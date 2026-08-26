/**
 * Portability (#188 + #192 + #238 + #240 + #223 + #220): save_discover_weekly / save_release_radar
 * (archive personalized playlists) + export_library_json / export_followed_artists
 * + export_profile_state/import_profile_state + export_listening_history
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
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
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
  RecentlyPlayedResponse,
  RecentlyPlayedItem,
} from '../types/spotify.js';
import { scenesFilePath, loadScenes } from './scenes.js';
import { genreTagsPath } from './libraryinsights.js';
import { playbackExtFile } from './playbackext.js';
import { searchHistoryFile } from './searchhistory.js';
import { historyFilePath } from '../history.js';

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

// ---------------------------------------------------------------------------
// #238: resolve personalized playlist via /me/playlists exact match first
// ---------------------------------------------------------------------------

type ResolvedPlaylist = {
  id: string;
  name: string;
  owner?: { id: string; display_name?: string | null } | null;
  uri?: string;
  source: 'me-playlists' | 'search';
  verified: boolean;
};

async function resolvePlaylistByName(
  client: SpotifyClient,
  name: string,
): Promise<ResolvedPlaylist | null> {
  const playlists = await client.getAllPages<SpotifyPlaylistSimple>('/me/playlists', { limit: '50' });
  const exactLocal = playlists.find((p) => p?.name?.toLowerCase() === name.toLowerCase());
  if (exactLocal) {
    return {
      id: exactLocal.id,
      name: exactLocal.name,
      owner: exactLocal.owner as ResolvedPlaylist['owner'],
      uri: exactLocal.uri,
      source: 'me-playlists',
      verified: true,
    };
  }
  try {
    const res = await client.get<{
      playlists?: { items: Array<{ id: string; name: string; owner?: { id: string; display_name?: string | null }; uri?: string } | null> };
    }>('/search', { q: name, type: 'playlist', limit: '10' });
    const items = res?.playlists?.items ?? [];
    const exact = items.find((p) => p?.name?.toLowerCase() === name.toLowerCase());
    if (exact) {
      return {
        id: exact.id,
        name: exact.name,
        owner: (exact.owner as ResolvedPlaylist['owner']) ?? null,
        uri: exact.uri,
        source: 'search',
        verified: false,
      };
    }
  } catch {
    // search failure -> treat as not found
  }
  return null;
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
  const resolved = await resolvePlaylistByName(client, args.sourceName);
  if (!resolved) {
    const payload = {
      ok: false as const,
      error: 'source_not_found' as const,
      source: args.sourceName,
      hint: `Could not find "${args.sourceName}" in your library (/me/playlists) or via search. If the playlist exists, pass its ID directly or ensure it is in your library.`,
    };
    const prose = `Could not find "${args.sourceName}" — not in your library and no exact search match. If you know the playlist ID, use it directly.`;
    return shapeResult(rf, prose, payload as unknown as Record<string, unknown>);
  }
  const sourceId = resolved.id;
  const sourceIdentity = {
    source: args.sourceName,
    source_id: sourceId,
    source_name: resolved.name,
    source_owner: resolved.owner ?? null,
    source_uri: resolved.uri ?? `spotify:playlist:${sourceId}`,
    source_url: `https://open.spotify.com/playlist/${sourceId}`,
    source_verified: resolved.verified,
    source_resolution: resolved.source as string,
    ...(resolved.verified ? {} : { warning: 'best-effort/unverified — resolved via public search, not your library; verify the owner before archiving' }),
  };

  const items = await client.getAllPages<PlaylistItemObject>(`/playlists/${encodeURIComponent(sourceId)}/items`, { limit: '100' });
  const uris = items.map((r) => r?.item?.uri).filter((u): u is string => typeof u === 'string');
  if (uris.length === 0) {
    return shapeResult(rf, `"${args.sourceName}" is empty \u2014 nothing to archive.`, { ok: true, ...sourceIdentity, archived: 0, uris: [] });
  }

  if (args.dry_run) {
    const payload = { ok: true, dry_run: true, ...sourceIdentity, archive: args.archiveName, would_archive: uris.length, uris };
    const preview = describeDryRun(`save ${args.sourceName}`, args.archiveName, [`Would archive ${uris.length} track(s) from "${args.sourceName}" into "${args.archiveName}"`, ...uris.slice(0, 5)]) + (uris.length > 5 ? `\n  …and ${uris.length - 5} more` : '');
    const unverifiedNote = resolved.verified ? '' : `\n[unverified source — resolved via search as ${resolved.name} by ${resolved.owner?.id ?? 'unknown owner'}; verify before archiving]`;
    return shapeResult(rf, preview + unverifiedNote, payload);
  }

  let archiveId = await findArchivePlaylist(client, args.archiveName);
  if (!archiveId) {
    const created = await client.post<{ id: string; uri: string }>(
      '/me/playlists',
      { name: args.archiveName, public: false, description: `Archive of ${args.sourceName} — auto-created` },
    );
    if (!created?.id) throw new Error(`Could not create archive playlist "${args.archiveName}"`);
    archiveId = created.id;
  } else {
    const existing = await client.getAllPages<PlaylistItemObject>(`/playlists/${encodeURIComponent(archiveId)}/items`, { limit: '100' });
    const existingUris = existing.map((r) => r?.item?.uri).filter((u): u is string => typeof u === 'string');
    const same = existingUris.length === uris.length && existingUris.every((u, i) => u === uris[i]);
    if (same) {
      return shapeResult(rf, `Archive "${args.archiveName}" already up to date (${uris.length} items) — nothing to do.`, { ok: true, ...sourceIdentity, archive_id: archiveId, archived: 0, idempotent: true, uris });
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
  const unverifiedLine = resolved.verified ? '' : `\n[unverified source — resolved via search; owner: ${resolved.owner?.id ?? 'unknown'}]`;
  const prose = `Archived ${uris.length} track(s) from "${args.sourceName}" → "${args.archiveName}" (ID: ${archiveId})\nSource: ${resolved.name} (${sourceIdentity.source_url}) owner ${resolved.owner?.id ?? 'unknown'} [${resolved.source}]${unverifiedLine}\n${batchSummary(uris.length, uris)}\n${formatReceipt(receipt)}` + (snapshotId ? `\nSnapshot ID: ${snapshotId}` : '');
  return shapeResult(rf, prose, { ok: true, ...sourceIdentity, archive_id: archiveId, archived: uris.length, uris, snapshot_id: snapshotId, receipt: receipt as unknown as Record<string, unknown> });
}

// ---------------------------------------------------------------------------
// #223 helpers: profile state stores
// ---------------------------------------------------------------------------

function watchlistFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const cfg = env.SPOTIFY_MCP_DATA_DIR;
  if (cfg) return join(cfg, 'artist-watchlist.json');
  return join('./data', 'artist-watchlist.json');
}

const PROFILE_STATE_SCHEMA_VERSION = 1;

async function tryReadJson(path: string): Promise<unknown | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function tryReadText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// #220 helpers: listening history
// ---------------------------------------------------------------------------

function listeningHistoryDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SPOTIFY_MCP_PORTABILITY_DIR ?? join(homedir(), '.spotify-mcp', 'portability');
}

export function registerPortabilityTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'save_discover_weekly',
    'Archive your Discover Weekly into a regular playlist (creates or overwrites the archive). Resolves Discover Weekly via /me/playlists exact match first, falling back to search (unverified); dry_run previews; idempotent if archive already matches. Result echoes source identity (owner, url, verified).',
    {
      archive_name: z.string().optional().default('Discover Weekly Archive').describe('Archive playlist name (created if missing, overwritten if present)'),
      dry_run: DryRun,
      response_format: ResponseFormat,
    },
    async (args) => savePersonalized(client, { sourceName: 'Discover Weekly', archiveName: args.archive_name, dry_run: args.dry_run, response_format: args.response_format }),
  );

  server.tool(
    'save_release_radar',
    'Archive your Release Radar into a regular playlist (creates or overwrites the archive). Resolves Release Radar via /me/playlists exact match first, falling back to search (unverified); dry_run previews; idempotent if archive already matches. Result echoes source identity (owner, url, verified).',
    {
      archive_name: z.string().optional().default('Release Radar Archive').describe('Archive playlist name (created if missing, overwritten if present)'),
      dry_run: DryRun,
      response_format: ResponseFormat,
    },
    async (args) => savePersonalized(client, { sourceName: 'Release Radar', archiveName: args.archive_name, dry_run: args.dry_run, response_format: args.response_format }),
  );

  server.tool(
    'export_library_json',
    'Export your full library (saved tracks, albums, shows, episodes, audiobooks) to a local directory as JSON or CSV sidecar files. Respects SPOTIFY_MCP_FETCH_ALL_CAP per type; when capped, reports cap_reached + truncated and a prose footer ("first N of … — raise SPOTIFY_MCP_FETCH_ALL_CAP").',
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
      const capReached = {
        tracks: tracks.length >= cap,
        albums: albums.length >= cap,
        shows: shows.length >= cap,
        episodes: episodes.length >= cap,
        audiobooks: audiobooks.length >= cap,
      };
      const truncated = Object.values(capReached).some(Boolean);

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
        const cappedTypes = Object.entries(capReached).filter(([, v]) => v).map(([k]) => k).join(', ');
        const footer = truncated ? ` [truncated — first ${cap} per type; capped types: ${cappedTypes} — raise SPOTIFY_MCP_FETCH_ALL_CAP for the full library]` : '';
        const payload = { ok: true, dir, format: 'csv', total, counts: { tracks: tracks.length, albums: albums.length, shows: shows.length, episodes: episodes.length, audiobooks: audiobooks.length }, cap_reached: capReached, truncated, cap, files: results.map((r) => r.path) };
        return shapeResult(rf, `Exported library to ${dir} as CSV (${total} items across ${results.length} files).${footer}`, payload);
      }

      const doc = {
        exported_at: new Date().toISOString(),
        counts: { tracks: tracks.length, albums: albums.length, shows: shows.length, episodes: episodes.length, audiobooks: audiobooks.length },
        cap_reached: capReached,
        truncated,
        cap,
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
      const cappedTypes = Object.entries(capReached).filter(([, v]) => v).map(([k]) => k).join(', ');
      const footer = truncated ? ` [truncated — first ${cap} per type; capped types: ${cappedTypes} — raise SPOTIFY_MCP_FETCH_ALL_CAP for the full library]` : '';
      const payload = { ok: true, dir, file: filePath, format: 'json', bytes, counts: doc.counts, cap_reached: capReached, truncated, cap, total: tracks.length + albums.length + shows.length + episodes.length + audiobooks.length };
      return shapeResult(rf, `Exported library to ${filePath} (${payload.total} items, ${bytes} bytes).${footer}`, payload);
    },
  );

  server.tool(
    'export_followed_artists',
    'Export your followed artists to a local directory as JSON or CSV. Fields: uri, name, genres. The file\'s exported_at is the export time, not a per-artist follow date (Spotify does not expose followed_at).',
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
      const capReached = artists.length >= cap;
      const truncated = capReached;

      if (args.format === 'csv') {
        const headers = ['uri', 'name', 'genres'];
        const rows = artists.map((a) => [a.uri, a.name, a.genres.join(';')]);
        const lines = [headers.map(csvField).join(','), ...rows.map((r) => r.map(csvField).join(','))].join('\n') + '\n';
        const filePath = join(dir, 'followed_artists.csv');
        await writeFile(filePath, lines, { mode: 0o600 });
        const footer = truncated ? ` [truncated — first ${cap}; raise SPOTIFY_MCP_FETCH_ALL_CAP for the full list]` : '';
        const payload = { ok: true, dir, file: filePath, format: 'csv', total: artists.length, cap_reached: capReached, truncated, cap, exported_at: exportedAt };
        return shapeResult(rf, `Exported ${artists.length} followed artist(s) to ${filePath} as CSV.${footer}`, payload);
      }

      const doc = { exported_at: exportedAt, total: artists.length, cap_reached: capReached, truncated, cap, artists: artists.map((a) => ({ uri: a.uri, name: a.name, genres: a.genres })) };
      const filePath = join(dir, 'followed_artists.json');
      const body = `${JSON.stringify(doc, null, 2)}\n`;
      await writeFile(filePath, body, { mode: 0o600 });
      const bytes = Buffer.byteLength(body);
      const footer = truncated ? ` [truncated — first ${cap}; raise SPOTIFY_MCP_FETCH_ALL_CAP for the full list]` : '';
      return shapeResult(rf, `Exported ${artists.length} followed artist(s) to ${filePath} (${bytes} bytes).${footer}`, { ok: true, dir, file: filePath, format: 'json', bytes, total: artists.length, cap_reached: capReached, truncated, cap, exported_at: exportedAt });
    },
  );

  // -------------------------------------------------------------------------
  // #223: export_profile_state / import_profile_state
  // -------------------------------------------------------------------------

  server.tool(
    'export_profile_state',
    'Export local sidecar stores (scenes, genre-tags, playback-ext, search-history, mutations, artist-watchlist) to a single schema-versioned JSON archive. Note: artist-watchlist defaults to ./data/artist-watchlist.json (cwd-relative, not ~/.spotify-mcp/) — a quirk flagged for future alignment.',
    {
      output_dir: z.string().optional().describe('Directory to write the archive into (default: ~/.spotify-mcp/exports)'),
      include_history: z.boolean().optional().default(false).describe('Include mutation history JSONL (can be large)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const dir = args.output_dir ?? join(homedir(), '.spotify-mcp', 'exports');
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const filePath = join(dir, `profile-state-${ts}.json`);

      const stores: Record<string, unknown> = {};
      const counts: Record<string, number> = {};

      // scenes
      const scenes = await tryReadJson(scenesFilePath());
      if (scenes && typeof scenes === 'object') {
        stores.scenes = scenes;
        counts.scenes = Object.keys(scenes as Record<string, unknown>).length;
      } else {
        stores.scenes = null;
        counts.scenes = 0;
      }

      // genre-tags
      const genreTags = await tryReadJson(genreTagsPath());
      if (genreTags && typeof genreTags === 'object' && (genreTags as Record<string, unknown>).tags) {
        stores.genre_tags = genreTags;
        const tags = (genreTags as { tags: Record<string, unknown> }).tags;
        counts.genre_tags = Object.keys(tags).length;
      } else if (genreTags) {
        stores.genre_tags = genreTags;
        counts.genre_tags = 0;
      } else {
        stores.genre_tags = null;
        counts.genre_tags = 0;
      }

      // playback-ext
      const playbackExt = await tryReadJson(playbackExtFile());
      if (playbackExt && typeof playbackExt === 'object') {
        stores.playback_ext = playbackExt;
        const pe = playbackExt as Record<string, unknown>;
        counts.playback_ext_states = pe.states ? Object.keys(pe.states as Record<string, unknown>).length : 0;
        counts.playback_ext_sessions = pe.sessions ? Object.keys(pe.sessions as Record<string, unknown>).length : 0;
      } else {
        stores.playback_ext = null;
        counts.playback_ext_states = 0;
        counts.playback_ext_sessions = 0;
      }

      // search-history
      const searchHistory = await tryReadJson(searchHistoryFile());
      if (Array.isArray(searchHistory)) {
        stores.search_history = searchHistory;
        counts.search_history = searchHistory.length;
      } else if (searchHistory && typeof searchHistory === 'object' && Array.isArray((searchHistory as Record<string, unknown>).entries)) {
        const entries = (searchHistory as { entries: unknown[] }).entries;
        stores.search_history = entries;
        counts.search_history = entries.length;
      } else {
        stores.search_history = searchHistory ?? null;
        counts.search_history = 0;
      }

      // artist-watchlist (cwd-relative default quirk!)
      const watchlist = await tryReadJson(watchlistFilePath());
      if (watchlist && typeof watchlist === 'object') {
        stores.artist_watchlist = watchlist;
        const wl = watchlist as { watchlists?: Record<string, unknown> };
        counts.artist_watchlist = wl.watchlists ? Object.keys(wl.watchlists).length : 0;
      } else {
        stores.artist_watchlist = null;
        counts.artist_watchlist = 0;
      }

      // mutations history (optional)
      if (args.include_history) {
        const histRaw = await tryReadText(historyFilePath());
        if (histRaw) {
          const lines = histRaw.split('\n').filter(Boolean);
          stores.mutations_history = lines.map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
          counts.mutations_history = lines.length;
        } else {
          stores.mutations_history = null;
          counts.mutations_history = 0;
        }
      }

      const doc = {
        schema_version: PROFILE_STATE_SCHEMA_VERSION,
        exported_at: new Date().toISOString(),
        include_history: !!args.include_history,
        watchlist_path_note: 'artist-watchlist defaults to ./data/artist-watchlist.json (cwd-relative) unless SPOTIFY_MCP_DATA_DIR is set — this is a known quirk',
        counts,
        stores,
      };

      const body = `${JSON.stringify(doc, null, 2)}\n`;
      await writeFile(filePath, body, { mode: 0o600 });
      const bytes = Buffer.byteLength(body);
      const payload = { ok: true, path: filePath, bytes, counts, schema_version: PROFILE_STATE_SCHEMA_VERSION };
      return shapeResult(rf, `Exported profile state to ${filePath} (${bytes} bytes) — ${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(', ')}.`, payload);
    },
  );

  server.tool(
    'import_profile_state',
    'Restore local sidecar stores from a profile-state archive. Merge adds to existing stores; overwrite replaces them. Refuses archives newer than this server\'s schema version.',
    {
      input_path: z.string().describe('Path to the profile-state archive JSON file'),
      mode: z.enum(['merge', 'overwrite']).optional().default('merge').describe('merge = add to existing stores; overwrite = replace them'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      let doc: Record<string, unknown>;
      try {
        const raw = await readFile(args.input_path, 'utf8');
        doc = JSON.parse(raw) as Record<string, unknown>;
      } catch (e) {
        throw new Error(`Could not read archive "${args.input_path}": ${e instanceof Error ? e.message : String(e)}`);
      }
      const schemaVersion = doc.schema_version as number | undefined;
      if (typeof schemaVersion === 'number' && schemaVersion > PROFILE_STATE_SCHEMA_VERSION) {
        throw new Error(`Archive schema version ${schemaVersion} is newer than this server's ${PROFILE_STATE_SCHEMA_VERSION} — please update the server before importing.`);
      }
      const stores = doc.stores as Record<string, unknown> | undefined;
      if (!stores || typeof stores !== 'object') {
        throw new Error('Archive missing stores object');
      }

      const allowedKeys = new Set(['scenes', 'genre_tags', 'playback_ext', 'search_history', 'artist_watchlist', 'mutations_history']);
      const results: Record<string, string> = {};

      const writeStore = async (filePath: string, data: unknown) => {
        await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
        await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      };

      const mergeOrOverwrite = async (
        label: string,
        filePath: string,
        incoming: unknown,
        isRecord: boolean,
      ): Promise<void> => {
        if (incoming == null) return;
        if (args.mode === 'overwrite') {
          await writeStore(filePath, incoming);
          results[label] = 'overwritten';
          return;
        }
        // merge
        const existing = await tryReadJson(filePath);
        if (isRecord && existing && typeof existing === 'object' && incoming && typeof incoming === 'object') {
          // For record stores, merge keys (incoming wins on conflict)
          const merged = { ...(existing as Record<string, unknown>), ...(incoming as Record<string, unknown>) };
          // Special handling for nested record shapes
          // genre_tags: { version, tags: {...} } -> merge tags
          if (label === 'genre_tags') {
            const eTags = (existing as { tags?: Record<string, unknown> }).tags ?? {};
            const iTags = (incoming as { tags?: Record<string, unknown> }).tags ?? {};
            (merged as Record<string, unknown>).tags = { ...(eTags as Record<string, unknown>), ...(iTags as Record<string, unknown>) };
          }
          // playback_ext: { states, devicePresets, sessions, ... } -> merge each sub-record
          if (label === 'playback_ext') {
            for (const sub of ['states', 'devicePresets', 'sessions', 'smartRules']) {
              const eSub = (existing as Record<string, unknown>)[sub];
              const iSub = (incoming as Record<string, unknown>)[sub];
              if (eSub && typeof eSub === 'object' && iSub && typeof iSub === 'object') {
                (merged as Record<string, unknown>)[sub] = { ...(eSub as Record<string, unknown>), ...(iSub as Record<string, unknown>) };
              }
            }
          }
          // artist_watchlist: { watchlists: {...} } -> merge watchlists
          if (label === 'artist_watchlist') {
            const eWl = (existing as { watchlists?: Record<string, unknown> }).watchlists ?? {};
            const iWl = (incoming as { watchlists?: Record<string, unknown> }).watchlists ?? {};
            (merged as Record<string, unknown>).watchlists = { ...(eWl as Record<string, unknown>), ...(iWl as Record<string, unknown>) };
          }
          await writeStore(filePath, merged);
          results[label] = 'merged';
        } else if (Array.isArray(existing) && Array.isArray(incoming)) {
          // search_history: array — concat
          const merged = [...existing, ...incoming];
          await writeStore(filePath, merged);
          results[label] = 'merged';
        } else if (existing == null) {
          await writeStore(filePath, incoming);
          results[label] = 'created';
        } else {
          // Fallback: overwrite if shapes don't match merge expectations
          await writeStore(filePath, incoming);
          results[label] = 'overwritten';
        }
      };

      for (const [key, value] of Object.entries(stores)) {
        if (!allowedKeys.has(key)) continue; // ignore unknown keys
        if (value == null) continue;
        switch (key) {
          case 'scenes':
            await mergeOrOverwrite('scenes', scenesFilePath(), value, true);
            break;
          case 'genre_tags':
            await mergeOrOverwrite('genre_tags', genreTagsPath(), value, true);
            break;
          case 'playback_ext':
            await mergeOrOverwrite('playback_ext', playbackExtFile(), value, true);
            break;
          case 'search_history':
            await mergeOrOverwrite('search_history', searchHistoryFile(), value, false);
            break;
          case 'artist_watchlist':
            await mergeOrOverwrite('artist_watchlist', watchlistFilePath(), value, true);
            break;
          case 'mutations_history': {
            if (Array.isArray(value)) {
              const histPath = historyFilePath();
              await mkdir(dirname(histPath), { recursive: true, mode: 0o700 });
              if (args.mode === 'overwrite') {
                const lines = (value as unknown[]).map((r) => JSON.stringify(r)).join('\n') + '\n';
                await writeFile(histPath, lines, { encoding: 'utf8', mode: 0o600 });
                results.mutations_history = 'overwritten';
              } else {
                const lines = (value as unknown[]).map((r) => JSON.stringify(r)).join('\n') + '\n';
                const { appendFile } = await import('node:fs/promises');
                try {
                  await appendFile(histPath, lines, { encoding: 'utf8', mode: 0o600 } as unknown as Record<string, unknown>);
                } catch {
                  await writeFile(histPath, lines, { encoding: 'utf8', mode: 0o600 });
                }
                results.mutations_history = 'merged';
              }
            }
            break;
          }
        }
      }

      const payload = { ok: true, mode: args.mode, input_path: args.input_path, results };
      return shapeResult(rf, `Imported profile state from ${args.input_path} (mode: ${args.mode}) — ${Object.entries(results).map(([k, v]) => `${k}:${v}`).join(', ') || 'nothing to import'}.`, payload);
    },
  );

  // -------------------------------------------------------------------------
  // #220: export_listening_history
  // -------------------------------------------------------------------------

  server.tool(
    'export_listening_history',
    'Export your listening history (recently played) to a JSON or CSV sidecar by walking /me/player/recently-played with before-cursor pagination. Respects SPOTIFY_MCP_FETCH_ALL_CAP; writes file 0600 and reports path + counts. Analogous to export_library_json.',
    {
      output_dir: z.string().optional().describe('Local directory to write files into (default: ~/.spotify-mcp/portability)'),
      format: z.enum(['json', 'csv']).optional().default('json').describe('Output format: json or csv'),
      limit: z.number().int().min(1).max(10000).optional().describe('Alias for max_items'),
      max_items: z.number().int().min(1).max(10000).optional().describe('Max history items to export (default: SPOTIFY_MCP_FETCH_ALL_CAP)'),
      before: z.string().optional().describe('Cursor: only return items played before this timestamp (milliseconds since epoch or ISO string)'),
      after: z.string().optional().describe('Cursor: only return items played after this timestamp (milliseconds since epoch or ISO string)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const dir = args.output_dir ?? listeningHistoryDir();
      const cap = args.max_items ?? args.limit ?? getConfig().fetchAllCap;

      const items: RecentlyPlayedItem[] = [];
      let before: string | undefined = args.before;
      // after cursor is not natively supported for pagination but we filter
      const afterMs = args.after ? new Date(args.after).getTime() : undefined;
      const beforeMsInitial = args.before ? new Date(args.before).getTime() : undefined;

      while (items.length < cap) {
        const params: Record<string, string> = { limit: '50' };
        if (before) params.before = before;
        // Spotify's recently-played cursor is milliseconds since epoch
        // If before was an ISO string, convert to ms string
        if (before && Number.isNaN(Number(before))) {
          const ms = new Date(before).getTime();
          if (Number.isFinite(ms)) params.before = String(ms);
        }
        const page = await client.get<RecentlyPlayedResponse>('/me/player/recently-played', params);
        const pageItems = page?.items ?? [];
        if (pageItems.length === 0) break;

        for (const item of pageItems) {
          if (afterMs !== undefined) {
            const playedMs = new Date(item.played_at).getTime();
            if (Number.isFinite(playedMs) && playedMs <= afterMs) continue;
          }
          items.push(item);
          if (items.length >= cap) break;
        }
        if (items.length >= cap) break;
        // Advance cursor: use the oldest item's played_at as next before
        const oldest = pageItems.at(-1);
        const nextBefore = page?.cursors?.before ?? (oldest ? String(new Date(oldest.played_at).getTime()) : undefined);
        if (!nextBefore || nextBefore === before) break;
        // Stop if we've gone past the after cursor (time-based)
        if (afterMs !== undefined && oldest) {
          const oldestMs = new Date(oldest.played_at).getTime();
          if (Number.isFinite(oldestMs) && oldestMs <= afterMs) break;
        }
        if (pageItems.length < 50) break;
        before = nextBefore;
      }
      if (items.length > cap) items.length = cap;

      await mkdir(dir, { recursive: true, mode: 0o700 });
      const exportedAt = new Date().toISOString();
      const capReached = items.length >= cap;
      const truncated = capReached;

      if (args.format === 'csv') {
        const headers = ['played_at', 'timestamp', 'track', 'artist', 'album', 'uri'];
        const rows = items.map((it) => [
          it.played_at,
          String(new Date(it.played_at).getTime()),
          it.track?.name ?? '',
          (it.track?.artists ?? []).map((a) => a.name).join(';'),
          it.track?.album?.name ?? '',
          it.track?.uri ?? '',
        ]);
        const lines = [headers.map(csvField).join(','), ...rows.map((r) => r.map(csvField).join(','))].join('\n') + '\n';
        const filePath = join(dir, 'listening_history.csv');
        await writeFile(filePath, lines, { mode: 0o600 });
        const footer = truncated ? ` [truncated — first ${cap}; raise SPOTIFY_MCP_FETCH_ALL_CAP or max_items for more]` : '';
        const payload = { ok: true, dir, file: filePath, format: 'csv', total: items.length, cap_reached: capReached, truncated, cap, exported_at: exportedAt };
        return shapeResult(rf, `Exported ${items.length} listening-history item(s) to ${filePath} as CSV.${footer}`, payload);
      }

      const doc = {
        exported_at: exportedAt,
        total: items.length,
        cap_reached: capReached,
        truncated,
        cap,
        items: items.map((it) => ({
          played_at: it.played_at,
          timestamp: new Date(it.played_at).getTime(),
          track: it.track?.name ?? '',
          artist: (it.track?.artists ?? []).map((a) => a.name).join(', '),
          album: it.track?.album?.name ?? '',
          uri: it.track?.uri ?? '',
          context: it.context ?? null,
        })),
      };
      const filePath = join(dir, 'listening_history.json');
      const body = `${JSON.stringify(doc, null, 2)}\n`;
      await writeFile(filePath, body, { mode: 0o600 });
      const bytes = Buffer.byteLength(body);
      const footer = truncated ? ` [truncated — first ${cap}; raise SPOTIFY_MCP_FETCH_ALL_CAP or max_items for more]` : '';
      return shapeResult(rf, `Exported ${items.length} listening-history item(s) to ${filePath} (${bytes} bytes).${footer}`, { ok: true, dir, file: filePath, format: 'json', bytes, total: items.length, cap_reached: capReached, truncated, cap, exported_at: exportedAt });
    },
  );
}
