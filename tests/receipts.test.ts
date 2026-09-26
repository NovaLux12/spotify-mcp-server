/**
 * Tests for src/receipts.ts (#112 idea 11: mutation receipts).
 *
 * Uses a stub client mirroring the makeHarness pattern in
 * tools.playlists-following.test.ts: records wire calls, delegates to a
 * swappable responder keyed by path.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  __resetReceiptStoreForTests,
  formatReceipt,
  getAllReceipts,
  issueReceipt,
  isReceiptsPersistent,
  receiptMissMessage,
  receiptRetentionLabel,
  receiptsFilePath,
  verifyReceipt,
  MAX_RECEIPTS,
  type Receipt,
  type ReceiptClient,
} from '../src/receipts.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SpotifyClient } from '../src/client.js';
import { REGISTRAR_MANIFEST, registerManifestModule } from '../src/tools/annotations.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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
    // Boot-scoped since #587: the boot segment keeps ids from two processes
    // apart, so a stale id can never name a later mutation.
    assert.match(r.receipt_id, /^rcpt_[a-z0-9]+-\d+$/);
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

// ---------------------------------------------------------------------------
// #625 — occurrence rows recorded for undo
// ---------------------------------------------------------------------------

describe('issueReceipt occurrence recording (#625)', () => {
  it('records the added row, not the pre-existing copy of a duplicated uri', async () => {
    // Track X was already at row 0; the add appended a second copy at row 2.
    const client = stubClient(() =>
      pagedItems([track('spotify:track:x'), track('spotify:track:y'), track('spotify:track:x')]),
    );
    const receipt = await issueReceipt(client, {
      kind: 'playlist_items',
      id: 'pl1',
      uris: ['spotify:track:x'],
    });
    assert.deepEqual(receipt.affected, [{ uri: 'spotify:track:x', positions: [2] }]);
  });

  it('records every row an add created when a uri was added more than once', async () => {
    // One pre-existing copy at row 0, then the add appended two more.
    const client = stubClient(() =>
      pagedItems([track('spotify:track:x'), track('spotify:track:x'), track('spotify:track:x')]),
    );
    const receipt = await issueReceipt(client, {
      kind: 'playlist_items',
      id: 'pl1',
      uris: ['spotify:track:x', 'spotify:track:x'],
    });
    assert.deepEqual(receipt.affected, [{ uri: 'spotify:track:x', positions: [1, 2] }],
      'both appended rows are recorded, never the pre-existing one');
  });

  it('records nothing when the walk stopped short of the end of the playlist', async () => {
    // Every page is full and `next` never ends: the walk runs out of pages
    // before the appended row. The last visible copy of x predates the add.
    const full = pagedItems(Array.from({ length: 100 }, (_, i) => track(`spotify:track:r${i}`)), 600, 'more');
    const client = stubClient(() => full);
    const receipt = await issueReceipt(client, {
      kind: 'playlist_items',
      id: 'pl1',
      uris: ['spotify:track:r0'],
    });
    assert.equal(receipt.affected, undefined,
      'a partial walk must not yield positions — undo would target a pre-existing row');
  });

  it('records nothing for a uri the walk never saw, so undo can refuse', async () => {
    const client = stubClient(() => pagedItems([track('spotify:track:seen')]));
    const receipt = await issueReceipt(client, {
      kind: 'playlist_items',
      id: 'pl1',
      uris: ['spotify:track:seen', 'spotify:track:unseen'],
    });
    assert.deepEqual(receipt.affected, [{ uri: 'spotify:track:seen', positions: [0] }]);
    assert.equal(
      receipt.affected?.some((entry) => entry.uri === 'spotify:track:unseen'),
      false,
      'an unobserved uri must not get a guessed position',
    );
  });

  it('records the removed positions of a targeted removal', async () => {
    const client = stubClient(() => pagedItems([track('spotify:track:b')]));
    const receipt = await issueReceipt(client, {
      kind: 'playlist_items',
      id: 'pl1',
      uris: ['spotify:track:a'],
      expectPresent: false,
      targetedPositions: [
        { uri: 'spotify:track:a', position: 3 },
        { uri: 'spotify:track:a', position: 1 },
      ],
    });
    assert.deepEqual(receipt.affected, [{ uri: 'spotify:track:a', positions: [1, 3] }]);
  });

  it('records no positions for a bare removal, whose rows reindexed', async () => {
    const client = stubClient(() => pagedItems([]));
    const receipt = await issueReceipt(client, {
      kind: 'playlist_items',
      id: 'pl1',
      uris: ['spotify:track:a'],
      expectPresent: false,
    });
    assert.equal(receipt.affected, undefined);
  });

  it('records the INSERTED row for a positional add, not the last occurrence', async () => {
    // Main's reproduction: [A, X, B] + insert X at 0 -> [X, A, X, B]. The
    // added row is index 0; index 2 is the X that predates the mutation.
    const client = stubClient(() =>
      pagedItems([track('spotify:track:x'), track('spotify:track:a'), track('spotify:track:x'), track('spotify:track:b')]),
    );
    const receipt = await issueReceipt(client, {
      kind: 'playlist_items',
      id: 'pl1',
      uris: ['spotify:track:x'],
      insertPosition: 0,
    });
    assert.deepEqual(receipt.affected, [{ uri: 'spotify:track:x', positions: [0] }]);
  });

  it('records a multi-uri positional add at consecutive indices', async () => {
    const client = stubClient(() =>
      pagedItems([track('spotify:track:x'), track('spotify:track:y'), track('spotify:track:a')]),
    );
    const receipt = await issueReceipt(client, {
      kind: 'playlist_items',
      id: 'pl1',
      uris: ['spotify:track:x', 'spotify:track:y'],
      insertPosition: 0,
    });
    assert.deepEqual(receipt.affected, [
      { uri: 'spotify:track:x', positions: [0] },
      { uri: 'spotify:track:y', positions: [1] },
    ]);
  });

  it('records nothing when a claimed insert position does not match the list', async () => {
    // A caller that supplies a position the walk cannot corroborate gets no
    // positions at all, so undo refuses instead of deleting a wrong row.
    const client = stubClient(() =>
      pagedItems([track('spotify:track:a'), track('spotify:track:x')]),
    );
    const receipt = await issueReceipt(client, {
      kind: 'playlist_items',
      id: 'pl1',
      uris: ['spotify:track:x'],
      insertPosition: 0,
    });
    assert.equal(receipt.affected, undefined);
  });

  it('records exactly the rows a caller states it created, at scattered indices', async () => {
    // An undo re-inserts runs at their own indices, which neither the append
    // rule nor a single `insertPosition` can express. The caller's rows are
    // taken as given once each one is corroborated by the observed list.
    const client = stubClient(() =>
      pagedItems([track('spotify:track:a'), track('spotify:track:b'), track('spotify:track:c')]),
    );
    const receipt = await issueReceipt(client, {
      kind: 'playlist_items',
      id: 'pl1',
      uris: ['spotify:track:b', 'spotify:track:c'],
      createdPositions: [
        { uri: 'spotify:track:b', position: 1 },
        { uri: 'spotify:track:c', position: 2 },
      ],
    });
    assert.deepEqual(receipt.affected, [
      { uri: 'spotify:track:b', positions: [1] },
      { uri: 'spotify:track:c', positions: [2] },
    ]);
  });

  it('records nothing for a stated row the walk cannot corroborate', async () => {
    // A stated position is still checked against the list. Row 1 holds 'a',
    // not the claimed 'z', so the claim is dropped wholesale and undo refuses
    // rather than deleting a row the mutation cannot justify owning.
    const client = stubClient(() =>
      pagedItems([track('spotify:track:a'), track('spotify:track:a')]),
    );
    const receipt = await issueReceipt(client, {
      kind: 'playlist_items',
      id: 'pl1',
      uris: ['spotify:track:z'],
      createdPositions: [{ uri: 'spotify:track:z', position: 1 }],
    });
    assert.equal(receipt.affected, undefined);
  });

  it('records no rows when a caller states it created none, even though the uri is present', async () => {
    // The delete-only rollback: every surviving copy PREDATES the mutation, so
    // claiming one as created would let the next undo delete pre-existing
    // state. Presence is still verified — only the row attribution is withheld.
    const client = stubClient(() => pagedItems([track('spotify:track:a')]));
    const receipt = await issueReceipt(client, {
      kind: 'playlist_items',
      id: 'pl1',
      uris: ['spotify:track:a'],
      createdPositions: [],
    });
    assert.equal(receipt.affected, undefined, 'the survivor is not claimed as created');
    assert.equal(receipt.verified, true, 'presence is still confirmed');
    assert.deepEqual(receipt.occurrences, { 'spotify:track:a': 1 });
  });

  it('records no occurrence counts when the walk stopped short of the end', async () => {
    // A truncated walk undercounts. Undo reads these counts to decide whether
    // a uri should still be present after the rollback, so an undercount here
    // becomes a false "the uri is gone" expectation and a false mismatch.
    const full = pagedItems(Array.from({ length: 100 }, (_, i) => track(`spotify:track:r${i}`)), 600, 'more');
    const client = stubClient(() => full);
    const receipt = await issueReceipt(client, {
      kind: 'playlist_items',
      id: 'pl1',
      uris: ['spotify:track:r0'],
    });
    assert.equal(receipt.occurrences, undefined);
  });

  it('records occurrence counts for a fully visible list', async () => {
    const client = stubClient(() =>
      pagedItems([track('spotify:track:x'), track('spotify:track:y'), track('spotify:track:x')]),
    );
    const receipt = await issueReceipt(client, {
      kind: 'playlist_items',
      id: 'pl1',
      uris: ['spotify:track:x', 'spotify:track:y'],
    });
    assert.deepEqual(receipt.occurrences, { 'spotify:track:x': 2, 'spotify:track:y': 1 });
  });
});

// ---------------------------------------------------------------------------
// #586 — verify_receipt must not invert a removal receipt's vocabulary
// ---------------------------------------------------------------------------

describe('verify_receipt label direction (#586)', () => {
  /**
   * Call the REAL `verify_receipt` tool — the registration that ships — rather
   * than `formatReceipt` directly. The defect lived in the gap between the two:
   * the mutating turn passed `{ expectPresent: false }`, the re-render passed
   * nothing, and the removal branch never ran.
   */
  async function callVerifyReceipt(receiptId: string): Promise<{ text: string; structuredContent: Record<string, unknown> }> {
    const server = new McpServer({ name: 'verify-receipt-audit', version: '0.0.0' });
    const context = { readOnly: false, isModuleActive: () => true, scopeBlocked: () => false };
    const module = REGISTRAR_MANIFEST.find((m) => m.key === 'receipts');
    assert.ok(module, 'the receipts module must be in the registrar manifest');
    registerManifestModule(server, new SpotifyClient(), module!, context);
    const registry = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; structuredContent?: Record<string, unknown> }> }>;
    })._registeredTools;
    const tool = registry.verify_receipt;
    assert.ok(tool, 'verify_receipt must be registered');
    const out = await tool.handler({ receipt_id: receiptId });
    return { text: out.content[0].text, structuredContent: out.structuredContent ?? {} };
  }

  it('labels a removal receipt\'s leftover uris still-present, not missing', async () => {
    // A removal of [gone, keep] where `keep` is still in the playlist.
    const client = stubClient(() => pagedItems([track('spotify:track:keep')]));
    const receipt = await issueReceipt(client, {
      kind: 'playlist_items',
      id: 'pl1',
      uris: ['spotify:track:gone', 'spotify:track:keep'],
      expectPresent: false,
    });
    assert.deepEqual(receipt.missing, ['spotify:track:keep'], 'the uri the refetch saw is the leftover');

    const { text, structuredContent } = await callVerifyReceipt(receipt.receipt_id);
    assert.match(text, /still-present uris: spotify:track:keep/);
    assert.doesNotMatch(text, /missing uris/,
      'a still-present uri must never be reported as missing — that reads as a removal that worked');
    assert.equal(structuredContent.expect_present, false,
      'an agent must be able to branch on the recorded direction, not parse prose');
    assert.deepEqual(structuredContent.missing, ['spotify:track:keep']);
  });

  it('keeps the addition vocabulary for an add whose uri did not land', async () => {
    const client = stubClient(() => pagedItems([track('spotify:track:other')]));
    const receipt = await issueReceipt(client, {
      kind: 'playlist_items',
      id: 'pl1',
      uris: ['spotify:track:absent'],
    });
    assert.deepEqual(receipt.missing, ['spotify:track:absent']);

    const { text, structuredContent } = await callVerifyReceipt(receipt.receipt_id);
    assert.match(text, /missing uris: spotify:track:absent/);
    assert.doesNotMatch(text, /still-present/);
    assert.equal(structuredContent.expect_present, true);
  });

  it('confirms absence rather than presence once the removal fully landed', async () => {
    const client = stubClient(() => pagedItems([]));
    const receipt = await issueReceipt(client, {
      kind: 'playlist_items',
      id: 'pl1',
      uris: ['spotify:track:gone'],
      expectPresent: false,
    });
    const { text } = await callVerifyReceipt(receipt.receipt_id);
    assert.match(text, /all uris confirmed absent/);
    assert.doesNotMatch(text, /all uris confirmed\n/);
  });
});

// #587 — receipts that survive a restart
//
// "Restart" is exercised two ways, because the two prove different things:
// a real second PROCESS (two `node --import tsx` children, so the in-memory
// store genuinely starts empty), and a store reset in-process for the
// retention rules that are about the trail's content.
// ---------------------------------------------------------------------------

/** Run a receipt operation in a genuinely separate process. */
function runReceiptChild(
  mode: 'issue' | 'issue-then-read',
  env: Record<string, string>,
): { fresh: Receipt; stale: Receipt | null } {
  const script = `
    const { issueReceipt, verifyReceipt } = await import(
      new URL('src/receipts.ts', 'file://' + process.cwd() + '/').href
    );
    const client = {
      get: async (path) =>
        path === '/me/library/contains'
          ? (process.env.CHILD_URIS ?? '').split(',').map(() => true)
          : null,
    };
    const fresh = await issueReceipt(client, {
      kind: 'library',
      uris: (process.env.CHILD_URIS ?? '').split(','),
    });
    const stale = process.env.CHILD_ID
      ? (verifyReceipt(process.env.CHILD_ID) ?? null)
      : null;
    process.stdout.write(JSON.stringify({ fresh, stale }));
  `;
  const out = execFileSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env, CHILD_MODE: mode } },
  );
  return JSON.parse(out) as { fresh: Receipt; stale: Receipt | null };
}

async function withTempDataDir<T>(
  vars: Record<string, string>,
  run: (dir: string) => T | Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'receipts-587-'));
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries({ ...vars, SPOTIFY_MCP_RECEIPTS_DIR: dir })) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await run(dir);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

const PERSIST_ON = { SPOTIFY_MCP_RECEIPTS: '1' };
const PERSIST_OFF = { SPOTIFY_MCP_RECEIPTS: '' };

describe('receipts across a restart (#587)', () => {
  it('a receipt issued before a restart still resolves after it, with the same id and content', async () => {
    await withTempDataDir(PERSIST_ON, () => {
      const first = runReceiptChild('issue', { CHILD_URIS: 'spotify:track:keep1,spotify:track:keep2' });
      // A second process: nothing in memory, everything it knows comes off disk.
      const after = runReceiptChild('issue-then-read', {
        CHILD_URIS: 'spotify:track:later',
        CHILD_ID: first.fresh.receipt_id,
      });
      assert.ok(after.stale, 'the pre-restart receipt must still be resolvable');
      assert.equal(after.stale.receipt_id, first.fresh.receipt_id);
      assert.deepEqual(after.stale.uris, ['spotify:track:keep1', 'spotify:track:keep2']);
      assert.deepEqual(after.stale, JSON.parse(JSON.stringify(first.fresh)) as Receipt);
    });
  });

  it('an id from an earlier process never resolves to a different mutation', async () => {
    await withTempDataDir(PERSIST_OFF, () => {
      // Counters restart at 1 in a new process, so a bare `rcpt_1` from the
      // previous session would silently resolve to whatever this session's
      // first mutation was.
      const before = JSON.parse(
        execFileSync(
          process.execPath,
          [
            '--import',
            'tsx',
            '--input-type=module',
            '-e',
            `const { issueReceipt } = await import(new URL('src/receipts.ts', 'file://' + process.cwd() + '/').href);
             const client = { get: async () => [true] };
             const r = await issueReceipt(client, { kind: 'library', uris: ['spotify:track:OLD'] });
             process.stdout.write(JSON.stringify(r));`,
          ],
          { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...PERSIST_OFF } },
        ),
      ) as Receipt;
      assert.equal(before.uris[0], 'spotify:track:OLD');

      const after = runReceiptChild('issue-then-read', {
        CHILD_URIS: 'spotify:track:NEW',
        CHILD_ID: before.receipt_id,
      });
      assert.notEqual(after.fresh.receipt_id, before.receipt_id, 'ids must be boot-scoped');
      assert.equal(after.stale, null, 'a stale id must resolve to nothing, never to a later receipt');
      assert.notDeepEqual(after.fresh.uris, before.uris);
    });
  });

  it('the miss message names the session scope and the retention rule when persistence is off', () => {
    withTempDataDir(PERSIST_OFF, () => {
      __resetReceiptStoreForTests();
      const message = receiptMissMessage('rcpt_gone-1');
      assert.match(message, /Unknown or expired receipt "rcpt_gone-1"/);
      assert.match(message, /session-scoped/);
      assert.match(message, /not persisted to disk/);
      assert.match(message, new RegExp(`${MAX_RECEIPTS} most recent mutations`));
      assert.match(message, /24h/);
    });
  });

  it('the miss message names the on-disk trail when persistence is on', async () => {
    await withTempDataDir(PERSIST_ON, (dir) => {
      __resetReceiptStoreForTests();
      const message = receiptMissMessage('rcpt_gone-1');
      assert.ok(message.includes(join(dir, 'receipts.jsonl')), message);
      assert.match(message, new RegExp(`${MAX_RECEIPTS} most recent mutations`));
    });
  });

  it('reports a TTL of hours in the retention label, and no time limit when disabled', () => {
    assert.equal(receiptRetentionLabel({}), 'for up to 24h');
    assert.equal(receiptRetentionLabel({ SPOTIFY_MCP_RECEIPTS_TTL_HOURS: '2' }), 'for up to 2h');
    assert.equal(receiptRetentionLabel({ SPOTIFY_MCP_RECEIPTS_TTL_HOURS: '0' }), 'with no time limit');
  });

  it('is opt-in: nothing is written and nothing is loaded when persistence is off', async () => {
    await withTempDataDir(PERSIST_OFF, async (dir) => {
      assert.equal(isReceiptsPersistent(), false);
      __resetReceiptStoreForTests();
      const client = stubClient((_p, arg) => (arg?.uris ?? '').split(',').map(() => true));
      const receipt = await issueReceipt(client, { kind: 'library', uris: ['spotify:track:ephemeral'] });
      assert.ok(verifyReceipt(receipt.receipt_id));
      assert.throws(() => readFileSync(join(dir, 'receipts.jsonl')));
    });
  });
});

describe('receipt retention on disk (#587)', () => {
  it('reloads the newest MAX_RECEIPTS after a restart and drops what the cap evicted', async () => {
    await withTempDataDir(PERSIST_ON, async (dir) => {
      __resetReceiptStoreForTests();
      const client = stubClient((_p, arg) => (arg?.uris ?? '').split(',').map(() => true));
      const issued: Receipt[] = [];
      for (let i = 0; i < MAX_RECEIPTS + 1; i++) {
        issued.push(await issueReceipt(client, { kind: 'library', uris: [`spotify:track:f${i}`] }));
      }
      const trailLines = readFileSync(join(dir, 'receipts.jsonl'), 'utf8').trim().split('\n');
      assert.equal(trailLines.length, MAX_RECEIPTS + 1, 'every issue is appended before a compaction');

      __resetReceiptStoreForTests(); // restart
      const reloaded = getAllReceipts();
      assert.equal(reloaded.length, MAX_RECEIPTS);
      assert.equal(verifyReceipt(issued[0].receipt_id), undefined, 'the FIFO-oldest receipt is gone');
      assert.deepEqual(verifyReceipt(issued[1].receipt_id)?.uris, issued[1].uris);
      assert.deepEqual(verifyReceipt(issued[MAX_RECEIPTS].receipt_id)?.uris, [
        `spotify:track:f${MAX_RECEIPTS}`,
      ]);
    });
  });

  it('keeps the undo anchor — the rows a mutation created — across a restart', async () => {
    await withTempDataDir(PERSIST_ON, async () => {
      __resetReceiptStoreForTests();
      const client = stubClient((_p) =>
        pagedItems([track('spotify:track:a'), track('spotify:track:b'), track('spotify:track:a')]),
      );
      const receipt = await issueReceipt(client, {
        kind: 'playlist_items',
        id: 'pl1',
        uris: ['spotify:track:a'],
      });
      assert.deepEqual(receipt.affected, [{ uri: 'spotify:track:a', positions: [2] }]);

      __resetReceiptStoreForTests(); // restart
      const reloaded = verifyReceipt(receipt.receipt_id);
      assert.deepEqual(reloaded?.affected, [{ uri: 'spotify:track:a', positions: [2] }]);
      assert.deepEqual(reloaded?.occurrences, { 'spotify:track:a': 2 });
      assert.deepEqual(reloaded, JSON.parse(JSON.stringify(receipt)) as Receipt);
    });
  });

  it('compacts the trail instead of growing it without bound', async () => {
    await withTempDataDir(PERSIST_ON, async (dir) => {
      __resetReceiptStoreForTests();
      const client = stubClient((_p, arg) => (arg?.uris ?? '').split(',').map(() => true));
      for (let i = 0; i < MAX_RECEIPTS * 5; i++) {
        await issueReceipt(client, { kind: 'library', uris: [`spotify:track:c${i}`] });
      }
      const lines = readFileSync(join(dir, 'receipts.jsonl'), 'utf8').trim().split('\n');
      assert.ok(lines.length <= MAX_RECEIPTS * 2, `trail grew to ${lines.length} lines`);
      assert.equal(getAllReceipts().length, MAX_RECEIPTS);
    });
  });

  it('expires a receipt past the TTL, and reports it as expired rather than unknown', async () => {
    await withTempDataDir(PERSIST_ON, async (dir) => {
      __resetReceiptStoreForTests();
      const client = stubClient((_p, arg) => (arg?.uris ?? '').split(',').map(() => true));
      const receipt = await issueReceipt(client, { kind: 'library', uris: ['spotify:track:stale'] });

      // Age the receipt on disk by a day past the 24h default, as a day-old
      // trail would be after the host was off overnight.
      const file = join(dir, 'receipts.jsonl');
      const aged = readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => {
          const parsed = JSON.parse(line) as Receipt;
          return JSON.stringify({ ...parsed, issued_at: Date.now() - 25 * 3_600_000 });
        });
      writeFileSync(file, aged.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });

      __resetReceiptStoreForTests(); // restart
      assert.equal(verifyReceipt(receipt.receipt_id), undefined);
      assert.equal(getAllReceipts().length, 0);
      assert.match(receiptMissMessage(receipt.receipt_id), /Unknown or expired/);
    });
  });

  it('keeps a receipt whose TTL is disabled and one with no recorded time', async () => {
    await withTempDataDir({ ...PERSIST_ON, SPOTIFY_MCP_RECEIPTS_TTL_HOURS: '0' }, async (dir) => {
      __resetReceiptStoreForTests();
      const client = stubClient((_p, arg) => (arg?.uris ?? '').split(',').map(() => true));
      const receipt = await issueReceipt(client, { kind: 'library', uris: ['spotify:track:forever'] });
      const file = join(dir, 'receipts.jsonl');
      writeFileSync(
        file,
        [
          JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), receipt_id: 'rcpt_legacy-1', issued_at: Date.now() - 90 * 86_400_000 }),
          JSON.stringify({ receipt_id: 'rcpt_untimed-1', kind: 'library', verified: true, missing: [], uris: ['spotify:track:untimed'] }),
        ].join('\n') + '\n',
        { encoding: 'utf8', mode: 0o600 },
      );

      __resetReceiptStoreForTests(); // restart
      assert.ok(verifyReceipt('rcpt_legacy-1'), 'TTL 0 means no expiry');
      assert.ok(verifyReceipt('rcpt_untimed-1'), 'an unknown age is not an expired one');
      assert.equal(verifyReceipt(receipt.receipt_id), undefined, 'the overwritten id is simply gone');
    });
  });
});
