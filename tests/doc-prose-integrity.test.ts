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
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeDocument, proseDrift, proseUnitHash, proseUnitLabel, splitProseUnits } from '../scripts/prose-manifest.mjs';
import { writeProvenanceFile } from './helpers/prose-tree.js';

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

/** The reason string the retirement tests record, asserted end to end. */
const RETIREMENT_REASON = 'removed the stale receipt paragraph';

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

type ProseReport = {
  errors: string[];
  currentCount: number;
  pinnedCount: number;
  coverage: { unpinned: Array<{ file: string; hash: string; label: string }>; missing: Array<{ file: string; hash: string; label: string }> };
  files: string[];
};
const report = (): ProseReport => JSON.parse(realProseReport().stdout) as ProseReport;

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
    const source = await readFile(join(ROOT, 'README.md'), 'utf8');
    const manifest = { files: { 'README.md': describeDocument(source) } };
    const added = `${source}\nA brand-new paragraph that no pin has ever seen.\n`;
    const report = proseDrift(manifest, { 'README.md': added });
    assert.deepEqual(report.errors, [], 'adding prose must be free, or the gate punishes ordinary work');
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
