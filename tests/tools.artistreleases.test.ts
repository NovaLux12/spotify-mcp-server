/**
 * One canonical artist-release probe (#900).
 *
 * Before the fix, five tools asked "what is new from this artist?" with five
 * different request spellings — `limit` 5 in three discovery call sites,
 * `limit` 10 with no `include_groups` in `whats_new` — and the read cache keys
 * on the whole request target, so none of them could ever share an entry. One
 * session running `whats_new` and `artistwatch_new_additions` over the same
 * artist spent two requests to derive one answer.
 *
 * These tests run the real `SpotifyClient` against a counting fetch stub, so
 * the TTL cache is genuinely in the path — a stub client with no cache would
 * let a non-shared helper pass.
 *
 * Run with: node --import tsx --test tests/tools.artistreleases.test.ts
 *
 * NOTE: TOKEN_FILE is resolved at module-load time inside src/auth.ts, so the
 * env vars MUST be set before the dynamic imports below.
 */
import './helpers/hermetic.js';

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const stateDir = await mkdtemp(path.join(tmpdir(), 'spotify-mcp-900-'));
process.env.SPOTIFY_MCP_TOKEN_FILE = path.join(stateDir, 'tokens.json');
process.env.SPOTIFY_CLIENT_ID = 'test-client-id';
// Keep the watermark out of the real home directory.
process.env.SPOTIFY_MCP_FRESHNESS_STATE = path.join(stateDir, 'freshness.json');
process.env.SPOTIFY_MCP_READONLY = '';

const { SpotifyClient } = await import('../src/client.ts');
const { TOKEN_FILE } = await import('../src/auth.ts');
const { LruTtlCache, cacheKey } = await import('../src/cache.ts');
const {
  probeArtistReleases,
  artistReleaseProbeUrl,
  artistReleaseProbePath,
  artistReleaseProbeParams,
  ARTIST_RELEASE_PROBE_LIMIT,
  ARTIST_RELEASE_PROBE_GROUPS,
} = await import('../src/artistreleases.ts');
const { registerFreshnessTools } = await import('../src/tools/freshness.ts');
const { registerSwarm3DiscoveryTools } = await import('../src/tools/swarm3_discovery.ts');
const { initConfig } = await import('../src/config.ts');

initConfig(process.env);

const realFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = realFetch;
  await rm(stateDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Harness: a real client over a counting fetch stub
// ---------------------------------------------------------------------------

type Responder = (url: URL) => { status?: number; body: unknown };

let fetchUrls: string[] = [];
let respond: Responder = () => ({ body: { items: [] } });

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** A 200 with an ETag absent, so nothing here can be answered by a 304. */
function installFetch(): void {
  globalThis.fetch = (async (input: unknown) => {
    const href = String(input);
    fetchUrls.push(href);
    const { status = 200, body } = respond(new URL(href));
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

beforeEach(async () => {
  fetchUrls = [];
  respond = () => ({ body: { items: [] } });
  await writeFile(
    TOKEN_FILE,
    JSON.stringify({ access_token: 'tok', refresh_token: 'ref', expires_at: Date.now() + 3_600_000 }),
    'utf8',
  );
  installFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Fetches of one API path, ignoring the query. */
const fetchesOf = (apiPath: string): string[] =>
  fetchUrls.filter((href) => new URL(href).pathname === `/v1${apiPath}`);

// ---------------------------------------------------------------------------
// Tool harness
// ---------------------------------------------------------------------------

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent: Record<string, unknown>;
}
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

/**
 * Register the two probe-heavy modules over ONE client, so a probe filled by
 * one tool is visible to the next. Registering them separately is what hides
 * the duplication the issue is about.
 */
function harness(client: SpotifyClient): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const server = {
    tool(name: string, _d: string, schema: unknown, handler: Handler) {
      handlers.set(name, async (args) => {
        const parsed = typeof (schema as z.ZodType).parse === 'function'
          ? (schema as z.ZodType).parse(args)
          : z.object(schema as z.ZodRawShape).parse(args);
        return (await handler(parsed as Record<string, unknown>)) as ToolResult;
      });
    },
    registerTool(name: string, config: { inputSchema?: z.ZodType }, handler: Handler) {
      handlers.set(name, async (args) => {
        const parsed = config.inputSchema ? config.inputSchema.parse(args) : args;
        return (await handler(parsed as Record<string, unknown>)) as ToolResult;
      });
    },
  } as unknown as McpServer;
  registerFreshnessTools(server, client);
  registerSwarm3DiscoveryTools(server, client);
  return handlers;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ARTIST_A = 'artistAAA0000000001';
const ARTIST_B = 'artistBBB0000000002';

const releasePage = (artistId: string, latestDate: string) => ({
  items: [
    {
      id: `rel-${artistId}-${latestDate}`,
      name: `Newest ${artistId}`,
      release_date: latestDate,
      album_type: 'album',
      uri: `spotify:album:rel-${artistId}-${latestDate}`,
      artists: [{ id: artistId, name: `Artist ${artistId}` }],
    },
    {
      id: `rel-${artistId}-old`,
      name: `Older ${artistId}`,
      release_date: '2019-01-01',
      album_type: 'single',
      uri: `spotify:album:rel-${artistId}-old`,
      artists: [{ id: artistId, name: `Artist ${artistId}` }],
    },
  ],
  total: 2,
  limit: ARTIST_RELEASE_PROBE_LIMIT,
  offset: 0,
  next: null,
});

const followedPage = (ids: string[]) => ({
  artists: {
    items: ids.map((id) => ({ id, name: `Artist ${id}`, uri: `spotify:artist:${id}`, genres: [] })),
    total: ids.length,
    cursors: { after: null },
    next: null,
  },
});

function respondFor(artists: Array<[string, string]>, followed: string[] = artists.map(([id]) => id)): Responder {
  return (url) => {
    const followMatch = url.pathname === '/v1/me/following';
    if (followMatch) return { body: followedPage(followed) };
    const albumMatch = url.pathname.match(/^\/v1\/artists\/([^/]+)\/albums$/);
    if (albumMatch) {
      const found = artists.find(([id]) => id === decodeURIComponent(albumMatch[1]!));
      if (!found) return { status: 404, body: { error: { message: 'not found' } } };
      return { body: releasePage(found[0], found[1]) };
    }
    if (url.pathname === '/v1/me/top/artists') {
      return { body: { items: followed.map((id) => ({ id, name: `Artist ${id}`, genres: [] })) } };
    }
    if (url.pathname === '/v1/search') {
      return { body: { artists: { items: followed.map((id) => ({ id, name: `Artist ${id}`, genres: [] })), total: followed.length } } };
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
}

/**
 * Run one tool on a client with its own cold cache, and return the probe URLs
 * that reached the wire for ARTIST_A. Each call site must be observed on its
 * own request, which a shared client would hide behind the cache.
 */
async function runIsolated(run: (client: SpotifyClient) => Promise<ToolResult>): Promise<string[]> {
  const client = new SpotifyClient();
  await run(client);
  return fetchUrls
    .filter((href) => new URL(href).pathname === `/v1/artists/${ARTIST_A}/albums`)
    // The stub captures the absolute API URL; artistReleaseProbeUrl is the
    // API-relative form the cache keys on. Drop the /v1 base to compare them.
    .map((href) => {
      const url = new URL(href);
      return `${url.pathname.slice('/v1'.length)}${url.search}`;
    });
}

// ---------------------------------------------------------------------------
// The canonical request itself
// ---------------------------------------------------------------------------

describe('canonical artist-release probe: the request (#900)', () => {
  it('is the live endpoint, at the schema limit, and byte-identical for a given artist', () => {
    // GET /artists/{id}/albums, verified against the Feb-2026 OpenAPI schema:
    // not deprecated, with a documented `limit` maximum of 10. /artists/{id}/
    // top-tracks is a different endpoint and is not used here.
    assert.equal(artistReleaseProbePath(ARTIST_A), `/artists/${ARTIST_A}/albums`);
    assert.equal(ARTIST_RELEASE_PROBE_LIMIT, 10);
    assert.deepEqual(artistReleaseProbeParams(), { include_groups: ARTIST_RELEASE_PROBE_GROUPS, limit: '10' });
    assert.equal(
      artistReleaseProbeUrl(ARTIST_A),
      `/artists/${ARTIST_A}/albums?include_groups=album%2Csingle&limit=10`,
    );
    // Byte-identical across repeat builds — nothing about the probe varies
    // with the caller.
    assert.equal(artistReleaseProbeUrl(ARTIST_A), artistReleaseProbeUrl(ARTIST_A));
    // The id is in the path, so a different artist is a different request.
    assert.notEqual(artistReleaseProbeUrl(ARTIST_A), artistReleaseProbeUrl(ARTIST_B));
  });

  it('a caller that wants fewer rows trims in memory, not on the wire', async () => {
    const client = new SpotifyClient();
    respond = respondFor([[ARTIST_A, '2026-09-01']]);

    const full = await probeArtistReleases(client, ARTIST_A);
    const trimmed = await probeArtistReleases(client, ARTIST_A, { rows: 1 });

    assert.equal(full.items.length, 2);
    assert.equal(trimmed.items.length, 1);
    // One request, and it carried the canonical limit — a limit=1 on the wire
    // would be a second cache key and would have issued a second fetch.
    assert.equal(fetchesOf(`/artists/${ARTIST_A}/albums`).length, 1);
    assert.equal(new URL(fetchesOf(`/artists/${ARTIST_A}/albums`)[0]!).searchParams.get('limit'), '10');
    assert.equal(full.fromCache, false, 'the first read is a miss');
    assert.equal(trimmed.fromCache, true, 'the second read is the same entry, served');
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 1: two tools, one request
// ---------------------------------------------------------------------------

describe('canonical artist-release probe: shared across tools (#900)', () => {
  it('whats_new then artistwatch_new_additions over one artist issues ONE /artists/{id}/albums request', async () => {
    const client = new SpotifyClient();
    respond = respondFor([[ARTIST_A, '2026-09-20'], [ARTIST_B, '2026-09-19']]);
    const h = harness(client);

    await h.get('whats_new')!({ days_back: 60, kinds: ['albums'], max_artists: 5 });
    const afterFreshness = fetchesOf(`/artists/${ARTIST_A}/albums`).length;
    assert.equal(afterFreshness, 1, 'whats_new probes each followed artist once');

    await h.get('artistwatch_new_additions')!({ days: 365, artists_cap: 5 });

    // The acceptance criterion: the second tool spends no request on an artist
    // the first one already probed.
    assert.equal(
      fetchesOf(`/artists/${ARTIST_A}/albums`).length,
      1,
      `artistwatch_new_additions re-fetched an artist whats_new already probed: ${fetchUrls.join(' ')}`,
    );
    // And the sharing is not one artist being skipped: artist B was probed by
    // both tools and still cost exactly one request.
    assert.equal(fetchesOf(`/artists/${ARTIST_B}/albums`).length, 1);
  });

  it('every call site emits the same probe bytes for a given artist', async () => {
    respond = respondFor([[ARTIST_A, '2026-09-20'], [ARTIST_B, '2026-09-19']]);
    // One client PER TOOL, so each call site actually reaches the wire: on one
    // shared client the second tool's probes are cache hits and never appear
    // in the captured URLs, which would make this assertion vacuous.
    const calls: Array<(c: SpotifyClient) => Promise<ToolResult>> = [
      (c) => harness(c).get('whats_new')!({ days_back: 60, kinds: ['albums'], max_artists: 5 }),
      (c) => harness(c).get('artist_name_disambiguator')!({ name: 'Artist AAA', candidates_cap: 1 }),
      (c) => harness(c).get('new_music_from_top_artists')!({ days: 365, artists_cap: 1 }),
      (c) => harness(c).get('discovery_digest')!({ days: 365, top_artists: 1 }),
    ];
    // Sequential: they share the process-wide fetch stub, so running them
    // concurrently would interleave the captured URLs.
    const probes: string[] = [];
    for (const call of calls) probes.push(...(await runIsolated(call)));

    const expected = artistReleaseProbeUrl(ARTIST_A);
    assert.ok(probes.length >= 4, `expected all four call sites on the wire, got ${probes.length}`);
    for (const captured of probes) {
      assert.equal(captured, expected, 'a call site sent a different probe');
    }
  });

  it('reports the probe cost in every payload', async () => {
    const client = new SpotifyClient();
    respond = respondFor([[ARTIST_A, '2026-09-20'], [ARTIST_B, '2026-09-19']]);
    const h = harness(client);

    // Cold: two probes, two requests, no hits.
    const cold = await h.get('whats_new')!({ days_back: 60, kinds: ['albums'], max_artists: 5 });
    const lookups = cold.structuredContent.lookups as Record<string, number>;
    assert.equal(lookups.artist_probes, 2);
    assert.equal(lookups.artist_probe_requests, 2);
    assert.equal(lookups.artist_probe_cache_hits, 0);

    // Warm: the radars probe the same artists again, for free.
    const warm = await h.get('artistwatch_new_additions')!({ days: 365, artists_cap: 5 });
    assert.equal(warm.structuredContent.artist_probes, 2);
    assert.equal(warm.structuredContent.artist_probe_requests, 0);
    assert.equal(warm.structuredContent.artist_probe_cache_hits, 2);
    // The probe cost rides in prose too, so the cost is visible without
    // reading structuredContent.
    assert.match(warm.content[0]!.text, /Probed 2 artists: 0 API requests, 2 served from the read cache/);

    const digest = await h.get('discovery_digest')!({ days: 365, top_artists: 2 });
    assert.equal(digest.structuredContent.artist_probes, 2);
    assert.equal(digest.structuredContent.artist_probe_cache_hits, 2);

    const disambiguator = await h.get('artist_name_disambiguator')!({ name: 'Artist AAA', candidates_cap: 2 });
    assert.equal(disambiguator.structuredContent.artist_probes, 2);
    assert.equal(disambiguator.structuredContent.artist_probe_cache_hits, 2);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 3: a miss is never answered with stale rows
// ---------------------------------------------------------------------------

describe('canonical artist-release probe: nothing stale escapes a miss (#900)', () => {
  it('a different artist never reads another artist\'s entry', async () => {
    const client = new SpotifyClient();
    respond = respondFor([[ARTIST_A, '2026-09-20'], [ARTIST_B, '2018-05-05']]);

    const a = await probeArtistReleases(client, ARTIST_A);
    const b = await probeArtistReleases(client, ARTIST_B);

    // Two requests: the artist id is in the path, so the key differs.
    assert.equal(fetchesOf(`/artists/${ARTIST_A}/albums`).length, 1);
    assert.equal(fetchesOf(`/artists/${ARTIST_B}/albums`).length, 1);
    assert.equal(a.items[0]?.release_date, '2026-09-20');
    assert.equal(b.items[0]?.release_date, '2018-05-05', 'artist B read its own page, not artist A\'s');
    // And re-probing B is a hit on B, not a miss, and not A's rows.
    const again = await probeArtistReleases(client, ARTIST_B);
    assert.equal(again.fromCache, true);
    assert.equal(again.items[0]?.id, `rel-${ARTIST_B}-2018-05-05`);
  });

  it('a cache miss returns what the API just said, not the previously cached rows', async () => {
    const first = new SpotifyClient();
    respond = respondFor([[ARTIST_A, '2026-09-20']]);
    const before = await probeArtistReleases(first, ARTIST_A);
    assert.equal(before.items[0]?.release_date, '2026-09-20');

    // A fresh client is a guaranteed miss. The stub now says the artist put
    // out something newer; the probe must report that, not the old row.
    respond = respondFor([[ARTIST_A, '2026-09-25']]);
    const second = new SpotifyClient();
    const after = await probeArtistReleases(second, ARTIST_A);

    assert.equal(after.fromCache, false, 'a client with a cold cache is a miss');
    assert.equal(after.items[0]?.release_date, '2026-09-25');
    assert.notEqual(after.items[0]?.id, before.items[0]?.id);
  });

  it('an expired entry is a miss, and the expired rows are not served', async () => {
    // A cache whose TTL has already passed: the entry is present but stale,
    // and the probe must re-read rather than hand back the old page.
    const cache = new LruTtlCache<unknown>({ ttlMs: -1 });
    const key = cacheKey('GET', artistReleaseProbePath(ARTIST_A), artistReleaseProbeParams());
    cache.set(key, { items: [{ id: 'stale-row', release_date: '2001-01-01' }] });

    const client = new SpotifyClient();
    respond = respondFor([[ARTIST_A, '2026-09-20']]);
    // Point the client at the poisoned cache rather than building one in.
    (client as unknown as { cache: unknown }).cache = cache;
    installFetch();

    const probe = await probeArtistReleases(client, ARTIST_A);
    assert.equal(probe.fromCache, false, 'an expired entry is not a hit');
    assert.equal(probe.items[0]?.id, `rel-${ARTIST_A}-2026-09-20`, 'the expired row was not served');
    assert.equal(fetchesOf(`/artists/${ARTIST_A}/albums`).length, 1);
  });

  it('reports a failed probe as a miss rather than a silent hit', async () => {
    const client = new SpotifyClient();
    respond = () => ({ status: 403, body: { error: { message: 'Forbidden', reason: 'UNKNOWN' } } });

    await assert.rejects(() => probeArtistReleases(client, ARTIST_A), /Forbidden/);
    // Nothing was stored, so the next probe is a miss too rather than a replay
    // of a failure.
    const cache = client.cache;
    if (cache) {
      assert.equal(cache.get(cacheKey('GET', artistReleaseProbePath(ARTIST_A), artistReleaseProbeParams())), undefined);
    }
  });
});
