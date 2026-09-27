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
  constants,
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
import { accountFileName, accountFileNames, accountStoreKey } from './accountkey.js';
import { getTokenFilePath } from './auth.js';
import { ownStoreRoots, resolveInputPathSync } from './paths.js';
import type { PlaylistItemsResponse } from './types/spotify.js';

/** Minimal client surface needed here — satisfied by SpotifyClient and test stubs. */
export interface ReceiptClient {
  get<T>(path: string, params?: Record<string, string>): Promise<T | null>;
  /**
   * The acting account's token file, which is what the store is keyed by.
   *
   * Optional so the test doubles that predate account switching keep
   * compiling; when it is absent the receipt is filed under the DEFAULT
   * account, which is the same store an unidentified client would have used
   * before. The real `SpotifyClient` always sets it — a `string` field
   * assigned in its constructor and re-pointed by `switchAccount` — so this
   * fallback is reachable only by a stub that never said which account it is.
   */
  tokenFile?: string;
}

type ReceiptKind = 'playlist_items' | 'library' | 'playlist_meta';


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
  /**
   * Playlist size after the mutation (#729): the `total` returned by
   * `/playlists/{id}/items`, not the count of matched rows inside the walk
   * window. On a playlist larger than `PLAYLIST_ITEM_PAGES_CAP *
   * PLAYLIST_ITEMS_PAGE_SIZE`, freshly appended rows sit past the walk and an
   * occurrence-based count reads 0 — `total` is the same regardless of how
   * many pages we walked, so it stays correct in both the seen-whole and
   * window-exceeded branches.
   */
  after?: number;
  /** Uris not found by the verification refetch (empty when verified). */
  missing: string[];
  /** URIs that were part of the original mutation (for undo). */
  uris: string[];
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
   * Why verification failed, when the failure is NOT a set of uris (#879).
   *
   * A row-count or row-order check fails on the playlist's SHAPE, not on a uri
   * the walk failed to find, and putting that in `missing` would make a field
   * documented as "uris not found" carry a sentence. Kept separate so the two
   * kinds of failure stay distinguishable to a reader and to `undo_mutation`,
   * which treats `missing` as data. Undefined when the check passed or did not
   * apply.
   */
  unmet?: string;
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
   * Row count the playlist must hold once this write lands (#879).
   *
   * Set only by a REPLACE. Presence is the whole contract for an append — a
   * no-op leaves rows the new uris were never in — but not for a replace: a
   * PUT that no-ops leaves the playlist on its OLD rows, and those may well
   * contain the same uris, so a presence-only receipt certifies a dropped
   * replace as verified. The count is what distinguishes the two.
   *
   * A mismatch fails the receipt and is reported in `unmet` as
   * `row count N ≠ expected M`. It is kept out of `missing`, which is
   * documented as the uris the walk did not find and is consumed as data by
   * `undo_mutation`. When the response carries no `total` the check is SKIPPED
   * rather than guessed at, and the uri walk stands alone.
   */
  expectedTotalAfter?: number;
  /**
   * The exact ordered uris this write placed at the START of the playlist
   * (#879).
   *
   * Row count catches a dropped replace, but not a dropped REORDER: reversing
   * a list preserves both the multiset and the count, so a PUT that no-ops
   * leaves a playlist that passes every count-and-presence check while holding
   * the original order. The prefix comparison catches that.
   *
   * Only the caller knows the post-state, and only for a write that starts at
   * position 0 — the first chunk of a replace. A later chunk appends past rows
   * this receipt cannot name, so it passes nothing and the check is skipped.
   * Skipped too when the walk saw fewer rows than the caller wrote; the
   * comparison never pads a short walk into a pass.
   */
  expectedOrder?: string[];
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

/**
 * One account's live receipt state: the undo window, the load flag, and the
 * append counter compaction needs. Keyed by {@link accountStoreKey} because
 * the receipts themselves are an undo CAPABILITY, not a log — a receipt minted
 * under one account must not be redeemable against another's library, so the
 * live store is partitioned exactly as the on-disk trail is (#1364).
 *
 * The file path is not a sufficient partition on its own: persistence is
 * opt-in, so in the default configuration this `Map` is the only store there
 * is, and an unpartitioned one hands any account on the process every
 * receipt every other account issued.
 */
interface AccountReceipts {
  store: Map<string, Receipt>;
  loaded: boolean;
  onDiskLines: number;
}

const accounts = new Map<string, AccountReceipts>();

/** The live state for one account, created on first touch. */
function stateFor(key: string): AccountReceipts {
  let state = accounts.get(key);
  if (state === undefined) {
    state = { store: new Map(), loaded: false, onDiskLines: 0 };
    accounts.set(key, state);
  }
  return state;
}

/**
 * Ids must be unique across PROCESSES, not just within one: a host that
 * respawns the server hands the agent ids from the previous session, and a
 * bare `rcpt_1` counter would resolve those to a DIFFERENT, later mutation
 * (#587). The boot id (process start time + random suffix) makes that
 * collision impossible in both directions. Ids stay unique across accounts
 * too, since the counter is process-wide — uniqueness is not the property at
 * issue in #1364, which is that an id was resolving at all under the wrong
 * account.
 */
const bootId = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
let nextSeq = 1;

/** True when receipts are persisted to disk (SPOTIFY_MCP_RECEIPTS). */
export function isReceiptsPersistent(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthyEnv(env.SPOTIFY_MCP_RECEIPTS);
}

/**
 * Receipt JSONL path for one account.
 *
 * The default account keeps the bare `receipts.jsonl`, so an install that has
 * been running this server reads and writes the file it already has (#1364).
 * A named profile gets `receipts.<profile>.jsonl` and starts empty — see
 * `src/accountkey.ts` for why the key is the token file and not `account_id`.
 */
export function receiptsFilePath(
  env: NodeJS.ProcessEnv = process.env,
  tokenFile = '',
): string {
  return join(receiptsDir(env), accountFileName(RECEIPT_FILE, tokenFile));
}

function receiptsDir(env: NodeJS.ProcessEnv): string {
  return (
    env.SPOTIFY_MCP_RECEIPTS_DIR ??
    env.SPOTIFY_MCP_HISTORY_DIR ??
    join(homedir(), '.spotify-mcp')
  );
}

/**
 * Every account's receipt trail in this store directory.
 *
 * `receiptsFilePath` is the single-file answer, correct on a machine with one
 * account and a partial answer on a machine with profiles: the other trails
 * exist and would be orphaned. `spotify_logout_stores` erases from this list
 * for that reason, the same way it does for the persisted read cache.
 */
export function receiptsFilePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  return accountFileNames(dirname(getTokenFilePath(env)), RECEIPT_FILE).map((name) =>
    join(receiptsDir(env), name),
  );
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
  tokenFile = '',
): string {
  const scope = isReceiptsPersistent(env)
    ? `persisted in ${receiptsFilePath(env, tokenFile)}`
    : 'session-scoped — receipts are not persisted to disk, so an id from an earlier session is gone';
  return `Unknown or expired receipt "${receiptId}" — receipts are ${scope}; only the ${MAX_RECEIPTS} most recent mutations are kept, ${receiptRetentionLabel(env)}.`;
}

/** Tail of a text file, bounded by maxBytes, skipping a partial leading line. */
function readTailText(file: string, maxBytes: number): string | null {
  // #623: the tail window already bounds how much is buffered, so the cap is
  // satisfied by construction — but the file is still validated first. A FIFO
  // where the receipt log belongs would block in openSync indefinitely, and
  // a symlink out of the receipts directory would read something else, so
  // both are refused by the same guard every other local read uses. The
  // ceiling passed here is the tail window, not the document cap: this read
  // never materialises more than maxBytes.
  const input = resolveInputPathSync({
    roots: ownStoreRoots(file),
    tool: 'receipts',
    target: file,
    maxBytes,
  });
  const { size } = statSync(input.path);
  const start = size > maxBytes ? size - maxBytes : 0;
  const fd = openSync(input.path, constants.O_RDONLY | constants.O_NOFOLLOW);
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
function pruneExpired(state: AccountReceipts, now: number, ttl: number): void {
  if (!Number.isFinite(ttl)) return;
  for (const [id, r] of state.store) {
    if (typeof r.issued_at === 'number' && now - r.issued_at > ttl) state.store.delete(id);
  }
}

/** Rehydrate one account's store: newest MAX_RECEIPTS, in issue order. */
function loadFromDisk(state: AccountReceipts, env: NodeJS.ProcessEnv, tokenFile: string): void {
  const text = readTailText(receiptsFilePath(env, tokenFile), MAX_RECEIPT_FILE_BYTES);
  if (text === null) return;
  const parsed = text
    .split('\n')
    .map(parseReceiptLine)
    .filter((r): r is Receipt => r !== null);
  for (const r of parsed.slice(-MAX_RECEIPTS)) state.store.set(r.receipt_id, r);
  state.onDiskLines = parsed.length;
  pruneExpired(state, Date.now(), receiptTtlMs(env));
}

/** First use of an account in a process hydrates it; every later call is a no-op. */
function ensureLoaded(env: NodeJS.ProcessEnv, tokenFile: string): AccountReceipts {
  const state = stateFor(accountStoreKey(tokenFile));
  if (state.loaded) return state;
  state.loaded = true;
  if (!isReceiptsPersistent(env)) return state;
  try {
    loadFromDisk(state, env, tokenFile);
  } catch {
    // An unreadable or corrupt trail must not break verify/undo: the store
    // starts empty and the next append rebuilds it.
  }
  return state;
}

/** Rewrite one account's trail with only its live receipts, in FIFO eviction order. */
function compactTrail(state: AccountReceipts, file: string): void {
  const retained = [...state.store.values()].slice(-MAX_RECEIPTS);
  const body = retained.map((r) => JSON.stringify(r)).join('\n');
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body.length > 0 ? body + '\n' : '', { encoding: 'utf8', mode: RECEIPT_FILE_MODE });
  renameSync(tmp, file);
  state.onDiskLines = retained.length;
}

/** Append one receipt. Never throws: a full or read-only disk must not fail a mutation. */
function persist(receipt: Receipt, env: NodeJS.ProcessEnv, tokenFile: string): void {
  if (!isReceiptsPersistent(env)) return;
  const file = receiptsFilePath(env, tokenFile);
  const state = stateFor(accountStoreKey(tokenFile));
  try {
    const dir = dirname(file);
    mkdirSync(dir, { recursive: true, mode: RECEIPT_DIR_MODE });
    chmodSync(dir, RECEIPT_DIR_MODE);
    appendFileSync(file, JSON.stringify(receipt) + '\n', { encoding: 'utf8', mode: RECEIPT_FILE_MODE });
    // A creation-time mode alone leaves a pre-existing or copied file
    // readable by others; re-assert owner-only on every write, as the
    // history ledger does.
    chmodSync(file, RECEIPT_FILE_MODE);
    state.onDiskLines += 1;
    if (state.onDiskLines > MAX_RECEIPT_LINES) compactTrail(state, file);
  } catch {
    /* best-effort: the in-memory receipt still answers this session's lookups */
  }
}

/**
 * Test-only: drop every in-memory trace of receipts so the next access
 * re-reads the trail — the state a freshly spawned process is in.
 */
export function __resetReceiptStoreForTests(): void {
  accounts.clear();
  nextSeq = 1;
}

/**
 * The id shape `issueReceipt` mints: `rcpt_<bootId>-<n>` since #587, and the
 * bare `rcpt_<n>` counter a pre-#587 `receipts.jsonl` can still hold. Both are
 * accepted; anything else is a typo or a fabricated id.
 *
 * A receipt id only ever comes from a mutation result, so an agent that
 * mistypes one is losing a lookup, not asking a question. Rejecting the
 * malformed shape at the schema is what turns "Unknown or expired receipt
 * 'recpt_4'" — which reads as a fact about the receipt — into a validation
 * error naming the expected shape, which reads as a fact about the call.
 */
export const RECEIPT_ID_PATTERN = /^rcpt_(?:[0-9a-z]+-)?\d+$/i;

/** Human form of {@link RECEIPT_ID_PATTERN}, quoted back in the failure message. */
export const RECEIPT_ID_SHAPE = 'rcpt_<bootId>-<n>';

/** True when `id` could be a receipt id at all — cheap, shape-only, no store read. */
export function isPlausibleReceiptId(id: string): boolean {
  return RECEIPT_ID_PATTERN.test(id);
}

/**
 * Stored receipt lookup for the acting account.
 *
 * `tokenFile` is required for the store to be the right one: it is the account
 * the lookup is being made *as*. A receipt id is an undo capability, and an
 * unbound one is an authority transfer, so an id minted under another account
 * resolves to `undefined` rather than to that account's contents (#1364).
 */
export function verifyReceipt(receiptId: string, tokenFile = ''): Receipt | undefined {
  const state = ensureLoaded(process.env, tokenFile);
  pruneExpired(state, Date.now(), receiptTtlMs());
  return state.store.get(receiptId);
}
/** The acting account's receipts in insertion order (for undo). */
export function getAllReceipts(tokenFile = ''): Receipt[] {
  const state = ensureLoaded(process.env, tokenFile);
  pruneExpired(state, Date.now(), receiptTtlMs());
  return [...state.store.values()];
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
  let unmet: string | undefined;
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
    // #729: the receipt's `after` is the playlist's actual item count after the
    // mutation, not a count of matched rows inside the walk window. When the
    // walk window is smaller than the playlist, fresh appends sit past it and
    // any occurrence-based count prints 0 — exactly the bug the receipt was
    // supposed to expose. `totalReported` is the playlist total from the last
    // fetched /items page; Spotify returns it regardless of how many pages we
    // walked, so it is correct in both the seen-whole and window-exceeded
    // branches. When the API response is malformed and `total` is missing,
    // fall back to the matched-row sum so older receipts stay informative.
    if (totalReported !== undefined) {
      after = totalReported;
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
        if (missing.length === 0) {
          verified = true;
          _windowExceeded = false;
        } else {
          verified = false;
        }
      } else {
        missing = [...counts.entries()].filter(([, n]) => n === 0).map(([uri]) => uri);
        verified = missing.length === 0;
        // A replace also has a row-count contract (#879). `expectedTotalAfter`
        // is set by the caller that knows the intended post-state; without it
        // this is a plain append and presence is the whole story.
        if (verified && opts.expectedTotalAfter !== undefined) {
          if (totalReported !== undefined && totalReported !== opts.expectedTotalAfter) {
            verified = false;
            unmet = `row count ${totalReported} ≠ expected ${opts.expectedTotalAfter}`;
          }
        }
      }
      if (verified && opts.expectedOrder !== undefined) {
        const want = opts.expectedOrder;
        if (want.length > orderedUris.length) {
          // The walk saw fewer rows than the caller wrote. Say so rather than
          // comparing a partial list, which would read as a match.
          verified = false;
          unmet = `walk saw ${orderedUris.length} row(s), expected at least ${want.length}`;
        } else {
          const at = want.findIndex((uri, i) => orderedUris[i] !== uri);
          if (at !== -1) {
            verified = false;
            unmet = `row ${at} is ${orderedUris[at] ?? '(none)'}, expected ${want[at]}`;
          }
        }
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
              missing = [];
            } else {
              verified = false;
              missing = [];
              _windowExceeded = true;
            }
          } else {
            verified = false;
            missing = [];
            _windowExceeded = true;
          }
        } else {
          // Positions are within the fetched window. A positional removal is
          // verified by a row-count comparison: the playlist should hold
          // exactly `before - removed` rows once the targeted rows are gone.
          // #626: a comparison needs BOTH numbers, and this branch used to set
          // `verified = true` whenever its check array came out empty — which
          // it did when `before` was absent (no check ran at all) and when the
          // re-read reported no total (the check was skipped). An unrun check
          // is not a passing one: a receipt that says VERIFIED while comparing
          // nothing is a field named for evidence that does not exist, the
          // shape of #803. Fail closed, and name which half was missing.
          //
          // The reason goes in `unmet`, not `missing`: this is a check about
          // row counts, not a set of uris (#879). `missing` is consumed as
          // data — `writeVerdict` counts its entries as unconfirmed rows and
          // `undo` renders them as a uri list — so a sentence filed there
          // would be read back as one missing track.
          if (opts.before === undefined) {
            verified = false;
            missing = [];
            unmet = 'no baseline for position verification — the caller captured no pre-mutation row count, so there is nothing to compare the re-read against';
          } else if (totalReported === undefined) {
            verified = false;
            missing = [];
            unmet = 'position-total check could not run — the re-read reported no row total to compare against the pre-mutation count';
          } else {
            const expectedTotal = opts.before - opts.targetedPositions!.length;
            verified = totalReported === expectedTotal;
            missing = [];
            if (!verified) unmet = `row count ${totalReported} ≠ expected ${expectedTotal}`;
          }
        }
      } else {
        if (_windowExceeded) {
          if (opts.before !== undefined && totalReported !== undefined && opts.expectedRemovedCount !== undefined) {
            const expectedTotal = opts.before - opts.expectedRemovedCount;
            if (totalReported === expectedTotal) {
              verified = true;
              missing = [];
              _windowExceeded = false;
            } else {
              verified = false;
              missing = [];
            }
          } else {
            // Don't report survivors as "still-present" when window is exceeded — it's misleading
            verified = false;
            missing = [];
          }
        } else {
          // #1252: an empty survivor list is not evidence that anything was
          // removed — only evidence that nothing was COUNTED. Those are
          // different facts and this branch used to conflate them.
          //
          // `sawWholeList` is the walk's own statement that it really did see
          // every row. A `204`, an empty body or a non-JSON payload (all of
          // which `client.get` answers as `null`) breaks the walk before it is
          // set, leaving every count at 0; so does a playlist longer than the
          // 500-row window whose response carried no `total` to detect the
          // window with. Either way `counts` is empty, `survivors` is empty,
          // and the old `verified = missing.length === 0` reported a removal
          // nothing had checked.
          //
          // The rows that could still hold a claimed uri may sit past the page
          // that failed, so the absence claim needs the whole list. It does not
          // get it, so withhold it. This is the shape of #803 — a correctly
          // named field whose value is a fiction — with the fiction in a count.
          //
          // The reason goes in `unmet`, not `missing` (#879): nothing was
          // observed to still be present, so the uri list stays empty, and
          // `missing` is consumed as data by `writeVerdict` and `undo`.
          if (!sawWholeList) {
            verified = false;
            missing = [];
            unmet = 'absence check could not run — the re-read did not return the whole playlist, so no row was observed and "nothing survived" is not evidence that anything was removed';
          } else {
            const survivors = [...counts.entries()].filter(([, n]) => n > 0);
            missing = survivors.map(([uri]) => uri);
            verified = missing.length === 0;
          }
        }
      }
    }
    if (_windowExceeded) _reason = 'window exceeded — playlist larger than verifiable window (500 rows)';
  } else if (opts.kind === 'library') {
    // /me/library/contains takes ≤50 uris per call; chunk and OR the results.
    //
    // #1252: a chunk that did not answer is a chunk that was NOT observed.
    // `client.get` answers `null` for a 204, an empty body and a non-JSON
    // payload, and a short or non-array body is equally unusable — every one
    // of those leaves that chunk's uris looking absent. For a removal that is
    // indistinguishable from "they are gone" and the receipt reported
    // VERIFIED on a read that never happened; for a save it is
    // indistinguishable from "they were never saved" and the receipt reported
    // every uri as missing, which `undo_mutation` and the library tool
    // payloads read as data. `observed` records which chunks really answered,
    // so neither `missing` nor `after` is ever built out of one that did not.
    const present = new Set<string>();
    const observed = new Set<string>();
    for (let i = 0; i < opts.uris.length; i += LIBRARY_CONTAINS_CHUNK) {
      const chunk = opts.uris.slice(i, i + LIBRARY_CONTAINS_CHUNK);
      const flags = await client.get<boolean[]>('/me/library/contains', {
        uris: chunk.join(','),
      });
      if (!Array.isArray(flags) || flags.length < chunk.length) continue;
      for (const uri of chunk) observed.add(uri);
      chunk.forEach((uri, j) => {
        if (flags[j]) present.add(uri);
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
    const unread = opts.uris.filter((u) => !observed.has(u));
    if (unread.length > 0) {
      // A uri no chunk answered for was neither observed present nor observed
      // absent, so it is neither missing nor confirmed: drop it from `missing`
      // rather than file a guess there, and leave `after` unset instead of
      // counting a read that never happened. The reason goes in `unmet`
      // (#879) — `reason` is gated on `windowExceeded` and is only spread into
      // the receipt when that flag is set, so a value written there would be
      // dropped from both the persisted receipt and the prose.
      missing = missing.filter((u) => observed.has(u));
      after = undefined;
      verified = false;
      unmet = `presence check could not run for ${unread.length} of ${opts.uris.length} uri(s) — /me/library/contains returned no usable answer, so "not present" means unread, not ${expectPresent ? 'absent' : 'present'}`;
    } else {
      verified = missing.length === 0;
    }
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
    ...(unmet !== undefined ? { unmet } : {}),
    uris: [...opts.uris],
    direction: (opts.expectPresent ?? true) ? 'added' : 'removed',
    // Persisted so a later re-render (verify_receipt) labels the same
    // `missing` list the way the mutating turn did (#586).
    expect_present: opts.expectPresent ?? true,
    ...(affected !== undefined && affected.length > 0 ? { affected } : {}),
    ...(occurrences !== undefined ? { occurrences } : {}),
    ...(_windowExceeded ? { windowExceeded: true as const, reason: _reason } : {}),
    issued_at: Date.now(),
  };
  const tokenFile = client.tokenFile ?? '';
  const state = ensureLoaded(process.env, tokenFile);
  state.store.set(receipt.receipt_id, receipt);
  if (state.store.size > MAX_RECEIPTS) {
    // Map preserves insertion order: first key is the oldest receipt.
    const oldest = state.store.keys().next().value;
    if (oldest !== undefined) state.store.delete(oldest);
  }
  persist(receipt, process.env, tokenFile);
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
    lines.push(`  items before/after: ${r.before ?? '?'}/${r.after ?? '?'}`);
  }
  if (r.unmet !== undefined) {
    lines.push(`  unmet: ${r.unmet}`);
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
    if (r.missing.length > 0) lines.push(`  still-present uris: ${r.missing.join(', ')}`);
    // #1252: the confirmation line is earned by the verdict, not by an empty
    // list. An UNVERIFIED receipt whose failure is not a set of uris (a read
    // that came back unreadable, a check that could not run) has an empty
    // `missing` by construction, and printing "all uris confirmed absent"
    // beside it stated the opposite of what the receipt just said.
    else if (r.verified) lines.push('  all uris confirmed absent');
  } else {
    if (r.missing.length > 0) lines.push(`  missing uris: ${r.missing.join(', ')}`);
    else if (r.verified) lines.push('  all uris confirmed');
  }
  return lines.join('\n');
}
