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

const REPO_ROOT = join(import.meta.dirname, '..');

/** Ceilings. Raising one is a deliberate act with a measured reason. */
const DEFAULT_MAX_TOOLS = 620;          // today 608
const DEFAULT_MAX_BYTES = 700_000;      // today 632,970 (annotations included)
const PER_TOOL_MAX_BYTES = 6_000;       // worst single schema+description today
const CORE_MAX_TOOLS = 200;             // today 157
const CORE_MAX_BYTES = 220_000;         // today 162,592

interface Tool {
  name: string;
  title?: string;
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

describe('tool surface: annotations', () => {
  it('every tool carries a title and an explicit readOnlyHint', async () => {
    const tools = await listTools({});
    const missingTitle = tools.filter((t) => !t.title).map((t) => t.name);
    const missingHint = tools.filter((t) => typeof t.annotations?.readOnlyHint !== 'boolean').map((t) => t.name);
    assert.deepEqual(missingTitle.slice(0, 10), [], `${missingTitle.length} tools without a title`);
    assert.deepEqual(missingHint.slice(0, 10), [], `${missingHint.length} tools without readOnlyHint`);
  });

  it('never advertises a destructive verb as read-only, nor a read verb as destructive', async () => {
    const tools = await listTools({});
    const DESTRUCTIVE = /^(remove|delete|unfollow|unsave|clear|clean|purge|drop|trash|replace|reset|cull|prune|wipe|empty|revoke|erase)/;
    const READ = /^(get|list|search|check|inspect|find|show|describe|report|count|analyze|analyse|validate|compare|diff)/;

    const badReadOnly = tools.filter((t) => DESTRUCTIVE.test(t.name) && t.annotations?.readOnlyHint === true).map((t) => t.name);
    const badDestructive = tools.filter((t) => READ.test(t.name) && t.annotations?.destructiveHint === true).map((t) => t.name);
    assert.deepEqual(badReadOnly, [], `destructive tools marked read-only: [${badReadOnly.join(', ')}]`);
    assert.deepEqual(badDestructive, [], `read tools marked destructive: [${badDestructive.join(', ')}]`);

    // Both classes must actually exist, so the assertions above cannot pass on an empty surface.
    assert.ok(tools.some((t) => t.annotations?.readOnlyHint === true), 'expected read-only tools');
    assert.ok(tools.some((t) => t.annotations?.destructiveHint === true), 'expected destructive tools');
    assert.ok(tools.filter((t) => t.annotations?.readOnlyHint === true).length > 100, 'expected >100 read-only tools');
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
