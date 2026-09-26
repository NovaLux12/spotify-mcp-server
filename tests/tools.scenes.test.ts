/**
 * Tests for src/tools/scenes.ts (#112 ideas 7+12): named playback scenes in a
 * local JSON sidecar plus the in-process wind-down ramp with an injectable
 * timer seam (no real timers ever fire here).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import {
  registerScenesTools,
  loadScenes,
  scenesFilePath,
  computeWindDownSchedule,
  __setWindDownScheduler,
  type WindDownTimers,
  type WindDownHandle,
  activeWindDown,
  windDownStatus,
} from '../src/tools/scenes.js';

// ---------------------------------------------------------------------------
// Stub plumbing (mirrors tests/tools.playlists-following.test.ts)
// ---------------------------------------------------------------------------

interface RecordedCall {
  method: 'GET' | 'POST' | 'PUT' | 'PUT_RAW' | 'DELETE';
  path: string;
  arg?: unknown;
}

type Responder = (path: string, arg: unknown) => unknown;

interface RegisteredTool {
  name: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (
    args: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  }>;
}

const wireCalls = (calls: RecordedCall[]) =>
  calls.map((c) => ({ method: c.method, path: c.path, arg: c.arg }));

function makeStubClient(responder: Responder = () => null) {
  const calls: RecordedCall[] = [];
  let respond: Responder = responder;
  const client = {
    calls,
    setResponder(fn: Responder) {
      respond = fn;
    },
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      calls.push({ method: 'GET', path, arg: params });
      return respond(path, params) as T | null;
    },
    async post<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'POST', path, arg: body });
      return respond(path, body) as T | null;
    },
    async put<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'PUT', path, arg: body });
      return respond(path, body) as T | null;
    },
    async putRaw(path: string, body: string): Promise<void> {
      calls.push({ method: 'PUT_RAW', path, arg: body });
    },
    async delete<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'DELETE', path, arg: body });
      return respond(path, body) as T | null;
    },
    async getAllPages<T>(): Promise<T[]> {
      return [];
    },
  };
  return client;
}

function harness(responder: Responder = () => null) {
  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(
      name: string,
      _description: string,
      schema: z.ZodRawShape,
      handler: RegisteredTool['handler'],
    ) {
      registered.push({
        name,
        validate: (args) => z.object(schema).parse(args),
        handler,
      });
    },
  } as unknown as McpServer;
  const client = makeStubClient(responder);
  registerScenesTools(fakeServer, client as unknown as SpotifyClient);
  return {
    registered,
    client,
    invoke: async (name: string, args: Record<string, unknown>) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

const textOf = (out: { content: Array<{ text: string }> }) => out.content[0].text;
interface SceneHarness {
  registered: RegisteredTool[];
  client: StubSpotifyClient;
  invoke(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> }>;
}

interface StubSpotifyClient {
  calls: RecordedCall[];
  setResponder(fn: Responder): void;
}

// ---------------------------------------------------------------------------
// Fake timer scheduler (test seam) — no real timers ever armed
// ---------------------------------------------------------------------------

function makeFakeTimers() {
  const scheduled: Array<{ fn: () => void; ms: number } & WindDownHandle> = [];
  const cleared: WindDownHandle[] = [];
  const delays: number[] = [];
  let now = 0;
  const timers: WindDownTimers = {
    setTimeout(fn: () => void, ms: number) {
      const handle = { fn, ms };
      scheduled.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      cleared.push(handle);
    },
    now: () => now,
  };
  /** Fire due callbacks one at a time, letting async continuations settle. */
  const drain = async (): Promise<void> => {
    for (let guard = 0; guard < 100 && scheduled.length > 0; guard++) {
      const timer = scheduled.shift()!;
      delays.push(timer.ms);
      now += timer.ms;
      timer.fn();
      const { promise, resolve } = Promise.withResolvers<void>();
      setImmediate(resolve);
      await promise;
    }
  };
  return { timers, scheduled, cleared, delays, drain };
}

// ---------------------------------------------------------------------------
// Sidecar fixture helpers
// ---------------------------------------------------------------------------

let sideDir: string;
let sideFile: string;

beforeEach(async () => {
  sideDir = await mkdtemp(join(tmpdir(), 'scenes-test-'));
  sideFile = join(sideDir, 'nested', 'scenes.json');
  process.env.SPOTIFY_MCP_SCENES_FILE = sideFile;
});

afterEach(async () => {
  __setWindDownScheduler(null); // restore real timers
  delete process.env.SPOTIFY_MCP_SCENES_FILE;
  await rm(sideDir, { recursive: true, force: true });
});

const deviceList = () => ({
  devices: [
    { id: 'dev-living', name: 'Living Room', type: 'Speaker', is_active: false, is_restricted: false, is_private_session: false, volume_percent: 30, supports_volume: true },
    { id: 'dev-kitchen', name: 'Kitchen Speaker', type: 'Speaker', is_active: true, is_restricted: false, is_private_session: false, volume_percent: 55, supports_volume: true },
  ],
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('scenes module registrations', () => {
  it('registers all seven scene tools exactly once', () => {
    const { registered } = harness();
    assert.deepEqual(registered.map((t) => t.name).sort(), [
      'apply_scene',
      'cancel_wind_down',
      'delete_scene',
      'list_scenes',
      'save_scene',
      'schedule_wind_down',
      'wind_down_status',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Sidecar store
// ---------------------------------------------------------------------------

describe('sidecar round-trip + permissions', () => {
  it('save_scene writes owner-only file/dir and round-trips through loadScenes', async () => {
    const h = harness();
    const out = await h.invoke('save_scene', {
      name: 'focus',
      device_hint: 'living',
      volume: 42,
      shuffle: false,
      repeat: 'off',
    });
    assert.match(textOf(out), /Saved scene "focus"/);

    // Created nested dirs at 0700 and the file at 0600.
    const dirStat = await stat(join(sideDir, 'nested'));
    assert.equal(dirStat.mode & 0o777, 0o700, 'sidecar dir must be 0700');
    const fileStat = await stat(sideFile);
    assert.equal(fileStat.mode & 0o777, 0o600, 'sidecar file must be 0600');

    const store = await loadScenes();
    assert.deepEqual(store['focus'], { device_hint: 'living', volume: 42, shuffle: false, repeat: 'off' });
  });

  it('list_scenes reflects saved scenes; delete_scene removes them persistently', async () => {
    const h = harness();
    await h.invoke('save_scene', { name: 'sleep', volume: 5, context_uri: 'spotify:playlist:abc' });

    const listed = await h.invoke('list_scenes', {});
    assert.match(textOf(listed), /sleep/);
    assert.match(textOf(listed), /vol 5/);

    const del = await h.invoke('delete_scene', { name: 'sleep' });
    assert.match(textOf(del), /Deleted scene "sleep"/);
    assert.deepEqual(await loadScenes(), {});

    const missing = await h.invoke('delete_scene', { name: 'sleep' });
    assert.match(textOf(missing), /No scene named/);
  });

  it('honours SPOTIFY_MCP_SCENES_FILE override', () => {
    assert.equal(scenesFilePath({ SPOTIFY_MCP_SCENES_FILE: '/tmp/x/scenes.json' }), '/tmp/x/scenes.json');
    assert.match(scenesFilePath({}), /\.spotify-mcp[/\\]scenes\.json$/);
  });
});

// ---------------------------------------------------------------------------
// save_scene validation
// ---------------------------------------------------------------------------

describe('save_scene up-front validation', () => {
  const h = harness();
  const validateOf = (name: string) => h.registered.find((t) => t.name === name)!.validate;

  it('rejects out-of-range volume', () => {
    assert.throws(() => validateOf('save_scene')({ name: 'bad', volume: 150 }), /too_big|<=|less/i);
    assert.throws(() => validateOf('save_scene')({ name: 'bad', volume: -1 }));
  });

  it('rejects invalid repeat enum', () => {
    assert.throws(() => validateOf('save_scene')({ name: 'bad', repeat: 'loud' }), /invalid_enum|Invalid/i);
  });

  it('accepts boundary volume 0 and 100', async () => {
    await h.invoke('save_scene', { name: 'mute', volume: 0 });
    await h.invoke('save_scene', { name: 'loud', volume: 100 });
    assert.equal((await loadScenes())['loud']!.volume, 100);
  });
});

// ---------------------------------------------------------------------------
// apply_scene
// ---------------------------------------------------------------------------
describe('apply_scene device-hint resolution', () => {
  const makeScene = async (h: SceneHarness, name: string, hint: string) => {
    await h.invoke('save_scene', { name, device_hint: hint, volume: 40, shuffle: true, repeat: 'track' });
  };

  it('resolves case-insensitive name substring', async () => {
    const h = harness(deviceList);
    await makeScene(h, 'cook', 'kitchen'); // lowercase vs "Kitchen Speaker"
    await h.invoke('apply_scene', { name: 'cook' });
    const muts = wireCalls(h.client.calls).filter((c) => c.method === 'PUT');
    assert.ok(muts.some((c) => c.path === '/me/player' && JSON.stringify(c.arg ?? {}).includes('dev-kitchen')), 'transfer targets kitchen id');
    assert.ok(muts.some((c) => c.path.includes('volume_percent=40') && c.path.includes('device_id=dev-kitchen')));
  });

  it('exact device id wins over name matching', async () => {
    const h = harness(deviceList);
    await makeScene(h, 'idscene', 'dev-living'); // matches no name but IS an id
    await h.invoke('apply_scene', { name: 'idscene' });
    const transfer = wireCalls(h.client.calls).find((c) => c.path === '/me/player');
    assert.ok(transfer, 'transfer issued');
    assert.deepEqual(transfer.arg, { device_ids: ['dev-living'] });
  });

  it('unmatched hint skips every device-scoped step without touching the active device', async () => {
    const h = harness(deviceList);
    await makeScene(h, 'ghost', 'garage speaker');
    const out = await h.invoke('apply_scene', { name: 'ghost' });
    const text = textOf(out);
    assert.match(text, /skipped/);
    // Zero mutating calls reached the API — nothing was retuned by accident.
    const muts = wireCalls(h.client.calls).filter((c) => c.method !== 'GET');
    assert.deepEqual(muts.map((c) => c.method), []);
    assert.match(text, /0 applied/);
  });
});

describe('apply_scene ordering', () => {
  it('applies transfer → volume → shuffle → repeat → play in strict order', async () => {
    const h = harness(deviceList);
    await h.invoke('save_scene', {
      name: 'full',
      device_hint: 'Living Room',
      volume: 25,
      shuffle: false,
      repeat: 'context',
      context_uri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M',
    });
    await h.invoke('apply_scene', { name: 'full' });

    const muts = wireCalls(h.client.calls).filter((c) => c.method === 'PUT');
    const paths = muts.map((c) => c.path.split('?')[0]);
    assert.deepEqual(paths, ['/me/player', '/me/player/volume', '/me/player/shuffle', '/me/player/repeat', '/me/player/play']);

    const [transfer, vol, shuf, rep, play] = muts;
    assert.deepEqual(transfer!.arg, { device_ids: ['dev-living'] });
    assert.match(vol!.path, /volume_percent=25/);
    assert.match(vol!.path, /device_id=dev-living/);
    assert.match(shuf!.path, /state=false/);
    assert.match(rep!.path, /state=context/);
    assert.match(play!.path, /device_id=dev-living/);
    assert.deepEqual(play!.arg, { context_uri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M' });
  });

  it('reports not-found scene names with available alternatives', async () => {
    const h = harness();
    const out = await h.invoke('apply_scene', { name: 'nope' });
    assert.match(textOf(out), /No scene named "nope"/);
  });
});

describe('apply_scene dry_run', () => {
  it('performs only the read-only resolution and zero mutations', async () => {
    const h = harness(deviceList);
    await h.invoke('save_scene', {
      name: 'preview',
      device_hint: 'kitchen',
      volume: 33,
      shuffle: true,
      repeat: 'off',
      context_uri: 'spotify:album:xyz',
    });
    const out = await h.invoke('apply_scene', { name: 'preview', dry_run: true });

    // Exactly one read-only call (device resolution); nothing else hits the wire.
    const kinds = wireCalls(h.client.calls).map((c) => `${c.method} ${c.path}`);
    assert.deepEqual(kinds.filter((k) => !k.startsWith('GET /me/player/devices')), [], 'zero non-resolution calls');

    const text = textOf(out);
    assert.match(text, /\[dry run\]/);
    assert.match(text, /Nothing was changed\./);
    assert.match(text, /device_ids.*dev-kitchen/);

    assert.equal(out.structuredContent?.dry_run, true);
    assert.equal(out.structuredContent?.ok, true);
  });

  it('dry_run lists skipped steps for unmatched hints too', async () => {
    const h = harness(deviceList);
    await h.invoke('save_scene', { name: 'gone', device_hint: 'boat', volume: 10 });
    const out = await h.invoke('apply_scene', { name: 'gone', dry_run: true });
    assert.match(textOf(out), /SKIP/);
    assert.match(textOf(out), /Nothing was changed\./);
  });
});

// #1084: a pre-existing scenes.json that was copied in with a world-readable
// mode must be tightened to 0600 when the server writes through `save_scene`.
describe('scene sidecar file mode (#1084)', () => {
  it('tightens a world-readable pre-existing scenes.json to 0600 on write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scenes-mode-'));
    try {
      const file = join(dir, 'nested', 'scenes.json');
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ stale: { device_hint: 'old' } }), { mode: 0o644 });
      await chmod(file, 0o644);
      const prev = process.env.SPOTIFY_MCP_SCENES_FILE;
      process.env.SPOTIFY_MCP_SCENES_FILE = file;
      try {
        const h = harness(deviceList);
        await h.invoke('save_scene', { name: 'fresh', device_hint: 'Living' });
        assert.equal((await stat(file)).mode & 0o777, 0o600);
      } finally {
        if (prev === undefined) delete process.env.SPOTIFY_MCP_SCENES_FILE;
        else process.env.SPOTIFY_MCP_SCENES_FILE = prev;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Wind-down math
// ---------------------------------------------------------------------------

describe('computeWindDownSchedule', () => {
  it('steps linearly down to the floor then clamps', () => {
    // 80 → 10 over 30m @5m steps: 6 steps, decrement ceil(70/6)=12.
    assert.deepEqual(computeWindDownSchedule(80, 30, 5, 10), [
      { at_minute: 5, volume: 68 },
      { at_minute: 10, volume: 56 },
      { at_minute: 15, volume: 44 },
      { at_minute: 20, volume: 32 },
      { at_minute: 25, volume: 20 },
      { at_minute: 30, volume: 10 },
    ]);
  });

  it('uses minimum decrement 1 when the span is small', () => {
    // 15 → 10 over 60m @10m: 6 steps of −1.
    assert.deepEqual(computeWindDownSchedule(15, 60, 10, 10), [
      { at_minute: 10, volume: 14 },
      { at_minute: 20, volume: 13 },
      { at_minute: 30, volume: 12 },
      { at_minute: 40, volume: 11 },
      { at_minute: 50, volume: 10 },
      { at_minute: 60, volume: 10 },
    ]);
  });

  it('never schedules fewer than one step', () => {
    assert.equal(computeWindDownSchedule(50, 3, 5, 10).length >= 1, true);
  });
});

// ---------------------------------------------------------------------------
// schedule_wind_down / cancel_wind_down (fake scheduler, no real timers)
// ---------------------------------------------------------------------------

describe('schedule_wind_down', () => {
  it('errors when there is no active device to capture volume from', async () => {
    const h = harness(() => null); // GET /me/player → null (204-like)
    const fake = makeFakeTimers();
    __setWindDownScheduler(fake.timers);
    const out = await h.invoke('schedule_wind_down', { minutes: 30 });
    assert.match(textOf(out), /No active device/);
    assert.equal(fake.scheduled.length, 0, 'no timers armed on failure');
  });

  it('arms the injected scheduler (not real timers) and executes volume→pause chain', async () => {
    const h = harness((path) => {
      if (path === '/me/player') {
        return { is_playing: true, device: { id: 'dev-living', volume_percent: 80 } };
      }
      return null;
    });
    const fake = makeFakeTimers();
    __setWindDownScheduler(fake.timers);

    // Prove real setTimeout stays untouched while the tool arms its chain.
    const realSetTimeout = globalThis.setTimeout;
    let realArmed = false;
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((fn: never, ms?: number) => {
      realArmed = true;
      return realSetTimeout(fn, ms);
    }) as typeof setTimeout;

    try {
      const out = await h.invoke('schedule_wind_down', { minutes: 10, step_minutes: 5, floor_volume: 10, device_id: 'dev-living' });
      const echo = out.structuredContent!;
      // 80 → 10 over 2 steps: decrement ceil(70/2)=35 → [45, 10], pause one step later.
      assert.deepEqual(echo.schedule, [
        { at_minute: 5, volume: 45 },
        { at_minute: 10, volume: 10 },
      ]);
      assert.equal(echo.pause_at_minute, 15);
      assert.equal(fake.scheduled.length, 1, 'only the first tick armed eagerly');
      assert.equal(realArmed, false, 'real setTimeout never used');
      assert.match(textOf(out), /Wind-down started from volume 80/);
      assert.match(
        textOf(out),
        /The fade runs only while this MCP server process is running — closing the client cancels it\./,
        'no-daemon disclaimer must be stated plainly',
      );

      // Drain the whole chain through the fake scheduler.
      await fake.drain();

      const puts = wireCalls(h.client.calls).filter((c) => c.method === 'PUT');
      assert.deepEqual(
        puts.map((c) => c.path),
        [
          '/me/player/volume?volume_percent=45&device_id=dev-living',
          '/me/player/volume?volume_percent=10&device_id=dev-living',
          '/me/player/pause?device_id=dev-living',
        ],
      );
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  it('anchors 30-minute fade steps to one wall-clock start without cumulative drift', async () => {
    const h = harness(() => ({ device: { volume_percent: 50 } }));
    const fake = makeFakeTimers();
    await h.invoke('cancel_wind_down', {});

    __setWindDownScheduler(fake.timers);
    const out = await h.invoke('schedule_wind_down', { minutes: 30, step_minutes: 5 });
    await fake.drain();

    assert.deepEqual(fake.delays, Array(7).fill(5 * 60_000));
    assert.equal(out.structuredContent!.pause_at_minute, 35);
  });
  it('previews the exact schedule without arming or replacing the active fade', async () => {
    const h = harness(() => ({ device: { id: 'dev-live', volume_percent: 80 } }));
    const fake = makeFakeTimers();
    await h.invoke('cancel_wind_down', {});
    __setWindDownScheduler(fake.timers);
    const args = { minutes: 15, step_minutes: 5, device_id: 'dev-live' };
    const preview = await h.invoke('schedule_wind_down', { ...args, dry_run: true });

    assert.equal(activeWindDown(), null, 'preview does not create active state');
    assert.equal(fake.scheduled.length, 0, 'preview arms no timer');
    assert.equal(h.client.calls.filter((call) => call.method === 'PUT').length, 0);

    const live = await h.invoke('schedule_wind_down', args);
    const active = activeWindDown()!;
    const armed = fake.scheduled[0];
    const activePreview = await h.invoke('schedule_wind_down', { ...args, dry_run: true });

    assert.equal(activeWindDown(), active, 'preview leaves the live state object untouched');
    assert.equal(active.steps_applied, 0);
    assert.equal(fake.scheduled.length, 1);
    assert.equal(fake.scheduled[0], armed, 'preview arms no replacement timer');
    assert.deepEqual(activePreview.structuredContent!.schedule, live.structuredContent!.schedule);
    assert.equal(activePreview.structuredContent!.pause_at_minute, live.structuredContent!.pause_at_minute);
    assert.deepEqual(preview.structuredContent!.schedule, live.structuredContent!.schedule);
    assert.equal(preview.structuredContent!.pause_at_minute, live.structuredContent!.pause_at_minute);
    assert.match(textOf(preview), /dry run/i);
    await h.invoke('cancel_wind_down', {});
  });

  it('records the rejected volume step and preserves earlier progress', async () => {
    let volumeWrites = 0;
    const h = harness((path) => {
      if (path === '/me/player') return { device: { volume_percent: 80 } };
      if (path.startsWith('/me/player/volume') && ++volumeWrites === 2) {
        throw new Error('403 Premium required');
      }
      return null;
    });
    const fake = makeFakeTimers();
    __setWindDownScheduler(fake.timers);
    await h.invoke('schedule_wind_down', { minutes: 15, step_minutes: 5 });
    await fake.drain();

    assert.equal(activeWindDown(), null, 'failed chain leaves no pending timer');
    assert.deepEqual(
      { state: windDownStatus()!.state, applied: windDownStatus()!.steps_applied, failed: windDownStatus()!.steps_failed, last: windDownStatus()!.last_error },
      { state: 'failed', applied: 1, failed: 1, last: '403 Premium required' },
    );
    assert.deepEqual(windDownStatus()!.failures[0], { step: 2, at_minute: 10, action: 'volume', error: '403 Premium required' });
    const status = await h.invoke('wind_down_status', {});
    assert.match(textOf(status), /2 \(volume, \+10m\): 403 Premium required/);
    assert.equal(volumeWrites, 2, 'remaining steps are not attempted after a hard failure');
  });

  it('records a rejected terminal pause after applying the volume', async () => {
    const h = harness((path) => {
      if (path === '/me/player') return { device: { volume_percent: 50 } };
      if (path === '/me/player/pause') throw new Error('404 device unavailable');
      return null;
    });
    const fake = makeFakeTimers();
    __setWindDownScheduler(fake.timers);
    await h.invoke('schedule_wind_down', { minutes: 5, step_minutes: 5 });
    await fake.drain();

    assert.equal(windDownStatus()!.steps_applied, 1);
    assert.equal(windDownStatus()!.steps_failed, 1);
    assert.equal(windDownStatus()!.failures[0]!.action, 'pause');
    assert.equal(windDownStatus()!.last_error, '404 device unavailable');
  });

});

describe('cancel_wind_down', () => {
  it('clears pending timers so later ticks never execute', async () => {
    const h = harness(() => ({ device: { volume_percent: 80 } }));
    const fake = makeFakeTimers();
    await h.invoke('cancel_wind_down', {}); // drop any prior ramp BEFORE the fake is counting
    __setWindDownScheduler(fake.timers);
    await h.invoke('schedule_wind_down', { minutes: 10, step_minutes: 5, floor_volume: 10, device_id: 'dev-x' });
    assert.equal(fake.scheduled.length, 1);

    const cancelled = await h.invoke('cancel_wind_down', {});
    assert.match(textOf(cancelled), /Cancelled 1 wind-down/);
    assert.equal(fake.cleared.length, 1, 'armed handle cleared');

    const putsBefore = h.client.calls.filter((c) => c.method === 'PUT').length;
    await fake.drain(); // firing stale handles must be inert
    const putsAfter = h.client.calls.filter((c) => c.method === 'PUT').length;
    assert.equal(putsBefore, putsAfter, 'no further volume/pause calls after cancel');

    const again = await h.invoke('cancel_wind_down', {});
    assert.match(textOf(again), /No active wind-down/);
  });

  it('scheduling a new wind-down cancels the previous one (single active)', async () => {
    const h = harness(() => ({ device: { volume_percent: 60 } }));
    const fake = makeFakeTimers();
    __setWindDownScheduler(fake.timers);

    await h.invoke('schedule_wind_down', { minutes: 5, step_minutes: 1, device_id: 'dev-a' });
    assert.ok(activeWindDown(), 'first ramp is live');
    const firstHandle = fake.scheduled[0]!;

    await h.invoke('schedule_wind_down', { minutes: 5, step_minutes: 1, device_id: 'dev-b' });
    assert.equal(activeWindDown()!.key, 'dev-b', 'second ramp replaced the first');
    assert.ok(fake.cleared.includes(firstHandle), 'previous chain cleared on replace');

    await h.invoke('cancel_wind_down', {}); // cleanup
    assert.equal(activeWindDown(), null);
  });

  it('cancel with a mismatching device_id leaves the active ramp running', async () => {
    const h = harness(() => ({ device: { volume_percent: 60 } }));
    const fake = makeFakeTimers();
    __setWindDownScheduler(fake.timers);

    await h.invoke('schedule_wind_down', { minutes: 5, step_minutes: 1, device_id: 'dev-a' });
    const out = await h.invoke('cancel_wind_down', { device_id: 'dev-zzz' });
    assert.match(textOf(out), /No active wind-down/);
    assert.ok(activeWindDown(), 'ramp untouched');
    await h.invoke('cancel_wind_down', {}); // cleanup
  });
});

describe('default scheduler unrefs timers', () => {
  it('real scheduler calls .unref() so fades never hold the process open', async () => {
    const h = harness(() => ({ device: { volume_percent: 40 } }));
    __setWindDownScheduler(null); // exercise the DEFAULT (real) scheduler

    // Spy global setTimeout: return an inert stub instead of arming real time.
    const realSetTimeout = globalThis.setTimeout;
    let unrefCalls = 0;
    let spyArms = 0;
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((_fn: never, _ms?: number) => ({
      unref: () => {
        unrefCalls++;
        return {} as never;
      },
      ref: () => ({}) as never,
      [Symbol.toPrimitive]: () => spyArms++,
    })) as unknown as typeof setTimeout;

    try {
      await h.invoke('schedule_wind_down', { minutes: 10, step_minutes: 5 });
      assert.equal(unrefCalls, 1, 'armed timer handle was unref’d');
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    await h.invoke('cancel_wind_down', {});
  });
});
