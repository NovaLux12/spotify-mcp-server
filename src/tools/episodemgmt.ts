/**
 * episodemgmt (#204, #187, #230): archive_played_episodes.
 * mark_episode_played was removed in #230 — PUT /me/episodes/{id} with
 * resume_point is not a real Spotify endpoint (real endpoint is
 * PUT /me/episodes?ids= to save). The tool swallowed 404s and reported
 * ok:true, which was phantom success. Removed per #85 precedent.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { confirmViaElicitation, describeConfirmation, requiredConfirmationRefusal } from './confirm.js';
import { DryRun, describeDryRun, ResponseFormat } from '../shaping.js';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown> };
function textResult(text: string, s?: Record<string, unknown>): ToolResult { return { content: [{ type: 'text', text }], ...(s ? { structuredContent: s } : {}) }; }
function emit(fmt: string | undefined, echo: Record<string, unknown>, text: string): ToolResult {
  if (fmt === 'json') return { content: [{ type: 'text', text: JSON.stringify(echo, null, 2) }], structuredContent: echo };
  return { content: [{ type: 'text', text }], structuredContent: echo };
}

export function registerEpisodeMgmtTools(server: McpServer, client: SpotifyClient): void {
  server.tool('archive_played_episodes',
    'Remove fully-played episodes from your episode library in bulk (checks resume_point.fully_played). Batch DELETE /me/episodes; archives over 50 episodes require elicitation confirmation (or SPOTIFY_MCP_CONFIRM=never for automation); dry_run supported.',
    {
      dry_run: DryRun,
      response_format: ResponseFormat,
      limit: z.number().int().min(1).max(500).optional().describe('Max episodes to scan (default 100).'),
      // Accepted so a 1.31.0 caller does not get a hard unknown_param error, but
      // deliberately NOT an authorization: this boolean used to bypass the
      // confirmation gate, which is exactly the write-without-a-human the gate
      // exists to prevent. It now only records intent; the elicitation (or the
      // server-wide SPOTIFY_MCP_CONFIRM=never) still decides.
      confirm: z.boolean().optional().describe('Deprecated and ignored: it no longer authorises the write. Over 50 episodes requires elicitation confirmation, or SPOTIFY_MCP_CONFIRM=never.'),
    },
    async (args) => {
      const cap = (args.limit as number) ?? 100;
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
      const deprecatedInputs = args.confirm === undefined ? [] : ['confirm'];
      const played = items.filter((r) => r?.episode?.resume_point?.fully_played);
      if (played.length === 0) return textResult(`No fully-played episodes in library (scanned ${items.length}).`, { ok: true, scanned: items.length, played: 0, ...(deprecatedInputs.length ? { deprecated_inputs: deprecatedInputs, deprecation_note: '`confirm` is accepted but ignored: it no longer authorises the delete. Use elicitation, or set SPOTIFY_MCP_CONFIRM=never to automate.' } : {}) });
      const ids = played.map((r) => r.episode.id);
      const uris = played.map((r) => r.episode.uri);
      if (args.dry_run) {
        const preview = played.slice(0, 5).map((r) => r.episode.name);
        return { content: [{ type: 'text', text: describeDryRun('archive_played_episodes', `${items.length} saved episodes`, [`would remove ${played.length} fully-played episodes`, ...preview]) }] };
      }
      if (played.length > 50) {
        const verdict = await confirmViaElicitation(server, {
          message: describeConfirmation('remove from episode library', 'fully-played episodes', [
            `Remove ${played.length} fully-played episode(s):`,
            ...uris.slice(0, 5),
            ...(uris.length > 5 ? [`(…and ${uris.length - 5} more)`] : []),
          ]),
          confirmLabel: 'Archive played episodes',
        });
        const refusal = requiredConfirmationRefusal(verdict);
        // Tell a legacy caller on every exit, not just the happy path: this is
        // where a caller that sent `confirm: true` learns it did not authorise
        // anything.
        if (refusal) return textResult(refusal.message, deprecatedInputs.length
          ? { ...refusal.payload, deprecated_inputs: deprecatedInputs, deprecation_note: '`confirm` was accepted but ignored: it no longer authorises the delete.' }
          : refusal.payload);
      }
      let removed = 0;
      for (let i = 0; i < ids.length; i += 50) {
        const batch = ids.slice(i, i + 50);
        await client.delete(`/me/episodes?ids=${batch.join(',')}`);
        removed += batch.length;
      }
      return emit(args.response_format as string, { ok: true, scanned: items.length, removed, ids, ...(deprecatedInputs.length ? { deprecated_inputs: deprecatedInputs, deprecation_note: '`confirm` was accepted but ignored: it no longer authorises the delete.' } : {}) }, `Archived ${removed} fully-played episodes.`);
    });
}
