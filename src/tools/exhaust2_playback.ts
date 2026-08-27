/**
 * exhaust2 playback slice — feature swarm v1.24.0 (issues #358-#379).
 *
 * 22 playback tools owned by the fix/exhaust2-playback builder. All in this
 * slice register here and nowhere else. Buckets: timers/volume/sleep
 * (sleep_timer, mute, unmute, volume_ramp, room_level, volume_report),
 * devices (switch_device, pause_everywhere), shuffle-play (surprise_me,
 * skip_n, daily_pick), podcasts (episode_bookmark, episode_resume,
 * queue_next_episode), queue honesty (queue_replace_via_playlist,
 * queue_profile), intel (session_stats, most_replayed, last_heard,
 * weekday_heatmap), checkpoints (checkpoint_playback, continue_last).
 *
 * Local sidecar store lives next to the other playback sidecars
 * (~/.spotify-mcp/exhaust2-playback.json, 0600; override with
 * SPOTIFY_MCP_EXHAUST2_PLAYBACK_FILE). In-process timers (sleep_timer,
 * volume_ramp) are cancel-safe and disclosed as living in this server
 * process only.
 */
import { z } from 'zod';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import type {
  PlaybackState,
  RecentlyPlayedResponse,
  RecentlyPlayedItem,
  GetDevicesResponse,
  SpotifyDevice,
  SpotifyPaged,
  SpotifyTrack,
  SavedTrackItem,
  SavedAlbumItem,
  SpotifyPlaylistSimple,
} from '../types/spotify.js';
import {
  ResponseFormat,
  DryRun,
  truncateItems,
  describeDryRun,
} from '../shaping.js';
import type { ResponseFormatValue } from '../shaping.js';
import { detectSessions, loadPlaybackExt } from './playbackext.js';

// ---------------------------------------------------------------------------
// shared helpers (house style)
// ---------------------------------------------------------------------------

type ToolOut = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown> };

function textResult(text: string, structured?: Record<string, unknown>): ToolOut {
  return { content: [{ type: 'text', text }], ...(structured ? { structuredContent: structured } : {}) };
}
function emit(fmt: ResponseFormatValue | undefined, echo: Record<string, unknown>, text: string): ToolOut {
  if (fmt === 'json') return { content: [{ type: 'text', text: JSON.stringify(echo, null, 2) }], structuredContent: echo };
  return { content: [{ type: 'text', text }], structuredContent: echo };
}

/** Human-readable duration for gaps ("3d 4h", "12m"). */
export function humanGap(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 48) return `${h}h ${rm}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** FNV-1a 32-bit string hash (date-seeded picks). */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic PRNG (mulberry32) for seedable surprises. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rngFor(seed: number | undefined): () => number {
  return typeof seed === 'number' ? mulberry32(seed) : Math.random;
}

async function resolveDeviceHint(
  client: SpotifyClient,
  hint: string,
): Promise<{ deviceId: string | null; devices: SpotifyDevice[] }> {
  const res = await client.get<GetDevicesResponse>('/me/player/devices');
  const devices = res?.devices ?? [];
  const exact = devices.find((d) => d.id === hint);
  const store = await loadPlaybackExt();
  const byLabel = devices.find(
    (d) => (store.devicePresets[d.id ?? '']?.label ?? '').toLowerCase() === hint.toLowerCase(),
  );
  const found = exact ?? byLabel ?? devices.find((d) => d.name.toLowerCase().includes(hint.toLowerCase()));
  return { deviceId: found?.id ?? null, devices };
}

/**
 * Cursor-walk /me/player/recently-played (newest → older via the documented
 * `before=cursors.after` chain), up to maxPages pages. `stopEarly` can halt
 * the walk to save quota.
 */
async function walkRecentlyPlayed(
  client: SpotifyClient,
  maxPages: number,
  stopEarly?: (items: RecentlyPlayedItem[], all: RecentlyPlayedItem[]) => boolean,
): Promise<RecentlyPlayedItem[]> {
  const all: RecentlyPlayedItem[] = [];
  let params: Record<string, string> | undefined = { limit: '50' };
  for (let p = 0; p < maxPages; p++) {
    const res: RecentlyPlayedResponse | null = await client.get<RecentlyPlayedResponse>('/me/player/recently-played', params);
    if (!res?.items?.length) break;
    all.push(...res.items);
    if (stopEarly?.(res.items, all)) break;
    const after: string | number | undefined = (res as { cursors?: { after?: string | number } }).cursors?.after;
    if (!after || !res.next) break;
    params = { limit: '50', before: String(after) };
  }
  return all;
}

function trackArtists(t: unknown): string[] {
  const arr = (t as { artists?: Array<{ name?: string }> } | null)?.artists;
  return (arr ?? []).map((a) => a.name ?? '').filter(Boolean);
}

/** Minimal queue row shape for queue_replace_via_playlist (tracks + episodes). */
interface QueueRow { uri?: string; name?: string; type?: string; artists?: Array<{ name: string }> }

// ---------------------------------------------------------------------------
// local sidecar store
// ---------------------------------------------------------------------------

export function exhaust2PlaybackFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.SPOTIFY_MCP_EXHAUST2_PLAYBACK_FILE ?? join(homedir(), '.spotify-mcp', 'exhaust2-playback.json');
}

export interface MuteMemory {
  volume: number;
  muted_at: string;
  device_id: string | null;
  device_name: string | null;
}
export interface EpisodeBookmark {
  id: string;
  saved_at: string;
  note?: string;
  episode_uri: string;
  episode_name: string;
  show_name: string | null;
  show_id: string | null;
  progress_ms: number;
  duration_ms: number | null;
  device_id: string | null;
}
export interface Exhaust2Checkpoint {
  id: string;
  saved_at: string;
  note?: string;
  playback: PlaybackState | null;
}
export interface Exhaust2Store {
  muteMemory: Record<string, MuteMemory>;
  episodeBookmarks: Record<string, EpisodeBookmark>;
  checkpoints: Record<string, Exhaust2Checkpoint>;
}

export async function loadExhaust2Store(env: NodeJS.ProcessEnv = process.env): Promise<Exhaust2Store> {
  try {
    const raw = await readFile(exhaust2PlaybackFile(env), 'utf8');
    const p = JSON.parse(raw) as Partial<Exhaust2Store>;
    return {
      muteMemory: p.muteMemory ?? {},
      episodeBookmarks: p.episodeBookmarks ?? {},
      checkpoints: p.checkpoints ?? {},
    };
  } catch {
    return { muteMemory: {}, episodeBookmarks: {}, checkpoints: {} };
  }
}

export async function saveExhaust2Store(store: Exhaust2Store, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const file = exhaust2PlaybackFile(env);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

// ---------------------------------------------------------------------------
// in-process timer registry (sleep_timer + volume_ramp; cancel-safe)
// ---------------------------------------------------------------------------

export type Exhaust2TimerKind = 'sleep_timer' | 'volume_ramp';
interface ActiveTimer {
  kind: Exhaust2TimerKind;
  description: string;
  started_at: string;
  cancel: () => void;
}
const activeTimers = new Map<Exhaust2TimerKind, ActiveTimer>();

export function listExhaust2Timers(): Array<{ kind: Exhaust2TimerKind; description: string; started_at: string }> {
  return [...activeTimers.values()].map((t) => ({ kind: t.kind, description: t.description, started_at: t.started_at }));
}
/** Cancel the in-process timer of a kind (sleep_timer / volume_ramp). */
export function cancelExhaust2Timer(kind: Exhaust2TimerKind): boolean {
  const t = activeTimers.get(kind);
  if (!t) return false;
  t.cancel();
  return true;
}
function registerTimer(kind: Exhaust2TimerKind, description: string, timeout: NodeJS.Timeout): void {
  const t: ActiveTimer = {
    kind,
    description,
    started_at: new Date().toISOString(),
    cancel: () => {
      clearTimeout(timeout);
      activeTimers.delete(kind);
    },
  };
  timeout.unref?.();
  activeTimers.set(kind, t);
}

// ---------------------------------------------------------------------------
// volume ramp math (pure, exported for tests)
// ---------------------------------------------------------------------------

export interface RampStep { index: number; percent: number; after_minutes: number }

/**
 * Linear ramp from → to: ceil(minutes/step_minutes) even steps; the last
 * step lands exactly on the target.
 */
export function computeRampPlan(from: number, to: number, minutes: number, stepMinutes: number): RampStep[] {
  const n = Math.max(1, Math.ceil(minutes / Math.max(stepMinutes, 0.1)));
  const spacing = minutes / n;
  const steps: RampStep[] = [];
  for (let i = 1; i <= n; i++) {
    steps.push({ index: i, percent: i >= n ? to : Math.round(from + (to - from) * (i / n)), after_minutes: Math.round(spacing * i * 100) / 100 });
  }
  return steps;
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

export function registerExhaust2PlaybackTools(server: McpServer, client: SpotifyClient): void {
  // 1. sleep_timer (#358) — fire-and-forget auto-pause, cancel-safe
  server.tool(
    'sleep_timer',
    'Keep music playing and auto-pause after N minutes: registers an in-process timer (cancel-safe; calling again replaces it) that fires PUT /me/player/pause on expiry. No fade — distinct from stepped schedule_wind_down. Quota: 🟢 1 read now; 1 pause on expiry. Timer lives in this MCP server process only.',
    {
      duration_min: z.number().int().min(1).max(480).describe('Minutes until auto-pause (1-480)'),
      device_id: z.string().optional().describe('Device to pause on expiry (defaults to the active device at expiry time)'),
      response_format: ResponseFormat,
      dry_run: DryRun,
    },
    async (args) => {
      const fmt = args.response_format as ResponseFormatValue | undefined;
      const dryRun = args.dry_run ?? true;
      const state = await client.get<PlaybackState>('/me/player');
      const current = state?.item ? `"${state.item.name}"` : 'nothing playing';
      const device = state?.device?.name ?? args.device_id ?? 'active device';
      const target = args.device_id ?? state?.device?.id ?? null;
      const desc = `pause "${device}" after ${args.duration_min} min`;
      if (dryRun) {
        const steps = [`Register in-process sleep timer: ${desc}`, ...(state?.is_playing ? [`Music keeps playing (${current} on ${device})`] : []), `On expiry: PUT /me/player/pause${target ? `?device_id=${target}` : ''}`];
        return { content: [{ type: 'text', text: describeDryRun('sleep_timer', desc, steps) }], structuredContent: { ok: true, dry_run: true, plan: steps, duration_min: args.duration_min } };
      }
      cancelExhaust2Timer('sleep_timer');
      const ms = args.duration_min * 60_000;
      const timeout = setTimeout(() => {
        activeTimers.delete('sleep_timer');
        void client.put(target ? `/me/player/pause?device_id=${encodeURIComponent(target)}` : '/me/player/pause').catch(() => {});
      }, ms);
      registerTimer('sleep_timer', desc, timeout);
      return emit(fmt, { ok: true, dry_run: false, duration_min: args.duration_min, device_id: target, now_playing: state?.item?.name ?? null, expires_at: new Date(Date.now() + ms).toISOString() }, `Sleep timer set: pausing ${device} in ${args.duration_min} min. Music keeps playing until then. Call sleep_timer again to replace the timer.`);
    },
  );

  // 2. mute (#359) — volume 0 with remembered level
  server.tool(
    'mute',
    'Set volume to 0 while remembering the previous level in the sidecar — one word beats volume_step ×N. unmute restores it. Quota: 🟢 1 read + 1 write.',
    {
      device_id: z.string().optional().describe('Device to mute (defaults to active device)'),
      response_format: ResponseFormat,
      dry_run: DryRun,
    },
    async (args) => {
      const fmt = args.response_format as ResponseFormatValue | undefined;
      const dryRun = args.dry_run ?? true;
      const state = await client.get<PlaybackState>('/me/player');
      if (!state?.device && !args.device_id) {
        return textResult('No active device — pass device_id to mute a specific device (volume memory is per device id).', { ok: false, error: 'no_active_device' });
      }
      const deviceId = args.device_id ?? state?.device?.id ?? null;
      const deviceName = state?.device?.name ?? null;
      const previous = typeof state?.device?.volume_percent === 'number' ? state.device.volume_percent : 50;
      const memoryKey = deviceId ?? 'active';
      if (dryRun) {
        const steps = [`Remember current volume ${previous}% for ${deviceName ?? deviceId ?? 'active device'}`, `PUT /me/player/volume?volume=0${deviceId ? `&device_id=${deviceId}` : ''}`];
        return { content: [{ type: 'text', text: describeDryRun('mute', deviceName ?? deviceId ?? 'active device', steps) }], structuredContent: { ok: true, dry_run: true, plan: steps, previous_volume: previous } };
      }
      const store = await loadExhaust2Store();
      store.muteMemory[memoryKey] = { volume: previous, muted_at: new Date().toISOString(), device_id: deviceId, device_name: deviceName };
      await saveExhaust2Store(store);
      await client.put(`/me/player/volume?${new URLSearchParams({ volume: '0', ...(deviceId ? { device_id: deviceId } : {}) })}`);
      return emit(fmt, { ok: true, dry_run: false, previous_volume: previous, device_id: deviceId, remembered_for: memoryKey }, `Muted ${deviceName ?? deviceId ?? 'active device'} (was ${previous}% — remembered for unmute).`);
    },
  );

  // 3. unmute (#360) — restore remembered level
  server.tool(
    'unmute',
    'Restore the volume level remembered by mute (falls back to 50% if nothing remembered). Quota: 🟢 1 write (sidecar read is local).',
    {
      device_id: z.string().optional().describe('Device to unmute (defaults to the key mute remembered / active device)'),
      response_format: ResponseFormat,
      dry_run: DryRun,
    },
    async (args) => {
      const fmt = args.response_format as ResponseFormatValue | undefined;
      const dryRun = args.dry_run ?? true;
      const store = await loadExhaust2Store();
      let deviceId = args.device_id ?? null;
      let memory = deviceId ? store.muteMemory[deviceId] ?? null : store.muteMemory.active ?? null;
      if (!memory && !deviceId) {
        // No explicit device: fall back to the most recent mute anywhere.
        const entries = Object.values(store.muteMemory).sort((a, b) => b.muted_at.localeCompare(a.muted_at));
        memory = entries[0] ?? null;
        deviceId = memory?.device_id ?? null;
      }
      const volume = memory?.volume ?? 50;
      const source = memory ? 'remembered by mute' : 'no memory — default 50%';
      if (dryRun) {
        const steps = [`PUT /me/player/volume?volume=${volume}${deviceId ? `&device_id=${deviceId}` : ''} (${source})`];
        return { content: [{ type: 'text', text: describeDryRun('unmute', deviceId ?? 'active device', steps) }], structuredContent: { ok: true, dry_run: true, plan: steps, volume, source } };
      }
      await client.put(`/me/player/volume?${new URLSearchParams({ volume: String(volume), ...(deviceId ? { device_id: deviceId } : {}) })}`);
      return emit(fmt, { ok: true, dry_run: false, volume, source, device_id: deviceId }, `Unmuted → volume ${volume}% (${source}).`);
    },
  );

  // 4. switch_device (#361) — fuzzy-name transfer, pure handoff
  server.tool(
    'switch_device',
    'Transfer playback to a device by fuzzy name or sidecar label — pure handoff, no content args (complements play_on which plays content, and handoff which is pos-preserving id-only). Quota: 🟢 1 read + 1 write.',
    {
      device_name: z.string().min(1).describe('Device name substring (case-insensitive), exact id, or sidecar label'),
      play: z.boolean().optional().default(true).describe('true = keep playing on the target (default); false = transfer paused'),
      response_format: ResponseFormat,
      dry_run: DryRun,
    },
    async (args) => {
      const fmt = args.response_format as ResponseFormatValue | undefined;
      const dryRun = args.dry_run ?? true;
      const { deviceId, devices } = await resolveDeviceHint(client, args.device_name as string);
      if (!deviceId) {
        const names = devices.map((d) => d.name).join(', ') || 'no devices';
        return textResult(`No device matches "${args.device_name}". Available: ${names}`, { ok: false, error: 'device_not_found', available: devices.map((d) => ({ id: d.id, name: d.name })) });
      }
      const target = devices.find((d) => d.id === deviceId);
      if (dryRun) {
        const steps = [`PUT /me/player { device_ids: ["${deviceId}"], play: ${args.play ?? true} }`];
        return { content: [{ type: 'text', text: describeDryRun('switch_device', target?.name ?? deviceId, steps) }], structuredContent: { ok: true, dry_run: true, resolved_device_id: deviceId, play: args.play ?? true } };
      }
      await client.put('/me/player', { device_ids: [deviceId], play: args.play ?? true });
      return emit(fmt, { ok: true, dry_run: false, resolved_device_id: deviceId, device_name: target?.name ?? null, play: args.play ?? true }, `Playback transferred → "${target?.name ?? deviceId}" (${args.play ?? true ? 'playing' : 'paused'}).`);
    },
  );

  // 5. surprise_me (#362) — seeded random play
  server.tool(
    'surprise_me',
    '"Surprise me": picks a random saved track, saved album, or owned playlist and plays it. Randomness seedable via seed for reproducible picks. Quota: 🟡 1-3 reads + 1 write (PUT /me/player/play).',
    {
      type: z.enum(['track', 'album', 'playlist', 'any']).optional().default('any').describe('What to surprise you with (default any)'),
      device_id: z.string().optional().describe('Target device id'),
      seed: z.number().optional().describe('Seed for reproducible picks (omit for true randomness)'),
      response_format: ResponseFormat,
      dry_run: DryRun,
    },
    async (args) => {
      const fmt = args.response_format as ResponseFormatValue | undefined;
      const dryRun = args.dry_run ?? true;
      const rng = rngFor(args.seed);
      const chosen = args.type === 'any' ? (['track', 'album', 'playlist'] as const)[Math.floor(rng() * 3)]! : args.type;
      let pickLabel = '';
      let playBody: Record<string, unknown> = {};
      if (chosen === 'track') {
        const head = await client.get<SpotifyPaged<SavedTrackItem>>('/me/tracks', { limit: '1' });
        const total = head?.total ?? 0;
        if (!total) return textResult('No saved tracks to surprise you with.', { ok: false, error: 'empty_library' });
        const offset = Math.floor(rng() * total);
        const page = await client.get<SpotifyPaged<SavedTrackItem>>('/me/tracks', { limit: '50', offset: String(offset) });
        const items = (page?.items ?? []).filter((i) => i.track?.uri);
        if (!items.length) return textResult('No playable saved tracks found at a random offset — try again.', { ok: false });
        const hit = items[Math.floor(rng() * items.length)]!.track!;
        pickLabel = `"${hit.name}" by ${trackArtists(hit).join(', ') || 'unknown'}`;
        playBody = { uris: [hit.uri] };
      } else if (chosen === 'album') {
        const head = await client.get<SpotifyPaged<SavedAlbumItem>>('/me/albums', { limit: '1' });
        const total = head?.total ?? 0;
        if (!total) return textResult('No saved albums to surprise you with.', { ok: false, error: 'empty_library' });
        const offset = Math.floor(rng() * total);
        const page = await client.get<SpotifyPaged<SavedAlbumItem>>('/me/albums', { limit: '50', offset: String(offset) });
        const items = (page?.items ?? []).filter((i) => (i as { album?: { uri?: string; name?: string } }).album?.uri);
        if (!items.length) return textResult('No playable saved albums found at a random offset — try again.', { ok: false });
        const hit = items[Math.floor(rng() * items.length)]! as unknown as { album: { uri: string; name: string; artists?: Array<{ name: string }> } };
        pickLabel = `album "${hit.album.name}" by ${(hit.album.artists ?? []).map((a) => a.name).join(', ') || 'unknown'}`;
        playBody = { context_uri: hit.album.uri };
      } else {
        const me = await client.get<{ id?: string }>('/me');
        const head = await client.get<SpotifyPaged<SpotifyPlaylistSimple>>('/me/playlists', { limit: '1' });
        const total = head?.total ?? 0;
        if (!total) return textResult('No playlists to surprise you with.', { ok: false, error: 'empty_library' });
        const offset = Math.floor(rng() * total);
        const page = await client.get<SpotifyPaged<SpotifyPlaylistSimple>>('/me/playlists', { limit: '50', offset: String(offset) });
        let items = (page?.items ?? []).filter((p): p is SpotifyPlaylistSimple => !!p?.uri);
        const owned = items.filter((p) => p.owner?.id && p.owner.id === me?.id);
        const usedOwned = owned.length > 0;
        if (usedOwned) items = owned;
        if (!items.length) return textResult('No playable playlists found at a random offset — try again.', { ok: false });
        const hit = items[Math.floor(rng() * items.length)]!;
        pickLabel = `${usedOwned ? 'owned ' : ''}playlist "${hit.name}"`;
        playBody = { context_uri: hit.uri };
      }
      const qs = args.device_id ? `?device_id=${encodeURIComponent(args.device_id)}` : '';
      if (dryRun) {
        const steps = [`PUT /me/player/play${qs} ${JSON.stringify(playBody)}`];
        return { content: [{ type: 'text', text: describeDryRun('surprise_me', pickLabel, steps) }], structuredContent: { ok: true, dry_run: true, chosen_type: chosen, pick: pickLabel, play_body: playBody, seed: args.seed ?? null } };
      }
      await client.put(`/me/player/play${qs}`, playBody);
      return emit(fmt, { ok: true, dry_run: false, chosen_type: chosen, pick: pickLabel, seed: args.seed ?? null }, `Surprise: playing ${pickLabel}.`);
    },
  );

  // 6. skip_n (#363) — looped next with honest N-call disclosure
  server.tool(
    'skip_n',
    'Advance N tracks at once via N sequential POST /me/player/next calls. Quota: 🔴 N writes (1-20, one call per skip — Spotify has no batch-skip endpoint).',
    {
      n: z.number().int().min(1).max(20).optional().default(1).describe('How many tracks to skip (1-20)'),
      device_id: z.string().optional().describe('Device to skip on'),
      response_format: ResponseFormat,
      dry_run: DryRun,
    },
    async (args) => {
      const fmt = args.response_format as ResponseFormatValue | undefined;
      const dryRun = args.dry_run ?? true;
      if (dryRun) {
        const steps = [`POST /me/player/next ×${args.n}${args.device_id ? ` (device ${args.device_id})` : ''} — ${args.n} separate API calls, no batch-skip endpoint exists`];
        return { content: [{ type: 'text', text: describeDryRun('skip_n', `next ${args.n} track(s)`, steps) }], structuredContent: { ok: true, dry_run: true, n: args.n, api_calls: args.n } };
      }
      const qs = args.device_id ? `?device_id=${encodeURIComponent(args.device_id)}` : '';
      let skipped = 0;
      const failed: number[] = [];
      for (let i = 0; i < args.n; i++) {
        try { await client.post(`/me/player/next${qs}`); skipped++; } catch { failed.push(i + 1); }
      }
      return emit(fmt, { ok: failed.length === 0, n: args.n, skipped, failed, api_calls: args.n }, `Skipped ${skipped}/${args.n} track(s) via ${args.n} sequential next calls${failed.length ? ` — failed at skip ${failed.join(', ')}` : ''}.`);
    },
  );

  // 7. pause_everywhere (#364) — pause every live Connect device
  server.tool(
    'pause_everywhere',
    'Pause every live Connect device (attempts PUT /me/player/pause per non-restricted device) — kills the "which speaker is still playing" hunt. Quota: 🟡 1 read + N writes (one pause per live device).',
    {
      response_format: ResponseFormat,
      dry_run: DryRun,
    },
    async (args) => {
      const fmt = args.response_format as ResponseFormatValue | undefined;
      const dryRun = args.dry_run ?? true;
      const res = await client.get<GetDevicesResponse>('/me/player/devices');
      const live = (res?.devices ?? []).filter((d) => d.id && !d.is_restricted);
      if (live.length === 0) return textResult('No live Connect devices found to pause.', { ok: true, paused: 0 });
      if (dryRun) {
        const steps = live.map((d) => `PUT /me/player/pause?device_id=${d.id} ("${d.name}")`);
        return { content: [{ type: 'text', text: describeDryRun('pause_everywhere', `${live.length} live device(s)`, steps) }], structuredContent: { ok: true, dry_run: true, targets: live.map((d) => ({ id: d.id, name: d.name })) } };
      }
      let paused = 0;
      const failed: string[] = [];
      for (const d of live) {
        try { await client.put(`/me/player/pause?device_id=${encodeURIComponent(d.id!)}`); paused++; } catch { failed.push(d.name); }
      }
      return emit(fmt, { ok: failed.length === 0, paused, total: live.length, failed }, `Paused ${paused}/${live.length} device(s)${failed.length ? ` — failed: ${failed.join(', ')}` : ''}.`);
    },
  );

  // 8. volume_ramp (#365) — generic stepped ramp, up or down
  server.tool(
    'volume_ramp',
    'Generic volume ramp to a target percent over N minutes (up OR down, step-controlled, optional end-state pause/play) — a superset of schedule_wind_down (which is down-only with floor+pause). Quota: 🟢 stepped PUT /me/player/volume writes (ceil(minutes/step_minutes) calls), in-process, cancel-safe (restart replaces).',
    {
      target_percent: z.number().int().min(0).max(100).describe('Ramp target (0-100)'),
      minutes: z.number().int().min(1).max(120).optional().default(5).describe('Total ramp duration in minutes (default 5)'),
      step_minutes: z.number().int().min(1).max(30).optional().default(1).describe('Minutes between steps (default 1)'),
      end_state: z.enum(['pause', 'play', 'none']).optional().default('none').describe('Applied after the final step (default none)'),
      device_id: z.string().optional().describe('Target device id (defaults to active device)'),
      response_format: ResponseFormat,
      dry_run: DryRun,
    },
    async (args) => {
      const fmt = args.response_format as ResponseFormatValue | undefined;
      const dryRun = args.dry_run ?? true;
      const state = await client.get<PlaybackState>('/me/player');
      const from = typeof state?.device?.volume_percent === 'number' ? state.device.volume_percent : 50;
      const deviceId = args.device_id ?? state?.device?.id ?? null;
      const steps = computeRampPlan(from, args.target_percent, args.minutes, args.step_minutes);
      const desc = `volume ${from}% → ${args.target_percent}% over ${args.minutes} min in ${steps.length} steps, end_state=${args.end_state}`;
      if (dryRun) {
        const lines = steps.map((s) => `  +${s.after_minutes} min → ${s.percent}%`);
        const plan = [`[dry run] ${desc} — nothing was changed.`, ...lines, `  final: end_state=${args.end_state}`].join('\n');
        return { content: [{ type: 'text', text: plan }], structuredContent: { ok: true, dry_run: true, plan: lines, from, to: args.target_percent, steps: steps.length, end_state: args.end_state } };
      }
      cancelExhaust2Timer('volume_ramp');
      const spacing = (args.minutes * 60_000) / steps.length;
      let i = 0;
      const runStep = (): void => {
        i++;
        const step = steps[i - 1]!;
        void client.put(`/me/player/volume?${new URLSearchParams({ volume: String(step.percent), ...(deviceId ? { device_id: deviceId } : {}) })}`).catch(() => {});
        if (i >= steps.length) {
          activeTimers.delete('volume_ramp');
          if (args.end_state === 'pause') void client.put(deviceId ? `/me/player/pause?device_id=${encodeURIComponent(deviceId)}` : '/me/player/pause').catch(() => {});
          if (args.end_state === 'play') void client.put(deviceId ? `/me/player/play?device_id=${encodeURIComponent(deviceId)}` : '/me/player/play').catch(() => {});
        } else {
          const t = setTimeout(runStep, spacing);
          registerTimer('volume_ramp', desc, t);
        }
      };
      const first = setTimeout(runStep, spacing);
      registerTimer('volume_ramp', desc, first);
      return emit(fmt, { ok: true, dry_run: false, from, to: args.target_percent, steps: steps.length, spacing_minutes: Math.round((spacing / 60_000) * 100) / 100, end_state: args.end_state, device_id: deviceId }, `Volume ramp started: ${from}% → ${args.target_percent}% over ${args.minutes} min (${steps.length} steps, end_state=${args.end_state}). Starting a new ramp replaces this one.`);
    },
  );

  // 9. episode_bookmark (#366) — podcast position sidecar
  server.tool(
    'episode_bookmark',
    'Bookmark the current podcast-episode position to the sidecar (title, show, progress, optional note) — where_was_i is audiobooks-only today. Quota: 🟢 1 read (GET /me/player).',
    {
      note: z.string().optional().describe('Optional note to attach to the bookmark'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const fmt = args.response_format as ResponseFormatValue | undefined;
      const state = await client.get<PlaybackState>('/me/player');
      const item = state?.item as (PlaybackState['item'] & { type?: string; show?: { name?: string; id?: string } }) | null;
      if (!item) return textResult('Nothing is currently playing to bookmark.', { ok: false, error: 'no_playback' });
      if (item.type !== 'episode') {
        return textResult(`Current item is a ${item.type ?? 'track'}, not a podcast episode — episode_bookmark only captures episodes (see where_was_i for audiobooks).`, { ok: false, error: 'not_an_episode', item_type: item.type ?? 'unknown' });
      }
      const store = await loadExhaust2Store();
      const id = `ep-${Date.now()}`;
      const bookmark: EpisodeBookmark = {
        id,
        saved_at: new Date().toISOString(),
        note: args.note,
        episode_uri: item.uri,
        episode_name: item.name ?? 'unknown episode',
        show_name: item.show?.name ?? null,
        show_id: item.show?.id ?? null,
        progress_ms: state?.progress_ms ?? 0,
        duration_ms: typeof item.duration_ms === 'number' ? item.duration_ms : null,
        device_id: state?.device?.id ?? null,
      };
      store.episodeBookmarks[id] = bookmark;
      await saveExhaust2Store(store);
      return emit(fmt, { ok: true, bookmark, path: exhaust2PlaybackFile() }, `Bookmarked "${bookmark.episode_name}" (${bookmark.show_name ?? 'unknown show'}) at ${Math.round(bookmark.progress_ms / 1000)}s → ${id}`);
    },
  );

  // 10. episode_resume (#367) — transfer + seek + play to bookmark
  server.tool(
    'episode_resume',
    'Jump straight back to the newest (or a named) episode bookmark: transfer + play with position + seek (2-3 writes). Pairs with episode_bookmark. Quota: 🟡 2-3 writes.',
    {
      bookmark_id: z.string().optional().describe('Bookmark id (default: newest by saved_at)'),
      device_id: z.string().optional().describe('Target device id (defaults to bookmarked device)'),
      response_format: ResponseFormat,
      dry_run: DryRun,
    },
    async (args) => {
      const fmt = args.response_format as ResponseFormatValue | undefined;
      const dryRun = args.dry_run ?? true;
      const store = await loadExhaust2Store();
      const bookmarks = Object.values(store.episodeBookmarks).sort((a, b) => b.saved_at.localeCompare(a.saved_at));
      if (bookmarks.length === 0) return textResult('No episode bookmarks. Use episode_bookmark while an episode is playing.', { ok: false, error: 'no_bookmarks' });
      const bm = args.bookmark_id ? store.episodeBookmarks[args.bookmark_id] : bookmarks[0];
      if (!bm) return textResult(`No episode bookmark "${args.bookmark_id}". Available: ${bookmarks.map((b) => b.id).join(', ')}`, { ok: false, error: 'not_found', available: bookmarks.map((b) => b.id) });
      const deviceId = args.device_id ?? bm.device_id ?? null;
      const qs = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
      if (dryRun) {
        const steps = [
          `PUT /me/player { device_ids: ["${deviceId ?? 'active'}"], play: true } (transfer)`,
          `PUT /me/player/play${qs} { uris: ["${bm.episode_uri}"], position_ms: ${bm.progress_ms} }`,
          `PUT /me/player/seek${qs} position_ms=${bm.progress_ms}`,
        ];
        return { content: [{ type: 'text', text: describeDryRun('episode_resume', `"${bm.episode_name}" @ ${Math.round(bm.progress_ms / 1000)}s`, steps) }], structuredContent: { ok: true, dry_run: true, plan: steps, bookmark: bm.id } };
      }
      const failed: string[] = [];
      // Transfer only when a target device is known — '' would 404.
      if (deviceId) { try { await client.put('/me/player', { device_ids: [deviceId], play: true }); } catch { failed.push('transfer'); } }
      try { await client.put(`/me/player/play${qs}`, { uris: [bm.episode_uri], position_ms: bm.progress_ms }); } catch (e) { failed.push('play'); }
      try { await client.put(`/me/player/seek${qs}${qs ? '&' : '?'}position_ms=${bm.progress_ms}`); } catch (e) { failed.push('seek'); }
      return emit(fmt, { ok: failed.length === 0, bookmark: bm.id, episode: bm.episode_name, progress_ms: bm.progress_ms, device_id: deviceId, failed }, `Resuming "${bm.episode_name}" at ${Math.round(bm.progress_ms / 1000)}s on ${deviceId ?? 'active device'}${failed.length ? ` — failed steps: ${failed.join(', ')}` : ''}.`);
    },
  );

  // 11. queue_next_episode (#368) — next unplayed episode of a show
  server.tool(
    'queue_next_episode',
    'Find the next unplayed episode of a show (not in recently-played and not fully played) within an episodes_back lookahead and queue it — podcast binge glue. Quota: 🟡 2-3 reads + 1 write (POST /me/player/queue).',
    {
      show_id: z.string().min(1).describe('Show ID (or spotify:show: URI)'),
      episodes_back: z.number().int().min(1).max(50).optional().default(10).describe('How many of the newest episodes to look back through (default 10)'),
      device_id: z.string().optional().describe('Target device id for the queue add'),
      response_format: ResponseFormat,
      dry_run: DryRun,
    },
    async (args) => {
      const fmt = args.response_format as ResponseFormatValue | undefined;
      const dryRun = args.dry_run ?? true;
      const showId = args.show_id.startsWith('spotify:show:') ? args.show_id.split(':')[2]! : args.show_id;
      const eps = await client.get<SpotifyPaged<{ id: string; name: string; uri: string; release_date?: string; resume_point?: { fully_played?: boolean } }>>(`/shows/${encodeURIComponent(showId)}/episodes`, { limit: '50' }); // one page covers the whole 1-50 lookahead
      const candidates = (eps?.items ?? []).slice(0, args.episodes_back);
      if (candidates.length === 0) return textResult(`Show "${showId}" has no episodes (or not found).`, { ok: false, error: 'no_episodes' });
      const recent = await walkRecentlyPlayed(client, 2);
      const played = new Set(recent.map((r) => r.track?.uri).filter(Boolean));
      const candidate = candidates.find((e) => !played.has(e.uri) && !e.resume_point?.fully_played);
      if (!candidate) {
        return textResult(`All ${candidates.length} recent episode(s) of "${showId}" are already played or fully played within the ${args.episodes_back}-episode lookahead.`, { ok: false, error: 'all_played', lookahead: args.episodes_back });
      }
      const params = new URLSearchParams({ uri: candidate.uri });
      if (args.device_id) params.set('device_id', args.device_id);
      if (dryRun) {
        const steps = [`POST /me/player/queue?${params.toString()} ("${candidate.name}", ${candidate.release_date ?? 'unknown date'})`];
        return { content: [{ type: 'text', text: describeDryRun('queue_next_episode', candidate.name, steps) }], structuredContent: { ok: true, dry_run: true, candidate: { id: candidate.id, name: candidate.name, uri: candidate.uri }, skipped_played: candidates.filter((e) => played.has(e.uri) || e.resume_point?.fully_played).length } };
      }
      await client.post(`/me/player/queue?${params}`);
      return emit(fmt, { ok: true, candidate: { id: candidate.id, name: candidate.name, uri: candidate.uri }, release_date: candidate.release_date ?? null }, `Queued next unplayed episode: "${candidate.name}" (${candidate.release_date ?? 'unknown date'}).`);
    },
  );

  // 12. queue_replace_via_playlist (#369) — honest no-clear-endpoint workaround
  server.tool(
    'queue_replace_via_playlist',
    'Honest no-clear-endpoint workaround to replace the live queue: snapshot it, optionally filter (drop dupes / keep only given artists), build a playlist, and start it as the playback context — the live queue is replaced via context switch (Spotify has no queue-clear endpoint). Quota: 🟡 1 read + 2-3 writes.',
    {
      keep_artists: z.array(z.string()).optional().describe('When given, keep only tracks by these artists (case-insensitive; episodes are dropped under this filter)'),
      drop_dupes: z.boolean().optional().default(true).describe('Drop repeated URIs from the snapshot (default true)'),
      playlist_name: z.string().optional().describe('Playlist name (default "Queue snapshot <date>")'),
      device_id: z.string().optional().describe('Device to start the new context on'),
      response_format: ResponseFormat,
      dry_run: DryRun,
    },
    async (args) => {
      const fmt = args.response_format as ResponseFormatValue | undefined;
      const dryRun = args.dry_run ?? true;
      const q = await client.get<{ currently_playing?: QueueRow | null; queue?: QueueRow[] }>('/me/player/queue');
      const rows: QueueRow[] = [q?.currently_playing, ...(q?.queue ?? [])].filter((r): r is QueueRow => !!r);
      const snapshot = rows.map((r) => r.uri).filter((u): u is string => !!u);
      const meta = new Map<string, { name: string; artists: string[]; type: string }>();
      rows.forEach((r, i) => { if (snapshot[i]) meta.set(snapshot[i]!, { name: r.name ?? snapshot[i]!, artists: (r.artists ?? []).map((a) => a.name), type: r.type ?? 'track' }); });
      let items = snapshot.slice();
      const snapshotMeta = snapshot.length;
      const keepSet = (args.keep_artists ?? []).map((a) => a.toLowerCase());
      if (args.drop_dupes !== false) {
        const seen = new Set<string>();
        items = items.filter((u) => (seen.has(u) ? false : (seen.add(u), true)));
      }
      if (keepSet.length > 0) {
        items = items.filter((u) => {
          const m = meta.get(u);
          if (!m) return false;
          if (m.type === 'episode') return false;
          return m.artists.some((a) => keepSet.includes(a.toLowerCase()));
        });
      }
      if (snapshotMeta === 0) return textResult('Current queue is empty — nothing to snapshot.', { ok: false, error: 'empty_queue' });
      if (items.length === 0) return textResult('All snapshot items were filtered out — nothing would be queued. Loosen keep_artists / drop_dupes.', { ok: false, error: 'all_filtered' });
      const name = args.playlist_name ?? `Queue snapshot ${new Date().toISOString().slice(0, 10)}`;
      if (dryRun) {
        const steps = [
          `Create playlist "${name}" with ${items.length} item(s)`,
          `POST /playlists/{id}/items with ${items.length} URIs (batched 100)`,
          `PUT /me/player/play${args.device_id ? `?device_id=${args.device_id}` : ''} { context_uri: "spotify:playlist:{id}" }`,
          'Disclosure: the live queue is replaced via context switch — Spotify has no queue-clear endpoint.',
        ];
        return { content: [{ type: 'text', text: describeDryRun('queue_replace_via_playlist', name, steps) }], structuredContent: { ok: true, dry_run: true, plan: steps, snapshot: snapshot.length, after_filters: items.length, playlist_name: name } };
      }
      const pl = await client.post<{ id?: string; uri?: string }>('/me/playlists', { name, description: `Queue snapshot from ${new Date().toISOString()} — ${items.length} items` });
      const plId = pl?.id;
      if (!plId) return textResult('Failed to create the snapshot playlist.', { ok: false, error: 'playlist_create_failed' });
      for (let i = 0; i < items.length; i += 100) {
        await client.post(`/playlists/${encodeURIComponent(plId)}/items`, { uris: items.slice(i, i + 100) });
      }
      const playQs = args.device_id ? `?device_id=${encodeURIComponent(args.device_id)}` : '';
      await client.put(`/me/player/play${playQs}`, { context_uri: pl.uri ?? `spotify:playlist:${plId}` });
      return emit(fmt, { ok: true, snapshot: snapshot.length, kept: items.length, playlist_id: plId, playlist_name: name, disclosure: 'live queue replaced via context switch (no queue-clear endpoint exists)' }, `Queued ${items.length} item(s) (snapshot ${snapshot.length}, after filters) into playlist "${name}" and started it as the context — the live queue is effectively replaced.`);
    },
  );

  // 13. session_stats (#370) — session-size distribution (local compute)
  server.tool(
    'session_stats',
    'Session-size distribution from recently-played via detectSessions (30-min gap): session count, median/mean tracks per session, longest session, avg session length. Quota: 🟢 1-2 reads, local compute.',
    {
      pages: z.number().int().min(1).max(10).optional().default(2).describe('Recently-played pages to walk (default 2, 50 items each)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const fmt = args.response_format as ResponseFormatValue | undefined;
      const items = await walkRecentlyPlayed(client, args.pages ?? 2);
      if (items.length === 0) return textResult('No recently-played items — nothing to summarise.', { ok: true, sessions: 0 });
      const sessions = detectSessions(items.map((i) => ({ played_at: i.played_at, track: { uri: i.track?.uri ?? '' } })));
      const counts = sessions.map((s) => s.tracks.length).sort((a, b) => a - b);
      const median = counts.length % 2 === 1 ? counts[(counts.length - 1) / 2]! : Math.round(((counts[counts.length / 2 - 1]! + counts[counts.length / 2]!) / 2) * 10) / 10;
      const mean = Math.round((counts.reduce((a, b) => a + b, 0) / counts.length) * 10) / 10;
      const longest = sessions.reduce((a, b) => (b.tracks.length > a.tracks.length ? b : a), sessions[0]!);
      const avgLen = Math.round((sessions.reduce((a, s) => a + (new Date(s.end).getTime() - new Date(s.start).getTime()), 0) / sessions.length / 60000) * 10) / 10;
      const echo = {
        ok: true,
        window: { items: items.length, pages: args.pages ?? 2 },
        sessions: {
          count: sessions.length,
          median_tracks: median,
          mean_tracks: mean,
          longest_session: { tracks: longest.tracks.length, start: longest.start, end: longest.end },
          avg_session_length_minutes: avgLen,
        },
      };
      const text = [
        `Session stats over ${items.length} recently-played items (${args.pages ?? 2} page(s)) — ${sessions.length} session(s) at 30-min gap:`,
        `  median tracks/session: ${median} | mean: ${mean} | avg length: ${avgLen} min`,
        `  longest session: ${longest.tracks.length} tracks (${longest.start} → ${longest.end})`,
      ].join('\n');
      return emit(fmt, echo, text);
    },
  );

  // 14. most_replayed (#371) — plays-per-track in the recent window
  server.tool(
    'most_replayed',
    'Most-replayed tracks in the recent window: play counts per track from recently-played, deduped — "on repeat" computed locally (complements window-based listening_report). Quota: 🟢 1-2 reads, local compute.',
    {
      limit: z.number().int().min(1).max(50).optional().default(10).describe('Top N tracks to return (default 10)'),
      pages: z.number().int().min(1).max(10).optional().default(2).describe('Recently-played pages to walk (default 2)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const fmt = args.response_format as ResponseFormatValue | undefined;
      const items = await walkRecentlyPlayed(client, args.pages ?? 2);
      if (items.length === 0) return textResult('No recently-played items — nothing to rank.', { ok: true, entries: 0 });
      const counts = new Map<string, { name: string; artists: string; plays: number; last: string }>();
      for (const row of items) {
        const t = row.track as (SpotifyTrack & { name?: string }) | null;
        if (!t?.uri) continue;
        const prev = counts.get(t.uri);
        counts.set(t.uri, {
          name: t.name ?? t.uri,
          artists: trackArtists(t).join(', ') || 'unknown',
          plays: (prev?.plays ?? 0) + 1,
          last: prev && prev.last > row.played_at ? prev.last : row.played_at,
        });
      }
      const ranked = [...counts.entries()].sort((a, b) => b[1].plays - a[1].plays || a[1].name.localeCompare(b[1].name));
      const t = truncateItems(ranked.map(([uri, v]) => ({ uri, ...v })), args.limit ?? 10);
      const echo = { ok: true, unique_tracks: ranked.length, total_plays: items.length, entries: t.items, truncated: t.truncated };
      const text = [
        `Most-replayed in the recent window (${items.length} plays, ${ranked.length} unique tracks):`,
        ...t.items.map((e, i) => `  ${i + 1}. "${e.name}" — ${e.artists} · ${e.plays} play${e.plays === 1 ? '' : 's'} · last ${e.last}`),
        ...(t.footer ? [`(${t.footer})`] : []),
      ].join('\n');
      return emit(fmt, echo, text);
    },
  );

  // 15. last_heard (#372) — when did you last actually play X?
  server.tool(
    'last_heard',
    'For 1-10 artists: when did you last actually play them (recently-played cursor walk) + the gap — answers "when did I last listen to X?" without guessing. Quota: 🟡 2-10 pages walked (max_pages, disclosed; stops early once all found).',
    {
      artists: z.array(z.string()).min(1).max(10).describe('Artist names to look up (1-10)'),
      max_pages: z.number().int().min(1).max(50).optional().default(10).describe('Max recently-played pages to walk (default 10)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const fmt = args.response_format as ResponseFormatValue | undefined;
      const wanted = (args.artists as string[]).map((a) => a.toLowerCase());
      const found = new Map<string, { last: string; track: string }>();
      const items = await walkRecentlyPlayed(client, args.max_pages ?? 10, (page, all) => {
        for (const row of page) {
          for (const a of trackArtists(row.track)) {
            const key = a.toLowerCase();
            if (wanted.includes(key) && !found.has(key)) found.set(key, { last: row.played_at, track: row.track?.name ?? '' });
          }
        }
        return wanted.every((w) => found.has(w));
      });
      const now = Date.now();
      const results = (args.artists as string[]).map((name) => {
        const hit = found.get(name.toLowerCase());
        return hit
          ? { artist: name, last_played: hit.last, gap: humanGap(now - new Date(hit.last).getTime()), last_track: hit.track, found: true }
          : { artist: name, last_played: null, gap: null, last_track: null, found: false };
      });
      const echo = { ok: true, pages_walked_cap: args.max_pages ?? 10, items_scanned: items.length, results };
      const text = [
        `Last-heard lookup over ${items.length} recently-played item(s) (cap ${args.max_pages ?? 10} pages):`,
        ...results.map((r) => r.found
          ? `  • ${r.artist}: last played ${r.last_played} (${r.gap} ago) — "${r.last_track}"`
          : `  • ${r.artist}: not played in the scanned window`),
      ].join('\n');
      return emit(fmt, echo, text);
    },
  );

  // 16. weekday_heatmap (#373) — weekday × daypart buckets
  server.tool(
    'weekday_heatmap',
    'Plays bucketed by weekday × daypart (morning/afternoon/evening/night) — listening_heatmap is hour-of-day; this adds the weekly dimension. Quota: 🟢 1-2 reads, local compute.',
    {
      pages: z.number().int().min(1).max(10).optional().default(2).describe('Recently-played pages to walk (default 2)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const fmt = args.response_format as ResponseFormatValue | undefined;
      const items = await walkRecentlyPlayed(client, args.pages ?? 2);
      if (items.length === 0) return textResult('No recently-played items — nothing to bucket.', { ok: true, plays: 0 });
      const parts = ['morning', 'afternoon', 'evening', 'night'] as const;
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const grid = new Map<string, number>();
      const partOf = (h: number): (typeof parts)[number] => (h >= 5 && h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 22 ? 'evening' : 'night');
      for (const row of items) {
        const d = new Date(row.played_at);
        const cell = `${days[d.getDay()]} ${partOf(d.getHours())}`;
        grid.set(cell, (grid.get(cell) ?? 0) + 1);
      }
      let busiest = { cell: '', plays: 0 };
      for (const [cell, plays] of grid) if (plays > busiest.plays) busiest = { cell, plays };
      const header = `${'cell'.padEnd(18)}plays`;
      const rows = [...grid.entries()].sort((a, b) => b[1] - a[1]).map(([cell, plays]) => `${cell.padEnd(18)}${plays}`);
      const echo = { ok: true, plays: items.length, grid: Object.fromEntries(grid), busiest };
      const text = [`Weekday × daypart heatmap over ${items.length} plays:`, header, ...rows, '', `Busiest slot: ${busiest.cell} (${busiest.plays} plays).`].join('\n');
      return emit(fmt, echo, text);
    },
  );

  // 17. queue_profile (#374) — composition profile of the current queue
  server.tool(
    'queue_profile',
    'Composition profile of the current queue: unique artists, albums, track-vs-episode mix, longest consecutive block by one artist. Quota: 🟢 1 read (GET /me/player/queue), local compute.',
    { response_format: ResponseFormat },
    async (args) => {
      const fmt = args.response_format as ResponseFormatValue | undefined;
      const q = await client.get<{ currently_playing?: unknown; queue?: Array<Record<string, unknown>> }>('/me/player/queue');
      const rows = [q?.currently_playing, ...(q?.queue ?? [])].filter(Boolean) as Array<Record<string, unknown>>;
      if (rows.length === 0) return textResult('Queue is empty.', { ok: true, total: 0 });
      const artists = new Map<string, number>();
      const albums = new Set<string>();
      const shows = new Set<string>();
      let tracks = 0;
      let episodes = 0;
      for (const r of rows) {
        if (r.type === 'episode') {
          episodes++;
          shows.add((r as { show?: { name?: string } }).show?.name ?? 'unknown show');
        } else {
          tracks++;
          for (const a of trackArtists(r)) artists.set(a, (artists.get(a) ?? 0) + 1);
          const album = (r as { album?: { name?: string } }).album?.name;
          if (album) albums.add(album);
        }
      }
      let blockArtist = '';
      let blockLen = 0;
      let curArtist = '';
      let curLen = 0;
      for (const r of rows) {
        const first = trackArtists(r)[0] ?? '';
        if (first === curArtist) curLen++;
        else { curArtist = first; curLen = 1; }
        if (curLen > blockLen && curArtist) { blockArtist = curArtist; blockLen = curLen; }
      }
      const echo = {
        ok: true,
        total: rows.length,
        tracks,
        episodes,
        unique_artists: artists.size,
        unique_albums: albums.size,
        unique_shows: shows.size,
        longest_artist_block: blockArtist ? { artist: blockArtist, tracks: blockLen } : null,
      };
      const text = [
        `Queue profile (${rows.length} items):`,
        `  mix: ${tracks} track(s) / ${episodes} episode(s)`,
        `  unique artists: ${artists.size} | unique albums: ${albums.size}${shows.size ? ` | unique shows: ${shows.size}` : ''}`,
        blockArtist ? `  longest block by one artist: ${blockArtist} ×${blockLen}` : '  no single-artist block',
      ].join('\n');
      return emit(fmt, echo, text);
    },
  );

  // 18. checkpoint_playback (#375) — auto-named timestamped checkpoint
  server.tool(
    'checkpoint_playback',
    'One-shot timestamped auto-named playback checkpoint (cp-2026-08-27T21:05 style) — saves you naming slots for save_playback_state. Quota: 🟢 1 read + local sidecar write.',
    {
      note: z.string().optional().describe('Optional note to attach'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const fmt = args.response_format as ResponseFormatValue | undefined;
      const state = await client.get<PlaybackState>('/me/player');
      const store = await loadExhaust2Store();
      const iso = new Date().toISOString();
      let id = `cp-${iso.slice(0, 16)}`;
      if (store.checkpoints[id]) id = `cp-${iso.slice(0, 19)}`;
      const cp: Exhaust2Checkpoint = { id, saved_at: iso, note: args.note, playback: state };
      store.checkpoints[id] = cp;
      await saveExhaust2Store(store);
      return emit(fmt, { ok: true, checkpoint: { id, saved_at: iso, note: args.note ?? null, item: state?.item?.name ?? null, progress_ms: state?.progress_ms ?? null }, path: exhaust2PlaybackFile() }, `Checkpoint saved: ${id}${state?.item ? ` (${state.item.name} @ ${state.progress_ms ?? 0}ms)` : ' (no active item)'}${args.note ? ` — ${args.note}` : ''}`);
    },
  );

  // 19. continue_last (#376) — resume newest checkpoint by saved_at
  server.tool(
    'continue_last',
    'Resume the most recent checkpoint without knowing its name (sidecar lookup by saved_at). Pairs with checkpoint_playback. Quota: 🟡 2-3 writes (play + shuffle/repeat best-effort).',
    {
      device_id: z.string().optional().describe('Target device id'),
      response_format: ResponseFormat,
      dry_run: DryRun,
    },
    async (args) => {
      const fmt = args.response_format as ResponseFormatValue | undefined;
      const dryRun = args.dry_run ?? true;
      const store = await loadExhaust2Store();
      const newest = Object.values(store.checkpoints).sort((a, b) => b.saved_at.localeCompare(a.saved_at))[0];
      if (!newest) return textResult('No checkpoints. Use checkpoint_playback first.', { ok: false, error: 'no_checkpoints' });
      const p = newest.playback;
      if (!p?.item?.uri) return textResult(`Checkpoint "${newest.id}" has no playable item to continue.`, { ok: false, error: 'no_item', checkpoint: newest.id });
      const deviceId = args.device_id ?? p.device?.id ?? null;
      const qs = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
      if (dryRun) {
        const steps = [
          `PUT /me/player/play${qs} { uris: ["${p.item.uri}"], position_ms: ${p.progress_ms ?? 0} }`,
          ...(typeof p.shuffle_state === 'boolean' ? [`PUT /me/player/shuffle?state=${p.shuffle_state}`] : []),
          ...(p.repeat_state ? [`PUT /me/player/repeat?state=${p.repeat_state}`] : []),
        ];
        return { content: [{ type: 'text', text: describeDryRun('continue_last', newest.id, steps) }], structuredContent: { ok: true, dry_run: true, plan: steps, checkpoint: newest.id, saved_at: newest.saved_at } };
      }
      const failed: string[] = [];
      try { await client.put(`/me/player/play${qs}`, { uris: [p.item.uri], position_ms: p.progress_ms ?? 0 }); } catch { failed.push('play'); }
      if (typeof p.shuffle_state === 'boolean') { try { await client.put(`/me/player/shuffle?state=${p.shuffle_state}${deviceId ? `&device_id=${encodeURIComponent(deviceId)}` : ''}`); } catch { failed.push('shuffle'); } }
      if (p.repeat_state) { try { await client.put(`/me/player/repeat?state=${p.repeat_state}${deviceId ? `&device_id=${encodeURIComponent(deviceId)}` : ''}`); } catch { failed.push('repeat'); } }
      return emit(fmt, { ok: failed.length === 0, checkpoint: newest.id, saved_at: newest.saved_at, item: p.item.uri, progress_ms: p.progress_ms ?? 0, device_id: deviceId, failed }, `Continuing from checkpoint "${newest.id}" → ${p.item.uri} @ ${p.progress_ms ?? 0}ms${failed.length ? ` — failed: ${failed.join(', ')}` : ''}.`);
    },
  );

  // 20. room_level (#377) — same volume percent on every live device
  server.tool(
    'room_level',
    'Level the room: read the active device volume and apply the same percent to every other live device. Quota: 🟡 1 read + N writes (one volume PUT per target device).',
    {
      exclude_device_id: z.string().optional().describe('Additional device id to leave untouched'),
      response_format: ResponseFormat,
      dry_run: DryRun,
    },
    async (args) => {
      const fmt = args.response_format as ResponseFormatValue | undefined;
      const dryRun = args.dry_run ?? true;
      const res = await client.get<GetDevicesResponse>('/me/player/devices');
      const devices = (res?.devices ?? []).filter((d) => d.id);
      const active = devices.find((d) => d.is_active && typeof d.volume_percent === 'number');
      if (!active) return textResult('No active device reporting a volume — cannot level the room.', { ok: false, error: 'no_active_device' });
      const targets = devices.filter((d) => d.id !== active.id && d.id !== args.exclude_device_id && !d.is_restricted);
      if (targets.length === 0) return textResult('No other live devices to level.', { ok: true, applied: 0 });
      if (dryRun) {
        const steps = targets.map((d) => `PUT /me/player/volume?volume=${active.volume_percent}&device_id=${d.id} ("${d.name}")`);
        return { content: [{ type: 'text', text: describeDryRun('room_level', `${targets.length} device(s) @ ${active.volume_percent}%`, steps) }], structuredContent: { ok: true, dry_run: true, source: { id: active.id, name: active.name, volume: active.volume_percent }, targets: targets.map((d) => ({ id: d.id, name: d.name })) } };
      }
      let applied = 0;
      const failed: string[] = [];
      for (const d of targets) {
        try { await client.put(`/me/player/volume?${new URLSearchParams({ volume: String(active.volume_percent!), device_id: d.id! })}`); applied++; } catch { failed.push(d.name); }
      }
      return emit(fmt, { ok: failed.length === 0, source: { id: active.id, name: active.name, volume: active.volume_percent }, applied, total: targets.length, failed }, `Room levelled: ${applied}/${targets.length} device(s) → ${active.volume_percent}%${failed.length ? ` — failed: ${failed.join(', ')}` : ''}.`);
    },
  );

  // 21. volume_report (#378) — read-only volume snapshot across devices
  server.tool(
    'volume_report',
    'Read-only volume snapshot across all devices, including sidecar presets vs live deltas — "what\'s the volume everywhere right now?". Quota: 🟢 1 read (GET /me/player/devices).',
    { response_format: ResponseFormat },
    async (args) => {
      const fmt = args.response_format as ResponseFormatValue | undefined;
      const res = await client.get<GetDevicesResponse>('/me/player/devices');
      const devices = res?.devices ?? [];
      const store = await loadPlaybackExt();
      const rows = devices.map((d) => {
        const preset = store.devicePresets[d.id ?? ''];
        const live = typeof d.volume_percent === 'number' ? d.volume_percent : null;
        return {
          id: d.id,
          name: d.name,
          type: d.type,
          is_active: !!d.is_active,
          volume_percent: live,
          preset_label: preset?.label ?? null,
          preset_volume: preset?.volume ?? null,
          preset_delta: live !== null && preset?.volume !== undefined ? live - preset.volume : null,
        };
      });
      const echo = { ok: true, devices: rows };
      const text = devices.length === 0
        ? 'No Connect devices visible.'
        : [
            `Volume snapshot across ${devices.length} device(s):`,
            ...rows.map((r) => `  • ${r.name} (${r.type}${r.is_active ? ', active' : ''}): ${r.volume_percent ?? '?'}%${r.preset_label ? ` · preset "${r.preset_label}" = ${r.preset_volume}%${r.preset_delta !== null ? ` (live Δ${r.preset_delta > 0 ? '+' : ''}${r.preset_delta})` : ')'}` : ''}`),
          ].join('\n');
      return emit(fmt, echo, text);
    },
  );

  // 22. daily_pick (#379) — deterministic date-seeded banger of the day
  server.tool(
    'daily_pick',
    'Deterministic "banger of the day": date-seeded pick from recently-played highlights (most-played pool + seeded tiebreak) — same date, same pick. Quota: 🟢 1-2 reads, local compute.',
    {
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD').optional().describe('Seed date (default today, YYYY-MM-DD)'),
      pool_size: z.number().int().min(1).max(50).optional().default(10).describe('Highlight pool size to pick from (default 10)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const fmt = args.response_format as ResponseFormatValue | undefined;
      const date = args.date ?? new Date().toISOString().slice(0, 10);
      const items = await walkRecentlyPlayed(client, 2);
      if (items.length === 0) return textResult('No recently-played items — no pool to pick from.', { ok: true });
      const counts = new Map<string, { name: string; artists: string; plays: number }>();
      for (const row of items) {
        const t = row.track as (SpotifyTrack & { name?: string }) | null;
        if (!t?.uri) continue;
        const prev = counts.get(t.uri);
        counts.set(t.uri, { name: t.name ?? t.uri, artists: trackArtists(t).join(', ') || 'unknown', plays: (prev?.plays ?? 0) + 1 });
      }
      const pool = [...counts.entries()]
        .sort((a, b) => b[1].plays - a[1].plays || a[1].name.localeCompare(b[1].name))
        .slice(0, args.pool_size ?? 10)
        .map(([uri, v]) => ({ uri, ...v }));
      const pick = pool[hashString(date) % pool.length]!;
      const echo = { ok: true, date, pool_size: pool.length, pick, pool };
      const text = [
        `Banger of the day (${date}, deterministic):`,
        `  🎵 "${pick.name}" — ${pick.artists} · ${pick.plays} play${pick.plays === 1 ? '' : 's'} in the recent window`,
        `(picked from a ${pool.length}-track highlight pool via date seed)`,
      ].join('\n');
      return emit(fmt, echo, text);
    },
  );
}
