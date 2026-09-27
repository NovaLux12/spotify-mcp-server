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
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SpotifyClient } from '../src/client.js';
import {
  REGISTRY_SCALE_CEILING,
  REGISTRY_SCALE_FLOOR,
  assertFloorIsDrawnCorrectly,
  blankGenerated,
  collectToolCountErrors,
  maskSource,
  maskToComments,
  registryScaleToolCounts,
  scannableFiles,
} from '../scripts/check-doc-tool-counts.mjs';
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
    //
    // #1290 supersedes the last part of that: those dated records are no longer
    // merely tolerated by being out of scope, they are regulated by
    // `scripts/check-doc-tool-counts.mjs`, which scans every document and every
    // `src/` comment and requires each one to be allowlisted line by line. What
    // stays a decision here is that a *dated* record may keep its number, which
    // is why the other rule keys on README's own prose.
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

// ---------------------------------------------------------------------------
// #1290 — registry tool counts in hand-maintained text
// ---------------------------------------------------------------------------

/**
 * #1290 is the gap in everything above. Those rules cover three documents by
 * name, and a `.ts` comment is not a document, so a stale "592 tools" sat in
 * six `src/` comments and one docs line for as long as the surface moved under
 * it. The fix is not a refresh: `scripts/check-doc-tool-counts.mjs` refuses a
 * registry-scale tool count anywhere outside a generated block, and a comment
 * that genuinely needs one has to record what it measured and when.
 *
 * Every test here is two-sided. The gate is driven as a subprocess against a
 * copy of the tree, so a mutation is a file edit rather than a re-implementation
 * of the comparison, and each mutation's expected failure is asserted on the
 * script's own output. A guard whose negative case was never run is the thing
 * §6 is warning about.
 */

/** The census this rule is anchored to, generated once and shared. */
let cachedCensus: Record<string, unknown> | undefined;
let cachedCensusFile: string | undefined;

function censusJson(): string {
  if (!cachedCensusFile) {
    const dir = mkdtempSync(join(tmpdir(), 'smcp-doc-figures-census-'));
    const file = join(dir, 'census.json');
    writeFileSync(file, execFileSync(process.execPath, ['scripts/surface-census.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }));
    cachedCensusFile = file;
    cachedCensus = JSON.parse(readFileSync(file, 'utf8'));
  }
  return cachedCensusFile;
}

function census(): Record<string, any> {
  censusJson();
  return cachedCensus as Record<string, any>;
}

/**
 * A throwaway copy of every file the rule reads, taken from the gate's own
 * `scannableFiles` so the test cannot fall behind the gate's scope.
 */
function withTree<T>(run: (root: string) => T): T {
  return withTempDir((dir) => {
    const root = join(dir, 'tree');
    for (const file of scannableFiles(ROOT)) {
      const destination = join(root, relative(ROOT, file));
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, readFileSync(file));
    }
    return run(root);
  });
}

/** Rewrite one file in a throwaway tree; the edit must actually change it. */
function editIn(root: string, file: string, mutate: (source: string) => string): void {
  const path = join(root, file);
  const before = readFileSync(path, 'utf8');
  const after = mutate(before);
  assert.notEqual(after, before, `precondition: the mutation changed nothing in ${file}`);
  writeFileSync(path, after);
}

/**
 * Drive the real gate against a mutated tree and return its combined output
 * plus the exit status. A clean tree exits 0; every mutation below asserts on
 * what the script printed, not on a re-derivation of it.
 */
function runGate(root: string): { code: number; output: string } {
  const args = ['scripts/check-doc-tool-counts.mjs', '--root', root, '--census-file', censusJson()];
  try {
    const stdout = execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 });
    return { code: 0, output: stdout };
  } catch (error) {
    const result = error as { status?: number; stdout?: string; stderr?: string };
    return { code: result.status ?? 1, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
  }
}

describe('registry tool counts stay out of hand-maintained text (#1290)', () => {
  it('the real gate passes on this tree', () => {
    const { code, output } = runGate(ROOT);
    assert.equal(code, 0, `the gate rejected the tree it is supposed to accept:\n${output}`);
    assert.deepEqual(collectToolCountErrors(ROOT, census()), [], 'the in-process comparison and the script disagree');
    // The gate is not vacuous: there is a real allowance list doing work, and
    // every entry in it is load-bearing because a dead one is an error.
    assert.ok(output.includes('no hand-typed registry tool count'), `unexpected gate output: ${output}`);
  });

  it('rejects the three present-tense sentences #1290 reported', () => {
    // The sentences as they actually stood on the tree this branch started
    // from. Each is restored into the real file it came from, so the gate has
    // to find a count in hand-written prose and in a `.ts` comment — the two
    // shapes the document rules above never looked at.
    const cases: { file: string; from: string; to: string }[] = [
      {
        file: 'src/logout.ts',
        from: 'would join the `tools/list` surface and every host',
        to: 'would join the `tools/list` surface (592 tools today) and every host',
      },
      {
        file: 'src/shaping.ts',
        from: 'fragment stays as-is for every other tool;',
        to: 'fragment stays as-is for the other ~590 tools;',
      },
      {
        file: 'SPEC.md',
        from: 'the escape hatch for a registry of hundreds of tools',
        to: 'the escape hatch for a 592-tool surface',
      },
    ];
    for (const { file, from, to } of cases) {
      const { code, output, expectedLine } = withTree((root) => {
        const before = readFileSync(join(ROOT, file), 'utf8');
        // The anchor has to be present *and* unique. A `replace` that lands on
        // the wrong occurrence would plant the text somewhere the case does not
        // mean to check, and the case would still pass.
        assert.equal(
          before.split(from).length - 1, 1,
          `precondition: "${from}" must appear exactly once in ${file}, found ${before.split(from).length - 1}`,
        );
        editIn(root, file, (source) => source.replace(from, to));
        // The expected line is derived from the tree as edited, never typed.
        // #1316 broke this test by adding lines to SPEC.md above the planted
        // sentence: a hand-typed `line: 1702` is the same defect as a hand-typed
        // tool count — a value the code re-derives at runtime, typed into a
        // place that rots silently until something unrelated breaks.
        const edited = readFileSync(join(root, file), 'utf8');
        const occurrences = edited.split(to).length - 1;
        assert.equal(occurrences, 1, `precondition: the planted text must appear exactly once in ${file}, found ${occurrences}`);
        const line = edited.slice(0, edited.indexOf(to)).split('\n').length;
        return { ...runGate(root), expectedLine: line };
      });
      assert.notEqual(code, 0, `restoring "${to}" into ${file} was not rejected`);
      const firstFinding = output.split('\n').find((found) => found.trim().length > 0)?.trim() ?? '';
      assert.ok(
        firstFinding.startsWith(`${file}:${expectedLine}:`),
        `expected the gate's first finding to be ${file}:${expectedLine}, got "${firstFinding}"\n${output}`,
      );
      assert.match(output, /hand-typed registry tool count "~?5\d\d"/, `the gate did not report the figure it found:\n${output}`);
    }
  });

  it('an allowance cannot launder a count on another line of the same file', () => {
    // The allowance list is line-scoped, so this is the case a whole-file
    // allowance would wave through: `src/tools/annotations.ts` carries seven
    // allowed lines, and a bare "today" claim added beside them is still fatal.
    const { code, output } = withTree((root) => {
      editIn(root, 'src/tools/annotations.ts', (source) =>
        source.replace(
          "  manifestEntry('catalog', 'catalog'",
          '  // 592 tools today, per the surface census.\n  manifestEntry(\'catalog\', \'catalog\'',
        ));
      return runGate(root);
    });
    assert.notEqual(code, 0, 'a new count inside an allowlisted file was accepted');
    assert.match(output, /src\/tools\/annotations\.ts:\d+: hand-typed registry tool count "592"/, output);
    assert.doesNotMatch(output, /is dead/, 'the existing allowances should still be live, so this must be the only failure');
  });

  it('a reworded allowance line is a dead allowance, not a silent pass', () => {
    // The other direction. If the allowance only had to exist, rewording the
    // sentence it covers would quietly hand the tree a free registry count —
    // so a line that no longer matches its allowance is reported, and the
    // reviewer has to re-read what the number was warranting.
    const { code, output } = withTree((root) => {
      editIn(root, 'src/tools/annotations.ts', (source) =>
        source.replace('+1% each, against a 592-tool tools/list payload.', '+1% each, against a 592 tool tools/list payload.'));
      return runGate(root);
    });
    assert.notEqual(code, 0, 'a rewording that orphaned an allowance passed');
    assert.match(output, /allowance for src\/tools\/annotations\.ts is dead/, output);
    assert.match(output, /\+1% each, against a 592-tool tools\/list payload\./, 'the dead allowance must quote what it no longer matches');
  });

  it('a count inside a generated block is not a finding, and blanking is what makes that so', () => {
    // The negative direction of the generated-block handling. `src/toolsets.ts`
    // states the registry total in its `surface-census` block, and that number
    // is the one in the tree that is not allowed to rot — so the rule has to
    // leave it alone, and the reason it does is the blanking, not a pattern
    // that happens to miss it.
    const file = 'src/toolsets.ts';
    const generated = /\/\/ BEGIN:generated surface-census[\s\S]*?\/\/ END:generated surface-census/.exec(readFileSync(join(ROOT, file), 'utf8'));
    assert.ok(generated, `precondition: ${file} has no surface-census block`);
    const inside = generated![0];
    const figure = /(\d[\d,]*) tools/.exec(inside)?.[1];
    assert.ok(figure, `precondition: the ${file} block states no tool count`);
    // The block's own number, in the block, is masked out.
    assert.deepEqual(registryScaleToolCounts(maskSource(inside, true)), [], 'the generated block was not blanked');
    // The same number outside a block is a finding, at the magnitude the gate
    // draws. Without this the blanking test above would also pass on a pattern
    // that simply cannot see a count.
    assert.deepEqual(
      registryScaleToolCounts(maskSource(`// ${figure} tools, on the merged tree.`, true)).map((hit) => hit.figure),
      [figure],
      'the pattern does not see a registry count outside a generated block',
    );
    // And a deliberately wrong figure inside the real block is still ignored.
    const { code, output } = withTree((root) => {
      editIn(root, file, (source) => source.replace(`${figure} tools,`, '592 tools,'));
      return runGate(root);
    });
    assert.equal(code, 0, `a stale count inside a generated block was reported as a finding:\n${output}`);
  });

  it('the floor is drawn from the measurement, and a count below it is a module, not the registry', () => {
    // The rule keys on magnitude, so the magnitude has to mean something. The
    // census says the registry is three digits and the largest single module is
    // not, which is what makes "31 tools" a per-module figure that
    // `surface-census --check` already validates and "592 tools" a claim about
    // the whole registry that nothing else validates.
    const measured = census();
    const largest = Math.max(...Object.values(measured.perModule as Record<string, number>));
    assert.ok(
      measured.tools >= REGISTRY_SCALE_FLOOR && measured.tools < REGISTRY_SCALE_CEILING,
      `precondition: the registry is ${measured.tools} tools, so "hundreds" in SPEC.md is ${measured.tools < REGISTRY_SCALE_CEILING ? 'true' : 'false'} and the ${REGISTRY_SCALE_FLOOR} floor is meaningful`,
    );
    assert.ok(
      largest < REGISTRY_SCALE_FLOOR,
      `precondition: the largest module holds ${largest} tools, so no per-module count reaches the floor`,
    );
    // SPEC.md leans on the upper bound of that range, so it is asserted rather
    // than trusted: the sentence this branch rewrote says "hundreds".
    assert.ok(
      readDoc('SPEC.md').includes('a registry of hundreds of tools'),
      'SPEC.md no longer states the surface as hundreds; the floor contract it leans on needs a review',
    );
    // The floor is the discriminator, on both sides of it.
    assert.deepEqual(registryScaleToolCounts(maskSource('// 31 tools / 27222B -> 31 tools / 27222B', true)), []);
    assert.deepEqual(registryScaleToolCounts(maskSource('// 592 tools, measured on the merged tree', true)).map((h) => h.figure), ['592']);
    // `tools: 592` is the other word order, and a count whose noun wrapped to
    // the next line of the same comment is the shape annotations.ts actually has.
    assert.deepEqual(registryScaleToolCounts(maskSource('// [27, 24316] from the real registrar (tools: 592).', true)).map((h) => h.figure), ['592']);
    assert.deepEqual(
      registryScaleToolCounts(maskSource('// 607,715B over the same 592\n//         tools — the smaller number', true)).map((h) => h.figure),
      ['592'],
      'a count whose noun wrapped onto the next comment line was missed',
    );
    // And the tokens that look like figures but are not: a markdown anchor, a
    // branch name, a version, a per-module baseline, a byte figure.
    for (const notAFigure of [
      '5. [Tools](#5-tools)',
      'branch swarm3-500-tools',
      'feature swarm v1.25.0',
      '24,316B baseline',
      'the aggregate is 606,460 → 607,104 bytes',
      'tools/list 606,353 B across 31',
    ]) {
      assert.deepEqual(
        registryScaleToolCounts(maskSource(`// ${notAFigure}`, true)),
        [],
        `a non-figure was read as a registry tool count: ${notAFigure}`,
      );
    }
  });

  it('a registry or a module that leaves the three-digit range fails the gate loudly', () => {
    // Both ends of the floor, so the threshold cannot quietly stop meaning
    // anything. Without this the rule would still pass on a surface of 40 tools
    // while checking nothing at all.
    const real = census();
    const shrunk = { ...real, tools: 40 };
    assert.throws(() => assertFloorIsDrawnCorrectly(shrunk), /below the \d+ floor/, 'a sub-100 registry did not fail the floor contract');
    const quadrupled = { ...real, tools: 4200 };
    assert.throws(() => assertFloorIsDrawnCorrectly(quadrupled), /no longer "hundreds"/, 'a four-digit registry did not fail the floor contract');
    const fatModule = { ...real, perModule: { ...real.perModule, 'src/tools/annotations.ts': 140 } };
    assert.throws(() => assertFloorIsDrawnCorrectly(fatModule), /a module registers 140 tools/, 'a module at the floor did not fail the floor contract');
    assert.doesNotThrow(() => assertFloorIsDrawnCorrectly(real), 'precondition: the real census does not satisfy the floor contract');
  });

  it('comment-only scanning of src/ costs no coverage today', () => {
    // The stated limitation: a trailing `//` comment on a code line is not
    // scanned, because a TypeScript comment cannot be told from a string
    // without a parser. This asserts the limitation is currently free rather
    // than assuming it — if a code line ever grows a registry count, this goes
    // red and the masking is revisited instead of the gap quietly widening.
    // Both sides are blanked the same way, so a generated block is not what
    // this reports.
    const offenders: string[] = [];
    for (const file of scannableFiles(ROOT)) {
      const name = relative(ROOT, file);
      if (!name.startsWith('src/')) continue;
      const blanked = blankGenerated(readFileSync(file, 'utf8'));
      const seen = registryScaleToolCounts(blanked);
      const scanned = new Set(registryScaleToolCounts(maskToComments(blanked)).map((hit) => hit.index));
      for (const hit of seen) {
        if (!scanned.has(hit.index)) offenders.push(`${name}: ${JSON.stringify(blanked.slice(hit.index, hit.index + 12).split('\n')[0])}`);
      }
    }
    assert.deepEqual(offenders, [], `a registry count sits on a code line the comment mask skips: ${offenders.join(', ')}`);
    // And the mirror of that limitation, asserted rather than assumed: every
    // comment *shape* the tree uses is still scanned, including a block
    // comment written without leading asterisks, whose continuation lines carry
    // no `*` for a naive prefix strip to key on.
    for (const shape of [
      '// 592 tools, measured on the merged tree',
      '/**\n * 592 tools, measured on the merged tree\n */',
      '/*\n592 tools, measured on the merged tree\n*/',
      '/** 592 tools, measured on the merged tree */',
    ]) {
      assert.deepEqual(
        registryScaleToolCounts(maskSource(shape, true)).map((hit) => hit.figure),
        ['592'],
        `a comment shape the mask drops: ${JSON.stringify(shape)}`,
      );
    }
    // A code line immediately after a closed block comment is masked again, so
    // the exemption above does not leak past the `*/`.
    assert.deepEqual(
      registryScaleToolCounts(maskSource('/*\ntext\n*/\nconst n = 1; // 592 tools', true)),
      [],
      'a trailing comment on the line after a block comment was scanned as a comment',
    );
  });
});
