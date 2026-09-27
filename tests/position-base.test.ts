/**
 * Playlist position bases are stated once, and mean what they say (#883).
 *
 * A playlist has one ordered item list. The tools that index into it were
 * numbered from two different ends: the parameters that go straight onto
 * Spotify's wire are 0-based, and the parameters that are human slot numbers
 * are 1-based and get converted by the handler. Both conventions are correct;
 * what was not correct is that the base was stated, or not stated, by whatever
 * sentence each call site happened to reach for.
 *
 * Fourteen playlist position parameters spelled the base out in roughly six
 * ways, and four of the most dangerous ones said nothing at all. The worst two
 * were `reorder_playlist_items.range_start` and `.insert_before` — the two
 * numbers a natural-language request ("move track 4 to the top") becomes, on
 * the one tool that forwards them unconverted to the API. Nothing downstream
 * corrects a wrong guess there: the write succeeds and the wrong rows move.
 *
 * Two gates, and they answer different questions:
 *
 *   1. The SCHEMA gate reads the live registry and holds every playlist
 *      position parameter to the same terminal sentence, with the base it
 *      declares. It is fail-closed: a position parameter added to a playlist
 *      tool later has to be declared in `POSITION_PARAMS` or excused in
 *      `NOT_A_POSITION`, so the table cannot quietly stop covering the surface.
 *   2. The WIRE gate drives the real handlers and checks that the index echoed
 *      in the plan is the index that reaches Spotify, for both bases. The
 *      schema gate can only prove a base was *claimed*; only this one proves
 *      the claim is true, which is the half an off-by-one hides.
 *
 * The wire gate is the reason this file is not a doc test. `range_start: 3`
 * meaning "the fourth item" is a claim about a number, and a claim about a
 * number is either checked against the wire or it is a comment.
 *
 * Run: node --import tsx --test tests/position-base.test.ts
 */
import { DEFAULT_TOKEN_FILE } from './helpers/hermetic.js';

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { SpotifyClient } from '../src/client.js';
import type { PlaylistItemObject } from '../src/types/spotify.js';
import { positionBaseClause, type PositionBase } from '../src/positionbase.js';
import { finalInputSchema } from '../src/shaping.js';
import {
  REGISTRAR_MANIFEST,
  loadManifestRegistrars,
  registerManifestModule,
} from '../src/tools/annotations.js';
import { registerPlaylistTools } from '../src/tools/playlists.js';
import { registerSwarm3PlaylistopsTools } from '../src/tools/swarm3_playlistops.js';
import { registerSwarm4PlaylistsTools } from '../src/tools/swarm4_playlists.js';

// ------------------------------------------------------------------ the spec

/**
 * Every playlist position parameter, and the base it is numbered from.
 *
 * This is the specification #883 asked for, written down. The sources are the
 * live OpenAPI schema for the 0-based half — `range_start`, `insert_before`,
 * the add `position` and the delete `positions[]` are all documented zero-based
 * there, and the handlers forward them unconverted — and the handler's own
 * `value - 1` for the 1-based half, which is the conversion the sentence
 * promises a reader.
 */
const POSITION_PARAMS: ReadonlyArray<readonly [tool: string, param: string, base: PositionBase]> = [
  // 0-based: crosses the API boundary unconverted.
  ['reorder_playlist_items', 'range_start', 'zero'],
  ['reorder_playlist_items', 'insert_before', 'zero'],
  ['add_to_playlist', 'position', 'zero'],
  // Dotted, because the position is an array member inside a union arm rather
  // than a top-level property — `uris: [{ uri, positions: [...] }]`.
  ['remove_from_playlist', 'uris.positions', 'zero'],
  ['clone_playlist_cover', 'image_index', 'zero'],
  ['playlist_cover_from_track', 'position', 'zero'],
  ['playlist_slice', 'start', 'zero'],
  ['playlist_slice', 'end', 'zero'],
  ['extract_playlist_range', 'start', 'zero'],
  ['extract_playlist_range', 'end', 'zero'],
  ['remove_playlist_range', 'start', 'zero'],
  ['remove_playlist_range', 'end', 'zero'],
  // 1-based: a human slot number the handler converts before the write.
  ['playlist_move_block', 'start', 'one'],
  ['playlist_move_block', 'to_position', 'one'],
  ['playlist_swap_positions', 'position_a', 'one'],
  ['playlist_swap_positions', 'position_b', 'one'],
  ['playlist_chunk_preview', 'offset', 'one'],
];

/**
 * Integer parameters in the playlist surface whose NAME looks like a position
 * but which are not one.
 *
 * This list is the fail-closed half of the schema gate and every entry earns
 * its place: a name-only heuristic cannot tell a playlist index from a rotation
 * delta, so each collision is recorded with the reason it is exempt rather than
 * left to look like an oversight.
 */
const NOT_A_POSITION: Readonly<Record<string, string>> = {
  // A signed delta — how far to rotate the list, not which slot. Negative
  // counts from the end, which no fixed base describes.
  'playlist_rotate.positions': 'signed rotation delta, not an index',
  'rotate_playlist_plan.positions': 'signed rotation delta, not an index',
  // Read pagination, not a position in the playlist. These are 0-based and say
  // so by their `.min(0)`/`Default: 0`, and they page a RESULT SET rather than
  // naming a row, so applying the playlist-position sentence to them would be
  // a different claim than the one they make.
  //
  // `playlist_chunk_preview.offset` is NOT in this list, and the contrast is
  // the point: it is the one `offset` on a playlist tool that IS a row
  // position, and it is 1-based where these three are 0-based.
  'get_playlist_items.offset': '0-based read pagination over results, not a row position',
  'get_playlist.offset': '0-based read pagination over results, not a row position',
  'get_user_playlists.offset': '0-based read pagination over results, not a row position',
};

/** Property names treated as position-shaped by the derivation below. */
const POSITION_SHAPED_NAME =
  /^(position|positions|position_a|position_b|start|end|range_start|insert_before|to_position|image_index|offset|index|slot|from_index|to_index|item_index|at_position)$/;

// ------------------------------------------------------------- live registry

interface PropertySchema {
  readonly type?: string;
  readonly description?: string;
  readonly items?: PropertySchema;
  readonly anyOf?: readonly PropertySchema[];
}

interface LiveSchema {
  readonly properties?: Record<string, PropertySchema>;
}

let PLAYLIST_SCHEMAS = new Map<string, LiveSchema>();
let REGISTERED_TOOL_COUNT = 0;

before(async () => {
  const server = new McpServer({ name: 'position-base', version: '0.0.0' });
  const client = new SpotifyClient();
  // Only the playlist scope. The whole-surface sweep this could become is 63
  // integer parameters, and 49 of them are `offset` pagination on search and
  // library reads — a different contract, governed by a different base, and out
  // of scope for an issue about playlist positions.
  const context = {
    readOnly: false,
    disableOverrides: new Set<string>(), isModuleActive: () => true,
    scopeBlocked: () => false,
  };
  for (const module of await loadManifestRegistrars(REGISTRAR_MANIFEST, context)) {
    if (module.scopeKey !== 'playlists') continue;
    registerManifestModule(server, client, module, context);
  }
  const registry = (server as unknown as {
    _registeredTools?: Record<string, { inputSchema?: unknown }>;
  })._registeredTools ?? {};
  for (const [name, entry] of Object.entries(registry)) {
    // The registry holds the zod shape; `finalInputSchema` is the one
    // conversion that turns it into the JSON schema a host actually reads, so
    // the gate checks the emitted wire form and not the source object.
    const schema = entry.inputSchema ? (finalInputSchema(entry.inputSchema) as LiveSchema) : undefined;
    if (schema?.properties) PLAYLIST_SCHEMAS.set(name, schema);
  }
  REGISTERED_TOOL_COUNT = Object.keys(registry).length;
});

/**
 * The property schema at a path, descending through arrays and unions.
 *
 * `remove_from_playlist.uris.positions` is an array of `string | { uri,
 * positions }` — so reaching it means stepping into `items`, then through
 * `anyOf`, then into an arm's `properties`. That is three levels of nesting for
 * one number, and it is exactly why that parameter reads as a bare
 * `min(0)` in the source while its sibling `add_to_playlist.position` is a
 * plain property: anything hand-written about it is easy to get wrong, which
 * is the reason the spec table addresses it by path rather than by name.
 */
function childNamed(node: PropertySchema | undefined, name: string): PropertySchema | undefined {
  if (!node) return undefined;
  if (node.anyOf) {
    for (const arm of node.anyOf) {
      const found = childNamed(arm, name);
      if (found) return found;
    }
    return undefined;
  }
  if (node.items) {
    const found = childNamed(node.items, name);
    if (found) return found;
  }
  return node.properties?.[name];
}

function propertyAt(schema: LiveSchema | undefined, path: readonly string[]): PropertySchema | undefined {
  let current: PropertySchema | undefined = schema?.properties?.[path[0]];
  for (const segment of path.slice(1)) {
    current = childNamed(current, segment);
    if (!current) return undefined;
  }
  return current;
}

// --------------------------------------------------------------- schema gate

describe('every playlist position parameter states its base in the same sentence (#883)', () => {
  it('derives a non-trivial playlist surface, so the gate is not vacuous', () => {
    // The registry pass is built from a manifest filter and a private read of
    // `_registeredTools`. Either can silently yield nothing — a scopeKey
    // renamed, a registrar that throws and is swallowed — and then every
    // assertion below passes against an empty map. A non-vacuity check is the
    // only thing standing between that and a green file proving nothing.
    assert.ok(
      REGISTERED_TOOL_COUNT > 50,
      `expected the playlist scope to register >50 tools, got ${REGISTERED_TOOL_COUNT}`,
    );
    assert.ok(
      PLAYLIST_SCHEMAS.size > 50,
      `expected >50 playlist schemas with properties, got ${PLAYLIST_SCHEMAS.size}`,
    );
  });

  it('states the declared base in the terminal sentence of every position description', () => {
    const failures: string[] = [];
    for (const [tool, param, base] of POSITION_PARAMS) {
      const property = propertyAt(PLAYLIST_SCHEMAS.get(tool), param.split('.'));
      if (!property) {
        failures.push(`${tool}.${param}: no such property in the registered schema`);
        continue;
      }
      const description = property.description ?? '';
      const clause = positionBaseClause(base);
      if (!description.endsWith(clause)) {
        failures.push(
          `${tool}.${param}: description does not end on the ${base}-based clause\n`
          + `    expected to end with: ${clause}\n`
          + `    actual:              ${JSON.stringify(description)}`,
        );
      }
    }
    assert.deepEqual(failures, [], `position parameters not stating their base:\n${failures.join('\n')}`);
  });

  it('covers every position-shaped parameter on a playlist tool, or excuses it', () => {
    // The table above can only be as good as the last person to update it. This
    // is the direction a hand-written list fails in: a new `position` lands on
    // a playlist tool, nobody adds a row, and the spec silently stops covering
    // the surface while the table above keeps passing. So the derivation runs
    // from the live schemas and every name-shaped integer has to be accounted
    // for — declared, or exempt with a reason.
    const unaccounted: string[] = [];
    for (const [tool, schema] of PLAYLIST_SCHEMAS) {
      for (const [name, property] of Object.entries(schema.properties ?? {})) {
        if (property.type !== 'integer' && property.type !== 'number') continue;
        if (!POSITION_SHAPED_NAME.test(name)) continue;
        const key = `${tool}.${name}`;
        const declared = POSITION_PARAMS.some(([t, p]) => `${t}.${p}` === key);
        if (declared) continue;
        if (NOT_A_POSITION[key]) continue;
        unaccounted.push(
          `${key} is an integer named like a position and is neither declared nor excused. `
          + `Add it to POSITION_PARAMS with its base, or to NOT_A_POSITION with a reason. `
          + `Description: ${JSON.stringify(property.description ?? null)}`,
        );
      }
    }
    assert.deepEqual(
      unaccounted,
      [],
      `position-shaped playlist parameters the spec does not account for:\n${unaccounted.join('\n')}`,
    );
  });

  it('records the exemptions the derivation relies on, so the allowlist cannot rot', () => {
    // `NOT_A_POSITION` exempts by name. A tool that is renamed or retired takes
    // its exemption silently out of use, and an allowlist nobody reads is an
    // allowlist that grows. Each entry must still name a live integer.
    for (const key of Object.keys(NOT_A_POSITION)) {
      const [tool, name] = key.split('.');
      const property = PLAYLIST_SCHEMAS.get(tool)?.properties?.[name];
      assert.ok(
        property && (property.type === 'integer' || property.type === 'number'),
        `NOT_A_POSITION names ${key}, but ${tool}.${name} is not a live integer parameter. `
        + `Drop the entry, or the exemption is doing nothing.`,
      );
    }
  });
});

// ----------------------------------------------------------------- wire gate

type ToolResult = {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};

function track(id: string): PlaylistItemObject {
  return {
    added_at: '2026-01-01T00:00:00Z',
    item: {
      type: 'track',
      uri: `spotify:track:${id}`,
      name: `Track ${id}`,
      duration_ms: 180_000,
      artists: [{ id: `artist-${id}`, name: `Artist ${id}` }],
      album: { id: `album-${id}`, name: `Album ${id}` },
    },
  } as PlaylistItemObject;
}

const PLAYLIST = 'P'.repeat(22);

interface WireCall {
  readonly method: 'POST' | 'PUT';
  readonly path: string;
  readonly body: unknown;
}

function harness(rows: PlaylistItemObject[]) {
  const writes: WireCall[] = [];
  const client = {
    // The real SpotifyClient always sets this at construction; a stub that
    // omits it is not a client the stores can key by (#1385).
    tokenFile: DEFAULT_TOKEN_FILE,
    async get<T>(path: string): Promise<T | null> {
      const id = decodeURIComponent(path.replace('/playlists/', ''));
      return { id, name: `Playlist ${id}`, collaborative: false, public: false } as T;
    },
    // This one stub serves BOTH read paths: `swarm4_playlists` walks with
    // `getAllPagesWithTruncation` so the truncation verdict travels with the
    // rows (#1362), while `swarm3_playlistops` still calls the bare
    // `getAllPages`. Both are needed — dropping either one breaks the other
    // module's tools. These fixtures are whole playlists, under the cap by
    // construction, so the verdict is reported as complete.
    async getAllPages<T>(path: string): Promise<T[]> {
      if (path.endsWith('/items')) return rows as unknown as T[];
      return [] as unknown as T[];
    },
    async getAllPagesWithTruncation<T>(path: string): Promise<{
      items: T[];
      truncated: boolean;
      truncatedByCap: boolean;
      reportedTotal: number | null;
      pages: number;
    }> {
      const items = path.endsWith('/items') ? (rows as unknown as T[]) : [];
      return {
        items,
        truncated: false,
        truncatedByCap: false,
        reportedTotal: items.length,
        pages: 1,
      };
    },
    async post<T>(path: string, body?: unknown): Promise<T | null> {
      writes.push({ method: 'POST', path, body });
      return { snapshot_id: 'snapshot' } as T;
    },
    async put<T>(path: string, body?: unknown): Promise<T | null> {
      writes.push({ method: 'PUT', path, body });
      return { snapshot_id: 'snapshot' } as T;
    },
  } as unknown as SpotifyClient;

  const registered: Array<{
    name: string;
    validate: (args: Record<string, unknown>) => Record<string, unknown>;
    handler: (args: Record<string, unknown>) => Promise<ToolResult>;
  }> = [];
  const server = {
    tool(
      name: string,
      _description: string,
      schema: z.ZodRawShape,
      handler: (args: Record<string, unknown>) => Promise<ToolResult>,
    ) {
      registered.push({
        name,
        validate: (args) => z.object(schema).parse(args),
        handler,
      });
    },
    // The object-literal form. `playlists.ts` uses both registration styles,
    // and a shim that only answers `tool` fails on the second with a
    // TypeError that reads like a broken tool rather than a broken stub.
    registerTool(
      name: string,
      config: { inputSchema?: z.ZodRawShape },
      handler: (args: Record<string, unknown>) => Promise<ToolResult>,
    ) {
      registered.push({
        name,
        validate: (args) => z.object(config.inputSchema ?? {}).parse(args),
        handler,
      });
    },
  } as unknown as McpServer;

  registerPlaylistTools(server, client);
  registerSwarm3PlaylistopsTools(server, client);
  registerSwarm4PlaylistsTools(server, client);

  return {
    writes,
    async invoke(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
      const tool = registered.find((candidate) => candidate.name === name);
      assert.ok(tool, `${name} is registered`);
      return tool.handler(tool.validate(args));
    },
    /** The URIs of the most recent atomic replace, in the order sent. */
    lastWriteUris(): string[] {
      const uris = (writes.at(-1)?.body as { uris?: string[] } | undefined)?.uris;
      assert.ok(uris, `expected the last write to carry a uris array, got ${JSON.stringify(writes.at(-1))}`);
      return uris;
    },
  };
}

const TEXT = (result: ToolResult): string =>
  result.content.map((part) => part.text ?? '').join('\n');

describe('the index echoed in the plan is the index sent on the wire, for both bases (#883)', () => {
  it('zero-based: reorder echoes exactly the range_start and insert_before it sends', async () => {
    // `reorder_playlist_items` is the one tool that puts a caller-supplied
    // number straight onto the API with no conversion. So for this tool the
    // echoed index and the wire index are the SAME number, and the sentence
    // promising "0-based" is a claim about it. If a handler ever started
    // adjusting the value on its way out, the plan would go on reporting the
    // input while the API moved different rows.
    const h = harness([]);
    const plan = await h.invoke('reorder_playlist_items', {
      playlist_id: PLAYLIST,
      range_start: 3,
      range_length: 2,
      insert_before: 7,
      dry_run: true,
    });

    const prose = TEXT(plan);
    assert.match(prose, /from index 3/, 'the plan must echo the 0-based range_start it was given');
    assert.match(prose, /insert_before=7/, 'the plan must echo the 0-based insert_before it was given');
    assert.equal(h.writes.length, 0, 'a dry run must not write');

    await h.invoke('reorder_playlist_items', {
      playlist_id: PLAYLIST,
      range_start: 3,
      range_length: 2,
      insert_before: 7,
      dry_run: false,
    });

    assert.equal(h.writes.length, 1, 'the commit must issue exactly one write');
    assert.deepEqual(
      h.writes[0].body,
      { range_start: 3, insert_before: 7, range_length: 2 },
      'the wire body must carry the same indices the plan echoed, unconverted',
    );
  });

  it('zero-based: an insert at position 0 sends 0, not 1', async () => {
    // The boundary case the base sentence exists for. Under a 1-based reading
    // `0` is out of range and the natural fix is to bump it; that would silently
    // put the item SECOND instead of first.
    const h = harness([]);
    await h.invoke('add_to_playlist', {
      playlist_id: PLAYLIST,
      uris: ['spotify:track:new'],
      position: 0,
    });
    const body = h.writes.at(-1)?.body as { position?: number };
    assert.equal(body.position, 0, 'position 0 must reach the API as 0 — the first slot');
  });

  it('one-based: swap 2 and 4 moves slots 2 and 4, not their neighbours', async () => {
    // The failure #883 names: an off-by-one here swaps the ADJACENT tracks and
    // reports success. Five rows, so every neighbouring pair is distinct and
    // the wrong answer is unmissable.
    const h = harness(['a', 'b', 'c', 'd', 'e'].map(track));
    const before = h.writes.length;

    const result = await h.invoke('playlist_swap_positions', {
      playlist_id: PLAYLIST,
      position_a: 2,
      position_b: 4,
      dry_run: false,
    });

    assert.equal(h.writes.length, before + 1, 'the swap must issue one atomic replace');
    assert.deepEqual(
      h.lastWriteUris(),
      ['spotify:track:a', 'spotify:track:d', 'spotify:track:c', 'spotify:track:b', 'spotify:track:e'],
      '1-based 2↔4 must swap rows at 0-based indices 1 and 3',
    );

    // The plan keeps the caller's own numbering, so a reader can check the
    // claim: it says 2 and 4, and 2 and 4 are the rows that moved.
    const payload = result.structuredContent ?? {};
    assert.equal(payload.position_a, 2, 'the plan must echo the 1-based position it was given');
    assert.equal(payload.position_b, 4, 'the plan must echo the 1-based position it was given');
  });

  it('one-based: the order the plan shows is the order the commit writes', async () => {
    // `playlist_move_block` reports 1-based arguments and rewrites the whole
    // playlist as an ordered URI list, so the wire index is implicit in the
    // array's order. That makes the dry run the only place the conversion is
    // visible, and the only place a wrong base would show up as a plan the
    // commit then contradicts.
    //
    // Slots 2–3 (0-based 1–2) lifted out and reinserted. `to_position: 5` is
    // a position in the ORIGINAL numbering, and `reorder_playlist_items`
    // documents the same rule for the same shape: a target beyond the moved
    // range shifts down by the range length, because the range is lifted out
    // first. So the block lands at index 2 of the shortened list.
    const h = harness(['a', 'b', 'c', 'd', 'e', 'f'].map(track));
    const planned = await h.invoke('playlist_move_block', {
      playlist_id: PLAYLIST,
      start: 2,
      count: 2,
      to_position: 5,
      dry_run: true,
    });

    const expected = [
      'spotify:track:a', 'spotify:track:d', 'spotify:track:b',
      'spotify:track:c', 'spotify:track:e', 'spotify:track:f',
    ];
    assert.deepEqual(
      (planned.structuredContent ?? {}).order,
      expected,
      'the dry-run plan must show the 0-based order the 1-based arguments resolve to',
    );
    // The plan keeps the caller's own numbering, so a reader can check the
    // claim against it.
    assert.equal((planned.structuredContent ?? {}).start, 2, 'the plan must echo the 1-based start');
    assert.equal((planned.structuredContent ?? {}).to_position, 5, 'the plan must echo the 1-based target');
    assert.equal(h.writes.length, 0, 'a dry run must not write');

    await h.invoke('playlist_move_block', {
      playlist_id: PLAYLIST,
      start: 2,
      count: 2,
      to_position: 5,
      dry_run: false,
    });
    assert.deepEqual(
      h.lastWriteUris(),
      expected,
      'the committed order must equal the order the dry run planned — the base is not applied twice',
    );
  });

  it('zero-based: an exclusive range end selects every row before it, not through it', async () => {
    // `extract_playlist_range` is the clearest statement of the 0-based half of
    // the surface: `start` inclusive, `end` EXCLUSIVE, and `end` one past the
    // last row wanted. Read 1-based it would drop the first row and keep the
    // last — an off-by-one at BOTH ends, and a silently wrong extract.
    //
    // It also reports the two bases at once: the structured `range` is 0-based
    // while the prose numbers rows from 1. That is the "record the resolved
    // base in the plan" #883 asks for, so it is pinned here rather than left
    // to be re-derived.
    const h = harness(['a', 'b', 'c', 'd', 'e'].map(track));
    const result = await h.invoke('extract_playlist_range', {
      playlist_id: PLAYLIST,
      start: 1,
      end: 4,
      name: 'Slice',
    });
    const payload = result.structuredContent ?? {};

    assert.deepEqual(
      payload.range,
      [1, 4],
      'the plan must report the 0-based half-open range it was given',
    );
    assert.deepEqual(
      payload.plan,
      ['spotify:track:b', 'spotify:track:c', 'spotify:track:d'],
      'start 1 to end 4 exclusive must take rows 1–3, dropping row 0 and row 4',
    );
    const prose = TEXT(result);
    assert.match(prose, /\[1,4\)/, 'the prose must show the resolved 0-based range');
    assert.match(prose, /pos 2 → spotify:track:b/, 'the prose numbers rows from 1 over a 0-based range');
    assert.equal(h.writes.length, 0, 'dry_run defaults to true, so this must not write');
  });

  it('one-based: chunk_preview offset 1 starts at the FIRST item, not the second', async () => {
    // `playlist_chunk_preview.offset` is the only 1-based parameter named
    // `offset` in the surface, and it is the sharpest version of the bug: read
    // 0-based, `offset: 1` silently skips the first track of the playlist and
    // every chunk boundary is off by one from there on. Nothing errors.
    const h = harness(['a', 'b', 'c', 'd'].map(track));
    const result = await h.invoke('playlist_chunk_preview', {
      playlist_id: PLAYLIST,
      page_size: 2,
      offset: 1,
      chunks_to_show: 2,
    });
    const prose = TEXT(result);
    assert.match(
      prose,
      /Track a\b/,
      'offset 1 must start the first chunk at the first item',
    );

    // And the two must differ, or the assertion above proves nothing.
    const second = await h.invoke('playlist_chunk_preview', {
      playlist_id: PLAYLIST,
      page_size: 2,
      offset: 2,
      chunks_to_show: 2,
    });
    assert.equal(
      TEXT(second).includes('Track a'),
      false,
      'offset 2 must start at the second item — otherwise the base is not being honoured',
    );
  });
});
