import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evalSetExpression,
  parseSetExpression,
  pickRoundRobin,
  rankCoverCandidates,
  registerExhaust2ExtraTools,
} from '../src/tools/exhaust2_extra.js';

type ToolContent = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> };
type RegisteredTool = { name: string; description: string; schema: Record<string, unknown>; handler: (a: Record<string, unknown>) => Promise<ToolContent> };
type Call = { method: string; path: string; body?: unknown };

interface FakeClient {
  get: (path: string, params?: Record<string, unknown>) => Promise<unknown>;
  post: (path: string, body?: unknown) => Promise<unknown>;
  putRaw: (path: string, body: string) => Promise<unknown>;
  getAllPages: (path: string, params?: Record<string, unknown>, opts?: unknown) => Promise<unknown[]>;
  calls: Call[];
}

function makeFakeClient(routes: Record<string, unknown>): FakeClient {
  const calls: Call[] = [];
  const self: FakeClient = {
    calls,
    get: async (path) => {
      calls.push({ method: 'GET', path });
      const out = routes[path];
      if (out instanceof Error) throw out;
      return out ?? null;
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
  };
  return self;
}

function makeServer(registered: RegisteredTool[]): unknown {
  return {
    tool: (name: string, description: string, schema: Record<string, unknown>, handler: RegisteredTool['handler']) =>
      registered.push({ name, description, schema, handler }),
  };
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
  const ranked = rankCoverCandidates([
    { url: 'small', width: 64 },
    { url: 'unknown-a', width: null },
    { url: 'big', width: 640 },
    { url: 'unknown-b', width: null },
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
