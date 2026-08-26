/**
 * Tests for src/receipts.ts (#112 idea 11: mutation receipts).
 *
 * Uses a stub client mirroring the makeHarness pattern in
 * tools.playlists-following.test.ts: records wire calls, delegates to a
 * swappable responder keyed by path.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatReceipt,
  issueReceipt,
  verifyReceipt,
  type Receipt,
  type ReceiptClient,
} from '../src/receipts.js';

// ---------------------------------------------------------------------------
// Stub plumbing
// ---------------------------------------------------------------------------

interface RecordedCall {
  method: 'GET';
  path: string;
  arg?: unknown;
}

type Responder = (path: string, arg?: Record<string, string>) => unknown;

function stubClient(responder: Responder = () => null): ReceiptClient & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      calls.push({ method: 'GET', path, arg: params });
      return responder(path, params) as T | null;
    },
  };
}

const pagedItems = (
  rows: Array<{ uri?: string } | null>,
  total = rows.length,
  next: string | null = null,
) => ({
  items: rows.map((r) => ({ added_at: '2026-01-01T00:00:00Z', item: r })),
  total,
  limit: rows.length,
  offset: 0,
  next,
});

const track = (uri: string) => ({ uri, name: uri });

// ---------------------------------------------------------------------------
// verified case (playlist_items)
// ---------------------------------------------------------------------------

describe('issueReceipt playlist_items', () => {
  it('verifies when every uri is present after the mutation', async () => {
    const client = stubClient((path) => {
      assert.equal(path, '/playlists/pl1/items');
      return pagedItems([track('spotify:track:a'), track('spotify:track:b')]);
    });
    const r = await issueReceipt(client, {
      kind: 'playlist_items',
      id: 'pl1',
      uris: ['spotify:track:a', 'spotify:track:b'],
      before: 0,
    });
    assert.equal(r.verified, true);
    assert.deepEqual(r.missing, []);
    assert.equal(r.after, 2);
    assert.equal(r.before, 0);
    assert.equal(r.id, 'pl1');
    assert.match(r.receipt_id, /^rcpt_\d+$/);
    // One page fetch at limit=100/offset=0.
    assert.deepEqual(client.calls, [
      { method: 'GET', path: '/playlists/pl1/items', arg: { limit: '100', offset: '0' } },
    ]);
    // Stored and retrievable.
    assert.deepEqual(verifyReceipt(r.receipt_id), r);
  });

  it('counts duplicate occurrences across pages', async () => {
    const client = stubClient((_path, arg) =>
      arg?.offset === '0'
        ? pagedItems(Array.from({ length: 100 }, () => track('spotify:track:x')), 150, 'next')
        : pagedItems([track('spotify:track:x'), track('spotify:track:y')], 150),
    );
    const r = await issueReceipt(client, {
      kind: 'playlist_items',
      id: 'pl2',
      uris: ['spotify:track:x', 'spotify:track:y'],
    });
    assert.equal(client.calls.length, 2);
    assert.equal(r.after, 102); // 100 + 2
    assert.equal(r.verified, true);
  });

  it('caps the walk at 5 pages even when every page is full', async () => {
    const client = stubClient(() =>
      pagedItems(
        Array.from({ length: 100 }, (_, i) => track(`spotify:track:t${i}`)),
        100000,
        'next',
      ),
    );
    const r = await issueReceipt(client, {
      kind: 'playlist_items',
      id: 'pl3',
      uris: ['spotify:track:not-there'],
    });
    assert.equal(client.calls.length, 5);
    assert.equal(r.verified, false);
    assert.deepEqual(r.missing, ['spotify:track:not-there']);
  });

  it('reports partial verification with missing uris listed in input order', async () => {
    const client = stubClient(() => pagedItems([track('spotify:track:keep')]));
    const r = await issueReceipt(client, {
      kind: 'playlist_items',
      id: 'pl4',
      uris: ['spotify:track:gone1', 'spotify:track:keep', 'spotify:track:gone2'],
    });
    assert.equal(r.verified, false);
    assert.deepEqual(r.missing, ['spotify:track:gone1', 'spotify:track:gone2']);
    assert.equal(r.after, 1);
  });
});

// ---------------------------------------------------------------------------
// library contains chunking (≤50 uris per call)
// ---------------------------------------------------------------------------

describe('issueReceipt library', () => {
  it('chunks >50 contains-checks into ≤50-uri calls', async () => {
    const uris = Array.from({ length: 120 }, (_, i) => `spotify:track:c${i}`);
    const chunksSeen: number[] = [];
    const client = stubClient((path, arg) => {
      assert.equal(path, '/me/library/contains');
      const list = (arg?.uris ?? '').split(',');
      chunksSeen.push(list.length);
      return list.map((u) => u !== 'spotify:track:c7' && u !== 'spotify:track:c99');
    });
    const r = await issueReceipt(client, { kind: 'library', uris });
    assert.deepEqual(chunksSeen, [50, 50, 20]);
    assert.equal(r.verified, false);
    assert.deepEqual(r.missing, ['spotify:track:c7', 'spotify:track:c99']);
    assert.equal(r.after, 118);
    assert.deepEqual(verifyReceipt(r.receipt_id)?.missing, r.missing);
  });

  it('verifies when all uris are saved', async () => {
    const client = stubClient((_p, arg) => (arg?.uris ?? '').split(',').map(() => true));
    const r = await issueReceipt(client, {
      kind: 'library',
      uris: ['spotify:album:e1', 'spotify:album:e2'],
    });
    assert.equal(r.verified, true);
    assert.deepEqual(r.missing, []);
    assert.equal(r.after, 2);
  });
});

// ---------------------------------------------------------------------------
// playlist_meta
// ---------------------------------------------------------------------------

describe('issueReceipt playlist_meta', () => {
  it('verifies when the created playlist resolves', async () => {
    let exists = true;
    const client = stubClient((path) => {
      assert.equal(path, '/playlists/newpl');
      return exists ? { uri: 'spotify:playlist:newpl' } : null;
    });
    const ok = await issueReceipt(client, { kind: 'playlist_meta', id: 'newpl', uris: [] });
    assert.equal(ok.verified, true);
    exists = false;
    const gone = await issueReceipt(client, { kind: 'playlist_meta', id: 'newpl', uris: [] });
    assert.equal(gone.verified, false);
  });
  it('reports UNVERIFIED on a failed refetch even with no uris to check', async () => {
    const client = stubClient(() => null);
    const r = await issueReceipt(client, { kind: 'playlist_meta', id: 'ghost', uris: [] });
    assert.equal(r.verified, false);
    assert.deepEqual(r.missing, []);
    assert.equal(r.after, 0);
  });
});

// ---------------------------------------------------------------------------
// store cap / FIFO eviction
// ---------------------------------------------------------------------------

describe('receipt store', () => {
  it('evicts oldest receipts FIFO beyond the 100-entry cap', async () => {
    const client = stubClient((_p, arg) => (arg?.uris ?? '').split(',').map(() => true));
    const issued: Receipt[] = [];
    for (let i = 0; i < 101; i++) {
      issued.push(await issueReceipt(client, { kind: 'library', uris: [`spotify:track:f${i}`] }));
    }
    assert.equal(verifyReceipt(issued[0].receipt_id), undefined); // evicted
    assert.ok(verifyReceipt(issued[1].receipt_id)); // now the oldest survivor
    assert.ok(verifyReceipt(issued[100].receipt_id)); // newest retained
  });

  it('verifyReceipt returns undefined for unknown ids', () => {
    assert.equal(verifyReceipt('rcpt_99999999'), undefined);
  });
});

// ---------------------------------------------------------------------------
// format stability
// ---------------------------------------------------------------------------

describe('formatReceipt', () => {
  it('is byte-stable for the same receipt', () => {
    const receipt: Receipt = {
      receipt_id: 'rcpt_42',
      kind: 'playlist_items',
      id: 'pl9',
      verified: false,
      before: 1,
      after: 1,
      missing: ['spotify:track:gone'],
    };
    assert.equal(formatReceipt(receipt), formatReceipt(receipt));
    assert.equal(
      formatReceipt(receipt),
      [
        'Receipt rcpt_42: UNVERIFIED (playlist_items pl9)',
        '  occurrences before/after: 1/1',
        '  missing uris: spotify:track:gone',
      ].join('\n'),
    );
  });

  it('formats the verified case without optional fields deterministically', () => {
    const receipt: Receipt = {
      receipt_id: 'rcpt_43',
      kind: 'library',
      verified: true,
      after: 2,
      missing: [],
    };
    assert.equal(
      formatReceipt(receipt),
      [
        'Receipt rcpt_43: VERIFIED (library)',
        '  occurrences before/after: ?/2',
        '  all uris confirmed',
      ].join('\n'),
    );
  });
});

describe('playlist_items absence direction (#133-era receipts)', () => {
  it('reports survivors as missing and counts remaining occurrences', async () => {
    const calls: Array<{ path: string; arg?: Record<string, string> }> = [];
    const client = {
      get: async (path: string, arg?: Record<string, string>) => {
        calls.push({ path, arg });
        // Page shows uri-keep survived (2 occurrences), uri-gone is absent.
        return {
          items: [
            { item: { uri: 'spotify:track:keep' } },
            { item: { uri: 'spotify:track:keep' } },
          ],
          total: 2,
          limit: 100,
          offset: 0,
          next: null,
        };
      },
    };

    const receipt = await issueReceipt(client, {
      kind: 'playlist_items',
      id: 'pl1',
      uris: ['spotify:track:gone', 'spotify:track:keep'],
      expectPresent: false,
    });

    assert.equal(receipt.verified, false);
    assert.deepEqual(receipt.missing, ['spotify:track:keep']);
    assert.equal(receipt.after, 2);
    const prose = formatReceipt(receipt, { expectPresent: false });
    assert.match(prose, /still-present uris: spotify:track:keep/);
  });

  it('reports verified when every uri is confirmed absent', async () => {
    const client = {
      get: async () => ({
        items: [],
        total: 0,
        limit: 100,
        offset: 0,
        next: null,
      }),
    };
    const receipt = await issueReceipt(client, {
      kind: 'playlist_items',
      id: 'pl1',
      uris: ['spotify:track:gone'],
      expectPresent: false,
    });
    assert.equal(receipt.verified, true);
    assert.equal(receipt.after, 0);
  });
});
