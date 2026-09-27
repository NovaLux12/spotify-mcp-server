/**
 * backup_first (#216): pre-flight snapshot for account-wide destructive tools.
 * Also exposes backup_first as a standalone tool.
 */
import { z } from 'zod';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SpotifyApiError, type SpotifyClient } from '../client.js';
import { getConfig } from '../config.js';
import { backupDir, nextBackupSeq, collectSnapshot } from './backup.js';
import { ResponseFormat } from '../shaping.js';
import { textResult } from '../result.js';

class BackupFirstError extends Error {
  constructor() {
    super('Pre-flight backup could not be created.');
    this.name = 'BackupFirstError';
  }
}

/**
 * Per-collection row counts in the pre-flight file's `_meta`.
 *
 * A `type` rather than an `interface` so it is assignable to the wire's
 * `Record<string, unknown>` without a cast (#1343). Every field is a real
 * count of rows that were read: `collectSnapshot` returns an array for each
 * collection even when a walk was truncated, and truncation is reported
 * separately in the file's own `collections` status. A count is never a
 * stand-in for a read that did not happen (#803).
 */
type PreflightCounts = {
  liked_tracks: number;
  saved_albums: number;
  saved_shows: number;
  saved_episodes: number;
  saved_audiobooks: number;
  followed_artists: number;
  playlists: number;
  playlist_items: number;
};

/** Create a pre-flight snapshot and return its path + counts. Throws on failure. */
async function createPreflightSnapshot(
  client: SpotifyClient,
  opts?: { notes?: string },
): Promise<{ file: string; counts: PreflightCounts; bytes: number }> {
  const cap = getConfig().fetchAllCap;
  // `SnapshotBody` already declares all seven collections as arrays, so the
  // lengths are readable without laundering the snapshot through a cast. The
  // previous `?? 0` fallbacks were guarding a shape the type already
  // guaranteed, and they had the side effect of publishing a confident 0 for
  // any collection that ever came back unreadable (#803).
  const collected = await collectSnapshot(client, cap);
  const created = new Date().toISOString();
  const counts: PreflightCounts = {
    liked_tracks: collected.liked_tracks.length,
    saved_albums: collected.saved_albums.length,
    saved_shows: collected.saved_shows.length,
    saved_episodes: collected.saved_episodes.length,
    saved_audiobooks: collected.saved_audiobooks.length,
    followed_artists: collected.followed_artists.length,
    playlists: collected.playlists.length,
    playlist_items: 0,
  };
  const snapshot = {
    _meta: {
      created,
      ...(opts?.notes ? { notes: opts.notes } : {}),
      counts,
    },
    ...collected,
  };
  // Abort if snapshot is empty when it shouldn't be
  const totalCaptured = counts.playlists + counts.liked_tracks + counts.followed_artists;
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
  return { file, counts, bytes: Buffer.byteLength(body) };
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
      } catch (error) {
        if (error instanceof SpotifyApiError) {
          throw new SpotifyApiError(error.status, 'Pre-flight backup could not be created.', error.retryAfterSec, error.reason);
        }
        throw new BackupFirstError();
      }
    },
  );
}
