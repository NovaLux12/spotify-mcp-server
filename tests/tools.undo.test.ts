/**
 * Tests for src/tools/undo.ts — direction-aware undo (#625).
 *
 * Regression: undo used to hard-code `DELETE /me/library`, so undoing a removal
 * re-removed (and reported success). These tests pin the inversion direction and
 * the dry-run default. No network, no token file access.
 *
 * Run: node --import tsx --test tests/tools.undo.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { issueReceipt } from '../src/receipts.js';
import { registerUndoTools } from '../src/tools/undo.js';

interface RecordedCall {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  arg?: unknown;
}

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> }>;

function stubServer(): { server: McpServer; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const server = {
    tool(name: string, _description: string, _schema: unknown, handler: Handler) {
      handlers.set(name, handler);
      return { name };
    },
  } as unknown as McpServer;
  return { server, handlers };
}

function stubClient(): { client: SpotifyClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const client = {
    async get(path: string): Promise<unknown> {
      calls.push({ method: 'GET', path });
      // Every verification fetch "succeeds" but reports nothing present; the
      // receipt is still issued, which is all undo needs.
      return {};
    },
    async post(path: string, arg?: unknown): Promise<unknown> {
      calls.push({ method: 'POST', path, arg });
      return { snapshot_id: 'snap-post' };
    },
    async put(path: string, arg?: unknown): Promise<unknown> {
      calls.push({ method: 'PUT', path, arg });
      return null;
    },
    async delete(path: string, arg?: unknown): Promise<unknown> {
      calls.push({ method: 'DELETE', path, arg });
      return { snapshot_id: 'snap-delete' };
    },
  } as unknown as SpotifyClient;
  return { client, calls };
}

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

  it('undoes a playlist add by removing items in chunks of 100', async () => {
    const { server, handlers } = stubServer();
    const { client, calls } = stubClient();
    registerUndoTools(server, client);

    const uris = Array.from({ length: 150 }, (_, i) => `spotify:track:${i}`);
    const receipt = await issueReceipt(client, { kind: 'playlist_items', id: 'pl1', uris, expectPresent: true });
    const out = await handlers.get('undo_mutation')!({ receipt_id: receipt.receipt_id, dry_run: false });

    assert.equal(out.structuredContent?.ok, true);
    const dels = writes(calls).filter((c) => c.method === 'DELETE');
    assert.equal(dels.length, 2, 'expected two chunked deletes for 150 URIs');
    assert.equal(dels[0]!.path, '/playlists/pl1/items');
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
