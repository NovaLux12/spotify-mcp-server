/**
 * #1628 follow-on: a token store `isTokenData` REJECTS must not be reported as
 * an internal defect.
 *
 * Found on the live instance 2026-10-01, not by reading the code. A
 * `logout-quarantine` event had left `tokens.json` holding only `refresh_token`
 * and `expires_at` — no `access_token`. `loadTokens` refused it and threw the
 * one message that actually fixes it:
 *
 *     Saved Spotify tokens are corrupted at <path> — run `npm run auth` again.
 *
 * `publicFailure` had no arm for a token store it could not READ, so that
 * instruction fell through to the `internal` fallback:
 *
 *     kind=internal status=none reason=internal_error
 *     → "search failed unexpectedly; retry once and inspect protected server
 *        diagnostics if it persists."
 *
 * Every clause of that advice is wrong here. The failure is deterministic, so
 * retrying cannot help; waiting cannot help; and "protected server diagnostics"
 * is where an operator goes to read a log line, when the fix is one command the
 * message had already named. The caller was sent to debug a server bug for what
 * is a missing credential.
 *
 * This is the AGENTS.md §1 "do not replace it with a blanket claim" shape, in the
 * direction where a blanket claim costs the user the fix.
 */
import './helpers/hermetic.js';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Env MUST be set before any token read: getTokenFilePath() resolves per call.
const tokenDir = await mkdtemp(path.join(tmpdir(), 'spotify-mcp-tokenstore-class-'));
process.env.SPOTIFY_MCP_TOKEN_FILE = path.join(tokenDir, 'tokens.json');

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { SpotifyClient } = await import('../src/client.js');
const { installToolErrorBoundary } = await import('../src/tools/annotations.js');

interface ErrorEnvelope {
  tool: string;
  kind: string;
  status?: number;
  reason: string;
  fix: string;
}

const originalConsoleError = console.error;
console.error = () => {};

let closeHarness: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeHarness?.();
  closeHarness = undefined;
  console.error = originalConsoleError;
});

/**
 * The real shape found on the instance: a `logout-quarantine` leaves the two
 * fields that survive a logout and drops `access_token`. `isTokenData` requires
 * all three, so `loadTokens` throws before the refresh path is ever reached —
 * which is why this reproduces with NO network stub at all. The bug is not a
 * refresh bug, and a test that stubbed the token endpoint would miss that.
 */
async function seedUnreadableTokenStore(): Promise<void> {
  await writeFile(
    process.env.SPOTIFY_MCP_TOKEN_FILE as string,
    JSON.stringify({
      refresh_token: 'ref-survivor-of-logout',
      expires_at: Date.now() - 86_400_000, // also expired, to prove expiry is not the claim
    }),
    'utf8',
  );
}

async function harness(): Promise<InstanceType<typeof Client>> {
  const server = new McpServer({ name: 'token-store-classification', version: '0.0.0' });
  server.tool('get_me', 'Read the current user.', async () => {
    const client = new SpotifyClient();
    const me = await client.get<Record<string, unknown>>('/me');
    return { content: [{ type: 'text', text: JSON.stringify(me) }], structuredContent: me ?? {} };
  });
  installToolErrorBoundary(server);

  const client = new Client({ name: 'token-store-classification-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closeHarness = async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  };
  return client;
}

async function callAndReadEnvelope(): Promise<{ envelope: ErrorEnvelope; text: string }> {
  const client = await harness();
  const result = (await client.callTool({ name: 'get_me', arguments: {} })) as unknown as {
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: { error?: ErrorEnvelope };
    isError?: boolean;
  };
  const envelope = result.structuredContent?.error;
  assert.ok(envelope, 'the boundary must return a structured error envelope');
  return { envelope, text: (result.content ?? []).map((c) => c.text ?? '').join(' ') };
}

describe('a token store that cannot be read is an auth failure, not an internal one', () => {
  it('classifies it as auth so the host is told to re-authenticate', async () => {
    await seedUnreadableTokenStore();
    const { envelope } = await callAndReadEnvelope();

    // The regression this file exists for: before the `auth` arm this was
    // `internal`, whose advice — retry once, then read protected diagnostics —
    // is wrong in every clause for a credential that cannot be loaded.
    assert.equal(envelope.kind, 'auth');
    assert.equal(envelope.reason, 'authentication_required');
  });

  it('never tells the caller to retry, because retrying cannot succeed', async () => {
    await seedUnreadableTokenStore();
    const { envelope, text } = await callAndReadEnvelope();

    assert.doesNotMatch(envelope.fix, /retry once/i);
    assert.doesNotMatch(text, /failed unexpectedly/i);
    assert.doesNotMatch(text, /protected server diagnostics/i);
  });

  it('names re-authentication as the action', async () => {
    await seedUnreadableTokenStore();
    const { envelope, text } = await callAndReadEnvelope();

    assert.match(envelope.fix, /re-authenticate|login/i);
    assert.match(text, /could not read saved Spotify credentials/i);
  });

  it('is deterministic — a second call reports the same class, not a retryable one', async () => {
    await seedUnreadableTokenStore();
    const first = await callAndReadEnvelope();
    const second = await callAndReadEnvelope();
    assert.equal(first.envelope.kind, second.envelope.kind);
    assert.equal(first.envelope.reason, second.envelope.reason);
  });
});

process.on('exit', () => {
  console.error = originalConsoleError;
  void rm(tokenDir, { recursive: true, force: true });
});
