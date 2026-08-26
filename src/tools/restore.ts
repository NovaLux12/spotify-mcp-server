/**
 * restore_library_snapshot (#160): STRICTLY ADDITIVE restore of a library
 * snapshot produced by backup_library_snapshot (#159 contract).
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
 *    writes; an environment without elicitation support (or with
 *    SPOTIFY_MCP_CONFIRM=never) refuses restores entirely rather than
 *    proceeding silently.
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
  truncateItems,
} from '../shaping.js';
import type { ResponseFormatValue } from '../shaping.js';
import { getConfig } from '../config.js';
import { confirmViaElicitation } from './confirm.js';

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
}

export interface LibrarySnapshot {
  _meta?: { created?: string; notes?: string; counts?: Record<string, unknown> };
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

const LIBRARY_CONTAINS_CHUNK = 50;
const FOLLOW_CHUNK = 50;
const ADD_ITEMS_CHUNK = 100;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
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
  notes: string[];
}

export interface PlaylistCreation {
  snapshotName: string;
  restoredName: string;
  itemUris: string[];
}

export interface RestorePlan {
  snapshotCreated: string | null;
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

  for (const category of categories) {
    const plan = freshCategoryPlan(category);

    if ((LIBRARY_CATEGORIES as readonly string[]).includes(category)) {
      const rows = dedupeRows((snapshot[category] ?? []) as SnapshotRow[], plan);
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
      const rows = dedupeRows(snapshot.followed_artists ?? [], plan);
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
          if (currentNames.has(pl.name)) {
            // STRICTLY ADDITIVE: an existing playlist of the same name is
            // never written into — the restore skips it untouched.
            plan.skipped += 1;
            skippedPlaylists.push(pl.name);
            plan.notes.push(`"${pl.name}" already exists — left untouched`);
            continue;
          }
          const itemUris = (pl.items ?? [])
            .filter((it) => typeof it?.uri === 'string')
            .map((it) => it.uri);
          const dropped = (pl.items ?? []).length - itemUris.length;
          if (dropped > 0) {
            plan.skipped += dropped;
            plan.notes.push(`${dropped} malformed item(s) dropped from "${pl.name}"`);
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

  return {
    snapshotCreated: snapshot._meta?.created ?? null,
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

export interface RestoreOutcome {
  executed: ExecutedByCategory;
  createdPlaylists: CreatedPlaylist[];
}

async function executeRestore(
  client: SpotifyClient,
  plan: RestorePlan,
  categories: readonly RestoreCategory[],
): Promise<RestoreOutcome> {
  const executed: ExecutedByCategory = {};
  const createdPlaylists: CreatedPlaylist[] = [];

  for (const category of categories) {
    const catPlan = plan.perCategory.find((c) => c.category === category);
    if (!catPlan || catPlan.planned === 0) continue;

    if ((LIBRARY_CATEGORIES as readonly string[]).includes(category)) {
      for (const part of chunk(catPlan.plannedUris, LIBRARY_CONTAINS_CHUNK)) {
        await client.put(`/me/library?uris=${part.join(',')}`);
      }
      executed[category] = catPlan.plannedUris.length;
    } else if (category === 'followed_artists') {
      for (const part of chunk(catPlan.plannedArtistIds, FOLLOW_CHUNK)) {
        await client.put(`/me/following?type=artist&ids=${part.join(',')}`);
      }
      executed[category] = catPlan.plannedArtistIds.length;
    } else if (category === 'playlists') {
      let addedTotal = 0;
      for (const creation of plan.playlistCreations) {
        const created = await client.post<{ id?: string }>('/me/playlists', {
          name: creation.restoredName,
          description: `Restored playlist "${creation.snapshotName}" from library snapshot`,
          public: false,
        });
        if (!created?.id) {
          throw new Error(`Failed to create playlist "${creation.restoredName}"`);
        }
        let added = 0;
        for (const part of chunk(creation.itemUris, ADD_ITEMS_CHUNK)) {
          await client.post(`/playlists/${created.id}/items`, { uris: part });
          added += part.length;
        }
        addedTotal += added;
        createdPlaylists.push({
          snapshotName: creation.snapshotName,
          restoredAs: creation.restoredName,
          itemsAdded: added,
        });
      }
      executed[category] = addedTotal;
    }
  }

  return { executed, createdPlaylists };
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
  return {
    tool: 'restore_library_snapshot',
    backup_path: backupPath,
    snapshot_created: plan.snapshotCreated,
    status,
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
    },
  };
}

function buildProse(
  backupPath: string,
  plan: RestorePlan,
  status: 'planned' | 'executed' | 'cancelled',
  outcome: RestoreOutcome | null,
  maxItems: number,
): string {
  const done = status === 'executed';
  const header =
    status === 'planned'
      ? `Restore plan for ${backupPath} (snapshot created ${plan.snapshotCreated ?? 'unknown date'}) — DRY RUN, nothing written:`
      : status === 'cancelled'
        ? `Restore cancelled for ${backupPath} — zero writes performed. Would-have-done summary:`
        : `Restore complete for ${backupPath} (strictly additive; nothing existing was modified):`;
  const lines: string[] = [header];

  for (const c of plan.perCategory) {
    const bits = [`${c.total} in snapshot`, `${c.alreadyPresent} already present`];
    bits.push(done ? `${outcome?.executed[c.category] ?? 0} written` : `${c.planned} would be written`);
    if (c.skipped > 0) bits.push(`${c.skipped} skipped`);
    lines.push(`- ${c.category}: ${bits.join(' · ')}`);
  }

  const detailLines: string[] = plan.playlistCreations.map((c) =>
    done
      ? `created "${c.restoredName}" (${c.itemUris.length} item(s))`
      : `would create "${c.restoredName}" (${c.itemUris.length} item(s))`,
  );
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
    "STRICTLY ADDITIVE restore of a library snapshot written by backup_library_snapshot. Adds only what is missing: saves absent tracks/albums/shows/episodes/audiobooks, follows unfollowed artists, and creates NEW playlists named 'Restored · <name> (<snapshot date>)' — existing playlists are never touched and nothing is ever deleted, renamed, or overwritten. dry_run defaults to TRUE (read-only preview); setting dry_run=false requires explicit interactive confirmation before any write, and restores are refused entirely in environments without confirmation support.",
    {
      backup_path: z
        .string()
        .min(1)
        .describe('Path to the snapshot JSON file from backup_library_snapshot'),
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

      if (args.dry_run || plannedTotal === 0) {
        return shapeResult(
          rf,
          buildProse(args.backup_path, plan, 'planned', null, maxItems),
          buildPayload(args.backup_path, plan, args.dry_run ? 'planned' : 'nothing_to_add', null),
        );
      }

      // Real writes: explicit confirmation first. Anything short of an
      // explicit accept cancels; no elicitation support refuses outright —
      // restores must never proceed silently.
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

      if (verdict === 'unsupported') {
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
      return shapeResult(
        rf,
        buildProse(args.backup_path, plan, 'executed', outcome, maxItems),
        buildPayload(args.backup_path, plan, 'executed', outcome),
      );
    },
  );
}
