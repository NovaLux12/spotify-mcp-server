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
 *    server has no write path for are persisted, and the allowlist is keyed on
 *    the PATH SHAPE rather than the path root — see {@link PERSISTABLE_ROOTS}.
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
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { getTokenFile } from './auth.js';
import { loadSidecar } from './sidecar.js';
import { truthyEnv } from './config.js';

/** On-disk schema version. A file written by a different shape is not guessed at. */
const PERSIST_VERSION = 1;

/**
 * The document's two literal halves, kept as constants so {@link savePersistedCache}
 * can size the file arithmetically instead of re-serializing to find out.
 */
const DOC_OPEN = `{"version":${PERSIST_VERSION},"entries":[`;
const DOC_CLOSE = ']}';

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
 * Catalog roots eligible for persistence, mapped to the DEEPEST path shape
 * under that root which is still public catalog.
 *
 * Keying on the root alone is not enough, and the depth is the whole point: a
 * root being public says nothing about its subtree. `/users` is the case in
 * point — `GET /users/{id}` is a public display profile, but everything the
 * stats.fm client reads beneath it (`/users/{id}/streams/stats`,
 * `/users/{id}/top/artists`, `/users/{id}/records/artists`,
 * `/users/{id}/streams/recent`, `/users/{id}/streams/current`,
 * `/users/{id}/friends`) is a listener's private history. Those have no Web API
 * write path NOT because they are immutable but because nothing can write
 * them: they change for reasons entirely outside this server, which
 * `invalidationPlan` cannot reach (it has no `users` rule) and a second
 * process could not have observed anyway. A root-level grant would persist
 * them for their full TTL.
 *
 * So each row is a verified claim about a path SHAPE, and the depths come
 * from the official OpenAPI schema
 * (https://developer.spotify.com/reference/web-api/open-api-schema.yaml):
 *
 * | root | depth | shapes that justify the depth                    |
 * |------|------:|-----------------------------------------------------|
 * | tracks | 2 | `/tracks/{id}`                                  |
 * | albums | 3 | `/albums/{id}`, `/albums/{id}/tracks`            |
 * | artists | 3 | `/artists/{id}`, `/artists/{id}/albums`, `/artists/{id}/top-tracks` |
 * | shows | 3 | `/shows/{id}`, `/shows/{id}/episodes`             |
 * | episodes | 2 | `/episodes/{id}`                                |
 * | audiobooks | 3 | `/audiobooks/{id}`, `/audiobooks/{id}/chapters` |
 * | genres | 3 | `/genres/{genre}/artists`                        |
 * | **users** | **2** | **`/users/{id}` ONLY** — nothing beneath it     |
 *
 * `/playlists` is deliberately absent at any depth: playlist contents and
 * metadata change under this server's own write tools, and a playlist read
 * persisted by one process would be served stale to another that never saw the
 * edit. A depth no entry claims stays refused, so a newly added subtree is
 * excluded by default rather than by remembering to extend a table.
 */
const PERSISTABLE_ROOTS = new Map<string, number>([
  ['tracks', 2],
  ['albums', 3],
  ['artists', 3],
  ['shows', 3],
  ['episodes', 2],
  ['audiobooks', 3],
  ['genres', 3],
  ['users', 2],
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
  /**
   * Entries skipped because they did not fit under the byte cap. Distinct from
   * `refused`: these passed the allowlist and were dropped for SIZE, and an
   * operator seeing `persisted=0` needs to be able to tell which it was.
   */
  oversize: number;
}

/** True when `SPOTIFY_MCP_CACHE_PERSIST` opts in. */
export function cachePersistEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthyEnv(env.SPOTIFY_MCP_CACHE_PERSIST);
}

/**
 * The cache file's NAME, derived from the token file it belongs to.
 *
 * Deriving beats re-resolving: the profile is read out of the very path
 * `getTokenFile()` produced, so the two stores cannot disagree about which
 * account is active. A second, hand-rolled profile lookup here is precisely
 * how this function came to ignore `--profile` (#1249 review) and left every
 * account on the machine sharing one `cache.json` — last writer wins, and a
 * session authenticated as one account serves another's reads to the next.
 */
function cacheFileNameFor(tokenFile: string): string {
  const base = basename(tokenFile);
  if (base === 'tokens.json') return 'cache.json';
  if (base.startsWith('tokens.') && base.endsWith('.json')) {
    return `cache.${base.slice('tokens.'.length, -'.json'.length)}.json`;
  }
  // An `SPOTIFY_MCP_TOKEN_FILE` with an unconventional name still gets its own
  // cache rather than silently sharing the default account's.
  return `cache.${base.replace(/\.json$/, '')}.json`;
}

/**
 * Target file path, resolved from the TOKEN file (#893).
 *
 * The cache is per-account state, so it is named after the account the same way
 * the token file is: `~/.spotify-mcp/cache.<profile>.json` beside
 * `~/.spotify-mcp/tokens.<profile>.json` (#1249 review). Both come from one
 * `getTokenFile()` call, which is what makes the two provably agree rather than
 * merely similar — see {@link cacheFileNameFor}.
 *
 * `SPOTIFY_MCP_DATA_DIR` still overrides the DIRECTORY (tests, relocated homes);
 * it does not merge accounts, because the name is still profile-derived.
 */
export function cachePersistPath(env: NodeJS.ProcessEnv = process.env, opts: CachePersistOptions = {}): string {
  if (opts.file) return opts.file;
  const tokenFile = getTokenFile(undefined, env);
  const dir = env.SPOTIFY_MCP_DATA_DIR?.trim() || dirname(tokenFile);
  return join(dir, cacheFileNameFor(tokenFile));
}

/**
 * Whether a cache key may be persisted (#893 rule 1).
 *
 * The key is `GET <path> <params>`, so the path is the segment after the
 * method. Refusing anything that is not `GET ...` also means a future
 * non-GET key cannot be written by accident.
 *
 * The test is on the path SHAPE (root + depth), not the root alone — see
 * {@link PERSISTABLE_ROOTS} for why `/users/{id}` is admissible and
 * `/users/{id}/streams/stats` is not.
 */
export function isPersistableKey(key: string): boolean {
  const match = /^GET (\/[^?\s]*)/.exec(key);
  if (!match) return false;
  const segments = match[1].split('/').filter((s) => s.length > 0);
  const root = segments[0];
  // No root means `/`-rooted reads, which this server does not make. Refuse
  // rather than guess: an unrecognised key is not evidence of safety.
  if (root === undefined) return false;
  const maxDepth = PERSISTABLE_ROOTS.get(root);
  if (maxDepth === undefined) return false;
  // Deeper than the deepest public shape this root admits — refuse.
  if (segments.length > maxDepth) return false;
  // Shallower than `/{root}/{id}` is not a resource read at all.
  return segments.length >= 2;
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
 * **One serialization per entry, and no re-serialization of the document.**
 * The obvious implementation re-stringifies the whole accumulated array on
 * every iteration to test the cap, which is O(n²) in bytes. Measured against
 * this module, 200 × 40 KB entries — exactly what a walked catalogue sitting at
 * the #894 8 MB budget looks like — costs 3446 ms per save and serializes
 * 813,716,595 bytes to write a file of 8,017,005; encoding each entry once
 * costs 65 ms and 8,016,780 bytes. The 101× ratio is the quadratic signature
 * (n(n+1)/2 = 20,100 against 200 entries). With a 250 ms save debounce that is
 * a ~3.4 s synchronous stall of the server's one event loop, on the feature's
 * own happy path (#1249 review).
 *
 * Instead each entry is encoded once, the cap is tracked arithmetically
 * against those exact lengths, and the document is assembled by joining the
 * encodings. The encoded length of the finished file is therefore known
 * exactly before a byte is written — the cap stays exact rather than becoming
 * an estimate.
 *
 * An entry that does not fit is SKIPPED, not treated as the end: the previous
 * `break` discarded every later entry that would have fit, and counted none of
 * them, so an operator saw `persisted=0` with no stated reason. Skipping keeps
 * the cap meaningful (the total never exceeds it) and makes the drop visible in
 * {@link CachePersistStats} and in the `spotify_doctor` row.
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

  // The document is exactly `{"version":N,"entries":[ … ,… ]}`, so its size is
  // the two literals plus the encodings plus one comma between each pair.
  const open = Buffer.byteLength(DOC_OPEN, 'utf8');
  const close = Buffer.byteLength(DOC_CLOSE, 'utf8');
  const kept: string[] = [];
  let total = open + close;
  let oversize = 0;
  for (const entry of allowed) {
    const encoded = JSON.stringify(entry);
    // Only entries past the first pay the separating comma.
    const delta = Buffer.byteLength(encoded, 'utf8') + (kept.length > 0 ? 1 : 0);
    if (total + delta > maxBytes) {
      oversize += 1;
      continue; // Later, smaller entries still fit; a `break` here would drop them.
    }
    kept.push(encoded);
    total += delta;
  }

  const body = DOC_OPEN + kept.join(',') + DOC_CLOSE;
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
  return { persisted: kept.length, bytes: total, failed: 0, refused, oversize };
}
