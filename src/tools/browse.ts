import { z } from 'zod';
import { MARKET_CODE } from './catalog.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import type { SpotifyArtistFull, SpotifyPlaylistSimple, SpotifyPaged } from '../types/spotify.js';
import {
  ResponseFormat,
  sharedListFields,
  resolveMaxResults,
  truncateItems,
  paginationInfo,
  listStructuredContent,
} from '../shaping.js';

/** Map a market code to the `locale` wire param (e.g. US -> en_US). */
const MARKET_LOCALES: Record<string, string> = {
  US: 'en_US',
  GB: 'en_GB',
  DE: 'de_DE',
  FR: 'fr_FR',
  ES: 'es_ES',
  IT: 'it_IT',
  BR: 'pt_BR',
  NL: 'nl_NL',
  SE: 'sv_SE',
  JP: 'ja_JP',
  KR: 'ko_KR',
};

function marketToLocale(market: string): string {
  const code = market.toUpperCase();
  return MARKET_LOCALES[code] ?? `en_${code}`;
}

type PlaylistPage = SpotifyPaged<SpotifyPlaylistSimple> & { message?: string | null };

interface CategoryItem {
  id: string;
  name: string;
  href: string;
  icons: Array<{ url: string; height: number | null; width: number | null }>;
}

export function registerBrowseTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'get_artist_genres',
    'Get genres for an artist (focused view of GET /artists/{id})',
    {
      artist_id: z.string().describe('Spotify artist ID'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const artist = await client.get<SpotifyArtistFull>(`/artists/${encodeURIComponent(args.artist_id)}`);
      if (!artist) throw new Error(`Artist "${args.artist_id}" not found`);
      const genres: string[] = Array.isArray(artist.genres) ? artist.genres : [];
      if (args.response_format === 'json') {
        const raw: Record<string, unknown> = { id: artist.id, name: artist.name, genres, uri: artist.uri };
        return { content: [{ type: 'text', text: JSON.stringify(raw, null, 2) }], structuredContent: raw };
      }
      const line = genres.length > 0 ? genres.join(', ') : 'none listed';
      return {
        content: [{ type: 'text', text: `Genres for "${artist.name}" (${artist.id}): ${line}` }],
        structuredContent: { id: artist.id, name: artist.name, genres, uri: artist.uri },
      };
    },
  );

  server.tool(
    'get_categories',
    'List Spotify browse categories (GET /browse/categories)',
    {
      limit: z.number().int().min(1).max(50).optional().describe('Results per page, 1\u201350. Default: 20'),
      offset: z.number().int().min(0).optional().describe('Offset. Default: 0'),
      market: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 country code, e.g. \'US\'. Canonical; wins over deprecated country. Sent as the locale wire param (market US -> locale en_US); explicit locale wins over both.'),
      country: z.string().regex(/^[A-Za-z]{2}$/, 'country must be a 2-letter ISO 3166-1 alpha-2 code, e.g. "US"').optional().describe('DEPRECATED alias of market — prefer market. Resolves only when market is omitted; same locale mapping applies.'),
      locale: z.string().optional().describe('Locale, e.g. en_US. Explicit locale wins over market/country.'),
      ...sharedListFields,
    },
    async (args) => {
      const params: Record<string, string> = {};
      if (args.limit !== undefined) params.limit = String(args.limit);
      if (args.offset !== undefined) params.offset = String(args.offset);
      if (args.locale) params.locale = args.locale;
      else {
        const code: string | undefined = args.market ?? args.country;
        if (code) params.locale = marketToLocale(code);
      }
      const data = await client.get<{ categories: SpotifyPaged<CategoryItem> }>('/browse/categories', params);
      if (!data?.categories) {
        return { content: [{ type: 'text', text: 'No categories found.' }] };
      }
      if (args.response_format === 'json') {
        const raw = data as unknown as Record<string, unknown>;
        return { content: [{ type: 'text', text: JSON.stringify(raw, null, 2) }], structuredContent: raw };
      }
      const page = data.categories;
      const cap = resolveMaxResults(args.max_results);
      const trunc = truncateItems(page.items, cap);
      const lines = [`Categories (${page.total} total):`];
      trunc.items.forEach((c) => lines.push(`  \u2022 ${c.name} (id: ${c.id})`));
      if (trunc.footer) lines.push('', `(${trunc.footer})`);
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: listStructuredContent(trunc.items, paginationInfo({ total: page.total, offset: args.offset, limit: args.limit ?? null, returned: trunc.items.length })),
      };
    },
  );

  server.tool(
    'get_category_playlists',
    'Get playlists for a browse category (GET /browse/categories/{id}/playlists)',
    {
      category_id: z.string().describe('Category ID (from get_categories)'),
      limit: z.number().int().min(1).max(50).optional().describe('Results per page, 1\u201350. Default: 20'),
      offset: z.number().int().min(0).optional().describe('Offset. Default: 0'),
      market: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 country code, e.g. \'US\'. Canonical; wins over deprecated country. Sent as the locale wire param (market US -> locale en_US); the endpoint accepts locale/limit/offset only.'),
      country: z.string().regex(/^[A-Za-z]{2}$/, 'country must be a 2-letter ISO 3166-1 alpha-2 code, e.g. "US"').optional().describe('DEPRECATED alias of market — prefer market. Resolves only when market is omitted; same locale mapping applies.'),
      ...sharedListFields,
    },
    async (args) => {
      const params: Record<string, string> = {};
      if (args.limit !== undefined) params.limit = String(args.limit);
      if (args.offset !== undefined) params.offset = String(args.offset);
      const code: string | undefined = args.market ?? args.country;
      if (code) params.locale = marketToLocale(code);
      const data = await client.get<{ playlists: PlaylistPage }>(
        `/browse/categories/${encodeURIComponent(args.category_id)}/playlists`,
        params,
      );
      if (!data?.playlists) {
        return { content: [{ type: 'text', text: `No playlists found for category "${args.category_id}".` }] };
      }
      if (args.response_format === 'json') {
        const raw = data as unknown as Record<string, unknown>;
        return { content: [{ type: 'text', text: JSON.stringify(raw, null, 2) }], structuredContent: raw };
      }
      const page = data.playlists;
      if (page.items.length === 0) {
        return {
          content: [{ type: 'text', text: `No playlists found for category "${args.category_id}".` }],
          structuredContent: listStructuredContent([], paginationInfo({ total: page.total, offset: args.offset, limit: args.limit ?? null, returned: 0 })),
        };
      }
      const cap = resolveMaxResults(args.max_results);
      const trunc = truncateItems(page.items, cap);
      const lines = [`Playlists for category "${args.category_id}" (${page.total} total):`];
      trunc.items.forEach((p) => lines.push(`  \u2022 "${p.name}" by ${(p as SpotifyPlaylistSimple).owner?.display_name ?? (p as SpotifyPlaylistSimple).owner?.id ?? 'unknown'} | URI: ${p.uri}`));
      if (trunc.footer) lines.push('', `(${trunc.footer})`);
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: listStructuredContent(trunc.items, paginationInfo({ total: page.total, offset: args.offset, limit: args.limit ?? null, returned: trunc.items.length })),
      };
    },
  );
}
