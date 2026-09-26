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
  applyToolAnnotations,
  collectAggregateSurfaceMeasurement,
  collectModuleSchemaBudgets,
  NEVER_MUTATING_PLANS,
  READ_ONLY_OVERRIDES,
  moduleToolNames,
  manifestEntry,
  serializedSchemaBytes,
  registerManifestModule,
  REGISTRAR_MANIFEST,
  installToolErrorBoundary,
  TOOL_SURFACE_BUDGET,
  STABLE_LIST_DEFAULTS,
  assertToolNamingPolicy,
  toolNamingMetadata,
} from '../src/tools/annotations.js';
import { SpotifyClient } from '../src/client.js';

const REPO_ROOT = join(import.meta.dirname, '..');

const DEFAULT_MAX_TOOLS = AGGREGATE_SURFACE_LIMITS.maxTools;
const DEFAULT_MAX_BYTES = AGGREGATE_SURFACE_LIMITS.maxBytes;
// Read the ceilings production enforces at startup; a literal copy here would
// keep passing after a ceiling is lowered and fail after one is raised.
const PER_TOOL_MAX_BYTES = TOOL_SURFACE_BUDGET.perToolMaxBytes;
const CORE_MAX_TOOLS = TOOL_SURFACE_BUDGET.coreMaxTools;
const CORE_MAX_BYTES = TOOL_SURFACE_BUDGET.coreMaxBytes;

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
    env: { ...process.env, SPOTIFY_CLIENT_ID: 'surface-test', SPOTIFY_MCP_TOOLSETS: 'all', ENABLE_TOOLS: '', DISABLE_TOOLS: '', SPOTIFY_SCOPES: '', ...env },
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

/**
 * A token in a tool description that could be naming another tool. The shape is
 * the v2 naming policy's: a lower_snake_case name with at least one underscore.
 * Requiring the underscore is what keeps ordinary English prose out, and it
 * also means a registration key can never collide — every registration key is
 * a single bare word (`library`, `doctor`, `playback`).
 */
const TOOL_NAME_SHAPE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

/**
 * lower_snake_case names that appear in descriptions but are NOT tools: keys a
 * tool writes into its own result — report row keys, envelope flags, paging
 * cursors, and the free-form keys of an object argument.
 *
 * Tool names and parameter names are deliberately absent — both are derived
 * from the surface at test time, so a renamed tool or a dropped parameter
 * stops being allowlisted the moment production drops it, instead of
 * surviving here and masking a real drift. Every entry below was read off the
 * description that produced it; a tool name belongs in the registry, never
 * here, so allowlisting a cross-reference mistake is not an escape hatch.
 */
const OUTPUT_FIELD_NAMES = new Set<string>([
  // Envelope / completeness flags a tool reports about its own result.
  'absent_keys',
  'cap_reached',
  'scan_complete',
  'search_errors',
  'search_failed',
  'sidecar_truncated',
  'truncated_collections',
  // StructuredContent keys the walk/disclosure work added and ARCHITECTURE.md
  // now names. Neither is a tool or a parameter; both are what a call reports
  // back about its own result. #786's list_all_chapters names the same key
  // for the same reason, so this stays one entry with two provenance comments.
  'truncated_by_cap',
  // #757: restore_library_snapshot documents the snapshot schema version it
  // now refuses on. A key inside the file it reads, not a tool or parameter.
  'schema_version',
  // Cursors and caps a call reports back so the next call can continue.
  // #809: create_smart_playlist names the candidate-pool ceiling it reports.
  'pool_capped', 'pool_cap',
  'fetch_all_cap',
  'from_token',
  'next_offset',
  // Row keys and counters inside a result payload.
  'added_by',
  'album_type',
  'artists_scanned',
  'available_markets',
  'catalogue_total',
  'dir_bytes',
  'exported_at',
  'followed_at',
  'fully_played',
  'is_local',
  'is_playable',
  'item_count',
  'library_requests',
  'new_entry',
  'oldest_created',
  // list_backups names the store envelope's oldest-survivor retention key. That
  // is `oldest_retention_until`, NOT the per-snapshot `_meta.retention_until`
  // listed further down — the tool description previously named the wrong one
  // of the pair, so this entry is load-bearing for the corrected prose.
  'oldest_retention_until',
  'played_at',
  'playlist_era',
  'quietest_hour',
  'quietest_tied_hours',
  'resume_point',
  'retention_until',
  'saved_at',
  'shows_checked',
  'singles_capped',
  'supports_volume',
  'taken_at',
  'watchlist_size',
  // A key of a free-form object argument, not an enum member of one.
  'last_refreshed',
]);

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
    // The audited read-only overrides are the only names whose MUTATING_PREFIXES
    // verdict the classifier is allowed to flip. NEVER_MUTATING_PLANS audits
    // *_plan/*_preview handlers; READ_ONLY_OVERRIDES audits OVERRIDES entries
    // that mark a verb-patterned name as a read (#1101).
    const leaks = tools.filter((t) => MUTATING_PREFIXES.test(t.name)
      && !NEVER_MUTATING_PLANS.has(t.name)
      && !READ_ONLY_OVERRIDES.has(t.name)
      && t.annotations?.readOnlyHint === true
    ).map((t) => t.name);
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

  it('local feedback aliases are explicit non-read-only writes', async () => {
    const tools = await listTools({});
    for (const name of ['statsfm_record_feedback', 'record_feedback']) {
      const tool = tools.find((entry) => entry.name === name);
      assert.ok(tool, `${name} is not registered`);
      assert.notEqual(tool.annotations?.readOnlyHint, true, `${name} is advertised read-only`);
      assert.equal(tool.annotations?.destructiveHint, false, `${name} must explicitly be non-destructive`);
    }
  });
  it('read verbs are not advertised as destructive', async () => {
    const tools = await listTools({});
    const bad = tools
      .filter((t) => READ_ONLY_PREFIXES.test(t.name) && !MUTATING_PREFIXES.test(t.name) && t.annotations?.destructiveHint === true)
      .map((t) => t.name);
    assert.deepEqual(bad, [], `read tools marked destructive: [${bad.join(', ')}]`);
  });

  it('keeps the read-only freshness radar visible in READONLY mode', async () => {
    const tools = await listTools({ SPOTIFY_MCP_READONLY: '1' });
    const freshness = tools.find((tool) => tool.name === 'whats_new');
    assert.ok(freshness, 'whats_new must remain visible in READONLY mode');
    assert.equal(freshness.annotations?.readOnlyHint, true);
  });
  it('enforces v2 naming and retires the episode alias', async () => {
    const tools = await listTools({});
    const names = tools.map((tool) => tool.name);
    assert.equal(new Set(names).size, names.length, 'tools/list contains duplicate names');
    assert.equal(names.includes('get_show_episodes'), false, 'deprecated endpoint alias remains reachable');
    assert.ok(names.includes('list_show_episodes'), 'canonical episode lister is missing');
    assert.doesNotThrow(() => assertToolNamingPolicy(names));
    for (const tool of tools) {
      const metadata = toolNamingMetadata(tool.name);
      assert.equal(metadata.classification, tool.annotations?.readOnlyHint === true ? 'read' : 'write', tool.name);
      const properties = (tool.inputSchema as { properties?: Record<string, { description?: string }> } | undefined)?.properties ?? {};
      for (const [property, schema] of Object.entries(properties)) {
        assert.equal(typeof schema.description, 'string', `${tool.name}.${property} has no description`);
        assert.notEqual(schema.description?.trim(), '', `${tool.name}.${property} has an empty description`);
      }
    }
  });

  it('exposes exactly the promised stable defaults, and only where declared', async () => {
    const tools = await listTools({});
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const [name, promised] of Object.entries(STABLE_LIST_DEFAULTS)) {
      const tool = byName.get(name);
      assert.ok(tool, `STABLE_LIST_DEFAULTS names unregistered tool ${name}`);
      const properties = (tool.inputSchema as { properties?: Record<string, { default?: unknown }> } | undefined)?.properties;
      assert.ok(properties, `${name} must expose an input schema`);
      for (const [property, value] of Object.entries(promised)) {
        // No `if (properties.x)` guard: a promised default the tool does not
        // declare is dead config, and a guard would let it ship unnoticed.
        assert.ok(properties[property], `${name} promises a default for ${property} but does not declare it`);
        assert.equal(properties[property].default, value, `${name}.${property} default`);
      }
    }
  });

  it('no description names a tool that is not registered', async () => {
    const tools = await listTools({});
    const registered = new Set(tools.map((tool) => tool.name));
    // Parameters and enum values are derived from the live surface, never
    // listed: a parameter production drops must stop being allowlisted the
    // moment it goes, instead of surviving here and masking real drift.
    const parameters = new Set<string>();
    const enumValues = new Set<string>();
    const collectEnums = (node: unknown): void => {
      if (Array.isArray(node)) return void node.forEach(collectEnums);
      if (!node || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      if (Array.isArray(record.enum)) {
        for (const value of record.enum) if (typeof value === 'string') enumValues.add(value);
      }
      for (const value of Object.values(record)) collectEnums(value);
    };
    for (const tool of tools) {
      const properties = (tool.inputSchema as { properties?: Record<string, { description?: string }> } | undefined)?.properties ?? {};
      for (const property of Object.keys(properties)) parameters.add(property);
      collectEnums(tool.inputSchema);
    }

    // Cross-tool references are how an agent routes a second call, so a name
    // that resolves to nothing is worse than no name at all. Real drift:
    // restore_library_snapshot pointed at `backup_library_snapshot`, a tool
    // that was never registered anywhere (#756).
    const dangling: string[] = [];
    for (const tool of tools) {
      const properties = (tool.inputSchema as { properties?: Record<string, { description?: string }> } | undefined)?.properties ?? {};
      const surfaces: Array<[string, string]> = [[tool.name, tool.description ?? '']];
      for (const [property, schema] of Object.entries(properties)) {
        surfaces.push([`${tool.name}.${property}`, schema.description ?? '']);
      }
      for (const [where, text] of surfaces) {
        for (const token of text.match(TOOL_NAME_SHAPE) ?? []) {
          if (registered.has(token) || parameters.has(token) || enumValues.has(token) || OUTPUT_FIELD_NAMES.has(token)) continue;
          dangling.push(`${where} names unregistered tool ${token}`);
        }
      }
    }
    assert.deepEqual(dangling, [], `descriptions name tools that do not exist:\n- ${dangling.join('\n- ')}`);
    // Presence floor: the scan above cannot pass on a degenerate surface, and
    // the shape regex must actually be matching (rename the constant and this
    // catches it).
    assert.ok(tools.length > 500, `expected the full surface, got ${tools.length} tools`);
    const restore = tools.find((tool) => tool.name === 'restore_library_snapshot');
    assert.match(restore?.description ?? '', /\bbackup_library\b/);
    assert.match(restore?.description ?? '', /\blist_backups\b/);
    const backupPath = (restore?.inputSchema as { properties?: Record<string, { description?: string }> } | undefined)?.properties?.backup_path;
    assert.match(backupPath?.description ?? '', /\bbackup_library\b/);
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

  it('preserves operation-specific canonical and legacy playlist bounds', async () => {
    const tools = await listTools({});
    const expected = {
      playlist_subtract: { minItems: 1, maxItems: 10 },
      playlist_difference_plan: { minItems: 1, maxItems: 5 },
      find_duplicate_tracks_across_playlists: { minItems: 2, maxItems: 20 },
    } as const;
    const aliases = {
      playlist_subtract: 'subtract_playlist_ids',
      playlist_difference_plan: 'subtract_playlist_ids',
      find_duplicate_tracks_across_playlists: 'playlist_ids',
    } as const;

    for (const [name, bounds] of Object.entries(expected)) {
      const schema = tools.find((tool) => tool.name === name)?.inputSchema as {
        properties?: Record<string, { minItems?: number; maxItems?: number }>;
      } | undefined;
      assert.ok(schema, `${name} must expose an input schema`);
      assert.deepEqual(
        [schema.properties?.playlists?.minItems, schema.properties?.playlists?.maxItems],
        [bounds.minItems, bounds.maxItems],
        `${name}.playlists bounds`,
      );
      const alias = aliases[name as keyof typeof aliases];
      assert.deepEqual(
        [schema.properties?.[alias]?.minItems, schema.properties?.[alias]?.maxItems],
        [bounds.minItems, bounds.maxItems],
        `${name}.${alias} bounds`,
      );
    }
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
    // Only the measurements are injected: the verdict is recomputed by the gate,
    // so a weakened comparison in the row builder cannot hide behind a
    // hand-supplied `withinBudget: true`.
    assert.throws(
      () => assertModuleSchemaBudgets([{ ...rows[0], schemaBytes: rows[0].maxSchemaBytes + 1, withinBudget: true }]),
      /exceeds schema budget/,
      'an over-budget measurement must fail the shared gate whatever the flag says',
    );
    assert.throws(
      () => assertModuleSchemaBudgets([{ ...rows[0], toolCount: rows[0].maxToolCount + 1, withinBudget: true }]),
      /exceeds schema budget/,
      'an over-count module must fail too',
    );
    assert.doesNotThrow(
      () => assertModuleSchemaBudgets([{ ...rows[0], schemaBytes: rows[0].maxSchemaBytes, toolCount: rows[0].maxToolCount, withinBudget: false }]),
      'a module exactly at its ceiling is within budget even if a flag says otherwise',
    );
  });

  it('sizes a gated module ceiling for the opted-in surface, not just the default (#1128)', () => {
    // The failure this pins: a module whose tool surface depends on config has
    // a baseline describing the DEFAULT surface, because the census strips
    // SPOTIFY_* and the generated tables report an ordinary install. Sizing the
    // ceiling on that baseline alone makes an opted-in process register more
    // tools than the ceiling allows and the server refuses to start — while the
    // default path stays green in CI, so only a user who sets the flag finds
    // out their server no longer boots.
    //
    // The figures are the ones #1128 measured on `integrate/b971`, the branch
    // that carries the analytics opt-in: 17 tools / 13,339B with the opt-in
    // off, 24 / 19,594B with it on. They are a fixture measured on that branch,
    // not a measurement of main — the gate it introduces has not landed, so
    // `swarm3analytics` still registers all 24 tools unconditionally and no
    // manifest row declares a `gatedSurface` yet. What is pinned here is the
    // derivation, which must be right before the first gated row exists.
    const registrar = (server: McpServer) => { server.tool('gated_probe', 'probe', {}, async () => ({ content: [] })); };
    const DEFAULT_SURFACE: readonly [number, number] = [17, 13_339];
    const OPTED_IN_SURFACE: readonly [number, number] = [24, 19_594];

    const ungated = manifestEntry('probe', 'probe', 'src/tools/probe.ts', registrar, DEFAULT_SURFACE);
    // The ungated derivation is unchanged: a ceiling is still one tool and 10%
    // over the baseline, so an ordinary module grows visibly.
    assert.equal(ungated.ceiling.toolCount, 18);
    assert.equal(ungated.ceiling.schemaBytes, Math.ceil(13_339 * 1.1));

    const gated = manifestEntry('probe', 'probe', 'src/tools/probe.ts', registrar, DEFAULT_SURFACE, {
      gatedSurface: {
        gatedBy: 'SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS',
        toolCount: OPTED_IN_SURFACE[0],
        schemaBytes: OPTED_IN_SURFACE[1],
      },
    });

    // The ceiling is sized for the LARGER of the two surfaces — this is the
    // allowance whose absence made the opted-in server refuse to boot.
    assert.equal(gated.ceiling.toolCount, 25, 'one tool over the opted-in surface, not over the default');
    assert.equal(gated.ceiling.schemaBytes, Math.ceil(OPTED_IN_SURFACE[1] * 1.1));

    // The baseline is untouched: the census still measures the default surface,
    // so the generated surface tables keep reporting an ordinary install.
    assert.equal(gated.baseline.toolCount, 17);
    assert.equal(gated.baseline.schemaBytes, 13_339);

    // A gated surface SMALLER than the baseline is a mis-declaration, not a
    // licence to shrink the ceiling: the census measures the default, so
    // shrinking below it would fail an ordinary install.
    const shrinks = manifestEntry('probe', 'probe', 'src/tools/probe.ts', registrar, DEFAULT_SURFACE, {
      gatedSurface: { gatedBy: 'SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS', toolCount: 12, schemaBytes: 9_000 },
    });
    assert.equal(shrinks.ceiling.toolCount, 18, 'Math.max must not let a gated figure below the baseline win');
    assert.equal(shrinks.ceiling.schemaBytes, Math.ceil(13_339 * 1.1));

    // Both surfaces must now clear the module gate. Without the allowance the
    // opted-in row is exactly the measurement the gate rejected.
    const row = (toolCount: number, schemaBytes: number) => ({
      module: gated.key,
      registrationKey: gated.registrationKey,
      file: gated.file,
      status: 'active' as const,
      toolCount,
      schemaBytes,
      baselineToolCount: gated.baseline.toolCount,
      baselineSchemaBytes: gated.baseline.schemaBytes,
      maxToolCount: gated.ceiling.toolCount,
      maxSchemaBytes: gated.ceiling.schemaBytes,
      withinBudget: true,
    });
    assert.doesNotThrow(() => assertModuleSchemaBudgets([row(24, 19_594)]), 'the opted-in surface must pass');
    assert.doesNotThrow(() => assertModuleSchemaBudgets([row(17, 13_339)]), 'the default surface must pass');

    // …and it is still a ceiling, not a rubber stamp: a registrar that grows
    // past the opted-in surface still fails and forces a manifest edit.
    assert.throws(() => assertModuleSchemaBudgets([row(26, 19_594)]), /exceeds schema budget/);
    assert.throws(() => assertModuleSchemaBudgets([row(25, Math.ceil(19_594 * 1.1) + 1)]), /exceeds schema budget/);
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
      'get_show', 'get_episode', 'get_me', 'get_artist_top_tracks',
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

  it('manifest measurements equal the finalized production tools/list projection', async () => {
    const server = new McpServer({ name: 'wire-audit', version: '0.0.0' });
    const client = new SpotifyClient();
    const context = { readOnly: false, isModuleActive: () => true, scopeBlocked: () => false };
    for (const module of REGISTRAR_MANIFEST) registerManifestModule(server, client, module, context);
    applyToolAnnotations(server);
    installToolErrorBoundary(server);
    const mcpClient = new Client({ name: 'wire-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
    const wireTools = (await mcpClient.listTools()).tools;
    const registry = (server as unknown as { _registeredTools: Record<string, { description?: string; inputSchema?: unknown }> })._registeredTools;
    const wireByName = new Map(wireTools.map((tool) => [tool.name, tool]));
    for (const module of REGISTRAR_MANIFEST) {
      const names = moduleToolNames(server, module.key);
      const measured = names.reduce((sum, name) => sum + serializedSchemaBytes(registry[name] ?? {}, name), 0);
      const wire = names.reduce((sum, name) => {
        const tool = wireByName.get(name);
        return sum + Buffer.byteLength(JSON.stringify({ description: tool?.description ?? '', inputSchema: tool?.inputSchema ?? {} }), 'utf8');
      }, 0);
      assert.equal(measured, wire, `${module.key} schema bytes must match tools/list wire payload`);
    }
    assert.equal(collectAggregateSurfaceMeasurement(server).schemaBytes, Buffer.byteLength(JSON.stringify(wireTools), 'utf8'));
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
