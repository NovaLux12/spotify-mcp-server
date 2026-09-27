/**
 * Failure semantics for the two live gate harnesses (#645).
 *
 * `tool-gate-check.mjs` and `live-e2e.mjs` each used to decide their own
 * verdict, and both decisions were unfalsifiable:
 *
 *   - `tool-gate-check.mjs` printed `!! tool not registered: <name>` and
 *     `[FAIL] <name>` but never counted either, then ended in an unconditional
 *     `process.exit(0)`. A run in which every candidate was missing exited 0.
 *   - `live-e2e.mjs` counted only JSON-RPC rejections as failures, so a token
 *     that had expired — which the server reports as a RESOLVED `isError`
 *     result carrying `structuredContent.error.kind === 'auth'`, not as a
 *     JSON-RPC error — was reported as a pass on every step.
 *
 * Both verdicts are computed HERE, and nothing here performs I/O, so a claim
 * can be evaluated against fixtures instead of a live Spotify account. The
 * drivers own the RPC; this module owns the answers. Same split as
 * `scripts/live-gauntlet-core.mjs` (#643), for the same reason.
 *
 * ## The rule that makes `live-e2e.mjs`'s ratio honest
 *
 * An MCP tool that fails does not reject the `tools/call` request. The server's
 * error boundary (`installToolErrorBoundary` in `src/tools/annotations.ts`)
 * catches the handler's throw and returns a NORMAL result carrying
 * `isError: true` and `structuredContent.error`. A harness that only catches
 * rejections therefore sees a failed tool as a successful call, and an expired
 * token reads as a clean sweep. {@link classifyToolResult} is the correction:
 * it reads `isError` first, and a rejected promise is the fallback, not the
 * primary path.
 */

import { looksGated } from './mcp-client.mjs';

/**
 * How one tool call is classified.
 *
 * - `pass`   — the tool answered, and its answer is not a gated/removed answer.
 * - `gated`  — the tool answered, and the answer discloses that the endpoint is
 *              app-registration-gated or was removed by Spotify. Expected on a
 *              current registration; a FAILURE on a grandfathered one.
 * - `auth`   — the call could not authenticate (401, or a classified auth
 *              error). Says nothing about the tool.
 * - `fail`   — anything else. The only status that is a functional failure.
 *
 * `gated` is deliberately NOT a failure. Per `src/gating.ts`, what a
 * registration may read is the runtime truth, and a 403 on a gated path is the
 * DESIGNED degradation, not a regression — the tools carry a `fallback` field
 * precisely so they keep answering.
 */
export const STATUS = Object.freeze({
  PASS: 'PASS',
  GATED: 'GATED',
  AUTH: 'AUTH',
  FAIL: 'FAIL',
});

/**
 * Statuses that mean "the tool did not get a fair test", so they are excluded
 * from the pass ratio rather than counted against it.
 *
 * `AUTH` is the case the issue names: an expired token made `live-e2e.mjs`
 * report seven of eight functional failures. Counting auth as a functional
 * failure tells the operator to go looking for a server regression that does not
 * exist. `GATED` is here for the same reason and for a stronger one: a 403 on
 * `GET /markets` is the documented contract, and a ratio that counted it as a
 * failure would make a CORRECT server look broken.
 */
export const NON_FUNCTIONAL_STATUSES = Object.freeze([STATUS.AUTH, STATUS.GATED]);

/**
 * Does this text say the failure was an authentication failure?
 *
 * Matched on the SHAPE the server publishes rather than on a status code alone,
 * because the two disagree in a way worth encoding: a dead refresh token comes
 * back as `status: 401` with `reason: 'TOKEN_INVALID_CLIENT'` (the client id is
 * wrong), and a merely expired access token that could not be refreshed comes
 * back with no `status` at all. Both are "run `npm run auth`", and neither is a
 * functional failure. The wire is not reachable from a live run, so the
 * strings are the contract — they are the values `defaultReason('auth')` and the
 * auth classifier in `src/tools/annotations.ts` actually produce.
 */
const AUTH_SNIFF = /\b401\b|authentication|authenticate|not authenticated|token|scope/i;

/**
 * The fix line an AUTH status tells the operator to run.
 *
 * One string, exported, because the classification and the instruction are the
 * same claim: a reader who sees `AUTH` without it has been told a fact and not
 * been told what to do about it.
 */
export const AUTH_FIX = 'run `npm run auth` (or `npm run auth -- --client-id <id>` if the app id is wrong), then re-run this check';

/**
 * Classify one `tools/call` result.
 *
 * @param {object} [options]
 * @param {unknown} [options.result]    The resolved MCP result, if it resolved.
 * @param {unknown} [options.error]     The rejection, if the request rejected.
 * @param {string}  [options.name]      Tool name, for the returned record.
 * @returns {{ name: string, status: string, detail: string }}
 */
export function classifyToolResult({ result, error, name = '' } = {}) {
  // A rejected `tools/call` is a protocol-level or harness-level failure: the
  // server died, the handshake never completed, or the request timed out. None
  // of those are the tool's answer, and none are an auth condition — a dead
  // server produces this on every step at once, which is exactly how a caller
  // tells "the server fell over" from "your token is stale".
  if (error !== undefined && error !== null) {
    return { name, status: STATUS.FAIL, detail: String(error?.message ?? error).slice(0, 200) };
  }

  // The error boundary's shape. Checked FIRST, because a resolved isError
  // result is the common failure path and reading it as a pass is the bug.
  if (result?.isError === true) {
    const err = result?.structuredContent?.error ?? {};
    const kind = typeof err.kind === 'string' ? err.kind : '';
    const reason = typeof err.reason === 'string' ? err.reason : '';
    const status = err.status === undefined ? '' : String(err.status);
    const text = textOf(result);

    // `kind: 'auth'` is the server's own classification, so it is the primary
    // signal; the message sniff is the fallback for a body that carries a 401
    // without the structured kind.
    if (kind === 'auth' || status === '401' || AUTH_SNIFF.test(text)) {
      return { name, status: STATUS.AUTH, detail: text.slice(0, 200) };
    }
    if (kind === 'forbidden' || looksGated(text)) {
      return { name, status: STATUS.GATED, detail: text.slice(0, 200) };
    }
    return { name, status: STATUS.FAIL, detail: text.slice(0, 200) };
  }

  // A successful call whose PROSE discloses a gated surface. A gated tool that
  // degrades by explaining (the `fallback: 'explained'` families) answers 200
  // with the disclosure in the text, so `isError` alone would score the
  // designed behaviour as a clean pass and the broken one as a pass too.
  const text = textOf(result);
  if (looksGated(text)) return { name, status: STATUS.GATED, detail: text.slice(0, 200) };

  return { name, status: STATUS.PASS, detail: text.slice(0, 200) };
}

/** Join a tool result's content blocks into the text a harness would print. */
function textOf(result) {
  return (result?.content ?? []).map((c) => c?.text ?? '').join('\n');
}

/**
 * A run's rows, plus the verdict those rows imply.
 *
 * @typedef {object} GateRow
 * @property {string} name
 * @property {string} status
 * @property {string} detail
 */

/**
 * Aggregate classified rows into the numbers a harness reports and the exit code
 * it returns.
 *
 * ## What counts as tested, and why GATED is one of those things
 *
 * Three numbers, deliberately not the same:
 *
 *   - `tested` — rows the server gave a REAL verdict on. A row is tested when it
 *     came back PASS, GATED or FAIL: in all three the harness asked a question
 *     of the tool and the tool answered in its own voice. AUTH is the only
 *     status that means the question never got asked.
 *   - `functional` — the subset of tested rows whose contract is to return DATA,
 *     i.e. `passed + failed`. This is the pass ratio's denominator.
 *   - `auth` — the rows whose token was dead. Never tested, and always fatal.
 *
 * GATED is in `tested` and out of `functional`, and that split is the whole
 * design. On a CURRENT app registration every one of the gated tools is
 * supposed to answer with the gating disclosure, so a correctly-functioning
 * server produces an all-GATED run — and if GATED rows counted as untested, that
 * run would exit 1 forever. A gate that is red on correct behaviour is a gate
 * nobody runs, which is how the original unconditional `exit(0)` looked
 * reasonable in the first place. So a GATED row is a SATISFIED row: the tool
 * did what `src/gating.ts` says it does when the registration may not read the
 * path.
 *
 * ## Why the exit code is not `failed === 0`
 *
 * The issue requires the script to keep gating when AUTH appears, and the two
 * requirements only look like they are in tension. They are not, because they
 * are different claims:
 *
 *   - the PASS RATIO is a statement about the TOOLS, so AUTH is excluded from
 *     its denominator and an expired token cannot manufacture a functional
 *     regression;
 *   - the EXIT CODE is a statement about the RUN, and a run in which NOTHING was
 *     tested is not a pass. Zero tested rows is not evidence of health, and
 *     exiting 0 there is how "green means ran" started.
 *
 * @param {GateRow[]} rows
 * @returns {{
 *   total: number, passed: number, failed: number, auth: number, gated: number,
 *   tested: number, functional: number, ratio: string, failures: number,
 *   exitCode: number, authNote: string,
 * }}
 */
export function summarizeRun(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const count = (s) => list.filter((r) => r.status === s).length;

  const passed = count(STATUS.PASS);
  const failed = count(STATUS.FAIL);
  const auth = count(STATUS.AUTH);
  const gated = count(STATUS.GATED);

  // A GATED row was tested — the tool answered, in its own voice, and the
  // answer is the documented degradation. Only AUTH means the question was
  // never put to the tool.
  const tested = list.length - auth;
  // The ratio's denominator is the rows whose contract is to return data.
  const functional = passed + failed;
  const ratio =
    functional === 0
      ? gated > 0
        ? 'n/a (every tested tool returned its gated disclosure)'
        : 'n/a (no tool was exercised)'
      : `${passed}/${functional}`;

  return {
    total: list.length,
    passed,
    failed,
    auth,
    gated,
    tested,
    functional,
    ratio,
    // Never-tested rows are AUTH, and AUTH always gates.
    failures: failed + auth,
    exitCode: failed > 0 || auth > 0 || tested === 0 ? 1 : 0,
    authNote: auth > 0 ? `AUTH — ${AUTH_FIX}` : '',
  };
}

/**
 * The gated families a live run should probe, derived from the registry.
 *
 * ## Why this is derived rather than a hand-kept list (#645)
 *
 * The 8-name candidate list this replaces had drifted past the point of being
 * a list of anything: two of its names (`are_you_following_artist`,
 * `get_categories`) name tools that do not exist in the server at all, and two
 * of its survivors (`get_available_markets`, `get_artist_top_tracks`) are not
 * registered under the DEFAULT toolset — so on a default run the script warned
 * about two tools it could never have called, and the warning was a constant.
 *
 * The truth lives in `GATED_FAMILIES` (`src/gating.ts`), which is already the
 * single source the README table, the #330 gauntlet SKIP set and the surface
 * census all read. Deriving from it means a family that gains a tool, or a tool
 * that is deleted, changes this list with no edit here.
 *
 * The list is the union of `family.tools` over families that still have a live
 * call site, because a family with `tools: []` is a retained CLASSIFIER for a
 * path nothing reads any more — there is nothing to probe.
 *
 * @param {ReadonlyArray<{id: string, tools: readonly string[]}>} families
 * @returns {string[]} sorted, de-duplicated tool names
 */
export function deriveGatedToolNames(families) {
  return [
    ...new Set(
      (families ?? [])
        .filter((f) => Array.isArray(f.tools) && f.tools.length > 0)
        .flatMap((f) => f.tools),
    ),
  ].sort();
}
