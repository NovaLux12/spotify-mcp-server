import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
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
  jsonResult,
  renderList,
  renderSingle,
  type ResponseFormatValue,
} from '../shaping.js';
import { getConfig } from '../config.js';
import {
  MARKET_CODE,
  getWithMarketFallback,
  resolveRequestMarket,
  resetProfileCountryCache,
  withMarketHint,
  withMarketSource,
  type MarketResolution,
} from '../markets.js';
// #603: the prose renderers live in a shared module so the audiobook resource
// templates print exactly what these tools print.
import {
  AUDIOBOOK_MARKET_NOTE as MARKET_NOTE,
  audiobookDetailLines,
  chapterDetailLines,
  chapterListLine,
} from '../audiobookview.js';

// Test hook, re-exported so the audiobooks suite keeps its import path.
export { resetProfileCountryCache };

// #595: the same bundled ISO 3166-1 check the catalog tools use, so an
// unassigned code is rejected without a GET /markets round-trip.
const MARKET_PARAM = MARKET_CODE
  .optional()
  .describe(
    `ISO 3166-1 alpha-2 country code. If given, only content available in that market is returned.${MARKET_NOTE}`,
  );


// The market-gated GET and its rejection hint both live in src/markets.ts
// (#782) — they used to be private to this file and separately to catalog.ts.
// The audiobook walk keeps its own function because the paged client is a
// different call, but it shares the hint.
const AUDIOBOOK_GATED = 'Audiobooks';

async function walkWithMarketFallback<T>(
  client: SpotifyClient,
  path: string,
  marketArg: string | undefined,
  opts: { maxItems?: number },
): Promise<{ items: T[]; truncated: boolean; market: MarketResolution }> {
  const market = await resolveRequestMarket(client, marketArg);
  try {
    const walk = await client.getAllPagesWithTruncation<T>(
      path,
      market.market ? { market: market.market } : undefined,
      opts,
    );
    return { ...walk, market };
  } catch (err) {
    throw withMarketHint(err, market.market, marketArg, AUDIOBOOK_GATED);
  }
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
      const { data: audiobook, market } = await getWithMarketFallback<SpotifyAudiobookFull>(
        client,
        `/audiobooks/${encodeURIComponent(args.id)}`,
        args.market,
        {},
        AUDIOBOOK_GATED,
      );
      if (!audiobook) throw new Error(`Audiobook "${args.id}" not found`);

      const lines = audiobookDetailLines(audiobook);

      return withMarketSource(renderSingle(args.response_format, audiobook as unknown as Record<string, unknown>, lines), market);
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
      let walk: { items: SpotifyChapterSimple[]; truncated: boolean; market: MarketResolution } | null = null;
      let result: SpotifyPaged<SpotifyChapterSimple> | null;
      let market: MarketResolution;
      if (args.fetch_all) {
        walk = await walkWithMarketFallback<SpotifyChapterSimple>(
          client,
          chaptersPath,
          args.market,
          { maxItems: walkCap },
        );
        market = walk.market;
        result = {
          items: walk.items,
          total: walk.items.length,
          limit: walk.items.length,
          offset: 0,
          next: null,
        };
      } else {
        ({ data: result, market } = await getWithMarketFallback<SpotifyPaged<SpotifyChapterSimple>>(
          client,
          chaptersPath,
          args.market,
          {
            limit: String(args.limit ?? 20),
            offset: String(args.offset ?? 0),
          },
          AUDIOBOOK_GATED,
        ));
      }
      if (!result) throw new Error(`Audiobook "${args.id}" not found`);

      if (args.response_format === 'json') {
        // A capped walk must not read as a complete payload in json mode
        // either, so the payload carries the same verdict the prose carries.
        return withMarketSource(
          jsonResult(
            walk
              ? {
                  ...(result as unknown as Record<string, unknown>),
                  fetch_all: true,
                  fetch_all_cap: walkCap,
                  truncated_by_cap: walk.truncated,
                }
              : (result as unknown as Record<string, unknown>),
          ),
          market,
        );
      }
      return withMarketSource(
        renderList(args.response_format, result.items, {
          header: walk
            ? `Chapters for audiobook (walked ${result.items.length} — ${
                walk.truncated
                  ? `fetch-all cap ${walkCap} REACHED, chapters past it were not read`
                  : 'every chapter read, cap not reached'
              }):`
            : `Chapters for audiobook (${result.total} total):`,
          line: (chapter) => chapterListLine(chapter),
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
        }),
        market,
      );
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
      const { data: chapter, market } = await getWithMarketFallback<SpotifyChapterFull>(
        client,
        `/chapters/${encodeURIComponent(args.id)}`,
        args.market,
        {},
        AUDIOBOOK_GATED,
      );
      if (!chapter) throw new Error(`Chapter "${args.id}" not found`);

      const lines = chapterDetailLines(chapter);

      return withMarketSource(renderSingle(args.response_format, chapter as unknown as Record<string, unknown>, lines), market);
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
