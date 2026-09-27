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
} from '../shaping.js';
import type { ResponseFormatValue, PaginationInfo } from '../shaping.js';
import { CHUNK_CAPS } from '../chunk.js';
import { getConfig } from '../config.js';
import { loadGenreTags, tagsForArtist } from './libraryinsights.js';

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

// #638: `mutationOut` and `dryRunOut` were removed with the follow WRITE tools.
// Every mutating tool this module shipped (`follow_artists`, `unfollow_artists`)
// targeted `PUT`/`DELETE /me/following?type=artist`, which Spotify removed in
// February 2026 and for which no endpoint accepts a replacement — PUT/DELETE
// /me/library take no `spotify:artist:` URI (see LIBRARY_SAVE_TYPES in
// library.ts, which omits `artist` on purpose). The read half migrated to GET
// /me/library/contains and survives as `check_following_artists`; the write
// half has no target, so the helpers that only existed to shape it went too.

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

export interface FollowedArtistsWalk {
  /** Every artist collected, already sliced to the fetch-all cap. */
  items: SpotifyArtistFull[];
  /** The count Spotify itself reported, or null when it sent none (#718). */
  reportedTotal: number | null;
  /** The fetch-all cap is what ended the walk, so rows past it were never asked for. */
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
 *
 * The verdict is the loop's own exit reason, never the collected count (#718).
 * `items.length >= cap` fires on a follow list that happens to END at exactly
 * the cap — nothing was dropped, and "truncated ... for the rest" would
 * invent a rest that does not exist. `stoppedByCap` records which branch
 * actually ended the walk; `reportedTotal` is the server's own number, or
 * null when it sent none, so a caller can never read the walked count off as
 * the size of the follow list.
 */
export async function walkFollowedArtists(client: SpotifyClient): Promise<FollowedArtistsWalk> {
  const cap = getConfig().fetchAllCap;
  const items: SpotifyArtistFull[] = [];
  let after: string | undefined;
  let reportedTotal: number | null = null;
  let nextCursor: string | null = null;
  let stoppedByCap = false;
  for (;;) {
    const params: Record<string, string> = {
      type: 'artist',
      limit: String(FOLLOWED_PAGE_LIMIT),
    };
    if (after) params.after = after;
    const res = await client.get<FollowedArtistsResponse>('/me/following', params);
    const followed = res?.artists;
    const page = Array.isArray(followed?.items) ? followed!.items! : [];
    if (typeof followed?.total === 'number') reportedTotal = followed.total;
    items.push(...page);
    nextCursor = followed?.cursors?.after ?? null;
    // A full page with a cursor is the only case where another request can
    // return anything; a short page or a missing cursor ends the walk.
    if (!nextCursor || page.length < FOLLOWED_PAGE_LIMIT) break;
    if (items.length >= cap) {
      stoppedByCap = true;
      break;
    }
    after = nextCursor;
  }
  return {
    items: stoppedByCap ? items.slice(0, cap) : items,
    reportedTotal,
    truncatedByCap: stoppedByCap,
    // A completed walk has nothing left to resume; only a capped walk does.
    nextCursor: stoppedByCap ? nextCursor : null,
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
        // #718: the payload's total is the count Spotify reported. It is null
        // when Spotify sent none — never the walked count, which is the number
        // of rows this call returned, not the size of the follow list.
        const pagination = paginationInfo({ total: walk.reportedTotal, returned: walk.items.length });
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
        // "of N" only when Spotify reported N. The walked count is the number
        // of rows this call returned, and passing it off as the size of the
        // follow list is the claim #718 removed.
        const header =
          walk.truncatedByCap && walk.reportedTotal !== null
            ? `Followed artists (${fetched} fetched of ${walk.reportedTotal}, showing ${fetched}):`
            : `Followed artists (${fetched} fetched, showing ${fetched}):`;
        const lines = [header];
        for (const artist of walk.items) lines.push(renderArtistLine(artist));
        if (walk.truncatedByCap) {
          const remaining =
            walk.reportedTotal !== null && walk.reportedTotal > fetched
              ? walk.reportedTotal - fetched
              : null;
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
      // #638: `GET /me/following/contains` was removed by Spotify's February
      // 2026 changes. `GET /me/library/contains` is the documented read
      // replacement and it is the one half of following that did migrate:
      // the library CHECK types include `artist` even though the library SAVE
      // types deliberately omit it, because PUT /me/library cannot express
      // `spotify:artist:` URIs (see `LIBRARY_SAVE_TYPES` in library.ts). So
      // the read moves to `uris=` and the write has no target at all.
      //
      // A response that is not one boolean per requested id is a bad read,
      // not a row of falses: Spotify's error body for this endpoint has
      // shipped as a truthy object, and spreading it positionally would
      // report every artist as not followed.
      const result = await client.get<boolean[]>('/me/library/contains', {
        uris: ids.map((id) => `spotify:artist:${id}`).join(','),
      });
      if (!Array.isArray(result) || result.length !== ids.length) {
        throw new Error(
          'Could not check following status: GET /me/library/contains returned '
          + `${Array.isArray(result) ? `${result.length} booleans` : 'a non-array body'} for ${ids.length} requested URI(s). `
          + 'Treated as unread rather than as "not followed" — no artist is reported as unfollowed on a response this shape.',
        );
      }
      if (result.some((value) => typeof value !== 'boolean')) {
        throw new Error(
          'Could not check following status: GET /me/library/contains returned a non-boolean element. '
          + 'Treated as unread rather than as "not followed".',
        );
      }

      // #110 finding 11: rows carry a full URI alongside the id so agents
      // can chain into other tools without reconstructing URIs. `follows`
      // is the only truthful boolean here — the library contains read says
      // nothing about library-SAVED state for these rows beyond follow.
      const checks = ids.map((id, i) => ({
        id,
        uri: `spotify:artist:${id}`,
        follows: result[i],
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

  // following_analytics (#297, #733)
  server.tool(
    'following_analytics',
    'Followed-artist rollups from the tag sidecar; popularity/followers unavailable (Spotify no longer returns those fields). Quota: GET /me/following.',
    {
      group_by: z.enum(['genre', 'popularity', 'followers']).default('genre').describe("Rollup dimension; popularity/followers report 'unavailable'"),
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

      // Spotify no longer returns `genres`, `popularity`, or `followers` on
      // followed artist objects, so `popularity`/`followers` groupings would
      // be reporting coerced zeros — and the `genre` group has to source from
      // the user-declared tag sidecar rather than `artist.genres` (#733).
      if (args.group_by !== 'genre') {
        const dimension = args.group_by === 'popularity' ? 'artist popularity' : 'artist follower counts';
        const prose = `Following analytics (${all.length} artists, by ${args.group_by}): unavailable — Spotify no longer returns ${dimension}; group_by:'genre' is the only dimension this tool still derives.`;
        const payload = listStructuredContent([], paginationInfo({ total: 0, returned: 0 }), {
          total_artists: all.length,
          group_by: args.group_by,
          available: false,
          reason: `Spotify no longer returns ${dimension}; declare tags with tag_management for a genre rollup.`,
        });
        return shapeResult(rf, prose, payload);
      }

      // Genre rollup: source from the user-declared sidecar keyed by artist
      // name. A walk that returns no tagged rollups is "the dimension has no
      // source", not "no followed artists" — same unreachable-disclosure rule
      // as #733 names.
      let tagStore: Record<string, string[]> = {};
      try { tagStore = loadGenreTags().tags; } catch { tagStore = {}; }
      const groups = new Map<string, number>();
      let matchedArtists = 0;
      for (const a of all) {
        if (!a || typeof a.name !== 'string') continue;
        const tags = tagsForArtist(tagStore, a.name);
        if (tags.length === 0) continue;
        matchedArtists++;
        for (const g of tags) groups.set(g, (groups.get(g) ?? 0) + 1);
      }
      const sortedGroups = [...groups.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

      if (sortedGroups.length === 0) {
        const prose = `Following analytics (${all.length} artists, by genre): no followed artist has a tag declared yet — Spotify no longer returns artist genres; declare tags with tag_management to populate this rollup.`;
        const payload = listStructuredContent([], paginationInfo({ total: 0, returned: 0 }), {
          total_artists: all.length,
          tagged_artists: 0,
          group_by: args.group_by,
          source: 'user-declared tags',
          available: false,
          reason: 'Spotify no longer returns artist genres; declare tags with tag_management to populate this rollup.',
        });
        return shapeResult(rf, prose, payload);
      }

      const topN = args.top_n ?? 10;
      const view = truncateItems(sortedGroups, Math.min(topN, cap(args)));
      const pagination = paginationInfo({ total: sortedGroups.length, returned: view.items.length });
      const lines = [`Following analytics (user-declared tags; ${all.length} followed artist(s), ${matchedArtists} tagged, by genre):`];
      for (const g of view.items) lines.push(`  ${g.key}: ${g.count}`);
      if (view.footer) lines.push(`(${view.footer})`);
      return shapeResult(rf, lines.join('\n'), listStructuredContent(view.items, pagination, {
        total_artists: all.length,
        tagged_artists: matchedArtists,
        group_by: args.group_by,
        source: 'user-declared tags',
        available: true,
      }));
    },
  );
}
