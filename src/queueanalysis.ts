/**
 * Local analyses over one `GET /me/player/queue` read (#847).
 *
 * Eight registered tools used to answer "what is in my queue" from this one
 * endpoint — `get_queue`, `describe_queue`, `peek_next`, `get_queue_snapshot`,
 * `queue_runtime_report`, `queue_duplicate_check`, `predict_next_tracks` and
 * `queue_profile` — each with its own request and its own payload. The
 * analyses below are the part that was worth keeping; the registrations were
 * not, and they are now two entry points (`get_queue` with `include:`, and
 * `peek_next`) that compute all of this in ONE pass over ONE read.
 *
 * It lives in `src/` rather than in a tool module because `tools/playback.ts`
 * (which owns `get_queue`) and `tools/swarm3_playback.ts` (which still owns
 * queue planners) both consume it, and a tool module must never be imported
 * into another one for its helpers. Nothing here makes a request: every
 * function takes the already-fetched rows.
 *
 * The rule every analysis here follows is #803's: a value that could not be
 * read is reported as unreadable with a reason, never coerced into a plausible
 * number. `runtimeAnalysis` is the case in point — the current track's REMAINING
 * time is a second endpoint (`GET /me/player`), so when that read fails the
 * field is `null` with `current_track_remaining_error` set, and
 * `estimated_total_wait_ms` is `null` rather than "just the queue runtime",
 * which would read as "you are already at the last track".
 */

import type { PlaybackState, SpotifyEpisode, SpotifyQueue, SpotifyTrack } from './types/spotify.js';

type PlayableItem = SpotifyTrack | SpotifyEpisode;

/** One upcoming row, normalized so the analyses never re-derive the same fields. */
export interface QueueRow {
  /** 1-based position in the upcoming queue. */
  position: number;
  uri: string;
  name: string;
  /** Artist names for a track, show name for an episode. */
  subtitle: string;
  duration_ms: number;
  is_episode: boolean;
  album_name: string | null;
  show_name: string | null;
  artist_names: string[];
}

function isTrackItem(item: PlayableItem | null): item is SpotifyTrack {
  return item !== null && 'artists' in item;
}

function itemTitle(item: PlayableItem | null): string {
  if (!item) return '—';
  return item.name;
}

function itemSubtitle(item: PlayableItem | null): string {
  if (!item) return '—';
  if ('artists' in item) return (item.artists ?? []).map((a) => a.name).join(', ') || 'unknown artist';
  return item.show?.name ?? 'episode';
}

/** Artist names on a playable row, structurally (an ad or unknown type has none). */
function rowArtists(item: PlayableItem | null | undefined): string[] {
  if (!item || !('artists' in item)) return [];
  return ((item as SpotifyTrack).artists ?? [])
    .map((a) => a.name)
    .filter((name): name is string => Boolean(name));
}

/**
 * The upcoming queue as normalized rows.
 *
 * Structural on purpose: `currently_playing_type` also admits `ad` and
 * `unknown` (#852), so a row is typed by what it carries rather than by an
 * assertion about its `type` field.
 */
export function queueRows(queue: SpotifyQueue | null | undefined): QueueRow[] {
  const items = Array.isArray(queue?.queue) ? queue.queue : [];
  return items.map((item, i) => toRow(item, i + 1));
}

/**
 * The currently-playing item as a row, or null when nothing is playing.
 *
 * Exposed separately so a caller can count the playing item in the same
 * vocabulary as the upcoming rows without synthesizing a fake queue around it
 * — the retired `queue_profile` counted it, and its replacement has to say
 * which way it counts or the number changes meaning under a name that used
 * to be right.
 */
export function playingRow(item: PlayableItem | null | undefined): QueueRow | null {
  return item ? toRow(item, 0) : null;
}

function toRow(item: PlayableItem, position: number): QueueRow {
  return {
    position,
    uri: item?.uri ?? '',
    name: itemTitle(item),
    subtitle: itemSubtitle(item),
    duration_ms: item?.duration_ms ?? 0,
    is_episode: !isTrackItem(item),
    album_name: isTrackItem(item) ? item.album?.name ?? null : null,
    show_name: isTrackItem(item) ? null : item.show?.name ?? null,
    artist_names: rowArtists(item),
  };
}

/** `m:ss`, or `h:mm:ss` past the hour. */
export function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Rounded hours/minutes, for totals a person reads rather than adds up. */
export function formatLong(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * One row of the play-order timeline.
 *
 * A `QueueRow` plus `plays_at_ms`, which makes this a strict superset of what
 * the retired `predict_next_tracks` returned in `items[]` — the union claim in
 * SPEC.md is only honest if the rows really do still carry everything they
 * carried, so the shape is declared as a widening of the row rather than a
 * hand-picked subset of the fields that happened to look good.
 */
export type RuntimeTimelineEntry = QueueRow & {
  /** Milliseconds from now until this item starts playing. */
  plays_at_ms: number;
};

export interface RuntimeAnalysis {
  upcoming_count: number;
  total_runtime_ms: number;
  total_runtime_formatted: string;
  average_runtime_ms: number;
  longest: { uri: string; name: string; duration_ms: number } | null;
  shortest: { uri: string; name: string; duration_ms: number } | null;
  /** Milliseconds left on the CURRENT track, or null when unread. */
  current_track_remaining_ms: number | null;
  /** Null whenever `current_track_remaining_ms` is — never a partial total. */
  estimated_total_wait_ms: number | null;
  /**
   * Per-item start times, the ETA the retired `predict_next_tracks` returned.
   * Null for the same reason `estimated_total_wait_ms` is: every offset in it
   * is measured from the current track's position, so an unread position makes
   * all of them unread, and an array of plausible-looking offsets would be a
   * whole column of #803 rather than one field.
   */
  timeline: RuntimeTimelineEntry[] | null;
  /** Why the current-track field is null, or null when it was read. */
  current_track_remaining_error: string | null;
}

/**
 * How long the queue takes to drain, from the rows already in hand.
 *
 * `state` is the `GET /me/player` response when the caller had one to read;
 * `stateError` is the failure text when it did not. The two are passed rather
 * than fetched so this function provably issues no request, which is what lets
 * the one-read contract in SPEC.md be a test rather than a promise.
 */
export function runtimeAnalysis(
  rows: readonly QueueRow[],
  state: PlaybackState | null,
  stateError: string | null = null,
): RuntimeAnalysis {
  const durations = rows.map((r) => r.duration_ms);
  const totalMs = durations.reduce((n, d) => n + d, 0);
  const avgMs = rows.length ? Math.round(totalMs / rows.length) : 0;
  const longest = rows.reduce<QueueRow | null>((best, r) => (!best || r.duration_ms > best.duration_ms ? r : best), null);
  const shortest = rows.reduce<QueueRow | null>((best, r) => (!best || r.duration_ms < best.duration_ms ? r : best), null);
  // Absent `item` is an answered question ("nothing is playing"), so it is 0.
  // A FAILED read is not, and never becomes 0 (#803).
  const remaining = state
    ? state.item
      ? Math.max(0, (state.item.duration_ms ?? 0) - (state.progress_ms ?? 0))
      : 0
    : null;
  const why = state ? null : stateError ?? 'playback state was not read';
  let timeline: RuntimeTimelineEntry[] | null = null;
  if (remaining !== null) {
    let cursor = remaining;
    timeline = rows.map((r) => {
      const entry = { ...r, plays_at_ms: cursor };
      cursor += r.duration_ms;
      return entry;
    });
  }
  return {
    upcoming_count: rows.length,
    total_runtime_ms: totalMs,
    total_runtime_formatted: formatLong(totalMs),
    average_runtime_ms: avgMs,
    longest: longest ? { uri: longest.uri, name: longest.name, duration_ms: longest.duration_ms } : null,
    shortest: shortest ? { uri: shortest.uri, name: shortest.name, duration_ms: shortest.duration_ms } : null,
    current_track_remaining_ms: remaining,
    estimated_total_wait_ms: remaining === null ? null : totalMs + remaining,
    timeline,
    current_track_remaining_error: remaining === null ? why : null,
  };
}

export interface DuplicateGroup {
  uri: string;
  name: string;
  occurrences: number;
  positions: number[];
  wasted_runtime_ms: number;
}

export interface DuplicateAnalysis {
  duplicate_groups: DuplicateGroup[];
  total_redundant: number;
  wasted_runtime_ms: number;
  /** Rows with no URI, which cannot be compared and are reported, not skipped. */
  unreadable_rows: number;
}

/** Repeated rows in the upcoming queue and the runtime they waste. */
export function duplicateAnalysis(rows: readonly QueueRow[]): DuplicateAnalysis {
  const byUri = new Map<string, QueueRow[]>();
  let unreadable = 0;
  for (const r of rows) {
    if (!r.uri) { unreadable++; continue; }
    const list = byUri.get(r.uri) ?? [];
    list.push(r);
    byUri.set(r.uri, list);
  }
  const groups = [...byUri.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([uri, list]) => ({
      uri,
      name: list[0].name,
      occurrences: list.length,
      positions: list.map((r) => r.position),
      wasted_runtime_ms: list.slice(1).reduce((n, r) => n + r.duration_ms, 0),
    }))
    .sort((a, b) => a.positions[0] - b.positions[0]);
  return {
    duplicate_groups: groups,
    total_redundant: groups.reduce((n, g) => n + g.occurrences - 1, 0),
    wasted_runtime_ms: groups.reduce((n, g) => n + g.wasted_runtime_ms, 0),
    unreadable_rows: unreadable,
  };
}

export interface ProfileAnalysis {
  total: number;
  tracks: number;
  episodes: number;
  unique_artists: number;
  unique_albums: number;
  unique_shows: number;
  longest_artist_block: { artist: string; tracks: number } | null;
}

/**
 * Composition of the queue: how many distinct artists/albums/shows, the
 * track-vs-episode mix, and the longest run of one artist.
 *
 * `includeCurrentlyPlaying` is what makes this match the retired
 * `queue_profile`, which counted the playing item as part of the queue. It is
 * a parameter rather than a constant because the two callers want different
 * answers and guessing which is "the" one is exactly how the two old payloads
 * drifted apart in the first place.
 */
export function profileAnalysis(
  rows: readonly QueueRow[],
  includeCurrentlyPlaying: QueueRow | null = null,
): ProfileAnalysis {
  const all = includeCurrentlyPlaying ? [includeCurrentlyPlaying, ...rows] : [...rows];
  const artists = new Set<string>();
  const albums = new Set<string>();
  const shows = new Set<string>();
  let tracks = 0;
  let episodes = 0;
  for (const r of all) {
    if (r.is_episode) {
      episodes++;
      shows.add(r.show_name ?? 'unknown show');
    } else {
      tracks++;
      for (const a of r.artist_names) artists.add(a);
      if (r.album_name) albums.add(r.album_name);
    }
  }
  let blockArtist = '';
  let blockLen = 0;
  let curArtist = '';
  let curLen = 0;
  for (const r of all) {
    const first = r.artist_names[0] ?? '';
    if (first === curArtist) curLen++;
    else { curArtist = first; curLen = 1; }
    if (curLen > blockLen && curArtist) { blockArtist = curArtist; blockLen = curLen; }
  }
  return {
    total: all.length,
    tracks,
    episodes,
    unique_artists: artists.size,
    unique_albums: albums.size,
    unique_shows: shows.size,
    longest_artist_block: blockArtist ? { artist: blockArtist, tracks: blockLen } : null,
  };
}
