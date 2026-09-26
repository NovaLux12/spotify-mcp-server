import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdir, readFile as readFileRaw, writeFile as writeFileRaw } from 'node:fs/promises';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPlaybackExtTools, detectSessions, loadPlaybackExt } from '../src/tools/playbackext.js';
import type { SpotifyClient } from '../src/client.js';

function makeClient(overrides: Partial<Record<string, any>> = {}) {
  const puts: string[] = []; const posts: string[] = [];
  const putCalls: Array<{ path: string; body: unknown }> = [];
  const postCalls: Array<{ path: string; body: unknown }> = [];
  let wrote = false;
  // Mirror the real paged walks so the verdict the tool reports is the one
  // the walk actually produced — not a canned constant (#1092).
  const saved = overrides.saved ?? [];
  const client = {
    async get(path: string, params?: Record<string, string>) {
      if (path === '/me/player') {
        // After a write the device may be reporting something else entirely —
        // that is what the restore verification read is for.
        if (wrote && overrides.playbackAfterWrite) return overrides.playbackAfterWrite;
        return overrides.playback ?? { is_playing: true, progress_ms: 1000, shuffle_state: false, repeat_state: 'off', item: { uri: 'spotify:track:t1', name: 'T1', type: 'track' }, device: { volume_percent: 42 } };
      }
      if (path === '/me/player/recently-played') {
        // The endpoint caps a page at 50; one call is all this tool reads.
        const limit = Number(params?.limit ?? 50);
        const recent = overrides.recent ?? [];
        return {
          items: recent
            .slice(0, limit)
            .map((t: unknown) => ({
              track: t,
              played_at: '2026-08-26T10:00:00Z',
              context: null,
            })),
          cursors: { after: '2026-08-26T10:00:00.000Z', before: '2026-08-26T09:00:00.000Z' },
        };
      }
      if (path === '/me/top/tracks') {
        const offset = Number(params?.offset ?? 0);
        const limit = Number(params?.limit ?? 50);
        const top = overrides.topTracks ?? [];
        return { items: top.slice(offset, offset + limit), total: top.length, limit, offset };
      }
      return null;
    },
    async put(path: string, body?: unknown) { puts.push(path); putCalls.push({ path, body }); wrote = true; if (overrides.failPut?.(path)) throw new Error('write rejected'); return null; },
    async post(path: string, body?: unknown) { posts.push(path); postCalls.push({ path, body }); wrote = true; return { id: 'pl1', uri: 'spotify:playlist:pl1' }; },
    async getAllPages() { return saved; },
    async getAllPagesWithTruncation<T>(path: string, _params?: Record<string, string>, opts?: { maxItems?: number }) {
      if (path !== '/me/tracks') return { items: [] as T[], truncated: false, truncatedByCap: false, reportedTotal: null };
      const maxItems = opts?.maxItems ?? 500;
      // /me/tracks items are { added_at, track }; the loader unwraps entry.track.
      // Library fits in one page below the cap; goes over otherwise.
      const wrapped = saved.slice(0, maxItems + 1).map((t) => ({ added_at: '2026-01-01T00:00:00Z', track: t }));
      return {
        items: wrapped.slice(0, maxItems) as T[],
        truncated: saved.length > maxItems,
        truncatedByCap: saved.length > maxItems,
        reportedTotal: saved.length,
      };
    },
  };
  return { client: client as unknown as SpotifyClient, puts, posts, putCalls, postCalls };
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
  // #667: the old `it('registers 13+ tools')` / `length >= 12` pair could not
  // fail — the title promised a floor of 13, the bound allowed 12, so losing
  // one registration entirely still passed. Pin the exact set: a dropped tool
  // is a silent feature loss and an added one is drift.
  it('registers exactly the 13 playback-extension tools', () => {
    const { client } = makeClient(); const h = serverHarness(client);
    assert.deepEqual(
      h.registered.map((r: { name: string }) => r.name).sort(),
      [
        'apply_device_presets',
        'list_device_presets',
        'list_playback_states',
        'list_sessions',
        'refresh_smart_playlist',
        'rename_device',
        'replay_session',
        'restore_playback_state',
        'save_playback_state',
        'save_show_digest',
        'save_smart_playlist_rule',
        'set_device_volume_preset',
        'tag_listening_session',
      ],
      'playback-extension tool surface drifted (added or dropped a registration)',
    );
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
  // #667: `/Kitchen|dev1/` was satisfied by either half alone — a row that
  // printed the device id but lost the label passed, which is the exact
  // half-broken state rename_device exists to prevent. Assert the whole row.
  it('device presets round-trip', async () => {
    const { client, puts } = makeClient(); const h = serverHarness(client);
    await h.invoke('rename_device', { device_id: 'dev1', new_name: 'Kitchen' });
    await h.invoke('set_device_volume_preset', { device_id: 'dev1', volume_percent: 42 });
    const listed = await h.invoke('list_device_presets', {});
    assert.equal(
      listed.content[0].text,
      '1 device preset(s):\n- dev1: label="Kitchen" vol=42',
      'list_device_presets must report dev1 carrying both its label and its volume',
    );
    const dry = await h.invoke('apply_device_presets', { dry_run: true });
    assert.equal(
      dry.content[0].text,
      '[dry run] Would apply 1 preset(s):\n  - dev1: volume 42',
      'a dry run must name the device and the volume it would write',
    );
    assert.equal(puts.length, 0, 'a dry run must not reach the API');
    const applied = await h.invoke('apply_device_presets', {});
    assert.equal(applied.content[0].text, 'Applied 1/1 volume presets.');
    assert.deepEqual(puts, ['/me/player/volume?volume_percent=42&device_id=dev1']);
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
  it('smart rule save + show digest dry_run', async () => {
    const { client } = makeClient(); const h = serverHarness(client);
    await h.invoke('save_smart_playlist_rule', { name: 'rock-top', rule: { source: 'top_tracks' } });
    const digest = await h.invoke('save_show_digest', { dry_run: true });
    assert.match(digest.content[0].text, /dry run/i);
  });
  // #834: refresh_smart_playlist answered `ok: true` without a single API call,
// so a saved rule never rebuilt anything. Every non-dry-run refresh must
// write to /playlists, and the second refresh must replace the playlist the
// first one created rather than creating another.
//
// #1092: top_tracks source caps at 100 (#809). The pool is read under that
// ceiling and a refresh that asks for more than 100 still only PUTs 100 — a
// floor, not a complete scan. The library still needs `limit > pool_cap` to
// exercise the path that picks everything in the pool without truncation
// being the reason the playlist is shorter.
it('refresh_smart_playlist rebuilds the playlist and reuses the id', async () => {
  const topTracks = Array.from({ length: 150 }, (_, i) => ({ uri: `spotify:track:s${i}`, name: `S${i}`, artists: [{ name: `A${i}` }] }));
  const { client, putCalls, postCalls } = makeClient({ topTracks });
  const h = serverHarness(client);
  await h.invoke('save_smart_playlist_rule', { name: 'rock-top', rule: { source: 'top_tracks', limit: 200 } });

  const planned = await h.invoke('refresh_smart_playlist', { name: 'rock-top', dry_run: true });
  assert.match(planned.content[0].text, /dry run/i);
  assert.equal(putCalls.length + postCalls.length, 0, 'a dry run must not write');

  const first = await h.invoke('refresh_smart_playlist', { name: 'rock-top' });
  const firstEcho = first.structuredContent as Record<string, unknown>;
  assert.equal(firstEcho.ok, true);
  assert.equal(firstEcho.playlist_id, 'pl1');
  assert.deepEqual(postCalls[0], { path: '/me/playlists', body: { name: 'rock-top', public: false } });
  // top_tracks pool caps at 100; the playlist hits that ceiling and PUTs the
  // whole pool in one call. There is nothing left to append.
  assert.deepEqual(putCalls.map((c) => c.path), ['/playlists/pl1/items']);
  assert.deepEqual(postCalls.slice(1), [], 'no follow-up POSTs when the pool fits in one write cap');
  assert.equal((putCalls[0].body as { uris: string[] }).uris.length, 100);

  const before = postCalls.length;
  const second = await h.invoke('refresh_smart_playlist', { name: 'rock-top' });
  const secondEcho = second.structuredContent as Record<string, unknown>;
    assert.equal(secondEcho.playlist_id, 'pl1');
    assert.equal(secondEcho.created, false);
    assert.equal(postCalls.filter((c) => c.path === '/me/playlists').length, 1, 'the second refresh must not create a second playlist');
    assert.equal(putCalls.length, 2, `expected one replace per refresh, got ${JSON.stringify(putCalls.map((c) => c.path))} (posts before: ${before})`);
  });

  // #1092: refresh_smart_playlist used to duplicate the smart-playlist pool
  // loader and disclose none of its ceilings. The fix collapses the two onto
  // a single loadCandidates, so every source reports the same pool_capped /
  // pool_cap fields create_smart_playlist does — on the dry run and on commit.
  describe('refresh_smart_playlist pool ceilings (#1092)', () => {
    const pool = (out: { structuredContent?: Record<string, unknown> }) =>
      out.structuredContent as {
        pool_capped: boolean;
        pool_cap: number;
        candidates_scanned: number;
        truncated_at_scan_cap: boolean;
        uris: string[];
      };
    const many = (n: number, p: string) =>
      Array.from({ length: n }, (_, i) => ({ uri: `spotify:track:${p}${i}`, name: `S${i}`, artists: [{ name: `A${i}` }] }));

    it('names the top_tracks ceiling (100) when both pages come back full', async () => {
      const { client } = makeClient({ topTracks: many(150, 't') });
      const h = serverHarness(client);
      await h.invoke('save_smart_playlist_rule', { name: 'r1', rule: { source: 'top_tracks', limit: 200 } });
      const out = await h.invoke('refresh_smart_playlist', { name: 'r1', dry_run: true });
      const p = pool(out);
      assert.equal(p.pool_capped, true);
      assert.equal(p.pool_cap, 100);
      assert.equal(p.candidates_scanned, 100);
      assert.match(out.content[0].text, /ceiling of 100/);
    });

    it('reports the recently_played page ceiling (50) instead of implying a full scan', async () => {
      const { client } = makeClient({ recent: many(150, 'r') });
      const h = serverHarness(client);
      await h.invoke('save_smart_playlist_rule', { name: 'r2', rule: { source: 'recently_played', limit: 80 } });
      const out = await h.invoke('refresh_smart_playlist', { name: 'r2', dry_run: true });
      const p = pool(out);
      assert.equal(p.pool_capped, true);
      assert.equal(p.pool_cap, 50);
      assert.equal(p.candidates_scanned, 50);
      assert.match(out.content[0].text, /ceiling of 50/);
    });

    it('does not claim a ceiling when top_tracks ran out on its own', async () => {
      const { client } = makeClient({ topTracks: many(12, 't') });
      const h = serverHarness(client);
      await h.invoke('save_smart_playlist_rule', { name: 'r3', rule: { source: 'top_tracks' } });
      const out = await h.invoke('refresh_smart_playlist', { name: 'r3', dry_run: true });
      const p = pool(out);
      assert.equal(p.pool_capped, false);
      assert.equal(p.pool_cap, 100);
      assert.equal(p.candidates_scanned, 12);
      assert.doesNotMatch(out.content[0].text, /ceiling of/);
    });

    it('a saved library that ends exactly at scan_cap is not called truncated', async () => {
      const saved = many(500, 's');
      const { client } = makeClient({ saved });
      const h = serverHarness(client);
      await h.invoke('save_smart_playlist_rule', { name: 'r4', rule: { source: 'saved_tracks', scan_cap: 500, limit: 500 } });
      const out = await h.invoke('refresh_smart_playlist', { name: 'r4', dry_run: true });
      const p = pool(out);
      assert.equal(p.pool_capped, false);
      assert.equal(p.pool_cap, 500);
      assert.equal(p.truncated_at_scan_cap, false);
      assert.doesNotMatch(out.content[0].text, /ceiling of/);
    });

    it('a saved library past scan_cap reports the truncation', async () => {
      const saved = many(900, 's');
      const { client } = makeClient({ saved });
      const h = serverHarness(client);
      await h.invoke('save_smart_playlist_rule', { name: 'r5', rule: { source: 'saved_tracks', scan_cap: 500, limit: 500 } });
      const out = await h.invoke('refresh_smart_playlist', { name: 'r5', dry_run: true });
      const p = pool(out);
      assert.equal(p.pool_capped, true);
      assert.equal(p.pool_cap, 500);
      assert.equal(p.truncated_at_scan_cap, true);
      assert.match(out.content[0].text, /ceiling of 500/);
    });

    it('reports the same pool numbers on the commit path as on the dry run', async () => {
      const { client } = makeClient({ topTracks: many(150, 't') });
      const h = serverHarness(client);
      await h.invoke('save_smart_playlist_rule', { name: 'r6', rule: { source: 'top_tracks', limit: 200 } });
      const dry = await h.invoke('refresh_smart_playlist', { name: 'r6', dry_run: true });
      const commit = await h.invoke('refresh_smart_playlist', { name: 'r6' });
      const d = pool(dry);
      const c = pool(commit);
      assert.equal(c.candidates_scanned, d.candidates_scanned);
      assert.equal(c.pool_capped, d.pool_capped);
      assert.equal(c.pool_cap, d.pool_cap);
      assert.equal(c.truncated_at_scan_cap, d.truncated_at_scan_cap);
      assert.match(commit.content[0].text, /ceiling of 100/);
    });

    it('the saved_tracks truncation comes from getAllPagesWithTruncation, not a row-count lie', async () => {
      // A library that ends exactly at scan_cap must not be reported truncated
      // — re-deriving the verdict from row count (#864) was the bug the smart
      // side fixed; this asserts the collapsed loader does not regress it.
      const saved = many(500, 's');
      const { client } = makeClient({ saved });
      const h = serverHarness(client);
      await h.invoke('save_smart_playlist_rule', { name: 'r7', rule: { source: 'saved_tracks', scan_cap: 500, limit: 500 } });
      const dry = await h.invoke('refresh_smart_playlist', { name: 'r7', dry_run: true });
      assert.equal(pool(dry).truncated_at_scan_cap, false);
      assert.equal(pool(dry).pool_capped, false);
    });

    it('the empty-pools path still discloses the ceiling it was taken under', async () => {
      const { client } = makeClient({ topTracks: [] });
      const h = serverHarness(client);
      await h.invoke('save_smart_playlist_rule', { name: 'r8', rule: { source: 'top_tracks' } });
      const out = await h.invoke('refresh_smart_playlist', { name: 'r8', dry_run: true });
      const echo = out.structuredContent as Record<string, unknown>;
      assert.equal(echo.error, 'no_candidates');
      assert.equal(echo.pool_cap, 100);
      assert.equal(echo.pool_capped, false);
      assert.equal(echo.candidates_scanned, 0);
    });
  });

  // #833: restore_playback_state replaced an album/playlist session with a
  // one-track ad-hoc queue and never read the player back, so it claimed
  // success on a device that was doing something else entirely.
  it('restore_playback_state round-trips the saved context and offset', async () => {
    const snapshot = {
      is_playing: true, progress_ms: 185000, shuffle_state: false, repeat_state: 'off',
      item: { uri: 'spotify:track:abc', name: 'Abc', type: 'track' },
      context: { type: 'album', uri: 'spotify:album:alb1' },
      device: { id: 'dev1', volume_percent: 42 },
    };
    const { client, putCalls } = makeClient({ playback: snapshot, playbackAfterWrite: snapshot });
    const h = serverHarness(client);
    await h.invoke('save_playback_state', { name: 'evening' });
    const listed = await h.invoke('list_playback_states', { response_format: 'json' });
    const savedStates = (listed.structuredContent as { states: Record<string, { playback: { context: { uri: string } } }> }).states;
    assert.equal(savedStates.evening?.playback.context.uri, 'spotify:album:alb1', 'the context must survive the save');

    const restored = await h.invoke('restore_playback_state', { name: 'evening', device_id: 'dev1' });
    const echo = restored.structuredContent as Record<string, unknown>;
    assert.deepEqual(putCalls[0], {
      path: '/me/player/play?device_id=dev1',
      body: { context_uri: 'spotify:album:alb1', offset: { uri: 'spotify:track:abc' }, position_ms: 185000 },
    });
    assert.equal(echo.verified, true);
    assert.equal(echo.observed_item, 'spotify:track:abc');
    assert.equal(echo.context_uri, 'spotify:album:alb1');
    assert.match(restored.content[0].text, /Restored/);
  });

  it('restore_playback_state reports verified:false when the device is elsewhere', async () => {
    const snapshot = {
      is_playing: true, progress_ms: 5000, shuffle_state: false, repeat_state: 'off',
      item: { uri: 'spotify:track:abc', name: 'Abc', type: 'track' },
      context: { type: 'album', uri: 'spotify:album:alb1' },
    };
    const elsewhere = { ...snapshot, item: { uri: 'spotify:track:zzz', name: 'Zzz', type: 'track' }, context: { type: 'playlist', uri: 'spotify:playlist:p9' } };
    const { client } = makeClient({ playback: snapshot, playbackAfterWrite: elsewhere });
    const h = serverHarness(client);
    await h.invoke('save_playback_state', { name: 'evening' });
    const restored = await h.invoke('restore_playback_state', { name: 'evening' });
    const echo = restored.structuredContent as Record<string, unknown>;
    assert.equal(echo.verified, false);
    assert.equal(echo.ok, false);
    assert.equal(echo.observed_item, 'spotify:track:zzz');
    assert.match(restored.content[0].text, /spotify:track:zzz/);
  });

  it('restore_playback_state retries an album without its offset when the context rejects it', async () => {
    const snapshot = {
      is_playing: true, progress_ms: 5000, shuffle_state: false, repeat_state: 'off',
      item: { uri: 'spotify:track:abc', name: 'Abc', type: 'track' },
      context: { type: 'album', uri: 'spotify:album:alb1' },
    };
    let playWrites = 0;
    const { client, putCalls } = makeClient({
      playback: snapshot,
      playbackAfterWrite: snapshot,
      failPut: (p: string) => p.startsWith('/me/player/play') && ++playWrites === 1,
    });
    const h = serverHarness(client);
    await h.invoke('save_playback_state', { name: 'evening' });
    const restored = await h.invoke('restore_playback_state', { name: 'evening' });
    const echo = restored.structuredContent as Record<string, unknown>;
    assert.equal(playWrites, 2, 'the rejected context write must be retried once');
    assert.deepEqual(putCalls[1], { path: '/me/player/play', body: { uris: ['spotify:track:abc'], position_ms: 5000 } });
    assert.equal(echo.context_fallback, true);
    assert.equal(echo.verified, true);
  });

  // #839: a sidecar that cannot be parsed used to read as an empty store, so
  // the next mutating call wrote that empty store back over the file and every
  // saved snapshot, preset, session and rule was gone with no warning. The
  // bytes must survive and the caller must be told.
  describe('#839 corrupt sidecar preservation', () => {
    const file = () => process.env.SPOTIFY_MCP_PLAYBACKEXT_FILE as string;
    const corruptCopies = async () => (await readdir(dir)).filter((f) => f.startsWith('playback-ext.json.corrupt-'));

    it('preserves the original bytes and reports load_error when a mutating tool saves over unparseable JSON', async () => {
      const original = '{"states":{"evening":{"name":"evening"';
      await writeFileRaw(file(), original, 'utf8');
      const { client } = makeClient();
      const h = serverHarness(client);
      const res = await h.invoke('set_device_volume_preset', { device_id: 'dev1', volume_percent: 42 });

      const copies = await corruptCopies();
      assert.equal(copies.length, 1, `expected exactly one preserved copy, found ${copies.join(', ')}`);
      assert.equal(await readFileRaw(join(dir, copies[0]), 'utf8'), original, 'the preserved copy must be byte-identical to what was on disk');

      const echo = res.structuredContent as Record<string, unknown>;
      assert.equal(typeof echo.load_error, 'string', 'structuredContent must carry load_error');
      assert.match(echo.load_error as string, /playback-ext\.json/);
      assert.equal(echo.preserved_as, join(dir, copies[0]));
      assert.match(res.content[0].text, /WARNING/, 'the prose must carry the warning too');
    });

    it('does not report load_error when the file was simply never written', async () => {
      const { client } = makeClient();
      const h = serverHarness(client);
      const res = await h.invoke('set_device_volume_preset', { device_id: 'dev1', volume_percent: 42 });
      const echo = res.structuredContent as Record<string, unknown>;
      assert.equal(echo.load_error, undefined, 'ENOENT is a genuinely empty store, not a failure');
      assert.deepEqual(await corruptCopies(), []);
      assert.equal(echo.ok, true);
    });

    it('keeps a valid store loadable and does not leave a stale load_error on disk', async () => {
      const { client } = makeClient();
      const h = serverHarness(client);
      await h.invoke('rename_device', { device_id: 'dev1', new_name: 'Kitchen' });
      const res = await h.invoke('list_device_presets', {});
      const echo = res.structuredContent as Record<string, unknown>;
      assert.equal(echo.load_error, undefined);
      assert.equal(JSON.parse(await readFileRaw(file(), 'utf8')).load_error, undefined, 'the report is per-call, never store content');
    });

    it('preserves a file whose collection fields are the wrong shape rather than throwing on the next write', async () => {
      await writeFileRaw(file(), '{"states":"oops"}', 'utf8');
      const store = await loadPlaybackExt();
      assert.equal(typeof store.load_error, 'string');
      assert.match(store.load_error as string, /"states" is not a JSON object/);
      assert.equal((await corruptCopies()).length, 1);
    });

    it('preserves a file whose top level is not an object', async () => {
      await writeFileRaw(file(), '[1,2,3]', 'utf8');
      const store = await loadPlaybackExt();
      assert.equal(typeof store.load_error, 'string');
      assert.match(store.load_error as string, /top level is not a JSON object/);
      assert.equal((await corruptCopies()).length, 1);
    });

    it('reports load_error on a read tool, so an empty listing is never mistaken for a real one', async () => {
      await writeFileRaw(file(), '{oops', 'utf8');
      const { client } = makeClient();
      const h = serverHarness(client);
      const res = await h.invoke('list_playback_states', {});
      const echo = res.structuredContent as Record<string, unknown>;
      assert.equal(typeof echo.load_error, 'string');
      assert.equal(echo.count, 0);
      assert.match(res.content[0].text, /WARNING/);
    });

    it('survives a second corruption without clobbering the copy already preserved', async () => {
      await writeFileRaw(file(), '{first', 'utf8');
      const first = await loadPlaybackExt();
      await writeFileRaw(file(), '{second', 'utf8');
      const second = await loadPlaybackExt();
      assert.notEqual(first.preserved_as, second.preserved_as);
      assert.equal((await corruptCopies()).length, 2, 'each corruption keeps its own copy');
      assert.equal(await readFileRaw(first.preserved_as as string, 'utf8'), '{first');
      assert.equal(await readFileRaw(second.preserved_as as string, 'utf8'), '{second');
    });

    it('a fresh save after a preserved corruption starts from the new entry only', async () => {
      await writeFileRaw(file(), '{"states":{"evening"oops}', 'utf8');
      const { client } = makeClient();
      const h = serverHarness(client);
      const res = await h.invoke('save_playback_state', { name: 'morning' });
      assert.equal(typeof (res.structuredContent as Record<string, unknown>).load_error, 'string');
      const onDisk = JSON.parse(await readFileRaw(file(), 'utf8')) as Record<string, Record<string, unknown>>;
      assert.deepEqual(Object.keys(onDisk.states), ['morning']);
      assert.equal((await corruptCopies()).length, 1, 'the unparseable bytes are still recoverable');
    });
  });
});
