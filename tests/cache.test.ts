/**
 * Tests for the read cache's byte bound and its key identity (#894).
 *
 * Covers:
 *   - LruTtlCache byte accounting: eviction under a byte budget, the
 *     per-entry ceiling, skip counting, and that bytes are released exactly
 *     once on overwrite / delete / clear / expiry.
 *   - cacheKey identity: the same request in a different query-param order
 *     is one entry, and any real difference (limit, offset, extra param)
 *     keeps its own entry.
 *   - The two facts holding at the call site: two `client.get` reads of the
 *     same resource with differently ordered params perform one fetch, and
 *     the read cache reports its entry count and bytes to an operator.
 *
 * Run with: node --import tsx --test tests/cache.test.ts
 *
 * NOTE: TOKEN_FILE is resolved at module-load time inside src/auth.ts, so the
 * env vars MUST be set before the dynamic import below. Tokens are only ever
 * written under os.tmpdir().
 */

import { describe, it, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const MB = 1024 * 1024;

// ---------------------------------------------------------------------------
// Env setup MUST precede importing src modules (TOKEN_FILE binds at load time)
// ---------------------------------------------------------------------------

const tokenDir = await mkdtemp(path.join(tmpdir(), 'spotify-mcp-cache-test-'));
process.env.SPOTIFY_MCP_TOKEN_FILE = path.join(tokenDir, 'tokens.json');
process.env.SPOTIFY_CLIENT_ID = 'test-client-id';

const { LruTtlCache, cacheKey } = await import('../src/cache.ts');
const { SpotifyClient } = await import('../src/client.ts');
const { TOKEN_FILE, getTokenFile } = await import('../src/auth.ts');
const persist = await import('../src/cachepersist.ts');

const { basename, dirname, join } = path;

function headerOf(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.[name] ?? null;
}

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
  return rm(tokenDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Byte bound (#894)
// ---------------------------------------------------------------------------

describe('cache: byte budget (#894)', () => {
  it('evicts by bytes: 10 x 2 MB against an 8 MB budget keeps the newest 4', () => {
    // maxEntryBytes is raised to 4 MB so 2 MB entries are admitted at all —
    // the default 1 MB per-entry ceiling is exercised separately below. With
    // that ceiling in force these writes are refused outright, which also
    // respects the budget but retains nothing.
    const cache = new LruTtlCache<object>({ maxBytes: 8 * MB, maxEntryBytes: 4 * MB });
    for (let i = 0; i < 10; i++) cache.set(`k${i}`, { i }, { bytes: 2 * MB });

    assert.ok(cache.size <= 4, `expected at most 4 entries retained, got ${cache.size}`);
    assert.equal(cache.size, 4);
    assert.ok(cache.bytes <= 8 * MB, `byte budget exceeded: ${cache.bytes}`);
    assert.equal(cache.bytes, 8 * MB);
    // Newest survive; the six oldest are gone.
    assert.equal(cache.get('k9')?.i, 9);
    assert.equal(cache.get('k6')?.i, 6);
    assert.equal(cache.get('k5'), undefined, 'oldest entry was evicted for bytes, not by count');
    assert.equal(cache.skippedOversize, 0, 'entries under the per-entry ceiling are not skips');
  });

  it('evicts least-recently-used first when the byte budget is reached', () => {
    const cache = new LruTtlCache<object>({ maxEntries: 100, maxBytes: 4 * MB, maxEntryBytes: 2 * MB });
    cache.set('a', { n: 'a' }, { bytes: 2 * MB });
    cache.set('b', { n: 'b' }, { bytes: 2 * MB });
    assert.equal(cache.get('a')?.n, 'a'); // refresh recency: b is now least recent
    cache.set('c', { n: 'c' }, { bytes: 2 * MB }); // evicts b on bytes

    assert.equal(cache.get('b'), undefined);
    assert.equal(cache.get('a')?.n, 'a');
    assert.equal(cache.get('c')?.n, 'c');
    assert.equal(cache.bytes, 4 * MB);
  });

  it('refuses a single entry larger than the whole budget instead of breaching it', () => {
    // The "bound is real" case: an entry-count bound would happily hold this
    // one entry, and a byte bound that silently over-shot would report a
    // number the process never kept.
    const cache = new LruTtlCache<object>({ maxEntries: 200, maxBytes: MB });
    cache.set('huge', { n: 1 }, { bytes: 2 * MB });

    assert.equal(cache.size, 0);
    assert.equal(cache.bytes, 0, 'a refused entry must not be charged bytes');
    assert.equal(cache.skippedOversize, 1);
  });

  it('refuses an entry above the per-entry ceiling and counts the skip', () => {
    const cache = new LruTtlCache<object>({ maxBytes: 8 * MB }); // default maxEntryBytes 1 MB
    cache.set('big', { n: 1 }, { bytes: 2 * MB });
    assert.equal(cache.size, 0);
    assert.equal(cache.skippedOversize, 1);

    // The refusal is per-entry, not a broken cache: normal reads still land.
    cache.set('small', { n: 2 }, { bytes: 512 });
    assert.equal(cache.get('small')?.n, 2);
    assert.equal(cache.skippedOversize, 1);
  });

  it('estimates bytes when the caller supplies none', () => {
    const cache = new LruTtlCache<string>({ maxBytes: 8 * MB, maxEntryBytes: 4 * MB });
    const payload = 'x'.repeat(2 * MB);
    cache.set('k', payload);
    assert.equal(cache.bytes, 2 * MB, 'a string value is measured by its UTF-8 length');
    assert.equal(cache.get('k'), payload);
  });

  it('never reports bytes above the budget, whatever the write order', () => {
    const cache = new LruTtlCache<object>({ maxEntries: 1000, maxBytes: 5 * MB, maxEntryBytes: 3 * MB });
    for (let i = 0; i < 40; i++) {
      cache.set(`k${i}`, { i }, { bytes: (i % 3) * MB + MB / 2 });
      assert.ok(cache.bytes <= 5 * MB, `byte budget exceeded after write ${i}: ${cache.bytes}`);
      assert.ok(cache.size <= 1000);
    }
  });

  it('charges an overwrite once, not twice', () => {
    const cache = new LruTtlCache<object>({ maxBytes: 8 * MB, maxEntryBytes: 4 * MB });
    cache.set('k', { v: 1 }, { bytes: 2 * MB });
    cache.set('k', { v: 2 }, { bytes: 2 * MB });
    assert.equal(cache.size, 1);
    assert.equal(cache.bytes, 2 * MB, 'replacing a key releases the old charge');
    assert.equal(cache.get('k')?.v, 2);
  });

  it('releases bytes on delete, clear and expiry', async () => {
    const cache = new LruTtlCache<object>({ ttlMs: 60_000, maxBytes: 8 * MB, maxEntryBytes: 4 * MB });
    cache.set('a', { n: 1 }, { bytes: 1024 });
    cache.set('b', { n: 2 }, { bytes: 1024 });
    assert.equal(cache.bytes, 2048);
    cache.delete('a');
    assert.equal(cache.bytes, 1024);
    cache.clear();
    assert.equal(cache.bytes, 0);

    // Expiry on read releases the charge too.
    const short = new LruTtlCache<object>({ ttlMs: 10, maxBytes: 8 * MB, maxEntryBytes: 4 * MB });
    short.set('x', { n: 1 }, { bytes: 512 });
    assert.equal(short.bytes, 512);
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(short.get('x'), undefined);
    assert.equal(short.bytes, 0, 'an expired entry stops counting against the budget');
  });

  it('a read that refreshes recency does not change the byte total', () => {
    const cache = new LruTtlCache<object>({ maxBytes: 8 * MB, maxEntryBytes: 4 * MB });
    cache.set('a', { n: 1 }, { bytes: 2048 });
    cache.set('b', { n: 2 }, { bytes: 2048 });
    assert.equal(cache.get('a')?.n, 1);
    assert.equal(cache.bytes, 4096, 'recency refresh must not double-count');
  });

  it('reports its ceilings for an operator', () => {
    const cache = new LruTtlCache<object>({ maxEntries: 7, maxBytes: 1234, maxEntryBytes: 567 });
    assert.deepEqual(cache.limits, { maxEntries: 7, maxBytes: 1234, maxEntryBytes: 567 });
    const defaults = new LruTtlCache<object>();
    assert.equal(defaults.limits.maxBytes, 8 * MB);
    assert.equal(defaults.limits.maxEntryBytes, MB);
  });
});

// ---------------------------------------------------------------------------
// Key identity (#894)
// ---------------------------------------------------------------------------

describe('cache: key identity (#894)', () => {
  it('one entry for the same params in a different order', () => {
    assert.equal(cacheKey('GET', '/x', { a: '1', b: '2' }), cacheKey('GET', '/x', { b: '2', a: '1' }));
    assert.equal(
      cacheKey('GET', '/playlists/p1/items', { limit: '50', offset: '0' }),
      cacheKey('GET', '/playlists/p1/items', { offset: '0', limit: '50' }),
    );
    // The inline form the client actually sends is canonical too.
    assert.equal(
      cacheKey('GET', '/playlists/p1/items?offset=0&limit=50'),
      cacheKey('GET', '/playlists/p1/items?limit=50&offset=0'),
    );
    // And the two spellings of one request are ONE key, not two competing
    // normalisations that could disagree.
    assert.equal(
      cacheKey('GET', '/playlists/p1/items?limit=50&offset=0'),
      cacheKey('GET', '/playlists/p1/items', { offset: '0', limit: '50' }),
    );
  });

  it('never collapses params that actually differ', () => {
    const base = cacheKey('GET', '/playlists/p1/items', { limit: '50', offset: '0' });
    // A page-size or cursor change is a different request and a different
    // entry: collapsing these would serve page N's items for page N+1.
    assert.notEqual(base, cacheKey('GET', '/playlists/p1/items', { limit: '100', offset: '0' }));
    assert.notEqual(base, cacheKey('GET', '/playlists/p1/items', { limit: '50', offset: '50' }));
    // Adding or dropping a param is likewise a different request.
    assert.notEqual(base, cacheKey('GET', '/playlists/p1/items', { limit: '50', offset: '0', market: 'US' }));
    assert.notEqual(cacheKey('GET', '/playlists/p1/items', { limit: '50' }), base);
    // Same value, different name, is not the same request.
    assert.notEqual(
      cacheKey('GET', '/search', { q: 'a', type: 'album' }),
      cacheKey('GET', '/search', { q: 'a', type: 'track' }),
    );
    // Same param, different path.
    assert.notEqual(base, cacheKey('GET', '/playlists/p2/items', { limit: '50', offset: '0' }));
  });

  it('keys distinct params to distinct cache entries, not just distinct strings', () => {
    const cache = new LruTtlCache<string>({ maxEntries: 10, maxBytes: 8 * MB });
    const fifty = cacheKey('GET', '/playlists/p1/items', { limit: '50', offset: '0' });
    const hundred = cacheKey('GET', '/playlists/p1/items', { limit: '100', offset: '0' });
    cache.set(fifty, 'page-50');
    cache.set(hundred, 'page-100');
    assert.equal(cache.get(fifty), 'page-50');
    assert.equal(cache.get(hundred), 'page-100');
    assert.equal(cache.size, 2);

    // A reordered read hits the entry the differently-ordered write made.
    const reordered = cacheKey('GET', '/playlists/p1/items', { offset: '0', limit: '50' });
    assert.equal(cache.get(reordered), 'page-50');
    assert.equal(cache.size, 2, 'a reordered read must not add a second copy');
  });
});

// ---------------------------------------------------------------------------
// The two facts at the call site
// ---------------------------------------------------------------------------

describe('cache: SpotifyClient reads (#894)', () => {
  let calls: string[] = [];
  const realFetchRef = { current: realFetch };

  beforeEach(async () => {
    calls = [];
    await writeFile(
      TOKEN_FILE,
      JSON.stringify({ access_token: 'tok', refresh_token: 'ref', expires_at: Date.now() + 3_600_000 }),
      'utf8',
    );
    globalThis.fetch = (async (url: unknown) => {
      const href = String(url);
      calls.push(href);
      return new Response(JSON.stringify({ items: [{ id: href }] }), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetchRef.current;
  });

  it('one fetch for the same read with differently ordered params', async () => {
    const client = new SpotifyClient();
    const first = await client.get<{ items: unknown[] }>('/playlists/p1/items', { limit: '5', offset: '0' });
    const second = await client.get<{ items: unknown[] }>('/playlists/p1/items', { offset: '0', limit: '5' });

    assert.equal(calls.length, 1, `expected one network read, got ${calls.length}: ${calls.join(', ')}`);
    assert.deepEqual(first, second);
    assert.equal(client.cache?.size, 1, 'the reordered read reused the entry rather than storing a copy');
  });

  it('two fetches when a param genuinely differs', async () => {
    const client = new SpotifyClient();
    const first = await client.get<{ items: Array<{ id: string }> }>('/playlists/p1/items', { limit: '5', offset: '0' });
    const second = await client.get<{ items: Array<{ id: string }> }>('/playlists/p1/items', { limit: '10', offset: '0' });
    const third = await client.get<{ items: Array<{ id: string }> }>('/playlists/p1/items', { limit: '5', offset: '50' });

    assert.equal(calls.length, 3, 'a different page is a different read');
    assert.notEqual(first?.items[0]?.id, second?.items[0]?.id);
    assert.notEqual(first?.items[0]?.id, third?.items[0]?.id);
    assert.equal(client.cache?.size, 3);
  });

  it('charges the cache the bytes the body actually arrived as', async () => {
    const client = new SpotifyClient();
    const body = { items: Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, name: 'x'.repeat(200) })) };
    const wire = Buffer.byteLength(JSON.stringify(body), 'utf8');
    globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;

    await client.get('/playlists/p1/items', { limit: '50' });

    assert.equal(client.cache?.bytes, wire, 'byte accounting must match the wire body, not an estimate');
    assert.equal(client.cache?.size, 1);
  });

  it('reports cache entries and bytes through getRateLimitStatus()', async () => {
    const client = new SpotifyClient();
    const status = client.getRateLimitStatus();
    assert.equal(status.cacheEntries, 0);
    assert.equal(status.cacheBytes, 0);
    assert.equal(status.cacheMaxBytes, 8 * MB);
    assert.equal(status.cacheSkippedOversize, 0);

    await client.get('/playlists/p1/items', { limit: '5' });
    const afterRead = client.getRateLimitStatus();
    assert.equal(afterRead.cacheEntries, 1);
    assert.ok((afterRead.cacheBytes ?? 0) > 0, 'a cached read reports its retained bytes');
  });

  it('a client with the cache disabled reports no cache at all', () => {
    const client = new SpotifyClient({ disableCache: true });
    const status = client.getRateLimitStatus();
    assert.equal(status.cacheEntries, undefined, 'disabled cache is not the same as an empty one');
    assert.equal(status.cacheBytes, undefined);
  });
});

// ---------------------------------------------------------------------------
// Scoped invalidation (#893)
//
// These drive REAL writes through the client and then read again, asserting on
// the PARSED body the second read returns. A test that only checks a prefix
// string was constructed would pass even if every lookup were wired to the
// wrong key, which is the failure mode this whole change risks.
// ---------------------------------------------------------------------------

describe('cache: scoped invalidation (#893)', () => {
  let calls: Array<{ method: string; href: string }> = [];
  const realFetchRef = { current: realFetch };

  beforeEach(async () => {
    calls = [];
    await writeFile(
      TOKEN_FILE,
      JSON.stringify({ access_token: 'tok', refresh_token: 'ref', expires_at: Date.now() + 3_600_000 }),
      'utf8',
    );
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const href = String(url);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, href });
      if (method !== 'GET') return new Response(JSON.stringify({ snapshot_id: 'snap-1' }), { status: 200 });
      // The body states which resource and which generation it came from, so
      // the assertions can tell "refetched" from "served the old entry" rather
      // than comparing URLs.
      const body = href.includes('/artists/B/')
        ? { items: [{ id: 'artist-b-track', generation: 'current' }] }
        : { items: [{ id: `${href.includes('/playlists/A') ? 'playlist-a' : 'other'}-track`, generation: 'current' }] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetchRef.current;
  });

  it('a playlist write drops that playlist’s reads and keeps unrelated ones', async () => {
    const client = new SpotifyClient();

    await client.get('/playlists/A/items', { limit: '50', offset: '0' });
    await client.get('/playlists/A', {});
    await client.get('/artists/B/albums', { limit: '50' });
    assert.equal(client.cache?.size, 3, 'all three reads are cached before the write');

    await client.post('/playlists/A/items', { uris: ['spotify:track:new'] });

    const rl = client.getRateLimitStatus();
    assert.equal(rl.cacheEntries, 1, 'only the unrelated artist read survives the scoped invalidation');

    // The surviving read is still served from cache — a scoped invalidation
    // that refetched everything would be the old wholesale clear.
    const beforeReread = calls.length;
    const kept = await client.get('/artists/B/albums', { limit: '50' });
    assert.equal(calls.length, beforeReread, 'the unrelated read is served from cache, not refetched');
    assert.equal((kept as { items: Array<{ id: string }> }).items[0]?.id, 'artist-b-track');

    // And the mutated playlist's reads are gone: they must be refetched.
    const items = await client.get('/playlists/A/items', { limit: '50', offset: '0' });
    assert.equal(calls.length, beforeReread + 1, 'the mutated playlist’s read is refetched, not served stale');
    assert.equal((items as { items: Array<{ id: string }> }).items[0]?.id, 'playlist-a-track');
  });

  it('a write whose response body is unreadable still invalidates (#1249)', async () => {
    // `afterMutation` sits in a `finally` in mutate(), so it runs even when
    // reading the response throws. That placement is load-bearing and it is a
    // guard against a real failure: the write reached Spotify either way, so
    // the reads it staled must still be dropped. Move it back out of the
    // `finally` and the second half of this test leaves a stale playlist in the
    // cache — served as fresh for the full TTL, with no error anywhere to say
    // so. (Pre-existing on main; flagged by the #1249 review.)
    //
    // The first half is the ordinary case and is NOT what the `finally` is for:
    // a non-JSON body makes `jsonOrNull` return null without throwing, so both
    // placements behave the same. It is kept as the control, so a regression
    // that breaks invalidation outright is caught here too.
    let poisonHeaders = false;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, href: String(url) });
      if (method !== 'GET') {
        // Several Spotify mutations answer with a bare id and no JSON at all
        // (add_to_queue returns a plain queue id), so `jsonOrNull` returns
        // null and nothing throws.
        if (!poisonHeaders) {
          return new Response('queue-id-1', { status: 200, headers: { 'content-type': 'text/plain' } });
        }
        // A response whose body cannot even be inspected. Real responses
        // don't do this, but the `finally` is the guarantee that an
        // unreadable write still invalidates, so it has to be driven here.
        const poison = new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
        Object.defineProperty(poison, 'headers', {
          get() { throw new Error('response body is gone'); },
        });
        return poison;
      }
      return new Response(JSON.stringify({ name: 'A' }), { status: 200 });
    }) as typeof fetch;

    const client = new SpotifyClient();

    await client.get('/playlists/A', {});
    assert.equal(client.cache?.size, 1, 'the playlist read is cached before the write');
    assert.equal(
      await client.post('/playlists/A/items', { uris: ['spotify:track:new'] }),
      null,
      'a non-JSON body really did yield no payload',
    );
    assert.equal(client.cache?.size, 0, 'a write with no readable body still drops the reads it staled');

    // Now the path the `finally` exists for: reading the response throws.
    await client.get('/playlists/A', {});
    assert.equal(client.cache?.size, 1, 're-cached, so the second write has something to drop');
    poisonHeaders = true;
    await assert.rejects(
      client.post('/playlists/A/items', { uris: ['spotify:track:new'] }),
      /response body is gone/,
      'the caller is told the response was unreadable, rather than seeing a false success',
    );
    assert.equal(
      client.cache?.size,
      0,
      'the finally must drop the reads the write could have staled even though the body read threw',
    );
  });

  it('one playlist’s write does not evict a DIFFERENT playlist whose id shares its prefix', async () => {
    const client = new SpotifyClient();
    // `/playlists/AB` starts with `/playlists/A`. A naive prefix match drops
    // AB's cached reads when A is written to, and the caller never learns.
    await client.get('/playlists/AB/items', { limit: '50' });
    await client.post('/playlists/A/items', { uris: ['spotify:track:new'] });
    assert.equal(client.getRateLimitStatus().cacheEntries, 1, 'the AB playlist read survives a write to playlist A');
  });

  it('a player command invalidates nothing — an unrelated read-mutate-read keeps its pages', async () => {
    const client = new SpotifyClient();
    // Count GETs only: the assertion is about re-walking the catalog, and the
    // queue add itself is a request that legitimately happens.
    const gets = (): number => calls.filter((c) => c.method === 'GET').length;
    // A five-page playlist walk, then an unrelated mutation, then the re-read.
    for (let offset = 0; offset < 500; offset += 100) {
      await client.get('/playlists/A/items', { limit: '100', offset: String(offset) });
    }
    const afterWalk = gets();
    assert.equal(afterWalk, 5, 'the first walk costs one request per page');

    await client.post('/me/player/queue', { uri: 'spotify:track:new' });

    for (let offset = 0; offset < 500; offset += 100) {
      await client.get('/playlists/A/items', { limit: '100', offset: String(offset) });
    }
    assert.equal(gets(), afterWalk, 'a queue add must not cost the agent the whole cached walk');
  });

  it('a library write drops the library reads it can change', async () => {
    const client = new SpotifyClient();
    await client.get('/me/tracks', { limit: '50', offset: '0' });
    await client.get('/artists/B/albums', { limit: '50' });
    assert.equal(client.cache?.size, 2);

    await client.put('/me/library', { uris: ['spotify:track:t1'] });

    assert.equal(client.getRateLimitStatus().cacheEntries, 1, 'the /me/tracks read is dropped, the catalog read is not');
    const beforeReread = calls.length;
    await client.get('/me/tracks', { limit: '50', offset: '0' });
    assert.equal(calls.length, beforeReread + 1, 'the library read is refetched after a save');
  });

  it('an unclassified write falls back to a full clear rather than a guess', async () => {
    const client = new SpotifyClient();
    await client.get('/artists/B/albums', { limit: '50' });
    await client.get('/albums/X', {});
    assert.equal(client.cache?.size, 2);

    // No rule covers this endpoint. Failing closed costs a refetch; failing
    // open would serve a stale read as if it were fresh.
    await client.post('/some/future/endpoint', {});

    assert.equal(client.getRateLimitStatus().cacheEntries, 0, 'an unknown write endpoint clears the cache');
  });

  it('a read in flight across a write is NOT stored, so the next read refetches', async () => {
    // The bug this guards: the funnel runs up to maxConcurrency requests at
    // once, so a read issued BEFORE a write can complete AFTER it. Storing
    // that body re-seeds the entry the write just invalidated, and the stale
    // value is then served for the full TTL while looking fresh.
    await writeFile(
      TOKEN_FILE,
      JSON.stringify({ access_token: 'tok', refresh_token: 'ref', expires_at: Date.now() + 3_600_000 }),
      'utf8',
    );

    let generation = 'before';
    let releaseRead: (() => void) | null = null;
    let gateRead = true;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const href = String(url);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method !== 'GET') {
        generation = 'after';
        return new Response(JSON.stringify({ snapshot_id: 's' }), { status: 200 });
      }
      // Snapshot the body at REQUEST time: what Spotify would have answered
      // then, which is the whole point — a response captured after the write
      // would prove nothing.
      const body = JSON.stringify({ items: [{ id: `track-${generation}` }] });
      if (gateRead) {
        return new Promise<Response>((resolve) => {
          releaseRead = () => resolve(new Response(body, { status: 200 }));
        });
      }
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const client = new SpotifyClient();
    const inflight = client.get('/playlists/A/items', { limit: '50' });
    await new Promise((r) => setTimeout(r, 40)); // the read is now in flight
    gateRead = false;
    await client.post('/playlists/A/items', { uris: ['spotify:track:new'] });
    releaseRead?.();

    // The in-flight caller still gets a truthful answer to its own read.
    const first = await inflight;
    assert.equal((first as { items: Array<{ id: string }> }).items[0]?.id, 'track-before');

    assert.equal(client.getRateLimitStatus().cacheEntries, 0, 'a body that predates the write is not stored');

    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ items: [{ id: `track-${generation}` }] }), { status: 200 });
    }) as typeof fetch;

    const second = await client.get('/playlists/A/items', { limit: '50' });
    assert.equal(calls, 1, 'the next read must hit the network, not the pre-write body');
    assert.equal(
      (second as { items: Array<{ id: string }> }).items[0]?.id,
      'track-after',
      'the value served is the post-write one',
    );
  });

  it('a PLAYER write racing a catalog read does not discard it (#1249)', async () => {
    // The counterpart to the test above, and the one that makes the headline
    // claim true. `POST /me/player/queue` has a plan that drops ZERO payload
    // prefixes, so it cannot make a catalog read stale. Under a single global
    // epoch the guard answered "something was invalidated" and threw the
    // catalog fill away anyway — `cacheEntries === 0` after the raced read,
    // which is the exact cost scoped invalidation claims to remove.
    await writeFile(
      TOKEN_FILE,
      JSON.stringify({ access_token: 'tok', refresh_token: 'ref', expires_at: Date.now() + 3_600_000 }),
      'utf8',
    );

    let releaseRead: (() => void) | null = null;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method !== 'GET') return new Response(JSON.stringify({ snapshot_id: 's' }), { status: 200 });
      return new Promise<Response>((resolve) => {
        releaseRead = () => resolve(new Response(JSON.stringify({ items: [{ id: 'alb1' }] }), { status: 200 }));
      });
    }) as typeof fetch;

    const client = new SpotifyClient();
    const inflight = client.get('/artists/AR/albums', { limit: '50' });
    await new Promise((r) => setTimeout(r, 40)); // the read is in flight
    await client.post('/me/player/queue', { uri: 'spotify:track:x' });
    releaseRead?.();
    await inflight;

    assert.equal(
      client.getRateLimitStatus().cacheEntries,
      1,
      'a player command drops no payload prefixes, so it must not cost an unrelated catalog read',
    );
  });

  it('a player write still invalidates a raced /me/player read, not just catalog (#1249)', async () => {
    // Scoping must not become a hole. The validator store serves /me/player
    // deliberately (#601), and `POST /me/player/queue` really does append to
    // the `queue` array `GET /me/player/queue` returns, so a validator that
    // survived would let a 304 answer with the PRE-add queue. This path never
    // enters the payload cache, so the validator store is the only place the
    // guard's verdict is observable — hence asserting on `If-None-Match`.
    await writeFile(
      TOKEN_FILE,
      JSON.stringify({ access_token: 'tok', refresh_token: 'ref', expires_at: Date.now() + 3_600_000 }),
      'utf8',
    );

    const offered: Array<string | null> = [];
    let gate = true;
    let releaseRead: (() => void) | null = null;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method !== 'GET') return new Response(JSON.stringify({ snapshot_id: 's' }), { status: 200 });
      offered.push((init?.headers as Record<string, string> | undefined)?.['If-None-Match'] ?? null);
      const res = () => new Response(JSON.stringify({ currently_playing: null, queue: [] }), {
        status: 200,
        headers: { etag: '"q1"' },
      });
      if (gate) return new Promise<Response>((resolve) => { releaseRead = () => resolve(res()); });
      return res();
    }) as typeof fetch;

    const client = new SpotifyClient();
    // Control: a raced read with NO mutation in between DOES leave a validator,
    // so the assertion below is about the mutation and not about a store that
    // never records anything.
    const inflight = client.get('/me/player/queue');
    await new Promise((r) => setTimeout(r, 40));
    gate = false;
    releaseRead?.();
    await inflight;
    await client.get('/me/player/queue');
    assert.equal(offered.at(-1), '"q1"', 'control: with no mutation the validator IS offered');

    // Now the same race, with a player write landing in between.
    gate = true;
    const raced = client.get('/me/player/queue');
    await new Promise((r) => setTimeout(r, 40));
    await client.post('/me/player/queue', { uri: 'spotify:track:x' });
    gate = false;
    releaseRead?.();
    await raced;
    await client.get('/me/player/queue');
    assert.equal(
      offered.at(-1),
      null,
      'the player write covers this key, so the raced validator must be withheld',
    );
  });

  it('a player write racing a 304 on a CATALOG read does not cost the refresh (#1249)', async () => {
    // The 304 branch of the guard, which the two tests above cannot reach: a
    // 304 only happens for a path that goes to the network, so a catalog read
    // needs its payload TTL to lapse while its ETag validator survives (the
    // validator outlives the payload on purpose — #601).
    //
    // The player write's plan covers `/me/player` and `/me/top` validators and
    // no catalog key, so a 304 for `/tracks/t1` landing across one is still a
    // truthful "unchanged" and its refresh is worth keeping. A blanket global
    // epoch would discard it.
    await writeFile(
      TOKEN_FILE,
      JSON.stringify({ access_token: 'tok', refresh_token: 'ref', expires_at: Date.now() + 3_600_000 }),
      'utf8',
    );

    let gate = false;
    let releaseRead: (() => void) | null = null;
    let network = 0;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method !== 'GET') return new Response(JSON.stringify({ snapshot_id: 's' }), { status: 200 });
      network += 1;
      // Decide at RELEASE time, not before: the gate must hold the revalidation
      // open across the mutation, and a responder that answered 304 before the
      // gate would let this test pass without ever racing anything.
      const answer = () =>
        headerOf(init, 'If-None-Match') === '"t1"'
          ? new Response(null, { status: 304 })
          : new Response(JSON.stringify({ id: 't1', name: 'One' }), { status: 200, headers: { etag: '"t1"' } });
      if (gate) return new Promise<Response>((resolve) => { releaseRead = () => resolve(answer()); });
      return answer();
    }) as typeof fetch;

    // A short payload TTL: the validator (60 min) outlives it, which is exactly
    // the asymmetry #601 is built on. Long enough that the refresh below is
    // still live when the next read checks, short enough to lapse while the
    // revalidation is in flight.
    const client = new SpotifyClient({ cache: { ttlMs: 300 } });
    await client.get('/tracks/t1');
    await new Promise((r) => setTimeout(r, 450)); // the payload lapses, the validator does not

    gate = true;
    const revalidating = client.get('/tracks/t1');
    await new Promise((r) => setTimeout(r, 40)); // the revalidation is in flight
    await client.post('/me/player/queue', { uri: 'spotify:track:x' });
    gate = false;
    releaseRead?.();
    await revalidating;

    const before = network;
    await client.get('/tracks/t1');
    assert.equal(
      network,
      before,
      'the 304 refreshed the payload, so the next read is a cache hit — a player write must not cost it',
    );
  });
});

// ---------------------------------------------------------------------------
// Persistence policy (#893) — pure, no client and no network
// ---------------------------------------------------------------------------

describe('cache: persistence policy (#893)', () => {
  it('persists catalog reads and refuses every /me read', () => {
    const { isPersistableKey } = persist;
    for (const key of [
      cacheKey('GET', '/tracks/t1'),
      cacheKey('GET', '/albums/a1'),
      cacheKey('GET', '/artists/ar1/albums', { limit: '50' }),
      cacheKey('GET', '/shows/s1'),
    ]) {
      assert.equal(isPersistableKey(key), true, `${key} is immutable catalog and should persist`);
    }
    // /me/* is user-owned and changes under this server's own write tools. A
    // second process would serve these without ever seeing the mutation.
    for (const key of [
      cacheKey('GET', '/me/tracks', { limit: '50' }),
      cacheKey('GET', '/me/playlists', { limit: '50' }),
      cacheKey('GET', '/me/player/queue'),
      cacheKey('GET', '/me/library/contains'),
    ]) {
      assert.equal(isPersistableKey(key), false, `${key} must never be persisted`);
    }
    // Playlists are writable here, so a playlist read persisted by one process
    // would be stale for another that never saw the edit.
    assert.equal(isPersistableKey(cacheKey('GET', '/playlists/p1/items', { limit: '50' })), false);
    // A non-GET key is refused on shape, not on a path allowlist.
    assert.equal(isPersistableKey('POST /tracks/t1 '), false);
  });

  it('persists the public /users profile and NOTHING under it (#1249)', () => {
    const { isPersistableKey } = persist;
    // The public display profile is genuinely public catalog and immutable.
    assert.equal(isPersistableKey(cacheKey('GET', '/users/u1')), true);

    // Everything below it is a listener's private history. These have no Web
    // API write path NOT because they are immutable but because nothing can
    // write them: they move for reasons outside this server, which scoped
    // invalidation cannot reach (`invalidationPlan` has no `users` rule) and a
    // second process could not have observed. A root-level grant persisted them
    // for the full TTL — account-private data on disk, at
    // src/tools/statsfm.ts:278 and :404.
    for (const path of [
      '/users/u1/streams/stats',
      '/users/u1/streams',
      '/users/u1/streams/recent',
      '/users/u1/streams/current',
      '/users/u1/top/artists',
      '/users/u1/top/tracks',
      '/users/u1/records/artists',
      '/users/u1/friends',
      '/users/u1/friends/count',
      // A playlist list is public, but `POST /me/playlists` changes it and no
      // invalidation rule reaches under /users, so it is refused too.
      '/users/u1/playlists',
    ]) {
      assert.equal(
        isPersistableKey(cacheKey('GET', path, { limit: '50' })),
        false,
        `${path} is account-private and must never be persisted`,
      );
    }

    // The depth rule is per-root, not global: catalog sub-resources that ARE
    // public stay persistable, so the fix did not over-restrict.
    for (const path of [
      '/albums/a1/tracks',
      '/artists/ar1/albums',
      '/artists/ar1/top-tracks',
      '/shows/s1/episodes',
      '/audiobooks/b1/chapters',
      '/genres/rock/artists',
    ]) {
      assert.equal(
        isPersistableKey(cacheKey('GET', path, { limit: '50' })),
        true,
        `${path} is public catalog and should still persist`,
      );
    }
  });

  it('drops expired entries on load instead of reviving them', () => {
    const now = Date.now();
    const doc = {
      version: 1,
      entries: [
        { key: cacheKey('GET', '/tracks/t1'), value: { id: 't1' }, expiresAt: now + 60_000 },
        { key: cacheKey('GET', '/tracks/t2'), value: { id: 't2' }, expiresAt: now - 1 },
      ],
    };
    const kept = persist.validatePersisted(doc, now);
    assert.deepEqual(kept.entries.map((e) => e.key), [cacheKey('GET', '/tracks/t1')]);
  });

  it('refuses a file whose schema version is not this one', () => {
    assert.throws(
      () => persist.validatePersisted({ version: 99, entries: [] }),
      /version 99 is not 1/,
    );
  });

  it('skips malformed rows rather than failing the whole file', () => {
    const now = Date.now();
    const kept = persist.validatePersisted(
      {
        version: 1,
        entries: [
          { key: cacheKey('GET', '/tracks/t1'), value: { id: 't1' }, expiresAt: now + 60_000 },
          { key: '', value: {}, expiresAt: now + 60_000 },
          { key: cacheKey('GET', '/tracks/t3'), expiresAt: now + 60_000 },
          { key: cacheKey('GET', '/tracks/t4'), value: {}, expiresAt: 'soon' },
          null,
        ],
      },
      now,
    );
    assert.deepEqual(kept.entries.map((e) => e.key), [cacheKey('GET', '/tracks/t1')]);
  });

  it('names the persisted file after the SAME profile the token file uses (#1249)', () => {
    // The cache is per-account state. Before this fix every profile shared one
    // `~/.spotify-mcp/cache.json`: last writer wins, and a session
    // authenticated as one account served another's reads to the next.
    const { cachePersistPath } = persist;
    // The token path is resolved from a fixed env, not `process.env`, so the
    // comparison below cannot pass by both sides reading the same ambient var.
    const pathFor = (profile?: string): { tokens: string; cache: string } => {
      const env: NodeJS.ProcessEnv = { SPOTIFY_MCP_TOKEN_FILE: undefined, SPOTIFY_MCP_PROFILE: profile };
      return { tokens: getTokenFile(undefined, env), cache: cachePersistPath(env) };
    };

    // The default account.
    {
      const { tokens, cache } = pathFor(undefined);
      assert.equal(dirname(cache), dirname(tokens), 'the cache sits beside its token file');
      assert.equal(basename(cache), 'cache.json');
    }

    // Profiles separate the two, and the profile TOKEN is identical on both
    // sides — which is the property that matters. Comparing only "the two paths
    // differ" would pass even if the cache invented a different profile name.
    for (const profile of ['work', 'personal', 'a.b-c_d', 'UPPER']) {
      const { tokens, cache } = pathFor(profile);
      assert.notEqual(cache, pathFor(undefined).cache, `profile ${profile} must not share the default cache`);
      assert.equal(dirname(cache), dirname(tokens), `profile ${profile}: cache sits beside its token file`);
      const tokenProfile = /tokens\.(.+)\.json$/.exec(basename(tokens))?.[1];
      const cacheProfile = /cache\.(.+)\.json$/.exec(basename(cache))?.[1];
      assert.equal(cacheProfile, tokenProfile, `profile ${profile}: cache and token must name the same profile`);
    }

    // A --profile CLI value resolves the same way (getTokenFile's first arg).
    assert.equal(
      basename(cachePersistPath({})),
      'cache.json',
      'no profile in the env means the default account, whatever the CLI said',
    );
    assert.equal(basename(cachePersistPath({}, {})), 'cache.json');

    // An explicit token file with a conventional profile name still partitions.
    const customEnv: NodeJS.ProcessEnv = { SPOTIFY_MCP_TOKEN_FILE: '/tmp/x/tokens.work.json' };
    assert.equal(basename(cachePersistPath(customEnv)), 'cache.work.json');

    // And SPOTIFY_MCP_DATA_DIR still relocates the DIRECTORY without merging
    // accounts — the profile comes from the name, not from the directory.
    const relocated = cachePersistPath({ SPOTIFY_MCP_DATA_DIR: '/tmp/elsewhere', SPOTIFY_MCP_PROFILE: 'work' });
    assert.equal(relocated, join('/tmp/elsewhere', 'cache.work.json'));

    // The explicit `file` override still wins outright.
    assert.equal(cachePersistPath({ SPOTIFY_MCP_PROFILE: 'work' }, { file: '/tmp/explicit.json' }), '/tmp/explicit.json');
  });
});

// ---------------------------------------------------------------------------
// Cross-process persistence (#893)
//
// Everything here writes under a fresh `mkdtemp` directory via
// `SPOTIFY_MCP_DATA_DIR` + the client's `cachePersist.file` override. The real
// `~/.spotify-mcp/` must never be a target of a test run, so the override is
// not optional here and there is no path through these tests that falls back
// to `homedir()`.
// ---------------------------------------------------------------------------

describe('cache: cross-process persistence (#893)', () => {
  let dir = '';
  let prevPersist: string | undefined;
  let prevDataDir: string | undefined;
  let prevTokenFile: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'spotify-mcp-persist-'));
    prevPersist = process.env.SPOTIFY_MCP_CACHE_PERSIST;
    prevDataDir = process.env.SPOTIFY_MCP_DATA_DIR;
    prevTokenFile = process.env.SPOTIFY_MCP_TOKEN_FILE;
    process.env.SPOTIFY_MCP_CACHE_PERSIST = '1';
    process.env.SPOTIFY_MCP_DATA_DIR = dir;
    process.env.SPOTIFY_MCP_TOKEN_FILE = path.join(dir, 'tokens.json');
    await writeFile(
      process.env.SPOTIFY_MCP_TOKEN_FILE,
      JSON.stringify({ access_token: 'tok', refresh_token: 'ref', expires_at: Date.now() + 3_600_000 }),
      'utf8',
    );
  });

  afterEach(async () => {
    if (prevPersist === undefined) delete process.env.SPOTIFY_MCP_CACHE_PERSIST;
    else process.env.SPOTIFY_MCP_CACHE_PERSIST = prevPersist;
    if (prevDataDir === undefined) delete process.env.SPOTIFY_MCP_DATA_DIR;
    else process.env.SPOTIFY_MCP_DATA_DIR = prevDataDir;
    if (prevTokenFile === undefined) delete process.env.SPOTIFY_MCP_TOKEN_FILE;
    else process.env.SPOTIFY_MCP_TOKEN_FILE = prevTokenFile;
    await rm(dir, { recursive: true, force: true });
  });

  it('a second client serves a catalog read with no network call, and never persists a /me read', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ items: [{ id: 'tr1' }] }), { status: 200 });
    }) as typeof fetch;

    const first = new SpotifyClient();
    await first.get('/tracks/tr1', {});
    assert.equal(first.getRateLimitStatus().cachePersist, true, 'persistence is reported as on, not implied');

    // The write is debounced; wait past the debounce so the file is on disk.
    await persist.savePersistedCache(
      first.cache?.snapshot().map((e) => ({ key: e.key, value: e.value, expiresAt: e.expiresAt })) ?? [],
      { file: path.join(dir, 'cache.json') },
    );

    const second = new SpotifyClient();
    await second.get('/tracks/tr1', {});
    const before = calls;
    const served = await second.get('/tracks/tr1', {});
    assert.equal(calls, before, 'the second client answered from the persisted file, not the network');
    assert.deepEqual(served, { items: [{ id: 'tr1' }] });

    // The /me read is the case that must never cross a process boundary: a
    // second process would serve it without having seen the mutation.
    await second.get('/me/tracks', {});
    const written = persist.validatePersisted(
      JSON.parse(await readFile(path.join(dir, 'cache.json'), 'utf8')),
    );
    assert.ok(
      written.entries.every((e) => !e.key.includes('/me/')),
      `no /me key may be persisted, got: ${written.entries.map((e) => e.key).join(', ')}`,
    );
  });

  it('a persisted entry does not outlive the expiry it was written with', async () => {
    const file = path.join(dir, 'cache.json');
    const key = cacheKey('GET', '/tracks/tr1', {});
    await persist.savePersistedCache([{ key, value: { id: 'tr1' }, expiresAt: Date.now() - 1 }], { file });

    // Already past its deadline, so a load must not hand it back.
    const loaded = await persist.loadPersistedCache({ file });
    assert.equal(loaded.length, 0, 'an expired entry is dropped on load, not revived');
  });

  it('a corrupt cache file is preserved and reported, not read as an empty cache', async () => {
    const file = path.join(dir, 'cache.json');
    await writeFile(file, '{ this is not json', 'utf8');
    await assert.rejects(persist.loadPersistedCache({ file }), /not valid JSON|cache file/);
    // The bytes are still there, moved aside rather than destroyed.
    assert.ok(existsSync(file) || existsSync(`${file}.corrupt`), 'the unreadable file is preserved, not deleted');
  });

  it('serializes each entry ONCE, not the growing document per entry (#1249)', async () => {
    // The O(n²) shape measured 2980 ms for 200 × 40 KB — the #894 8 MB budget
    // after a catalogue walk — against 17 ms for one stringify. Counting
    // stringify CALLS cannot tell those apart (both call it n times); what
    // separates them is how many BYTES go through it. The old loop re-encoded
    // the whole accumulator per entry, so it serialized ~n/2 × the final file.
    // Asserting on bytes is deterministic, where a timing assertion would flake
    // on a loaded CI box.
    const file = path.join(dir, 'cache.json');
    const n = 200;
    const entries = Array.from({ length: n }, (_, i) => ({
      key: cacheKey('GET', `/tracks/t${i}`),
      value: { id: `t${i}`, blob: 'x'.repeat(40_000) },
      expiresAt: Date.now() + 600_000,
    }));

    const realStringify = JSON.stringify;
    let serializedBytes = 0;
    JSON.stringify = function counting(...args: Parameters<typeof realStringify>) {
      const out = realStringify(...args);
      serializedBytes += typeof out === 'string' ? out.length : 0;
      return out;
    };
    try {
      await persist.savePersistedCache(entries, { file });
    } finally {
      JSON.stringify = realStringify;
    }

    const finalBytes = (await readFile(file, 'utf8')).length;
    assert.ok(finalBytes > 7_000_000, `the fixture must be a realistic full cache, got ${finalBytes} bytes`);
    assert.ok(
      serializedBytes <= finalBytes * 2,
      `serialized ${serializedBytes} bytes to write ${finalBytes}: the writer is re-serializing ` +
        'the accumulator per entry (O(n²)). Budget is one pass over the data.',
    );
  });

  it('skips an oversize entry, keeps the later ones that fit, and counts the drop (#1249)', async () => {
    // The cap used to `break`, so one entry too large discarded every later
    // entry that would have fitted, and counted none of them: the operator saw
    // `persisted=0` with no stated reason.
    const file = path.join(dir, 'cache.json');
    const big = { id: 'big', blob: 'x'.repeat(200_000) };
    const small = (id: string) => ({ key: cacheKey('GET', `/tracks/${id}`), value: { id }, expiresAt: Date.now() + 600_000 });
    const entries = [
      { key: cacheKey('GET', '/tracks/big'), value: big, expiresAt: Date.now() + 600_000 },
      small('a'),
      small('b'),
      small('c'),
    ];

    // A cap that comfortably fits the three small entries and not the big one.
    const maxBytes = 20_000;
    const stats = await persist.savePersistedCache(entries, { file, maxBytes });

    assert.equal(stats.oversize, 1, 'the oversize entry is counted, not silently dropped');
    assert.equal(stats.persisted, 3, 'the three later entries that fit are kept');
    assert.equal(stats.bytes, (await readFile(file, 'utf8')).length, 'the reported size is the file actually written');
    assert.ok(stats.bytes <= maxBytes, 'the cap is still respected');

    const written = persist.validatePersisted(JSON.parse(await readFile(file, 'utf8')));
    assert.deepEqual(
      written.entries.map((e) => e.key),
      [small('a').key, small('b').key, small('c').key],
      'the oversize entry is absent and the rest are present, in order',
    );
  });
});
