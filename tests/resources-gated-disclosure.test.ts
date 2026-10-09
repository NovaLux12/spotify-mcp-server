/**
 * Tests for #1677 — two resource renderers discarded the gated-403 disclosure.
 *
 * `src/resources/index.ts` has one canonical pattern for a gated read failure,
 * in the shared `renderWithApiErrors` helper: compute `gatedResourceResult`,
 * `if (result) return result;`, else `throw error`. The saved-audiobooks and
 * genre-heatmap renderers computed the result and never returned it, so a
 * 403/404/429 on either resource threw raw instead of serving the disclosure
 * the server promises for gated endpoints (AGENTS.md §2, #931).
 *
 * Every test below drives the real MCP SDK over `InMemoryTransport` with a
 * stub client whose walk throws, so the assertion is on what a host receives.
 * The two 403 tests are the regression pair: they assert the INNER subject
 * text (`Genre data ...`, `Audiobook data ...`), which only the fixed inner
 * block serves — pre-fix the same reads resolve with the outer wrapper's
 * resource-key text instead.
 * The 500 test guards the adjacent path, and says so: `gatedResourceResult`
 * returns null off the 403/404/429 set, and those errors must still fail
 * loudly rather than degrade into prose. It passes with and without this fix;
 * it exists so a future edit to these catch blocks cannot quietly turn a 500
 * into a disclosure.
 *
 * These tests fail without the fix by construction: pre-fix, the 403 reads
 * resolve with the OUTER wrapper's disclosure (`genre-heatmap is unavailable
 * ...`), so any assertion on the inner subject text fails. Verified by
 * stashing the src change and re-running: the two 403 tests fail, the 500
 * test passes (it pins the adjacent null path, not this change).
 */
import './helpers/hermetic.js';
import './helpers/hermetic.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

import { registerReadSurfaces } from '../src/resources/register.js';
import { SpotifyApiError, type SpotifyClient } from '../src/client.js';

function throwingClient(status: number): SpotifyClient {
  // The message carries the status so the 500-case matcher below confirms the
  // rejection is OUR error surfacing through the SDK (`MCP error -32603: ...`),
  // not some other failure. What the test pins is the rejection itself —
  // a 500 must throw rather than degrade into prose.
  const stub = {
    get: async () => {
      throw new SpotifyApiError(status, `Spotify ${status}`);
    },
    getAllPages: async () => [],
    getAllPagesWithTruncation: async () => {
      throw new SpotifyApiError(status, `Spotify ${status}`);
    },
    getRateLimitStatus: () => ({
      lastThrottleAt: null as number | null,
      retryAfterSec: null as number | null,
      cooldownRemainingMs: 0,
    }),
  };
  return stub as unknown as SpotifyClient;
}

async function connect(client: SpotifyClient): Promise<Client> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerReadSurfaces(server, client);
  const mcpClient = new Client({ name: 'tester', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(clientTransport), mcpClient.connect(serverTransport)]);
  return mcpClient;
}

function textOf(result: ReadResourceResult): string {
  const first = result.contents[0];
  assert.ok(first, 'readResource returned no content blocks');
  assert.ok('text' in first, `expected a text content block, got ${JSON.stringify(first)}`);
  return first.text;
}

test('saved-audiobooks: a 403 serves the subject disclosure (#1677)', async () => {
  const mcp = await connect(throwingClient(403));
  const text = textOf(await mcp.readResource({ uri: 'spotify://me/saved/audiobooks' }));
  assert.match(text, /Audiobook data is unavailable in this market or OAuth scope \(403\)/);
});

test('genre-heatmap: a 403 serves the subject disclosure (#1677)', async () => {
  const mcp = await connect(throwingClient(403));
  const text = textOf(await mcp.readResource({ uri: 'spotify://me/genre-heatmap' }));
  assert.match(text, /Genre data is unavailable in this market or OAuth scope \(403\)/);
});

test('a non-gated status still fails loudly on both resources (#1677)', async () => {
  for (const uri of ['spotify://me/saved/audiobooks', 'spotify://me/genre-heatmap']) {
    const mcp = await connect(throwingClient(500));
    await assert.rejects(
      mcp.readResource({ uri }),
      /500/,
      `${uri} must throw a 500 rather than degrade it into prose`,
    );
  }
});
