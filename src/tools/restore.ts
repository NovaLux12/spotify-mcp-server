/**
 * restore_library_snapshot (#160): STRICTLY ADDITIVE restore of a library
 * snapshot produced by backup_library (#159 contract).
 *
 * Safety rules baked in:
 *  - Nothing existing is ever overwritten, renamed, deleted, or unfollowed.
 *    Liked tracks / saved items are only ADDED when absent (contains-check
 *    first); artists are only followed when not yet followed; playlists are
 *    only ever CREATED — a snapshot playlist whose exact name already exists
 *    in the live account is skipped untouched.
 *  - dry_run defaults to TRUE: by default the tool performs read-only checks
 *    and reports what it WOULD do, calling no mutating endpoint.
 *  - Any actual write requires explicit elicitation confirmation summarizing
 *    the planned writes per category. A declined prompt cancels with zero
 *    writes; elicitation errors and clients without support refuse restores
 *    entirely. SPOTIFY_MCP_CONFIRM=never is the explicit automation bypass.
 */
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import {
  ResponseFormat,
  MaxResults,
  resolveMaxResults,
  parseSpotifyUri,
  completenessFooter,
  truncateItems,
  LIBRARY_WRITE_CHUNK,
} from '../shaping.js';
import type { ResponseFormatValue } from '../shaping.js';
import { getConfig } from '../config.js';
import { confirmViaElicitation } from './confirm.js';
import { issueReceipt, type Receipt } from '../receipts.js';
import { receiptRecords, receiptsLines, writeVerdict } from './playlistreceipts.js';
import { LIBRARY_BACKUP_SCHEMA_VERSION } from './backup.js';

// ---------------------------------------------------------------------------
// Snapshot shape (#159 BackupBuilder contract)
// ---------------------------------------------------------------------------

/** Saved-library row: {uri,name,added_at}; followed artists omit added_at. */
interface SnapshotRow {
  uri: string;
  name: string;
  added_at?: string;
}

interface SnapshotPlaylistItem {
  uri: string;
  name: string;
}

interface SnapshotPlaylist {
  name: string;
  uri?: string | null;
  item_count?: number | null;
  items?: SnapshotPlaylistItem[];
  items_truncated?: boolean;
  items_error?: string;
}

interface SnapshotCollectionStatus {
  complete?: boolean;
  truncated?: boolean;
  fetched?: number;
  cap?: number;
}

export interface LibrarySnapshot {
  /** On-disk contract version; absent on pre-#757 files. */
  schema_version?: number;
  /** Set by backup_library on a quota-hit file: nothing was captured. */
  quota_hit?: boolean;
  /** Set by backup_library on any non-complete file. */
  _partial?: boolean;
  _meta?: {
    created?: string;
    notes?: string;
    counts?: Record<string, unknown>;
    snapshot_state?: 'complete' | 'partial';
    complete?: boolean;
    partial_reason?: string;
    partial_reasons?: string[];
    collections?: Record<string, SnapshotCollectionStatus>;
  };
  liked_tracks?: SnapshotRow[];
  saved_albums?: SnapshotRow[];
  saved_shows?: SnapshotRow[];
  saved_episodes?: SnapshotRow[];
  saved_audiobooks?: SnapshotRow[];
  followed_artists?: SnapshotRow[];
  playlists?: SnapshotPlaylist[];
}

const RESTORE_CATEGORIES = [
  'liked_tracks',
  'saved_albums',
  'saved_shows',
  'saved_episodes',
  'saved_audiobooks',
  'followed_artists',
  'playlists',
] as const;
type RestoreCategory = (typeof RESTORE_CATEGORIES)[number];

const SNAPSHOT_ROW_KEYS = [
  'liked_tracks',
  'saved_albums',
  'saved_shows',
  'saved_episodes',
  'saved_audiobooks',
  'followed_artists',
] as const;

const LIBRARY_CATEGORIES = [
  'liked_tracks',
  'saved_albums',
  'saved_shows',
  'saved_episodes',
  'saved_audiobooks',
] as const satisfies readonly RestoreCategory[];

/**
 * `/me/library/contains` (read-only verification) accepts 50 uris per call —
 * a different, larger cap than the WRITE endpoint, which takes
 * `LIBRARY_WRITE_CHUNK` (40). The two are kept apart on purpose: conflating
 * them is what let the write path drift to an over-cap batch (#624).
 */
const LIBRARY_CONTAINS_CHUNK = 50;
const FOLLOW_CHUNK = 50;
const ADD_ITEMS_CHUNK = 100;

/**
 * A well-formed Spotify object URI (#624). Snapshot rows are caller-supplied
 * and go straight into a request query string, so a row like
 * `spotify:track:a&market=XX` would inject a parameter and a `#…` would
 * truncate the request — the restore would then do something other than what
 * the plan printed. Anything not matching this shape is skipped and reported.
 */
const SNAPSHOT_URI_PATTERN = /^spotify:[a-z]+:[A-Za-z0-9]+$/;

/**
 * Floor for the name-reservation walk over `/me/playlists` (#737).
 *
 * The guard that keeps a restore from duplicating an existing playlist is only
 * as good as this walk, and the walk used to inherit the default fetch-all cap
 * of 500. An account with 900 playlists therefore had rows 501-900 invisible to
 * the guard while the restore went on creating `Restored · <name> (<date>)`
 * copies of playlists that were already there — the exact promise the tool
 * makes, broken without a word about it.
 *
 * The walk is a name lookup, not an analysis: pages are small and it runs once
 * per restore, so a generous floor costs far less than a duplicate. Headroom
 * over the snapshot's own playlist count keeps the scan ahead of what it is
 * being compared against, and the floor covers accounts larger than the
 * snapshot. If even this walk is clipped, the tool refuses to restore rather
 * than guess — see the reservation refusal in the handler.
 */
const RESERVATION_SCAN_FLOOR = 2000;

/** Cap for the reservation walk: the floor, or snapshot size + headroom. */
function reservationScanCap(snapshotPlaylistCount: number): number {
  return Math.max(RESERVATION_SCAN_FLOOR, snapshotPlaylistCount + getConfig().fetchAllCap);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Why a snapshot records no library content worth restoring, or null.
 *
 * A quota-hit backup still writes a structurally valid file: every
 * category empty, `quota_hit`/`_partial` set, `_meta.complete` false. It
 * parses fine and every row passes validation, so without this check a
 * restore reports a clean "nothing to add" for a library the backup
 * never managed to read. A snapshot that is *not* declared complete and
 * carries no rows is that file, whatever the marker is spelled like, so
 * both the explicit marker and the emptiness it produces are refused.
 * Cap-truncated snapshots do record rows and stay previewable — the
 * plan's restorable_complete check refuses them before any write.
 */
function unrestorableSnapshotReason(
  obj: Record<string, unknown>,
  recognized: readonly string[],
): string | null {
  if (obj.quota_hit === true) return 'quota hit recorded in the file';
  const meta = obj._meta as
    | { complete?: unknown; snapshot_state?: unknown }
    | undefined;
  const declaredComplete = meta?.complete === true || meta?.snapshot_state === 'complete';
  if (declaredComplete) return null;
  const recorded = recognized.reduce(
    (n, key) => n + (Array.isArray(obj[key]) ? (obj[key] as unknown[]).length : 0),
    0,
  );
  return recorded === 0 ? 'no library content was recorded and the file is not marked complete' : null;
}

/**
 * Read + validate a snapshot file. Every problem surfaces as one clear error
 * naming the path and what exactly is wrong — never a raw parse trace.
 */
async function loadSnapshot(path: string): Promise<LibrarySnapshot> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new Error(
      `Could not read snapshot at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Malformed snapshot at ${path}: not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Malformed snapshot at ${path}: top level must be a JSON object`);
  }

  const obj = parsed as Record<string, unknown>;

  // An unknown contract version means the keys below cannot be read on a
  // guess (#757). Files written before the field existed carry none and
  // stay loadable.
  const version = obj.schema_version;
  if (version !== undefined && version !== LIBRARY_BACKUP_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported snapshot at ${path}: schema_version ${JSON.stringify(version)} is not the supported version ${LIBRARY_BACKUP_SCHEMA_VERSION} - restore aborted; take a fresh backup`,
    );
  }
  const recognized: readonly string[] = [...SNAPSHOT_ROW_KEYS, 'playlists'];
  if (!recognized.some((k) => k in obj)) {
    throw new Error(
      `Malformed snapshot at ${path}: no recognized categories (expected one or more of: ${recognized.join(', ')})`,
    );
  }

  for (const key of SNAPSHOT_ROW_KEYS) {
    if (!(key in obj)) continue;
    if (!Array.isArray(obj[key])) {
      throw new Error(`Malformed snapshot at ${path}: '${key}' must be an array`);
    }
    (obj[key] as unknown[]).forEach((row, i) => {
      if (
        typeof row !== 'object' ||
        row === null ||
        typeof (row as { uri?: unknown }).uri !== 'string'
      ) {
        throw new Error(
          `Malformed snapshot at ${path}: '${key}' row ${i} is not a {uri,name} object`,
        );
      }
    });
  }

  if ('playlists' in obj) {
    if (!Array.isArray(obj.playlists)) {
      throw new Error(`Malformed snapshot at ${path}: 'playlists' must be an array`);
    }
    (obj.playlists as unknown[]).forEach((pl, i) => {
      if (
        typeof pl !== 'object' ||
        pl === null ||
        typeof (pl as { name?: unknown }).name !== 'string'
      ) {
        throw new Error(
          `Malformed snapshot at ${path}: 'playlists' row ${i} is missing a string 'name'`,
        );
      }
    });
  }

  // Structure is sound and the file still holds nothing: judge the
  // content only once the shape is known good, so a malformed file is
  // never reported as an empty-but-valid one.
  const contentless = unrestorableSnapshotReason(obj, recognized);
  if (contentless !== null) {
    throw new Error(
      `Partial snapshot at ${path}: ${contentless} - restore aborted; take a fresh backup`,
    );
  }

  return parsed as LibrarySnapshot;
}

/** YYYY-MM-DD slice of _meta.created, or 'unknown date'. */
function snapshotDate(snapshot: LibrarySnapshot): string {
  const created = snapshot._meta?.created;
  return typeof created === 'string' && created.length >= 10 ? created.slice(0, 10) : 'unknown date';
}

// ---------------------------------------------------------------------------
// Planning (read-only)
// ---------------------------------------------------------------------------

interface CategoryPlan {
  category: RestoreCategory;
  /** Rows considered from the snapshot (after dropping duplicate rows). */
  total: number;
  /** Rows already present in the live account — never re-written. */
  alreadyPresent: number;
  /** Writes this restore would/does perform. */
  planned: number;
  /** Absent URIs to save (library categories only). */
  plannedUris: string[];
  /** Unfollowed artist IDs to follow (followed_artists only). */
  plannedArtistIds: string[];
  /**
   * #638: artist rows the restore can read but cannot write back.
   *
   * Spotify's February 2026 changes removed `PUT`/`DELETE /me/following`, and
   * `PUT`/`DELETE /me/library` — the replacement named for every other removed
   * write here — accepts track, album, episode, show, audiobook, user and
   * playlist URIs but NOT `spotify:artist:`. So an artist the user has since
   * unfollowed is not restorable by any endpoint, and a plan that counted it
   * as a pending write would report a restore that cannot happen. These rows
   * are counted here and named in `notes` instead.
   */
  unrestorable: number;
  /** Rows dropped (malformed URI/name, duplicates, name collisions). */
  skipped: number;
  /**
   * Snapshot rows dropped for a malformed URI (#624), kept apart from ordinary
   * skips (duplicates, name collisions) so a caller can tell a corrupt
   * snapshot row from a deliberate non-restoration.
   */
  invalidUris: string[];
  notes: string[];
}

interface PlaylistCreation {
  snapshotName: string;
  restoredName: string;
  itemUris: string[];
}

/**
 * How much of the account the playlist name-reservation guard actually saw
 * (#737). The guard's whole promise — an existing playlist of the same name is
 * never written into or duplicated — rests on this walk, so its coverage is
 * reported rather than assumed.
 *
 * `scanned` is null when no walk ran (playlists category unselected, or the
 * snapshot carries no playlist rows). That is NOT the same as 0: a scanned-0
 * account is a claim, an unrun scan is the absence of one.
 */
interface ReservationScan {
  /** Existing playlists compared against the snapshot's names. */
  scanned: number;
  /** True when the walk stopped short, so the guard cannot be called complete. */
  truncated: boolean;
  /** Cap in force for this walk. */
  cap: number;
  /** The server's own playlist count, or null when it reported none. */
  reportedTotal: number | null;
}

interface RestorePlan {
  snapshotCreated: string | null;
  snapshotState: 'complete' | 'partial' | 'unknown';
  restorableComplete: boolean | null;
  selectedFetched: number | null;
  selectedCap: number | null;
  shortfalls: string[];
  perCategory: CategoryPlan[];
  playlistCreations: PlaylistCreation[];
  skippedPlaylists: string[];
  /** Null when the reservation walk never ran; see ReservationScan. */
  reservation: ReservationScan | null;
}

/** Dedupe rows on uri, counting repeats as skips. */
function dedupeRows(rows: SnapshotRow[], plan: CategoryPlan): SnapshotRow[] {
  const seen = new Set<string>();
  const kept: SnapshotRow[] = [];
  for (const row of rows) {
    if (seen.has(row.uri)) {
      plan.skipped += 1;
      continue;
    }
    seen.add(row.uri);
    kept.push(row);
  }
  return kept;
}

/**
 * Drop rows whose URI is not a well-formed Spotify object URI (#624), counting
 * each as a skip. Skipped rather than fatal: one corrupt row must not abort a
 * restore of the rest of the snapshot, but it must never reach the wire.
 */
function wellFormedRows(rows: SnapshotRow[], plan: CategoryPlan): SnapshotRow[] {
  return rows.filter((row) => {
    if (SNAPSHOT_URI_PATTERN.test(row.uri)) return true;
    plan.skipped += 1;
    plan.invalidUris.push(row.uri);
    plan.notes.push(`skipped invalid URI ${row.uri} — not a spotify:<type>:<id> URI`);
    return false;
  });
}

async function containsLibraryUris(
  client: SpotifyClient,
  uris: readonly string[],
): Promise<boolean[]> {
  const flags: boolean[] = [];
  for (const part of chunk(uris, LIBRARY_CONTAINS_CHUNK)) {
    const res = await client.get<boolean[]>('/me/library/contains', { uris: part.join(',') });
    if (!res) throw new Error('Could not check current library state (/me/library/contains)');
    flags.push(...res);
  }
  return flags;
}

async function followsArtistIds(
  client: SpotifyClient,
  ids: readonly string[],
): Promise<boolean[]> {
  const flags: boolean[] = [];
  for (const part of chunk(ids, FOLLOW_CHUNK)) {
    // #638: `GET /me/following/contains` was removed by Spotify's February
    // 2026 changes; `GET /me/library/contains` is the documented read
    // replacement and it is the half of following that DID migrate — it
    // accepts `spotify:artist:` URIs even though PUT/DELETE /me/library
    // cannot save them (that is the whole reason the follow WRITE is
    // unrecoverable; see the `unrestorable` accounting in the planner).
    const res = await client.get<boolean[]>('/me/library/contains', {
      uris: part.map((id) => `spotify:artist:${id}`).join(','),
    });
    // A response that is not one boolean per requested id is an unread, not a
    // row of "not followed": counting an unrecognised body positionally would
    // plan a follow write for every artist in the chunk, and the plan's
    // `alreadyPresent` figure is what keeps a restore from re-doing work.
    if (!Array.isArray(res) || res.length !== part.length || res.some((v) => typeof v !== 'boolean')) {
      throw new Error(
        `Could not check current follows: GET /me/library/contains returned a body that is not `
        + `${part.length} booleans for the ${part.length} artist URI(s) requested. Treated as unread.`,
      );
    }
    flags.push(...res);
  }
  return flags;
}

function freshCategoryPlan(category: RestoreCategory): CategoryPlan {
  return {
    category,
    total: 0,
    alreadyPresent: 0,
    planned: 0,
    plannedUris: [],
    plannedArtistIds: [],
    unrestorable: 0,
    skipped: 0,
    notes: [],
    invalidUris: [],
  };
}

/** Compute the additive plan with read-only calls only. */
async function computeRestorePlan(
  client: SpotifyClient,
  snapshot: LibrarySnapshot,
  categories: readonly RestoreCategory[],
): Promise<RestorePlan> {
  const perCategory: CategoryPlan[] = [];
  const playlistCreations: PlaylistCreation[] = [];
  const skippedPlaylists: string[] = [];
  // Null until the playlists branch actually walks /me/playlists (#737).
  let reservationScan: ReservationScan | null = null;
  const shortfalls: string[] = [];
  const selected: readonly string[] = categories;
  const collectionMetadata = snapshot._meta?.collections;
  const recordedReasons = [
    ...(snapshot._meta?.partial_reasons ?? []),
    ...(snapshot._meta?.partial_reason ? [snapshot._meta.partial_reason] : []),
  ];
  if (collectionMetadata === undefined) {
    for (const reason of recordedReasons) shortfalls.push(`snapshot: ${reason}`);
  }

  for (const [name, status] of Object.entries(snapshot._meta?.collections ?? {})) {
    if (selected.includes(name) && (status.truncated === true || status.complete === false)) {
      shortfalls.push(`${name}: fetched ${status.fetched ?? 'unknown'} of cap ${status.cap ?? 'unknown'}`);
    }
  }
  const selectedStatuses = categories.map((category) => snapshot._meta?.collections?.[category]);
  const selectedFetched = selectedStatuses.every((status) => typeof status?.fetched === 'number')
    ? selectedStatuses.reduce((total, status) => total + (status?.fetched ?? 0), 0)
    : null;
  const selectedCap = selectedStatuses.every((status) => typeof status?.cap === 'number')
    ? selectedStatuses.reduce((total, status) => total + (status?.cap ?? 0), 0)
    : null;
  for (const category of categories) {
    const plan = freshCategoryPlan(category);

    if ((LIBRARY_CATEGORIES as readonly string[]).includes(category)) {
      const rows = wellFormedRows(dedupeRows((snapshot[category] ?? []) as SnapshotRow[], plan), plan);
      plan.total = rows.length;
      if (rows.length > 0) {
        const present = await containsLibraryUris(client, rows.map((r) => r.uri));
        rows.forEach((row, i) => {
          if (present[i]) plan.alreadyPresent += 1;
          else plan.plannedUris.push(row.uri);
        });
        plan.planned = plan.plannedUris.length;
        plan.notes.push(...plan.plannedUris.map((uri) => `would save ${uri}`));
      }
    } else if (category === 'followed_artists') {
      const rows = wellFormedRows(dedupeRows(snapshot.followed_artists ?? [], plan), plan);
      plan.total = rows.length;
      const ids: string[] = [];
      for (const row of rows) {
        const parsed = parseSpotifyUri(row.uri);
        if (parsed && parsed.type === 'artist') ids.push(parsed.id);
        else {
          plan.skipped += 1;
          plan.notes.push(`skipped non-artist URI ${row.uri}`);
        }
      }
      if (ids.length > 0) {
        const follows = await followsArtistIds(client, ids);
        // #638: the read half migrated (GET /me/library/contains) but the
        // WRITE half did not — see `unrestorable`. An artist the user is not
        // currently following is therefore counted as unrestorable rather
        // than planned, so a plan can no longer promise a follow write that no
        // endpoint will accept.
        ids.forEach((id, i) => {
          if (follows[i]) plan.alreadyPresent += 1;
          else {
            plan.unrestorable += 1;
            plan.notes.push(`cannot re-follow spotify:artist:${id} — Spotify removed the follow write (#638)`);
          }
        });
        plan.planned = plan.plannedArtistIds.length;
      }
    } else if (category === 'playlists') {
      const snapshotPlaylists = snapshot.playlists ?? [];
      plan.total = snapshotPlaylists.length;
      if (snapshotPlaylists.length > 0) {
        // #737: this walk is the whole basis of the "never duplicates an
        // existing playlist" promise, so it asks for the truncation verdict
        // instead of taking a bare array. A bare array cannot distinguish
        // "read every playlist" from "stopped at the cap", and a walk
        // silently cut short is a guard quietly comparing against half the
        // account — the same lie as a payload field that reports a value it
        // never read. The verdict travels with the plan and blocks the write
        // path when the walk is clipped.
        const cap = reservationScanCap(snapshotPlaylists.length);
        const walk = await client.getAllPagesWithTruncation<{ id: string; name: string }>(
          '/me/playlists',
          { limit: '50' },
          { maxItems: cap },
        );
        reservationScan = {
          scanned: walk.items.length,
          truncated: walk.truncated,
          cap,
          reportedTotal: walk.reportedTotal,
        };
        const currentNames = new Set(walk.items.map((p) => p.name));
        const dateSuffix = snapshotDate(snapshot);
        for (const pl of snapshotPlaylists) {
          const expected = typeof pl.item_count === 'number' ? pl.item_count : null;
          const stored = (pl.items ?? []).filter((it) => typeof it?.uri === 'string').length;
          if (pl.items_truncated === true || pl.items_error !== undefined || (expected !== null && expected > stored)) {
            shortfalls.push(
              `${pl.name}: stored ${stored} of ${expected ?? 'unknown'} items${pl.items_error ? ` (${pl.items_error})` : ''}`,
            );
            plan.skipped += 1;
            plan.notes.push(`refused incomplete playlist "${pl.name}" — ${stored} of ${expected ?? 'unknown'} items stored`);
            continue;
          }
          if (currentNames.has(pl.name)) {
            // STRICTLY ADDITIVE: an existing playlist of the same name is
            // never written into — the restore skips it untouched.
            plan.skipped += 1;
            skippedPlaylists.push(pl.name);
            plan.notes.push(`"${pl.name}" already exists — left untouched`);
            continue;
          }
          // A malformed item URI is dropped and reported rather than aborted:
          // a corrupt row must not stop the rest of the playlist, and it must
          // never reach the wire (#624).
          const rawItems = (pl.items ?? []).filter((it) => typeof it?.uri === 'string');
          const itemUris = wellFormedRows(
            rawItems.map((it) => ({ uri: it.uri as string, name: it.name ?? '' })),
            plan,
          ).map((it) => it.uri);
          const nonStringItems = (pl.items ?? []).length - rawItems.length;
          if (nonStringItems > 0) {
            plan.skipped += nonStringItems;
            plan.notes.push(`${nonStringItems} malformed item(s) dropped from "${pl.name}"`);
          }
          const restoredName = `Restored · ${pl.name} (${dateSuffix})`;
          plan.planned += 1;
          playlistCreations.push({ snapshotName: pl.name, restoredName, itemUris });
          plan.notes.push(`would create "${restoredName}" (${itemUris.length} item(s))`);
        }
      }
    }

    perCategory.push(plan);
  }

  const uniqueShortfalls = shortfalls.filter((reason, index) => shortfalls.indexOf(reason) === index);
  const snapshotState: RestorePlan['snapshotState'] =
    uniqueShortfalls.length > 0 || snapshot._meta?.complete === false
      ? 'partial'
      : snapshot._meta?.snapshot_state ?? 'unknown';
  return {
    snapshotCreated: snapshot._meta?.created ?? null,
    snapshotState,
    restorableComplete: uniqueShortfalls.length > 0 ? false : snapshotState === 'unknown' ? null : true,
    selectedFetched,
    selectedCap,
    shortfalls: uniqueShortfalls,
    perCategory,
    playlistCreations,
    skippedPlaylists,
    reservation: reservationScan,
  };
}

// ---------------------------------------------------------------------------
// Execution (strictly additive writes only, straight off the verified plan)
// ---------------------------------------------------------------------------

type ExecutedByCategory = Partial<Record<RestoreCategory, number>>;

interface CreatedPlaylist {
  snapshotName: string;
  restoredAs: string;
  itemsAdded: number;
}

/**
 * One write that did not land (#624, #734). Every count field is a count of
 * what was ACTUALLY attempted — a count that folded in work still queued
 * would be a guess, and a guess about what landed is worse than no number.
 *
 * `last_committed_chunk` is what made the failure recoverable: knowing which
 * chunk just landed lets the caller re-run the restore and skip forward from
 * there, instead of duplicating the work that already went through. Empty
 * when the failing request was the first of its category.
 */
interface RestoreFailure {
  category: RestoreCategory;
 /**
  * Where in the category's write sequence the failure occurred.
  *
  * `follow_write` was removed with the follow write itself (#638): no
  * endpoint accepts a `spotify:artist:` follow, so a followed-artist restore
  * can no longer fail mid-sequence — it is planned as unrestorable up front.
  */
  stage: 'library_write' | 'playlist_create' | 'playlist_items';
  /** Chunks (or playlists) that completed before the failure. */
  requests_completed: number;
  requests_attempted: number;
  items_written: number;
  items_planned: number;
  items_pending: number;
  /**
   * URIs / IDs of the most recent chunk that landed before the failure (the
   * "last committed chunk", #734). An empty array means the failing request
   * was the first attempt in its stage. For `playlist_create` this is always
   * empty because the stage does not chunk.
   */
  last_committed_chunk: string[];
}

interface RestoreOutcome {
  executed: ExecutedByCategory;
  createdPlaylists: CreatedPlaylist[];
  failures: RestoreFailure[];
  /** Planned playlist creations absent from `createdPlaylists`. */
  playlistsNotCreated: number;
  /**
   * One receipt per created playlist, re-reading the new playlist to confirm
   * its items landed (#879). A 2xx on the add POST is not evidence.
   */
  playlistReceipts: Receipt[];
}

/**
 * One chunked list write, accounted so a mid-run failure is reportable (#734).
 * `lastCommitted` names the URIs of the most recent chunk that landed, so the
 * failure record can carry the chunk a caller should resume from.
 */
async function writeChunked(
  parts: string[][],
  write: (uris: string[]) => Promise<unknown>,
): Promise<{
  completed: number;
  attempted: number;
  itemsWritten: number;
  failed: boolean;
  lastCommitted: string[];
}> {
  let completed = 0;
  let itemsWritten = 0;
  let lastCommitted: string[] = [];
  for (const part of parts) {
    try {
      await write(part);
    } catch {
      return { completed, attempted: completed + 1, itemsWritten, failed: true, lastCommitted };
    }
    completed += 1;
    itemsWritten += part.length;
    lastCommitted = part;
  }
  return { completed, attempted: completed, itemsWritten, failed: false, lastCommitted };
}

/**
 * Perform the planned writes. A failed chunk no longer throws: the categories
 * that already landed stay landed, and the tool reports exactly which chunks
 * and counts landed and which did not, so a half-restored account is
 * described rather than discovered (#624).
 */
async function executeRestore(
  client: SpotifyClient,
  plan: RestorePlan,
  categories: readonly RestoreCategory[],
): Promise<RestoreOutcome> {
  const executed: ExecutedByCategory = {};
  const createdPlaylists: CreatedPlaylist[] = [];
  const playlistReceipts: Receipt[] = [];
  const failures: RestoreFailure[] = [];

  for (const category of categories) {
    const catPlan = plan.perCategory.find((c) => c.category === category);
    if (!catPlan || catPlan.planned === 0) continue;

    if ((LIBRARY_CATEGORIES as readonly string[]).includes(category)) {
      const parts = chunk(catPlan.plannedUris, LIBRARY_WRITE_CHUNK);
      const r = await writeChunked(parts, async (uris) => {
        // `LIBRARY_WRITE_CHUNK` (40) is the documented write cap, and
        // URLSearchParams keeps a snapshot-supplied URI from reshaping the
        // request (#624).
        await client.put(`/me/library?${new URLSearchParams({ uris: uris.join(',') }).toString()}`);
      });
      executed[category] = r.itemsWritten;
      if (r.failed) {
        failures.push({
          category,
          stage: 'library_write',
          requests_completed: r.completed,
          requests_attempted: r.attempted,
          items_written: r.itemsWritten,
          items_planned: catPlan.plannedUris.length,
          items_pending: catPlan.plannedUris.length - r.itemsWritten,
          last_committed_chunk: r.lastCommitted,
        });
      }
    } else if (category === 'followed_artists') {
      // #638: there is no follow write to perform. `PUT /me/following` was
      // removed by Spotify's February 2026 changes and `PUT /me/library` does
      // not accept `spotify:artist:` URIs, so nothing here can restore a
      // follow. The planner already moved every un-followed row into
      // `unrestorable` and named it in the notes, so the plan is empty by
      // construction; recording the zero here keeps `executed` complete
      // rather than leaving the category silently absent, which would read
      // as "not attempted" instead of "not possible".
      executed[category] = 0;
    } else if (category === 'playlists') {
      let addedTotal = 0;
      // Each creation is attempted independently, so one failure is attributed
      // to its own playlist rather than abandoning the rest. A failure record
      // covers only what was actually attempted: counting the creations still
      // queued would report playlists as lost that may be created moments
      // later. The truthful "not created" total is computed once, after the
      // loop, from what the outcome really contains.
      const plannedPlaylists = plan.playlistCreations;
      for (const creation of plannedPlaylists) {
        let created: { id?: string } | null;
        try {
          created = await client.post<{ id?: string }>('/me/playlists', {
            name: creation.restoredName,
            description: `Restored playlist "${creation.snapshotName}" from library snapshot`,
            public: false,
          });
        } catch {
          created = null;
        }
        if (!created?.id) {
          failures.push({
            category,
            stage: 'playlist_create',
            requests_completed: createdPlaylists.length,
            requests_attempted: createdPlaylists.length + 1,
            items_written: addedTotal,
            items_planned: addedTotal + creation.itemUris.length,
            items_pending: creation.itemUris.length,
            // `playlist_create` does not chunk, so there is no "last committed
            // chunk" to report — the create itself is the single request.
            last_committed_chunk: [],
          });
          continue;
        }
        const r = await writeChunked(chunk(creation.itemUris, ADD_ITEMS_CHUNK), async (uris) => {
          await client.post(`/playlists/${created!.id}/items`, { uris });
        });
        addedTotal += r.itemsWritten;
        // The new playlist starts empty, so one re-read over every planned uri
        // says exactly which of them the adds actually landed (#879).
        if (creation.itemUris.length > 0) {
          playlistReceipts.push(
            await issueReceipt(client, {
              kind: 'playlist_items',
              id: created.id,
              uris: creation.itemUris,
            }),
          );
        }
        createdPlaylists.push({
          snapshotName: creation.snapshotName,
          restoredAs: creation.restoredName,
          itemsAdded: r.itemsWritten,
        });
        if (r.failed) {
          failures.push({
            category,
            stage: 'playlist_items',
            requests_completed: r.completed,
            requests_attempted: r.attempted,
            items_written: r.itemsWritten,
            items_planned: creation.itemUris.length,
            items_pending: creation.itemUris.length - r.itemsWritten,
            last_committed_chunk: r.lastCommitted,
          });
        }
      }
      executed[category] = addedTotal;
    }
  }

  return {
    executed,
    createdPlaylists,
    failures,
    playlistReceipts,
    // Truthful by construction: planned creations that are not in the outcome.
    playlistsNotCreated: plan.playlistCreations.length - createdPlaylists.length,
  };
}

// ---------------------------------------------------------------------------
// Result shaping
// ---------------------------------------------------------------------------

function shapeResult(rf: ResponseFormatValue, prose: string, payload: Record<string, unknown>) {
  return {
    content: [
      { type: 'text' as const, text: rf === 'json' ? JSON.stringify(payload, null, 2) : prose },
    ],
    structuredContent: payload,
  };
}

function categoryPayload(plan: CategoryPlan, outcome: RestoreOutcome | null) {
  return {
    total: plan.total,
    already_present: plan.alreadyPresent,
    planned: plan.planned,
    executed: outcome?.executed[plan.category] ?? 0,
    skipped: plan.skipped,
    skipped_invalid: plan.invalidUris.length,
    // #638: rows this restore can read but has no endpoint to write back.
    // Published as its own field rather than folded into `skipped` so a
    // caller can tell "the snapshot row was malformed" from "the platform
    // removed the write" — the first is a data problem, the second is not.
    unrestorable: plan.unrestorable,
    notes: plan.notes,
  };
}

function buildPayload(
  backupPath: string,
  plan: RestorePlan,
  status: string,
  outcome: RestoreOutcome | null,
): Record<string, unknown> {
  const categories: Record<string, unknown> = {};
  for (const c of plan.perCategory) categories[c.category] = categoryPayload(c, outcome);
  const invalidUris = plan.perCategory.flatMap((c) => c.invalidUris);
  return {
    tool: 'restore_library_snapshot',
    backup_path: backupPath,
    snapshot_created: plan.snapshotCreated,
    status,
    snapshot_state: plan.snapshotState,
    restorable_complete: plan.restorableComplete,
    // Three-valued on purpose: a legacy file carrying no _meta says
    // nothing about its own completeness, and null is that answer.
    partial: plan.snapshotState === 'partial' || plan.restorableComplete === false
      ? true
      : plan.snapshotState === 'complete' ? false : null,
    selected_fetched: plan.selectedFetched,
    selected_cap: plan.selectedCap,
    shortfalls: plan.shortfalls,
    skipped_invalid: invalidUris.length,
    ...(invalidUris.length > 0 ? { invalid_uris: invalidUris } : {}),
    ...(outcome && outcome.failures.length > 0 ? { partial_restore: true, failures: outcome.failures } : {}),
    categories,
    playlists: {
      created: (outcome?.createdPlaylists ?? plan.playlistCreations.map((c) => ({
        snapshotName: c.snapshotName,
        restoredAs: c.restoredName,
        itemsAdded: 0,
      }))).map((c) => ({
        snapshot_name: c.snapshotName,
        restored_as: c.restoredAs,
        items_added: c.itemsAdded,
      })),
      skipped_existing: plan.skippedPlaylists,
      // #737: the guard's coverage, so a caller can tell "no playlist of that
      // name exists" from "we did not see the whole account". Null (no walk
      // ran) is deliberately distinct from 0.
      existing_scanned: plan.reservation?.scanned ?? null,
      existing_truncated: plan.reservation?.truncated ?? null,
      existing_scan_cap: plan.reservation?.cap ?? null,
      existing_scan_total: plan.reservation?.reportedTotal ?? null,
      ...(outcome ? { not_created: outcome.playlistsNotCreated } : {}),
      ...(outcome
        ? {
            // The receipts verify the PLANNED playlist items; the executed
            // counter is what the request layer believes it wrote.
            ...writeVerdict(
              outcome.playlistReceipts,
              plan.playlistCreations.reduce((s, c) => s + c.itemUris.length, 0),
            ),
            receipts: receiptRecords(outcome.playlistReceipts),
          }
        : {}),
    },
  };
}

function buildProse(
  backupPath: string,
  plan: RestorePlan,
  status: 'planned' | 'executed' | 'cancelled' | 'partial_restore',
  outcome: RestoreOutcome | null,
  maxItems: number,
): string {
  const done = status === 'executed' || status === 'partial_restore';
  const header =
    status === 'planned'
      ? `Restore plan for ${backupPath} (snapshot created ${plan.snapshotCreated ?? 'unknown date'}) — DRY RUN, nothing written:`
      : status === 'cancelled'
        ? `Restore cancelled for ${backupPath} — zero writes performed. Would-have-done summary:`
        : status === 'partial_restore'
          ? `Restore PARTIAL for ${backupPath} — some writes failed, so the library is only partly restored (nothing existing was modified):`
          : `Restore complete for ${backupPath} (strictly additive; nothing existing was modified):`;
  const lines: string[] = [
    header,
    `Snapshot completeness: ${plan.snapshotState}${plan.restorableComplete === false ? ' — incomplete collections/playlists will not be restored' : ''}`,
  ];
  if (plan.selectedFetched !== null && plan.selectedCap !== null) {
    lines.push(completenessFooter({
      fetched: plan.selectedFetched,
      cap: plan.selectedCap,
      truncated: plan.restorableComplete === false,
      subject: 'selected collection rows',
    }));
  }
  for (const shortfall of plan.shortfalls) lines.push(`  · shortfall: ${shortfall}`);
  for (const c of plan.perCategory) {
    for (const uri of c.invalidUris) {
      lines.push(`  · skipped invalid snapshot URI ${uri} (not a spotify:<type>:<id> URI)`);
    }
  }
  for (const c of plan.perCategory) {
    const bits = [`${c.total} in snapshot`, `${c.alreadyPresent} already present`];
    bits.push(done ? `${outcome?.executed[c.category] ?? 0} written` : `${c.planned} would be written`);
    if (c.skipped > 0) bits.push(`${c.skipped} skipped`);
    if (c.unrestorable > 0) {
      bits.push(
        `${c.unrestorable} NOT RESTORABLE — Spotify removed the endpoint that would write them (#638)`,
      );
    }
    lines.push(`- ${c.category}: ${bits.join(' · ')}`);
  }
  for (const failure of outcome?.failures ?? []) {
    lines.push(
      `  · NOT WRITTEN — ${failure.category} (${failure.stage}): ` +
        `${failure.requests_completed}/${failure.requests_attempted} request(s) succeeded, ` +
        `${failure.items_written}/${failure.items_planned} item(s) landed, ` +
        `${failure.items_pending} still pending. Re-run the restore to finish them.`,
    );
  }
  if (outcome && outcome.playlistsNotCreated > 0) {
    lines.push(
      `  · ${outcome.playlistsNotCreated} planned playlist(s) were never created. Re-run the restore to create them.`,
    );
  }

  // #737: the reservation guard's own coverage, in the same vocabulary as
  // every other collection walk. "Skipped existing playlist" is only a proof
  // for the names this scan actually saw; without this line a clipped scan
  // reads identically to a complete one.
  if (plan.reservation) {
    lines.push(
      `Name-reservation scan: ${completenessFooter({
        fetched: plan.reservation.scanned,
        cap: plan.reservation.cap,
        truncated: plan.reservation.truncated,
        subject: 'existing playlists compared',
        total: plan.reservation.reportedTotal,
      })}`,
    );
    if (plan.reservation.truncated) {
      lines.push(
        '  · the reservation scan was clipped, so a playlist beyond it with a matching name is INVISIBLE ' +
          'to the duplicate guard — the restore is refused rather than risk writing a copy over it. ' +
          'Raise SPOTIFY_MCP_FETCH_ALL_CAP and re-run.',
      );
    }
  }

  // Once writes have run, the per-playlist lines come from the OUTCOME: a
  // playlist whose create failed must not be listed as created, and one that
  // took only some items must not claim them all.
  let detailLines: string[];
  if (done && outcome) {
    const plannedSize = new Map(plan.playlistCreations.map((c) => [c.restoredName, c.itemUris.length]));
    detailLines = outcome.createdPlaylists.map((c) => {
      const expected = plannedSize.get(c.restoredAs);
      return c.itemsAdded === expected
        ? `created "${c.restoredAs}" (${c.itemsAdded} item(s))`
        : `created "${c.restoredAs}" (${c.itemsAdded} of ${expected ?? '?'} item(s) added)`;
    });
    for (const c of plan.playlistCreations) {
      if (!outcome.createdPlaylists.some((made) => made.restoredAs === c.restoredName)) {
        detailLines.push(`NOT created — "${c.restoredName}" (${c.itemUris.length} item(s))`);
      }
    }
  } else {
    detailLines = plan.playlistCreations.map((c) => `would create "${c.restoredName}" (${c.itemUris.length} item(s))`);
  }
  for (const name of plan.skippedPlaylists) {
    detailLines.push(`skipped existing playlist "${name}" — left untouched`);
  }
  const t = truncateItems(detailLines, maxItems);
  for (const d of t.items) lines.push(`  · ${d}`);
  if (t.truncated) lines.push(`  …(${t.remaining} more detail lines — pass max_results to raise)`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerRestoreTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'restore_library_snapshot',
    "STRICTLY ADDITIVE restore of a library snapshot written by backup_library (see list_backups). Adds only what is missing: saves absent tracks/albums/shows/episodes/audiobooks, follows unfollowed artists, and creates NEW playlists named 'Restored · <name> (<snapshot date>)' — existing playlists are never touched and nothing is deleted, renamed, or overwritten. Truncated snapshots are previewable but refused before confirmation or writes; quota-hit, contentless or wrong-schema_version snapshots are refused outright. dry_run defaults to TRUE (read-only preview); setting dry_run=false requires explicit confirmation before any write, fails closed when elicitation is unavailable or errors, and allows writes when SPOTIFY_MCP_CONFIRM=never.",
    {
      backup_path: z
        .string()
        .min(1)
        .describe('Snapshot JSON path from backup_library (see list_backups)'),
      categories: z
        .array(z.enum(RESTORE_CATEGORIES))
        .default([...RESTORE_CATEGORIES])
        .describe('Which snapshot categories to restore. Default: all'),
      dry_run: z
        .boolean()
        .default(true)
        .describe(
          'DEFAULT true: read-only preview of exactly what would be added. Set false to perform the (additive) writes after explicit confirmation.',
        ),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const snapshot = await loadSnapshot(args.backup_path);
      const categories = args.categories as RestoreCategory[];
      const plan = await computeRestorePlan(client, snapshot, categories);
      const maxItems = resolveMaxResults(args.max_results, getConfig().maxItems);
      const plannedTotal = plan.perCategory.reduce((n, c) => n + c.planned, 0);
      if (!args.dry_run && plan.restorableComplete === false) {
        throw new Error(
          `Refusing to restore incomplete snapshot at ${args.backup_path}: ${plan.shortfalls.join('; ')}`,
        );
      }
      // #737: the write path's other fail-closed gate. The tool promises an
      // existing playlist of the same name is never written into or
      // duplicated, and that promise is kept only by the /me/playlists scan
      // having seen the whole account. A clipped scan cannot support it, and
      // proceeding anyway is how a restore silently splits the user's library
      // in two. A dry run is unaffected — it writes nothing, and its plan
      // carries the coverage so the caller can see why the write would stop.
      if (!args.dry_run && plan.reservation?.truncated === true) {
        throw new Error(
          `Refusing to restore into ${args.backup_path}: the name-reservation scan of /me/playlists stopped ` +
            `at ${plan.reservation.scanned} playlist(s) (cap ${plan.reservation.cap}` +
            `${plan.reservation.reportedTotal === null ? '' : `, server reports ${plan.reservation.reportedTotal}`}), ` +
            'so a playlist beyond the scan with a matching name would be invisible and the restore would create ' +
            'a duplicate of it. Raise SPOTIFY_MCP_FETCH_ALL_CAP so the scan can cover the account, then re-run. ' +
            'Run with dry_run (the default) to see the plan and the scan coverage.',
        );
      }

      if (args.dry_run || plannedTotal === 0) {
        return shapeResult(
          rf,
          buildProse(args.backup_path, plan, 'planned', null, maxItems),
          buildPayload(args.backup_path, plan, args.dry_run ? 'planned' : 'nothing_to_add', null),
        );
      }

      // Real writes: explicit confirmation first. Anything short of an
      // explicit accept cancels; elicitation errors and unavailable clients
      // refuse outright. SPOTIFY_MCP_CONFIRM=never is the only bypass.
      const changeLines = plan.perCategory
        .filter((c) => c.planned > 0)
        .map((c) => {
          if (c.category === 'playlists') return `- playlists: create ${c.planned} playlist(s)`;
          return `- ${c.category}: save ${c.planned} item(s)`;
        });
      // #638: the person authorising this restore is told, at the point of
      // authorisation, that a slice of the snapshot cannot be applied. Silence
      // here would be the #1100 failure in a new costume: the prompt lists
      // what WILL change, and a category that quietly drops its rows looks
      // identical to a category with nothing to do.
      for (const c of plan.perCategory) {
        if (c.unrestorable > 0) {
          changeLines.push(
            `- ${c.category}: ${c.unrestorable} item(s) CANNOT be restored — Spotify removed the `
            + 'endpoint that would write them (#638). They are excluded, not attempted.',
          );
        }
      }
      changeLines.push(
        ...plan.playlistCreations.map(
          (c) => `- playlists: create "${c.restoredName}" (${c.itemUris.length} item(s))`,
        ),
      );
      const verdict = await confirmViaElicitation(server, {
        message: [
          `About to restore library snapshot "${args.backup_path}" (created ${plan.snapshotCreated ?? 'unknown date'}).`,
          'STRICTLY ADDITIVE — nothing existing will be modified, renamed, or removed:',
          ...changeLines,
          '',
          'Proceed?',
        ].join('\n'),
        confirmLabel: 'Restore snapshot',
      });

      if (verdict === 'error') {
        throw new Error('Elicitation failed — refusing to restore without confirmation');
      }
      if (verdict === 'unsupported' && process.env.SPOTIFY_MCP_CONFIRM !== 'never') {
        throw new Error('Elicitation unavailable — refusing to restore without confirmation');
      }
      if (verdict === 'declined') {
        return shapeResult(
          rf,
          buildProse(args.backup_path, plan, 'cancelled', null, maxItems),
          buildPayload(args.backup_path, plan, 'cancelled', null),
        );
      }

      const outcome = await executeRestore(client, plan, categories);
      // A failed chunk mid-restore leaves the account partly restored, so the
      // result says so explicitly instead of throwing over landed writes (#624).
      const status = outcome.failures.length > 0 ? 'partial_restore' : 'executed';
      return shapeResult(
        rf,
        buildProse(args.backup_path, plan, status, outcome, maxItems),
        buildPayload(args.backup_path, plan, status, outcome),
      );
    },
  );
}
