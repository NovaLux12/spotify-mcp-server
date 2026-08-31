import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerExhaust2PlaylistsTools,
} from '../src/tools/exhaust2_playlists.js';

type ToolContent = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> };
type RegisteredTool = { name: string; description: string; schema: Record<string, unknown>; handler: (a: Record<string, unknown>) => Promise<ToolContent> };
type Call = { method: string; path: string; params?: Record<string, unknown>; body?: unknown };

interface FakeClient {
  get: (path: string, params?: Record<string, unknown>) => Promise<unknown>;
  post: (path: string, body?: unknown) => Promise<unknown>;
  put: (path: string, body?: unknown) => Promise<unknown>;
  getAllPages: (path: string, params?: Record<string, unknown>, opts?: unknown) => Promise<unknown[]>;
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

/**
 * Fake client mirroring the surface exhaust2_playlists touches:
 * get (metadata), getAllPages (playlist items), post/put (mutations, logged).
 */
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
  };
  return self.getAllPages.bind(self) && Object.assign(self.getAllPages, { call: null }), self;
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
    assert.equal(p.items, 5);
    // Latest save is 5 days ago -> fresh grade, no refresh push.
    assert.equal(p.days_since_latest, 5);
    assert.equal(p.grade, 'fresh');
    assert.deepEqual(p.suggestions, ['no action needed — ride the momentum']);
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
      item(track('t1', 'One'), daysAgo(1)),
      item(track('t2', 'Two'), daysAgo(2)),
      item(track('t3', 'Three'), daysAgo(3)),
      item(track('t4', 'Four'), daysAgo(4)),
      item(track('t5', 'Five'), daysAgo(5)),
      item(track('t6', 'Six'), daysAgo(6)),
      item(track('t7', 'Seven'), daysAgo(7)),
      item(track('t8', 'Eight'), daysAgo(8)),
      item(track('t9', 'Nine'), daysAgo(9)),
      item(track('t10', 'Ten'), daysAgo(10)),
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
});

test('library_to_playlist dry run plans the export without POSTing', async () => {
  const client = makeFakeClient({
    '/me/tracks': [
      item(track('t1', 'One'), daysAgo(1)),
      item(track('t2', 'Two'), daysAgo(2)),
      item(track('t3', 'Three'), daysAgo(3)),
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
});

test('missing playlist fails fast with a clear error', async () => {
  const registered: RegisteredTool[] = [];
  registerExhaust2PlaylistsTools(makeServer(registered), makeFakeClient({}));
  const t = find(registered, 'playlist_staleness_score');
  await assert.rejects(() => t.handler({ playlist_id: 'nope' }), /not found/);
});
