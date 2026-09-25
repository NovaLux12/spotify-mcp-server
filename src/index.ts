import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { runAuthFlow, loadTokens } from './auth.js';
import { SpotifyClient, SpotifyApiError } from './client.js';
import { initConfig, DEFAULT_MAX_ITEMS } from './config.js';
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
import { registerExhaust2CatalogTools } from './tools/exhaust2_catalog.js';
import { registerExhaust2PlaybackTools } from './tools/exhaust2_playback.js';
import { registerExhaust2PlaylistsTools } from './tools/exhaust2_playlists.js';
import { registerExhaust2MiscTools } from './tools/exhaust2_misc.js';
import { registerExhaust2EnggatingTools } from './tools/exhaust2_enggating.js';
import { registerExhaust2ExtraTools } from './tools/exhaust2_extra.js';
import { registerEpisodeMgmtTools } from './tools/episodemgmt.js';
import { registerDoctorTool } from './tools/doctortool.js';
import { registerSwarm3PlaybackTools } from './tools/swarm3_playback.js';
import { registerSwarm3PlaylistopsTools } from './tools/swarm3_playlistops.js';
import { registerSwarm3DiscoveryTools } from './tools/swarm3_discovery.js';
import { registerSwarm3bDiscoveryTools } from './tools/swarm3b_discovery.js';
import { registerSwarm4PlaylistsTools } from './tools/swarm4_playlists.js';
import { registerSwarm3LibraryTools } from './tools/swarm3_library.js';
import { registerSwarm3ShowsTools } from './tools/swarm3_shows.js';
import { registerSwarm3AnalyticsTools } from './tools/swarm3_analytics.js';
import { registerStatsfmTasteTools } from './tools/statsfm_taste.js';
import { registerTasteCompositeTools } from './tools/taste_composites.js';
import { registerSwarm3RefsTools } from './tools/swarm3_refs.js';
import { registerSwarm3SnapshotsTools } from './tools/swarm3_snapshots.js';
import {
  applyToolAnnotations,
  assertToolNamingPolicy,
  removeDeprecatedToolAliases,
  toolErrorResult,
} from './tools/annotations.js';
import { registerSwarm3MetaTools } from './tools/swarm3_meta.js';
import { registerStatsfmTools } from './tools/statsfm.js';
import { verifyReceipt, formatReceipt } from './receipts.js';
import { registerTemplateResources } from './resources/templates.js';
import { z } from 'zod';
import { registerResources } from './resources/index.js';
import { registerPrompts } from './prompts/index.js';
import { TOOLSETS, resolveToolsets, assertToolsetsUsable, isModuleActive, resolveToolOverrides, toolsetEnvHelp } from './toolsets.js';
import { moduleBlockedByScopes, scopesFor } from './scopefilter.js';

import { createRequire } from 'node:module';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };
type ToolInput = { inputSchema?: unknown };
type RegistryHolder = { _registeredTools?: Record<string, object> };
type ToolCallInternals = {
  validateToolInput: (tool: ToolInput, args: unknown, name: string) => Promise<unknown>;
  executeToolHandler: (tool: ToolInput, args: unknown, extra: unknown) => Promise<unknown>;
  createToolError: (message: string) => unknown;
};
type ServerInternals = {
  server: { _requestHandlers?: Map<string, (...args: unknown[]) => Promise<unknown>> };
};

const UnknownArgumentSchema = z.object({
  tool: z.string().optional(),
  param: z.string().optional(),
  suggestions: z.array(z.string()).optional(),
});
const DEFAULTED_TOOLS: Readonly<Record<string, true>> = Object.freeze({
  search: true,
  get_saved_tracks: true,
  get_artist_top_tracks: true,
});

function installToolBoundary(server: McpServer): void {
  const internals = server as unknown as ToolCallInternals;
  const originalValidate = internals.validateToolInput.bind(server);
  const originalExecute = internals.executeToolHandler.bind(server);
  const names = new Map<object, string>();
  const registryHolder = server as unknown as RegistryHolder;
  const registry = registryHolder._registeredTools;
  if (registry && typeof registry === 'object') {
    for (const [name, entry] of Object.entries(registry)) names.set(entry, name);
  }

  internals.validateToolInput = async (tool, args, name) => {
    const schema = tool.inputSchema;
    const shape = schema && typeof schema === 'object' && 'shape' in schema ? schema.shape : undefined;
    const accepted = shape && typeof shape === 'object' && !Array.isArray(shape) ? Object.keys(shape) : [];
    if (args && typeof args === 'object' && !Array.isArray(args)) {
      const unknown = Object.keys(args).find((key) => !accepted.includes(key));
      if (unknown) {
        const suggestions = accepted
          .map((candidate) => ({ candidate, distance: Math.abs(candidate.length - unknown.length) }))
          .filter(({ candidate, distance }) => distance <= 3 && candidate.toLowerCase().includes(unknown.toLowerCase().slice(0, 2)))
          .sort((a, b) => a.distance - b.distance)
          .slice(0, 3)
          .map(({ candidate }) => candidate);
        throw new Error(`UNKNOWN_ARGUMENT:${JSON.stringify({ tool: name, param: unknown, suggestions })}`);
      }
    }
    return originalValidate(tool, args, name);
  };

  internals.executeToolHandler = async (tool, args, extra) => {
    const name = names.get(tool) ?? 'tool';
    try {
      const result = await originalExecute(tool, args, extra);
      if (!result || typeof result !== 'object' || !('content' in result) || !Array.isArray(result.content)) return result;
      const schema = tool.inputSchema;
      const shape = schema && typeof schema === 'object' && 'shape' in schema ? schema.shape : undefined;
      const accepted = shape && typeof shape === 'object' && !Array.isArray(shape) ? Object.keys(shape) : [];
      const actions: string[] = [];
      if (accepted.includes('max_results')) actions.push('raise max_results');
      if (accepted.includes('offset')) actions.push('pass offset');
      if (accepted.includes('fetch_all')) actions.push('set fetch_all=true');
      const advice = actions.length > 0 ? actions.join(', ') : 'narrow the query';
      let remaining: number | undefined;
      result.content = result.content.map((part: unknown) => {
        if (!part || typeof part !== 'object' || !('text' in part) || typeof part.text !== 'string') return part;
        return {
          ...part,
          text: part.text.replace(/\((\d+) more — pass offset or fetch_all\)/g, (_match, count: string) => {
            remaining = Number(count);
            return `(${count} more — ${advice})`;
          }),
        };
      });
      const structured = 'structuredContent' in result && result.structuredContent && typeof result.structuredContent === 'object'
        ? result.structuredContent
        : undefined;
      if (remaining !== undefined && structured) {
        Object.defineProperty(structured, 'truncated', { value: true, configurable: true, enumerable: true });
        Object.defineProperty(structured, 'remaining', { value: remaining, configurable: true, enumerable: true });
        const returned = 'items' in structured && Array.isArray(structured.items) ? structured.items.length : undefined;
        Object.defineProperty(structured, 'returned', { value: returned, configurable: true, enumerable: true });
        Object.defineProperty(structured, 'total', { value: typeof returned === 'number' ? returned + remaining : undefined, configurable: true, enumerable: true });
      }
      return result;
    } catch (error) {
      return toolErrorResult(name, error);
    }
  };

  internals.createToolError = (message) => {
    const unknownArgument = /^UNKNOWN_ARGUMENT:(\{.*\})$/.exec(message);
    if (unknownArgument) {
      try {
        const detail = UnknownArgumentSchema.safeParse(JSON.parse(unknownArgument[1]));
        if (detail.success) {
          return toolErrorResult(detail.data.tool ?? 'tool', message, {
            kind: 'unknown_param', param: detail.data.param, suggestions: detail.data.suggestions,
          });
        }
      } catch {
        return toolErrorResult('tool', message, { kind: 'unknown_param' });
      }
      return toolErrorResult('tool', message, { kind: 'unknown_param' });
    }
    const unknownTool = /^Tool (.+) not found$/.exec(message);
    if (unknownTool) return toolErrorResult(unknownTool[1], message, { kind: 'unknown_tool' });
    const validationTool = /Invalid arguments for tool ([^:]+):/.exec(message);
    return toolErrorResult(validationTool?.[1] ?? 'tool', message, { kind: message.includes('Input validation error') ? 'validation' : undefined });
  };

  const serverInternals = server as unknown as ServerInternals;
  const handlers = serverInternals.server._requestHandlers;
  const list = handlers?.get('tools/list');
  if (!handlers || !list) return;
  handlers.set('tools/list', async (...args: unknown[]) => {
    const response: unknown = await list(...args);
    if (!response || typeof response !== 'object' || !('tools' in response) || !Array.isArray(response.tools)) return response;
    for (const tool of response.tools) {
      if (!tool || typeof tool !== 'object' || !('name' in tool) || typeof tool.name !== 'string') continue;
      if (tool.name === 'list_show_episodes' && 'description' in tool && typeof tool.description === 'string') {
        tool.description = tool.description.replace('Default limit 20', 'Page size 50; use max_results to cap the response');
      }
      if (!('inputSchema' in tool)) continue;
      const schema = tool.inputSchema;
      if (!schema || typeof schema !== 'object' || Array.isArray(schema)) continue;
      if (!('properties' in schema)) continue;
      const properties = schema.properties;
      if (!properties || typeof properties !== 'object' || Array.isArray(properties)) continue;
      for (const [name, value] of Object.entries(properties)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        if (!('description' in value) || typeof value.description !== 'string' || value.description.trim().length === 0) {
          Object.defineProperty(value, 'description', { value: name, configurable: true, enumerable: true });
        }
        const defaultValue = 'default' in value ? value.default : undefined;
        if (defaultValue === undefined && name === 'offset' && Object.hasOwn(DEFAULTED_TOOLS, tool.name)) Object.defineProperty(value, 'default', { value: 0, configurable: true, enumerable: true });
        if (defaultValue === undefined && name === 'fetch_all' && Object.hasOwn(DEFAULTED_TOOLS, tool.name)) Object.defineProperty(value, 'default', { value: false, configurable: true, enumerable: true });
        if (defaultValue === undefined && name === 'max_results' && Object.hasOwn(DEFAULTED_TOOLS, tool.name)) Object.defineProperty(value, 'default', { value: DEFAULT_MAX_ITEMS, configurable: true, enumerable: true });
      }
    }
    return response;
  });
}

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
  // stats.fm taste intelligence (v2 taste track): read-only public API, no
  // auth, no Spotify scopes — record_feedback is local-only memory. No
  // readOnly gate: nothing here mutates Spotify state.
  if (isModuleActive('taste', activeSets, overrides)) registerStatsfmTasteTools(server, client)
  // Wave-2 taste composites (registration key `tastecomposites`, taste set):
  // read-only stats.fm composites, no Spotify scopes — same treatment as taste.
  if (isModuleActive('tastecomposites', activeSets, overrides)) registerTasteCompositeTools(server, client)
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
  if (!readOnly && isModuleActive('artistwatch', activeSets, overrides) && !moduleBlockedByScopes('catalog', grantedScopes)) registerArtistWatchTools(server, client)
  if (isModuleActive('searchhistory', activeSets, overrides) && !moduleBlockedByScopes('search', grantedScopes)) registerSearchHistoryTools(server, client)
  // Exhaust misc mop-up (search_within_playlist, search_history_stats, audiobook_progress + 7 deferred) — playlists+library set
  if (!readOnly && isModuleActive('playlists', activeSets, overrides)) registerExhaustMiscTools(server, client)
  if (isModuleActive('exhaust2catalog', activeSets, overrides) && !moduleBlockedByScopes('catalog', grantedScopes)) registerExhaust2CatalogTools(server, client)
  if (!readOnly && isModuleActive('exhaust2playback', activeSets, overrides) && !moduleBlockedByScopes('playback', grantedScopes)) registerExhaust2PlaybackTools(server, client)
  if (!readOnly && isModuleActive('exhaust2playlists', activeSets, overrides) && !moduleBlockedByScopes('playlists', grantedScopes)) registerExhaust2PlaylistsTools(server, client)
  if (!readOnly && isModuleActive('exhaust2misc', activeSets, overrides) && !moduleBlockedByScopes('library', grantedScopes)) registerExhaust2MiscTools(server, client)
  if (isModuleActive('exhaust2enggating', activeSets, overrides) && !moduleBlockedByScopes('catalog', grantedScopes)) registerExhaust2EnggatingTools(server, client)
  if (!readOnly && isModuleActive('exhaust2extra', activeSets, overrides) && !moduleBlockedByScopes('playlists', grantedScopes)) registerExhaust2ExtraTools(server, client)
  // library analytics + portability + episode management
  if (isModuleActive('libraryanalytics', activeSets, overrides) && !moduleBlockedByScopes('library', grantedScopes)) registerLibraryAnalyticsTools(server, client)
  if (!readOnly && isModuleActive('portability', activeSets, overrides) && !moduleBlockedByScopes('library', grantedScopes)) registerPortabilityTools(server, client)
  if (!readOnly && isModuleActive('episodemgmt', activeSets, overrides) && !moduleBlockedByScopes('library', grantedScopes)) registerEpisodeMgmtTools(server, client)
  // playlist health + batch + misc
  if (!readOnly && isModuleActive('playlisthealth', activeSets, overrides) && !moduleBlockedByScopes('playlists', grantedScopes)) registerPlaylistHealthTools(server, client)
  if (!readOnly && isModuleActive('playlistbatch', activeSets, overrides) && !moduleBlockedByScopes('playlists', grantedScopes)) registerPlaylistBatchTools(server, client)
  if (!readOnly && isModuleActive('playlistmisc', activeSets, overrides) && !moduleBlockedByScopes('playlists', grantedScopes)) registerPlaylistMiscTools(server, client)
  // playback/queue extensions
  if (!readOnly && isModuleActive('queueops', activeSets, overrides) && !moduleBlockedByScopes('playback', grantedScopes)) registerQueueOpsTools(server, client)
  if (!readOnly && isModuleActive('playbackext', activeSets, overrides) && !moduleBlockedByScopes('playback', grantedScopes)) registerPlaybackExtTools(server, client)
  if (!readOnly && isModuleActive('playbackintel', activeSets, overrides) && !moduleBlockedByScopes('playback', grantedScopes)) registerPlaybackIntelTools(server, client)
  // spotify_doctor diagnostic (#111): unconditional — must survive toolset trimming.
  registerDoctorTool(server, client);

  // swarm3 500-tool push (issue #442): one registration key per slice file.
  if (!readOnly && isModuleActive('swarm3playback', activeSets, overrides) && !moduleBlockedByScopes('playback', grantedScopes)) registerSwarm3PlaybackTools(server, client)
  if (!readOnly && isModuleActive('swarm3playlistops', activeSets, overrides) && !moduleBlockedByScopes('playlists', grantedScopes)) registerSwarm3PlaylistopsTools(server, client)
  if (isModuleActive('swarm3discovery', activeSets, overrides) && !moduleBlockedByScopes('catalog', grantedScopes)) registerSwarm3DiscoveryTools(server, client)
  if (isModuleActive('swarm3bdiscovery', activeSets, overrides) && !moduleBlockedByScopes('catalog', grantedScopes)) registerSwarm3bDiscoveryTools(server, client)
  if (isModuleActive('swarm3library', activeSets, overrides) && !moduleBlockedByScopes('library', grantedScopes)) registerSwarm3LibraryTools(server, client)
  if (!readOnly && isModuleActive('swarm3shows', activeSets, overrides) && !moduleBlockedByScopes('catalog', grantedScopes)) registerSwarm3ShowsTools(server, client)
  if (isModuleActive('swarm3analytics', activeSets, overrides) && !moduleBlockedByScopes('personalization', grantedScopes)) registerSwarm3AnalyticsTools(server, client)
  if (isModuleActive('swarm3refs', activeSets, overrides) && !moduleBlockedByScopes('catalog', grantedScopes)) registerSwarm3RefsTools(server, client)
  if (!readOnly && isModuleActive('swarm3snapshots', activeSets, overrides) && !moduleBlockedByScopes('playlists', grantedScopes)) registerSwarm3SnapshotsTools(server, client)
  // Discovery tools (find_tool/inspect_tool/toolset_report) — always registered (like doctor) so minimal toolsets
  // (playback+playlists) can still discover the surface; discovery/catalog sets also gate via ENABLE_TOOLS for compat.
  if (!moduleBlockedByScopes('catalog', grantedScopes)) registerSwarm3MetaTools(server, client)
  if (!readOnly && isModuleActive('swarm4playlists', activeSets, overrides) && !moduleBlockedByScopes('playlists', grantedScopes)) registerSwarm4PlaylistsTools(server, client)
  // stats.fm (third-party public API, no Spotify auth/scopes): read-only,
  // so it stays registered under READONLY like backup_library.
  if (isModuleActive('statsfm', activeSets, overrides)) registerStatsfmTools(server)
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
  // Scenes deliberately share the semantic `playback` registration key: trimming
  // the playback toolset also trims scene registration.
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
  const removedAliases = removeDeprecatedToolAliases(server);
  if (removedAliases.length > 0) console.error(`[spotify-mcp] retired tool aliases: ${removedAliases.join(', ')}`);
  const registryHolder = server as unknown as RegistryHolder;
  assertToolNamingPolicy(Object.keys(registryHolder._registeredTools ?? {}));
  installToolBoundary(server);

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
