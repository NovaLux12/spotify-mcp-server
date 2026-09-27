/**
 * stats.fm taste-intelligence slice (v2 taste track).
 *
 * Eight read-only tools over the stats.fm PUBLIC API v1 (no auth).
 *
 * Every read goes through the one shared client in `lib/statsfm-client.ts`,
 * which owns the base URL, the request timeout, the retry and the cache (#907).
 * This module used to carry a second copy of the base-URL constant and a bare
 * `fetch` with no timeout, so the ~124 KB `/users/{u}/streams` page was
 * re-downloaded by every sibling tool and a stalled response blocked forever.
 * What stays here is only a parsed-payload test seam for the pure-analytics
 * suite, which the client adapts onto its own transport.
 *
 * Parsing is deliberately lenient: stats.fm shapes vary across endpoints
 * (streams vs top vs stats), so every extractor tolerates missing/renamed
 * fields and degrades to "not enough data" prose instead of crashing.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SpotifyClient } from '../client.js';
import { loadSidecar } from '../sidecar.js';
import {
  ResponseFormat,
  MaxResults,
  resolveMaxResults,
  truncateItems,
  paginationInfo,
  listStructuredContent,
} from '../shaping.js';

import {
  StatsfmClient,
  __setStatsfmClient,
  statsfmClient,
  statsfmFetchFromPayloadImpl,
  resolveStatsfmUserId,
} from '../lib/statsfm-client.js';
import { statsfmRangeSchema } from './statsfm.js';
import { storePath } from '../config.js';

// ---------------------------------------------------------------------------
// Parsed-payload fixture seam over the shared stats.fm client
// ---------------------------------------------------------------------------

/** Minimal fetch: full URL in, parsed JSON out (or throw). */
type StatsfmFetchImpl = (url: string) => Promise<unknown>;

/**
 * Test seam: inject fixture-backed fetch. It becomes the active client for
 * every stats.fm module (#907), so a suite that drives two of them against one
 * fixture also exercises the shared cache.
 */
export function __setStatsfmFetchImpl(impl: StatsfmFetchImpl): void {
  __setStatsfmClient(new StatsfmClient(statsfmFetchFromPayloadImpl(impl)));
}

/** Test seam: restore live requests through the shared client. */
export function __resetStatsfmFetchImpl(): void {
  __setStatsfmClient(undefined);
}

async function statsfmGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  return (await statsfmClient().get<T>(path, params)) as T;
}

// ---------------------------------------------------------------------------
// Lenient stats.fm shapes
// ---------------------------------------------------------------------------

interface RawItem {
  [k: string]: unknown;
}

function asItems(payload: unknown): RawItem[] {
  if (Array.isArray(payload)) return payload as RawItem[];
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.items)) return obj.items as RawItem[];
    if (Array.isArray(obj.data)) return obj.data as RawItem[];
  }
  return [];
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Stream/total count across stats.fm field-name variants. */
function countOf(it: RawItem): number {
  for (const k of ['streams', 'streamCount', 'playCount', 'plays', 'count', 'total']) {
    const n = num(it[k], NaN);
    if (Number.isFinite(n) && n !== 0) return n;
  }
  return num(it.streams, 0);
}

function genreNameOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as RawItem;
    return str(o.tag) || str(o.name) || str(o.genre);
  }
  return '';
}

function nestedObj(it: RawItem, key: string): RawItem | undefined {
  const v = it[key];
  return v && typeof v === 'object' ? (v as RawItem) : undefined;
}

function nameOf(it: RawItem): string {
  // Flat shapes (existing fixtures): { name }, { genre }, { item: { name } }.
  // Live stats.fm top payloads are wrapped:
  //   artists: { position, streams, playedMs, artist: { id, name } }
  //   tracks:  { ..., track: { id, name } }
  //   albums:  { ..., album: { id, name } }
  //   genres:  { ..., genre: string | { tag/name } }
  return (
    str(it.name) ||
    genreNameOf(it.genre) ||
    str(nestedObj(it, 'artist')?.name) ||
    str(nestedObj(it, 'track')?.name) ||
    str(nestedObj(it, 'album')?.name) ||
    str((it.item as RawItem | undefined)?.name) ||
    genreNameOf((it.item as RawItem | undefined)?.genre) ||
    str(nestedObj((it.item as RawItem | undefined) ?? {}, 'artist')?.name) ||
    str(nestedObj((it.item as RawItem | undefined) ?? {}, 'track')?.name) ||
    str(nestedObj((it.item as RawItem | undefined) ?? {}, 'album')?.name) ||
    'unknown'
  );
}

/** Prefer the nested entity id (artist/track/album) over the wrapper id. */
export function idOf(it: RawItem): string {
  return (
    str(nestedObj(it, 'artist')?.id) ||
    str(nestedObj(it, 'track')?.id) ||
    str(nestedObj(it, 'album')?.id) ||
    str((it.item as RawItem | undefined)?.id) ||
    str(it.id) ||
    nameOf(it)
  );
}

/** Normalized stream row used by every analytic below. */
export interface TasteStream {
  trackId: string;
  trackName: string;
  artistNames: string[];
  playedAtMs: number;
}

function artistNamesOf(track: RawItem | undefined): string[] {
  if (!track || typeof track !== 'object') return [];
  const raw = track.artists;
  if (!Array.isArray(raw)) {
    const single = str(track.artistName) || str(track.artist);
    return single ? [single] : [];
  }
  return (raw as RawItem[])
    .map((a) => (typeof a === 'string' ? a : str(a.name)))
    .filter((n) => n.length > 0);
}

function playedAtOf(entry: RawItem): number {
  for (const k of ['playedAt', 'endTime', 'played_at', 'timestamp', 'createdAt']) {
    const v = entry[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
    if (typeof v === 'string') {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return t;
    }
  }
  // Some stream rows nest under `item`/`stream`.
  for (const k of ['item', 'stream']) {
    const nested = entry[k];
    if (nested && typeof nested === 'object') {
      const t = playedAtOf(nested as RawItem);
      if (t > 0) return t;
    }
  }
  return 0;
}

function trackOf(entry: RawItem): RawItem | undefined {
  for (const k of ['track', 'item', 'stream']) {
    const v = entry[k];
    if (v && typeof v === 'object') {
      const obj = v as RawItem;
      // Unwrap one more level: { item: { track: {...} } }.
      if (obj.track && typeof obj.track === 'object') return obj.track as RawItem;
      if (obj.name !== undefined || obj.artists !== undefined || obj.id !== undefined) {
        return obj;
      }
    }
  }
  // Flat row: the entry itself carries track fields.
  if (entry.trackName !== undefined || entry.trackId !== undefined) return entry;
  return undefined;
}

/** Normalize any stats.fm streams payload into flat rows (drops undated rows). */
export function normalizeStreams(payload: unknown): TasteStream[] {
  const out: TasteStream[] = [];
  for (const entry of asItems(payload)) {
    const playedAtMs = playedAtOf(entry);
    if (playedAtMs <= 0) continue;
    const track = trackOf(entry);
    out.push({
      trackId: str(track?.id) || str(entry.trackId) || str(track?.name),
      trackName:
        str(track?.name) || str(entry.trackName) || 'unknown track',
      artistNames: artistNamesOf(track),
      playedAtMs,
    });
  }
  return out.sort((a, b) => a.playedAtMs - b.playedAtMs);
}

/** Normalized top-list row (artists / tracks / genres). */
interface TopRow {
  id: string;
  name: string;
  count: number;
}

export function normalizeTopList(payload: unknown): TopRow[] {
  return asItems(payload).map((it) => ({
    id: idOf(it),
    name: nameOf(it),
    count: countOf(it),
  }));
}

// ---------------------------------------------------------------------------
// Pure analytics (exported for tests)
// ---------------------------------------------------------------------------

/** Exposure ladder for a single subject. Thresholds are documented, not magic. */
type ExposureTier = 'unheard' | 'sampled' | 'explored' | 'established' | 'favorite';

export function classifyExposure(lifetimeStreams: number): ExposureTier {
  if (lifetimeStreams <= 0) return 'unheard';
  if (lifetimeStreams <= 2) return 'sampled';
  if (lifetimeStreams <= 9) return 'explored';
  if (lifetimeStreams <= 49) return 'established';
  return 'favorite';
}

/** One listening session: maximal run of streams separated by at most gapMin. */
interface ListeningSession {
  startMs: number;
  endMs: number;
  streams: number;
  tracks: string[];
}

/** Group ascending streams into sessions; a gap > gapMinutes starts a new one. */
export function groupSessions(streams: TasteStream[], gapMinutes = 30): ListeningSession[] {
  const sessions: ListeningSession[] = [];
  let current: ListeningSession | null = null;
  // Membership lives in a Set, not in `tracks` (#903): the array stays the
  // ordered, caller-visible list while `includes` stops being the hot path.
  // The set is a local and is never attached to the session, so the returned
  // shape is exactly what the previous `includes` version returned.
  let seen: Set<string> = new Set();
  const gapMs = Math.max(1, gapMinutes) * 60_000;
  for (const s of streams) {
    if (!current || s.playedAtMs - current.endMs > gapMs) {
      current = { startMs: s.playedAtMs, endMs: s.playedAtMs, streams: 0, tracks: [] };
      sessions.push(current);
      seen = new Set();
    }
    current.endMs = s.playedAtMs;
    current.streams += 1;
    if (s.trackName !== 'unknown track' && !seen.has(s.trackName)) {
      seen.add(s.trackName);
      current.tracks.push(s.trackName);
    }
  }
  return sessions;
}

/**
 * Recency half-life (days) from stream ages: assuming exponential decay,
 * median age = halfLife * ln(2), so halfLife = median / ln(2). Null when empty.
 */
export function estimateHalfLifeDays(
  streams: TasteStream[],
  nowMs = Date.now(),
): number | null {
  if (streams.length === 0) return null;
  const ages = streams
    .map((s) => (nowMs - s.playedAtMs) / 86_400_000)
    .filter((a) => a >= 0)
    .sort((a, b) => a - b);
  if (ages.length === 0) return null;
  const mid = Math.floor(ages.length / 2);
  const median =
    ages.length % 2 === 1 ? ages[mid] : (ages[mid - 1] + ages[mid]) / 2;
  return Math.round((median / Math.LN2) * 10) / 10;
}

/** Per-month roll-up consumed by era detection. */
export interface MonthlySummary {
  month: string; // YYYY-MM
  streams: number;
  topArtist: string;
  uniqueArtists: number;
}

/** Roll dated streams up into per-month summaries. */
export function summarizeMonths(streams: TasteStream[]): MonthlySummary[] {
  const byMonth = new Map<string, TasteStream[]>();
  for (const s of streams) {
    const d = new Date(s.playedAtMs);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const bucket = byMonth.get(key);
    if (bucket) bucket.push(s);
    else byMonth.set(key, [s]);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, rows]) => {
      const artistCounts = new Map<string, number>();
      for (const r of rows) {
        for (const a of r.artistNames.length > 0 ? r.artistNames : ['unknown']) {
          artistCounts.set(a, (artistCounts.get(a) ?? 0) + 1);
        }
      }
      let topArtist = 'unknown';
      let topCount = -1;
      for (const [a, c] of artistCounts) {
        if (c > topCount) {
          topCount = c;
          topArtist = a;
        }
      }
      return { month, streams: rows.length, topArtist, uniqueArtists: artistCounts.size };
    });
}

/** One listening era: a run of months with a stable signature artist/volume. */
interface ListeningEra {
  startMonth: string;
  endMonth: string;
  months: number;
  signatureArtist: string;
  avgStreamsPerMonth: number;
  /** Why this era *started* — the boundary immediately before `startMonth`. */
  boundaryReason: string;
}

/**
 * Change-point detection over monthly summaries. A new era starts when the
 * monthly top artist changes OR volume shifts by more than 60% vs the
 * previous month. Deterministic and documented — not a statistical model.
 *
 * Every era is labelled with the boundary that *opened* it: era 0 reads
 * `history start`, each later era reads `prev: <reason>` where the reason
 * compares the month before `startMonth` with `startMonth`.
 */
export function detectEras(months: MonthlySummary[]): ListeningEra[] {
  const eras: ListeningEra[] = [];
  let start = 0;
  // Why the era beginning at `start` began. Era 0 opens the history itself.
  let openReason = 'history start';
  const reasonFor = (prev: MonthlySummary, cur: MonthlySummary): string | null => {
    if (cur.topArtist !== prev.topArtist) {
      return `top artist ${prev.topArtist} → ${cur.topArtist}`;
    }
    if (prev.streams > 0) {
      const shift = Math.abs(cur.streams - prev.streams) / prev.streams;
      if (shift > 0.6) {
        return `volume shift ${prev.streams} → ${cur.streams} streams/mo`;
      }
    }
    return null;
  };
  const closeEra = (from: number, to: number, reason: string): void => {
    const slice = months.slice(from, to + 1);
    const sig = new Map<string, number>();
    let total = 0;
    for (const m of slice) {
      total += m.streams;
      sig.set(m.topArtist, (sig.get(m.topArtist) ?? 0) + m.streams);
    }
    let signatureArtist = slice[0].topArtist;
    let best = -1;
    for (const [a, c] of sig) {
      if (c > best) {
        best = c;
        signatureArtist = a;
      }
    }
    eras.push({
      startMonth: slice[0].month,
      endMonth: slice[slice.length - 1].month,
      months: slice.length,
      signatureArtist,
      avgStreamsPerMonth: Math.round(total / slice.length),
      boundaryReason: reason,
    });
  };
  for (let i = 1; i < months.length; i++) {
    const reason = reasonFor(months[i - 1], months[i]);
    if (reason !== null) {
      closeEra(start, i - 1, openReason);
      start = i;
      openReason = `prev: ${reason}`;
    }
  }
  if (months.length > 0) {
    closeEra(start, months.length - 1, openReason);
  }
  return eras;
}

/** Day-part buckets (UTC; stats.fm timestamps carry no local zone). */
type DayPart = 'night' | 'morning' | 'afternoon' | 'evening';

function dayPartOfHour(hourUtc: number): DayPart {
  if (hourUtc < 6) return 'night';
  if (hourUtc < 12) return 'morning';
  if (hourUtc < 18) return 'afternoon';
  return 'evening';
}

export function summarizeDayParting(streams: TasteStream[]): Record<DayPart, number> {
  const out: Record<DayPart, number> = { night: 0, morning: 0, afternoon: 0, evening: 0 };
  for (const s of streams) {
    out[dayPartOfHour(new Date(s.playedAtMs).getUTCHours())] += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Local-only feedback store (record_feedback never touches the network)
//
// Bounded and persisted (#905). This was a module-global array that grew for the
// life of the process, was copied in full on every read, and then vanished at
// restart: memory grew while the value did not. It is now a capped sidecar.
//
// THE CAP is three bounds, because no single one of them is sufficient.
//
//   1. One record. `subject` was `z.string().min(1)` with no maximum, so a
//      single verdict could have been arbitrarily large — a count cap on its
//      own would have let one call flush the entire ring. `note` already had a
//      500-char maximum; `subject` now has 200, and every remaining field is an
//      enum or an ISO timestamp. One record is therefore bounded at ~750 bytes.
//   2. A record count — SPOTIFY_MCP_TASTE_FEEDBACK_MAX_ENTRIES, default 500.
//      This is the bound that matters for memory and for the size of one MCP
//      list payload; a byte cap alone bounds neither, because 500 records of
//      1 KB each is still a 500 KB tool response.
//   3. A byte size — SPOTIFY_MCP_TASTE_FEEDBACK_MAX_BYTES, default 1 MiB.
//      Defence in depth: it is the on-disk guarantee that survives someone
//      later raising the count or the field caps, and it is what makes "one
//      file, N bytes" a promise the module can keep on disk.
//
// Eviction is oldest-first until all three hold, and the count of evicted
// verdicts is persisted and reported — a silently shrinking store would read as
// "the agent has no history" rather than "the cap dropped your records".
//
// RETENTION is a ring buffer, not a TTL. A verdict's value is that it is
// recent, but a TTL cannot bound a store an agent fills within one session; it
// would add a clock read to every record and every list while still leaving the
// count unbounded. The count cap is the tighter, cheaper, deterministic bound.
// (The mutation history keeps byte rotation instead, because an append-only log
// of fixed small lines is the opposite shape — there the cap is enforced by
// rotating the file, not by rewriting it.)
//
// A store that has been truncated or corrupted on load follows src/sidecar.ts
// and nothing else: ENOENT reads as empty, and every other read/parse/validate
// failure raises SidecarUnreadableError with the bytes preserved at
// `<file>.corrupt[N]` at 0600. Rotation and eviction make a malformed file more
// likely to appear, not less, so the write is structured so that it does not
// create one: temp file, fsync, then rename(2). This store is ONE JSON document,
// so a `writeFile` straight onto the path that dies mid-write would lose every
// record rather than one line.
// ---------------------------------------------------------------------------

type FeedbackRating = 'love' | 'like' | 'mixed' | 'boring' | 'dislike';
type FeedbackSubjectType = 'track' | 'artist' | 'album' | 'genre';

interface FeedbackEntry {
  id: number;
  at: string;
  subject_type: FeedbackSubjectType;
  subject: string;
  rating: FeedbackRating;
  note: string | null;
}

/**
 * On-disk envelope. `recorded`/`evicted` are lifetime counters, so an agent
 * that records 1,000 verdicts can still be told that 1,000 were recorded and
 * 500 were dropped by the cap — rather than being shown an empty store and no
 * explanation.
 */
export interface FeedbackStore {
  entries: FeedbackEntry[];
  recorded: number;
  evicted: number;
  /** Monotonic; never rewound by eviction, so an id is never reused. */
  seq: number;
}

/** Longest `subject` accepted or stored — a track/artist/album/genre name. */
export const MAX_FEEDBACK_SUBJECT_LENGTH = 200;
/** Longest `note` accepted or stored; matches the tool's declared maximum. */
export const MAX_FEEDBACK_NOTE_LENGTH = 500;

export const DEFAULT_FEEDBACK_MAX_ENTRIES = 500;
export const DEFAULT_FEEDBACK_MAX_BYTES = 1_048_576;
/** One `action=list` page, so the response cannot scale with the store. */
export const DEFAULT_FEEDBACK_LIST_LIMIT = 20;
export const MAX_FEEDBACK_LIST_LIMIT = 500;

export const FEEDBACK_FILE_MODE = 0o600;
export const FEEDBACK_DIR_MODE = 0o700;

const RATINGS: readonly string[] = ['love', 'like', 'mixed', 'boring', 'dislike'];
const SUBJECT_TYPES: readonly string[] = ['track', 'artist', 'album', 'genre'];

/**
 * Where the store lives. SPOTIFY_MCP_TASTE_FEEDBACK_FILE names the file
 * outright (the seam tests use, and the only way to keep a test run off the
 * real one); otherwise SPOTIFY_MCP_DATA_DIR overrides the directory, matching
 * every other sidecar in the server.
 */
export function tasteFeedbackFile(env: NodeJS.ProcessEnv = process.env): string {
  // Directory and file name both come from the registry; see LOCAL_STORES.
  return storePath('taste-feedback', env);
}

/** Positive integer from the environment, or the fallback for anything else. */
function capFromEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function feedbackMaxEntries(env: NodeJS.ProcessEnv = process.env): number {
  return capFromEnv(env.SPOTIFY_MCP_TASTE_FEEDBACK_MAX_ENTRIES, DEFAULT_FEEDBACK_MAX_ENTRIES);
}

export function feedbackMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  return capFromEnv(env.SPOTIFY_MCP_TASTE_FEEDBACK_MAX_BYTES, DEFAULT_FEEDBACK_MAX_BYTES);
}

function emptyStore(): FeedbackStore {
  return { entries: [], recorded: 0, evicted: 0, seq: 0 };
}

/**
 * Coerce a stored field to a bounded string, or null when it is not a string.
 * Length is clamped rather than rejected: a store written before `subject`
 * carried a maximum, or one an owner hand-edited, is still readable data. The
 * clamp is reported (see `clamped`) rather than passing through as if the long
 * value had been stored.
 */
function boundedString(value: unknown, max: number): string | null {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

/**
 * Validate the untrusted on-disk document into a FeedbackStore.
 *
 * Malformed *rows* are dropped (a store is a list; one bad row is not a corrupt
 * document), but the shape of the document itself is what throws, and that
 * throw is what routes the file through the sidecar preservation path. Long
 * fields are clamped and counted, so an oversized record is bounded on the way
 * in rather than becoming the reason the whole store is rejected.
 */
function validateFeedbackStore(parsed: unknown): FeedbackStore {
  const envelope = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  // A bare array is accepted: the first on-disk version of this store may be
  // read by a build that only knows the envelope, and vice versa.
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(envelope.entries) ? envelope.entries : null;
  if (rows === null && !Array.isArray(parsed)) {
    throw new Error('is not a feedback store: "entries" is not an array');
  }
  const entries: FeedbackEntry[] = [];
  for (const row of rows ?? []) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const id = r.id;
    if (typeof id !== 'number' || !Number.isFinite(id)) continue;
    const subject = boundedString(r.subject, MAX_FEEDBACK_SUBJECT_LENGTH);
    const rating = boundedString(r.rating, 32);
    const subjectType = boundedString(r.subject_type, 32);
    if (subject === null || rating === null || subjectType === null) continue;
    if (!RATINGS.includes(rating) || !SUBJECT_TYPES.includes(subjectType)) continue;
    const note = r.note === null || r.note === undefined ? null : boundedString(r.note, MAX_FEEDBACK_NOTE_LENGTH);
    entries.push({
      id,
      at: typeof r.at === 'string' ? r.at : '',
      subject_type: subjectType as FeedbackSubjectType,
      subject,
      rating: rating as FeedbackRating,
      note,
    });
  }
  const count = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
  // seq must be at least the highest id present, or the next record would
  // reuse an id that is still on disk.
  const highestId = entries.reduce((max, e) => (e.id > max ? e.id : max), 0);
  const seq = Math.max(count(envelope.seq), highestId);
  return {
    entries,
    recorded: Math.max(count(envelope.recorded), entries.length),
    evicted: count(envelope.evicted),
    seq,
  };
}

/** Read the store. Throws SidecarUnreadableError for anything but ENOENT. */
export function loadFeedbackStore(env: NodeJS.ProcessEnv = process.env): Promise<FeedbackStore> {
  return loadSidecar<FeedbackStore>(tasteFeedbackFile(env), emptyStore, validateFeedbackStore);
}

/** The exact bytes that would be written. Measuring beats estimating. */
function serializeStore(store: FeedbackStore): string {
  return `${JSON.stringify(store, null, 2)}\n`;
}

/**
 * Persist atomically: a uniquely-named temp file in the SAME directory, fsync,
 * then rename(2) over the target. The rename is the only mutation of the real
 * path, so a crash before it leaves the previous store whole rather than a
 * half-written one. Temp and target are owner-only and re-asserted after
 * creation because a creation-time mode is masked by umask.
 *
 * The temp name MUST be unique per writer — a fixed `<path>.tmp` is a race
 * between concurrent record_feedback calls, and the first rename moves the name
 * away so the second fails ENOENT. Same idiom as artistwatch / auth / freshness.
 *
 * Failures THROW. A verdict that reads as recorded but is not on disk is the
 * failure #764 removed from the watchlist store.
 */
async function saveFeedbackStore(store: FeedbackStore, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const file = tasteFeedbackFile(env);
  const tmp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  await mkdir(dirname(file), { recursive: true, mode: FEEDBACK_DIR_MODE });
  // Directory mode is also creation-only — tighten a pre-existing one.
  await chmod(dirname(file), FEEDBACK_DIR_MODE);
  try {
    const handle = await open(tmp, 'w', FEEDBACK_FILE_MODE);
    try {
      await handle.writeFile(serializeStore(store), 'utf8');
      await handle.sync(); // on disk before the rename can publish them
    } finally {
      await handle.close();
    }
    await chmod(tmp, FEEDBACK_FILE_MODE);
    await rename(tmp, file);
  } catch (err) {
    // A unique temp name means a failed write can leave a file nothing else
    // will ever clean up. Do not leave litter in the state directory.
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  await chmod(file, FEEDBACK_FILE_MODE);
}

/**
 * Evict oldest-first until the count cap and the byte cap both hold, and write
 * what survives. The byte loop measures the exact document it would write
 * rather than estimating it, and is a no-op at the defaults: 500 records of at
 * most ~750 bytes cannot reach 1 MiB, so the per-record and count bounds are
 * what bind in practice and this is the backstop for a raised cap.
 */
async function persistCapped(store: FeedbackStore, env: NodeJS.ProcessEnv): Promise<FeedbackStore> {
  const maxEntries = feedbackMaxEntries(env);
  const maxBytes = feedbackMaxBytes(env);
  let entries = store.entries.length > maxEntries ? store.entries.slice(store.entries.length - maxEntries) : store.entries;
  let evicted = store.evicted + (store.entries.length - entries.length);
  let seq = store.seq;
  let body = serializeStore({ ...store, entries, evicted, seq });
  while (entries.length > 0 && Buffer.byteLength(body) > maxBytes) {
    entries = entries.slice(1);
    evicted += 1;
    body = serializeStore({ ...store, entries, evicted, seq });
  }
  const capped: FeedbackStore = { entries, recorded: store.recorded, evicted, seq };
  await saveFeedbackStore(capped, env);
  return capped;
}

/**
 * Serialise load -> append -> save. record_feedback is a read-modify-write on a
 * shared path and its handler awaits, so two concurrent calls would otherwise
 * both read the same prefix and the second write would discard the first
 * record. Chaining on the tail promise makes each cycle see the previous one's
 * result; a rejection is cleared so one failed write cannot wedge the queue.
 */
let feedbackQueue: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = feedbackQueue.then(fn, fn);
  feedbackQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Record one verdict and persist the capped store. Returns the new entry, the
 * store as written, and how many verdicts the caps dropped on this call.
 */
export function recordFeedbackEntry(
  input: {
    subject_type: FeedbackSubjectType;
    subject: string;
    rating: FeedbackRating;
    note?: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ entry: FeedbackEntry; store: FeedbackStore; evictedNow: number }> {
  return serialized(async () => {
    const store = await loadFeedbackStore(env);
    const entry: FeedbackEntry = {
      id: store.seq + 1,
      at: new Date().toISOString(),
      subject_type: input.subject_type,
      subject: input.subject.slice(0, MAX_FEEDBACK_SUBJECT_LENGTH),
      rating: input.rating,
      note: input.note === undefined ? null : input.note.slice(0, MAX_FEEDBACK_NOTE_LENGTH),
    };
    const before = store.evicted;
    const capped = await persistCapped(
      { entries: [...store.entries, entry], recorded: store.recorded + 1, evicted: store.evicted, seq: entry.id },
      env,
    );
    return { entry, store: capped, evictedNow: capped.evicted - before };
  });
}

/** Rating tally over what is retained, computed from the caller's own snapshot. */
export function feedbackRatingCounts(store: FeedbackStore): Record<FeedbackRating, number> {
  const counts: Record<FeedbackRating, number> = { love: 0, like: 0, mixed: 0, boring: 0, dislike: 0 };
  for (const entry of store.entries) counts[entry.rating] += 1;
  return counts;
}

/** The failure result every feedback tool returns for an unreadable store. */
function storeUnreadable(error: string) {
  return {
    content: [{ type: 'text' as const, text: `Taste feedback store could not be read: ${error}` }],
    structuredContent: { ok: false, persisted: false, reason: 'store_unreadable', error },
    isError: true,
  };
}

/** The failure result for a verdict that did not reach disk. */
function storeUnwritable(path: string, error: unknown) {
  const message = (error as Error).message;
  return {
    content: [
      {
        type: 'text' as const,
        text:
          `NOT saved: writing ${path} failed (${message}). Nothing was persisted — ` +
          'fix the path or its permissions and re-run.',
      },
    ],
    structuredContent: { ok: false, persisted: false, reason: 'store_unwritable', path, error: message },
    isError: true,
  };
}

/** Test seam: reset the write serialisation queue. */
export function __clearFeedbackEntries(): void {
  feedbackQueue = Promise.resolve();
}

// ---------------------------------------------------------------------------
// Shared arg fragments + output helper
// ---------------------------------------------------------------------------

/**
 * The stats.fm identity argument for the `statsfm_user` spelling (#927).
 *
 * This module used to keep a private copy of the schema that
 * `taste_composites.ts` also declares; both are now the same optional field
 * with the same `STATSFM_USER_ID` default, resolved by the same
 * `resolveStatsfmUserId` helper. See that function for why the guard is
 * required rather than merely tidy.
 */
const statsfmUserSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    'stats.fm user ID (or username) — public profile, no auth. Defaults to STATSFM_USER_ID.',
  );

/**
 * `range` is the shared stats.fm ranking window (#720) — the same upstream
 * parameter the endpoint tools in `statsfm.ts` send, so it must carry the same
 * values. This module used to keep a private copy that offered `week`/`month`,
 * which stats.fm rejects with `400 invalid range`.
 */
const rangeSchema = statsfmRangeSchema;

interface ToolOut {
  [k: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
}

function textOut(lines: string[], structured?: Record<string, unknown>): ToolOut {
  const out: ToolOut = { content: [{ type: 'text', text: lines.join('\n') }] };
  if (structured) out.structuredContent = structured;
  return out;
}

// ---------------------------------------------------------------------------
// Dual registration: canonical statsfm_* names + backwards-compat taste_* aliases
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerStatsfmTasteTools(server: McpServer, _client: SpotifyClient): void {
  void _client; // stats.fm public API needs no Spotify client; kept for index.ts uniformity

  // Register the canonical statsfm_* name plus the legacy taste_* alias.
  // Both point at the same handler; gating stays at the 'taste' module key.
  const dualRegister = (
    canonical: string,
    alias: string,
    desc: string,
    params: Record<string, z.ZodTypeAny>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (args: any) => Promise<any>,
  ): void => {
    const s = server as unknown as {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tool(name: string, desc: string, params: any, handler: any): void;
    };
    s.tool(canonical, desc, params, handler);
    s.tool(alias, `${desc} (Legacy alias of ${canonical} — prefer the canonical name.)`, params, handler);
  };

  // ---- taste_profile ----
  dualRegister(
    'statsfm_taste_profile',
    'taste_profile',
    'Taste snapshot from stats.fm: core artists, top genres, loyalty-vs-novelty balance, and day-parting (when you listen). Read-only, no auth.',
    {
      statsfm_user: statsfmUserSchema,
      range: rangeSchema,
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const u = resolveStatsfmUserId(args.statsfm_user, 'statsfm_user');
      const range = args.range ?? 'lifetime';
      const [artistsRaw, genresRaw, tracksRaw, streamsRaw] = await Promise.all([
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/top/artists`, {
          range,
          limit: '20',
        }),
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/top/genres`, {
          range,
          limit: '20',
        }),
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/top/tracks`, {
          range,
          limit: '20',
        }),
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/streams`, { limit: '100' }),
      ]);
      if (args.response_format === 'json') {
        const raw = {
          topArtists: artistsRaw,
          topGenres: genresRaw,
          topTracks: tracksRaw,
          recentStreams: streamsRaw,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(raw) }],
          structuredContent: { ...raw },
        };
      }
      const artists = normalizeTopList(artistsRaw);
      const genres = normalizeTopList(genresRaw);
      const tracks = normalizeTopList(tracksRaw);
      const streams = normalizeStreams(streamsRaw);
      const cap = resolveMaxResults(args.max_results);

      if (artists.length === 0 && genres.length === 0 && tracks.length === 0) {
        return textOut([
          `No taste data for "${u}" (range ${range}) — check the stats.fm user ID.`,
        ]);
      }

      const totalArtistStreams = artists.reduce((s, a) => s + a.count, 0);
      const top5 = artists.slice(0, 5).reduce((s, a) => s + a.count, 0);
      const loyalty = totalArtistStreams > 0 ? top5 / totalArtistStreams : 0;
      const lifetimeTop20 = new Set(artists.slice(0, 20).map((a) => a.name.toLowerCase()));
      const recentNovel = streams.filter(
        (s) => !s.artistNames.some((a) => lifetimeTop20.has(a.toLowerCase())),
      );
      const novelty =
        streams.length > 0 ? recentNovel.length / streams.length : 0;
      const parts = summarizeDayParting(streams);
      const peak = (Object.entries(parts) as Array<[DayPart, number]>).sort(
        (a, b) => b[1] - a[1],
      )[0];

      const detailed = args.response_format === 'detailed';
      const lines = [
        `Taste profile for ${u} (range ${range}, loyalty ${(loyalty * 100).toFixed(0)}% top-5 / novelty ${(novelty * 100).toFixed(0)}% recent-outside-core):`,
        `Core artists: ${artists
          .slice(0, Math.min(10, cap))
          .map((a) => `${a.name} (${a.count})`)
          .join(' · ') || 'n/a'}`,
        `Top genres: ${genres
          .slice(0, Math.min(8, cap))
          .map((g) => `${g.name} (${g.count})`)
          .join(' · ') || 'n/a'}`,
        `Day-parting (UTC, last ${streams.length} streams): night ${parts.night} / morning ${parts.morning} / afternoon ${parts.afternoon} / evening ${parts.evening} — peak: ${peak[0]}.`,
      ];
      if (detailed && tracks.length > 0) {
        lines.push(
          `Top tracks: ${tracks
            .slice(0, Math.min(10, cap))
            .map((t) => `${t.name} (${t.count})`)
            .join(' · ')}`,
        );
      }
      return textOut(lines, {
        user: u,
        range,
        coreArtists: artists.slice(0, 10),
        topGenres: genres.slice(0, 8),
        loyaltyVsNovelty: {
          loyaltyShareTop5: Math.round(loyalty * 1000) / 1000,
          recentNoveltyShare: Math.round(novelty * 1000) / 1000,
          recentStreamsSampled: streams.length,
        },
        dayParting: { ...parts, peak: peak[0] },
        ...(detailed ? { topTracks: tracks.slice(0, 10) } : {}),
      });
    },
  );

  // ---- artist_affinity ----
  dualRegister(
    'statsfm_artist_affinity',
    'artist_affinity',
    'How deep does an artist run? Lifetime intensity (share of top-artist streams) plus a recency half-life fitted to recent stream ages. Read-only, no auth.',
    {
      statsfm_user: statsfmUserSchema,
      artist: z.string().min(1).describe('Artist name (substring match) or stats.fm artist ID'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const u = resolveStatsfmUserId(args.statsfm_user, 'statsfm_user');
      const q = args.artist.toLowerCase();
      const [artistsRaw, streamsRaw] = await Promise.all([
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/top/artists`, {
          range: 'lifetime',
          limit: '50',
        }),
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/streams`, { limit: '500' }),
      ]);
      const artists = normalizeTopList(artistsRaw);
      const streams = normalizeStreams(streamsRaw);
      const row = artists.find(
        (a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase() === q,
      );
      const mine = streams.filter((s) =>
        s.artistNames.some((a) => a.toLowerCase().includes(q)),
      );
      const total = artists.reduce((s, a) => s + a.count, 0);
      const intensity = row && total > 0 ? row.count / total : 0;
      const halfLife = estimateHalfLifeDays(mine);
      const tier = classifyExposure(row?.count ?? 0);
      if (!row && mine.length === 0) {
        return textOut(
          [`No affinity for "${args.artist}" — unheard in ${u}'s stats.fm history.`],
          { user: u, artist: args.artist, tier: 'unheard', intensity: 0 },
        );
      }
      const lastPlayed =
        mine.length > 0 ? new Date(mine[mine.length - 1].playedAtMs).toISOString() : null;
      const lines = [
        `Affinity for ${row?.name ?? args.artist} (${u}): ${tier}, intensity ${(intensity * 100).toFixed(1)}% of top-artist streams (${row?.count ?? 0} lifetime).`,
        `Recent: ${mine.length} streams in sample${halfLife !== null ? `, recency half-life ${halfLife}d` : ''}${lastPlayed ? `, last played ${lastPlayed}` : ''}.`,
      ];
      if (args.response_format === 'json') {
        const raw = { topArtists: artistsRaw, recentStreams: streamsRaw };
        return {
          content: [{ type: 'text', text: JSON.stringify(raw) }],
          structuredContent: { ...raw },
        };
      }
      return textOut(lines, {
        user: u,
        artist: row?.name ?? args.artist,
        tier,
        intensity: Math.round(intensity * 1000) / 1000,
        lifetimeStreams: row?.count ?? 0,
        recentStreams: mine.length,
        halfLifeDays: halfLife,
        lastPlayed,
      });
    },
  );

  // ---- exposure_check ----
  dualRegister(
    'statsfm_exposure_check',
    'exposure_check',
    'Where does a subject sit on the exposure ladder — unheard / sampled / explored / established / favorite? Evidence cites lifetime + recent counts. Read-only, no auth.',
    {
      statsfm_user: statsfmUserSchema,
      subject: z.string().min(1).describe('Artist, track, album, or genre name to check'),
      subject_type: z
        .enum(['artist', 'track', 'album', 'genre'])
        .optional()
        .describe('Which top-list to check against. Default: artist'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const u = resolveStatsfmUserId(args.statsfm_user, 'statsfm_user');
      const kind = args.subject_type ?? 'artist';
      const q = args.subject.toLowerCase();
      const listPath =
        kind === 'track'
          ? 'tracks'
          : kind === 'album'
            ? 'albums'
            : kind === 'genre'
              ? 'genres'
              : 'artists';
      const [listRaw, streamsRaw] = await Promise.all([
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/top/${listPath}`, {
          range: 'lifetime',
          limit: '100',
        }),
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/streams`, { limit: '500' }),
      ]);
      const rows = normalizeTopList(listRaw);
      const streams = normalizeStreams(streamsRaw);
      const row = rows.find(
        (r) => r.name.toLowerCase().includes(q) || r.id.toLowerCase() === q,
      );
      const recentHits = streams.filter(
        (s) =>
          s.trackName.toLowerCase().includes(q) ||
          s.artistNames.some((a) => a.toLowerCase().includes(q)),
      ).length;
      const tier = classifyExposure(row?.count ?? 0);
      const lines = [
        `Exposure for "${args.subject}" (${kind}, ${u}): ${tier} — ${row?.count ?? 0} lifetime streams, ${recentHits} in the recent sample.`,
      ];
      if (args.response_format === 'json') {
        const raw = { topList: listRaw, recentStreams: streamsRaw };
        return {
          content: [{ type: 'text', text: JSON.stringify(raw) }],
          structuredContent: { ...raw },
        };
      }
      return textOut(lines, {
        user: u,
        subject: args.subject,
        subject_type: kind,
        tier,
        lifetimeStreams: row?.count ?? 0,
        recentStreams: recentHits,
      });
    },
  );

  // ---- listening_eras ----
  dualRegister(
    'statsfm_listening_eras',
    'listening_eras',
    'Change points in monthly listening: groups months into eras split on top-artist turnover or >60% volume shifts. Read-only, no auth.',
    {
      statsfm_user: statsfmUserSchema,
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const u = resolveStatsfmUserId(args.statsfm_user, 'statsfm_user');
      const streamsRaw = await statsfmGet<unknown>(
        `/users/${encodeURIComponent(u)}/streams`,
        { limit: '500' },
      );
      if (args.response_format === 'json') {
        const raw = { streams: streamsRaw };
        return {
          content: [{ type: 'text', text: JSON.stringify(raw) }],
          structuredContent: { ...raw },
        };
      }
      const streams = normalizeStreams(streamsRaw);
      const months = summarizeMonths(streams);
      if (months.length === 0) {
        return textOut([`No dated streams for "${u}" — cannot build eras.`]);
      }
      const eras = detectEras(months);
      const shaped = truncateItems(eras, resolveMaxResults(args.max_results));
      const lines = [`Listening eras for ${u} (${months.length} months, ${eras.length} eras):`];
      shaped.items.forEach((e, i) => {
        lines.push(
          `  ${i + 1}. ${e.startMonth} → ${e.endMonth} (${e.months}mo): ${e.signatureArtist}, ~${e.avgStreamsPerMonth}/mo [${e.boundaryReason}]`,
        );
      });
      if (shaped.footer) lines.push(`(${shaped.footer})`);
      const pagination = paginationInfo({
        total: eras.length,
        offset: 0,
        limit: null,
        returned: eras.length,
      });
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: listStructuredContent(shaped.items, pagination, {
          months,
          truncated: shaped.truncated,
          remaining: shaped.remaining,
        }),
      };
    },
  );

  // ---- listening_sessions ----
  dualRegister(
    'statsfm_listening_sessions',
    'listening_sessions',
    'Group recent streams into sessions: a gap longer than gap_minutes starts a new session (default 30). Read-only, no auth.',
    {
      statsfm_user: statsfmUserSchema,
      gap_minutes: z
        .number()
        .int()
        .min(5)
        .max(240)
        .optional()
        .describe('Inactivity gap that splits sessions. Default: 30'),
      limit: z.number().int().min(1).max(500).optional().describe('Streams to fetch. Default: 100'),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const u = resolveStatsfmUserId(args.statsfm_user, 'statsfm_user');
      const gap = args.gap_minutes ?? 30;
      const streamsRaw = await statsfmGet<unknown>(
        `/users/${encodeURIComponent(u)}/streams`,
        { limit: String(args.limit ?? 100) },
      );
      if (args.response_format === 'json') {
        const raw = { streams: streamsRaw };
        return {
          content: [{ type: 'text', text: JSON.stringify(raw) }],
          structuredContent: { ...raw },
        };
      }
      const streams = normalizeStreams(streamsRaw);
      if (streams.length === 0) {
        return textOut([`No dated streams for "${u}" — no sessions to group.`]);
      }
      const sessions = groupSessions(streams, gap);
      const shaped = truncateItems(sessions, resolveMaxResults(args.max_results));
      const avgLen =
        sessions.reduce((s, x) => s + x.streams, 0) / Math.max(1, sessions.length);
      const longest = sessions.reduce((m, x) => Math.max(m, x.streams), 0);
      const fmt = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
      const lines = [
        `Listening sessions for ${u}: ${sessions.length} sessions from ${streams.length} streams (gap ${gap}m, avg ${avgLen.toFixed(1)} tracks, longest ${longest}).`,
      ];
      shaped.items.forEach((s, i) => {
        lines.push(
          `  ${i + 1}. ${fmt(s.startMs)} → ${fmt(s.endMs)} UTC: ${s.streams} tracks — ${s.tracks.slice(0, 5).join(' · ')}${s.tracks.length > 5 ? ` (+${s.tracks.length - 5} more)` : ''}`,
        );
      });
      if (shaped.footer) lines.push(`(${shaped.footer})`);
      const pagination = paginationInfo({
        total: sessions.length,
        offset: 0,
        limit: null,
        returned: sessions.length,
      });
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: listStructuredContent(shaped.items, pagination, {
          gapMinutes: gap,
          sessionCount: sessions.length,
          truncated: shaped.truncated,
          remaining: shaped.remaining,
        }),
      };
    },
  );

  // ---- forgotten_favorites ----
  dualRegister(
    'statsfm_forgotten_favorites',
    'forgotten_favorites',
    'High-lifetime tracks with zero recent plays — favorites that fell off. Ranked by lifetime streams. Read-only, no auth.',
    {
      statsfm_user: statsfmUserSchema,
      top_limit: z
        .number()
        .int()
        .min(5)
        .max(100)
        .optional()
        .describe('Lifetime top tracks to scan. Default: 50'),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const u = resolveStatsfmUserId(args.statsfm_user, 'statsfm_user');
      const [topRaw, streamsRaw] = await Promise.all([
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/top/tracks`, {
          range: 'lifetime',
          limit: String(args.top_limit ?? 50),
        }),
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/streams`, { limit: '500' }),
      ]);
      if (args.response_format === 'json') {
        const raw = { topTracks: topRaw, recentStreams: streamsRaw };
        return {
          content: [{ type: 'text', text: JSON.stringify(raw) }],
          structuredContent: { ...raw },
        };
      }
      const top = normalizeTopList(topRaw);
      const streams = normalizeStreams(streamsRaw);
      const recentIds = new Set(streams.map((s) => s.trackId.toLowerCase()));
      const recentNames = new Set(streams.map((s) => s.trackName.toLowerCase()));
      const forgotten = top.filter(
        (t) =>
          !recentIds.has(t.id.toLowerCase()) && !recentNames.has(t.name.toLowerCase()),
      );
      const shaped = truncateItems(forgotten, resolveMaxResults(args.max_results));
      const lines = [
        forgotten.length === 0
          ? `No forgotten favorites for ${u} — every lifetime top-${top.length} track appears in the recent sample.`
          : `Forgotten favorites for ${u}: ${forgotten.length} of lifetime top-${top.length} absent from the last ${streams.length} streams.`,
      ];
      shaped.items.forEach((t, i) => {
        lines.push(`  ${i + 1}. ${t.name} (${t.count} lifetime streams)`);
      });
      if (shaped.footer) lines.push(`(${shaped.footer})`);
      if (shaped.items.length > 0) {
        lines.push(`Revival pick: replay "${shaped.items[0].name}".`);
      }
      const pagination = paginationInfo({
        total: forgotten.length,
        offset: 0,
        limit: null,
        returned: forgotten.length,
      });
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: listStructuredContent(shaped.items, pagination, {
          scannedTop: top.length,
          recentSampled: streams.length,
          truncated: shaped.truncated,
          remaining: shaped.remaining,
        }),
      };
    },
  );

  // ---- taste_recommendations ----
  dualRegister(
    'statsfm_taste_recommendations',
    'taste_recommendations',
    'Bridge-mode recommendations: adjacent genres/artists between the listener\u2019s core and the unexplored, each with evidence and a risk note. Heuristic over stats.fm tops — read-only, no auth.',
    {
      statsfm_user: statsfmUserSchema,
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const u = resolveStatsfmUserId(args.statsfm_user, 'statsfm_user');
      const [artistsRaw, genresRaw, streamsRaw] = await Promise.all([
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/top/artists`, {
          range: 'lifetime',
          limit: '30',
        }),
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/top/genres`, {
          range: 'lifetime',
          limit: '15',
        }),
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/streams`, { limit: '200' }),
      ]);
      if (args.response_format === 'json') {
        const raw = { topArtists: artistsRaw, topGenres: genresRaw, recentStreams: streamsRaw };
        return {
          content: [{ type: 'text', text: JSON.stringify(raw) }],
          structuredContent: { ...raw },
        };
      }
      const artists = normalizeTopList(artistsRaw);
      const genres = normalizeTopList(genresRaw);
      const streams = normalizeStreams(streamsRaw);
      if (artists.length === 0 || genres.length === 0) {
        return textOut([
          `Not enough taste data for "${u}" to build bridges — need top artists and genres.`,
        ]);
      }
      const coreGenres = genres.slice(0, 3).map((g) => g.name);
      const recentArtistNames = new Set(
        streams.flatMap((s) => s.artistNames.map((a) => a.toLowerCase())),
      );
      interface Bridge {
        direction: string;
        evidence: string;
        risk: string;
      }
      const bridges: Bridge[] = [];
      for (const g of genres.slice(3, 10)) {
        bridges.push({
          direction: `Bridge from ${coreGenres.join(' / ')} toward ${g.name}`,
          evidence: `${g.name} ranks #${genres.indexOf(g) + 1} lifetime with ${g.count} streams — adjacent but underexplored vs core ${coreGenres[0]}.`,
          risk: `Only ${g.count} lifetime streams: start with one playlist, skip if the first 3 tracks bounce.`,
        });
      }
      for (const a of artists.slice(10, 20)) {
        if (recentArtistNames.has(a.name.toLowerCase())) continue;
        bridges.push({
          direction: `Revisit ${a.name} (lifetime #${artists.indexOf(a) + 1})`,
          evidence: `${a.count} lifetime streams but absent from the last ${streams.length} — dormant affinity, not a cold start.`,
          risk: `Taste may have moved on: treat as a re-test, not a lock.`,
        });
        if (bridges.length >= 10) break;
      }
      const shaped = truncateItems(bridges, resolveMaxResults(args.max_results));
      const lines = [`Bridge-mode recommendations for ${u} (core: ${coreGenres.join(' / ')}):`];
      shaped.items.forEach((b, i) => {
        lines.push(`  ${i + 1}. ${b.direction}`);
        lines.push(`      Evidence: ${b.evidence}`);
        lines.push(`      Risk: ${b.risk}`);
      });
      if (shaped.footer) lines.push(`(${shaped.footer})`);
      const pagination = paginationInfo({
        total: bridges.length,
        offset: 0,
        limit: null,
        returned: bridges.length,
      });
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: listStructuredContent(shaped.items, pagination, {
          coreGenres,
          truncated: shaped.truncated,
          remaining: shaped.remaining,
        }),
      };
    },
  );

  // ---- record_feedback ----
  dualRegister(
    'statsfm_record_feedback',
    'record_feedback',
    'Record a local-only taste verdict (love/like/mixed/boring/dislike) or list stored verdicts. Never touches the network. Verdicts persist in ~/.spotify-mcp/taste-feedback.json (SPOTIFY_MCP_DATA_DIR overrides) as a capped sidecar: the newest 500 survive, older ones are evicted and counted.',
    {
      action: z
        .enum(['record', 'list'])
        .optional()
        .describe('record (default) stores a verdict; list returns stored verdicts'),
      subject_type: z
        .enum(['track', 'artist', 'album', 'genre'])
        .optional()
        .describe('Required for record'),
      subject: z
        .string()
        .min(1)
        .max(MAX_FEEDBACK_SUBJECT_LENGTH)
        .optional()
        .describe(`Track/artist/album/genre name, max ${MAX_FEEDBACK_SUBJECT_LENGTH} chars. Required for record`),
      rating: z
        .enum(['love', 'like', 'mixed', 'boring', 'dislike'])
        .optional()
        .describe('Required for record'),
      note: z
        .string()
        .max(MAX_FEEDBACK_NOTE_LENGTH)
        .optional()
        .describe(`Optional free-text note, max ${MAX_FEEDBACK_NOTE_LENGTH} chars`),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_FEEDBACK_LIST_LIMIT)
        .optional()
        .describe(
          `For action=list: newest verdicts to return (default ${DEFAULT_FEEDBACK_LIST_LIMIT}, max ${MAX_FEEDBACK_LIST_LIMIT}). The store holds at most ${DEFAULT_FEEDBACK_MAX_ENTRIES}; older ones are evicted.`,
        ),
      response_format: ResponseFormat,
    },
    async (args) => {
      const action = args.action ?? 'record';
      if (action === 'list') {
        const limit = Math.min(MAX_FEEDBACK_LIST_LIMIT, Math.max(1, args.limit ?? DEFAULT_FEEDBACK_LIST_LIMIT));
        let store: FeedbackStore;
        try {
          store = await loadFeedbackStore();
        } catch (err) {
          // Returned rather than thrown: the tool boundary turns a throw into a
          // generic "invalid arguments" envelope, which would name the wrong
          // cause and drop the path the user has to repair.
          return storeUnreadable((err as Error).message);
        }
        // Newest `limit`, still in chronological order within the page.
        const page = store.entries.slice(Math.max(0, store.entries.length - limit));
        const truncated = page.length < store.entries.length;
        const lines =
          page.length === 0
            ? [
                store.recorded === 0
                  ? 'No feedback recorded yet — use action=record to store a verdict.'
                  : `No feedback retained: all ${store.recorded} recorded verdict(s) were evicted by the store cap.`,
              ]
            : [
                `${page.length} of ${store.entries.length} retained feedback entr${
                  store.entries.length === 1 ? 'y' : 'ies'
                } (newest first page; ${store.recorded} recorded, ${store.evicted} evicted by the cap):`,
                ...page.map(
                  (e) =>
                    `  #${e.id} [${e.rating}] ${e.subject_type}:${e.subject}${e.note ? ` — ${e.note}` : ''} (${e.at})`,
                ),
                ...(truncated
                  ? [`  … ${store.entries.length - page.length} older entr(y/ies) retained; raise limit to see them.`]
                  : []),
              ];
        const echo = {
          ok: true,
          entries: page,
          returned: page.length,
          retained: store.entries.length,
          truncated,
          recorded: store.recorded,
          evicted: store.evicted,
          max_entries: feedbackMaxEntries(),
        };
        if (args.response_format === 'json') {
          return {
            content: [{ type: 'text', text: JSON.stringify(echo, null, 2) }],
            structuredContent: echo,
          };
        }
        return textOut(lines, echo);
      }
      if (!args.subject_type || !args.subject || !args.rating) {
        throw new Error(
          'record_feedback with action=record requires subject_type, subject, and rating',
        );
      }
      const path = tasteFeedbackFile();
      let recorded: { entry: FeedbackEntry; store: FeedbackStore; evictedNow: number };
      try {
        recorded = await recordFeedbackEntry({
          subject_type: args.subject_type,
          subject: args.subject,
          rating: args.rating,
          note: args.note,
        });
      } catch (err) {
        // A verdict that reports success but is not on disk is the #764
        // watchlist failure. A corrupt store surfaces its own preserved-copy
        // path through the same route rather than being reset.
        const preserved = (err as { preservedAs?: string | null }).preservedAs;
        return preserved
          ? storeUnreadable((err as Error).message)
          : storeUnwritable(path, err);
      }
      const { entry, store, evictedNow } = recorded;
      const counts = feedbackRatingCounts(store);
      const lines = [
        `Recorded #${entry.id}: [${entry.rating}] ${entry.subject_type}:${entry.subject}${entry.note ? ` — ${entry.note}` : ''} (local-only, ${store.entries.length} retained, ${store.recorded} recorded).`,
        ...(evictedNow > 0
          ? [`  Cap reached: ${evictedNow} oldest verdict(s) dropped (${store.entries.length}/${feedbackMaxEntries()} retained).`]
          : []),
      ];
      return textOut(lines, { ok: true, entry, counts, retained: store.entries.length, recorded: store.recorded, evicted: store.evicted });
    },
  );
}
