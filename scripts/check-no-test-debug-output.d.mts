/**
 * Types for `scripts/check-no-test-debug-output.mjs`.
 *
 * **Hand-maintained alongside the `.mjs` it describes — update this file
 * whenever that script's exports change.** A signature that stops matching the
 * implementation is a bug in this file, and the fix is to correct it here, never
 * to widen a caller's cast back to `any`.
 *
 * #1408 made this necessary. `tsconfig.tests.json` includes `src` and `tests`
 * but not `scripts`, so this `.mjs` has no declaration and `tsc` reports TS7016
 * on the import in `tests/no-test-debug-output-guard.test.ts`. The binding is
 * then `any`, and `collectDebugOutputErrors(...).map((f) => …)` has no
 * contextual type, so `f` is an implicit-any parameter — two errors from one
 * missing file.
 */

/**
 * Every debug statement in one source file, as `file:line: name — text`.
 *
 * Returns `[]` when the file is clean — that empty array is the comparison the
 * gate turns on, so it is computed by the collector rather than injected by a
 * caller. Entries are sorted by line and flattened to one formatted string each,
 * because the test splits on `:` to assert the line number of every hit.
 */
export declare function collectDebugOutputErrors(source: string, file: string): string[];
