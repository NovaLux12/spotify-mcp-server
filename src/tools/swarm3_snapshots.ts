/** swarm3 snapshots slice — 500-tool swarm v1.26.0 (issue #442). Owned by snapshots builder. */
/**
 * Per-playlist local snapshots (distinct from backup.ts whole-library files).
 *
 * Each snapshot is a small JSON file in SPOTIFY_MCP_SNAPSHOT_DIR (default
 * ~/.spotify-mcp/playlist-snapshots) capturing one playlist's items — uri,
 * name, added_at — plus a cheap _meta block. Snapshots are READ-ONLY against
 * Spotify to create; the only write is the local file (dir 0700 / file 0600).
 *
 * Restore/merge tools mutate the live playlist only when dry_run=false; the
 * default is a deterministic PLAN (repo convention: previews are the default).
 * Playlist item ops use /playlists/{id}/items (Feb-2026 path, SPEC §9).
 */
import { z } from 'zod';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { getConfig } from '../config.js';
import {
  ResponseFormat,
  MaxResults,
  resolveMaxResults,
  truncateItems,
  parseSpotifyUri,
} from '../shaping.js';
import type { ResponseFormatValue } from '../shaping.js';
import { spotifyId } from '../refs.js';
import type { PlaylistItemObject } from '../types/spotify.js';

// ---------------------------------------------------------------------------
// On-disk contract
// ---------------------------------------------------------------------------

/** One snapshotted playlist row. */
export interface SnapTrackRow {
  uri: string;
  name: string;
  added_at: string | null;
}

/** Cheap top-level block so list/report tools never parse full track arrays. */
export interface SnapMeta {
  snapshot_id: string;
  playlist_id: string;
  playlist_name: string;
  playlist_uri: string | null;
  taken_at: string;
  track_count: number;
  unique_uris: number;
  notes?: string;
}

/** Top-level shape of a plsnap-*.json file. Unknown keys = forward-compatible. */
export interface PlaylistSnapshot {
  _meta: SnapMeta;
  tracks: SnapTrackRow[];
}

/** Snapshot dir; SPOTIFY_MCP_SNAPSHOT_DIR overrides the whole directory. */
export function snapshotDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SPOTIFY_MCP_SNAPSHOT_DIR ?? join(homedir(), '.spotify-mcp', 'playlist-snapshots');
}

const SNAP_FILE_RE = /^plsnap-([A-Za-z0-9]+)-(\d{4}-\d{2}-\d{2})-(\d+)\.json$/;
const BUNDLE_FILE_RE = /^snapbundle-(\d{4}-\d{2}-\d{2})-(\d+)\.json$/;

// ---------------------------------------------------------------------------
// Result shaping helpers (exhaust2 house style)
// ---------------------------------------------------------------------------

type TextContent = { type: 'text'; text: string };
type ToolResult = { content: TextContent[]; structuredContent?: Record<string, unknown> };

const jsonText = (data: unknown): string => JSON.stringify(data, null, 2);

/** json mode stringifies the payload; payload always rides as structuredContent. */
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
    'Preview only: perform the read side and return a deterministic PLAN without writing/deleting anything. '
      + 'Default true — pass false to commit.',
  );

const isDry = (args: { dry_run?: boolean }): boolean => args.dry_run ?? true;

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`;
}

function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Local file plumbing
// ---------------------------------------------------------------------------

function snapFileStem(filename: string): string {
  return filename.replace(/\.json$/, '');
}

/** List snapshot bundle files in dir (unsorted). */
async function listBundleFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((n) => BUNDLE_FILE_RE.test(n));
  } catch {
    return [];
  }
}

/** Next free sequence for a prefix + dateStamp inside dir (never clobbers). */
async function nextSeq(dir: string, re: RegExp, dateStamp: string, group: number): Promise<number> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return 1;
  }
  let max = 0;
  for (const n of names) {
    const m = re.exec(n);
    if (m && m[group] === dateStamp) max = Math.max(max, Number(m[3] ?? m[2]));
  }
  return max + 1;
}

/** Parse + minimally validate one snapshot file. Throws Error on corrupt data. */
export async function readSnapshotFile(path: string): Promise<PlaylistSnapshot> {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as Partial<PlaylistSnapshot>;
  if (!parsed || typeof parsed !== 'object') throw new Error('not a JSON object');
  if (!parsed._meta || typeof parsed._meta !== 'object') throw new Error('missing _meta block');
  if (typeof parsed._meta.playlist_id !== 'string') throw new Error('_meta.playlist_id missing');
  if (typeof parsed._meta.taken_at !== 'string') throw new Error('_meta.taken_at missing');
  if (!Array.isArray(parsed.tracks)) throw new Error('tracks array missing');
  for (const t of parsed.tracks) {
    if (!t || typeof t.uri !== 'string') throw new Error('track row missing uri');
  }
  return parsed as PlaylistSnapshot;
}

/**
 * Resolve a snapshot reference: absolute/relative path, full filename, or
 * snapshot_id (filename stem). Returns the resolved path.
 */
export async function resolveSnapshotRef(ref: string): Promise<string> {
  const trimmed = ref.trim();
  if (trimmed.includes('/')) return trimmed;
  const dir = snapshotDir();
  // Full filename?
  if (trimmed.endsWith('.json')) {
    const p = join(dir, trimmed);
    try {
      await stat(p);
      return p;
    } catch {
      throw new Error(`Snapshot file not found: ${p}`);
    }
  }
  // Snapshot id (stem) — exact match on any plsnap file's stem.
  const names = await listSnapFilenames(dir);
  const exact = names.find((n) => snapFileStem(n) === trimmed);
  if (exact) return join(dir, exact);
  throw new Error(
    `Snapshot '${trimmed}' not found in ${dir}. Use list_saved_snapshots to see available ids.`,
  );
}

/** List plsnap-*.json filenames in dir, sorted oldest→newest by name parts. */
async function listSnapFilenames(dir: string, playlistId?: string): Promise<string[]> {
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => SNAP_FILE_RE.test(n));
  } catch {
    return [];
  }
  if (playlistId) {
    names = names.filter((n) => {
      const m = SNAP_FILE_RE.exec(n);
      return m ? m[1] === playlistId : false;
    });
  }
  return names.sort((a, b) => a.localeCompare(b));
}

/** Load every snapshot (parsed + file size), sorted oldest→newest. Corrupt files get error entries. */
async function loadSnapshots(
  playlistId?: string,
): Promise<Array<{ file: string; path: string; bytes: number | null; snap: PlaylistSnapshot | null; error?: string }>> {
  const dir = snapshotDir();
  const names = await listSnapFilenames(dir, playlistId);
  const out = await Promise.all(
    names.map(async (file) => {
      const path = join(dir, file);
      try {
        const [snap, st] = await Promise.all([readSnapshotFile(path), stat(path)]);
        return { file, path, bytes: st.size, snap };
      } catch (e) {
        return {
          file,
          path,
          bytes: null,
          snap: null,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }),
  );
  // Deterministic order: valid ones by taken_at, corrupt ones last, tiebreak filename.
  return out.sort((x, y) => {
    const tx = x.snap ? Date.parse(x.snap._meta.taken_at) : Number.POSITIVE_INFINITY;
    const ty = y.snap ? Date.parse(y.snap._meta.taken_at) : Number.POSITIVE_INFINITY;
    return tx - ty || x.file.localeCompare(y.file);
  });
}

/** Group loaded snapshots by playlist_id (valid ones only), preserving order. */
function groupByPlaylist(
  loaded: Awaited<ReturnType<typeof loadSnapshots>>,
): Map<string, Array<{ file: string; path: string; bytes: number | null; snap: PlaylistSnapshot }>> {
  const groups = new Map<string, Array<{ file: string; path: string; bytes: number | null; snap: PlaylistSnapshot }>>();
  for (const l of loaded) {
    if (!l.snap) continue;
    const key = l.snap._meta.playlist_id;
    const arr = groups.get(key) ?? [];
    arr.push({ file: l.file, path: l.path, bytes: l.bytes, snap: l.snap });
    groups.set(key, arr);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Track diff core (multiset semantics so duplicate URIs behave sanely)
// ---------------------------------------------------------------------------

export interface TrackDiff {
  added: SnapTrackRow[];
  removed: SnapTrackRow[];
  added_count: number;
  removed_count: number;
  unchanged_count: number;
}

/** Diff track lists a (before) → b (after) by URI with multiset counting. */
export function diffTrackLists(a: SnapTrackRow[], b: SnapTrackRow[]): TrackDiff {
  const countA = new Map<string, number>();
  for (const r of a) countA.set(r.uri, (countA.get(r.uri) ?? 0) + 1);
  const countB = new Map<string, number>();
  for (const r of b) countB.set(r.uri, (countB.get(r.uri) ?? 0) + 1);

  const added: SnapTrackRow[] = [];
  const consumedInA = new Map<string, number>();
  for (const r of b) {
    const budget = countA.get(r.uri) ?? 0;
    const used = consumedInA.get(r.uri) ?? 0;
    if (used < budget) consumedInA.set(r.uri, used + 1);
    else added.push(r);
  }
  const removed: SnapTrackRow[] = [];
  const consumedInB = new Map<string, number>();
  for (const r of a) {
    const budget = countB.get(r.uri) ?? 0;
    const used = consumedInB.get(r.uri) ?? 0;
    if (used < budget) consumedInB.set(r.uri, used + 1);
    else removed.push(r);
  }
  return {
    added,
    removed,
    added_count: added.length,
    removed_count: removed.length,
    unchanged_count: a.length - removed.length,
  };
}

function diffLines(d: TrackDiff, maxNames: number): string[] {
  const lines: string[] = [];
  if (d.added_count === 0 && d.removed_count === 0) {
    lines.push('No track differences — identical track sets.');
    return lines;
  }
  lines.push(`+${d.added_count} added, -${d.removed_count} removed (${d.unchanged_count} unchanged).`);
  for (const r of d.added.slice(0, maxNames)) lines.push(`  + ${r.name || r.uri}`);
  if (d.added_count > maxNames) lines.push(`  … +${d.added_count - maxNames} more added`);
  for (const r of d.removed.slice(0, maxNames)) lines.push(`  - ${r.name || r.uri}`);
  if (d.removed_count > maxNames) lines.push(`  … -${d.removed_count - maxNames} more removed`);
  return lines;
}

// ---------------------------------------------------------------------------
// Live playlist fetch (read-only)
// ---------------------------------------------------------------------------

function itemToTrackRow(row: PlaylistItemObject): SnapTrackRow | null {
  const item = row.item;
  if (!item || typeof item !== 'object') return null;
  if (typeof item.uri !== 'string') return null;
  return {
    uri: item.uri,
    name: typeof item.name === 'string' ? item.name : '',
    added_at: typeof row.added_at === 'string' ? row.added_at : null,
  };
}

interface LivePlaylist {
  id: string;
  name: string;
  uri: string | null;
  tracks: SnapTrackRow[];
  reported_total: number | null;
}

/** Fetch a live playlist + its items via /playlists/{id}/items. */
async function fetchLivePlaylist(client: SpotifyClient, playlistId: string): Promise<LivePlaylist> {
  const meta = await client.get<{ id?: string; name?: string; uri?: string }>(
    `/playlists/${encodeURIComponent(playlistId)}`,
  );
  const rows = await client.getAllPages<PlaylistItemObject>(
    `/playlists/${encodeURIComponent(playlistId)}/items`,
    { limit: '100' },
  );
  const tracks: SnapTrackRow[] = [];
  for (const r of rows) {
    const t = itemToTrackRow(r);
    if (t) tracks.push(t);
  }
  return {
    id: meta?.id ?? playlistId,
    name: meta?.name ?? '(unknown)',
    uri: meta?.uri ?? null,
    tracks,
    reported_total:
      meta && typeof (meta as { items?: { total?: number } }).items?.total === 'number'
        ? (meta as { items: { total: number } }).items.total
        : null,
  };
}

/** Normalize a playlist ref (bare id or spotify:playlist: URI) to the raw id. */
function normalizePlaylistRef(ref: string): string {
  const parsed = parseSpotifyUri(ref);
  if (parsed && parsed.type === 'playlist') return parsed.id;
  return ref.trim();
}

// ---------------------------------------------------------------------------
// Mutation helpers (only called with dry_run=false)
// ---------------------------------------------------------------------------

async function applyPlaylistOps(
  client: SpotifyClient,
  playlistId: string,
  addUris: readonly string[],
  removeUris: readonly string[],
): Promise<{ added: number; removed: number; requests: number }> {
  let added = 0;
  let removed = 0;
  let requests = 0;
  for (const part of chunk(removeUris, 100)) {
    await client.delete(`/playlists/${encodeURIComponent(playlistId)}/items`, {
      tracks: part.map((uri) => ({ uri })),
    });
    removed += part.length;
    requests += 1;
  }
  for (const part of chunk(addUris, 100)) {
    await client.post(`/playlists/${encodeURIComponent(playlistId)}/items`, { uris: [...part] });
    added += part.length;
    requests += 1;
  }
  return { added, removed, requests };
}

interface RestoreOps {
  playlist_id: string;
  add_uris: string[];
  remove_uris: string[];
  add_requests: number;
  remove_requests: number;
}

/** Compute the add/remove ops that turn `live` into `target` (order-insensitive multiset). */
function computeRestoreOps(playlistId: string, live: SnapTrackRow[], target: SnapTrackRow[]): RestoreOps {
  const d = diffTrackLists(live, target);
  return {
    playlist_id: playlistId,
    add_uris: d.added.map((r) => r.uri),
    remove_uris: d.removed.map((r) => r.uri),
    add_requests: chunk(d.added.map((r) => r.uri), 100).length,
    remove_requests: chunk(d.removed.map((r) => r.uri), 100).length,
  };
}

function opsPlanLines(ops: RestoreOps): string[] {
  const lines: string[] = [];
  lines.push(`Remove ${ops.remove_uris.length} track(s) in ${ops.remove_requests} DELETE request(s).`);
  for (const u of ops.remove_uris.slice(0, 10)) lines.push(`  - ${u}`);
  if (ops.remove_uris.length > 10) lines.push(`  … ${ops.remove_uris.length - 10} more`);
  lines.push(`Add ${ops.add_uris.length} track(s) in ${ops.add_requests} POST request(s).`);
  for (const u of ops.add_uris.slice(0, 10)) lines.push(`  + ${u}`);
  if (ops.add_uris.length > 10) lines.push(`  … ${ops.add_uris.length - 10} more`);
  lines.push('Note: additive/subtractive restore — exact track ordering within the playlist is not preserved.');
  return lines;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSwarm3SnapshotsTools(server: McpServer, client: SpotifyClient): void {
  // -- 1. take_playlist_snapshot -------------------------------------------
  server.tool(
    'take_playlist_snapshot',
    'Capture a live playlist’s items (uri, name, added_at) into a timestamped local JSON snapshot file; dry_run=true previews the walk and target filename without writing. Newest, transactional snapshot (swarm) — preferred over legacy snapshot_playlist. See also list_saved_snapshots, read_playlist_snapshot, diff_playlist_snapshots. Also covers: playlist snapshot (swarm). Snapshot guide: take_playlist_snapshot (create), list_saved_snapshots (list), read_playlist_snapshot (read), diff_playlist_snapshots / snapshot_new_tracks / snapshot_removed_tracks (diff), restore_playlist_from_snapshot / restore_playlist_plan (restore).',
    {
      playlist: spotifyId('playlist').describe('Playlist ID or spotify:playlist: URI to snapshot'),
      notes: z.string().optional().describe('Free-text note stored in the snapshot _meta block'),
      max_results: MaxResults,
      response_format: ResponseFormat,
      dry_run: DryRunDefault,
    },
    async (args) => {
      const playlistId = normalizePlaylistRef(args.playlist);
      const cap = args.max_results ?? getConfig().fetchAllCap;
      if (isDry(args)) {
        const payload: Record<string, unknown> = {
          dry_run: true,
          playlist_id: playlistId,
          item_walk_cap: cap,
          dir: snapshotDir(),
          estimated_requests: Math.ceil(cap / 100) + 1,
        };
        const prose = [
          `[dry run] take_playlist_snapshot — playlist ${playlistId}`,
          `Would GET /playlists/${playlistId} (name/uri) then walk /playlists/${playlistId}/items at limit 100, capped at ${cap} items.`,
          `Would write ${snapshotDir()}/plsnap-<playlistId>-<today>-<seq>.json (dir 0700, file 0600).`,
          `Pass dry_run=false to take the snapshot.`,
        ].join('\n');
        return shape(args.response_format, prose, payload);
      }
      const live = await fetchLivePlaylist(client, playlistId);
      const taken = new Date().toISOString();
      const dir = snapshotDir();
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const dateStamp = taken.slice(0, 10);
      const seq = await nextSeq(dir, SNAP_FILE_RE, dateStamp, 2);
      const snapshotId = `plsnap-${playlistId}-${dateStamp}-${seq}`;
      const file = join(dir, `${snapshotId}.json`);
      const unique = new Set(live.tracks.map((t) => t.uri));
      const snapshot: PlaylistSnapshot = {
        _meta: {
          snapshot_id: snapshotId,
          playlist_id: live.id,
          playlist_name: live.name,
          playlist_uri: live.uri,
          taken_at: taken,
          track_count: live.tracks.length,
          unique_uris: unique.size,
          ...(args.notes !== undefined ? { notes: args.notes } : {}),
        },
        tracks: live.tracks,
      };
      const body = `${JSON.stringify(snapshot, null, 2)}\n`;
      await writeFile(file, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      const payload: Record<string, unknown> = {
        ok: true,
        snapshot_id: snapshotId,
        file,
        bytes: Buffer.byteLength(body),
        playlist_name: live.name,
        track_count: live.tracks.length,
        unique_uris: unique.size,
        reported_total: live.reported_total,
        ...(args.notes !== undefined ? { notes: args.notes } : {}),
      };
      const prose = [
        `Snapshot written → ${file} (${formatBytes(payload.bytes as number)})`,
        `- Playlist: ${live.name} (${live.id})`,
        `- Tracks: ${live.tracks.length} (${unique.size} unique${live.reported_total !== null ? `, reported total ${live.reported_total}` : ''})`,
      ].join('\n');
      return shape(args.response_format, prose, payload);
    },
  );

  // -- 2. list_saved_snapshots ------------------------------------------
  server.tool(
    'list_saved_snapshots',
    'List local playlist snapshots (newest first) with path, creation time, size, and the _meta summary; optionally filtered to one playlist Snapshot guide: take_playlist_snapshot (create), list_saved_snapshots (list), read_playlist_snapshot (read), diff_playlist_snapshots / snapshot_new_tracks / snapshot_removed_tracks (diff), restore_playlist_from_snapshot / restore_playlist_plan (restore).',
    {
      playlist: spotifyId('playlist').optional().describe('Only snapshots of this playlist (ID or URI)'),
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args) => {
      const playlistId = args.playlist ? normalizePlaylistRef(args.playlist) : undefined;
      const loaded = (await loadSnapshots(playlistId)).reverse(); // newest first
      const maxResults = resolveMaxResults(args.max_results);
      const { items, truncated, footer } = truncateItems(loaded, maxResults);
      const rows = items.map((l) => ({
        snapshot_id: l.snap?._meta.snapshot_id ?? snapFileStem(l.file),
        playlist_id: l.snap?._meta.playlist_id ?? null,
        playlist_name: l.snap?._meta.playlist_name ?? null,
        taken_at: l.snap?._meta.taken_at ?? null,
        track_count: l.snap?._meta.track_count ?? null,
        bytes: l.bytes,
        path: l.path,
        ...(l.error ? { error: l.error } : {}),
      }));
      const payload: Record<string, unknown> = {
        ok: true,
        dir: snapshotDir(),
        ...(playlistId ? { playlist_id: playlistId } : {}),
        total: loaded.length,
        returned: rows.length,
        truncated,
        snapshots: rows,
      };
      const lines = [`Playlist snapshots in ${snapshotDir()}${playlistId ? ` (playlist ${playlistId})` : ''} — ${loaded.length} total, newest first:`];
      for (const r of rows) {
        const bits = [
          r.taken_at ?? 'unknown date',
          r.bytes !== null ? formatBytes(r.bytes) : 'unreadable',
        ];
        if (r.playlist_name) bits.push(`"${r.playlist_name}" (${r.playlist_id})`);
        if (r.track_count !== null) bits.push(`${r.track_count} tracks`);
        lines.push(`- ${r.snapshot_id} — ${bits.join(' · ')}${'error' in r ? ` [ERROR: ${(r as { error: string }).error}]` : ''}`);
      }
      if (footer) lines.push(footer);
      return shape(args.response_format, lines.join('\n'), payload);
    },
  );

  // -- 3. read_playlist_snapshot -------------------------------------------
  server.tool(
    'read_playlist_snapshot',
    'Read one local playlist snapshot and return its meta plus the captured track rows (truncated by max_results) Snapshot guide: take_playlist_snapshot (create), list_saved_snapshots (list), read_playlist_snapshot (read), diff_playlist_snapshots / snapshot_new_tracks / snapshot_removed_tracks (diff), restore_playlist_from_snapshot / restore_playlist_plan (restore).',
    {
      snapshot: z.string().min(1).describe('Snapshot id (filename stem), filename, or path'),
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args) => {
      const path = await resolveSnapshotRef(args.snapshot);
      const snap = await readSnapshotFile(path);
      const maxResults = resolveMaxResults(args.max_results);
      const { items, total, truncated, footer } = truncateItems(snap.tracks, maxResults);
      const payload: Record<string, unknown> = {
        ok: true,
        snapshot_id: snap._meta.snapshot_id,
        meta: snap._meta,
        total,
        returned: items.length,
        truncated,
        tracks: items,
      };
      const lines = [
        `Snapshot ${snap._meta.snapshot_id}`,
        `- Playlist: ${snap._meta.playlist_name} (${snap._meta.playlist_id})`,
        `- Taken: ${snap._meta.taken_at} · tracks ${snap._meta.track_count} (${snap._meta.unique_uris} unique)`,
        ...(snap._meta.notes ? [`- Notes: ${snap._meta.notes}`] : []),
        '',
        ...items.map((t, i) => `${i + 1}. ${t.name || t.uri} — ${t.uri}${t.added_at ? ` (added ${t.added_at})` : ''}`),
      ];
      if (footer) lines.push(footer);
      return shape(args.response_format, lines.join('\n'), payload);
    },
  );

  // -- 4. delete_playlist_snapshot -----------------------------------------
  server.tool(
    'delete_playlist_snapshot',
    'Delete one local playlist snapshot file; dry_run=true (default) only reports what would be removed Snapshot guide: take_playlist_snapshot (create), list_saved_snapshots (list), read_playlist_snapshot (read), diff_playlist_snapshots / snapshot_new_tracks / snapshot_removed_tracks (diff), restore_playlist_from_snapshot / restore_playlist_plan (restore).',
    {
      snapshot: z.string().min(1).describe('Snapshot id (filename stem), filename, or path'),
      response_format: ResponseFormat,
      dry_run: DryRunDefault,
    },
    async (args) => {
      const path = await resolveSnapshotRef(args.snapshot);
      const stem = snapFileStem(path.split('/').pop() ?? path);
      if (isDry(args)) {
        const payload: Record<string, unknown> = { dry_run: true, snapshot_id: stem, file: path };
        return shape(
          args.response_format,
          `[dry run] delete_playlist_snapshot — would remove local file ${path}. Pass dry_run=false to delete.`,
          payload,
        );
      }
      await unlink(path);
      const payload: Record<string, unknown> = { ok: true, deleted: true, snapshot_id: stem, file: path };
      return shape(args.response_format, `Deleted snapshot file ${path}.`, payload);
    },
  );

  // -- 5. diff_playlist_snapshots ------------------------------------------
  server.tool(
    'diff_playlist_snapshots',
    'Diff two local snapshots of a playlist and report every added and removed track between them Snapshot guide: take_playlist_snapshot (create), list_saved_snapshots (list), read_playlist_snapshot (read), diff_playlist_snapshots / snapshot_new_tracks / snapshot_removed_tracks (diff), restore_playlist_from_snapshot / restore_playlist_plan (restore).',
    {
      from_snapshot: z.string().min(1).describe('Older snapshot (id, filename, or path) — the baseline'),
      to_snapshot: z.string().min(1).describe('Newer snapshot (id, filename, or path) — the comparison'),
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args) => {
      const fromPath = await resolveSnapshotRef(args.from_snapshot);
      const toPath = await resolveSnapshotRef(args.to_snapshot);
      const [from, to] = await Promise.all([readSnapshotFile(fromPath), readSnapshotFile(toPath)]);
      const d = diffTrackLists(from.tracks, to.tracks);
      const maxResults = resolveMaxResults(args.max_results, 100);
      const addedShown = d.added.slice(0, maxResults);
      const removedShown = d.removed.slice(0, maxResults);
      const payload: Record<string, unknown> = {
        ok: true,
        from: { snapshot_id: from._meta.snapshot_id, taken_at: from._meta.taken_at, track_count: from._meta.track_count },
        to: { snapshot_id: to._meta.snapshot_id, taken_at: to._meta.taken_at, track_count: to._meta.track_count },
        added_count: d.added_count,
        removed_count: d.removed_count,
        unchanged_count: d.unchanged_count,
        added: addedShown,
        removed: removedShown,
        added_truncated: d.added_count > addedShown.length,
        removed_truncated: d.removed_count > removedShown.length,
      };
      const lines = [
        `Diff ${from._meta.snapshot_id} (${from._meta.taken_at}) → ${to._meta.snapshot_id} (${to._meta.taken_at})`,
        ...diffLines(d, maxResults),
      ];
      return shape(args.response_format, lines.join('\n'), payload);
    },
  );

  // -- 6. snapshot_new_tracks ----------------------------------------------
  server.tool(
    'snapshot_new_tracks',
    'List only the tracks added between an older and a newer snapshot of a playlist Snapshot guide: take_playlist_snapshot (create), list_saved_snapshots (list), read_playlist_snapshot (read), diff_playlist_snapshots / snapshot_new_tracks / snapshot_removed_tracks (diff), restore_playlist_from_snapshot / restore_playlist_plan (restore).',
    {
      from_snapshot: z.string().min(1).describe('Older snapshot (id, filename, or path)'),
      to_snapshot: z.string().min(1).describe('Newer snapshot (id, filename, or path)'),
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args) => {
      const fromPath = await resolveSnapshotRef(args.from_snapshot);
      const toPath = await resolveSnapshotRef(args.to_snapshot);
      const [from, to] = await Promise.all([readSnapshotFile(fromPath), readSnapshotFile(toPath)]);
      const d = diffTrackLists(from.tracks, to.tracks);
      const maxResults = resolveMaxResults(args.max_results);
      const { items, truncated, footer } = truncateItems(d.added, maxResults);
      const payload: Record<string, unknown> = {
        ok: true,
        from: from._meta.snapshot_id,
        to: to._meta.snapshot_id,
        total: d.added_count,
        returned: items.length,
        truncated,
        tracks: items,
      };
      const lines = [
        `${d.added_count} track(s) added between ${from._meta.snapshot_id} and ${to._meta.snapshot_id}:`,
        ...items.map((t, i) => `${i + 1}. ${t.name || t.uri} — ${t.uri}${t.added_at ? ` (added ${t.added_at})` : ''}`),
      ];
      if (d.added_count === 0) lines.length = 1;
      if (footer) lines.push(footer);
      return shape(args.response_format, lines.join('\n'), payload);
    },
  );

  // -- 7. snapshot_removed_tracks ------------------------------------------
  server.tool(
    'snapshot_removed_tracks',
    'List only the tracks removed between an older and a newer snapshot of a playlist Snapshot guide: take_playlist_snapshot (create), list_saved_snapshots (list), read_playlist_snapshot (read), diff_playlist_snapshots / snapshot_new_tracks / snapshot_removed_tracks (diff), restore_playlist_from_snapshot / restore_playlist_plan (restore).',
    {
      from_snapshot: z.string().min(1).describe('Older snapshot (id, filename, or path)'),
      to_snapshot: z.string().min(1).describe('Newer snapshot (id, filename, or path)'),
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args) => {
      const fromPath = await resolveSnapshotRef(args.from_snapshot);
      const toPath = await resolveSnapshotRef(args.to_snapshot);
      const [from, to] = await Promise.all([readSnapshotFile(fromPath), readSnapshotFile(toPath)]);
      const d = diffTrackLists(from.tracks, to.tracks);
      const maxResults = resolveMaxResults(args.max_results);
      const { items, truncated, footer } = truncateItems(d.removed, maxResults);
      const payload: Record<string, unknown> = {
        ok: true,
        from: from._meta.snapshot_id,
        to: to._meta.snapshot_id,
        total: d.removed_count,
        returned: items.length,
        truncated,
        tracks: items,
      };
      const lines = [
        `${d.removed_count} track(s) removed between ${from._meta.snapshot_id} and ${to._meta.snapshot_id}:`,
        ...items.map((t, i) => `${i + 1}. ${t.name || t.uri} — ${t.uri}${t.added_at ? ` (added ${t.added_at})` : ''}`),
      ];
      if (d.removed_count === 0) lines.length = 1;
      if (footer) lines.push(footer);
      return shape(args.response_format, lines.join('\n'), payload);
    },
  );

  // -- 8. snapshot_added_at_report -----------------------------------------
  server.tool(
    'snapshot_added_at_report',
    'Report when the tracks in a snapshot were added to the playlist, bucketed by month (YYYY-MM) Snapshot guide: take_playlist_snapshot (create), list_saved_snapshots (list), read_playlist_snapshot (read), diff_playlist_snapshots / snapshot_new_tracks / snapshot_removed_tracks (diff), restore_playlist_from_snapshot / restore_playlist_plan (restore).',
    {
      snapshot: z.string().min(1).describe('Snapshot id, filename, or path'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const path = await resolveSnapshotRef(args.snapshot);
      const snap = await readSnapshotFile(path);
      const buckets = new Map<string, number>();
      let undated = 0;
      for (const t of snap.tracks) {
        if (!t.added_at || Number.isNaN(Date.parse(t.added_at))) {
          undated += 1;
          continue;
        }
        const month = t.added_at.slice(0, 7);
        buckets.set(month, (buckets.get(month) ?? 0) + 1);
      }
      const sorted = [...buckets.entries()].sort((x, y) => x[0].localeCompare(y[0]));
      const payload: Record<string, unknown> = {
        ok: true,
        snapshot_id: snap._meta.snapshot_id,
        playlist_id: snap._meta.playlist_id,
        total_tracks: snap.tracks.length,
        undated,
        months: sorted.map(([month, count]) => ({ month, count })),
      };
      const lines = [
        `added_at distribution for ${snap._meta.snapshot_id} (${snap.tracks.length} tracks):`,
        ...sorted.map(([month, count]) => `- ${month}: ${count}`),
        ...(undated > 0 ? [`- (undated/unparseable): ${undated}`] : []),
      ];
      return shape(args.response_format, lines.join('\n'), payload);
    },
  );

  // -- 9. snapshot_changelog -----------------------------------------------
  server.tool(
    'snapshot_changelog',
    'Build a chronological changelog of a playlist from every local snapshot, describing the changes between consecutive snapshots Snapshot guide: take_playlist_snapshot (create), list_saved_snapshots (list), read_playlist_snapshot (read), diff_playlist_snapshots / snapshot_new_tracks / snapshot_removed_tracks (diff), restore_playlist_from_snapshot / restore_playlist_plan (restore).',
    {
      playlist: spotifyId('playlist').describe('Playlist ID or spotify:playlist: URI'),
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args) => {
      const playlistId = normalizePlaylistRef(args.playlist);
      const loaded = await loadSnapshots(playlistId);
      const valid = loaded.filter((l) => l.snap);
      if (valid.length === 0) {
        return shape(
          args.response_format,
          `No valid snapshots found for playlist ${playlistId} in ${snapshotDir()}.`,
          { ok: true, playlist_id: playlistId, entries: [] },
        );
      }
      const snaps = valid.map((l) => l.snap as PlaylistSnapshot);
      const entries: Array<Record<string, unknown>> = [];
      for (let i = 0; i < snaps.length; i += 1) {
        const cur = snaps[i];
        if (i === 0) {
          entries.push({
            at: cur._meta.taken_at,
            snapshot_id: cur._meta.snapshot_id,
            kind: 'baseline',
            added_count: 0,
            removed_count: 0,
            track_count: cur._meta.track_count,
          });
          continue;
        }
        const prev = snaps[i - 1];
        const d = diffTrackLists(prev.tracks, cur.tracks);
        entries.push({
          at: cur._meta.taken_at,
          snapshot_id: cur._meta.snapshot_id,
          previous_snapshot_id: prev._meta.snapshot_id,
          kind: 'change',
          added_count: d.added_count,
          removed_count: d.removed_count,
          track_count: cur._meta.track_count,
          added_names: d.added.slice(0, 5).map((t) => t.name || t.uri),
          removed_names: d.removed.slice(0, 5).map((t) => t.name || t.uri),
        });
      }
      const shown = entries.slice(-resolveMaxResults(args.max_results, 50));
      const payload: Record<string, unknown> = {
        ok: true,
        playlist_id: playlistId,
        snapshot_count: snaps.length,
        total_entries: entries.length,
        returned: shown.length,
        entries: shown,
      };
      const lines = [`Changelog for playlist ${playlistId} across ${snaps.length} snapshot(s):`];
      for (const e of shown) {
        if (e.kind === 'baseline') {
          lines.push(`- ${e.at} — baseline ${e.snapshot_id} (${e.track_count} tracks)`);
        } else {
          const names = [
            ...((e.added_names as string[]) ?? []).map((n) => `+${n}`),
            ...((e.removed_names as string[]) ?? []).map((n) => `-${n}`),
          ].join(', ');
          lines.push(
            `- ${e.at} — ${e.snapshot_id}: +${e.added_count} / -${e.removed_count} (now ${e.track_count})${names ? ` — ${names}` : ''}`,
          );
        }
      }
      return shape(args.response_format, lines.join('\n'), payload);
    },
  );

  // -- 10. snapshot_stats_report -------------------------------------------
  server.tool(
    'snapshot_stats_report',
    'Compute stats for one snapshot: track count, unique URIs, duplicates, and the oldest/newest added_at dates Snapshot guide: take_playlist_snapshot (create), list_saved_snapshots (list), read_playlist_snapshot (read), diff_playlist_snapshots / snapshot_new_tracks / snapshot_removed_tracks (diff), restore_playlist_from_snapshot / restore_playlist_plan (restore).',
    {
      snapshot: z.string().min(1).describe('Snapshot id, filename, or path'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const path = await resolveSnapshotRef(args.snapshot);
      const snap = await readSnapshotFile(path);
      const perUri = new Map<string, number>();
      const nameByUri = new Map<string, string>();
      for (const t of snap.tracks) {
        perUri.set(t.uri, (perUri.get(t.uri) ?? 0) + 1);
        if (!nameByUri.has(t.uri) && t.name) nameByUri.set(t.uri, t.name);
      }
      const dups = [...perUri.entries()]
        .filter(([, n]) => n > 1)
        .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
      const dates = snap.tracks
        .map((t) => t.added_at)
        .filter((d): d is string => !!d && !Number.isNaN(Date.parse(d)))
        .sort();
      const payload: Record<string, unknown> = {
        ok: true,
        snapshot_id: snap._meta.snapshot_id,
        playlist_id: snap._meta.playlist_id,
        playlist_name: snap._meta.playlist_name,
        taken_at: snap._meta.taken_at,
        track_count: snap.tracks.length,
        unique_uris: perUri.size,
        duplicate_uri_count: dups.length,
        duplicates: dups.map(([uri, n]) => ({ uri, name: nameByUri.get(uri) ?? null, occurrences: n })),
        oldest_added_at: dates[0] ?? null,
        newest_added_at: dates[dates.length - 1] ?? null,
      };
      const lines = [
        `Stats for ${snap._meta.snapshot_id} ("${snap._meta.playlist_name}", taken ${snap._meta.taken_at}):`,
        `- Rows: ${snap.tracks.length}; unique URIs: ${perUri.size}; duplicate URIs: ${dups.length}`,
        ...(dates.length > 0 ? [`- added_at range: ${dates[0]} → ${dates[dates.length - 1]}`] : []),
        ...(dups.length > 0
          ? [`- Top duplicates: ${dups.slice(0, 5).map(([u, n]) => `${nameByUri.get(u) || u} ×${n}`).join(', ')}`]
          : []),
      ];
      return shape(args.response_format, lines.join('\n'), payload);
    },
  );

  // -- 11. snapshot_integrity_check ----------------------------------------
  server.tool(
    'snapshot_integrity_check',
    'Validate one snapshot (or all of them): JSON parses, required _meta keys exist, and the declared track_count matches the tracks array Snapshot guide: take_playlist_snapshot (create), list_saved_snapshots (list), read_playlist_snapshot (read), diff_playlist_snapshots / snapshot_new_tracks / snapshot_removed_tracks (diff), restore_playlist_from_snapshot / restore_playlist_plan (restore).',
    {
      snapshot: z.string().min(1).optional().describe('One snapshot (id/filename/path); omit to check ALL snapshots'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const loaded = args.snapshot
        ? [{ file: args.snapshot, path: await resolveSnapshotRef(args.snapshot), bytes: null, snap: null, error: undefined }]
        : await loadSnapshots();
      const results = await Promise.all(
        loaded.map(async (l) => {
          const file = l.path.split('/').pop() ?? l.path;
          try {
            const snap = l.snap ?? (await readSnapshotFile(l.path));
            const issues: string[] = [];
            if (!snap._meta.snapshot_id) issues.push('_meta.snapshot_id missing');
            if (!snap._meta.playlist_name) issues.push('_meta.playlist_name missing');
            if (!snap._meta.playlist_uri) issues.push('_meta.playlist_uri missing');
            if (snap._meta.track_count !== snap.tracks.length) {
              issues.push(`track_count ${snap._meta.track_count} != tracks.length ${snap.tracks.length}`);
            }
            if (snap._meta.unique_uris !== new Set(snap.tracks.map((t) => t.uri)).size) {
              issues.push('unique_uris mismatch');
            }
            for (const t of snap.tracks) {
              if (!t.uri.startsWith('spotify:')) {
                issues.push(`non-spotify uri: ${t.uri}`);
                break;
              }
            }
            return { file, snapshot_id: snap._meta.snapshot_id ?? null, valid: issues.length === 0, issues, path: l.path };
          } catch (e) {
            return {
              file,
              snapshot_id: null,
              valid: false,
              issues: [e instanceof Error ? e.message : String(e)],
              path: l.path,
            };
          }
        }),
      );
      const invalid = results.filter((r) => !r.valid);
      const payload: Record<string, unknown> = {
        ok: true,
        checked: results.length,
        valid_count: results.length - invalid.length,
        invalid_count: invalid.length,
        results,
      };
      const lines = [
        `Integrity check over ${results.length} snapshot(s): ${results.length - invalid.length} valid, ${invalid.length} invalid.`,
        ...(invalid.length > 0
          ? invalid.map((r) => `- ${r.file}: ${r.issues.join('; ')}`)
          : []),
      ];
      return shape(args.response_format, lines.join('\n'), payload);
    },
  );

  // -- 12. prune_old_snapshots ---------------------------------------------
  server.tool(
    'prune_old_snapshots',
    'Delete old local snapshots, keeping the newest N per playlist and optionally dropping those older than a cutoff; dry_run=true (default) only reports what would go Snapshot guide: take_playlist_snapshot (create), list_saved_snapshots (list), read_playlist_snapshot (read), diff_playlist_snapshots / snapshot_new_tracks / snapshot_removed_tracks (diff), restore_playlist_from_snapshot / restore_playlist_plan (restore).',
    {
      playlist: spotifyId('playlist').optional().describe('Restrict pruning to this playlist (ID or URI)'),
      keep_last: z.number().int().positive().max(100).optional().describe('Snapshots to KEEP per playlist (default 5)'),
      older_than_days: z.number().int().positive().max(3650).optional().describe('Additionally prune snapshots older than this many days'),
      response_format: ResponseFormat,
      dry_run: DryRunDefault,
    },
    async (args) => {
      const playlistId = args.playlist ? normalizePlaylistRef(args.playlist) : undefined;
      const keepLast = args.keep_last ?? 5;
      const groups = groupByPlaylist(await loadSnapshots(playlistId));
      const cutoff = args.older_than_days !== undefined ? Date.now() - args.older_than_days * 86_400_000 : null;
      const doomed: Array<{ file: string; path: string; reason: string }> = [];
      for (const [, snaps] of groups) {
        // snaps are oldest→newest; keep the last keepLast.
        snaps.forEach((s, idx) => {
          const rank = snaps.length - idx; // 1 = newest
          if (rank > keepLast) {
            doomed.push({ file: s.file, path: s.path, reason: `beyond keep_last=${keepLast}` });
            return;
          }
          if (cutoff !== null && Date.parse(s.snap._meta.taken_at) < cutoff) {
            doomed.push({ file: s.file, path: s.path, reason: `older than ${args.older_than_days} days` });
          }
        });
      }
      if (isDry(args)) {
        const payload: Record<string, unknown> = {
          dry_run: true,
          keep_last: keepLast,
          ...(cutoff !== null ? { older_than_days: args.older_than_days } : {}),
          would_delete: doomed.map((d) => ({ file: d.file, reason: d.reason })),
          would_delete_count: doomed.length,
        };
        const lines = [
          `[dry run] prune_old_snapshots — ${doomed.length} file(s) would be deleted (keeping ${keepLast} newest per playlist${cutoff !== null ? `, cutoff ${new Date(cutoff).toISOString()}` : ''}).`,
          ...doomed.slice(0, 20).map((d) => `- ${d.file} (${d.reason})`),
          ...(doomed.length > 20 ? [`… ${doomed.length - 20} more`] : []),
          'Pass dry_run=false to delete.',
        ];
        return shape(args.response_format, lines.join('\n'), payload);
      }
      let deleted = 0;
      const errors: Array<{ file: string; error: string }> = [];
      for (const d of doomed) {
        try {
          await unlink(d.path);
          deleted += 1;
        } catch (e) {
          errors.push({ file: d.file, error: e instanceof Error ? e.message : String(e) });
        }
      }
      const payload: Record<string, unknown> = {
        ok: errors.length === 0,
        deleted_count: deleted,
        error_count: errors.length,
        errors,
      };
      return shape(args.response_format, `Pruned ${deleted} snapshot file(s); ${errors.length} error(s).`, payload);
    },
  );

  // -- 13. restore_playlist_from_snapshot ----------------------------------
  server.tool(
    'restore_playlist_from_snapshot',
    'Make a live playlist match a snapshot (add missing, remove extra tracks); dry_run=true (default) returns the deterministic PLAN without touching Spotify Snapshot guide: take_playlist_snapshot (create), list_saved_snapshots (list), read_playlist_snapshot (read), diff_playlist_snapshots / snapshot_new_tracks / snapshot_removed_tracks (diff), restore_playlist_from_snapshot / restore_playlist_plan (restore).',
    {
      snapshot: z.string().min(1).describe('Snapshot to restore from (id, filename, or path)'),
      playlist: spotifyId('playlist').optional().describe('Target playlist (default: the snapshot’s own playlist_id)'),
      response_format: ResponseFormat,
      dry_run: DryRunDefault,
    },
    async (args) => {
      const path = await resolveSnapshotRef(args.snapshot);
      const snap = await readSnapshotFile(path);
      const targetId = args.playlist ? normalizePlaylistRef(args.playlist) : snap._meta.playlist_id;
      const live = await fetchLivePlaylist(client, targetId);
      const ops = computeRestoreOps(targetId, live.tracks, snap.tracks);
      if (isDry(args)) {
        const payload: Record<string, unknown> = {
          dry_run: true,
          snapshot_id: snap._meta.snapshot_id,
          playlist_id: targetId,
          live_track_count: live.tracks.length,
          snapshot_track_count: snap.tracks.length,
          add_count: ops.add_uris.length,
          remove_count: ops.remove_uris.length,
          plan: opsPlanLines(ops),
        };
        const lines = [
          `[dry run] restore_playlist_from_snapshot — ${snap._meta.snapshot_id} → playlist ${targetId} ("${live.name}")`,
          `Live: ${live.tracks.length} rows; snapshot: ${snap.tracks.length} rows.`,
          ...opsPlanLines(ops),
          'Pass dry_run=false to execute.',
        ];
        return shape(args.response_format, lines.join('\n'), payload);
      }
      const res = await applyPlaylistOps(client, targetId, ops.add_uris, ops.remove_uris);
      const after = await fetchLivePlaylist(client, targetId);
      const payload: Record<string, unknown> = {
        ok: true,
        snapshot_id: snap._meta.snapshot_id,
        playlist_id: targetId,
        added: res.added,
        removed: res.removed,
        requests: res.requests,
        live_track_count_after: after.tracks.length,
      };
      return shape(
        args.response_format,
        `Restore complete: +${res.added} / -${res.removed} on playlist ${targetId} ("${live.name}"); now ${after.tracks.length} rows.`,
        payload,
      );
    },
  );

  // -- 14. restore_playlist_plan -------------------------------------------
  server.tool(
    'restore_playlist_plan',
    'Read-only plan of exactly which tracks would be added/removed to make a live playlist match a snapshot — never mutates Snapshot guide: take_playlist_snapshot (create), list_saved_snapshots (list), read_playlist_snapshot (read), diff_playlist_snapshots / snapshot_new_tracks / snapshot_removed_tracks (diff), restore_playlist_from_snapshot / restore_playlist_plan (restore).',
    {
      snapshot: z.string().min(1).describe('Snapshot to plan from (id, filename, or path)'),
      playlist: spotifyId('playlist').optional().describe('Target playlist (default: the snapshot’s own playlist_id)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const path = await resolveSnapshotRef(args.snapshot);
      const snap = await readSnapshotFile(path);
      const targetId = args.playlist ? normalizePlaylistRef(args.playlist) : snap._meta.playlist_id;
      const live = await fetchLivePlaylist(client, targetId);
      const ops = computeRestoreOps(targetId, live.tracks, snap.tracks);
      const payload: Record<string, unknown> = {
        ok: true,
        snapshot_id: snap._meta.snapshot_id,
        playlist_id: targetId,
        playlist_name: live.name,
        live_track_count: live.tracks.length,
        snapshot_track_count: snap.tracks.length,
        add_count: ops.add_uris.length,
        remove_count: ops.remove_uris.length,
        add_requests: ops.add_requests,
        remove_requests: ops.remove_requests,
        add_uris: ops.add_uris,
        remove_uris: ops.remove_uris,
      };
      const lines = [
        `Restore plan: ${snap._meta.snapshot_id} → playlist ${targetId} ("${live.name}")`,
        `Live ${live.tracks.length} rows vs snapshot ${snap.tracks.length} rows: +${ops.add_uris.length} to add, -${ops.remove_uris.length} to remove.`,
        ...opsPlanLines(ops),
      ];
      return shape(args.response_format, lines.join('\n'), payload);
    },
  );

  // -- 15. snapshot_diff_summary -------------------------------------------
  server.tool(
    'snapshot_diff_summary',
    'One-paragraph summary of the differences between two snapshots: counts plus the first few changed tracks Snapshot guide: take_playlist_snapshot (create), list_saved_snapshots (list), read_playlist_snapshot (read), diff_playlist_snapshots / snapshot_new_tracks / snapshot_removed_tracks (diff), restore_playlist_from_snapshot / restore_playlist_plan (restore).',
    {
      from_snapshot: z.string().min(1).describe('Older snapshot (id, filename, or path)'),
      to_snapshot: z.string().min(1).describe('Newer snapshot (id, filename, or path)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const fromPath = await resolveSnapshotRef(args.from_snapshot);
      const toPath = await resolveSnapshotRef(args.to_snapshot);
      const [from, to] = await Promise.all([readSnapshotFile(fromPath), readSnapshotFile(toPath)]);
      const d = diffTrackLists(from.tracks, to.tracks);
      const payload: Record<string, unknown> = {
        ok: true,
        from: { snapshot_id: from._meta.snapshot_id, taken_at: from._meta.taken_at, track_count: from._meta.track_count },
        to: { snapshot_id: to._meta.snapshot_id, taken_at: to._meta.taken_at, track_count: to._meta.track_count },
        added_count: d.added_count,
        removed_count: d.removed_count,
        unchanged_count: d.unchanged_count,
        sample_added: d.added.slice(0, 5).map((t) => t.name || t.uri),
        sample_removed: d.removed.slice(0, 5).map((t) => t.name || t.uri),
      };
      const sample = (rows: SnapTrackRow[]) => rows.slice(0, 3).map((t) => t.name || t.uri).join(', ') || '—';
      const prose = `${from._meta.snapshot_id} → ${to._meta.snapshot_id}: +${d.added_count} / -${d.removed_count} (${d.unchanged_count} unchanged). Recently added: ${sample(d.added)}. Recently removed: ${sample(d.removed)}.`;
      return shape(args.response_format, prose, payload);
    },
  );

  // -- 16. find_new_since_snapshot -----------------------------------------
  server.tool(
    'find_new_since_snapshot',
    'Compare a live playlist against a snapshot and list tracks added to the playlist since it was taken Snapshot guide: take_playlist_snapshot (create), list_saved_snapshots (list), read_playlist_snapshot (read), diff_playlist_snapshots / snapshot_new_tracks / snapshot_removed_tracks (diff), restore_playlist_from_snapshot / restore_playlist_plan (restore).',
    {
      snapshot: z.string().min(1).describe('Baseline snapshot (id, filename, or path)'),
      playlist: spotifyId('playlist').optional().describe('Live playlist to compare (default: the snapshot’s playlist_id)'),
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args) => {
      const path = await resolveSnapshotRef(args.snapshot);
      const snap = await readSnapshotFile(path);
      const targetId = args.playlist ? normalizePlaylistRef(args.playlist) : snap._meta.playlist_id;
      const live = await fetchLivePlaylist(client, targetId);
      const d = diffTrackLists(snap.tracks, live.tracks); // snapshot = before, live = after
      const maxResults = resolveMaxResults(args.max_results);
      const { items, truncated, footer } = truncateItems(d.added, maxResults);
      const payload: Record<string, unknown> = {
        ok: true,
        snapshot_id: snap._meta.snapshot_id,
        playlist_id: targetId,
        total: d.added_count,
        returned: items.length,
        truncated,
        tracks: items,
      };
      const lines = [
        `${d.added_count} track(s) in live "${live.name}" that are NOT in ${snap._meta.snapshot_id}:`,
        ...items.map((t, i) => `${i + 1}. ${t.name || t.uri} — ${t.uri}`),
      ];
      if (d.added_count === 0) lines.length = 1;
      if (footer) lines.push(footer);
      return shape(args.response_format, lines.join('\n'), payload);
    },
  );

  // -- 17. find_lost_since_snapshot ----------------------------------------
  server.tool(
    'find_lost_since_snapshot',
    'Compare a live playlist against a snapshot and list snapshot tracks that have since disappeared from the playlist Snapshot guide: take_playlist_snapshot (create), list_saved_snapshots (list), read_playlist_snapshot (read), diff_playlist_snapshots / snapshot_new_tracks / snapshot_removed_tracks (diff), restore_playlist_from_snapshot / restore_playlist_plan (restore).',
    {
      snapshot: z.string().min(1).describe('Baseline snapshot (id, filename, or path)'),
      playlist: spotifyId('playlist').optional().describe('Live playlist to compare (default: the snapshot’s playlist_id)'),
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args) => {
      const path = await resolveSnapshotRef(args.snapshot);
      const snap = await readSnapshotFile(path);
      const targetId = args.playlist ? normalizePlaylistRef(args.playlist) : snap._meta.playlist_id;
      const live = await fetchLivePlaylist(client, targetId);
      const d = diffTrackLists(snap.tracks, live.tracks);
      const maxResults = resolveMaxResults(args.max_results);
      const { items, truncated, footer } = truncateItems(d.removed, maxResults);
      const payload: Record<string, unknown> = {
        ok: true,
        snapshot_id: snap._meta.snapshot_id,
        playlist_id: targetId,
        total: d.removed_count,
        returned: items.length,
        truncated,
        tracks: items,
      };
      const lines = [
        `${d.removed_count} track(s) from ${snap._meta.snapshot_id} missing from live "${live.name}":`,
        ...items.map((t, i) => `${i + 1}. ${t.name || t.uri} — ${t.uri}`),
      ];
      if (d.removed_count === 0) lines.length = 1;
      if (footer) lines.push(footer);
      return shape(args.response_format, lines.join('\n'), payload);
    },
  );

  // -- 18. merge_snapshot_changes_plan -------------------------------------
  server.tool(
    'merge_snapshot_changes_plan',
    'Read-only plan to replay the changes between two snapshots onto the live playlist (add new and/or remove lost tracks) Snapshot guide: take_playlist_snapshot (create), list_saved_snapshots (list), read_playlist_snapshot (read), diff_playlist_snapshots / snapshot_new_tracks / snapshot_removed_tracks (diff), restore_playlist_from_snapshot / restore_playlist_plan (restore).',
    {
      from_snapshot: z.string().min(1).describe('Older snapshot — the baseline the playlist is assumed to match'),
      to_snapshot: z.string().min(1).describe('Newer snapshot — the target state'),
      playlist: spotifyId('playlist').optional().describe('Live playlist to change (default: the snapshots’ playlist_id)'),
      mode: z.enum(['both', 'add_new', 'remove_lost']).optional().describe('Which changes to include (default both)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const mode = args.mode ?? 'both';
      const fromPath = await resolveSnapshotRef(args.from_snapshot);
      const toPath = await resolveSnapshotRef(args.to_snapshot);
      const [from, to] = await Promise.all([readSnapshotFile(fromPath), readSnapshotFile(toPath)]);
      const targetId = args.playlist ? normalizePlaylistRef(args.playlist) : to._meta.playlist_id;
      const live = await fetchLivePlaylist(client, targetId);
      const d = diffTrackLists(from.tracks, to.tracks);
      // Replay A→B changes: adds = B-only tracks; removes = A-only tracks.
      // The live playlist is fetched anyway so the plan reflects the CURRENT
      // live state, not the assumed baseline.
      const liveDiff = diffTrackLists(live.tracks, to.tracks);
      const addUris = mode === 'remove_lost' ? [] : liveDiff.added.map((r) => r.uri);
      const removeUris = mode === 'add_new' ? [] : d.removed
        .map((r) => r.uri)
        .filter((uri) => live.tracks.some((t) => t.uri === uri));
      const ops: RestoreOps = {
        playlist_id: targetId,
        add_uris: addUris,
        remove_uris: removeUris,
        add_requests: chunk(addUris, 100).length,
        remove_requests: chunk(removeUris, 100).length,
      };
      const payload: Record<string, unknown> = {
        ok: true,
        from: from._meta.snapshot_id,
        to: to._meta.snapshot_id,
        playlist_id: targetId,
        mode,
        add_count: addUris.length,
        remove_count: removeUris.length,
        add_requests: ops.add_requests,
        remove_requests: ops.remove_requests,
        add_uris: addUris,
        remove_uris: removeUris,
      };
      const lines = [
        `Merge plan (${mode}): replay ${from._meta.snapshot_id} → ${to._meta.snapshot_id} onto live playlist ${targetId} ("${live.name}", ${live.tracks.length} rows).`,
        ...opsPlanLines(ops),
      ];
      return shape(args.response_format, lines.join('\n'), payload);
    },
  );

  // -- 19. apply_snapshot_changes ------------------------------------------
  server.tool(
    'apply_snapshot_changes',
    'Execute a merge plan on the live playlist (replay the changes between two snapshots); dry_run=true (default) only returns the plan Snapshot guide: take_playlist_snapshot (create), list_saved_snapshots (list), read_playlist_snapshot (read), diff_playlist_snapshots / snapshot_new_tracks / snapshot_removed_tracks (diff), restore_playlist_from_snapshot / restore_playlist_plan (restore).',
    {
      from_snapshot: z.string().min(1).describe('Older snapshot — the baseline'),
      to_snapshot: z.string().min(1).describe('Newer snapshot — the target state'),
      playlist: spotifyId('playlist').optional().describe('Live playlist to change (default: the snapshots’ playlist_id)'),
      mode: z.enum(['both', 'add_new', 'remove_lost']).optional().describe('Which changes to apply (default both)'),
      response_format: ResponseFormat,
      dry_run: DryRunDefault,
    },
    async (args) => {
      const mode = args.mode ?? 'both';
      const fromPath = await resolveSnapshotRef(args.from_snapshot);
      const toPath = await resolveSnapshotRef(args.to_snapshot);
      const [from, to] = await Promise.all([readSnapshotFile(fromPath), readSnapshotFile(toPath)]);
      const targetId = args.playlist ? normalizePlaylistRef(args.playlist) : to._meta.playlist_id;
      const live = await fetchLivePlaylist(client, targetId);
      const d = diffTrackLists(from.tracks, to.tracks);
      const liveDiff = diffTrackLists(live.tracks, to.tracks);
      const addUris = mode === 'remove_lost' ? [] : liveDiff.added.map((r) => r.uri);
      const removeUris = mode === 'add_new' ? [] : d.removed
        .map((r) => r.uri)
        .filter((uri) => live.tracks.some((t) => t.uri === uri));
      if (isDry(args)) {
        const ops: RestoreOps = {
          playlist_id: targetId,
          add_uris: addUris,
          remove_uris: removeUris,
          add_requests: chunk(addUris, 100).length,
          remove_requests: chunk(removeUris, 100).length,
        };
        const payload: Record<string, unknown> = {
          dry_run: true,
          from: from._meta.snapshot_id,
          to: to._meta.snapshot_id,
          playlist_id: targetId,
          mode,
          add_count: addUris.length,
          remove_count: removeUris.length,
          plan: opsPlanLines(ops),
        };
        const lines = [
          `[dry run] apply_snapshot_changes (${mode}) — ${from._meta.snapshot_id} → ${to._meta.snapshot_id} onto playlist ${targetId} ("${live.name}")`,
          ...opsPlanLines(ops),
          'Pass dry_run=false to execute.',
        ];
        return shape(args.response_format, lines.join('\n'), payload);
      }
      const res = await applyPlaylistOps(client, targetId, addUris, removeUris);
      const after = await fetchLivePlaylist(client, targetId);
      const payload: Record<string, unknown> = {
        ok: true,
        from: from._meta.snapshot_id,
        to: to._meta.snapshot_id,
        playlist_id: targetId,
        mode,
        added: res.added,
        removed: res.removed,
        requests: res.requests,
        live_track_count_after: after.tracks.length,
      };
      return shape(
        args.response_format,
        `Applied snapshot changes (${mode}): +${res.added} / -${res.removed} on "${live.name}"; now ${after.tracks.length} rows.`,
        payload,
      );
    },
  );

  // -- 20. snapshot_retention_plan -----------------------------------------
  server.tool(
    'snapshot_retention_plan',
    'Report which snapshots a keep-last-N (+ optional age cutoff) retention policy would keep or delete — never deletes anything Snapshot guide: take_playlist_snapshot (create), list_saved_snapshots (list), read_playlist_snapshot (read), diff_playlist_snapshots / snapshot_new_tracks / snapshot_removed_tracks (diff), restore_playlist_from_snapshot / restore_playlist_plan (restore).',
    {
      playlist: spotifyId('playlist').optional().describe('Restrict the plan to this playlist (ID or URI)'),
      keep_last: z.number().int().positive().max(100).optional().describe('Snapshots to KEEP per playlist (default 5)'),
      older_than_days: z.number().int().positive().max(3650).optional().describe('Also mark snapshots older than this many days for deletion'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const playlistId = args.playlist ? normalizePlaylistRef(args.playlist) : undefined;
      const keepLast = args.keep_last ?? 5;
      const cutoff = args.older_than_days !== undefined ? Date.now() - args.older_than_days * 86_400_000 : null;
      const groups = groupByPlaylist(await loadSnapshots(playlistId));
      const keep: Array<{ file: string; playlist_id: string; taken_at: string }> = [];
      const drop: Array<{ file: string; playlist_id: string; taken_at: string; reason: string }> = [];
      for (const [pid, snaps] of groups) {
        snaps.forEach((s, idx) => {
          const rank = snaps.length - idx;
          if (rank > keepLast) {
            drop.push({ file: s.file, playlist_id: pid, taken_at: s.snap._meta.taken_at, reason: `beyond keep_last=${keepLast}` });
            return;
          }
          if (cutoff !== null && Date.parse(s.snap._meta.taken_at) < cutoff) {
            drop.push({ file: s.file, playlist_id: pid, taken_at: s.snap._meta.taken_at, reason: `older than ${args.older_than_days} days` });
            return;
          }
          keep.push({ file: s.file, playlist_id: pid, taken_at: s.snap._meta.taken_at });
        });
      }
      const payload: Record<string, unknown> = {
        ok: true,
        keep_last: keepLast,
        ...(cutoff !== null ? { older_than_days: args.older_than_days } : {}),
        keep_count: keep.length,
        drop_count: drop.length,
        keep,
        drop,
      };
      const lines = [
        `Retention plan (keep ${keepLast} newest per playlist${cutoff !== null ? `, cutoff ${new Date(cutoff).toISOString()}` : ''}): ${keep.length} kept, ${drop.length} would be deleted.`,
        ...drop.slice(0, 20).map((d) => `- DROP ${d.file} (${d.reason})`),
        ...(drop.length > 20 ? [`… ${drop.length - 20} more`] : []),
        'Nothing was deleted — use prune_old_snapshots with dry_run=false to execute this policy.',
      ];
      return shape(args.response_format, lines.join('\n'), payload);
    },
  );

  // -- 21. snapshot_disk_usage ---------------------------------------------
  server.tool(
    'snapshot_disk_usage',
    'Report disk usage of the snapshot directory: total size, file count, per-playlist breakdown, and the largest files Snapshot guide: take_playlist_snapshot (create), list_saved_snapshots (list), read_playlist_snapshot (read), diff_playlist_snapshots / snapshot_new_tracks / snapshot_removed_tracks (diff), restore_playlist_from_snapshot / restore_playlist_plan (restore).',
    {
      response_format: ResponseFormat,
    },
    async (args) => {
      const loaded = await loadSnapshots();
      const totalBytes = loaded.reduce((n, l) => n + (l.bytes ?? 0), 0);
      const perPlaylist = new Map<string, { files: number; bytes: number; name: string | null }>();
      for (const l of loaded) {
        if (!l.snap) continue;
        const key = l.snap._meta.playlist_id;
        const cur = perPlaylist.get(key) ?? { files: 0, bytes: 0, name: l.snap._meta.playlist_name };
        cur.files += 1;
        cur.bytes += l.bytes ?? 0;
        perPlaylist.set(key, cur);
      }
      const perList = [...perPlaylist.entries()]
        .map(([playlist_id, v]) => ({ playlist_id, playlist_name: v.name, files: v.files, bytes: v.bytes }))
        .sort((x, y) => y.bytes - x.bytes || x.playlist_id.localeCompare(y.playlist_id));
      const largest = loaded
        .slice()
        .sort((x, y) => (y.bytes ?? 0) - (x.bytes ?? 0))
        .slice(0, 10)
        .map((l) => ({ file: l.file, bytes: l.bytes }));
      const payload: Record<string, unknown> = {
        ok: true,
        dir: snapshotDir(),
        file_count: loaded.length,
        corrupt_count: loaded.filter((l) => !l.snap).length,
        total_bytes: totalBytes,
        per_playlist: perList,
        largest_files: largest,
      };
      const lines = [
        `Snapshot disk usage in ${snapshotDir()}: ${loaded.length} file(s), ${formatBytes(totalBytes)} total.`,
        ...perList.slice(0, 15).map((p) => `- ${p.playlist_name ?? p.playlist_id} (${p.playlist_id}): ${p.files} file(s), ${formatBytes(p.bytes)}`),
        ...(perList.length > 15 ? [`… ${perList.length - 15} more playlists`] : []),
      ];
      return shape(args.response_format, lines.join('\n'), payload);
    },
  );

  // -- 22. snapshot_integrity_report ---------------------------------------
  server.tool(
    'snapshot_integrity_report',
    'Aggregate health report over all local snapshots: valid vs corrupt files, per-playlist coverage, and the age of each playlist’s newest snapshot Snapshot guide: take_playlist_snapshot (create), list_saved_snapshots (list), read_playlist_snapshot (read), diff_playlist_snapshots / snapshot_new_tracks / snapshot_removed_tracks (diff), restore_playlist_from_snapshot / restore_playlist_plan (restore).',
    {
      response_format: ResponseFormat,
    },
    async (args) => {
      const loaded = await loadSnapshots();
      const valid = loaded.filter((l) => l.snap);
      const corrupt = loaded.filter((l) => !l.snap);
      const groups = groupByPlaylist(loaded);
      const now = Date.now();
      const coverage = [...groups.entries()]
        .map(([playlist_id, snaps]) => {
          const latest = snaps[snaps.length - 1].snap;
          const ageDays = (now - Date.parse(latest._meta.taken_at)) / 86_400_000;
          return {
            playlist_id,
            playlist_name: latest._meta.playlist_name,
            snapshot_count: snaps.length,
            first_taken_at: snaps[0].snap._meta.taken_at,
            latest_taken_at: latest._meta.taken_at,
            latest_snapshot_id: latest._meta.snapshot_id,
            latest_track_count: latest._meta.track_count,
            days_since_latest: Math.round(ageDays * 10) / 10,
          };
        })
        .sort((x, y) => x.playlist_id.localeCompare(y.playlist_id));
      const payload: Record<string, unknown> = {
        ok: true,
        dir: snapshotDir(),
        total_files: loaded.length,
        valid_count: valid.length,
        corrupt_count: corrupt.length,
        playlists_covered: coverage.length,
        coverage,
        corrupt_files: corrupt.map((c) => ({ file: c.file, error: c.error ?? 'unreadable' })),
      };
      const lines = [
        `Snapshot health: ${valid.length}/${loaded.length} files valid, ${coverage.length} playlist(s) covered.`,
        ...coverage.map(
          (c) =>
            `- ${c.playlist_name ?? c.playlist_id}: ${c.snapshot_count} snapshot(s), latest ${c.latest_snapshot_id} (${c.days_since_latest}d ago, ${c.latest_track_count} tracks)`,
        ),
        ...(corrupt.length > 0
          ? [`⚠ ${corrupt.length} corrupt file(s): ${corrupt.map((c) => c.file).join(', ')}`]
          : []),
      ];
      return shape(args.response_format, lines.join('\n'), payload);
    },
  );

  // -- 23. export_snapshot_bundle ------------------------------------------
  server.tool(
    'export_snapshot_bundle',
    'Bundle selected snapshots (all of one playlist, or explicit ids) into a single portable JSON export file locally; dry_run=true (default) previews the bundle Snapshot guide: take_playlist_snapshot (create), list_saved_snapshots (list), read_playlist_snapshot (read), diff_playlist_snapshots / snapshot_new_tracks / snapshot_removed_tracks (diff), restore_playlist_from_snapshot / restore_playlist_plan (restore).',
    {
      playlist: spotifyId('playlist').optional().describe('Bundle every snapshot of this playlist (ID or URI)'),
      snapshots: z.array(z.string().min(1)).optional().describe('Explicit snapshot ids/filenames to bundle (overrides playlist filter)'),
      response_format: ResponseFormat,
      dry_run: DryRunDefault,
    },
    async (args) => {
      let selected: Array<{ file: string; path: string; snap: PlaylistSnapshot }>;
      if (args.snapshots && args.snapshots.length > 0) {
        selected = [];
        for (const ref of args.snapshots) {
          const path = await resolveSnapshotRef(ref);
          selected.push({ file: path.split('/').pop() ?? path, path, snap: await readSnapshotFile(path) });
        }
      } else if (args.playlist) {
        const playlistId = normalizePlaylistRef(args.playlist);
        selected = (await loadSnapshots(playlistId))
          .filter((l) => l.snap)
          .map((l) => ({ file: l.file, path: l.path, snap: l.snap as PlaylistSnapshot }));
      } else {
        selected = (await loadSnapshots())
          .filter((l) => l.snap)
          .map((l) => ({ file: l.file, path: l.path, snap: l.snap as PlaylistSnapshot }));
      }
      if (selected.length === 0) {
        return shape(
          args.response_format,
          'No snapshots selected — pass snapshots: [...] or playlist, or take a snapshot first.',
          { ok: false, selected_count: 0 },
        );
      }
      const dir = snapshotDir();
      const exportedAt = new Date().toISOString();
      const dateStamp = exportedAt.slice(0, 10);
      const seq = await nextSeq(dir, BUNDLE_FILE_RE, dateStamp, 1);
      const bundleId = `snapbundle-${dateStamp}-${seq}`;
      const outPath = join(dir, `${bundleId}.json`);
      if (isDry(args)) {
        const payload: Record<string, unknown> = {
          dry_run: true,
          selected_count: selected.length,
          sources: selected.map((s) => s.snap._meta.snapshot_id),
          out_file: outPath,
        };
        const lines = [
          `[dry run] export_snapshot_bundle — would bundle ${selected.length} snapshot(s) into ${outPath}.`,
          ...selected.map((s) => `- ${s.snap._meta.snapshot_id} (${s.snap._meta.track_count} tracks)`),
          'Pass dry_run=false to write the bundle.',
        ];
        return shape(args.response_format, lines.join('\n'), payload);
      }
      const bundle = {
        _meta: {
          bundle_id: bundleId,
          exported_at: exportedAt,
          snapshot_count: selected.length,
          sources: selected.map((s) => s.snap._meta.snapshot_id),
        },
        snapshots: selected.map((s) => s.snap),
      };
      const body = `${JSON.stringify(bundle, null, 2)}\n`;
      await writeFile(outPath, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      const payload: Record<string, unknown> = {
        ok: true,
        bundle_id: bundleId,
        file: outPath,
        bytes: Buffer.byteLength(body),
        snapshot_count: selected.length,
        sources: selected.map((s) => s.snap._meta.snapshot_id),
      };
      return shape(
        args.response_format,
        `Bundle written → ${outPath} (${formatBytes(payload.bytes as number)}), ${selected.length} snapshot(s).`,
        payload,
      );
    },
  );

  // -- 24. snapshot_registry_report ----------------------------------------
  server.tool(
    'snapshot_registry_report',
    'Registry view of every local snapshot: per playlist, all snapshot ids with taken_at and track counts, plus naming anomalies in the snapshot directory Snapshot guide: take_playlist_snapshot (create), list_saved_snapshots (list), read_playlist_snapshot (read), diff_playlist_snapshots / snapshot_new_tracks / snapshot_removed_tracks (diff), restore_playlist_from_snapshot / restore_playlist_plan (restore).',
    {
      response_format: ResponseFormat,
    },
    async (args) => {
      const dir = snapshotDir();
      const loaded = await loadSnapshots();
      const groups = groupByPlaylist(loaded);
      const registry = [...groups.entries()]
        .map(([playlist_id, snaps]) => ({
          playlist_id,
          playlist_name: snaps[snaps.length - 1].snap._meta.playlist_name,
          snapshots: snaps.map((s) => ({
            snapshot_id: s.snap._meta.snapshot_id,
            taken_at: s.snap._meta.taken_at,
            track_count: s.snap._meta.track_count,
            bytes: s.bytes,
          })),
        }))
        .sort((x, y) => x.playlist_id.localeCompare(y.playlist_id));
      // Naming anomalies: JSON files in the dir that match neither pattern.
      let anomalies: string[] = [];
      try {
        anomalies = (await readdir(dir)).filter(
          (n) => n.endsWith('.json') && !SNAP_FILE_RE.test(n) && !BUNDLE_FILE_RE.test(n),
        );
      } catch {
        anomalies = [];
      }
      const payload: Record<string, unknown> = {
        ok: true,
        dir,
        snapshot_count: loaded.filter((l) => l.snap).length,
        playlist_count: registry.length,
        registry,
        unrecognized_json_files: anomalies,
      };
      const lines = [
        `Snapshot registry (${dir}): ${registry.length} playlist(s), ${loaded.filter((l) => l.snap).length} snapshot(s).`,
        ...registry.map((r) => {
          const ids = r.snapshots.map((s) => s.snapshot_id).join(', ');
          return `- ${r.playlist_name ?? r.playlist_id} (${r.playlist_id}): ${r.snapshots.length} snapshot(s) — ${ids}`;
        }),
        ...(anomalies.length > 0 ? [`⚠ Unrecognized JSON files: ${anomalies.join(', ')}`] : []),
      ];
      return shape(args.response_format, lines.join('\n'), payload);
    },
  );

}
