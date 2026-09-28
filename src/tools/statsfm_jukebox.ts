/**
 * `statsfm_jukebox` — propose replacements and appends for a playlist from a
 * stats.fm user's recent rotation, and (on an explicit commit) apply them
 * (#726).
 *
 * ## Why this is server-side
 *
 * The workflow lives in a client-side cron today, so every host carries its own
 * MCP-aware agent loop and each one re-implements the same policy — which rows
 * count as stale, how many get replaced — and the results are not comparable
 * across hosts. The evidence (stats.fm streams) and the mutation (Spotify
 * playlist items) are both things this server already reaches, so the policy
 * belongs here too.
 *
 * ## What it reads
 *
 *  - `GET /users/{id}/streams` through the one shared client in
 *    `src/lib/statsfm-client.ts` (via `statsfmGet`), which owns the base URL,
 *    the request timeout, the `Retry-After` handling and the cache. A fourth
 *    fetch shim here would be a fourth set of all four.
 *  - `GET /playlists/{id}` plus a walked `GET /playlists/{id}/items` through the
 *    shared `getAllPages`, so the rows carry the positions the removal half
 *    needs.
 *
 * ## What it does not claim
 *
 * stats.fm returns a bounded recent page, not the account's whole history — and
 * its bounds are honoured on this route but the page is still finite. So "not
 * played in the last N days" is a claim about the rows THIS PAGE carried, and
 * the response says which rows those were: `streams.page_oldest`,
 * `streams.page_newest` and `streams.page_may_not_cover_window`. When the page
 * cannot reach back to the window start, the prose says so in the same breath as
 * the proposals. A caller who reads "stale" as "provably not played" and acts on
 * it is the exact failure this disclosure exists to prevent.
 *
 * ## A value that could not be read is never a value
 *
 * Three counts are reported rather than absorbed (#803/#804):
 *
 *  - a stream row with no readable play time cannot be placed inside or outside
 *    the window, so it is neither evidence of rotation nor evidence of
 *    staleness. Counted in `streams.unreadable_timestamps`, excluded from both.
 *  - a stream row whose track id is not a usable Spotify track id cannot become
 *    a `spotify:track:` URI. Counted in `streams.unresolved_track_ids` and never
 *    rendered as a URI — the alternative, borrowing the track NAME into the id
 *    field the way `normalizeStreams` does, would put a name in a URI and then
 *    send it to Spotify as though it had been read. It still counts toward the
 *    rotation, because a listen is a listen whatever the track is addressed by.
 *  - a playlist row whose URI cannot be read cannot be removed by position.
 *    Counted in `playlist_rows_unreadable` and left alone.
 *
 * A proposal is never padded. If the window yields three candidates and five
 * were asked for, three are proposed and the shortfall is named — a silently
 * truncated list reads as "this is the whole answer".
 *
 * ## The write half
 *
 * `dry_run` defaults to TRUE (`DryRunDefault`), so an omitted flag is a plan.
 * The commit path removes the stale rows by position and appends the picks, and
 * it asks through elicitation UNCONDITIONALLY — no threshold. The removal half
 * deletes rows, and "fewer than ten rows" is not a defence for deleting rows.
 * The four threshold-gated families in this repo exist because most bulk writes
 * ARE threshold-shaped; this one is not.
 * `requiredConfirmationRefusal()` fails closed when the client cannot prompt, so
 * an unanswerable prompt is a refusal and never an unprompted write.
 *
 * Two receipts are issued, not one: the removals and the adds are separate
 * mutations with separate inverses, and a single receipt could only describe one
 * of them. `undo_mutation` walks receipts newest-first, so reversing this
 * composite takes two calls in that order — the response names them.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SpotifyApiError, type SpotifyClient } from '../client.js';
import {
  ResponseFormat,
  normalizePlaylistReference,
  DryRunDefault,
  isDryRun,
  resolveStatsfmUserInput,
  StatsfmUserInputFields,
} from '../shaping.js';
import { textResult } from '../result.js';
import { issueReceipt, formatReceipt, type Receipt } from '../receipts.js';
import { capFor } from '../chunk.js';
import { statsfmGet } from './taste_composites.js';
import { readOnlyModeEnabled } from './annotations.js';
import { confirmViaElicitation, describeConfirmation, requiredConfirmationRefusal } from './confirm.js';
import { playlistItemTotal } from '../types/spotify.js';
// A separate `import type` statement on purpose: the shared types file owns
// these shapes, and a multi-line specifier list starting with `type Foo,` reads
// to `tests/types.ownership.test.ts` as a local declaration shadowing it.
import type { SpotifyPlaylistPage, PlaylistItemObject } from '../types/spotify.js';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * How many rows each half may propose.
 *
 * Bounded, and the ceiling is stated in the message: every one of these rows is
 * a position-indexed removal or an added URI, and both are shown to a human in
 * a confirmation prompt. A ceiling that exists only to stop a caller asking for
 * ten thousand is a ceiling nobody can read.
 */
const ProposalCount = (what: string) =>
  z
    .number()
    .int()
    .min(0)
    .max(50)
    .default(5)
    .describe(`How many ${what} to propose (0–50). Default 5`);

const WindowDays = z
  .number()
  .int()
  .min(1)
  .max(365)
  .default(90)
  .describe(
    'Rotation window in days, counted back from now. Applies to the bounded recent page stats.fm '
      + 'returns, not to the account whole history. Default 90',
  );

// ---------------------------------------------------------------------------
// stats.fm row reading
// ---------------------------------------------------------------------------

/** A stats.fm stream row reduced to the facts the policy needs. */
interface StreamRow {
  /** 22-char base62 Spotify track id, or null when the row carries none. */
  trackId: string | null;
  trackName: string;
  artistKey: string;
  artistName: string;
  /** Play time in epoch ms. Never null here: unreadable rows never become StreamRows. */
  playedAtMs: number;
}

interface RawRow {
  [k: string]: unknown;
}

function asItems(payload: unknown): RawRow[] {
  if (Array.isArray(payload)) return payload as RawRow[];
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.items)) return obj.items as RawRow[];
    if (Array.isArray(obj.data)) return obj.data as RawRow[];
  }
  return [];
}

/**
 * Play time in epoch ms, or null when it cannot be read.
 *
 * The same two spellings `statsfm.ts` accepts (an ISO string, or a number below
 * 1e12 meaning seconds) for the same reason: a window is a FILTER, and a row
 * whose time cannot be read cannot be placed in or out of it. Returning null
 * lets the caller count it; returning 0 would file it under 1970 and call it
 * stale.
 */
function playedAtOf(row: RawRow): number | null {
  const track = (row.track as RawRow | undefined) ?? row;
  for (const source of [row, track]) {
    for (const key of ['endTime', 'playedAt', 'played_at', 'timestamp']) {
      const value = source[key];
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return value < 1e12 ? value * 1000 : value;
      }
      if (typeof value === 'string') {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
      }
    }
  }
  return null;
}

const SPOTIFY_TRACK_ID = /^[0-9A-Za-z]{22}$/;

/**
 * The row's Spotify track id, or null.
 *
 * `normalizeStreams` in `statsfm_taste.ts` falls back to the track NAME when no
 * id is present, which is right for a report that only prints text and wrong
 * here, because this module's output is a `spotify:track:` URI. Borrowing a name
 * into the id field would produce `spotify:track:Hit Single`, and that string
 * would then go to Spotify as though it had been read. So the id has to look
 * like one, and a row without one is counted rather than coerced.
 */
function trackIdOf(row: RawRow): string | null {
  const track = (row.track as RawRow | undefined) ?? row;
  for (const candidate of [track.id, row.trackId, row.id]) {
    if (typeof candidate === 'string' && SPOTIFY_TRACK_ID.test(candidate)) return candidate;
  }
  return null;
}

function trackNameOf(row: RawRow): string {
  const track = (row.track as RawRow | undefined) ?? row;
  for (const candidate of [track.name, row.trackName, row.name]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return 'unknown track';
}

/** Artist key + display name, preferring the stable id over the mutable name. */
function artistOf(row: RawRow): { key: string; name: string } {
  const track = (row.track as RawRow | undefined) ?? row;
  const list = track.artists;
  const first = Array.isArray(list) ? (list as RawRow[])[0] : undefined;
  const name =
    typeof first?.name === 'string' && first.name.length > 0
      ? first.name
      : typeof row.artistName === 'string' && row.artistName.length > 0
        ? row.artistName
        : 'unknown artist';
  const id = first?.id;
  return {
    key: typeof id === 'string' && id.length > 0 ? `id:${id}` : `name:${name.toLowerCase()}`,
    name,
  };
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** One playlist row this tool proposes to remove, with the evidence for calling it stale. */
interface ReplacementProposal {
  position: number;
  uri: string;
  name: string;
  /** ISO day of the last play the sampled page carried, or null when it carried none. */
  last_played_at: string | null;
  rationale: string;
}

/** One track this tool proposes to add. */
interface AppendProposal {
  uri: string;
  name: string;
  artist: string;
  /** The artist's rank in the window's rotation; 1 = most streamed. */
  rotation_rank: number;
  streams_in_window: number;
  rationale: string;
}

interface Plan {
  playlistId: string;
  playlistName: string | null;
  /** The playlist object's own count, or null when it stated none. */
  playlistTotal: number | null;
  rowsRead: number;
  rowsUnreadable: number;
  /** True when the items walk stopped before the playlist's own total. */
  walkTruncated: boolean;
  /** Why it stopped, or null when it saw the whole list. */
  walkTruncatedReason: string | null;
  replacements: ReplacementProposal[];
  appends: AppendProposal[];
  rotation: Array<{ artist: string; streams: number }>;
  rotationArtistCount: number;
  /** What the caller ASKED for, which is not the same as what the evidence supports. */
  replacementsRequested: number;
  appendsRequested: number;
  windowDays: number;
  windowAfter: string;
  streamsReturned: number;
  streamsInWindow: number;
  streamsUnreadableTime: number;
  streamsUnresolvedId: number;
  pageOldest: string | null;
  pageNewest: string | null;
  pageMayNotCover: boolean;
  candidatesAvailable: number;
  staleAvailable: number;
}

/**
 * A short, bounded reason for a failed read. HTTP status and Spotify's own
 * reason code only — never `err.message`, which an upstream error body can fill
 * with private ids (the same redaction rule `taste_playlist.ts` follows).
 */
function readFailureMessage(err: unknown): string {
  if (err instanceof SpotifyApiError) {
    return `HTTP ${err.status}${err.reason ? ` (${err.reason})` : ''}`;
  }
  return err instanceof Error ? err.name : 'unknown error';
}

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * Read both sides and produce the proposal. Issues GETs only, so the same
 * function serves the dry run and the commit's pre-confirmation state.
 */
async function buildPlan(
  client: SpotifyClient,
  userId: string,
  playlistRef: string,
  replacements: number,
  appends: number,
  windowDays: number,
  now: number,
): Promise<Plan> {
  const playlistId = normalizePlaylistReference(playlistRef);
  const encId = encodeURIComponent(playlistId);

  // ---- the playlist ----
  const meta = await client.get<SpotifyPlaylistPage>(`/playlists/${encId}`);
  if (!meta) {
    throw new Error(`playlist ${playlistId} was not found: GET /playlists/{id} returned nothing`);
  }
  const walk = await client.getAllPagesWithTruncation<PlaylistItemObject>(
    `/playlists/${encId}/items`,
    { limit: '100' },
  );

  const playlistUris = new Set<string>();
  const playlistRows: Array<{ position: number; uri: string; name: string }> = [];
  let rowsUnreadable = 0;
  for (let position = 0; position < walk.items.length; position += 1) {
    const item = walk.items[position]?.item ?? null;
    const uri = item && typeof item.uri === 'string' && item.uri.length > 0 ? item.uri : null;
    if (!uri) {
      // A row with no readable URI cannot be matched against the streams and
      // cannot be removed by position. Counted, never skipped silently.
      rowsUnreadable += 1;
      continue;
    }
    playlistUris.add(uri);
    playlistRows.push({
      position,
      uri,
      name: item && typeof item.name === 'string' && item.name.length > 0 ? item.name : uri,
    });
  }

  // ---- the stats.fm side ----
  const windowAfterMs = now - windowDays * 86_400_000;
  const payloadRaw = await statsfmGet<unknown>(
    `/users/${encodeURIComponent(userId)}/streams`,
    { limit: '500', after: String(windowAfterMs) },
  );
  const raw = asItems(payloadRaw);

  // Every row the page carried with a READABLE play time, in-window or not.
  //
  // The out-of-window rows are kept rather than dropped at the filter, because
  // they are the two things a caller would otherwise be told nothing about: the
  // evidence that the page reaches back to the window start at all, and the
  // date a stale row was last played. Filtering first would leave both blank
  // precisely when the page had the answers.
  const readable: StreamRow[] = [];
  let streamsUnreadableTime = 0;
  for (const row of raw) {
    const playedAtMs = playedAtOf(row);
    if (playedAtMs === null) {
      // Cannot be placed in or out of the window: evidence for neither claim.
      streamsUnreadableTime += 1;
      continue;
    }
    const artist = artistOf(row);
    readable.push({
      trackId: trackIdOf(row),
      trackName: trackNameOf(row),
      artistKey: artist.key,
      artistName: artist.name,
      playedAtMs,
    });
  }
  const inWindow = readable.filter((r) => r.playedAtMs >= windowAfterMs);
  let streamsUnresolvedId = 0;
  for (const row of inWindow) if (row.trackId === null) streamsUnresolvedId += 1;

  const pageTimes = readable.map((r) => r.playedAtMs).sort((a, b) => a - b);
  const pageOldest = pageTimes.length > 0 ? new Date(pageTimes[0]!).toISOString() : null;
  const pageNewest = pageTimes.length > 0 ? new Date(pageTimes[pageTimes.length - 1]!).toISOString() : null;
  const pageMayNotCover = pageTimes.length > 0 && pageTimes[0]! > windowAfterMs;

  // ---- rotation: artists by stream count inside the window ----
  const byArtist = new Map<string, { artist: string; streams: number }>();
  for (const row of inWindow) {
    const entry = byArtist.get(row.artistKey);
    if (entry) entry.streams += 1;
    else byArtist.set(row.artistKey, { artist: row.artistName, streams: 1 });
  }
  const rotationRanked = [...byArtist.entries()]
    .map(([key, v]) => ({ key, artist: v.artist, streams: v.streams }))
    .sort((a, b) => b.streams - a.streams || a.artist.localeCompare(b.artist));
  const rotationIndex = new Map(rotationRanked.map((r, i) => [r.key, i + 1]));

  // ---- staleness: playlist rows absent from the window ----
  // Two sets, deliberately different in scope. `playedInWindow` decides WHAT is
  // stale — only an in-window play clears a row. `newestSeen` dates the row —
  // the newest play the page carried for it, in or out of window — so a
  // proposal can say "last played in March" instead of the weaker "not in the
  // page", and a dated row can be ranked above one the page never mentioned.
  // One pass each, so the ordering below is a map read rather than a re-scan.
  const playedInWindow = new Set<string>();
  const newestSeen = new Map<string, number>();
  for (const row of inWindow) {
    if (row.trackId === null) continue;
    playedInWindow.add(`spotify:track:${row.trackId}`);
  }
  for (const row of readable) {
    if (row.trackId === null) continue;
    const uri = `spotify:track:${row.trackId}`;
    const seen = newestSeen.get(uri);
    if (seen === undefined || row.playedAtMs > seen) newestSeen.set(uri, row.playedAtMs);
  }

  const neverSeen: typeof playlistRows = [];
  const seenBefore: Array<{ row: (typeof playlistRows)[number]; at: number }> = [];
  for (const row of playlistRows) {
    if (playedInWindow.has(row.uri)) continue;
    const at = newestSeen.get(row.uri);
    if (at === undefined) neverSeen.push(row);
    else seenBefore.push({ row, at });
  }
  // Oldest last play first. A row the page never carried is ranked as oldest,
  // which is the strongest staleness claim the evidence supports — and the
  // disclosure below is what stops that being read as a claim about all time.
  neverSeen.sort((a, b) => a.position - b.position);
  seenBefore.sort((a, b) => a.at - b.at || a.row.position - b.row.position);
  const staleOrder = [
    ...neverSeen.map((row) => ({ row, at: null as number | null })),
    ...seenBefore.map((s) => ({ row: s.row, at: s.at as number | null })),
  ];

  const replacementProposals: ReplacementProposal[] = staleOrder.slice(0, replacements).map(({ row, at }) => ({
    position: row.position,
    uri: row.uri,
    name: row.name,
    last_played_at: at === null ? null : isoDay(at),
    rationale:
      at === null
        ? `absent from the stream page covering the last ${plural(windowDays, 'day', 'days')}`
        : `last played ${isoDay(at)} in the sampled page, outside the ${plural(windowDays, 'day', 'days')} window`,
  }));

  // ---- candidates: in-window tracks the playlist does not already hold ----
  const seenTrack = new Set<string>();
  const candidates: Array<{
    uri: string;
    name: string;
    artist: string;
    rank: number;
    streams: number;
    recent: number;
  }> = [];
  for (const row of inWindow) {
    if (row.trackId === null) continue;
    const uri = `spotify:track:${row.trackId}`;
    if (playlistUris.has(uri) || seenTrack.has(uri)) continue;
    seenTrack.add(uri);
    const entry = byArtist.get(row.artistKey);
    candidates.push({
      uri,
      name: row.trackName,
      artist: row.artistName,
      rank: rotationIndex.get(row.artistKey) ?? rotationRanked.length,
      streams: entry?.streams ?? 0,
      recent: row.playedAtMs,
    });
  }
  candidates.sort(
    (a, b) => a.rank - b.rank || b.streams - a.streams || b.recent - a.recent || a.uri.localeCompare(b.uri),
  );

  // The two pools are disjoint by construction — a candidate is an in-window
  // track the playlist does NOT hold, and a replacement is a row the playlist
  // DOES — so each half is drawn from its own, and `replacements: 5, appends: 5`
  // really is ten proposals rather than five plus whatever the removals left.
  const appendProposals: AppendProposal[] = candidates.slice(0, appends).map((c) => ({
    uri: c.uri,
    name: c.name,
    artist: c.artist,
    rotation_rank: c.rank,
    streams_in_window: c.streams,
    rationale:
      `${c.artist} is #${c.rank} in the last ${plural(windowDays, 'day', 'days')} rotation `
      + `(${plural(c.streams, 'stream', 'streams')})`,
  }));

  return {
    playlistId,
    playlistName: typeof meta.name === 'string' ? meta.name : null,
    playlistTotal: playlistItemTotal(meta) ?? null,
    rowsRead: playlistRows.length,
    rowsUnreadable,
    walkTruncated: walk.truncated,
    walkTruncatedReason: walk.truncated
      ? (walk.truncatedByCap
        ? 'the items walk hit its row cap'
        : 'the items walk ended before the playlist total')
      : null,
    replacements: replacementProposals,
    appends: appendProposals,
    rotation: rotationRanked.slice(0, 10).map(({ artist, streams }) => ({ artist, streams })),
    rotationArtistCount: rotationRanked.length,
    replacementsRequested: replacements,
    appendsRequested: appends,
    windowDays,
    windowAfter: new Date(windowAfterMs).toISOString(),
    streamsReturned: raw.length,
    streamsInWindow: inWindow.length,
    streamsUnreadableTime,
    streamsUnresolvedId,
    pageOldest,
    pageNewest,
    pageMayNotCover,
    candidatesAvailable: candidates.length,
    staleAvailable: staleOrder.length,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Everything a caller could not have learned from the numbers alone.
 *
 * Each note is about a limit of what was READ, not about the user's taste, and
 * each one changes how a proposal should be acted on — which is the test for
 * whether it belongs here at all.
 */
function disclosures(plan: Plan): string[] {
  const notes: string[] = [];
  if (plan.pageMayNotCover) {
    notes.push(
      `stats.fm returns a bounded recent page, which here spans ${plan.pageOldest} to ${plan.pageNewest}. That page `
      + `does not reach back to the window start (${plan.windowAfter}), so "absent from the window" means "absent `
      + 'from the rows this page carried": a track played before '
      + `${plan.pageOldest} is not distinguishable here from one never played at all.`,
    );
  }
  if (plan.streamsReturned === 0) {
    notes.push(
      'stats.fm returned no stream rows for this user, so there is no rotation and no staleness evidence. '
      + 'No row is proposed for removal on that basis.',
    );
  }
  if (plan.streamsUnreadableTime > 0) {
    notes.push(
      `${plural(plan.streamsUnreadableTime, 'row', 'rows')} had no readable play time and were excluded from the window `
      + 'rather than counted into it — a row that cannot be placed in or out of a window is evidence for neither.',
    );
  }
  if (plan.streamsUnresolvedId > 0) {
    notes.push(
      `${plural(plan.streamsUnresolvedId, 'in-window row', 'in-window rows')} carried no usable Spotify track id, so they can `
      + 'be neither proposed as a URI nor matched against the playlist. They still count toward the rotation.',
    );
  }
  if (plan.rowsUnreadable > 0) {
    notes.push(
      `${plural(plan.rowsUnreadable, 'playlist row', 'playlist rows')} had no readable URI and were left alone: a row that `
      + 'cannot be named cannot be matched against the streams or removed by position.',
    );
  }
  if (plan.walkTruncated) {
    notes.push(
      `Only the first ${plan.rowsRead} of this playlist's rows were read (${plan.walkTruncatedReason}), so `
      + '"stale" counts the rows that were read, not every row the playlist holds. '
      + 'Nothing past the walk was examined and nothing past it will be removed.',
    );
  }
  return notes;
}

/** The structured payload every response mode carries. */
function planPayload(userId: string, plan: Plan, dryRun: boolean): Record<string, unknown> {
  return {
    ok: true,
    dry_run: dryRun,
    statsfm_user: userId,
    playlist_id: plan.playlistId,
    playlist_name: plan.playlistName,
    playlist_total: plan.playlistTotal,
    playlist_rows_read: plan.rowsRead,
    playlist_rows_unreadable: plan.rowsUnreadable,
    playlist_walk_truncated: plan.walkTruncated,
    playlist_walk_truncated_reason: plan.walkTruncatedReason,
    window: { days: plan.windowDays, after: plan.windowAfter, before: null, timezone: 'UTC' },
    rotation: plan.rotation,
    rotation_artist_count: plan.rotationArtistCount,
    streams: {
      returned: plan.streamsReturned,
      in_window: plan.streamsInWindow,
      unreadable_timestamps: plan.streamsUnreadableTime,
      unresolved_track_ids: plan.streamsUnresolvedId,
      page_oldest: plan.pageOldest,
      page_newest: plan.pageNewest,
      page_may_not_cover_window: plan.pageMayNotCover,
    },
    proposed: { replacements: plan.replacements, appends: plan.appends },
    available: {
      stale_playlist_rows: plan.staleAvailable,
      rotation_candidates: plan.candidatesAvailable,
    },
  };
}

function planLines(plan: Plan, dryRun: boolean, heading: string): string[] {
  const name = plan.playlistName ?? plan.playlistId;
  const total = plan.playlistTotal === null ? 'total unknown' : plural(plan.playlistTotal, 'item', 'items');
  const lines = [`${heading} — ${name} (${total})`];

  lines.push('', `Replacements (${plan.replacements.length} of ${plan.staleAvailable} stale row(s)):`);
  if (plan.replacements.length > 0) {
    for (const r of plan.replacements) lines.push(`  #${r.position + 1} ${r.uri} "${r.name}" — ${r.rationale}`);
  } else {
    lines.push(`  none — ${plural(plan.staleAvailable, 'row', 'rows')} in this playlist fell outside the window.`);
  }

  lines.push('', `Appends (${plan.appends.length} of ${plan.candidatesAvailable} candidate(s)):`);
  if (plan.appends.length > 0) {
    for (const a of plan.appends) lines.push(`  ${a.uri} "${a.name}" — ${a.rationale}`);
  } else {
    lines.push(
      `  none — ${plural(plan.candidatesAvailable, 'in-window track', 'in-window tracks')} the playlist does not already hold.`,
    );
  }

  // The shortfall is measured against what the caller ASKED for, not against
  // what got proposed. Comparing the proposed counts to the available pool
  // would compare a number to itself and report no shortfall ever — which is
  // how a list silently shorter than requested comes to read as the whole
  // answer.
  const shortfalls: string[] = [];
  if (plan.replacements.length < plan.replacementsRequested) {
    shortfalls.push(
      `${plan.replacementsRequested - plan.replacements.length} replacement(s) — only `
      + `${plural(plan.staleAvailable, 'stale row', 'stale rows')} in the window`,
    );
  }
  if (plan.appends.length < plan.appendsRequested) {
    shortfalls.push(
      `${plan.appendsRequested - plan.appends.length} append(s) — only `
      + `${plural(plan.candidatesAvailable, 'in-window track', 'in-window tracks')} the playlist does not already hold`,
    );
  }
  if (shortfalls.length > 0) {
    lines.push(
      '',
      `Short of what was asked for: ${shortfalls.join('; ')}. The lists above are the whole of what the evidence `
      + 'supports and are not padded. Widen window_days, or lower replacements/appends to match.',
    );
  }

  if (plan.rotation.length > 0) {
    lines.push('', `Rotation (top ${plan.rotation.length} of ${plan.rotationArtistCount} artists):`);
    for (const r of plan.rotation) lines.push(`  ${r.artist} — ${plural(r.streams, 'stream', 'streams')}`);
  }

  const notes = disclosures(plan);
  if (notes.length > 0) lines.push('', ...notes.map((n) => `(${n})`));

  if (dryRun) lines.push('', 'DRY RUN — nothing was written. Re-run with dry_run=false to apply this plan.');
  return lines;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerStatsfmJukeboxTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'statsfm_jukebox',
    "Propose replacements and appends for a playlist from a stats.fm user's recent rotation: ranks the "
      + "playlist's rows by staleness against the streams in a window, and picks in-window tracks the playlist "
      + 'does not hold. dry_run defaults to TRUE — the default call is a plan and writes nothing. dry_run=false '
      + 'removes the stale rows and adds the picks, always after an elicitation confirmation that is refused '
      + 'outright when the client cannot prompt, and returns receipts resolvable by verify_receipt and reversible '
      + 'by undo_mutation (two calls, newest first). Rotation and staleness are computed from the bounded recent '
      + "page stats.fm returns, and the response reports that page's own span so \"absent from the window\" is "
      + 'never read as "provably never played". Rows whose play time or Spotify track id cannot be read are counted '
      + 'and excluded, never guessed.',
    {
      ...StatsfmUserInputFields,
      playlist_id: z
        .string()
        .min(1)
        .describe('Playlist to refresh: Spotify playlist ID, spotify:playlist: URI, or open.spotify.com playlist URL'),
      replacements: ProposalCount('stale rows to replace'),
      appends: ProposalCount('new tracks to append'),
      window_days: WindowDays,
      dry_run: DryRunDefault,
      response_format: ResponseFormat,
    },
    async (args) => {
      const userId = resolveStatsfmUserInput(args as Record<string, unknown>).userId;
      const dryRun = isDryRun(args);
      const replacements = args.replacements ?? 5;
      const appends = args.appends ?? 5;
      const windowDays = args.window_days ?? 90;
      const playlistRef = normalizePlaylistReference(args.playlist_id);

      let plan: Plan;
      try {
        plan = await buildPlan(client, userId, playlistRef, replacements, appends, windowDays, Date.now());
      } catch (err) {
        // A read that failed is reported as a failed read. Nothing here degrades
        // to "0 stale rows, 0 candidates", which would read as a confident answer
        // about a playlist nobody managed to look at.
        const reason = readFailureMessage(err);
        return textResult(
          `Could not build a jukebox plan for ${playlistRef}: ${reason}. Nothing was read and nothing was written.`,
          { ok: false, dry_run: dryRun, reason: 'plan_unavailable', statsfm_user: userId, playlist_id: playlistRef, read_failure: reason },
        );
      }

      const body = planPayload(userId, plan, dryRun);

      if (dryRun) return textResult(planLines(plan, true, 'Jukebox plan (DRY RUN)').join('\n'), body);

      if (readOnlyModeEnabled()) {
        return textResult(
          'Refused to write: SPOTIFY_MCP_READONLY mode is active, so nothing was changed. '
          + 'Re-run with dry_run=true for the plan, or drop read-only mode to commit.',
          { ...body, ok: false, blocked: 'read_only_mode' },
        );
      }

      if (plan.replacements.length === 0 && plan.appends.length === 0) {
        return textResult(planLines(plan, false, 'Jukebox (nothing to do)').join('\n'), {
          ...body,
          applied: false,
          no_op_reason: 'nothing_proposed',
        });
      }

      // No threshold. See the module header: the removal half deletes rows, and
      // a count of five is not a defence for deleting five.
      const verdict = await confirmViaElicitation(server, {
        message: describeConfirmation('apply the jukebox plan', plan.playlistName ?? plan.playlistId, [
          `Remove ${plan.replacements.length} stale row(s) and add ${plan.appends.length} track(s) to `
          + `"${plan.playlistName ?? plan.playlistId}".`,
          ...plan.replacements.slice(0, 5).map((r) => `remove #${r.position + 1} ${r.uri} — ${r.rationale}`),
          ...(plan.replacements.length > 5 ? [`(…and ${plan.replacements.length - 5} more removals)`] : []),
          ...plan.appends.slice(0, 5).map((a) => `add ${a.uri} — ${a.rationale}`),
          ...(plan.appends.length > 5 ? [`(…and ${plan.appends.length - 5} more additions)`] : []),
        ]),
        confirmLabel: 'Apply jukebox plan',
      });
      const refusal = requiredConfirmationRefusal(verdict);
      if (refusal) return textResult(refusal.message, { ...body, ...refusal.payload });

      const encId = encodeURIComponent(plan.playlistId);
      const writeCap = capFor('playlist_writes');
      const receipts: Receipt[] = [];
      let requests = 0;

      // Positions are indices into the CURRENT playlist, so removals run from
      // the tail backwards: once a chunk lands, every lower index has shifted.
      if (plan.replacements.length > 0) {
        const doomed = [...plan.replacements].sort((a, b) => b.position - a.position);
        let expectedTotal = plan.playlistTotal;
        for (let start = 0; start < doomed.length; start += writeCap) {
          const slice = doomed.slice(start, start + writeCap);
          await client.delete(`/playlists/${encId}/items`, {
            tracks: slice.map((r) => ({ uri: r.uri, positions: [r.position] })),
          });
          requests += 1;
          receipts.push(await issueReceipt(client, {
            kind: 'playlist_items',
            id: plan.playlistId,
            uris: slice.map((r) => r.uri),
            expectPresent: false,
            targetedPositions: slice.map((r) => ({ uri: r.uri, position: r.position })),
            ...(expectedTotal === null ? {} : { before: expectedTotal }),
          }));
          if (expectedTotal !== null) expectedTotal -= slice.length;
        }
      }

      if (plan.appends.length > 0) {
        const uris = plan.appends.map((a) => a.uri);
        for (let start = 0; start < uris.length; start += writeCap) {
          await client.post(`/playlists/${encId}/items`, { uris: uris.slice(start, start + writeCap) });
          requests += 1;
        }
        const afterRemovals = plan.playlistTotal === null ? null : Math.max(0, plan.playlistTotal - plan.replacements.length);
        receipts.push(await issueReceipt(client, {
          kind: 'playlist_items',
          id: plan.playlistId,
          uris,
          expectPresent: true,
          ...(afterRemovals === null ? {} : { before: afterRemovals }),
        }));
      }

      // The final total is the LAST receipt's MEASURED `after`, never a number
      // computed from the plan. When the verification walk carried no total the
      // field is null and the prose says so — an inferred total is not a reading.
      const finalTotal = receipts.length > 0 ? receipts[receipts.length - 1]!.after ?? null : null;

      const applied: Record<string, unknown> = {
        ...body,
        ok: true,
        applied: true,
        removed: plan.replacements.length,
        added: plan.appends.length,
        playlist_total_before: plan.playlistTotal,
        playlist_total_after: finalTotal,
        playlist_total_after_unreadable: finalTotal === null,
        requests,
        receipts: receipts.map((r) => ({
          receipt_id: r.receipt_id,
          kind: r.kind,
          verified: r.verified,
          before: r.before ?? null,
          after: r.after ?? null,
        })),
        undo_order: `newest first: undo ${[...receipts].reverse().map((r) => r.receipt_id).join(', then ')}`,
      };

      const lines = [
        `Applied the jukebox plan to "${plan.playlistName ?? plan.playlistId}": removed `
        + `${plural(plan.replacements.length, 'row', 'rows')}, added ${plural(plan.appends.length, 'track', 'tracks')}.`,
        `Playlist total: ${plan.playlistTotal ?? 'unknown'} → ${finalTotal ?? 'unknown after the write'}`
        + (finalTotal === null ? ' — the verification read carried no total, so the after figure is unknown rather than computed.' : '.'),
        '',
        ...receipts.map((r) => formatReceipt(r)),
        '',
        `To reverse this: two undo_mutation calls, newest first — ${[...receipts].reverse().map((r) => r.receipt_id).join(', then ')}.`,
      ];
      const notes = disclosures(plan);
      if (notes.length > 0) lines.push('', ...notes.map((n) => `(${n})`));

      if (args.response_format === 'json') {
        return { content: [{ type: 'text' as const, text: JSON.stringify(applied, null, 2) }], structuredContent: applied };
      }
      return textResult(lines.join('\n'), applied);
    },
  );
}
