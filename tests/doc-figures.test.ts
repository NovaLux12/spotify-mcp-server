/**
 * #1241 / #1247 — the hand-typed figures in the docs have drifted.
 *
 * Three instances, one class: a number typed into prose. Prose is not gated, so
 * a number copied out of code or out of a measurement is stale within one
 * release, and this repo has now shipped three ways of watching that happen:
 * a schema ceiling frozen two raises behind the constant, a tool count one
 * behind the census *in the same README*, and a test count stale by more than
 * 3x. The fix is that each figure is generated and `--check`-gated, plus a
 * guard per figure — because a generated block that renders from a wrongly
 * computed variable is decoration, and §6 warns about exactly that twice.
 *
 * The guards here are deliberately two-sided. For each figure there is an
 * assertion that the real document agrees with the code, and a mutation that
 * makes the same comparison reject a deliberately wrong document. A guard
 * whose negative case was never run is the thing §6 is warning about.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SpotifyClient } from '../src/client.js';
import {
  AGGREGATE_SURFACE_LIMITS,
  TOOL_SURFACE_BUDGET,
  applyToolAnnotations,
  assertToolNamingPolicy,
  collectAggregateSurfaceMeasurement,
  registerManifestModules,
} from '../src/tools/annotations.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function readDoc(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'smcp-doc-figures-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run a command expected to fail and return its combined output. */
function runFailure(args: string[]): string {
  try {
    execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string };
    return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  }
  assert.fail(`expected command to fail: ${args.join(' ')}`);
}

/**
 * The body between one block's markers, sliced exactly the way
 * `inspectGeneratedBlock` slices it, so a mutation applied to the document and
 * compared through `--marker-fixture` tests the real gate.
 */
function generatedBlockBody(relative: string, name: string): string {
  const source = readDoc(relative);
  const start = `<!-- BEGIN:generated ${name} -->`;
  const end = `<!-- END:generated ${name} -->`;
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end);
  assert.ok(startAt >= 0 && endAt > startAt, `${relative} has no ${name} block`);
  return source.slice(startAt + start.length, endAt);
}

/** Remove every generated block, leaving only the hand-maintained prose. */
function stripGeneratedBlocks(source: string): string {
  return source.replace(/<!-- BEGIN:generated [a-z0-9-]+ -->[\s\S]*?<!-- END:generated [a-z0-9-]+ -->/g, '');
}

/**
 * Drive the real gate against a mutated document.
 *
 * `body` stays the document's own (correct) block body, so the only difference
 * the gate can see is the mutation — this exercises `inspectGeneratedBlock`,
 * not a re-implementation of it. The caller asserts on the returned output.
 */
function gateRejectsMutatedBlock(relative: string, name: string, mutate: (source: string) => string): string {
  return withTempDir((dir) => {
    const fixture = join(dir, 'marker.json');
    writeFileSync(fixture, JSON.stringify({
      source: mutate(readDoc(relative)),
      file: relative,
      name,
      body: generatedBlockBody(relative, name),
    }));
    return runFailure(['scripts/surface-census.mjs', '--marker-fixture', fixture]);
  });
}

// ---------------------------------------------------------------------------
// docs/schema-budgets.md — the aggregate figures
// ---------------------------------------------------------------------------

/**
 * Pull the integers out of the aggregate block's table, keyed by row label.
 * Row labels are normalized (backticks stripped, the "(enforced)" qualifier
 * dropped) so a label rewording does not read as a figure change.
 */
function aggregateBlockFigures(body: string): Record<string, number> {
  const figures: Record<string, number> = {};
  for (const line of body.split('\n')) {
    const row = /^\|\s*([^|]*?)\s*\|\s*(\d[\d,]*)\s*(?:B|tools)?\s*\|/.exec(line);
    if (!row) continue;
    // Backticks are deliberately kept: the expected keys below are the
    // document's literal row labels, so a renamed row fails instead of
    // silently resolving to nothing.
    const label = row[1].replace(/\s*\(enforced\)\s*$/, '').trim();
    figures[label] = Number(row[2].replace(/,/g, ''));
  }
  return figures;
}

/** Every disagreement between a rendered block and independently-measured truth. */
function aggregateFigureMismatches(figures: Record<string, number>, expected: Record<string, number>): string[] {
  const errors: string[] = [];
  for (const [label, value] of Object.entries(expected)) {
    const actual = figures[label];
    if (actual === undefined) errors.push(`aggregate-budget block has no "${label}" row`);
    else if (actual !== value) errors.push(`aggregate-budget ${label}: document says ${actual}, code/measurement says ${value}`);
  }
  return errors;
}

/**
 * Build the registry the way `src/index.ts` does and measure it, so the
 * expected side never comes from the census that wrote the document. This is
 * the same `collectAggregateSurfaceMeasurement` call `assertAggregateSurfaceBudget`
 * gates on, after the same two finalizers.
 */
async function measureIndependently() {
  const server = new McpServer({ name: 'doc-figures', version: '0.0.0' });
  const client = new SpotifyClient();
  try {
    await registerManifestModules(server, client, { readOnly: false, isModuleActive: () => true, scopeBlocked: () => false });
    const registered = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {};
    assertToolNamingPolicy(Object.keys(registered));
    applyToolAnnotations(server);
    return collectAggregateSurfaceMeasurement(server);
  } finally {
    await server.close().catch(() => undefined);
  }
}

describe('generated documentation figures (#1241, #1247)', () => {
  it('aggregate-budget states the enforced ceiling, the measured payload, and the headroom', async () => {
    const measured = await measureIndependently();
    // Precondition, so this cannot pass by comparing a block against an
    // undefined measurement: the aggregate is a real byte count.
    assert.ok(measured.schemaBytes > 0, `independent measurement produced ${measured.schemaBytes} bytes`);
    const expected: Record<string, number> = {
      '`TOOL_SURFACE_BUDGET.defaultMaxBytes`': TOOL_SURFACE_BUDGET.defaultMaxBytes,
      '`TOOL_SURFACE_BUDGET.defaultMaxTools`': AGGREGATE_SURFACE_LIMITS.maxTools,
      '`AGGREGATE_SURFACE_LIMITS.maxBytes`': AGGREGATE_SURFACE_LIMITS.maxBytes,
      'Measured `tools/list` payload': measured.schemaBytes,
      Headroom: AGGREGATE_SURFACE_LIMITS.maxBytes - measured.schemaBytes,
    };
    const figures = aggregateBlockFigures(generatedBlockBody('docs/schema-budgets.md', 'aggregate-budget'));
    assert.deepEqual(aggregateFigureMismatches(figures, expected), []);
  });

  it('rejects a wrong aggregate figure in each row, one at a time', async () => {
    // The anti-vacuity half. Each expected figure is perturbed and the SAME
    // comparison is required to notice. If a row were parsed out of the block
    // but never compared, or compared against a value derived from the block,
    // this loop would find nothing and fail here.
    const measured = await measureIndependently();
    const expected: Record<string, number> = {
      '`TOOL_SURFACE_BUDGET.defaultMaxBytes`': TOOL_SURFACE_BUDGET.defaultMaxBytes,
      '`TOOL_SURFACE_BUDGET.defaultMaxTools`': AGGREGATE_SURFACE_LIMITS.maxTools,
      '`AGGREGATE_SURFACE_LIMITS.maxBytes`': AGGREGATE_SURFACE_LIMITS.maxBytes,
      'Measured `tools/list` payload': measured.schemaBytes,
      Headroom: AGGREGATE_SURFACE_LIMITS.maxBytes - measured.schemaBytes,
    };
    const figures = aggregateBlockFigures(generatedBlockBody('docs/schema-budgets.md', 'aggregate-budget'));
    const rows = Object.keys(expected);
    assert.ok(rows.length >= 5, `expected at least 5 checked rows, found ${rows.length}`);
    // Precondition. Without it a row that is simply ABSENT satisfies the loop
    // below, because the "no such row" error also contains the label — which
    // is how a comparison that never compared anything still passed once.
    for (const label of rows) {
      assert.ok(
        typeof figures[label] === 'number',
        `precondition: "${label}" is present in the block before perturbing it`,
      );
    }
    for (const label of rows) {
      const wrong = { ...figures, [label]: figures[label] + 1 };
      const errors = aggregateFigureMismatches(wrong, expected);
      assert.ok(
        errors.some((error) => error.includes(label)),
        `perturbing "${label}" by one byte was not detected`,
      );
    }
    // And the reverse: a block that lost a row entirely must not pass.
    const { Headroom: _dropped, ...withoutRow } = figures;
    assert.ok(
      aggregateFigureMismatches(withoutRow, expected).some((error) => error.includes('Headroom')),
      'a missing aggregate row was not detected',
    );
  });

  it('the real --check gate fails when a generated aggregate figure is wrong', () => {
    // Mutation check against the actual gate, not a re-implementation: the
    // document's own (correct) block body is what the gate expects, and the
    // document is handed a number that disagrees with it.
    const body = generatedBlockBody('docs/schema-budgets.md', 'aggregate-budget');
    const wrongBytes = body.replace(/\| (\d[\d,]*)B \| `collectAggregateSurfaceMeasurement`/, (_m, value: string) => {
      const bumped = Number(value.replace(/,/g, '')) + 1;
      return `| ${bumped.toLocaleString('en-US')}B | \`collectAggregateSurfaceMeasurement\``;
    });
    assert.notEqual(wrongBytes, body, 'precondition: the mutation actually changed the document');
    const output = gateRejectsMutatedBlock(
      'docs/schema-budgets.md',
      'aggregate-budget',
      () => readDoc('docs/schema-budgets.md').replace(body, wrongBytes),
    );
    assert.match(output, /is stale/);
  });

  it('the aggregate conclusion follows the measured headroom, not a remembered one', () => {
    const body = generatedBlockBody('docs/schema-budgets.md', 'aggregate-budget');
    const headroom = aggregateBlockFigures(body).Headroom;
    const percent = (headroom / AGGREGATE_SURFACE_LIMITS.maxBytes) * 100;
    // The verdict band, restated here on purpose: the point of the assertion
    // is that the rendered sentence cannot claim a band the ratio does not
    // support. A stale "effectively exhausted" against real headroom fails.
    const expected = percent < 1 ? 'effectively exhausted' : percent < 5 ? 'tight' : 'within budget';
    assert.ok(
      body.includes(`**${expected}**`),
      `aggregate-budget verdict does not match the measured ${percent.toFixed(1)}% headroom (expected "${expected}")`,
    );
    assert.match(body, /Headroom is \*\*[\d,]+B\*\* of the [\d,]+B enforced limit/);
  });
});

// ---------------------------------------------------------------------------
// README.md — the tool count in prose
// ---------------------------------------------------------------------------

/**
 * The first three hand-typed shapes, each with exactly one capture group so a
 * hit reports the figure and not the surrounding markup. `\*{0,2}` on both sides
 * because the generated clauses emphasise their number — a scanner that missed
 * `**592**-tool` would pass the very document it was written to protect.
 *
 * The big-figure pattern deliberately has no trailing `\b`: `607,000B` has no
 * word boundary between `0` and `B`, so a boundary would let the exact strings
 * #1241 reported through untouched. It is the magnitude arm of the two that
 * `ungatedAggregateFiguresIn` combines; the unit arm is below it.
 */
const HAND_TYPED_TOOL_COUNT = /\*{0,2}(\d[\d,]*)\*{0,2}\s*-tool\b/g;
const HAND_TYPED_TEST_COUNT = /\*{0,2}(\d[\d,]*)\+?\*{0,2}\s+tests?\b/gi;
const HAND_TYPED_FIGURE = /\*{0,2}(\d{1,3}(?:,\d{3})+|\d{5,})/g;

/**
 * The aggregate scale. A six-digit figure describes the whole `tools/list`
 * payload — a live measurement that moves whenever any description is reworded,
 * so it can only live in the generated block.
 */
const AGGREGATE_FIGURE_FLOOR = 100_000;

/**
 * The unit arm. A figure written with byte units is a payload measurement at
 * *any* magnitude, which a magnitude threshold cannot see: today's headroom is
 * five digits, so a floor drawn at the aggregate scale would have waved through
 * "13,896 bytes of headroom" — the one figure whose staleness inverts the
 * document's conclusion.
 *
 * Only whitespace may sit between the figure and its unit, so this reads
 * `607,000B`, `621,000-byte` and `13,896 bytes` while leaving a per-module
 * baseline in prose (`21,825 → 22,277 schema bytes`, where a noun separates the
 * figure from "bytes") alone. That separation is the point: the warrant for a
 * baseline raise is the measurement that justified it, and rewriting it out of
 * the page to satisfy a drift guard would make the record less true, not more.
 *
 * The lookbehind keeps the digit out of a hyphenated token, because the docs
 * measure "UTF-8 bytes of compact JSON" and that `8` is a character-set name,
 * not a figure.
 */
const BYTE_SIZED_FIGURE = /(?<![\w-])\*{0,2}(\d[\d,]*)\*{0,2}\s*(?:B\b|bytes?\b|-byte\b)/g;

/**
 * Every figure that claims to be a live `tools/list` measurement: at the
 * aggregate scale, or carrying byte units. These may only appear in a generated
 * block.
 */
function ungatedAggregateFiguresIn(prose: string): string[] {
  const hits = [
    ...figuresIn(prose, HAND_TYPED_FIGURE).filter((figure) => Number(figure.replace(/,/g, '')) >= AGGREGATE_FIGURE_FLOOR),
    ...figuresIn(prose, BYTE_SIZED_FIGURE),
  ];
  return [...new Set(hits)].sort();
}

/** Names of generated blocks whose BEGIN marker is indented off column 0. */
function indentedGeneratedBlocks(source: string): string[] {
  return [...source.matchAll(/^[ \t]+<!-- BEGIN:generated ([a-z0-9-]+) -->[ \t]*$/gm)].map((match) => match[1]);
}

/** Every figure the pattern finds, as the number itself. */
function figuresIn(prose: string, pattern: RegExp): string[] {
  return [...prose.matchAll(pattern)].map((match) => match[1]);
}

describe('hand-typed figures stay out of documentation prose (#1241, #1247)', () => {
  it('README prose carries no hand-typed tool count', () => {
    const prose = stripGeneratedBlocks(readDoc('README.md'));
    // Precondition: the strip actually removed something. Without this the
    // next assertion would also pass on a README with no generated blocks,
    // which is a different (and uninteresting) pass.
    assert.ok(prose.length < readDoc('README.md').length, 'stripGeneratedBlocks removed nothing from README.md');
    const hits = figuresIn(prose, HAND_TYPED_TOOL_COUNT);
    assert.deepEqual(hits, [], `README.md prose hand-types a tool count: ${hits.join(', ')}`);
    // Scoped to README.md on purpose, and the scope is a decision rather than an
    // oversight. README is where a reader is told how big the surface is, so it
    // is the one page where a stale count is read as a claim about today. Other
    // pages quote tool counts inside dated change records — `docs/schema-budgets.md`
    // says the registry was 592 tools before and after #900 — which are the same
    // category as the per-module baselines below and stay in prose. Widen this
    // to every page and it would demand that history be deleted.
  });

  it('the README tool-count guard would have caught the #1241 sentence', () => {
    // #1241 reported "everything else in the 591-tool surface keeps its name".
    // The fix removed the number rather than generating it: the sentence sits
    // inside a numbered list item, and a generated block's end marker renders
    // at column 0, which terminates the list. So the guard's job is to keep
    // that number from coming back by hand, and the anti-vacuity case is the
    // sentence as it actually stood in the issue.
    const regressed = readDoc('README.md').replace(
      'everything else in the surface keeps its name',
      'everything else in the 591-tool surface keeps its name',
    );
    const hits = figuresIn(stripGeneratedBlocks(regressed), HAND_TYPED_TOOL_COUNT);
    assert.deepEqual(hits, ['591'], 'the guard did not flag the un-gated tool count it exists to catch');
  });

  it('no generated block is indented, because its end marker would split a list', () => {
    // The reason the README count is prose-with-no-number rather than a block.
    // `renderedBlock` always writes the end marker at column 0; inside a list
    // item that ends the item (verified against a CommonMark renderer, which
    // emits `</ol>` before the closing comment and restarts the list). So an
    // indented BEGIN marker is always a mistake, and this names it.
    for (const relative of ['README.md', 'docs/distribution.md', 'docs/schema-budgets.md', 'ARCHITECTURE.md', 'SPEC.md']) {
      assert.deepEqual(
        indentedGeneratedBlocks(readDoc(relative)),
        [],
        `${relative} has an indented generated block; its end marker renders at column 0 and splits the list`,
      );
    }
    // The anti-vacuity half: the fixture is the exact shape #1241 briefly had
    // in README.md, so the scan above is shown to see it.
    assert.deepEqual(
      indentedGeneratedBlocks('0. Item one.\n   <!-- BEGIN:generated remaining-surface -->\n   body\n<!-- END:generated remaining-surface -->\n'),
      ['remaining-surface'],
      'the scan did not detect an indented generated block, so the check above is vacuous',
    );
  });

  it('docs/distribution.md carries no hand-typed test count', () => {
    // Option (a) from #1247: the census does not run the suite, and wiring it
    // to would mean CI runs the suite twice, so the figure is gone rather than
    // refreshed. A sentence with no number in it cannot drift.
    const prose = stripGeneratedBlocks(readDoc('docs/distribution.md'));
    const hits = figuresIn(prose, HAND_TYPED_TEST_COUNT);
    assert.deepEqual(hits, [], `docs/distribution.md prose hand-types a test count: ${hits.join(', ')}`);
  });

  it('the distribution test-count guard would have caught the #1247 sentence', () => {
    const restored = readDoc('docs/distribution.md').replace(
      'a hard read-only mode. The full',
      'a hard read-only mode. 830+ tests, The full',
    );
    const hits = figuresIn(stripGeneratedBlocks(restored), HAND_TYPED_TEST_COUNT);
    assert.deepEqual(hits, ['830'], 'the guard did not flag the stale test count it exists to catch');
  });

  it('docs/schema-budgets.md prose carries no byte-sized aggregate figure', () => {
    // The whole passage that quoted 607,000 / 608,000 / 607,715 / 285 is now a
    // generated block. A raise, or a measurement that moves the headroom, shows
    // up as a block diff; nothing in the surrounding prose asserts a current
    // number that `--check` cannot see.
    const prose = stripGeneratedBlocks(readDoc('docs/schema-budgets.md'));
    const hits = ungatedAggregateFiguresIn(prose);
    assert.deepEqual(hits, [], `docs/schema-budgets.md prose hand-types a byte figure: ${hits.join(', ')}`);
  });

  it('the two rules catch live aggregates and spare per-module warrant history', () => {
    // The relaxation is deliberate, so it is demonstrated rather than asserted.
    // `main` merged a `### Baseline raises` section that records *dated* per-module
    // baselines — the measured warrant for a raise is the whole point of recording
    // it — and the same sentence carried a live aggregate figure, already 10
    // bytes stale on arrival. The rules have to catch the second and tolerate the
    // first, so this pins both halves against the real text in the file.
    const prose = stripGeneratedBlocks(readDoc('docs/schema-budgets.md'));
    const raise = /- \*\*#900\*\*[\s\S]*?\n\s*\n/.exec(prose);
    assert.ok(raise, 'docs/schema-budgets.md no longer carries the #900 per-module raise history');

    // The magnitude pattern sees the five-digit per-module figures...
    assert.deepEqual(
      figuresIn(raise[0], HAND_TYPED_FIGURE).sort(),
      ['2,043', '2,235', '21,825', '22,277'],
      'precondition: the pattern no longer sees the per-module raise history, so the rules are not being exercised',
    );
    // ...and neither rule takes them, because a dated raise is not a live figure.
    assert.deepEqual(
      ungatedAggregateFiguresIn(raise[0]),
      [],
      'a rule flagged a per-module baseline raise, which is dated history rather than a live aggregate',
    );

    // But a live aggregate figure in that same sentence is fatal — which is the
    // clause `main` arrived with, verbatim. The unit arm is what catches the
    // five-digit ones; a magnitude threshold alone would have passed all of them.
    const anchor = 'no ceiling moved to make a breach disappear.';
    assert.ok(raise[0].includes(anchor), 'the #900 raise history no longer ends where this test assumes');
    const withAggregate = raise[0].replace(
      anchor,
      'the aggregate moved 606,460 → 607,104 bytes against the 621,000-byte enforced ceiling, leaving 13,896 bytes of headroom.',
    );
    assert.deepEqual(
      ungatedAggregateFiguresIn(withAggregate),
      ['13,896', '606,460', '607,104', '621,000'],
      'a live aggregate figure inside the raise history was not caught',
    );
  });

  it('the magnitude arm catches an aggregate figure written without a unit', () => {
    // Its own test so it can fail on its own. The byte-unit arm catches a
    // figure that says `B` or `bytes`; this is the other half — prose quoting a
    // payload with no unit on it, which is just as much a live figure. If the
    // two arms ever collapsed into one, a suite where only the other could fail
    // would be a suite that stops guarding half of what it claims to.
    const bare = 'The payload came to 607094 and the ceiling 620000, so it fits.';
    assert.deepEqual(
      ungatedAggregateFiguresIn(bare),
      ['607094', '620000'],
      'a unit-less aggregate figure was not caught; only the byte-unit arm is load-bearing',
    );
  });

  it('the schema-budget figure guard would have caught every number #1241 reported', () => {
    const restored = readDoc('docs/schema-budgets.md').replace(
      'whole default surface:',
      [
        '`defaultMaxBytes` is 607,000B and the enforced limit is that plus 1,000B, so',
        '**608,000B is the real ceiling**. Measured on the tree carrying #1004 and',
        'the whole wave (592 tools): **607,715B — 285B of headroom, which is not',
        'headroom.** whole default surface:',
      ].join(' '),
    );
    // 592 is below the floor and carries no unit, so neither arm sees it: a tool
    // count is governed by its own rule. Every byte figure in the issue's own
    // passage is caught, including the four- and three-digit ones (1,000B, 285B)
    // that a magnitude threshold alone would have waved through.
    const hits = ungatedAggregateFiguresIn(stripGeneratedBlocks(restored));
    assert.deepEqual(hits, ['1,000', '285', '607,000', '607,715', '608,000'], 'the guard missed a figure from the issue report');
  });

  it('AGENTS.md §3 still names every generated block in the tree', () => {
    // The census gained two blocks. Its own generated list must have picked
    // them up; if `--write` were skipped for AGENTS.md this fails.
    const listed = generatedBlockBody('AGENTS.md', 'generated-blocks');
    for (const expected of [
      '`README.md`: `surface-census`, `gated-endpoints`',
      '`docs/schema-budgets.md`: `schema-budget-table`, `aggregate-budget`',
    ]) {
      assert.ok(listed.includes(expected), `AGENTS.md §3 is missing "${expected}"`);
    }
  });
});
