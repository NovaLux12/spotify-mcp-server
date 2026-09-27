/**
 * Types for `scripts/check-tests-typecheck.mjs`.
 *
 * **Hand-maintained alongside the `.mjs` it describes — update this file
 * whenever that script's exports change.** A signature that stops matching the
 * implementation is a bug in this file, and the fix is to correct it here, never
 * to widen a caller's cast back to `any`.
 *
 * `tsconfig.tests.json` includes `src` and `tests` but not `scripts`, so this
 * `.mjs` had no declaration and `tests/tests-typecheck-budget-gate.test.ts` took
 * TS7016 — inside the very gate whose subject is untyped test imports. Naming
 * the one exported function fixes it without editing that test.
 *
 * Note the module body is not guarded by an entry-point check: importing it runs
 * a full `tsc` and can `process.exit`. That is existing behaviour and is left
 * exactly as it is; this declaration says nothing about it and changes nothing
 * about it.
 */

/**
 * `tsc` output parsed into one record per diagnostic.
 *
 * `byFile` is a `Map`, not an object, so two diagnostics for the same file
 * accumulate rather than overwrite. It is compared per file as well as in total
 * so the count cannot be held flat by fixing one file and breaking another.
 */
export interface ParsedDiagnostics {
  /** Every counted diagnostic, run-level failures excluded. */
  total: number;
  /** Per-file diagnostic counts, keyed by the path `tsc` printed. */
  byFile: Map<string, number>;
  /**
   * Run-level failures — `error TS5058: The specified path does not exist`, and
   * anything else printed without a `file(line,col):` prefix.
   *
   * These carry no file, so a parser that only matched diagnostics would report
   * zero errors for a run that never typechecked anything. Any non-empty value
   * means the run is not a measurement and the caller must fail closed.
   */
  globalErrors: string[];
}

/**
 * Parse `tsc` output into one record per diagnostic.
 *
 * Multi-line diagnostics (TS2339 and friends print a follow-up
 * `  Property … does not exist` line) are continued rather than counted twice,
 * which is why the anchor requires the `file(line,col): error TSxxxx:` prefix
 * rather than a looser `error TS`. A trailing `Found N errors in M files.`
 * summary is not a diagnostic and is ignored.
 */
export declare function parseDiagnostics(output: string): ParsedDiagnostics;
