/**
 * Types for `scripts/registry-schema.mjs`.
 *
 * **Hand-maintained alongside the `.mjs` it describes — update this file
 * whenever that script's exports change.** A signature that stops matching the
 * implementation is a bug in this file, and the fix is to correct it here, never
 * to widen a caller's cast back to `any`.
 *
 * The module is separate from `scripts/check-server-schema.mjs` so a test can
 * drive every branch from a fixture — no network, no subprocess, no `git stash`.
 * It was still undeclared, so `tsconfig.tests.json` reported TS7016 on
 * `tests/server-schema.test.ts` and, because the binding was `any`, the
 * `schema` parameter of `fetchSchema(url, options).then((schema) => …)` had no
 * contextual type. Two errors from one missing file.
 *
 * The three-verdict shape below is the point of the module: `valid` / `invalid`
 * alone makes "the schema host was unreachable" indistinguishable from a clean
 * run, which is how a gate becomes decoration after enough outages.
 */

/**
 * The outcome of a conformance check, in three states rather than two.
 *
 * `unavailable` means *the question was not answered* — the schema could not be
 * fetched or would not compile. It is not `valid`, and it is not a violation:
 * a broken schema is a broken input, and reporting it against the manifest would
 * send a maintainer to edit a file that is not at fault.
 */
export interface ConformanceVerdict {
  status: 'valid' | 'invalid' | 'unavailable';
  /** One readable line per violation; empty for the other two states. */
  violations: string[];
  /** Why the check could not be performed; empty for the other two states. */
  detail: string;
}

/** The parsed inputs `checkManifest` is given, so every branch is fixture-drivable. */
export interface ManifestCheckInput {
  /** A parsed JSON Schema document. */
  schema: unknown;
  /** A parsed `server.json`. */
  manifest: unknown;
}

/** How `fetchSchema` reaches the network, so a test can hand it a planted response. */
export interface FetchSchemaOptions {
  /** Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Defaults to `SCHEMA_FETCH_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * The shape `formatAjvErrors` reads off an ajv error.
 *
 * Every field is optional because the parameter accepts a caller's own value —
 * the test passes `{ instancePath, message, schemaPath }` literally — and
 * `ajv` leaves `instancePath` empty (rather than absent) for a root-level
 * failure.
 */
export interface AjvErrorLike {
  instancePath?: string;
  message?: string;
  schemaPath?: string;
}

/** Bound on the schema fetch so an unreachable host cannot wedge a CI job. */
export declare const SCHEMA_FETCH_TIMEOUT_MS: number;

/**
 * ajv error objects -> one readable line per violation, kept stable enough to
 * assert on.
 *
 * A non-array or empty input yields the single line saying there is no detail,
 * rather than an empty list — a violation report that is empty because the
 * report failed is indistinguishable from a clean run.
 */
export declare function formatAjvErrors(
  errors: readonly AjvErrorLike[] | null | undefined,
): string[];

/**
 * Validate a parsed manifest against a parsed schema.
 *
 * `unavailable` when the schema could not be compiled; `invalid` when it
 * compiled and rejected the manifest; `valid` when it accepted it.
 */
export declare function checkManifest(input: ManifestCheckInput): Promise<ConformanceVerdict>;

/**
 * Fetch the schema a manifest declares.
 *
 * Resolves to the parsed schema document, or throws with a message naming the
 * URL, the elapsed budget and the offline remedy. A body that parses to a
 * non-object is rejected here rather than downstream: `JSON.parse('null')`
 * succeeds, so a `200` with an empty body would otherwise reach `ajv.compile`
 * and be reported as a fault in `server.json`, the one file not at fault.
 */
export declare function fetchSchema(url: string, options?: FetchSchemaOptions): Promise<Record<string, unknown>>;

/**
 * Read and parse a JSON file, with the path in the error so a typo is obvious.
 *
 * `unknown` rather than a shape: this is the boundary where an untrusted file
 * enters, and the caller decides what it is entitled to assume.
 */
export declare function readJson(path: string): Promise<unknown>;
