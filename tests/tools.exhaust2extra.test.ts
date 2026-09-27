import { DEFAULT_TOKEN_FILE } from './helpers/hermetic.js';

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import {
  evalSetExpression,
  parseSetExpression,
  pickRoundRobin,
  rankCoverCandidates,
  registerExhaust2ExtraTools,
} from '../src/tools/exhaust2_extra.js';

type ToolContent = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> };
type RegisteredTool = { name: string; description: string; schema: Record<string, unknown>; handler: (a: Record<string, unknown>) => Promise<ToolContent> };
type Call = { method: string; path: string; params?: Record<string, unknown>; body?: unknown };

interface FakeClient {
  // Mirrored from the real `SpotifyClient.tokenFile: string` (src/client.ts).
  // The account stores key by it, so a double without it is not a client the
  // tools can route through (#1385).
  tokenFile: string;
  get: (path: string, params?: Record<string, unknown>) => Promise<unknown>;
  post: (path: string, body?: unknown) => Promise<unknown>;
  putRaw: (path: string, body: string) => Promise<unknown>;
  getAllPages: (path: string, params?: Record<string, unknown>, opts?: unknown) => Promise<unknown[]>;
  getAllPagesWithTruncation: (
    path: string,
    params?: Record<string, unknown>,
    opts?: { maxItems?: number },
  ) => Promise<{
    items: unknown[];
    truncated: boolean;
    truncatedByCap: boolean;
    reportedTotal: number | null;
    pages: number;
  }>;
  calls: Call[];
}

/**
 * The registrar's `client` parameter, as the value this file hands it.
 *
 * `SpotifyClient` is a CLASS with private state (the 429 queue, the TTL cache,
 * the token loader), so no structural double satisfies it — and this double is
 * deliberately structural, since its job is to record calls rather than make
 * them. The cast is therefore confined to the one place the two meet: the
 * object literal is still built and checked as a `FakeClient`, so the members
 * it claims are verified, and `calls` is kept in the return type so assertions
 * read the real log.
 *
 * What the cast stops catching: changes to the ~65 members of `SpotifyClient`
 * this file never invokes. The alternative was that cast at each of the 15
 * registration sites, which is 15 chances to cast the wrong thing.
 */
type RegistrarClient = SpotifyClient & Pick<FakeClient, 'calls'>;

/**
 * A paged route: an array is the playlist's WHOLE item list, and this shim
 * pages it the way `SpotifyClient.getAllPagesWithTruncation` does, so a route
 * of 5 rows and a cap of 2 really does stop at 2 and really does report
 * truncation. The client-side walk loop itself is covered in client.test.ts;
 * this file drives the CALL SITE (what cap it passes, what it does with the
 * verdict). `tests/exhaust2extra-fetchcap.test.ts` runs the same slice against
 * the real client so the loop is never only this shim's version of it.
 */
function makeFakeClient(routes: Record<string, unknown>): RegistrarClient {
  const calls: Call[] = [];
  const self: FakeClient = {
    calls,
    // The real SpotifyClient always sets this at construction; a stub that
    // omits it is not a client the stores can key by (#1385).
    tokenFile: DEFAULT_TOKEN_FILE,
    get: async (path, params) => {
      calls.push({ method: 'GET', path, params });
      const out = routes[path];
      if (out instanceof Error) throw out;
      return typeof out === 'function'
        ? (out as (params?: Record<string, unknown>) => unknown)(params)
        : out ?? null;
    },
    post: async (path, body) => {
      calls.push({ method: 'POST', path, body });
      const out = routes[`POST ${path}`];
      if (out instanceof Error) throw out;
      return out ?? { id: 'new-pl-1' };
    },
    putRaw: async (path, body) => {
      calls.push({ method: 'PUT', path, body });
      const out = routes[`PUT ${path}`];
      if (out instanceof Error) throw out;
      return out ?? {};
    },
    getAllPages: async function (this: FakeClient, path: string) {
      calls.push({ method: 'GET', path, body: { paged: true } });
      const out = routes[path];
      if (out instanceof Error) throw out;
      return Array.isArray(out) ? out : [];
    },
    getAllPagesWithTruncation: async (path, params, opts) => {
      const maxItems = opts?.maxItems ?? Number.MAX_SAFE_INTEGER;
      const pageSize = Number(params?.limit ?? 100) || 100;
      const rows = (() => {
        const out = routes[path];
        if (out instanceof Error) throw out;
        return Array.isArray(out) ? out : [];
      })();
      const total = rows.length;
      const all: unknown[] = [];
      let offset = 0;
      // #899: the tools report a read cost, and this fixture has to count the
      // pages the way the real client does — incremented after each GET and
      // before the loop can break, so a walk that ends on a short page still
      // spends (and reports) that request. Hardcoding it here would make the
      // read-cost assertions measure the fixture rather than the tool.
      let pages = 0;
      for (;;) {
        const slice = rows.slice(offset, offset + pageSize);
        calls.push({ method: 'GET', path, params: { ...params, offset: String(offset) } });
        pages++;
        all.push(...slice);
        if (all.length >= maxItems) {
          return {
            items: all.slice(0, maxItems),
            truncated: all.length > maxItems || all.length < total,
            truncatedByCap: true,
            reportedTotal: total,
            pages,
          };
        }
        if (slice.length < pageSize) break;
        offset += pageSize;
      }
      return {
        items: all,
        truncated: all.length < total,
        truncatedByCap: false,
        reportedTotal: total,
        pages,
      };
    },
  };
  return self as unknown as RegistrarClient;
}

/**
 * The recording double for the registrar's `server` argument.
 *
 * Cast ONCE here rather than at each of the 15 registration sites below: the
 * cast is a claim about this file's harness (a `tool()` recorder, not an SDK
 * server), and repeating it would make 15 chances to cast the wrong thing. The
 * recorder's own shape is still checked — the literal has to satisfy
 * `RegisteredTool` before it is asserted to be an `McpServer`.
 */
function makeServer(registered: RegisteredTool[]): McpServer {
  return {
    tool: (name: string, description: string, schema: Record<string, unknown>, handler: RegisteredTool['handler']) =>
      registered.push({ name, description, schema, handler }),
  } as unknown as McpServer;
}

function find(registered: RegisteredTool[], name: string): RegisteredTool {
  const t = registered.find((x) => x.name === name);
  assert.ok(t, `missing tool ${name}`);
  return t!;
}

function text(r: ToolContent): string {
  return r.content.map((c) => c.text).join('\n');
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const SETS: Record<string, string[]> = {
  aaa: ['spotify:track:1', 'spotify:track:2', 'spotify:track:3'],
  bbb: ['spotify:track:2', 'spotify:track:3', 'spotify:track:4'],
  ccc: ['spotify:track:3', 'spotify:track:5'],
};

const routesForSets = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...Object.fromEntries(
    Object.entries(SETS).map(([ref, uris]) => [
      `/playlists/${ref}/items`,
      uris.map((uri) => ({ added_at: '2026-01-01', item: { type: 'track', uri } })),
    ]),
  ),
  ...Object.fromEntries(Object.keys(SETS).map((ref) => [`/playlists/${ref}`, { id: ref, name: ref }])),
  ...extra,
});

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test('set algebra: ∪ / ∩ / − with dedupe and first-seen order', () => {
  const resolve = (ref: string) => SETS[ref] ?? [];
  const a = parseSetExpression('aaa ∪ bbb');
  assert.deepEqual(evalSetExpression(a.ast, resolve), ['spotify:track:1', 'spotify:track:2', 'spotify:track:3', 'spotify:track:4']);
  const i = parseSetExpression('aaa ∩ bbb');
  assert.deepEqual(evalSetExpression(i.ast, resolve), ['spotify:track:2', 'spotify:track:3']);
  const d = parseSetExpression('aaa − bbb');
  assert.deepEqual(evalSetExpression(d.ast, resolve), ['spotify:track:1']);
});

test('set algebra: ASCII aliases and parenthesised precedence', () => {
  const resolve = (ref: string) => SETS[ref] ?? [];
  // A ∪ (B ∩ C) − D with fixtures: (bbb ∩ ccc) = {t3, t5}; aaa ∪ that = {t1,t2,t3,t5}; minus ccc {t3,t5} = {t1,t2}
  const e = parseSetExpression('aaa | (bbb & ccc) + ccc');
  // precedence: & tightest, then | left-assoc → (aaa | (bbb & ccc)) | ccc = {t1,t2,t3,t5}
  assert.deepEqual(evalSetExpression(e.ast, resolve), ['spotify:track:1', 'spotify:track:2', 'spotify:track:3', 'spotify:track:5']);
  const grouped = parseSetExpression('(aaa + bbb) - (bbb & ccc)');
  // (aaa ∪ bbb) = {t1..t4}; (bbb ∩ ccc) = {t3}; diff = {t1,t2,t4}
  assert.deepEqual(evalSetExpression(grouped.ast, resolve), ['spotify:track:1', 'spotify:track:2', 'spotify:track:4']);
});

test('pickRoundRobin cycles queries, skips seen, respects target', () => {
  const picks = pickRoundRobin(
    [['spotify:track:1', 'spotify:track:2'], ['spotify:track:2', 'spotify:track:3', 'spotify:track:4']],
    ['q0', 'q1'],
    3,
    new Set(['spotify:track:1']),
  );
  // pass 1: q0 skips t1 (seen) → t2; q1 skips t2 → t3. pass 2: q0 exhausted; q1 → t4.
  assert.deepEqual(
    picks.map((p) => p.uri),
    ['spotify:track:2', 'spotify:track:3', 'spotify:track:4'],
  );
  assert.equal(picks[0]?.query_index, 0);
  assert.equal(picks[1]?.query_index, 1);
  assert.equal(picks[2]?.query_index, 1);
});

test('rankCoverCandidates orders largest first, unknown widths last (stable)', () => {
  // `height` is required on the real `SpotifyImage` and is carried as `null`
  // throughout: the ranking reads `width` alone, and a fixture that varied
  // height too would invite a reader to think it had a bearing on the order.
  const ranked = rankCoverCandidates([
    { url: 'small', width: 64, height: null },
    { url: 'unknown-a', width: null, height: null },
    { url: 'big', width: 640, height: null },
    { url: 'unknown-b', width: null, height: null },
  ]);
  assert.deepEqual(ranked.map((r) => r.url), ['big', 'small', 'unknown-a', 'unknown-b']);
});

// ---------------------------------------------------------------------------
// tool behaviour
// ---------------------------------------------------------------------------

test('playlist_fill_from_search dry run plans picks without POSTing', async () => {
  const client = makeFakeClient({
    '/playlists/mix1': { id: 'mix1', name: 'Mix' },
    '/playlists/mix1/items': [{ added_at: '2026-01-01', item: { type: 'track', uri: 'spotify:track:1' } }],
    '/search': { tracks: { items: [{ uri: 'spotify:track:2' }, { uri: 'spotify:track:1' }, { uri: 'spotify:track:3' }] } },
  });
  const registered: RegisteredTool[] = [];
  registerExhaust2ExtraTools(makeServer(registered), client);
  const t = find(registered, 'playlist_fill_from_search');
  const r = await t.handler({ playlist_id: 'mix1', queries: ['alpha'], target_count: 2 });
  const p = r.structuredContent as Record<string, unknown>;
  assert.equal(p.dry_run, true);
  assert.equal(p.added, 2); // t2 then t3; t1 already in playlist
  const picks = p.picks as Array<{ uri: string }>;
  assert.deepEqual(picks.map((x) => x.uri), ['spotify:track:2', 'spotify:track:3']);
  assert.match(text(r), /\[dry run\]/);
  assert.equal(client.calls.filter((c) => c.method === 'POST').length, 0);
});

test('playlist_fill_from_search caps each search page at 10 and pages deterministically', async () => {
  const firstPage = Array.from({ length: 10 }, (_, i) => ({ uri: `spotify:track:${i + 1}` }));
  const secondPage = Array.from({ length: 2 }, (_, i) => ({ uri: `spotify:track:${i + 11}` }));
  const client = makeFakeClient({
    '/playlists/mix1': { id: 'mix1', name: 'Mix' },
    '/playlists/mix1/items': [],
    '/search': (params?: Record<string, unknown>) => ({
      tracks: { items: params?.offset === '10' ? secondPage : firstPage, total: 12 },
    }),
  });
  const registered: RegisteredTool[] = [];
  registerExhaust2ExtraTools(makeServer(registered), client);
  const r = await find(registered, 'playlist_fill_from_search').handler({
    playlist_id: 'mix1',
    queries: ['alpha'],
    target_count: 12,
  });

  const searchCalls = client.calls.filter((call) => call.path === '/search');
  assert.deepEqual(searchCalls.map((call) => call.params), [
    { q: 'alpha', type: 'track', limit: '10' },
    { q: 'alpha', type: 'track', limit: '10', offset: '10' },
  ]);
  const payload = r.structuredContent as Record<string, unknown>;
  assert.deepEqual(
    (payload.candidates_per_query as Array<Record<string, unknown>>)[0],
    {
      query_index: 0,
      query: 'alpha',
      candidates: 12,
      pages_searched: 2,
      candidate_uris: Array.from({ length: 12 }, (_, i) => `spotify:track:${i + 1}`),
      exhausted: true,
    },
  );
  assert.deepEqual(
    (payload.picks as Array<{ uri: string }>).map((pick) => pick.uri),
    Array.from({ length: 12 }, (_, i) => `spotify:track:${i + 1}`),
  );
});

test('playlist_fill_from_search commit adds chunked POSTs', async () => {
  const client = makeFakeClient({
    '/playlists/mix1': { id: 'mix1', name: 'Mix' },
    '/playlists/mix1/items': [],
    '/search': { tracks: { items: [{ uri: 'spotify:track:9' }] } },
  });
  const registered: RegisteredTool[] = [];
  registerExhaust2ExtraTools(makeServer(registered), client);
  const t = find(registered, 'playlist_fill_from_search');
  const r = await t.handler({ playlist_id: 'mix1', queries: ['alpha'], target_count: 1, dry_run: false, response_format: 'json' });
  const p = r.structuredContent as Record<string, unknown>;
  assert.equal(p.dry_run, false);
  assert.equal(p.requests, 1);
  const posts = client.calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.path, '/playlists/mix1/items');
});

test('playlist_expression_algebra dry run reports ref sizes and result preview', async () => {
  const client = makeFakeClient(routesForSets());
  const registered: RegisteredTool[] = [];
  registerExhaust2ExtraTools(makeServer(registered), client);
  const t = find(registered, 'playlist_expression_algebra');
  const r = await t.handler({ expression: 'aaa ∪ bbb', target_name: 'Union Result' });
  const p = r.structuredContent as Record<string, unknown>;
  assert.equal(p.dry_run, true);
  assert.equal(p.result_count, 4);
  assert.match(text(r), /Union Result/);
  assert.equal(client.calls.filter((c) => c.method === 'POST').length, 0);
});

test('playlist_expression_algebra commit creates the playlist and adds the result', async () => {
  const client = makeFakeClient(routesForSets());
  const registered: RegisteredTool[] = [];
  registerExhaust2ExtraTools(makeServer(registered), client);
  const t = find(registered, 'playlist_expression_algebra');
  const r = await t.handler({ expression: 'aaa − bbb', target_name: 'Diff', dry_run: false, response_format: 'json' });
  const p = r.structuredContent as Record<string, unknown>;
  assert.equal(p.dry_run, false);
  assert.equal(p.result_count, 1);
  const posts = client.calls.filter((c) => c.method === 'POST');
  assert.equal(posts[0]?.path, '/me/playlists');
  assert.deepEqual((posts[0]?.body as Record<string, unknown>).name, 'Diff');
  assert.equal(posts[1]?.path, '/playlists/new-pl-1/items');
  assert.deepEqual((posts[1]?.body as Record<string, unknown>).uris, ['spotify:track:1']);
});

test('empty algebra result fails fast before writing', async () => {
  const client = makeFakeClient(routesForSets());
  const registered: RegisteredTool[] = [];
  registerExhaust2ExtraTools(makeServer(registered), client);
  const t = find(registered, 'playlist_expression_algebra');
  await assert.rejects(
    () => t.handler({ expression: 'aaa ∩ bbb − bbb', target_name: 'Empty', dry_run: false }),
    /empty set/,
  );
});

test('playlist_cover_from_track dry run names the position source without PUT', async () => {
  const client = makeFakeClient({
    '/playlists/mix1': { id: 'mix1', name: 'Mix' },
    '/playlists/mix1/items': [
      { added_at: '2026-01-01', item: { type: 'track', uri: 'spotify:track:1', name: 'One', album: { images: [{ url: 'u-small', width: 64 }] } } },
    ],
  });
  const registered: RegisteredTool[] = [];
  registerExhaust2ExtraTools(makeServer(registered), client);
  const t = find(registered, 'playlist_cover_from_track');
  const r = await t.handler({ playlist_id: 'mix1', position: 0 });
  const p = r.structuredContent as Record<string, unknown>;
  assert.equal(p.dry_run, true);
  assert.equal(p.source, 'position 0');
  assert.equal(p.track, 'spotify:track:1');
  assert.match(text(r), /\[dry run\]/);
  assert.equal(client.calls.filter((c) => c.method === 'PUT').length, 0);
});

test('playlist_cover_from_track commit fetches art and PUTs base64', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } })) as typeof fetch;
  try {
    const client = makeFakeClient({
      '/playlists/mix1': { id: 'mix1', name: 'Mix' },
      '/playlists/mix1/items': [
        { added_at: '2026-01-01', item: { type: 'track', uri: 'spotify:track:1', name: 'One', album: { images: [{ url: 'https://img/big.jpg', width: 640 }] } } },
      ],
    });
    const registered: RegisteredTool[] = [];
    registerExhaust2ExtraTools(makeServer(registered), client);
    const t = find(registered, 'playlist_cover_from_track');
    const r = await t.handler({ playlist_id: 'mix1', position: 0, dry_run: false, response_format: 'json' });
    const p = r.structuredContent as Record<string, unknown>;
    assert.equal(p.dry_run, false);
    assert.equal(p.image_url, 'https://img/big.jpg');
    const puts = client.calls.filter((c) => c.method === 'PUT');
    assert.equal(puts.length, 1);
    assert.equal(puts[0]?.path, '/playlists/mix1/images');
    assert.equal(puts[0]?.body, jpeg.toString('base64'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('playlist_cover_from_track reports the real playlist length, not the bounded walk length', async () => {
  // The playlist really holds 1000 items; the item walk is capped at 500, so
  // the row count is not the playlist length and must never be printed as one.
  const scanned = Array.from({ length: 500 }, (_, i) => ({
    added_at: '2026-01-01',
    item: { type: 'track', uri: `spotify:track:${i}`, name: `T${i}`, album: { images: [] } },
  }));
  const client = makeFakeClient({
    '/playlists/big1': { id: 'big1', name: 'Big', tracks: { total: 1000 } },
    '/playlists/big1/items': scanned,
    '/tracks/9': { uri: 'spotify:track:9', name: 'Nine', album: { images: [{ url: 'https://img/nine.jpg', width: 640 }] } },
  });
  const registered: RegisteredTool[] = [];
  registerExhaust2ExtraTools(makeServer(registered), client);
  const t = find(registered, 'playlist_cover_from_track');

  await assert.rejects(() => t.handler({ playlist_id: 'big1', position: 700 }), (err: Error) => {
    assert.match(err.message, /playlist has 1000 item\(s\)/);
    assert.match(err.message, /500 item\(s\) scanned/);
    assert.doesNotMatch(err.message, /out of range \(500 item\(s\)\)/);
    return true;
  });

  // The success-shaped answer carries both numbers separately.
  const r = await t.handler({ playlist_id: 'big1', track_uri: 'spotify:track:9' });
  const p = r.structuredContent as Record<string, unknown>;
  assert.equal(p.playlist_total, 1000);
  assert.equal(p.items_scanned, 0);
});

test('playlist_cover_from_track reads the canonical items.total, not only the legacy tracks.total', async () => {
  // Feb 2026: Spotify deprecated PlaylistObject.tracks in favour of `items`.
  // A payload carrying only the canonical page must still yield a length; the
  // pre-fix reader looked at `tracks` alone and answered "length unknown" for
  // every playlist on the current shape (#589).
  const scanned = Array.from({ length: 500 }, (_, i) => ({
    added_at: '2026-01-01',
    item: { type: 'track', uri: `spotify:track:${i}`, name: `T${i}`, album: { images: [] } },
  }));
  const client = makeFakeClient({
    '/playlists/big2': { id: 'big2', name: 'Big', items: { total: 1000 } },
    '/playlists/big2/items': scanned,
    '/tracks/9': { uri: 'spotify:track:9', name: 'Nine', album: { images: [{ url: 'https://img/nine.jpg', width: 640 }] } },
  });
  const registered: RegisteredTool[] = [];
  registerExhaust2ExtraTools(makeServer(registered), client);
  const t = find(registered, 'playlist_cover_from_track');

  await assert.rejects(() => t.handler({ playlist_id: 'big2', position: 700 }), (err: Error) => {
    assert.match(err.message, /playlist has 1000 item\(s\)/);
    assert.doesNotMatch(err.message, /playlist length unknown/);
    return true;
  });

  const r = await t.handler({ playlist_id: 'big2', track_uri: 'spotify:track:9' });
  assert.equal((r.structuredContent as Record<string, unknown>).playlist_total, 1000);
});

test('playlist_cover_from_track says the length is unknown rather than inventing one', async () => {
  // Neither page present: the answer is "unknown", not 0 and not the walk count.
  const client = makeFakeClient({
    '/playlists/empty1': { id: 'empty1', name: 'Empty' },
    '/playlists/empty1/items': [],
    '/tracks/9': { uri: 'spotify:track:9', name: 'Nine', album: { images: [{ url: 'https://img/nine.jpg', width: 640 }] } },
  });
  const registered: RegisteredTool[] = [];
  registerExhaust2ExtraTools(makeServer(registered), client);
  const t = find(registered, 'playlist_cover_from_track');

  const r = await t.handler({ playlist_id: 'empty1', track_uri: 'spotify:track:9' });
  // null, not 0: nothing stated a length, and 0 would read as "empty playlist".
  assert.equal((r.structuredContent as Record<string, unknown>).playlist_total, null);
  assert.equal((r.structuredContent as Record<string, unknown>).items_scanned, 0);

  // The walk-based error path says the same thing in prose.
  await assert.rejects(
    () => t.handler({ playlist_id: 'empty1' }),
    /playlist length unknown/,
  );
});

test('missing playlist fails fast', async () => {
  const registered: RegisteredTool[] = [];
  registerExhaust2ExtraTools(makeServer(registered), makeFakeClient({}));
  const t = find(registered, 'playlist_fill_from_search');
  await assert.rejects(() => t.handler({ playlist_id: 'nope', queries: ['x'] }), /not found/);
});

test('registers the exhaust2 extra slice (3 tools)', () => {
  const registered: RegisteredTool[] = [];
  registerExhaust2ExtraTools(makeServer(registered), makeFakeClient({}));
  const names = registered.map((t) => t.name);
  assert.equal(registered.length, 3);
  for (const expected of ['playlist_fill_from_search', 'playlist_expression_algebra', 'playlist_cover_from_track']) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
});

// ---------------------------------------------------------------------------
// #899 — bounded query arrays and the read cost they imply
// ---------------------------------------------------------------------------

describe('#899 playlist_fill_from_search bounds', () => {
  const fillHarness = () => {
    const client = makeFakeClient({
      '/playlists/mix1': { id: 'mix1', name: 'Mix' },
      '/playlists/mix1/items': [],
      '/search': { tracks: { items: [{ uri: 'spotify:track:9' }] } },
    });
    const registered: RegisteredTool[] = [];
    registerExhaust2ExtraTools(makeServer(registered), client);
    return { client, t: find(registered, 'playlist_fill_from_search') };
  };

  // The harness records the raw shape, so the bound is asserted against the
  // real zod schema rather than a hand-copied copy of it.
  const schemaFor = (t: RegisteredTool) => z.object(t.schema as z.ZodRawShape);

  test('rejects more than 25 queries and names the per-query read cost', () => {
    const { t } = fillHarness();
    const tooMany = Array.from({ length: 26 }, (_, i) => `q${i}`);
    // A bare "too big" would leave the reader unable to tell a Spotify limit
    // from a typo; the bound exists because each query is its own search walk.
    assert.throws(() => schemaFor(t).parse({ playlist_id: 'mix1', queries: tooMany }), (err: Error) => {
      assert.match(err.message, /max 25 per call/);
      assert.match(err.message, /separate paged search per query/);
      return true;
    });
  });

  test('accepts exactly 25 queries', () => {
    const { t } = fillHarness();
    const queries = Array.from({ length: 25 }, (_, i) => `q${i}`);
    const parsed = schemaFor(t).parse({ playlist_id: 'mix1', queries });
    assert.deepEqual((parsed as { queries: string[] }).queries, queries);
  });

  test('accepts a comma-separated query string bounded by the same 25-item limit', () => {
    const { t } = fillHarness();
    const csv = Array.from({ length: 25 }, (_, i) => `q${i}`).join(',');
    const parsed = schemaFor(t).parse({ playlist_id: 'mix1', queries: csv }) as { queries: string[] };
    // The CSV form normalises BEFORE the bound, so it must not be a way
    // around it.
    assert.equal(parsed.queries.length, 25);
    assert.throws(
      () => schemaFor(t).parse({ playlist_id: 'mix1', queries: `${csv},q26` }),
      /max 25 per call/,
    );
  });

  test('reports requests_read as a TOTAL, matching every GET the call issued', async () => {
    const { client, t } = fillHarness();
    const r = await t.handler({ playlist_id: 'mix1', queries: ['alpha', 'beta', 'gamma'] });
    const payload = r.structuredContent as Record<string, unknown>;
    const searchCalls = client.calls.filter((c) => c.path === '/search').length;

    // The search-only figure stays available and still matches the wire, so a
    // reader can separate "searches" from "playlist setup".
    const perQuery = (payload.candidates_per_query as Array<{ pages_searched: number }>)
      .reduce((total, q) => total + q.pages_searched, 0);
    assert.equal(payload.search_requests_read, perQuery);
    assert.equal(payload.search_requests_read, searchCalls);

    // `requests_read` is the whole read phase, so it must equal EVERY GET the
    // stub saw — including the two `/playlists/mix1` metadata reads and the
    // items walk. A field named `requests_read` that quietly excluded the
    // playlist setup would be a smaller number wearing a total's name, and
    // this assertion is what catches that.
    const allGets = client.calls.filter((c) => c.method === 'GET').length;
    assert.equal(payload.requests_read, allGets, 'requests_read must be the total read cost');
    // Both operands are parenthesised. Without them the trailing `as number`
    // binds to the COMPARISON, not to the field — `>` is tighter than `as` —
    // so the line was a `boolean` cast to `number` and the assertion it was
    // meant to make was not the one being written.
    assert.ok(
      (payload.requests_read as number) > (payload.search_requests_read as number),
      'the playlist setup reads must be inside the total, not omitted from it',
    );

    // The prose carries it too, or it does not reach a text-only reader.
    assert.match(
      r.content[0]!.text,
      /Read cost: \d+ paged read request\(s\) across 3 queries\./,
    );
  });

  test('reports requests_read for expression_algebra, which walks every distinct ref', async () => {
    const client = makeFakeClient(routesForSets());
    const registered: RegisteredTool[] = [];
    registerExhaust2ExtraTools(makeServer(registered), client);
    const t = find(registered, 'playlist_expression_algebra');
    const r = await t.handler({ expression: 'aaa ∪ bbb', target_name: 'Union Result', dry_run: true });
    // The description said "N GETs" with N counting REFS; the walk costs a
    // metadata read plus an items read each, so the reported figure has to
    // come from the walk rather than from the ref count.
    const allGets = client.calls.filter((c) => c.method === 'GET').length;
    assert.equal((r.structuredContent as Record<string, unknown>).requests_read, allGets);
    assert.equal(allGets, 4, '2 refs x (1 metadata + 1 items read)');
  });
});
