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

/** v2-retired names and their canonical replacements (#917). */
export const DEPRECATED_TOOL_ALIASES = Object.freeze({
  get_show_episodes: 'list_show_episodes',
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

export type ToolErrorKind =
  | 'auth' | 'forbidden' | 'not_found' | 'rate_limited' | 'unavailable'
  | 'validation' | 'unknown_tool' | 'unknown_param' | 'internal';

export interface ToolErrorContext {
  kind?: ToolErrorKind;
  param?: string;
  suggestions?: readonly string[];
}

export interface StructuredToolError {
  tool: string;
  kind: ToolErrorKind;
  status: number | null;
  retryAfterSec: number | null;
  reason: string | null;
  param: string | null;
  fix: string;
}


/** Convert any tool failure to the one-line + machine-readable MCP envelope. */
export function toolErrorResult(
  tool: string,
  error: unknown,
  context: ToolErrorContext = {},
): { isError: true; content: [{ type: 'text'; text: string }]; structuredContent: { error: StructuredToolError } } {
  let status: number | null = null;
  let retryAfterSec: number | null = null;
  let reason: string | null = null;
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const value = current as { status?: unknown; retryAfterSec?: unknown; reason?: unknown; cause?: unknown };
    if (typeof value.status === 'number') {
      status = value.status;
      retryAfterSec = typeof value.retryAfterSec === 'number' ? value.retryAfterSec : null;
      reason = typeof value.reason === 'string' ? value.reason : null;
      break;
    }
    current = value.cause;
  }
  const kind: ToolErrorKind = context.kind
    ?? (status === null ? 'internal' : status === 401 ? 'auth' : status === 403 ? 'forbidden' : status === 404 ? 'not_found' : status === 429 ? 'rate_limited' : status === 408 || status === 503 ? 'unavailable' : 'internal');
  const message = (error instanceof Error ? error.message : String(error)).replace(/^MCP error -?\d+:\s*/i, '').replace(/\s+/g, ' ').trim();
  const suggestions = context.suggestions ?? [];
  const fix = kind === 'unknown_param'
    ? (suggestions.length > 0 ? `Use one of: ${suggestions.join(', ')}.` : 'Use only the parameters advertised by tools/list.')
    : kind === 'validation' ? 'Check the argument names and values against the tool input schema.'
      : kind === 'unknown_tool' ? 'Call tools/list and use an advertised tool name.'
        : kind === 'auth' ? 'Refresh Spotify credentials, then retry once.'
          : kind === 'forbidden' ? 'Check Premium access, app registration eligibility, and OAuth scopes.'
            : kind === 'not_found' ? 'Verify the Spotify ID or URI, then retry.'
              : kind === 'rate_limited' ? (retryAfterSec === null ? 'Retry after the rate-limit window.' : `Wait ${retryAfterSec} seconds before retrying.`)
                : kind === 'unavailable' ? 'Spotify is temporarily unavailable; retry later.'
                  : 'Retry once; if the failure persists, inspect the Spotify API response.';
  const sentence = kind === 'unknown_param'
    ? `${tool}: unknown argument "${context.param}"; ${fix}`
    : `${tool}: ${message || 'request failed'} Fix: ${fix}`;
  const structured: StructuredToolError = {
    tool,
    kind,
    status,
    retryAfterSec,
    reason,
    param: context.param ?? null,
    fix,
  };
  return { isError: true, content: [{ type: 'text', text: sentence }], structuredContent: { error: structured } };
}

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
type ToolRegistryHolder = { _registeredTools?: Record<string, unknown> };

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

/** Remove v2-retired endpoint aliases before the first tools/list handshake. */
export function removeDeprecatedToolAliases(server: McpServer): string[] {
  const registryHolder = server as unknown as ToolRegistryHolder;
  const registry = registryHolder._registeredTools;
  if (!registry || typeof registry !== 'object') return [];
  const removed: string[] = [];
  for (const name of Object.keys(DEPRECATED_TOOL_ALIASES)) {
    if (Object.hasOwn(registry, name)) {
      delete registry[name];
      removed.push(name);
    }
  }
  return removed;
}
