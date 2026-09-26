import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SpotifyApiError, type SpotifyClient } from '../client.js';
import type {
  SpotifyAudiobookFull,
  SpotifyChapterFull,
  SpotifyChapterSimple,
  SpotifyPaged,
  SavedAudiobookItem,
  UserProfile,
} from '../types/spotify.js';

import {
  ResponseFormat,
  sharedListFields,
  resolveMaxResults,
  truncateItems,
  paginationInfo,
  listStructuredContent,
  type ResponseFormatValue,
} from '../shaping.js';
import { getConfig, resolveMarket } from '../config.js';

const MARKET_NOTE =
  ' Audiobooks are only available in the US, UK, Canada, Ireland, New Zealand and Australia markets.';

const MARKET_PARAM = z
  .string()
  .regex(/^[A-Za-z]{2}$/, 'market must be a 2-letter ISO 3166-1 alpha-2 country code, e.g. "US"')
  .transform((code) => code.toUpperCase())
  .optional()
  .describe(
    `ISO 3166-1 alpha-2 country code. If given, only content available in that market is returned.${MARKET_NOTE}`,
  );


// Rows the audiobook detail card previews. Spotify embeds a fixed handful of
// chapters; #787 requires the card to say how much of the book that is.
const EMBEDDED_CHAPTER_PREVIEW = 10;

let profileCountry: Promise<string | undefined> | null = null;

// The audiobooks API is market-gated (#29): when the caller supplies no
// market, default to the account's country from /me.
function resolveProfileCountry(client: SpotifyClient): Promise<string | undefined> {
  profileCountry ??= client
    .get<UserProfile>('/me')
    .then((user) => user?.country)
    .catch(() => undefined);
  return profileCountry;
}

/** Test hook: forget the memoized profile-country lookup. */
export function resetProfileCountryCache(): void {
  profileCountry = null;
}

// The market an audiobook lookup runs under: the caller's code, then the
// configured market, then the account country from /me (#29).
async function resolveLookupMarket(
  client: SpotifyClient,
  marketArg: string | undefined,
): Promise<string | undefined> {
  if (marketArg) return marketArg.toUpperCase();
  const configured = getConfig().market;
  if (configured) return configured;
  return resolveProfileCountry(client);
}

// GET with `market` defaulting to the profile country. When the market was
// defaulted (not caller-supplied) and Spotify rejects the lookup, rethrow
// with a hint while preserving the original error as `cause`.
async function getWithMarketFallback<T>(
  client: SpotifyClient,
  path: string,
  marketArg: string | undefined,
  extraParams: Record<string, string> = {},
): Promise<T | null> {
  const market = await resolveLookupMarket(client, marketArg);
  const params: Record<string, string> = { ...extraParams };
  if (market) params.market = market;
  try {
    return await client.get<T>(path, params);
  } catch (err) {
    throw withMarketHint(err, market, marketArg);
  }
}

// A market-gated rejection is a lookup problem, not an argument problem. Only
// a market this server defaulted (not one the caller supplied) is worth a
// hint; the original error rides along as `cause`.
function withMarketHint(err: unknown, market: string | undefined, marketArg: string | undefined): unknown {
  if (
    !marketArg &&
    market &&
    err instanceof SpotifyApiError &&
    (err.status === 404 || err.status === 400)
  ) {
    return new Error(
      `Spotify returned ${err.status} for this lookup using market ${market}. Audiobooks are market-gated — retry with an explicit market code if this looks wrong.`,
      { cause: err },
    );
  }
  return err;
}

// The fetch_all counterpart of getWithMarketFallback: the same market, the
// same hint, but a paging walk instead of one GET (#787).
async function walkWithMarketFallback<T>(
  client: SpotifyClient,
  path: string,
  marketArg: string | undefined,
  opts: { maxItems?: number },
): Promise<{ items: T[]; truncated: boolean }> {
  const market = await resolveLookupMarket(client, marketArg);
  try {
    return await client.getAllPagesWithTruncation<T>(
      path,
      market ? { market } : undefined,
      opts,
    );
  } catch (err) {
    throw withMarketHint(err, market, marketArg);
  }
}
function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// Thin presentation glue over src/shaping.ts primitives (#51/#52/#53), kept
// identical to the catalog module's helpers.

type ShapedToolResult = {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};

/** #51 json mode: raw API payload as parseable JSON text plus structuredContent. */
function jsonResult(raw: Record<string, unknown>): ShapedToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(raw) }], structuredContent: raw };
}

/**
 * Single-object rendering (#51): concise keeps the existing prose verbatim;
 * detailed appends fields the prose drops.
 */
function renderSingle(
  fmt: ResponseFormatValue | undefined,
  raw: Record<string, unknown>,
  concise: string[],
): ShapedToolResult {
  if (fmt === 'json') return jsonResult(raw);
  return { content: [{ type: 'text', text: concise.join('\n') }] };
}

/**
 * List rendering (#52/#53): truncates to max_results, appends the shared
 * footer, and emits structuredContent with pagination info.
 */
function renderList<T>(
  fmt: ResponseFormatValue | undefined,
  pageItems: readonly T[],
  opts: {
    header: string;
    line: (item: T, index: number) => string;
    maxResults?: number;
    total?: number | null;
    offset?: number;
    limit?: number | null;
    continuable?: boolean;
    /** Extra top-level structuredContent fields (e.g. a walk's cap verdict). */
    extra?: Record<string, unknown>;
  },
): ShapedToolResult {
  const cap = resolveMaxResults(opts.maxResults);
  const trunc = truncateItems(pageItems, cap);
  const lines = [opts.header];
  trunc.items.forEach((item, i) => lines.push(opts.line(item, i)));
  if (trunc.footer) lines.push('', `(${trunc.footer})`);
  const continuable = opts.continuable !== false;
  const pagination = paginationInfo({
    total: opts.total ?? trunc.total,
    offset: opts.offset,
    limit: opts.limit ?? null,
    returned: trunc.items.length,
  });
  if (!continuable) {
    pagination.next_offset = null;
  } else if (!trunc.truncated && pagination.next_offset !== null) {
    const left =
      pagination.total !== null ? pagination.total - pagination.next_offset : null;
    lines.push(
      '',
      `More pages available — pass offset=${pagination.next_offset}${
        left !== null ? ` (${left} items left)` : ''
      }`,
    );
  }
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: listStructuredContent(trunc.items, pagination, opts.extra),
  };
}

export function registerAudiobookTools(server: McpServer, client: SpotifyClient): void {
  // get_audiobook
  server.tool(
    'get_audiobook',
    `Get full details for an audiobook by ID.${MARKET_NOTE}`,
    {
      id: z.string().describe('Spotify audiobook ID'),
      market: MARKET_PARAM,
      response_format: ResponseFormat,
    },
    async (args) => {
      const audiobook = await getWithMarketFallback<SpotifyAudiobookFull>(
        client,
        `/audiobooks/${encodeURIComponent(args.id)}`,
        args.market,
      );
      if (!audiobook) throw new Error(`Audiobook "${args.id}" not found`);

      const authors = audiobook.authors.map((a) => a.name).join(', ');
      const narrators = audiobook.narrators.map((n) => n.name).join(', ') || 'none listed';
      const lines = [
        `"${audiobook.name}" by ${authors}, narrated by ${narrators}`,
        `${audiobook.publisher ?? 'Unknown publisher'}${audiobook.edition ? ` (${audiobook.edition})` : ''} | ${audiobook.total_chapters} chapters`,
        audiobook.description,
        `Languages: ${audiobook.languages.join(', ')} | Explicit: ${audiobook.explicit ? 'yes' : 'no'}`,
        `URI: ${audiobook.uri}`,
      ];

      // #787: the embedded chapter array is a fixed ten-row preview, not the
      // book's chapter list. Without a count the card reads as complete, so
      // state how much of the book it stands for.
      if (audiobook.chapters?.items.length) {
        lines.push('', 'Chapters:');
        const shown = audiobook.chapters.items.slice(0, EMBEDDED_CHAPTER_PREVIEW);
        for (const chapter of shown) {
          lines.push(
            `  ${chapter.chapter_number}. "${chapter.name}" (${formatDuration(chapter.duration_ms)}) | URI: ${chapter.uri}`,
          );
        }
        const declared = typeof audiobook.total_chapters === 'number' ? audiobook.total_chapters : 0;
        const chapterTotal = Math.max(declared, audiobook.chapters.items.length);
        if (chapterTotal > shown.length) {
          lines.push(
            `  (${shown.length} of ${chapterTotal} chapters shown — use get_audiobook_chapters with fetch_all for the rest)`,
          );
        }
      }

      return renderSingle(args.response_format, audiobook as unknown as Record<string, unknown>, lines);
    },
  );

  // get_audiobook_chapters
  server.tool(
    'get_audiobook_chapters',
    `List the chapters of an audiobook with pagination.${MARKET_NOTE}`,
    {
      id: z.string().describe('Spotify audiobook ID'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Results per page, 1–50. Default: 20'),
      offset: z.number().int().min(0).optional().describe('Index of the first chapter to return. Default: 0'),
      fetch_all: z
        .boolean()
        .optional()
        .describe(
          'When true, walk every chapter page up to the fetch-all cap (SPOTIFY_MCP_FETCH_ALL_CAP) instead of returning one page. Default: false',
        ),
      market: MARKET_PARAM,
      ...sharedListFields,
    },
    async (args) => {
      const chaptersPath = `/audiobooks/${encodeURIComponent(args.id)}/chapters`;
      const walkCap = getConfig().fetchAllCap;
      // #787: a single page of at most 50 could not read a long book at all.
      // fetch_all walks the pages, and the walk's own verdict (#864) — not the
      // row count — is what says whether it really reached the end.
      let walk: { items: SpotifyChapterSimple[]; truncated: boolean } | null = null;
      let result: SpotifyPaged<SpotifyChapterSimple> | null;
      if (args.fetch_all) {
        walk = await walkWithMarketFallback<SpotifyChapterSimple>(
          client,
          chaptersPath,
          args.market,
          { maxItems: walkCap },
        );
        result = {
          items: walk.items,
          total: walk.items.length,
          limit: walk.items.length,
          offset: 0,
          next: null,
        };
      } else {
        result = await getWithMarketFallback<SpotifyPaged<SpotifyChapterSimple>>(
          client,
          chaptersPath,
          args.market,
          {
            limit: String(args.limit ?? 20),
            offset: String(args.offset ?? 0),
          },
        );
      }
      if (!result) throw new Error(`Audiobook "${args.id}" not found`);

      if (args.response_format === 'json') {
        // A capped walk must not read as a complete payload in json mode
        // either, so the payload carries the same verdict the prose carries.
        return jsonResult(
          walk
            ? {
                ...(result as unknown as Record<string, unknown>),
                fetch_all: true,
                fetch_all_cap: walkCap,
                truncated_by_cap: walk.truncated,
              }
            : (result as unknown as Record<string, unknown>),
        );
      }
      return renderList(args.response_format, result.items, {
        header: walk
          ? `Chapters for audiobook (walked ${result.items.length} — ${
              walk.truncated
                ? `fetch-all cap ${walkCap} REACHED, chapters past it were not read`
                : 'every chapter read, cap not reached'
            }):`
          : `Chapters for audiobook (${result.total} total):`,
        line: (chapter) => {
          const playable = chapter.is_playable ? '' : ' [not playable]';
          return `  ${chapter.chapter_number}. "${chapter.name}" (${formatDuration(chapter.duration_ms)}, ${chapter.release_date})${playable} | URI: ${chapter.uri}`;
        },
        total: result.total,
        offset: walk ? 0 : args.offset,
        limit: walk ? result.items.length : args.limit ?? 20,
        // fetch_all is a documented bypass of max_results: the walk is already
        // bounded by the fetch-all cap, and re-slicing it here would drop
        // exactly what the caller asked for (see src/shaping.ts).
        maxResults: walk ? walkCap : args.max_results,
        continuable: !walk,
        extra: walk
          ? { fetch_all: true, fetch_all_cap: walkCap, truncated_by_cap: walk.truncated }
          : undefined,
      });
    },
  );

  // get_chapter
  server.tool(
    'get_chapter',
    `Get full details for a single audiobook chapter by ID. Resume position requires the user-read-playback-position scope.${MARKET_NOTE}`,
    {
      id: z.string().describe('Spotify chapter ID'),
      market: MARKET_PARAM,
      response_format: ResponseFormat,
    },
    async (args) => {
      const chapter = await getWithMarketFallback<SpotifyChapterFull>(
        client,
        `/chapters/${encodeURIComponent(args.id)}`,
        args.market,
      );
      if (!chapter) throw new Error(`Chapter "${args.id}" not found`);

      const lines = [
        `Chapter ${chapter.chapter_number}: "${chapter.name}"`,
        chapter.description,
        `Duration: ${formatDuration(chapter.duration_ms)} | Released: ${chapter.release_date}`,
        `Explicit: ${chapter.explicit ? 'yes' : 'no'} | Playable in given market: ${chapter.is_playable ? 'yes' : 'no'}`,
      ];

      if (chapter.resume_point) {
        const status = chapter.resume_point.fully_played
          ? 'Fully played'
          : `Resume at ${formatDuration(chapter.resume_point.resume_position_ms)}`;
        lines.push(`Resume point: ${status}`);
      }

      lines.push(`URI: ${chapter.uri}`);

      return renderSingle(args.response_format, chapter as unknown as Record<string, unknown>, lines);
    },
  );

  // get_saved_audiobooks
  server.tool(
    'get_saved_audiobooks',
    "List the audiobooks saved in the current user's Spotify library. Requires the user-library-read scope.",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Results per page, 1–50. Default: 20'),
      offset: z.number().int().min(0).optional().describe('Index of the first audiobook to return. Default: 0'),
      ...sharedListFields,
    },
    async (args) => {
      const params: Record<string, string> = {
        limit: String(args.limit ?? 20),
        offset: String(args.offset ?? 0),
      };

      const result = await client.get<SpotifyPaged<SavedAudiobookItem>>('/me/audiobooks', params);
      if (!result) throw new Error('Could not fetch saved audiobooks');

      if (args.response_format === 'json') {
        return jsonResult(result as unknown as Record<string, unknown>);
      }
      return renderList(args.response_format, result.items, {
        header: `Saved audiobooks (${result.total} total):`,
        line: (item) => {
          const authors = item.audiobook.authors.map((a) => a.name).join(', ');
          return `  • "${item.audiobook.name}" by ${authors} (${item.audiobook.total_chapters} chapters, saved ${item.added_at}) | URI: ${item.audiobook.uri}`;
        },
        total: result.total,
        offset: args.offset,
        limit: args.limit ?? 20,
        maxResults: args.max_results,
      });
    },
  );
}
