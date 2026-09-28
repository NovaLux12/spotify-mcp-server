/**
 * Types for `scripts/check-no-duplicate-config-accessors.mjs`.
 *
 * **Hand-maintained alongside the `.mjs` it describes — update this file
 * whenever that script's exports change.** A signature that stops matching the
 * implementation is a bug in this file, and the fix is to correct it here, never
 * to widen a caller's cast back to `any`.
 *
 * `tsconfig.tests.json` includes `src` and `tests` but not `scripts`, so this
 * `.mjs` would otherwise have no declaration and the guard test below would take
 * TS7016.
 *
 * The module runs its gate as a side effect of being imported, so the guard test
 * spawns the real CLI rather than calling in. The exports below exist for the
 * parts a test wants to assert about DIRECTLY — the shape rule and the field
 * list — where spawning would measure the CLI's exit code and not the boundary
 * the rule draws. Both are consumed; neither is a second implementation.
 */

/**
 * Every module-scope `getConfig()` re-binding in one source file, as
 * `file:line: text`.
 *
 * Returns `[]` when the file is clean. That empty array is the comparison the
 * gate turns on, so it is computed by the collector rather than injected by a
 * caller — a test that passed `[]` in would be asserting against its own input.
 */
export declare function collectDuplicateConfigAccessorErrors(
  source: string,
  file: string,
): string[];

/**
 * The `file:field` pairs this collector found, for tests that care WHICH setting
 * was re-bound rather than where the finding was printed. Same collector, same
 * pattern — a second implementation here would be a second rule to keep in
 * step with the first.
 */
export declare function collectReboundFields(
  source: string,
  file: string,
): string[];
