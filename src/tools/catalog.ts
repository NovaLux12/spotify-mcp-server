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

export function registerCatalogTools(server: McpServer, client: SpotifyClient): void {
  // get_track
  server.tool(
    'get_track',
    'Get full details for a track by ID',
    { id: z.string().describe('Spotify track ID') },
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
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // get_artist
  server.tool(
    'get_artist',
    'Get artist info by ID',
    { id: z.string().describe('Spotify artist ID') },
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
      return { content: [{ type: 'text', text: lines.join('\n') }] };
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

      const lines = [`Albums for artist (${result.total} total):`];
      for (const album of result.items) {
        const artists = album.artists.map((a) => a.name).join(', ');
        lines.push(
          `  • "${album.name}" by ${artists} (${album.album_type}, ${album.release_date}, ${album.total_tracks} tracks) | URI: ${album.uri}`,
        );
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
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
    },
    async (args) => {
      const album = await getWithMarketFallback<SpotifyAlbumFull>(
        client,
        `/albums/${encodeURIComponent(args.id)}`,
        args.market,
      );
      if (!album) throw new Error(`Album "${args.id}" not found`);


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
      return { content: [{ type: 'text', text: lines.join('\n') }] };
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
      const lines = [`Tracks for album (${result.total} total):`];
      for (const track of result.items) {
        const trackArtists = track.artists.map((a) => a.name).join(', ');
        lines.push(
          `  ${track.track_number}. "${track.name}" by ${trackArtists} (${formatDuration(track.duration_ms)}) | URI: ${track.uri}`,
        );
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // get_show
  server.tool(
    'get_show',
    'Get full details for a podcast show',
    {
      id: z.string().describe('Spotify show ID'),
      market: z.string().optional().describe('ISO 3166-1 alpha-2 country code'),
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

      return { content: [{ type: 'text', text: lines.join('\n') }] };
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

      const lines = [`Episodes (${result.total} total):`];
      for (const ep of result.items) {
        const played = ep.resume_point?.fully_played ? ' [played]' : '';
        lines.push(
          `  • "${ep.name}" (${formatDuration(ep.duration_ms)}, ${ep.release_date})${played} | URI: ${ep.uri}`,
        );
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // get_episode
  server.tool(
    'get_episode',
    'Get full details for a podcast episode',
    {
      id: z.string().describe('Spotify episode ID'),
      market: z.string().optional().describe('ISO 3166-1 alpha-2 country code'),
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

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // get_me
  server.tool(
    'get_me',
    "Get the current user's Spotify profile: display name, user ID, email, country, and subscription level. Email requires the user-read-email scope; country and product require user-read-private.",
    {},
    async () => {
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
      return { content: [{ type: 'text', text: lines.join('\n') }] };
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

      const tracks = result.tracks ?? [];
      const lines = [`Top tracks (${tracks.length}):`];
      tracks.forEach((track, i) => {
        lines.push(
          `  ${i + 1}. "${track.name}" by ${joinArtists(track)} (${formatDuration(track.duration_ms)}) | URI: ${track.uri}`,
        );
      });
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // get_available_markets
  server.tool(
    'get_available_markets',
    'List the country codes of every market where Spotify is available — useful for validating market inputs to other tools',
    {},
    async () => {
      const data = await client.get<{
        markets?: Array<{ name?: string; codes?: string[] } | string>;
      }>('/markets');
      if (!data?.markets?.length) throw new Error('Available markets list is empty or unavailable');

      const lines = [`Available markets (${data.markets.length}):`];
      for (const market of data.markets) {
        if (typeof market === 'string') {
          lines.push(`  • ${market}`);
        } else if (market.codes?.length) {
          lines.push(`  • ${market.name ?? 'Unknown'} (${market.codes.join(', ')})`);
        } else {
          lines.push(`  • ${market.name ?? 'Unknown'}`);
        }
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // get_several_tracks
  server.tool(
    'get_several_tracks',
    'Get full details for several tracks by ID in a single call (up to 50 per request)',
    { ids: severalIdsSchema('tracks') },
    async (args) => {
      const tracks = await fetchSeveral<SpotifyTrack>(client, 'tracks', 'tracks', args.ids);
      if (!tracks.length) throw new Error('No matching tracks found');

      const lines = [`Tracks (${tracks.length}):`];
      for (const track of tracks) {
        lines.push(
          `  • "${track.name}" by ${joinArtists(track)} (${formatDuration(track.duration_ms)}) | URI: ${track.uri}`,
        );
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // get_several_albums
  server.tool(
    'get_several_albums',
    'Get full details for several albums by ID in a single call (up to 20 per request)',
    { ids: severalIdsSchema('albums') },
    async (args) => {
      const albums = await fetchSeveral<SpotifyAlbumItem>(client, 'albums', 'albums', args.ids);
      if (!albums.length) throw new Error('No matching albums found');

      const lines = [`Albums (${albums.length}):`];
      for (const album of albums) {
        lines.push(
          `  • "${album.name}" by ${joinArtists(album)} (${album.album_type}, ${album.release_date}, ${album.total_tracks} tracks) | URI: ${album.uri}`,
        );
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // get_several_artists
  server.tool(
    'get_several_artists',
    'Get full details for several artists by ID in a single call (up to 50 per request)',
    { ids: severalIdsSchema('artists') },
    async (args) => {
      const artists = await fetchSeveral<SpotifyArtistFull>(client, 'artists', 'artists', args.ids);
      if (!artists.length) throw new Error('No matching artists found');

      const lines = [`Artists (${artists.length}):`];
      for (const item of artists) {
        const genres = Array.isArray(item.genres) && item.genres.length > 0
          ? ` (${item.genres.join(', ')})`
          : '';
        lines.push(`  • Artist: ${item.name}${genres} | URI: ${item.uri}`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // get_several_episodes
  server.tool(
    'get_several_episodes',
    'Get full details for several podcast episodes by ID in a single call (up to 50 per request)',
    { ids: severalIdsSchema('episodes') },
    async (args) => {
      const episodes = await fetchSeveral<SpotifyEpisodeFull>(client, 'episodes', 'episodes', args.ids);
      if (!episodes.length) throw new Error('No matching episodes found');

      const lines = [`Episodes (${episodes.length}):`];
      for (const ep of episodes) {
        lines.push(
          `  • "${ep.name}" (${formatDuration(ep.duration_ms)}, ${ep.release_date}) | URI: ${ep.uri}`,
        );
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // get_several_shows
  server.tool(
    'get_several_shows',
    'Get full details for several podcast shows by ID in a single call (up to 50 per request)',
    { ids: severalIdsSchema('shows') },
    async (args) => {
      const shows = await fetchSeveral<SpotifyShowFull>(client, 'shows', 'shows', args.ids);
      if (!shows.length) throw new Error('No matching shows found');

      const lines = [`Shows (${shows.length}):`];
      for (const show of shows) {
        lines.push(
          `  • "${show.name}" by ${show.publisher ?? 'unknown publisher'} (${show.total_episodes} episodes) | URI: ${show.uri}`,
        );
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // get_several_audiobooks
  server.tool(
    'get_several_audiobooks',
    'Get full details for several audiobooks by ID in a single call (up to 50 per request). Audiobooks are only available in the US, UK, Canada, Ireland, New Zealand and Australia markets.',
    { ids: severalIdsSchema('audiobooks') },
    async (args) => {
      const books = await fetchSeveral<SpotifyAudiobookSimple>(client, 'audiobooks', 'audiobooks', args.ids);
      if (!books.length) throw new Error('No matching audiobooks found');

      const lines = [`Audiobooks (${books.length}):`];
      for (const book of books) {
        const authors = (book.authors ?? []).map((a) => a.name).join(', ') || 'unknown author';
        lines.push(
          `  • "${book.name}" by ${authors} (${book.total_chapters} chapters) | URI: ${book.uri}`,
        );
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // get_several_chapters
  server.tool(
    'get_several_chapters',
    'Get full details for several audiobook chapters by ID in a single call (up to 50 per request)',
    { ids: severalIdsSchema('chapters') },
    async (args) => {
      const chapters = await fetchSeveral<SpotifyChapterSimple>(client, 'chapters', 'chapters', args.ids);
      if (!chapters.length) throw new Error('No matching chapters found');

      const lines = [`Chapters (${chapters.length}):`];
      for (const chapter of chapters) {
        lines.push(
          `  ${chapter.chapter_number}. "${chapter.name}" (${formatDuration(chapter.duration_ms)}) | URI: ${chapter.uri}`,
        );
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );
}
