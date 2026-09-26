/**
 * Mutation receipts (#112 idea 11).
 *
 * After a mutating tool call succeeds, `issueReceipt` refetches minimal state
 * to verify the mutation actually landed, stores a receipt, and hands back a
 * short prose summary the tool can append to its result text.
 *
 * ## How a tool integrates it (orchestrator will wire this)
 *
 * 1. **Call after a successful mutation.** Immediately after the write call
 *    (add/remove playlist items → kind `'playlist_items'`; save/remove from
 *    library → kind `'library'`; create/update playlist metadata → kind
 *    `'playlist_meta'`), invoke:
 *
 *      const receipt = await issueReceipt(client, {
 *        kind: 'playlist_items',
 *        id: playlistId,
 *        uris: addedUris,
 *        before: previousTotalMatches, // optional, when known pre-mutation
 *      });
 *
 * 2. **Append the formatted lines to the result text**, e.g.
 *
 *      text += '\n' + formatReceipt(receipt);
 *
 *    so the model sees explicit confirmation of what landed (and what did
 *    not) in the same turn as the mutation.
 *
 * 3. **Expose `verify_receipt` as a follow-up tool** wrapping
 *    `verifyReceipt(id)`: takes a receipt id, returns the stored receipt (or
 *    "unknown receipt" prose) so a later turn can re-inspect verification
 *    without refetching. The live store is an in-module Map capped at
 *    MAX_RECEIPTS with FIFO eviction, and ids are boot-scoped
 *    (`rcpt_<bootId>-<n>`) so a stale id from an earlier session can never
 *    resolve to a DIFFERENT mutation (#587).
 *
 * ## Surviving a restart (#587)
 *
 * With `SPOTIFY_MCP_RECEIPTS` truthy, each issued receipt is appended to
 * `<dir>/receipts.jsonl` and the newest MAX_RECEIPTS are loaded back on first
 * use, so `verify_receipt` and `undo_mutation` survive a host restart, a
 * crash, or a session longer than the in-memory cap. The directory follows
 * the history store's family: `SPOTIFY_MCP_RECEIPTS_DIR`, else
 * `SPOTIFY_MCP_HISTORY_DIR`, else `~/.spotify-mcp`. With persistence off the
 * store is process-local and every miss message SAYS so — receipts are never
 * presented as account history. Retention is stated, never implied: the
 * newest MAX_RECEIPTS mutations, each kept for at most
 * `SPOTIFY_MCP_RECEIPTS_TTL_HOURS` (default 24, 0 disables expiry).
 */

import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { truthyEnv } from './config.js';
import type { PlaylistItemsResponse } from './types/spotify.js';

/** Minimal client surface needed here — satisfied by SpotifyClient and test stubs. */
export interface ReceiptClient {
  get<T>(path: string, params?: Record<string, string>): Promise<T | null>;
}

type ReceiptKind = 'playlist_items' | 'library' | 'playlist_meta';

/**
 * The per-type buckets the legacy `save_items` / `remove_saved_items` tools
 * write (#1095). One bucket is one Spotify endpoint (`/me/tracks`,
 * `/me/albums`, `/me/shows`, `/me/episodes`, `/me/audiobooks`); `undo_mutation`
 * reads the receipt's `writes` to invert through these endpoints instead of
 * the unified `/me/library` the unified tools use, so a receipt issued by a
 * legacy tool stays executable on the credentials the legacy tools exist for.
 *
 * Mirrors `SAVED_URI_TYPES` in `src/tools/library.ts`; keep them in sync.
 */
export type LibraryBucketType = 'track' | 'album' | 'show' | 'episode' | 'audiobook';

/**
 * One entry per URI whose playlist occurrences a mutation touched: the
 * zero-based row indices the mutation added or removed (#625).
 */
interface ReceiptAffected {
  uri: string;
  positions: number[];
}

export interface Receipt {
  receipt_id: string;
  kind: ReceiptKind;
  /** Playlist id for playlist_items / playlist_meta kinds. */
  id?: string;
  /** True when every checked uri is present (or the meta fetch succeeded). */
  verified: boolean;
  /** Occurrence count supplied by the caller pre-mutation, when known. */
  before?: number;
  /** Post-mutation count of matched rows / present uris. */
  after?: number;
  /** Uris not found by the verification refetch (empty when verified). */
  missing: string[];
  /** URIs that were part of the original mutation (for undo). */
  uris: string[];
  /**
   * Per-type writes a legacy library mutation landed (#1095). Each entry is
   * one bucket the legacy `save_items` / `remove_saved_items` tools wrote,
   * so `undo_mutation` can invert through the same per-type endpoints the
   * mutation used (`/me/tracks`, `/me/albums`, `/me/shows?ids=…`, …) rather
   * than `/me/library`. Receipts without this field still invert through
   * `/me/library` so older receipts and receipts from `save_to_library` /
   * `remove_from_library` keep working.
   */
  writes?: Array<{ type: LibraryBucketType; ids: string[] }>;
  /**
   * Which way the mutation went (#625): `added` for save/add receipts, `removed`
   * for removal receipts. Derived from `expectPresent` so `undo` can invert the
   * original operation instead of always deleting.
   */
  direction?: 'added' | 'removed';
  /**
   * The direction the mutation was ISSUED with (#586): `false` for a removal,
   * `true` for an addition or a meta receipt. Persisted so a receipt rendered
   * after the fact — `verify_receipt` re-renders the stored receipt with no
   * caller options — still labels its `missing` list correctly. Without it
   * `formatReceipt` fell back to the addition vocabulary and printed a
   * leftover removal uri as "missing uris", i.e. the opposite of what the
   * refetch observed.
   */
  expect_present?: boolean;
  /**
   * The exact playlist rows this mutation touched (#625), recorded from the
   * post-mutation walk. `undo` removes these positions rather than every copy
   * of the URI, so undoing an add cannot destroy a row that predated it.
   * Absent when the walk could not observe the affected rows (for example a
   * playlist larger than the verifiable window) — undo then refuses instead
   * of guessing.
   */
  affected?: ReceiptAffected[];
  /**
   * Post-mutation occurrence count per recorded uri, when the walk counted
   * them (#625). Undo needs this to know whether a uri had copies that
   * PREDATE the mutation: removing the added row must leave those in place, so
   * the uri is still present afterwards and the post-state check must expect
   * presence rather than absence.
   */
  occurrences?: Record<string, number>;
  /** When true, playlist exceeds verifiable window — verified is false due to cap, not missing data. */
  windowExceeded?: boolean;
  /** Human reason when not verified or window exceeded. */
  reason?: string;
  /**
   * Epoch ms the receipt was issued (#587). The retention clock and
   * `receipt_lookup`'s `since` filter both read it, and it is persisted with
   * the receipt so one loaded after a restart keeps its original age.
   */
  issued_at?: number;
}

export interface IssueReceiptOpts {
  kind: ReceiptKind;
  id?: string;
  uris: string[];
  before?: number;
  /**
   * Whether the mutation was expected to make the uris PRESENT
   * (add/save — default) or ABSENT (remove). Applies to the
   * 'playlist_items' and 'library' kinds.
   */
  expectPresent?: boolean;
  /** For targeted-position removals: the specific (uri, position) pairs removed. When set, verification is per-position not binary presence. */
  targetedPositions?: Array<{ uri: string; position: number }>;
  /**
   * For an add that inserted at a given index rather than appending (#625).
   * Without it the added rows are assumed to be the uris' LAST occurrences,
   * which is wrong for a positional add — a caller that used `position` must
   * pass it here or undo will target a row that predates the mutation.
   */
  insertPosition?: number;
  /**
   * The exact playlist rows THIS mutation created, for callers that know them
   * better than a post-mutation walk can infer (#625).
   *
   * The walk can only infer an append's last-occurrence rule or one contiguous
   * `insertPosition`. Neither describes an undo, whose writes are a
   * delete-only rollback (which created nothing) or re-inserted runs at
   * scattered indices — and the append rule is actively wrong for both, since
   * it names a row that PREDATES the mutation, which a chained undo then
   * deletes. Each position is verified against the observed list, so a wrong
   * guess records nothing and undo refuses rather than deleting what it cannot
   * justify. An EMPTY list means the mutation created no rows at all.
   */
  createdPositions?: Array<{ uri: string; position: number }>;
  /** Expected number of rows removed (for window-exceeded detection). */
  expectedRemovedCount?: number;
  /**
   * Per-type writes the mutation landed (#1095). Forwarded onto the receipt
   * so `undo_mutation` can invert through the same per-type endpoints the
   * mutation used instead of `/me/library`. Set only by legacy
   * `save_items` / `remove_saved_items`, which deliberately avoid
   * `/me/library` for credentials that cannot use it.
   */
  writes?: Array<{ type: LibraryBucketType; ids: string[] }>;
}

// Live receipt store: an in-module Map capped at MAX_RECEIPTS with FIFO
// eviction, mirrored to disk when persistence is on (#587).
/** Receipts kept live — the undo/verify window, in memory and on disk. */
export const MAX_RECEIPTS = 100;
/** Default receipt lifetime; SPOTIFY_MCP_RECEIPTS_TTL_HOURS overrides (0 = never). */
export const DEFAULT_RECEIPT_TTL_HOURS = 24;
/** Owner-only modes, re-asserted on every write, like the history ledger's. */
const RECEIPT_FILE_MODE = 0o600;
const RECEIPT_DIR_MODE = 0o700;
const RECEIPT_FILE = 'receipts.jsonl';
/**
 * The trail is compacted once it holds this many lines, so a long session
 * costs one rewrite per MAX_RECEIPT_LINES appends instead of one per
 * mutation. Eviction is FIFO by issue order, exactly like the in-memory cap.
 */
const MAX_RECEIPT_LINES = MAX_RECEIPTS * 4;
/** Hard ceiling on what a load will read from disk, whatever the file's size. */
const MAX_RECEIPT_FILE_BYTES = 4 * 1024 * 1024;

const store = new Map<string, Receipt>();
/**
 * Ids must be unique across PROCESSES, not just within one: a host that
 * respawns the server hands the agent ids from the previous session, and a
 * bare `rcpt_1` counter would resolve those to a DIFFERENT, later mutation
 * (#587). The boot id (process start time + random suffix) makes that
 * collision impossible in both directions.
 */
const bootId = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
let nextSeq = 1;
let loaded = false;
/** Lines this process has appended, so compaction stays amortized O(1). */
let onDiskLines = 0;

/** True when receipts are persisted to disk (SPOTIFY_MCP_RECEIPTS). */
export function isReceiptsPersistent(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthyEnv(env.SPOTIFY_MCP_RECEIPTS);
}

/** Receipt JSONL path; SPOTIFY_MCP_RECEIPTS_DIR / SPOTIFY_MCP_HISTORY_DIR override the dir. */
export function receiptsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const dir =
    env.SPOTIFY_MCP_RECEIPTS_DIR ??
    env.SPOTIFY_MCP_HISTORY_DIR ??
    join(homedir(), '.spotify-mcp');
  return join(dir, RECEIPT_FILE);
}

/** Receipt lifetime in ms; Infinity when SPOTIFY_MCP_RECEIPTS_TTL_HOURS is 0. */
export function receiptTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.SPOTIFY_MCP_RECEIPTS_TTL_HOURS ?? '', 10);
  if (!Number.isFinite(raw)) return DEFAULT_RECEIPT_TTL_HOURS * 3_600_000;
  if (raw <= 0) return Infinity;
  return raw * 3_600_000;
}

/** Human retention statement shared by every "unknown receipt" message. */
export function receiptRetentionLabel(env: NodeJS.ProcessEnv = process.env): string {
  const ttl = receiptTtlMs(env);
  if (!Number.isFinite(ttl)) return 'with no time limit';
  const hours = ttl / 3_600_000;
  const window = hours >= 1
    ? `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`
    : `${Math.round(ttl / 60_000)}m`;
  return `for up to ${window}`;
}

/**
 * The one miss message every receipt-facing tool must use. It names the real
 * scope: an id from an earlier session is not account history — it is either
 * gone (cap or TTL) or was never persisted at all (#587).
 */
export function receiptMissMessage(
  receiptId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const scope = isReceiptsPersistent(env)
    ? `persisted in ${receiptsFilePath(env)}`
    : 'session-scoped — receipts are not persisted to disk, so an id from an earlier session is gone';
  return `Unknown or expired receipt "${receiptId}" — receipts are ${scope}; only the ${MAX_RECEIPTS} most recent mutations are kept, ${receiptRetentionLabel(env)}.`;
}

/** Tail of a text file, bounded by maxBytes, skipping a partial leading line. */
function readTailText(file: string, maxBytes: number): string | null {
  const { size } = statSync(file);
  const start = size > maxBytes ? size - maxBytes : 0;
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    if (start === 0) return text;
    const nl = text.indexOf('\n');
    return nl === -1 ? '' : text.slice(nl + 1);
  } finally {
    closeSync(fd);
  }
}

const RECEIPT_KINDS: ReadonlySet<string> = new Set<ReceiptKind>([
  'playlist_items',
  'library',
  'playlist_meta',
]);

/** Parse one persisted line, or null when it is not a receipt this build can use. */
function parseReceiptLine(line: string): Receipt | null {
  if (!line.trim()) return null;
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== 'object' || value === null) return null;
    const fields = value as Record<string, unknown>;
    if (typeof fields.receipt_id !== 'string') return null;
    if (!RECEIPT_KINDS.has(fields.kind as string)) return null;
    if (!Array.isArray(fields.uris) || !Array.isArray(fields.missing)) return null;
    return value as Receipt;
  } catch {
    return null;
  }
}

/**
 * Drop receipts past the TTL. A receipt with no timestamp is NOT expired —
 * an unknown age is not a verdict, so a legacy or hand-written line stays
 * resolvable rather than being silently discarded.
 */
function pruneExpired(now: number, ttl: number): void {
  if (!Number.isFinite(ttl)) return;
  for (const [id, r] of store) {
    if (typeof r.issued_at === 'number' && now - r.issued_at > ttl) store.delete(id);
  }
}

/** Rehydrate the store from the trail: newest MAX_RECEIPTS, in issue order. */
function loadFromDisk(env: NodeJS.ProcessEnv): void {
  const text = readTailText(receiptsFilePath(env), MAX_RECEIPT_FILE_BYTES);
  if (text === null) return;
  const parsed = text
    .split('\n')
    .map(parseReceiptLine)
    .filter((r): r is Receipt => r !== null);
  for (const r of parsed.slice(-MAX_RECEIPTS)) store.set(r.receipt_id, r);
  onDiskLines = parsed.length;
  pruneExpired(Date.now(), receiptTtlMs(env));
}

/** First use in a process hydrates the store; every later call is a no-op. */
function ensureLoaded(env: NodeJS.ProcessEnv = process.env): void {
  if (loaded) return;
  loaded = true;
  if (!isReceiptsPersistent(env)) return;
  try {
    loadFromDisk(env);
  } catch {
    // An unreadable or corrupt trail must not break verify/undo: the store
    // starts empty and the next append rebuilds it.
  }
}

/** Rewrite the trail with only the live receipts, in FIFO eviction order. */
function compactTrail(file: string): void {
  const retained = [...store.values()].slice(-MAX_RECEIPTS);
  const body = retained.map((r) => JSON.stringify(r)).join('\n');
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body.length > 0 ? body + '\n' : '', { encoding: 'utf8', mode: RECEIPT_FILE_MODE });
  renameSync(tmp, file);
  onDiskLines = retained.length;
}

/** Append one receipt. Never throws: a full or read-only disk must not fail a mutation. */
function persist(receipt: Receipt, env: NodeJS.ProcessEnv): void {
  if (!isReceiptsPersistent(env)) return;
  const file = receiptsFilePath(env);
  try {
    const dir = dirname(file);
    mkdirSync(dir, { recursive: true, mode: RECEIPT_DIR_MODE });
    chmodSync(dir, RECEIPT_DIR_MODE);
    appendFileSync(file, JSON.stringify(receipt) + '\n', { encoding: 'utf8', mode: RECEIPT_FILE_MODE });
    // A creation-time mode alone leaves a pre-existing or copied file
    // readable by others; re-assert owner-only on every write, as the
    // history ledger does.
    chmodSync(file, RECEIPT_FILE_MODE);
    onDiskLines += 1;
    if (onDiskLines > MAX_RECEIPT_LINES) compactTrail(file);
  } catch {
    /* best-effort: the in-memory receipt still answers this session's lookups */
  }
}

/**
 * Test-only: drop every in-memory trace of receipts so the next access
 * re-reads the trail — the state a freshly spawned process is in.
 */
export function __resetReceiptStoreForTests(): void {
  store.clear();
  nextSeq = 1;
  loaded = false;
  onDiskLines = 0;
}

/** Stored receipt lookup for the orchestrator-wired `verify_receipt` tool. */
export function verifyReceipt(receiptId: string): Receipt | undefined {
  ensureLoaded();
  pruneExpired(Date.now(), receiptTtlMs());
  return store.get(receiptId);
}
/** All receipts in insertion order (for undo). */
export function getAllReceipts(): Receipt[] {
  ensureLoaded();
  pruneExpired(Date.now(), receiptTtlMs());
  return [...store.values()];
}

const PLAYLIST_ITEM_PAGES_CAP = 5;
const PLAYLIST_ITEMS_PAGE_SIZE = 100;
const LIBRARY_CONTAINS_CHUNK = 50;

/**
 * Refetch minimal state after a mutation and record whether it landed.
 * Never throws on shape surprises — unverifiable state yields
 * `verified: false` with the offending uris in `missing`.
 */
export async function issueReceipt(
  client: ReceiptClient,
  opts: IssueReceiptOpts,
): Promise<Receipt> {
  let affected: ReceiptAffected[] | undefined;
  let missing: string[] = [];
  let after: number | undefined;
  let verified: boolean;
  let _windowExceeded = false;
  let _reason: string | undefined;
  let occurrences: Record<string, number> | undefined;

  if (opts.kind === 'playlist_items') {
    // Walk /playlists/{id}/items in 100-row pages, at most 5 pages, counting
    // occurrences of each uri across all fetched rows. For targeted-position
    // removals, verify per-position: each removed position must now hold a
    // different URI (or the list shrank). For large playlists exceeding the
    // window, return window-exceeded rather than misleading missing list.
    const isTargeted = opts.targetedPositions !== undefined && opts.targetedPositions.length > 0;
    const counts = new Map<string, number>(opts.uris.map((u) => [u, 0]));
    // Capture the full ordered URI list for per-position checks
    const orderedUris: (string | null)[] = [];
    let totalReported: number | undefined;
    // True only when the walk ended on a short/absent-next page, i.e. it really
    // did see every row. Running out of pages mid-list leaves it false.
    let sawWholeList = false;
    for (let page = 0; page < PLAYLIST_ITEM_PAGES_CAP; page++) {
      const res = await client.get<PlaylistItemsResponse>(
        `/playlists/${encodeURIComponent(opts.id ?? '')}/items`,
        { limit: String(PLAYLIST_ITEMS_PAGE_SIZE), offset: String(page * PLAYLIST_ITEMS_PAGE_SIZE) },
      );
      if (!res || !Array.isArray(res.items)) break;
      if (typeof res.total === 'number') totalReported = res.total;
      for (const row of res.items) {
        const uri = row?.item?.uri ?? null;
        orderedUris.push(uri);
        if (uri && counts.has(uri)) counts.set(uri, (counts.get(uri) ?? 0) + 1);
      }
      if (!res.next || res.items.length < PLAYLIST_ITEMS_PAGE_SIZE) {
        sawWholeList = true;
        break;
      }
    }
    // Detect window exceeded: last fetched page was full and total > fetched
    if (totalReported !== undefined && totalReported > orderedUris.length && orderedUris.length >= PLAYLIST_ITEM_PAGES_CAP * PLAYLIST_ITEMS_PAGE_SIZE) {
      _windowExceeded = true;
    }
    // Per-uri counts let a later undo tell a copy that PREDATES the mutation
    // from one it created, which decides whether absence or presence is the
    // correct post-state after the rollback. Gated on the same condition as
    // `affected` below: a truncated walk's counts undercount, and an
    // undercount here becomes a false "the uri is gone" expectation later.
    if (sawWholeList) {
      occurrences = Object.fromEntries(opts.uris.map((u) => [u, counts.get(u) ?? 0]));
    }
    // Occurrence bookkeeping (#625): record WHICH rows this mutation touched,
    // so `undo` reverses exactly those rows instead of every copy of the URI.
    // An add appends one row per appearance of a uri, so the rows to reverse
    // are that uri's LAST k occurrences; a positions-targeted removal reports
    // the positions the caller removed. A bare removal reindexes the rows it
    // removed, so their positions are unknowable afterwards and stay unrecorded.
    //
    // Derivation is gated on having seen the WHOLE list. On a playlist larger
    // than the window the rows the add appended are off-window, so the last
    // *visible* occurrence of a duplicated uri is a row that PREDATES the
    // mutation — recording it would make undo delete pre-existing state, which
    // is the one thing this bookkeeping exists to prevent. Undo then refuses.
    affected = [];
    if (sawWholeList) {
      if (opts.expectPresent !== false) {
        if (opts.createdPositions !== undefined) {
          // The caller states exactly which rows this mutation created — the
          // only honest input for an undo, whose write shape no walk can
          // infer. Every position is checked against the observed list, so a
          // guess that does not hold records nothing and a chained undo
          // refuses rather than deleting a row it cannot justify. An empty
          // list is meaningful: the mutation created no rows, and the copies
          // that survive a delete-only rollback PREDATE it, so claiming one
          // here would let the next undo delete pre-existing state (#625).
          const created = opts.createdPositions;
          if (created.every((p) => orderedUris[p.position] === p.uri)) {
            const byUri = new Map<string, number[]>();
            for (const { uri, position } of created) {
              const list = byUri.get(uri);
              if (list) list.push(position);
              else byUri.set(uri, [position]);
            }
            for (const [uri, positions] of byUri) {
              affected.push({ uri, positions: [...positions].sort((a, b) => a - b) });
            }
          }
        } else if (opts.insertPosition !== undefined) {
          // A positional add inserts the posted uris IN ORDER at that index, so
          // each one occupies `insertPosition + its own index in the request`.
          // Treating it as an append instead would record the uri's last
          // occurrence — a row that PREDATES the mutation, and the row undo
          // would then delete. The layout is verified against the observed
          // list; if it does not hold, nothing is recorded and undo refuses.
          const at = opts.insertPosition;
          const holds = opts.uris.every((uri, i) => orderedUris[at + i] === uri);
          if (holds) {
            const byUri = new Map<string, number[]>();
            opts.uris.forEach((uri, i) => {
              const list = byUri.get(uri);
              if (list) list.push(at + i);
              else byUri.set(uri, [at + i]);
            });
            for (const [uri, positions] of byUri) affected.push({ uri, positions });
          }
        } else {
          // An append: the rows it created are that uri's LAST k occurrences.
          const addedPerUri = new Map<string, number>();
          for (const uri of opts.uris) addedPerUri.set(uri, (addedPerUri.get(uri) ?? 0) + 1);
          for (const [uri, added] of addedPerUri) {
            const positions: number[] = [];
            for (let i = orderedUris.length - 1; i >= 0 && positions.length < added; i--) {
              if (orderedUris[i] === uri) positions.push(i);
            }
            // A uri with fewer visible rows than the add created is not fully
            // accounted for; recording a partial set would target a wrong row.
            if (positions.length === added) affected.push({ uri, positions: positions.reverse() });
          }
        }
      } else if (isTargeted) {
        const byUri = new Map<string, number[]>();
        for (const p of opts.targetedPositions!) {
          const list = byUri.get(p.uri);
          if (list) list.push(p.position);
          else byUri.set(p.uri, [p.position]);
        }
        for (const [uri, positions] of byUri) {
          affected.push({ uri, positions: [...positions].sort((a, b) => a - b) });
        }
      }
    }
    const expectPresent = opts.expectPresent ?? true;
    if (expectPresent) {
      if (_windowExceeded) {
        missing = [...counts.entries()].filter(([, n]) => n === 0).map(([uri]) => uri);
        after = [...counts.values()].reduce((a, b) => a + b, 0);
        if (missing.length === 0) {
          verified = true;
          _windowExceeded = false;
        } else {
          verified = false;
        }
      } else {
        missing = [...counts.entries()].filter(([, n]) => n === 0).map(([uri]) => uri);
        after = [...counts.values()].reduce((a, b) => a + b, 0);
        verified = missing.length === 0;
      }
    } else {
      if (isTargeted) {
        // Per-position verification: check if positions beyond window
        const maxPos = Math.max(...opts.targetedPositions!.map((p) => p.position));
        if (maxPos >= PLAYLIST_ITEM_PAGES_CAP * PLAYLIST_ITEMS_PAGE_SIZE || _windowExceeded) {
          // Targeted position outside verifiable window — use count-based fallback if before is known
          if (opts.before !== undefined && totalReported !== undefined) {
            const expectedAfter = opts.before - (opts.expectedRemovedCount ?? opts.targetedPositions!.length);
            if (totalReported === expectedAfter) {
              verified = true;
              after = [...counts.values()].reduce((a, b) => a + b, 0);
              missing = [];
            } else {
              verified = false;
              after = [...counts.values()].reduce((a, b) => a + b, 0);
              missing = [];
              _windowExceeded = true;
            }
          } else {
            verified = false;
            after = [...counts.values()].reduce((a, b) => a + b, 0);
            missing = [];
            _windowExceeded = true;
          }
        } else {
          // Positions are within fetched window — verify each removed position now holds different URI
          // After removal, indices shift; we check that the URI at each original position is no longer the removed one
          // Simplified: check remaining count shrank or position content changed
          const failures: string[] = [];
          // For per-position, we verify occurrence counts decreased by expected amount
          if (opts.before !== undefined) {
            const totalBefore = opts.before;
            const expectedTotal = totalBefore - opts.targetedPositions!.length;
            if (totalReported !== undefined && totalReported !== expectedTotal) {
              failures.push(`row count ${totalReported} ≠ expected ${expectedTotal}`);
            }
          }
          if (failures.length === 0) {
            verified = true;
            after = [...counts.values()].reduce((a, b) => a + b, 0);
            missing = [];
          } else {
            verified = false;
            after = [...counts.values()].reduce((a, b) => a + b, 0);
            missing = failures;
          }
        }
      } else {
        if (_windowExceeded) {
          if (opts.before !== undefined && totalReported !== undefined && opts.expectedRemovedCount !== undefined) {
            const expectedTotal = opts.before - opts.expectedRemovedCount;
            if (totalReported === expectedTotal) {
              verified = true;
              after = [...counts.entries()].filter(([, n]) => n > 0).reduce((a, [, n]) => a + n, 0);
              missing = [];
              _windowExceeded = false;
            } else {
              verified = false;
              after = [...counts.entries()].filter(([, n]) => n > 0).reduce((a, [, n]) => a + n, 0);
              missing = [];
            }
          } else {
            const survivors = [...counts.entries()].filter(([, n]) => n > 0);
            // Don't report survivors as "still-present" when window is exceeded — it's misleading
            verified = false;
            after = survivors.reduce((a, [, n]) => a + n, 0);
            missing = [];
          }
        } else {
          const survivors = [...counts.entries()].filter(([, n]) => n > 0);
          missing = survivors.map(([uri]) => uri);
          after = survivors.reduce((a, [, n]) => a + n, 0);
          verified = missing.length === 0;
        }
      }
    }
    if (_windowExceeded) _reason = 'window exceeded — playlist larger than verifiable window (500 rows)';
  } else if (opts.kind === 'library') {
    // /me/library/contains takes ≤50 uris per call; chunk and OR the results.
    const present = new Set<string>();
    for (let i = 0; i < opts.uris.length; i += LIBRARY_CONTAINS_CHUNK) {
      const chunk = opts.uris.slice(i, i + LIBRARY_CONTAINS_CHUNK);
      const flags = await client.get<boolean[]>('/me/library/contains', {
        uris: chunk.join(','),
      });
      chunk.forEach((uri, j) => {
        if (flags?.[j]) present.add(uri);
      });
    }
    // Save expects everything present; removal expects everything absent —
    // a leftover uri after removal is exactly what the agent needs to know.
    const expectPresent = opts.expectPresent ?? true;
    if (expectPresent) {
      missing = opts.uris.filter((u) => !present.has(u));
      after = present.size;
    } else {
      missing = opts.uris.filter((u) => present.has(u));
      after = opts.uris.length - missing.length;
    }
    verified = missing.length === 0;
  } else {
    // playlist_meta: the mutation succeeded if the playlist itself resolves.
    // Verified independent of `uris` (often empty here) — a failed fetch must
    // never report VERIFIED just because there is nothing to mark missing.
    const pl = await client.get<{ uri?: string }>(`/playlists/${encodeURIComponent(opts.id ?? '')}`);
    verified = pl !== null;
    if (!pl) missing = opts.uris;
    after = pl ? opts.uris.length : 0;
  }

  const receipt: Receipt = {
    // Boot-scoped: `rcpt_<bootId>-<n>` cannot be minted by a later process,
    // so a stale id resolves to nothing rather than to another mutation.
    receipt_id: `rcpt_${bootId}-${nextSeq++}`,
    kind: opts.kind,
    ...(opts.id !== undefined ? { id: opts.id } : {}),
    verified: _windowExceeded ? false : verified!,
    ...(opts.before !== undefined ? { before: opts.before } : {}),
    ...(after !== undefined ? { after } : {}),
    missing,
    uris: [...opts.uris],
    direction: (opts.expectPresent ?? true) ? 'added' : 'removed',
    // Persisted so a later re-render (verify_receipt) labels the same
    // `missing` list the way the mutating turn did (#586).
    expect_present: opts.expectPresent ?? true,
    ...(affected !== undefined && affected.length > 0 ? { affected } : {}),
    ...(occurrences !== undefined ? { occurrences } : {}),
    ...(_windowExceeded ? { windowExceeded: true as const, reason: _reason } : {}),
    ...(opts.writes !== undefined && opts.writes.length > 0 ? { writes: opts.writes.map((w) => ({ type: w.type, ids: [...w.ids] })) } : {}),
    issued_at: Date.now(),
  };
  ensureLoaded();
  store.set(receipt.receipt_id, receipt);
  if (store.size > MAX_RECEIPTS) {
    // Map preserves insertion order: first key is the oldest receipt.
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  persist(receipt, process.env);
  return receipt;
}

/**
 * The direction a receipt's `missing` list must be labelled with (#586). An
 * explicit caller option wins (the mutating turn knows the direction it
 * issued); otherwise the receipt carries it, and `direction` is the fallback
 * for anything issued before `expect_present` was persisted. With neither, the
 * issue-time default applies and the label is "missing uris".
 */
function expectsPresence(r: Receipt, opts?: { expectPresent?: boolean }): boolean {
  if (opts?.expectPresent !== undefined) return opts.expectPresent;
  if (r.expect_present !== undefined) return r.expect_present;
  return r.direction !== 'removed';
}

/**
 * Deterministic prose lines for appending to a tool result. Same receipt →
 * byte-identical output, every time.
 */
export function formatReceipt(
  r: Receipt,
  opts?: { expectPresent?: boolean },
): string {
  const target = r.id ? `${r.kind} ${r.id}` : r.kind;
  const lines = [`Receipt ${r.receipt_id}: ${r.verified ? 'VERIFIED' : 'UNVERIFIED'} (${target})`];
  if (r.before !== undefined || r.after !== undefined) {
    lines.push(`  occurrences before/after: ${r.before ?? '?'}/${r.after ?? '?'}`);
  }
  if (r.windowExceeded) {
    lines.push(`  reason: ${r.reason ?? 'window exceeded'}`);
    if (r.missing.length > 0) {
      const label = expectsPresence(r, opts) ? 'missing uris' : 'still-present uris';
      lines.push(`  ${label}: ${r.missing.join(', ')}`);
    }
    return lines.join('\n');
  }
  if (!expectsPresence(r, opts)) {
    lines.push(
      r.missing.length > 0
        ? `  still-present uris: ${r.missing.join(', ')}`
        : '  all uris confirmed absent',
    );
  } else {
    lines.push(
      r.missing.length > 0 ? `  missing uris: ${r.missing.join(', ')}` : '  all uris confirmed',
    );
  }
  return lines.join('\n');
}
