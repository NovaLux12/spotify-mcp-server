/**
 * Types for `scripts/check-no-explicit-any.mjs`.
 *
 * **Hand-maintained alongside the `.mjs` it describes — update this file
 * whenever that script's exports change.** A signature that stops matching the
 * implementation is a bug in this file, and the fix is to correct it here, never
 * to widen a caller's cast back to `any`.
 *
 * #1408 made this necessary. `tsconfig.tests.json` includes `src` and `tests`
 * but not `scripts`, so this `.mjs` has no declaration and `tsc` reports TS7016
 * on the import. The binding is then `any`, and everything derived from it loses
 * its type too — `collectExplicitAnyErrors(...).map((f) => …)` in
 * `tests/explicit-any-guard.test.ts` has no contextual type for `f`, so the
 * implicit-any parameter is the same one error wearing a second hat. Three
 * importers (`explicit-any-guard`, `statsfm-client`, `statsfm-shims`) carried
 * four errors from one missing file.
 *
 * Note that importing this module for its helpers *runs* the gate: the `.mjs`
 * walks `src/tools` and sets `process.exitCode` at module scope. That is why
 * `blankNonCode` is re-exported from here rather than having callers import
 * `blank-non-code.mjs` directly — one module, one side effect, and the test
 * already accepts it.
 */

/** Re-exported verbatim from `./blank-non-code.mjs`; see its own declaration. */
export declare function blankNonCode(source: string): string;

/**
 * Every `as any` in one source file, as `file:line: text`.
 *
 * Returns `[]` when the file is clean — that empty array is the comparison the
 * gate turns on, so it is computed by the collector rather than injected by a
 * caller. Callers split on `:` to reach the line number, which is why each entry
 * is a single formatted string rather than a record.
 */
export declare function collectExplicitAnyErrors(source: string, file: string): string[];
