/**
 * Tiny LRU + TTL cache used by SpotifyClient for immutable catalog reads
 * (#54). Pure data structure plus a pure cache-policy predicate — no I/O,
 * no client imports.
 */

export const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
export const DEFAULT_CACHE_MAX_ENTRIES = 200;

export interface LruTtlCacheOptions {
  /** Entry lifetime in ms. Default 5 minutes (#54). */
  ttlMs?: number;
  /** Maximum entries before the least-recently-used entry is evicted. */
  maxEntries?: number;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class LruTtlCache<V> {
  private readonly map = new Map<string, Entry<V>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(opts: LruTtlCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_CACHE_TTL_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
  }

  get size(): number {
    return this.map.size;
  }

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh recency: delete + re-insert moves the key to Map's tail.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, ttlMs?: number): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + (ttlMs ?? this.ttlMs) });
    while (this.map.size > this.maxEntries) {
      // Map iterates insertion order; the first key is least recently used.
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

// Paths whose responses change out from under us (live playback state,
// personal charts) or that mutate server state — never cached (#54).
const VOLATILE_PATH_PREFIXES = ['/me/player', '/me/top'];

/**
 * Cache policy: bypass for anything non-GET, volatile prefixes (/me/player*,
 * /me/top*, which includes recently-played), and any mutation path.
 */
export function shouldBypassCache(method: string, path: string): boolean {
  if (method.toUpperCase() !== 'GET') return true;
  const cleanPath = path.split('?')[0];
  return VOLATILE_PATH_PREFIXES.some((prefix) => cleanPath.startsWith(prefix));
}

/**
 * Split an API-relative request target into its query-free path and its
 * ordered [name, value] pairs. The inline branch is the live one, not
 * defence: the sole production call site, `cacheKey('GET', relative)` in
 * SpotifyClient.get (src/client.ts:592), is handed `buildUrl`'s output
 * (src/client.ts:455-459), which appends `?${new URLSearchParams(params)}`.
 * The split is therefore what makes a params-bearing read keyable at all,
 * and what lets a composed target and a params object meet on one key.
 */
function splitQuery(target: string): { path: string; pairs: Array<[string, string]> } {
  const mark = target.indexOf('?');
  if (mark === -1) return { path: target, pairs: [] };
  const pairs: Array<[string, string]> = [];
  // Iterating URLSearchParams keeps every occurrence of a repeated name and
  // percent-decodes values, so `?q=a%20b` and `{ q: 'a b' }` agree.
  for (const [name, value] of new URLSearchParams(target.slice(mark + 1))) {
    pairs.push([name, value]);
  }
  return { path: target.slice(0, mark), pairs };
}

/**
 * Stable key over method + path + params (params order-insensitive). Pairs
 * are sorted by name, then by value, in UTF-16 code-unit order — not
 * localeCompare, which varies by environment and would make keys unstable
 * across processes. Requests differing in any name or any value keep distinct
 * keys.
 *
 * Callers keep the query out of the path they hand `get`: no `get`/
 * `getAllPages` call site in `src/` passes a target containing `?`, and the
 * only `?`-bearing path builders either feed `put`/`post`/`delete`, all of
 * which `shouldBypassCache` skips (tools/library.ts `savedItemsPath`), or are
 * split before the call (tools/exhaust2_misc.ts). So `params` is the
 * defensive argument — no call site in `src/` passes it; production always
 * arrives through `splitQuery`'s inline branch.
 *
 * Repeated names (`?a=1&a=2`) are value-sorted like any other pair, so
 * `?a=1&a=2` and `?a=2&a=1` share an entry. That is sound for the Spotify Web
 * API: query params are an unordered multimap, and every list-valued param
 * this server builds (`ids`, `fields`) is comma-joined into a single value.
 */
export function cacheKey(method: string, path: string, params?: Record<string, string>): string {
  const { path: cleanPath, pairs } = splitQuery(path);
  if (params) for (const [name, value] of Object.entries(params)) pairs.push([name, value]);
  let serializedParams = '';
  if (pairs.length > 0) {
    pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    serializedParams = JSON.stringify(pairs);
  }
  return `${method.toUpperCase()} ${cleanPath} ${serializedParams}`;
}
