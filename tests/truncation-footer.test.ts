import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import type { SpotifyClient } from '../src/client.js';
import { initConfig } from '../src/config.js';
import { installTruncationBoundary, truncateItems, type TruncationBoundary } from '../src/shaping.js';

const REPO_ROOT = join(import.meta.dirname, '..');
const TOOL_MODULE_DIR = join(REPO_ROOT, 'src/tools');
const CONTROL_NAMES = ['max_results', 'offset', 'fetch_all', 'scan_cap', 'limit'] as const;

interface ListedTool {
  name: string;
  inputSchema?: { properties?: Record<string, unknown> };
}

function representativeArgs(properties: Set<string>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (properties.has('max_results')) args.max_results = 1;
  if (properties.has('offset')) args.offset = 0;
  if (properties.has('fetch_all')) args.fetch_all = true;
  if (properties.has('scan_cap')) args.scan_cap = 1;
  if (properties.has('limit')) args.limit = 1;
  return args;
}

function mentionedControls(text: string): string[] {
  return CONTROL_NAMES.filter((control) => new RegExp(`\\b${control}\\b`).test(text));
}

async function enumerateLiveBoundary(): Promise<{
  tools: ListedTool[];
  shape: TruncationBoundary['shape'];
  topTracksResult: Awaited<ReturnType<Client['callTool']>>;
}> {
  const server = new McpServer({ name: 'truncation-boundary-test', version: '0.0.0' });
  const boundary = installTruncationBoundary(server);
  const client = new Client({ name: 'truncation-boundary-client', version: '0.0.0' });
  const tracks = Array.from({ length: 4 }, (_, index) => ({
    id: `track-${index}`,
    name: `Track ${index}`,
    uri: `spotify:track:track-${index}`,
    duration_ms: 1_000,
    artists: [{ name: 'Artist' }],
  }));
  const stub = {
    get: async (path: string) => path === '/me/top/tracks'
      ? { items: tracks, total: tracks.length, limit: 4, offset: 0 }
      : null,
    post: async () => null,
    put: async () => null,
    delete: async () => null,
    getAllPages: async () => [],
  } as unknown as SpotifyClient;

  for (const file of (await readdir(TOOL_MODULE_DIR)).filter((name) => name.endsWith('.ts')).sort()) {
    if (file === 'annotations.ts') continue;
    const module = await import(join(TOOL_MODULE_DIR, file)) as Record<string, unknown>;
    for (const [name, exported] of Object.entries(module)) {
      if (!/^register[A-Z]/.test(name) || typeof exported !== 'function') continue;
      try {
        if (name === 'registerStatsfmTools') (exported as (server: McpServer) => void)(server);
        else (exported as (server: McpServer, client: SpotifyClient) => void)(server, stub);
      } catch (error) {
        assert.fail(`registrar ${file}:${name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // Registered inline by src/index.ts rather than a tools/ registrar.
  server.tool(
    'verify_receipt',
    'Verify a mutation receipt',
    { receipt_id: z.string() },
    async () => ({ content: [{ type: 'text', text: 'unused' }] }),
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = await client.listTools();
    const topTracksResult = await client.callTool({
      name: 'get_top_tracks',
      arguments: { max_results: 2 },
    });
    return { tools: listed.tools as ListedTool[], shape: boundary.shape, topTracksResult };
  } finally {
    await client.close();
    await server.close();
  }
}

describe('production truncation boundary', () => {
  it('repairs every live tool footer and emits consistent metadata', async () => {
    const { tools, shape, topTracksResult } = await enumerateLiveBoundary();
    assert.ok(tools.length > 500, `expected the full live surface, got ${tools.length}`);
    const observedCases = new Set<string>();

    for (let index = 0; index < tools.length; index++) {
      const tool = tools[index]!;
      const properties = new Set(Object.keys(tool.inputSchema?.properties ?? {}));
      const signature = CONTROL_NAMES.filter((name) => properties.has(name)).join(',') || 'none';
      observedCases.add(signature);
      const args = representativeArgs(properties);
      const legacy = {
        content: [{
          type: 'text',
          text: `Representative ${tool.name}\n(3 more — pass offset or fetch_all)`,
        }],
        structuredContent: { items: ['first'], total: 4 },
      };

      const shaped = shape(tool.name, args, legacy) as {
        content: Array<{ type: string; text: string }>;
        structuredContent: Record<string, unknown>;
      };
      const text = shaped.content[0]!.text;
      for (const control of mentionedControls(text)) {
        assert.ok(properties.has(control), `${tool.name} footer names unavailable ${control}`);
      }
      if (signature === 'max_results') assert.match(text, /raise max_results/);
      if (signature === 'offset,fetch_all') assert.match(text, /continue with offset.*set fetch_all/);
      if (signature === 'scan_cap') assert.match(text, /raise scan_cap/);
      if (signature === 'none') assert.match(text, /narrow the query/);
      assert.match(text, /3 more/);
      const metadata = shaped.structuredContent;
      assert.equal(metadata.truncated, true);
      assert.equal(metadata.returned, 1);
      assert.equal(metadata.total, 4);
      assert.equal(metadata.remaining, 3);
      if (properties.has('offset')) assert.equal(metadata.next_offset, 1);
      else assert.equal('next_offset' in metadata, false);
    }

    const signatures = [...observedCases];
    assert.ok(signatures.includes('max_results'), 'fixture must include max_results-only tools');
    assert.ok(signatures.some((signature) => signature.includes('offset') && signature.includes('fetch_all')), 'fixture must include offset + fetch_all tools');
    assert.ok(signatures.some((signature) => signature.split(',').includes('scan_cap')), 'fixture must include scan_cap tools');
    assert.ok(signatures.includes('none'), 'fixture must include no-continuation tools');
    const clientText = topTracksResult.content.map((block) => 'text' in block ? block.text : '').join('\n');
    assert.match(clientText, /2 more — raise max_results, continue with offset, raise limit/);
    const clientMetadata = topTracksResult.structuredContent as Record<string, unknown>;
    assert.equal(clientMetadata.returned, 2);
    assert.equal(clientMetadata.total, 4);
    assert.equal(clientMetadata.remaining, 2);
    assert.equal(clientMetadata.next_offset, 2);
  });

  it('preserves the legacy direct truncateItems footer contract', () => {
    assert.equal(
      truncateItems([1, 2, 3], 1).footer,
      '2 more — pass offset or fetch_all',
    );
  });

  it('caps raw JSON items and keeps its text and structured payload synchronized', async () => {
    const server = new McpServer({ name: 'truncation-json-test', version: '0.0.0' });
    const boundary = installTruncationBoundary(server);
    server.tool(
      'json_list',
      'JSON list',
      { max_results: z.number().optional() },
      async () => ({ content: [{ type: 'text', text: 'handler result' }] }),
    );
    const raw = { items: ['a', 'b', 'c'], total: 3 };
    const shaped = boundary.shape('json_list', { max_results: 2 }, {
      content: [{ type: 'text', text: JSON.stringify(raw) }],
    }) as {
      content: Array<{ type: string; text: string }>;
      structuredContent: Record<string, unknown>;
    };
    assert.deepEqual(shaped.structuredContent.items, ['a', 'b']);
    assert.deepEqual(shaped.structuredContent, {
      items: ['a', 'b'],
      total: 3,
      truncated: true,
      returned: 2,
      remaining: 1,
    });
    assert.deepEqual(JSON.parse(shaped.content[0]!.text), shaped.structuredContent);
  });

  it('handles the current limit-only footer with entries but no total metadata', async () => {
    const server = new McpServer({ name: 'truncation-limit-test', version: '0.0.0' });
    const boundary = installTruncationBoundary(server);
    server.tool('most_replayed', 'Limit-only ranked list', { limit: z.number().optional() }, async () => ({ content: [] }));
    const shapedResult = truncateItems(['a', 'b', 'c', 'd'], 2, { limit: true });
    const shaped = boundary.shape('most_replayed', { limit: 2 }, {
      content: [{ type: 'text', text: `ranked\n(${shapedResult.footer})` }],
      structuredContent: { unique_tracks: 4, entries: shapedResult.items, truncated: true },
    }) as {
      content: Array<{ type: string; text: string }>;
      structuredContent: Record<string, unknown>;
    };
    assert.match(shaped.content[0]!.text, /2 more — raise limit\)/);
    assert.doesNotMatch(shaped.content[0]!.text, /0 more|max_results|offset|fetch_all|scan_cap/);
    assert.equal(shaped.structuredContent.returned, 2);
    assert.equal(shaped.structuredContent.total, 4);
    assert.equal(shaped.structuredContent.remaining, 2);
  });

  it('uses a finite declared total before inferring remaining from excess items', () => {
    const server = new McpServer({ name: 'truncation-total-test', version: '0.0.0' });
    const boundary = installTruncationBoundary(server);
    server.tool('finite_total', 'Finite total', { max_results: z.number().optional() }, async () => ({ content: [] }));
    const shaped = boundary.shape('finite_total', { max_results: 2 }, {
      content: [{ type: 'text', text: JSON.stringify({ items: ['a', 'b', 'c', 'd', 'e'], total: 3 }) }],
    }) as { content: Array<{ text: string }>; structuredContent: Record<string, unknown> };
    assert.deepEqual(shaped.structuredContent.items, ['a', 'b']);
    assert.equal(shaped.structuredContent.total, 3);
    assert.equal(shaped.structuredContent.returned, 2);
    assert.equal(shaped.structuredContent.remaining, 1);
  });

  it('uses the initialized configured cap when max_results is omitted', () => {
    const previous = process.env.SPOTIFY_MCP_MAX_ITEMS;
    try {
      initConfig({ ...process.env, SPOTIFY_MCP_MAX_ITEMS: '3' });
      const server = new McpServer({ name: 'truncation-config-test', version: '0.0.0' });
      const boundary = installTruncationBoundary(server);
      server.tool('configured_cap', 'Configured cap', { max_results: z.number().optional() }, async () => ({ content: [] }));
      const shaped = boundary.shape('configured_cap', {}, {
        content: [{ type: 'text', text: JSON.stringify(['a', 'b', 'c', 'd']) }],
      }) as { content: Array<{ text: string }>; structuredContent: Record<string, unknown> };
      assert.deepEqual(shaped.structuredContent.items, ['a', 'b', 'c']);
      assert.equal(shaped.structuredContent.returned, 3);
      assert.equal(shaped.structuredContent.remaining, 1);
    } finally {
      if (previous === undefined) delete process.env.SPOTIFY_MCP_MAX_ITEMS;
      else process.env.SPOTIFY_MCP_MAX_ITEMS = previous;
      initConfig(process.env);
    }
  });

  it('keeps shaped top-level JSON arrays as JSON arrays', () => {
    const server = new McpServer({ name: 'truncation-array-test', version: '0.0.0' });
    const boundary = installTruncationBoundary(server);
    server.tool('json_array', 'JSON array', { max_results: z.number().optional() }, async () => ({ content: [] }));
    const shaped = boundary.shape('json_array', { max_results: 2 }, {
      content: [{ type: 'text', text: JSON.stringify(['a', 'b', 'c']) }],
    }) as { content: Array<{ text: string }>; structuredContent: Record<string, unknown> };
    assert.deepEqual(JSON.parse(shaped.content[0]!.text), ['a', 'b']);
    assert.equal(Array.isArray(JSON.parse(shaped.content[0]!.text)), true);
    assert.equal(shaped.structuredContent.returned, 2);
    assert.equal(shaped.structuredContent.remaining, 1);
  });

  it('does not rewrite arbitrary more-prose or add continuation to ordinary short pages', () => {
    const server = new McpServer({ name: 'truncation-short-test', version: '0.0.0' });
    const boundary = installTruncationBoundary(server);
    server.tool('short_page', 'Short page', { max_results: z.number().optional() }, async () => ({ content: [] }));
    const arbitrary = { content: [{ type: 'text' as const, text: '3 more — live' }] };
    const ordinary = { content: [{ type: 'text' as const, text: 'Only one row' }] };
    assert.equal(boundary.shape('short_page', {}, arbitrary), arbitrary);
    assert.equal(boundary.shape('short_page', {}, ordinary), ordinary);
  });

  it('recognizes bare canonical generated footers without capturing prose', () => {
    const server = new McpServer({ name: 'truncation-bare-footer-test', version: '0.0.0' });
    const boundary = installTruncationBoundary(server);
    server.tool('bare_footer', 'Bare footer', { max_results: z.number().optional() }, async () => ({ content: [] }));
    const shaped = boundary.shape('bare_footer', { max_results: 2 }, {
      content: [{ type: 'text', text: '3 more — pass offset or fetch_all' }],
      structuredContent: { items: ['a'], total: 4 },
    }) as { content: Array<{ text: string }>; structuredContent: Record<string, unknown> };
    assert.equal(shaped.structuredContent.remaining, 3);
    assert.match(shaped.content[0]!.text, /3 more/);
  });

  it('preserves successful untouched results by identity', async () => {
    const server = new McpServer({ name: 'truncation-identity-test', version: '0.0.0' });
    const boundary = installTruncationBoundary(server);
    server.tool('plain', 'Plain', {}, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const content = [{ type: 'text' as const, text: 'ok' }];
    const result = { content };
    assert.equal(boundary.shape('plain', {}, result), result);
    assert.equal((boundary.shape('plain', {}, result) as typeof result).content, content);
  });
});
