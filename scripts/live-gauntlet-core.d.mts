/**
 * Types for `scripts/live-gauntlet-core.mjs`.
 *
 * **Hand-maintained alongside the `.mjs` it describes — update this file
 * whenever that script's exports change.** A signature that stops matching the
 * implementation is a bug in this file, and the fix is to correct it here, never
 * to widen a caller's cast back to `any`.
 *
 * `tsconfig.tests.json` includes `src` and `tests` but not `scripts`, so this
 * `.mjs` had no declaration and `tests/gauntlet-mutation-proof.test.ts` took
 * TS7016 on its `import * as realCore`. That test then re-declared the module's
 * whole shape as a local `CoreModule` interface and cast through `unknown` —
 * which meant the real module was never checked against it. Naming the exports
 * here puts the module under the compiler; the test's own interface is now a
 * second, independent statement about the same contract rather than the only one.
 *
 * The module's design rule, and the reason several of the shapes below are
 * tagged rather than nullable: a claim is either derived from observed state or
 * it is reported as UNVERIFIED. Silence is never evidence of absence.
 */

/** A tool's classification, plus the evidence for it. */
export type ToolClass = 'MUTATING' | 'SAFE';

/** The four proof statuses. Only `PASS` is a claim. */
export type MutationStatus = 'MUTATIONS_DETECTED' | 'UNVERIFIED' | 'INCOMPLETE' | 'PASS';

/**
 * One `tools/list` row, as far as the classifier reads it.
 *
 * Every field is optional because the classifier is defensive: a row without a
 * name throws, and a row without annotations is classified as a write. The
 * absence of a read-only claim is the load-bearing case, not a malformed one.
 */
export interface RegistryTool {
  name?: string | null;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: unknown } | null;
}

/** The `dry_run`-declaring tools treated as reads anyway, mapped to the evidence. */
export declare const REVIEWED_READS: ReadonlyMap<string, string>;

/**
 * One of the four cheap GETs the fingerprint is built from.
 *
 * `measure` names which reader folds the response: `total` takes the reported
 * count, `id_set_hash` hashes the playlist id set. An id SET, not a contents
 * hash — hashing every playlist's items would mean walking the whole account
 * twice per run, which is the quota wall this script exists to pace around.
 */
export interface AccountProbe {
  /** The fingerprint field this probe fills. */
  field: string;
  /** The tool called to read it. Must itself be classified SAFE. */
  tool: string;
  measure: 'total' | 'id_set_hash';
  args: Readonly<Record<string, unknown>>;
}

export declare const ACCOUNT_PROBES: readonly Readonly<AccountProbe>[];

export declare const MUTATING: 'MUTATING';
export declare const SAFE: 'SAFE';

/** One tool's verdict, plus the evidence that produced it. */
export interface ToolVerdict {
  tool: string;
  class: ToolClass;
  /** The sentence a reader of the report gets as the justification. */
  reason: string;
  /** Which of the four classification branches decided it. */
  source: 'reviewed_read' | 'registry_write' | 'dry_run_capability' | 'registry_read';
  /** Read straight off the annotations the server itself publishes. */
  serverSaysRead: boolean;
  /** Whether the input schema declares a `dry_run` property. */
  declaresDryRun: boolean;
}

/** The escape-hatch override, so a test can drive the classifier with its own list. */
export interface ClassifyOptions {
  /** Defaults to `REVIEWED_READS`. */
  reviewedReads?: ReadonlyMap<string, string>;
}

/** One `tools/call` this run issued against a MUTATING tool. */
export interface GauntletInvocation {
  tool: string;
  /** True only when the call was actually a preview. */
  dry_run?: boolean;
  /** False when the call itself failed. */
  ok?: boolean;
  error?: string;
  /** The response's `structuredContent`, which is the only evidence accepted. */
  structured?: { dry_run?: unknown } | null;
}

/**
 * One row of the cumulative per-tool report.
 *
 * The index signature is honest rather than permissive: the report carries more
 * columns than the proof reads, and this is the row type the driver assembles
 * from a whole sweep.
 */
export interface GauntletRecord {
  tool: string;
  /** The record's own claim that the tool was called without committing. */
  verified_no_mutation?: boolean;
  status?: string;
  reason?: string;
  [column: string]: unknown;
}

/** The account state read before and after a run. */
export interface Fingerprint {
  /** Measured values, keyed by `AccountProbe.field`. A failed probe is absent, never zero. */
  fields: Record<string, number | string>;
  /** Why a field is absent, keyed the same way. */
  unreadable: Record<string, string>;
}

/** One probe response, as folded by `snapshotFromProbeResponses`. */
export interface ProbeResponse {
  probe: Pick<AccountProbe, 'field' | 'tool' | 'measure'>;
  /** False when the call failed; the reason then goes to `unreadable`. */
  ok?: boolean;
  /** The response's structured payload, which the measure reads. */
  structured?: unknown;
  error?: string;
}

/** One field that changed across the run. */
export interface FingerprintChange {
  field: string;
  before: number | string;
  after: number | string;
  /** The tool whose read observed the change — not the tool that caused it. */
  probe: string;
}

/** The comparison of two fingerprints. */
export interface FingerprintDiff {
  changed: FingerprintChange[];
  /** Fields that could not be read on one or both sides. Never compared. */
  unreadable: string[];
  compared: number;
  before: Fingerprint | null;
  after: Fingerprint | null;
}

/** The arg-recipe tables, keyed by table name then by tool name. */
export type RecipeTables = Record<string, Record<string, unknown> | null | undefined>;

/** Recipes naming a tool that no longer registers, and read recipes for writes. */
export interface RecipeAudit {
  /** `TABLE.tool` entries for tools that are not registered — silently skipped, so they read as coverage while exercising nothing. */
  orphans: string[];
  /** `TABLE.tool (CLASS)` entries for read-path recipes the registry now calls writes. */
  unreachable: string[];
}

/** The per-run classification census, and the gate built on it. */
export interface ClassificationAudit {
  total: number;
  mutating: number;
  safe: number;
  dryRunDeclared: number;
  reviewedReads: string[];
  reviewedReadCount: number;
  unannotatedCount: number;
  /** Invariant 1, both halves. */
  dryRunDeclaredButSafe: string[];
  unreviewedDryRunReads: string[];
  /** Invariant 2, both halves. */
  reviewedButNotReadOnly: string[];
  writeClassifiedSafe: string[];
  /** Reported, not gating: a REVIEWED_READS entry for a tool this registry does not register. */
  reviewedNotRegistered: string[];
  /** Writes with no `dry_run`, so this harness can never call them — coverage the report does not claim. */
  uncalledRegistryWrites: string[];
  uncalledRegistryWriteCount: number;
  verdicts: Map<string, ToolVerdict>;
  /** Non-empty fails the run. Every entry is recomputed here, never injected. */
  errors: string[];
  warnings: string[];
}

/** One observed change, with the attribution the diff can honestly support. */
export interface PerformedMutation {
  field: string;
  before: number | string;
  after: number | string;
  /** The tool whose probe observed the change. */
  observed_by: string;
  /** The single unguarded mutating call, or `null` when the change cannot be attributed to one. */
  attributable_to: string | null;
  /** Why the attribution is what it is. */
  attribution_note: string;
}

/** A mutating call the run could not show was a preview. */
export interface UnverifiedInvocation {
  tool: string;
  reason: string;
}

/** A mutating tool recorded without a confirmed dry run. */
export interface UnaccountedTool {
  tool: string;
  status: string;
  reason: string;
}

/** The mutation proof, and everything the report and banner render from it. */
export interface MutationProof {
  status: MutationStatus;
  state_check: 'PERFORMED' | 'NOT_PERFORMED';
  calls_made: number;
  /** The length of the observed diff, always — never a constant. */
  mutations_detected: number;
  /** False when no diff was observed but the run did issue calls. */
  mutations_known: boolean;
  mutations_performed: PerformedMutation[];
  dry_run_verified: string[];
  unverified: UnverifiedInvocation[];
  unaccounted: UnaccountedTool[];
  /** Mutating tools the sweep did not reach. Non-empty forces `INCOMPLETE`. */
  pending: string[];
  fingerprint: {
    compared_fields: number;
    unreadable_fields: string[];
    before: Fingerprint | null;
    after: Fingerprint | null;
  };
}

/** What `computeMutationProof` reads. Every field is optional and defaults to empty. */
export interface MutationProofInput {
  classification?: ReadonlyMap<string, ToolVerdict>;
  records?: readonly GauntletRecord[];
  invocations?: readonly GauntletInvocation[];
  callsMade?: number;
  before?: Fingerprint;
  after?: Fingerprint;
}

/**
 * SKIP reasons that mean "this harness declined to call a MUTATING tool", which
 * is a legitimate, recorded decision. Matched as prefixes so a reason can carry
 * a detail suffix without falling out of the set.
 */
export declare const GATE_SKIP_PREFIXES: readonly string[];

/**
 * Does this input schema declare a `dry_run` property?
 *
 * The capability test, on a schema rather than a whole `tools/list` row, so the
 * driver's own call site reuses it instead of re-deriving the same condition.
 */
export declare function schemaDeclaresDryRun(schema: unknown): boolean;

/** `schemaDeclaresDryRun` for a `tools/list` row. */
export declare function declaresDryRun(tool: RegistryTool | null | undefined): boolean;

/**
 * Classify one registered tool. Fail-closed: anything the registry does not
 * advertise as read-only, and anything that declares a commit path, is
 * `MUTATING`. The only exception is `REVIEWED_READS`, which is audited per entry.
 *
 * Throws when the row has no usable `name`.
 */
export declare function classifyTool(
  tool: RegistryTool | null | undefined,
  options?: ClassifyOptions,
): ToolVerdict;

/** Classify a whole `tools/list` payload, keyed by tool name. */
export declare function classifyRegistry(
  tools: readonly RegistryTool[],
  options?: ClassifyOptions,
): Map<string, ToolVerdict>;

/**
 * The per-run classification census, and the gate built on it.
 *
 * `errors` is what fails the run, and it is recomputed from the tool payloads
 * rather than read from a precomputed verdict, so a change to `classifyTool`
 * that breaks an invariant turns this red.
 */
export declare function auditClassification(
  tools: readonly RegistryTool[],
  options?: ClassifyOptions,
): ClassificationAudit;

/**
 * Audit the arg-recipe tables against the classification.
 *
 * `orphans` name a tool that no longer registers and are silently skipped, so
 * they read as coverage while exercising nothing. `unreachable` are read-path
 * recipes for tools the registry now calls writes.
 */
export declare function auditRecipeTables(
  tools: readonly RegistryTool[],
  verdicts: ReadonlyMap<string, ToolVerdict>,
  recipeTables: RecipeTables,
): RecipeAudit;

/**
 * Fold the probe responses into a fingerprint.
 *
 * A probe that fails, or that answers without the field the fingerprint needs,
 * is recorded in `unreadable` rather than defaulted to 0. Defaulting an
 * unreadable count to zero is the "0 streams" bug from #803 in a new coat, and it
 * would make the diff silently agree with itself.
 */
export declare function snapshotFromProbeResponses(
  responses: readonly ProbeResponse[] | null | undefined,
): Fingerprint;

/**
 * Compare two fingerprints.
 *
 * A field unreadable on either side is reported in `unreadable`, never compared:
 * "we could not check this" is not "this did not change".
 */
export declare function diffFingerprints(
  before: Fingerprint | null | undefined,
  after: Fingerprint | null | undefined,
): FingerprintDiff;

/** Is this SKIP reason one of the gate's own decline reasons? */
export declare function isGateSkip(reason: unknown): boolean;

/**
 * Does this response actually confirm it was a dry run?
 *
 * Structured evidence only: `structuredContent.dry_run === true`. Prose is not
 * accepted — the tool telling the harness what the harness wanted to hear is not
 * a measurement.
 */
export declare function confirmsDryRun(invocation: unknown): boolean;

/** Compute the mutation proof from the classification, the records and the fingerprint. */
export declare function computeMutationProof(input: MutationProofInput): MutationProof;

/** True for every status except the one that is a claim. */
export declare function proofBlocksExit(proof: Pick<MutationProof, 'status'>): boolean;

/** The banner lines. Every number here comes from the proof, never a literal. */
export declare function renderProofLines(proof: MutationProof): string[];

/** The per-run classification census, rendered. */
export declare function renderAuditLines(audit: ClassificationAudit): string[];
