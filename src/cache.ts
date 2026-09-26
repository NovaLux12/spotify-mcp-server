/**
 * Tiny LRU + TTL cache used by SpotifyClient for immutable catalog reads
 * (#54). Pure data structure plus a pure cache-policy predicate — no I/O,
 * no client imports.
 */

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_CACHE_MAX_ENTRIES = 200;
/**
 * Total retained-payload budget (#894). A count bound is not a memory bound:
 * one 100-track playlist page is ~150 KB of parsed JSON, so 200 of them is
 * ~30 MB on a ~156 MB RSS baseline, while 200 tiny catalogue reads are
 * nothing. 8 MB keeps the cache worth having without letting a single class
 * of read dominate the process.
 */
const DEFAULT_CACHE_MAX_BYTES = 8 * 1024 * 1024;
/**
 * Per-entry ceiling (#894). An entry larger than this is never stored, so one
 * huge response cannot flush the whole cache on its way in and cannot make
 * the byte budget unreachable. Skips are counted, not silent — see
 * {@link LruTtlCache.skippedOversize}.
 */
const DEFAULT_CACHE_MAX_ENTRY_BYTES = 1024 * 1024;

interface LruTtlCacheOptions {
  /** Entry lifetime in ms. Default 5 minutes (#54). */
  ttlMs?: number;
  /** Maximum entries before the least-recently-used entry is evicted. */
  maxEntries?: number;
  /** Total retained-payload budget in bytes (#894). Default 8 MB. */
  maxBytes?: number;
  /**
   * Largest single entry kept, in bytes (#894). Anything bigger is refused
   * and counted. Default 1 MB. Also caps `maxBytes` in effect: an entry above
   * the total budget could never be retained without breaching it, so it is
   * refused too.
   */
  maxEntryBytes?: number;
}

/** Per-write overrides for {@link LruTtlCache.set}. */
interface LruTtlCacheSetOptions {
  /** Lifetime for this entry, overriding the cache default. */
  ttlMs?: number;
  /**
   * Retained cost of this value in bytes (#894). Callers that already hold the
   * serialized body should pass its exact UTF-8 length rather than make the
   * cache re-serialize; omitting it falls back to {@link estimateBytes}.
   */
  bytes?: number;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
  bytes: number;
}

/**
 * Approximate retained cost of a value the caller did not measure (#894).
 * Serialized length is the honest proxy for a JSON-derived payload, and the
 * client always passes the exact body length instead — this is the fallback
 * for direct use of the data structure. A value that cannot be serialized
 * (circular, or a bare `undefined`) reports 0 rather than throwing: this is a
 * memory-pressure guard, and refusing the write would turn a measurement
 * problem into a lost cache entry.
 */
function estimateBytes(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (typeof value !== 'object') return String(value).length;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : Buffer.byteLength(json, 'utf8');
  } catch {
    return 0;
  }
}

export class LruTtlCache<V> {
  private readonly map = new Map<string, Entry<V>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxEntryBytes: number;
  private _bytes = 0;
  private _skippedOversize = 0;

  constructor(opts: LruTtlCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_CACHE_TTL_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
    this.maxBytes = opts.maxBytes ?? DEFAULT_CACHE_MAX_BYTES;
    this.maxEntryBytes = opts.maxEntryBytes ?? DEFAULT_CACHE_MAX_ENTRY_BYTES;
  }

  get size(): number {
    return this.map.size;
  }

  /**
   * Approximate bytes of stored payloads (#894). Counts entries that have
   * expired but not yet been read or evicted, exactly as `size` does — they
   * are still reachable, so reporting them is honest; the next `get` or
   * `set` reclaims them.
   */
  get bytes(): number {
    return this._bytes;
  }

  /**
   * Writes refused because the value was larger than `maxEntryBytes` (or than
   * the whole budget) (#894). Non-zero means reads of that size are never
   * served from cache, so it is surfaced by `spotify_doctor` rather than
   * absorbed.
   */
  get skippedOversize(): number {
    return this._skippedOversize;
  }

  /** The configured ceilings, for reporting (#894). */
  get limits(): { maxEntries: number; maxBytes: number; maxEntryBytes: number } {
    return { maxEntries: this.maxEntries, maxBytes: this.maxBytes, maxEntryBytes: this.maxEntryBytes };
  }

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.drop(key);
      return undefined;
    }
    // Refresh recency: delete + re-insert moves the key to Map's tail.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, opts: LruTtlCacheSetOptions = {}): void {
    // Replacing a key must release the old entry's bytes first, or the
    // accounting would charge one payload twice and drift upward.
    this.drop(key);
    const bytes = opts.bytes ?? estimateBytes(value);
    // An entry that cannot fit the byte budget is refused rather than stored
    // and immediately evicted: storing it would evict every other entry and
    // still breach the budget. The count is kept — a cache that silently
    // stopped caching is worse than one that says so (#894, AGENTS.md §6).
    if (bytes > this.maxEntryBytes || bytes > this.maxBytes) {
      this._skippedOversize += 1;
      return;
    }
    this.map.set(key, { value, expiresAt: Date.now() + (opts.ttlMs ?? this.ttlMs), bytes });
    this._bytes += bytes;
    // Deterministic LRU: Map iterates insertion order, and `get` re-inserts,
    // so the first key is always the least recently used. `map.size > 1`
    // keeps the loop from deleting the entry just inserted — the newest is
    // the last key, and the bounds it was admitted under are satisfiable by
    // it alone.
    while (this.map.size > 1 && (this.map.size > this.maxEntries || this._bytes > this.maxBytes)) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
  }

  delete(key: string): void {
    this.drop(key);
  }

  clear(): void {
    this.map.clear();
    this._bytes = 0;
  }

  /** Remove a key and release the bytes it was charged (#894). */
  private drop(key: string): void {
    const entry = this.map.get(key);
    if (!entry) return;
    this.map.delete(key);
    this._bytes -= entry.bytes;
  }
}

/**
 * How long a stored ETag stays usable as an `If-None-Match` validator (#601).
 * Longer than the payload TTL on purpose: an expired TTL only means the body
 * must be re-validated, not re-downloaded.
 */
export const DEFAULT_VALIDATOR_TTL_MS = 60 * 60_000;

interface ValidatorEntry<V> {
  value: V;
  etag: string;
  savedAt: number;
}

/**
 * Per-key store of the last payload that carried an ETag, so a later read can
 * revalidate with `If-None-Match` and answer a 304 from here instead of
 * re-downloading the body (#601).
 *
 * Unlike {@link LruTtlCache} this is not a freshness cache: a stored payload is
 * never served on its own. It is only ever returned after the origin has
 * confirmed, with a 304, that it is still current — so a short `ttlMs` costs
 * bandwidth, not accuracy.
 */
export class ValidatorStore<V> {
  private readonly map = new Map<string, ValidatorEntry<V>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(ttlMs: number = DEFAULT_VALIDATOR_TTL_MS, maxEntries: number = DEFAULT_CACHE_MAX_ENTRIES) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  get size(): number {
    return this.map.size;
  }

  /** The stored validator for `key`, or undefined when absent or expired. */
  get(key: string): { value: V; etag: string } | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.savedAt >= this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh recency: delete + re-insert moves the key to Map's tail.
    this.map.delete(key);
    this.map.set(key, entry);
    return { value: entry.value, etag: entry.etag };
  }

  /** Store (or refresh the window of) a payload and the ETag that identifies it. */
  set(key: string, value: V, etag: string): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, etag, savedAt: Date.now() });
    while (this.map.size > this.maxEntries) {
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
 * SpotifyClient.get, is handed `buildUrl`'s output, which appends
 * `?${new URLSearchParams(params)}`. The split is therefore what makes a
 * params-bearing read keyable at all, and what lets a composed target and a
 * params object meet on one key.
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
 * There is one normalisation, not two competing ones: the target's inline
 * query and an explicit `params` object are merged into the same pair list
 * before the single sort (#894), so the two spellings of one request cannot
 * disagree. Production keys off the composed target because that string is
 * the request that actually goes on the wire — keying it off `path` +
 * `params` separately would let a `?`-bearing `path` lose its own query
 * params and collide with a different request. `params` remains the explicit
 * form of the same key, and `tests/cache.test.ts` pins that the two agree.
 *
 * Callers keep the query out of the path they hand `get`: no `get`/
 * `getAllPages` call site in `src/` passes a target containing `?`, and the
 * only `?`-bearing path builders either feed `put`/`post`/`delete`, all of
 * which `shouldBypassCache` skips (tools/library.ts `savedItemsPath`), or are
 * split before the call (tools/exhaust2_misc.ts).
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
