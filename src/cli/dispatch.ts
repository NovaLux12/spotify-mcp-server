/**
 * The dispatcher for the `spotify-mcp` subcommands added in #606.
 *
 * ## Why `init` is dispatched separately from the other four
 *
 * `tools`, `call`, `watch` and `export` all need a live registry, so they open
 * one `CliSession` and share it. `init` needs no registry at all — it writes a
 * file and optionally starts a child — and opening a full registry boot to do
 * that would make the fastest command the slowest and would register 500+ tools
 * to answer a question about a config file. Splitting it here keeps the
 * session cost where the session is.
 *
 * ## Exit codes, once
 *
 * 0 success · 1 the work ran and failed · 2 the invocation was wrong and
 * nothing was sent. Every subcommand returns one of these three and this
 * function is the only place they become `process.exitCode`.
 */

import { getTokenFile } from '../auth.js';
import { takeProfileFlag, usageFailure } from './args.js';
import type { CliSession, CliSessionOptions } from './session.js';

export interface CliDispatch {
  /** The subcommand that was routed, for the caller's own reporting. */
  readonly name: string;
  readonly code: number;
}

/**
 * The one seam tests replace, and the only one.
 *
 * `--profile` is turned into a token file here and nowhere else, and the value
 * it produced used to leave no trace a test could read: the session is closed
 * again before this function returns, so a test that only watched the exit code
 * would pass whether the flag was wired to the client or dropped on the floor.
 * `openSession` is the seam that makes the handoff observable, and it is
 * deliberately narrow — everything else about the dispatch, including which
 * subcommand ran and with what argv, is still the real code.
 */
export interface CliDispatchDeps {
  readonly openSession?: (options: CliSessionOptions) => Promise<CliSession>;
}

/**
 * Route one #606 subcommand. `argv` is everything after the subcommand name.
 *
 * `init` is recognised here and handed its own runner; the caller (`src/index.ts`)
 * keeps the dispatch chain readable by asking this function first rather than
 * growing an `else if` per subcommand in the entry point.
 */
export async function dispatchCliSubcommand(
  name: string,
  argv: readonly string[],
  deps: CliDispatchDeps = {},
): Promise<CliDispatch> {
  if (name === 'init') {
    const { runInit } = await import('./init.js');
    return { name, code: await runInit(argv) };
  }

  const sessionCommand = name as 'tools' | 'call' | 'watch' | 'export';
  if (name !== 'tools' && name !== 'call' && name !== 'watch' && name !== 'export') {
    throw new Error(`dispatchCliSubcommand was called with an unhandled subcommand: ${name}`);
  }

  // `--profile` is lifted here, once, for all four: it names the account, not
  // the operation, and the only thing it means is which token file the client
  // loads. `getTokenFile` owns the documented precedence
  // (SPOTIFY_MCP_TOKEN_FILE > --profile > SPOTIFY_MCP_PROFILE > default), so
  // the dispatcher asks it rather than assembling a path. See `takeProfileFlag`
  // for why this is not left in argv for the runner to ignore.
  let rest: readonly string[];
  let sessionOptions: { tokenFile?: string } = {};
  try {
    const { profile, rest: withoutProfile } = takeProfileFlag(argv);
    rest = withoutProfile;
    if (profile !== undefined) sessionOptions = { tokenFile: getTokenFile(profile, process.env) };
  } catch (err) {
    // A profile name the server's own validator rejects is a bad invocation,
    // not a crash: exit 2, with the message `spotify-mcp auth` would give.
    //
    // On stdout, through the same `usageFailure` every runner uses, rather than
    // on stderr: a rejected invocation is part of this command's answer, and a
    // message on the other stream is one a `$(...)` caller never sees. It also
    // means this refusal is refused BEFORE the ~2 s registry boot, which is the
    // only reason to check it here rather than letting the session resolve it.
    process.stdout.write(`${usageFailure((err as Error).message, await helpFor(sessionCommand))}\n`);
    return { name, code: 2 };
  }

  const { openCliSession } = await import('./session.js');
  const session: CliSession = await (deps.openSession ?? openCliSession)(sessionOptions);
  try {
    if (name === 'tools') {
      const { runTools } = await import('./tools.js');
      return { name, code: await runTools(rest, session) };
    }
    if (name === 'call') {
      const { runCall } = await import('./call.js');
      return { name, code: await runCall(rest, session) };
    }
    if (name === 'watch') {
      const { runWatch } = await import('./watch.js');
      return { name, code: await runWatch(rest, session) };
    }
    const { runExport } = await import('./exportcmd.js');
    return { name, code: await runExport(rest, session) };
  } finally {
    await session.close();
  }
}

/**
 * The usage text of one session subcommand, for a refusal printed before the
 * session exists.
 *
 * A dynamic import for the same reason the runners are: nothing here should be
 * evaluated by a launch that is not the one being refused. The `name` is
 * narrowed by the guard above before it can be called with anything else.
 */
async function helpFor(name: 'tools' | 'call' | 'watch' | 'export'): Promise<string> {
  if (name === 'tools') return (await import('./tools.js')).TOOLS_HELP;
  if (name === 'call') return (await import('./call.js')).CALL_HELP;
  if (name === 'watch') return (await import('./watch.js')).WATCH_HELP;
  return (await import('./exportcmd.js')).EXPORT_HELP;
}

/** The names this dispatcher claims, for the entry point's routing and its help. */
export const CLI_SUBCOMMANDS = ['tools', 'call', 'watch', 'export', 'init'] as const;

/** True when `argv[0]` is a #606 subcommand. Used to pick the branch cheaply. */
export function isCliSubcommand(argv0: string | undefined): boolean {
  return argv0 !== undefined && (CLI_SUBCOMMANDS as readonly string[]).includes(argv0);
}
