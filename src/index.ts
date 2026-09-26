import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { runAuthFlow, loadTokens } from './auth.js';
import { SpotifyClient, SpotifyApiError } from './client.js';
import { initConfig } from './config.js';
import {
  applyToolAnnotations,
  assertAggregateSurfaceBudget,
  collectAggregateSurfaceMeasurement,
  assertModuleSchemaBudgets,
  collectModuleSchemaBudgets,
  installToolErrorBoundary,
  assertToolNamingPolicy,
  registerManifestModule,
  REGISTRAR_MANIFEST,
  readOnlyModeEnabled,
} from './tools/annotations.js';
import { registerTemplateResources } from './resources/templates.js';
import { registerResources } from './resources/index.js';
import { registerPrompts } from './prompts/index.js';
import { TOOLSETS, resolveToolsets, assertToolsetsUsable, isModuleActive, resolveToolOverrides, toolsetEnvHelp } from './toolsets.js';
import { moduleBlockedByScopes, scopesFor } from './scopefilter.js';
import { createRequire } from 'node:module';
import { installTruncationBoundary } from './shaping.js';
import { installGatedPathContract } from './gating.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

async function startMcpServer(): Promise<void> {
  // Read the SPOTIFY_MCP_* env family once; everything else consumes
  // getConfig() from here on.
  initConfig();

  const server = new McpServer({
    name: 'spotify-mcp',
    version,
  });
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

  // Forward long-walk pagination progress (#65) as MCP progress
  // notifications. The monotonic walkId doubles as the progressToken;
  // failures are swallowed so notification hiccups never break a walk.
  client.setProgressReporter((info) => {
    try {
      void server.server
        .notification({
          method: 'notifications/progress',
          params: {
            progressToken: info.walkId,
            progress: info.fetched,
            ...(info.total !== undefined ? { total: info.total } : {}),
          },
        })
        .catch(() => undefined);
    } catch {
      // best-effort only
    }
  });

  for (const module of REGISTRAR_MANIFEST) {
    registerManifestModule(server, client, module, {
      readOnly,
      isModuleActive: (key) => isModuleActive(key, activeSets, overrides),
      scopeBlocked: (key) => moduleBlockedByScopes(key, grantedScopes),
    });
  }

  // Resources/prompts are separate MCP surfaces and do not contribute to the
  // tool schema budget, but retain their existing toolsets and scope gates.
  if (isModuleActive('resources', activeSets, overrides) && !moduleBlockedByScopes('resources', grantedScopes)) registerTemplateResources(server, client);
  if (isModuleActive('resources', activeSets, overrides) && !moduleBlockedByScopes('resources', grantedScopes)) registerResources(server, client);
  if (isModuleActive('prompts', activeSets, overrides) && !moduleBlockedByScopes('prompts', grantedScopes)) registerPrompts(server);
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
 * class. Prints the resolved configuration, token file state/expiry, then a
 * live authenticated GET /me probe. Exits non-zero when anything fails.
 */
async function runDoctor(): Promise<void> {
  const cfg = initConfig();
  let failed = false;

  console.log(`spotify-mcp ${version}`);
  console.log('');
  console.log('Configuration:');
  console.log(`  token file        ${cfg.tokenFile}`);
  if (cfg.profile) console.log(`  profile           ${cfg.profile}`);
  console.log(`  redirect URI      ${cfg.redirectUri}`);
  console.log(`  headless          ${cfg.headless ? 'yes' : 'no'}`);
  console.log(`  max items         ${cfg.maxItems}`);
  console.log(`  fetch-all cap     ${cfg.fetchAllCap}`);
  console.log(`  mutation history  ${cfg.historyEnabled ? 'enabled' : 'disabled'}`);
  if (cfg.market) console.log(`  market            ${cfg.market}`);
  if (cfg.scopes) console.log(`  scopes            ${cfg.scopes.join(', ')}`);

  console.log('');
  try {
    const tokens = await loadTokens();
    const msLeft = tokens.expires_at - Date.now();
    const hasRefresh = typeof tokens.refresh_token === 'string' && !!tokens.refresh_token;
    const refreshNote = hasRefresh ? 'refresh_token present' : 'refresh_token MISSING — re-run auth';
    if (msLeft <= 0) {
      const secAgo = Math.round(-msLeft / 1000);
      console.log(`Token state: EXPIRED (${secAgo}s ago, ${new Date(tokens.expires_at).toISOString()}) — next API call will auto-refresh; if refresh fails, re-run "spotify-mcp auth".`);
      console.log(`             ${refreshNote} | file: ${cfg.tokenFile}`);
    } else if (msLeft < 60_000) {
      console.log(
        `Token state: expiring in ${Math.round(msLeft / 1000)}s — will auto-refresh on next use.`,
      );
      console.log(`             ${refreshNote} | file: ${cfg.tokenFile}`);
    } else {
      const mins = Math.floor(msLeft / 60_000);
      const hours = Math.floor(mins / 60);
      console.log(
        `Token state: valid, expires at ${new Date(tokens.expires_at).toISOString()} ` +
          `(in ${hours > 0 ? `${hours}h ` : ''}${mins % 60}m) — ${refreshNote}`,
      );
      console.log(`             file: ${cfg.tokenFile}`);
    }
    if (tokens.scope) console.log(`  granted scopes: ${tokens.scope}`);
  } catch (err) {
    failed = true;
    console.error(`Token state: MISSING or unreadable — ${err instanceof Error ? err.message : err}`);
    console.error('             Run "spotify-mcp auth" first.');
    console.error(`             file: ${cfg.tokenFile}`);
  }

  console.log('');
  console.log('Live probe: GET /me ...');
  const client = new SpotifyClient({ disableCache: true });
  try {
    const me = await client.get<{ id?: string; display_name?: string; product?: string; country?: string }>('/me');
    if (!me || !me.id) {
      failed = true;
      console.error('  FAIL — endpoint returned an empty profile.');
    } else {
      const extra = [
        me.product ? `product=${me.product}` : null,
        me.country ? `country=${me.country}` : null,
      ].filter(Boolean).join(' ');
      console.log(`  PASS — authenticated as ${me.display_name ?? me.id} (${me.id})${extra ? ' ' + extra : ''}`);
      if (me.product   === 'free' || me.product === 'open') {
        console.log('  NOTE — account is Free — playback control (play/pause/skip/seek/volume/queue) will 403; Premium required.');
      }
    }
  } catch (err) {
    failed = true;
    const detail =
      err instanceof SpotifyApiError
        ? `HTTP ${err.status}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    console.error(`  FAIL — ${detail}`);
  }

  console.log('');
  if (failed) {
    console.error('Doctor found problems. If this looks like an auth issue, re-run "spotify-mcp auth".');
    process.exit(1);
  }
  console.log('All checks passed.');
}

const HELP = `spotify-mcp — MCP server for the Spotify Web API

Usage:
  spotify-mcp            Start the MCP server over stdio (this is the default)
  spotify-mcp auth       Run the OAuth PKCE flow and save tokens
  spotify-mcp doctor     Check config, token state, and live API access (#62)
  spotify-mcp --help     Show this message
  spotify-mcp --version  Print the version

Environment:
  SPOTIFY_CLIENT_ID          Required (from developer.spotify.com dashboard)
  SPOTIFY_REDIRECT_URI       OAuth redirect URI (default http://127.0.0.1:8888/callback)
  SPOTIFY_HEADLESS           Set to 1 for browserless paste-flow auth
  SPOTIFY_MCP_TOKEN_FILE     Token file override (default ~/.spotify-mcp/tokens.json)
  SPOTIFY_MCP_MAX_ITEMS      Default per-call truncation cap (default 50)
  SPOTIFY_MCP_FETCH_ALL_CAP  Cap for fetch_all pagination walks (default 500)
  SPOTIFY_MCP_HISTORY        Set to 1 to log mutations to history JSONL
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
} else {
  startMcpServer().catch((err: unknown) => {
    console.error('Server error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
