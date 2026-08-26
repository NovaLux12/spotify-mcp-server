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
}

// In-module receipt store, capped at 100 with FIFO eviction.
const MAX_RECEIPTS = 100;
const store = new Map<string, Receipt>();
let nextSeq = 1;

/** Stored receipt lookup for the orchestrator-wired `verify_receipt` tool. */
export function verifyReceipt(receiptId: string): Receipt | undefined {
  return store.get(receiptId);
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

  if (opts.kind === 'playlist_items') {
    // Walk /playlists/{id}/items in 100-row pages, at most 5 pages, counting
    // occurrences of each uri across all fetched rows.
    const counts = new Map<string, number>(opts.uris.map((u) => [u, 0]));
    for (let page = 0; page < PLAYLIST_ITEM_PAGES_CAP; page++) {
      const res = await client.get<PlaylistItemsResponse>(
        `/playlists/${encodeURIComponent(opts.id ?? '')}/items`,
        { limit: String(PLAYLIST_ITEMS_PAGE_SIZE), offset: String(page * PLAYLIST_ITEMS_PAGE_SIZE) },
      );
      if (!res || !Array.isArray(res.items)) break;
      for (const row of res.items) {
        const uri = row?.item?.uri;
        if (uri && counts.has(uri)) counts.set(uri, (counts.get(uri) ?? 0) + 1);
      }
      if (!res.next || res.items.length < PLAYLIST_ITEMS_PAGE_SIZE) break;
    }
    // Add expects every uri present after the write; removal expects every
    // uri gone — a leftover uri after removal is exactly what the agent
    // needs to know about (#133-era receipts follow the same convention as
    // the library kind).
    const expectPresent = opts.expectPresent ?? true;
    if (expectPresent) {
      missing = [...counts.entries()].filter(([, n]) => n === 0).map(([uri]) => uri);
      after = [...counts.values()].reduce((a, b) => a + b, 0);
      verified = missing.length === 0;
    } else {
      // Absence direction: ANY surviving occurrence means the removal is
      // incomplete; `after` reads as remaining occurrences across the
      // receipt's uris.
      const survivors = [...counts.entries()].filter(([, n]) => n > 0);
      missing = survivors.map(([uri]) => uri);
      after = survivors.reduce((a, [, n]) => a + n, 0);
      verified = missing.length === 0;
    }
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
    verified,
    ...(opts.before !== undefined ? { before: opts.before } : {}),
    ...(after !== undefined ? { after } : {}),
    missing,
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
  if (opts?.expectPresent === false) {
    // Removal direction: "missing" lists uris STILL PRESENT after the write.
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
