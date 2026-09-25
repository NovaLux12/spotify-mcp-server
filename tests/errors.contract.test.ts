import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SpotifyApiError, type SpotifyClient } from '../src/client.js';
import { installToolErrorBoundary } from '../src/tools/annotations.js';
import { registerBackupFirstTools } from '../src/tools/backupfirst.js';

interface ErrorEnvelope {
  tool: string;
  kind: string;
  status?: number;
  retryAfterSec?: number;
  reason: string;
  param?: string;
  fix: string;
}

interface ErrorResult {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: { error?: ErrorEnvelope };
  isError?: boolean;
}

let closeHarness: (() => Promise<void>) | undefined;
const originalConsoleError = console.error;
const diagnostics: string[] = [];

console.error = (...args: unknown[]) => {
  diagnostics.push(args.map(String).join(' '));
};

afterEach(async () => {
  await closeHarness?.();
  closeHarness = undefined;
  diagnostics.length = 0;
});

async function harness(): Promise<Client> {
  const server = new McpServer({ name: 'error-contract', version: '0.0.0' });
  const throws = (error: unknown) => async () => { throw error; };

  server.tool('auth_error', '401', throws(new SpotifyApiError(401, 'raw auth path /home/alice/.config/spotify/tokens.json')));
  server.tool('forbidden_error', '403', throws(new SpotifyApiError(403, 'private callback https://example.test/callback?code=secret')));
  server.tool('not_found_error', '404', throws(new SpotifyApiError(404, 'missing /home/alice/snapshots/private.json')));
  server.tool('rate_limited_error', '429', throws(new SpotifyApiError(429, 'raw /tmp/archive.zip', 37, 'QUOTA_EXCEEDED')));
  server.tool('unavailable_error', '503', throws(new SpotifyApiError(503, 'raw /var/lib/spotify.snapshot')));
  server.tool('internal_error', 'internal', throws(new Error('ENOENT /home/alice/input/private.m3u and https://example.test/raw?token=secret')));
  server.tool('valid_error', 'validation', { count: z.number() }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  server.tool('near_error', 'unknown parameter', { playlist_id: z.string() }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  server.tool('list_show_episodes', 'episodes', { show_id: z.string(), offset: z.number().optional(), max_results: z.number().optional() }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  registerBackupFirstTools(server, {
    getAllPages: async () => { throw new SpotifyApiError(429, 'SENTINEL_BACKUP https://example.test/raw?token=secret /home/alice/private.json', 9); },
  } as unknown as SpotifyClient);

  installToolErrorBoundary(server);
  const client = new Client({ name: 'error-contract-client', version: '0.0.0' });
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
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0]?.type, 'text');
  const text = result.content[0]?.text ?? '';
  assert.ok(text.length > 0);
  assert.equal(text.includes('\n'), false);
  assert.equal(text.includes('\r'), false);
  assert.equal(text.startsWith('MCP error -'), false);
  const error = result.structuredContent?.error;
  assert.ok(error, 'structuredContent.error is required');
  assert.equal(typeof error.tool, 'string');
  assert.equal(typeof error.kind, 'string');
  assert.equal(typeof error.reason, 'string');
  assert.equal(typeof error.fix, 'string');
  return error;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ErrorResult> {
  return await client.callTool({ name, arguments: args }) as ErrorResult;
}

describe('production tool error contract (#921)', () => {
  it('advertises closed root input schemas', async () => {
    const client = await harness();
    const listed = await client.listTools();
    assert.ok(listed.tools.length > 0);
    for (const tool of listed.tools) {
      assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must reject unknown root arguments`);
    }
  });

  it('maps every required failure kind to a structured one-line tool result', async () => {
    const client = await harness();
    const cases = [
      { tool: 'auth_error', kind: 'auth', status: 401 },
      { tool: 'forbidden_error', kind: 'forbidden', status: 403 },
      { tool: 'not_found_error', kind: 'not_found', status: 404 },
      { tool: 'rate_limited_error', kind: 'rate_limited', status: 429, retryAfterSec: 37 },
      { tool: 'unavailable_error', kind: 'unavailable', status: 503 },
    ] as const;

    for (const expected of cases) {
      const error = envelope(await call(client, expected.tool));
      assert.equal(error.tool, expected.tool);
      assert.equal(error.kind, expected.kind);
      assert.equal(error.status, expected.status);
      assert.equal(error.retryAfterSec, expected.retryAfterSec);
    }

    const validation = envelope(await call(client, 'valid_error', { count: 'wrong' }));
    assert.equal(validation.tool, 'valid_error');
    assert.equal(validation.kind, 'validation');
    assert.equal(validation.param, 'count');

    const unknownParam = envelope(await call(client, 'near_error', { playlst_id: 'x' }));
    assert.equal(unknownParam.tool, 'near_error');
    assert.equal(unknownParam.kind, 'unknown_param');
    assert.equal(unknownParam.param, 'playlst_id');
    assert.match(unknownParam.fix, /playlist_id/);

    const unknownTool = envelope(await call(client, 'near_errr', {}));
    assert.equal(unknownTool.tool, 'near_errr');
    assert.equal(unknownTool.kind, 'unknown_tool');
    assert.match(unknownTool.fix, /near_error/);

    const internal = envelope(await call(client, 'internal_error'));
    assert.equal(internal.tool, 'internal_error');
    assert.equal(internal.kind, 'internal');
  });

  it('rejects unknown parameters before the handler and suggests real pagination names', async () => {
    let calls = 0;
    const server = new McpServer({ name: 'pre-handler', version: '0.0.0' });
    server.tool('guarded', 'guard', { value: z.string() }, async () => {
      calls++;
      return { content: [{ type: 'text', text: 'ok' }] };
    });
    server.tool('list_show_episodes', 'episodes', { show_id: z.string(), offset: z.number().optional(), max_results: z.number().optional() }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    installToolErrorBoundary(server);
    const client = new Client({ name: 'pre-handler-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closeHarness = async () => {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    };

    const unknown = envelope(await call(client, 'guarded', { vale: 'x' }));
    assert.equal(unknown.kind, 'unknown_param');
    assert.equal(unknown.param, 'vale');
    assert.match(unknown.fix, /value/);
    assert.equal(calls, 0, 'unknown argument reached the tool handler');

    const episodes = envelope(await call(client, 'list_show_episodes', { show_id: 'show1', limit: 5 }));
    assert.equal(episodes.tool, 'list_show_episodes');
    assert.equal(episodes.kind, 'unknown_param');
    assert.equal(episodes.param, 'limit');
    assert.match(episodes.fix, /offset/);
    assert.match(episodes.fix, /max_results/);
  });

  it('keeps private paths, query values, suffixes, and RPC prefixes out of public and stderr errors', async () => {
    const client = await harness();
    const publicResults = [
      await call(client, 'auth_error'),
      await call(client, 'internal_error'),
      await call(client, 'backup_first'),
    ];
    const publicText = JSON.stringify(publicResults);
    const stderrText = diagnostics.join('\n');
    for (const secret of [
      '/home/alice',
      'tokens.json',
      'private.m3u',
      'private.json',
      'private.zip',
      'spotify.snapshot',
      'code=secret',
      'token=secret',
      'SENTINEL_BACKUP',
      'MCP error -',
    ]) {
      assert.equal(publicText.includes(secret), false, `public error leaked ${secret}`);
      assert.equal(stderrText.includes(secret), false, `stderr leaked ${secret}`);
    }
    assert.ok(diagnostics.some((line) => /correlation_id=[0-9a-f-]{36}/.test(line)));
    assert.ok(diagnostics.some((line) => line.includes('tool=auth_error') && line.includes('kind=auth') && line.includes('status=401')));
    assert.ok(diagnostics.some((line) => line.includes('tool=internal_error') && line.includes('kind=internal') && line.includes('reason=internal_error')));
    assert.equal(stderrText.includes('diagnostic='), false);
  });
});

process.on('exit', () => {
  console.error = originalConsoleError;
});
