/**
 * `spotify-mcp call <tool> [--args '<json>']` — run one tool without a host (#606).
 *
 * ## The whole point is that there is no second call path
 *
 * This command is an MCP client, not a shortcut into the registrars. The
 * arguments are validated by the same zod schema, the same closed-input-schema
 * boundary rejects an unknown key, the same `structuredContent.error` envelope
 * classifies a failure, and the same confirmation gate refuses a destructive
 * write when nobody can be asked. A bug that only a CLI caller could hit would
 * therefore be a bug in the MCP path, which is where it belongs.
 *
 * ## `--dry-run` is a request, not a promise
 *
 * Many tools take a `dry_run` parameter and many cannot. This command does NOT
 * inject `dry_run: true` into a tool that does not declare it and then report
 * success: the pre-handler boundary rejects unknown keys, and if that boundary
 * ever stopped rejecting them, an injected flag on a tool that ignores it would
 * print a full destructive run under a `--dry-run` banner. So `--dry-run`
 * checks the tool's own live `inputSchema` first:
 *
 *   - declares `dry_run` → send `dry_run: true`, and say in the output that
 *     the preview came from the tool's own parameter.
 *   - does not → exit 2, naming the tool, before any request is made. The
 *     message says which read-only tool to use instead where one is obvious.
 *
 * ## Exit codes
 *
 *   0  the tool ran and did not set `isError`
 *   1  the tool ran and returned the error envelope (a refusal, a 403, a
 *      validation failure) — its `kind`/`reason`/`fix` are printed
 *   2  the invocation itself was wrong (bad JSON, unknown tool, bad flag) —
 *      nothing was sent to Spotify
 *
 * 2 and 1 are kept apart because they are different mistakes. "Your arguments
 * are wrong" and "Spotify said no" must not both be a bare 1.
 */

import { CliUsageError, takeValue, usageFailure } from './args.js';
import { decodeToolResult } from './result.js';
import type { CliSession } from './session.js';

export const CALL_HELP = `Usage: spotify-mcp call <tool> [--args '<json>'] [options]

Invoke one registered tool through this server's own MCP path — the same
validation, the same gates and the same error envelope a host gets. Nothing
here adds an API surface the server does not already have.

Arguments:
  <tool>                 Name exactly as \`spotify-mcp tools\` prints it
  --args '<json>'        Object of arguments, as a JSON string (default {})

Options:
  --dry-run              Set the tool's OWN dry_run parameter to true. Fails
                         before any request when the tool has no such
                         parameter, rather than pretending to preview.
  --json                 Emit the raw MCP result as JSON on stdout
  --profile <name>       Act on a named profile (as with \`auth --profile\`)
  --help                 Show this message

Exit codes: 0 success, 1 the tool returned an error envelope, 2 the
invocation was rejected before anything was sent.`;

export interface CallOptions {
  tool: string;
  args: Record<string, unknown>;
  dryRun: boolean;
  json: boolean;
  profile?: string;
}

/**
 * Parse and validate one `call` invocation.
 *
 * Exported and separated from the session so the tests can drive every
 * rejection path — bad JSON, a JSON array where an object belongs, a missing
 * tool name, a value-taking flag with no value — without booting a server.
 * Those are the paths a CLI gets wrong silently, so they are the ones worth
 * testing without the ~2 s a registry boot costs.
 */
export function parseCallArgs(argv: readonly string[]): CallOptions {
  const opts = { tool: undefined as string | undefined, args: undefined as Record<string, unknown> | undefined, dryRun: false, json: false, profile: undefined as string | undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') throw new CliUsageError('__help__');
    else if (arg === '--args' || arg.startsWith('--args=')) {
      const raw = takeValue(argv, i, '--args');
      if (arg === '--args') i += 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        // The parse error is named, not swallowed: "Unexpected token } in JSON"
        // is the difference between a user fixing their quoting and a user
        // filing a bug.
        throw new CliUsageError(`--args is not valid JSON: ${(err as Error).message}`);
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new CliUsageError(`--args must be a JSON object, got ${describeJson(parsed)}`);
      }
      opts.args = parsed as Record<string, unknown>;
    } else if (arg === '--profile' || arg.startsWith('--profile=')) {
      opts.profile = takeValue(argv, i, '--profile');
      if (arg === '--profile') i += 1;
    } else if (arg.startsWith('-')) {
      throw new CliUsageError(`unknown argument: ${arg}`);
    } else if (opts.tool === undefined) {
      opts.tool = arg;
    } else {
      throw new CliUsageError(`unexpected argument: ${arg} (the tool name is the only positional)`);
    }
  }
  if (opts.tool === undefined) throw new CliUsageError('a tool name is required');
  return {
    tool: opts.tool,
    args: opts.args ?? {},
    dryRun: opts.dryRun,
    json: opts.json,
    profile: opts.profile,
  };
}

function describeJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

/** The declared property names of a tool's live `inputSchema`. */
function declaredProperties(schema: unknown): Set<string> {
  if (typeof schema !== 'object' || schema === null) return new Set();
  const properties = (schema as { properties?: unknown }).properties;
  if (typeof properties !== 'object' || properties === null) return new Set();
  return new Set(Object.keys(properties as Record<string, unknown>));
}

export interface CallReport {
  tool: string;
  arguments: Record<string, unknown>;
  is_error: boolean;
  /** The error envelope's `structuredContent.error`, verbatim, or null. */
  error: Record<string, unknown> | null;
  /** Whether `--dry-run` was satisfied by the tool's own parameter. */
  dry_run_applied: boolean;
  content_text: string;
  structured_content: Record<string, unknown> | null;
}

export async function runCall(argv: readonly string[], session: CliSession): Promise<number> {
  let opts: CallOptions;
  try {
    opts = parseCallArgs(argv);
  } catch (err) {
    if ((err as Error).message === '__help__') {
      session.io.write(`${CALL_HELP}\n`);
      return 0;
    }
    session.io.write(usageFailure((err as Error).message, CALL_HELP));
    return 2;
  }

  const { client, io } = session;
  const listed = await client.listTools();
  const tool = listed.tools.find((t) => t.name === opts.tool);
  if (tool === undefined) {
    // A near-miss is the common case (wrong case, singular/plural, a retired
    // name). Offering the closest three names costs one pass and turns "unknown
    // tool" into an answer; without it the user has to go and run `tools`.
    const near = nearest(opts.tool, listed.tools.map((t) => t.name), 3);
    io.write(
      `spotify-mcp: no tool named ${JSON.stringify(opts.tool)} is registered.\n`
      + (near.length > 0
        ? `Did you mean: ${near.join(', ')}?\n`
        : `Run "spotify-mcp tools" for the ${listed.tools.length} tools this installation registers.\n`)
      + `Names come from this installation's gates, so a tool documented elsewhere may not be registered here.\n`,
    );
    return 2;
  }

  const args = { ...opts.args };
  if (opts.dryRun) {
    if (!declaredProperties(tool.inputSchema).has('dry_run')) {
      io.write(
        `spotify-mcp: ${tool.name} has no dry_run parameter, so --dry-run cannot be honoured.\n`
        + `Nothing was sent. For a read-only look at the same data, try "spotify-mcp call ${suggestReadOnly(tool.name)}".\n`,
      );
      return 2;
    }
    args.dry_run = true;
  }

  let result: Awaited<ReturnType<typeof client.callTool>>;
  try {
    result = await client.callTool({ name: opts.tool, arguments: args });
  } catch (err) {
    // A transport/protocol failure rather than a tool result. Still non-zero,
    // and the cause is printed verbatim so a hung registry or a rejected
    // handshake cannot read as "the tool succeeded quietly".
    io.write(`spotify-mcp: ${tool.name} could not be called: ${(err as Error).message}\n`);
    return 1;
  }

  const decoded = decodeToolResult(result);
  const contentText = decoded.text;
  const structured = decoded.structured;
  const errorField = decoded.error;
  const isError = decoded.isError;

  const report: CallReport = {
    tool: opts.tool,
    arguments: args,
    is_error: isError,
    error: errorField,
    dry_run_applied: opts.dryRun && args.dry_run === true,
    content_text: contentText,
    structured_content: structured,
  };

  if (opts.json) {
    io.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    io.write(contentText.endsWith('\n') ? contentText : `${contentText}\n`);
    if (structured !== null) io.write(`\n--- structuredContent ---\n${JSON.stringify(structured, null, 2)}\n`);
  }
  if (isError && errorField !== null) {
    io.write(
      `\n${opts.tool} failed: kind=${String(errorField.kind)} reason=${String(errorField.reason)}`
      + `${errorField.status !== undefined ? ` status=${String(errorField.status)}` : ''}\n`
      + `fix: ${String(errorField.fix)}\n`,
    );
  }
  return isError ? 1 : 0;
}

/** The n names closest to `target`, by shared-prefix length then distance. */
export function nearest(target: string, names: readonly string[], n: number): string[] {
  return names
    .map((name) => ({ name, score: distance(target, name) }))
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, n)
    .map((row) => row.name);
}

function distance(a: string, b: string): number {
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1;
  return (a.length + b.length) - 2 * shared;
}

/** A read-only tool that plausibly previews `name`, or the discovery entry. */
function suggestReadOnly(name: string): string {
  const base = name.replace(/_(plan|preview|draft)$/, '');
  if (base !== name) return base;
  return 'find_tool';
}
