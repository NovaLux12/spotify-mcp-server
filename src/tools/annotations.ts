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
import { CallToolRequestSchema, ListToolsRequestSchema, type ServerResult } from '@modelcontextprotocol/sdk/types.js';
import { getObjectShape, normalizeObjectSchema, safeParseAsync } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { SpotifyApiError } from '../client.js';

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


type ErrorKind =
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'unavailable'
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

function findSpotifyApiError(error: unknown): SpotifyApiError | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (current instanceof SpotifyApiError) return current;
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
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
    case 'validation': return 'validation_failed';
    case 'unknown_tool': return 'tool_not_registered';
    case 'unknown_param': return 'parameter_not_accepted';
    case 'internal': return 'internal_error';
  }
}

function publicFailure(tool: string, error: unknown): ErrorFields {
  const spotifyError = findSpotifyApiError(error);
  if (spotifyError) {
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
    } else if (status === 503) {
      kind = 'unavailable';
      text = `${tool} could not reach Spotify because the service is unavailable; retry shortly.`;
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
      reason: safeSpotifyReason(spotifyError.reason) ?? defaultReason(kind),
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
  if (/invalid arguments?|input validation|must |required|provide at least|pass either|not both|expected /.test(lower)) {
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
  const rawDiagnostic = diagnostic instanceof Error
    ? (diagnostic.stack ?? diagnostic.message)
    : String(diagnostic);
  console.error(
    `[spotify-mcp] error correlation_id=${correlationId} tool=${safeIdentifier(tool)} kind=${fields.kind} diagnostic=${JSON.stringify(rawDiagnostic)}`,
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
        const objectSchema = normalizeObjectSchema(entry.inputSchema);
        const inputSchema = objectSchema
          ? toJsonSchemaCompat(objectSchema, { pipeStrategy: 'input' })
          : { type: 'object', properties: {} };
        inputSchema.additionalProperties = false;
        delete inputSchema.$schema;

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
