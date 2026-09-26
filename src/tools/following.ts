import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import type { FollowedArtistsResponse, SpotifyArtistFull } from '../types/spotify.js';
import { classifySpotifyReference } from '../refs.js';
import {
  CHUNK_CAPS,
  ResponseFormat,
  MaxResults,
  resolveMaxResults,
  truncateItems,
  paginationInfo,
  listStructuredContent,
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

/**
 * `GET /me/library/contains` accepts at most 40 URIs per request, so the
 * per-artist follow check below is chunked rather than sent as one list.
 */
const LIBRARY_CONTAINS_CHUNK = CHUNK_CAPS.library_writes;

function chunkIds(ids: readonly string[], size: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/**
 * Why the artist-follow WRITE tools cannot be migrated (#594).
 *
 * Spotify removed `PUT /me/following` and `DELETE /me/following` in February
 * 2026 and named `PUT`/`DELETE /me/library` as the replacement. That
 * replacement does not close the gap for artists: its supported URI types
 * are track, album, episode, show, audiobook, user and playlist — there is
 * no `spotify:artist:`. So a `PUT /me/library?uris=spotify:artist:<id>` call
 * looks migrated but cannot follow an artist; it is rejected by the API.
 *
 * The read side is unaffected and deliberately still works:
 * `GET /me/following` (the followed-artists list) and
 * `GET /me/library/contains` (which DOES accept `spotify:artist:`) are both
 * still available, which is why `check_following_artists` below migrates
 * cleanly while the two write tools cannot.
 */
const ARTIST_FOLLOW_WRITE_UNAVAILABLE =
  'Spotify removed PUT/DELETE /me/following in February 2026. Its documented replacement, ' +
  'PUT/DELETE /me/library, does not accept spotify:artist: URIs (supported types are track, ' +
  'album, episode, show, audiobook, user and playlist), so following an artist has no working ' +
  'replacement call. Reading follow state still works: GET /me/following lists followed artists ' +
  'and GET /me/library/contains checks an individual artist.';

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
    'Check if the user follows specific artists (GET /me/library/contains; spotify:artist: is supported there, and GET /me/following/contains was removed in Feb 2026). Accepts IDs or spotify:artist: URIs. Rows carry {id, uri, follows}. Max 50.',
    {
      ids: ArtistIds.describe('Artist IDs, spotify:artist: URIs, or artist URLs; CSV accepted'),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const ids = normalizeArtistIds(args.ids);
      // #594: GET /me/following/contains was removed in February 2026.
      // GET /me/library/contains is the documented replacement and it does
      // accept spotify:artist: URIs, so follow state is preserved exactly —
      // only the transport changed. Chunked at the documented 40-URI cap.
      const flags: boolean[] = [];
      for (const part of chunkIds(ids, LIBRARY_CONTAINS_CHUNK)) {
        const uris = part.map((id) => `spotify:artist:${id}`);
        const res = await client.get<boolean[]>('/me/library/contains', {
          uris: uris.join(','),
        });
        // A short or non-boolean reply does not line up with the URIs that
        // were sent. Spreading it would slide every later flag one position
        // left, so an artist nobody asked about would inherit another's
        // answer — a wrong `true`/`false`, not a missing value. Fail closed
        // instead, the way portability.ts's contains helper does.
        if (!Array.isArray(res) || res.length !== uris.length) {
          throw new Error(
            `Could not check following status (/me/library/contains): expected ` +
              `${uris.length} flag(s) for ${uris.length} URI(s), got ` +
              `${Array.isArray(res) ? res.length : 'no array'}`,
          );
        }
        flags.push(...res);
      }

      // #110 finding 11: rows carry a full URI alongside the id so agents
      // can chain into other tools without reconstructing URIs. `follows` is
      // the boolean the library check returned for that artist URI.
      // Safe to index unguarded: the loop above proved flags.length === ids.length.
      const checks = ids.map((id, i) => ({
        id,
        uri: `spotify:artist:${id}`,
        follows: flags[i] === true,
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
    'UNAVAILABLE (#594): no endpoint can follow an artist — PUT /me/following was removed in Feb 2026 and PUT /me/library rejects spotify:artist: URIs. Fails loudly rather than following nothing. Read state with check_following_artists.',
    {
      ids: ArtistIds.describe('Artist IDs, spotify:artist: URIs, or artist URLs; CSV accepted'),
      dry_run: z
        .boolean()
        .optional()
        .describe('Unavailable — this tool always fails (#594).'),
      response_format: ResponseFormat,
    },
    async (args) => {
      // Normalize first so a malformed reference still fails with the precise
      // "Invalid artist reference" error it always has, then refuse outright.
      normalizeArtistIds(args.ids);
      // dry_run is refused too: previewing an action that can never execute
      // would report a clean "would affect" list for an impossible write.
      throw new Error(`follow_artists cannot run: ${ARTIST_FOLLOW_WRITE_UNAVAILABLE}`);
    },
  );

  // unfollow_artists
  server.tool(
    'unfollow_artists',
    'UNAVAILABLE (#594): no endpoint can unfollow an artist — DELETE /me/following was removed in Feb 2026 and DELETE /me/library rejects spotify:artist: URIs. Fails loudly rather than unfollowing nothing. Read state with check_following_artists.',
    {
      ids: ArtistIds.describe('Artist IDs, spotify:artist: URIs, or artist URLs; CSV accepted'),
      dry_run: z
        .boolean()
        .optional()
        .describe('Unavailable — this tool always fails (#594).'),
      response_format: ResponseFormat,
    },
    async (args) => {
      normalizeArtistIds(args.ids);
      throw new Error(`unfollow_artists cannot run: ${ARTIST_FOLLOW_WRITE_UNAVAILABLE}`);
    },
  );

  // following_analytics (#297)
  server.tool(
    'following_analytics',
    'Analytics over followed artists: genre rollup from the followed-artist walk. group_by="genre" only — Spotify removed the popularity and followers Artist fields.',
    {
      group_by: z.enum(['genre', 'popularity', 'followers']).default('genre').describe('Rollup dimension for the report'),
      top_n: z.number().int().min(1).max(50).optional().describe('Top N groups to show'),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const rf = args.response_format;
      // #594: Spotify removed `popularity` and `followers` from the Artist
      // object in February 2026, so those two rollups can no longer be
      // computed. They are refused up front — the old `?? 0` fallback would
      // have bucketed every artist into "0-24"/"<10K" and reported a
      // confidently-named rollup full of zeroes, which is worse than an error.
      if (args.group_by !== 'genre') {
        throw new Error(
          `following_analytics cannot group by "${args.group_by}": Spotify removed the ` +
            `${args.group_by} field from Artist objects in February 2026, so the value is ` +
            'not returned by GET /me/following and the rollup cannot be computed. Use group_by="genre".',
        );
      }
      // The same cursor walk get_followed_artists(fetch_all) uses (#744), so
      // the two follow readers can never disagree about how far a walk goes.
      const all = (await walkFollowedArtists(client)).items;
      if (all.length === 0) return shapeResult(rf, 'No followed artists.', listStructuredContent([], paginationInfo({ total: 0, returned: 0 })));
      // #594: the batch `GET /artists?ids=` endpoint was removed in February
      // 2026, and the per-id replacement was a no-op here: `genre` is the only
      // reachable dimension and the followed-artist walk already returns
      // `genres` on every item (documented response sample: `"genres":
      // ["Prog rock", "Grunge"]`). The old per-artist fan-out cost one request
      // per followed artist — up to fetchAllCap (500) sequential calls against
      // an endpoint that returns fields this rollup no longer reads. Rolling up
      // the walk's own items is both cheaper and exact: `total_artists` is now
      // the number of artists actually measured.
      //
      // `genre` is the only reachable dimension: the guard above refuses
      // popularity/followers, whose backing Artist fields no longer exist.
      const m = new Map<string, number>();
      for (const a of all) for (const g of a.genres ?? []) m.set(g, (m.get(g) ?? 0) + 1);
      const groups: Array<{ key: string; count: number }> = [...m.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count);
      const topN = args.top_n ?? 10;
      const view = truncateItems(groups, Math.min(topN, cap(args)));
      const pagination = paginationInfo({ total: groups.length, returned: view.items.length });
      const lines = [`Following analytics (${all.length} artists, by ${args.group_by}):`];
      for (const g of view.items) lines.push(`  ${g.key}: ${g.count}`);
      if (view.footer) lines.push(`(${view.footer})`);
      return shapeResult(rf, lines.join('\n'), listStructuredContent(view.items, pagination, { total_artists: all.length, group_by: args.group_by }));
    },
  );
}
