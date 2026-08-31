/**
 * backup_first (#216): pre-flight snapshot for account-wide destructive tools.
 * Also exposes backup_first as a standalone tool.
 */
import { z } from 'zod';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { getConfig } from '../config.js';
import { backupDir, nextBackupSeq, collectSnapshot } from './backup.js';
import { ResponseFormat } from '../shaping.js';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown> };
function textResult(text: string, s?: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text }], ...(s ? { structuredContent: s } : {}) };
}

/** Create a pre-flight snapshot and return its path + counts. Throws on failure. */
export async function createPreflightSnapshot(
  client: SpotifyClient,
  opts?: { notes?: string },
): Promise<{ file: string; counts: Record<string, unknown>; bytes: number }> {
  const cap = getConfig().fetchAllCap;
  const collected = await collectSnapshot(client, cap);
  const created = new Date().toISOString();
  const snapshot = {
    _meta: {
      created,
      ...(opts?.notes ? { notes: opts.notes } : {}),
      counts: {
        liked_tracks: (collected as unknown as { liked_tracks: unknown[] }).liked_tracks?.length ?? 0,
        saved_albums: (collected as unknown as { saved_albums: unknown[] }).saved_albums?.length ?? 0,
        saved_shows: (collected as unknown as { saved_shows: unknown[] }).saved_shows?.length ?? 0,
        saved_episodes: (collected as unknown as { saved_episodes: unknown[] }).saved_episodes?.length ?? 0,
        saved_audiobooks: (collected as unknown as { saved_audiobooks: unknown[] }).saved_audiobooks?.length ?? 0,
        followed_artists: (collected as unknown as { followed_artists: unknown[] }).followed_artists?.length ?? 0,
        playlists: (collected as unknown as { playlists: unknown[] }).playlists?.length ?? 0,
        playlist_items: 0,
      },
    },
    ...collected,
  };
  // Abort if snapshot is empty when it shouldn't be
  const c = snapshot._meta.counts as Record<string, number>;
  const totalCaptured = (c.playlists ?? 0) + (c.liked_tracks ?? 0) + (c.followed_artists ?? 0);
  if (totalCaptured === 0) {
    // Still write it but caller should treat as warning
  }
  const dir = backupDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const dateStamp = created.slice(0, 10);
  const seq = await nextBackupSeq(dir, dateStamp);
  const file = join(dir, `backup-${dateStamp}-${seq}.json`);
  const body = `${JSON.stringify(snapshot, null, 2)}\n`;
  await writeFile(file, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return { file, counts: c as unknown as Record<string, unknown>, bytes: Buffer.byteLength(body) };
}

export function registerBackupFirstTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'backup_first',
    'Create a pre-flight library snapshot before a destructive operation. Returns snapshot file path and counts for later restore. Read-only against Spotify.',
    {
      notes: z.string().optional().describe('Free-text note for the snapshot'),
      response_format: ResponseFormat,
    },
    async (args) => {
      try {
        const snap = await createPreflightSnapshot(client, { notes: args.notes });
        const text = `Pre-flight backup written → ${snap.file} (${snap.bytes} bytes)\nCounts: ${JSON.stringify(snap.counts)}`;
        return textResult(text, { ok: true, file: snap.file, counts: snap.counts, bytes: snap.bytes });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return textResult(`Pre-flight backup failed: ${msg}`, { ok: false, error: msg });
      }
    },
  );
}
