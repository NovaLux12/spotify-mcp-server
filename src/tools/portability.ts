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
import { CHUNK_CAPS, capFor } from '../chunk.js';
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
import {
  DEFAULT_HISTORY_READ_LIMIT,
  HISTORY_DIR_MODE,
  HISTORY_FILE_MODE,
  historyFilePath,
  isHistoryEnabled,
  readHistory,
} from '../history.js';
import type { HistoryRecord } from '../history.js';
import { backupDir, readBackupStore } from './backup.js';
import { artistWatchlistPath } from './artistwatch.js';

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
// #754: history_search reads three stores, not one. Each store reports how its
// read ENDED: a store that could not be read is 'unreadable' with a null
// total, never an empty listing. A store that does not exist is 'absent',
// which genuinely holds nothing.
// ---------------------------------------------------------------------------

/** Which store a hit came from; also the `scope` filter's vocabulary. */
const HISTORY_SEARCH_SCOPES = ['portability', 'backups', 'history', 'all'] as const;
type HistorySearchScope = (typeof HISTORY_SEARCH_SCOPES)[number];

type StoreState = 'ok' | 'absent' | 'unreadable' | 'skipped';

/** Hits returned before the response is truncated; the rest are disclosed. */
const HISTORY_SEARCH_HIT_CAP = 50;

/** The ledger fields a query is matched against, and the only ones echoed back. */
const HISTORY_RECORD_FIELDS = ['ts', 'who', 'method', 'path', 'target', 'snapshot_id'] as const;

interface StoreSummary {
  /** How the read ended; 'skipped' means the scope filter excluded it. */
  state: StoreState;
  /** Candidates examined, or null when the store could not be read. */
  total: number | null;
  /** Candidates matching the query; 0 whenever the store yielded no candidates. */
  matched: number;
}

/** Enumerate a directory, separating "nothing there" from "cannot tell". */
async function listStore(dir: string): Promise<{ state: StoreState; names: string[] | null }> {
  try {
    return { state: 'ok', names: await readdir(dir) };
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'absent', names: [] }
      : { state: 'unreadable', names: null };
  }
}

function historyRecordMatches(record: HistoryRecord, q: string): boolean {
  return HISTORY_RECORD_FIELDS.some((field) => {
    const value = record[field];
    return typeof value === 'string' && value.toLowerCase().includes(q);
  });
}

/** Echo only the whitelisted ledger fields: the file is a flat JSONL a user can hand-edit. */
function historyRecordHit(record: HistoryRecord): Record<string, unknown> {
  const hit: Record<string, unknown> = { source: 'history' };
  for (const field of HISTORY_RECORD_FIELDS) {
    const value = record[field];
    if (typeof value === 'string') hit[field] = value;
  }
  return hit;
}

const skippedStore = (): StoreSummary => ({ state: 'skipped', total: null, matched: 0 });


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

// ---------------------------------------------------------------------------
// #753: the archive is the ONE playlist this tool writes into, so it is
// resolved by owner AND name, over a walk whose completeness is known.
// ---------------------------------------------------------------------------

/** Owner as the walk reported it. `id: null` means the row named no owner. */
type ArchiveOwner = { id: string | null; display_name: string | null };

/**
 * Why no archive could be resolved. Every one of these is a refusal: the
 * handler returns before any POST/PUT/DELETE, so a followed playlist of the
 * same name is never written into and a capped walk never creates a duplicate.
 */
type ArchiveRefusal =
  | 'archive_not_owned'
  | 'archive_owner_unknown'
  | 'archive_scan_incomplete';

type ArchiveTarget =
  /** An owned playlist of that name exists; this is what gets PUT into. */
  | {
      status: 'resolved';
      id: string;
      uri: string;
      owner: ArchiveOwner;
      scanned: number;
      truncated: boolean;
      same_name: number;
    }
  /** No playlist of that name exists and the whole list was read: create one. */
  | { status: 'create'; scanned: number }
  | {
      status: 'refused';
      error: ArchiveRefusal;
      /** Actionable sentence; reused verbatim as the tool's `hint`. */
      message: string;
      scanned: number;
      truncated: boolean;
      same_name: number;
      cap: number;
      owner: ArchiveOwner | null;
    };

/**
 * Resolve the archive playlist `save_discover_weekly` / `save_release_radar`
 * will write into.
 *
 * A name match alone is not a target. `/me/playlists` also returns playlists
 * the user only FOLLOWS, and the first row that happened to match was then
 * PUT-replaced (#753) — a 403 for a read-only collaborator, or a real
 * overwrite of someone else's playlist for a collaborator with edit rights.
 * Ownership is therefore required, and the walk's truncation verdict decides
 * what a MISS means: a complete walk proves the archive does not exist, while
 * a capped walk only proves it was not in the rows read, and creating there
 * splits the archive across two playlists while reporting success.
 */
async function resolveArchivePlaylist(
  client: SpotifyClient,
  archiveName: string,
): Promise<ArchiveTarget> {
  const cap = getConfig().fetchAllCap;
  // The bound is stated rather than inherited, because the verdict below is
  // the only thing that tells "missing" apart from "unread".
  const walk = await client.getAllPagesWithTruncation<SpotifyPlaylistSimple>(
    '/me/playlists',
    { limit: '50' },
    { maxItems: cap },
  );
  const scanned = walk.items.length;
  const truncated = walk.truncated;
  const want = archiveName.toLowerCase();
  const sameName = walk.items.filter((p) => p?.name?.toLowerCase() === want);
  const ownerOf = (p: SpotifyPlaylistSimple): ArchiveOwner => ({
    id: typeof p.owner?.id === 'string' && p.owner.id ? p.owner.id : null,
    display_name: p.owner?.display_name ?? null,
  });

  if (sameName.length === 0) {
    if (truncated) {
      return {
        status: 'refused',
        error: 'archive_scan_incomplete',
        scanned,
        truncated,
        same_name: 0,
        cap,
        owner: null,
        message:
          `Could not scan your full playlist list: the /me/playlists walk stopped at ${scanned} playlist(s) (cap ${cap}),`
          + ` so an existing "${archiveName}" archive past that point cannot be ruled out —`
          + ' refusing to create a second playlist with the same name.'
          + ` Raise SPOTIFY_MCP_FETCH_ALL_CAP above ${cap} and retry, or pass a different archive_name.`,
      };
    }
    return { status: 'create', scanned };
  }

  // `/me` is fetched only once a same-name row exists: it is the only thing
  // that separates "mine" from "someone else's", and a clean miss needs no
  // ownership verdict. A failed read is NOT read as "nobody owns it" — the
  // row is then unclassifiable, so no playlist may be written into.
  let myId: string | null = null;
  try {
    const me = await client.get<{ id?: string }>('/me');
    if (typeof me?.id === 'string' && me.id) myId = me.id;
  } catch {
    myId = null;
  }

  const mine = myId === null ? [] : sameName.filter((p) => ownerOf(p).id === myId);
  if (mine.length === 0) {
    const other = ownerOf(sameName[0]);
    const who = other.display_name ?? other.id ?? 'an owner the API did not name';
    const unknown = myId === null;
    return {
      status: 'refused',
      error: unknown ? 'archive_owner_unknown' : 'archive_not_owned',
      scanned,
      truncated,
      same_name: sameName.length,
      cap,
      owner: other,
      message: unknown
        ? `Found "${archiveName}" in your playlists but could not read your own user id (GET /me),`
          + ` so its ownership could not be verified — refusing to write into an unverified playlist.`
          + ' Retry the call, or pass a different archive_name.'
        : `Found "${archiveName}" owned by ${who}, not by you — refusing to write into it.`
          + ' Pass a different archive_name, or point archive_name at the copy you own.',
    };
  }

  const target = mine[0];
  return {
    status: 'resolved',
    id: target.id,
    uri: target.uri ?? `spotify:playlist:${target.id}`,
    owner: ownerOf(target),
    scanned,
    truncated,
    same_name: sameName.length,
  };
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

  // #753: the archive is resolved BEFORE the dry_run branch, so a preview
  // names the playlist that would really be written and refuses exactly when
  // the real call would. Nothing below this point can reach a playlist the
  // user does not own.
  const target = await resolveArchivePlaylist(client, args.archiveName);
  if (target.status === 'refused') {
    const payload = {
      ok: false as const,
      error: target.error,
      ...sourceIdentity,
      archive: args.archiveName,
      archives_scanned: target.scanned,
      archive_scan_truncated: target.truncated,
      same_name_playlists: target.same_name,
      archive_owner: target.owner,
      hint: target.message,
    };
    return shapeResult(rf, target.message, payload as unknown as Record<string, unknown>);
  }

  // What a write into the resolved archive would destroy. The old code read
  // these rows and threw the count away, then PUT-replaced them in silence.
  let existingUris: string[] = [];
  if (target.status === 'resolved') {
    const existing = await client.getAllPages<PlaylistItemObject>(`/playlists/${encodeURIComponent(target.id)}/items`, { limit: '100' });
    existingUris = existing.map((r) => r?.item?.uri).filter((u): u is string => typeof u === 'string');
  }
  const scan = {
    archives_scanned: target.scanned,
    ...(target.status === 'create' ? {} : { archive_scan_truncated: target.truncated, same_name_playlists: target.same_name }),
  };

  if (args.dry_run) {
    const planned = target.status === 'create'
      ? { ...scan, archive_id: null, archive_uri: null, archive_action: 'create' as const, would_archive: uris.length, would_replace: 0, uris }
      : { ...scan, archive_id: target.id, archive_uri: target.uri, archive_action: 'replace' as const, archive_owner: target.owner, would_archive: uris.length, would_replace: existingUris.length, uris };
    const effect = target.status === 'create'
      ? `Would create "${args.archiveName}"`
      : `Would replace ${existingUris.length} existing item(s) in "${args.archiveName}" (ID: ${target.id})`;
    const preview = describeDryRun(`save ${args.sourceName}`, args.archiveName, [`${effect} with ${uris.length} track(s) from "${args.sourceName}"`, ...uris.slice(0, 5)]) + (uris.length > 5 ? `\n  …and ${uris.length - 5} more` : '');
    const unverifiedNote = resolved.verified ? '' : `\n[unverified source — resolved via search as ${resolved.name} by ${resolved.owner?.id ?? 'unknown owner'}; verify before archiving]`;
    return shapeResult(rf, preview + unverifiedNote, { ok: true, dry_run: true, ...sourceIdentity, archive: args.archiveName, ...planned });
  }

  if (target.status === 'resolved') {
    const same = existingUris.length === uris.length && existingUris.every((u, i) => u === uris[i]);
    if (same) {
      return shapeResult(rf, `Archive "${args.archiveName}" already up to date (${uris.length} items) — nothing to do.`, { ok: true, ...sourceIdentity, archive: args.archiveName, ...scan, archive_id: target.id, archive_uri: target.uri, archive_action: 'replace' as const, archive_owner: target.owner, archived: 0, replaced: 0, idempotent: true, uris });
    }
  }

  let archiveId: string;
  let archiveUri: string;
  let created = false;
  if (target.status === 'resolved') {
    archiveId = target.id;
    archiveUri = target.uri;
  } else {
    const made = await client.post<{ id: string; uri?: string }>(
      '/me/playlists',
      { name: args.archiveName, public: false, description: `Archive of ${args.sourceName} — auto-created` },
    );
    if (!made?.id) throw new Error(`Could not create archive playlist "${args.archiveName}"`);
    archiveId = made.id;
    archiveUri = made.uri ?? `spotify:playlist:${made.id}`;
    created = true;
  }

  let snapshotId: string | undefined;
  const writeCap = capFor('playlist_writes');
  for (let start = 0; start < uris.length; start += writeCap) {
    const chunk = uris.slice(start, start + writeCap);
    const res =
      start === 0
        ? await client.put<{ snapshot_id?: string }>(`/playlists/${encodeURIComponent(archiveId)}/items`, { uris: chunk })
        : await client.post<{ snapshot_id?: string }>(`/playlists/${encodeURIComponent(archiveId)}/items`, { uris: chunk });
    if (res?.snapshot_id) snapshotId = res.snapshot_id;
  }

  const receipt = await issueReceipt(client, { kind: 'playlist_items', id: archiveId, uris });
  const unverifiedLine = resolved.verified ? '' : `\n[unverified source — resolved via search; owner: ${resolved.owner?.id ?? 'unknown'}]`;
  // #753: the first PUT is a REPLACE, so the number of items it destroys is
  // stated rather than implied, and the archive it wrote to is named by id
  // and uri. `archive_owner` is only resolved on the matched-existing path;
  // a playlist this call just created needs no ownership lookup to be its own.
  const replaced = created ? 0 : existingUris.length;
  const archiveOutcome = {
    archive: args.archiveName,
    ...scan,
    archive_id: archiveId,
    archive_uri: archiveUri,
    archive_action: created ? 'create' as const : 'replace' as const,
    archive_owner: target.status === 'resolved' ? target.owner : null,
  };
  const effect = created
    ? `Created archive playlist "${args.archiveName}" (ID: ${archiveId})`
    : `Replaced ${replaced} existing item(s) in "${args.archiveName}" (ID: ${archiveId})`;
  const prose = `Archived ${uris.length} track(s) from "${args.sourceName}" → "${args.archiveName}" (ID: ${archiveId})\n${effect}\nSource: ${resolved.name} (${sourceIdentity.source_url}) owner ${resolved.owner?.id ?? 'unknown'} [${resolved.source}]${unverifiedLine}\n${batchSummary(uris.length, uris)}\n${formatReceipt(receipt)}` + (snapshotId ? `\nSnapshot ID: ${snapshotId}` : '');
  return shapeResult(rf, prose, { ok: true, ...sourceIdentity, ...archiveOutcome, archived: uris.length, replaced, uris, snapshot_id: snapshotId, receipt: receipt as unknown as Record<string, unknown> });
}

// ---------------------------------------------------------------------------
// #223 helpers: profile state stores
// ---------------------------------------------------------------------------

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
  /**
   * #1008: what the file itself says about its own completeness.
   *
   * `truncated` is the exporter's `truncated` flag verbatim, and it is
   * `null` — not `false` — when the file carries no such flag. A sidecar
   * that never says whether it was capped leaves completeness unknown, and
   * reporting that as "not truncated" would invent a guarantee the file
   * never made. `capReached` keeps only the five collection keys, and
   * `truncatedKeys` is the subset the exporter named as capped (all
   * present keys when the file flags truncation without naming them).
   */
  readonly truncated: boolean | null;
  readonly capReached: Readonly<Partial<Record<SidecarKey, boolean>>>;
  readonly truncatedKeys: readonly SidecarKey[];
  /** The per-type cap the exporter recorded, or null when it recorded none. */
  readonly cap: number | null;
}

/**
 * Read the completeness metadata `export_library_json` writes beside the
 * five collections (#1008). Every field is a value the file actually
 * carries; nothing is inferred from row counts, because a walk that stopped
 * at the cap and a library that was genuinely that size are indistinguishable
 * from the rows alone — only the exporter's own flag distinguishes them.
 */
function readSidecarTruncation(doc: Record<string, unknown>): Pick<SidecarPlan, 'truncated' | 'capReached' | 'truncatedKeys' | 'cap'> {
  const rawCapReached = doc.cap_reached;
  const capReached: Partial<Record<SidecarKey, boolean>> = {};
  if (rawCapReached !== null && typeof rawCapReached === 'object' && !Array.isArray(rawCapReached)) {
    for (const { key } of SIDECAR_COLLECTIONS) {
      const flag = (rawCapReached as Record<string, unknown>)[key];
      if (typeof flag === 'boolean') capReached[key] = flag;
    }
  }
  const cap = typeof doc.cap === 'number' && Number.isFinite(doc.cap) ? doc.cap : null;
  // A boolean is read as written; anything else (absent, null, a string) is
  // unread, and unread stays null rather than collapsing to false.
  const truncated = typeof doc.truncated === 'boolean' ? doc.truncated : null;
  const namedCapped = (Object.keys(capReached) as SidecarKey[]).filter((k) => capReached[k]);
  const truncatedKeys = namedCapped.length > 0
    ? namedCapped
    : truncated === true
      ? [...SIDECAR_COLLECTIONS].map(({ key }) => key)
      : [];
  return { truncated, capReached, truncatedKeys, cap };
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

  const truncation = readSidecarTruncation(doc);
  return { present, absent, candidates, owner, collections, invalid, invalidSamples, inFile, ...truncation };
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
/**
 * #1008: prose for what the sidecar itself says about its completeness.
 *
 * Three states, none of them collapsed into a fourth:
 *  - `truncated: true` — the exporter says it stopped at the cap, so this
 *    restore covers a subset of the library and the missing rows are named.
 *  - `truncated: false` — the exporter says the walk finished.
 *  - `truncated: null` — the file carries no flag, so whether the export
 *    was capped is UNKNOWN. It is reported as unknown, never as complete.
 */
function truncationDisclosure(plan: SidecarPlan, inputPath: string): string {
  if (plan.truncated === true) {
    const keys = plan.truncatedKeys.length > 0 ? plan.truncatedKeys.join(', ') : 'unknown';
    const cap = plan.cap !== null ? ` at the per-type cap of ${plan.cap}` : '';
    return `This sidecar is TRUNCATED: ${inputPath} was written${cap} and only covers part of the library — capped collections: ${keys}. Restoring it adds what the file holds, never the rows left out of it; re-export with a raised SPOTIFY_MCP_FETCH_ALL_CAP for the rest.`;
  }
  if (plan.truncated === null) {
    return `${inputPath} carries no truncation flag, so whether the export was capped is UNKNOWN — the restore below covers exactly the ${plan.inFile} row(s) in the file and completeness of the source export cannot be confirmed from it.`;
  }
  return `This sidecar reports a complete export (truncated: false), so the restore below covers the full ${plan.inFile} row(s) it carries.`;
}

/** The disclosure fields every import_from_sidecar payload carries. */
function truncationPayload(plan: SidecarPlan) {
  return {
    sidecar_truncated: plan.truncated,
    cap_reached: plan.capReached,
    truncated_collections: plan.truncatedKeys,
    cap: plan.cap,
  };
}

/**
 * #760: a store that exists but cannot be read is UNREAD, not empty.
 * tryReadJson collapses "no such file" and "unparseable bytes" into the same
 * null, so a corrupt scenes.json used to export as `counts.scenes: 0` — a
 * count the archive then carried into every later import.
 */
type StoreRead =
  | { readonly state: 'read'; readonly value: unknown }
  | { readonly state: 'absent' }
  | { readonly state: 'unreadable'; readonly reason: string };

async function readStoreForExport(path: string): Promise<StoreRead> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { state: 'absent' };
    return { state: 'unreadable', reason: code ?? (e instanceof Error ? e.message : String(e)) };
  }
  try {
    return { state: 'read', value: JSON.parse(raw) };
  } catch (e) {
    return { state: 'unreadable', reason: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
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

      // #864: the verdict comes from the walk that produced the rows, not from
      // `rows.length === cap`. A library that is exactly `cap` long and one the
      // cap cut short hold the same rows; only the walk knows which it saw.
      const [trackWalk, albumWalk, showWalk, episodeWalk] = await Promise.all([
        client.getAllPagesWithTruncation<SavedTrackItem>('/me/tracks', { limit: '50' }, { maxItems: cap }),
        client.getAllPagesWithTruncation<SavedAlbumItem>('/me/albums', { limit: '50' }, { maxItems: cap }),
        client.getAllPagesWithTruncation<SavedShowItem>('/me/shows', { limit: '50' }, { maxItems: cap }),
        client.getAllPagesWithTruncation<SavedEpisodeItem>('/me/episodes', { limit: '50' }, { maxItems: cap }),
      ]);
      let audiobooks: Array<{ added_at: string; audiobook: { uri: string; name: string } }> = [];
      let audiobooksTruncated = false;
      // A failed read is not a zero: an unreadable /me/audiobooks is reported
      // as unread, never as an account that saved no audiobooks.
      let audiobooksUnreadable: string | null = null;
      try {
        const walk = await client.getAllPagesWithTruncation<{ added_at: string; audiobook: { uri: string; name: string } }>('/me/audiobooks', { limit: '50' }, { maxItems: cap });
        audiobooks = walk.items;
        audiobooksTruncated = walk.truncated;
      } catch (e) {
        audiobooksUnreadable = e instanceof Error ? e.message : String(e);
      }
      const tracks = trackWalk.items;
      const albums = albumWalk.items;
      const shows = showWalk.items;
      const episodes = episodeWalk.items;

      const capReached = {
        tracks: trackWalk.truncated,
        albums: albumWalk.truncated,
        shows: showWalk.truncated,
        episodes: episodeWalk.truncated,
        audiobooks: audiobooksTruncated,
      };
      const truncated = Object.values(capReached).some(Boolean);
      const unreadable = audiobooksUnreadable === null ? {} : { audiobooks: audiobooksUnreadable };
      const unreadableLine = audiobooksUnreadable === null
        ? ''
        : ` /me/audiobooks could not be read (${audiobooksUnreadable}) — audiobooks are reported as UNREAD, not as zero saved.`;

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
        const payload = { ok: audiobooksUnreadable === null, dir, format: 'csv', total, counts: { tracks: tracks.length, albums: albums.length, shows: shows.length, episodes: episodes.length, audiobooks: audiobooks.length }, cap_reached: capReached, truncated, cap, unreadable, files: results.map((r) => r.path) };
        return shapeResult(rf, `Exported library to ${dir} as CSV (${total} items across ${results.length} files).${footer}${unreadableLine}`, payload);
      }

      const doc = {
        exported_at: new Date().toISOString(),
        counts: { tracks: tracks.length, albums: albums.length, shows: shows.length, episodes: episodes.length, audiobooks: audiobooks.length },
        cap_reached: capReached,
        truncated,
        unreadable,
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
      const payload = { ok: audiobooksUnreadable === null, dir, file: filePath, format: 'json', bytes, counts: doc.counts, cap_reached: capReached, truncated, cap, total: tracks.length + albums.length + shows.length + episodes.length + audiobooks.length, unreadable };
      return shapeResult(rf, `Exported library to ${filePath} (${payload.total} items, ${bytes} bytes).${footer}${unreadableLine}`, payload);
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
      // #864: `artists.length >= cap` is not a verdict — a following list that
      // is exactly `cap` long is a complete list. The walk records WHY it
      // stopped: only the cap stopping it while the server still offered a
      // next cursor means rows were left behind.
      let capReached = false;
      while (artists.length < cap) {
        const params: Record<string, string> = { type: 'artist', limit: '50' };
        if (after) params.after = after;
        const page = await client.get<FollowedArtistsResponse>('/me/following', params);
        const items = page?.artists?.items ?? [];
        if (items.length === 0) break;
        for (const a of items) artists.push({ uri: a.uri, name: a.name, genres: a.genres ?? [] });
        const next = page?.artists?.cursors?.after ?? undefined;
        const hasMore = !!page?.artists?.next && !!next;
        if (artists.length >= cap) {
          capReached = hasMore || artists.length > cap;
          if (artists.length > cap) artists.length = cap;
          break;
        }
        if (!hasMore) break;
        after = next;
      }

      const exportedAt = new Date().toISOString();
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
    'Export local sidecar stores (scenes, genre-tags, playback-ext, search-history, mutations, artist-watchlist) to a single schema-versioned JSON archive. artist-watchlist is ~/.spotify-mcp/artist-watchlist.json; SPOTIFY_MCP_DATA_DIR overrides that directory.',
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
      const counts: Record<string, number | null> = {};
      // #760: `undefined` means the store could not be read at all and `null`
      // means the file is genuinely not there. A corrupt sidecar used to land
      // in the second bucket and export as a real count of zero.
      const unreadable: Record<string, string> = {};
      const read = async (key: string, path: string): Promise<unknown> => {
        const store = await readStoreForExport(path);
        if (store.state === 'unreadable') {
          unreadable[key] = `${path}: ${store.reason}`;
          return undefined;
        }
        return store.state === 'absent' ? null : store.value;
      };
      const empty = (value: unknown): number | null => (value === undefined ? null : 0);

      // scenes
      const scenes = await read('scenes', scenesFilePath());
      if (scenes && typeof scenes === 'object') {
        stores.scenes = scenes;
        counts.scenes = Object.keys(scenes as Record<string, unknown>).length;
      } else {
        stores.scenes = scenes ?? null;
        counts.scenes = empty(scenes);
      }

      // genre-tags
      const genreTags = await read('genre_tags', genreTagsPath());
      if (genreTags && typeof genreTags === 'object' && (genreTags as Record<string, unknown>).tags) {
        stores.genre_tags = genreTags;
        const tags = (genreTags as { tags: Record<string, unknown> }).tags;
        counts.genre_tags = Object.keys(tags).length;
      } else if (genreTags) {
        stores.genre_tags = genreTags;
        counts.genre_tags = empty(genreTags);
      } else {
        stores.genre_tags = genreTags ?? null;
        counts.genre_tags = empty(genreTags);
      }

      // playback-ext
      const playbackExt = await read('playback_ext', playbackExtFile());
      if (playbackExt && typeof playbackExt === 'object') {
        stores.playback_ext = playbackExt;
        const pe = playbackExt as Record<string, unknown>;
        counts.playback_ext_states = pe.states ? Object.keys(pe.states as Record<string, unknown>).length : 0;
        counts.playback_ext_sessions = pe.sessions ? Object.keys(pe.sessions as Record<string, unknown>).length : 0;
      } else {
        stores.playback_ext = playbackExt ?? null;
        counts.playback_ext_states = empty(playbackExt);
        counts.playback_ext_sessions = empty(playbackExt);
      }

      // search-history
      const searchHistory = await read('search_history', searchHistoryFile());
      if (Array.isArray(searchHistory)) {
        stores.search_history = searchHistory;
        counts.search_history = searchHistory.length;
      } else if (searchHistory && typeof searchHistory === 'object' && Array.isArray((searchHistory as Record<string, unknown>).entries)) {
        const entries = (searchHistory as { entries: unknown[] }).entries;
        stores.search_history = entries;
        counts.search_history = entries.length;
      } else {
        stores.search_history = searchHistory ?? null;
        counts.search_history = empty(searchHistory);
      }

      // artist-watchlist (same path the artist-watch tools write, #764)
      const watchlist = await tryReadJson(artistWatchlistPath());
      if (watchlist && typeof watchlist === 'object') {
        stores.artist_watchlist = watchlist;
        const wl = watchlist as { watchlists?: Record<string, unknown> };
        counts.artist_watchlist = wl.watchlists ? Object.keys(wl.watchlists).length : 0;
      } else {
        stores.artist_watchlist = watchlist ?? null;
        counts.artist_watchlist = empty(watchlist);
      }
      const unreadableLine = Object.keys(unreadable).length > 0
        ? ` ${Object.keys(unreadable).length} store(s) could not be read and are counted as UNREAD, not zero: ${Object.entries(unreadable).map(([k, why]) => `${k} (${why})`).join('; ')}. Their contents are not in this archive.`
        : '';

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
        watchlist_path: artistWatchlistPath(),
        counts,
        stores,
      };

      const body = `${JSON.stringify(doc, null, 2)}\n`;
      await writeOutputFile(filePath, body);
      const bytes = Buffer.byteLength(body);
      const payload = { ok: Object.keys(unreadable).length === 0, path: filePath, bytes, counts, schema_version: PROFILE_STATE_SCHEMA_VERSION, unreadable };
      return shapeResult(rf, `Exported profile state to ${filePath} (${bytes} bytes) — ${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(', ')}.${unreadableLine}`, payload);
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
        // A mode argument only applies at CREATION, so a store that was already
        // on disk keeps whatever mode it had — a copied-in or
        // previously-world-readable scenes.json / search-history.json would
        // still be readable by anyone after the import. This is the same
        // re-assert the mutations-history ledger already does (#628); these
        // five stores were the call site it missed.
        await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await chmod(filePath, 0o600);
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
            await planStore('artist_watchlist', artistWatchlistPath(), value, 'record');
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
    'Export your listening history (recently played) to a JSON or CSV sidecar by walking /me/player/recently-played with before-cursor pagination. Respects SPOTIFY_MCP_FETCH_ALL_CAP; writes file 0600 and reports path + counts.',
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
      // #864: the verdict is the reason the walk stopped, never
      // `items.length === cap`. Landing exactly on the cap is a cap hit only
      // when the server still had a full page to give; a short page means it
      // had run out of history.
      let capReached = false;
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
        if (items.length >= cap) {
          capReached = pageItems.length >= 50;
          break;
        }
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

      const exportedAt = new Date().toISOString();
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
      // #864/#1008: both walks report their own truncation verdict, and an
      // item read that fails is named as unread rather than exported as an
      // empty playlist. A capped walk and an unreadable playlist are different
      // facts and both used to read as "this playlist has no items".
      const listWalk = await client.getAllPagesWithTruncation<SpotifyPlaylistSimple>('/me/playlists', { limit: '50' }, { maxItems: cap });
      const playlistsTruncated = listWalk.truncated;
      let playlists = listWalk.items;
      if (args.scope === 'owned' && myId) playlists = playlists.filter((p) => p?.owner?.id === myId);
      const exportedAt = new Date().toISOString();
      const playlistRows: Array<{ id: string; name: string; uri: string; total: number; items: Array<{ uri: string; name: string }>; items_unreadable?: string }> = playlists.map((p) => ({ id: p.id, name: p.name, uri: p.uri, total: p.items?.total ?? 0, items: [] }));
      const cappedPlaylists: string[] = [];
      const unreadablePlaylists: string[] = [];
      if (args.include_items !== false) {
        for (const row of playlistRows) {
          try {
            const walk = await client.getAllPagesWithTruncation<PlaylistItemObject>(`/playlists/${encodeURIComponent(row.id)}/items`, { limit: '100' }, { maxItems: cap });
            row.items = walk.items.map((r) => ({ uri: (r?.item as { uri?: string })?.uri ?? '', name: (r?.item as { name?: string })?.name ?? '' })).filter((x) => x.uri);
            if (walk.truncated) cappedPlaylists.push(row.id);
          } catch (e) {
            row.items = [];
            row.items_unreadable = e instanceof Error ? e.message : String(e);
            unreadablePlaylists.push(row.id);
          }
        }
      }
      const truncated = playlistsTruncated || cappedPlaylists.length > 0;
      const unreadable: Record<string, string> = {};
      for (const row of playlistRows) if (row.items_unreadable) unreadable[row.id] = row.items_unreadable;
      const notes: string[] = [];
      if (playlistsTruncated) notes.push(`The /me/playlists walk hit the cap of ${cap}, so this export covers only the first ${playlists.length} playlist(s) — raise SPOTIFY_MCP_FETCH_ALL_CAP for the rest.`);
      if (cappedPlaylists.length > 0) notes.push(`Item walks hit the cap of ${cap} for ${cappedPlaylists.length} playlist(s) (${cappedPlaylists.join(', ')}) — their item lists are partial.`);
      if (unreadablePlaylists.length > 0) notes.push(`Item list UNREADABLE for ${unreadablePlaylists.length} playlist(s) (${unreadablePlaylists.join(', ')}): ${Object.entries(unreadable).map(([id, why]) => `${id} (${why})`).join('; ')} — they are exported with an empty item list, not as playlists that hold nothing.`);
      const notesSuffix = notes.length > 0 ? `\n${notes.join('\n')}` : '';
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
        return shapeResult(rf, `Exported ${playlistRows.length} playlist(s) (${rows.length} rows) to ${fp}.${notesSuffix}`, { ok: unreadablePlaylists.length === 0, dir, file: fp, format: 'csv', total: playlistRows.length, rows: rows.length, cap, cap_reached: playlistsTruncated, truncated, capped_playlists: cappedPlaylists, unreadable });
      }
      const doc = { exported_at: exportedAt, total: playlistRows.length, scope: args.scope, cap, cap_reached: playlistsTruncated, truncated, capped_playlists: cappedPlaylists, unreadable, playlists: playlistRows };
      const fp = join(dir, 'playlists.json');
      const body = `${JSON.stringify(doc, null, 2)}\n`;
      await writeOutputFile(fp, body);
      return shapeResult(rf, `Exported ${playlistRows.length} playlist(s) to ${fp} (${Buffer.byteLength(body)} bytes).${notesSuffix}`, { ok: unreadablePlaylists.length === 0, dir, file: fp, format: 'json', bytes: Buffer.byteLength(body), total: playlistRows.length, scope: args.scope, cap, cap_reached: playlistsTruncated, truncated, capped_playlists: cappedPlaylists, unreadable });
    },
  );

  // library_snapshot_diff — diff two sidecar files locally
  server.tool(
    'library_snapshot_diff',
    'Diff two sidecar JSON files (library.json or playlists.json): added/removed counts + samples. Quota: 🟢 local only (no API).',
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

  // history_search — search the portability, backup and mutation-history stores (#754)
  server.tool(
    'history_search',
    'Search portability, backup and mutation-history stores; hits name their source. Quota: 🟢 local only (no API).',
    {
      query: z.string().optional().describe('Substring to match'),
      scope: z.enum(HISTORY_SEARCH_SCOPES).optional().default('all').describe('Scope'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const scope = (args.scope ?? 'all') as HistorySearchScope;
      const q = (args.query ?? '').trim().toLowerCase();
      const searched = (store: Exclude<HistorySearchScope, 'all'>): boolean => scope === 'all' || scope === store;
      const notes: string[] = [];
      const hits: Array<Record<string, unknown>> = [];
      const sources: Record<string, StoreSummary> = {};

      if (searched('portability')) {
        const dir = portabilityDir();
        const listing = await listStore(dir);
        if (listing.names === null) {
          sources.portability = { state: 'unreadable', total: null, matched: 0 };
          notes.push(`${dir} could not be listed — its contents are unknown, not empty.`);
        } else {
          const matched = listing.names.filter((n) => !q || n.toLowerCase().includes(q));
          for (const name of matched) hits.push({ source: 'portability', name, path: join(dir, name) });
          sources.portability = { state: listing.state, total: listing.names.length, matched: matched.length };
          if (listing.state === 'absent') notes.push(`No portability directory at ${dir}.`);
        }
      } else {
        sources.portability = skippedStore();
      }

      if (searched('backups')) {
        const store = await readBackupStore();
        if (store.artifacts === null) {
          sources.backups = { state: 'unreadable', total: null, matched: 0 };
          notes.push(`${store.dir} could not be listed — its contents are unknown, not empty.`);
        } else {
          const matched = store.artifacts.filter((a) => !q || a.name.toLowerCase().includes(q));
          for (const artifact of matched) hits.push({ source: 'backups', ...artifact });
          sources.backups = { state: store.state, total: store.artifacts.length, matched: matched.length };
          if (store.state === 'absent') notes.push(`No backup store at ${store.dir}.`);
        }
      } else {
        sources.backups = skippedStore();
      }

      if (searched('history')) {
        const file = historyFilePath();
        const state: StoreState = await stat(file).then(
          () => 'ok',
          (err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? 'absent' : 'unreadable'),
        );
        if (state === 'unreadable') {
          sources.history = { state, total: null, matched: 0 };
          notes.push(`${file} could not be read — its contents are unknown, not empty.`);
        } else if (state === 'absent') {
          sources.history = { state, total: 0, matched: 0 };
          notes.push(`No mutation ledger at ${file}.`);
        } else {
          const records = await readHistory({ file, limit: DEFAULT_HISTORY_READ_LIMIT });
          const matched = q ? records.filter((r) => historyRecordMatches(r, q)) : records;
          for (const record of matched) hits.push(historyRecordHit(record));
          sources.history = { state, total: records.length, matched: matched.length };
          if (records.length === DEFAULT_HISTORY_READ_LIMIT) {
            notes.push(`The ledger was read up to its ${DEFAULT_HISTORY_READ_LIMIT}-record ceiling; older records may exist.`);
          }
        }
        if (!isHistoryEnabled()) {
          notes.push('SPOTIFY_MCP_HISTORY is off, so nothing new is being recorded: matches cover only records written while it was enabled.');
        }
      } else {
        sources.history = skippedStore();
      }

      const read = Object.values(sources).filter((s) => s.state !== 'skipped');
      const unreadable = read.filter((s) => s.state === 'unreadable');
      const storeNames = (Object.keys(sources) as string[]).filter((n) => sources[n]!.state !== 'skipped');
      const total = read.reduce((sum, s) => sum + (s.total ?? 0), 0);
      const matchedCount = hits.length;
      const shown = hits.slice(0, HISTORY_SEARCH_HIT_CAP);
      const breakdown = storeNames
        .filter((n) => sources[n]!.matched > 0)
        .map((n) => `${sources[n]!.matched} from ${n}`)
        .join(', ');
      const prose = [
        `Found ${matchedCount}/${total} item(s) matching "${args.query ?? ''}" across ${storeNames.join(', ') || 'no store'}${breakdown ? `: ${breakdown}` : ''}.`,
        ...(unreadable.length > 0 ? [`${unreadable.length} store(s) could not be read — their totals are unknown, not zero.`] : []),
        ...(matchedCount > shown.length ? [`Showing the first ${shown.length} of ${matchedCount} hit(s).`] : []),
        ...notes,
      ].join('\n');
      const payload = {
        ok: true,
        query: args.query ?? '',
        scope,
        dirs: { portability: portabilityDir(), backups: backupDir(), history: historyFilePath() },
        total,
        matched_count: matchedCount,
        sources,
        hits: shown,
        hits_truncated: matchedCount > shown.length,
        unreadable_sources: unreadable.length,
        notes,
      };
      return shapeResult(rf, prose, payload);
    },
  );

  // import_from_sidecar — additive restore from sidecar (dry_run defaults true)
  server.tool(
    'import_from_sidecar',
    'Additive restore from a library.json sidecar written by export_library_json: re-adds every missing saved item across all five collections (tracks, albums, shows, episodes, audiobooks) through the unified PUT /me/library endpoint, skipping items the library already holds. Rows whose uri is not a canonical spotify:<kind>:<22-char id> URI are counted as invalid and never sent. Collections the file does not carry are named in absent_keys. The exporter\'s own truncated / cap_reached flags are surfaced as sidecar_truncated + truncated_collections: a capped sidecar restores only the rows it holds and says so, and a file with no flag reports completeness as UNKNOWN rather than complete. dry_run=true by default. Quota: 🟢 local read + 🟡 contains-check + writes when dry_run=false (chunked).',
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
      const truncationLine = truncationDisclosure(plan, inputPath);

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
          ...truncationPayload(plan),
        };
        const lines = [
          `Would restore ${plan.candidates.length} item(s) from ${plan.present.length} collection(s): ${plan.present.join(', ') || '—'}`,
          ...plan.candidates.slice(0, 5).map((u) => u),
        ];
        if (plan.candidates.length > 5) lines.push(`…and ${plan.candidates.length - 5} more`);
        if (absentLine) lines.push(absentLine);
        if (invalidLine) lines.push(invalidLine);
        lines.push(truncationLine);
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
          ...truncationPayload(plan),
        };
        return shapeResult(
          rf,
          `Import from ${inputPath}: added 0 item(s) — the sidecar carried no valid library URI to restore.${truncationLine} ${absentLine ? `${absentLine} ` : ''}${invalidLine ? ` ${invalidLine}` : ''}`,
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
            // #1008: the operator confirms a write, so the subset they are
            // agreeing to has to be visible in the prompt, not only afterwards.
            ...(plan.truncated === true || plan.truncated === null
              ? [`  NOTE — ${truncationLine}`]
              : []),
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
        ...truncationPayload(plan),
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
        truncationLine,
        batchSummary(missing.length, missing),
        ...(receipt ? [formatReceipt(receipt)] : []),
      ]
        .filter((l) => l !== '')
        .join('\n');
      return shapeResult(rf, prose, payload);
    },
  );
}
