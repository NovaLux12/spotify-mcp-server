/**
 * MCP tool annotations (#565 / A0-002, A4-005).
 *
 * Before this module, 0 of 608 tools carried `annotations`, so a host could not
 * tell `get_track` (safe read) from `remove_duplicate_playlist_items` (destroys
 * playlist rows) and had to either prompt for everything or nothing. The SDK
 * projects `annotations` (and `title`) straight from its registry, and exposes
 * `registeredTool.update({ annotations, title })` — so classification is applied
 * once, after registration, from a single table instead of 573 call sites.
 *
 * Classification is deliberately conservative and name-driven:
 *  - a tool is READ-ONLY only when its verb cannot mutate (get/list/search/…);
 *  - anything matching a removal/replacement verb is DESTRUCTIVE;
 *  - set-like writes (save/follow/pin/update/…) are marked idempotent;
 *  - every Spotify/stats.fm tool reaches an external world: openWorldHint true.
 * Tool-specific overrides live in OVERRIDES below and win over the patterns.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Tool names whose behaviour the verb patterns cannot infer correctly. */
const OVERRIDES: Record<string, ToolAnnotations> = {
  // Writes that read like reads.
  verify_receipt: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  export_playlist: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  export_all_playlists: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  export_library: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  backup_library: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  spotify_doctor: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  // Playback control changes state but destroys nothing.
  play: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  pause: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  next_track: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  previous_track: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  // Restore/undo are the inverse of a destructive act, not destructive themselves.
  undo_mutation: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  undo_last_mutation: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

const READ_ONLY_VERBS = /^(get|list|search|check|inspect|find|show|describe|report|count|is|has|read|resolve|validate|preview|plan|recommend|suggest|browse|lookup|compare|diff|stats|summary|summarize|summarise|analyze|analyse|estimate|diagnose|quiz|recap|census|audit|health|review|leaderboard|timeline|heatmap|trends?|insights?|coverage|orphans?|duplicates?|gaps?|distribution|breakdown|matrix|explorer|probe|snapshot_status|digest|briefing|radar|watch_\w*_status)/;

const DESTRUCTIVE_VERBS = /^(remove|delete|unfollow|unsave|archive|clean|clear|purge|drop|trash|replace|reset|revert|cull|prune|trim|strip|garbage|destroy|wipe|empty|unpin|unarchive|disconnect|logout|revoke|erase)/;

const IDEMPOTENT_WRITE_VERBS = /^(save|follow|pin|set|update|add|remove|delete|unsave|unfollow|archive|replace|restore|cache|mark|assign|sync|apply|import|transfer|move|reorder|sort|shuffle|rename|retag|undo)/;

/**
 * Trim a classification to the fields worth serialising. Every tool advertises
 * four booleans otherwise; on 608 tools that is ~100 KB of schema per session, so
 * only non-default values are emitted (`openWorldHint` defaults to true, and the
 * destructive/idempotent hints matter only when set). `readOnlyHint` is always
 * explicit because hosts gate auto-approval on it.
 */
export function toWireAnnotations(a: ToolAnnotations): ToolAnnotations {
  const out: ToolAnnotations = { title: a.title, readOnlyHint: a.readOnlyHint === true };
  if (a.destructiveHint) out.destructiveHint = true;
  if (a.idempotentHint) out.idempotentHint = true;
  if (a.openWorldHint === false) out.openWorldHint = false;
  return out;
}

/** Human-readable title: `batch_add_to_playlist` → `Batch add to playlist`. */
export function titleFor(toolName: string): string {
  const words = toolName.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Classify one tool by name; explicit overrides win. */
export function classifyToolAnnotations(toolName: string): ToolAnnotations {
  const override = OVERRIDES[toolName];
  if (override) return { title: titleFor(toolName), openWorldHint: true, ...override };

  const isDestructive = DESTRUCTIVE_VERBS.test(toolName);
  const looksReadOnly = READ_ONLY_VERBS.test(toolName);
  // `fetch_*`/`resolve_*`-style helpers are reads; `*_preview`/`*_plan` describe.
  const readOnly = !isDestructive && (looksReadOnly || /_(preview|plan|status|info)$/.test(toolName));

  return {
    title: titleFor(toolName),
    readOnlyHint: readOnly,
    destructiveHint: isDestructive,
    idempotentHint: readOnly || IDEMPOTENT_WRITE_VERBS.test(toolName),
    openWorldHint: true,
  };
}

interface RegistryEntry {
  annotations?: unknown;
  title?: string;
  update?: (u: { annotations?: ToolAnnotations; title?: string }) => void;
}

/**
 * Attach annotations + titles to every registered tool.
 * Uses the SDK's `update()` when available (it also notifies hosts of the change)
 * and falls back to assigning the fields directly. Returns counts so callers can
 * assert coverage instead of assuming it.
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
    const annotations = toWireAnnotations(classifyToolAnnotations(name));
    try {
      if (typeof entry.update === 'function') entry.update({ annotations, title: annotations.title });
      else {
        entry.annotations = annotations;
        entry.title = annotations.title;
      }
      annotated++;
    } catch {
      // A registry that rejects updates is a host-shape change: better to leave the
      // tool unannotated than to fail server startup.
    }
  }
  return { total: Object.keys(registry).length, annotated };
}
