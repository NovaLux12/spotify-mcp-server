/**
 * Library backup (#159): snapshot the entire reachable library — liked
 * tracks, saved albums/shows/episodes/audiobooks, followed artists and every
 * playlist (with items) — into a timestamped local JSON file plus a bounded
 * metadata sidecar used by list_backups.
 *
 * Backups are READ-ONLY against Spotify: every endpoint hit is a GET. Local
 * snapshots and sidecars use owner-only dir 0700 / file 0600 permissions.
 * Restore stays a separate, additive-only concern (#160).
 *
 * The store is BOUNDED (#697): snapshots expire after
 * SPOTIFY_MCP_BACKUP_RETENTION_DAYS (default 30, 0 disables), expiry runs
 * at the start of every backup_library and on every list_backups, and
 * delete_backup removes one snapshot on request behind a confirmation gate
 * with a dry run as the default. A snapshot is a dated compilation of the
 * user's saves, so it must not outlive its purpose by default.
 *
 * Incompleteness is recorded, not implied (#735): _meta.reported_totals
 * carries Spotify's own size for each collection next to the walked
 * counts, a playlist that could not be read keeps its error, and the prose
 * names every shortfall through the shared completenessFooter vocabulary.
 *
 * Every walk is capped at getConfig().fetchAllCap (SPOTIFY_MCP_FETCH_ALL_CAP,
 * default 500); an explicit max_results argument overrides it for this call.
 */
import { z } from 'zod';
import { lstat, mkdir, open, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { getConfig } from '../config.js';
import {
  ResponseFormat,
  DryRun,
  completenessFooter,
  describeDryRun,
  type ResponseFormatValue,
} from '../shaping.js';
import { SpotifyApiError } from '../client.js';
import { backupRetentionDays, resolveOutputPath } from '../paths.js';
import { confirmViaElicitation, describeConfirmation, requiredConfirmationRefusal } from './confirm.js';
import type {
  FollowedArtistsResponse,
  PlaylistItemObject,
  SavedAlbumItem,
  SavedAudiobookItem,
  SavedEpisodeItem,
  SavedShowItem,
  SavedTrackItem,
  SpotifyPaged,
  SpotifyPlaylistSimple,
} from '../types/spotify.js';

// ---------------------------------------------------------------------------
// Snapshot schema (stable on-disk contract; restore #160 consumes these files)
// ---------------------------------------------------------------------------

/** One saved-library row: full URI, display name, when it was added. */
export interface BackupSavedRow {
  uri: string;
  name: string;
  added_at: string;
}

/** Followed artist row (the follow API carries no added_at). */
export interface BackupArtistRow {
  uri: string;
  name: string;
}

/** One playlist with its paged items (uri + name only). */
export interface BackupPlaylistRow {
  uri: string;
  name: string;
  /** Spotify's own item total when reported (`items.total`), else items.length. */
  item_count: number | null;
  items: Array<{ uri: string; name: string }>;
  /** True when stored playlist items are incomplete because the item cap was reached. */
  items_truncated: boolean;
  /** Present when Spotify could not be read for this playlist. */
  items_error?: string;
}

export type BackupCollectionName =
  | 'liked_tracks'
  | 'saved_albums'
  | 'saved_shows'
  | 'saved_episodes'
  | 'saved_audiobooks'
  | 'followed_artists'
  | 'playlists';

export interface BackupCollectionStatus {
  fetched: number;
  cap: number;
  complete: boolean;
  truncated: boolean;
}

/** Prose name per collection, for the truncation disclosures (#735). */
const COLLECTION_SUBJECTS: Record<BackupCollectionName, string> = {
  liked_tracks: 'liked tracks',
  saved_albums: 'saved albums',
  saved_shows: 'saved shows',
  saved_episodes: 'saved episodes',
  saved_audiobooks: 'saved audiobooks',
  followed_artists: 'followed artists',
  playlists: 'playlists',
};

/** Cheap top-level block mirrored to an owner-only sidecar for list_backups. */
export interface BackupMeta {
  created: string;
  /** True on every file this server writes: the file holds Spotify Content. */
  spotify_data: true;
  /**
   * ISO instant this snapshot falls out of the retention window
   * (#697), or null when pruning is disabled. The file is
   * self-describing, so a copy kept outside the server still says how
   * long it was meant to live.
   */
  retention_until: string | null;
  notes?: string;
  snapshot_state: 'complete' | 'partial';
  complete: boolean;
  partial_reason?: string;
  partial_reasons: string[];
  cap: number;
  caps: {
    per_category: number;
    playlist_items_per_playlist: number;
  };
  collections: Record<BackupCollectionName, BackupCollectionStatus>;
  playlist_items: {
    fetched: number;
    cap_per_playlist: number;
    truncated: boolean;
    truncated_playlists: number;
  };
  /**
   * What Spotify itself reported as the collection size, captured from
   * each page's `total` (#735). Distinct from counts.*, which are the
   * walked lengths: when the two disagree the walk was cut at the cap and
   * the snapshot is short by `reported - count`.
   */
  reported_totals: Record<BackupCollectionName, number | null>;
  counts: {
    liked_tracks: number;
    saved_albums: number;
    saved_shows: number;
    saved_episodes: number;
    saved_audiobooks: number;
    followed_artists: number;
    playlists: number;
    playlist_items: number;
    playlists_truncated: number;
  };
}

/**
 * On-disk contract version of a snapshot file (#757). A file declaring
 * any other version is refused by restore_library_snapshot instead of
 * being parsed on a guess: this field is what lets a future format
 * change be rejected rather than half-understood.
 */
export const LIBRARY_BACKUP_SCHEMA_VERSION = 1;

/**
 * Top-level keys of a backup-*.json file. Order matters only cosmetically;
 * consumers MUST treat unknown keys as forward-compatible additions.
 */
export interface LibraryBackup {
  schema_version: typeof LIBRARY_BACKUP_SCHEMA_VERSION;
  _meta: BackupMeta;
  liked_tracks: BackupSavedRow[];
  saved_albums: BackupSavedRow[];
  saved_shows: BackupSavedRow[];
  saved_episodes: BackupSavedRow[];
  saved_audiobooks: BackupSavedRow[];
  followed_artists: BackupArtistRow[];
  playlists: BackupPlaylistRow[];
}

// ---------------------------------------------------------------------------
// Sidecar location + sequencing
// ---------------------------------------------------------------------------

/** Backup dir; SPOTIFY_MCP_BACKUP_DIR overrides the whole directory. */
export function backupDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SPOTIFY_MCP_BACKUP_DIR ?? join(homedir(), '.spotify-mcp', 'backups');
}

const BACKUP_FILE_RE = /^backup-(\d{4}-\d{2}-\d{2})-(\d+)(\.partial)?\.json$/;

/**
 * Next free sequence for today's date inside dir. Scans existing names so
 * repeated backups the same day never clobber each other.
 */
export async function nextBackupSeq(dir: string, dateStamp: string): Promise<number> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return 1;
  }
  let max = 0;
  for (const n of names) {
    const m = BACKUP_FILE_RE.exec(n);
    if (m && m[1] === dateStamp) max = Math.max(max, Number(m[2]));
  }
  return max + 1;
}

// ---------------------------------------------------------------------------
// Collection (read-only GETs, all walks capped)
// ---------------------------------------------------------------------------


interface WalkResult<T> {
  rows: T[];
  complete: boolean;
  truncated: boolean;
  /**
   * The size Spotify itself reported for the whole collection (#735), or
   * null when no page carried a usable `total`. Always the FULL size, so a
   * capped walk can be reported as "3 of 5" rather than silently as 3.
   */
  reportedTotal: number | null;
}

/** First numeric `total` seen on a page; later pages cannot lower it. */
function firstReportedTotal(total: unknown, already: number | null): number | null {
  if (already !== null) return already;
  return typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : null;
}

/**
 * Offset-walk a standard Spotify paged endpoint up to `cap` items. The
 * endpoint's own `next` signal distinguishes an exact-cap ending from a walk
 * that was cut short, without fetching cap + 1 full rows.
 */
async function walkOffset<T>(client: SpotifyClient, path: string, cap: number): Promise<WalkResult<T>> {
  const out: T[] = [];
  let offset = 0;
  let truncated = false;
  let complete = false;
  let reportedTotal: number | null = null;
  const maxRequests = Math.ceil((cap + 1) / 50) + 1;
  for (let request = 0; request < maxRequests && offset <= cap; request += 1) {
    const page = await client.get<SpotifyPaged<T>>(path, {
      limit: String(Math.min(50, cap + 1 - out.length)),
      offset: String(offset),
    });
    if (!page || !Array.isArray(page.items)) {
      complete = true;
      break;
    }
    reportedTotal = firstReportedTotal(page.total, reportedTotal);
    out.push(...page.items);
    if (out.length > cap) {
      out.length = cap;
      truncated = true;
      break;
    }
    if (!page.next || page.items.length === 0) {
      complete = true;
      break;
    }
    if (out.length >= cap) {
      truncated = true;
      break;
    }
    offset += page.items.length;
  }
  return { rows: out, complete, truncated, reportedTotal };
}

async function walkSaved(
  client: SpotifyClient,
  path: string,
  key: 'track' | 'album' | 'show' | 'episode' | 'audiobook',
  cap: number,
): Promise<WalkResult<BackupSavedRow>> {
  type Row = { added_at: string } & Record<string, { uri: string; name: string }>;
  const walked = await walkOffset<Row>(client, path, cap);
  const rows = walked.rows
    .filter((r) => r[key] !== undefined && r[key] !== null)
    .map((r) => ({ uri: r[key].uri, name: r[key].name, added_at: r.added_at }));
  return { rows, complete: walked.complete, truncated: walked.truncated, reportedTotal: walked.reportedTotal };
}

/** Cursor-walk followed artists, retaining the API's end-of-data signal. */
async function walkFollowedArtists(client: SpotifyClient, cap: number): Promise<WalkResult<BackupArtistRow>> {
  const out: BackupArtistRow[] = [];
  let after: string | undefined;
  let complete = false;
  let truncated = false;
  let reportedTotal: number | null = null;
  const maxRequests = Math.ceil((cap + 1) / 50) + 1;
  for (let request = 0; request < maxRequests; request += 1) {
    const params: Record<string, string> = { type: 'artist', limit: String(Math.min(50, cap + 1 - out.length)) };
    if (after) params.after = after;
    const page = await client.get<FollowedArtistsResponse>('/me/following', params);
    if (!page) {
      complete = true;
      break;
    }
    const items = page.artists?.items ?? [];
    reportedTotal = firstReportedTotal(page.artists?.total, reportedTotal);
    if (items.length === 0) {
      complete = true;
      break;
    }
    out.push(...items.map((a) => ({ uri: a.uri, name: a.name })));
    if (out.length > cap) {
      out.length = cap;
      truncated = true;
      break;
    }
    after = page?.artists?.cursors?.after ?? undefined;
    if (!page?.artists?.next || !after) {
      complete = true;
      break;
    }
    if (out.length >= cap) {
      truncated = true;
      break;
    }
  }
  return { rows: out, complete, truncated, reportedTotal };
}

/** Per-playlist item cap (#159): at most 500 valid items are stored. */
const PLAYLIST_ITEMS_CAP = 500;


/** Page valid playlist items and report a true next-page cap crossing. */
async function collectPlaylistItems(
  client: SpotifyClient,
  playlistId: string,
  cap: number,
): Promise<WalkResult<BackupPlaylistRow['items'][number]>> {
  const limit = Math.min(cap, PLAYLIST_ITEMS_CAP);
  const out: BackupPlaylistRow['items'] = [];
  let offset = 0;
  let complete = false;
  let truncated = false;
  let reportedTotal: number | null = null;
  const maxRequests = Math.ceil((limit + 1) / 100) + 1;
  for (let request = 0; request < maxRequests; request += 1) {
    const page = await client.get<SpotifyPaged<PlaylistItemObject>>(
      `/playlists/${playlistId}/items`,
      { limit: String(Math.min(100, limit + 1 - out.length)), offset: String(offset) },
    );
    if (!page || !Array.isArray(page.items)) {
      complete = true;
      break;
    }
    reportedTotal = firstReportedTotal(page.total, reportedTotal);
    let validBeyondRemaining = false;
    for (const row of page.items) {
      const item = row.item;
      if (!item || typeof item !== 'object') continue;
      if (typeof item.uri !== 'string' || typeof item.name !== 'string') continue;
      if (out.length >= limit) {
        validBeyondRemaining = true;
        break;
      }
      out.push({ uri: item.uri, name: item.name });
    }
    if (validBeyondRemaining) {
      truncated = true;
      break;
    }
    if (!page.next || page.items.length === 0) {
      complete = true;
      break;
    }
    if (out.length >= limit) {
      truncated = true;
      break;
    }
    offset += page.items.length;
  }
  return { rows: out, complete, truncated, reportedTotal };
}

type SnapshotBody = Omit<LibraryBackup, '_meta' | 'schema_version'>;
interface DetailedSnapshot {
  body: SnapshotBody;
  collections: BackupMeta['collections'];
  playlistItems: BackupMeta['playlist_items'];
  partialReasons: string[];
  reportedTotals: BackupMeta['reported_totals'];
}

/** Gather a snapshot plus truthful end-of-data/truncation metadata. */
async function collectSnapshotDetailed(client: SpotifyClient, cap: number): Promise<DetailedSnapshot> {
  const [liked, albums, shows, episodes, audiobooks, artists, playlistWalk] = await Promise.all([
    walkSaved(client, '/me/tracks', 'track', cap),
    walkSaved(client, '/me/albums', 'album', cap),
    walkSaved(client, '/me/shows', 'show', cap),
    walkSaved(client, '/me/episodes', 'episode', cap),
    walkSaved(client, '/me/audiobooks', 'audiobook', cap),
    walkFollowedArtists(client, cap),
    walkOffset<SpotifyPlaylistSimple>(client, '/me/playlists', cap),
  ]);

  const playlistRows: BackupPlaylistRow[] = [];
  const partialReasons: string[] = [];
  for (const p of playlistWalk.rows) {
    if (!p || typeof p.uri !== 'string') continue;
    const reported =
      p.items && typeof p.items === 'object' && typeof (p.items as { total?: unknown }).total === 'number'
        ? (p.items.total as number)
        : null;
    try {
      const walked = await collectPlaylistItems(client, p.id, cap);
      if (walked.truncated) partialReasons.push(`playlist_truncated:${p.uri}`);
      if (!walked.complete) partialReasons.push(`playlist_incomplete:${p.uri}`);
      playlistRows.push({
        uri: p.uri,
        name: typeof p.name === 'string' ? p.name : '',
        item_count: reported ?? walked.rows.length,
        items: walked.rows,
        items_truncated: walked.truncated,
      });
    } catch (e) {
      if (e instanceof SpotifyApiError && e.status === 429) throw e;
      const message = e instanceof Error ? e.message : String(e);
      partialReasons.push(`playlist_read_failed:${p.uri}:${message}`);
      playlistRows.push({
        uri: p.uri,
        name: typeof p.name === 'string' ? p.name : '',
        item_count: reported ?? 0,
        items: [],
        items_truncated: false,
        items_error: message,
      });
    }
  }

  const body: SnapshotBody = {
    liked_tracks: liked.rows,
    saved_albums: albums.rows,
    saved_shows: shows.rows,
    saved_episodes: episodes.rows,
    saved_audiobooks: audiobooks.rows,
    followed_artists: artists.rows,
    playlists: playlistRows,
  };
  const statuses: BackupMeta['collections'] = {
    liked_tracks: { fetched: liked.rows.length, cap, complete: liked.complete, truncated: liked.truncated },
    saved_albums: { fetched: albums.rows.length, cap, complete: albums.complete, truncated: albums.truncated },
    saved_shows: { fetched: shows.rows.length, cap, complete: shows.complete, truncated: shows.truncated },
    saved_episodes: { fetched: episodes.rows.length, cap, complete: episodes.complete, truncated: episodes.truncated },
    saved_audiobooks: { fetched: audiobooks.rows.length, cap, complete: audiobooks.complete, truncated: audiobooks.truncated },
    followed_artists: { fetched: artists.rows.length, cap, complete: artists.complete, truncated: artists.truncated },
    playlists: { fetched: playlistRows.length, cap, complete: playlistWalk.complete, truncated: playlistWalk.truncated },
  };
  const reportedTotals: BackupMeta['reported_totals'] = {
    liked_tracks: liked.reportedTotal,
    saved_albums: albums.reportedTotal,
    saved_shows: shows.reportedTotal,
    saved_episodes: episodes.reportedTotal,
    saved_audiobooks: audiobooks.reportedTotal,
    followed_artists: artists.reportedTotal,
    playlists: playlistWalk.reportedTotal,
  };
  const cappedCollections = Object.entries(statuses)
    .filter(([, status]) => !status.complete || status.truncated)
    .map(([name]) => name);
  if (cappedCollections.length > 0) partialReasons.unshift(`collection_cap_reached:${cappedCollections.join(',')}`);
  return {
    body,
    collections: statuses,
    playlistItems: {
      fetched: playlistRows.reduce((n, p) => n + p.items.length, 0),
      cap_per_playlist: Math.min(cap, PLAYLIST_ITEMS_CAP),
      truncated: playlistRows.some((p) => p.items_truncated),
      truncated_playlists: playlistRows.filter((p) => p.items_truncated).length,
    },
    reportedTotals,
    partialReasons,
  };
}

/** Gather the full library snapshot via read-only GETs. */
export async function collectSnapshot(client: SpotifyClient, cap: number): Promise<SnapshotBody> {
  return (await collectSnapshotDetailed(client, cap)).body;
}

function metaCounts(snap: SnapshotBody): BackupMeta['counts'] {
  return {
    liked_tracks: snap.liked_tracks.length,
    saved_albums: snap.saved_albums.length,
    saved_shows: snap.saved_shows.length,
    saved_episodes: snap.saved_episodes.length,
    saved_audiobooks: snap.saved_audiobooks.length,
    followed_artists: snap.followed_artists.length,
    playlists: snap.playlists.length,
    playlist_items: snap.playlists.reduce((n, p) => n + p.items.length, 0),
    playlists_truncated: snap.playlists.filter((p) => p.items_truncated).length,
  };
}

function buildMeta(
  created: string,
  detailed: DetailedSnapshot,
  notes?: string,
  forcedPartialReason?: string,
): BackupMeta {
  const partialReasons = forcedPartialReason
    ? [forcedPartialReason, ...detailed.partialReasons]
    : detailed.partialReasons;
  const complete = partialReasons.length === 0;
  return {
    created,
    spotify_data: true,
    retention_until: retentionUntil(created, backupRetentionDays()),
    ...(notes !== undefined ? { notes } : {}),
    snapshot_state: complete ? 'complete' : 'partial',
    complete,
    ...(partialReasons[0] !== undefined ? { partial_reason: partialReasons[0] } : {}),
    partial_reasons: partialReasons,
    cap: detailed.collections.liked_tracks.cap,
    caps: {
      per_category: detailed.collections.liked_tracks.cap,
      playlist_items_per_playlist: detailed.playlistItems.cap_per_playlist,
    },
    collections: detailed.collections,
    playlist_items: detailed.playlistItems,
    counts: metaCounts(detailed.body),
    reported_totals: detailed.reportedTotals,
  };
}

// ---------------------------------------------------------------------------
// Store envelope: retention, pruning, delete (#697)
// ---------------------------------------------------------------------------

/** A retention window is whole days; no calendar or DST arithmetic. */
const DAY_MS = 86_400_000;

/** At or above this many surviving snapshots, the store is flagged. */
const PRUNE_HINT_THRESHOLD = 5;

/** created + the configured window, or null when pruning is disabled. */
export function retentionUntil(created: string, retentionDays: number): string | null {
  if (retentionDays <= 0) return null;
  const ms = Date.parse(created);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + retentionDays * DAY_MS).toISOString();
}

function ageInDays(created: string, now: number): number | null {
  const ms = Date.parse(created);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((now - ms) / DAY_MS));
}

/** One backup file plus everything list_backups/prune need to judge it. */
interface StoreEntry {
  name: string;
  path: string;
  /** null when the file could not be stat()ed at all. */
  bytes: number | null;
  created: string | null;
  meta: Record<string, unknown> | null;
  metadataSource: 'sidecar' | 'legacy_prefix' | 'unavailable';
  sidecarBytes: number;
  /** lstat: false for a symlink or directory, which is never unlinked. */
  regularFile: boolean;
}

/**
 * Read one backup file's cheap metadata: bounded sidecar first, bounded
 * legacy prefix second, file mtime last. The same read serves retention,
 * the dir envelope and the listing, so a store is never parsed twice.
 */
async function readStoreEntry(dir: string, name: string): Promise<StoreEntry> {
  const path = join(dir, name);
  const entry: StoreEntry = {
    name,
    path,
    bytes: null,
    created: null,
    meta: null,
    metadataSource: 'unavailable',
    sidecarBytes: 0,
    regularFile: false,
  };
  const st = await lstat(path).catch(() => null);
  if (!st) return entry;
  entry.regularFile = st.isFile();
  entry.bytes = st.size;
  const sidecar = await stat(metadataSidecarPath(path)).catch(() => null);
  if (sidecar?.isFile()) entry.sidecarBytes = sidecar.size;
  // A symlink planted under a backup name is never opened: realpath could
  // otherwise walk the read out of the store entirely.
  if (entry.regularFile) {
    try {
      const parsed = await readBoundedJson(metadataSidecarPath(path), MAX_SIDECAR_BYTES);
      const validated = MetadataSidecarSchema.safeParse(parsed);
      if (validated.success) {
        entry.meta = validated.data.meta;
        entry.metadataSource = 'sidecar';
      }
    } catch { /* no usable sidecar */ }
    if (entry.meta === null) {
      const legacy = await readLegacySnapshotMeta(path).catch(() => null);
      if (legacy !== null) {
        entry.meta = legacy;
        entry.metadataSource = 'legacy_prefix';
      }
    }
  }
  entry.created = stringField(entry.meta ?? {}, 'created') ?? st.mtime.toISOString();
  return entry;
}

/** Every backup-*.json in dir, newest-metadata-first in listing order. */
async function readStoreEntries(dir: string): Promise<StoreEntry[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => BACKUP_FILE_RE.test(name));
  } catch {
    return [];
  }
  return Promise.all(names.map((name) => readStoreEntry(dir, name)));
}

export interface PrunedBackup {
  path: string;
  created: string;
  age_days: number;
  bytes: number;
}

export interface PruneResult {
  /** Configured window in days; 0 means pruning is switched off. */
  retention_days: number;
  enabled: boolean;
  removed: PrunedBackup[];
  bytes_freed: number;
  /** Files that could not be deleted, as `path: errno`. */
  failed: string[];
  /** Entries deliberately not judged (unreadable, or not a regular file). */
  skipped: number;
}

function emptyPrune(retentionDays: number): PruneResult {
  return {
    retention_days: retentionDays,
    enabled: retentionDays > 0,
    removed: [],
    bytes_freed: 0,
    failed: [],
    skipped: 0,
  };
}

/**
 * Delete every snapshot older than the retention window and report exactly
 * what went (#697). Only regular files are considered: a symlink or
 * directory wearing a backup name is skipped, never followed, and a file
 * whose date cannot be established is kept rather than guessed at.
 */
export async function pruneStore(
  dir: string,
  entries: readonly StoreEntry[],
  retentionDays: number,
  now: number = Date.now(),
): Promise<PruneResult> {
  const result = emptyPrune(retentionDays);
  if (retentionDays <= 0) return result;
  const cutoff = now - retentionDays * DAY_MS;
  for (const entry of entries) {
    if (!entry.regularFile || entry.created === null) {
      result.skipped += 1;
      continue;
    }
    const createdMs = Date.parse(entry.created);
    if (!Number.isFinite(createdMs) || createdMs >= cutoff) continue;
    try {
      await unlink(entry.path);
      if (entry.sidecarBytes > 0) await unlink(metadataSidecarPath(entry.path)).catch(() => undefined);
      result.removed.push({
        path: entry.path,
        created: entry.created,
        age_days: Math.max(0, Math.floor((now - createdMs) / DAY_MS)),
        bytes: (entry.bytes ?? 0) + entry.sidecarBytes,
      });
    } catch (error) {
      result.failed.push(`${entry.path}: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}`);
    }
  }
  result.bytes_freed = result.removed.reduce((n, r) => n + r.bytes, 0);
  return result;
}

/** One-shot prune for callers that do not already hold the store listing. */
export async function pruneBackups(
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): Promise<PruneResult> {
  const dir = backupDir(env);
  return pruneStore(dir, await readStoreEntries(dir), backupRetentionDays(env), now);
}

export interface StoreEnvelope {
  count: number;
  /** Bytes on disk for these snapshots plus their sidecars. */
  dir_bytes: number;
  oldest_created: string | null;
  oldest_age_days: number | null;
  /** When the oldest survivor falls out of the window. */
  oldest_retention_until: string | null;
}

/** The accumulation envelope: how much is stored and how stale it is. */
export function storeEnvelope(
  entries: readonly StoreEntry[],
  retentionDays: number,
  now: number = Date.now(),
): StoreEnvelope {
  let dirBytes = 0;
  let oldestMs = Number.POSITIVE_INFINITY;
  let oldest: string | null = null;
  for (const entry of entries) {
    dirBytes += (entry.bytes ?? 0) + entry.sidecarBytes;
    if (entry.created === null) continue;
    const ms = Date.parse(entry.created);
    if (!Number.isFinite(ms) || ms >= oldestMs) continue;
    oldestMs = ms;
    oldest = entry.created;
  }
  return {
    count: entries.length,
    dir_bytes: dirBytes,
    oldest_created: oldest,
    oldest_age_days: oldest === null ? null : ageInDays(oldest, now),
    oldest_retention_until: oldest === null ? null : retentionUntil(oldest, retentionDays),
  };
}

/** Prose for the envelope, shared by backup_library and list_backups. */
function describeEnvelope(envelope: StoreEnvelope, retentionDays: number): string {
  const policy = retentionDays > 0
    ? `retention ${retentionDays} day(s) (SPOTIFY_MCP_BACKUP_RETENTION_DAYS)`
    : 'retention disabled (SPOTIFY_MCP_BACKUP_RETENTION_DAYS=0 — snapshots are kept until deleted)';
  const oldest = envelope.oldest_created === null
    ? 'none stored'
    : `oldest ${envelope.oldest_created} (${envelope.oldest_age_days} day(s) old)`;
  return `Store: ${envelope.count} snapshot(s), ${formatBytes(envelope.dir_bytes)} on disk, ${oldest} — ${policy}.`;
}

/** Prose for a prune pass, or null when nothing was removed. */
function describePrune(prune: PruneResult): string | null {
  if (prune.removed.length === 0 && prune.failed.length === 0) return null;
  const lines = [`Pruned ${prune.removed.length} snapshot(s) past the ${prune.retention_days}-day window (freed ${formatBytes(prune.bytes_freed)}):`];
  for (const removed of prune.removed) {
    lines.push(`  - ${removed.path} (created ${removed.created}, ${removed.age_days} day(s) old, ${formatBytes(removed.bytes)})`);
  }
  for (const failure of prune.failed) lines.push(`  ! not deleted: ${failure}`);
  return lines.join('\n');
}

/**
 * One row of the list_backups payload: the snapshot's recorded state plus
 * how much longer it is meant to live. A file whose metadata cannot be read
 * at all is reported as unreadable, never as a clean snapshot.
 */
function storeRecord(entry: StoreEntry, retentionDays: number, now: number) {
  const partialByName = entry.name.endsWith('.partial.json');
  const meta = entry.meta;
  const unreadable = entry.bytes === null;
  const recordedState = stringField(meta ?? {}, 'snapshot_state');
  const snapshotState = partialByName ? 'partial' : recordedState ?? 'unknown';
  const reasons = stringArrayField(meta ?? {}, 'partial_reasons');
  const recordedReason = stringField(meta ?? {}, 'partial_reason');
  return {
    path: entry.path,
    created: entry.created,
    notes: stringField(meta ?? {}, 'notes') ?? null,
    bytes: entry.bytes,
    counts: meta === null ? null : countsField(meta),
    cap: meta === null ? null : (typeof meta.cap === 'number' ? meta.cap : null),
    collections: meta !== null && typeof meta.collections === 'object' && meta.collections !== null
      ? meta.collections
      : null,
    snapshot_state: snapshotState,
    complete: partialByName || unreadable ? false : booleanField(meta ?? {}, 'complete') ?? null,
    partial: partialByName || snapshotState === 'partial',
    partial_reason: partialByName
      ? recordedReason ?? 'unknown'
      : recordedReason ?? (reasons[0] ?? null),
    partial_reasons: partialByName && reasons.length === 0 ? ['unknown'] : reasons,
    metadata_source: entry.metadataSource,
    age_days: entry.created === null ? null : ageInDays(entry.created, now),
    /** When this file falls out of the window, or null when disabled. */
    retention_until: entry.created === null ? null : retentionUntil(entry.created, retentionDays),
  };
}

// ---------------------------------------------------------------------------
// Result shaping
// ---------------------------------------------------------------------------

type ToolOut = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};

/** Emit a tool result: json mode stringifies the payload; twin always attached. */
function shapeResult(rf: ResponseFormatValue, prose: string, payload: Record<string, unknown>): ToolOut {
  return {
    content: [{ type: 'text', text: rf === 'json' ? JSON.stringify(payload, null, 2) : prose }],
    structuredContent: payload,
  };
}

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`;
}

const MAX_SIDECAR_BYTES = 1024 * 1024;
const MAX_LEGACY_META_PREFIX_BYTES = 64 * 1024;

const MetadataRecordSchema = z.record(z.string(), z.unknown());
const MetadataCountsSchema = z.record(z.string(), z.number());
const MetadataSidecarSchema = z.object({ meta: MetadataRecordSchema });

function metadataSidecarPath(snapshotPath: string): string {
  return `${snapshotPath.slice(0, -'.json'.length)}.meta.json`;
}

async function readBoundedJson(path: string, maxBytes: number): Promise<unknown | null> {
  const handle = await open(path, 'r');
  try {
    const file = await handle.stat();
    if (file.size > maxBytes) return null;
    const buffer = Buffer.allocUnsafe(file.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const raw = buffer.subarray(0, bytesRead).toString('utf8');
    try {
      const parsed: unknown = JSON.parse(raw);
      return MetadataRecordSchema.safeParse(parsed).success ? parsed : null;
    } catch {
      return null;
    }
  } finally {
    await handle.close();
  }
}

/** Read only the leading _meta object from a pre-sidecar snapshot. */
async function readLegacySnapshotMeta(path: string): Promise<Record<string, unknown> | null> {
  const handle = await open(path, 'r');
  let prefix: string;
  try {
    const buffer = Buffer.allocUnsafe(MAX_LEGACY_META_PREFIX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    prefix = buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }

  const key = prefix.indexOf('"_meta"');
  if (key < 0) return null;
  const objectStart = prefix.indexOf('{', key);
  if (objectStart < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = objectStart; i < prefix.length; i += 1) {
    const char = prefix[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(prefix.slice(objectStart, i + 1));
          const validated = MetadataRecordSchema.safeParse(parsed);
          return validated.success ? validated.data : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function writeMetadataSidecar(snapshotPath: string, meta: BackupMeta, bytes: number): Promise<void> {
  const body = `${JSON.stringify({ schema_version: 1, snapshot: snapshotPath, bytes, meta }, null, 2)}\n`;
  await writeFile(metadataSidecarPath(snapshotPath), body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function countsField(record: Record<string, unknown>): Record<string, number> | null {
  const value = record.counts;
  const validated = MetadataCountsSchema.safeParse(value);
  return validated.success ? validated.data : null;
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/**
 * delete_backup is opt-OUT of preview (#627): the schema itself advertises
 * the safe default, so a client that inspects the signature — rather than
 * reading the prose — sees that a missing dry_run means "delete nothing".
 */
const DeleteDryRun = DryRun.default(true).describe(
  'Preview only, and the default: pass dry_run: false to delete the snapshot.',
);


// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerBackupTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'backup_library',
    'Snapshot your ENTIRE library to a local JSON file (read-only against Spotify): liked tracks, saved albums/shows/episodes/audiobooks, followed artists, and every playlist with its items. Walks capped at SPOTIFY_MCP_FETCH_ALL_CAP (default 500 per category). Files land in SPOTIFY_MCP_BACKUP_DIR (default ~/.spotify-mcp/backups), mode 0600.',
    {
      notes: z.string().optional().describe('Free-text note stored in the snapshot _meta block'),
      response_format: ResponseFormat,
      max_results: z
        .number()
        .int()
        .positive()
        .max(2000)
        .optional()
        .describe('Per-category walk cap for THIS call (default: SPOTIFY_MCP_FETCH_ALL_CAP)'),
      dry_run: DryRun,
    },
    async (args) => {
      const cap = args.max_results ?? getConfig().fetchAllCap;
      if (args.dry_run) {
        const perCatPages = Math.ceil(cap / 50);
        const wouldWalk = {
          tracks: cap,
          albums: cap,
          shows: cap,
          episodes: cap,
          audiobooks: cap,
          followed_artists: cap,
          playlists: cap,
          playlist_items_cap: Math.min(cap, PLAYLIST_ITEMS_CAP),
        };
        const categories = 7;
        const estimatedRequests = categories * perCatPages + 10; // ~10 playlist item walks extra, rough
        const lines = [
          `[dry run] backup_library would walk ${categories} categories (tracks, albums, shows, episodes, audiobooks, followed_artists, playlists) capped at ${cap} per category (~${perCatPages} page(s) each at limit 50).`,
          `Plus per-playlist item walks: up to ~10 playlists × ~${Math.ceil(Math.min(cap, PLAYLIST_ITEMS_CAP) / 100)} page(s) each.`,
          `Estimated: ~${estimatedRequests}+ requests (varies with actual playlist count).`,
        ];
        const payload: Record<string, unknown> = {
          dry_run: true,
          would_walk: wouldWalk,
          per_category_pages: perCatPages,
          estimated_requests: estimatedRequests,
          cap,
        };
        const prose = lines.join('\n');
        if (args.response_format === 'json') return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
        return shapeResult(args.response_format, prose, payload);
      }

      // Retention first (#697): an unbounded store is the thing being fixed,
      // so every run expires what it can BEFORE adding another snapshot.
      const prune = await pruneBackups();
      let detailed: DetailedSnapshot;
      try {
        detailed = await collectSnapshotDetailed(client, cap);
      } catch (e) {
        if (e instanceof SpotifyApiError && e.status === 429) {
          const quotaHit = { retry_after: e.retryAfterSec ?? null };
          const partialBody: SnapshotBody = {
            liked_tracks: [],
            saved_albums: [],
            saved_shows: [],
            saved_episodes: [],
            saved_audiobooks: [],
            followed_artists: [],
            playlists: [],
          };
          const emptyStatus = (): BackupCollectionStatus => ({ fetched: 0, cap, complete: false, truncated: false });
          const partialDetailed: DetailedSnapshot = {
            body: partialBody,
            collections: {
              liked_tracks: emptyStatus(),
              saved_albums: emptyStatus(),
              saved_shows: emptyStatus(),
              saved_episodes: emptyStatus(),
              saved_audiobooks: emptyStatus(),
              followed_artists: emptyStatus(),
              playlists: emptyStatus(),
            },
            playlistItems: {
              fetched: 0,
              cap_per_playlist: Math.min(cap, PLAYLIST_ITEMS_CAP),
              truncated: false,
              truncated_playlists: 0,
            },
            partialReasons: [],
            reportedTotals: {
              liked_tracks: null,
              saved_albums: null,
              saved_shows: null,
              saved_episodes: null,
              saved_audiobooks: null,
              followed_artists: null,
              playlists: null,
            },
          };
          const created = new Date().toISOString();
          const snapshot: LibraryBackup = {
            schema_version: LIBRARY_BACKUP_SCHEMA_VERSION,
            _meta: buildMeta(created, partialDetailed, args.notes, 'quota_exceeded'),
            ...partialBody,
          };
          let file: string | null = null;
          try {
            const dir = backupDir();
            await mkdir(dir, { recursive: true, mode: 0o700 });
            const dateStamp = created.slice(0, 10);
            const seq = await nextBackupSeq(dir, dateStamp);
            file = join(dir, `backup-${dateStamp}-${seq}.partial.json`);
            const body = `${JSON.stringify({ ...snapshot, _partial: true, quota_hit: true, retry_after: quotaHit.retry_after }, null, 2)}\n`;
            await writeFile(file, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            await writeMetadataSidecar(file, snapshot._meta, Buffer.byteLength(body));
          } catch { /* best-effort local failure */ }
          const payload: Record<string, unknown> = {
            ok: false,
            quota_hit: true,
            retry_after: quotaHit.retry_after,
            file,
            counts: snapshot._meta.counts,
            cap,
            collections: snapshot._meta.collections,
            snapshot_state: 'partial',
            complete: false,
            partial: true,
            partial_reason: 'quota_exceeded',
            retention_days: prune.retention_days,
            pruned: prune.removed,
            bytes_freed: prune.bytes_freed,
          };
          const prose = `Quota hit during backup_library (Retry-After: ${quotaHit.retry_after ?? 'unknown'}s) — partial snapshot${file ? ` written to ${file}` : ' (no file)'} . Retry later or lower max_results.`;
          return shapeResult(args.response_format, prose, payload);
        }
        throw e;
      }

      const created = new Date().toISOString();
      const snapshot: LibraryBackup = {
        schema_version: LIBRARY_BACKUP_SCHEMA_VERSION,
        _meta: buildMeta(created, detailed, args.notes),
        ...detailed.body,
      };

      const dir = backupDir();
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const dateStamp = created.slice(0, 10);
      const seq = await nextBackupSeq(dir, dateStamp);
      const file = join(dir, `backup-${dateStamp}-${seq}.json`);
      // A partial snapshot says so at the top level too (#735), so a
      // consumer that never looks inside _meta cannot mistake it for
      // complete truth.
      const fileBody = snapshot._meta.complete ? snapshot : { ...snapshot, _partial: true };
      const body = `${JSON.stringify(fileBody, null, 2)}\n`;
      const bytes = Buffer.byteLength(body);
      // 'wx' refuses to clobber even if sequencing raced another writer.
      await writeFile(file, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await writeMetadataSidecar(file, snapshot._meta, bytes);
      // The envelope is read back from the store, not from this call's
      // bookkeeping: what the operator can actually delete is what is
      // reported.
      const envelope = storeEnvelope(await readStoreEntries(dir), prune.retention_days);
      const retentionWarning = envelope.count >= PRUNE_HINT_THRESHOLD
        ? `${envelope.count} snapshots are stored (oldest ${envelope.oldest_age_days} day(s) old, ${formatBytes(envelope.dir_bytes)} on disk) — set SPOTIFY_MCP_BACKUP_RETENTION_DAYS or call delete_backup to prune.`
        : undefined;
      const pruneNote = describePrune(prune);

      const c = snapshot._meta.counts;
      const payload: Record<string, unknown> = {
        ok: true,
        file,
        bytes,
        counts: c,
        cap,
        caps: snapshot._meta.caps,
        collections: snapshot._meta.collections,
        playlist_items: snapshot._meta.playlist_items,
        snapshot_state: snapshot._meta.snapshot_state,
        complete: snapshot._meta.complete,
        partial: !snapshot._meta.complete,
        reported_totals: snapshot._meta.reported_totals,
        retention_days: prune.retention_days,
        retention_until: snapshot._meta.retention_until,
        pruned: prune.removed,
        pruned_count: prune.removed.length,
        bytes_freed: prune.bytes_freed,
        store: envelope,
        ...(retentionWarning !== undefined ? { retention_warning: retentionWarning } : {}),
        ...(snapshot._meta.partial_reason !== undefined ? { partial_reason: snapshot._meta.partial_reason } : {}),
        ...(args.notes !== undefined ? { notes: args.notes } : {}),
      };
      if (args.response_format === 'json') {
        return {
          content: [{ type: 'text', text: JSON.stringify(fileBody, null, 2) }],
          structuredContent: payload,
        };
      }
      const truncatedPlaylists = detailed.body.playlists.filter((playlist) => playlist.items_truncated);
      const truncationLines = truncatedPlaylists.map(
        (playlist) =>
          `\n- Truncated playlist "${playlist.name}" (${playlist.uri}): ${completenessFooter({
            fetched: playlist.items.length,
            cap: detailed.playlistItems.cap_per_playlist,
            truncated: true,
            subject: 'items',
            total: playlist.item_count,
          })}`,
      );
      // A playlist that could not be read is stored as an empty one, so it
      // is named here: silence is what let restore create "Restored - X"
      // with zero tracks and report success (#735).
      const unreadablePlaylists = detailed.body.playlists.filter((playlist) => playlist.items_error !== undefined);
      const unreadableLines = unreadablePlaylists.map(
        (playlist) =>
          `\n- WARNING unreadable playlist "${playlist.name}" (${playlist.uri}): stored with ${playlist.items.length} items — ${playlist.items_error}`,
      );
      // Category walks that stopped at the cap get the same disclosure
      // vocabulary, with Spotify's own total as the denominator (#735).
      const cappedLines = (Object.entries(snapshot._meta.collections) as [BackupCollectionName, BackupCollectionStatus][])
        .filter(([, status]) => status.truncated || !status.complete)
        .map(([name, status]) =>
          `\n- WARNING incomplete ${COLLECTION_SUBJECTS[name]}: ${completenessFooter({
            fetched: status.fetched,
            cap: status.cap,
            truncated: true,
            subject: COLLECTION_SUBJECTS[name],
            total: snapshot._meta.reported_totals[name] ?? undefined,
          })}`,
        );
      const prose =
        `Library ${snapshot._meta.complete ? 'backup' : 'partial backup'} written → ${file} (${formatBytes(bytes)})\n` +
        `- Liked tracks: ${c.liked_tracks}\n` +
        `- Saved albums: ${c.saved_albums}\n` +
        `- Saved shows: ${c.saved_shows}\n` +
        `- Saved episodes: ${c.saved_episodes}\n` +
        `- Saved audiobooks: ${c.saved_audiobooks}\n` +
        `- Followed artists: ${c.followed_artists}\n` +
        `- Playlists: ${c.playlists} (${c.playlist_items} items; ${c.playlists_truncated} truncated${unreadablePlaylists.length > 0 ? `; ${unreadablePlaylists.length} unreadable` : ''})\n` +
        cappedLines.join('') +
        truncationLines.join('') +
        unreadableLines.join('') +
        `\n${describeEnvelope(envelope, prune.retention_days)}` +
        (snapshot._meta.retention_until !== null ? `\nRetention: this snapshot expires ${snapshot._meta.retention_until} unless deleted sooner.` : '') +
        (pruneNote !== null ? `\n${pruneNote}` : '') +
        (retentionWarning !== undefined ? `\nWARNING ${retentionWarning}` : '') +
        (snapshot._meta.partial_reason ? `\n- Incomplete: ${snapshot._meta.partial_reason}` : '');
      return shapeResult(args.response_format, prose, payload);
    },
  );

  server.tool(
    'list_backups',
    'List complete and partial library backups (newest first) using bounded metadata sidecar reads, with a bounded prefix fallback for legacy snapshots. Expires snapshots past SPOTIFY_MCP_BACKUP_RETENTION_DAYS (default 30, 0 disables) and reports what it removed, plus the store envelope (dir_bytes, oldest_created, retention_until).',
    { response_format: ResponseFormat },
    async (args) => {
      const dir = backupDir();
      const retentionDays = backupRetentionDays();
      const now = Date.now();
      const entries = await readStoreEntries(dir);
      // Retention runs on the read path too (#697): an operator asking
      // "what is stored" must not be shown a year-old snapshot forever.
      const prune = await pruneStore(dir, entries, retentionDays, now);
      const removed = new Set(prune.removed.map((entry) => entry.path));
      const survivors = entries.filter((entry) => !removed.has(entry.path));
      const envelope = storeEnvelope(survivors, retentionDays, now);
      const envelopeFields: Record<string, unknown> = {
        ok: true,
        dir,
        count: survivors.length,
        dir_bytes: envelope.dir_bytes,
        oldest_created: envelope.oldest_created,
        oldest_age_days: envelope.oldest_age_days,
        retention_days: retentionDays,
        retention_enabled: prune.enabled,
        oldest_retention_until: envelope.oldest_retention_until,
        pruned: prune.removed,
        pruned_count: prune.removed.length,
        bytes_freed: prune.bytes_freed,
        ...(envelope.count >= PRUNE_HINT_THRESHOLD
          ? {
            retention_warning: `${envelope.count} snapshots are stored (oldest ${envelope.oldest_age_days} day(s) old, ${formatBytes(envelope.dir_bytes)} on disk) — set SPOTIFY_MCP_BACKUP_RETENTION_DAYS or call delete_backup to prune.`,
          }
          : {}),
      };

      const pruneNote = describePrune(prune);
      if (survivors.length === 0) {
        return shapeResult(
          args.response_format,
          [
            `No backups found in ${dir}. Run backup_library first.`,
            describeEnvelope(envelope, retentionDays),
            ...(pruneNote === null ? [] : [pruneNote]),
          ].join('\n'),
          { ...envelopeFields, backups: [] },
        );
      }

      const backups = survivors
        .map((entry) => storeRecord(entry, retentionDays, now))
        .sort((a, b) => {
          const ta = a.created ? Date.parse(a.created) : Number.NEGATIVE_INFINITY;
          const tb = b.created ? Date.parse(b.created) : Number.NEGATIVE_INFINITY;
          return tb - ta || b.path.localeCompare(a.path);
        });

      const lines = [`Backups in ${dir} (newest first):`];
      for (const b of backups) {
        const bits = [
          b.created ?? 'unknown date',
          b.bytes !== null ? formatBytes(b.bytes) : 'unreadable',
          b.partial ? `PARTIAL: ${b.partial_reason ?? 'unknown reason'}` : b.snapshot_state,
        ];
        if (b.notes) bits.push(`notes: "${b.notes}"`);
        if (b.counts) {
          bits.push(
            `tracks ${b.counts.liked_tracks}, playlists ${b.counts.playlists}` +
              ` (${b.counts.playlist_items} items), artists ${b.counts.followed_artists}`,
          );
        }
        if (b.retention_until !== null) bits.push(`expires ${b.retention_until}`);
        lines.push(`- ${b.path} — ${bits.join(' · ')}`);
      }
      if (pruneNote !== null) lines.push(pruneNote);
      lines.push(describeEnvelope(envelope, retentionDays));
      if (envelope.count >= PRUNE_HINT_THRESHOLD) {
        lines.push(
          `WARNING ${envelope.count} snapshots are stored (oldest ${envelope.oldest_age_days} day(s) old) — set SPOTIFY_MCP_BACKUP_RETENTION_DAYS or call delete_backup to prune.`,
        );
      }

      return shapeResult(args.response_format, lines.join('\n'), { ...envelopeFields, backups });
    },
  );

  server.tool(
    'delete_backup',
    'Delete one library backup file (and its metadata sidecar) from SPOTIFY_MCP_BACKUP_DIR. Irreversible — the library rows in the file cannot be recovered from anywhere else. Destructive and confirmation-gated: dry_run defaults to true, and executing is refused when the client cannot prompt (SPOTIFY_MCP_CONFIRM=never bypasses). Paths outside the backup directory are refused.',
    {
      file: z.string().min(1).describe('Backup file name (e.g. backup-2026-01-02-1.json) or a path inside the backup directory'),
      response_format: ResponseFormat,
      dry_run: DeleteDryRun,
    },
    async (args) => {
      const dir = backupDir();
      const requested = args.file.trim();
      // Confinement is decided on the REAL path by the shared resolver: a
      // `..` segment, an absolute path elsewhere, or a symlink planted
      // under a backup name all resolve first and are refused outside the
      // store (#622/#697).
      let resolved: { file: string };
      try {
        resolved = await resolveOutputPath({
          root: dir,
          target: requested,
          tool: 'delete_backup',
          kind: 'file',
          overwrite: true,
        });
      } catch (error) {
        // The shared resolver's own wording is about writing exports; the
        // leading sentence says what the caller actually asked for, and the
        // resolver's line stays as the reason.
        const detail = error instanceof Error ? error.message : String(error);
        const message = `delete_backup: "${requested}" is not inside the backup directory (${dir}); nothing was deleted. ${detail}`;
        return shapeResult(
          args.response_format,
          message,
          { ok: false, reason: 'refused', dir, requested, error: message, detail },
        );
      }
      const name = basename(resolved.file);
      if (!BACKUP_FILE_RE.test(name)) {
        const message = `delete_backup: "${name}" is not a library backup file (expected backup-YYYY-MM-DD-N[.partial].json).`;
        return shapeResult(
          args.response_format,
          message,
          { ok: false, reason: 'not_a_backup', dir, path: resolved.file, error: message },
        );
      }
      const st = await stat(resolved.file).catch(() => null);
      if (!st?.isFile()) {
        const message = `delete_backup: no readable backup file at "${resolved.file}".`;
        return shapeResult(
          args.response_format,
          message,
          { ok: false, reason: 'not_found', dir, path: resolved.file, error: message },
        );
      }
      const sidecarPath = metadataSidecarPath(resolved.file);
      const sidecar = await stat(sidecarPath).catch(() => null);
      const sidecarBytes = sidecar?.isFile() ? sidecar.size : 0;
      const changes = [
        `Delete ${resolved.file} (${formatBytes(st.size)}) permanently — those library rows exist nowhere else`,
        ...(sidecarBytes > 0 ? [`Delete its metadata sidecar (${formatBytes(sidecarBytes)})`] : []),
      ];

      if (args.dry_run !== false) {
        const payload: Record<string, unknown> = {
          ok: true,
          dry_run: true,
          dir,
          path: resolved.file,
          bytes: st.size,
          sidecar: sidecarBytes > 0 ? sidecarPath : null,
          sidecar_bytes: sidecarBytes,
          retention_days: backupRetentionDays(),
        };
        return shapeResult(args.response_format, `${describeDryRun('delete backup', name, changes)}\nRe-run with dry_run: false to delete.`, payload);
      }

      const verdict = await confirmViaElicitation(server, {
        message: describeConfirmation('delete backup', name, changes),
        confirmLabel: 'Delete backup',
      });
      const refusal = requiredConfirmationRefusal(verdict);
      if (refusal) return shapeResult(args.response_format, refusal.message, refusal.payload);

      try {
        await unlink(resolved.file);
      } catch (error) {
        const message = `delete_backup: could not delete "${resolved.file}": ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}.`;
        return shapeResult(args.response_format, message, { ok: false, reason: 'delete_failed', dir, path: resolved.file, error: message });
      }
      let sidecarDeleted = false;
      if (sidecarBytes > 0) {
        try {
          await unlink(sidecarPath);
          sidecarDeleted = true;
        } catch {
          sidecarDeleted = false;
        }
      }
      return shapeResult(
        args.response_format,
        `Deleted backup ${resolved.file} (${formatBytes(st.size)})${sidecarDeleted ? ' and its metadata sidecar' : ''}. ${describeEnvelope(storeEnvelope(await readStoreEntries(dir), backupRetentionDays()), backupRetentionDays())}`,
        {
          ok: true,
          deleted: true,
          dry_run: false,
          dir,
          path: resolved.file,
          bytes: st.size,
          sidecar_deleted: sidecarDeleted,
          retention_days: backupRetentionDays(),
        },
      );
    },
  );
}
