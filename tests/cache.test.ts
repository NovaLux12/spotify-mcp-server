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
 * NOTE: the token path is resolved per CALL by getTokenFilePath(), so env
 * env vars MUST be set before the dynamic import below. Tokens are only ever
 * written under os.tmpdir().
 */

import './helpers/hermetic.js';

import { describe, it, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { armFileDeadline, FLEET_FILE_BUDGET_MS } from './helpers/file-deadline.js';

// The `SpotifyClient` DESTRUCTURED below is a value — it comes out of an
// `await import(...)` that must stay below the env setup — so it cannot be
// named in a type position. This alias is the same class seen as a type; being
// `import type`, it is erased at runtime and disturbs no import ordering.
import type { SpotifyClient as SpotifyClientType } from '../src/client.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MB = 1024 * 1024;

// Armed at module scope, above every hook, because a bound a teardown can clear
// is not a bound (#1569). This file spawns five children with
// `stdio: ['ignore', 'pipe', 'pipe']` — the `PipeWrap` geometry the fleet guard
// exists to bound — and it was missed entirely: the guard's classifier required
// `spawn(process.execPath` on one line, and every call here wraps the argument
// onto the next. The timer is `unref`'d, so it cannot delay a file that finishes.
armFileDeadline({
  label: 'tests/cache.test.ts',
  budgetMs: FLEET_FILE_BUDGET_MS,
  children: () => [],
});

// ---------------------------------------------------------------------------
// Env setup MUST precede anything that reads a token (getTokenFilePath()
// resolves per call, so ordering no longer matters for the BINDING — only for
// the value read).
// ---------------------------------------------------------------------------

const tokenDir = await mkdtemp(path.join(tmpdir(), 'spotify-mcp-cache-test-'));
process.env.SPOTIFY_MCP_TOKEN_FILE = path.join(tokenDir, 'tokens.json');
process.env.SPOTIFY_CLIENT_ID = 'test-client-id';

const { LruTtlCache, cacheKey } = await import('../src/cache.ts');
const { SpotifyClient } = await import('../src/client.ts');
const { getTokenFilePath, getTokenFile } = await import('../src/auth.ts');
const tokenPath = getTokenFilePath();
const persist = await import('../src/cachepersist.ts');

const { basename, dirname, join } = path;

function headerOf(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.[name] ?? null;
}

/**
 * Release a gated read, tolerating "the gate was never armed".
 *
 * Each race test parks its fetch stub's response behind a `releaseRead` latch
 * that the stub ASSIGNS from inside its own callback. TypeScript's control-flow
 * analysis only sees the `null` initializer at the call site — an assignment
 * from a closure does not widen it back — so `releaseRead?.()` there is typed
 * `never` and rejected. Taking the latch as a parameter moves the call into a
 * position where the declared `(() => void) | null` type is what the compiler
 * checks, which is the same optional call the test already wrote.
 */
function releaseGatedRead(release: (() => void) | null): void {
  release?.();
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
    const cache = new LruTtlCache<{ i: number }>({ maxBytes: 8 * MB, maxEntryBytes: 4 * MB });
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
    const cache = new LruTtlCache<{ n: string }>({ maxEntries: 100, maxBytes: 4 * MB, maxEntryBytes: 2 * MB });
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
    const cache = new LruTtlCache<{ n: number }>({ maxEntries: 200, maxBytes: MB });
    cache.set('huge', { n: 1 }, { bytes: 2 * MB });

    assert.equal(cache.size, 0);
    assert.equal(cache.bytes, 0, 'a refused entry must not be charged bytes');
    assert.equal(cache.skippedOversize, 1);
  });

  it('refuses an entry above the per-entry ceiling and counts the skip', () => {
    const cache = new LruTtlCache<{ n: number }>({ maxBytes: 8 * MB }); // default maxEntryBytes 1 MB
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
    const cache = new LruTtlCache<{ i: number }>({ maxEntries: 1000, maxBytes: 5 * MB, maxEntryBytes: 3 * MB });
    for (let i = 0; i < 40; i++) {
      cache.set(`k${i}`, { i }, { bytes: (i % 3) * MB + MB / 2 });
      assert.ok(cache.bytes <= 5 * MB, `byte budget exceeded after write ${i}: ${cache.bytes}`);
      assert.ok(cache.size <= 1000);
    }
  });

  it('charges an overwrite once, not twice', () => {
    const cache = new LruTtlCache<{ v: number }>({ maxBytes: 8 * MB, maxEntryBytes: 4 * MB });
    cache.set('k', { v: 1 }, { bytes: 2 * MB });
    cache.set('k', { v: 2 }, { bytes: 2 * MB });
    assert.equal(cache.size, 1);
    assert.equal(cache.bytes, 2 * MB, 'replacing a key releases the old charge');
    assert.equal(cache.get('k')?.v, 2);
  });

  it('releases bytes on delete, clear and expiry', async () => {
    const cache = new LruTtlCache<{ n: number }>({ ttlMs: 60_000, maxBytes: 8 * MB, maxEntryBytes: 4 * MB });
    cache.set('a', { n: 1 }, { bytes: 1024 });
    cache.set('b', { n: 2 }, { bytes: 1024 });
    assert.equal(cache.bytes, 2048);
    cache.delete('a');
    assert.equal(cache.bytes, 1024);
    cache.clear();
    assert.equal(cache.bytes, 0);

    // Expiry on read releases the charge too.
    const short = new LruTtlCache<{ n: number }>({ ttlMs: 10, maxBytes: 8 * MB, maxEntryBytes: 4 * MB });
    short.set('x', { n: 1 }, { bytes: 512 });
    assert.equal(short.bytes, 512);
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(short.get('x'), undefined);
    assert.equal(short.bytes, 0, 'an expired entry stops counting against the budget');
  });

  it('a read that refreshes recency does not change the byte total', () => {
    const cache = new LruTtlCache<{ n: number }>({ maxBytes: 8 * MB, maxEntryBytes: 4 * MB });
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
      tokenPath,
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
      tokenPath,
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
      tokenPath,
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
    releaseGatedRead(releaseRead);

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
      tokenPath,
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
    releaseGatedRead(releaseRead);
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
      tokenPath,
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
    releaseGatedRead(releaseRead);
    await inflight;
    await client.get('/me/player/queue');
    assert.equal(offered.at(-1), '"q1"', 'control: with no mutation the validator IS offered');

    // Now the same race, with a player write landing in between.
    gate = true;
    const raced = client.get('/me/player/queue');
    await new Promise((r) => setTimeout(r, 40));
    await client.post('/me/player/queue', { uri: 'spotify:track:x' });
    gate = false;
    releaseGatedRead(releaseRead);
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
      tokenPath,
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
    releaseGatedRead(releaseRead);
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

  /**
   * Every client this block constructs, so `afterEach` can quiesce it (#1339).
   *
   * A read arms a 250 ms debounced save that nothing here waits out. Left
   * alone, the timer fires during or after the teardown's `rm`, and
   * `savePersistedCache`'s `mkdir(recursive)` re-creates the tree underneath a
   * delete that has already walked it — the final `rmdir` then fails
   * `ENOTEMPTY` and takes the whole gate with it.
   */
  let clients: SpotifyClientType[] = [];
  const newClient = (): SpotifyClientType => {
    const c = new SpotifyClient();
    clients.push(c);
    return c;
  };

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
    // Quiesce what this block made, BEFORE the directory goes (#1339). The
    // flush writes the pending save now and clears the debounce timer, so
    // nothing can land once `rm` starts walking. Ordering is the whole fix;
    // `force: true` suppresses ENOENT but not ENOTEMPTY, so the race was not
    // something the teardown could absorb. `flush` swallows write failures
    // into the controller's counters rather than rejecting, so a client whose
    // save fails cannot turn the teardown into a second failure.
    for (const c of clients) await c.flushCachePersist();
    clients = [];
    await rm(dir, { recursive: true, force: true });
  });

  it('a second client serves a catalog read with no network call, and never persists a /me read', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ items: [{ id: 'tr1' }] }), { status: 200 });
    }) as typeof fetch;

    const first = newClient();
    await first.get('/tracks/tr1', {});
    assert.equal(first.getRateLimitStatus().cachePersist, true, 'persistence is reported as on, not implied');

    // The write is debounced; wait past the debounce so the file is on disk.
    await persist.savePersistedCache(
      first.cache?.snapshot().map((e) => ({ key: e.key, value: e.value, expiresAt: e.expiresAt })) ?? [],
      { file: path.join(dir, 'cache.json') },
    );

    const second = newClient();
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
    // `JSON.stringify` is OVERLOADED (a replacer may be a function or a list
    // of keys), and `Parameters<typeof realStringify>` only ever names the
    // last overload — which is why the original spread form would not
    // typecheck as a replacement. Spell both arms out in one union and pick
    // the overload by the replacer's runtime kind.
    JSON.stringify = function counting(
      value: unknown,
      replacer?: ((this: unknown, key: string, value: unknown) => unknown) | (string | number)[] | null,
      space?: string | number,
    ): string {
      const out =
        typeof replacer === 'function'
          ? realStringify(value, replacer, space)
          : realStringify(value, replacer, space);
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

  // -------------------------------------------------------------------------
  // #1339: the teardown ordering, and the control that keeps it honest
  //
  // ENOTEMPTY is only the symptom. The mechanism is that a pending debounced
  // save will re-create a directory that was deleted out from under it,
  // because `savePersistedCache` does `mkdir(dirname(file), { recursive: true })`
  // before writing — so a late save does not merely write into a directory that
  // may still exist, it GUARANTEES one exists afterwards.
  //
  // Asserting "rm did not throw" would be a test that cannot fail: the throw
  // needs a 250 ms timer to land inside a microsecond-wide window, which is
  // exactly why CI failed twice and a developer box never does. Asserting that
  // the directory STAYS gone takes the timing out of it entirely. Either
  // nothing writes after the delete and it stays gone, or a write recreates it
  // and that is visible on every single run.
  // -------------------------------------------------------------------------

  /** 8x the debounce, so a timer firing late on a loaded box still lands. */
  const RESURRECTION_BUDGET_MS = 2_000;

  async function waitFor(cond: () => boolean, budgetMs: number): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      if (cond()) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('CONTROL: an unflushed debounced save re-creates the directory that was removed (#1339)', async () => {
    // The positive control for the guard below. Without it the guard could pass
    // for the wrong reason — a client that never persisted, a fixture that
    // stopped arming anything, an env var that stopped taking — and none of
    // those are the property #1339 is about. This asserts the mechanism is
    // real, in this process, today, before anything leans on it.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: 'tr1' }), { status: 200 })) as typeof fetch;
    const c = newClient();
    await c.get('/tracks/tr1', {});
    assert.ok(
      existsSync(path.join(dir, 'cache.json.pending')),
      'the read armed the debounce and its marker, so there really is a save in flight to lose track of',
    );

    await rm(dir, { recursive: true, force: true });
    assert.equal(existsSync(dir), false, 'precondition: the directory is gone before the timer fires');

    // Wait on the FILE, not on the directory.
    //
    // `savePersistedCache` does `mkdir(dirname(file), { recursive: true })` and
    // only then `writeFile(tmp)` + `rename(tmp, file)`, so the directory is
    // observable for a window before the file lands. Polling the directory and
    // then asserting on the file reads that intermediate state and fails on a
    // COIN FLIP: measured on this box at up to 16ms between the mkdir and the
    // rename, against a 10ms poll interval, so whether the poll lands inside
    // the window depends on nothing but how the write interleaves. That is the
    // same class of test as the ENOTEMPTY itself — a real failure decided by
    // timing — and it is what CI caught on Node 22.
    //
    // The file is also the stronger claim. It is the last step of the write,
    // it arrives by an atomic `rename` so it has no partial state, and its
    // presence in `dir` implies the directory too — which is exactly what
    // ENOTEMPTY is about. One assertion, no intermediate state to fall into.
    const writeLanded = await waitFor(() => existsSync(path.join(dir, 'cache.json')), RESURRECTION_BUDGET_MS);
    assert.equal(
      writeLanded,
      true,
      `an unflushed save must re-create the directory and complete its write into it within ${RESURRECTION_BUDGET_MS}ms — ` +
        "that write landing is what makes rm's final rmdir fail ENOTEMPTY. If this fails then the mechanism behind " +
        '#1339 is gone, and the guard below is proving nothing.',
    );
  });

  it('a client flushed before teardown cannot resurrect its removed cache directory (#1339)', async () => {
    // The guard. The same sequence as the control, with the flush the teardown
    // now performs. The write lands while the directory is still meant to
    // exist, the timer is cleared instead of left to fire, and so `rm` removes
    // the last of it and nothing arrives afterwards.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: 'tr1' }), { status: 200 })) as typeof fetch;
    const c = newClient();
    await c.get('/tracks/tr1', {});

    await c.flushCachePersist();
    assert.ok(
      existsSync(path.join(dir, 'cache.json')),
      'the flush landed the save while the directory still existed, which is the ordering the fix is about',
    );
    await rm(dir, { recursive: true, force: true });

    await new Promise((r) => setTimeout(r, RESURRECTION_BUDGET_MS));
    assert.equal(
      existsSync(dir),
      false,
      `the directory must stay gone ${RESURRECTION_BUDGET_MS}ms after removal. A debounced save that fires after ` +
        "teardown re-creates it, and rm's final rmdir then fails ENOTEMPTY — which force:true does not suppress.",
    );
  });
});

// ---------------------------------------------------------------------------
// #1266: the debounced save must survive process termination
// ---------------------------------------------------------------------------

describe('cache: persistence survives process exit (#1266)', () => {
  let dir = '';
  let prevPersist: string | undefined;
  let prevDataDir: string | undefined;
  let prevTokenFile: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'spotify-mcp-persist-exit-'));
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

  /**
   * Run one catalog read in a REAL child process and terminate it a given way.
   *
   * This has to be a child process. The defect is that the pending save is
   * dropped when the process ends, so an in-process test could only assert on
   * a controller method and would pass whether or not the *termination* path
   * actually flushed. The child is killed or exits while the 250 ms debounce
   * window is still open, which is the whole case: `SPOTIFY_MCP_CACHE_PERSIST`
   * is documented for hosts that restart the server per session, so a session
   * of one quick read is the ordinary shape, not an exotic one.
   *
   * Returns the exit status alongside the answer, because how the process DIED
   * is part of the claim: a fix that made the server survive SIGTERM instead of
   * stopping would make the file appear and still be wrong.
   */
  async function readThenDie(how: 'exit' | 'sigterm' | 'uncaught'): Promise<{ saved: boolean; signal: string | null; code: number | null }> {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx/esm', path.join(REPO_ROOT, 'tests', 'fixtures', 'persist-exit-child.ts')],
      {
        cwd: REPO_ROOT,
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          SPOTIFY_CLIENT_ID: 'test-client-id',
          SPOTIFY_MCP_CACHE_PERSIST: '1',
          SPOTIFY_MCP_DATA_DIR: dir,
          SPOTIFY_MCP_TOKEN_FILE: path.join(dir, 'tokens.json'),
          SPOTIFY_MCP_PERSIST_EXIT_MODE: how,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    // The child prints `cached` the moment the read is in the cache and the
    // debounce is armed. Waiting for THAT line, rather than a fixed sleep, is
    // what puts the signal reliably inside the window: module loading under
    // tsx takes longer than 250 ms on a cold start, so a timer fired at
    // process spawn would arrive before the read had even happened and would
    // be testing nothing at all.
    const ready = new Promise<void>((resolve) => {
      let seen = '';
      child.stdout.on('data', (c: Buffer) => {
        seen += String(c);
        if (seen.includes('cached')) resolve();
      });
    });

    // The `error` handler is registered INSIDE the executor so it closes over
    // the same `resolve` the `exit` handler uses. It used to be registered
    // after the `new Promise(...)`, where `resolve` is not in scope at all — so
    // a spawn failure raised `ReferenceError: resolve is not defined` inside an
    // event handler instead of settling `exited`, leaving the test hanging on
    // the very failure it was written to report. The executor body runs
    // synchronously, so registering here attaches the listener on the same
    // tick and changes nothing else. tsx strips types, so nothing caught this
    // until `tests/` was typechecked (#1408).
    const exited = new Promise<{ signal: string | null; code: number | null }>((resolve) => {
      child.on('exit', (code, signal) => resolve({ signal, code }));
      child.on('error', () => resolve({ signal: null, code: null }));
    });

    if (how === 'sigterm') {
      await ready;
      child.kill('SIGTERM');
    }
    const { signal, code } = await exited;
    // Allow an uncaught throw to finish unwinding to the `exit` event.
    await new Promise((r) => setTimeout(r, 200));

    const file = path.join(dir, 'cache.json');
    let saved = false;
    if (existsSync(file)) {
      const written = persist.validatePersisted(JSON.parse(await readFile(file, 'utf8')));
      saved = written.entries.some((e) => e.key.includes('/tracks/'));
    }
    return { saved, signal, code };
  }

  it('writes the read even when the process exits inside the debounce window (#1266)', async () => {
    // The reproduction. `process.exit()` inside the window loses the write
    // outright: `exit` listeners run synchronously and the debounce timer is
    // the only thing that would otherwise have performed the save.
    const { saved } = await readThenDie('exit');
    assert.equal(
      saved,
      true,
      'a catalog read made just before process.exit() must still reach the cache file, not be dropped by the 250 ms debounce',
    );
  });

  it('writes the read when an uncaught throw ends the process inside the window (#1266)', async () => {
    // The same synchrony applies: an uncaught throw unwinds straight to the
    // `exit` event with no opportunity to await a pending write.
    const { saved, code } = await readThenDie('uncaught');
    assert.equal(
      saved,
      true,
      'an uncaught throw must not discard a save that was already queued',
    );
    assert.notEqual(code, 0, 'the throw really did fail the process, so the flush did not just ride a clean exit');
  });

  it('writes the read on SIGTERM, and still dies of the signal (#1266)', async () => {
    // SIGTERM is how a host stops a per-session server, and it is the case
    // Node gives you NO JavaScript for by default: no `exit`, no `beforeExit`.
    // A handler has to be installed for the process to get a chance to save.
    const { saved, signal } = await readThenDie('sigterm');
    assert.equal(
      saved,
      true,
      'SIGTERM is how a host stops a per-session server; the pending save must be flushed, not discarded',
    );
    // Installing a handler must not quietly disarm the signal — the process has
    // to still terminate, and still report the signal to whatever supervises it.
    assert.equal(
      signal,
      'SIGTERM',
      'the process must still die OF the signal; a handler that swallows it would leave the server unkillable',
    );
  });

  it('a child that fails to spawn settles the wait instead of hanging (#1408)', async () => {
    // The `error` handler inside `readThenDie` is the only thing that settles
    // `exited` when the child never starts. It used to be registered AFTER the
    // `new Promise(...)`, where `resolve` is not in scope — so the handler
    // threw `ReferenceError` instead of resolving, and the test would hang
    // until the runner timed out rather than reporting the failure.
    //
    // `error` is emitted when the child cannot be SPAWNED — a missing
    // EXECUTABLE, not a missing script. Spawning `node` with a nonexistent
    // script path still produces `exit` (node starts, then fails on the
    // script), so it is the executable that has to be wrong here. Asserting
    // the promise SETTLES is the point: with the handler out of scope it never
    // does, and the race below turns that hang into a named failure instead of
    // a stalled run.
    const settled = await Promise.race([
      new Promise<string>((resolve) => {
        const child = spawn(path.join(dir, 'no-such-executable'), [], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        // Same shape as the fixed registration in `readThenDie`: both handlers
        // inside the executor, closing over the same `settle`.
        const exited = new Promise<{ signal: string | null; code: number | null }>((settle) => {
          child.on('exit', (code, signal) => settle({ signal, code }));
          child.on('error', () => settle({ signal: null, code: null }));
        });
        exited.then(({ signal, code }) => resolve(`settled:signal=${signal}:code=${code}`));
      }),
      new Promise<string>((resolve) => setTimeout(() => resolve('HUNG'), 5_000)),
    ]);

    assert.notEqual(
      settled,
      'HUNG',
      'the wait must settle on a spawn error; an unresolved promise here is the #1408 defect returning',
    );
    assert.match(settled, /^settled:signal=null:code=null$/);
  });

  it('flush() is idempotent and does not double-count a save that already ran (#1266)', async () => {
    // The debounce timer and an explicit flush can both reach the same save.
    // Whichever loses must not count the write twice, or `spotify_doctor`
    // over-reports a save that happened once.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: 'tr1' }), { status: 200 })) as typeof fetch;

    const client = new SpotifyClient();
    await client.get('/tracks/tr1', {});

    const before = client.getRateLimitStatus();
    await (client as unknown as { flushCachePersist(): Promise<void> }).flushCachePersist();
    const afterFirst = client.getRateLimitStatus();
    await (client as unknown as { flushCachePersist(): Promise<void> }).flushCachePersist();
    const afterSecond = client.getRateLimitStatus();

    const file = path.join(dir, 'cache.json');
    assert.ok(existsSync(file), 'the flush wrote the file');
    assert.deepEqual(
      persist.validatePersisted(JSON.parse(await readFile(file, 'utf8'))).entries.map((e) => e.key),
      [cacheKey('GET', '/tracks/tr1')],
      'the flushed file holds exactly the cached read',
    );
    assert.equal(
      afterSecond.cachePersistFailed,
      afterFirst.cachePersistFailed,
      'a second flush with nothing pending must not count another failure',
    );
    assert.equal(
      afterSecond.cachePersistFailed,
      0,
      'a successful flush is not a failure, however many times it is asked for',
    );
    assert.ok(before !== null, 'the pre-flush status is readable');
  });
});

// ---------------------------------------------------------------------------
// #1279: the half that cannot be fixed, and the half that can
// ---------------------------------------------------------------------------

describe('cache: a hard-killed save is reported, not silently dropped (#1279)', () => {
  let dir = '';
  let prevPersist: string | undefined;
  let prevDataDir: string | undefined;
  let prevTokenFile: string | undefined;

  /**
   * The clients this block constructs in ITS OWN process (#1339).
   *
   * The child processes below are deliberately left alone: their unflushed
   * pending save is the thing under test, and this array is not inherited by a
   * spawned process, so flushing here cannot touch it.
   */
  let clients: SpotifyClientType[] = [];
  const newClient = (): SpotifyClientType => {
    const c = new SpotifyClient();
    clients.push(c);
    return c;
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'spotify-mcp-persist-kill-'));
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
    // Quiesce the in-process clients before the directory goes (#1339), for
    // the reason the #893 block does: a read arms a 250 ms debounced save, and
    // a save that fires against a directory being deleted re-creates it and
    // fails `rm`'s final `rmdir` with ENOTEMPTY. The SIGKILL test below is
    // unaffected — its pending save belongs to a child process that is already
    // gone, and nothing here can reach it.
    for (const c of clients) await c.flushCachePersist();
    clients = [];
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * Run one catalog read in a REAL child and SIGKILL it inside the window.
   *
   * SIGKILL is the case no in-process code can address: the kernel ends the
   * process, so no `exit` event, no signal handler, and no pending promise ever
   * runs. Whatever the parent observes afterwards is therefore the honest
   * ceiling of this design, not a shortcoming of the harness.
   */
  async function readThenSigkill(): Promise<{ cacheWritten: boolean; marker: string | null }> {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx/esm', path.join(REPO_ROOT, 'tests', 'fixtures', 'persist-exit-child.ts')],
      {
        cwd: REPO_ROOT,
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          SPOTIFY_CLIENT_ID: 'test-client-id',
          SPOTIFY_MCP_CACHE_PERSIST: '1',
          SPOTIFY_MCP_DATA_DIR: dir,
          SPOTIFY_MCP_TOKEN_FILE: path.join(dir, 'tokens.json'),
          SPOTIFY_MCP_PERSIST_EXIT_MODE: 'sigkill',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const ready = new Promise<void>((resolve) => {
      let seen = '';
      child.stdout.on('data', (c: Buffer) => {
        seen += String(c);
        if (seen.includes('cached')) resolve();
      });
    });
    await ready;
    // SIGKILL, not SIGTERM: the whole point is that no JavaScript runs.
    child.kill('SIGKILL');
    await new Promise((resolve) => child.on('exit', resolve));
    const cacheFile = path.join(dir, 'cache.json');
    const markerFile = path.join(dir, 'cache.json.pending');
    return {
      cacheWritten: existsSync(cacheFile),
      marker: existsSync(markerFile) ? await readFile(markerFile, 'utf8') : null,
    };
  }

  it('SIGKILL really does lose the write — the boundary this fix does NOT cross', async () => {
    // The control for everything below. If a future change made the pending
    // save survive SIGKILL, this would fail — and it should, because the docs
    // promise it cannot. It is here so the claim stays measured rather than
    // asserted from memory.
    const { cacheWritten } = await readThenSigkill();
    assert.equal(
      cacheWritten,
      false,
      'a SIGKILLed process runs no JavaScript, so the pending save cannot land; if this ever passes, the durability claim in docs/configuration.md is stale and must be rewritten',
    );
  });

  it('leaves a marker naming what was lost, so the NEXT process can report it (#1279)', async () => {
    const { marker } = await readThenSigkill();
    assert.notEqual(
      marker,
      null,
      'the marker must be armed before the debounce timer, or a hard kill leaves no evidence at all',
    );
    const parsed = JSON.parse(marker ?? '{}') as { pid?: number; count?: number };
    assert.equal(
      parsed.count,
      1,
      'the marker records how many entries were pending, so the report states a size rather than a bare "something was lost"',
    );
    assert.equal(
      typeof parsed.pid,
      'number',
      'the marker names the process that armed it, so a LIVE process\'s pending save is never read as a dead one\'s loss',
    );
  });

  it('reports the loss on the next start, and only once (#1279)', async () => {
    await readThenSigkill();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: 'tr1' }), { status: 200 })) as typeof fetch;

    const first = newClient();
    // The load that consumes the marker is kicked off in the constructor and
    // is not awaited by it, so drive the queue before reading the status.
    await first.get('/tracks/tr1', {});
    const afterFirstStart = first.getRateLimitStatus();
    assert.equal(
      afterFirstStart.cachePersistLost,
      1,
      'the process after a hard kill must report the entries it never wrote; a silent 0 is the exact failure #1279 describes',
    );

    const second = newClient();
    await second.get('/tracks/tr1', {});
    assert.equal(
      second.getRateLimitStatus().cachePersistLost,
      undefined,
      'the marker is consumed on read, so one hard kill is reported once rather than on every subsequent start',
    );
  });

  it('a clean SIGTERM is NOT reported as a loss — the flush disarms the marker (#1279)', async () => {
    // The false-positive guard. A marker left behind by a save that DID land
    // would report entries as lost that are sitting in the cache file, which
    // would be worse than the silence it replaced.
    const child = spawn(
      process.execPath,
      ['--import', 'tsx/esm', path.join(REPO_ROOT, 'tests', 'fixtures', 'persist-exit-child.ts')],
      {
        cwd: REPO_ROOT,
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          SPOTIFY_CLIENT_ID: 'test-client-id',
          SPOTIFY_MCP_CACHE_PERSIST: '1',
          SPOTIFY_MCP_DATA_DIR: dir,
          SPOTIFY_MCP_TOKEN_FILE: path.join(dir, 'tokens.json'),
          SPOTIFY_MCP_PERSIST_EXIT_MODE: 'sigterm',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const ready = new Promise<void>((resolve) => {
      let seen = '';
      child.stdout.on('data', (c: Buffer) => {
        seen += String(c);
        if (seen.includes('cached')) resolve();
      });
    });
    await ready;
    child.kill('SIGTERM');
    await new Promise((resolve) => child.on('exit', resolve));

    assert.ok(existsSync(path.join(dir, 'cache.json')), 'SIGTERM flushed the write');
    assert.equal(
      existsSync(path.join(dir, 'cache.json.pending')),
      false,
      'the synchronous shutdown flush must clear the marker; a marker left after a landed write would report entries as lost that are in the file',
    );
  });

  it('SIGHUP flushes and still dies of the signal (#1279)', async () => {
    // SIGHUP was an unhandled gap: the server flushed politely on SIGTERM and
    // lost the write on the signal a closing terminal or a supervisor's
    // hard-stop actually sends.
    const child = spawn(
      process.execPath,
      ['--import', 'tsx/esm', path.join(REPO_ROOT, 'tests', 'fixtures', 'persist-exit-child.ts')],
      {
        cwd: REPO_ROOT,
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          SPOTIFY_CLIENT_ID: 'test-client-id',
          SPOTIFY_MCP_CACHE_PERSIST: '1',
          SPOTIFY_MCP_DATA_DIR: dir,
          SPOTIFY_MCP_TOKEN_FILE: path.join(dir, 'tokens.json'),
          SPOTIFY_MCP_PERSIST_EXIT_MODE: 'sighup',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const ready = new Promise<void>((resolve) => {
      let seen = '';
      child.stdout.on('data', (c: Buffer) => {
        seen += String(c);
        if (seen.includes('cached')) resolve();
      });
    });
    const exited = new Promise<{ signal: NodeJS.Signals | null }>((resolve) => {
      child.on('exit', (_code, signal) => resolve({ signal }));
    });
    await ready;
    child.kill('SIGHUP');
    const { signal } = await exited;

    const file = path.join(dir, 'cache.json');
    assert.ok(existsSync(file), 'SIGHUP is an ordinary termination and must flush the pending save');
    const written = persist.validatePersisted(JSON.parse(await readFile(file, 'utf8')));
    assert.ok(
      written.entries.some((e) => e.key.includes('/tracks/')),
      'the flushed file holds the read that was pending when SIGHUP arrived',
    );
    assert.equal(
      signal,
      'SIGHUP',
      'the process must still die OF the signal; a handler that swallowed it would leave the server unkillable by SIGHUP',
    );
  });
});

describe('cache: the pending marker is a description, never a repair (#1279)', () => {
  let dir = '';
  let prevDataDir: string | undefined;
  let prevTokenFile: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'spotify-mcp-marker-'));
    prevDataDir = process.env.SPOTIFY_MCP_DATA_DIR;
    prevTokenFile = process.env.SPOTIFY_MCP_TOKEN_FILE;
    process.env.SPOTIFY_MCP_DATA_DIR = dir;
    process.env.SPOTIFY_MCP_TOKEN_FILE = path.join(dir, 'tokens.json');
  });

  afterEach(async () => {
    if (prevDataDir === undefined) delete process.env.SPOTIFY_MCP_DATA_DIR;
    else process.env.SPOTIFY_MCP_DATA_DIR = prevDataDir;
    if (prevTokenFile === undefined) delete process.env.SPOTIFY_MCP_TOKEN_FILE;
    else process.env.SPOTIFY_MCP_TOKEN_FILE = prevTokenFile;
    await rm(dir, { recursive: true, force: true });
  });

  it('an unreadable marker still reports a loss rather than reading as none (#1279)', async () => {
    // A marker we cannot parse is still evidence that a save was in flight.
    // Reporting "unknown size" and reporting "nothing was lost" are different
    // claims, and only the second one is false.
    const marker = path.join(dir, 'cache.json.pending');
    await writeFile(marker, 'not-a-number', 'utf8');
    assert.equal(
      persist.consumePendingMarker(),
      0,
      'an unparseable marker means the size is unknown, not that nothing was lost — 0 keeps the loss reportable',
    );
    assert.equal(
      persist.consumePendingMarker(),
      null,
      'the marker is consumed, so the same loss is not reported twice',
    );
  });

  it('a marker owned by a LIVE process is not reported as a loss (#1279)', async () => {
    // The false-positive guard, and the bug this design actually hit: two
    // clients in one process, the second of which would read the first's
    // in-flight save as a dead session's loss. Deleting it would be worse
    // still — it would blind the live process to its own pending save.
    const marker = path.join(dir, 'cache.json.pending');
    await writeFile(marker, JSON.stringify({ pid: process.pid, count: 7 }), 'utf8');
    assert.equal(
      persist.consumePendingMarker(),
      null,
      'a save in flight in this very process is not a loss',
    );
    assert.ok(
      existsSync(marker),
      'the live process keeps its marker; consuming it would hide its own pending save from the shutdown flush',
    );
  });

  it('reports null when there is no marker, so a clean exit is not a loss (#1279)', () => {
    assert.equal(
      persist.consumePendingMarker(),
      null,
      'no marker means the previous process exited cleanly; null is the signal that there is nothing to report',
    );
  });

  it('a lost entry is NOT resurrected: the marker carries a count, not the data', async () => {
    // The property that stops this being mistaken for a journal. A count can
    // report a loss; it cannot repair one. If this ever fails, the marker has
    // started holding payloads and the durability claims in the docs are wrong.
    const marker = path.join(dir, 'cache.json.pending');
    // pid -1 cannot name a live process, so this reads as a dead owner.
    await writeFile(marker, JSON.stringify({ pid: -1, count: 3 }), 'utf8');
    const lost = persist.consumePendingMarker();
    assert.equal(lost, 3, 'the count is the whole payload');
    assert.equal(existsSync(path.join(dir, 'cache.json')), false, 'reading the marker creates no cache file');
  });

  it('the marker path is derived from the cache file, so profiles cannot share one', () => {
    // Two accounts must never share a marker, or one profile's hard kill would
    // be reported against the other's cache.
    const a = persist.cachePendingPath({ SPOTIFY_MCP_PROFILE: 'work' } as NodeJS.ProcessEnv);
    const b = persist.cachePendingPath({ SPOTIFY_MCP_PROFILE: 'personal' } as NodeJS.ProcessEnv);
    assert.notEqual(a, b, 'a profile-specific cache must get its own marker');
    assert.ok(a.endsWith('.pending'), 'the marker sits beside its cache file');
  });
});

describe('cache: the debounced save disarms the marker it armed (#1279)', () => {
  let dir = '';
  let prevPersist: string | undefined;
  let prevDataDir: string | undefined;
  let prevTokenFile: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'spotify-mcp-marker-debounce-'));
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

  it('a save that fires on the debounce timer clears the marker (#1279)', async () => {
    // The ordinary path, and the one the shutdown-flush tests never exercise:
    // no process is ending here, the 250 ms timer simply fires. If the async
    // writer left the marker armed, every ordinary session would leave a
    // marker behind, and the next start would report a loss for a save that
    // had in fact landed — the false alarm, permanently, on the happy path.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: 'tr1' }), { status: 200 })) as typeof fetch;

    const client = new SpotifyClient();
    await client.get('/tracks/tr1', {});

    const marker = path.join(dir, 'cache.json.pending');
    assert.ok(
      existsSync(marker),
      'the marker is armed while the save is debouncing, which is the window a hard kill would interrupt',
    );

    // Outlive the debounce so the timer-driven save resolves.
    await new Promise((resolve) => setTimeout(resolve, 250 + 400));

    assert.ok(existsSync(path.join(dir, 'cache.json')), 'the debounced save wrote the cache file');
    assert.equal(
      existsSync(marker),
      false,
      'the timer-driven save must clear the marker it armed; leaving it would make every normal session look like a lost one to the next start',
    );
  });
});
