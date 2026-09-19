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
 * with an allowlisted non-mutating verb AND does not start with a mutating one.
 * That matters because `plan`/`preview` in a name does not guarantee a
 * non-executing handler — the audit found dry-run defaults are inconsistent
 * (A4-006), and names like `apply_volume_plan` execute — so anything unknown
 * advertises as a write and the host keeps its confirmation.
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
 * Writes, even when the rest of the name looks like a read or a plan. Kept
 * deliberately broad: `*_plan`/`*_preview` handlers are not guaranteed to be
 * non-executing, and `apply_*`/`start_*` clearly are not.
 */
const MUTATING_PREFIXES =
  /^(apply|start|save|add|create|update|set|replace|import|move|copy|remove|delete|unfollow|unsave|follow|pin|fill|merge|split|sort|shuffle|reorder|transfer|restore|cancel|clean|clear|trim|cull|archive|mark|queue|play|pause|skip|seek|generate|grow|balance|reschedule|migrate|handoff|dj|undo|export|backup|write|upload|rename|retag|sync|dedupe|take|snapshot|plan|volume|sleep|transfer_playback|recently|retry|revert|reset|purge|wipe|drop|erase|revoke|disconnect|logout)/;

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
  // Snapshot rewrites: additive in the library case, row-deleting in the playlist case.
  // (`undo_preview` and `restore_playlist_plan` deliberately get NO read-only override:
  // "plan"/"preview" in a name does not guarantee a non-executing handler.)
  restore_library_snapshot: { destructiveHint: false },
  restore_playback_state: { destructiveHint: false },
  restore_playback: { destructiveHint: false },
  restore_playlist_from_snapshot: { destructiveHint: true },
  apply_snapshot_changes: { destructiveHint: true },
  merge_snapshot_changes: { destructiveHint: true },
};

/**
 * Classify one tool. Returns only the fields worth putting on the wire:
 * non-default values plus an explicit `destructiveHint` for every write (MCP
 * defaults it to true, so silence means "may destroy").
 */
export function classifyToolAnnotations(toolName: string): ToolAnnotations {
  const override = OVERRIDES[toolName];
  if (override) return { ...override };

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
