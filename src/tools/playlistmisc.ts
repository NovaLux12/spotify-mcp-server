/**
 * Playlist misc (#208): mood-vibe template playlists composed from the user's
 * existing library/top data. pin/unpin (follow/unfollow) moved to
 * playlistfollow.ts: they call /me/library, which authorises a different
 * either-of scope set than the playlist-modify pair this file's tools need
 * (#1005), so they need their own manifest row to be gated honestly.
 */
import { z } from 'zod';
import { capFor, runChunkedPlaylistWrite } from '../chunk.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import {
  ResponseFormat,
  DryRun,
  describeDryRun,
  batchSummary,
} from '../shaping.js';
import type { ResponseFormatValue } from '../shaping.js';
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
      const writeCap = capFor('playlist_writes');
      // #865: the playlist is already created by this point, so a batch that
      // rejects leaves an empty-then-partial playlist the caller has no
      // pointer to. Report the committed prefix (and the new playlist's id)
      // so a retry can resume rather than re-add what landed.
      const write = await runChunkedPlaylistWrite(uris, writeCap, (chunk) =>
        client.post<{ snapshot_id?: string }>(itemsPath, { uris: chunk }),
      );
      if (!write.ok) {
        const committedCount = write.committed_uris;
        const lastUri = write.last_committed_chunk_uris[write.last_committed_chunk_uris.length - 1];
        const prose = write.failed_chunk_index === 0
          ? `Created "${playlistName}" (${created.id}) but no track landed: ${write.error}. The playlist exists and is empty; retry the add of ${uris.length} track(s).`
          : `Partial apply of template "${args.template}" into new playlist ${created.id}: chunks 1–${write.failed_chunk_index} committed (${committedCount} track(s)), chunk ${write.failed_chunk_index + 1} of ${write.attempted_chunks} failed.${lastUri ? ` Last URI committed: ${lastUri}.` : ''} Retry the remaining ${uris.length - committedCount} track(s); the committed prefix is already there. (${write.error})`;
        return shapeResult(rf, prose, {
          ...write,
          template: args.template,
          playlist_id: created.id,
          playlist_uri: created.uri,
          attempted_uris: uris.length,
          remaining_uris: uris.length - committedCount,
        });
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
