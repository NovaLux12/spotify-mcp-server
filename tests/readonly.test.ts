/**
 * #579: SPOTIFY_MCP_READONLY must hide every write-capable module.
 *
 * The issue was filed against a tree where the guarantee was 65 hand-written
 * `!readOnly &&` literals in `src/index.ts` and six write-capable rows carried
 * no gate at all. `origin/main` @ 2978cec has since replaced those literals
 * with one per-row `readOnlySafe` field on the manifest, so the gate is now a
 * single `module.readOnlySafe !== true` check — structurally fail-closed by
 * the `manifestEntry` default of `false`. Most of the issue is therefore
 * already fixed upstream, and the tests below are written to keep it fixed
 * rather than to re-assert the historical shape.
 *
 * What is NOT yet fixed, and what this file is really about, is the one path
 * that made the gate fail OPEN: `moduleRegistrationStatus` nested the
 * read-only check inside `if (!module.alwaysActive)`, so a manifest row
 * carrying `alwaysActive: true` skipped the read-only gate entirely. That flag
 * exists to exempt a row from the TOOLSET gate (doctor/receipts/swarm3meta
 * must survive a trimmed SPOTIFY_MCP_TOOLSETS so they can report the trim) and
 * is not a safety claim — but as written it also exempted a row from
 * SPOTIFY_MCP_READONLY. A future `alwaysActive: true` row without
 * `readOnlySafe: true` would have registered its write tools into a read-only
 * session. All three rows that carry the flag today are `readOnlySafe`, so no
 * shipped surface changes; what changes is that the next one fails closed.
 *
 * ANTI-VACUITY. This file builds a real registry twice and compares the two
 * tool sets. A registry that came back empty would satisfy every "tool X is
 * absent under READONLY" assertion below while proving nothing, and that exact
 * failure has shipped in this repo before (an unawaited
 * `buildFullRegistryServer` registered nothing while every gate still passed).
 * So the first describe block pins a plausible tool count for BOTH runs before
 * any absence assertion is made, and the final block drives the registry to
 * empty on purpose and asserts that the pinned count is what fails.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { SpotifyClient } from '../src/client.js';
import {
  REGISTRAR_MANIFEST,
  classifyToolAnnotations,
  manifestEntry,
  localModule,
  moduleRegistrationStatus,
  moduleToolNames,
  registerManifestModules,
} from '../src/tools/annotations.js';
import type { ModuleRegistrationStatus } from '../src/tools/annotations.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The ungated surface, measured by driving `node dist/index.js` over stdio
 * (`initialize` → `notifications/initialized` → `tools/list`) rather than from
 * the census JSON, which has been measured high by ~1.9 KB. 592 at
 * origin/main @ 2978cec.
 *
 * This is a FLOOR, not an exact count: a later release legitimately adds
 * tools, and a test that pinned the exact number would fail on every such
 * release for no reason. It fails only if the registry collapses, which is the
 * failure this file exists to catch. The ceiling is deliberately loose for the
 * same reason — see AGENTS.md §4 on why tool counts live in generated blocks
 * rather than in prose.
 */
const UNGATED_TOOL_FLOOR = 500;

/**
 * A READONLY session is strictly smaller than the ungated one, and nowhere
 * near empty: 237 at origin/main @ 2978cec.
 */
const READONLY_TOOL_FLOOR = 150;

/** Build the real registry through the production gate. */
async function registry(options: { readOnly?: boolean } = {}): Promise<Set<string>> {
  return (await registered(options)).names;
}

/** The registry plus the per-row tool-ownership map the gate records. */
async function registered(options: { readOnly?: boolean } = {}): Promise<{ names: Set<string>; owned: Map<string, readonly string[]> }> {
  const server = new McpServer({ name: 'readonly-gate-test', version: '0.0.0' });
  await registerManifestModules(server, new SpotifyClient(), {
    readOnly: options.readOnly ?? false,
    isModuleActive: () => true,
    scopeBlocked: () => false,
  });
  const owned = new Map(REGISTRAR_MANIFEST.map((module) => [module.key, moduleToolNames(server, module.key)]));
  return { names: new Set(Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools)), owned };
}

/**
 * Write-capability is a property of the ROW'S SOURCE FILE, not of a
 * registration chunk. The issue's own verification pass recorded that a
 * chunk-scoped scan undercounts: `undo.ts` issues its writes from a helper
 * defined at line 230, well above its first `server.tool(` at line 435, so a
 * per-tool-chunk split attributes no writer to the row at all. The same is
 * true of every row that routes through a shared executor.
 *
 * The patterns are the ones `tests/mutations.conformance.test.ts` already
 * treats as writer evidence: the client's mutating verbs (in the plain form,
 * the generic-call form `client.delete<{...}>(`, and the cast-hidden form
 * `(client as unknown as { put }).put(...)` that made `artistwatch` invisible
 * to a plain `client.put` grep), an explicit HTTP verb string, and the local
 * commit helpers a row can use instead of a Spotify write.
 */
const SPOTIFY_WRITE = /\.\s*(post|put|delete|patch|putRaw)\s*(<[\s\S]*?>)?\s*\(|\bmethod\s*:\s*['"](?:PUT|POST|DELETE|PATCH)['"]/;
const LOCAL_COMMIT = /\b(atomicReplace|replaceWithUris|atomicAdd|writeFileSync|mkdirSync|rmSync|unlinkSync|renameSync|appendFileSync)\s*\(/;

interface WriteRow {
  readonly key: string;
  readonly file: string;
}

const WRITE_ROWS: readonly WriteRow[] = REGISTRAR_MANIFEST
  .map((module) => ({ key: module.key, file: module.file }))
  .filter(({ file }) => {
    const source = readFileSync(join(REPO_ROOT, file), 'utf8');
    return SPOTIFY_WRITE.test(source) || LOCAL_COMMIT.test(source);
  });

/**
 * The one place the surface count is judged, so the anti-vacuity block can
 * drive the SAME predicate against a deliberately empty registry. A floor
 * written inline at its only call site cannot be shown to fail.
 */
function assertPlausibleSurface(count: number, floor: number, label: string): void {
  assert.ok(
    count >= floor,
    `${label} registry has ${count} tools, below the ${floor} floor — the registry came back near-empty, which would `
      + 'make every absence assertion in this file vacuous',
  );
}

describe('#579 the READONLY registry is real, and smaller than the ungated one', () => {
  // Everything below asserts ABSENCE. Absence is what an empty registry gives
  // you for free, so these counts are pinned FIRST and a collapsed registry
  // fails here rather than silently satisfying the rest of the file.
  let ungated: Set<string>;
  let readOnly: Set<string>;

  it('registers a plausible number of tools with the flag off', async () => {
    ungated = await registry();
    assertPlausibleSurface(ungated.size, UNGATED_TOOL_FLOOR, 'ungated');
  });

  it('registers a plausible number of tools with the flag on', async () => {
    readOnly = await registry({ readOnly: true });
    assertPlausibleSurface(readOnly.size, READONLY_TOOL_FLOOR, 'READONLY');
  });

  it('is a strict subset: READONLY hides tools rather than swapping them', () => {
    assert.ok(readOnly.size < ungated.size, `READONLY (${readOnly.size}) did not drop below ungated (${ungated.size})`);
    for (const name of readOnly) {
      assert.ok(ungated.has(name), `${name} is in the READONLY registry but not in the ungated one`);
    }
  });
});

describe('#579 every write-capable module is gated', () => {
  // The enumeration is derived from the manifest rather than hand-listed, so a
  // new write row is covered the day it lands. A hand-list would be a third
  // copy of the classification and would drift exactly like the 65 inline
  // literals this issue was filed about.
  it('finds the write-capable rows at all (guards the enumeration itself)', () => {
    // Named so the count cannot fall to zero unnoticed: a filter that matched
    // nothing would leave `WRITE_ROWS` empty and make the per-row loop below
    // a test with no cases in it.
    assert.ok(
      WRITE_ROWS.length >= 30,
      `write-capable row enumeration found only ${WRITE_ROWS.length} rows; the write patterns are too narrow`,
    );
  });

  for (const row of WRITE_ROWS) {
    it(`hides ${row.key} in a READONLY session and serves it otherwise`, async () => {
      const ungated = await registered();
      const readOnly = await registry({ readOnly: true });

      // The representative is derived from the row's OWN registered tools, as
      // recorded by the gate's per-module ownership map — so this asserts
      // about a tool that demonstrably exists and demonstrably mutates, not a
      // name typed into a table. Each write row contributes a case, which is
      // what makes this coverage rather than a sample.
      const rowTools = ungated.owned.get(row.key) ?? [];
      assert.ok(rowTools.length > 0, `${row.key} (${row.file}) registered no tools in the ungated run`);
      const writers = rowTools.filter((name) => classifyToolAnnotations(name).readOnlyHint !== true);
      assert.ok(writers.length > 0, `${row.key} (${row.file}) registers no classifier-write tool to assert on`);

      for (const name of writers) {
        assert.ok(
          ungated.names.has(name),
          `${name} is attributed to ${row.key} but is absent from the ungated registry`,
        );
        assert.ok(
          !readOnly.has(name),
          `${name} (${row.key}) is registered in SPOTIFY_MCP_READONLY: ${row.file} is write-capable and the row `
            + 'did not declare readOnlySafe',
        );
      }
    });
  }
});

describe('#579 the gate fails closed, including for alwaysActive rows', () => {
  /**
   * The live defect. `alwaysActive` exists so doctor/receipts/swarm3meta
   * survive a trimmed `SPOTIFY_MCP_TOOLSETS` and can report the trim. Nested
   * inside the same `if`, it also exempted those rows from SPOTIFY_MCP_READONLY,
   * which made the gate fail open for the whole class: an `alwaysActive: true`
   * row that is not `readOnlySafe` registers its write tools into a read-only
   * session. Verified against pre-fix `origin/main` @ 2978cec — a synthetic
   * `alwaysActive` row registered `delete_everything` with `readOnly: true`.
   */
  const alwaysActiveWriter = manifestEntry(
    'synthetic-always-active-writer',
    'synthetic',
    localModule('src/tools/synthetic.ts', 'registerSynthetic', () => undefined),
    [1, 100],
    // deliberately NOT readOnlySafe: this is the shape that used to leak
    { alwaysActive: true },
  );

  it('reads as hidden, not active, for an alwaysActive row that is not readOnlySafe', () => {
    const status: ModuleRegistrationStatus = moduleRegistrationStatus(alwaysActiveWriter, {
      readOnly: true,
      isModuleActive: () => true,
      scopeBlocked: () => false,
    });
    assert.equal(status, 'read_only_hidden', 'an alwaysActive write row is not gated by SPOTIFY_MCP_READONLY');
  });

  it('still exempts an alwaysActive row from the TOOLSET gate', () => {
    // The other half of the same fix: moving the read-only check out must not
    // have taken the toolset exemption with it, or doctor/receipts/swarm3meta
    // would disappear from every trimmed session and stop being able to report
    // the trim. This is what `alwaysActive` is for.
    const status: ModuleRegistrationStatus = moduleRegistrationStatus(
      { ...alwaysActiveWriter, readOnlySafe: true },
      {
        readOnly: false,
        isModuleActive: () => false,
        scopeBlocked: () => false,
      },
    );
    assert.equal(status, 'active', 'alwaysActive no longer survives a trimmed toolset');
  });

  it('defaults a manifest row to write-capable when it says nothing', () => {
    // The fail-closed default lives in `manifestEntry`, not at the gate. A row
    // that omits `readOnlySafe` is a writer until someone verifies its handler
    // and opts it in — the same contract as the name-driven annotation
    // classifier, and for the same reason: an unverified row must not be
    // exposed on the strength of silence.
    const silent = manifestEntry('synthetic-silent', 'synthetic', alwaysActiveWriter, [1, 100]);
    assert.equal(silent.readOnlySafe, false, 'a row that declares nothing is not read-only by default');
    assert.equal(
      moduleRegistrationStatus(silent, { readOnly: true, isModuleActive: () => true, scopeBlocked: () => false }),
      'read_only_hidden',
    );
  });
});

describe('#579 the anti-vacuity guard is not itself vacuous', () => {
  /**
   * Proves the counts above can fail. Registration is driven with an empty
   * manifest, which is what an unawaited `buildFullRegistryServer` produced
   * when this repo shipped that bug — a registry of zero tools that satisfied
   * every gate and every "this tool is absent" assertion in the file.
   *
   * If the floors were unreachable (a typo, a stricter comparison, a floor
   * above the real surface) this test would fail while the guard it protects
   * was quietly passing nothing. That inversion is the whole point.
   */
  it('the tool-count floor rejects an empty registry', async () => {
    const server = new McpServer({ name: 'empty-registry-test', version: '0.0.0' });
    await registerManifestModules(
      server,
      new SpotifyClient(),
      { readOnly: false, isModuleActive: () => true, scopeBlocked: () => false },
      [], // deliberately empty: stands in for a registry that failed to build
    );
    const names = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    assert.equal(names.length, 0, 'the stand-in registry was supposed to be empty');
    // The floor must REJECT this. Asserting that it accepts would be the
    // vacuous test; asserting that it throws is what proves the guard in the
    // first describe block is load-bearing.
    assert.throws(
      () => assertPlausibleSurface(names.length, UNGATED_TOOL_FLOOR, 'empty'),
      /below the 500 floor/,
      'the anti-vacuity floor cannot fail: it accepted a zero-tool registry, so it guards nothing',
    );
  });

  it('the READONLY floor rejects an empty registry too', () => {
    // Same floor, second number: a gate that registered nothing under
    // SPOTIFY_MCP_READONLY would satisfy every "no writer is exposed" claim in
    // this file just as completely as an ungated one that registered nothing.
    assert.throws(
      () => assertPlausibleSurface(0, READONLY_TOOL_FLOOR, 'empty'),
      /below the 150 floor/,
    );
  });

  it('the per-row loop actually iterates (a filtered-to-nothing enumeration would pass)', () => {
    // `WRITE_ROWS` drives a `for` loop of test cases. Node's test runner
    // reports a file with no cases as a pass, so an enumeration that filtered
    // everything out would leave this file green with zero coverage of the
    // thing it exists to cover.
    assert.ok(WRITE_ROWS.length > 0, 'no write-capable rows enumerated; every per-row assertion was skipped');
  });
});
