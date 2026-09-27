/**
 * stats.fm tools (read-only): listening stats, tops, catalog and social
 * lookups against the public stats.fm API.
 *
 * No Spotify auth required — the StatsfmClient does unauthenticated GETs,
 * so this module is never scope-gated and stays visible under
 * SPOTIFY_MCP_READONLY. Registration key: `statsfm` (own toolset, on by
 * default, additive only).
 *
 * Reads default to the process-wide client in `lib/statsfm-client.ts` rather
 * than to a fresh one per registrar call, so this module shares its timeout,
 * retry and cache with `statsfm_taste.ts` and `taste_composites.ts` (#907).
 * Passing a client explicitly is a test seam, not a second policy.
 *
 * Endpoint paths verified live 2026-09-05; stats.fm envelopes are
 * `{ item }` for singles and `{ items }` for collections.
 *
 * Re-verified 2026-09-27 for the per-entity stream totals (#1006). The
 * aggregate route is plural and nested under `/users/{id}/streams/`:
 * `/users/{id}/streams/tracks/{trackId}/stats`. The shape that reads as the
 * obvious one — `/users/{id}/streams/{trackId}` — 404s, which is what made
 * #1006 conclude no per-entity total existed. One exists, and stats.fm
 * computes it server-side; see `readEntityTotals`.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  StatsfmClient,
  StatsfmApiError,
  statsfmClient,
} from '../lib/statsfm-client.js';
import {
  ResponseFormat,
  MaxResults,
  resolveMaxResults,
  truncateItems,
  paginationInfo,
  listStructuredContent,
  // #895: json mode and structuredContent share one row cap.
  capRowSections,
  emitOnce,
  // #1318/#1449: the one stats.fm user-identity argument.
  resolveStatsfmUserInput,
  StatsfmUserInputFields,
} from '../shaping.js';

/** The row array every stats.fm collection tool publishes (#895). */
const STATSFM_ROW_ARRAYS = ['items'] as const;

/**
 * One-line text for a json-mode call whose payload sits in
 * `structuredContent` (#895). Bounded by construction — it names the row count
 * and never interpolates a row.
 */
function summarizeStatsfmCollection(title: string) {
  return (payload: Record<string, unknown>): string => {
    const sections = payload.sections as Record<string, { returned: number; total: number }> | undefined;
    const items = sections?.items;
    const count = items ? ` (items: ${items.returned}/${items.total})` : '';
    return `${title}${count} — full payload in structuredContent.`;
  };
}

type J = Record<string, any>;

function invalidResponse(path: string, detail: string): never {
  throw new StatsfmApiError(200, `stats.fm invalid response for ${path}: ${detail}`);
}

function responseObject(body: unknown, path: string): J {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    invalidResponse(path, 'expected a JSON object');
  }
  return body as J;
}

function collectionItems(body: unknown, path: string): J[] {
  const object = responseObject(body, path);
  if (!Array.isArray(object.items)) invalidResponse(path, 'expected an items array');
  return object.items;
}

function nullableItem(body: unknown, path: string): J | null {
  const object = responseObject(body, path);
  if (!Object.prototype.hasOwnProperty.call(object, 'item')) {
    invalidResponse(path, 'expected an item field');
  }
  if (object.item !== null && (typeof object.item !== 'object' || Array.isArray(object.item))) {
    invalidResponse(path, 'expected item to be an object or null');
  }
  return object.item as J | null;
}

function requiredItem(body: unknown, path: string): J {
  const item = nullableItem(body, path);
  if (item === null) invalidResponse(path, 'expected a non-null item');
  return item;
}

function searchItems(body: unknown, path: string): Record<string, J[]> {
  const object = responseObject(body, path);
  const items = object.items;
  if (!items || typeof items !== 'object' || Array.isArray(items)) {
    invalidResponse(path, 'expected an items object');
  }
  for (const [name, entries] of Object.entries(items)) {
    if (!Array.isArray(entries)) invalidResponse(path, `expected ${name} to be an array`);
  }
  return items as Record<string, J[]>;
}

function statsPayload(body: unknown, path: string): J {
  const object = responseObject(body, path);
  if (object.items !== undefined && (!object.items || typeof object.items !== 'object' || Array.isArray(object.items))) {
    invalidResponse(path, 'expected items to be an object when present');
  }
  return (object.items ?? object) as J;
}

/**
 * The stats.fm identity argument is declared by `StatsfmUserInputFields` in
 * `src/shaping.ts` (#1318), not here. It used to be a module-private
 * `userIdSchema()` under one name while three sibling modules declared the
 * same argument under another; the two spellings are now one field declared in
 * one place, and `user_id` survives beside it as a deprecated alias for one
 * release (AGENTS.md §5).
 *
 * The one ranking-window vocabulary for the whole stats.fm surface (#720).
 *
 * Verified live 2026-09-26 against `GET /users/{id}/top/artists`: stats.fm
 * answers `400 {"message":"invalid range"}` for the singular `week`/`month`
 * spellings (and for `6months`, `year`, `all-time`). `weeks`/`months`/
 * `lifetime` are the complete accepted set, so this enum is the contract
 * rather than a local guess.
 *
 * This module, `statsfm_taste.ts`, and `taste_composites.ts` all forward
 * `range` to that same upstream query parameter, so all three import this
 * schema. Three private copies previously drifted apart and the two taste
 * copies advertised values upstream rejects outright.
 */
export const STATSFM_RANGES = ['weeks', 'months', 'lifetime'] as const;

export const statsfmRangeSchema = z
  .enum(STATSFM_RANGES)
  .optional()
  .describe('Ranking window: weeks, months, or lifetime. Default: lifetime');

/**
 * The named stream-window vocabulary for `statsfm_recent_streams` (#730).
 *
 * ## This is deliberately NOT the same enum as {@link STATSFM_RANGES}
 *
 * The ranking `range` is forwarded verbatim to a stats.fm query parameter, so
 * its vocabulary is whatever upstream answers 200 for. This one never reaches
 * the network: `/users/{id}/streams/recent` takes no window parameter at all,
 * and the bucket is resolved here into `after`/`before` and applied to the rows
 * in hand. The two lists therefore *cannot* be one enum — merging them would
 * advertise `year` to a ranking tool, and upstream answers
 * `400 {"message":"invalid range"}` for `year` (re-verified 2026-09-27 for
 * this issue; the same probe rejects `year`, `years`, `12months`, `52weeks`,
 * `all`, `allTime` and `since`). See `statsfm-window-enum.test.ts`, which pins
 * the split from both sides.
 *
 * ## Why the upstream bounds cannot do this work
 *
 * `after`/`before` were already declared on this tool, and they are a **silent
 * no-op** upstream. Probed live 2026-09-27 against three public profiles
 * (`rohan`, `spotify`, `lars`): `?after=4102444800000` (the year 2100) and
 * `?before=1000000000000` (2001) each return byte-identical results to the
 * unfiltered read. `limit` is ignored the same way, and `offset` is ignored
 * too, so the route is a fixed window of the newest rows.
 *
 * That makes this a correctness fix and not only a convenience one: forwarding
 * the bucket upstream would have returned unfiltered rows under a header
 * claiming a month. The same probe found the bounds *are* honoured on
 * `/users/{id}/streams`, on `/users/{id}/top/*` and on the per-entity
 * `/stats` aggregate, so this is a per-route fact and not a general one.
 *
 * ## The window is a filter, never a claim about the whole period
 *
 * The route returns a fixed, unpaged page of the newest rows (50 observed). A
 * `year` bucket over a page that spans 12 hours is a filter that kept
 * everything, not a year of history — so the resolved window is reported
 * alongside the page's own observed span (`page_oldest`/`page_newest`) and
 * `page_truncated`, so a caller can see when the page could not have covered
 * the bucket it asked for.
 */
export const STATSFM_STREAM_WINDOWS = ['today', 'week', 'month', 'year', 'lifetime'] as const;

export type StatsfmStreamWindow = (typeof STATSFM_STREAM_WINDOWS)[number];

export const statsfmStreamWindowSchema = z
  .enum(STATSFM_STREAM_WINDOWS)
  .optional()
  .describe(
    'Named window over the returned streams, resolved to UTC boundaries: '
    + 'today (since 00:00 UTC), week (since Monday 00:00 UTC), month (since the 1st, 00:00 UTC), '
    + 'year (since 1 January, 00:00 UTC), or lifetime (no lower bound). '
    + 'Ignored when `after` or `before` is supplied — an explicit bound wins. '
    + 'Applied to the rows stats.fm returns, which is a fixed recent page, not the full history.',
  );

/**
 * One row's play time in epoch ms, or `null` when it cannot be read.
 *
 * `endTime` is an ISO 8601 string on this route (verified 2026-09-27), while
 * the sibling `statsfm_taste.ts` helper also accepts epoch numbers and treats a
 * value below 1e12 as seconds. Both spellings are accepted here for the same
 * reason, because a bucket is a *filter*: a row whose time cannot be read
 * cannot be placed in or out of the window, and dropping it silently would
 * report a wrong count. It is returned as unreadable and counted instead
 * (#803/#804 — a value that could not be read is never a number).
 */
function streamEndTimeMs(stream: J): number | null {
  for (const key of ['endTime', 'playedAt', 'played_at', 'timestamp']) {
    const value = stream?.[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value < 1e12 ? value * 1000 : value;
    }
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

/**
 * A window bucket resolved to concrete UTC edges, plus the echo the caller
 * needs to verify what was applied.
 *
 * `source` records *which* input decided the window, because the precedence
 * rule is the part a caller cannot infer from the result: an explicit
 * `after`/`before` beats `range`, and when both are supplied the bucket is
 * recorded as `explicit` so the payload says the range was not the one used.
 */
type ResolvedWindow = {
  after: number | null;
  before: number | null;
  source: 'range' | 'explicit' | 'unbounded';
  label: string;
};

/**
 * The start of the ISO week (Monday) containing `now`, in UTC.
 *
 * Monday is the ISO-8601 start and matches `libraryanalytics.ts`, which
 * documents the same choice. Sunday-start would put Sunday's streams in the
 * *previous* week, which is the kind of off-by-one that makes an agent report
 * a wrong rotation picture as fact.
 */
function startOfIsoWeekUtc(now: number): number {
  const d = new Date(now);
  const isoDay = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (isoDay - 1));
}

/**
 * Resolve the window a call actually applied.
 *
 * Precedence is explicit bounds over a named bucket, and the order is
 * deliberate: a caller who computed a precise bound has more information than
 * the bucket name carries, so the bucket must not silently narrow or widen it.
 * A bucket alongside one explicit bound still contributes the *other* edge —
 * `range:'week'` with only `before` set is "this week, up to that instant",
 * which is what the caller asked for.
 *
 * `now` is a parameter rather than a `Date.now()` call so the boundaries are
 * testable without freezing the clock.
 */
function resolveStreamWindow(
  range: StatsfmStreamWindow | undefined,
  after: number | undefined,
  before: number | undefined,
  now: number,
): ResolvedWindow {
  const explicitAfter = after ?? null;
  const explicitBefore = before ?? null;
  if (explicitAfter !== null || explicitBefore !== null) {
    // The bucket still fills whichever edge the caller left open: `range` plus
    // only `before` is "this window, up to that instant", and silently dropping
    // the lower edge would widen the read back to the whole history.
    const bucket = explicitAfter === null || explicitBefore === null
      ? resolveStreamWindow(range, undefined, undefined, now)
      : null;
    return {
      after: explicitAfter ?? bucket!.after,
      before: explicitBefore ?? bucket!.before,
      source: 'explicit',
      label: 'explicit after/before',
    };
  }
  if (range === undefined || range === 'lifetime') {
    return { after: null, before: null, source: 'unbounded', label: 'lifetime (no bounds)' };
  }
  const d = new Date(now);
  const edges: Record<Exclude<StatsfmStreamWindow, 'lifetime'>, number> = {
    today: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
    week: startOfIsoWeekUtc(now),
    month: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1),
    year: Date.UTC(d.getUTCFullYear(), 0, 1),
  };
  return {
    after: edges[range],
    // No upper bound: the bucket means "since this instant", and pinning
    // `before` to `now` would make the payload look like a closed interval
    // when the only reason it ends is that the read happened just now.
    before: null,
    source: 'range',
    label: range,
  };
}

/**
 * Apply a resolved window to the rows in hand.
 *
 * Rows whose time cannot be read are **excluded and counted**, never passed
 * through and never dropped in silence: a bucket that quietly discarded
 * unparseable rows would report a smaller, wrong number for the window.
 */
function filterByWindow(
  items: J[],
  window: ResolvedWindow,
): { kept: J[]; unreadable: number; excluded: number } {
  if (window.after === null && window.before === null) {
    return { kept: items, unreadable: 0, excluded: 0 };
  }
  const kept: J[] = [];
  let unreadable = 0;
  let excluded = 0;
  for (const item of items) {
    const at = streamEndTimeMs(item);
    if (at === null) {
      unreadable += 1;
      continue;
    }
    const afterOk = window.after === null || at >= window.after;
    const beforeOk = window.before === null || at < window.before;
    if (afterOk && beforeOk) kept.push(item);
    else excluded += 1;
  }
  return { kept, unreadable, excluded };
}

const limitSchema = (max = 100, def = 10) =>
  z.number().int().min(1).max(max).optional().describe(`1–${max}. Default: ${def}`);
const offsetSchema = () =>
  z.number().int().min(0).optional().describe('Start position (0-based). Default: 0');
const afterSchema = () =>
  z.number().int().nonnegative().optional().describe('Only streams after this Unix-ms timestamp');
const beforeSchema = () =>
  z.number().int().nonnegative().optional().describe('Only streams before this Unix-ms timestamp');

function fmtPlayed(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '0m';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `${h}h ${mins % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function artistNames(trackOrArtists: J): string {
  const artists: J[] = Array.isArray(trackOrArtists?.artists) ? trackOrArtists.artists : [];
  return artists.map((a) => a?.name ?? '?').join(', ') || '?';
}

function indicatorArrow(ind: unknown): string {
  if (ind === 'UP') return '▲';
  if (ind === 'DOWN') return '▼';
  if (ind === 'NEW') return '✚';
  return '•';
}

/**
 * The most rows a *scoped* top route has been observed to return — #1297.
 *
 * Empirical, not documented. stats.fm publishes no maximum for these routes
 * (their own swagger entry lists no parameters at all), and a response landing
 * exactly on this many rows cannot be distinguished from a truncated one by any
 * other signal, because the envelope carries no `total` — the top-level keys
 * are exactly `["items"]` — and every returned row is self-consistent.
 * Treating "at the ceiling" as "cardinality unknown" is the safe direction: if
 * stats.fm raises the cap, the tool under-claims rather than asserting a total
 * it never read.
 */
const SCOPED_TOP_UPSTREAM_CEILING = 100;

/**
 * What a scoped-route response may honestly be reported as, plus the page the
 * caller actually asked for.
 *
 * `total` is `null` when the response sits on the upstream ceiling: the true
 * cardinality is at least `received` but was never read, so it is reported as
 * unknown rather than as the length of whatever happened to come back.
 */
type ScopedTopWindow = {
  items: J[];
  total: number | null;
  received: number;
  note: string | null;
};

/**
 * Cut the requested page out of a scoped-route response (#1297).
 *
 * The three scoped routes — `/users/{id}/top/artists/{artistId}/{tracks,albums}`
 * and `/users/{id}/top/albums/{albumId}/tracks` — ignore `limit` and `offset`.
 * Their swagger entry declares `"parameters": []`, so the bounds were never
 * part of the contract. Live-verified 2026-09-27 against two public profiles:
 * the responses for `limit=1`, `limit=5`, `limit=1000` and `offset=40` are
 * byte-identical to the unbounded read. The four *flat* `/users/{id}/top/{kind}`
 * routes are unaffected and do honour both — which is why this is a per-route
 * fact and not a general one.
 *
 * The branch is decided by what came back rather than by what was asked for, so
 * that a stats.fm which later starts honouring the bounds cannot cause a double
 * slice: a response no larger than the requested `limit` is already the page and
 * is passed through untouched.
 */
function windowScopedTop(rows: J[], limit: number, offset: number): ScopedTopWindow {
  if (rows.length <= limit) {
    return { items: rows, total: rows.length, received: rows.length, note: null };
  }
  const start = Math.max(0, offset);
  const items = rows.slice(start, start + limit);
  if (rows.length >= SCOPED_TOP_UPSTREAM_CEILING) {
    return {
      items,
      total: null,
      received: rows.length,
      note:
        `stats.fm ignores limit/offset on this route and returned its maximum of ${SCOPED_TOP_UPSTREAM_CEILING} rows, `
        + `so the full ranking holds at least ${rows.length} entries and its exact size could not be read. `
        + `Showing rows ${start + 1}–${start + items.length}, windowed here rather than upstream.`,
    };
  }
  // Under the ceiling the response IS the complete ranking, so its length is the
  // real cardinality and may be reported as one.
  return { items, total: rows.length, received: rows.length, note: null };
}

/** MCP tool-result envelope (keeps `{ type: 'text' }` literal for tsc). */
type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};

/** Shared concise/detailed/json envelope for `{ items }` collections. */
function shapeCollection(
  title: string,
  rawItems: J[],
  args: { response_format?: string; max_results?: number; limit?: number; offset?: number },
  line: (item: J, i: number) => string,
  detail?: (item: J) => string | null,
  /**
   * Set by a caller whose upstream ignored `limit`/`offset` (#1297). The rows
   * are already the requested page; `window` carries the true cardinality —
   * `null` when it could not be read — so the header never presents a page as
   * the whole set.
   */
  window?: ScopedTopWindow,
): ToolResult {
  // With a window, the rows in hand are a page, so the honest denominator is
  // the upstream cardinality, not the page length.
  const shown = window ? window.items : rawItems;
  const total = window ? window.total : rawItems.length;
  const cap = resolveMaxResults(args.max_results);
  if (args.response_format === 'json') {
    // #895: json mode shipped `shown` whole while the prose path two lines
    // below capped it, so the two channels of one call disagreed about how
    // many rows there were. The cap is computed once and read by both.
    const capped = capRowSections<Record<string, unknown>>({ items: shown }, STATSFM_ROW_ARRAYS, cap);
    if (window) {
      // The page is not the set, so the section's denominator is the upstream
      // cardinality. Leaving the page length there would make a windowed read
      // claim it returned every row of a ranking it never saw.
      capped.sections.items.total = window.total ?? window.received;
      capped.truncated = capped.sections.items.total > capped.sections.items.returned;
    }
    const rows = capped.items as J[];
    const body = window
      ? { ...capped, pagination: paginationInfo({
          total: window.total,
          offset: args.offset ?? 0,
          limit: args.limit ?? rows.length,
          returned: rows.length,
        }), ...(window.total === null ? { total_unreadable: true, received: window.received } : {}) }
      : capped;
    return emitOnce(body, summarizeStatsfmCollection(title));
  }
  if (shown.length === 0) {
    return { content: [{ type: 'text', text: `${title}: no results.` }] };
  }
  const shaped = truncateItems(shown, cap);
  const detailed = args.response_format === 'detailed';
  // "of 91" when the size is known; "of at least 100 (exact total unread)"
  // when it is not — never a bare page length presented as a whole.
  const denominator = window
    ? window.total !== null
      ? ` of ${window.total}`
      : ` — at least ${window.received}, exact total not readable`
    : ` of ${rawItems.length}`;
  const lines = [`${title} (showing ${shaped.items.length}${denominator}):`];
  shaped.items.forEach((item, i) => {
    // Rows are numbered from the caller's offset, so a paged read reads as the
    // slice of the ranking it is rather than restarting the count at 1.
    lines.push(`  ${(args.offset ?? 0) + i + 1}. ${line(item, i)}`);
    if (detailed && detail) {
      const extra = detail(item);
      if (extra) lines.push(`      ${extra}`);
    }
  });
  if (shaped.footer) lines.push(`(${shaped.footer})`);
  if (window?.note) lines.push(`(${window.note})`);
  const pagination = paginationInfo({
    total: total ?? null,
    offset: args.offset ?? 0,
    limit: args.limit ?? shown.length,
    returned: shown.length,
  });
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: listStructuredContent(shaped.items, pagination, {
      truncated: shaped.truncated,
      remaining: shaped.remaining,
      ...(window && window.total === null ? { total_unreadable: true, received: window.received } : {}),
    }),
  };
}

function topLine(kind: 'track' | 'artist' | 'album' | 'genre'): (item: J) => string {
  return (entry: J) => {
    const pos = typeof entry.position === 'number' ? `#${entry.position} ` : '';
    const streams = typeof entry.streams === 'number' ? ` — ${entry.streams} streams (${fmtPlayed(entry.playedMs)})` : '';
    if (kind === 'track') {
      const t: J = entry.track ?? {};
      return `${pos}"${t.name ?? '?'}" by ${artistNames(t)}${streams}`;
    }
    if (kind === 'artist') return `${pos}${entry.artist?.name ?? '?'}${streams}`;
    if (kind === 'album') {
      const a: J = entry.album ?? {};
      return `${pos}"${a.name ?? '?'}" by ${artistNames(a)}${streams}`;
    }
    return `${pos}${entry.genre ?? entry.name ?? '?'}${streams}`;
  };
}

function topDetail(kind: 'track' | 'artist' | 'album' | 'genre'): (item: J) => string | null {
  return (entry: J) => {
    const obj: J = entry.track ?? entry.artist ?? entry.album ?? {};
    if (kind === 'track') {
      const albumName = Array.isArray(obj.albums) && obj.albums[0]?.name ? `Album: ${obj.albums[0].name}` : null;
      const ids = obj.externalIds?.spotify?.[0] ? `Spotify: ${obj.externalIds.spotify[0]}` : null;
      return [albumName, ids].filter(Boolean).join(' | ') || null;
    }
    if (kind === 'artist') {
      const bits: string[] = [];
      if (Array.isArray(obj.genres) && obj.genres.length > 0) bits.push(`Genres: ${obj.genres.join(', ')}`);
      if (typeof obj.followers === 'number') bits.push(`Followers: ${obj.followers}`);
      return bits.join(' | ') || null;
    }
    if (kind === 'album') {
      const bits: string[] = [];
      if (typeof obj.totalTracks === 'number') bits.push(`${obj.totalTracks} tracks`);
      if (obj.label) bits.push(String(obj.label));
      return bits.join(' | ') || null;
    }
    const preview = Array.isArray(entry.previewArtists)
      ? entry.previewArtists.slice(0, 3).map((p: J) => p?.artist?.name ?? '?').join(', ')
      : null;
    return preview ? `Top artists: ${preview}` : null;
  };
}

function streamLine(s: J): string {
  const when = s.endTime ? new Date(s.endTime).toLocaleString() : 'unknown time';
  return `"${s.trackName ?? '?'}" (${fmtPlayed(s.playedMs)}) — ${when}`;
}

/** The per-entity stats tools all read the same family of endpoints. */
type EntityFilter = 'track' | 'artist' | 'album';

/**
 * The path segment each entity kind uses.
 *
 * Verified live 2026-09-27: the per-entity routes are plural and nested under
 * `/users/{id}/streams/` — `/users/{id}/streams/tracks/{trackId}/stats`.
 * The flat `/users/{id}/streams/{id}` shape reads as the obvious one and
 * 404s, which is how #1006 came to conclude no per-entity total existed.
 */
const ENTITY_SEGMENT: Record<EntityFilter, string> = {
  track: 'tracks',
  artist: 'artists',
  album: 'albums',
};

/**
 * One entity's aggregate, unwrapped from whichever envelope it arrived in.
 *
 * Verified live 2026-09-27: this family answers `{ items: {...} }` for tracks
 * and artists but `{ item: {...} }` for albums, so the envelope is read by
 * what is present. Assuming one shape would read the album payload's missing
 * `count` as a total of nothing.
 */
function entityStatsPayload(body: unknown, path: string): J {
  const object = responseObject(body, path);
  if (Object.prototype.hasOwnProperty.call(object, 'item')) return requiredItem(body, path);
  if (Object.prototype.hasOwnProperty.call(object, 'items')) {
    const stats = object.items;
    if (!stats || typeof stats !== 'object' || Array.isArray(stats)) {
      invalidResponse(path, 'expected items to be an object');
    }
    return stats as J;
  }
  invalidResponse(path, 'expected an item or items object');
}

/**
 * The two totals every per-entity aggregate carries, or a loud failure.
 *
 * `count` and `durationMs` are stats.fm's own figures for the whole entity
 * over the requested window — not a page of the profile's history. A payload
 * that omits either, or carries a non-number for one, is refused rather than
 * read as 0: a total that could not be read must never arrive looking like a
 * measured one (#803, #804).
 */
function entityTotals(
  stats: J,
  path: string,
): { count: number; totalMs: number; cardinality: J | null } {
  if (typeof stats.count !== 'number' || !Number.isInteger(stats.count) || stats.count < 0) {
    invalidResponse(path, 'expected count to be a non-negative integer');
  }
  if (typeof stats.durationMs !== 'number' || !Number.isFinite(stats.durationMs) || stats.durationMs < 0) {
    invalidResponse(path, 'expected durationMs to be a non-negative finite number');
  }
  const card = stats.cardinality;
  if (card !== undefined && (!card || typeof card !== 'object' || Array.isArray(card))) {
    invalidResponse(path, 'expected cardinality to be an object when present');
  }
  return { count: stats.count, totalMs: stats.durationMs, cardinality: (card as J | undefined) ?? null };
}

/** ISO form of a window edge, so the scope reads as a date rather than epoch ms. */
function windowEdge(value: string | undefined): string | null {
  if (value === undefined) return null;
  const ms = Number(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * What the read covered. No window means the entity's whole recorded history,
 * so `lifetime` is the claim the prose and the payload both make.
 */
function entityScope(params: Record<string, string>): { scope: string; lifetime: boolean } {
  const from = windowEdge(params.after);
  const to = windowEdge(params.before);
  if (!from && !to) return { scope: 'lifetime', lifetime: true };
  return {
    scope: `${from ? `after ${from}` : 'start of history'} → ${to ? `before ${to}` : 'now'}`,
    lifetime: false,
  };
}

/** The plays read alongside a total. A sample, never the entity's whole history. */
type EntitySample = {
  streams: J[];
  limit: number;
  returned: number;
  truncated: boolean;
  unreadableReason: string | null;
  oldest: string | null;
  newest: string | null;
};

/**
 * The entity's own stream records, newest first, capped at `limit`.
 *
 * Verified live 2026-09-27: unlike `/users/{id}/streams`, this route IS
 * server-filtered to the entity, honours `limit` and `after`/`before`, and
 * ignores `offset` — so a short sample is the most recent plays, never a
 * page of the profile's mixed history.
 *
 * A failure here is contained rather than fatal. The total is read separately
 * and independently, so losing the sample costs the play list and the span,
 * not the figure. What it must never do is hide a total that was read (#803).
 */
async function readEntitySample(
  client: StatsfmClient,
  path: string,
  params: Record<string, string>,
  limit: number,
): Promise<EntitySample> {
  try {
    const body = await client.get<J>(path, { ...params, limit: String(limit) });
    const streams = collectionItems(body, path);
    const ends = streams.map((s) => s.endTime).filter((t) => typeof t === 'string') as string[];
    return {
      streams,
      limit,
      returned: streams.length,
      truncated: streams.length >= limit,
      unreadableReason: null,
      oldest: ends.length > 0 ? ends.reduce((a, b) => (a < b ? a : b)) : null,
      newest: ends.length > 0 ? ends.reduce((a, b) => (a > b ? a : b)) : null,
    };
  } catch (err) {
    // A 200-status error is this module's own envelope assertion firing, so it
    // means the code is wrong rather than the read having failed; filing it as
    // an upstream problem would bury the defect. Everything else genuinely is
    // an unreadable sample.
    if (err instanceof StatsfmApiError && err.status === 200) throw err;
    return {
      streams: [],
      limit,
      returned: 0,
      truncated: false,
      unreadableReason: unreadableLookupReason(err),
      oldest: null,
      newest: null,
    };
  }
}

/** A real per-entity total, plus whatever sample of the plays could be read. */
type EntityRead = {
  count: number;
  totalMs: number;
  cardinality: J | null;
  scope: string;
  lifetime: boolean;
  sample: EntitySample;
};

/**
 * The entity's stream total, read from stats.fm's own aggregate.
 *
 * #1006 recorded that no per-entity lifetime total was reachable, on the
 * evidence that `/users/{id}/streams` silently drops the entity filter and
 * `offset`. Both hold — and both are irrelevant here, because this reads a
 * different route, one the API documents at
 * `/api/v1/users/{userId}/streams/{tracks|artists|albums}/{entityId}/stats`
 * and answers with the entity's real `count` and `durationMs`. Verified live
 * 2026-09-27 against a 98,101-stream profile: a track the top chart reports
 * 122 lifetime plays returns `count: 162` here (the chart counts the newest
 * window it ranks; this is the whole record), and a track the profile has
 * never played returns `count: 0` — a measured zero, not a failed read.
 */
async function readEntityTotals(
  client: StatsfmClient,
  userId: string,
  filter: EntityFilter,
  entityId: string,
  params: Record<string, string>,
  sampleLimit: number,
): Promise<EntityRead> {
  const base = `/users/${encodeURIComponent(userId)}/streams/${ENTITY_SEGMENT[filter]}/${encodeURIComponent(entityId)}`;
  const statsPath = `${base}/stats`;
  const body = await client.get<J>(statsPath, params);
  const totals = entityTotals(entityStatsPayload(body, statsPath), statsPath);
  const sample = await readEntitySample(client, base, params, sampleLimit);
  return { ...totals, ...entityScope(params), sample };
}

/** Machine-readable payload. `source` says the total is measured, not derived. */
function entityPayload(label: string, read: EntityRead): J {
  return {
    label,
    count: read.count,
    totalMs: read.totalMs,
    // `null`, not 0. A mean over zero plays does not exist, and 0 is a number
    // that reads as "the average play lasted 0 ms" — a measurement of a play
    // that never happened. The prose half of this same read already omits the
    // mean at zero; reporting 0 here would make the payload contradict it.
    avgMs: read.count > 0 ? Math.round(read.totalMs / read.count) : null,
    source: 'stats.fm per-entity aggregate',
    scope: read.scope,
    lifetime: read.lifetime,
    cardinality: read.cardinality,
    sample_limit: read.sample.limit,
    sample_returned: read.sample.returned,
    sample_truncated: read.sample.truncated,
    sample_unreadable_reason: read.sample.unreadableReason,
    sample_oldest: read.sample.oldest,
    sample_newest: read.sample.newest,
  };
}

function formatEntitySummary(label: string, read: EntityRead, filter: EntityFilter): string {
  const { count, totalMs, sample } = read;
  // The mean of zero plays is undefined, so it is not printed: "avg 0m"
  // beside a measured zero would read as a measurement of a play that did
  // not happen.
  const avg = count > 0 ? ` (avg ${fmtPlayed(Math.round(totalMs / count))})` : '';
  const lead = `${label}: ${count} stream${count === 1 ? '' : 's'}, ${fmtPlayed(totalMs)} total${avg}`;
  const origin = read.lifetime
    ? `Lifetime total for this ${filter}, computed by stats.fm.`
    : `Total for the ${read.scope} window, computed by stats.fm for this ${filter}.`;
  if (sample.unreadableReason) {
    return `${lead}\n${origin}\nThe list of individual plays could not be read (${sample.unreadableReason}); the total above is unaffected.`;
  }
  if (sample.returned === 0) return `${lead}\n${origin}`;
  const span = sample.oldest && sample.newest ? ` (sampled span ${sample.oldest} → ${sample.newest})` : '';
  const what = sample.truncated
    ? `Sampled the ${sample.returned} most recent of ${count} plays${span}.`
    : `All ${sample.returned} play${sample.returned === 1 ? '' : 's'}${span}.`;
  return `${lead}\n${origin}\n${what}`;
}

/**
 * Sample rows the per-entity tools show in json mode (#895).
 *
 * Named rather than inlined so the cap and the prose row count are the same
 * number by construction — a literal in one place and not the other is how the
 * payload and the sentence beside it drifted in the first place. A caller that
 * wants the whole sampled page raises `max_results`.
 */
const ENTITY_SAMPLE_ROWS = 10;

/** Shared body of the six per-entity tools, so no one of them can drift. */
async function runEntityStats(
  client: StatsfmClient,
  args: J,
  filter: EntityFilter,
  idField: string,
  defaultLimit: number,
): Promise<ToolResult> {
  const entityId = String(args[idField]);
  const params: Record<string, string> = {};
  if (args.after !== undefined) params.after = String(args.after);
  if (args.before !== undefined) params.before = String(args.before);
  const read = await readEntityTotals(client, resolveStatsfmUserInput(args as J).userId, filter, entityId, params, args.limit ?? defaultLimit);
  const label = `${filter} ${entityId}`;
  const payload = entityPayload(label, read);
  if (args.response_format === 'json') {
    // #895: the whole sampled page (up to 500 streams, ~124 KB measured) used
    // to ship here while the prose path beside it showed ten. The sample rows
    // are the answer, so they are capped like every other collection and the
    // exact count is reported; a caller that wants the page asks for a bigger
    // `max_results` or a narrower range.
    const body = capRowSections(
      { ...payload, streams: read.sample.streams },
      ['streams'],
      resolveMaxResults(args.max_results, ENTITY_SAMPLE_ROWS),
    );
    return emitOnce(body, summarizeStatsfmCollection(label));
  }
  return {
    content: [{ type: 'text', text: formatEntitySummary(label, read, filter) }],
    structuredContent: { ...payload, streams: read.sample.streams.slice(0, ENTITY_SAMPLE_ROWS) },
  };
}

/** Short, non-guessing reason a per-friend stream lookup could not be read. */
function unreadableLookupReason(err: unknown): string {
  if (err instanceof StatsfmApiError) {
    if (err.status === 429) return `rate limited (429, retry after ${err.retryAfterSec ?? 'an unspecified number of'}s)`;
    if (err.status === 403) return 'private or gated profile (403)';
    if (err.status === 404) return 'profile not found (404)';
    if (err.status === 0) return 'stats.fm unreachable';
    return `stats.fm HTTP ${err.status}`;
  }
  return 'lookup failed';
}

/** A friend whose stream total was actually read (0 is a real answer). */
type FriendCount = { friend: J; streams: number };
/** A friend whose stream total is unknown — never coerced to 0 (#803). */
type FriendUnreadable = { friend: J; unreadableReason: string };
type FriendLookup = FriendCount | FriendUnreadable;

function isFriendCount(lookup: FriendLookup): lookup is FriendCount {
  return 'streams' in lookup;
}

export function registerStatsfmTools(server: McpServer, client: StatsfmClient = statsfmClient()): void {
  // 1. statsfm_resolve_user — GET /users/{id}, search fallback on 404.
  server.tool(
    'statsfm_resolve_user',
    'Resolve a stats.fm user id or customId to their profile (falls back to user search)',
    { ...StatsfmUserInputFields, response_format: ResponseFormat },
    async (args) => {
      let body: J | null = null;
      try {
        body = await client.get<J>(`/users/${encodeURIComponent(resolveStatsfmUserInput(args as J).userId)}`);
      } catch (err) {
        if (!(err instanceof StatsfmApiError) || err.status !== 404) throw err;
        const found = await client.get<J>('/search', { query: resolveStatsfmUserInput(args as J).userId, type: 'user', limit: 5 });
        const foundItems = searchItems(found, '/search');
        const users = foundItems.users;
        if (!Array.isArray(users)) invalidResponse('/search', 'expected users to be an array');
        if (users.length === 0) throw err;
        body = { item: users[0], via_search: true };
      }
      const user = requiredItem(body, `/users/${encodeURIComponent(resolveStatsfmUserInput(args as J).userId)}`);
      if (!user) throw new StatsfmApiError(404, 'stats.fm user not found', undefined, 'RESOURCE_NOT_FOUND');
      if (args.response_format === 'json') {
        return { content: [{ type: 'text', text: JSON.stringify(user) }], structuredContent: { ...user } };
      }
      const lines = [
        `${user.displayName ?? user.customId ?? resolveStatsfmUserInput(args as J).userId} (@${user.customId ?? '?'})`,
        `  id: ${user.id ?? '?'} | Plus: ${user.isPlus ? 'yes' : 'no'} | order: ${user.orderBy ?? '?'}`,
      ];
      if (user.timezone) lines.push(`  timezone: ${user.timezone}`);
      return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { ...user } };
    },
  );

  // 2–5. user tops (tracks / artists / albums / genres).
  const topConfigs = [
    { name: 'statsfm_top_tracks', desc: "A stats.fm user's most-streamed tracks", kind: 'track' as const, path: 'tracks' },
    { name: 'statsfm_top_artists', desc: "A stats.fm user's most-streamed artists", kind: 'artist' as const, path: 'artists' },
    { name: 'statsfm_top_albums', desc: "A stats.fm user's most-streamed albums", kind: 'album' as const, path: 'albums' },
    { name: 'statsfm_top_genres', desc: "A stats.fm user's most-streamed genres", kind: 'genre' as const, path: 'genres' },
  ];
  for (const cfg of topConfigs) {
    server.tool(
      cfg.name,
      cfg.desc,
      {
        ...StatsfmUserInputFields,
        range: statsfmRangeSchema,
        limit: limitSchema(),
        offset: offsetSchema(),
        response_format: ResponseFormat,
        max_results: MaxResults,
      },
      async (args) => {
        const body = await client.get<J>(`/users/${encodeURIComponent(resolveStatsfmUserInput(args as J).userId)}/top/${cfg.path}`, {
          range: args.range ?? 'lifetime',
          limit: String(args.limit ?? 10),
          offset: String(args.offset ?? 0),
        });
        const items = collectionItems(body, `/users/${encodeURIComponent(resolveStatsfmUserInput(args as J).userId)}/top/${cfg.path}`);
        return shapeCollection(`Top ${cfg.path}`, items, args, topLine(cfg.kind), topDetail(cfg.kind));
      },
    );
  }

  // 6. statsfm_recent_streams — GET /users/{id}/streams/recent.
  server.tool(
    'statsfm_recent_streams',
    "A stats.fm user's recently played streams, optionally narrowed to a named UTC window (`range`) or explicit Unix-ms bounds",
    {
      ...StatsfmUserInputFields,
      limit: limitSchema(100, 20),
      range: statsfmStreamWindowSchema,
      after: afterSchema(),
      before: beforeSchema(),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const params: Record<string, string> = { limit: String(args.limit ?? 20) };
      if (args.after !== undefined) params.after = String(args.after);
      if (args.before !== undefined) params.before = String(args.before);
      const body = await client.get<J>(`/users/${encodeURIComponent(resolveStatsfmUserInput(args as J).userId)}/streams/recent`, params);
      const items = collectionItems(body, `/users/${encodeURIComponent(resolveStatsfmUserInput(args as J).userId)}/streams/recent`);

      // The window is applied HERE, not upstream. `/streams/recent` ignores
      // `after`/`before` (live-verified 2026-09-27: a bound in the year 2100
      // and one in 2001 both return the unfiltered page), so forwarding the
      // bucket would have returned every row under a header claiming a month.
      // The bounds stay on the wire for forward-compatibility; the local
      // filter is what makes them true today, and applying both is idempotent.
      const window = resolveStreamWindow(args.range, args.after, args.before, Date.now());
      const { kept, unreadable, excluded } = filterByWindow(items, window);

      const timed = items
        .map((s) => streamEndTimeMs(s))
        .filter((t): t is number => t !== null)
        .sort((a, b) => a - b);
      const pageOldest = timed.length > 0 ? new Date(timed[0]).toISOString() : null;
      const pageNewest = timed.length > 0 ? new Date(timed[timed.length - 1]).toISOString() : null;

      // When the page's own span cannot reach back to the requested lower
      // bound, the rows in hand were never a candidate for anything older —
      // so the answer is "every stream in this page falls in the window", and
      // saying so is the difference between a filter and a claim about the
      // window's true contents.
      const pageMayBeShort =
        window.after !== null && pageOldest !== null && Date.parse(pageOldest) > window.after;

      const result = shapeCollection('Recent streams', kept, args, streamLine, (s) =>        s.trackId !== undefined ? `trackId: ${s.trackId} | artists: ${(s.artistIds ?? []).join(', ')}` : null,
      );

      const notes: string[] = [];
      if (pageMayBeShort) {
        notes.push(
          `stats.fm returns a fixed recent page (not paged), which here spans ${pageOldest} to ${pageNewest}. `
          + `That page does not reach back to the requested window start (${new Date(window.after!).toISOString()}), `
          + `so this is every stream in the returned page that falls in the window — not a full count for the window.`,
        );
      }
      if (unreadable > 0) {
        notes.push(
          `${unreadable} row(s) had no readable play time and were excluded from the window rather than counted in it.`,
        );
      }
      if (excluded > 0) notes.push(`${excluded} row(s) fell outside the window and were filtered out.`);

      const rangeResolved = {
        requested: args.range ?? null,
        applied: window.source,
        after: window.after === null ? null : new Date(window.after).toISOString(),
        before: window.before === null ? null : new Date(window.before).toISOString(),
        timezone: 'UTC',
        label: window.label,
      };

      const bodyExtras = {
        range_resolved: rangeResolved,
        returned_before_window: items.length,
        returned_after_window: kept.length,
        excluded_by_window: excluded,
        unreadable_timestamps: unreadable,
        page_oldest: pageOldest,
        page_newest: pageNewest,
        page_may_not_cover_window: pageMayBeShort,
      };

      if (args.response_format === 'json') {
        const payload = { ...(result.structuredContent as Record<string, unknown>), ...bodyExtras };
        return { content: result.content, structuredContent: payload };
      }
      const text = result.content.map((c) => c.text).join('\n');
      const head = `Window: ${window.label} — ${rangeResolved.after ?? 'start of history'} → ${rangeResolved.before ?? 'now'} (UTC), from ${rangeResolved.applied === 'explicit' ? 'explicit after/before' : args.range ?? 'no range'}.`;
      const suffix = notes.length > 0 ? `\n${notes.map((n) => `(${n})`).join('\n')}` : '';
      const shaped = text.endsWith('no results.')
        ? `${text}\n${head}${suffix}`
        : `${text}\n${head}${suffix}`;
      return {
        content: [{ type: 'text' as const, text: shaped }],
        structuredContent: { ...(result.structuredContent as Record<string, unknown>), ...bodyExtras },
      };
    },
  );

  // 7. statsfm_now_playing — GET /users/{id}/streams/current.
  server.tool(
    'statsfm_now_playing',
    "What a stats.fm user is playing right now (null when idle)",
    { ...StatsfmUserInputFields, response_format: ResponseFormat },
    async (args) => {
      const body = await client.get<J>(`/users/${encodeURIComponent(resolveStatsfmUserInput(args as J).userId)}/streams/current`);
      const current = nullableItem(body, `/users/${encodeURIComponent(resolveStatsfmUserInput(args as J).userId)}/streams/current`);
      if (args.response_format === 'json') {
        return {
          content: [{ type: 'text', text: JSON.stringify(current) }],
          structuredContent: { item: current },
        };
      }
      if (!current) {
        return { content: [{ type: 'text', text: 'Nothing playing right now.' }] };
      }
      const when = current.endTime ? new Date(current.endTime).toLocaleString() : 'now';
      return {
        content: [
          {
            type: 'text',
            text: `Now playing: "${current.trackName ?? current.track?.name ?? '?'}" (${fmtPlayed(current.playedMs)}) — ${when}`,
          },
        ],
        structuredContent: { ...current },
      };
    },
  );

  // 8–10. per-entity stream totals (track / artist / album), read from
  // stats.fm's own per-entity aggregate (#1006).
  const entityStats = [
    { name: 'statsfm_track_stats', filter: 'track' as const, idField: 'track_id' },
    { name: 'statsfm_artist_stats', filter: 'artist' as const, idField: 'artist_id' },
    { name: 'statsfm_album_stats', filter: 'album' as const, idField: 'album_id' },
  ];
  for (const cfg of entityStats) {
    server.tool(
      cfg.name,
      `stats.fm's own lifetime stream total for one ${cfg.filter} in a user's history, plus a sample of the individual plays`,
      {
        ...StatsfmUserInputFields,
        [cfg.idField]: z.union([z.string(), z.number()]).describe(`stats.fm ${cfg.filter} id`),
        limit: limitSchema(100, 50),
        response_format: ResponseFormat,
      },
      async (args) => runEntityStats(client, args as J, cfg.filter, cfg.idField, 50),
    );
  }

  // 11. statsfm_search — GET /search.
  server.tool(
    'statsfm_search',
    'Search the stats.fm catalog (tracks, artists, albums, playlists, users)',
    {
      query: z.string().min(1).describe('Search text'),
      type: z
        .string()
        .optional()
        .describe('Comma-separated subset of track,artist,album,playlist,user. Default: track,artist,album'),
      limit: limitSchema(50, 10),
      response_format: ResponseFormat,
    },
    async (args) => {
      const body = await client.get<J>('/search', {
        query: args.query,
        type: args.type ?? 'track,artist,album',
        limit: String(args.limit ?? 10),
      });
      const groups = searchItems(body, '/search');
      if (args.response_format === 'json') {
        return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: { ...(body as J) } };
      }
      const lines = [`Search results for "${args.query}":`];
      let total = 0;
      for (const [group, entries] of Object.entries(groups)) {
        if (!Array.isArray(entries) || entries.length === 0) continue;
        total += entries.length;
        lines.push(`  ${group}:`);
        for (const e of entries.slice(0, args.limit ?? 10)) {
          lines.push(`    • ${e.name ?? e.displayName ?? '?'}${e.id !== undefined ? ` (id: ${e.id})` : ''}`);
        }
      }
      if (total === 0) lines.push('  (no results)');
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: { ...(body as J) },
      };
    },
  );

  // 12. statsfm_recaps — yearly streams/stats window.
  server.tool(
    'statsfm_recaps',
    'Year-in-review recap: stream totals and catalog breadth for one calendar year',
    {
      ...StatsfmUserInputFields,
      year: z.number().int().min(2010).max(2100).optional().describe('Calendar year. Default: current year'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const year = args.year ?? new Date().getUTCFullYear();
      const body = await client.get<J>(`/users/${encodeURIComponent(resolveStatsfmUserInput(args as J).userId)}/streams/stats`, {
        after: String(Date.UTC(year, 0, 1)),
        before: String(Date.UTC(year + 1, 0, 1)),
      });
      const stats = statsPayload(body, `/users/${encodeURIComponent(resolveStatsfmUserInput(args as J).userId)}/streams/stats`);
      if (args.response_format === 'json') {
        return { content: [{ type: 'text', text: JSON.stringify({ year, ...((stats as J) ?? {}) }) }], structuredContent: { year, ...((stats as J) ?? {}) } };
      }
      const s = (stats ?? {}) as J;
      const card = s.cardinality ?? {};
      const lines = [
        `${year} recap: ${s.count ?? 0} streams, ${fmtPlayed(s.durationMs ?? s.playedMs?.sum)} listened`,
        `  ${card.tracks ?? '?'} tracks · ${card.artists ?? '?'} artists · ${card.albums ?? '?'} albums`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { year, ...s } };
    },
  );

  // 13. statsfm_streams_stats — GET /users/{id}/streams/stats.
  server.tool(
    'statsfm_streams_stats',
    'Aggregate listening stats (totals, percentiles, catalog cardinality) for a user, optionally windowed',
    {
      ...StatsfmUserInputFields,
      after: afterSchema(),
      before: beforeSchema(),
      response_format: ResponseFormat,
    },
    async (args) => {
      const params: Record<string, string> = {};
      if (args.after !== undefined) params.after = String(args.after);
      if (args.before !== undefined) params.before = String(args.before);
      const body = await client.get<J>(`/users/${encodeURIComponent(resolveStatsfmUserInput(args as J).userId)}/streams/stats`, params);
      const stats = statsPayload(body, `/users/${encodeURIComponent(resolveStatsfmUserInput(args as J).userId)}/streams/stats`);
      if (args.response_format === 'json') {
        return { content: [{ type: 'text', text: JSON.stringify(stats) }], structuredContent: { ...stats } };
      }
      const card = stats.cardinality ?? {};
      const text = [
        `Listening stats: ${stats.count ?? 0} streams, ${fmtPlayed(stats.durationMs)} listened`,
        `  ${card.tracks ?? '?'} tracks · ${card.artists ?? '?'} artists · ${card.albums ?? '?'} albums`,
      ].join('\n');
      return { content: [{ type: 'text', text }], structuredContent: { ...stats } };
    },
  );

  // 14–16. scoped tops (tracks from artist / albums from artist / tracks from album).
  //
  // These three routes ignore `limit`/`offset` upstream, so the window is
  // applied here and the response is disclosed for what it is (#1297). Both
  // parameters are still sent on the wire: they are inert today, and a
  // stats.fm that starts honouring them must not cause a double slice.
  const scopedTops = [
    { name: 'statsfm_top_tracks_from_artist', desc: "A user's top tracks from one artist", seg: (id: string) => `artists/${encodeURIComponent(id)}/tracks`, label: 'Top tracks from artist' },
    { name: 'statsfm_top_albums_from_artist', desc: "A user's top albums from one artist", seg: (id: string) => `artists/${encodeURIComponent(id)}/albums`, label: 'Top albums from artist' },
    { name: 'statsfm_top_tracks_from_album', desc: "A user's top tracks from one album", seg: (id: string) => `albums/${encodeURIComponent(id)}/tracks`, label: 'Top tracks from album' },
  ];
  for (const cfg of scopedTops) {
    const isAlbum = cfg.name.endsWith('_from_album');
    server.tool(
      cfg.name,
      cfg.desc,
      {
        ...StatsfmUserInputFields,
        [isAlbum ? 'album_id' : 'artist_id']: z.union([z.string(), z.number()]).describe(`stats.fm ${isAlbum ? 'album' : 'artist'} id`),
        range: statsfmRangeSchema,
        limit: limitSchema(100, 10).describe(`1–100. Default: 10. Applied by this server, not by stats.fm — the scoped route ignores it and returns up to ${SCOPED_TOP_UPSTREAM_CEILING} ranked rows (#1297).`),
        offset: offsetSchema().describe('Start position (0-based). Default: 0. Applied by this server, not by stats.fm (#1297).'),
        response_format: ResponseFormat,
        max_results: MaxResults,
      },
      async (args) => {
        const entityId = String((args as J)[isAlbum ? 'album_id' : 'artist_id']);
        // Resolved here rather than cast: this handler reaches the identity
        // through `(args as J)`, so a `as string` compiles cleanly and would
        // have sent the literal "undefined" as a profile name. See
        // `resolveStatsfmUserInput` — the throw is the contract, not the cast.
        const userId = resolveStatsfmUserInput(args as J).userId;
        const path = `/users/${encodeURIComponent(userId)}/top/${cfg.seg(entityId)}`;
        const body = await client.get<J>(path, {
          range: (args as J).range ?? 'lifetime',
          limit: String((args as J).limit ?? 10),
          offset: String((args as J).offset ?? 0),
        });
        const items = collectionItems(body, path);
        const limit = (args as J).limit ?? 10;
        const window = windowScopedTop(items, limit, (args as J).offset ?? 0);
        const kind = cfg.name.includes('_albums_') ? 'album' : 'track';
        return shapeCollection(cfg.label, items, args as J, topLine(kind), topDetail(kind), window);
      },
    );
  }

  // 17–19. catalog singles (track / artist / album).
  const catalog = [
    { name: 'statsfm_catalog_track', desc: 'Look up a track in the stats.fm catalog by id', seg: 'tracks', idField: 'track_id', label: 'track' },
    { name: 'statsfm_catalog_artist', desc: 'Look up an artist in the stats.fm catalog by id', seg: 'artists', idField: 'artist_id', label: 'artist' },
    { name: 'statsfm_catalog_album', desc: 'Look up an album in the stats.fm catalog by id', seg: 'albums', idField: 'album_id', label: 'album' },
  ];
  for (const cfg of catalog) {
    server.tool(
      cfg.name,
      cfg.desc,
      {
        [cfg.idField]: z.union([z.string(), z.number()]).describe(`stats.fm ${cfg.label} id`),
        response_format: ResponseFormat,
      },
      async (args) => {
        const id = String((args as J)[cfg.idField]);
        const body = await client.get<J>(`/${cfg.seg}/${encodeURIComponent(id)}`);
        const item = nullableItem(body, `/${cfg.seg}/${encodeURIComponent(id)}`);
        if (!item) throw new StatsfmApiError(404, `stats.fm ${cfg.label} not found`, undefined, 'RESOURCE_NOT_FOUND');
        if ((args as J).response_format === 'json') {
          return { content: [{ type: 'text', text: JSON.stringify(item) }], structuredContent: { ...item } };
        }
        const lines = [`${item.name ?? id}`];
        if (cfg.label === 'track') lines.push(`  by ${artistNames(item)} | ${fmtPlayed(item.durationMs)}`);
        if (Array.isArray(item.genres) && item.genres.length > 0) lines.push(`  genres: ${item.genres.join(', ')}`);
        if (typeof item.followers === 'number') lines.push(`  followers: ${item.followers}`);
        if (typeof item.totalTracks === 'number') lines.push(`  tracks: ${item.totalTracks}`);
        return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { ...item } };
      },
    );
  }

  // 20. statsfm_genre_artists — GET /genres/{genre}/artists.
  server.tool(
    'statsfm_genre_artists',
    'Artists tagged with a genre in the stats.fm catalog',
    {
      genre: z.string().min(1).describe('Genre tag, e.g. "rock" or "hip-hop/rap"'),
      limit: limitSchema(),
      offset: offsetSchema(),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const body = await client.get<J>(`/genres/${encodeURIComponent(args.genre)}/artists`, {
        limit: String(args.limit ?? 10),
        offset: String(args.offset ?? 0),
      });
      const items = collectionItems(body, `/genres/${encodeURIComponent(args.genre)}/artists`);
      return shapeCollection(`Artists in "${args.genre}"`, items, args, (a) => {
        const genres = Array.isArray(a.genres) && a.genres.length > 0 ? ` [${a.genres.join(', ')}]` : '';
        return `${a.name ?? '?'}${genres}`;
      });
    },
  );

  // 21–23. lifetime charts (track / artist / album) with movement indicators.
  const charts = [
    { name: 'statsfm_charts_tracks', desc: "All-time chart of a user's top tracks with movement indicators", kind: 'track' as const, path: 'tracks' },
    { name: 'statsfm_charts_artists', desc: "All-time chart of a user's top artists with movement indicators", kind: 'artist' as const, path: 'artists' },
    { name: 'statsfm_charts_albums', desc: "All-time chart of a user's top albums with movement indicators", kind: 'album' as const, path: 'albums' },
  ];
  for (const cfg of charts) {
    server.tool(
      cfg.name,
      cfg.desc,
      {
        ...StatsfmUserInputFields,
        limit: limitSchema(100, 20),
        offset: offsetSchema(),
        response_format: ResponseFormat,
        max_results: MaxResults,
      },
      async (args) => {
        const body = await client.get<J>(`/users/${encodeURIComponent(resolveStatsfmUserInput(args as J).userId)}/top/${cfg.path}`, {
          range: 'lifetime',
          limit: String(args.limit ?? 20),
          offset: String(args.offset ?? 0),
        });
        const items = collectionItems(body, `/users/${encodeURIComponent(resolveStatsfmUserInput(args as J).userId)}/top/${cfg.path}`);
        const base = topLine(cfg.kind);
        return shapeCollection(`All-time ${cfg.path} chart`, items, args, (entry) => `${indicatorArrow(entry.indicator)} ${base(entry)}`);
      },
    );
  }

  // 24. statsfm_charts_users — rank a user's friends by stream count.
  server.tool(
    'statsfm_charts_users',
    "Rank a stats.fm user's friends by total stream count (people chart)",
    {
      ...StatsfmUserInputFields,
      limit: limitSchema(25, 10),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const friendsPath = `/users/${encodeURIComponent(resolveStatsfmUserInput(args as J).userId)}/friends`;
      const friendsBody = await client.get<J>(friendsPath, {
        limit: String(args.limit ?? 10),
      });
      const friends = collectionItems(friendsBody, friendsPath);
      // Every friend is a separate lookup, and a private, registration-gated
      // or throttled profile fails only that one request. A failed lookup is
      // "unreadable", never "0 streams" (#803): charting it as zero tells the
      // reader their friend streamed nothing, which is a fabricated answer.
      // Each profile is read exactly once — a throttled friend is reported,
      // never retried into the rate limit.
      const lookups = await Promise.all(
        friends.map(async (f): Promise<FriendCount | FriendUnreadable> => {
          const path = `/users/${encodeURIComponent(String(f.id ?? f.customId))}/streams/stats`;
          try {
            const stats = await client.get<J>(path);
            return { friend: f, streams: Number(statsPayload(stats, path).count ?? 0) || 0 };
          } catch (err) {
            // A malformed payload breaks our response contract rather than
            // hiding a profile, so it still fails loudly instead of being
            // demoted to an unreadable row.
            if (err instanceof StatsfmApiError && err.status === 200) throw err;
            return { friend: f, unreadableReason: unreadableLookupReason(err) };
          }
        }),
      );
      const ranked = lookups.filter(isFriendCount).sort((a, b) => b.streams - a.streams);
      const unreadable = lookups.filter((l): l is FriendUnreadable => !isFriendCount(l));
      const rows = ranked.map((r) => ({
        ...r.friend,
        streams: r.streams,
        display: `${r.friend.displayName ?? r.friend.customId ?? '?'} — ${r.streams} streams`,
      }));
      const unreadableRows = unreadable.map((r) => ({
        ...r.friend,
        streams: null,
        readable: false,
        reason: r.unreadableReason,
        display: `${r.friend.displayName ?? r.friend.customId ?? '?'} — unreadable (${r.unreadableReason})`,
      }));
      if (args.response_format === 'json') {
        // #895: same cap as the prose path below, computed once. `unreadable`
        // is NOT capped — it is a per-friend failure list that the caller must
        // see in full to know whose stream count it is missing, and each row
        // is a short reason rather than a track.
        const payload = capRowSections(
          { items: rows, unreadable: unreadableRows, unreadable_count: unreadableRows.length },
          STATSFM_ROW_ARRAYS,
          resolveMaxResults(args.max_results),
        );
        return emitOnce(payload, summarizeStatsfmCollection('People chart'));
      }
      const shaped = truncateItems(rows, resolveMaxResults(args.max_results));
      const partial = unreadableRows.length > 0
        ? `, ${unreadableRows.length} of ${friends.length} unreadable — partial result`
        : '';
      const lines = [`People chart (friends ranked by streams, showing ${shaped.items.length} of ${rows.length}${partial}):`];
      // Only claim a read failure when one happened: an empty friend list is
      // a complete answer, not a set of unreadable profiles (#803).
      if (unreadableRows.length > 0) lines.push('  (no friend profile could be read)');
      shaped.items.forEach((r, i) => lines.push(`  ${i + 1}. ${r.display}`));
      if (shaped.footer) lines.push(`(${shaped.footer})`);
      if (unreadableRows.length > 0) {
        lines.push(`Unreadable — stream count unknown, not zero (${unreadableRows.length}, excluded from the ranking):`);
        for (const r of unreadableRows) lines.push(`  - ${r.display}`);
      }
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: listStructuredContent(
          shaped.items,
          paginationInfo({ total: rows.length, offset: 0, limit: args.limit ?? 10, returned: rows.length }),
          { truncated: shaped.truncated, remaining: shaped.remaining, unreadable: unreadableRows, unreadable_count: unreadableRows.length },
        ),
      };
    },
  );

  // 25–27. the same per-entity totals, narrowed to an after/before window.
  const dateStats = [
    { name: 'statsfm_track_date_stats', filter: 'track' as const, idField: 'track_id' },
    { name: 'statsfm_artist_date_stats', filter: 'artist' as const, idField: 'artist_id' },
    { name: 'statsfm_album_date_stats', filter: 'album' as const, idField: 'album_id' },
  ];
  for (const cfg of dateStats) {
    server.tool(
      cfg.name,
      `stats.fm's own stream total for one ${cfg.filter} within an after/before window, plus a sample of the individual plays`,
      {
        ...StatsfmUserInputFields,
        [cfg.idField]: z.union([z.string(), z.number()]).describe(`stats.fm ${cfg.filter} id`),
        after: afterSchema(),
        before: beforeSchema(),
        limit: limitSchema(500, 100),
        response_format: ResponseFormat,
      },
      async (args) => runEntityStats(client, args as J, cfg.filter, cfg.idField, 100),
    );
  }

  // 28. statsfm_friends — GET /users/{id}/friends.
  server.tool(
    'statsfm_friends',
    "List a stats.fm user's friends",
    {
      ...StatsfmUserInputFields,
      limit: limitSchema(),
      offset: offsetSchema(),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const body = await client.get<J>(`/users/${encodeURIComponent(resolveStatsfmUserInput(args as J).userId)}/friends`, {
        limit: String(args.limit ?? 10),
        offset: String(args.offset ?? 0),
      });
      const items = collectionItems(body, `/users/${encodeURIComponent(resolveStatsfmUserInput(args as J).userId)}/friends`);
      return shapeCollection('Friends', items, args, (f) => `${f.displayName ?? '?'} (@${f.customId ?? '?'})${f.isPlus ? ' ★' : ''}`);
    },
  );

  // 29. statsfm_friend_count — GET /users/{id}/friends/count.
  server.tool(
    'statsfm_friend_count',
    "How many friends a stats.fm user has",
    { ...StatsfmUserInputFields, response_format: ResponseFormat },
    async (args) => {
      const body = await client.get<J>(`/users/${encodeURIComponent(resolveStatsfmUserInput(args as J).userId)}/friends/count`);
      const countBody = responseObject(body, `/users/${encodeURIComponent(resolveStatsfmUserInput(args as J).userId)}/friends/count`);
      if (!Object.prototype.hasOwnProperty.call(countBody, 'item') || typeof countBody.item !== 'number' || !Number.isFinite(countBody.item)) {
        invalidResponse(`/users/${encodeURIComponent(resolveStatsfmUserInput(args as J).userId)}/friends/count`, 'expected item to be a finite number');
      }
      const count = countBody.item as number;
      if (args.response_format === 'json') {
        return { content: [{ type: 'text', text: JSON.stringify({ count }) }], structuredContent: { count } };
      }
      return { content: [{ type: 'text', text: `Friend count: ${count}` }], structuredContent: { count } };
    },
  );

  // 30. statsfm_records_artists — GET /users/{id}/records/artists.
  server.tool(
    'statsfm_records_artists',
    "Record-holding artists of a stats.fm user (longest streaks, top milestones)",
    {
      ...StatsfmUserInputFields,
      limit: limitSchema(),
      offset: offsetSchema(),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const body = await client.get<J>(`/users/${encodeURIComponent(resolveStatsfmUserInput(args as J).userId)}/records/artists`, {
        limit: String(args.limit ?? 10),
        offset: String(args.offset ?? 0),
      });
      const items = collectionItems(body, `/users/${encodeURIComponent(resolveStatsfmUserInput(args as J).userId)}/records/artists`);
      return shapeCollection('Record artists', items, args, (r) => {
        const name = r.artist?.name ?? r.name ?? '?';
        const extra = r.record ? ` — ${String(r.record)}` : r.streams !== undefined ? ` — ${r.streams} streams` : '';
        return `${name}${extra}`;
      });
    },
  );
}
