/**
 * SDK-level cancellation for #676: a real `notifications/cancelled` against an
 * in-flight multi-page `tools/call`.
 *
 * The client-layer tests in `tests/cancellation.test.ts` cover the walk loop
 * and the client directly. They cannot prove the third layer — that the MCP
 * SDK's own `notifications/cancelled` actually reaches the walk — because they
 * never build a protocol session. This file does, and it is the acceptance
 * criterion from the issue stated verbatim: "a `notifications/cancelled` for an
 * in-flight multi-page `tools/call` stops additional page requests within one
 * page and returns an error mentioning cancellation (assert through a stub
 * counting fetches)."
 *
 * Production `installCancellationContextBoundary` runs on a real `McpServer`
 * connected to a real `Client` over `InMemoryTransport`, so the abort path is
 * the SDK's: `_oncancel` -> the per-request `AbortController` -> `extra.signal`
 * -> the ambient context -> the client's walk. Nothing here reaches into the
 * plumbing by hand.
 *
 * The assertion is the FETCH COUNT, not the error's shape. A handler that sets
 * a "cancelled" flag and keeps walking passes an isError check and still burns
 * the quota, which is the failure the issue describes.
 *
 * Run with: node --import tsx --test tests/cancellation-sdk.test.ts
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

const tokenDir = await mkdtemp(path.join(tmpdir(), 'spotify-mcp-cancel-sdk-'));
process.env.SPOTIFY_MCP_TOKEN_FILE = path.join(tokenDir, 'tokens.json');
process.env.SPOTIFY_CLIENT_ID = 'cancel-sdk-client';
process.env.SPOTIFY_MCP_FETCH_ALL_CAP = '100000';

const { SpotifyClient } = await import('../src/client.ts');
const { installCancellationContextBoundary } = await import('../src/cancellation.ts');
const { installTruncationBoundary } = await import('../src/shaping.ts');
const { installToolErrorBoundary } = await import('../src/tools/annotations.ts');
const { initConfig } = await import('../src/config.ts');

initConfig();

const realFetch = globalThis.fetch;

/** Pages the stub would serve if nothing stopped the walk. */
const TOTAL_PAGES = 30;
const PER_PAGE = 10;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function abortError(): Error {
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
}

/** Offsets the stub actually served a request for. */
let served: number[] = [];

async function seedTokens(): Promise<void> {
  await writeFile(
    process.env.SPOTIFY_MCP_TOKEN_FILE!,
    JSON.stringify({
      access_token: 'tok-initial',
      refresh_token: 'ref-initial',
      expires_at: Date.now() + 3_600_000,
      scope: '',
    }),
    'utf8',
  );
}

interface Harness {
  client: Client;
  /** Fetches the stub served, counted at dispatch. */
  servedCount: () => number;
  cleanup: () => Promise<void>;
}

/**
 * A server whose one tool walks `/me/tracks` to completion, wired with the
 * production cancellation boundary, the truncation boundary, and the real tool
 * error boundary — so a cancelled walk is mapped to the same public envelope
 * every other failure gets, rather than a bespoke path.
 */
async function bootstrap(): Promise<Harness> {
  const spotify = new SpotifyClient({ disableCache: true, maxConcurrency: 4 });
  const server = new McpServer({ name: 'cancel-test', version: '0.0.0' });
  installCancellationContextBoundary(server);
  installTruncationBoundary(server);

  server.tool(
    'walk_saved_tracks',
    'Walks /me/tracks page by page (#676 fixture).',
    {},
    async () => {
      const rows = await spotify.getAllPages<{ id: number }>('/me/tracks');
      return { content: [{ type: 'text' as const, text: `walked ${rows.length}` }] };
    },
  );

  // Installed AFTER registration, matching src/index.ts: the error boundary
  // replaces the SDK's tools/call handler and asserts the tools capability,
  // which only exists once a tool has registered.
  installToolErrorBoundary(server);

  const mcpClient = new Client({ name: 'cancel-test-client', version: '0.0.0' });
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTx), mcpClient.connect(clientTx)]);

  return {
    client: mcpClient,
    servedCount: () => served.length,
    cleanup: async () => {
      await mcpClient.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}

describe('#676 SDK-level cancellation', () => {
  before(async () => {
    await seedTokens();
  });

  beforeEach(async () => {
    served = [];
    await rm(process.env.SPOTIFY_MCP_TOKEN_FILE!, { force: true });
    await seedTokens();
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const href = String(url);
      if (href.startsWith('https://accounts.spotify.com/')) {
        return jsonResponse({ access_token: 'tok', expires_in: 3600, token_type: 'Bearer' });
      }
      const offset = Number(new URL(href).searchParams.get('offset') ?? 0);
      // Counted on dispatch, and the abort is honoured, so the stub models a
      // real fetch: a cancelled in-flight request rejects rather than
      // resolving, and a dispatched one is spent whether or not it answers.
      if (offset < TOTAL_PAGES * PER_PAGE) served.push(offset);
      if (init?.signal?.aborted) throw abortError();
      return jsonResponse({
        items: Array.from({ length: PER_PAGE }, (_, i) => ({ id: offset + i })),
        total: TOTAL_PAGES * PER_PAGE,
        limit: PER_PAGE,
        offset,
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  after(async () => {
    await rm(tokenDir, { recursive: true, force: true });
  });

  it('an uncancelled call walks every page and returns a clean result', async () => {
    const { client, servedCount, cleanup } = await bootstrap();
    try {
      const result = await client.callTool({ name: 'walk_saved_tracks', arguments: {} });
      assert.notEqual(result.isError, true, `unexpected failure: ${JSON.stringify(result.content)}`);
      assert.equal(servedCount(), TOTAL_PAGES, 'an uncancelled walk issues one request per page');
    } finally {
      await cleanup();
    }
  });

  it('a notifications/cancelled stops the walk: the fetch count stops growing', async () => {
    const { client, servedCount, cleanup } = await bootstrap();
    try {
      // Aborting the CLIENT-side signal is what makes the SDK send a
      // `notifications/cancelled` (shared/protocol.js: the abort listener on
      // `options.signal` calls `cancel()`), and the server's `_oncancel` then
      // aborts the per-request controller that `extra.signal` carries. So this
      // exercises the real protocol path, not a hand-rolled abort.
      const controller = new AbortController();
      const pending = client.callTool(
        { name: 'walk_saved_tracks', arguments: {} },
        undefined,
        { signal: controller.signal },
      );
      // Let the walk get going first; a cancellation before the first page
      // would prove only the already-aborted path, not the in-flight one.
      for (let i = 0; i < 400 && servedCount() < 3; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.ok(servedCount() >= 3, `the walk must be in flight before cancelling, saw ${servedCount()}`);

      controller.abort();
      // The client rejects its own call as soon as it cancels; that says
      // nothing about what the SERVER did, which is what is under test.
      await pending.then(() => undefined, () => undefined);

      const atCancel = servedCount();
      await new Promise((r) => setTimeout(r, 300));

      // The load-bearing assertion. Everything else in this file is shape;
      // this is the proof that the walk actually stopped doing work.
      assert.equal(
        servedCount(),
        atCancel,
        `the walk kept issuing requests after cancellation: ${atCancel} -> ${servedCount()}`,
      );
      assert.ok(
        servedCount() < TOTAL_PAGES,
        `the walk must not run to completion: ${servedCount()} of ${TOTAL_PAGES}`,
      );
    } finally {
      await cleanup();
    }
  });

  it('the cancellation is observable as cancellation, not as a completed walk', async () => {
    const { client, servedCount, cleanup } = await bootstrap();
    try {
      const controller = new AbortController();
      const pending = client.callTool(
        { name: 'walk_saved_tracks', arguments: {} },
        undefined,
        { signal: controller.signal },
      );
      for (let i = 0; i < 400 && servedCount() < 3; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      controller.abort();

      const settled = await pending.then(
        (r) => ({ ok: true, result: r } as const),
        (e: unknown) => ({ ok: false, thrown: String(e) } as const),
      );

      if (settled.ok) {
        // If the SDK ever races the server's response ahead of the abort, the
        // result must at least be a classified FAILURE. A successful result
        // would be a host handed a completed walk it had already cancelled.
        const result = settled.result as { isError?: unknown; content?: unknown };
        assert.equal(
          result.isError,
          true,
          `a cancelled call must not report success: ${JSON.stringify(result).slice(0, 300)}`,
        );
        assert.match(
          JSON.stringify(result),
          /cancel/i,
          'the error result must name cancellation so a host can tell its own cancel from a fault',
        );
      } else {
        // The usual outcome: the SDK rejects the client-side call the moment
        // it cancels, so the server's mapped result never reaches this client.
        assert.match(
          settled.thrown,
          /cancel|abort|closed/i,
          `cancellation must be recognisable: ${settled.thrown.slice(0, 300)}`,
        );
      }
      assert.ok(
        servedCount() < TOTAL_PAGES,
        `the walk must not run to completion: ${servedCount()} of ${TOTAL_PAGES}`,
      );
    } finally {
      await cleanup();
    }
  });
});
