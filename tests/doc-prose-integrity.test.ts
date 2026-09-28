/**
 * Hand-written prose integrity in documents that mix prose with generated
 * blocks (#1384).
 *
 * `ARCHITECTURE.md` interleaves hand-written prose with two generated blocks.
 * `writeBlock()` is marker-bounded, so `--write` can only ever replace what
 * sits between a BEGIN/END pair — but a whole-file conflict resolution in that
 * file takes a side wholesale, and the prose the losing side carried was never
 * between markers. The generator has no copy of it and no gate had a claim on
 * it, so during the #1350 work a paragraph of hand-written stats.fm prose
 * disappeared and both documentation gates stayed green. It was caught only
 * because an agent read its own diff and noticed a hunk it could not explain.
 *
 * The gate in `scripts/prose-manifest.mjs` pins that prose by content hash.
 * This file guards the gate, and the shape follows what the repository has
 * already learned about guarding gates:
 *
 *  - **Both directions, over the real `--check`.** A classifier that only ever
 *    returns errors satisfies every "does it detect the bug" test, so the clean
 *    tree has to go through the same code path and pass. The planted run is
 *    driven through the *real* gate rather than the classifier in isolation,
 *    because a correct check that is never reached is the failure this whole
 *    issue is about — the one #1238 had to fix in this repo already.
 *  - **The red must name the planted paragraph.** A non-zero exit could come
 *    from anything. Asserting the message names the exact text that was
 *    removed is what makes the exit evidence rather than an observation.
 *  - **The pin cannot be quietly rewritten.** `--prose-sync` refusing to drop
 *    a vanished entry is the property the whole design rests on: a pin that a
 *    command can regenerate on demand is not a pin. That is pinned here by
 *    asserting the manifest file is byte-identical afterwards.
 *  - **Normal work stays free.** Adding prose is what a tool-addition PR does.
 *    A gate that punishes it gets disabled, so that direction is asserted too.
 *    It is asserted in two places, and they failed for different reasons. The
 *    `errors` assertion held from the start; the *count* comparison did not.
 *    This file compared `currentCount` to `pinnedCount`, and while the pin was
 *    in sync those were equal, so the comparison looked like a second,
 *    redundant check on the same fact. It was not: it also failed the moment a
 *    paragraph was added, which is the one direction the gate is documented to
 *    let through, and it said so with a message about a paragraph that had gone
 *    missing. #1412 spent a diagnosis on it, and #1460 is the cleanup.
 *  - **And it is *reported*, which is where #1523 lands.** The bullet above is
 *    about `errors` and `--check`, and both still hold. `--prose-report` is the
 *    third thing, and it now fails on the surplus: a paragraph the pin has never
 *    seen is prose the guard cannot watch, because no key means no later
 *    deletion of it raises anything. Four `AGENTS.md` lessons merged that way
 *    with the report still exiting 0. "Free" and "unreported" are different
 *    claims, and only the first of them was ever true.
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeDocument, proseDrift, proseUnitHash, proseUnitLabel, qualifiedHash, splitProseUnits } from '../scripts/prose-manifest.mjs';
import { writeProvenanceFile } from './helpers/prose-tree.js';
import { armFileDeadline, FLEET_FILE_BUDGET_MS } from './helpers/file-deadline.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'scripts', 'doc-prose-manifest.json');

/**
 * Every document in the repository that mixes hand-written prose with at least
 * one generated block.
 *
 * Pinned as a list because a count alone cannot tell "covered every mixed
 * document" from "covered the three that hold most of the prose". The gate
 * derives this set by walking the tree for generated blocks rather than from a
 * hand-maintained array, so a new mixed document joins it automatically — and
 * this assertion is what makes a silent narrowing of the walk visible.
 */
const EXPECTED_FILES = [
  'AGENTS.md',
  'ARCHITECTURE.md',
  'README.md',
  'SPEC.md',
  // Added by #926, which gave the env reference's two hand-typed name lists
  // generated blocks — which is what made it a mixed document.
  'docs/configuration.md',
  'docs/cookbook.md',
  'docs/distribution.md',
  // Added by #1630, which gave the 3.0 migration guide a generated block for
  // its retirement tables — which is what made it a mixed document. Sorted
  // into place rather than appended: both this list and the tree walk it is
  // compared against are sorted, so a new mixed document lands where its name
  // sorts, and the non-vacuity check only holds if the two orders agree.
  'docs/migration-v3.md',
  'docs/schema-budgets.md',
  'docs/v3-roadmap.md',
  'docs/wave2-composites.md',
  'skills/spotify-exhaustive-feature-sweep/SKILL.md',
  'skills/spotify-mcp-competitor-comparison/SKILL.md',
];

/**
 * The paragraph #1384 is actually about: the stats.fm section at
 * `ARCHITECTURE.md:86`, which `--theirs` reverted during the #1350 work.
 *
 * Named as a literal rather than derived from the file, so this test fails if
 * the prose is edited, not only if it is deleted — a pin for a sentence nobody
 * reads is not a pin.
 */
const STATSFM_PROSE = 'Spotify is the system of record for playback, library, and catalog.';

/**
 * The replacement `STATSFM_PROSE` is reworded to in the #1527 tests.
 *
 * A real sentence rather than a marker, because the operation checks that the
 * replacement is a unit of the document as the splitter sees it — a fixture like
 * `REWORDED` would still be a paragraph, and that is the claim under test, so
 * the wording itself is free. It is deliberately *longer* than the sentence it
 * replaces, because "the paragraph is gone and the replacement is also gone" and
 * "the paragraph was reworded" have to be distinguishable in the manifest as
 * well as on the command line.
 */
const REWORDED_STATSFM = 'Spotify is the system of record for playback, library and catalog, and nothing else is';

/** The reason string the retirement tests record, asserted end to end. */
const RETIREMENT_REASON = 'removed the stale receipt paragraph';

/** The reason string the reanchor tests record, asserted end to end. */
const REANCHOR_REASON = 'the second-upstream sentence no longer held on its own; #1527 records the reword';

/**
 * A *second* reword of the same paragraph, for the chain case.
 *
 * Distinct from `REWORDED_STATSFM` and distinct from the paragraph it replaced,
 * because the chain test's whole claim is that a reanchor of an already-anchored
 * unit is not silently chained. A replacement that reused either existing text
 * would be refused by the deduplication in `describeDocument` rather than by the
 * rule under test.
 */
const SECOND_REWORD = 'Spotify is the only system of record for playback, library and catalog, and nothing else is';

type Run = { status: number; stdout: string; stderr: string };

type Reanchored = { file: string; hash: string; to: string; reason: string; date: string; label: string; toLabel?: string };

function runCensus(args: string[]): Run {
  // `spawnSync` rather than `execFileSync` for one reason, and it is a reason
  // several assertions depend on: `execFileSync` returns only stdout, so every
  // `stderr` this helper reported was stderr from a run that had *failed*. A
  // successful run's stderr — which is where every "--prose-sync wrote N
  // reanchored, M already recorded" line goes — read as empty, so "the command
  // said it did nothing" and "the command said nothing" were indistinguishable.
  // A test that cannot tell those apart is asserting on the exit code twice.
  const result = spawnSync(process.execPath, ['scripts/surface-census.mjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * Scratch directories live under `os.tmpdir()`, never inside the repository and
 * never at a fixed shared path: the test runner executes test files in parallel
 * and other agents work in sibling worktrees, so a fixed path would be
 * clobbered out from under a run.
 */
async function withScratchDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'spotify-mcp-prose-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Every pinned document as it stands, with one file replaced by `substitute`. */
async function readAllDocuments(substitute: string): Promise<Record<string, string>> {
  const documents: Record<string, string> = {};
  for (const file of EXPECTED_FILES) {
    documents[file] = file === 'ARCHITECTURE.md' ? await readFile(substitute, 'utf8') : await readFile(join(ROOT, file), 'utf8');
  }
  return documents;
}

/** Drop one paragraph from a document, the way a `--theirs` resolution would. */
function withoutParagraph(source: string, needle: string): string {
  const lines = source.split('\n');
  const kept = lines.filter((line) => !line.includes(needle));
  assert.notEqual(kept.length, lines.length, `the fixture paragraph "${needle}" was not found — this test would prove nothing`);
  return kept.join('\n');
}

/**
 * Reword one paragraph **in place**: same position, same line, different words.
 *
 * The in-place part is load-bearing rather than cosmetic. The defect #1527 is
 * about a reword and a deletion hashing identically, and a fixture that moved
 * the paragraph would differ in more ways than one, so a test built on a move
 * would still go green against a reanchor that had never been written. Line for
 * line, one line changed, is what the operation is actually for.
 */
function withRewordedParagraph(source: string, from: string, to: string): string {
  const lines = source.split('\n');
  const at = lines.findIndex((line) => line.includes(from));
  assert.notEqual(at, -1, `the fixture paragraph "${from}" was not found — this test would prove nothing`);
  const kept = [...lines];
  kept[at] = kept[at].replace(from, to);
  assert.notEqual(kept[at], lines[at], 'the replacement did not change anything, so there is no reword to record');
  return kept.join('\n');
}

/**
 * The whole prose unit carrying `needle` — the paragraph, not the sentence.
 *
 * The pin is keyed on the unit and the unit is the paragraph, so a test that
 * hashed the sentence would name a key that is in no manifest and prove nothing
 * at all. Resolved from the live document for the same reason: it is the only
 * definition of "that paragraph" that cannot drift from what the gate hashes.
 */
function paragraphContaining(source: string, needle: string): string {
  const unit = splitProseUnits(source).find((text) => text.includes(needle));
  assert.ok(unit, `no prose unit in the document contains "${needle}" — the fixture no longer describes a paragraph`);
  return unit;
}

// Every census run boots the MCP server, and the test runner executes test
// files in parallel on a box that is already loaded. The census JSON is
// therefore produced once and handed to each `--check` via `--census-file`, and
// each distinct run is memoized: the assertions stay separate, only the
// subprocess is shared.
let censusJson: string | undefined;
function censusFileArg(dir: string): string {
  censusJson ??= execFileSync(process.execPath, ['scripts/surface-census.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const path = join(dir, 'census.json');
  writeFileSync(path, censusJson);
  return path;
}

const reportCache = new Map<string, Run>();
function memo<T>(cache: Map<string, T>, key: string, produce: () => T): T {
  if (!cache.has(key)) cache.set(key, produce());
  return cache.get(key)!;
}

const checkCache = new Map<string, Run>();
function realCheck(dir: string, override?: string): Run {
  return memo(checkCache, override ?? 'clean', () => {
    const args = ['--check', '--census-file', censusFileArg(dir)];
    if (override) args.push('--prose-override', override);
    return runCensus(args);
  });
}

function realProseReport(): Run {
  return memo(reportCache, 'report', () => runCensus(['--prose-report']));
}

/**
 * Drive a real `--prose-sync --reanchor` against a scratch copy of the pin.
 *
 * Never the repository's own manifest: `--prose-sync` *writes* the path it is
 * given, and a test that rewrote the checked-in pin — particularly a test whose
 * subject is "does this get refused" — would corrupt the artefact it is testing
 * at exactly the moment the mechanism is broken. The same reason `--census-file`
 * and `--prose-provenance` exist: the decision code has to be the real one.
 */
async function reanchor(dir: string, copy: string, document: string, key: string, to: string): Promise<Run> {
  return runCensus([
    '--prose-sync',
    '--reanchor', key,
    '--to', to,
    '--why', REANCHOR_REASON,
    '--prose-manifest', copy,
    '--prose-override', `ARCHITECTURE.md=${document}`,
    // Same reasoning as the retirement tests: this file asserts what a reanchor
    // does, so it states the tree it is syncing against rather than inheriting
    // whatever git says about the machine the suite happens to run on.
    '--prose-provenance', await writeProvenanceFile(dir),
  ]);
}

type ProseReport = {
  errors: string[];
  currentCount: number;
  pinnedCount: number;
  unpinnedCount: number;
  coverage: { unpinned: Array<{ file: string; hash: string; label: string }>; missing: Array<{ file: string; hash: string; label: string }> };
  files: string[];
};
const report = (): ProseReport => JSON.parse(realProseReport().stdout) as ProseReport;

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
  label: 'tests/doc-prose-integrity.test.ts',
  budgetMs: FLEET_FILE_BUDGET_MS,
  children: () => [],
});

describe('hand-written prose integrity (#1384)', () => {
  it('covers every document that mixes prose with generated blocks', () => {
    // Non-vacuity. A walk that found nothing would report a clean verdict
    // identically to one that checked all ten files, and a "no errors" test
    // against it would pass forever. So the coverage itself is pinned: the file
    // list, and a unit count in the thousands rather than zero.
    const result = report();
    assert.deepEqual(result.errors, [], result.errors.join('\n'));
    assert.deepEqual(result.files, EXPECTED_FILES);
    // Every *pinned* paragraph is present. That is the one-directional fact,
    // and `errors` above is where it is established — it names every way a pin
    // can go missing and which paragraph did.
    //
    // It used to assert `currentCount === pinnedCount` instead, which is a
    // different and stronger claim — that the pin covers every prose unit in
    // the tree — wearing this message. It fires on the one direction where
    // nothing is wrong: a contributor adding a contract paragraph to a pinned
    // document turned the suite red with a message blaming a deletion, and
    // nothing was missing. #1412 hit it (`1195 !== 1192`) and was first
    // diagnosed as a stale gate, which was wrong; the count was the only
    // evidence offered and it did not say which way round it differed.
    //
    // The claim it contradicted was never in doubt. "Adding prose is free" is
    // stated as deliberate in AGENTS.md ("The gate (#1384)"), in this file's
    // own header, and in `scripts/prose-manifest.mjs` ("adding prose is the
    // normal case ... and must never be red"). Three documents said additions
    // are free; this one assertion said otherwise, and it has said so since
    // #1431 introduced it. The assertion was the outlier, not the design.
    // Keeping the equality instead would be option (b) in #1460 — making
    // `--prose-sync` mandatory for any prose addition — which is a behaviour
    // change for contributors and has to be a deliberate choice made in the
    // open, not an accident of a comparison operator.
    //
    // So the surplus is left free, and the reach check below stays where it
    // was. `currentCount > 1000` is the non-vacuity claim: a walk that found
    // nothing would have reported the same clean `errors: []` as a walk that
    // read every document `EXPECTED_FILES` names, and only the count tells
    // them apart. It is deliberately `currentCount` and not `pinnedCount` —
    // the walk's reach is the thing under test here, and asserting the pin
    // instead would let a walk that collected too few units look complete.
    assert.ok(
      result.currentCount > 1000,
      `expected the walk to cover over a thousand prose blocks, found ${result.currentCount} — the walk is not covering what it claims to cover`,
    );
  });

  it('splits prose into paragraphs, list items and whole fenced blocks', () => {
    // The splitter's three rules, pinned on a synthetic document, because the
    // gate's whole diagnostic quality rests on them. This case exists because
    // the mutation sweep found the blank-line rule was the one rule no test
    // could fail: with blank lines no longer breaking paragraphs, every other
    // test still passed, because a one-giant-unit document still goes red when
    // something inside it is deleted — it just names the wrong paragraph.
    //
    // The last unit is the one that matters most for correctness: content
    // between the markers is not prose, and treating it as prose would pin a
    // table row that the generator is entitled to rewrite on any PR.
    const doc = [
      '# Heading',
      '',
      'A paragraph that runs',
      'over two lines.',
      '',
      '- first item',
      '- second item',
      '',
      '1. step one',
      '2. step two',
      '',
      '```mermaid',
      'flowchart TD',
      '',
      '  A --> B',
      '```',
      '',
      '<!-- BEGIN:generated demo -->',
      'a generated row nobody wrote by hand',
      '<!-- END:generated demo -->',
      '',
      'Trailing prose.',
      '',
    ].join('\n');

    assert.deepEqual(
      splitProseUnits(doc),
      [
        '# Heading',
        'A paragraph that runs\nover two lines.',
        '- first item',
        '- second item',
        '1. step one',
        '2. step two',
        // The blank line inside the diagram is diagram syntax. An early draft
        // split on it and reported four deleted blocks where there was one
        // edited one — noisier, and naming a paragraph that never existed.
        '```mermaid\nflowchart TD\n\n  A --> B\n```',
        'Trailing prose.',
      ],
    );
  });

  it('fails the real --check when a hand-written paragraph is deleted', async () => {
    // The wiring proof, and the reason this issue exists. Everything above
    // exercises the classifier; only this drives the gate `checkDocumentation`
    // actually runs, over a document that is genuinely wrong.
    await withScratchDir(async (dir) => {
      const truncated = join(dir, 'ARCHITECTURE.md');
      const source = await readFile(join(ROOT, 'ARCHITECTURE.md'), 'utf8');
      await writeFile(truncated, withoutParagraph(source, STATSFM_PROSE));

      const run = realCheck(dir, `ARCHITECTURE.md=${truncated}`);
      assert.notEqual(run.status, 0, 'the documentation gate passed a document that had lost a paragraph');
      assert.match(run.stderr, /pinned prose block is no longer in the file/);
      assert.match(
        run.stderr,
        /Spotify is the system of record/,
        'the failure must name the paragraph that went missing; a non-zero exit alone could have come from anything',
      );
    });
  });

  it('passes the real --check on the unmodified tree', async () => {
    // The other direction. Every negative assertion above is satisfied by a
    // classifier that reports an error unconditionally, and this is the only
    // thing in the file that rules that out over the same code path.
    await withScratchDir(async (dir) => {
      const run = realCheck(dir);
      assert.equal(run.status, 0, `the clean tree must pass the documentation gate:\n${run.stderr}`);
    });
  });

  it('catches a deleted list item, not just a deleted paragraph', async () => {
    // Resolution matters. `ARCHITECTURE.md`'s eleven-step request pipeline is
    // the densest hand-written prose in the file, and a splitter that treated
    // the whole list as one block would report "something in that list
    // changed" — a modification, not a named loss. Driven through the
    // classifier rather than a subprocess because the claim is about the
    // splitter, and the real gate's reach is already proven above.
    //
    // The first assertion is the load-bearing one and it is here because a
    // weaker version of this test passed against a splitter with list
    // splitting removed: it found the pipeline step by searching for text
    // *inside* a unit, which the merged eleven-step list satisfied just as
    // well, and then reported the merge as the one missing paragraph. So the
    // claim is stated as the unit being the step and nothing else.
    const source = await readFile(join(ROOT, 'ARCHITECTURE.md'), 'utf8');
    const units = splitProseUnits(source);
    const numbered = units.filter((unit) => /^\d+\. /.test(unit));
    assert.equal(
      numbered.length,
      11,
      `expected the request pipeline to be eleven separate prose units, found ${numbered.length} — a list that is one unit reports a change, not a missing step`,
    );

    const step = units.find((unit) => unit.includes('Bounded 5xx and transport retry'));
    assert.ok(step, 'the sixth pipeline step is not a prose unit of its own');
    assert.match(step, /^\s*6\.\s\*\*Bounded 5xx/, 'the unit must be the sixth step alone, with no neighbour joined to it');

    const pinned = { files: { 'ARCHITECTURE.md': [{ hash: proseUnitHash(step), label: 'step 6' }] } };
    assert.deepEqual(
      proseDrift(pinned, { 'ARCHITECTURE.md': source }).errors,
      [],
      'the step is present, so pinning it must be clean — otherwise the next assertion proves nothing',
    );
    const errors = proseDrift(pinned, { 'ARCHITECTURE.md': withoutParagraph(source, 'Bounded 5xx and transport retry') }).errors;
    assert.equal(errors.length, 1, 'deleting one numbered pipeline step must report exactly one missing paragraph');
  });

  it('does not report anything when prose is added', async () => {
    // Keepability. A new tool adds a contract paragraph; if that went red the
    // gate would be routed around within a week, and a routed-around gate
    // catches nothing. Additions are free by construction — the pin is keyed on
    // content, so a key that was never pinned cannot be missing.
    //
    // The next test is where the *reporting* of that freedom is pinned. This one
    // is the behaviour: `errors` stays empty. That was never the part that
    // broke — `errors` always ignored additions. What broke was a caller
    // comparing the two counts, which this file did.
    //
    // It also stays the contract after #1523, and the two are not in tension:
    // this asserts what `errors` and `--check` do, the next asserts what
    // `--prose-report` does with the same tree. An unpinned paragraph is not one
    // of the two ways a *pin* can be wrong, so it belongs in the second list.
    const source = await readFile(join(ROOT, 'README.md'), 'utf8');
    const manifest = { files: { 'README.md': describeDocument(source) } };
    const added = `${source}\nA brand-new paragraph that no pin has ever seen.\n`;
    const report = proseDrift(manifest, { 'README.md': added });
    assert.deepEqual(report.errors, [], 'adding prose must be free, or the gate punishes ordinary work');
  });

  it('fails --prose-report on prose the pin has never seen, and names it (#1523)', async () => {
    // The report half of the test above, driven through the real CLI. The
    // defect was never in the classifier: `proseDrift` reported the surplus
    // correctly the whole time, in `coverage.unpinned`, with the file and the
    // label on it. What it did not do was reach the exit code — so
    // `--prose-report` exited 0 while naming four unpinned `AGENTS.md` lessons
    // on `main` (#1523), the four newest entries in the file that records this
    // repository's hard-won ones. A guard nobody can be red by is a guard whose
    // blind spot is invisible, and a pin that has never seen a paragraph cannot
    // report that paragraph's later deletion or reword — which is the whole
    // reason the surplus is worth failing on.
    //
    // The override is the same device the deletion tests use, for the same
    // reason: a paragraph cannot be added to the real document without leaving
    // the working tree dirty, and a gate test must not edit the tree it guards.
    //
    // Both directions, one command apart. A non-zero exit on its own is
    // satisfied by a command that always fails, and the clean half is what
    // makes the red half evidence that *this* paragraph caused it.
    const scratch = 'A paragraph added to a pinned document, which the pin has never seen.';
    await withScratchDir(async (dir) => {
      const copy = join(dir, 'AGENTS.md');
      const source = await readFile(join(ROOT, 'AGENTS.md'), 'utf8');
      await writeFile(copy, `${source}\n${scratch}\n`);

      const withAddition = runCensus(['--prose-report', '--prose-override', `AGENTS.md=${copy}`]);
      assert.notEqual(withAddition.status, 0, 'an unpinned paragraph must not exit 0 — that is how four lessons merged unseen');

      const report = JSON.parse(withAddition.stdout) as ProseReport;
      assert.equal(report.unpinnedCount, 1, 'one paragraph was added, so exactly one is unpinned');
      assert.equal(
        report.coverage.missing.length,
        0,
        'precondition: the paragraph is new, not lost. A run that broke both would satisfy the exit-code assertion above for the wrong reason',
      );
      assert.ok(
        report.errors.some((line) => line.includes('AGENTS.md') && line.includes(proseUnitLabel(scratch))),
        `the failure must name the file and the paragraph, not just a count:\n${report.errors.join('\n')}`,
      );

      const clean = realProseReport();
      assert.equal(clean.status, 0, `the real tree has no unpinned prose, so the same command must exit 0:\n${clean.stdout}`);
    });
  });

  it('reports a new paragraph and a lost one in different places, so neither can be read as the other (#1460)', async () => {
    // The defect was not that `errors` ignored additions — it always did, and
    // correctly. The defect was that `proseDrift` handed a caller two totals
    // and nothing else, so the only way to learn that they differed was to
    // subtract them, and the difference has two opposite meanings:
    //
    //     currentCount > pinnedCount   prose the manifest has never seen
    //     currentCount < pinnedCount   prose a file no longer carries
    //
    // A caller comparing the totals directly cannot tell which it is looking
    // at. This file did exactly that, with a message describing only the second
    // row, so an addition was reported as a loss — see the coverage test above
    // for what that cost (#1412, `1195 !== 1192`, first diagnosed as a stale
    // gate because the count was the only evidence there was).
    //
    // So the direction is now named, and this asserts the naming in both
    // directions against the same manifest. It is written to fail on the
    // plausible wrong implementation too: reporting the unsigned difference
    // satisfies neither row, which is what a reader would have guessed a bare
    // `count` meant.
    //
    // Synthetic rather than taken from a real document, because the claim is
    // about which bucket a unit lands in, not about any particular paragraph —
    // and a fixture lifted from `README.md` would make this test go red the
    // next time a sentence is reworded, for a reason that has nothing to do
    // with what it is pinning. The neighbouring "reports a pin whose document
    // is not scanned" case is synthetic for the same reason.
    const first = 'The first paragraph, which the manifest does pin.\n';
    const second = 'The second paragraph, which the manifest also pins.\n';
    const third = 'A third paragraph that no pin has ever seen.\n';
    const manifest = { files: { 'README.md': describeDocument(`${first}\n${second}`) } };

    // Addition. The surplus is one unit, it is named, and it is on the
    // `unpinned` side — where "not yet pinned" lives, a fact that is never a
    // finding.
    const withAddition = proseDrift(manifest, { 'README.md': `${first}\n${second}\n${third}` });
    assert.deepEqual(withAddition.errors, [], 'precondition: an addition reports no error');
    assert.equal(withAddition.coverage.unpinned.length, 1, 'the added paragraph must be reported as unpinned');
    assert.equal(withAddition.coverage.missing.length, 0, 'a paragraph nobody pinned cannot be one that went missing');
    assert.equal(
      withAddition.coverage.unpinned[0].file,
      'README.md',
      'the unpinned entry must name the file it was found in, or a reader cannot act on it',
    );
    assert.equal(
      withAddition.coverage.unpinned[0].label,
      proseUnitLabel(third),
      'the unpinned entry must name the paragraph, or `--prose-sync` is a command with nothing to act on',
    );

    // Loss. The same manifest, one paragraph removed, and the count now runs
    // the *other* way — the pin promises a unit the file no longer has. The
    // error already names it; the point is that the surplus side stays empty,
    // which is what a difference with a sign could never have told you.
    const withLoss = proseDrift(manifest, { 'README.md': `${first}\n${third}` });
    // One error, not two. The added paragraph is right there in the same
    // document and contributes nothing to `errors` — the whole point, and the
    // reason a count comparison over this document was wrong in the first
    // place.
    assert.equal(
      withLoss.errors.length,
      1,
      'precondition: only the removed paragraph is a finding. The added one sits in the same document and must not be one',
    );
    assert.equal(withLoss.coverage.missing.length, 1, 'the lost paragraph must be reported as missing');
    assert.equal(withLoss.coverage.unpinned.length, 1, 'the added paragraph is still an addition, not part of the loss');
    assert.equal(
      withLoss.coverage.missing[0].label,
      proseUnitLabel(second),
      'the missing entry must carry the label the error names, so the two cannot disagree about which paragraph',
    );
    assert.deepEqual(
      withLoss.errors,
      withLoss.errors.filter((line) => line.includes(proseUnitLabel(second))),
      'every error must be about a paragraph listed in `coverage.missing` — the two report the same loss and must not be able to drift apart',
    );

    // The counts themselves are unchanged and still worth reading; they are
    // what tells a scan that found nothing apart from one that read every
    // file. What is new is only that their difference no longer has to be
    // interpreted — and note that the second case carries a surplus *and* a
    // loss at once, which is precisely the case a single count comparison
    // could not describe at all.
    assert.equal(withAddition.currentCount, 3);
    assert.equal(withAddition.pinnedCount, 2);
    assert.equal(withLoss.currentCount, 2);
    assert.equal(withLoss.pinnedCount, 2);
  });

  it('refuses to rewrite the pin when a pinned paragraph is gone', async () => {
    // The property the design rests on. A pin that a command can regenerate on
    // demand is not a pin: the documented recovery for a conflicted file is
    // "take the merge base, then run `--write`", so a pin that `--write` (or
    // anything automatic) refreshes would go green one command after the prose
    // was lost. Asserted on the file on disk, not just the exit code, because
    // a command that printed a refusal and wrote anyway would pass the first.
    //
    // Driven against a *copy*, via `--prose-manifest`. That is not tidiness:
    // this test proved the point by breaking the repository. An earlier version
    // pointed `--prose-sync` at the checked-in manifest, and when the refusal
    // was mutated away the command did exactly what it was built to prevent —
    // it rewrote the real pin, dropping the paragraph — leaving the working
    // tree with a manifest that no longer described it. A test that can
    // corrupt the artifact it is testing is not hermetic, and the failure mode
    // is invisible until something unrelated goes red later.
    const repoBefore = await readFile(MANIFEST, 'utf8');
    await withScratchDir(async (dir) => {
      const truncated = join(dir, 'ARCHITECTURE.md');
      const copy = join(dir, 'manifest.json');
      const source = await readFile(join(ROOT, 'ARCHITECTURE.md'), 'utf8');
      await writeFile(truncated, withoutParagraph(source, STATSFM_PROSE));
      await writeFile(copy, repoBefore);

      const run = runCensus([
        '--prose-sync',
        '--prose-manifest', copy,
        '--prose-override', `ARCHITECTURE.md=${truncated}`,
        // #1440: `--prose-sync` now refuses to write from a tree it cannot
        // vouch for. This test is about the *drop* refusal, so it states the
        // tree it is syncing against rather than inheriting whatever git says
        // about the machine the suite happens to run on — otherwise a
        // contributor with a document open would see a different message.
        '--prose-provenance', await writeProvenanceFile(dir),
      ]);
      assert.notEqual(run.status, 0, '--prose-sync rewrote the pin over a deleted paragraph');
      assert.match(run.stderr, /Refusing to rewrite the prose manifest/);
      assert.match(run.stderr, /--retire/);
      assert.equal(
        await readFile(copy, 'utf8'),
        repoBefore,
        'the copy changed on disk even though the command reported a refusal — refusing has to mean not writing',
      );
      assert.equal(
        await readFile(MANIFEST, 'utf8'),
        repoBefore,
        'this test wrote to the checked-in manifest instead of the copy it was given',
      );
    });
  });

  it('records an acknowledged deletion with a reason and a date', async () => {
    // The keepability half: a gate with no way to say "yes, that paragraph
    // really did go on purpose" is a gate that gets switched off. The record is
    // permanent and greppable, so an acknowledged loss stays visible in the
    // diff rather than disappearing.
    //
    // Driven through the real `--prose-sync --retire` rather than by calling
    // `syncProseManifest` with the reason handed in directly. The direct call
    // was the earlier version of this test and it passed while the CLI wrote
    // retirement records with *no* reason on them — the flag was forwarded and
    // the string was dropped on the way. An assertion derived from the same
    // values the code under test is handed proves nothing about the wiring
    // between them, which is exactly what broke.
    const repoBefore = await readFile(MANIFEST, 'utf8');
    await withScratchDir(async (dir) => {
      const copy = join(dir, 'manifest.json');
      const truncated = join(dir, 'ARCHITECTURE.md');
      const source = await readFile(join(ROOT, 'ARCHITECTURE.md'), 'utf8');
      await writeFile(copy, repoBefore);
      await writeFile(truncated, withoutParagraph(source, STATSFM_PROSE));

      const run = runCensus([
        '--prose-sync', '--retire', RETIREMENT_REASON,
        '--prose-manifest', copy,
        '--prose-override', `ARCHITECTURE.md=${truncated}`,
        // #1440: same reasoning as above — this test asserts the *retirement*
        // is recorded, so it names a tree a retirement is allowed to come from.
        '--prose-provenance', await writeProvenanceFile(dir),
      ]);
      assert.equal(run.status, 0, `an acknowledged deletion must be accepted:\n${run.stderr}`);

      const manifest = JSON.parse(await readFile(copy, 'utf8'));
      const retired = manifest.retired ?? [];
      const entry = retired.find((row: { label: string }) => row.label.startsWith('Spotify is the system of record'));
      assert.ok(entry, `the retired paragraph is not in the record:\n${JSON.stringify(retired, null, 2)}`);
      assert.equal(
        entry.reason,
        RETIREMENT_REASON,
        'the record carries no reason. A retirement without one is indistinguishable from prose quietly disappearing, which is the thing the record exists to prevent.',
      );
      assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
      // Compared against every document, not just the truncated one: the copy
      // pins all ten, and handing `proseDrift` a single-file map reports the
      // other nine as unscanned — which is correct behaviour and would drown
      // the one assertion this test is about.
      const documents = await readAllDocuments(truncated);
      assert.deepEqual(
        proseDrift(manifest, documents).errors,
        [],
        'an acknowledged deletion must stop being an error, or nobody will ever acknowledge one',
      );
      assert.equal(
        await readFile(MANIFEST, 'utf8'),
        repoBefore,
        'this test wrote to the checked-in manifest instead of the copy it was given',
      );
    });
  });

  it('requires a reason before it will retire anything', async () => {
    // `--retire` with nothing after it is the shape of a shell that ate the
    // quotes. Retiring on an empty reason would produce exactly the
    // unexplained record the previous test exists to forbid, so the command
    // refuses instead of guessing.
    await withScratchDir(async (dir) => {
      const copy = join(dir, 'manifest.json');
      await writeFile(copy, await readFile(MANIFEST, 'utf8'));
      const run = runCensus(['--prose-sync', '--retire', '--prose-manifest', copy]);
      assert.notEqual(run.status, 0, '--retire with no reason should not be accepted');
      assert.match(run.stderr, /--retire requires a reason/);
    });
  });

  // ---------------------------------------------------------------------
  // #1527 — a reword in place is a different fact from a deletion, and it
  // needs a different record.
  //
  // Everything above is what the pin could say. These are the two records it
  // could not tell apart, and the assertion in each is deliberately narrow: a
  // reanchor that is accepted but writes a retirement has reproduced the
  // original defect with extra steps, so the shape of the record is checked
  // and not merely that the command succeeded.
  // ---------------------------------------------------------------------

  it('records a reword in place as a reanchor carrying both hashes, not as a retirement (#1527)', async () => {
    // The positive case, and the one the whole issue is a gap in. A paragraph
    // fixed in place used to have exactly one thing that could be written about
    // it — a retirement, i.e. a permanent claim that it is gone — so correcting
    // a sentence meant asserting a deletion. The record has to name the old hash
    // AND the new one, or it is the same false record with a friendlier label.
    //
    // Driven through the real CLI, for the reason the retirement tests give: an
    // earlier version of this file called `syncProseManifest` directly and would
    // have passed against a `--reanchor` the CLI never forwarded.
    const repoBefore = await readFile(MANIFEST, 'utf8');
    await withScratchDir(async (dir) => {
      const copy = join(dir, 'manifest.json');
      const reworded = join(dir, 'ARCHITECTURE.md');
      const source = await readFile(join(ROOT, 'ARCHITECTURE.md'), 'utf8');
      const before = paragraphContaining(source, STATSFM_PROSE);
      const after = paragraphContaining(withRewordedParagraph(source, STATSFM_PROSE, REWORDED_STATSFM), REWORDED_STATSFM);
      const oldHash = proseUnitHash(before);
      const newHash = proseUnitHash(after);

      // Preconditions. A fixture that is not a pinned paragraph, or whose reword
      // does not change the hash, would make every assertion below pass for free.
      assert.ok(
        (JSON.parse(repoBefore).files['ARCHITECTURE.md'] as Array<{ hash: string }>).some((entry) => entry.hash === oldHash),
        'the fixture paragraph is not pinned, so there is nothing for a reanchor to replace',
      );
      assert.notEqual(oldHash, newHash, 'a reword that does not change the content hash is a reword the pin cannot see');

      await writeFile(copy, repoBefore);
      await writeFile(reworded, withRewordedParagraph(source, STATSFM_PROSE, REWORDED_STATSFM));

      // `--to` takes the replacement's hash, which is the form an author
      // actually has: `--prose-report` prints the hash of every paragraph the
      // walk found, and the reworded one is sitting in `unpinned`.
      const run = await reanchor(dir, copy, reworded, `ARCHITECTURE.md:${oldHash}`, newHash);
      assert.equal(run.status, 0, `a reword in place must be accepted:\n${run.stderr}`);

      const manifest = JSON.parse(await readFile(copy, 'utf8'));
      const record = (manifest.reanchored as Reanchored[]).find((entry) => entry.hash === oldHash);
      assert.ok(record, `the reword was not recorded as a reanchor:\n${JSON.stringify(manifest.reanchored, null, 2)}`);
      assert.equal(record.file, 'ARCHITECTURE.md', 'the record has to name the file; the same prose can be pinned in two');
      assert.equal(record.to, newHash, 'the record must carry the NEW hash too. A reanchor that only remembers what it replaced is a retirement wearing a new label');
      assert.equal(record.reason, REANCHOR_REASON, 'a reanchor without a reason is the same unexplained record a retirement without one is');
      assert.match(record.date, /^\d{4}-\d{2}-\d{2}$/);

      // The load-bearing negative. This is the defect: one paragraph, one
      // permanent record, and the two operations are supposed to be
      // indistinguishable to the tool and *not* interchangeable to the reader.
      assert.deepEqual(
        (manifest.retired ?? []).filter((entry: { hash: string }) => entry.hash === oldHash),
        [],
        'a reword was recorded as a deletion. That is the false record #1527 exists to stop, and it would read to the next author as a decision.',
      );

      // The replacement really is pinned now, which is the mechanical half of
      // "a reanchor asserts both texts are in the tree".
      assert.ok(
        (manifest.files['ARCHITECTURE.md'] as Array<{ hash: string }>).some((entry) => entry.hash === newHash),
        'the replacement paragraph is not pinned, so the reanchor claims a text the pin does not hold',
      );

      // And the gate is clean — through the real report, over the real manifest
      // the run wrote, not through a hand-built one. An accepted reanchor that
      // left the report red would be a reanchor that only moved the failure.
      const reportRun = runCensus(['--prose-report', '--prose-manifest', copy, '--prose-override', `ARCHITECTURE.md=${reworded}`]);
      assert.equal(reportRun.status, 0, `the report must be clean after a reanchor:\n${reportRun.stderr}${reportRun.stdout}`);
      const reportJson = JSON.parse(reportRun.stdout) as {
        errors: string[];
        coverage: { missing: unknown[]; unpinned: unknown[] };
        reanchors: { active: Reanchored[]; contradicted: unknown[]; malformed: unknown[]; cyclic: unknown[] };
      };
      assert.deepEqual(reportJson.errors, [], reportJson.errors.join('\n'));
      assert.equal(reportJson.coverage.missing.length, 0, 'the reworded paragraph is still reported missing after a reanchor');
      assert.deepEqual(reportJson.reanchors.contradicted, [], 'the record just written must not read as contradicted');
      assert.deepEqual(reportJson.reanchors.malformed, []);
      assert.deepEqual(reportJson.reanchors.cyclic, []);
      assert.ok(
        reportJson.reanchors.active.some((entry) => entry.hash === oldHash),
        'the reanchor is not in `active`, so --prose-report is not reading the list it was meant to check',
      );

      assert.equal(
        await readFile(MANIFEST, 'utf8'),
        repoBefore,
        'this test wrote to the checked-in manifest instead of the copy it was given',
      );
    });
  });

  it('refuses a reanchor whose replacement is not in the file (#1527)', async () => {
    // The anti-vacuity half, and the reason the operation is allowed to exist at
    // all. A reanchor that did not require the replacement to be present would be
    // a way to drop a pin: name any paragraph, point at any text, and the
    // manifest records a reword where nothing was ever written. So this asserts
    // the refusal AND that the pin on disk is byte-identical afterwards — a
    // command that printed a refusal and wrote anyway would satisfy the first.
    const repoBefore = await readFile(MANIFEST, 'utf8');
    await withScratchDir(async (dir) => {
      const copy = join(dir, 'manifest.json');
      const reworded = join(dir, 'ARCHITECTURE.md');
      const source = await readFile(join(ROOT, 'ARCHITECTURE.md'), 'utf8');
      const oldHash = proseUnitHash(paragraphContaining(source, STATSFM_PROSE));

      // The paragraph really is reworded on disk, so the only thing wrong with
      // this run is the `--to`. Without the reword the tool would refuse for a
      // different reason and this test would prove nothing about the check.
      await writeFile(copy, repoBefore);
      await writeFile(reworded, withRewordedParagraph(source, STATSFM_PROSE, REWORDED_STATSFM));

      const absent = 'A replacement paragraph that was never written into this file at all.';
      const run = await reanchor(dir, copy, reworded, `ARCHITECTURE.md:${oldHash}`, absent);
      assert.notEqual(run.status, 0, 'a reanchor was accepted for text that is not in the file — that is a way to drop a pin');
      assert.match(run.stderr, /replacement-absent/, 'the refusal has to name which check failed');
      assert.match(run.stderr, /both are in the tree/, 'the refusal has to say what a reanchor asserts, or the reader cannot act on it');
      assert.equal(
        await readFile(copy, 'utf8'),
        repoBefore,
        'the copy changed on disk even though the command reported a refusal — refusing has to mean not writing',
      );
      assert.equal(
        await readFile(MANIFEST, 'utf8'),
        repoBefore,
        'this test wrote to the checked-in manifest instead of the copy it was given',
      );
    });
  });

  it('cannot use a reanchor to bring back a paragraph that was really deleted (#1527)', async () => {
    // The same check seen from the other direction, and the reason restoring is
    // `--retire`'s absence rather than this operation's job. There is no text to
    // point at: the paragraph is gone, so every replacement the tool can be
    // offered is absent, and the correct answer is a refusal that points at
    // `git show`. A reanchor that could re-pin a deleted paragraph would make
    // the record a lie in the strongest available way — it would assert both
    // texts are in the tree while putting only one there.
    //
    // The control at the end is as load-bearing as the refusals: `--retire` is
    // the right operation for a genuine deletion and this change must not have
    // made it refuse, or the mechanism has no way to record a deletion at all.
    const repoBefore = await readFile(MANIFEST, 'utf8');
    await withScratchDir(async (dir) => {
      const copy = join(dir, 'manifest.json');
      const truncated = join(dir, 'ARCHITECTURE.md');
      const source = await readFile(join(ROOT, 'ARCHITECTURE.md'), 'utf8');
      const deleted = paragraphContaining(source, STATSFM_PROSE);
      const oldHash = proseUnitHash(deleted);

      await writeFile(copy, repoBefore);
      await writeFile(truncated, withoutParagraph(source, STATSFM_PROSE));

      // The obvious attempt: point the reanchor at the text that used to be
      // there. That is exactly the "restore it with a flag" shape, and it must
      // be the one that says no.
      const restoreAttempt = await reanchor(dir, copy, truncated, `ARCHITECTURE.md:${oldHash}`, deleted);
      assert.notEqual(
        restoreAttempt.status,
        0,
        'a reanchor restored a deleted paragraph. A record that asserts both texts are in the tree must not be the thing that puts one there.',
      );
      assert.match(restoreAttempt.stderr, /replacement-absent/);
      assert.match(restoreAttempt.stderr, /git show <ref>:/, 'the refusal has to say where prose actually comes from, or it is a dead end');
      assert.equal(
        await readFile(copy, 'utf8'),
        repoBefore,
        'the copy changed on disk even though the command reported a refusal',
      );

      // And the same check with an unrelated paragraph, so the refusal cannot be
      // an artefact of the text chosen.
      const otherAttempt = await reanchor(
        dir,
        copy,
        truncated,
        `ARCHITECTURE.md:${oldHash}`,
        'Some other replacement that is equally not in the file.',
      );
      assert.notEqual(otherAttempt.status, 0);
      assert.match(otherAttempt.stderr, /replacement-absent/);

      // The control. A genuine deletion is still recorded by the operation that
      // is for it, and it is recorded as a deletion with no successor named.
      const retired = runCensus([
        '--prose-sync', '--retire', RETIREMENT_REASON,
        '--prose-manifest', copy,
        '--prose-override', `ARCHITECTURE.md=${truncated}`,
        '--prose-provenance', await writeProvenanceFile(dir),
      ]);
      assert.equal(retired.status, 0, `--retire must still be the way to record a deletion:\n${retired.stderr}`);
      const manifest = JSON.parse(await readFile(copy, 'utf8'));
      assert.ok(
        (manifest.retired ?? []).some((entry: Reanchored) => entry.hash === oldHash),
        'the deletion was not recorded',
      );
      assert.deepEqual(
        (manifest.reanchored ?? []).filter((entry: Reanchored) => entry.hash === oldHash),
        [],
        'a deletion was recorded as a reanchor',
      );
    });
  });

  it('is idempotent, and does not chain a second record onto a reanchored paragraph (#1527)', async () => {
    // Two properties that are really one. A reanchor is a permanent record, so
    // the obvious failure of an easy-to-rerun command is a manifest that grows
    // a second, near-identical record every time it is run — and the reader
    // cannot tell which of the two is the one that happened. Re-running must be
    // a no-op; a genuinely different second reword must be a reanchor of the
    // *replacement*, so the chain stays a chain.
    await withScratchDir(async (dir) => {
      const copy = join(dir, 'manifest.json');
      const reworded = join(dir, 'ARCHITECTURE.md');
      const twiceReworded = join(dir, 'twice.md');
      const source = await readFile(join(ROOT, 'ARCHITECTURE.md'), 'utf8');
      const first = paragraphContaining(source, STATSFM_PROSE);
      const second = paragraphContaining(withRewordedParagraph(source, STATSFM_PROSE, REWORDED_STATSFM), REWORDED_STATSFM);
      const third = paragraphContaining(
        withRewordedParagraph(withRewordedParagraph(source, STATSFM_PROSE, REWORDED_STATSFM), REWORDED_STATSFM, SECOND_REWORD),
        SECOND_REWORD,
      );
      const firstHash = proseUnitHash(first);
      const secondHash = proseUnitHash(second);
      const thirdHash = proseUnitHash(third);

      const repoBefore = await readFile(MANIFEST, 'utf8');
      await writeFile(copy, repoBefore);
      await writeFile(reworded, withRewordedParagraph(source, STATSFM_PROSE, REWORDED_STATSFM));

      const firstRun = await reanchor(dir, copy, reworded, `ARCHITECTURE.md:${firstHash}`, secondHash);
      assert.equal(firstRun.status, 0, `the first reanchor must be accepted:\n${firstRun.stderr}`);
      const afterFirst = JSON.parse(await readFile(copy, 'utf8'));
      assert.equal(
        (afterFirst.reanchored as Reanchored[]).filter((entry) => entry.hash === firstHash).length,
        1,
        'the first reanchor did not write exactly one record',
      );

      // Same command, same arguments, same tree. The paragraph it names has left
      // the pin on purpose, so this is the case that separates "already done"
      // from "not a pinned paragraph" — and it must be the first.
      const secondRun = await reanchor(dir, copy, reworded, `ARCHITECTURE.md:${firstHash}`, secondHash);
      assert.equal(secondRun.status, 0, `re-running a reanchor must be a no-op, not a failure:\n${secondRun.stderr}`);
      const afterSecond = JSON.parse(await readFile(copy, 'utf8'));
      assert.equal(
        (afterSecond.reanchored as Reanchored[]).filter((entry) => entry.hash === firstHash).length,
        1,
        're-running a reanchor wrote a second record. A permanent record that duplicates itself on every run cannot be read.',
      );
      assert.deepEqual(afterSecond.reanchored, afterFirst.reanchored, 'a re-run changed the records it was supposed to leave alone');
      // Last, because it is the weakest of the three: a run that says nothing
      // and a run that says the wrong thing both leave the file right, and the
      // line above is the one a reader would act on. Asserted at all because a
      // silent no-op is indistinguishable from a command that quietly failed.
      assert.match(secondRun.stderr, /already recorded/, 'the run has to say it recognised the record rather than silently doing nothing');

      // A different replacement for a paragraph that has already been replaced
      // is refused, not recorded — that is what "does not chain" means.
      const chained = await reanchor(
        dir,
        copy,
        reworded,
        `ARCHITECTURE.md:${firstHash}`,
        'A third text that is not the one the paragraph was actually reworded to.',
      );
      assert.notEqual(chained.status, 0, 'a second replacement was recorded for a paragraph that already has one');
      assert.match(chained.stderr, /replacement-absent/, 'this run names text that is not in the file, so the replacement check is what refuses it');

      // The legitimate second reword: the *replacement* is what gets reanchored,
      // and the chain reads forward — first record's `to` is second's `hash`.
      await writeFile(twiceReworded, withRewordedParagraph(
        withRewordedParagraph(source, STATSFM_PROSE, REWORDED_STATSFM),
        REWORDED_STATSFM,
        SECOND_REWORD,
      ));
      const thirdRun = await reanchor(dir, copy, twiceReworded, `ARCHITECTURE.md:${secondHash}`, thirdHash);
      assert.equal(thirdRun.status, 0, `a second reword of the replacement must be accepted:\n${thirdRun.stderr}`);
      const afterThird = JSON.parse(await readFile(copy, 'utf8'));
      const records = afterThird.reanchored as Reanchored[];
      assert.equal(records.filter((entry) => entry.hash === secondHash).length, 1, 'the second reword wrote no record of its own');
      assert.equal(
        records.find((entry) => entry.hash === firstHash)?.to,
        secondHash,
        'the first record must still point at what it was reworded to, or the chain has a hole in it',
      );
    });
  });

  it('reads the reanchored list back, and fails on records that contradict each other (#1527)', async () => {
    // A list that is written and never read is a comment. This asserts that
    // `--prose-report` reaches `reanchorStanding` and that the two failures it
    // can catch are real: a paragraph carrying BOTH a reanchor and a live
    // retirement is precisely the false record the operation exists to prevent,
    // and it arrives by merge rather than by flag — no CLI refuses it, because
    // no single run ever sees both.
    const repoBefore = await readFile(MANIFEST, 'utf8');
    await withScratchDir(async (dir) => {
      const source = await readFile(join(ROOT, 'ARCHITECTURE.md'), 'utf8');
      const rewordedSource = withRewordedParagraph(source, STATSFM_PROSE, REWORDED_STATSFM);
      const oldHash = proseUnitHash(paragraphContaining(source, STATSFM_PROSE));
      const newHash = proseUnitHash(paragraphContaining(rewordedSource, REWORDED_STATSFM));
      const base = JSON.parse(repoBefore);
      const stamp = base.provenance ?? { head: 'a'.repeat(40), base: 'b'.repeat(40), upstream: 'b'.repeat(40), behind: false };
      // `--prose-override` takes a PATH, and a manifest fixture alone is not
      // enough: the report compares the pin against the documents, so the
      // reworded document has to be the one it reads.
      const rewordedPath = join(dir, 'ARCHITECTURE.md');
      await writeFile(rewordedPath, rewordedSource);
      const override = `ARCHITECTURE.md=${rewordedPath}`;

      // The clean direction first, so the failures below cannot be passing
      // because the report is red for an unrelated reason. Built by hand rather
      // than by running the CLI, so the fixture is exactly "one good record".
      const clean = {
        ...base,
        provenance: stamp,
        files: { ...base.files, 'ARCHITECTURE.md': describeDocument(rewordedSource) },
        reanchored: [{
          file: 'ARCHITECTURE.md',
          hash: oldHash,
          label: proseUnitLabel(paragraphContaining(source, STATSFM_PROSE)),
          to: newHash,
          date: '2026-09-27',
          reason: 'a reword recorded by hand for this fixture',
        }],
      };
      const cleanPath = join(dir, 'clean.json');
      await writeFile(cleanPath, JSON.stringify(clean, null, 2));
      const cleanRun = runCensus(['--prose-report', '--prose-manifest', cleanPath, '--prose-override', override]);
      assert.equal(
        cleanRun.status,
        0,
        `a single well-formed reanchor record must leave the report clean — otherwise the two failures below prove nothing:\n${cleanRun.stderr}${cleanRun.stdout}`,
      );

      // Contradiction: the same paragraph, recorded as replaced and as deleted.
      const contradicted = {
        ...clean,
        reanchored: clean.reanchored,
        retired: [...(base.retired ?? []), {
          file: 'ARCHITECTURE.md', hash: oldHash, label: clean.reanchored[0].label, date: '2026-09-27', reason: 'a deletion that contradicts the reword',
        }],
      };
      const contradictedPath = join(dir, 'contradicted.json');
      await writeFile(contradictedPath, JSON.stringify(contradicted, null, 2));
      const contradictedRun = runCensus(['--prose-report', '--prose-manifest', contradictedPath, '--prose-override', override]);
      assert.notEqual(contradictedRun.status, 0, '--prose-report accepted a paragraph recorded as both reworded and deleted');
      const contradictedJson = JSON.parse(contradictedRun.stdout) as { reanchors: { contradicted: Array<{ reanchor: string; why: string }> } };
      assert.equal(contradictedJson.reanchors.contradicted.length, 1, 'the contradiction was not named');
      assert.equal(
        contradictedJson.reanchors.contradicted[0].reanchor,
        `ARCHITECTURE.md:${oldHash}`,
        'the report must name the paragraph that carries both records, in the form a reader can grep for',
      );

      // A record with no reason is the same artefact a retirement with no reason
      // is, and it reaches the file by the same route: a merge that took half of
      // a hand-edited record.
      const malformed = {
        ...clean,
        reanchored: [{ ...clean.reanchored[0], reason: '' }],
      };
      const malformedPath = join(dir, 'malformed.json');
      await writeFile(malformedPath, JSON.stringify(malformed, null, 2));
      const malformedRun = runCensus(['--prose-report', '--prose-manifest', malformedPath, '--prose-override', override]);
      assert.notEqual(malformedRun.status, 0, '--prose-report accepted a reanchor record with no reason');
      const malformedJson = JSON.parse(malformedRun.stdout) as { reanchors: { malformed: Array<{ reanchor: string; why: string }> } };
      assert.equal(malformedJson.reanchors.malformed.length, 1, 'the reasonless record was not named');
      assert.match(malformedJson.reanchors.malformed[0].why, /reason/);
    });
  });

  it('reports a document that carries prose but no manifest entry claims it', async () => {
    // A new mixed document has to be gated the moment it lands. Derived from a
    // tree walk rather than a list, so a file nobody remembered is still
    // covered — and this is the assertion that says so.
    const errors = proseDrift({ files: {} }, { 'docs/new.md': 'Some prose.\n' }).errors;
    assert.equal(errors.length, 1);
    assert.match(errors[0], /docs\/new\.md/);
    assert.match(errors[0], /no manifest entry claims it/);
  });
  it('reports a pin whose document is not scanned', async () => {
    // The opposite direction, and the one that produces a gate that is green
    // forever. A pin for a file that does not exist can never fail, so it
    // protects nothing while appearing in the manifest to protect something.
    // README is pinned here so that the *only* error under test is the
    // unscanned document — an unclaimed README would be a second, unrelated
    // error and the count would stop meaning what it says.
    const readme = 'Some prose.\n';
    const errors = proseDrift(
      {
        files: {
          'README.md': describeDocument(readme),
          'docs/gone.md': [{ hash: proseUnitHash('vanished'), label: 'vanished' }],
        },
      },
      { 'README.md': readme },
    ).errors;
    assert.equal(errors.length, 1, `expected only the unscanned document, got:\n${errors.join('\n')}`);
    assert.match(errors[0], /docs\/gone\.md/);
    assert.match(errors[0], /can never fail/);
  });
});

/**
 * The shape of a `--to` value, and the asymmetry with `--reanchor` (#1552).
 *
 * `--reanchor` requires `"<file>:<hash>"` and refuses a bare hash as ambiguous,
 * because the same prose can be pinned in two files. So the natural next move is
 * to qualify `--to` the same way — and that used to be read as a search for the
 * literal 30-character string `SPEC.md:1bd9ce1b66814558`, producing a refusal
 * naming the wrong problem ("the replacement is not in SPEC.md", when the hash
 * was in SPEC.md the whole time). Nothing marked the difference between the two
 * arguments, so the trap cost a third dogfood use of the operation to find.
 *
 * The two halves of this file are deliberately different kinds of evidence.
 * `qualifiedHash` is pure, so the *shape* rules are asserted directly and
 * exhaustively — including the inputs that must NOT read as keys, which are the
 * half a shape test usually omits and the half that decides whether the change
 * is safe. The CLI tests then prove the *message*: that a qualified `--to` is
 * accepted end to end, that a mismatched file is refused by name rather than
 * searched for, and that refusing still means not writing.
 */
describe('reanchor argument shapes (#1552)', () => {
  const HASH = 'd6f6074447d29264';

  it('reads a <file>:<hash> qualifier, and only that shape', () => {
    // The positive cases, including the one that is not obvious: the qualifier
    // is read off the LAST colon, because a repository path is allowed to
    // contain one. Splitting on the first would read `docs/a:b.md:<hash>` as the
    // file `docs/a` and then refuse a request that is perfectly well formed.
    assert.deepEqual(qualifiedHash('SPEC.md:d6f6074447d29264'), { file: 'SPEC.md', hash: HASH });
    assert.deepEqual(
      qualifiedHash('docs/distribution.md:a1b2c3d4e5f60718'),
      { file: 'docs/distribution.md', hash: 'a1b2c3d4e5f60718' },
    );
    assert.deepEqual(qualifiedHash('docs/a:b.md:0123456789abcdef'), { file: 'docs/a:b.md', hash: '0123456789abcdef' });

    // The negatives, which are the load-bearing half. Every one of these is a
    // value a caller can genuinely pass as `--to`, and each must come back null
    // so that it is read as replacement *prose* rather than as a key.
    for (const value of [
      'A paragraph of ordinary prose with no colon at all.',
      // A colon, and a 16-hex run — but not at the end. The tail is what has to
      // be the hash, or any prose mentioning a pinned hash would be read as a key.
      'The hash d6f6074447d29264 belongs to the paragraph below.',
      // Ends in 16 hex, but the whole value is not a key because the colon is
      // preceded by nothing: a leading colon leaves no file to read.
      ':d6f6074447d29264',
      // Uppercase is not the hash shape. A pin is lower-case, and a case-folded
      // match would invent a hit rather than report one.
      'SPEC.md:D6F6074447D29264',
      // 15 and 17 characters: off-by-one either side must not pass.
      'SPEC.md:d6f6074447d2926',
      'SPEC.md:d6f6074447d292641',
      // A bare hash is not a qualified value at all. This is the asymmetry the
      // issue is about, asserted on the function that implements it: `--to`
      // accepts the bare form, `--reanchor` refuses it.
      HASH,
      '',
    ]) {
      assert.equal(qualifiedHash(value), null, `"${value}" must not read as a <file>:<hash> qualifier`);
    }
  });

  it('accepts a --to qualified to the same file, and records what the bare hash records', async () => {
    // The regression itself, through the real CLI. Before the fix this exited 1
    // with `replacement-absent` naming a paragraph that was in the file.
    //
    // The assertion is an *equivalence*, not just exit 0: a qualified `--to` is
    // only correct if it produces byte-for-byte the record the bare hash
    // produces. A fix that merely stopped refusing — by skipping the check, or by
    // accepting anything — would pass a weaker version of this test.
    const repoBefore = await readFile(MANIFEST, 'utf8');
    await withScratchDir(async (dir) => {
      const source = await readFile(join(ROOT, 'ARCHITECTURE.md'), 'utf8');
      const rewordedSource = withRewordedParagraph(source, STATSFM_PROSE, REWORDED_STATSFM);
      const oldHash = proseUnitHash(paragraphContaining(source, STATSFM_PROSE));
      const newHash = proseUnitHash(paragraphContaining(rewordedSource, REWORDED_STATSFM));
      assert.notEqual(oldHash, newHash, 'the fixture reword does not change the hash, so there is no reanchor to record');

      const runOne = async (to: string): Promise<{ run: Run; manifest: { reanchored?: Reanchored[] } }> => {
        const copy = join(dir, `manifest-${to.replace(/[^a-z0-9]/gi, '_')}.json`);
        const document = join(dir, `ARCHITECTURE-${to.replace(/[^a-z0-9]/gi, '_')}.md`);
        await writeFile(copy, repoBefore);
        await writeFile(document, rewordedSource);
        const run = await reanchor(dir, copy, document, `ARCHITECTURE.md:${oldHash}`, to);
        return { run, manifest: JSON.parse(await readFile(copy, 'utf8')) as { reanchored?: Reanchored[] } };
      };

      const bare = await runOne(newHash);
      const qualified = await runOne(`ARCHITECTURE.md:${newHash}`);

      assert.equal(qualified.run.status, 0, `a --to qualified to the --reanchor file must be accepted:\n${qualified.run.stderr}`);
      assert.doesNotMatch(
        qualified.run.stderr,
        /replacement-absent/,
        'the qualified form is still being read as prose to search for — this is the #1552 defect',
      );

      const bareRecord = (bare.manifest.reanchored ?? []).find((entry) => entry.hash === oldHash);
      const qualifiedRecord = (qualified.manifest.reanchored ?? []).find((entry) => entry.hash === oldHash);
      assert.ok(qualifiedRecord, `the qualified reanchor wrote no record:\n${JSON.stringify(qualified.manifest.reanchored, null, 2)}`);
      assert.equal(
        JSON.stringify(qualifiedRecord),
        JSON.stringify(bareRecord),
        'a --to qualified to the same file must record exactly what the bare hash records',
      );
      assert.equal(qualifiedRecord.to, newHash);
      assert.equal(await readFile(MANIFEST, 'utf8'), repoBefore, 'this test wrote to the checked-in manifest');
    });
  });

  it('refuses a --to qualified to a different file, by name, and writes nothing', async () => {
    // Option 1 of the issue made the mismatched file a named caller error rather
    // than a silent reinterpretation as prose. Named means: the message says
    // which of the two keys disagrees and offers the bare form, so the reader has
    // something to do. A run that searched README for a SPEC.md key reported the
    // replacement as absent from SPEC.md, which is true and useless.
    const repoBefore = await readFile(MANIFEST, 'utf8');
    await withScratchDir(async (dir) => {
      const copy = join(dir, 'manifest.json');
      const reworded = join(dir, 'ARCHITECTURE.md');
      const source = await readFile(join(ROOT, 'ARCHITECTURE.md'), 'utf8');
      const oldHash = proseUnitHash(paragraphContaining(source, STATSFM_PROSE));
      await writeFile(copy, repoBefore);
      await writeFile(reworded, withRewordedParagraph(source, STATSFM_PROSE, REWORDED_STATSFM));

      // The hash is real and it IS in ARCHITECTURE.md — only the file half of
      // the key is wrong. A fixture with a nonsense hash would be refused for the
      // replacement's absence instead, and this test would pass against a fix
      // that never learned about the file half.
      const newHash = proseUnitHash(
        paragraphContaining(withRewordedParagraph(source, STATSFM_PROSE, REWORDED_STATSFM), REWORDED_STATSFM),
      );
      const run = await reanchor(dir, copy, reworded, `ARCHITECTURE.md:${oldHash}`, `README.md:${newHash}`);

      assert.notEqual(run.status, 0, 'a reanchor onto a paragraph in another document was accepted');
      assert.match(run.stderr, /replacement-elsewhere/, `the refusal has to name the file mismatch:\n${run.stderr}`);
      assert.match(run.stderr, /README\.md/, 'the refusal has to name the file the --to actually pointed at');
      assert.match(
        run.stderr,
        new RegExp(`--to "${newHash}"`),
        'the refusal has to offer the bare form, or the reader is left holding the same broken command',
      );
      assert.equal(await readFile(copy, 'utf8'), repoBefore, 'the copy changed on disk even though the command refused');
      assert.equal(await readFile(MANIFEST, 'utf8'), repoBefore, 'this test wrote to the checked-in manifest');
    });
  });

  it('states the --to/--reanchor asymmetry in the replacement-absent refusal', async () => {
    // The half of the trap that is about the message rather than the behaviour.
    // Before the fix, `--reanchor` demanded a qualifier, the caller supplied one,
    // and the refusal then said "pass the paragraph's hash instead of its text" —
    // naming the exact shape the argument one line earlier had rejected, with
    // nothing marking that it meant the *other* shape. A reader who followed that
    // advice literally and dropped the qualifier would have been right, which is
    // the only reason it was survivable; the fix has to say so rather than leave
    // it to be inferred.
    const repoBefore = await readFile(MANIFEST, 'utf8');
    await withScratchDir(async (dir) => {
      const copy = join(dir, 'manifest.json');
      const reworded = join(dir, 'ARCHITECTURE.md');
      const source = await readFile(join(ROOT, 'ARCHITECTURE.md'), 'utf8');
      const oldHash = proseUnitHash(paragraphContaining(source, STATSFM_PROSE));
      await writeFile(copy, repoBefore);
      await writeFile(reworded, withRewordedParagraph(source, STATSFM_PROSE, REWORDED_STATSFM));

      const run = await reanchor(
        dir, copy, reworded, `ARCHITECTURE.md:${oldHash}`,
        'A replacement paragraph that was never written into this file at all.',
      );
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /replacement-absent/);
      // The recovery line names both accepted forms, so the advice cannot be
      // followed into the shape `--reanchor` refuses.
      assert.match(run.stderr, /--to "ARCHITECTURE\.md:<hash>"/, `the refusal does not say the qualified form is accepted:\n${run.stderr}`);
      assert.match(run.stderr, /--reanchor, which\s+requires the qualifier/, 'the refusal does not mark the asymmetry it is surrounded by');
      // And the recovery line that names no file is fixed: it used to be a
      // single-quoted string, so it printed `${request.file}` literally — the one
      // line telling the reader how to recover the bytes named no file.
      assert.match(run.stderr, /git show <ref>:ARCHITECTURE\.md/, 'the git show line interpolates no file');
      assert.doesNotMatch(run.stderr, /\$\{request\.file\}/, 'an un-interpolated template leaked into a message');
      assert.equal(await readFile(MANIFEST, 'utf8'), repoBefore, 'this test wrote to the checked-in manifest');
    });
  });
});
