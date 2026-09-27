/**
 * The production `tools/list` derivation, shared by the test suite (#663).
 *
 * ## Why this is separate from `live-registry.ts`
 *
 * Two questions about the tool surface have two different owners:
 *
 *   - `live-registry.ts` walks `REGISTRAR_MANIFEST` in process. That is the
 *     in-process derivation, and the gates that ask "does this tool name exist
 *     in the registry" use it.
 *   - This module spawns the real `src/index.ts` over stdio and reads
 *     `tools/list` back off the wire, which is the path
 *     `scripts/surface-census.mjs` measures. It sees the registry AFTER
 *     production gates and finalizers have run — annotation application, the
 *     naming policy, the schema-budget gate, the read-only and toolset trims.
 *
 * A gate that wants the number CI publishes has to ask the wire, not the
 * manifest: the census is what writes the tool count into the generated docs,
 * and a coverage gate measured against a different derivation could be green
 * while the documented surface is not.
 *
 * This was extracted rather than copied. `registry-pin.test.ts` already carried
 * a full stdio harness for exactly this measurement, and a second hand-rolled
 * copy is the failure #659 was filed for: two harnesses that read the same way,
 * are updated separately, and agree until they do not.
 *
 * ## Hermeticity
 *
 * HOME and the token file both point into a fresh `mkdtemp`, so a run cannot
 * read or write Jack's real `~/.spotify-mcp/`. Nothing here binds a port — the
 * transport is stdio, not TCP.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The census environment, copied from `scripts/surface-census.mjs` so the
 * derivation matches the one the generated documentation is written from.
 *
 * `SPOTIFY_MCP_TOOLSETS: 'all'` is the important line: the census describes the
 * DEFAULT registry, and a trimmed or read-only child would serve a subset and
 * make every gated tool look removed.
 */
const CENSUS_ENV: Readonly<Record<string, string>> = Object.freeze({
  SPOTIFY_CLIENT_ID: 'wire-registry',
  SPOTIFY_MCP_TOKEN_FILE: '',
  SPOTIFY_MCP_TOOLSETS: 'all',
  SPOTIFY_MCP_ENABLE_TOOLS: '',
  SPOTIFY_MCP_DISABLE_TOOLS: '',
  SPOTIFY_MCP_READONLY: '0',
  SPOTIFY_MCP_CONFIRM: 'never',
  SPOTIFY_MCP_MAX_ITEMS: '50',
  SPOTIFY_MCP_FETCH_ALL_CAP: '500',
  SPOTIFY_MCP_FRESHNESS_BUDGET: '25',
  SPOTIFY_MCP_HISTORY: '0',
  SPOTIFY_MCP_PROFILE: '',
  SPOTIFY_MCP_MARKET: '',
});

export interface WireTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

interface RpcResult {
  readonly result?: { readonly tools?: WireTool[] };
  readonly error?: unknown;
}

let cached: Promise<WireTool[]> | undefined;

/**
 * Start the real server and return its `tools/list` payload, memoised.
 *
 * A budget breach fails STARTUP, before `initialize` is answered, so every
 * request races the child's exit and re-throws whatever it printed — otherwise
 * a breach reports "timeout waiting for initialize" and hides the measured
 * total the gate had already computed.
 */
export function wireTools(): Promise<WireTool[]> {
  return (cached ??= listWireTools());
}

async function listWireTools(): Promise<WireTool[]> {
  const home = mkdtempSync(join(tmpdir(), 'wire-registry-'));
  const tokenFile = join(home, 'tokens.json');
  writeFileSync(
    tokenFile,
    JSON.stringify({ access_token: 'wire-registry', refresh_token: 'wire-registry', expires_at: Date.now() + 3_600_000 }),
    { mode: 0o600 },
  );

  const child = spawn(process.execPath, ['--import', 'tsx/esm', 'src/index.ts'], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH, HOME: home, ...CENSUS_ENV, SPOTIFY_MCP_TOKEN_FILE: tokenFile },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  let stderr = '';
  const pending = new Map<number, { resolve: (value: RpcResult) => void; reject: (reason: Error) => void }>();
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
      const message = JSON.parse(line) as { id?: number };
      if (typeof message.id !== 'number') continue;
      pending.get(message.id)?.resolve(message as RpcResult);
      pending.delete(message.id);
    }
  });

  let nextId = 0;
  const failAll = (reason: string): void => {
    for (const [, settle] of pending) settle.reject(new Error(reason));
    pending.clear();
  };
  child.on('exit', (code) => {
    if (pending.size > 0) failAll(`the server exited with code ${code} before answering\nstderr:\n${stderr.trim() || '(no stderr)'}`);
  });
  child.on('error', (error) => failAll(`the server failed to start: ${error.message}`));

  const request = (method: string, params: Record<string, unknown> = {}): Promise<RpcResult> => {
    const { promise, resolve, reject } = Promise.withResolvers<RpcResult>();
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => reject(new Error(`timeout waiting for ${method}\nstderr:\n${stderr}`)), 60_000).unref();
    return promise;
  };

  try {
    const init = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'wire-registry', version: '1.0.0' },
    });
    if (init.error !== undefined) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    const listed = await request('tools/list');
    if (listed.error !== undefined) throw new Error(`tools/list failed: ${JSON.stringify(listed.error)}\nstderr:\n${stderr}`);
    const tools = listed.result?.tools;
    if (!Array.isArray(tools)) throw new Error('tools/list must return an array');
    return tools;
  } finally {
    child.stdin.end();
    setTimeout(() => child.kill('SIGKILL'), 1_500).unref();
  }
}

/** The served tool names, sorted. */
export async function wireToolNames(): Promise<string[]> {
  return (await wireTools()).map((tool) => tool.name).sort();
}
