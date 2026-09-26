import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import type { FollowedArtistsResponse, SpotifyArtistFull } from '../types/spotify.js';
import { classifySpotifyReference } from '../refs.js';
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
import { CHUNK_CAPS, capFor } from '../chunk.js';
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

/** `/me/following` accepts at most 50 rows per page. */
const FOLLOWED_PAGE_LIMIT = CHUNK_CAPS.followed;

interface FollowedArtistsWalk {
  /** Every artist collected, already sliced to the fetch-all cap. */
  items: SpotifyArtistFull[];
  /** Server-reported total when Spotify sends one, else the walked count. */
  total: number;
  /** The walk stopped at fetchAllCap, so the caller is not seeing everything. */
  truncatedByCap: boolean;
  /** Resume cursor for the page the walk stopped on; null when it ran out. */
  nextCursor: string | null;
}

/**
 * Cursor-walk `/me/following?type=artist` (#744).
 *
 * This endpoint pages by an `after` cursor, which `client.getAllPages` does
 * not support, so the walk is explicit — the loop following_analytics already
 * ran inline, lifted here so the two follow readers cannot drift apart. Every
 * page is `limit=50`, and the walk stops at `getConfig().fetchAllCap`
 * (SPOTIFY_MCP_FETCH_ALL_CAP) rather than paging without bound.
 */
async function walkFollowedArtists(client: SpotifyClient): Promise<FollowedArtistsWalk> {
  const cap = getConfig().fetchAllCap;
  const items: SpotifyArtistFull[] = [];
  let after: string | undefined;
  let total = 0;
  let nextCursor: string | null = null;
  for (;;) {
    const params: Record<string, string> = {
      type: 'artist',
      limit: String(FOLLOWED_PAGE_LIMIT),
    };
    if (after) params.after = after;
    const res = await client.get<FollowedArtistsResponse>('/me/following', params);
    const followed = res?.artists;
    const page = Array.isArray(followed?.items) ? followed!.items! : [];
    total = typeof followed?.total === 'number' ? followed.total : total + page.length;
    items.push(...page);
    nextCursor = followed?.cursors?.after ?? null;
    // A full page with a cursor is the only case where another request can
    // return anything; a short page or a missing cursor ends the walk.
    if (!nextCursor || page.length < FOLLOWED_PAGE_LIMIT) break;
    if (items.length >= cap) break;
    after = nextCursor;
  }
  const truncatedByCap = items.length >= cap;
  return {
    items: truncatedByCap ? items.slice(0, cap) : items,
    total,
    truncatedByCap,
    // A completed walk has nothing left to resume; only a capped walk does.
    nextCursor: truncatedByCap ? nextCursor : null,
  };
}

/**
 * Normalize one artist reference to the bare ID the follow endpoints expect
 * (#745). The same policy as `normalizePlaylistReference`: a bare id, a
 * `spotify:artist:` URI and an open.spotify.com/artist URL are one id on the
 * wire, and a wrong-kind reference is rejected here rather than sent to
 * Spotify as an opaque id that comes back as a bare 400. `allowShortIds`
 * keeps the short ids these tools have always accepted.
 */
function normalizeArtistReference(reference: string): string {
  const parsed = classifySpotifyReference(reference, 'artist', { allowShortIds: true });
  if (!parsed.valid || !parsed.id) {
    throw new Error(
      `Invalid artist reference "${reference}": ${parsed.error ?? 'invalid Spotify artist reference'}`,
    );
  }
  return parsed.id;
}

/**
 * The id list actually put on the wire (#745). Hosts that serialise array
 * parameters as CSV hand us `"a,b"` or `"spotify:artist:a,spotify:artist:b"`,
 * so a single string is split the same way an array is.
 */
function normalizeArtistIds(input: unknown): string[] {
  const values = Array.isArray(input) ? input : [input];
  return values
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map(normalizeArtistReference);
}

/** `ids` as an array of references, tolerating a CSV string (#745). */
const ArtistIds = z.preprocess(
  (value) => (typeof value === 'string' ? value.split(',') : value),
  z.array(z.string().min(1)).min(1).max(50),
);

export function registerFollowingTools(server: McpServer, client: SpotifyClient): void {

  // get_followed_artists
  server.tool(
    'get_followed_artists',
    'Get the artists the user follows. fetch_all=true walks every page; limit/after page manually.',
    {
      limit: z.number().int().min(1).max(50).optional().describe('1–50. Default: 20'),
      after: z
        .string()
        .optional()
        .describe('Artist ID cursor for pagination (from previous response)'),
      fetch_all: z
        .boolean()
        .optional()
        .describe('Walk every page instead of one page (ignores limit)'),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const rf = args.response_format;

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

      // fetch_all walks the `after` cursor to the end instead of returning the
      // first page. It deliberately bypasses max_results: the caller asked for
      // the whole follow list, so everything walked is rendered and the
      // payload reports when the fetch-all cap cut the walk short.
      if (args.fetch_all) {
        const walk = await walkFollowedArtists(client);
        const pagination = paginationInfo({ total: walk.total, returned: walk.items.length });
        const extra = {
          fetch_all: true,
          next_cursor: walk.nextCursor,
          truncated_by_cap: walk.truncatedByCap,
        };
        if (walk.items.length === 0) {
          return shapeResult(
            rf,
            'Followed artists (0 fetched, showing 0).',
            listStructuredContent([], pagination, extra),
          );
        }
        const fetched = walk.items.length;
        const header = walk.truncatedByCap
          ? `Followed artists (${fetched} fetched of ${walk.total}, showing ${fetched}):`
          : `Followed artists (${fetched} fetched, showing ${fetched}):`;
        const lines = [header];
        for (const artist of walk.items) lines.push(renderArtistLine(artist));
        if (walk.truncatedByCap) {
          const remaining = walk.total > fetched ? walk.total - fetched : null;
          lines.push(
            remaining === null
              ? `(fetch-all cap REACHED — more follows may remain; pass after=${walk.nextCursor} to continue)`
              : `(${remaining} more — fetch-all cap REACHED; pass after=${walk.nextCursor} to continue)`,
          );
        }
        return shapeResult(rf, lines.join('\n'), listStructuredContent(walk.items, pagination, extra));
      }
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
    'Check if the user follows specific artists — this tests FOLLOW state, not library-saved state (for that use check_in_library). Accepts IDs or spotify:artist: URIs. Rows carry {id, uri, follows}; returns a boolean per ID. Max 50.',
    {
      ids: ArtistIds.describe('Artist IDs, spotify:artist: URIs, or artist URLs; CSV accepted'),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const ids = normalizeArtistIds(args.ids);
      const result = await client.get<boolean[]>('/me/following/contains', {
        type: 'artist',
        ids: ids.join(','),
      });
      if (!result) throw new Error('Could not check following status');

      // #110 finding 11: rows carry a full URI alongside the id so agents
      // can chain into other tools without reconstructing URIs. `follows`
      // is the only truthful boolean here — following/contains says nothing
      // about library-saved state.
      const checks = ids.map((id, i) => ({
        id,
        uri: `spotify:artist:${id}`,
        follows: result[i] ?? false,
      }));
      const t = truncateItems(checks, cap(args));
      const pagination = paginationInfo({ total: checks.length, returned: t.items.length });

      const lines = ['Following check:'];
      for (const c of t.items) {
        const mark = c.follows;
        lines.push(`  ${mark ? '✓' : '✗'} ${c.uri} (id: ${c.id})`);
      }
      appendPaginationFooters(lines, t, pagination);
      return shapeResult(args.response_format, lines.join('\n'), listStructuredContent(t.items, pagination));
    },
  );

  // follow_artists
  server.tool(
    'follow_artists',
    'Follow artists (1–50 IDs, spotify:artist: URIs, or artist URLs). Requires user-follow-modify. dry_run=true previews.',
    {
      ids: ArtistIds.describe('Artist IDs, spotify:artist: URIs, or artist URLs; CSV accepted'),
      dry_run: z
        .boolean()
        .optional()
        .describe('Preview only: show exactly which artists would be followed without calling the API'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const ids = normalizeArtistIds(args.ids);
      const artistUris = ids.map((id) => `spotify:artist:${id}`);
      if (args.dry_run) {
        return dryRunOut(args.response_format, 'follow_artists', 'followed artists', artistUris);
      }
      // Spotify takes ids/type as query parameters on PUT /me/following,
      // not a request body.
      await client.put(`/me/following?type=artist&ids=${ids.join(',')}`);
      return mutationOut(
        args.response_format,
        `Followed ${ids.length} artist(s).`,
        ids.length,
        artistUris,
      );
    },
  );

  // unfollow_artists
  server.tool(
    'unfollow_artists',
    'Unfollow artists (1–50 IDs, spotify:artist: URIs, or artist URLs). Requires user-follow-modify. dry_run=true previews.',
    {
      ids: ArtistIds.describe('Artist IDs, spotify:artist: URIs, or artist URLs; CSV accepted'),
      dry_run: z
        .boolean()
        .optional()
        .describe('Preview only: show exactly which artists would be unfollowed without calling the API'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const ids = normalizeArtistIds(args.ids);
      const artistUris = ids.map((id) => `spotify:artist:${id}`);
      if (args.dry_run) {
        return dryRunOut(args.response_format, 'unfollow_artists', 'followed artists', artistUris);
      }
      // Symmetric with follow_artists: query parameters, no body.
      await client.delete(`/me/following?type=artist&ids=${ids.join(',')}`);
      return mutationOut(
        args.response_format,
        `Unfollowed ${ids.length} artist(s).`,
        ids.length,
        artistUris,
      );
    },
  );

  // following_analytics (#297)
  server.tool(
    'following_analytics',
    'Analytics over followed artists: genre/popularity rollups via batch /artists?ids= enrichment. Quota: 🟢 GET /me/following + GET /artists batches.',
    {
      group_by: z.enum(['genre', 'popularity', 'followers']).default('genre').describe('Rollup dimension for the report'),
      top_n: z.number().int().min(1).max(50).optional().describe('Top N groups to show'),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const rf = args.response_format;
      // The same cursor walk get_followed_artists(fetch_all) uses (#744), so
      // the two follow readers can never disagree about how far a walk goes.
      const all = (await walkFollowedArtists(client)).items;
      if (all.length === 0) return shapeResult(rf, 'No followed artists.', listStructuredContent([], paginationInfo({ total: 0, returned: 0 })));
      // Enrich in batches of CHUNK_CAPS.artists via /artists?ids=
      const enriched: SpotifyArtistFull[] = [];
      const artistCap = capFor('artists');
      for (let i = 0; i < all.length; i += artistCap) {
        const ids = all.slice(i, i + artistCap).map(a => a.id).join(',');
        const batch = await client.get<{ artists: SpotifyArtistFull[] }>('/artists', { ids });
        if (batch?.artists) enriched.push(...batch.artists.filter(Boolean));
      }
      const src = enriched.length ? enriched : all;
      let groups: Array<{ key: string; count: number }> = [];
      if (args.group_by === 'genre') {
        const m = new Map<string, number>();
        for (const a of src) for (const g of (a.genres ?? [])) m.set(g, (m.get(g) ?? 0) + 1);
        groups = [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
      } else if (args.group_by === 'popularity') {
        const buckets = new Map<string, number>();
        for (const a of src as Array<SpotifyArtistFull & { popularity?: number }>) { const pop = (a as unknown as { popularity?: number }).popularity ?? 0; const bucket = pop >= 75 ? '75-100' : pop >= 50 ? '50-74' : pop >= 25 ? '25-49' : '0-24'; buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1); }
        groups = [...buckets.entries()].map(([key, count]) => ({ key, count })).sort((a,b)=>b.count-a.count);
      } else {
        const buckets = new Map<string, number>();
        for (const a of src as Array<SpotifyArtistFull & { followers?: { total: number } }>) { const f = (a as unknown as { followers?: { total: number } }).followers?.total ?? 0; const bucket = f >= 1000000 ? '1M+' : f >= 100000 ? '100K-1M' : f >= 10000 ? '10K-100K' : '<10K'; buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1); }
        groups = [...buckets.entries()].map(([key, count]) => ({ key, count })).sort((a,b)=>b.count-a.count);
      }
      const topN = args.top_n ?? 10;
      const view = truncateItems(groups, Math.min(topN, cap(args)));
      const pagination = paginationInfo({ total: groups.length, returned: view.items.length });
      const lines = [`Following analytics (${src.length} artists, by ${args.group_by}):`];
      for (const g of view.items) lines.push(`  ${g.key}: ${g.count}`);
      if (view.footer) lines.push(`(${view.footer})`);
      return shapeResult(rf, lines.join('\n'), listStructuredContent(view.items, pagination, { total_artists: src.length, group_by: args.group_by }));
    },
  );
}
