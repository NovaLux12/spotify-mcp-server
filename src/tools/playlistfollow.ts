/**
 * Playlist follow/unfollow (#1005), split out of playlistmisc.ts.
 *
 * These two tools are the only ones in the family that call PUT/DELETE
 * /me/library with a `spotify:playlist:` URI, and that endpoint authorises
 * THREE alternative scopes — `user-library-modify`, `user-follow-modify` or
 * `playlist-modify-public`. Sharing playlistmisc's `playlists` requirement
 * (`playlist-modify-public|private`) advertised a tool the granted scopes
 * could not authorise: a caller holding only the playlist scopes saw
 * `pin_playlist` in tools/list and got a raw 403 on every call. Giving the
 * pair its own registrar row lets the manifest carry the full either-of list
 * (scopeKey `playlistfollow` in src/scopefilter.ts) instead of a guess.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { ResponseFormat, DryRun, describeDryRun } from '../shaping.js';
import type { ResponseFormatValue } from '../shaping.js';
import { confirmViaElicitation, describeConfirmation, requiredConfirmationRefusal } from './confirm.js';

type ToolOut = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function shapeResult(rf: ResponseFormatValue, prose: string, payload: Record<string, unknown>): ToolOut {
  return {
    content: [{ type: 'text', text: rf === 'json' ? JSON.stringify(payload, null, 2) : prose }],
    structuredContent: payload,
  };
}

/**
 * pin_playlist is opt-OUT of preview (#870), so the default lives here rather
 * than in the shared DryRun default (true): following a playlist is a write to
 * the caller's library, and #870's finding was that this family in particular
 * was committing while callers believed they were previewing.
 *
 * Pass dry_run: false to execute the follow. `true` returns the plan and
 * issues no request.
 */
const PinDryRun = DryRun.default(true).describe(
  'Preview only (default): pass dry_run: false to execute the follow.',
);

// Feb 2026: Spotify removed PUT/DELETE /playlists/{id}/followers outright and
// folded playlist following into the unified library endpoints, whose
// documented URI list explicitly includes spotify:playlist:{id}. So "pin" is
// saving the playlist URI to the library and "unpin" is removing it. The
// replacement takes no request body, so the old `public` visibility flag has
// no equivalent: `false` is rejected outright, and `true` is accepted for
// call-site compatibility but reaches neither the request nor the
// confirmation prompt — a library save is inherently private, so claiming
// "public: true" at the moment the user authorises the write is a lie, not a
// default.
function playlistLibraryPath(playlistId: string): string {
  const uris = new URLSearchParams({ uris: `spotify:playlist:${playlistId}` }).toString();
  return `/me/library?${uris}`;
}

export function registerPlaylistFollowTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'pin_playlist',
    'Follow (pin) a playlist into your library via PUT /me/library. Supports dry_run (default true); writes require confirmation unless SPOTIFY_MCP_CONFIRM=never.',
    {
      playlist_id: z.string().describe('Playlist ID to follow'),
      public: z
        .boolean()
        .optional()
        .describe('Must be true or omitted; the library endpoint has no visibility parameter.'),
      dry_run: PinDryRun,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      if (args.public === false) {
        throw new Error(
          'pin_playlist cannot honour public=false: the Feb 2026 replacement PUT /me/library has no visibility parameter. Omit `public` or pass true.',
        );
      }
      if (args.dry_run) {
        const payload = { ok: true, dry_run: true, playlist_id: args.playlist_id, would_pin: true };
        return shapeResult(rf, describeDryRun('pin playlist', args.playlist_id, [`Follow playlist ${args.playlist_id}`]), payload);
      }
      const verdict = await confirmViaElicitation(server, {
        message: describeConfirmation('pin playlist', args.playlist_id, [
          `Follow playlist ${args.playlist_id}`,
        ]),
      });
      const refusal = requiredConfirmationRefusal(verdict);
      if (refusal) return shapeResult(rf, refusal.message, refusal.payload);
      await client.put(playlistLibraryPath(args.playlist_id));
      const payload = { ok: true, playlist_id: args.playlist_id, pinned: true };
      return shapeResult(rf, `Pinned playlist ${args.playlist_id}.`, payload);
    },
  );

  server.tool(
    'unpin_playlist',
    'Unfollow (unpin) a playlist via DELETE /me/library. Supports dry_run; writes require explicit confirmation unless SPOTIFY_MCP_CONFIRM=never.',
    {
      playlist_id: z.string().describe('Playlist ID to unfollow'),
      dry_run: DryRun,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      if (args.dry_run) {
        const payload = { ok: true, dry_run: true, playlist_id: args.playlist_id, would_unpin: true };
        return shapeResult(rf, describeDryRun('unpin playlist', args.playlist_id, [`Unfollow ${args.playlist_id}`]), payload);
      }
      const verdict = await confirmViaElicitation(server, {
        message: describeConfirmation('unpin playlist', args.playlist_id, [`Unfollow playlist ${args.playlist_id}`]),
      });
      if (verdict === 'declined') {
        return shapeResult(rf, 'Cancelled \u2014 nothing was changed.', { ok: false, cancelled: true });
      }
      if (verdict === 'error') {
        throw new Error('Elicitation failed — refusing to unpin playlist without confirmation');
      }
      if (verdict === 'unsupported' && process.env.SPOTIFY_MCP_CONFIRM !== 'never') {
        throw new Error('Elicitation unavailable — refusing to unpin playlist without confirmation');
      }
      await client.delete(playlistLibraryPath(args.playlist_id));
      return shapeResult(rf, `Unpinned playlist ${args.playlist_id}.`, { ok: true, playlist_id: args.playlist_id, pinned: false });
    },
  );
}
