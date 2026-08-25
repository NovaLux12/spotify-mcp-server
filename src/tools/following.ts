import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import type { FollowedArtistsResponse, SpotifyArtistFull } from '../types/spotify.js';
import {
  ResponseFormat,
  MaxResults,
  resolveMaxResults,
  truncateItems,
  paginationInfo,
  listStructuredContent,
  batchSummary,
  describeDryRun,
} from '../shaping.js';
import type { ResponseFormatValue, PaginationInfo } from '../shaping.js';
import { getConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Shared result shaping (#51/#52/#58 helpers composed locally per file)
// ---------------------------------------------------------------------------

type ToolOut = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
}

/**
 * Emit a tool result (#51): `json` mode stringifies the machine-readable
 * payload; every mode attaches it as MCP structuredContent (#52).
 */
function shapeResult(
  rf: ResponseFormatValue,
  prose: string,
  payload: Record<string, unknown>,
): ToolOut {
  return {
    content: [
      { type: 'text', text: rf === 'json' ? JSON.stringify(payload, null, 2) : prose },
    ],
    structuredContent: payload,
  };
}

/** Per-call cap: explicit max_results wins over SPOTIFY_MCP_MAX_ITEMS (#53). */
function cap(args: { max_results?: number }): number {
  return resolveMaxResults(args.max_results, getConfig().maxItems);
}

/** Mutation confirmation (#58): prose plus "{n} items affected: …" echo. */
function mutationOut(
  rf: ResponseFormatValue,
  prose: string,
  n: number,
  uris: readonly string[],
): ToolOut {
  const payload = { ok: true, affected: n, uris: [...uris] };
  return shapeResult(rf, `${prose}\n${batchSummary(n, uris)}`, payload);
}

/** dry_run preview (#57): deterministic diff text, zero mutating calls made. */
function dryRunOut(
  rf: ResponseFormatValue,
  action: string,
  target: string,
  changes: readonly string[],
): ToolOut {
  const payload = {
    ok: true,
    dry_run: true,
    action,
    target,
    would_affect: [...changes],
  };
  return shapeResult(rf, describeDryRun(action, target, changes), payload);
}

/**
 * Pagination footers (#52/#53): the truncation footer when this call sliced
 * items client-side, otherwise a next-offset hint while more remain.
 */
function appendPaginationFooters(
  lines: string[],
  t: { footer: string | null },
  pagination: PaginationInfo,
): void {
  if (t.footer) {
    lines.push(`(${t.footer})`);
  } else if (pagination.next_offset !== null) {
    lines.push(`(More available — pass offset=${pagination.next_offset} for the next page)`);
  }
}

export function registerFollowingTools(server: McpServer, client: SpotifyClient): void {

  // get_followed_artists
  server.tool(
    'get_followed_artists',
    'Get all artists the user follows (cursor-based pagination)',
    {
      limit: z.number().int().min(1).max(50).optional().describe('1–50. Default: 20'),
      after: z
        .string()
        .optional()
        .describe('Artist ID cursor for pagination (from previous response)'),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const rf = args.response_format;
      const params: Record<string, string> = {
        type: 'artist',
        limit: String(args.limit ?? 20),
      };
      if (args.after) params.after = args.after;

      const result = await client.get<FollowedArtistsResponse>('/me/following', params);
      if (!result) throw new Error('Could not retrieve followed artists');

      // Same defensive guard as issue #3 — \`result.artists\` is what Spotify
      // returns on success but can be null/undefined on edge cases
      // (e.g. account with zero followed artists, transient state issue).
      // Validate before reading .items.length to avoid the crash on issue #4.
      const followed = result.artists ?? {
        items: [],
        total: 0,
        cursors: null,
        next: null,
      };
      const items = Array.isArray(followed.items) ? followed.items : [];
      const total = typeof followed.total === 'number' ? followed.total : items.length;
      const detailed = rf === 'detailed';
      const renderArtistLine = (artist: SpotifyArtistFull): string => {
        const genres =
          Array.isArray(artist.genres) && artist.genres.length > 0
            ? artist.genres.join(', ')
            : 'no genres listed';
        let line = `  • ${artist.name} — ${genres} | URI: ${artist.uri}`;
        if (detailed) line += ` | ID: ${artist.id}`;
        return line;
      };

      const t = truncateItems(items, cap(args));
      const pagination = paginationInfo({ total, returned: t.items.length });
      const extra = {
        cursors: followed.cursors ?? null,
        next_cursor: followed.cursors?.after ?? null,
      };

      if (t.items.length === 0) {
        return shapeResult(
          rf,
          `Followed artists (${total} total, showing 0).`,
          listStructuredContent([], pagination, extra),
        );
      }

      const lines = [`Followed artists (${total} total, showing ${t.items.length}):`];
      for (const artist of t.items) lines.push(renderArtistLine(artist));
      if (t.truncated) {
        lines.push(`(${t.remaining} more — pass max_results to raise this call's cap)`);
      }
      if (followed.cursors?.after) {
        lines.push(`\nNext page cursor: ${followed.cursors.after}`);
      }
      return shapeResult(rf, lines.join('\n'), listStructuredContent(t.items, pagination, extra));
    },
  );

  // check_following_artists
  server.tool(
    'check_following_artists',
    'Check if the user follows specific artists. Returns a boolean per ID. Max 50.',
    {
      ids: z.array(z.string()).min(1).max(50).describe('Spotify artist IDs to check'),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const result = await client.get<boolean[]>('/me/following/contains', {
        type: 'artist',
        ids: args.ids.join(','),
      });
      if (!result) throw new Error('Could not check following status');

      const checks = args.ids.map((id, i) => ({ id, follows: result[i] ?? false }));
      const t = truncateItems(checks, cap(args));
      const pagination = paginationInfo({ total: checks.length, returned: t.items.length });

      const lines = ['Following check:'];
      for (const c of t.items) lines.push(`  ${c.follows ? '✓' : '✗'} ${c.id}`);
      appendPaginationFooters(lines, t, pagination);
      return shapeResult(args.response_format, lines.join('\n'), listStructuredContent(t.items, pagination));
    },
  );

  // follow_artists
  server.tool(
    'follow_artists',
    'Follow one or more artists (1–50 IDs). Requires user-follow-modify.',
    {
      ids: z.array(z.string()).min(1).max(50).describe('Spotify artist IDs to follow'),
      response_format: ResponseFormat,
    },
    async (args) => {
      // Spotify takes ids/type as query parameters on PUT /me/following,
      // not a request body.
      await client.put(`/me/following?type=artist&ids=${args.ids.join(',')}`);
      const artistUris = args.ids.map((id) => `spotify:artist:${id}`);
      return mutationOut(
        args.response_format,
        `Followed ${args.ids.length} artist(s).`,
        args.ids.length,
        artistUris,
      );
    },
  );

  // unfollow_artists
  server.tool(
    'unfollow_artists',
    'Unfollow one or more artists (1–50 IDs). Requires user-follow-modify. Set dry_run=true to preview.',
    {
      ids: z.array(z.string()).min(1).max(50).describe('Spotify artist IDs to unfollow'),
      dry_run: z
        .boolean()
        .optional()
        .describe('Preview only: show exactly which artists would be unfollowed without calling the API'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const artistUris = args.ids.map((id) => `spotify:artist:${id}`);
      if (args.dry_run) {
        return dryRunOut(args.response_format, 'unfollow_artists', 'followed artists', artistUris);
      }
      // Symmetric with follow_artists: query parameters, no body.
      await client.delete(`/me/following?type=artist&ids=${args.ids.join(',')}`);
      return mutationOut(
        args.response_format,
        `Unfollowed ${args.ids.length} artist(s).`,
        args.ids.length,
        artistUris,
      );
    },
  );
}
