/**
 * Tests for the shared infrastructure modules (#51-#58, #64/#65):
 *   - src/config.ts: loadConfig defaults/overrides, truthyEnv, initConfig/getConfig.
 *   - src/cache.ts: LruTtlCache TTL/expiry/recency/eviction, shouldBypassCache,
 *     cacheKey param-order insensitivity.
 *   - src/shaping.ts: truncateItems truncation math + footer, resolveMaxResults
 *     clamping, describeDryRun output shape.
 *   - src/history.ts: JSONL record whitelist (only whitelisted fields ever hit
 *     disk), enabled/disabled gating, env-dir override — all under os.tmpdir().
 *
 * Run with: node --import tsx --test tests/infra.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
const { appendHistory, isHistoryEnabled, historyFilePath } = await import('../src/history.ts');

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
    process.env.SPOTIFY_MCP_HISTORY = '1';
    process.env.SPOTIFY_MCP_HISTORY_DIR = histDir;
  });

  afterEach(async () => {
    process.env.SPOTIFY_MCP_HISTORY = savedEnv['SPOTIFY_MCP_HISTORY'];
    process.env.SPOTIFY_MCP_HISTORY_DIR = savedEnv['SPOTIFY_MCP_HISTORY_DIR'];
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
    assert.deepEqual(Object.keys(rec).sort(), ['method', 'path', 'ts', 'who']);
    assert.equal(rec.method, 'PUT', 'method uppercased');
    assert.equal(rec.path, '/playlists/p1/items');
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
});
