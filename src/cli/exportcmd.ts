/**
 * `spotify-mcp export` — write a library or playlist export to disk (#606).
 *
 * ## This does not re-implement the exporters, and it cannot widen them
 *
 * `export_library_json` and `export_playlist` each confine a caller-supplied
 * destination to a configured root — `portabilityDir()` for the library,
 * `exportRootDir()` for a playlist — and refuse a path that resolves outside
 * it (`resolveOutputPath`, #622). That confinement is the reason a CLI wrapper
 * here is safe: this command passes `--out` straight through and lets the tool
 * decide, so there is no second path-resolution implementation that could be
 * more permissive than the one the MCP surface uses. A `--out` outside the
 * configured root therefore fails HERE, with the tool's own message, at exit 1.
 *
 * It is also why the help says where the roots are rather than promising a
 * path: `~/.spotify-mcp/portability` and `~/.spotify-mcp/exports` unless
 * `SPOTIFY_MCP_PORTABILITY_DIR` / `SPOTIFY_MCP_EXPORT_DIR` move them.
 *
 * ## The two kinds are not the same shape, and pretending otherwise would lie
 *
 * Issue #606 writes `--kind library|playlists --out <file>`. That maps onto
 * the shipped tools unevenly, so the CLI is explicit about it:
 *
 *   - `--kind library` → `export_library_json`, which writes a **directory** of
 *     sidecar files (or one JSON document), not a single file. `--out` names a
 *     directory.
 *   - `--kind playlist` → `export_playlist`, which exports **one** playlist and
 *     needs its id. There is no tool that exports every playlist, so
 *     `--kind playlists` is refused with that sentence rather than quietly
 *     treated as a singular, which would export a playlist the user did not
 *     name.
 *
 * ## Truncation is reported, never smoothed over
 *
 * Both tools walk with `FETCH_ALL_CAP` and can come back truncated. The CLI
 * passes the result through verbatim and surfaces `truncated` /
 * `fetch_truncated` / `cap_reached` in the JSON output, because an export that
 * silently wrote 500 of 9,000 tracks reads as a complete backup until the day
 * it is needed.
 */

import { CliUsageError, takeValue, usageFailure } from './args.js';
import { decodeToolResult } from './result.js';
import type { CliSession } from './session.js';

export const EXPORT_HELP = `Usage: spotify-mcp export --kind library|playlist [options]

Write an export to disk using the same tools an agent would call, with the same
output-root confinement. The destinations are relative to a configured root
(~/.spotify-mcp/portability for the library, ~/.spotify-mcp/exports for a
playlist unless the matching SPOTIFY_MCP_*_DIR moves it); a path outside that
root is refused by the tool, not by this command.

Options:
  --kind library       Export the saved library (all five collections)
  --kind playlist      Export ONE playlist, named by --playlist
  --out <path>         Destination, relative to the configured output root
  --format <fmt>       library: json (default) or csv
                       playlist: m3u (default) or csv
  --playlist <id>      Required for --kind playlist
  --overwrite          Replace an existing file (refused by default)
  --json               Emit the tool's result as JSON
  --help               Show this message

Exit codes: 0 written, 1 the tool reported a failure, 2 the invocation was
rejected before anything was sent.`;

export type ExportKind = 'library' | 'playlist';

export interface ExportOptions {
  kind: ExportKind;
  out?: string;
  format?: string;
  playlist?: string;
  overwrite: boolean;
  json: boolean;
}

export function parseExportArgs(argv: readonly string[]): ExportOptions {
  const opts: Partial<ExportOptions> = { overwrite: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--overwrite') opts.overwrite = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') throw new CliUsageError('__help__');
    else if (arg === '--kind' || arg.startsWith('--kind=')) {
      const raw = takeValue(argv, i, '--kind');
      if (arg === '--kind') i += 1;
      if (raw === 'playlists') {
        throw new CliUsageError(
          '--kind playlists is not available: no tool exports every playlist. '
          + 'Use --kind playlist --playlist <id> for one, or --kind library for the saved library.',
        );
      }
      if (raw !== 'library' && raw !== 'playlist') {
        throw new CliUsageError(`--kind must be library or playlist, got ${JSON.stringify(raw)}`);
      }
      opts.kind = raw;
    } else if (arg === '--out' || arg.startsWith('--out=')) {
      opts.out = takeValue(argv, i, '--out');
      if (arg === '--out') i += 1;
    } else if (arg === '--format' || arg.startsWith('--format=')) {
      opts.format = takeValue(argv, i, '--format');
      if (arg === '--format') i += 1;
    } else if (arg === '--playlist' || arg.startsWith('--playlist=')) {
      opts.playlist = takeValue(argv, i, '--playlist');
      if (arg === '--playlist') i += 1;
    } else {
      throw new CliUsageError(`unknown argument: ${arg}`);
    }
  }
  if (opts.kind === undefined) throw new CliUsageError('--kind is required (library or playlist)');
  if (opts.kind === 'playlist' && opts.playlist === undefined) {
    throw new CliUsageError('--kind playlist needs --playlist <id>');
  }
  if (opts.kind === 'library' && opts.playlist !== undefined) {
    throw new CliUsageError('--playlist applies to --kind playlist only');
  }
  if (opts.kind === 'library' && opts.format !== undefined && !['json', 'csv'].includes(opts.format)) {
    throw new CliUsageError(`--format for --kind library must be json or csv, got ${JSON.stringify(opts.format)}`);
  }
  if (opts.kind === 'playlist' && opts.format !== undefined && !['m3u', 'csv'].includes(opts.format)) {
    throw new CliUsageError(`--format for --kind playlist must be m3u or csv, got ${JSON.stringify(opts.format)}`);
  }
  return {
    kind: opts.kind,
    out: opts.out,
    format: opts.format,
    playlist: opts.playlist,
    overwrite: opts.overwrite === true,
    json: opts.json === true,
  };
}

/** The tool and the arguments this kind maps onto. Exported for the tests. */
export function exportTarget(opts: ExportOptions): { tool: string; args: Record<string, unknown> } {
  if (opts.kind === 'library') {
    return {
      tool: 'export_library_json',
      // `output_dir` is a DIRECTORY here; naming it `out` in the help is the
      // user-facing word, and this is where the two are reconciled.
      args: {
        ...(opts.out !== undefined ? { output_dir: opts.out } : {}),
        ...(opts.format !== undefined ? { format: opts.format } : {}),
      },
    };
  }
  return {
    tool: 'export_playlist',
    args: {
      playlist_id: opts.playlist as string,
      ...(opts.out !== undefined ? { output_path: opts.out } : {}),
      ...(opts.format !== undefined ? { format: opts.format } : {}),
      ...(opts.overwrite ? { overwrite: true } : {}),
    },
  };
}

export async function runExport(argv: readonly string[], session: CliSession): Promise<number> {
  let opts: ExportOptions;
  try {
    opts = parseExportArgs(argv);
  } catch (err) {
    if ((err as Error).message === '__help__') {
      session.io.write(`${EXPORT_HELP}\n`);
      return 0;
    }
    session.io.write(usageFailure((err as Error).message, EXPORT_HELP));
    return 2;
  }

  const { tool, args } = exportTarget(opts);
  const listed = await session.client.listTools();
  if (!listed.tools.some((t) => t.name === tool)) {
    session.io.write(
      `spotify-mcp: ${tool} is not registered in this installation `
      + `(toolset trimming can remove it — set SPOTIFY_MCP_TOOLSETS to include its module).\n`,
    );
    return 2;
  }

  session.io.write(`spotify-mcp export — calling ${tool}\n`);
  const result = await session.client.callTool({ name: tool, arguments: args });
  const decoded = decodeToolResult(result);
  const structured = decoded.structured;
  const text = decoded.text;

  if (opts.json) {
    session.io.write(`${JSON.stringify({ tool, arguments: args, is_error: decoded.isError, result: structured, text }, null, 2)}\n`);
  } else {
    session.io.write(text.endsWith('\n') ? text : `${text}\n`);
  }

  if (decoded.isError) {
    const envelope = decoded.error;
    session.io.write(
      envelope === null
        ? `\n${tool} failed without an error envelope.\n`
        : `\n${tool} failed: kind=${String(envelope.kind)} reason=${String(envelope.reason)}`
          + `${envelope.status !== undefined ? ` status=${String(envelope.status)}` : ''}\nfix: ${String(envelope.fix)}\n`,
    );
    return 1;
  }

  // A capped walk is not a failure, but it is the difference between a backup
  // and a fragment of one. Say so even on the success path.
  const flags = ['truncated', 'fetch_truncated', 'cap_reached', 'truncated_collections']
    .filter((key) => structured?.[key] === true || (Array.isArray(structured?.[key]) && (structured[key] as unknown[]).length > 0));
  if (flags.length > 0 && !opts.json) {
    session.io.write(
      `\nThis export is TRUNCATED (${flags.join(', ')}). It is not a complete backup — `
      + 'raise SPOTIFY_MCP_FETCH_ALL_CAP and re-run.\n',
    );
  }
  return 0;
}
