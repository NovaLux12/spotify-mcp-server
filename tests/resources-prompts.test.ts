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
 *    that actually exist in src/tools — the tool-name allow-list is derived
 *    from the live registrar manifest via tests/live-registry.ts, never
 *    written down (#670)
 */
import './helpers/hermetic.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

import { registerReadSurfaces } from '../src/resources/register.js';
import { registerPrompts } from '../src/prompts/index.js';
import { SpotifyApiError, type SpotifyClient } from '../src/client.js';
import { moduleToolNames } from '../src/tools/annotations.js';
import {
  buildFullRegistryServer,
  extractBody,
  findUndeclaredPromptArgs,
  findUnknownPromptTools,
  promptSurface,
  type PromptSurface,
} from './live-registry.js';

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
  /**
   * Full walk verdict, for the resources that report coverage (#718/#604).
   * Omitted means a complete walk whose rows are every row returned, which is
   * what the pre-existing rendering tests assume.
   */
  walk?: {
    items: unknown[];
    truncated?: boolean;
    truncatedByCap?: boolean;
    reportedTotal?: number | null;
  };
}

function makeClientStub(opts: StubOptions = {}): SpotifyClient {
  const calls: Call[] = [];
  const stub = {
    get: async (path: string, params?: Record<string, string>) => {
      calls.push(params === undefined ? { method: 'GET', path } : { method: 'GET', path, params });
      return opts.getResponse?.(path, params);
    },
    // Both paging seams are fed from the same rows on purpose: the pre-fix
    // code walked via `getAllPages` and the fixed code via
    // `getAllPagesWithTruncation`, so a fixture wired to only one of them
    // would make these tests fail on an EMPTY result rather than on the
    // missing disclosure — a green-for-the-wrong-reason red (#6: a test that
    // cannot fail for the stated reason is worse than no test).
    getAllPages: async (path: string) =>
      opts.getAllPagesResponse?.(path) ?? opts.walk?.items ?? [],
    // The saved/playlist resources report the walk's cap verdict (#718), and
    // the genre heatmap reports its own coverage (#604); this seam hands back
    // a complete walk unless a test supplies a verdict, so the tests below
    // stay about rendering.
    getAllPagesWithTruncation: async (path: string) => {
      const rows = opts.walk?.items ?? opts.getAllPagesResponse?.(path) ?? [];
      return {
        items: rows,
        truncated: opts.walk?.truncated ?? false,
        truncatedByCap: opts.walk?.truncatedByCap ?? false,
        reportedTotal: opts.walk?.reportedTotal ?? null,
        pages: 1,
      };
    },
    getRateLimitStatus: () => ({
      lastThrottleAt: null as number | null,
      retryAfterSec: null as number | null,
      cooldownRemainingMs: 0,
    }),
  };
  // Test seam: registerResources only needs these members of the class.
  return stub as unknown as SpotifyClient;
}

async function connect(stub: SpotifyClient): Promise<Client> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  // #685: the whole read surface, through the same helper `src/index.ts` uses.
  // This file used to register only `registerResources`, which is why the
  // `{+qs}` twins beside those resources were invisible from here.
  registerReadSurfaces(server, stub);
  // Resources ARE registered here, so the prompt surface may name them (#715).
  registerPrompts(server, { resourceHints: true });
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
    'spotify://player/devices',
    'spotify://player/queue',
    'spotify://player/state',
  ]);

  assert.ok(resources.resources.every((resource) => resource.mimeType === 'text/plain'));

  const templates = await client.listResourceTemplates();
  const templateUris = templates.resourceTemplates.map((t) => t.uriTemplate).sort();
  // Every fixed URI has exactly one query-absorbing template. #603 widened the
  // saved-library parameter sets from {?format} to {?format,limit,offset} — the
  // parameterised form that actually documents the set a host may build a URI
  // from. `spotify://me` takes no parameters, so its template is {?format}.
  assert.equal(templateUris.filter((u) => u === 'spotify://me{?format}').length, 1);
  assert.equal(templateUris.filter((u) => u === 'spotify://me/saved/shows{?format,limit,offset}').length, 1);
  assert.equal(templateUris.filter((u) => u === 'spotify://me/top/tracks{?format,time_range,limit,offset}').length, 1);
  // #685: the `{?…}` form-style matcher is the routing mechanism, so the
  // `{+qs}` catch-all that used to sit beside it is gone. #1401's
  // `Rfc6570UriTemplate` reads declared names as an ordered subsequence, so
  // `?limit=5` alone matches without a second registration claiming it.
  assert.equal(templateUris.filter((u) => /\{\+/.test(u)).length, 0, 'a {+qs} catch-all twin is back');
  // …and playlist tracks is one template, not a bare entry plus two twins.
  assert.equal(templateUris.filter((u) => u === 'spotify://playlist/{id}/tracks{?format,offset,limit}').length, 1);
  assert.equal(templateUris.filter((u) => u.startsWith('spotify://playlist/{id}/tracks{')).length, 1);
  // The catalog entity templates arrive through the same harness.
  assert.ok(templateUris.includes('spotify://artist/{id}{?format}'));
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

  // #718: the payload now carries the walk's cap verdict, not just a total.
  const showsJson = firstContent(await client.readResource({ uri: 'spotify://me/saved/shows?format=json' }));
  const shows = JSON.parse(showsJson.text);
  assert.equal(shows.total, 1);
  assert.equal(shows.truncated, false);
  assert.equal(shows.truncation_note, undefined);
  assert.deepEqual(shows.items, [showItem]);

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

// ---------------------------------------------------------- genre heatmap

test('genre-heatmap reports the source and the coverage it actually read (#604)', async () => {
  const client = await connect(makeClientStub({
    walk: {
      items: [
        { id: 'a1', name: 'Radiohead', uri: 'spotify:artist:a1', genres: ['alternative rock', 'art rock'] },
        { id: 'a2', name: 'Portishead', uri: 'spotify:artist:a2', genres: ['trip hop'] },
      ],
    },
  }));

  const prose = firstContent(await client.readResource({ uri: 'spotify://me/genre-heatmap' }));
  // The source is named, so a reader cannot mistake a top-artists sample for
  // the followed-artist set the old description promised.
  assert.match(prose.text, /source: top_artists_sample/);
  assert.match(prose.text, /2 artist\(s\) read/);
  assert.match(prose.text, /not your followed artists/);

  const raw = firstContent(await client.readResource({ uri: 'spotify://me/genre-heatmap?format=json' }));
  const sc = JSON.parse(raw.text);
  assert.equal(sc.source, 'top_artists_sample');
  assert.equal(sc.time_range, 'medium_term');
  assert.equal(sc.artists_counted, 2);
  assert.equal(sc.artists_with_genres, 2);
  assert.equal(sc.artists_unreadable, 0);
  assert.equal(sc.truncated, false);
  assert.deepEqual(sc.genres, { 'alternative rock': 1, 'art rock': 1, 'trip hop': 1 });
  // Nothing unreadable means the omission itself is absent, matching the
  // stats.fm #803 shape rather than emitting an empty list by default.
  assert.equal(sc.unreadable_artists, undefined);
});

test('genre-heatmap reports an artist with no genres field as unreadable, not as zero genres (#604/#804)', async () => {
  const client = await connect(makeClientStub({
    walk: {
      items: [
        { id: 'a1', name: 'Radiohead', uri: 'spotify:artist:a1', genres: ['alternative rock'] },
        // `genres` is deprecated and not in ArtistObject's required set, so a
        // row can arrive without it. That is a row we could not read — NOT an
        // artist Spotify classified as having no genres.
        { id: 'a2', name: 'Nameless Read', uri: 'spotify:artist:a2' },
        // A row that is genuinely genre-less: read, and really zero.
        { id: 'a3', name: 'Truly Unclassified', uri: 'spotify:artist:a3', genres: [] },
      ],
    },
  }));

  const prose = firstContent(await client.readResource({ uri: 'spotify://me/genre-heatmap' }));
  assert.match(prose.text, /1 of 3 artist\(s\) could not be read/);
  assert.match(prose.text, /lower bound/);
  // Named by id as well as name, and carrying the reason.
  assert.match(prose.text, /Nameless Read \(a2\)/);
  assert.match(prose.text, /no genres field/);
  // The genuinely-empty artist is not reported as unreadable: it was read.
  assert.doesNotMatch(prose.text, /Truly Unclassified/);

  const raw = firstContent(await client.readResource({ uri: 'spotify://me/genre-heatmap?format=json' }));
  const sc = JSON.parse(raw.text);
  assert.equal(sc.artists_counted, 3);
  assert.equal(sc.artists_with_genres, 2);
  assert.equal(sc.artists_unreadable, 1);
  assert.deepEqual(sc.unreadable_artists, [
    { id: 'a2', name: 'Nameless Read', reason: 'the API returned this artist with no genres field' },
  ]);
  // The unreadable row contributed no genre, and the readable one did.
  assert.deepEqual(sc.genres, { 'alternative rock': 1 });
});

test('genre-heatmap names an unreadable artist by id when its name is missing too (#804)', async () => {
  const client = await connect(makeClientStub({
    walk: { items: [{ id: 'a9', uri: 'spotify:artist:a9' }] },
  }));

  const raw = firstContent(await client.readResource({ uri: 'spotify://me/genre-heatmap?format=json' }));
  const sc = JSON.parse(raw.text);
  assert.deepEqual(sc.unreadable_artists, [
    { id: 'a9', name: null, reason: 'the API returned this artist with no genres field' },
  ]);

  // The prose must still identify the row; the id cannot itself be wrong.
  const prose = firstContent(await client.readResource({ uri: 'spotify://me/genre-heatmap' }));
  assert.match(prose.text, /a9 \(a9\)/);
});

test('genre-heatmap says so when every artist in the sample is unreadable (#604)', async () => {
  const client = await connect(makeClientStub({
    walk: { items: [{ id: 'a1', name: 'One', uri: 'spotify:artist:a1' }] },
  }));

  const prose = firstContent(await client.readResource({ uri: 'spotify://me/genre-heatmap' }));
  // The old code rendered this as "No genre data available." — indistinguishable
  // from a user who genuinely has no genre tags, which is the #803 mistake.
  assert.doesNotMatch(prose.text, /No genre data available/);
  assert.match(prose.text, /no genre was returned for any artist in this sample/);
  assert.match(prose.text, /1 of 1 artist\(s\) could not be read/);
});

test('genre-heatmap reports a truncated walk instead of implying full coverage (#604/#864)', async () => {
  const capped = await connect(makeClientStub({
    walk: {
      items: [{ id: 'a1', name: 'Radiohead', uri: 'spotify:artist:a1', genres: ['art rock'] }],
      truncated: true,
      truncatedByCap: true,
      reportedTotal: 180,
    },
  }));
  const prose = firstContent(await capped.readResource({ uri: 'spotify://me/genre-heatmap' }));
  assert.match(prose.text, /truncated at 50 artists/);
  assert.match(prose.text, /get_top_artists with offset/);

  // Short of a reported total WITHOUT the cap binding: naming the cap there
  // would blame a ceiling that never applied.
  const short = await connect(makeClientStub({
    walk: {
      items: [{ id: 'a1', name: 'Radiohead', uri: 'spotify:artist:a1', genres: ['art rock'] }],
      truncated: true,
      truncatedByCap: false,
      reportedTotal: 180,
    },
  }));
  const shortProse = firstContent(await short.readResource({ uri: 'spotify://me/genre-heatmap' }));
  assert.match(shortProse.text, /the API reports 180 artists and this walk read 1/);
  assert.doesNotMatch(shortProse.text, /truncated at 50/);
});

test('genre-heatmap no longer claims a followed_artists sidecar it never read (#604)', async () => {
  const client = await connect(makeClientStub());
  const resources = await client.listResources();
  const heatmap = resources.resources.find((r) => r.uri === 'spotify://me/genre-heatmap');
  assert.ok(heatmap, 'genre-heatmap resource is registered');
  // The description promised a sidecar source that no code path reads, which
  // is the coverage promise #604 exists to remove.
  assert.doesNotMatch(heatmap.description, /sidecar/);
  assert.doesNotMatch(heatmap.description, /followed_artists/);
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

// The tool-name allow-list is DERIVED, not written down (#670). This used to
// be a 91-name hand-copy of src/tools/*, which failed in both directions at
// once: a tool deleted from the registry kept passing because its name was
// still in the copy, and a prompt naming any of the other 501 live tools
// failed spuriously because nobody remembered to add it. `promptSurface()`
// registers the real manifest and reads the names back off the registry, so
// adding or removing a tool needs no edit here at all.
test('every prompt only references tool names that are actually registered (#670)', async () => {
  const surface = await promptSurface();
  const unknown = findUnknownPromptTools(surface);
  assert.deepEqual(
    unknown,
    [],
    `prompts reference tools that are not registered:\n${unknown.join('\n')}`,
  );
});

test('the prompt allow-list is the live registry, not a copy of it (#670)', async () => {
  // Nothing below is edited when a tool is added or removed; the assertions
  // exist to fail if someone reintroduces a written-down list.
  const surface = await promptSurface();
  const referenced = new Set(
    [...surface.prompts.values()].flatMap((body) => extractBody(body).bareTools),
  );

  // 1. It is the WHOLE registry, not a list scoped to what prompts happen to
  //    use. Prompts name 28 tools against a 592-tool registry; the hand-copy
  //    this replaced held 91 names, so it cleared this ratio by a factor of
  //    three while still rejecting 501 legitimate tool references. Derived
  //    from the pass rather than typed, so it cannot itself go stale.
  assert.ok(
    referenced.size > 0, 'prompts should name some tools, or this gate proves nothing');
  assert.ok(
    referenced.size < surface.toolSchemas.size / 4,
    `prompts name ${referenced.size} tools but the derived allow-list has ${surface.toolSchemas.size}; ` +
    'an allow-list narrowed to prompt usage (or a hand-copy padded to just cover them) is a copy again',
  );

  // 2. ADDING a tool needs no hand edit. A synthetic registrar joins the same
  //    pass; a hand-maintained table has no way to learn about it.
  const withExtra = await promptSurface({
    extra: (server) => {
      server.tool(
        'w670_synthetic_probe',
        'A tool that exists only for this test.',
        { query: z.string().describe('search text') },
        async () => ({ content: [] }),
      );
    },
  });
  assert.ok(
    withExtra.toolSchemas.has('w670_synthetic_probe'),
    'a tool added to the registry must appear in the derived allow-list with no hand edit',
  );
  assert.ok(
    !surface.toolSchemas.has('w670_synthetic_probe'),
    'the synthetic tool must not leak into the un-augmented pass',
  );
  // ...and a prompt naming it is then accepted, end to end.
  const probeSurface: PromptSurface = {
    ...withExtra,
    prompts: new Map([['w670_probe_prompt', 'Call w670_synthetic_probe (query="x") to start.']]),
  };
  assert.deepEqual(findUnknownPromptTools(probeSurface), []);

  // 3. REMOVING a tool a prompt names is reported, naming prompt and tool.
  //    Which module to drop, and which of its tools prompts name, is worked
  //    out from the registry rather than written down — so this still means
  //    something after a tool moves.
  const analyticsOwns = new Set(moduleToolNames(await buildFullRegistryServer(), 'analytics'));
  const promptNamed = [...analyticsOwns].filter((name) => referenced.has(name));
  assert.ok(
    promptNamed.length > 0,
    'expected the analytics module to own at least one tool that a prompt names; ' +
    'if those tools moved, point this test at the module that now owns them',
  );

  const withoutAnalytics = await promptSurface({ skipModules: ['analytics'] });
  const missing = findUnknownPromptTools(withoutAnalytics);
  for (const tool of promptNamed) {
    const expected = [...surface.prompts]
      .filter(([, body]) => extractBody(body).bareTools.includes(tool))
      .map(([name]) => `${name}: unknown tool '${tool}'`);
    for (const line of expected) {
      assert.ok(missing.includes(line), `dropping the analytics module must report "${line}"; got:\n${missing.join('\n')}`);
    }
  }
  // ...and the same tools are present, unreported, in the un-skipped pass.
  assert.deepEqual(findUnknownPromptTools(surface), []);
});

test('a prompt argument the tool does not declare is reported (#670)', async () => {
  const surface = await promptSurface();
  const declared = new Set(
    [...surface.prompts.values()].flatMap((body) => extractBody(body).calls.flatMap((c) => c.args)),
  );
  // Without this the assertion below passes on a parser that matched nothing.
  assert.ok(declared.size >= 4, `expected call-form argument matches across prompts, saw ${declared.size}`);

  // show_new_episodes takes days/per_show_limit/max_shows; `since` was the
  // invented name podcast_catchup used before #716. Feed the gate a prompt
  // that makes the mistake and it has to name tool, parameter and prompt.
  const broken: PromptSurface = {
    ...surface,
    prompts: new Map([['podcast_catchup', 'Call show_new_episodes (since=7) first.']]),
  };
  const bad = findUndeclaredPromptArgs(broken);
  assert.deepEqual(
    bad,
    ["podcast_catchup: show_new_episodes(since=…) — 'since' not in show_new_episodes schema"],
  );
  // The real prompts pass the same check.
  assert.deepEqual(findUndeclaredPromptArgs(surface), []);
});

// #639: this previously asserted that a publisherless show is labelled
// `unknown publisher`. That string is a stand-in press name — it reads
// exactly like a show published by somebody called "unknown publisher" — and
// in the tools that GROUP by publisher it became a census bucket holding every
// show a current registration could read. What replaces it is an omission PLUS
// a stated reason, so a reader who sees no byline knows the field is gone
// rather than guessing this server dropped it. The second case is the control:
// a grandfathered registration that still sends `publisher` keeps its byline,
// because a real name is not the problem being fixed.
test('saved-shows resource omits an absent publisher and says why, keeping a real one', async () => {
  const showItem = {
    added_at: '2026-02-02T00:00:00Z',
    show: {
      id: 'shw9', name: 'Publisherless Show', uri: 'spotify:show:shw9',
      description: '', total_episodes: 4,
    },
  };
  const namedItem = {
    added_at: '2026-02-03T00:00:00Z',
    show: {
      id: 'shw8', name: 'Named Show', uri: 'spotify:show:shw8',
      description: '', total_episodes: 9, publisher: 'Wondery',
    },
  };
  const client = await connect(makeClientStub({
    getAllPagesResponse: (path) => (path === '/me/shows' ? [showItem, namedItem] : []),
  }));

  const shows = firstContent(await client.readResource({ uri: 'spotify://me/saved/shows' }));
  assert.doesNotMatch(shows.text, /unknown publisher/, 'no stand-in press name');
  assert.match(shows.text, /"Publisherless Show" \(4 episodes/, 'the absent byline is simply absent');
  assert.match(shows.text, /"Named Show" by Wondery \(9 episodes/, 'a real publisher is still printed');
  assert.match(shows.text, /1 of 2 show\(s\) carry no byline/, 'the omission is accounted for');
  assert.match(shows.text, /February 2026/, 'and the reason is the platform, not this server');
});
