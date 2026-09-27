/**
 * Per-request cancellation context for MCP `tools/call` (#676).
 *
 * The MCP SDK hands every tool handler a second argument, `extra`, whose
 * `signal` is the request's `AbortController` — the one the SDK aborts when a
 * `notifications/cancelled` arrives for that request id, or when the
 * connection drops. Before this module every handler signature in `src/tools`
 * consumed `args` only, so that signal was never read: a cancelled walk kept
 * issuing one request per page until it hit the fetch-all cap, spending the
 * per-account quota the same agent needed for its immediate retry.
 *
 * ## Why ambient rather than a parameter
 *
 * The alternative is threading `signal` through every client method and every
 * handler that starts a walk — roughly 500 call sites across `src/tools`, most
 * of which never mention a signal and would each need a plumbing-only edit.
 * This server already solved the identical problem twice: the progress token
 * (`src/progress.ts`) and the mutation actor (`src/history.ts`) are both carried
 * ambiently through an `AsyncLocalStorage` established at the single
 * tool-invocation boundary. Cancellation follows the same shape, so the
 * boundary is installed once and every existing walk becomes cancellable with
 * no call-site edit.
 *
 * `AsyncLocalStorage` is what makes concurrent calls safe: two overlapping
 * `tools/call`s interleave their awaits on one shared client, and a stored
 * field on the client would answer with whichever finished last. A context
 * store is per-async-context, so each walk sees only its own request's signal.
 *
 * ## Scope
 *
 * This module owns the CONTEXT only. The signal's effect on requests — the
 * fetch, the retry ladder, the page loop — lives in `src/client.ts`, which
 * reads `currentRequestSignal()` as a fallback when a caller passes no
 * explicit `signal`. Keeping the two apart is what lets a client caller pass a
 * signal directly (tests, the auth flow) with no MCP involvement at all.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const requestSignalStorage = new AsyncLocalStorage<AbortSignal>();

/**
 * The abort signal for the `tools/call` currently in flight on this async
 * context, or `undefined` when no request is in flight, the host never supplied
 * one, or the caller passed an explicit signal of its own.
 *
 * `undefined` is the normal, healthy case — a client calling `get()` outside
 * any MCP request has nothing to cancel against, and must behave exactly as it
 * did before this module existed.
 */
export function currentRequestSignal(): AbortSignal | undefined {
  return requestSignalStorage.getStore();
}

/**
 * Run `fn` with `signal` as the ambient cancellation signal for everything it
 * awaits, so a walk started inside it is stopped when the request is cancelled.
 *
 * Passing `undefined` is a no-op wrapper: the function still runs, just with no
 * context, which reads the same as "nothing to cancel against". It is NOT a
 * signal that never fires — an absent context must not turn a cancellation into
 * a silent no-op at the read sites.
 */
export function runInCancellationContext<T>(
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (signal === undefined) return fn();
  return requestSignalStorage.run(signal, fn);
}

/**
 * Install the per-request cancellation context at the tool-invocation boundary.
 *
 * Wraps the SDK's `tool` and `registerTool` so every registered callback runs
 * under the calling request's abort signal, taken from the SDK's `extra`
 * argument (position 1 for a callback that takes `args`, matching the
 * convention `installProgressContextBoundary` and `installTruncationBoundary`
 * already layer on).
 *
 * Mirrors `installProgressContextBoundary` exactly — same last-argument
 * callback convention, same `tool`/`registerTool` pair, same reason for reading
 * `extra` at index 1. Layering it alongside those two is therefore safe: each
 * wrapper only reads `extra` and delegates, so install order does not change
 * what any of them sees.
 */
export function installCancellationContextBoundary(server: McpServer | Server): void {
  const api = server as unknown as {
    tool?: (...args: unknown[]) => unknown;
    registerTool?: (...args: unknown[]) => unknown;
  };

  const wrapRegistration = (
    orig: (...args: unknown[]) => unknown,
  ): ((...args: unknown[]) => unknown) => (...args: unknown[]) => {
    // Callback is the LAST positional arg in `tool(name, ..., cb)` and at index
    // 2 in `registerTool(name, config, cb)` — the convention the progress and
    // truncation boundaries both rely on.
    const callbackIndex = args.length - 1;
    if (typeof args[callbackIndex] === 'function') {
      const cb = args[callbackIndex] as (...cbArgs: unknown[]) => Promise<unknown>;
      args[callbackIndex] = async (...cbArgs: unknown[]) => {
        // The SDK populates `extra.signal` from the per-request
        // AbortController in shared/protocol.js, which `notifications/cancelled`
        // aborts. A tool registered WITHOUT an input schema is called as
        // `cb(extra)`, so the signal is at index 0 there rather than 1.
        const extra = (
          cbArgs.length > 1 ? cbArgs[1] : cbArgs[0]
        ) as { signal?: AbortSignal } | undefined;
        return runInCancellationContext(extra?.signal, () => cb(...cbArgs));
      };
    }
    return orig(...args);
  };

  if (typeof api.tool === 'function') api.tool = wrapRegistration(api.tool.bind(server));
  if (typeof api.registerTool === 'function') {
    api.registerTool = wrapRegistration(api.registerTool.bind(server));
  }
}
