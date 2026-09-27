/**
 * Release-history comparison (#932) — the pure half.
 *
 * Split from `check-release-history.mjs` for the reason
 * `check-no-explicit-any.mjs` gives for its own split: a guard module that
 * runs its gate at import time turns `import` in a test into a side effect
 * (here, a `git tag` call and a possible `process.exit`). The comparison lives
 * here so both the CLI and `tests/release-history-guard.test.ts` can drive the
 * same code, and so a test can exercise a contradiction without creating a tag.
 */

/**
 * Releases that are tagged and that the generator cannot give a section, with
 * the commit that explains each one.
 *
 * `CHANGELOG.md` is generated: release-please reads its anchor from
 * `.github/release-please-manifest.json`, diffs the Conventional Commits since
 * that version, and writes one section per release. These four were tagged
 * without the manifest ever naming them, so release-please had no anchor and
 * emitted no section. #547 — "sync release-please manifest with package.json
 * (1.28.1)" — is the repair for the manifest lag that caused it, and is why
 * sections resumed at 1.28.2. Backfilling the four by hand would present a
 * reconstruction as a record, in the one file that must only ever be written by
 * a release PR. Deleting an entry here is only correct if the tag is gone;
 * adding one is a claim that a release happened without release-please
 * recording it, so the reason is the part that has to stay true.
 */
const UNRECORDABLE_RELEASES = {
  '1.27.0': 'tagged at dc7058f "chore: bump version to 1.27.0" — package.json and package-lock.json only, with no release-please manifest or CHANGELOG edit',
  '1.27.1': 'tagged at 2a0ecea "chore: bump version to 1.27.1 for test fix" — a hand bump, the same shape as 1.27.0',
  '1.28.0': 'tagged at cfca407 "chore(main): release 1.28.0" — bumped package.json, package-lock.json and server.json but not .github/release-please-manifest.json, so release-please had no anchor for it (#547 repaired the manifest)',
  '1.28.1': 'tagged at 91e588a "chore(main): release 1.28.1" — the same missing manifest update as 1.28.0 (#547)',
};

/**
 * Versions written as `## [x.y.z]`, optionally followed by a compare link and
 * a date.
 *
 * The closing bracket is required, which is why `## 2.1.2` is not a version
 * header: a section rewritten without brackets has stopped documenting a
 * release, and reading it as one would let a renamed heading pass as a
 * well-formed document with a gap in it.
 */
const CHANGELOG_HEADER = /^## \[(\d+\.\d+\.\d+)\]/;

/**
 * A heading that documents a build rather than a release: a prerelease
 * (`## [3.0.0-beta.1]`) or Keep a Changelog's `## [Unreleased]`.
 *
 * These are ignored rather than reported. A prerelease does not document a
 * release — it must not satisfy the `package.json` comparison, and it must not
 * make `v3.0.0` look documented before it is tagged — but it is a legitimate
 * heading and this repository has no prerelease policy to enforce, so flagging
 * one would fail the gate on a shape that is not a defect.
 */
const CHANGELOG_NON_RELEASE = /^## \[(?:Unreleased|\d+\.\d+\.\d+-[0-9A-Za-z.-]+)\]/i;

/** Compare two `x.y.z` strings numerically, so 1.30.0 sorts above 1.9.0. */
function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

/**
 * Every version the changelog claims to document, plus every level-2 heading it
 * contains that is neither a released version nor a non-release heading.
 *
 * The second return value is what stops a *renamed* header from reading as a
 * clean file: a section rewritten as `## 2.1.2` would otherwise simply vanish
 * from the comparison and look like a gap in `package.json` rather than a
 * malformed document.
 */
export function changelogVersions(source) {
  const versions = new Set();
  const malformed = [];
  for (const line of source.split('\n')) {
    if (!line.startsWith('## ')) continue;
    const match = CHANGELOG_HEADER.exec(line);
    if (match) versions.add(match[1]);
    else if (!CHANGELOG_NON_RELEASE.test(line)) malformed.push(line.trim());
  }
  return { versions, malformed };
}

/** A `v` prefix is stripped; anything that is not `x.y.z` is not a release tag. */
export function tagVersions(tags) {
  return new Set(
    [...tags].map((tag) => tag.trim().replace(/^v/, '')).filter((version) => /^\d+\.\d+\.\d+$/.test(version)),
  );
}

/**
 * Every disagreement between what is tagged, what the changelog documents, and
 * what `package.json` says is current. An empty list means the three agree.
 */
export function releaseHistoryErrors({ tags, changelog, packageVersion }) {
  const errors = [];
  const { versions: documented, malformed } = changelogVersions(changelog);
  for (const heading of malformed) {
    errors.push(`CHANGELOG.md has a level-2 heading that is not a released version: ${heading}`);
  }

  const tagged = tagVersions(tags);

  for (const version of [...tagged].filter((v) => !documented.has(v)).sort(compareVersions)) {
    if (version in UNRECORDABLE_RELEASES) continue;
    errors.push(
      `tag v${version} has no CHANGELOG.md section. The changelog is generated, so the fix is a release-please run that emits the section, not a hand-written entry.`,
    );
  }

  for (const version of [...documented].filter((v) => !tagged.has(v)).sort(compareVersions)) {
    // The one section legitimately ahead of the tags is the one for the
    // version the open release PR is cutting: release-please writes the section
    // and `package.json` in the PR, and the tag is created by merging it. CI
    // runs on the PR, before the merge, so requiring a tag here would turn
    // every release PR red. Anything else documented without a tag is a
    // hand-written entry or a section for a release that never happened.
    if (version === packageVersion) continue;
    errors.push(`CHANGELOG.md documents ${version}, which has no v${version} tag.`);
  }

  if (packageVersion) {
    if (!documented.has(packageVersion)) {
      errors.push(`package.json is at ${packageVersion} and CHANGELOG.md has no ${packageVersion} section.`);
    } else {
      const newest = [...documented].sort(compareVersions).at(-1);
      if (newest !== packageVersion) {
        errors.push(`CHANGELOG.md's newest section is ${newest}, but package.json is at ${packageVersion}.`);
      }
    }
  }

  return errors;
}

/** The releases the gate explains away, for reporting and for the test. */
export function unrecordableReleases() {
  return Object.entries(UNRECORDABLE_RELEASES).map(([version, reason]) => ({ version, reason }));
}
