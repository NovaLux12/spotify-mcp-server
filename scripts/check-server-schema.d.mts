/**
 * Types for `scripts/check-server-schema.mjs`.
 *
 * **Hand-maintained alongside the `.mjs` it describes — update this file
 * whenever that script's exports change.** A signature that stops matching the
 * implementation is a bug in this file, and the fix is to correct it here, never
 * to widen a caller's cast back to `any`.
 *
 * `tsconfig.tests.json` includes `src` and `tests` but not `scripts`, so this
 * `.mjs` had no declaration and `tests/server-schema.test.ts` took TS7016. The
 * module body is guarded by an entry-point check, so importing the checker does
 * not run the gate or exit the test process.
 *
 * The I/O lives here; the logic lives in `scripts/registry-schema.mjs`. One
 * implementation between the CLI and the suite is the point — two checkers that
 * can disagree is the failure mode this split exists to prevent.
 */

/** What to check. Both default to the committed files when omitted. */
export interface ServerSchemaCheckOptions {
  /** The manifest to validate. Defaults to `server.json` at the repository root. */
  manifestPath?: string | undefined;
  /** A local copy of the schema, used instead of fetching the `$schema` URL. */
  schemaPath?: string | undefined;
}

/**
 * The gate's verdict, as the CLI consumes it.
 *
 * `ok: false` covers all three ways of not having an answer — no `$schema`
 * declared, the schema unavailable, the manifest invalid — and `message` is the
 * one line the CLI prints before exiting non-zero.
 */
export interface ServerSchemaCheckResult {
  ok: boolean;
  message: string;
}

/**
 * Run the gate once.
 *
 * Exported so a test can call it directly against a planted manifest, and used
 * as the single body of the CLI — there is no second implementation to drift.
 * Rejects if the manifest or the schema file cannot be read or parsed; the CLI
 * turns that into a non-zero exit too, because a gate that cannot read its
 * input has not validated anything.
 */
export declare function runServerSchemaCheck(
  options?: ServerSchemaCheckOptions,
): Promise<ServerSchemaCheckResult>;
