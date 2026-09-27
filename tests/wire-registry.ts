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
 * That argument came back one layer down. This file's own harness was itself a
 * hand-rolled copy of `helpers/stdio-child.ts`, it predated the helper, and it
 * disagreed with the helper about the one field that matters on a killed child
 * (#1405). It now uses `StdioJsonRpcChild` directly — see the note at the
 * spawn. `tests/child-exit-gate.test.ts` is what keeps the next copy from
 * appearing.
 *
 * ## Hermeticity
 *
 * HOME and the token file both point into a fresh `mkdtemp`, so a run cannot
 * read or write Jack's real `~/.spotify-mcp/`. Nothing here binds a port — the
 * transport is stdio, not TCP.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StdioJsonRpcChild } from './helpers/stdio-child.js';

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

  // The shared harness, not a second copy of it (#1405, #1379).
  //
  // This file carried its own hand-rolled harness whose `exit` handler took only
  // `code`:
  //
  //     child.on('exit', (code) => { … `exited with code ${code}` … });
  //
  // Node supplies `(code, signal)`, and a signalled child has `code === null`,
  // so every SIGKILL — the OOM killer, a host under pressure — was reported as
  // "exited with code null". The signal was on the event and was thrown away in
  // the parameter list, which is the AGENTS.md §6 shape: a value that exists,
  // is discarded, and leaves a message that is confidently wrong about the cause.
  //
  // `StdioJsonRpcChild` already did this correctly (it latches the death,
  // records the signal, and keeps first-cause-wins so a following EPIPE cannot
  // overwrite the SIGKILL). Migrating is the fix and the consolidation #1379
  // asks for: one implementation rather than a correct one and a lossy one.
  //
  // The env is passed explicitly and stays minimal — `PATH`, a temp `HOME`, and
  // `CENSUS_ENV` — because booting with *no* inherited environment is part of
  // what this derivation proves. `hermeticServerEnv` spreads `process.env`, so
  // using it here would quietly stop testing that.
  const child = StdioJsonRpcChild.spawn({
    label: 'wire-registry',
    command: process.execPath,
    args: ['--import', 'tsx/esm', 'src/index.ts'],
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH, HOME: home, ...CENSUS_ENV, SPOTIFY_MCP_TOKEN_FILE: tokenFile },
  });

  try {
    await child.initialize('wire-registry');
    const listed = await child.request('tools/list');
    if (listed.error !== undefined) {
      throw new Error(`tools/list failed: ${JSON.stringify(listed.error)}\nchild stderr:\n${child.stderr}`);
    }
    const tools = listed.result?.tools;
    if (!Array.isArray(tools)) throw new Error('tools/list must return an array');
    return tools as WireTool[];
  } finally {
    // `dispose()` rather than the old `stdin.end()` + unref'd SIGKILL: the old
    // teardown left the child's stdio streams registered in the event loop, and
    // a reaped child that inherited a descriptor from a survivor can hold a
    // test file open for the rest of the run.
    await child.dispose();
  }
}

/** The served tool names, sorted. */
export async function wireToolNames(): Promise<string[]> {
  return (await wireTools()).map((tool) => tool.name).sort();
}
