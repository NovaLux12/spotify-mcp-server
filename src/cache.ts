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

/** Stable key over method + path + params (params order-insensitive). */
export function cacheKey(method: string, path: string, params?: Record<string, string>): string {
  let serializedParams = '';
  if (params && Object.keys(params).length > 0) {
    serializedParams = JSON.stringify(
      Object.keys(params)
        .sort()
        .map((name) => [name, params[name]]),
    );
  }
  return `${method.toUpperCase()} ${path} ${serializedParams}`;
}
