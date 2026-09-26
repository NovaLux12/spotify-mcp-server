/**
 * Tests for the shared infrastructure modules (#51-#58, #64/#65):
 *   - src/config.ts: loadConfig defaults/overrides, truthyEnv, initConfig/getConfig.
 *   - src/cache.ts: LruTtlCache TTL/expiry/recency/eviction, shouldBypassCache,
 *     cacheKey query-param order normalisation (#678) and the client read
 *     cache built on it.
 *   - src/shaping.ts: truncateItems truncation math + footer, resolveMaxResults
 *     clamping, describeDryRun output shape.
 *   - src/history.ts: JSONL record whitelist, URI redaction, owner-only mode
 *     re-assertion, size-bounded rotation, bounded tail reads — all under os.tmpdir().
 *
 * Run with: node --import tsx --test tests/infra.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// Isolation guard: history tests must never touch ~/.spotify-mcp/history.
const infraDir = await mkdtemp(path.join(tmpdir(), 'spotify-mcp-infra-test-'));
process.env.SPOTIFY_MCP_TOKEN_FILE = path.join(infraDir, 'tokens.json');

const { loadConfig, truthyEnv, initConfig, getConfig, DEFAULT_MAX_ITEMS, DEFAULT_FETCH_ALL_CAP } =
  await import('../src/config.ts');
const { LruTtlCache, shouldBypassCache, cacheKey } = await import('../src/cache.ts');
const { truncateItems, resolveMaxResults, describeDryRun } = await import('../src/shaping.ts');
const { SpotifyClient } = await import('../src/client.ts');
const {
  appendHistory,
  isHistoryEnabled,
  historyFilePath,
  historyMaxBytes,
  redactPath,
  readHistory,
  DEFAULT_HISTORY_MAX_BYTES,
} = await import('../src/history.ts');

// ---------------------------------------------------------------------------
// Config parsing (#53/#55/#61)
// ---------------------------------------------------------------------------

describe('config: loadConfig', () => {
  it('returns documented defaults when the env family is empty', () => {
    const cfg = loadConfig({});
    assert.equal(cfg.maxItems, DEFAULT_MAX_ITEMS);
    assert.equal(cfg.fetchAllCap, DEFAULT_FETCH_ALL_CAP);
    assert.ok(cfg.tokenFile.endsWith(path.join('.spotify-mcp', 'tokens.json')));
    assert.equal(cfg.headless, false);
    assert.equal(cfg.redirectUri, 'http://127.0.0.1:8888/callback');
    assert.equal(cfg.historyEnabled, false);
  });

  it('honours positive integer overrides', () => {
    const cfg = loadConfig({
      SPOTIFY_MCP_MAX_ITEMS: '120',
      SPOTIFY_MCP_FETCH_ALL_CAP: '42',
    });
    assert.equal(cfg.maxItems, 120);
    assert.equal(cfg.fetchAllCap, 42);
  });

  it('falls back to defaults on non-positive or garbage integers', () => {
    for (const bad of ['abc', '0', '-5', '', undefined]) {
      const cfg = loadConfig({ SPOTIFY_MCP_MAX_ITEMS: bad });
      assert.equal(cfg.maxItems, DEFAULT_MAX_ITEMS, `SPOTIFY_MCP_MAX_ITEMS=${String(bad)}`);
    }
  });

  it('truncates fractional values via integer parsing (3.7 -> 3)', () => {
    const cfg = loadConfig({ SPOTIFY_MCP_MAX_ITEMS: '3.7' });
    assert.equal(cfg.maxItems, 3);
  });

  it('honours token file, redirect URI, headless and history overrides', () => {
    const cfg = loadConfig({
      SPOTIFY_MCP_TOKEN_FILE: '/tmp/custom-tokens.json',
      SPOTIFY_REDIRECT_URI: 'http://127.0.0.1:9000/callback',
      SPOTIFY_HEADLESS: '1',
      SPOTIFY_MCP_HISTORY: 'true',
    });
    assert.equal(cfg.tokenFile, '/tmp/custom-tokens.json');
    assert.equal(cfg.redirectUri, 'http://127.0.0.1:9000/callback');
    assert.equal(cfg.headless, true);
    assert.equal(cfg.historyEnabled, true);
  });
});

describe('config: truthyEnv', () => {
  it('accepts the documented truthy spellings case-insensitively', () => {
    for (const raw of ['1', 'true', 'TRUE', 'Yes', 'on', ' yes ']) {
      assert.equal(truthyEnv(raw), true, `truthyEnv(${JSON.stringify(raw)})`);
    }
  });

  it('rejects everything else, including undefined and empty', () => {
    for (const raw of [undefined, '', '0', 'false', 'no', 'off', 'maybe']) {
      assert.equal(truthyEnv(raw), false, `truthyEnv(${JSON.stringify(raw)})`);
    }
  });
});

describe('config: initConfig/getConfig binding', () => {
  afterEach(() => {
    initConfig(); // restore process-wide snapshot from real env
  });

  it('getConfig reflects the most recent initConfig snapshot', () => {
    initConfig({ ...process.env, SPOTIFY_MCP_MAX_ITEMS: '77' });
    assert.equal(getConfig().maxItems, 77);

    initConfig(); // back to process.env defaults
    assert.equal(getConfig().maxItems, DEFAULT_MAX_ITEMS);
  });

  it('getConfig lazily initializes instead of throwing', () => {
    // getConfig() must never return null/undefined even before any explicit init.
    assert.equal(typeof getConfig().fetchAllCap, 'number');
  });
});

// ---------------------------------------------------------------------------
// LruTtlCache (#54)
// ---------------------------------------------------------------------------

describe('cache: LruTtlCache', () => {
  it('stores and retrieves values, reporting size', () => {
    const cache = new LruTtlCache<string>();
    assert.equal(cache.size, 0);
    cache.set('a', 'alpha');
    cache.set('b', 'beta');
    assert.equal(cache.size, 2);
    assert.equal(cache.get('a'), 'alpha');
    assert.equal(cache.get('missing'), undefined);
  });

  it('expires entries after their TTL', async () => {
    const cache = new LruTtlCache<string>({ ttlMs: 10 });
    cache.set('k', 'v');
    assert.equal(cache.get('k'), 'v');
    await sleep(25);
    assert.equal(cache.get('k'), undefined, 'entry expired');
    assert.equal(cache.size, 0, 'expired entry was dropped on read');
  });

  it('honours per-entry TTL overrides over the default TTL', async () => {
    const cache = new LruTtlCache<string>({ ttlMs: 60_000 });
    cache.set('short', 'x', 5);
    cache.set('long', 'y');
    await sleep(25);
    assert.equal(cache.get('short'), undefined);
    assert.equal(cache.get('long'), 'y');
  });

  it('evicts the least-recently-used entry beyond maxEntries', () => {
    const cache = new LruTtlCache<number>({ maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    assert.equal(cache.get('a'), 1); // refresh recency: b is now LRU
    cache.set('c', 3); // evicts b
    assert.equal(cache.get('b'), undefined, 'least recently used entry was evicted');
    assert.equal(cache.get('a'), 1);
    assert.equal(cache.get('c'), 3);
    assert.equal(cache.size, 2);
  });

  it('set overwrites an existing key without growing the map', () => {
    const cache = new LruTtlCache<number>({ maxEntries: 2 });
    cache.set('a', 1);
    cache.set('a', 9);
    assert.equal(cache.size, 1);
    assert.equal(cache.get('a'), 9);
  });

  it('delete and clear remove entries', () => {
    const cache = new LruTtlCache<number>();
    cache.set('a', 1);
    cache.set('b', 2);
    cache.delete('a');
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.get('b'), 2);
    cache.clear();
    assert.equal(cache.size, 0);
    assert.equal(cache.get('b'), undefined);
  });
});

describe('cache: policy helpers (#54)', () => {
  it('bypasses non-GET methods regardless of path', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'post']) {
      assert.equal(shouldBypassCache(method, '/albums'), true, method);
    }
  });

  it('bypasses volatile prefixes, including with query strings', () => {
    assert.equal(shouldBypassCache('GET', '/me/player'), true);
    assert.equal(shouldBypassCache('GET', '/me/player/devices'), true);
    assert.equal(shouldBypassCache('GET', '/me/player?market=US'), true);
    assert.equal(shouldBypassCache('GET', '/me/top/tracks'), true);
    assert.equal(shouldBypassCache('GET', '/me/top/artists?limit=5'), true);
  });

  it('allows plain immutable GET catalog reads', () => {
    assert.equal(shouldBypassCache('GET', '/albums/4aawyAB9vmqZ3ueQd27Cgr'), false);
    assert.equal(shouldBypassCache('GET', '/me'), false);
    assert.equal(shouldBypassCache('GET', '/playlists/abc/tracks?limit=50'), false);
  });

  it('builds order-insensitive keys over method+path+params', () => {
    assert.equal(cacheKey('GET', '/x', { a: '1', b: '2' }), cacheKey('GET', '/x', { b: '2', a: '1' }));
    assert.equal(
      cacheKey('get', '/albums', { market: 'US', limit: '5' }),
      cacheKey('GET', '/albums', { limit: '5', market: 'US' }),
    );
    assert.notEqual(
      cacheKey('GET', '/albums', { limit: '5' }),
      cacheKey('GET', '/albums', { limit: '10' }),
    );
    assert.equal(cacheKey('GET', '/me'), 'GET /me ');
  });

  // #678: the request target carries its query inline, so before this the
  // two equivalent forms below produced two different keys and the second
  // read missed the cache.
  it('treats a query string inside the path as params, order-insensitively', () => {
    assert.equal(
      cacheKey('GET', '/search?type=album&q=beatles'),
      cacheKey('GET', '/search?q=beatles&type=album'),
    );
    // Inline query, reordered params object, and a mix of both: one entry.
    const inline = cacheKey('GET', '/search?type=album&q=beatles&limit=10');
    assert.equal(inline, cacheKey('GET', '/search?q=beatles&limit=10', { type: 'album' }));
    assert.equal(inline, cacheKey('GET', '/search?limit=10', { q: 'beatles', type: 'album' }));
    // Percent-encoded on the wire, decoded in the params object.
    assert.equal(
      cacheKey('GET', '/search?q=rock%20%26%20roll'),
      cacheKey('GET', '/search', { q: 'rock & roll' }),
    );
    // A repeated name is resolved by the value tiebreak, not by arrival
    // order, so the same multiset cannot take two entries. Every occurrence
    // survives: a name→value map would drop all but the last and collapse
    // two different multisets onto one key.
    assert.equal(cacheKey('GET', '/search?a=1&a=2'), cacheKey('GET', '/search?a=2&a=1'));
    assert.notEqual(cacheKey('GET', '/search?a=1&a=2'), cacheKey('GET', '/search?a=2&a=2'));
  });

  it('keeps entries apart when any param name or value differs', () => {
    const base = cacheKey('GET', '/search?q=beatles&type=album');
    assert.notEqual(base, cacheKey('GET', '/search?q=roller&type=album'), 'value differs');
    assert.notEqual(base, cacheKey('GET', '/search?q=beatles&type=artist'), 'value differs');
    assert.notEqual(base, cacheKey('GET', '/search?type=album'), 'a param is missing');
    assert.notEqual(
      cacheKey('GET', '/search?q=beatles&type=album'),
      cacheKey('GET', '/search?q=beatles&type=album&limit=5'),
      'extra param must not collapse into the shorter key',
    );
    assert.notEqual(
      cacheKey('GET', '/search?q=a&limit=1'),
      cacheKey('GET', '/search?q=limit&limit=a'),
      'name/value boundaries must not alias',
    );
    assert.notEqual(
      cacheKey('GET', '/albums?q=beatles'),
      cacheKey('GET', '/artists?q=beatles'),
      'different path',
    );
  });

  it('is stable across key orderings of more than two params', () => {
    const orders = [
      { q: 'beatles', type: 'album', limit: '5', market: 'US' },
      { market: 'US', limit: '5', type: 'album', q: 'beatles' },
      { type: 'album', q: 'beatles', market: 'US', limit: '5' },
    ];
    const keys = orders.map((o) => cacheKey('GET', '/search', o));
    assert.equal(new Set(keys).size, 1, keys.join(' | '));
  });
 });

// ---------------------------------------------------------------------------
// Client read cache: order-insensitive keys, no value collisions (#678)
// ---------------------------------------------------------------------------

describe('client: read cache keys (#678)', () => {
  const realFetch = globalThis.fetch;
  const tokenFile = path.join(infraDir, 'tokens.json');
  // Every URL the stubbed fetch saw, and how many bodies it served.
  let urls: string[] = [];
  let served = 0;

  beforeEach(async () => {
    urls = [];
    served = 0;
    // A far-future expiry keeps the client out of its refresh window, so the
    // request count below counts API reads only.
    await writeFile(
      tokenFile,
      JSON.stringify({ access_token: 'tok-cache', refresh_token: 'ref-cache', expires_at: Date.now() + 3600_000 }),
      'utf8',
    );
    globalThis.fetch = (async (url: unknown) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ call: ++served }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('issues one fetch and one entry for the same params in two orders', async () => {
    const client = new SpotifyClient();
    const first = await client.get<{ call: number }>('/albums', { limit: '5', offset: '0' });
    // Byte-for-byte the same request, params object in the other key order.
    const reordered = await client.get<{ call: number }>('/albums', { offset: '0', limit: '5' });
    assert.deepEqual(reordered, first, 'the reordered call re-fetched instead of hitting the cache');
    assert.equal(served, 1, `expected one fetch, got ${urls.join(', ')}`);
    assert.equal(client.cache?.size, 1, 'reordered params created a second cache entry');

    // A changed VALUE must not collide with the cached entry.
    const other = await client.get<{ call: number }>('/albums', { limit: '5', offset: '20' });
    assert.equal(other.call, 2, 'a changed param value reused the cached response');
    assert.equal(client.cache?.size, 2);
  });

  it('serves an inline query string from the same entry as the params object', async () => {
    const client = new SpotifyClient();
    const inline = await client.get<{ call: number }>('/search?type=album&q=beatles');
    const viaParams = await client.get<{ call: number }>('/search', { q: 'beatles', type: 'album' });
    assert.deepEqual(viaParams, inline);
    assert.equal(served, 1, `expected one fetch, got ${urls.join(', ')}`);
    assert.equal(client.cache?.size, 1);
    assert.equal(urls[0], 'https://api.spotify.com/v1/search?type=album&q=beatles');
  });
});

// ---------------------------------------------------------------------------
// Shaping: truncation math + footer (#53) and dry-run description (#57)
// ---------------------------------------------------------------------------

describe('shaping: truncateItems', () => {
  const items = Array.from({ length: 10 }, (_, i) => i);

  it('passes through short lists untruncated with no footer', () => {
    const r = truncateItems([1, 2, 3], 50);
    assert.deepEqual(r.items, [1, 2, 3]);
    assert.equal(r.total, 3);
    assert.equal(r.returned, 3);
    assert.equal(r.truncated, false);
    assert.equal(r.remaining, 0);
    assert.equal(r.footer, null);
  });

  it('slices exactly at the cap and computes footer counts', () => {
    const r = truncateItems(items, 4);
    assert.deepEqual(r.items, [0, 1, 2, 3]);
    assert.equal(r.total, 10);
    assert.equal(r.returned, 4);
    assert.equal(r.truncated, true);
    assert.equal(r.remaining, 6);
    assert.match(r.footer ?? '', /^6 more — /);
    assert.match(r.footer ?? '', /offset|fetch_all/);
  });

  it('does not mutate the input array', () => {
    const input = [1, 2, 3, 4];
    truncateItems(input, 2);
    assert.equal(input.length, 4);
  });

  it('clamps degenerate caps to at least one item', () => {
    const r = truncateItems([1, 2], 0);
    assert.equal(r.returned, 1);
    assert.deepEqual(r.items, [1]);
  });
});

describe('shaping: resolveMaxResults', () => {
  it('prefers an explicit positive argument', () => {
    assert.equal(resolveMaxResults(17, 50), 17);
  });

  it('falls back when explicit is missing or invalid', () => {
    assert.equal(resolveMaxResults(undefined, 33), 33);
    assert.equal(resolveMaxResults(0, 33), 33);
    assert.equal(resolveMaxResults(-4, 33), 33);
    assert.equal(resolveMaxResults(Number.NaN, 33), 33);
    assert.equal(resolveMaxResults(undefined, DEFAULT_MAX_ITEMS), DEFAULT_MAX_ITEMS);
  });

  it('floors fractional values and never returns below 1', () => {
    assert.equal(resolveMaxResults(7.9, 50), 7);
    assert.equal(resolveMaxResults(undefined, 0.4), 1);
  });
});

describe('shaping: describeDryRun (#57)', () => {
  it('states that nothing was changed, even with no changes listed', () => {
    const out = describeDryRun('remove items', 'playlist abc', []);
    assert.match(out, /\[dry run\]/);
    assert.match(out, /remove items on playlist abc/);
    assert.match(out, /nothing was changed/i);
    assert.ok(!out.includes('Would affect'));
  });

  it('lists each change with correct singular/plural counting', () => {
    const single = describeDryRun('reorder', 'pl 1', ['move track x']);
    assert.match(single, /Would affect 1 item:/);
    assert.match(single, /- move track x/);

    const multi = describeDryRun('add', 'pl 2', ['spotify:track:a', 'spotify:track:b']);
    assert.match(multi, /Would affect 2 items:/);
    assert.match(multi, /- spotify:track:a/);
    assert.match(multi, /- spotify:track:b/);
  });

  it('is deterministic for identical inputs', () => {
    assert.equal(
      describeDryRun('unfollow', 'u1', ['a', 'b']),
      describeDryRun('unfollow', 'u1', ['a', 'b']),
    );
  });
});

// ---------------------------------------------------------------------------
// History JSONL whitelist (#64)
// ---------------------------------------------------------------------------

describe('history: JSONL mutation records', () => {
  let histDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    histDir = await mkdtemp(path.join(tmpdir(), 'spotify-mcp-history-test-'));
    savedEnv['SPOTIFY_MCP_HISTORY'] = process.env.SPOTIFY_MCP_HISTORY;
    savedEnv['SPOTIFY_MCP_HISTORY_DIR'] = process.env.SPOTIFY_MCP_HISTORY_DIR;
    savedEnv['SPOTIFY_MCP_HISTORY_MAX_BYTES'] = process.env.SPOTIFY_MCP_HISTORY_MAX_BYTES;
    process.env.SPOTIFY_MCP_HISTORY = '1';
    process.env.SPOTIFY_MCP_HISTORY_DIR = histDir;
    delete process.env.SPOTIFY_MCP_HISTORY_MAX_BYTES;
  });

  afterEach(async () => {
    process.env.SPOTIFY_MCP_HISTORY = savedEnv['SPOTIFY_MCP_HISTORY'];
    process.env.SPOTIFY_MCP_HISTORY_DIR = savedEnv['SPOTIFY_MCP_HISTORY_DIR'];
    if (savedEnv['SPOTIFY_MCP_HISTORY_MAX_BYTES'] === undefined) delete process.env.SPOTIFY_MCP_HISTORY_MAX_BYTES;
    else process.env.SPOTIFY_MCP_HISTORY_MAX_BYTES = savedEnv['SPOTIFY_MCP_HISTORY_MAX_BYTES'];
    await rm(histDir, { recursive: true, force: true });
  });

  it('reports enabled state and resolved file path from env', () => {
    assert.equal(isHistoryEnabled(), true);
    assert.equal(historyFilePath(), path.join(histDir, 'mutations.jsonl'));

    process.env.SPOTIFY_MCP_HISTORY = '';
    assert.equal(isHistoryEnabled(), false);
  });

  it('writes only the whitelisted fields, one JSON object per line', async () => {
    // A stray extra field must never reach disk (no tokens/bodies leakage).
    const leaky = Object.assign(
      { method: 'put', path: '/playlists/p1/items', who: 'agent' },
      { access_token: 'SECRET', request_body: '{"uris":["spotify:track:x"]}' },
    );
    await appendHistory(leaky as Parameters<typeof appendHistory>[0]);

    const raw = await readFile(path.join(histDir, 'mutations.jsonl'), 'utf8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 1);

    const rec = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.deepEqual(Object.keys(rec).sort(), ['method', 'path', 'target', 'ts', 'who']);
    assert.equal(rec.method, 'PUT', 'method uppercased');
    assert.equal(rec.path, '/playlists/p1/items', 'route vocabulary survives redaction');
    assert.equal(rec.who, 'agent');
    assert.ok(typeof rec.ts === 'string' && !Number.isNaN(Date.parse(String(rec.ts))));
    assert.ok(!raw.includes('SECRET'), 'token-like payload never persisted');
  });

  it('defaults who to "agent" and omits snapshot_id when absent', async () => {
    await appendHistory({ method: 'delete', path: '/tracks/x' });

    const rec = JSON.parse(
      (await readFile(path.join(histDir, 'mutations.jsonl'), 'utf8')).trim(),
    ) as Record<string, unknown>;
    assert.equal(rec.who, 'agent');
    assert.equal('snapshot_id' in rec, false);
  });

  it('persists snapshot_id when provided (undo anchor)', async () => {
    await appendHistory({
      method: 'post',
      path: '/playlists/p2/items',
      snapshot_id: 'snap-123',
    });

    const rec = JSON.parse(
      (await readFile(path.join(histDir, 'mutations.jsonl'), 'utf8')).trim(),
    ) as Record<string, unknown>;
    assert.equal(rec.snapshot_id, 'snap-123');
  });

  it('appends multiple mutations as separate lines', async () => {
    await appendHistory({ method: 'post', path: '/a' });
    await appendHistory({ method: 'put', path: '/b' });

    const lines = (await readFile(path.join(histDir, 'mutations.jsonl'), 'utf8'))
      .trim()
      .split('\n');
    assert.equal(lines.length, 2);
    assert.equal((JSON.parse(lines[0]) as { path: string }).path, '/a');
    assert.equal((JSON.parse(lines[1]) as { path: string }).path, '/b');
  });

  it('writes nothing while history is disabled', async () => {
    process.env.SPOTIFY_MCP_HISTORY = '0';
    await appendHistory({ method: 'post', path: '/quiet' });

    await assert.rejects(readFile(path.join(histDir, 'mutations.jsonl'), 'utf8'), {
      code: 'ENOENT',
    });
  });

  it('creates the directory tree on demand', async () => {
    process.env.SPOTIFY_MCP_HISTORY_DIR = path.join(histDir, 'nested', 'deeper');
    await appendHistory({ method: 'post', path: '/deep' });
    const raw = await readFile(
      path.join(histDir, 'nested', 'deeper', 'mutations.jsonl'),
      'utf8',
    );
    assert.match(raw, /"path":"\/deep"/);
  });

  // --- #628 property 1: no raw URI payload is persisted ---------------------

  it('persists no raw playlist/track URI — only a route template and a fingerprint', async () => {
    const playlistId = '37i9dQZF1DXcBWIGoYBM5M';
    const trackUri = 'spotify:track:4uLU6hMCjMI75M1A2tKUQC';
    await appendHistory({
      method: 'put',
      path: `/me/library?uris=${encodeURIComponent(trackUri)}`,
    });
    await appendHistory({
      method: 'post',
      path: `/playlists/${playlistId}/items`,
      snapshot_id: 'snap-9',
    });

    const raw = await readFile(path.join(histDir, 'mutations.jsonl'), 'utf8');
    assert.ok(!raw.includes(trackUri), 'item URI from the query string never persisted');
    assert.ok(!raw.includes('spotify:track'), 'no spotify: URI scheme fragment persisted');
    assert.ok(!raw.includes(playlistId), 'playlist id never persisted');
    assert.ok(!raw.includes('uris='), 'raw query string never persisted');

    const rows = raw.trim().split('\n').map((l) => JSON.parse(l) as { path: string; target: string });
    assert.deepEqual(rows.map((r) => r.path), ['/me/library', '/playlists/{id}/items']);
    // "What changed" is still answerable: which route, which method, and a
    // stable per-target fingerprint that repeats for the same target.
    assert.equal(rows[0].target.length, 16);
    await appendHistory({ method: 'put', path: `/me/library?uris=${encodeURIComponent(trackUri)}` });
    const after = (await readHistory()).filter((r) => r.path === '/me/library');
    assert.equal(after.length, 2);
    assert.equal(after[0].target, after[1].target, 'same target hashes to the same fingerprint');
  });

  it('redactPath collapses ids, URI fragments and query strings but keeps route vocabulary', () => {
    assert.equal(redactPath('/me/player/pause'), '/me/player/pause');
    assert.equal(redactPath('/playlists/37i9dQZF1DXcBWIGoYBM5M/items'), '/playlists/{id}/items');
    assert.equal(redactPath('/me/library?uris=spotify%3Atrack%3Aabc'), '/me/library');
    assert.equal(redactPath('/me/tracks/spotify:track:abc'), '/me/tracks/{id}');
    assert.equal(redactPath('/users/someuser_1234567890abcd/playlists'), '/users/{id}/playlists');
    assert.equal(redactPath('/playlists/{id}/items'), '/playlists/{id}/items', 'idempotent');
  });

  // --- #628 property 2: owner-only mode, not just at creation ---------------

  it('tightens a pre-existing world-readable ledger to 0600 on the next write', async () => {
    const file = path.join(histDir, 'mutations.jsonl');
    await writeFile(file, '{"ts":"2020-01-01T00:00:00.000Z","who":"agent","method":"PUT","path":"/me/library"}\n');
    await chmod(file, 0o644);
    assert.equal((await stat(file)).mode & 0o777, 0o644, 'precondition: copied-in loose mode');

    await appendHistory({ method: 'put', path: '/me/library' });

    assert.equal((await stat(file)).mode & 0o777, 0o600);
  });

  it('tightens a pre-existing world-readable history directory to 0700', async () => {
    const dir = path.join(histDir, 'loose');
    await mkdir(dir, { recursive: true, mode: 0o755 });
    await chmod(dir, 0o755);
    process.env.SPOTIFY_MCP_HISTORY_DIR = dir;

    await appendHistory({ method: 'put', path: '/me/library' });

    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(dir, 'mutations.jsonl'))).mode & 0o777, 0o600);
  });

  // --- #628 property 3: bounded growth and bounded reads -------------------

  it('rotates the ledger so total on-disk history stays within 2x the cap', async () => {
    process.env.SPOTIFY_MCP_HISTORY_MAX_BYTES = '2048';
    assert.equal(historyMaxBytes(), 2048);
    for (let i = 0; i < 200; i++) {
      await appendHistory({ method: 'put', path: `/me/library?uris=spotify%3Atrack%3A${i}` });
    }

    const live = await stat(path.join(histDir, 'mutations.jsonl'));
    const archive = await stat(path.join(histDir, 'mutations.jsonl.1'));
    assert.ok(live.size <= 2048 + 512, `live ledger grew past the cap: ${live.size}`);
    assert.ok(live.size + archive.size <= 2 * 2048 + 512, `ledger unbounded: ${live.size}+${archive.size}`);
    assert.ok(archive.size > 0, 'rotation actually happened');
    assert.equal(archive.mode & 0o777, 0o600, 'rotated archive is owner-only too');
    // Rotation is lossy by design — but the newest records must survive.
    const rows = await readHistory({ limit: 1 });
    assert.equal(rows.length, 1);
    assert.match(String(rows[0].target), /^[0-9a-f]{16}$/);
  });

  it('defaults the rotation cap and ignores a nonsense override', () => {
    assert.equal(historyMaxBytes({}), DEFAULT_HISTORY_MAX_BYTES);
    assert.equal(historyMaxBytes({ SPOTIFY_MCP_HISTORY_MAX_BYTES: '0' }), DEFAULT_HISTORY_MAX_BYTES);
    assert.equal(historyMaxBytes({ SPOTIFY_MCP_HISTORY_MAX_BYTES: 'abc' }), DEFAULT_HISTORY_MAX_BYTES);
    assert.equal(historyMaxBytes({ SPOTIFY_MCP_HISTORY_MAX_BYTES: '4096' }), 4096);
  });

  it('readHistory returns at most limit records for an arbitrarily large ledger', async () => {
    // 5,000 records ≈ 700 KB. Pre-fix, readers did
    // `readFile(...).split('\n')` and materialized every line; the bounded
    // reader must return 25 newest and nothing more.
    const records = Array.from({ length: 5000 }, (_, i) =>
      JSON.stringify({ ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), who: 'agent', method: 'PUT', path: '/me/library', target: `t${i}` }),
    ).join('\n');
    const file = path.join(histDir, 'mutations.jsonl');
    await writeFile(file, records + '\n');
    assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 5000, 'precondition: the ledger is genuinely large');

    const rows = await readHistory({ limit: 25 });
    assert.equal(rows.length, 25);
    assert.equal(rows[24].target, 't4999', 'newest record retained');
    assert.equal(rows[0].target, 't4975', 'oldest of the retained window');
  });

  it('readHistory spans the rotation boundary in chronological order', async () => {
    process.env.SPOTIFY_MCP_HISTORY_MAX_BYTES = '2048';
    for (let i = 0; i < 200; i++) {
      await appendHistory({ method: 'put', path: `/me/library?uris=spotify%3Atrack%3A${i}` });
    }
    await appendHistory({ method: 'delete', path: '/me/tracks/37i9dQZF1DXcBWIGoYBM5M' });

    const rows = await readHistory({ limit: 500 });
    const methods = rows.map((r) => r.method);
    assert.ok(methods.length > 1, 'records came from both generations');
    assert.equal(methods.filter((m) => m === 'DELETE').length, 1, 'live generation read last');
    const times = rows.map((r) => String(r.ts));
    assert.deepEqual(times, [...times].sort(), 'records returned oldest-first');
    // Nothing is lost at the seam: every line in both generations is returned.
    const count = async (p: string) => (await readFile(p, 'utf8')).trim().split('\n').filter(Boolean).length;
    const onDisk = (await count(path.join(histDir, 'mutations.jsonl.1'))) + (await count(path.join(histDir, 'mutations.jsonl')));
    assert.equal(rows.length, Math.min(onDisk, 500));
    assert.ok(onDisk > 1, 'precondition: both generations hold records');
  });

  it('readHistory skips torn/unparseable lines instead of failing the read', async () => {
    await writeFile(
      path.join(histDir, 'mutations.jsonl'),
      '{"method":"PUT","path":"/me/library","target":"a"}\n{"method":"PUT","path":"/me/lib\n',
    );
    const rows = await readHistory();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].target, 'a');
  });

  it('readHistory returns an empty list when no ledger exists', async () => {
    assert.deepEqual(await readHistory(), []);
  });
});
