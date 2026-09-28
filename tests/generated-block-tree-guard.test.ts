/**
 * Generated-block marker-tree guard (#1238).
 *
 * `npm run count:tools -- --check` used to walk exactly one list: the `blocks`
 * array in `scripts/surface-census.mjs`. Every `BEGIN:generated <name>` /
 * `END:generated <name>` pair that no entry in that array claimed was therefore
 * invisible to the gate — and a block nobody registered is precisely the block
 * nobody maintains. It could sit in a file, go stale, and stay ungated, with CI
 * green, because the gate was never asked about it.
 *
 * The fix inverts the direction: a second pass walks the *tree* and reconciles
 * every marker pair it finds against the entries in `blocks`. This file guards
 * that pass, in two halves that both matter:
 *
 *  - **Classification** — an orphan, a phantom, an unbalanced pair and a
 *    double-claimed block are each reported with the direction named.
 *  - **Wiring and coverage** — the classifier being correct proves nothing if
 *    `checkDocumentation` never calls it, and a scan that finds nothing at all
 *    would report green forever. So one test drives the real `--check` over a
 *    planted orphan, and one pins the set of files the real scan reads.
 *
 * The second half is the point. An earlier guard in `arch-inventory.test.ts`
 * caught orphans by walking the tree in the test and comparing against
 * AGENTS.md §3; that caught the symptom while the gate itself stayed blind, and
 * its own comment records the limitation. This one targets the gate.
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every file that currently carries a generated block. */
const EXPECTED_FILES = [
  'AGENTS.md',
  'ARCHITECTURE.md',
  'README.md',
  'SPEC.md',
  // Added by #1288, which gave the cookbook's recipe count a generated block.
  // Added by #926, which gave the env reference's two hand-typed name lists
  // generated blocks — making it a mixed document the tree scan must read.
  'docs/configuration.md',
  'docs/cookbook.md',
  'docs/distribution.md',
  // Added by #1630, which gave the 3.0 migration guide's retirement tables a
  // generated block so the guide cannot drift from the runtime constants.
  // Sorted into place, not appended: this list is compared deep-equal against
  // a sorted walk of the real tree, so a new marked file has to land where its
  // name sorts or the guard fails on ordering rather than on coverage.
  'docs/migration-v3.md',
  'docs/schema-budgets.md',
  // Added with the 3.0 roadmap, whose headline figures are measured by the census.
  'docs/v3-roadmap.md',
  'docs/wave2-composites.md',
  'skills/spotify-exhaustive-feature-sweep/SKILL.md',
  'skills/spotify-mcp-competitor-comparison/SKILL.md',
  'src/toolsets.ts',
];

type Report = { errors: string[]; markerCount: number; claimedCount: number; files: string[] };
type Run = { status: number; stdout: string; stderr: string };

function runCensus(args: string[]): Run {
  try {
    const stdout = execFileSync(process.execPath, ['scripts/surface-census.mjs', ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

/** A census run that must fail, with its diagnostics. */
function censusFailure(args: string[]): Run {
  const run = runCensus(args);
  assert.notEqual(run.status, 0, `expected \`${args.join(' ')}\` to exit non-zero`);
  return run;
}

/**
 * Scratch directories live under `os.tmpdir()`, never inside the repository and
 * never at a fixed shared path. The test runner executes test files in parallel
 * and other agents work in sibling worktrees, so a fixed `/tmp/*.md` scratch
 * path would be clobbered out from under a run.
 */
async function withScratchDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'spotify-mcp-marker-tree-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeFixture(dir: string, name: string, payload: unknown): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, JSON.stringify(payload));
  return file;
}

const markdownBlock = (name: string, body = 'body') =>
  `<!-- BEGIN:generated ${name} -->\n${body}\n<!-- END:generated ${name} -->\n`;

// Each full census run spawns the whole MCP server, and the test runner executes
// test files in parallel, so three separate `--check` runs to cover three planted
// defects is three servers' worth of startup for one shared input. The
// planted-defect run is done once and shared. The assertions stay separate; only
// the subprocess is shared.
//
// This used to be justified by a specific flake — enough extra load to tip
// `tests/infra.test.ts`'s wall-clock ValidatorStore test over its 60ms TTL, which
// is now driven by an injected clock and cannot fail that way (#1386). The
// sharing stands on its own cost, not on that test.
let realReport: Report | undefined;
function realTreeReport(): Report {
  realReport ??= JSON.parse(runCensus(['--marker-tree-report']).stdout) as Report;
  return realReport;
}

let plantedRun: Run | undefined;
/** `--check` over a scratch tree holding all three structural defects at once. */
async function checkWithPlantedDefects(): Promise<Run> {
  plantedRun ??= await withScratchDir(async (dir) => {
    await writeFile(join(dir, 'orphan.md'), markdownBlock('never-registered'));
    await writeFile(join(dir, 'half-open.md'), '<!-- BEGIN:generated half-open -->\nbody\n');
    await writeFile(join(dir, 'closing-only.md'), 'body\n<!-- END:generated closing-only -->\n');
    return censusFailure(['--check', '--marker-tree-extra', dir]);
  });
  return plantedRun;
}

describe('generated-block marker tree (#1238)', () => {
  it('reads every file in the repository that carries a generated block', () => {
    // Non-vacuity, and the exact assertion #1238 asks for. A scan that found
    // nothing would pass a "no orphans" test trivially and forever, so the
    // coverage itself is pinned: the file list, and a marker count that is
    // exactly two per claimed block. If a new generated block is added, both
    // sides move together and this stays honest; if the scan stops covering
    // the tree, `files` loses an entry and the test goes red.
    const report = realTreeReport();
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.files, EXPECTED_FILES);
    assert.ok(report.claimedCount >= 15, `expected at least 15 claimed blocks, found ${report.claimedCount}`);
    assert.equal(
      report.markerCount,
      report.claimedCount * 2,
      'every claimed block must contribute exactly one BEGIN and one END marker, and no marker may be unclaimed',
    );
  });

  it('reports no orphan and no phantom in the current tree', () => {
    const report = realTreeReport();
    assert.deepEqual(report.errors, [], report.errors.join('\n'));
  });

  it('fails --check when a marker pair in the tree is claimed by nothing', async () => {
    // The wiring proof. `--marker-tree-fixture` could only ever show the
    // classifier is right in isolation; this drives the real gate end to end,
    // which is the only thing that demonstrates `checkDocumentation` calls it.
    // The defect in #1238 was a correct idea that was never reached, so a test
    // of the classifier alone would have passed against the unfixed gate.
    const run = await checkWithPlantedDefects();
    assert.match(run.stderr, /never-registered/, 'the orphan must be named');
    assert.match(run.stderr, /\(orphan\)/, 'the failure must say the direction went wrong');
    assert.match(run.stderr, /can never report it stale|not claimed/, 'the message must say what stays ungated');
  });

  it('fails --check when a marker pair is missing its END', async () => {
    const run = await checkWithPlantedDefects();
    assert.match(run.stderr, /half-open/, 'the unbalanced block must be named');
    assert.match(run.stderr, /unbalanced/, 'the failure must name the balance class');
  });

  it('fails --check when a marker is missing its opening BEGIN', async () => {
    const run = await checkWithPlantedDefects();
    assert.match(run.stderr, /closing-only/);
    assert.match(run.stderr, /unbalanced/);
  });

  it('flags a blocks entry whose markers do not exist, naming the phantom direction', async () => {
    const errors = await withScratchDir(async (dir) => {
      const file = await writeFixture(dir, 'phantom.json', {
        blocks: [['README.md', 'no-such-block']],
        markers: [],
      });
      const run = censusFailure(['--marker-tree-fixture', file]);
      return (JSON.parse(run.stdout) as Report).errors;
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /README\.md:no-such-block/);
    assert.match(errors[0], /phantom/, 'a phantom must be distinguishable from a stale body');
  });

  it('flags a block claimed by two blocks entries', async () => {
    const errors = await withScratchDir(async (dir) => {
      const file = await writeFixture(dir, 'double-claimed.json', {
        blocks: [['README.md', 'twice'], ['README.md', 'twice']],
        markers: [
          { file: 'README.md', kind: 'begin', name: 'twice' },
          { file: 'README.md', kind: 'end', name: 'twice' },
        ],
      });
      const run = censusFailure(['--marker-tree-fixture', file]);
      return (JSON.parse(run.stdout) as Report).errors;
    });
    assert.ok(errors.some((line) => /README\.md:twice/.test(line) && /by 2 entries/.test(line)), errors.join('\n'));
  });

  it('flags a marker pair whose file is not the one the blocks entry claims', async () => {
    // The same key on both sides would pass; only the file differs, so a guard
    // keying on name alone would miss this.
    const errors = await withScratchDir(async (dir) => {
      const file = await writeFixture(dir, 'wrong-file.json', {
        blocks: [['README.md', 'shared-name']],
        markers: [
          { file: 'SPEC.md', kind: 'begin', name: 'shared-name' },
          { file: 'SPEC.md', kind: 'end', name: 'shared-name' },
        ],
      });
      const run = censusFailure(['--marker-tree-fixture', file]);
      return (JSON.parse(run.stdout) as Report).errors;
    });
    assert.ok(errors.some((line) => /SPEC\.md:shared-name/.test(line) && /orphan/.test(line)), errors.join('\n'));
    assert.ok(errors.some((line) => /README\.md:shared-name/.test(line) && /phantom/.test(line)), errors.join('\n'));
  });

  it('accepts a tree and a blocks array that agree', async () => {
    // The other direction: a classifier that only ever returns errors would
    // satisfy every test above.
    const report = await withScratchDir(async (dir) => {
      const file = await writeFixture(dir, 'clean.json', {
        blocks: [['README.md', 'a'], ['SPEC.md', 'b']],
        markers: [
          { file: 'README.md', kind: 'begin', name: 'a' },
          { file: 'README.md', kind: 'end', name: 'a' },
          { file: 'SPEC.md', kind: 'begin', name: 'b' },
          { file: 'SPEC.md', kind: 'end', name: 'b' },
        ],
      });
      const run = runCensus(['--marker-tree-fixture', file]);
      assert.equal(run.status, 0, run.stdout);
      return JSON.parse(run.stdout) as Report;
    });
    assert.deepEqual(report.errors, []);
    assert.equal(report.claimedCount, 2);
  });

  it('still guards staleness for a block that is properly claimed', async () => {
    // The tree pass must not have displaced the original job. A claimed,
    // balanced, uniquely-owned block whose body has drifted is still stale.
    await withScratchDir(async (dir) => {
      const file = await writeFixture(dir, 'stale.json', {
        source: '<!-- BEGIN:generated current -->\nnew body\n<!-- END:generated current -->',
        file: 'README.md',
        name: 'current',
        body: 'old body',
      });
      const run = censusFailure(['--marker-fixture', file]);
      assert.match(run.stdout, /stale/);
    });
  });
});

/**
 * The one generated block that is not in a document (#1438).
 *
 * `src/toolsets.ts` carries a `// BEGIN:generated surface-census` block — the
 * registry totals, as a comment, at the top of a source file. Everything else
 * the census generates lands in Markdown, and the *prose* pin (#1384) is
 * Markdown-only by design, so this block sits in the one file class that
 * neither of the documentation gates was built to think about. That made it
 * look ungated, and #1438 was filed on the reading that `--check` does not
 * compare it.
 *
 * It does. The two mechanisms are separate and it is worth saying which does
 * what, because conflating them is what produced the issue:
 *
 *  - **Staleness** is `checkDocumentation()`'s per-block loop, and it reads the
 *    `blocks` array — *any* extension, `src/toolsets.ts` included. A count in
 *    that file goes stale when the registry moves, and `--check` reports it:
 *    `src/toolsets.ts: generated surface-census block is stale`.
 *  - **Prose loss** is the `doc-prose-manifest.json` reconciliation, and it is
 *    Markdown-only because pinning source code as though it were documentation
 *    is not the same hazard. That exclusion is enumerated and asserted on the
 *    other side, by `EXPECTED_FILES` in `tests/doc-prose-integrity.test.ts`,
 *    so this file joining the prose scope would go red there rather than
 *    passing by default.
 *
 * The tree pass already pins the *structural* claim — `EXPECTED_FILES` above
 * names `src/toolsets.ts`, so dropping the file from `blocks` reports it as an
 * orphan. What was missing is the body claim for this file specifically, and
 * that is what the test below adds: it drives the real `inspectGeneratedBlock`
 * over a truncated copy of the real file, in the `//`-comment syntax, which is
 * the shape a `--theirs` conflict resolution actually leaves behind.
 */
describe('the generated block in src/toolsets.ts (#1438)', () => {
  const FILE = 'src/toolsets.ts';
  const NAME = 'surface-census';
  const start = `// BEGIN:generated ${NAME}`;
  const end = `// END:generated ${NAME}`;

  /**
   * The real file's block, split into the body and the rendered whole.
   *
   * Every assertion here is a precondition, and each one says what it would
   * mean if it failed: a fixture built from a mis-sliced block would still
   * "prove" the gate rejects *something*, which is the shape of a test that
   * cannot fail (AGENTS.md §6). Note the two newlines: the body sits between
   * two markers that each own a line, so exactly one newline is stripped from
   * each side and the middle is left alone.
   *
   * Whether the checked-in body is *current* is a different claim, and it is
   * asserted where it can be measured rather than reconstructed — by
   * `checkDocumentation` comparing this file against the real registry in
   * `tests/arch-inventory.test.ts`, and in CI.
   */
  function realBlock(): { body: string; rendered: string } {
    const source = readFileSync(join(ROOT, FILE), 'utf8');
    const startAt = source.indexOf(start);
    const endAt = source.indexOf(end);
    assert.ok(startAt >= 0 && endAt > startAt, `precondition: ${FILE} has no ${NAME} block`);
    assert.equal(source.split(start).length - 1, 1, `precondition: ${FILE} must carry exactly one ${start} marker`);
    assert.equal(source.split(end).length - 1, 1, `precondition: ${FILE} must carry exactly one ${end} marker`);
    const between = source.slice(startAt + start.length, endAt);
    assert.ok(
      between.startsWith('\n') && between.endsWith('\n'),
      `precondition: the ${NAME} body must sit between the markers on their own lines; found ${JSON.stringify(between.slice(0, 40))}`,
    );
    const body = between.slice(1, -1);
    assert.match(
      body,
      /\d+ tools, \d+ fixed resources, \d+ resource templates, and \d+ prompts\./,
      `precondition: the ${FILE} block states no registry totals; a fixture built from it would prove nothing`,
    );
    return { body, rendered: source.slice(startAt, endAt + end.length) };
  }

  it('rejects a truncated block, and accepts the real one', async () => {
    // The wiring proof, and the claim #1438's premise denies. Two halves, and
    // both have to hold:
    //
    //  - `blocks` *claims* this file. The tree pass above reports no orphan
    //    for it, which means the `blocks` array declares
    //    `['src/toolsets.ts', 'surface-census', …]` — and it is that
    //    declaration which makes `checkDocumentation` loop over the file at
    //    all. A file no `blocks` entry names is never staleness-checked, so
    //    this precondition is the half that turns the fixture below into a
    //    statement about the real gate rather than about a classifier.
    //  - `inspectGeneratedBlock` — the exact function that loop calls, with
    //    this exact file and name — rejects a body that has drifted. The
    //    `//`-comment syntax is used rather than the `<!-- -->` the Markdown
    //    fixtures use, because that is the spelling in this file.
    const { body, rendered } = realBlock();
    const report = realTreeReport();
    assert.deepEqual(report.errors, [], `precondition: the tree pass must report nothing:\n${report.errors.join('\n')}`);
    assert.ok(
      report.files.includes(FILE),
      `precondition: the tree pass must read ${FILE}; a file it does not reach has no staleness gate`,
    );

    await withScratchDir(async (dir) => {
      // The real source first, so a gate that reports *every* fixture as stale
      // cannot satisfy the assertion below.
      const clean = await writeFixture(dir, 'toolsets-current.json', {
        source: rendered, file: FILE, name: NAME, body,
      });
      const accepted = runCensus(['--marker-fixture', clean]);
      assert.equal(accepted.status, 0, `the real ${FILE} block was rejected as stale:\n${accepted.stdout}`);
      assert.deepEqual(JSON.parse(accepted.stdout), { error: null });

      // Then the shape a rebase conflict leaves behind: the markers survive,
      // the body they enclose does not. This is the drift the generated-block
      // gate exists to catch, in a `.ts` file rather than a document.
      const truncated = `${start}\n${NAME} block body lost to a --theirs resolution\n${end}`;
      const stale = await writeFixture(dir, 'toolsets-truncated.json', {
        source: truncated, file: FILE, name: NAME, body,
      });
      const run = censusFailure(['--marker-fixture', stale]);
      assert.match(run.stdout, new RegExp(`${FILE.replace('.', '\\.')}: generated ${NAME} block is stale`), run.stdout);
    });
  });
});
