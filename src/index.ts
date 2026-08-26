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
import { registerExportTools } from './tools/export.js';
import { registerImportTools } from './tools/import.js';
import { registerSmartTools } from './tools/smart.js';
import { registerShowRadarTools } from './tools/showradar.js';
import { registerSavedDedupeTools } from './tools/saveddedupe.js';
import { registerBackupTools } from './tools/backup.js';
import { registerRestoreTools } from './tools/restore.js';
import { registerUndoTools } from './tools/undo.js';
import { registerBackupFirstTools } from './tools/backupfirst.js';
import { registerLibraryHygieneTools } from './tools/libraryhygiene.js';
import { registerBrowseTools } from './tools/browse.js';
import { registerArtistWatchTools } from './tools/artistwatch.js';
import { registerLibraryAnalyticsTools } from './tools/libraryanalytics.js';
import { registerPlaylistHealthTools } from './tools/playlisthealth.js';
import { registerPlaylistBatchTools } from './tools/playlistbatch.js';
import { registerPlaylistMiscTools } from './tools/playlistmisc.js';
import { registerPortabilityTools } from './tools/portability.js';
import { registerQueueOpsTools } from './tools/queueops.js';
import { registerPlaybackExtTools } from './tools/playbackext.js';
import { registerPlaybackIntelTools } from './tools/playbackintel.js';
import { registerSearchHistoryTools } from './tools/searchhistory.js';
import { registerExhaustMiscTools } from './tools/exhaustmisc.js';
import { registerEpisodeMgmtTools } from './tools/episodemgmt.js';
import { registerDoctorTool } from './tools/doctortool.js';
import { verifyReceipt, formatReceipt } from './receipts.js';
import { registerTemplateResources } from './resources/templates.js';
import { z } from 'zod';
import { registerResources } from './resources/index.js';
import { registerPrompts } from './prompts/index.js';
import { TOOLSETS, resolveToolsets, isModuleActive, resolveToolOverrides, toolsetEnvHelp } from './toolsets.js';
import { moduleBlockedByScopes, scopesFor } from './scopefilter.js';
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
    console.error(`[spotify-mcp] unknown toolset(s) ignored: ${unknown.join(', ')} — ${toolsetEnvHelp()}`);
  }
  if (activeSets.size < Object.keys(TOOLSETS).length) {
    console.error(`[spotify-mcp] active toolsets: ${[...activeSets].sort().join(', ')}`);
  }

  const client = new SpotifyClient();

  // Scope-aware hiding (#111 item 6): granted scopes come from the persisted
  // token file; fail-open (empty set blocks nothing) for pre-scope files.
  const grantedScopes = await loadTokens()
    .then((t) => scopesFor(t.scope))
    .catch(() => scopesFor(undefined));

  // SPOTIFY_MCP_READONLY=1 hides every write-capable module regardless of
  // granted scopes — for users who want hard guarantees, not conventions.
  const readOnly = ['1', 'true', 'yes'].includes(
    (process.env.SPOTIFY_MCP_READONLY ?? '').toLowerCase(),
  );
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

  if (!readOnly && isModuleActive('playback', activeSets, overrides) && !moduleBlockedByScopes('playback', grantedScopes)) registerPlaybackTools(server, client)
  if (isModuleActive('search', activeSets, overrides) && !moduleBlockedByScopes('search', grantedScopes)) registerSearchTools(server, client)
  if (isModuleActive('catalog', activeSets, overrides) && !moduleBlockedByScopes('catalog', grantedScopes)) registerCatalogTools(server, client)
  if (isModuleActive('personalization', activeSets, overrides) && !moduleBlockedByScopes('personalization', grantedScopes)) registerPersonalizationTools(server, client)
  // Listening analytics (#97): derived taste-profile reporting.
  if (isModuleActive('personalization', activeSets, overrides) && !moduleBlockedByScopes('personalization', grantedScopes)) registerAnalyticsTools(server, client)
  // Library hygiene (#112 idea 5): album completion + consolidation findings.
  if (!readOnly && isModuleActive('library', activeSets, overrides) && !moduleBlockedByScopes('library', grantedScopes)) registerLibraryHygieneTools(server, client)
  // Library backup (#159) + strictly-additive restore (#160). Backup is
  // read-only (Spotify → local sidecar) so it stays visible in READONLY,
  // but both still require library scopes like every other library read.
  if (isModuleActive('library', activeSets, overrides) && !moduleBlockedByScopes('library', grantedScopes)) {
    if (!readOnly) registerRestoreTools(server, client)
    registerBackupTools(server, client)
  }
  // Big-release streams (wired centrally to avoid per-stream index conflicts):
  // catalog/browse
  if (isModuleActive('browse', activeSets, overrides) && !moduleBlockedByScopes('catalog', grantedScopes)) registerBrowseTools(server, client)
  if (isModuleActive('artistwatch', activeSets, overrides) && !moduleBlockedByScopes('catalog', grantedScopes)) registerArtistWatchTools(server, client)
  if (isModuleActive('searchhistory', activeSets, overrides) && !moduleBlockedByScopes('search', grantedScopes)) registerSearchHistoryTools(server, client)
  // Exhaust misc mop-up (search_within_playlist, search_history_stats, audiobook_progress + 7 deferred) — playlists+library set
  if (isModuleActive('playlists', activeSets, overrides)) registerExhaustMiscTools(server, client)
  // library analytics + portability + episode management
  if (isModuleActive('libraryanalytics', activeSets, overrides) && !moduleBlockedByScopes('library', grantedScopes)) registerLibraryAnalyticsTools(server, client)
  if (!readOnly && isModuleActive('portability', activeSets, overrides) && !moduleBlockedByScopes('library', grantedScopes)) registerPortabilityTools(server, client)
  if (!readOnly && isModuleActive('episodemgmt', activeSets, overrides) && !moduleBlockedByScopes('library', grantedScopes)) registerEpisodeMgmtTools(server, client)
  // playlist health + batch + misc
  if (isModuleActive('playlisthealth', activeSets, overrides) && !moduleBlockedByScopes('playlists', grantedScopes)) registerPlaylistHealthTools(server, client)
  if (!readOnly && isModuleActive('playlistbatch', activeSets, overrides) && !moduleBlockedByScopes('playlists', grantedScopes)) registerPlaylistBatchTools(server, client)
  if (!readOnly && isModuleActive('playlistmisc', activeSets, overrides) && !moduleBlockedByScopes('playlists', grantedScopes)) registerPlaylistMiscTools(server, client)
  // playback/queue extensions
  if (!readOnly && isModuleActive('queueops', activeSets, overrides) && !moduleBlockedByScopes('playback', grantedScopes)) registerQueueOpsTools(server, client)
  if (!readOnly && isModuleActive('playbackext', activeSets, overrides) && !moduleBlockedByScopes('playback', grantedScopes)) registerPlaybackExtTools(server, client)
  if (isModuleActive('playback', activeSets, overrides) && !moduleBlockedByScopes('playback', grantedScopes)) registerPlaybackIntelTools(server, client)
  // spotify_doctor diagnostic (#111): unconditional — must survive toolset trimming.
  registerDoctorTool(server, client);
  if (!readOnly && isModuleActive('following', activeSets, overrides) && !moduleBlockedByScopes('following', grantedScopes)) registerFollowingTools(server, client)
  if (!readOnly && isModuleActive('audiobooks', activeSets, overrides) && !moduleBlockedByScopes('audiobooks', grantedScopes)) registerAudiobookTools(server, client)
  if (!readOnly && isModuleActive('playlists', activeSets, overrides) && !moduleBlockedByScopes('playlists', grantedScopes)) registerPlaylistTools(server, client)
  if (!readOnly && isModuleActive('users', activeSets, overrides) && !moduleBlockedByScopes('users', grantedScopes)) registerUsersTools(server, client)
  if (!readOnly && isModuleActive('library', activeSets, overrides) && !moduleBlockedByScopes('library', grantedScopes)) registerLibraryTools(server, client)
  // Playlist power ops (#96): merge/diff/overlap — part of the playlists set.
  if (!readOnly && isModuleActive('playlists', activeSets, overrides) && !moduleBlockedByScopes('playlists', grantedScopes)) registerPlaylistOpsTools(server, client)
  // Playlist DNA (#112 idea 6): read-only co-occurrence curation.
  if (!readOnly && isModuleActive('playlists', activeSets, overrides) && !moduleBlockedByScopes('playlists', grantedScopes)) registerPlaylistDnaTools(server, client)
  // Export (#155), import (#165) + saved-dedupe (#156): portability and hygiene.
  if (!readOnly && isModuleActive('playlists', activeSets, overrides) && !moduleBlockedByScopes('playlists', grantedScopes)) registerExportTools(server, client)
  if (!readOnly && isModuleActive('playlists', activeSets, overrides) && !moduleBlockedByScopes('playlists', grantedScopes)) registerImportTools(server, client)
  // Smart playlists (#172): rule-based generation from own listening data.
  if (!readOnly && isModuleActive('playlists', activeSets, overrides) && !moduleBlockedByScopes('playlists', grantedScopes)) registerSmartTools(server, client)
  // Show episode radar (#173): new-episode radar across saved podcast shows.
  if (isModuleActive('library', activeSets, overrides) && !moduleBlockedByScopes('library', grantedScopes)) registerShowRadarTools(server, client)
  if (!readOnly && isModuleActive('library', activeSets, overrides) && !moduleBlockedByScopes('library', grantedScopes)) registerSavedDedupeTools(server, client)
  // Differentiation wave (#112): library insights, freshness radar, deep search.
  if (!readOnly && isModuleActive('library', activeSets, overrides) && !moduleBlockedByScopes('library', grantedScopes)) registerLibraryInsightsTools(server, client)
  if (!readOnly && isModuleActive('following', activeSets, overrides) && !moduleBlockedByScopes('following', grantedScopes)) registerFreshnessTools(server, client)
  if (isModuleActive('search', activeSets, overrides) && !moduleBlockedByScopes('search', grantedScopes)) registerSearchDeepTool(server, client)
  // Wave-4 (#112): podcast sessions, audiobook copilot, scenes + wind-down.
  if (!readOnly && isModuleActive('library', activeSets, overrides) && !moduleBlockedByScopes('library', grantedScopes)) registerPodcastSessionTools(server, client)
  if (!readOnly && isModuleActive('audiobooks', activeSets, overrides) && !moduleBlockedByScopes('audiobooks', grantedScopes)) registerAudiobookCopilotTools(server, client)
  if (!readOnly && isModuleActive('playback', activeSets, overrides) && !moduleBlockedByScopes('playback', grantedScopes)) registerScenesTools(server, client)
  // Resource templates ride with the resources set — read-only surfaces stay visible under READONLY (like backup).
  if (isModuleActive('resources', activeSets, overrides) && !moduleBlockedByScopes('resources', grantedScopes)) registerTemplateResources(server, client)
  if (isModuleActive('resources', activeSets, overrides) && !moduleBlockedByScopes('resources', grantedScopes)) registerResources(server, client)
  if (isModuleActive('prompts', activeSets, overrides) && !moduleBlockedByScopes('prompts', grantedScopes)) registerPrompts(server);

  // backup_first is read-only (GETs only) — visible under READONLY like backup_library
  if (isModuleActive('library', activeSets, overrides) && !moduleBlockedByScopes('library', grantedScopes)) {
    registerBackupFirstTools(server, client);
  }
  // undo is write-capable — hidden under READONLY like other mutators
  if (!readOnly && isModuleActive('library', activeSets, overrides) && !moduleBlockedByScopes('library', grantedScopes)) {
    registerUndoTools(server, client);
  }

  // Mutation receipts (#112 idea 11): verify_receipt is a read-only lookup — stays visible under READONLY.
  if (isModuleActive('library', activeSets, overrides) && !moduleBlockedByScopes('library', grantedScopes)) {
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
