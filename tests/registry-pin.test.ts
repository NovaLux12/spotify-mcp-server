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
 *      first four manifest modules; the other 66 modules' names are unasserted
 *      anywhere, so a rename outside that prefix is silent.
 *   3. **Duplicates abort, but opaquely.** The SDK throws
 *      `Tool search is already registered` before any assertion runs, naming
 *      the tool and neither module.
 *   4. **The byte ceiling was measured in the wrong unit.** At the time this
 *      file was written, `tool.surface.test.ts` asserted
 *      `JSON.stringify(tools).length` — UTF-16 code units — while the
 *      production startup gate in `src/index.ts` budgets UTF-8 bytes via
 *      `collectAggregateSurfaceMeasurement`. On a surface whose tool
 *      descriptions carry non-ASCII text the code-unit count is strictly
 *      smaller, so a budget written in it understates what the host actually
 *      receives. That is a trap worth a guard whether or not it is currently
 *      biting: the two measures agree closely enough that nothing fails while
 *      they disagree, and the error only announces itself once it is large
 *      enough to matter.
 *
 *      #1283 fixed the unit in `tool.surface.test.ts` in the same change that
 *      wrote this paragraph, so the wrong-unit defect this item describes is
 *      now fixed everywhere — production measures with `Buffer.byteLength(...,
 *      'utf8')` and so does that file. What remains here is not the repair but
 *      two things it does not provide: a SECOND measurement taken against the
 *      ENFORCED ceiling (`AGGREGATE_SURFACE_LIMITS.maxBytes`, which carries the
 *      annotation allowance that `tool.surface.test.ts`'s constant does not),
 *      and the guard below that fails loudly if the two units ever stop
 *      differing on this surface — which would mean the trap is gone, and would
 *      be as worth knowing as the trap being live.
 *
 *      No figure from that measurement is written here on purpose. Every one of
 *      them — the byte count, the headroom, the share of tools carrying
 *      non-ASCII text — moves with the surface, and a number typed into a
 *      comment is a number that is wrong within one release while nothing
 *      re-derives it. The assertions below emit all of them on every run.
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
// Redirects HOME to a disposable temp root so a store default resolved
// through homedir() cannot land in the real $HOME (#1274). Side effect only,
// and it must precede every other import so anything resolved at module-load
// time sees the sandbox.
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SpotifyClient } from '../src/client.js';
import { wireTools, type WireTool } from './wire-registry.js';
import {
  AGGREGATE_SURFACE_LIMITS,
  loadManifestRegistrars,
  localModule,
  moduleToolNames,
  registerManifestModule,
  registerManifestModules,
  REGISTRAR_MANIFEST,
  type RegistrarManifestContext,
  type RegistrarManifestEntry,
} from '../src/tools/annotations.js';

const REPO_ROOT = join(import.meta.dirname, '..');
const PIN_PATH = join(REPO_ROOT, 'tests/registry-surface.json');

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
  const context: RegistrarManifestContext = { readOnly: false, disableOverrides: new Set<string>(), isModuleActive: () => true, scopeBlocked: () => false };
  await registerManifestModules(server, client, context);
  return new Map(REGISTRAR_MANIFEST.map((module) => [module.key, [...moduleToolNames(server, module.key)]]));
}

/** The one wire list, shared by every assertion that needs it. */
const listWireTools = wireTools;

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
    // own message names only the tool. In a 70-module manifest that leaves the
    // reader to guess which of the other 69 modules owns the name, so
    // `registerManifestModule` annotates the failure with both owners.
    const server = new McpServer({ name: 'duplicate-probe', version: '0.0.0' });
    const client = new SpotifyClient();
    const context: RegistrarManifestContext = { readOnly: false, disableOverrides: new Set<string>(), isModuleActive: () => true, scopeBlocked: () => false };

    // Resolve the first module's lazy registrar the way production does (#906).
    const [first] = await loadManifestRegistrars(REGISTRAR_MANIFEST, context);
    registerManifestModule(server, client, first, context);
    const stolen = moduleToolNames(server, first.key)[0];
    assert.ok(stolen, `${first.key} registered nothing to collide with`);

    // Built through `localModule`, the same helper every synthetic manifest
    // row in this tree uses, rather than as a bare object literal. A
    // `RegistrarManifestEntry` extends `RegistrarSpec`, so it owes `name` and
    // `load` as well as `registrar`; a literal that declared only `registrar`
    // was an entry the type did not accept, and the duplicate-detection path
    // under test is exactly the one that must not depend on a hand-built
    // object. `load` is never called here — `registrar` is already resolved —
    // but it is part of the contract, so the row carries a real one.
    const steal = (target: McpServer) => { target.tool(stolen, 'duplicate', {}, async () => ({ content: [] })); };
    const impostor: RegistrarManifestEntry = {
      key: 'duplicate-probe-module',
      registrationKey: 'duplicate-probe',
      ...localModule('tests/registry-pin.test.ts', 'steal', steal),
      registrar: steal,
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
    // 'utf8')`. Measuring UTF-16 code units instead undercounts this surface,
    // because tool descriptions carry non-ASCII text — and the two measures sit
    // close enough together that neither one fails while they disagree. That is
    // the argument for measuring in the production unit rather than asserting
    // that it matters yet: a budget expressed in the other unit is right by
    // coincidence until the descriptions grow. Compare against the live
    // production constant, never a literal copy of it.
    //
    // This is a SECOND, independent measurement, not the guard. `assertAggregateSurfaceWithinBudget`
    // runs at startup, so a real breach aborts the process before `tools/list` is ever
    // answered — verified by forcing the ceiling to 1,000B, which made this suite fail with
    // "the server exited with code 1 before answering" rather than reaching the assertion
    // below. What this test adds is a failure that names the byte count and the headroom
    // instead of a spawn error, and a unit that is pinned in a test rather than only in
    // production.
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

    // Report the size of the trap rather than just its existence: what makes the
    // undercount dangerous is its size against the headroom left, so that
    // comparison is the assertion rather than a printed line. A print cannot
    // fail, and #664's guard is right to reject one.
    const utf8Bytes = Buffer.byteLength(json, 'utf8');
    const headroom = AGGREGATE_SURFACE_LIMITS.maxBytes - utf8Bytes;
    assert.ok(
      headroom > 0,
      `tools/list is ${utf8Bytes}B against a ${AGGREGATE_SURFACE_LIMITS.maxBytes}B ceiling — no headroom left, `
        + `and a code-unit budget would undercount it by a further ${undercount}B`,
    );
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

      // Write mode verifies its own write instead of printing that it happened.
      // A regeneration that silently wrote the wrong shape would otherwise look
      // exactly like a successful one until the next reader ran the suite.
      const written = JSON.parse(readFileSync(PIN_PATH, 'utf8')) as RegistryPin;
      assert.deepEqual(written.modules, built.modules, 'the regenerated pin did not round-trip');
      assert.deepEqual(written.flat, built.flat, 'the regenerated pin did not round-trip');
      return;
    }
    const built = await buildPin();
    assert.deepEqual(built.modules, (await pin()).modules, 'tests/registry-surface.json is stale — regenerate it and commit the result');
    assert.deepEqual(built.flat, (await pin()).flat, 'tests/registry-surface.json is stale — regenerate it and commit the result');
  });
});
