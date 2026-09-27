/**
 * Tests for `src/tools/rewritable.ts` (#657) — the unavailable-row guard every
 * full-sequence playlist rewrite commits behind (#860).
 *
 * The module had no importing test. What is easy to get wrong here, and what
 * the assertions below pin:
 *
 *   1. Positions are 1-BASED. The API pages a playlist that way, and a caller
 *      reading "position 0" cannot act on it. An off-by-one guard would name
 *      the wrong row on the one playlist a user has a single unavailable track
 *      on.
 *   2. The count and the quoted list are SEPARATE. The notice caps how many
 *      positions it spells out, but the count it reports must still be the
 *      true total — capping the count turns a refusal that names five affected
 *      rows into one that says there is one.
 *   3. `truncated` has to read as a lower bound. The walk stopped at the
 *      fetch-all cap, so rows past it went unread; a notice that states the
 *      count without that clause states it as complete when it is not.
 *
 * Run: node --import tsx --test tests/rewritable.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPlaylistRewritable,
  unavailableRowNotice,
  unavailableRowPositions,
} from '../src/tools/rewritable.ts';
import type { PlaylistItemObject } from '../src/types/spotify.ts';

const playable = (n: number): PlaylistItemObject =>
  ({ added_at: '2026-01-01T00:00:00Z', item: { uri: `spotify:track:${n}` } }) as PlaylistItemObject;
const unavailable = (): PlaylistItemObject =>
  ({ added_at: '2026-01-01T00:00:00Z', item: null }) as PlaylistItemObject;

describe('#657 rewritable: unavailableRowPositions', () => {
  it('returns an empty list when every row is addressable by URI', () => {
    // The precondition for "no refusal": a playlist with nothing lost is the
    // common case and must not block any rewrite.
    assert.deepEqual(unavailableRowPositions([playable(1), playable(2), playable(3)]), []);
  });

  it('reports 1-BASED positions in playlist order', () => {
    assert.deepEqual(
      unavailableRowPositions([unavailable(), playable(1), unavailable()]),
      [1, 3],
      'the first row is position 1, not 0',
    );
    assert.deepEqual(
      unavailableRowPositions([playable(1), unavailable()]),
      [2],
      'a single trailing loss is position 2, not 1',
    );
  });

  it('reports every position when the whole playlist is unavailable', () => {
    assert.deepEqual(unavailableRowPositions([unavailable(), unavailable()]), [1, 2]);
  });

  it('treats an empty playlist as nothing to refuse', () => {
    assert.deepEqual(unavailableRowPositions([]), []);
  });
});

describe('#657 rewritable: unavailableRowNotice', () => {
  it('returns null when nothing is unavailable', () => {
    assert.equal(unavailableRowNotice('Mix', []), null, 'an empty list is the "no refusal" answer');
    assert.equal(unavailableRowNotice('Mix', [], { truncated: true }), null);
  });

  it('names the count, the positions and the remedy', () => {
    const notice = unavailableRowNotice('Friday Mix', [2, 5]);
    assert.ok(notice, 'a non-empty position list must produce a notice');
    assert.match(notice, /"Friday Mix" contains 2 unavailable item\(s\)/);
    assert.match(notice, /1-based position\(s\) 2, 5/);
    assert.match(notice, /A full rewrite would drop them from the playlist\./);
    assert.match(notice, /Remove the unavailable items first, then retry\./);
  });

  it('honours a caller-supplied remedy', () => {
    const notice = unavailableRowNotice('Mix', [1], { remedy: 'Call remove_unavailable_playlist_items.' });
    assert.ok(notice);
    assert.match(notice, /Call remove_unavailable_playlist_items\./);
    assert.doesNotMatch(
      notice,
      /Remove the unavailable items first/,
      'the caller remedy replaces the default rather than joining it',
    );
  });

  it('caps the quoted positions but NOT the count, and says so with an ellipsis', () => {
    // Twenty-five affected rows. The count has to stay 25 — a refusal that
    // reported "10" understates the loss the caller is agreeing to.
    const positions = Array.from({ length: 25 }, (_, i) => i + 1);
    const notice = unavailableRowNotice('Big Mix', positions);
    assert.ok(notice);
    assert.match(notice, /contains 25 unavailable item\(s\)/, 'the true count survives the cap');
    assert.match(notice, /position\(s\) 1, 2, 3, 4, 5, 6, 7, 8, 9, 10…/, 'exactly ten, then an ellipsis');
    assert.doesNotMatch(notice, /11,/, 'position 11 must not be spelled out');
  });

  it('adds no ellipsis at exactly the cap', () => {
    const notice = unavailableRowNotice('Mix', Array.from({ length: 10 }, (_, i) => i + 1));
    assert.ok(notice);
    assert.doesNotMatch(notice, /…/, 'ten positions are not a truncated list');
  });

  it('states the count is a LOWER BOUND when the item walk stopped at the cap', () => {
    // This is the disclosure clause. Without it the count reads as complete.
    const plain = unavailableRowNotice('Mix', [1, 2]);
    const capped = unavailableRowNotice('Mix', [1, 2], { truncated: true });
    assert.ok(plain && capped);
    assert.doesNotMatch(plain, /lower bound/, 'an unwalked playlist states no bound');
    assert.match(capped, /lower bound/);
    assert.match(capped, /stopped at the configured cap/);
    assert.match(capped, /positions past the cap are unknown/);
  });
});

describe('#657 rewritable: assertPlaylistRewritable', () => {
  it('returns silently for a fully addressable playlist', () => {
    assert.equal(assertPlaylistRewritable('Mix', []), undefined);
  });

  it('throws the notice verbatim before the first PUT', () => {
    // The refusal is an exception, not a confirmation: a prompt can only
    // describe the loss in words, and the row is still gone after the user
    // clicks through it. The message must be byte-identical to the one a dry
    // run discloses, so assert equality rather than a pattern.
    const positions = [3, 4];
    const options = { truncated: true, remedy: 'Fix it.' } as const;
    const expected = unavailableRowNotice('Friday Mix', positions, options);
    assert.ok(expected, 'precondition: the notice text is non-null for a non-empty list');
    assert.throws(
      () => assertPlaylistRewritable('Friday Mix', positions, options),
      (err: unknown) => err instanceof Error && err.message === expected,
      'the throw must carry exactly the dry-run notice',
    );
  });

  it('names the label the caller was rewriting, not the source of the read', () => {
    // For a set operation this is the TARGET. A guard that quoted the source
    // playlist named the wrong playlist in the refusal.
    assert.throws(
      () => assertPlaylistRewritable('Target', [1]),
      /"Target" contains 1 unavailable item\(s\)/,
    );
  });

  it('quotes eleven positions with the ellipsis in the thrown message too', () => {
    const positions = Array.from({ length: 11 }, (_, i) => i + 1);
    assert.throws(
      () => assertPlaylistRewritable('Mix', positions),
      (err: unknown) =>
        err instanceof Error
        && err.message.includes('contains 11 unavailable item(s)')
        && err.message.includes('9, 10…')
        && !err.message.includes('10, 11'),
    );
  });
});
