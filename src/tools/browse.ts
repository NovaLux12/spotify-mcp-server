import { z } from 'zod';
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

type PlaylistPage = SpotifyPaged<SpotifyPlaylistSimple> & { message?: string | null };

interface CategoryItem {
  id: string;
  name: string;
  href: string;
  icons: Array<{ url: string; height: number | null; width: number | null }>;
}

export function registerBrowseTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'get_related_artists',
    'Get artists related to a given artist (GET /artists/{id}/related-artists)',
    {
      artist_id: z.string().describe('Spotify artist ID'),
      ...sharedListFields,
    },
    async (args) => {
      const data = await client.get<{ artists: SpotifyArtistFull[] }>(
        `/artists/${encodeURIComponent(args.artist_id)}/related-artists`,
      );
      const artists = data?.artists ?? [];
      if (args.response_format === 'json') {
        const raw: Record<string, unknown> = { artists };
        return { content: [{ type: 'text', text: JSON.stringify(raw, null, 2) }], structuredContent: raw };
      }
      if (artists.length === 0) {
        return {
          content: [{ type: 'text', text: `No related artists found for "${args.artist_id}".` }],
          structuredContent: { items: [], pagination: paginationInfo({ total: 0, returned: 0 }) },
        };
      }
      const cap = resolveMaxResults(args.max_results);
      const trunc = truncateItems(artists, cap);
      const lines = [`Related artists for "${args.artist_id}" (${artists.length}):`];
      trunc.items.forEach((a) => {
        const genres = (a as SpotifyArtistFull).genres?.length ? ` \u2014 ${(a as SpotifyArtistFull).genres.slice(0, 3).join(', ')}` : '';
        lines.push(`  \u2022 ${a.name}${genres} | URI: ${a.uri}`);
      });
      if (trunc.footer) lines.push('', `(${trunc.footer})`);
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: listStructuredContent(trunc.items, paginationInfo({ total: artists.length, returned: trunc.items.length })),
      };
    },
  );

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
    'get_featured_playlists',
    'Get featured playlists from Spotify browse (GET /browse/featured-playlists)',
    {
      limit: z.number().int().min(1).max(50).optional().describe('Results per page, 1\u201350. Default: 20'),
      offset: z.number().int().min(0).optional().describe('Offset. Default: 0'),
      country: z.string().optional().describe('ISO 3166-1 alpha-2 country code'),
      locale: z.string().optional().describe('Locale, e.g. en_US'),
      timestamp: z.string().optional().describe('ISO 8601 timestamp for featured selection'),
      ...sharedListFields,
    },
    async (args) => {
      const params: Record<string, string> = {};
      if (args.limit !== undefined) params.limit = String(args.limit);
      if (args.offset !== undefined) params.offset = String(args.offset);
      if (args.country) params.country = args.country;
      if (args.locale) params.locale = args.locale;
      if (args.timestamp) params.timestamp = args.timestamp;
      const data = await client.get<{ message?: string; playlists: PlaylistPage }>('/browse/featured-playlists', params);
      if (!data?.playlists) {
        return { content: [{ type: 'text', text: 'No featured playlists found.' }] };
      }
      if (args.response_format === 'json') {
        const raw = data as unknown as Record<string, unknown>;
        return { content: [{ type: 'text', text: JSON.stringify(raw, null, 2) }], structuredContent: raw };
      }
      const page = data.playlists;
      const cap = resolveMaxResults(args.max_results);
      const trunc = truncateItems(page.items, cap);
      const header = data.message ? `Featured playlists \u2014 ${data.message} (${page.total} total):` : `Featured playlists (${page.total} total):`;
      const lines = [header];
      trunc.items.forEach((p) => lines.push(`  \u2022 "${p.name}" by ${(p as SpotifyPlaylistSimple).owner?.display_name ?? (p as SpotifyPlaylistSimple).owner?.id ?? 'unknown'} | URI: ${p.uri}`));
      if (trunc.footer) lines.push('', `(${trunc.footer})`);
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: listStructuredContent(trunc.items, paginationInfo({ total: page.total, offset: args.offset, limit: args.limit ?? null, returned: trunc.items.length }), { message: data.message ?? null }),
      };
    },
  );

  server.tool(
    'get_categories',
    'List Spotify browse categories (GET /browse/categories)',
    {
      limit: z.number().int().min(1).max(50).optional().describe('Results per page, 1\u201350. Default: 20'),
      offset: z.number().int().min(0).optional().describe('Offset. Default: 0'),
      country: z.string().optional().describe('ISO 3166-1 alpha-2 country code'),
      locale: z.string().optional().describe('Locale, e.g. en_US'),
      ...sharedListFields,
    },
    async (args) => {
      const params: Record<string, string> = {};
      if (args.limit !== undefined) params.limit = String(args.limit);
      if (args.offset !== undefined) params.offset = String(args.offset);
      if (args.country) params.country = args.country;
      if (args.locale) params.locale = args.locale;
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
      country: z.string().optional().describe('ISO 3166-1 alpha-2 country code'),
      ...sharedListFields,
    },
    async (args) => {
      const params: Record<string, string> = {};
      if (args.limit !== undefined) params.limit = String(args.limit);
      if (args.offset !== undefined) params.offset = String(args.offset);
      if (args.country) params.country = args.country;
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
