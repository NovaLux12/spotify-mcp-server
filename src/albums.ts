import type { MaxInt } from '@spotify/web-api-ts-sdk';
import { z } from 'zod';
import type { SpotifyHandlerExtra, tool } from './types.js';
import {
  CHUNK_CAPS,
  chunkArray,
  extractSpotifyId,
  formatDuration,
  getAllPages,
  getFetchAllCap,
  handleSpotifyRequest,
  paginationFooter,
} from './utils.js';

const getAlbums: tool<{
  albumIds: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodString>]>>;
  ids: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodString>]>>;
}> = {
  name: 'getAlbums',
  description:
    'Get detailed information about one or more albums by their Spotify IDs. ' +
    'Accepts bare ID, spotify:album: URI, or https://open.spotify.com/album/ URL (spotifyId). ' +
    `Chunk cap: ${CHUNK_CAPS.albums} per request — larger lists are fetched in parallel chunks via Promise.all.`,
  schema: {
    albumIds: z
      .union([z.string(), z.array(z.string()).max(20)])
      .optional()
      .describe('A single album ID, spotify:album: URI, or open.spotify.com URL, or array of such (max 20)'),
    ids: z
      .union([z.string(), z.array(z.string()).max(20)])
      .optional()
      .describe('Alias for albumIds — also accepts URI/URL (deprecated alias, prefer albumIds)'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const raw = args.albumIds ?? args.ids;
    if (!raw) {
      return {
        content: [{ type: 'text', text: 'Error: albumIds is required' }],
      };
    }
    const albumIds = raw;
    const rawIds: string[] = Array.isArray(albumIds) ? albumIds : [albumIds];
    const ids = rawIds.map(extractSpotifyId);

    if (ids.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: No album IDs provided',
          },
        ],
      };
    }

    try {
      // Chunked Promise.all for IDs beyond cap (future-proof if schema limit raised)
      const chunks = chunkArray(ids, CHUNK_CAPS.albums);
      const chunkResults = await Promise.all(
        chunks.map((chunk) =>
          handleSpotifyRequest(async (spotifyApi) => {
            return chunk.length === 1
              ? [await spotifyApi.albums.get(chunk[0])]
              : await spotifyApi.albums.get(chunk);
          }),
        ),
      );
      const albums = chunkResults.flat();

      if (albums.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No albums found for the provided IDs',
            },
          ],
        };
      }

      if (albums.length === 1) {
        const album = albums[0];
        const artists = album.artists.map((a) => a.name).join(', ');
        const releaseDate = album.release_date;
        const totalTracks = album.total_tracks;
        const albumType = album.album_type;

        return {
          content: [
            {
              type: 'text',
              text: `# Album Details\n\n**Name**: "${album.name}"\n**Artists**: ${artists}\n**Release Date**: ${releaseDate}\n**Type**: ${albumType}\n**Total Tracks**: ${totalTracks}\n**ID**: ${album.id}`,
            },
          ],
        };
      }

      const formattedAlbums = albums
        .map((album, i) => {
          if (!album) return `${i + 1}. [Album not found]`;

          const artists = album.artists.map((a) => a.name).join(', ');
          return `${i + 1}. "${album.name}" by ${artists} (${album.release_date}) - ${album.total_tracks} tracks - ID: ${album.id}`;
        })
        .join('\n');

      return {
        content: [
          {
            type: 'text',
            text: `# Multiple Albums\n\n${formattedAlbums}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error getting albums: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const getAlbumTracks: tool<{
  albumId: z.ZodString;
  album_id: z.ZodOptional<z.ZodString>;
  limit: z.ZodOptional<z.ZodNumber>;
  offset: z.ZodOptional<z.ZodNumber>;
  fetch_all: z.ZodOptional<z.ZodBoolean>;
  max_results: z.ZodOptional<z.ZodNumber>;
}> = {
  name: 'getAlbumTracks',
  description:
    'Get tracks from a specific album with pagination support. ' +
    'Accepts bare album ID, spotify:album: URI, or open.spotify.com URL. ' +
    'Default limit 20 is a single page — pass fetch_all=true to walk all pages (up to cap) or use offset. ' +
    `fetch_all cap: ${getFetchAllCap()} (override via SPOTIFY_MCP_MAX_ITEMS).`,
  schema: {
    albumId: z.string().describe('The Spotify ID of the album (also accepts spotify:album: URI or https://open.spotify.com/album/ URL)'),
    album_id: z.string().optional().describe('Alias for albumId — also accepts URI/URL'),
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum number of tracks per page (1-50). When fetch_all=false, this is the page size. Default: 20.'),
    offset: z
      .number()
      .min(0)
      .optional()
      .describe('Offset for pagination (0-based index). Ignored when fetch_all=true starts from offset.'),
    fetch_all: z.boolean().optional().describe('Fetch all pages (up to cap) instead of a single page'),
    max_results: z.number().int().min(1).max(2000).optional().describe('Client-side truncation cap (up to 2000). Applied after fetching.'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const rawAlbumId = args.albumId ?? args.album_id;
    const albumId = rawAlbumId ? extractSpotifyId(rawAlbumId) : undefined;
    const { limit = 20, offset = 0, fetch_all = false, max_results } = args as any;
    if (!albumId) {
      return {
        content: [{ type: 'text', text: 'Error: albumId is required' }],
      };
    }

    try {
      let allItems: any[] = [];
      let total = 0;
      let truncatedByCap = false;
      if (fetch_all) {
        const res = await getAllPages(
          async (off, lim) => {
            const page = await handleSpotifyRequest(async (spotifyApi) => {
              return await spotifyApi.albums.tracks(albumId, undefined, lim as MaxInt<50>, off);
            });
            return { items: page.items, total: page.total };
          },
          { startOffset: offset, pageLimit: limit, cap: getFetchAllCap() },
        );
        allItems = res.items;
        total = res.total;
        truncatedByCap = res.truncatedByCap;
        if (max_results && allItems.length > max_results) {
          allItems = allItems.slice(0, max_results);
          truncatedByCap = true;
        }
      } else {
        const page = await handleSpotifyRequest(async (spotifyApi) => {
          return await spotifyApi.albums.tracks(albumId, undefined, limit as MaxInt<50>, offset);
        });
        allItems = page.items;
        total = page.total;
        if (max_results && allItems.length > max_results) {
          allItems = allItems.slice(0, max_results);
          truncatedByCap = true;
        }
      }

      if (allItems.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No tracks found in this album',
            },
          ],
        };
      }

      const effectiveOffset = fetch_all ? offset : offset;
      const formattedTracks = allItems
        .map((track, i) => {
          if (!track) return `${i + 1}. [Track not found]`;

          const artists = (track.artists as Array<{ name: string }>).map((a) => a.name).join(', ');
          const duration = formatDuration(track.duration_ms);
          return `${effectiveOffset + i + 1}. "${track.name}" by ${artists} (${duration}) - ID: ${track.id}`;
        })
        .join('\n');

      const footer = truncatedByCap
        ? ` (truncated at ${max_results ?? getFetchAllCap()})`
        : total > allItems.length || (!fetch_all && total > allItems.length)
          ? paginationFooter({ count: allItems.length, total, offset, limit })
          : (!fetch_all && offset + allItems.length < total)
            ? `\n\nMore pages available — pass offset=${offset + allItems.length} or fetch_all=true (of total ${total}).`
            : '';

      return {
        content: [
          {
            type: 'text',
            text: `# Album Tracks (${effectiveOffset + 1}-${effectiveOffset + allItems.length} of ${total})\n\n${formattedTracks}${footer}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error getting album tracks: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const saveOrRemoveAlbumForUser: tool<{
  albumIds: z.ZodArray<z.ZodString>;
  action: z.ZodEnum<['save', 'remove']>;
}> = {
  name: 'saveOrRemoveAlbumForUser',
  description: 'Save or remove albums from the user\'s "Your Music" library',
  schema: {
    albumIds: z
      .array(z.string())
      .max(20)
      .describe('Array of Spotify album IDs (max 20)'),
    action: z
      .enum(['save', 'remove'])
      .describe('Action to perform: save or remove albums'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { albumIds, action } = args;

    if (albumIds.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: No album IDs provided',
          },
        ],
      };
    }

    try {
      await handleSpotifyRequest(async (spotifyApi) => {
        return action === 'save'
          ? await spotifyApi.currentUser.albums.saveAlbums(albumIds)
          : await spotifyApi.currentUser.albums.removeSavedAlbums(albumIds);
      });

      const actionPastTense = action === 'save' ? 'saved' : 'removed';
      const preposition = action === 'save' ? 'to' : 'from';

      return {
        content: [
          {
            type: 'text',
            text: `Successfully ${actionPastTense} ${albumIds.length} album${albumIds.length === 1 ? '' : 's'} ${preposition} your library`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error ${action === 'save' ? 'saving' : 'removing'} albums: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const checkUsersSavedAlbums: tool<{
  albumIds: z.ZodArray<z.ZodString>;
}> = {
  name: 'checkUsersSavedAlbums',
  description: 'Check if albums are saved in the user\'s "Your Music" library',
  schema: {
    albumIds: z
      .array(z.string())
      .max(20)
      .describe('Array of Spotify album IDs to check (max 20)'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { albumIds } = args;

    if (albumIds.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: No album IDs provided',
          },
        ],
      };
    }

    try {
      const savedStatus = await handleSpotifyRequest(async (spotifyApi) => {
        return await spotifyApi.currentUser.albums.hasSavedAlbums(albumIds);
      });

      const formattedResults = albumIds
        .map((albumId, i) => {
          const isSaved = savedStatus[i];
          return `${i + 1}. ${albumId}: ${isSaved ? 'Saved' : 'Not saved'}`;
        })
        .join('\n');

      return {
        content: [
          {
            type: 'text',
            text: `# Album Save Status\n\n${formattedResults}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error checking saved albums: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

export const albumTools = [
  getAlbums,
  getAlbumTracks,
  saveOrRemoveAlbumForUser,
  checkUsersSavedAlbums,
];
