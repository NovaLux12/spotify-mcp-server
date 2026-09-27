/**
 * The production MCP server, as a factory, and the scope it derives from (#599,
 * #606).
 *
 * ## Why this module exists at all
 *
 * Until #606 there was exactly one caller of this code: `src/index.ts`, the
 * `bin` entry. The CLI subcommands `tools`, `call`, `watch` and `export` need
 * the SAME registry a host gets — same toolsets, same scope filter, same
 * read-only gate, same budget gates, same annotations, same error boundary —
 * and the only way to get it is to call the code that builds it. Re-deriving
 * the gates in the CLI would be a second copy of the policy, which is the drift
 * `tests/result.consolidation.test.ts` exists to catch and the drift
 * `tests/manifest-comment-baseline.test.ts` exists to keep honest.
 *
 * ## Why it could not stay in `src/index.ts`
 *
 * Because `src/index.ts` is an ENTRY POINT: its module body reads
 * `process.argv[2]` and dispatches. Importing it from anywhere but `node
 * dist/index.js` therefore runs `startMcpServer()` in the importing process —
 * which is why `tests/index-cli.test.ts` spawns it rather than importing it,
 * and why the CLI could not have reused it in-process. Moving the two exports
 * out and re-exporting them from `index.ts` keeps both callers honest: the
 * server path is byte-for-byte what it was, and `src/cli/session.ts` can
 * `import { buildMcpServer }` with no side effect at all.
 *
 * `src/index.ts` re-exports both, so the public surface of the entry point is
 * unchanged and nothing that imported from it needs to move.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createRequire } from 'node:module';

import { installAttributionBoundary, installResourceAttributionBoundary } from './attribution.js';
import { loadTokens } from './auth.js';
import { SpotifyClient } from './client.js';
import { statsfmEnv } from './config.js';
import { DERIVED_ANALYTICS_TOOLS, derivedAnalyticsEnabled } from './derivedanalytics.js';
import { installGatedPathContract } from './gating.js';
import { installProgressContextBoundary, installProgressNotifications } from './progress.js';
import { installActingAccountBoundary, resolveActingAccount } from './actingaccount.js';
import { installCancellationContextBoundary } from './cancellation.js';
import { moduleBlockedByScopes, scopesFor } from './scopefilter.js';
import { SERVER_INSTRUCTIONS } from './serverinstructions.js';
import { PersistentTaskStore, applyTaskSupport, tasksDir } from './tasks.js';
import { installTruncationBoundary } from './shaping.js';
import {
  applyToolAnnotations,
  applyToolOutputSchemas,
  assertAggregateSurfaceBudget,
  collectAggregateSurfaceMeasurement,
  assertModuleSchemaBudgets,
  collectModuleSchemaBudgets,
  installToolErrorBoundary,
  assertToolNamingPolicy,
  registeredToolNames,
  registerManifestModules,
  readOnlyModeEnabled,
} from './tools/annotations.js';
import {
  TOOLSETS,
  resolveToolsets,
  assertToolsetsUsable,
  isModuleActive,
  resolveToolOverrides,
  toolsetEnvHelp,
  STATSFM_REGISTRATION_KEYS,
  DEFAULT_TOOLSETS,
} from './toolsets.js';

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
 * Everything that must run for EVERY session moved: the boundaries, the
 * gated-path contract, the progress reporter, the acting-account echo, the
 * attribution boundary, the manifest registration, the naming policy, the
 * annotations and both budget gates. Those are per-server by construction, and
 * a session that skipped one would serve tools without the truncation cap or
 * the closed input schemas.
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
export async function buildMcpServer(
  client: SpotifyClient,
  scope: ServerScope,
  options: { announce: boolean },
): Promise<McpServer> {
  const { activeSets, overrides, grantedScopes, readOnly } = scope;

  // #600: the MCP Tasks store, built BEFORE the server so it can be passed to
  // the SDK's constructor — supplying `taskStore` is what makes the SDK install
  // its own `tasks/get`, `tasks/result`, `tasks/list` and `tasks/cancel`
  // handlers. Constructing it here rather than lazily also means the restart
  // reconciliation runs once, at startup, before any task can be read.
  //
  // Read-only mode still gets a store: a read-only host can still ask for a
  // multi-minute export as a task, and the store holds no credentials.
  const taskStore = new PersistentTaskStore(tasksDir());

  const server = new McpServer(
    {
      name: 'spotify-mcp',
      version,
    },
    // The second argument, not a field on serverInfo: `instructions` is a
    // ServerOptions member, and the two are easy to confuse when the first
    // call site has only ever taken one.
    { instructions: SERVER_INSTRUCTIONS, taskStore },
  );
  // The capability has to be declared or no client will send a `task` field in
  // the first place. `cancel` and `list` are declared because this store
  // implements both, and `requests.tools.call` because that is the request
  // `installToolErrorBoundary` below answers with a task handle.
  server.server.registerCapabilities({
    tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
  });
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

  // The resource half of the same boundary (#1525). It installs at the same
  // point, and for the same reason — outermost, so nothing added later can
  // bypass a compliance line — but it wraps `server.resource` /
  // `server.registerResource` rather than the tool methods, because a resource
  // read is the other way a host reaches rendered Spotify metadata: the
  // registry advertises 17 fixed resources and 28 resource templates, none of
  // which is a tool.
  //
  // It has to be installed BEFORE the read surfaces register. `server.resource`
  // stores the read callback at registration time and `resources/read`
  // dispatches through that stored reference, so a boundary installed after
  // `registerReadSurfaces()` below would wrap nothing at all. That ordering is
  // load-bearing; the tool boundary has no equivalent constraint, because every
  // tool module is registered further down and none of them are read through a
  // pre-stored callback.
  installResourceAttributionBoundary(server);

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
  // One reader of the SDK's private tool registry, in `annotations.ts`. The
  // call site used to cast the field itself, which made `src/index.ts` (and
  // then this file) a second place asserting a shape the SDK does not publish.
  assertToolNamingPolicy(registeredToolNames(server));

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
  // `execution.taskSupport` for the multi-minute tools (#600), stamped before
  // the budget gates so the advertised payload is the measured one.
  const taskSupport = applyTaskSupport(server);
  if (options.announce && taskSupport.stamped === 0) {
    console.error('[spotify-mcp] warning: no tool was marked task-capable (#600)');
  }
  // One final tools/list + tools/call boundary runs after every registration:
  // closed input schemas, pre-handler unknown-key rejection, and structured
  // error envelopes for all production tools.
  installToolErrorBoundary(server, { taskStore });
  assertAggregateSurfaceBudget(collectAggregateSurfaceMeasurement(server));
  return server;
}

/** The per-process derivations every session of one server shares. */
export interface ServerScope {
  // Typed as the mutable `Set` the resolvers hand back, not `ReadonlySet`:
  // `isModuleActive` and `moduleBlockedByScopes` take a `Set`, and widening the
  // parameter type of a function that does not mutate would be a wider change
  // than this refactor is.
  readonly activeSets: Set<string>;
  readonly overrides: { enable: Set<string>; disable: Set<string> };
  readonly grantedScopes: Set<string>;
  readonly readOnly: boolean;
}

/**
 * Derive the scope every session of one process shares (#606).
 *
 * ## Why this is a function and not a block inside `startMcpServer`
 *
 * `spotify-mcp tools`, `call`, `watch` and `export` (#606) each need a registry
 * that is the *production* one — same toolsets, same scope filter, same
 * read-only gate, same budget gates — because the acceptance criterion is that
 * `tools --json` matches `tools/list` and `call` runs the same zod validation as
 * a host. The only way to get that is to call the code that builds the server.
 * Copying the derivation into the CLI would be the copy-drift
 * `tests/result.consolidation.test.ts` exists to catch, in a new place: a
 * second toolset resolution that understood one more env var than the first
 * would be a CLI that reports a surface no host ever sees.
 *
 * So the derivation MOVED here and both callers use it. The server path is
 * byte-for-byte what it was — same order, same `console.error` lines, same
 * throw — because `announce: true` takes every branch that used to run.
 *
 * ## `announce: false` is a quiet mode, not a different derivation
 *
 * Every `console.error` in this body is gated on it and nothing else is. The
 * hard errors are NOT gated: `assertToolsetsUsable` still throws on an
 * unknown-only spec, because a CLI that silently served a different surface than
 * the one asked for would be worse than a stack trace. Suppressing the advisory
 * lines is what lets a CLI subcommand own stdout for machine-readable output
 * (`tools --json` piped into `jq`) without the startup banner interleaving.
 */
export async function resolveServerScope(options: { announce: boolean }): Promise<ServerScope> {
  const announce = options.announce;

  // Mutation-ledger retention, applied at startup and not only on the next
  // append (#703). A ledger nobody wrote to for a month still ages, and
  // pruning on append alone would leave the oldest records on disk for exactly
  // as long as the user did nothing — which is the case a retention window
  // exists for. Every account's ledger is swept, since a profile the user
  // stopped using is the one no append will ever reach. It is fire-and-
  // forget and advisory: it cannot fail a startup, and a prune that cannot
  // land is counted and reported by spotify_doctor like any other history
  // write failure.
  //
  // ## Why it lives here and not in `startMcpServer`
  //
  // It used to sit in `startMcpServer`, which made the startup sweep a property
  // of the one entry point that happened to host a server. #606 gave the CLI
  // subcommands a second entry point onto the same registry, and a sweep that
  // only the first one runs is a sweep the other silently does without: a user
  // whose entire interaction with this package is `spotify-mcp export` would
  // never age a ledger out. This function is the ONE derivation both callers
  // make before they have a registry at all, so it is the only place the sweep
  // can be both run and guaranteed to run exactly once per process.
  //
  // ## Why it is safe to run from a command that then exits
  //
  // Three properties, and the first is what makes the other two sufficient:
  //
  //  1. `pruneHistoryLedgers` returns immediately unless SPOTIFY_MCP_HISTORY is
  //     truthy, so a user who never opted into the ledger has no file to sweep
  //     and the promise below never reaches the disk.
  //  2. A prune that has nothing to prune does not WRITE. `pruneLedger` compares
  //     the kept set against what it read and returns before `writeLedgerFile`
  //     when they are equal, so the common case is a read and a `return` — and
  //     it deliberately does not create an empty ledger for an account that has
  //     never mutated anything.
  //  3. Every write publishes by `rename(2)` over a unique temp file, and the
  //     one unlink (`rm` of a now-redundant archive) is a POSIX unlink. Neither
  //     can truncate a file another operation is reading: a reader with the old
  //     inode open keeps reading it to EOF. Nothing in this module holds a
  //     ledger fd across an await — `readTailLines` closes in a `finally`,
  //     `writeHistoryRecord` appends per call, `rotate` is a rename — so there
  //     is no in-process handle for a concurrent sweep to pull out from under a
  //     reader.
  //
  // The sweep also runs BEFORE any registration, which is where it ran before
  // #606: the server path's ordering is unchanged, and a CLI subcommand fires it
  // before it can issue a single tool call, so no mutation of this process is in
  // flight while it runs.
  //
  // It cannot change a subcommand's exit code, either. The promise is `void`ed
  // with a `.catch`, `pruneHistoryLedgers` already swallows per-ledger failures
  // into `noteWriteFailure`, and nothing in `history.ts` assigns
  // `process.exitCode` or calls `process.exit`. A pending promise does not by
  // itself keep the event loop alive, so the process is never held open by it
  // either.
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
    if (announce) console.error(`[spotify-mcp] Unknown SPOTIFY_MCP_ENABLE_TOOLS entry ignored: ${name}`);
  }
  for (const name of unknownOverrides.disable) {
    if (announce) console.error(`[spotify-mcp] Unknown SPOTIFY_MCP_DISABLE_TOOLS entry ignored: ${name}`);
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
    if (announce) console.error('[spotify-mcp] SPOTIFY_MCP_STATSFM is set — the stats.fm families are registered');
  }
  const overrides = { enable, disable };
  if (unknown.length > 0) {
    if (announce) {
      console.error(`[spotify-mcp] unknown toolset(s) ignored: ${unknown.join(', ')} — registered ${activeSets.size} toolset(s): ${[...activeSets].sort().join(', ')} — ${toolsetEnvHelp()}`);
    }
  }
  if (announce && activeSets.size < Object.keys(TOOLSETS).length) {
    console.error(`[spotify-mcp] active toolsets: ${[...activeSets].sort().join(', ')}`);
  }
  // The curated default is a change an operator has to be able to see, not a
  // silent trim: without this line, a user whose integration lost a tool has
  // nothing in the startup log to grep for. `spotify_doctor` reports the same
  // thing to a running session, but stderr is what gets pasted into a bug.
  if (announce && (toolsetsSpec ?? '').trim() === '') {
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
  if (announce) {
    if (derivedAnalyticsEnabled()) {
      console.error(`[spotify-mcp] SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS is set — ${DERIVED_ANALYTICS_TOOLS.size} derived listening-analytics tools are registered (${[...DERIVED_ANALYTICS_TOOLS].sort().join(', ')})`);
    } else {
      console.error(`[spotify-mcp] derived listening analytics are OFF — ${DERIVED_ANALYTICS_TOOLS.size} tools (${[...DERIVED_ANALYTICS_TOOLS].sort().join(', ')}) are not registered. Set SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS=1 to register them.`);
    }
  }

  // Scope-aware hiding (#111 item 6): granted scopes come from the persisted
  // token file; fail-open (empty set blocks nothing) for pre-scope files.
  const grantedScopes = await loadTokens()
    .then((t) => scopesFor(t.scope))
    .catch(() => scopesFor(undefined));

  // SPOTIFY_MCP_READONLY=1 hides every write-capable module regardless of
  // granted scopes — for users who want hard guarantees, not conventions.
  const readOnly = readOnlyModeEnabled();
  return { activeSets, overrides, grantedScopes, readOnly };
}
