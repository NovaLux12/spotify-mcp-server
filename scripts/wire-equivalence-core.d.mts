/**
 * Types for `scripts/wire-equivalence-core.mjs`.
 *
 * The module is plain JavaScript because it is a Node script that runs with no
 * build step, but `tests/wire-equivalence.test.ts` imports it and is
 * typechecked by the ratcheting gate from #1408, which refuses a NEW test file
 * that arrives with type errors. Without this declaration the importer gets
 * TS7016 (a `.mjs` module implicitly types as `any`) plus a cascade of
 * implicit-`any` parameters — the six errors this file removes.
 *
 * It is a declaration of the real exports, not a widening. If a signature here
 * stops matching the implementation, the test fails at the call site rather
 * than quietly degrading to `any`, which is the point of the gate.
 */

/** A `[RegExp, string]` pair, applied in array order. */
export type ValueMask = readonly [RegExp, string];

/**
 * One `tools/call` invocation, as recorded in a snapshot line.
 *
 * `args` and `result` are `unknown` deliberately: they are whatever a tool put
 * on the wire, and the harness must not impose a shape the server does not
 * guarantee. The comparison serializes them rather than reading into them.
 */
export interface WireRecord {
  /** The tool name, exactly as registered. */
  tool: string;
  /** Which argument case produced this result. */
  callCase: string;
  /** The arguments sent, after masking. */
  args: unknown;
  /** The `tools/call` result, after masking. */
  result: unknown;
}

/** A changed invocation, as the report renders it. */
export interface ChangedEntry {
  tool: string;
  callCase: string;
  before: string;
  after: string;
}

/** A one-sided entry: present on only one of the two snapshots. */
export interface OneSidedEntry {
  tool: string;
  callCase: string;
  before?: string;
  after?: string;
}

/** The verdict of comparing two snapshots. */
export interface SnapshotDiff {
  changed: ChangedEntry[];
  added: OneSidedEntry[];
  removed: OneSidedEntry[];
  /** The same set of invocations in a different order — a real difference. */
  reordered: boolean;
  counts: {
    base: number;
    head: number;
    changed: number;
    added: number;
    removed: number;
  };
}

/** The instant every `Date` reads as: 2026-01-02T03:04:05.000Z. */
export declare const FROZEN_NOW_MS: number;

/** The fixed seed for `Math.random`. */
export declare const RANDOM_SEED: number;

/** The per-run value masks, in application order. */
export declare const VALUE_MASKS: readonly ValueMask[];

/** The argument matrix, as case names. */
export declare const CALL_CASES: readonly string[];

/** Apply every mask, in order, to one already-serialized JSON string. */
export declare function maskValues(text: string): string;

/** Build an argument object satisfying a tool's `required` list. */
export declare function synthesizeRequiredArgs(schema: unknown): Record<string, unknown>;

/** Build the argument object for one case of one tool. */
export declare function argsForCase(schema: unknown, callCase: string): Record<string, unknown>;

/** Serialize a record to its one-line snapshot form, masks applied. */
export declare function serializeRecord(record: WireRecord): string;

/** Parse a snapshot back into records. Throws on a malformed line. */
export declare function parseSnapshot(text: string): WireRecord[];

/** Compare two snapshots and describe every difference. */
export declare function compareSnapshots(baseText: string, headText: string): SnapshotDiff;

/** A one-line-per-difference human report. */
export declare function formatDiff(diff: SnapshotDiff, width?: number): string;

/** A deterministic 32-bit FNV-1a digest: 8 lowercase hex characters. */
export declare function digest(text: string): string;
