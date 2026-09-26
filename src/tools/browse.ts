import { z } from 'zod';
import { MARKET_CODE } from './catalog.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SpotifyApiError, type SpotifyClient } from '../client.js';
import { isRemovedEndpointFailure } from '../gating.js';
import type { SpotifyArtistFull, SpotifyPlaylistSimple, SpotifyPaged } from '../types/spotify.js';
import {
  ResponseFormat,
  sharedListFields,
  resolveMaxResults,
  truncateItems,
  paginationInfo,
  listStructuredContent,
} from '../shaping.js';

interface CategoryItem {
  id: string;
  name: string;
  href: string;
  icons: Array<{ url: string; height: number | null; width: number | null }>;
}

function resolveBrowseMarket(
  market: string | undefined,
  country: string | undefined,
): string | undefined {
  if (market !== undefined && country !== undefined && market !== country) {
    throw new Error(
      `Conflicting values: market ("${market}") and deprecated country ("${country}") differ — pass only one.`,
    );
  }
  return market ?? country;
}

/**
 * #1013: Spotify's February 2026 changelog removed GET /browse/categories and
 * GET /browse/categories/{id} outright and lists no replacement, and no
 * surviving endpoint exposes browse categories. The 2026-08-26 gate probe
 * already classifies /browse/categories* as app-registration-gated
 * (src/gating.ts), so a failure here is a dead endpoint — never a missing
 * category, an empty list or a quota problem. Same contract as
 * get_available_markets and get_user_profile: name the removal, and report a
 * response that carried no payload as unreadable rather than as zero.
 *
 * `noun` names what could not be read, so the no-payload case reports the same
 * fact as the wire-failure case: nothing was read, so nothing is returned.
 */
function browseCategoriesUnavailable(path: string, noun: string, err?: unknown): Error {
  // A gated 403 reaches the tool as the #428 graceful-contract Error, so that
  // text is kept verbatim and the removal is appended to it rather than
  // replacing a contract the README and other modules depend on.
  const detail =
    err === undefined
      ? `the response carried no ${noun} payload, so nothing was read. `
      : err instanceof SpotifyApiError
        ? `Spotify answered ${err.status} — ${err.message} `
        : err instanceof Error
          ? `${err.message} `
          : 'Spotify rejected the request. ';
  return new Error(
    `The browse-categories lookup (${path}) could not be answered: ${detail} GET /browse/categories and ` +
      'GET /browse/categories/{id} were removed by Spotify’s February 2026 Web API changes and have ' +
      'no replacement endpoint, so no category list can be read from them; run with credentials from a ' +
      'grandfathered (pre-Nov-2024) app if you need one.',
    err === undefined ? undefined : { cause: err },
  );
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
    'List Spotify browse categories. Removed Feb 2026, no replacement endpoint',
    {
      limit: z.number().int().min(1).max(50).optional().describe('Results per page, 1\u201350. Default: 20'),
      offset: z.number().int().min(0).optional().describe('Offset. Default: 0'),
      market: MARKET_CODE.optional().describe(
        'Canonical ISO 3166-1 alpha-2 market code, e.g. \'US\'; sent as country.',
      ),
      country: MARKET_CODE.optional().describe(
        'Deprecated compatibility spelling for market. Prefer market; conflicting spellings are rejected.',
      ),
      locale: z.string().optional().describe('Locale, e.g. en_US'),
      ...sharedListFields,
    },
    async (args) => {
      const params: Record<string, string> = {};
      if (args.limit !== undefined) params.limit = String(args.limit);
      if (args.offset !== undefined) params.offset = String(args.offset);
      const market = resolveBrowseMarket(args.market, args.country);
      if (market) params.country = market;
      if (args.locale) params.locale = args.locale;
      let data: { categories: SpotifyPaged<CategoryItem> } | null;
      try {
        data = await client.get<{ categories: SpotifyPaged<CategoryItem> }>('/browse/categories', params);
      } catch (err) {
        if (isRemovedEndpointFailure(err)) {
          throw browseCategoriesUnavailable('/browse/categories', 'categories', err);
        }
        throw err;
      }
      if (!data?.categories) {
        throw browseCategoriesUnavailable('/browse/categories', 'categories');
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
    'Get playlists for a browse category. Removed Feb 2026, no replacement endpoint',
    {
      category_id: z.string().describe('Category ID'),
      limit: z.number().int().min(1).max(50).optional().describe('Results per page, 1\u201350. Default: 20'),
      offset: z.number().int().min(0).optional().describe('Offset. Default: 0'),
      market: MARKET_CODE.optional().describe(
        'Canonical ISO 3166-1 alpha-2 market code, e.g. \'US\'; sent as country.',
      ),
      country: MARKET_CODE.optional().describe(
        'Deprecated compatibility spelling for market. Prefer market; conflicting spellings are rejected.',
      ),
      ...sharedListFields,
    },
    async (args) => {
      const params: Record<string, string> = {};
      if (args.limit !== undefined) params.limit = String(args.limit);
      if (args.offset !== undefined) params.offset = String(args.offset);
      const market = resolveBrowseMarket(args.market, args.country);
      if (market) params.country = market;
      const path = `/browse/categories/${encodeURIComponent(args.category_id)}/playlists`;
      let data: { playlists: SpotifyPaged<SpotifyPlaylistSimple> } | null;
      try {
        data = await client.get<{ playlists: SpotifyPaged<SpotifyPlaylistSimple> }>(path, params);
      } catch (err) {
        if (isRemovedEndpointFailure(err)) {
          throw browseCategoriesUnavailable(path, 'playlists', err);
        }
        throw err;
      }
      if (!data?.playlists) {
        throw browseCategoriesUnavailable(path, 'playlists');
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
