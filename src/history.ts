/**
 * Opt-in mutation history JSONL (#64). When SPOTIFY_MCP_HISTORY is truthy,
 * every agent-driven mutation appends one JSON line under
 * ~/.spotify-mcp/history/mutations.jsonl (override dir with
 * SPOTIFY_MCP_HISTORY_DIR) recording who/what/snapshot_id — enabling undo,
 * audit and cross-session personalization.
 *
 * Records are written through a strict field whitelist so tokens or raw
 * request/response bodies can never leak into the file.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { truthyEnv } from './config.js';

export interface MutationRecord {
  /** HTTP method of the mutating call (POST/PUT/DELETE). */
  method: string;
  /** API path that was mutated, e.g. /playlists/{id}/items. */
  path: string;
  /** snapshot_id echoed by the API response when present (undo anchor). */
  snapshot_id?: string;
  /** Actor label; defaults to 'agent' (all mutations come from MCP tools). */
  who?: string;
}

export function isHistoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthyEnv(env.SPOTIFY_MCP_HISTORY);
}

/** Target JSONL path; SPOTIFY_MCP_HISTORY_DIR overrides the directory. */
export function historyFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.SPOTIFY_MCP_HISTORY_DIR ?? join(homedir(), '.spotify-mcp', 'history');
  return join(dir, 'mutations.jsonl');
}

/**
 * Append one mutation record. No-op unless history is enabled; never throws
 * to the caller's face is NOT a goal here — callers (client) catch and drop.
 */
export async function appendHistory(record: MutationRecord): Promise<void> {
  if (!isHistoryEnabled()) return;
  // Whitelist serialization: only these five fields ever reach disk, so a
  // stray token/body reference in the record object cannot be persisted.
  const line =
    JSON.stringify({
      ts: new Date().toISOString(),
      who: record.who ?? 'agent',
      method: record.method.toUpperCase(),
      path: record.path,
      ...(record.snapshot_id !== undefined ? { snapshot_id: record.snapshot_id } : {}),
    }) + '\n';
  const file = historyFilePath();
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, line, 'utf8');
}
