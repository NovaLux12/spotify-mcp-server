import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { runAuthFlow, getTokenFilePath, parseAuthArgs } from './auth.js';
import { SpotifyClient } from './client.js';
import { initConfig, renderEnvHelp, attributionEnv } from './config.js';
import { createRequire } from 'node:module';
import { BRANDING_NOTICE, NON_AFFILIATION_NOTICE } from './branding.js';
// #606: the registry factory and the scope derivation moved to ./server.js so
// `src/cli/*` can build the SAME production server in-process. Importing them
// from here would be impossible: this module's body dispatches on argv, so
// importing it from a test or from a subcommand would run startMcpServer() in
// the importing process. Re-exported below, so this entry point's public
// surface is unchanged for anything that already imported from it.
import { buildMcpServer, resolveServerScope, type ServerScope } from './server.js';
// The predicate only — the dispatcher itself (and the whole `src/cli/` tree it
// reaches) stays behind the dynamic import in the branch below, so a host
// launching the server over stdio evaluates none of it.
import { isCliSubcommand } from './cli/dispatch.js';
import { readOnlyModeEnabled } from './tools/annotations.js';
import { derivedAnalyticsEnabled } from './derivedanalytics.js';

export { buildMcpServer, resolveServerScope };
export type { ServerScope };

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

async function startMcpServer(): Promise<void> {
  // Read the SPOTIFY_MCP_* env family once; everything else consumes
  // getConfig() from here on.
  initConfig();

  // Resolved BEFORE any registration work, and it throws rather than warns.
  // A refusal here means the process exits 1 having registered nothing, which
  // is the only outcome that cannot be mistaken for a healthy server (#599).
  const { resolveHttpConfig } = await import('./http.js');
  const httpConfig = resolveHttpConfig(process.env);

  // #606: the derivation moved into `resolveServerScope` so the CLI
  // subcommands register through the same code path. `announce: true` keeps
  // the startup log byte-for-byte what it was before the extraction.
  const scope: ServerScope = await resolveServerScope({ announce: true });

  if (!httpConfig.enabled) {
    // The default, and the path every current host uses. Byte-for-byte the
    // same sequence of registrations and gates as before #599: the only thing
    // added on this branch is the config read above, which cannot throw for a
    // stdio process because it returns before inspecting any HTTP variable.
    const client = new SpotifyClient();
    const server = await buildMcpServer(client, scope, { announce: true });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  // Opt-in network transport (#599). One McpServer AND one SpotifyClient per
  // session: sharing the client would give the second session a single
  // progress-reporter slot and redirect the first session's notifications onto
  // the second session's stream (see src/http.ts's header).
  const { startHttpTransport } = await import('./http.js');
  const handle = await startHttpTransport({
    config: httpConfig,
    createServer: async () => buildMcpServer(new SpotifyClient(), scope, { announce: false }),
  });
  console.error(
    `[spotify-mcp] Streamable HTTP transport listening on ${handle.url} `
    + '(bearer auth required; loopback-only by default — see docs/configuration.md)',
  );

  // The process now outlives the request that started it, so the two signals a
  // supervisor actually sends have to close the listener and every live
  // session rather than leaving the socket bound to a dead registry.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[spotify-mcp] ${signal} received — closing the HTTP transport`);
    void handle.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

/**
 * `spotify-mcp doctor` (#62): self-serve the most common auth/config failure
 * class. Prints the resolved configuration, then the shared diagnostic report.
 * Exits non-zero when the report is not ok.
 *
 * #581: the checks are NOT re-implemented here. `collectDoctorReport` and
 * `renderDoctorProse` are the same functions the `spotify_doctor` tool calls
 * (src/tools/doctortool.ts), so the CLI subcommand and the in-server tool
 * cannot report different facts about the same config and token file. What is
 * left here is the CLI-only Configuration block, which is a dump of resolved
 * config keys rather than a check — the checks are rows, and every row is
 * rendered by the shared renderer.
 *
 * Imported dynamically for the same reason the resources and prompts
 * registrars are (#906): a static import would evaluate the doctor module on
 * the MCP startup path, where it is already loaded through the manifest. The
 * `doctor` command never starts a server, so it pays nothing for the import.
 */
async function runDoctor(): Promise<void> {
  const cfg = initConfig();
  // #609: one resolution, argv profile included, used for BOTH the printed
  // Configuration block and the report below. `cfg.tokenFile` is
  // `resolveTokenFile(env)` and knows nothing about `--profile`, so under
  // `spotify-mcp doctor --profile work` this printed the DEFAULT account's
  // file, then inspected `tokens.work.json` through loadTokens — the report
  // meant to explain "wrong account" pointing at the wrong file, with no
  // profile row at all.
  const tokenFile = getTokenFilePath();
  // The CLI profile outranks the env one, matching the token path above.
  const profile = parseAuthArgs().profile ?? cfg.profile;

  console.log(`spotify-mcp ${version}`);
  // The banner, not just the report below it (#705). A user pastes the first
  // lines of this output into a bug thread, and the rendered prose that
  // follows carries the same notice — but the banner is the line a person
  // reads while deciding whether this is an official integration, so it says
  // so itself.
  console.log(NON_AFFILIATION_NOTICE);
  console.log('');
  console.log('Configuration:');
  console.log(`  token file        ${tokenFile}`);
  if (profile) console.log(`  profile           ${profile}`);
  console.log(`  redirect URI      ${cfg.redirectUri}`);
  console.log(`  headless          ${cfg.headless ? 'yes' : 'no'}`);
  console.log(`  max items         ${cfg.maxItems}`);
  console.log(`  fetch-all cap     ${cfg.fetchAllCap}`);
  console.log(`  mutation history  ${cfg.historyEnabled ? 'enabled' : 'disabled'}`);
  // Read from the GATE (readOnlyModeEnabled), not from cfg.readonly: this row
  // is a disclosure, so it must state what module registration actually acted
  // on. The two are pinned equal in tests/config-readonly.test.ts, but the
  // report must not depend on that pin holding at runtime. The shared report's
  // `surface` row reads the same gate, so the two cannot disagree either.
  console.log(`  readonly          ${readOnlyModeEnabled() ? 'yes' : 'no'}`);
  // Read from the GATE, not from `cfg.experimentalAnalytics`, for the same
  // reason as the row above: this line is a disclosure, so it must state what
  // module registration actually acted on. Independent of the readonly row.
  console.log(`  derived analytics ${derivedAnalyticsEnabled() ? 'enabled' : 'disabled (opt-in via SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS)'}`);
  // Read from the GATE (attributionEnv), not from cfg.attribution, for the same
  // reason as the two rows above: this line is a disclosure, so it must state
  // what the boundary actually acted on. An operator reading "on" here and
  // finding no footer in a result is looking at a broken install, and this is
  // where they find out.
  console.log(`  attribution      ${attributionEnv() ? 'enabled' : 'disabled (SPOTIFY_MCP_ATTRIBUTION)'}`);
  if (cfg.market) console.log(`  market            ${cfg.market}`);
  if (cfg.scopes) console.log(`  scopes            ${cfg.scopes.join(', ')}`);

  console.log('');
  const { collectDoctorReport, renderDoctorProse } = await import('./tools/doctortool.js');
  // `disableCache` as before: the CLI process reads the profile once and exits,
  // so caching the one live request would only hide it from the report.
  const report = await collectDoctorReport(new SpotifyClient({ disableCache: true }), undefined, { tokenFile });
  // Always verbose. This output is the artefact users paste when asking for
  // help, and the detail lines are where the token path, the granted scopes
  // and the resolved sets live.
  console.log(renderDoctorProse(report, true));

  console.log('');
  if (!report.ok) {
    console.error('Doctor found problems. If this looks like an auth issue, re-run "spotify-mcp auth".');
    process.exit(1);
  }
  console.log('All checks passed.');
}

const HELP = `spotify-mcp — MCP server for the Spotify Web API
${BRANDING_NOTICE}

Usage:
  spotify-mcp                          Start the MCP server over stdio (this is the default)
  spotify-mcp auth [--profile <name>]  Run the OAuth PKCE flow and save tokens
                        [--scope-profile <name>]
                        [--scopes <list>]
  spotify-mcp doctor                   Check config, token state, and live API access (#62)
                        [--profile <name>]
  spotify-mcp logout [--dry-run]       Erase local stores; print how to revoke the
                        [--keep-backups]   Spotify token by hand (#704)
                        [--profile <name>]
                        [--purge-data]
  spotify-mcp tools [--json]           Print the tool surface this installation
                        [--filter <text>]  registers right now (#606)
                        [--module <key>]
  spotify-mcp call <tool>              Run one tool through this server's own MCP
                        [--args '<json>']  path, without a host (#606)
                        [--dry-run]
                        [--json]
  spotify-mcp watch                    Poll one surface and print only changes
                        [--interval N]    (#606)
                        [--count N]
                        [--tool <name>]
                        [--resource <uri>]
  spotify-mcp export --kind library|playlist   Write an export to disk, confined
                        [--out <path>]    to the configured output roots (#606)
                        [--playlist <id>]
  spotify-mcp init --host <host>       Write a host config, optionally verified
                        [--out <file>]    by starting the server once (#606)
                        [--verify]
  spotify-mcp --help                   Show this message
  spotify-mcp --version                Print the version

  SPOTIFY_MCP_TRANSPORT=http serves the same server over Streamable HTTP
  instead. It is opt-in, requires a bearer token, binds loopback unless you say
  otherwise, and is still single-user — see docs/configuration.md before
  exposing it to anything other than this machine.

  auth --profile <name> is the CLI form of SPOTIFY_MCP_PROFILE and selects
  ~/.spotify-mcp/tokens.<name>.json. It applies to the whole invocation and
  not just to auth: the server, doctor and logout all act on the named
  account.

  auth asks the consent screen for a scope PROFILE, not a hand-written list:
  read | core | write | full. The default is core — reads plus playback
  control, and no library, playlist, follow or cover-upload write. Use
  --scope-profile <name> (or SPOTIFY_MCP_SCOPE_PROFILE) to pick another, and
  --scopes <list> to name scopes one by one. auth prints what it is about to
  ask for before it opens the browser. --scopes and --scope-profile reject an
  empty or unknown value rather than silently falling back to a wider grant.

  logout erases every local store it can find and names each path it removed.
  Spotify publishes no token-revocation API, so the token must still be revoked
  at https://www.spotify.com/account/apps/ — logout prints that address.
  --purge-data asks for that erasure explicitly and is accepted, but it changes
  nothing: the stores go whether or not you pass it (#703).

  tools, call, watch and export are MCP clients, not a second call path (#606).
  They build this same server and speak to it, so the surface they report is
  the surface a host gets, and a call runs the same validation and the same
  confirmation gates. init writes a host config and can verify it by starting
  the server once. See docs/cli.md.

Environment:
${renderEnvHelp()}

Full reference: docs/configuration.md
`;

const command = process.argv[2];

if (command === '--help' || command === '-h') {
  console.log(HELP);
} else if (command === '--version' || command === '-v') {
  console.log('spotify-mcp ' + version);
} else if (command === 'auth') {
  runAuthFlow().catch((err: unknown) => {
    console.error('Auth failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
} else if (command === 'doctor') {
  runDoctor().catch((err: unknown) => {
    console.error('Doctor error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
} else if (command === 'logout') {
  // Imported lazily: logout pulls in the store resolvers, and the server must
  // not pay for them (or trigger their module evaluation) on the normal path.
  import('./logout.js')
    .then(({ runLogout }) => runLogout(process.argv.slice(3)))
    .then((code: number) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error('Logout failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
} else if (isCliSubcommand(command)) {
  // #606. Same lazy shape as logout: the session and its four subcommands are
  // pulled in only when one of those names is actually the command, so a host
  // that launches the server over stdio pays for none of it.
  import('./cli/dispatch.js')
    .then(({ dispatchCliSubcommand }) => dispatchCliSubcommand(command as string, process.argv.slice(3)))
    .then((result: { code: number }) => {
      process.exitCode = result.code;
    })
    .catch((err: unknown) => {
      console.error(`spotify-mcp ${command} failed:`, err instanceof Error ? err.message : err);
      process.exit(1);
    });
} else {
  startMcpServer().catch((err: unknown) => {
    console.error('Server error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
