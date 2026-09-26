import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerExhaust2PlaybackTools,
  exhaust2PlaybackFile,
  loadExhaust2Store,
  saveExhaust2Store,
  humanGap,
  hashString,
  mulberry32,
  computeRampPlan,
  listExhaust2Timers,
  cancelExhaust2Timer,
  exhaust2TimerStatus,
  __setExhaust2Scheduler,
  type Exhaust2TimerHandle,
  type Exhaust2TimerScheduler,
} from '../src/tools/exhaust2_playback.js';

// ---------------------------------------------------------------- fixtures

type ToolContent = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type RegisteredTool = {
  name: string;
  description: string;
  schema: Record<string, { safeParse(value: unknown): { success: boolean } }>;
  handler: (args: Record<string, unknown>) => Promise<ToolContent>;
};

type Call = { method: string; path: string; params?: Record<string, string>; body?: unknown };

interface ClientOptions {
  getResponse?: (path: string, params?: Record<string, string>) => unknown;
  getError?: (path: string, params?: Record<string, string>) => unknown;
  putError?: (path: string, body?: unknown) => unknown;
}

function makeHarness(
  register: (server: never, client: never) => void,
  opts: ClientOptions = {},
) {
  const calls: Call[] = [];
  const client = {
    get: async (path: string, params?: Record<string, string>) => {
      const err = opts.getError?.(path, params);
      if (err !== undefined) {
        calls.push(params === undefined ? { method: 'GET', path } : { method: 'GET', path, params });
        throw err;
      }
      calls.push(params === undefined ? { method: 'GET', path } : { method: 'GET', path, params });
      return opts.getResponse?.(path, params);
    },
    put: async (path: string, body?: unknown) => {
      calls.push({ method: 'PUT', path, body });
      const error = opts.putError?.(path, body);
      if (error !== undefined) throw error;
    },
    post: async (path: string, body?: unknown) => {
      calls.push({ method: 'POST', path, body });
      return { id: 'pl1', uri: 'spotify:playlist:pl1' };
    },
    delete: async () => null,
  };
  const tools = new Map<string, RegisteredTool>();
  const server = {
    tool(
      name: string,
      description: string,
      schema: Record<string, { safeParse(value: unknown): { success: boolean } }>,
      handler: (args: Record<string, unknown>) => Promise<ToolContent>,
    ) {
      tools.set(name, { name, description, schema, handler });
    },
  };
  register(server as never, client as never);
  function findTool(name: string): RegisteredTool {
    const t = tools.get(name);
    if (!t) throw new Error(`tool not registered: ${name}`);
    return t;
  }
  async function invoke(name: string, args: Record<string, unknown> = {}): Promise<ToolContent> {
    return findTool(name).handler(args);
  }
  return { tools, calls, client, findTool, invoke };
}

const text = (out: ToolContent): string => out.content.map((c) => c.text).join('\n');

function makeFakePlaybackTimers() {
  const scheduled: Array<{ fn: () => void | Promise<void>; ms: number } & Exhaust2TimerHandle> = [];
  const cleared: Exhaust2TimerHandle[] = [];
  const scheduler: Exhaust2TimerScheduler = {
    setTimeout(fn, ms) {
      const handle = { fn, ms };
      scheduled.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      cleared.push(handle);
    },
  };
  const drain = async (): Promise<void> => {
    for (let guard = 0; guard < 100 && scheduled.length > 0; guard++) {
      await scheduled.shift()!.fn();
    }
  };
  return { scheduler, scheduled, cleared, drain };
}

afterEach(() => {
  cancelExhaust2Timer('sleep_timer');
  cancelExhaust2Timer('volume_ramp');
  __setExhaust2Scheduler(null);
});

const device = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'dev1',
  name: 'Kitchen',
  type: 'Speaker',
  is_active: false,
  is_restricted: false,
  volume_percent: 40,
  ...over,
});

const playbackState = (over: Record<string, unknown> = {}) => ({
  device: device({ is_active: true, volume_percent: 55 }),
  repeat_state: 'off',
  shuffle_state: false,
  is_playing: true,
  progress_ms: 90_000,
  item: { id: 'trk1', name: 'Song A', uri: 'spotify:track:trk1', type: 'track', artists: [{ name: 'Artist X' }], duration_ms: 200_000, album: { name: 'Album 1' } },
  ...over,
});

const recentRow = (uri: string, played_at: string, name = 'Song') => ({
  track: { uri, name, type: 'track', artists: [{ name: 'Artist X' }], duration_ms: 200_000 },
  played_at,
  context: { uri: 'spotify:album:alb1', type: 'album' },
});

/** Wipe the exhaust2 sidecar so a test starts from a clean slate. */
async function resetSidecar(): Promise<void> {
  await saveExhaust2Store({ muteMemory: {}, episodeBookmarks: {}, checkpoints: {} });
}
/** Remove the sidecar entirely (loadExhaust2Store then returns defaults). */
async function clearSidecar(): Promise<void> {
  await rm(exhaust2PlaybackFile(), { force: true });
}

// sidecar isolation per test file run
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
const tmpRoot = await mkdtemp(join(tmpdir(), 'exhaust2-pb-'));
process.env.SPOTIFY_MCP_EXHAUST2_PLAYBACK_FILE = join(tmpRoot, 'sidecar.json');
process.env.SPOTIFY_MCP_PLAYBACKEXT_FILE = join(tmpRoot, 'playback-ext.json');

// ---------------------------------------------------------------- pure helpers

test('humanGap formats minutes, hours and days', () => {
  assert.equal(humanGap(5 * 60_000), '5m');
  assert.equal(humanGap(90 * 60_000), '1h 30m');
  assert.equal(humanGap(72 * 60 * 60_000), '3d 0h');
});

test('mulberry32 is deterministic per seed and hashString stable', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  assert.deepEqual([a(), a()], [b(), b()]);
  assert.equal(hashString('2026-08-27'), hashString('2026-08-27'));
  assert.notEqual(hashString('a'), hashString('b'));
});

test('computeRampPlan: even steps, last step lands on target', () => {
  const plan = computeRampPlan(60, 30, 5, 1);
  assert.equal(plan.length, 5);
  assert.equal(plan[plan.length - 1]!.percent, 30);
  assert.equal(plan[0]!.percent, 54); // 60 + (30-60)*1/5 = 54
  assert.ok(plan[0]!.after_minutes < plan[plan.length - 1]!.after_minutes);
  const up = computeRampPlan(10, 90, 10, 5);
  assert.equal(up.length, 2);
  assert.equal(up[up.length - 1]!.percent, 90);
});

// ---------------------------------------------------------------- registration

test('all 23 exhaust2 playback tools are registered with quota notes', () => {
  const { tools } = makeHarness(registerExhaust2PlaybackTools);
  const expected = [
    'sleep_timer', 'mute', 'unmute', 'switch_device', 'surprise_me',
    'skip_n', 'pause_everywhere', 'volume_ramp', 'playback_timer_status',
    'episode_bookmark', 'episode_resume', 'queue_next_episode', 'queue_replace_via_playlist',
    'session_stats', 'most_replayed', 'last_heard',
    'weekday_heatmap', 'queue_profile',
    'checkpoint_playback', 'continue_last',
    'room_level', 'volume_report', 'daily_pick',
  ];
  for (const name of expected) {
    const t = tools.get(name);
    assert.ok(t, `missing tool: ${name}`);
    assert.match(t.description, /Quota:/);
  }
  assert.equal(tools.size, expected.length);
});

// ---------------------------------------------------------------- timers & sidecar

test('timer registry: cancel-safe replacement and cancel', () => {
  assert.equal(listExhaust2Timers().length, 0);
  // cancelExhaust2Timer with nothing active is a no-op returning false
  assert.equal(cancelExhaust2Timer('sleep_timer'), false);
});

test('sidecar store round-trips and defaults sanely', async () => {
  await resetSidecar();
  const empty = await loadExhaust2Store();
  assert.deepEqual(empty, { muteMemory: {}, episodeBookmarks: {}, checkpoints: {} });
  const store = { muteMemory: { active: { volume: 42, muted_at: '2026-08-27T10:00:00Z', device_id: null, device_name: null } }, episodeBookmarks: {}, checkpoints: {} };
  await saveExhaust2Store(store);
  const loaded = await loadExhaust2Store();
  assert.equal(loaded.muteMemory.active?.volume, 42);
  assert.match(exhaust2PlaybackFile(), /sidecar\.json$/);
});

// #1051: a corrupt sidecar must NOT silently read as an empty store, or the
// next mutating call would overwrite the user's hand-curated data with a
// default-shaped stub. The bytes survive at <path>.corrupt and the tool errors
// out so the caller can decide whether to repair or stop.
test('#1051 corrupt sidecar: tool throws and bytes are preserved', async () => {
  await resetSidecar();
  const file = exhaust2PlaybackFile();
  const corrupt = '{oops';
  await writeFile(file, corrupt, 'utf8');
  const h = makeHarness(registerExhaust2PlaybackTools, { getResponse: (p) => (p === '/me/player' ? playbackState() : undefined) });
  try {
    await assert.rejects(
      h.invoke('checkpoint_playback', { note: 'should never save' }),
      /is not valid JSON/,
    );
    // The corrupt bytes survive at <file>.corrupt; the original is still on
    // disk and byte-identical, so the user can repair from either copy.
    const corruptBackup = `${file}.corrupt`;
    assert.equal(await readFile(corruptBackup, 'utf8'), corrupt, 'preserved copy must be byte-identical');
    assert.equal(await readFile(file, 'utf8'), corrupt, 'original must remain on disk');
  } finally {
    // Restore the sidecar so subsequent tests in this file start from a clean
    // empty store rather than from the corrupt bytes we just preserved.
    await resetSidecar();
    await rm(`${file}.corrupt`, { force: true });
    await rm(`${file}.corrupt.1`, { force: true });
    await rm(`${file}.corrupt.2`, { force: true });
  }
});

test('#1051 corrupt sidecar: missing collection shape throws (not silently dropped)', async () => {
  await resetSidecar();
  const file = exhaust2PlaybackFile();
  await writeFile(file, JSON.stringify({ muteMemory: 'oops' }), 'utf8');
  try {
    await assert.rejects(
      loadExhaust2Store(),
      /"muteMemory" is not a JSON object/,
    );
    const corruptBackup = `${file}.corrupt`;
    assert.equal((await readFile(corruptBackup, 'utf8')).length > 0, true, 'preserved copy must exist');
  } finally {
    await resetSidecar();
    await rm(`${file}.corrupt`, { force: true });
    await rm(`${file}.corrupt.1`, { force: true });
  }
});

// ---------------------------------------------------------------- sleep_timer

test('sleep_timer dry run registers nothing and discloses the plan', async () => {
  const { invoke, calls } = makeHarness(registerExhaust2PlaybackTools, { getResponse: (p) => (p === '/me/player' ? playbackState() : undefined) });
  const out = await invoke('sleep_timer', { duration_min: 30, dry_run: true });
  assert.match(text(out), /dry run/i);
  assert.match(text(out), /pause/i);
  assert.equal(listExhaust2Timers().length, 0);
  assert.equal(calls.length, 1); // only the GET /me/player
});

test('sleep_timer live run replaces an active timer and discloses process scope', async () => {
  const { invoke } = makeHarness(registerExhaust2PlaybackTools, { getResponse: (p) => (p === '/me/player' ? playbackState() : undefined) });
  const first = await invoke('sleep_timer', { duration_min: 60, dry_run: false });
  assert.match(text(first), /Sleep timer set/);
  assert.match(text(first), /Music keeps playing/);
  const timers1 = listExhaust2Timers();
  assert.equal(timers1.length, 1);
  const second = await invoke('sleep_timer', { duration_min: 5, dry_run: false });
  assert.match(text(second), /Sleep timer set/);
  const timers2 = listExhaust2Timers();
  assert.equal(timers2.length, 1); // replaced, not duplicated
  assert.ok(timers2[0]!.started_at >= timers1[0]!.started_at);
  assert.ok(cancelExhaust2Timer('sleep_timer'));
  assert.equal(listExhaust2Timers().length, 0);
});

test('sleep_timer exposes a rejected pause instead of swallowing it', async () => {
  const fake = makeFakePlaybackTimers();
  __setExhaust2Scheduler(fake.scheduler);
  const h = makeHarness(registerExhaust2PlaybackTools, {
    getResponse: (p) => (p === '/me/player' ? playbackState() : undefined),
    putError: (path) => path === '/me/player/pause?device_id=dev1' ? new Error('403 Premium required') : undefined,
  });
  await h.invoke('sleep_timer', { duration_min: 5, dry_run: false });
  await fake.drain();

  const status = exhaust2TimerStatus('sleep_timer')!;
  assert.equal(status.state, 'failed');
  assert.equal(status.steps_applied, 0);
  assert.equal(status.steps_failed, 1);
  assert.deepEqual(status.failures[0], { step: 1, at_minute: 5, action: 'pause', error: '403 Premium required' });
  const readable = await h.invoke('playback_timer_status', { kind: 'sleep_timer' });
  assert.match(text(readable), /step 1 \(pause, \+5m\): 403 Premium required/);
});

// ---------------------------------------------------------------- mute / unmute

test('mute remembers the previous volume and zeroes it', async () => {
  const { invoke, calls } = makeHarness(registerExhaust2PlaybackTools, { getResponse: (p) => (p === '/me/player' ? playbackState() : undefined) });
  const out = await invoke('mute', { dry_run: false });
  assert.match(text(out), /Muted Kitchen \(was 55% — remembered for unmute\)/);
  const put = calls.find((c) => c.method === 'PUT' && c.path.includes('/me/player/volume'));
  assert.ok(put);
  assert.match(put!.path, /volume_percent=0/);
  const store = await loadExhaust2Store();
  assert.equal(store.muteMemory.dev1?.volume, 55);
});

test('mute that fails to write volume persists no memory, so unmute cannot restore a volume that was never muted (#843)', async () => {
  await resetSidecar();
  const { invoke, calls } = makeHarness(registerExhaust2PlaybackTools, {
    getResponse: (p) => (p === '/me/player' ? playbackState() : undefined),
    putError: (path) => (path.includes('/me/player/volume') ? new Error('403 Premium required') : undefined),
  });
  await assert.rejects(invoke('mute', { dry_run: false }), /403 Premium required/);
  const store = await loadExhaust2Store();
  assert.deepEqual(store.muteMemory, {});
  // A later unmute must not resurrect the never-muted level: it falls back to 50%.
  const later = makeHarness(registerExhaust2PlaybackTools);
  const out = await later.invoke('unmute', { device_id: 'dev1', dry_run: false });
  assert.match(text(out), /volume 50% \(no memory — default 50%\)/);
  const put = calls.concat(later.calls).find((c) => c.method === 'PUT' && c.path.includes('/me/player/volume'));
  assert.match(put!.path, /volume_percent=0/);
});

test('unmute restores the remembered level; default is 50% without memory', async () => {
  await resetSidecar();
  const store = await loadExhaust2Store();
  store.muteMemory.dev1 = { volume: 33, muted_at: new Date().toISOString(), device_id: 'dev1', device_name: 'Kitchen' };
  await saveExhaust2Store(store);
  const { invoke, calls } = makeHarness(registerExhaust2PlaybackTools);
  const out = await invoke('unmute', { device_id: 'dev1', dry_run: false });
  assert.match(text(out), /volume 33% \(remembered by mute\)/);
  const put = calls.find((c) => c.method === 'PUT' && c.path.includes('/me/player/volume'));
  assert.match(put!.path, /volume_percent=33/);

  const { invoke: invoke2 } = makeHarness(registerExhaust2PlaybackTools);
  await clearSidecar();
  const out2 = await invoke2('unmute', { dry_run: false });
  assert.match(text(out2), /no memory — default 50%/);
});

// ---------------------------------------------------------------- switch_device

test('switch_device resolves fuzzy name, exact id and sidecar label', async () => {
  const options: ClientOptions = { getResponse: (p) => (p === '/me/player/devices' ? { devices: [device(), device({ id: 'dev2', name: 'Study', volume_percent: 20 })] } : undefined) };
  const h1 = makeHarness(registerExhaust2PlaybackTools, options);
  const out1 = await h1.invoke('switch_device', { device_name: 'stud', dry_run: false });
  assert.match(text(out1), /Study/);
  const put1 = h1.calls.find((c) => c.method === 'PUT' && c.path === '/me/player');
  assert.deepEqual(put1!.body, { device_ids: ['dev2'], play: true });

  const h2 = makeHarness(registerExhaust2PlaybackTools, options);
  const out2 = await h2.invoke('switch_device', { device_name: 'dev1', play: false, dry_run: false });
  assert.match(text(out2), /paused/);
  assert.deepEqual(h2.calls.find((c) => c.method === 'PUT' && c.path === '/me/player')!.body, { device_ids: ['dev1'], play: false });

  const h3 = makeHarness(registerExhaust2PlaybackTools, options);
  const out3 = await h3.invoke('switch_device', { device_name: 'nope', dry_run: false });
  assert.match(text(out3), /No device matches "nope"/);
  assert.match(text(out3), /Kitchen/);
});

// ---------------------------------------------------------------- surprise_me

test('surprise_me with seed plays a deterministic saved track', async () => {
  const saved = { total: 3, items: [{ added_at: '2026-01-01', track: { id: 't1', name: 'Banger', uri: 'spotify:track:t1', artists: [{ name: 'A1' }] } }] };
  const h = makeHarness(registerExhaust2PlaybackTools, {
    getResponse: (p, params) => {
      if (p === '/me/tracks') {
        if (params?.offset === undefined) return { total: 3, items: [] };
        return saved;
      }
      return undefined;
    },
  });
  const out = await h.invoke('surprise_me', { type: 'track', seed: 7, dry_run: false });
  const structured = out.structuredContent as { pick?: string };
  assert.match(text(out), /Surprise: playing/);
  assert.equal(structured.chosen_type, 'track');
  const put = h.calls.find((c) => c.method === 'PUT' && c.path.startsWith('/me/player/play'));
  assert.ok(put);
  assert.deepEqual(put!.body, { uris: ['spotify:track:t1'] });
  // Same seed → same pick label in a second harness
  const h2 = makeHarness(registerExhaust2PlaybackTools, {
    getResponse: (p, params) => {
      if (p === '/me/tracks') {
        if (params?.offset === undefined) return { total: 3, items: [] };
        return saved;
      }
      return undefined;
    },
  });
  const out2 = await h2.invoke('surprise_me', { type: 'track', seed: 7, dry_run: true });
  assert.equal((out2.structuredContent as { pick?: string }).pick, structured.pick);
});

test('surprise_me owned-playlist weighting and empty-library guard', async () => {
  const playlists = { total: 2, items: [
    { name: 'Mine', uri: 'spotify:playlist:mine', owner: { id: 'me' } },
    { name: 'Theirs', uri: 'spotify:playlist:theirs', owner: { id: 'other' } },
  ] };
  const h = makeHarness(registerExhaust2PlaybackTools, {
    getResponse: (p, params) => {
      if (p === '/me') return { id: 'me' };
      if (p === '/me/playlists') return params?.offset === undefined ? { total: 2, items: [] } : playlists;
      return undefined;
    },
  });
  const out = await h.invoke('surprise_me', { type: 'playlist', seed: 1, dry_run: false });
  const structured = out.structuredContent as { pick?: string };
  assert.match(structured.pick ?? '', /owned playlist "(Mine|Theirs)"/);
  const put = h.calls.find((c) => c.method === 'PUT' && c.path.startsWith('/me/player/play'));
  assert.match((put!.body as { context_uri?: string }).context_uri ?? '', /spotify:playlist:(mine|theirs)/);

  const h2 = makeHarness(registerExhaust2PlaybackTools, { getResponse: (p) => (p === '/me/tracks' ? { total: 0, items: [] } : undefined) });
  const out2 = await h2.invoke('surprise_me', { type: 'track', dry_run: false });
  assert.match(text(out2), /No saved tracks/);
});

// ---------------------------------------------------------------- skip_n

test('skip_n loops n next calls and reports failures honestly', async () => {
  const h = makeHarness(registerExhaust2PlaybackTools);
  const out = await h.invoke('skip_n', { n: 3, dry_run: false });
  assert.match(text(out), /Skipped 3\/3 track\(s\) via 3 sequential next calls/);
  const nexts = h.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/me/player/next'));
  assert.equal(nexts.length, 3);
});

test('skip_n dry run discloses N-call quota without writes', async () => {
  const h = makeHarness(registerExhaust2PlaybackTools);
  const out = await h.invoke('skip_n', { n: 5, dry_run: true });
  assert.match(text(out), /5 separate API calls/);
  assert.equal(h.calls.filter((c) => c.method === 'POST').length, 0);
});

// ---------------------------------------------------------------- pause_everywhere

test('pause_everywhere pauses each live non-restricted device', async () => {
  const h = makeHarness(registerExhaust2PlaybackTools, {
    getResponse: (p) => (p === '/me/player/devices' ? { devices: [device({ is_active: true }), device({ id: 'dev2', name: 'Study' }), device({ id: 'dev3', name: 'Kids', is_restricted: true })] } : undefined),
  });
  const out = await h.invoke('pause_everywhere', { dry_run: false });
  assert.match(text(out), /Paused 2\/2 device\(s\)/);
  const pauses = h.calls.filter((c) => c.method === 'PUT' && c.path.includes('/me/player/pause'));
  assert.equal(pauses.length, 2);
});

test('pause_everywhere handles the no-devices case', async () => {
  const h = makeHarness(registerExhaust2PlaybackTools, { getResponse: (p) => (p === '/me/player/devices' ? { devices: [] } : undefined) });
  const out = await h.invoke('pause_everywhere', { dry_run: false });
  assert.match(text(out), /No live Connect devices/);
});

// ---------------------------------------------------------------- volume_ramp

test('volume_ramp dry run discloses step plan without writes', async () => {
  const h = makeHarness(registerExhaust2PlaybackTools, { getResponse: (p) => (p === '/me/player' ? playbackState() : undefined) });
  const out = await h.invoke('volume_ramp', { target_percent: 20, minutes: 4, step_minutes: 1, dry_run: true });
  assert.match(text(out), /dry run/i);
  assert.equal(h.calls.filter((c) => c.method === 'PUT').length, 0);
  assert.equal((out.structuredContent as { steps: number }).steps, 4);
});

test('volume_ramp records every successful volume and end-state write', async () => {
  const fake = makeFakePlaybackTimers();
  __setExhaust2Scheduler(fake.scheduler);
  const h = makeHarness(registerExhaust2PlaybackTools, { getResponse: (p) => (p === '/me/player' ? playbackState() : undefined) });
  const out = await h.invoke('volume_ramp', { target_percent: 30, minutes: 2, step_minutes: 1, end_state: 'pause', dry_run: false });
  assert.match(text(out), /Volume ramp started/);
  assert.equal(out.structuredContent?.steps, 2);
  await fake.drain();

  const puts = h.calls.filter((call) => call.method === 'PUT');
  assert.deepEqual(puts.map((call) => call.path), [
    '/me/player/volume?volume_percent=43&device_id=dev1',
    '/me/player/volume?volume_percent=30&device_id=dev1',
    '/me/player/pause?device_id=dev1',
  ]);
  assert.equal(exhaust2TimerStatus('volume_ramp')!.steps_applied, puts.length);
  assert.equal(exhaust2TimerStatus('volume_ramp')!.steps_failed, 0);
  assert.equal(exhaust2TimerStatus('volume_ramp')!.state, 'completed');
});

test('volume_ramp terminally records a rejected first volume step', async () => {
  const fake = makeFakePlaybackTimers();
  __setExhaust2Scheduler(fake.scheduler);
  const h = makeHarness(registerExhaust2PlaybackTools, {
    getResponse: (p) => (p === '/me/player' ? playbackState() : undefined),
    putError: (path) => path.startsWith('/me/player/volume?') && path.includes('device_id=dev1') ? new Error('429 rate limited') : undefined,
  });
  await h.invoke('volume_ramp', { target_percent: 20, minutes: 4, step_minutes: 1, dry_run: false });
  await fake.drain();

  const status = exhaust2TimerStatus('volume_ramp')!;
  assert.equal(status.state, 'failed');
  assert.equal(status.steps_applied, 0);
  assert.equal(status.steps_failed, 1);
  assert.equal(status.last_error, '429 rate limited');
  assert.deepEqual(status.failures[0], { step: 1, at_minute: 1, action: 'volume', error: '429 rate limited' });
  const readable = await h.invoke('playback_timer_status', { kind: 'volume_ramp' });
  assert.match(text(readable), /step 1 \(volume, \+1m\): 429 rate limited/);
  assert.equal(readable.structuredContent?.count, 1);
  assert.equal(h.calls.filter((call) => call.method === 'PUT').length, 1, 'later ramp steps are not attempted');
});

for (const endState of ['pause', 'play'] as const) {
  test(`volume_ramp exposes a rejected ${endState} end-state write`, async () => {
    const fake = makeFakePlaybackTimers();
    __setExhaust2Scheduler(fake.scheduler);
    const h = makeHarness(registerExhaust2PlaybackTools, {
      getResponse: (p) => (p === '/me/player' ? playbackState() : undefined),
      putError: (path) => path === `/me/player/${endState}?device_id=dev1` ? new Error(`404 ${endState} unavailable`) : undefined,
    });
    await h.invoke('volume_ramp', { target_percent: 20, minutes: 1, step_minutes: 1, end_state: endState, dry_run: false });
    await fake.drain();

    const status = exhaust2TimerStatus('volume_ramp')!;
    assert.equal(status.steps_applied, 1);
    assert.equal(status.steps_failed, 1);
    assert.equal(status.failures[0]!.action, endState);
    assert.equal(status.last_error, `404 ${endState} unavailable`);
    const readable = await h.invoke('playback_timer_status', { kind: 'volume_ramp' });
    assert.match(text(readable), new RegExp(`step 2 \\(${endState}, \\+1m\\): 404 ${endState} unavailable`));
  });
}

test('cancelling volume_ramp prevents every pending volume and end-state write', async () => {
  const fake = makeFakePlaybackTimers();
  __setExhaust2Scheduler(fake.scheduler);
  const h = makeHarness(registerExhaust2PlaybackTools, { getResponse: (p) => (p === '/me/player' ? playbackState() : undefined) });
  await h.invoke('volume_ramp', { target_percent: 20, minutes: 4, step_minutes: 1, end_state: 'pause', dry_run: false });

  assert.ok(cancelExhaust2Timer('volume_ramp'));
  assert.equal(fake.cleared.length, 1);
  await fake.drain();
  assert.equal(h.calls.filter((call) => call.method === 'PUT').length, 0);
  assert.equal(exhaust2TimerStatus('volume_ramp'), null);
});

// ---------------------------------------------------------------- episode bookmarks

test('episode_bookmark captures episode progress; rejects tracks', async () => {
  const episodeState = playbackState({
    progress_ms: 500_000,
    item: { id: 'ep1', name: 'Ep One', uri: 'spotify:episode:ep1', type: 'episode', duration_ms: 3_600_000, show: { name: 'Great Show', id: 'shw1' } },
  });
  const h = makeHarness(registerExhaust2PlaybackTools, { getResponse: (p) => (p === '/me/player' ? episodeState : undefined) });
  const out = await h.invoke('episode_bookmark', { note: 'mid-run' });
  assert.match(text(out), /Bookmarked "Ep One" \(Great Show\) at 500s/);
  const store = await loadExhaust2Store();
  const bms = Object.values(store.episodeBookmarks);
  assert.equal(bms.length, 1);
  assert.equal(bms[0]!.progress_ms, 500_000);
  assert.equal(bms[0]!.note, 'mid-run');

  const h2 = makeHarness(registerExhaust2PlaybackTools, { getResponse: (p) => (p === '/me/player' ? playbackState() : undefined) });
  const out2 = await h2.invoke('episode_bookmark', {});
  assert.match(text(out2), /not a podcast episode/);

  const h3 = makeHarness(registerExhaust2PlaybackTools, { getResponse: (p) => (p === '/me/player' ? null : undefined) });
  const out3 = await h3.invoke('episode_bookmark', {});
  assert.match(text(out3), /Nothing is currently playing/);
});

test('episode_resume jumps to the newest (or named) bookmark', async () => {
  await resetSidecar();
  const store = await loadExhaust2Store();
  store.episodeBookmarks['ep-1'] = { id: 'ep-1', saved_at: '2026-08-26T10:00:00Z', episode_uri: 'spotify:episode:e1', episode_name: 'Old Ep', show_name: null, show_id: null, progress_ms: 1000, duration_ms: null, device_id: 'dev1' };
  store.episodeBookmarks['ep-2'] = { id: 'ep-2', saved_at: '2026-08-27T10:00:00Z', episode_uri: 'spotify:episode:e2', episode_name: 'New Ep', show_name: null, show_id: null, progress_ms: 2000, duration_ms: null, device_id: 'dev2' };
  await saveExhaust2Store(store);
  const h = makeHarness(registerExhaust2PlaybackTools);
  const out = await h.invoke('episode_resume', { dry_run: false });
  assert.match(text(out), /Resuming "New Ep" at 2s/);
  const play = h.calls.find((c) => c.method === 'PUT' && c.path.startsWith('/me/player/play'));
  assert.ok(play);
  assert.match(play!.path, /device_id=dev2/);
  assert.deepEqual(play!.body, { uris: ['spotify:episode:e2'], position_ms: 2000 });

  const h2 = makeHarness(registerExhaust2PlaybackTools);
  const out2 = await h2.invoke('episode_resume', { bookmark_id: 'ep-1', dry_run: true });
  assert.match(text(out2), /Old Ep/);

  const h3 = makeHarness(registerExhaust2PlaybackTools);
  const out3 = await h3.invoke('episode_resume', { bookmark_id: 'missing' });
  assert.match(text(out3), /No episode bookmark "missing"/);
});

// ---------------------------------------------------------------- queue_next_episode

test('queue_next_episode queues the newest unplayed episode', async () => {
  const episodes = {
    items: [
      { id: 'e1', name: 'Ep One', uri: 'spotify:episode:e1', release_date: '2026-08-01', resume_point: { fully_played: true } },
      { id: 'e2', name: 'Ep Two', uri: 'spotify:episode:e2', release_date: '2026-08-02', resume_point: { fully_played: false } },
    ],
  };
  const h = makeHarness(registerExhaust2PlaybackTools, {
    getResponse: (p) => {
      if (p.startsWith('/shows/') && p.endsWith('/episodes')) return episodes;
      if (p === '/me/player/recently-played') return { items: [recentRow('spotify:episode:e9', '2026-08-27T09:00:00Z')], next: null };
      return undefined;
    },
  });
  const out = await h.invoke('queue_next_episode', { show_id: 'shw1', dry_run: false });
  assert.match(text(out), /Queued next unplayed episode: "Ep Two"/);
  const q = h.calls.find((c) => c.method === 'POST' && c.path.startsWith('/me/player/queue'));
  assert.match(q!.path, /uri=spotify%3Aepisode%3Ae2/);
});

test('queue_next_episode reports the all-played case', async () => {
  const episodes = { items: [{ id: 'e1', name: 'Ep One', uri: 'spotify:episode:e1', release_date: '2026-08-01', resume_point: { fully_played: true } }] };
  const h = makeHarness(registerExhaust2PlaybackTools, {
    getResponse: (p) => {
      if (p.startsWith('/shows/') && p.endsWith('/episodes')) return episodes;
      if (p === '/me/player/recently-played') return { items: [], next: null };
      return undefined;
    },
  });
  const out = await h.invoke('queue_next_episode', { show_id: 'shw1' });
  assert.match(text(out), /already played or fully played/);
});

// ---------------------------------------------------------------- queue_replace_via_playlist

test('queue_replace_via_playlist snapshots, filters and starts the new context', async () => {
  const queue = {
    currently_playing: { uri: 'spotify:track:t1', name: 'T1', type: 'track', artists: [{ name: 'A' }] },
    queue: [
      { uri: 'spotify:track:t1', name: 'T1 dup', type: 'track', artists: [{ name: 'A' }] },
      { uri: 'spotify:track:t2', name: 'T2', type: 'track', artists: [{ name: 'B' }] },
      { uri: 'spotify:episode:e1', name: 'Pod', type: 'episode' },
    ],
  };
  const h = makeHarness(registerExhaust2PlaybackTools, { getResponse: (p) => (p === '/me/player/queue' ? queue : undefined) });
  const out = await h.invoke('queue_replace_via_playlist', { keep_artists: ['a'], dry_run: false });
  assert.match(text(out), /live queue is effectively replaced/);
  const add = h.calls.find((c) => c.method === 'POST' && c.path.includes('/playlists/pl1/items'));
  assert.deepEqual(add!.body, { uris: ['spotify:track:t1'] });
  const play = h.calls.find((c) => c.method === 'PUT' && c.path.startsWith('/me/player/play'));
  assert.deepEqual(play!.body, { context_uri: 'spotify:playlist:pl1' });
});

test('queue_replace_via_playlist guards empty queues and all-filtered outcomes', async () => {
  const h = makeHarness(registerExhaust2PlaybackTools, { getResponse: (p) => (p === '/me/player/queue' ? { currently_playing: null, queue: [] } : undefined) });
  const out = await h.invoke('queue_replace_via_playlist', { dry_run: true });
  assert.match(text(out), /empty/i);

  const queue = { currently_playing: { uri: 'spotify:track:t1', name: 'T1', type: 'track', artists: [{ name: 'A' }] }, queue: [] };
  const h2 = makeHarness(registerExhaust2PlaybackTools, { getResponse: (p) => (p === '/me/player/queue' ? queue : undefined) });
  const out2 = await h2.invoke('queue_replace_via_playlist', { keep_artists: ['zzz'] });
  assert.match(text(out2), /filtered out/i);
});

// A live queue carries ads and unavailable rows with no URI. Pairing metadata
// by position rather than by URI shifted every later track's artist onto the
// URI-less row's, and that wrong artist decided which tracks survived
// keep_artists (#844).
test('queue_replace_via_playlist attributes a track to its own URI when a URI-less ad precedes it', async () => {
  const queue = {
    currently_playing: { name: 'Ad', type: 'ad' },
    queue: [
      { uri: 'spotify:track:byA', name: 'Track A', type: 'track', artists: [{ name: 'A' }] },
      { uri: 'spotify:track:byB', name: 'Track B', type: 'track', artists: [{ name: 'B' }] },
    ],
  };
  const h = makeHarness(registerExhaust2PlaybackTools, { getResponse: (p) => (p === '/me/player/queue' ? queue : undefined) });
  await h.invoke('queue_replace_via_playlist', { keep_artists: ['a'], dry_run: false });
  const add = h.calls.find((c) => c.method === 'POST' && c.path.includes('/playlists/pl1/items'));
  assert.deepEqual(add!.body, { uris: ['spotify:track:byA'] });
});

// The same track can appear twice, the second time as a bare stub with no
// artist metadata. Positional pairing let that stub overwrite the real
// attribution, so keep_artists dropped a track that did match.
test('queue_replace_via_playlist keeps a duplicated track attributed to its own URI when a stub row repeats it', async () => {
  const queue = {
    currently_playing: { uri: 'spotify:track:byA', name: 'Track A', type: 'track', artists: [{ name: 'A' }] },
    queue: [
      { uri: 'spotify:track:byA', name: 'Track A' },
      { uri: 'spotify:track:byB', name: 'Track B', type: 'track', artists: [{ name: 'B' }] },
    ],
  };
  const h = makeHarness(registerExhaust2PlaybackTools, { getResponse: (p) => (p === '/me/player/queue' ? queue : undefined) });
  await h.invoke('queue_replace_via_playlist', { keep_artists: ['a'], dry_run: false });
  const add = h.calls.find((c) => c.method === 'POST' && c.path.includes('/playlists/pl1/items'));
  assert.ok(add, 'the matching track is queued rather than filtered away');
  assert.deepEqual(add.body, { uris: ['spotify:track:byA'] });
});

// Two rows for one URI are the same track, so their attributions MERGE.
// Ranking them instead let a name-only row (score 1) tie with, and beat, an
// artists-only row (also score 1) — erasing the artists and dropping the one
// track that genuinely matched keep_artists.
test('queue_replace_via_playlist does not let a name-only row erase the artists of the same URI', async () => {
  const queue = {
    currently_playing: { uri: 'spotify:track:byA', artists: [{ name: 'A' }] },
    queue: [
      { uri: 'spotify:track:byA', name: 'Track A', type: 'track' },
      { uri: 'spotify:track:byB', artists: [{ name: 'B' }] },
    ],
  };
  const h = makeHarness(registerExhaust2PlaybackTools, { getResponse: (p) => (p === '/me/player/queue' ? queue : undefined) });
  const out = await h.invoke('queue_replace_via_playlist', { keep_artists: ['a'], dry_run: false });
  assert.notEqual(out.structuredContent?.error, 'all_filtered', 'the real artist-A match survives the merge');
  const add = h.calls.find((c) => c.method === 'POST' && c.path.includes('/playlists/pl1/items'));
  assert.ok(add, 'the matching track is queued rather than filtered away');
  assert.deepEqual(add.body, { uris: ['spotify:track:byA'] });
});

// The two early bail-outs are exactly the paths a URI-less ad drives you to,
// so the skipped-row disclosure has to survive them too.
test('queue_replace_via_playlist reports skipped rows on the all_filtered path', async () => {
  const queue = {
    currently_playing: { name: 'Ad', type: 'ad' },
    queue: [{ uri: 'spotify:track:byB', name: 'Track B', type: 'track', artists: [{ name: 'B' }] }],
  };
  const h = makeHarness(registerExhaust2PlaybackTools, { getResponse: (p) => (p === '/me/player/queue' ? queue : undefined) });
  const out = await h.invoke('queue_replace_via_playlist', { keep_artists: ['a'], dry_run: false });
  assert.equal(out.structuredContent?.error, 'all_filtered');
  assert.equal(out.structuredContent?.uri_less_rows, 1);
  assert.match(text(out), /had no URI/);
  assert.equal(h.calls.filter((c) => c.method === 'POST').length, 0);
});

test('queue_replace_via_playlist reports skipped rows on the empty_queue path', async () => {
  const queue = {
    currently_playing: { name: 'Ad', type: 'ad' },
    queue: [{ name: 'Ad 2', type: 'ad' }],
  };
  const h = makeHarness(registerExhaust2PlaybackTools, { getResponse: (p) => (p === '/me/player/queue' ? queue : undefined) });
  const out = await h.invoke('queue_replace_via_playlist', { dry_run: true });
  assert.equal(out.structuredContent?.error, 'empty_queue');
  assert.equal(out.structuredContent?.uri_less_rows, 2);
  assert.match(text(out), /had no URI/);
  assert.equal(h.calls.filter((c) => c.method === 'POST').length, 0);
});

// A row with a URI but no name/artists/type cannot be attributed to anyone.
// It is reported as unknown instead of inheriting a neighbour's data.
test('queue_replace_via_playlist reports a metadata-less row as unknown rather than borrowing a neighbour artist', async () => {
  const queue = {
    currently_playing: { uri: 'spotify:track:unknown', name: null, type: null, artists: null },
    queue: [{ uri: 'spotify:track:byA', name: 'Track A', type: 'track', artists: [{ name: 'A' }] }],
  };
  const h = makeHarness(registerExhaust2PlaybackTools, { getResponse: (p) => (p === '/me/player/queue' ? queue : undefined) });
  const out = await h.invoke('queue_replace_via_playlist', { keep_artists: ['a'], dry_run: false });
  assert.equal(out.structuredContent?.unknown_rows, 1);
  assert.deepEqual(out.structuredContent?.unknown_uris, ['spotify:track:unknown']);
  assert.match(text(out), /reported as unknown/);
  const add = h.calls.find((c) => c.method === 'POST' && c.path.includes('/playlists/pl1/items'));
  assert.deepEqual(add!.body, { uris: ['spotify:track:byA'] });
});

test('queue_replace_via_playlist reports URI-less rows in the dry run too', async () => {
  const queue = {
    currently_playing: { name: 'Ad', type: 'ad' },
    queue: [
      { uri: 'spotify:track:byA', name: 'Track A', type: 'track', artists: [{ name: 'A' }] },
      { uri: 'spotify:track:byB', name: 'Track B', type: 'track', artists: [{ name: 'B' }] },
    ],
  };
  const h = makeHarness(registerExhaust2PlaybackTools, { getResponse: (p) => (p === '/me/player/queue' ? queue : undefined) });
  const out = await h.invoke('queue_replace_via_playlist', { keep_artists: ['a'], dry_run: true });
  assert.equal(out.structuredContent?.uri_less_rows, 1);
  assert.equal(out.structuredContent?.after_filters, 1);
  assert.equal(h.calls.filter((c) => c.method === 'POST').length, 0);
});

// ---------------------------------------------------------------- recently-played intel

const recentWindow = () => ({
  items: [
    recentRow('spotify:track:a', '2026-08-27T10:05:00Z', 'AAA'),
    recentRow('spotify:track:b', '2026-08-27T09:00:00Z', 'BBB'),
    recentRow('spotify:track:a', '2026-08-26T09:30:00Z', 'AAA'),
    recentRow('spotify:track:c', '2026-08-20T22:10:00Z', 'CCC'),
  ],
  next: null,
});

test('session_stats reports median/mean/longest via detectSessions', async () => {
  const h = makeHarness(registerExhaust2PlaybackTools, { getResponse: (p) => (p === '/me/player/recently-played' ? recentWindow() : undefined) });
  const out = await h.invoke('session_stats', { pages: 2 });
  const s = (out.structuredContent as { sessions: { count: number; median_tracks: number; longest_session: { tracks: number } } }).sessions;
  assert.ok(s.count >= 1);
  assert.ok(s.median_tracks >= 1);
  assert.match(text(out), /Session stats over 4 recently-played items/);
});

test('most_replayed ranks play counts with dedupe', async () => {
  const h = makeHarness(registerExhaust2PlaybackTools, { getResponse: (p) => (p === '/me/player/recently-played' ? recentWindow() : undefined) });
  const out = await h.invoke('most_replayed', { limit: 2 });
  assert.match(text(out), /Most-replayed in the recent window \(4 plays, 3 unique tracks\)/);
  const first = text(out).split('\n').find((l) => l.match(/^\s+1\./));
  assert.match(first ?? '', /AAA.*2 plays/);
});

test('last_heard finds artists with gaps and reports misses', async () => {
  const h = makeHarness(registerExhaust2PlaybackTools, { getResponse: (p) => (p === '/me/player/recently-played' ? recentWindow() : undefined) });
  const out = await h.invoke('last_heard', { artists: ['Artist X', 'Nobody'], max_pages: 2 });
  assert.match(text(out), /Artist X: last played 2026-08-27T10:05:00Z/);
  assert.match(text(out), /Nobody: not played in the scanned window/);
});

test('weekday_heatmap buckets weekday × daypart and names the busiest slot', async () => {
  const h = makeHarness(registerExhaust2PlaybackTools, { getResponse: (p) => (p === '/me/player/recently-played' ? recentWindow() : undefined) });
  const out = await h.invoke('weekday_heatmap', {});
  assert.match(text(out), /Weekday × daypart heatmap over 4 plays:/);
  assert.match(text(out), /Busiest slot: \w+ \w+ \(2 plays\)\./);
});

test('daily_pick is deterministic per date and seeded from the highlight pool', async () => {
  const h = makeHarness(registerExhaust2PlaybackTools, { getResponse: (p) => (p === '/me/player/recently-played' ? recentWindow() : undefined) });
  const a = await h.invoke('daily_pick', { date: '2026-08-27' });
  const b = await h.invoke('daily_pick', { date: '2026-08-27' });
  assert.equal((a.structuredContent as { pick: { uri: string } }).pick.uri, (b.structuredContent as { pick: { uri: string } }).pick.uri);
  const c = await h.invoke('daily_pick', { date: '2026-01-01', pool_size: 1 });
  assert.equal((c.structuredContent as { pick: { uri: string } }).pick.uri, 'spotify:track:a'); // top of pool
  assert.match(text(c), /Banger of the day \(2026-01-01, deterministic\)/);
});

// ---------------------------------------------------------------- queue_profile

test('queue_profile reports mix, uniques and longest artist block', async () => {
  const queue = {
    currently_playing: { uri: 'spotify:track:t1', name: 'T1', type: 'track', artists: [{ name: 'A' }], album: { name: 'X' } },
    queue: [
      { uri: 'spotify:track:t2', name: 'T2', type: 'track', artists: [{ name: 'A' }], album: { name: 'Y' } },
      { uri: 'spotify:episode:e1', name: 'Pod', type: 'episode', show: { name: 'Show' } },
    ],
  };
  const h = makeHarness(registerExhaust2PlaybackTools, { getResponse: (p) => (p === '/me/player/queue' ? queue : undefined) });
  const out = await h.invoke('queue_profile', {});
  assert.match(text(out), /mix: 2 track\(s\) \/ 1 episode\(s\)/);
  assert.match(text(out), /unique artists: 1 \| unique albums: 2 \| unique shows: 1/);
  assert.match(text(out), /longest block by one artist: A ×2/);
});

// ---------------------------------------------------------------- checkpoints

test('checkpoint_playback auto-names and continue_last resumes the newest', async () => {
  const h = makeHarness(registerExhaust2PlaybackTools, { getResponse: (p) => (p === '/me/player' ? playbackState({ progress_ms: 42_000 }) : undefined) });
  const out = await h.invoke('checkpoint_playback', { note: 'car ride' });
  assert.match(text(out), /Checkpoint saved: cp-\d{4}-\d{2}-\d{2}T\d{2}:\d{2} \(Song A @ 42000ms\) — car ride/);
  const store = await loadExhaust2Store();
  const cps = Object.values(store.checkpoints);
  assert.equal(cps.length, 1);
  assert.equal(cps[0]!.note, 'car ride');

  const h2 = makeHarness(registerExhaust2PlaybackTools);
  const out2 = await h2.invoke('continue_last', { dry_run: false });
  assert.match(text(out2), /Continuing from checkpoint "cp-[\d:T-]+" → spotify:track:trk1 @ 42000ms/);
  const play = h2.calls.find((c) => c.method === 'PUT' && c.path.startsWith('/me/player/play'));
  assert.deepEqual(play!.body, { uris: ['spotify:track:trk1'], position_ms: 42_000 });
});

test('continue_last guards no-checkpoints and no-item states', async () => {
  await resetSidecar();
  const h = makeHarness(registerExhaust2PlaybackTools);
  const out = await h.invoke('continue_last', {});
  assert.match(text(out), /No checkpoints/);

  const store = await loadExhaust2Store();
  store.checkpoints['cp-empty'] = { id: 'cp-empty', saved_at: new Date().toISOString(), playback: null };
  await saveExhaust2Store(store);
  const h2 = makeHarness(registerExhaust2PlaybackTools);
  const out2 = await h2.invoke('continue_last', {});
  assert.match(text(out2), /no playable item/i);
});

// ---------------------------------------------------------------- room_level / volume_report

test('room_level applies the active volume to every other live device', async () => {
  const h = makeHarness(registerExhaust2PlaybackTools, {
    getResponse: (p) => (p === '/me/player/devices' ? { devices: [device({ is_active: true, volume_percent: 50 }), device({ id: 'dev2', name: 'Study', volume_percent: 10 }), device({ id: 'dev3', name: 'Kids', is_restricted: true })] } : undefined),
  });
  const out = await h.invoke('room_level', { dry_run: false });
  assert.match(text(out), /Room levelled: 1\/1 device\(s\) → 50%/);
  const vol = h.calls.find((c) => c.method === 'PUT' && c.path.includes('/me/player/volume'));
  assert.match(vol!.path, /volume_percent=50/);
  assert.match(vol!.path, /device_id=dev2/);
});

test('volume_report snapshots live volumes vs sidecar presets', async () => {
  const ext = await loadPlaybackExtForTest();
  ext.devicePresets.dev1 = { label: 'Kitchen speaker', volume: 35 };
  await savePlaybackExtForTest(ext);
  const h = makeHarness(registerExhaust2PlaybackTools, {
    getResponse: (p) => (p === '/me/player/devices' ? { devices: [device({ is_active: true })] } : undefined),
  });
  const out = await h.invoke('volume_report', {});
  assert.match(text(out), /Kitchen \(Speaker, active\): 40% · preset "Kitchen speaker" = 35% \(live Δ\+5\)/);
});

// mini helpers — reuse playbackext sidecar file via the same env override
import { loadPlaybackExt, playbackExtFile } from '../src/tools/playbackext.js';
async function loadPlaybackExtForTest() {
  return loadPlaybackExt();
}
async function savePlaybackExtForTest(store: Awaited<ReturnType<typeof loadPlaybackExt>>) {
  const file = playbackExtFile();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(store, null, 2));
}
