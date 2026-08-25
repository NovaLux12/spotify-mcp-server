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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { registerResources } from '../src/resources/index.js';
import { registerPrompts } from '../src/prompts/index.js';
import type { SpotifyClient } from '../src/client.js';

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
    'spotify://me/playlists',
    'spotify://me/rate-limit',
    'spotify://me/recently-played',
    'spotify://me/saved/albums',
    'spotify://me/saved/episodes',
    'spotify://me/saved/shows',
    'spotify://me/top/artists',
    'spotify://me/top/tracks',
    'spotify://player/queue',
    'spotify://player/state',
  ]);

  const templates = await client.listResourceTemplates();
  const templateUris = templates.resourceTemplates.map((t) => t.uriTemplate).sort();
  // Every fixed URI has a {?format} twin…
  assert.equal(templateUris.filter((u) => u === 'spotify://me{?format}').length, 1);
  assert.equal(templateUris.filter((u) => u === 'spotify://me/saved/shows{?format}').length, 1);
  // …and playlist tracks exists bare + query-absorbing.
  assert.ok(templateUris.includes('spotify://playlist/{id}/tracks'));
  assert.ok(templateUris.includes('spotify://playlist/{id}/tracks{+qs}'));
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
  assert.match(prose.text, /Playing: "Bohemian Rhapsody" by Queen/);
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

// -------------------------------------------------------- playlist tracks

test('playlist/{id}/tracks template serves prose pagination and raw json (#59)', async () => {
  const page = {
    items: [{ track }, { track: null }],
    total: 3,
    limit: 2,
    offset: 0,
    next: null,
  };
  const client = await connect(makeClientStub({
    getResponse: (path, params) => {
      if (path !== '/playlists/pl1/tracks') return undefined;
      if ((params?.offset ?? '0') === '100') {
        return { ...page, offset: 100, items: [{ track: { ...track, id: 'trk3' } }] };
      }
      return page;
    },
  }));

  const bare = firstContent(await client.readResource({ uri: 'spotify://playlist/pl1/tracks' }));
  assert.match(bare.text, /^Playlist pl1 — 3 tracks/);
  assert.match(bare.text, /1\. "Bohemian Rhapsody" by Queen \| URI: spotify:track:trk1/);
  // the { track: null } entry is filtered out, so the next offset is 1
  assert.match(bare.text, /more available — re-read with \?offset=1/);

  const paged = firstContent(
    await client.readResource({ uri: 'spotify://playlist/pl1/tracks?offset=100&limit=2' }),
  );
  assert.match(paged.text, /101\. "Bohemian Rhapsody"/);

  const raw = firstContent(await client.readResource({ uri: 'spotify://playlist/pl1/tracks?format=json' }));
  assert.deepEqual(JSON.parse(raw.text), page);
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

test('all nine prompts are registered (#60)', async () => {
  const client = await connect(makeClientStub());
  const prompts = await client.listPrompts();
  assert.deepEqual(
    prompts.prompts.map((p) => p.name).sort(),
    [
      'artist_deep_dive',
      'discover_weekly_alternative',
      'dj',
      'listening_recap',
      'migrate_library',
      'music_taste_summary',
      'playlist_audit',
      'playlist_from_mood',
      'podcast_catchup',
    ],
  );
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

// Static lookup table of every tool registered by src/tools/*.
const realToolNames: Record<string, true> = Object.fromEntries([
  // playback
  'get_now_playing', 'get_currently_playing', 'play_from_search', 'play', 'pause',
  'skip_next', 'skip_previous', 'seek', 'set_volume', 'set_shuffle', 'set_repeat',
  'get_queue', 'add_to_queue', 'get_devices', 'transfer_playback',
  'get_track', 'get_artist', 'get_artist_albums', 'get_album', 'get_album_tracks',
  'get_show', 'get_show_episodes', 'get_episode', 'get_me', 'get_artist_top_tracks',
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
        .map((a) => [a.name, 'test-input']),
    );
    const result = await client.getPrompt({ name: p.name, arguments: promptArgs });
    const body = result.messages.map((m) => textOf(m)).join('\n');
    // Non-tool snake_case tokens that legitimately appear in prompt bodies:
    // Spotify API field names, prompt argument names, and time ranges.
    const NOT_TOOLS = [
      'fetch_all', 'max_per_show', 'time_range',
      'short_term', 'medium_term', 'long_term',
      'album_type', 'release_date', 'playlist_name', 'include_singles',
      'max_results',
    ];
    const referenced = [...body.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)]
      .map((m) => m[0])
      .filter((name) => !name.startsWith('spotify_') && !NOT_TOOLS.includes(name));
    for (const name of new Set(referenced)) {
      assert.ok(realToolNames[name] === true, `prompt '${p.name}' references unknown tool '${name}'`);
    }
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
