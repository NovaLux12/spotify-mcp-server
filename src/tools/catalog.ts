import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SpotifyApiError, type SpotifyClient } from '../client.js';
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
import { getConfig, resolveMarket } from '../config.js';


// Issue #110: market codes are exactly two letters; lowercase input is
// normalised to uppercase before it reaches the wire.
export const MARKET_CODE = z
  .string()
  .regex(/^[A-Za-z]{2}$/, 'market must be a 2-letter ISO 3166-1 alpha-2 country code, e.g. "US"')
  .transform((code) => code.toUpperCase());

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
const SEVERAL_LIMITS = {
  tracks: 50,
  albums: 20,
  artists: 50,
  episodes: 50,
  shows: 50,
  audiobooks: 50,
  chapters: 50,
} as const;

type SeveralKind = keyof typeof SEVERAL_LIMITS;

async function fetchSeveral<T>(
  client: SpotifyClient,
  kind: SeveralKind,
  responseKey: string,
  ids: string[],
): Promise<T[]> {
  const limit = SEVERAL_LIMITS[kind];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += limit) {
    chunks.push(ids.slice(i, i + limit));
  }

  const merged: T[] = [];
  for (const chunk of chunks) {
    // Feb 2026: all "Get Several" batch endpoints were removed for app
    // registrations created after Nov 2024 (403). Fail with an explanation
    // rather than a raw API error.
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
    for (const item of res?.[responseKey] ?? []) {
      if (item != null) merged.push(item);
    }
  }
  return merged;
}

function severalIdsSchema(kind: SeveralKind) {
  const max = SEVERAL_LIMITS[kind];
  return z
    .array(z.string().min(1))
    .min(1)
    .describe(
      `Spotify ${kind} IDs (1–${max} per request; longer lists are fetched in chunks of ${max} and merged)`,
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
    { id: z.string().describe('Spotify track ID'), response_format: ResponseFormat },
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
    { id: z.string().describe('Spotify artist ID'), response_format: ResponseFormat },
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
      id: z.string().describe('Spotify artist ID'),
      include_groups: z
        .array(z.enum(['album', 'single', 'appears_on', 'compilation']))
        .optional()
        .describe('Album types to include. Default: ["album","single"]'),
      // Feb-2026: /artists/{id}/albums hard-caps limit at 10 (400 above).
      limit: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('Results per page, 1–10. Default: 10'),
      offset: z.number().int().min(0).optional().describe('Index of the first album to return. Default: 0'),
      market: MARKET_CODE.optional().describe(
        'ISO 3166-1 alpha-2 country code. Defaults to the account country; affects album availability.',
      ),
      ...sharedListFields,
    },
    async (args) => {
      const result = await getWithMarketFallback<SpotifyArtistAlbumsResponse>(
        client,
        `/artists/${encodeURIComponent(args.id)}/albums`,
        args.market,
        {
          include_groups: (args.include_groups ?? ['album', 'single']).join(','),
          limit: String(args.limit ?? 10),
          offset: String(args.offset ?? 0),
        },
      );
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
        limit: args.limit ?? 10,
        maxResults: args.max_results,
      });
    },
  );

  // get_album
  server.tool(
    'get_album',
    'Get album details and track list by ID',
    {
      id: z.string().describe('Spotify album ID'),
      market: MARKET_CODE.optional().describe(
        'ISO 3166-1 alpha-2 country code. Defaults to the account country; affects track playability.',
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
      id: z.string().describe('Spotify album ID'),
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
      ...sharedListFields,
    },
    async (args) => {
      const result = await getWithMarketFallback<SpotifyPaged<SpotifyTrackSimple>>(
        client,
        `/albums/${encodeURIComponent(args.id)}/tracks`,
        args.market,
        {
          limit: String(args.limit ?? 20),
          offset: String(args.offset ?? 0),
        },
      );
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
      id: z.string().describe('Spotify show ID'),
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

      if (show.episodes?.items.length) {
        lines.push('', 'Recent episodes:');
        for (const ep of show.episodes.items.slice(0, 10)) {
          const played = ep.resume_point?.fully_played ? ' [played]' : '';
          lines.push(
            `  • "${ep.name}" (${formatDuration(ep.duration_ms)}, ${ep.release_date})${played} | URI: ${ep.uri}`,
          );
        }
      }

      return renderSingle(args.response_format, show as unknown as Record<string, unknown>, lines);
    },
  );

  // get_show_episodes
  server.tool(
    'get_show_episodes',
    "List a podcast show's episodes with pagination. Resume positions require the user-read-playback-position scope.",
    {
      id: z.string().describe('Spotify show ID'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Results per page, 1–50. Default: 20'),
      offset: z.number().int().min(0).optional().describe('Index of the first episode to return. Default: 0'),
      market: MARKET_CODE.optional().describe(
        'ISO 3166-1 alpha-2 country code. If given, only shows and episodes available in that market are returned.',
      ),
      ...sharedListFields,
    },
    async (args) => {
      const result = await getWithMarketFallback<SpotifyPaged<SpotifyEpisodeSimple>>(
        client,
        `/shows/${encodeURIComponent(args.id)}/episodes`,
        args.market,
        {
          limit: String(args.limit ?? 20),
          offset: String(args.offset ?? 0),
        },
      );
      if (!result) throw new Error(`Show "${args.id}" not found`);

      if (args.response_format === 'json') {
        return jsonResult(result as unknown as Record<string, unknown>);
      }
      return renderList(args.response_format, result.items, {
        header: `Episodes (${result.total} total):`,
        line: (ep) => {
          const played = ep.resume_point?.fully_played ? ' [played]' : '';
          return `  • "${ep.name}" (${formatDuration(ep.duration_ms)}, ${ep.release_date})${played} | URI: ${ep.uri}`;
        },
        total: result.total,
        offset: args.offset,
        limit: args.limit ?? 20,
        maxResults: args.max_results,
      });
    },
  );

  // get_episode
  server.tool(
    'get_episode',
    'Get full details for a podcast episode',
    {
      id: z.string().describe('Spotify episode ID'),
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
      id: z.string().describe('Spotify artist ID'),
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
    'Get a single Spotify browse category by ID (GET /browse/categories/{id}). Quota: 🟢 single.',
    {
      category_id: z.string().min(1).describe('Category ID from get_categories'),
      country: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 country code, e.g. \'US\''),
      locale: z.string().optional().describe('Locale, e.g. en_US'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const params: Record<string, string> = {};
      if (args.country) params.country = args.country;
      if (args.locale) params.locale = args.locale;
      const data = await client.get<Record<string, unknown>>(
        `/browse/categories/${encodeURIComponent(args.category_id)}`,
        params,
      );
      if (!data) throw new Error(`Category "${args.category_id}" not found`);
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
        if (args.response_format === 'json') {
          const r = raw as Record<string, unknown>;
          return { content: [{ type: 'text', text: JSON.stringify(r) }], structuredContent: r };
        }
        const section = (raw as Record<string, unknown>)[meta.key] as { items?: unknown[]; total?: number } | undefined;
        const items = (section?.items ?? []).filter(Boolean) as unknown[];
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
      const invalid: string[] = [];
      for (const uri of uris) {
        const parsed = parseSpotifyUri(uri);
        if (!parsed) { invalid.push(uri); continue; }
        const type = parsed.type;
        // normalize plural key for fetchSeveral
        const kindMap: Record<string, string> = { track: 'tracks', album: 'albums', artist: 'artists', playlist: 'playlists', show: 'shows', episode: 'episodes', audiobook: 'audiobooks', chapter: 'chapters' };
        const kind = kindMap[type];
        if (!kind) { invalid.push(uri); continue; }
        // playlists use different endpoint not in fetchSeveral; skip with note
        if (kind === 'playlists') { invalid.push(uri); continue; }
        const arr = groups.get(kind) ?? [];
        arr.push(parsed.id);
        groups.set(kind, arr);
      }
      if (groups.size === 0) throw new Error(`No resolvable URIs. Invalid: ${invalid.join(', ')}`);
      const responseKeyMap: Record<string, string> = { tracks: 'tracks', albums: 'albums', artists: 'artists', shows: 'shows', episodes: 'episodes', audiobooks: 'audiobooks', chapters: 'chapters' };
      const allItems: Array<{ type: string; item: unknown }> = [];
      for (const [kind, ids] of groups) {
        const key = responseKeyMap[kind] ?? kind;
        const items = await fetchSeveral<Record<string, unknown>>(client, kind as SeveralKind, key, ids);
        for (const it of items) allItems.push({ type: kind, item: it });
      }
      if (args.response_format === 'json') {
        const raw: Record<string, unknown> = { items: allItems, invalid };
        return { content: [{ type: 'text', text: JSON.stringify(raw) }], structuredContent: raw };
      }
      const cap = resolveMaxResults(args.max_results);
      const trunc = truncateItems(allItems, cap);
      const lines = [`Batch lookup (${allItems.length} resolved${invalid.length ? `, ${invalid.length} invalid skipped` : ''}):`];
      trunc.items.forEach(({ type, item }) => {
        const o = item as Record<string, unknown>;
        lines.push(`  \u2022 [${type}] "${(o.name as string) ?? (o.id as string)}" | URI: ${(o.uri as string) ?? ''}`);
      });
      if (trunc.footer) lines.push('', `(${trunc.footer})`);
      if (invalid.length) lines.push('', `Invalid URIs skipped: ${invalid.join(', ')}`);
      return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { items: trunc.items, total: allItems.length, invalid } };
    },
  );

  // ----- get_artist_singles / get_artist_appearances (#269, #270) -----
  server.tool(
    'get_artist_singles',
    "List an artist's singles only (GET /artists/{id}/albums?include_groups=single). Quota: 🟢 single.",
    {
      artist_id: z.string().describe('Spotify artist ID'),
      limit: z.number().int().min(1).max(10).optional().describe('Results per page, 1–10. Default: 10'),
      offset: z.number().int().min(0).optional().describe('Offset. Default: 0'),
      market: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 country code'),
      ...sharedListFields,
    },
    async (args) => {
      const result = await getWithMarketFallback<SpotifyArtistAlbumsResponse>(client, `/artists/${encodeURIComponent(args.artist_id as string)}/albums`, args.market as string | undefined, { include_groups: 'single', limit: String((args.limit as number) ?? 10), offset: String((args.offset as number) ?? 0) });
      if (!result) throw new Error(`Artist "${args.artist_id}" not found`);
      if (args.response_format === 'json') return jsonResult(result as unknown as Record<string, unknown>);
      return renderList(args.response_format as ResponseFormatValue, result.items, { header: `Singles for artist (${result.total} total):`, line: (album: SpotifyAlbumItem) => `  \u2022 "${album.name}" (${album.release_date}, ${album.total_tracks} tracks) | URI: ${album.uri}`, total: result.total, offset: args.offset as number | undefined, limit: (args.limit as number) ?? 10, maxResults: args.max_results as number | undefined });
    },
  );
  server.tool(
    'get_artist_appearances',
    "List albums an artist appears on (GET /artists/{id}/albums?include_groups=appears_on). Quota: 🟢 single.",
    {
      artist_id: z.string().describe('Spotify artist ID'),
      limit: z.number().int().min(1).max(10).optional().describe('Results per page, 1–10. Default: 10'),
      offset: z.number().int().min(0).optional().describe('Offset. Default: 0'),
      market: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 country code'),
      include_groups: z.array(z.enum(['appears_on', 'compilation'])).optional().describe('Default: ["appears_on"]'),
      ...sharedListFields,
    },
    async (args) => {
      const groups = ((args.include_groups as string[] | undefined) ?? ['appears_on']).join(',');
      const result = await getWithMarketFallback<SpotifyArtistAlbumsResponse>(client, `/artists/${encodeURIComponent(args.artist_id as string)}/albums`, args.market as string | undefined, { include_groups: groups, limit: String((args.limit as number) ?? 10), offset: String((args.offset as number) ?? 0) });
      if (!result) throw new Error(`Artist "${args.artist_id}" not found`);
      if (args.response_format === 'json') return jsonResult(result as unknown as Record<string, unknown>);
      return renderList(args.response_format as ResponseFormatValue, result.items, { header: `Appearances for artist (${result.total} total):`, line: (album: SpotifyAlbumItem) => `  \u2022 "${album.name}" (${album.album_type}, ${album.release_date}) | URI: ${album.uri}`, total: result.total, offset: args.offset as number | undefined, limit: (args.limit as number) ?? 10, maxResults: args.max_results as number | undefined });
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
    'Category → playlists → optional items peek in one call (GET /browse/categories/{id} + /playlists (+ /playlists/{id}/tracks peek)). Quota: 🟡 2–3 calls.',
    {
      category_id: z.string().min(1).describe('Category ID from get_categories'),
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
      const category = await client.get<Record<string, unknown>>(`/browse/categories/${encodeURIComponent(args.category_id as string)}`, catParams);
      if (!category) throw new Error(`Category "${args.category_id}" not found`);
      const plParams: Record<string, string> = {};
      if (args.country) plParams.country = args.country as string;
      if (args.limit !== undefined) plParams.limit = String(args.limit);
      const plData = await client.get<{ playlists: SpotifyPaged<SpotifyAlbumItem & { owner?: { display_name?: string; id?: string } }> }>(`/browse/categories/${encodeURIComponent(args.category_id as string)}/playlists`, plParams);
      const playlists = plData?.playlists;
      let peek: unknown[] | null = null;
      if (args.peek_items && playlists?.items?.length) {
        const first = playlists.items[0] as { id?: string };
        if (first?.id) {
          try {
            const itemsData = await client.get<{ items: unknown[] }>(`/playlists/${encodeURIComponent(first.id)}/tracks`, { limit: '2' });
            peek = itemsData?.items ?? null;
          } catch { peek = null; }
        }
      }
      if (args.response_format === 'json') {
        const raw: Record<string, unknown> = { category, playlists, peek };
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
        if (peek?.length) {
          lines.push('', 'Peek (first playlist, 2 tracks):');
          (peek as Array<Record<string, unknown>>).slice(0, 2).forEach((it) => {
            const track = (it.track ?? it) as Record<string, unknown>;
            lines.push(`  - "${(track.name as string) ?? 'unknown'}" | URI: ${(track.uri as string) ?? ''}`);
          });
        }
      }
      return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { category, playlists, peek } };
    },
  );

  // ----- show_episode_search (rank 60 / #318) -----
  server.tool(
    'show_episode_search',
    'Full-text search within one show\'s episodes (GET /shows/{id}/episodes paged + client-side q). Quota: 🟡 1–N pages (fetch_all walks).',
    {
      show_id: z.string().min(1).describe('Spotify show ID'),
      query: z.string().min(1).describe('Case-insensitive substring over name/description'),
      limit: z.number().int().min(1).max(50).optional().describe('Results per page for the underlying paging, 1–50. Default: 20'),
      offset: z.number().int().min(0).optional().describe('Offset for underlying paging. Default: 0'),
      market: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 country code, e.g. \'US\''),
      fetch_all: z.boolean().optional().describe('When true, walk all pages (up to cap) to find matches'),
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
      const walk = async (off: number, lim: number) => {
        const params: Record<string, string> = { limit: String(lim), offset: String(off) };
        if (market) params.market = market;
        const page = await client.get<SpotifyPaged<SpotifyEpisodeSimple>>(`/shows/${encodeURIComponent(args.show_id as string)}/episodes`, params);
        if (!page) return null;
        total = page.total;
        for (const ep of page.items) {
          const hay = `${ep.name} ${ep.description ?? ''}`.toLowerCase();
          if (hay.includes(q)) matches.push(ep);
        }
        return page;
      };
      if (fetchAll) {
        let off = 0;
        const pageSize = 50;
        while (true) {
          const page = await walk(off, pageSize);
          if (!page || page.items.length < pageSize || off + pageSize >= (page.total ?? 0)) break;
          off += pageSize;
          if (off > 500) break; // safety cap
        }
      } else {
        await walk(offset, limit);
      }
      if (args.response_format === 'json') {
        const raw: Record<string, unknown> = { show_id: args.show_id, query: args.query, total_episodes: total, matches };
        return { content: [{ type: 'text', text: JSON.stringify(raw) }], structuredContent: raw };
      }
      if (matches.length === 0) return { content: [{ type: 'text', text: `No episodes matching "${args.query}" in show ${args.show_id}.` }] };
      const cap = resolveMaxResults(args.max_results as number | undefined);
      const trunc = truncateItems(matches, cap);
      const lines = [`Episodes matching "${args.query}" in show ${args.show_id} (${matches.length} of ${total} total):`];
      trunc.items.forEach((ep) => lines.push(`  \u2022 "${ep.name}" (${formatDuration(ep.duration_ms)}, ${ep.release_date}) | URI: ${ep.uri}`));
      if (trunc.footer) lines.push('', `(${trunc.footer})`);
      return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { show_id: args.show_id, query: args.query, total_episodes: total, matches: trunc.items, pagination: paginationInfo({ total: matches.length, offset: 0, limit: null, returned: trunc.items.length }) } };
    },
  );
}
