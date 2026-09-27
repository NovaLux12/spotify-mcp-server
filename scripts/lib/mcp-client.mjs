// One MCP client for the live harnesses: one handshake, one protocol version,
// one timeout policy, one error-classification rule.
//
// #644: `live-gauntlet.mjs`, `live-e2e.mjs` and `tool-gate-check.mjs` each
// carried their own copy of the JSONL RPC loop — the same buffered stdout
// reader, the same `pending` map, the same `initialize` call — and none of the
// three agreed with the others. The copies had drifted into three timeouts
// (120s / 45s / 30s) and three hard-coded protocol versions. A fix applied to
// one was invisible to the other two, and `grep -rn protocolVersion scripts/`
// answering with three lines was the only way to find that out.
//
// The protocol version is a LOCAL CONSTANT, deliberately. Importing
// `LATEST_PROTOCOL_VERSION` from `@modelcontextprotocol/sdk` would be the
// better engineering in every other repo, and it is wrong here: three existing
// tests (`tests/harness-hermetic-home.test.ts`,
// `tests/gauntlet-mutation-proof.test.ts`) run these harnesses from a bare
// `mkdtemp` copy with no `node_modules` beside them, and a bare specifier
// import there is `ERR_MODULE_NOT_FOUND` — the sandbox is the point. So the
// constant is duplicated on purpose, and `tests/lib-mcp-client.test.ts` is what
// makes the duplication safe: it compares this value against the SDK's, so the
// two things that must agree are compared rather than each being checked.

import { assertPreconditions, guardChild } from './preflight.mjs';
import { spawnHarnessServer } from '../hermetic-home.mjs';

/**
 * The protocol revision these harnesses ask for.
 *
 * Equal to the SDK's `LATEST_PROTOCOL_VERSION`; asserted by
 * `tests/lib-mcp-client.test.ts`, which is what makes this a checked constant
 * rather than a second place to forget. Bumping the SDK bumps the assertion,
 * which fails — which is the intended direction.
 */
export const MCP_PROTOCOL_VERSION = '2025-11-25';

/**
 * How long any single request may take.
 *
 * One number for all three harnesses, where the copies held 120s, 45s and 30s.
 * The value is the one the full-surface sweep needs: a quota-paced run
 * legitimately waits out cascading `Retry-After` windows, and a shorter default
 * would turn those into `timeout: tools/call` rows in a coverage report — a
 * value measured from a deadline, presented as a fact about the tool. The two
 * short-timeout harnesses inherit the long bound as a *slow failure* rather
 * than a fast one; that is the cheaper direction to be wrong in for a
 * diagnostic tool, and a caller that genuinely needs a different bound passes
 * one per call rather than editing a policy three times.
 */
export const RPC_TIMEOUT_MS = 120_000;

/**
 * How much of a JSON-RPC error is kept before it is thrown.
 *
 * Was 400 in `tool-gate-check.mjs`, 300 in `live-gauntlet.mjs` and unbounded in
 * `live-e2e.mjs`. The bound exists so a Spotify error body cannot put a
 * megabyte into a sweep report; a per-harness number means the report's shape
 * depended on which script produced it.
 */
export const ERROR_TEXT_CAP = 400;

/**
 * Snippets meaning "the tool answered, but the endpoint behind it is gated".
 *
 * Moved here because it was byte-identical in `live-gauntlet.mjs:118` and
 * `sweep-finalize.mjs:21` — two copies of the same regex, on two different
 * inputs (the gauntlet tests a successful response's text, the finalizer tests
 * a failure's reason). A drifted copy would have produced a sweep report and a
 * filed-issue count that disagreed about the same run.
 */
const GATE_SNIFF = /forbidden|\b403\b|removed by spotify|not available for this app|app registration/i;

/**
 * Does this text say the endpoint is app-registration-gated (or removed)?
 *
 * @param {unknown} text
 * @returns {boolean} false for anything that is not a string, so a caller
 *   passing a missing field gets "not gated" rather than a thrown TypeError.
 */
export function looksGated(text) {
  return typeof text === 'string' && GATE_SNIFF.test(text);
}

/** Join a tool result's content blocks the way all three harnesses did. */
function textOf(result) {
  return (result?.content ?? []).map((c) => c?.text ?? '').join('\n');
}

/**
 * Boot the real server, complete the handshake, and return a request function.
 *
 * The preconditions run BEFORE the spawn, so a missing build or token is a
 * named cause and an exit 1 rather than a 120-second `timeout: initialize`.
 *
 * @param {object} options
 * @param {string} options.label            Harness name; shows in errors and the sandbox path.
 * @param {string} [options.name]           `clientInfo.name`. Defaults to `label`.
 * @param {string} [options.version]        `clientInfo.version`.
 * @param {string} [options.cwd]            Where `dist/index.js` is resolved from.
 * @param {string[]} [options.args]         Node args. Defaults to the hermetic
 *   `--env-file-if-exists=.env dist/index.js` spawn.
 * @param {string} [options.protocolVersion]
 * @param {number} [options.timeoutMs]      Per-request bound.
 * @param {Record<string, string>} [options.env]  Layered onto the sandbox env.
 * @returns {Promise<{ rpc, callTool, close, child, sandbox, negotiatedVersion }>}
 */
export async function connect({
  label,
  name = label,
  version = '1.0.0',
  cwd,
  protocolVersion = MCP_PROTOCOL_VERSION,
  timeoutMs = RPC_TIMEOUT_MS,
  args,
  env,
} = {}) {
  const root = cwd ?? new URL('../..', import.meta.url).pathname;

  await assertPreconditions({ label, root });

  const { child, sandbox } = await spawnHarnessServer({
    label,
    cwd: root,
    // `-if-exists` rather than `-env-file`. The preflight above has already
    // established that a client id is reachable one way or the other, and the
    // unconditional form aborts node with exit 9 on a missing file BEFORE the
    // server starts — which is the failure this module exists to remove. The
    // flag is the second line of defence, for a caller that reaches
    // `spawnHarnessServer` without preflight.
    args: args ?? ['--env-file-if-exists=.env', 'dist/index.js'],
    env,
  });

  const pending = new Map();
  const timers = new Set();
  let nextId = 1;
  let closed = false;

  const childState = guardChild(child, {
    label,
    onFail: (err) => rejectAll(err),
  });

  function rejectAll(err) {
    for (const [id, entry] of [...pending]) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(err);
    }
  }

  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue; // a banner or a stray write is not a protocol violation
      }
      if (m?.id == null || !pending.has(m.id)) continue;
      const entry = pending.get(m.id);
      pending.delete(m.id);
      clearTimeout(entry.timer);
      timers.delete(entry.timer);
      if (m.error) {
        entry.reject(new Error(JSON.stringify(m.error).slice(0, ERROR_TEXT_CAP)));
      } else {
        entry.resolve(m.result);
      }
    }
  });

  /**
   * One JSONL request. Rejects with `timeout: <method>` on expiry, with the
   * capped JSON-RPC error body on an error response, and with the child's own
   * cause when it dies or cannot start — never with a timeout for a failure
   * that was already known.
   */
  function rpc(method, params, requestTimeoutMs = timeoutMs) {
    if (closed) return Promise.reject(new Error(`${label}: client is closed`));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        timers.delete(timer);
        reject(new Error(`timeout: ${method}`));
      }, requestTimeoutMs);
      timers.add(timer);
      pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        timers.delete(timer);
        // EPIPE: the child is gone. `guardChild` may not have fired yet.
        reject(new Error(`${label}: could not write ${method} — ${err.code ?? err.message}`));
      }
    });
  }

  /** `tools/call`, returning the raw MCP result (content + structuredContent). */
  async function callTool(toolName, args) {
    return rpc('tools/call', { name: toolName, arguments: args });
  }

  const initialized = await rpc('initialize', {
    protocolVersion,
    capabilities: {},
    clientInfo: { name, version },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  return {
    rpc,
    callTool,
    textOf,
    child,
    sandbox,
    /** The revision the server actually negotiated, for a report to name. */
    negotiatedVersion: initialized?.protocolVersion ?? protocolVersion,
    childState,
    close() {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      rejectAll(new Error(`${label}: client closed`));
      if (!childState.failure()) child.kill();
    },
  };
}
