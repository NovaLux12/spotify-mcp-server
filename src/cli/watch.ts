/**
 * `spotify-mcp watch` — poll one surface and print only what changed (#606).
 *
 * ## What the ETag story actually is, stated up front
 *
 * Issue #606 asks this command to "poll the watchable resources with
 * ETag/conditional requests". Conditional requests are real and shipped
 * (`src/client.ts` `GetOptions.onNotModified`, `ValidatorStore`, the
 * `If-None-Match` header, the 304-before-`!res.ok` handling, all covered by
 * `tests/conditional.test.ts`) — but **no MCP resource uses them.** Not one of
 * the 17 fixed resources or 28 templates in `src/resources/` passes
 * `onNotModified`, exposes a validator, or emits a list-changed notification.
 * The only two production call sites that do are `get_now_playing` and
 * `get_currently_playing`, and they report the hit as `unchanged: true` in
 * `structuredContent` precisely so "a watch loop can branch" on it.
 *
 * So this command does two different things and says which is which, on every
 * poll:
 *
 *   - a **tool** target that reports `unchanged` gets the real ETag path, and
 *     a 304 costs no Spotify quota and prints nothing;
 *   - a **resource** target has no ETag surface to use, so the loop compares
 *     the payload it got and says `change_detection: "payload-diff"`.
 *
 * It never reports an ETag it did not get. `change_detection` is measured
 * across the polls that ran, not assumed from the target's name, and the three
 * values are `etag` (every poll carried the signal), `mixed` (some did) and
 * `payload-diff` (none did). A command that hard-coded `etag` for a resource
 * URI would be the exact failure AGENTS.md §6 names: a correctly named field
 * lying about its value.
 *
 * ## Printing only changes, without looking like a hang
 *
 * The first poll always prints — it is the baseline the diffs are against, and
 * a loop whose first output is silence has told the user nothing. After that,
 * a poll prints only when the payload differs. `--json` emits one line per
 * poll either way, so a scripted consumer sees every poll and can tell a quiet
 * poll from a dead loop.
 *
 * ## Failures stop the loop
 *
 * The client already retries 429 and 5xx internally with backoff and
 * `Retry-After`, so an error that reaches this loop has survived that. Printing
 * it and polling on would turn one dead token into an unbounded stream of the
 * same line. The first error is printed in full and ends the run with exit 1;
 * `--tolerate-errors` keeps going and is the opt-in for a user who would
 * rather sit through a flaky network.
 */

import { CliUsageError, parsePositiveInt, takeValue, usageFailure } from './args.js';
import { decodeToolResult } from './result.js';
import type { CliSession } from './session.js';

export const WATCH_HELP = `Usage: spotify-mcp watch [options]

Poll one surface and print only what changes. The default target is
get_now_playing, the one tool that revalidates with an ETag and reports a 304
as \`unchanged: true\`.

Options:
  --tool <name>       Poll this tool instead (default get_now_playing)
  --resource <uri>    Poll this spotify:// resource instead of a tool
  --args '<json>'     Arguments for --tool (default {})
  --interval <secs>   Seconds between polls (default 5, minimum 1)
  --count <n>         Stop after n polls (default 0 = run until Ctrl-C)
  --json              Emit one JSON object per poll instead of prose
  --tolerate-errors   Keep polling after an error instead of stopping
  --profile <name>    Act on a named ACCOUNT profile, as with
                       \`auth --profile\`. Read once by the dispatcher and
                       applied to this subcommand's token file
  --help              Show this message

Exit codes: 0 ran to completion, 1 a poll failed.`;

export interface WatchOptions {
  tool?: string;
  resource?: string;
  args: Record<string, unknown>;
  intervalSeconds: number;
  count: number;
  json: boolean;
  tolerateErrors: boolean;
}

export const DEFAULT_WATCH_TOOL = 'get_now_playing';

export function parseWatchArgs(argv: readonly string[]): WatchOptions {
  const opts: WatchOptions = {
    args: {},
    intervalSeconds: 5,
    count: 0,
    json: false,
    tolerateErrors: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--tolerate-errors') opts.tolerateErrors = true;
    else if (arg === '--help' || arg === '-h') throw new CliUsageError('__help__');
    else if (arg === '--tool' || arg.startsWith('--tool=')) {
      opts.tool = takeValue(argv, i, '--tool');
      if (arg === '--tool') i += 1;
    } else if (arg === '--resource' || arg.startsWith('--resource=')) {
      opts.resource = takeValue(argv, i, '--resource');
      if (arg === '--resource') i += 1;
    } else if (arg === '--args' || arg.startsWith('--args=')) {
      const raw = takeValue(argv, i, '--args');
      if (arg === '--args') i += 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new CliUsageError(`--args is not valid JSON: ${(err as Error).message}`);
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new CliUsageError('--args must be a JSON object');
      }
      opts.args = parsed as Record<string, unknown>;
    } else if (arg === '--interval' || arg.startsWith('--interval=')) {
      opts.intervalSeconds = parsePositiveInt(takeValue(argv, i, '--interval'), '--interval');
      if (arg === '--interval') i += 1;
    } else if (arg === '--count' || arg.startsWith('--count=')) {
      const raw = takeValue(argv, i, '--count');
      // 0 is the documented "until Ctrl-C", so this one is a non-negative
      // integer rather than the positive-only rule the interval uses.
      if (!/^\d+$/.test(raw)) throw new CliUsageError(`--count must be a whole number, got ${JSON.stringify(raw)}`);
      opts.count = Number.parseInt(raw, 10);
      if (arg === '--count') i += 1;
    } else {
      throw new CliUsageError(`unknown argument: ${arg}`);
    }
  }
  if (opts.tool !== undefined && opts.resource !== undefined) {
    throw new CliUsageError('--tool and --resource are mutually exclusive; pick one surface to watch');
  }
  return opts;
}

/** How the loop decided a poll had changed. Derived from the polls, not assumed. */
export type ChangeDetection = 'etag' | 'mixed' | 'payload-diff';

export interface WatchPoll {
  poll: number;
  at: string;
  target: string;
  /** The target's own `unchanged` signal, or null when it reports none. */
  unchanged: boolean | null;
  changed: boolean;
  summary: string;
  payload: unknown;
  error?: { message: string; kind?: string; reason?: string; status?: number };
}

function changeDetection(polls: readonly WatchPoll[]): ChangeDetection {
  if (polls.length === 0) return 'payload-diff';
  const signalled = polls.filter((p) => p.unchanged !== null).length;
  if (signalled === polls.length) return 'etag';
  return signalled === 0 ? 'payload-diff' : 'mixed';
}

/** First line of a payload, trimmed to a readable length. Never a fabricated value. */
function summarise(payload: unknown): string {
  if (payload === null || payload === undefined) return '(no payload)';
  if (typeof payload === 'string') return payload.split('\n').filter((l) => l.trim().length > 0)[0] ?? '(empty)';
  if (typeof payload === 'object') {
    const row = payload as Record<string, unknown>;
    for (const key of ['item', 'track', 'now_playing', 'is_playing', 'state']) {
      const value = row[key];
      if (typeof value === 'string' && value.length > 0) return value;
      if (typeof value === 'boolean') return `${key}=${String(value)}`;
    }
  }
  const text = JSON.stringify(payload);
  return text === undefined ? '(unserialisable payload)' : text.slice(0, 160);
}

export interface WatchDeps {
  /** Resolves after the interval, and rejects if the run was interrupted. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => Date;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('interrupted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runWatch(
  argv: readonly string[],
  session: CliSession,
  deps: WatchDeps = {},
): Promise<number> {
  let opts: WatchOptions;
  try {
    opts = parseWatchArgs(argv);
  } catch (err) {
    if ((err as Error).message === '__help__') {
      session.io.write(`${WATCH_HELP}\n`);
      return 0;
    }
    session.io.write(usageFailure((err as Error).message, WATCH_HELP));
    return 2;
  }

  const target = opts.resource ?? opts.tool ?? DEFAULT_WATCH_TOOL;
  const isResource = opts.resource !== undefined;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? ((): Date => new Date());
  const controller = new AbortController();
  const onSignal = (): void => { controller.abort(); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const { client, io } = session;
  const polls: WatchPoll[] = [];
  let previous: string | undefined;
  let failures = 0;

  // The banner is prose, so `--json` does not print it. A consumer piping this
  // into `jq` gets one JSON object per poll and one summary object; a banner
  // line in front of them is a parse error, not a header.
  if (!opts.json) {
    io.write(
      `spotify-mcp watch — ${target} every ${opts.intervalSeconds}s`
      + `${opts.count > 0 ? `, ${opts.count} poll(s)` : ' until interrupted'}\n`,
    );
  }

  try {
    for (let n = 1; opts.count === 0 || n <= opts.count; n += 1) {
      let payload: unknown;
      let unchanged: boolean | null = null;
      let error: WatchPoll['error'];

      try {
        if (isResource) {
          const read = await client.readResource({ uri: target });
          payload = read.contents.map((c) => ('text' in c ? c.text : JSON.stringify(c))).join('\n');
        } else {
          const result = await client.callTool({ name: target, arguments: opts.args });
          const decoded = decodeToolResult(result);
          if (decoded.isError) {
            error = {
              message: decoded.text.trim(),
              kind: typeof decoded.error?.kind === 'string' ? decoded.error.kind : undefined,
              reason: typeof decoded.error?.reason === 'string' ? decoded.error.reason : undefined,
              status: typeof decoded.error?.status === 'number' ? decoded.error.status : undefined,
            };
            payload = undefined;
          } else {
            // `unchanged` is read only when the tool actually sets it. A tool
            // that never sets it leaves this null, which is what moves
            // change_detection to payload-diff rather than a false "unchanged".
            unchanged = typeof decoded.structured?.unchanged === 'boolean' ? decoded.structured.unchanged : null;
            payload = decoded.structured ?? decoded.text;
          }
        }
      } catch (err) {
        error = { message: (err as Error).message };
        payload = undefined;
      }

      const serialised = payload === undefined ? undefined : JSON.stringify(payload) ?? 'null';
      const changed = error === undefined && (previous === undefined || serialised !== previous);
      const poll: WatchPoll = {
        poll: n,
        at: now().toISOString(),
        target,
        unchanged,
        changed,
        summary: error !== undefined ? error.message : summarise(payload),
        payload,
        ...(error !== undefined ? { error } : {}),
      };
      polls.push(poll);

      if (error !== undefined) {
        failures += 1;
        if (opts.json) {
          io.write(`${JSON.stringify(poll)}\n`);
        } else {
          io.write(`[${poll.at}] ${target} — ERROR: ${error.message}\n`);
          if (error.kind !== undefined) {
            io.write(`  kind=${error.kind} reason=${error.reason ?? '(none)'}`
              + `${error.status !== undefined ? ` status=${error.status}` : ''}\n`);
          }
        }
        if (!opts.tolerateErrors) break;
      } else if (changed) {
        if (opts.json) {
          io.write(`${JSON.stringify(poll)}\n`);
        } else {
          io.write(`[${poll.at}] ${target} — ${poll.summary}\n`);
        }
      }
      if (serialised !== undefined) previous = serialised;

      if (opts.count === 0 || n < opts.count) {
        try {
          await sleep(opts.intervalSeconds * 1000, controller.signal);
        } catch {
          break; // Ctrl-C between polls: a clean stop, not a failure.
        }
      }
    }
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  const detection = changeDetection(polls);
  const io2 = session.io;
  if (!opts.json) {
    io2.write(
      `\n${polls.length} poll(s), ${polls.filter((p) => p.changed).length} change(s), `
      + `${failures} error(s); change detection: ${detection}\n`,
    );
    if (detection !== 'etag') {
      io2.write(
        `This target does not report an ETag revalidation, so each poll was a full read compared against the\n`
        + `previous one. get_now_playing and get_currently_playing are the tools that do revalidate.\n`,
      );
    }
  } else {
    io2.write(`${JSON.stringify({ summary: true, polls: polls.length, failures, change_detection: detection })}\n`);
  }
  return failures > 0 ? 1 : 0;
}
