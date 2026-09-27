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

import type { CliSession } from './session.js';

export interface CliDispatch {
  /** The subcommand that was routed, for the caller's own reporting. */
  readonly name: string;
  readonly code: number;
}

/**
 * Route one #606 subcommand. `argv` is everything after the subcommand name.
 *
 * `init` is recognised here and handed its own runner; the caller (`src/index.ts`)
 * keeps the dispatch chain readable by asking this function first rather than
 * growing an `else if` per subcommand in the entry point.
 */
export async function dispatchCliSubcommand(name: string, argv: readonly string[]): Promise<CliDispatch> {
  if (name === 'init') {
    const { runInit } = await import('./init.js');
    return { name, code: await runInit(argv) };
  }

  if (name !== 'tools' && name !== 'call' && name !== 'watch' && name !== 'export') {
    throw new Error(`dispatchCliSubcommand was called with an unhandled subcommand: ${name}`);
  }

  const { openCliSession } = await import('./session.js');
  const session: CliSession = await openCliSession();
  try {
    if (name === 'tools') {
      const { runTools } = await import('./tools.js');
      return { name, code: await runTools(argv, session) };
    }
    if (name === 'call') {
      const { runCall } = await import('./call.js');
      return { name, code: await runCall(argv, session) };
    }
    if (name === 'watch') {
      const { runWatch } = await import('./watch.js');
      return { name, code: await runWatch(argv, session) };
    }
    const { runExport } = await import('./exportcmd.js');
    return { name, code: await runExport(argv, session) };
  } finally {
    await session.close();
  }
}

/** The names this dispatcher claims, for the entry point's routing and its help. */
export const CLI_SUBCOMMANDS = ['tools', 'call', 'watch', 'export', 'init'] as const;

/** True when `argv[0]` is a #606 subcommand. Used to pick the branch cheaply. */
export function isCliSubcommand(argv0: string | undefined): boolean {
  return argv0 !== undefined && (CLI_SUBCOMMANDS as readonly string[]).includes(argv0);
}
