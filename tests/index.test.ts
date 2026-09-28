/**
 * Tests for `src/index.ts`'s progress-token wiring (#728).
 *
 * Background — OpenClaw, the primary host for v2, sees 35+ `notifications/
 * progress` frames on a single `export_all_playlists {include_items:true}`
 * call against a 33-playlist account. Its line-oriented parser reads those
 * frames as if they were the final JSON-RPC result. The fix:
 *
 *   1. The reporter must only fire when the caller supplied a
 *      `progressToken` in `request.params._meta.progressToken`.
 *   2. When it does fire, it echoes the caller's token, not a server-
 *      invented counter.
 *   3. The JSON-RPC result is the last frame on the wire.
 *
 * These tests run the production `installProgressContextBoundary` +
 * `installProgressNotifications` (both from `src/progress.ts`) on a
 * McpServer connected to a real Client through `InMemoryTransport`. The
 * tool under test calls `SpotifyClient.getAllPages` against a mocked
 * fetch, so the notification stream is fully observable end-to-end.
 */
import './helpers/hermetic.js';

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ProgressNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

// ---------------------------------------------------------------------------
// Env setup MUST precede any token read (getTokenFilePath() resolves per call)
// ---------------------------------------------------------------------------
const tokenDir = await mkdtemp(path.join(tmpdir(), 'spotify-mcp-index-test-'));
process.env.SPOTIFY_MCP_TOKEN_FILE = path.join(tokenDir, 'tokens.json');
process.env.SPOTIFY_CLIENT_ID = 'test-client-id';

const { SpotifyClient } = await import('../src/client.ts');
const { installTruncationBoundary } = await import('../src/shaping.ts');
const {
  installProgressContextBoundary,
  installProgressNotifications,
  currentProgressToken,
} = await import('../src/progress.ts');

interface FetchCall {
  url: string;
  init: RequestInit;
}

let calls: FetchCall[] = [];
let responder: (url: string, init: RequestInit) => Response = () =>
  new Response(JSON.stringify({}), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
const realFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

function isAccountsUrl(url: string): boolean {
  return url.startsWith('https://accounts.spotify.com/');
}

async function seedTokens(): Promise<void> {
  const tokens = {
    access_token: 'tok-initial',
    refresh_token: 'ref-initial',
    expires_at: Date.now() + 3_600_000,
  };
  await writeFile(process.env.SPOTIFY_MCP_TOKEN_FILE!, JSON.stringify(tokens), 'utf8');
}

before(async () => {
  await seedTokens();
});

beforeEach(() => {
  calls = [];
  responder = () => jsonResponse({});
  globalThis.fetch = (async (url: unknown, init: RequestInit = {}) => {
    const call: FetchCall = { url: String(url), init };
    calls.push(call);
    return responder(call.url, call.init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

after(async () => {
  await rm(tokenDir, { recursive: true, force: true });
});

/** Three-page walk responder: 3 pages -> 2 progress events. */
function threePageResponder(url: string): Response {
  if (isAccountsUrl(url)) return jsonResponse({});
  const offset = Number(new URL(url).searchParams.get('offset') ?? 0);
  return jsonResponse({ items: [{ id: offset }], total: 3, limit: 1, offset });
}

/**
 * Wire the production boundaries around a McpServer + SpotifyClient and
 * attach it to a Client via InMemoryTransport. The tool that gets
 * registered walks `/me/tracks` so the reporter fires for every page.
 */
async function bootstrap(): Promise<{
  client: Client;
  cleanup: () => Promise<void>;
}> {
  const spotify = new SpotifyClient();

  const server = new McpServer({ name: 'progress-test', version: '0.0.0' });
  installProgressContextBoundary(server);
  installTruncationBoundary(server);
  installProgressNotifications(spotify, server);

  server.tool(
    'walk_saved_tracks',
    'Walks /me/tracks and emits one progress event per page (#728 fixture).',
    {},
    async () => {
      const rows = await spotify.getAllPages<{ id: number }>('/me/tracks');
      return {
        content: [{ type: 'text' as const, text: `walked ${rows.length}` }],
      };
    },
  );

  const mcpClient = new Client({ name: 'progress-test-client', version: '0.0.0' });
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTx), mcpClient.connect(clientTx)]);

  return {
    client: mcpClient,
    cleanup: async () => {
      await mcpClient.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}

describe('progress-token wiring (#728)', () => {
  it('emits no notifications when the caller did not supply a progressToken', async () => {
    responder = threePageResponder;
    const { client, cleanup } = await bootstrap();
    const captured: unknown[] = [];
    // A block body, not `(n) => captured.push(n)`: the handler's declared
    // return is `void | Promise<void>`, and an expression body hands it
    // `push`'s number. Same capture, no number leaking out as a result.
    client.setNotificationHandler(ProgressNotificationSchema, (n) => { captured.push(n); });
    try {
      const result = await client.callTool({ name: 'walk_saved_tracks', arguments: {} });
      assert.equal(result.isError, undefined);
      assert.deepEqual(captured, [], 'no progress notifications must reach a caller that did not opt in');
    } finally {
      await cleanup();
    }
  });

  it("echoes the caller's progressToken verbatim on every notification", async () => {
    responder = threePageResponder;
    const { client, cleanup } = await bootstrap();
    const captured: Array<{ progressToken: unknown; progress: unknown; total?: unknown }> = [];
    client.setNotificationHandler(ProgressNotificationSchema, (n) => {
      const params = (n as { params?: { progressToken: unknown; progress: unknown; total?: unknown } }).params;
      captured.push({
        progressToken: params?.progressToken,
        progress: params?.progress,
        total: params?.total,
      });
    });
    try {
      await client.callTool({
        name: 'walk_saved_tracks',
        arguments: {},
        _meta: { progressToken: 'caller-supplied-token-42' },
      });
      assert.equal(captured.length, 3, 'one progress frame per fetched page (3 pages -> 3 events)');
      for (const frame of captured) {
        assert.equal(
          frame.progressToken,
          'caller-supplied-token-42',
          'caller-supplied token must echo verbatim, not a server-invented counter',
        );
        assert.equal(frame.total, 3, 'server-reported total forwarded');
      }
      assert.deepEqual(captured.map((f) => f.progress), [1, 2, 3]);
    } finally {
      await cleanup();
    }
  });

  it('accepts integer progressTokens as the MCP spec allows', async () => {
    responder = (url) => {
      if (isAccountsUrl(url)) return jsonResponse({});
      const offset = Number(new URL(url).searchParams.get('offset') ?? 0);
      return jsonResponse({ items: [{ id: offset }], total: 1, limit: 1, offset });
    };
    const { client, cleanup } = await bootstrap();
    const captured: Array<{ progressToken: unknown }> = [];
    client.setNotificationHandler(ProgressNotificationSchema, (n) => {
      const params = (n as { params?: { progressToken: unknown } }).params;
      captured.push({ progressToken: params?.progressToken });
    });
    try {
      await client.callTool({
        name: 'walk_saved_tracks',
        arguments: {},
        _meta: { progressToken: 7 },
      });
      assert.equal(captured.length, 1, 'one page -> one frame');
      assert.equal(captured[0].progressToken, 7, 'integer token echoes verbatim');
    } finally {
      await cleanup();
    }
  });

  it('keeps the JSON-RPC result as the last frame', async () => {
    responder = (url) => {
      if (isAccountsUrl(url)) return jsonResponse({});
      const offset = Number(new URL(url).searchParams.get('offset') ?? 0);
      return jsonResponse({ items: [{ id: offset }], total: 4, limit: 1, offset });
    };

    const spotify = new SpotifyClient();
    const server = new McpServer({ name: 'progress-order-test', version: '0.0.0' });
    installProgressContextBoundary(server);
    installTruncationBoundary(server);
    installProgressNotifications(spotify, server);

    server.tool(
      'walk_saved_tracks_4',
      'four-page walk fixture',
      {},
      async () => {
        const rows = await spotify.getAllPages<{ id: number }>('/me/tracks');
        return { content: [{ type: 'text' as const, text: `walked ${rows.length}` }] };
      },
    );

    const mcpClient = new Client({ name: 'progress-order-client', version: '0.0.0' });
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTx), mcpClient.connect(clientTx)]);

    // Observe every JSON-RPC frame the server writes, in order, by wrapping
    // the in-memory transport's `send`. The original send still runs so the
    // Client's `callTool` resolves — we only record the order.
    const low = server.server as unknown as {
      _transport: { send: (msg: unknown) => Promise<void> };
    };
    const origSend = low._transport.send.bind(low._transport);
    const order: string[] = [];
    low._transport.send = async (msg: unknown) => {
      const m = msg as { id?: unknown; method?: unknown };
      if (typeof m.id !== 'undefined') order.push('result');
      else if (m.method === 'notifications/progress') order.push('progress');
      else if (typeof m.method === 'string') order.push(`notify:${m.method}`);
      else order.push('other');
      await origSend(msg);
    };

    const captured: unknown[] = [];
    mcpClient.setNotificationHandler(ProgressNotificationSchema, (n) => { captured.push(n); });
    try {
      await mcpClient.callTool({
        name: 'walk_saved_tracks_4',
        arguments: {},
        _meta: { progressToken: 'order-test-token' },
      });
      assert.equal(captured.length, 4, 'four pages -> four progress frames');
      assert.deepEqual(
        order,
        ['progress', 'progress', 'progress', 'progress', 'result'],
        'every progress frame precedes the JSON-RPC result',
      );
    } finally {
      await mcpClient.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
});

describe('progress module internals (#728)', () => {
  it('currentProgressToken returns undefined outside a tool invocation', () => {
    assert.equal(currentProgressToken(), undefined);
  });
});