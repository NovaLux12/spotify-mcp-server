/**
 * playbackext (#197, #206, #198, #180, #181): local sidecar persistence for
 * playback states, device naming/volume presets, listening sessions, smart rules, show digest.
 *
 * #839 — a sidecar that cannot be read is never silently reset. ENOENT is the
 * only condition that yields an empty store; every other read failure and every
 * unparseable file is preserved under `<file>.corrupt-<ts>` and reported as
 * `load_error` on the store, so the mutating tools owe the caller a warning
 * rather than a quiet wipe of their snapshots, presets and rules.
 */
import { z } from 'zod';
import { capFor } from '../chunk.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { copyFile, link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SpotifyClient } from '../client.js';
import type {
  PlaybackState,
  RecentlyPlayedItem,
  SavedTrackItem,
  SpotifyPaged,
  SpotifyTrack,
} from '../types/spotify.js';
import { DryRun, ResponseFormat } from '../shaping.js';
import { getConfig } from '../config.js';
import { matchesArtistFilter, uniqueByArtist } from './smart.js';
import { addToQueueBatch } from './queueops.js';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown> };
function textResult(text: string, structured?: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text }], ...(structured ? { structuredContent: structured } : {}) };
}
function emit(fmt: string | undefined, echo: Record<string, unknown>, text: string): ToolResult {
  if (fmt === 'json') return { content: [{ type: 'text', text: JSON.stringify(echo, null, 2) }], structuredContent: echo };
  return { content: [{ type: 'text', text }], structuredContent: echo };
}

export function playbackExtFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.SPOTIFY_MCP_PLAYBACKEXT_FILE ?? join(homedir(), '.spotify-mcp', 'playback-ext.json');
}
export interface PlaybackSnapshot {
  name: string;
  saved_at: string;
  playback: PlaybackState | null;
  note?: string;
}
export interface DevicePreset { label?: string; volume?: number }
export interface ListeningSession { id: string; tags: string[]; created_at: string; tracks: string[]; note?: string }
export interface PlaybackExtStore {
  states: Record<string, PlaybackSnapshot>;
  devicePresets: Record<string, DevicePreset>;
  sessions: Record<string, ListeningSession>;
  smartRules: Record<string, unknown>;
  showDigest?: { playlist_id?: string; last_saved?: string };
  /**
   * #839: set when the file existed but could not be turned into a store. The
   * bytes were moved aside first, so a later write loses nothing — but the
   * caller must be told, because the store it holds is empty for a reason.
   */
  load_error?: string;
  /** Where the original bytes were preserved; null when even that failed. */
  preserved_as?: string | null;
}

/** A fresh, empty store. Every call gets its own maps; callers mutate them. */
function emptyPlaybackExtStore(): PlaybackExtStore {
  return { states: {}, devicePresets: {}, sessions: {}, smartRules: {} };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Move an unusable sidecar to `<file>.corrupt-<ts>` so its bytes survive the
 * store reset that follows (#839). `link` is used rather than `rename` because
 * rename() overwrites an existing target on POSIX: a copy made moments earlier
 * by a second corruption would be clobbered. Returns the path the bytes now
 * live at, or null when they could not be moved (in which case the caller must
 * say the file is still in place rather than imply it is gone).
 */
async function preserveUnreadableSidecar(file: string): Promise<string | null> {
  for (let n = 0; n < 50; n++) {
    const target = `${file}.corrupt-${Date.now()}${n === 0 ? '' : `-${n + 1}`}`;
    try {
      await link(file, target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') continue; // an earlier copy owns this name
      if (code === 'ENOENT') return null; // the file went away under us
      if (code === 'EPERM' || code === 'ENOSYS' || code === 'EMLINK' || code === 'EXDEV') {
        // No hardlinks here (or a cross-device move): copy without clobbering.
        try {
          await copyFile(file, target, FS.COPYFILE_EXCL);
        } catch (copyErr) {
          const copyCode = (copyErr as NodeJS.ErrnoException).code;
          if (copyCode === 'EEXIST') continue;
          return null;
        }
      } else {
        return null;
      }
    }
    // The copy exists; drop the original so the next save starts clean. A
    // failed unlink is survivable — the copy already holds every byte.
    await unlink(file).catch(() => undefined);
    return target;
  }
  return null;
}

/** Build the empty store plus the #839 disclosure for a file we cannot use. */
async function unreadableStore(file: string, reason: string): Promise<PlaybackExtStore> {
  const preservedAs = await preserveUnreadableSidecar(file);
  return {
    ...emptyPlaybackExtStore(),
    load_error: preservedAs
      ? `${file} was unreadable (${reason}) and has been preserved as ${preservedAs}; it was not loaded.`
      : `${file} was unreadable (${reason}) and could not be moved aside, so it is still in place; it was not loaded.`,
    preserved_as: preservedAs,
  };
}

export async function loadPlaybackExt(env: NodeJS.ProcessEnv = process.env): Promise<PlaybackExtStore> {
  const file = playbackExtFile(env);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    // A file that was never written is genuinely empty. A file we could not
    // read is not: the bytes may all still be there, so it is never coerced.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyPlaybackExtStore();
    return unreadableStore(file, (err as NodeJS.ErrnoException).code ?? 'read failed');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return unreadableStore(file, err instanceof Error ? err.message : 'invalid JSON');
  }
  if (!isPlainObject(parsed)) return unreadableStore(file, 'top level is not a JSON object');
  // A collection field of the wrong type would make `store.states[x] = y`
  // throw on a write, so the file is unusable as a whole rather than partly.
  for (const key of ['states', 'devicePresets', 'sessions', 'smartRules'] as const) {
    if (parsed[key] !== undefined && !isPlainObject(parsed[key])) {
      return unreadableStore(file, `"${key}" is not a JSON object`);
    }
  }
  return {
    states: (parsed.states ?? {}) as Record<string, PlaybackSnapshot>,
    devicePresets: (parsed.devicePresets ?? {}) as Record<string, DevicePreset>,
    sessions: (parsed.sessions ?? {}) as Record<string, ListeningSession>,
    smartRules: (parsed.smartRules ?? {}) as Record<string, unknown>,
    showDigest: isPlainObject(parsed.showDigest) ? (parsed.showDigest as { playlist_id?: string; last_saved?: string }) : undefined,
  };
}

/**
 * #839: the one way these tools answer. When the store was reset because its
 * file was unreadable, the warning is carried in both the prose and
 * structuredContent — never in one alone, so neither a human nor a host
 * reading the JSON can miss it.
 */
function respond(fmt: string | undefined, store: PlaybackExtStore, echo: Record<string, unknown>, text: string): ToolResult {
  if (!store.load_error) return emit(fmt, echo, text);
  const disclosed = { ...echo, load_error: store.load_error, preserved_as: store.preserved_as ?? null };
  if (fmt === 'json') {
    return { content: [{ type: 'text', text: JSON.stringify(disclosed, null, 2) }], structuredContent: disclosed };
  }
  return { content: [{ type: 'text', text: `WARNING: ${store.load_error}\n${text}` }], structuredContent: disclosed };
}

async function savePlaybackExt(store: PlaybackExtStore, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const file = playbackExtFile(env);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  // `load_error` is a report about this call, not store content: persisting it
  // would make the next load claim a corruption that has already been resolved.
  const { load_error: _loadError, preserved_as: _preservedAs, ...persisted } = store;
  await writeFile(file, `${JSON.stringify(persisted, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

// sessions auto-detect helper exported for tests
export function detectSessions(items: Array<{ played_at: string; track: { uri: string } }>): Array<{ tracks: string[]; start: string; end: string }> {
  const GAP = 30 * 60 * 1000;
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => new Date(a.played_at).getTime() - new Date(b.played_at).getTime());
  const sessions: Array<{ tracks: string[]; start: string; end: string }> = [];
  let cur: string[] = [sorted[0].track.uri];
  let start = sorted[0].played_at;
  let prev = new Date(sorted[0].played_at).getTime();
  for (let i = 1; i < sorted.length; i++) {
    const t = new Date(sorted[i].played_at).getTime();
    if (t - prev > GAP) {
      sessions.push({ tracks: [...cur], start, end: sorted[i - 1].played_at });
      cur = [];
      start = sorted[i].played_at;
    }
    cur.push(sorted[i].track.uri);
    prev = t;
  }
  sessions.push({ tracks: cur, start, end: sorted[sorted.length - 1].played_at });
  return sessions;
}

// ---------------------------------------------------------------------------
// #834 smart-rule resolution — refresh_smart_playlist used to make no API call
// at all and still answered `ok: true`. The rule contract is the one
// create_smart_playlist already implements; the stored rule is normalised into
// it, resolved to candidate URIs, and turned into a plan that the execute path
// replays verbatim (plan/execute parity, a5-handoff-plan-execute-parity).
// ---------------------------------------------------------------------------
const SMART_SOURCES = ['top_tracks', 'recently_played', 'saved_tracks'] as const;
type SmartSource = (typeof SMART_SOURCES)[number];

/** The rule object save_smart_playlist_rule persists and refresh_smart_playlist rebuilds from. */
export interface SmartPlaylistRule {
  source: SmartSource;
  time_range: 'short_term' | 'medium_term' | 'long_term';
  limit: number;
  artist_filter: string[];
  unique_artists: boolean;
  scan_cap: number;
  description: string | null;
  public: boolean;
  /** Set by the first refresh so later refreshes replace instead of recreating. */
  playlist_id?: string;
  last_refreshed?: string;
  last_refreshed_tracks?: number;
}

/** Coerce an arbitrary persisted rule record into the supported rule contract. */
export function normalizeSmartRule(raw: unknown, defaultScanCap: number): SmartPlaylistRule {
  const r = (raw ?? {}) as Record<string, unknown>;
  const source = SMART_SOURCES.includes(r.source as SmartSource) ? (r.source as SmartSource) : 'top_tracks';
  const timeRange = r.time_range;
  const limitRaw = Number(r.limit);
  const scanCapRaw = Number(r.scan_cap);
  return {
    source,
    time_range: timeRange === 'short_term' || timeRange === 'long_term' || timeRange === 'medium_term' ? timeRange : 'medium_term',
    limit: Number.isFinite(limitRaw) ? Math.min(500, Math.max(1, Math.trunc(limitRaw))) : 30,
    artist_filter: Array.isArray(r.artist_filter) ? (r.artist_filter as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    unique_artists: r.unique_artists === true,
    scan_cap: Number.isFinite(scanCapRaw) ? Math.min(10000, Math.max(1, Math.trunc(scanCapRaw))) : defaultScanCap,
    description: typeof r.description === 'string' ? r.description : null,
    public: r.public === true,
    ...(typeof r.playlist_id === 'string' && r.playlist_id ? { playlist_id: r.playlist_id } : {}),
  };
}

export interface SmartResolution {
  uris: string[];
  candidates_scanned: number;
  truncated_at_scan_cap: boolean;
}

/** Resolve a rule to the candidate URIs a rebuild would write, in playlist order. */
async function resolveRuleCandidates(client: SpotifyClient, rule: SmartPlaylistRule): Promise<SmartResolution> {
  let pool: SpotifyTrack[];
  let truncatedAtCap = false;
  if (rule.source === 'recently_played') {
    const res = await client.get<{ items?: RecentlyPlayedItem[] }>('/me/player/recently-played', { limit: '50' });
    pool = (res?.items ?? []).map((i) => i?.track).filter((t): t is SpotifyTrack => Boolean(t?.uri));
  } else if (rule.source === 'saved_tracks') {
    const saved = await client.getAllPages<SavedTrackItem>('/me/tracks', { limit: '50' }, { maxItems: rule.scan_cap });
    pool = saved.map((entry) => entry?.track).filter((t): t is SpotifyTrack => Boolean(t?.uri));
    truncatedAtCap = pool.length >= rule.scan_cap;
  } else {
    const page1 = await client.get<SpotifyPaged<SpotifyTrack>>('/me/top/tracks', { limit: '50', offset: '0', time_range: rule.time_range });
    const page2 = await client.get<SpotifyPaged<SpotifyTrack>>('/me/top/tracks', { limit: '50', offset: '50', time_range: rule.time_range });
    pool = [...(page1?.items ?? []), ...(page2?.items ?? [])].filter((t) => t?.uri);
  }
  const candidatesScanned = pool.length;
  // Dedupe by URI keeping first occurrence (recently-played repeats), then the
  // same artist filters create_smart_playlist applies, in the same order.
  const seen = new Set<string>();
  let candidates = pool.filter((t) => (seen.has(t.uri) ? false : (seen.add(t.uri), true)));
  if (rule.artist_filter.length > 0) candidates = candidates.filter((t) => matchesArtistFilter(t, rule.artist_filter));
  if (rule.unique_artists) candidates = uniqueByArtist(candidates);
  return { uris: candidates.slice(0, rule.limit).map((t) => t.uri), candidates_scanned: candidatesScanned, truncated_at_scan_cap: truncatedAtCap };
}

interface RefreshStep { method: 'PUT' | 'POST'; path: string; uris: number }

/**
 * The write calls a refresh performs, derived from the resolved URIs alone.
 * The dry run renders exactly this list and the execute path replays it, so a
 * plan can never promise a call the commit does not make.
 */
function planRefresh(playlistId: string | null, uris: string[]): RefreshStep[] {
  const steps: RefreshStep[] = [];
  if (!playlistId) steps.push({ method: 'POST', path: '/me/playlists', uris: 0 });
  const target = playlistId ?? '<new playlist id>';
  const itemsPath = `/playlists/${target}/items`;
  // PUT /playlists/{id}/items replaces the whole playlist and caps at
  // CHUNK_CAPS.playlist_writes uris; anything beyond that is appended in
  // POST chunks of the same cap.
  const writeCap = capFor('playlist_writes');
  steps.push({ method: playlistId ? 'PUT' : 'POST', path: itemsPath, uris: Math.min(uris.length, writeCap) });
  for (let start = writeCap; start < uris.length; start += writeCap) {
    steps.push({ method: 'POST', path: itemsPath, uris: Math.min(uris.length - start, writeCap) });
  }
  return steps;
}

export function registerPlaybackExtTools(server: McpServer, client: SpotifyClient): void {
  // save_playback_state
  server.tool('save_playback_state',
    'Snapshot current playback state to a named local slot (sidecar JSON).',
    { name: z.string().min(1).optional().describe('Slot name (default: timestamp)'), response_format: ResponseFormat },
    async (args) => {
      const state = await client.get<PlaybackState>('/me/player');
      const store = await loadPlaybackExt();
      const name = (args.name as string) ?? `state-${Date.now()}`;
      const snap: PlaybackSnapshot = { name, saved_at: new Date().toISOString(), playback: state };
      store.states[name] = snap;
      await savePlaybackExt(store);
      return respond(args.response_format as string, store, { ok: true, name, snapshot: snap, path: playbackExtFile() }, `Saved playback state "${name}" → ${playbackExtFile()}${state?.item ? ` (${state.item.name})` : ' (no active item)'}`);
    });

  server.tool('restore_playback_state',
    'Restore a saved playback state snapshot: replays the saved item at its offset inside the saved context (album/playlist) when one was captured, then shuffle/repeat, then verifies via GET /me/player (verified:false if the device is elsewhere).',
    { name: z.string().min(1).describe('Snapshot name'), device_id: z.string().optional().describe('Target device id'), dry_run: DryRun, response_format: ResponseFormat },
    async (args) => {
      const fmt = args.response_format as string;
      const store = await loadPlaybackExt();
      const snap = store.states[args.name as string];
      if (!snap) return respond(fmt, store, { ok: false, error: 'not_found', available: Object.keys(store.states) }, `No playback state named "${args.name}".`);
      const playback = snap.playback;
      if (!playback?.item) return respond(fmt, store, { ok: false, error: 'no_playable_item', name: args.name }, `Snapshot "${args.name}" has no playable item to restore.`);
      const deviceId = args.device_id as string | undefined;
      const itemUri = playback.item.uri;
      // #833: the snapshot's context is the queue the item was playing inside.
      const contextUri = playback.context?.uri ?? null;
      const positionMs = playback.progress_ms ?? 0;
      const qs = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
      const suffix = deviceId ? `&device_id=${encodeURIComponent(deviceId)}` : '';
      // Same body shape the playback-bookmark resume path uses: replay the
      // context with the saved item as the offset so the surrounding queue (and
      // what plays next) comes back. Ad-hoc single-track sessions captured no
      // context and fall back to uris[].
      const contextBody: Record<string, unknown> = { context_uri: contextUri, offset: { uri: itemUri }, position_ms: positionMs };
      const singleBody: Record<string, unknown> = { uris: [itemUri], position_ms: positionMs };
      const plan = [
        contextUri
          ? `PUT /me/player/play${qs} { context_uri: ${contextUri}, offset: { uri: ${itemUri} }, position_ms: ${positionMs} }`
          : `PUT /me/player/play${qs} { uris: [${itemUri}], position_ms: ${positionMs} }`,
        ...(typeof playback.shuffle_state === 'boolean' ? [`PUT /me/player/shuffle?state=${playback.shuffle_state}${suffix}`] : []),
        ...(playback.repeat_state ? [`PUT /me/player/repeat?state=${playback.repeat_state}${suffix}`] : []),
        `GET /me/player${qs} — verify the restored item`,
      ];
      if (args.dry_run) {
        return respond(fmt, store, { ok: true, dry_run: true, name: args.name, plan, item: itemUri, context_uri: contextUri, position_ms: positionMs },
          `[dry run] Would restore "${args.name}" → ${contextUri ? `context ${contextUri} at ${itemUri}` : itemUri} @ ${positionMs}ms shuffle=${playback.shuffle_state} repeat=${playback.repeat_state}\n${plan.map((s) => `  ${s}`).join('\n')}`);
      }
      let usedSingleTrackFallback = false;
      try {
        try {
          await client.put(`/me/player/play${qs}`, contextUri ? contextBody : singleBody);
        } catch (e) {
          if (!contextUri) throw e;
          // The offset was rejected (e.g. the track left that context) — retry
          // once as an ad-hoc single-track context instead of failing outright.
          usedSingleTrackFallback = true;
          await client.put(`/me/player/play${qs}`, singleBody);
        }
        if (typeof playback.shuffle_state === 'boolean') {
          await client.put(`/me/player/shuffle?state=${playback.shuffle_state}${suffix}`);
        }
        if (playback.repeat_state) {
          await client.put(`/me/player/repeat?state=${playback.repeat_state}${suffix}`);
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return respond(fmt, store, { ok: false, error: message, name: args.name }, `Restore failed: ${message}`);
      }
      // Read the player back: a write that returns 2xx is not proof the device
      // actually landed on the saved item.
      const observed = await client.get<PlaybackState>('/me/player', deviceId ? { device_id: deviceId } : undefined).catch(() => null);
      const observedItem = observed?.item?.uri ?? null;
      const observedContext = observed?.context?.uri ?? null;
      const itemMatch = observedItem === itemUri;
      const contextMatch = contextUri !== null && observedContext === contextUri;
      const verified = itemMatch || contextMatch;
      const echo = {
        ok: verified,
        verified,
        name: args.name,
        device_id: deviceId ?? null,
        item: itemUri,
        context_uri: contextUri,
        position_ms: positionMs,
        context_fallback: usedSingleTrackFallback,
        observed_item: observedItem,
        observed_context: observedContext,
      };
      return respond(fmt, store, echo, verified
        ? `Restored "${args.name}" → ${contextUri && !itemMatch ? `${contextUri} @ ${itemUri}` : itemUri}${usedSingleTrackFallback ? ' (context offset rejected — played as a single track)' : ''}`
        : `Restore issued for "${args.name}" but the device reports ${observedItem ? `"${observedItem}"` : 'nothing playing'} — not the saved ${itemUri}.`);
    });

  server.tool('list_playback_states',
    'List saved playback state snapshots from the local sidecar.',
    { response_format: ResponseFormat },
    async (args) => {
      const store = await loadPlaybackExt();
      const names = Object.keys(store.states).sort();
      if (names.length === 0) return respond(args.response_format as string, store, { ok: true, count: 0, states: {} }, 'No saved playback states. Use save_playback_state.');
      const lines = names.map((n) => {
        const s = store.states[n]!;
        return `- ${n}: ${s.playback?.item ? `${s.playback.item.name} @ ${s.playback.progress_ms ?? 0}ms` : 'no item'} (${s.saved_at})`;
      });
      const echo = { ok: true, count: names.length, states: store.states };
      if (args.response_format === 'json') return respond('json', store, echo, '');
      return respond(args.response_format as string, store, echo, `${names.length} saved state(s):\n${lines.join('\n')}`);
    });

  // device naming + presets
  server.tool('rename_device',
    'Rename a device locally (sidecar label — Spotify has no rename endpoint).',
    { device_id: z.string().min(1).describe('Device id'), new_name: z.string().min(1).describe('Friendly label'), response_format: ResponseFormat },
    async (args) => {
      const store = await loadPlaybackExt();
      const entry = store.devicePresets[args.device_id as string] ?? {};
      entry.label = args.new_name as string;
      store.devicePresets[args.device_id as string] = entry;
      await savePlaybackExt(store);
      return respond(args.response_format as string, store, { ok: true, device_id: args.device_id, label: args.new_name, path: playbackExtFile() }, `Renamed device ${args.device_id} → "${args.new_name}" (local sidecar).`);
    });

  server.tool('set_device_volume_preset',
    'Store a per-device volume preset (0–100) in the local sidecar.',
    { device_id: z.string().min(1).describe('Device id'), volume_percent: z.number().int().min(0).max(100).describe('Volume 0–100'), response_format: ResponseFormat },
    async (args) => {
      const store = await loadPlaybackExt();
      const entry = store.devicePresets[args.device_id as string] ?? {};
      entry.volume = args.volume_percent as number;
      store.devicePresets[args.device_id as string] = entry;
      await savePlaybackExt(store);
      return respond(args.response_format as string, store, { ok: true, device_id: args.device_id, volume: args.volume_percent }, `Set volume preset for ${args.device_id} → ${args.volume_percent}%.`);
    });

  server.tool('apply_device_presets',
    'Apply all stored per-device volume presets via PUT /me/player/volume.',
    { dry_run: DryRun, response_format: ResponseFormat },
    async (args) => {
      const store = await loadPlaybackExt();
      const presets = Object.entries(store.devicePresets).filter(([, v]) => typeof v.volume === 'number');
      if (presets.length === 0) return respond(args.response_format as string, store, { ok: true, applied: 0 }, 'No volume presets stored. Use set_device_volume_preset first.');
      if (args.dry_run) {
        const lines = presets.map(([id, p]) => `  - ${id}: volume ${p.volume}`);
        return respond(args.response_format as string, store, { ok: true, dry_run: true, applied: 0, presets: presets.length }, `[dry run] Would apply ${presets.length} preset(s):\n${lines.join('\n')}`);
      }
      let applied = 0; const failed: string[] = [];
      for (const [id, p] of presets) {
        try { await client.put(`/me/player/volume?${new URLSearchParams({ volume_percent: String(p.volume!), device_id: id })}`); applied++; } catch (e) { failed.push(id); }
      }
      return respond(args.response_format as string, store, { ok: failed.length === 0, applied, failed }, `Applied ${applied}/${presets.length} volume presets${failed.length ? ` — failed: ${failed.join(', ')}` : ''}.`);
    });

  server.tool('list_device_presets',
    'List stored device name labels and volume presets.',
    { response_format: ResponseFormat },
    async (args) => {
      const store = await loadPlaybackExt();
      const ids = Object.keys(store.devicePresets).sort();
      if (ids.length === 0) return respond(args.response_format as string, store, { ok: true, count: 0, presets: {} }, 'No device presets. Use rename_device / set_device_volume_preset.');
      const lines = ids.map((id) => {
        const p = store.devicePresets[id]!;
        return `- ${id}: ${p.label ? `label="${p.label}"` : 'no label'}${p.volume !== undefined ? ` vol=${p.volume}` : ''}`;
      });
      const echo = { ok: true, count: ids.length, presets: store.devicePresets };
      if (args.response_format === 'json') return respond('json', store, echo, '');
      return respond(args.response_format as string, store, echo, `${ids.length} device preset(s):\n${lines.join('\n')}`);
    });

  // listening sessions
  server.tool('tag_listening_session',
    'Tag a listening session (auto-detected 30-min gaps from recently-played) with labels.',
    { session_id: z.string().min(1).describe('Session id (or new label to create)'), tags: z.array(z.string()).optional().describe('Tags to attach'), note: z.string().optional().describe('Optional note'), response_format: ResponseFormat },
    async (args) => {
      const store = await loadPlaybackExt();
      // If session exists, update tags; else create by fetching recently-played to materialise
      const id = args.session_id as string;
      if (store.sessions[id]) {
        if (args.tags) store.sessions[id].tags = args.tags as string[];
        if (args.note !== undefined) store.sessions[id].note = args.note as string;
        await savePlaybackExt(store);
        return respond(args.response_format as string, store, { ok: true, session: store.sessions[id] }, `Updated session "${id}" → tags: ${(store.sessions[id].tags ?? []).join(', ')}`);
      }
      // Create new session from recently-played (auto-detect)
      const recent = await client.get<{ items: Array<{ played_at: string; track: { uri: string } }> }>('/me/player/recently-played', { limit: '50' });
      const raw = recent?.items ?? [];
      const detected = detectSessions(raw as any);
      // Use the most recent detected session as the template
      const latest = detected[detected.length - 1];
      const tracks = latest ? latest.tracks : raw.slice(0, 20).map((r) => r.track.uri);
      const sess: ListeningSession = { id, tags: (args.tags as string[]) ?? [], created_at: new Date().toISOString(), tracks, note: args.note as string | undefined };
      store.sessions[id] = sess;
      await savePlaybackExt(store);
      return respond(args.response_format as string, store, { ok: true, session: sess }, `Tagged session "${id}" with ${sess.tags.length} tag(s), ${tracks.length} tracks.`);
    });

  server.tool('replay_session',
    'Replay a tagged listening session: queue its tracks or create a playlist.',
    {
      session_id: z.string().min(1).describe('Session id'),
      mode: z.enum(['queue', 'playlist']).default('queue').describe('Replay via queue or new playlist'),
      dry_run: DryRun,
      response_format: ResponseFormat,
    },
    async (args) => {
      const store = await loadPlaybackExt();
      const sess = store.sessions[args.session_id as string];
      if (!sess) return respond(args.response_format as string, store, { ok: false, error: 'not_found', available: Object.keys(store.sessions) }, `No session "${args.session_id}". Use tag_listening_session / list_sessions.`);
      if (sess.tracks.length === 0) return respond(args.response_format as string, store, { ok: false, error: 'empty_session', session_id: args.session_id }, `Session "${args.session_id}" has no tracks to replay.`);
      if (args.dry_run) return respond(args.response_format as string, store, { ok: true, dry_run: true, session_id: args.session_id, mode: args.mode, total: sess.tracks.length }, `[dry run] Would replay "${args.session_id}" via ${args.mode}: ${sess.tracks.length} tracks`);
      if (args.mode === 'queue') {
        const { queued, failed } = await addToQueueBatch(client, sess.tracks);
        return respond(args.response_format as string, store, { ok: true, session_id: args.session_id, mode: 'queue', queued, failed, total: sess.tracks.length }, `Replayed session "${args.session_id}" → queued ${queued}/${sess.tracks.length} tracks${failed.length ? ` (${failed.length} failed)` : ''}.`);
      } else {
        const pl = await client.post<{ id: string; uri: string }>('/me/playlists', { name: `Replay: ${sess.id}`, description: `Replay of session ${sess.id} — ${sess.tags.join(', ')}` });
        const id = (pl as any)?.id;
        if (!id) return respond(args.response_format as string, store, { ok: false, error: 'create_failed', session_id: args.session_id }, 'Failed to create replay playlist.');
        // add tracks in CHUNK_CAPS.playlist_writes batches
        const writeCap = capFor('playlist_writes');
        for (let i = 0; i < sess.tracks.length; i += writeCap) {
          await client.post(`/playlists/${id}/items`, { uris: sess.tracks.slice(i, i + writeCap) });
        }
        return respond(args.response_format as string, store, { ok: true, session_id: args.session_id, mode: 'playlist', playlist_id: id, tracks: sess.tracks.length }, `Replayed session "${args.session_id}" → playlist ${id} (${sess.tracks.length} tracks).`);
      }
    });

  server.tool('list_sessions',
    'List tagged listening sessions (optionally filter by tag). Auto-detect mode can also scan recently-played gaps.',
    { tag: z.string().optional().describe('Filter by tag'), response_format: ResponseFormat },
    async (args) => {
      const store = await loadPlaybackExt();
      let sessions = Object.values(store.sessions).sort((a, b) => b.created_at.localeCompare(a.created_at));
      if (args.tag) sessions = sessions.filter((s) => s.tags.includes(args.tag as string));
      if (sessions.length === 0) {
        // best-effort auto-detect preview
        const recent = await client.get<{ items: Array<{ played_at: string; track: { uri: string; name: string } }> }>('/me/player/recently-played', { limit: '50' });
        const detected = recent?.items ? detectSessions(recent.items as any).length : 0;
        return respond(args.response_format as string, store, { ok: true, count: 0, detected_sessions: detected }, `No tagged sessions${args.tag ? ` for tag "${args.tag}"` : ''}. Detected ${detected} session(s) in recently-played. Use tag_listening_session to label one.`);
      }
      const lines = sessions.map((s) => `- ${s.id}: [${s.tags.join(', ')}] ${s.tracks.length} tracks (${s.created_at})${s.note ? ` — ${s.note}` : ''}`);
      const echo = { ok: true, count: sessions.length, sessions };
      if (args.response_format === 'json') return respond('json', store, echo, '');
      return respond(args.response_format as string, store, echo, `${sessions.length} session(s):\n${lines.join('\n')}`);
    });

  // #180 smart rule persistence
  server.tool('save_smart_playlist_rule',
    'Persist a smart-playlist rule to the local sidecar so refresh_smart_playlist can rebuild the playlist later.',
    {
      name: z.string().min(1).describe('Rule name / playlist key'),
      rule: z.record(z.string(), z.unknown()).describe('Rule object: { source: top_tracks|recently_played|saved_tracks, time_range: short_term|medium_term|long_term, limit (1-500), artist_filter: string[], unique_artists: bool, scan_cap, description, public } — defaults as create_smart_playlist, unknown keys ignored. A refresh records playlist_id/last_refreshed here.'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const store = await loadPlaybackExt();
      store.smartRules[args.name as string] = args.rule;
      await savePlaybackExt(store);
      return respond(args.response_format as string, store, { ok: true, name: args.name, rule: args.rule }, `Saved smart rule "${args.name}".`);
    });

  server.tool('refresh_smart_playlist',
    'Rebuild a playlist from its persisted rule: resolve candidates, then replace the contents (PUT /playlists/{id}/items), creating the playlist on the first refresh. A non-dry-run refresh always writes. The playlist id is stored back on the rule so later refreshes replace it.',
    {
      name: z.string().min(1).describe('Rule name saved via save_smart_playlist_rule'),
      playlist_id: z.string().optional().describe('Playlist id to rebuild in place. Defaults to the id recorded by the previous refresh; otherwise the playlist is created.'),
      dry_run: DryRun,
      response_format: ResponseFormat,
    },
    async (args) => {
      const fmt = args.response_format as string;
      const name = args.name as string;
      const store = await loadPlaybackExt();
      const stored = store.smartRules[name] as Record<string, unknown> | undefined;
      if (!stored) return respond(fmt, store, { ok: false, error: 'not_found', available: Object.keys(store.smartRules) }, `No smart rule named "${name}".`);

      // Same resolution for plan and commit: one code path builds both.
      const rule = normalizeSmartRule(stored, getConfig().fetchAllCap);
      const resolved = await resolveRuleCandidates(client, rule);
      const { uris, candidates_scanned, truncated_at_scan_cap } = resolved;
      if (uris.length === 0) {
        return respond(fmt, store, { ok: false, error: 'no_candidates', name, rule, candidates_scanned, playlist_id: rule.playlist_id ?? null },
          `Rule "${name}" matched 0 candidate tracks — nothing was created or changed. Loosen artist_filter or widen source/time_range.`);
      }

      const targetId = (args.playlist_id as string | undefined) ?? rule.playlist_id ?? null;
      const steps = planRefresh(targetId, uris);
      const planLines = steps.map((s) => `  ${s.method} ${s.path}${s.uris ? ` — ${s.uris} uri(s)` : ''}`);
      if (args.dry_run) {
        return respond(fmt, store, {
          ok: true, dry_run: true, name, rule, playlist_id: targetId,
          would_create: targetId === null, selected: uris.length,
          candidates_scanned, truncated_at_scan_cap, plan: steps, uris,
        }, `[dry run] Would refresh smart playlist "${name}" (${uris.length} track(s) from ${rule.source}${truncated_at_scan_cap ? `, pool truncated at scan_cap=${rule.scan_cap}` : ''}):\n${planLines.join('\n')}`);
      }

      let playlistId = targetId;
      if (!playlistId) {
        const created = await client.post<{ id: string; uri: string }>('/me/playlists', {
          name,
          public: rule.public,
          ...(rule.description ? { description: rule.description } : {}),
        });
        if (!created?.id) return respond(fmt, store, { ok: false, error: 'create_failed', name, rule }, `Rule "${name}" resolved ${uris.length} track(s) but Spotify did not return a playlist id — nothing was created.`);
        playlistId = created.id;
      }
      const itemsPath = `/playlists/${encodeURIComponent(playlistId)}/items`;
      // PUT replaces the whole playlist (max CHUNK_CAPS.playlist_writes uris);
      // the rest is appended in chunks of the same cap.
      const writeCap = capFor('playlist_writes');
      await client.put(itemsPath, { uris: uris.slice(0, writeCap) });
      for (let start = writeCap; start < uris.length; start += writeCap) {
        await client.post(itemsPath, { uris: uris.slice(start, start + writeCap) });
      }

      const refreshedAt = new Date().toISOString();
      store.smartRules[name] = { ...stored, playlist_id: playlistId, last_refreshed: refreshedAt, last_refreshed_tracks: uris.length };
      await savePlaybackExt(store);
      return respond(fmt, store, {
        ok: true, name, playlist_id: playlistId, created: targetId === null,
        tracks: uris.length, batches_sent: steps.length - (targetId === null ? 1 : 0),
        candidates_scanned, truncated_at_scan_cap, source: rule.source,
        last_refreshed: refreshedAt, calls: steps, uris,
      }, `Refreshed smart playlist "${name}" → ${targetId === null ? 'created' : 'rebuilt'} playlist ${playlistId} with ${uris.length} track(s) from ${rule.source} (${steps.length} write call(s)).`);
    });

  // #181 show radar digest
  server.tool('save_show_digest',
    'Create or update a digest playlist from the latest show_new_episodes radar (auto-save helper).',
    {
      playlist_name: z.string().min(1).optional().describe('Digest playlist name (default: Show Digest)'),
      dry_run: DryRun,
      response_format: ResponseFormat,
    },
    async (args) => {
      const showRadarModule = await import('./showradar.js').catch(() => null);
      // fallback: just create an empty digest playlist signalling intent
      if (args.dry_run) return { content: [{ type: 'text', text: `[dry run] Would save show digest → playlist "${(args.playlist_name as string) ?? 'Show Digest'}"` }] };
      const name = (args.playlist_name as string) ?? 'Show Digest';
      const store = await loadPlaybackExt();
      // create playlist
      const pl = await client.post<{ id: string; uri: string }>('/me/playlists', { name, description: 'Auto-saved show radar digest' });
      const id = (pl as any)?.id ?? 'unknown';
      store.showDigest = { playlist_id: id, last_saved: new Date().toISOString() };
      await savePlaybackExt(store);
      return respond(args.response_format as string, store, { ok: true, playlist_id: id, name }, `Saved show digest → playlist "${name}" (${id}).`);
    });
}
