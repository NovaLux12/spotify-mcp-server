/**
 * Playback sidecar stores and the one device resolver (#848).
 *
 * ## Why this module exists
 *
 * #848 collapses the transfer and volume tool families onto one tool each.
 * The surviving tools are `transfer_playback` and `set_volume`, and both live
 * in `playback.ts` — which is in the `core` toolset, so it is evaluated in
 * essentially every session.
 *
 * The behaviour being absorbed, however, did not all live there. `mute` kept
 * its remembered level in the **exhaust2** sidecar; `apply_device_presets`
 * and every sidecar label read **playbackext**; and each of the three modules
 * involved carried its OWN `resolveDeviceHint`. Simply importing those modules
 * into `playback.ts` would have been the small change and the wrong one: a
 * static import of a tool module evaluates it, and `playback.ts` importing
 * `exhaust2_playback.js` would drag that module's whole 23-tool surface into
 * every `core` session. That is the lazy-loading contract from #906 — the
 * manifest holds a specifier plus a thunk precisely so a trimmed toolset is
 * never evaluated — and `tests/lazy-module-loading.test.ts` holds tripwires
 * for it.
 *
 * So the STORES move here, and `playback.ts` imports a plain module with no
 * registrar in it. `playbackext.ts` and `exhaust2_playback.ts` re-export from
 * here rather than keeping private copies, so every existing importer
 * (`logout.ts`, `portability.ts`, `exhaust2_misc.ts`, the tests) keeps working
 * and there is still exactly one implementation of each store's read/validate/
 * write policy.
 *
 * The resolver moves for the same reason and for a second one: there were
 * three near-identical copies (exhaust2's, playbackintel's, scenes'), and they
 * had **drifted**. exhaust2's consulted the sidecar label, the other two did
 * not; scenes' matched names case-insensitively, playbackintel's did not.
 * Collapsing the tools without collapsing the resolver would have picked one
 * of the three behaviours arbitrarily. The one resolver here is the superset:
 * exact id, then sidecar label, then case-insensitive name substring.
 *
 * That superset is deliberately a behaviour change for the tools that keep
 * using it — a device that previously resolved only by id now also resolves by
 * the label someone stored. It is a widening, not a redefinition, and
 * `tests/tools.playback-collapse.test.ts` pins each precedence step.
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { storePath } from './config.js';
import { loadSidecar, SidecarUnreadableError } from './sidecar.js';
import type { SpotifyClient } from './client.js';
import type { GetDevicesResponse, PlaybackState, SpotifyDevice } from './types/spotify.js';

// ---------------------------------------------------------------------------
// playbackext store
// ---------------------------------------------------------------------------

export function playbackExtFile(env: NodeJS.ProcessEnv = process.env): string {
  return storePath('playback-extensions', env);
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
export function emptyPlaybackExtStore(): PlaybackExtStore {
  return { states: {}, devicePresets: {}, sessions: {}, smartRules: {} };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePlaybackExtStore(parsed: unknown): PlaybackExtStore {
  if (!isPlainObject(parsed)) throw new Error('top level is not a JSON object');
  for (const key of ['states', 'devicePresets', 'sessions', 'smartRules'] as const) {
    if (parsed[key] !== undefined && !isPlainObject(parsed[key])) {
      throw new Error(`"${key}" is not a JSON object`);
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

export async function loadPlaybackExt(env: NodeJS.ProcessEnv = process.env): Promise<PlaybackExtStore> {
  const file = playbackExtFile(env);
  try {
    return await loadSidecar<PlaybackExtStore>(file, emptyPlaybackExtStore, parsePlaybackExtStore);
  } catch (err) {
    if (err instanceof SidecarUnreadableError) {
      return {
        ...emptyPlaybackExtStore(),
        load_error: err.message,
        preserved_as: err.preservedAs,
      };
    }
    throw err;
  }
}

export async function savePlaybackExt(store: PlaybackExtStore, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const file = playbackExtFile(env);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  // `load_error` is a report about this call, not store content: persisting it
  // would make the next load claim a corruption that has already been resolved.
  const { load_error: _loadError, preserved_as: _preservedAs, ...persisted } = store;
  await writeFile(file, `${JSON.stringify(persisted, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  // #1084: mode only applies at creation; re-assert so a pre-existing or
  // copied-in store does not stay world-readable after this write.
  await chmod(file, 0o600);
}

// ---------------------------------------------------------------------------
// exhaust2 store
// ---------------------------------------------------------------------------

export function exhaust2PlaybackFile(env: NodeJS.ProcessEnv = process.env): string {
  return storePath('exhaust2-playback', env);
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
  return loadSidecar<Exhaust2Store>(
    exhaust2PlaybackFile(env),
    () => ({ muteMemory: {}, episodeBookmarks: {}, checkpoints: {} }),
    (parsed) => {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('top level is not a JSON object');
      }
      const p = parsed as Record<string, unknown>;
      for (const key of ['muteMemory', 'episodeBookmarks', 'checkpoints'] as const) {
        if (p[key] !== undefined && (typeof p[key] !== 'object' || p[key] === null || Array.isArray(p[key]))) {
          throw new Error(`"${key}" is not a JSON object`);
        }
      }
      return {
        muteMemory: (p.muteMemory ?? {}) as Record<string, MuteMemory>,
        episodeBookmarks: (p.episodeBookmarks ?? {}) as Record<string, EpisodeBookmark>,
        checkpoints: (p.checkpoints ?? {}) as Record<string, Exhaust2Checkpoint>,
      };
    },
  );
}

export async function saveExhaust2Store(store: Exhaust2Store, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const file = exhaust2PlaybackFile(env);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  // #1084: mode only applies at creation; re-assert so a pre-existing or
  // copied-in store does not stay world-readable after this write.
  await chmod(file, 0o600);
}

// ---------------------------------------------------------------------------
// the one device resolver
// ---------------------------------------------------------------------------

export interface DeviceResolution {
  /**
   * The resolved device, or null when nothing matched. Callers that need an id
   * read `device?.id ?? null` rather than a second returned field: a resolution
   * carrying both a device and a `deviceId` invites a caller to use one while
   * meaning the other, and the two can only ever disagree by bug.
   */
  device: SpotifyDevice | null;
  /** Every device Spotify reported, for the "available devices" refusal. */
  devices: SpotifyDevice[];
  /**
   * Why the sidecar-label step was skipped, or null when it ran (or an earlier
   * step already decided the answer). A non-null value means a device the
   * caller named by label may exist and simply could not be checked.
   */
  labelLookupFailed: string | null;
}

/**
 * The precedence itself, as a PURE function over a device list.
 *
 *   1. an EXACT device id — the only unambiguous match, and what every caller
 *      that already holds an id means;
 *   2. a sidecar LABEL, case-insensitively — the label `rename_device` stored,
 *      which is the name a human gave this speaker;
 *   3. a case-insensitive NAME SUBSTRING — the fuzzy match, and the reason
 *      `switch_device` existed at all.
 *
 * Pure, and over a list the caller already has, because the two callers have
 * different fetch costs: a single hint can afford one `GET
 * /me/player/devices`, while a fan-out over N hints must NOT pay N of them. If
 * the precedence lived only inside the async resolver, the fan-out would either
 * re-derive it (and drift) or make N requests (and be slow for a device that is
 * already known by id).
 *
 * Returns `null` rather than guessing when nothing matches, so the caller can
 * refuse with the list of real names. A resolver that fell back to "the first
 * device" would move the music to a speaker nobody asked for.
 */
export function matchDevice(
  devices: readonly SpotifyDevice[],
  hint: string,
  labels: Readonly<Record<string, string | undefined>> = {},
): SpotifyDevice | null {
  const exact = devices.find((d) => d.id === hint);
  if (exact) return exact;

  const wanted = hint.trim().toLowerCase();
  if (wanted !== '') {
    const byLabel = devices.find((d) => (labels[d.id ?? ''] ?? '').toLowerCase() === wanted);
    if (byLabel) return byLabel;
  }

  const lower = hint.toLowerCase();
  return devices.find((d) => d.name.toLowerCase().includes(lower)) ?? null;
}

/**
 * Load the sidecar device labels, or `{}` when they cannot be read.
 *
 * A failed read is reported rather than thrown, because the caller's real
 * decision — id match, name match, or refuse — is still answerable without
 * labels; it just has one fewer fallback.
 *
 * The failure is read off `store.load_error` and NOT off a `try`/`catch` around
 * `loadPlaybackExt`, because that function does not throw for a corrupt file:
 * #839's policy is to preserve the bytes and hand back an EMPTY store carrying
 * the reason. A `catch` here would therefore never fire, `failed` would always
 * be null, and a caller naming a device by its saved label would be told "no
 * device matches" as a definite answer to a question that was never asked —
 * the #803 failure in a resolver rather than a chart. The empty map and the
 * reason come from the same read, so they cannot disagree.
 */
export async function loadDeviceLabels(): Promise<{ labels: Record<string, string | undefined>; failed: string | null }> {
  try {
    const store = await loadPlaybackExt();
    if (store.load_error) return { labels: {}, failed: store.load_error };
    const labels: Record<string, string | undefined> = {};
    for (const [id, preset] of Object.entries(store.devicePresets)) labels[id] = preset?.label;
    return { labels, failed: null };
  } catch (err) {
    return { labels: {}, failed: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Resolve one device hint against `GET /me/player/devices`, through
 * {@link matchDevice}'s precedence.
 *
 * A sidecar that will not load must not silently remove the label step: it
 * degrades to id-then-name, and says so in `labelLookupFailed` rather than
 * pretending the label did not exist.
 */
export async function resolveDeviceHint(
  client: SpotifyClient,
  hint: string,
): Promise<DeviceResolution & { labelLookupFailed: string | null }> {
  const res = await client.get<GetDevicesResponse>('/me/player/devices');
  const devices = res?.devices ?? [];

  // An exact id needs no sidecar read at all, so the common case costs one GET
  // and no disk access.
  if (devices.some((d) => d.id === hint)) {
    return { device: matchDevice(devices, hint), devices, labelLookupFailed: null };
  }

  const { labels, failed } = await loadDeviceLabels();
  return { device: matchDevice(devices, hint, labels), devices, labelLookupFailed: failed };
}
