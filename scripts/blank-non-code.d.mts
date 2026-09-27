/**
 * Types for `scripts/blank-non-code.mjs`.
 *
 * #1408 made this necessary, for the same reason as `prose-manifest.d.mts`:
 * `tsconfig.tests.json` includes `src` and `tests` but not `scripts`, so this
 * `.mjs` has no declaration and `tsc` reports TS7016 on the import. The binding
 * is then `any`, and `structuredcontent-boundary.test.ts` inherited that twice
 * over — `blankNonCode(text).split('\n')` is an `any`, so the `line` and `i`
 * parameters of the `.forEach` callback it feeds have no contextual type and
 * become implicit `any`. Two errors, one cause.
 *
 * One export, one signature — this module is small enough that the drift risk
 * the declaration introduces is smaller than the `any` it removes.
 */

/**
 * Blank out everything that is not code, so a comment or a doc string that
 * *talks about* a pattern does not fail a gate, while a real one does.
 *
 * Template-literal `${…}` holes are kept — a statement can live inside one, and
 * blanking them would hide it. The result has every non-code character replaced
 * by a space, so offsets and line numbers still line up with the input; callers
 * rely on that when they report `line: i + 1`.
 */
export function blankNonCode(source: string): string;
