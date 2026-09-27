/**
 * Executing-path coverage for the 20 `swarm3_playback` tools that #668 found
 * were registered and reachable but whose handlers no test ever invoked.
 *
 * The gap was measured, not assumed. Each handler body was instrumented to
 * record its own invocation and the whole suite was run (3242 tests): only 4 of
 * the module's 24 handlers ever fired — `get_context_inspect`,
 * `plan_volume_level_across_devices`, `apply_volume_plan` and
 * `resume_playback_position`, all covered by the `tools.swarm3playback-*.test.ts`
 * units and `tools.swarm-coverage.test.ts`. The other 20 were named in no test
 * file at all, so a wrong endpoint, a wrong body key or a wrong page size in
 * any of them shipped green. These cases drive the real handlers against a
 * recording stub and assert the exact wire call.
 *
 * The module's mutations carry `dry_run` (default false, #836) and are covered
 * on BOTH sides here: the preview must issue no write at all, and the commit
 * must issue exactly the documented one. `delete_playback_bookmark` is the
 * destructive local write (`destructiveHint: true`); its commit path is asserted
 * to unlink the file and its preview path to leave the file in place.
 *
 * The two sides are separated the way #803 was: where a write can be silently
 * dropped, the assertion is on the observed effect (the file, the playlist
 * rows, the re-read), not on the call being recorded. A stub that swallowed
 * the call could not make a deleted file come back.
 */
import { DEFAULT_TOKEN_FILE } from './helpers/hermetic.js';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerSwarm3PlaybackTools } from '../src/tools/swarm3_playback.js';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type Registered = {
  name: string;
  schema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};

interface Call {
  method: string;
  path: string;
  body?: unknown;
  params?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface DeviceStub {
  id: string | null;
  name: string;
  type: string;
  volume_percent: number | null;
  supports_volume: boolean;
  is_active: boolean;
  is_restricted: boolean;
  is_private_session: boolean;
}

const device = (over: Partial<DeviceStub> & { id: string | null; name: string }): DeviceStub => ({
  type: 'Speaker',
  volume_percent: 30,
  supports_volume: true,
  is_active: false,
  is_restricted: false,
  is_private_session: false,
  ...over,
});

const track = (n: number, ms: number, name?: string) => ({
  uri: `spotify:track:t${String(n).padStart(2, '0')}`,
  name: name ?? `Track ${n}`,
  duration_ms: ms,
  type: 'track' as const,
  artists: [{ name: 'Artist' }],
  album: { id: 'al1', name: 'Album', release_date: '2024-01-01' },
});

const episode = (n: number, ms: number) => ({
  uri: `spotify:episode:e${String(n).padStart(2, '0')}`,
  name: `Episode ${n}`,
  duration_ms: ms,
  type: 'episode' as const,
  show: { id: 'sh1', name: 'The Show' },
});

const state = (over: Record<string, unknown> = {}) => ({
  is_playing: true,
  progress_ms: 30_000,
  shuffle_state: false,
  repeat_state: 'off' as const,
  timestamp: Date.parse('2026-09-27T10:00:00.000Z'),
  device: device({ id: 'dev_kitchen', name: 'Kitchen Speaker', is_active: true, volume_percent: 55 }),
  item: track(1, 200_000, 'First'),
  currently_playing_type: 'track' as const,
  context: { type: 'playlist', uri: 'spotify:playlist:pl1' },
  ...over,
});

const DEVICES: DeviceStub[] = [
  device({ id: 'dev_kitchen', name: 'Kitchen Speaker', is_active: true, volume_percent: 55 }),
  device({ id: 'dev_desk', name: 'Desk Computer', type: 'Computer', volume_percent: 20 }),
];

interface StubOptions {
  /** `'throw'` makes that endpoint reject, to drive the degraded paths. */
  state?: Record<string, unknown> | null | 'throw';
  devices?: DeviceStub[] | 'throw';
  queue?: { currently_playing: unknown; queue: unknown[] } | null | 'throw';
  me?: Record<string, unknown> | null | 'throw';
  /** Path fragments whose write rejects. Drives the fallback/failed_steps paths. */
  failWrite?: string[];
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Every tool this file invoked, for the anti-vacuity check at the bottom. */
const invoked = new Set<string>();

function makeHarness(options: StubOptions = {}) {
  const registered: Registered[] = [];
  const calls: Call[] = [];
  /** id -> the URIs a re-read of `/playlists/{id}/items` will see. */
  const playlists = new Map<string, string[]>();
  let nextPlaylistId = 0;
  const failWrite = options.failWrite ?? [];

  const rejects = (method: string, path: string): Error | null => {
    if (method === 'GET') return null;
    const hit = failWrite.find((frag) => path.includes(frag));
    return hit ? new Error(`stubbed failure for ${method} ${path} (matched "${hit}")`) : null;
  };

  const client = {
    // The real SpotifyClient always sets this at construction; a stub that
    // omits it is not a client the stores can key by (#1385).
    tokenFile: DEFAULT_TOKEN_FILE,
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      calls.push({ method: 'GET', path, params });
      const key = options.state === undefined ? 'state' : 'state';
      if (path === '/me/player') {
        if (options.state === 'throw') throw new Error('stubbed /me/player failure');
        return (options.state === undefined ? state() : options.state) as T | null;
      }
      if (path === '/me/player/devices') {
        if (options.devices === 'throw') throw new Error('stubbed /me/player/devices failure');
        return { devices: options.devices ?? DEVICES } as unknown as T;
      }
      if (path === '/me/player/queue') {
        if (options.queue === 'throw') throw new Error('stubbed /me/player/queue failure');
        return (options.queue ?? { currently_playing: track(1, 200_000, 'First'), queue: [] }) as T | null;
      }
      if (path === '/me') {
        if (options.me === 'throw') throw new Error('stubbed /me failure');
        return (options.me === undefined ? { id: 'jack', display_name: 'Jack' } : options.me) as T | null;
      }
      const items = /^\/playlists\/([^/]+)\/items$/.exec(path);
      if (items) {
        const id = decodeURIComponent(items[1] as string);
        const uris = playlists.get(id) ?? [];
        const limit = Number(params?.limit ?? '100');
        const offset = Number(params?.offset ?? '0');
        const page = uris.slice(offset, offset + limit);
        return {
          items: page.map((uri) => ({ item: { uri } })),
          limit,
          offset,
          total: uris.length,
          next: offset + limit < uris.length ? `offset=${offset + limit}` : null,
        } as unknown as T;
      }
      void key;
      throw new Error(`stub received an unexpected GET ${path}`);
    },

    async put<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'PUT', path, body });
      const failure = rejects('PUT', path);
      if (failure) throw failure;
      const replace = /^\/playlists\/([^/]+)\/items$/.exec(path);
      if (replace) {
        playlists.set(decodeURIComponent(replace[1] as string), [...((body as { uris?: string[] })?.uris ?? [])]);
        return { snapshot_id: 'snap' } as unknown as T;
      }
      return null as T;
    },

    async post<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'POST', path, body });
      const failure = rejects('POST', path);
      if (failure) throw failure;
      if (path === '/me/playlists') {
        const id = `pl${++nextPlaylistId}`;
        playlists.set(id, []);
        return { id, uri: `spotify:playlist:${id}`, snapshot_id: `snap-${id}` } as unknown as T;
      }
      const append = /^\/playlists\/([^/]+)\/items$/.exec(path);
      if (append) {
        const id = decodeURIComponent(append[1] as string);
        playlists.set(id, [...(playlists.get(id) ?? []), ...((body as { uris?: string[] })?.uris ?? [])]);
        return { snapshot_id: `snap-${id}` } as unknown as T;
      }
      throw new Error(`stub received an unexpected POST ${path}`);
    },

    async delete<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'DELETE', path, body });
      return null as T;
    },
  } as unknown as SpotifyClient;

  const server = {
    tool(name: string, _description: string, schema: z.ZodRawShape, handler: Registered['handler']) {
      registered.push({ name, schema, handler });
    },
  } as unknown as McpServer;

  registerSwarm3PlaybackTools(server, client);

  return {
    calls,
    playlists,
    names: () => registered.map((t) => t.name),
    find: (name: string) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" must be registered by registerSwarm3PlaybackTools`);
      return tool;
    },
    /** Invokes the real handler through the declared schema, as a host would. */
    invoke: async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" must be registered — a missing tool makes every case below vacuous`);
      invoked.add(name);
      return tool.handler(z.object(tool.schema).parse(args) as Record<string, unknown>);
    },
    paths: (method: string) => calls.filter((c) => c.method === method).map((c) => c.path),
    text: (r: ToolResult) => r.content.map((c) => c.text).join('\n'),
    structured: (r: ToolResult) => r.structuredContent as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Local sidecar dir — every byte this file writes lands under os.tmpdir()
// ---------------------------------------------------------------------------

let tmp: string;
let prevBackupDir: string | undefined;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'spotify-swarm3-playback-'));
  prevBackupDir = process.env.SPOTIFY_MCP_BACKUP_DIR;
  process.env.SPOTIFY_MCP_BACKUP_DIR = tmp;
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
  if (prevBackupDir === undefined) delete process.env.SPOTIFY_MCP_BACKUP_DIR;
  else process.env.SPOTIFY_MCP_BACKUP_DIR = prevBackupDir;
});

const bookmarkFile = (id: string) => join(tmp, `playback-bookmark-${id}.json`);
const sessionFile = (id: string) => join(tmp, `listening-session-${id}.json`);

const seedBookmark = (over: Record<string, unknown> = {}) => {
  const bm = {
    id: 'bm1',
    captured_at: '2026-09-27T09:00:00.000Z',
    device_id: 'dev_kitchen',
    device_name: 'Kitchen Speaker',
    track_uri: 'spotify:track:t01',
    track_name: 'First',
    position_ms: 30_000,
    is_playing: true,
    context_uri: 'spotify:playlist:pl1',
    ...over,
  };
  return { bm, path: bookmarkFile(String(bm.id)) };
};

const writeJson = async (path: string, value: unknown) => {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
};

// ===========================================================================
// 1-2. get_playback_snapshot
// ===========================================================================

describe('#668 get_playback_snapshot', () => {
  it('reports the full state from exactly one GET /me/player', async () => {
    const h = makeHarness();
    const out = await h.invoke('get_playback_snapshot');
    assert.deepEqual(h.paths('GET'), ['/me/player'], 'the snapshot must come from the one documented endpoint');
    const sc = h.structured(out);
    assert.equal(sc.active, true);
    assert.equal(sc.track_name, 'First');
    assert.equal(sc.position_ms, 30_000);
    assert.equal(sc.device_name, 'Kitchen Speaker');
    assert.equal(sc.context_uri, 'spotify:playlist:pl1');
    assert.match(h.text(out), /Playback snapshot \(playing\)/);
  });

  it('reports active:false with no snapshot fields when nothing is playing', async () => {
    const h = makeHarness({ state: null });
    const out = await h.invoke('get_playback_snapshot');
    const sc = h.structured(out);
    assert.equal(sc.active, false, 'an idle account must not be reported as an active snapshot');
    assert.equal(sc.track_name, undefined);
    assert.match(h.text(out), /No active playback on any device/);
  });
});

// ===========================================================================
// 3. capture_playback_position
// ===========================================================================

describe('#668 capture_playback_position', () => {
  it('writes a 0600 bookmark under the temp backup dir and names the path', async () => {
    const h = makeHarness();
    const out = await h.invoke('capture_playback_position', { label: 'morning' });
    const sc = h.structured(out);
    assert.equal(sc.bookmarked, true);
    const bookmark = sc.bookmark as Record<string, unknown>;
    assert.equal(bookmark.label, 'morning');
    assert.equal(bookmark.track_uri, 'spotify:track:t01');
    assert.equal(bookmark.position_ms, 30_000);
    assert.equal(bookmark.device_id, 'dev_kitchen');

    // The effect, not the call: the file really exists, with the right mode.
    const files = await readdir(tmp);
    assert.equal(files.length, 1, `exactly one sidecar expected, saw ${files.join(', ')}`);
    assert.equal(
      String(sc.path),
      join(tmp, files[0] as string),
      'the reported path must be the file that was actually written, inside the temp backup dir',
    );
    const onDisk = JSON.parse(await readFile(join(tmp, files[0] as string), 'utf8')) as Record<string, unknown>;
    assert.equal(onDisk.track_uri, 'spotify:track:t01');
    const mode = (await stat(join(tmp, files[0] as string))).mode & 0o777;
    assert.equal(mode, 0o600, `bookmark sidecar must be 0600, saw ${mode.toString(8)}`);
  });

  it('writes nothing when there is no item to bookmark', async () => {
    const h = makeHarness({ state: state({ item: null }) });
    const out = await h.invoke('capture_playback_position');
    assert.equal(h.structured(out).active, false);
    assert.deepEqual(await readdir(tmp), [], 'the empty path must not leave a sidecar behind');
  });
});

// ===========================================================================
// 4. list_playback_bookmarks — the handler NO test had ever invoked
// ===========================================================================

describe('#668 list_playback_bookmarks', () => {
  it('lists every bookmark, ordered by id, with label and mm:ss position', async () => {
    const h = makeHarness();
    // Ids seeded in an order that is NOT their sort order, so the assertion
    // below cannot pass by accident on a filesystem whose readdir happens to
    // return them sorted. The ordering claim is asserted as "equals the sort
    // of what was seeded" rather than against a hardcoded pair, so it holds
    // whatever order the directory hands back.
    const seeded = [
      { id: 'zz-last', track_name: 'Zulu', position_ms: 3_661_000, label: 'morning' },
      { id: 'aa-first', track_name: 'Alpha', position_ms: 90_000 },
      { id: 'mm-middle', track_name: 'Mike', position_ms: 0 },
    ];
    for (const row of seeded) {
      await writeJson(bookmarkFile(row.id), seedBookmark({ ...row, id: row.id }).bm);
    }
    // A file that is not a bookmark must be ignored, not listed.
    await writeFile(join(tmp, 'backup-2026-09-27-1.json'), '{}\n');

    const out = await h.invoke('list_playback_bookmarks');
    assert.deepEqual(h.calls, [], 'listing bookmarks is a local read and must issue no Spotify call');

    const sc = h.structured(out);
    const items = sc.items as Array<Record<string, unknown>>;
    const expectedIds = seeded.map((r) => r.id).sort();
    assert.deepEqual(
      items.map((b) => b.id),
      expectedIds,
      'bookmarks come back sorted by id, and only playback-bookmark-*.json rows are bookmarks',
    );
    assert.equal(items.find((b) => b.id === 'zz-last')?.label, 'morning');
    const prose = h.text(out);
    assert.match(prose, /3 bookmark\(s\)/);
    assert.match(prose, /1:30/, '90_000ms renders as 1:30');
    assert.match(prose, /1:01:01/, '3_661_000ms renders as 1:01:01');
    assert.deepEqual(sc.pagination, { total: 3, returned: 3, truncated: false });
  });

  it('reports zero bookmarks and points at capture when the dir has none', async () => {
    const h = makeHarness();
    const out = await h.invoke('list_playback_bookmarks');
    const sc = h.structured(out);
    assert.deepEqual(sc.items, []);
    assert.deepEqual(sc.pagination, { total: 0, returned: 0, truncated: false });
    assert.match(h.text(out), /use capture_playback_position/);
  });

  it('truncates with a footer rather than silently returning every row', async () => {
    const h = makeHarness();
    for (const id of ['a', 'b', 'c']) await writeJson(bookmarkFile(id), seedBookmark({ id, track_name: id }).bm);
    const out = await h.invoke('list_playback_bookmarks', { max_results: 2 });
    const sc = h.structured(out);
    assert.equal((sc.items as unknown[]).length, 2);
    assert.deepEqual(sc.pagination, { total: 3, returned: 2, truncated: true });
    assert.match(h.text(out), /\(1 more — pass offset or fetch_all\)/);
  });
});

// ===========================================================================
// 5. delete_playback_bookmark — the destructive local write
// ===========================================================================

describe('#668 delete_playback_bookmark', () => {
  it('unlinks the file on commit and says what it removed', async () => {
    const h = makeHarness();
    await writeJson(bookmarkFile('bm1'), seedBookmark().bm);
    const out = await h.invoke('delete_playback_bookmark', { bookmark_id: 'bm1', dry_run: false });
    assert.equal(h.structured(out).deleted, true);
    assert.deepEqual(await readdir(tmp), [], 'commit must actually remove the sidecar');
    assert.match(h.text(out), /Deleted bookmark bm1/);
  });

  it('leaves the file untouched on the dry_run preview', async () => {
    const h = makeHarness();
    await writeJson(bookmarkFile('bm1'), seedBookmark().bm);
    const out = await h.invoke('delete_playback_bookmark', { bookmark_id: 'bm1', dry_run: true });
    assert.equal(h.structured(out).dry_run, true);
    assert.deepEqual(await readdir(tmp), ['playback-bookmark-bm1.json'], 'a preview must not delete');
  });

  it('reports found:false for an unknown id instead of throwing', async () => {
    const h = makeHarness();
    const out = await h.invoke('delete_playback_bookmark', { bookmark_id: 'nope', dry_run: false });
    assert.equal(h.structured(out).found, false);
    assert.match(h.text(out), /No bookmark found with id "nope"/);
  });
});

// ===========================================================================
// 6. compare_devices
// ===========================================================================

describe('#668 compare_devices', () => {
  it('ranks active first, then by type rank, and reads /me/player/devices once', async () => {
    const h = makeHarness({
      devices: [
        device({ id: 'd_tv', name: 'TV', type: 'TV', volume_percent: 90 }),
        // The active device is a Speaker on purpose: Computer outranks Speaker,
        // so an implementation that sorted on type alone would put the
        // inactive desk first and this expectation would fail.
        device({ id: 'd_speaker', name: 'Speaker', type: 'Speaker', is_active: true }),
        device({ id: 'd_phone', name: 'Phone', type: 'Smartphone', volume_percent: 10 }),
        device({ id: 'd_desk', name: 'Desk', type: 'Computer' }),
      ],
    });
    const out = await h.invoke('compare_devices');
    assert.deepEqual(h.paths('GET'), ['/me/player/devices']);
    const sc = h.structured(out);
    assert.equal(sc.total, 4);
    assert.deepEqual(
      (sc.items as Array<Record<string, unknown>>).map((d) => d.id),
      ['d_speaker', 'd_desk', 'd_phone', 'd_tv'],
      'active first, then Computer > Smartphone > TV > Speaker',
    );
    assert.match(h.text(out), /4 device\(s\) available/);
  });

  it('says so plainly when no device is available', async () => {
    const h = makeHarness({ devices: [] });
    const out = await h.invoke('compare_devices');
    assert.equal(h.structured(out).total, 0);
    assert.match(h.text(out), /\(none — open Spotify on a device first\)/);
  });
});

// ===========================================================================
// 7. get_device_volume_report
// ===========================================================================

describe('#668 get_device_volume_report', () => {
  it('pairs the device list with the active device from the player state', async () => {
    const h = makeHarness();
    const out = await h.invoke('get_device_volume_report');
    assert.deepEqual(
      h.paths('GET').sort(),
      ['/me/player', '/me/player/devices'],
      'the report needs both the roster and the active device',
    );
    const sc = h.structured(out);
    assert.equal((sc.items as unknown[]).length, 2);
    assert.deepEqual(sc.active_device, { id: 'dev_kitchen', name: 'Kitchen Speaker', volume_percent: 55 });
    assert.match(h.text(out), /active: "Kitchen Speaker" at 55%/);
  });

  it('marks a device that cannot take a volume and reports an em dash for null volume', async () => {
    const h = makeHarness({
      devices: [device({ id: 'd_no_vol', name: 'Remote', supports_volume: false, volume_percent: null })],
      state: state({ device: null }),
    });
    const out = await h.invoke('get_device_volume_report');
    const sc = h.structured(out);
    assert.equal(sc.active_device, null);
    assert.equal((sc.items as Array<Record<string, unknown>>)[0]?.supports_volume, false);
    assert.match(h.text(out), /vol — \(volume control unsupported\)/);
  });
});

// ===========================================================================
// #847 removed: get_queue_snapshot
// ===========================================================================
//
// Retired into `get_queue` with `include: ['runtime']`. Its tests moved with it rather than being deleted
// with the registration: the describe block "#847 the retired tools' coverage,
// re-pointed at get_queue" in tests/queue.tools.test.ts re-makes every assertion
// this one made, against the tool that answers now.


// #847 removed: queue_runtime_report
// ===========================================================================
//
// Retired into `get_queue` with `include: ['runtime']`. Its tests moved with it rather than being deleted
// with the registration: the describe block "#847 the retired tools' coverage,
// re-pointed at get_queue" in tests/queue.tools.test.ts re-makes every assertion
// this one made, against the tool that answers now.


// 10. split_queue_plan
// ===========================================================================

describe('#668 split_queue_plan', () => {
  const QUEUE = { currently_playing: null, queue: [track(1, 600_000), track(2, 600_000), track(3, 600_000)] };

  it('previews the chunks and creates nothing on the dry_run path', async () => {
    const h = makeHarness({ queue: QUEUE });
    const out = await h.invoke('split_queue_plan', { chunk_minutes: 10, dry_run: true });
    assert.deepEqual(h.paths('POST'), [], 'a preview must not create a playlist');
    assert.deepEqual(h.paths('PUT'), []);
    const sc = h.structured(out);
    assert.equal(sc.dry_run, true);
    const chunks = sc.chunks as Array<Record<string, unknown>>;
    assert.equal(chunks.length, 3, '600_000ms per track against a 600_000ms cap is one track per chunk');
    assert.deepEqual(chunks.map((c) => c.playlist_name), ['Queue chunk 01', 'Queue chunk 02', 'Queue chunk 03']);
    assert.match(h.text(out), /POST \/me\/playlists/);
  });

  it('creates the playlists and writes every queued uri, verified by a re-read', async () => {
    const h = makeHarness({ queue: QUEUE });
    const out = await h.invoke('split_queue_plan', { chunk_minutes: 10, playlist_name_prefix: 'Split', dry_run: false });
    assert.deepEqual(
      h.paths('GET'),
      ['/me/player/queue', '/me', '/playlists/pl1/items', '/playlists/pl2/items', '/playlists/pl3/items'],
      'read the queue, resolve the user, then re-read each playlist to verify the write',
    );
    assert.deepEqual(
      h.paths('POST'),
      ['/me/playlists', '/me/playlists', '/me/playlists'],
      'one playlist per chunk, created on /me/playlists',
    );
    // The create body is the contract an agent reproduces by hand.
    const creates = h.calls.filter((c) => c.method === 'POST' && c.path === '/me/playlists');
    assert.deepEqual(creates[0]?.body, {
      name: 'Split 01',
      public: false,
      description: '1 tracks, 10m — split from the live queue',
    });
    assert.deepEqual(
      h.paths('PUT'),
      ['/playlists/pl1/items', '/playlists/pl2/items', '/playlists/pl3/items'],
      'the first ≤100 uris of each chunk go in as a replace (PUT /items, not the removed /tracks)',
    );

    const sc = h.structured(out);
    assert.equal(sc.created, true);
    assert.equal(sc.ok, true, 'each chunk re-read must confirm its rows');
    assert.equal(sc.expected, 3);
    assert.equal(sc.actual, 3);
    const receipts = sc.receipts as Array<Record<string, unknown>>;
    assert.equal(receipts.length, 3);
    assert.equal(receipts[0]?.verified, true);
    // The rows really are there, not merely recorded as written.
    assert.deepEqual(h.playlists.get('pl1'), ['spotify:track:t01']);
    assert.deepEqual(h.playlists.get('pl3'), ['spotify:track:t03']);
  });

  it('chunks past 100 uris into a replace plus appends, and still verifies', async () => {
    // 150 one-minute tracks against a 240-minute cap stays in ONE chunk, so the
    // overflow path (POST /items for uris 101+) is the one under test.
    const many = Array.from({ length: 150 }, (_, i) => track(i + 1, 60_000));
    const h = makeHarness({ queue: { currently_playing: null, queue: many } });
    const out = await h.invoke('split_queue_plan', { chunk_minutes: 240, dry_run: false });
    const sc = h.structured(out);
    assert.equal((sc.chunks as unknown[]).length, 1, '150 × 60_000ms = 150m, inside the 240m cap');
    assert.equal(sc.ok, true, 'the overflow rows must be confirmed by the receipt walk too');
    assert.equal(sc.expected, 150);
    assert.equal(sc.actual, 150);

    const replaced = h.calls.find((c) => c.method === 'PUT' && c.path === '/playlists/pl1/items');
    assert.ok(replaced, 'the first ≤100 uris are written as a PUT replace');
    assert.equal((replaced.body as { uris: string[] }).uris.length, 100);
    const appended = h.calls.filter((c) => c.method === 'POST' && c.path === '/playlists/pl1/items');
    assert.equal(appended.length, 1, 'the remaining 50 uris are one append, not one call per uri');
    assert.equal((appended[0]?.body as { uris: string[] }).uris.length, 50);
    assert.equal(h.playlists.get('pl1')?.length, 150, 'the re-read sees all 150 rows');
  });

  it('refuses to create anything when the user id cannot be resolved', async () => {
    const h = makeHarness({ queue: QUEUE, me: { display_name: 'Jack' } });
    const out = await h.invoke('split_queue_plan', { chunk_minutes: 10, dry_run: false });
    assert.equal(h.structured(out).created, false);
    assert.deepEqual(h.paths('POST'), [], 'no playlist is created without a resolvable user id');
    assert.match(h.text(out), /Could not resolve the current user id/);
  });
});

// ===========================================================================
// #847 removed: queue_duplicate_check
// ===========================================================================
//
// Retired into `get_queue` with `include: ['duplicates']`. Its tests moved with it rather than being deleted
// with the registration: the describe block "#847 the retired tools' coverage,
// re-pointed at get_queue" in tests/queue.tools.test.ts re-makes every assertion
// this one made, against the tool that answers now.


// 12. queue_prune_plan
// ===========================================================================

describe('#668 queue_prune_plan', () => {
  it('keeps the first of each uri and lists the rest as drops', async () => {
    const h = makeHarness({
      queue: { currently_playing: null, queue: [track(1), track(2), track(1), episode(3, 100_000)] },
    });
    const out = await h.invoke('queue_prune_plan', {});
    const sc = h.structured(out);
    // Only the repeat is a duplicate; the episode survives because
    // drop_episodes defaults to false, and `keep` is the first sighting of
    // every distinct uri (so it includes the entry the duplicate copies).
    assert.deepEqual(sc.drop, ['spotify:track:t01']);
    assert.deepEqual(sc.keep, ['spotify:track:t01', 'spotify:track:t02', 'spotify:episode:e03']);
    assert.equal(sc.dropped_count, 1);
    assert.deepEqual(
      h.paths('GET'),
      ['/me/player/queue'],
      'a plan reads the queue and writes nothing — Spotify has no queue-removal endpoint',
    );
    assert.match(h.text(out), /Prune 1 of 4 queued item\(s\)/);
    assert.match(h.text(out), /drop #3 "Track 1" \(duplicate\)/);
  });

  it('drops episodes too when asked, and says which kind each drop is', async () => {
    const h = makeHarness({
      queue: { currently_playing: null, queue: [track(1), episode(3, 100_000), track(2)] },
    });
    const out = await h.invoke('queue_prune_plan', { drop_episodes: true });
    assert.deepEqual(h.structured(out).drop, ['spotify:episode:e03']);
    assert.deepEqual(h.structured(out).keep, ['spotify:track:t01', 'spotify:track:t02']);
    assert.match(h.text(out), /drop #2 "Episode 3" \(episode\)/);
  });

  it('reports a clean queue when there is nothing to prune', async () => {
    const h = makeHarness({ queue: { currently_playing: null, queue: [track(1), track(2)] } });
    const out = await h.invoke('queue_prune_plan', {});
    assert.equal(h.structured(out).dropped_count, 0);
    assert.match(h.text(out), /nothing to prune — queue is already clean/);
  });
});

// ===========================================================================
// #847 removed: predict_next_tracks
// ===========================================================================
//
// Retired into `get_queue` with `include: ['runtime']`, whose `runtime.timeline` carries the same per-item rows and cumulative `plays_at_ms`. Its tests moved with it rather than being deleted
// with the registration: the describe block "#847 the retired tools' coverage,
// re-pointed at get_queue" in tests/queue.tools.test.ts re-makes every assertion
// this one made, against the tool that answers now.


// 14. shuffle_state_report
// ===========================================================================

describe('#668 shuffle_state_report', () => {
  it('reports shuffle, repeat, device and context together', async () => {
    const h = makeHarness({ state: state({ shuffle_state: true, repeat_state: 'context' }) });
    const out = await h.invoke('shuffle_state_report');
    assert.deepEqual(h.paths('GET'), ['/me/player']);
    const sc = h.structured(out);
    assert.equal(sc.shuffle_state, true);
    assert.equal(sc.repeat_state, 'context');
    assert.equal(sc.context_uri, 'spotify:playlist:pl1');
    assert.match(h.text(out), /Shuffle: ON · Repeat: context/);
  });

  it('reports active:false instead of guessing when nothing is playing', async () => {
    const h = makeHarness({ state: null });
    const out = await h.invoke('shuffle_state_report');
    assert.equal(h.structured(out).active, false);
    assert.match(h.text(out), /No active playback — shuffle state unknown\./);
  });
});

// ===========================================================================
// 15. playback_health_check
// ===========================================================================

describe('#668 playback_health_check', () => {
  it('reports HEALTHY with a per-probe verdict when every endpoint answers', async () => {
    const h = makeHarness();
    const out = await h.invoke('playback_health_check');
    const sc = h.structured(out);
    assert.equal(sc.healthy, true);
    const probes = sc.probes as Array<Record<string, unknown>>;
    assert.deepEqual(probes.map((p) => p.probe), ['token', 'devices', 'playback_state', 'queue']);
    assert.ok(probes.every((p) => p.ok === true), JSON.stringify(probes));
    assert.match(h.text(out), /Playback health check: HEALTHY/);
  });

  it('reports DEGRADED and names the failing endpoint when the token is rejected', async () => {
    const h = makeHarness({ me: 'throw' });
    const out = await h.invoke('playback_health_check');
    const sc = h.structured(out);
    assert.equal(sc.healthy, false, 'one failed probe must not be reported as healthy');
    const probes = sc.probes as Array<Record<string, unknown>>;
    const token = probes.find((p) => p.probe === 'token');
    assert.equal(token?.ok, false);
    assert.match(String(token?.detail), /stubbed \/me failure/);
    assert.ok(probes.filter((p) => p.probe !== 'token').every((p) => p.ok === true), 'only the token probe failed');
    assert.match(h.text(out), /✗ token/);
  });

  it('treats a queue outage as degraded rather than throwing', async () => {
    const h = makeHarness({ queue: 'throw' });
    const out = await h.invoke('playback_health_check');
    const probes = h.structured(out).probes as Array<Record<string, unknown>>;
    assert.equal(h.structured(out).healthy, false);
    assert.equal(probes.find((p) => p.probe === 'queue')?.ok, false);
  });
});

// ===========================================================================
// 16-18. listening session sidecars
// ===========================================================================

describe('#668 listening_session_start', () => {
  it('captures the current snapshot into a 0600 sidecar and reports its id', async () => {
    const h = makeHarness();
    const out = await h.invoke('listening_session_start', { label: 'commute' });
    const sc = h.structured(out);
    assert.equal(sc.started, true);
    const session = sc.session as Record<string, unknown>;
    assert.equal(session.label, 'commute');
    const startSnapshot = session.start_snapshot as Record<string, unknown>;
    assert.equal(startSnapshot.track_name, 'First', 'the snapshot really came from the live state');
    assert.equal(startSnapshot.position_ms, 30_000);
    const files = await readdir(tmp);
    assert.equal(files.length, 1);
    const onDisk = JSON.parse(await readFile(join(tmp, files[0] as string), 'utf8')) as Record<string, unknown>;
    assert.equal(onDisk.id, session.id);
    assert.equal((await stat(join(tmp, files[0] as string))).mode & 0o777, 0o600);
  });
});

describe('#668 listening_session_close', () => {
  it('stamps duration and end snapshot onto the open session', async () => {
    const h = makeHarness();
    const started = h.structured(await h.invoke('listening_session_start', {}));
    const id = (started.session as Record<string, unknown>).id as string;
    const out = await h.invoke('listening_session_close', { session_id: id });
    const sc = h.structured(out);
    assert.equal(sc.closed, true);
    const closed = sc.session as Record<string, unknown>;
    assert.equal(closed.closed, true);
    assert.ok(typeof closed.duration_ms === 'number' && (closed.duration_ms as number) >= 0);
    const onDisk = JSON.parse(await readFile(sessionFile(id), 'utf8')) as Record<string, unknown>;
    assert.equal(onDisk.closed, true, 'the close is persisted, not just returned');
    assert.equal((onDisk.end_snapshot as Record<string, unknown>).track_name, 'First');
  });

  it('reports found:false for an unknown session id', async () => {
    const h = makeHarness();
    const out = await h.invoke('listening_session_close', { session_id: 'no-such' });
    assert.equal(h.structured(out).found, false);
    assert.match(h.text(out), /No session found with id "no-such"/);
  });
});

describe('#668 listening_session_report', () => {
  it('reports the most recent session when no id is given', async () => {
    const h = makeHarness();
    await writeJson(sessionFile('2026-09-26T08-00-00-000Z'), {
      id: '2026-09-26T08-00-00-000Z',
      started_at: '2026-09-26T08:00:00.000Z',
      start_snapshot: { track_name: 'Older', device_name: 'Kitchen Speaker' },
    });
    await writeJson(sessionFile('2026-09-27T09-00-00-000Z'), {
      id: '2026-09-27T09-00-00-000Z',
      label: 'morning',
      started_at: '2026-09-27T09:00:00.000Z',
      closed: true,
      closed_at: '2026-09-27T09:30:00.000Z',
      duration_ms: 1_800_000,
      start_snapshot: { track_name: 'Newer', device_name: 'Kitchen Speaker' },
      end_snapshot: { track_name: 'Newer', device_name: 'Desk Computer' },
    });
    const out = await h.invoke('listening_session_report', {});
    const sc = h.structured(out);
    assert.equal(sc.found, true);
    assert.equal((sc.session as Record<string, unknown>).id, '2026-09-27T09-00-00-000Z', 'newest last → last id');
    assert.match(h.text(out), /\(morning\) — closed/);
    assert.match(h.text(out), /Duration: 30m/);
  });

  it('marks an unclosed session as STILL OPEN and omits the closed block', async () => {
    const h = makeHarness();
    await writeJson(sessionFile('open1'), {
      id: 'open1',
      started_at: '2026-09-27T09:00:00.000Z',
      start_snapshot: { track_name: 'Playing', device_name: 'Kitchen Speaker' },
    });
    const out = await h.invoke('listening_session_report', { session_id: 'open1' });
    assert.match(h.text(out), /STILL OPEN/);
    assert.doesNotMatch(h.text(out), /Duration:/);
  });

  it('reports found:false when no session has ever been recorded', async () => {
    const h = makeHarness();
    const out = await h.invoke('listening_session_report', {});
    assert.equal(h.structured(out).found, false);
    assert.match(h.text(out), /No listening sessions recorded/);
  });
});

// ===========================================================================
// 19. transfer_playback_with_state — the multi-step Spotify write
// ===========================================================================

describe('#668 transfer_playback_with_state', () => {
  it('issues the documented PUTs in order against the resolved device', async () => {
    const h = makeHarness({ state: state({ shuffle_state: true, repeat_state: 'track' }) });
    const out = await h.invoke('transfer_playback_with_state', { target_device: 'Desk', dry_run: false });
    assert.equal(h.structured(out).transferred, true);

    const puts = h.calls.filter((c) => c.method === 'PUT');
    assert.deepEqual(puts.map((c) => c.path), [
      '/me/player',
      '/me/player/play?device_id=dev_desk',
      '/me/player/shuffle?state=true&device_id=dev_desk',
      '/me/player/repeat?state=track&device_id=dev_desk',
    ]);
    assert.deepEqual(puts[0]?.body, { device_ids: ['dev_desk'], play: true }, 'the transfer body is the contract');
    assert.deepEqual(puts[1]?.body, { uris: ['spotify:track:t01'], position_ms: 30_000 });
  });

  it('falls back to a seek when the context-less resume is refused', async () => {
    const h = makeHarness({ failWrite: ['/me/player/play'] });
    const out = await h.invoke('transfer_playback_with_state', { target_device: 'dev_desk', dry_run: false });
    const puts = h.calls.filter((c) => c.method === 'PUT');
    assert.deepEqual(puts.map((c) => c.path), [
      '/me/player',
      '/me/player/play?device_id=dev_desk',
      '/me/player/seek?position_ms=30000&device_id=dev_desk',
      '/me/player/shuffle?state=false&device_id=dev_desk',
      '/me/player/repeat?state=off&device_id=dev_desk',
    ]);
    assert.equal(h.structured(out).transferred, true, 'the seek fallback is a success, not a partial failure');
  });

  it('names the steps that failed instead of claiming a clean transfer', async () => {
    // play:false takes the else-branch seek, so the failure lands on `seek`.
    const h = makeHarness({ failWrite: ['/me/player/seek'] });
    const out = await h.invoke('transfer_playback_with_state', { target_device: 'dev_desk', play: false, dry_run: false });
    const sc = h.structured(out);
    assert.equal(sc.transferred, false);
    assert.deepEqual(sc.failed_steps, ['seek']);
    assert.match(h.text(out), /failed steps: seek/);
  });

  it('appends device_id to the shuffle/repeat queries with &, not a second ?', async () => {
    // The regression this file exists for: `?state=false?device_id=X` put the
    // device id inside the `state` value, so the state was never restored.
    const h = makeHarness({ state: state({ shuffle_state: true, repeat_state: 'context' }) });
    await h.invoke('transfer_playback_with_state', { target_device: 'dev_desk', dry_run: false });
    for (const path of h.paths('PUT')) {
      assert.doesNotMatch(path, /\?[^?]*\?/, `"${path}" has two '?' — the second parameter is part of the first value`);
    }
    assert.ok(h.paths('PUT').includes('/me/player/shuffle?state=true&device_id=dev_desk'));
    assert.ok(h.paths('PUT').includes('/me/player/repeat?state=context&device_id=dev_desk'));
  });

  it('refuses to transfer when no device matches, issuing no write at all', async () => {
    const h = makeHarness();
    const out = await h.invoke('transfer_playback_with_state', { target_device: 'Car', dry_run: false });
    assert.equal(h.structured(out).target_found, false);
    assert.deepEqual(h.paths('PUT'), [], 'an unresolved target must not reach the player endpoint');
    assert.match(h.text(out), /No device matches "Car" among 2 device\(s\)\./);
  });

  it('previews the same steps without issuing any of them', async () => {
    const h = makeHarness({ state: state({ shuffle_state: true }) });
    const out = await h.invoke('transfer_playback_with_state', { target_device: 'dev_desk', dry_run: true });
    assert.deepEqual(h.paths('PUT'), []);
    const sc = h.structured(out);
    assert.equal(sc.dry_run, true);
    const steps = sc.steps as string[];
    assert.ok(steps.some((s) => s.startsWith('PUT /me/player/seek?position_ms=30000')), steps.join(' | '));
  });
});

// ===========================================================================
// 20. sleep_timer_plan
// ===========================================================================

describe('#668 sleep_timer_plan', () => {
  it('picks whole items that stay under the target and names the pause call', async () => {
    const h = makeHarness({ queue: { currently_playing: null, queue: [track(1, 600_000), track(2, 600_000), track(3, 600_000)] } });
    const out = await h.invoke('sleep_timer_plan', { minutes: 25 });
    const sc = h.structured(out);
    assert.equal(sc.picked_count, 2, 'the third track would overrun 25 minutes');
    assert.equal(sc.picked_runtime_ms, 1_200_000);
    assert.equal(sc.shortfall_ms, 300_000);
    assert.equal(sc.pause_after_position, 2);
    assert.deepEqual(h.calls.map((c) => c.path), ['/me/player/queue'], 'a planner issues no write');
    assert.match(h.text(out), /PUT \/me\/player\/pause — after queue position 2/);
  });

  it('keeps an item that lands exactly on the target (the boundary is inclusive)', async () => {
    // Three 10-minute items against a 20-minute target. The second lands
    // exactly on it, so a `>=` where the contract is `>` would drop it and
    // report a 10-minute plan with a 10-minute shortfall instead of an exact
    // fit. Without this the loop's comparison operator is unobservable.
    const h = makeHarness({ queue: { currently_playing: null, queue: [track(1, 600_000), track(2, 600_000), track(3, 600_000)] } });
    const sc = h.structured(await h.invoke('sleep_timer_plan', { minutes: 20 }));
    assert.equal(sc.picked_count, 2, 'the second item completes the target exactly and is kept');
    assert.equal(sc.picked_runtime_ms, 1_200_000);
    assert.equal(sc.shortfall_ms, 0);
    assert.equal(sc.pause_after_position, 2);
  });

  it('picks nothing and pauses at position 0 for an empty queue', async () => {
    const h = makeHarness({ queue: { currently_playing: null, queue: [] } });
    const out = await h.invoke('sleep_timer_plan', { minutes: 30 });
    const sc = h.structured(out);
    assert.equal(sc.picked_count, 0);
    assert.equal(sc.picked_runtime_ms, 0);
    assert.equal(sc.pause_after_position, 0);
    assert.equal(sc.shortfall_ms, 1_800_000);
  });
});

// ===========================================================================
// 21. device_type_census
// ===========================================================================

describe('#668 device_type_census', () => {
  it('groups by type in rank order with the volume range of each group', async () => {
    const h = makeHarness({
      devices: [
        device({ id: 'd1', name: 'Speaker A', type: 'Speaker', volume_percent: 30 }),
        device({ id: 'd2', name: 'Speaker B', type: 'Speaker', volume_percent: 70 }),
        device({ id: 'd3', name: 'Desk', type: 'Computer', volume_percent: 10 }),
        device({ id: 'd4', name: 'Remote', type: 'Speaker', volume_percent: null }),
      ],
    });
    const out = await h.invoke('device_type_census');
    const sc = h.structured(out);
    assert.equal(sc.total_devices, 4);
    const groups = sc.groups as Array<Record<string, unknown>>;
    assert.deepEqual(groups.map((g) => g.type), ['Computer', 'Speaker'], 'Computer outranks Speaker');
    assert.equal(groups[0]?.volume_min, 10);
    assert.equal(groups[1]?.count, 3, 'the id-less remote is still a device in the census');
    assert.equal(groups[1]?.volume_min, 30, 'a null volume is excluded from the range, not read as 0');
    assert.equal(groups[1]?.volume_max, 70);
  });

  it('returns an empty group list when no device is available', async () => {
    const h = makeHarness({ devices: [] });
    const out = await h.invoke('device_type_census');
    assert.deepEqual(h.structured(out).groups, []);
    assert.equal(h.structured(out).total_devices, 0);
    assert.match(h.text(out), /across 0 type\(s\)/);
  });
});

// ===========================================================================
// Anti-vacuity
// ===========================================================================

/**
 * The four handlers this module ships that #668 found already covered, each by
 * a dedicated unit. They are named here so the guard below reads as "everything
 * else is covered" rather than silently exempting a growing list: if one of
 * these loses its own coverage, that file's cases stop protecting it and this
 * constant is the place to notice.
 */
const COVERED_ELSEWHERE = new Set([
  'get_context_inspect', // tests/tools.swarm3playback-context.test.ts
  'plan_volume_level_across_devices', // tests/tools.swarm3playback-volume.test.ts
  'apply_volume_plan', // tests/tools.swarm3playback-volume.test.ts
  'resume_playback_position', // tests/tools.swarm3playback-resume.test.ts
]);

describe('#668 anti-vacuity', () => {
  it('registers all 20 playback tools, so a renamed or dropped tool fails here', () => {
    const names = makeHarness().names();
    // #847 retired four of them (`get_queue_snapshot`, `queue_runtime_report`,
    // `queue_duplicate_check`, `predict_next_tracks`), so 24 became 20. The count
    // stays pinned so the NEXT removal is equally loud.
    assert.equal(names.length, 20, `expected the module's 20 tools, got ${names.length}: ${names.join(', ')}`);
    assert.equal(new Set(names).size, 20, 'tool names must be unique');
  });

  it('classifies the two mutating playback tools as writes, not reads', async () => {
    // Guards the readOnly/destructive split for the tools whose names do not
    // start with a read verb. `delete_playback_bookmark` is the destructive one.
    const { classifyToolAnnotations } = await import('../src/tools/annotations.js');
    assert.deepEqual(classifyToolAnnotations('delete_playback_bookmark'), { destructiveHint: true });
    assert.deepEqual(classifyToolAnnotations('transfer_playback_with_state'), { destructiveHint: false });
    assert.deepEqual(classifyToolAnnotations('list_playback_bookmarks'), { readOnlyHint: true, idempotentHint: true });
  });
});

  it('leaves no handler unclaimed: every registered tool is driven here or by a named unit', () => {
    // Runs after the cases above, so `invoked` is complete. It is an `it`, not
    // an `after` hook, so a name-filtered debugging run skips it instead of
    // reporting a false failure against tools it never got to exercise.
    const names = makeHarness().names();
    const unclaimed = names.filter((n) => !invoked.has(n) && !COVERED_ELSEWHERE.has(n));
    assert.deepEqual(
      unclaimed,
      [],
      `these swarm3_playback handlers are registered but no test invokes them: ${unclaimed.join(', ')}`,
    );
    const stale = [...COVERED_ELSEWHERE].filter((n) => !names.includes(n));
    assert.deepEqual(stale, [], `COVERED_ELSEWHERE names tools this module no longer registers: ${stale.join(', ')}`);
    // 20 when #668 measured it; 16 after #847 retired the four queue readers
    // whose cases moved to tests/queue.tools.test.ts. The assertion is a floor on
    // COVERAGE, not a record of the old number, so it tracks what is still here.
    assert.equal(invoked.size, 16, `this file should drive the 16 remaining uncovered tools; it drove ${invoked.size}`);
  });
