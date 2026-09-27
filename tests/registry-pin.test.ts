/**
 * Registry pin (#662) — the four contracts that hold the tool surface still.
 *
 * What already existed, and what this file deliberately does NOT repeat:
 *
 *   - `tests/tool.surface.test.ts` pins the naming policy, the annotation
 *     contract, the per-module CEILINGS, the aggregate ceiling, the 4-module
 *     core-first name prefix, the manifest-vs-wire byte agreement and
 *     `toolset_report`. All of it still passes and is not duplicated here.
 *   - `tests/arch-inventory.test.ts` pins `toolInputSchemas` key count and that
 *     every tool exposes `inputSchema.properties`, read out of the census, plus
 *     the generated-doc count sync.
 *
 * The gap those two left, found by mutating this tree and watching what stayed
 * green — see the module-shrink probe in the PR body:
 *
 *   1. **No lower bound.** Every manifest baseline is an exact record (verified:
 *      592 measured = 592 summed), but `assertModuleSchemaBudgets` only
 *      compares against `ceiling = baseline + 1`, so a module that loses tools
 *      is still "within budget". Deleting the whole `unfollow_artists`
 *      registration left the entire `tool surface: budget` suite GREEN. The
 *      only red came from an unrelated doc-count gate, and it reported
 *      "expected **608 tools**" — a stale number from a two-releases-old
 *      issue — not the tool that vanished.
 *   2. **Only 64 of 592 names are pinned.** The core-first sequence covers the
 *      first four manifest modules; the other 62 modules' names are unasserted
 *      anywhere, so a rename outside that prefix is silent.
 *   3. **Duplicates abort, but opaquely.** The SDK throws
 *      `Tool search is already registered` before any assertion runs, naming
 *      the tool and neither module.
 *   4. **The byte ceiling was measured in the wrong unit.**
 *      `tool.surface.test.ts` asserts `JSON.stringify(tools).length`, which
 *      counts UTF-16 code units; the production startup gate budgets UTF-8
 *      bytes. Measured 602,272 vs 603,766 — a 1,494B undercount against a
 *      ceiling with 234B of real headroom, on a surface where 404 tools
 *      already contain non-ASCII text.
 *
 * The pinned surface lives in `tests/registry-surface.json`. It is a lockfile,
 * not a second registrar list: every module key in it must match
 * `REGISTRAR_MANIFEST` and every per-module count must match the manifest's own
 * baseline, so the manifest stays authoritative and the JSON only adds the
 * name-level detail the manifest does not carry.
 *
 * Regenerate deliberately, after reviewing the diff:
 *   REGISTRY_PIN_WRITE=1 node --import tsx --test tests/registry-pin.test.ts
 *
 * Run: node --import tsx --test tests/registry-pin.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SpotifyClient } from '../src/client.js';
import {
  AGGREGATE_SURFACE_LIMITS,
  loadManifestRegistrars,
  moduleToolNames,
  registerManifestModule,
  registerManifestModules,
  REGISTRAR_MANIFEST,
  type RegistrarManifestContext,
  type RegistrarManifestEntry,
} from '../src/tools/annotations.js';

const REPO_ROOT = join(import.meta.dirname, '..');
const PIN_PATH = join(REPO_ROOT, 'tests/registry-surface.json');

interface WireTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface RegistryPin {
  readonly generatedBy: string;
  readonly modules: Record<string, string[]>;
  readonly flat: string[];
}

// ---------------------------------------------------------------------------
// Measurement helpers
// ---------------------------------------------------------------------------

/**
 * Register every manifest module against a real McpServer, in manifest order,
 * and return the exact tool name each module owns.
 *
 * `registerManifestModules` is the production path (#906): it resolves each
 * module's lazy registrar and then registers in manifest order, so this
 * measures the sequence `src/index.ts` actually serves rather than a parallel
 * one. `registerManifestModule` records ownership as the names that appeared
 * during that module's own registrar call, so a module's list is derived from
 * the registry rather than restated from the manifest.
 */
async function measureManifestOwnership(): Promise<Map<string, string[]>> {
  const server = new McpServer({ name: 'registry-pin', version: '0.0.0' });
  const client = new SpotifyClient();
  const context: RegistrarManifestContext = { readOnly: false, isModuleActive: () => true, scopeBlocked: () => false };
  await registerManifestModules(server, client, context);
  return new Map(REGISTRAR_MANIFEST.map((module) => [module.key, [...moduleToolNames(server, module.key)]]));
}

/**
 * Drive the real production server over stdio and return its `tools/list`
 * payload, in the same hermetic shape `scripts/surface-census.mjs` uses: HOME
 * and the token file both point into a fresh mkdtemp, so a run cannot touch
 * Jack's real `~/.spotify-mcp/`.
 */
async function listWireTools(): Promise<WireTool[]> {
  const home = mkdtempSync(join(tmpdir(), 'registry-pin-'));
  const tokenFile = join(home, 'tokens.json');
  writeFileSync(tokenFile, JSON.stringify({ access_token: 'registry-pin', refresh_token: 'registry-pin', expires_at: Date.now() + 3_600_000 }), { mode: 0o600 });

  const child = spawn('node', ['--import', 'tsx/esm', 'src/index.ts'], {
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      SPOTIFY_CLIENT_ID: 'registry-pin',
      SPOTIFY_MCP_TOOLSETS: 'all',
      SPOTIFY_MCP_TOKEN_FILE: tokenFile,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  let stderr = '';
  const pending = new Map<number, { resolve: (value: { result?: { tools?: WireTool[] }; error?: unknown }) => void; reject: (reason: Error) => void }>();
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
      pending.get(message.id)?.resolve(message as { result?: { tools?: WireTool[] } });
      pending.delete(message.id);
    }
  });

  let nextId = 0;
  // A budget breach fails STARTUP, before `initialize` is ever answered: the
  // aggregate gate in `src/index.ts` throws and the process exits. Waiting out
  // the request timeout would report "timeout waiting for initialize" and hide
  // the measured total the gate already computed — which is exactly what
  // acceptance criterion #3 asks a breach to print. Race every request against
  // the child's exit and re-throw whatever it printed.
  const failAll = (reason: string): void => {
    for (const [, settle] of pending) settle.reject(new Error(reason));
    pending.clear();
  };
  child.on('exit', (code) => {
    if (pending.size > 0) {
      failAll(`the server exited with code ${code} before answering\nstderr:\n${stderr.trim() || '(no stderr)'}`);
    }
  });
  child.on('error', (error) => failAll(`the server failed to start: ${error.message}`));

  const request = (method: string, params: Record<string, unknown> = {}): Promise<{ result?: { tools?: WireTool[] }; error?: unknown }> => {
    const { promise, resolve, reject } = Promise.withResolvers<{ result?: { tools?: WireTool[] }; error?: unknown }>();
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
      clientInfo: { name: 'registry-pin', version: '1.0.0' },
    });
    assert.equal(init.error, undefined, `initialize failed: ${JSON.stringify(init.error)}`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    const listed = await request('tools/list');
    assert.equal(listed.error, undefined, `tools/list failed: ${JSON.stringify(listed.error)}\nstderr:\n${stderr}`);
    const tools = listed.result?.tools;
    assert.ok(Array.isArray(tools), 'tools/list must return an array');
    return tools;
  } finally {
    child.stdin.end();
    setTimeout(() => child.kill('SIGKILL'), 1_500).unref();
  }
}

/** The one wire list, shared by every assertion that needs it. */
let wireToolsPromise: Promise<WireTool[]> | undefined;
const wireTools = (): Promise<WireTool[]> => (wireToolsPromise ??= listWireTools());

/** Measured ownership, shared by every in-process assertion. */
let ownershipPromise: Promise<Map<string, string[]>> | undefined;
const ownership = (): Promise<Map<string, string[]>> => (ownershipPromise ??= measureManifestOwnership());

const sorted = (names: Iterable<string>): string[] => [...names].sort();

/** Names in `actual` that `expected` does not record, and the reverse. */
function delta(expected: readonly string[], actual: readonly string[]): { missing: string[]; added: string[] } {
  const have = new Set(actual);
  const want = new Set(expected);
  return { missing: sorted(want).filter((name) => !have.has(name)), added: sorted(have).filter((name) => !want.has(name)) };
}

const REGENERATE = process.env.REGISTRY_PIN_WRITE === '1';

// ---------------------------------------------------------------------------

describe('registry pin: exact manifest', () => {
  it('every manifest module registers exactly the tool names the pin records', async () => {
    const measured = await ownership();
    const pinned = await pin();
    const problems: string[] = [];
    for (const module of REGISTRAR_MANIFEST) {
      const expected = pinned.modules[module.key];
      assert.ok(Array.isArray(expected), `tests/registry-surface.json has no entry for module ${module.key}`);
      const { missing, added } = delta(expected, measured.get(module.key) ?? []);
      if (missing.length > 0) problems.push(`${module.key} (${module.file}) no longer registers: ${missing.join(', ')}`);
      if (added.length > 0) problems.push(`${module.key} (${module.file}) newly registers: ${added.join(', ')}`);
    }
    assert.deepEqual(problems, [], [
      'the pinned registry does not match what the modules register.',
      'A registration was added, removed or renamed. If that is deliberate, regenerate with',
      '  REGISTRY_PIN_WRITE=1 node --import tsx --test tests/registry-pin.test.ts',
      'and commit tests/registry-surface.json with the change.',
      ...problems.map((line) => `  - ${line}`),
    ].join('\n'));
  });

  it('the pin covers every manifest module, and no module that is not in the manifest', async () => {
    const pinned = sorted(Object.keys((await pin()).modules));
    const manifest = sorted(REGISTRAR_MANIFEST.map((module) => module.key));
    assert.deepEqual(pinned, manifest, 'tests/registry-surface.json and REGISTRAR_MANIFEST disagree on the module set');
  });

  it('the pin agrees with the manifest baselines, so it cannot become a second registrar list', async () => {
    // The manifest owns the counts; the pin adds names. If the two records ever
    // disagree, one of them was hand-edited — and the point of the pin is that
    // neither is a silent place to change the surface.
    const pinned = (await pin()).modules;
    const mismatches = REGISTRAR_MANIFEST
      .filter((module) => (pinned[module.key] ?? []).length !== module.baseline.toolCount)
      .map((module) => `${module.key}: pin lists ${(pinned[module.key] ?? []).length} names, manifest baseline is ${module.baseline.toolCount}`);
    assert.deepEqual(mismatches, [], `pin and manifest baselines disagree:\n  ${mismatches.join('\n  ')}`);
  });

  it('the live tools/list is exactly the pinned surface, with no additions and no omissions', async () => {
    const tools = await wireTools();
    const { missing, added } = delta((await pin()).flat, tools.map((tool) => tool.name));
    assert.deepEqual(missing, [], `tools/list no longer serves pinned tools: ${missing.join(', ')}`);
    assert.deepEqual(added, [], `tools/list serves tools the pin does not record: ${added.join(', ')}`);
  });
});

describe('registry pin: no duplicate names', () => {
  it('no tool name is owned by two manifest modules', async () => {
    const owners = new Map<string, string[]>();
    for (const [key, names] of await ownership()) {
      for (const name of names) owners.set(name, [...(owners.get(name) ?? []), key]);
    }
    const shared = [...owners].filter(([, keys]) => keys.length > 1).map(([name, keys]) => `${name} claimed by ${keys.join(' and ')}`);
    assert.deepEqual(shared, [], `a tool name may belong to exactly one module:\n  ${shared.join('\n  ')}`);
    // Presence floor: the scan above must be looking at a real surface.
    assert.ok(owners.size > 500, `expected the full surface, measured ${owners.size} owned names`);
  });

  it('a duplicate registration fails naming both modules that own the name', async () => {
    // The SDK aborts on a re-registration before any assertion can run, and its
    // own message names only the tool. In a 66-module manifest that leaves the
    // reader to guess which of the other 65 modules owns the name, so
    // `registerManifestModule` annotates the failure with both owners.
    const server = new McpServer({ name: 'duplicate-probe', version: '0.0.0' });
    const client = new SpotifyClient();
    const context: RegistrarManifestContext = { readOnly: false, isModuleActive: () => true, scopeBlocked: () => false };

    // Resolve the first module's lazy registrar the way production does (#906).
    const [first] = await loadManifestRegistrars(REGISTRAR_MANIFEST, context);
    registerManifestModule(server, client, first, context);
    const stolen = moduleToolNames(server, first.key)[0];
    assert.ok(stolen, `${first.key} registered nothing to collide with`);

    const impostor: RegistrarManifestEntry = {
      key: 'duplicate-probe-module',
      registrationKey: 'duplicate-probe',
      file: 'tests/registry-pin.test.ts',
      registrar: (target) => { target.tool(stolen, 'duplicate', {}, async () => ({ content: [] })); },
      baseline: { toolCount: 1, schemaBytes: 1 },
      ceiling: { toolCount: 2, schemaBytes: 2 },
    };

    assert.throws(
      () => registerManifestModule(server, client, impostor, context),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        // Both owners, by module key — the part the SDK message omits.
        assert.match(message, new RegExp(`registered by the "${first.key}" module`), 'error must name the module that already owns the name');
        assert.match(message, /re-registered by "duplicate-probe-module"/, 'error must name the module that tried to take it');
        assert.match(message, new RegExp(`"${stolen}"`), 'error must still name the colliding tool');
        return true;
      },
    );
  });
});

describe('registry pin: schema validity', () => {
  it('every tool serves an object inputSchema with a properties map', async () => {
    const tools = await wireTools();
    const offenders = tools
      .filter((tool) => {
        const schema = tool.inputSchema as { type?: unknown; properties?: unknown } | undefined;
        return !schema || typeof schema !== 'object' || schema.type !== 'object'
          || !schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties);
      })
      .map((tool) => tool.name);
    assert.deepEqual(offenders, [], `tools without a usable object inputSchema: ${offenders.join(', ')}`);
    assert.ok(tools.length > 500, `expected the full surface, got ${tools.length} tools`);
  });

  it('every input property declares a JSON Schema type marker', async () => {
    const tools = await wireTools();
    const untyped: string[] = [];
    for (const tool of tools) {
      const properties = (tool.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {};
      for (const [property, schema] of Object.entries(properties)) {
        const node = schema as Record<string, unknown>;
        const declared = typeof node?.type === 'string' || (Array.isArray(node?.type) && node.type.every((t) => typeof t === 'string'));
        const composed = '$ref' in node || 'anyOf' in node || 'oneOf' in node || 'allOf' in node || Array.isArray(node?.enum);
        if (!declared && !composed) untyped.push(`${tool.name}.${property}`);
      }
    }
    assert.deepEqual(untyped, [], `properties with no type marker: ${untyped.join(', ')}`);
  });
});

describe('registry pin: size budget', () => {
  it('the aggregate surface fits the production ceiling measured in UTF-8 bytes', async () => {
    const tools = await wireTools();
    // The startup gate in `src/index.ts` budgets `Buffer.byteLength(...,
    // 'utf8')`. Measuring UTF-16 code units here instead would undercount by
    // 1,494B on today's surface — larger than the headroom the ceiling has
    // left, so a change adding non-ASCII prose could pass this test and still
    // abort the server. Compare against the live production constant, never a
    // literal copy of it.
    const bytes = Buffer.byteLength(JSON.stringify(tools), 'utf8');
    assert.ok(
      bytes <= AGGREGATE_SURFACE_LIMITS.maxBytes,
      `tools/list is ${bytes}B (ceiling ${AGGREGATE_SURFACE_LIMITS.maxBytes}B, headroom ${AGGREGATE_SURFACE_LIMITS.maxBytes - bytes}B) — ` +
      'the host pays this every session; trim or raise the ceiling deliberately with a measured warrant',
    );
  });

  it('the byte measurement distinguishes UTF-8 bytes from UTF-16 code units', async () => {
    // The guard on the assertion above: on an all-ASCII surface the two
    // measures agree, so reverting to `JSON.stringify(tools).length` would
    // change nothing and the mistake would go unnoticed until the budget
    // mattered. Both directions are pinned, on payloads chosen to force them.
    const ascii = JSON.stringify([{ name: 'ascii_only', description: 'plain' }]);
    assert.equal(Buffer.byteLength(ascii, 'utf8'), ascii.length, 'an all-ASCII payload must measure identically in both units');

    const tools = await wireTools();
    const json = JSON.stringify(tools);
    const nonAscii = tools.filter((tool) => /[^\x20-\x7E]/.test(JSON.stringify(tool)));
    assert.ok(nonAscii.length > 0, `expected non-ASCII text in descriptions, found none across ${tools.length} tools`);
    const undercount = Buffer.byteLength(json, 'utf8') - json.length;
    assert.ok(undercount > 0, `UTF-8 must exceed UTF-16 here; the two measures are identical, so a code-unit budget is passing unnoticed`);
  });

  it('every manifest module stays inside its own derived ceiling', async () => {
    // The upper bound `tool.surface.test.ts` already enforces. What it does not
    // have is a lower bound — that is the first assertion in this file.
    const measured = await ownership();
    const over = REGISTRAR_MANIFEST
      .map((module) => ({ module, count: measured.get(module.key)?.length ?? 0 }))
      .filter(({ module, count }) => count > module.ceiling.toolCount)
      .map(({ module, count }) => `${module.key}: ${count} tools > ceiling ${module.ceiling.toolCount}`);
    assert.deepEqual(over, [], `modules over their tool ceiling:\n  ${over.join('\n  ')}`);
  });
});

// ---------------------------------------------------------------------------
// The pin file. Read lazily so the write-mode regeneration below can replace
// it mid-run without every closure holding a stale copy.
// ---------------------------------------------------------------------------

let cachedPin: RegistryPin | undefined;
function pin(): Promise<RegistryPin> {
  if (REGENERATE) return buildPin();
  cachedPin ??= JSON.parse(readFileSync(PIN_PATH, 'utf8')) as RegistryPin;
  return Promise.resolve(cachedPin);
}

async function buildPin(): Promise<RegistryPin> {
  const measured = await ownership();
  return {
    generatedBy: 'tests/registry-pin.test.ts — REGISTRY_PIN_WRITE=1 node --import tsx --test tests/registry-pin.test.ts',
    modules: Object.fromEntries(REGISTRAR_MANIFEST.map((module) => [module.key, sorted(measured.get(module.key) ?? [])])),
    flat: sorted(new Set([...measured.values()].flat())),
  };
}

describe('registry pin: the lockfile itself', () => {
  it('is current with the registry, or is regenerated on request', async () => {
    if (REGENERATE) {
      // No console.log: tests/no-test-debug-output-guard.test.ts holds this tree
      // at zero debug statements, and a stray log in a passing run is exactly
      // the thing that guard exists to catch.
      const built = await buildPin();
      writeFileSync(PIN_PATH, `${JSON.stringify(built, null, 2)}\n`);
      cachedPin = built;
      return;
    }
    const built = await buildPin();
    assert.deepEqual(built.modules, (await pin()).modules, 'tests/registry-surface.json is stale — regenerate it and commit the result');
    assert.deepEqual(built.flat, (await pin()).flat, 'tests/registry-surface.json is stale — regenerate it and commit the result');
  });
});
