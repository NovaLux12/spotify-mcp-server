/**
 * Shared receipt plumbing for the playlist write helpers (#879).
 *
 * `src/receipts.ts` owns the verification walk and the receipt contract; the
 * tool modules own the writes. These two helpers are the bridge, so every
 * playlist writer renders its receipts with the same wording and reports the
 * same verdict: an agent that learned to trust `add_to_playlist` reads a
 * sibling tool's result the same way.
 */

import { formatReceipt, type Receipt } from '../receipts.js';

export type { Receipt };

/**
 * One `formatReceipt` block per receipt, in issue order. Empty input yields an
 * empty string so a caller can append the result unconditionally.
 */
export function receiptsLines(receipts: readonly Receipt[]): string {
  return receipts.map((r) => formatReceipt(r)).join('\n');
}

/**
 * The same receipts as structuredContent records. A Receipt is plain JSON.
 *
 * #1343: this used to be `receipts as unknown as Array<Record<string, unknown>>`
 * — a widening at the payload boundary that told the compiler the receipts had
 * been checked when nothing had checked them. `Receipt` is an `interface`, so
 * it has no implicit index signature and is not assignable to the wire's
 * `Record<string, unknown>`; the cast papered over that. Spreading each
 * receipt into a fresh object produces a plain value the wire accepts on its
 * own terms, and it keeps the boundary a place a reader can look rather than a
 * step hidden behind an assertion.
 */
export function receiptRecords(receipts: readonly Receipt[]): Array<Record<string, unknown>> {
  return receipts.map((r) => ({ ...r }));
}

export interface WriteVerdict {
  /** False as soon as one receipt failed verification. */
  ok: boolean;
  /** Rows the write asked the API to land. */
  expected: number;
  /** Rows the re-read confirmed — present, for an add; absent, for a removal. */
  actual: number;
}

/**
 * What a committed playlist write actually landed (#879).
 *
 * `ok` is false the moment any receipt fails verification, so a write the API
 * accepted and then silently dropped can no longer be reported as a completed
 * change. `expected` is the row count the write asked for and `actual` the
 * count the re-read confirmed; both are derived from the receipts' own
 * `missing` lists rather than from the request the tool sent, so a read that
 * came back short shows up as a low `actual` instead of a confident one. A
 * write that issued no request at all has nothing to verify and is `ok`.
 */
export function writeVerdict(receipts: readonly Receipt[], expected: number): WriteVerdict {
  const unconfirmed = new Set(receipts.flatMap((r) => r.missing));
  return {
    ok: receipts.every((r) => r.verified),
    expected,
    actual: Math.max(0, expected - unconfirmed.size),
  };
}

/**
 * The verdict for a REPLACE, in rows rather than in uris (#879).
 *
 * A replace's `expected` is the row count the playlist must end up holding and
 * `actual` is the count the re-read reported (`after`, #729), because a
 * dropped PUT is invisible to a uri-presence check: it leaves the OLD rows
 * behind, which may well contain every uri the replace wrote. The receipts
 * already carry that check via `expectedTotalAfter`, so this only reads their
 * verdict off.
 *
 * A chunk whose response had no `total` yields no count to compare, and a
 * missing number is never turned into a passing one: the verdict falls back to
 * `writeVerdict`, which reports the uris it could confirm and stays unverified
 * if the walk could not confirm them.
 */
export function replaceVerdict(receipts: readonly Receipt[], expected: number): WriteVerdict {
  const base = writeVerdict(receipts, expected);
  if (receipts.length === 0) return base;
  const afters = receipts.map((r) => r.after);
  if (afters.some((a) => a === undefined)) return base;
  const actual = afters[afters.length - 1]!;
  return { ok: base.ok && actual === expected, expected, actual };
}
