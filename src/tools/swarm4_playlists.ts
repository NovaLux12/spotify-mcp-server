/**
 * swarm4 playlists slice — feature swarm v1.25.0 (issues #420–#437).
 *
 * Owned by the fix/swarm4-playlists builder. All tools in this slice are
 * registered here and nowhere else. NOTE: this is NOT tools/playlistops.ts —
 * that file owns merge_playlists/diff_playlists/overlap_playlists (#96).
 *
 * House conventions honoured here:
 *   • shaping.ts helpers only (resolveMaxResults / truncateItems / getAllPages
 *     via the client) — nothing hand-rolled.
 *   • Every mutating tool carries `dry_run` (default TRUE) and performs the
 *     read side + returns a deterministic PLAN when true (#57).
 *   • Playlist item ops use /playlists/{id}/items (Feb-2026 path).
 *   • Order rewrites are atomic: PUT replaces (≤100 URIs per call), the
 *     remainder appends via POST through the serialized client queue,
 *     mirroring replace_playlist_items on main.
 *   • Full-sequence rewrites REFUSE to run when the playlist contains
 *     unavailable items (empty uri) — a rewrite would silently drop them.
 *   • No deprecated endpoints (SPEC §9).
 */
import { z } from 'zod';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { getConfig } from '../config.js';
import { backupDir } from './backup.js';
import {
  ResponseFormat,
  MaxResults,
  batchSummary,
  describeDryRun,
  parseSpotifyUri,
  resolveMaxResults,
  sharedListFields,
  truncateItems,
} from '../shaping.js';
import type { ResponseFormatValue } from '../shaping.js';
import type {
  PlaylistItemObject,
  SpotifyEpisode,
  SpotifyTrack,
} from '../types/spotify.js';
import type { LibraryBackup } from './backup.js';

type TextContent = { type: 'text'; text: string };
type ToolResult = { content: TextContent[]; structuredContent?: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Shared shaping helpers
// ---------------------------------------------------------------------------

/** #51/#52 shaping: json mode stringifies the payload; payload rides as structuredContent. */
function shape(rf: ResponseFormatValue, prose: string, payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: rf === 'json' ? JSON.stringify(payload, null, 2) : prose }],
    structuredContent: payload,
  };
}

/** `dry_run` fragment defaulting to TRUE (repo convention: previews are the default). */
const DryRunDefault = z
  .boolean()
  .optional()
  .default(true)
  .describe(
    'Preview only: perform the read side and return a PLAN without changing anything. '
      + 'Pass false to commit. Default true',
  );

const PublicFlag = z
  .boolean()
  .optional()
  .describe('New playlists public? Default false (private)');

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/** Accept a bare playlist ID or a spotify:playlist: URI; return the raw ID. */
function normalizePlaylistRef(ref: string): string {
  const parsed = parseSpotifyUri(ref);
  if (parsed && parsed.type === 'playlist') return parsed.id;
  return ref.trim();
}

/** Accept a bare artist ID or spotify:artist: URI; return the raw ID. */
function normalizeArtistRef(ref: string): string {
  const parsed = parseSpotifyUri(ref);
  if (parsed && parsed.type === 'artist') return parsed.id;
  return ref.trim();
}

/** Page every item of a playlist (playlist order), capped by the fetch-all cap. */
async function fetchAllItems(client: SpotifyClient, ref: string): Promise<PlaylistItemObject[]> {
  const id = encodeURIComponent(normalizePlaylistRef(ref));
  return client.getAllPages<PlaylistItemObject>(
    `/playlists/${id}/items`,
    { limit: '100' },
    { maxItems: getConfig().fetchAllCap },
  );
}

const isTrack = (p: SpotifyTrack | SpotifyEpisode | null | undefined): p is SpotifyTrack =>
  p?.type === 'track';
const isEpisode = (p: SpotifyTrack | SpotifyEpisode | null | undefined): p is SpotifyEpisode =>
  p?.type === 'episode';

interface LoadedPlaylist {
  id: string;
  name: string | null;
  items: PlaylistItemObject[];
}

/** Playlist metadata + fully paged items; fails fast on a missing playlist. */
async function loadPlaylistFull(client: SpotifyClient, ref: string): Promise<LoadedPlaylist> {
  const id = normalizePlaylistRef(ref);
  const meta = await client.get<{ id?: string; name?: string }>(`/playlists/${encodeURIComponent(id)}`);
  if (!meta) throw new Error(`Playlist "${ref}" not found`);
  const items = await fetchAllItems(client, id);
  return { id, name: meta.name ?? null, items };
}

/**
 * Atomic overwrite: PUT replaces the whole playlist (≤100 URIs per call), so
 * the first chunk does the replacement and any remainder is appended via POST
 * — mirroring replace_playlist_items on main.
 */
async function atomicReplace(
  client: SpotifyClient,
  targetId: string,
  uris: readonly string[],
): Promise<{ requests: number; snapshot_id?: string }> {
  const path = `/playlists/${encodeURIComponent(targetId)}/items`;
  let snapshotId: string | undefined;
  let requests = 0;
  for (let start = 0; start < uris.length; start += 100) {
    const chunk = uris.slice(start, start + 100);
    const res =
      start === 0
        ? await client.put<{ snapshot_id?: string }>(path, { uris: chunk })
        : await client.post<{ snapshot_id?: string }>(path, { uris: chunk });
    if (res?.snapshot_id) snapshotId = res.snapshot_id;
    requests++;
  }
  return { requests, snapshot_id: snapshotId };
}

/** Create a playlist under /me/playlists. */
async function createPlaylist(
  client: SpotifyClient,
  name: string,
  isPublic: boolean,
  description?: string,
): Promise<string> {
  const body: Record<string, unknown> = { name, public: isPublic };
  if (description) body.description = description;
  const created = await client.post<{ id?: string }>('/me/playlists', body);
  if (!created?.id) throw new Error('Could not create playlist');
  return created.id;
}

/** Append URIs in ≤100-URI chunks; returns request accounting. */
async function addUrisChunked(
  client: SpotifyClient,
  targetId: string,
  uris: readonly string[],
): Promise<{ requests: number; snapshot_id?: string }> {
  const path = `/playlists/${encodeURIComponent(targetId)}/items`;
  let snapshotId: string | undefined;
  let requests = 0;
  for (let start = 0; start < uris.length; start += 100) {
    const res = await client.post<{ snapshot_id?: string }>(path, {
      uris: uris.slice(start, start + 100),
    });
    if (res?.snapshot_id) snapshotId = res.snapshot_id;
    requests++;
  }
  return { requests, snapshot_id: snapshotId };
}

/** Fisher–Yates over a copy (sampling helper). */
function shuffleArr<T>(items: readonly T[], rand: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** mulberry32 PRNG — small, fast, deterministic for a given uint32 seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `4312000` ms → `1:11:52`-style clock for prose plans. */
function msToClock(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Today as `YYYY-MM-DD` (default playlist names). */
function formatDateStamp(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Row model
// ---------------------------------------------------------------------------

interface OpRow {
  /** Empty string when the item is unavailable (removed from catalog). */
  uri: string;
  name: string;
  kind: 'track' | 'episode' | 'unavailable';
  durationMs: number | null;
  addedAt: string;
  /** Track artist names, in track order. Episodes: show name. */
  artists: string[];
  artistIds: string[];
  album: string | null;
}

/** Flatten paged playlist entries into rich rows. */
function toRows(items: readonly PlaylistItemObject[]): OpRow[] {
  return items.map((entry) => {
    const p = entry.item;
    if (isTrack(p)) {
      return {
        uri: p.uri,
        name: p.name,
        kind: 'track' as const,
        durationMs: p.duration_ms,
        addedAt: entry.added_at ?? '',
        artists: (p.artists ?? []).map((a) => a.name),
        artistIds: (p.artists ?? []).map((a) => a.id),
        album: p.album?.name ?? null,
      };
    }
    if (isEpisode(p)) {
      return {
        uri: p.uri,
        name: p.name,
        kind: 'episode' as const,
        durationMs: p.duration_ms,
        addedAt: entry.added_at ?? '',
        artists: p.show?.name ? [p.show.name] : [],
        artistIds: [],
        album: null,
      };
    }
    return {
      uri: '',
      name: '(unavailable)',
      kind: 'unavailable' as const,
      durationMs: null,
      addedAt: entry.added_at ?? '',
      artists: [],
      artistIds: [],
      album: null,
    };
  });
}

/** 1-based positions of unavailable items — a full-sequence rewrite would drop these. */
function unavailablePositions(items: readonly PlaylistItemObject[]): number[] {
  return items.map((e, i) => (e.item?.uri ? -1 : i + 1)).filter((p) => p > 0);
}

/**
 * Guard for every committing tool in this slice: the write path is a full
 * atomic replace, so unavailable items (empty uri) would silently vanish.
 */
function assertRewritable(p: LoadedPlaylist): void {
  const bad = unavailablePositions(p.items);
  if (bad.length > 0) {
    const shown = bad.slice(0, 10).join(', ');
    throw new Error(
      `"${p.name ?? p.id}" contains ${bad.length} unavailable item(s) at 1-based position(s) ${shown}` +
        `${bad.length > 10 ? '…' : ''}. A full rewrite would drop them from the playlist. ` +
        `Remove the unavailable items first, then retry.`,
    );
  }
}

/** "Name — Artist" style display label for a row. */
function rowLabel(r: OpRow): string {
  const who = r.artists.length > 0 ? ` — ${r.artists.join(', ')}` : '';
  return `${r.name}${who}`;
}

/** Truncate a row list into prose lines + footer, honoring max_results. */
function renderRows(rows: readonly OpRow[], maxResults: number, marker = '✓'): string[] {
  const view = truncateItems(rows, maxResults);
  const lines = view.items.map((r, i) => `  ${marker} ${i + 1}. ${rowLabel(r)} [${r.uri}]`);
  if (view.footer) lines.push(`  (${view.footer})`);
  return lines;
}

// ---------------------------------------------------------------------------
// Backup-file helpers (snapshots live in backupDir from ./backup.js)
// ---------------------------------------------------------------------------

const SNAPSHOT_RE = /^backup-\d{4}-\d{2}-\d{2}-\d+\.json$/;

interface SnapshotSummary {
  file: string;
  created: string | null;
  playlists: number;
  playlistItems: number;
  likedTracks: number;
}

async function listSnapshotFiles(): Promise<string[]> {
  const dir = backupDir();
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names.filter((n) => SNAPSHOT_RE.test(n)).sort();
}

async function readSnapshot(file: string): Promise<LibraryBackup> {
  const path = join(backupDir(), file);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    const all = await listSnapshotFiles();
    const hint = all.length > 0
      ? ` Available snapshots: ${all.slice(0, 8).join(', ')}${all.length > 8 ? '…' : ''}`
      : ` No snapshots found in ${backupDir()} — run backup_now first.`;
    throw new Error(`Snapshot "${file}" not found.${hint}`);
  }
  const parsed = JSON.parse(raw) as LibraryBackup;
  if (!Array.isArray(parsed?.playlists)) {
    throw new Error(`Snapshot "${file}" is malformed (no playlists array).`);
  }
  return parsed;
}

/** Find one playlist inside a snapshot: exact name first, then case-insensitive substring. */
function findSnapshotPlaylist(
  snap: LibraryBackup,
  file: string,
  wanted: string,
): { uri: string; name: string; item_count: number | null; items: Array<{ uri: string; name: string }> } {
  const wantedLc = wanted.trim().toLowerCase();
  const exact = snap.playlists.find((p) => p.name.toLowerCase() === wantedLc);
  const row = exact ?? snap.playlists.find((p) => p.name.toLowerCase().includes(wantedLc));
  if (!row) {
    const names = snap.playlists.map((p) => p.name).slice(0, 12).join(', ');
    throw new Error(
      `Playlist "${wanted}" not found in snapshot ${file}. ` +
        `Playlists present: ${names}${snap.playlists.length > 12 ? '…' : ''}`,
    );
  }
  return { uri: row.uri, name: row.name, item_count: row.item_count, items: row.items };
}

// ---------------------------------------------------------------------------
// Registration — 18 tools, issues #420–#437
// ---------------------------------------------------------------------------

export function registerSwarm4PlaylistsTools(server: McpServer, client: SpotifyClient): void {
  // -----------------------------------------------------------------------
  // #420 playlist_sort
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_resequence',
    'Sort a playlist in place — by track name, artist, album, duration, or date added — written '
      + 'back as one atomic replace. Episodes sort last (no artist/album key). '
      + 'Quota: 🟢 2 GETs + 1 PUT.',
    {
      playlist_id: z.string().describe('Playlist to sort, as ID or spotify:playlist: URI'),
      sort_by: z
        .enum(['name', 'artist', 'album', 'duration', 'added_at'])
        .describe('Sort key. artist/album use the first artist / album name'),
      direction: z
        .enum(['asc', 'desc'])
        .optional()
        .default('asc')
        .describe('Sort direction. Default asc'),
      dry_run: DryRunDefault,
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      assertRewritable(p);
      const rows = toRows(p.items);
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
      const key = (r: OpRow): string | number | null => {
        switch (args.sort_by) {
          case 'name': return r.name;
          case 'artist': return r.artists[0] ?? null;
          case 'album': return r.album;
          case 'duration': return r.durationMs;
          case 'added_at': return r.addedAt ? Date.parse(r.addedAt) : null;
        }
      };
      const sign = args.direction === 'desc' ? -1 : 1;
      const sorted = [...rows].sort((a, b) => {
        const ka = key(a);
        const kb = key(b);
        if (ka === null && kb === null) return 0;
        if (ka === null) return 1; // nulls last regardless of direction
        if (kb === null) return -1;
        if (typeof ka === 'number' && typeof kb === 'number') return sign * (ka - kb);
        return sign * collator.compare(String(ka), String(kb));
      });
      const uris = sorted.map((r) => r.uri);
      const prose = [
        `${args.direction === 'desc' ? 'Descending' : 'Ascending'} sort of "${p.name ?? p.id}" by ${args.sort_by}:`,
        `  ${rows.length} item(s) would be reordered.`,
        '',
        ...renderRows(sorted, max),
      ];
      const payload = {
        ok: true,
        playlist: p.id,
        playlist_name: p.name,
        sort_by: args.sort_by,
        direction: args.direction,
        items: rows.length,
        order: uris,
        dry_run: args.dry_run,
      };
      if (args.dry_run) {
        return shape(rf, describeDryRun(`sort by ${args.sort_by}`, p.name ?? p.id, prose.slice(1)), payload);
      }
      const res = await atomicReplace(client, p.id, uris);
      return shape(
        rf,
        `Sorted "${p.name ?? p.id}" by ${args.sort_by} (${args.direction}), ${rows.length} item(s).\n`
          + batchSummary(uris.length, uris),
        { ...payload, dry_run: false, requests: res.requests, snapshot_id: res.snapshot_id ?? null },
      );
    },
  );

  // -----------------------------------------------------------------------
  // #421 playlist_rotate
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_rotate',
    'Rotate a playlist by N positions: positive N moves the first N items to the end, negative N '
      + 'moves the last |N| to the front (wraps around). Written as one atomic replace. '
      + 'Quota: 🟢 2 GETs + 1 PUT.',
    {
      playlist_id: z.string().describe('Playlist to rotate, as ID or spotify:playlist: URI'),
      positions: z
        .number()
        .int()
        .describe('Rotation amount; positive = first N move to end, negative = last |N| move to front'),
      dry_run: DryRunDefault,
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      assertRewritable(p);
      const rows = toRows(p.items);
      const n = rows.length;
      if (n === 0) {
        return shape(rf, `"${p.name ?? p.id}" is empty — nothing to rotate.`, { ok: true, items: 0 });
      }
      const shift = ((args.positions % n) + n) % n;
      const rotated = [...rows.slice(shift), ...rows.slice(0, shift)];
      const uris = rotated.map((r) => r.uri);
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const firstNew = rotated[0] ? rowLabel(rotated[0]) : '(empty)';
      const prose = [
        `Rotate "${p.name ?? p.id}" by ${args.positions} (effective ${shift} of ${n}):`,
        `  new first item: ${firstNew}`,
        ...renderRows(rotated, max),
      ];
      const payload = {
        ok: true,
        playlist: p.id,
        playlist_name: p.name,
        positions: args.positions,
        effective_shift: shift,
        items: n,
        order: uris,
        dry_run: args.dry_run,
      };
      if (args.dry_run) {
        return shape(rf, describeDryRun('rotate', p.name ?? p.id, prose.slice(1)), payload);
      }
      const res = await atomicReplace(client, p.id, uris);
      return shape(
        rf,
        `Rotated "${p.name ?? p.id}" by ${args.positions} — now starts with "${firstNew}".\n`
          + batchSummary(uris.length, uris),
        { ...payload, dry_run: false, requests: res.requests, snapshot_id: res.snapshot_id ?? null },
      );
    },
  );

  // -----------------------------------------------------------------------
  // #422 playlist_shuffle
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_seed_shuffle',
    'Shuffle a playlist in place (Fisher–Yates) with an optional deterministic seed — same seed, '
      + 'same order, so you can preview and commit the exact same shuffle. Unavailable items are '
      + 'kept, pinned at the end. Quota: 🟢 2 GETs + 1 PUT.',
    {
      playlist_id: z.string().describe('Playlist to shuffle, as ID or spotify:playlist: URI'),
      seed: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Deterministic seed (0–2^31): the same seed produces the same shuffle. Omit for random'),
      dry_run: DryRunDefault,
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      assertRewritable(p);
      const rows = toRows(p.items);
      const rand = args.seed !== undefined ? mulberry32(args.seed) : Math.random;
      const shuffled = shuffleArr(rows, rand);
      const uris = shuffled.map((r) => r.uri);
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const prose = [
        `Shuffle "${p.name ?? p.id}"${args.seed !== undefined ? ` (seed ${args.seed} — reproducible)` : ''}:`,
        `  ${rows.length} item(s), order randomized.`,
        ...renderRows(shuffled, max),
      ];
      const payload = {
        ok: true,
        playlist: p.id,
        playlist_name: p.name,
        seed: args.seed ?? null,
        items: rows.length,
        order: uris,
        dry_run: args.dry_run,
      };
      if (args.dry_run) {
        return shape(rf, describeDryRun('shuffle', p.name ?? p.id, prose.slice(1)), payload);
      }
      const res = await atomicReplace(client, p.id, uris);
      return shape(
        rf,
        `Shuffled "${p.name ?? p.id}" (${rows.length} item(s)${args.seed !== undefined ? `, seed ${args.seed}` : ''}).\n`
          + batchSummary(uris.length, uris),
        { ...payload, dry_run: false, requests: res.requests, snapshot_id: res.snapshot_id ?? null },
      );
    },
  );

  // -----------------------------------------------------------------------
  // #423 playlist_reverse
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_flip_order',
    'Reverse a playlist: last item becomes first, written as one atomic replace. The standard '
      + 'fix for imports that arrived backwards. Quota: 🟢 2 GETs + 1 PUT.',
    {
      playlist_id: z.string().describe('Playlist to reverse, as ID or spotify:playlist: URI'),
      dry_run: DryRunDefault,
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      assertRewritable(p);
      const rows = toRows(p.items);
      const reversed = [...rows].reverse();
      const uris = reversed.map((r) => r.uri);
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const prose = [
        `Reverse "${p.name ?? p.id}":`,
        `  ${rows.length} item(s); first becomes "${rows.length ? rowLabel(reversed[0]) : '(empty)'}".`,
        ...renderRows(reversed, max),
      ];
      const payload = {
        ok: true,
        playlist: p.id,
        playlist_name: p.name,
        items: rows.length,
        order: uris,
        dry_run: args.dry_run,
      };
      if (args.dry_run) {
        return shape(rf, describeDryRun('reverse', p.name ?? p.id, prose.slice(1)), payload);
      }
      const res = await atomicReplace(client, p.id, uris);
      return shape(
        rf,
        `Reversed "${p.name ?? p.id}" (${rows.length} item(s)).\n` + batchSummary(uris.length, uris),
        { ...payload, dry_run: false, requests: res.requests, snapshot_id: res.snapshot_id ?? null },
      );
    },
  );

  // -----------------------------------------------------------------------
  // #424 playlist_move_block
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_move_block',
    'Move a contiguous block of items (1-based start + count) so its first item lands at a target '
      + 'position expressed in the ORIGINAL numbering. The rest of the playlist closes up around '
      + 'it. Written as one atomic replace. Quota: 🟢 2 GETs + 1 PUT.',
    {
      playlist_id: z.string().describe('Playlist to edit, as ID or spotify:playlist: URI'),
      start: z.number().int().min(1).describe('1-based position of the first item to move'),
      count: z.number().int().min(1).optional().default(1).describe('How many contiguous items to move. Default 1'),
      to_position: z
        .number()
        .int()
        .min(1)
        .describe('1-based position (ORIGINAL numbering) where the block should land'),
      dry_run: DryRunDefault,
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      assertRewritable(p);
      const rows = toRows(p.items);
      const n = rows.length;
      const start = args.start;
      const count = Math.min(args.count, n - start + 1);
      if (start > n || count < 1) {
        return shape(rf, `Position ${args.start} is out of range for "${p.name ?? p.id}" (${n} item(s)).`, {
          ok: false,
          items: n,
        });
      }
      const t = Math.min(Math.max(args.to_position - 1, 0), Math.max(n - 1, 0));
      const block = rows.slice(start - 1, start - 1 + count);
      const rest = [...rows];
      rest.splice(start - 1, count);
      let idx: number;
      if (t < start - 1) idx = t;
      else if (t >= start - 1 + count) idx = t - count;
      else idx = start - 1; // target inside the block itself → no-op
      const moved = [...rest];
      moved.splice(Math.min(idx, moved.length), 0, ...block);
      const uris = moved.map((r) => r.uri);
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const noOp = idx === start - 1 && t >= start - 1 && t < start - 1 + count;
      const prose = [
        noOp
          ? `Move is a no-op: target position ${args.to_position} is inside the block itself.`
          : `Move items ${start}–${start + count - 1} to original position ${args.to_position}:`,
        `  block: ${block.map(rowLabel).join(' | ')}`,
        ...renderRows(moved, max),
      ];
      const payload = {
        ok: true,
        playlist: p.id,
        playlist_name: p.name,
        start,
        count,
        to_position: args.to_position,
        no_op: noOp,
        items: n,
        order: uris,
        dry_run: args.dry_run,
      };
      if (args.dry_run) {
        return shape(rf, describeDryRun('move block', p.name ?? p.id, prose), payload);
      }
      const res = await atomicReplace(client, p.id, uris);
      return shape(
        rf,
        `Moved ${count} item(s) in "${p.name ?? p.id}" (start ${start} → position ${args.to_position}).\n`
          + batchSummary(uris.length, uris),
        { ...payload, dry_run: false, requests: res.requests, snapshot_id: res.snapshot_id ?? null },
      );
    },
  );

  // -----------------------------------------------------------------------
  // #425 playlist_swap_positions
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_swap_positions',
    'Swap the items at two 1-based positions — e.g. flip tracks 3 and 7. Positions may be any '
      + 'two distinct slots in the playlist. Written as one atomic replace. '
      + 'Quota: 🟢 2 GETs + 1 PUT.',
    {
      playlist_id: z.string().describe('Playlist to edit, as ID or spotify:playlist: URI'),
      position_a: z.number().int().min(1).describe('First position (1-based)'),
      position_b: z.number().int().min(1).describe('Second position (1-based)'),
      dry_run: DryRunDefault,
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      assertRewritable(p);
      const rows = toRows(p.items);
      const n = rows.length;
      if (args.position_a > n || args.position_b > n) {
        return shape(rf, `Positions ${args.position_a}/${args.position_b} out of range for "${p.name ?? p.id}" (${n} item(s)).`, {
          ok: false,
          items: n,
        });
      }
      if (args.position_a === args.position_b) {
        return shape(rf, 'position_a and position_b are identical — nothing to swap.', { ok: true, no_op: true, items: n });
      }
      const a = args.position_a - 1;
      const b = args.position_b - 1;
      const swapped = [...rows];
      [swapped[a], swapped[b]] = [swapped[b], swapped[a]];
      const uris = swapped.map((r) => r.uri);
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const prose = [
        `Swap positions ${args.position_a} ↔ ${args.position_b} in "${p.name ?? p.id}":`,
        `  ${args.position_a}: ${rowLabel(rows[a])} → ${rowLabel(rows[b])}`,
        `  ${args.position_b}: ${rowLabel(rows[b])} → ${rowLabel(rows[a])}`,
        ...renderRows(swapped, max),
      ];
      const payload = {
        ok: true,
        playlist: p.id,
        playlist_name: p.name,
        position_a: args.position_a,
        position_b: args.position_b,
        items: n,
        order: uris,
        dry_run: args.dry_run,
      };
      if (args.dry_run) {
        return shape(rf, describeDryRun('swap positions', p.name ?? p.id, prose.slice(1)), payload);
      }
      const res = await atomicReplace(client, p.id, uris);
      return shape(
        rf,
        `Swapped positions ${args.position_a} ↔ ${args.position_b} in "${p.name ?? p.id}".\n`
          + batchSummary(uris.length, uris),
        { ...payload, dry_run: false, requests: res.requests, snapshot_id: res.snapshot_id ?? null },
      );
    },
  );

  // -----------------------------------------------------------------------
  // #426 playlist_dedupe_advanced
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_dedupe_advanced',
    'Remove duplicate items from a playlist, matching by URI (exact copies) OR by track name '
      + '(catches re-adds of the same song from different albums/singles when combined with '
      + 'dedupe by uri). Choose keep-first or keep-last. Written as one atomic replace. '
      + 'Quota: 🟢 2 GETs + 1 PUT.',
    {
      playlist_id: z.string().describe('Playlist to dedupe, as ID or spotify:playlist: URI'),
      keep: z.enum(['first', 'last']).optional().default('first').describe('Which occurrence to keep. Default first'),
      match_by: z
        .enum(['uri', 'name'])
        .optional()
        .default('uri')
        .describe('Duplicate key: exact URI, or case-insensitive track name (catches same song from different releases). Default uri'),
      dry_run: DryRunDefault,
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      assertRewritable(p);
      const rows = toRows(p.items);
      const keyOf = (r: OpRow): string | null =>
        args.match_by === 'uri' ? (r.uri || null) : (r.name.trim().toLowerCase() || null);
      const seen = new Map<string, number>();
      const kept: OpRow[] = [];
      const removed: OpRow[] = [];
      const order = args.keep === 'first' ? rows : [...rows].reverse();
      for (const r of order) {
        const k = keyOf(r);
        if (k === null || !seen.has(k)) {
          if (k !== null) seen.set(k, 1);
          kept.push(r);
        } else {
          removed.push(r);
        }
      }
      const finalRows = args.keep === 'first' ? kept : kept.reverse();
      const uris = finalRows.map((r) => r.uri);
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const prose = [
        `Dedupe "${p.name ?? p.id}" (match by ${args.match_by}, keep ${args.keep}):`,
        `  ${removed.length} duplicate(s) would be removed, ${finalRows.length} item(s) kept.`,
        ...(removed.length > 0 ? ['', 'Removed:', ...renderRows(removed, max, '✗')] : []),
      ];
      const payload = {
        ok: true,
        playlist: p.id,
        playlist_name: p.name,
        match_by: args.match_by,
        keep: args.keep,
        removed: removed.map((r) => r.uri),
        removed_count: removed.length,
        kept_count: finalRows.length,
        order: uris,
        dry_run: args.dry_run,
      };
      if (args.dry_run) {
        return shape(rf, describeDryRun('dedupe', p.name ?? p.id, prose.slice(1)), payload);
      }
      const res = await atomicReplace(client, p.id, uris);
      return shape(
        rf,
        `Deduped "${p.name ?? p.id}": removed ${removed.length} duplicate(s), ${finalRows.length} item(s) kept.\n`
          + batchSummary(uris.length, uris),
        { ...payload, dry_run: false, requests: res.requests, snapshot_id: res.snapshot_id ?? null },
      );
    },
  );

  // -----------------------------------------------------------------------
  // #427 playlist_remove_artist
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_remove_artist',
    'Remove every track by one artist from a playlist (match by artist name, case-insensitive, '
      + 'or by artist ID / spotify:artist: URI). Shows exactly what would go. '
      + 'Quota: 🟢 2 GETs + 1 PUT when committing.',
    {
      playlist_id: z.string().describe('Playlist to edit, as ID or spotify:playlist: URI'),
      artist: z
        .string()
        .describe('Artist name (case-insensitive) or artist ID / spotify:artist: URI'),
      dry_run: DryRunDefault,
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      assertRewritable(p);
      const rows = toRows(p.items);
      const artistRef = normalizeArtistRef(args.artist);
      const looksLikeId = /^[0-9A-Za-z]{22}$/.test(artistRef);
      const nameLc = looksLikeId ? null : args.artist.trim().toLowerCase();
      const matches = (r: OpRow): boolean =>
        looksLikeId ? r.artistIds.includes(artistRef) : r.artists.some((a) => a.toLowerCase() === nameLc);
      const kept = rows.filter((r) => !matches(r));
      const removed = rows.filter(matches);
      const uris = kept.map((r) => r.uri);
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const prose = [
        `Remove ${looksLikeId ? `artist ${artistRef}` : `"${args.artist}"`} from "${p.name ?? p.id}":`,
        `  ${removed.length} track(s) would be removed, ${kept.length} kept.`,
        ...(removed.length > 0 ? ['', 'Removed:', ...renderRows(removed, max, '✗')] : []),
      ];
      const payload = {
        ok: true,
        playlist: p.id,
        playlist_name: p.name,
        artist: looksLikeId ? artistRef : args.artist,
        removed_count: removed.length,
        kept_count: kept.length,
        removed_uris: removed.map((r) => r.uri),
        order: uris,
        dry_run: args.dry_run,
      };
      if (args.dry_run) {
        return shape(rf, describeDryRun('remove artist', p.name ?? p.id, prose.slice(1)), payload);
      }
      if (removed.length === 0) {
        return shape(rf, `No tracks by ${looksLikeId ? artistRef : `"${args.artist}"`} found — playlist unchanged.`, {
          ...payload,
          no_op: true,
        });
      }
      const res = await atomicReplace(client, p.id, uris);
      return shape(
        rf,
        `Removed ${removed.length} track(s) by ${looksLikeId ? artistRef : `"${args.artist}"`} from "${p.name ?? p.id}".\n`
          + batchSummary(uris.length, uris),
        { ...payload, dry_run: false, requests: res.requests, snapshot_id: res.snapshot_id ?? null },
      );
    },
  );

  // -----------------------------------------------------------------------
  // #428 playlist_keep_artist
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_keep_artist',
    'Inverse filter: keep ONLY tracks by one artist in a playlist and drop everything else. '
      + 'Optionally keep podcast episodes too (they have no artist). One atomic replace. '
      + 'Quota: 🟢 2 GETs + 1 PUT.',
    {
      playlist_id: z.string().describe('Playlist to edit, as ID or spotify:playlist: URI'),
      artist: z.string().describe('Artist name (case-insensitive) or artist ID / spotify:artist: URI'),
      keep_episodes: z
        .boolean()
        .optional()
        .default(false)
        .describe('Also keep podcast episodes (they have no artist). Default false'),
      dry_run: DryRunDefault,
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      assertRewritable(p);
      const rows = toRows(p.items);
      const artistRef = normalizeArtistRef(args.artist);
      const looksLikeId = /^[0-9A-Za-z]{22}$/.test(artistRef);
      const nameLc = looksLikeId ? null : args.artist.trim().toLowerCase();
      const byArtist = (r: OpRow): boolean =>
        looksLikeId ? r.artistIds.includes(artistRef) : r.artists.some((a) => a.toLowerCase() === nameLc);
      const kept = rows.filter((r) => byArtist(r) || (args.keep_episodes && r.kind === 'episode'));
      const removed = rows.filter((r) => !kept.includes(r));
      const uris = kept.map((r) => r.uri);
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const prose = [
        `Keep only ${looksLikeId ? `artist ${artistRef}` : `"${args.artist}"`} in "${p.name ?? p.id}":`,
        `  ${kept.length} track(s) kept, ${removed.length} removed${args.keep_episodes ? ' (episodes kept)' : ''}.`,
        ...(kept.length > 0 ? ['', 'Kept:', ...renderRows(kept, max)] : []),
      ];
      const payload = {
        ok: true,
        playlist: p.id,
        playlist_name: p.name,
        artist: looksLikeId ? artistRef : args.artist,
        kept_count: kept.length,
        removed_count: removed.length,
        order: uris,
        dry_run: args.dry_run,
      };
      if (args.dry_run) {
        return shape(rf, describeDryRun('keep artist', p.name ?? p.id, prose.slice(1)), payload);
      }
      const res = await atomicReplace(client, p.id, uris);
      return shape(
        rf,
        `"${p.name ?? p.id}" now holds only ${kept.length} item(s) (kept ${looksLikeId ? artistRef : `"${args.artist}"`}).\n`
          + batchSummary(uris.length, uris),
        { ...payload, dry_run: false, requests: res.requests, snapshot_id: res.snapshot_id ?? null },
      );
    },
  );

  // -----------------------------------------------------------------------
  // #429 playlist_filter_runtime
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_filter_runtime',
    'Keep only items whose duration falls inside a window (e.g. min_sec 120 → drop intros/interludes; '
      + 'max_sec 360 → drop 6-minute epics). At least one bound required. One atomic replace. '
      + 'Quota: 🟢 2 GETs + 1 PUT.',
    {
      playlist_id: z.string().describe('Playlist to filter, as ID or spotify:playlist: URI'),
      min_sec: z.number().int().min(0).optional().describe('Minimum duration in seconds'),
      max_sec: z.number().int().min(1).optional().describe('Maximum duration in seconds'),
      dry_run: DryRunDefault,
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      if (args.min_sec === undefined && args.max_sec === undefined) {
        return shape(rf, 'Provide min_sec, max_sec, or both.', { ok: false });
      }
      if (args.min_sec !== undefined && args.max_sec !== undefined && args.min_sec > args.max_sec) {
        return shape(rf, `min_sec (${args.min_sec}) is greater than max_sec (${args.max_sec}).`, { ok: false });
      }
      const p = await loadPlaylistFull(client, args.playlist_id);
      assertRewritable(p);
      const rows = toRows(p.items);
      const inWindow = (r: OpRow): boolean =>
        r.durationMs !== null &&
        (args.min_sec === undefined || r.durationMs >= args.min_sec * 1000) &&
        (args.max_sec === undefined || r.durationMs <= args.max_sec * 1000);
      const kept = rows.filter(inWindow);
      const removed = rows.filter((r) => !inWindow(r));
      const totalMs = kept.reduce((s, r) => s + (r.durationMs ?? 0), 0);
      const uris = kept.map((r) => r.uri);
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const window = [
        args.min_sec !== undefined ? `≥ ${msToClock(args.min_sec * 1000)}` : null,
        args.max_sec !== undefined ? `≤ ${msToClock(args.max_sec * 1000)}` : null,
      ]
        .filter(Boolean)
        .join(' and ');
      const prose = [
        `Filter "${p.name ?? p.id}" to duration ${window}:`,
        `  ${kept.length} item(s) kept (runtime ${msToClock(totalMs)}), ${removed.length} removed.`,
        ...(removed.length > 0 ? ['', 'Removed:', ...renderRows(removed, max, '✗')] : []),
      ];
      const payload = {
        ok: true,
        playlist: p.id,
        playlist_name: p.name,
        min_sec: args.min_sec ?? null,
        max_sec: args.max_sec ?? null,
        kept_count: kept.length,
        removed_count: removed.length,
        kept_runtime_ms: totalMs,
        removed_uris: removed.map((r) => r.uri),
        order: uris,
        dry_run: args.dry_run,
      };
      if (args.dry_run) {
        return shape(rf, describeDryRun('runtime filter', p.name ?? p.id, prose.slice(1)), payload);
      }
      const res = await atomicReplace(client, p.id, uris);
      return shape(
        rf,
        `Filtered "${p.name ?? p.id}": ${kept.length} item(s) kept (runtime ${msToClock(totalMs)}), ${removed.length} removed.\n`
          + batchSummary(uris.length, uris),
        { ...payload, dry_run: false, requests: res.requests, snapshot_id: res.snapshot_id ?? null },
      );
    },
  );

  // -----------------------------------------------------------------------
  // #430 playlist_chunk_preview
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_chunk_preview',
    'Read-only pagination preview: how a playlist splits into write-sized chunks (the 100-URI '
      + 'replace limit) or any custom size — per-chunk position ranges, first/last items, and '
      + 'item counts. Plan batched edits before running them. Quota: 🟢 2 GETs.',
    {
      playlist_id: z.string().describe('Playlist to preview, as ID or spotify:playlist: URI'),
      page_size: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .default(100)
        .describe('Items per chunk to simulate. Default 100 (the atomic-replace limit)'),
      offset: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(1)
        .describe('1-based item position to start the first chunk at. Default 1'),
      chunks_to_show: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(5)
        .describe('How many chunks to detail. Default 5'),
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      const rows = toRows(p.items);
      const start = Math.min(args.offset, Math.max(rows.length, 1));
      const total = rows.slice(start - 1).length;
      const chunkCount = total === 0 ? 0 : Math.ceil(total / args.page_size);
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const shown = Math.min(args.chunks_to_show, chunkCount, max);
      const lines: string[] = [];
      for (let c = 0; c < shown; c++) {
        const from = start + c * args.page_size;
        const to = Math.min(from + args.page_size - 1, start + total - 1);
        const first = rows[from - 1];
        const last = rows[to - 1];
        lines.push(
          `  chunk ${c + 1}: positions ${from}–${to} (${to - from + 1} items) — ` +
            `first "${rowLabel(first)}" / last "${rowLabel(last)}"`,
        );
      }
      if (chunkCount > shown) lines.push(`  … ${chunkCount - shown} more chunk(s) not shown.`);
      const prose = [
        `Chunk preview for "${p.name ?? p.id}" (page_size ${args.page_size}, offset ${start}):`,
        `  ${rows.length} item(s) total → ${chunkCount} chunk(s).`,
        ...(lines.length > 0 ? ['', ...lines] : ['  (nothing to preview)']),
      ];
      return shape(rf, prose.join('\n'), {
        ok: true,
        playlist: p.id,
        playlist_name: p.name,
        items: rows.length,
        offset: start,
        page_size: args.page_size,
        chunk_count: chunkCount,
        chunks: Array.from({ length: shown }, (_, c) => {
          const from = start + c * args.page_size;
          const to = Math.min(from + args.page_size - 1, start + total - 1);
          return { first_position: from, last_position: to, items: to - from + 1 };
        }),
      });
    },
  );

  // -----------------------------------------------------------------------
  // #431 playlist_diff
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_diff',
    'Compare two playlists: what is only in A, only in B, and in both — plus whether the shared '
      + 'tracks appear in the same relative order. Read-only. Quota: 🟢 4 GETs.',
    {
      playlist_a_id: z.string().describe('First playlist, as ID or spotify:playlist: URI'),
      playlist_b_id: z.string().describe('Second playlist, as ID or spotify:playlist: URI'),
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const a = await loadPlaylistFull(client, args.playlist_a_id);
      const b = await loadPlaylistFull(client, args.playlist_b_id);
      const rowsA = toRows(a.items);
      const rowsB = toRows(b.items);
      const setA = new Map<string, OpRow>();
      rowsA.forEach((r) => { if (r.uri) setA.set(r.uri, r); });
      const setB = new Map<string, OpRow>();
      rowsB.forEach((r) => { if (r.uri) setB.set(r.uri, r); });
      const onlyA = rowsA.filter((r) => r.uri && !setB.has(r.uri));
      const onlyB = rowsB.filter((r) => r.uri && !setA.has(r.uri));
      const common = rowsA.filter((r) => r.uri && setB.has(r.uri));
      const orderB = rowsB.filter((r) => r.uri && setA.has(r.uri)).map((r) => r.uri);
      const sameOrder = common.map((r) => r.uri).join('|') === orderB.join('|');
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const prose = [
        `Diff "${a.name ?? a.id}" (${rowsA.length}) vs "${b.name ?? b.id}" (${rowsB.length}):`,
        `  common: ${common.length} · only in A: ${onlyA.length} · only in B: ${onlyB.length}`,
        `  shared tracks in same relative order: ${sameOrder ? 'yes' : 'no'}`,
        ...(onlyA.length > 0 ? ['', `Only in "${a.name ?? a.id}":`, ...renderRows(onlyA, max, 'A')] : []),
        ...(onlyB.length > 0 ? ['', `Only in "${b.name ?? b.id}":`, ...renderRows(onlyB, max, 'B')] : []),
      ];
      return shape(rf, prose.join('\n'), {
        ok: true,
        playlist_a: { id: a.id, name: a.name, items: rowsA.length },
        playlist_b: { id: b.id, name: b.name, items: rowsB.length },
        common_count: common.length,
        only_in_a: onlyA.map((r) => r.uri),
        only_in_b: onlyB.map((r) => r.uri),
        same_order: sameOrder,
      });
    },
  );

  // -----------------------------------------------------------------------
  // #432 playlist_history
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_history',
    'List your local backup snapshots (from backup_now): file name, created timestamp, and the '
      + 'counts each snapshot carries. The entry point for snapshot_detail / changelog / '
      + 'clone_snapshot. Read-only, no API calls.',
    {
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const files = await listSnapshotFiles();
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const view = truncateItems(files, max);
      const rows: SnapshotSummary[] = [];
      for (const file of view.items) {
        try {
          const snap = await readSnapshot(file);
          rows.push({
            file,
            created: snap._meta?.created ?? null,
            playlists: snap._meta?.counts?.playlists ?? snap.playlists.length,
            playlistItems: snap._meta?.counts?.playlist_items ?? 0,
            likedTracks: snap._meta?.counts?.liked_tracks ?? snap.liked_tracks.length,
          });
        } catch {
          rows.push({ file, created: null, playlists: -1, playlistItems: -1, likedTracks: -1 });
        }
      }
      const prose = [
        `Backup snapshots in ${backupDir()}: ${files.length} file(s).`,
        ...(rows.length > 0
          ? [
              '',
              ...rows.map(
                (r) =>
                  `  • ${r.file} — created ${r.created ?? '?'} · ${r.playlists < 0 ? 'unreadable' : `${r.playlists} playlists`}`
                    + `${r.playlists >= 0 ? ` / ${r.playlistItems} items / ${r.likedTracks} liked tracks` : ''}`,
              ),
              view.footer ? `  (${view.footer})` : '',
            ].filter(Boolean)
          : ['  (none yet — run backup_now to create one)']),
      ];
      return shape(rf, prose.join('\n'), {
        ok: true,
        backup_dir: backupDir(),
        snapshot_count: files.length,
        snapshots: rows.map((r) => ({
          file: r.file,
          created: r.created,
          playlists: r.playlists,
          playlist_items: r.playlistItems,
          liked_tracks: r.likedTracks,
        })),
      });
    },
  );

  // -----------------------------------------------------------------------
  // #433 playlist_snapshot_detail
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_snapshot_detail',
    'Inspect one playlist inside a local backup snapshot: its item_count as recorded plus the '
      + 'full item list (truncated by max_results). Read-only, no API calls.',
    {
      backup_file: z.string().describe('Snapshot file name, e.g. backup-2026-08-28-1.json (see playlist_history)'),
      playlist_name: z
        .string()
        .describe('Playlist name inside the snapshot (exact match first, then case-insensitive substring)'),
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const snap = await readSnapshot(args.backup_file);
      const row = findSnapshotPlaylist(snap, args.backup_file, args.playlist_name);
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const pseudoRows: OpRow[] = row.items.map((it) => ({
        uri: it.uri,
        name: it.name,
        kind: 'track',
        durationMs: null,
        addedAt: '',
        artists: [],
        artistIds: [],
        album: null,
      }));
      const prose = [
        `"${row.name}" in snapshot ${args.backup_file}:`,
        `  recorded item_count: ${row.item_count ?? row.items.length} · items stored: ${row.items.length}`,
        '',
        ...renderRows(pseudoRows, max),
      ];
      return shape(rf, prose.join('\n'), {
        ok: true,
        backup_file: args.backup_file,
        playlist: row.uri,
        playlist_name: row.name,
        recorded_item_count: row.item_count,
        items_stored: row.items.length,
        items: row.items,
      });
    },
  );

  // -----------------------------------------------------------------------
  // #434 playlist_clone_snapshot
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_clone_snapshot',
    'Restore a playlist from a local backup snapshot as a NEW playlist (never overwrites the '
      + 'live one — clone, don\'t clobber). Items restore by URI; catalog-removed items are '
      + 'skipped by Spotify automatically. Quota: 🟡 0 GETs + create + chunked adds.',
    {
      backup_file: z.string().describe('Snapshot file name, e.g. backup-2026-08-28-1.json (see playlist_history)'),
      playlist_name: z.string().describe('Playlist name inside the snapshot to clone'),
      new_name: z.string().optional().describe('Name for the new playlist. Default "<name> (restored YYYY-MM-DD)"'),
      public: PublicFlag,
      dry_run: DryRunDefault,
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const snap = await readSnapshot(args.backup_file);
      const row = findSnapshotPlaylist(snap, args.backup_file, args.playlist_name);
      const uris = row.items.map((it) => it.uri).filter(Boolean);
      const name = args.new_name ?? `${row.name} (restored ${formatDateStamp()})`;
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const pseudoRows: OpRow[] = row.items
        .filter((it) => it.uri)
        .map((it) => ({
          uri: it.uri,
          name: it.name,
          kind: 'track' as const,
          durationMs: null,
          addedAt: '',
          artists: [],
          artistIds: [],
          album: null,
        }));
      const payload = {
        ok: true,
        backup_file: args.backup_file,
        source_playlist: row.name,
        new_name: name,
        items: uris.length,
        uris,
        dry_run: args.dry_run,
      };
      if (args.dry_run) {
        return shape(rf, describeDryRun('clone from snapshot', `new playlist "${name}"`, [
          `Create "${name}" with ${uris.length} item(s) from snapshot ${args.backup_file}:`,
          ...renderRows(pseudoRows, max),
        ]), payload);
      }
      const created = await createPlaylist(client, name, args.public ?? false, `Restored from snapshot ${args.backup_file}`);
      const add = uris.length > 0 ? await addUrisChunked(client, created, uris) : { requests: 0 };
      return shape(
        rf,
        `Cloned "${row.name}" from snapshot ${args.backup_file} into new playlist ${created} `
          + `("${name}", ${uris.length} item(s), ${add.requests} add request(s)).`,
        { ...payload, dry_run: false, playlist_id: created, requests: add.requests },
      );
    },
  );

  // -----------------------------------------------------------------------
  // #435 playlist_changelog
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_changelog',
    'Diff ONE playlist across two backup snapshots (older → newer): tracks added, removed, and '
      + 'kept — plus whether the kept tracks were reordered. The "what changed since last week" '
      + 'view. Read-only, no API calls.',
    {
      backup_file_a: z.string().describe('OLDER snapshot file name (baseline)'),
      backup_file_b: z.string().describe('NEWER snapshot file name (comparison)'),
      playlist_name: z.string().describe('Playlist name to compare (exact first, then substring)'),
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const snapA = await readSnapshot(args.backup_file_a);
      const snapB = await readSnapshot(args.backup_file_b);
      const rowA = findSnapshotPlaylist(snapA, args.backup_file_a, args.playlist_name);
      const rowB = findSnapshotPlaylist(snapB, args.backup_file_b, args.playlist_name);
      const urisA = rowA.items.map((it) => it.uri);
      const urisB = rowB.items.map((it) => it.uri);
      const setA = new Set(urisA);
      const setB = new Set(urisB);
      const nameOf = (snap: LibraryBackup, uri: string): string =>
        snap.playlists
          .flatMap((p) => p.items)
          .find((it) => it.uri === uri)?.name ?? uri;
      const added = urisB.filter((u) => !setA.has(u));
      const removed = urisA.filter((u) => !setB.has(u));
      const keptA = urisA.filter((u) => setB.has(u));
      const keptB = urisB.filter((u) => setA.has(u));
      const reordered = keptA.join('|') !== keptB.join('|');
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const asRows = (uris: readonly string[], names: Map<string, string>): OpRow[] =>
        uris.map((u) => ({
          uri: u,
          name: names.get(u) ?? u,
          kind: 'track' as const,
          durationMs: null,
          addedAt: '',
          artists: [],
          artistIds: [],
          album: null,
        }));
      const nameMap = new Map<string, string>();
      for (const p of [...snapA.playlists, ...snapB.playlists]) {
        for (const it of p.items) nameMap.set(it.uri, it.name);
      }
      const prose = [
        `Changelog for "${rowA.name}" — ${args.backup_file_a} → ${args.backup_file_b}:`,
        `  ${rowA.items.length} → ${rowB.items.length} items · +${added.length} added / -${removed.length} removed / ${keptA.length} kept`,
        reordered ? '  kept tracks were REORDERED between snapshots.' : '  kept tracks kept their relative order.',
        ...(added.length > 0 ? ['', 'Added:', ...renderRows(asRows(added, nameMap), max, '+')] : []),
        ...(removed.length > 0 ? ['', 'Removed:', ...renderRows(asRows(removed, nameMap), max, '-')] : []),
      ];
      return shape(rf, prose.join('\n'), {
        ok: true,
        playlist: rowA.uri,
        playlist_name: rowA.name,
        baseline_file: args.backup_file_a,
        comparison_file: args.backup_file_b,
        items_before: rowA.items.length,
        items_after: rowB.items.length,
        added: added.map((u) => ({ uri: u, name: nameMap.get(u) ?? u })),
        removed: removed.map((u) => ({ uri: u, name: nameMap.get(u) ?? u })),
        kept_count: keptA.length,
        reordered,
      });
    },
  );

  // -----------------------------------------------------------------------
  // #436 playlist_pair_check
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_pair_check',
    'Pairwise relationship report for two playlists: sizes, overlap, Jaccard similarity, and '
      + 'sampled candidates from each side that the other lacks (for merging or splitting '
      + 'decisions). Read-only. Quota: 🟢 4 GETs.',
    {
      playlist_a_id: z.string().describe('First playlist, as ID or spotify:playlist: URI'),
      playlist_b_id: z.string().describe('Second playlist, as ID or spotify:playlist: URI'),
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const a = await loadPlaylistFull(client, args.playlist_a_id);
      const b = await loadPlaylistFull(client, args.playlist_b_id);
      const rowsA = toRows(a.items).filter((r) => r.uri);
      const rowsB = toRows(b.items).filter((r) => r.uri);
      const setA = new Set(rowsA.map((r) => r.uri));
      const setB = new Set(rowsB.map((r) => r.uri));
      const overlap = rowsA.filter((r) => setB.has(r.uri));
      const onlyA = rowsA.filter((r) => !setB.has(r.uri));
      const onlyB = rowsB.filter((r) => !setA.has(r.uri));
      const union = setA.size + setB.size - overlap.length;
      const jaccard = union === 0 ? 1 : overlap.length / union;
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const prose = [
        `Pair check "${a.name ?? a.id}" (${rowsA.length}) ↔ "${b.name ?? b.id}" (${rowsB.length}):`,
        `  overlap ${overlap.length} · Jaccard ${jaccard.toFixed(3)} · only-A ${onlyA.length} · only-B ${onlyB.length}`,
        ...(onlyA.length > 0 ? ['', `"${a.name ?? a.id}" lacks (from B):`, ...renderRows(onlyB, max, '→')] : []),
        ...(onlyB.length > 0 ? ['', `"${b.name ?? b.id}" lacks (from A):`, ...renderRows(onlyA, max, '→')] : []),
      ];
      return shape(rf, prose.join('\n'), {
        ok: true,
        playlist_a: { id: a.id, name: a.name, items: rowsA.length },
        playlist_b: { id: b.id, name: b.name, items: rowsB.length },
        overlap_count: overlap.length,
        only_in_a: onlyA.map((r) => r.uri),
        only_in_b: onlyB.map((r) => r.uri),
        jaccard: Number(jaccard.toFixed(4)),
      });
    },
  );

  // -----------------------------------------------------------------------
  // #437 playlist_balance
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_balance',
    'Split a playlist into N balanced new playlists: sequential chunks (part 1 = first third, …) '
      + 'or interleave (round-robin deal, so every part samples the whole span). Creates N new '
      + 'playlists; the source is left untouched. Quota: 🟡 2 GETs + N creates + chunked adds.',
    {
      playlist_id: z.string().describe('Playlist to split, as ID or spotify:playlist: URI'),
      parts: z.number().int().min(2).max(10).describe('How many playlists to create (2–10)'),
      strategy: z
        .enum(['sequential', 'interleave'])
        .optional()
        .default('interleave')
        .describe('sequential = contiguous chunks in order; interleave = round-robin deal. Default interleave'),
      name_prefix: z
        .string()
        .optional()
        .describe('Name prefix for the new playlists. Default "<source name> — Part"'),
      public: PublicFlag,
      dry_run: DryRunDefault,
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      assertRewritable(p);
      const rows = toRows(p.items);
      const n = rows.length;
      if (n < args.parts) {
        return shape(rf, `"${p.name ?? p.id}" has ${n} item(s) — fewer than the ${args.parts} parts requested.`, {
          ok: false,
          items: n,
        });
      }
      const prefix = args.name_prefix ?? `${p.name ?? 'Playlist'} — Part`;
      const buckets: OpRow[][] = Array.from({ length: args.parts }, () => []);
      if (args.strategy === 'sequential') {
        const base = Math.floor(n / args.parts);
        const rem = n % args.parts;
        let at = 0;
        for (let i = 0; i < args.parts; i++) {
          const size = base + (i < rem ? 1 : 0);
          buckets[i] = rows.slice(at, at + size);
          at += size;
        }
      } else {
        rows.forEach((r, i) => buckets[i % args.parts].push(r));
      }
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const names = buckets.map((_, i) => `${prefix} ${i + 1}`);
      const prose = [
        `Split "${p.name ?? p.id}" (${n} items) into ${args.parts} ${args.strategy} playlists:`,
        ...buckets.map(
          (b, i) => `  "${names[i]}": ${b.length} item(s), runtime ${msToClock(b.reduce((s, r) => s + (r.durationMs ?? 0), 0))}`,
        ),
        ...buckets.flatMap((b, i) => [``, `Part ${i + 1}:`, ...renderRows(b, max)]),
      ];
      const payload = {
        ok: true,
        playlist: p.id,
        playlist_name: p.name,
        parts: args.parts,
        strategy: args.strategy,
        names,
        buckets: buckets.map((b) => b.map((r) => r.uri)),
        dry_run: args.dry_run,
      };
      if (args.dry_run) {
        return shape(rf, describeDryRun('balance split', p.name ?? p.id, prose.slice(1)), payload);
      }
      const created: string[] = [];
      let requests = 0;
      for (let i = 0; i < args.parts; i++) {
        const id = await createPlaylist(client, names[i], args.public ?? false, `Part ${i + 1} of ${args.parts} (from ${p.name ?? p.id})`);
        created.push(id);
        const add = buckets[i].length > 0 ? await addUrisChunked(client, id, buckets[i].map((r) => r.uri)) : { requests: 0 };
        requests += 1 + add.requests;
      }
      return shape(
        rf,
        `Split "${p.name ?? p.id}" into ${args.parts} new playlists:\n`
          + buckets.map((b, i) => `  • "${names[i]}" (${created[i]}): ${b.length} item(s)`).join('\n'),
        { ...payload, dry_run: false, playlist_ids: created, requests },
      );
    },
  );
}
