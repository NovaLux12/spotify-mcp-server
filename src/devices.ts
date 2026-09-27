/**
 * The one device line, shared by the `get_devices` tool and the
 * `spotify://player/devices` resource (#603).
 *
 * ## Why this module exists
 *
 * The device row has a non-obvious field read — the #855 `volume_percent`
 * guard, where Spotify omits the field on some devices and sends `null` on
 * others. Written twice, that guard is a regression waiting to happen: the
 * resource can end up printing `volume: undefined%` while the tool next to it
 * prints `volume: unknown`, and nothing in the build notices, because the two
 * copies are each internally correct. AGENTS.md §6 calls this the failure mode
 * that "a correctly named field can still lie about its value".
 *
 * So the field read lives here once, and both surfaces call it. The
 * acceptance criterion for #603 — resource output for devices matches the
 * corresponding tool output field-for-field — is then structural rather than
 * something two renderers have to be kept in agreement by hand.
 */
import type { SpotifyDevice } from './types/spotify.js';

/** What both surfaces print when Spotify reports zero devices. */
export const DEVICES_EMPTY_MESSAGE = 'No devices found. Open Spotify on a device to make it available.';

/**
 * One device as a single prose row, e.g.
 * `• Living Room (Speaker) [ACTIVE], volume: 42% — ID: dev1`.
 *
 * The active flag and the volume are read here and nowhere else, so the tool
 * and the resource cannot disagree about them.
 */
export function deviceLine(d: SpotifyDevice): string {
  const active = d.is_active ? ' [ACTIVE]' : '';
  // #855: the API omits `volume_percent` on some devices (and sends null on
  // others) — a `!== null` guard let the undefined case through and printed
  // "volume: undefined%". A volume-capable device with no reported level is
  // unknown, not 0% and not undefined%; a device that cannot report volume
  // at all says nothing.
  const reported = typeof d.volume_percent === 'number' && Number.isFinite(d.volume_percent);
  const volume = reported
    ? `, volume: ${d.volume_percent}%`
    : d.supports_volume
      ? ', volume: unknown'
      : '';
  return `• ${d.name} (${d.type})${active}${volume} — ID: ${d.id ?? 'n/a'}`;
}
