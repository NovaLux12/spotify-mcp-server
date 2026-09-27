/**
 * Types for `scripts/lib/gate-decision.mjs`.
 *
 * Same contract as `scripts/lib/mcp-client.d.mts` — see that file for why a
 * plain-JS module under `scripts/` needs a hand-written sibling. The module
 * comment explains what the classifications are FOR; this file only names them.
 */

/** The four statuses a classified call can carry. */
export type GateStatus = 'PASS' | 'GATED' | 'AUTH' | 'FAIL';

/** One classified call. */
export interface GateRow {
  /** Step or tool name. */
  name: string;
  /** See {@link GateStatus}. */
  status: GateStatus;
  /** The tool's own text, capped. Never empty for a classified result. */
  detail: string;
}

/** The aggregate a harness reports and returns an exit code from. */
export interface GateSummary {
  /** Rows submitted. */
  total: number;
  /** Rows that passed. */
  passed: number;
  /** Rows that failed functionally. */
  failed: number;
  /** Rows that could not authenticate. Excluded from {@link ratio}. */
  auth: number;
  /** Rows whose endpoint is gated or removed. Tested, but excluded from {@link ratio}. */
  gated: number;
  /** Rows the server gave a real verdict on: `total - auth`. */
  tested: number;
  /** `passed + failed` — the rows whose contract is to return data. */
  functional: number;
  /** e.g. `'3/4'`, or `'n/a (every tested tool returned its gated disclosure)'`. */
  ratio: string;
  /** Everything that must produce a non-zero exit. */
  failures: number;
  /** 0 only when every row was tested, none failed, and none needed auth. */
  exitCode: number;
  /** The AUTH instruction, or `''` when there was no AUTH row. */
  authNote: string;
}

/** Statuses that mean "not tested", and so are excluded from the ratio. */
export declare const NON_FUNCTIONAL_STATUSES: readonly GateStatus[];

/** The fix line printed when an AUTH row appears. */
export declare const AUTH_FIX: string;

/** The `STATUS` constants. */
export declare const STATUS: {
  readonly PASS: 'PASS';
  readonly GATED: 'GATED';
  readonly AUTH: 'AUTH';
  readonly FAIL: 'FAIL';
};

/** Classify one `tools/call` result or rejection. */
export declare function classifyToolResult(options?: {
  result?: unknown;
  error?: unknown;
  name?: string;
}): GateRow;

/** Aggregate classified rows into the reported numbers and the exit code. */
export declare function summarizeRun(rows: readonly GateRow[]): GateSummary;

/** The gated tool names, derived from `GATED_FAMILIES`. */
export declare function deriveGatedToolNames(
  families: ReadonlyArray<{ id: string; tools: readonly string[] }>,
): string[];
