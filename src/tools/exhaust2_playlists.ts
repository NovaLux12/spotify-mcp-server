/**
 * exhaust2 playlists slice — feature swarm v1.24.0 (issues #380–#400).
 *
 * Owned by the fix/exhaust2-playlists builder. All tools in this slice are
 * registered here and nowhere else.
 *
 * House conventions honoured here:
 *   • shaping.ts helpers only (resolveMaxResults / truncateItems / getAllPages
 *     via the client) — nothing hand-rolled.
 *   • Every mutating tool carries `dry_run` (default TRUE) and performs the
 *     read side + returns a deterministic PLAN when true (#57).
 *   • Playlist item ops use /playlists/{id}/items (Feb-2026 path).
 *   • Atomic replaces: PUT (≤100 URIs) then POST appends via the serialized
 *     client queue, mirroring replace_playlist_items on main.
 *   • No deprecated endpoints (SPEC §9).
 */
import { z } from 'zod';
import { MARKET_CODE } from './catalog.js';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { getConfig } from '../config.js';
import { backupDir } from './backup.js';
import {
  DryRun,
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
  SavedTrackItem,
  SpotifyAlbumItem,
  SpotifyAlbumSimple,
  SpotifyEpisode,
  SpotifyPlaylistSimple,
  SpotifyTrack,
} from '../types/spotify.js';

type TextContent = { type: 'text'; text: string };
type ToolResult = { content: TextContent[]; structuredContent?: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Shared shaping helpers
// ---------------------------------------------------------------------------

const textResult = (text: string, structured?: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text }],
  ...(structured ? { structuredContent: structured } : {}),
});

const jsonText = (data: unknown): string => JSON.stringify(data, null, 2);

/** #51/#52 shaping: json mode stringifies the payload; payload rides as structuredContent. */
function shape(rf: ResponseFormatValue, prose: string, payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: rf === 'json' ? jsonText(payload) : prose }],
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
      + 'Default true — pass false to commit.',
  );

const PublicFlag = z
  .boolean()
  .optional()
  .default(false)
  .describe('Public visibility for a newly created playlist. Default: private');

/** Effective dry-run flag: the fragment already defaults true, but parse defensively. */
const isDry = (args: { dry_run?: boolean }): boolean => args.dry_run ?? true;

/** Dry-run PLAN result (repo convention: previews are the default). */
function dryOut(label: string, target: string, lines: string[], extra?: Record<string, unknown>): ToolResult {
  const prose = `[dry run] ${label} — ${target}\n${lines.join('\n')}`;
  return {
    content: [{ type: 'text', text: prose }],
    structuredContent: { ok: true, dry_run: true, label, target, plan: lines, ...extra },
  };
}

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

/** Accept a bare track ID or spotify:track: URI; return the raw ID. */
function normalizeTrackRef(ref: string): string {
  const parsed = parseSpotifyUri(ref);
  if (parsed && parsed.type === 'track') return parsed.id;
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

/** URI when present, else ID — set-op identity for a playable row. */
function playableKey(p: SpotifyTrack | SpotifyEpisode | null | undefined): string | null {
  if (!p) return null;
  return p.uri ?? p.id ?? null;
}

function displayName(p: SpotifyTrack | SpotifyEpisode | null | undefined): string {
  return p?.name ?? '(unavailable)';
}

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
function shuffleArr<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Uniform random sample of `n` distinct elements (no replacement). */
function sampleN<T>(items: readonly T[], n: number): T[] {
  return shuffleArr(items).slice(0, Math.min(n, items.length));
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

/** `YYYY`, `YYYY-MM`, `YYYY-MM-DD` → comparable number (partial dates pad with zeros). */
function dateNum(date: string): number {
  const digits = date.replace(/\D/g, '').slice(0, 8);
  return parseInt(digits.padEnd(8, '0'), 10);
}

function daysBetween(iso: string, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 86_400_000));
}

interface Row {
  uri: string;
  name: string;
  durationMs: number | null;
  addedAt: string;
}

/** Flatten paged playlist entries into plain rows, tagging kind. */
function toRows(
  items: readonly PlaylistItemObject[],
): Array<Row & { kind: 'track' | 'episode' | 'unavailable' }> {
  return items.map((entry) => {
    const p = entry.item;
    if (isTrack(p)) {
      return {
        uri: p.uri,
        name: p.name,
        durationMs: p.duration_ms,
        addedAt: entry.added_at ?? '',
        kind: 'track' as const,
      };
    }
    if (isEpisode(p)) {
      return {
        uri: p.uri,
        name: p.name,
        durationMs: p.duration_ms,
        addedAt: entry.added_at ?? '',
        kind: 'episode' as const,
      };
    }
    return {
      uri: '',
      name: '(unavailable)',
      durationMs: null,
      addedAt: entry.added_at ?? '',
      kind: 'unavailable' as const,
    };
  });
}

/** Playlist tracks only (episodes/unavailable rows skipped). */
function trackRows(items: readonly PlaylistItemObject[]): Row[] {
  return toRows(items)
    .filter((r) => r.kind === 'track')
    .map(({ uri, name, durationMs, addedAt }) => ({ uri, name, durationMs, addedAt }));
}

interface ArtistLite {
  id?: string;
  name: string;
}

/** artist id/name pairs for every track row. */
function rowArtists(items: readonly PlaylistItemObject[]): Array<{ artists: ArtistLite[]; row: Row }> {
  const out: Array<{ artists: ArtistLite[]; row: Row }> = [];
  for (const entry of items) {
    const p = entry.item;
    if (!isTrack(p)) continue;
    out.push({
      artists: (p.artists ?? []).map((a) => ({ id: a.id, name: a.name })),
      row: { uri: p.uri, name: p.name, durationMs: p.duration_ms, addedAt: entry.added_at ?? '' },
    });
  }
  return out;
}

interface SearchLike {
  tracks?: { items: SpotifyTrack[]; total: number };
  episodes?: { items: SpotifyEpisode[]; total: number };
  artists?: { items: Array<ArtistLite & { uri?: string }>; total: number };
}

// --- set-op helpers over ordered URI sequences -----------------------------

function intersectionOf(lists: readonly (readonly string[])[]): string[] {
  if (lists.length === 0) return [];
  const first = [...new Set(lists[0])];
  return first.filter((uri) => lists.every((rest) => rest.includes(uri)));
}

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

function xorOf(a: readonly string[], b: readonly string[]): string[] {
  const setA = new Set(a);
  const setB = new Set(b);
  return [...a.filter((u) => !setB.has(u)), ...b.filter((u) => !setA.has(u))];
}

// --- candidate pickers (#381/#398): one slot per query, no double-fire -----

/** Pull candidate uris for one search type. */
function candidatesFor(results: SearchLike, type: 'track' | 'episode'): string[] {
  if (type === 'track') return (results.tracks?.items ?? []).filter(Boolean).map((t) => t.uri);
  return (results.episodes?.items ?? []).filter(Boolean).map((t) => t.uri);
}

/** Pick the first candidate from `pool` not yet chosen anywhere. */
function pickTarget(pool: readonly string[], chosen: ReadonlySet<string>): string | null {
  for (const uri of pool) if (!chosen.has(uri)) return uri;
  return null;
}

// --- dedupe candidate resolution (#389) -----------------------------------

interface DedupeResolution {
  candidates: Array<{ uri: string; positions: number[] }>;
  duplicatesInPlaylist: number;
  libraryOverlap: number | null;
}

/**
 * #389 candidate set + optional library overlap. scope 'library' pages
 * /me/tracks (fetch-all cap) and counts how many candidates are ALSO saved.
 */
async function resolveDedupeParams(
  client: SpotifyClient,
  items: readonly PlaylistItemObject[],
  dedupeScope: 'playlist' | 'library' | 'none',
): Promise<DedupeResolution> {
  const byUri = new Map<string, number[]>();
  items.forEach((entry, i) => {
    const p = entry.item;
    if (!p?.uri) return;
    const list = byUri.get(p.uri) ?? [];
    list.push(i);
    byUri.set(p.uri, list);
  });
  const candidates = [...byUri.entries()]
    .map(([uri, positions]) => ({ uri, positions }))
    .sort((a, b) => a.positions[0] - b.positions[0]);
  const duplicatesInPlaylist = candidates.reduce((n, c) => n + (c.positions.length - 1), 0);

  let libraryOverlap: number | null = null;
  if (dedupeScope === 'library') {
    const saved = await client.getAllPages<SavedTrackItem>(
      '/me/tracks',
      { limit: '50' },
      { maxItems: getConfig().fetchAllCap },
    );
    const savedUris = new Set(saved.map((row) => row?.track?.uri).filter(Boolean) as string[]);
    libraryOverlap = candidates.filter((c) => savedUris.has(c.uri)).length;
  }
  return { candidates, duplicatesInPlaylist, libraryOverlap };
}

// --- gated-read wrapper (#403 contract, SPEC §9) ---------------------------

/**
 * Run a read, converting a raw 403 into the graceful "app-registration gated"
 * short-circuit contract — never a bare Forbidden to the agent.
 */
export async function getWithGating<T>(
  client: SpotifyClient,
  path: string,
  params?: Record<string, string>,
): Promise<T | null> {
  try {
    return await client.get<T>(path, params);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 403) {
      throw new Error(
        `This endpoint is app-registration gated for your Spotify app — access denied. ` +
          `Request elevated access in the Spotify developer dashboard, or use a tool that ` +
          `derives the same data from permitted endpoints.`,
      );
    }
    throw err;
  }
}

// --- paged-library walker for /me/{type} ----------------------------------

type LibraryRow = SavedTrackItem | { added_at: string; album?: SpotifyAlbumSimple };

/** Walk a /me/{type}s offset-paged library list (getAllPages, capped). */
function listAllMeType(client: SpotifyClient, type: 'tracks' | 'albums'): Promise<LibraryRow[]> {
  return client.getAllPages<LibraryRow>(
    `/me/${type}`,
    { limit: '50' },
    { maxItems: getConfig().fetchAllCap },
  );
}

function rowUri(row: LibraryRow): string {
  const t = row as SavedTrackItem;
  if (t.track?.uri) return t.track.uri;
  const a = row as { album?: { uri?: string } };
  return a.album?.uri ?? '';
}

function rowName(row: LibraryRow): string {
  const t = row as SavedTrackItem;
  if (t.track?.name) return t.track.name;
  const a = row as { album?: { name?: string } };
  return a.album?.name ?? '';
}

// ---------------------------------------------------------------------------
// #380 playlist_intersect
// ---------------------------------------------------------------------------

/** Shared args for #380/#399 set ops: keep first/last/none within the result. */
const SetDedupe = z
  .enum(['first', 'last', 'none'])
  .optional()
  .default('none')
  .describe('Dedupe within the RESULT sequence: keep the first or last occurrence, or none. Default none');

/** Shared args for #380/#399 intersection writes. */
const SetOpParams = {
  dedupe: SetDedupe,
  target_playlist_id: z
    .string()
    .optional()
    .describe('Existing playlist (ID or spotify:playlist: URI) to ATOMICALLY OVERWRITE with the result. Omit to compute read-only.'),
  dry_run: DryRunDefault,
} as const;

/** Apply the result-dedupe choice to an ordered uri sequence. */
function dedupeSequence(uris: readonly string[], mode: 'first' | 'last' | 'none'): string[] {
  if (mode === 'none') return [...uris];
  if (mode === 'first') return [...new Set(uris)];
  const out: string[] = [];
  const seenLast = new Map<string, number>();
  uris.forEach((u, i) => seenLast.set(u, i));
  return uris.filter((u, i) => seenLast.get(u) === i);
}

// ---------------------------------------------------------------------------
// #381/#398 search support
// ---------------------------------------------------------------------------

async function searchOne(
  client: SpotifyClient,
  query: string,
  type: 'track' | 'episode',
): Promise<SearchLike> {
  // Feb 2026: /search limit max is 10 (400 above), default 5.
  return (
    (await client.get<SearchLike>('/search', { q: query, type, limit: '10' })) ?? {}
  );
}

export function registerExhaust2PlaylistsTools(server: McpServer, client: SpotifyClient): void {
  // #380 playlist_intersect
  server.tool(
    'playlist_intersect',
    'Keep only the tracks present in ALL of 2–10 playlists, written as one atomic replace — '
      + 'the missing set op (union/subtract/XOR exist). Without a target it reports the '
      + 'intersection read-only. Quota: 🟢 N GETs + 1 PUT when committing. Also covers: playlist_intersection (same op, unified) — See also: playlist_intersection.',
    {
      source_playlist_ids: z
        .array(z.string())
        .min(2)
        .max(10)
        .describe('Playlists to intersect, as IDs or spotify:playlist: URIs (2–10)'),
      ...SetOpParams,
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const loaded = await Promise.all(args.source_playlist_ids.map((ref) => loadPlaylistFull(client, ref)));
      const uriLists = loaded.map((p) => trackRows(p.items).map((r) => r.uri));
      const counts = intersectionOf(uriLists).length;
      const intersected = dedupeSequence(intersectionOf(uriLists), args.dedupe);
      const payload: Record<string, unknown> = {
        ok: true,
        per_playlist: loaded.map((p) => ({ id: p.id, name: p.name, tracks: trackRows(p.items).length })),
        intersection_count: intersected.length,
      };
      const rows = truncateItems(intersected, resolveMaxResults(args.max_results, getConfig().maxItems));
      const prose = [
        `Intersection of ${loaded.length} playlists: ${intersected.length} common track(s)` +
          (args.dedupe !== 'none' ? ` (dedupe=${args.dedupe})` : '') + '.',
        ...loaded.map(
          (p, i) => `  • ${p.name ?? p.id}: ${uriLists[i].length} track(s)`,
        ),
      ];
      if (rows.items.length > 0) {
        prose.push('');
        prose.push(...rows.items.map((uri) => `  ✓ ${uri}`));
        if (rows.footer) prose.push(`(${rows.footer})`);
      }
      if (!args.target_playlist_id) {
        return shape(rf, prose.join('\n'), { ...payload, target: null });
      }
      if (isDry(args)) {
        const changes = [
          `Overwrite "${args.target_playlist_id}" with ${intersected.length} common track(s)`,
          ...(rows.items.length > 0 ? rows.items.map((uri) => `  - ${uri}`) : ['  (playlist would be emptied)']),
        ];
        return shape(rf, describeDryRun('intersect', args.target_playlist_id, changes), {
          ...payload,
          target: args.target_playlist_id,
        });
      }
      const targetId = normalizePlaylistRef(args.target_playlist_id);
      const res = await atomicReplace(client, targetId, intersected);
      return shape(
        rf,
        `Wrote ${intersected.length} common track(s) to playlist ${targetId} in ${res.requests} request(s).\n`
          + batchSummary(intersected.length, intersected),
        { ...payload, target: targetId, requests: res.requests },
      );
    },
  );

  // #381 playlist_add_by_search
  server.tool(
    'playlist_add_by_search',
    '"Add Radiohead Paranoid Android to Chill Mix" in one shot: search the catalog, pick the '
      + 'top result(s), and add the URI(s) to a playlist. Highest-traffic curation gesture. '
      + 'Quota: 🟡 1 search + 1 add call.',
    {
      playlist_id: z.string().describe('Destination playlist, as ID or spotify:playlist: URI'),
      query: z.string().describe('Search query, e.g. "Radiohead Paranoid Android"'),
      type: z.enum(['track', 'episode']).optional().default('track').describe('What to search for. Default track'),
      pick: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .default(1)
        .describe('How many top search hits to add (1–10). Default 1'),
      dry_run: DryRunDefault,
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const results = await searchOne(client, args.query, args.type);
      const pool = candidatesFor(results, args.type);
      const chosen = pickTarget(pool, new Set());
      if (!chosen) {
        return shape(rf, `No ${args.type} results for "${args.query}" — nothing added.`, {
          ok: false,
          added: 0,
        });
      }
      const uris = pool.slice(0, Math.min(args.pick, pool.length));
      const meta = await client.get<{ name?: string }>(
        `/playlists/${encodeURIComponent(normalizePlaylistRef(args.playlist_id))}`,
      );
      if (isDry(args)) {
        const changes = uris.map((u, i) => `Add ${u} (search hit #${i + 1} for "${args.query}")`);
        return shape(rf, describeDryRun('add by search', meta?.name ?? args.playlist_id, changes), {
          ok: true,
          dry_run: true,
          uris: uris,
        });
      }
      const res = await addUrisChunked(client, normalizePlaylistRef(args.playlist_id), uris);
      return shape(
        rf,
        `Added ${uris.length} ${args.type}(s) to "${meta?.name ?? args.playlist_id}" (top hits for "${args.query}").`,
        { ok: true, added: uris.length, uris, requests: res.requests },
      );
    },
  );

  // #382 playlist_trim_to_duration
  server.tool(
    'playlist_trim_to_duration',
    'Fit a playlist to a target runtime (e.g. "exactly 30 min for the commute"): greedy '
      + 'keep-first/last/random selection within ±tolerance seconds, written as one atomic '
      + 'replace. Complements item-count playlist_trim. Quota: 🟢 GET + 1 PUT.',
    {
      playlist_id: z.string().describe('Playlist to trim, as ID or spotify:playlist: URI'),
      target_minutes: z.number().positive().describe('Target runtime in minutes'),
      tolerance_sec: z
        .number()
        .int()
        .min(0)
        .optional()
        .default(30)
        .describe('Acceptable deviation from the target, in seconds. Default 30'),
      keep_which: z
        .enum(['first', 'last', 'random'])
        .optional()
        .default('first')
        .describe('Greedy direction: keep the first N that fit, the last N, or a random draw. Default first'),
      dry_run: DryRunDefault,
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      const rows = toRows(p.items).filter(
        (r): r is Row & { kind: 'track' | 'episode' } =>
          (r.kind === 'track' || r.kind === 'episode') && r.durationMs != null,
      );
      const totalMs = rows.reduce((s, r) => s + (r.durationMs ?? 0), 0);
      const targetMs = args.target_minutes * 60_000;
      const toleranceMs = args.tolerance_sec * 1000;
      const source =
        args.keep_which === 'last' ? [...rows].reverse() : args.keep_which === 'random' ? sampleN(rows, rows.length) : rows;
      const kept: Row[] = [];
      let acc = 0;
      for (const row of source) {
        const next = acc + (row.durationMs ?? 0);
        if (next > targetMs + toleranceMs) break;
        kept.push(row);
        acc = next;
      }
      const keptUris = kept.map((r) => r.uri);
      const keptRuntime = kept.reduce((s, r) => s + (r.durationMs ?? 0), 0);
      const view = truncateItems(keptUris, resolveMaxResults(args.max_results, getConfig().maxItems));
      const payload: Record<string, unknown> = {
        ok: true,
        playlist: p.id,
        playlist_name: p.name,
        keep_which: args.keep_which,
        current_runtime_ms: totalMs,
        target_minutes: args.target_minutes,
        tolerance_sec: args.tolerance_sec,
        kept: kept.length,
        kept_runtime_ms: keptRuntime,
        kept_uris: keptUris,
        dry_run: isDry(args),
      };
      const prose = [
        `Trim "${p.name ?? p.id}" to ≈${args.target_minutes} min (±${args.tolerance_sec}s, keep_${args.keep_which}):`,
        `  current runtime ${msToClock(totalMs)} across ${rows.length} playable item(s);`,
        `  ${isDry(args) ? 'PLAN: would keep' : 'kept'} ${kept.length} item(s) → runtime ≈${msToClock(keptRuntime)}:`,
        ...view.items.map((u, i) => `  ${i + 1}. ${u}`),
        view.footer ? `(${view.footer})` : '',
        isDry(args) ? '' : batchSummary(kept.length, keptUris),
      ]
        .filter(Boolean)
        .join('\n');
      if (isDry(args)) return shape(args.response_format, `[dry run] ${prose}`, { ...payload, dry_run: true });
      const res = await atomicReplace(client, p.id, keptUris);
      return shape(args.response_format, `${prose}\nSnapshot ID: ${res.snapshot_id ?? 'n/a'}`, {
        ...payload,
        dry_run: false,
        requests: res.requests,
        snapshot_id: res.snapshot_id ?? null,
      });
    },
  );

  // -----------------------------------------------------------------------
  // #383 saved_tracks_roulette — deal N random cards from your saved tracks
  // -----------------------------------------------------------------------
  server.tool(
    'saved_tracks_roulette',
    'Deal N random cards from your saved tracks into a FRESH playlist — an instant rediscovery '
      + 'sampler. Quota: 🟡 getAllPages + 1 create + chunked adds.',
    {
      count: z.number().int().min(10).max(100).optional().describe('How many cards to deal (10–100). Default 20'),
      from: z.enum(['tracks', 'albums', 'episodes']).optional().describe('Save shelf to draw from. Default tracks'),
      name: z.string().optional().describe('New playlist name. Default "Saved Roulette YYYY-MM-DD"'),
      dedupe: z.boolean().optional().describe('Drop duplicate uris before dealing. Default false'),
      public: PublicFlag,
      response_format: ResponseFormat,
      dry_run: DryRunDefault,
    },
    async (args) => {
      const rf = args.response_format;
      const shelf = args.from ?? 'tracks';
      const path = shelf === 'tracks' ? '/me/tracks' : '/me/episodes';
      const rows = await client.getAllPages<{ added_at: string; track?: SpotifyTrack; episode?: SpotifyEpisode }>(
        path,
        { limit: '50' },
        { maxItems: getConfig().fetchAllCap },
      );
      const deck = rows
        .map((r) => (shelf === 'albums' ? null : r.track ?? r.episode ?? null))
        .filter((p): p is SpotifyTrack | SpotifyEpisode => !!p?.uri);
      let pool = deck.map((p) => p.uri);
      if (args.dedupe) pool = [...new Set(pool)];
      const dealt = sampleN(pool, args.count ?? 20);
      const name = args.name ?? `Saved Roulette ${formatDateStamp()}`;
      if (isDry(args)) {
        return dryOut('deal roulette cards', `new playlist "${name}"`, [
          `Draw ${dealt.length} random uris from ${pool.length} saved ${shelf} (${deck.length} playable):`,
          ...dealt.map((u) => `  - ${u}`),
          args.dedupe ? '(duplicates dropped first)' : '(duplicates kept — deck may repeat)',
        ]);
      }
      const created = await createPlaylist(client, name, args.public ?? false);
      const add = await addUrisChunked(client, created, dealt);
      return shape(rf, `Dealt ${dealt.length} random ${shelf} into new playlist ${created}.`, {
        ok: true,
        playlist: created,
        name,
        deck_size: pool.length,
        dealt: dealt.length,
        requests: add.requests,
      });
    },
  );

  // -----------------------------------------------------------------------
  // #384 playlist_slice — copy items[start..end] / first/last N / date range
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_slice',
    'Copy a slice of one playlist — positions start..end, first/last N, or an added-at date '
      + 'range — into a NEW playlist. Era snapshots, side A/B, decadal splits. '
      + 'Quota: 🟢 GET + create + chunked adds.',
    {
      playlist_id: z.string().describe('Source playlist (ID or spotify:playlist: URI)'),
      mode: z.enum(['first', 'last', 'range', 'added_between']).describe('Slice mode'),
      start: z.number().int().min(0).optional().describe('range: 0-based inclusive start (default 0)'),
      end: z.number().int().min(0).optional().describe('range: 0-based EXCLUSIVE end'),
      count: z.number().int().min(1).optional().describe('first/last: how many items (default 10)'),
      date_from: z.string().optional().describe('added_between: inclusive YYYY-MM-DD'),
      date_to: z.string().optional().describe('added_between: inclusive YYYY-MM-DD'),
      name: z.string().describe('Name for the new slice playlist'),
      public: PublicFlag,
      response_format: ResponseFormat,
      max_results: MaxResults,
      dry_run: DryRunDefault,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      const entries = p.items;
      let sliced: PlaylistItemObject[];
      if (args.mode === 'first' || args.mode === 'last') {
        const n = args.count ?? 10;
        sliced = args.mode === 'first' ? entries.slice(0, n) : entries.slice(-n);
      } else if (args.mode === 'range') {
        sliced = entries.slice(args.start ?? 0, args.end ?? entries.length);
      } else {
        const from = args.date_from ? dateNum(args.date_from) : 0;
        const to = args.date_to ? dateNum(args.date_to) : 99999999;
        sliced = entries.filter((e) => {
          const n = dateNum(e.added_at ?? '');
          return n >= from && n <= to;
        });
      }
      const uris = sliced.map((e) => e.item?.uri).filter(Boolean) as string[];
      const view = truncateItems(uris, resolveMaxResults(args.max_results, getConfig().maxItems));
      if (isDry(args)) {
        return dryOut('slice playlist', `new playlist "${args.name}"`, [
          `Copy ${uris.length} of ${entries.length} item(s) (${args.mode}) into "${args.name}":`,
          ...view.items.map((u, i) => `  ${i + 1}. ${u}`),
          view.footer ? `(${view.footer})` : '',
        ]);
      }
      const created = await createPlaylist(client, args.name, args.public ?? false);
      const add = await addUrisChunked(client, created, uris);
      return shape(rf, `Created "${args.name}" (${created}) with ${uris.length} sliced item(s).`, {
        ok: true,
        source: p.id,
        playlist: created,
        mode: args.mode,
        copied: uris.length,
        requests: add.requests,
      });
    },
  );

  // -----------------------------------------------------------------------
  // #385 playlist_names_bulk_normalize — one-shot name hygiene
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_names_bulk_normalize',
    'One-shot name hygiene across your library: strip "(Official Copy)"-style noise, trailing '
      + '"2" duplicates, apply a prefix/suffix, or renumber. Preview → commit. '
      + 'Quota: 🟡 GET + N PUTs (N = renamed only).',
    {
      op: z.enum(['strip_noise', 'prefix', 'suffix', 'renumber']).optional().describe('Normalize op. Default strip_noise'),
      prefix: z.string().optional().describe('prefix: text to prepend'),
      suffix: z.string().optional().describe('suffix: text to append'),
      match: z.string().optional().describe('Only rename playlists whose name contains this substring'),
      apply_to: z.enum(['owned', 'all']).optional().describe('Rename only your own playlists or every followed one. Default owned'),
      response_format: ResponseFormat,
      dry_run: DryRunDefault,
    },
    async (args) => {
      const rf = args.response_format;
      const op = args.op ?? 'strip_noise';
      if (op === 'prefix' && !args.prefix) throw new Error('prefix op requires --prefix');
      if (op === 'suffix' && !args.suffix) throw new Error('suffix op requires --suffix');
      const playlists = await client.getAllPages<SpotifyPlaylistSimple>(
        '/me/playlists',
        { limit: '50' },
        { maxItems: getConfig().fetchAllCap },
      );
      const owned = (pl: SpotifyPlaylistSimple): boolean => {
        if (args.apply_to === 'all') return true;
        return pl.owner?.id != null; // /me/playlists lists own first; owner id presence = owned
      };
      const seen = new Map<string, number>();
      const renames: Array<{ id: string; from: string; to: string }> = [];
      for (const pl of playlists) {
        if (!pl?.id || !owned(pl)) continue;
        if (args.match && !pl.name.includes(args.match)) continue;
        let to = pl.name;
        if (op === 'strip_noise') {
          to = to.replace(/\s*\((?:official|copy|official copy|deluxe|remastered)[^)]*\)/gi, '');
          to = to.replace(/\s*\[\s*\]\s*/g, ' ').trim();
          to = to.replace(/\s+(\d{1,2})$/, ''); // trailing duplicate "2"
        } else if (op === 'prefix') {
          to = `${args.prefix}${pl.name}`;
        } else if (op === 'suffix') {
          to = `${pl.name}${args.suffix}`;
        } else {
          const n = (seen.get(pl.name) ?? 0) + 1;
          seen.set(pl.name, n);
          to = n === 1 ? pl.name : `${pl.name} ${n}`;
        }
        if (to && to !== pl.name) renames.push({ id: pl.id, from: pl.name, to });
      }
      if (isDry(args)) {
        return dryOut('bulk normalize names', `${renames.length} playlist(s)`, [
          ...renames.map((r) => `  "${r.from}" → "${r.to}"`),
        ]);
      }
      let renamed = 0;
      for (const r of renames) {
        await client.put(`/playlists/${encodeURIComponent(r.id)}`, { name: r.to });
        renamed++;
      }
      return shape(rf, `Renamed ${renamed} playlist(s).`, { ok: true, renamed, renames });
    },
  );

  // -----------------------------------------------------------------------
  // #386 playlist_keep_only — inverse removal, atomic single replace
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_keep_only',
    'Inverse removal: keep only matching items (by uri / artist / type / query) and drop '
      + 'everything else — one atomic replace, no N+1 deletes. '
      + 'Quota: 🟢 GET + 1 PUT.',
    {
      playlist_id: z.string().describe('Playlist to prune (ID or spotify:playlist: URI)'),
      keep_by: z.enum(['uris', 'artist', 'type', 'query']).describe('Match mode for what to KEEP'),
      values: z.array(z.string()).optional().describe('uris mode: track uris to keep'),
      artist: z.string().optional().describe('artist mode: keep tracks by this artist (ID/URI or name)'),
      type: z.enum(['track', 'episode']).optional().describe('type mode: keep only this playable type'),
      query: z.string().optional().describe('query mode: keep items whose name contains this substring'),
      response_format: ResponseFormat,
      max_results: MaxResults,
      dry_run: DryRunDefault,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      const keepUris = new Set<string>();
      if (args.keep_by === 'uris') {
        if (!args.values?.length) throw new Error('keep_by=uris requires --values');
        args.values.forEach((u) => keepUris.add(u));
      } else if (args.keep_by === 'artist') {
        if (!args.artist) throw new Error('keep_by=artist requires --artist');
        const wanted = normalizeArtistRef(args.artist).toLowerCase();
        for (const { artists, row } of rowArtists(p.items)) {
          if (
            artists.some((a) => (a.id ?? '').toLowerCase() === wanted || a.name.toLowerCase() === args.artist!.toLowerCase())
          ) {
            keepUris.add(row.uri);
          }
        }
      } else if (args.keep_by === 'type') {
        const t = args.type ?? 'track';
        for (const r of toRows(p.items)) if (r.kind === t) keepUris.add(r.uri);
      } else {
        if (!args.query) throw new Error('keep_by=query requires --query');
        const q = args.query.toLowerCase();
        for (const r of toRows(p.items)) if (r.name.toLowerCase().includes(q)) keepUris.add(r.uri);
      }
      const kept = toRows(p.items).filter((r) => keepUris.has(r.uri));
      const dropped = toRows(p.items).filter((r) => r.uri && !keepUris.has(r.uri));
      const view = truncateItems(kept.map((r) => r.uri), resolveMaxResults(args.max_results, getConfig().maxItems));
      if (isDry(args)) {
        return dryOut('keep only matches', p.id, [
          `Keep ${kept.length} item(s), drop ${dropped.length} (${p.name ?? p.id}):`,
          ...view.items.map((u, i) => `  keep ${i + 1}. ${u}`),
          view.footer ? `(${view.footer})` : '',
        ]);
      }
      const res = await atomicReplace(client, p.id, kept.map((r) => r.uri));
      return shape(rf, `Kept ${kept.length}, dropped ${dropped.length} from ${p.id}.`, {
        ok: true,
        playlist: p.id,
        kept: kept.length,
        dropped: dropped.length,
        requests: res.requests,
      });
    },
  );

  // -----------------------------------------------------------------------
  // #387 playlist_strip_episodes — purify music playlists (or vice versa)
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_strip_episodes',
    'Purify a playlist after collab drift: strip every podcast EPISODE (or every TRACK) with one '
      + 'client-side filter + atomic replace. Quota: 🟢 GET + 1 PUT.',
    {
      playlist_id: z.string().describe('Playlist to purify (ID or spotify:playlist: URI)'),
      strip: z.enum(['episodes', 'tracks']).optional().describe('What to remove. Default episodes'),
      response_format: ResponseFormat,
      dry_run: DryRunDefault,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      const stripRaw = args.strip ?? 'episodes';
      const strip = stripRaw === 'tracks' ? 'track' : 'episode';
      const kept = toRows(p.items).filter((r) => r.uri && r.kind !== strip);
      const removed = toRows(p.items).filter((r) => r.uri && r.kind === strip);
      if (isDry(args)) {
        return dryOut(`strip ${stripRaw}`, p.id, [
          `Keep ${kept.length} item(s), remove ${removed.length} ${stripRaw}:`,
          ...removed.slice(0, 10).map((r) => `  - ${r.uri} "${r.name}"`),
        ], { stripped: removed.length, remaining: kept.length });
      }
      const res = await atomicReplace(client, p.id, kept.map((r) => r.uri));
      return shape(rf, `Stripped ${removed.length} ${strip}; ${kept.length} item(s) remain in ${p.id}.`, {
        ok: true,
        playlist: p.id,
        stripped: removed.length,
        remaining: kept.length,
        requests: res.requests,
      });
    },
  );

  // -----------------------------------------------------------------------
  // #388 playlist_move_to_top — bring matches to the front, one replace
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_move_to_top',
    'Bring matching items (uris / artist / query) to the FRONT of a playlist in one atomic '
      + 'replace. Deliberately avoids Spotify reorder N+1 for large moves. '
      + 'Quota: 🟢 GET + 1 PUT.',
    {
      playlist_id: z.string().describe('Playlist to reorder (ID or spotify:playlist: URI)'),
      match_uris: z.array(z.string()).optional().describe('Track uris to move to the top'),
      artist: z.string().optional().describe('Move every track by this artist (ID/URI or name)'),
      query: z.string().optional().describe('Move items whose name contains this substring'),
      stable_order: z.boolean().optional().describe('Keep playlist order among matches and non-matches. Default true'),
      response_format: ResponseFormat,
      dry_run: DryRunDefault,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      const matchUris = new Set<string>(args.match_uris ?? []);
      if (args.artist) {
        const wanted = normalizeArtistRef(args.artist).toLowerCase();
        for (const { artists, row } of rowArtists(p.items)) {
          if (artists.some((a) => (a.id ?? '').toLowerCase() === wanted || a.name.toLowerCase() === args.artist!.toLowerCase())) {
            matchUris.add(row.uri);
          }
        }
      }
      if (args.query) {
        const q = args.query.toLowerCase();
        for (const r of toRows(p.items)) if (r.name.toLowerCase().includes(q)) matchUris.add(r.uri);
      }
      const all = toRows(p.items).filter((r) => r.uri);
      const matched = all.filter((r) => matchUris.has(r.uri));
      const rest = all.filter((r) => !matchUris.has(r.uri));
      const ordered = args.stable_order === false ? [...sampleN(matched, matched.length), ...rest] : [...matched, ...rest];
      if (isDry(args)) {
        return dryOut('move to top', p.id, [
          `Move ${matched.length} matched item(s) to the front of ${matched.length + rest.length}:`,
          ...ordered.slice(0, 10).map((r, i) => `  ${i + 1}. ${r.uri} "${r.name}"`),
        ]);
      }
      const res = await atomicReplace(client, p.id, ordered.map((r) => r.uri));
      return shape(rf, `Moved ${matched.length} matched item(s) to the top of ${p.id}.`, {
        ok: true,
        playlist: p.id,
        moved: matched.length,
        requests: res.requests,
      });
    },
  );

  // -----------------------------------------------------------------------
  // #389 playlist_exclude_artists — purge the artist one-shot
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_exclude_artists',
    'Remove every track by one or more artist IDs from a playlist — the "purge the artist" '
      + 'one-shot. Quota: 🟢 GET + chunked deletes.',
    {
      playlist_id: z.string().describe('Playlist to purge (ID or spotify:playlist: URI)'),
      artist_ids: z.array(z.string()).min(1).max(20).describe('Artist IDs/URIs to exclude (1–20)'),
      dedupe_scope: z.enum(['playlist', 'library', 'none']).optional().describe(
        'playlist (default): only drop uris duplicated INSIDE this playlist; '
          + 'library: also drop candidates that are saved in /me/tracks; none: drop every candidate',
      ),
      response_format: ResponseFormat,
      dry_run: DryRunDefault,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      const excluded = new Set(args.artist_ids.map((a) => normalizeArtistRef(a).toLowerCase()));
      const removable = new Set<string>();
      for (const { artists, row } of rowArtists(p.items)) {
        if (artists.some((a) => excluded.has((a.id ?? '').toLowerCase()))) removable.add(row.uri);
      }
      const scope = args.dedupe_scope ?? 'playlist';
      const dedupe = await resolveDedupeParams(client, p.items, scope);
      const candidates = dedupe.candidates.filter((c) => removable.has(c.uri));
      const positions = candidates.flatMap((c) => c.positions);
      const payload: Record<string, unknown> = {
        ok: true,
        playlist: p.id,
        playlist_name: p.name,
        excluded_artists: [...excluded],
        scope,
        candidates: candidates.map((c) => c.uri),
        removals: positions.length,
        duplicates_in_playlist: dedupe.duplicatesInPlaylist,
        library_overlap: dedupe.libraryOverlap,
        dry_run: isDry(args),
      };
      if (isDry(args)) {
        const changes = [
          `Remove ${positions.length} occurrence(s) of ${candidates.length} track(s) by ${excluded.size} artist(s):`,
          ...candidates.slice(0, 10).map((c) => `  - ${c.uri} (positions ${c.positions.join(', ')})`),
          scope === 'library' && dedupe.libraryOverlap != null
            ? `  ${dedupe.libraryOverlap} candidate(s) are also saved in your library`
            : '',
        ].filter(Boolean);
        return dryOut('exclude artists', p.id, changes);
      }
      let requests = 0;
      for (let start = 0; start < positions.length; start += 100) {
        await client.delete(`/playlists/${encodeURIComponent(p.id)}/items`, {
          tracks: positions.slice(start, start + 100).map((i) => ({ uri: p.items[i].item?.uri })),
        });
        requests++;
      }
      return shape(rf, `Removed ${positions.length} occurrence(s) from ${p.id}.`, {
        ...payload,
        dry_run: false,
        requests,
      });
    },
  );

  // -----------------------------------------------------------------------
  // #390 playlist_staleness_score — days since last save, grade + advice
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_staleness_score',
    'Local staleness check: days since the most-recent / median added_at in a playlist, a '
      + 'fresh/aging/stale/fossil grade, and refresh suggestions. Read-only. '
      + 'Quota: 🟢 1–2 GETs.',
    {
      playlist_id: z.string().describe('Playlist to score (ID or spotify:playlist: URI)'),
      threshold_days: z.number().int().min(1).optional().describe('Days over which a playlist counts as stale. Default 90'),
      market: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 market for availability, e.g. \'US\''),
      response_format: ResponseFormat,
      max_results: MaxResults,
      dry_run: DryRun,
    },
    async (args) => {
      const rf = args.response_format;
      const id = normalizePlaylistRef(args.playlist_id);
      const meta = await client.get<{ id?: string; name?: string; items?: { total?: number } }>(
        `/playlists/${encodeURIComponent(id)}`,
      );
      if (!meta) throw new Error(`Playlist "${args.playlist_id}" not found`);
      const items = await fetchAllItems(client, id);
      const now = Date.now();
      const ages = items
        .map((e) => daysBetween(e.added_at ?? '', now))
        .filter((a): a is number => a != null)
        .sort((a, b) => a - b);
      const medianAge = ages.length ? ages[Math.floor(ages.length / 2)] : null;
      const latestAge = ages.length ? ages[0] : null; // min = most recent save
      const threshold = args.threshold_days ?? 90;
      let grade: 'fresh' | 'aging' | 'stale' | 'fossil';
      if (latestAge == null) grade = 'fossil';
      else if (latestAge < 14) grade = 'fresh';
      else if (latestAge < threshold) grade = 'aging';
      else if (latestAge < threshold * 4) grade = 'stale';
      else grade = 'fossil';
      const suggestions: string[] = [];
      if (grade === 'stale' || grade === 'fossil') {
        suggestions.push('grow_playlist from listening data (same seed artist/track)');
        suggestions.push('playlist_fill_from_search with a few hand-picked queries');
      }
      if (grade === 'aging') suggestions.push('top up with a couple of new releases via playlist_add_by_search');
      if (grade === 'fresh') suggestions.push('no action needed — ride the momentum');
      const payload: Record<string, unknown> = {
        ok: true,
        playlist: id,
        playlist_name: meta.name ?? null,
        items: items.length,
        days_since_latest: latestAge,
        median_age_days: medianAge,
        threshold_days: threshold,
        grade,
        suggestions,
      };
      if (args.response_format === 'json') return shape(rf, '', payload);
      return shape(
        rf,
        [
          `"${meta.name ?? id}" staleness: ${grade.toUpperCase()}`,
          `  ${items.length} item(s); latest save ${latestAge ?? '?'} day(s) ago; median save ${medianAge ?? '?'} day(s) old (threshold ${threshold}).`,
          `  Suggestions: ${suggestions.join(' | ')}`,
        ].join('\n'),
        payload,
      );
    },
  );

  // -----------------------------------------------------------------------
  // #391 playlist_artist_heat — repetition concentration
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_artist_heat',
    'Local artist-concentration check: top-artist share, an HHI concentration index, and the '
      + 'repeat-offender list with track counts. "Is this mix just one band?" '
      + 'Quota: 🟢 1 GET.',
    {
      playlist_id: z.string().describe('Playlist to analyse (ID or spotify:playlist: URI)'),
      top_n: z.number().int().min(1).optional().describe('Artists to list. Default 5'),
      response_format: ResponseFormat,
      max_results: MaxResults,
      dry_run: DryRun,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      const counts = new Map<string, { name: string; tracks: number }>();
      let trackCount = 0;
      for (const { artists } of rowArtists(p.items)) {
        trackCount++;
        const primary = artists[0];
        if (!primary) continue;
        const key = primary.id ?? primary.name.toLowerCase();
        const entry = counts.get(key) ?? { name: primary.name, tracks: 0 };
        entry.tracks++;
        counts.set(key, entry);
      }
      const ranked = [...counts.entries()]
        .map(([key, v]) => ({ key, ...v, share: trackCount ? v.tracks / trackCount : 0 }))
        .sort((a, b) => b.tracks - a.tracks || a.name.localeCompare(b.name));
      const hhi = ranked.reduce((s, r) => s + r.share * r.share, 0);
      const topN = args.top_n ?? 5;
      const offenders = ranked.filter((r) => r.tracks >= 3);
      const payload: Record<string, unknown> = {
        ok: true,
        playlist: p.id,
        playlist_name: p.name,
        tracks: trackCount,
        distinct_artists: ranked.length,
        top_artist_share: ranked[0]?.share ?? 0,
        hhi: Number(hhi.toFixed(4)),
        top_artists: ranked.slice(0, topN).map((r) => ({ name: r.name, tracks: r.tracks, share: Number(r.share.toFixed(3)) })),
        repeat_offenders: offenders.map((r) => ({ name: r.name, tracks: r.tracks })),
      };
      if (args.response_format === 'json') return shape(rf, '', payload);
      const lines = [
        `"${p.name ?? p.id}" artist heat:`,
        `  ${trackCount} track(s), ${ranked.length} distinct primary artist(s); top share ${(100 * (ranked[0]?.share ?? 0)).toFixed(1)}%; HHI ${hhi.toFixed(4)}.`,
        '  Top:',
        ...ranked.slice(0, topN).map((r) => `    • ${r.name}: ${r.tracks} track(s) (${(100 * r.share).toFixed(1)}%)`),
      ];
      if (offenders.length) lines.push(`  Repeat offenders (≥3): ${offenders.map((r) => `${r.name} (${r.tracks})`).join(', ')}`);
      return shape(rf, lines.join('\n'), payload);
    },
  );

  // -----------------------------------------------------------------------
  // #392 playlist_era_profile — release-year / decade histogram
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_era_profile',
    'Local release-era profile: decade histogram, median track age, and a time-capsule verdict. '
      + 'Pairs with playlist_era slices. Quota: 🟢 1 GET (market refetch disclosed).',
    {
      playlist_id: z.string().describe('Playlist to profile (ID or spotify:playlist: URI)'),
      market: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 market, e.g. \'US\' — when given, items are REFETCHED with this market so album release dates resolve (disclosed second GET)'),
      response_format: ResponseFormat,
      max_results: MaxResults,
      dry_run: DryRun,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      if (args.market) await fetchAllItems(client, p.id); // market refetch (disclosed)
      const albums = new Map<string, string>(); // album id → release_date
      for (const entry of p.items) {
        const t = entry.item;
        if (!isTrack(t) || !t.album?.id) continue;
        const rel = (t.album as SpotifyAlbumSimple & { release_date?: string }).release_date;
        if (rel) albums.set(t.album.id, rel);
      }
      const years = [...albums.values()].map((d) => parseInt(d.slice(0, 4), 10)).filter((n) => n > 0);
      const decadeOf = (y: number): string => `${Math.floor(y / 10) * 10}s`;
      const decades = new Map<string, number>();
      for (const y of years) {
        const d = decadeOf(y);
        decades.set(d, (decades.get(d) ?? 0) + 1);
      }
      const sortedYears = [...years].sort((a, b) => a - b);
      const medianYear = sortedYears.length ? sortedYears[Math.floor(sortedYears.length / 2)] : null;
      const nowYear = new Date().getFullYear();
      const medianAge = medianYear ? nowYear - medianYear : null;
      const verdict =
        years.length === 0
          ? 'UNKNOWN — no release dates resolved (try --market)'
          : medianAge != null && medianAge <= 5
            ? 'CURRENT'
            : medianAge != null && medianAge <= 15
              ? 'MIXED'
              : 'TIME CAPSULE';
      const histogram = [...decades.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const payload: Record<string, unknown> = {
        ok: true,
        playlist: p.id,
        playlist_name: p.name,
        albums_resolved: years.length,
        albums_total: albums.size,
        decade_histogram: Object.fromEntries(histogram),
        median_year: medianYear,
        median_track_age_years: medianAge,
        verdict,
      };
      if (args.response_format === 'json') return shape(rf, '', payload);
      return shape(
        rf,
        [
          `"${p.name ?? p.id}" era profile: ${verdict}`,
          years.length === 0 ? '' : `  Median year ${medianYear} (≈${medianAge}y old) across ${years.length} album(s).`,
          ...histogram.map(([d, n]) => `    ${d}: ${n}`),
          args.market ? '  (items refetched with the given market to resolve release dates)' : '',
        ]
          .filter(Boolean)
          .join('\n'),
        payload,
      );
    },
  );

  // -----------------------------------------------------------------------
  // #393 playlist_overlap_matrix — pairwise Jaccard
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_overlap_matrix',
    'Pairwise Jaccard overlap for 2–10 playlists — which of your mixes have drifted into the '
      + 'same set. Quota: 🟢 N GETs.',
    {
      playlist_ids: z.array(z.string()).min(2).max(10).describe('Playlists to compare (2–10)'),
      min_overlap: z.number().min(0).max(1).optional().describe('Jaccard threshold to report a pair. Default 0.5'),
      response_format: ResponseFormat,
      max_results: MaxResults,
      dry_run: DryRun,
    },
    async (args) => {
      const rf = args.response_format;
      const loaded = await Promise.all(args.playlist_ids.map((ref) => loadPlaylistFull(client, ref)));
      const sets = loaded.map((p) => new Set(trackRows(p.items).map((r) => r.uri)));
      const threshold = args.min_overlap ?? 0.5;
      const pairs: Array<{ a: string; b: string; intersection: number; union: number; jaccard: number }> = [];
      for (let i = 0; i < sets.length; i++) {
        for (let j = i + 1; j < sets.length; j++) {
          const inter = [...sets[i]].filter((u) => sets[j].has(u)).length;
          const uni = new Set([...sets[i], ...sets[j]]).size;
          const jac = uni ? inter / uni : 0;
          if (jac >= threshold) {
            pairs.push({ a: loaded[i].name ?? loaded[i].id, b: loaded[j].name ?? loaded[j].id, intersection: inter, union: uni, jaccard: Number(jac.toFixed(3)) });
          }
        }
      }
      pairs.sort((x, y) => y.jaccard - x.jaccard);
      const payload: Record<string, unknown> = {
        ok: true,
        playlists: loaded.map((p) => ({ id: p.id, name: p.name, tracks: sets[loaded.indexOf(p)].size })),
        threshold,
        pairs,
      };
      if (args.response_format === 'json') return shape(rf, '', payload);
      return shape(
        rf,
        [
          `Overlap (Jaccard ≥ ${threshold}) across ${loaded.length} playlists:`,
          ...loaded.map((p, i) => `  • ${p.name ?? p.id}: ${sets[i].size} track(s)`),
          ...pairs.map((p) => `  ~ ${p.a} ↔ ${p.b}: ${p.intersection}/${p.union} = ${p.jaccard}`),
          pairs.length === 0 ? '  (no pairs above threshold)' : '',
        ]
          .filter(Boolean)
          .join('\n'),
        payload,
      );
    },
  );

  // -----------------------------------------------------------------------
  // #394 saved_tracks_by_artist — library shelf lookup
  // -----------------------------------------------------------------------
  server.tool(
    'saved_tracks_by_artist',
    'List your SAVED tracks for one artist ("everything I\'ve saved by X"): resolves the artist '
      + 'ID when given a name, then filters the liked shelf. Quota: 🟡 getAllPages + 1 search (name input).',
    {
      artist: z.string().describe('Artist ID/URI, or a name (1 search to resolve)'),
      market: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 market for the artist search, e.g. \'US\''),
      response_format: ResponseFormat,
      max_results: MaxResults,
      dry_run: DryRun,
    },
    async (args) => {
      const rf = args.response_format;
      const parsedId = parseSpotifyUri(args.artist)?.type === 'artist' ? parseSpotifyUri(args.artist)!.id : null;
      let artistId = parsedId ?? normalizeArtistRef(args.artist);
      let artistName = parsedId ? null : args.artist;
      if (!parsedId && !/^[0-9a-zA-Z]{22}$/.test(artistId)) {
        const params: Record<string, string> = { q: args.artist, type: 'artist', limit: '1' };
        if (args.market) params.market = args.market;
        const found = await getWithGating<SearchLike>(client, '/search', params);
        const hit = found?.artists?.items?.[0];
        if (!hit?.id) throw new Error(`No artist found for "${args.artist}"`);
        artistId = hit.id;
        artistName = hit.name;
      }
      if (!parsedId && (!artistName || /^[0-9a-zA-Z]{22}$/.test(args.artist))) {
        const full = await getWithGating<ArtistLite & { name: string }>(client, `/artists/${encodeURIComponent(artistId)}`);
        artistName = full?.name ?? artistName;
      }
      const saved = await listAllMeType(client, 'tracks');
      const wanted = artistId.toLowerCase();
      const rows = saved
        .filter((row) => {
          const t = (row as SavedTrackItem).track;
          return t?.artists?.some((a) => (a.id ?? '').toLowerCase() === wanted || a.name.toLowerCase() === (artistName ?? '\u0000').toLowerCase());
        })
        .map((row) => {
          const t = (row as SavedTrackItem).track!;
          return { uri: t.uri, name: t.name, added_at: row.added_at, album: t.album?.name ?? null };
        });
      const view = truncateItems(rows, resolveMaxResults(args.max_results, getConfig().maxItems));
      const payload: Record<string, unknown> = {
        ok: true,
        artist_id: artistId,
        artist_name: artistName ?? null,
        saved_count: rows.length,
        tracks: view.items,
      };
      if (args.response_format === 'json') return shape(rf, '', payload);
      return shape(
        rf,
        [
          `Saved tracks by ${artistName ?? artistId}: ${rows.length}`,
          ...view.items.map((t) => `  • ${t.name}${t.album ? ` — ${t.album}` : ''} (saved ${t.added_at})`),
          view.footer ? `(${view.footer})` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        payload,
      );
    },
  );

  // -----------------------------------------------------------------------
  // #395 saved_library_delta — snapshot vs now
  // -----------------------------------------------------------------------
  server.tool(
    'saved_library_delta',
    'Diff your current saved tracks/albums against a local backup snapshot (from backup_now): '
      + 'added since / removed since. Quota: 🟡 getAllPages walks + local file read.',
    {
      snapshot_id: z.string().optional().describe('Snapshot id or backup file name (e.g. "backup-2026-08-01-1")'),
      type: z.enum(['all', 'tracks', 'albums']).optional().describe('Which shelves to diff. Default all'),
      fresh_cap: z.number().int().min(1).optional().describe('Max fresh liked tracks to walk. Default fetch-all cap'),
      response_format: ResponseFormat,
      max_results: MaxResults,
      dry_run: DryRun,
    },
    async (args) => {
      const rf = args.response_format;
      const dir = backupDir();
      const files = (await readdir(dir)).filter((f) => f.endsWith('.json') && f.startsWith('backup-'));
      let fileName: string | undefined;
      if (args.snapshot_id) {
        const wanted = args.snapshot_id.endsWith('.json') ? args.snapshot_id : `${args.snapshot_id}.json`;
        fileName = files.includes(wanted) ? wanted : undefined;
        if (!fileName) throw new Error(`Snapshot "${args.snapshot_id}" not found in ${dir}`);
      } else {
        fileName = files.sort().pop();
        if (!fileName) throw new Error('No local backups found — run backup_now first.');
      }
      const raw = JSON.parse(await readFile(join(dir, fileName), 'utf8')) as {
        liked_tracks?: Array<{ uri?: string; name?: string }>;
        saved_albums?: Array<{ uri?: string; name?: string }>;
      };
      const shelves = (args.type ?? 'all') === 'albums' ? ['albums'] : (args.type ?? 'all') === 'tracks' ? ['tracks'] : ['tracks', 'albums'];
      const out: Record<string, unknown> = { ok: true, snapshot: fileName, shelves: {} };
      const prose: string[] = [`Library delta vs ${fileName}:`];
      if (shelves.includes('tracks')) {
        const fresh = await listAllMeType(client, 'tracks');
        const freshUris = fresh.map(rowUri);
        const snapUris = (raw.liked_tracks ?? []).map((t) => t.uri ?? '').filter(Boolean);
        const added = differenceOf(freshUris, snapUris);
        const removed = differenceOf(snapUris, freshUris);
        out.shelves = { ...(out.shelves as object), tracks: { added: added.length, removed: removed.length, added_uris: added, removed_uris: removed } };
        const addedView = truncateItems(added, resolveMaxResults(args.max_results, getConfig().maxItems));
        prose.push(
          `  Tracks: +${added.length} / −${removed.length}`,
          ...addedView.items.map((u) => `    + ${u}`),
          addedView.footer ? `(${addedView.footer})` : '',
        );
      }
      if (shelves.includes('albums')) {
        const fresh = await listAllMeType(client, 'albums');
        const freshUris = fresh.map(rowUri);
        const snapUris = (raw.saved_albums ?? []).map((t) => t.uri ?? '').filter(Boolean);
        const added = differenceOf(freshUris, snapUris);
        const removed = differenceOf(snapUris, freshUris);
        out.shelves = { ...(out.shelves as object), albums: { added: added.length, removed: removed.length, added_uris: added, removed_uris: removed } };
        prose.push(`  Albums: +${added.length} / −${removed.length}`);
      }
      return shape(rf, prose.filter(Boolean).join('\n'), out);
    },
  );

  // -----------------------------------------------------------------------
  // #396 library_to_playlist — export liked shelf to a playlist
  // -----------------------------------------------------------------------
  server.tool(
    'library_to_playlist',
    'Export your saved tracks (or saved albums\' first tracks) into a NEW playlist — sort by '
      + 'save order, cap at N, chunked adds. Quota: 🟡 getAllPages + create + chunked adds.',
    {
      from: z.enum(['tracks', 'albums']).optional().describe('Which saved shelf to export. Default tracks'),
      name: z.string().optional().describe('Playlist name. Default "Liked Songs export YYYY-MM-DD"'),
      order: z.enum(['added_asc', 'added_desc']).optional().describe('Export order. Default added_asc'),
      limit: z.number().int().min(1).optional().describe('Max items to export. Default 500'),
      public: PublicFlag,
      response_format: ResponseFormat,
      max_results: MaxResults,
      dry_run: DryRunDefault,
    },
    async (args) => {
      const rf = args.response_format;
      const from = args.from ?? 'tracks';
      const order = args.order ?? 'added_asc';
      const cap = args.limit ?? getConfig().fetchAllCap;
      const rows = await listAllMeType(client, from);
      const sorted = order === 'added_desc' ? [...rows].reverse() : rows;
      const selected = sorted.slice(0, cap);
      const uris = selected.map(rowUri).filter(Boolean);
      const view = truncateItems(uris, resolveMaxResults(args.max_results, getConfig().maxItems));
      const name = args.name ?? `Liked Songs export ${formatDateStamp()}`;
      const plan: Record<string, unknown> = {
        ok: true,
        from,
        name,
        selected: uris.length,
        shelf_size: rows.length,
        resulting_uris: uris,
        dry_run: isDry(args),
      };
      if (isDry(args)) {
        const lines = [
          `[dry run] Export ${uris.length} saved ${from} (${order}) into new playlist "${name}":`,
          ...view.items.map((u, i) => `  ${i + 1}. ${u}`),
          view.footer ? `(${view.footer})` : '',
        ];
        return shape(args.response_format, lines.filter(Boolean).join('\n'), plan);
      }
      const created = await createPlaylist(client, name, args.public ?? false, 'Liked Songs export via library_to_playlist');
      if (uris.length > 0) await addUrisChunked(client, created, uris);
      const text =
        `Exported ${selected.length} saved ${from} (${order}) to new playlist "${name}" (${created}).`
        + `\n${batchSummary(uris.length, uris)}`;
      return rf === 'json' ? shape(args.response_format, '', { ...plan, dry_run: false, playlist: created }) : textResult(text, plan);
    },
  );

  // -----------------------------------------------------------------------
  // #397 collab_mix_from_followed — recent releases of followed artists
  // -----------------------------------------------------------------------
  server.tool(
    'collab_mix_from_followed',
    'Build a collaborative-style mix playlist from your FOLLOWED artists\' recent releases: walks '
      + '/me/following (cursor-paged, capped by artists_cap), fans out one albums GET per artist '
      + 'plus one album GET per picked album (concurrency 5 — disclosed fan-out), takes ≤per_artist '
      + 'newest tracks per artist, then round-robin-merges them into a new playlist. '
      + 'dry_run=true (default) previews the mix. Quota: 🔴 ~artists_cap×(1+per_artist) GETs + create/adds.',
    {
      artists_cap: z.number().int().min(1).max(20).optional().describe('Max followed artists to include (default 10)'),
      per_artist: z.number().int().min(1).max(5).optional().describe('Max tracks per artist (1–5, default 2)'),
      days: z.number().int().min(1).max(365).optional().describe('Only albums released in the last N days (default 30)'),
      name: z.string().optional().describe('Playlist name. Default: "Collab Mix — <today>"'),
      dry_run: DryRunDefault,
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const dryRun = isDry(args);
      const artistsCap = args.artists_cap ?? 10;
      const perArtist = args.per_artist ?? 2;
      const days = args.days ?? 30;
      const cutoff = dateNum(
        new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10),
      );
      const artists: ArtistLite[] = [];
      let after: string | undefined;
      do {
        const page = await getWithGating<{ artists: { items: ArtistLite[]; cursors: { after: string | null } | null } }>(
          client,
          '/me/following',
          { type: 'artist', limit: '50', ...(after ? { after } : {}) },
        );
        const body = page?.artists;
        if (!body) break;
        artists.push(...body.items);
        after = body.cursors?.after ?? undefined;
      } while (after && artists.length < artistsCap);
      const pickedArtists = artists.slice(0, artistsCap);

      const perArtistTracks: string[][] = [];
      for (let i = 0; i < pickedArtists.length; i += 5) {
        const batch = pickedArtists.slice(i, i + 5);
        const settled = await Promise.all(
          batch.map(async (artist) => {
            const albumsPage = await client.get<{ items: SpotifyAlbumItem[] }>(
              `/artists/${encodeURIComponent(artist.id ?? '')}/albums`,
              { limit: '10' },
            );
            const newest = (albumsPage?.items ?? [])
              .filter((al) => dateNum(al.release_date ?? '') >= cutoff)
              .sort((a, b) => dateNum(b.release_date ?? '') - dateNum(a.release_date ?? ''));
            const tracks: string[] = [];
            for (const album of newest.slice(0, 2)) {
              const albumTracks = await client.get<{ items: { uri?: string; name?: string }[] }>(
                `/albums/${encodeURIComponent(album.id)}/tracks`,
                { limit: '10' },
              );
              for (const t of albumTracks?.items ?? []) {
                if (tracks.length >= perArtist) break;
                if (t?.uri) tracks.push(t.uri);
              }
              if (tracks.length >= perArtist) break;
            }
            return tracks;
          }),
        );
        perArtistTracks.push(...settled);
      }

      // Round-robin merge: one track per artist per round.
      const mix: string[] = [];
      const cursors = perArtistTracks.map(() => 0);
      let round = 0;
      let addedInRound = 1;
      while (addedInRound > 0) {
        addedInRound = 0;
        for (let a = 0; a < perArtistTracks.length; a++) {
          const pool = perArtistTracks[a];
          if (cursors[a] < pool.length) {
            mix.push(pool[cursors[a]++]);
            addedInRound++;
          }
        }
        round++;
      }
      void round;
      const name = args.name ?? `Collab Mix — ${formatDateStamp()}`;
      if (dryRun) {
        return dryOut('collab mix', `new playlist "${name}"`, [
          `Mix of ${pickedArtists.length} followed artist(s), ≤${perArtist} tracks each, released in the last ${days} day(s):`,
          ...mix.map((u) => `  - ${u}`),
          '(fan-out: ~1 albums GET + ≤2 album GETs per artist — disclosed)',
        ]);
      }
      const created = await createPlaylist(client, name, false);
      const add = await addUrisChunked(client, created, mix);
      return shape(rf, `Created "${name}" (${created}) with ${mix.length} tracks from ${pickedArtists.length} followed artist(s).`, {
        ok: true,
        playlist: created,
        artists: pickedArtists.map((a) => a.name),
        tracks: mix.length,
        requests: add.requests,
      });
    },
  );
}
