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
          `  • "${item.show.name}" by ${item.show.publisher} (${item.show.total_episodes} episodes) | URI: ${item.show.uri}`,
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
    "Save one or more items to the user's library. Accepts track, album, show, and episode URIs (e.g. spotify:track:abc). Max 50.",
    {
      uris: z
        .array(z.string())
        .min(1)
        .max(50)
        .describe('Spotify URIs to save (e.g. ["spotify:track:abc", "spotify:album:xyz"])'),
    },
    async (args) => {
      await client.put('/me/library', { uris: args.uris });
      return { content: [{ type: 'text', text: `Saved ${args.uris.length} item(s) to library.` }] };
    },
  );

  // remove_saved_items
  server.tool(
    'remove_saved_items',
    "Remove one or more items from the user's library. Max 50.",
    {
      uris: z.array(z.string()).min(1).max(50).describe('Spotify URIs to remove'),
    },
    async (args) => {
      await client.delete('/me/library', { uris: args.uris });
      return {
        content: [{ type: 'text', text: `Removed ${args.uris.length} item(s) from library.` }],
      };
    },
  );

  // check_saved_items
  server.tool(
    'check_saved_items',
    "Check whether items are saved in the user's library. Returns a boolean per URI. Max 40.",
    {
      uris: z
        .array(z.string())
        .min(1)
        .max(40)
        .describe(
          'Spotify URIs to check (accepts tracks, albums, shows, episodes, artists, playlists)',
        ),
    },
    async (args) => {
      const result = await client.get<boolean[]>('/me/library/contains', {
        uris: args.uris.join(','),
      });
      if (!result) throw new Error('Could not check saved items');

      const lines = args.uris.map((uri, i) => `  ${result[i] ? '✓' : '✗'} ${uri}`);
      return { content: [{ type: 'text', text: `Library check:\n${lines.join('\n')}` }] };
    },
  );
}
