import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { runAuthFlow, loadTokens } from './auth.js';
import { SpotifyClient, SpotifyApiError } from './client.js';
import { initConfig } from './config.js';
import { registerPlaybackTools } from './tools/playback.js';
import { registerSearchTools } from './tools/search.js';
import { registerCatalogTools } from './tools/catalog.js';
import { registerPersonalizationTools } from './tools/personalization.js';
import { registerLibraryTools } from './tools/library.js';
import { registerFollowingTools } from './tools/following.js';
import { registerAudiobookTools } from './tools/audiobooks.js';
import { registerPlaylistTools } from './tools/playlists.js';
import { registerUsersTools } from './tools/users.js';
import { registerPlaylistOpsTools } from './tools/playlistops.js';
import { registerLibraryInsightsTools } from './tools/libraryinsights.js';
import { registerFreshnessTools } from './tools/freshness.js';
import { registerSearchDeepTool } from './tools/searchdive.js';
import { registerPodcastSessionTools } from './tools/podcastsession.js';
import { registerAudiobookCopilotTools } from './tools/audiobookcopilot.js';
import { registerScenesTools } from './tools/scenes.js';
import { registerPlaylistDnaTools } from './tools/playlistdna.js';
import { registerAnalyticsTools } from './tools/analytics.js';
import { verifyReceipt, formatReceipt } from './receipts.js';
import { registerTemplateResources } from './resources/templates.js';
import { z } from 'zod';
import { registerResources } from './resources/index.js';
import { registerPrompts } from './prompts/index.js';
import { TOOLSETS, resolveToolsets, isActive, toolsetEnvHelp } from './toolsets.js';
import { createRequire } from 'node:module';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

async function startMcpServer(): Promise<void> {
  // Read the SPOTIFY_MCP_* env family once; everything else consumes
  // getConfig() from here on.
  initConfig();

  const server = new McpServer({
    name: 'spotify-mcp',
    version,
  });

  // Toolset segmentation (#95): SPOTIFY_MCP_TOOLSETS=playlists,player,... trims
  // the registered surface for clients that cap tool counts. Default: all.
  const { sets: activeSets, unknown } = resolveToolsets(process.env.SPOTIFY_MCP_TOOLSETS);
  if (unknown.length > 0) {
    console.error(`[spotify-mcp] unknown toolset(s) ignored: ${unknown.join(', ')} — ${toolsetEnvHelp()}`);
  }
  if (activeSets.size < Object.keys(TOOLSETS).length) {
    console.error(`[spotify-mcp] active toolsets: ${[...activeSets].sort().join(', ')}`);
  }

  const client = new SpotifyClient();

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

  if (isActive('playback', activeSets)) registerPlaybackTools(server, client);
  if (isActive('search', activeSets)) registerSearchTools(server, client);
  if (isActive('catalog', activeSets)) registerCatalogTools(server, client);
  if (isActive('personalization', activeSets)) registerPersonalizationTools(server, client);
  // Listening analytics (#97): derived taste-profile reporting.
  if (isActive('personalization', activeSets)) registerAnalyticsTools(server, client);
  if (isActive('following', activeSets)) registerFollowingTools(server, client);
  if (isActive('audiobooks', activeSets)) registerAudiobookTools(server, client);
  if (isActive('playlists', activeSets)) registerPlaylistTools(server, client);
  if (isActive('users', activeSets)) registerUsersTools(server, client);
  if (isActive('library', activeSets)) registerLibraryTools(server, client);
  // Playlist power ops (#96): merge/diff/overlap — part of the playlists set.
  if (isActive('playlists', activeSets)) registerPlaylistOpsTools(server, client);
  // Playlist DNA (#112 idea 6): read-only co-occurrence curation.
  if (isActive('playlists', activeSets)) registerPlaylistDnaTools(server, client);
  // Differentiation wave (#112): library insights, freshness radar, deep search.
  if (isActive('library', activeSets)) registerLibraryInsightsTools(server, client);
  if (isActive('following', activeSets)) registerFreshnessTools(server, client);
  if (isActive('search', activeSets)) registerSearchDeepTool(server, client);
  // Wave-4 (#112): podcast sessions, audiobook copilot, scenes + wind-down.
  if (isActive('library', activeSets)) registerPodcastSessionTools(server, client);
  if (isActive('audiobooks', activeSets)) registerAudiobookCopilotTools(server, client);
  if (isActive('playback', activeSets)) registerScenesTools(server, client);
  // Resource templates ride with the resources set.
  if (isActive('resources', activeSets)) registerTemplateResources(server, client);
  if (isActive('resources', activeSets)) registerResources(server, client);
  if (isActive('prompts', activeSets)) registerPrompts(server);

  // Mutation receipts (#112 idea 11): verify_receipt looks up a stored
  // receipt id and reports post-mutation verification status.
  if (isActive('library', activeSets)) {
    server.tool(
      'verify_receipt',
      'Verify that a previous mutation actually landed on Spotify by looking up its receipt',
      { receipt_id: z.string().min(1).describe('Receipt ID from a receipt-bearing mutation result') },
      async (args) => {
        const receipt = verifyReceipt(args.receipt_id);
        if (!receipt) {
          return { content: [{ type: 'text', text: `Unknown receipt "${args.receipt_id}" — receipts are kept for the most recent 100 mutations.` }] };
        }
        return { content: [{ type: 'text', text: formatReceipt(receipt) }], structuredContent: { ...receipt } };
      },
    );
  }

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
  console.log(`  redirect URI      ${cfg.redirectUri}`);
  console.log(`  headless          ${cfg.headless ? 'yes' : 'no'}`);
  console.log(`  max items         ${cfg.maxItems}`);
  console.log(`  fetch-all cap     ${cfg.fetchAllCap}`);
  console.log(`  mutation history  ${cfg.historyEnabled ? 'enabled' : 'disabled'}`);

  console.log('');
  try {
    const tokens = await loadTokens();
    const msLeft = tokens.expires_at - Date.now();
    if (msLeft <= 0) {
      console.log('Token state: EXPIRED — the next API call will attempt an automatic refresh.');
    } else if (msLeft < 60_000) {
      console.log(
        `Token state: expiring in ${Math.round(msLeft / 1000)}s — will auto-refresh on next use.`,
      );
    } else {
      const mins = Math.floor(msLeft / 60_000);
      const hours = Math.floor(mins / 60);
      console.log(
        `Token state: valid, expires at ${new Date(tokens.expires_at).toISOString()} ` +
          `(in ${hours > 0 ? `${hours}h ` : ''}${mins % 60}m).`,
      );
    }
  } catch (err) {
    failed = true;
    console.error(`Token state: MISSING or unreadable — ${err instanceof Error ? err.message : err}`);
    console.error('             Run "spotify-mcp auth" first.');
  }

  console.log('');
  console.log('Live probe: GET /me ...');
  const client = new SpotifyClient({ disableCache: true });
  try {
    const me = await client.get<{ id?: string; display_name?: string }>('/me');
    if (!me || !me.id) {
      failed = true;
      console.error('  FAIL — endpoint returned an empty profile.');
    } else {
      console.log(`  PASS — authenticated as ${me.display_name ?? me.id} (${me.id})`);
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
