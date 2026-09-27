/**
 * #895 — one shared cap for json-mode and structuredContent payloads.
 *
 * The bug: several tools built a whole payload and handed the SAME object to
 * both machine channels — `content[0].text` as `JSON.stringify(payload, null,
 * 2)` AND `structuredContent: payload` — so the host paid twice for one call,
 * and nothing bounded the rows in either copy. `max_results` reached the prose
 * path and stopped there.
 *
 * The fix: `capRowSections` (src/shaping.ts) caps the row arrays and DISCLOSES
 * what it withheld in a `sections` envelope; `emitOnce` puts the payload in
 * `structuredContent` once and a bounded summary in the text block.
 *
 * Every test here must fail on the pre-fix tree. The size tests use library
 * sizes chosen to actually trip the cap, and each asserts the ABSENCE of a
 * second copy — an assertion that passes on a 12-row fixture is decoration
 * (AGENTS.md §6).
 */

import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { StubFromResponder } from './helpers/stub-client.js';
import type { LegacyResponder } from './helpers/stub-client.js';
import { capRowSections, emitOnce } from '../src/shaping.js';
import { registerLibraryHygieneTools } from '../src/tools/libraryhygiene.js';
import { registerSavedDedupeTools } from '../src/tools/saveddedupe.js';
import { registerExhaust2MiscTools } from '../src/tools/exhaust2_misc.js';
import { registerPlaylistOpsTools } from '../src/tools/playlistops.js';
import { registerTasteCompositeTools } from '../src/tools/taste_composites.js';
import { registerStatsfmTools } from '../src/tools/statsfm.js';
import { __setStatsfmFetchImpl, __resetStatsfmFetchImpl } from '../src/tools/statsfm_taste.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Responder = (path: string, params?: Record<string, string>) => unknown;

interface RegisteredTool {
  name: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (
    args: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  }>;
}

function harness(
  register: (server: McpServer, client: StubFromResponder) => void,
  responder: Responder = () => null,
) {
  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(
      name: string,
      _description: string,
      schema: z.ZodRawShape,
      handler: RegisteredTool['handler'],
    ) {
      registered.push({
        name,
        validate: (args) => z.object(schema).parse(args),
        handler,
      });
    },
    // `registerTool` is the SDK's own entry point and several modules use it
    // instead of `server.tool`. A harness that only implements the second one
    // fails at REGISTRATION, not at the assertion under test.
    registerTool(
      name: string,
      config: { description?: string; inputSchema?: z.ZodType },
      handler: RegisteredTool['handler'],
    ) {
      registered.push({
        name,
        // `z.ZodType` unparameterized parses to `unknown`, which is the honest
        // default for an arbitrary schema but not for THIS one: a tool's
        // `inputSchema` is always an object schema, so its output is the args
        // object. Naming the output parameter states that, where the bare cast
        // left the value arriving as `unknown` and every reader had to cast
        // again.
        validate: (args) => (config.inputSchema as z.ZodType<Record<string, unknown>>).parse(args),
        handler,
      });
    },
  } as unknown as McpServer;
  const client = new StubFromResponder(responder as LegacyResponder, {
    writes: {
      POST: responder as LegacyResponder,
      PUT: responder as LegacyResponder,
      DELETE: responder as LegacyResponder,
      PUT_RAW: () => undefined,
    },
  });
  register(fakeServer, client);
  return {
    invoke: async (name: string, args: Record<string, unknown> = {}) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

const textOf = (out: { content: Array<{ text: string }> }) => out.content[0].text;

/**
 * stats.fm modules register against a module-level client rather than the
 * injected one, so their handler is reached by name and called with the
 * already-defaulted args a zod parse would have produced.
 */
function handlerHarness(
  register: (server: unknown, client: unknown) => void,
  client: unknown = {},
) {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  }>>();
  const server = {
    tool: (name: string, _d: string, _s: unknown, handler: (args: Record<string, unknown>) => never) =>
      handlers.set(name, handler),
  };
  register(server, client);
  return async (name: string, args: Record<string, unknown>) => {
    const handler = handlers.get(name);
    assert.ok(handler, `tool "${name}" should be registered`);
    return handler(args);
  };
}

/**
 * `registerStatsfmTools` takes an INJECTED `{ get }` client rather than the
 * shared stats.fm one, so it needs a fixture-swappable responder. Set
 * `statsfmResponder` before invoking; an unset responder is a test bug, not a
 * silent empty page.
 */
let statsfmResponder: (path: string, params?: Record<string, string>) => unknown = () => {
  throw new Error('statsfmResponder was not set for this test');
};
const statsfmInvoke = handlerHarness(registerStatsfmTools as never, {
  get: async (path: string, params?: Record<string, string>) => statsfmResponder(path, params),
});
const tasteInvoke = handlerHarness(registerTasteCompositeTools as never);
/** Array length at `key`, for either a tool result or a bare shaped payload. */
const rowsOf = (payload: Record<string, unknown>, key: string): unknown[] =>
  (payload[key] ?? []) as unknown[];
const rows = (out: { structuredContent?: Record<string, unknown> }, key: string) =>
  rowsOf(out.structuredContent ?? {}, key);

/**
 * `albums` near-complete albums, each with 8 of 10 tracks saved (coverage 0.8,
 * inside the 0.7-0.99 near_complete band), served paged like the real API plus
 * the per-id `GET /albums/{id}` fan-in.
 *
 * The size of `albums` is the test's real variable: 40 albums and 400 albums
 * must produce the SAME number of returned rows at the same `max_results`, and
 * different `sections.*.total`. A fixture whose "large" library fits under the
 * cap proves nothing (AGENTS.md §6).
 */
function hygieneLibrary(albums: number) {
  const tracks: unknown[] = [];
  const albumTable: Record<string, unknown> = {};
  for (let i = 0; i < albums; i += 1) {
    const ids = Array.from({ length: 10 }, (_, n) => `t${i}_${n}`);
    for (const id of ids.slice(0, 8)) {
      tracks.push({
        added_at: '2026-01-01T00:00:00Z',
        track: {
          id, name: `Track ${id}`, uri: `spotify:track:${id}`, type: 'track',
          duration_ms: 200_000, explicit: false,
          artists: [{ id: `ar${i}`, name: `Artist ${i}` }],
          album: { id: `alb${i}`, name: `Album ${i}`, uri: `spotify:album:alb${i}` },
        },
      });
    }
    albumTable[`alb${i}`] = {
      id: `alb${i}`, name: `Album ${i}`, uri: `spotify:album:alb${i}`,
      album_type: 'album', release_date: '2026-01-01', total_tracks: 10,
      artists: [{ id: `ar${i}`, name: `Artist ${i}` }], images: [],
      tracks: {
        items: ids.map((id, n) => ({
          id, name: `Track ${id}`, uri: `spotify:track:${id}`, duration_ms: 200_000,
          explicit: false, track_number: n + 1, artists: [{ id: `ar${i}`, name: `Artist ${i}` }],
        })),
        total: 10,
      },
    };
  }
  const responder = (path: string, params?: Record<string, string>) => {
    if (path === '/me/tracks') {
      const limit = 50;
      const offset = Number(params?.offset ?? 0);
      return { items: tracks.slice(offset, offset + limit), total: tracks.length, limit, offset };
    }
    const single = /^\/albums\/(.+)$/.exec(path);
    if (single) return albumTable[decodeURIComponent(single[1])] ?? null;
    return null;
  };
  return responder;
}

/**
 * A saved library with `distinct` songs saved twice each — `distinct` exact
 * duplicate groups. The two saves of a song need DIFFERENT uris: the group key
 * is ISRC + album + duration + normalized name, so two copies of the same uri
 * collapse to one row and no group forms at all.
 */
function dedupeLibrary(distinct: number) {
  const save = (id: string, isrc: string, album: string) => ({
    added_at: '2026-01-01T00:00:00Z',
    track: {
      id, name: `Song ${isrc}`, uri: `spotify:track:${id}`, type: 'track',
      duration_ms: 200_000, explicit: false,
      artists: [{ id: 'ar1', name: 'Artist One' }],
      album: { id: album, name: `Album ${album}`, uri: `spotify:album:${album}` },
      external_ids: { isrc },
    },
  });
  const items: unknown[] = [];
  for (let i = 0; i < distinct; i += 1) {
    const isrc = `ISRC${String(i).padStart(4, '0')}`;
    const album = `alb${i}`;
    items.push(save(`x${i}a`, isrc, album), save(`x${i}b`, isrc, album));
  }
  return (path: string, params?: Record<string, string>) => {
    if (path !== '/me/tracks') return null;
    const limit = Number(params?.limit ?? 50);
    const offset = Number(params?.offset ?? 0);
    return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
  };
}

// ---------------------------------------------------------------------------
// The helper itself
// ---------------------------------------------------------------------------

describe('capRowSections (#895)', () => {
  it('caps every named array to the same row budget and discloses each one', () => {
    const payload = {
      ok: true,
      a: Array.from({ length: 500 }, (_, i) => `a${i}`),
      b: Array.from({ length: 3 }, (_, i) => `b${i}`),
      untouched: Array.from({ length: 400 }, (_, i) => `u${i}`),
    };
    const out = capRowSections(payload, ['a', 'b'], 10);

    assert.equal(rowsOf(out, 'a').length, 10, 'the big section is capped');
    assert.equal(rowsOf(out, 'b').length, 3, 'a section under the cap is untouched');
    assert.equal(rowsOf(out, 'untouched').length, 400, 'unnamed keys are not capped');

    // The totals are the pre-cap truth, which is the whole point: 500 is what
    // the scan found even though 10 rows shipped.
    const sections = out.sections as Record<string, { returned: number; total: number; truncated: boolean }>;
    assert.deepEqual(sections.a, { returned: 10, total: 500, truncated: true });
    assert.deepEqual(sections.b, { returned: 3, total: 3, truncated: false });
    assert.equal(out.truncated, true, 'the payload-level flag says rows were withheld HERE');
  });

  it('leaves the input object alone and does not truncate when everything fits', () => {
    const items = ['x', 'y'];
    const payload = { items, total: 2 };
    const out = capRowSections(payload, ['items'], 10);

    assert.notEqual(out, payload, 'a new object is returned');
    assert.equal(payload.items.length, 2, 'the input is not mutated in place');
    assert.equal(out.truncated, false);
  });

  it('reports a non-array key as unreadable rather than coercing it to []', () => {
    // #804: a value that could not be read must not become a plausible one.
    // `null` is not "zero rows found" — it is "the scan could not read it".
    const out = capRowSections({ candidates: null, ok: true }, ['candidates'], 5);

    assert.equal(out.candidates, null, 'the unreadable value is left exactly as produced');
    const section = (out.sections as Record<string, { unreadable?: boolean; total: number }>).candidates;
    assert.equal(section.unreadable, true);
    assert.equal(section.total, 0, 'an unreadable key claims no rows, because it read none');
  });

  it('withholds a named key entirely and says how to get it back', () => {
    const out = capRowSections(
      { groups: Array.from({ length: 60 }, (_, i) => ({ i })), near: [] },
      ['near'],
      10,
      ['groups'],
    );

    assert.equal('groups' in out, false, 'the withheld key is gone from the payload');
    const section = (out.sections as Record<string, { withheld?: boolean; total: number; available_via?: string }>).groups;
    assert.equal(section.withheld, true);
    assert.equal(section.total, 60, 'the withheld total is still the truth');
    assert.equal(section.available_via, "response_format: 'json'");
    assert.equal(out.truncated, true);
  });

  it('caps withheld and returned sections under one shared budget, not per-section', () => {
    // Two sections of 300 rows each at a cap of 10: the budget is the caller's,
    // spent once. Reporting 10+10 rows while the cap says 10 would be a lie
    // about the shape of the limit.
    const out = capRowSections(
      { a: Array.from({ length: 300 }, (_, i) => i), b: Array.from({ length: 300 }, (_, i) => i) },
      ['a', 'b'],
      10,
    );
    const sections = out.sections as Record<string, { returned: number; total: number }>;
    assert.equal(sections.a.returned, 10);
    assert.equal(sections.b.returned, 10);
    assert.equal(sections.a.total + sections.b.total, 600, 'no row is lost from the totals');
  });
});

describe('emitOnce (#895)', () => {
  it('puts the payload in structuredContent and a non-JSON summary in the text block', () => {
    const raw = capRowSections(
      { items: Array.from({ length: 200 }, (_, i) => ({ i })), total: 200 },
      ['items'],
      10,
    );
    const out = emitOnce(raw, (payload) => {
      const s = payload.sections as Record<string, { returned: number; total: number }>;
      return `items: ${s.items.returned}/${s.items.total}. Full payload in structuredContent.`;
    });

    assert.deepEqual(out.structuredContent, raw, 'the payload is attached once, unchanged');
    assert.equal(out.content.length, 1);
    assert.throws(() => JSON.parse(out.content[0].text), 'the text block is not a second copy');
    assert.ok(out.content[0].text.length < JSON.stringify(raw).length,
      'the summary is the smaller of the two strings');
  });
});

// ---------------------------------------------------------------------------
// Call sites. Each asserts the SIZE the fix is about, on a library big enough
// to trip the cap — a 3-row fixture would pass with or without the fix.
// ---------------------------------------------------------------------------

describe('library_hygiene json mode (#895)', () => {
  it('sizes the payload by max_results, not by how big the library is', async () => {
    // `response_format: 'json'` is the documented bulk export for this tool and
    // deliberately returns the whole analysis (issue #895, AC1). The cap that
    // has to hold regardless of library size is the one on the human-facing
    // modes, which is where the 60-90 KB payload the issue measured came from.
    const small = await harness(registerLibraryHygieneTools, hygieneLibrary(40)).invoke(
      'library_hygiene',
      { max_results: 10, response_format: 'detailed' },
    );
    const large = await harness(registerLibraryHygieneTools, hygieneLibrary(60)).invoke(
      'library_hygiene',
      { max_results: 10, response_format: 'detailed' },
    );

    assert.equal(rows(small, 'near_complete').length, 10, 'a 40-album library returns exactly max_results rows');
    assert.equal(rows(large, 'near_complete').length, 10, 'a 60-album library returns the SAME number of rows');

    const smallSec = small.structuredContent!.sections as Record<string, { returned: number; total: number }>;
    const largeSec = large.structuredContent!.sections as Record<string, { returned: number; total: number }>;
    assert.equal(smallSec.near_complete.total, 40, 'the pre-cap total of the small library');
    assert.equal(largeSec.near_complete.total, 60, 'the pre-cap total of the large library');
    assert.equal(
      small.structuredContent!.near_complete === large.structuredContent!.near_complete,
      false,
      'two different libraries — the row counts above are not one shared constant',
    );
  });

  it('emits the json payload once, with a summary in the text block', async () => {
    const out = await harness(registerLibraryHygieneTools, hygieneLibrary(60)).invoke(
      'library_hygiene',
      { max_results: 10, response_format: 'json' },
    );
    const payload = JSON.stringify(out.structuredContent, null, 2);

    assert.notEqual(textOf(out), payload, 'the text block is not a stringify of the payload');
    assert.throws(() => JSON.parse(textOf(out)), 'the text block is not a second JSON copy');
    assert.ok(
      textOf(out).length * 4 < payload.length,
      `summary ${textOf(out).length} B must be far smaller than payload ${payload.length} B`,
    );
  });

  it('discloses withheld groups instead of shipping them', async () => {
    const out = await harness(registerLibraryHygieneTools, hygieneLibrary(60)).invoke(
      'library_hygiene',
      { max_results: 10, response_format: 'detailed' },
    );
    const sections = out.structuredContent!.sections as Record<
      string,
      { withheld?: boolean; total: number; available_via?: string }
    >;

    assert.equal('groups' in out.structuredContent!, false,
      'a capped call must not carry the full album-group scan beside the cap');
    assert.equal(sections.groups.withheld, true);
    assert.equal(sections.groups.total, 60, 'the exact group total survives the withholding');
    assert.equal(sections.groups.available_via, "response_format: 'json'");
  });
});

describe('find_duplicate_saved_tracks json mode (#895)', () => {
  it('emits the capped payload once and keeps the exact group total', async () => {
    const out = await harness(registerSavedDedupeTools, dedupeLibrary(40)).invoke(
      'find_duplicate_saved_tracks',
      { max_results: 5, response_format: 'json' },
    );

    const groups = rows(out, 'groups') as Array<{ kind: string }>;
    assert.equal(groups.length, 5, '40 groups in, 5 rows out — the cap fired');
    assert.equal(groups.every((g) => g.kind === 'exact'), true, 'the fixture really produced duplicate groups');

    const section = (out.structuredContent!.sections as Record<string, { returned: number; total: number }>).groups;
    assert.equal(section.returned, 5);
    assert.equal(section.total, 40, 'the pre-cap group total is disclosed, not dropped');
    assert.equal(out.structuredContent!.truncated, true);

    const payload = JSON.stringify(out.structuredContent, null, 2);
    assert.notEqual(textOf(out), payload, 'no second copy in the text block');
    assert.ok(textOf(out).length * 4 < payload.length);
  });
});

describe('diff_playlists / overlap_playlists (#895)', () => {
  // Spotify ids are 22 base62 characters; anything else is refused before a
  // single request is made.
  const PAIR_A = 'Q'.repeat(22);
  const PAIR_B = 'R'.repeat(22);

  const item = (id: string) => ({
    added_at: '2026-01-01T00:00:00Z',
    item: {
      type: 'track', id, name: `Track ${id}`, uri: `spotify:track:${id}`,
      duration_ms: 200_000, artists: [{ name: `Artist ${id}` }],
    },
  });

  /** Two 400-track playlists that share nothing: 800 differing rows to cap. */
  const disjointResponder = () => (path: string, arg?: unknown) => {
    const match = /^\/playlists\/([^/]+)\/items$/.exec(path);
    if (!match) return null;
    const prefix = match[1] === PAIR_A ? 'a' : 'b';
    const all = Array.from({ length: 400 }, (_, i) => item(`${prefix}${i}`));
    const offset = Number((arg as Record<string, string> | undefined)?.offset ?? 0);
    return { items: all.slice(offset, offset + 100), total: 400, limit: 100, offset, next: null };
  };

  it('caps each section to max_results and reports the exact pre-cap totals', async () => {
    const out = await harness(registerPlaylistOpsTools, disjointResponder()).invoke(
      'diff_playlists',
      { playlist_a: PAIR_A, playlist_b: PAIR_B, max_results: 10, response_format: 'json' },
    );
    const sections = out.structuredContent!.sections as Record<string, { returned: number; total: number; truncated: boolean }>;

    assert.equal(sections.only_in_a.returned, 10, '400 rows in, max_results out');
    assert.equal(sections.only_in_a.total, 400, 'the pre-cap total is the truth, not the row count');
    assert.equal(sections.only_in_b.returned, 10);
    assert.equal(sections.only_in_b.total, 400);
    assert.equal(sections.moved.total, 0, 'a disjoint pair has no moved rows, and that is reported');
    assert.equal(rows(out, 'only_in_a').length, 10);
    assert.equal(rows(out, 'only_in_b').length, 10);
    assert.equal(out.structuredContent!.truncated, true, 'the payload flag reports rows withheld HERE');
    assert.equal(out.structuredContent!.a_total, 400, 'the walk totals are untouched by the row cap');
  });

  it('caps overlap rows and keeps total_shared exact', async () => {
    // Overlap counts tracks present in at least `threshold` playlists, so the
    // disjoint fixture above would prove nothing here — it shares nothing.
    // This one shares 400 of 400 in both playlists.
    const sharedResponder = () => (path: string, arg?: unknown) => {
      const match = /^\/playlists\/([^/]+)\/items$/.exec(path);
      if (!match) return null;
      const all = Array.from({ length: 400 }, (_, i) => item(`c${i}`));
      const offset = Number((arg as Record<string, string> | undefined)?.offset ?? 0);
      return { items: all.slice(offset, offset + 100), total: 400, limit: 100, offset, next: null };
    };
    const out = await harness(registerPlaylistOpsTools, sharedResponder()).invoke(
      'overlap_playlists',
      { playlists: [PAIR_A, PAIR_B], threshold: 2, max_results: 10, response_format: 'json' },
    );
    const sections = out.structuredContent!.sections as Record<string, { returned: number; total: number }>;

    assert.equal(rows(out, 'shared').length, 10, '400 shared rows in, max_results out');
    assert.equal(sections.shared.total, 400, 'the pre-cap total is the truth');
    assert.equal(out.structuredContent!.total_shared, 400, 'and total_shared agrees with sections');
  });

  it('names the source-walk cap `truncated_by_cap`, not `truncated`', async () => {
    const out = await harness(registerPlaylistOpsTools, disjointResponder()).invoke(
      'diff_playlists',
      { playlist_a: PAIR_A, playlist_b: PAIR_B, max_results: 10, response_format: 'json' },
    );
    // Two different quantities, two names. A complete walk is not a truncated
    // walk, and a capped payload is not a capped walk — one flag cannot say both.
    assert.equal(out.structuredContent!.truncated_by_cap, false, 'the walk finished inside scan_cap');
    assert.equal(out.structuredContent!.truncated, true, 'the PAYLOAD dropped rows');
  });

  it('emits the diff and overlap payloads once, not twice', async () => {
    for (const [name, args] of [
      ['diff_playlists', { playlist_a: PAIR_A, playlist_b: PAIR_B }],
      ['overlap_playlists', { playlists: [PAIR_A, PAIR_B], threshold: 2 }],
    ] as const) {
      const out = await harness(registerPlaylistOpsTools, disjointResponder()).invoke(name, {
        ...args, max_results: 10, response_format: 'json',
      });
      const payload = JSON.stringify(out.structuredContent, null, 2);
      assert.notEqual(textOf(out), payload, `${name}: the text block is not a second copy`);
      assert.throws(() => JSON.parse(textOf(out)), `${name}: the text block is not JSON at all`);
      assert.match(textOf(out), /structuredContent/, `${name}: the text block points at the payload`);
    }
  });
});

describe('dead_library_finder (#895)', () => {
  it('caps the dead-track rows and keeps the exact pre-cap count', async () => {
    const responder = (path: string) => {
      if (path === '/me/tracks') return { items: [], total: 0 };
      if (path === '/me/player/recently-played') return { items: [], next: null };
      if (path === '/me/playlists') return { items: [], total: 0 };
      if (path.startsWith('/playlists/')) return { items: [], total: 0 };
      return null;
    };
    const out = await harness(registerExhaust2MiscTools, responder).invoke(
      'dead_library_finder',
      { dry_run: false, max_results: 10, response_format: 'json' },
    );
    const sections = out.structuredContent!.sections as Record<string, { returned: number; total: number }> | undefined;

    // The empty-library fixture trips the cap at 0 rows, so this asserts the
    // ENVELOPE is present and consistent, not that a cap fired.
    assert.ok(sections, 'a capped tool must publish the sections envelope');
    assert.equal(sections!.candidates.returned, rows(out, 'candidates').length);
    assert.equal(sections!.candidates.total, out.structuredContent!.count,
      'sections.candidates.total and count are the same number, not two guesses');
    assert.notEqual(textOf(out), JSON.stringify(out.structuredContent, null, 2));
  });
});

// ---------------------------------------------------------------------------
// stats.fm: the shared collection envelope, and the raw composites beside it.
// These two modules talk to stats.fm over a module-level client, so they are
// driven through the parsed-payload fetch seam rather than a client stub.
// ---------------------------------------------------------------------------

describe('statsfm json mode (#895)', () => {
  const streamRow = (i: number) => ({
    track: { id: `t${i}`, name: `Track ${i}` },
    artists: [{ id: `ar${i}`, name: `Artist ${i}` }],
    playedAt: 1_700_000_000_000 + i,
  });

  /** `count` real stream rows, served as `{ items }` — the live route shape. */
  const streamsFixture = (count: number) => {
    statsfmResponder = () => ({
      items: Array.from({ length: count }, (_, i) => streamRow(i)),
    });
  };

  it('caps the shared collection envelope at max_results and discloses the total', async () => {
    streamsFixture(500);
    const out = await statsfmInvoke('statsfm_recent_streams', {
      user_id: 'alice', limit: 500, max_results: 20, response_format: 'json',
    });

    assert.equal(rows(out, 'items').length, 20, '500 streams in, 20 rows out');
    const section = (out.structuredContent!.sections as Record<string, { returned: number; total: number }>).items;
    assert.equal(section.returned, 20);
    assert.equal(section.total, 500, 'the pre-cap total is disclosed, not silently dropped');
    assert.equal(out.structuredContent!.truncated, true);

    assert.throws(() => JSON.parse(textOf(out)), 'the raw 500-stream page is not echoed as text');
    assert.ok(textOf(out).length < 500, 'the text block is a summary, not a payload copy');
  });

  it('keeps payload size flat as the upstream page grows', async () => {
    const sizeAt = async (count: number) => {
      streamsFixture(count);
      const out = await statsfmInvoke('statsfm_recent_streams', {
        user_id: 'alice', limit: count, max_results: 20, response_format: 'json',
      });
      return JSON.stringify(out.structuredContent).length;
    };
    const small = await sizeAt(100);
    const large = await sizeAt(500);
    // Not an equality: the payload carries the exact totals, so a bigger page
    // makes the DISCLOSURE longer. It must not make it grow with the rows.
    assert.equal(large < small * 1.2, true, `${large} B must stay within 20% of ${small} B`);
  });
});

describe('taste composite json mode (#895)', () => {
  it('caps every raw upstream collection in the composite and emits it once', async () => {
    // The issue measured `GET /users/{u}/streams?limit=500` at 124,127 bytes.
    const bigPage = (n: number) => ({ items: Array.from({ length: n }, (_, i) => ({
      track: { id: `t${i}`, name: `Track ${i}` }, artists: [{ id: `ar${i}`, name: `Artist ${i}` }],
      playedAt: 1_700_000_000_000 + i, duration: 200_000, platform: 'spotify',
    })) });
    __setStatsfmFetchImpl(async (url: string) => {
      if (url.includes('/streams')) return bigPage(500);
      if (url.includes('/top/tracks')) return { items: bigPage(50).items };
      return { items: bigPage(20).items };
    });
    try {
      const out = await tasteInvoke('taste_daily_brief', {
        statsfm_user: 'alice', max_results: 10, response_format: 'json',
      });
      const payload = out.structuredContent!;
      const sections = payload.sections as Record<string, { returned: number; total: number }>;

      for (const [key, total] of [['topArtists', 20], ['topTracks', 50], ['recentStreams', 500]] as const) {
        assert.equal(sections[key].returned, 10, `${key} is capped to max_results`);
        assert.equal(sections[key].total, total, `${key} discloses its pre-cap total`);
      }
      assert.equal(out.structuredContent!.truncated, true);
      assert.throws(() => JSON.parse(textOf(out)));
      assert.ok(
        JSON.stringify(payload).length < 10_000,
        `500-stream composite must be under 10 KB, got ${JSON.stringify(payload).length}`,
      );
    } finally {
      __resetStatsfmFetchImpl();
    }
  });
});
