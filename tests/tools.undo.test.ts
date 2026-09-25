/**
 * Tests for src/tools/undo.ts — direction-aware undo (#625).
 *
 * Regression: undo used to hard-code `DELETE /me/library`, so undoing a removal
 * re-removed (and reported success). These tests pin the inversion direction and
 * the dry-run default. No network, no token file access.
 *
 * Run: node --import tsx --test tests/tools.undo.test.ts
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { issueReceipt } from '../src/receipts.js';
import { registerUndoTools } from '../src/tools/undo.js';

interface RecordedCall {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  arg?: unknown;
}

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> }>;

/**
 * A stub McpServer. By default it carries an inner host that advertises
 * elicitation and accepts, so the tests below exercise the confirmed path the
 * gate requires; `canConfirm: false` models a client that never advertised it.
 */
function stubServer(opts: { canConfirm?: boolean } = {}): { server: McpServer; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const server = {
    tool(name: string, _description: string, _schema: unknown, handler: Handler) {
      handlers.set(name, handler);
      return { name };
    },
    // The gate resolves the INNER host, exactly as McpServer does (#684).
    server: opts.canConfirm === false
      ? undefined
      : {
        getClientCapabilities: () => ({ elicitation: {} }),
        elicitInput: async () => ({ action: 'accept', content: { confirm: true } }),
      },
  } as unknown as McpServer;
  return { server, handlers };
}

/**
 * A stub Spotify over a MUTABLE account, so the post-state refetch undo relies
 * on actually observes the writes it made. A stub that answers every GET with
 * `{}` cannot confirm anything, and would make the honest-reporting contract
 * untestable.
 */
function stubClient(): {
  client: SpotifyClient;
  calls: RecordedCall[];
  saved: Set<string>;
  playlists: Record<string, string[]>;
} {
  const calls: RecordedCall[] = [];
  const saved = new Set<string>();
  const playlists: Record<string, string[]> = {};

  /** Resolve `/playlists/{id}/items` to that playlist's row list. */
  const playlistIdOf = (path: string): string | null => {
    const match = /^\/playlists\/([^/]+)\/items$/.exec(path);
    return match ? decodeURIComponent(match[1]!) : null;
  };

  const client = {
    async get(path: string, params?: Record<string, string>): Promise<unknown> {
      calls.push({ method: 'GET', path, arg: params });
      if (path === '/me/library/contains') {
        return (params?.uris ?? '').split(',').filter(Boolean).map((uri) => saved.has(uri));
      }
      const id = playlistIdOf(path);
      if (id === null) return {};
      playlists[id] ??= [];
      const offset = Number(params?.offset ?? '0');
      const limit = Number(params?.limit ?? '100');
      const page = playlists[id]!.slice(offset, offset + limit);
      return {
        items: page.map((uri) => ({ item: { uri } })),
        total: playlists[id]!.length,
        // Spotify advertises a further page whenever rows remain.
        next: offset + limit < playlists[id]!.length ? 'more' : undefined,
      };
    },
    async post(path: string, arg?: unknown): Promise<unknown> {
      calls.push({ method: 'POST', path, arg });
      const id = playlistIdOf(path);
      if (id !== null) {
        // `position` inserts at that zero-based index; omitted means append.
        const rows = playlists[id] ?? [];
        const at = numberField(arg, 'position');
        playlists[id] =
          at === null
            ? [...rows, ...stringList(arg, 'uris')]
            : [...rows.slice(0, at), ...stringList(arg, 'uris'), ...rows.slice(at)];
      }
      return { snapshot_id: 'snap-post' };
    },
    async put(path: string, arg?: unknown): Promise<unknown> {
      calls.push({ method: 'PUT', path, arg });
      if (path.startsWith('/me/library?')) for (const uri of urisParam(path)) saved.add(uri);
      return null;
    },
    async delete(path: string, arg?: unknown): Promise<unknown> {
      calls.push({ method: 'DELETE', path, arg });
      if (path.startsWith('/me/library?')) {
        for (const uri of urisParam(path)) saved.delete(uri);
        return null;
      }
      const id = playlistIdOf(path);
      if (id !== null) {
        // This stub encodes the DOCUMENTED contract, not whatever the code
        // under test happens to send: `DELETE /playlists/{id}/items` takes
        // `{ tracks: [{ uri, positions? }] }`. A body without `tracks` is
        // rejected the way the real endpoint rejects it, so an implementation
        // that invents a different shape fails here instead of passing.
        const tracks = trackList(arg);
        if (tracks === null) throw new Error('400: body must carry a "tracks" array');
        const rows = playlists[id] ?? [];
        const drop = new Set<number>();
        let anyPositions = false;
        for (const entry of tracks) {
          for (const position of entry.positions) {
            anyPositions = true;
            if (position < 0 || position >= rows.length) {
              throw new Error(`400: position ${position} is out of range for ${rows.length} rows`);
            }
            if (rows[position] !== entry.uri) {
              throw new Error(`400: position ${position} does not hold ${entry.uri}`);
            }
            drop.add(position);
          }
        }
        // A bare-URI entry drops every copy; a positional entry drops exactly
        // the rows it names. That is the behaviour being relied on.
        playlists[id] = anyPositions
          ? rows.filter((_, index) => !drop.has(index))
          : rows.filter((uri) => !tracks.some((entry) => entry.uri === uri));
      }
      return { snapshot_id: 'snap-delete' };
    },
  } as unknown as SpotifyClient;
  return { client, calls, saved, playlists };
}

/** Read a string[] request-body field, narrowing rather than asserting. */
function stringList(body: unknown, key: string): string[] {
  const value = fieldOf(body, key);
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : [];
}

/** Read a number[] request-body field; null when the field is absent. */
function numberList(body: unknown, key: string): number[] | null {
  const value = fieldOf(body, key);
  return Array.isArray(value) && value.every((v) => typeof v === 'number') ? (value as number[]) : null;
}

/**
 * Parse the documented `{ tracks: [{ uri, positions? }] }` body, narrowing
 * rather than assuming. Returns null when the shape is not the documented one.
 * An entry with no `positions` means "every occurrence of this uri".
 */
function trackList(body: unknown): Array<{ uri: string; positions: number[] }> | null {
  const value = fieldOf(body, 'tracks');
  if (!Array.isArray(value)) return null;
  const out: Array<{ uri: string; positions: number[] }> = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || !('uri' in entry)) return null;
    const record = entry as Record<string, unknown>;
    if (typeof record.uri !== 'string') return null;
    out.push({ uri: record.uri, positions: numberList(entry, 'positions') ?? [] });
  }
  return out;
}

/** Read a numeric request-body field; null when absent or not a number. */
function numberField(body: unknown, key: string): number | null {
  const value = fieldOf(body, key);
  return typeof value === 'number' ? value : null;
}

function fieldOf(body: unknown, key: string): unknown {
  if (typeof body !== 'object' || body === null || !(key in body)) return undefined;
  return (body as Record<string, unknown>)[key];
}

const urisParam = (path: string): string[] =>
  (new URLSearchParams(path.split('?')[1] ?? '').get('uris') ?? '').split(',').filter(Boolean);

const writes = (calls: RecordedCall[]): RecordedCall[] =>
  calls.filter((c) => c.method !== 'GET');

describe('undo_mutation direction inversion', () => {
  it('undoes a library SAVE by deleting, when asked to execute', async () => {
    const { server, handlers } = stubServer();
    const { client, calls } = stubClient();
    registerUndoTools(server, client);

    const receipt = await issueReceipt(client, {
      kind: 'library',
      uris: ['spotify:track:a', 'spotify:track:b'],
      expectPresent: true,
    });
    assert.equal(receipt.direction, 'added');

    const out = await handlers.get('undo_mutation')!({ receipt_id: receipt.receipt_id, dry_run: false });
    assert.equal(out.structuredContent?.ok, true);
    assert.equal(out.structuredContent?.direction, 'added');
    assert.deepEqual(writes(calls).map((c) => `${c.method} ${c.path.split('?')[0]}`), ['DELETE /me/library']);
  });

  it('undoes a library REMOVAL by re-adding, when asked to execute', async () => {
    const { server, handlers } = stubServer();
    const { client, calls } = stubClient();
    registerUndoTools(server, client);

    const receipt = await issueReceipt(client, {
      kind: 'library',
      uris: ['spotify:track:a'],
      expectPresent: false,
    });
    assert.equal(receipt.direction, 'removed');

    const out = await handlers.get('undo_mutation')!({ receipt_id: receipt.receipt_id, dry_run: false });
    assert.equal(out.structuredContent?.ok, true);
    assert.equal(out.structuredContent?.inverted_to, 'add');
    assert.deepEqual(writes(calls).map((c) => `${c.method} ${c.path.split('?')[0]}`), ['PUT /me/library']);
  });

  it('previews by default and performs no write without dry_run: false', async () => {
    const { server, handlers } = stubServer();
    const { client, calls } = stubClient();
    registerUndoTools(server, client);

    const receipt = await issueReceipt(client, {
      kind: 'library',
      uris: ['spotify:track:a'],
      expectPresent: false,
    });
    const out = await handlers.get('undo_mutation')!({ receipt_id: receipt.receipt_id });
    assert.equal(out.structuredContent?.dry_run, true);
    assert.equal(writes(calls).length, 0);
    assert.match(out.content[0]!.text, /dry run/);
  });

  it('undoes a playlist add by removing its rows in chunks of 100', async () => {
    const { server, handlers } = stubServer();
    const { client, calls, playlists } = stubClient();
    registerUndoTools(server, client);

    // The add landed: the playlist really holds 150 rows now, so the receipt
    // records a row position for each and the undo has rows to target.
    const uris = Array.from({ length: 150 }, (_, i) => `spotify:track:${i}`);
    playlists.pl1 = [...uris];
    const receipt = await issueReceipt(client, { kind: 'playlist_items', id: 'pl1', uris, expectPresent: true });
    assert.equal(receipt.affected?.length, 150, 'receipt records the row each add created');

    const out = await handlers.get('undo_mutation')!({ receipt_id: receipt.receipt_id, dry_run: false });

    assert.equal(out.structuredContent?.ok, true);
    const dels = writes(calls).filter((c) => c.method === 'DELETE');
    assert.equal(dels.length, 2, 'expected two chunked deletes for 150 rows');
    assert.equal(dels[0]!.path, '/playlists/pl1/items');
    for (const del of dels) {
      const tracks = trackList(del.arg);
      assert.ok(tracks, `delete body must carry a tracks array, got ${JSON.stringify(del.arg)}`);
      for (const entry of tracks) {
        assert.ok(entry.positions.length > 0, 'undo must address rows by position, not by bare URI');
      }
    }
    assert.deepEqual(playlists.pl1, [], 'every added row removed');
  });

  it('redacts a failed first undo attempt with fixed counts', async () => {
    const { server, handlers } = stubServer();
    const { client } = stubClient();
    (client as unknown as { delete: () => Promise<never> }).delete = async () => {
      throw new Error('SENTINEL_UNDO https://example.test/raw?token=secret /home/alice/private.json', {
        cause: new Error('nested Spotify rejection'),
      });
    };
    registerUndoTools(server, client);
    const receipt = await issueReceipt(client, { kind: 'library', uris: ['spotify:track:a'], expectPresent: true });
    const out = await handlers.get('undo_mutation')!({ receipt_id: receipt.receipt_id, dry_run: false });
    assert.equal(out.structuredContent?.reason, 'partial_write_failure');
    assert.equal(out.structuredContent?.attempted_requests, 1);
    assert.equal(out.structuredContent?.completed_requests, 0);
    const publicText = JSON.stringify(out);
    for (const secret of ['SENTINEL_UNDO', 'token=secret', '/home/alice', 'nested Spotify rejection']) {
      assert.equal(publicText.includes(secret), false, `undo failure leaked ${secret}`);
    }
  });

  it('returns only fixed categories and counts after a partial undo', async () => {
    const { server, handlers } = stubServer();
    const { client } = stubClient();
    let deletes = 0;
    (client as unknown as { delete: () => Promise<null> }).delete = async () => {
      deletes++;
      if (deletes === 2) throw new Error('SENTINEL_UNDO_PARTIAL https://example.test/private?token=secret');
      return null;
    };
    registerUndoTools(server, client);
    const receipt = await issueReceipt(client, {
      kind: 'library',
      uris: Array.from({ length: 41 }, (_, index) => `spotify:track:${index}`),
      expectPresent: true,
    });
    const out = await handlers.get('undo_mutation')!({ receipt_id: receipt.receipt_id, dry_run: false });
    assert.equal(out.structuredContent?.ok, false);
    assert.equal(out.structuredContent?.reason, 'partial_write_failure');
    assert.equal(out.structuredContent?.completed_requests, 1);
    assert.equal(out.structuredContent?.attempted_requests, 2);
    const publicText = JSON.stringify(out);
    for (const secret of ['SENTINEL_UNDO_PARTIAL', 'token=secret', 'https://example.test']) {
      assert.equal(publicText.includes(secret), false, `partial undo leaked ${secret}`);
    }
  });
});

// ---------------------------------------------------------------------------
// #625 — occurrence-targeted undo and honest post-state reporting
// ---------------------------------------------------------------------------

describe('undo_mutation occurrence targeting (#625)', () => {
  it('removes only the row an add created when the URI was already present', async () => {
    const { server, handlers } = stubServer();
    const { client, calls, playlists } = stubClient();
    registerUndoTools(server, client);

    // Track X is already in the playlist at row 0; the add appends a second
    // copy at row 1. A bare-URI delete would take BOTH rows.
    playlists.pl1 = ['spotify:track:pre', 'spotify:track:x'];
    const receipt = await issueReceipt(client, {
      kind: 'playlist_items',
      id: 'pl1',
      uris: ['spotify:track:x'],
      expectPresent: true,
    });
    assert.deepEqual(receipt.affected, [{ uri: 'spotify:track:x', positions: [1] }]);

    const out = await handlers.get('undo_mutation')!({ receipt_id: receipt.receipt_id, dry_run: false });

    const del = writes(calls).find((c) => c.method === 'DELETE');
    assert.ok(del, 'expected a playlist delete');
    assert.deepEqual(del.arg, { tracks: [{ uri: 'spotify:track:x', positions: [1] }] },
      'the documented tracks shape, addressing the added row and not every occurrence');
    assert.deepEqual(playlists.pl1, ['spotify:track:pre'], 'the pre-existing row survives');
    assert.equal(out.structuredContent?.ok, true);
  });

  it('undoes a positional add without destroying the row that predated it', async () => {
    const { server, handlers } = stubServer();
    const { client, playlists } = stubClient();
    registerUndoTools(server, client);

    // [A, X, B] with X inserted at 0 -> [X, A, X, B]. Deriving the added row as
    // "X's last occurrence" would pick index 2, the X that predates the add,
    // and leave the added row behind. The 4-row playlist is entirely inside
    // the walk window, so only the insert position can distinguish the two.
    playlists.pl1 = ['spotify:track:x', 'spotify:track:a', 'spotify:track:x', 'spotify:track:b'];
    const receipt = await issueReceipt(client, {
      kind: 'playlist_items',
      id: 'pl1',
      uris: ['spotify:track:x'],
      insertPosition: 0,
    });
    assert.deepEqual(receipt.affected, [{ uri: 'spotify:track:x', positions: [0] }]);

    const out = await handlers.get('undo_mutation')!({ receipt_id: receipt.receipt_id, dry_run: false });
    assert.equal(out.structuredContent?.ok, true);
    assert.deepEqual(playlists.pl1, ['spotify:track:a', 'spotify:track:x', 'spotify:track:b'],
      'the pre-add ordering is restored exactly');
  });

  it('verifies a mixed add — one duplicate, one new — without a false alarm', async () => {
    const { server, handlers } = stubServer();
    const { client, playlists } = stubClient();
    registerUndoTools(server, client);

    // [X, A] plus an appended add of [X, Y] gives [X, A, X, Y]. Undoing
    // removes X's added row and Y's row, leaving [X, A, Y]: X is still
    // present because it predates the mutation, Y is absent. A single
    // expectPresent flag cannot express that — expecting presence flags Y as
    // missing, expecting absence flags X — so a correct rollback would be
    // reported as post_state_mismatch.
    playlists.pl1 = ['spotify:track:x', 'spotify:track:a', 'spotify:track:x', 'spotify:track:y'];
    const receipt = await issueReceipt(client, {
      kind: 'playlist_items',
      id: 'pl1',
      uris: ['spotify:track:x', 'spotify:track:y'],
    });

    const out = await handlers.get('undo_mutation')!({ receipt_id: receipt.receipt_id, dry_run: false });

    assert.equal(out.structuredContent?.ok, true, 'a correct rollback must not be reported as a mismatch');
    assert.deepEqual(out.structuredContent?.expected_present, ['spotify:track:x']);
    assert.deepEqual(out.structuredContent?.expected_absent, ['spotify:track:y']);
    // Back to the pre-add state: X's original row survives, while the X the
    // add appended and the newly added Y are both gone.
    assert.deepEqual(playlists.pl1, ['spotify:track:x', 'spotify:track:a']);
    assert.match(out.content[0]!.text, /1 URI\(s\) confirmed absent; 1 URI\(s\) confirmed present/);
  });

  it('refuses an add undo on a playlist beyond the walk window, sparing pre-existing rows', async () => {
    const { server, handlers } = stubServer();
    const { client, calls, playlists } = stubClient();
    registerUndoTools(server, client);

    // 600 rows: the walk sees 500, so the copy the add appended is off-window.
    // The last VISIBLE copy of x is the one that predates the add — undo must
    // not target it, which means refusing rather than guessing.
    const rows = Array.from({ length: 600 }, (_, i) => `spotify:track:r${i}`);
    rows[499] = 'spotify:track:x';
    playlists.pl1 = [...rows, 'spotify:track:x'];
    const receipt = await issueReceipt(client, {
      kind: 'playlist_items',
      id: 'pl1',
      uris: ['spotify:track:x'],
    });
    assert.equal(receipt.affected, undefined, 'no positions may be derived from a partial walk');

    const out = await handlers.get('undo_mutation')!({ receipt_id: receipt.receipt_id, dry_run: false });
    assert.equal(out.structuredContent?.ok, false);
    assert.equal(out.structuredContent?.reason, 'occurrences_unrecorded');
    assert.equal(writes(calls).length, 0);
    assert.equal(playlists.pl1.length, 601, 'the pre-existing row survives');
  });

  it('restores a targeted removal at its recorded position', async () => {
    const { server, handlers } = stubServer();
    const { client, calls, playlists } = stubClient();
    registerUndoTools(server, client);

    playlists.pl1 = ['spotify:track:a', 'spotify:track:b', 'spotify:track:c'];
    // Remove row 1 (track b) by position.
    await issueReceipt(client, {
      kind: 'playlist_items',
      id: 'pl1',
      uris: ['spotify:track:b'],
      expectPresent: false,
      targetedPositions: [{ uri: 'spotify:track:b', position: 1 }],
    });
    playlists.pl1 = ['spotify:track:a', 'spotify:track:c'];

    const out = await handlers.get('undo_last_mutation')!({ dry_run: false });
    assert.equal(out.structuredContent?.ok, true);
    const post = writes(calls).find((c) => c.method === 'POST');
    assert.ok(post, 'expected a re-add');
    assert.deepEqual(post.arg, { uris: ['spotify:track:b'], position: 1 },
      'the row goes back where it was, not appended');
    assert.deepEqual(playlists.pl1, ['spotify:track:a', 'spotify:track:b', 'spotify:track:c']);
  });

  it('refuses an add undo when the receipt records no row positions', async () => {
    const { server, handlers } = stubServer();
    const { client, calls, playlists } = stubClient();
    registerUndoTools(server, client);

    // A receipt that cannot say which row the add created (pre-#625 receipt, or
    // rows beyond the verification window) must not fall back to a bare-URI
    // delete, which would remove pre-existing rows.
    playlists.pl1 = ['spotify:track:x', 'spotify:track:other'];
    const receipt = await issueReceipt(client, { kind: 'playlist_items', id: 'pl1', uris: [], expectPresent: true });
    receipt.uris = ['spotify:track:x'];
    delete receipt.affected;

    const out = await handlers.get('undo_mutation')!({ receipt_id: receipt.receipt_id, dry_run: false });

    assert.equal(out.structuredContent?.ok, false);
    assert.equal(out.structuredContent?.reason, 'occurrences_unrecorded');
    assert.equal(writes(calls).length, 0, 'a refused undo issues zero writes');
    assert.deepEqual(playlists.pl1, ['spotify:track:x', 'spotify:track:other']);
  });

  it('marks a pre-#625 receipt as direction_assumed instead of silently adding', async () => {
    const { server, handlers } = stubServer();
    const { client, saved } = stubClient();
    registerUndoTools(server, client);
    saved.add('spotify:track:a');

    const receipt = await issueReceipt(client, { kind: 'library', uris: ['spotify:track:a'], expectPresent: true });
    delete receipt.direction; // as written by a v1 build

    const preview = await handlers.get('undo_mutation')!({ receipt_id: receipt.receipt_id });
    assert.equal(preview.structuredContent?.direction_assumed, true);
    assert.match(preview.content[0]!.text, /assumed, not recorded/);

    const out = await handlers.get('undo_mutation')!({ receipt_id: receipt.receipt_id, dry_run: false });
    assert.equal(out.structuredContent?.direction_assumed, true);
  });

  it('reports the post-state mismatch instead of claiming N URIs were inverted', async () => {
    const { server, handlers } = stubServer();
    const { client, saved } = stubClient();
    registerUndoTools(server, client);
    saved.add('spotify:track:a');
    // The delete returns 200 but leaves the item in the library.
    (client as unknown as { delete: () => Promise<null> }).delete = async () => null;

    const receipt = await issueReceipt(client, { kind: 'library', uris: ['spotify:track:a'], expectPresent: true });
    const out = await handlers.get('undo_mutation')!({ receipt_id: receipt.receipt_id, dry_run: false });

    assert.equal(out.structuredContent?.ok, false);
    assert.equal(out.structuredContent?.reason, 'post_state_mismatch');
    assert.deepEqual(out.structuredContent?.unconfirmed_uris, ['spotify:track:a']);
    assert.doesNotMatch(out.content[0]!.text, /inverted 1 URI/);
    assert.match(out.content[0]!.text, /did NOT confirm: spotify:track:a/);
    assert.deepEqual(out.structuredContent?.expected_absent, ['spotify:track:a']);
  });

  it('chunk-writes a 41-URI library undo at the documented 40-uri cap, encoded', async () => {
    const { server, handlers } = stubServer();
    const { client, calls, saved } = stubClient();
    registerUndoTools(server, client);
    const uris = Array.from({ length: 41 }, (_, i) => `spotify:track:${i}`);
    for (const uri of uris) saved.add(uri);
    const receipt = await issueReceipt(client, { kind: 'library', uris, expectPresent: true });

    await handlers.get('undo_mutation')!({ receipt_id: receipt.receipt_id, dry_run: false });

    const dels = writes(calls).filter((c) => c.method === 'DELETE' && c.path.startsWith('/me/library?'));
    assert.equal(dels.length, 2, '41 uris need 2 requests at the 40-uri cap');
    for (const del of dels) {
      const sent = new URLSearchParams(del.path.split('?')[1] ?? '').get('uris') ?? '';
      assert.ok(sent.split(',').length <= 40, 'no request may exceed the 40-uri write cap');
    }
    assert.equal(saved.size, 0, 'every saved URI is removed');
  });
});

describe('undo confirmation gate (#627)', () => {
  afterEach(() => {
    delete process.env.SPOTIFY_MCP_CONFIRM;
  });

  /**
   * A REAL McpServer + Client over InMemoryTransport: the only harness that
 * can show the gate reaching the connected client's advertised capabilities
   * rather than a hand-rolled stand-in.
   */
  async function wiredServer(advertiseElicitation: boolean) {
    const server = new McpServer({ name: 'undo-gate-test', version: '0.0.0' });
    const { client: spotify, calls } = stubClient();
    registerUndoTools(server, spotify);
    const prompts: unknown[] = [];
    const client = new Client(
      { name: 'undo-gate-client', version: '0.0.0' },
      advertiseElicitation ? { capabilities: { elicitation: { form: {} } } } : {},
    );
    if (advertiseElicitation) {
      client.setRequestHandler(ElicitRequestSchema, async (request) => {
        prompts.push(request.params);
        return { action: 'accept' as const, content: { confirm: true } };
      });
    }
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { client, calls, prompts, spotify, close: () => Promise.all([client.close(), server.close()]) };
  }

  it('makes ZERO writes when the client cannot prompt, even with dry_run: false', async () => {
    const harness = await wiredServer(false);
    try {
      const receipt = await issueReceipt(harness.spotify, {
        kind: 'library',
        uris: ['spotify:track:a', 'spotify:track:b'],
        expectPresent: true,
      });
      const before = harness.calls.length;
      const res = await harness.client.callTool({
        name: 'undo_mutation',
        arguments: { receipt_id: receipt.receipt_id, dry_run: false },
      });
      const structured = res.structuredContent as Record<string, unknown>;
      assert.equal(structured.reason, 'confirmation_unavailable');
      assert.equal(structured.ok, false);
      // The point of the regression: the rollback is genuinely unissued, not
      // merely reported as cancelled.
      assert.deepEqual(writes(harness.calls.slice(before)), []);
    } finally {
      await harness.close();
    }
  });

  it('undo_last_mutation also writes nothing when the client cannot prompt', async () => {
    const harness = await wiredServer(false);
    try {
      await issueReceipt(harness.spotify, {
        kind: 'library',
        uris: ['spotify:track:a'],
        expectPresent: true,
      });
      const before = harness.calls.length;
      const res = await harness.client.callTool({ name: 'undo_last_mutation', arguments: { dry_run: false } });
      const structured = res.structuredContent as Record<string, unknown>;
      assert.equal(structured.reason, 'confirmation_unavailable');
      assert.deepEqual(writes(harness.calls.slice(before)), []);
    } finally {
      await harness.close();
    }
  });

  it('executes the rollback once the connected client confirms', async () => {
    const harness = await wiredServer(true);
    try {
      const receipt = await issueReceipt(harness.spotify, {
        kind: 'library',
        uris: ['spotify:track:a'],
        expectPresent: true,
      });
      const before = harness.calls.length;
      const res = await harness.client.callTool({
        name: 'undo_mutation',
        arguments: { receipt_id: receipt.receipt_id, dry_run: false },
      });
      assert.equal((res.structuredContent as Record<string, unknown>).ok, true);
      assert.deepEqual(writes(harness.calls.slice(before)).map((c) => `${c.method} ${c.path.split('?')[0]}`), ['DELETE /me/library']);
      assert.equal(harness.prompts.length, 1, 'expected exactly one confirmation prompt');
    } finally {
      await harness.close();
    }
  });

  it('publishes dry_run as defaulting to true, and previews without prompting', async () => {
    const harness = await wiredServer(false);
    try {
      // The handler treats a missing dry_run as a preview either way, so the
      // advertised default is the only place the contract is observable.
      const listed = await harness.client.listTools();
      for (const name of ['undo_mutation', 'undo_last_mutation']) {
        const tool = listed.tools.find((t) => t.name === name);
        const dryRun = (tool?.inputSchema as { properties?: { dry_run?: { default?: unknown } } } | undefined)
          ?.properties?.dry_run;
        assert.equal(dryRun?.default, true, `${name} must advertise dry_run default: true`);
      }

      const receipt = await issueReceipt(harness.spotify, {
        kind: 'library',
        uris: ['spotify:track:a'],
        expectPresent: true,
      });
      const res = await harness.client.callTool({
        name: 'undo_mutation',
        arguments: { receipt_id: receipt.receipt_id },
      });
      assert.equal((res.structuredContent as Record<string, unknown>).dry_run, true);
      assert.equal(harness.prompts.length, 0);
    } finally {
      await harness.close();
    }
  });
});
