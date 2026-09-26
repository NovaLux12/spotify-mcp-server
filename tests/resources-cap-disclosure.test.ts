/**
 * #718 — the saved-library and followed-artist resources walk pages up to
 * SPOTIFY_MCP_FETCH_ALL_CAP and then rendered the capped array length as the
 * library total, with no truncation signal in either the prose or the JSON
 * payload. A consumer could not tell a 2-item read from a capped one.
 *
 * These tests drive the REAL SpotifyClient (only globalThis.fetch is stubbed)
 * so the cap verdict, the page walk and the rendered payload are production
 * code, then assert:
 *
 *   - a capped walk says so in prose and in JSON, and names the reader tool
 *   - a walk that finished claims nothing
 *   - spotify://me/playlists reports the API's total, not the walked count
 *   - a total nobody reported stays unknown rather than becoming the row count
 *   - the follower's advice names only controls the named tool actually
 *     accepts, checked against the live registered inputSchema (#919)
 *
 * Run with: node --import tsx --test tests/resources-cap-disclosure.test.ts
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

// ---------------------------------------------------------------------------
// The dynamic imports below are load-bearing, not a style choice: src/auth.ts
// binds SPOTIFY_MCP_TOKEN_FILE at module load, so the env must land first (the
// same seam tests/client.test.ts documents).
// ---------------------------------------------------------------------------

const CAP = 2;
const tokenDir = await mkdtemp(path.join(tmpdir(), 'spotify-mcp-cap-test-'));
process.env.SPOTIFY_MCP_TOKEN_FILE = path.join(tokenDir, 'tokens.json');
process.env.SPOTIFY_CLIENT_ID = 'test-client-id';
process.env.SPOTIFY_MCP_FETCH_ALL_CAP = String(CAP);

const { SpotifyClient } = await import('../src/client.ts');
const { initConfig } = await import('../src/config.ts');
const { registerResources } = await import('../src/resources/index.ts');
const { registerLibraryTools } = await import('../src/tools/library.ts');
const { registerPlaylistTools } = await import('../src/tools/playlists.ts');
const { registerAudiobookTools } = await import('../src/tools/audiobooks.ts');
const { registerFollowingTools } = await import('../src/tools/following.ts');
// The follower walk's real page size, so the cursor fixture returns a FULL
// page (a truncated cursor walk is a full page plus a live cursor, not a
// short one) and the cap below is a cap the walk really hits.
const { CHUNK_CAPS } = await import('../src/chunk.ts');
const FOLLOWED_PAGE_LIMIT = CHUNK_CAPS.followed;
const { Client: McpClient } = await import('@modelcontextprotocol/sdk/client/index.js');
const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

initConfig();

const realFetch = globalThis.fetch;
type Responder = (requestPath: string) => unknown;
let responder: Responder = () => ({ items: [], total: 0, limit: 50, offset: 0, next: null });

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// ------------------------------------------------------------------ fixtures

const savedAlbum = (n: number) => ({
  added_at: '2026-01-01T00:00:00Z',
  album: {
    id: `alb${n}`,
    name: `Album ${n}`,
    uri: `spotify:album:alb${n}`,
    release_date: '1999-01-01',
    total_tracks: 10,
    artists: [{ id: 'a1', name: 'Artist', uri: 'spotify:artist:a1' }],
  },
});
const savedShow = (n: number) => ({
  added_at: '2026-01-01T00:00:00Z',
  show: {
    id: `shw${n}`,
    name: `Show ${n}`,
    uri: `spotify:show:shw${n}`,
    publisher: 'Publisher',
    total_episodes: 5,
  },
});
const savedEpisode = (n: number) => ({
  added_at: '2026-01-01T00:00:00Z',
  episode: {
    id: `ep${n}`,
    name: `Episode ${n}`,
    uri: `spotify:episode:ep${n}`,
    duration_ms: 1_800_000,
    release_date: '2026-01-01T00:00:00Z',
    show: { id: 'shw1', name: 'Show', uri: 'spotify:show:shw1' },
  },
});
const savedAudiobook = (n: number) => ({
  added_at: '2026-01-01T00:00:00Z',
  audiobook: {
    id: `ab${n}`,
    name: `Audiobook ${n}`,
    uri: `spotify:audiobook:ab${n}`,
    authors: [{ name: 'Author' }],
  },
});
const userPlaylist = (n: number) => ({
  id: `pl${n}`,
  name: `Playlist ${n}`,
  uri: `spotify:playlist:pl${n}`,
  items: { total: 3 },
});
const followedArtist = (n: number) => ({
  id: `art${n}`,
  name: `Artist ${n}`,
  uri: `spotify:artist:art${n}`,
  genres: ['rock'],
});

/** Resource URI -> the API path it walks and a row factory for that shape. */
const CAPPED_RESOURCES: Array<{ uri: string; path: string; row: (n: number) => unknown }> = [
  { uri: 'spotify://me/playlists', path: '/me/playlists', row: userPlaylist },
  { uri: 'spotify://me/saved/albums', path: '/me/albums', row: savedAlbum },
  { uri: 'spotify://me/saved/shows', path: '/me/shows', row: savedShow },
  { uri: 'spotify://me/saved/episodes', path: '/me/episodes', row: savedEpisode },
  { uri: 'spotify://me/saved/audiobooks', path: '/me/audiobooks', row: savedAudiobook },
  { uri: 'spotify://me/followed/artists', path: '/me/following', row: followedArtist },
];

/**
 * A capped walk on every endpoint, each shaped the way its own API actually
 * truncates. The offset-paged endpoints hand back one page of `rows` with a
 * `total` to match, so a cap below `rows` truncates them. `/me/following`
 * pages by cursor instead, so a capped walk there means a FULL page plus a
 * live cursor — a short page is that endpoint's end-of-data signal, and
 * faking one with a cursor would test a walk that ended early rather than one
 * the cap stopped.
 */
function cappedResponder(rows: number): Responder {
  return (requestPath) => {
    if (requestPath === '/me/following') {
      return {
        artists: {
          items: Array.from({ length: FOLLOWED_PAGE_LIMIT }, (_, i) => followedArtist(i)),
          total: FOLLOWED_PAGE_LIMIT * 4,
          cursors: { after: 'cursor-1' },
          next: 'https://api.spotify.com/v1/me/following?after=cursor-1',
        },
      };
    }
    const resource = CAPPED_RESOURCES.find((entry) => entry.path === requestPath);
    return {
      items: Array.from({ length: rows }, (_, i) => resource!.row(i)),
      total: rows,
      limit: 50,
      offset: 0,
      next: null,
    };
  };
}

/** A walk that reached the end of the data on every endpoint. */
function completeResponder(rows: number): Responder {
  return (requestPath) => {
    if (requestPath === '/me/following') {
      return {
        artists: {
          items: Array.from({ length: rows }, (_, i) => followedArtist(i)),
          total: rows,
          cursors: null,
          next: null,
        },
      };
    }
    const resource = CAPPED_RESOURCES.find((entry) => entry.path === requestPath);
    return {
      items: Array.from({ length: rows }, (_, i) => resource!.row(i)),
      total: rows,
      limit: 50,
      offset: 0,
      next: null,
    };
  };
}
/** The client prefixes every call with the API version; the fixtures are not. */
function requestPathOf(url: string): string {
  return new URL(url).pathname.replace(/^\/v1/, '');
}

async function connect(): Promise<Client> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const client = new SpotifyClient();
  registerResources(server, client);
  // The reader tools whose schemas the footer's advice is checked against.
  registerLibraryTools(server, client);
  registerPlaylistTools(server, client);
  registerAudiobookTools(server, client);
  registerFollowingTools(server, client);
  const mcp = new McpClient({ name: 'tester', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(clientTransport), mcp.connect(serverTransport)]);
  return mcp;
}

async function read(mcp: Client, uri: string): Promise<string> {
  const res = await mcp.readResource({ uri });
  // Every resource rendered here is text or JSON text, never a blob.
  const first = res.contents[0] as { text?: string } | undefined;
  return first?.text ?? '';
}

before(async () => {
  await writeFile(
    process.env.SPOTIFY_MCP_TOKEN_FILE!,
    JSON.stringify({ access_token: 'tok', refresh_token: 'ref', expires_at: Date.now() + 3_600_000 }),
    'utf8',
  );
});

beforeEach(() => {
  globalThis.fetch = (async (url: unknown) =>
    jsonResponse(responder(requestPathOf(String(url))))) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  return rm(tokenDir, { recursive: true, force: true });
});

// -------------------------------------------------------------------- tests

test('a walk stopped at SPOTIFY_MCP_FETCH_ALL_CAP discloses it in prose and JSON', async () => {
  responder = cappedResponder(CAP + 1);
  const mcp = await connect();

  for (const { uri } of CAPPED_RESOURCES) {
    const prose = await read(mcp, uri);
    assert.match(prose, /truncated at SPOTIFY_MCP_FETCH_ALL_CAP \(2\)/, `${uri} prose must disclose the cap`);
    assert.doesNotMatch(prose, /\(2 total\)/, `${uri} must not present the capped row count as a total`);

    const payload = JSON.parse(await read(mcp, `${uri}?format=json`));
    assert.equal(payload.truncated, true, `${uri} JSON must set truncated`);
    assert.equal(payload.cap, CAP, `${uri} JSON must name the cap`);
    assert.equal(payload.items.length, CAP, `${uri} returns exactly the capped rows`);
    assert.match(payload.truncation_note, /truncated at SPOTIFY_MCP_FETCH_ALL_CAP \(2\)/);
  }
});

test('a walk that reached the end claims no truncation anywhere', async () => {
  responder = completeResponder(1);
  const mcp = await connect();

  for (const { uri } of CAPPED_RESOURCES) {
    const prose = await read(mcp, uri);
    assert.doesNotMatch(prose, /truncated/, `${uri} prose must stay silent on a complete walk`);

    const payload = JSON.parse(await read(mcp, `${uri}?format=json`));
    assert.equal(payload.truncated, false, `${uri} JSON must report a complete walk`);
    assert.equal(payload.truncation_note, undefined, `${uri} JSON carries no truncation note`);
    assert.equal(payload.total, 1, `${uri} total is the API-reported count when nothing was dropped`);
  }
});

test('a walk that stopped exactly on the cap, having read everything, is not truncation', async () => {
  // Every endpoint reports total === cap and ends its data there, so the cap
  // bounded the walk and the library at the same time: nothing was dropped,
  // and claiming truncation would invent a fact the API did not report. The
  // cursor walk is in this test too, and it agrees: a short page with no
  // cursor is that endpoint's end-of-data signal, so an exhausted follow list
  // of exactly `cap` rows is complete. `items.length === cap` proves nothing
  // about whether rows are missing — the walk's own exit reason does.
  responder = completeResponder(CAP);
  const mcp = await connect();

  for (const { uri } of CAPPED_RESOURCES) {
    const payload = JSON.parse(await read(mcp, `${uri}?format=json`));
    assert.equal(payload.truncated, false, `${uri} read every row the API reported`);
    assert.equal(payload.total, CAP, `${uri} reports the API total, not a guessed one`);
    assert.equal(payload.truncation_note, undefined, `${uri} discloses nothing when nothing was dropped`);
  }
});

test('a complete follow list of exactly cap rows is not truncation, and says so', async () => {
  // The array-length heuristic this replaces called this walk truncated:
  // `items.length >= cap` fires on a follow list that ENDS at the cap. Nothing
  // was dropped and the cursor is exhausted, so "truncated ... for the rest"
  // would point at a rest that does not exist.
  responder = completeResponder(CAP);
  const mcp = await connect();

  const payload = JSON.parse(await read(mcp, 'spotify://me/followed/artists?format=json'));
  assert.equal(payload.items.length, CAP, 'precondition: the walk collected exactly cap rows');
  assert.equal(payload.truncated, false, 'an exhausted follow list of exactly cap rows is complete');
  assert.equal(payload.total, CAP, 'and it reports the count the API reported');

  const prose = await read(mcp, 'spotify://me/followed/artists');
  assert.doesNotMatch(prose, /for the rest/, 'there is no rest to point a reader at');
  assert.doesNotMatch(prose, /truncated/, `${prose}`);
  assert.match(prose, /Followed artists \(2 total\):/);
});

test('spotify://me/playlists reports the API total, not the capped row count', async () => {
  responder = (requestPath) =>
    requestPath === '/me/playlists'
      ? { items: [userPlaylist(0), userPlaylist(1), userPlaylist(2)], total: 7, limit: 50, offset: 0, next: null }
      : { items: [], total: 0, limit: 50, offset: 0, next: null };
  const mcp = await connect();

  const payload = JSON.parse(await read(mcp, 'spotify://me/playlists?format=json'));
  assert.equal(payload.items.length, CAP);
  assert.equal(payload.total, 7, 'the API-reported total outranks the walked count');
  assert.equal(payload.truncated, true);

  const prose = await read(mcp, 'spotify://me/playlists');
  assert.match(prose, /Playlists \(7 total, showing 2\)/);
});

test('an unreadable API total stays unknown on every capped resource, not just one', async () => {
  // The walk hits the cap and NO endpoint reports a total. This is the
  // headline invariant, and it is per-resource: the three bespoke paths
  // (playlists' separate first-page read, the audiobooks error-gated walk,
  // and the shared saved-library helper) each compute their own `total`, so
  // one of them can be reverted to the walked count without CI noticing.
  // Every entry in CAPPED_RESOURCES is walked here, not one hand-picked URI.
  responder = (requestPath) => {
    if (requestPath === '/me/following') {
      return {
        artists: {
          items: Array.from({ length: FOLLOWED_PAGE_LIMIT }, (_, i) => followedArtist(i)),
          cursors: { after: 'cursor-1' },
          next: 'https://api.spotify.com/v1/me/following?after=cursor-1',
        },
      };
    }
    const resource = CAPPED_RESOURCES.find((entry) => entry.path === requestPath);
    return {
      items: Array.from({ length: CAP + 1 }, (_, i) => resource!.row(i)),
      limit: 50,
      offset: 0,
      next: null,
    };
  };
  const mcp = await connect();

  for (const { uri } of CAPPED_RESOURCES) {
    const payload = JSON.parse(await read(mcp, `${uri}?format=json`));
    assert.equal(payload.truncated, true, `precondition: ${uri} walk hit the cap`);
    assert.equal(
      payload.total,
      null,
      `${uri} reported no total and was truncated, so total must be null — not the ${payload.items.length} rows walked`,
    );
  }
});

test('a walk short of the API-reported total is not complete, and does not blame the cap', async () => {
  // Page 1 is full (50 rows, total 500), page 2 is short. The walk ends on the
  // short page, which is the normal end-of-data signal — but the server's own
  // `total` says 500 playlists exist and the walk read 52. `truncated: false`
  // there would tell a consumer it read everything, and naming the cap as the
  // cause would blame a ceiling that never bound the walk.
  let first = true;
  responder = (requestPath) => {
    if (requestPath !== '/me/playlists') return { items: [], total: 0, limit: 50, offset: 0, next: null };
    if (first) {
      first = false;
      return {
        items: Array.from({ length: 50 }, (_, i) => userPlaylist(i)),
        total: 500,
        limit: 50,
        offset: 0,
        next: 'https://api.spotify.com/v1/me/playlists?offset=50',
      };
    }
    return {
      items: Array.from({ length: 2 }, (_, i) => userPlaylist(50 + i)),
      total: 500,
      limit: 50,
      offset: 50,
      next: null,
    };
  };
  // A cap high enough that the walk is bounded by the short page, not the cap.
  initConfig({ ...process.env, SPOTIFY_MCP_FETCH_ALL_CAP: '500' });
  try {
    const mcp = await connect();

    const payload = JSON.parse(await read(mcp, 'spotify://me/playlists?format=json'));
    assert.equal(payload.items.length, 52, 'precondition: the walk collected 52 of 500');
    assert.equal(payload.total, 500, 'the API-reported total still outranks the walked count');
    assert.equal(payload.truncated, true, 'a walk short of the reported total is not a complete read');
    assert.match(payload.truncation_note, /incomplete: the API reports 500 and this walk read 52/);
    assert.doesNotMatch(payload.truncation_note, /SPOTIFY_MCP_FETCH_ALL_CAP/, 'the cap never bound this walk');

    const prose = await read(mcp, 'spotify://me/playlists');
    assert.match(prose, /Playlists \(500 total, showing 52\)/);
    assert.match(prose, /incomplete: the API reports 500/);
  } finally {
    initConfig();
  }
});

/** Advice phrase -> the inputSchema property it refers to (truncationAdvice). */
const ADVICE_TO_PARAMETER: Record<string, string> = {
  'raise max_results': 'max_results',
  'raise max_items': 'max_items',
  'continue with offset': 'offset',
  'set fetch_all': 'fetch_all',
  'raise scan_cap': 'scan_cap',
  'raise limit': 'limit',
};

test('every capped resource names its reader tool, and only controls that tool accepts', async () => {
  responder = cappedResponder(CAP + 1);
  const mcp = await connect();
  const tools = (await mcp.listTools()).tools;

  for (const { uri } of CAPPED_RESOURCES) {
    const prose = await read(mcp, uri);
    const named = /use (\w+) for the rest: (.+)$/m.exec(prose);
    assert.ok(named, `${uri} must name the reader tool and the advice`);
    const [, toolName, advice] = named;

    const tool = tools.find((entry) => entry.name === toolName);
    assert.ok(tool, `${uri} names ${toolName}, which is not a registered tool`);
    const properties = Object.keys(
      (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
    );
    assert.ok(properties.length > 0, `${toolName} exposes no input schema properties`);

    for (const phrase of advice!.split(', ')) {
      const parameter = ADVICE_TO_PARAMETER[phrase];
      assert.ok(parameter, `${uri} gave unrecognised advice ${JSON.stringify(phrase)}`);
      assert.ok(
        properties.includes(parameter),
        `${uri} advises "${phrase}" but ${toolName} does not accept ${parameter}`,
      );
    }
  }
});
