/** swarm3 playback slice — 500-tool swarm v1.26.0 (issue #442). Owned by playback builder. */
/**
 * 24 playback/queue/device tools. House conventions honoured here:
 *   • shaping.ts helpers only (resolveMaxResults / truncateItems / describeDryRun).
 *   • Read tools accept response_format and emit structuredContent alongside text.
 *   • Mutating tools carry dry_run (default TRUE) and return a deterministic PLAN
 *     when true; execution only happens with dry_run=false.
 *   • Bookmark + session sidecars live under backupDir() (from ./backup.js),
 *     dir 0700 / files 0600 — same hygiene as scenes.json.
 *   • No deprecated endpoints (SPEC §9). Client put/post only via the
 *     serialized client queue.
 */
import { z } from 'zod';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { getConfig } from '../config.js';
import { backupDir } from './backup.js';
import {
  MaxResults,
  ResponseFormat,
  describeDryRun,
  resolveMaxResults,
  truncateItems,
} from '../shaping.js';
import type { ResponseFormatValue } from '../shaping.js';
import type {
  GetDevicesResponse,
  PlaybackState,
  SpotifyDevice,
  SpotifyEpisode,
  SpotifyQueue,
  SpotifyTrack,
} from '../types/spotify.js';

type TextContent = { type: 'text'; text: string };
type ToolResult = { content: TextContent[]; structuredContent?: Record<string, unknown> };
type PlayableItem = SpotifyTrack | SpotifyEpisode;

// ---------------------------------------------------------------------------
// Shared shaping helpers
// ---------------------------------------------------------------------------

const textResult = (text: string, structured?: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text }],
  ...(structured ? { structuredContent: structured } : {}),
});

const jsonText = (data: unknown): string => JSON.stringify(data, null, 2);

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

const isDry = (args: { dry_run?: boolean }): boolean => args.dry_run ?? true;

function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatLong(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function itemTitle(item: PlayableItem | null): string {
  if (!item) return '—';
  return item.name;
}

function itemSubtitle(item: PlayableItem | null): string {
  if (!item) return '—';
  if ('artists' in item) {
    return (item.artists ?? []).map((a) => a.name).join(', ') || 'unknown artist';
  }
  return item.show?.name ?? 'episode';
}

function isTrackItem(item: PlayableItem | null): item is SpotifyTrack {
  return item !== null && 'artists' in item;
}

// ---------------------------------------------------------------------------
// Shared fetchers (read-only GET endpoints)
// ---------------------------------------------------------------------------

async function fetchPlaybackState(client: SpotifyClient): Promise<PlaybackState | null> {
  return client.get<PlaybackState>('/me/player');
}

async function fetchDevices(client: SpotifyClient): Promise<SpotifyDevice[]> {
  const res = await client.get<GetDevicesResponse>('/me/player/devices');
  return res?.devices ?? [];
}

async function fetchQueue(client: SpotifyClient): Promise<SpotifyQueue> {
  const res = await client.get<SpotifyQueue>('/me/player/queue');
  return {
    currently_playing: res?.currently_playing ?? null,
    queue: res?.queue ?? [],
  };
}

// ---------------------------------------------------------------------------
// Device ranking + volume helpers
// ---------------------------------------------------------------------------

const TYPE_RANK: Record<string, number> = {
  Computer: 0,
  Smartphone: 1,
  Tablet: 2,
  TV: 3,
  Speaker: 4,
  CastAudio: 5,
  Automotive: 6,
  Unknown: 9,
};

function typeRank(type: string): number {
  return TYPE_RANK[type] ?? 9;
}

function rankDevices(devices: readonly SpotifyDevice[]): SpotifyDevice[] {
  return [...devices].sort((a, b) => {
    if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
    const tr = typeRank(a.type) - typeRank(b.type);
    if (tr !== 0) return tr;
    return (b.volume_percent ?? -1) - (a.volume_percent ?? -1);
  });
}

function volumeDisplay(d: SpotifyDevice): string {
  return d.volume_percent === null ? '—' : `${d.volume_percent}%`;
}

/** Resolve a device argument (exact id first, then case-insensitive name substring). */
function resolveDevice(devices: readonly SpotifyDevice[], hint: string): SpotifyDevice | null {
  const exact = devices.find((d) => d.id === hint);
  if (exact) return exact;
  const lower = hint.toLowerCase();
  return devices.find((d) => d.name.toLowerCase().includes(lower)) ?? null;
}

function deviceLine(d: SpotifyDevice): string {
  const flags: string[] = [];
  if (d.is_active) flags.push('ACTIVE');
  if (d.is_restricted) flags.push('restricted');
  if (d.is_private_session) flags.push('private');
  return `${d.id ?? '(no id)'} — "${d.name}" [${d.type}] vol ${volumeDisplay(d)}${flags.length ? ` (${flags.join(', ')})` : ''}`;
}

// ---------------------------------------------------------------------------
// Bookmark sidecar helpers (local JSON under backupDir())
// ---------------------------------------------------------------------------

interface PlaybackBookmark {
  id: string;
  captured_at: string;
  label?: string;
  device_id: string | null;
  device_name: string | null;
  track_uri: string;
  track_name: string;
  position_ms: number;
  is_playing: boolean;
  context_uri: string | null;
}

const BOOKMARK_PREFIX = 'playback-bookmark-';
const BOOKMARK_SUFFIX = '.json';

function bookmarkPath(id: string): string {
  // Defensive: ids are generated by capture_playback_position, but never let a
  // caller craft a path that escapes the backup dir.
  const safe = id.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${BOOKMARK_PREFIX}${safe}${BOOKMARK_SUFFIX}`;
}

async function listBookmarkIds(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir))
      .filter((f) => f.startsWith(BOOKMARK_PREFIX) && f.endsWith(BOOKMARK_SUFFIX))
      .map((f) => f.slice(BOOKMARK_PREFIX.length, -BOOKMARK_SUFFIX.length))
      .sort();
  } catch {
    return [];
  }
}

async function readBookmark(dir: string, id: string): Promise<PlaybackBookmark | null> {
  try {
    const raw = await readFile(`${dir}/${bookmarkPath(id)}`, 'utf8');
    return JSON.parse(raw) as PlaybackBookmark;
  } catch {
    return null;
  }
}

async function writeBookmark(dir: string, bookmark: PlaybackBookmark): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(`${dir}/${bookmarkPath(bookmark.id)}`, `${JSON.stringify(bookmark, null, 2)}\n`, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Listening-session sidecar helpers (local JSON under backupDir())
// ---------------------------------------------------------------------------

interface ListeningSession {
  id: string;
  label?: string;
  started_at: string;
  closed_at?: string;
  duration_ms?: number;
  closed?: boolean;
  start_snapshot: Record<string, unknown>;
  end_snapshot?: Record<string, unknown>;
}

const SESSION_PREFIX = 'listening-session-';
const SESSION_SUFFIX = '.json';

function sessionPath(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${SESSION_PREFIX}${safe}${SESSION_SUFFIX}`;
}

async function listSessionIds(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir))
      .filter((f) => f.startsWith(SESSION_PREFIX) && f.endsWith(SESSION_SUFFIX))
      .map((f) => f.slice(SESSION_PREFIX.length, -SESSION_SUFFIX.length))
      .sort();
  } catch {
    return [];
  }
}

async function readSession(dir: string, id: string): Promise<ListeningSession | null> {
  try {
    const raw = await readFile(`${dir}/${sessionPath(id)}`, 'utf8');
    return JSON.parse(raw) as ListeningSession;
  } catch {
    return null;
  }
}

async function writeSession(dir: string, session: ListeningSession): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(`${dir}/${sessionPath(session.id)}`, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
}

/** Compact machine-readable snapshot of a playback state (reused by several tools). */
function snapshotOf(state: PlaybackState | null, at: string): Record<string, unknown> {
  if (!state) return { at, active: false };
  return {
    at,
    active: true,
    is_playing: state.is_playing,
    device_id: state.device?.id ?? null,
    device_name: state.device?.name ?? null,
    track_uri: state.item?.uri ?? null,
    track_name: itemTitle(state.item),
    position_ms: state.progress_ms ?? 0,
    shuffle_state: state.shuffle_state,
    repeat_state: state.repeat_state,
    context_uri: state.context?.uri ?? null,
    context_type: state.context?.type ?? null,
  };
}

// ---------------------------------------------------------------------------
// Queue shared shapes
// ---------------------------------------------------------------------------

interface QueueEntry {
  position: number; // 1-based position in the upcoming queue
  uri: string;
  name: string;
  subtitle: string;
  duration_ms: number;
  is_episode: boolean;
}

function queueEntries(queue: SpotifyQueue): QueueEntry[] {
  return (queue.queue ?? []).map((item, i) => ({
    position: i + 1,
    uri: item?.uri ?? '',
    name: itemTitle(item),
    subtitle: itemSubtitle(item),
    duration_ms: item?.duration_ms ?? 0,
    is_episode: !isTrackItem(item),
  }));
}

// ===========================================================================
// Tool registration
// ===========================================================================

export function registerSwarm3PlaybackTools(server: McpServer, client: SpotifyClient): void {
  // -------------------------------------------------------------------------
  // 1. get_playback_snapshot — full current state, compact
  // -------------------------------------------------------------------------
  server.tool(
    'get_playback_snapshot',
    'Return the full current playback state compactly: device, track/episode, position, shuffle/repeat and context. Read-only.',
    { response_format: ResponseFormat },
    async (args: { response_format?: ResponseFormatValue }) => {
      const rf = args.response_format ?? 'concise';
      const state = await fetchPlaybackState(client);
      if (!state) {
        return textResult('No active playback on any device right now.', { active: false });
      }
      const item = state.item;
      const payload = snapshotOf(state, new Date(state.timestamp).toISOString());
      const prose = [
        `Playback snapshot (${state.is_playing ? 'playing' : 'paused'}):`,
        `  Device: ${state.device ? deviceLine(state.device) : 'unknown'}`,
        `  Track:  "${itemTitle(item)}" — ${itemSubtitle(item)} (${formatMs(item?.duration_ms ?? 0)})`,
        `  Position: ${formatMs(state.progress_ms ?? 0)} / ${formatMs(item?.duration_ms ?? 0)}`,
        `  Shuffle: ${state.shuffle_state} · Repeat: ${state.repeat_state}`,
        `  Context: ${state.context ? `${state.context.type} ${state.context.uri}` : 'none'}`,
      ].join('\n');
      return shape(rf, prose, payload);
    },
  );

  // -------------------------------------------------------------------------
  // 2. capture_playback_position — bookmark track+position+device to local JSON
  // -------------------------------------------------------------------------
  server.tool(
    'capture_playback_position',
    'Bookmark the current track, playback position and device to a local JSON file under the backup dir so it can be resumed later with resume_playback_position. Writes only a local sidecar file, never touches Spotify.',
    {
      label: z.string().min(1).max(80).optional().describe('Optional short label to recognise the bookmark later'),
      response_format: ResponseFormat,
    },
    async (args: { label?: string; response_format?: ResponseFormatValue }) => {
      const rf = args.response_format ?? 'concise';
      const state = await fetchPlaybackState(client);
      if (!state || !state.item) {
        return textResult('Nothing is playing — no track/position to bookmark.', { active: false });
      }
      const id = new Date().toISOString().replace(/[:.]/g, '-');
      const bookmark: PlaybackBookmark = {
        id,
        captured_at: new Date().toISOString(),
        ...(args.label ? { label: args.label } : {}),
        device_id: state.device?.id ?? null,
        device_name: state.device?.name ?? null,
        track_uri: state.item.uri,
        track_name: itemTitle(state.item),
        position_ms: state.progress_ms ?? 0,
        is_playing: state.is_playing,
        context_uri: state.context?.uri ?? null,
      };
      const dir = backupDir();
      await writeBookmark(dir, bookmark);
      const structured = { bookmarked: true, bookmark, path: `${dir}/${bookmarkPath(id)}` };
      const prose = [
        `Bookmark captured → ${dir}/${bookmarkPath(id)}`,
        `  "${bookmark.track_name}" at ${formatMs(bookmark.position_ms)} on "${bookmark.device_name ?? bookmark.device_id ?? 'unknown device'}"`,
      ].join('\n');
      return shape(rf, prose, structured);
    },
  );

  // -------------------------------------------------------------------------
  // 3. resume_playback_position — seek device to bookmark (mutator, dry_run)
  // -------------------------------------------------------------------------
  server.tool(
    'resume_playback_position',
    'Resume a captured playback bookmark: transfer playback to the bookmarked device and seek to the bookmarked position. Preview by default — pass dry_run=false to execute.',
    {
      bookmark_id: z.string().min(1).describe('Bookmark id as returned by capture_playback_position / list_playback_bookmarks'),
      play: z.boolean().optional().default(true).describe('Start playback after transferring. Default true'),
      dry_run: DryRunDefault,
      response_format: ResponseFormat,
    },
    async (args: { bookmark_id: string; play?: boolean; dry_run?: boolean; response_format?: ResponseFormatValue }) => {
      const rf = args.response_format ?? 'concise';
      const dir = backupDir();
      const bookmark = await readBookmark(dir, args.bookmark_id);
      if (!bookmark) {
        return textResult(`No bookmark found with id "${args.bookmark_id}" under ${dir}.`, { found: false });
      }
      const devices = await fetchDevices(client);
      const device = bookmark.device_id ? devices.find((d) => d.id === bookmark.device_id) ?? null : null;
      const targetId = device?.id ?? bookmark.device_id;
      const transferBody = { device_ids: [targetId], play: args.play ?? true };
      const steps = [
        `PUT /me/player ${JSON.stringify(transferBody)} → resume "${bookmark.track_name}" on "${device?.name ?? bookmark.device_name ?? targetId ?? 'unknown'}"`,
        `PUT /me/player/seek?position_ms=${bookmark.position_ms}${targetId ? `&device_id=${encodeURIComponent(targetId)}` : ''}`,
      ];
      if (isDry(args)) {
        const prose = describeDryRun('resume playback position', `bookmark ${bookmark.id}`, steps);
        return shape(rf, prose, { dry_run: true, bookmark, steps });
      }
      if (!targetId) {
        return textResult('Bookmark has no device id and no matching device is available — cannot resume.', { resumed: false });
      }
      await client.put('/me/player', transferBody);
      try {
        await client.put(`/me/player/seek?position_ms=${bookmark.position_ms}&device_id=${encodeURIComponent(targetId)}`);
      } catch {
        // Seek can race the transfer on slow devices; retry once after the transfer settles.
        await client.put(`/me/player/seek?position_ms=${bookmark.position_ms}&device_id=${encodeURIComponent(targetId)}`);
      }
      return shape(rf, `Resumed "${bookmark.track_name}" at ${formatMs(bookmark.position_ms)} on "${device?.name ?? targetId}".`, {
        resumed: true,
        bookmark,
      });
    },
  );

  // -------------------------------------------------------------------------
  // 4. list_playback_bookmarks
  // -------------------------------------------------------------------------
  server.tool(
    'list_playback_bookmarks',
    'List all captured playback bookmarks stored locally under the backup dir, newest last. Read-only.',
    {
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args: { max_results?: number; response_format?: ResponseFormatValue }) => {
      const rf = args.response_format ?? 'concise';
      const dir = backupDir();
      const ids = await listBookmarkIds(dir);
      const cap = resolveMaxResults(args.max_results);
      const rows: PlaybackBookmark[] = [];
      for (const id of ids) {
        const bm = await readBookmark(dir, id);
        if (bm) rows.push(bm);
      }
      const cut = truncateItems(rows, cap);
      const lines = cut.items.map((bm) => {
        const label = bm.label ? ` (${bm.label})` : '';
        return `${bm.id}${label} — "${bm.track_name}" @ ${formatMs(bm.position_ms)} on "${bm.device_name ?? bm.device_id ?? '?'}"`;
      });
      const prose = [
        `${cut.total} bookmark(s) in ${dir}:`,
        ...(lines.length ? lines : ['  (none yet — use capture_playback_position while something is playing)']),
        ...(cut.footer ? [`(${cut.footer})`] : []),
      ].join('\n');
      return shape(rf, prose, { items: cut.items, pagination: { total: cut.total, returned: cut.returned, truncated: cut.truncated } });
    },
  );

  // -------------------------------------------------------------------------
  // 5. delete_playback_bookmark (mutator, dry_run)
  // -------------------------------------------------------------------------
  server.tool(
    'delete_playback_bookmark',
    'Delete one captured playback bookmark file from the local backup dir. Preview by default — pass dry_run=false to delete.',
    {
      bookmark_id: z.string().min(1).describe('Bookmark id to delete'),
      dry_run: DryRunDefault,
      response_format: ResponseFormat,
    },
    async (args: { bookmark_id: string; dry_run?: boolean; response_format?: ResponseFormatValue }) => {
      const rf = args.response_format ?? 'concise';
      const dir = backupDir();
      const bookmark = await readBookmark(dir, args.bookmark_id);
      if (!bookmark) {
        return textResult(`No bookmark found with id "${args.bookmark_id}" under ${dir}.`, { found: false });
      }
      const file = `${dir}/${bookmarkPath(args.bookmark_id)}`;
      if (isDry(args)) {
        const prose = describeDryRun('delete playback bookmark', file, [`"${bookmark.track_name}" @ ${formatMs(bookmark.position_ms)}`]);
        return shape(rf, prose, { dry_run: true, bookmark });
      }
      await unlink(file);
      return shape(rf, `Deleted bookmark ${args.bookmark_id} (${file}).`, { deleted: true, bookmark });
    },
  );

  // -------------------------------------------------------------------------
  // 6. compare_devices — rank devices by active/type/volume
  // -------------------------------------------------------------------------
  server.tool(
    'compare_devices',
    'List every available Spotify device ranked by active state, then device type (Computer > Smartphone > Tablet > TV > Speaker), then volume. Read-only.',
    { response_format: ResponseFormat },
    async (args: { response_format?: ResponseFormatValue }) => {
      const rf = args.response_format ?? 'concise';
      const devices = rankDevices(await fetchDevices(client));
      const lines = devices.map((d, i) => `${i + 1}. ${deviceLine(d)}`);
      const prose = [
        `${devices.length} device(s) available:`,
        ...(lines.length ? lines : ['  (none — open Spotify on a device first)']),
      ].join('\n');
      return shape(rf, prose, { items: devices, total: devices.length });
    },
  );

  // -------------------------------------------------------------------------
  // 7. get_device_volume_report
  // -------------------------------------------------------------------------
  server.tool(
    'get_device_volume_report',
    'Report volume_percent, supports_volume and active state for every Spotify device, highlighting the currently active device. Read-only.',
    { response_format: ResponseFormat },
    async (args: { response_format?: ResponseFormatValue }) => {
      const rf = args.response_format ?? 'concise';
      const [devices, state] = await Promise.all([fetchDevices(client), fetchPlaybackState(client)]);
      const lines = devices.map((d) =>
        `  ${d.is_active ? '▶' : ' '} "${d.name}" [${d.type}] vol ${volumeDisplay(d)}${d.supports_volume ? '' : ' (volume control unsupported)'}`,
      );
      const active = state?.device ?? null;
      const prose = [
        `Volume report for ${devices.length} device(s) — active: ${active ? `"${active.name}" at ${volumeDisplay(active)}` : 'none'}:`,
        ...(lines.length ? lines : ['  (none)']),
      ].join('\n');
      return shape(rf, prose, {
        items: devices.map((d) => ({
          id: d.id,
          name: d.name,
          type: d.type,
          volume_percent: d.volume_percent,
          supports_volume: d.supports_volume,
          is_active: d.is_active,
        })),
        active_device: active ? { id: active.id, name: active.name, volume_percent: active.volume_percent } : null,
      });
    },
  );

  // -------------------------------------------------------------------------
  // 8. plan_volume_level_across_devices — deterministic plan
  // -------------------------------------------------------------------------
  server.tool(
    'plan_volume_level_across_devices',
    'Plan setting every (volume-capable) Spotify device to one target volume level — returns the exact per-device PUT calls without executing anything. Read-only planner.',
    {
      volume: z.number().int().min(0).max(100).describe('Target volume percent for every selected device (0–100)'),
      device_ids: z.array(z.string().min(1)).optional().describe('Restrict the plan to these device ids/names; default all volume-capable devices'),
      response_format: ResponseFormat,
    },
    async (args: { volume: number; device_ids?: string[]; response_format?: ResponseFormatValue }) => {
      const rf = args.response_format ?? 'concise';
      const all = await fetchDevices(client);
      let selected = all.filter((d) => d.supports_volume);
      if (args.device_ids?.length) {
        const wanted = args.device_ids.map((h) => resolveDevice(all, h)).filter((d): d is SpotifyDevice => d !== null);
        selected = wanted.filter((d) => d.supports_volume);
      }
      const steps = selected.map((d) => `PUT /me/player/volume?volume=${args.volume}&device_id=${d.id} ("${d.name}")`);
      const prose = [
        `[plan] Set volume to ${args.volume}% on ${selected.length} device(s):`,
        ...(steps.length ? steps.map((s) => `  - ${s}`) : ['  (no volume-capable devices matched)']),
      ].join('\n');
      return shape(rf, prose, { volume: args.volume, steps, devices: selected.map((d) => d.id) });
    },
  );

  // -------------------------------------------------------------------------
  // 9. apply_volume_plan (mutator, dry_run)
  // -------------------------------------------------------------------------
  server.tool(
    'apply_volume_plan',
    'Set one target volume level across all (or selected) Spotify devices via per-device PUT /me/player/volume. Preview by default — pass dry_run=false to apply.',
    {
      volume: z.number().int().min(0).max(100).describe('Target volume percent for every selected device (0–100)'),
      device_ids: z.array(z.string().min(1)).optional().describe('Restrict to these device ids/names; default all volume-capable devices'),
      dry_run: DryRunDefault,
      response_format: ResponseFormat,
    },
    async (args: { volume: number; device_ids?: string[]; dry_run?: boolean; response_format?: ResponseFormatValue }) => {
      const rf = args.response_format ?? 'concise';
      const all = await fetchDevices(client);
      let selected = all.filter((d) => d.supports_volume);
      if (args.device_ids?.length) {
        const wanted = args.device_ids.map((h) => resolveDevice(all, h)).filter((d): d is SpotifyDevice => d !== null);
        selected = wanted.filter((d) => d.supports_volume);
      }
      if (isDry(args)) {
        const steps = selected.map((d) => `PUT /me/player/volume?volume=${args.volume}&device_id=${d.id} ("${d.name}")`);
        const prose = describeDryRun('apply volume plan', `${selected.length} device(s) → ${args.volume}%`, steps);
        return shape(rf, prose, { dry_run: true, volume: args.volume, steps });
      }
      const applied: string[] = [];
      const failed: string[] = [];
      for (const d of selected) {
        try {
          await client.put(`/me/player/volume?${new URLSearchParams({ volume: String(args.volume), device_id: d.id ?? '' })}`);
          applied.push(d.name);
        } catch {
          failed.push(d.name);
        }
      }
      const prose = `Volume set to ${args.volume}% on ${applied.length}/${selected.length} device(s)${failed.length ? ` — failed: ${failed.join(', ')}` : ''}.`;
      return shape(rf, prose, { applied: true, volume: args.volume, applied_devices: applied, failed_devices: failed });
    },
  );

  // -------------------------------------------------------------------------
  // 10. get_queue_snapshot — full queue + runtime
  // -------------------------------------------------------------------------
  server.tool(
    'get_queue_snapshot',
    'Return the full upcoming queue with per-track runtime and the total queue runtime. Read-only.',
    {
      max_results: MaxResults,
      response_format: ResponseFormat,
    },
    async (args: { max_results?: number; response_format?: ResponseFormatValue }) => {
      const rf = args.response_format ?? 'concise';
      const q = await fetchQueue(client);
      const entries = queueEntries(q);
      const cap = resolveMaxResults(args.max_results);
      const cut = truncateItems(entries, cap);
      const totalMs = entries.reduce((n, e) => n + e.duration_ms, 0);
      const lines = cut.items.map((e) => `${e.position}. "${e.name}" — ${e.subtitle} (${formatMs(e.duration_ms)})`);
      const prose = [
        `Queue: currently "${itemTitle(q.currently_playing)}" — ${itemSubtitle(q.currently_playing)}; ${entries.length} upcoming (${formatLong(totalMs)}):`,
        ...(lines.length ? lines : ['  (queue is empty)']),
        ...(cut.footer ? [`(${cut.footer})`] : []),
      ].join('\n');
      return shape(rf, prose, {
        currently_playing: q.currently_playing ? { uri: q.currently_playing.uri, name: itemTitle(q.currently_playing) } : null,
        items: cut.items,
        total: entries.length,
        total_runtime_ms: totalMs,
        pagination: { total: entries.length, returned: cut.returned, truncated: cut.truncated },
      });
    },
  );

  // -------------------------------------------------------------------------
  // 11. queue_runtime_report
  // -------------------------------------------------------------------------
  server.tool(
    'queue_runtime_report',
    'Compute runtime statistics for the upcoming queue: total, average, longest and shortest items plus time remaining on the current track. Read-only.',
    { response_format: ResponseFormat },
    async (args: { response_format?: ResponseFormatValue }) => {
      const rf = args.response_format ?? 'concise';
      const [state, q] = await Promise.all([fetchPlaybackState(client), fetchQueue(client)]);
      const entries = queueEntries(q);
      const durations = entries.map((e) => e.duration_ms);
      const totalMs = durations.reduce((n, d) => n + d, 0);
      const avgMs = entries.length ? Math.round(totalMs / entries.length) : 0;
      const longest = entries.reduce<QueueEntry | null>((best, e) => (!best || e.duration_ms > best.duration_ms ? e : best), null);
      const shortest = entries.reduce<QueueEntry | null>((best, e) => (!best || e.duration_ms < best.duration_ms ? e : best), null);
      const currentRemaining = state?.item ? Math.max(0, (state.item.duration_ms ?? 0) - (state.progress_ms ?? 0)) : 0;
      const payload = {
        upcoming_count: entries.length,
        total_runtime_ms: totalMs,
        average_runtime_ms: avgMs,
        longest: longest ? { uri: longest.uri, name: longest.name, duration_ms: longest.duration_ms } : null,
        shortest: shortest ? { uri: shortest.uri, name: shortest.name, duration_ms: shortest.duration_ms } : null,
        current_track_remaining_ms: currentRemaining,
        estimated_total_wait_ms: totalMs + currentRemaining,
      };
      const prose = [
        `Queue runtime report:`,
        `  Upcoming items: ${payload.upcoming_count} · total ${formatLong(totalMs)} · avg ${formatMs(avgMs)}`,
        `  Longest:  ${longest ? `"${longest.name}" (${formatMs(longest.duration_ms)})` : '—'}`,
        `  Shortest: ${shortest ? `"${shortest.name}" (${formatMs(shortest.duration_ms)})` : '—'}`,
        `  Current track remaining: ${formatMs(currentRemaining)} · est. total wait ${formatLong(payload.estimated_total_wait_ms)}`,
      ].join('\n');
      return shape(rf, prose, payload);
    },
  );

  // -------------------------------------------------------------------------
  // 12. split_queue_plan — plan queue → playlist chunks (mutator, dry_run)
  // -------------------------------------------------------------------------
  server.tool(
    'split_queue_plan',
    'Plan splitting the upcoming queue into runtime-bounded playlist chunks (default 30 minutes each). Preview by default — pass dry_run=false to actually create the playlists and fill them.',
    {
      chunk_minutes: z.number().int().min(5).max(240).optional().default(30).describe('Target runtime per chunk in minutes. Default 30'),
      playlist_name_prefix: z.string().min(1).max(60).optional().default('Queue chunk').describe('Name prefix for created playlists. Default "Queue chunk"'),
      dry_run: DryRunDefault,
      response_format: ResponseFormat,
    },
    async (args: { chunk_minutes?: number; playlist_name_prefix?: string; dry_run?: boolean; response_format?: ResponseFormatValue }) => {
      const rf = args.response_format ?? 'concise';
      const chunkMs = (args.chunk_minutes ?? 30) * 60_000;
      const prefix = args.playlist_name_prefix ?? 'Queue chunk';
      const q = await fetchQueue(client);
      const entries = queueEntries(q).filter((e) => e.uri);

      // Greedy chunking: close a chunk once adding the next item would exceed the cap.
      const chunks: QueueEntry[][] = [];
      let current: QueueEntry[] = [];
      let currentMs = 0;
      for (const e of entries) {
        if (current.length > 0 && currentMs + e.duration_ms > chunkMs) {
          chunks.push(current);
          current = [];
          currentMs = 0;
        }
        current.push(e);
        currentMs += e.duration_ms;
      }
      if (current.length) chunks.push(current);

      const chunkPlans = chunks.map((chunk, i) => {
        const ms = chunk.reduce((n, e) => n + e.duration_ms, 0);
        return {
          playlist_name: `${prefix} ${String(i + 1).padStart(2, '0')}`,
          track_count: chunk.length,
          runtime_ms: ms,
          uris: chunk.map((e) => e.uri),
        };
      });

      if (isDry(args)) {
        const lines = chunkPlans.map((c) => `  - "${c.playlist_name}": ${c.track_count} tracks, ${formatLong(c.runtime_ms)}`);
        const steps = chunkPlans.flatMap((c) => [
          `POST /me/playlists → "${c.playlist_name}"`,
          ...chunkedUris(c.uris).map((part, i) => `POST /playlists/{id}/items${i === 0 ? ' (PUT replace first ≤100)' : ` (append ${part.length})`}`),
        ]);
        const prose = [
          describeDryRun('split queue into playlist chunks', `${chunkPlans.length} chunk(s) of ≤${args.chunk_minutes ?? 30}m`, lines),
          steps.length ? '\nCalls that dry_run=false would make:\n' + steps.map((s) => `  - ${s}`).join('\n') : '',
        ].filter(Boolean).join('\n');
        return shape(rf, prose, { dry_run: true, chunks: chunkPlans });
      }

      const me = await client.get<{ id?: string }>('/me');
      if (!me?.id) return textResult('Could not resolve the current user id to create playlists.', { created: false });
      const created: Array<{ name: string; id?: string; tracks: number }> = [];
      for (const c of chunkPlans) {
        const pl = await client.post<{ id?: string }>('/me/playlists', {
          name: c.playlist_name,
          public: false,
          description: `${c.track_count} tracks, ${formatLong(c.runtime_ms)} — split from the live queue`,
        });
        if (!pl?.id) {
          created.push({ name: c.playlist_name, tracks: 0 });
          continue;
        }
        const first = c.uris.slice(0, 100);
        await client.put(`/playlists/${encodeURIComponent(pl.id)}/items`, { uris: first });
        for (const part of chunkedUris(c.uris.slice(100))) {
          await client.post(`/playlists/${encodeURIComponent(pl.id)}/items`, { uris: part });
        }
        created.push({ name: c.playlist_name, id: pl.id, tracks: c.track_count });
      }
      return shape(rf, `Created ${created.length} playlist(s) from the queue.`, { created: true, chunks: created });
    },
  );

  // -------------------------------------------------------------------------
  // 13. queue_duplicate_check
  // -------------------------------------------------------------------------
  server.tool(
    'queue_duplicate_check',
    'Check the upcoming queue for duplicate tracks/episodes and report each duplicate group with its positions and wasted runtime. Read-only.',
    { response_format: ResponseFormat },
    async (args: { response_format?: ResponseFormatValue }) => {
      const rf = args.response_format ?? 'concise';
      const q = await fetchQueue(client);
      const entries = queueEntries(q);
      const byUri = new Map<string, QueueEntry[]>();
      for (const e of entries) {
        const list = byUri.get(e.uri) ?? [];
        list.push(e);
        byUri.set(e.uri, list);
      }
      const groups = [...byUri.entries()]
        .filter(([, list]) => list.length > 1)
        .map(([uri, list]) => ({
          uri,
          name: list[0].name,
          occurrences: list.length,
          positions: list.map((e) => e.position),
          wasted_runtime_ms: list.slice(1).reduce((n, e) => n + e.duration_ms, 0),
        }))
        .sort((a, b) => a.positions[0] - b.positions[0]);
      const wasted = groups.reduce((n, g) => n + g.wasted_runtime_ms, 0);
      const prose = [
        groups.length
          ? `${groups.length} duplicate group(s) — ${groups.reduce((n, g) => n + g.occurrences - 1, 0)} redundant entries, ${formatMs(wasted)} wasted:`
          : 'No duplicates in the upcoming queue.',
        ...groups.map((g) => `  - "${g.name}" ×${g.occurrences} at positions ${g.positions.join(', ')} (${formatMs(g.wasted_runtime_ms)} wasted)`),
      ].join('\n');
      return shape(rf, prose, { duplicate_groups: groups, total_redundant: groups.reduce((n, g) => n + g.occurrences - 1, 0), wasted_runtime_ms: wasted });
    },
  );

  // -------------------------------------------------------------------------
  // 14. queue_prune_plan — plan-only dedupe/skip plan
  // -------------------------------------------------------------------------
  server.tool(
    'queue_prune_plan',
    'Plan pruning the upcoming queue: identify redundant duplicate entries (and optionally podcast episodes) to drop, and emit a clean re-queue list. Spotify has no queue-removal endpoint, so this is a plan you act on with queue playback. Read-only planner.',
    {
      drop_episodes: z.boolean().optional().default(false).describe('Also plan to drop podcast episodes from the queue. Default false'),
      response_format: ResponseFormat,
    },
    async (args: { drop_episodes?: boolean; response_format?: ResponseFormatValue }) => {
      const rf = args.response_format ?? 'concise';
      const q = await fetchQueue(client);
      const entries = queueEntries(q).filter((e) => e.uri);
      const seen = new Set<string>();
      const drop: QueueEntry[] = [];
      const keep: QueueEntry[] = [];
      for (const e of entries) {
        if (seen.has(e.uri) || (args.drop_episodes && e.is_episode)) {
          drop.push(e);
        } else {
          seen.add(e.uri);
          keep.push(e);
        }
      }
      const lines = drop.map((e) => `  - drop #${e.position} "${e.name}" (${e.is_episode ? 'episode' : 'duplicate'})`);
      const prose = [
        `[plan] Prune ${drop.length} of ${entries.length} queued item(s):`,
        ...(lines.length ? lines : ['  (nothing to prune — queue is already clean)']),
        keep.length ? `\nClean re-queue list (${keep.length} items):\n  ${keep.map((e) => e.uri).join('\n  ')}` : '',
      ].filter(Boolean).join('\n');
      return shape(rf, prose, { drop: drop.map((e) => e.uri), keep: keep.map((e) => e.uri), dropped_count: drop.length });
    },
  );

  // -------------------------------------------------------------------------
  // 15. get_context_inspect — context details + position within it
  // -------------------------------------------------------------------------
  server.tool(
    'get_context_inspect',
    'Inspect the currently-playing context (playlist/album/artist) in detail, including the position of the current track within that context when it is enumerable. Read-only.',
    { response_format: ResponseFormat },
    async (args: { response_format?: ResponseFormatValue }) => {
      const rf = args.response_format ?? 'concise';
      const state = await fetchPlaybackState(client);
      if (!state || !state.item) {
        return textResult('No active playback to inspect.', { active: false });
      }
      const ctx = state.context;
      const base = snapshotOf(state, new Date(state.timestamp).toISOString());
      if (!ctx) {
        return shape(rf, `Playing "${itemTitle(state.item)}" with no context (single track / autoplay).`, { ...base, context_enumerated: false });
      }
      let positionInContext: number | null = null;
      let contextTotal: number | null = null;
      const cap = getConfig().fetchAllCap;
      try {
        if (ctx.type === 'playlist' && ctx.uri) {
          const pid = ctx.uri.split(':').pop() ?? '';
          const page = await client.get<{ items?: Array<{ track?: { uri?: string } | null }> }>(
            `/playlists/${encodeURIComponent(pid)}/items`,
            { limit: String(Math.min(100, cap)) },
          );
          let items = (page?.items ?? []).map((r) => r.track?.uri ?? '').filter(Boolean);
          let offset = 0;
          // Walk pages (offset-based) until the track is found or the cap is hit.
          while (positionInContext === null && items.length > 0 && offset < cap) {
            const idx = items.indexOf(state.item.uri);
            if (idx >= 0) {
              positionInContext = offset + idx + 1;
              break;
            }
            offset += items.length;
            const next = await client.get<{ items?: Array<{ track?: { uri?: string } | null }> }>(
              `/playlists/${encodeURIComponent(pid)}/items`,
              { limit: String(Math.min(100, cap)), offset: String(offset) },
            );
            items = (next?.items ?? []).map((r) => r.track?.uri ?? '').filter(Boolean);
            if (items.length === 0) break;
          }
        } else if (ctx.type === 'album' && ctx.uri) {
          const aid = ctx.uri.split(':').pop() ?? '';
          const album = await client.get<{ total_tracks?: number; tracks?: { items?: Array<{ uri?: string }> } }>(
            `/albums/${encodeURIComponent(aid)}/tracks`,
            { limit: '50' },
          );
          const uris = (album?.tracks?.items ?? []).map((t) => t.uri ?? '').filter(Boolean);
          contextTotal = album?.total_tracks ?? null;
          const idx = uris.indexOf(state.item.uri);
          positionInContext = idx >= 0 ? idx + 1 : null;
        }
      } catch {
        // Non-fatal: report position as unknown.
      }
      const positionText = positionInContext !== null
        ? `Track ${positionInContext}${contextTotal ? ` of ${contextTotal}` : ''} in the context`
        : 'Position within the context could not be determined (non-enumerable or capped walk).';
      const prose = [
        `Context inspect:`,
        `  Type: ${ctx.type} · URI: ${ctx.uri}`,
        `  Current: "${itemTitle(state.item)}" at ${formatMs(state.progress_ms ?? 0)}`,
        `  ${positionText}`,
      ].join('\n');
      return shape(rf, prose, {
        ...base,
        context_enumerated: positionInContext !== null,
        position_in_context: positionInContext,
        context_total: contextTotal,
      });
    },
  );

  // -------------------------------------------------------------------------
  // 16. predict_next_tracks — upcoming N with runtime
  // -------------------------------------------------------------------------
  server.tool(
    'predict_next_tracks',
    'Predict the next N tracks that will play from the queue, each with its own runtime and the cumulative time until it plays. Read-only.',
    {
      count: z.number().int().min(1).max(50).optional().default(5).describe('How many upcoming items to predict. Default 5'),
      response_format: ResponseFormat,
    },
    async (args: { count?: number; response_format?: ResponseFormatValue }) => {
      const rf = args.response_format ?? 'concise';
      const [state, q] = await Promise.all([fetchPlaybackState(client), fetchQueue(client)]);
      const entries = queueEntries(q).slice(0, Math.max(1, args.count ?? 5));
      const currentRemaining = state?.item ? Math.max(0, (state.item.duration_ms ?? 0) - (state.progress_ms ?? 0)) : 0;
      let cumulative = currentRemaining;
      const withEta = entries.map((e) => {
        const plays_at_ms = cumulative;
        cumulative += e.duration_ms;
        return { ...e, plays_at_ms };
      });
      const lines = withEta.map((e) =>
        `+${formatMs(e.plays_at_ms)} → "${e.name}" — ${e.subtitle} (${formatMs(e.duration_ms)})`,
      );
      const prose = [
        `Next ${withEta.length} item(s) from the queue:`,
        ...(lines.length ? lines : ['  (queue is empty — predictions unavailable)']),
      ].join('\n');
      return shape(rf, prose, { items: withEta, current_track_remaining_ms: currentRemaining });
    },
  );

  // -------------------------------------------------------------------------
  // 17. shuffle_state_report
  // -------------------------------------------------------------------------
  server.tool(
    'shuffle_state_report',
    'Report the current shuffle and repeat state, the device they apply to and the active context. Read-only.',
    { response_format: ResponseFormat },
    async (args: { response_format?: ResponseFormatValue }) => {
      const rf = args.response_format ?? 'concise';
      const state = await fetchPlaybackState(client);
      if (!state) {
        return textResult('No active playback — shuffle state unknown.', { active: false });
      }
      const payload = {
        active: true,
        shuffle_state: state.shuffle_state,
        repeat_state: state.repeat_state,
        device: state.device ? { id: state.device.id, name: state.device.name, type: state.device.type } : null,
        context_uri: state.context?.uri ?? null,
        is_playing: state.is_playing,
      };
      const prose = [
        `Shuffle: ${state.shuffle_state ? 'ON' : 'OFF'} · Repeat: ${state.repeat_state}`,
        `  Device: ${state.device ? `"${state.device.name}" [${state.device.type}]` : 'unknown'}`,
        `  Context: ${state.context?.uri ?? 'none'} · ${state.is_playing ? 'playing' : 'paused'}`,
      ].join('\n');
      return shape(rf, prose, payload);
    },
  );

  // -------------------------------------------------------------------------
  // 18. playback_health_check — token/device/queue probe
  // -------------------------------------------------------------------------
  server.tool(
    'playback_health_check',
    'Probe the playback stack end to end: token validity, available devices, current playback state and queue readability — reporting pass/fail per probe. Read-only.',
    { response_format: ResponseFormat },
    async (args: { response_format?: ResponseFormatValue }) => {
      const rf = args.response_format ?? 'concise';
      const probes: Array<{ probe: string; ok: boolean; detail: string }> = [];

      try {
        const me = await client.get<{ id?: string; display_name?: string }>('/me');
        probes.push({ probe: 'token', ok: Boolean(me?.id), detail: me?.id ? `authenticated as ${me.display_name ?? me.id}` : 'no user profile returned' });
      } catch (e) {
        probes.push({ probe: 'token', ok: false, detail: `failed: ${(e as Error).message}` });
      }

      let devices: SpotifyDevice[] = [];
      try {
        devices = await fetchDevices(client);
        probes.push({ probe: 'devices', ok: devices.length > 0, detail: `${devices.length} device(s), ${devices.filter((d) => d.is_active).length} active` });
      } catch (e) {
        probes.push({ probe: 'devices', ok: false, detail: `failed: ${(e as Error).message}` });
      }

      try {
        const state = await fetchPlaybackState(client);
        probes.push({
          probe: 'playback_state',
          ok: true,
          detail: state ? `${state.is_playing ? 'playing' : 'paused'} on "${state.device?.name ?? '?'}"` : 'no active session (ok, but nothing playing)',
        });
      } catch (e) {
        probes.push({ probe: 'playback_state', ok: false, detail: `failed: ${(e as Error).message}` });
      }

      try {
        const q = await fetchQueue(client);
        const n = (q.queue ?? []).length;
        probes.push({ probe: 'queue', ok: true, detail: `${n} upcoming item(s)` });
      } catch (e) {
        probes.push({ probe: 'queue', ok: false, detail: `failed: ${(e as Error).message}` });
      }

      const healthy = probes.every((p) => p.ok);
      const prose = [
        `Playback health check: ${healthy ? 'HEALTHY' : 'DEGRADED'}`,
        ...probes.map((p) => `  ${p.ok ? '✓' : '✗'} ${p.probe}: ${p.detail}`),
      ].join('\n');
      return shape(rf, prose, { healthy, probes });
    },
  );

  // -------------------------------------------------------------------------
  // 19. listening_session_start — local session log
  // -------------------------------------------------------------------------
  server.tool(
    'listening_session_start',
    'Start a local listening-session log: captures the current playback snapshot into a session file under the backup dir; close it later with listening_session_close. Writes only a local sidecar file.',
    {
      label: z.string().min(1).max(80).optional().describe('Optional short label for the session'),
      response_format: ResponseFormat,
    },
    async (args: { label?: string; response_format?: ResponseFormatValue }) => {
      const rf = args.response_format ?? 'concise';
      const state = await fetchPlaybackState(client);
      const id = new Date().toISOString().replace(/[:.]/g, '-');
      const dir = backupDir();
      const session: ListeningSession = {
        id,
        ...(args.label ? { label: args.label } : {}),
        started_at: new Date().toISOString(),
        start_snapshot: snapshotOf(state, new Date().toISOString()),
      };
      await writeSession(dir, session);
      const playing = state ? `"${itemTitle(state.item)}" on "${state.device?.name ?? '?'}"` : 'nothing playing';
      const prose = `Listening session started (${id}) — ${playing}.\nLog: ${dir}/${sessionPath(id)}`;
      return shape(rf, prose, { started: true, session });
    },
  );

  // -------------------------------------------------------------------------
  // 20. listening_session_close
  // -------------------------------------------------------------------------
  server.tool(
    'listening_session_close',
    'Close a listening session: captures an end-of-session playback snapshot, stamps the duration and marks the session log closed. Writes only a local sidecar file.',
    {
      session_id: z.string().min(1).describe('Session id from listening_session_start'),
      response_format: ResponseFormat,
    },
    async (args: { session_id: string; response_format?: ResponseFormatValue }) => {
      const rf = args.response_format ?? 'concise';
      const dir = backupDir();
      const session = await readSession(dir, args.session_id);
      if (!session) {
        return textResult(`No session found with id "${args.session_id}" under ${dir}.`, { found: false });
      }
      const state = await fetchPlaybackState(client);
      const start = session.start_snapshot as { track_name?: string; device_name?: string | null };
      const closedAt = new Date();
      const durationMs = Math.max(0, closedAt.getTime() - new Date(session.started_at).getTime());
      const closed: ListeningSession = {
        ...session,
        closed: true,
        closed_at: closedAt.toISOString(),
        duration_ms: durationMs,
        end_snapshot: snapshotOf(state, closedAt.toISOString()),
      };
      await writeSession(dir, closed);
      const prose = [
        `Listening session closed: ${session.id}`,
        `  Duration: ${formatLong(durationMs)}`,
        `  Started: "${start.track_name ?? '?'}" → ended ${state ? `"${itemTitle(state.item)}" on "${state.device?.name ?? '?'}"` : 'nothing playing'}`,
        `  Log: ${dir}/${sessionPath(session.id)}`,
      ].join('\n');
      return shape(rf, prose, { closed: true, session: closed });
    },
  );

  // -------------------------------------------------------------------------
  // 21. listening_session_report
  // -------------------------------------------------------------------------
  server.tool(
    'listening_session_report',
    'Report a listening session (or the most recent one when no id is given): duration, start/end snapshots and closed status. Read-only.',
    {
      session_id: z.string().min(1).optional().describe('Session id; omit to report the most recent session'),
      response_format: ResponseFormat,
    },
    async (args: { session_id?: string; response_format?: ResponseFormatValue }) => {
      const rf = args.response_format ?? 'concise';
      const dir = backupDir();
      const ids = await listSessionIds(dir);
      if (ids.length === 0) {
        return textResult(`No listening sessions recorded under ${dir}.`, { found: false });
      }
      const chosenId = args.session_id ?? ids[ids.length - 1];
      const session = await readSession(dir, chosenId);
      if (!session) {
        return textResult(`No session found with id "${chosenId}" under ${dir}.`, { found: false });
      }
      const start = session.start_snapshot as { track_name?: string; device_name?: string | null };
      const end = (session.end_snapshot ?? {}) as { track_name?: string; device_name?: string | null };
      const payload = { session, found: true };
      const prose = [
        `Listening session ${session.id}${session.label ? ` (${session.label})` : ''} — ${session.closed ? 'closed' : 'STILL OPEN'}`,
        `  Started: ${session.started_at} — "${start.track_name ?? '?'}" on "${start.device_name ?? '?'}"`,
        ...(session.closed
          ? [
              `  Closed:  ${session.closed_at} — "${end.track_name ?? '?'}" on "${end.device_name ?? '?'}"`,
              `  Duration: ${formatLong(session.duration_ms ?? 0)}`,
            ]
          : []),
      ].join('\n');
      return shape(rf, prose, payload);
    },
  );

  // -------------------------------------------------------------------------
  // 22. transfer_playback_with_state — capture + transfer + restore (mutator)
  // -------------------------------------------------------------------------
  server.tool(
    'transfer_playback_with_state',
    'Transfer playback to another device while restoring the full state: same track, position, shuffle and repeat. Preview by default — pass dry_run=false to execute the transfer.',
    {
      target_device: z.string().min(1).describe('Target device id or name substring'),
      play: z.boolean().optional().default(true).describe('Start playback after transferring. Default true'),
      dry_run: DryRunDefault,
      response_format: ResponseFormat,
    },
    async (args: { target_device: string; play?: boolean; dry_run?: boolean; response_format?: ResponseFormatValue }) => {
      const rf = args.response_format ?? 'concise';
      const [state, devices] = await Promise.all([fetchPlaybackState(client), fetchDevices(client)]);
      const target = resolveDevice(devices, args.target_device);
      if (!target?.id) {
        return textResult(`No device matches "${args.target_device}" among ${devices.length} device(s).`, { target_found: false });
      }
      const captured = {
        track_uri: state?.item?.uri ?? null,
        track_name: itemTitle(state?.item ?? null),
        position_ms: state?.progress_ms ?? 0,
        shuffle_state: state?.shuffle_state ?? null,
        repeat_state: state?.repeat_state ?? null,
      };
      const qs = `?device_id=${encodeURIComponent(target.id)}`;
      const steps = [
        `PUT /me/player ${JSON.stringify({ device_ids: [target.id], play: args.play ?? true })}`,
        ...(captured.track_uri ? [`PUT /me/player/play${qs} context-less resume of ${captured.track_uri}`] : []),
        `PUT /me/player/seek?position_ms=${captured.position_ms}&device_id=${encodeURIComponent(target.id)}`,
        ...(captured.shuffle_state !== null ? [`PUT /me/player/shuffle?state=${captured.shuffle_state}${qs}`] : []),
        ...(captured.repeat_state ? [`PUT /me/player/repeat?state=${captured.repeat_state}${qs}`] : []),
      ];
      if (isDry(args)) {
        const prose = describeDryRun('transfer playback with state', `"${target.name}" [${target.type}]`, steps);
        return shape(rf, prose, { dry_run: true, target: { id: target.id, name: target.name }, captured, steps });
      }
      const failed: string[] = [];
      await client.put('/me/player', { device_ids: [target.id], play: args.play ?? true }).catch(() => { failed.push('transfer'); });
      if (captured.track_uri && args.play !== false) {
        try {
          await client.put(`/me/player/play${qs}`, { uris: [captured.track_uri], position_ms: captured.position_ms });
        } catch {
          // Fall back to transfer + separate seek when context-less resume is refused.
          try {
            await client.put(`/me/player/seek?position_ms=${captured.position_ms}&device_id=${encodeURIComponent(target.id)}`);
          } catch {
            failed.push('seek');
          }
        }
      } else {
        try {
          await client.put(`/me/player/seek?position_ms=${captured.position_ms}&device_id=${encodeURIComponent(target.id)}`);
        } catch {
          failed.push('seek');
        }
      }
      if (captured.shuffle_state !== null) {
        await client.put(`/me/player/shuffle?state=${captured.shuffle_state}${qs}`).catch(() => { failed.push('shuffle'); });
      }
      if (captured.repeat_state) {
        await client.put(`/me/player/repeat?state=${captured.repeat_state}${qs}`).catch(() => { failed.push('repeat'); });
      }
      const prose = `Transferred playback to "${target.name}" with state restored${failed.length ? ` (failed steps: ${failed.join(', ')})` : ''}.`;
      return shape(rf, prose, { transferred: failed.length === 0, target: { id: target.id, name: target.name }, captured, failed_steps: failed });
    },
  );

  // -------------------------------------------------------------------------
  // 23. sleep_timer_plan — pick N tracks ≈ X min then pause plan
  // -------------------------------------------------------------------------
  server.tool(
    'sleep_timer_plan',
    'Plan a sleep timer: pick the leading queue items whose cumulative runtime best approximates a target duration, then a final pause call. Read-only planner.',
    {
      minutes: z.number().int().min(5).max(240).optional().default(30).describe('Target listening duration in minutes. Default 30'),
      response_format: ResponseFormat,
    },
    async (args: { minutes?: number; response_format?: ResponseFormatValue }) => {
      const rf = args.response_format ?? 'concise';
      const targetMs = (args.minutes ?? 30) * 60_000;
      const q = await fetchQueue(client);
      const entries = queueEntries(q);

      // Greedy fill: take items while they keep us under target, then stop.
      const picked: QueueEntry[] = [];
      let total = 0;
      for (const e of entries) {
        if (total + e.duration_ms > targetMs) break;
        picked.push(e);
        total += e.duration_ms;
      }
      const lastPosition = picked.length ? picked[picked.length - 1].position : 0;
      const shortfall = Math.max(0, targetMs - total);
      const payload = {
        target_minutes: args.minutes ?? 30,
        picked_count: picked.length,
        picked_runtime_ms: total,
        shortfall_ms: shortfall,
        pause_after_position: lastPosition,
        items: picked.map((e) => ({ uri: e.uri, name: e.name, duration_ms: e.duration_ms })),
      };
      const prose = [
        `[plan] Sleep timer ≈ ${args.minutes ?? 30}m:`,
        `  Play ${picked.length} queued item(s) = ${formatLong(total)} (shortfall ${formatMs(shortfall)} vs target)`,
        ...picked.map((e, i) => `  ${i + 1}. "${e.name}" (${formatMs(e.duration_ms)})`),
        `  Then: PUT /me/player/pause — after queue position ${lastPosition}`,
      ].join('\n');
      return shape(rf, prose, payload);
    },
  );

  // -------------------------------------------------------------------------
  // 24. device_type_census
  // -------------------------------------------------------------------------
  server.tool(
    'device_type_census',
    'Census of available Spotify devices grouped by type, with counts, names and volume range per group. Read-only.',
    { response_format: ResponseFormat },
    async (args: { response_format?: ResponseFormatValue }) => {
      const rf = args.response_format ?? 'concise';
      const devices = await fetchDevices(client);
      const byType = new Map<string, SpotifyDevice[]>();
      for (const d of devices) {
        const list = byType.get(d.type) ?? [];
        list.push(d);
        byType.set(d.type, list);
      }
      const groups = [...byType.entries()]
        .map(([type, list]) => {
          const vols = list.map((d) => d.volume_percent).filter((v): v is number => v !== null);
          return {
            type,
            count: list.length,
            names: list.map((d) => d.name),
            volume_min: vols.length ? Math.min(...vols) : null,
            volume_max: vols.length ? Math.max(...vols) : null,
          };
        })
        .sort((a, b) => typeRank(a.type) - typeRank(b.type) || b.count - a.count);
      const prose = [
        `Device census — ${devices.length} device(s) across ${groups.length} type(s):`,
        ...groups.map((g) => `  ${g.type}: ×${g.count} — ${g.names.map((n) => `"${n}"`).join(', ')}${g.volume_min !== null ? ` (vol ${g.volume_min}–${g.volume_max}%)` : ''}`),
      ].join('\n');
      return shape(rf, prose, { groups, total_devices: devices.length });
    },
  );
}

// ---------------------------------------------------------------------------
// Local util (defined last; hoisted use in split_queue_plan)
// ---------------------------------------------------------------------------

/** Split a uri list into ≤100-URI batches for playlist item writes. */
function chunkedUris(uris: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < uris.length; i += 100) out.push(uris.slice(i, i + 100));
  return out;
}
