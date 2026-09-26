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
  CHUNK_CAPS,
} from '../shaping.js';
import type { ResponseFormatValue } from '../shaping.js';
import { issueReceipt, formatReceipt } from '../receipts.js';
import { confirmViaElicitation, describeConfirmation, requiredConfirmationRefusal } from './confirm.js';
// #637: the batch-add gate constant is shared, never re-declared here.
import { BATCH_ADD_ELICIT_THRESHOLD } from './playlistbatch.js';
import { getConfig } from '../config.js';
// mkdir/writeFile stay for import_profile_state, which writes to the server's
// own store paths (scenesFilePath(), historyFilePath()) rather than to a
// caller-supplied destination. chmod is here for the history-file mode
// enforcement in export_profile_state.
import { appendFile, chmod, copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { exportRootDir, resolveOutputPath, writeOutputFile } from '../paths.js';
import { csvTable } from '../csvsafe.js';
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
import { HISTORY_DIR_MODE, HISTORY_FILE_MODE, historyFilePath, readHistory } from '../history.js';

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

/** #752: a record store value — arrays and nulls are not records. */
const isPlainRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * #752: sub-maps whose OWN keys are the entry identity. Spreading only the
 * top level would let the incoming sub-map replace the existing one and drop
 * every pre-existing entry inside it.
 */
const NESTED_SUBMAPS: Record<string, readonly string[]> = {
  genre_tags: ['tags'],
  playback_ext: ['states', 'devicePresets', 'sessions', 'smartRules'],
  artist_watchlist: ['watchlists'],
};

/**
 * #752: scenes.json is a bare `Record<sceneName, Scene>` (scenes.ts), but an
 * archive may carry the enveloped `{version, scenes:{…}}` form. Either way
 * the scene map is the store's key space, so it is merged on scene names
 * rather than replaced wholesale.
 */
function sceneMapOf(store: Record<string, unknown>): Record<string, unknown> {
  return isPlainRecord(store.scenes) ? store.scenes : store;
}

/** #752: the 90-day window searchhistory.ts already enforces on read and write. */
const SEARCH_HISTORY_TTL_MS = 90 * 86_400_000;

/** #752: an entry's identity — its `id`, else its own serialisation. */
function searchEntryKey(entry: unknown): string {
  if (isPlainRecord(entry) && typeof entry.id === 'string' && entry.id.length > 0) return `id:${entry.id}`;
  return `raw:${JSON.stringify(entry ?? null)}`;
}

/** What a merge did, per store, so a dry run can report it without writing. */
interface MergeOutcome {
  data: unknown;
  /** Entries already in the local store. */
  existing_keys: number;
  added: number;
  conflicts: number;
  dropped_duplicates: number;
  dropped_expired: number;
  /** Entries whose timestamp could not be read: kept, never guessed at. */
  unreadable_timestamps: number;
}

const NO_DROPPED = { dropped_duplicates: 0, dropped_expired: 0, unreadable_timestamps: 0 };

/** Entries the incoming store adds vs. keys it overrides on the existing one. */
function keyCounts(existing: Record<string, unknown>, merged: Record<string, unknown>): { added: number; conflicts: number } {
  const existingKeys = new Set(Object.keys(existing));
  let added = 0;
  let conflicts = 0;
  for (const key of Object.keys(merged)) (existingKeys.has(key) ? conflicts++ : added++);
  return { added, conflicts };
}

/** #752: union a record store on its own keys, incoming wins per key. */
function mergeRecordStore(label: string, existing: Record<string, unknown>, incoming: Record<string, unknown>): MergeOutcome {
  if (label === 'scenes') {
    const map = { ...sceneMapOf(existing), ...sceneMapOf(incoming) };
    return {
      // The envelope comes from the archive alone: spreading the existing
      // store's bare keys alongside it would leave phantom scenes at the top
      // level for loadScenes() to read.
      data: isPlainRecord(incoming.scenes) ? { ...incoming, scenes: map } : map,
      existing_keys: Object.keys(sceneMapOf(existing)).length,
      ...keyCounts(sceneMapOf(existing), map),
      ...NO_DROPPED,
    };
  }
  const merged: Record<string, unknown> = { ...existing, ...incoming };
  for (const sub of NESTED_SUBMAPS[label] ?? []) {
    const eSub = existing[sub];
    const iSub = incoming[sub];
    if (isPlainRecord(eSub) && isPlainRecord(iSub)) merged[sub] = { ...eSub, ...iSub };
  }
  return { data: merged, existing_keys: Object.keys(existing).length, ...keyCounts(existing, merged), ...NO_DROPPED };
}

/**
 * #752: de-duplicate search history on merge and hold it to the retention
 * window its own reader applies. A blind concat doubled the file on every
 * re-import and kept rows that every reader then filtered out.
 */
function mergeSearchHistory(existing: unknown[], incoming: unknown[]): MergeOutcome {
  const cutoff = Date.now() - SEARCH_HISTORY_TTL_MS;
  const seen = new Set<string>();
  const kept: unknown[] = [];
  let dropped_duplicates = 0;
  let dropped_expired = 0;
  let unreadable_timestamps = 0;
  for (const entry of [...existing, ...incoming]) {
    const key = searchEntryKey(entry);
    if (seen.has(key)) {
      dropped_duplicates++;
      continue;
    }
    seen.add(key);
    const at = new Date(isPlainRecord(entry) ? String(entry.timestamp ?? '') : '').getTime();
    if (!Number.isFinite(at)) {
      // Not a judgement about the entry — its age is simply unreadable, so it
      // is kept rather than dropped or aged on a guess.
      unreadable_timestamps++;
    } else if (at < cutoff) {
      dropped_expired++;
      continue;
    }
    kept.push(entry);
  }
  return {
    data: kept,
    existing_keys: existing.length,
    added: kept.length - existing.length,
    conflicts: 0,
    dropped_duplicates,
    dropped_expired,
    unreadable_timestamps,
  };
}

/** #752: overwrite is destructive, so the store it replaces is kept beside it. */
async function writeStoreBackup(filePath: string): Promise<string> {
  const backup = `${filePath}.bak`;
  await copyFile(filePath, backup);
  await chmod(backup, 0o600);
  return backup;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// #220 helpers: listening history
// ---------------------------------------------------------------------------

function listeningHistoryDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SPOTIFY_MCP_PORTABILITY_DIR ?? join(homedir(), '.spotify-mcp', 'portability');
}

// ---------------------------------------------------------------------------
// #637 + #736: additive restore of a library.json sidecar
// ---------------------------------------------------------------------------

/**
 * The five collections export_library_json writes into library.json (#736).
 * The importer restores every one of them; a key the file does not carry is
 * reported in `absent_keys` instead of being silently treated as "nothing to
 * do", so a partial sidecar can never read as a complete restore.
 */
const SIDECAR_COLLECTIONS = [
  { key: 'tracks', kind: 'track' },
  { key: 'albums', kind: 'album' },
  { key: 'shows', kind: 'show' },
  { key: 'episodes', kind: 'episode' },
  { key: 'audiobooks', kind: 'audiobook' },
] as const;

type SidecarKey = (typeof SIDECAR_COLLECTIONS)[number]['key'];

/**
 * A sidecar row is only usable when its `uri` is the canonical library URI
 * for that collection. Spotify ids are 22 base62 characters; a row with
 * anything else is a malformed sidecar, not a library item, and is counted as
 * invalid rather than being turned into an id by string splitting (#637).
 */
function sidecarUriRegex(kind: string): RegExp {
  return new RegExp(`^spotify:${kind}:[A-Za-z0-9]{22}$`);
}

/** Same query shape as library.ts's `libraryUrisParam` (kept in sync there). */
function libraryUrisParam(uris: readonly string[]): Record<string, string> {
  return { uris: uris.join(',') };
}

interface SidecarPlan {
  /** Collections the file actually carries, in export order. */
  readonly present: readonly SidecarKey[];
  /** Collections the file does not carry. */
  readonly absent: readonly SidecarKey[];
  /** Valid, de-duplicated URIs to restore, each owned by one collection. */
  readonly candidates: readonly string[];
  /** Which collection each candidate came from (first occurrence wins). */
  readonly owner: ReadonlyMap<string, SidecarKey>;
  /** Per-collection { in_file, invalid, candidates }, for every one of the five keys. */
  readonly collections: Record<SidecarKey, { in_file: number; invalid: number; candidates: number }>;
  readonly invalid: number;
  readonly invalidSamples: readonly string[];
  readonly inFile: number;
}

function planSidecarRestore(doc: Record<string, unknown>): SidecarPlan {
  const present: SidecarKey[] = [];
  const absent: SidecarKey[] = [];
  const invalidByKey = {} as Record<SidecarKey, number>;
  const validByKey = {} as Record<SidecarKey, string[]>;
  const candidates: string[] = [];
  const owner = new Map<string, SidecarKey>();
  const invalidSamples: string[] = [];
  let invalid = 0;
  let inFile = 0;

  for (const { key, kind } of SIDECAR_COLLECTIONS) {
    const rows = doc[key];
    if (!Array.isArray(rows)) {
      absent.push(key);
      invalidByKey[key] = 0;
      validByKey[key] = [];
      continue;
    }
    present.push(key);
    inFile += rows.length;
    const regex = sidecarUriRegex(kind);
    const valid: string[] = [];
    let bad = 0;
    for (const row of rows) {
      const uri = (row as { uri?: unknown } | null | undefined)?.uri;
      if (typeof uri === 'string' && regex.test(uri)) {
        valid.push(uri);
      } else {
        bad++;
        if (invalidSamples.length < 5) invalidSamples.push(`${key}: ${JSON.stringify(uri ?? null)}`);
      }
    }
    invalidByKey[key] = bad;
    invalid += bad;
    validByKey[key] = valid;
    for (const uri of valid) {
      if (owner.has(uri)) continue; // a URI shared by two keys is restored once, under the first key
      owner.set(uri, key);
      candidates.push(uri);
    }
  }

  const collections = {} as Record<SidecarKey, { in_file: number; invalid: number; candidates: number }>;
  for (const { key } of SIDECAR_COLLECTIONS) {
    collections[key] = {
      in_file: Array.isArray(doc[key]) ? (doc[key] as unknown[]).length : 0,
      invalid: invalidByKey[key],
      candidates: validByKey[key].length,
    };
  }

  return { present, absent, candidates, owner, collections, invalid, invalidSamples, inFile };
}

/**
 * Which of `uris` the library does not already hold. The unified
 * `/me/library/contains` endpoint is the ungated, type-agnostic drop-in for the
 * per-type contains calls; a malformed or short reply fails closed rather than
 * reporting every item as missing.
 */
async function findMissingLibraryUris(client: SpotifyClient, uris: readonly string[]): Promise<string[]> {
  const present = new Set<string>();
  for (let i = 0; i < uris.length; i += CHUNK_CAPS.library_writes) {
    const chunk = uris.slice(i, i + CHUNK_CAPS.library_writes);
    const flags = await client.get<boolean[]>('/me/library/contains', libraryUrisParam(chunk));
    if (!Array.isArray(flags) || flags.length !== chunk.length) {
      throw new Error('Could not check library state (/me/library/contains)');
    }
    chunk.forEach((uri, idx) => {
      if (flags[idx]) present.add(uri);
    });
  }
  return uris.filter((uri) => !present.has(uri));
}

/** Per-key counts over all five collections, counting only owned candidates. */
function countByCollection(plan: SidecarPlan, subset: (uri: string) => boolean): Record<SidecarKey, number> {
  const counts: Record<SidecarKey, number> = { tracks: 0, albums: 0, shows: 0, episodes: 0, audiobooks: 0 };
  for (const uri of plan.candidates) {
    if (subset(uri)) counts[plan.owner.get(uri) as SidecarKey]++;
  }
  return counts;
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
      output_dir: z.string().optional().describe('Local directory to write into, confined to the output root (default ~/.spotify-mcp/portability, set SPOTIFY_MCP_PORTABILITY_DIR to move it)'),
      format: z.enum(['json', 'csv']).optional().default('json').describe('Output format: json (single file) or csv (one file per type)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      // #622: the caller's output_dir is symlink-resolved and must stay inside
      // the configured root; a relative value is taken as root-relative.
      const { dir } = await resolveOutputPath({
        root: portabilityDir(),
        target: args.output_dir ?? '.',
        tool: 'export_library_json',
        kind: 'directory',
      });
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
          const p = join(dir, `${name}.csv`);
          await writeOutputFile(p, csvTable(headers, rows));
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
      await writeOutputFile(filePath, body);
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
      output_dir: z.string().optional().describe('Local directory to write into, confined to the output root (default ~/.spotify-mcp/portability, set SPOTIFY_MCP_PORTABILITY_DIR to move it)'),
      format: z.enum(['json', 'csv']).optional().default('json').describe('Output format: json or csv'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const { dir } = await resolveOutputPath({
        root: portabilityDir(),
        target: args.output_dir ?? '.',
        tool: 'export_followed_artists',
        kind: 'directory',
      });
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

      const exportedAt = new Date().toISOString();
      const capReached = artists.length >= cap;
      const truncated = capReached;

      if (args.format === 'csv') {
        const headers = ['uri', 'name', 'genres'];
        const rows = artists.map((a) => [a.uri, a.name, a.genres.join(';')]);
        const lines = csvTable(headers, rows);
        const filePath = join(dir, 'followed_artists.csv');
        await writeOutputFile(filePath, lines);
        const footer = truncated ? ` [truncated — first ${cap}; raise SPOTIFY_MCP_FETCH_ALL_CAP for the full list]` : '';
        const payload = { ok: true, dir, file: filePath, format: 'csv', total: artists.length, cap_reached: capReached, truncated, cap, exported_at: exportedAt };
        return shapeResult(rf, `Exported ${artists.length} followed artist(s) to ${filePath} as CSV.${footer}`, payload);
      }

      const doc = { exported_at: exportedAt, total: artists.length, cap_reached: capReached, truncated, cap, artists: artists.map((a) => ({ uri: a.uri, name: a.name, genres: a.genres })) };
      const filePath = join(dir, 'followed_artists.json');
      const body = `${JSON.stringify(doc, null, 2)}\n`;
      await writeOutputFile(filePath, body);
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
      output_dir: z.string().optional().describe('Directory to write the archive into, confined to the output root (default ~/.spotify-mcp/exports, set SPOTIFY_MCP_EXPORT_DIR to move it)'),
      include_history: z.boolean().optional().default(false).describe('Include mutation history JSONL (can be large)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const { dir } = await resolveOutputPath({
        root: exportRootDir(),
        target: args.output_dir ?? '.',
        tool: 'export_profile_state',
        kind: 'directory',
      });
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

      // mutations history (optional) — bounded tail read (#628)
      if (args.include_history) {
        const records = await readHistory();
        stores.mutations_history = records.length > 0 ? records : null;
        counts.mutations_history = records.length;
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
      await writeOutputFile(filePath, body);
      const bytes = Buffer.byteLength(body);
      const payload = { ok: true, path: filePath, bytes, counts, schema_version: PROFILE_STATE_SCHEMA_VERSION };
      return shapeResult(rf, `Exported profile state to ${filePath} (${bytes} bytes) — ${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(', ')}.`, payload);
    },
  );

  server.tool(
    'import_profile_state',
    'Restore local sidecar stores from a profile-state archive. merge unions each store on its own keys and de-duplicates search_history by entry id; overwrite replaces each store, keeping a 0600 <file>.bak of what it replaced. dry_run reports the per-store plan and writes nothing. Refuses newer schema versions.',
    {
      input_path: z.string().describe('Path to the profile-state archive JSON file'),
      mode: z.enum(['merge', 'overwrite']).optional().default('merge').describe('merge = union on each store\'s own keys; overwrite = replace, keeping a .bak'),
      dry_run: DryRun,
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

      /**
       * #752: one row of the per-store plan. Planning only reads, so the same
       * rows back both the dry run and the commit.
       */
      interface StorePlan {
        store: string;
        path: string;
        action: 'created' | 'merged' | 'overwritten' | 'appended' | 'skipped';
        summary: string;
        /** The exact value to write. Never echoed into a result payload. */
        data: unknown;
        existing_keys: number | null;
        added: number;
        conflicts: number;
        dropped_duplicates: number;
        dropped_expired: number;
        unreadable_timestamps: number;
        /** Overwrite only: the .bak this run wrote, or would write. */
        backup: string | null;
      }

      /** The plan as reported — the bytes headed for the store are withheld. */
      const planRow = ({ data: _bytes, ...row }: StorePlan): Omit<StorePlan, 'data'> => row;

      /** #752: the merge line, shared by the dry run and the commit report. */
      const mergeSummary = (label: string, o: MergeOutcome): string => {
        const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
        const notes = [`${label}: ${o.existing_keys} existing + ${o.added} new${o.conflicts > 0 ? `, ${plural(o.conflicts, 'conflict')} overwritten` : ''}`];
        if (o.dropped_duplicates > 0) notes.push(`dropped ${plural(o.dropped_duplicates, 'duplicate entry')}`);
        if (o.dropped_expired > 0) notes.push(`dropped ${plural(o.dropped_expired, 'entry')} older than 90 days`);
        if (o.unreadable_timestamps > 0) notes.push(`kept ${plural(o.unreadable_timestamps, 'entry')} whose timestamp could not be read`);
        return notes.join('; ');
      };

      const plan: StorePlan[] = [];
      const results: Record<string, string> = {};
      const backups: Record<string, string> = {};

      const writeStore = async (filePath: string, data: unknown) => {
        await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
        await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      };

      const planStore = async (
        label: string,
        filePath: string,
        incoming: unknown,
        kind: 'record' | 'array',
      ): Promise<void> => {
        if (incoming == null) return;
        const present = await fileExists(filePath);
        const incomingCount = kind === 'array'
          ? (Array.isArray(incoming) ? incoming.length : 0)
          : (isPlainRecord(incoming) ? Object.keys(incoming).length : 0);
        const base = {
          store: label,
          path: filePath,
          existing_keys: 0,
          added: 0,
          conflicts: 0,
          ...NO_DROPPED,
          backup: null as string | null,
        };

        if (args.mode === 'overwrite') {
          plan.push({
            ...base,
            action: present ? 'overwritten' : 'created',
            data: incoming,
            added: incomingCount,
            backup: present ? `${filePath}.bak` : null,
            summary: present
              ? `replace ${label} with ${incomingCount} archive entries — the current store is kept at ${filePath}.bak`
              : `create ${label} with ${incomingCount} archive entries (no local store to replace)`,
          });
          return;
        }

        const existing = await tryReadJson(filePath);
        // A local store that is not this kind — absent, or present in another
        // shape — has no keys to merge with, so it merges against an empty one
        // and is reported as the create-or-replace it really is. The
        // de-duplication and retention the merge applies then hold on the very
        // first import too.
        const compatible = kind === 'record' ? isPlainRecord(existing) : Array.isArray(existing);
        const pushMerge = (outcome: MergeOutcome) => {
          plan.push({
            ...base,
            action: compatible ? 'merged' : present ? 'overwritten' : 'created',
            data: outcome.data,
            existing_keys: outcome.existing_keys,
            added: outcome.added,
            conflicts: outcome.conflicts,
            dropped_duplicates: outcome.dropped_duplicates,
            dropped_expired: outcome.dropped_expired,
            unreadable_timestamps: outcome.unreadable_timestamps,
            backup: present ? `${filePath}.bak` : null,
            summary: compatible
              ? mergeSummary(label, outcome)
              : present
                ? `${label}: the local store does not match the archive's ${kind} shape, so it is replaced with ${outcome.added} archive entries — the current store is kept at ${filePath}.bak`
                : `create ${label} with ${outcome.added} archive entries (no local store to merge into)`,
          });
        };
        if (kind === 'record' && isPlainRecord(incoming)) {
          pushMerge(mergeRecordStore(label, compatible ? (existing as Record<string, unknown>) : {}, incoming));
          return;
        }
        if (kind === 'array' && Array.isArray(incoming)) {
          pushMerge(mergeSearchHistory(compatible ? (existing as unknown[]) : [], incoming));
          return;
        }
        // The archive does not carry this store in a shape the store's own
        // reader accepts, so writing it would break every reader of the file.
        // The local store is left alone and the skip is reported.
        plan.push({
          ...base,
          action: 'skipped',
          data: null,
          summary: `${label}: the archive's entry is not a ${kind} store, so the local store is left unchanged`,
        });
      };

      /** #752: the mutation ledger is JSONL, appended to rather than rewritten. */
      const planLedger = async (value: unknown): Promise<void> => {
        if (!Array.isArray(value)) return;
        const histPath = historyFilePath();
        const present = await fileExists(histPath);
        // An unreadable ledger reports no count rather than a fabricated zero.
        const existingKeys = present
          ? await readFile(histPath, 'utf8').then(
            (raw) => raw.split('\n').filter((l) => l.trim().length > 0).length,
            () => null,
          )
          : 0;
        const data = `${value.map((r) => JSON.stringify(r)).join('\n')}\n`;
        if (args.mode === 'overwrite') {
          plan.push({
            store: 'mutations_history',
            path: histPath,
            action: present ? 'overwritten' : 'created',
            summary: present
              ? `replace mutations_history with ${value.length} ledger records — the current ledger is kept at ${histPath}.bak`
              : `create mutations_history with ${value.length} ledger records (no local ledger to replace)`,
            data,
            existing_keys: 0,
            added: value.length,
            conflicts: 0,
            ...NO_DROPPED,
            backup: present ? `${histPath}.bak` : null,
          });
          return;
        }
        plan.push({
          store: 'mutations_history',
          path: histPath,
          action: 'appended',
          summary: `append ${value.length} ledger record(s) to mutations_history`,
          data,
          existing_keys: existingKeys,
          added: value.length,
          conflicts: 0,
          ...NO_DROPPED,
          backup: null,
        });
      };

      for (const [key, value] of Object.entries(stores)) {
        if (!allowedKeys.has(key)) continue; // ignore unknown keys
        if (value == null) continue;
        switch (key) {
          case 'scenes':
            await planStore('scenes', scenesFilePath(), value, 'record');
            break;
          case 'genre_tags':
            await planStore('genre_tags', genreTagsPath(), value, 'record');
            break;
          case 'playback_ext':
            await planStore('playback_ext', playbackExtFile(), value, 'record');
            break;
          case 'search_history':
            await planStore('search_history', searchHistoryFile(), value, 'array');
            break;
          case 'artist_watchlist':
            await planStore('artist_watchlist', watchlistFilePath(), value, 'record');
            break;
          case 'mutations_history':
            await planLedger(value);
            break;
        }
      }

      if (args.dry_run) {
        const payload = {
          ok: true,
          dry_run: true,
          executed: false,
          mode: args.mode,
          input_path: args.input_path,
          plan: plan.map(planRow),
        };
        return shapeResult(rf, describeDryRun('import_profile_state', args.input_path, plan.map((p) => p.summary)), payload);
      }

      for (const step of plan) {
        if (step.action === 'skipped') {
          results[step.store] = 'skipped';
          continue;
        }
        if (step.backup) backups[step.store] = await writeStoreBackup(step.path);
        if (step.store === 'mutations_history') {
          await mkdir(dirname(step.path), { recursive: true, mode: HISTORY_DIR_MODE });
          // Mode arguments only apply at creation, so re-assert after the
          // write: a pre-existing or copied-in ledger must not stay
          // group/world-readable (#628).
          await chmod(dirname(step.path), HISTORY_DIR_MODE);
          const body = step.data as string;
          if (step.action === 'appended') {
            try {
              await appendFile(step.path, body, { encoding: 'utf8', mode: HISTORY_FILE_MODE } as unknown as Record<string, unknown>);
            } catch {
              await writeFile(step.path, body, { encoding: 'utf8', mode: HISTORY_FILE_MODE });
            }
          } else {
            await writeFile(step.path, body, { encoding: 'utf8', mode: HISTORY_FILE_MODE });
          }
          await chmod(step.path, HISTORY_FILE_MODE);
          results.mutations_history = step.action === 'appended' ? 'merged' : step.action;
          continue;
        }
        await writeStore(step.path, step.data);
        results[step.store] = step.action;
      }

      const payload = {
        ok: true,
        dry_run: false,
        executed: true,
        mode: args.mode,
        input_path: args.input_path,
        results,
        ...(Object.keys(backups).length > 0 ? { backups } : {}),
        plan: plan.map(planRow),
      };
      const backupNote = Object.keys(backups).length > 0
        ? ` Replaced stores were backed up first: ${Object.entries(backups).map(([k, v]) => `${k} → ${v}`).join(', ')}.`
        : '';
      return shapeResult(rf, `Imported profile state from ${args.input_path} (mode: ${args.mode}) — ${plan.map((p) => p.summary).join(' | ') || 'nothing to import'}.${backupNote}`, payload);

    },
  );

  // -------------------------------------------------------------------------
  // #220: export_listening_history
  // -------------------------------------------------------------------------

  server.tool(
    'export_listening_history',
    'Export your listening history (recently played) to a JSON or CSV sidecar by walking /me/player/recently-played with before-cursor pagination. Respects SPOTIFY_MCP_FETCH_ALL_CAP; writes file 0600 and reports path + counts. Analogous to export_library_json.',
    {
      output_dir: z.string().optional().describe('Local directory to write into, confined to the output root (default ~/.spotify-mcp/portability, set SPOTIFY_MCP_PORTABILITY_DIR to move it)'),
      format: z.enum(['json', 'csv']).optional().default('json').describe('Output format: json or csv'),
      limit: z.number().int().min(1).max(10000).optional().describe('Alias for max_items'),
      max_items: z.number().int().min(1).max(10000).optional().describe('Max history items to export (default: SPOTIFY_MCP_FETCH_ALL_CAP)'),
      before: z.string().optional().describe('Cursor: only return items played before this timestamp (milliseconds since epoch or ISO string)'),
      after: z.string().optional().describe('Cursor: only return items played after this timestamp (milliseconds since epoch or ISO string)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const { dir } = await resolveOutputPath({
        root: listeningHistoryDir(),
        target: args.output_dir ?? '.',
        tool: 'export_listening_history',
        kind: 'directory',
      });
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
        const lines = csvTable(headers, rows);
        const filePath = join(dir, 'listening_history.csv');
        await writeOutputFile(filePath, lines);
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
      await writeOutputFile(filePath, body);
      const bytes = Buffer.byteLength(body);
      const footer = truncated ? ` [truncated — first ${cap}; raise SPOTIFY_MCP_FETCH_ALL_CAP or max_items for more]` : '';
      return shapeResult(rf, `Exported ${items.length} listening-history item(s) to ${filePath} (${bytes} bytes).${footer}`, { ok: true, dir, file: filePath, format: 'json', bytes, total: items.length, cap_reached: capReached, truncated, cap, exported_at: exportedAt });
    },
  );

  // export_all_playlists — collection export (issue sweep #2)
  server.tool(
    'export_all_playlists',
    'Export every owned (or all) playlist with metadata + items to a sidecar file. Quota: GET /me/playlists + N×GET /playlists/{id}/items; capped by fetchAllCap.',
    {
      output_dir: z.string().optional().describe('Local directory to write into, confined to the output root (default ~/.spotify-mcp/portability, set SPOTIFY_MCP_PORTABILITY_DIR to move it)'),
      format: z.enum(['json', 'csv']).optional().default('json').describe('Output format'),
      include_items: z.boolean().optional().default(true).describe('Include track items per playlist'),
      scope: z.enum(['owned', 'all']).optional().default('all').describe('owned = only playlists you own'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const { dir } = await resolveOutputPath({
        root: portabilityDir(),
        target: args.output_dir ?? '.',
        tool: 'export_all_playlists',
        kind: 'directory',
      });
      const cap = getConfig().fetchAllCap;
      const me = await client.get<{ id?: string }>('/me');
      const myId = me?.id as string | undefined;
      let playlists = await client.getAllPages<SpotifyPlaylistSimple>('/me/playlists', { limit: '50' }, { maxItems: cap });
      if (args.scope === 'owned' && myId) playlists = playlists.filter((p) => p?.owner?.id === myId);
      const exportedAt = new Date().toISOString();
      let playlistRows: Array<{ id: string; name: string; uri: string; total: number; items: Array<{ uri: string; name: string }> }> = playlists.map((p) => ({ id: p.id, name: p.name, uri: p.uri, total: p.items?.total ?? 0, items: [] }));
      if (args.include_items !== false) {
        for (const row of playlistRows) {
          try {
            const items = await client.getAllPages<PlaylistItemObject>(`/playlists/${encodeURIComponent(row.id)}/items`, { limit: '100' }, { maxItems: cap });
            row.items = items.map((r) => ({ uri: (r?.item as { uri?: string })?.uri ?? '', name: (r?.item as { name?: string })?.name ?? '' })).filter((x) => x.uri);
          } catch { row.items = []; }
        }
      }
      if (args.format === 'csv') {
        const headers = ['playlist_id', 'playlist_name', 'item_uri', 'item_name'];
        const rows: string[][] = [];
        for (const pl of playlistRows) {
          if (pl.items.length === 0) rows.push([pl.id, pl.name, '', '']);
          else for (const it of pl.items) rows.push([pl.id, pl.name, it.uri, it.name]);
        }
        const lines = csvTable(headers, rows);
        const fp = join(dir, 'playlists.csv');
        await writeOutputFile(fp, lines);
        return shapeResult(rf, `Exported ${playlistRows.length} playlist(s) (${rows.length} rows) to ${fp}.`, { ok: true, dir, file: fp, format: 'csv', total: playlistRows.length, rows: rows.length });
      }
      const doc = { exported_at: exportedAt, total: playlistRows.length, scope: args.scope, playlists: playlistRows };
      const fp = join(dir, 'playlists.json');
      const body = `${JSON.stringify(doc, null, 2)}\n`;
      await writeOutputFile(fp, body);
      return shapeResult(rf, `Exported ${playlistRows.length} playlist(s) to ${fp} (${Buffer.byteLength(body)} bytes).`, { ok: true, dir, file: fp, format: 'json', bytes: Buffer.byteLength(body), total: playlistRows.length, scope: args.scope });
    },
  );

  // library_snapshot_diff — diff two sidecar files locally
  server.tool(
    'library_snapshot_diff',
    'Diff two portability/library sidecar JSON files (library.json or playlists.json): added/removed counts + samples. Quota: 🟢 local only (no API).',
    {
      before_path: z.string().describe('Path to before snapshot JSON'),
      after_path: z.string().describe('Path to after snapshot JSON'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const readJson = async (p: string) => JSON.parse(await readFile(p, 'utf8'));
      const before = await readJson(args.before_path);
      const after = await readJson(args.after_path);
      const extractUris = (doc: Record<string, unknown>): Set<string> => {
        const s = new Set<string>();
        for (const k of ['tracks', 'albums', 'shows', 'episodes', 'audiobooks', 'artists', 'playlists']) {
          const arr = doc[k] as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(arr)) for (const r of arr) { const u = (r.uri ?? r.id) as string | undefined; if (u) s.add(String(u)); }
        }
        // playlists nested items
        const pls = doc.playlists as Array<{ items?: Array<{ uri: string }> }> | undefined;
        if (Array.isArray(pls)) for (const pl of pls) for (const it of (pl.items ?? [])) if (it?.uri) s.add(it.uri);
        return s;
      };
      const bSet = extractUris(before as Record<string, unknown>);
      const aSet = extractUris(after as Record<string, unknown>);
      const added = [...aSet].filter((x) => !bSet.has(x));
      const removed = [...bSet].filter((x) => !aSet.has(x));
      const payload = { ok: true, before: args.before_path, after: args.after_path, added_count: added.length, removed_count: removed.length, added_sample: added.slice(0, 10), removed_sample: removed.slice(0, 10) };
      const prose = `Diff: +${added.length} added, -${removed.length} removed. Added sample: ${added.slice(0, 3).join(', ') || '—'}; Removed sample: ${removed.slice(0, 3).join(', ') || '—'}`;
      return shapeResult(rf, prose, payload);
    },
  );

  // history_search — search portability sidecar filenames + mutation history
  server.tool(
    'history_search',
    'Search local portability/backups for files matching a query (filename substring). Quota: 🟢 local only (no API).',
    {
      query: z.string().optional().describe('Substring to match (default: all)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const dir = portabilityDir();
      let files: string[] = [];
      try { files = await readdir(dir); } catch { files = []; }
      const q = (args.query ?? '').toLowerCase();
      const matched = q ? files.filter((f) => f.toLowerCase().includes(q)) : files;
      const payload = { ok: true, dir, total: files.length, matched_count: matched.length, files: matched.slice(0, 50) };
      return shapeResult(rf, `Found ${matched.length}/${files.length} file(s) matching "${args.query ?? ''}" in ${dir}.`, payload);
    },
  );

  // import_from_sidecar — additive restore from sidecar (dry_run defaults true)
  server.tool(
    'import_from_sidecar',
    'Additive restore from a library.json sidecar written by export_library_json: re-adds every missing saved item across all five collections (tracks, albums, shows, episodes, audiobooks) through the unified PUT /me/library endpoint, skipping items the library already holds. Rows whose uri is not a canonical spotify:<kind>:<22-char id> URI are counted as invalid and never sent. Collections the file does not carry are named in absent_keys. dry_run=true by default. Quota: 🟢 local read + 🟡 contains-check + writes when dry_run=false (chunked).',
    {
      input_path: z.string().optional().describe('Path to sidecar JSON (default: <portability>/library.json)'),
      dry_run: z.boolean().optional().default(true).describe('Preview only, making no API calls at all. Writes happen only when explicitly set to false.'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const inputPath = args.input_path ?? join(portabilityDir(), 'library.json');
      const raw = await readFile(inputPath, 'utf8');
      const doc = JSON.parse(raw) as Record<string, unknown>;
      // #736: every collection the exporter writes is planned, not just tracks.
      const plan = planSidecarRestore(doc);

      const absentLine = plan.absent.length > 0
        ? `${inputPath} has no ${plan.absent.join(' / ')} key — nothing to restore for ${plan.absent.join(' / ')}.`
        : '';
      const invalidLine = plan.invalid > 0
        ? `${plan.invalid} invalid row(s) skipped (not a canonical spotify:<kind>:<22-char id> URI): ${plan.invalidSamples.join('; ')}`
        : '';

      // Dry run: local read only — no contains-check, no write, same per-collection plan.
      if (args.dry_run !== false) {
        const would_import = {} as Record<SidecarKey, number>;
        for (const { key } of SIDECAR_COLLECTIONS) would_import[key] = plan.collections[key].candidates;
        const payload = {
          ok: true,
          dry_run: true,
          executed: false,
          input: inputPath,
          present_keys: plan.present,
          absent_keys: plan.absent,
          collections: plan.collections,
          would_import,
          total_in_file: plan.inFile,
          invalid: plan.invalid,
          invalid_samples: plan.invalidSamples,
          sample: plan.candidates.slice(0, 5),
        };
        const lines = [
          `Would restore ${plan.candidates.length} item(s) from ${plan.present.length} collection(s): ${plan.present.join(', ') || '—'}`,
          ...plan.candidates.slice(0, 5).map((u) => u),
        ];
        if (plan.candidates.length > 5) lines.push(`…and ${plan.candidates.length - 5} more`);
        if (absentLine) lines.push(absentLine);
        if (invalidLine) lines.push(invalidLine);
        return shapeResult(rf, describeDryRun('import_from_sidecar', inputPath, lines), payload);
      }

      if (plan.candidates.length === 0) {
        const payload = {
          ok: true,
          dry_run: false,
          executed: true,
          input: inputPath,
          present_keys: plan.present,
          absent_keys: plan.absent,
          collections: plan.collections,
          imported: countByCollection(plan, () => false),
          added: 0,
          skipped_existing: 0,
          invalid: plan.invalid,
          invalid_samples: plan.invalidSamples,
          total_in_file: plan.inFile,
        };
        return shapeResult(
          rf,
          `Import from ${inputPath}: added 0 item(s) — the sidecar carried no valid library URI to restore.${absentLine ? ` ${absentLine}` : ''}${invalidLine ? ` ${invalidLine}` : ''}`,
          payload,
        );
      }

      // #637: one contains-check over the whole candidate set, then one gated,
      // chunked write through the unified endpoint. No deprecated per-type PUT.
      const missing = await findMissingLibraryUris(client, plan.candidates);
      const addedSet = new Set(missing);
      const imported = countByCollection(plan, (u) => addedSet.has(u));
      const skippedByCollection = countByCollection(plan, (u) => !addedSet.has(u));
      const skippedExisting = plan.candidates.length - missing.length;

      if (missing.length >= BATCH_ADD_ELICIT_THRESHOLD) {
        const verdict = await confirmViaElicitation(server, {
          message: describeConfirmation('restore library items from', inputPath, [
            `Re-add ${missing.length} item(s) across ${Object.entries(imported).filter(([, n]) => n > 0).map(([k, n]) => `${k}: ${n}`).join(', ')}:`,
            ...missing.slice(0, 10).map((u) => `  - ${u}`),
            ...(missing.length > 10 ? [`  (…and ${missing.length - 10} more)`] : []),
          ]),
          confirmLabel: 'Restore library',
        });
        const refusal = requiredConfirmationRefusal(verdict);
        if (refusal) return shapeResult(rf, refusal.message, refusal.payload);
      }

      for (let i = 0; i < missing.length; i += CHUNK_CAPS.library_writes) {
        const chunk = missing.slice(i, i + CHUNK_CAPS.library_writes);
        await client.put(`/me/library?${new URLSearchParams(libraryUrisParam(chunk)).toString()}`);
      }

      // #736: the import is invertible through undo_last_mutation. A run that
      // wrote nothing mints no receipt — an empty-uri receipt would report
      // VERIFIED with after=0 and imply a save that never happened.
      const receipt = missing.length > 0 ? await issueReceipt(client, { kind: 'library', uris: missing }) : null;
      const payload = {
        ok: true,
        dry_run: false,
        executed: true,
        input: inputPath,
        present_keys: plan.present,
        absent_keys: plan.absent,
        collections: plan.collections,
        imported,
        added: missing.length,
        skipped_existing: skippedExisting,
        skipped_by_collection: skippedByCollection,
        invalid: plan.invalid,
        invalid_samples: plan.invalidSamples,
        total_in_file: plan.inFile,
        sample: missing.slice(0, 5),
        ...(receipt ? { receipt: receipt.receipt_id } : {}),
      };
      const summary = Object.entries(imported)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k}: ${n}`)
        .join(', ');
      const prose = [
        `Import from ${inputPath}: added ${missing.length} item(s) to Your Library (${summary || 'none'}) across ${plan.present.length} collection(s).`,
        skippedExisting > 0 ? `${skippedExisting} item(s) were already in the library and were left untouched.` : '',
        invalidLine,
        absentLine,
        batchSummary(missing.length, missing),
        ...(receipt ? [formatReceipt(receipt)] : []),
      ]
        .filter((l) => l !== '')
        .join('\n');
      return shapeResult(rf, prose, payload);
    },
  );
}
