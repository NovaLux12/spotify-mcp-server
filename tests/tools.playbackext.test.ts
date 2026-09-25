import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPlaybackExtTools, detectSessions } from '../src/tools/playbackext.js';
import type { SpotifyClient } from '../src/client.js';

function makeClient(overrides: Partial<Record<string, any>> = {}) {
  const puts: string[] = []; const posts: string[] = [];
  const client = {
    async get(path: string) {
      if (path === '/me/player') return overrides.playback ?? { is_playing: true, progress_ms: 1000, shuffle_state: false, repeat_state: 'off', item: { uri: 'spotify:track:t1', name: 'T1', type: 'track' }, device: { volume_percent: 42 } };
      if (path === '/me/player/recently-played') return { items: overrides.recent ?? [] };
      return null;
    },
    async put(path: string) { puts.push(path); if (overrides.failPut?.(path)) throw new Error('volume write rejected'); return null; },
    async post(path: string) { posts.push(path); return { id: 'pl1', uri: 'spotify:playlist:pl1' } as any; },
    async getAllPages() { return []; },
  };
  return { client: client as unknown as SpotifyClient, puts, posts };
}
function serverHarness(client: SpotifyClient) {
  const registered: any[] = [];
  const s = { tool(n: string, _d: string, sch: any, h: any) { registered.push({ name: n, schema: sch, handler: h }); } } as unknown as McpServer;
  registerPlaybackExtTools(s, client);
  const invoke = async (name: string, args: any) => {
    const t = registered.find((r: any) => r.name === name); assert.ok(t, name);
    const parsed = z.object(t.schema).parse(args); return t.handler(parsed);
  };
  return { registered, invoke };
}

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pbext-')); process.env.SPOTIFY_MCP_PLAYBACKEXT_FILE = join(dir, 'playback-ext.json'); });
afterEach(async () => { delete process.env.SPOTIFY_MCP_PLAYBACKEXT_FILE; await rm(dir, { recursive: true, force: true }); });

describe('playbackext', () => {
  it('registers 13+ tools', () => {
    const { client } = makeClient(); const h = serverHarness(client);
    assert.ok(h.registered.length >= 12);
  });
  it('save + list + restore playback state', async () => {
    const { client, puts } = makeClient({ playback: { is_playing: true, progress_ms: 5000, shuffle_state: true, repeat_state: 'context', item: { uri: 'spotify:track:abc', name: 'Abc', type: 'track' } } });
    const h = serverHarness(client);
    const saved = await h.invoke('save_playback_state', { name: 'evening' });
    assert.match(saved.content[0].text, /Saved/);
    const listed = await h.invoke('list_playback_states', {});
    assert.match(listed.content[0].text, /evening/);
    const restored = await h.invoke('restore_playback_state', { name: 'evening' });
    assert.match(restored.content[0].text, /Restored/);
    assert.ok(puts.some((p) => p.includes('/me/player/play')));
  });
  it('device presets round-trip', async () => {
    const { client } = makeClient(); const h = serverHarness(client);
    await h.invoke('rename_device', { device_id: 'dev1', new_name: 'Kitchen' });
    await h.invoke('set_device_volume_preset', { device_id: 'dev1', volume_percent: 42 });
    const listed = await h.invoke('list_device_presets', {});
    assert.match(listed.content[0].text, /Kitchen|dev1/);
    const dry = await h.invoke('apply_device_presets', { dry_run: true });
    assert.match(dry.content[0].text, /Would apply|dry run/i);
    const applied = await h.invoke('apply_device_presets', {});
    assert.match(applied.content[0].text, /Applied/);
  });
  // #830: Spotify declares volume_percent as the required query parameter; the
  // `volume` spelling is silently rejected, so every preset write was a no-op.
  it('apply_device_presets writes volume_percent, not volume', async () => {
    const { client, puts } = makeClient(); const h = serverHarness(client);
    await h.invoke('set_device_volume_preset', { device_id: 'dev1', volume_percent: 42 });
    await h.invoke('set_device_volume_preset', { device_id: 'dev2', volume_percent: 7 });
    await h.invoke('apply_device_presets', {});
    const vol = puts.filter((p) => p.startsWith('/me/player/volume'));
    assert.equal(vol.length, 2, JSON.stringify(puts));
    const parsed = vol.map((p) => new URLSearchParams(p.split('?')[1]));
    assert.deepEqual(parsed.map((q) => q.get('volume_percent'))!.sort(), ['42', '7']);
    for (const q of parsed) {
      assert.equal(q.get('volume'), null, 'Spotify does not accept `volume`');
      assert.ok(q.get('device_id'));
    }
  });
  it('apply_device_presets reports ok:false when a write is rejected', async () => {
    const { client } = makeClient({ failPut: (p: string) => p.startsWith('/me/player/volume') });
    const h = serverHarness(client);
    await h.invoke('set_device_volume_preset', { device_id: 'dev1', volume_percent: 42 });
    const out = await h.invoke('apply_device_presets', {});
    const sc = out.structuredContent as Record<string, unknown>;
    assert.equal(sc.ok, false, 'a rejected preset write must not report success');
    assert.equal(sc.applied, 0);
    assert.deepEqual(sc.failed, ['dev1']);
    assert.match(out.content[0].text, /failed: dev1/);
  });
  it('listening sessions tag/list/replay queue', async () => {
    const recent = [
      { played_at: new Date(Date.now() - 100000).toISOString(), track: { uri: 'spotify:track:t1', name: 'T1' } },
      { played_at: new Date().toISOString(), track: { uri: 'spotify:track:t2', name: 'T2' } },
    ];
    const { client } = makeClient({ recent });
    const h = serverHarness(client);
    await h.invoke('tag_listening_session', { session_id: 'gym', tags: ['gym'] });
    const listed = await h.invoke('list_sessions', {});
    assert.match(listed.content[0].text, /gym/);
    const replay = await h.invoke('replay_session', { session_id: 'gym', mode: 'queue' });
    assert.match(replay.content[0].text, /queued|Replayed/i);
  });
  it('detectSessions splits on 30-min gap', () => {
    const now = Date.now();
    const items = [
      { played_at: new Date(now - 2 * 60 * 60000).toISOString(), track: { uri: 'spotify:track:a' } },
      { played_at: new Date(now - 90 * 60000).toISOString(), track: { uri: 'spotify:track:b' } },
      { played_at: new Date(now).toISOString(), track: { uri: 'spotify:track:c' } },
    ];
    const sessions = detectSessions(items as any);
    assert.equal(sessions.length, 2);
  });
  it('smart rule save + refresh + show digest dry_run', async () => {
    const { client } = makeClient(); const h = serverHarness(client);
    await h.invoke('save_smart_playlist_rule', { name: 'rock-top', rule: { source: 'top_tracks' } });
    const refreshed = await h.invoke('refresh_smart_playlist', { name: 'rock-top', dry_run: true });
    assert.match(refreshed.content[0].text, /dry run/i);
    const digest = await h.invoke('save_show_digest', { dry_run: true });
    assert.match(digest.content[0].text, /dry run/i);
  });
});
