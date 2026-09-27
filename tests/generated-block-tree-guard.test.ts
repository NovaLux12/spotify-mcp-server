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
  'docs/cookbook.md',
  'docs/distribution.md',
  'docs/schema-budgets.md',
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
// test files in parallel. Three separate `--check` runs to cover three planted
// defects was enough extra load to tip `tests/infra.test.ts`'s wall-clock
// ValidatorStore test over its 60ms TTL, so the planted-defect run is done once
// and shared. The assertions stay separate; only the subprocess is shared.
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
