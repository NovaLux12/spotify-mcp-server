/**
 * `spotify-mcp tools` — print the surface this installation actually registers (#606).
 *
 * ## What "actually" costs here, and why it is worth it
 *
 * The tool list is not a constant in this repository. It is the product of the
 * toolset resolution (`SPOTIFY_MCP_TOOLSETS`), the per-key opt-in/opt-out, the
 * read-only gate, the granted-scope filter, the stats.fm opt-in and the derived
 * analytics opt-in — and a list printed from a table would be wrong for every
 * user whose environment differs from the author's. So the names come from
 * `tools/list` on a real session (`src/cli/session.ts`), which is also what
 * makes #606's acceptance criterion — "same names, same count" — true by
 * construction rather than by a test that has to be re-run after every release.
 *
 * ## Where the per-tool facts come from, and what "not declared" means
 *
 * Each row carries four things, and each is read from a *different* place on
 * purpose:
 *
 *   - `read_only` / `destructive` / `idempotent` — the tool's own `annotations`
 *     on the wire. This is what a host sees, so it is what a user comparing
 *     the CLI against their host should see.
 *   - `module` / `registration_key` — from `moduleToolNames` over
 *     `REGISTRAR_MANIFEST` in `src/tools/annotations.ts`. It is NOT on the
 *     wire, and inventing a wire field to carry it would be a payload every
 *     host pays for on every session. The map is read off the same server
 *     object the wire came from, so it cannot disagree with it.
 *   - `quota` — the `Quota: …` clause some descriptions carry, extracted from
 *     the LIVE description text. A tool whose description declares no quota
 *     sentence reports `null`, and the JSON says `null`. It does not report
 *     `"none"`, `""` or `0`, because "this description declares no quota" and
 *     "this tool makes no quota'd calls" are different claims and only the
 *     first one is knowable from the description. `notes` carries the same
 *     fact in prose so the text output is not the only place it appears.
 *   - `gated` — why a name in the manifest is absent from this registration.
 *     Read from `collectModuleSchemaBudgets`, which is the same table
 *     `spotify_doctor` and `toolset_report` read.
 *
 * ## A tool in the manifest that no module registered
 *
 * `attribution` is built from the manifest and then indexed by the names that
 * actually registered. A registered name with no manifest owner is reported as
 * `module: null` with an explicit `notes` entry rather than dropped: a tool
 * that appeared in `tools/list` with no owner would be invisible here, and an
 * invisible tool is the failure this command exists to make visible.
 */

import { REGISTRAR_MANIFEST, collectModuleSchemaBudgets, moduleToolNames } from '../tools/annotations.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CliUsageError, takeValue, usageFailure } from './args.js';
import type { CliSession } from './session.js';

export const TOOLS_HELP = `Usage: spotify-mcp tools [options]

Print the tool surface this installation registers right now — after the
toolset, read-only, granted-scope and opt-in gates, so it matches what a host
connecting with the same environment would receive.

Options:
  --json           Emit the surface as JSON on stdout
  --filter <text>  Only tools whose name contains <text> (case-insensitive)
  --module <key>   Only tools registered by one manifest module
  --help           Show this message`;

export interface ToolsOptions {
  json: boolean;
  filter?: string;
  module?: string;
}

/** An unrecognised flag is an error, matching every other subcommand. */
export function parseToolsArgs(argv: readonly string[]): ToolsOptions {
  const opts: ToolsOptions = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') throw new CliUsageError('__help__');
    else if (arg === '--filter' || arg.startsWith('--filter=')) {
      opts.filter = takeValue(argv, i, '--filter');
      if (arg === '--filter') i += 1;
    } else if (arg === '--module' || arg.startsWith('--module=')) {
      opts.module = takeValue(argv, i, '--module');
      if (arg === '--module') i += 1;
    } else {
      throw new CliUsageError(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

/**
 * The `Quota: …` sentence a description declares, or `null`.
 *
 * Returns `null` rather than an empty string for a description that declares
 * none. An empty string would render identically to a quota sentence that was
 * found and happened to be blank, and would be indistinguishable from "we did
 * not look" in a JSON document.
 */
export function quotaMarker(description: string | undefined): string | null {
  if (typeof description !== 'string') return null;
  const at = description.lastIndexOf('Quota:');
  if (at === -1) return null;
  const tail = description.slice(at + 'Quota:'.length).trim();
  // Descriptions put the clause last, but not always terminated by a full stop.
  // Stop at the first sentence end; take the whole tail when there is none.
  const stop = tail.search(/[.;]\s/);
  // The trailing full stop goes with the sentence, not with the clause: a
  // clause at the very end of a description has no `. ` to stop at, so without
  // this the same quota sentence would read `2 reads` in one description and
  // `2 reads.` in another.
  const clause = (stop === -1 ? tail : tail.slice(0, stop)).trim().replace(/[.;]$/, '');
  return clause.length > 0 ? clause : null;
}

export interface ToolRow {
  name: string;
  module: string | null;
  registration_key: string | null;
  read_only: boolean;
  destructive: boolean;
  idempotent: boolean;
  /** The description's own `Quota:` clause, or `null` when it declares none. */
  quota: string | null;
  notes: string[];
}

/** Tool name -> manifest module, read off the same server the wire came from. */
export function moduleAttribution(server: McpServer): Map<string, { module: string; registrationKey: string }> {
  const byKey = new Map(REGISTRAR_MANIFEST.map((m) => [m.key, m.registrationKey] as const));
  const out = new Map<string, { module: string; registrationKey: string }>();
  for (const entry of REGISTRAR_MANIFEST) {
    for (const name of moduleToolNames(server, entry.key)) {
      out.set(name, { module: entry.key, registrationKey: byKey.get(entry.key) ?? entry.registrationKey });
    }
  }
  return out;
}

export interface ToolsReport {
  registered: number;
  matching: number;
  toolsets: string[];
  read_only_mode: boolean;
  hidden_modules: Array<{ module: string; status: string }>;
  tools: ToolRow[];
}

/**
 * Build the report. Split from rendering so the tests can assert the DATA,
 * which is the part the acceptance criterion is about, without matching prose.
 */
export async function collectToolsReport(
  session: CliSession,
  opts: ToolsOptions,
): Promise<ToolsReport> {
  const { client, server } = session;
  const listed = await client.listTools();
  // The wire is the source of truth for the COUNT too. `tools/list` may page in
  // a future SDK; the count below is the number of rows actually returned, not
  // an assumed 556 and not a manifest length.
  const attribution = moduleAttribution(server);
  const budgetRows = collectModuleSchemaBudgets(server);
  const hidden = budgetRows
    .filter((row) => row.status !== 'active')
    .map((row) => ({ module: row.module, status: row.status }));

  const activeSets = new Set<string>();
  for (const row of budgetRows) {
    if (row.status === 'active') activeSets.add(row.registrationKey);
  }

  const needle = opts.filter?.toLowerCase();
  const rows: ToolRow[] = [];
  for (const tool of listed.tools) {
    if (needle !== undefined && !tool.name.toLowerCase().includes(needle)) continue;
    if (opts.module !== undefined && attribution.get(tool.name)?.module !== opts.module) continue;
    const owner = attribution.get(tool.name);
    const notes: string[] = [];
    if (owner === undefined) {
      // Named rather than dropped: see the header.
      notes.push('registered with no manifest module owner');
    }
    const quota = quotaMarker(tool.description);
    if (quota === null) notes.push('description declares no Quota: clause');
    rows.push({
      name: tool.name,
      module: owner?.module ?? null,
      registration_key: owner?.registrationKey ?? null,
      read_only: tool.annotations?.readOnlyHint === true,
      destructive: tool.annotations?.destructiveHint === true,
      idempotent: tool.annotations?.idempotentHint === true,
      quota,
      notes,
    });
  }

  return {
    registered: listed.tools.length,
    matching: rows.length,
    toolsets: [...activeSets].sort(),
    read_only_mode: hidden.some((h) => h.status === 'read_only_hidden'),
    hidden_modules: hidden,
    tools: rows,
  };
}

function marker(row: ToolRow): string {
  const parts: string[] = [];
  if (row.read_only) parts.push('read');
  if (row.destructive) parts.push('destructive');
  else if (!row.read_only) parts.push('write');
  if (row.idempotent) parts.push('idempotent');
  return parts.join(',');
}

export function renderToolsText(report: ToolsReport, opts: ToolsOptions): string {
  const lines: string[] = [];
  const scope = opts.filter !== undefined || opts.module !== undefined
    ? `${report.matching} of ${report.registered} registered`
    : `${report.registered} registered`;
  lines.push(`spotify-mcp tools — ${scope}${report.read_only_mode ? ' (SPOTIFY_MCP_READONLY is on)' : ''}`);
  lines.push(`toolsets: ${report.toolsets.length > 0 ? report.toolsets.join(', ') : '(none active)'}`);
  if (report.hidden_modules.length > 0) {
    lines.push(
      `not registered here: ${report.hidden_modules.map((h) => `${h.module} (${h.status})`).join(', ')}`,
    );
  }
  lines.push('');
  for (const row of report.tools) {
    lines.push(`${row.name}`);
    lines.push(`    module     ${row.module ?? '(unowned — see notes)'}`);
    lines.push(`    markers    ${marker(row)}`);
    lines.push(`    quota      ${row.quota ?? 'not declared in the description'}`);
    for (const note of row.notes) lines.push(`    note       ${note}`);
  }
  return lines.join('\n') + '\n';
}

export async function runTools(argv: readonly string[], session: CliSession): Promise<number> {
  let opts: ToolsOptions;
  try {
    opts = parseToolsArgs(argv);
  } catch (err) {
    if ((err as Error).message === '__help__') {
      session.io.write(`${TOOLS_HELP}\n`);
      return 0;
    }
    session.io.write(usageFailure((err as Error).message, TOOLS_HELP));
    return 2;
  }
  const report = await collectToolsReport(session, opts);
  session.io.write(opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderToolsText(report, opts));
  return 0;
}
