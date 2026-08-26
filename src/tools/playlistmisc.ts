/**
 * Playlist misc (#186 + #208): pin/unpin playlist (follow/unfollow) + mood-vibe
 * template playlists composed from the user's existing library/top data.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import {
  ResponseFormat,
  DryRun,
  describeDryRun,
  batchSummary,
} from '../shaping.js';
import type { ResponseFormatValue } from '../shaping.js';
import { confirmViaElicitation, describeConfirmation } from './confirm.js';
import { issueReceipt, formatReceipt } from '../receipts.js';
import type {
  SpotifyPaged,
  SpotifyTrack,
  SavedTrackItem,
  RecentlyPlayedItem,
} from '../types/spotify.js';

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

const TEMPLATES = {
  focus: {
    label: 'Focus',
    description: 'Calm, concentrated listening \u2014 drawn from your saved and top tracks',
    sources: ['top_tracks', 'saved_tracks'] as const,
  },
  'wind-down': {
    label: 'Wind Down',
    description: 'Evening wind-down \u2014 mellow picks from your library',
    sources: ['saved_tracks', 'top_tracks'] as const,
  },
  gym: {
    label: 'Gym',
    description: 'High-energy picks for workouts \u2014 recent and top tracks',
    sources: ['top_tracks', 'recently_played'] as const,
  },
  commute: {
    label: 'Commute',
    description: 'Commute mix \u2014 recently played and top tracks in rotation',
    sources: ['recently_played', 'top_tracks'] as const,
  },
} as const;

type TemplateName = keyof typeof TEMPLATES;

async function loadCandidates(client: SpotifyClient, source: string): Promise<SpotifyTrack[]> {
  if (source === 'top_tracks') {
    const p1 = await client.get<SpotifyPaged<SpotifyTrack>>('/me/top/tracks', { limit: '50', offset: '0' });
    const p2 = await client.get<SpotifyPaged<SpotifyTrack>>('/me/top/tracks', { limit: '50', offset: '50' });
    return [...(p1?.items ?? []), ...(p2?.items ?? [])].filter((t) => t?.uri);
  }
  if (source === 'recently_played') {
    const res = await client.get<{ items?: RecentlyPlayedItem[] }>('/me/player/recently-played', { limit: '50' });
    return (res?.items ?? []).filter((i) => i?.track).map((i) => i.track as SpotifyTrack);
  }
  const saved = await client.getAllPages<SavedTrackItem>('/me/tracks', { limit: '50' });
  return saved.map((e) => e?.track).filter((t): t is SpotifyTrack => Boolean(t?.uri));
}

function dedupeUris(tracks: readonly SpotifyTrack[]): SpotifyTrack[] {
  const seen = new Set<string>();
  return tracks.filter((t) => {
    if (!t.uri || seen.has(t.uri)) return false;
    seen.add(t.uri);
    return true;
  });
}

export function registerPlaylistMiscTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'pin_playlist',
    'Follow (pin) a playlist to your library. PUT /playlists/{id}/followers.',
    {
      playlist_id: z.string().describe('Playlist ID to follow'),
      public: z.boolean().optional().describe('Whether the follow should be public (Spotify default: true)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const id = encodeURIComponent(args.playlist_id);
      const body: Record<string, unknown> = {};
      if (args.public !== undefined) body.public = args.public;
      const hasBody = Object.keys(body).length > 0;
      await client.put(`/playlists/${id}/followers`, hasBody ? body : undefined);
      const payload = { ok: true, playlist_id: args.playlist_id, pinned: true };
      return shapeResult(rf, `Pinned playlist ${args.playlist_id}.`, payload);
    },
  );

  server.tool(
    'unpin_playlist',
    'Unfollow (unpin) a playlist. DELETE /playlists/{id}/followers. Supports dry_run and elicitation for bulk use.',
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
      await client.delete(`/playlists/${encodeURIComponent(args.playlist_id)}/followers`);
      return shapeResult(rf, `Unpinned playlist ${args.playlist_id}.`, { ok: true, playlist_id: args.playlist_id, pinned: false });
    },
  );

  server.tool(
    'playlist_template_apply',
    'Create an instant mood/vibe playlist from a template (focus, wind-down, gym, commute) composed from your existing listening data. Creates a new playlist and fills it.',
    {
      template: z.enum(['focus', 'wind-down', 'gym', 'commute']).describe('Template name'),
      name: z.string().optional().describe('Playlist name (default: "<Template> Mix")'),
      limit: z.number().int().min(1).max(100).optional().default(30).describe('How many tracks (1-100, default 30)'),
      public: z.boolean().optional().default(false).describe('Whether the playlist is public'),
      description: z.string().optional().describe('Playlist description override'),
      dry_run: DryRun,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const tmpl = TEMPLATES[args.template as TemplateName];
      if (!tmpl) throw new Error(`Unknown template "${args.template}" \u2014 valid: ${Object.keys(TEMPLATES).join(', ')}`);

      let candidates: SpotifyTrack[] = [];
      for (const src of tmpl.sources) {
        const batch = dedupeUris(await loadCandidates(client, src));
        for (const t of batch) {
          if (!candidates.some((c) => c.uri === t.uri)) candidates.push(t);
        }
        if (candidates.length >= (args.limit ?? 30)) break;
      }
      candidates = dedupeUris(candidates).slice(0, args.limit ?? 30);

      const playlistName = args.name ?? `${tmpl.label} Mix`;
      const playlistDesc = args.description ?? tmpl.description;

      if (args.dry_run) {
        const changes = candidates.map((t) => `${t.artists.map((a) => a.name).join(', ')} \u2014 ${t.name} | ${t.uri}`);
        const payload = { ok: true, dry_run: true, template: args.template, name: playlistName, would_create: true, tracks: candidates.length, uris: candidates.map((t) => t.uri) };
        return shapeResult(rf, describeDryRun('apply playlist template', args.template, [`Would create "${playlistName}" with ${candidates.length} track(s)`, ...changes.slice(0, 5)]) + (changes.length > 5 ? `\n  \u2026and ${changes.length - 5} more` : ''), payload);
      }

      if (candidates.length === 0) throw new Error(`No candidate tracks for template "${args.template}" \u2014 save or play some tracks first`);

      const created = await client.post<{ id: string; uri: string; external_urls?: { spotify?: string } }>(
        '/me/playlists',
        { name: playlistName, public: args.public ?? false, description: playlistDesc },
      );
      if (!created?.id) throw new Error('Could not create playlist');

      const itemsPath = `/playlists/${encodeURIComponent(created.id)}/items`;
      const uris = candidates.map((t) => t.uri);
      for (let i = 0; i < uris.length; i += 100) {
        await client.post(itemsPath, { uris: uris.slice(i, i + 100) });
      }

      const receipt = await issueReceipt(client, { kind: 'playlist_meta', id: created.id, uris: [] });
      const prose = `Created "${playlistName}" from template "${args.template}" (${candidates.length} tracks)\nID: ${created.id}\nURI: ${created.uri}\n${batchSummary(uris.length, uris)}\n${formatReceipt(receipt)}`;
      return shapeResult(rf, prose, {
        ok: true,
        template: args.template,
        playlist_id: created.id,
        playlist_uri: created.uri,
        added: uris.length,
        uris,
        receipt: receipt as unknown as Record<string, unknown>,
      });
    },
  );
}
