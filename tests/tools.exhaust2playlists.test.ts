import { DEFAULT_TOKEN_FILE } from './helpers/hermetic.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import {
  registerExhaust2PlaylistsTools,
} from '../src/tools/exhaust2_playlists.js';

type ToolContent = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> };
type RegisteredTool = { name: string; description: string; schema: Record<string, unknown>; handler: (a: Record<string, unknown>) => Promise<ToolContent> };
type Call = { method: string; path: string; params?: Record<string, unknown>; body?: unknown };

interface FakeClient {
  // Mirrored from the real `SpotifyClient.tokenFile: string` (src/client.ts).
  // A double that omits it is not a client the account stores can key by
  // (#1385), and the registrar's parameter type says so.
  tokenFile: string;
  get: (path: string, params?: Record<string, unknown>) => Promise<unknown>;
  post: (path: string, body?: unknown) => Promise<unknown>;
  put: (path: string, body?: unknown) => Promise<unknown>;
  getAllPages: (path: string, params?: Record<string, unknown>, opts?: unknown) => Promise<unknown[]>;
  getAllPagesWithTruncation: (path: string, params?: Record<string, unknown>, opts?: unknown) => Promise<{ items: unknown[]; truncated: boolean; truncatedByCap: boolean; reportedTotal: number | null }>;
  calls: Call[];
}

/** Deterministic "now" anchor: 2026-08-27T12:00:00Z. */
const NOW = Date.parse('2026-08-27T12:00:00Z');
const daysAgo = (n: number): string => new Date(NOW - n * 86_400_000).toISOString();

function track(id: string, name: string, opts?: { artists?: Array<{ id: string; name: string }>; release?: string; ms?: number }): Record<string, unknown> {
  return {
    type: 'track',
    uri: `spotify:track:${id}`,
    id,
    name,
    duration_ms: opts?.ms ?? 200_000,
    artists: opts?.artists ?? [{ id: 'a1', name: 'Alpha' }],
    album: { id: `al-${id}`, release_date: opts?.release ?? '2024-01-01' },
  };
}

function episode(id: string, name: string, ms = 1_800_000): Record<string, unknown> {
  return { type: 'episode', uri: `spotify:episode:${id}`, id, name, duration_ms: ms };
}

function item(payload: Record<string, unknown>, addedAt = daysAgo(30)): Record<string, unknown> {
  return { added_at: addedAt, item: payload };
}

function album(id: string, name: string): Record<string, unknown> {
  return { id, name, uri: `spotify:album:${id}`, images: [] };
}

function savedTrack(payload: Record<string, unknown>, addedAt = daysAgo(30)): Record<string, unknown> {
  return { added_at: addedAt, track: payload };
}

/**
 * The registrar's `client` parameter, as the value this file actually hands it.
 *
 * `SpotifyClient` is a CLASS with private state (the 429 queue, the TTL cache,
 * the token loader), so no structural double can satisfy it — and this double
 * is deliberately structural, because the whole point is to record calls rather
 * than make them. The two therefore have to meet through a cast, so it is
 * confined to the one place they meet: the object literal is still built and
 * checked as a `FakeClient` first, which is what verifies that this double
 * implements the members the interface claims. `calls` is kept in the return
 * type so the assertions read the real log rather than a re-declared one.
 *
 * What the cast stops catching: any change to the ~65 members of
 * `SpotifyClient` that this file never invokes. That is most of the class,
 * and it is the honest cost of a recording double — the alternative was the
 * cast each of the 22 registration sites would otherwise carry, which is 22
 * chances to cast the wrong thing instead of one.
 */
type RegistrarClient = SpotifyClient & Pick<FakeClient, 'calls'>;

/**
 * Fake client mirroring the surface exhaust2_playlists touches:
 * get (metadata), getAllPages / getAllPagesWithTruncation (playlist items),
 * post/put (mutations, logged).
 *
 * `verdicts` stages what a walk REPORTED about itself, independently of the
 * rows it hands back — the capped-read case #1555 is about is a walk that
 * returns a correct prefix plus a verdict saying it is a prefix.
 */
function makeFakeClient(
  routes: Record<string, unknown>,
  verdicts: Record<string, { truncated: boolean; truncatedByCap: boolean; reportedTotal: number | null }> = {},
): RegistrarClient {
  const calls: Call[] = [];
  const self: FakeClient = {
    calls,
    // The real SpotifyClient always sets this at construction; a stub that
    // omits it is not a client the stores can key by (#1385).
    tokenFile: DEFAULT_TOKEN_FILE,
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
      return out ?? { id: 'new-pl-1', snapshot_id: 'snap-1' };
    },
    put: async (path, body) => {
      calls.push({ method: 'PUT', path, body });
      const out = routes[`PUT ${path}`];
      if (out instanceof Error) throw out;
      return out ?? { snapshot_id: 'snap-2' };
    },
    getAllPages: async function (this: FakeClient, path: string) {
      calls.push({ method: 'GET', path, params: { paged: true } });
      const out = routes[path];
      if (out instanceof Error) throw out;
      return Array.isArray(out) ? out : [];
    },
    // #1555: the verdict a capped walk returns. `verdicts[path]` lets a test
    // stage the case that matters — a walk that stopped short — separately
    // from the rows it returned, which is the whole distinction under test.
    getAllPagesWithTruncation: async (path: string) => {
      calls.push({ method: 'GET', path, params: { paged: true } });
      const out = routes[path];
      if (out instanceof Error) throw out;
      const rows = Array.isArray(out) ? out : [];
      const staged = verdicts[path];
      return {
        items: rows,
        truncated: staged?.truncated ?? false,
        truncatedByCap: staged?.truncatedByCap ?? false,
        reportedTotal: staged?.reportedTotal ?? null,
      };
    },
  };
  return self.getAllPages.bind(self) && Object.assign(self.getAllPages, { call: null }), self as unknown as RegistrarClient;
}

/**
 * The recording double for the registrar's `server` argument.
 *
 * It is cast ONCE, here, rather than at every registration site: the cast is a
 * statement about this file's harness (a `tool()` recorder, not an SDK server),
 * and repeating it at 20 call sites would make 20 chances to cast the wrong
 * thing. The recorder's own shape is still checked — the object literal has to
 * satisfy `RegisteredTool` before it is asserted to be an `McpServer`.
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

const PLAYLIST_ROUTE = {
  '/playlists/mix1': { id: 'mix1', name: 'Friday Mix' },
  '/playlists/mix1/items': [
    item(track('t1', 'One', { artists: [{ id: 'a1', name: 'Alpha' }], release: '2024-05-01' }), daysAgo(5)),
    item(track('t2', 'Two', { artists: [{ id: 'a1', name: 'Alpha' }], release: '1995-06-15' }), daysAgo(40)),
    item(track('t3', 'Three', { artists: [{ id: 'a1', name: 'Alpha' }], release: '1974-02-20' }), daysAgo(400)),
    item(track('t4', 'Four', { artists: [{ id: 'a2', name: 'Beta' }], release: '2025-11-02' }), daysAgo(400)),
    item(episode('e1', 'Pod One'), daysAgo(120)),
  ],
};

test('registers the exhaust2 playlists slice (18 tools)', () => {
  const registered: RegisteredTool[] = [];
  registerExhaust2PlaylistsTools(makeServer(registered), makeFakeClient(PLAYLIST_ROUTE));
  const names = registered.map((t) => t.name);
  assert.equal(registered.length, 18);
  for (const expected of [
    'playlist_intersect', 'playlist_add_by_search', 'playlist_trim_to_duration',
    'saved_tracks_roulette', 'playlist_slice', 'playlist_names_bulk_normalize',
    'playlist_keep_only', 'playlist_strip_episodes', 'playlist_move_to_top',
    'playlist_exclude_artists', 'playlist_staleness_score', 'playlist_artist_heat',
    'playlist_era_profile', 'playlist_overlap_matrix', 'saved_tracks_by_artist',
    'saved_library_delta', 'library_to_playlist', 'collab_mix_from_followed',
  ]) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
});

test('playlist_staleness_score grades a stale playlist and suggests refreshes', async () => {
  const originalDateNow = Date.now;
  Date.now = () => NOW;
  try {
    const registered: RegisteredTool[] = [];
    registerExhaust2PlaylistsTools(makeServer(registered), makeFakeClient(PLAYLIST_ROUTE));
    const t = find(registered, 'playlist_staleness_score');
    const r = await t.handler({ playlist_id: 'mix1', dry_run: true, response_format: 'json' });
    const p = r.structuredContent as Record<string, unknown>;
    assert.equal(p.ok, true);
    assert.equal(p.playlist, 'mix1');
    // #1555: this route states no total, so `items` is null — a length Spotify
    // did not state is not the walked row count. `items_examined` is the 5.
    assert.equal(p.items, null);
    assert.equal(p.items_examined, 5);
    assert.equal(p.items_truncated, false);
    assert.equal(p.truncated_by_cap, false);
    // Latest save is 5 days ago -> fresh grade, no refresh push.
    assert.equal(p.days_since_latest, 5);
    assert.equal(p.grade, 'fresh');
    assert.deepEqual(p.suggestions, ['no action needed — ride the momentum']);
  } finally {
    Date.now = originalDateNow;
  }
});

// #1555: the walk is capped by SPOTIFY_MCP_FETCH_ALL_CAP, so its row count is
// not the playlist's size. These assert the size comes from what Spotify
// STATES, and that a capped read discloses itself.
test('playlist_staleness_score reports the stated total, not the walked row count (#1555)', async () => {
  const originalDateNow = Date.now;
  Date.now = () => NOW;
  try {
    const registered: RegisteredTool[] = [];
    registerExhaust2PlaylistsTools(
      makeServer(registered),
      makeFakeClient(PLAYLIST_ROUTE, {
        // 900 rows exist; the walk returned the 5 the route holds and stopped.
        '/playlists/mix1/items': { truncated: true, truncatedByCap: true, reportedTotal: 900 },
      }),
    );
    const t = find(registered, 'playlist_staleness_score');
    const p = (await t.handler({ playlist_id: 'mix1', dry_run: true, response_format: 'json' }))
      .structuredContent as Record<string, unknown>;
    // The 900, not the 5 the walk managed to collect.
    assert.equal(p.items, 900);
    assert.equal(p.items_examined, 5);
    assert.equal(p.items_truncated, true);
    assert.equal(p.truncated_by_cap, true);
    // The grade was read off a bounded sample; that is disclosed, not implied.
    assert.equal(p.grade_bounded_by_walk, true);
  } finally {
    Date.now = originalDateNow;
  }
});

test('playlist_staleness_score prefers the walk reportedTotal over the metadata read (#1555)', async () => {
  const originalDateNow = Date.now;
  Date.now = () => NOW;
  try {
    const registered: RegisteredTool[] = [];
    // The two sources disagree. The walk read the /items page this tool
    // actually scored, so its number is the one that cannot be stale.
    const routes = {
      ...PLAYLIST_ROUTE,
      '/playlists/mix1': { id: 'mix1', name: 'Friday Mix', items: { total: 111 } },
    };
    registerExhaust2PlaylistsTools(
      makeServer(registered),
      makeFakeClient(routes, {
        '/playlists/mix1/items': { truncated: true, truncatedByCap: true, reportedTotal: 900 },
      }),
    );
    const t = find(registered, 'playlist_staleness_score');
    const p = (await t.handler({ playlist_id: 'mix1', dry_run: true, response_format: 'json' }))
      .structuredContent as Record<string, unknown>;
    assert.equal(p.items, 900);
  } finally {
    Date.now = originalDateNow;
  }
});

test('playlist_staleness_score falls back to items.total, then tracks.total (#1555)', async () => {
  const originalDateNow = Date.now;
  Date.now = () => NOW;
  try {
    // No walk verdict, so the metadata read decides. `items.total` is canonical.
    const canonical: RegisteredTool[] = [];
    registerExhaust2PlaylistsTools(
      makeServer(canonical),
      makeFakeClient({ ...PLAYLIST_ROUTE, '/playlists/mix1': { id: 'mix1', name: 'Friday Mix', items: { total: 742 } } }),
    );
    const p1 = (await find(canonical, 'playlist_staleness_score')
      .handler({ playlist_id: 'mix1', dry_run: true, response_format: 'json' })).structuredContent as Record<string, unknown>;
    assert.equal(p1.items, 742);

    // Only the pre-Feb-2026 spelling present: still a number, not null.
    const legacy: RegisteredTool[] = [];
    registerExhaust2PlaylistsTools(
      makeServer(legacy),
      makeFakeClient({ ...PLAYLIST_ROUTE, '/playlists/mix1': { id: 'mix1', name: 'Friday Mix', tracks: { total: 88 } } }),
    );
    const p2 = (await find(legacy, 'playlist_staleness_score')
      .handler({ playlist_id: 'mix1', dry_run: true, response_format: 'json' })).structuredContent as Record<string, unknown>;
    assert.equal(p2.items, 88);
  } finally {
    Date.now = originalDateNow;
  }
});

test('playlist_staleness_score prose says a bounded read was bounded (#1555)', async () => {
  const originalDateNow = Date.now;
  Date.now = () => NOW;
  try {
    const registered: RegisteredTool[] = [];
    registerExhaust2PlaylistsTools(
      makeServer(registered),
      makeFakeClient(PLAYLIST_ROUTE, {
        '/playlists/mix1/items': { truncated: true, truncatedByCap: true, reportedTotal: 900 },
      }),
    );
    const t = find(registered, 'playlist_staleness_score');
    const prose = text(await t.handler({ playlist_id: 'mix1', dry_run: true }));
    // The size, and the fact that the ages came from a prefix of it.
    assert.match(prose, /900 item\(s\)/);
    assert.match(prose, /first 5 examined/);
    assert.match(prose, /cap ended the read/);
  } finally {
    Date.now = originalDateNow;
  }
});

test('playlist_staleness_score prose says "unknown" rather than printing a count it did not read (#1555)', async () => {
  const originalDateNow = Date.now;
  Date.now = () => NOW;
  try {
    const registered: RegisteredTool[] = [];
    registerExhaust2PlaylistsTools(makeServer(registered), makeFakeClient(PLAYLIST_ROUTE));
    const t = find(registered, 'playlist_staleness_score');
    const prose = text(await t.handler({ playlist_id: 'mix1', dry_run: true }));
    // Not "5 item(s)" — the walk's row count wearing the playlist's name.
    assert.match(prose, /length unknown \(5 item\(s\) examined\)/);
    assert.doesNotMatch(prose, /^\s*5 item\(s\);/m);
  } finally {
    Date.now = originalDateNow;
  }
});

test('playlist_staleness_score text mode renders grade + suggestions prose', async () => {
  const originalDateNow = Date.now;
  Date.now = () => NOW;
  try {
    const registered: RegisteredTool[] = [];
    registerExhaust2PlaylistsTools(makeServer(registered), makeFakeClient(PLAYLIST_ROUTE));
    const t = find(registered, 'playlist_staleness_score');
    const r = await t.handler({ playlist_id: 'spotify:playlist:mix1', dry_run: true });
    const prose = text(r);
    assert.match(prose, /FRIDAY MIX/i);
    assert.match(prose, /FRESH/);
    assert.match(prose, /latest save 5 day\(s\) ago/);
  } finally {
    Date.now = originalDateNow;
  }
});

test('playlist_artist_heat computes share, HHI, and repeat offenders', async () => {
  const registered: RegisteredTool[] = [];
  registerExhaust2PlaylistsTools(makeServer(registered), makeFakeClient(PLAYLIST_ROUTE));
  const t = find(registered, 'playlist_artist_heat');
  const r = await t.handler({ playlist_id: 'mix1', top_n: 2, response_format: 'json' });
  const p = r.structuredContent as Record<string, unknown>;
  // 4 playable rows carry artists; the episode row does not.
  assert.equal(p.tracks, 4);
  assert.equal(p.distinct_artists, 2);
  const top = (p.top_artists as Array<{ name: string; tracks: number }>);
  assert.equal(top[0]?.name, 'Alpha');
  assert.equal(top[0]?.tracks, 3);
  // 3/4 share -> 0.75; HHI = 0.75^2 + 0.25^2 = 0.625
  assert.equal(p.top_artist_share, 0.75);
  assert.equal(p.hhi, 0.625);
  const offenders = p.repeat_offenders as Array<{ name: string; tracks: number }>;
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0]?.name, 'Alpha');
});

test('playlist_era_profile histograms decades and issues a TIME CAPSULE verdict', async () => {
  const registered: RegisteredTool[] = [];
  registerExhaust2PlaylistsTools(makeServer(registered), makeFakeClient(PLAYLIST_ROUTE));
  const t = find(registered, 'playlist_era_profile');
  const r = await t.handler({ playlist_id: 'mix1', response_format: 'json' });
  const p = r.structuredContent as Record<string, unknown>;
  assert.equal(p.ok, true);
  assert.equal(p.albums_resolved, 4);
  const hist = p.decade_histogram as Record<string, number>;
  assert.equal(hist['2020s'], 2);
  assert.equal(hist['1990s'], 1);
  assert.equal(hist['1970s'], 1);
  assert.equal(p.median_year, 2024);
  assert.equal(p.median_track_age_years, 2);
  assert.equal(p.verdict, 'CURRENT');
});

// ---------------------------------------------------------------------------
// #874 — playlist_era_profile: a market refetch must FEED the analysis
// ---------------------------------------------------------------------------

/** Two tracks whose release dates differ completely between the default-market
 *  read and the market read, so the output identifies which rows were used. */
const ERA_DEFAULT_ROWS = [
  item(track('t1', 'One', { release: '2024-05-01' })),
  item(track('t2', 'Two', { release: '2025-11-02' })),
];
const ERA_GB_ROWS = [
  item(track('t1', 'One', { release: '1995-06-15' })),
  item(track('t2', 'Two', { release: '1974-02-20' })),
];

/**
 * Client that records each paged walk with the REAL query params it was handed
 * and serves a different row set per market. The shared makeFakeClient drops
 * params, which would hide whether market ever reached the query string.
 *
 * The return type is `RegistrarClient` for the same reason `makeFakeClient`'s
 * is: a structural double cannot satisfy a class with private members, so the
 * cast is applied once here rather than at each of the three registration
 * sites below. The object literal is still checked as a `FakeClient`.
 */
function makeMarketAwareClient(
  meta: Record<string, unknown>,
  byMarket: Record<string, Array<Record<string, unknown>>>,
): RegistrarClient {
  const calls: Call[] = [];
  const self: FakeClient = {
    calls,
    // The real SpotifyClient always sets this at construction; a stub that
    // omits it is not a client the stores can key by (#1385).
    tokenFile: DEFAULT_TOKEN_FILE,
    get: async (path: string) => {
      calls.push({ method: 'GET', path });
      return meta;
    },
    post: async () => null,
    put: async () => null,
    getAllPages: async (path: string, params?: Record<string, unknown>) => {
      calls.push({ method: 'GET', path, params: { ...(params ?? {}) } });
      const market = (params?.market as string | undefined) ?? '';
      return byMarket[market] ?? [];
    },
    // #1555: the playlist walk goes through the verdict-returning method now,
    // so this fake needs it too. It reports a complete read of whatever rows
    // it serves, which is what these market tests mean to stage.
    getAllPagesWithTruncation: async (path: string, params?: Record<string, unknown>) => {
      calls.push({ method: 'GET', path, params: { ...(params ?? {}) } });
      const market = (params?.market as string | undefined) ?? '';
      const rows = byMarket[market] ?? [];
      return { items: rows, truncated: false, truncatedByCap: false, reportedTotal: rows.length };
    },
  };
  return self as unknown as RegistrarClient;
}

test('playlist_era_profile computes the profile from the market-refetched rows (#874)', async () => {
  const client = makeMarketAwareClient(
    { id: 'mx', name: 'Market Mix' },
    { '': ERA_DEFAULT_ROWS, GB: ERA_GB_ROWS },
  );
  const registered: RegisteredTool[] = [];
  registerExhaust2PlaylistsTools(makeServer(registered), client);
  const t = find(registered, 'playlist_era_profile');
  const r = await t.handler({ playlist_id: 'mx', market: 'GB', response_format: 'json' });
  const p = r.structuredContent as Record<string, unknown>;

  // The second walk is the disclosed refetch and it carries the market.
  const walks = client.calls.filter((c) => c.path === '/playlists/mx/items');
  assert.equal(walks.length, 2, 'expected the disclosed second paged walk');
  assert.equal(walks[0]?.params?.market, undefined, 'first walk must stay market-less');
  assert.equal(walks[1]?.params?.market, 'GB', 'refetch must forward the market');

  // The profile follows the REFETCHED rows (1990s/1970s), not the first read
  // (2020s) — proof the discarded-rows bug is gone rather than a mock echo.
  assert.equal(p.albums_resolved, 2);
  assert.deepEqual(p.decade_histogram, { '1970s': 1, '1990s': 1 });
  assert.equal(p.median_year, 1995);
  assert.equal(p.verdict, 'TIME CAPSULE');
});

test('playlist_era_profile without market does one walk and uses those rows (#874)', async () => {
  const client = makeMarketAwareClient({ id: 'mx', name: 'Market Mix' }, { '': ERA_DEFAULT_ROWS });
  const registered: RegisteredTool[] = [];
  registerExhaust2PlaylistsTools(makeServer(registered), client);
  const t = find(registered, 'playlist_era_profile');
  const r = await t.handler({ playlist_id: 'mx', response_format: 'json' });
  const p = r.structuredContent as Record<string, unknown>;

  const walks = client.calls.filter((c) => c.path === '/playlists/mx/items');
  assert.equal(walks.length, 1, 'no market means no refetch walk');
  assert.equal(walks[0]?.params?.market, undefined);
  assert.deepEqual(p.decade_histogram, { '2020s': 2 });
  assert.equal(p.median_year, 2025);
});

test('playlist_era_profile mentions the refetch only when one was performed (#874)', async () => {
  const withMarket = makeMarketAwareClient({ id: 'mx', name: 'Market Mix' }, { '': ERA_DEFAULT_ROWS, GB: ERA_GB_ROWS });
  const registeredWith: RegisteredTool[] = [];
  registerExhaust2PlaylistsTools(makeServer(registeredWith), withMarket);
  const rWith = await find(registeredWith, 'playlist_era_profile').handler({ playlist_id: 'mx', market: 'GB' });
  assert.match(text(rWith), /refetched with the given market/);
  assert.match(text(rWith), /1970s: 1/, 'prose histogram must be the refetched rows');

  const without = makeMarketAwareClient({ id: 'mx', name: 'Market Mix' }, { '': ERA_DEFAULT_ROWS });
  const registeredWithout: RegisteredTool[] = [];
  registerExhaust2PlaylistsTools(makeServer(registeredWithout), without);
  const rWithout = await find(registeredWithout, 'playlist_era_profile').handler({ playlist_id: 'mx' });
  assert.doesNotMatch(text(rWithout), /refetched with the given market/);
  assert.match(text(rWithout), /2020s: 2/);
});

test('playlist_strip_episodes default strips episodes (dry run: plan only, no PUT)', async () => {
  const client = makeFakeClient(PLAYLIST_ROUTE);
  const registered: RegisteredTool[] = [];
  registerExhaust2PlaylistsTools(makeServer(registered), client);
  const t = find(registered, 'playlist_strip_episodes');
  const r = await t.handler({ playlist_id: 'mix1' }); // dry_run defaults true
  const p = r.structuredContent as Record<string, unknown>;
  assert.equal(p.dry_run, true);
  assert.equal(p.stripped, 1);
  assert.equal(p.remaining, 4);
  assert.match(text(r), /\[dry run\]/);
  // No mutation happened.
  assert.equal(client.calls.filter((c) => c.method === 'PUT' || c.method === 'POST').length, 0);
});

test('playlist_strip_episodes commits when dry_run=false (atomic replace)', async () => {
  const client = makeFakeClient(PLAYLIST_ROUTE);
  const registered: RegisteredTool[] = [];
  registerExhaust2PlaylistsTools(makeServer(registered), client);
  const t = find(registered, 'playlist_strip_episodes');
  const r = await t.handler({ playlist_id: 'mix1', dry_run: false, response_format: 'json' });
  const p = r.structuredContent as Record<string, unknown>;
  assert.equal(p.dry_run, undefined);
  assert.equal(p.stripped, 1);
  assert.equal(p.remaining, 4);
  const puts = client.calls.filter((c) => c.method === 'PUT');
  assert.equal(puts.length, 1);
  const body = puts[0]?.body as { uris?: string[] };
  assert.equal(body.uris?.length, 4);
  assert.ok(!body.uris?.some((u) => u.startsWith('spotify:episode:')));
});

test('playlist_strip_episodes strip=tracks keeps episodes and removes tracks', async () => {
  const client = makeFakeClient(PLAYLIST_ROUTE);
  const registered: RegisteredTool[] = [];
  registerExhaust2PlaylistsTools(makeServer(registered), client);
  const t = find(registered, 'playlist_strip_episodes');
  const r = await t.handler({ playlist_id: 'mix1', strip: 'tracks', dry_run: false, response_format: 'json' });
  const p = r.structuredContent as Record<string, unknown>;
  assert.equal(p.stripped, 4);
  assert.equal(p.remaining, 1);
  const puts = client.calls.filter((c) => c.method === 'PUT');
  const body = puts[0]?.body as { uris?: string[] };
  assert.deepEqual(body.uris, ['spotify:episode:e1']);
});

test('saved_tracks_roulette dry run deals a plan without creating anything', async () => {
  const client = makeFakeClient({
    '/me/tracks': [
      savedTrack(track('t1', 'One'), daysAgo(1)),
      savedTrack(track('t2', 'Two'), daysAgo(2)),
      savedTrack(track('t3', 'Three'), daysAgo(3)),
      savedTrack(track('t4', 'Four'), daysAgo(4)),
      savedTrack(track('t5', 'Five'), daysAgo(5)),
      savedTrack(track('t6', 'Six'), daysAgo(6)),
      savedTrack(track('t7', 'Seven'), daysAgo(7)),
      savedTrack(track('t8', 'Eight'), daysAgo(8)),
      savedTrack(track('t9', 'Nine'), daysAgo(9)),
      savedTrack(track('t10', 'Ten'), daysAgo(10)),
    ],
  });
  const registered: RegisteredTool[] = [];
  registerExhaust2PlaylistsTools(makeServer(registered), client);
  const t = find(registered, 'saved_tracks_roulette');
  const r = await t.handler({ from: 'tracks', count: 10, dedupe: true, seed: 7, dry_run: true });
  const p = r.structuredContent as Record<string, unknown>;
  assert.equal(p.dry_run, true);
  assert.match(text(r), /\[dry run\]/);
  assert.equal(client.calls.filter((c) => c.method === 'POST' || c.method === 'PUT').length, 0);
  assert.equal(client.calls.some((call) => call.method === 'POST' && call.path === '/me/playlists'), false);
});

test('library_to_playlist dry run plans the export without POSTing', async () => {
  const client = makeFakeClient({
    '/me/tracks': [
      savedTrack(track('t1', 'One'), daysAgo(1)),
      savedTrack(track('t2', 'Two'), daysAgo(2)),
      savedTrack(track('t3', 'Three'), daysAgo(3)),
    ],
  });
  const registered: RegisteredTool[] = [];
  registerExhaust2PlaylistsTools(makeServer(registered), client);
  const t = find(registered, 'library_to_playlist');
  const r = await t.handler({ from: 'tracks', name: 'Liked Export', dry_run: true });
  const p = r.structuredContent as Record<string, unknown>;
  assert.equal(p.dry_run, true);
  assert.match(text(r), /Liked Export/);
  assert.equal(client.calls.filter((c) => c.method === 'POST').length, 0);
  assert.equal(client.calls.some((call) => call.method === 'POST' && call.path === '/me/playlists'), false);
});

test('library_to_playlist expands saved albums to playable track URIs before adding', async () => {
  const client = makeFakeClient({
    '/me/albums': [{ added_at: daysAgo(1), album: album('a1', 'Shelf Album') }],
    '/albums/a1/tracks': [
      { uri: 'spotify:track:t1' },
      { uri: null, is_playable: false, restrictions: { reason: 'market' } },
      { uri: 'spotify:track:market-blocked', is_playable: false, restrictions: { reason: 'market' } },
      { uri: 'spotify:episode:e1' },
      { uri: 'spotify:track:t2' },
    ],
  });
  const registered: RegisteredTool[] = [];
  registerExhaust2PlaylistsTools(makeServer(registered), client);
  const result = await find(registered, 'library_to_playlist').handler({
    from: 'albums',
    name: 'Album Export',
    limit: 2,
    dry_run: false,
    response_format: 'json',
  });
  const payload = result.structuredContent as Record<string, unknown>;
  assert.deepEqual(payload.resulting_uris, ['spotify:track:t1', 'spotify:track:t2']);
  assert.equal(payload.albums_expanded, 1);
  const add = client.calls.find((call) => call.method === 'POST' && call.path === '/playlists/new-pl-1/items');
  assert.deepEqual((add?.body as { uris: string[] }).uris, ['spotify:track:t1', 'spotify:track:t2']);
  assert.ok(!(add?.body as { uris: string[] }).uris.some((uri) => uri.startsWith('spotify:album:')));
});

test('saved_tracks_roulette reads the albums shelf and writes only expanded tracks', async () => {
  const client = makeFakeClient({
    '/me/albums': [{ added_at: daysAgo(1), album: album('a1', 'Shelf Album') }],
    '/albums/a1/tracks': [
      { uri: 'spotify:track:t1' },
      { uri: null, is_playable: false },
      { uri: 'spotify:track:t2' },
    ],
  });
  const registered: RegisteredTool[] = [];
  registerExhaust2PlaylistsTools(makeServer(registered), client);
  const result = await find(registered, 'saved_tracks_roulette').handler({
    from: 'albums',
    count: 10,
    dry_run: false,
    response_format: 'json',
  });
  const payload = result.structuredContent as Record<string, unknown>;
  assert.equal(payload.albums_expanded, 1);
  assert.equal(client.calls.some((call) => call.path === '/me/episodes'), false);
  const add = client.calls.find((call) => call.method === 'POST' && call.path === '/playlists/new-pl-1/items');
  assert.deepEqual((add?.body as { uris: string[] }).uris.slice().sort(), ['spotify:track:t1', 'spotify:track:t2']);
});

for (const toolName of ['library_to_playlist', 'saved_tracks_roulette']) {
  test(`${toolName} rejects an empty saved album before playlist creation`, async () => {
    const client = makeFakeClient({
      '/me/albums': [{ added_at: daysAgo(1), album: album('empty', 'Empty Album') }],
      '/albums/empty/tracks': [],
    });
    const registered: RegisteredTool[] = [];
    registerExhaust2PlaylistsTools(makeServer(registered), client);
    await assert.rejects(
      () => find(registered, toolName).handler({
        from: 'albums',
        count: 10,
        dry_run: false,
        response_format: 'json',
      }),
      /empty or fully region-blocked.*no playlist was created/i,
    );
    assert.equal(client.calls.some((call) => call.method === 'POST' && call.path === '/me/playlists'), false);
  });

  test(`${toolName} rejects a fully region-blocked album before playlist creation`, async () => {
    const client = makeFakeClient({
      '/me/albums': [{ added_at: daysAgo(1), album: album('blocked', 'Blocked Album') }],
      '/albums/blocked/tracks': [
        { uri: null, is_playable: false, restrictions: { reason: 'market' } },
        { uri: null, is_playable: false, restrictions: { reason: 'product' } },
      ],
    });
    const registered: RegisteredTool[] = [];
    registerExhaust2PlaylistsTools(makeServer(registered), client);
    await assert.rejects(
      () => find(registered, toolName).handler({
        from: 'albums',
        count: 10,
        dry_run: false,
        response_format: 'json',
      }),
      /empty or fully region-blocked.*no playlist was created/i,
    );
    assert.equal(client.calls.some((call) => call.method === 'POST' && call.path === '/me/playlists'), false);
  });

  test(`${toolName} aborts without creating when album expansion fails`, async () => {
    const failure = Object.assign(new Error('album unavailable'), { status: 403 });
    const client = makeFakeClient({
      '/me/albums': [{ added_at: daysAgo(1), album: album('blocked', 'Blocked Album') }],
      '/albums/blocked/tracks': failure,
    });
    const registered: RegisteredTool[] = [];
    registerExhaust2PlaylistsTools(makeServer(registered), client);
    await assert.rejects(
      () => find(registered, toolName).handler({
        from: 'albums',
        count: 10,
        dry_run: false,
        response_format: 'json',
      }),
      /could not expand saved album.*no playlist was created/i,
    );
    assert.equal(client.calls.some((call) => call.method === 'POST' && call.path === '/me/playlists'), false);
  });
}

test('missing playlist fails fast with a clear error', async () => {
  const registered: RegisteredTool[] = [];
  registerExhaust2PlaylistsTools(makeServer(registered), makeFakeClient({}));
  const t = find(registered, 'playlist_staleness_score');
  await assert.rejects(() => t.handler({ playlist_id: 'nope' }), /not found/);
});

// ---------------------------------------------------------------------------
// #868 — playlist_names_bulk_normalize: real ownership, resume, partial failure
// ---------------------------------------------------------------------------

/** `/me/playlists` row: id, name, and the `owner` id the tool must compare. */
function pl(id: string, name: string, ownerId: string): Record<string, unknown> {
  return {
    id,
    name,
    uri: `spotify:playlist:${id}`,
    description: null,
    owner: { display_name: ownerId, id: ownerId },
    items: { total: 0 },
  };
}

const ME_ID = 'me-1';
const OTHER_ID = 'someone-else';

test('playlist_names_bulk_normalize skips followed playlists under the owned default (#868)', async () => {
  // Two owned + two followed playlists all carry `owner.id`, but only the
  // owned ones should be renamed when apply_to defaults to 'owned'.
  const client = makeFakeClient({
    '/me': { id: ME_ID },
    '/me/playlists': [
      pl('own-a', 'Mine (Official Copy)', ME_ID),
      pl('own-b', 'Mine Two', ME_ID),
      pl('fol-a', 'Friends Mix (Official Copy)', OTHER_ID),
      pl('fol-b', 'Friends Two', OTHER_ID),
    ],
  });
  const registered: RegisteredTool[] = [];
  registerExhaust2PlaylistsTools(makeServer(registered), client);
  const r = await find(registered, 'playlist_names_bulk_normalize').handler({
    op: 'strip_noise',
    dry_run: false,
    response_format: 'json',
  });
  const p = r.structuredContent as Record<string, unknown>;
  const renames = p.renames as Array<{ id: string; from: string; to: string }>;
  const renamedIds = renames.map((x) => x.id).sort();
  // Only the owned playlist with noise gets renamed; the followed rows and
  // the already-clean owned row are skipped.
  assert.deepEqual(renamedIds, ['own-a']);
  assert.equal(p.renamed, 1);
  assert.equal(p.failed, 0);
  // The followed row was NOT touched.
  const puts = client.calls.filter((c) => c.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.equal(puts[0]?.path, '/playlists/own-a');
});

test('playlist_names_bulk_normalize renames every followed playlist when apply_to=all (#868)', async () => {
  const client = makeFakeClient({
    '/me': { id: ME_ID },
    '/me/playlists': [
      pl('own-a', 'Mine (Official Copy)', ME_ID),
      pl('fol-a', 'Friends Mix (Official Copy)', OTHER_ID),
    ],
  });
  const registered: RegisteredTool[] = [];
  registerExhaust2PlaylistsTools(makeServer(registered), client);
  const r = await find(registered, 'playlist_names_bulk_normalize').handler({
    op: 'strip_noise',
    apply_to: 'all',
    dry_run: false,
    response_format: 'json',
  });
  const p = r.structuredContent as Record<string, unknown>;
  const renamedIds = (p.renames as Array<{ id: string }>).map((x) => x.id).sort();
  assert.deepEqual(renamedIds, ['fol-a', 'own-a']);
  assert.equal(p.renamed, 2);
});

test('playlist_names_bulk_normalize resumes past already-landed renames (#868)', async () => {
  // Simulates a re-run after a previous run already renamed a playlist to
  // its target: the playlist is now back in the listing with the new name,
  // and the same deterministic computation produces the same target, so the
  // tool should NOT issue a redundant PUT.
  const client = makeFakeClient({
    '/me': { id: ME_ID },
    '/me/playlists': [
      pl('own-a', 'Mine', ME_ID),          // already at the target
      pl('own-b', 'Mine Two (Copy)', ME_ID), // still has noise
    ],
  });
  const registered: RegisteredTool[] = [];
  registerExhaust2PlaylistsTools(makeServer(registered), client);
  const r = await find(registered, 'playlist_names_bulk_normalize').handler({
    op: 'strip_noise',
    dry_run: false,
    response_format: 'json',
  });
  const p = r.structuredContent as Record<string, unknown>;
  const renamedIds = (p.renames as Array<{ id: string }>).map((x) => x.id).sort();
  assert.deepEqual(renamedIds, ['own-b']);
  assert.equal(p.renamed, 1);
  const puts = client.calls.filter((c) => c.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.equal(puts[0]?.path, '/playlists/own-b');
});

test('playlist_names_bulk_normalize continues past a mid-run 403 and reports it (#868)', async () => {
  const client = makeFakeClient({
    '/me': { id: ME_ID },
    '/me/playlists': [
      pl('own-a', 'A (Copy)', ME_ID),
      pl('own-b', 'B (Copy)', ME_ID),
      pl('own-c', 'C (Copy)', ME_ID),
    ],
    'PUT /playlists/own-b': Object.assign(new Error('forbidden'), { status: 403 }),
  });
  const registered: RegisteredTool[] = [];
  registerExhaust2PlaylistsTools(makeServer(registered), client);
  const r = await find(registered, 'playlist_names_bulk_normalize').handler({
    op: 'strip_noise',
    dry_run: false,
    response_format: 'json',
  });
  const p = r.structuredContent as Record<string, unknown>;
  assert.equal(p.renamed, 2);
  assert.equal(p.failed, 1);
  assert.equal(p.ok, false);
  const failures = p.failures as Array<{ id: string; status: number; from: string; to: string }>;
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.id, 'own-b');
  assert.equal(failures[0]?.status, 403);
  // Every playlist is still attempted; only own-b fails.
  const puts = client.calls.filter((c) => c.method === 'PUT').map((c) => c.path).sort();
  assert.deepEqual(puts, ['/playlists/own-a', '/playlists/own-b', '/playlists/own-c']);
});

test('playlist_names_bulk_normalize dry-run still applies the ownership filter (#868)', async () => {
  const client = makeFakeClient({
    '/me': { id: ME_ID },
    '/me/playlists': [
      pl('own-a', 'Mine (Copy)', ME_ID),
      pl('fol-a', 'Friends (Copy)', OTHER_ID),
    ],
  });
  const registered: RegisteredTool[] = [];
  registerExhaust2PlaylistsTools(makeServer(registered), client);
  const r = await find(registered, 'playlist_names_bulk_normalize').handler({
    op: 'strip_noise',
    dry_run: true,
    response_format: 'json',
  });
  const prose = text(r);
  // Owned one appears, followed one does not.
  assert.match(prose, /"Mine \(Copy\)" → "Mine"/);
  assert.doesNotMatch(prose, /Friends/);
  // Dry-run must not issue PUTs.
  assert.equal(client.calls.some((c) => c.method === 'PUT'), false);
});
