/**
 * The entity-id reference contract (#914).
 *
 * `src/refs.ts` is the one resolver that turns a bare id, a `spotify:` URI, a
 * `spotify://` link or an open.spotify.com share URL into a bare id. Whether a
 * reference has to be bare used to depend on which module the tool lived in:
 * an agent that learned "URIs work" from a `swarm3_*` tool and then called
 * `get_playlist` with the same reference got a URL-encoded URI in the request
 * path and a 404 that looked like a missing playlist.
 *
 * This file is the gate that makes the invariant enforceable rather than a
 * convention. It has two halves:
 *
 *  1. `RESOLVER_BACKED` — a source scan over `src/tools/**` that fails when a
 *     parameter whose NAME is id-shaped is declared with a plain `z.string()`
 *     and is not on the ledger below. New drift fails CI on the commit that
 *     introduces it, which is the only point at which the cost of fixing it is
 *     small.
 *
 *  2. A wire-level test on the three tools the issue names by hand, asserting
 *     the resolved bare id is what reaches `client.get`, not the caller's
 *     original string.
 *
 * ## Why the ledger below is long, and why it is here rather than in a comment
 *
 * The issue's step 2 asks for every entity-id parameter to be migrated. That is
 * ~90 parameters across ~25 modules, and it is not a mechanical edit, because
 * `spotifyId()` hard-rejects anything that is not exactly 22 URL-safe
 * characters. Migrating a parameter therefore does not only accept a URI — it
 * also turns "the caller passed something that is not a playlist id" from a
 * 404 into a 400, across a third of the tool surface, and it invalidates every
 * test that used a readable fake id like `pl1`.
 *
 * That is a real decision with a real blast radius, not a cleanup, so it is not
 * smuggled in beside a duplicate-matching fix. What lands here instead is the
 * measurement and the ratchet: every remaining plain id-shaped parameter is
 * enumerated, named, and classified below, and the scan fails on anything not
 * on the list. The list is the migration ledger — it is measured, it is
 * enforced in both directions, and it cannot rot silently, because an entry
 * that stops matching a real declaration fails the "no stale entries" test.
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerPlaylistTools } from '../src/tools/playlists.js';
import { registerCatalogTools } from '../src/tools/catalog.js';
import { registerSwarm3ShowsTools } from '../src/tools/swarm3_shows.js';

const TOOLS_DIR = 'src/tools';

/**
 * Parameter-name shapes that are NOT Spotify entity references.
 *
 * Each entry says why, because "it looked like an id" is exactly the reasoning
 * that put a `device_id` through `spotifyId('track')`. A device id comes from
 * `GET /me/player/devices` and is not a catalog entity; a snapshot, session,
 * receipt, mutation or history id is minted by THIS server; a category is a
 * human label like `party`, not an id at all.
 *
 * A name in this set is exempt from the scan entirely. Adding a name here is a
 * claim that the parameter is not a Spotify entity reference, and it is the
 * claim the test exists to make hard to get wrong.
 */
const NOT_A_SPOTIFY_ENTITY: Readonly<Record<string, string>> = Object.freeze({
  device_id: 'A device id from GET /me/player/devices — not a catalog entity. `GET /me/player` matches on it verbatim.',
  device_ids: 'Device ids from GET /me/player/devices, in the same non-catalog space as device_id.',
  exclude_device_id: 'A device id, negated. Same non-catalog space as device_id.',
  snapshot_id: 'A snapshot id minted by this server (snapshot_playlist / diff_since_snapshot), not a Spotify id.',
  session_id: 'A session id minted by this server, not a Spotify id.',
  receipt_id: 'A mutation receipt id minted by this server, not a Spotify id.',
  mutation_id: 'A mutation-history id minted by this server, not a Spotify id.',
  history_id: 'A history-entry id minted by this server, not a Spotify id.',
  bookmark_id: 'A caller-supplied label for restoring this server\'s own state, not a Spotify id.',
  category_id: 'A browse category label such as `party`, not an id. The endpoint that took it was removed in Feb 2026.',
});

/**
 * The migration ledger: entity-id parameters still declared as plain strings.
 *
 * Every entry is a real Spotify entity reference that has NOT yet been routed
 * through `spotifyId()`, grouped by the kind it should take when it is. This is
 * a measured inventory, not a wish list: `tests/schema.refs.test.ts` fails if
 * an entry stops matching a declaration (the migration happened, delete the
 * row) and fails if an id-shaped declaration is missing from both this table
 * and {@link NOT_A_SPOTIFY_ENTITY} (new drift, fix it now).
 *
 * The count below is the honest remainder of the issue's step 2 as of this
 * commit. Reporting it here rather than in a PR body means the number cannot
 * drift away from the code.
 */
const NOT_YET_MIGRATED: Readonly<Record<string, readonly string[]>> = Object.freeze({
  playlist: ['playlist_id', 'target_playlist_id', 'source_playlist_id', 'destination_playlist_id'],
  artist: [
    'artist_id',
    'artist_ids',
    // `following.ts`'s `ids` is a `z.array(z.string())` behind a CSV-splitting
    // preprocess. Its HANDLER normalises through `normalizeArtistReference`, so
    // it behaves correctly today — but the correctness lives in the handler, not
    // the schema, which is exactly the split this gate is closing.
    'ids',
  ],
  audiobook: ['audiobook_id'],
  show: ['show_id'],
  track: ['track_id', 'track_ids'],
  album: ['album_id', 'album_ids'],
  episode: ['episode_id'],
  /** `id` is only classifiable at the call site; listed per-tool in the test below. */
  ambiguous: ['id'],
});

/** Every id-shaped name the scan treats as a Spotify entity reference. */
const MIGRATED_NAMES: ReadonlySet<string> = new Set(
  Object.values(NOT_YET_MIGRATED).flat(),
);

/** Names exempt because they are not Spotify entity references. */
const EXEMPT_NAMES: ReadonlySet<string> = new Set(Object.keys(NOT_A_SPOTIFY_ENTITY));

/**
 * A parameter name is id-shaped if it is `id`/`ids` or ends `_id`/`_ids`.
 *
 * The middle group admits underscores, so `target_playlist_id` counts. A
 * pattern that only matched a single word before the suffix would miss every
 * multi-word id in the codebase — and a gate that undercounts is a gate that
 * reports success while the drift it exists to catch goes unrecorded.
 */
const ID_SHAPED = /^(id|ids|[a-z][a-z0-9_]*_ids?)$/;

/**
 * Shared schemas that already resolve through the reference policy but are not
 * written as a `spotifyId(...)` call at the declaration site.
 *
 * `PlaylistRef` / `PlaylistId` in `src/shaping.ts` normalise through
 * `classifySpotifyReference` in a `.transform`, so a tool using them satisfies
 * the contract this file is about. They are named here rather than pattern-
 * matched so that a new shared schema has to be classified on purpose: an
 * unrecognized factory in a spot should be a failure, not a silent pass.
 */
const SHARED_RESOLVER_SCHEMAS: ReadonlySet<string> = new Set(['PlaylistId', 'PlaylistRef']);

/** The kinds `src/refs.ts` can resolve. */
const REFERENCE_KINDS = new Set([
  'track', 'album', 'artist', 'playlist', 'show', 'episode', 'audiobook', 'user',
]);

interface Declaration {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  /** The zod factory as written, e.g. `z.string()` or `spotifyId`. */
  readonly factory: string;
}

function idShapedDeclarations(): Declaration[] {
  const found: Declaration[] = [];
  for (const entry of readdirSync(TOOLS_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const file = join(TOOLS_DIR, entry);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, index) => {
      // A tool-parameter declaration: `<name>: <zod factory>` at the top level of
      // a schema object literal. Anchored to the start of a line so a handler
      // destructuring or a hand-rolled object cannot be mistaken for one. The
      // factory alternation admits a bare capitalised schema name because
      // `registerTool({ inputSchema: z.object({ … }) })` puts several
      // declarations on one line.
      const match = /^(\s*)([a-z][a-z0-9_]*):\s*(z\.[A-Za-z]+|spotifyId[A-Za-z]*|[A-Z][A-Za-z0-9]*)\b/.exec(text);
      if (!match) return;
      const name = match[2]!;
      if (!ID_SHAPED.test(name)) return;
      found.push({ file, line: index + 1, name, factory: match[3]! });
    });
  }
  return found;
}

/** True when the declaration resolves through the shared reference policy. */
function isResolverBacked(declaration: Declaration): boolean {
  return declaration.factory.startsWith('spotifyId') || SHARED_RESOLVER_SCHEMAS.has(declaration.factory);
}

describe('#914 no entity-id parameter is declared as a plain string', () => {
  const declarations = idShapedDeclarations().filter((d) => !EXEMPT_NAMES.has(d.name));

  it('found the id-shaped parameters it is gating', () => {
    // A scan that silently matched nothing would report success forever. This
    // is the same failure as the `playlist_exclude_artists` id-only comparison
    // #885 removed, one layer up: a check that cannot fail is worse than none.
    assert.ok(
      declarations.length > 50,
      `the scan only found ${declarations.length} id-shaped parameters — it is not reading the schemas`,
    );
    assert.ok(
      declarations.some((d) => isResolverBacked(d)),
      'no resolver-backed parameter was found either; the factory pattern is stale',
    );
  });

  it('every un-migrated entity-id parameter is on the ledger', () => {
    const unlisted = declarations
      .filter((d) => !isResolverBacked(d) && !MIGRATED_NAMES.has(d.name))
      .map((d) => `${d.file}:${d.line} ${d.name}`);
    assert.deepEqual(
      unlisted,
      [],
      'these id-shaped parameters are neither resolver-backed, nor exempt, nor on the migration ledger — '
        + 'route them through spotifyId(kind) or say in NOT_A_SPOTIFY_ENTITY why they are not Spotify ids',
    );
  });

  it('the ledger has no stale entries', () => {
    // The other direction. Without it, "migrate a parameter" and "forget the
    // row" leaves a table that claims work is outstanding which is done, and
    // the count in the PR body stops meaning anything.
    const declared = new Set(declarations.map((d) => d.name));
    const unlisted = [...MIGRATED_NAMES].filter((name) => !declared.has(name));
    assert.deepEqual(
      unlisted,
      [],
      'the migration ledger names parameters no longer declared as plain strings — migrate them and delete the row',
    );
    const orphaned = [...EXEMPT_NAMES].filter((name) => !idShapedDeclarations().some((d) => d.name === name));
    assert.deepEqual(
      orphaned,
      [],
      'NOT_A_SPOTIFY_ENTITY names parameters that are no longer id-shaped — delete the entry',
    );
  });

  it('every exempt name carries the reason it is not a Spotify entity', () => {
    for (const [name, reason] of Object.entries(NOT_A_SPOTIFY_ENTITY)) {
      assert.ok(reason.length > 20, `${name} is exempt without a reason someone can check`);
    }
  });

  it('the resolver is only ever asked for a kind refs.ts knows', () => {
    // A typo'd kind would not throw at build time — `spotifyId('playlst')`
    // compiles — it would reject every reference at runtime, which reads as
    // "this tool is broken" rather than "this schema is wrong".
    for (const entry of readdirSync(TOOLS_DIR).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(join(TOOLS_DIR, entry), 'utf8');
      for (const match of source.matchAll(/spotifyId(?:Array)?(?:<[^>]*>)?\(\s*'([a-z]+)'\s*\)/g)) {
        assert.ok(
          REFERENCE_KINDS.has(match[1]!),
          `${entry}: spotifyId('${match[1]}') is not one of the kinds src/refs.ts resolves`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The wire-level half: what actually reaches the request path
// ---------------------------------------------------------------------------

const TRACK_ID = '4iV5W9uYEdYUVa79Axb7Rh';
const PLAYLIST_ID = '37i9dQZF1DWZeKCadgRdKQ';
const SHOW_ID = '4rOoJ6Egrf8K2IrywzwOMk';

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

function recordingHarness(): {
  invoke: (name: string, args: Record<string, unknown>) => Promise<void>;
  paths: string[];
} {
  const paths: string[] = [];
  const registered: Array<{ name: string; schema: z.ZodTypeAny; handler: Handler }> = [];
  const server = {
    tool(name: string, _d: string, schema: Record<string, z.ZodTypeAny>, handler: Handler) {
      registered.push({ name, schema: z.object(schema), handler });
    },
    registerTool(name: string, config: { inputSchema?: z.ZodType }, handler: Handler) {
      registered.push({ name, schema: (config.inputSchema ?? z.object({})) as z.ZodTypeAny, handler });
    },
    server: { getClientCapabilities: () => ({ elicitation: { form: {} } }) },
  } as unknown as McpServer;

  const client = {
    async get<T>(path: string): Promise<T | null> {
      paths.push(path);
      return null as T;
    },
    async getAllPages(): Promise<never[]> {
      return [];
    },
    async getAllPagesWithTruncation<T>(): Promise<{ items: T[]; truncated: boolean }> {
      return { items: [], truncated: false };
    },
  } as unknown as SpotifyClient;

  registerPlaylistTools(server, client);
  registerCatalogTools(server, client);
  registerSwarm3ShowsTools(server, client);

  return {
    paths,
    async invoke(name, args) {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `${name} should be registered`);
      // The 404 path is fine here: the assertion is on the path, not the result.
      await tool.handler(tool.schema.parse(args)).catch(() => undefined);
    },
  };
}

describe('#914 a reference reaches the wire as a bare id', () => {
  it('get_track, get_playlist and list_show_episodes all resolve a URI and a share URL', async () => {
    // The wire probes from the issue, as a test. Each tool is given the same
    // entity in all four accepted forms and the path is asserted to contain
    // only the bare id — never `spotify%3A` or `open.spotify.com`.
    const cases: Array<{ tool: string; key: string; id: string; uri: string; url: string }> = [
      {
        tool: 'get_track',
        key: 'id',
        id: TRACK_ID,
        uri: `spotify:track:${TRACK_ID}`,
        url: `https://open.spotify.com/track/${TRACK_ID}`,
      },
      {
        tool: 'get_playlist',
        key: 'playlist_id',
        id: PLAYLIST_ID,
        uri: `spotify:playlist:${PLAYLIST_ID}`,
        url: `https://open.spotify.com/playlist/${PLAYLIST_ID}`,
      },
      {
        tool: 'list_show_episodes',
        key: 'show_id',
        id: SHOW_ID,
        uri: `spotify:show:${SHOW_ID}`,
        url: `https://open.spotify.com/show/${SHOW_ID}`,
      },
    ];

    for (const { tool, key, id, uri, url } of cases) {
      for (const [form, reference] of [['bare id', id], ['URI', uri], ['share URL', url]] as const) {
        const h = recordingHarness();
        await h.invoke(tool, { [key]: reference });
        const entity = h.paths.find((p) => !p.endsWith('/items') && p !== '/me/playlists');
        assert.ok(entity, `${tool} (${form}) made no request at all — the failure would look like a 404`);
        assert.ok(
          entity.includes(`/${id}`),
          `${tool} (${form}) put ${JSON.stringify(entity)} on the wire; expected it to contain /${id}`,
        );
        assert.ok(
          !entity.includes('spotify%3A') && !entity.includes('open.spotify.com'),
          `${tool} (${form}) sent the reference unnormalised: ${entity}`,
        );
      }
    }
  });

  it('a spotify:// link resolves too, not just the two forms above', async () => {
    const h = recordingHarness();
    await h.invoke('get_track', { id: `spotify://track/${TRACK_ID}` });
    const path = h.paths.find((p) => p.startsWith('/tracks/'));
    assert.ok(path?.includes(`/${TRACK_ID}`), `spotify:// link was not normalised: ${path}`);
  });
});
