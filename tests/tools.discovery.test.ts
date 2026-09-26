/**
 * Tests for the discovery trio in src/tools/swarm3_meta.ts (#A0-004, #713).
 *
 * Regression: the reader used `tool.name` from the SDK's registry values, which
 * do not carry a name — every call reported "0 registered tools" while 608 were
 * registered. The registry key is the tool name.
 *
 * #713: all three tools also declare `response_format` and route through the
 * one `shapeDiscoveryResult` helper. Before the fix `find_tool` and
 * `inspect_tool` advertised the switch and never read it, and
 * `toolset_report` did not declare it, so an agent asking for JSON got prose.
 *
 * Run: node --import tsx --test tests/tools.discovery.test.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSwarm3MetaTools } from '../src/tools/swarm3_meta.js';
import { registerSwarm3RefsTools } from '../src/tools/swarm3_refs.js';
import { finalInputSchema, shapeDiscoveryResult } from '../src/shaping.js';
import { CHUNK_CAPS } from '../src/chunk.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

/**
 * #713 — the discovery trio honours `response_format`.
 *
 * The discriminating assertion in each case is `text === JSON.stringify(
 * structuredContent, null, 2)`: that is `shapeDiscoveryResult`'s exact output,
 * so a bespoke branch in the handler (compact JSON, a re-derived payload, a
 * prose prefix) cannot satisfy it. Prose alone would not prove the helper.
 */
describe('#713 — the discovery trio honours response_format', () => {
  const REGISTRY = {
    get_playlist: { description: 'Fetch one playlist', inputSchema: { type: 'object', properties: { playlist_id: { type: 'string' } } }, enabled: true },
    add_to_playlist: { description: 'Append tracks to a playlist', inputSchema: { type: 'object' }, enabled: true },
  };

  /** The helper's contract, asserted on its own so a change to it is deliberate. */
  it('shapeDiscoveryResult produces all three modes from one branch', () => {
    const payload = { ok: true, tools: [{ name: 'find_tool' }] };
    const json = shapeDiscoveryResult('json', 'PROSE', payload);
    assert.equal(json.content[0]!.text, JSON.stringify(payload, null, 2));
    assert.deepEqual(json.structuredContent, payload);
    for (const prose of ['concise', 'detailed', undefined] as const) {
      const shaped = shapeDiscoveryResult(prose, 'PROSE', payload);
      assert.equal(shaped.content[0]!.text, 'PROSE', `mode ${String(prose)} must keep the prose`);
      assert.deepEqual(shaped.structuredContent, payload);
    }
  });

  it('find_tool json mode returns a parseable tools array', async () => {
    const handlers = harness(REGISTRY);
    const res = await handlers.get('find_tool')!({ query: 'playlist', response_format: 'json' });
    const parsed = JSON.parse(res.content[0]!.text);
    assert.equal(res.content[0]!.text, JSON.stringify(res.structuredContent, null, 2), 'json text must be the helper output, not a bespoke serialization');
    assert.ok(Array.isArray(parsed.tools), 'the parsed payload must carry a tools array');
    assert.deepEqual((parsed.tools as Array<{ name: string }>).map((t) => t.name), ['get_playlist', 'add_to_playlist']);
    assert.equal(parsed.total_registered, 2);
    assert.equal(parsed.matched, 2);
  });

  it('find_tool prose modes are unchanged, and limit still applies in json', async () => {
    const handlers = harness(REGISTRY);
    const prose = await handlers.get('find_tool')!({ query: 'playlist' });
    assert.match(prose.content[0]!.text, /^Matched 2 of 2 registered tools:/);
    assert.match(prose.content[0]!.text, /• get_playlist — Fetch one playlist/);
    const capped = await handlers.get('find_tool')!({ query: 'playlist', limit: 1, response_format: 'json' });
    assert.equal((JSON.parse(capped.content[0]!.text).tools as unknown[]).length, 1, 'limit bounds the json payload too');
  });

  it('inspect_tool json mode returns the input schema as JSON text', async () => {
    const handlers = harness(REGISTRY);
    const res = await handlers.get('inspect_tool')!({ tool_name: 'get_playlist', response_format: 'json' });
    const parsed = JSON.parse(res.content[0]!.text);
    assert.equal(res.content[0]!.text, JSON.stringify(res.structuredContent, null, 2));
    assert.equal(parsed.found, true);
    assert.ok(parsed.input_schema.properties.playlist_id, 'the parsed payload must carry the input schema');
  });

  it('toolset_report declares response_format and honours it', async () => {
    const server = new McpServer({ name: 'discovery-713', version: '0.0.0' });
    registerSwarm3MetaTools(server);
    const registry = (server as unknown as {
      _registeredTools: Record<string, {
        inputSchema?: unknown;
        handler: (args: Record<string, unknown>) => Promise<DiscoveryResult>;
      }>;
    })._registeredTools;

    for (const name of ['find_tool', 'inspect_tool', 'toolset_report']) {
      // finalInputSchema is the real tools/list boundary, so this asserts what a
      // host actually reads the description from.
      const declared = (finalInputSchema(registry[name]?.inputSchema).properties as Record<string, { description?: string }> | undefined)?.response_format;
      assert.ok(declared, `${name} must declare response_format`);
      assert.match(String(declared.description), /parseable JSON text/, `${name} must say what json returns`);
    }

    const prose = await registry.toolset_report!.handler({});
    assert.match(prose.content[0]!.text, /Batch caps \(per request\):/);
    const json = await registry.toolset_report!.handler({ response_format: 'json' });
    assert.equal(json.content[0]!.text, JSON.stringify(json.structuredContent, null, 2));
    assert.deepEqual(JSON.parse(json.content[0]!.text).batch_caps, CHUNK_CAPS);
  });

  it('the failure branches are shaped too, not left as raw prose', async () => {
    const empty = harness({});
    const unavailable = await empty.get('find_tool')!({ query: 'playlist', response_format: 'json' });
    assert.equal(unavailable.content[0]!.text, JSON.stringify(unavailable.structuredContent, null, 2));
    assert.equal(JSON.parse(unavailable.content[0]!.text).error, 'registry_unavailable');
    const missing = await harness(REGISTRY).get('inspect_tool')!({ tool_name: 'nope', response_format: 'json' });
    assert.equal(missing.content[0]!.text, JSON.stringify(missing.structuredContent, null, 2));
    assert.equal(JSON.parse(missing.content[0]!.text).found, false);
  });

  it('one shared helper, not a branch per tool', () => {
    const source = readFileSync(join(ROOT, 'src', 'tools', 'swarm3_meta.ts'), 'utf8');
    assert.doesNotMatch(
      source,
      /response_format\s*===\s*'json'/,
      'the mode branch belongs to shapeDiscoveryResult; a second copy here is how the modes drifted (#713)',
    );
    // find_tool x2, inspect_tool x3 (registry-unavailable, unknown, found), toolset_report x1.
    assert.equal(
      (source.match(/shapeDiscoveryResult\(/g) ?? []).length,
      6,
      'every discovery return path must emit through the shared helper',
    );
  });
});

describe('live discovery excludes redundant owned URI utilities', () => {
  it('exposes exactly the six curated Spotify reference tools', async () => {
    const registered = new Map<string, { description: string; enabled: boolean; readOnlyHint?: boolean }>();
    const server = {
      _registeredTools: registered,
      tool(name: string, description: string, _schema: unknown, annotations?: { readOnlyHint?: boolean }, _handler?: unknown) {
        registered.set(name, { description, enabled: true, readOnlyHint: annotations?.readOnlyHint });
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
    for (const [name, tool] of registered) {
      assert.equal(tool.readOnlyHint, true, name);
    }
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
