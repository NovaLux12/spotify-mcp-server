import { z } from 'zod';
import type { SpotifyHandlerExtra, tool } from './types.js';
import {
  CHUNK_CAPS,
  chunkArray,
  extractSpotifyId,
  handleSpotifyRequest,
  spotifyFetch,
} from './utils.js';

const getPlaylist: tool<{
  playlistId: z.ZodString;
  id: z.ZodOptional<z.ZodString>;
}> = {
  name: 'getPlaylist',
  description:
    'Get details of a specific Spotify playlist including tracks count, description and owner. ' +
    'Accepts bare playlist ID, spotify:playlist: URI, or https://open.spotify.com/playlist/ URL (spotifyId). ' +
    'Idempotency: read-only, safe to retry.',
  schema: {
    playlistId: z.string().describe('The Spotify ID of the playlist (also accepts spotify:playlist: URI or https://open.spotify.com/playlist/ URL)'),
    id: z.string().optional().describe('Alias for playlistId — also accepts URI/URL (bare id for compat)'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const raw = (args as any).playlistId ?? (args as any).id;
    const playlistId = raw ? extractSpotifyId(raw) : undefined;
    if (!playlistId) return { content: [{ type: 'text', text: 'Error: playlistId is required (also accepts id, URI or URL)' }] };

    try {
      const playlist = await handleSpotifyRequest(async (spotifyApi) => {
        return await spotifyApi.playlists.getPlaylist(playlistId);
      });

      const owner =
        playlist.owner?.display_name ?? playlist.owner?.id ?? 'Unknown';
      const tracksTotal = playlist.tracks?.total ?? 0;
      const isPublic = playlist.public ? 'Public' : 'Private';
      const isCollaborative = playlist.collaborative ? ' | Collaborative' : '';
      const description = playlist.description
        ? `\n**Description**: ${playlist.description}`
        : '';
      const url = playlist.external_urls?.spotify ?? '';

      return {
        content: [
          {
            type: 'text',
            text:
              `# Playlist: "${playlist.name}"\n\n` +
              `**Owner**: ${owner}\n` +
              `**Tracks**: ${tracksTotal}\n` +
              `**Visibility**: ${isPublic}${isCollaborative}` +
              `${description}\n` +
              `**ID**: ${playlist.id}\n` +
              `**URL**: ${url}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error getting playlist: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const updatePlaylist: tool<{
  playlistId: z.ZodString;
  id: z.ZodOptional<z.ZodString>;
  name: z.ZodOptional<z.ZodString>;
  description: z.ZodOptional<z.ZodString>;
  public: z.ZodOptional<z.ZodBoolean>;
  collaborative: z.ZodOptional<z.ZodBoolean>;
}> = {
  name: 'updatePlaylist',
  description:
    'Update the details of a Spotify playlist (name, description, public/private, collaborative)',
  schema: {
    playlistId: z.string().describe('The Spotify ID of the playlist (also accepts URI/URL)'),
    id: z.string().optional().describe('Alias for playlistId — also accepts URI/URL'),
    name: z.string().optional().describe('New name for the playlist'),
    description: z
      .string()
      .optional()
      .describe('New description for the playlist'),
    public: z
      .boolean()
      .optional()
      .describe('Whether the playlist should be public'),
    collaborative: z
      .boolean()
      .optional()
      .describe(
        'Whether the playlist should be collaborative (requires public to be false)',
      ),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const rawId = (args as any).playlistId ?? (args as any).id;
    const playlistId = rawId ? extractSpotifyId(rawId) : undefined;
    const { name, description, public: isPublic, collaborative } = args as any;
    if (!playlistId) return { content: [{ type: 'text', text: 'Error: playlistId is required' }] };

    if (
      !name &&
      description === undefined &&
      isPublic === undefined &&
      collaborative === undefined
    ) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: At least one field to update must be provided (name, description, public, collaborative)',
          },
        ],
      };
    }

    try {
      const body: Record<string, string | boolean> = {};
      if (name) body.name = name;
      if (description !== undefined) body.description = description;
      if (isPublic !== undefined) body.public = isPublic;
      if (collaborative !== undefined) body.collaborative = collaborative;

      await handleSpotifyRequest(async (spotifyApi) => {
        await spotifyApi.playlists.changePlaylistDetails(playlistId, body);
      });

      const changes = Object.keys(body).join(', ');
      return {
        content: [
          {
            type: 'text',
            text: `Successfully updated playlist (ID: ${playlistId})\nFields updated: ${changes}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error updating playlist: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const removeTracksFromPlaylist: tool<{
  playlistId: z.ZodString;
  id: z.ZodOptional<z.ZodString>;
  trackIds: z.ZodArray<z.ZodString>;
  snapshotId: z.ZodOptional<z.ZodString>;
}> = {
  name: 'removeTracksFromPlaylist',
  description:
    'Remove one or more tracks from a Spotify playlist (max 100 tracks per request). ' +
    'Idempotency: with deduped input, re-running after partial failure is safe; snapshot_id guards version. Quota: ceil(N/100) writes, sequential.',
  schema: {
    playlistId: z.string().describe('The Spotify ID of the playlist (also accepts URI/URL)'),
    id: z.string().optional().describe('Alias for playlistId — also accepts URI/URL'),
    trackIds: z
      .array(z.string())
      .min(1)
      .max(100)
      .describe('Array of Spotify track IDs to remove (max 100). Accepts bare ID, URI, or URL — deduped.'),
    snapshotId: z
      .string()
      .optional()
      .describe(
        'The playlist snapshot ID to target a specific version (optional)',
      ),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const rawId = (args as any).playlistId ?? (args as any).id;
    const playlistId = rawId ? extractSpotifyId(rawId) : undefined;
    if (!playlistId) return { content: [{ type: 'text', text: 'Error: playlistId is required' }] };
    const snapshotId = (args as any).snapshotId as string | undefined;
    const rawTracks: string[] = (args as any).trackIds ?? [];
    const deduped = [...new Set(rawTracks.map(extractSpotifyId))];
    const trackIds = deduped;

    try {
      const items = trackIds.map((id) => ({
        uri: id.startsWith('spotify:') ? id : `spotify:track:${id}`,
      }));

      // Hit /items directly: SDK targets the deprecated /tracks endpoint
      // (see spotifyFetch JSDoc for context on the March 2026 migration).
      await spotifyFetch(`playlists/${playlistId}/items`, {
        method: 'DELETE',
        body: {
          items,
          ...(snapshotId ? { snapshot_id: snapshotId } : {}),
        },
      });

      return {
        content: [
          {
            type: 'text',
            text: `Successfully removed ${trackIds.length} track${
              trackIds.length === 1 ? '' : 's'
            } from playlist (ID: ${playlistId})`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error removing tracks from playlist: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const reorderPlaylistItems: tool<{
  playlistId: z.ZodString;
  id: z.ZodOptional<z.ZodString>;
  rangeStart: z.ZodNumber;
  insertBefore: z.ZodNumber;
  rangeLength: z.ZodOptional<z.ZodNumber>;
  snapshotId: z.ZodOptional<z.ZodString>;
}> = {
  name: 'reorderPlaylistItems',
  description:
    'Reorder a range of tracks within a Spotify playlist by moving them to a new position',
  schema: {
    playlistId: z.string().describe('The Spotify ID of the playlist (also accepts URI/URL)'),
    id: z.string().optional().describe('Alias for playlistId — also accepts URI/URL'),
    rangeStart: z
      .number()
      .nonnegative()
      .describe('The position of the first item to move (0-based index)'),
    insertBefore: z
      .number()
      .nonnegative()
      .describe(
        'The position where the items should be inserted (0-based index)',
      ),
    rangeLength: z
      .number()
      .min(1)
      .optional()
      .describe('Number of consecutive items to move (defaults to 1)'),
    snapshotId: z
      .string()
      .optional()
      .describe(
        'The playlist snapshot ID to target a specific version (optional)',
      ),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const rawId = (args as any).playlistId ?? (args as any).id;
    const playlistId = rawId ? extractSpotifyId(rawId) : undefined;
    if (!playlistId) return { content: [{ type: 'text', text: 'Error: playlistId is required' }] };
    const { rangeStart, insertBefore, rangeLength, snapshotId } = args as any;

    try {
      // Hit /items directly: see spotifyFetch JSDoc for context.
      await spotifyFetch(`playlists/${playlistId}/items`, {
        method: 'PUT',
        body: {
          range_start: rangeStart,
          insert_before: insertBefore,
          ...(rangeLength !== undefined ? { range_length: rangeLength } : {}),
          ...(snapshotId ? { snapshot_id: snapshotId } : {}),
        },
      });

      const count = rangeLength ?? 1;
      return {
        content: [
          {
            type: 'text',
            text: `Successfully moved ${count} track${
              count === 1 ? '' : 's'
            } from position ${rangeStart} to before position ${insertBefore} in playlist (ID: ${playlistId})`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error reordering playlist items: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const unfollowPlaylist: tool<{
  playlistId: z.ZodString;
  id: z.ZodOptional<z.ZodString>;
}> = {
  name: 'unfollowPlaylist',
  description:
    "Remove a playlist from the current user's library (unfollow). " +
    'Note: Spotify does not allow permanent deletion of playlists via the API.',
  schema: {
    playlistId: z.string().describe('The Spotify ID of the playlist to unfollow (also accepts URI/URL)'),
    id: z.string().optional().describe('Alias for playlistId — also accepts URI/URL'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const raw = (args as any).playlistId ?? (args as any).id;
    const playlistId = raw ? extractSpotifyId(raw) : undefined;
    if (!playlistId) return { content: [{ type: 'text', text: 'Error: playlistId is required' }] };

    try {
      await spotifyFetch(`playlists/${playlistId}/followers`, {
        method: 'DELETE',
      });

      return {
        content: [
          {
            type: 'text',
            text: `Successfully unfollowed playlist (ID: ${playlistId})`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error unfollowing playlist: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

// Batch twin for EPIC 523 #478 — parallel fetch of multiple playlists (up to 20)
const getSeveralPlaylists: tool<{
  playlistIds: z.ZodArray<z.ZodString>;
  ids: z.ZodOptional<z.ZodArray<z.ZodString>>;
}> = {
  name: 'getSeveralPlaylists',
  description:
    'Get details for several playlists in parallel (batch twin for getPlaylist). ' +
    'Accepts bare IDs, spotify:playlist: URIs, or open.spotify.com URLs — deduped. ' +
    'Uses Promise.all for reads (order preserved). Playlist writes remain sequential (snapshot chain). ' +
    `Quota: 1 per ${CHUNK_CAPS.playlistWrite} items but reads are parallel; no chunk cap — each playlist is one GET.`,
  schema: {
    playlistIds: z.array(z.string()).min(1).max(50).describe('Array of playlist IDs/URIs/URLs (max 50, deduped)'),
    ids: z.array(z.string()).min(1).max(50).optional().describe('Alias for playlistIds'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const raw: string[] = (args as any).playlistIds ?? (args as any).ids ?? [];
    const deduped = [...new Set(raw.map(extractSpotifyId))];
    if (deduped.length === 0) return { content: [{ type: 'text', text: 'Error: playlistIds is required' }] };
    try {
      const results = await Promise.all(
        deduped.map((pid) =>
          handleSpotifyRequest(async (spotifyApi) => spotifyApi.playlists.getPlaylist(pid))
            .then((pl) => ({ ok: true as const, pl }))
            .catch((e: unknown) => ({ ok: false as const, id: pid, error: e instanceof Error ? e.message : String(e) })),
        ),
      );
      const lines = results.map((r, i) => {
        if (!r.ok) return `${i + 1}. [Failed ${r.id}: ${r.error}]`;
        const pl: any = r.pl;
        const owner = pl.owner?.display_name ?? pl.owner?.id ?? 'Unknown';
        return `${i + 1}. "${pl.name}" by ${owner} (${pl.tracks?.total ?? 0} tracks) — ID: ${pl.id}`;
      });
      return { content: [{ type: 'text', text: `# Playlists (${results.length})\n\n${lines.join('\n')}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error getting playlists: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  },
};

export const playlistTools = [
  getPlaylist,
  getSeveralPlaylists,
  updatePlaylist,
  removeTracksFromPlaylist,
  reorderPlaylistItems,
  unfollowPlaylist,
];
