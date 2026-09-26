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
import { LIBRARY_BACKUP_SCHEMA_VERSION } from './backup.js';

// ---------------------------------------------------------------------------
// Snapshot shape (#159 BackupBuilder contract)
// ---------------------------------------------------------------------------

/** Saved-library row: {uri,name,added_at}; followed artists omit added_at. */
export interface SnapshotRow {
  uri: string;
  name: string;
  added_at?: string;
}

export interface SnapshotPlaylistItem {
  uri: string;
  name: string;
}

export interface SnapshotPlaylist {
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

export const RESTORE_CATEGORIES = [
  'liked_tracks',
  'saved_albums',
  'saved_shows',
  'saved_episodes',
  'saved_audiobooks',
  'followed_artists',
  'playlists',
] as const;
export type RestoreCategory = (typeof RESTORE_CATEGORIES)[number];

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
export async function loadSnapshot(path: string): Promise<LibrarySnapshot> {
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
export function snapshotDate(snapshot: LibrarySnapshot): string {
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

export interface PlaylistCreation {
  snapshotName: string;
  restoredName: string;
  itemUris: string[];
}

export interface RestorePlan {
  snapshotCreated: string | null;
  snapshotState: 'complete' | 'partial' | 'unknown';
  restorableComplete: boolean | null;
  selectedFetched: number | null;
  selectedCap: number | null;
  shortfalls: string[];
  perCategory: CategoryPlan[];
  playlistCreations: PlaylistCreation[];
  skippedPlaylists: string[];
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
    const res = await client.get<boolean[]>('/me/following/contains', {
      type: 'artist',
      ids: part.join(','),
    });
    if (!res) throw new Error('Could not check current follows (/me/following/contains)');
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
    skipped: 0,
    notes: [],
    invalidUris: [],
  };
}

/** Compute the additive plan with read-only calls only. */
export async function computeRestorePlan(
  client: SpotifyClient,
  snapshot: LibrarySnapshot,
  categories: readonly RestoreCategory[],
): Promise<RestorePlan> {
  const perCategory: CategoryPlan[] = [];
  const playlistCreations: PlaylistCreation[] = [];
  const skippedPlaylists: string[] = [];
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
        ids.forEach((id, i) => {
          if (follows[i]) plan.alreadyPresent += 1;
          else plan.plannedArtistIds.push(id);
        });
        plan.planned = plan.plannedArtistIds.length;
        plan.notes.push(
          ...plan.plannedArtistIds.map((id) => `would follow spotify:artist:${id}`),
        );
      }
    } else if (category === 'playlists') {
      const snapshotPlaylists = snapshot.playlists ?? [];
      plan.total = snapshotPlaylists.length;
      if (snapshotPlaylists.length > 0) {
        const current = await client.getAllPages<{ id: string; name: string }>('/me/playlists', {
          limit: '50',
        });
        const currentNames = new Set(current.map((p) => p.name));
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
  };
}

// ---------------------------------------------------------------------------
// Execution (strictly additive writes only, straight off the verified plan)
// ---------------------------------------------------------------------------

export type ExecutedByCategory = Partial<Record<RestoreCategory, number>>;

export interface CreatedPlaylist {
  snapshotName: string;
  restoredAs: string;
  itemsAdded: number;
}

/**
 * One write that did not land (#624). Every field is a count, never a message:
 * the API's error text is not safe to echo back to a model, and the counts are
 * what a caller needs to decide whether to retry.
 */
export interface RestoreFailure {
  category: RestoreCategory;
 /** Where in the category's write sequence the failure occurred. */
  stage: 'library_write' | 'follow_write' | 'playlist_create' | 'playlist_items';
  /** Chunks (or playlists) that completed before the failure. */
  requests_completed: number;
  requests_attempted: number;
  items_written: number;
  items_planned: number;
  items_pending: number;
  /**
   * Every field is a count of what was ACTUALLY attempted. A count that folded
   * in work still queued would be a guess, and a guess about what landed is
   * worse than no number at all.
   */
}

export interface RestoreOutcome {
  executed: ExecutedByCategory;
  createdPlaylists: CreatedPlaylist[];
  failures: RestoreFailure[];
  /** Planned playlist creations absent from `createdPlaylists`. */
  playlistsNotCreated: number;
}

/** One chunked list write, accounted so a mid-run failure is reportable. */
async function writeChunked(
  parts: string[][],
  write: (uris: string[]) => Promise<unknown>,
): Promise<{ completed: number; attempted: number; itemsWritten: number; failed: boolean }> {
  let completed = 0;
  let itemsWritten = 0;
  for (const part of parts) {
    try {
      await write(part);
    } catch {
      return { completed, attempted: completed + 1, itemsWritten, failed: true };
    }
    completed += 1;
    itemsWritten += part.length;
  }
  return { completed, attempted: completed, itemsWritten, failed: false };
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
        });
      }
    } else if (category === 'followed_artists') {
      const parts = chunk(catPlan.plannedArtistIds, FOLLOW_CHUNK);
      const r = await writeChunked(parts, async (ids) => {
        await client.put(
          `/me/following?${new URLSearchParams({ type: 'artist', ids: ids.join(',') }).toString()}`,
        );
      });
      executed[category] = r.itemsWritten;
      if (r.failed) {
        failures.push({
          category,
          stage: 'follow_write',
          requests_completed: r.completed,
          requests_attempted: r.attempted,
          items_written: r.itemsWritten,
          items_planned: catPlan.plannedArtistIds.length,
          items_pending: catPlan.plannedArtistIds.length - r.itemsWritten,
        });
      }
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
          });
          continue;
        }
        const r = await writeChunked(chunk(creation.itemUris, ADD_ITEMS_CHUNK), async (uris) => {
          await client.post(`/playlists/${created!.id}/items`, { uris });
        });
        addedTotal += r.itemsWritten;
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
      ...(outcome ? { not_created: outcome.playlistsNotCreated } : {}),
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
          if (c.category === 'followed_artists') {
            return `- followed_artists: follow ${c.planned} artist(s)`;
          }
          return `- ${c.category}: save ${c.planned} item(s)`;
        });
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
