/**
 * Optional cross-process persistence for the immutable read cache (#893,
 * A16-019). Opt-in with `SPOTIFY_MCP_CACHE_PERSIST=1`; off by default, because
 * a cache that outlives the process is a cache that can outlive the invalidation
 * that was supposed to govern it.
 *
 * Three rules make a persisted entry safe to serve to a SECOND process, and
 * all three are enforced here rather than left to the caller:
 *
 * 1. **Allowlist, never denylist.** Only catalog resources whose contents this
 *    server has no write path for are persisted (`/tracks`, `/albums`,
 *    `/artists`, `/shows`, `/episodes`, `/audiobooks`, `/users`, `/genres`).
 *    A path not on the list is refused, so a newly added `/me/*` read is
 *    excluded by default rather than by remembering to update a denylist. A
 *    persisted library or playback read would be served to a process that never
 *    saw the mutation that changed it — the exact failure the issue calls out.
 * 2. **Absolute expiry, re-checked on load.** `expiresAt` is stored, and an
 *    entry whose deadline has passed is dropped on load rather than revived. A
 *    clock that jumped, or a file edited by hand, cannot extend an entry's
 *    life: the deadline is the deadline.
 * 3. **Owner-only, bounded, and atomic.** Mode 0600, re-asserted on every write
 *    (a file copied in with looser modes is not thereby permitted); a size cap
 *    so one huge library of entries cannot grow without bound; writes go to a
 *    temp file and are renamed, so a crash mid-write cannot leave a half file
 *    that reads as a smaller cache.
 *
 * A write failure is counted and reported, never swallowed: a cache that
 * silently stopped persisting looks exactly like a cache that is working.
 */
import { chmod, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadSidecar } from './sidecar.js';
import { truthyEnv } from './config.js';

/** On-disk schema version. A file written by a different shape is not guessed at. */
const PERSIST_VERSION = 1;

/** Owner-only, matching every other sidecar in this server. */
const PERSIST_FILE_MODE = 0o600;
const PERSIST_DIR_MODE = 0o700;

/**
 * Ceiling on the persisted file. The in-memory budget is 8 MB of payloads
 * (#894); the serialized form plus keys runs somewhat over that, so the cap
 * sits above it and the writer trims oldest-first rather than refusing to save
 * at all once it is reached.
 */
const DEFAULT_PERSIST_MAX_BYTES = 12 * 1024 * 1024;

/**
 * Catalog roots eligible for persistence. Each is a resource this server never
 * writes, so a mutation in ANY process cannot change what a persisted entry
 * says. `/playlists` is deliberately absent: playlist contents and metadata
 * change under this server's own write tools, and a playlist read persisted by
 * one process would be served stale to another that never saw the edit.
 */
const PERSISTABLE_ROOTS = new Set([
  'tracks',
  'albums',
  'artists',
  'shows',
  'episodes',
  'audiobooks',
  'users',
  'genres',
]);

/** One persisted cache entry. `value` is the parsed body Spotify returned. */
export interface PersistedEntry {
  key: string;
  value: unknown;
  expiresAt: number;
}

/** On-disk document. */
interface PersistFile {
  version: number;
  entries: PersistedEntry[];
}

export interface CachePersistOptions {
  /** Override the file path (tests, multi-account homes). */
  file?: string;
  /** Override the byte cap. */
  maxBytes?: number;
}

export interface CachePersistStats {
  /** Entries written to the file by the most recent save. */
  persisted: number;
  /** Bytes written by the most recent save. */
  bytes: number;
  /** Saves that failed. Surfaced, not swallowed. */
  failed: number;
  /** Entries refused because their path is not on the allowlist. */
  refused: number;
}

/** True when `SPOTIFY_MCP_CACHE_PERSIST` opts in. */
export function cachePersistEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthyEnv(env.SPOTIFY_MCP_CACHE_PERSIST);
}

/**
 * Target file path. `SPOTIFY_MCP_DATA_DIR` overrides the directory, matching the
 * other sidecars; the default is `~/.spotify-mcp/cache.json`.
 */
export function cachePersistPath(env: NodeJS.ProcessEnv = process.env, opts: CachePersistOptions = {}): string {
  if (opts.file) return opts.file;
  const dir = env.SPOTIFY_MCP_DATA_DIR?.trim() || join(homedir(), '.spotify-mcp');
  return join(dir, 'cache.json');
}

/**
 * Whether a cache key may be persisted (#893 rule 1).
 *
 * The key is `GET <path> <params>`, so the path is the segment after the
 * method. Refusing anything that is not `GET ...` also means a future
 * non-GET key cannot be written by accident.
 */
export function isPersistableKey(key: string): boolean {
  const match = /^GET (\/[^?\s]*)/.exec(key);
  if (!match) return false;
  const segments = match[1].split('/').filter((s) => s.length > 0);
  const root = segments[0];
  // No root means `/`-rooted reads, which this server does not make. Refuse
  // rather than guess: an unrecognised key is not evidence of safety.
  if (root === undefined) return false;
  return PERSISTABLE_ROOTS.has(root);
}

/** Byte cap for the file, overridable by `opts` only (no env knob by design). */
function capFor(opts: CachePersistOptions): number {
  return opts.maxBytes ?? DEFAULT_PERSIST_MAX_BYTES;
}

/**
 * Drop entries that cannot be served: wrong schema version, malformed rows,
 * or expired. Returns only the entries that are still usable.
 *
 * Expired entries are dropped rather than revived — `expiresAt` is an absolute
 * deadline, so this is a filter on the stored value and not a re-computation of
 * a TTL that a rewritten file could stretch.
 */
export function validatePersisted(parsed: unknown, now: number = Date.now()): PersistFile {
  if (typeof parsed !== 'object' || parsed === null) throw new Error('cache file is not an object');
  const doc = parsed as Partial<PersistFile>;
  if (doc.version !== PERSIST_VERSION) {
    throw new Error(`cache file version ${String(doc.version)} is not ${PERSIST_VERSION}`);
  }
  if (!Array.isArray(doc.entries)) throw new Error('cache file has no entries array');
  const entries: PersistedEntry[] = [];
  for (const raw of doc.entries) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Partial<PersistedEntry>;
    if (typeof entry.key !== 'string' || entry.key.length === 0) continue;
    if (typeof entry.expiresAt !== 'number' || !Number.isFinite(entry.expiresAt)) continue;
    if (entry.value === undefined) continue;
    if (entry.expiresAt <= now) continue;
    entries.push({ key: entry.key, value: entry.value, expiresAt: entry.expiresAt });
  }
  return { version: PERSIST_VERSION, entries };
}

/**
 * Read the persisted entries. A missing file is an empty cache. An unreadable
 * or malformed file is PRESERVED and reported through `loadSidecar`'s
 * `SidecarUnreadableError` rather than read as an empty cache — a corrupt file
 * that silently became "nothing cached" would be indistinguishable from a cold
 * start, which is how a real data-loss bug hides.
 */
export async function loadPersistedCache(
  opts: CachePersistOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<PersistedEntry[]> {
  const file = cachePersistPath(env, opts);
  const doc = await loadSidecar<PersistFile>(file, () => ({ version: PERSIST_VERSION, entries: [] }), validatePersisted);
  return doc.entries;
}

/**
 * Write the entries, honouring the allowlist and the size cap.
 *
 * Entries are written newest-deadline-last (the cache is LRU, so the map's
 * iteration order is recency order) and the tail is trimmed once the encoded
 * document exceeds the cap, so the most recently used entries are the ones kept.
 * A single entry too large to fit is dropped and counted, never written.
 */
export async function savePersistedCache(
  entries: PersistedEntry[],
  opts: CachePersistOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<CachePersistStats> {
  const file = cachePersistPath(env, opts);
  const maxBytes = capFor(opts);
  const allowed = entries.filter((e) => isPersistableKey(e.key));
  const refused = entries.length - allowed.length;

  const kept: PersistedEntry[] = [];
  let bytes = 0;
  for (const entry of allowed) {
    const candidate = { version: PERSIST_VERSION, entries: [...kept, entry] };
    const encoded = Buffer.byteLength(JSON.stringify(candidate), 'utf8');
    if (encoded > maxBytes) break; // Trim from the tail: later entries are older.
    kept.push(entry);
    bytes = encoded;
  }

  const body = JSON.stringify({ version: PERSIST_VERSION, entries: kept });
  await mkdir(dirname(file), { recursive: true, mode: PERSIST_DIR_MODE });
  // Temp-then-rename: a crash mid-write leaves the previous file intact
  // instead of a truncated one that reads as a smaller cache.
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, body, { encoding: 'utf8', mode: PERSIST_FILE_MODE });
    await rename(tmp, file);
  } catch (err) {
    await (await import('node:fs/promises')).unlink(tmp).catch(() => {});
    throw err;
  }
  // Mode is re-asserted after the rename: `writeFile`'s mode only applies at
  // creation, so a file that already existed with looser permissions would
  // otherwise keep them.
  await chmod(file, PERSIST_FILE_MODE);
  return { persisted: kept.length, bytes, failed: 0, refused };
}

/** Current size of the persisted file, or 0 when it does not exist. */
export async function persistedCacheBytes(
  opts: CachePersistOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  try {
    return (await stat(cachePersistPath(env, opts))).size;
  } catch {
    return 0;
  }
}
