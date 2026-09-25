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
import { StatsfmApiError } from '../lib/statsfm-client.js';
import { truthyEnv } from '../config.js';
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
import { CallToolRequestSchema, ListToolsRequestSchema, type ServerResult } from '@modelcontextprotocol/sdk/types.js';
import { getObjectShape, normalizeObjectSchema, safeParseAsync } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { finalInputSchema } from '../shaping.js';
import { SpotifyApiError } from '../client.js';

/**
 * v2 registry policy (#909/#918). Prefix allowances are a frozen baseline, not
 * a target: a new family gets the default budget of three, while these legacy
 * entity/verb families are allowed to shrink but never to grow silently.
 */
export const TOOL_SURFACE_BUDGET = Object.freeze({
  defaultMaxTools: 620,
  defaultMaxBytes: 600_000,
  perToolMaxBytes: 6_000,
  coreMaxTools: 200,
  coreMaxBytes: 220_000,
  defaultPrefixBudget: 3,
  prefixBudgets: Object.freeze({
    album: 8, apply: 4, artist: 35, check: 6, episode: 5, export: 10,
    filter: 4, find: 11, get: 59, library: 8, list: 11, listening: 17,
    play: 4, playback: 4, playlist: 54, queue: 8, remove: 9, restore: 4,
    save: 11, saved: 11, search: 22, set: 4, show: 8, snapshot: 12,
    split: 5, statsfm: 38, taste: 16, top: 6, track: 4, uri: 4,
  }),
});


const LEGACY_BANNED_PREFIXES: Readonly<Record<string, true>> = Object.freeze({
  normalize: true, format: true, make: true, archive: true, prune: true, trim: true,
});

/** Existing names retained only until their owning modules can be migrated. */
export const LEGACY_NAMING_EXCEPTIONS: Readonly<Record<string, true>> = Object.freeze({
  archive_played_episodes: true,
  format_spotify_uri: true,
  normalize_spotify_uri: true,
  make_spotify_uri: true,
  prune_old_snapshots: true,
});

export type ToolClassification = 'read' | 'write';

export interface ToolNamingMetadata {
  name: string;
  prefix: string;
  prefixBudget: number;
  classification: ToolClassification;
}

export function toolNamingMetadata(name: string): ToolNamingMetadata {
  const prefix = name.split('_', 1)[0] ?? name;
  const budget = (TOOL_SURFACE_BUDGET.prefixBudgets as Record<string, number>)[prefix]
    ?? TOOL_SURFACE_BUDGET.defaultPrefixBudget;
  return {
    name,
    prefix,
    prefixBudget: budget,
    classification: classifyToolAnnotations(name).readOnlyHint === true ? 'read' : 'write',
  };
}

/** Fail startup when a newly registered name violates the frozen v2 policy. */
export function assertToolNamingPolicy(toolNames: Iterable<string>): void {
  const counts = new Map<string, number>();
  const violations: string[] = [];
  for (const name of toolNames) {
    if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(name)) {
      violations.push(`${name}: expected lower_snake_case verb_entity naming`);
    }
    if (Object.hasOwn(LEGACY_BANNED_PREFIXES, name.split('_', 1)[0]) && !Object.hasOwn(LEGACY_NAMING_EXCEPTIONS, name)) {
      violations.push(`${name}: banned canonical verb`);
    }
    const prefix = name.split('_', 1)[0] ?? name;
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  for (const [prefix, count] of counts) {
    const budget = (TOOL_SURFACE_BUDGET.prefixBudgets as Record<string, number>)[prefix]
      ?? TOOL_SURFACE_BUDGET.defaultPrefixBudget;
    if (count > budget) violations.push(`${prefix}*: ${count} tools exceeds prefix budget ${budget}`);
  }
  if (violations.length > 0) {
    throw new Error(`Tool naming policy violation:\n- ${violations.join('\n- ')}`);
  }
}


export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}
/**
 * Defaults a host can rely on without reading prose. Every entry here must be a
 * property the tool actually declares: `applyStableListDefaults` skips unknown
 * properties silently, so a row naming `offset` for a tool that only declares
 * `response_format`/`max_results` is dead config that reads as a promise.
 * tests/tool.surface.test.ts asserts this mapping against the real schemas.
 */
export const STABLE_LIST_DEFAULTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = Object.freeze({
  search: Object.freeze({ offset: 0 }),
  get_saved_tracks: Object.freeze({ offset: 0, fetch_all: false }),
});

function applyStableListDefaults(toolName: string, schema: Record<string, unknown>): Record<string, unknown> {
  const defaults = STABLE_LIST_DEFAULTS[toolName];
  const properties = schema.properties;
  if (!defaults || !properties || typeof properties !== 'object' || Array.isArray(properties)) return schema;
  const propertySchemas = properties as Record<string, unknown>;
  for (const [property, defaultValue] of Object.entries(defaults)) {
    const propertySchema = propertySchemas[property];
    if (!propertySchema || typeof propertySchema !== 'object' || Object.hasOwn(propertySchema, 'default')) continue;
    Object.defineProperty(propertySchema, 'default', { value: defaultValue, configurable: true, enumerable: true });
  }
  return schema;
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
  // Local reference normalization never calls Spotify or mutates server state.
  dedupe_spotify_uris: { readOnlyHint: true, idempotentHint: true },
  parse_spotify_uri: { readOnlyHint: true, idempotentHint: true },
  parse_spotify_uris: { readOnlyHint: true, idempotentHint: true },
  format_spotify_uri: { readOnlyHint: true, idempotentHint: true },
  canonicalize_spotify_uri: { readOnlyHint: true, idempotentHint: true },
  spotify_uri_stats: { readOnlyHint: true, idempotentHint: true },

  statsfm_record_feedback: { destructiveHint: false },
  record_feedback: { destructiveHint: false },
  export_playlist: { destructiveHint: false },
  backup_library: { destructiveHint: false },
  play: { destructiveHint: false },
  pause: { destructiveHint: false },
  next_track: { destructiveHint: false },
  previous_track: { destructiveHint: false },
  // undo_mutation / undo_last_mutation are deliberately NOT listed here: they
  // delete real library rows, and a client that trusts destructiveHint to decide
  // what it may auto-approve must not be told a rollback is safe (#627).
  // (No read-only overrides for undo_preview / restore_playlist_plan here — they
  // live in NEVER_MUTATING_PLANS below with the per-handler audit notes.)
  restore_playback: { destructiveHint: false },
  restore_playlist_from_snapshot: { destructiveHint: true },
  apply_snapshot_changes: { destructiveHint: true },
  merge_snapshot_changes: { destructiveHint: true },
};

/**
 * The single reader of SPOTIFY_MCP_READONLY. Every read-only decision — module
 * gating, the doctor report, the freshness watermark hold, `whats_new`
 * annotation — must agree, or one env value yields two contradictory safety
 * states (modules visible but the watermark frozen, say).
 */
export function readOnlyModeEnabled(): boolean {
  return truthyEnv(process.env.SPOTIFY_MCP_READONLY);
}
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
// dedupe_spotify_uris is local classification/canonicalization only; no API or filesystem writes.
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
  'dedupe_spotify_uris',
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
  if (toolName === 'whats_new') {
    return readOnlyModeEnabled()
      ? { readOnlyHint: true, idempotentHint: true }
      : { destructiveHint: false };
  }
  const override = OVERRIDES[toolName];
  if (override) return { ...override };
  if (NEVER_MUTATING_PLANS.has(toolName)) return { readOnlyHint: true, idempotentHint: true };

  const mutating = MUTATING_PREFIXES.test(toolName);
  const readOnly = !mutating && READ_ONLY_PREFIXES.test(toolName);
  if (readOnly) return { readOnlyHint: true, idempotentHint: true };

  const destructive = DESTRUCTIVE_PREFIXES.test(toolName);
  return destructive ? { destructiveHint: true } : { destructiveHint: false };
}

type SdkSchema = NonNullable<Parameters<typeof getObjectShape>[0]>;
type ToolHandler =
  | ((...args: unknown[]) => unknown)
  | { createTask: (...args: unknown[]) => unknown };

interface RegistryEntry {
  title?: string;
  description?: string;
  inputSchema?: SdkSchema;
  outputSchema?: SdkSchema;
  annotations?: unknown;
  handler?: ToolHandler;
  enabled?: boolean;
  execution?: unknown;
  _meta?: Record<string, unknown>;
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

export const AGGREGATE_SURFACE_LIMITS = {
  maxTools: TOOL_SURFACE_BUDGET.defaultMaxTools,
  // 1 KB headroom covers final MCP annotation metadata added after registration.
  maxBytes: TOOL_SURFACE_BUDGET.defaultMaxBytes + 1_000,
} as const;

export interface AggregateSurfaceMeasurement {
  readonly toolCount: number;
  readonly schemaBytes: number;
}

export function collectAggregateSurfaceMeasurement(server: McpServer): AggregateSurfaceMeasurement {
  const registry = (server as unknown as { _registeredTools?: Record<string, SchemaRegistryEntry & { annotations?: unknown; title?: string; outputSchema?: unknown; execution?: unknown; _meta?: unknown }> })._registeredTools ?? {};
  const tools = Object.entries(registry).filter(([, tool]) => tool.enabled !== false).map(([name, tool]) => ({
    name,
    title: tool.title,
    description: tool.description,
    inputSchema: applyStableListDefaults(name, finalInputSchema(tool.inputSchema)),
    annotations: tool.annotations,
    execution: tool.execution,
    _meta: tool._meta,
  }));
  return { toolCount: tools.length, schemaBytes: Buffer.byteLength(JSON.stringify(tools), 'utf8') };
}

export function assertAggregateSurfaceBudget(measurement: AggregateSurfaceMeasurement): void {
  if (measurement.toolCount > AGGREGATE_SURFACE_LIMITS.maxTools || measurement.schemaBytes > AGGREGATE_SURFACE_LIMITS.maxBytes) {
    throw new Error(`aggregate tool surface exceeds budget: ${measurement.toolCount} tools/${measurement.schemaBytes}B > ${AGGREGATE_SURFACE_LIMITS.maxTools} tools/${AGGREGATE_SURFACE_LIMITS.maxBytes}B`);
  }
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
  manifestEntry('search', 'search', 'src/tools/search.ts', registerSearchTools, [1, 1821], { readOnlySafe: true }),
  manifestEntry('catalog', 'catalog', 'src/tools/catalog.ts', registerCatalogTools, [31, 27013], { readOnlySafe: true }),
  manifestEntry('library', 'library', 'src/tools/library.ts', registerLibraryTools, [16, 14957]),
  manifestEntry('playback', 'playback', 'src/tools/playback.ts', registerPlaybackTools, [16, 12023]),
  manifestEntry('following', 'following', 'src/tools/following.ts', registerFollowingTools, [5, 3921]),
  manifestEntry('users', 'users', 'src/tools/users.ts', registerUsersTools, [2, 1613]),
  manifestEntry('audiobooks', 'audiobooks', 'src/tools/audiobooks.ts', registerAudiobookTools, [4, 3535]),
  manifestEntry('audiobookcopilot', 'audiobooks', 'src/tools/audiobookcopilot.ts', registerAudiobookCopilotTools, [3, 1870]),
  manifestEntry('playlists', 'playlists', 'src/tools/playlists.ts', registerPlaylistTools, [26, 25949]),
  manifestEntry('playlistops', 'playlists', 'src/tools/playlistops.ts', registerPlaylistOpsTools, [3, 5489]),
  manifestEntry('playlistbatch', 'playlistbatch', 'src/tools/playlistbatch.ts', registerPlaylistBatchTools, [3, 4784], { scopeKey: 'playlists' }),
  manifestEntry('playlistmisc', 'playlistmisc', 'src/tools/playlistmisc.ts', registerPlaylistMiscTools, [3, 2543], { scopeKey: 'playlists' }),
  manifestEntry('personalization', 'personalization', 'src/tools/personalization.ts', registerPersonalizationTools, [3, 2532], { readOnlySafe: true }),
  manifestEntry('analytics', 'personalization', 'src/tools/analytics.ts', registerAnalyticsTools, [4, 2753], { readOnlySafe: true }),
  manifestEntry('statsfm', 'statsfm', 'src/tools/statsfm.ts', (server) => registerStatsfmTools(server), [30, 22721], { readOnlySafe: true }),
  manifestEntry('taste', 'taste', 'src/tools/statsfm_taste.ts', registerStatsfmTasteTools, [16, 13959], { readOnlySafe: true }),
  manifestEntry('tastecomposites', 'tastecomposites', 'src/tools/taste_composites.ts', registerTasteCompositeTools, [11, 9101], { readOnlySafe: true }),
  manifestEntry('doctor', 'doctor', 'src/tools/doctortool.ts', registerDoctorTool, [1, 750], { alwaysActive: true, readOnlySafe: true }),
  manifestEntry('swarm3meta', 'swarm3meta', 'src/tools/swarm3_meta.ts', registerSwarm3MetaTools, [3, 1624], { alwaysActive: true, scopeKey: 'catalog', readOnlySafe: true }),
  manifestEntry('libraryanalytics', 'libraryanalytics', 'src/tools/libraryanalytics.ts', registerLibraryAnalyticsTools, [4, 3350], { readOnlySafe: true, scopeKey: 'library' }),
  manifestEntry('portability', 'portability', 'src/tools/portability.ts', registerPortabilityTools, [11, 9514], { scopeKey: 'library' }),
  manifestEntry('libraryinsights', 'library', 'src/tools/libraryinsights.ts', registerLibraryInsightsTools, [3, 2751], { scopeKey: 'library' }),
  manifestEntry('libraryhygiene', 'library', 'src/tools/libraryhygiene.ts', registerLibraryHygieneTools, [1, 681], { scopeKey: 'library' }),
  manifestEntry('showradar', 'library', 'src/tools/showradar.ts', registerShowRadarTools, [1, 1675], { readOnlySafe: true, scopeKey: 'library' }),
  manifestEntry('saveddedupe', 'library', 'src/tools/saveddedupe.ts', registerSavedDedupeTools, [1, 1562], { scopeKey: 'library' }),
  manifestEntry('podcastsession', 'library', 'src/tools/podcastsession.ts', registerPodcastSessionTools, [2, 2759], { scopeKey: 'library' }),
  manifestEntry('backupfirst', 'library', 'src/tools/backupfirst.ts', registerBackupFirstTools, [1, 513], { readOnlySafe: true, scopeKey: 'library' }),
  manifestEntry('backup', 'library', 'src/tools/backup.ts', registerBackupTools, [2, 1443], { readOnlySafe: true, scopeKey: 'library' }),
  manifestEntry('restore', 'library', 'src/tools/restore.ts', registerRestoreTools, [1, 1851], { scopeKey: 'library' }),
  manifestEntry('undo', 'library', 'src/tools/undo.ts', registerUndoTools, [2, 1518], { scopeKey: 'library' }),
  manifestEntry('receipts', 'library', 'src/tools/annotations.ts', (server) => {
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
  }, [1, 315], { readOnlySafe: true, scopeKey: 'library' }),
  manifestEntry('episodemgmt', 'episodemgmt', 'src/tools/episodemgmt.ts', registerEpisodeMgmtTools, [1, 1053], { scopeKey: 'library' }),
  manifestEntry('freshness', 'following', 'src/tools/freshness.ts', registerFreshnessTools, [1, 2043], { readOnlySafe: true, scopeKey: 'following' }),
  manifestEntry('searchdive', 'search', 'src/tools/searchdive.ts', registerSearchDeepTool, [1, 1561], { readOnlySafe: true, scopeKey: 'search' }),
  manifestEntry('searchhistory', 'searchhistory', 'src/tools/searchhistory.ts', registerSearchHistoryTools, [2, 1103], { readOnlySafe: true, scopeKey: 'search' }),
  manifestEntry('browse', 'browse', 'src/tools/browse.ts', registerBrowseTools, [3, 2665], { readOnlySafe: true, scopeKey: 'catalog' }),
  manifestEntry('artistwatch', 'artistwatch', 'src/tools/artistwatch.ts', registerArtistWatchTools, [6, 5567], { scopeKey: 'catalog' }),
  manifestEntry('queueops', 'queueops', 'src/tools/queueops.ts', registerQueueOpsTools, [3, 3449], { scopeKey: 'playback' }),
  manifestEntry('playbackext', 'playbackext', 'src/tools/playbackext.ts', registerPlaybackExtTools, [13, 7857], { scopeKey: 'playback' }),
  manifestEntry('playbackintel', 'playbackintel', 'src/tools/playbackintel.ts', registerPlaybackIntelTools, [15, 11663], { scopeKey: 'playback' }),
  manifestEntry('scenes', 'playback', 'src/tools/scenes.ts', registerScenesTools, [7, 4456], { scopeKey: 'playback' }),
  manifestEntry('playlisthealth', 'playlisthealth', 'src/tools/playlisthealth.ts', registerPlaylistHealthTools, [8, 5285], { scopeKey: 'playlists' }),
  manifestEntry('playlistdna', 'playlists', 'src/tools/playlistdna.ts', registerPlaylistDnaTools, [1, 1310], { readOnlySafe: true, scopeKey: 'playlists' }),
  manifestEntry('export', 'playlists', 'src/tools/export.ts', registerExportTools, [1, 1363], { scopeKey: 'playlists' }),
  manifestEntry('import', 'playlists', 'src/tools/import.ts', registerImportTools, [1, 1211], { scopeKey: 'playlists' }),
  manifestEntry('smart', 'playlists', 'src/tools/smart.ts', registerSmartTools, [1, 2182], { scopeKey: 'playlists' }),
  manifestEntry('exhaustmisc', 'playlists', 'src/tools/exhaustmisc.ts', registerExhaustMiscTools, [10, 7924], { scopeKey: 'exhaustmisc' }),
  manifestEntry('exhaust2catalog', 'exhaust2catalog', 'src/tools/exhaust2_catalog.ts', registerExhaust2CatalogTools, [19, 18759], { readOnlySafe: true, scopeKey: 'catalog' }),
  manifestEntry('exhaust2enggating', 'exhaust2enggating', 'src/tools/exhaust2_enggating.ts', registerExhaust2EnggatingTools, [0, 0], { readOnlySafe: true, scopeKey: 'catalog' }),
  manifestEntry('exhaust2playback', 'exhaust2playback', 'src/tools/exhaust2_playback.ts', registerExhaust2PlaybackTools, [23, 17306], { scopeKey: 'playback' }),
  manifestEntry('exhaust2playlists', 'exhaust2playlists', 'src/tools/exhaust2_playlists.ts', registerExhaust2PlaylistsTools, [18, 23511], { scopeKey: 'playlists' }),
  manifestEntry('exhaust2misc', 'exhaust2misc', 'src/tools/exhaust2_misc.ts', registerExhaust2MiscTools, [27, 23234], { scopeKey: 'library' }),
  manifestEntry('exhaust2extra', 'exhaust2extra', 'src/tools/exhaust2_extra.ts', registerExhaust2ExtraTools, [3, 3695], { scopeKey: 'playlists' }),
  manifestEntry('swarm3discovery', 'swarm3discovery', 'src/tools/swarm3_discovery.ts', registerSwarm3DiscoveryTools, [24, 21951], { readOnlySafe: true, scopeKey: 'catalog' }),
  manifestEntry('swarm3bdiscovery', 'swarm3bdiscovery', 'src/tools/swarm3b_discovery.ts', registerSwarm3bDiscoveryTools, [24, 20048], { readOnlySafe: true, scopeKey: 'catalog' }),
  manifestEntry('swarm3shows', 'swarm3shows', 'src/tools/swarm3_shows.ts', registerSwarm3ShowsTools, [24, 20161], { scopeKey: 'catalog' }),
  manifestEntry('swarm3refs', 'swarm3refs', 'src/tools/swarm3_refs.ts', registerSwarm3RefsTools, [6, 4331], { readOnlySafe: true, scopeKey: 'catalog' }),
  manifestEntry('swarm3analytics', 'swarm3analytics', 'src/tools/swarm3_analytics.ts', registerSwarm3AnalyticsTools, [24, 18880], { readOnlySafe: true, scopeKey: 'personalization' }),
  manifestEntry('swarm3library', 'swarm3library', 'src/tools/swarm3_library.ts', registerSwarm3LibraryTools, [24, 17987], { readOnlySafe: true, scopeKey: 'library' }),
  manifestEntry('swarm3playback', 'swarm3playback', 'src/tools/swarm3_playback.ts', registerSwarm3PlaybackTools, [24, 14247], { scopeKey: 'playback' }),
  manifestEntry('swarm3playlistops', 'swarm3playlistops', 'src/tools/swarm3_playlistops.ts', registerSwarm3PlaylistopsTools, [24, 31777], { scopeKey: 'playlists' }),
  manifestEntry('swarm3snapshots', 'swarm3snapshots', 'src/tools/swarm3_snapshots.ts', registerSwarm3SnapshotsTools, [24, 23744], { scopeKey: 'playlists' }),
  manifestEntry('swarm4playlists', 'swarm4playlists', 'src/tools/swarm4_playlists.ts', registerSwarm4PlaylistsTools, [18, 22594], { scopeKey: 'playlists' }),
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
export function serializedSchemaBytes(schema: Pick<SchemaRegistryEntry, 'description' | 'inputSchema'>, toolName?: string): number {
  const inputSchema = applyStableListDefaults(toolName ?? '', finalInputSchema(schema.inputSchema));
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
    for (const name of names) schemaBytes += serializedSchemaBytes(registry[name] ?? {}, name);
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
  // Recompute the verdict from the measurements rather than trusting a
  // precomputed `withinBudget` field: a caller (or a future edit to the row
  // builder) could otherwise flip the flag without the comparison ever running,
  // and the per-module budget gate would be dead while still reporting healthy.
  const over = rows.filter((row) => row.status === 'active'
    && (row.toolCount > row.maxToolCount || row.schemaBytes > row.maxSchemaBytes));
  if (over.length === 0) return;
  throw new Error(over.map((row) =>
    `${row.module} (${row.file}) exceeds schema budget: ${row.toolCount} tools/${row.schemaBytes}B ` +
    `> ${row.maxToolCount} tools/${row.maxSchemaBytes}B`,
  ).join('; '));
}

type ErrorKind =
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'unavailable'
  | 'conflict'
  | 'validation'
  | 'unknown_tool'
  | 'unknown_param'
  | 'internal';

interface ErrorFields {
  kind: ErrorKind;
  reason: string;
  fix: string;
  text: string;
  status?: number;
  retryAfterSec?: number;
  param?: string;
}

function getToolRegistry(server: McpServer): Record<string, RegistryEntry> {
  const registry = (server as unknown as { _registeredTools?: Record<string, RegistryEntry> })._registeredTools;
  if (!registry || typeof registry !== 'object') {
    throw new Error('Spotify MCP tool registry is unavailable; refusing to start without its error boundary');
  }
  return registry;
}

function safeIdentifier(value: string): string {
  const oneLine = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return (oneLine.replace(/[^A-Za-z0-9_.:-]+/g, '?').slice(0, 96) || '(unnamed)');
}

function levenshtein(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const substitution = previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        substitution,
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function nearestNames(name: string, candidates: string[]): string[] {
  return candidates
    .map((candidate) => ({ candidate, distance: levenshtein(name, candidate) }))
    .filter(({ distance }) => distance > 0 && distance <= 3)
    .sort((left, right) => left.distance - right.distance || left.candidate.localeCompare(right.candidate))
    .slice(0, 3)
    .map(({ candidate }) => candidate);
}

function humanList(values: string[]): string {
  if (values.length === 1) return `"${values[0]}"`;
  if (values.length === 2) return `"${values[0]}" or "${values[1]}"`;
  return `"${values[0]}", "${values[1]}", or "${values[2]}"`;
}

function findTypedApiError(error: unknown): SpotifyApiError | StatsfmApiError | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (current instanceof SpotifyApiError || current instanceof StatsfmApiError) return current;
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}


function safeStatsfmReason(reason: unknown): string | undefined {
  if (typeof reason !== 'string') return undefined;
  if (/registration[-_ ]?gated/i.test(reason)) return 'registration_gated';
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(reason) ? reason : undefined;
}

function statsfmFailure(tool: string, error: StatsfmApiError): ErrorFields {
  let kind: ErrorKind;
  let reason: string;
  let fix: string;
  let text: string;
  if (error.status === 401) {
    kind = 'auth';
    reason = safeStatsfmReason(error.reason) ?? 'statsfm_authentication_required';
    fix = 'Retry when stats.fm authentication is available.';
    text = `${tool} could not authenticate with stats.fm; retry later.`;
  } else if (error.status === 403) {
    kind = 'forbidden';
    reason = safeStatsfmReason(error.reason) ?? (error.reason && /registration[-_ ]?gated/i.test(error.reason)
      ? 'registration_gated'
      : 'statsfm_access_forbidden');
    fix = 'Use a permitted stats.fm tool, or request the required access.';
    text = `${tool} is not available from stats.fm for this request; use a permitted tool or request access.`;
  } else if (error.status === 404) {
    kind = 'not_found';
    reason = safeStatsfmReason(error.reason) ?? 'statsfm_resource_not_found';
    fix = 'Verify the stats.fm identifier and retry.';
    text = `${tool} could not find the requested stats.fm resource; verify its identifier and retry.`;
  } else if (error.status === 429) {
    kind = 'rate_limited';
    reason = safeStatsfmReason(error.reason) ?? 'statsfm_rate_limited';
    fix = typeof error.retryAfterSec === 'number'
      ? `Wait ${error.retryAfterSec} seconds before retrying.`
      : 'Wait before retrying.';
    text = typeof error.retryAfterSec === 'number'
      ? `${tool} was rate-limited by stats.fm; retry after ${error.retryAfterSec} seconds.`
      : `${tool} was rate-limited by stats.fm; retry later.`;
  } else if (error.status === 503) {
    kind = 'unavailable';
    reason = safeStatsfmReason(error.reason) ?? 'statsfm_unavailable';
    fix = 'Retry shortly.';
    text = `${tool} could not reach stats.fm because the service is unavailable; retry shortly.`;
  } else {
    kind = 'internal';
    reason = safeStatsfmReason(error.reason) ?? 'statsfm_error';
    fix = 'Retry once; if the failure persists, inspect protected server diagnostics.';
    text = `${tool} failed unexpectedly; retry once and inspect protected server diagnostics if it persists.`;
  }
  return {
    kind,
    reason,
    fix,
    text,
    status: error.status,
    ...(kind === 'rate_limited' && typeof error.retryAfterSec === 'number'
      ? { retryAfterSec: error.retryAfterSec }
      : {}),
  };
}

function validationParam(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('issues' in error) || !Array.isArray(error.issues)) {
    return undefined;
  }
  for (const issue of error.issues) {
    if (issue === null || typeof issue !== 'object' || !('path' in issue) || !Array.isArray(issue.path)) continue;
    const first = issue.path[0];
    if (typeof first === 'string' && first.length > 0) return safeIdentifier(first);
    if (typeof first === 'number') return safeIdentifier(String(first));
  }
  return undefined;
}

function safeSpotifyReason(reason: unknown): string | undefined {
  return typeof reason === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(reason) ? reason : undefined;
}

function defaultReason(kind: ErrorKind): string {
  switch (kind) {
    case 'auth': return 'authentication_required';
    case 'forbidden': return 'spotify_access_forbidden';
    case 'not_found': return 'spotify_resource_not_found';
    case 'rate_limited': return 'spotify_rate_limited';
    case 'unavailable': return 'spotify_unavailable';
    case 'conflict': return 'playlist_changed_since_read';
    case 'validation': return 'validation_failed';
    case 'unknown_tool': return 'tool_not_registered';
    case 'unknown_param': return 'parameter_not_accepted';
    case 'internal': return 'internal_error';
  }
}

function publicFailure(tool: string, error: unknown): ErrorFields {
  const typedError = findTypedApiError(error);
  if (typedError instanceof StatsfmApiError) return statsfmFailure(tool, typedError);
  if (typedError instanceof SpotifyApiError) {
    const spotifyError = typedError;
    const status = spotifyError.status;
    let kind: ErrorKind;
    let text: string;
    let fix: string;
    if (status === 401) {
      kind = 'auth';
      text = `${tool} could not authenticate with Spotify; run "spotify-mcp auth" and retry.`;
      fix = 'Run "spotify-mcp auth" and retry.';
    } else if (status === 403) {
      kind = 'forbidden';
      text = `${tool} is not available for this Spotify app registration or account; use a permitted tool or request the required access.`;
      fix = 'Use a permitted tool, or request the required Spotify access for this app registration.';
    } else if (status === 404) {
      kind = 'not_found';
      text = `${tool} could not find the requested Spotify resource; verify its identifier and retry.`;
      fix = 'Verify the Spotify identifier and retry.';
    } else if (status === 429) {
      kind = 'rate_limited';
      const wait = spotifyError.retryAfterSec;
      text = typeof wait === 'number'
        ? `${tool} was rate-limited by Spotify; retry after ${wait} seconds.`
        : `${tool} was rate-limited by Spotify; retry later.`;
      fix = typeof wait === 'number' ? `Wait ${wait} seconds before retrying.` : 'Wait before retrying.';
    } else if (status === 408 || status === 503) {
      kind = 'unavailable';
      text = status === 408
        ? `${tool} timed out while waiting for Spotify; retry shortly.`
        : `${tool} could not reach Spotify because the service is unavailable; retry shortly.`;
      fix = 'Retry shortly.';
    } else if (status === 400 || status === 422) {
      kind = 'validation';
      text = `${tool} received invalid arguments; pass values that match the tool schema.`;
      fix = 'Pass values that match the tool schema.';
    } else {
      kind = 'internal';
      text = `${tool} failed unexpectedly; retry once and inspect protected server diagnostics if it persists.`;
      fix = 'Retry once; if the failure persists, inspect protected server diagnostics.';
    }
    return {
      kind,
      reason: status === 403 && safeSpotifyReason(spotifyError.reason) === 'REGISTRATION_GATED'
        ? 'registration_gated'
        : safeSpotifyReason(spotifyError.reason) ?? defaultReason(kind),
      fix,
      text,
      status,
      ...(kind === 'rate_limited' && typeof spotifyError.retryAfterSec === 'number'
        ? { retryAfterSec: spotifyError.retryAfterSec }
        : {}),
    };
  }

  const message = (error instanceof Error ? error.message : String(error)).replace(/^MCP error -\d+:\s*/, '').trim();
  const lower = message.toLowerCase();
  if (/not authenticated|no token file|token refresh failed|spotify-mcp auth|spotify auth error/.test(lower)) {
    return {
      kind: 'auth',
      reason: defaultReason('auth'),
      fix: 'Run "spotify-mcp auth" and retry.',
      text: `${tool} could not authenticate with Spotify; run "spotify-mcp auth" and retry.`,
    };
  }
  if (/app-registration gated|registration-gated|forbidden|access denied|premium required|oauth scope|scope .*missing|market-gated/.test(lower)) {
    return {
      kind: 'forbidden',
      reason: lower.includes('gated') ? 'registration_gated' : defaultReason('forbidden'),
      fix: 'Use a permitted tool, or request the required Spotify access for this app registration.',
      text: `${tool} is not available for this Spotify app registration or account; use a permitted tool or request the required access.`,
    };
  }
  if (/\bnot found\b|does not exist/.test(lower)) {
    return {
      kind: 'not_found',
      reason: defaultReason('not_found'),
      fix: 'Verify the Spotify identifier and retry.',
      text: `${tool} could not find the requested Spotify resource; verify its identifier and retry.`,
    };
  }
  if (/rate.?limit|retry-after|quota exceeded/.test(lower)) {
    return {
      kind: 'rate_limited',
      reason: defaultReason('rate_limited'),
      fix: 'Wait before retrying.',
      text: `${tool} was rate-limited by Spotify; retry later.`,
    };
  }
  if (/temporarily unavailable|service unavailable|retry shortly|fetch failed|econnreset|socket hang up/.test(lower)) {
    return {
      kind: 'unavailable',
      reason: defaultReason('unavailable'),
      fix: 'Retry shortly.',
      text: `${tool} could not reach Spotify because the service is unavailable; retry shortly.`,
    };
  }
  // A guard that aborts because the playlist changed under it is neither an
  // unexpected crash nor a bad argument: nothing was written, and the caller
  // must re-read and re-run to see the new impact. Classifying it as internal
  // throws that instruction away and invites a blind retry.
  if (/changed during|re-run to review|out of date|stale (?:playlist|snapshot|state)|snapshot .* mismatch/.test(lower)) {
    return {
      kind: 'conflict',
      reason: defaultReason('conflict'),
      fix: 'Re-read the playlist and re-run to review the new destructive impact.',
      text: `${tool} refused to write because the playlist changed since it was read; re-read it and re-run to review the new destructive impact.`,
    };
  }
  if (/^(?:invalid (?:(?:playable )?(?:spotify )?(?:reference|uris?)|spotify track\/episode uri|playlist reference)|(?:no resolvable|no valid).*uris?\b)|invalid arguments?|input validation|must |required|provide at least|pass either|not both|expected /.test(lower)) {
    return {
      kind: 'validation',
      reason: defaultReason('validation'),
      fix: 'Pass values that match the tool schema.',
      text: `${tool} received invalid arguments; pass values that match the tool schema.`,
    };
  }
  return {
    kind: 'internal',
    reason: defaultReason('internal'),
    fix: 'Retry once; if the failure persists, inspect protected server diagnostics.',
    text: `${tool} failed unexpectedly; retry once and inspect protected server diagnostics if it persists.`,
  };
}

function errorResult(tool: string, fields: ErrorFields, diagnostic: unknown) {
  const correlationId = globalThis.crypto.randomUUID();
  const safeReason = /^[a-z][a-z0-9_]{0,63}$/.test(fields.reason) ? fields.reason : 'classified_error';
  const status = fields.status === undefined ? 'none' : String(fields.status);
  // The breadcrumb an operator actually reads: which tool, which class, and —
  // for an unknown tool or parameter — what was asked for. Sanitised like every
  // other log line, so a caller-supplied name cannot inject newlines or paths
  // that the redaction policy exists to keep off stderr.
  const detail = typeof diagnostic === 'string' ? ` detail=${safeIdentifier(diagnostic.slice(0, 120))}` : '';
  console.error(
    `[spotify-mcp] error correlation_id=${correlationId} tool=${safeIdentifier(tool)} kind=${fields.kind} status=${status} reason=${safeReason}${detail}`,
  );

  const error: Record<string, unknown> = {
    tool,
    kind: fields.kind,
    reason: fields.reason,
    fix: fields.fix,
  };
  if (fields.status !== undefined) error.status = fields.status;
  if (fields.retryAfterSec !== undefined) error.retryAfterSec = fields.retryAfterSec;
  if (fields.param !== undefined) error.param = fields.param;
  return {
    content: [{ type: 'text' as const, text: fields.text }],
    structuredContent: { error },
    isError: true,
  };
}

function unknownToolResult(registry: Record<string, RegistryEntry>, requested: string) {
  const tool = safeIdentifier(requested);
  const suggestions = nearestNames(requested, Object.keys(registry));
  const suggestionText = suggestions.length > 0
    ? `call ${humanList(suggestions)} instead.`
    : 'call a tool advertised by tools/list instead.';
  return errorResult(tool, {
    kind: 'unknown_tool',
    reason: defaultReason('unknown_tool'),
    fix: suggestions.length > 0 ? `Call ${humanList(suggestions)} instead.` : 'Call a tool advertised by tools/list instead.',
    text: `${tool} is not an available tool; ${suggestionText}`,
  }, `unknown tool ${JSON.stringify(requested)}`);
}

function unknownParamResult(tool: string, param: string, candidates: string[]) {
  let suggestions = nearestNames(param, candidates);
  if (suggestions.length === 0 && param === 'limit' && candidates.includes('offset')) {
    suggestions = ['offset'];
    if (candidates.includes('max_results')) suggestions.push('max_results');
  }
  const replacement = suggestions.length > 0
    ? `use ${humanList(suggestions)} instead.`
    : 'use only parameters advertised by the tool schema instead.';
  return errorResult(tool, {
    kind: 'unknown_param',
    reason: defaultReason('unknown_param'),
    fix: suggestions.length > 0
      ? `Remove ${safeIdentifier(param)} and use ${humanList(suggestions)}.`
      : `Remove ${safeIdentifier(param)} and use only advertised parameters.`,
    text: `${tool} does not accept parameter ${safeIdentifier(param)}; remove it and ${replacement}`,
    param: safeIdentifier(param),
  }, `unknown parameter ${JSON.stringify(param)}`);
}

function validationResult(tool: string, param: string | undefined) {
  const subject = param ? `parameter ${safeIdentifier(param)}` : 'arguments';
  return errorResult(tool, {
    kind: 'validation',
    reason: defaultReason('validation'),
    fix: param ? `Pass a valid value for ${safeIdentifier(param)}.` : 'Pass values that match the tool schema.',
    text: `${tool} rejected ${subject}; pass a valid value according to the tool schema.`,
    ...(param ? { param: safeIdentifier(param) } : {}),
  }, param ? `schema validation failed for parameter ${param}` : 'schema validation failed');
}

async function invokeHandler(entry: RegistryEntry, args: unknown, extra: unknown): Promise<unknown> {
  const handler = entry.handler;
  if (typeof handler === 'function') {
    return entry.inputSchema ? handler(args, extra) : handler(extra);
  }
  if (handler && typeof handler.createTask === 'function') {
    return entry.inputSchema ? handler.createTask(args, extra) : handler.createTask(extra);
  }
  throw new Error(`Tool handler is unavailable for ${String(handler)}`);
}

async function validateOutput(entry: RegistryEntry, result: unknown, tool: string, isTaskRequest: boolean): Promise<void> {
  if (!entry.outputSchema || isTaskRequest || result === null || typeof result !== 'object' || !('content' in result)) return;
  const output = result as { isError?: unknown; structuredContent?: unknown };
  if (output.isError === true) return;
  if (output.structuredContent === undefined) {
    throw new Error(`Output validation failed for ${tool}: structured content is required`);
  }
  const parsed = await safeParseAsync(entry.outputSchema, output.structuredContent);
  if (!parsed.success) throw new Error(`Output validation failed for ${tool}`);
}

/**
 * Replace the SDK's two early tools handlers with the final production boundary.
 * It advertises closed root input objects, rejects unknown keys before any
 * callback runs, preserves parsed handler/output semantics, and turns every
 * failure into a one-line public envelope with diagnostics confined to stderr.
 */
export function installToolErrorBoundary(server: McpServer): number {
  const registry = getToolRegistry(server);
  const lowLevelServer = server.server;

  lowLevelServer.removeRequestHandler('tools/list');
  lowLevelServer.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: Object.entries(registry)
      .filter(([, entry]) => entry.enabled !== false)
      .map(([name, entry]) => {
        const inputSchema = applyStableListDefaults(name, finalInputSchema(entry.inputSchema));

        const definition: Record<string, unknown> = { name, inputSchema };
        if (entry.title !== undefined) definition.title = entry.title;
        if (entry.description !== undefined) definition.description = entry.description;
        if (entry.annotations !== undefined) definition.annotations = entry.annotations;
        if (entry.execution !== undefined) definition.execution = entry.execution;
        if (entry._meta !== undefined) definition._meta = entry._meta;
        if (entry.outputSchema) {
          const outputObject = normalizeObjectSchema(entry.outputSchema);
          if (outputObject) {
            definition.outputSchema = toJsonSchemaCompat(outputObject, { pipeStrategy: 'output' });
          }
        }
        return definition;
      }),
  }) as unknown as ServerResult);

  lowLevelServer.removeRequestHandler('tools/call');
  lowLevelServer.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const requested = request.params.name;
    const entry = registry[requested];
    if (!entry || entry.enabled === false) return unknownToolResult(registry, requested);

    const tool = safeIdentifier(requested);
    const shape = getObjectShape(entry.inputSchema);
    const knownParams = shape ? Object.keys(shape) : [];
    const args = request.params.arguments ?? {};
    const unknown = Object.keys(args).find((param) => !knownParams.includes(param));
    if (unknown) return unknownParamResult(tool, unknown, knownParams);

    let parsedArgs: unknown;
    try {
      if (entry.inputSchema) {
        const parsed = await safeParseAsync(entry.inputSchema, args);
        if (!parsed.success) return validationResult(tool, validationParam(parsed.error));
        parsedArgs = parsed.data;
      }
    } catch {
      return validationResult(tool, undefined);
    }

    try {
      const result = await invokeHandler(entry, parsedArgs, extra);
      await validateOutput(entry, result, tool, request.params.task !== undefined);
      return result as ServerResult;
    } catch (error) {
      return errorResult(tool, publicFailure(tool, error), error) as ServerResult;
    }
  });

  return Object.keys(registry).length;
}
