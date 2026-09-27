/**
 * freshness radar (#112 idea 2): personal replacement for the removed
 * /browse/new-releases surface. Derives "what's new" from what the user
 * already follows:
 *   albums   — followed artists → newest album page per artist
 *   podcasts — saved shows → newest episode page per show
 *
 * A local watermark file (SPOTIFY_MCP_FRESHNESS_STATE,
 * default ~/.spotify-mcp/freshness.json) supports since='last-check' so
 * agents can ask "everything since I last checked" without tracking dates
 * themselves. The watermark is tracked PER KIND (#724): a single global mark
 * meant an albums-only scan advanced the mark a podcast scan reads, so the
 * podcast scan saw nothing new purely because the album scan ran first. After a
 * successful non-dry run each scanned kind's mark advances to today (UTC) — but
 * only when that kind's scan completed without cap truncation (#239), and never
 * when the caller passed an explicit `since` date, because an explicit window is
 * a question and not a checkpoint.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { SpotifyApiError, quotaPreflight, quotaSnapshot, quotaWindowRemaining, quotaDelta } from '../client.js';
import type {
  FollowedArtistsResponse,
  SavedShowItem,
  SpotifyEpisodeSimple,
} from '../types/spotify.js';
import {
  ResponseFormat,
  MaxResults,
  DryRun,
  resolveMaxResults,
  truncateItems,
  paginationInfo,
  listStructuredContent,
} from '../shaping.js';
import type { ResponseFormatValue, PaginationInfo } from '../shaping.js';
import { getConfig } from '../config.js';
import {
  probeArtistReleases,
  ARTIST_RELEASE_PROBE_LIMIT,
  ARTIST_RELEASE_PROBE_GROUPS,
} from '../artistreleases.js';
import { readOnlyModeEnabled } from './annotations.js';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ownStoreRoots, readLocalFile } from '../paths.js';

// ---------------------------------------------------------------------------
// Date + watermark helpers (pure local I/O; no network)
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * True only for a syntactically well-formed YYYY-MM-DD string that is an
 * actually existing calendar day.
 *
 * `new Date('2026-02-30')` does NOT fail — it silently rolls over to
 * 2026-03-02, and `2026-02-29` in a non-leap year rolls to 2026-03-01. Anything
 * that round-trips a date through `Date` therefore normalises impossible input
 * instead of rejecting it, which is how a caller ends up scanning a window they
 * never asked for. We validate by comparing UTC calendar parts, so no rollover
 * is possible.
 */
function isRealCalendarDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  // Day 0 of month+1 is the last day of `month` in UTC. This never parses the
  // input itself, so an impossible day cannot normalise here.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

/** Explain why a YYYY-MM-DD string is not an existing calendar day. */
function describeImpossibleDate(value: string): string | null {
  if (isRealCalendarDate(value)) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return 'expected the YYYY-MM-DD form';
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return `month ${m[2]} does not exist (expected 01-12)`;
  if (day < 1 || day > 31) return `day ${m[3]} does not exist (expected 01-31)`;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return `${year}-${m[2]} has ${daysInMonth} days`
    + `${leap ? ' (leap year)' : ' (not a leap year)'}, so day ${m[3]} does not exist`;
}

/** Today's date as YYYY-MM-DD in UTC. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** UTC date N days back, YYYY-MM-DD. */
function daysBack(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * Normalize Spotify release-date precision ("2026", "2026-05",
 * "2026-05-17") to a comparable YYYY-MM-DD lower bound. Year/month-only
 * dates pad with 01 so they are treated as their earliest possible day —
 * inclusive when filtering against a cutoff.
 *
 * The result is shape-normalised but NOT calendar-validated: it can still be an
 * impossible day (e.g. a bogus upstream "2026-02-30"). Callers must gate on
 * `isRealCalendarDate` before trusting it as a real day.
 */
function normalizeReleaseDate(raw: string): string {
  if (/^\d{4}$/.test(raw)) return `${raw}-01-01`;
  if (/^\d{4}-\d{2}$/.test(raw)) return `${raw}-01`;
  return raw.slice(0, 10);
}

/**
 * Zod schema for the `since` argument: YYYY-MM-DD or the "last-check"
 * sentinel.
 *
 * The string branch keeps `.regex(ISO_DATE_RE, ...)` so the published MCP
 * schema still carries the `pattern` hint clients read. `superRefine` then adds
 * the check a regex cannot express: the day must actually exist on the
 * calendar, so `since=2026-02-30` / `2026-13-01` / `2026-02-29` are rejected by
 * name rather than silently rolling forward into a different window. Both
 * messages name the `since` field.
 */
const SinceArg = z
  .union([
    z.literal('last-check'),
    z.string().regex(ISO_DATE_RE, 'since: expected YYYY-MM-DD or "last-check"'),
  ])
  .superRefine((value, ctx) => {
    if (value === 'last-check') return;
    // Shape already settled by the branch regex; only the calendar is left.
    if (!ISO_DATE_RE.test(value)) return;
    const why = describeImpossibleDate(value);
    if (why) {
      ctx.addIssue({
        code: 'custom',
        message: `since: "${value}" is not a real calendar date — ${why}. Pick an existing day, or use "last-check".`,
      });
    }
  });

export function watermarkFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.SPOTIFY_MCP_FRESHNESS_STATE ??
    join(homedir(), '.spotify-mcp', 'freshness.json')
  );
}
type FreshnessKind = 'albums' | 'podcasts';

const FRESHNESS_KINDS: readonly FreshnessKind[] = ['albums', 'podcasts'];

/**
 * The on-disk watermark state.
 *
 * `kinds` holds one checkpoint per kind and is the only thing the *scan* logic
 * reads. A kind missing from the map has no checkpoint of its own — the file
 * records what was actually scanned, not what a caller once asked about.
 *
 * `hasKinds` distinguishes a file this code wrote from a pre-#724 flat
 * `{"last_check": "..."}` file. On a flat file the single global mark is used
 * as a shared read fallback for kinds that have no entry of their own, which
 * preserves the position a user had before the upgrade; the mark is never
 * copied into `kinds` for a kind that has not completed a scan, so it cannot
 * mark an unscanned kind as caught up. The first write converts the file to
 * the per-kind shape, after which the fallback is gone and each kind depends
 * only on its own scans.
 *
 * `last_check` is read only on that flat path. On a per-kind file it is a
 * derived compatibility field (the most recent day any kind advanced to) that
 * an older build still reads; a corrupt value there must not fail a call whose
 * cutoff comes from `kinds`, which is why the two are read on separate paths.
 */
interface WatermarkState {
  legacyLastCheck: string | null;
  hasKinds: boolean;
  kinds: Partial<Record<FreshnessKind, string>>;
}

const EMPTY_STATE: WatermarkState = { legacyLastCheck: null, hasKinds: false, kinds: {} };

/** Reject a stored day that is not a real calendar day, naming file and key. */
function storedDate(path: string, key: string, value: string): string {
  const why = describeImpossibleDate(value);
  if (why) {
    throw new Error(
      `Stored watermark in ${path} is not a real calendar date: `
      + `"${value}" at ${key} — ${why}. Fix or delete that file, or pass an explicit since=YYYY-MM-DD.`,
    );
  }
  return value;
}

/**
 * Read the stored watermark state. An absent, unreadable or non-object file is
 * an empty state, not an error — the caller falls back to `days_back`.
 *
 * A hand-edited or corrupted file can hold a day that does not exist
 * ("2026-02-30"). Using it as the cutoff would scan a window the caller never
 * asked for, so such a value is rejected by name rather than coerced.
 */
async function readWatermarkState(): Promise<WatermarkState> {
  const path = watermarkFilePath();
  let parsed: unknown;
  try {
    // #1285's bounded read, re-applied across the #724 rebase. The per-kind
    // restructure replaced the call that #1285 had hardened, so resolving this
    // conflict in favour of #724's structure would otherwise have silently
    // reverted the hardening: `readFile` on a FIFO planted at this path hangs
    // the read forever, and an oversized file gets buffered whole. #1285's
    // comment on the superseded `readWatermark` explains why the regular-file
    // check and the size cap are the parts that earn their keep.
    parsed = JSON.parse(
      await readLocalFile({ roots: ownStoreRoots(path), tool: 'freshness', target: path }),
    );
  } catch {
    return EMPTY_STATE;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return EMPTY_STATE;
  }
  const obj = parsed as Record<string, unknown>;
  const rawKinds = obj.kinds;
  const hasKinds = rawKinds !== null && typeof rawKinds === 'object' && !Array.isArray(rawKinds);
  if (!hasKinds) {
    const legacy = obj.last_check;
    return typeof legacy === 'string'
      ? { legacyLastCheck: storedDate(path, 'last_check', legacy), hasKinds: false, kinds: {} }
      : EMPTY_STATE;
  }
  const source = rawKinds as Record<string, unknown>;
  const kinds: Partial<Record<FreshnessKind, string>> = {};
  for (const kind of FRESHNESS_KINDS) {
    const value = source[kind];
    // A non-string entry is ignored (treated as no checkpoint) rather than
    // fatal, matching how a non-string `last_check` read before #724. Only an
    // impossible *date* is worth stopping for.
    if (typeof value === 'string') kinds[kind] = storedDate(path, `kinds.${kind}`, value);
  }
  return { legacyLastCheck: null, hasKinds: true, kinds };
}

/** The checkpoint a kind reads, or null when it has none. */
function watermarkFor(state: WatermarkState, kind: FreshnessKind): string | null {
  return state.kinds[kind] ?? (state.hasKinds ? null : state.legacyLastCheck);
}

/**
 * Persist the per-kind state, atomically. Temp-file + rename keeps the update
 * crash-safe; the temp file is created 0600 and re-asserted after the write
 * (#1084: a `mode` argument only applies at creation), so the final file is
 * too.
 *
 * The temp name MUST be unique per writer. A fixed `${target}.tmp` is a race
 * between concurrent writers on a shared state path: both create it, the
 * first rename moves it away, and the second fails ENOENT (#1130). That is
 * not only a test-suite problem — two server processes, or a server and a
 * CLI run, share `~/.spotify-mcp/freshness.json` by default. Follows the
 * same idiom as the token sidecar in `auth.ts`.
 *
 * `last_check` is written as the most recent day any kind holds, so a build
 * that predates the per-kind shape still resumes from a real checkpoint. It is
 * never read back for a kind on a per-kind file (see `WatermarkState`).
 *
 * A writer that lost a concurrent read-modify-write drops the *other* kind's
 * freshest mark and keeps the older one, which widens the next window rather
 * than hiding items in it. The losing direction would be the dangerous one,
 * so this is left unguarded.
 */
async function writeWatermarkState(state: WatermarkState): Promise<void> {
  const kinds: Record<string, string> = {};
  let newest: string | null = null;
  for (const kind of FRESHNESS_KINDS) {
    const value = state.kinds[kind];
    if (!value) continue;
    kinds[kind] = value;
    if (newest === null || value > newest) newest = value;
  }
  // Nothing to record: writing here would replace a file that still holds a
  // legacy mark with an empty per-kind one, discarding the user's position.
  if (newest === null) return;
  const target = watermarkFilePath();
  const tmp = `${target}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  // The fixed `<target>.tmp` name is dead now that writers are unique. A
  // pre-fix crash can have stranded one, and the catch below only reclaims
  // temps this call created, so clear the old name here the way auth.ts does.
  await rm(`${target}.tmp`, { force: true }).catch(() => {});
  try {
    await writeFile(tmp, `${JSON.stringify({ last_check: newest, kinds }, null, 2)}\n`, {
      mode: 0o600,
    });
    // #1084: re-assert 0600 after the write — a `mode` argument only applies at
    // creation, and a leftover tmp from a previous run could carry a looser
    // mode that would otherwise ride the rename into the final file.
    await chmod(tmp, 0o600);
    await rename(tmp, target);
  } catch (err) {
    // A unique temp name means a failed write can leave a file nothing else
    // will ever clean up. Do not leave litter in the state directory.
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Page size both listings are walked at. Spotify's own maximum for these two
 * endpoints, so each page is full unless the source itself is nearly exhausted.
 * The cost model below is written in terms of these, not a flat "+1": the walk
 * issues one listing request per page, so a budget larger than a single page
 * costs more than one listing request. (#679)
 */
const FOLLOW_PAGE_SIZE = 50;
const SHOWS_PAGE_SIZE = 50;

/** Rows one album/episode page read returns (Spotify's Feb-2026 cap). */
const ENTITY_PAGE_SIZE = 10;

/**
 * What a cost figure in this tool's output is (#679). The distinction is in the
 * contract, not only the prose: a `budget_bound` is arithmetic over a budget
 * the caller chose, a `measured` figure is a count of requests this call
 * actually issued, and a `measured_lower_bound` is a count that is missing a
 * leg whose page count could not be read. Presenting any of them as a
 * measurement would be the class of lie AGENTS.md §6 is about.
 */
type CostKind = 'budget_bound' | 'measured' | 'measured_lower_bound';

/**
 * The request cost one source's leg is planned to spend, derived from a lookup
 * budget rather than from anything read. `max_requests` assumes the listing
 * hands back full pages — see `assumes_full_pages` on the top-level object,
 * which is what makes that assumption checkable instead of implied.
 */
interface SourceCostPlan {
  /** Rows requested per listing page. */
  listing_page_size: number;
  /** Listing requests the walk needs to enumerate `max_lookups` entities. */
  max_listing_pages: number;
  /** Per-entity page reads, bounded by the call's budget. */
  max_lookups: number;
  max_requests: number;
}

function planSourceCost(listingPageSize: number, lookups: number): SourceCostPlan {
  // `max_listing_pages` is never 0: even a single-entity budget must ask the
  // listing once to find that entity, so `Math.ceil` alone would understate the
  // smallest possible run.
  const maxListingPages = Math.max(1, Math.ceil(lookups / listingPageSize));
  return {
    listing_page_size: listingPageSize,
    max_listing_pages: maxListingPages,
    max_lookups: lookups,
    max_requests: maxListingPages + lookups,
  };
}

/**
 * The whole call's planned cost, for a dry run or a cooldown gate — neither of
 * which has walked anything, so nothing here is measured.
 */
function planCallCost(
  wantAlbums: boolean,
  wantPodcasts: boolean,
  albumLookups: number,
  showLookups: number,
): {
  kind: CostKind;
  measured: false;
  basis: string;
  assumes_full_pages: boolean;
  max_requests: number;
  albums: SourceCostPlan | null;
  podcasts: SourceCostPlan | null;
} {
  const albums = wantAlbums ? planSourceCost(FOLLOW_PAGE_SIZE, albumLookups) : null;
  // The saved-shows listing is bounded by the same budget as the episode reads:
  // the walk can never use more shows than it has episode lookups for, so pages
  // past that point are quota spent on rows the result discards.
  const podcasts = wantPodcasts ? planSourceCost(SHOWS_PAGE_SIZE, showLookups) : null;
  return {
    kind: 'budget_bound',
    measured: false,
    basis:
      'derived from the max_artists budget, not read: the followed-artist and saved-show counts '
      + 'are unknown until the walk runs, so this is what the call COULD spend, not what it did',
    assumes_full_pages: true,
    max_requests: (albums?.max_requests ?? 0) + (podcasts?.max_requests ?? 0),
    albums,
    podcasts,
  };
}

function isQuotaError(err: unknown): { quota: boolean; retryAfter: number | undefined } {
  if (err instanceof SpotifyApiError && err.status === 429 && err.reason === 'QUOTA_EXCEEDED') {
    return { quota: true, retryAfter: err.retryAfterSec };
  }
  // Also handle plain objects thrown by test stubs mimicking the shape.
  if (
    err !== null && typeof err === 'object' &&
    (err as { status?: unknown; reason?: unknown }).status === 429 &&
    (err as { reason?: unknown }).reason === 'QUOTA_EXCEEDED'
  ) {
    const ra = (err as { retryAfterSec?: unknown }).retryAfterSec;
    return { quota: true, retryAfter: typeof ra === 'number' ? ra : undefined };
  }
  return { quota: false, retryAfter: undefined };
}

// ---------------------------------------------------------------------------
// Result shaping (same composition pattern as tools/following.ts)
// ---------------------------------------------------------------------------

type ToolOut = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function shapeResult(
  rf: ResponseFormatValue,
  prose: string,
  payload: Record<string, unknown>,
): ToolOut {
  return {
    content: [{ type: 'text', text: rf === 'json' ? JSON.stringify(payload, null, 2) : prose }],
    structuredContent: payload,
  };
}

interface NewReleaseHit {
  kind: 'album' | 'episode';
  id: string;
  name: string;
  uri: string;
  release_date: string;
  /** Normalized YYYY-MM-DD used for cutoff comparison + sorting. */
  date_key: string;
  album_type?: string;
  artist_names?: string[];
  show_name?: string;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerFreshnessTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'whats_new',
    "Personal new-releases radar: derive what's new from followed artists (new albums/singles) "
      + 'and saved shows (new podcast episodes), replacing the removed browse/new-releases surface. '
      + 'WARNING: the follow list is paged 50 artists per request, so on a COLD read cache the album leg '
      + 'costs ceil(max_artists/50) follow pages PLUS up to max_artists album lookups (#679); a repeat '
      + 'scan inside the cache window re-probes the same canonical request and spends no request (#900). '
      + 'A large library can still exhaust small dev-account quotas in one call. Use max_artists to budget '
      + 'and dry_run to preview the cost before running; dry_run labels its figure a budget bound (it is '
      + 'arithmetic over the budget, not a measurement) and a real call reports the request count it '
      + 'actually issued in `cost`. Decision guide: whats_new for personal follows radar; search_fresh for '
      + 'query-scoped tag:new, search/search_deep for general catalog, search_by_isrc for ISRC-exact.',
    {
      since: SinceArg
        .optional()
        .describe(
          "Only include releases on/after this date (YYYY-MM-DD), or 'last-check' to resume from "
            + "the stored per-kind watermark file (default path ~/.spotify-mcp/freshness.json). "
            + "Tracked per kind, so a call scoped to one kind never moves the other kind's mark. "
            + "An explicit date never writes this file; 'last-check' and a days_back window do.",
        ),
      days_back: z
        .number()
        .int()
        .min(1)
        .max(3650)
        .optional()
        .describe('Look this many days back when `since` is omitted. Default: 30'),
      kinds: z
        .array(z.enum(['albums', 'podcasts']))
        .max(2)
        .optional()
        .describe("Which sources to scan. Default: ['albums','podcasts']"),
      max_artists: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe(
          'Per-call budget for artist album lookups (and show episode lookups). Default: 25 '
            + '(or SPOTIFY_MCP_FRESHNESS_BUDGET). Walk caps at this budget and reports truncation. '
            + 'Independent of SPOTIFY_MCP_FETCH_ALL_CAP. WARNING: each lookup costs a request unless the '
            + 'read cache already holds that artist\'s canonical release probe (#900).',
        ),
      response_format: ResponseFormat,
      max_results: MaxResults,
      dry_run: DryRun,
    },
    async (args) => {
      const rf = args.response_format;
      const gate = quotaPreflight(client);
      if (gate.blocked) {
        // Nothing was walked, so the cost is the same budget bound a dry run
        // reports — including its pager arithmetic. The old `+ 1` counted one
        // follow page for a walk that issues one per 50 artists, which
        // understated every budget above 50 by a whole request per page.
        // (#679)
        const blockedKinds = args.kinds ?? ['albums', 'podcasts'];
        const budget = args.max_artists ?? getConfig().freshnessBudget;
        return shapeResult(rf, gate.message, {
          ok: false,
          cooldown: true,
          wait_sec: gate.waitSec,
          requests_made: 0,
          cost: planCallCost(
            blockedKinds.includes('albums'),
            blockedKinds.includes('podcasts'),
            budget,
            budget,
          ),
          kinds: blockedKinds,
        });
      }
      const snapshot = quotaSnapshot(client);
      const kinds = args.kinds ?? ['albums', 'podcasts'];
      const wantAlbums = kinds.includes('albums');
      const wantPodcasts = kinds.includes('podcasts');
      const freshnessBudget = args.max_artists ?? getConfig().freshnessBudget;

      // ---- Cutoff resolution -------------------------------------------------
      // The watermark is tracked per kind (#724). One global mark meant an
      // albums-only scan advanced the mark a podcasts scan reads, so the
      // podcast scan reported "nothing new" purely because the album scan ran
      // first — no error, and nothing in the payload to say so.
      let state: WatermarkState = EMPTY_STATE;
      let previousWatermark: string | null = null;
      let cutoff: string;
      let cutoffReason: string;
      // Marks resolved for EVERY kind, not just the requested ones, so the
      // prose can name the mark an unscanned kind is holding.
      const marks: Partial<Record<FreshnessKind, string>> = {};
      // An explicit window is a question, not a checkpoint, so it must not move
      // the incremental mark (#724). `since` is validated above, so a non-null
      // value that is not the sentinel is always an explicit YYYY-MM-DD.
      const explicitSince = typeof args.since === 'string' && args.since !== 'last-check';

      if (args.since === 'last-check') {
        state = await readWatermarkState();
        const unmarked: FreshnessKind[] = [];
        for (const kind of FRESHNESS_KINDS) {
          const mark = watermarkFor(state, kind);
          if (mark) marks[kind] = mark;
        }
        for (const kind of kinds) {
          if (!marks[kind]) unmarked.push(kind);
        }
        if (unmarked.length === 0) {
          // The OLDEST requested mark is the safe merged cutoff. Taking the
          // newest would hide everything released since it, for whichever
          // requested kind happens to be furthest behind.
          previousWatermark = kinds.map((k) => marks[k] as string).sort()[0];
          cutoff = previousWatermark;
          cutoffReason =
            `resumed from the stored ${kinds.length > 1 ? 'oldest of the per-kind' : 'per-kind'} `
            + `watermark${kinds.length > 1 ? 's' : ''} for ${kinds.join(', ')}`;
        } else {
          // At least one requested kind has never completed a scan. Falling
          // back to the marks that do exist would hide this kind's items behind
          // a window they were never filtered against, so the whole call goes
          // back to days_back.
          cutoff = daysBack(args.days_back ?? 30);
          cutoffReason =
            `no stored watermark yet for ${unmarked.join(' and ')} — falling back to `
            + `days_back (${args.days_back ?? 30})`;
        }
      } else if (args.since) {
        cutoff = args.since;
        cutoffReason = `explicit since=${cutoff}`;
      } else {
        cutoff = daysBack(args.days_back ?? 30);
        cutoffReason = `days_back (${args.days_back ?? 30}), no since given`;
      }

      // ---- dry_run: describe the plan, make zero API calls -------------------
      if (args.dry_run) {
        const lookupCap = getConfig().fetchAllCap;
        const plan: string[] = [];
        if (wantAlbums) {
          plan.push(`walk GET /me/following?type=artist (cursor-paged, ${FOLLOW_PAGE_SIZE} per page)`);
          plan.push(
            `GET /artists/{id}/albums?include_groups=${ARTIST_RELEASE_PROBE_GROUPS}&limit=${ARTIST_RELEASE_PROBE_LIMIT} (shared canonical probe #900, Feb-2026 cap) for up to ${freshnessBudget} followed artists (budget max_artists=${freshnessBudget}, fetchAllCap=${lookupCap})`,
          );
        }
        if (wantPodcasts) {
          plan.push(`list saved shows via GET /me/shows (${SHOWS_PAGE_SIZE} per page, bounded at max_artists=${freshnessBudget})`);
          plan.push(`GET /shows/{id}/episodes?limit=${ENTITY_PAGE_SIZE} for up to ${freshnessBudget} saved shows (budget max_artists=${freshnessBudget})`);
        }
        plan.push(
          `advance the ${kinds.join(' and ')} watermark${kinds.length > 1 ? 's' : ''} to `
          + `${todayUtc()} (${watermarkFilePath()}) — each kind only, and only if that kind's scan `
          + 'completes without cap truncation or quota hit; otherwise that kind is held. An explicit '
          + 'since date holds every kind.',
        );
        // Cost line required by #242. dry_run makes zero API calls, so nothing
        // here is measured: the figure is arithmetic over the budget, and the
        // walk's own pager is part of it. The old wording charged one follow
        // page no matter how many the walk would issue (#679).
        const cost = planCallCost(wantAlbums, wantPodcasts, freshnessBudget, freshnessBudget);
        const costEstimateParts: string[] = [];
        if (cost.albums) {
          const a = cost.albums;
          costEstimateParts.push(
            `albums: at most ${a.max_lookups} album lookups + at most ${a.max_listing_pages} follow `
            + `page(s) of ${a.listing_page_size} = at most ${a.max_requests} requests for albums`,
          );
        }
        if (cost.podcasts) {
          const p = cost.podcasts;
          costEstimateParts.push(
            `podcasts: at most ${p.max_lookups} episode lookups + at most ${p.max_listing_pages} saved-show `
            + `listing page(s) of ${p.listing_page_size} = at most ${p.max_requests} requests for podcasts`,
          );
        }
        const costEstimate = costEstimateParts.join('; ');
        const prose =
          `[dry run] whats_new preview — no API calls were made and nothing was changed.\n`
          + `Cutoff: releases on/after ${cutoff}\n`
          + `Kinds: ${kinds.join(', ')}\n`
          + `Cost ESTIMATE (a budget bound, not a measurement — budget: max_artists=${freshnessBudget}): `
          + `${costEstimate}; at most ${cost.max_requests} requests if both kinds are walked.\n`
          + `Followed/show counts unknown until executed, so this is what the call could spend, not what `
          + `it will: the bound assumes each listing page comes back full, and a real call reports the `
          + `request count it issued in \`cost\` (kind: measured).\n`
          + 'Planned lookups:\n'
          + plan.map((step) => `  • ${step}`).join('\n');
        return shapeResult(rf, prose, {
          ok: true,
          dry_run: true,
          cutoff,
          cutoff_reason: cutoffReason,
          kinds,
          previous_watermark: previousWatermark,
          // Each kind's current mark, so a caller planning an alternating
          // albums/podcasts schedule can see the two positions differ. Whether
          // a real run would advance is not knowable before the walk, so the
          // plan line states the rule rather than a per-kind verdict here.
          watermarks: Object.fromEntries(
            FRESHNESS_KINDS.map((kind) => [kind, { previous: marks[kind] ?? null }]),
          ),
          cost_estimate: costEstimate,
          cost,
          max_artists: freshnessBudget,
          plan,
        });
      }

      const lookupCap = getConfig().fetchAllCap;
      // Effective per-source caps — budget is independent of fetchAllCap but
      // both apply (the smaller wins). Keeps existing FETCH_ALL_CAP semantics
      // while adding the quota budget. (#904) when the client reports recent
      // spend inside the trailing window, shrink the call's scan budget to the
      // remaining window instead of the module-local constant; with no spend
      // the caps resolve exactly as before.
      const windowRemaining = quotaWindowRemaining(client);
      const freshnessBudgetEff = Math.min(freshnessBudget, windowRemaining);
      const shrinkNote = freshnessBudgetEff < freshnessBudget;
      const artistCap = Math.min(lookupCap, freshnessBudgetEff);
      const showCap = Math.min(lookupCap, freshnessBudgetEff);

      // ---- Albums path: followed artists → newest album page per artist -----
      const albums: NewReleaseHit[] = [];
      // Two counters per source, deliberately not one (#679). A *scan* is one
      // per-entity page actually read — the definition the scan summary has
      // always used, and the one `scanned` publishes. A *request* is issued
      // before the await, so a page that comes back 429 still spent it;
      // counting it after the await is exactly what made a failed request free
      // (the defect #818 fixed in `library_requests`).
      let albumLookups = 0;
      // #900 splits what #679 counts as one album leg: a lookup is now a
      // PROBE of the shared canonical request, and a probe served from the read
      // cache spends no request. So probes, cache hits and real requests are
      // three counters, and the probe total is the same `albumLookups` #679
      // charges before the await — a probe that throws still cost the call.
      let artistProbes = 0;
      let artistProbeCacheHits = 0;
      let artistProbeRequests = 0;
      let artistsSeen = 0;
      let followPages = 0;
      let followTruncatedByCap = false;
      let quotaHit = false;
      let quotaRetryAfter: number | undefined;
      /** Which source's walk hit the wall — the counters alone cannot say. */
      let quotaSource: 'albums' | 'podcasts' | null = null;

      if (wantAlbums) {
        let after: string | null = null;
        walk: for (;;) {
          if (albumLookups >= artistCap) {
            followTruncatedByCap = after !== null;
            break;
          }
          const params: Record<string, string> = { type: 'artist', limit: String(FOLLOW_PAGE_SIZE) };
          if (after) params.after = after;
          let page: FollowedArtistsResponse | null;
          followPages++;
          try {
            page = await client.get<FollowedArtistsResponse>('/me/following', params);
          } catch (err) {
            const q = isQuotaError(err);
            if (q.quota) {
              quotaHit = true;
              quotaRetryAfter = q.retryAfter;
              quotaSource = 'albums';
              break;
            }
            throw err;
          }
          if (!page?.artists || !Array.isArray(page.artists.items)) break;
          for (const artist of page.artists.items) {
            if (albumLookups >= artistCap) {
              followTruncatedByCap = true;
              break walk;
            }
            try {
              // Charged BEFORE the await, not after (#679): a probe that comes
              // back 429 spent the request anyway, and counting only the probes
              // that returned is what made a quota wall read as free.
              albumLookups++;
              // The one canonical artist-release probe (#900). This used to
              // send its own { limit: '10' } with no include_groups, which is
              // a different cache key from every discovery radar's probe — so
              // the same artist cost two requests per scan window. The
              // canonical request also drops appears_on/compilation, whose rows
              // were filling a 10-slot page and pushing genuinely new releases
              // off the end of it.
              const res = await probeArtistReleases(client, artist.id);
              // A probe is not a request: one served from the read cache spent
              // no quota (#900). `albumLookups` above stays the chargeable
              // count #679's cost arithmetic is built on — a cache hit is a
              // probe the call made, and the request breakdown reports the
              // narrower figure separately rather than silently shrinking it.
              artistProbes++;
              if (res.fromCache) artistProbeCacheHits++;
              else artistProbeRequests++;
              artistsSeen++;
              for (const album of res.items) {
                const dateKey = normalizeReleaseDate(album.release_date ?? '');
                // Shape AND calendar: an impossible upstream day ("2026-02-30")
                // is dropped, never rolled into a neighbouring month.
                if (!isRealCalendarDate(dateKey) || dateKey < cutoff) continue;
                albums.push({
                  kind: 'album',
                  id: album.id,
                  name: album.name,
                  uri: album.uri,
                  release_date: album.release_date,
                  date_key: dateKey,
                  album_type: album.album_type,
                  artist_names: (album.artists ?? []).map((a) => a.name),
                });
              }
            } catch (err) {
              const q = isQuotaError(err);
              if (q.quota) {
                quotaHit = true;
                quotaRetryAfter = q.retryAfter;
                quotaSource = 'albums';
                break walk;
              }
              throw err;
            }
          }
          after = page.artists.cursors?.after ?? null;
          if (!after) break;
        }
      }

      // #724: completion is per kind. Captured here, BEFORE the podcast walk,
      // so a quota wall inside the podcast walk cannot retroactively mark the
      // album walk as unfinished (and vice versa).
      const albumsCompleted = wantAlbums && !followTruncatedByCap && !quotaHit;

      // ---- Podcasts path: saved shows → newest episode page per show --------
      const episodes: NewReleaseHit[] = [];
      let showLookups = 0;
      let showsSeen = 0;
      let showsWalked = false;
      /**
       * Pages the saved-shows listing cost. `null` — not 0 — when the listing
       * itself threw: the walk issued at least one request, but the count never
       * came back, so the total request figure degrades to a lower bound that
       * says so. (#679)
       */
      let showListingPages: number | null = null;
      let showListingTruncated = false;
      let showsTruncatedByCap = false;
      // If quota was hit during albums, skip podcast lookups — quota window
      // won't recover within this call; preserve partial album results instead.
      if (wantPodcasts && !quotaHit) {
        showsWalked = true;
        let savedShows: SavedShowItem[];
        try {
          // The truncation verdict, not a bare array (#679). A listing that
          // stopped short of the library is a partial read of the source, and
          // the result is built from whatever it returned — the same class of
          // silent clip #898 documents for set-algebra refs. Bounding the
          // listing at `showCap` (not fetchAllCap) is also the cost fix: the
          // episode loop can never use more shows than it has lookups for, so
          // pages past that point are quota spent on rows the result discards.
          const listing = await client.getAllPagesWithTruncation<SavedShowItem>(
            '/me/shows',
            { limit: String(SHOWS_PAGE_SIZE) },
            { maxItems: showCap },
          );
          savedShows = listing.items;
          showListingPages = listing.pages;
          showListingTruncated = listing.truncated;
        } catch (err) {
          const q = isQuotaError(err);
          if (q.quota) {
            quotaHit = true;
            quotaRetryAfter = q.retryAfter;
            quotaSource = 'podcasts';
            savedShows = [];
          } else {
            throw err;
          }
        }
        if (!quotaHit) {
          for (const entry of savedShows) {
            if (showLookups >= showCap) {
              showsTruncatedByCap = true;
              break;
            }
            try {
              showLookups++;
              const res = await client.get<{ items?: SpotifyEpisodeSimple[] }>(
                `/shows/${encodeURIComponent(entry.show.id)}/episodes`,
                { limit: String(ENTITY_PAGE_SIZE) },
              );
              showsSeen++;
              for (const ep of res?.items ?? []) {
                const dateKey = normalizeReleaseDate(ep.release_date ?? '');
                // Shape AND calendar: an impossible upstream day ("2026-02-30")
                // is dropped, never rolled into a neighbouring month.
                if (!isRealCalendarDate(dateKey) || dateKey < cutoff) continue;
                episodes.push({
                  kind: 'episode',
                  id: ep.id,
                  name: ep.name,
                  uri: ep.uri,
                  release_date: ep.release_date,
                  date_key: dateKey,
                  show_name: entry.show.name,
                });
              }
            } catch (err) {
              const q = isQuotaError(err);
              if (q.quota) {
                quotaHit = true;
                quotaRetryAfter = q.retryAfter;
                quotaSource = 'podcasts';
                break;
              }
              throw err;
            }
          }
        }
      }

      // #724: the podcast walk is complete only if it ran at all. `quotaHit`
      // covers both a wall inside this walk and one in the album walk, which
      // skips this walk entirely (`if (wantPodcasts && !quotaHit)` above) —
      // either way these shows were not read to the end, so the podcast mark
      // must not move. `showListingTruncated` counts too (#1255): a saved-shows
      // listing that stopped short of the library is a partial read of the
      // source, and the episodes of the shows past the cap are absent from the
      // result entirely, so advancing past it would skip them for good.
      const podcastsCompleted = wantPodcasts && !quotaHit && !showsTruncatedByCap && !showListingTruncated;
      // #1255: the podcasts leg is partial if EITHER the saved-shows listing
      // stopped short of the library or the per-show episode loop ran into the
      // lookup cap. Both mean shows past that point contributed no episodes to
      // the result, so the disclosure below has to say the source was cut short.
      const podcastsPartial = showListingTruncated || showsTruncatedByCap;

      // ---- Merge, sort newest-first (name as tiebreaker), truncate ----------
      const merged = [...albums, ...episodes].sort((a, b) =>
        a.date_key === b.date_key ? a.name.localeCompare(b.name) : b.date_key.localeCompare(a.date_key),
      );
      const maxResults = resolveMaxResults(args.max_results, getConfig().maxItems);
      const t = truncateItems(merged, maxResults);
      const pagination = paginationInfo({
        total: merged.length,
        returned: t.items.length,
        limit: maxResults,
      });

      // ---- Watermark handling (#239, per kind as of #724) -------------------
      // A kind advances only if all of the following hold:
      //   1. it was requested and its walk ran to the end — no cap truncation
      //      and no quota wall, because an unreached release must never be
      //      skipped. A saved-shows listing that stopped short of the library
      //      holds the podcasts kind the same way a half-walked follow list
      //      holds the albums one (#679, #1255): the result is built from
      //      whatever the listing returned, so advancing past it would skip the
      //      shows it never read.
      //   2. READONLY is off, so an auto-approved read cannot move local state;
      //   3. the caller did not pass an explicit `since` date, because an
      //      explicit window is a question about the past, not a claim that
      //      everything up to today has been seen (#724).
      // `since: "last-check"` and a plain `days_back` window both still
      // advance: both return everything released since the mark, so the user
      // really has seen the whole window up to today.
      const readOnly = readOnlyModeEnabled();
      const today = todayUtc();
      const heldByScan = (completed: boolean): string | null => {
        if (completed) return null;
        if (quotaHit) {
          return 'quota exceeded mid-walk — partial results returned, watermark held so the next '
            + 'since=last-check retries the unscanned sources';
        }
        return 'scan truncated by cap — watermark held so the next since=last-check does not skip '
          + 'unreached releases; raise max_artists to finish the walk';
      };
      const heldByMode = (): string | null => {
        if (readOnly) {
          return 'READONLY mode is active — watermark held so an auto-approved read cannot change '
            + 'local freshness state';
        }
        if (explicitSince) {
          return `explicit since=${cutoff} — watermark held, because an explicit window is a `
            + 'question about the past and not a claim that everything up to today has been seen';
        }
        return null;
      };

      interface KindWatermark {
        scanned: boolean;
        previous: string | null;
        next: string | null;
        advanced: boolean;
        held_reason: string | null;
      }
      const byKind = {} as Record<FreshnessKind, KindWatermark>;
      const advancedKinds: FreshnessKind[] = [];
      for (const kind of FRESHNESS_KINDS) {
        const requested = kind === 'albums' ? wantAlbums : wantPodcasts;
        const previous = marks[kind] ?? null;
        if (!requested) {
          byKind[kind] = { scanned: false, previous, next: previous, advanced: false, held_reason: null };
          continue;
        }
        const reason = heldByMode() ?? heldByScan(kind === 'albums' ? albumsCompleted : podcastsCompleted);
        if (reason) {
          byKind[kind] = { scanned: false, previous, next: previous, advanced: false, held_reason: reason };
          continue;
        }
        byKind[kind] = { scanned: true, previous, next: today, advanced: true, held_reason: null };
        advancedKinds.push(kind);
      }

      // Only write when a mark actually moved. A held scan leaves the file
      // byte-for-byte alone, so a pre-#724 flat file survives a held call and
      // still supplies the legacy fallback to the next one.
      if (advancedKinds.length > 0) {
        const next: WatermarkState = {
          legacyLastCheck: null,
          hasKinds: true,
          kinds: { ...state.kinds },
        };
        for (const kind of advancedKinds) next.kinds[kind] = today;
        await writeWatermarkState(next);
      }

      const watermarkAdvanced = advancedKinds.length > 0;
      const newWatermark = watermarkAdvanced ? today : null;
      // The one-line summary keeps the pre-#724 wording for the two cases it
      // already covered; per-kind detail is a separate line below.
      const watermarkReason: string | null = watermarkAdvanced
        ? null
        : readOnly
          ? 'READONLY mode is active — watermark held so an auto-approved read cannot change local freshness state'
          : explicitSince
            ? `explicit since=${cutoff} — an explicit window is a question, not a checkpoint, so the watermark was not moved`
            : quotaHit
              ? 'quota exceeded mid-walk — partial results returned, watermark held so the next since=last-check retries the unscanned sources'
              : 'scan truncated by cap — watermark held so the next since=last-check does not skip unreached releases; raise max_artists or use an explicit since date to continue';

      // ---- Per-source scan + cost disclosure (#679) ---------------------------
      // The quota wall can land on either leg, and the walk stops at the first
      // one it hits, so the counters below ARE the counts at the moment of the
      // wall — one set of numbers for both outcomes rather than a snapshot
      // copied into a second variable that can drift. `scanned` is per source
      // because a single total cannot distinguish "podcasts were never walked"
      // from "podcasts were walked and matched nothing"; the old `scanned_artists`
      // read the second case as the first, which is what provoked a pointless
      // immediate retry against an exhausted quota.
      const albumsStoppedBy: 'cap' | 'quota' | null = quotaSource === 'albums'
        ? 'quota'
        : followTruncatedByCap ? 'cap' : null;
      const podcastsStoppedBy: 'cap' | 'quota' | null = quotaSource === 'podcasts'
        ? 'quota'
        : podcastsPartial ? 'cap' : null;
      const sourceScan = (
        source: 'albums' | 'podcasts',
        requested: boolean,
        walked: boolean,
        scannedCount: number,
        lookups: number,
        listingRequests: number | null,
        listingTruncated: boolean,
        stoppedBy: 'cap' | 'quota' | null,
      ) => ({
        source,
        requested,
        walked,
        scanned: scannedCount,
        lookups,
        listing_requests: listingRequests,
        listing_truncated: listingTruncated,
        // A source skipped because the other leg hit the quota wall is not a
        // clean zero: nothing about it was read, so it is not "scanned, found
        // none".
        partial: walked ? stoppedBy !== null : requested,
        stopped_by: stoppedBy,
      });
      const sourceScans = [
        sourceScan('albums', wantAlbums, wantAlbums, artistsSeen, albumLookups, followPages, followTruncatedByCap, albumsStoppedBy),
        sourceScan('podcasts', wantPodcasts, showsWalked, showsSeen, showLookups, showListingPages, showListingTruncated, podcastsStoppedBy),
      ];
      const scanned = {
        artists: artistsSeen,
        shows: showsSeen,
        total: artistsSeen + showsSeen,
        partial: sourceScans.some((s) => s.partial),
        sources: sourceScans,
      };
      // Every request this call issues is one of these four, so the executed
      // cost is a measurement — except when the saved-shows listing threw, which
      // leaves its page count unreadable. That is a lower bound, and it says so
      // rather than reporting 0 pages for a listing that was asked for.
      // A run that never asked for podcasts issued no listing at all, and that
      // zero is a measurement, not an unreadable count — resolving it here keeps
      // an albums-only call out of the degraded lower-bound branch.
      const measuredListingPages = wantPodcasts ? showListingPages : 0;
      const listingUnknown = measuredListingPages === null;
      const measuredBreakdown = {
        follow_pages: followPages,
        album_lookups: albumLookups,
        show_listing_pages: measuredListingPages,
        show_episode_calls: showLookups,
      };
      const knownRequests = followPages + albumLookups + showLookups;
      const measuredRequests = measuredListingPages === null
        ? null
        : knownRequests + measuredListingPages;
      // A listing that threw was asked for at least once, so the floor is not
      // the other legs' total — the thrown request was issued and spent quota
      // even though its count never came back. Reporting `known` here would
      // understate the floor by the one request we can prove happened.
      const requestsFloor = measuredListingPages === null ? knownRequests + 1 : null;
      const cost = {
        kind: listingUnknown ? 'measured_lower_bound' : 'measured',
        measured: true,
        requests: measuredRequests,
        ...(requestsFloor === null
          ? {}
          : {
            requests_floor: requestsFloor,
            requests_note:
              'the saved-shows listing failed, so its page count never came back — at least '
              + `${requestsFloor} request(s) were issued, and this is a floor, not a total`,
          }),
        breakdown: measuredBreakdown,
        // Restated from the effective (possibly shrunk) budget so the caller can
        // calibrate the next call against what this one actually spent.
        planned: planCallCost(wantAlbums, wantPodcasts, artistCap, showCap),
      };

      // ---- Prose rendering ---------------------------------------------------
      const lines: string[] = [`What's new since ${cutoff} (kinds: ${kinds.join(', ')}):`];
      if (t.items.length === 0) {
        lines.push('No new releases found.');
      }
      let currentKind: NewReleaseHit['kind'] | null = null;
      for (const hit of t.items) {
        if (hit.kind !== currentKind) {
          currentKind = hit.kind;
          const count =
            hit.kind === 'album'
              ? albums.filter((a) => a.date_key >= cutoff).length
              : episodes.filter((e) => e.date_key >= cutoff).length;
          lines.push(`${hit.kind === 'album' ? 'Albums' : 'Episodes'} (${count} new):`);
        }
        if (hit.kind === 'album') {
          const artists = hit.artist_names?.length ? hit.artist_names.join(', ') : 'unknown artist';
          lines.push(`  • ${hit.name} — ${artists} | ${hit.release_date} | ${hit.album_type} | URI: ${hit.uri}`);
        } else {
          lines.push(`  • ${hit.name} — ${hit.show_name} | ${hit.release_date} | URI: ${hit.uri}`);
        }
      }
      if (t.footer) lines.push(`(${t.footer})`);

      // Quota notice in prose when hit. Both counters whenever both legs ran,
      // and an explicit "not walked" for a leg the wall cut short — a bare "0
      // shows" reads as "your shows were checked and had nothing new".
      if (quotaHit) {
        const retryMsg = quotaRetryAfter != null ? ` Retry-After: ${quotaRetryAfter}s.` : '';
        const walkedCounts = sourceScans
          .filter((s) => s.walked)
          .map((s) => `${s.scanned} ${s.source === 'albums' ? 'artist' : 'show'}${s.scanned === 1 ? '' : 's'}`);
        const skipped = sourceScans
          .filter((s) => s.requested && !s.walked)
          .map((s) => s.source);
        const countPhrase = walkedCounts.length
          ? walkedCounts.join(' / ')
          : 'no source completed a scan';
        const skipNote = skipped.length
          ? ` (${skipped.join(' and ')} not walked — the quota wall landed during the other leg, so that is a skipped source, not a source that returned nothing)`
          : '';
        lines.push(
          `Quota exceeded mid-walk (QUOTA_EXCEEDED) at the ${quotaSource ?? 'unknown'} leg. `
          + `Partial results: ${albums.length + episodes.length} release(s) from ${countPhrase} scanned${skipNote}.`
          + `${retryMsg} Retry after the quota window resets.`,
        );
      }

      const scanSummary: string[] = [];
      if (wantAlbums) {
        // Probes and requests are different numbers once the read cache is
        // warm: artistwatch_new_additions and the discovery radars probe the
        // same artists through the same canonical request, so a second tool in
        // the same window spends a probe and no request (#900).
        const hitNote = artistProbeCacheHits > 0
          ? `, ${artistProbeRequests} request${artistProbeRequests === 1 ? '' : 's'} (${artistProbeCacheHits} served from the read cache)`
          : '';
        scanSummary.push(
          `${artistsSeen} followed artist${artistsSeen === 1 ? '' : 's'} scanned `
            + `(${albumLookups} album lookup${albumLookups === 1 ? '' : 's'} charged, `
            + `${followPages} follow page${followPages === 1 ? '' : 's'}, cap ${artistCap}`
            + `${followTruncatedByCap ? ', reached' : ', not reached'}${hitNote})`,
        );
      }
      if (wantPodcasts) {
        scanSummary.push(
          showsWalked
            ? `${showsSeen} saved show${showsSeen === 1 ? '' : 's'} scanned `
              + `(${showLookups} episode lookup request${showLookups === 1 ? '' : 's'} issued, `
              + `${showListingPages === null ? 'saved-show listing failed (page count unknown)' : `${showListingPages} listing page${showListingPages === 1 ? '' : 's'}`}, cap ${showCap}`
              + `${showsTruncatedByCap ? ', reached' : ', not reached'}`
              + `${showListingTruncated ? ', listing TRUNCATED — shows beyond the cap were never read' : ''})`
            : 'podcasts NOT walked (the quota wall landed during the albums leg) — 0 shows scanned, which is not a statement about your saved shows',
        );
      }
      lines.push(`Scanned: ${scanSummary.join('; ')}.`);
      if (scanned.partial && !quotaHit) {
        const clipped = sourceScans
          .filter((s) => s.partial && s.walked)
          .map((s) => `${s.source} (${s.stopped_by === 'cap' ? 'stopped at the cap' : 'incomplete'})`);
        if (clipped.length) {
          lines.push(
            `⚠ PARTIAL SCAN: ${clipped.join(', ')} — this result is built from a partial read of that source; `
            + 'a release you follow but that was not reached reads as absent.',
          );
        }
      }
      lines.push(
        `Quota spent by this call: ${requestsFloor === null ? `${measuredRequests} request(s) measured` : `at least ${requestsFloor} request(s) — floor, not a total (see cost.requests_note)`}.`,
      );
      if (shrinkNote) {
        lines.push(`Scan budget shrunk to the remaining quota window (max_artists=${freshnessBudgetEff} of requested ${freshnessBudget}).`);
      }
      if (watermarkAdvanced) {
        lines.push(
          previousWatermark
            ? `Previous watermark: ${previousWatermark}. Watermark advanced to ${newWatermark}.`
            : `No previous watermark. Watermark set to ${newWatermark}.`,
        );
      } else {
        lines.push(
          `Watermark held at ${previousWatermark ?? '(none)'} — ${watermarkReason}`,
        );
        // Always mention that truncated/quota scans did NOT advance
        lines.push(`watermark_advanced: false, watermark_held: true`);
      }
      // Per kind (#724). A one-kind call must say which mark moved and that
      // the other did not, or a caller cannot tell a real "nothing new" from
      // one caused by a sibling kind's scan having moved the shared mark.
      const kindClauses: string[] = [];
      for (const kind of kinds) {
        const w = byKind[kind];
        if (w.advanced) {
          kindClauses.push(
            `${kind} watermark advanced${w.previous ? ` from ${w.previous}` : ''} to ${w.next}`,
          );
        } else if (w.scanned) {
          kindClauses.push(`${kind} watermark held at ${w.next ?? '(none)'}`);
        } else {
          kindClauses.push(
            w.held_reason
              ? `${kind} watermark held at ${w.next ?? w.previous ?? '(none)'} — ${w.held_reason}`
              : `${kind} not scanned this call — its watermark is unchanged at ${w.next ?? w.previous ?? '(none)'}`,
          );
        }
      }
      for (const kind of FRESHNESS_KINDS) {
        if (kinds.includes(kind)) continue;
        const w = byKind[kind];
        kindClauses.push(
          `${kind} not scanned this call — its watermark is unchanged at ${w.next ?? w.previous ?? '(none)'}`,
        );
      }
      lines.push(`Watermark per kind: ${kindClauses.join('; ')}.`);

      const extra: Record<string, unknown> = {
        ok: true,
        cutoff,
        cutoff_reason: cutoffReason,
        kinds,
        previous_watermark: previousWatermark,
        watermark: newWatermark,
        watermark_advanced: watermarkAdvanced,
        watermark_held: !watermarkAdvanced,
        ...(watermarkReason ? { watermark_reason: watermarkReason } : {}),
        // Per-kind detail (#724). The scalar fields above stay as they were so
        // existing readers keep working; `watermarks` is where a caller that
        // cares which mark moved should look.
        watermarks: byKind,
        // Disclose a pre-#724 flat file the first time it is read, so the
        // switch to per-kind marks is visible rather than silent.
        ...(state.legacyLastCheck !== null && !state.hasKinds
          ? { legacy_watermark_migrated_from: state.legacyLastCheck }
          : {}),
        counts: { albums: albums.length, episodes: episodes.length },
        ...quotaDelta(client, snapshot),
        ...(shrinkNote ? { requests_planned: cost.planned.max_requests, budget_shrunk: true } : {}),
        scanned,
        cost,
        lookups: {
          artists_seen: artistsSeen,
          // #679's chargeable count (probes issued, including one that threw)
          // and its paged walk, plus #900's probe/cache split. Both are
          // published because they are different questions: how many artist
          // lookups the budget allowed the call to make, and how many of those
          // actually spent a request.
          artist_album_calls: albumLookups,
          follow_pages: followPages,
          follow_page_size: FOLLOW_PAGE_SIZE,
          artist_probes: artistProbes,
          artist_probe_cache_hits: artistProbeCacheHits,
          artist_probe_requests: artistProbeRequests,
          shows_seen: showsSeen,
          show_episode_calls: showLookups,
          show_listing_pages: showListingPages,
          shows_walked: showsWalked,
          cap: artistCap,
          budget: freshnessBudget,
          fetch_all_cap: lookupCap,
          albums_truncated_by_cap: followTruncatedByCap,
          shows_truncated_by_cap: showsTruncatedByCap,
          shows_listing_truncated: showListingTruncated,
        },
      };
      if (quotaHit) {
        Object.assign(extra, {
          quota_hit: true,
          retry_after: quotaRetryAfter ?? null,
          quota_source: quotaSource,
          // Kept for compatibility, and now meaning exactly what its name says:
          // the ARTIST half of the scan. It is 0 on a podcasts-only quota run
          // because no artist was scanned — `scanned.sources` is where the shows
          // half lives, and `scanned.total` is the whole-scan figure this used
          // to be mistaken for. (#679)
          scanned_artists: artistsSeen,
        });
      }

      return shapeResult(rf, lines.join('\n'), listStructuredContent(t.items, pagination, extra));
    },
  );
}
