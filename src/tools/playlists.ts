import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import type {
  SpotifyPaged,
  SpotifyPlaylistSimple,
  PlaylistItemsResponse,
  SpotifyImage,
} from '../types/spotify.js';

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// Hard cap for fetch_all pagination loops
const FETCH_ALL_CAP = 500;

// Playlist metadata as returned by GET /playlists/{id}, which includes cover
// images (unlike the simplified playlists in paged listings)
interface PlaylistWithImages extends SpotifyPlaylistSimple {
  images?: SpotifyImage[] | null;
}

export function registerPlaylistTools(server: McpServer, client: SpotifyClient): void {
  // get_user_playlists
  server.tool(
    'get_user_playlists',
    "List the current user's playlists",
    {
      limit: z.number().int().min(1).max(50).optional().describe('1–50. Default: 20'),
      offset: z.number().int().min(0).optional().describe('Pagination offset. Default: 0'),
      fetch_all: z
        .boolean()
        .optional()
        .describe('Fetch every page (up to 500 playlists) instead of a single page'),
    },
    async (args) => {
      const limit = String(args.limit ?? 20);
      const params: Record<string, string> = { limit };
      if (args.offset !== undefined) params.offset = String(args.offset);

      const result = await client.get<SpotifyPaged<SpotifyPlaylistSimple>>('/me/playlists', params);
      if (!result) throw new Error('Could not retrieve playlists');

      let total = result.total;
      const items = [...result.items];
      if (args.fetch_all) {
        while (items.length < Math.min(total, FETCH_ALL_CAP)) {
          const page = await client.get<SpotifyPaged<SpotifyPlaylistSimple>>('/me/playlists', {
            limit,
            offset: String(items.length),
          });
          if (!page || page.items.length === 0) break;
          items.push(...page.items);
          total = page.total;
        }
        if (items.length > FETCH_ALL_CAP) items.length = FETCH_ALL_CAP;
      }

      const lines = [`Your playlists (${total} total, showing ${items.length}):`];
      for (const pl of items) {
        const trackCount = pl.tracks?.total ?? 0;
        const owner = pl.owner.display_name ?? pl.owner.id;
        lines.push(
          `  • "${pl.name}" by ${owner} (${trackCount} tracks) | ID: ${pl.id} | URI: ${pl.uri}`,
        );
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // get_playlist
  server.tool(
    'get_playlist',
    "Get a playlist's metadata (including cover image) and items",
    {
      id: z.string().describe('Playlist ID'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Items per page, 1–100. Default: 50'),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Pagination offset for items. Default: 0'),
      fetch_all: z
        .boolean()
        .optional()
        .describe('Fetch all items across pages (up to 500) instead of a single page'),
    },
    async (args) => {
      const id = encodeURIComponent(args.id);
      const itemLimit = String(args.limit ?? 50);
      const itemParams: Record<string, string> = { limit: itemLimit };
      if (args.offset !== undefined) itemParams.offset = String(args.offset);

      const [metadata, firstPage] = await Promise.all([
        client.get<PlaylistWithImages>(`/playlists/${id}`),
        client.get<PlaylistItemsResponse>(`/playlists/${id}/items`, itemParams),
      ]);
      if (!metadata) throw new Error('Playlist not found');

      let items = firstPage;
      if (args.fetch_all && firstPage) {
        const collected = [...firstPage.items];
        while (collected.length < Math.min(firstPage.total, FETCH_ALL_CAP)) {
          const page = await client.get<PlaylistItemsResponse>(`/playlists/${id}/items`, {
            limit: itemLimit,
            offset: String(collected.length),
          });
          if (!page || page.items.length === 0) break;
          collected.push(...page.items);
        }
        if (collected.length > FETCH_ALL_CAP) collected.length = FETCH_ALL_CAP;
        items = { ...firstPage, items: collected };
      }

      // Cover image: prefer the one embedded in the playlist object, else ask
      // the images endpoint explicitly
      let coverUrl = metadata.images?.[0]?.url ?? null;
      if (!coverUrl) {
        const images = await client.get<SpotifyImage[]>(`/playlists/${id}/images`);
        coverUrl = images?.[0]?.url ?? null;
      }

      const owner = metadata.owner.display_name ?? metadata.owner.id;
      const lines = [`"${metadata.name}" by ${owner}`];
      if (metadata.description) lines.push(`Description: ${metadata.description}`);
      lines.push(`URI: ${metadata.uri}`);
      if (coverUrl) lines.push(`Cover image: ${coverUrl}`);

      if (items && items.items.length > 0) {
        lines.push(`\nTracks (${items.total} total, showing ${items.items.length}):`);
        let trackNum = (args.offset ?? 0) + 1;
        for (const item of items.items) {
          if (!item.track) { trackNum++; continue; }
          if (item.track.type === 'track') {
            const artists = item.track.artists.map((a) => a.name).join(', ');
            lines.push(
              `  ${trackNum}. "${item.track.name}" by ${artists} (${formatDuration(item.track.duration_ms)}) | URI: ${item.track.uri}`,
            );
          } else {
            lines.push(
              `  ${trackNum}. "${item.track.name}" — ${item.track.show.name} (${formatDuration(item.track.duration_ms)}) | URI: ${item.track.uri}`,
            );
          }
          trackNum++;
        }
      } else {
        lines.push('\nPlaylist is empty.');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // get_playlist_cover
  server.tool(
    'get_playlist_cover',
    "Get a playlist's cover image URLs",
    {
      playlist_id: z.string().describe('Playlist ID'),
    },
    async (args) => {
      const images = await client.get<SpotifyImage[]>(
        `/playlists/${encodeURIComponent(args.playlist_id)}/images`,
      );
      if (!images || images.length === 0) {
        return {
          content: [{ type: 'text', text: 'This playlist has no custom cover image.' }],
        };
      }
      const lines = [`Cover images (${images.length}):`];
      for (const img of images) {
        const dims =
          img.width != null && img.height != null ? ` (${img.width}x${img.height})` : '';
        lines.push(`  • ${img.url}${dims}`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // upload_playlist_cover
  server.tool(
    'upload_playlist_cover',
    "Replace a playlist's cover image with a base64-encoded JPEG. Requires the ugc-image-upload scope on the Spotify developer dashboard app (plus playlist-modify-public/private); without it Spotify rejects the upload with 403.",
    {
      playlist_id: z.string().describe('Playlist ID'),
      jpeg_base64: z.string().min(1).describe('Base64-encoded JPEG file contents (max 256 KB decoded)'),
    },
    async (args) => {
      // Validate before spending the round-trip: JPEG magic bytes in base64
      // start with /9j, and Spotify caps cover uploads at 256 KB
      if (!args.jpeg_base64.startsWith('/9j')) {
        throw new Error('jpeg_base64 does not look like a JPEG (base64 data should start with "/9j")');
      }
      if (Buffer.from(args.jpeg_base64, 'base64').length > 256 * 1024) {
        throw new Error('Decoded JPEG exceeds the 256 KB limit for playlist covers');
      }

      await client.putRaw(
        `/playlists/${encodeURIComponent(args.playlist_id)}/images`,
        args.jpeg_base64,
      );
      return {
        content: [{ type: 'text', text: 'Cover image uploaded.' }],
      };
    },
  );

  // create_playlist
  server.tool(
    'create_playlist',
    'Create a new playlist for the current user',
    {
      name: z.string().describe('Playlist name'),
      description: z.string().optional().describe('Playlist description'),
      public: z.boolean().optional().describe('Whether the playlist is public. Default: false'),
      collaborative: z
        .boolean()
        .optional()
        .describe('Whether the playlist is collaborative. Default: false'),
    },
    async (args) => {
      const body: Record<string, unknown> = {
        name: args.name,
        public: args.public ?? false,
        collaborative: args.collaborative ?? false,
      };
      if (args.description) body.description = args.description;

      const result = await client.post<{
        id: string;
        uri: string;
        external_urls: { spotify: string };
      }>('/me/playlists', body);
      if (!result) throw new Error('Could not create playlist');

      return {
        content: [{
          type: 'text',
          text: `Created playlist "${args.name}"\nID: ${result.id}\nURI: ${result.uri}\nURL: ${result.external_urls.spotify}`,
        }],
      };
    },
  );

  // add_to_playlist
  server.tool(
    'add_to_playlist',
    'Add tracks or episodes to a playlist. Max 100 URIs per call.',
    {
      playlist_id: z.string().describe('Playlist ID'),
      uris: z.array(z.string()).min(1).max(100).describe('Track or episode URIs to add'),
      position: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Insert at index; appends if omitted'),
    },
    async (args) => {
      const body: Record<string, unknown> = { uris: args.uris };
      if (args.position !== undefined) body.position = args.position;

      await client.post(`/playlists/${encodeURIComponent(args.playlist_id)}/items`, body);
      return {
        content: [{ type: 'text', text: `Added ${args.uris.length} item(s) to playlist.` }],
      };
    },
  );

  // remove_from_playlist
  server.tool(
    'remove_from_playlist',
    'Remove tracks or episodes from a playlist',
    {
      playlist_id: z.string().describe('Playlist ID'),
      uris: z.array(z.string()).min(1).describe('URIs to remove'),
    },
    async (args) => {
      const tracks = args.uris.map((uri) => ({ uri }));
      await client.delete(`/playlists/${encodeURIComponent(args.playlist_id)}/items`, { tracks });
      return {
        content: [{ type: 'text', text: `Removed ${args.uris.length} item(s) from playlist.` }],
      };
    },
  );

  // update_playlist
  server.tool(
    'update_playlist',
    "Update a playlist's name, description, or visibility",
    {
      id: z.string().describe('Playlist ID'),
      name: z.string().optional().describe('New name'),
      description: z.string().optional().describe('New description'),
      public: z.boolean().optional().describe('New public state'),
      collaborative: z.boolean().optional().describe('New collaborative state'),
    },
    async (args) => {
      const body: Record<string, unknown> = {};
      if (args.name !== undefined) body.name = args.name;
      if (args.description !== undefined) body.description = args.description;
      if (args.public !== undefined) body.public = args.public;
      if (args.collaborative !== undefined) body.collaborative = args.collaborative;

      if (Object.keys(body).length === 0) {
        throw new Error(
          'Provide at least one field to update (name, description, public, collaborative)',
        );
      }

      await client.put(`/playlists/${encodeURIComponent(args.id)}`, body);
      return { content: [{ type: 'text', text: 'Playlist updated.' }] };
    },
  );

  // reorder_playlist_items
  server.tool(
    'reorder_playlist_items',
    'Move a range of items within a playlist',
    {
      playlist_id: z.string().describe('Playlist ID'),
      range_start: z.number().int().min(0).describe('Index of the first item to move'),
      range_length: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Number of items to move. Default: 1'),
      insert_before: z.number().int().min(0).describe('Index to insert the range before'),
    },
    async (args) => {
      const body: Record<string, unknown> = {
        range_start: args.range_start,
        insert_before: args.insert_before,
      };
      if (args.range_length !== undefined) body.range_length = args.range_length;

      await client.put(`/playlists/${encodeURIComponent(args.playlist_id)}/items`, body);
      return { content: [{ type: 'text', text: 'Playlist items reordered.' }] };
    },
  );
}
