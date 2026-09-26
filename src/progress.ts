/**
 * Ambient progress-token context for MCP `tools/call` requests (#728).
 *
 * The MCP `notifications/progress` mechanism is opt-in: the caller supplies a
 * `progressToken` in `request.params._meta.progressToken`, and the server
 * echoes it on every progress notification. Servers that invent their own
 * progressToken — or that emit unconditionally — leak frames that
 * line-oriented hosts cannot distinguish from the final JSON-RPC result.
 *
 * The reporter in `index.ts` reads the caller's token from an
 * AsyncLocalStorage populated at the tool-invocation boundary. When the
 * caller did not supply a token, no notification is emitted at all.
 *
 * The boundary wrapper mirrors `installTruncationBoundary`'s registration-
 * time wrapping, so progress context joins the same tool-callback layer as
 * truncation shaping and the actor context. It MUST be installed BEFORE the
 * truncation boundary so the progress-context wrapper ends up outside the
 * truncation wrapper at call time (the truncation shape runs with the
 * progress token in scope, so any long walks it triggers also see the
 * caller's token).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from './client.js';

interface ProgressContext {
  /** Caller-supplied progress token for the current request, if any. */
  progressToken: string | number;
}

const progressContextStorage = new AsyncLocalStorage<ProgressContext>();

/**
 * Caller-supplied progress token for the current async context, if any.
 * Returns `undefined` when no `tools/call` request is in flight, or when the
 * caller did not opt in via `request.params._meta.progressToken`.
 */
export function currentProgressToken(): string | number | undefined {
  return progressContextStorage.getStore()?.progressToken;
}

/**
 * Run `fn` with the caller's progress token in ambient storage so the
 * progress reporter can find it. Passing `undefined` is a no-op: no context
 * is set, which the reporter treats as "do not emit".
 */
export function runInProgressContext<T>(
  token: string | number | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (token === undefined) return fn();
  return progressContextStorage.run({ progressToken: token }, fn);
}

/**
 * Wire `SpotifyClient` long-walk progress events (#65) to MCP progress
 * notifications (#728).
 *
 *   - The reporter only fires when the caller supplied a progressToken in
 *     `request.params._meta.progressToken`; otherwise it stays silent so the
 *     JSON-RPC result is the last frame on the wire for line-oriented hosts.
 *   - When it does fire, it echoes the caller's token rather than inventing
 *     one (the previous behaviour leaked a monotonic walkId that the host
 *     could not bind back to its originating request).
 *   - Notification failures are swallowed: the walk is the source of truth,
 *     and a flaky stream must never break a multi-page fetch.
 */
export function installProgressNotifications(
  client: SpotifyClient,
  server: Server | McpServer,
): void {
  const lowLevel: Server = 'server' in server ? (server as McpServer).server : server;
  client.setProgressReporter((info) => {
    const progressToken = currentProgressToken();
    if (progressToken === undefined) return;
    try {
      void lowLevel
        .notification({
          method: 'notifications/progress',
          params: {
            progressToken,
            progress: info.fetched,
            ...(info.total !== undefined ? { total: info.total } : {}),
          },
        })
        .catch(() => undefined);
    } catch {
      // best-effort only — a flaky stream must never break a walk.
    }
  });
}

/**
 * Install the progress-token ambient context at the tool-invocation boundary.
 * Wraps the SDK's `tool` and `registerTool` so every registered callback
 * runs with the caller's progress token (if any) in the ALS, where the
 * `index.ts` reporter finds it.
 *
 * Must be installed BEFORE the truncation boundary in `src/shaping.ts` so
 * the progress wrapper ends up outside the truncation wrapper at call time.
 */
export function installProgressContextBoundary(server: McpServer): void {
  const api = server as unknown as {
    tool: (...args: unknown[]) => unknown;
    registerTool: (...args: unknown[]) => unknown;
  };

  const wrapRegistration = (
    orig: (...args: unknown[]) => unknown,
  ): ((...args: unknown[]) => unknown) => (...args: unknown[]) => {
    // Callback is the LAST positional arg in `tool(name, ..., cb)` and at
    // index 2 in `registerTool(name, config, cb)` — same convention
    // `installTruncationBoundary` uses, so layering the two wrappers does not
    // desync them.
    const callbackIndex = args.length - 1;
    if (typeof args[callbackIndex] === 'function') {
      const cb = args[callbackIndex] as (
        ...cbArgs: unknown[]
      ) => Promise<unknown>;
      args[callbackIndex] = async (...cbArgs: unknown[]) => {
        // The MCP SDK populates `extra._meta` from `request.params._meta`
        // (shared/protocol.js). The progress token lives there when the
        // caller opted in; absent there, the reporter stays silent.
        const extra = cbArgs[1] as
          | { _meta?: { progressToken?: string | number } }
          | undefined;
        const token = extra?._meta?.progressToken;
        return runInProgressContext(token, () => cb(...cbArgs));
      };
    }
    return orig(...args);
  };

  api.tool = wrapRegistration(api.tool.bind(server));
  api.registerTool = wrapRegistration(api.registerTool.bind(server));
}