import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { runAuthFlow, loadTokens, getTokenFilePath, parseAuthArgs } from './auth.js';
import { SpotifyClient } from './client.js';
import { initConfig, renderEnvHelp } from './config.js';
import {
  applyToolAnnotations,
  assertAggregateSurfaceBudget,
  collectAggregateSurfaceMeasurement,
  assertModuleSchemaBudgets,
  collectModuleSchemaBudgets,
  installToolErrorBoundary,
  assertToolNamingPolicy,
  registerManifestModules,
  readOnlyModeEnabled,
} from './tools/annotations.js';
import { TOOLSETS, resolveToolsets, assertToolsetsUsable, isModuleActive, resolveToolOverrides, toolsetEnvHelp } from './toolsets.js';
import { moduleBlockedByScopes, scopesFor } from './scopefilter.js';
import { DERIVED_ANALYTICS_TOOLS, derivedAnalyticsEnabled } from './derivedanalytics.js';
import { createRequire } from 'node:module';
import { installTruncationBoundary } from './shaping.js';
import { installGatedPathContract } from './gating.js';
import { installProgressContextBoundary, installProgressNotifications } from './progress.js';
import { installActingAccountBoundary, resolveActingAccount } from './actingaccount.js';
import { installCancellationContextBoundary } from './cancellation.js';
import { BRANDING_NOTICE, NON_AFFILIATION_NOTICE } from './branding.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

/**
 * The `instructions` a host receives in the `initialize` response (#705).
 *
 * This is the only surface an agent that never sees the README, the npm page
 * or the repository gets: a host that launches the server over stdio and
 * speaks JSON-RPC sees the tool list and this string, and nothing else. The
 * non-affiliation notice is the sentence that must therefore be here, because
 * the project name begins with "Spot" and the decision to keep it (see
 * docs/compliance.md) is only defensible if an unaffiliated user cannot be
 * left to infer otherwise.
 *
 * The wording is `BRANDING_NOTICE`, not a hand-typed copy: the sibling units
 * that own host-orientation guidance extend this string rather than editing
 * the notice. `tests/branding-notice-guard.test.ts` reads the instructions
 * back off a spawned server, so dropping the constant here fails a test rather
 * than shipping a silent gap.
 */
const SERVER_INSTRUCTIONS = BRANDING_NOTICE;

async function startMcpServer(): Promise<void> {
  // Read the SPOTIFY_MCP_* env family once; everything else consumes
  // getConfig() from here on.
  initConfig();

  const server = new McpServer(
    {
      name: 'spotify-mcp',
      version,
    },
    // The second argument, not a field on serverInfo: `instructions` is a
    // ServerOptions member, and the two are easy to confuse when the first
    // call site has only ever taken one.
    { instructions: SERVER_INSTRUCTIONS },
  );
  // Progress-context boundary MUST install before the truncation boundary
  // (#728): both wrap the SDK's tool/registerTool, and progress wraps
  // truncation at call time so any long walks triggered by shaping also see
  // the caller's progress token.
  // Per-request cancellation context (#676): the SDK hands every handler an
  // `extra.signal` that it aborts on `notifications/cancelled`, and this
  // boundary is the single place that signal enters the server. Installed
  // alongside the progress context because it wraps `tool`/`registerTool` the
  // same way and both only read `extra` and delegate — order between the three
  // wrappers is not load-bearing, but it is listed first because cancellation
  // is the one a caller is waiting on.
  installCancellationContextBoundary(server);
  installProgressContextBoundary(server);
  installTruncationBoundary(server);

  // Toolset segmentation (#95): SPOTIFY_MCP_TOOLSETS=playlists,player,... trims
  // the registered surface for clients that cap tool counts. Default: all.
  const toolsetsSpec = process.env.SPOTIFY_MCP_TOOLSETS;
  const { sets: activeSets, unknown } = resolveToolsets(toolsetsSpec);
  // Unknown-only specs fail loud (#910); mixed specs keep starting.
  assertToolsetsUsable(toolsetsSpec, { sets: activeSets, unknown });
  // Per-tool opt-in/opt-out (#111 item 7): SPOTIFY_MCP_ENABLE_TOOLS /
  // SPOTIFY_MCP_DISABLE_TOOLS take registration keys; disable > enable > set.
  const { enable, disable, unknown: unknownOverrides } = resolveToolOverrides(
    process.env.SPOTIFY_MCP_ENABLE_TOOLS,
    process.env.SPOTIFY_MCP_DISABLE_TOOLS,
  );
  for (const name of unknownOverrides.enable) {
    console.error(`[spotify-mcp] Unknown SPOTIFY_MCP_ENABLE_TOOLS entry ignored: ${name}`);
  }
  for (const name of unknownOverrides.disable) {
    console.error(`[spotify-mcp] Unknown SPOTIFY_MCP_DISABLE_TOOLS entry ignored: ${name}`);
  }
  const overrides = { enable, disable };
  if (unknown.length > 0) {
    console.error(`[spotify-mcp] unknown toolset(s) ignored: ${unknown.join(', ')} — registered ${activeSets.size} toolset(s): ${[...activeSets].sort().join(', ')} — ${toolsetEnvHelp()}`);
  }
  if (activeSets.size < Object.keys(TOOLSETS).length) {
    console.error(`[spotify-mcp] active toolsets: ${[...activeSets].sort().join(', ')}`);
  }

  const client = new SpotifyClient();

  // Cross-cutting error contract for Spotify's app-registration-gated
  // endpoints (#791): installed here, next to the progress reporter, because
  // it must hold in every host configuration. It used to be installed by the
  // exhaust2enggating tool module, so trimming that toolset silently removed
  // the graceful 403 mapping for every other module's tools too.
  installGatedPathContract(client);

  // Scope-aware hiding (#111 item 6): granted scopes come from the persisted
  // token file; fail-open (empty set blocks nothing) for pre-scope files.
  const grantedScopes = await loadTokens()
    .then((t) => scopesFor(t.scope))
    .catch(() => scopesFor(undefined));

  // SPOTIFY_MCP_READONLY=1 hides every write-capable module regardless of
  // granted scopes — for users who want hard guarantees, not conventions.
  const readOnly = readOnlyModeEnabled();
  if (readOnly) {
    console.error('[spotify-mcp] SPOTIFY_MCP_READONLY is set — write-capable modules are hidden');
  }

  // #695: the derived-listening-analytics opt-in, disclosed on every start in
  // the direction that matters. Saying nothing when the flag is OFF would let
  // an operator believe the analytics are there and find eleven tools missing
  // with no explanation — so the OFF case prints, and it names the flag rather
  // than a bare count. The ON case prints too, because a host that opted in
  // should be able to see in a log that the extra surface is what it asked for.
  // This is a separate mechanism from SPOTIFY_MCP_READONLY and the two lines
  // are independent: read-only mode says nothing about analytics, and a
  // read-only host can still hold derived metrics.
  if (derivedAnalyticsEnabled()) {
    console.error(`[spotify-mcp] SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS is set — ${DERIVED_ANALYTICS_TOOLS.size} derived listening-analytics tools are registered (${[...DERIVED_ANALYTICS_TOOLS].sort().join(', ')})`);
  } else {
    console.error(`[spotify-mcp] derived listening analytics are OFF — ${DERIVED_ANALYTICS_TOOLS.size} tools (${[...DERIVED_ANALYTICS_TOOLS].sort().join(', ')}) are not registered. Set SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS=1 to register them.`);
  }

  // Forward long-walk pagination progress (#65) as MCP progress
  // notifications (#728). The reporter only fires when the caller supplied
  // a progressToken in `request.params._meta`; otherwise we stay silent so
  // line-oriented hosts see the JSON-RPC result as the last frame on the
  // wire. The token echoed on each notification is the caller's, not a
  // server-invented counter. Failures are swallowed so notification hiccups
  // never break a walk.
  installProgressNotifications(client, server);

  // The acting-account echo (#602) installs LAST of the three boundaries, so it
  // is the outermost wrapper and sees the finished, shaped result. It needs the
  // client, which is why it cannot sit with the other two above.
  installActingAccountBoundary(server, resolveActingAccount, client);

  // Tool modules load behind the toolset gate (#906). `registerManifestModules`
  // imports only the modules that are about to register — a module whose key is
  // trimmed is never evaluated — and then registers them in manifest order, so
  // `tools/list` order is unchanged. The gates below are deliberately NOT lazy:
  // they run here, after every module that will serve tools has registered, and
  // they measure the same live registry they measured before.
  await registerManifestModules(server, client, {
    readOnly,
    isModuleActive: (key) => isModuleActive(key, activeSets, overrides),
    scopeBlocked: (key) => moduleBlockedByScopes(key, grantedScopes),
  });

  // Resources/prompts are separate MCP surfaces and do not contribute to the
  // tool schema budget, but retain their existing toolsets and scope gates.
  // Imported dynamically for the same reason as the tool modules: a static
  // import of ./resources/index.js would drag `walkFollowedArtists` — and so
  // the whole of src/tools/following.ts — into every process, including one
  // that trimmed the `following` toolset.
  const resourcesActive =
    isModuleActive('resources', activeSets, overrides) && !moduleBlockedByScopes('resources', grantedScopes);
  if (resourcesActive) {
    const { registerTemplateResources } = await import('./resources/templates.js');
    const { registerResources } = await import('./resources/index.js');
    registerTemplateResources(server, client);
    registerResources(server, client);
  }
  if (isModuleActive('prompts', activeSets, overrides) && !moduleBlockedByScopes('prompts', grantedScopes)) {
    const { registerPrompts } = await import('./prompts/index.js');
    // ONE boolean decides both whether the resources are registered and what
    // the prompts are allowed to say about them (#715). Derived twice, the two
    // answers can drift and the drifting one ships a `spotify://` hint that
    // resolves to nothing in the configuration it was served under.
    registerPrompts(server, { resourceHints: resourcesActive });
  }
  assertToolNamingPolicy(Object.keys((server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {}));

  assertModuleSchemaBudgets(collectModuleSchemaBudgets(server));

  // Annotations + titles for every registered tool (#565/A0-002): hosts need to
  // tell reads from destructive writes to auto-approve safely. Applied once here
  // rather than at 500+ call sites; assert coverage below so a silent no-op (SDK
  // registry shape change) is visible in the startup log instead of a host.
  const annotations = applyToolAnnotations(server);
  if (annotations.total === 0 || annotations.annotated < annotations.total) {
    console.error(
      `[spotify-mcp] warning: tool annotations applied to ${annotations.annotated}/${annotations.total} registered tools`,
    );
  }
  // One final tools/list + tools/call boundary runs after every registration:
  // closed input schemas, pre-handler unknown-key rejection, and structured
  // error envelopes for all production tools.
  installToolErrorBoundary(server);
  assertAggregateSurfaceBudget(collectAggregateSurfaceMeasurement(server));
  const transport = new StdioServerTransport();
  await server.connect(transport);
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
                        [--scopes <list>]
  spotify-mcp doctor                   Check config, token state, and live API access (#62)
                        [--profile <name>]
  spotify-mcp logout [--dry-run]       Erase local stores; print how to revoke the
                        [--keep-backups]   Spotify token by hand (#704)
                        [--profile <name>]
  spotify-mcp --help                   Show this message
  spotify-mcp --version                Print the version

  auth --profile <name> is the CLI form of SPOTIFY_MCP_PROFILE and selects
  ~/.spotify-mcp/tokens.<name>.json. It applies to the whole invocation and
  not just to auth: the server, doctor and logout all act on the named
  account. auth --scopes <list> overrides SPOTIFY_SCOPES for that run; both
  reject an empty value rather than silently falling back to the default token
  file and the full 17-scope grant.

  logout erases every local store it can find and names each path it removed.
  Spotify publishes no token-revocation API, so the token must still be revoked
  at https://www.spotify.com/account/apps/ — logout prints that address.

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
} else {
  startMcpServer().catch((err: unknown) => {
    console.error('Server error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
