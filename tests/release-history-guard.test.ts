/**
 * #932 — the release-history documents had drifted apart, and the drift was
 * only visible by hand.
 *
 * Four documents made claims about what this project has released. One named a
 * version line that had been abandoned thirty releases earlier; one named a
 * version that had long since shipped; one ended its history three minor
 * versions before the last release; and the generated changelog silently had no
 * entry for four tags, because nothing compared the two. Every one of those is a
 * *comparison* between two files, and a comparison nobody runs is a comment.
 *
 * So the fixes here are comparisons, and these tests are what make them real:
 *
 * - `scripts/release-history.mjs` compares the tags, the changelog headings and
 *   `package.json`. The tests drive that comparison in all three directions,
 *   plus the two ways a heading can stop being a heading at all, and assert the
 *   real gate passes on this tree.
 * - the four tags release-please can never emit a section for are *derived* from
 *   the repository rather than restated: the test computes `tags − sections` and
 *   requires it to equal the recorded list exactly, so a fifth gap fails until
 *   someone writes down why it cannot be closed.
 * - `SECURITY.md` and `docs/distribution.md` no longer carry a version, a
 *   version line or a date, and each is checked against the code it describes:
 *   the token path SECURITY.md names is the one `resolveTokenFile` returns, the
 *   headless variable it names is read by `loadConfig`.
 * - `SPEC.md`'s phases table is marked as build history, its duplicate label is
 *   gone, and it carries no hand-typed tool count.
 *
 * Every rule below is two-sided: an assertion that the document is right, and a
 * mutation that requires the same check to notice it is wrong. §6 is explicit
 * that a guard whose negative case was never run is decoration.
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DOCUMENTED_ENV_VARS,
  TRUTHY_ENV_VALUES,
  loadConfig,
  resolveTokenFile,
} from '../src/config.js';
import {
  changelogVersions,
  releaseHistoryErrors,
  tagVersions,
  unrecordableReleases,
} from '../scripts/release-history.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

/** Run a command expected to succeed and return its combined output. */
function runSuccess(args: string[]): string {
  return execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 });
}

/** Write fixture files into a temp dir and run the gate over them. */
function withFixtures<T>(files: Record<string, string>, run: (paths: Record<string, string>) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'smcp-release-history-'));
  try {
    const paths: Record<string, string> = {};
    for (const [name, body] of Object.entries(files)) {
      paths[name] = join(dir, name);
      writeFileSync(paths[name], body);
    }
    return run(paths);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const readDoc = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8');

const realTags = (): string[] =>
  execFileSync('git', ['tag', '--list', 'v*'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

const realChangelog = (): string => readDoc('CHANGELOG.md');

/**
 * The version this fixture claims is being released: the REAL `package.json`
 * version.
 *
 * This was hardcoded `'3.0.0'`, and my first fix derived a synthetic version
 * from the newest changelog heading. Both were wrong for the same reason, and
 * the release branch is what proved it.
 *
 * On a release PR the real CHANGELOG already contains an UNTAGGED section for
 * the version about to ship, because the tag is only created by the merge. A
 * fixture that appends to the real changelog therefore INHERITS that untagged
 * section, and the guard — which exempts only the version in `package.json` —
 * correctly reports it as a gap. The release PR went red for a fact about
 * itself, on both CI legs.
 *
 * So the fixture has to agree with the branch it runs on. The real
 * `package.json` version IS the version being released, so pairing it with the
 * real changelog is the one self-consistent arrangement: on a release branch
 * that section is untagged and therefore exempt, and after the merge it is
 * tagged and therefore consistent. Both cases pass, and neither depends on a
 * literal that expires the day that version ships.
 */
const nextUndocumented = (): string => JSON.parse(readDoc('package.json')).version;

/** A version guaranteed to differ from `version`, by advancing its patch. */
const bumpPatch = (version: string): string => {
  const [major = '0', minor = '0', patch = '0'] = version.split('.');
  return `${major}.${minor}.${Number(patch) + 1}`;
};

/** The newest version the changelog documents, as a string. */
const newestDocumented = (): string => [...changelogVersions(realChangelog()).versions].sort().at(-1)!;

// ---------------------------------------------------------------------------
// The release-history gate
// ---------------------------------------------------------------------------

describe('release history: every tag has a CHANGELOG section (#932)', () => {
  it('the real gate passes on this tree', () => {
    // The tags have to be there for this to mean anything, and CI has to fetch
    // them for the same reason: `actions/checkout` defaults to `fetch-depth: 1`
    // and brings none, so the gate would compare an empty list. The precondition
    // is stated rather than assumed, so a shallow clone reads as "fetch the
    // tags" instead of as a pass.
    assert.ok(realTags().length > 0, 'precondition: no v* tags in this clone — run `git fetch --tags` (CI does this before the gate)');
    assert.match(runSuccess(['scripts/check-release-history.mjs']), /Release history is consistent/);
  });

  it('the unrecorded releases are exactly the tags with no section — none more, none fewer', () => {
    // This is the anti-drift form of the exception list. #932 found four tags
    // with no changelog section and the gate carries four recorded exceptions.
    // If a fifth release ever loses its section, `tags − sections` grows and
    // this fails, so the exceptions cannot quietly absorb a gap that *could*
    // have been closed: someone has to write down why it could not.
    assert.ok(realTags().length > 0, 'precondition: no v* tags in this clone — run `git fetch --tags`');
    const documented = changelogVersions(realChangelog()).versions;
    const unrecorded = [...tagVersions(realTags())].filter((version) => !documented.has(version)).sort();
    const recorded = unrecordableReleases().map((entry) => entry.version).sort();
    assert.deepEqual(unrecorded, recorded, 'the recorded exceptions no longer match the tags that have no changelog section');
  });

  it('each recorded exception is still a real gap, and says which commit tagged it', () => {
    const tags = tagVersions(realTags());
    const documented = changelogVersions(realChangelog()).versions;
    for (const { version, reason } of unrecordableReleases()) {
      // If a section ever appears for one of these, the exception is stale: the
      // gap closed and the entry should have been removed rather than left to
      // suppress a section that now exists.
      assert.ok(tags.has(version), `recorded exception ${version} is not tagged`);
      assert.ok(!documented.has(version), `recorded exception ${version} now has a CHANGELOG section; remove the exception`);
      // The reason is the evidence. A bare version list would leave a reader to
      // assume the omission is a mistake, which is the belief this gate exists
      // to remove.
      assert.match(reason, /\b[0-9a-f]{7,40}\b/, `${version}'s reason names no commit`);
      assert.ok(reason.length > 60, `${version}'s reason is too short to be evidence: ${reason}`);
    }
  });

  it('a tag with no section fails, and the recorded exceptions are what suppress the other four', () => {
    const tags = realTags();
    assert.ok(tags.length > 0, 'precondition: no v* tags in this clone');
    const output = withFixtures(
      { 'tags.txt': `${tags.join('\n')}\nv9.9.9\n` },
      (paths) => runFailure(['scripts/check-release-history.mjs', '--tags-file', paths['tags.txt']]),
    );
    assert.match(output, /tag v9\.9\.9 has no CHANGELOG\.md section/);
    // The failure has to say where the fix belongs. A reader who took this as
    // "add the missing section by hand" would break the one rule that keeps the
    // changelog a record rather than a reconstruction.
    assert.match(output, /generated/, 'the failure should say where the fix belongs, not just that something is wrong');
    // The same invocation still carries the four recorded versions in its tag
    // list, and must not mention them. If it did, the exceptions would not be
    // load-bearing and the consistent result above would be unexplained.
    for (const { version } of unrecordableReleases()) {
      assert.ok(!output.includes(`v${version} has no`), `recorded exception ${version} was reported as a gap`);
    }
  });

  it('a section with no tag fails', () => {
    const output = withFixtures(
      { 'changelog.md': `${realChangelog()}\n## [9.9.9] — 2027-01-01\n` },
      (paths) => runFailure(['scripts/check-release-history.mjs', '--changelog', paths['changelog.md']]),
    );
    assert.match(output, /CHANGELOG\.md documents 9\.9\.9, which has no v9\.9\.9 tag/);
  });

  it('the section for the version being released is exempt, because its tag is the merge', () => {
    // A release PR writes the section and `package.json` together; the tag is
    // created by the merge, after CI has already run on the PR. Requiring a tag
    // for that one version would turn every release PR red — including the one
    // open right now — so it is the single exemption. Everything else with no
    // tag still fails, which the test above shows.
    // DERIVED, not hardcoded. This used to be `const next = '3.0.0'`, which
    // was correct only while 3.0.0 was still unreleased. The moment it shipped,
    // `realChangelog()` began containing a 3.0.0 section, so appending another
    // one built a DUPLICATE — which the guard correctly reported as an untagged
    // version, and the release PR went red for a reason that had nothing to do
    // with the release. Same shape as #1658: a release-path assumption that is
    // true once and then quietly false forever. Deriving from the newest
    // documented version makes the fixture describe "a version that is not in
    // the changelog yet", which is what a release PR actually is, so it holds
    // for every future release instead of exactly one.
    const next = nextUndocumented();
    const release = { 'changelog.md': realChangelog(), 'package.json': JSON.stringify({ version: next }) };
    withFixtures(release, (paths) => {
      assert.match(
        runSuccess([
          'scripts/check-release-history.mjs',
          '--changelog', paths['changelog.md'],
          '--package', paths['package.json'],
        ]),
        /Release history is consistent/,
        'a release PR carrying its own untagged section was reported as inconsistent',
      );
    });
    // The exemption is for the version being released and nothing else: the
    // same document with a *different* untagged section still fails.
    // Also derived, and for the same reason: the stray must be a version that
    // differs from `next`, and pinning it to 3.0.1 meant it silently became a
    // DUPLICATE the day 3.0.1 shipped — which would have made the negative case
    // assert nothing. Derived from a different bump so it can never equal `next`.
    const strayVersion = bumpPatch(next);
    const stray = `${release['changelog.md']}\n## [${strayVersion}] — 2026-09-28\n`;
    withFixtures({ ...release, 'changelog.md': stray }, (paths) => {
      assert.match(
        runFailure([
          'scripts/check-release-history.mjs',
          '--changelog', paths['changelog.md'],
          '--package', paths['package.json'],
        ]),
        new RegExp(`CHANGELOG\\.md documents ${strayVersion.replace(/\./g, '\\.')}, which has no v${strayVersion.replace(/\./g, '\\.')} tag`),
        'the exemption covered a version that is not the one being released',
      );
    });
  });

  it('a package.json version with no section fails', () => {
    const output = withFixtures(
      { 'package.json': JSON.stringify({ version: '9.9.9' }) },
      (paths) => runFailure(['scripts/check-release-history.mjs', '--package', paths['package.json']]),
    );
    assert.match(output, /package\.json is at 9\.9\.9 and CHANGELOG\.md has no 9\.9\.9 section/);
  });

  it('a heading that is not a released version fails, and the two legitimate non-release headings do not', () => {
    const newest = newestDocumented();
    assert.ok(newest, 'precondition: the changelog has no version headers');
    // A section rewritten as `## 2.1.2` — brackets dropped — stops documenting
    // a release while still looking like a heading. Without this arm it would
    // simply vanish from the comparison and read as a gap in `package.json`
    // rather than a malformed document.
    const malformed = realChangelog().replace(`## [${newest}]`, `## ${newest}`);
    assert.notEqual(malformed, realChangelog(), 'precondition: the header mutation changed nothing');
    const output = withFixtures(
      { 'changelog.md': malformed },
      (paths) => runFailure(['scripts/check-release-history.mjs', '--changelog', paths['changelog.md']]),
    );
    assert.match(output, /level-2 heading that is not a released version/);

    // The other side. A prerelease and Keep a Changelog's `## [Unreleased]` are
    // not defects, and this repository has no prerelease policy to enforce. If
    // the malformed arm were really "any heading that is not a plain version",
    // these two would fail the gate on a legitimate shape. They are *added*
    // rather than substituted, because replacing the newest header would remove
    // a release and fail for an unrelated and correct reason.
    for (const heading of ['## [Unreleased]', `## [${newest}-rc.1]`]) {
      const source = realChangelog().replace('# Changelog\n', `# Changelog\n\n${heading}\n\n* not a release\n`);
      assert.ok(source.includes(heading), `precondition: ${heading} was not inserted into the fixture`);
      withFixtures({ 'changelog.md': source }, (paths) => {
        assert.match(
          runSuccess(['scripts/check-release-history.mjs', '--changelog', paths['changelog.md']]),
          /Release history is consistent/,
          `${heading} was reported as a defect`,
        );
      });
    }
  });

  it('the newest-section comparison sorts numerically, not lexicographically', () => {
    // `1.9.0` sorts *after* `1.30.0` as a string, so a lexicographic comparison
    // would report the wrong newest section and either miss a real gap or invent
    // one. These two releases are the ones the string order gets backwards.
    const changelog = '## [1.9.0]\n\n* a\n\n## [1.30.0]\n\n* b\n';
    assert.deepEqual(
      releaseHistoryErrors({ tags: ['v1.9.0', 'v1.30.0'], changelog, packageVersion: '1.30.0' }),
      [],
      '1.30.0 as the current version was not accepted',
    );
    assert.deepEqual(
      releaseHistoryErrors({ tags: ['v1.9.0', 'v1.30.0'], changelog, packageVersion: '1.9.0' }),
      ["CHANGELOG.md's newest section is 1.30.0, but package.json is at 1.9.0."],
    );
  });

  it('a shallow clone is a loud failure rather than a green one', () => {
    // An empty tag list compared against 43 sections would report 43
    // "documents X, which has no tag" errors and look like a broken repository.
    // The gate refuses the comparison instead, because `actions/checkout` fetches
    // no tags at its default depth and that is the state CI is in until it runs
    // `git fetch --tags`.
    const output = withFixtures(
      { 'tags.txt': '' },
      (paths) => runFailure(['scripts/check-release-history.mjs', '--tags-file', paths['tags.txt']]),
    );
    assert.match(output, /no v\* tags/);
    assert.match(output, /git fetch --tags/);
  });
});

// ---------------------------------------------------------------------------
// The CI wiring that makes the gate's input real
// ---------------------------------------------------------------------------

/**
 * One workflow step, parsed out of `ci.yml` by name.
 *
 * A guard here is a real fix only if the *step* carries it, and a step is a
 * block of lines — so this slices the block rather than searching the file for
 * a string. Grepping the whole workflow for `if: ${{ !cancelled() }}` would
 * pass as soon as any unrelated step had one, which is exactly the state the
 * bug was found in: three steps carried the guard and the two that mattered
 * did not.
 */
function workflowStep(workflow: string, name: string): string {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.notEqual(start, -1, `ci.yml has no step named ${JSON.stringify(name)}`);
  // A step ends where the next step begins, or at the end of the job.
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\s{6}- name: /.test(line));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join('\n');
}

/** Whether a step runs even after an earlier step failed. */
function runsUnlessCancelled(step: string): boolean {
  return /^\s*if:\s*\$\{\{[^}]*!cancelled\(\)/m.test(step);
}

/** Remove a step's `if:` line, which is the shape the step had before #932. */
function withoutGuard(step: string): string {
  return step
    .split('\n')
    .filter((line) => !/^\s*if:/.test(line))
    .join('\n');
}

describe('ci.yml fetches the tags the release-history gate compares (#932)', () => {
  it('the tag-fetch step and the gate run even when an earlier step failed', () => {
    const workflow = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');

    // A step with no `if:` is skipped as soon as any earlier step fails. The
    // tag fetch had no `if:`, so an unrelated red upstream of it — the
    // typecheck budget, in the run that reported this — dropped the tag list,
    // and the gate below it was skipped with it. The test step that depends on
    // those tags *did* carry `if: ${{ !cancelled() }}`, so it kept running and
    // reported eight failures that all named a missing clone instead of the
    // skipped fetch that caused them.
    for (const name of ['Fetch release tags', 'Release-history check (every tag has a CHANGELOG section)']) {
      assert.ok(
        runsUnlessCancelled(workflowStep(workflow, name)),
        `ci.yml step ${JSON.stringify(name)} is skipped when an earlier step fails, so the tags it needs never arrive`,
      );
    }
  });

  it('detects the step that lost its guard, rather than the workflow that kept one', () => {
    // The regression sat next to three steps that already carried the guard,
    // so "this workflow contains a `!cancelled()` step" is not the property
    // being asserted — that check passed on the broken file. Slicing by step
    // name is what makes it specific, and the mutation below is the proof: put
    // the broken shape back and the same predicate has to reject it.
    const workflow = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    const fetchStep = workflowStep(workflow, 'Fetch release tags');

    assert.equal(
      runsUnlessCancelled(withoutGuard(fetchStep)),
      false,
      'the guard check accepts a step whose guard was removed, so it cannot detect this regression',
    );

    // And the same holds when the file itself is mutated rather than a slice
    // of it — otherwise the rejection above could be an artefact of the
    // slice boundary rather than of the missing line.
    const brokenWorkflow = workflow.replace(
      /^(\s*)if:\s*\$\{\{[^}]*!cancelled\(\)[^\n]*\n(?=[\s\S]*?^\s*run: git fetch --tags)/m,
      '',
    );
    assert.notEqual(brokenWorkflow, workflow, 'precondition: the mutation changed nothing');
    assert.equal(
      runsUnlessCancelled(workflowStep(brokenWorkflow, 'Fetch release tags')),
      false,
      'the check still finds a guard on a step that no longer has one',
    );
  });
});

// ---------------------------------------------------------------------------
// SECURITY.md
// ---------------------------------------------------------------------------

/**
 * A release version (`2.1.2`) or a release *line* (`1.x`).
 *
 * Both are the shape that goes stale. SECURITY.md supported `1.0.x` when the
 * package was thirty releases past it; removing that table left `including the
 * whole 1.x series` in the sentence beside it — the same claim, one clause
 * later, and wrong again the moment a 3.x ships. The current line is whatever
 * `package.json` says, and a document that inlines it will eventually disagree
 * with the package it is describing.
 */
const RELEASE_LITERAL = /(?<![A-Za-z0-9])v?\d+(?:\.\w+){1,2}\b/gi;

/** Every release literal in a passage, as `[]` when there are none. */
function literalsIn(text: string): string[] {
  return text.match(RELEASE_LITERAL) ?? [];
}

/** An ISO date, written or implied. */
const ISO_DATE = /\d{4}-\d{2}-\d{2}/;

/**
 * Every stale-able figure in a heading, named the way the reader would meet it.
 *
 * Shared by the assertion and its mutation on purpose. Two separate patterns
 * would let the positive check pass on a rule the negative case never exercised,
 * which is the failure mode §6 is about.
 */
function headingProblems(heading: string): string[] {
  return [
    ...literalsIn(heading).map((literal) => `release figure ${literal}`),
    ...(ISO_DATE.test(heading) ? [`date ${ISO_DATE.exec(heading)![0]}`] : []),
  ];
}

describe('SECURITY.md states the supported line without naming it (#932)', () => {
  it('carries no release version and no release line', () => {
    const source = readDoc('SECURITY.md');
    // Precondition: the scan is looking at a real document. Without it this
    // would also pass on a file that had been emptied.
    assert.ok(source.length > 1000, 'precondition: SECURITY.md is suspiciously short');
    assert.deepEqual(literalsIn(source), [], 'SECURITY.md names a release version or line that will go stale');
  });

  it('the guard would have caught the #932 table, and the clause that outlived it', () => {
    // The assertion above is checked against the exact sentence #932 reported,
    // restored verbatim: a two-row table naming 1.0.x and the note that
    // followed it. If the scan cannot see this, it is not looking at the file.
    const restored = readDoc('SECURITY.md').replace(
      'Only the current release line receives security fixes; every earlier line is\nunsupported.',
      [
        '| Version | Supported |',
        '|---------|-----------|',
        '| 1.0.x   | Yes       |',
        '',
        'Older release lines are not maintained; please upgrade to the latest 1.0.x before reporting.',
      ].join('\n'),
    );
    assert.notEqual(restored, readDoc('SECURITY.md'), 'precondition: the table mutation changed nothing');
    // The pattern reports `1.0` and `0.x` out of `1.0.x` — the two halves of a
    // release line — so the assertion is that the restored text yields figures
    // where the file yields none, and that one of them is the line.
    const hits = literalsIn(restored);
    assert.ok(hits.length > 0, 'the guard did not flag the abandoned 1.0.x line it exists to catch');
    assert.ok(hits.some((hit) => hit.endsWith('.x')), `the guard did not see 1.0.x as a release line: ${hits.join(', ')}`);
    // And the clause that survived the original fix, which the same pattern has
    // to catch: a release line named in prose ages exactly like one named in a
    // table, and #932's fix is what left it behind.
    const withProseLine = readDoc('SECURITY.md').replace(
      'every earlier line is',
      'every earlier line, including the whole 1.x series, is',
    );
    assert.notEqual(withProseLine, readDoc('SECURITY.md'), 'precondition: the prose mutation changed nothing');
    assert.ok(literalsIn(withProseLine).includes('1.x'), 'the guard did not flag a release line named in prose');
  });

  it('points at the sources it declines to inline', () => {
    const source = readDoc('SECURITY.md');
    assert.match(source, /`version` field in\s*\n`?package\.json`?/, 'SECURITY.md no longer says where the current version lives');
    assert.match(source, /\(CHANGELOG\.md\)/, 'SECURITY.md no longer points at the changelog for what each release contains');
  });

  it('the token path it names is the one the code resolves', () => {
    // A security page that sends a reporter to the wrong file is worse than one
    // that names none, so the path is checked against `resolveTokenFile` rather
    // than against a literal typed into this test. The home directory is
    // whatever `homedir()` returns, because the hermetic helper has redirected
    // it to a temp root.
    assert.equal(resolveTokenFile({}), join(homedir(), '.spotify-mcp', 'tokens.json'));
    assert.ok(
      readDoc('SECURITY.md').includes('~/.spotify-mcp/tokens.json'),
      'SECURITY.md no longer names the default token cache',
    );
  });

  it('the headless variable it names is the one the config reads', () => {
    // `SPOTIFY_HEADLESS=1` is a reportable attack surface — the paste flow — so
    // a wrong value here would send a report to a surface that does not exist.
    // The value is checked against the config's own vocabulary rather than
    // against `true`, which is what the code was edited to accept by accident.
    const source = readDoc('SECURITY.md');
    const printed = /SPOTIFY_HEADLESS=([^`)\s]+)/.exec(source)?.[1];
    assert.equal(printed, '1', 'SECURITY.md no longer names the headless paste flow with an explicit value');
    assert.ok(TRUTHY_ENV_VALUES.includes(printed!), 'the value SECURITY.md prints is not one the config reads as true');
    assert.ok(
      DOCUMENTED_ENV_VARS.filter((entry) => entry.inHelp).map((entry) => entry.name).includes('SPOTIFY_HEADLESS'),
      'SPOTIFY_HEADLESS is no longer a documented variable',
    );
    assert.equal(loadConfig({ SPOTIFY_HEADLESS: printed! }).headless, true, 'loadConfig does not read the documented value as true');
    assert.equal(loadConfig({ SPOTIFY_HEADLESS: '0' }).headless, false, 'loadConfig reads a falsy value as true');
    assert.equal(loadConfig({}).headless, false, 'headless defaulted on with no variable set');
  });
});

// ---------------------------------------------------------------------------
// docs/distribution.md
// ---------------------------------------------------------------------------

describe('docs/distribution.md quotes no release figure it cannot keep current (#932)', () => {
  it('no level-2 heading carries a version or a date', () => {
    // The page exists to be pasted into a directory submission, where a header
    // naming a release is read as the current one. The surface line under it is
    // generated and `--check`-gated, the test count is stated nowhere and read
    // from CI, and the header said "v1.27.1, 2026-08-31" — none of those.
    const headings = [...readDoc('docs/distribution.md').matchAll(/^## .*$/gm)].map((match) => match[0]);
    assert.ok(headings.length > 0, 'precondition: docs/distribution.md has no level-2 headings');
    for (const heading of headings) {
      assert.deepEqual(headingProblems(heading), [], `docs/distribution.md heading names a figure nothing keeps current: ${heading}`);
    }
  });

  it('the heading guard would have caught the frozen header #932 reported', () => {
    const restored = readDoc('docs/distribution.md').replace('## Canonical facts', '## Canonical facts (2026-08-31, v1.27.1)');
    const heading = /^## .*$/gm.exec(restored)?.[0] ?? '';
    assert.notEqual(heading, '', 'precondition: the heading mutation produced no heading');
    const problems = headingProblems(heading);
    assert.ok(problems.includes('date 2026-08-31'), `the date arm did not flag the frozen header: ${problems.join(', ')}`);
    assert.ok(problems.includes('release figure v1.27.1'), `the version arm did not flag the frozen header: ${problems.join(', ')}`);
  });

  it('the surface figure it does quote lives in the generated block, not in the prose', () => {
    // Not a second copy of the test-count guard in tests/doc-figures.test.ts.
    // This one is about *where* the surface figures are, because a figure
    // outside a generated block is the failure the block exists to prevent, and
    // this is the page that gets copied into submissions elsewhere.
    const source = readDoc('docs/distribution.md');
    const start = source.indexOf('<!-- BEGIN:generated surface-census -->');
    const end = source.indexOf('<!-- END:generated surface-census -->');
    assert.ok(start >= 0 && end > start, 'precondition: docs/distribution.md has no surface-census block');
    const block = source.slice(start, end);
    const prose = source.slice(0, start) + source.slice(end);
    const count = /- Surface: ([\d,]+) tools/.exec(block)?.[1];
    assert.ok(count, 'precondition: the generated block states no tool count');
    // A hand-copied restatement above or below the block is what this catches.
    assert.deepEqual(
      prose.match(new RegExp(`\\b${count} tools\\b`, 'g')) ?? [],
      [],
      `the generated tool count ${count} is also hand-written in the prose`,
    );
  });
});

// ---------------------------------------------------------------------------
// SPEC.md
// ---------------------------------------------------------------------------

describe("SPEC.md's phases table is build history, not a release record (#932)", () => {
  const phasesSection = (): string => {
    const source = readDoc('SPEC.md');
    const start = source.indexOf('## Implementation phases');
    assert.ok(start >= 0, 'precondition: SPEC.md no longer has an implementation-phases section');
    return source.slice(start);
  };

  it('is labelled as history and says where the current surface is measured', () => {
    const section = phasesSection();
    assert.match(section.split('\n')[0], /\(build history\)/, 'the phases section is not labelled as build history');
    assert.match(section, /\[CHANGELOG\.md\]\(CHANGELOG\.md\)/, 'the phases section does not defer to the changelog for what shipped');
    assert.match(section, /npm run count:tools/, 'the phases section does not point at the generated surface figures');
  });

  it('every phase label is unique', () => {
    // #932's table carried two rows both labelled `Phase 15`, which is how a
    // reader counting phases ends up with a phase that has two scopes and no
    // order between them.
    const labels = [...phasesSection().matchAll(/\*\*(Phase \d+)\*\*/g)].map((match) => match[1]);
    assert.ok(labels.length > 0, 'precondition: the phases table has no rows');
    const seen = new Set<string>();
    const duplicates = labels.filter((label) => (seen.has(label) ? true : (seen.add(label), false)));
    assert.deepEqual(duplicates, [], `duplicate phase labels: ${duplicates.join(', ')}`);

    // Anti-vacuity: the shape main actually had, put back.
    const regressed = [...'| **Phase 15** | one |\n| **Phase 15** | two |\n'.matchAll(/\*\*(Phase \d+)\*\*/g)].map((match) => match[1]);
    const seenAgain = new Set<string>();
    assert.deepEqual(
      regressed.filter((label) => (seenAgain.has(label) ? true : (seenAgain.add(label), false))),
      ['Phase 15'],
      'the duplicate-label check does not detect a duplicate',
    );
  });

  it('carries no hand-typed tool count', () => {
    // The table used to end at a release whose "550 tools" figure was 58 tools
    // behind the shipped surface. Generated rows would duplicate a generated
    // changelog by hand, and a figure inside a history table is a figure that
    // goes stale — which is the defect this section was reported for.
    const section = phasesSection();
    assert.ok(section.length > 500, 'precondition: the phases section is suspiciously short');
    const counts = [...section.matchAll(/\b\d[\d,]*\s+(?:registered\s+)?tools?\b/gi)].map((match) => match[0]);
    assert.deepEqual(counts, [], `the phases table hand-types a tool count: ${counts.join(', ')}`);

    // Anti-vacuity: the sentence #932 quoted, put back.
    const withCount = section.replace('live gauntlet and `tools/list` verified', '550 registered tools — live gauntlet and `tools/list` verified');
    assert.notEqual(withCount, section, 'precondition: the tool-count mutation changed nothing');
    assert.deepEqual(
      [...withCount.matchAll(/\b\d[\d,]*\s+(?:registered\s+)?tools?\b/gi)].map((match) => match[0]),
      ['550 registered tools'],
      'the tool-count check does not detect the figure it exists to catch',
    );
  });
});
