/**
 * Portability (#188 + #192): save_discover_weekly / save_release_radar (archive
 * personalized playlists) + export_library_json / export_followed_artists
 * (full data portability to local sidecar files).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import {
  ResponseFormat,
  DryRun,
  describeDryRun,
  batchSummary,
} from '../shaping.js';
import type { ResponseFormatValue } from '../shaping.js';
import { issueReceipt, formatReceipt } from '../receipts.js';
import { getConfig } from '../config.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
  SpotifyPaged,
  PlaylistItemObject,
  SavedTrackItem,
  SavedAlbumItem,
  SavedShowItem,
  SavedEpisodeItem,
  SpotifyPlaylistSimple,
  FollowedArtistsResponse,
} from '../types/spotify.js';

type ToolOut = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function shapeResult(rf: ResponseFormatValue, prose: string, payload: Record<string, unknown>): ToolOut {
  return {
    content: [{ type: 'text', text: rf === 'json' ? JSON.stringify(payload, null, 2) : prose }],
    structuredContent: payload,
  };
}

function portabilityDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SPOTIFY_MCP_PORTABILITY_DIR ?? join(homedir(), '.spotify-mcp', 'portability');
}

function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

async function resolvePlaylistByName(client: SpotifyClient, name: string): Promise<string | null> {
  const res = await client.get<{ playlists?: { items: Array<{ id: string; name: string } | null> } }>(
    '/search',
    { q: name, type: 'playlist', limit: '10' },
  );
  const items = res?.playlists?.items ?? [];
  const exact = items.find((p) => p?.name?.toLowerCase() === name.toLowerCase());
  if (exact) return exact.id;
  const fuzzy = items.find((p) => p?.name?.toLowerCase().includes(name.toLowerCase()));
  return fuzzy?.id ?? null;
}

async function findArchivePlaylist(client: SpotifyClient, archiveName: string): Promise<string | null> {
  const playlists = await client.getAllPages<SpotifyPlaylistSimple>('/me/playlists', { limit: '50' });
  const found = playlists.find((p) => p?.name?.toLowerCase() === archiveName.toLowerCase());
  return found?.id ?? null;
}

async function savePersonalized(
  client: SpotifyClient,
  args: { sourceName: string; archiveName: string; dry_run?: boolean; response_format: ResponseFormatValue },
): Promise<ToolOut> {
  const rf = args.response_format;
  const sourceId = await resolvePlaylistByName(client, args.sourceName);
  if (!sourceId) throw new Error(`Could not find playlist "${args.sourceName}" via search \u2014 is it available for this account?`);

  const items = await client.getAllPages<PlaylistItemObject>(`/playlists/${encodeURIComponent(sourceId)}/items`, { limit: '100' });
  const uris = items.map((r) => r?.item?.uri).filter((u): u is string => typeof u === 'string');
  if (uris.length === 0) {
    return shapeResult(rf, `"${args.sourceName}" is empty \u2014 nothing to archive.`, { ok: true, source: args.sourceName, source_id: sourceId, archived: 0, uris: [] });
  }

  if (args.dry_run) {
    const payload = { ok: true, dry_run: true, source: args.sourceName, source_id: sourceId, archive: args.archiveName, would_archive: uris.length, uris };
    return shapeResult(rf, describeDryRun(`save ${args.sourceName}`, args.archiveName, [`Would archive ${uris.length} track(s) from "${args.sourceName}" into "${args.archiveName}"`, ...uris.slice(0, 5)]) + (uris.length > 5 ? `\n  \u2026and ${uris.length - 5} more` : ''), payload);
  }

  let archiveId = await findArchivePlaylist(client, args.archiveName);
  if (!archiveId) {
    const created = await client.post<{ id: string; uri: string }>(
      '/me/playlists',
      { name: args.archiveName, public: false, description: `Archive of ${args.sourceName} \u2014 auto-created` },
    );
    if (!created?.id) throw new Error(`Could not create archive playlist "${args.archiveName}"`);
    archiveId = created.id;
  } else {
    const existing = await client.getAllPages<PlaylistItemObject>(`/playlists/${encodeURIComponent(archiveId)}/items`, { limit: '100' });
    const existingUris = existing.map((r) => r?.item?.uri).filter((u): u is string => typeof u === 'string');
    const same = existingUris.length === uris.length && existingUris.every((u, i) => u === uris[i]);
    if (same) {
      return shapeResult(rf, `Archive "${args.archiveName}" already up to date (${uris.length} items) \u2014 nothing to do.`, { ok: true, source: args.sourceName, archive_id: archiveId, archived: 0, idempotent: true, uris });
    }
  }

  let snapshotId: string | undefined;
  for (let start = 0; start < uris.length; start += 100) {
    const chunk = uris.slice(start, start + 100);
    const res =
      start === 0
        ? await client.put<{ snapshot_id?: string }>(`/playlists/${encodeURIComponent(archiveId)}/items`, { uris: chunk })
        : await client.post<{ snapshot_id?: string }>(`/playlists/${encodeURIComponent(archiveId)}/items`, { uris: chunk });
    if (res?.snapshot_id) snapshotId = res.snapshot_id;
  }

  const receipt = await issueReceipt(client, { kind: 'playlist_items', id: archiveId, uris });
  const prose = `Archived ${uris.length} track(s) from "${args.sourceName}" \u2192 "${args.archiveName}" (ID: ${archiveId})\n${batchSummary(uris.length, uris)}\n${formatReceipt(receipt)}` + (snapshotId ? `\nSnapshot ID: ${snapshotId}` : '');
  return shapeResult(rf, prose, { ok: true, source: args.sourceName, source_id: sourceId, archive_id: archiveId, archived: uris.length, uris, snapshot_id: snapshotId, receipt: receipt as unknown as Record<string, unknown> });
}

export function registerPortabilityTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'save_discover_weekly',
    'Archive your Discover Weekly into a regular playlist (creates or overwrites the archive). Resolves Discover Weekly by name via search; dry_run previews; idempotent if archive already matches.',
    {
      archive_name: z.string().optional().default('Discover Weekly Archive').describe('Archive playlist name (created if missing, overwritten if present)'),
      dry_run: DryRun,
      response_format: ResponseFormat,
    },
    async (args) => savePersonalized(client, { sourceName: 'Discover Weekly', archiveName: args.archive_name, dry_run: args.dry_run, response_format: args.response_format }),
  );

  server.tool(
    'save_release_radar',
    'Archive your Release Radar into a regular playlist (creates or overwrites the archive). Resolves Release Radar by name via search; dry_run previews; idempotent if archive already matches.',
    {
      archive_name: z.string().optional().default('Release Radar Archive').describe('Archive playlist name (created if missing, overwritten if present)'),
      dry_run: DryRun,
      response_format: ResponseFormat,
    },
    async (args) => savePersonalized(client, { sourceName: 'Release Radar', archiveName: args.archive_name, dry_run: args.dry_run, response_format: args.response_format }),
  );

  server.tool(
    'export_library_json',
    'Export your full library (saved tracks, albums, shows, episodes, audiobooks) to a local directory as JSON or CSV sidecar files.',
    {
      output_dir: z.string().optional().describe('Local directory to write files into (default: ~/.spotify-mcp/portability)'),
      format: z.enum(['json', 'csv']).optional().default('json').describe('Output format: json (single file) or csv (one file per type)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const dir = args.output_dir ?? portabilityDir();
      const cap = getConfig().fetchAllCap;

      const [tracks, albums, shows, episodes] = await Promise.all([
        client.getAllPages<SavedTrackItem>('/me/tracks', { limit: '50' }, { maxItems: cap }),
        client.getAllPages<SavedAlbumItem>('/me/albums', { limit: '50' }, { maxItems: cap }),
        client.getAllPages<SavedShowItem>('/me/shows', { limit: '50' }, { maxItems: cap }),
        client.getAllPages<SavedEpisodeItem>('/me/episodes', { limit: '50' }, { maxItems: cap }),
      ]);
      let audiobooks: Array<{ added_at: string; audiobook: { uri: string; name: string } }> = [];
      try {
        audiobooks = await client.getAllPages<{ added_at: string; audiobook: { uri: string; name: string } }>('/me/audiobooks', { limit: '50' }, { maxItems: cap });
      } catch {
        audiobooks = [];
      }

      await mkdir(dir, { recursive: true, mode: 0o700 });

      if (args.format === 'csv') {
        const writeCsv = async (name: string, rows: string[][], headers: string[]) => {
          const lines = [headers.map(csvField).join(','), ...rows.map((r) => r.map(csvField).join(','))].join('\n') + '\n';
          const p = join(dir, `${name}.csv`);
          await writeFile(p, lines, { mode: 0o600 });
          return { path: p, rows: rows.length };
        };
        const results = await Promise.all([
          writeCsv('tracks', tracks.map((r) => [r.track.uri, r.track.name, r.track.artists.map((a) => a.name).join(';'), r.added_at]), ['uri', 'name', 'artists', 'added_at']),
          writeCsv('albums', albums.map((r) => [r.album.uri, r.album.name, r.added_at]), ['uri', 'name', 'added_at']),
          writeCsv('shows', shows.map((r) => [r.show.uri, r.show.name, r.added_at]), ['uri', 'name', 'added_at']),
          writeCsv('episodes', episodes.map((r) => [r.episode.uri, r.episode.name, r.added_at]), ['uri', 'name', 'added_at']),
          writeCsv('audiobooks', audiobooks.map((r) => [r.audiobook.uri, r.audiobook.name, r.added_at]), ['uri', 'name', 'added_at']),
        ]);
        const total = tracks.length + albums.length + shows.length + episodes.length + audiobooks.length;
        const payload = { ok: true, dir, format: 'csv', total, counts: { tracks: tracks.length, albums: albums.length, shows: shows.length, episodes: episodes.length, audiobooks: audiobooks.length }, files: results.map((r) => r.path) };
        return shapeResult(rf, `Exported library to ${dir} as CSV (${total} items across ${results.length} files).`, payload);
      }

      const doc = {
        exported_at: new Date().toISOString(),
        counts: { tracks: tracks.length, albums: albums.length, shows: shows.length, episodes: episodes.length, audiobooks: audiobooks.length },
        tracks: tracks.map((r) => ({ uri: r.track.uri, name: r.track.name, artists: r.track.artists.map((a) => a.name), added_at: r.added_at })),
        albums: albums.map((r) => ({ uri: r.album.uri, name: r.album.name, added_at: r.added_at })),
        shows: shows.map((r) => ({ uri: r.show.uri, name: r.show.name, added_at: r.added_at })),
        episodes: episodes.map((r) => ({ uri: r.episode.uri, name: r.episode.name, added_at: r.added_at })),
        audiobooks: audiobooks.map((r) => ({ uri: r.audiobook.uri, name: r.audiobook.name, added_at: r.added_at })),
      };
      const filePath = join(dir, 'library.json');
      const body = `${JSON.stringify(doc, null, 2)}\n`;
      await writeFile(filePath, body, { mode: 0o600 });
      const bytes = Buffer.byteLength(body);
      const payload = { ok: true, dir, file: filePath, format: 'json', bytes, counts: doc.counts, total: tracks.length + albums.length + shows.length + episodes.length + audiobooks.length };
      return shapeResult(rf, `Exported library to ${filePath} (${payload.total} items, ${bytes} bytes).`, payload);
    },
  );

  server.tool(
    'export_followed_artists',
    'Export your followed artists (artists, genres, followed_at) to a local directory as JSON or CSV.',
    {
      output_dir: z.string().optional().describe('Local directory to write files into (default: ~/.spotify-mcp/portability)'),
      format: z.enum(['json', 'csv']).optional().default('json').describe('Output format: json or csv'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const dir = args.output_dir ?? portabilityDir();
      const cap = getConfig().fetchAllCap;

      const artists: Array<{ uri: string; name: string; genres: string[] }> = [];
      let after: string | undefined;
      while (artists.length < cap) {
        const params: Record<string, string> = { type: 'artist', limit: '50' };
        if (after) params.after = after;
        const page = await client.get<FollowedArtistsResponse>('/me/following', params);
        const items = page?.artists?.items ?? [];
        if (items.length === 0) break;
        for (const a of items) artists.push({ uri: a.uri, name: a.name, genres: a.genres ?? [] });
        after = page?.artists?.cursors?.after ?? undefined;
        if (!page?.artists?.next || !after) break;
      }
      if (artists.length > cap) artists.length = cap;

      await mkdir(dir, { recursive: true, mode: 0o700 });
      const exportedAt = new Date().toISOString();

      if (args.format === 'csv') {
        const headers = ['uri', 'name', 'genres', 'followed_at'];
        const rows = artists.map((a) => [a.uri, a.name, a.genres.join(';'), exportedAt]);
        const lines = [headers.map(csvField).join(','), ...rows.map((r) => r.map(csvField).join(','))].join('\n') + '\n';
        const filePath = join(dir, 'followed_artists.csv');
        await writeFile(filePath, lines, { mode: 0o600 });
        const payload = { ok: true, dir, file: filePath, format: 'csv', total: artists.length };
        return shapeResult(rf, `Exported ${artists.length} followed artist(s) to ${filePath} as CSV.`, payload);
      }

      const doc = { exported_at: exportedAt, total: artists.length, artists: artists.map((a) => ({ uri: a.uri, name: a.name, genres: a.genres, followed_at: exportedAt })) };
      const filePath = join(dir, 'followed_artists.json');
      const body = `${JSON.stringify(doc, null, 2)}\n`;
      await writeFile(filePath, body, { mode: 0o600 });
      const bytes = Buffer.byteLength(body);
      return shapeResult(rf, `Exported ${artists.length} followed artist(s) to ${filePath} (${bytes} bytes).`, { ok: true, dir, file: filePath, format: 'json', bytes, total: artists.length });
    },
  );
}
