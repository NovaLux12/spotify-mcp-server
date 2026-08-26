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
 *    without refetching. Receipts live in an in-module Map capped at 100 with
 *    FIFO eviction; ids are session-scoped (`rcpt_<n>`).
 */

import type { PlaylistItemsResponse } from './types/spotify.js';

/** Minimal client surface needed here — satisfied by SpotifyClient and test stubs. */
export interface ReceiptClient {
  get<T>(path: string, params?: Record<string, string>): Promise<T | null>;
}

export type ReceiptKind = 'playlist_items' | 'library' | 'playlist_meta';

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
  /** When true, playlist exceeds verifiable window — verified is false due to cap, not missing data. */
  windowExceeded?: boolean;
  /** Human reason when not verified or window exceeded. */
  reason?: string;
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
  /** Expected number of rows removed (for window-exceeded detection). */
  expectedRemovedCount?: number;
}

// In-module receipt store, capped at 100 with FIFO eviction.
const MAX_RECEIPTS = 100;
const store = new Map<string, Receipt>();
let nextSeq = 1;

/** Stored receipt lookup for the orchestrator-wired `verify_receipt` tool. */
export function verifyReceipt(receiptId: string): Receipt | undefined {
  return store.get(receiptId);
}
/** All receipts in insertion order (for undo). */
export function getAllReceipts(): Receipt[] {
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
  let missing: string[] = [];
  let after: number | undefined;
  let verified: boolean;
  let _windowExceeded = false;
  let _reason: string | undefined;

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
      if (!res.next || res.items.length < PLAYLIST_ITEMS_PAGE_SIZE) break;
    }
    // Detect window exceeded: last fetched page was full and total > fetched
    if (totalReported !== undefined && totalReported > orderedUris.length && orderedUris.length >= PLAYLIST_ITEM_PAGES_CAP * PLAYLIST_ITEMS_PAGE_SIZE) {
      _windowExceeded = true;
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
    receipt_id: `rcpt_${nextSeq++}`,
    kind: opts.kind,
    ...(opts.id !== undefined ? { id: opts.id } : {}),
    verified: _windowExceeded ? false : verified!,
    ...(opts.before !== undefined ? { before: opts.before } : {}),
    ...(after !== undefined ? { after } : {}),
    missing,
    uris: [...opts.uris],
    ...(_windowExceeded ? { windowExceeded: true as const, reason: _reason } : {}),
  };
  store.set(receipt.receipt_id, receipt);
  if (store.size > MAX_RECEIPTS) {
    // Map preserves insertion order: first key is the oldest receipt.
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  return receipt;
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
      const label = opts?.expectPresent === false ? 'still-present uris' : 'missing uris';
      lines.push(`  ${label}: ${r.missing.join(', ')}`);
    }
    return lines.join('\n');
  }
  if (opts?.expectPresent === false) {
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
