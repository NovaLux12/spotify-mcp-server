/**
 * queueops (#194, #202, #224, #231): queue_playlist + save_queue_as_playlist.
 * queue_reorder / queue_remove / queue_clear were removed in #231 — those
 * endpoints do not exist (only GET and POST /me/player/queue are real).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { DryRun, describeDryRun, parseSpotifyUri, ResponseFormat } from '../shaping.js';
import type { SpotifyPaged, SpotifyTrack } from '../types/spotify.js';

type TextContent = { type: 'text'; text: string };
type ToolResult = { content: TextContent[]; structuredContent?: Record<string, unknown> };
const textResult = (text: string, structured?: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text }],
  ...(structured ? { structuredContent: structured } : {}),
});

function mutationResult(format: string | undefined, echo: Record<string, unknown>, text: string): ToolResult {
  if (format === 'json') return { content: [{ type: 'text', text: JSON.stringify(echo, null, 2) }], structuredContent: echo };
  return { content: [{ type: 'text', text }], structuredContent: echo };
}

export async function addToQueueBatch(client: SpotifyClient, uris: string[], deviceId?: string): Promise<{ queued: number; failed: string[] }> {
  let queued = 0;
  const failed: string[] = [];
  for (const uri of uris) {
    try {
      const params = new URLSearchParams({ uri });
      if (deviceId) params.set('device_id', deviceId);
      await client.post(`/me/player/queue?${params}`);
      queued++;
    } catch {
      failed.push(uri);
    }
  }
  return { queued, failed };
}

async function resolveUris(client: SpotifyClient, sourceUri: string, limit: number): Promise<{ uris: string[]; sourceType: string; total: number }> {
  const parsed = parseSpotifyUri(sourceUri);
  if (!parsed) throw new Error(`Invalid Spotify URI: ${sourceUri}`);
  const type = parsed.type;
  const id = parsed.id;
  let uris: string[] = [];
  let total = 0;
  if (type === 'playlist') {
    const items = await client.getAllPages<{ item?: SpotifyTrack | null; track?: SpotifyTrack | null }>(
      `/playlists/${id}/items`, { limit: '100' }, { maxItems: limit },
    );
    const tracks = items.map((r: any) => r.item ?? r.track).filter(Boolean) as SpotifyTrack[];
    uris = tracks.map((t) => t.uri).filter(Boolean);
    total = uris.length;
    uris = uris.slice(0, limit);
  } else if (type === 'album') {
    const page = await client.get<SpotifyPaged<SpotifyTrack>>(`/albums/${id}/tracks`, { limit: String(Math.min(limit, 50)) });
    const items = page?.items ?? [];
    uris = items.map((t) => t.uri).filter(Boolean).slice(0, limit);
    total = page?.total ?? uris.length;
  } else if (type === 'artist') {
    const top = await client.get<{ tracks: SpotifyTrack[] }>(`/artists/${id}/top-tracks`, { market: 'from_token' });
    uris = (top?.tracks ?? []).map((t) => t.uri).filter(Boolean).slice(0, limit);
    total = uris.length;
    if (uris.length === 0) {
      const albums = await client.get<SpotifyPaged<{ id: string }>>(`/artists/${id}/albums`, { limit: '20' });
      for (const al of (albums?.items ?? []).slice(0, 5)) {
        const tr = await client.get<SpotifyPaged<SpotifyTrack>>(`/albums/${al.id}/tracks`, { limit: '20' });
        for (const t of tr?.items ?? []) { if (t?.uri) uris.push(t.uri); if (uris.length >= limit) break; }
        if (uris.length >= limit) break;
      }
      total = uris.length;
      uris = uris.slice(0, limit);
    }
  } else if (type === 'track' || type === 'episode') {
    uris = [sourceUri];
    total = 1;
  } else {
    throw new Error(`Unsupported source type: ${type} — use playlist, album, artist, track or episode`);
  }
  return { uris, sourceType: type, total };
}

export function registerQueueOpsTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'queue_playlist',
    'Queue all tracks from a playlist/album/artist URI in order (cap 200). mode=append adds to end; mode=replace is not supported — Spotify has no queue-clear endpoint.',
    {
      source_uri: z.string().describe('Source Spotify URI (playlist/album/artist/track/episode)'),
      mode: z.enum(['append', 'replace']).default('append').describe('append: add to end; replace: not supported — returns ok:false with guidance'),
      limit: z.number().int().min(1).max(200).optional().describe('Max tracks to queue (cap 200). Default 100.'),
      dry_run: DryRun,
      response_format: ResponseFormat,
      device_id: z.string().optional().describe('Target device id for queue adds'),
    },
    async (args) => {
      // #231: mode=replace must refuse — there is no queue-clear endpoint, so
      // silently appending as "replace" is misleading.
      if (args.mode === 'replace') {
        const guidance = 'Spotify Web API has no queue-clear endpoint — mode=replace cannot be honoured. Use mode=append, or create a playlist with the desired order and play it via the play tool with context_uri.';
        return textResult(guidance, { ok: false, mode: 'replace', guidance, source_uri: args.source_uri });
      }
      const cap = Math.min(args.limit ?? 100, 200);
      const parsed = parseSpotifyUri(args.source_uri as string);
      if (!parsed) throw new Error(`Invalid Spotify URI: ${args.source_uri}`);
      const { uris, sourceType, total } = await resolveUris(client, args.source_uri as string, cap);
      if (uris.length === 0) {
        return textResult(`No tracks found for ${args.source_uri} (${sourceType}).`, { ok: true, source_uri: args.source_uri, source_type: sourceType, total: 0, queued: 0 });
      }
      if (args.dry_run) {
        const preview = uris.slice(0, 5);
        return { content: [{ type: 'text', text: describeDryRun('queue_playlist', args.source_uri as string, [`${args.mode} ${uris.length} tracks (source: ${sourceType}, total ${total})`, ...preview]) }] };
      }
      let queued = 0;
      const failed: string[] = [];
      for (const uri of uris) {
        try {
          const params = new URLSearchParams({ uri });
          if (args.device_id) params.set('device_id', args.device_id as string);
          await client.post(`/me/player/queue?${params}`);
          queued++;
        } catch {
          failed.push(uri);
        }
      }
      const text = `Queued ${queued}/${uris.length} tracks from ${sourceType} ${args.source_uri} (mode=${args.mode})${failed.length ? ` — ${failed.length} failed` : ''}`;
      return mutationResult(args.response_format as string | undefined, { ok: true, source_uri: args.source_uri, source_type: sourceType, mode: args.mode, total, queued, failed }, text);
    },
  );

  // #224: save_queue_as_playlist — capture current queue as durable playlist
  server.tool(
    'save_queue_as_playlist',
    'Capture the current playback queue as a durable playlist. Reads GET /me/player/queue, creates (or appends to) a playlist, adds URIs in batches of 100 preserving order. Handles mixed track/episode URIs.',
    {
      name: z.string().optional().describe('Name for the new playlist (required when creating; omit when target_playlist_id is given)'),
      target_playlist_id: z.string().optional().describe('Existing playlist ID to append to (alternative to name — when given, URIs are appended to this playlist)'),
      description: z.string().optional().describe('Playlist description (when creating a new playlist)'),
      include_current: z.boolean().default(true).describe('Include the currently-playing track/episode as the first item (default true)'),
      include_episodes: z.boolean().default(true).describe('Include episodes in the saved playlist (default true — set false for tracks only)'),
      dry_run: DryRun,
      response_format: ResponseFormat,
    },
    async (args) => {
      const includeCurrent = (args.include_current as boolean | undefined) ?? true;
      const includeEpisodes = (args.include_episodes as boolean | undefined) ?? true;
      const name = args.name as string | undefined;
      const targetId = args.target_playlist_id as string | undefined;

      if (!name && !targetId) {
        throw new Error('Provide either name (to create a new playlist) or target_playlist_id (to append to an existing one).');
      }

      // Fetch current queue
      const queueData = await client.get<{
        currently_playing?: { uri?: string; type?: string; id?: string } | null;
        queue?: Array<{ uri?: string; type?: string; id?: string }>;
      }>('/me/player/queue');

      if (!queueData) {
        return textResult('Could not read the current queue — is something playing? GET /me/player/queue returned no data.', { ok: false, reason: 'no_queue_data' });
      }

      const collected: string[] = [];
      if (includeCurrent && queueData.currently_playing?.uri) {
        const cur = queueData.currently_playing;
        const isEpisode = cur.type === 'episode' || cur.uri?.includes(':episode:');
        if (includeEpisodes || !isEpisode) collected.push(cur.uri!);
      }
      for (const item of queueData.queue ?? []) {
        if (!item?.uri) continue;
        const isEpisode = item.type === 'episode' || item.uri.includes(':episode:');
        if (!includeEpisodes && isEpisode) continue;
        collected.push(item.uri);
      }

      if (collected.length === 0) {
        const hint = !includeEpisodes && (queueData.queue ?? []).some((q) => q.type === 'episode')
          ? ' (queue contained only episodes and include_episodes was false)'
          : '';
        return textResult(`Queue is empty — nothing to save${hint}. Start playback or queue some tracks first.`, { ok: true, empty: true, count: 0 });
      }

      if (args.dry_run) {
        const preview = collected.slice(0, 5);
        const target = targetId ? `playlist ${targetId}` : `new playlist "${name}"`;
        return { content: [{ type: 'text', text: describeDryRun('save_queue_as_playlist', target, [`would save ${collected.length} items from queue`, ...preview]) }] };
      }

      let playlistId: string;
      let playlistUrl: string | undefined;
      let snapshotId: string | undefined;

      if (targetId) {
        playlistId = targetId;
      } else {
        // Create new playlist — need current user id
        const me = await client.get<{ id: string }>('/me');
        if (!me?.id) throw new Error('Could not resolve current user id to create playlist');
        const created = await client.post<{ id: string; external_urls?: { spotify?: string }; snapshot_id?: string }>(
          `/users/${me.id}/playlists`,
          { name: name!, description: (args.description as string | undefined) ?? `Saved from queue on ${new Date().toISOString().slice(0, 10)}`, public: false },
        );
        if (!created?.id) throw new Error('Failed to create playlist');
        playlistId = created.id;
        playlistUrl = created.external_urls?.spotify;
        snapshotId = created.snapshot_id;
      }

      // Add URIs in batches of 100
      let added = 0;
      let lastSnapshot: string | undefined = snapshotId;
      for (let i = 0; i < collected.length; i += 100) {
        const batch = collected.slice(i, i + 100);
        const res = await client.post<{ snapshot_id?: string }>(`/playlists/${playlistId}/tracks`, { uris: batch });
        added += batch.length;
        if (res?.snapshot_id) lastSnapshot = res.snapshot_id;
      }

      const isNew = !targetId;
      const text = isNew
        ? `Saved ${added} items from queue to new playlist "${name}" (${playlistId})${playlistUrl ? ` — ${playlistUrl}` : ''}.`
        : `Appended ${added} items from queue to playlist ${playlistId}.`;

      return mutationResult(args.response_format as string | undefined, {
        ok: true,
        playlist_id: playlistId,
        playlist_url: playlistUrl,
        snapshot_id: lastSnapshot,
        count: added,
        uris: collected,
        is_new: isNew,
      }, text);
    },
  );

  server.tool(
    'batch_add_to_queue',
    'Add multiple URIs to the playback queue in one shot. POSTs each URI to /me/player/queue and returns a summary of queued/failed counts. Quota: 🟡 N writes (one POST per URI).',
    {
      uris: z.array(z.string()).min(1).max(200).describe('Spotify track/episode URIs to queue (1–200)'),
      device_id: z.string().optional().describe('Target device id'),
      dry_run: DryRun,
      response_format: ResponseFormat,
    },
    async (args) => {
      const uriList = args.uris as string[];
      for (const uri of uriList) {
        const parsed = parseSpotifyUri(uri);
        if (!parsed || (parsed.type !== 'track' && parsed.type !== 'episode')) {
          throw new Error(`Invalid Spotify track/episode URI: ${uri}`);
        }
      }
      if (args.dry_run) {
        return { content: [{ type: 'text', text: describeDryRun('batch_add_to_queue', `${uriList.length} URIs to queue`, [`Would queue ${uriList.length} URI(s)`]) }] };
      }
      const { queued, failed } = await addToQueueBatch(client, uriList, args.device_id as string | undefined);
      const text = `Queued ${queued}/${uriList.length} tracks${failed.length ? ` — ${failed.length} failed` : ''}`;
      return mutationResult(args.response_format as string | undefined, { ok: true, queued, failed, total: uriList.length }, text);
    },
  );
}
