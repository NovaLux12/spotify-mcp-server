import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SpotifyApiError, type SpotifyClient } from '../client.js';
import { isGatedError, isRemovedEndpointFailure } from '../gating.js';
import { publisherByline } from '../removed.js';
import type {
  SpotifyTrack,
  SpotifyArtistFull,
  SpotifyArtistAlbumsResponse,
  SpotifyAlbumFull,
  SpotifyTrackSimple,
  SpotifyPaged,
  SpotifyShowFull,
  SpotifyEpisodeSimple,
  SpotifyEpisodeFull,
  SpotifyAlbumItem,
  SpotifyAudiobookSimple,
  SpotifyChapterSimple,
  UserProfile,
} from '../types/spotify.js';

import {
  ResponseFormat,
  sharedListFields,
  resolveMaxResults,
  truncateItems,
  paginationInfo,
  nextPageLine,
  parseSpotifyUri,
  jsonResult,
  renderList,
  renderSingle,
  severalCounts,
  unresolvedIdsNote,
  type ResponseFormatValue,
} from '../shaping.js';
import { chunk, capFor, type ChunkCapKind } from '../chunk.js';
import { recordSearch } from './searchhistory.js';
import { spotifyId, spotifyIdArray, SPOTIFY_SEARCHABLE_KINDS, type SpotifyReferenceKind, type SpotifySearchableKind } from '../refs.js';
import {
  MARKET_CODE,
  getWithMarketFallback,
  resolveRequestMarket,
  resetProfileCountryCache,
  withMarketSource,
  type MarketResolution,
} from '../markets.js';

// Re-exported so every tool module keeps importing MARKET_CODE (and the
// market test hook) from this file.
export { MARKET_CODE, resetProfileCountryCache };


// Rows the show detail card previews. #787 requires the card to say how much
// of the episode list that is.
const EMBEDDED_EPISODE_PREVIEW = 10;
// #1013: Spotify's February 2026 changelog removed GET /browse/categories/{id}
// and GET /browse/categories/{id}/playlists outright and lists no replacement,
// and no surviving endpoint exposes browse categories. A failure from this
// family is a dead endpoint, never a missing category, so it must be reported
// as such instead of as "Category <id> not found" or a category-only result
// that silently drops the playlist page. Same contract as get_available_markets.
// `noun` names what could not be read, so the no-payload case reports the same
// fact as the wire-failure case: nothing was read, so nothing is returned.
function browseCategoryUnavailable(path: string, noun: string, err?: unknown): Error {
  // A gated 403 reaches the tool as the #428 graceful-contract Error, so that
  // text is kept verbatim and the removal is appended to it.
  const detail =
    err === undefined
      ? `the response carried no ${noun} payload, so nothing was read. `
      : err instanceof SpotifyApiError
        ? `Spotify answered ${err.status} — ${err.message} `
        : err instanceof Error
          ? `${err.message} `
          : 'Spotify rejected the request. ';
  return new Error(
    `The browse-category lookup (${path}) could not be answered: ${detail} GET /browse/categories/{id} and ` +
      'GET /browse/categories/{id}/playlists were removed by Spotify’s February 2026 Web API changes and ' +
      'have no replacement endpoint, so the category and its playlists cannot be read; run with credentials ' +
      'from a grandfathered (pre-Nov-2024) app if you need them.',
    err === undefined ? undefined : { cause: err },
  );
}


// show_episode_search (#790): /shows/{id}/episodes serves at most 50 rows per
// page, and a fetch_all walk is bounded by FETCH_ALL_EPISODE_CAP episodes.
const EPISODE_PAGE_MAX = 50;
const FETCH_ALL_EPISODE_CAP = 500;

/**
 * Continuation controls `truncateItems` may name in this tool's footer.
 * `max_results` trims the rendered rows, `offset` starts a later scan window,
 * `limit` is the page size and `fetch_all` widens one page into a walk. The
 * scan cap is not a caller knob, so it is never offered as a remedy.
 */
const PAGE_CAPABILITIES = { maxResults: true, offset: true, limit: true, fetchAll: true } as const;
const SCAN_CAPABILITIES = { maxResults: true, offset: true } as const;

// The market-gated GET (getWithMarketFallback) and its rejection hint now live
// in src/markets.ts (#782). They used to be private to this file and copied
// into audiobooks.ts; two copies left the show/episode walks with no shared
// way in, and a market-gated call site that reached for neither simply sent no
// market.
function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// ------------------------------------------------ get_several_* family (#43)
// Per-request ID caps for GET /<type>?ids=. Inputs larger than the cap are
// chunked into multiple queued calls and merged in request order; items
// Spotify could not resolve come back null, and every requested id is accounted
// for, so an id the batch dropped is named in the tool's own output (#778).
//
// The caps are the shared table in `chunk.ts` (#583): this family used to
// carry a second copy of the same seven numbers, which is how a limit change
// would have had to be made in two places.

export const ARTIST_ALBUM_PAGE_LIMIT = 10;

type SeveralKind = Extract<ChunkCapKind, 'tracks' | 'albums' | 'artists' | 'episodes' | 'shows' | 'audiobooks' | 'chapters'>;

// #789: batch id lists go through the same shared reference grammar as every
// other tool, so a caller can pass bare ids, `spotify:<kind>:` URIs, or
// open.spotify.com URLs interchangeably. `chapters` has no Spotify URI form
// (and no SpotifyReferenceKind), so it keeps plain string ids.
const SEVERAL_REFERENCE_KINDS: Record<SeveralKind, SpotifyReferenceKind | null> = {
  tracks: 'track',
  albums: 'album',
  artists: 'artist',
  episodes: 'episode',
  shows: 'show',
  audiobooks: 'audiobook',
  chapters: null,
};

async function fetchSeveral<T>(
  client: SpotifyClient,
  kind: SeveralKind,
  responseKey: string,
  ids: string[],
): Promise<{
  items: T[];
  missing: string[];
  /**
   * Set on a chunk that fell back to per-item GETs after a gated 403 on the
   * batch endpoint (#725). The reason text is the same one the seven
   * `get_several_*` tools append to their prose and structuredContent.
   */
  degraded?: { reason: string };
}> {
  // #583: the bound comes from the shared table, not a local copy (#778's
  // per-id accounting is preserved by reporting what the batch could not resolve).
  const chunks = chunk(ids, kind);


  // 523: parallelize chunk fetches (was sequential for-loop) — order preserved via Promise.all index
  const __chunkResults = await Promise.all(
    chunks.map(async (chunk) => {
      let res: Partial<Record<string, Array<T | null>>> | null;
      try {
        res = await client.get<Partial<Record<string, Array<T | null>>>>(`/${kind}`, {
          ids: chunk.map((id) => encodeURIComponent(id)).join(','),
        });
      } catch (err) {
        // #725: Spotify's February 2026 Web API changes removed the multi-id
        // batch endpoints for newer app registrations (#638). The graceful
        // 403 wrapper annotates the gated 403 via isGatedError; on a match,
        // fall back to per-item GETs through the client's queue/backoff
        // rather than telling the caller "use the single-item tools
        // instead" — the response IS the single-item tools. A non-gated 403
        // (or any other SpotifyApiError) still surfaces the original shape
        // so callers with their own designed 403 degradation on this path
        // keep matching on `err.status === 403` unchanged.
        if (err instanceof SpotifyApiError && err.status === 403 && isGatedError(err)) {
          const perItem = await Promise.all(
            chunk.map(async (id): Promise<{ id: string; item: T | null }> => {
              try {
                const item = await client.get<T>(`/${kind}/${encodeURIComponent(id)}`);
                return { id, item };
              } catch {
                // Per-item failure (404 / 410 / transient) is recorded as
                // unresolved so the caller sees the same id accounting it
                // would have seen from a successful batch with a null slot
                // (#778). Re-raising would crash a 50-id lookup over a
                // single dead id.
                return { id, item: null };
              }
            }),
          );
          const items: T[] = [];
          const missing: string[] = [];
          for (const { id, item } of perItem) {
            if (item != null) items.push(item);
            else missing.push(id);
          }
          return {
            items,
            missing,
            degraded: { reason: `batch endpoint returned 403; ${chunk.length} ${kind} fetched individually` },
          };
        }
        throw err;
      }
      // #778: the endpoint answers with one slot per requested id, in request
      // order. A null slot — or a slot the response never carried — is an id
      // Spotify did not resolve, so it is reported instead of vanishing: the
      // caller must be able to tell a smaller lookup from a fully-resolved one.
      const slots: Array<T | null> = res?.[responseKey] ?? [];
      const items: T[] = [];
      const missing: string[] = [];
      for (let i = 0; i < Math.max(chunk.length, slots.length); i += 1) {
        const slot = slots[i];
        if (slot != null) {
          items.push(slot);
          continue;
        }
        const id = chunk[i];
        if (id !== undefined) missing.push(id);
      }
      return { items, missing };
    }),
  );
  // #725: any chunk that fell back to per-item lookups marks the whole
  // response degraded. Per-item failures stay inside their chunk so the
  // request-order merge still works.
  const firstDegraded = __chunkResults.find((c) => c.degraded !== undefined)?.degraded;
  return {
    items: __chunkResults.flatMap((chunk) => chunk.items),
    missing: __chunkResults.flatMap((chunk) => chunk.missing),
    ...(firstDegraded !== undefined ? { degraded: firstDegraded } : {}),
  };
}

/**
 * #1004: read artists with per-id `GET /artists/{id}` requests — the only
 * read Spotify still serves for this data.
 *
 * The February 2026 changelog removed "Get Several Artists" (`GET /artists`
 * with `?ids=`) outright and names no replacement, so there is nothing to
 * fall back FROM: trying the batch first and degrading on a 403 only burns a
 * request and, on a registration where the removed route answers 404, looks
 * like a batch of unresolvable ids (#638/#725 graded the batch endpoints as
 * registration-gated; AGENTS.md §2 is explicit that the graceful-403 wrapper
 * does not make a removed endpoint safe). The per-id route is the documented
 * replacement, so this goes straight there.
 *
 * Cost is the trade: one request per distinct id, not one per 50. The fan-out
 * runs at a fixed window width because the client's request queue serialises
 * and rate-limits every call anyway, and a wide `Promise.all` would only
 * enqueue the same work sooner. The width matches the `collab_mix_from_followed`
 * fan-out (`exhaust2_playlists.ts`) so there is one precedent, not two.
 *
 * A per-id failure is recorded with its reason, never swallowed into an empty
 * list: the callers publish `requested == resolved + missing`, so an id that
 * could not be read must be named, not dropped (#1093's accounting rule).
 */
export const ARTIST_FANOUT_WIDTH = 5;

/**
 * #1224: the width every per-id fan-out runs at. One constant because
 * `fetchArtistsPerId` (#1004) and the album/track fan-outs below are the same
 * mechanism, and a second width constant is how they drift apart.
 */
export const PER_ID_FANOUT_WIDTH = ARTIST_FANOUT_WIDTH;

/** An id whose per-id GET could not be read, with why. Never a silent drop. */
export interface PerIdUnresolved {
  id: string;
  reason: string;
  /** HTTP status when Spotify answered, `null` when the transport failed. */
  status: number | null;
  /** Set only on a 429, so the #763 Retry-After degradation stays possible. */
  retry_after_sec?: number | null;
}

/**
 * #1224: the result of a per-id fan-out. `byId` is keyed by the id that was
 * REQUESTED, not by whatever the payload happened to carry, so a caller can
 * map its own request list onto the answer without a second lookup.
 */
export interface PerIdRead<T> {
  byId: Map<string, T>;
  /** Ids that failed, in requested order. Absent from `byId`, named here. */
  unresolved: PerIdUnresolved[];
  /**
   * The first 429 the fan-out hit, if any. `library_hygiene` (#763 point 4)
   * degrades a rate-limited album pass into a partial with Retry-After
   * messaging; carrying the first throttle here is what lets the per-id path
   * keep that behaviour instead of rethrowing it.
   */
  throttled: { message: string; retry_after_sec: number | null } | null;
  /** `GET /{kind}/{id}` requests issued, counted before the response cache. */
  requests: number;
}

/** The batch types the February 2026 removal took `?ids=` away from. */
export type PerIdKind = 'artists' | 'albums' | 'tracks';

/**
 * #1224: read `kind` objects with per-id `GET /{kind}/{id}` requests.
 *
 * #1004 established the shape for artists and this generalises it to albums
 * and tracks, the other two `?ids=` call sites that had no per-id fallback.
 * The reasoning is the same and worth restating once: the February 2026
 * changelog removed these batch routes, so whether one answers at all depends
 * on the app registration — `src/gating.ts` grades them as registration-gated
 * precisely because a code path cannot know which registration it is talking
 * to. Trying the batch first and degrading on a 403 would still be the
 * graceful behaviour for the seven `get_several_*` tools (which keep it,
 * because those endpoints were graded gated, not removed), but it burns a
 * request and turns a 404 registration into a silent list of unresolvable ids.
 * The per-id route is the documented replacement, so the read goes straight
 * there.
 *
 * Cost is the trade: one request per distinct id, not one per 50. The fan-out
 * is windowed because the client's queue serialises and rate-limits every
 * call anyway, and an unbounded `Promise.all` over N ids would only enqueue
 * the same work sooner — a self-inflicted 429 on the very path being fixed.
 *
 * A per-id failure is recorded with its reason and never coerced into an empty
 * result: the callers publish `requested == resolved + missing`, and an id
 * that could not be read has to be named, not dropped (#803/#1093).
 */
export async function fetchCatalogPerId<T extends { id?: string | null }>(
  client: SpotifyClient,
  kind: PerIdKind,
  ids: readonly string[],
  opts: { width?: number; params?: Record<string, string> } = {},
): Promise<PerIdRead<T>> {
  // De-dupe first: a track's album often lists the same artist twice, and the
  // census unions three windows, so the raw list over-counts by a lot.
  const wanted: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    wanted.push(id);
  }
  const width = Math.max(1, opts.width ?? PER_ID_FANOUT_WIDTH);
  const byId = new Map<string, T>();
  const unresolved: PerIdUnresolved[] = [];
  let requests = 0;
  let throttled: PerIdRead<T>['throttled'] = null;
  for (let i = 0; i < wanted.length; i += width) {
    const window = wanted.slice(i, i + width);
    const settled = await Promise.allSettled(
      window.map(async (id) => {
        requests += 1;
        try {
          const item = await client.get<T>(`/${kind}/${encodeURIComponent(id)}`, opts.params ?? {});
          return { id, item, error: undefined as unknown };
        } catch (error) {
          return { id, item: null as T | null, error };
        }
      }),
    );
    for (let w = 0; w < settled.length; w += 1) {
      const outcome = settled[w];
      const id = window[w];
      if (outcome.status === 'rejected') {
        // The window itself rejected rather than one of its entries, which
        // the per-entry try/catch should have prevented. Reported rather than
        // dropped: a silently shortened roster is the #1093 failure mode.
        unresolved.push(failureEntry(id, outcome.reason));
        continue;
      }
      const { item, error } = outcome.value;
      if (error !== undefined) {
        const entry = failureEntry(id, error);
        unresolved.push(entry);
        // #763 point 4: the first 429 is carried out so the caller can degrade
        // with Retry-After messaging instead of the whole pass throwing.
        if (entry.status === 429 && throttled === null) {
          throttled = { message: entry.reason, retry_after_sec: entry.retry_after_sec ?? null };
        }
        continue;
      }
      // A 200 that carries no id, or a different id than was asked for, is an
      // unread, not the object. Keying the map on the requested id would hand
      // the caller a value the payload never confirmed (#804's rule, one field
      // over: never guess a field that could contradict the wire).
      if (item == null || item.id == null) {
        unresolved.push({ id, reason: `Spotify returned no ${singular(kind)} for this id`, status: null });
        continue;
      }
      if (item.id !== id) {
        unresolved.push({ id, reason: `Spotify returned a different ${singular(kind)} (${item.id}) for the requested id`, status: null });
        continue;
      }
      byId.set(id, item);
    }
  }
  return { byId, unresolved, throttled, requests };
}

/** #1224: a failure entry carries the status, and Retry-After on a 429. */
function failureEntry(id: string, error: unknown): PerIdUnresolved {
  const status = error instanceof SpotifyApiError ? error.status : null;
  return {
    id,
    reason: describeFailure(error, 'request failed'),
    status,
    ...(status === 429
      ? { retry_after_sec: error instanceof SpotifyApiError ? error.retryAfterSec ?? null : null }
      : {}),
  };
}

/** #1224: singular label for the fan-out's "Spotify returned no …" reason. */
function singular(kind: PerIdKind): string {
  return kind === 'artists' ? 'artist' : kind === 'albums' ? 'album' : 'track';
}

/**
 * #1004's artist read kept its own named shape so its three callers keep the
 * contract they were written against. `throttled` is optional here: only
 * `library_hygiene` degrades on a 429, and the artist callers do not read it.
 */
export interface PerIdArtistRead {
  byId: Map<string, SpotifyArtistFull>;
  unresolved: PerIdUnresolved[];
  throttled?: { message: string; retry_after_sec: number | null } | null;
  requests: number;
}

/**
 * #1004's artist read, kept as the named entry point its three callers use.
 * The implementation is `fetchCatalogPerId`'s — the artist route was the
 * first of this family migrated, and leaving a private second copy of the
 * fan-out in place is how the width and the failure reporting drift.
 */
export function fetchArtistsPerId(
  client: SpotifyClient,
  ids: readonly string[],
  opts: { width?: number } = {},
): Promise<PerIdArtistRead> {
  return fetchCatalogPerId<SpotifyArtistFull>(client, 'artists', ids, opts);
}

/** #1224: per-id `GET /albums/{id}` — the ungated replacement for `?ids=`. */
export function fetchAlbumsPerId<T extends { id?: string | null }>(
  client: SpotifyClient,
  ids: readonly string[],
  opts: { width?: number; params?: Record<string, string> } = {},
): Promise<PerIdRead<T>> {
  return fetchCatalogPerId<T>(client, 'albums', ids, opts);
}

/** #1224: per-id `GET /tracks/{id}` — the ungated replacement for `?ids=`. */
export function fetchTracksPerId<T extends { id?: string | null }>(
  client: SpotifyClient,
  ids: readonly string[],
  opts: { width?: number; params?: Record<string, string> } = {},
): Promise<PerIdRead<T>> {
  return fetchCatalogPerId<T>(client, 'tracks', ids, opts);
}

/** #1004: an unreadable per-id failure is reported with its reason, never dropped. */
function describeFailure(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim() !== '') return err.message;
  if (typeof err === 'string' && err.trim() !== '') return err;
  return fallback;
}

/** #778: a fully-unresolved batch must still name what it could not resolve. */
function noMatchingSeveral(kind: SeveralKind, missing: readonly string[]): string {
  const note = unresolvedIdsNote(missing);
  return note ? `No matching ${kind} found (${note})` : `No matching ${kind} found`;
}

function severalIdsSchema(kind: SeveralKind) {
  const max = capFor(kind);
  const referenceKind = SEVERAL_REFERENCE_KINDS[kind];
  // spotifyIdArray already returns a ZodArray, so the element list is chosen
  // here — wrapping either branch in z.array() would nest ids one level deep.
  const element = referenceKind ? spotifyIdArray(referenceKind) : z.array(z.string().min(1));
  return element.min(1).describe(
    referenceKind
      ? `Spotify ${referenceKind} IDs, spotify:${referenceKind}: URIs, or open.spotify.com/${referenceKind} URLs (1–${max} per request; longer lists are fetched in chunks of ${max} and merged)`
      : `Spotify ${kind} IDs (1–${max} per request; longer lists are fetched in chunks of ${max} and merged)`,
  );
}

/**
 * #725: the structuredContent fields a degraded batch lookup publishes when
 * it falls back to per-item GETs. Spreading the empty object keeps the json
 * path's shape identical when no fallback happened — the key only appears
 * when `degraded` is set, so a non-degraded response doesn't advertise it.
 */
function severalDegradedExtra(degraded: { reason: string } | undefined): Record<string, unknown> {
  if (!degraded) return {};
  return { degraded: true, degraded_reason: degraded.reason };
}

function joinArtists(items: { artists?: { name: string }[] }): string {
  return (items.artists ?? []).map((a) => a.name).join(', ');
}


export function registerCatalogTools(server: McpServer, client: SpotifyClient): void {
  // get_track
  server.tool(
    'get_track',
    'Get full details for a track by ID',
    { id: spotifyId('track'), response_format: ResponseFormat },
    async (args) => {
      const track = await client.get<SpotifyTrack>(`/tracks/${encodeURIComponent(args.id)}`);
      if (!track) throw new Error(`Track "${args.id}" not found`);

      const artists = track.artists.map((a) => a.name).join(', ');
      const lines = [
        `"${track.name}" by ${artists}`,
        `Album: ${track.album.name}`,
        `Duration: ${formatDuration(track.duration_ms)}`,
        `Explicit: ${track.explicit ? 'yes' : 'no'}`,
        `URI: ${track.uri}`,
      ];
      return renderSingle(args.response_format, track as unknown as Record<string, unknown>, lines, [
        ['album.release_date', 'Released'],
        ['popularity', 'Popularity'],
        ['external_ids.isrc', 'ISRC'],
        ['album.id', 'Album ID'],
      ]);
    },
  );

  // get_artist
  server.tool(
    'get_artist',
    'Get artist info by ID',
    { id: spotifyId('artist'), response_format: ResponseFormat },
    async (args) => {
      const artist = await client.get<SpotifyArtistFull>(`/artists/${encodeURIComponent(args.id)}`);
      if (!artist) throw new Error(`Artist "${args.id}" not found`);

      const genres =
        Array.isArray(artist.genres) && artist.genres.length > 0
          ? artist.genres.join(', ')
          : 'none listed';
      const lines = [
        `Artist: ${artist.name}`,
        `Genres: ${genres}`,
        `URI: ${artist.uri}`,
      ];
      return renderSingle(args.response_format, artist as unknown as Record<string, unknown>, lines, [
        ['followers.total', 'Followers'],
        ['popularity', 'Popularity'],
      ]);
    },
  );

  // get_artist_albums
  server.tool(
    'get_artist_albums',
    "List an artist's albums and singles",
    {
      id: spotifyId('artist'),
      include_groups: z
        .array(z.enum(['album', 'single', 'appears_on', 'compilation']))
        .optional()
        .describe('Album types to include. Default: ["album","single"]'),
      // Feb-2026: /artists/{id}/albums hard-caps limit at 10 (400 above).
      limit: z
        .number()
        .int()
        .min(1)
        .max(ARTIST_ALBUM_PAGE_LIMIT)
        .optional()
        .describe('Results per page, 1–10. Default: 10'),
      offset: z.number().int().min(0).optional().describe('Album offset. Default: 0'),
      market: MARKET_CODE.optional().describe('ISO country code; defaults to SPOTIFY_MCP_MARKET.'),
      fetch_all: z.boolean().optional().describe('Fetch all pages up to cap. Default: false'),
      ...sharedListFields,
    },
    async (args) => {
      // 523: fetch_all walks all pages via getAllPages
      // #595: one resolution, shared by both branches. The fetch_all path
      // used to forward only an explicit market, so a configured default
      // reached the paged branch and silently missed the walk.
      const market = await resolveRequestMarket(client, args.market);
      let result: SpotifyArtistAlbumsResponse | null;
      if ((args as unknown as { fetch_all?: boolean }).fetch_all) {
        const items = await client.getAllPages<SpotifyArtistAlbumsResponse['items'][number]>(
          `/artists/${encodeURIComponent(args.id)}/albums`,
          {
            include_groups: (args.include_groups ?? ['album', 'single']).join(','),
            limit: String(ARTIST_ALBUM_PAGE_LIMIT),
            ...(market.market ? { market: market.market } : {}),
          },
          { maxItems: args.max_results },
        );
        result = { items, total: items.length, limit: items.length, offset: 0, href: '', previous: null, next: null } as unknown as SpotifyArtistAlbumsResponse;
      } else {
        result = (await getWithMarketFallback<SpotifyArtistAlbumsResponse>(
          client,
          `/artists/${encodeURIComponent(args.id)}/albums`,
          args.market,
          {
            include_groups: (args.include_groups ?? ['album', 'single']).join(','),
            limit: String(Math.min(args.limit ?? ARTIST_ALBUM_PAGE_LIMIT, ARTIST_ALBUM_PAGE_LIMIT)),
            offset: String(args.offset ?? 0),
          },
        )).data;
      }
      if (!result) throw new Error(`Artist "${args.id}" not found`);

      if (args.response_format === 'json') {
        return jsonResult(result as unknown as Record<string, unknown>);
      }
      return withMarketSource(
        renderList(args.response_format, result.items, {
          header: `Albums for artist (${result.total} total):`,
          line: (album) => {
            const artists = album.artists.map((a) => a.name).join(', ');
            return `  • "${album.name}" by ${artists} (${album.album_type}, ${album.release_date}, ${album.total_tracks} tracks) | URI: ${album.uri}`;
          },
          total: result.total,
          offset: args.offset,
          limit: Math.min(args.limit ?? ARTIST_ALBUM_PAGE_LIMIT, ARTIST_ALBUM_PAGE_LIMIT),
          maxResults: args.max_results,
        }),
        market,
      );
    },
  );

  // get_album
  server.tool(
    'get_album',
    'Get album details and track list by ID',
    {
      id: spotifyId('album'),
      market: MARKET_CODE.optional().describe(
        'ISO country code; defaults to SPOTIFY_MCP_MARKET.',
      ),
      ...sharedListFields,
    },
    async (args) => {
      const { data: album, market } = await getWithMarketFallback<SpotifyAlbumFull>(
        client,
        `/albums/${encodeURIComponent(args.id)}`,
        args.market,
      );
      if (!album) throw new Error(`Album "${args.id}" not found`);


      if (args.response_format === 'json') {
        return withMarketSource(jsonResult(album as unknown as Record<string, unknown>), market);
      }
      const artists = album.artists.map((a) => a.name).join(', ');
      const lines = [
        `"${album.name}" by ${artists}`,
        `Released: ${album.release_date} | ${album.total_tracks} tracks`,
        `URI: ${album.uri}`,
        '',
        'Tracks:',
      ];
      for (const track of album.tracks.items) {
        const trackArtists = track.artists.map((a) => a.name).join(', ');
        lines.push(
          `  ${track.track_number}. "${track.name}" by ${trackArtists} (${formatDuration(track.duration_ms)}) | URI: ${track.uri}`,
        );
      }
      return withMarketSource(
        renderSingle(args.response_format, album as unknown as Record<string, unknown>, lines, [
          ['label', 'Label'],
          ['popularity', 'Popularity'],
          ['genres', 'Genres'],
          ['copyrights', 'Copyright'],
        ]),
        market,
      );
    },
  );

  // get_album_tracks
  server.tool(
    'get_album_tracks',
    'List the tracks of an album with pagination',
    {
      id: spotifyId('album'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Results per page, 1–50. Default: 20'),
      offset: z.number().int().min(0).optional().describe('Index of the first track to return. Default: 0'),
      market: MARKET_CODE.optional().describe(
        'ISO 3166-1 alpha-2 country code. Defaults to SPOTIFY_MCP_MARKET; affects track availability.',
      ),
      fetch_all: z.boolean().optional().describe('When true, walk all pages via getAllPages up to cap (fetch_all_cap) — use for "all" queries. Default: false'),
      ...sharedListFields,
    },
    async (args) => {
      // #595: the fetch_all walk shares the one resolved market, so a
      // configured default reaches it instead of only the paged branch.
      const market = await resolveRequestMarket(client, args.market);
      let result: SpotifyPaged<SpotifyTrackSimple> | null;
      if ((args as unknown as { fetch_all?: boolean }).fetch_all) {
        const items = await client.getAllPages<SpotifyTrackSimple>(
          `/albums/${encodeURIComponent(args.id)}/tracks`,
          market.market ? { market: market.market } : undefined,
          { maxItems: args.max_results }
        );
        result = { items, total: items.length, limit: items.length, offset: 0, next: null } as SpotifyPaged<SpotifyTrackSimple>;
      } else {
        result = (await getWithMarketFallback<SpotifyPaged<SpotifyTrackSimple>>(
          client,
          `/albums/${encodeURIComponent(args.id)}/tracks`,
          args.market,
          {
            limit: String(args.limit ?? 20),
            offset: String(args.offset ?? 0),
          },
        )).data;
      }
      if (!result) throw new Error(`Album "${args.id}" not found`);

      if (args.response_format === 'json') {
        return withMarketSource(jsonResult(result as unknown as Record<string, unknown>), market);
      }
      return withMarketSource(
        renderList(args.response_format, result.items, {
          header: `Tracks for album (${result.total} total):`,
          line: (track) => {
            const trackArtists = track.artists.map((a) => a.name).join(', ');
            return `  ${track.track_number}. "${track.name}" by ${trackArtists} (${formatDuration(track.duration_ms)}) | URI: ${track.uri}`;
          },
          total: result.total,
          offset: args.offset,
          limit: args.limit ?? 20,
          maxResults: args.max_results,
        }),
        market,
      );
    },
  );

  // get_show
  server.tool(
    'get_show',
    'Get full details for a podcast show',
    {
      id: spotifyId('show'),
      market: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 country code'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const { data: show, market } = await getWithMarketFallback<SpotifyShowFull>(
        client,
        `/shows/${encodeURIComponent(args.id)}`,
        args.market,
      );
      if (!show) throw new Error(`Show "${args.id}" not found`);

      const lines = [
        // #639: `publisher` was removed from Show payloads in Feb 2026. When it
        // is absent the byline is dropped rather than filled with a stand-in
        // that reads like a publisher named "unknown publisher".
        `"${show.name}"${publisherByline(show.publisher)}`,
        show.description,
        `Episodes: ${show.total_episodes} | Explicit: ${show.explicit ? 'yes' : 'no'}`,
        `Languages: ${show.languages.join(', ')} | Media type: ${show.media_type}`,
        `URI: ${show.uri}`,
      ];

      // #787: the embedded episode array is a fixed ten-row preview, not the
      // show's episode list. Without a count the card reads as complete, so
      // state how much of the show it stands for.
      if (show.episodes?.items.length) {
        lines.push('', 'Recent episodes:');
        const shown = show.episodes.items.slice(0, EMBEDDED_EPISODE_PREVIEW);
        for (const ep of shown) {
          const played = ep.resume_point?.fully_played ? ' [played]' : '';
          lines.push(
            `  • "${ep.name}" (${formatDuration(ep.duration_ms)}, ${ep.release_date})${played} | URI: ${ep.uri}`,
          );
        }
        const declared = typeof show.total_episodes === 'number' ? show.total_episodes : 0;
        const episodeTotal = Math.max(declared, show.episodes.items.length);
        if (episodeTotal > shown.length) {
          lines.push(
            `  (${shown.length} of ${episodeTotal} episodes shown — use list_show_episodes to page the rest)`,
          );
        }
      }

      return withMarketSource(renderSingle(args.response_format, show as unknown as Record<string, unknown>, lines), market);
    },
  );


  // get_episode
  server.tool(
    'get_episode',
    'Get full details for a podcast episode',
    {
      id: spotifyId('episode'),
      market: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 country code, e.g. \'US\''),
      response_format: ResponseFormat,
    },
    async (args) => {
      const { data: episode, market } = await getWithMarketFallback<SpotifyEpisodeFull>(
        client,
        `/episodes/${encodeURIComponent(args.id)}`,
        args.market,
      );
      if (!episode) throw new Error(`Episode "${args.id}" not found`);

      const lines = [
        `"${episode.name}"`,
        `Show: ${episode.show.name}`,
        episode.description,
        `Duration: ${formatDuration(episode.duration_ms)} | Released: ${episode.release_date}`,
        `Explicit: ${episode.explicit ? 'yes' : 'no'} | Languages: ${episode.languages.join(', ')}`,
      ];

      if (episode.resume_point) {
        const status = episode.resume_point.fully_played
          ? 'Fully played'
          : `Resume at ${formatDuration(episode.resume_point.resume_position_ms)}`;
        lines.push(`Resume point: ${status}`);
      }

      lines.push(`URI: ${episode.uri}`);

      return withMarketSource(
        // #639: `show.publisher` is offered here as a projection but the field
        // was removed from Show payloads in Feb 2026, so it always renders
        // nothing. Replaced with a field the show payload still carries,
        // rather than left as a projection a caller can select and never get.
        renderSingle(args.response_format, episode as unknown as Record<string, unknown>, lines, [
          ['show.total_episodes', 'Show episode count'],
        ]),
        market,
      );
    },
  );

  // get_me
  server.tool(
    'get_me',
    "Get the current user's Spotify profile: display name, user ID, and URI. Spotify removed `email`, `country`, `product`, `followers` and `explicit_content` from `GET /me` in February 2026, so on a current registration none of them is returned and this tool omits them rather than reporting a placeholder; a grandfathered registration that still sends one has it printed.",
    { response_format: ResponseFormat },
    async (args) => {
      const user = await client.get<UserProfile>('/me');
      if (!user) throw new Error('User profile not found');
      const lines = [
        `Display name: ${user.display_name ?? 'not set'}`,
        `User ID: ${user.id}`,
      ];
      if (user.email !== undefined) lines.push(`Email: ${user.email ?? 'not available'}`);
      if (user.country) lines.push(`Country: ${user.country}`);
      if (user.product) lines.push(`Product: ${user.product}`);
      lines.push(`URI: ${user.uri}`);
      return renderSingle(args.response_format, user as unknown as Record<string, unknown>, lines);
    },
  );
  // get_artist_top_tracks
  server.tool(
    'get_artist_top_tracks',
    "Get an artist's ten most-played tracks for a market. Removed by Spotify's February 2026 Web API changes — unavailable for newer app registrations",
    {
      id: spotifyId('artist'),
      market: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 code, e.g. \'US\' — defaults to SPOTIFY_MCP_MARKET'),
      ...sharedListFields,
    },
    async (args) => {
      let result: { tracks?: SpotifyTrack[] } | null;
      let market: MarketResolution;
      try {
        ({ data: result, market } = await getWithMarketFallback<{ tracks?: SpotifyTrack[] }>(
          client,
          `/artists/${encodeURIComponent(args.id)}/top-tracks`,
          args.market,
        ));
      } catch (err) {
        if (err instanceof SpotifyApiError && err.status === 403) {
          throw new Error(
            `Spotify returned 403 for the top-tracks lookup: ${err.message}. This endpoint may not be available for this app registration, or the required scope is missing.`,
            { cause: err },
          );
        }
        throw err;
      }
      if (!result) throw new Error(`Artist "${args.id}" not found`);

      if (args.response_format === 'json') {
        return withMarketSource(jsonResult(result as unknown as Record<string, unknown>), market);
      }
      const tracks = result.tracks ?? [];
      return withMarketSource(
        renderList(args.response_format, tracks, {
          header: `Top tracks (${tracks.length}):`,
          line: (track, i) =>
            `  ${i + 1}. "${track.name}" by ${joinArtists(track)} (${formatDuration(track.duration_ms)}) | URI: ${track.uri}`,
          total: tracks.length,
          continuable: false,
          maxResults: args.max_results,
        }),
        market,
      );
    },
  );

  // get_available_markets
  server.tool(
    'get_available_markets',
    'List the country codes of every market where Spotify is available. Removed by Spotify\u2019s February 2026 Web API changes — unavailable for newer app registrations',
    { ...sharedListFields },
    async (args) => {
      // Feb 2026: GET /markets was removed (403 for newer app registrations).
      let data: {
        markets?: Array<{ name?: string; codes?: string[] } | string>;
      } | null;
      try {
        data = await client.get<{
          markets?: Array<{ name?: string; codes?: string[] } | string>;
        }>('/markets');
      } catch (err) {
        if (err instanceof SpotifyApiError && err.status === 403) {
          throw new Error(
            `Spotify returned 403 for the markets lookup: ${err.message}. GET /markets was removed by Spotify's February 2026 Web API changes, so the set of markets Spotify serves cannot be read on a current registration; market inputs are validated against the bundled ISO 3166-1 alpha-2 list instead, and the market a lookup runs under comes from its market argument or SPOTIFY_MCP_MARKET. Run with credentials from a grandfathered (pre-Nov-2024) app if you need the served-market list.`,
            { cause: err },
          );
        }
        throw err;
      }
      if (!data?.markets?.length) throw new Error('Available markets list is empty or unavailable');

      return renderList(args.response_format, data.markets, {
        header: `Available markets (${data.markets.length}):`,
        line: (market) => {
          if (typeof market === 'string') return `  • ${market}`;
          if (market.codes?.length) {
            return `  • ${market.name ?? 'Unknown'} (${market.codes.join(', ')})`;
          }
          return `  • ${market.name ?? 'Unknown'}`;
        },
        total: data.markets.length,
        continuable: false,
        maxResults: args.max_results,
      });
    },
  );

  // get_several_tracks
  server.tool(
    'get_several_tracks',
    'Get full details for several tracks by ID in a single call (up to 50 per request)',
    { ids: severalIdsSchema('tracks'), ...sharedListFields },
    async (args) => {
      const { items: tracks, missing, degraded } = await fetchSeveral<SpotifyTrack>(client, 'tracks', 'tracks', args.ids);
      if (!tracks.length) throw new Error(noMatchingSeveral('tracks', missing));

      if (args.response_format === 'json') {
        return jsonResult({
          items: tracks,
          counts: severalCounts(tracks.length, missing),
          ...severalDegradedExtra(degraded),
        });
      }
      return renderList(args.response_format, tracks, {
        header: `Tracks (${tracks.length}):`,
        line: (track) =>
          `  • "${track.name}" by ${joinArtists(track)} (${formatDuration(track.duration_ms)}) | URI: ${track.uri}`,
        continuable: false,
        maxResults: args.max_results,
        unresolved: missing,
        degraded,
      });
    },
  );

  // get_several_albums
  server.tool(
    'get_several_albums',
    'Get full details for several albums by ID in a single call (up to 20 per request)',
    { ids: severalIdsSchema('albums'), ...sharedListFields },
    async (args) => {
      const { items: albums, missing, degraded } = await fetchSeveral<SpotifyAlbumItem>(client, 'albums', 'albums', args.ids);
      if (!albums.length) throw new Error(noMatchingSeveral('albums', missing));

      if (args.response_format === 'json') {
        return jsonResult({
          items: albums,
          counts: severalCounts(albums.length, missing),
          ...severalDegradedExtra(degraded),
        });
      }
      return renderList(args.response_format, albums, {
        header: `Albums (${albums.length}):`,
        line: (album) =>
          `  • "${album.name}" by ${joinArtists(album)} (${album.album_type}, ${album.release_date}, ${album.total_tracks} tracks) | URI: ${album.uri}`,
        continuable: false,
        maxResults: args.max_results,
        unresolved: missing,
        degraded,
      });
    },
  );

  // get_several_artists
  server.tool(
    'get_several_artists',
    'Get full details for several artists by ID in a single call (up to 50 per request)',
    { ids: severalIdsSchema('artists'), ...sharedListFields },
    async (args) => {
      const { items: artists, missing, degraded } = await fetchSeveral<SpotifyArtistFull>(client, 'artists', 'artists', args.ids);
      if (!artists.length) throw new Error(noMatchingSeveral('artists', missing));

      if (args.response_format === 'json') {
        return jsonResult({
          items: artists,
          counts: severalCounts(artists.length, missing),
          ...severalDegradedExtra(degraded),
        });
      }
      return renderList(args.response_format, artists, {
        header: `Artists (${artists.length}):`,
        line: (item) => {
          const genres = Array.isArray(item.genres) && item.genres.length > 0
            ? ` (${item.genres.join(', ')})`
            : '';
          return `  • Artist: ${item.name}${genres} | URI: ${item.uri}`;
        },
        continuable: false,
        maxResults: args.max_results,
        unresolved: missing,
        degraded,
      });
    },
  );

  // get_several_episodes
  server.tool(
    'get_several_episodes',
    'Get full details for several podcast episodes by ID in a single call (up to 50 per request)',
    { ids: severalIdsSchema('episodes'), ...sharedListFields },
    async (args) => {
      const { items: episodes, missing, degraded } = await fetchSeveral<SpotifyEpisodeFull>(client, 'episodes', 'episodes', args.ids);
      if (!episodes.length) throw new Error(noMatchingSeveral('episodes', missing));

      if (args.response_format === 'json') {
        return jsonResult({
          items: episodes,
          counts: severalCounts(episodes.length, missing),
          ...severalDegradedExtra(degraded),
        });
      }
      return renderList(args.response_format, episodes, {
        header: `Episodes (${episodes.length}):`,
        line: (ep) =>
          `  • "${ep.name}" (${formatDuration(ep.duration_ms)}, ${ep.release_date}) | URI: ${ep.uri}`,
        continuable: false,
        maxResults: args.max_results,
        unresolved: missing,
        degraded,
      });
    },
  );

  // get_several_shows
  server.tool(
    'get_several_shows',
    'Get full details for several podcast shows by ID in a single call (up to 50 per request)',
    { ids: severalIdsSchema('shows'), ...sharedListFields },
    async (args) => {
      const { items: shows, missing, degraded } = await fetchSeveral<SpotifyShowFull>(client, 'shows', 'shows', args.ids);
      if (!shows.length) throw new Error(noMatchingSeveral('shows', missing));

      if (args.response_format === 'json') {
        return jsonResult({
          items: shows,
          counts: severalCounts(shows.length, missing),
          ...severalDegradedExtra(degraded),
        });
      }
      return renderList(args.response_format, shows, {
        header: `Shows (${shows.length}):`,
        line: (show) =>
          `  • "${show.name}"${publisherByline(show.publisher)} (${show.total_episodes} episodes) | URI: ${show.uri}`,
        continuable: false,
        maxResults: args.max_results,
        unresolved: missing,
        degraded,
      });
    },
  );

  // get_several_audiobooks
  server.tool(
    'get_several_audiobooks',
    'Get full details for several audiobooks by ID in a single call (up to 50 per request). Audiobooks are only available in the US, UK, Canada, Ireland, New Zealand and Australia markets.',
    { ids: severalIdsSchema('audiobooks'), ...sharedListFields },
    async (args) => {
      const { items: books, missing, degraded } = await fetchSeveral<SpotifyAudiobookSimple>(client, 'audiobooks', 'audiobooks', args.ids);
      if (!books.length) throw new Error(noMatchingSeveral('audiobooks', missing));

      if (args.response_format === 'json') {
        return jsonResult({
          items: books,
          counts: severalCounts(books.length, missing),
          ...severalDegradedExtra(degraded),
        });
      }
      return renderList(args.response_format, books, {
        header: `Audiobooks (${books.length}):`,
        line: (book) => {
          const authors = (book.authors ?? []).map((a) => a.name).join(', ') || 'unknown author';
          return `  • "${book.name}" by ${authors} (${book.total_chapters} chapters) | URI: ${book.uri}`;
        },
        continuable: false,
        maxResults: args.max_results,
        unresolved: missing,
        degraded,
      });
    },
  );

  // get_several_chapters
  server.tool(
    'get_several_chapters',
    'Get full details for several audiobook chapters by ID in a single call (up to 50 per request)',
    { ids: severalIdsSchema('chapters'), ...sharedListFields },
    async (args) => {
      const { items: chapters, missing, degraded } = await fetchSeveral<SpotifyChapterSimple>(client, 'chapters', 'chapters', args.ids);
      if (!chapters.length) throw new Error(noMatchingSeveral('chapters', missing));

      if (args.response_format === 'json') {
        return jsonResult({
          items: chapters,
          counts: severalCounts(chapters.length, missing),
          ...severalDegradedExtra(degraded),
        });
      }
      return renderList(args.response_format, chapters, {
        header: `Chapters (${chapters.length}):`,
        line: (chapter) =>
          `  ${chapter.chapter_number}. "${chapter.name}" (${formatDuration(chapter.duration_ms)}) | URI: ${chapter.uri}`,
        continuable: false,
        maxResults: args.max_results,
        unresolved: missing,
        degraded,
      });
    },
  );

  // ----- gap-fill: get_category (#256) -----
  server.tool(
    'get_category',
    'Get a single Spotify browse category by ID. Removed Feb 2026, no replacement endpoint. Quota: 1 call.',
    {
      category_id: z.string().min(1).describe('Category ID'),
      country: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 country code, e.g. \'US\''),
      locale: z.string().optional().describe('Locale, e.g. en_US'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const params: Record<string, string> = {};
      if (args.country) params.country = args.country;
      if (args.locale) params.locale = args.locale;
      const categoryPath = `/browse/categories/${encodeURIComponent(args.category_id)}`;
      let data: Record<string, unknown> | null;
      try {
        data = await client.get<Record<string, unknown>>(categoryPath, params);
      } catch (err) {
        if (isRemovedEndpointFailure(err)) {
          throw browseCategoryUnavailable(categoryPath, 'category', err);
        }
        throw err;
      }
      if (!data) throw browseCategoryUnavailable(categoryPath, 'category');
      if (args.response_format === 'json') return jsonResult(data as Record<string, unknown>);
      const icons = (data.icons as Array<{ url: string }> | undefined) ?? [];
      const lines = [
        `Category: ${data.name as string} (id: ${data.id as string})`,
        `Href: ${data.href as string}`,
        ...(icons.length ? [`Icons: ${icons.map((i) => i.url).join(', ')}`] : []),
      ];
      return renderSingle(args.response_format, data as Record<string, unknown>, lines);
    },
  );

  // ----- typed search family (#257-263) via factory -----
  type TypedSearchKind = SpotifySearchableKind;
  const typedSearchMeta: Record<TypedSearchKind, { tool: string; description: string; key: string }> = {
    track: { tool: 'search_tracks', description: 'Search tracks only (GET /search?type=track). Quota: 1 call.', key: 'tracks' },
    artist: { tool: 'search_artists', description: 'Search artists only (GET /search?type=artist). Quota: 1 call.', key: 'artists' },
    album: { tool: 'search_albums', description: 'Search albums only (GET /search?type=album). Quota: 1 call.', key: 'albums' },
    playlist: { tool: 'search_playlists', description: 'Search playlists only (GET /search?type=playlist). Quota: 1 call.', key: 'playlists' },
    show: { tool: 'search_shows', description: 'Search podcast shows only (GET /search?type=show). Quota: 1 call.', key: 'shows' },
    episode: { tool: 'search_episodes', description: 'Search podcast episodes only (GET /search?type=episode). Quota: 1 call.', key: 'episodes' },
    audiobook: { tool: 'search_audiobooks', description: 'Search audiobooks only (GET /search?type=audiobook). Audiobooks are only available in the US, UK, CA, IE, NZ and AU markets. Quota: 1 call.', key: 'audiobooks' },
  };
  function makeTypedSearchTool(kind: TypedSearchKind): void {
    const meta = typedSearchMeta[kind];
    server.tool(
      meta.tool,
      meta.description,
      {
        query: z.string().min(1).describe('Search query'),
        limit: z.number().int().min(1).max(10).optional().describe('Results per type, 1–10. Default: 5'),
        offset: z.number().int().min(0).max(1000).optional().describe('Index of the first result to return, 0–1000'),
        market: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 country code, e.g. \'US\''),
        include_external: z.enum(['audio']).optional().describe('Pass "audio" to include externally-hosted audio items'),
        response_format: ResponseFormat,
        max_results: z.number().int().positive().max(2000).optional().describe('Max items to return'),
      },
      async (args) => {
        const limit = args.limit ?? 5;
        const offset = args.offset ?? 0;
        const params: Record<string, string> = { q: args.query as string, type: kind, limit: String(limit) };
        if (args.offset !== undefined) params.offset = String(args.offset);
        if (args.market) params.market = args.market as string;
        if (args.include_external) params.include_external = args.include_external as string;
        const raw = await client.get<Record<string, unknown>>('/search', params);
        if (!raw) return { content: [{ type: 'text', text: 'No results found.' }] };
        const section = (raw as Record<string, unknown>)[meta.key] as { items?: unknown[]; total?: number } | undefined;
        const items = (section?.items ?? []).filter(Boolean) as unknown[];
        // #766: the factory registers seven tools from this one handler, so
        // this is the only writer for all of them — one entry per user action,
        // never seven. `kind` is a single type, hence the one-element list.
        if (items.length > 0) {
          await recordSearch({
            query: args.query as string,
            types: [kind],
            items,
            limit,
            market: args.market as string | undefined,
            offset: args.offset as number | undefined,
          });
        }
        if (args.response_format === 'json') {
          const r = raw as Record<string, unknown>;
          return { content: [{ type: 'text', text: JSON.stringify(r) }], structuredContent: r };
        }
        const total = typeof section?.total === 'number' ? section!.total as number : items.length;
        if (items.length === 0) return { content: [{ type: 'text', text: 'No results found.' }] };
        const cap = resolveMaxResults(args.max_results as number | undefined);
        const trunc = truncateItems(items, cap);
        const lines: string[] = [`Search ${kind}s for "${args.query}" (${total} total):`];
        trunc.items.forEach((it) => {
          const o = it as Record<string, unknown>;
          const name = (o.name as string) ?? (o.id as string) ?? 'unknown';
          const uri = (o.uri as string) ?? '';
          let extra = '';
          if (kind === 'track') {
            const artists = ((o.artists as Array<{ name: string }> | undefined) ?? []).map((a) => a.name).join(', ');
            const album = (o.album as { name?: string } | undefined)?.name ?? '';
            extra = artists ? ` by ${artists}` : '';
            if (album) extra += ` — ${album}`;
            if (typeof o.duration_ms === 'number') extra += ` (${formatDuration(o.duration_ms as number)})`;
          } else if (kind === 'artist') {
            const genres = ((o.genres as string[] | undefined) ?? []).slice(0, 3).join(', ');
            if (genres) extra = ` — ${genres}`;
          } else if (kind === 'album') {
            const artists = ((o.artists as Array<{ name: string }> | undefined) ?? []).map((a) => a.name).join(', ');
            if (artists) extra = ` by ${artists}`;
            if (o.release_date) extra += ` (${o.release_date as string})`;
          } else if (kind === 'playlist') {
            const owner = (o.owner as { display_name?: string; id?: string } | undefined);
            const ownerName = owner?.display_name ?? owner?.id ?? 'unknown';
            extra = ` by ${ownerName}`;
          } else if (kind === 'show') {
            extra = publisherByline(o.publisher as string | undefined);
          } else if (kind === 'episode') {
            const show = (o.show as { name?: string } | undefined)?.name ?? '';
            if (show) extra = ` — ${show}`;
            if (typeof o.duration_ms === 'number') extra += ` (${formatDuration(o.duration_ms as number)})`;
          } else if (kind === 'audiobook') {
            const authors = ((o.authors as Array<{ name: string }> | undefined) ?? []).map((a) => a.name).join(', ');
            if (authors) extra = ` by ${authors}`;
          }
          lines.push(`  \u2022 "${name}"${extra} | URI: ${uri}`);
        });
        if (trunc.footer) lines.push('', `(${trunc.footer})`);
        // The paging verdict is made on the total Spotify actually reported.
        // `total` above falls back to `items.length` for display when the
        // section omits it, and that fallback would read as "this is the whole
        // result set" — silencing the paging signal on a page that is full.
        // A missing total is a missing total (#6: a value that could not be
        // read is not a value); `paginationInfo` then falls back to the
        // page-full heuristic instead of a fabricated end.
        const pagination = paginationInfo({
          total: typeof section?.total === 'number' ? section.total : null,
          offset,
          limit,
          returned: trunc.items.length,
        });
        // #781: the offset to continue from is only useful in prose. A
        // line-oriented agent never reads `structuredContent`, so the same
        // `next_offset` the payload carries is printed here; null prints
        // nothing, because an exhausted page must not tell the agent to keep
        // going.
        const pageLine = nextPageLine(pagination.next_offset);
        if (pageLine) lines.push(pageLine);
        return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { query: args.query, type: kind, items: trunc.items, total, pagination } };
      },
    );
  }
  SPOTIFY_SEARCHABLE_KINDS.forEach(makeTypedSearchTool);

  // ----- catalog_batch_lookup (#268) -----
  server.tool(
    'catalog_batch_lookup',
    'Resolve a mixed list of Spotify URIs (tracks/albums/artists/shows/episodes/audiobooks/chapters) in partitioned batch calls. Quota: 1 per distinct type + chunking.',
    {
      uris: z.array(z.string().min(1)).min(1).max(50).describe('Spotify URIs (spotify:track:..., spotify:album:..., etc.) 1–50 mixed'),
      ...sharedListFields,
    },
    async (args) => {
      const uris = args.uris as string[];
      const groups = new Map<string, string[]>();
      // Two different failures, kept apart (#779): `invalid` is a URI this
      // tool could not read at all, `unsupported` is a well-formed URI whose
      // type has no batch endpoint here. Reporting the second as invalid told
      // callers their valid input was malformed, and that payload is consumed
      // as the truth about what resolved.
      // #778: the URI each id was requested under, so an id the endpoint
      // answers with null is reported the way the caller spelled it.
      const requestedUri = new Map<string, string>();
      const invalid: string[] = [];
      const unsupported: string[] = [];
      for (const uri of uris) {
        const parsed = parseSpotifyUri(uri);
        if (!parsed) { invalid.push(uri); continue; }
        const type = parsed.type;
        // normalize plural key for fetchSeveral
        const kindMap: Record<string, string> = { track: 'tracks', album: 'albums', artist: 'artists', playlist: 'playlists', show: 'shows', episode: 'episodes', audiobook: 'audiobooks', chapter: 'chapters' };
        const kind = kindMap[type];
        // Playlists (and any other well-formed type with no `/${kind}?ids=`
        // sibling) are unsupported, not invalid — see the buckets above.
        if (!kind) { unsupported.push(uri); continue; }
        if (kind === 'playlists') { unsupported.push(uri); continue; }
        const arr = groups.get(kind) ?? [];
        arr.push(parsed.id);
        groups.set(kind, arr);
        requestedUri.set(`${kind}:${parsed.id}`, uri);
      }
      if (groups.size === 0) {
        const why = [
          invalid.length ? `Invalid: ${invalid.join(', ')}` : '',
          unsupported.length ? `Unsupported here: ${unsupported.join(', ')}` : '',
        ].filter(Boolean).join(' | ');
        throw new Error(`No resolvable URIs. ${why}`);
      }
      const responseKeyMap: Record<string, string> = { tracks: 'tracks', albums: 'albums', artists: 'artists', shows: 'shows', episodes: 'episodes', audiobooks: 'audiobooks', chapters: 'chapters' };
      // One request per distinct type; they need not queue (#779), and each
      // type's `missing` ids are reported under the URI the caller spelled
      // rather than the id Spotify echoed (#778).
      const perKind = await Promise.all(
        [...groups].map(async ([kind, ids]) => {
          const key = responseKeyMap[kind] ?? kind;
          return { kind, ...(await fetchSeveral<Record<string, unknown>>(client, kind as SeveralKind, key, ids)) };
        }),
      );
      const allItems: Array<{ type: string; item: unknown }> = [];
      const unresolved: string[] = [];
      for (const { kind, items, missing } of perKind) {
        for (const id of missing) unresolved.push(requestedUri.get(`${kind}:${id}`) ?? id);
        for (const it of items) allItems.push({ type: kind, item: it });
      }
      if (args.response_format === 'json') {
        const raw: Record<string, unknown> = { items: allItems, invalid, unsupported, unresolved };
        return { content: [{ type: 'text', text: JSON.stringify(raw) }], structuredContent: raw };
      }
      const cap = resolveMaxResults(args.max_results);
      const trunc = truncateItems(allItems, cap);
      const counts = [`${allItems.length} resolved`];
      if (invalid.length) counts.push(`${invalid.length} invalid skipped`);
      if (unsupported.length) counts.push(`${unsupported.length} unsupported skipped`);
      const lines = [`Batch lookup (${counts.join(', ')}):`];
      if (unresolved.length > 0) lines.push(`IDs the endpoint could not resolve: ${unresolved.join(', ')}`);
      trunc.items.forEach(({ type, item }) => {
        const o = item as Record<string, unknown>;
        lines.push(`  \u2022 [${type}] "${(o.name as string) ?? (o.id as string)}" | URI: ${(o.uri as string) ?? ''}`);
      });
      if (trunc.footer) lines.push('', `(${trunc.footer})`);
      if (invalid.length) lines.push('', `Invalid URIs skipped (not readable as a Spotify URI): ${invalid.join(', ')}`);
      if (unsupported.length) lines.push('', `Unsupported here (well-formed, but no batch endpoint for this type): ${unsupported.join(', ')}`);
      if (unresolved.length) lines.push('', `IDs the endpoint could not resolve: ${unresolved.join(', ')}`);
      return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { items: trunc.items, total: allItems.length, invalid, unsupported, unresolved } };
    },
  );

  // ----- get_artist_singles / get_artist_appearances (#269, #270) -----
  server.tool(
    'get_artist_singles',
    "List an artist's singles only (GET /artists/{id}/albums?include_groups=single). Quota: 1 call.",
    {
      artist_id: spotifyId('artist'),
      limit: z.number().int().min(1).max(ARTIST_ALBUM_PAGE_LIMIT).optional().describe(`Results per page, 1–${ARTIST_ALBUM_PAGE_LIMIT}. Default: ${ARTIST_ALBUM_PAGE_LIMIT}`),
      offset: z.number().int().min(0).optional().describe('Offset. Default: 0'),
      market: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 country code'),
      ...sharedListFields,
    },
    async (args) => {
      const { data: result, market } = await getWithMarketFallback<SpotifyArtistAlbumsResponse>(client, `/artists/${encodeURIComponent(args.artist_id as string)}/albums`, args.market as string | undefined, { include_groups: 'single', limit: String(Math.min((args.limit as number) ?? ARTIST_ALBUM_PAGE_LIMIT, ARTIST_ALBUM_PAGE_LIMIT)), offset: String((args.offset as number) ?? 0) });
      if (!result) throw new Error(`Artist "${args.artist_id}" not found`);
      if (args.response_format === 'json') return withMarketSource(jsonResult(result as unknown as Record<string, unknown>), market);
      return withMarketSource(renderList(args.response_format as ResponseFormatValue, result.items, { header: `Singles for artist (${result.total} total):`, line: (album: SpotifyAlbumItem) => `  • "${album.name}" (${album.release_date}, ${album.total_tracks} tracks) | URI: ${album.uri}`, total: result.total, offset: args.offset as number | undefined, limit: Math.min((args.limit as number) ?? ARTIST_ALBUM_PAGE_LIMIT, ARTIST_ALBUM_PAGE_LIMIT), maxResults: args.max_results as number | undefined }), market);
    },
  );
  server.tool(
    'get_artist_appearances',
    "List albums an artist appears on (GET /artists/{id}/albums?include_groups=appears_on). Quota: 1 call.",
    {
      artist_id: spotifyId('artist'),
      limit: z.number().int().min(1).max(ARTIST_ALBUM_PAGE_LIMIT).optional().describe(`Results per page, 1–${ARTIST_ALBUM_PAGE_LIMIT}. Default: ${ARTIST_ALBUM_PAGE_LIMIT}`),
      offset: z.number().int().min(0).optional().describe('Offset. Default: 0'),
      market: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 country code'),
      include_groups: z.array(z.enum(['appears_on', 'compilation'])).optional().describe('Default: ["appears_on"]'),
      ...sharedListFields,
    },
    async (args) => {
      const groups = ((args.include_groups as string[] | undefined) ?? ['appears_on']).join(',');
      const { data: result, market } = await getWithMarketFallback<SpotifyArtistAlbumsResponse>(client, `/artists/${encodeURIComponent(args.artist_id as string)}/albums`, args.market as string | undefined, { include_groups: groups, limit: String(Math.min((args.limit as number) ?? ARTIST_ALBUM_PAGE_LIMIT, ARTIST_ALBUM_PAGE_LIMIT)), offset: String((args.offset as number) ?? 0) });
      if (!result) throw new Error(`Artist "${args.artist_id}" not found`);
      if (args.response_format === 'json') return withMarketSource(jsonResult(result as unknown as Record<string, unknown>), market);
      return withMarketSource(renderList(args.response_format as ResponseFormatValue, result.items, { header: `Appearances for artist (${result.total} total):`, line: (album: SpotifyAlbumItem) => `  • "${album.name}" (${album.album_type}, ${album.release_date}) | URI: ${album.uri}`, total: result.total, offset: args.offset as number | undefined, limit: Math.min((args.limit as number) ?? ARTIST_ALBUM_PAGE_LIMIT, ARTIST_ALBUM_PAGE_LIMIT), maxResults: args.max_results as number | undefined }), market);
    },
  );

  // ----- market_validate (#271) -----
  server.tool(
    'market_validate',
    'Validate ISO 3166-1 market codes against GET /markets (cached) and optionally return the account market from /me. Quota: 1–2 calls.',
    {
      markets: z.array(MARKET_CODE).optional().describe('Market codes to validate (2-letter). If omitted, just lists valid markets / account market.'),
      include_account_market: z.boolean().optional().describe('Include account country from /me. Spotify removed `country` from `GET /me` in February 2026, so on a current registration this is always null and the tool says so rather than inventing a market.'),
      response_format: ResponseFormat,
    },
    async (args) => {
      let validSet: Set<string> | null = null;
      let marketsRaw: unknown = null;
      try {
        const data = await client.get<{ markets?: Array<string | { codes?: string[] }> }>('/markets');
        const list = data?.markets ?? [];
        const codes: string[] = [];
        for (const m of list) {
          if (typeof m === 'string') codes.push(m.toUpperCase());
          else if (m && typeof m === 'object' && Array.isArray((m as { codes?: string[] }).codes)) codes.push(...(m as { codes: string[] }).codes.map((c) => c.toUpperCase()));
          else if (m && typeof m === 'object' && typeof (m as { name?: string }).name === 'string') { /* ignore name-only */ }
        }
        validSet = new Set(codes);
        marketsRaw = data;
      } catch (err) {
        if (isGatedError(err)) {
          const note = `GET /markets returned 403 (removed for newer app registrations Feb 2026). Falling back to account market only.`;
          let accountMarket: string | undefined;
          if (args.include_account_market) {
            try { const me = await client.get<UserProfile>('/me'); accountMarket = me?.country; } catch { /* ignore */ }
          }
          const result: Record<string, unknown> = { note, account_market: accountMarket ?? null };
          if (args.markets?.length) {
            result.requested = args.markets;
            result.verdict = 'unknown — /markets unavailable (403)';
          }
          if (args.response_format === 'json') return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
          const lines = [note];
          if (accountMarket) lines.push(`Account market: ${accountMarket}`);
          if (args.markets?.length) lines.push(`Requested: ${args.markets.join(', ')} (cannot validate without /markets)`);
          return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: result };
        }
        throw err;
      }
      let accountMarket: string | undefined;
      if (args.include_account_market) {
        try { const me = await client.get<UserProfile>('/me'); accountMarket = me?.country; } catch { /* ignore */ }
      }
      if (!args.markets?.length) {
        const result: Record<string, unknown> = { valid_markets: validSet ? [...validSet].sort() : [], account_market: accountMarket ?? null, markets_raw: marketsRaw };
        if (args.response_format === 'json') return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
        const lines = [`Valid markets (${validSet!.size}): ${[...validSet!].sort().join(', ')}`];
        if (accountMarket) lines.push(`Account market: ${accountMarket}`);
        return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: result };
      }
      const requested = (args.markets as string[]).map((c) => c.toUpperCase());
      const valid: string[] = [];
      const invalid: string[] = [];
      for (const c of requested) (validSet!.has(c) ? valid : invalid).push(c);
      const result: Record<string, unknown> = { requested, valid, invalid, account_market: accountMarket ?? null };
      if (args.response_format === 'json') return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      const lines = [`Requested: ${requested.join(', ')}`, `Valid: ${valid.length ? valid.join(', ') : 'none'}`, `Invalid: ${invalid.length ? invalid.join(', ') : 'none'}`];
      if (accountMarket) lines.push(`Account market: ${accountMarket}`);
      return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: result };
    },
  );

  // ----- browse_category_deepdive (rank 59 / #317) -----
  server.tool(
    'browse_category_deepdive',
    'Category → playlists → optional items peek in one call. Removed Feb 2026, no replacement endpoint. Quota: 2–3 calls.',
    {
      category_id: z.string().min(1).describe('Category ID'),
      country: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 country code, e.g. \'US\''),
      locale: z.string().optional().describe('Locale, e.g. en_US'),
      limit: z.number().int().min(1).max(50).optional().describe('Playlists per page, 1–50. Default: 10'),
      peek_items: z.boolean().optional().describe('When true, fetch top 2 tracks of the first playlist'),
      ...sharedListFields,
    },
    async (args) => {
      const catParams: Record<string, string> = {};
      if (args.country) catParams.country = args.country as string;
      if (args.locale) catParams.locale = args.locale as string;
      const categoryPath = `/browse/categories/${encodeURIComponent(args.category_id as string)}`;
      let category: Record<string, unknown> | null;
      try {
        category = await client.get<Record<string, unknown>>(categoryPath, catParams);
      } catch (err) {
        if (isRemovedEndpointFailure(err)) {
          throw browseCategoryUnavailable(categoryPath, 'category', err);
        }
        throw err;
      }
      if (!category) throw browseCategoryUnavailable(categoryPath, 'category');
      const plParams: Record<string, string> = {};
      if (args.country) plParams.country = args.country as string;
      if (args.limit !== undefined) plParams.limit = String(args.limit);
      const playlistsPath = `${categoryPath}/playlists`;
      let playlists: SpotifyPaged<SpotifyAlbumItem & { owner?: { display_name?: string; id?: string } }> | undefined;
      try {
        const plData = await client.get<{ playlists: typeof playlists }>(playlistsPath, plParams);
        playlists = plData?.playlists;
      } catch (err) {
        if (isRemovedEndpointFailure(err)) {
          throw browseCategoryUnavailable(playlistsPath, 'playlists', err);
        }
        throw err;
      }
      if (!playlists) throw browseCategoryUnavailable(playlistsPath, 'playlists');
      let peek: Array<Record<string, unknown>> | null = null;
      // A peek that could not be read is unknown, not empty: report the
      // failure instead of collapsing it into "this playlist has no rows" (#773).
      let peekError: string | null = null;
      if (args.peek_items && playlists?.items?.length) {
        const first = playlists.items[0] as { id?: string };
        if (first?.id) {
          try {
            // /playlists/{id}/items returns { added_at, item } rows; the
            // legacy /tracks path is gone. Read every row shape defensively.
            const itemsData = await client.get<{ items?: unknown[] }>(
              `/playlists/${encodeURIComponent(first.id)}/items`,
              { limit: '2', additional_types: 'track' },
            );
            peek = (itemsData?.items ?? []).map((it) => {
              const row = (it ?? {}) as Record<string, unknown>;
              return (row.item ?? row.track ?? row) as Record<string, unknown>;
            });
          } catch (err) {
            peek = null;
            peekError = err instanceof Error ? err.message : String(err);
          }
        }
      }
      if (args.response_format === 'json') {
        const raw: Record<string, unknown> = { category, playlists, peek, peek_error: peekError };
        return { content: [{ type: 'text', text: JSON.stringify(raw) }], structuredContent: raw };
      }
      const cap = resolveMaxResults(args.max_results as number | undefined);
      const lines = [`Category: ${category.name as string} (id: ${category.id as string})`];
      if (playlists) {
        lines.push(`Playlists (${playlists.total} total):`);
        const trunc = truncateItems(playlists.items as unknown[], cap);
        trunc.items.forEach((p) => {
          const o = p as Record<string, unknown>;
          lines.push(`  \u2022 "${o.name as string}" | URI: ${o.uri as string}`);
        });
        if (trunc.footer) lines.push(`  (${trunc.footer})`);
        if (peekError) {
          lines.push(`  (preview unavailable: ${peekError})`);
        } else if (peek?.length) {
          lines.push('', 'Peek (first playlist, 2 tracks):');
          peek.slice(0, 2).forEach((track) => {
            lines.push(`  - "${(track.name as string) ?? 'unknown'}" | URI: ${(track.uri as string) ?? ''}`);
          });
        }
      }
      return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { category, playlists, peek, peek_error: peekError } };
    },
  );

  // ----- show_episode_search (rank 60 / #318) -----
  server.tool(
    'show_episode_search',
    'Full-text search within one show\'s episodes (GET /shows/{id}/episodes paged + client-side q). Quota: 1–N pages (fetch_all walks).',
    {
      show_id: spotifyId('show'),
      query: z.string().min(1).describe('Case-insensitive substring over name/description'),
      limit: z.number().int().min(1).max(50).optional().describe('Results per page for the underlying paging, 1–50. Default: 20'),
      offset: z.number().int().min(0).optional().describe('Offset for underlying paging. Default: 0'),
      market: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 country code, e.g. \'US\''),
      fetch_all: z.boolean().optional().describe('When true, walk from offset to the end (500-episode cap)'),
      ...sharedListFields,
    },
    async (args) => {
      const q = (args.query as string).toLowerCase();
      const fetchAll = Boolean(args.fetch_all);
      const limit = (args.limit as number) ?? 20;
      const offset = (args.offset as number) ?? 0;
      const market = args.market as string | undefined;
      const matches: SpotifyEpisodeSimple[] = [];
      let total = 0;
      let scanned = 0;
      let safetyCapHit = false;
      const walk = async (off: number, lim: number) => {
        const params: Record<string, string> = { limit: String(lim), offset: String(off) };
        if (market) params.market = market;
        const page = await client.get<SpotifyPaged<SpotifyEpisodeSimple>>(`/shows/${encodeURIComponent(args.show_id as string)}/episodes`, params);
        if (!page) return null;
        total = page.total;
        scanned += page.items.length;
        for (const ep of page.items) {
          const hay = `${ep.name} ${ep.description ?? ''}`.toLowerCase();
          if (hay.includes(q)) matches.push(ep);
        }
        return page;
      };
      if (fetchAll) {
        // #790: the walk honours the caller's limit/offset and is bounded by
        // FETCH_ALL_EPISODE_CAP, never by the display cap. The final request is
        // shortened so the walk can never overshoot the cap, and hitting it with
        // episodes left is reported rather than passed off as a full search.
        const pageSize = Math.min(EPISODE_PAGE_MAX, limit);
        let off = offset;
        for (;;) {
          // Reached only after a full page with episodes left, so the cap here
          // means the walk was cut short, not that the show ended.
          if (scanned >= FETCH_ALL_EPISODE_CAP) { safetyCapHit = true; break; }
          const requestSize = Math.min(pageSize, FETCH_ALL_EPISODE_CAP - scanned);
          const page = await walk(off, requestSize);
          if (!page) break;
          const unscanned = Math.max(0, (page.total ?? 0) - (off + page.items.length));
          if (page.items.length < requestSize) break; // short page: end of show
          if (unscanned <= 0) break; // whole show covered
          if (requestSize < pageSize) { safetyCapHit = true; break; } // cap-bound page
          off += requestSize;
        }
      } else {
        await walk(offset, limit);
      }
      const scannedFrom = offset;
      const scannedTo = offset + scanned;
      const scan: Record<string, unknown> = {
        scanned_episodes: scanned,
        scanned_from: scannedFrom,
        scanned_to: scannedTo,
        safety_cap_hit: safetyCapHit,
      };
      if (args.response_format === 'json') {
        const raw: Record<string, unknown> = { show_id: args.show_id, query: args.query, total_episodes: total, ...scan, matches };
        return { content: [{ type: 'text', text: JSON.stringify(raw) }], structuredContent: raw };
      }
      if (matches.length === 0) {
        const lines = [`No episodes matching "${args.query}" in show ${args.show_id}.`];
        lines.push(`(Scanned ${scanned} episode${scanned === 1 ? '' : 's'} of ${total} in the range ${scannedFrom}–${scannedTo}.)`);
        if (safetyCapHit) lines.push(`(Stopped at the ${FETCH_ALL_EPISODE_CAP}-episode safety cap — episodes after index ${scannedTo} were not searched, so matches there are unknown.)`);
        return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { show_id: args.show_id, query: args.query, total_episodes: total, ...scan, matches: [] } };
      }
      const cap = resolveMaxResults(args.max_results as number | undefined);
      // fetch_all is already on, so its footer must not advise setting it; the
      // scan cap is not a caller knob, so it is not offered either.
      const trunc = truncateItems(matches, cap, fetchAll ? SCAN_CAPABILITIES : PAGE_CAPABILITIES);
      const lines = [`Episodes matching "${args.query}" in show ${args.show_id} (${matches.length} match${matches.length === 1 ? '' : 'es'} of ${total} total, from ${scanned} scanned episode${scanned === 1 ? '' : 's'} ${scannedFrom}–${scannedTo}):`];
      trunc.items.forEach((ep) => lines.push(`  • "${ep.name}" (${formatDuration(ep.duration_ms)}, ${ep.release_date}) | URI: ${ep.uri}`));
      if (trunc.footer) lines.push('', `(${trunc.footer})`);
      if (safetyCapHit) lines.push(`(Walk stopped at the ${FETCH_ALL_EPISODE_CAP}-episode safety cap: episodes after index ${scannedTo} of ${total} were not searched, so this list is not every match.)`);
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: {
          show_id: args.show_id,
          query: args.query,
          total_episodes: total,
          ...scan,
          matches: trunc.items,
          // Page mode scans one episode window, so paging over the episode
          // range is truthful. In fetch_all mode the walk is already as wide as
          // it will get and the rendered rows are a trimmed view of a
          // client-side match set, not a page of the endpoint — a next_offset
          // there would point at episodes, not matches, so it is omitted.
          ...(fetchAll ? {} : { pagination: paginationInfo({ total, offset, limit, returned: scanned }) }),
        },
      };
    },
  );
}
