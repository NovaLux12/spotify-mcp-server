/**
 * #1007: a token-refresh failure must not be reported as a validation error.
 *
 * The chain under test is the real one: `GET /me` answers 401, the client
 * retries through the refresh, and accounts.spotify.com answers 400. Before
 * the fix the 400 from the token endpoint replaced the 401, so publicFailure
 * classified a call that passed no arguments at all as `validation` — "pass
 * values that match the tool schema". The operator's actual problem (the grant
 * is dead) was unreported.
 *
 * The assertions are on the operator-facing envelope produced by the real
 * error boundary, not on the client in isolation: the defect is the message a
 * caller sees.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Env MUST be set before src modules load: TOKEN_FILE binds at import time.
const tokenDir = await mkdtemp(path.join(tmpdir(), 'spotify-mcp-refresh-class-'));
process.env.SPOTIFY_MCP_TOKEN_FILE = path.join(tokenDir, 'tokens.json');
process.env.SPOTIFY_CLIENT_ID = 'test-client-id';

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { SpotifyClient, SpotifyApiError } = await import('../src/client.js');
const { installToolErrorBoundary } = await import('../src/tools/annotations.js');

interface ErrorEnvelope {
  tool: string;
  kind: string;
  status?: number;
  reason: string;
  fix: string;
}

interface ErrorResult {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: { error?: ErrorEnvelope };
  isError?: boolean;
}

const realFetch = globalThis.fetch;
const originalConsoleError = console.error;
console.error = () => {};

let closeHarness: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeHarness?.();
  closeHarness = undefined;
  globalThis.fetch = realFetch;
  console.error = originalConsoleError;
});

/** A live access token, so the client refreshes only in response to the 401. */
async function seedLiveToken(): Promise<void> {
  await writeFile(
    process.env.SPOTIFY_MCP_TOKEN_FILE as string,
    JSON.stringify({
      access_token: 'expired-access-token',
      refresh_token: 'ref-revoked',
      expires_at: Date.now() + 3_600_000,
    }),
    'utf8',
  );
}

/**
 * The wire the issue traced: the API endpoint 401s, and the token endpoint
 * fails with a 400 of its own (what accounts.spotify.com actually returns when
 * the grant is dead or the client is misconfigured).
 */
function installWireStub(): void {
  globalThis.fetch = (async (url: unknown) => {
    const href = String(url);
    if (href.startsWith('https://accounts.spotify.com/')) {
      return new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: { status: 401, message: 'The access token expired' } }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

/** A server whose one tool performs a real authenticated GET /me. */
async function harness(): Promise<Client> {
  const server = new McpServer({ name: 'refresh-classification', version: '0.0.0' });
  server.tool('get_me', 'Read the current user.', async () => {
    const client = new SpotifyClient();
    return await client.get('/me');
  });
  installToolErrorBoundary(server);

  const client = new Client({ name: 'refresh-classification-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closeHarness = async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  };
  return client;
}

function envelope(result: ErrorResult): ErrorEnvelope {
  assert.equal(result.isError, true);
  const error = result.structuredContent?.error;
  assert.ok(error, 'structuredContent.error is required');
  return error;
}

describe('token-refresh failure is reported as an auth failure (#1007)', () => {
  it('does not report a dead grant as invalid arguments', async () => {
    await seedLiveToken();
    installWireStub();

    const client = await harness();
    const error = envelope(await client.callTool({ name: 'get_me', arguments: {} }) as ErrorResult);

    assert.equal(error.kind, 'auth');
    assert.equal(error.status, 401);
    assert.match(error.fix, /spotify-mcp auth/);
  });

  it('preserves the actionable 401 when the refresh fails mid-flight', async () => {
    await seedLiveToken();
    // The token endpoint fails in a way that is not a grant rejection: a
    // transient 400 of its own. The 401 from the API endpoint is the only fact
    // the caller can act on and must survive the refresh attempt.
    globalThis.fetch = (async (url: unknown) => {
      const href = String(url);
      if (href.startsWith('https://accounts.spotify.com/')) {
        return new Response('upstream token failure', { status: 400 });
      }
      return new Response(JSON.stringify({ error: { status: 401, message: 'The access token expired' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const spotify = new SpotifyClient();
    await assert.rejects(spotify.get('/me'), (err: unknown) => {
      assert.ok(err instanceof SpotifyApiError);
      assert.equal(err.status, 401);
      return true;
    });
  });
});

process.on('exit', () => {
  globalThis.fetch = realFetch;
  console.error = originalConsoleError;
  void rm(tokenDir, { recursive: true, force: true });
});
