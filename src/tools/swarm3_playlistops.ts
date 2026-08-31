/**
 * swarm3 playlistops slice — 500-tool swarm v1.26.0 (issue #442). Owned by PLAYLISTOPS builder.
 *
 * 24 playlist-ops tools: sort / reverse / rotate / interleave / merge / set-ops /
 * range extract+remove / dedupe / split / filter / sample / TOC / edit journal /
 * cross-playlist move / rebalance / live clone.
 *
 * House conventions honoured here:
 *   • shaping.ts helpers only (resolveMaxResults / truncateItems / getAllPages
 *     via the client) — nothing hand-rolled.
 *   • Every mutating tool carries `dry_run` (default TRUE) and performs the
 *     read side + returns a deterministic PLAN when true.
 *   • Playlist item ops use /playlists/{id}/items (Feb-2026 path).
 *   • Commit paths are BACKUP-FIRST: a local JSON snapshot of the playlist's
 *     current items is written under backupDir() BEFORE any write, then the
 *     rewrite runs as PUT (≤100 URIs) + POST appends through the serialized
 *     client queue (mirrors replace_playlist_items on main).
 *   • Full-sequence rewrites REFUSE to run when the playlist contains
 *     unavailable items (empty uri) — a rewrite would silently drop them.
 *   • No deprecated endpoints (SPEC §9); no popularity/followers/markets reads.
 *
 * NAME DEVIATION (deliberate): `playlist_changelog` and `playlist_clone_snapshot`
 * already exist in swarm4_playlists.ts, so this slice ships the equivalents as
 * `playlist_edit_journal` (live added_at/added_by history) and `playlist_clone_live`
 * (clone the LIVE playlist, not a local backup) — different mechanics, no clash.
 */
import { z } from 'zod';
import { mkdir, writeFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { getConfig } from '../config.js';
import { backupDir } from './backup.js';
import {
  MaxResults,
  ResponseFormat,
  describeDryRun,
  parseSpotifyUri,
  resolveMaxResults,
  sharedListFields,
  truncateItems,
} from '../shaping.js';
import type { ResponseFormatValue } from '../shaping.js';
import type {
  PlaylistItemObject,
  SpotifyAlbumSimple,
  SpotifyEpisode,
  SpotifyTrack,
} from '../types/spotify.js';

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

/** Field aliases used throughout this slice (same fragments, local names). */
const ResponseFormatArgName = ResponseFormat;
const MaxResultsArgName = MaxResults;

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
  .default(false)
  .describe('Public visibility for a newly created playlist. Default: private');

/** Effective dry-run flag: the fragment already defaults true, but parse defensively. */
const isDry = (args: { dry_run?: boolean }): boolean => args.dry_run ?? true;

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
 * BACKUP-FIRST: write a local JSON snapshot of a playlist's current items under
 * backupDir() so any commit can be undone by hand. Returns the file path.
 */
async function backupItemsBeforeWrite(
  playlistId: string,
  playlistName: string | null,
  items: readonly PlaylistItemObject[],
): Promise<string> {
  const dir = backupDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeId = playlistId.replace(/[^A-Za-z0-9._-]/g, '_');
  const file = `${dir}/playlistops-pre-${safeId}-${stamp}.json`;
  const payload = {
    _kind: 'playlistops pre-write backup',
    playlist_id: playlistId,
    playlist_name: playlistName,
    saved_at: new Date().toISOString(),
    item_count: items.length,
    items: items.map((entry) => ({
      added_at: entry.added_at ?? null,
      uri: entry.item?.uri ?? null,
      name: entry.item?.name ?? null,
    })),
  };
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return file;
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

/** `YYYY`, `YYYY-MM`, `YYYY-MM-DD` → comparable number (partial dates pad with zeros). */
function dateNum(date: string): number {
  const digits = date.replace(/\D/g, '').slice(0, 8);
  return parseInt(digits.padEnd(8, '0'), 10);
}

// ---------------------------------------------------------------------------
// Row model: one flat record per playlist entry
// ---------------------------------------------------------------------------

interface OpRow {
  uri: string;
  name: string;
  durationMs: number | null;
  addedAt: string;
  addedBy: string | null;
  artistNames: string[];
  artistIds: string[];
  albumName: string | null;
  releaseDate: string | null;
  kind: 'track' | 'episode' | 'unavailable';
  position: number;
}

/** Flatten paged playlist entries into rich rows (original positions preserved). */
function toRows(items: readonly PlaylistItemObject[]): OpRow[] {
  return items.map((entry, position) => {
    const withBy = entry as PlaylistItemObject & { added_by?: { id?: string } };
    const p = entry.item;
    if (isTrack(p)) {
      const album = p.album as (SpotifyAlbumSimple & { release_date?: string }) | undefined;
      return {
        uri: p.uri ?? '',
        name: p.name,
        durationMs: p.duration_ms,
        addedAt: entry.added_at ?? '',
        addedBy: withBy.added_by?.id ?? null,
        artistNames: (p.artists ?? []).map((a) => a.name),
        artistIds: (p.artists ?? []).map((a) => a.id ?? ''),
        albumName: album?.name ?? null,
        releaseDate: album?.release_date ?? null,
        kind: 'track' as const,
        position,
      };
    }
    if (isEpisode(p)) {
      return {
        uri: p.uri ?? '',
        name: p.name,
        durationMs: p.duration_ms,
        addedAt: entry.added_at ?? '',
        addedBy: withBy.added_by?.id ?? null,
        artistNames: [],
        artistIds: [],
        albumName: null,
        releaseDate: null,
        kind: 'episode' as const,
        position,
      };
    }
    return {
      uri: '',
      name: '(unavailable)',
      durationMs: null,
      addedAt: entry.added_at ?? '',
      addedBy: null,
      artistNames: [],
      artistIds: [],
      albumName: null,
      releaseDate: null,
      kind: 'unavailable' as const,
      position,
    };
  });
}

/** Track rows only (episodes/unavailable skipped). */
function trackRows(items: readonly PlaylistItemObject[]): OpRow[] {
  return toRows(items).filter((r) => r.kind === 'track');
}

/** True when any entry lost its playable object — a rewrite would drop it. */
function hasUnavailable(items: readonly PlaylistItemObject[]): boolean {
  return items.some((e) => !e.item?.uri);
}

// --- ordering + set-op helpers ---------------------------------------------

type SortKey = 'name' | 'artist' | 'album' | 'duration' | 'added_at' | 'release_date';

/** Deterministic sort value for a row; ties break by original position. */
function sortValue(row: OpRow, key: SortKey): string | number {
  switch (key) {
    case 'name':
      return row.name.toLowerCase();
    case 'artist':
      return (row.artistNames[0] ?? '\uffff').toLowerCase();
    case 'album':
      return (row.albumName ?? '\uffff').toLowerCase();
    case 'duration':
      return row.durationMs ?? Number.MAX_SAFE_INTEGER;
    case 'added_at':
      return dateNum(row.addedAt);
    case 'release_date':
      return row.releaseDate ? dateNum(row.releaseDate) : 99999999;
  }
}

function orderRows(rows: readonly OpRow[], key: SortKey, direction: 'asc' | 'desc'): OpRow[] {
  const sign = direction === 'desc' ? -1 : 1;
  return [...rows]
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const va = sortValue(a.row, key);
      const vb = sortValue(b.row, key);
      const cmp =
        typeof va === 'string' || typeof vb === 'string'
          ? String(va).localeCompare(String(vb))
          : va - vb;
      return sign * cmp || a.i - b.i;
    })
    .map((e) => e.row);
}

/** Union in first-seen order. */
function unionOf(lists: readonly (readonly string[])[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const uri of list) {
      if (!seen.has(uri)) {
        seen.add(uri);
        out.push(uri);
      }
    }
  }
  return out;
}

function differenceOf(minuend: readonly string[], subtrahend: readonly string[]): string[] {
  const cut = new Set(subtrahend);
  return minuend.filter((uri) => !cut.has(uri));
}

/** Apply a result-dedupe choice to an ordered uri sequence. */
function dedupeSequence(uris: readonly string[], mode: 'first' | 'last' | 'none'): string[] {
  if (mode === 'none') return [...uris];
  if (mode === 'first') return [...new Set(uris)];
  const lastSeen = new Map<string, number>();
  uris.forEach((u, i) => lastSeen.set(u, i));
  return uris.filter((u, i) => lastSeen.get(u) === i);
}

/** Deterministic seeded PRNG (mulberry32) for reproducible samples. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates over a copy; uses the supplied rng (deterministic when seeded). */
function shuffleWith<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------------------------------------------------------------------

export function registerSwarm3PlaylistopsTools(server: McpServer, client: SpotifyClient): void {
  // -----------------------------------------------------------------------
  // 1. sort_playlist_plan — read-only sort planner
  // -----------------------------------------------------------------------
  server.tool(
    'sort_playlist_plan',
    'Plan a sort of a playlist by name, artist, album, duration, added-at date or release era '
      + 'and preview the exact resulting order — read-only, commits nothing (use '
      + 'sort_playlist_apply to commit). Quota: 🟢 1–2 GETs.',
    {
      playlist_id: z.string().describe('Playlist to plan a sort for (ID or spotify:playlist: URI)'),
      sort_by: z.enum(['name', 'artist', 'album', 'duration', 'added_at', 'release_date']).optional().describe('Sort key. Default name'),
      direction: z.enum(['asc', 'desc']).optional().describe('Sort direction. Default asc'),
      response_format: ResponseFormatArgName,
      max_results: MaxResultsArgName,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      const rows = toRows(p.items);
      const ordered = orderRows(rows, args.sort_by ?? 'name', args.direction ?? 'asc');
      const view = truncateItems(
        ordered.map((r) => (r.uri ? `${r.uri} — ${r.name}` : `#${r.position} (unavailable)`)),
        resolveMaxResults(args.max_results, getConfig().maxItems),
      );
      const payload = {
        ok: true,
        playlist: p.id,
        playlist_name: p.name,
        sort_by: args.sort_by ?? 'name',
        direction: args.direction ?? 'asc',
        items: ordered.length,
        planned_order_uris: ordered.map((r) => r.uri).filter(Boolean),
      };
      return shape(rf, [
        `[plan] Sort "${p.name ?? p.id}" by ${payload.sort_by} ${payload.direction} — read-only, nothing changed.`,
        `  ${ordered.length} item(s); commit with sort_playlist_apply.`,
        ...view.items.map((line, i) => `  ${i + 1}. ${line}`),
        view.footer ? `(${view.footer})` : '',
      ].filter(Boolean).join('\n'), payload);
    },
  );

  // -----------------------------------------------------------------------
  // 2. sort_playlist_apply — backup-first sort + atomic replace
  // -----------------------------------------------------------------------
  server.tool(
    'sort_playlist_apply',
    'Sort a playlist in place by name, artist, album, duration, added-at date or release era: '
      + 'backs up the current items to a local file first, then rewrites via one atomic '
      + 'replace. dry_run=true (default) previews only. Quota: 🟢 GET + 1 local write + 1 PUT.',
    {
      playlist_id: z.string().describe('Playlist to sort (ID or spotify:playlist: URI)'),
      sort_by: z.enum(['name', 'artist', 'album', 'duration', 'added_at', 'release_date']).optional().describe('Sort key. Default name'),
      direction: z.enum(['asc', 'desc']).optional().describe('Sort direction. Default asc'),
      dry_run: DryRunDefault,
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      const ordered = orderRows(toRows(p.items), args.sort_by ?? 'name', args.direction ?? 'asc');
      const uris = ordered.map((r) => r.uri).filter(Boolean);
      const view = truncateItems(uris, resolveMaxResults(args.max_results, getConfig().maxItems));
      if (isDry(args)) {
        return shape(rf, describeDryRun('sort', p.name ?? p.id, [
          `Rewrite in ${args.sort_by ?? 'name'} ${args.direction ?? 'asc'} order (${uris.length} track(s)):`,
          ...view.items.map((u, i) => `  ${i + 1}. ${u}`),
          view.footer ? `(${view.footer})` : '',
        ]), { ok: true, dry_run: true, playlist: p.id, sort_by: args.sort_by ?? 'name', direction: args.direction ?? 'asc', would_write: uris.length });
      }
      if (hasUnavailable(p.items)) {
        throw new Error(
          `Playlist "${p.name ?? p.id}" contains unavailable items — a full rewrite would drop them. ` +
            `Remove them first (e.g. playlist_strip_episodes / keep_only style tools).`,
        );
      }
      const backupFile = await backupItemsBeforeWrite(p.id, p.name, p.items);
      const res = await atomicReplace(client, p.id, uris);
      return shape(rf, [
        `Sorted "${p.name ?? p.id}" by ${args.sort_by ?? 'name'} ${args.direction ?? 'asc'} (${uris.length} track(s), ${res.requests} request(s)).`,
        `Pre-write backup: ${backupFile}`,
        `Snapshot ID: ${res.snapshot_id ?? 'n/a'}`,
      ].join('\n'), {
        ok: true,
        dry_run: false,
        playlist: p.id,
        requests: res.requests,
        snapshot_id: res.snapshot_id ?? null,
        backup_file: backupFile,
      });
    },
  );

  // -----------------------------------------------------------------------
  // 3. reverse_playlist_plan — reversed-order rewrite (plan by default)
  // -----------------------------------------------------------------------
  server.tool(
    'reverse_playlist_plan',
    'Plan (and optionally commit) reversing a playlist\'s entire order via one atomic replace — ' +
      'dry_run defaults to TRUE so it returns the reversed PLAN read-only. '
      + 'Quota: 🟢 GET + 1 PUT when committing.',
    {
      playlist_id: z.string().describe('Playlist to reverse (ID or spotify:playlist: URI)'),
      dry_run: DryRunDefault,
      response_format: ResponseFormatArgName,
      max_results: MaxResultsArgName,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      const uris = toRows(p.items).map((r) => r.uri).filter(Boolean);
      const reversed = [...uris].reverse();
      const view = truncateItems(reversed, resolveMaxResults(args.max_results, getConfig().maxItems));
      if (isDry(args)) {
        return shape(rf, describeDryRun('reverse', p.name ?? p.id, [
          `Would reverse all ${reversed.length} item(s); new first item:`,
          ...view.items.slice(0, 10).map((u, i) => `  ${i + 1}. ${u}`),
          view.footer ? `(${view.footer})` : '',
        ]), { ok: true, dry_run: true, playlist: p.id, would_write: reversed.length, plan: reversed });
      }
      if (hasUnavailable(p.items)) {
        throw new Error(`Playlist "${p.name ?? p.id}" contains unavailable items — a full rewrite would drop them.`);
      }
      const backupFile = await backupItemsBeforeWrite(p.id, p.name, p.items);
      const res = await atomicReplace(client, p.id, reversed);
      return shape(rf, `Reversed "${p.name ?? p.id}" (${reversed.length} item(s), ${res.requests} request(s)).\nPre-write backup: ${backupFile}\nSnapshot ID: ${res.snapshot_id ?? 'n/a'}`, {
        ok: true,
        dry_run: false,
        playlist: p.id,
        requests: res.requests,
        snapshot_id: res.snapshot_id ?? null,
        backup_file: backupFile,
      });
    },
  );

  // -----------------------------------------------------------------------
  // 4. rotate_playlist_plan — rotate the sequence by N positions
  // -----------------------------------------------------------------------
  server.tool(
    'rotate_playlist_plan',
    'Plan (and optionally commit) rotating a playlist by N positions — positive moves the '
      + 'first N items to the end, negative moves the last |N| to the front; dry_run defaults '
      + 'to TRUE so it returns the rotated PLAN read-only. Quota: 🟢 GET + 1 PUT when committing.',
    {
      playlist_id: z.string().describe('Playlist to rotate (ID or spotify:playlist: URI)'),
      positions: z.number().int().optional().describe('Rotation amount; positive = first N to end, negative = last |N| to front. Default 1'),
      dry_run: DryRunDefault,
      response_format: ResponseFormatArgName,
      max_results: MaxResultsArgName,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      const rows = toRows(p.items);
      const n = args.positions ?? 1;
      if (rows.length === 0) throw new Error(`Playlist "${p.name ?? p.id}" is empty — nothing to rotate.`);
      const k = ((n % rows.length) + rows.length) % rows.length;
      const uris = rows.map((r) => r.uri);
      const rotated = [...uris.slice(k), ...uris.slice(0, k)];
      const view = truncateItems(rotated, resolveMaxResults(args.max_results, getConfig().maxItems));
      if (isDry(args)) {
        return shape(rf, describeDryRun('rotate', p.name ?? p.id, [
          `Rotate by ${n} (effective ${k}): new order starts with #${k + 1} "${rows[k].name}".`,
          ...view.items.slice(0, 10).map((u, i) => `  ${i + 1}. ${u}`),
          view.footer ? `(${view.footer})` : '',
        ]), { ok: true, dry_run: true, playlist: p.id, positions: n, effective: k, plan: rotated });
      }
      if (hasUnavailable(p.items)) {
        throw new Error(`Playlist "${p.name ?? p.id}" contains unavailable items — a full rewrite would drop them.`);
      }
      const backupFile = await backupItemsBeforeWrite(p.id, p.name, p.items);
      const res = await atomicReplace(client, p.id, rotated);
      return shape(rf, `Rotated "${p.name ?? p.id}" by ${n} (effective ${k}) — ${rotated.length} item(s), ${res.requests} request(s).\nPre-write backup: ${backupFile}\nSnapshot ID: ${res.snapshot_id ?? 'n/a'}`, {
        ok: true,
        dry_run: false,
        playlist: p.id,
        positions: n,
        effective: k,
        requests: res.requests,
        snapshot_id: res.snapshot_id ?? null,
        backup_file: backupFile,
      });
    },
  );

  // -----------------------------------------------------------------------
  // 5. interleave_playlists_plan — zip 2+ playlists together
  // -----------------------------------------------------------------------
  server.tool(
    'interleave_playlists_plan',
    'Plan (and optionally commit) interleaving 2–10 playlists — round-robin one track each or ' +
      'in N-track chunks. Without a target it returns the interleaved PLAN read-only; with ' +
      'target_playlist_id and dry_run=false it atomically overwrites the target. '
      + 'Quota: 🟢 N GETs + 1 PUT when committing.',
    {
      playlist_ids: z.array(z.string()).min(2).max(10).describe('Playlists to interleave (2–10), in round order'),
      strategy: z.enum(['round_robin', 'chunk']).optional().describe('round_robin = 1 track per playlist per pass; chunk = N per pass. Default round_robin'),
      chunk_size: z.number().int().min(1).max(20).optional().describe('chunk strategy: tracks per playlist per pass (1–20). Default 3'),
      target_playlist_id: z.string().optional().describe('Existing playlist (ID or URI) to atomically overwrite with the interleave. Omit = read-only plan'),
      dry_run: DryRunDefault,
      response_format: ResponseFormatArgName,
      max_results: MaxResultsArgName,
    },
    async (args) => {
      const rf = args.response_format;
      const loaded = await Promise.all(args.playlist_ids.map((ref) => loadPlaylistFull(client, ref)));
      const seqs = loaded.map((p) => trackRows(p.items).map((r) => r.uri));
      const per = args.strategy === 'chunk' ? (args.chunk_size ?? 3) : 1;
      const out: string[] = [];
      const cursors = seqs.map(() => 0);
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (let s = 0; s < seqs.length; s++) {
          const take = Math.min(per, seqs[s].length - cursors[s]);
          if (take > 0) {
            out.push(...seqs[s].slice(cursors[s], cursors[s] + take));
            cursors[s] += take;
            progressed = true;
          }
        }
      }
      const counts = unionOf(seqs).length;
      const view = truncateItems(out, resolveMaxResults(args.max_results, getConfig().maxItems));
      const payload = {
        ok: true,
        strategy: args.strategy === 'chunk' ? `chunk(${per})` : 'round_robin',
        per_playlist: loaded.map((p, i) => ({ id: p.id, name: p.name, tracks: seqs[i].length })),
        interleaved: out.length,
        distinct: counts,
      };
      const lines = [
        `Interleave plan (${payload.strategy}) of ${loaded.length} playlists → ${out.length} item(s):`,
        ...loaded.map((p, i) => `  • ${p.name ?? p.id}: ${seqs[i].length} track(s)`),
      ];
      if (!args.target_playlist_id) {
        lines.push('', ...view.items.map((u, i) => `  ${i + 1}. ${u}`));
        if (view.footer) lines.push(`(${view.footer})`);
        return shape(rf, `[plan] ${lines.join('\n')} — read-only, nothing changed.`, { ...payload, target: null });
      }
      if (isDry(args)) {
        lines.push('', ...view.items.map((u, i) => `  ${i + 1}. ${u}`));
        if (view.footer) lines.push(`(${view.footer})`);
        return shape(rf, describeDryRun('interleave', args.target_playlist_id, lines.slice(1)), { ...payload, target: args.target_playlist_id });
      }
      const targetId = normalizePlaylistRef(args.target_playlist_id);
      const res = await atomicReplace(client, targetId, out);
      return shape(rf, `Interleaved ${loaded.length} playlists into ${targetId} (${out.length} item(s), ${res.requests} request(s)).`, {
        ...payload,
        target: targetId,
        requests: res.requests,
        snapshot_id: res.snapshot_id ?? null,
      });
    },
  );

  // -----------------------------------------------------------------------
  // 6. merge_playlists_plan — concatenate 2+ playlists into a NEW playlist
  // -----------------------------------------------------------------------
  server.tool(
    'merge_playlists_plan',
    'Plan (and optionally commit) merging 2–10 playlists in order into a NEW playlist ' +
      '(optional first/last dedupe) — dry_run defaults to TRUE so it returns the merged ' +
      'PLAN read-only. Quota: 🟡 N GETs + create + chunked adds when committing.',
    {
      playlist_ids: z.array(z.string()).min(2).max(10).describe('Playlists to merge (2–10), in order'),
      dedupe: z.enum(['first', 'last', 'none']).optional().describe('Dedupe across the merge: keep first or last occurrence. Default first'),
      name: z.string().optional().describe('New playlist name. Default "Merged YYYY-MM-DD"'),
      description: z.string().optional().describe('New playlist description'),
      public: PublicFlag,
      dry_run: DryRunDefault,
      response_format: ResponseFormatArgName,
      max_results: MaxResultsArgName,
    },
    async (args) => {
      const rf = args.response_format;
      const loaded = await Promise.all(args.playlist_ids.map((ref) => loadPlaylistFull(client, ref)));
      const seqs = loaded.map((p) => trackRows(p.items).map((r) => r.uri));
      const raw = seqs.flat();
      const merged = dedupeSequence(raw, args.dedupe ?? 'first');
      const name = args.name ?? `Merged ${new Date().toISOString().slice(0, 10)}`;
      const view = truncateItems(merged, resolveMaxResults(args.max_results, getConfig().maxItems));
      if (isDry(args)) {
        return shape(rf, describeDryRun('merge', `new playlist "${name}"`, [
          `Concatenate ${loaded.length} playlists (${raw.length} entries) → ${merged.length} after dedupe=${args.dedupe ?? 'first'}:`,
          ...loaded.map((p, i) => `  • ${p.name ?? p.id}: ${seqs[i].length} track(s)`),
          '',
          ...view.items.map((u, i) => `  ${i + 1}. ${u}`),
          view.footer ? `(${view.footer})` : '',
        ]), { ok: true, dry_run: true, name, merged_count: merged.length, raw_count: raw.length, plan: merged });
      }
      const created = await createPlaylist(client, name, args.public ?? false, args.description ?? 'Merged via merge_playlists_plan');
      const add = await addUrisChunked(client, created, merged);
      return shape(rf, `Merged ${loaded.length} playlists into new playlist "${name}" (${created}): ${merged.length} track(s), ${add.requests} add request(s).`, {
        ok: true,
        dry_run: false,
        playlist: created,
        name,
        merged: merged.length,
        raw: raw.length,
        requests: add.requests,
      });
    },
  );

  // -----------------------------------------------------------------------
  // 7. playlist_difference_plan — A minus B1..B5
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_difference_plan',
    'Plan (and optionally commit) the set difference "base minus subtrahends": keep the base ' +
      'playlist\'s tracks that appear in NONE of up to 5 others. Without a target it returns ' +
      'the PLAN read-only; with target_playlist_id and dry_run=false it atomically overwrites ' +
      'the target. Quota: 🟢 ≤7 GETs + 1 PUT when committing.',
    {
      base_playlist_id: z.string().describe('Base playlist (ID or URI) whose survivors are kept'),
      subtract_playlist_ids: z.array(z.string()).min(1).max(5).describe('Playlists whose tracks are removed from the base (1–5)'),
      target_playlist_id: z.string().optional().describe('Existing playlist (ID or URI) to atomically overwrite with the difference. Omit = read-only plan'),
      dry_run: DryRunDefault,
      response_format: ResponseFormatArgName,
      max_results: MaxResultsArgName,
    },
    async (args) => {
      const rf = args.response_format;
      const base = await loadPlaylistFull(client, args.base_playlist_id);
      const subs = await Promise.all(args.subtract_playlist_ids.map((ref) => loadPlaylistFull(client, ref)));
      const baseSeq = trackRows(base.items).map((r) => r.uri);
      const cut = unionOf(subs.map((s) => trackRows(s.items).map((r) => r.uri)));
      const diff = differenceOf(baseSeq, cut);
      const view = truncateItems(diff, resolveMaxResults(args.max_results, getConfig().maxItems));
      const payload = {
        ok: true,
        base: { id: base.id, name: base.name, tracks: baseSeq.length },
        subtract: subs.map((s) => ({ id: s.id, name: s.name, tracks: trackRows(s.items).length })),
        removed: baseSeq.length - diff.length,
        remaining: diff.length,
      };
      if (!args.target_playlist_id) {
        return shape(rf, [
          `[plan] Difference "${base.name ?? base.id}" minus ${subs.length} playlist(s): ${diff.length} of ${baseSeq.length} survive (read-only).`,
          ...view.items.map((u) => `  ✓ ${u}`),
          view.footer ? `(${view.footer})` : '',
        ].filter(Boolean).join('\n'), { ...payload, target: null });
      }
      if (isDry(args)) {
        return shape(rf, describeDryRun('difference', args.target_playlist_id, [
          `Overwrite with the ${diff.length} surviving track(s):`,
          ...view.items.map((u) => `  - ${u}`),
          view.footer ? `(${view.footer})` : '',
        ]), { ...payload, target: args.target_playlist_id });
      }
      const targetId = normalizePlaylistRef(args.target_playlist_id);
      const res = await atomicReplace(client, targetId, diff);
      return shape(rf, `Wrote the difference (${diff.length} track(s)) to ${targetId} in ${res.requests} request(s).`, {
        ...payload,
        target: targetId,
        requests: res.requests,
        snapshot_id: res.snapshot_id ?? null,
      });
    },
  );

  // -----------------------------------------------------------------------
  // 8. playlist_intersection — common tracks + membership map (read-only)
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_intersection',
    'Report the tracks present in ALL of 2–10 playlists, including which of the source ' +
      'playlists each common track appears in — the read-only intersection analysis ' +
      '(commit variants live in the set-op plan tools). Quota: 🟢 N GETs.',
    {
      playlist_ids: z.array(z.string()).min(2).max(10).describe('Playlists to intersect (2–10)'),
      response_format: ResponseFormatArgName,
      max_results: MaxResultsArgName,
    },
    async (args) => {
      const rf = args.response_format;
      const loaded = await Promise.all(args.playlist_ids.map((ref) => loadPlaylistFull(client, ref)));
      const nameOf = loaded.map((p) => p.name ?? p.id);
      const rowsPer = loaded.map((p) => trackRows(p.items));
      const membership = new Map<string, OpRow[]>();
      for (let i = 0; i < rowsPer.length; i++) {
        for (const row of rowsPer[i]) {
          const list = membership.get(row.uri) ?? [];
          if (list.length === 0) membership.set(row.uri, list);
          list.push(row);
        }
      }
      const common = [...membership.entries()]
        .filter(([, rows]) => rows.length === loaded.length)
        .sort((a, b) => a[1][0].position - b[1][0].position)
        .map(([uri, rows]) => ({ uri, name: rows[0].name, in_playlists: rows.map((r) => r.position + 1) }));
      const view = truncateItems(common, resolveMaxResults(args.max_results, getConfig().maxItems));
      const payload = {
        ok: true,
        playlists: loaded.map((p, i) => ({ id: p.id, name: nameOf[i], tracks: rowsPer[i].length })),
        intersection_count: common.length,
        common_tracks: common,
      };
      return shape(rf, [
        `Intersection of ${loaded.length} playlists: ${common.length} common track(s).`,
        ...loaded.map((p, i) => `  • ${nameOf[i]}: ${rowsPer[i].length} track(s)`),
        ...(common.length > 0 ? ['', 'Common:', ...view.items.map((c, i) => `  ${i + 1}. ${c.name} (${c.uri}) — present in ${c.in_playlists.length}/${loaded.length} sources`)] : []),
        view.footer ? `(${view.footer})` : '',
      ].filter(Boolean).join('\n'), payload);
    },
  );

  // -----------------------------------------------------------------------
  // 9. playlist_union_preview — union sequence + exclusivity stats (read-only)
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_union_preview',
    'Preview the union of 2–10 playlists as a first-seen-ordered sequence, with per-playlist ' +
      'counts and how many tracks are unique to each — read-only, no writes. '
      + 'Quota: 🟢 N GETs.',
    {
      playlist_ids: z.array(z.string()).min(2).max(10).describe('Playlists to union (2–10)'),
      response_format: ResponseFormatArgName,
      max_results: MaxResultsArgName,
    },
    async (args) => {
      const rf = args.response_format;
      const loaded = await Promise.all(args.playlist_ids.map((ref) => loadPlaylistFull(client, ref)));
      const nameOf = loaded.map((p) => p.name ?? p.id);
      const seqs = loaded.map((p) => trackRows(p.items).map((r) => r.uri));
      const union = unionOf(seqs);
      const occurrences = new Map<string, number>();
      for (const seq of seqs) for (const uri of new Set(seq)) occurrences.set(uri, (occurrences.get(uri) ?? 0) + 1);
      const uniquePer = seqs.map((seq) => [...new Set(seq)].filter((u) => occurrences.get(u) === 1).length);
      const view = truncateItems(union, resolveMaxResults(args.max_results, getConfig().maxItems));
      const payload = {
        ok: true,
        playlists: loaded.map((p, i) => ({ id: p.id, name: nameOf[i], tracks: seqs[i].length, unique: uniquePer[i] })),
        union_count: union.length,
        union_uris: union,
      };
      return shape(rf, [
        `Union preview of ${loaded.length} playlists: ${union.length} distinct track(s) (read-only).`,
        ...loaded.map((p, i) => `  • ${nameOf[i]}: ${seqs[i].length} track(s), ${uniquePer[i]} unique to this playlist`),
        '',
        ...view.items.map((u, i) => `  ${i + 1}. ${u}`),
        view.footer ? `(${view.footer})` : '',
      ].filter(Boolean).join('\n'), payload);
    },
  );

  // -----------------------------------------------------------------------
  // 10. extract_playlist_range — copy [start,end) into a NEW playlist
  // -----------------------------------------------------------------------
  server.tool(
    'extract_playlist_range',
    'Extract a positional range of a playlist (0-based start, EXCLUSIVE end; negative values ' +
      'count from the end) into a NEW playlist, reporting the original→new position map — ' +
      'dry_run defaults to TRUE. Quota: 🟢 GET + create + chunked adds when committing.',
    {
      playlist_id: z.string().describe('Source playlist (ID or spotify:playlist: URI)'),
      start: z.number().int().optional().describe('0-based inclusive start; negative = from end. Default 0'),
      end: z.number().int().optional().describe('0-based EXCLUSIVE end; negative = from end. Default: all items'),
      name: z.string().describe('Name for the new extract playlist'),
      public: PublicFlag,
      dry_run: DryRunDefault,
      response_format: ResponseFormatArgName,
      max_results: MaxResultsArgName,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      const rows = toRows(p.items);
      const total = rows.length;
      const norm = (v: number): number => (v < 0 ? Math.max(0, total + v) : Math.min(total, v));
      const from = norm(args.start ?? 0);
      const to = norm(args.end ?? total);
      if (from >= to) throw new Error(`Empty range [${from},${to}) on a ${total}-item playlist.`);
      const sliced = rows.slice(from, to).filter((r) => r.uri);
      const uris = sliced.map((r) => r.uri);
      const view = truncateItems(uris, resolveMaxResults(args.max_results, getConfig().maxItems));
      if (isDry(args)) {
        return shape(rf, describeDryRun('extract range', `new playlist "${args.name}"`, [
          `Copy items [${from},${to}) of ${total} → ${uris.length} playable item(s) into "${args.name}":`,
          ...view.items.map((u, i) => `  pos ${from + i + 1} → ${u}`),
          view.footer ? `(${view.footer})` : '',
        ]), { ok: true, dry_run: true, source: p.id, range: [from, to], extracted: uris.length, plan: uris });
      }
      const created = await createPlaylist(client, args.name, args.public ?? false, `Extract [${from},${to}) of ${p.name ?? p.id}`);
      const add = await addUrisChunked(client, created, uris);
      return shape(rf, `Extracted [${from},${to}) (${uris.length} item(s)) from "${p.name ?? p.id}" into new playlist "${args.name}" (${created}), ${add.requests} add request(s).`, {
        ok: true,
        dry_run: false,
        source: p.id,
        playlist: created,
        range: [from, to],
        extracted: uris.length,
        requests: add.requests,
      });
    },
  );

  // -----------------------------------------------------------------------
  // 11. remove_playlist_range — position-based delete [start,end)
  // -----------------------------------------------------------------------
  server.tool(
    'remove_playlist_range',
    'Delete a positional range of a playlist (0-based start, EXCLUSIVE end; negative values ' +
      'count from the end): backs up the current items to a local file first, then removes by ' +
      'positions + uris. dry_run defaults to TRUE. Quota: 🟢 GET + chunked deletes when committing.',
    {
      playlist_id: z.string().describe('Playlist to trim (ID or spotify:playlist: URI)'),
      start: z.number().int().optional().describe('0-based inclusive start; negative = from end. Default 0'),
      end: z.number().int().optional().describe('0-based EXCLUSIVE end; negative = from end. Default: all items'),
      dry_run: DryRunDefault,
      response_format: ResponseFormatArgName,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      const rows = toRows(p.items);
      const total = rows.length;
      const norm = (v: number): number => (v < 0 ? Math.max(0, total + v) : Math.min(total, v));
      const from = norm(args.start ?? 0);
      const to = norm(args.end ?? total);
      if (from >= to) throw new Error(`Empty range [${from},${to}) on a ${total}-item playlist.`);
      const doomed = rows.slice(from, to).filter((r) => r.uri);
      const keptCount = total - doomed.length;
      if (isDry(args)) {
        return shape(rf, describeDryRun('remove range', p.name ?? p.id, [
          `Would delete items [${from},${to}) — ${doomed.length} of ${total} item(s), ${keptCount} remain:`,
          ...doomed.slice(0, 10).map((r) => `  - pos ${r.position + 1}: ${r.uri} "${r.name}"`),
        ]), { ok: true, dry_run: true, playlist: p.id, range: [from, to], removals: doomed.length, remaining: keptCount });
      }
      const backupFile = await backupItemsBeforeWrite(p.id, p.name, p.items);
      let requests = 0;
      for (let start = 0; start < doomed.length; start += 100) {
        const chunk = doomed.slice(start, start + 100);
        await client.delete(`/playlists/${encodeURIComponent(p.id)}/items`, {
          tracks: chunk.map((r) => ({ uri: r.uri, positions: [r.position] })),
        });
        requests++;
      }
      return shape(rf, `Deleted ${doomed.length} item(s) [${from},${to}) from "${p.name ?? p.id}"; ${keptCount} remain. ${requests} delete request(s).\nPre-write backup: ${backupFile}`, {
        ok: true,
        dry_run: false,
        playlist: p.id,
        removals: doomed.length,
        remaining: keptCount,
        requests,
        backup_file: backupFile,
      });
    },
  );

  // -----------------------------------------------------------------------
  // 12. dedupe_playlist_plan — duplicate census (read-only)
  // -----------------------------------------------------------------------
  server.tool(
    'dedupe_playlist_plan',
    'Census every duplicate uri in a playlist — groups, all positions, and the exact keep-' +
      'first/keep-last removal plan — read-only (commit with dedupe_playlist_apply). '
      + 'Quota: 🟢 1–2 GETs.',
    {
      playlist_id: z.string().describe('Playlist to scan (ID or spotify:playlist: URI)'),
      response_format: ResponseFormatArgName,
      max_results: MaxResultsArgName,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      const byUri = new Map<string, number[]>();
      toRows(p.items).forEach((r) => {
        if (!r.uri) return;
        const list = byUri.get(r.uri) ?? [];
        if (list.length === 0) byUri.set(r.uri, list);
        list.push(r.position);
      });
      const groups = [...byUri.entries()]
        .filter(([, positions]) => positions.length > 1)
        .sort((a, b) => a[1][0] - b[1][0])
        .map(([uri, positions]) => ({ uri, positions }));
      const excess = groups.reduce((n, g) => n + g.positions.length - 1, 0);
      const view = truncateItems(groups, resolveMaxResults(args.max_results, getConfig().maxItems));
      const payload = {
        ok: true,
        playlist: p.id,
        playlist_name: p.name,
        duplicate_groups: groups.length,
        excess_copies: excess,
        keep_first_plan: groups.map((g) => ({ uri: g.uri, remove_positions: g.positions.slice(1) })),
        keep_last_plan: groups.map((g) => ({ uri: g.uri, remove_positions: g.positions.slice(0, -1) })),
      };
      return shape(rf, [
        `"${p.name ?? p.id}" duplicates: ${groups.length} group(s), ${excess} excess cop(ies).`,
        ...view.items.map((g, i) => `  ${i + 1}. ${g.uri} at positions ${g.positions.map((p) => p + 1).join(', ')}`),
        view.footer ? `(${view.footer})` : '',
      ].filter(Boolean).join('\n'), payload);
    },
  );

  // -----------------------------------------------------------------------
  // 13. dedupe_playlist_apply — backup-first dedupe + atomic replace
  // -----------------------------------------------------------------------
  server.tool(
    'dedupe_playlist_apply',
    'Remove duplicate uris from a playlist keeping the first (or last) occurrence: backs up ' +
      'the current items to a local file first, then rewrites via one atomic replace. ' +
      'dry_run defaults to TRUE. Quota: 🟢 GET + 1 local write + 1 PUT when committing.',
    {
      playlist_id: z.string().describe('Playlist to dedupe (ID or spotify:playlist: URI)'),
      keep: z.enum(['first', 'last']).optional().describe('Which occurrence to keep. Default first'),
      dry_run: DryRunDefault,
      response_format: ResponseFormatArgName,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      const rows = toRows(p.items);
      const keep = args.keep ?? 'first';
      const uris = rows.map((r) => r.uri);
      const deduped = keep === 'first' ? [...new Set(uris)] : dedupeSequence(uris, 'last');
      const removed = uris.length - deduped.length;
      if (isDry(args)) {
        return shape(rf, describeDryRun('dedupe', p.name ?? p.id, [
          `Would remove ${removed} duplicate occurrence(s), keeping ${keep} — ${deduped.length} of ${uris.length} remain.`,
        ]), { ok: true, dry_run: true, playlist: p.id, keep, removed, remaining: deduped.length });
      }
      if (hasUnavailable(p.items)) {
        throw new Error(`Playlist "${p.name ?? p.id}" contains unavailable items — a full rewrite would drop them.`);
      }
      const backupFile = await backupItemsBeforeWrite(p.id, p.name, p.items);
      const res = await atomicReplace(client, p.id, deduped);
      return shape(rf, `Deduped "${p.name ?? p.id}" (kept ${keep}): removed ${removed}, ${deduped.length} remain, ${res.requests} request(s).\nPre-write backup: ${backupFile}\nSnapshot ID: ${res.snapshot_id ?? 'n/a'}`, {
        ok: true,
        dry_run: false,
        playlist: p.id,
        keep,
        removed,
        remaining: deduped.length,
        requests: res.requests,
        snapshot_id: res.snapshot_id ?? null,
        backup_file: backupFile,
      });
    },
  );

  // -----------------------------------------------------------------------
  // 14. split_playlist_by_count — equal parts into NEW playlists
  // -----------------------------------------------------------------------
  server.tool(
    'split_playlist_by_count',
    'Split a playlist into N roughly-equal parts, each written to a NEW playlist named ' +
      '"<prefix> 1..N" — dry_run defaults to TRUE so it returns the part plan read-only. '
      + 'Quota: 🟡 GET + N creates + chunked adds when committing.',
    {
      playlist_id: z.string().describe('Playlist to split (ID or spotify:playlist: URI)'),
      parts: z.number().int().min(2).max(50).optional().describe('Number of parts (2–50). Default 2'),
      prefix: z.string().optional().describe('New playlist name prefix. Default: "<original name> — Part"'),
      public: PublicFlag,
      dry_run: DryRunDefault,
      response_format: ResponseFormatArgName,
      max_results: MaxResultsArgName,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      const rows = toRows(p.items).filter((r) => r.uri);
      const n = args.parts ?? 2;
      if (rows.length < n) throw new Error(`Cannot split ${rows.length} item(s) into ${n} non-empty parts.`);
      const base = Math.floor(rows.length / n);
      const remainder = rows.length % n;
      const prefix = args.prefix ?? `${p.name ?? p.id} — Part`;
      const parts: Array<{ name: string; uris: string[] }> = [];
      let cursor = 0;
      for (let i = 0; i < n; i++) {
        const size = base + (i < remainder ? 1 : 0);
        parts.push({ name: `${prefix} ${i + 1}`, uris: rows.slice(cursor, cursor + size).map((r) => r.uri) });
        cursor += size;
      }
      const sizes = parts.map((part) => `${part.name}: ${part.uris.length}`).join(', ');
      if (isDry(args)) {
        return shape(rf, describeDryRun('split by count', p.name ?? p.id, [
          `Would create ${n} playlist(s) → ${sizes}.`,
        ]), { ok: true, dry_run: true, parts: parts.map((part) => ({ name: part.name, count: part.uris.length, uris: part.uris })) });
      }
      const created: Array<{ playlist: string; name: string; added: number }> = [];
      let requests = 0;
      for (const part of parts) {
        const id = await createPlaylist(client, part.name, args.public ?? false, `Part ${created.length + 1}/${n} of ${p.name ?? p.id}`);
        const add = await addUrisChunked(client, id, part.uris);
        requests += add.requests;
        created.push({ playlist: id, name: part.name, added: part.uris.length });
      }
      return shape(rf, `Split "${p.name ?? p.id}" into ${n} playlist(s) → ${sizes} (${requests} add request(s)).`, {
        ok: true,
        dry_run: false,
        source: p.id,
        created,
        requests,
      });
    },
  );

  // -----------------------------------------------------------------------
  // 15. split_playlist_by_duration — runtime-packed parts
  // -----------------------------------------------------------------------
  server.tool(
    'split_playlist_by_duration',
    'Split a playlist greedily into consecutive parts of a target runtime (e.g. 60-minute ' +
      'commute blocks), each written to a NEW playlist — dry_run defaults to TRUE. '
      + 'Quota: 🟡 GET + N creates + chunked adds when committing.',
    {
      playlist_id: z.string().describe('Playlist to split (ID or spotify:playlist: URI)'),
      target_minutes: z.number().positive().describe('Target runtime per part, in minutes'),
      tolerance_sec: z.number().int().min(0).optional().describe('A part may run over by up to this many seconds. Default 30'),
      prefix: z.string().optional().describe('New playlist name prefix. Default: "<original name> — Part"'),
      public: PublicFlag,
      dry_run: DryRunDefault,
      response_format: ResponseFormatArgName,
      max_results: MaxResultsArgName,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      const rows = toRows(p.items).filter((r) => r.uri && r.durationMs != null);
      const targetMs = args.target_minutes * 60_000;
      const toleranceMs = (args.tolerance_sec ?? 30) * 1000;
      const prefix = args.prefix ?? `${p.name ?? p.id} — Part`;
      const parts: Array<{ name: string; uris: string[]; runtimeMs: number }> = [];
      let acc = 0;
      let bucket: string[] = [];
      let runtime = 0;
      for (const row of rows) {
        const d = row.durationMs ?? 0;
        if (bucket.length > 0 && runtime + d > targetMs + toleranceMs) {
          parts.push({ name: `${prefix} ${parts.length + 1}`, uris: bucket, runtimeMs: runtime });
          bucket = [];
          runtime = 0;
          acc = 0;
        }
        void acc;
        bucket.push(row.uri);
        runtime += d;
      }
      if (bucket.length > 0) parts.push({ name: `${prefix} ${parts.length + 1}`, uris: bucket, runtimeMs: runtime });
      const sizes = parts.map((part) => `${part.name}: ${part.uris.length} (${msToClock(part.runtimeMs)})`).join(', ');
      if (isDry(args)) {
        return shape(rf, describeDryRun('split by duration', p.name ?? p.id, [
          `Would create ${parts.length} part(s) of ≈${args.target_minutes} min → ${sizes}.`,
        ]), { ok: true, dry_run: true, parts: parts.map((part) => ({ name: part.name, count: part.uris.length, runtime_ms: part.runtimeMs, uris: part.uris })) });
      }
      const created: Array<{ playlist: string; name: string; added: number; runtime_ms: number }> = [];
      let requests = 0;
      for (const part of parts) {
        const id = await createPlaylist(client, part.name, args.public ?? false, `≈${msToClock(part.runtimeMs)} block of ${p.name ?? p.id}`);
        const add = await addUrisChunked(client, id, part.uris);
        requests += add.requests;
        created.push({ playlist: id, name: part.name, added: part.uris.length, runtime_ms: part.runtimeMs });
      }
      return shape(rf, `Split "${p.name ?? p.id}" into ${parts.length} runtime block(s) → ${sizes} (${requests} add request(s)).`, {
        ok: true,
        dry_run: false,
        source: p.id,
        created,
        requests,
      });
    },
  );

  // -----------------------------------------------------------------------
  // 16. filter_playlist_by_era — release-year filter (report or write)
  // -----------------------------------------------------------------------
  server.tool(
    'filter_playlist_by_era',
    'Filter a playlist by album release era (decade and/or year window) and either report the ' +
      'matches read-only or — with a name and dry_run=false — write them to a NEW playlist. '
      + 'Quota: 🟢 GET (+ create/adds when committing).',
    {
      playlist_id: z.string().describe('Playlist to filter (ID or spotify:playlist: URI)'),
      decade: z.number().int().min(1900).max(2100).optional().describe('Decade start year (e.g. 1980 = 1980–1989)'),
      from_year: z.number().int().min(1900).max(2100).optional().describe('Inclusive from-year (overrides nothing; combined with decade is allowed)'),
      to_year: z.number().int().min(1900).max(2100).optional().describe('Inclusive to-year'),
      name: z.string().optional().describe('New playlist name — omit to stay read-only'),
      public: PublicFlag,
      dry_run: DryRunDefault,
      response_format: ResponseFormatArgName,
      max_results: MaxResultsArgName,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      const fromY = args.decade ?? args.from_year ?? 0;
      const toY = args.decade ? args.decade + 9 : (args.to_year ?? 9999);
      const rows = trackRows(p.items);
      const matched = rows.filter((r) => {
        if (!r.releaseDate) return false;
        const y = parseInt(r.releaseDate.slice(0, 4), 10);
        return y >= fromY && y <= toY;
      });
      const unresolvable = rows.length - rows.filter((r) => r.releaseDate).length;
      const uris = matched.map((r) => r.uri);
      const view = truncateItems(
        matched.map((r) => `${r.name} — ${r.artistNames.join(', ')} (${(r.releaseDate ?? '').slice(0, 4)})`),
        resolveMaxResults(args.max_results, getConfig().maxItems),
      );
      const payload = {
        ok: true,
        playlist: p.id,
        era: { from_year: fromY, to_year: toY },
        matched: uris.length,
        unresolvable_release_dates: unresolvable,
        matched_uris: uris,
      };
      const lines = [
        `Era filter ${fromY}–${toY} on "${p.name ?? p.id}": ${uris.length} of ${rows.length} track(s) match`
          + (unresolvable > 0 ? ` (${unresolvable} without release dates excluded)` : '') + ':',
        ...view.items.map((line, i) => `  ${i + 1}. ${line}`),
        view.footer ? `(${view.footer})` : '',
      ];
      if (!args.name) return shape(rf, `[report] ${lines.join('\n')} — read-only.`, { ...payload, target: null });
      if (isDry(args)) return shape(rf, describeDryRun('era filter', `new playlist "${args.name}"`, lines.slice(1)), payload);
      const created = await createPlaylist(client, args.name, args.public ?? false, `Era ${fromY}–${toY} from ${p.name ?? p.id}`);
      const add = await addUrisChunked(client, created, uris);
      return shape(rf, `Wrote ${uris.length} era-matching track(s) to new playlist "${args.name}" (${created}), ${add.requests} add request(s).`, {
        ...payload,
        target: created,
        requests: add.requests,
      });
    },
  );

  // -----------------------------------------------------------------------
  // 17. filter_playlist_by_artist — artist filter (report or write)
  // -----------------------------------------------------------------------
  server.tool(
    'filter_playlist_by_artist',
    'Filter a playlist by artist (IDs/URIs or names, matched on id or exact name) and either ' +
      'report the matches read-only or — with a name and dry_run=false — write them to a NEW ' +
      'playlist. Quota: 🟢 GET (+ create/adds when committing).',
    {
      playlist_id: z.string().describe('Playlist to filter (ID or spotify:playlist: URI)'),
      artists: z.array(z.string()).min(1).max(20).describe('Artists to match: IDs/URIs or exact names (1–20)'),
      name: z.string().optional().describe('New playlist name — omit to stay read-only'),
      public: PublicFlag,
      dry_run: DryRunDefault,
      response_format: ResponseFormatArgName,
      max_results: MaxResultsArgName,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      const wantedIds = new Set(
        args.artists.map((a) => normalizeArtistRef(a).toLowerCase()).filter((v) => /^[0-9a-zA-Z]{22}$/.test(v)),
      );
      const wantedNames = new Set(
        args.artists.map((a) => a.trim().toLowerCase()).filter((v) => !/^[0-9a-zA-Z]{22}$/.test(v)),
      );
      const matched = trackRows(p.items).filter((r) =>
        r.artistNames.some((nm) => wantedNames.has(nm.toLowerCase())) ||
        r.artistIds.some((id) => id && wantedIds.has(id.toLowerCase())),
      );
      const uris = matched.map((r) => r.uri);
      const view = truncateItems(
        matched.map((r) => `${r.name} — ${r.artistNames.join(', ')}`),
        resolveMaxResults(args.max_results, getConfig().maxItems),
      );
      const payload = {
        ok: true,
        playlist: p.id,
        artists: [...wantedIds, ...wantedNames],
        matched: uris.length,
        matched_uris: uris,
      };
      const lines = [
        `Artist filter on "${p.name ?? p.id}": ${uris.length} of ${trackRows(p.items).length} track(s) match:`,
        ...view.items.map((line, i) => `  ${i + 1}. ${line}`),
        view.footer ? `(${view.footer})` : '',
      ];
      if (!args.name) return shape(rf, `[report] ${lines.join('\n')} — read-only.`, { ...payload, target: null });
      if (isDry(args)) return shape(rf, describeDryRun('artist filter', `new playlist "${args.name}"`, lines.slice(1)), payload);
      const created = await createPlaylist(client, args.name, args.public ?? false, `Artist filter from ${p.name ?? p.id}`);
      const add = await addUrisChunked(client, created, uris);
      return shape(rf, `Wrote ${uris.length} artist-matching track(s) to new playlist "${args.name}" (${created}), ${add.requests} add request(s).`, {
        ...payload,
        target: created,
        requests: add.requests,
      });
    },
  );

  // -----------------------------------------------------------------------
  // 18. filter_playlist_by_duration — runtime filter (report or write)
  // -----------------------------------------------------------------------
  server.tool(
    'filter_playlist_by_duration',
    'Filter a playlist by track duration (min/max seconds) and either report the matches ' +
      'read-only or — with a name and dry_run=false — write them to a NEW playlist. '
      + 'Quota: 🟢 GET (+ create/adds when committing).',
    {
      playlist_id: z.string().describe('Playlist to filter (ID or spotify:playlist: URI)'),
      min_seconds: z.number().int().min(0).optional().describe('Inclusive minimum track length in seconds. Default 0'),
      max_seconds: z.number().int().min(1).optional().describe('Inclusive maximum track length in seconds. Default: no cap'),
      name: z.string().optional().describe('New playlist name — omit to stay read-only'),
      public: PublicFlag,
      dry_run: DryRunDefault,
      response_format: ResponseFormatArgName,
      max_results: MaxResultsArgName,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      const min = args.min_seconds ?? 0;
      const max = args.max_seconds ?? Number.MAX_SAFE_INTEGER;
      const rows = trackRows(p.items).filter((r) => r.durationMs != null);
      const matched = rows.filter((r) => {
        const sec = Math.round((r.durationMs ?? 0) / 1000);
        return sec >= min && sec <= max;
      });
      const uris = matched.map((r) => r.uri);
      const view = truncateItems(
        matched.map((r) => `${r.name} — ${msToClock(r.durationMs ?? 0)}`),
        resolveMaxResults(args.max_results, getConfig().maxItems),
      );
      const payload = {
        ok: true,
        playlist: p.id,
        duration_window: { min_seconds: min, max_seconds: args.max_seconds ?? null },
        matched: uris.length,
        matched_uris: uris,
      };
      const lines = [
        `Duration filter ${min}s–${args.max_seconds != null ? `${args.max_seconds}s` : '∞'} on "${p.name ?? p.id}": ${uris.length} of ${rows.length} track(s) match:`,
        ...view.items.map((line, i) => `  ${i + 1}. ${line}`),
        view.footer ? `(${view.footer})` : '',
      ];
      if (!args.name) return shape(rf, `[report] ${lines.join('\n')} — read-only.`, { ...payload, target: null });
      if (isDry(args)) return shape(rf, describeDryRun('duration filter', `new playlist "${args.name}"`, lines.slice(1)), payload);
      const created = await createPlaylist(client, args.name, args.public ?? false, `Duration ${min}s–${args.max_seconds ?? '∞'}s from ${p.name ?? p.id}`);
      const add = await addUrisChunked(client, created, uris);
      return shape(rf, `Wrote ${uris.length} duration-matching track(s) to new playlist "${args.name}" (${created}), ${add.requests} add request(s).`, {
        ...payload,
        target: created,
        requests: add.requests,
      });
    },
  );

  // -----------------------------------------------------------------------
  // 19. sample_playlist_tracks — reproducible random sample (read-only)
  // -----------------------------------------------------------------------
  server.tool(
    'sample_playlist_tracks',
    'Draw a uniform random sample of N tracks from a playlist — deterministic when a seed is ' +
      'given (same seed + same playlist = same sample), read-only. Quota: 🟢 1–2 GETs.',
    {
      playlist_id: z.string().describe('Playlist to sample (ID or spotify:playlist: URI)'),
      count: z.number().int().min(1).max(200).optional().describe('Sample size (1–200). Default 10'),
      seed: z.number().int().min(0).optional().describe('Seed for reproducible sampling. Omit for a fresh random draw'),
      response_format: ResponseFormatArgName,
 max_results: MaxResultsArgName,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      const rows = trackRows(p.items);
      const rng = seededRandom(args.seed ?? (Date.now() % 2_147_483_647));
      const picked = shuffleWith(rows, rng).slice(0, Math.min(args.count ?? 10, rows.length));
      const view = truncateItems(
        picked.map((r) => `${r.name} — ${r.artistNames.join(', ')}`),
        resolveMaxResults(args.max_results, getConfig().maxItems),
      );
      return shape(rf, [
        `Sampled ${picked.length} of ${rows.length} track(s) from "${p.name ?? p.id}"${args.seed != null ? ` (seed ${args.seed})` : ' (unseeded)'}:`,
        ...view.items.map((line, i) => `  ${i + 1}. ${line}`),
        view.footer ? `(${view.footer})` : '',
      ].filter(Boolean).join('\n'), {
        ok: true,
        playlist: p.id,
        pool: rows.length,
        seed: args.seed ?? null,
        sample: picked.map((r) => ({ uri: r.uri, name: r.name, artists: r.artistNames })),
      });
    },
  );

  // -----------------------------------------------------------------------
  // 20. playlist_table_of_contents — chapters by add-month (read-only)
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_table_of_contents',
    'Build a table of contents for a playlist: totals, runtime, and "chapters" — contiguous ' +
      'position ranges grouped by the month each block was added — plus contributor counts. ' +
      'Read-only. Quota: 🟢 1–2 GETs.',
    {
      playlist_id: z.string().describe('Playlist to index (ID or spotify:playlist: URI)'),
      response_format: ResponseFormatArgName,
      max_results: MaxResultsArgName,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      const rows = toRows(p.items);
      const tracks = rows.filter((r) => r.kind === 'track');
      const runtimeMs = tracks.reduce((s, r) => s + (r.durationMs ?? 0), 0);
      const chapters: Array<{ month: string; positions: [number, number]; count: number }> = [];
      for (const row of rows) {
        const month = (row.addedAt || 'unknown').slice(0, 7);
        const last = chapters[chapters.length - 1];
        if (last && last.month === month) {
          last.positions[1] = row.position + 1;
          last.count++;
        } else {
          chapters.push({ month, positions: [row.position + 1, row.position + 1], count: 1 });
        }
      }
      const contributors = new Map<string, number>();
      for (const row of rows) {
        const who = row.addedBy ?? 'unknown';
        contributors.set(who, (contributors.get(who) ?? 0) + 1);
      }
      const chapterView = truncateItems(chapters, resolveMaxResults(args.max_results, getConfig().maxItems));
      const payload = {
        ok: true,
        playlist: p.id,
        playlist_name: p.name,
        items: rows.length,
        tracks: tracks.length,
        runtime_ms: runtimeMs,
        chapters,
        contributors: Object.fromEntries([...contributors.entries()].sort((a, b) => b[1] - a[1])),
      };
      return shape(rf, [
        `"${p.name ?? p.id}" — ${rows.length} item(s), ${tracks.length} track(s), runtime ${msToClock(runtimeMs)}:`,
        '  Chapters (by add-month):',
        ...chapterView.items.map((c, i) => `    ${i + 1}. ${c.month}: positions ${c.positions[0]}–${c.positions[1]} (${c.count} item(s))`),
        chapterView.footer ? `  (${chapterView.footer})` : '',
        `  Contributors: ${[...contributors.entries()].sort((a, b) => b[1] - a[1]).map(([who, n]) => `${who} (${n})`).join(', ')}`,
      ].filter(Boolean).join('\n'), payload);
    },
  );

  // -----------------------------------------------------------------------
  // 21. playlist_edit_journal — live add-batch history (read-only)
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_edit_journal',
    'Journal a playlist\'s live edit history from added_at/added_by metadata: add-batches by ' +
      'date with who added them, collab contributors, and drift verdict — read-only, no local ' +
      'snapshot needed. Quota: 🟢 1–2 GETs.',
    {
      playlist_id: z.string().describe('Playlist to journal (ID or spotify:playlist: URI)'),
      response_format: ResponseFormatArgName,
      max_results: MaxResultsArgName,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      const rows = toRows(p.items);
      const byDate = new Map<string, Array<OpRow>>();
      for (const row of rows) {
        const day = (row.addedAt || 'unknown').slice(0, 10);
        const list = byDate.get(day) ?? [];
        if (list.length === 0) byDate.set(day, list);
        list.push(row);
      }
      const batches = [...byDate.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([day, list]) => ({
          date: day,
          added: list.length,
          by: [...new Set(list.map((r) => r.addedBy ?? 'unknown'))],
          first_position: list[0].position + 1,
        }));
      const contributors = new Map<string, number>();
      for (const row of rows) {
        const who = row.addedBy ?? 'unknown';
        contributors.set(who, (contributors.get(who) ?? 0) + 1);
      }
      const distinct = contributors.size;
      const verdict = distinct <= 1 ? 'SOLO' : distinct <= 3 ? 'LIGHT COLLAB' : 'HEAVY COLLAB';
      const batchView = truncateItems(batches, resolveMaxResults(args.max_results, getConfig().maxItems));
      const payload = {
        ok: true,
        playlist: p.id,
        playlist_name: p.name,
        batches,
        contributors: Object.fromEntries([...contributors.entries()].sort((a, b) => b[1] - a[1])),
        verdict,
      };
      return shape(rf, [
        `Edit journal for "${p.name ?? p.id}" — ${batches.length} add-batch(es), ${rows.length} item(s). Verdict: ${verdict}.`,
        ...batchView.items.map((b, i) => `  ${i + 1}. ${b.date}: +${b.added} (positions ${b.first_position}+) by ${b.by.join(', ')}`),
        batchView.footer ? `  (${batchView.footer})` : '',
        `  Contributors: ${[...contributors.entries()].sort((a, b) => b[1] - a[1]).map(([who, n]) => `${who} (${n})`).join(', ')}`,
      ].filter(Boolean).join('\n'), payload);
    },
  );

  // -----------------------------------------------------------------------
  // 22. move_tracks_between_playlists — cross-playlist move (backup-first)
  // -----------------------------------------------------------------------
  server.tool(
    'move_tracks_between_playlists',
    'Move matching tracks (by uris, name substring, or artist) from one playlist to another: ' +
      'backs up the source to a local file first, deletes the matched positions from the ' +
      'source, then appends them to the destination. dry_run defaults to TRUE. '
      + 'Quota: 🟡 GETs + chunked deletes + chunked adds when committing.',
    {
      source_playlist_id: z.string().describe('Source playlist (ID or spotify:playlist: URI)'),
      destination_playlist_id: z.string().describe('Destination playlist (ID or spotify:playlist: URI)'),
      match_uris: z.array(z.string()).optional().describe('Track uris to move'),
      query: z.string().optional().describe('Move items whose name contains this substring'),
      artist: z.string().optional().describe('Move every track by this artist (ID/URI or exact name)'),
      dry_run: DryRunDefault,
      response_format: ResponseFormatArgName,
      max_results: MaxResultsArgName,
    },
    async (args) => {
      const rf = args.response_format;
      if (!args.match_uris?.length && !args.query && !args.artist) {
        throw new Error('Provide one of match_uris, query, or artist.');
      }
      const src = await loadPlaylistFull(client, args.source_playlist_id);
      const dst = await loadPlaylistFull(client, args.destination_playlist_id);
      const matchUris = new Set<string>(args.match_uris ?? []);
      if (args.query) {
        const q = args.query.toLowerCase();
        for (const r of toRows(src.items)) if (r.name.toLowerCase().includes(q)) matchUris.add(r.uri);
      }
      if (args.artist) {
        const wantedId = normalizeArtistRef(args.artist).toLowerCase();
        for (const r of toRows(src.items)) {
          if (
            r.artistNames.some((nm) => nm.toLowerCase() === args.artist!.toLowerCase()) ||
            r.artistIds.some((id) => id && id.toLowerCase() === wantedId)
          ) {
            matchUris.add(r.uri);
          }
        }
      }
      const moving = toRows(src.items).filter((r) => r.uri && matchUris.has(r.uri));
      const uris = moving.map((r) => r.uri);
      const view = truncateItems(
        moving.map((r) => `${r.name} — ${r.artistNames.join(', ')}`),
        resolveMaxResults(args.max_results, getConfig().maxItems),
      );
      if (isDry(args)) {
        return shape(rf, describeDryRun('move tracks', `${src.name ?? src.id} → ${dst.name ?? dst.id}`, [
          `Would move ${moving.length} track(s):`,
          ...view.items.map((line, i) => `  ${i + 1}. ${line}`),
          view.footer ? `(${view.footer})` : '',
        ]), { ok: true, dry_run: true, source: src.id, destination: dst.id, moved: moving.length, plan: uris });
      }
      const backupFile = await backupItemsBeforeWrite(src.id, src.name, src.items);
      let requests = 0;
      for (let start = 0; start < moving.length; start += 100) {
        const chunk = moving.slice(start, start + 100);
        await client.delete(`/playlists/${encodeURIComponent(src.id)}/items`, {
          tracks: chunk.map((r) => ({ uri: r.uri, positions: [r.position] })),
        });
        requests++;
      }
      const add = await addUrisChunked(client, dst.id, uris);
      requests += add.requests;
      return shape(rf, `Moved ${moving.length} track(s) from "${src.name ?? src.id}" to "${dst.name ?? dst.id}" (${requests} request(s)).\nPre-write backup: ${backupFile}`, {
        ok: true,
        dry_run: false,
        source: src.id,
        destination: dst.id,
        moved: moving.length,
        requests,
        backup_file: backupFile,
      });
    },
  );

  // -----------------------------------------------------------------------
  // 23. balance_playlist_pairs — equalize 2+ playlists
  // -----------------------------------------------------------------------
  server.tool(
    'balance_playlist_pairs',
    'Plan (and optionally commit) rebalancing 2–10 playlists to similar track counts or ' +
      'runtimes: computes surplus moves from the larger to the smaller. dry_run defaults to ' +
      'TRUE so it returns the move PLAN read-only. Quota: 🟡 N GETs + moves when committing.',
    {
      playlist_ids: z.array(z.string()).min(2).max(10).describe('Playlists to balance (2–10)'),
      balance_by: z.enum(['count', 'runtime']).optional().describe('Balance metric: track count or total runtime. Default count'),
      dry_run: DryRunDefault,
      response_format: ResponseFormatArgName,
      max_results: MaxResultsArgName,
    },
    async (args) => {
      const rf = args.response_format;
      const metric = args.balance_by ?? 'count';
      const loaded = await Promise.all(args.playlist_ids.map((ref) => loadPlaylistFull(client, ref)));
      const loadedById = new Map(loaded.map((p) => [p.id, p.items]));
      const buckets = loaded.map((p) => {
        const rows = trackRows(p.items).filter((r) => r.uri && (metric === 'count' || r.durationMs != null));
        const size = metric === 'count' ? rows.length : rows.reduce((s, r) => s + (r.durationMs ?? 0), 0);
        return { id: p.id, name: p.name, rows, size };
      });
      const total = buckets.reduce((s, b) => s + b.size, 0);
      const target = Math.floor(total / buckets.length);
      const received = new Map<string, number>();
      const needOf = (b: { id: string; size: number }): number => target - b.size - (received.get(b.id) ?? 0);
      const moveCost = (r: OpRow): number => (metric === 'count' ? 1 : r.durationMs ?? 0);
      const moves: Array<{ uri: string; name: string; from_playlist: string; from_name: string; to_playlist: string; to_name: string }> = [];
      const movedUris = new Set<string>();
      const donors = [...buckets].filter((b) => b.size > target).sort((a, b) => b.size - a.size);
      const receivers = [...buckets].filter((b) => b.size < target);
      let ri = 0;
      for (const donor of donors) {
        let surplus = donor.size - target;
        let i = donor.rows.length - 1;
        while (surplus > 0 && i >= 0 && ri < receivers.length) {
          if (needOf(receivers[ri]) <= 0) {
            ri++;
            continue;
          }
          const row = donor.rows[i];
          if (!movedUris.has(row.uri)) {
            movedUris.add(row.uri);
            received.set(receivers[ri].id, (received.get(receivers[ri].id) ?? 0) + moveCost(row));
            moves.push({
              uri: row.uri,
              name: row.name,
              from_playlist: donor.id,
              from_name: donor.name ?? donor.id,
              to_playlist: receivers[ri].id,
              to_name: receivers[ri].name ?? receivers[ri].id,
            });
            surplus -= moveCost(row);
          }
          i--;
        }
      }
      const moveView = truncateItems(moves, resolveMaxResults(args.max_results, getConfig().maxItems));
      if (isDry(args)) {
        return shape(rf, describeDryRun('balance', `${buckets.length} playlists by ${metric}`, [
          `Total ${metric}: ${metric === 'count' ? String(total) : msToClock(total)}; target per playlist: ${metric === 'count' ? String(target) : msToClock(target)}.`,
          `${moves.length} move(s) planned:`,
          ...moveView.items.map((m, i) => `  ${i + 1}. "${m.name}" ${m.from_name} → ${m.to_name}`),
          moveView.footer ? `(${moveView.footer})` : '',
        ]), { ok: true, dry_run: true, balance_by: metric, total, target, moves });
      }
      // BACKUP-FIRST per donating playlist, then delete positions DESCENDING so each
      // chunk's positions stay valid, then append to receivers.
      const backupFiles: string[] = [];
      let requests = 0;
      const outboundBySrc = new Map<string, OpRow[]>();
      for (const m of moves) {
        const donorBucket = buckets.find((b) => b.id === m.from_playlist);
        if (!donorBucket) continue;
        const row = donorBucket.rows.find((r) => r.uri === m.uri);
        if (!row) continue;
        const list = outboundBySrc.get(m.from_playlist) ?? [];
        if (list.length === 0) outboundBySrc.set(m.from_playlist, list);
        list.push(row);
      }
      for (const [srcId, rows] of outboundBySrc) {
        const origItems = loadedById.get(srcId);
        if (origItems) backupFiles.push(await backupItemsBeforeWrite(srcId, buckets.find((b) => b.id === srcId)?.name ?? null, origItems));
        const descending = [...rows].sort((a, b) => b.position - a.position);
        for (let start = 0; start < descending.length; start += 100) {
          const chunk = descending.slice(start, start + 100);
          await client.delete(`/playlists/${encodeURIComponent(srcId)}/items`, {
            tracks: chunk.map((r) => ({ uri: r.uri, positions: [r.position] })),
          });
          requests++;
        }
      }
      for (const recv of receivers) {
        const inbound = moves.filter((m) => m.to_playlist === recv.id).map((m) => m.uri);
        if (inbound.length > 0) {
          const add = await addUrisChunked(client, recv.id, inbound);
          requests += add.requests;
        }
      }
      return shape(rf, `Balanced ${buckets.length} playlists by ${metric}: ${moves.length} move(s), ${requests} request(s).\nPre-write backups:\n${backupFiles.map((f) => `  - ${f}`).join('\n')}`, {
        ok: true,
        dry_run: false,
        balance_by: metric,
        total,
        target,
        moves,
        requests,
        backup_files: backupFiles,
      });
    },
  );

  // -----------------------------------------------------------------------
  // 24. playlist_clone_live — clone the LIVE playlist into a NEW one
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_clone_live',
    'Clone a playlist AS IT IS RIGHT NOW into a NEW playlist (name, optional description and ' +
      'publicity) — works on the live playlist, not a local snapshot; dry_run defaults to ' +
      'TRUE. Quota: 🟡 GET + create + chunked adds when committing.',
    {
      playlist_id: z.string().describe('Playlist to clone (ID or spotify:playlist: URI)'),
      name: z.string().optional().describe('New playlist name. Default "<original> (copy)"'),
      description: z.string().optional().describe('New playlist description. Default: cloned from source'),
      public: PublicFlag,
      dry_run: DryRunDefault,
      response_format: ResponseFormatArgName,
      max_results: MaxResultsArgName,
    },
    async (args) => {
      const rf = args.response_format;
      const meta = await client.get<{ id?: string; name?: string; description?: string; public?: boolean }>(
        `/playlists/${encodeURIComponent(normalizePlaylistRef(args.playlist_id))}`,
      );
      if (!meta) throw new Error(`Playlist "${args.playlist_id}" not found`);
      const items = await fetchAllItems(client, normalizePlaylistRef(args.playlist_id));
      const uris = toRows(items).map((r) => r.uri).filter(Boolean);
      const name = args.name ?? `${meta.name ?? args.playlist_id} (copy)`;
      const view = truncateItems(uris, resolveMaxResults(args.max_results, getConfig().maxItems));
      if (isDry(args)) {
        return shape(rf, describeDryRun('clone', `new playlist "${name}"`, [
          `Would create "${name}" with all ${uris.length} item(s) from "${meta.name ?? args.playlist_id}":`,
          ...view.items.map((u, i) => `  ${i + 1}. ${u}`),
          view.footer ? `(${view.footer})` : '',
        ]), { ok: true, dry_run: true, source: meta.id ?? null, name, items: uris.length, plan: uris });
      }
      const created = await createPlaylist(
        client,
        name,
        args.public ?? false,
        args.description ?? (meta.description ? `${meta.description} (clone)` : 'Clone via playlist_clone_live'),
      );
      const add = uris.length > 0 ? await addUrisChunked(client, created, uris) : { requests: 0 };
      return shape(rf, `Cloned "${meta.name ?? args.playlist_id}" → new playlist "${name}" (${created}) with ${uris.length} item(s), ${add.requests} add request(s).`, {
        ok: true,
        dry_run: false,
        source: meta.id ?? null,
        playlist: created,
        name,
        items: uris.length,
        requests: add.requests,
      });
    },
  );
}
