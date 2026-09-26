import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SpotifyApiError, type SpotifyClient } from '../client.js';
import { isRemovedEndpointFailure } from '../gating.js';
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
  listStructuredContent,
  parseSpotifyUri,
  type ResponseFormatValue,
} from '../shaping.js';
import { chunk, capFor, type ChunkCapKind } from '../chunk.js';
import { recordSearch } from './searchhistory.js';
import { getConfig, resolveMarket } from '../config.js';
import { spotifyId, spotifyIdArray, type SpotifyReferenceKind } from '../refs.js';


// Issue #110: market codes are exactly two letters; lowercase input is
// normalised to uppercase before it reaches the wire.
export const MARKET_CODE = z
  .string()
  .regex(/^[A-Za-z]{2}$/, 'market must be a 2-letter ISO 3166-1 alpha-2 country code, e.g. "US"')
  .transform((code) => code.toUpperCase());

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

let profileCountry: Promise<string | undefined> | null = null;

// Show/episode lookups are market-gated (#29): when the caller supplies no
// market, default to the account's country from /me.
function resolveProfileCountry(client: SpotifyClient): Promise<string | undefined> {
  profileCountry ??= client
    .get<UserProfile>('/me')
    .then((user) => user?.country)
    .catch(() => undefined);
  return profileCountry;
}

/** Test hook: forget the memoized profile-country lookup. */
export function resetProfileCountryCache(): void {
  profileCountry = null;
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

// GET with `market` defaulting to the profile country. When the market was
// defaulted (not caller-supplied) and Spotify rejects the lookup, rethrow
// with a hint while preserving the original error as `cause`.
async function getWithMarketFallback<T>(
  client: SpotifyClient,
  path: string,
  marketArg: string | undefined,
  extraParams: Record<string, string> = {},
): Promise<T | null> {
  let market: string | undefined;
  if (marketArg) market = marketArg.toUpperCase();
  else if (getConfig().market) market = getConfig().market!;
  else market = await resolveProfileCountry(client);
  const params: Record<string, string> = { ...extraParams };
  if (market) params.market = market;
  try {
    return await client.get<T>(path, params);
  } catch (err) {
    if (
      !marketArg &&
      market &&
      err instanceof SpotifyApiError &&
      (err.status === 404 || err.status === 400)
    ) {
      throw new Error(
        `Spotify returned ${err.status} for this lookup using market ${market}. This endpoint is market-gated — retry with an explicit market code if this looks wrong.`,
        { cause: err },
      );
    }
    throw err;
  }
}
function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// ------------------------------------------------ get_several_* family (#43)
// Per-request ID caps for GET /<type>?ids=. Inputs larger than the cap are
// chunked into multiple queued calls and merged in request order; items
// Spotify could not resolve come back null and are dropped.
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
): Promise<T[]> {
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
        if (err instanceof SpotifyApiError && err.status === 403) {
          throw new Error(
            `Spotify returned 403 for the /${kind} batch lookup: ${err.message}. The "Get Several" batch endpoints were removed by Spotify's February 2026 Web API changes and are unavailable for newer app registrations; use the single-item get tools instead, or run with credentials from a grandfathered (pre-Nov-2024) app.`,
            { cause: err },
          );
        }
        throw err;
      }
      return (res?.[responseKey] ?? []).filter((item): item is T => item != null);
    })
  );
  return __chunkResults.flat();
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

function joinArtists(items: { artists?: { name: string }[] }): string {
  return (items.artists ?? []).map((a) => a.name).join(', ');
}


// ------------------------------------------ shared response shaping (#51/#52/#53)

type ShapedToolResult = {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};

/** Read an (optionally dotted) field off a raw API payload, e.g. 'album.release_date'. */
function field(payload: unknown, path: string): unknown {
  let cur: unknown = payload;
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Prose rendering of a raw API value; null when the API omitted it. */
function fmtFieldValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) {
    const parts = value.map((v) =>
      typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v),
    );
    return parts.join(', ');
  }
  return String(value);
}

/** #51 json mode: raw API payload as parseable JSON text plus structuredContent. */
function jsonResult(raw: Record<string, unknown>): ShapedToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(raw) }], structuredContent: raw };
}

/**
 * Single-object rendering (#51): concise keeps the existing prose verbatim;
 * detailed appends fields the prose drops (popularity, release dates, …).
 */
function renderSingle(
  fmt: ResponseFormatValue | undefined,
  raw: Record<string, unknown>,
  concise: string[],
  detailedKeys: Array<[path: string, label: string]> = [],
): ShapedToolResult {
  if (fmt === 'json') return jsonResult(raw);
  const lines = [...concise];
  if (fmt === 'detailed') {
    let headerPushed = false;
    for (const [path, label] of detailedKeys) {
      const rendered = fmtFieldValue(field(raw, path));
      if (rendered === null) continue;
      if (!headerPushed) {
        lines.push('', 'More details:');
        headerPushed = true;
      }
      lines.push(`${label}: ${rendered}`);
    }
  }
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

/**
 * List rendering (#52/#53): truncates to max_results, appends the shared
 * footer, and emits structuredContent with pagination info.
 */
function renderList<T>(
  fmt: ResponseFormatValue | undefined,
  pageItems: readonly T[],
  opts: {
    header: string;
    line: (item: T, index: number) => string;
    maxResults?: number;
    /** Server-side total when the endpoint reports one. */
    total?: number | null;
    offset?: number;
    limit?: number | null;
    /** False when the list cannot continue server-side (several_* lookups). */
    continuable?: boolean;
  },
): ShapedToolResult {
  const cap = resolveMaxResults(opts.maxResults);
  const trunc = truncateItems(pageItems, cap);
  const lines = [opts.header];
  trunc.items.forEach((item, i) => lines.push(opts.line(item, i)));
  if (trunc.footer) lines.push('', `(${trunc.footer})`);
  const continuable = opts.continuable !== false;
  const pagination = paginationInfo({
    total: opts.total ?? trunc.total,
    offset: opts.offset,
    limit: opts.limit ?? null,
    returned: trunc.items.length,
  });
  if (!continuable) {
    pagination.next_offset = null;
  } else if (!trunc.truncated && pagination.next_offset !== null) {
    const left =
      pagination.total !== null ? pagination.total - pagination.next_offset : null;
    lines.push(
      '',
      `More pages available — pass offset=${pagination.next_offset}${
        left !== null ? ` (${left} items left)` : ''
      }`,
    );
  }
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: listStructuredContent(trunc.items, pagination),
  };
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
      market: MARKET_CODE.optional().describe('ISO country code; defaults to account country.'),
      fetch_all: z.boolean().optional().describe('Fetch all pages up to cap. Default: false'),
      ...sharedListFields,
    },
    async (args) => {
      // 523: fetch_all walks all pages via getAllPages
      let result: SpotifyArtistAlbumsResponse | null;
      if ((args as unknown as { fetch_all?: boolean }).fetch_all) {
        const items = await client.getAllPages<SpotifyArtistAlbumsResponse['items'][number]>(
          `/artists/${encodeURIComponent(args.id)}/albums`,
          {
            include_groups: (args.include_groups ?? ['album', 'single']).join(','),
            limit: String(ARTIST_ALBUM_PAGE_LIMIT),
            ...(args.market ? { market: args.market } : {}),
          },
          { maxItems: args.max_results },
        );
        result = { items, total: items.length, limit: items.length, offset: 0, href: '', previous: null, next: null } as unknown as SpotifyArtistAlbumsResponse;
      } else {
        result = await getWithMarketFallback<SpotifyArtistAlbumsResponse>(
          client,
          `/artists/${encodeURIComponent(args.id)}/albums`,
          args.market,
          {
            include_groups: (args.include_groups ?? ['album', 'single']).join(','),
            limit: String(Math.min(args.limit ?? ARTIST_ALBUM_PAGE_LIMIT, ARTIST_ALBUM_PAGE_LIMIT)),
            offset: String(args.offset ?? 0),
          },
        );
      }
      if (!result) throw new Error(`Artist "${args.id}" not found`);

      if (args.response_format === 'json') {
        return jsonResult(result as unknown as Record<string, unknown>);
      }
      return renderList(args.response_format, result.items, {
        header: `Albums for artist (${result.total} total):`,
        line: (album) => {
          const artists = album.artists.map((a) => a.name).join(', ');
          return `  • "${album.name}" by ${artists} (${album.album_type}, ${album.release_date}, ${album.total_tracks} tracks) | URI: ${album.uri}`;
        },
        total: result.total,
        offset: args.offset,
        limit: Math.min(args.limit ?? ARTIST_ALBUM_PAGE_LIMIT, ARTIST_ALBUM_PAGE_LIMIT),
        maxResults: args.max_results,
      });
    },
  );

  // get_album
  server.tool(
    'get_album',
    'Get album details and track list by ID',
    {
      id: spotifyId('album'),
      market: MARKET_CODE.optional().describe(
        'ISO country code; defaults to account country.',
      ),
      ...sharedListFields,
    },
    async (args) => {
      const album = await getWithMarketFallback<SpotifyAlbumFull>(
        client,
        `/albums/${encodeURIComponent(args.id)}`,
        args.market,
      );
      if (!album) throw new Error(`Album "${args.id}" not found`);


      if (args.response_format === 'json') {
        return jsonResult(album as unknown as Record<string, unknown>);
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
      return renderSingle(args.response_format, album as unknown as Record<string, unknown>, lines, [
        ['label', 'Label'],
        ['popularity', 'Popularity'],
        ['genres', 'Genres'],
        ['copyrights', 'Copyright'],
      ]);
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
        'ISO 3166-1 alpha-2 country code. Defaults to the account country; affects track availability.',
      ),
      fetch_all: z.boolean().optional().describe('When true, walk all pages via getAllPages up to cap (fetch_all_cap) — use for "all" queries. Default: false'),
      ...sharedListFields,
    },
    async (args) => {
      let result: SpotifyPaged<SpotifyTrackSimple> | null;
      if ((args as unknown as { fetch_all?: boolean }).fetch_all) {
        const items = await client.getAllPages<SpotifyTrackSimple>(
          `/albums/${encodeURIComponent(args.id)}/tracks`,
          args.market ? { market: args.market } : undefined,
          { maxItems: args.max_results }
        );
        result = { items, total: items.length, limit: items.length, offset: 0, next: null } as SpotifyPaged<SpotifyTrackSimple>;
      } else {
        result = await getWithMarketFallback<SpotifyPaged<SpotifyTrackSimple>>(
          client,
          `/albums/${encodeURIComponent(args.id)}/tracks`,
          args.market,
          {
            limit: String(args.limit ?? 20),
            offset: String(args.offset ?? 0),
          },
        );
      }
      if (!result) throw new Error(`Album "${args.id}" not found`);

      if (args.response_format === 'json') {
        return jsonResult(result as unknown as Record<string, unknown>);
      }
      return renderList(args.response_format, result.items, {
        header: `Tracks for album (${result.total} total):`,
        line: (track) => {
          const trackArtists = track.artists.map((a) => a.name).join(', ');
          return `  ${track.track_number}. "${track.name}" by ${trackArtists} (${formatDuration(track.duration_ms)}) | URI: ${track.uri}`;
        },
        total: result.total,
        offset: args.offset,
        limit: args.limit ?? 20,
        maxResults: args.max_results,
      });
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
      const show = await getWithMarketFallback<SpotifyShowFull>(
        client,
        `/shows/${encodeURIComponent(args.id)}`,
        args.market,
      );
      if (!show) throw new Error(`Show "${args.id}" not found`);

      const lines = [
        `"${show.name}" by ${show.publisher ?? 'unknown publisher'}`,
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

      return renderSingle(args.response_format, show as unknown as Record<string, unknown>, lines);
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
      const episode = await getWithMarketFallback<SpotifyEpisodeFull>(
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

      return renderSingle(args.response_format, episode as unknown as Record<string, unknown>, lines, [
        ['show.publisher', 'Show publisher'],
      ]);
    },
  );

  // get_me
  server.tool(
    'get_me',
    "Get the current user's Spotify profile: display name, user ID, email, country, and subscription level. Email requires the user-read-email scope; country and product require user-read-private.",
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
      market: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 country code, e.g. \'US\' — defaults to the account country'),
      ...sharedListFields,
    },
    async (args) => {
      let result: { tracks?: SpotifyTrack[] } | null;
      try {
        result = await getWithMarketFallback<{ tracks?: SpotifyTrack[] }>(
          client,
          `/artists/${encodeURIComponent(args.id)}/top-tracks`,
          args.market,
        );
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
        return jsonResult(result as unknown as Record<string, unknown>);
      }
      const tracks = result.tracks ?? [];
      return renderList(args.response_format, tracks, {
        header: `Top tracks (${tracks.length}):`,
        line: (track, i) =>
          `  ${i + 1}. "${track.name}" by ${joinArtists(track)} (${formatDuration(track.duration_ms)}) | URI: ${track.uri}`,
        total: tracks.length,
        continuable: false,
        maxResults: args.max_results,
      });
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
            `Spotify returned 403 for the markets lookup: ${err.message}. GET /markets was removed by Spotify's February 2026 Web API changes; validate market inputs with your account country from get_me, or run with credentials from a grandfathered (pre-Nov-2024) app.`,
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
      const tracks = await fetchSeveral<SpotifyTrack>(client, 'tracks', 'tracks', args.ids);
      if (!tracks.length) throw new Error('No matching tracks found');

      if (args.response_format === 'json') return jsonResult({ items: tracks });
      return renderList(args.response_format, tracks, {
        header: `Tracks (${tracks.length}):`,
        line: (track) =>
          `  • "${track.name}" by ${joinArtists(track)} (${formatDuration(track.duration_ms)}) | URI: ${track.uri}`,
        continuable: false,
        maxResults: args.max_results,
      });
    },
  );

  // get_several_albums
  server.tool(
    'get_several_albums',
    'Get full details for several albums by ID in a single call (up to 20 per request)',
    { ids: severalIdsSchema('albums'), ...sharedListFields },
    async (args) => {
      const albums = await fetchSeveral<SpotifyAlbumItem>(client, 'albums', 'albums', args.ids);
      if (!albums.length) throw new Error('No matching albums found');

      if (args.response_format === 'json') return jsonResult({ items: albums });
      return renderList(args.response_format, albums, {
        header: `Albums (${albums.length}):`,
        line: (album) =>
          `  • "${album.name}" by ${joinArtists(album)} (${album.album_type}, ${album.release_date}, ${album.total_tracks} tracks) | URI: ${album.uri}`,
        continuable: false,
        maxResults: args.max_results,
      });
    },
  );

  // get_several_artists
  server.tool(
    'get_several_artists',
    'Get full details for several artists by ID in a single call (up to 50 per request)',
    { ids: severalIdsSchema('artists'), ...sharedListFields },
    async (args) => {
      const artists = await fetchSeveral<SpotifyArtistFull>(client, 'artists', 'artists', args.ids);
      if (!artists.length) throw new Error('No matching artists found');

      if (args.response_format === 'json') return jsonResult({ items: artists });
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
      });
    },
  );

  // get_several_episodes
  server.tool(
    'get_several_episodes',
    'Get full details for several podcast episodes by ID in a single call (up to 50 per request)',
    { ids: severalIdsSchema('episodes'), ...sharedListFields },
    async (args) => {
      const episodes = await fetchSeveral<SpotifyEpisodeFull>(client, 'episodes', 'episodes', args.ids);
      if (!episodes.length) throw new Error('No matching episodes found');

      if (args.response_format === 'json') return jsonResult({ items: episodes });
      return renderList(args.response_format, episodes, {
        header: `Episodes (${episodes.length}):`,
        line: (ep) =>
          `  • "${ep.name}" (${formatDuration(ep.duration_ms)}, ${ep.release_date}) | URI: ${ep.uri}`,
        continuable: false,
        maxResults: args.max_results,
      });
    },
  );

  // get_several_shows
  server.tool(
    'get_several_shows',
    'Get full details for several podcast shows by ID in a single call (up to 50 per request)',
    { ids: severalIdsSchema('shows'), ...sharedListFields },
    async (args) => {
      const shows = await fetchSeveral<SpotifyShowFull>(client, 'shows', 'shows', args.ids);
      if (!shows.length) throw new Error('No matching shows found');

      if (args.response_format === 'json') return jsonResult({ items: shows });
      return renderList(args.response_format, shows, {
        header: `Shows (${shows.length}):`,
        line: (show) =>
          `  • "${show.name}" by ${show.publisher ?? 'unknown publisher'} (${show.total_episodes} episodes) | URI: ${show.uri}`,
        continuable: false,
        maxResults: args.max_results,
      });
    },
  );

  // get_several_audiobooks
  server.tool(
    'get_several_audiobooks',
    'Get full details for several audiobooks by ID in a single call (up to 50 per request). Audiobooks are only available in the US, UK, Canada, Ireland, New Zealand and Australia markets.',
    { ids: severalIdsSchema('audiobooks'), ...sharedListFields },
    async (args) => {
      const books = await fetchSeveral<SpotifyAudiobookSimple>(client, 'audiobooks', 'audiobooks', args.ids);
      if (!books.length) throw new Error('No matching audiobooks found');

      if (args.response_format === 'json') return jsonResult({ items: books });
      return renderList(args.response_format, books, {
        header: `Audiobooks (${books.length}):`,
        line: (book) => {
          const authors = (book.authors ?? []).map((a) => a.name).join(', ') || 'unknown author';
          return `  • "${book.name}" by ${authors} (${book.total_chapters} chapters) | URI: ${book.uri}`;
        },
        continuable: false,
        maxResults: args.max_results,
      });
    },
  );

  // get_several_chapters
  server.tool(
    'get_several_chapters',
    'Get full details for several audiobook chapters by ID in a single call (up to 50 per request)',
    { ids: severalIdsSchema('chapters'), ...sharedListFields },
    async (args) => {
      const chapters = await fetchSeveral<SpotifyChapterSimple>(client, 'chapters', 'chapters', args.ids);
      if (!chapters.length) throw new Error('No matching chapters found');

      if (args.response_format === 'json') return jsonResult({ items: chapters });
      return renderList(args.response_format, chapters, {
        header: `Chapters (${chapters.length}):`,
        line: (chapter) =>
          `  ${chapter.chapter_number}. "${chapter.name}" (${formatDuration(chapter.duration_ms)}) | URI: ${chapter.uri}`,
        continuable: false,
        maxResults: args.max_results,
      });
    },
  );

  // ----- gap-fill: get_category (#256) -----
  server.tool(
    'get_category',
    'Get a single Spotify browse category by ID. Removed Feb 2026, no replacement endpoint. Quota: 🟢 single.',
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
  type TypedSearchKind = 'track' | 'artist' | 'album' | 'playlist' | 'show' | 'episode' | 'audiobook';
  const typedSearchMeta: Record<TypedSearchKind, { tool: string; description: string; key: string }> = {
    track: { tool: 'search_tracks', description: 'Search tracks only (GET /search?type=track). Quota: 🟢 single.', key: 'tracks' },
    artist: { tool: 'search_artists', description: 'Search artists only (GET /search?type=artist). Quota: 🟢 single.', key: 'artists' },
    album: { tool: 'search_albums', description: 'Search albums only (GET /search?type=album). Quota: 🟢 single.', key: 'albums' },
    playlist: { tool: 'search_playlists', description: 'Search playlists only (GET /search?type=playlist). Quota: 🟢 single.', key: 'playlists' },
    show: { tool: 'search_shows', description: 'Search podcast shows only (GET /search?type=show). Quota: 🟢 single.', key: 'shows' },
    episode: { tool: 'search_episodes', description: 'Search podcast episodes only (GET /search?type=episode). Quota: 🟢 single.', key: 'episodes' },
    audiobook: { tool: 'search_audiobooks', description: 'Search audiobooks only (GET /search?type=audiobook). Audiobooks are only available in the US, UK, CA, IE, NZ and AU markets. Quota: 🟢 single.', key: 'audiobooks' },
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
            const pub = (o.publisher as string | undefined) ?? 'unknown publisher';
            extra = ` by ${pub}`;
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
        const pagination = paginationInfo({ total, offset, limit, returned: trunc.items.length });
        return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { query: args.query, type: kind, items: trunc.items, total, pagination } };
      },
    );
  }
  (['track', 'artist', 'album', 'playlist', 'show', 'episode', 'audiobook'] as TypedSearchKind[]).forEach(makeTypedSearchTool);

  // ----- catalog_batch_lookup (#268) -----
  server.tool(
    'catalog_batch_lookup',
    'Resolve a mixed list of Spotify URIs (tracks/albums/artists/shows/episodes/audiobooks/chapters) in partitioned batch calls. Quota: 🟡 1 per distinct type + chunking.',
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
      }
      if (groups.size === 0) {
        const why = [
          invalid.length ? `Invalid: ${invalid.join(', ')}` : '',
          unsupported.length ? `Unsupported here: ${unsupported.join(', ')}` : '',
        ].filter(Boolean).join(' | ');
        throw new Error(`No resolvable URIs. ${why}`);
      }
      const responseKeyMap: Record<string, string> = { tracks: 'tracks', albums: 'albums', artists: 'artists', shows: 'shows', episodes: 'episodes', audiobooks: 'audiobooks', chapters: 'chapters' };
      // One request per distinct type, but they do not have to queue up behind
      // each other (#779). Promise.all hands back the per-type groups in the
      // order they were partitioned above, so the rendered list is identical to
      // the sequential walk no matter which type answers first.
      const perKind = await Promise.all(
        [...groups].map(async ([kind, ids]) => {
          const key = responseKeyMap[kind] ?? kind;
          const items = await fetchSeveral<Record<string, unknown>>(client, kind as SeveralKind, key, ids);
          return items.map((item) => ({ type: kind, item }));
        }),
      );
      const allItems: Array<{ type: string; item: unknown }> = perKind.flat();
      if (args.response_format === 'json') {
        const raw: Record<string, unknown> = { items: allItems, invalid, unsupported };
        return { content: [{ type: 'text', text: JSON.stringify(raw) }], structuredContent: raw };
      }
      const cap = resolveMaxResults(args.max_results);
      const trunc = truncateItems(allItems, cap);
      const counts = [`${allItems.length} resolved`];
      if (invalid.length) counts.push(`${invalid.length} invalid skipped`);
      if (unsupported.length) counts.push(`${unsupported.length} unsupported skipped`);
      const lines = [`Batch lookup (${counts.join(', ')}):`];
      trunc.items.forEach(({ type, item }) => {
        const o = item as Record<string, unknown>;
        lines.push(`  \u2022 [${type}] "${(o.name as string) ?? (o.id as string)}" | URI: ${(o.uri as string) ?? ''}`);
      });
      if (trunc.footer) lines.push('', `(${trunc.footer})`);
      if (invalid.length) lines.push('', `Invalid URIs skipped (not readable as a Spotify URI): ${invalid.join(', ')}`);
      if (unsupported.length) lines.push('', `Unsupported here (well-formed, but no batch endpoint for this type): ${unsupported.join(', ')}`);
      return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { items: trunc.items, total: allItems.length, invalid, unsupported } };
    },
  );

  // ----- get_artist_singles / get_artist_appearances (#269, #270) -----
  server.tool(
    'get_artist_singles',
    "List an artist's singles only (GET /artists/{id}/albums?include_groups=single). Quota: 🟢 single.",
    {
      artist_id: spotifyId('artist'),
      limit: z.number().int().min(1).max(ARTIST_ALBUM_PAGE_LIMIT).optional().describe(`Results per page, 1–${ARTIST_ALBUM_PAGE_LIMIT}. Default: ${ARTIST_ALBUM_PAGE_LIMIT}`),
      offset: z.number().int().min(0).optional().describe('Offset. Default: 0'),
      market: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 country code'),
      ...sharedListFields,
    },
    async (args) => {
      const result = await getWithMarketFallback<SpotifyArtistAlbumsResponse>(client, `/artists/${encodeURIComponent(args.artist_id as string)}/albums`, args.market as string | undefined, { include_groups: 'single', limit: String(Math.min((args.limit as number) ?? ARTIST_ALBUM_PAGE_LIMIT, ARTIST_ALBUM_PAGE_LIMIT)), offset: String((args.offset as number) ?? 0) });
      if (!result) throw new Error(`Artist "${args.artist_id}" not found`);
      if (args.response_format === 'json') return jsonResult(result as unknown as Record<string, unknown>);
      return renderList(args.response_format as ResponseFormatValue, result.items, { header: `Singles for artist (${result.total} total):`, line: (album: SpotifyAlbumItem) => `  • "${album.name}" (${album.release_date}, ${album.total_tracks} tracks) | URI: ${album.uri}`, total: result.total, offset: args.offset as number | undefined, limit: Math.min((args.limit as number) ?? ARTIST_ALBUM_PAGE_LIMIT, ARTIST_ALBUM_PAGE_LIMIT), maxResults: args.max_results as number | undefined });
    },
  );
  server.tool(
    'get_artist_appearances',
    "List albums an artist appears on (GET /artists/{id}/albums?include_groups=appears_on). Quota: 🟢 single.",
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
      const result = await getWithMarketFallback<SpotifyArtistAlbumsResponse>(client, `/artists/${encodeURIComponent(args.artist_id as string)}/albums`, args.market as string | undefined, { include_groups: groups, limit: String(Math.min((args.limit as number) ?? ARTIST_ALBUM_PAGE_LIMIT, ARTIST_ALBUM_PAGE_LIMIT)), offset: String((args.offset as number) ?? 0) });
      if (!result) throw new Error(`Artist "${args.artist_id}" not found`);
      if (args.response_format === 'json') return jsonResult(result as unknown as Record<string, unknown>);
      return renderList(args.response_format as ResponseFormatValue, result.items, { header: `Appearances for artist (${result.total} total):`, line: (album: SpotifyAlbumItem) => `  • "${album.name}" (${album.album_type}, ${album.release_date}) | URI: ${album.uri}`, total: result.total, offset: args.offset as number | undefined, limit: Math.min((args.limit as number) ?? ARTIST_ALBUM_PAGE_LIMIT, ARTIST_ALBUM_PAGE_LIMIT), maxResults: args.max_results as number | undefined });
    },
  );

  // ----- market_validate (#271) -----
  server.tool(
    'market_validate',
    'Validate ISO 3166-1 market codes against GET /markets (cached) and optionally return the account market from /me. Quota: 🟢 1–2 calls.',
    {
      markets: z.array(MARKET_CODE).optional().describe('Market codes to validate (2-letter). If omitted, just lists valid markets / account market.'),
      include_account_market: z.boolean().optional().describe('Include account country from /me'),
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
        if (err instanceof SpotifyApiError && err.status === 403) {
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
    'Category → playlists → optional items peek in one call. Removed Feb 2026, no replacement endpoint. Quota: 🟡 2–3 calls.',
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
    'Full-text search within one show\'s episodes (GET /shows/{id}/episodes paged + client-side q). Quota: 🟡 1–N pages (fetch_all walks).',
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
