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
const CONTROL_NAMES = ['max_results', 'max_items', 'offset', 'fetch_all', 'scan_cap', 'limit'] as const;

interface ListedTool {
  name: string;
  inputSchema?: { properties?: Record<string, unknown> };
}

function representativeArgs(properties: Set<string>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (properties.has('max_results')) args.max_results = 1;
  if (properties.has('offset')) args.offset = 0;
  if (properties.has('max_items')) args.max_items = 1;
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
      if (signature === 'max_items') assert.match(text, /raise max_items/);
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
    assert.ok(signatures.includes('max_items'), 'fixture must include max_items-only tools');
    const clientText = topTracksResult.content.map((block) => 'text' in block ? block.text : '').join('\n');
    assert.match(clientText, /2 more — raise max_results, continue with offset, raise limit/);
    const clientMetadata = topTracksResult.structuredContent as Record<string, unknown>;
    assert.equal(clientMetadata.returned, 2);
    assert.equal(clientMetadata.total, 4);
    assert.equal(clientMetadata.remaining, 2);
    assert.equal(clientMetadata.next_offset, 2);

    const listeningStreaks = tools.find((tool) => tool.name === 'listening_streaks');
    assert.ok(listeningStreaks, 'fixture must include listening_streaks');
    const listeningProperties = new Set(Object.keys(listeningStreaks.inputSchema?.properties ?? {}));
    assert.ok(listeningProperties.has('max_items'));
    assert.equal(listeningProperties.has('offset'), false);
    const listeningResult = shape('listening_streaks', { max_items: 2 }, {
      content: [{
        type: 'text',
        text: 'Listening streaks\n(3 more — pass offset or fetch_all)',
      }],
      structuredContent: { items: ['a', 'b', 'c'], total: 5 },
    }) as {
      content: Array<{ type: string; text: string }>;
      structuredContent: Record<string, unknown>;
    };
    assert.match(listeningResult.content[0]!.text, /3 more — raise max_items/);
    assert.doesNotMatch(listeningResult.content[0]!.text, /pass offset or fetch_all/);
    assert.deepEqual(mentionedControls(listeningResult.content[0]!.text), ['max_items']);
    assert.equal(listeningResult.structuredContent.returned, 2);
    assert.equal(listeningResult.structuredContent.remaining, 3);
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

  it('never re-slices a result whose tool was explicitly asked to fetch everything', () => {
    const server = new McpServer({ name: 'truncation-fetch-all-test', version: '0.0.0' });
    const boundary = installTruncationBoundary(server);
    server.tool(
      'fetch_all_reader',
      'Reads every page when asked',
      { max_results: z.number().optional(), fetch_all: z.boolean().optional() },
      async () => ({ content: [] }),
    );
    const rows = Array.from({ length: 120 }, (_, index) => `spotify:track:t${index}`);
    const result = (args: Record<string, unknown>) => boundary.shape('fetch_all_reader', args, {
      content: [{ type: 'text', text: `Playlist items (120 total, showing 120):\n${rows.join('\n')}` }],
      structuredContent: { items: rows, total: 120, returned: 120 },
    }) as { content: Array<{ text: string }>; structuredContent: Record<string, unknown> };

    // fetch_all is a documented bypass of max_results: the prose and the
    // machine payload must agree, and neither may drop what the caller asked for.
    const all = result({ max_results: 50, fetch_all: true });
    assert.equal((all.structuredContent.items as string[]).length, 120, 'fetch_all must not be re-sliced');
    assert.match(all.content[0].text, /showing 120/);
    assert.equal(all.structuredContent.truncated, undefined);

    // Without it the same payload is capped — the cap is a contract, not a bug.
    const capped = result({ max_results: 50 });
    assert.equal((capped.structuredContent.items as string[]).length, 50);
    assert.equal(capped.structuredContent.remaining, 70);
  });

  // `returned < total` is not evidence of truncation: `total` is page-scoped
  // in some tools and means "exhausted" in others. Both shapes below used to be
  // stamped as truncation, inventing advice the caller cannot act on.
  it('stays silent on an exhausted page that still reports a non-zero total', () => {
    const server = new McpServer({ name: 'truncation-exhausted-page', version: '0.0.0' });
    const boundary = installTruncationBoundary(server);
    server.tool(
      'category_playlists',
      'Paged collection',
      { max_results: z.number().optional(), offset: z.number().optional() },
      async () => ({ content: [] }),
    );
    const shaped = boundary.shape('category_playlists', { offset: 40 }, {
      content: [{ type: 'text', text: 'No playlists found for category "party".' }],
      structuredContent: { items: [], total: 37, pagination: { total: 37, next_offset: null } },
    }) as { content: Array<{ text: string }>; structuredContent: Record<string, unknown> };
    assert.equal(shaped.structuredContent.truncated, undefined);
    assert.equal(shaped.structuredContent.remaining, undefined);
    assert.equal(shaped.structuredContent.next_offset, undefined, 'must not re-offer the offset just used');
    assert.doesNotMatch(shaped.content[0].text, /more —/);
  });

  it('stays silent when total describes a wider population than the tool can return', () => {
    const server = new McpServer({ name: 'truncation-page-scoped-total', version: '0.0.0' });
    const boundary = installTruncationBoundary(server);
    // search_by_isrc exposes no offset and no max_results: an index-wide
    // `total` here is not something the caller can act on by paging.
    server.tool('exact_isrc_search', 'Exact match', { market: z.string().optional() }, async () => ({ content: [] }));
    const shaped = boundary.shape('exact_isrc_search', {}, {
      content: [{ type: 'text', text: 'ISRC match (1841 total, showing 1):\n  • spotify:track:x' }],
      structuredContent: { items: ['spotify:track:x'], total: 1841, pagination: { total: 1841 } },
    }) as { content: Array<{ text: string }>; structuredContent: Record<string, unknown> };
    assert.equal(shaped.structuredContent.truncated, undefined);
    assert.equal(shaped.structuredContent.remaining, undefined);
    assert.doesNotMatch(shaped.content[0].text, /narrow the query|raise limit/);
  });

  // A tool may say "my SOURCE walk was cut off" and also describe render
  // truncation. The boundary computes its own `truncated` from render counts,
  // so the tool's flag must survive the spread — otherwise diff_playlists
  // reports a complete result computed from a walk that stopped at scan_cap.
  it('preserves a tool-authored truncated flag beside a render-truncation block', () => {
    const server = new McpServer({ name: 'truncation-authoritative-tool', version: '0.0.0' });
    const boundary = installTruncationBoundary(server);
    server.tool('diff_playlists', 'Two-playlist diff', { max_results: z.number().optional(), scan_cap: z.number().optional() }, async () => ({ content: [] }));
    const rows = Array.from({ length: 5 }, (_, index) => `spotify:track:d${index}`);
    // Every row fits inside max_results, so the boundary's own render
    // calculation is `remaining: 0` — the only thing carrying the truth is the
    // tool's own flag.
    const shaped = boundary.shape('diff_playlists', { max_results: 50, scan_cap: 5 }, {
      content: [{ type: 'text', text: 'Diff between A and B' }],
      structuredContent: {
        truncated: true,
        scan_cap: 5,
        playlist_a: 'aaaaaaaaaaaaaaaaaaaaaa',
        playlist_b: 'bbbbbbbbbbbbbbbbbbbbbb',
        only_in_a: rows,
        only_in_b: rows,
        moved: [],
        truncation: { returned: 10, total: 210 },
      },
    }) as { structuredContent: Record<string, unknown> };
    assert.equal(shaped.structuredContent.truncated, true, 'the source-walk flag must survive');
  });

  it('reports remaining from a declared total only when the tool can actually page', () => {
    const server = new McpServer({ name: 'truncation-paged-total', version: '0.0.0' });
    const boundary = installTruncationBoundary(server);
    // Same index-wide total, but this tool declares no offset/limit and is not
    // self-truncating: the boundary must not manufacture a `remaining`.
    server.tool('exact_search', 'Exact match', { market: z.string().optional() }, async () => ({ content: [] }));
    const shaped = boundary.shape('exact_search', {}, {
      content: [{ type: 'text', text: 'match' }],
      structuredContent: { items: ['a'], total: 1841 },
    }) as { structuredContent: Record<string, unknown> };
    assert.equal(shaped.structuredContent.remaining, undefined);
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

  it('preserves an explicit truncation marker without inventing a returned count', () => {
    const server = new McpServer({ name: 'truncation-marker-test', version: '0.0.0' });
    const boundary = installTruncationBoundary(server);
    server.tool('marked_partial', 'Marked partial', { max_results: z.number().optional() }, async () => ({ content: [] }));
    const result = {
      content: [],
      structuredContent: { truncated: true, remaining: 3, status: 'partial' },
    };
    const shaped = boundary.shape('marked_partial', { max_results: 2 }, result) as typeof result;
    assert.equal(shaped.structuredContent.truncated, true);
    assert.equal(shaped.structuredContent.remaining, 3);
    assert.equal('returned' in shaped.structuredContent, false);
    assert.equal('total' in shaped.structuredContent, false);
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
