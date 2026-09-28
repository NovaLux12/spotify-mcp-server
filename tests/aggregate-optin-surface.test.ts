/**
 * #1493 — the aggregate budget only ever described the analytics-OFF surface.
 *
 * ## The defect
 *
 * `assertAggregateSurfaceBudget` is a STARTUP gate. It measures whichever
 * surface the process actually registered, so an install with
 * `SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS` set is the one that can be refused a
 * boot. The census, which is the only thing that reports the number, deletes
 * every `SPOTIFY_*` variable before its measurement — correctly, for the budget
 * baselines — so `measuredBytes` was always the off figure. The per-module
 * budgets solved the same problem in #1128 with `gatedSurface` on the manifest
 * entries; the aggregate gate never got the counterpart, and the page a
 * maintainer reads to decide whether a tool fits reported headroom nobody who
 * opted in has.
 *
 * ## What these tests hold
 *
 * The opt-in surface is a first-class, measured row — not a derived one. The
 * issue's suggestion that the aggregate byte figure could be summed from the
 * per-module `gatedSurface` deltas is **wrong**, and §6's class: the per-module
 * budget charges `description + inputSchema + outputSchema` while
 * `collectAggregateSurfaceMeasurement` also charges every tool's name, title,
 * annotations, execution and `_meta`. Summing lands short of what the gate
 * enforces. So the tool count is cross-checked against the manifest — exact,
 * and a property of the manifest alone — while the bytes are measured. The
 * shortfall is asserted here as a positive gap, so "simplifying" the
 * measurement back into a sum fails instead of publishing a headroom nobody has.
 *
 * Every expected figure is measured here, in this process, by the same call
 * `src/index.ts` gates on — never read from the census that wrote the document.
 * And each assertion has a negative half, because a generated block that
 * renders from a wrongly computed variable is decoration (§6).
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SpotifyClient } from '../src/client.js';
import {
  AGGREGATE_SURFACE_LIMITS,
  REGISTRAR_MANIFEST,
  aggregateGatedEnvVars,
  applyToolAnnotations,
  applyToolOutputSchemas,
  assertSingleAggregateGatedFlag,
  assertToolNamingPolicy,
  collectAggregateSurfaceMeasurement,
  declaredGatedToolDelta,
  registerManifestModules,
} from '../src/tools/annotations.js';
import { applyTaskSupport } from '../src/tasks.js';
import { armFileDeadline, FLEET_FILE_BUDGET_MS } from './helpers/file-deadline.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = 'docs/schema-budgets.md';
const CENSUS = join(ROOT, 'scripts', 'surface-census.mjs');
const OPT_IN = 'SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS';

interface Surface {
  toolCount: number;
  schemaBytes: number;
}

function generatedBlockBody(relative: string, name: string): string {
  const source = readFileSync(join(ROOT, relative), 'utf8');
  const start = `<!-- BEGIN:generated ${name} -->`;
  const end = `<!-- END:generated ${name} -->`;
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end);
  assert.ok(startAt >= 0 && endAt > startAt, `${relative} has no ${name} block`);
  return source.slice(startAt + start.length, endAt);
}

/**
 * Pull the integers out of a block's tables, keyed by row label.
 *
 * Deliberately the same shape as `tests/doc-figures.test.ts`'s parser, so a row
 * the shared gates can read is a row this file can read too. The opt-in rows are
 * generated with the byte figure leading the value column precisely so this
 * regex matches them: a `+9,988B, +11 tools` cell parses as nothing at all,
 * which would let a wrong figure through unread.
 */
function blockFigures(body: string): Record<string, number> {
  const figures: Record<string, number> = {};
  for (const line of body.split('\n')) {
    const row = /^\|\s*([^|]*?)\s*\|\s*(\d[\d,]*)\s*(?:B|tools)?\s*\|/.exec(line);
    if (!row) continue;
    const label = row[1].replace(/\s*\(enforced\)\s*$/, '').trim();
    figures[label] = Number(row[2].replace(/,/g, ''));
  }
  return figures;
}

function figureMismatches(figures: Record<string, number>, expected: Record<string, number>): string[] {
  const errors: string[] = [];
  for (const [label, value] of Object.entries(expected)) {
    const actual = figures[label];
    if (actual === undefined) errors.push(`aggregate-budget block has no "${label}" row`);
    else if (actual !== value) errors.push(`aggregate-budget ${label}: document says ${actual}, measurement says ${value}`);
  }
  return errors;
}

/**
 * Measure the aggregate surface with the opt-in off and then on.
 *
 * Same three finalizers, same order, same call as `src/index.ts` — and all
 * three, because each is something `collectAggregateSurfaceMeasurement` charges
 * for. Skipping the naming policy measures a surface production refuses to
 * serve; skipping `applyToolOutputSchemas` (#687) reads 1,080B low on this
 * tree, which is the disagreement `tests/doc-figures.test.ts` would report
 * against the document this file asserts. Skipping `applyTaskSupport` (#600)
 * reads 11B high, for the same reason and one field fewer: the aggregate charges
 * for `execution`. The opt-in row would then be measured against a different
 * yardstick than the default row beside it.
 *
 * The env flip is in a `finally` because this is a live process, and a leaked
 * `1` would silently resize every figure measured after it.
 */
async function measureBothSurfaces(): Promise<{ off: Surface; on: Surface }> {
  const measureOnce = async (): Promise<Surface> => {
    const server = new McpServer({ name: 'optin-figures', version: '0.0.0' });
    const client = new SpotifyClient();
    try {
      await registerManifestModules(server, client, { readOnly: false, disableOverrides: new Set<string>(), isModuleActive: () => true, scopeBlocked: () => false });
      const registered = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {};
      assertToolNamingPolicy(Object.keys(registered));
      applyToolOutputSchemas(server);
      applyToolAnnotations(server);
      applyTaskSupport(server);
      return collectAggregateSurfaceMeasurement(server);
    } finally {
      await server.close().catch(() => undefined);
    }
  };

  const prior = process.env[OPT_IN];
  try {
    delete process.env[OPT_IN];
    const off = await measureOnce();
    process.env[OPT_IN] = '1';
    const on = await measureOnce();
    return { off, on };
  } finally {
    if (prior === undefined) delete process.env[OPT_IN];
    else process.env[OPT_IN] = prior;
  }
}

/** The manifest's per-module gated byte deltas, summed — the derivation #1493 warns against. */
function derivedGatedSchemaBytes(): number {
  return REGISTRAR_MANIFEST.reduce(
    (total, entry) => total + (entry.gatedSurface ? entry.gatedSurface.schemaBytes - entry.baseline.schemaBytes : 0),
    0,
  );
}

/** The three opt-in figures the generated block must state, measured here. */
function optInExpectations(surfaces: { off: Surface; on: Surface }): Record<string, number> {
  return {
    [`\`${OPT_IN}=1\``]: surfaces.on.schemaBytes,
    'Added by the opt-in': surfaces.on.schemaBytes - surfaces.off.schemaBytes,
    'Headroom with the opt-in': AGGREGATE_SURFACE_LIMITS.maxBytes - surfaces.on.schemaBytes,
  };
}

/**
 * Drive the census's `checkAggregateSurfaceTruth` with a deliberately wrong
 * `aggregateSurface` and return what it said.
 *
 * `--census-file` cannot do this: it replays the registry read and RECOMPUTES
 * every aggregate fact from the live tree, so a doctored fact in the file is
 * ignored. `--aggregate-fixture` exists for exactly this reach — see its
 * declaration.
 */
function checkVerdicts(overrides: Record<string, unknown>): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'smcp-optin-gate-'));
  try {
    const file = join(dir, 'aggregate.json');
    writeFileSync(file, JSON.stringify(overrides));
    const run = spawnSync(process.execPath, [CENSUS, '--aggregate-fixture', file], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: run.status, output: `${run.stdout}\n${run.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The same, asserting the rejection.
 *
 * The precondition is inside the helper on purpose: these cases exist to prove
 * the census's opt-in arms CAN fire, so a fixture that stopped tripping them
 * has to fail the test rather than pass it for the wrong reason.
 */
function checkRejects(overrides: Record<string, unknown>, expected: RegExp): void {
  const { status, output } = checkVerdicts(overrides);
  assert.notEqual(status, 0, `precondition: ${JSON.stringify(overrides)} was expected to be rejected, but the census exited 0:\n${output}`);
  assert.match(output, expected);
}

/**
 * The whole-file bound (#1569).
 *
 * This file spawns real child processes, so a child whose tree still holds an
 * inherited stdio write end can keep this process's `PipeWrap` registered and the
 * loop undrainable — the #1365 failure, which is silent and unbounded because the
 * runner is invoked with no `--test-timeout`. See `helpers/file-deadline.ts`.
 *
 * Armed at module scope, above every hook, because a bound a teardown can clear is
 * not a bound. The timer is `unref`'d, so it cannot itself delay this file.
 */
armFileDeadline({
  label: 'tests/aggregate-optin-surface.test.ts',
  budgetMs: FLEET_FILE_BUDGET_MS,
  children: () => [],
});

describe('the aggregate budget describes the opted-in surface too (#1493)', () => {
  it('the opt-in genuinely registers a larger surface than the default', async () => {
    // The precondition every other assertion here rests on. If the env flip
    // stopped working, or the gated modules stopped registering, both surfaces
    // would measure EQUAL — and every opt-in figure downstream would be a copy
    // of the default one, passing unnoticed. Asserted on its own so that
    // failure is legible rather than surfacing as a byte mismatch.
    const { off, on } = await measureBothSurfaces();
    assert.ok(off.schemaBytes > 0 && off.toolCount > 0, 'the default measurement is empty, so the comparison below would be vacuous');
    assert.ok(on.schemaBytes > off.schemaBytes, `opt-in surface is ${on.schemaBytes}B, default is ${off.schemaBytes}B — the flag did not enlarge the surface`);
    assert.ok(on.toolCount > off.toolCount, `opt-in surface is ${on.toolCount} tools, default is ${off.toolCount} — the flag did not enlarge the surface`);
  });

  it('the manifest declares exactly the tool-count delta the opt-in registers', async () => {
    // `declaredGatedToolDelta` is a property of the manifest alone, so it is
    // exact and can be asserted against a live measurement. The census's
    // `checkAggregateSurfaceTruth` asserts the same relationship; doing it from
    // outside the script that consumes it means the check is not only as good as
    // its own author thought.
    const { off, on } = await measureBothSurfaces();
    assert.equal(on.toolCount - off.toolCount, declaredGatedToolDelta());
  });

  it('the manifest gates exactly one env var, and it is the one measured here', () => {
    // Pins the name, so a renamed flag moves these tests rather than silently
    // measuring nothing.
    assert.deepEqual(aggregateGatedEnvVars(), [OPT_IN]);
  });

  it('a second declared gated flag is refused, not measured', () => {
    // The guard is the load-bearing part. Asserting `deepEqual` on the constant
    // above reads the same whether or not `assertSingleAggregateGatedFlag`
    // exists, so it could never detect the guard's absence — which is how a
    // claim that lived in four comments shipped with no code behind it. Drive
    // the function with a two-flag list instead.
    assert.throws(
      () => assertSingleAggregateGatedFlag(['SPOTIFY_MCP_ALPHA', 'SPOTIFY_MCP_BETA']),
      /2 gated flags declared/,
    );
    // And the shapes either side of the boundary must be exempt, or the guard
    // is a tripwire rather than a rule.
    assert.doesNotThrow(() => assertSingleAggregateGatedFlag([]));
    assert.doesNotThrow(() => assertSingleAggregateGatedFlag([OPT_IN]));
  });

  it('aggregate-budget states the opted-in surface, its delta, and its headroom', async () => {
    const surfaces = await measureBothSurfaces();
    const expected = optInExpectations(surfaces);
    const figures = blockFigures(generatedBlockBody(DOC, 'aggregate-budget'));
    assert.deepEqual(figureMismatches(figures, expected), []);
  });

  it('the opt-in headroom is quoted against the limit startup actually enforces', () => {
    // A byte total without the ceiling it sits inside is the #1241 defect one
    // table over: the reader cannot tell whether the opt-in would be served.
    const body = generatedBlockBody(DOC, 'aggregate-budget');
    assert.ok(
      body.includes('`AGGREGATE_SURFACE_LIMITS.maxBytes` (enforced)'),
      'the enforced-limit row is missing, so the opt-in headroom is against an unstated ceiling',
    );
    assert.ok(
      body.includes(OPT_IN),
      'the opt-in table does not name the environment variable that selects it',
    );
  });

  it('the opt-in figure is measured, and the sum that would replace it is short', async () => {
    // The issue suggested the aggregate byte figure could be derived from the
    // per-module `gatedSurface` deltas. It cannot, and this is the arithmetic
    // that says so: the sum under-reports, by roughly a kilobyte on this tree.
    //
    // Asserted as a *positive* gap rather than a hard-coded number, because the
    // gap moves with every tool the opt-in gains. A test pinning "1,305B" would
    // redden on a legitimate addition and teach the next reader to update a
    // number instead of re-running a measurement.
    const { off, on } = await measureBothSurfaces();
    const measured = on.schemaBytes - off.schemaBytes;
    const derived = derivedGatedSchemaBytes();
    assert.ok(measured > derived, `the aggregate charges ${measured}B for the opt-in but the per-module deltas sum to ${derived}B — the gap this test exists to catch has closed`);
    // The other direction: a gap as large as the delta would mean the manifest
    // figures had rotted, not that the aggregate projection is narrower.
    assert.ok(measured - derived < measured, `the shortfall is ${measured - derived}B of a ${measured}B delta — that is a broken manifest, not a narrower projection`);
  });

  it('rejects a wrong opt-in figure in each row, one at a time', async () => {
    // The anti-vacuity half. Each expected figure is perturbed and the SAME
    // comparison must notice. If a row were parsed but never compared, or
    // compared against a value derived from the block, this loop finds nothing.
    const surfaces = await measureBothSurfaces();
    const expected = optInExpectations(surfaces);
    const figures = blockFigures(generatedBlockBody(DOC, 'aggregate-budget'));
    const labels = Object.keys(expected);
    for (const label of labels) {
      assert.ok(typeof figures[label] === 'number', `precondition: "${label}" is present in the block before perturbing it`);
    }
    for (const label of labels) {
      const wrong = { ...figures, [label]: figures[label] + 1 };
      assert.ok(
        figureMismatches(wrong, expected).some((error) => error.includes(label)),
        `perturbing "${label}" by one byte was not detected`,
      );
    }
    // And a block that lost every opt-in row must fail every opt-in assertion —
    // the "no such row" message contains the label, so a count alone would
    // not distinguish a missing row from a wrong one.
    const withoutRows: Record<string, number> = {};
    for (const [label, value] of Object.entries(figures)) {
      if (!(label in expected)) withoutRows[label] = value;
    }
    const errors = figureMismatches(withoutRows, expected);
    assert.equal(errors.length, labels.length, 'removing every opt-in row did not fail every opt-in assertion');
  });

  it('the census accepts its own live measurements before any fixture is applied', () => {
    // The precondition for every case below. `--aggregate-fixture` MERGES over
    // the measured facts, so `{}` is the real surface with nothing changed. If
    // this goes red, the live tree already violates the gate and the negative
    // cases below would be passing for a reason that has nothing to do with the
    // arm they are testing.
    const { status, output } = checkVerdicts({});
    assert.equal(status, 0, `the census rejected its own live measurements:\n${output}`);
  });

  it('the census rejects an opt-in measurement that cannot tell the surfaces apart', () => {
    // Without this, the census could publish the default surface's headroom as
    // the opt-in's and every other test here would still pass, because the
    // document would faithfully match a measurement that measured nothing.
    checkRejects(
      { optInBytes: 0, optInToolCount: 0, optInDeltaBytes: 0, optInDeltaTools: 0 },
      // The byte/tool rows are zeroed, so the *relationship* check is what has
      // to fire — not the ceiling check, which a zeroed surface passes trivially.
      /opt-in measurement is not seeing/,
    );
  });

  it('the census rejects a gated harness that disagrees with the finalized registry', () => {
    // Two harnesses, two sets of numbers, side by side in one table with nothing
    // tying them. This is the failure that would make the opt-in row
    // incomparable to the default row it qualifies.
    checkRejects({ offBytes: 1, offToolCount: 1 }, /the two harnesses disagree/);
  });

  it('the census rejects a gated tool-count delta the manifest does not declare', () => {
    checkRejects({ declaredGatedToolDelta: 999 }, /gated entries declare 999 extra tools/);
  });

  it('the census rejects an opt-in surface that would be refused at startup', () => {
    // The limit is enforced against whichever surface the process registered, so
    // an opt-in surface over the ceiling is a boot that fails. Publishing the
    // figure without failing here would leave the one surface that actually
    // breaches unguarded.
    checkRejects({ optInBytes: Number.MAX_SAFE_INTEGER }, /would be refused at startup/);
  });
});
