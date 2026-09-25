/**
 * Tests for src/resources/index.ts (#59) and src/prompts/index.ts (#60):
 *
 *  - resource/prompt registration inventory (names, URIs, templates)
 *  - prose vs ?format=json rendering through the real MCP SDK routing
 *    (InMemoryTransport), which proves fixed URIs AND {?format} twins both
 *    resolve — the SDK matches fixed resources by exact string, so the twin
 *    templates are load-bearing
 *  - saved-library resources, paginated playlist-tracks template,
 *    rate-limit resource
 *  - prompt argument defaults and that prompt text only references tools
 *    that actually exist in src/tools
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { registerResources } from '../src/resources/index.js';
import { registerPrompts } from '../src/prompts/index.js';
import { SpotifyApiError, type SpotifyClient } from '../src/client.js';
import { registerArtistWatchTools } from '../src/tools/artistwatch.js';
import { registerShowRadarTools } from '../src/tools/showradar.js';

type ToolContent = {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};

// ---------------------------------------------------------------- fixtures

type Call = { method: string; path: string; params?: Record<string, string> };

const artist = { id: 'art1', name: 'Queen', uri: 'spotify:artist:art1' };
const track = {
  id: 'trk1',
  name: 'Bohemian Rhapsody',
  uri: 'spotify:track:trk1',
  type: 'track' as const,
  duration_ms: 355000,
  explicit: false,
  artists: [artist],
  album: { id: 'alb1', name: 'A Night at the Opera', uri: 'spotify:album:alb1', images: [] },
};
const profile = {
  id: 'user1',
  display_name: 'Jack',
  uri: 'spotify:user:user1',
};

interface StubOptions {
  getResponse?: (path: string, params?: Record<string, string>) => unknown;
  getAllPagesResponse?: (path: string) => unknown[];
}

function makeClientStub(opts: StubOptions = {}): SpotifyClient {
  const calls: Call[] = [];
  const stub = {
    get: async (path: string, params?: Record<string, string>) => {
      calls.push(params === undefined ? { method: 'GET', path } : { method: 'GET', path, params });
      return opts.getResponse?.(path, params);
    },
    getAllPages: async (path: string) => opts.getAllPagesResponse?.(path) ?? [],
    getRateLimitStatus: () => ({
      lastThrottleAt: null as number | null,
      retryAfterSec: null as number | null,
      cooldownRemainingMs: 0,
    }),
  };
  // Test seam: registerResources only needs these three members of the class.
  return stub as unknown as SpotifyClient;
}

async function connect(stub: SpotifyClient): Promise<Client> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerResources(server, stub);
  registerPrompts(server);
  const client = new Client({ name: 'tester', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(clientTransport), client.connect(serverTransport)]);
  return client;
}

function firstContent(result: { contents: Array<{ mimeType: string; text: string }> }): {
  mimeType: string;
  text: string;
} {
  return result.contents[0];
}

function textOf(message: { content: { type: string; text?: string } }): string {
  return message.content.type === 'text' ? (message.content.text ?? '') : '';
}

// ------------------------------------------------------- resource inventory

test('registers all #59 resource URIs plus format/json twins and templates', async () => {
  const client = await connect(makeClientStub());
  const resources = await client.listResources();
  const uris = resources.resources.map((r) => r.uri).sort();

  assert.deepEqual(uris, [
    'spotify://me',
    'spotify://me/followed/artists',
    'spotify://me/genre-heatmap',
    'spotify://me/listening-history',
    'spotify://me/playlists',
    'spotify://me/rate-limit',
    'spotify://me/recently-played',
    'spotify://me/saved/albums',
    'spotify://me/saved/audiobooks',
    'spotify://me/saved/episodes',
    'spotify://me/saved/shows',
    'spotify://me/saved/tracks',
    'spotify://me/top/artists',
    'spotify://me/top/tracks',
    'spotify://player/queue',
    'spotify://player/state',
  ]);

  assert.ok(resources.resources.every((resource) => resource.mimeType === 'text/plain'));

  const templates = await client.listResourceTemplates();
  const templateUris = templates.resourceTemplates.map((t) => t.uriTemplate).sort();
  // Every fixed URI has a {?format} twin…
  assert.equal(templateUris.filter((u) => u === 'spotify://me{?format}').length, 1);
  assert.equal(templateUris.filter((u) => u === 'spotify://me/saved/shows{?format}').length, 1);
  // …and playlist tracks exists bare + query-absorbing.
  assert.ok(templateUris.includes('spotify://playlist/{id}/tracks'));
  assert.ok(templateUris.includes('spotify://playlist/{id}/tracks{+qs}'));
  assert.ok(templates.resourceTemplates.every((template) => template.mimeType === 'text/plain'));
});

// ------------------------------------------------------ json variant routing

test('bare spotify://me renders prose; ?format=json resolves via twin template', async () => {
  const client = await connect(makeClientStub({
    getResponse: (path) => (path === '/me' ? profile : undefined),
  }));

  const prose = firstContent(await client.readResource({ uri: 'spotify://me' }));
  assert.equal(prose.mimeType, 'text/plain');
  assert.match(prose.text, /User: Jack/);

  const raw = firstContent(await client.readResource({ uri: 'spotify://me?format=json' }));
  assert.equal(raw.mimeType, 'application/json');
  assert.deepEqual(JSON.parse(raw.text), profile);
});

test('player state json variant returns the raw API object', async () => {
  const playbackState = {
    is_playing: true,
    progress_ms: 1000,
    shuffle_state: false,
    repeat_state: 'off',
    device: null,
    item: track,
  };
  const client = await connect(makeClientStub({
    getResponse: (path) => (path === '/me/player' ? playbackState : undefined),
  }));

  const raw = firstContent(await client.readResource({ uri: 'spotify://player/state?format=json' }));
  assert.equal(raw.mimeType, 'application/json');
  assert.deepEqual(JSON.parse(raw.text), playbackState);

  const prose = firstContent(await client.readResource({ uri: 'spotify://player/state' }));
  assert.match(prose.text, /Playing: "Bohemian Rhapsody" \(track\) — by Queen/);
});

test('player state safely renders chapter items and requests non-track types', async () => {
  const chapter = {
    id: 'ch1',
    name: 'Chapter One',
    uri: 'spotify:chapter:ch1',
    type: 'chapter',
    duration_ms: 60000,
    audiobook: { name: 'A Long Book', authors: [{ name: 'An Author' }] },
  };
  const state = {
    is_playing: true,
    progress_ms: 15000,
    shuffle_state: false,
    repeat_state: 'off',
    timestamp: 1,
    device: null,
    item: chapter,
    currently_playing_type: 'unknown',
    context: null,
  };
  const stub = makeClientStub({ getResponse: (path) => (path === '/me/player' ? state : undefined) });
  const client = await connect(stub);

  const prose = firstContent(await client.readResource({ uri: 'spotify://player/state' }));
  assert.match(prose.text, /Chapter One/);
  assert.match(prose.text, /A Long Book/);
  assert.doesNotMatch(prose.text, /unsupported item/);
});

// ------------------------------------------------------------ saved library

test('saved albums/shows/episodes walk pages and support ?format=json (#59)', async () => {
  const albumItem = {
    added_at: '2026-01-01T00:00:00Z',
    album: { ...track.album, release_date: '1975-10-31', total_tracks: 12, artists: [artist] },
  };
  const showItem = {
    added_at: '2026-02-02T00:00:00Z',
    show: {
      id: 'shw1', name: 'Great Podcast', uri: 'spotify:show:shw1',
      description: '', publisher: 'Acme', total_episodes: 9,
    },
  };
  const episodeItem = {
    added_at: '2026-03-03T00:00:00Z',
    episode: {
      id: 'ep1', name: 'Episode One', uri: 'spotify:episode:ep1', duration_ms: 1800000,
      release_date: '2026-03-01', explicit: false, description: '', languages: ['en'],
      audio_preview_url: null, show: { id: 'shw1', name: 'Great Podcast', uri: 'spotify:show:shw1' },
    },
  };
  const client = await connect(makeClientStub({
    getAllPagesResponse: (path) =>
      path === '/me/albums' ? [albumItem]
        : path === '/me/shows' ? [showItem]
          : path === '/me/episodes' ? [episodeItem]
            : [],
  }));

  const albums = firstContent(await client.readResource({ uri: 'spotify://me/saved/albums' }));
  assert.match(albums.text, /Saved albums \(1\)/);
  assert.match(albums.text, /"A Night at the Opera" — Queen \(1975-10-31, 12 tracks/);

  const showsJson = firstContent(await client.readResource({ uri: 'spotify://me/saved/shows?format=json' }));
  assert.deepEqual(JSON.parse(showsJson.text), { total: 1, items: [showItem] });

  const episodes = firstContent(await client.readResource({ uri: 'spotify://me/saved/episodes' }));
  assert.match(episodes.text, /"Episode One" — Great Podcast \(30:00/);
});

test('playlist summary distinguishes a zero count from a missing count', async () => {
  const client = await connect(makeClientStub({
    getAllPagesResponse: () => [
      { id: 'zero', name: 'Empty', uri: 'spotify:playlist:zero', description: null, owner: { id: 'u', display_name: null }, items: { total: 0 } },
      { id: 'unknown', name: 'Uncounted', uri: 'spotify:playlist:unknown', description: null, owner: { id: 'u', display_name: null } },
    ],
  }));

  const out = firstContent(await client.readResource({ uri: 'spotify://me/playlists' }));
  assert.match(out.text, /"Empty" \(0 items\)/);
  assert.match(out.text, /"Uncounted" \(unknown item count\)/);
});

// -------------------------------------------------------- playlist tracks

test('playlist/{id}/tracks template serves prose pagination and raw json (#59)', async () => {
  const page = {
    items: [{ item: track }, { item: null }],
    total: 3,
    limit: 2,
    offset: 0,
    next: null,
  };
  const client = await connect(makeClientStub({
    getResponse: (path, params) => {
      if (path !== '/playlists/pl1/items') return undefined;
      if ((params?.offset ?? '0') === '100') {
        return { ...page, offset: 100, items: [{ item: { ...track, id: "trk3" } }] };
      }
      return page;
    },
  }));

  const bare = firstContent(await client.readResource({ uri: 'spotify://playlist/pl1/tracks' }));
  assert.match(bare.text, /^Playlist pl1 — 3 items/);
  assert.match(bare.text, /1\. "Bohemian Rhapsody" \(track\) — by Queen/);
  // the { item: null } entry is filtered out, so the next offset advances by the page size
  assert.match(bare.text, /more available — re-read with \?offset=2/);

  const paged = firstContent(
    await client.readResource({ uri: 'spotify://playlist/pl1/tracks?offset=100&limit=2' }),
  );
  assert.match(paged.text, /101\. "Bohemian Rhapsody"/);

  const raw = firstContent(await client.readResource({ uri: 'spotify://playlist/pl1/tracks?format=json' }));
  assert.deepEqual(JSON.parse(raw.text), page);

});

test('playlist tracks keeps missing totals distinct from zero and renders non-track entries', async () => {
  const episode = {
    item: {
      id: 'ep1', name: 'Episode One', uri: 'spotify:episode:ep1', type: 'episode', duration_ms: 120000,
      show: { name: 'The Show' },
    },
  };
  const client = await connect(makeClientStub({
    getResponse: (path) => path === '/playlists/pl2/items'
      ? { items: [episode], limit: 100, offset: 0, next: null }
      : undefined,
  }));

  const out = firstContent(await client.readResource({ uri: 'spotify://playlist/pl2/tracks' }));
  assert.match(out.text, /Playlist pl2 — unknown items/);
  assert.match(out.text, /Episode One.*episode.*The Show/);
});

test('gated resource errors are named instead of rendered as empty', async () => {
  for (const uri of ['spotify://me/saved/audiobooks', 'spotify://me/genre-heatmap']) {
    const forbidden = await connect(makeClientStub({
      getAllPagesResponse: () => { throw new SpotifyApiError(403, 'Forbidden'); },
    }));
    const prose = firstContent(await forbidden.readResource({ uri }));
    assert.match(prose.text, /market or OAuth scope \(403\)/);

    const payload = firstContent(await forbidden.readResource({ uri: `${uri}?format=json` }));
    assert.deepEqual(JSON.parse(payload.text), { error: '403', partial: false });
  }

  const rateLimited = await connect(makeClientStub({
    getAllPagesResponse: () => {
      throw new SpotifyApiError(429, 'Rate limited', 17);
    },
  }));
  const wait = firstContent(await rateLimited.readResource({ uri: 'spotify://me/genre-heatmap' }));
  assert.match(wait.text, /Retry after 17 seconds/);
});

test('unexpected resource errors propagate instead of claiming empty data', async () => {
  for (const uri of ['spotify://me/saved/audiobooks', 'spotify://me/genre-heatmap']) {
    const client = await connect(makeClientStub({
      getAllPagesResponse: () => { throw new TypeError('payload parser failed'); },
    }));
    await assert.rejects(client.readResource({ uri }), /payload parser failed/);
  }
});

// ------------------------------------------------------------- rate-limit

test('rate-limit resource reports never throttled by default (#56/#59)', async () => {
  const client = await connect(makeClientStub());
  const out = firstContent(await client.readResource({ uri: 'spotify://me/rate-limit' }));
  assert.match(out.text, /never throttled/);

  const raw = firstContent(await client.readResource({ uri: 'spotify://me/rate-limit?format=json' }));
  assert.deepEqual(JSON.parse(raw.text), { lastThrottleAt: null, retryAfterSec: null, cooldownRemainingMs: 0 });
});

// ---------------------------------------------------------------- prompts

test('all fourteen prompts are registered (#60, #112)', async () => {
  const client = await connect(makeClientStub());
  const prompts = await client.listPrompts();
  assert.deepEqual(
    prompts.prompts.map((p) => p.name).sort(),
    [
      'artist_deep_dive',
      'crate_digging',
      'discover_weekly_alternative',
      'dj',
      'listening_recap',
      'migrate_library',
      'morning_briefing',
      'music_briefing',
      'music_taste_summary',
      'playlist_audit',
      'playlist_from_mood',
      'podcast_catchup',
      'triage_liked_songs',
      'weekly_digest',
    ],
  );
});

test('prompt schemas describe every advertised argument', async () => {
  const client = await connect(makeClientStub());
  const prompts = await client.listPrompts();
  for (const prompt of prompts.prompts) {
    for (const argument of prompt.arguments ?? []) {
      assert.equal(typeof argument.description, 'string', `${prompt.name}.${argument.name} has no description`);
      assert.notEqual(argument.description?.trim(), '', `${prompt.name}.${argument.name} has an empty description`);
    }
  }
});

test('parameterized prompts apply defaults without requiring arguments (#60)', async () => {
  const client = await connect(makeClientStub());

  const tasteAll = await client.getPrompt({ name: 'music_taste_summary', arguments: {} });
  assert.match(textOf(tasteAll.messages[0]), /short_term.*medium_term.*long_term/s);

  const discovery = await client.getPrompt({ name: 'discover_weekly_alternative', arguments: {} });
  assert.match(textOf(discovery.messages[0]), /\b20\b/, 'size defaults to 20');

  const recap = await client.getPrompt({ name: 'listening_recap', arguments: {} });
  assert.match(textOf(recap.messages[0]), /time_range=medium_term/);
  assert.match(textOf(recap.messages[0]), /limit=10\)/);

  const migrate = await client.getPrompt({ name: 'migrate_library', arguments: {} });
  assert.match(textOf(migrate.messages[0]), /My Saved Albums/);
});

test('prompt time_range argument flows into generated instructions (#60)', async () => {
  const client = await connect(makeClientStub());
  const recap = await client.getPrompt({
    name: 'listening_recap',
    arguments: { time_range: 'long_term', size: '25' },
  });
  const body = textOf(recap.messages[0]);
  assert.match(body, /time_range=long_term/);
  assert.match(body, /limit=25\)/);
});

test('triage_liked_songs is registered and its schema rejects a bogus bucket_by (#112)', async () => {
  const client = await connect(makeClientStub());
  const prompts = await client.listPrompts();
  assert.ok(
    prompts.prompts.some((p) => p.name === 'triage_liked_songs'),
    'triage_liked_songs prompt should be registered',
  );
  // Enum validation happens at the SDK layer before the handler runs.
  await assert.rejects(
    client.getPrompt({ name: 'triage_liked_songs', arguments: { bucket_by: 'bogus' } }),
  );
});

// Static lookup table of every tool registered by src/tools/*.
const realToolNames: Record<string, true> = Object.fromEntries([
  // playback
  'get_now_playing', 'get_currently_playing', 'play_from_search', 'play', 'pause',
  'find_duplicates_in_playlist',
  'skip_next', 'skip_previous', 'seek', 'set_volume', 'set_shuffle', 'set_repeat',
  'get_queue', 'add_to_queue', 'get_devices', 'transfer_playback',
  'get_track', 'get_artist', 'get_artist_albums', 'get_album', 'get_album_tracks',
  'get_show', 'list_show_episodes', 'get_episode', 'get_me', 'get_artist_top_tracks',
  'get_available_markets', 'get_several_tracks', 'get_several_albums', 'get_several_artists',
  'get_several_episodes', 'get_several_shows', 'get_several_audiobooks', 'get_several_chapters',
  // personalization
  'get_top_tracks', 'get_top_artists', 'get_recently_played',
  // library
  'get_saved_tracks', 'get_saved_albums', 'get_saved_shows', 'get_saved_episodes',
  'save_items', 'remove_saved_items', 'check_saved_items',
  'save_to_library', 'remove_from_library', 'check_in_library',
  // playlists
  'get_user_playlists', 'get_playlist', 'get_playlist_items', 'get_playlist_cover',
  'upload_playlist_cover', 'create_playlist', 'add_to_playlist', 'remove_from_playlist',
  'update_playlist', 'reorder_playlist_items', 'replace_playlist_items',
  // following / users
  'get_followed_artists', 'check_following_artists', 'follow_artists', 'unfollow_artists',
  'get_user_profile', 'get_user_playlists_by_id',
  // audiobooks
  'get_audiobook', 'get_audiobook_chapters', 'get_chapter', 'get_saved_audiobooks',
  // analytics/portability (exhaust-portability)
  'listening_report', 'listening_streaks', 'top_artists_by_range', 'taste_shift_report',
  'export_all_playlists', 'export_library_json', 'export_followed_artists', 'library_snapshot_diff', 'history_search', 'import_from_sidecar',
  'save_discover_weekly', 'save_release_radar',
  // search/catalog helpers referenced by prompts
  'search', 'search_deep', 'get_artist_albums', 'get_album_tracks',
  // radar/briefing tools referenced by music_briefing + others
  'show_new_episodes', 'artist_release_digest', 'whats_new', 'check_artist_releases', 'watch_artists',
  'library_genre_report', 'filter_by_genre',
  // catalog helpers for crate_digging etc
  'get_top_tracks', 'get_top_artists', 'get_recently_played', 'get_saved_albums', 'get_saved_tracks',
  'get_saved_shows', 'list_show_episodes', 'get_followed_artists',
  // queueops
  'queue_playlist', 'save_queue_as_playlist', 'batch_add_to_queue',
  // suite helpers
  'create_playlist', 'add_to_playlist', 'add_to_queue', 'get_user_playlists', 'get_playlist_items',
  'find_duplicates_in_playlist', 'remove_from_playlist',
].map((name) => [name, true as const]));

test('every prompt only references tool names that are actually registered', async () => {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerPrompts(server);
  const client = new Client({ name: 'tester', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(ct), client.connect(st)]);

  for (const p of (await client.listPrompts()).prompts) {
    // Required args in this suite are all plain strings; fill them so prompts
    // like playlist_from_mood validate.
    const promptArgs = Object.fromEntries(
      ((p.arguments ?? []) as Array<{ name: string; required?: boolean }>)
        .filter((a) => a.required)
        .map((a) => [a.name, a.name === 'since' ? '2026-01-01' : 'test-input']),
    );
    const result = await client.getPrompt({ name: p.name, arguments: promptArgs });
    const body = result.messages.map((m) => textOf(m)).join('\n');
    // Non-tool snake_case tokens that legitimately appear in prompt bodies:
    // Spotify API field names, prompt argument names, time ranges, and the
    // declared parameters of the tools a prompt calls — `per_show_limit` is
    // show_new_episodes' parameter, not a misspelt tool (#716). Wrong
    // tool/parameter *pairings* are the param guard's job below, not this
    // guard's, which only asks "is this token a tool at all".
    const NOT_TOOLS = [
      'fetch_all', 'max_per_show', 'time_range',
      'short_term', 'medium_term', 'long_term',
      'album_type', 'release_date', 'playlist_name', 'include_singles',
      'max_results', 'dry_run', 'total_tracks',
    ];
    const referenced = [...body.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)]
      .map((m) => m[0])
      .filter((name) => !name.startsWith('spotify_') && !NOT_TOOLS.includes(name) && !realParamNames.has(name));
    for (const name of new Set(referenced)) {
      assert.ok(realToolNames[name] === true, `prompt '${p.name}' references unknown tool '${name}'`);
    }
  }
});

// ---------------------------------------------------------------------------
// #716 — a prompt can name a real tool and still be wrong.
//
// The name-only guard above passes on `show_new_episodes (since=2026-08-01,
// max_per_show=3)`: the tool exists, but it declares neither parameter, so the
// client silently drops both and the 7-day default answers a "three months"
// request. A prompt can also mandate a tool whose wrapper rethrows on 403 with
// no degraded path, which either aborts the task or — for a hit filter —
// inverts the prompt's own purpose. Both are separate guards below.
// ---------------------------------------------------------------------------

async function withPromptClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerPrompts(server);
  const client = new Client({ name: 'tester', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(ct), client.connect(st)]);
  return fn(client);
}

async function promptBody(
  client: Client,
 name: string,
  args: Record<string, string> = {},
): Promise<string> {
  const result = await client.getPrompt({ name, arguments: args });
  return result.messages.map((m) => textOf(m)).join('\n');
}

/** Every registered prompt, rendered with the required args the guards use. */
async function allPromptBodies(): Promise<Map<string, string>> {
  return withPromptClient(async (client) => {
    const bodies = new Map<string, string>();
    for (const p of (await client.listPrompts()).prompts) {
      const required = Object.fromEntries(
        ((p.arguments ?? []) as Array<{ name: string; required?: boolean }>)
          .filter((a) => a.required)
          .map((a) => [a.name, a.name === 'since' ? '2026-01-01' : 'test-input']),
      );
      bodies.set(p.name, await promptBody(client, p.name, required));
    }
    return bodies;
  });
}

/**
 * The parameter contract of every tool a prompt passes `key=value` arguments
 * to, transcribed by hand from the tool schemas in src/tools/*.
 *
 * Deliberately NOT derived from the live registry: a table regenerated from
 * the registry would restate whatever the registry happens to declare and so
 * could never contradict a prompt — that is the defect the guard exists to
 * catch. A tool that gains a parameterised mention in a prompt body without a
 * row here fails the test on purpose, so the expectation stays an explicit
 * decision rather than an inherited default.
 */
const realToolParams: Record<string, readonly string[]> = {
  add_to_playlist: ['playlist_id', 'uris', 'check_duplicates', 'position', 'dry_run'],
  add_to_queue: ['uri', 'device_id', 'response_format', 'dry_run'],
  batch_add_to_queue: ['uris', 'device_id', 'response_format', 'dry_run'],
  create_playlist: ['name', 'description', 'public', 'collaborative', 'dry_run'],
  get_playlist_items: [
    'playlist_id', 'id', 'limit', 'offset', 'market', 'fields', 'additional_types',
    'fetch_all', 'response_format', 'max_results',
  ],
  get_recently_played: ['limit', 'after', 'before', 'response_format', 'max_results'],
  get_saved_shows: ['limit', 'offset', 'fetch_all', 'response_format', 'max_results'],
  get_top_artists: ['time_range', 'limit', 'offset', 'response_format', 'max_results'],
  get_top_tracks: ['time_range', 'limit', 'offset', 'response_format', 'max_results'],
  get_user_playlists: ['limit', 'offset', 'fetch_all', 'response_format', 'max_results'],
  search: ['query', 'types', 'limit', 'offset', 'include_external', 'market', 'response_format', 'max_results'],
  show_new_episodes: ['days', 'per_show_limit', 'max_shows', 'cost_preview', 'response_format', 'max_results'],
  watch_artists: ['artist_ids', 'name', 'response_format'],
  whats_new: ['since', 'days_back', 'kinds', 'max_artists', 'response_format', 'max_results', 'dry_run'],
};

/**
 * Every parameter name declared above, so the name-only guard can tell a tool
 * parameter such as `per_show_limit` apart from a misspelt tool. Same
 * hand-written source, so this inherits the same independence from the
 * registry.
 */
const realParamNames = new Set(Object.values(realToolParams).flat());

test('every parameter a prompt hands to a tool is one the tool declares (#716)', async () => {
  const bodies = await allPromptBodies();
  // Which tools got a real `key=` argument list inspected. Prose parentheses
  // such as "(limit 50; paginate if needed)" carry no `key=` and are skipped.
  const inspected = new Set<string>();
  for (const [promptName, body] of bodies) {
    for (const m of body.matchAll(/([a-z][a-z0-9_]*)\s*\(([^()]*)\)/g)) {
      const [, token, inner] = m;
      if (realToolNames[token] !== true) continue; // prose noun, not a tool
      const keys = [...inner.matchAll(/([a-z][a-z0-9_]*)\s*=/g)].map((k) => k[1]);
      if (keys.length === 0) continue;
      const declared = realToolParams[token];
      assert.ok(
        declared !== undefined,
        `prompt '${promptName}' calls ${token} with parameters but realToolParams has no row for it — add ${token}'s real parameter list`,
      );
      for (const key of keys) {
        assert.ok(
          declared.includes(key),
          `prompt '${promptName}' passes '${key}' to ${token}, which does not declare it (declares: ${declared.join(', ')})`,
        );
      }
      inspected.add(token);
    }
  }
  // The pass must actually reach the call sites it is meant to police;
  // otherwise a regex regression would make it vacuously green.
  for (const expected of [
    'show_new_episodes', 'get_user_playlists', 'get_saved_shows', 'whats_new',
    'watch_artists', 'create_playlist', 'add_to_playlist', 'search',
    'get_top_tracks', 'get_top_artists', 'get_recently_played',
  ]) {
    assert.ok(inspected.has(expected), `param pass never inspected ${expected} — the match pattern is not seeing the prompt text`);
  }
});

test('podcast_catchup converts its `since` date into show_new_episodes\' real window parameter (#716)', async () => {
  const fortyDaysAgo = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
  const body = await withPromptClient((c) => promptBody(c, 'podcast_catchup', { since: fortyDaysAgo }));

  // The date intent survives as a day count, on the parameters the tool takes.
  assert.match(body, /show_new_episodes \(days=40, per_show_limit=3\)/);
  assert.doesNotMatch(body, /show_new_episodes\s*\([^)]*\bsince=/, 'show_new_episodes has no `since` parameter');
  assert.doesNotMatch(body, /max_per_show=/, 'show_new_episodes has no `max_per_show` parameter');
  // ...and the tool still gets called, so this is not a swap of one bad name
  // for another.
  assert.match(body, /Prefer show_new_episodes/);
  // A window the tool cannot express is disclosed instead of silently clamped.
 const tooOld = new Date(Date.now() - 500 * 86_400_000).toISOString().slice(0, 10);
  const clamped = await withPromptClient((c) => promptBody(c, 'podcast_catchup', { since: tooOld }));
  assert.match(clamped, /days=365/);
  assert.match(clamped, /365-day maximum/);
});

test('the day count podcast_catchup emits makes show_new_episodes cut off ON the requested date (#716)', async () => {
  const since = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
  const body = await withPromptClient((c) => promptBody(c, 'podcast_catchup', { since }));
  const emitted = /show_new_episodes \(days=(\d+),/.exec(body);
  assert.ok(emitted, 'podcast_catchup should hand a day count to show_new_episodes');
  assert.equal(emitted[1], '40');

  // Ask the REAL tool what date that day count cuts off at, rather than
  // restating cutoffDate() here. `since` must be that date: the tool filters
  // with `release_date < cutoff` against a YYYY-MM-DD string, so the requested
  // day is included in full and nothing released on it is dropped. A +1 would
  // overshoot instead, contradicting the tool's own "last N day(s)" framing,
  // which already counts the current day as one of the N.
  const handlers: Record<string, (a: Record<string, unknown>) => Promise<ToolContent>> = {};
  const server = {
    tool: (n: string, _d: string, _s: unknown, h: (a: Record<string, unknown>) => Promise<ToolContent>) => {
      handlers[n] = h;
    },
  };
  registerShowRadarTools(server as never, makeClientStub() as never);
  const radar = handlers.show_new_episodes;
  assert.ok(radar, 'show_new_episodes should be registered');
  const preview = await radar({ days: Number(emitted[1]), cost_preview: true });
  const prose = preview.content.map((c) => c.text ?? '').join('\n');
  assert.match(prose, new RegExp(`Cutoff: episodes on/after ${since}\\b`));
});

/**
 * Tools whose wrapper rethrows on 403 rather than degrading. A prompt may name
 * one, but mandating it with no documented degraded path is the defect: the
 * task aborts, or the model drops the step and reports the artist's biggest
 * songs as deep cuts. `mustMention` is the exact fallback the prompt must
 * spell out — hand-written from the throw in src/tools/catalog.ts, so a prompt
 * cannot satisfy it by echoing whatever the tool happens to do.
 */
const REQUIRED_FALLBACK: Array<{ tool: string; mustMention: string[] }> = [
  {
    tool: 'get_artist_top_tracks',
    mustMention: ['403', 'get_artist_albums', 'get_album_tracks', 'hit detection was unavailable'],
  },
];

test('a prompt that names a hard-throwing tool documents the degraded path (#716)', async () => {
  for (const [promptName, body] of await allPromptBodies()) {
    for (const { tool, mustMention } of REQUIRED_FALLBACK) {
      if (!body.includes(tool)) continue;
      for (const phrase of mustMention) {
        assert.ok(
          body.includes(phrase),
          `prompt '${promptName}' mandates ${tool} but never says "${phrase}" — without it the 403 either aborts the run or silently drops the hit filter`,
        );
      }
    }
  }
});

/**
 * Lookups that return one page by default. A prompt that uses one to answer
 * "does this name already exist?" must pin the paging flag AT that call, not
 * merely somewhere in the body: a first page of 20 turns a >20-playlist
 * account into a duplicate playlist on every re-run.
 */
const PAGED_NAME_CHECKS: Array<{ tool: string; mustCarry: string }> = [
  { tool: 'get_user_playlists', mustCarry: 'fetch_all=true' },
];

test('a playlist name-existence check pins fetch_all=true at the call site (#716)', async () => {
  for (const [promptName, body] of await allPromptBodies()) {
    for (const { tool, mustCarry } of PAGED_NAME_CHECKS) {
      let at = body.indexOf(tool);
      while (at !== -1) {
        const window = body.slice(at, at + 240);
        assert.ok(
          window.includes(mustCarry),
          `prompt '${promptName}' reads ${tool} at offset ${at} without ${mustCarry} nearby, so a first-page listing looks like a complete one: "${window.slice(0, 120)}"`,
        );
        at = body.indexOf(tool, at + tool.length);
      }
    }
  }
});

test('music_briefing asks whats_new for followed-artist releases, not the watchlist sidecar (#716)', async () => {
  const body = (await allPromptBodies()).get('music_briefing') ?? '';
  // artist_release_digest reads a local watchlist sidecar that is empty on a
  // default install, so it cannot answer "new releases from followed artists".
  const releasesLine = body.split('\n').find((l) => l.startsWith('2. New releases')) ?? '';
  assert.ok(releasesLine !== '', 'music_briefing should have a "2. New releases" section');
  assert.match(releasesLine, /call whats_new \(kinds=\["albums"\], max_artists=\d+\)/);
  assert.doesNotMatch(releasesLine, /call artist_release_digest \(or /);
  assert.match(releasesLine, /watchlist-scoped variant/);
  assert.match(releasesLine, /watch_artists \(artist_ids=\[\.\.\.\]\)/);
});

test('artist_release_digest empty watchlist is actionable, not a bare dead end (#716)', async () => {
  const dir = join(tmpdir(), `aw-empty-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const prev = process.env.SPOTIFY_MCP_DATA_DIR;
  process.env.SPOTIFY_MCP_DATA_DIR = dir;
  try {
    const handlers: Record<string, (a: Record<string, unknown>) => Promise<ToolContent>> = {};
    const server = {
      tool: (n: string, _d: string, _s: unknown, h: (a: Record<string, unknown>) => Promise<ToolContent>) => {
        handlers[n] = h;
      },
    };
    registerArtistWatchTools(server as never, makeClientStub() as never);
    const digest = handlers.artist_release_digest;
    assert.ok(digest, 'artist_release_digest should be registered');

    const unknown = await digest({ watchlist_name: 'not-a-list' });
    const text = unknown.content.map((c) => c.text).join('\n');
    assert.match(text, /does not exist/, 'a missing watchlist must say so, not "is empty"');
    assert.match(text, /watch_artists \(artist_ids=\[\.\.\.\]\)/, 'the fix must be named');
    assert.equal(unknown.structuredContent?.ok, false);
    assert.equal(unknown.structuredContent?.reason, 'unknown_watchlist');

    // Seed a watchlist with no artists: same dead end, different reason.
    const watchers = handlers.watch_artists;
    assert.ok(watchers, 'watch_artists should be registered');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'artist-watchlist.json'),
      JSON.stringify({ watchlists: { seeded: { artists: [], createdAt: '', lastChecked: null, seen: {} } } }),
    );
    const empty = await digest({ watchlist_name: 'seeded' });
    const emptyText = empty.content.map((c) => c.text).join('\n');
    assert.match(emptyText, /No artists in watchlist "seeded" — nothing was scanned\./);
    assert.doesNotMatch(emptyText, /Watchlist "seeded" is empty\./, 'the bare dead end is what #716 removed');
    assert.equal(empty.structuredContent?.ok, false);
    assert.equal(empty.structuredContent?.reason, 'empty_watchlist');
  } finally {
    if (prev === undefined) delete process.env.SPOTIFY_MCP_DATA_DIR;
    else process.env.SPOTIFY_MCP_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test('saved-shows resource falls back to "unknown publisher" when the field is absent (issues #78/#86; Feb 2026)', async () => {
  const showItem = {
    added_at: '2026-02-02T00:00:00Z',
    show: {
      id: 'shw9', name: 'Publisherless Show', uri: 'spotify:show:shw9',
      description: '', total_episodes: 4,
    },
  };
  const client = await connect(makeClientStub({
    getAllPagesResponse: (path) => (path === '/me/shows' ? [showItem] : []),
  }));

  const shows = firstContent(await client.readResource({ uri: 'spotify://me/saved/shows' }));
  assert.match(shows.text, /"Publisherless Show" — unknown publisher \(4 episodes/);
});
