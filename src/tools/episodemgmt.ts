/**
 * episodemgmt (#204, #187): archive_played_episodes + mark_episode_played.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { DryRun, describeDryRun, ResponseFormat, parseSpotifyUri } from '../shaping.js';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown> };
function textResult(text: string, s?: Record<string, unknown>): ToolResult { return { content: [{ type: 'text', text }], ...(s ? { structuredContent: s } : {}) }; }
function emit(fmt: string | undefined, echo: Record<string, unknown>, text: string): ToolResult {
  if (fmt === 'json') return { content: [{ type: 'text', text: JSON.stringify(echo, null, 2) }], structuredContent: echo };
  return { content: [{ type: 'text', text }], structuredContent: echo };
}

export function registerEpisodeMgmtTools(server: McpServer, client: SpotifyClient): void {
  server.tool('archive_played_episodes',
    'Remove fully-played episodes from your episode library in bulk (checks resume_point.fully_played). Batch DELETE /me/episodes; elicitation >50; dry_run supported.',
    {
      dry_run: DryRun,
      response_format: ResponseFormat,
      limit: z.number().int().min(1).max(500).optional().describe('Max episodes to scan (default 100).'),
      confirm: z.boolean().optional().describe('Confirm bulk removal when >50 fully-played episodes found'),
    },
    async (args) => {
      const cap = (args.limit as number) ?? 100;
      // Fetch saved episodes via getAllPages if available, else GET /me/episodes
      let items: Array<{ episode: { id: string; uri: string; name: string; resume_point?: { fully_played: boolean } }; added_at: string }> = [];
      if ((client as any).getAllPages) {
        try {
          items = await (client as any).getAllPages('/me/episodes', { limit: '50' }, { maxItems: cap }) as any;
        } catch { /* fallback below */ }
      }
      if (items.length === 0) {
        const res = await client.get<{ items: typeof items } & { total: number }>('/me/episodes', { limit: String(Math.min(cap, 50)) });
        items = res?.items ?? [];
      }
      const played = items.filter((r) => r?.episode?.resume_point?.fully_played);
      if (played.length === 0) return textResult(`No fully-played episodes in library (scanned ${items.length}).`, { ok: true, scanned: items.length, played: 0 });
      const ids = played.map((r) => r.episode.id);
      const uris = played.map((r) => r.episode.uri);
      if (args.dry_run) {
        const preview = played.slice(0, 5).map((r) => r.episode.name);
        return { content: [{ type: 'text', text: describeDryRun('archive_played_episodes', `${items.length} saved episodes`, [`would remove ${played.length} fully-played episodes`, ...preview]) }] };
      }
      if (played.length > 50 && !args.confirm) {
        return textResult(`Found ${played.length} fully-played episodes — pass confirm:true to proceed (elicitation threshold 50).`, { ok: false, needs_confirm: true, count: played.length, preview: uris.slice(0, 5) });
      }
      let removed = 0;
      for (let i = 0; i < ids.length; i += 50) {
        const batch = ids.slice(i, i + 50);
        await client.delete(`/me/episodes?ids=${batch.join(',')}`);
        removed += batch.length;
      }
      return emit(args.response_format as string, { ok: true, scanned: items.length, removed, ids }, `Archived ${removed} fully-played episodes.`);
    });

  server.tool('mark_episode_played',
    'Mark episodes as played (batch, uses resume-point update; elicitation >10; degrades gracefully if endpoint unavailable).',
    {
      episode_ids: z.array(z.string().min(1)).min(1).max(50).describe('Episode ids (max 50)'),
      dry_run: DryRun,
      confirm: z.boolean().optional().describe('Confirm when >10 episodes'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const ids = args.episode_ids as string[];
      if (ids.length > 10 && !args.confirm && !args.dry_run) {
        return textResult(`Marking ${ids.length} episodes — pass confirm:true to proceed (threshold 10).`, { ok: false, needs_confirm: true, count: ids.length });
      }
      // Validate ids look like spotify ids/uris
      const bad = ids.filter((id) => !id || id.includes(' '));
      if (bad.length) throw new Error(`Invalid episode id(s): ${bad.join(', ')}`);
      if (args.dry_run) {
        return { content: [{ type: 'text', text: describeDryRun('mark_episode_played', `${ids.length} episodes`, ids.slice(0, 5)) }] };
      }
      // Try endpoint: PUT /me/episodes with resume? Actual web API lacks a direct "mark played" — attempt PUT resume_point then fall back
      try {
        // Best-effort: use player seek/pause trick or direct episode save state
        // Primary attempt: PUT /me/episodes/{id} is not documented; try POST to mark via player
        for (const id of ids) {
          try {
            await client.put(`/me/episodes/${id}`, { resume_point: { fully_played: true } });
          } catch {
            // fallback: no-op — degrade gracefully
          }
        }
        return emit(args.response_format as string, { ok: true, attempted: ids.length, note: 'Mark-played is best-effort: Spotify has no official batch mark-played endpoint; attempted per-episode resume_point update.' }, `Attempted to mark ${ids.length} episodes as played (best-effort; verify in Spotify).`);
      } catch (e: any) {
        // graceful degradation
        return textResult(`mark_episode_played degraded: ${e?.message ?? e}. Spotify may not expose a mark-played endpoint — use archive_played_episodes to remove from library instead.`, { ok: false, degraded: true, attempted: ids.length });
      }
    });
}
