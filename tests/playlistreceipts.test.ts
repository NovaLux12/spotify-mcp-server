/**
 * Tests for `src/tools/playlistreceipts.ts` (#657) — the shared receipt
 * plumbing every playlist writer renders its result through (#879).
 *
 * The module had no importing test, and it is the one place a playlist write's
 * pass/fail is decided, so the assertions below concentrate on the three ways
 * it can lie:
 *
 *   1. `ok` must go false the moment ANY receipt fails verification. A write
 *      whose second chunk was silently dropped cannot report success because
 *      the first chunk verified.
 *   2. `actual` is derived from the receipts' own `missing` lists, not from
 *      the request the tool sent. `every` is the wrong operator there — a
 *      duplicated missing URI across two receipts counts once, and a caller
 *      that reported `expected - 1` for a write that lost two rows understated
 *      the loss.
 *   3. `replaceVerdict` must fall back rather than guess. A chunk whose
 *      response carried no `total` yields no row count to compare, and a
 *      missing number is never turned into a passing one.
 *
 * Run: node --import tsx --test tests/playlistreceipts.test.ts
 */
// Hermetic home (#1274): point HOME at a temp root so a test run cannot
// write into the real ~/.spotify-mcp. This suite confines its own
// filesystem work under mkdtemp(os.tmpdir()) as well.
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  receiptRecords,
  receiptsLines,
  replaceVerdict,
  writeVerdict,
} from '../src/tools/playlistreceipts.ts';
import type { Receipt } from '../src/receipts.ts';

const uri = (n: number): string => `spotify:track:${n}`;

function receipt(over: Partial<Receipt> = {}): Receipt {
  return {
    receipt_id: 'r1',
    kind: 'playlist_items',
    id: 'mix1',
    verified: true,
    before: 10,
    after: 12,
    missing: [],
    uris: [],
    ...over,
  } as Receipt;
}

describe('#657 playlistreceipts: writeVerdict', () => {
  it('reports ok/expected/actual for a fully verified write', () => {
    assert.deepEqual(writeVerdict([receipt()], 2), { ok: true, expected: 2, actual: 2 });
  });

  it('goes ok:false as soon as ONE receipt is unverified', () => {
    // The multi-chunk case: 100-item chunks, so a 250-uri write produced three
    // receipts. An `every`-over-`-some` inversion here reports a partial write
    // as complete.
    const v = writeVerdict(
      [receipt(), receipt({ receipt_id: 'r2', verified: false }), receipt({ receipt_id: 'r3' })],
      3,
    );
    assert.equal(v.ok, false, 'a dropped chunk must not report success');
  });

  it('counts `actual` from the receipts’ own missing lists', () => {
    const v = writeVerdict(
      [receipt({ missing: [uri(1), uri(2)] })],
      4,
    );
    assert.equal(v.actual, 2, 'two of four uris the re-read could not find');
  });

  it('counts a duplicated missing URI once, not twice', () => {
    // Two receipts both naming the same absent uri means one row was lost, not
    // two. `flatMap(...).length` would report actual 2 for a 3-uri write that
    // lost one row.
    const v = writeVerdict(
      [receipt({ missing: [uri(1)] }), receipt({ receipt_id: 'r2', missing: [uri(1)] })],
      3,
    );
    assert.equal(v.actual, 2);
  });

  it('never reports a negative `actual` when the missing list exceeds `expected`', () => {
    // A walk that reported more uris missing than the write asked for is a
    // broken receipt, not a negative success count. The floor at zero keeps
    // the number readable.
    const v = writeVerdict([receipt({ missing: [uri(1), uri(2), uri(3)] })], 1);
    assert.equal(v.actual, 0);
    assert.ok(v.actual >= 0);
  });

  it('treats a write with no receipts as ok, because nothing was issued', () => {
    const v = writeVerdict([], 0);
    assert.deepEqual(v, { ok: true, expected: 0, actual: 0 });
  });

  it('passes `expected` through untouched', () => {
    assert.equal(writeVerdict([receipt()], 7).expected, 7);
  });
});

describe('#657 playlistreceipts: replaceVerdict', () => {
  it('compares the LAST chunk’s `after` against the expected row count', () => {
    // A replace must end up holding exactly the rows it wrote. A dropped PUT
    // is invisible to a uri-presence check — it leaves the OLD rows behind,
    // which may contain every uri the replace wrote — so only the row count
    // separates the two cases. The total is reported by the final chunk, so
    // that is the one that counts.
    const v = replaceVerdict(
      [receipt({ after: 5 }), receipt({ receipt_id: 'r2', after: 12 })],
      12,
    );
    assert.deepEqual(v, { ok: true, expected: 12, actual: 12 });
  });

  it('reports ok:false and the REAL row count when the replace was dropped', () => {
    const v = replaceVerdict(
      [receipt({ after: 5 }), receipt({ receipt_id: 'r2', after: 20, verified: false })],
      12,
    );
    assert.equal(v.ok, false, 'the playlist still holds 20 rows, not 12');
    assert.equal(v.actual, 20, '`actual` is what the re-read saw, not what was asked for');
  });

  it('does not let a later `after` mask an earlier chunk that never reported one', () => {
    // The first chunk's response had no `total`, so the row count is unknown
    // for the whole write.
    const v = replaceVerdict(
      [receipt({ after: undefined }), receipt({ receipt_id: 'r2', after: 12 })],
      12,
    );
    assert.equal(v.actual, 12, 'falls back to the uri-based count: 12 expected, none missing');
    assert.equal(v.ok, true, 'the uris were all confirmed, so the fallback verifies');
  });

  it('stays unverified when a chunk omitted `after` AND a uri is missing', () => {
    // The fallback must not manufacture a pass out of a partial read. This is
    // the case a naive `after ?? expected` would report as ok.
    const v = replaceVerdict(
      [receipt({ after: undefined, verified: false, missing: [uri(7)] })],
      12,
    );
    assert.equal(v.ok, false);
    assert.equal(v.actual, 11, 'one uri the walk could not confirm');
  });

  it('falls back to writeVerdict for an empty receipt list', () => {
    assert.deepEqual(replaceVerdict([], 0), { ok: true, expected: 0, actual: 0 });
  });

  it('keeps the base ok when the receipts verify but the row count disagrees', () => {
    const v = replaceVerdict([receipt({ after: 13 })], 12);
    assert.equal(v.ok, false, '13 rows is not the 12 that were written');
    assert.equal(v.actual, 13);
  });
});

describe('#657 playlistreceipts: receiptsLines', () => {
  it('renders one formatReceipt block per receipt, in issue order', () => {
    const out = receiptsLines([
      receipt({ receipt_id: 'r1', after: 12 }),
      receipt({ receipt_id: 'r2', verified: false, after: undefined }),
    ]);
    const blocks = out.split('\n').filter((l) => l.startsWith('Receipt '));
    assert.equal(blocks.length, 2, 'one header line per receipt');
    assert.match(blocks[0], /^Receipt r1: VERIFIED \(playlist_items mix1\)$/);
    assert.match(blocks[1], /^Receipt r2: UNVERIFIED \(playlist_items mix1\)$/);
    assert.ok(out.indexOf('Receipt r1:') < out.indexOf('Receipt r2:'), 'issue order is preserved');
  });

  it('renders an UNVERIFIED receipt with an empty `after` as "?", not "undefined"', () => {
    // `?` is the disclosed-unknown marker. The string "undefined" in a receipt
    // reads as a value the server measured.
    const out = receiptsLines([receipt({ verified: false, after: undefined, before: 10 })]);
    assert.match(out, /items before\/after: 10\/\?/);
    assert.doesNotMatch(out, /undefined/);
  });

  it('yields an empty string for no receipts, so a caller can append unconditionally', () => {
    assert.equal(receiptsLines([]), '');
  });
});

describe('#657 playlistreceipts: receiptRecords', () => {
  it('exposes the receipts as plain JSON records', () => {
    // structuredContent crosses a JSON-RPC boundary, so the projection has to
    // survive a round trip with the fields intact.
    const input = [receipt({ receipt_id: 'r1' }), receipt({ receipt_id: 'r2', missing: [uri(1)] })];
    const records = receiptRecords(input);
    assert.equal(records.length, 2);
    assert.equal(records[0].receipt_id, 'r1');
    assert.deepEqual(records[1].missing, [uri(1)]);
    assert.deepEqual(JSON.parse(JSON.stringify(records)), records, 'must be JSON-serialisable');
  });

  it('yields an empty array for no receipts', () => {
    assert.deepEqual(receiptRecords([]), []);
  });
});
