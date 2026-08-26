/**
 * queueops (#194, #202): queue_playlist + queue stubs (reorder/remove/clear).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { DryRun, describeDryRun, parseSpotifyUri, ResponseFormat } from '../shaping.js';
import { getConfig } from '../config.js';
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
    // fetch top tracks as proxy (avoids paging albums)
    const top = await client.get<{ tracks: SpotifyTrack[] }>(`/artists/${id}/top-tracks`, { market: 'from_token' });
    uris = (top?.tracks ?? []).map((t) => t.uri).filter(Boolean).slice(0, limit);
    total = uris.length;
    // fallback: fetch albums if top-tracks empty
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
    'Queue all tracks from a playlist/album/artist URI in order (cap 200). mode=append adds to end; mode=replace notes clear+rebuild fallback.',
    {
      source_uri: z.string().describe('Source Spotify URI (playlist/album/artist/track/episode)'),
      mode: z.enum(['append', 'replace']).default('append').describe('append or replace queue'),
      limit: z.number().int().min(1).max(200).optional().describe('Max tracks to queue (cap 200). Default 100.'),
      dry_run: DryRun,
      response_format: ResponseFormat,
      device_id: z.string().optional().describe('Target device id for queue adds'),
    },
    async (args) => {
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
      if (args.mode === 'replace') {
        // No native clear: attempt best-effort via queue_clear guidance in structuredContent
      }
      let queued = 0;
      const failed: string[] = [];
      for (const uri of uris) {
        try {
          const params = new URLSearchParams({ uri });
          if (args.device_id) params.set('device_id', args.device_id);
          await client.post(`/me/player/queue?${params}`);
          queued++;
        } catch (e) {
          failed.push(uri);
        }
      }
      const text = `Queued ${queued}/${uris.length} tracks from ${sourceType} ${args.source_uri} (mode=${args.mode})${failed.length ? ` — ${failed.length} failed` : ''}${args.mode === 'replace' ? ' — note: Spotify has no native queue-clear; queued items were appended (clear+rebuild fallback).' : ''}`;
      return mutationResult(args.response_format, { ok: true, source_uri: args.source_uri, source_type: sourceType, mode: args.mode, total, queued, failed }, text);
    },
  );

  const guidance = 'Spotify Web API has no queue-reorder/remove/clear endpoint. Workaround: create a temporary playlist with the desired order and use playback with context, or use queue_playlist in replace mode (clear+rebuild fallback).';

  server.tool(
    'queue_reorder',
    'Reorder an item in the upcoming queue (proposal stub — Spotify has no reorder endpoint; returns guidance and attempts best-effort if a future endpoint appears).',
    {
      uri: z.string().optional().describe('Track/episode URI to move'),
      position: z.number().int().min(0).optional().describe('Target position in queue (0 = next)'),
      response_format: ResponseFormat,
      dry_run: DryRun,
    },
    async (args) => {
      if (args.dry_run) return { content: [{ type: 'text', text: describeDryRun('queue_reorder', args.uri ?? 'queue', [guidance]) }] };
      // Attempt future endpoint; fall back to guidance
      try {
        await client.put('/me/player/queue/reorder', { uri: args.uri, position: args.position });
        return mutationResult(args.response_format, { ok: true, uri: args.uri, position: args.position }, `Reordered ${args.uri} to position ${args.position}.`);
      } catch (e: any) {
        const msg = e?.status === 403 || e?.status === 404 ? guidance : `queue_reorder not available: ${e?.message ?? e}. ${guidance}`;
        return textResult(msg, { ok: false, fallback: 'clear+rebuild', guidance, uri: args.uri, position: args.position });
      }
    },
  );

  server.tool(
    'queue_remove',
    'Remove a track from the upcoming queue (proposal stub — falls back to guidance if no endpoint).',
    {
      uri: z.string().optional().describe('Track/episode URI to remove'),
      response_format: ResponseFormat,
      dry_run: DryRun,
    },
    async (args) => {
      if (args.dry_run) return { content: [{ type: 'text', text: describeDryRun('queue_remove', args.uri ?? 'queue', [guidance]) }] };
      try {
        const qs = args.uri ? `?uri=${encodeURIComponent(args.uri)}` : '';
        await client.delete(`/me/player/queue${qs}`);
        return mutationResult(args.response_format, { ok: true, uri: args.uri }, `Removed ${args.uri ?? 'next item'} from queue.`);
      } catch (e: any) {
        return textResult(`queue_remove not available: ${e?.message ?? e}. ${guidance}`, { ok: false, fallback: 'clear+rebuild', guidance, uri: args.uri });
      }
    },
  );

  server.tool(
    'queue_clear',
    'Clear the upcoming queue (proposal stub — Spotify has no clear endpoint; returns guidance).',
    { response_format: ResponseFormat, dry_run: DryRun },
    async (args) => {
      if (args.dry_run) return { content: [{ type: 'text', text: describeDryRun('queue_clear', 'queue', [guidance]) }] };
      try {
        await client.delete('/me/player/queue');
        return mutationResult(args.response_format, { ok: true }, 'Queue cleared.');
      } catch (e: any) {
        return textResult(`queue_clear not available: ${e?.message ?? e}. ${guidance}`, { ok: false, fallback: 'clear+rebuild', guidance });
      }
    },
  );
}
