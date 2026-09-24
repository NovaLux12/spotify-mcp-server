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
 * Every walk is capped at getConfig().fetchAllCap (SPOTIFY_MCP_FETCH_ALL_CAP,
 * default 500); an explicit max_results argument overrides it for this call.
 */
import { z } from 'zod';
import { mkdir, open, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { getConfig } from '../config.js';
import { ResponseFormat, DryRun, completenessFooter, type ResponseFormatValue } from '../shaping.js';
import { SpotifyApiError } from '../client.js';
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

/** Cheap top-level block mirrored to an owner-only sidecar for list_backups. */
export interface BackupMeta {
  created: string;
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
 * Top-level keys of a backup-*.json file. Order matters only cosmetically;
 * consumers MUST treat unknown keys as forward-compatible additions.
 */
export interface LibraryBackup {
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
  return { rows: out, complete, truncated };
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
  return { rows, complete: walked.complete, truncated: walked.truncated };
}

/** Cursor-walk followed artists, retaining the API's end-of-data signal. */
async function walkFollowedArtists(client: SpotifyClient, cap: number): Promise<WalkResult<BackupArtistRow>> {
  const out: BackupArtistRow[] = [];
  let after: string | undefined;
  let complete = false;
  let truncated = false;
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
  return { rows: out, complete, truncated };
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
  return { rows: out, complete, truncated };
}

type SnapshotBody = Omit<LibraryBackup, '_meta'>;
interface DetailedSnapshot {
  body: SnapshotBody;
  collections: BackupMeta['collections'];
  playlistItems: BackupMeta['playlist_items'];
  partialReasons: string[];
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
          };
          const created = new Date().toISOString();
          const snapshot: LibraryBackup = {
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
          };
          const prose = `Quota hit during backup_library (Retry-After: ${quotaHit.retry_after ?? 'unknown'}s) — partial snapshot${file ? ` written to ${file}` : ' (no file)'} . Retry later or lower max_results.`;
          return shapeResult(args.response_format, prose, payload);
        }
        throw e;
      }

      const created = new Date().toISOString();
      const snapshot: LibraryBackup = {
        _meta: buildMeta(created, detailed, args.notes),
        ...detailed.body,
      };

      const dir = backupDir();
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const dateStamp = created.slice(0, 10);
      const seq = await nextBackupSeq(dir, dateStamp);
      const file = join(dir, `backup-${dateStamp}-${seq}.json`);
      const body = `${JSON.stringify(snapshot, null, 2)}\n`;
      const bytes = Buffer.byteLength(body);
      // 'wx' refuses to clobber even if sequencing raced another writer.
      await writeFile(file, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await writeMetadataSidecar(file, snapshot._meta, bytes);

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
        ...(snapshot._meta.partial_reason !== undefined ? { partial_reason: snapshot._meta.partial_reason } : {}),
        ...(args.notes !== undefined ? { notes: args.notes } : {}),
      };
      if (args.response_format === 'json') {
        return {
          content: [{ type: 'text', text: JSON.stringify(snapshot, null, 2) }],
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
      const prose =
        `Library ${snapshot._meta.complete ? 'backup' : 'partial backup'} written → ${file} (${formatBytes(bytes)})\n` +
        `- Liked tracks: ${c.liked_tracks}\n` +
        `- Saved albums: ${c.saved_albums}\n` +
        `- Saved shows: ${c.saved_shows}\n` +
        `- Saved episodes: ${c.saved_episodes}\n` +
        `- Saved audiobooks: ${c.saved_audiobooks}\n` +
        `- Followed artists: ${c.followed_artists}\n` +
        `- Playlists: ${c.playlists} (${c.playlist_items} items; ${c.playlists_truncated} truncated)\n` +
        truncationLines.join('') +
        (snapshot._meta.partial_reason ? `\n- Incomplete: ${snapshot._meta.partial_reason}` : '');
      return shapeResult(args.response_format, prose, payload);
    },
  );

  server.tool(
    'list_backups',
    'List complete and partial library backups (newest first) using bounded metadata sidecar reads, with a bounded prefix fallback for legacy snapshots',
    { response_format: ResponseFormat },
    async (args) => {
      const dir = backupDir();
      let names: string[] = [];
      try {
        names = (await readdir(dir)).filter((name) => BACKUP_FILE_RE.test(name));
      } catch {
        names = [];
      }

      if (names.length === 0) {
        return shapeResult(
          args.response_format,
          `No backups found in ${dir}. Run backup_library first.`,
          { ok: true, dir, backups: [] },
        );
      }

      const backups = (
        await Promise.all(
          names.map(async (name) => {
            const path = join(dir, name);
            const partialByName = name.endsWith('.partial.json');
            try {
              const st = await stat(path);
              let meta: Record<string, unknown> | null = null;
              let metadataSource = 'unavailable';
              try {
                const sidecar = await readBoundedJson(metadataSidecarPath(path), MAX_SIDECAR_BYTES);
                const validated = MetadataSidecarSchema.safeParse(sidecar);
                if (validated.success) {
                  meta = validated.data.meta;
                  metadataSource = 'sidecar';
                }
              } catch { /* no usable sidecar */ }
              if (meta === null) {
                meta = await readLegacySnapshotMeta(path);
                if (meta !== null) metadataSource = 'legacy_prefix';
              }

              const created = stringField(meta ?? {}, 'created') ?? st.mtime.toISOString();
              const notes = stringField(meta ?? {}, 'notes');
              const recordedState = stringField(meta ?? {}, 'snapshot_state');
              const snapshotState = partialByName ? 'partial' : recordedState ?? 'unknown';
              const complete = partialByName ? false : booleanField(meta ?? {}, 'complete') ?? null;
              const reasons = stringArrayField(meta ?? {}, 'partial_reasons');
              const recordedReason = stringField(meta ?? {}, 'partial_reason');
              return {
                path,
                created,
                notes: notes ?? null,
                bytes: st.size,
                counts: meta === null ? null : countsField(meta),
                cap: meta === null ? null : (typeof meta.cap === 'number' ? meta.cap : null),
                collections: meta !== null && typeof meta.collections === 'object' && meta.collections !== null
                  ? meta.collections
                  : null,
                snapshot_state: snapshotState,
                complete,
                partial: partialByName || snapshotState === 'partial',
                partial_reason: partialByName
                  ? recordedReason ?? 'unknown'
                  : recordedReason ?? (reasons[0] ?? null),
                partial_reasons: partialByName && reasons.length === 0 ? ['unknown'] : reasons,
                metadata_source: metadataSource,
              };
            } catch {
              return {
                path,
                created: null,
                bytes: null,
                counts: null,
                cap: null,
                collections: null,
                notes: null,
                snapshot_state: partialByName ? 'partial' : 'unknown',
                complete: false,
                partial: partialByName,
                partial_reason: partialByName ? 'unknown' : null,
                partial_reasons: partialByName ? ['unknown'] : [],
                metadata_source: 'unavailable',
              };
            }
          }),
        )
      ).sort((a, b) => {
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
        lines.push(`- ${b.path} — ${bits.join(' · ')}`);
      }

      return shapeResult(args.response_format, lines.join('\n'), {
        ok: true,
        dir,
        count: backups.length,
        backups,
      });
    },
  );
}
