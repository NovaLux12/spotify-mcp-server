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
import {
  NEVER_MUTATING_PLANS,
  TOOL_SURFACE_BUDGET,
  assertToolNamingPolicy,
  toolNamingMetadata,
  toolErrorResult,
} from '../src/tools/annotations.js';
import { truncateItems } from '../src/shaping.js';

const REPO_ROOT = join(import.meta.dirname, '..');

/** Ceilings. Raising one is a deliberate act with a measured reason. */
const DEFAULT_MAX_TOOLS = TOOL_SURFACE_BUDGET.defaultMaxTools;
const DEFAULT_MAX_BYTES = TOOL_SURFACE_BUDGET.defaultMaxBytes;
const PER_TOOL_MAX_BYTES = TOOL_SURFACE_BUDGET.perToolMaxBytes;
const CORE_MAX_TOOLS = TOOL_SURFACE_BUDGET.coreMaxTools;
const CORE_MAX_BYTES = TOOL_SURFACE_BUDGET.coreMaxBytes;

interface Tool {
  name: string;
  description?: string;
  inputSchema?: { additionalProperties?: boolean; properties?: Record<string, { description?: string; default?: unknown }> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

interface JsonRpc {
  id?: number;
  result?: { tools?: Tool[]; content?: Array<{ type: string; text?: string }>; structuredContent?: { error?: { kind?: string; param?: string | null } }; isError?: boolean };
  error?: { code: number; message: string };
}

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

async function callTool(name: string, args: Record<string, unknown>): Promise<JsonRpc> {
  const child = spawn('node', ['--import', 'tsx/esm', 'src/index.ts'], {
    cwd: REPO_ROOT,
    env: { ...process.env, SPOTIFY_CLIENT_ID: 'surface-test' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  let stderr = '';
  const pending = new Map<number, (value: JsonRpc) => void>();
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line) as JsonRpc;
      const resolve = typeof message.id === 'number' ? pending.get(message.id) : undefined;
      if (resolve && typeof message.id === 'number') { pending.delete(message.id); resolve(message); }
    }
  });
  let id = 0;
  const request = (method: string, params: Record<string, unknown>): Promise<JsonRpc> => {
    const requestId = ++id;
    const promise = new Promise<JsonRpc>((resolve, reject) => {
      pending.set(requestId, resolve);
      setTimeout(() => reject(new Error(`timeout waiting for ${method}\n${stderr}`)), 20_000).unref();
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
    return promise;
  };
  try {
    await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'surface-test', version: '1.0.0' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    return await request('tools/call', { name, arguments: args });
  } finally {
    child.stdin.end();
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

  it('has unique names, explicit naming budgets, and complete schemas', async () => {
    const tools = await listTools({});
    const names = tools.map((tool) => tool.name);
    assert.equal(new Set(names).size, names.length, 'tools/list contains duplicate names');
    assert.equal(names.includes('get_show_episodes'), false, 'deprecated endpoint alias remains reachable');
    assert.ok(names.includes('list_show_episodes'), 'canonical episode lister is missing');
    assert.doesNotThrow(() => assertToolNamingPolicy(names));
    for (const tool of tools) {
      const metadata = toolNamingMetadata(tool.name);
      assert.equal(metadata.classification, tool.annotations?.readOnlyHint === true ? 'read' : 'write');
      for (const [property, schema] of Object.entries(tool.inputSchema?.properties ?? {})) {
        assert.equal(typeof schema.description, 'string', `${tool.name}.${property} has no description`);
        assert.notEqual(schema.description?.trim(), '', `${tool.name}.${property} has an empty description`);
      }
    }
  });

  it('exposes stable defaults for shared list controls', async () => {
    const tools = await listTools({});
    for (const name of ['search', 'get_saved_tracks', 'get_artist_top_tracks']) {
      const properties = tools.find((tool) => tool.name === name)?.inputSchema?.properties;
      assert.ok(properties, `${name} must expose an input schema`);
      if (properties.response_format) assert.equal(properties.response_format.default, 'concise');
      if (properties.max_results) assert.equal(properties.max_results.default, 50);
      if (properties.offset) assert.equal(properties.offset.default, 0);
      if (properties.fetch_all) assert.equal(properties.fetch_all.default, false);
    }
  });

  it('truncation advice names only declared continuation controls', () => {
    const items = Array.from({ length: 5 }, (_, index) => index);
    assert.match(truncateItems(items, 2, { maxResults: true }).footer ?? '', /max_results/);
    assert.doesNotMatch(truncateItems(items, 2, { maxResults: true }).footer ?? '', /offset|fetch_all/);
    assert.doesNotMatch(truncateItems(items, 2, {}).footer ?? '', /max_results|offset|fetch_all/);
  });

  it('maps failures to a machine-readable error envelope', () => {
    const rateLimited = toolErrorResult('search', { status: 429, retryAfterSec: 17, reason: 'RATE_LIMITED' });
    assert.equal(rateLimited.structuredContent.error.kind, 'rate_limited');

    assert.equal(rateLimited.structuredContent.error.retryAfterSec, 17);
    assert.equal(rateLimited.structuredContent.error.reason, 'RATE_LIMITED');
    const unknownParam = toolErrorResult('search', new Error('bad key'), { kind: 'unknown_param', param: 'queryy', suggestions: ['query'] });
    assert.equal(unknownParam.structuredContent.error.kind, 'unknown_param');
    assert.match(unknownParam.content[0].text, /search/);
  });
  it('rejects unknown arguments before the tool handler runs', async () => {
    const response = await callTool('verify_receipt', { receipt_id: 'r1', recpt_id: 'typo' });
    assert.equal(response.error, undefined);
    assert.equal(response.result?.isError, true);
    assert.equal(response.result?.structuredContent?.error?.kind, 'unknown_param');
    assert.equal(response.result?.structuredContent?.error?.param, 'recpt_id');
    assert.match(response.result?.content?.[0]?.text ?? '', /verify_receipt/);
  });
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
});
