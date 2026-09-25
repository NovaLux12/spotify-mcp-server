/**
 * MCP tool annotations (#565 / A0-002, A4-005).
 *
 * Before this module, 0 of 608 tools carried `annotations`, so a host could not
 * tell `get_track` (safe read) from `remove_duplicate_playlist_items` (destroys
 * playlist rows) and had to either prompt for everything or nothing. The SDK
 * projects `annotations` straight from its registry and exposes
 * `registeredTool.update({ annotations })` — so classification is applied once,
 * after registration, from this table rather than at 500+ call sites.
 *
 * Classification is FAIL-CLOSED: a tool is read-only only when its name starts
 * with an allowlisted non-mutating verb AND does not start with a mutating one —
 * except for the plans and previews listed in NEVER_MUTATING_PLANS below. Name
 * suffixes alone prove nothing: most `dry_run`-carrying `*_plan` tools accept a
 * commit path, so a new plan/preview tool defaults to "write" until someone
 * verifies its handler and adds it to that set. Anything unknown advertises as
 * a write and the host keeps its confirmation.
 *
 * Wire cost is kept low on purpose (the host pays it every session):
 *  - read-only tools emit `{ readOnlyHint: true }` (+ `idempotentHint` when true);
 *  - destructive tools emit `{ destructiveHint: true }`;
 *  - other writes emit `{ destructiveHint: false }`, because MCP's default for
 *    `destructiveHint` is TRUE — omitting it would advertise `save_to_library`
 *    as dangerous as `remove_saved_items`;
 *  - no `title` (hosts fall back to the tool name; duplicating it cost ~25 KB).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { registerPlaybackTools } from './playback.js';
import { registerSearchTools } from './search.js';
import { registerCatalogTools } from './catalog.js';
import { registerPersonalizationTools } from './personalization.js';
import { registerLibraryTools } from './library.js';
import { registerFollowingTools } from './following.js';
import { registerAudiobookTools } from './audiobooks.js';
import { registerPlaylistTools } from './playlists.js';
import { registerUsersTools } from './users.js';
import { registerPlaylistOpsTools } from './playlistops.js';
import { registerLibraryInsightsTools } from './libraryinsights.js';
import { registerFreshnessTools } from './freshness.js';
import { registerSearchDeepTool } from './searchdive.js';
import { registerPodcastSessionTools } from './podcastsession.js';
import { registerAudiobookCopilotTools } from './audiobookcopilot.js';
import { registerScenesTools } from './scenes.js';
import { registerPlaylistDnaTools } from './playlistdna.js';
import { registerAnalyticsTools } from './analytics.js';
import { registerExportTools } from './export.js';
import { registerImportTools } from './import.js';
import { registerSmartTools } from './smart.js';
import { registerShowRadarTools } from './showradar.js';
import { registerSavedDedupeTools } from './saveddedupe.js';
import { registerBackupTools } from './backup.js';
import { registerRestoreTools } from './restore.js';
import { registerUndoTools } from './undo.js';
import { registerBackupFirstTools } from './backupfirst.js';
import { registerLibraryHygieneTools } from './libraryhygiene.js';
import { registerBrowseTools } from './browse.js';
import { registerArtistWatchTools } from './artistwatch.js';
import { registerLibraryAnalyticsTools } from './libraryanalytics.js';
import { registerPlaylistHealthTools } from './playlisthealth.js';
import { registerPlaylistBatchTools } from './playlistbatch.js';
import { registerPlaylistMiscTools } from './playlistmisc.js';
import { registerPortabilityTools } from './portability.js';
import { registerQueueOpsTools } from './queueops.js';
import { registerPlaybackExtTools } from './playbackext.js';
import { registerPlaybackIntelTools } from './playbackintel.js';
import { registerSearchHistoryTools } from './searchhistory.js';
import { registerExhaustMiscTools } from './exhaustmisc.js';
import { registerExhaust2CatalogTools } from './exhaust2_catalog.js';
import { registerExhaust2PlaybackTools } from './exhaust2_playback.js';
import { registerExhaust2PlaylistsTools } from './exhaust2_playlists.js';
import { registerExhaust2MiscTools } from './exhaust2_misc.js';
import { registerExhaust2EnggatingTools } from './exhaust2_enggating.js';
import { registerExhaust2ExtraTools } from './exhaust2_extra.js';
import { registerEpisodeMgmtTools } from './episodemgmt.js';
import { registerDoctorTool } from './doctortool.js';
import { registerSwarm3PlaybackTools } from './swarm3_playback.js';
import { registerSwarm3PlaylistopsTools } from './swarm3_playlistops.js';
import { registerSwarm3DiscoveryTools } from './swarm3_discovery.js';
import { registerSwarm3bDiscoveryTools } from './swarm3b_discovery.js';
import { registerSwarm4PlaylistsTools } from './swarm4_playlists.js';
import { registerSwarm3LibraryTools } from './swarm3_library.js';
import { registerSwarm3ShowsTools } from './swarm3_shows.js';
import { registerSwarm3AnalyticsTools } from './swarm3_analytics.js';
import { registerStatsfmTasteTools } from './statsfm_taste.js';
import { registerTasteCompositeTools } from './taste_composites.js';
import { registerSwarm3RefsTools } from './swarm3_refs.js';
import { registerSwarm3SnapshotsTools } from './swarm3_snapshots.js';
import { registerSwarm3MetaTools } from './swarm3_meta.js';
import { registerStatsfmTools } from './statsfm.js';
import { formatReceipt, verifyReceipt } from '../receipts.js';
import { z } from 'zod';
import * as z4 from 'zod/v4-mini';

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * Reads can only start with one of these. Being an allowlist is the point: a new
 * mutating tool whose name we failed to anticipate defaults to "write".
 */
const READ_ONLY_PREFIXES =
  /^(get|list|search|check|inspect|find|show|describe|report|count|is|has|read|lookup|compare|diff|history|stats|statsfm|summary|summarize|summarise|analyze|analyse|validate|estimate|diagnose|resolve|quiz|census|audit|review|coverage|timeline|heatmap|trends?|insights?|distribution|breakdown|matrix|explorer|probe|digest|briefing|radar|where)/;

/**
 * Writes. Bare `plan` is deliberately NOT in this list: a `_plan` suffix alone
 * is not evidence of mutation, so plans are classified by capability via
 * NEVER_MUTATING_PLANS instead.
 */
const MUTATING_PREFIXES =
  /^(apply|start|save|add|create|update|set|replace|import|move|copy|remove|delete|unfollow|unsave|follow|pin|fill|merge|split|sort|shuffle|reorder|transfer|restore|cancel|clean|clear|trim|cull|archive|mark|queue|play|pause|skip|seek|generate|grow|balance|reschedule|migrate|handoff|dj|undo|export|backup|write|upload|rename|retag|sync|dedupe|take|snapshot|volume|sleep|transfer_playback|recently|retry|revert|reset|purge|wipe|drop|erase|revoke|disconnect|logout)/;

/** Irreversible operations: they delete or overwrite user data. */
const DESTRUCTIVE_PREFIXES =
  /^(remove|delete|unfollow|unsave|replace|overwrite|purge|wipe|clear|clean|cull|trim|drop|erase|revoke|reset|empty|trash|garbage|strip)/;

/** Names whose behaviour the verb patterns cannot infer. They win outright. */
const OVERRIDES: Record<string, ToolAnnotations> = {
  verify_receipt: { readOnlyHint: true, idempotentHint: true },
  spotify_doctor: { readOnlyHint: true, idempotentHint: true },
  // Writes that read like reads, and reads that read like writes.
  export_playlist: { destructiveHint: false },
  export_all_playlists: { destructiveHint: false },
  export_library: { destructiveHint: false },
  backup_library: { destructiveHint: false },
  play: { destructiveHint: false },
  pause: { destructiveHint: false },
  next_track: { destructiveHint: false },
  previous_track: { destructiveHint: false },
  undo_mutation: { destructiveHint: false },
  undo_last_mutation: { destructiveHint: false },
  // (No read-only overrides for undo_preview / restore_playlist_plan here — they
  // live in NEVER_MUTATING_PLANS below with the per-handler audit notes.)
  restore_playback: { destructiveHint: false },
  restore_playlist_from_snapshot: { destructiveHint: true },
  apply_snapshot_changes: { destructiveHint: true },
  merge_snapshot_changes: { destructiveHint: true },
};
/**
 * Plans and previews whose handlers provably never mutate — each entry was
 * verified against its handler (GET/local-file reads and local computation
 * only; no `client.post/put/delete`, no local file writes, no commit branch):
 *
 * - undo_preview (exhaust2_misc.ts) — verifyReceipt plus one optional playlist
 *   GET; the description's own dry-run framing matches the code.
 * - decade_sampler_plan (swarm3_discovery.ts) — saved-album walks only.
 * - album_representative_plan (swarm3_discovery.ts) — GET /albums/{id} plus a
 *   paged tracks walk; returns a sampling computation.
 * - front_to_back_plan (swarm3_discovery.ts) — GET /albums/{id} plus a paged
 *   tracks walk; returns cumulative start times.
 * - plan_volume_level_across_devices (swarm3_playback.ts) — device GETs, then
 *   returns PUT call *strings*; nothing is executed.
 * - queue_prune_plan (swarm3_playback.ts) — queue GET only; there is no
 *   queue-removal endpoint, so the output can only be acted on by playing it.
 * - sleep_timer_plan (swarm3_playback.ts) — queue GET plus a greedy fill;
 *   the "final pause call" is returned as data, not issued.
 * - sort_playlist_plan (swarm3_playlistops.ts) — GET plus a pure in-memory
 *   reorder; the commit path lives in the separate sort_playlist_apply.
 * - playlist_union_preview (swarm3_playlistops.ts) — GET plus exclusivity
 *   stats; no dry_run param exists at all.
 * - dedupe_playlist_plan (swarm3_playlistops.ts) — GET plus a duplicate
 *   census; its description names dedupe_playlist_apply as the committer.
 * - stale_saved_shows_plan (swarm3_shows.ts) — GET plus prune-candidate
 *   computation; "read-only by design … never unfollows anything".
 * - mark_episode_played_plan (swarm3_shows.ts) — GET resume points; "Read-only
 *   by design" because Spotify removed the mark-played API (#230).
 * - show_backlog_plan (swarm3_shows.ts) — GET plus ordering; "dry-run only,
 *   never mutates".
 * - restore_playlist_plan (swarm3_snapshots.ts) — live-state GET plus snapshot
 *   file reads; "Read-only plan … never mutates".
 * - merge_snapshot_changes_plan (swarm3_snapshots.ts) — GET plus snapshot file
 *   reads; no commit branch exists in the handler.
 * - snapshot_retention_plan (swarm3_snapshots.ts) — local snapshot file reads
 *   only; execution lives in prune_old_snapshots.
 * - playlist_chunk_preview (swarm4_playlists.ts) — GET plus arithmetic;
 *   "Read-only pagination preview".
 * - plan_podcast_session (podcastsession.ts) — candidate GETs returning a
 *   packing; no dry_run param and no commit branch (that lives in the
 *   separate start_podcast_session).
 *
 * Anything named `*_plan`/`*_preview` that is NOT in this set is classified as
 * a write, even when its description says "read-only": preview-by-default
 * handlers that accept dry_run=false execute (apply_volume_plan,
 * split_queue_plan, reverse_/rotate_/interleave_/merge_/difference_playlist_plan).
 */
export const NEVER_MUTATING_PLANS: ReadonlySet<string> = new Set([
  'undo_preview',
  'decade_sampler_plan',
  'album_representative_plan',
  'front_to_back_plan',
  'plan_volume_level_across_devices',
  'queue_prune_plan',
  'sleep_timer_plan',
  'sort_playlist_plan',
  'playlist_union_preview',
  'dedupe_playlist_plan',
  'stale_saved_shows_plan',
  'mark_episode_played_plan',
  'show_backlog_plan',
  'restore_playlist_plan',
  'merge_snapshot_changes_plan',
  'snapshot_retention_plan',
  'playlist_chunk_preview',
  'plan_podcast_session',
]);

/**
 * Classify one tool. Returns only the fields worth putting on the wire:
 * non-default values plus an explicit `destructiveHint` for every write (MCP
 * defaults it to true, so silence means "may destroy").
 */
export function classifyToolAnnotations(toolName: string): ToolAnnotations {
  const override = OVERRIDES[toolName];
  if (override) return { ...override };
  if (NEVER_MUTATING_PLANS.has(toolName)) return { readOnlyHint: true, idempotentHint: true };

  const mutating = MUTATING_PREFIXES.test(toolName);
  const readOnly = !mutating && READ_ONLY_PREFIXES.test(toolName);
  if (readOnly) return { readOnlyHint: true, idempotentHint: true };

  const destructive = DESTRUCTIVE_PREFIXES.test(toolName);
  return destructive ? { destructiveHint: true } : { destructiveHint: false };
}

interface RegistryEntry {
  annotations?: unknown;
  update?: (u: { annotations?: ToolAnnotations }) => void;
}

/**
 * Attach annotations to every registered tool, using the SDK's `update()` when
 * available (it also notifies hosts) and assigning directly otherwise. Returns
 * counts so startup can log a silent no-op instead of shipping unannotated tools.
 */
export function applyToolAnnotations(server: McpServer): { total: number; annotated: number } {
  const registry = (server as unknown as { _registeredTools?: Record<string, RegistryEntry> })._registeredTools;
  if (!registry || typeof registry !== 'object') return { total: 0, annotated: 0 };
  let annotated = 0;
  for (const [name, entry] of Object.entries(registry)) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.annotations && Object.keys(entry.annotations).length > 0) {
      annotated++;
      continue;
    }
    const annotations = classifyToolAnnotations(name);
    try {
      if (typeof entry.update === 'function') entry.update({ annotations });
      else entry.annotations = annotations;
      annotated++;
    } catch {
      // A registry that rejects updates is a host-shape change: leaving a tool
      // unannotated is safer than failing server startup.
    }
  }
  return { total: Object.keys(registry).length, annotated };
}

export type ModuleRegistrationStatus =
  | 'active'
  | 'toolset_trimmed'
  | 'scope_blocked'
  | 'read_only_hidden';

export interface ModuleSchemaBudget {
  readonly module: string;
  readonly registrationKey: string;
  readonly file: string;
  readonly status: ModuleRegistrationStatus;
  readonly toolCount: number;
  readonly schemaBytes: number;
  readonly baselineToolCount: number;
  readonly baselineSchemaBytes: number;
  readonly maxToolCount: number;
  readonly maxSchemaBytes: number;
  readonly withinBudget: boolean;
}

export interface RegistrarManifestEntry {
  readonly key: string;
  readonly registrationKey: string;
  readonly file: string;
  readonly registrar: (server: McpServer, client: SpotifyClient) => void;
  readonly scopeKey?: string;
  readonly alwaysActive?: boolean;
  readonly readOnlySafe?: boolean;
  readonly baseline: { readonly toolCount: number; readonly schemaBytes: number };
  readonly ceiling: { readonly toolCount: number; readonly schemaBytes: number };
}

export interface RegistrarManifestContext {
  readonly readOnly: boolean;
  readonly isModuleActive: (registrationKey: string) => boolean;
  readonly scopeBlocked: (scopeKey: string) => boolean;
}

const manifestEntry = (
  key: string,
  registrationKey: string,
  file: string,
  registrar: RegistrarManifestEntry['registrar'],
  baseline: readonly [toolCount: number, schemaBytes: number],
  options: Partial<Omit<RegistrarManifestEntry, 'key' | 'registrationKey' | 'file' | 'registrar' | 'baseline' | 'ceiling'>> = {},
): RegistrarManifestEntry => ({
  key,
  registrationKey,
  file,
  registrar,
  scopeKey: registrationKey,
  readOnlySafe: false,
  ...options,
  baseline: { toolCount: baseline[0], schemaBytes: baseline[1] },
  // Ten percent schema headroom and one additional tool force a deliberate
  // baseline/ceiling update whenever a registrar grows.
  ceiling: {
    toolCount: baseline[0] + 1,
    schemaBytes: Math.ceil(baseline[1] * 1.1),
  },
});

export const REGISTRAR_MANIFEST: readonly RegistrarManifestEntry[] = [
  manifestEntry('search', 'search', 'src/tools/search.ts', registerSearchTools, [1, 1832], { readOnlySafe: true }),
  manifestEntry('catalog', 'catalog', 'src/tools/catalog.ts', registerCatalogTools, [32, 27331], { readOnlySafe: true }),
  manifestEntry('library', 'library', 'src/tools/library.ts', registerLibraryTools, [16, 14651]),
  manifestEntry('playback', 'playback', 'src/tools/playback.ts', registerPlaybackTools, [16, 12391]),
  manifestEntry('following', 'following', 'src/tools/following.ts', registerFollowingTools, [5, 3634]),
  manifestEntry('users', 'users', 'src/tools/users.ts', registerUsersTools, [2, 1561]),
  manifestEntry('audiobooks', 'audiobooks', 'src/tools/audiobooks.ts', registerAudiobookTools, [4, 3627]),
  manifestEntry('audiobookcopilot', 'audiobooks', 'src/tools/audiobookcopilot.ts', registerAudiobookCopilotTools, [3, 1939]),
  manifestEntry('playlists', 'playlists', 'src/tools/playlists.ts', registerPlaylistTools, [26, 20356]),
  manifestEntry('playlistops', 'playlists', 'src/tools/playlistops.ts', registerPlaylistOpsTools, [3, 3541]),
  manifestEntry('playlistbatch', 'playlistbatch', 'src/tools/playlistbatch.ts', registerPlaylistBatchTools, [3, 4026]),
  manifestEntry('playlistmisc', 'playlistmisc', 'src/tools/playlistmisc.ts', registerPlaylistMiscTools, [3, 2390]),
  manifestEntry('personalization', 'personalization', 'src/tools/personalization.ts', registerPersonalizationTools, [3, 2601], { readOnlySafe: true }),
  manifestEntry('analytics', 'personalization', 'src/tools/analytics.ts', registerAnalyticsTools, [4, 2687], { readOnlySafe: true }),
  manifestEntry('statsfm', 'statsfm', 'src/tools/statsfm.ts', (server) => registerStatsfmTools(server), [30, 23411], { readOnlySafe: true }),
  manifestEntry('taste', 'taste', 'src/tools/statsfm_taste.ts', registerStatsfmTasteTools, [16, 14327], { readOnlySafe: true }),
  manifestEntry('tastecomposites', 'tastecomposites', 'src/tools/taste_composites.ts', registerTasteCompositeTools, [11, 9354], { readOnlySafe: true }),
  manifestEntry('doctor', 'doctor', 'src/tools/doctortool.ts', registerDoctorTool, [1, 773], { alwaysActive: true, readOnlySafe: true }),
  manifestEntry('swarm3meta', 'swarm3meta', 'src/tools/swarm3_meta.ts', registerSwarm3MetaTools, [3, 1693], { alwaysActive: true, scopeKey: 'catalog', readOnlySafe: true }),
  manifestEntry('libraryanalytics', 'libraryanalytics', 'src/tools/libraryanalytics.ts', registerLibraryAnalyticsTools, [4, 3224], { readOnlySafe: true, scopeKey: 'library' }),
  manifestEntry('portability', 'portability', 'src/tools/portability.ts', registerPortabilityTools, [11, 9061], { scopeKey: 'library' }),
  manifestEntry('libraryinsights', 'library', 'src/tools/libraryinsights.ts', registerLibraryInsightsTools, [3, 2820], { scopeKey: 'library' }),
  manifestEntry('libraryhygiene', 'library', 'src/tools/libraryhygiene.ts', registerLibraryHygieneTools, [1, 704], { scopeKey: 'library' }),
  manifestEntry('showradar', 'library', 'src/tools/showradar.ts', registerShowRadarTools, [1, 1552], { readOnlySafe: true, scopeKey: 'library' }),
  manifestEntry('saveddedupe', 'library', 'src/tools/saveddedupe.ts', registerSavedDedupeTools, [1, 1585], { scopeKey: 'library' }),
  manifestEntry('podcastsession', 'library', 'src/tools/podcastsession.ts', registerPodcastSessionTools, [2, 2805], { scopeKey: 'library' }),
  manifestEntry('backupfirst', 'library', 'src/tools/backupfirst.ts', registerBackupFirstTools, [1, 536], { readOnlySafe: true, scopeKey: 'library' }),
  manifestEntry('backup', 'library', 'src/tools/backup.ts', registerBackupTools, [2, 1489], { readOnlySafe: true, scopeKey: 'library' }),
  manifestEntry('restore', 'library', 'src/tools/restore.ts', registerRestoreTools, [1, 1874], { scopeKey: 'library' }),
  manifestEntry('undo', 'library', 'src/tools/undo.ts', registerUndoTools, [2, 1476], { scopeKey: 'library' }),
  manifestEntry('receipts', 'library', 'src/index.ts', (server) => {
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
  }, [1, 338], { readOnlySafe: true, scopeKey: 'library' }),
  manifestEntry('episodemgmt', 'episodemgmt', 'src/tools/episodemgmt.ts', registerEpisodeMgmtTools, [1, 815], { scopeKey: 'library' }),
  manifestEntry('freshness', 'following', 'src/tools/freshness.ts', registerFreshnessTools, [1, 2066], { scopeKey: 'following' }),
  manifestEntry('searchdive', 'search', 'src/tools/searchdive.ts', registerSearchDeepTool, [1, 1349], { readOnlySafe: true, scopeKey: 'search' }),
  manifestEntry('searchhistory', 'searchhistory', 'src/tools/searchhistory.ts', registerSearchHistoryTools, [2, 1050], { readOnlySafe: true, scopeKey: 'search' }),
  manifestEntry('browse', 'browse', 'src/tools/browse.ts', registerBrowseTools, [3, 2734], { readOnlySafe: true, scopeKey: 'catalog' }),
  manifestEntry('artistwatch', 'artistwatch', 'src/tools/artistwatch.ts', registerArtistWatchTools, [6, 5705], { scopeKey: 'catalog' }),
  manifestEntry('queueops', 'queueops', 'src/tools/queueops.ts', registerQueueOpsTools, [3, 3518], { scopeKey: 'playback' }),
  manifestEntry('playbackext', 'playbackext', 'src/tools/playbackext.ts', registerPlaybackExtTools, [13, 7494], { scopeKey: 'playback' }),
  manifestEntry('playbackintel', 'playbackintel', 'src/tools/playbackintel.ts', registerPlaybackIntelTools, [15, 11960], { readOnlySafe: true, scopeKey: 'playback' }),
  manifestEntry('scenes', 'playback', 'src/tools/scenes.ts', registerScenesTools, [7, 4617], { scopeKey: 'playback' }),
  manifestEntry('playlisthealth', 'playlisthealth', 'src/tools/playlisthealth.ts', registerPlaylistHealthTools, [8, 5469], { scopeKey: 'playlists' }),
  manifestEntry('playlistdna', 'playlists', 'src/tools/playlistdna.ts', registerPlaylistDnaTools, [1, 1333], { readOnlySafe: true, scopeKey: 'playlists' }),
  manifestEntry('export', 'playlists', 'src/tools/export.ts', registerExportTools, [1, 1111], { scopeKey: 'playlists' }),
  manifestEntry('import', 'playlists', 'src/tools/import.ts', registerImportTools, [1, 1158], { scopeKey: 'playlists' }),
  manifestEntry('smart', 'playlists', 'src/tools/smart.ts', registerSmartTools, [1, 2205], { scopeKey: 'playlists' }),
  manifestEntry('exhaustmisc', 'playlists', 'src/tools/exhaustmisc.ts', registerExhaustMiscTools, [10, 7593], { scopeKey: 'playlists' }),
  manifestEntry('exhaust2catalog', 'exhaust2catalog', 'src/tools/exhaust2_catalog.ts', registerExhaust2CatalogTools, [19, 18643], { readOnlySafe: true, scopeKey: 'catalog' }),
  manifestEntry('exhaust2enggating', 'exhaust2enggating', 'src/tools/exhaust2_enggating.ts', registerExhaust2EnggatingTools, [0, 0], { readOnlySafe: true, scopeKey: 'catalog' }),
  manifestEntry('exhaust2playback', 'exhaust2playback', 'src/tools/exhaust2_playback.ts', registerExhaust2PlaybackTools, [23, 17835], { scopeKey: 'playback' }),
  manifestEntry('exhaust2playlists', 'exhaust2playlists', 'src/tools/exhaust2_playlists.ts', registerExhaust2PlaylistsTools, [18, 22765], { scopeKey: 'playlists' }),
  manifestEntry('exhaust2misc', 'exhaust2misc', 'src/tools/exhaust2_misc.ts', registerExhaust2MiscTools, [27, 23391], { scopeKey: 'library' }),
  manifestEntry('exhaust2extra', 'exhaust2extra', 'src/tools/exhaust2_extra.ts', registerExhaust2ExtraTools, [3, 3764], { scopeKey: 'playlists' }),
  manifestEntry('swarm3discovery', 'swarm3discovery', 'src/tools/swarm3_discovery.ts', registerSwarm3DiscoveryTools, [24, 22383], { readOnlySafe: true, scopeKey: 'catalog' }),
  manifestEntry('swarm3bdiscovery', 'swarm3bdiscovery', 'src/tools/swarm3b_discovery.ts', registerSwarm3bDiscoveryTools, [24, 19731], { readOnlySafe: true, scopeKey: 'catalog' }),
  manifestEntry('swarm3shows', 'swarm3shows', 'src/tools/swarm3_shows.ts', registerSwarm3ShowsTools, [24, 20853], { scopeKey: 'catalog' }),
  manifestEntry('swarm3refs', 'swarm3refs', 'src/tools/swarm3_refs.ts', registerSwarm3RefsTools, [24, 13346], { readOnlySafe: true, scopeKey: 'catalog' }),
  manifestEntry('swarm3analytics', 'swarm3analytics', 'src/tools/swarm3_analytics.ts', registerSwarm3AnalyticsTools, [24, 19000], { readOnlySafe: true, scopeKey: 'personalization' }),
  manifestEntry('swarm3library', 'swarm3library', 'src/tools/swarm3_library.ts', registerSwarm3LibraryTools, [24, 18539], { readOnlySafe: true, scopeKey: 'library' }),
  manifestEntry('swarm3playback', 'swarm3playback', 'src/tools/swarm3_playback.ts', registerSwarm3PlaybackTools, [24, 14799], { scopeKey: 'playback' }),
  manifestEntry('swarm3playlistops', 'swarm3playlistops', 'src/tools/swarm3_playlistops.ts', registerSwarm3PlaylistopsTools, [24, 28853], { scopeKey: 'playlists' }),
  manifestEntry('swarm3snapshots', 'swarm3snapshots', 'src/tools/swarm3_snapshots.ts', registerSwarm3SnapshotsTools, [24, 24296], { scopeKey: 'playlists' }),
  manifestEntry('swarm4playlists', 'swarm4playlists', 'src/tools/swarm4_playlists.ts', registerSwarm4PlaylistsTools, [18, 22128], { scopeKey: 'playlists' }),
] as const;

interface SchemaRegistryEntry {
  description?: string;
  inputSchema?: unknown;
  enabled?: boolean;
}

interface ServerModuleMetadata {
  statuses: Map<string, ModuleRegistrationStatus>;
  tools: Map<string, string[]>;
  budgetRows?: readonly ModuleSchemaBudget[];
}

const SERVER_METADATA = new WeakMap<McpServer, ServerModuleMetadata>();

function serverMetadata(server: McpServer): ServerModuleMetadata {
  const existing = SERVER_METADATA.get(server);
  if (existing) return existing;
  const created: ServerModuleMetadata = { statuses: new Map(), tools: new Map() };
  SERVER_METADATA.set(server, created);
  (server as unknown as { __spotifyModuleSchemaBudgets?: () => ModuleSchemaBudget[] }).__spotifyModuleSchemaBudgets =
    () => collectModuleSchemaBudgets(server);
  return created;
}

function registeredToolNames(server: McpServer): string[] {
  const registry = (server as unknown as { _registeredTools?: Record<string, SchemaRegistryEntry> })._registeredTools ?? {};
  return Object.keys(registry);
}

export function moduleRegistrationStatus(
  module: RegistrarManifestEntry,
  context: RegistrarManifestContext,
): ModuleRegistrationStatus {
  if (module.alwaysActive) {
    return context.scopeBlocked(module.scopeKey ?? module.registrationKey) ? 'scope_blocked' : 'active';
  }
  if (context.scopeBlocked(module.scopeKey ?? module.registrationKey)) return 'scope_blocked';
  if (!context.isModuleActive(module.registrationKey)) return 'toolset_trimmed';
  if (context.readOnly && module.readOnlySafe !== true) return 'read_only_hidden';
  return 'active';
}

/** Register one manifest module and retain its exact tool-name ownership. */
export function registerManifestModule(
  server: McpServer,
  client: SpotifyClient,
  module: RegistrarManifestEntry,
  context: RegistrarManifestContext,
): void {
  const metadata = serverMetadata(server);
  const status = moduleRegistrationStatus(module, context);
  metadata.statuses.set(module.key, status);
  if (status !== 'active') return;
  const before = new Set(registeredToolNames(server));
  module.registrar(server, client);
  metadata.tools.set(module.key, registeredToolNames(server).filter((name) => !before.has(name)));
  metadata.budgetRows = undefined;
}

/** Tool names owned by one manifest module for wire-level audit tests/reports. */
export function moduleToolNames(server: McpServer, moduleKey: string): readonly string[] {
  return serverMetadata(server).tools.get(moduleKey) ?? [];
}

/** UTF-8 bytes for description + the same JSON Schema emitted by tools/list. */
export function serializedSchemaBytes(schema: Pick<SchemaRegistryEntry, 'description' | 'inputSchema'>): number {
  const inputSchema = schema.inputSchema === undefined
    ? {}
    : z4.toJSONSchema(schema.inputSchema as Parameters<typeof z4.toJSONSchema>[0], {
        target: 'draft-7',
        io: 'input',
      });
  return Buffer.byteLength(JSON.stringify({
    description: String(schema.description ?? ''),
    inputSchema,
  }), 'utf8');
}

export function collectModuleSchemaBudgets(server: McpServer): ModuleSchemaBudget[] {
  const metadata = serverMetadata(server);
  if (metadata.budgetRows) return [...metadata.budgetRows];
  const registry = (server as unknown as { _registeredTools?: Record<string, SchemaRegistryEntry> })._registeredTools ?? {};
  const rows = REGISTRAR_MANIFEST.map((module): ModuleSchemaBudget => {
    const status = metadata.statuses.get(module.key) ?? 'active';
    const names = metadata.tools.get(module.key) ?? [];
    let schemaBytes = 0;
    for (const name of names) schemaBytes += serializedSchemaBytes(registry[name] ?? {});
    const toolCount = names.length;
    return {
      module: module.key,
      registrationKey: module.registrationKey,
      file: module.file,
      status,
      toolCount,
      schemaBytes,
      baselineToolCount: module.baseline.toolCount,
      baselineSchemaBytes: module.baseline.schemaBytes,
      maxToolCount: module.ceiling.toolCount,
      maxSchemaBytes: module.ceiling.schemaBytes,
      withinBudget: status !== 'active' || (toolCount <= module.ceiling.toolCount && schemaBytes <= module.ceiling.schemaBytes),
    };
  });
  metadata.budgetRows = rows;
  return [...rows];
}

export function assertModuleSchemaBudgets(rows: readonly ModuleSchemaBudget[]): void {
  const over = rows.filter((row) => row.status === 'active' && !row.withinBudget);
  if (over.length === 0) return;
  throw new Error(over.map((row) =>
    `${row.module} (${row.file}) exceeds schema budget: ${row.toolCount} tools/${row.schemaBytes}B ` +
    `> ${row.maxToolCount} tools/${row.maxSchemaBytes}B`,
  ).join('; '));
}
