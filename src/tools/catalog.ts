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
  type ResponseFormatValue,
} from '../shaping.js';

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
  const market = marketArg ?? (await resolveProfileCountry(client));
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
    const res = await client.get<Partial<Record<string, Array<T | null>>>>(`/${kind}`, {
      ids: chunk.map((id) => encodeURIComponent(id)).join(','),
    });
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
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Results per page, 1–50. Default: 20'),
      offset: z.number().int().min(0).optional().describe('Index of the first album to return. Default: 0'),
      market: z.string().optional().describe(
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
          limit: String(args.limit ?? 20),
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
        limit: args.limit ?? 20,
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
      market: z.string().optional().describe(
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
      market: z.string().optional().describe(
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
      market: z.string().optional().describe('ISO 3166-1 alpha-2 country code'),
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
      market: z.string().optional().describe(
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
      market: z.string().optional().describe('ISO 3166-1 alpha-2 country code'),
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

      if (episode.audio_preview_url) {
        lines.push(`Preview: ${episode.audio_preview_url}`);
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
    "Get an artist's ten most-played tracks for a market",
    {
      id: z.string().describe('Spotify artist ID'),
      market: z.string().optional().describe(
        'ISO 3166-1 alpha-2 country code. Defaults to the account country.',
      ),
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
    'List the country codes of every market where Spotify is available — useful for validating market inputs to other tools',
    { ...sharedListFields },
    async (args) => {
      const data = await client.get<{
        markets?: Array<{ name?: string; codes?: string[] } | string>;
      }>('/markets');
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
}
