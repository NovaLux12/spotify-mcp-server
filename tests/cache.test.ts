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

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
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
const { TOKEN_FILE } = await import('../src/auth.ts');

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
