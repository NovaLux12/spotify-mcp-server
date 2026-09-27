/**
 * Opt-in mutation history JSONL (#64, hardened in #628). When
 * SPOTIFY_MCP_HISTORY is truthy, every agent-driven mutation appends one JSON
 * line under ~/.spotify-mcp/history/mutations.jsonl (override dir with
 * SPOTIFY_MCP_HISTORY_DIR) recording who/what/snapshot_id — enabling undo,
 * audit and cross-session personalization.
 *
 * Records are written through a strict field whitelist so tokens or raw
 * request/response bodies can never leak into the file.
 *
 * Four hardening properties, each independently enforced:
 *
 * 1. No raw URI payload. The request path is normalized to a route template
 *    (query string dropped, opaque segments replaced with `{id}`) and the
 *    exact target is kept only as a truncated SHA-256 fingerprint, so records
 *    can be correlated with a target but never disclose it. Undo does not need
 *    the raw path: reversals are driven by receipts (src/receipts.ts), which
 *    hold the URIs in memory for the current session.
 * 2. Owner-only mode, re-asserted on every write. `mkdir`/`appendFile` mode
 *    arguments only apply at creation, so a file (or directory) that predates
 *    the hardening — or was copied in with looser modes — is chmod'ed 0600
 *    (0700 for the directory) on every append, and the rotated archive is
 *    chmod'ed too.
 * 3. Bounded growth and bounded reads. The live file rotates to a single
 *    `mutations.jsonl.1` generation once it would exceed
 *    SPOTIFY_MCP_HISTORY_MAX_BYTES, so the ledger is capped at
 *    2 x maxBytes on disk. Readers go through readHistory(), which tails
 *    backwards through the files in fixed-size chunks and keeps at most
 *    DEFAULT_HISTORY_READ_LIMIT records in memory regardless of file size.
 * 4. A row cap and an age cap, because a bound expressed in BYTES is not a
 *    retention policy (#703). Rotation bounds what is on disk at a moment in
 *    time; it says nothing about how long a dated record survives, and a
 *    1 MiB ledger can hold a year of writes or a week depending only on how
 *    busy the account was. So the ledger is also held to
 *    SPOTIFY_MCP_HISTORY_MAX_ROWS records (default 5000) and to
 *    SPOTIFY_MCP_HISTORY_RETENTION_DAYS days (default 90, `0` disables the
 *    age cap), enforced over BOTH generations — the archive is where the
 *    oldest records live, so pruning only the live file would expire
 *    nothing. A prune rewrites what survives atomically (temp file, fsync,
 *    rename(2)) at mode 0600, so a crash mid-prune leaves the previous
 *    ledger whole rather than a half-written one, and drops the oldest
 *    records, never the newest.
 *
 * `who` records the tool that issued the mutation when the call came through
 * the tool-invocation boundary, and `agent` otherwise (#591). A lost append
 * is counted and reported by spotify_doctor rather than swallowed, so an
 * incomplete trail never reads as a complete one.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { open, appendFile, chmod, mkdir, rename, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { storePath, truthyEnv } from './config.js';
import { accountFileName, accountFileNames, accountStoreKey } from './accountkey.js';
import { getTokenFilePath } from './auth.js';

// ---------------------------------------------------------------------------
// Actor labelling (#591)
//
// Every mutation reaches the ledger through the client's write methods, which
// do not know — and cannot cheaply be told — which tool issued them. The one
// place that does know is the tool-invocation boundary, so the tool name is
// carried ambiently (AsyncLocalStorage) and read back at the record site.
// ---------------------------------------------------------------------------

const toolContext = new AsyncLocalStorage<string>();

/** Guard rail: tool names are far shorter; the cap keeps the field bounded. */
const MAX_WHO_LENGTH = 64;

/**
 * `who` is echoed unescaped into Markdown tables by the history export tools,
 * so only the character class real tool names use survives.
 */
const WHO_UNSAFE = /[^A-Za-z0-9_.-]+/g;

/** The tool whose handler is running on this async context, if any. */
export function currentToolName(): string | undefined {
  return toolContext.getStore();
}

/**
 * Run `fn` with `name` as the ambient actor for every mutation issued inside
 * it, across awaits. Installed at the single tool-invocation boundary
 * (installTruncationBoundary in src/shaping.ts), so no mutation call site has
 * to name itself and concurrent tool calls keep their own actor.
 */
export function runInToolContext<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return toolContext.run(name, fn);
}

/** Normalised `who` label; undefined when there is no usable actor. */
function normalizeActor(who: string | undefined): string | undefined {
  if (who === undefined) return undefined;
  const cleaned = who.replace(WHO_UNSAFE, '_').slice(0, MAX_WHO_LENGTH);
  return cleaned.length > 0 ? cleaned : undefined;
}

// ---------------------------------------------------------------------------
// Write-failure accounting (#591)
//
// The trail is best-effort by design (a history problem must never fail the
// mutation it describes), but "best-effort" used to mean "invisible": an
// unwritable directory produced a ledger that reads as complete. Failures are
// therefore counted, reported once per process, and read back by
// spotify_doctor as a `fail` row.
// ---------------------------------------------------------------------------

let writeFailures = 0;
let lastWriteFailure: string | undefined;
let warnedWriteFailure = false;

export interface HistoryWriteStatus {
  /** Whether the trail is being recorded at all. */
  enabled: boolean;
  /** The resolved JSONL path the writer targets. */
  path: string;
  /** Appends that did not reach disk since process start. */
  failures: number;
  /** `errno` + path of the most recent failure, when there was one. */
  last_failure?: string;
}

/** What spotify_doctor reports: where the ledger lives and how lossy it got. */
export function historyWriteStatus(
  env: NodeJS.ProcessEnv = process.env,
  tokenFile: string,
): HistoryWriteStatus {
  return {
    enabled: isHistoryEnabled(env),
    path: historyFilePath(env, tokenFile),
    failures: writeFailures,
    ...(lastWriteFailure !== undefined ? { last_failure: lastWriteFailure } : {}),
  };
}

/**
 * Count a lost append and warn exactly once per process. The warning is the
 * only signal a host that never calls spotify_doctor will ever see, so it
 * names the errno and the path it could not write.
 */
function noteWriteFailure(err: unknown, file: string): void {
  writeFailures++;
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  lastWriteFailure = `${typeof code === 'string' ? code : 'unknown error'} on ${file}`;
  if (warnedWriteFailure) return;
  warnedWriteFailure = true;
  console.error(
    `[spotify-mcp] history write failed (${lastWriteFailure}) — audit trail incomplete; ` +
      'undo anchors may be missing. Run spotify_doctor to see the failure counter.',
  );
}

/** Test seam: clear the process-scoped counter and the warn-once latch. */
export function __resetHistoryWriteState(): void {
  writeFailures = 0;
  lastWriteFailure = undefined;
  warnedWriteFailure = false;
  // The measured ledger shapes are process state about FILES, so they are
  // cleared with it: a test that points the same path at a different ledger
  // must not inherit the previous ledger's row count.
  ledgerShapes.clear();
}

export interface MutationRecord {
  /** HTTP method of the mutating call (POST/PUT/DELETE). */
  method: string;
  /** API path that was mutated, e.g. /playlists/{id}/items. */
  path: string;
  /** snapshot_id echoed by the API response when present (undo anchor). */
  snapshot_id?: string;
  /** Actor label; defaults to 'agent' (all mutations come from MCP tools). */
  who?: string;
}

/** Shape of one persisted history line. `path` is a route template, never raw. */
export interface HistoryRecord {
  ts?: string;
  who?: string;
  method?: string;
  /** Normalized route template, e.g. `/playlists/{id}/items`. */
  path?: string;
  /** Truncated SHA-256 of the exact request path; correlation, not disclosure. */
  target?: string;
  snapshot_id?: string;
  [key: string]: unknown;
}

/** The settings every `readHistory` shape shares. */
interface HistoryReadOptionsBase {
  /** Max records to return, oldest-dropped. Default DEFAULT_HISTORY_READ_LIMIT. */
  limit?: number;
  /** Env used to resolve the file path. Default process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * A `readHistory` call must say WHICH ledger to read, one way or the other
 * (#1385).
 *
 * The two shapes are mutually exclusive on purpose. `tokenFile` names the
 * account and lets the store derive the path; `file` names the path outright,
 * which is what a caller inspecting a specific ledger on disk wants. The
 * combination this replaces — both optional — made "neither" a legal call, and
 * neither resolved to the DEFAULT account's ledger. A reader that never said
 * which account it was therefore got the default account's mutations, which is
 * the cross-account merge the account key exists to prevent.
 */
export type HistoryReadOptions =
  | (HistoryReadOptionsBase & {
      /** Override the file to read (rotation archive derived from it). */
      file: string;
      tokenFile?: never;
    })
  | (HistoryReadOptionsBase & {
      /**
       * The acting account's token file, which selects the ledger to read.
       */
      tokenFile: string;
      file?: never;
    });

/** Live file rotates past this many bytes; SPOTIFY_MCP_HISTORY_MAX_BYTES overrides. */
export const DEFAULT_HISTORY_MAX_BYTES = 1_048_576;

/**
 * Records retained across the WHOLE ledger (live file plus its one rotated
 * generation); SPOTIFY_MCP_HISTORY_MAX_ROWS overrides (#703).
 *
 * The byte cap and the row cap are not the same bound. Bytes stop a file
 * growing without limit but say nothing about how many dated records that is,
 * so a user reading their ledger cannot answer "how much of my history is
 * still here" from a byte count. Rows are that answer.
 */
export const DEFAULT_HISTORY_MAX_ROWS = 5000;

/**
 * Days a record survives; SPOTIFY_MCP_HISTORY_RETENTION_DAYS overrides, and `0`
 * disables age-based pruning entirely (#703).
 *
 * `0` is a real setting here rather than a fallback, which is why this parses
 * differently from the two caps: an unset, non-numeric or negative value falls
 * back to the default (a typo must not silently expire the whole ledger on the
 * next append), but an explicit `0` is honoured and means "keep rows until the
 * row cap drops them". Same intent as SPOTIFY_MCP_RECEIPTS_TTL_HOURS, which
 * reads `0` the same way.
 */
export const DEFAULT_HISTORY_RETENTION_DAYS = 90;

/**
 * The ledger's un-keyed filename, and the stem every per-account ledger is
 * derived from: `mutations.work.jsonl` for the `work` profile.
 */
const HISTORY_FILE = 'mutations.jsonl';

/** Records kept in memory by readHistory() — the reader's memory ceiling. */
export const DEFAULT_HISTORY_READ_LIMIT = 500;
/** Owner-only modes, re-asserted on every write (creation-only mode args are not enough). */
export const HISTORY_FILE_MODE = 0o600;
export const HISTORY_DIR_MODE = 0o700;
/** Single rotation generation; keeps total on-disk history at 2 x maxBytes. */
const HISTORY_ARCHIVE_SUFFIX = '.1';

/** The rotated generation beside a live ledger. */
export function historyArchivePath(file: string): string {
  return `${file}${HISTORY_ARCHIVE_SUFFIX}`;
}

const READ_CHUNK_BYTES = 64 * 1024;

const DAY_MS = 86_400_000;

/**
 * A segment is safe to keep verbatim only when it looks like route
 * vocabulary: 1–15 lowercase alphanumerics/hyphens, no uppercase, no dots,
 * colons or percent-escapes. Everything else (22-char base62 Spotify IDs,
 * `spotify:track:…` fragments, percent-encoded ids) becomes `{id}`. Fails
 * closed: an unrecognized shape is redacted, not persisted.
 */
const ROUTE_SEGMENT = /^[a-z][a-z0-9-]{0,14}$/;

export function isHistoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthyEnv(env.SPOTIFY_MCP_HISTORY);
}

/**
 * The ledger's DIRECTORY, taken from the registry's `mutations` row (#711).
 *
 * The row resolves the full path for the DEFAULT account, and `dirname` of that
 * is the directory for every account — the account key changes the file name,
 * never the directory. Deriving it here is what keeps the two from disagreeing:
 * a change to the fallback chain in `config.ts` moves this one too, and a copy
 * typed out again would not.
 */
function historyDir(env: NodeJS.ProcessEnv): string {
  return dirname(storePath('mutations', env));
}

/**
 * Target JSONL path for one account; SPOTIFY_MCP_HISTORY_DIR overrides the directory.
 *
 * The default account keeps the bare `mutations.jsonl`, so an install that has
 * been running this server reads and writes the ledger it already has — no
 * migration, and no "history disappeared after the upgrade" regression. A
 * named profile gets `mutations.<profile>.jsonl` and starts empty. Each
 * account's ledger now holds only that account's writes, which is what makes
 * `mutation_log_export` and `undo_mutation` mean the same thing under every
 * account on the machine (#1364). See `src/accountkey.ts` for why the key is
 * the token file rather than Spotify's `account_id`.
 */
export function historyFilePath(env: NodeJS.ProcessEnv = process.env, tokenFile: string): string {
  const dir = historyDir(env);
  return join(dir, accountFileName(HISTORY_FILE, tokenFile));
}

/**
 * Every account's ledger in this store directory.
 *
 * `historyFilePath` is the single-file answer, correct on a machine with one
 * account and a partial answer on a machine with profiles: the other ledgers
 * exist and would be orphaned. `spotify_logout_stores` erases from this list
 * for that reason, the same way it does for the persisted read cache.
 */
export function historyFilePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  return accountFileNames(dirname(getTokenFilePath(env)), HISTORY_FILE).map((name) =>
    join(historyDir(env), name),
  );
}

/**
 * Every ledger file on disk: each account's live file AND the rotated
 * generation beside it.
 *
 * {@link historyFilePaths} is the list of ledgers; this is the list of FILES,
 * and `logout` needs the second one. A rotated `mutations.jsonl.1` holds the
 * oldest half of the same record, so erasing only the live file and reporting
 * a clean sweep would be a logout that removed half the audit trail and said
 * nothing about the half it left — which is the outcome this whole command
 * exists to prevent (#703).
 */
export function historyLedgerPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  return historyFilePaths(env).flatMap((file) => [file, historyArchivePath(file)]);
}

/** Rotation threshold in bytes; SPOTIFY_MCP_HISTORY_MAX_BYTES overrides. */
export function historyMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.SPOTIFY_MCP_HISTORY_MAX_BYTES ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HISTORY_MAX_BYTES;
}

/**
 * Record cap; SPOTIFY_MCP_HISTORY_MAX_ROWS overrides (#703).
 *
 * Unset, non-numeric, zero and negative values fall back to the default for
 * the reason `historyMaxBytes` does: a typo must not turn a bounded ledger
 * into an unbounded one. There is deliberately no way to say "no row cap" —
 * the byte cap cannot be disabled either, and a user who wants a longer trail
 * raises the bound rather than removing it.
 */
export function historyMaxRows(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.SPOTIFY_MCP_HISTORY_MAX_ROWS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HISTORY_MAX_ROWS;
}

/**
 * Retention window in days; SPOTIFY_MCP_HISTORY_RETENTION_DAYS overrides and
 * `0` disables age-based pruning (#703). Negative and non-numeric values fall
 * back to the default, so an unusable value keeps the ledger rather than
 * expiring it.
 */
export function historyRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.SPOTIFY_MCP_HISTORY_RETENTION_DAYS ?? '', 10);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_HISTORY_RETENTION_DAYS;
  return raw;
}

/**
 * Retention window in ms; Infinity when SPOTIFY_MCP_HISTORY_RETENTION_DAYS is 0.
 *
 * Infinity rather than a separate "disabled" flag, because `now - age > ttl`
 * is then false for every age and the expiry test needs no special case —
 * the same shape as `receiptTtlMs` in src/receipts.ts.
 */
export function historyRetentionMs(env: NodeJS.ProcessEnv = process.env): number {
  const days = historyRetentionDays(env);
  return days > 0 ? days * DAY_MS : Number.POSITIVE_INFINITY;
}

export interface HistoryLedgerStats {
  /** Live ledger path. */
  path: string;
  /** Bytes in the live ledger; 0 when it does not exist yet. */
  bytes: number;
  /** Bytes in the rotated generation; 0 when there is none. */
  archive_bytes: number;
  /** Cap both files are held under (2 x maxBytes: live + one generation). */
  cap_bytes: number;
  /**
   * Records counted from a bounded tail read, so the number is a floor rather
   * than a total whenever the ledger holds more than the read limit.
   */
  records: number;
  /** True when `records` hit the read ceiling and more may exist. */
  records_capped: boolean;
  /**
   * EXACT count of complete records across the live file and its rotated
   * generation (#703) — the number the row cap is enforced against, so unlike
   * `records` it does not stop counting at the read limit.
   */
  rows: number;
  /** The row cap `rows` is held under. */
  max_rows: number;
  /** Retention window in days; 0 means no age-based pruning. */
  retention_days: number;
  /**
   * `ts` of the OLDEST retained record, read from the head of the archive or
   * the live file. Absent when the ledger is empty, or when its oldest
   * complete line carries no readable timestamp — which is why it is reported
   * as absent rather than defaulted to a date.
   */
  oldest_ts?: string;
}

/**
 * Where the ledger is and how much of it there is (#905). Growth was
 * unobservable: the doctor row reported a path and a write-failure count, so a
 * ledger at 99% of its cap looked exactly like one at 1%.
 *
 * The record count comes from the same bounded tail read every other reader
 * uses, so this stays O(limit) regardless of file size. When that read hits the
 * ceiling the count is reported as `records_capped`, because a number that
 * stopped counting is not the same as a total.
 *
 * #703 adds the retention view beside it: the EXACT row count the row cap is
 * enforced against, that cap, the retention window, and the oldest record the
 * ledger can date. A byte count and a capped read cannot answer "how much of
 * my history is still here, and since when", which is the question a user
 * enabling an audit trail then wanting it gone actually has.
 */
export async function historyLedgerStats(
  env: NodeJS.ProcessEnv = process.env,
  tokenFile: string,
): Promise<HistoryLedgerStats> {
  const file = historyFilePath(env, tokenFile);
  const archive = historyArchivePath(file);
  const sizeOf = async (path: string): Promise<number> => {
    try {
      return (await stat(path)).size;
    } catch {
      return 0; // no ledger yet
    }
  };
  const [bytes, archiveBytes, records, shape] = await Promise.all([
    sizeOf(file),
    sizeOf(archive),
    readHistory({ file, env, limit: DEFAULT_HISTORY_READ_LIMIT }),
    measureLedger(file),
  ]);
  return {
    path: file,
    bytes,
    archive_bytes: archiveBytes,
    cap_bytes: historyMaxBytes(env) * 2,
    records: records.length,
    records_capped: records.length >= DEFAULT_HISTORY_READ_LIMIT,
    rows: shape.rows,
    max_rows: historyMaxRows(env),
    retention_days: historyRetentionDays(env),
    ...(shape.oldest_ts !== undefined ? { oldest_ts: shape.oldest_ts } : {}),
  };
}

/**
 * Normalize a request path to a route template: drop the query string (it
 * carries `uris=`/`ids=` item payloads) and replace every non-route segment
 * with `{id}`. Idempotent — redacting an already-redacted path is a no-op.
 */
export function redactPath(raw: string): string {
  const [route] = raw.split('?', 1);
  const parts = route!.split('/');
  const out = parts
    .map((seg, i) => (i === 0 || ROUTE_SEGMENT.test(seg) ? seg : '{id}'))
    .join('/');
  return out.length > 1 && out.endsWith('/') ? out.slice(0, -1) : out;
}

/**
 * Truncated SHA-256 of the exact request path. Lets an audit correlate two
 * records that hit the same target without storing the target itself.
 */
function targetFingerprint(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/**
 * Move the live file aside so the next append starts a fresh generation.
 * rename(2) replaces any existing archive atomically, so the ledger never
 * holds more than the live file plus one generation.
 */
async function rotate(file: string): Promise<void> {
  const archive = historyArchivePath(file);
  try {
    await rename(file, archive);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  // rename preserves the old inode's mode — a pre-fix 0644 file would stay
  // world-readable as the archive, so re-assert the mode on it too.
  await chmod(archive, HISTORY_FILE_MODE);
}

// ---------------------------------------------------------------------------
// Row cap + retention (#703)
//
// Rotation bounds the ledger in bytes at a moment in time. It says nothing
// about how MANY dated records that is, nor how long any of them survive —
// and a compliance question ("what is still here, and since when") has no
// answer without both. So the ledger carries two more bounds, enforced over
// BOTH generations: the rotated generation holds the oldest records, so a
// prune that only touched the live file would expire nothing.
// ---------------------------------------------------------------------------

/** Epoch ms a record claims it was written; undefined when it carries no usable `ts`. */
function recordAgeMs(record: HistoryRecord | null | undefined): number | undefined {
  const ts = record?.ts;
  if (typeof ts !== 'string') return undefined;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Bytes of a ledger file; 0 when it is not there, which is not an error. */
async function ledgerFileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/**
 * What the two bounds are checked against, measured without trusting a
 * counter: the exact line count across both generations, and the oldest
 * record the ledger can date.
 */
interface LedgerShape {
  /** Complete lines in the live file plus the rotated generation. */
  rows: number;
  /** `ts` of the oldest line that carries a parseable one. */
  oldest_ts?: string;
  /** Live/archive byte sizes this shape was measured against. */
  live_bytes: number;
  archive_bytes: number;
}

/**
 * Measured shapes, keyed by live path and validated against file SIZE.
 *
 * The reason this cache exists: enforcing a row cap by reading the ledger on
 * every mutation would put a full pass over the file in the append path —
 * the per-append round trip this issue's sibling audit finding (A15-027)
 * already complains about. Sizes are the validation key rather than a row
 * count the process maintains alone, so a writer this process never saw
 * (a second server, an editor) still invalidates the count instead of leaving
 * it confidently wrong.
 *
 * The residual exposure is a mutation landing between the measurement and
 * this process's own append, which the existing byte-rotation `stat` already
 * has: the two writers race by at most the rows they interleave, and the next
 * append re-measures.
 */
const ledgerShapes = new Map<string, LedgerShape>();

/** Every complete line of one ledger, oldest first, across both generations. */
async function readLedgerLines(file: string): Promise<HistoryLine[]> {
  const [archived, live] = await Promise.all([
    readTailLines(historyArchivePath(file), Number.POSITIVE_INFINITY),
    readTailLines(file, Number.POSITIVE_INFINITY),
  ]);
  return [...archived, ...live];
}

async function measureLedger(file: string): Promise<LedgerShape> {
  const [liveBytes, archiveBytes, lines] = await Promise.all([
    ledgerFileSize(file),
    ledgerFileSize(historyArchivePath(file)),
    readLedgerLines(file),
  ]);
  // The oldest line the ledger can DATE. An undated line ahead of it (a
  // hand-edited or pre-`ts` file) is not a date the report may borrow, so the
  // field stays absent rather than naming the next record's timestamp.
  const oldest = lines.find((entry) => recordAgeMs(entry.record) !== undefined);
  return {
    rows: lines.length,
    ...(oldest?.record?.ts !== undefined ? { oldest_ts: oldest.record.ts } : {}),
    live_bytes: liveBytes,
    archive_bytes: archiveBytes,
  };
}

async function ledgerShape(file: string): Promise<LedgerShape> {
  const [liveBytes, archiveBytes] = await Promise.all([
    ledgerFileSize(file),
    ledgerFileSize(historyArchivePath(file)),
  ]);
  const cached = ledgerShapes.get(file);
  if (cached && cached.live_bytes === liveBytes && cached.archive_bytes === archiveBytes) {
    return cached;
  }
  const measured = await measureLedger(file);
  ledgerShapes.set(file, measured);
  return measured;
}

/** True when either bound is currently exceeded. */
function ledgerNeedsPrune(shape: LedgerShape, env: NodeJS.ProcessEnv, now: number): boolean {
  if (shape.rows > historyMaxRows(env)) return true;
  const oldest = shape.oldest_ts === undefined ? undefined : Date.parse(shape.oldest_ts);
  if (oldest === undefined || !Number.isFinite(oldest)) return false;
  return now - oldest > historyRetentionMs(env);
}

/**
 * Replace a ledger's bytes atomically: a uniquely-named temp file in the same
 * directory, fsync, then rename(2) over the target. The rename is the only
 * mutation of the real path, so a crash before it leaves the previous ledger
 * whole rather than a half-pruned one. Temp and target are owner-only, and
 * the mode is re-asserted after creation because a creation-time mode is
 * masked by umask — same idiom as saveTokens and the taste-feedback store.
 *
 * Throws; a failed prune propagates to the caller's policy, which is the same
 * policy an append failure has.
 */
async function writeLedgerFile(file: string, entries: HistoryLine[]): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const handle = await open(tmp, 'w', HISTORY_FILE_MODE);
    try {
      await handle.writeFile(entries.map((entry) => entry.line).join('\n') + (entries.length > 0 ? '\n' : ''), 'utf8');
      await handle.sync(); // on disk before the rename can publish them
    } finally {
      await handle.close();
    }
    await chmod(tmp, HISTORY_FILE_MODE);
    await rename(tmp, file);
  } catch (err) {
    // A unique temp name means a failed write can leave a file nothing else
    // will ever clean up. Do not leave litter in the state directory.
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  await chmod(file, HISTORY_FILE_MODE);
}

/** What a prune removed, for the caller's log line and the tests. */
export interface HistoryPruneResult {
  /** Complete lines found across both generations, before pruning. */
  rows_before: number;
  /** Lines written back, after both bounds. */
  rows_after: number;
  /** Lines dropped for being older than the retention window. */
  expired: number;
  /** Lines dropped for exceeding the row cap. */
  over_cap: number;
}

/**
 * Bring one ledger back inside both bounds, oldest records first.
 *
 * Survivors are the newest lines, kept while they fit the row cap AND the
 * on-disk byte budget rotation already holds the ledger to (2 x maxBytes). The
 * byte term is there so a prune never has to shed a record rotation would
 * have kept: if the cap is lowered below the current size, the byte budget
 * binds instead and the same oldest-first rule applies.
 *
 * Kept lines are then split back across the two generations at the rotation
 * threshold, so the pair is byte-identical to what rotation alone would have
 * produced and no reader has to learn a third layout.
 *
 * The write order is archive, then live, then remove a now-unneeded archive.
 * A crash inside that window leaves the NEW older half duplicated under the
 * OLD live file rather than losing the older half outright: rows that may be
 * counted twice until the next append, which is recoverable, beats rows that
 * are gone, on a store whose whole purpose is the record of what happened.
 */
async function pruneLedger(
  file: string,
  env: NodeJS.ProcessEnv,
  now: number,
): Promise<HistoryPruneResult> {
  const maxRows = historyMaxRows(env);
  const maxBytes = historyMaxBytes(env);
  const ttl = historyRetentionMs(env);
  const lines = await readLedgerLines(file);

  // An undated line is NOT expired, for the reason receipts.ts gives: an
  // unknown age is not a verdict, so a hand-written or pre-`ts` line is kept
  // rather than silently discarded. The row cap still bounds it.
  const fresh = lines.filter((entry) => {
    const age = recordAgeMs(entry.record);
    return age === undefined || now - age <= ttl;
  });

  const keptNewestFirst: HistoryLine[] = [];
  let bytes = 0;
  for (let i = fresh.length - 1; i >= 0; i--) {
    const entry = fresh[i]!;
    if (keptNewestFirst.length >= maxRows) break;
    const size = Buffer.byteLength(entry.line) + 1;
    if (bytes + size > maxBytes * 2) break;
    bytes += size;
    keptNewestFirst.push(entry);
  }
  const kept = keptNewestFirst.reverse();

  // Split at the rotation threshold: `kept[split..]` is the live file, and
  // everything older becomes the one rotated generation.
  let split = kept.length;
  let liveBytes = 0;
  for (let i = kept.length - 1; i >= 0; i--) {
    const size = Buffer.byteLength(kept[i]!.line) + 1;
    if (liveBytes + size > maxBytes) break;
    liveBytes += size;
    split = i;
  }

  // A prune with nothing to prune must not touch the disk. The startup sweep
  // runs on every start, so the rewrite below would otherwise put two fsyncs
  // and an unlink on the path to a `tools/list` for a ledger that is already
  // inside both bounds — and would CREATE an empty ledger for every account
  // that has tokens but has never mutated anything. Recompute the cached shape
  // and stop; the surviving layout is already the one rotation would produce.
  if (kept.length === lines.length) {
    ledgerShapes.set(file, {
      rows: kept.length,
      ...(kept[0]?.record?.ts !== undefined ? { oldest_ts: kept[0].record.ts } : {}),
      live_bytes: liveBytes,
      archive_bytes: bytes - liveBytes,
    });
    return { rows_before: lines.length, rows_after: kept.length, expired: 0, over_cap: 0 };
  }

  const archive = historyArchivePath(file);
  if (split > 0) await writeLedgerFile(archive, kept.slice(0, split));
  await writeLedgerFile(file, kept.slice(split));
  if (split === 0) await rm(archive, { force: true });

  const shape: LedgerShape = {
    rows: kept.length,
    ...(kept[0]?.record?.ts !== undefined ? { oldest_ts: kept[0].record.ts } : {}),
    live_bytes: liveBytes,
    archive_bytes: bytes - liveBytes,
  };
  ledgerShapes.set(file, shape);

  return {
    rows_before: lines.length,
    rows_after: kept.length,
    expired: lines.length - fresh.length,
    over_cap: fresh.length - kept.length,
  };
}

/**
 * Apply both bounds to one ledger now, whether or not anything is over them.
 *
 * Exported with the instant as a parameter so a test can expire a record
 * against a clock it holds rather than waiting 90 days: the record's own `ts`
 * is data, and the age comparison is the only thing under test.
 */
export async function pruneHistoryLedger(
  env: NodeJS.ProcessEnv = process.env,
  tokenFile: string,
  now: number = Date.now(),
): Promise<HistoryPruneResult> {
  return pruneLedger(historyFilePath(env, tokenFile), env, now);
}

/**
 * Enforce both bounds across every account's ledger (#703).
 *
 * Run at startup as well as on append, because a ledger nobody wrote to for a
 * month still ages: pruning only on the next mutation would leave the oldest
 * records sitting on disk for exactly as long as the user did nothing, which
 * is the retention contract this is here to state. Dormant accounts are
 * included for the same reason — a profile the user stopped using is the one
 * whose ledger is guaranteed not to be pruned by an append.
 */
export async function pruneHistoryLedgers(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!isHistoryEnabled(env)) return;
  const now = Date.now();
  for (const file of historyLedgerPaths(env)) {
    try {
      await pruneLedger(file, env, now);
    } catch (err) {
      // Counted and warned exactly like a lost append: the ledger is then
      // larger than the cap the user was told about, and spotify_doctor is
      // the only surface that can say so.
      noteWriteFailure(err, file);
    }
  }
}

/** Serialize + persist one record. Throws; the wrapper below owns the policy. */
async function writeHistoryRecord(
  file: string,
  record: MutationRecord,
  tokenFile: string,
  now: number,
): Promise<void> {
  // Whitelist serialization: only these fields ever reach disk, so a
  // stray token/body reference in the record object cannot be persisted.
  // `account` is the profile segment from `accountStoreKey`, empty for the
  // default account: it is what makes a merged two-account file separable
  // after the fact, and what a reader uses to tell whose write a line was.
  const line =
    JSON.stringify({
      ts: new Date(now).toISOString(),
      who: normalizeActor(record.who) ?? 'agent',
      method: record.method.toUpperCase(),
      path: redactPath(record.path),
      target: targetFingerprint(record.path),
      ...(record.snapshot_id !== undefined ? { snapshot_id: record.snapshot_id } : {}),
      ...(accountStoreKey(tokenFile) !== '' ? { account: accountStoreKey(tokenFile) } : {}),
    }) + '\n';
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: HISTORY_DIR_MODE });
  // Directory mode is also creation-only — tighten a pre-existing one.
  await chmod(dir, HISTORY_DIR_MODE);
  // One measurement serves both bounds: the row/age check needs the ledger's
  // shape, and `live_bytes` from the same pass is the rotation threshold
  // check, so the append path does not stat the file a second time.
  const before = await ledgerShape(file);
  const max = historyMaxBytes();
  const rotated = before.live_bytes > 0 && before.live_bytes + Buffer.byteLength(line) > max;
  if (rotated) await rotate(file);
  await appendFile(file, line, { encoding: 'utf8', mode: HISTORY_FILE_MODE });
  // Creation-time mode alone leaves pre-existing or copied files readable by
  // others; re-assert owner-only on every write.
  await chmod(file, HISTORY_FILE_MODE);
  // The post-append shape is exact arithmetic, not a guess: this append added
  // one line of known length to one of the two files. Carrying it forward is
  // what keeps the row cap from costing a full read of the ledger per
  // mutation.
  const after: LedgerShape = {
    rows: before.rows + 1,
    // An empty ledger's oldest record after this append is THIS one. Carrying
    // that forward matters because the cached shape is what the age cap is
    // checked against, and a ledger that starts empty would otherwise report
    // no oldest record until something else invalidated the cache.
    ...(before.oldest_ts !== undefined
      ? { oldest_ts: before.oldest_ts }
      : before.rows === 0
        ? { oldest_ts: new Date(now).toISOString() }
        : {}),
    live_bytes: rotated ? Buffer.byteLength(line) : before.live_bytes + Buffer.byteLength(line),
    archive_bytes: rotated ? before.live_bytes : before.archive_bytes,
  };
  ledgerShapes.set(file, after);
  if (ledgerNeedsPrune(after, process.env, now)) {
    await pruneLedger(file, process.env, now);
  }
}

/**
 * Append one mutation record. No-op unless history is enabled.
 *
 * Never rejects: a history problem must not fail the mutation it describes.
 * It is also never silent — a lost append is counted, warns once per process,
 * and turns the spotify_doctor `history` row red (#591).
 */
export async function appendHistory(
  record: MutationRecord,
  tokenFile: string,
): Promise<void> {
  if (!isHistoryEnabled()) return;
  const file = historyFilePath(process.env, tokenFile);
  // ONE clock for the record's own `ts` and for the age check against it, so
  // the record a prune just kept can never be the record that prune expired.
  const now = Date.now();
  try {
    await writeHistoryRecord(file, record, tokenFile, now);
  } catch (err) {
    noteWriteFailure(err, file);
  }
}

/**
 * One complete line of a ledger file, with the record it parses to.
 *
 * The raw line travels with the parsed record because the row/age prune
 * rewrites the ledger from what it read, and re-serializing a parsed record
 * would quietly normalise it — an unparseable line would be dropped and a
 * parsed one re-keyed — when the honest operation is "delete some lines, keep
 * the rest byte-for-byte".
 */
interface HistoryLine {
  line: string;
  record: HistoryRecord | null;
}

/**
 * Newest `limit` PARSEABLE records of a JSONL file, in chronological order,
 * found by walking backwards in fixed-size chunks. Memory and I/O are bounded
 * by the requested record count, never by the file's size. Unparseable lines
 * are skipped and do not consume the budget — with one exception: a limit of
 * `Infinity` collects every complete line, parseable or not, which is what the
 * row measurement needs (a line is a row on disk whether or not it reads).
 */
async function readTailLines(file: string, limit: number): Promise<HistoryLine[]> {
  let handle: FileHandle;
  try {
    handle = await open(file, 'r');
  } catch {
    return [];
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return [];
    const decoder = new StringDecoder('utf8');
    const newestFirst: HistoryLine[] = [];
    const budgeted = Number.isFinite(limit);
    // Parseable records collected so far. This is the budget, NOT
    // `newestFirst.length`: an unparseable line must not spend the caller's
    // budget, or a ledger with junk in it would return fewer than `limit`
    // records from a file that holds them. Under an `Infinity` limit the
    // counter is unused — every line is wanted either way.
    let collected = 0;
    const take = (segment: string): void => {
      // A blank segment is not a record. The segment after the file's final
      // newline is always one, and counting it would make every measured
      // ledger a row longer than it is — which the row cap would then enforce
      // against, dropping a real record to make room for nothing.
      if (!segment.trim()) return;
      const entry = entryFor(segment);
      newestFirst.push(entry);
      if (entry.record !== null) collected += 1;
    };
    let pos = size;
    // Partial line carried across the low end of the current chunk window.
    let carry = '';
    while (pos > 0 && (!budgeted || collected < limit)) {
      const len = Math.min(READ_CHUNK_BYTES, pos);
      pos -= len;
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await handle.read(buf, 0, len, pos);
      const parts = (decoder.write(buf.subarray(0, bytesRead)) + carry).split('\n');
      carry = parts.shift() ?? '';
      for (let i = parts.length - 1; i >= 0 && (!budgeted || collected < limit); i--) {
        take(parts[i]!);
      }
      if (pos === 0 && carry.trim()) {
        if (!budgeted || collected < limit) take(carry);
        carry = '';
      }
    }
    return newestFirst.reverse();
  } finally {
    await handle.close();
  }
}

function entryFor(line: string): HistoryLine {
  return { line, record: parseRecord(line) };
}

async function readTailRecords(file: string, limit: number): Promise<HistoryRecord[]> {
  const entries = await readTailLines(file, limit);
  return entries
    .map((entry) => entry.record)
    .filter((record): record is HistoryRecord => record !== null);
}

function parseRecord(line: string): HistoryRecord | null {
  if (!line.trim()) return null;
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null ? (value as HistoryRecord) : null;
  } catch {
    return null;
  }
}

/**
 * Read the mutation ledger with a hard memory ceiling: at most `limit`
 * records (default DEFAULT_HISTORY_READ_LIMIT) held at once, tailed from the
 * live file and, when that is not enough, from the rotated archive. A ledger
 * of any size therefore costs the same resident memory. Records are returned
 * oldest-first, matching append order.
 */
export async function readHistory(options: HistoryReadOptions): Promise<HistoryRecord[]> {
  const limit = Math.max(0, Math.trunc(options.limit ?? DEFAULT_HISTORY_READ_LIMIT));
  if (limit === 0) return [];
  const file = options.file ?? historyFilePath(options.env, options.tokenFile);
  const [older, newer] = await Promise.all([
    readTailRecords(`${file}${HISTORY_ARCHIVE_SUFFIX}`, limit),
    readTailRecords(file, limit),
  ]);
  const merged = [...older, ...newer];
  return merged.length > limit ? merged.slice(merged.length - limit) : merged;
}
