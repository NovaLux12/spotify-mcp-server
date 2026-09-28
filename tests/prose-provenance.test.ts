/**
 * Provenance of the hand-written prose pin (#1440), and the shape of the
 * justification that keeps the marker scan's skip list honest (#1427).
 *
 * ## The failure this exists for
 *
 * `scripts/doc-prose-manifest.json` records a *reason* for every paragraph that
 * left a document. That reason is a claim about why, and it is permanent: it is
 * written once, it is hand-maintained afterwards, and nothing ever re-checks it.
 *
 * PR #1439 shipped two of them that were false. The shape of the mistake is
 * specific and worth stating, because it is not "someone typed a wrong reason":
 *
 *  1. A branch started before a documentation PR landed.
 *  2. That PR reworded two paragraphs in `README.md`.
 *  3. The branch's tree does not contain the reworded paragraphs, because the
 *     branch has not merged the PR.
 *  4. `--prose-sync` compared the branch's tree against the pin and concluded
 *     the paragraphs had been *removed*.
 *  5. The author wrote the reason that was true **on their machine** —
 *     "reworded by upstream #1402" — and that reason is wrong, because the
 *     reword had not reached their tree. The paragraph was never reworded here;
 *     it had simply not arrived yet.
 *
 * The record is indistinguishable from a true one afterwards. The merge that
 * would have made it true is the merge the branch was still waiting for.
 *
 * ## Why the guard is a refusal and not a warning
 *
 * A warning that still lets the false reason be written fixes nothing: the
 * artefact is already in the file by the time the warning is read, and the
 * artefact is the thing that is wrong. So `--prose-sync` refuses to write, and
 * names what to do instead.
 *
 * ## What "stale" means here, enumerated
 *
 * A guard written for the case that was observed stops working on the next one,
 * so each condition is named separately and each has its own test below:
 *
 *  - **The tree is behind `origin/main`.** The #1439 case, and the one a
 *    "did you mean to delete this?" prompt cannot catch — from inside the stale
 *    tree the deletion is real.
 *  - **A pinned document or the manifest has uncommitted changes.** The sync
 *    reads bytes that are in no commit, so the retirement describes a tree that
 *    never existed, whether or not the author goes on to commit them.
 *  - **`origin/main` cannot be resolved** — a shallow checkout, a clone with no
 *    remote, a source tarball. "Cannot exclude behind" is not "not behind".
 *  - **There is no usable tree at all** — no git, no commits.
 *  - **The branch was rebased or amended after the sync.** Nothing is wrong at
 *    the moment of writing, so this is caught on the *read* side: the pin names
 *    the commit it was generated from, and `--check` asks whether that commit
 *    is still an ancestor of `HEAD`.
 *
 * ## Why the override is narrower than the guard
 *
 * Two of these are *situations* rather than defects — a feature branch genuinely
 * may not have merged a docs PR yet — and a gate with no way to proceed gets
 * switched off. `--allow-stale "<why>"` exists for those, and it does not
 * silence anything: the acknowledgement is written into the manifest's
 * `provenance` block, where a reviewer reads it next to the retirement it
 * qualifies. The uncommitted-changes refusal has no override, because there is
 * no commit to stamp and inventing one is the false record the pin exists to
 * prevent. A single escape hatch covering both would be a documented bypass of
 * the case it was written for.
 *
 * ## Test-shape rules this file follows
 *
 *  - **The refusals are driven through the real CLI**, via
 *    `--prose-provenance`, because a correct check that is never reached is the
 *    failure this whole issue is about — the one #1238 had to fix in this repo
 *    already. The substitute supplies the *reading*, not the decision.
 *  - **Refusing is asserted on the file.** A command that printed a refusal and
 *    wrote anyway would pass an exit-code assertion, and that is precisely the
 *    failure mode.
 *  - **The git reading is tested against a real repository**, built under
 *    `os.tmpdir()`, not against a mock. `gitProvenanceIn` is the only place
 *    that knows what `git status --porcelain` and `--is-ancestor` actually
 *    return, and a hand-written fixture would encode the author's assumption
 *    rather than git's behaviour.
 *  - **Nothing here writes to the checked-in manifest.** Every CLI run gets
 *    `--prose-manifest <copy>`, because `--prose-sync` *writes* that path.
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  contradictedByUpstream,
  gitProvenanceIn,
  proseProvenanceVerdict,
  proseSyncRefusals,
  proseUnitHash,
  provenanceStampWarning,
  retirementKey,
  retirementStanding,
  stampProvenance,
  syncProseManifest,
} from '../scripts/prose-manifest.mjs';
import type { ProseRetirement } from '../scripts/prose-manifest.mjs';
import { CLEAN_TREE, writeProvenanceFile } from './helpers/prose-tree.js';
import { armFileDeadline, FLEET_FILE_BUDGET_MS } from './helpers/file-deadline.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'scripts', 'doc-prose-manifest.json');
const CENSUS = join(ROOT, 'scripts', 'surface-census.mjs');

/**
 * Is this checkout one where an `--is-ancestor` walk is truncated at `HEAD`?
 *
 * Mirrors `shallowHeadCannotWalk` in `scripts/surface-census.mjs`, which is not
 * exported. The duplication is deliberate and bounded, because the test below
 * branches on the answer and its two branches assert **opposite** outcomes: a
 * probe that drifts from the census sends the test down the branch the gate
 * contradicts, and it fails loudly. It cannot pass by being wrong quietly.
 *
 * This is the condition that made the test un-runnable in CI rather than
 * merely strict there. `actions/checkout` defaults to `fetch-depth: 1`, so
 * `HEAD` sits on the shallow boundary; git reports "not an ancestor" for a
 * commit created in this clone, but the walk that produced that answer never
 * reached past `HEAD`, so the census correctly returns `null` — the verdict is
 * `unverifiable`, not `rewritten` — and the gate stays silent *on purpose*.
 * Asserting a non-zero exit in that environment asserts the bug away.
 */
function headIsGraftPoint(): boolean {
  const commonDir = spawnSync('git', ['-C', ROOT, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
  });
  if (commonDir.error || commonDir.status !== 0) return false;
  let boundary: string;
  try {
    boundary = readFileSync(join(commonDir.stdout.trim(), 'shallow'), 'utf8');
  } catch {
    // No boundary file at all: a full clone, so a "no" really is a "no".
    return false;
  }
  const head = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (head.error || head.status !== 0) return false;
  return boundary.split('\n').some((line) => line.trim() === head.stdout.trim());
}

/** The reason string the retirement tests record. */
const RETIREMENT_REASON = 'reworded by upstream #1402';

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
 * clobbered out from under a run. This also keeps `mkdtemp` clear of
 * `scripts/check-no-repo-root-fixtures.mjs`, which fails any `mkdtemp` under
 * `tests/` that does not root at `os.tmpdir()` (#1383/#1417).
 */
async function withScratchDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'spotify-mcp-provenance-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Run `git` in `dir`, letting a non-zero exit throw — a fixture that cannot be built is a bug. */
function git(dir: string, ...argv: string[]): string {
  return execFileSync('git', ['-C', dir, ...argv], { encoding: 'utf8' }).replace(/\n$/, '');
}

/**
 * A commit object that exists in this clone and that `HEAD` does not contain.
 *
 * This is the shape a squash-merge leaves behind. `main` squash-merges, so a
 * feature branch's tip is a real object in the repository that is an ancestor of
 * nothing once the PR lands (#1482), and modelling it needs exactly that: an
 * object git can answer `--is-ancestor` about, which a made-up SHA is not — a
 * SHA git has never heard of exits 128 and produces the `unverifiable` verdict,
 * so a fixture of that shape would make every ancestry assertion below pass for
 * the wrong reason.
 *
 * Identity comes from the environment rather than from `git config`, because
 * this worktree may or may not have one and a test must not depend on whose
 * checkout it is running in. Nothing here is ever pushed, signed, or attributed
 * to a person, and no ref is moved: a parallel test running against the same
 * repository cannot observe the object.
 */
function uncontainedCommit(message: string): string {
  const tree = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
  return execFileSync('git', ['-C', ROOT, 'commit-tree', tree, '-m', message], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Provenance Fixture',
      GIT_AUTHOR_EMAIL: 'provenance@example.invalid',
      GIT_COMMITTER_NAME: 'Provenance Fixture',
      GIT_COMMITTER_EMAIL: 'provenance@example.invalid',
    },
  }).trim();
}

/** Is `sha` an ancestor of `HEAD` in this checkout? `true` / `false` / null when git cannot tell. */
function isAncestor(sha: string): boolean | null {
  const walk = spawnSync('git', ['-C', ROOT, 'merge-base', '--is-ancestor', sha, 'HEAD']);
  if (walk.status === 0) return true;
  if (walk.status === 1) return false;
  return null;
}

/**
 * A real git repository under `dir`, with a real `refs/remotes/origin/main`.
 *
 * The remote is a plain ref, not a configured remote: `gitProvenanceIn` asks
 * `rev-parse --verify refs/remotes/origin/main` and nothing more, so a ref set
 * with `update-ref` is a faithful fixture and costs no network. `behind` is
 * produced the way it actually happens — a sibling commit that `HEAD` does not
 * contain — rather than by pointing the ref at a SHA that was never committed.
 */
async function scratchRepo(dir: string): Promise<{ path: string; head: string; originMain: string }> {
  const path = join(dir, 'repo');
  await mkdir(path, { recursive: true });
  git(path, 'init', '--quiet', '--initial-branch=main');
  git(path, 'config', 'user.email', 'provenance@example.invalid');
  git(path, 'config', 'user.name', 'Provenance Fixture');
  git(path, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(path, 'README.md'), 'A pinned paragraph that only exists in the first commit.\n');
  git(path, 'add', 'README.md');
  git(path, 'commit', '--quiet', '-m', 'first');
  const first = git(path, 'rev-parse', 'HEAD');

  await writeFile(join(path, 'README.md'), 'A pinned paragraph, and a second one added upstream.\n');
  git(path, 'add', 'README.md');
  git(path, 'commit', '--quiet', '-m', 'second');
  const head = git(path, 'rev-parse', 'HEAD');

  // A commit on a side branch: it descends from `first`, and `HEAD` does not
  // contain it. That is precisely what "this branch is behind" means, and it is
  // why the real failure was a reword this branch never saw.
  const side = git(path, 'commit-tree', `${first}^{tree}`, '-p', first, '-m', 'upstream moved on');
  git(path, 'update-ref', 'refs/remotes/origin/main', side);
  return { path, head, originMain: side };
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
  label: 'tests/prose-provenance.test.ts',
  budgetMs: FLEET_FILE_BUDGET_MS,
  children: () => [],
});

describe('prose pin provenance (#1440)', () => {
  it('refuses to retire prose from a tree that is behind origin/main', async () => {
    // The #1439 case, driven through the real command. Before the fix this run
    // exited 0 and wrote a retirement whose reason described a change this tree
    // had never seen; the manifest copy below is asserted byte-identical, so a
    // fix that warns and writes anyway fails here.
    const repoBefore = await readFile(MANIFEST, 'utf8');
    await withScratchDir(async (dir) => {
      const copy = join(dir, 'manifest.json');
      const truncated = join(dir, 'ARCHITECTURE.md');
      const source = await readFile(join(ROOT, 'ARCHITECTURE.md'), 'utf8');
      const kept = source.split('\n').filter((line) => !line.includes('Spotify is the system of record'));
      assert.notEqual(kept.length, source.split('\n').length, 'the fixture paragraph was not found — this test would prove nothing');
      await writeFile(copy, repoBefore);
      await writeFile(truncated, kept.join('\n'));
      await writeProvenanceFile(dir, { ...CLEAN_TREE, behind: true });

      const run = runCensus([
        '--prose-sync', '--retire', RETIREMENT_REASON,
        '--prose-manifest', copy,
        '--prose-override', `ARCHITECTURE.md=${truncated}`,
        '--prose-provenance', join(dir, 'provenance.json'),
      ]);

      assert.notEqual(run.status, 0, '--prose-sync retired prose from a tree that is behind origin/main');
      assert.match(run.stderr, /Refusing to rewrite the prose manifest/);
      assert.match(run.stderr, /behind the branch it will merge into/);
      assert.match(run.stderr, /Rebase or merge origin\/main/, 'a refusal that does not say what to do next gets routed around');
      assert.equal(
        await readFile(copy, 'utf8'),
        repoBefore,
        'the manifest changed on disk even though the command reported a refusal — refusing has to mean not writing',
      );
      assert.equal(
        await readFile(MANIFEST, 'utf8'),
        repoBefore,
        'this test wrote to the checked-in manifest instead of the copy it was given',
      );
    });
  });

  it('refuses when origin/main cannot be resolved at all', async () => {
    // A separate case with the same wrong answer, and it is separate because
    // "I could not find upstream" is not the same fact as "upstream is ahead".
    // Collapsing the two would let a shallow checkout retire prose, which is
    // the #1439 failure with the check quietly unable to run.
    await withScratchDir(async (dir) => {
      const copy = join(dir, 'manifest.json');
      await writeFile(copy, await readFile(MANIFEST, 'utf8'));
      await writeProvenanceFile(dir, { ...CLEAN_TREE, upstream: null, behind: false, note: 'refs/remotes/origin/main does not resolve.' });

      const run = runCensus([
        '--prose-sync',
        '--prose-manifest', copy,
        '--prose-provenance', join(dir, 'provenance.json'),
      ]);
      assert.notEqual(run.status, 0, 'a tree that cannot be compared against upstream was accepted');
      assert.match(run.stderr, /behind the branch it will merge into/);
      assert.match(run.stderr, /does not resolve/);
    });
  });

  it('refuses when there is no usable tree to record provenance against', async () => {
    // No git, no commits, a source tarball. There is nothing to stamp, and
    // stamping a guess is the false record the pin exists to prevent, so this
    // one has no override either.
    await withScratchDir(async (dir) => {
      const copy = join(dir, 'manifest.json');
      await writeFile(copy, await readFile(MANIFEST, 'utf8'));
      await writeProvenanceFile(dir, {
        usable: false, head: null, upstream: null, behind: false, detached: false, dirty: [],
        note: '/tmp/x is not a git working tree (or has no commits), so there is no tree to record provenance against.',
      });

      const run = runCensus([
        '--prose-sync',
        '--prose-manifest', copy,
        '--prose-provenance', join(dir, 'provenance.json'),
        '--allow-stale', 'I really need this to go through',
      ]);
      assert.notEqual(run.status, 0, 'a sync with no tree to attest was accepted, even with an acknowledgement');
      assert.match(run.stderr, /not a git working tree/);
    });
  });

  it('refuses when a document the pin depends on has uncommitted changes', async () => {
    // A retirement decided against bytes that are in no commit describes a tree
    // that never existed. Note this is the *hard* class: it is asserted with an
    // acknowledgement present, because an override that reached it would let a
    // half-finished edit become a permanent record.
    await withScratchDir(async (dir) => {
      const copy = join(dir, 'manifest.json');
      await writeFile(copy, await readFile(MANIFEST, 'utf8'));
      await writeProvenanceFile(dir, { ...CLEAN_TREE, dirty: ['README.md'] });

      const run = runCensus([
        '--prose-sync',
        '--prose-manifest', copy,
        '--prose-provenance', join(dir, 'provenance.json'),
        '--allow-stale', 'the docs PR has not landed yet',
      ]);
      assert.notEqual(run.status, 0, 'an uncommitted document was accepted, even with an acknowledgement');
      assert.match(run.stderr, /Uncommitted changes/);
      assert.match(run.stderr, /README\.md/, 'the refusal must name the file — a bare "dirty" sends the reader hunting');
      assert.match(run.stderr, /no override for this/, 'the message has to say the flag will not help, or it will be tried');
    });
  });

  it('names the paragraphs it refused over, so no coverage is silently discarded', async () => {
    // The other half of "the fix must not silently discard coverage". A refusal
    // that only said "stale" would leave the author with no idea which prose is
    // in question, and the path of least resistance would be to pass
    // `--allow-stale` without reading anything.
    await withScratchDir(async (dir) => {
      const copy = join(dir, 'manifest.json');
      const truncated = join(dir, 'ARCHITECTURE.md');
      const source = await readFile(join(ROOT, 'ARCHITECTURE.md'), 'utf8');
      const kept = source.split('\n').filter((line) => !line.includes('Spotify is the system of record'));
      await writeFile(copy, await readFile(MANIFEST, 'utf8'));
      await writeFile(truncated, kept.join('\n'));
      await writeProvenanceFile(dir, { ...CLEAN_TREE, behind: true });

      const run = runCensus([
        '--prose-sync', '--retire', RETIREMENT_REASON,
        '--prose-manifest', copy,
        '--prose-override', `ARCHITECTURE.md=${truncated}`,
        '--prose-provenance', join(dir, 'provenance.json'),
      ]);
      assert.match(
        run.stderr,
        /Spotify is the system of record/,
        'the refusal must still say which paragraph is at stake, or the author cannot act on it',
      );
    });
  });

  it('names the retirements the branch it merges into contradicts, not just that it is behind', async () => {
    // #1440's second definition-of-done item, and the part a generic "your tree
    // is behind" refusal cannot do on its own: it says *which* of the retirements
    // this run would have recorded are contradicted by the branch they are being
    // merged into.
    //
    // Driven with this repository's real `origin/main` SHA rather than a
    // fabricated one, because the evidence is read out of that ref with
    // `git show` — a fake SHA would make the read fail and the check would pass
    // for the wrong reason, which is the failure mode this file keeps testing
    // for. Nothing is written to the ref and no ref is moved.
    await withScratchDir(async (dir) => {
      const upstream = execFileSync('git', ['-C', ROOT, 'rev-parse', 'origin/main'], { encoding: 'utf8' }).trim();
      const copy = join(dir, 'manifest.json');
      const truncated = join(dir, 'ARCHITECTURE.md');
      const source = await readFile(join(ROOT, 'ARCHITECTURE.md'), 'utf8');
      const kept = source.split('\n').filter((line) => !line.includes('Spotify is the system of record'));
      assert.notEqual(kept.length, source.split('\n').length, 'the fixture paragraph was not found — this test would prove nothing');
      await writeFile(copy, await readFile(MANIFEST, 'utf8'));
      await writeFile(truncated, kept.join('\n'));
      await writeProvenanceFile(dir, { ...CLEAN_TREE, head: 'a'.repeat(40), upstream, behind: true });

      const run = runCensus([
        '--prose-sync', '--retire', RETIREMENT_REASON,
        '--prose-manifest', copy,
        '--prose-override', `ARCHITECTURE.md=${truncated}`,
        '--prose-provenance', join(dir, 'provenance.json'),
      ]);

      assert.notEqual(run.status, 0, '--prose-sync retired a paragraph that is still present upstream');
      assert.match(
        run.stderr,
        /still present in their file at d0b690f|still present in their file at [0-9a-f]{7}/,
        `the refusal must cite the ref the paragraph is still present in:\n${run.stderr}`,
      );
      assert.match(
        run.stderr,
        /Spotify is the system of record/,
        'the contradiction must name the paragraph it is about — "something is wrong" is not actionable',
      );
      assert.equal(await readFile(copy, 'utf8'), await readFile(MANIFEST, 'utf8'), 'the manifest copy changed on a refusal');
    });
  });

  it('does not call a paragraph contradicted when upstream no longer has it', async () => {
    // The other direction, and it is the one that decides whether this check is
    // usable at all. A reworded or deleted paragraph is absent upstream, and
    // that is exactly the case a retirement is *for*.
    //
    // The fixture is a *partial* reword on purpose. The manifest stores a
    // 56-character label next to every hash, and that label survives the opening
    // of a reword — so an implementation that matched on the label would fire
    // here and refuse every legitimate retirement of reworded prose. The first
    // assertion below is the one that rules that out, and it is the assertion
    // that failed when this was tried against a label-matching implementation.
    const paragraph = 'Spotify is the system of record for playback, library, and catalog.\n';
    const reworded = 'Spotify is the system of record for playback, library, and history.\n';
    const dropped = [{ file: 'ARCHITECTURE.md', hash: proseUnitHash(paragraph), label: 'Spotify is the system of record for playback, library, a…' }];

    assert.notEqual(
      proseUnitHash(reworded),
      dropped[0].hash,
      'the fixture is supposed to be a reword of the pinned paragraph, not the same text',
    );
    assert.ok(
      dropped[0].label.startsWith('Spotify is the system of record for playback, library, a'),
      'the fixture label no longer shares the opening a label-matching implementation would match on, so this test would pass for the wrong reason',
    );

    assert.deepEqual(
      contradictedByUpstream(dropped, { 'ARCHITECTURE.md': paragraph }),
      dropped,
      'a paragraph still in the upstream file must be reported as contradicted',
    );
    assert.deepEqual(
      contradictedByUpstream(dropped, { 'ARCHITECTURE.md': reworded }),
      [],
      'a paragraph upstream has reworded is what a retirement is for, and must not be reported as contradicted — '
      + 'the label prefix still matches it, so matching on the label would refuse this',
    );
    assert.deepEqual(
      contradictedByUpstream(dropped, { 'README.md': paragraph }),
      [],
      'a document that does not exist upstream cannot contradict anything — it must be skipped, not read as empty',
    );
  });

  it('records the tree the pin was generated from', async () => {
    // The read side has nothing to check without this, and the DoD for #1440 is
    // that a stale manifest is diagnosable *without* a bisect. A reason string
    // cannot be checked against anything; a commit can.
    await withScratchDir(async (dir) => {
      const copy = join(dir, 'manifest.json');
      await writeFile(copy, await readFile(MANIFEST, 'utf8'));
      await writeProvenanceFile(dir, CLEAN_TREE);

      const run = runCensus([
        '--prose-sync',
        '--prose-manifest', copy,
        '--prose-provenance', join(dir, 'provenance.json'),
      ]);
      assert.equal(run.status, 0, `a clean, current tree must be accepted:\n${run.stderr}`);

      const manifest = JSON.parse(await readFile(copy, 'utf8'));
      assert.deepEqual(
        manifest.provenance,
        { head: CLEAN_TREE.head, base: CLEAN_TREE.base, upstream: CLEAN_TREE.upstream, behind: false },
        'the pin must name the tree it was generated from, or the retirement reasons in it are unfalsifiable',
      );
    });
  });

  it('records the commit the tree was built on beside the branch tip, so the stamp survives the merge (#1482)', async () => {
    // The failure #1482 is about, driven through the real command.
    //
    // `--prose-sync` stamps `provenance.head` with `HEAD`. This repository
    // squash-merges, so that commit is an interior commit of the squash and is
    // an ancestor of nothing afterwards: the stamp is orphaned by the very merge
    // that lands the prose it describes, `--check` reports it as a rewritten
    // history on a tree whose pinned paragraphs are all present, and clearing it
    // costs a follow-up commit. Five PRs paid that in one session.
    //
    // The witness that *does* survive is the commit `HEAD` and `origin/main` last
    // shared — an ancestor of both, and `main` only ever grows — so it is
    // recorded beside the tip rather than instead of it, and the read side asks
    // about it first. Asserted on the written file: a `--prose-sync` that
    // recorded the tip alone would satisfy an exit-code assertion and leave
    // every merge in this repository to orphan its own pin.
    const tip = uncontainedCommit('a branch tip this tree does not contain (#1482)');
    const base = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    // Confirm the fixture is the shape it claims before relying on it: a base
    // this tree does not contain would make the assertion below pass for a
    // reason that has nothing to do with the stamp.
    assert.equal(isAncestor(base), true, `the base must be in this tree's history, git said ${isAncestor(base)}`);
    assert.equal(isAncestor(tip), false, `the tip must NOT be in this tree's history, git said ${isAncestor(tip)}`);

    await withScratchDir(async (dir) => {
      const repoBefore = await readFile(MANIFEST, 'utf8');
      const copy = join(dir, 'manifest.json');
      await writeFile(copy, repoBefore);
      await writeProvenanceFile(dir, { ...CLEAN_TREE, head: tip, base, upstream: base });

      const run = runCensus([
        '--prose-sync',
        '--prose-manifest', copy,
        '--prose-provenance', join(dir, 'provenance.json'),
      ]);
      assert.equal(run.status, 0, `a clean, current tree must be accepted:\n${run.stderr}`);

      const manifest = JSON.parse(await readFile(copy, 'utf8'));
      assert.equal(manifest.provenance.head, tip, 'the tree the author was looking at is still recorded — it is the claim the retirements rest on');
      assert.equal(
        manifest.provenance.base,
        base,
        'the commit the stamp will be judged on was not recorded, so the merge that lands this prose orphans its own pin',
      );

      // And the read side, on a tree where the tip is gone and the base is not —
      // which is the state a squash-merge produces, and the only thing the merge
      // changes about the commit graph.
      const checked = runCensus(['--check', '--prose-manifest', copy]);
      assert.equal(
        checked.status,
        0,
        `a stamp naming a commit this tree contains must pass the gate, whatever became of the branch tip:\n${checked.stderr}`,
      );
      const verdict = runCensus(['--prose-report', '--prose-manifest', copy]);
      const provenance = JSON.parse(verdict.stdout).provenance as { status: string; detail: string };
      assert.equal(provenance.status, 'verified', `the base is in this history, so the pin is verified: ${provenance.detail}`);
      assert.match(provenance.detail, new RegExp(base.slice(0, 7)), 'the verdict must name the commit it verified against');
      assert.match(provenance.detail, new RegExp(tip.slice(0, 7)), 'the branch tip that is not in this history must be named too, or "verified" reads as if nothing was lost');

      assert.equal(await readFile(MANIFEST, 'utf8'), repoBefore, 'this test wrote to the checked-in manifest instead of the copy it was given');
    });
  });

  it('judges a manifest stamped before the base was recorded on its branch tip alone', async () => {
    // Backward compatibility, and deliberately in the strict direction.
    //
    // A manifest carrying no `base` was stamped by a version that had nowhere
    // else to put one, so the branch tip is the only witness it has and the only
    // witness it is judged on. That keeps today's `main` — whose stamp predates
    // the field — on the pre-#1482 semantics, and it is the direction that can
    // report `rewritten` where the base would not. Reading a missing `base` as
    // "this tree is fine" instead would silently forgive a stamp that is wrong.
    const tip = uncontainedCommit('a branch tip this tree does not contain (#1482, pre-base stamp)');
    const verdict = proseProvenanceVerdict(
      { provenance: { head: tip, upstream: 'b'.repeat(40), behind: false } },
      { ancestor: () => false },
    );
    assert.equal(verdict.status, 'rewritten', 'a stamp with no base has only its tip to judge, and this tree does not have it');
    assert.match(verdict.error!, new RegExp(tip.slice(0, 7)));

    // The same pin with a base that this tree does contain is verified, which is
    // what the field buys — asserted here so the pair cannot drift apart.
    const base = 'd'.repeat(40);
    const withBase = proseProvenanceVerdict(
      { provenance: { head: tip, base, upstream: base, behind: false } },
      { ancestor: (sha: string) => (sha === base ? true : false) },
    );
    assert.equal(withBase.status, 'verified');
    assert.equal(withBase.error, null);
  });

  it('warns when the stamp it is about to write cannot survive the merge', async () => {
    // A tree with no merge base — no `origin/main`, or two unrelated histories —
    // has no commit that is an ancestor of both sides, so the only stamp it can
    // produce names a branch tip. That is not a defect, and refusing over it
    // would break the case `--allow-stale` exists for, so it is a warning: the
    // write proceeds and the author is told the cost *before* they commit to it,
    // rather than discovering it as a red `main` between two merges.
    assert.equal(
      provenanceStampWarning({ ...CLEAN_TREE, base: 'e'.repeat(40) }),
      null,
      'a stamp naming the merge base survives the merge, so there is nothing to warn about',
    );
    assert.equal(
      provenanceStampWarning({ ...CLEAN_TREE, head: null, base: null }),
      null,
      'a tree with no head has no stamp to warn about — the refusal is proseSyncRefusals\' job',
    );
    assert.equal(
      provenanceStampWarning({
        usable: false, head: null, base: null, upstream: null, behind: false, detached: false, dirty: [], note: '',
      }),
      null,
      'an unusable tree is refused by proseSyncRefusals, which has its own message; a second one here would be noise',
    );

    const warning = provenanceStampWarning({ ...CLEAN_TREE, base: null });
    assert.match(warning!, /merge or rebase\s+origin\/main/, 'the warning has to say what to do, or it is a complaint');
    assert.match(warning!, /red `main`|orphaned/, 'the warning has to say what it costs');
  });

  it('records an override as an acknowledgement, not as a quiet pass', async () => {
    // The escape hatch has to cost something permanent, or it becomes the
    // default within a month. The acknowledgement goes in `provenance` beside
    // the retirement it qualifies — not into the retirement's own reason, which
    // is the field that is already the thing that went wrong in #1439.
    await withScratchDir(async (dir) => {
      const copy = join(dir, 'manifest.json');
      const truncated = join(dir, 'ARCHITECTURE.md');
      const source = await readFile(join(ROOT, 'ARCHITECTURE.md'), 'utf8');
      const kept = source.split('\n').filter((line) => !line.includes('Spotify is the system of record'));
      await writeFile(copy, await readFile(MANIFEST, 'utf8'));
      await writeFile(truncated, kept.join('\n'));
      const acknowledgement = 'the #1402 reword is already in this tree, verified by hand';
      await writeProvenanceFile(dir, { ...CLEAN_TREE, behind: true });

      const run = runCensus([
        '--prose-sync', '--retire', RETIREMENT_REASON,
        '--allow-stale', acknowledgement,
        '--prose-manifest', copy,
        '--prose-override', `ARCHITECTURE.md=${truncated}`,
        '--prose-provenance', join(dir, 'provenance.json'),
      ]);
      assert.equal(run.status, 0, `an acknowledged stale tree must be accepted:\n${run.stderr}`);

      const manifest = JSON.parse(await readFile(copy, 'utf8'));
      assert.equal(
        manifest.provenance.allowStale,
        acknowledgement,
        'the acknowledgement was not recorded, so a reviewer cannot tell that this retirement was written from a tree that could not vouch for itself',
      );
      const entry = (manifest.retired ?? []).find((row: { label: string }) => row.label.startsWith('Spotify is the system of record'));
      assert.ok(entry, 'the retirement itself was not recorded');
      assert.equal(entry.reason, RETIREMENT_REASON, 'the override must not rewrite the reason — that is the field that was already wrong');
    });
  });

  it('requires a reason before it will accept a stale tree', async () => {
    // The same argument `--retire` already makes, for the same reason: a flag
    // that is easy to pass with an empty value is a flag that gets passed with
    // one, and an acknowledgement with no reason is indistinguishable from
    // having not looked.
    await withScratchDir(async (dir) => {
      const copy = join(dir, 'manifest.json');
      await writeFile(copy, await readFile(MANIFEST, 'utf8'));
      await writeProvenanceFile(dir, { ...CLEAN_TREE, behind: true });

      const run = runCensus([
        '--prose-sync', '--allow-stale',
        '--prose-manifest', copy,
        '--prose-provenance', join(dir, 'provenance.json'),
      ]);
      assert.notEqual(run.status, 0, '--allow-stale with no reason was accepted');
      assert.match(run.stderr, /--allow-stale requires a reason/);
    });
  });

  it('reads the real working tree when no substitute is given', async () => {
    // Proves the substitute reaches the *decision* and not a test-only copy of
    // it. The reading this test asserts is the one `gitProvenanceIn(ROOT)`
    // returns, so the git plumbing is exercised for real.
    //
    // Deliberately tolerant of a refusal: this repository has ~20 agents working
    // in sibling worktrees, and asserting success would make the suite depend
    // on whether somebody happens to have a document dirty right now. Both
    // outcomes are asserted, and each one is meaningful.
    await withScratchDir(async (dir) => {
      const copy = join(dir, 'manifest.json');
      await writeFile(copy, await readFile(MANIFEST, 'utf8'));
      const realHead = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

      const run = runCensus(['--prose-sync', '--prose-manifest', copy]);
      if (run.status !== 0) {
        assert.match(
          run.stderr,
          /this tree cannot be attested/,
          `--prose-sync refused for a reason other than provenance:\n${run.stderr}`,
        );
        return;
      }
      const manifest = JSON.parse(await readFile(copy, 'utf8'));
      assert.equal(
        manifest.provenance.head,
        realHead,
        'the default reading did not come from this working tree, so the substitute and the real path are not the same code',
      );
    });
  });

  it('refuses a pin naming an absent commit where that is answerable, and stays silent where it is not', async () => {
    // The wiring proof for the read side, and the reason it exists separately
    // from the verdict test below. `proseProvenanceVerdict` returning a correct
    // error proves nothing if `checkDocumentation` never asks for it — which is
    // the exact failure #1238 had to fix in this repository, where a check was
    // written and never reached. So this drives the real gate.
    //
    // The commit is made with `commit-tree`, which writes an object that exists
    // in this clone and is *not* an ancestor of `HEAD`. Nothing is moved: no ref
    // is updated, no branch is created, and the worktree is untouched, so a
    // parallel test running against the same repository cannot observe this.
    await withScratchDir(async (dir) => {
      const repoBefore = await readFile(MANIFEST, 'utf8');
      const tree = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
      // Identity comes from the environment rather than from `git config`,
      // because this worktree may or may not have one and a test must not depend
      // on whose checkout it is running in. Nothing here is ever pushed, signed,
      // or attributed to a person.
      const dangling = execFileSync(
        'git',
        ['-C', ROOT, 'commit-tree', tree, '-m', 'a commit this branch does not contain'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Provenance Fixture',
            GIT_AUTHOR_EMAIL: 'provenance@example.invalid',
            GIT_COMMITTER_NAME: 'Provenance Fixture',
            GIT_COMMITTER_EMAIL: 'provenance@example.invalid',
          },
        },
      ).trim();

      // Confirm the fixture is the shape it claims before relying on it. An
      // object git does not know about exits 128 from `--is-ancestor`, and the
      // verdict that produces is `unverifiable`, not `rewritten` — so a typo
      // here would make this test pass for a reason that has nothing to do
      // with the gate.
      const ancestry = spawnSync('git', ['-C', ROOT, 'merge-base', '--is-ancestor', dangling, 'HEAD']);
      assert.equal(ancestry.status, 1, `the fixture commit must exist and NOT be an ancestor of HEAD (git said ${ancestry.status})`);

      const copy = join(dir, 'manifest.json');
      const manifest = JSON.parse(repoBefore);
      manifest.provenance = { head: dangling, upstream: null, behind: false };
      await writeFile(copy, JSON.stringify(manifest, null, 2));

      const run = runCensus(['--check', '--prose-manifest', copy]);

      // Which of the two documented behaviours applies is a property of the
      // checkout, not of the code under test, and asserting the wrong one is
      // asserting a bug away. On a full clone the walk reaches an answer, the
      // verdict is `rewritten`, and the gate must fail naming the commit. On a
      // `fetch-depth: 1` CI checkout `HEAD` is a graft point, the walk is
      // truncated before it can answer, the verdict is `unverifiable`, and the
      // gate is silent on purpose — the census documents that as "expected on a
      // shallow CI clone; it is not evidence either way".
      //
      // Both branches are real assertions, and they are opposite: a `headIs-
      // GraftPoint()` that disagreed with the census would land here in the
      // branch the gate contradicts, so this cannot pass by mis-detecting.
      if (headIsGraftPoint()) {
        assert.equal(
          run.status,
          0,
          'the gate failed on a pin this checkout provably cannot judge. Ancestry is '
            + 'unanswerable at a shallow boundary, so the verdict is `unverifiable` and the '
            + 'gate is silent by design; a failure here means it invented an answer:\n' + run.stderr,
        );
      } else {
        assert.notEqual(run.status, 0, 'the documentation gate passed a pin that describes prose this branch does not have');
        assert.match(run.stderr, /not an ancestor of HEAD/, 'the failure must name the rewritten-history condition, not just fail');
        assert.match(run.stderr, new RegExp(dangling.slice(0, 7)), 'the failure must name the commit the pin claims, so a reader can go and look at it');
      }

      assert.equal(
        await readFile(MANIFEST, 'utf8'),
        repoBefore,
        'this test wrote to the checked-in manifest instead of the copy it was given',
      );
    });
  });

  it('passes the real --check when the pin names a commit this branch does contain', async () => {
    // The other direction over the same code path. Every negative assertion in
    // this file is satisfied by a gate that reports an error unconditionally,
    // and this is the only thing that rules that out. Stamping with this
    // branch's own `HEAD` is the "verified" case, which must be silent.
    await withScratchDir(async (dir) => {
      const repoBefore = await readFile(MANIFEST, 'utf8');
      const realHead = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const copy = join(dir, 'manifest.json');
      const manifest = JSON.parse(repoBefore);
      manifest.provenance = { head: realHead, upstream: realHead, behind: false };
      await writeFile(copy, JSON.stringify(manifest, null, 2));

      const run = runCensus(['--check', '--prose-manifest', copy]);
      assert.equal(run.status, 0, `a pin stamped with this branch's own HEAD must pass the gate:\n${run.stderr}`);
    });
  });

  it('reports the provenance verdict from --prose-report, so "clean" is distinguishable from "unchecked"', async () => {
    // `--prose-report` exists so a reader can tell "checked ten files and found
    // nothing" from "found nothing at all". A provenance verdict that only ever
    // prints on failure has the same defect, so the status is in the JSON.
    // Three states, and the third is the one a naive implementation drops: this
    // repository's CI checks out with `fetch-depth: 1`, so a pin stamped before
    // that checkout names a commit the clone does not have.
    await withScratchDir(async (dir) => {
      const realHead = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const unknown = 'f'.repeat(40);
      const copy = join(dir, 'manifest.json');
      const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));

      const verdictFor = async (provenance: Record<string, unknown>) => {
        await writeFile(copy, JSON.stringify({ ...manifest, provenance }, null, 2));
        const run = runCensus(['--prose-report', '--prose-manifest', copy]);
        return { status: run.status, body: JSON.parse(run.stdout) as { provenance: { status: string } } };
      };

      const verified = await verdictFor({ head: realHead, upstream: realHead, behind: false });
      assert.equal(verified.body.provenance.status, 'verified');
      assert.equal(verified.status, 0);

      const unverifiable = await verdictFor({ head: unknown, upstream: realHead, behind: false });
      assert.equal(unverifiable.body.provenance.status, 'unverifiable', 'a commit the checkout does not have is unverifiable, not rewritten');
      assert.equal(unverifiable.status, 0, 'a shallow CI clone must not fail the documentation gate');
    });
  });

  it('reports a pin whose recorded commit is no longer in the branch history', async () => {
    // The rebased-branch case, and the reason the pin records a commit at all.
    // Nothing is wrong at write time here, so the guard cannot be a refusal; it
    // is a check-time error, and `--check` is the gate that has to carry it.
    const rewritten = { provenance: { head: 'c'.repeat(40), upstream: 'b'.repeat(40), behind: false } };
    const verdict = proseProvenanceVerdict(rewritten, { ancestor: () => false });
    assert.equal(verdict.status, 'rewritten');
    assert.ok(verdict.error, 'a rewritten history must produce an error, not a note');
    assert.match(verdict.error!, /not an ancestor of HEAD/);
    assert.match(verdict.error!, /--prose-sync/, 'the error has to say what to do');
  });

  it('does not fail a checkout that cannot answer the question', async () => {
    // The honest verdicts are three, not two. `git merge-base --is-ancestor`
    // exits 128 for "no such object", this repository's CI checks out with
    // `fetch-depth: 1`, and a manifest stamped before that checkout names a
    // commit that is simply not in the clone. Collapsing 128 into "no" would
    // turn every shallow CI run red, and a gate that is always red is a gate
    // nobody reads. Asserted because the *cheaper* implementation is the wrong
    // one, and it is the one that looks like a fix.
    const recorded = { provenance: { head: 'c'.repeat(40), upstream: 'b'.repeat(40), behind: false } };
    const verdict = proseProvenanceVerdict(recorded, { ancestor: () => null });
    assert.equal(verdict.status, 'unverifiable');
    assert.equal(verdict.error, null, 'a shallow checkout must not fail a documentation gate');
    assert.match(verdict.detail, /not evidence either way/, 'an unverifiable answer has to say it is not a clean one');
  });

  it('reports a pin that predates provenance rather than failing it', async () => {
    // The manifest checked in today has no `provenance` block, and requiring one
    // would make the very first run of this change red on `main`. A missing
    // record is a fact to surface, not a violation to enforce — the sentence
    // that surfaces it is what gets it stamped on the next legitimate sync.
    const verdict = proseProvenanceVerdict({ files: {} }, { ancestor: () => true });
    assert.equal(verdict.status, 'unrecorded');
    assert.equal(verdict.error, null, 'a pin with no recorded tree must not fail the gate');
    assert.match(verdict.detail, /--prose-sync/);
  });

  it('distinguishes a tip that is gone from a tip this checkout cannot see', async () => {
    // A `fetch-depth: 1` clone — which is how CI checks this repository out — has
    // the branch tip's object nowhere in it, so `merge-base --is-ancestor` exits
    // 128 and `ancestor` returns null. That is not the same answer as exit 1, and
    // it is not the absence of an answer about the base either, which is why the
    // base is still `true` here. Rendering the unknown as silence made `verified`
    // read as though the tip were still reachable, in exactly the environment
    // where nobody could tell by looking.
    const base = 'c'.repeat(40);
    const tip = 'a'.repeat(40);
    const manifest = { files: {}, provenance: { head: tip, base, upstream: base, behind: false } };
    const cannotSee = (sha: string) => (sha === base ? true : null);
    const verdict = proseProvenanceVerdict(manifest, { ancestor: cannotSee });

    assert.equal(verdict.status, 'verified', 'the base is in this history, so the pin itself is verified');
    assert.match(
      verdict.detail,
      new RegExp(tip.slice(0, 7)),
      'the tip must still be named when its fate is unknown — omitting the sentence is what reads as "nothing was lost"',
    );
    assert.match(
      verdict.detail,
      /could not be determined/,
      'and the reason has to say the answer is unavailable rather than implying the tip is present',
    );

    // The three-way distinction the paragraph is about: gone, unknown, and
    // same-commit. A stamp whose head IS its base has no separate tip to ask
    // about and must not claim to have looked for one.
    const gone = proseProvenanceVerdict(manifest, { ancestor: (sha) => (sha === base ? true : false) });
    assert.match(gone.detail, new RegExp(tip.slice(0, 7)));
    assert.match(gone.detail, /is not in this history/, 'a definite "no" is reported as one');
    assert.doesNotMatch(gone.detail, /could not be determined/);

    // The reachable tip is the fourth state, and it is the one a check that only
    // exercises the unhappy paths cannot see: a tip that IS in this history has
    // nothing to disclose, so neither sentence may appear. Rendering the known
    // answer as "could not be determined" would be its own kind of false claim.
    const reachable = proseProvenanceVerdict(manifest, { ancestor: () => true });
    assert.equal(reachable.status, 'verified');
    assert.doesNotMatch(
      reachable.detail,
      /could not be determined/,
      'a tip that is in this history must not be reported as an unanswerable question',
    );
    assert.doesNotMatch(
      reachable.detail,
      /is not in this history/,
      'nor as one that is missing',
    );

    const same = proseProvenanceVerdict(
      { files: {}, provenance: { head: base, base, upstream: base, behind: false } },
      { ancestor: cannotSee },
    );
    assert.doesNotMatch(same.detail, /could not be determined/, 'head === base leaves no tip to ask about');
    assert.doesNotMatch(same.detail, /is not in this history/);
  });

  it('classifies each staleness case as hard or soft, and only the soft ones are overridable', async () => {
    // The split is the design, so it is pinned directly rather than only
    // through the CLI. Collapsing the two classes into one list is how a guard
    // ends up with a documented bypass that applies to the case it was written
    // for, and no CLI test above can tell that apart.
    const behind = proseSyncRefusals({ ...CLEAN_TREE, behind: true });
    assert.equal(behind.hard.length, 0, 'being behind is a situation, not a defect — it must be overridable');
    assert.equal(behind.soft.length, 1);
    assert.deepEqual(proseSyncRefusals({ ...CLEAN_TREE, behind: true }, { allowStale: 'because' }).soft, []);

    const dirty = proseSyncRefusals({ ...CLEAN_TREE, dirty: ['README.md'] }, { allowStale: 'because' });
    assert.equal(dirty.hard.length, 1, 'uncommitted bytes are not a situation, and an override must not reach them');
    assert.deepEqual(proseSyncRefusals({ ...CLEAN_TREE, dirty: ['README.md'] }, { allowStale: 'because' }).soft, []);

    const usable = proseSyncRefusals(CLEAN_TREE);
    assert.deepEqual([usable.hard, usable.soft], [[], []], 'a clean, current, on-branch tree must produce no refusals at all');
  });

  it('carries the reading through the stamp rather than re-deriving it', async () => {
    // `stampProvenance` takes the reading that was already accepted rather than
    // re-reading the tree. If it re-read, a tree that moved between the refusal
    // and the write would be stamped with a different commit than the one the
    // decision was made against, and the two would silently disagree.
    const manifest = { files: { 'README.md': [] } };
    const stamped = stampProvenance(manifest, {
      head: 'a'.repeat(40),
      base: 'c'.repeat(40),
      upstream: 'b'.repeat(40),
      behind: true,
    });
    assert.deepEqual(
      stamped.provenance,
      { head: 'a'.repeat(40), base: 'c'.repeat(40), upstream: 'b'.repeat(40), behind: true },
      'both commits the reading decided on are carried through: the tree that was synced, and the commit it was built on',
    );
    assert.deepEqual(stamped.files, manifest.files, 'stamping must not disturb the pins it is recorded beside');
  });
});

describe('git provenance readings (#1440)', () => {
  it('reads a real repository as clean when nothing the pin depends on is uncommitted', async () => {
    // A real repository, not a fixture object shaped like what the author
    // expects git to return. `gitProvenanceIn` is the only place that knows
    // what `status --porcelain` and `--is-ancestor` actually say.
    await withScratchDir(async (dir) => {
      const { path, head, originMain } = await scratchRepo(dir);
      const prov = gitProvenanceIn(path, { docFiles: ['README.md'], manifestPath: 'scripts/pin.json' });
      assert.equal(prov.usable, true);
      assert.equal(prov.head, head);
      assert.equal(prov.upstream, originMain);
      assert.equal(prov.behind, true, 'HEAD does not contain the sibling commit this ref names');
      assert.equal(prov.detached, false);
      assert.deepEqual(prov.dirty, []);
      assert.deepEqual(proseSyncRefusals(prov).soft.length, 1, 'a real behind-reading must be a soft refusal, so the CLI test and this one agree');
    });
  });

  it('reads the commit this tree and origin/main share, which is the one the merge keeps (#1482)', async () => {
    // The reading the stamp is built from. `merge-base` is the only commit that
    // is an ancestor of both sides, so it is the only stamp that survives a
    // squash-merge — and it is a real git answer, not a construction: a `base`
    // that was anything other than the merge base would be a stamp no merge
    // could vouch for, and the field would be decoration.
    await withScratchDir(async (dir) => {
      const { path, head } = await scratchRepo(dir);
      const first = execFileSync('git', ['-C', path, 'rev-list', '--max-parents=0', 'HEAD'], { encoding: 'utf8' }).trim();

      // Behind: `origin/main` is a sibling of `HEAD`, so the newest commit they
      // share is the one they forked at.
      const behind = gitProvenanceIn(path, { docFiles: ['README.md'] });
      assert.equal(behind.behind, true);
      assert.equal(behind.base, first, 'a tree that forked from origin/main shares the fork point, not the tip it does not contain');

      // Current: `origin/main` is behind `HEAD`, so the newest shared commit is
      // `origin/main`'s own tip — the ordinary feature branch, and the case a
      // stamp naming the branch tip gets wrong.
      git(path, 'update-ref', 'refs/remotes/origin/main', first);
      const current = gitProvenanceIn(path, { docFiles: ['README.md'] });
      assert.equal(current.behind, false);
      assert.equal(current.base, first, 'a branch that contains origin/main shares its tip, so a stamp on it survives the squash');
      assert.notEqual(current.base, current.head, 'the base is the commit the tree was built on, not the tree itself — a stamp of HEAD is the #1482 bug');

      // A checkout with no `origin/main` to share anything with has no base, and
      // says so by leaving it null rather than substituting the head.
      git(path, 'update-ref', '-d', 'refs/remotes/origin/main');
      const detached = gitProvenanceIn(path, { docFiles: ['README.md'] });
      assert.equal(detached.base, null, 'a commit that cannot be read must not be guessed at');
      assert.equal(detached.upstream, null);
      assert.equal(detached.head, head);
      assert.ok(
        provenanceStampWarning(detached),
        'a stamp with no base is orphaned by the next squash-merge, and the author is told so',
      );
    });
  });

  it('reports a tree behind a ref it *does* contain as not behind', async () => {
    // The other direction, and the one that matters most: an implementation
    // that treated any ref mismatch as "behind" would refuse every ordinary
    // branch push and be switched off within a week. `HEAD` here is a
    // descendant of the ref, which is what a normal feature branch looks like.
    await withScratchDir(async (dir) => {
      const { path, head, originMain } = await scratchRepo(dir);
      git(path, 'update-ref', 'refs/remotes/origin/main', originMain);
      const first = execFileSync('git', ['-C', path, 'rev-list', '--max-parents=0', 'HEAD'], { encoding: 'utf8' }).trim();
      git(path, 'update-ref', 'refs/remotes/origin/main', first);

      const prov = gitProvenanceIn(path, { docFiles: ['README.md'] });
      assert.equal(prov.behind, false, 'a branch that contains origin/main is not behind it');
      assert.equal(prov.head, head);
      assert.deepEqual(proseSyncRefusals(prov), { hard: [], soft: [] }, 'an ordinary branch must sync without an override');
    });
  });

  it('reports only the uncommitted files the pin actually depends on', async () => {
    // A dirty `src/tools/foo.ts` cannot make a prose retirement false, and
    // refusing on it would train people to pass `--allow-stale` out of habit
    // until the flag stops meaning anything. This is also the assertion that
    // would catch a regression to "refuse on any dirty tree at all" — which
    // would be strictly more cautious and strictly less usable.
    await withScratchDir(async (dir) => {
      const { path } = await scratchRepo(dir);
      await writeFile(join(path, 'README.md'), 'An uncommitted edit to a pinned document.\n');
      await writeFile(join(path, 'src.ts'), 'An uncommitted edit to something else.\n');

      const prov = gitProvenanceIn(path, { docFiles: ['README.md'], manifestPath: 'scripts/pin.json' });
      assert.deepEqual(prov.dirty, ['README.md'], 'a file the pin does not depend on must not block a sync');
      assert.equal(proseSyncRefusals(prov).hard.length, 1);
    });
  });

  it('reports no usable tree for a directory that is not a repository', async () => {
    // A source tarball, or `npm pack` output. The reading has to degrade with
    // an explanation rather than throw, because the caller's job is to refuse
    // with a reason the author can act on — not to crash before it gets there.
    await withScratchDir(async (dir) => {
      const prov = gitProvenanceIn(dir, { docFiles: ['README.md'] });
      assert.equal(prov.usable, false);
      assert.match(prov.note, /not a git working tree/);
      assert.equal(proseSyncRefusals(prov).hard.length, 1);
      assert.equal(proseSyncRefusals(prov, { allowStale: 'because' }).hard.length, 1, 'this one has no override either');
    });
  });

  it('reports a detached HEAD, which is overridable but not silent', async () => {
    // A checkout of a tag or a SHA is a normal thing to do and produces a
    // manifest nobody can trace back to a branch, so it is worth saying — and
    // unlike the uncommitted case there is a legitimate reason to be there.
    //
    // The scratch repository is deliberately left behind `origin/main` as well,
    // so this asserts the detached reason is *among* the soft refusals rather
    // than that it is the only one. A test that counted refusals would have had
    // to make the fixture artificially clean, and the count is not the claim.
    await withScratchDir(async (dir) => {
      const { path, head } = await scratchRepo(dir);
      git(path, 'checkout', '--quiet', '--detach', head);
      const prov = gitProvenanceIn(path, { docFiles: ['README.md'] });
      assert.equal(prov.detached, true);
      const refusals = proseSyncRefusals(prov);
      assert.equal(refusals.hard.length, 0, 'a detached checkout is a situation, not a defect');
      assert.ok(
        // `prose-manifest.mjs` is untyped JavaScript (see the import above), so
        // `soft` arrives as `any` and this callback parameter needs saying. The
        // annotation is the claim under test: every refusal is a rendered line.
        refusals.soft.some((line: string) => /detached/.test(line)),
        `the detached reason is missing from the refusal:\n${refusals.soft.join('\n')}`,
      );
      assert.deepEqual(proseSyncRefusals(prov, { allowStale: 'checking out a tag on purpose' }).soft, []);
    });
  });
});

describe('the marker scan skip list states its reason (#1427)', () => {
  /**
   * Extract the block comment immediately above `MARKER_SCAN_SKIP`'s
   * declaration.
   *
   * Scoped to the declaration rather than the file, because the file is 2,250
   * lines and a whole-file assertion about "no call sites" would be satisfied
   * by a test that found the wrong comment.
   */
  async function skipDocstring(): Promise<string> {
    const source = await readFile(CENSUS, 'utf8');
    const at = source.indexOf('const MARKER_SCAN_SKIP');
    assert.notEqual(at, -1, 'MARKER_SCAN_SKIP is gone; this test is guarding a constant that no longer exists');
    const before = source.slice(0, at);
    const start = before.lastIndexOf('/**');
    assert.notEqual(start, -1, 'MARKER_SCAN_SKIP has no docstring, so there is no reason left to go stale');
    return before.slice(start);
  }

  it('does not justify the skip by naming a call site', async () => {
    // The defect #1427 is about. The old docstring justified skipping every
    // dot-directory by pointing at `mkdtemp(join(ROOT, '.census-fixture-'))`
    // in a test file. PR #1417 moved that fixture out of the repository root,
    // which left a correct skip resting on a sentence about a line that no
    // longer exists — and a justification that cites a location is a
    // justification that a later commit can invalidate without anyone noticing
    // the reasoning went with it.
    const docstring = await skipDocstring();
    assert.doesNotMatch(
      docstring,
      /\.census-fixture/,
      'the skip is justified by citing a fixture path that #1417 removed; the reasoning has to survive the call site moving',
    );
    assert.doesNotMatch(
      docstring,
      /mkdtemp\s*\(\s*join\s*\(\s*ROOT/,
      'the skip is justified by quoting a call expression rather than the hazard it guards against',
    );
  });

  it('names the invariant the skip protects, so it survives the next refactor', async () => {
    // The replacement has to carry the reason forward, not just delete the stale
    // citation. What makes the skip correct is concurrent-write safety — a
    // sibling process can populate an untracked directory while the scan is
    // walking it — and that is true whether or not any test still writes inside
    // the repository.
    const docstring = await skipDocstring();
    assert.match(
      docstring,
      /untracked|does not version|does not track/i,
      'the docstring must state the invariant (skip what the repository does not version), not an example of it',
    );
    assert.match(
      docstring,
      /#1238/,
      'the issue that established the hazard is the durable citation; a line number is not',
    );
    assert.match(
      docstring,
      /half-written|concurrent|sibling process/i,
      'the hazard is a torn read from a directory being written under the scan, and the docstring has to say so',
    );
  });

  it('still skips the tracked-but-generated directories the census would otherwise walk', async () => {
    // The other direction, and the reason this is not a test that only ever
    // fails. A docstring that "explains" the skip is worthless if the set itself
    // regressed, and the set is the part that has behaviour.
    const source = await readFile(CENSUS, 'utf8');
    const at = source.indexOf('const MARKER_SCAN_SKIP');
    const declaration = source.slice(at, source.indexOf(';', at));
    for (const dir of ['node_modules', 'dist', 'coverage']) {
      assert.match(declaration, new RegExp(`'${dir}'`), `${dir} is no longer skipped, so a census walk reads generated output as hand-written content`);
    }
  });
});

/**
 * A retirement reason that turns out to be FALSE (#1502).
 *
 * A retirement record is a permanent claim about *why* prose left a file, and
 * until this change there was no way to retract one — only to add a second,
 * equally-permanent record contradicting it. That leaves a reader holding two
 * entries with nothing to say which to believe, and leaves the false claim in the
 * manifest in perpetuity, in the one file whose whole value is being a
 * trustworthy record of prose loss.
 */
describe('retirement corrections (#1502)', () => {
  const A = { file: 'SPEC.md', hash: '46c5ce02d1cbde05', label: 'Response byte cap' };
  const B = { file: 'AGENTS.md', hash: '2baa4ae7670cf60a', label: 'recovery recipe' };

  /**
   * A record written by one `--retire` run: what was claimed, and when.
   *
   * Typed as `ProseRetirement` rather than a hand-written shape, so a fixture
   * that drifts from the real record is a type error rather than a test that
   * passes against a field nothing writes.
   */
  function record(entry: { file: string; hash: string; label?: string }, reason: string, date = '2026-09-27'): ProseRetirement {
    return { file: entry.file, hash: entry.hash, label: `${entry.label ?? entry.hash}…`, date, reason };
  }

  it('a correction retracts the reason it supersedes, and keeps the record', () => {
    // The false one from the issue, the correction, and one untouched record.
    const falseReason = record(A, 'reworded by #895: the paragraph gained the emitOnce exception');
    const correction = record(B, 'the paragraph was DELETED, not reworded — see the character-level diff', '2026-09-28');
    const untouched = record({ file: 'README.md', hash: '178a37f764107949' }, 'reworded by #1402');
    const manifest = {
      retired: [falseReason, { ...correction, corrects: retirementKey(A) }, untouched],
    };

    const standing = retirementStanding(manifest);
    assert.deepEqual(standing.unknown, [], 'a correction naming a real record is not unknown');
    assert.deepEqual(standing.cyclic, [], 'and not cyclic');
    // The retraction is what makes the correction worth anything: the false reason
    // is no longer in the set a reader acts on.
    assert.ok(
      standing.retracted.some((entry) => entry.reason === falseReason.reason),
      'the superseded reason must be marked retracted',
    );
    assert.ok(
      standing.active.some((entry) => entry.reason === correction.reason),
      'the correction is the reason that is still load-bearing',
    );
    assert.ok(
      standing.active.some((entry) => entry.reason === untouched.reason),
      'a record nobody corrected stays active',
    );
    assert.equal(standing.active.length + standing.retracted.length, manifest.retired.length, 'every record is one or the other');
    // Neither record is deleted: the claim that was made, and when, is the evidence
    // a later reader most needs. Deleting the false one would destroy the record
    // that a false reason was ever written here.
    assert.equal(standing.retracted.length + standing.active.length, 3);
    assert.ok(manifest.retired.includes(falseReason), 'the manifest itself is not rewritten by reading it');
  });

  it('a correction written by --prose-sync carries its own key, not the one it retracts', () => {
    // The record is keyed by `file:hash`, so a correction that inherited the
    // target's file and hash would sit at the SAME key as the record it retracts
    // — two entries at one key, `corrects` pointing at itself. That is a
    // self-correction, which the reader refuses, which means a correction could
    // never succeed. Driving the real sync is what caught it: the unit tests
    // above all built their correction records by hand and could not see it.
    const documents = { 'SPEC.md': 'A paragraph that is still here.\n' };
    const manifest = {
      files: { 'SPEC.md': [{ hash: 'a'.repeat(16), label: 'A paragraph…' }] },
      retired: [{ file: 'SPEC.md', hash: '4cba6f94f8fa9fa3', label: 'An older paragraph…', date: '2026-09-27', reason: 'reworded by #895' }],
    };
    const result = syncProseManifest(manifest, documents, {
      retire: 'the recorded reason said reworded; a character-level diff shows two sentences were deleted',
      reason: 'the recorded reason said reworded; a character-level diff shows two sentences were deleted',
      corrects: 'SPEC.md:4cba6f94f8fa9fa3',
      date: '2026-09-28',
    });
    assert.equal(result.unknownCorrection, null, 'the target exists, so this is not an unknown correction');
    const correction = result.retired.find((entry) => entry.corrects === 'SPEC.md:4cba6f94f8fa9fa3');
    assert.ok(correction, 'a correction record is written');
    assert.notEqual(retirementKey(correction), 'SPEC.md:4cba6f94f8fa9fa3', 'and it does not occupy the key it retracts');

    // The end state is the one the issue asked for: the false reason stops being
    // load-bearing, both records survive, and the manifest is not a place that
    // asserts something untrue with nothing to say so.
    const standing = retirementStanding({ retired: result.allRetired });
    assert.deepEqual(standing.cyclic, [], 'a real correction must not read as a cycle');
    assert.deepEqual(standing.unknown, []);
    // The fixture also drops its own pinned block, so `retired` is that drop plus
    // the correction — the assertion is on the target specifically, because a count
    // would be asserting an accident of the fixture.
    assert.ok(
      standing.retracted.some((entry) => entry.hash === '4cba6f94f8fa9fa3'),
      'the record the correction names is the one that stops being load-bearing',
    );
    assert.equal(
      standing.retracted.filter((entry) => entry.hash === '4cba6f94f8fa9fa3').length,
      1,
      'and it is retracted exactly once',
    );
    assert.ok(
      standing.active.some((entry) => /character-level diff/.test(entry.reason)),
      'while the correction is the reason that is still load-bearing',
    );
  });

  it('a --prose-sync correction of a record that is not there refuses rather than writing', () => {
    // The write must not happen: a correction retracting nothing is the #1439
    // shape, and the refusal is the whole point.
    const result = syncProseManifest(
      { files: { 'SPEC.md': [{ hash: 'a'.repeat(16), label: 'A…' }] }, retired: [] },
      { 'SPEC.md': 'still here\n' },
      { retire: 'a reason', reason: 'a reason', corrects: 'SPEC.md:deadbeefdeadbeef', date: '2026-09-28' },
    );
    assert.equal(result.refused, true);
    assert.equal(result.unknownCorrection, 'SPEC.md:deadbeefdeadbeef');
    assert.deepEqual(result.retired, [], 'and writes no record');
  });

  it('a correction of a correction still retracts the original', () => {
    // Transitivity is the part a single-level implementation gets wrong: a reader
    // who corrects a correction, and stops, leaves the original load-bearing again
    // with a reason that was already retracted once.
    const manifest = {
      retired: [
        record(A, 'the original, which was false'),
        { ...record(B, 'the first correction'), corrects: retirementKey(A) },
        { ...record({ file: 'SPEC.md', hash: 'd31c370da5da0cbe' }, 'the second correction'), corrects: retirementKey(B) },
      ],
    };
    const standing = retirementStanding(manifest);
    assert.equal(
      standing.retracted.length,
      2,
      'the original and the first correction are both retracted, leaving the second as the live reason',
    );
    assert.equal(standing.active.length, 1);
    assert.match(standing.active[0]!.reason, /second correction/);
  });

  it('a `corrects` naming no record is reported, not resolved', () => {
    // Silently ignoring it would write a correction that corrects nothing into
    // the one file whose value is that its claims can be trusted — the #1439 shape.
    const manifest = { retired: [{ ...record(A, 'a reason'), corrects: 'SPEC.md:deadbeefdeadbeef' }] };
    const standing = retirementStanding(manifest);
    assert.deepEqual(standing.unknown, [{ corrects: 'SPEC.md:deadbeefdeadbeef', by: retirementKey(A) }]);
    assert.deepEqual(standing.cyclic, []);
  });

  it('a record that corrects itself is reported, not resolved', () => {
    // There is no consistent reading of a retraction that retracts itself, and
    // picking one silently is a guess about what the author meant.
    const self = { ...record(A, 'why it left'), corrects: retirementKey(A) };
    const standing = retirementStanding({ retired: [self] });
    assert.deepEqual(standing.cyclic, [retirementKey(A)]);
    assert.deepEqual(standing.unknown, []);
  });

  it('the key is file + hash, because a bare hash is ambiguous', () => {
    assert.equal(retirementKey(A), 'SPEC.md:46c5ce02d1cbde05');
    // The same prose text pinned in two files: the collision that makes a bare
    // hash the wrong key, and the reason the CLI refuses one.
    assert.notEqual(retirementKey(A), retirementKey({ ...A, file: 'README.md' }));
  });

  it('a correction resolves transitively without looping forever', () => {
    // A two-record cycle terminates rather than recursing until the stack gives
    // out. The `seen` set is what makes that true, and the only way to know is to
    // run it — a cycle is exactly the input a correct-looking walk hangs on.
    const one = { ...record(A, 'first'), corrects: retirementKey(B) };
    const two = { ...record(B, 'second'), corrects: retirementKey(A) };
    const standing = retirementStanding({ retired: [one, two] });
    assert.ok(Array.isArray(standing.active));
    // Both are retracted by each other, so neither is load-bearing; what matters is
    // that the call returned at all.
    assert.ok(standing.retracted.length + standing.active.length === 2);
  });
});
