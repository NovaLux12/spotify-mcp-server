/**
 * stats.fm tools (read-only): listening stats, tops, catalog and social
 * lookups against the public stats.fm API (https://api.stats.fm/api/v1).
 *
 * No Spotify auth required — the StatsfmClient does unauthenticated GETs,
 * so this module is never scope-gated and stays visible under
 * SPOTIFY_MCP_READONLY. Registration key: `statsfm` (own toolset, on by
 * default, additive only).
 *
 * Endpoint paths verified live 2026-09-05; stats.fm envelopes are
 * `{ item }` for singles and `{ items }` for collections.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  StatsfmClient,
  StatsfmApiError,
} from '../lib/statsfm-client.js';
import {
  ResponseFormat,
  MaxResults,
  resolveMaxResults,
  truncateItems,
  paginationInfo,
  listStructuredContent,
} from '../shaping.js';

type J = Record<string, any>;

function invalidResponse(path: string, detail: string): never {
  throw new StatsfmApiError(200, `stats.fm invalid response for ${path}: ${detail}`);
}

function responseObject(body: unknown, path: string): J {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    invalidResponse(path, 'expected a JSON object');
  }
  return body as J;
}

function collectionItems(body: unknown, path: string): J[] {
  const object = responseObject(body, path);
  if (!Array.isArray(object.items)) invalidResponse(path, 'expected an items array');
  return object.items;
}

function nullableItem(body: unknown, path: string): J | null {
  const object = responseObject(body, path);
  if (!Object.prototype.hasOwnProperty.call(object, 'item')) {
    invalidResponse(path, 'expected an item field');
  }
  if (object.item !== null && (typeof object.item !== 'object' || Array.isArray(object.item))) {
    invalidResponse(path, 'expected item to be an object or null');
  }
  return object.item as J | null;
}

function requiredItem(body: unknown, path: string): J {
  const item = nullableItem(body, path);
  if (item === null) invalidResponse(path, 'expected a non-null item');
  return item;
}

function searchItems(body: unknown, path: string): Record<string, J[]> {
  const object = responseObject(body, path);
  const items = object.items;
  if (!items || typeof items !== 'object' || Array.isArray(items)) {
    invalidResponse(path, 'expected an items object');
  }
  for (const [name, entries] of Object.entries(items)) {
    if (!Array.isArray(entries)) invalidResponse(path, `expected ${name} to be an array`);
  }
  return items as Record<string, J[]>;
}

function statsPayload(body: unknown, path: string): J {
  const object = responseObject(body, path);
  if (object.items !== undefined && (!object.items || typeof object.items !== 'object' || Array.isArray(object.items))) {
    invalidResponse(path, 'expected items to be an object when present');
  }
  return (object.items ?? object) as J;
}

const userIdSchema = () =>
  z.string().min(1).describe('stats.fm user id or customId (e.g. "martijn")');
const rangeSchema = z
  .enum(['weeks', 'months', 'lifetime'])
  .optional()
  .describe('Ranking window. Default: lifetime');
const limitSchema = (max = 100, def = 10) =>
  z.number().int().min(1).max(max).optional().describe(`1–${max}. Default: ${def}`);
const offsetSchema = () =>
  z.number().int().min(0).optional().describe('Start position (0-based). Default: 0');
const afterSchema = () =>
  z.number().int().nonnegative().optional().describe('Only streams after this Unix-ms timestamp');
const beforeSchema = () =>
  z.number().int().nonnegative().optional().describe('Only streams before this Unix-ms timestamp');

function fmtPlayed(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '0m';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `${h}h ${mins % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function artistNames(trackOrArtists: J): string {
  const artists: J[] = Array.isArray(trackOrArtists?.artists) ? trackOrArtists.artists : [];
  return artists.map((a) => a?.name ?? '?').join(', ') || '?';
}

function indicatorArrow(ind: unknown): string {
  if (ind === 'UP') return '▲';
  if (ind === 'DOWN') return '▼';
  if (ind === 'NEW') return '✚';
  return '•';
}

/** MCP tool-result envelope (keeps `{ type: 'text' }` literal for tsc). */
type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};

/** Shared concise/detailed/json envelope for `{ items }` collections. */
function shapeCollection(
  title: string,
  rawItems: J[],
  args: { response_format?: string; max_results?: number; limit?: number; offset?: number },
  line: (item: J, i: number) => string,
  detail?: (item: J) => string | null,
): ToolResult {
  if (args.response_format === 'json') {
    return {
      content: [{ type: 'text', text: JSON.stringify({ items: rawItems }) }],
      structuredContent: { items: rawItems },
    };
  }
  if (rawItems.length === 0) {
    return { content: [{ type: 'text', text: `${title}: no results.` }] };
  }
  const shaped = truncateItems(rawItems, resolveMaxResults(args.max_results));
  const detailed = args.response_format === 'detailed';
  const lines = [`${title} (showing ${shaped.items.length} of ${rawItems.length}):`];
  shaped.items.forEach((item, i) => {
    lines.push(`  ${i + 1}. ${line(item, i)}`);
    if (detailed && detail) {
      const extra = detail(item);
      if (extra) lines.push(`      ${extra}`);
    }
  });
  if (shaped.footer) lines.push(`(${shaped.footer})`);
  const pagination = paginationInfo({
    total: rawItems.length,
    offset: args.offset ?? 0,
    limit: args.limit ?? rawItems.length,
    returned: rawItems.length,
  });
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: listStructuredContent(shaped.items, pagination, {
      truncated: shaped.truncated,
      remaining: shaped.remaining,
    }),
  };
}

function topLine(kind: 'track' | 'artist' | 'album' | 'genre'): (item: J) => string {
  return (entry: J) => {
    const pos = typeof entry.position === 'number' ? `#${entry.position} ` : '';
    const streams = typeof entry.streams === 'number' ? ` — ${entry.streams} streams (${fmtPlayed(entry.playedMs)})` : '';
    if (kind === 'track') {
      const t: J = entry.track ?? {};
      return `${pos}"${t.name ?? '?'}" by ${artistNames(t)}${streams}`;
    }
    if (kind === 'artist') return `${pos}${entry.artist?.name ?? '?'}${streams}`;
    if (kind === 'album') {
      const a: J = entry.album ?? {};
      return `${pos}"${a.name ?? '?'}" by ${artistNames(a)}${streams}`;
    }
    return `${pos}${entry.genre ?? entry.name ?? '?'}${streams}`;
  };
}

function topDetail(kind: 'track' | 'artist' | 'album' | 'genre'): (item: J) => string | null {
  return (entry: J) => {
    const obj: J = entry.track ?? entry.artist ?? entry.album ?? {};
    if (kind === 'track') {
      const albumName = Array.isArray(obj.albums) && obj.albums[0]?.name ? `Album: ${obj.albums[0].name}` : null;
      const ids = obj.externalIds?.spotify?.[0] ? `Spotify: ${obj.externalIds.spotify[0]}` : null;
      return [albumName, ids].filter(Boolean).join(' | ') || null;
    }
    if (kind === 'artist') {
      const bits: string[] = [];
      if (Array.isArray(obj.genres) && obj.genres.length > 0) bits.push(`Genres: ${obj.genres.join(', ')}`);
      if (typeof obj.followers === 'number') bits.push(`Followers: ${obj.followers}`);
      return bits.join(' | ') || null;
    }
    if (kind === 'album') {
      const bits: string[] = [];
      if (typeof obj.totalTracks === 'number') bits.push(`${obj.totalTracks} tracks`);
      if (obj.label) bits.push(String(obj.label));
      return bits.join(' | ') || null;
    }
    const preview = Array.isArray(entry.previewArtists)
      ? entry.previewArtists.slice(0, 3).map((p: J) => p?.artist?.name ?? '?').join(', ')
      : null;
    return preview ? `Top artists: ${preview}` : null;
  };
}

function streamLine(s: J): string {
  const when = s.endTime ? new Date(s.endTime).toLocaleString() : 'unknown time';
  return `"${s.trackName ?? '?'}" (${fmtPlayed(s.playedMs)}) — ${when}`;
}

/** Aggregate a `{ items: streams }` page into count/playedMs/first/last. */
function summarizeStreams(streams: J[], label: string) {
  const count = streams.length;
  const totalMs = streams.reduce((sum, s) => sum + (typeof s.playedMs === 'number' ? s.playedMs : 0), 0);
  const ends = streams.map((s) => s.endTime).filter((t) => typeof t === 'string') as string[];
  const first = ends.length > 0 ? ends.reduce((a, b) => (a < b ? a : b)) : null;
  const last = ends.length > 0 ? ends.reduce((a, b) => (a > b ? a : b)) : null;
  return { label, count, totalMs, avgMs: count > 0 ? Math.round(totalMs / count) : 0, first, last };
}

function formatSummary(sum: ReturnType<typeof summarizeStreams>): string {
  const span = sum.first && sum.last ? ` | span: ${sum.first} → ${sum.last}` : '';
  return `${sum.label}: ${sum.count} streams, ${fmtPlayed(sum.totalMs)} total (avg ${fmtPlayed(sum.avgMs)})${span}`;
}

/** Short, non-guessing reason a per-friend stream lookup could not be read. */
function unreadableLookupReason(err: unknown): string {
  if (err instanceof StatsfmApiError) {
    if (err.status === 429) return `rate limited (429, retry after ${err.retryAfterSec ?? 'an unspecified number of'}s)`;
    if (err.status === 403) return 'private or gated profile (403)';
    if (err.status === 404) return 'profile not found (404)';
    if (err.status === 0) return 'stats.fm unreachable';
    return `stats.fm HTTP ${err.status}`;
  }
  return 'lookup failed';
}

/** A friend whose stream total was actually read (0 is a real answer). */
type FriendCount = { friend: J; streams: number };
/** A friend whose stream total is unknown — never coerced to 0 (#803). */
type FriendUnreadable = { friend: J; unreadableReason: string };
type FriendLookup = FriendCount | FriendUnreadable;

function isFriendCount(lookup: FriendLookup): lookup is FriendCount {
  return 'streams' in lookup;
}

export function registerStatsfmTools(server: McpServer, client: StatsfmClient = new StatsfmClient()): void {
  // 1. statsfm_resolve_user — GET /users/{id}, search fallback on 404.
  server.tool(
    'statsfm_resolve_user',
    'Resolve a stats.fm user id or customId to their profile (falls back to user search)',
    { user_id: userIdSchema(), response_format: ResponseFormat },
    async (args) => {
      let body: J | null = null;
      try {
        body = await client.get<J>(`/users/${encodeURIComponent(args.user_id)}`);
      } catch (err) {
        if (!(err instanceof StatsfmApiError) || err.status !== 404) throw err;
        const found = await client.get<J>('/search', { query: args.user_id, type: 'user', limit: 5 });
        const foundItems = searchItems(found, '/search');
        const users = foundItems.users;
        if (!Array.isArray(users)) invalidResponse('/search', 'expected users to be an array');
        if (users.length === 0) throw err;
        body = { item: users[0], via_search: true };
      }
      const user = requiredItem(body, `/users/${encodeURIComponent(args.user_id)}`);
      if (!user) throw new StatsfmApiError(404, 'stats.fm user not found', undefined, 'RESOURCE_NOT_FOUND');
      if (args.response_format === 'json') {
        return { content: [{ type: 'text', text: JSON.stringify(user) }], structuredContent: { ...user } };
      }
      const lines = [
        `${user.displayName ?? user.customId ?? args.user_id} (@${user.customId ?? '?'})`,
        `  id: ${user.id ?? '?'} | Plus: ${user.isPlus ? 'yes' : 'no'} | order: ${user.orderBy ?? '?'}`,
      ];
      if (user.timezone) lines.push(`  timezone: ${user.timezone}`);
      return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { ...user } };
    },
  );

  // 2–5. user tops (tracks / artists / albums / genres).
  const topConfigs = [
    { name: 'statsfm_top_tracks', desc: "A stats.fm user's most-streamed tracks", kind: 'track' as const, path: 'tracks' },
    { name: 'statsfm_top_artists', desc: "A stats.fm user's most-streamed artists", kind: 'artist' as const, path: 'artists' },
    { name: 'statsfm_top_albums', desc: "A stats.fm user's most-streamed albums", kind: 'album' as const, path: 'albums' },
    { name: 'statsfm_top_genres', desc: "A stats.fm user's most-streamed genres", kind: 'genre' as const, path: 'genres' },
  ];
  for (const cfg of topConfigs) {
    server.tool(
      cfg.name,
      cfg.desc,
      {
        user_id: userIdSchema(),
        range: rangeSchema,
        limit: limitSchema(),
        offset: offsetSchema(),
        response_format: ResponseFormat,
        max_results: MaxResults,
      },
      async (args) => {
        const body = await client.get<J>(`/users/${encodeURIComponent(args.user_id)}/top/${cfg.path}`, {
          range: args.range ?? 'lifetime',
          limit: String(args.limit ?? 10),
          offset: String(args.offset ?? 0),
        });
        const items = collectionItems(body, `/users/${encodeURIComponent(args.user_id)}/top/${cfg.path}`);
        return shapeCollection(`Top ${cfg.path}`, items, args, topLine(cfg.kind), topDetail(cfg.kind));
      },
    );
  }

  // 6. statsfm_recent_streams — GET /users/{id}/streams/recent.
  server.tool(
    'statsfm_recent_streams',
    "A stats.fm user's recently played streams",
    {
      user_id: userIdSchema(),
      limit: limitSchema(100, 20),
      after: afterSchema(),
      before: beforeSchema(),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const params: Record<string, string> = { limit: String(args.limit ?? 20) };
      if (args.after !== undefined) params.after = String(args.after);
      if (args.before !== undefined) params.before = String(args.before);
      const body = await client.get<J>(`/users/${encodeURIComponent(args.user_id)}/streams/recent`, params);
      const items = collectionItems(body, `/users/${encodeURIComponent(args.user_id)}/streams/recent`);
      return shapeCollection('Recent streams', items, args, streamLine, (s) =>
        s.trackId !== undefined ? `trackId: ${s.trackId} | artists: ${(s.artistIds ?? []).join(', ')}` : null,
      );
    },
  );

  // 7. statsfm_now_playing — GET /users/{id}/streams/current.
  server.tool(
    'statsfm_now_playing',
    "What a stats.fm user is playing right now (null when idle)",
    { user_id: userIdSchema(), response_format: ResponseFormat },
    async (args) => {
      const body = await client.get<J>(`/users/${encodeURIComponent(args.user_id)}/streams/current`);
      const current = nullableItem(body, `/users/${encodeURIComponent(args.user_id)}/streams/current`);
      if (args.response_format === 'json') {
        return {
          content: [{ type: 'text', text: JSON.stringify(current) }],
          structuredContent: { item: current },
        };
      }
      if (!current) {
        return { content: [{ type: 'text', text: 'Nothing playing right now.' }] };
      }
      const when = current.endTime ? new Date(current.endTime).toLocaleString() : 'now';
      return {
        content: [
          {
            type: 'text',
            text: `Now playing: "${current.trackName ?? current.track?.name ?? '?'}" (${fmtPlayed(current.playedMs)}) — ${when}`,
          },
        ],
        structuredContent: { ...current },
      };
    },
  );

  // 8–10. per-entity stream aggregates (track / artist / album).
  const entityStats = [
    { name: 'statsfm_track_stats', desc: 'Stream totals for one track within a user library', filter: 'track', idField: 'track_id' },
    { name: 'statsfm_artist_stats', desc: 'Stream totals for one artist within a user library', filter: 'artist', idField: 'artist_id' },
    { name: 'statsfm_album_stats', desc: 'Stream totals for one album within a user library', filter: 'album', idField: 'album_id' },
  ];
  for (const cfg of entityStats) {
    server.tool(
      cfg.name,
      cfg.desc,
      {
        user_id: userIdSchema(),
        [cfg.idField]: z.union([z.string(), z.number()]).describe(`stats.fm ${cfg.filter} id`),
        limit: limitSchema(100, 50),
        response_format: ResponseFormat,
      },
      async (args) => {
        const entityId = String((args as J)[cfg.idField]);
        const body = await client.get<J>(`/users/${encodeURIComponent((args as J).user_id as string)}/streams`, {
          [cfg.filter]: entityId,
          limit: String((args as J).limit ?? 50),
        });
        const streams = collectionItems(body, `/users/${encodeURIComponent((args as J).user_id as string)}/streams`);
        const sum = summarizeStreams(streams, `${cfg.filter} ${entityId}`);
        if ((args as J).response_format === 'json') {
          return {
            content: [{ type: 'text', text: JSON.stringify({ ...sum, streams }) }],
            structuredContent: { ...sum, streams },
          };
        }
        if (streams.length === 0) {
          return { content: [{ type: 'text', text: `${formatSummary(sum)} — no streams found.` }] };
        }
        return {
          content: [{ type: 'text', text: formatSummary(sum) }],
          structuredContent: { ...sum, streams: streams.slice(0, 10) },
        };
      },
    );
  }

  // 11. statsfm_search — GET /search.
  server.tool(
    'statsfm_search',
    'Search the stats.fm catalog (tracks, artists, albums, playlists, users)',
    {
      query: z.string().min(1).describe('Search text'),
      type: z
        .string()
        .optional()
        .describe('Comma-separated subset of track,artist,album,playlist,user. Default: track,artist,album'),
      limit: limitSchema(50, 10),
      response_format: ResponseFormat,
    },
    async (args) => {
      const body = await client.get<J>('/search', {
        query: args.query,
        type: args.type ?? 'track,artist,album',
        limit: String(args.limit ?? 10),
      });
      const groups = searchItems(body, '/search');
      if (args.response_format === 'json') {
        return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: { ...(body as J) } };
      }
      const lines = [`Search results for "${args.query}":`];
      let total = 0;
      for (const [group, entries] of Object.entries(groups)) {
        if (!Array.isArray(entries) || entries.length === 0) continue;
        total += entries.length;
        lines.push(`  ${group}:`);
        for (const e of entries.slice(0, args.limit ?? 10)) {
          lines.push(`    • ${e.name ?? e.displayName ?? '?'}${e.id !== undefined ? ` (id: ${e.id})` : ''}`);
        }
      }
      if (total === 0) lines.push('  (no results)');
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: { ...(body as J) },
      };
    },
  );

  // 12. statsfm_recaps — yearly streams/stats window.
  server.tool(
    'statsfm_recaps',
    'Year-in-review recap: stream totals and catalog breadth for one calendar year',
    {
      user_id: userIdSchema(),
      year: z.number().int().min(2010).max(2100).optional().describe('Calendar year. Default: current year'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const year = args.year ?? new Date().getUTCFullYear();
      const body = await client.get<J>(`/users/${encodeURIComponent(args.user_id)}/streams/stats`, {
        after: String(Date.UTC(year, 0, 1)),
        before: String(Date.UTC(year + 1, 0, 1)),
      });
      const stats = statsPayload(body, `/users/${encodeURIComponent(args.user_id)}/streams/stats`);
      if (args.response_format === 'json') {
        return { content: [{ type: 'text', text: JSON.stringify({ year, ...((stats as J) ?? {}) }) }], structuredContent: { year, ...((stats as J) ?? {}) } };
      }
      const s = (stats ?? {}) as J;
      const card = s.cardinality ?? {};
      const lines = [
        `${year} recap: ${s.count ?? 0} streams, ${fmtPlayed(s.durationMs ?? s.playedMs?.sum)} listened`,
        `  ${card.tracks ?? '?'} tracks · ${card.artists ?? '?'} artists · ${card.albums ?? '?'} albums`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { year, ...s } };
    },
  );

  // 13. statsfm_streams_stats — GET /users/{id}/streams/stats.
  server.tool(
    'statsfm_streams_stats',
    'Aggregate listening stats (totals, percentiles, catalog cardinality) for a user, optionally windowed',
    {
      user_id: userIdSchema(),
      after: afterSchema(),
      before: beforeSchema(),
      response_format: ResponseFormat,
    },
    async (args) => {
      const params: Record<string, string> = {};
      if (args.after !== undefined) params.after = String(args.after);
      if (args.before !== undefined) params.before = String(args.before);
      const body = await client.get<J>(`/users/${encodeURIComponent(args.user_id)}/streams/stats`, params);
      const stats = statsPayload(body, `/users/${encodeURIComponent(args.user_id)}/streams/stats`);
      if (args.response_format === 'json') {
        return { content: [{ type: 'text', text: JSON.stringify(stats) }], structuredContent: { ...stats } };
      }
      const card = stats.cardinality ?? {};
      const text = [
        `Listening stats: ${stats.count ?? 0} streams, ${fmtPlayed(stats.durationMs)} listened`,
        `  ${card.tracks ?? '?'} tracks · ${card.artists ?? '?'} artists · ${card.albums ?? '?'} albums`,
      ].join('\n');
      return { content: [{ type: 'text', text }], structuredContent: { ...stats } };
    },
  );

  // 14–16. scoped tops (tracks from artist / albums from artist / tracks from album).
  const scopedTops = [
    { name: 'statsfm_top_tracks_from_artist', desc: "A user's top tracks from one artist", seg: (id: string) => `artists/${encodeURIComponent(id)}/tracks`, label: 'Top tracks from artist' },
    { name: 'statsfm_top_albums_from_artist', desc: "A user's top albums from one artist", seg: (id: string) => `artists/${encodeURIComponent(id)}/albums`, label: 'Top albums from artist' },
    { name: 'statsfm_top_tracks_from_album', desc: "A user's top tracks from one album", seg: (id: string) => `albums/${encodeURIComponent(id)}/tracks`, label: 'Top tracks from album' },
  ];
  for (const cfg of scopedTops) {
    const isAlbum = cfg.name.endsWith('_from_album');
    server.tool(
      cfg.name,
      cfg.desc,
      {
        user_id: userIdSchema(),
        [isAlbum ? 'album_id' : 'artist_id']: z.union([z.string(), z.number()]).describe(`stats.fm ${isAlbum ? 'album' : 'artist'} id`),
        range: rangeSchema,
        limit: limitSchema(),
        offset: offsetSchema(),
        response_format: ResponseFormat,
        max_results: MaxResults,
      },
      async (args) => {
        const entityId = String((args as J)[isAlbum ? 'album_id' : 'artist_id']);
        const body = await client.get<J>(
          `/users/${encodeURIComponent((args as J).user_id as string)}/top/${cfg.seg(entityId)}`,
          {
            range: (args as J).range ?? 'lifetime',
            limit: String((args as J).limit ?? 10),
            offset: String((args as J).offset ?? 0),
          },
        );
        const items = collectionItems(body, `/users/${encodeURIComponent((args as J).user_id as string)}/top/${cfg.seg(entityId)}`);
        const kind = cfg.name.includes('_albums_') ? 'album' : 'track';
        return shapeCollection(cfg.label, items, args as J, topLine(kind), topDetail(kind));
      },
    );
  }

  // 17–19. catalog singles (track / artist / album).
  const catalog = [
    { name: 'statsfm_catalog_track', desc: 'Look up a track in the stats.fm catalog by id', seg: 'tracks', idField: 'track_id', label: 'track' },
    { name: 'statsfm_catalog_artist', desc: 'Look up an artist in the stats.fm catalog by id', seg: 'artists', idField: 'artist_id', label: 'artist' },
    { name: 'statsfm_catalog_album', desc: 'Look up an album in the stats.fm catalog by id', seg: 'albums', idField: 'album_id', label: 'album' },
  ];
  for (const cfg of catalog) {
    server.tool(
      cfg.name,
      cfg.desc,
      {
        [cfg.idField]: z.union([z.string(), z.number()]).describe(`stats.fm ${cfg.label} id`),
        response_format: ResponseFormat,
      },
      async (args) => {
        const id = String((args as J)[cfg.idField]);
        const body = await client.get<J>(`/${cfg.seg}/${encodeURIComponent(id)}`);
        const item = nullableItem(body, `/${cfg.seg}/${encodeURIComponent(id)}`);
        if (!item) throw new StatsfmApiError(404, `stats.fm ${cfg.label} not found`, undefined, 'RESOURCE_NOT_FOUND');
        if ((args as J).response_format === 'json') {
          return { content: [{ type: 'text', text: JSON.stringify(item) }], structuredContent: { ...item } };
        }
        const lines = [`${item.name ?? id}`];
        if (cfg.label === 'track') lines.push(`  by ${artistNames(item)} | ${fmtPlayed(item.durationMs)}`);
        if (Array.isArray(item.genres) && item.genres.length > 0) lines.push(`  genres: ${item.genres.join(', ')}`);
        if (typeof item.followers === 'number') lines.push(`  followers: ${item.followers}`);
        if (typeof item.totalTracks === 'number') lines.push(`  tracks: ${item.totalTracks}`);
        return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { ...item } };
      },
    );
  }

  // 20. statsfm_genre_artists — GET /genres/{genre}/artists.
  server.tool(
    'statsfm_genre_artists',
    'Artists tagged with a genre in the stats.fm catalog',
    {
      genre: z.string().min(1).describe('Genre tag, e.g. "rock" or "hip-hop/rap"'),
      limit: limitSchema(),
      offset: offsetSchema(),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const body = await client.get<J>(`/genres/${encodeURIComponent(args.genre)}/artists`, {
        limit: String(args.limit ?? 10),
        offset: String(args.offset ?? 0),
      });
      const items = collectionItems(body, `/genres/${encodeURIComponent(args.genre)}/artists`);
      return shapeCollection(`Artists in "${args.genre}"`, items, args, (a) => {
        const genres = Array.isArray(a.genres) && a.genres.length > 0 ? ` [${a.genres.join(', ')}]` : '';
        return `${a.name ?? '?'}${genres}`;
      });
    },
  );

  // 21–23. lifetime charts (track / artist / album) with movement indicators.
  const charts = [
    { name: 'statsfm_charts_tracks', desc: "All-time chart of a user's top tracks with movement indicators", kind: 'track' as const, path: 'tracks' },
    { name: 'statsfm_charts_artists', desc: "All-time chart of a user's top artists with movement indicators", kind: 'artist' as const, path: 'artists' },
    { name: 'statsfm_charts_albums', desc: "All-time chart of a user's top albums with movement indicators", kind: 'album' as const, path: 'albums' },
  ];
  for (const cfg of charts) {
    server.tool(
      cfg.name,
      cfg.desc,
      {
        user_id: userIdSchema(),
        limit: limitSchema(100, 20),
        offset: offsetSchema(),
        response_format: ResponseFormat,
        max_results: MaxResults,
      },
      async (args) => {
        const body = await client.get<J>(`/users/${encodeURIComponent(args.user_id)}/top/${cfg.path}`, {
          range: 'lifetime',
          limit: String(args.limit ?? 20),
          offset: String(args.offset ?? 0),
        });
        const items = collectionItems(body, `/users/${encodeURIComponent(args.user_id)}/top/${cfg.path}`);
        const base = topLine(cfg.kind);
        return shapeCollection(`All-time ${cfg.path} chart`, items, args, (entry) => `${indicatorArrow(entry.indicator)} ${base(entry)}`);
      },
    );
  }

  // 24. statsfm_charts_users — rank a user's friends by stream count.
  server.tool(
    'statsfm_charts_users',
    "Rank a stats.fm user's friends by total stream count (people chart)",
    {
      user_id: userIdSchema(),
      limit: limitSchema(25, 10),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const friendsPath = `/users/${encodeURIComponent(args.user_id)}/friends`;
      const friendsBody = await client.get<J>(friendsPath, {
        limit: String(args.limit ?? 10),
      });
      const friends = collectionItems(friendsBody, friendsPath);
      // Every friend is a separate lookup, and a private, registration-gated
      // or throttled profile fails only that one request. A failed lookup is
      // "unreadable", never "0 streams" (#803): charting it as zero tells the
      // reader their friend streamed nothing, which is a fabricated answer.
      // Each profile is read exactly once — a throttled friend is reported,
      // never retried into the rate limit.
      const lookups = await Promise.all(
        friends.map(async (f): Promise<FriendCount | FriendUnreadable> => {
          const path = `/users/${encodeURIComponent(String(f.id ?? f.customId))}/streams/stats`;
          try {
            const stats = await client.get<J>(path);
            return { friend: f, streams: Number(statsPayload(stats, path).count ?? 0) || 0 };
          } catch (err) {
            // A malformed payload breaks our response contract rather than
            // hiding a profile, so it still fails loudly instead of being
            // demoted to an unreadable row.
            if (err instanceof StatsfmApiError && err.status === 200) throw err;
            return { friend: f, unreadableReason: unreadableLookupReason(err) };
          }
        }),
      );
      const ranked = lookups.filter(isFriendCount).sort((a, b) => b.streams - a.streams);
      const unreadable = lookups.filter((l): l is FriendUnreadable => !isFriendCount(l));
      const rows = ranked.map((r) => ({
        ...r.friend,
        streams: r.streams,
        display: `${r.friend.displayName ?? r.friend.customId ?? '?'} — ${r.streams} streams`,
      }));
      const unreadableRows = unreadable.map((r) => ({
        ...r.friend,
        streams: null,
        readable: false,
        reason: r.unreadableReason,
        display: `${r.friend.displayName ?? r.friend.customId ?? '?'} — unreadable (${r.unreadableReason})`,
      }));
      if (args.response_format === 'json') {
        const payload = { items: rows, unreadable: unreadableRows, unreadable_count: unreadableRows.length };
        return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
      }
      const shaped = truncateItems(rows, resolveMaxResults(args.max_results));
      const partial = unreadableRows.length > 0
        ? `, ${unreadableRows.length} of ${friends.length} unreadable — partial result`
        : '';
      const lines = [`People chart (friends ranked by streams, showing ${shaped.items.length} of ${rows.length}${partial}):`];
<<<<<<< HEAD
      if (rows.length === 0) lines.push('  (no friend profile could be read)');
=======
      // Only claim a read failure when one happened: an empty friend list is
      // a complete answer, not a set of unreadable profiles (#803).
      if (unreadableRows.length > 0) lines.push('  (no friend profile could be read)');
>>>>>>> fix/v4-statsfm
      shaped.items.forEach((r, i) => lines.push(`  ${i + 1}. ${r.display}`));
      if (shaped.footer) lines.push(`(${shaped.footer})`);
      if (unreadableRows.length > 0) {
        lines.push(`Unreadable — stream count unknown, not zero (${unreadableRows.length}, excluded from the ranking):`);
        for (const r of unreadableRows) lines.push(`  - ${r.display}`);
      }
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: listStructuredContent(
          shaped.items,
          paginationInfo({ total: rows.length, offset: 0, limit: args.limit ?? 10, returned: rows.length }),
          { truncated: shaped.truncated, remaining: shaped.remaining, unreadable: unreadableRows, unreadable_count: unreadableRows.length },
        ),
      };
    },
  );

  // 25–27. date-windowed per-entity stats (track / artist / album).
  const dateStats = [
    { name: 'statsfm_track_date_stats', desc: 'Stream totals for one track within a date window', filter: 'track', idField: 'track_id' },
    { name: 'statsfm_artist_date_stats', desc: 'Stream totals for one artist within a date window', filter: 'artist', idField: 'artist_id' },
    { name: 'statsfm_album_date_stats', desc: 'Stream totals for one album within a date window', filter: 'album', idField: 'album_id' },
  ];
  for (const cfg of dateStats) {
    server.tool(
      cfg.name,
      cfg.desc,
      {
        user_id: userIdSchema(),
        [cfg.idField]: z.union([z.string(), z.number()]).describe(`stats.fm ${cfg.filter} id`),
        after: afterSchema(),
        before: beforeSchema(),
        limit: limitSchema(500, 100),
        response_format: ResponseFormat,
      },
      async (args) => {
        const entityId = String((args as J)[cfg.idField]);
        const params: Record<string, string> = {
          [cfg.filter]: entityId,
          limit: String((args as J).limit ?? 100),
        };
        if ((args as J).after !== undefined) params.after = String((args as J).after);
        if ((args as J).before !== undefined) params.before = String((args as J).before);
        const body = await client.get<J>(`/users/${encodeURIComponent((args as J).user_id as string)}/streams`, params);
        const streams = collectionItems(body, `/users/${encodeURIComponent((args as J).user_id as string)}/streams`);
        const window = (args as J).after !== undefined || (args as J).before !== undefined
          ? ` [${(args as J).after ?? '…'} → ${(args as J).before ?? '…'}]`
          : '';
        const sum = summarizeStreams(streams, `${cfg.filter} ${entityId}${window}`);
        if ((args as J).response_format === 'json') {
          return {
            content: [{ type: 'text', text: JSON.stringify({ ...sum, streams }) }],
            structuredContent: { ...sum, streams },
          };
        }
        return {
          content: [{ type: 'text', text: formatSummary(sum) }],
          structuredContent: { ...sum, streams: streams.slice(0, 10) },
        };
      },
    );
  }

  // 28. statsfm_friends — GET /users/{id}/friends.
  server.tool(
    'statsfm_friends',
    "List a stats.fm user's friends",
    {
      user_id: userIdSchema(),
      limit: limitSchema(),
      offset: offsetSchema(),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const body = await client.get<J>(`/users/${encodeURIComponent(args.user_id)}/friends`, {
        limit: String(args.limit ?? 10),
        offset: String(args.offset ?? 0),
      });
      const items = collectionItems(body, `/users/${encodeURIComponent(args.user_id)}/friends`);
      return shapeCollection('Friends', items, args, (f) => `${f.displayName ?? '?'} (@${f.customId ?? '?'})${f.isPlus ? ' ★' : ''}`);
    },
  );

  // 29. statsfm_friend_count — GET /users/{id}/friends/count.
  server.tool(
    'statsfm_friend_count',
    "How many friends a stats.fm user has",
    { user_id: userIdSchema(), response_format: ResponseFormat },
    async (args) => {
      const body = await client.get<J>(`/users/${encodeURIComponent(args.user_id)}/friends/count`);
      const countBody = responseObject(body, `/users/${encodeURIComponent(args.user_id)}/friends/count`);
      if (!Object.prototype.hasOwnProperty.call(countBody, 'item') || typeof countBody.item !== 'number' || !Number.isFinite(countBody.item)) {
        invalidResponse(`/users/${encodeURIComponent(args.user_id)}/friends/count`, 'expected item to be a finite number');
      }
      const count = countBody.item as number;
      if (args.response_format === 'json') {
        return { content: [{ type: 'text', text: JSON.stringify({ count }) }], structuredContent: { count } };
      }
      return { content: [{ type: 'text', text: `Friend count: ${count}` }], structuredContent: { count } };
    },
  );

  // 30. statsfm_records_artists — GET /users/{id}/records/artists.
  server.tool(
    'statsfm_records_artists',
    "Record-holding artists of a stats.fm user (longest streaks, top milestones)",
    {
      user_id: userIdSchema(),
      limit: limitSchema(),
      offset: offsetSchema(),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const body = await client.get<J>(`/users/${encodeURIComponent(args.user_id)}/records/artists`, {
        limit: String(args.limit ?? 10),
        offset: String(args.offset ?? 0),
      });
      const items = collectionItems(body, `/users/${encodeURIComponent(args.user_id)}/records/artists`);
      return shapeCollection('Record artists', items, args, (r) => {
        const name = r.artist?.name ?? r.name ?? '?';
        const extra = r.record ? ` — ${String(r.record)}` : r.streams !== undefined ? ` — ${r.streams} streams` : '';
        return `${name}${extra}`;
      });
    },
  );
}
