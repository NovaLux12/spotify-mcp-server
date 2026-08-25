/**
 * Named playback scenes (#112 ideas 7+12): save/apply/list/delete reusable
 * "profiles" (device + volume + shuffle/repeat + context) stored in a local
 * JSON sidecar at ~/.spotify-mcp/scenes.json (override with
 * SPOTIFY_MCP_SCENES_FILE). The sidecar never holds credentials — just
 * playback preferences — but like history/tokens it is kept owner-only
 * (0600 file, 0700 dir).
 *
 * Also ships schedule_wind_down / cancel_wind_down (#112 idea 12): an
 * IN-PROCESS volume ramp that steps playback down every N minutes until a
 * floor volume, then pauses. Timers run through an injectable scheduler
 * seam (__setWindDownScheduler) so tests drive ticks deterministically
 * without real time passing.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SpotifyClient } from '../client.js';
import type { PlaybackState, SpotifyDevice, GetDevicesResponse } from '../types/spotify.js';
import { ResponseFormat, DryRun } from '../shaping.js';

// ---------------------------------------------------------------------------
// Sidecar store
// ---------------------------------------------------------------------------

export interface Scene {
  /** Device name substring or exact device id, resolved against /me/player/devices. */
  device_hint?: string;
  /** Master volume percent 0–100. */
  volume?: number;
  shuffle?: boolean;
  repeat?: 'off' | 'track' | 'context';
  /** Context to start on apply (album/playlist/show URI). */
  context_uri?: string;
}

type SceneStore = Record<string, Scene>;

/** Sidecar path; SPOTIFY_MCP_SCENES_FILE overrides the whole file location. */
export function scenesFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.SPOTIFY_MCP_SCENES_FILE ?? join(homedir(), '.spotify-mcp', 'scenes.json');
}

/** Load all scenes; missing/corrupt file yields an empty store. */
export async function loadScenes(env: NodeJS.ProcessEnv = process.env): Promise<SceneStore> {
  try {
    const raw = await readFile(scenesFilePath(env), 'utf8');
    const parsed = JSON.parse(raw) as SceneStore;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Persist the store atomically-enough: owner-only dir and file modes. */
async function saveScenes(store: SceneStore, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const file = scenesFilePath(env);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------


const sceneFields = {
  device_hint: z
    .string()
    .optional()
    .describe('Device name substring (case-insensitive) or exact device id'),
  volume: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe('Master volume percent (0–100)'),
  shuffle: z.boolean().optional().describe('Shuffle state'),
  repeat: z
    .enum(['off', 'track', 'context'])
    .optional()
    .describe("Repeat mode: 'off' | 'track' | 'context'"),
  context_uri: z.string().optional().describe('Context URI to start on apply (e.g. spotify:playlist:…)'),
} as const;

/** Echo-style result mirroring playback.ts mutationResult. */
function emit(
  format: string | undefined,
  echo: Record<string, unknown>,
  text: string,
): { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown> } {
  if (format === 'json') {
    return { content: [{ type: 'text', text: JSON.stringify(echo, null, 2) }], structuredContent: echo };
  }
  return { content: [{ type: 'text', text }], structuredContent: echo };
}

// ---------------------------------------------------------------------------
// apply_scene planning
// ---------------------------------------------------------------------------

interface PlannedStep {
  action: 'transfer' | 'volume' | 'shuffle' | 'repeat' | 'play';
  /** Human description of what this step does. */
  detail: string;
  /** Wire call that executes the step (informational, shown under dry_run). */
  call: string;
}

interface ExecutedStep extends PlannedStep {
  status: 'applied' | 'skipped' | 'failed';
  error?: string;
}

/**
 * Plan the ordered step list for a scene. When a device hint resolves, every
 * device-scoped step targets that id; when a hint is given but does NOT match
 * any device, the transfer AND all device-scoped steps are planned as skips
 * (a scene aimed at "Kitchen" must not retune the active speaker instead).
 */
function planSteps(scene: Scene, deviceId: string | null): PlannedStep[] {
  const steps: PlannedStep[] = [];
  // A hint that matches nothing skips EVERY step: the scene targets a
  // specific device and must not retune whichever speaker happens to be
  // active instead.
  const skipAll = scene.device_hint !== undefined && !deviceId;
  const skipStep = (action: PlannedStep['action'], detail: string): PlannedStep => ({
    action,
    detail: skipAll ? `no device matches hint "${scene.device_hint}"` : detail,
    call: '(skipped)',
  });
  if (scene.device_hint !== undefined) {
    steps.push(
      deviceId
        ? {
            action: 'transfer',
            detail: `transfer playback to device ${deviceId}`,
            call: `PUT /me/player {"device_ids":["${deviceId}"]}`,
          }
        : skipStep('transfer', ''),
    );
  }
  if (scene.volume !== undefined) {
    steps.push(
      skipAll ? skipStep('volume', '') : { action: 'volume', detail: `set volume to ${scene.volume}`, call: `PUT /me/player/volume?volume=${scene.volume}${devSuffix(deviceId)}` },
    );
  }
  if (scene.shuffle !== undefined) {
    steps.push(
      skipAll
        ? skipStep('shuffle', '')
        : { action: 'shuffle', detail: `shuffle ${scene.shuffle ? 'on' : 'off'}`, call: `PUT /me/player/shuffle?state=${scene.shuffle}${devSuffix(deviceId)}` },
    );
  }
  if (scene.repeat !== undefined) {
    steps.push(
      skipAll
        ? skipStep('repeat', '')
        : { action: 'repeat', detail: `repeat ${scene.repeat}`, call: `PUT /me/player/repeat?state=${scene.repeat}${devSuffix(deviceId)}` },
    );
  }
  if (scene.context_uri !== undefined) {
    steps.push(
      skipAll
        ? skipStep('play', '')
        : {
            action: 'play',
            detail: `start ${scene.context_uri}`,
            call: `PUT /me/player/play${deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : ''} {"context_uri":"${scene.context_uri}"}`,
          },
    );
  }
  return steps;
}

/** Query-suffix fragment for device-scoped player endpoints. */
function devSuffix(deviceId: string | null): string {
  return deviceId ? `&device_id=${encodeURIComponent(deviceId)}` : '';
}

/**
 * Resolve a device hint against GET /me/player/devices: exact id match wins,
 * then case-insensitive name substring. Returns null when nothing matches.
 */
async function resolveDeviceHint(
  client: SpotifyClient,
  hint: string,
): Promise<{ deviceId: string | null; devices: SpotifyDevice[] }> {
  const res = await client.get<GetDevicesResponse>('/me/player/devices');
  const devices = res?.devices ?? [];
  const exact = devices.find((d) => d.id === hint);
  const found = exact ?? devices.find((d) => d.name.toLowerCase().includes(hint.toLowerCase()));
  return { deviceId: found?.id ?? null, devices };
}

// ---------------------------------------------------------------------------
// Wind-down engine (in-process timer chain)
// ---------------------------------------------------------------------------

/**
 * Injectable timer seam so tests fire ticks without wall-clock delays.
 * Handles expose the `unref` surface of Node timers; the default scheduler
 * unrefs every armed timer so a fade NEVER keeps this stdio server's event
 * loop alive — when the client exits, the fade ends with the process.
 */
export interface WindDownHandle {
  unref?(): unknown;
}

export interface WindDownTimers {
  setTimeout(fn: () => void, ms: number): WindDownHandle;
  clearTimeout(handle: WindDownHandle): void;
}

const realTimers: WindDownTimers = {
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    // Critical for a stdio MCP server: an in-process fade must not hold the
    // process open after the client disconnects.
    timer.unref();
    return timer;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

let windDownTimers: WindDownTimers = realTimers;

/**
 * Test seam: replace the timer implementation used by schedule_wind_down.
 * Pass null/undefined to restore real (unref'd) timers. Fake timers MUST fire
 * the callbacks manually — none are ever left running against real time.
 */
export function __setWindDownScheduler(timers?: WindDownTimers | null): void {
  windDownTimers = timers ?? realTimers;
}

interface ActiveWindDown {
  key: string;
  cancelled: boolean;
  pending: WindDownHandle[];
  /** Volume steps still to run (earliest first); last entry pauses. */
  remaining: Array<{ volume?: number; delayMs: number }>;
}

/** Only ONE fade at a time: scheduling a new one cancels the previous. */
let current: ActiveWindDown | null = null;

/** Internal state exposure for tests: the live wind-down, if any. */
export function activeWindDown(): Readonly<ActiveWindDown> | null {
  return current;
}

const windDownKey = (deviceId?: string): string => deviceId ?? 'default';

function cancelActive(): boolean {
  if (!current) return false;
  current.cancelled = true;
  for (const handle of current.pending) windDownTimers.clearTimeout(handle);
  current.pending = [];
  current.remaining = [];
  current = null;
  return true;
}

// Process-lifecycle cleanup: a fade is best-effort by definition — on shutdown
// we drop every pending timer instead of letting ticks fire mid-teardown.
// Signals re-raise themselves so default termination semantics are untouched.
let exitCleanupInstalled = false;
function ensureExitCleanup(): void {
  if (exitCleanupInstalled) return;
  exitCleanupInstalled = true;
  const reraise = (signal: NodeJS.Signals): void => {
    cancelActive();
    process.kill(process.pid, signal);
  };
  process.once('SIGINT', () => reraise('SIGINT'));
  process.once('SIGTERM', () => reraise('SIGTERM'));
  process.on('exit', () => cancelActive());
}

/**
 * Deterministic ramp math: split [current → floor] into
 * totalSteps = floor(minutes / step_minutes) (≥1) equal integer decrements,
 * clamped so volume never drops below floor. Pause lands after the final
 * step (at totalSteps × step_minutes).
 */
export function computeWindDownSchedule(
  startVolume: number,
  minutes: number,
  stepMinutes: number,
  floorVolume: number,
): Array<{ at_minute: number; volume: number }> {
  const totalSteps = Math.max(1, Math.floor(minutes / stepMinutes));
  const span = Math.max(0, startVolume - floorVolume);
  const decrement = Math.max(1, Math.ceil(span / totalSteps));
  const out: Array<{ at_minute: number; volume: number }> = [];
  for (let i = 1; i <= totalSteps; i++) {
    out.push({ at_minute: i * stepMinutes, volume: Math.max(floorVolume, startVolume - i * decrement) });
  }
  return out;
}

/** Execute one ramp tick: PUT volume (or pause when volume is absent). */
async function execTick(client: SpotifyClient, step: { volume?: number }, deviceId?: string): Promise<void> {
  if (step.volume !== undefined) {
    const qs = deviceId
      ? `?${new URLSearchParams({ volume: String(step.volume), device_id: deviceId })}`
      : `?${new URLSearchParams({ volume: String(step.volume) })}`;
    await client.put(`/me/player/volume${qs}`);
  } else {
    await client.put(deviceId ? `/me/player/pause?device_id=${encodeURIComponent(deviceId)}` : '/me/player/pause');
  }
}

/** Kick off the timer chain for a freshly computed schedule. */
function startWindDown(
  key: string,
  schedule: Array<{ at_minute: number; volume: number }>,
  deviceId: string | undefined,
  client: SpotifyClient,
): void {
  ensureExitCleanup();
  cancelActive(); // single-slot: arming a new fade replaces any previous one

  // at_minute already counts in step_minutes multiples; the pause sentinel
  // lands one step after the final volume step.
  const pauseAtMinute = schedule.at(-1)?.at_minute ?? 1;
  const remaining: Array<{ volume?: number; delayMs: number }> = schedule.map((s) => ({
    volume: s.volume,
    delayMs: s.at_minute * 60_000,
  }));
  remaining.push({ volume: undefined, delayMs: Math.max(1, pauseAtMinute * 60_000) });
  const active: ActiveWindDown = { key, cancelled: false, pending: [], remaining };
  current = active;

  const armNext = (): void => {
    const next = active.remaining[0];
    if (!next || active.cancelled) return;
    const handle = windDownTimers.setTimeout(() => {
      if (active.cancelled) return;
      active.remaining.shift();
      const isFinalPause = next.volume === undefined;
      void execTick(client, next, deviceId)
        .catch(() => {
          /* best-effort: a dropped step must not kill the ramp */
        })
        .finally(() => {
          if (isFinalPause && !active.cancelled && current === active) current = null;
          armNext();
        });
    }, next.delayMs);
    active.pending.push(handle);
  };
  armNext();
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerScenesTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'save_scene',
    'Save a named playback scene (device + volume + shuffle/repeat + optional context) to the local sidecar (~/.spotify-mcp/scenes.json)',
    {
      name: z.string().min(1).describe('Scene name (key in the sidecar)'),
      ...sceneFields,
      response_format: ResponseFormat,
    },
    async (args) => {
      // Up-front validation beyond zod: reject scenes with no actionable field.
      const scene: Scene = {};
      if (args.device_hint !== undefined) scene.device_hint = args.device_hint;
      if (args.volume !== undefined) scene.volume = args.volume;
      if (args.shuffle !== undefined) scene.shuffle = args.shuffle;
      if (args.repeat !== undefined) scene.repeat = args.repeat;
      if (args.context_uri !== undefined) scene.context_uri = args.context_uri;
      if (Object.keys(scene).length === 0) {
        return emit(args.response_format, { ok: false, error: 'empty_scene' }, 'Scene has no fields to save — provide at least one of device_hint, volume, shuffle, repeat, context_uri.');
      }

      const store = await loadScenes();
      const existed = args.name in store;
      store[args.name] = scene;
      await saveScenes(store);

      return emit(
        args.response_format,
        { ok: true, name: args.name, scene, overwritten: existed, path: scenesFilePath() },
        `${existed ? 'Updated' : 'Saved'} scene "${args.name}" (${Object.keys(scene).join(', ')}) → ${scenesFilePath()}`,
      );
    },
  );

  server.tool(
    'list_scenes',
    'List saved playback scenes from the local sidecar',
    { response_format: ResponseFormat },
    async (args) => {
      const store = await loadScenes();
      const names = Object.keys(store).sort();
      if (names.length === 0) {
        return { content: [{ type: 'text', text: 'No saved scenes. Use save_scene to create one.' }] };
      }
      const lines = names.map((n) => {
        const s = store[n]!;
        const bits = [
          s.device_hint !== undefined ? `device~"${s.device_hint}"` : null,
          s.volume !== undefined ? `vol ${s.volume}` : null,
          s.shuffle !== undefined ? `shuffle ${s.shuffle}` : null,
          s.repeat !== undefined ? `repeat ${s.repeat}` : null,
          s.context_uri ?? null,
        ].filter(Boolean);
        return `- ${n}: ${bits.join(', ')}`;
      });
      const echo = { ok: true, count: names.length, scenes: store };
      if (args.response_format === 'json') {
        return { content: [{ type: 'text', text: JSON.stringify(echo, null, 2) }], structuredContent: echo };
      }
      return {
        content: [{ type: 'text', text: `${names.length} scene(s):\n${lines.join('\n')}` }],
        structuredContent: echo,
      };
    },
  );

  server.tool(
    'delete_scene',
    'Delete a saved playback scene from the local sidecar',
    { name: z.string().min(1).describe('Scene name to delete'), response_format: ResponseFormat },
    async (args) => {
      const store = await loadScenes();
      if (!(args.name in store)) {
        return emit(args.response_format, { ok: false, error: 'not_found' }, `No scene named "${args.name}".`);
      }
      delete store[args.name];
      await saveScenes(store);
      return emit(args.response_format, { ok: true, deleted: args.name }, `Deleted scene "${args.name}".`);
    },
  );

  server.tool(
    'apply_scene',
    'Apply a saved scene: resolve its device hint, transfer playback, then set volume/shuffle/repeat and start the saved context (in that order; missing targets are skipped)',
    {
      name: z.string().min(1).describe('Scene name to apply'),
      dry_run: DryRun,
      response_format: ResponseFormat,
    },
    async (args) => {
      const store = await loadScenes();
      const scene = store[args.name];
      if (!scene) {
        const known = Object.keys(store).sort();
        return emit(
          args.response_format,
          { ok: false, error: 'not_found', available: known },
          `No scene named "${args.name}".${known.length ? ` Saved: ${known.join(', ')}.` : ' No scenes saved yet.'}`,
        );
      }

      // Resolution is a read-only GET; everything below is either reported
      // (dry_run) or executed in strict order: transfer → volume → shuffle →
      // repeat → play.
      let deviceId: string | null = null;
      if (scene.device_hint !== undefined) {
        ({ deviceId } = await resolveDeviceHint(client, scene.device_hint));
      }
      const steps = planSteps(scene, deviceId);

      if (args.dry_run) {
        const lines = steps.map((s) =>
          s.call === '(skipped)' ? `  - SKIP: ${s.detail}` : `  - ${s.action}: ${s.call}`,
        );
        const text =
          `[dry run] Would apply scene "${args.name}":\n${lines.join('\n')}\n` +
          '[dry run] Nothing was changed.';
        return {
          content: [{ type: 'text', text }],
          structuredContent: { ok: true, dry_run: true, scene: args.name, device_id: deviceId, steps },
        };
      }

      const executed: ExecutedStep[] = [];
      const run = async (step: PlannedStep): Promise<void> => {
        if (step.call === '(skipped)') {
          executed.push({ ...step, status: 'skipped' });
          return;
        }
        try {
          switch (step.action) {
            case 'transfer':
              await client.put('/me/player', { device_ids: [deviceId!] });
              break;
            case 'volume':
              await client.put(
                `/me/player/volume?${new URLSearchParams({ volume: String(scene.volume!), ...(deviceId ? { device_id: deviceId } : {}) })}`,
              );
              break;
            case 'shuffle':
              await client.put(
                `/me/player/shuffle?${new URLSearchParams({ state: String(scene.shuffle!), ...(deviceId ? { device_id: deviceId } : {}) })}`,
              );
              break;
            case 'repeat':
              await client.put(
                `/me/player/repeat?${new URLSearchParams({ state: scene.repeat!, ...(deviceId ? { device_id: deviceId } : {}) })}`,
              );
              break;
            case 'play':
              await client.put(
                deviceId ? `/me/player/play?device_id=${encodeURIComponent(deviceId)}` : '/me/player/play',
                { context_uri: scene.context_uri! },
              );
              break;
          }
          executed.push({ ...step, status: 'applied' });
        } catch (err) {
          // Each step is tolerant: one failing call never aborts the rest.
          executed.push({ ...step, status: 'failed', error: err instanceof Error ? err.message : String(err) });
        }
      };
      for (const step of planSteps(scene, deviceId)) {
        await run(step);
      }

      const applied = executed.filter((s) => s.status === 'applied').length;
      const skipped = executed.filter((s) => s.status === 'skipped').length;
      const failed = executed.filter((s) => s.status === 'failed').length;
      const lines = executed.map((s) =>
        s.status === 'applied'
          ? `  ✓ ${s.detail}`
          : s.status === 'skipped'
            ? `  - skipped: ${s.detail}`
            : `  ✗ failed: ${s.detail} (${s.error})`,
      );
      return emit(
        args.response_format,
        { ok: failed === 0, scene: args.name, device_id: deviceId, applied, skipped, failed, steps: executed },
        `Applied scene "${args.name}": ${applied} applied, ${skipped} skipped, ${failed} failed\n${lines.join('\n')}`,
      );
    },
  );

  server.tool(
    'schedule_wind_down',
    'Ramp playback volume down to a floor over N minutes (stepping every step_minutes), then pause. Runs in-process until done or cancelled via cancel_wind_down.',
    {
      minutes: z.number().int().min(1).max(180).describe('Total ramp duration in minutes (1–180)'),
      step_minutes: z
        .number()
        .int()
        .min(1)
        .default(5)
        .describe('Minutes between volume steps (default 5)'),
      floor_volume: z
        .number()
        .int()
        .min(0)
        .max(100)
        .default(10)
        .describe('Volume floor the ramp never goes below (default 10)'),
      device_id: z.string().optional().describe('Target device id; defaults to the active device'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const state = await client.get<PlaybackState>('/me/player');
      const capturedVol = state?.device?.volume_percent;
      if (typeof capturedVol !== 'number') {
        return emit(
          args.response_format,
          { ok: false, error: 'no_active_device' },
          'No active device — cannot capture the starting volume for a wind-down.',
        );
      }
      const startVol = Math.min(100, Math.max(0, Math.round(capturedVol)));
      const schedule = computeWindDownSchedule(startVol, args.minutes, args.step_minutes, args.floor_volume);
      const key = windDownKey(args.device_id);
      startWindDown(key, schedule, args.device_id, client);

      const lines = [
        ...schedule.map((s) => `  +${s.at_minute}m → volume ${s.volume}`),
        `  +${schedule.length * args.step_minutes}m → pause`,
      ];
      const echo = {
        ok: true,
        started_from: startVol,
        floor: args.floor_volume,
        step_minutes: args.step_minutes,
        device_id: args.device_id ?? null,
        schedule,
        pause_at_minute: schedule.length * args.step_minutes,
      };
      return emit(
        args.response_format,
        echo,
        `Wind-down started from volume ${startVol} → floor ${args.floor_volume} over ${args.minutes}m:\n${lines.join('\n')}\nCancel with cancel_wind_down. The fade runs only while this MCP server process is running — closing the client cancels it.`,
      );
    },
  );

  server.tool(
    'cancel_wind_down',
    'Cancel the in-process wind-down ramp, if one is running',
    { device_id: z.string().optional().describe('Only cancel if the active wind-down targets this device id'), response_format: ResponseFormat },
    async (args) => {
      const matches = !current || (args.device_id ? current.key === windDownKey(args.device_id) : true);
      const cancelled = matches && cancelActive();
      return emit(
        args.response_format,
        { ok: true, cancelled },
        cancelled ? 'Cancelled 1 wind-down.' : 'No active wind-down to cancel.',
      );
    },
  );
}
