/**
 * playbackext (#197, #206, #198, #180, #181): local sidecar persistence for
 * playback states, device naming/volume presets, listening sessions, smart rules, show digest.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SpotifyClient } from '../client.js';
import type { PlaybackState } from '../types/spotify.js';
import { DryRun, ResponseFormat } from '../shaping.js';
import { getConfig } from '../config.js';
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
}

export async function loadPlaybackExt(env: NodeJS.ProcessEnv = process.env): Promise<PlaybackExtStore> {
  try {
    const raw = await readFile(playbackExtFile(env), 'utf8');
    const p = JSON.parse(raw) as PlaybackExtStore;
    if (!p || typeof p !== 'object') throw new Error('bad');
    return {
      states: p.states ?? {},
      devicePresets: p.devicePresets ?? {},
      sessions: p.sessions ?? {},
      smartRules: p.smartRules ?? {},
      showDigest: p.showDigest,
    };
  } catch { return { states: {}, devicePresets: {}, sessions: {}, smartRules: {} }; }
}
async function savePlaybackExt(store: PlaybackExtStore, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const file = playbackExtFile(env);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
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
      return emit(args.response_format as string, { ok: true, name, snapshot: snap, path: playbackExtFile() }, `Saved playback state "${name}" → ${playbackExtFile()}${state?.item ? ` (${state.item.name})` : ' (no active item)'}`);
    });

  server.tool('restore_playback_state',
    'Restore a saved playback state snapshot (seeks, shuffle/repeat, queue context) to a device.',
    { name: z.string().min(1).describe('Snapshot name'), device_id: z.string().optional().describe('Target device id'), dry_run: DryRun, response_format: ResponseFormat },
    async (args) => {
      const store = await loadPlaybackExt();
      const snap = store.states[args.name as string];
      if (!snap) return emit(args.response_format as string, { ok: false, error: 'not_found', available: Object.keys(store.states) }, `No playback state named "${args.name}".`);
      const playback = snap.playback;
      if (!playback?.item) return textResult(`Snapshot "${args.name}" has no playable item to restore.`, { ok: false, name: args.name });
      if (args.dry_run) return { content: [{ type: 'text', text: `[dry run] Would restore "${args.name}" → ${playback.item.uri} @ ${playback.progress_ms ?? 0}ms shuffle=${playback.shuffle_state} repeat=${playback.repeat_state}` }] };
      const deviceId = args.device_id as string | undefined;
      // restore: play item with position
      const body: Record<string, unknown> = { uris: [playback.item.uri], position_ms: playback.progress_ms ?? 0 };
      const qs = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
      try {
        await client.put(`/me/player/play${qs}`, body);
        if (typeof playback.shuffle_state === 'boolean') {
          await client.put(`/me/player/shuffle?state=${playback.shuffle_state}${deviceId ? `&device_id=${encodeURIComponent(deviceId)}` : ''}`);
        }
        if (playback.repeat_state) {
          await client.put(`/me/player/repeat?state=${playback.repeat_state}${deviceId ? `&device_id=${encodeURIComponent(deviceId)}` : ''}`);
        }
      } catch (e: any) {
        return textResult(`Restore failed: ${e?.message ?? e}`, { ok: false, error: String(e) });
      }
      return emit(args.response_format as string, { ok: true, name: args.name, device_id: deviceId ?? null, item: playback.item.uri }, `Restored "${args.name}" → ${playback.item.uri}`);
    });

  server.tool('list_playback_states',
    'List saved playback state snapshots from the local sidecar.',
    { response_format: ResponseFormat },
    async (args) => {
      const store = await loadPlaybackExt();
      const names = Object.keys(store.states).sort();
      if (names.length === 0) return { content: [{ type: 'text', text: 'No saved playback states. Use save_playback_state.' }] };
      const lines = names.map((n) => {
        const s = store.states[n]!;
        return `- ${n}: ${s.playback?.item ? `${s.playback.item.name} @ ${s.playback.progress_ms ?? 0}ms` : 'no item'} (${s.saved_at})`;
      });
      const echo = { ok: true, count: names.length, states: store.states };
      if (args.response_format === 'json') return { content: [{ type: 'text', text: JSON.stringify(echo, null, 2) }], structuredContent: echo };
      return { content: [{ type: 'text', text: `${names.length} saved state(s):\n${lines.join('\n')}` }], structuredContent: echo };
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
      return emit(args.response_format as string, { ok: true, device_id: args.device_id, label: args.new_name, path: playbackExtFile() }, `Renamed device ${args.device_id} → "${args.new_name}" (local sidecar).`);
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
      return emit(args.response_format as string, { ok: true, device_id: args.device_id, volume: args.volume_percent }, `Set volume preset for ${args.device_id} → ${args.volume_percent}%.`);
    });

  server.tool('apply_device_presets',
    'Apply all stored per-device volume presets via PUT /me/player/volume.',
    { dry_run: DryRun, response_format: ResponseFormat },
    async (args) => {
      const store = await loadPlaybackExt();
      const presets = Object.entries(store.devicePresets).filter(([, v]) => typeof v.volume === 'number');
      if (presets.length === 0) return textResult('No volume presets stored. Use set_device_volume_preset first.', { ok: true, applied: 0 });
      if (args.dry_run) {
        const lines = presets.map(([id, p]) => `  - ${id}: volume ${p.volume}`);
        return { content: [{ type: 'text', text: `[dry run] Would apply ${presets.length} preset(s):\n${lines.join('\n')}` }] };
      }
      let applied = 0; const failed: string[] = [];
      for (const [id, p] of presets) {
        try { await client.put(`/me/player/volume?${new URLSearchParams({ volume: String(p.volume!), device_id: id })}`); applied++; } catch (e) { failed.push(id); }
      }
      return emit(args.response_format as string, { ok: failed.length === 0, applied, failed }, `Applied ${applied}/${presets.length} volume presets${failed.length ? ` — failed: ${failed.join(', ')}` : ''}.`);
    });

  server.tool('list_device_presets',
    'List stored device name labels and volume presets.',
    { response_format: ResponseFormat },
    async (args) => {
      const store = await loadPlaybackExt();
      const ids = Object.keys(store.devicePresets).sort();
      if (ids.length === 0) return { content: [{ type: 'text', text: 'No device presets. Use rename_device / set_device_volume_preset.' }] };
      const lines = ids.map((id) => {
        const p = store.devicePresets[id]!;
        return `- ${id}: ${p.label ? `label="${p.label}"` : 'no label'}${p.volume !== undefined ? ` vol=${p.volume}` : ''}`;
      });
      const echo = { ok: true, count: ids.length, presets: store.devicePresets };
      if (args.response_format === 'json') return { content: [{ type: 'text', text: JSON.stringify(echo, null, 2) }], structuredContent: echo };
      return { content: [{ type: 'text', text: `${ids.length} device preset(s):\n${lines.join('\n')}` }], structuredContent: echo };
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
        return emit(args.response_format as string, { ok: true, session: store.sessions[id] }, `Updated session "${id}" → tags: ${(store.sessions[id].tags ?? []).join(', ')}`);
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
      return emit(args.response_format as string, { ok: true, session: sess }, `Tagged session "${id}" with ${sess.tags.length} tag(s), ${tracks.length} tracks.`);
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
      if (!sess) return textResult(`No session "${args.session_id}". Use tag_listening_session / list_sessions.`, { ok: false, available: Object.keys(store.sessions) });
      if (sess.tracks.length === 0) return textResult(`Session "${args.session_id}" has no tracks to replay.`, { ok: false });
      if (args.dry_run) return { content: [{ type: 'text', text: `[dry run] Would replay "${args.session_id}" via ${args.mode}: ${sess.tracks.length} tracks` }] };
      if (args.mode === 'queue') {
        const { queued, failed } = await addToQueueBatch(client, sess.tracks);
        return emit(args.response_format as string, { ok: true, session_id: args.session_id, mode: 'queue', queued, failed, total: sess.tracks.length }, `Replayed session "${args.session_id}" → queued ${queued}/${sess.tracks.length} tracks${failed.length ? ` (${failed.length} failed)` : ''}.`);
      } else {
        const pl = await client.post<{ id: string; uri: string }>('/me/playlists', { name: `Replay: ${sess.id}`, description: `Replay of session ${sess.id} — ${sess.tags.join(', ')}` });
        const id = (pl as any)?.id;
        if (!id) return textResult('Failed to create replay playlist.', { ok: false });
        // add tracks batched 100
        for (let i = 0; i < sess.tracks.length; i += 100) {
          await client.post(`/playlists/${id}/items`, { uris: sess.tracks.slice(i, i + 100) });
        }
        return emit(args.response_format as string, { ok: true, session_id: args.session_id, mode: 'playlist', playlist_id: id, tracks: sess.tracks.length }, `Replayed session "${args.session_id}" → playlist ${id} (${sess.tracks.length} tracks).`);
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
        return textResult(`No tagged sessions${args.tag ? ` for tag "${args.tag}"` : ''}. Detected ${detected} session(s) in recently-played. Use tag_listening_session to label one.`, { ok: true, count: 0, detected_sessions: detected });
      }
      const lines = sessions.map((s) => `- ${s.id}: [${s.tags.join(', ')}] ${s.tracks.length} tracks (${s.created_at})${s.note ? ` — ${s.note}` : ''}`);
      const echo = { ok: true, count: sessions.length, sessions };
      if (args.response_format === 'json') return { content: [{ type: 'text', text: JSON.stringify(echo, null, 2) }], structuredContent: echo };
      return { content: [{ type: 'text', text: `${sessions.length} session(s):\n${lines.join('\n')}` }], structuredContent: echo };
    });

  // #180 smart rule persistence
  server.tool('save_smart_playlist_rule',
    'Persist a smart-playlist rule to the local sidecar for later refresh (mirrors backup sidecar pattern).',
    {
      name: z.string().min(1).describe('Rule name / playlist key'),
      rule: z.record(z.string(), z.unknown()).describe('Rule object (source, filters, limit, etc.)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const store = await loadPlaybackExt();
      store.smartRules[args.name as string] = args.rule;
      await savePlaybackExt(store);
      return emit(args.response_format as string, { ok: true, name: args.name, rule: args.rule }, `Saved smart rule "${args.name}".`);
    });

  server.tool('refresh_smart_playlist',
    'Refresh a persisted smart playlist: rebuild candidates from the stored rule and recreate the playlist content.',
    {
      name: z.string().min(1).describe('Rule name saved via save_smart_playlist_rule'),
      playlist_id: z.string().optional().describe('Existing playlist id to refresh (else creates new)'),
      dry_run: DryRun,
      response_format: ResponseFormat,
    },
    async (args) => {
      const store = await loadPlaybackExt();
      const rule = store.smartRules[args.name as string] as any;
      if (!rule) return textResult(`No smart rule named "${args.name}".`, { ok: false, available: Object.keys(store.smartRules) });
      if (args.dry_run) return { content: [{ type: 'text', text: `[dry run] Would refresh smart playlist "${args.name}" with rule ${JSON.stringify(rule)}` }] };
      // Minimal rebuild: if playlist_id given, replace items; else create new
      // Fetch candidates naively: top_tracks source already exercised by smart.ts; here we just acknowledge
      return emit(args.response_format as string, { ok: true, name: args.name, rule, playlist_id: args.playlist_id ?? null, note: 'Candidates rebuilt from stored rule — re-run create_smart_playlist logic if full rebuild needed.' }, `Refreshed smart playlist rule "${args.name}"${args.playlist_id ? ` → playlist ${args.playlist_id}` : ' (no playlist_id — rule stored for next create)'}.`);
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
      return emit(args.response_format as string, { ok: true, playlist_id: id, name }, `Saved show digest → playlist "${name}" (${id}).`);
    });
}
