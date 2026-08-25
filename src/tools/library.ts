import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import type {
  SpotifyPaged,
  SavedTrackItem,
  SavedAlbumItem,
  SavedShowItem,
  SavedEpisodeItem,
} from '../types/spotify.js';

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

const SAVED_URI_TYPES = ['track', 'album', 'show', 'episode', 'audiobook'] as const;
type SavedUriType = (typeof SAVED_URI_TYPES)[number];

function partitionSavedUris(uris: string[]): Record<SavedUriType, string[]> {
  const buckets: Record<SavedUriType, string[]> = {
    track: [],
    album: [],
    show: [],
    episode: [],
    audiobook: [],
  };
  for (const uri of uris) {
    const match = /^spotify:(track|album|show|episode|audiobook):([^:]+)$/.exec(uri);
    if (!match) {
      throw new Error(
        `Unsupported URI type: ${uri} (supported: spotify:track:, spotify:album:, spotify:show:, spotify:episode:, spotify:audiobook:)`,
      );
    }
    buckets[match[1] as SavedUriType].push(match[2]);
  }
  return buckets;
}

// Shows AND audiobooks take `ids` ONLY as a query parameter (#12, #36): when
// `?ids=` is present any JSON body IDs are ignored, so the body form used by
// tracks/albums/episodes is a silent no-op for these types.
const IDS_AS_QUERY: Record<SavedUriType, boolean> = {
  track: false,
  album: false,
  show: true,
  episode: false,
  audiobook: true,
};

function savedItemsPath(type: SavedUriType, ids: string[]): string {
  if (!IDS_AS_QUERY[type]) return `/me/${type}s`;
  return `/me/${type}s?ids=${encodeURIComponent(ids.join(','))}`;
}

// Unified library endpoints (#37): the modern path accepting any mix of URI
// types — including artist/user/playlist follow state on contains — in a
// single request against /me/library instead of per-type bucket loops.
const LIBRARY_URI_RE = /^spotify:(track|album|episode|show|audiobook|artist|user|playlist):([^:]+)$/;
const LIBRARY_SAVE_TYPES = [
  'track',
  'album',
  'episode',
  'show',
  'audiobook',
  'user',
  'playlist',
] as const;
const LIBRARY_CHECK_TYPES = [...LIBRARY_SAVE_TYPES, 'artist'] as const;

function validateLibraryUris(uris: string[], supported: readonly string[]): void {
  for (const uri of uris) {
    const match = LIBRARY_URI_RE.exec(uri);
    if (!match || !supported.includes(match[1])) {
      throw new Error(
        `Unsupported URI type: ${uri} (supported: ${supported.map((t) => `spotify:${t}:`).join(', ')})`,
      );
    }
  }
}

function libraryUrisParam(uris: string[]): Record<string, string> {
  return { uris: uris.join(',') };
}

export function registerLibraryTools(server: McpServer, client: SpotifyClient): void {
  // get_saved_tracks
  server.tool(
    'get_saved_tracks',
    "Get tracks saved in the user's Liked Songs. Set fetch_all=true to retrieve the entire collection (capped at 500 items).",
    {
      limit: z.number().int().min(1).max(50).optional().describe('1–50. Default: 20'),
      offset: z.number().int().min(0).optional().describe('Pagination offset. Default: 0'),
      market: z.string().optional().describe('ISO 3166-1 alpha-2 country code'),
      fetch_all: z
        .boolean()
        .optional()
        .describe(
          'Fetch all pages instead of one page (ignores limit/offset; capped at 500 items)',
        ),
    },
    async (args) => {
      const params: Record<string, string> = {};
      if (!args.fetch_all) params.limit = String(args.limit ?? 20);
      if (!args.fetch_all && args.offset !== undefined) params.offset = String(args.offset);
      if (args.market) params.market = args.market;

      let items: SavedTrackItem[];
      let header: string;
      if (args.fetch_all) {
        params.limit = '50';
        items = await client.getAllPages<SavedTrackItem>('/me/tracks', params);
        header = `Liked Songs (${items.length} fetched, capped at 500):`;
      } else {
        const result = await client.get<SpotifyPaged<SavedTrackItem>>('/me/tracks', params);
        if (!result) throw new Error('Could not retrieve saved tracks');
        items = result.items;
        header = `Liked Songs (${result.total} total, showing ${items.length}):`;
      }

      const lines = [header];
      for (const item of items) {
        const artists = item.track.artists.map((a) => a.name).join(', ');
        lines.push(
          `  • "${item.track.name}" by ${artists} (${formatDuration(item.track.duration_ms)}) | URI: ${item.track.uri}`,
        );
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // get_saved_albums
  server.tool(
    'get_saved_albums',
    "Get albums saved in the user's library. Set fetch_all=true to retrieve the entire collection (capped at 500 items).",
    {
      limit: z.number().int().min(1).max(50).optional().describe('1–50. Default: 20'),
      offset: z.number().int().min(0).optional().describe('Pagination offset. Default: 0'),
      market: z.string().optional().describe('ISO 3166-1 alpha-2 country code'),
      fetch_all: z
        .boolean()
        .optional()
        .describe(
          'Fetch all pages instead of one page (ignores limit/offset; capped at 500 items)',
        ),
    },
    async (args) => {
      const params: Record<string, string> = {};
      if (!args.fetch_all) params.limit = String(args.limit ?? 20);
      if (!args.fetch_all && args.offset !== undefined) params.offset = String(args.offset);
      if (args.market) params.market = args.market;

      let items: SavedAlbumItem[];
      let header: string;
      if (args.fetch_all) {
        params.limit = '50';
        items = await client.getAllPages<SavedAlbumItem>('/me/albums', params);
        header = `Saved albums (${items.length} fetched, capped at 500):`;
      } else {
        const result = await client.get<SpotifyPaged<SavedAlbumItem>>('/me/albums', params);
        if (!result) throw new Error('Could not retrieve saved albums');
        items = result.items;
        header = `Saved albums (${result.total} total, showing ${items.length}):`;
      }

      const lines = [header];
      for (const item of items) {
        const artists = item.album.artists.map((a) => a.name).join(', ');
        lines.push(
          `  • "${item.album.name}" by ${artists} (${item.album.total_tracks} tracks, ${item.album.release_date}) | URI: ${item.album.uri}`,
        );
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // get_saved_shows
  server.tool(
    'get_saved_shows',
    "Get podcast shows saved in the user's library. Set fetch_all=true to retrieve the entire collection (capped at 500 items).",
    {
      limit: z.number().int().min(1).max(50).optional().describe('1–50. Default: 20'),
      offset: z.number().int().min(0).optional().describe('Pagination offset. Default: 0'),
      fetch_all: z
        .boolean()
        .optional()
        .describe(
          'Fetch all pages instead of one page (ignores limit/offset; capped at 500 items)',
        ),
    },
    async (args) => {
      const params: Record<string, string> = {};
      if (!args.fetch_all) params.limit = String(args.limit ?? 20);
      if (!args.fetch_all && args.offset !== undefined) params.offset = String(args.offset);

      let items: SavedShowItem[];
      let header: string;
      if (args.fetch_all) {
        params.limit = '50';
        items = await client.getAllPages<SavedShowItem>('/me/shows', params);
        header = `Saved shows (${items.length} fetched, capped at 500):`;
      } else {
        const result = await client.get<SpotifyPaged<SavedShowItem>>('/me/shows', params);
        if (!result) throw new Error('Could not retrieve saved shows');
        items = result.items;
        header = `Saved shows (${result.total} total, showing ${items.length}):`;
      }
      const lines = [header];

      for (const item of items) {
        lines.push(
          `  • "${item.show.name}" by ${item.show.publisher ?? 'unknown publisher'} (${item.show.total_episodes} episodes) | URI: ${item.show.uri}`,
        );
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // get_saved_episodes
  server.tool(
    'get_saved_episodes',
    "Get podcast episodes saved in the user's library. Set fetch_all=true to retrieve the entire collection (capped at 500 items).",
    {
      limit: z.number().int().min(1).max(50).optional().describe('1–50. Default: 20'),
      offset: z.number().int().min(0).optional().describe('Pagination offset. Default: 0'),
      market: z.string().optional().describe('ISO 3166-1 alpha-2 country code'),
      fetch_all: z
        .boolean()
        .optional()
        .describe(
          'Fetch all pages instead of one page (ignores limit/offset; capped at 500 items)',
        ),
    },
    async (args) => {
      const params: Record<string, string> = {};
      if (!args.fetch_all) params.limit = String(args.limit ?? 20);
      if (!args.fetch_all && args.offset !== undefined) params.offset = String(args.offset);
      if (args.market) params.market = args.market;

      let items: SavedEpisodeItem[];
      let header: string;
      if (args.fetch_all) {
        params.limit = '50';
        items = await client.getAllPages<SavedEpisodeItem>('/me/episodes', params);
        header = `Saved episodes (${items.length} fetched, capped at 500):`;
      } else {
        const result = await client.get<SpotifyPaged<SavedEpisodeItem>>('/me/episodes', params);
        if (!result) throw new Error('Could not retrieve saved episodes');
        items = result.items;
        header = `Saved episodes (${result.total} total, showing ${items.length}):`;
      }

      const lines = [header];
      for (const item of items) {
        lines.push(
          `  • "${item.episode.name}" — ${item.episode.show.name} (${formatDuration(item.episode.duration_ms)}, ${item.episode.release_date}) | URI: ${item.episode.uri}`,
        );
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // save_items
  server.tool(
    'save_items',
    "Save one or more items to the user's library. Accepts track, album, show, episode, and audiobook URIs (e.g. spotify:track:abc). Max 50.",
    {
      uris: z
        .array(z.string())
        .min(1)
        .max(50)
        .describe('Spotify URIs to save (e.g. ["spotify:track:abc", "spotify:album:xyz"])'),
    },
    async (args) => {
      const buckets = partitionSavedUris(args.uris);
      const counts: string[] = [];
      let saved = 0;
      for (const type of SAVED_URI_TYPES) {
        const ids = buckets[type];
        if (ids.length === 0) continue;
        await client.put(savedItemsPath(type, ids), IDS_AS_QUERY[type] ? undefined : { ids });
        counts.push(`${ids.length} ${type}${ids.length === 1 ? '' : 's'}`);
        saved += ids.length;
      }
      return {
        content: [{ type: 'text', text: `Saved ${saved} item(s) to library (${counts.join(', ')}).` }],
      };
    },
  );

  // remove_saved_items
  server.tool(
    'remove_saved_items',
    "Remove one or more items from the user's library. Accepts track, album, show, episode, and audiobook URIs (e.g. spotify:track:abc). Max 50.",
    {
      uris: z.array(z.string()).min(1).max(50).describe('Spotify URIs to remove'),
    },
    async (args) => {
      const buckets = partitionSavedUris(args.uris);
      let removed = 0;
      for (const type of SAVED_URI_TYPES) {
        const ids = buckets[type];
        if (ids.length === 0) continue;
        await client.delete(savedItemsPath(type, ids), IDS_AS_QUERY[type] ? undefined : { ids });
        removed += ids.length;
      }
      return {
        content: [{ type: 'text', text: `Removed ${removed} item(s) from library.` }],
      };
    },
  );

  // check_saved_items
  server.tool(
    'check_saved_items',
    "Check whether items are saved in the user's library. Returns a boolean per URI. Accepts track, album, show, episode, and audiobook URIs. Max 50.",
    {
      uris: z
        .array(z.string())
        .min(1)
        .max(50)
        .describe(
          'Spotify URIs to check (accepts tracks, albums, shows, episodes, audiobooks)',
        ),
    },
    async (args) => {
      const buckets = partitionSavedUris(args.uris);
      const savedByUri = new Map<string, boolean>();
      for (const type of SAVED_URI_TYPES) {
        const ids = buckets[type];
        if (ids.length === 0) continue;
        const contains = await client.get<boolean[]>(`/me/${type}s/contains`, {
          ids: ids.join(','),
        });
        if (!contains) throw new Error(`Could not check saved ${type}s`);
        ids.forEach((id, i) => savedByUri.set(`spotify:${type}:${id}`, contains[i] ?? false));
      }

      const lines = args.uris.map((uri, i) => `  ${savedByUri.get(uri) ? '✓' : '✗'} ${uri}`);
      return { content: [{ type: 'text', text: `Library check:\n${lines.join('\n')}` }] };
    },
  );

  // save_to_library (#37)
  server.tool(
    'save_to_library',
    "Save one or more items to the user's library via Spotify's unified library endpoint, in a single request. Accepts track, album, episode, show, audiobook, user, and playlist URIs in any mix. Max 40.",
    {
      uris: z
        .array(z.string())
        .min(1)
        .max(40)
        .describe('Spotify URIs to save (e.g. ["spotify:track:abc", "spotify:user:xyz"])'),
    },
    async (args) => {
      validateLibraryUris(args.uris, LIBRARY_SAVE_TYPES);
      await client.put(`/me/library?${new URLSearchParams(libraryUrisParam(args.uris)).toString()}`);
      return {
        content: [{ type: 'text', text: `Saved ${args.uris.length} item(s) to library.` }],
      };
    },
  );

  // remove_from_library (#37)
  server.tool(
    'remove_from_library',
    "Remove one or more items from the user's library via Spotify's unified library endpoint, in a single request. Accepts track, album, episode, show, audiobook, user, and playlist URIs in any mix. Max 40.",
    {
      uris: z
        .array(z.string())
        .min(1)
        .max(40)
        .describe('Spotify URIs to remove'),
    },
    async (args) => {
      validateLibraryUris(args.uris, LIBRARY_SAVE_TYPES);
      await client.delete(
        `/me/library?${new URLSearchParams(libraryUrisParam(args.uris)).toString()}`,
      );
      return {
        content: [{ type: 'text', text: `Removed ${args.uris.length} item(s) from library.` }],
      };
    },
  );

  // check_in_library (#37)
  server.tool(
    'check_in_library',
    "Check whether items are saved in or followed by the user. Returns a boolean per URI via Spotify's unified endpoint. Accepts track, album, episode, show, audiobook, artist, user, and playlist URIs in any mix. Max 40.",
    {
      uris: z
        .array(z.string())
        .min(1)
        .max(40)
        .describe(
          'Spotify URIs to check (accepts tracks, albums, episodes, shows, audiobooks, artists, users, playlists)',
        ),
    },
    async (args) => {
      validateLibraryUris(args.uris, LIBRARY_CHECK_TYPES);
      const contains = await client.get<boolean[]>(
        '/me/library/contains',
        libraryUrisParam(args.uris),
      );
      if (!contains) throw new Error('Could not check library state');
      const lines = args.uris.map((uri, i) => `  ${contains[i] ? '✓' : '✗'} ${uri}`);
      return { content: [{ type: 'text', text: `Library check:\n${lines.join('\n')}` }] };
    },
  );
}
