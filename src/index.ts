import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { runAuthFlow, loadTokens, getTokenFilePath, parseAuthArgs } from './auth.js';
import { SpotifyClient } from './client.js';
import { initConfig, renderEnvHelp, statsfmEnv, attributionEnv } from './config.js';
import {
  applyToolAnnotations,
  applyToolOutputSchemas,
  assertAggregateSurfaceBudget,
  collectAggregateSurfaceMeasurement,
  assertModuleSchemaBudgets,
  collectModuleSchemaBudgets,
  installToolErrorBoundary,
  assertToolNamingPolicy,
  registerManifestModules,
  readOnlyModeEnabled,
} from './tools/annotations.js';
import { TOOLSETS, resolveToolsets, assertToolsetsUsable, isModuleActive, resolveToolOverrides, toolsetEnvHelp, STATSFM_REGISTRATION_KEYS, DEFAULT_TOOLSETS } from './toolsets.js';
import { moduleBlockedByScopes, scopesFor } from './scopefilter.js';
import { DERIVED_ANALYTICS_TOOLS, derivedAnalyticsEnabled } from './derivedanalytics.js';
import { createRequire } from 'node:module';
import { installTruncationBoundary } from './shaping.js';
import { installGatedPathContract } from './gating.js';
import { installProgressContextBoundary, installProgressNotifications } from './progress.js';
import { installActingAccountBoundary, resolveActingAccount } from './actingaccount.js';
import { installAttributionBoundary } from './attribution.js';
import { installCancellationContextBoundary } from './cancellation.js';
import { BRANDING_NOTICE, NON_AFFILIATION_NOTICE } from './branding.js';
import { SERVER_INSTRUCTIONS } from './serverinstructions.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

/**
 * The `instructions` a host receives in the `initialize` response (#705, #690).
 *
 * This is the only surface an agent that never sees the README, the npm page
 * or the repository gets: a host that launches the server over stdio and
 * speaks JSON-RPC sees the tool list and this string, and nothing else. The
 * non-affiliation notice is the sentence that must therefore be here, because
 * the project name begins with "Spot" and the decision to keep it (see
 * docs/compliance.md) is only defensible if an unaffiliated user cannot be
 * left to infer otherwise.
 *
 * #705 supplied that notice and nothing else. #690 appends the host guidance
 * — the discovery trio, the `dry_run` convention, the two toolset knobs and
 * the receipt lifetime — so a host that reads only `initialize` and
 * `tools/list` can find the preview convention instead of inferring it from
 * 555 KiB of tool schemas. The string itself, and the reasoning for what is
 * kept out of it, live in `src/serverinstructions.ts`; this comment stays on
 * the call site because the call site is the half that can regress silently.
 *
 * The wording is `BRANDING_NOTICE`, not a hand-typed copy: this unit is the
 * sibling #705 was waiting on, and it appends to the notice rather than
 * re-authoring or re-ordering it. `tests/branding-notice-guard.test.ts` and
 * `tests/server-instructions.test.ts` both read the instructions back off a
 * spawned server, so dropping the constant here — the exact regression the
 * `{ instructions }` argument below can introduce — fails a test rather than
 * shipping a silent gap.
 */

/**
 * The registration half of `startMcpServer`, as a factory.
 *
 * Extracted for #599 so the opt-in HTTP transport can build one fully
 * registered `McpServer` per session — the MCP SDK's `Server` holds exactly
 * one transport, so a multi-session listener cannot reuse a single instance.
 *
 * ## What did and did not move into it
 *
 * Everything that must run for EVERY session moved: the three boundaries, the
 * gated-path contract, the progress reporter, the acting-account echo, the
 * manifest registration, the naming policy, the annotations and both budget
 * gates. Those are per-server by construction, and a session that skipped one
 * would serve tools without the truncation cap or the closed input schemas.
 *
 * What stayed in `startMcpServer` is the process-level derivation: the toolset
 * resolution, the granted-scope read and the read-only gate. All three read
 * `process.env` or the token file once, and all three are identical for every
 * session of one process — recomputing them per session would multiply the
 * token-file reads and could, in principle, produce two sessions that disagree
 * about which tools exist.
 *
 * The HTTP path is NOT a parallel registration: it goes through this same
 * function, so the schema-budget gate and the annotation coverage check that
 * fail startup over stdio fail it identically over HTTP. That is the whole
 * reason the factory exists rather than a second, HTTP-specific registrar.
 *
 * `announce` suppresses the two advisory startup lines on the second and later
 * sessions. The gates themselves still run and still throw — a session whose
 * annotations did not apply is a real defect, it just does not need to be
 * reported once per connected client.
 */
async function buildMcpServer(
  client: SpotifyClient,
  scope: ServerScope,
  options: { announce: boolean },
): Promise<McpServer> {
  const { activeSets, overrides, grantedScopes, readOnly } = scope;

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

  // Cross-cutting error contract for Spotify's app-registration-gated
  // endpoints (#791): installed here, next to the progress reporter, because
  // it must hold in every host configuration. It used to be installed by the
  // exhaust2enggating tool module, so trimming that toolset silently removed
  // the graceful 403 mapping for every other module's tools too.
  installGatedPathContract(client);

  if (options.announce && readOnly) {
    console.error('[spotify-mcp] SPOTIFY_MCP_READONLY is set — write-capable modules are hidden');
  }

  // Forward long-walk pagination progress (#65) as MCP progress
  // notifications (#728). The reporter only fires when the caller supplied
  // a progressToken in `request.params._meta`; otherwise we stay silent so
  // line-oriented hosts see the JSON-RPC result as the last frame on the
  // wire. The token echoed on each notification is the caller's, not a
  // server-invented counter. Failures are swallowed so notification hiccups
  // never break a walk.
  installProgressNotifications(client, server);

  // The acting-account echo (#602) installs AFTER the three boundaries above,
  // so it is the outer wrapper and sees the finished, shaped result. It needs
  // the client, which is why it cannot sit with the other two.
  installActingAccountBoundary(server, resolveActingAccount, client);

  // The attribution boundary (#696) installs LAST of all of them, so it is the
  // outermost wrapper and the last thing to touch a result's text block. It has
  // to see the final prose, not the pre-shaping prose: the truncation boundary
  // rewrites the last line of a capped result, and a footer appended under a
  // line that is about to be replaced would end up in the wrong place.
  //
  // Order against the acting-account echo is not load-bearing and is stated
  // rather than left to be inferred: the two write disjoint halves of the same
  // result — the echo touches `structuredContent`, attribution touches the text
  // block — so either order produces the same bytes. It goes last because
  // "outermost, sees the finished result" is the property worth having, and
  // because a later boundary must not be able to bypass a compliance line by
  // being added after it.
  installAttributionBoundary(server);

  // Tool modules load behind the toolset gate (#906). `registerManifestModules`
  // imports only the modules that are about to register — a module whose key is
  // trimmed is never evaluated — and then registers them in manifest order, so
  // `tools/list` order is unchanged. The gates below are deliberately NOT lazy:
  // they run here, after every module that will serve tools has registered, and
  // they measure the same live registry they measured before.
  await registerManifestModules(server, client, {
    readOnly,
    isModuleActive: (key) => isModuleActive(key, activeSets, overrides),
    disableOverrides: overrides.disable,
    scopeBlocked: (key) => moduleBlockedByScopes(key, grantedScopes),
  });

  // Resources/prompts are separate MCP surfaces and do not contribute to the
  // tool schema budget, but retain their existing toolsets and scope gates.
  // Imported dynamically for the same reason as the tool modules: a static
  // import of ./resources/register.js would drag `walkFollowedArtists` — and so
  // the whole of src/tools/following.ts — into every process, including one
  // that trimmed the `following` toolset.
  //
  // #685: the two resource modules are registered through ONE helper, so the
  // order a host sees is the order any test reproducing it sees. They used to
  // be two calls here and two independent calls in the test suites, one of
  // which registered only one of the modules — which is how a shadowing pair
  // could not be observed by the tests that claimed to cover it.
  const resourcesActive =
    isModuleActive('resources', activeSets, overrides) && !moduleBlockedByScopes('resources', grantedScopes);
  if (resourcesActive) {
    const { registerReadSurfaces } = await import('./resources/register.js');
    // #597: one registry, two consumers. `registerReadSurfaces` records each
    // watchable resource's renderer in it; `installResourceSubscriptions` polls
    // through those same renderers, so a subscription compares the body a
    // `resources/read` would return rather than a private re-implementation of
    // it. Both are dynamic for the reason the import above gives.
    const { createResourceReadRegistry, installResourceSubscriptions } = await import('./resources/subscriptions.js');
    const reads = createResourceReadRegistry();
    registerReadSurfaces(server, client, reads);
    installResourceSubscriptions(server, reads);
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

  // Published output contracts (#687), before either budget gate below. Both
  // `assertModuleSchemaBudgets` and `assertAggregateSurfaceBudget` measure
  // `outputSchema`, so a declaration made after them would be free — and a
  // payload no gate can see is not one anybody is paying for. It throws on a
  // module nobody classified, which is the state this issue exists to end.
  const outputSchemas = applyToolOutputSchemas(server);
  if (options.announce && (outputSchemas.total === 0 || outputSchemas.declared === 0)) {
    console.error('[spotify-mcp] warning: no tool published an outputSchema (#687)');
  }

  assertModuleSchemaBudgets(collectModuleSchemaBudgets(server));

  // Annotations + titles for every registered tool (#565/A0-002): hosts need to
  // tell reads from destructive writes to auto-approve safely. Applied once here
  // rather than at 500+ call sites; assert coverage below so a silent no-op (SDK
  // registry shape change) is visible in the startup log instead of a host.
  const annotations = applyToolAnnotations(server);
  if (options.announce && (annotations.total === 0 || annotations.annotated < annotations.total)) {
    console.error(
      `[spotify-mcp] warning: tool annotations applied to ${annotations.annotated}/${annotations.total} registered tools`,
    );
  }
  // One final tools/list + tools/call boundary runs after every registration:
  // closed input schemas, pre-handler unknown-key rejection, and structured
  // error envelopes for all production tools.
  installToolErrorBoundary(server);
  assertAggregateSurfaceBudget(collectAggregateSurfaceMeasurement(server));
  return server;
}

/** The per-process derivations every session of one server shares. */
interface ServerScope {
  // Typed as the mutable `Set` the resolvers hand back, not `ReadonlySet`:
  // `isModuleActive` and `moduleBlockedByScopes` take a `Set`, and widening the
  // parameter type of a function that does not mutate would be a wider change
  // than this refactor is.
  readonly activeSets: Set<string>;
  readonly overrides: { enable: Set<string>; disable: Set<string> };
  readonly grantedScopes: Set<string>;
  readonly readOnly: boolean;
}

async function startMcpServer(): Promise<void> {
  // Read the SPOTIFY_MCP_* env family once; everything else consumes
  // getConfig() from here on.
  initConfig();

  // Resolved BEFORE any registration work, and it throws rather than warns.
  // A refusal here means the process exits 1 having registered nothing, which
  // is the only outcome that cannot be mistaken for a healthy server (#599).
  const { resolveHttpConfig } = await import('./http.js');
  const httpConfig = resolveHttpConfig(process.env);

  // Mutation-ledger retention, applied at startup and not only on the next
  // append (#703). A ledger nobody wrote to for a month still ages, and
  // pruning on append alone would leave the oldest records on disk for exactly
  // as long as the user did nothing — which is the case a retention window
  // exists for. Every account's ledger is swept, since a profile the user
  // stopped using is the one no append will ever reach. It is fire-and-
  // forget and advisory: it cannot fail a startup, and a prune that cannot
  // land is counted and reported by spotify_doctor like any other history
  // write failure.
  void import('./history.js')
    .then(({ pruneHistoryLedgers }) => pruneHistoryLedgers(process.env))
    .catch(() => {
      /* retention is best-effort; the append path and doctor still report it */
    });

  // Toolset segmentation (#95): SPOTIFY_MCP_TOOLSETS=playlists,player,... trims
  // the registered surface for clients that cap tool counts. Default: the
  // curated `core` surface (#889); `all` is the whole thing.
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
  // The stats.fm families are off by default (#607): 49 tools across the
  // `statsfm`, `taste` and `tastecomposites` keys that need a separate
  // stats.fm username, advertised to every user whether or not they have one.
  // SPOTIFY_MCP_STATSFM=1 is the one-word opt-in, and it rides the ENABLE path
  // rather than inventing a second gate, so an explicit
  // SPOTIFY_MCP_DISABLE_TOOLS=statsfm still wins over it — the same precedence
  // every other registration key obeys.
  if (statsfmEnv()) {
    for (const key of STATSFM_REGISTRATION_KEYS) enable.add(key);
    console.error('[spotify-mcp] SPOTIFY_MCP_STATSFM is set — the stats.fm families are registered');
  }
  const overrides = { enable, disable };
  if (unknown.length > 0) {
    console.error(`[spotify-mcp] unknown toolset(s) ignored: ${unknown.join(', ')} — registered ${activeSets.size} toolset(s): ${[...activeSets].sort().join(', ')} — ${toolsetEnvHelp()}`);
  }
  if (activeSets.size < Object.keys(TOOLSETS).length) {
    console.error(`[spotify-mcp] active toolsets: ${[...activeSets].sort().join(', ')}`);
  }
  // The curated default is a change an operator has to be able to see, not a
  // silent trim: without this line, a user whose integration lost a tool has
  // nothing in the startup log to grep for. `spotify_doctor` reports the same
  // thing to a running session, but stderr is what gets pasted into a bug.
  if ((toolsetsSpec ?? '').trim() === '') {
    console.error(
      `[spotify-mcp] SPOTIFY_MCP_TOOLSETS is unset — registering the default surface ` +
      `(${DEFAULT_TOOLSETS.join(', ')}). Set SPOTIFY_MCP_TOOLSETS=all for every tool.`,
    );
  }

  // #695: the derived-listening-analytics opt-in, disclosed once per process.
  // Saying nothing when the flag is OFF would let an operator believe the
  // analytics are there and find eleven tools missing with no explanation — so
  // the OFF case prints, and it names the flag rather than a bare count. The ON
  // case prints too, because a host that opted in should be able to see in a log
  // that the extra surface is what it asked for. This is a separate mechanism
  // from SPOTIFY_MCP_READONLY and the two lines are independent: read-only mode
  // says nothing about analytics, and a read-only host can still hold derived
  // metrics.
  //
  // It sits here, beside the toolset derivation it is disclosed next to, rather
  // than inside buildMcpServer: `derivedAnalyticsEnabled()` reads process.env and
  // every session of one process sees the same answer, so printing it per
  // session would repeat one line once per connected client (#599).
  if (derivedAnalyticsEnabled()) {
    console.error(`[spotify-mcp] SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS is set — ${DERIVED_ANALYTICS_TOOLS.size} derived listening-analytics tools are registered (${[...DERIVED_ANALYTICS_TOOLS].sort().join(', ')})`);
  } else {
    console.error(`[spotify-mcp] derived listening analytics are OFF — ${DERIVED_ANALYTICS_TOOLS.size} tools (${[...DERIVED_ANALYTICS_TOOLS].sort().join(', ')}) are not registered. Set SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS=1 to register them.`);
  }

  // Scope-aware hiding (#111 item 6): granted scopes come from the persisted
  // token file; fail-open (empty set blocks nothing) for pre-scope files.
  const grantedScopes = await loadTokens()
    .then((t) => scopesFor(t.scope))
    .catch(() => scopesFor(undefined));

  // SPOTIFY_MCP_READONLY=1 hides every write-capable module regardless of
  // granted scopes — for users who want hard guarantees, not conventions.
  const readOnly = readOnlyModeEnabled();
  const scope: ServerScope = { activeSets, overrides, grantedScopes, readOnly };

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
