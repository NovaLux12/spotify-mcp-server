/**
 * Album completion & consolidation hygiene (#112 idea 5).
 *
 * Read-only analysis over the user's liked (/me/tracks) library:
 *   • NEAR-COMPLETE ALBUMS — albums where 70%–99% of the tracks are already
 *     liked; suggest saving the whole album (and optionally unliking the
 *     individually saved tracks, which become redundant).
 *   • ORPHANED SINGLES — standalone singles where nothing else from the same
 *     release or the same artist is liked; reported at LOW confidence because
 *     a lone single may be perfectly intentional.
 *
 * The tool never mutates anything: suggestions are rendered as prose only.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { quotaPreflight, quotaSnapshot, quotaWindowRemaining, quotaDelta } from '../client.js';
import type { SavedTrackItem, SpotifyAlbumFull } from '../types/spotify.js';
import {
  ResponseFormat,
  MaxResults,
  resolveMaxResults,
  completenessFooter,
  truncateItems,
  structuredContent,
  capRowSections,
  emitOnce,
} from '../shaping.js';
import type { ResponseFormatValue } from '../shaping.js';
import { fetchAlbumsPerId, PER_ID_FANOUT_WIDTH } from './catalog.js';
import type { PerIdRead } from './catalog.js';
import { getConfig } from '../config.js';

/** Hard cap on distinct GET /albums/{id} lookups per analysis run (#112 idea 5). */
const ALBUM_LOOKUP_CAP = 200;

/** `/me/tracks` page size used by the walk (see analyze). */
const TRACK_PAGE_LIMIT = 50;

/** Coverage ratio at which an album counts as near-complete (inclusive). */
const NEAR_COMPLETE_THRESHOLD = 0.7;

/**
 * #897: the fan-in result for a run that needed no album read at all.
 *
 * Written as a constant rather than an inline literal so the "nothing to read"
 * path is the same shape as a real read — `album_lookups.unresolved` stays an
 * array and `rate_limited` stays `false` rather than becoming `undefined` and
 * having a reader guess which of those it got.
 */
const EMPTY_ALBUM_READ: PerIdRead<SpotifyAlbumFull> = {
  byId: new Map(),
  unresolved: [],
  throttled: null,
  requests: 0,
};

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

interface LikedTrackRef {
  id: string;
  name: string;
  uri: string;
}

/** All liked tracks sharing one parent album. */
interface AlbumGroup {
  album_id: string;
  album_name: string;
  album_uri: string;
  /** From the simplified track.album object; null until an album lookup fills it. */
  album_type: string | null;
  artist_ids: string[];
  artist_names: string[];
  liked_count: number;
  liked_tracks: LikedTrackRef[];
  /** Filled from GET /albums/{id}; null when no lookup was made (cap/skip). */
  total_tracks: number | null;
  /** liked_count / total_tracks once known. */
  coverage: number | null;
}

interface NearCompleteFinding {
  kind: 'near_complete_album';
  album_id: string;
  album_name: string;
  album_uri: string;
  artist_names: string[];
  liked_count: number;
  total_tracks: number;
  /** liked/total, in [0.7, 1.0). */
  coverage: number;
  confidence: 'high';
  suggestion: string;
}

interface OrphanedSingleFinding {
  kind: 'orphaned_single';
  track_id: string;
  track_name: string;
  track_uri: string;
  artist_names: string[];
  album_id: string;
  album_name: string;
  confidence: 'low';
  reason: string;
}

/**
 * What a completed run publishes.
 *
 * Declared as a `type`, not an `interface`, and that is load-bearing: an
 * `interface` has no implicit index signature, so it is not assignable to the
 * wire's `Record<string, unknown>` (#1343). That gap is why this used to need
 * `payload as unknown as Record<string, unknown>` on the way out — the cast was
 * covering up a declaration choice, not a shape the compiler had checked.
 */
type AnalysisResult = {
  /** Always true on a completed run. */
  ok: true;
  scanned: {
    liked_tracks: number;
    skipped_unplayable: number;
    album_groups: number;
    fetched: number;
    cap: number;
    fetch_all_cap: number;
    snapshot_state: 'complete' | 'partial';
    complete: boolean;
    tracks_truncated_by_cap: boolean;
  };
  album_lookups: {
    /** Distinct albums whose per-id read was attempted. */
    made: number;
    /**
     * Album groups whose `total_tracks`/`album_type` were read off the
     * `/me/tracks` walk rather than a per-id `GET /albums/{id}` (#897). A run
     * reporting `requests: 0` is complete, not empty: this is the number that
     * says so. It is `0` only when every group needed the fallback read.
     */
    shared_from_walk: number;
    cap: number;
    truncated_by_cap: boolean;
    /**
     * `GET /albums/{id}` requests actually issued (#1224: the batch route is
     * gone, so this is one per album, width-bounded rather than serial).
     */
    requests: number;
    request_mode: 'per_id';
    fanout_width: number;
    /** Albums that could not be read, each with the reason. */
    unresolved: Array<{ id: string; reason: string; status: number | null }>;
    /** True when a read was rate-limited; analysis degrades to a partial. */
    rate_limited: boolean;
    rate_limit_message?: string;
    retry_after_sec?: number | null;
  };
  counts: {
    near_complete: number;
    orphaned_singles: number;
  };
  groups: AlbumGroup[];
  near_complete: NearCompleteFinding[];
  orphaned_singles: OrphanedSingleFinding[];
};

/**
 * The quota-cooldown refusal (#1343).
 *
 * This payload was previously cast to `AnalysisResult` to reach the wire, and
 * the cast is what let the contradiction stand: `AnalysisResult.ok` is the
 * literal type `true`, and this object says `ok: false`. The compiler was
 * never allowed to notice. It is now a declared variant of the union, so
 * `ok: false` is a value the type admits — which is the honest answer,
 * because the cooldown really does return `ok: false` and a host reading
 * `ok === true` to mean "the scan completed" must be able to see it.
 */
type CooldownResult = {
  ok: false;
  cooldown: true;
  wait_sec: number;
  requests_made: 0;
  requests_planned: number;
};

/**
 * `dry_run` cost preview (#763). Zero API requests, so it reports neither
 * `scanned` nor `counts` — the fields a real run fills in are genuinely
 * absent here rather than zero, and a reader that assumed otherwise would be
 * reading a scan that never happened (#803).
 */
type DryRunResult = {
  ok: true;
  dry_run: true;
  requests_made: 0;
  album_lookup_cap: number;
  album_lookup_shrunk: boolean;
  request_mode: 'per_id';
  fanout_width: number;
  track_walk_requests: number;
  estimated_album_requests: number;
  estimated_requests: number;
};

/** Every payload `library_hygiene` can put on the wire. */
type LibraryHygieneResult = AnalysisResult | CooldownResult | DryRunResult;

type ToolOut = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};

/**
 * The row arrays `library_hygiene` publishes in the prose modes (#895).
 *
 * `near_complete` and `orphaned_singles` are the findings the tool exists to
 * report, and the prose path already caps them via `truncateItems`; shipping
 * them uncapped alongside that prose made the machine-readable channel
 * disagree with the sentence the tool's own description writes.
 */
const ROW_ARRAYS = ['near_complete', 'orphaned_singles'] as const;

/**
 * Fields the prose modes do not ship at all, and the exact count the caller
 * would have got (#895). `groups` is the bulk export: pass
 * `response_format: 'json'` to receive it whole.
 */
const WITHHELD_ROWS = ['groups'] as const;

/**
 * One-line text for a json-mode call whose payload sits in
 * `structuredContent` (#895). The two channels are deliberately not
 * byte-identical — see `emitOnce`. Bounded by construction: it names section
 * counts and never interpolates a row.
 */
function summarizeAnalysis(payload: Record<string, unknown>): string {
  const sections = payload.sections as
    | Record<string, { returned: number; total: number; truncated: boolean; unreadable?: boolean }>
    | undefined;
  if (!sections) return 'Album completion & consolidation — full analysis in structuredContent.';
  const parts = Object.entries(sections).map(([key, section]) =>
    section.unreadable ? `${key} (unreadable)` : `${key}: ${section.returned}/${section.total}`);
  const head = 'Album completion & consolidation — full analysis in structuredContent:';
  return `${head}\nSections: ${parts.join(', ')}.`;
}

/**
 * Shape one result (#895).
 *
 * The prose modes cap the machine channel through `capRowSections`;
 * `response_format: 'json'` is the bulk export and returns the analysis whole,
 * which is what the tool description promises. Either way the payload is
 * emitted ONCE, as `structuredContent`, with a bounded text block beside it.
 */
function shapeResult(
  rf: ResponseFormatValue,
  prose: string,
  payload: LibraryHygieneResult,
  maxResults?: number,
): ToolOut {
  const bulk = rf === 'json';
  // json mode is the bulk export: the analysis whole, uncapped and unenveloped.
  // The prose modes are where the cap applies, because that is where the
  // `max_results` promise in the tool description is written.
  const machine = bulk || maxResults === undefined || !('groups' in payload)
    ? payload
    : capRowSections(payload, ROW_ARRAYS, maxResults, WITHHELD_ROWS);
  if (bulk) return emitOnce(structuredContent(machine), summarizeAnalysis);
  return {
    content: [{ type: 'text', text: prose }],
    structuredContent: structuredContent(machine),
  };
}

// ---------------------------------------------------------------------------
// Core analysis (pure given fetched data + album lookups)
// ---------------------------------------------------------------------------

const pct = (ratio: number): string => `${Math.round(ratio * 100)}%`;

function buildSuggestion(likedCount: number): string {
  return `save the album and optionally prune the ${likedCount} single${likedCount === 1 ? '' : 's'} you liked individually`;
}

/**
 * Walk the liked-tracks library, group by album, look up album totals
 * (cached per album id, capped), and derive hygiene findings.
 */
async function analyze(
  client: SpotifyClient,
): Promise<AnalysisResult & { requests_made?: number }> {
  const snapshot = quotaSnapshot(client);
  const fetchAllCap = getConfig().fetchAllCap;
  // (#904) shrink the module-local lookup cap to the remaining quota window
  // when recent throttle pressure exists; idle clients keep the full cap.
  const lookupCap = Math.min(ALBUM_LOOKUP_CAP, quotaWindowRemaining(client));
  const lookupShrunk = lookupCap < ALBUM_LOOKUP_CAP;
  const walked = await client.getAllPages<SavedTrackItem>(
    '/me/tracks',
    { limit: String(TRACK_PAGE_LIMIT) },
    { maxItems: fetchAllCap + 1 },
  );

  const tracksTruncatedByCap = walked.length > fetchAllCap;
  const saved = walked.slice(0, fetchAllCap);

  // ---- Group liked tracks by parent album ---------------------------------
  let skippedUnplayable = 0;
  const groupsById = new Map<string, AlbumGroup>();
  const likedTrackIds = new Set<string>();
  const likedCountByArtist = new Map<string, number>();
  const artistsByTrackId = new Map<string, { id: string; name: string }[]>();

  for (const entry of saved) {
    const track = entry?.track;
    if (!track?.id || !track.album?.id) {
      skippedUnplayable++;
      continue;
    }
    likedTrackIds.add(track.id);
    artistsByTrackId.set(track.id, (track.artists ?? []).map((a) => ({ id: a.id, name: a.name })));
    for (const artist of track.artists ?? []) {
      if (!artist.id) continue;
      likedCountByArtist.set(artist.id, (likedCountByArtist.get(artist.id) ?? 0) + 1);
    }
    let group = groupsById.get(track.album.id);
    if (!group) {
      group = {
        album_id: track.album.id,
        album_name: track.album.name,
        album_uri: track.album.uri ?? `spotify:album:${track.album.id}`,
        album_type: null,
        artist_ids: (track.artists ?? []).map((a) => a.id).filter(Boolean),
        artist_names: (track.artists ?? []).map((a) => a.name),
        liked_count: 0,
        liked_tracks: [],
        total_tracks: null,
        coverage: null,
      };
      groupsById.set(track.album.id, group);
    }
    group.liked_count++;
    group.liked_tracks.push({ id: track.id, name: track.name, uri: track.uri });
    // #897: the walk already delivered these two, on this row. `album_type`
    // and `total_tracks` are required members of Spotify's `AlbumBase`, and
    // `TrackObject.album` is a `SimplifiedAlbumObject` — so the per-id
    // `GET /albums/{id}` below was re-reading what the grouping loop was
    // already holding, once per album in the library. Share it instead.
    //
    // Checked per row rather than only at group creation, because the first
    // row of a group is not necessarily the one that carries the fields, and
    // `> 0` rather than `typeof === 'number'` alone, so a nonsensical zero
    // falls through to the read below and is named there instead of silently
    // excluding the album from the findings.
    if (group.album_type == null && typeof track.album.album_type === 'string') {
      group.album_type = track.album.album_type;
    }
    if (group.total_tracks == null && typeof track.album.total_tracks === 'number' && track.album.total_tracks > 0) {
      group.total_tracks = track.album.total_tracks;
    }
  }

  // Deterministic processing order: busiest album first, id as tiebreaker.
  const groups = [...groupsById.values()].sort(
    (a, b) => b.liked_count - a.liked_count || a.album_id.localeCompare(b.album_id),
  );
  // ---- Per-id GET /albums/{id} fan-in (cached, capped) --------------------
  // #1224: the fan-in used to be `GET /albums?ids=`, which #763 took to
  // ceil(albums / 20) requests. That route is one of the batch endpoints the
  // February 2026 changelog removed, and it had no per-id fallback here, so on
  // a registration without the grant this tool rethrew — the one error that
  // endpoint is most likely to produce, on the analysis that degrades
  // gracefully everywhere else. The per-id route is the documented
  // replacement, and the fan-out is width-bounded rather than serial.
  //
  // #897: that replacement answered for EVERY album in the library, and for
  // the near-complete rollup the only two fields it was read for are
  // `total_tracks` and `album_type` — both carried by the
  // `SimplifiedAlbumObject` already on every `/me/tracks` row the grouping
  // loop above consumed. Migrating off the batch route was therefore never
  // what would make this cheap; the request that made it expensive was a
  // re-read of data the walk held.
  //
  // The orphaned-singles rollup is the one consumer that is NOT satisfied by
  // the walk: it compares a release's full `tracks.items` listing against the
  // liked set, and a `SimplifiedAlbumObject` carries no track list at all. So
  // an album is still read when either (a) the walk could not answer its
  // total, or (b) it is a single-candidate — which is exactly the population
  // the orphan check can ever examine, because a group that is neither a
  // single nor three tracks or shorter is skipped by that check before it
  // ever looks at a track list. Reading the rest was the waste.
  //
  // Everything about the read itself is unchanged: per-id, width-bounded,
  // capped, 429 degrading to a partial, and every failure named.
  const needsAlbumRead = groups.filter(
    (g) => g.total_tracks == null || g.album_type === 'single' || (g.total_tracks != null && g.total_tracks <= 3),
  );
  const sharedFromWalk = groups.length - needsAlbumRead.length;
  const budgeted = needsAlbumRead.slice(0, lookupCap);
  const lookupTruncated = needsAlbumRead.length > budgeted.length;
  const lookups = budgeted.length;

  // #763 point 4 survives: a 429 degrades the run to a partial with
  // Retry-After-aware messaging instead of aborting the whole analysis. The
  // per-id fan-out records the first throttle rather than throwing, so the
  // albums that did read are still reported and the rest are named as
  // unresolved rather than looking like albums with no track total.
  const albumRead = budgeted.length > 0
    ? await fetchAlbumsPerId<SpotifyAlbumFull>(client, budgeted.map((g) => g.album_id))
    : EMPTY_ALBUM_READ;
  const albumCache = albumRead.byId;
  const throttled = albumRead.throttled;
  const unresolvedAlbums = albumRead.unresolved;

  for (const group of groups) {
    const full = albumCache.get(group.album_id) ?? null;
    if (full) {
      // Guarded rather than assigned: a read that comes back without a total
      // must not blank a value the walk already supplied.
      if (group.total_tracks == null && typeof full.total_tracks === 'number') {
        group.total_tracks = full.total_tracks;
      }
      group.album_type = full.album_type ?? group.album_type;
    }
  }

  // ---- Findings ------------------------------------------------------------
  const nearComplete: NearCompleteFinding[] = [];
  for (const group of groups) {
    if (!group.total_tracks || group.total_tracks <= 0) continue;
    const coverage = group.liked_count / group.total_tracks;
    group.coverage = coverage;
    if (coverage >= NEAR_COMPLETE_THRESHOLD && coverage < 1) {
      nearComplete.push({
        kind: 'near_complete_album',
        album_id: group.album_id,
        album_name: group.album_name,
        album_uri: group.album_uri,
        artist_names: group.artist_names,
        liked_count: group.liked_count,
        total_tracks: group.total_tracks,
        coverage,
        confidence: 'high',
        suggestion: buildSuggestion(group.liked_count),
      });
    }
  }

  const orphanedSingles: OrphanedSingleFinding[] = [];
  for (const group of groups) {
    if (!group.liked_tracks.length) continue;
    const full = albumCache.get(group.album_id) ?? null;
    const isSingle =
      (full?.album_type ?? group.album_type) === 'single' ||
      (group.total_tracks !== null && group.total_tracks <= 3);
    if (!isSingle) continue;

    // "Other tracks on this release are NOT liked": compare the release's own
    // track listing against the global liked set, minus this group's entries.
    const groupTrackIds = new Set(group.liked_tracks.map((t) => t.id));
    const releaseTracks = full?.tracks?.items ?? [];
    const otherLikedOnRelease = releaseTracks.filter(
      (t) => likedTrackIds.has(t.id) && !groupTrackIds.has(t.id),
    );
    if (releaseTracks.length > 0 && otherLikedOnRelease.length > 0) continue;

    for (const track of group.liked_tracks) {
      // Only liked item from that artist: every artist of this track must have
      // exactly one liked track overall (this one).
      const artists = artistsByTrackId.get(track.id) ?? [];
      const onlyFromArtist =
        artists.length > 0 &&
        artists.every((a) => !a.id || likedCountByArtist.get(a.id) === 1);
      if (!onlyFromArtist) continue;
      orphanedSingles.push({
        kind: 'orphaned_single',
        track_id: track.id,
        track_name: track.name,
        track_uri: track.uri,
        artist_names: artists.map((a) => a.name),
        album_id: group.album_id,
        album_name: group.album_name,
        confidence: 'low',
        reason:
          `nothing else liked from this release (${group.album_name}) or its artist(s) — `
            + 'a lone single like this may be intentional, so treat as a hint only',
      });
    }
  }

  return {
    ok: true,
    scanned: {
      liked_tracks: saved.length,
      skipped_unplayable: skippedUnplayable,
      album_groups: groups.length,
      fetched: saved.length,
      cap: fetchAllCap,
      fetch_all_cap: fetchAllCap,
      snapshot_state: tracksTruncatedByCap ? 'partial' : 'complete',
      complete: !tracksTruncatedByCap,
      tracks_truncated_by_cap: tracksTruncatedByCap,
    },
    album_lookups: {
      made: lookups,
      shared_from_walk: sharedFromWalk,
      cap: lookupCap,
      truncated_by_cap: lookupTruncated,
      // #1224: one request per album id, and that is the number the caller
      // pays for — the old `batch_requests`/`batch_size` pair described the
      // removed `?ids=` route and would now be a false claim.
      requests: albumRead.requests,
      request_mode: 'per_id' as const,
      fanout_width: PER_ID_FANOUT_WIDTH,
      /**
       * Albums whose `GET /albums/{id}` failed, with the reason. An album
       * here is excluded from the near-complete findings because its track
       * total is unknown — not because it has no tracks, and never silently.
       */
      unresolved: unresolvedAlbums,
      rate_limited: throttled !== null,
      ...(throttled
        ? {
          rate_limit_message: throttled.message,
          retry_after_sec: throttled.retry_after_sec,
        }
        : {}),
    },
    ...(lookupShrunk ? { requests_planned: ALBUM_LOOKUP_CAP, budget_shrunk: true } : {}),
    counts: {
      near_complete: nearComplete.length,
      orphaned_singles: orphanedSingles.length,
    },
    ...quotaDelta(client, snapshot),
    groups,
    near_complete: nearComplete,
    orphaned_singles: orphanedSingles,
  };
}

// ---------------------------------------------------------------------------
// Prose rendering
// ---------------------------------------------------------------------------

function renderProse(result: AnalysisResult, maxResults: number): string {
  const { scanned, album_lookups, counts, near_complete, orphaned_singles } = result;
  const lines: string[] = ['Library hygiene — album completion & consolidation:', ''];

  lines.push(
    `Scanned ${scanned.liked_tracks} liked track${scanned.liked_tracks === 1 ? '' : 's'} `
      + `across ${scanned.album_groups} album${scanned.album_groups === 1 ? '' : 's'}`
      + `${scanned.skipped_unplayable ? ` (${scanned.skipped_unplayable} unplayable/local entries skipped)` : ''}. `
      + `${completenessFooter({
        fetched: scanned.fetched,
        cap: scanned.cap,
        truncated: scanned.tracks_truncated_by_cap,
        subject: 'liked tracks',
      })}.`,
  );
  lines.push(
    `Album lookups: ${album_lookups.requests} GET /albums/{id} request`
      + `${album_lookups.requests === 1 ? '' : 's'} for ${album_lookups.made} album`
      + `${album_lookups.made === 1 ? '' : 's'} (per-id, since Feb 2026 removed the ?ids= batch; `
      + `fanned out ${album_lookups.fanout_width} at a time; cap ${album_lookups.cap} `
      + `${album_lookups.truncated_by_cap ? 'REACHED — some albums were not checked' : 'not reached'}). `
      + `${album_lookups.shared_from_walk} of ${scanned.album_groups} album`
      + `${scanned.album_groups === 1 ? '' : 's'} took their track total from the /me/tracks walk itself `
      + 'and needed no lookup at all.',
  );
  if (album_lookups.rate_limited) {
    lines.push(
      `  PARTIAL: album lookups were rate limited — ${album_lookups.rate_limit_message}. `
        + `Albums without a resolved total are excluded from the findings below; `
        + `${album_lookups.retry_after_sec != null ? `wait ~${album_lookups.retry_after_sec}s and ` : ''}`
        + 're-run to fill the gaps.',
    );
  }
  // #1224: an album that could not be read is not an album with no tracks.
  // Name the ids so the gaps above are never read as "nothing to find here".
  if (album_lookups.unresolved.length > 0) {
    const shown = album_lookups.unresolved.slice(0, 10).map((u) => u.id).join(', ');
    const more = album_lookups.unresolved.length > 10 ? ', …' : '';
    const reasons = [...new Set(album_lookups.unresolved.map((u) => u.reason))].slice(0, 3).join('; ');
    lines.push(
      `  ${album_lookups.unresolved.length} album read${album_lookups.unresolved.length === 1 ? '' : 's'} failed `
        + `(${reasons}): ${shown}${more}. Their track totals are unknown, so they are excluded from the findings below.`,
    );
  }

  if (scanned.liked_tracks === 0) {
    lines.push('', 'No liked tracks found — nothing to analyze.');
    return lines.join('\n');
  }

  // Combined findings, top-first: near-complete by coverage desc, then singles.
  near_complete.sort((a, b) => b.coverage - a.coverage || a.album_id.localeCompare(b.album_id));
  const combined: Array<NearCompleteFinding | OrphanedSingleFinding> = [
    ...near_complete,
    ...orphaned_singles,
  ];
  if (combined.length === 0) {
    lines.push('', 'No hygiene findings — your library looks tidy.');
    return lines.join('\n');
  }

  const t = truncateItems(combined, maxResults);
  const ncShown = Math.min(counts.near_complete, t.items.length);

  lines.push('');
  lines.push(
    `NEAR-COMPLETE ALBUMS (${counts.near_complete}): at least ${pct(NEAR_COMPLETE_THRESHOLD)} of the `
      + 'tracks are already liked — saving the album keeps everything in one place:',
  );
  for (const finding of t.items.slice(0, ncShown) as NearCompleteFinding[]) {
    const artists = finding.artist_names.length ? finding.artist_names.join(', ') : 'unknown artist';
    lines.push(
      `  • ${finding.album_name} — ${artists} | ${finding.liked_count}/${finding.total_tracks} tracks `
        + `liked (${pct(finding.coverage)}) | ${finding.suggestion} | URI: ${finding.album_uri}`,
    );
  }
  if (counts.near_complete === 0) lines.push('  (none)');

  lines.push(
    `ORPHANED SINGLES (${counts.orphaned_singles}) [LOW CONFIDENCE] — lone singles with nothing else `
      + 'liked from their release or artist:',
  );
  for (const finding of t.items.slice(ncShown) as OrphanedSingleFinding[]) {
    const artists = finding.artist_names.length ? finding.artist_names.join(', ') : 'unknown artist';
    lines.push(`  • ${finding.track_name} — ${artists} | URI: ${finding.track_uri}`);
  }
  if (counts.orphaned_singles === 0) lines.push('  (none)');

  if (t.footer) lines.push(`(${t.footer})`);
  return lines.join('\n');
}

const DryRunScan = z
  .boolean()
  .optional()
  .describe('Preview cost only.');

/** #763: cost preview for `library_hygiene` — issues zero API requests. */
function renderDryRun(client: SpotifyClient): { prose: string; payload: DryRunResult } {
  const fetchAllCap = getConfig().fetchAllCap;
  const lookupCap = Math.min(ALBUM_LOOKUP_CAP, quotaWindowRemaining(client));
  const walkPages = Math.max(1, Math.ceil(fetchAllCap / TRACK_PAGE_LIMIT));
  // #1224: one request per album again, since the `?ids=` batch route is gone.
  // The upper bound is the cap, not a per-chunk count. #897 keeps that as an
  // UPPER bound rather than the expectation: the `/me/tracks` rows carry
  // `total_tracks` and `album_type` themselves, so most albums need no read at
  // all. Budgeting for the worst case is the honest direction to err in, and
  // the common case cannot be claimed before the walk has run — how many albums
  // fall back is not knowable from here.
  //
  // What the walk CANNOT answer is the orphan-singles check, which compares an
  // album's real track listing against the liked set, and a
  // `SimplifiedAlbumObject` carries no track list. So a single-candidate — a
  // single, or three tracks or fewer — is still read even when its row answered
  // everything. Singles are common in a liked library, so "the walk answers, so
  // this costs nothing" would be false for a large share of real runs, and this
  // preview is where a caller decides whether the run is affordable.
  const albumLookups = lookupCap;
  const estimatedRequests = walkPages + albumLookups;
  const prose =
    `[dry run] library_hygiene would walk /me/tracks (up to ${walkPages} page${walkPages === 1 ? '' : 's'} `
    + `for ${fetchAllCap} liked tracks) and fan in up to ${lookupCap} album`
    + `${lookupCap === 1 ? '' : 's'} via per-id GET /albums/{id} request`
    + `${albumLookups === 1 ? '' : 's'} (fanned out ${PER_ID_FANOUT_WIDTH} at a time; Feb 2026 removed the ?ids= batch). `
    + `Cost: at most ~${estimatedRequests} requests, 0 made. That is the worst case. Each /me/tracks row `
    + 'already carries its album\'s track total and type, so most albums are never re-read; an album is read '
    + 'only when the walk could not answer it, or when it is a single or three tracks or shorter — the orphan '
    + 'check needs a real track listing, which a simplified album does not carry. How many fall back is not '
    + 'knowable before the walk runs, so the album-lookup figure stays the budgeted upper bound.';
  return {
    prose,
    payload: {
      ok: true,
      dry_run: true,
      requests_made: 0,
      album_lookup_cap: lookupCap,
      album_lookup_shrunk: lookupCap < ALBUM_LOOKUP_CAP,
      request_mode: 'per_id',
      fanout_width: PER_ID_FANOUT_WIDTH,
      track_walk_requests: walkPages,
      estimated_album_requests: albumLookups,
      estimated_requests: estimatedRequests,
    },
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerLibraryHygieneTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'library_hygiene',
    'Read-only album hygiene over your liked tracks: flags near-complete albums worth saving and '
      + 'lone singles with nothing else liked from their artist (low confidence). Album totals come '
      + 'from the /me/tracks walk; a width-bounded per-id GET /albums/{id} fills in the rest. '
      + 'Never mutates. dry_run previews cost.',
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
      dry_run: DryRunScan,
    },
    async (args) => {
      const rf = args.response_format;
      if (args.dry_run) {
        const preview = renderDryRun(client);
        return shapeResult(rf, preview.prose, preview.payload);
      }
      const gate = quotaPreflight(client);
      if (gate.blocked) {
        return shapeResult(rf, gate.message, {
          ok: false,
          cooldown: true,
          wait_sec: gate.waitSec,
          requests_made: 0,
          requests_planned: ALBUM_LOOKUP_CAP,
        });
      }
      const result = await analyze(client);
      const maxResults = resolveMaxResults(args.max_results, getConfig().maxItems);
      return shapeResult(rf, renderProse(result, maxResults), result, maxResults);
    },
  );
}
