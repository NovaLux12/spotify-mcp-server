/**
 * Tests for the discovery trio in src/tools/swarm3_meta.ts (#A0-004).
 *
 * Regression: the reader used `tool.name` from the SDK's registry values, which
 * do not carry a name — every call reported "0 registered tools" while 608 were
 * registered. The registry key is the tool name.
 *
 * Run: node --import tsx --test tests/tools.discovery.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerSwarm3MetaTools } from '../src/tools/swarm3_meta.js';
import { registerSwarm3RefsTools } from '../src/tools/swarm3_refs.js';

interface DiscoveryResult {
  content: Array<{ type: string; text: string }>;
  structuredContent: Record<string, unknown>;
}

type Handler = (args: Record<string, unknown>) => Promise<DiscoveryResult>;

function harness(registry: Record<string, unknown>): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const server = {
    _registeredTools: registry,
    tool(name: string, _description: string, _schema: unknown, handler: Handler) {
      handlers.set(name, handler);
      return { name };
    },
  };
  registerSwarm3MetaTools(server as never, {} as never);
  return handlers;
}

describe('discovery tools read the live registry', () => {
  it('find_tool matches tool names taken from the registry keys', async () => {
    const handlers = harness({
      search: { description: 'Search the catalog', inputSchema: {}, enabled: true },
      get_track: { description: 'Get a track', inputSchema: {}, enabled: true },
      disabled_tool: { description: 'Not registered', enabled: false },
    });
    const res = await handlers.get('find_tool')!({ query: 'track' });
    assert.equal(res.structuredContent.total_registered, 2);
    assert.equal(res.structuredContent.matched, 1);
    assert.deepEqual((res.structuredContent.tools as Array<{ name: string }>)[0]!.name, 'get_track');
  });

  it('inspect_tool resolves a tool and returns its schema', async () => {
    const handlers = harness({
      search: {
        description: 'Search the catalog',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        enabled: true,
      },
    });
    const res = await handlers.get('inspect_tool')!({ tool_name: 'search' });
    assert.equal(res.structuredContent.found, true);
    assert.match(res.content[0]!.text, /properties/);
  });

  it('reports registry_unavailable rather than an empty surface', async () => {
    const handlers = harness({});
    const res = await handlers.get('find_tool')!({ query: 'playlist' });
    assert.equal(res.structuredContent.error, 'registry_unavailable');
  });

  it('toolset_report derives active sets and modules from the env spec', async () => {
    const handlers = harness({ search: { description: 'search', enabled: true } });
    const prev = process.env.SPOTIFY_MCP_TOOLSETS;
    process.env.SPOTIFY_MCP_TOOLSETS = 'catalog';
    try {
      const res = await handlers.get('toolset_report')!({});
      const activeSets = res.structuredContent.active_toolsets as string[];
      assert.ok(activeSets.includes('catalog'), 'catalog should be active');
      assert.ok(!activeSets.includes('playback'), 'playback should be trimmed');
      assert.equal(res.structuredContent.registered_tools, 1);
      assert.ok((res.structuredContent.active_modules as string[]).includes('search'));
      assert.ok(!(res.structuredContent.active_modules as string[]).includes('playback'));
    } finally {
      if (prev === undefined) delete process.env.SPOTIFY_MCP_TOOLSETS;
      else process.env.SPOTIFY_MCP_TOOLSETS = prev;
    }
  });
});

describe('live discovery excludes redundant owned URI utilities', () => {
  it('exposes exactly the six curated Spotify reference tools', async () => {
    const registered = new Map<string, { description: string; enabled: boolean }>();
    const server = {
      _registeredTools: registered,
      tool(name: string, description: string) {
        registered.set(name, { description, enabled: true });
        return { name };
      },
    };
    registerSwarm3RefsTools(server as never, {} as never);
    const handlers = harness(Object.fromEntries(registered));

    const result = await handlers.get('find_tool')!({ query: 'spotify' });
    const names = (result.structuredContent.tools as Array<{ name: string }>).map((tool) => tool.name);
    assert.deepEqual(names, [
      'parse_spotify_uri',
      'parse_spotify_uris',
      'format_spotify_uri',
      'canonicalize_spotify_uri',
      'dedupe_spotify_uris',
      'spotify_uri_stats',
    ]);
    for (const removed of [
      'extract_spotify_id',
      'uri_to_base62',
      'normalize_spotify_uri',
      'uri_namespace_census',
      'find_duplicate_spotify_uris',
      'classify_spotify_uris',
    ]) {
      assert.equal(registered.has(removed), false, removed);
    }
  });
});
