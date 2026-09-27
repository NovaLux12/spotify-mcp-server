/**
 * The argument vocabulary every `spotify-mcp` subcommand shares (#606).
 *
 * ## Why a shared parser and not five copies
 *
 * `logout` established the house rule (`src/logout.ts:parseLogoutArgs`): an
 * unrecognised flag is an error, not a no-op, because a silently ignored
 * `--dry-run` looks like a command that honoured it. Four subcommands with the
 * same `--json` flag are four places for that rule to be spelled slightly
 * differently, and a typo that becomes "unknown flag" in one and "no flag" in
 * another is a behaviour difference nobody wrote down. So the flag-reading
 * primitives live here once and each subcommand composes them.
 *
 * ## The two-value rule
 *
 * A flag that takes a value accepts `--flag value` and `--flag=value`, and
 * refuses a missing value. It refuses `--flag --other` specifically: reading
 * `--other` as the value would produce a command that ran with a flag named
 * `--other` as its subject, and the failure would surface as a confusing
 * downstream error rather than as the usage mistake it is. `logout` already
 * draws this line for `--profile`; this is the same rule generalised.
 */

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

/** Read the value of `--name value` / `--name=value` at `i`, advancing past it. */
export function takeValue(argv: readonly string[], i: number, name: string): string {
  const arg = argv[i];
  const eq = arg.indexOf('=');
  if (eq !== -1) {
    const inline = arg.slice(eq + 1);
    if (inline.length === 0) throw new CliUsageError(`${name} requires a value`);
    return inline;
  }
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) {
    throw new CliUsageError(`${name} requires a value`);
  }
  return next;
}

/**
 * Parse a positive integer flag, or throw.
 *
 * `Number.parseInt` alone would accept `'12abc'` as 12 and `Number()` alone
 * would accept `'1e3'` and `' 12 '`. An interval that silently becomes 1000 ms
 * because the user typed `1e3` is exactly the kind of quiet reinterpretation
 * that makes a watch loop look broken, so the string has to be digits.
 */
export function parsePositiveInt(raw: string, name: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new CliUsageError(`${name} must be a whole number of ${name === '--interval' ? 'seconds' : 'items'}, got ${JSON.stringify(raw)}`);
  }
  const value = Number.parseInt(raw, 10);
  if (value < 1) throw new CliUsageError(`${name} must be at least 1, got ${value}`);
  return value;
}

/** Positional arguments: everything that is not a `--flag` or a flag's value. */
export function positionals(argv: readonly string[]): { words: string[]; unknown: string[] } {
  const words: string[] = [];
  const unknown: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('-')) {
      words.push(arg);
      continue;
    }
    if (arg.startsWith('--') && !arg.includes('=') && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
      i += 1; // the next token is this flag's value
    }
    unknown.push(arg);
  }
  return { words, unknown };
}

/** The usage line a subcommand prints on a bad flag, followed by its help. */
export function usageFailure(message: string, help: string): string {
  return `spotify-mcp: ${message}\n\n${help}`;
}
