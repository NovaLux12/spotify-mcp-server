/**
 * Tool-surface budget + annotation gate (#565 / A0-001, A0-002, A4-005).
 *
 * The default surface advertises every registered tool, and each schema is paid
 * for by the host on every session (~170k tokens today). Nothing stopped that
 * from growing. This test pins three contracts:
 *
 *   1. annotations — every tool carries a title and an explicit readOnlyHint, and
 *      no destructive verb is ever advertised as read-only;
 *   2. budget — the default surface and the `core` preset stay inside ceilings,
 *      so a new module cannot silently triple the payload;
 *   3. the `core` preset actually covers the daily loop (search, playback,
 *      playlist writes, library, portability export, stats.fm).
 *
 * Spawns the real server over stdio; no Spotify traffic (initialize/tools/list
 * are served locally).
 *
 * Run: node --import tsx --test tests/tool.surface.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  AGGREGATE_SURFACE_LIMITS,
  assertAggregateSurfaceBudget,
  assertModuleSchemaBudgets,
  collectAggregateSurfaceMeasurement,
  collectModuleSchemaBudgets,
  NEVER_MUTATING_PLANS,
  moduleToolNames,
  serializedSchemaBytes,
  registerManifestModule,
  REGISTRAR_MANIFEST,
} from '../src/tools/annotations.js';
import { SpotifyClient } from '../src/client.js';

const REPO_ROOT = join(import.meta.dirname, '..');

const DEFAULT_MAX_TOOLS = AGGREGATE_SURFACE_LIMITS.maxTools;
const DEFAULT_MAX_BYTES = AGGREGATE_SURFACE_LIMITS.maxBytes;
const PER_TOOL_MAX_BYTES = 6_000;       // worst single schema+description today
const CORE_MAX_TOOLS = 200;             // today 157
const CORE_MAX_BYTES = 220_000;         // today 162,592

interface Tool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

interface JsonRpc { id?: number; result?: { tools?: Tool[] }; error?: { code: number; message: string } }

async function listTools(env: Record<string, string>): Promise<Tool[]> {
  const child = spawn('node', ['--import', 'tsx/esm', 'src/index.ts'], {
    cwd: REPO_ROOT,
    env: { ...process.env, SPOTIFY_CLIENT_ID: 'surface-test', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  const pending = new Map<number, (v: JsonRpc) => void>();
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c: string) => { stderr += c; });
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as JsonRpc;
      if (typeof msg.id !== 'number') continue;
      const resolve = pending.get(msg.id);
      if (resolve) { pending.delete(msg.id); resolve(msg); }
    }
  });
  let id = 0;
  const request = (method: string, params: Record<string, unknown> = {}): Promise<JsonRpc> => {
    const { promise, resolve, reject } = Promise.withResolvers<JsonRpc>();
    const myId = ++id;
    pending.set(myId, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, params })}\n`);
    // Watchdog only: the server under test is a separate OS process whose internal
    // timers cannot be faked from here, so a real deadline is the only way to fail
    // fast instead of hanging CI if the child wedges. The wait itself is event-driven.
    setTimeout(() => reject(new Error(`timeout waiting for ${method}\nstderr:\n${stderr}`)), 20_000).unref();
    return promise;
  };

  try {
    const init = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'surface-test', version: '1.0.0' },
    });
    assert.equal(init.error, undefined, `initialize failed: ${JSON.stringify(init.error)}`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    const listed = await request('tools/list');
    assert.equal(listed.error, undefined, `tools/list failed: ${JSON.stringify(listed.error)}`);
    const tools = listed.result?.tools;
    assert.ok(Array.isArray(tools) && tools.length > 0, 'tools/list must return a non-empty array');
    return tools;
  } finally {
    child.stdin.end();
    // Cleanup backstop for the same reason: the child is external, so give it a
    // moment to exit on stdin EOF, then force-kill so the test runner cannot hang.
    setTimeout(() => child.kill('SIGKILL'), 1500).unref();
  }
}

const bytesOf = (t: Tool): number => JSON.stringify(t).length;

/**
 * Verbs that change state. Bare `plan` is deliberately NOT here: a `_plan`
 * suffix alone is not evidence of mutation, so `*_plan` tools are classified by
 * capability in NEVER_MUTATING_PLANS (imported live so this gate cannot drift
 * from the classifier).
 */
const MUTATING_PREFIXES =
  /^(apply|start|save|add|create|update|set|replace|import|move|copy|remove|delete|unfollow|unsave|follow|pin|fill|merge|split|sort|shuffle|reorder|transfer|restore|cancel|clean|clear|trim|cull|archive|mark|queue|play|pause|skip|seek|generate|grow|balance|reschedule|migrate|handoff|dj|undo|export|backup|write|upload|rename|retag|sync|dedupe|take|snapshot|volume|sleep|transfer_playback|recently|retry|revert|reset|purge|wipe|drop|erase|revoke|disconnect|logout)/;

const READ_ONLY_PREFIXES =
  /^(get|list|search|check|inspect|find|show|describe|report|count|is|has|read|lookup|compare|diff|history|stats|statsfm|summary|summarize|summarise|analyze|analyse|validate|estimate|diagnose|resolve|quiz|census|audit|review|coverage|timeline|heatmap|trends?|insights?|distribution|breakdown|matrix|explorer|probe|digest|briefing|radar|where)/;

describe('tool surface: annotations', () => {
  it('every tool carries an explicit classification', async () => {
    const tools = await listTools({});
    const unclassified = tools
      .filter((t) => typeof t.annotations?.readOnlyHint !== 'boolean' && typeof t.annotations?.destructiveHint !== 'boolean')
      .map((t) => t.name);
    assert.deepEqual(unclassified.slice(0, 10), [], `${unclassified.length} tools with no classification`);
  });

  it('nothing that can mutate is advertised as read-only', async () => {
    const tools = await listTools({});
    // Any _plan/_preview name outside the audited never-mutating set must be a
    // write: preview-by-default tools that accept dry_run=false execute.
    const unlistedPlans = tools
      .filter((t) => /_(plan|preview)$/.test(t.name) && !NEVER_MUTATING_PLANS.has(t.name) && t.annotations?.readOnlyHint === true)
      .map((t) => t.name);
    assert.deepEqual(unlistedPlans, [], `unaudited plan/preview tools advertised read-only: [${unlistedPlans.join(', ')}]`);
    const leaks = tools.filter((t) => MUTATING_PREFIXES.test(t.name) && !NEVER_MUTATING_PLANS.has(t.name) && t.annotations?.readOnlyHint === true).map((t) => t.name);
    assert.deepEqual(leaks, [], `mutating tools advertised read-only: [${leaks.join(', ')}]`);

    // Presence floor: the assertion above cannot pass on an empty/degenerate surface.
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint === true);
    assert.ok(readOnly.length > 100, `expected >100 read-only tools, got ${readOnly.length}`);
    assert.ok(tools.length > 500, `expected the full surface, got ${tools.length} tools`);
  });

  it('audited never-mutating plans stay read-only, and coverage cannot silently drop', async () => {
    const tools = await listTools({});
    const byName = new Map(tools.map((t) => [t.name, t]));

    // Every audited name must still exist and still be a read.
    for (const name of NEVER_MUTATING_PLANS) {
      const tool = byName.get(name);
      assert.ok(tool, `audited plan ${name} is no longer registered`);
      assert.equal(tool.annotations?.readOnlyHint, true, `${name} lost its read-only classification`);
    }

    // Honest previews keep helping the host auto-approve: the set must not
    // quietly shrink until only executes remain.
    assert.ok(NEVER_MUTATING_PLANS.size >= 18, `audited never-mutating set unexpectedly shrank to ${NEVER_MUTATING_PLANS.size}`);
  });

  it('every write states destructiveHint explicitly (MCP defaults it to true)', async () => {
    const tools = await listTools({});
    const silentWrites = tools
      .filter((t) => t.annotations?.readOnlyHint !== true && typeof t.annotations?.destructiveHint !== 'boolean')
      .map((t) => t.name);
    assert.deepEqual(silentWrites.slice(0, 10), [], `${silentWrites.length} writes leave destructiveHint to the true default`);

    const destructive = tools.filter((t) => t.annotations?.destructiveHint === true).map((t) => t.name);
    assert.ok(destructive.length > 0, 'expected at least one destructive tool');
    const wrong = destructive.filter((t) => !MUTATING_PREFIXES.test(t) && !/snapshot_changes/.test(t));
    assert.deepEqual(wrong, [], `destructive tools outside the mutating verb set: [${wrong.join(', ')}]`);
  });
  it('read verbs are not advertised as destructive', async () => {
    const tools = await listTools({});
    const bad = tools
      .filter((t) => READ_ONLY_PREFIXES.test(t.name) && !MUTATING_PREFIXES.test(t.name) && t.annotations?.destructiveHint === true)
      .map((t) => t.name);
    assert.deepEqual(bad, [], `read tools marked destructive: [${bad.join(', ')}]`);
  });
});

describe('tool surface: budget', () => {
  it('default surface stays inside the tool-count and byte ceilings', async () => {
    const tools = await listTools({});
    const bytes = JSON.stringify(tools).length;
    assert.ok(
      tools.length <= DEFAULT_MAX_TOOLS,
      `default surface grew to ${tools.length} tools (ceiling ${DEFAULT_MAX_TOOLS}) — trim or raise the ceiling deliberately`,
    );
    assert.ok(
      bytes <= DEFAULT_MAX_BYTES,
      `default tools/list grew to ${bytes} bytes (ceiling ${DEFAULT_MAX_BYTES}) — the host pays this every session`,
    );

    const oversized = tools.filter((t) => bytesOf(t) > PER_TOOL_MAX_BYTES).map((t) => `${t.name} (${bytesOf(t)}B)`);
    assert.deepEqual(oversized, [], `tools exceeding ${PER_TOOL_MAX_BYTES}B: [${oversized.join(', ')}]`);
  });

  it('the core preset is small and still covers the daily loop', async () => {
    const tools = await listTools({ SPOTIFY_MCP_TOOLSETS: 'core' });
    const names = new Set(tools.map((t) => t.name));
    const bytes = JSON.stringify(tools).length;

    for (const required of ['search', 'play', 'batch_add_to_playlist', 'export_all_playlists', 'statsfm_recent_streams', 'get_playlist_items', 'save_to_library']) {
      assert.ok(names.has(required), `core preset must include ${required}`);
    }
    assert.ok(
      tools.length <= CORE_MAX_TOOLS,
      `core preset grew to ${tools.length} tools (ceiling ${CORE_MAX_TOOLS})`,
    );
    assert.ok(
      bytes <= CORE_MAX_BYTES,
      `core preset grew to ${bytes} bytes (ceiling ${CORE_MAX_BYTES})`,
    );
    assert.ok(names.size < 608 / 2, `core must be materially smaller than the full surface (got ${names.size})`);
  });

  it('production aggregate gate fails closed on an injected overage', () => {
    const server = new McpServer({ name: 'aggregate-audit', version: '0.0.0' });
    for (let i = 0; i <= AGGREGATE_SURFACE_LIMITS.maxTools; i++) {
      server.tool(`aggregate_probe_${i}`, 'probe', {}, async () => ({ content: [] }));
    }
    const measurement = collectAggregateSurfaceMeasurement(server);
    assert.ok(measurement.toolCount > AGGREGATE_SURFACE_LIMITS.maxTools);
    assert.throws(() => assertAggregateSurfaceBudget(measurement), /aggregate tool surface exceeds budget/);
  });

  it('manifest audit measures every module and enforces every ceiling', async () => {
    const server = new McpServer({ name: 'schema-audit', version: '0.0.0' });
    const client = new SpotifyClient();
    const context = { readOnly: false, isModuleActive: () => true, scopeBlocked: () => false };
    for (const module of REGISTRAR_MANIFEST) registerManifestModule(server, client, module, context);
    const rows = collectModuleSchemaBudgets(server);
    assert.equal(rows.length, REGISTRAR_MANIFEST.length);
    assert.doesNotThrow(() => assertModuleSchemaBudgets(rows));
    assert.doesNotThrow(() => assertAggregateSurfaceBudget(collectAggregateSurfaceMeasurement(server)));

    const tools = new Set(Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools));
    assert.equal(tools.size, rows.reduce((sum, row) => sum + row.toolCount, 0), 'every tool must belong to exactly one manifest module');
    assert.throws(
      () => assertModuleSchemaBudgets([{ ...rows[0], schemaBytes: rows[0].maxSchemaBytes + 1, withinBudget: false }]),
      /exceeds schema budget/,
      'an injected over-budget module must fail the shared gate',
    );
  });

  it('registers the exact core-first name sequence with every module once', async () => {
    const server = new McpServer({ name: 'order-audit', version: '0.0.0' });
    const client = new SpotifyClient();
    const context = { readOnly: false, isModuleActive: () => true, scopeBlocked: () => false };
    for (const module of REGISTRAR_MANIFEST) registerManifestModule(server, client, module, context);
    const names = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    const coreCount = REGISTRAR_MANIFEST.slice(0, 4).reduce((sum, module) => sum + module.baseline.toolCount, 0);
    assert.deepEqual(names.slice(0, coreCount), [
      'search',
      'get_track', 'get_artist', 'get_artist_albums', 'get_album', 'get_album_tracks',
      'get_show', 'get_show_episodes', 'get_episode', 'get_me', 'get_artist_top_tracks',
      'get_available_markets', 'get_several_tracks', 'get_several_albums', 'get_several_artists',
      'get_several_episodes', 'get_several_shows', 'get_several_audiobooks', 'get_several_chapters',
      'get_category', 'search_tracks', 'search_artists', 'search_albums', 'search_playlists',
      'search_shows', 'search_episodes', 'search_audiobooks', 'catalog_batch_lookup',
      'get_artist_singles', 'get_artist_appearances', 'market_validate', 'browse_category_deepdive',
      'show_episode_search',
      'get_saved_tracks', 'get_saved_albums', 'get_saved_shows', 'get_saved_episodes',
      'save_items', 'remove_saved_items', 'check_saved_items', 'save_to_library', 'remove_from_library',
      'get_saved_counts', 'search_saved_albums', 'search_saved_shows', 'search_saved_episodes',
      'search_saved_audiobooks', 'check_in_library', 'search_saved_tracks',
      'get_now_playing', 'get_currently_playing', 'play_from_search', 'play', 'pause', 'skip_next',
      'skip_previous', 'seek', 'set_volume', 'set_shuffle', 'set_repeat', 'get_queue', 'add_to_queue',
      'get_devices', 'transfer_playback', 'handoff',
    ]);
    assert.equal(new Set(names).size, names.length);
    assert.equal(new Set(REGISTRAR_MANIFEST.map((module) => module.key)).size, REGISTRAR_MANIFEST.length);
  });

  it('manifest measurements equal tools/list over InMemoryTransport', async () => {
    const server = new McpServer({ name: 'wire-audit', version: '0.0.0' });
    const client = new SpotifyClient();
    const context = { readOnly: false, isModuleActive: () => true, scopeBlocked: () => false };
    for (const module of REGISTRAR_MANIFEST) registerManifestModule(server, client, module, context);
    const mcpClient = new Client({ name: 'wire-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
    const wireTools = (await mcpClient.listTools()).tools;
    const registry = (server as unknown as { _registeredTools: Record<string, { description?: string; inputSchema?: unknown }> })._registeredTools;
    const wireByName = new Map(wireTools.map((tool) => [tool.name, tool]));
    for (const module of REGISTRAR_MANIFEST) {
      const names = moduleToolNames(server, module.key);
      const measured = names.reduce((sum, name) => sum + serializedSchemaBytes(registry[name] ?? {}), 0);
      const wire = names.reduce((sum, name) => {
        const tool = wireByName.get(name);
        return sum + Buffer.byteLength(JSON.stringify({ description: tool?.description ?? '', inputSchema: tool?.inputSchema ?? {} }), 'utf8');
      }, 0);
      assert.equal(measured, wire, `${module.key} schema bytes must match tools/list wire payload`);
    }
    assert.equal(wireTools.length, Object.keys(registry).length);
    await mcpClient.close();
    await server.close();
  });

  it('toolset_report returns the same per-module measurements', async () => {
    const server = new McpServer({ name: 'report-audit', version: '0.0.0' });
    const client = new SpotifyClient();
    const context = { readOnly: false, isModuleActive: () => true, scopeBlocked: () => false };
    for (const module of REGISTRAR_MANIFEST) registerManifestModule(server, client, module, context);
    const tool = (server as unknown as { _registeredTools: Record<string, { handler: (args: Record<string, never>) => Promise<{ structuredContent: { module_schema_budgets: unknown[] }; content: Array<{ text: string }> }> }> })._registeredTools.toolset_report;
    const result = await tool.handler({});
    assert.deepEqual(result.structuredContent.module_schema_budgets, collectModuleSchemaBudgets(server));
    assert.match(result.content[0].text, /Per-module schema budget/);
  });
});
