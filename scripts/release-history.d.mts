/**
 * Types for `scripts/release-history.mjs`.
 *
 * **Hand-maintained alongside the `.mjs` it describes — update this file
 * whenever that script's exports change.** A signature that stops matching the
 * implementation is a bug in this file, and the fix is to correct it here, never
 * to widen a caller's cast back to `any`.
 *
 * The module is plain JavaScript and is split out of
 * `scripts/check-release-history.mjs` for the reason
 * `check-no-explicit-any.mjs` gives for its own split: a guard module that runs
 * its gate at import time turns `import` in a test into a `git tag` side effect.
 * But `tsconfig.tests.json` includes `src` and `tests` and not `scripts`, so
 * `tests/release-history-guard.test.ts` importing the pure half still got TS7016
 * — and because the binding was `any`, `unrecordableReleases().map((entry) => …)`
 * had no contextual type, so `entry` was an implicit-any parameter. Two errors,
 * one missing file.
 */

/**
 * A version header the changelog claims, and every level-2 heading that is
 * neither a released version nor a recognised non-release heading.
 *
 * `malformed` is what stops a *renamed* header from reading as a clean file: a
 * section rewritten as `## 2.1.2` would otherwise simply vanish from the
 * comparison and look like a gap in `package.json` rather than a malformed
 * document. Entries are the trimmed heading text.
 */
export interface ChangelogVersions {
  /** Every `## [x.y.z]` version the document claims to document. */
  versions: Set<string>;
  /** Level-2 headings that are neither a version nor `## [Unreleased]`. */
  malformed: string[];
}

/** A release the gate explains away, and the commit history that says why. */
export interface UnrecordableRelease {
  /** The bare `x.y.z`, without the `v`. */
  version: string;
  /** The evidence — a commit, or a pair of them. This is the part that must stay true. */
  reason: string;
}

/** The inputs `releaseHistoryErrors` compares: three views of what was released. */
export interface ReleaseHistoryInput {
  /** Raw tag names, `v` prefix and all, exactly as `git tag` printed them. */
  tags: readonly string[];
  /** The full text of `CHANGELOG.md`. */
  changelog: string;
  /** The `version` field of `package.json`, or a falsy value to skip that check. */
  packageVersion?: string | null;
}

/**
 * Every version the changelog claims to document, plus every level-2 heading it
 * contains that is neither a released version nor a non-release heading.
 *
 * `## [Unreleased]` and prerelease headings (`## [3.0.0-beta.1]`) are ignored
 * rather than reported: a prerelease does not document a release, but flagging
 * one would fail the gate on a shape that is not a defect.
 */
export declare function changelogVersions(source: string): ChangelogVersions;

/** A `v` prefix is stripped; anything that is not `x.y.z` is not a release tag. */
export declare function tagVersions(tags: readonly string[]): Set<string>;

/**
 * Every disagreement between what is tagged, what the changelog documents, and
 * what `package.json` says is current. An empty list means the three agree.
 */
export declare function releaseHistoryErrors(input: ReleaseHistoryInput): string[];

/** The releases the gate explains away, for reporting and for the test. */
export declare function unrecordableReleases(): UnrecordableRelease[];
