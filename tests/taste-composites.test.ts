import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerTasteCompositeTools,
  __setTasteCompositeFetchImpl,
  __resetTasteCompositeFetchImpl,
} from '../src/tools/taste_composites.js';
import { SpotifyApiError } from '../src/client.js';

// ---------------------------------------------------------------- fixtures

type ToolContent = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type RegisteredTool = {
  name: string;
  description: string;
  schema: Record<string, { safeParse(value: unknown): { success: boolean; data?: unknown } }>;
  handler: (args: Record<string, unknown>) => Promise<ToolContent>;
};

/** One recorded Spotify wire call — the assertions read these, not prose. */
type WireCall = {
  method: 'get' | 'post' | 'put' | 'delete';
  path: string;
  params?: Record<string, string>;
  body?: unknown;
};

/** Fake SpotifyClient that records every wire call. */
type RecordingClient = {
  calls: WireCall[];
  /** Substring of the /search q → URIs returned for it. Anything unmatched returns no items. */
  searchHits: Record<string, string[]>;
  /** Substring of the /search q → error thrown instead of an answer. `'*'` throws for every search. */
  searchThrows: Record<string, Error>;
  playlistId: string | null;
  get(path: string, params?: Record<string, string>): Promise<unknown>;
  post(path: string, body?: unknown): Promise<unknown>;
  put(path: string, body?: unknown): Promise<unknown>;
  delete(path: string, body?: unknown): Promise<unknown>;
};

function makeClient(): RecordingClient {
  const client: RecordingClient = {
    calls: [],
    searchHits: {},
    searchThrows: {},
    playlistId: 'PL-1',
    async get(path, params) {
      client.calls.push({ method: 'get', path, params });
      if (path !== '/search') return null;
      const q = params?.q ?? '';
      const boom = Object.entries(client.searchThrows).find(([needle]) => needle === '*' || q.includes(needle));
      if (boom) throw boom[1];
      const hit = Object.entries(client.searchHits).find(([needle]) => q.includes(needle));
      return { tracks: { items: (hit?.[1] ?? []).map((uri) => ({ uri, id: uri.split(':').pop() })) } };
    },
    async post(path, body) {
      client.calls.push({ method: 'post', path, body });
      if (path === '/me/playlists') {
        return client.playlistId ? { id: client.playlistId, external_urls: { spotify: `https://open.spotify.com/playlist/${client.playlistId}` } } : {};
      }
      return { snapshot_id: 'snap-post' };
    },
    async put(path, body) {
      client.calls.push({ method: 'put', path, body });
      return { snapshot_id: 'snap-put' };
    },
    async delete(path, body) {
      client.calls.push({ method: 'delete', path, body });
      return null;
    },
  };
  return client;
}

function streamRow(trackId: string, trackName: string, artist: string, iso: string) {
  return {
    track: { id: trackId, name: trackName, artists: [{ name: artist }] },
    playedAt: iso,
  };
}

const EXPECTED = [
  'taste_to_playlist',
  'taste_daily_brief',
  'taste_era_playlist',
  'taste_forgotten_bangers',
  'taste_obsession_ladder',
  'taste_diamond_rotation',
  'taste_weekly_recap',
  'taste_genre_bridge',
  'taste_novelty_loyalty',
  'taste_listening_clock',
  'taste_revival_queue',
];

function installFixtures() {
  __setTasteCompositeFetchImpl(async (url: string) => {
    if (url.includes('/top/artists')) {
      return {
        items: [
          { id: 'a1', name: 'Core Band', streams: 120 },
          { id: 'a2', name: 'Second Act', streams: 60 },
          { id: 'a3', name: 'Third Wheel', streams: 30 },
          { id: 'a4', name: 'Dormant Star', streams: 25 },
          { id: 'a5', name: 'Old Flame', streams: 20 },
          { id: 'a6', name: 'Deep Diver', streams: 15 },
          { id: 'a7', name: 'Side Quest', streams: 12 },
          { id: 'a8', name: 'Faint Echo', streams: 10 },
          { id: 'a9', name: 'Riser', streams: 8 },
          { id: 'a10', name: 'Sleeper', streams: 6 },
          { id: 'a11', name: 'Ghost Note', streams: 5 },
          { id: 'a12', name: 'Late Bloomer', streams: 4 },
        ],
      };
    }
    if (url.includes('/top/genres')) {
      return {
        items: [
          { name: 'indie rock', count: 200 },
          { name: 'shoegaze', count: 120 },
          { name: 'ambient', count: 80 },
          { name: 'jazz', count: 20 },
          { name: 'krautrock', count: 10 },
        ],
      };
    }
    if (url.includes('/top/tracks')) {
      const items = [];
      const core: Array<[string, string, string, number]> = [
        ['t1', 'Hit Single', 'Core Band', 90],
        ['t2', 'Deep Cut', 'Second Act', 40],
        ['t3', 'Lost Classic', 'Dormant Star', 35],
      ];
      for (const [id, name, artist, streams] of core) {
        items.push({
          id,
          name,
          streams,
          track: { id, name, artists: [{ name: artist }] },
          externalIds: { spotify: [`spotify:track:${id}`] },
        });
      }
      // Mid-tier filler ranks 4..60 for diamond mining.
      for (let i = 4; i <= 60; i++) {
        items.push({
          id: `tm${i}`,
          name: `Mid Cut ${i}`,
          streams: 60 - i,
          track: { id: `tm${i}`, name: `Mid Cut ${i}`, artists: [{ name: 'Third Wheel' }] },
        });
      }
      return { items };
    }
    if (url.includes('/streams')) {
      return {
        items: [
          streamRow('t1', 'Hit Single', 'Core Band', '2026-09-06T08:00:00Z'),
          streamRow('t1', 'Hit Single', 'Core Band', '2026-09-06T08:04:00Z'),
          streamRow('t9', 'New Thing', 'Fresh Face', '2026-09-06T20:00:00Z'),
          streamRow('t2', 'Deep Cut', 'Second Act', '2026-09-05T09:00:00Z'),
          streamRow('t1', 'Hit Single', 'Core Band', '2026-08-10T10:00:00Z'),
          streamRow('t2', 'Deep Cut', 'Second Act', '2026-07-05T10:00:00Z'),
          streamRow('t5', 'Spring Song', 'Core Band', '2026-03-05T10:00:00Z'),
        ],
      };
    }
    throw new Error(`unexpected stats.fm path: ${url}`);
  });
}

const writes = (client: RecordingClient): WireCall[] =>
  client.calls.filter((c) => c.method !== 'get');
function makeHarness(client: RecordingClient = makeClient()) {
  const registered: RegisteredTool[] = [];
  const server = {
    // The SDK accepts both tool(name, description, schema, cb) and
    // tool(name, description, schema, annotations, cb); the fake must too.
    tool: (
      name: string,
      description: string,
      schema: RegisteredTool['schema'],
      annotationsOrHandler: unknown,
      maybeHandler?: unknown,
    ) => {
      const handler = (typeof maybeHandler === 'function' ? maybeHandler : annotationsOrHandler) as RegisteredTool['handler'];
      registered.push({ name, description, schema, handler });
    },
  };
  registerTasteCompositeTools(
    server as unknown as Parameters<typeof registerTasteCompositeTools>[0],
    client as unknown as Parameters<typeof registerTasteCompositeTools>[1],
  );
  return { registered, client };
}

function findTool(registered: RegisteredTool[], name: string): RegisteredTool {
  const tool = registered.find((t) => t.name === name);
  assert.ok(tool, `expected tool ${name} to be registered`);
  return tool;
}

async function invoke(tool: RegisteredTool, args: Record<string, unknown> = {}) {
  return (tool.handler as (a: Record<string, unknown>) => Promise<ToolContent>)(args);
}

function text(result: ToolContent): string {
  return result.content.map((c) => c.text).join('\n');
}

test.beforeEach(() => {
  installFixtures();
});


const READONLY_ENV = 'SPOTIFY_MCP_READONLY';
const priorReadonly = process.env[READONLY_ENV];

test.afterEach(() => {
  __resetTasteCompositeFetchImpl();
  if (priorReadonly === undefined) delete process.env[READONLY_ENV];
  else process.env[READONLY_ENV] = priorReadonly;
});

// --------------------------------------------------------------- registry

test('registers all 11 composite tools', () => {
  const { registered } = makeHarness();
  for (const name of EXPECTED) {
    assert.ok(registered.some((t) => t.name === name), `missing ${name}`);
  }
  assert.equal(registered.length, 11);
});

// ------------------------------------------------------- 1. taste_to_playlist

test('taste_to_playlist emits a DRY RUN list with fallback guidance', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'taste_to_playlist'), {
    statsfm_user: 'demo',
    track_count: 6,
  });
  const out = text(result);
  assert.match(out, /DRY RUN/);
  assert.match(out, /Hit Single/);
  assert.match(out, /externalIds\.spotify/);
  const sc = result.structuredContent as { picks: unknown[]; dryRun: boolean };
  assert.equal(sc.dryRun, true);
  assert.ok(sc.picks.length > 0);
});

test('taste_to_playlist dry_run=true issues no Spotify write and previews the plan', async () => {
  const { registered, client } = makeHarness();
  const result = await invoke(findTool(registered, 'taste_to_playlist'), {
    statsfm_user: 'demo',
    seed: 'core',
    track_count: 3,
    dry_run: true,
  });
  assert.deepEqual(client.calls, [], 'a preview must not touch the Spotify client');
  const sc = result.structuredContent as { dryRun: boolean; picks: unknown[]; playlist?: unknown };
  assert.equal(sc.dryRun, true);
  assert.equal(sc.playlist, undefined, 'a preview must not report a created playlist');
  assert.equal(sc.picks.length, 3);
  assert.match(text(result), /no Spotify writes performed/);
});

test('taste_to_playlist defaults to a preview when dry_run is omitted', async () => {
  const { registered, client } = makeHarness();
  const result = await invoke(findTool(registered, 'taste_to_playlist'), {
    statsfm_user: 'demo',
    seed: 'core',
    track_count: 3,
  });
  assert.deepEqual(client.calls, [], 'the omitted default must not touch the Spotify client');
  const sc = result.structuredContent as { dryRun: boolean; playlist?: unknown };
  assert.equal(sc.dryRun, true);
  assert.equal(sc.playlist, undefined);
});

test('taste_to_playlist declares the dry_run default on the schema', () => {
  const { registered } = makeHarness();
  const parsed = findTool(registered, 'taste_to_playlist').schema.dry_run.safeParse(undefined);
  assert.equal(parsed.success, true);
  assert.equal(parsed.data, true, 'dry_run must default to true at the schema level');
});

test('taste_to_playlist dry_run=false creates the playlist and adds the resolved tracks', async () => {
  const { registered, client } = makeHarness();
  const result = await invoke(findTool(registered, 'taste_to_playlist'), {
    statsfm_user: 'demo',
    seed: 'core',
    track_count: 3,
    dry_run: false,
    playlist_name: 'Demo taste',
  });
  assert.deepEqual(
    writes(client).map((c) => `${c.method} ${c.path}`),
    ['post /me/playlists', 'put /playlists/PL-1/items'],
  );
  const create = writes(client)[0];
  assert.deepEqual(create.body, {
    name: 'Demo taste',
    public: false,
    description: 'stats.fm taste blend for demo (seed core)',
  });
  assert.deepEqual(writes(client)[1].body, {
    uris: ['spotify:track:t1', 'spotify:track:t2', 'spotify:track:t3'],
  });
  const sc = result.structuredContent as {
    dryRun: boolean;
    unresolved: string[];
    playlist: { id: string; added: number; requested: number; url: string };
  };
  assert.equal(sc.dryRun, false);
  assert.equal(sc.playlist.id, 'PL-1');
  assert.equal(sc.playlist.added, 3);
  assert.equal(sc.playlist.requested, 3);
  assert.equal(sc.playlist.url, 'https://open.spotify.com/playlist/PL-1');
  assert.deepEqual(sc.unresolved, []);
  assert.match(text(result), /COMMITTED/);
});

test('taste_to_playlist dry_run=false falls back to search and reports every unresolved pick', async () => {
  const client = makeClient();
  // 'recent' picks come from the streams feed, which carries no Spotify ids.
  client.searchHits = { 'New Thing': ['spotify:track:SEARCH1'] };
  const { registered } = makeHarness(client);
  const result = await invoke(findTool(registered, 'taste_to_playlist'), {
    statsfm_user: 'demo',
    seed: 'recent',
    track_count: 4,
    dry_run: false,
  });
  const searches = client.calls.filter((c) => c.method === 'get' && c.path === '/search');
  assert.equal(searches.length, 4, 'every id-less pick must be looked up');
  const added = writes(client).find((c) => c.path.endsWith('/items'))?.body as { uris: string[] };
  assert.deepEqual(added.uris, ['spotify:track:SEARCH1'], 'only the resolved pick may be added');
  const sc = result.structuredContent as {
    unresolved: string[];
    playlist: { added: number; requested: number };
  };
  assert.deepEqual(sc.unresolved, ['Core Band — Spring Song', 'Second Act — Deep Cut', 'Core Band — Hit Single']);
  assert.equal(sc.playlist.added, 1);
  assert.equal(sc.playlist.requested, 4);
  assert.match(text(result), /unresolved\[\]/);
});

test('taste_to_playlist dry_run=false refuses to write in read-only mode', async () => {
  process.env[READONLY_ENV] = '1';
  const { registered, client } = makeHarness();
  const result = await invoke(findTool(registered, 'taste_to_playlist'), {
    statsfm_user: 'demo',
    seed: 'core',
    track_count: 3,
    dry_run: false,
  });
  assert.deepEqual(client.calls, [], 'read-only mode must block the write before any call');
  assert.match(text(result), /Refused to write/);
});

test('taste_to_playlist dry_run=false creates nothing when no pick resolves', async () => {
  const client = makeClient();
  const { registered } = makeHarness(client);
  const result = await invoke(findTool(registered, 'taste_to_playlist'), {
    statsfm_user: 'demo',
    seed: 'recent',
    track_count: 2,
    dry_run: false,
  });
  assert.deepEqual(writes(client), [], 'an empty playlist must never be created');
  const sc = result.structuredContent as { ok: boolean; blocked: string; unresolved: string[] };
  assert.equal(sc.ok, false);
  assert.equal(sc.blocked, 'no_resolvable_tracks');
  assert.equal(sc.unresolved.length, 2);
  assert.match(text(result), /Nothing written/);
});

test('taste_to_playlist dry_run=false blocks with search_failed when every /search errors', async () => {
  const client = makeClient();
  client.searchThrows = { '*': new SpotifyApiError(401, 'The access token expired') };
  const { registered } = makeHarness(client);
  const result = await invoke(findTool(registered, 'taste_to_playlist'), {
    statsfm_user: 'demo',
    seed: 'recent',
    track_count: 2,
    dry_run: false,
  });
  assert.deepEqual(writes(client), [], 'a run where no lookup was served must write nothing');
  const sc = result.structuredContent as {
    ok: boolean;
    blocked: string;
    unresolved: string[];
    search_errors: string[];
  };
  assert.equal(sc.ok, false);
  assert.equal(sc.blocked, 'search_failed');
  // An errored lookup says nothing about the track, so it must not land in
  // unresolved[] — that list means "Spotify searched and matched nothing".
  assert.deepEqual(sc.unresolved, []);
  assert.equal(sc.search_errors.length, 2);
  assert.ok(sc.search_errors.every((e) => e.includes('HTTP 401')), `status must survive into the report: ${JSON.stringify(sc.search_errors)}`);
  const out = text(result);
  assert.doesNotMatch(out, /matched nothing/, 'an auth failure must never read as a missing track');
  assert.doesNotMatch(out, /0 found/, 'a count of matches may not be printed for searches that never returned');
});

test('taste_to_playlist dry_run=false separates failed lookups from genuine misses in a mixed run', async () => {
  const client = makeClient();
  client.searchHits = { 'New Thing': ['spotify:track:SEARCH1'] };
  client.searchThrows = {
    'Spring Song': new SpotifyApiError(429, 'rate limited', 7, 'QUOTA_EXCEEDED'),
    'Deep Cut': new SpotifyApiError(429, 'rate limited', 7, 'QUOTA_EXCEEDED'),
    'Hit Single': new SpotifyApiError(429, 'rate limited', 7, 'QUOTA_EXCEEDED'),
  };
  const { registered } = makeHarness(client);
  const result = await invoke(findTool(registered, 'taste_to_playlist'), {
    statsfm_user: 'demo',
    seed: 'recent',
    track_count: 4,
    dry_run: false,
  });
  const sc = result.structuredContent as {
    unresolved: string[];
    search_errors: string[];
    playlist: { id: string; added: number; requested: number };
  };
  assert.equal(sc.playlist.id, 'PL-1', 'the one resolved pick is still committed');
  assert.equal(sc.playlist.added, 1);
  assert.equal(sc.playlist.requested, 4);
  // The three quota-walled lookups are unknown, not misses.
  assert.deepEqual(sc.unresolved, []);
  assert.equal(sc.search_errors.length, 3);
  assert.ok(
    sc.search_errors.every((e) => e.includes('QUOTA_EXCEEDED')),
    `quota reason must reach the caller: ${JSON.stringify(sc.search_errors)}`,
  );
  const out = text(result);
  assert.match(out, /search_errors\[\]/);
  assert.match(out, /PARTIAL/, 'a short commit must say so in the headline, not only in a footer');
  assert.doesNotMatch(out, /unresolved\[\]/);
});

test('taste_to_playlist treats a 404 search as a genuine miss, not a failed lookup', async () => {
  const client = makeClient();
  client.searchThrows = { '*': new SpotifyApiError(404, 'Not found.') };
  const { registered } = makeHarness(client);
  const result = await invoke(findTool(registered, 'taste_to_playlist'), {
    statsfm_user: 'demo',
    seed: 'recent',
    track_count: 2,
    dry_run: false,
  });
  assert.deepEqual(writes(client), [], 'nothing resolved, so nothing is created');
  const sc = result.structuredContent as {
    blocked: string;
    unresolved: string[];
    search_errors: string[];
  };
  assert.equal(sc.blocked, 'no_resolvable_tracks', 'a 404 is Spotify saying "no match", not a failure');
  assert.equal(sc.unresolved.length, 2);
  assert.deepEqual(sc.search_errors, []);
  assert.match(text(result), /0 found/);
});

test('taste_to_playlist reports only the lookups that actually failed when searches fail and miss in the same run', async () => {
  const client = makeClient();
  // 'Spring Song' 401s; 'Deep Cut' is looked up and comes back with no items.
  // Two searches ran, only one errored.
  client.searchThrows = { 'Spring Song': new SpotifyApiError(401, 'The access token expired') };
  const { registered } = makeHarness(client);
  const result = await invoke(findTool(registered, 'taste_to_playlist'), {
    statsfm_user: 'demo',
    seed: 'recent',
    track_count: 2,
    dry_run: false,
  });
  assert.deepEqual(writes(client), [], 'nothing resolved, so nothing is created');
  const sc = result.structuredContent as {
    blocked: string;
    unresolved: string[];
    search_errors: string[];
  };
  assert.equal(sc.blocked, 'search_failed');
  assert.equal(sc.search_errors.length, 1, 'only the 401 failed; the empty result is not a failure');
  assert.match(sc.search_errors[0], /Core Band — Spring Song \[search failed: HTTP 401\]/);
  assert.deepEqual(sc.unresolved, ['Second Act — Deep Cut'], 'the searched-and-empty pick is a miss, not an error');
  const out = text(result);
  assert.match(out, /1 of 2 track searches failed/, 'the failed count must be the real one, not the search count');
  assert.doesNotMatch(out, /all 2 track searches failed/, 'a pick Spotify searched for is not a failed lookup');
  assert.match(out, /Second Act — Deep Cut/, 'the missed pick is still named for the caller');
});

test('taste_to_playlist never reports an added track under missing[] on the commit path', async () => {
  const client = makeClient();
  // 'recent' carries no stats.fm ids, so all three picks are looked up.
  // Two resolve and land in the playlist; one matches nothing.
  client.searchHits = {
    'Spring Song': ['spotify:track:S1'],
    'Deep Cut': ['spotify:track:S2'],
  };
  const { registered } = makeHarness(client);
  const result = await invoke(findTool(registered, 'taste_to_playlist'), {
    statsfm_user: 'demo',
    seed: 'recent',
    track_count: 3,
    dry_run: false,
  });
  const added = writes(client).find((c) => c.path.endsWith('/items'))?.body as { uris: string[] };
  assert.deepEqual(added.uris, ['spotify:track:S1', 'spotify:track:S2']);
  const sc = result.structuredContent as {
    missing: string[];
    unresolved: string[];
    playlist: { added: number; requested: number };
  };
  assert.equal(sc.playlist.added, 2);
  // renderPicks' pre-search missing[] would name all three; two are in the
  // playlist that was just created and calling them missing invites a re-add.
  assert.deepEqual(sc.missing, ['Core Band — Hit Single'], 'missing[] on commit means NOT added');
  assert.deepEqual(sc.unresolved, ['Core Band — Hit Single']);
  const out = text(result);
  assert.doesNotMatch(out, /had no Spotify id at all/, 'the preview guidance is stale once the lookups have run');
  assert.doesNotMatch(out, /search them by name/, 'the commit path must not tell the caller to search the rows it just added');
  assert.doesNotMatch(out, /\[search: search_tracks/, 'a committed row must not still be asking for its own lookup');
  assert.match(out, /do not re-search or re-add/, 'the commit guidance must steer away from a duplicate add');
  // Each committed row now reports what actually happened to that pick.
  assert.match(out, /1\. Core Band — Spring Song \[spotify:track:S1\]/);
  assert.match(out, /2\. Second Act — Deep Cut \[spotify:track:S2\]/);
  assert.match(out, /3\. Core Band — Hit Single \[search matched nothing — NOT added\]/);
});

// -------------------------------------------------------- 2. taste_daily_brief

test('taste_daily_brief reports top3 + revivals + novelty', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'taste_daily_brief'), {
    statsfm_user: 'demo',
    date: '2026-09-06',
  });
  const out = text(result);
  assert.match(out, /Daily brief for demo — 2026-09-06/);
  assert.match(out, /Top 3:/);
  assert.match(out, /Revivals:/);
  assert.match(out, /Novelty share:/);
});

// -------------------------------------------------------- 3. taste_era_playlist

test('taste_era_playlist renders an era window with tracks', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'taste_era_playlist'), {
    statsfm_user: 'demo',
  });
  const out = text(result);
  assert.match(out, /Era playlist for demo/);
  assert.match(out, /signature/);
});

test('taste_era_playlist rejects an out-of-range era', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'taste_era_playlist'), {
    statsfm_user: 'demo',
    era_index: 99,
  });
  assert.match(text(result), /out of range/);
});

// --------------------------------------------------- 4. taste_forgotten_bangers

test('taste_forgotten_bangers surfaces a revival pick', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'taste_forgotten_bangers'), {
    statsfm_user: 'demo',
  });
  const out = text(result);
  assert.match(out, /Forgotten bangers for demo/);
  assert.match(out, /Revival pick/);
});

// --------------------------------------------------- 5. taste_obsession_ladder

test('taste_obsession_ladder ranks artists with tiers', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'taste_obsession_ladder'), {
    statsfm_user: 'demo',
  });
  const out = text(result);
  assert.match(out, /Obsession ladder for demo/);
  assert.match(out, /Core Band/);
  assert.match(out, /\[favorite\]/);
});

// --------------------------------------------------- 6. taste_diamond_rotation

test('taste_diamond_rotation lists mid-tier deep cuts', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'taste_diamond_rotation'), {
    statsfm_user: 'demo',
  });
  const out = text(result);
  assert.match(out, /Diamond rotation for demo/);
  assert.match(out, /Mid Cut/);
});

// -------------------------------------------------------- 7. taste_weekly_recap

test('taste_weekly_recap summarizes a wide window', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'taste_weekly_recap'), {
    statsfm_user: 'demo',
    days: 900,
  });
  const out = text(result);
  assert.match(out, /Weekly recap for demo/);
  assert.match(out, /Busiest day:/);
});

// -------------------------------------------------------- 8. taste_genre_bridge

test('taste_genre_bridge spans two genres with evidence', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'taste_genre_bridge'), {
    statsfm_user: 'demo',
  });
  const out = text(result);
  assert.match(out, /Genre bridge for demo/);
  assert.match(out, /indie rock/);
});

// ----------------------------------------------------- 9. taste_novelty_loyalty

test('taste_novelty_loyalty reports a verdict', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'taste_novelty_loyalty'), {
    statsfm_user: 'demo',
  });
  const out = text(result);
  assert.match(out, /Novelty vs loyalty for demo/);
  assert.match(out, /Verdict: (comfort|balanced|explorer)/);
});

// ----------------------------------------------------- 10. taste_listening_clock

test('taste_listening_clock reports day parts and a peak', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'taste_listening_clock'), {
    statsfm_user: 'demo',
  });
  const out = text(result);
  assert.match(out, /Listening clock for demo/);
  assert.match(out, /peak:/);
  const sc = result.structuredContent as { dayParting: { peak: string } };
  assert.ok(['night', 'morning', 'afternoon', 'evening'].includes(sc.dayParting.peak));
});

// ------------------------------------------------------ 11. taste_revival_queue

test('taste_revival_queue builds an ordered queue', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'taste_revival_queue'), {
    statsfm_user: 'demo',
    queue_size: 5,
  });
  const out = text(result);
  assert.match(out, /Revival queue for demo/);
});

// ------------------------------------------------------------------ empty data

test('composites degrade gracefully on empty data', async () => {
  __setTasteCompositeFetchImpl(async () => ({ items: [] }));
  const { registered } = makeHarness();
  for (const name of EXPECTED) {
    const result = await invoke(findTool(registered, name), { statsfm_user: 'demo' });
    assert.ok(text(result).length > 0, `${name} produced no output on empty data`);
  }
});
