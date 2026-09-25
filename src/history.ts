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
 * Three hardening properties, each independently enforced:
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
 */
import { createHash } from 'node:crypto';
import { open, appendFile, chmod, mkdir, rename, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { truthyEnv } from './config.js';

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

export interface HistoryReadOptions {
  /** Max records to return, oldest-dropped. Default DEFAULT_HISTORY_READ_LIMIT. */
  limit?: number;
  /** Override the file to read (rotation archive derived from it). */
  file?: string;
  /** Env used to resolve the file path. Default process.env. */
  env?: NodeJS.ProcessEnv;
}

/** Live file rotates past this many bytes; SPOTIFY_MCP_HISTORY_MAX_BYTES overrides. */
export const DEFAULT_HISTORY_MAX_BYTES = 1_048_576;

/** Records kept in memory by readHistory() — the reader's memory ceiling. */
export const DEFAULT_HISTORY_READ_LIMIT = 500;
/** Owner-only modes, re-asserted on every write (creation-only mode args are not enough). */
export const HISTORY_FILE_MODE = 0o600;
export const HISTORY_DIR_MODE = 0o700;
/** Single rotation generation; keeps total on-disk history at 2 x maxBytes. */
export const HISTORY_ARCHIVE_SUFFIX = '.1';

const READ_CHUNK_BYTES = 64 * 1024;

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

/** Target JSONL path; SPOTIFY_MCP_HISTORY_DIR overrides the directory. */
export function historyFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.SPOTIFY_MCP_HISTORY_DIR ?? join(homedir(), '.spotify-mcp', 'history');
  return join(dir, 'mutations.jsonl');
}


/** Rotation threshold in bytes; SPOTIFY_MCP_HISTORY_MAX_BYTES overrides. */
export function historyMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.SPOTIFY_MCP_HISTORY_MAX_BYTES ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HISTORY_MAX_BYTES;
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
export function targetFingerprint(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/**
 * Move the live file aside so the next append starts a fresh generation.
 * rename(2) replaces any existing archive atomically, so the ledger never
 * holds more than the live file plus one generation.
 */
async function rotate(file: string): Promise<void> {
  const archive = `${file}${HISTORY_ARCHIVE_SUFFIX}`;
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

/**
 * Append one mutation record. No-op unless history is enabled; never throws
 * to the caller's face is NOT a goal here — callers (client) catch and drop.
 */
export async function appendHistory(record: MutationRecord): Promise<void> {
  if (!isHistoryEnabled()) return;
  // Whitelist serialization: only these fields ever reach disk, so a
  // stray token/body reference in the record object cannot be persisted.
  const line =
    JSON.stringify({
      ts: new Date().toISOString(),
      who: record.who ?? 'agent',
      method: record.method.toUpperCase(),
      path: redactPath(record.path),
      target: targetFingerprint(record.path),
      ...(record.snapshot_id !== undefined ? { snapshot_id: record.snapshot_id } : {}),
    }) + '\n';
  const file = historyFilePath();
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: HISTORY_DIR_MODE });
  // Directory mode is also creation-only — tighten a pre-existing one.
  await chmod(dir, HISTORY_DIR_MODE);
  const max = historyMaxBytes();
  let size = 0;
  try { size = (await stat(file)).size; } catch { /* no ledger yet: nothing to rotate */ }
  if (size > 0 && size + Buffer.byteLength(line) > max) await rotate(file);
  await appendFile(file, line, { encoding: 'utf8', mode: HISTORY_FILE_MODE });
  // Creation-time mode alone leaves pre-existing or copied files readable by
  // others; re-assert owner-only on every write.
  await chmod(file, HISTORY_FILE_MODE);
}

/**
 * Newest `limit` complete lines of a JSONL file, in chronological order,
 * found by walking backwards in fixed-size chunks. Memory and I/O are bounded
 * by the requested record count, never by the file's size. Unparseable lines
 * are skipped.
 */
async function readTailRecords(file: string, limit: number): Promise<HistoryRecord[]> {
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
    const newestFirst: HistoryRecord[] = [];
    let pos = size;
    // Partial line carried across the low end of the current chunk window.
    let carry = '';
    while (pos > 0 && newestFirst.length < limit) {
      const len = Math.min(READ_CHUNK_BYTES, pos);
      pos -= len;
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await handle.read(buf, 0, len, pos);
      const parts = (decoder.write(buf.subarray(0, bytesRead)) + carry).split('\n');
      carry = parts.shift() ?? '';
      for (let i = parts.length - 1; i >= 0 && newestFirst.length < limit; i--) {
        const parsed = parseRecord(parts[i]!);
        if (parsed) newestFirst.push(parsed);
      }
      if (pos === 0 && carry.trim()) {
        if (newestFirst.length < limit) {
          const head = parseRecord(carry);
          if (head) newestFirst.push(head);
        }
        carry = '';
      }
    }
    return newestFirst.reverse();
  } finally {
    await handle.close();
  }
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
export async function readHistory(options: HistoryReadOptions = {}): Promise<HistoryRecord[]> {
  const limit = Math.max(0, Math.trunc(options.limit ?? DEFAULT_HISTORY_READ_LIMIT));
  if (limit === 0) return [];
  const file = options.file ?? historyFilePath(options.env);
  const [older, newer] = await Promise.all([
    readTailRecords(`${file}${HISTORY_ARCHIVE_SUFFIX}`, limit),
    readTailRecords(file, limit),
  ]);
  const merged = [...older, ...newer];
  return merged.length > limit ? merged.slice(merged.length - limit) : merged;
}
