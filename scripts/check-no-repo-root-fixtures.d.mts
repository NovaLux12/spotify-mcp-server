/**
 * Types for `scripts/check-no-repo-root-fixtures.mjs`.
 *
 * **Hand-maintained alongside the `.mjs` it describes — update this file
 * whenever that script's exports change.** A signature that stops matching the
 * implementation is a bug in this file, and the fix is to correct it here, never
 * to widen a caller's cast back to `any`.
 *
 * `tsconfig.tests.json` includes `src` and `tests` but not `scripts`, so this
 * `.mjs` had no declaration and `tests/repo-root-fixture-guard.test.ts` took
 * TS7016. Because the binding was `any`, the `hit` parameter of
 * `widened.filter((hit) => …)` had no contextual type and was an implicit
 * `any` — two errors from one missing file.
 *
 * The guard is scoped to `mkdtemp`, not `mkdir`, and that boundary is measured
 * rather than asserted: `widenedMkdirMeasurements` re-runs the collector with the
 * call pattern widened so the test can re-derive the false-positive count on the
 * live tree instead of quoting a figure that rots.
 */

/**
 * One guarded file, as the tree map holds it: repo-relative key, raw source.
 *
 * `code` is RAW, not blanked. The import-specifier resolution reads string
 * literals, and `blankNonCode` erases exactly those.
 */
export interface GuardedSource {
  file: string;
  code: string;
}

/**
 * Every `.ts` under `tests/`, keyed by repo-relative forward-slashed path.
 *
 * Passed by every collector so a file is judged against the real tree: a fixture
 * that imports `HERMETIC_ROOT` has to resolve exactly as the file it stands in
 * for, or a correct call site reads as a finding.
 */
export type GuardedSources = ReadonlyMap<string, GuardedSource>;

/**
 * Every `mkdtemp` in one source file that is not rooted at `tmpdir()`, as
 * `file:line: …` strings. Returns `[]` when the file is clean — that empty array
 * is the comparison the gate turns on, so it is computed by the collector rather
 * than injected by a caller.
 */
export declare function collectRepoRootFixtureErrors(
  source: string,
  file: string,
  sources?: GuardedSources,
): string[];

/**
 * What widening the gate to `mkdir` would cost, as `file:line` strings over the
 * real `tests/` tree. Not a gate — a measurement, consumed by the boundary test.
 *
 * Every entry is a false positive today: the `mkdir` is on a subdirectory of a
 * fixture root, which the guard resolves only for `mkdtemp`.
 */
export declare function widenedMkdirMeasurements(sources: GuardedSources): string[];

/**
 * The same collector, with the call pattern supplied by the caller.
 *
 * Exists so the `mkdir` boundary can be measured rather than asserted in prose.
 * The `pattern` argument is the one thing the declaration cannot narrow: the
 * default is the module-private `MKDEMP_CALL` regular expression, and the widened
 * variant is also module-private. A caller that wants a different pattern supplies
 * its own `RegExp`; the implementation never inspects it.
 */
export declare function collectWithPattern(
  source: string,
  file: string,
  sources?: GuardedSources,
  pattern?: RegExp,
): string[];
