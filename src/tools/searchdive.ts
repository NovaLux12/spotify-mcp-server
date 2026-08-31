import { z } from 'zod';
import { MARKET_CODE } from './catalog.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { ResponseFormat, MaxResults, resolveMaxResults, truncateItems } from '../shaping.js';

// Feb 2026: Spotify capped /search at limit=10 (400 above it), so agents can't
// fetch more than 10 rows per type in one call. `search_deep` walks the offset
// server-side (0,10,20,...) so one invocation can return up to 50 deduped rows
// per type without the agent issuing repeated calls (issue #112 idea 10).

const TYPES = ['track', 'artist', 'album', 'playlist', 'show', 'episode', 'audiobook'] as const;
type SearchType = (typeof TYPES)[number];

const PAGE_LIMIT = 10;
const HARD_CAP_PER_TYPE = 50;

// /search nests each type's results under its plural key.
function sectionKey(type: SearchType): string {
  return `${type}s`;
}


interface Section {
  items?: unknown[];
  total?: number;
}

interface PageResponse {
  [key: string]: Section | undefined;
}

// Rows without an id can't be deduped safely; callers skip them.
function rowId(row: Record<string, unknown>): string | null {
  return typeof row.id === 'string' ? row.id : null;
}

function compactRow(type: SearchType, row: Record<string, unknown>): string {
  const uri = typeof row.uri === 'string' ? row.uri : '';
  const name = typeof row.name === 'string' ? row.name : '(unnamed)';
  const namesOf = (key: string): string =>
    Array.isArray(row[key])
      ? (row[key] as Array<{ name?: unknown }>)
          .map((a) => (typeof a?.name === 'string' ? a.name : null))
          .filter(Boolean)
          .join(', ')
      : '';
  switch (type) {
    case 'track': {
      let album = '';
      if (typeof row.album === 'object' && row.album !== null && 'name' in row.album) {
        const albumName: unknown = row.album.name;
        if (typeof albumName === 'string') album = albumName;
      }
      return `"${name}" by ${namesOf('artists')}${album ? ` — ${album}` : ''} | URI: ${uri}`;
    }
    case 'artist':
      return `${name} | URI: ${uri}`;
    case 'playlist': {
      let owner = 'unknown';
      if (typeof row.owner === 'object' && row.owner !== null && 'display_name' in row.owner) {
        if (typeof row.owner.display_name === 'string') owner = row.owner.display_name;
        else if ('id' in row.owner && typeof row.owner.id === 'string') owner = row.owner.id;
      }
      return `"${name}" by ${owner} | URI: ${uri}`;
    }
    case 'episode': {
      let show = '';
      if (typeof row.show === 'object' && row.show !== null && 'name' in row.show) {
        const showName: unknown = row.show.name;
        if (typeof showName === 'string') show = showName;
      }
      return `"${name}"${show ? ` — ${show}` : ''} | URI: ${uri}`;
    }
    default:
      // album / show / audiobook: publisher-style attribution when present.
      return `"${name}"${namesOf('artists') || namesOf('authors') ? ` by ${namesOf('artists') || namesOf('authors')}` : ''} | URI: ${uri}`;
  }
}

interface Collected {
  rows: Array<Record<string, unknown>>;
  total: number;
  pagesFetched: number;
}

async function collectType(
  client: SpotifyClient,
  query: string,
  type: SearchType,
  pages: number,
  market: string | undefined,
): Promise<Collected> {
  const seen = new Set<string>();
  const rows: Array<Record<string, unknown>> = [];
  let total = 0;
  let fetched = 0;
  const key = sectionKey(type);

  for (let page = 0; page < pages && rows.length < HARD_CAP_PER_TYPE; page++) {
    const params: Record<string, string> = {
      q: query,
      type,
      limit: String(PAGE_LIMIT),
      offset: String(page * PAGE_LIMIT),
    };
    if (market) params.market = market;

    const res = await client.get<PageResponse>('/search', params);
    if (!res) break;
    fetched++;

    const section = res[key];
    const sectionItems: unknown[] = Array.isArray(section?.items) ? section.items : [];
    total = typeof section?.total === 'number' ? section.total : total;

    for (const item of sectionItems) {
      const row = item as Record<string, unknown> | null;
      if (row === null || typeof row !== 'object') continue; // market-filtered slots arrive as null
      const id = rowId(row);
      // Rows without an id can't be deduped safely; keep them only once.
      if (id === null) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push(row);
      if (rows.length >= HARD_CAP_PER_TYPE) break;
    }

    // Early stop: a short page means the result set is exhausted even when
    // `total` claims more (market filtering, dedupe churn).
    if (sectionItems.length < PAGE_LIMIT) break;
  }

  return { rows, total, pagesFetched: fetched };
}

export function registerSearchDeepTool(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'search_deep',
    'Paged catalog search that walks past the API limit of 10 results per type. Fetches up to 5 pages of 10 results per requested type server-side, dedupes by id, and returns compact rows (name | artists | album | URI).',
    {
      query: z.string().describe('Search query'),
      types: z
        .array(z.enum(TYPES))
        .optional()
        .describe('Content types to search. Default: ["track"]'),
      pages: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe('Pages of 10 results to walk per type, 1–5. Default: 1'),
      market: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 country code, e.g. \'US\''),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const types = args.types ?? ['track'];
      const pages = args.pages ?? 1;

      const collected = new Map<SearchType, Collected>();
      for (const type of types) {
        collected.set(type, await collectType(client, args.query, type, pages, args.market));
      }

      if (args.response_format === 'json') {
        const raw: Record<string, unknown> = {};
        for (const [type, col] of collected) {
          raw[sectionKey(type)] = col.rows;
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(raw) }],
          structuredContent: raw,
        };
      }

      const cap = Math.min(resolveMaxResults(args.max_results), HARD_CAP_PER_TYPE);
      const lines: string[] = [`Deep search results for "${args.query}":\n`];
      const sections: Record<string, unknown> = {};
      let sawSection = false;
      let grandTotal = 0;

      for (const type of types) {
        const col = collected.get(type)!;
        if (col.rows.length === 0) continue;
        sawSection = true;
        grandTotal += col.rows.length;
        const shaped = truncateItems(col.rows, cap);
        lines.push(`${sectionKey(type).toUpperCase()} (${col.rows.length} unique across ${col.pagesFetched} page${col.pagesFetched === 1 ? '' : 's'}${col.total > col.rows.length ? `, ${col.total} total on Spotify` : ''}):`);
        shaped.items.forEach((row) => lines.push(`  • ${compactRow(type, row)}`));
        if (shaped.footer) lines.push(`  (${shaped.footer})`);
        lines.push('');
        sections[sectionKey(type)] = {
          items: shaped.items,
          unique_count: col.rows.length,
          spotify_total: col.total,
          pages_fetched: col.pagesFetched,
        };
      }

      if (!sawSection) {
        return { content: [{ type: 'text', text: 'No results found.' }] };
      }
      lines.push(`${grandTotal} unique result${grandTotal === 1 ? '' : 's'} across ${types.length} type${types.length === 1 ? '' : 's'}.`);
      return {
        content: [{ type: 'text', text: lines.join('\n').trim() }],
        structuredContent: { query: args.query, types, pages, sections },
      };
    },
  );
}
