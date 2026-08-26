import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import type {
  SpotifyPaged,
  SavedTrackItem,
  SavedAlbumItem,
  SavedShowItem,
  SavedEpisodeItem,
} from '../types/spotify.js';
import {
  ResponseFormat,
  MaxResults,
  resolveMaxResults,
  truncateItems,
  paginationInfo,
  listStructuredContent,
  batchSummary,
  describeDryRun,
  DryRun,
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
 * items client-side, otherwise a next-offset hint while the API has more.
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

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

const SAVED_URI_TYPES = ['track', 'album', 'show', 'episode', 'audiobook'] as const;
type SavedUriType = (typeof SAVED_URI_TYPES)[number];

function partitionSavedUris(uris: string[]): Record<SavedUriType, string[]> {
  const buckets: Record<SavedUriType, string[]> = {
    track: [],
    album: [],
    show: [],
    episode: [],
    audiobook: [],
  };
  for (const uri of uris) {
    const match = /^spotify:(track|album|show|episode|audiobook):([^:]+)$/.exec(uri);
    if (!match) {
      throw new Error(
        `Unsupported URI type: ${uri} (supported: spotify:track:, spotify:album:, spotify:show:, spotify:episode:, spotify:audiobook:)`,
      );
    }
    buckets[match[1] as SavedUriType].push(match[2]);
  }
  return buckets;
}

// Shows AND audiobooks take `ids` ONLY as a query parameter (#12, #36): when
// `?ids=` is present any JSON body IDs are ignored, so the body form used by
// tracks/albums/episodes is a silent no-op for these types.
const IDS_AS_QUERY: Record<SavedUriType, boolean> = {
  track: false,
  album: false,
  show: true,
  episode: false,
  audiobook: true,
};

function savedItemsPath(type: SavedUriType, ids: string[]): string {
  if (!IDS_AS_QUERY[type]) return `/me/${type}s`;
  return `/me/${type}s?ids=${encodeURIComponent(ids.join(','))}`;
}

// Unified library endpoints (#37): the modern path accepting any mix of URI
// types — including artist/user/playlist follow state on contains — in a
// single request against /me/library instead of per-type bucket loops.
const LIBRARY_URI_RE = /^spotify:(track|album|episode|show|audiobook|artist|user|playlist):([^:]+)$/;
const LIBRARY_SAVE_TYPES = [
  'track',
  'album',
  'episode',
  'show',
  'audiobook',
  'user',
  'playlist',
] as const;
const LIBRARY_CHECK_TYPES = [...LIBRARY_SAVE_TYPES, 'artist'] as const;

function validateLibraryUris(uris: string[], supported: readonly string[]): void {
  for (const uri of uris) {
    const match = LIBRARY_URI_RE.exec(uri);
    if (!match || !supported.includes(match[1])) {
      throw new Error(
        `Unsupported URI type: ${uri} (supported: ${supported.map((t) => `spotify:${t}:`).join(', ')})`,
      );
    }
  }
}

function libraryUrisParam(uris: string[]): Record<string, string> {
  return { uris: uris.join(',') };
}

export function registerLibraryTools(server: McpServer, client: SpotifyClient): void {
  // get_saved_tracks
  server.tool(
    'get_saved_tracks',
    "Get tracks saved in the user's Liked Songs. Set fetch_all=true to retrieve the entire collection. Output is capped by max_results (default: SPOTIFY_MCP_MAX_ITEMS).",
    {
      limit: z.number().int().min(1).max(50).optional().describe('1–50. Default: 20'),
      offset: z.number().int().min(0).optional().describe('Pagination offset. Default: 0'),
      market: z.string().optional().describe('ISO 3166-1 alpha-2 country code'),
      fetch_all: z
        .boolean()
        .optional()
        .describe('Fetch all pages instead of one page (ignores limit/offset)'),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const rf = args.response_format;
      const params: Record<string, string> = {};
      if (!args.fetch_all) params.limit = String(args.limit ?? 20);
      if (!args.fetch_all && args.offset !== undefined) params.offset = String(args.offset);
      if (args.market) params.market = args.market;

      let allItems: SavedTrackItem[];
      let header: string;
      let pagination;
      let lines: string[];
      if (args.fetch_all) {
        params.limit = '50';
        allItems = await client.getAllPages<SavedTrackItem>('/me/tracks', params);
        const t = truncateItems(allItems, cap(args));
        pagination = paginationInfo({
          total: allItems.length,
          returned: t.items.length,
          limit: t.items.length,
        });
        header = `Liked Songs (${allItems.length} fetched, showing ${t.items.length}):`;
        lines = [header];
        const detailed = rf === 'detailed';
        for (const item of t.items) renderTrackLine(lines, item, detailed);
        if (t.truncated) {
          lines.push(`(${t.remaining} more — pass max_results to raise this call's cap)`);
        }
        return shapeResult(rf, lines.join('\n'), listStructuredContent(t.items, pagination));
      }

      const result = await client.get<SpotifyPaged<SavedTrackItem>>('/me/tracks', params);
      if (!result) throw new Error('Could not retrieve saved tracks');
      const t = truncateItems(result.items, cap(args));
      pagination = paginationInfo({
        total: result.total,
        offset: args.offset ?? 0,
        limit: args.limit ?? 20,
        returned: t.items.length,
      });
      header = `Liked Songs (${result.total} total, showing ${t.items.length}):`;
      lines = [header];
      const detailed = rf === 'detailed';
      for (const item of t.items) renderTrackLine(lines, item, detailed);
      appendPaginationFooters(lines, t, pagination);
      return shapeResult(rf, lines.join('\n'), listStructuredContent(t.items, pagination));
    },
  );

  // get_saved_albums
  server.tool(
    'get_saved_albums',
    "Get albums saved in the user's library. Set fetch_all=true to retrieve the entire collection. Output is capped by max_results (default: SPOTIFY_MCP_MAX_ITEMS).",
    {
      limit: z.number().int().min(1).max(50).optional().describe('1–50. Default: 20'),
      offset: z.number().int().min(0).optional().describe('Pagination offset. Default: 0'),
      market: z.string().optional().describe('ISO 3166-1 alpha-2 country code'),
      fetch_all: z
        .boolean()
        .optional()
        .describe('Fetch all pages instead of one page (ignores limit/offset)'),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const rf = args.response_format;
      const params: Record<string, string> = {};
      if (!args.fetch_all) params.limit = String(args.limit ?? 20);
      if (!args.fetch_all && args.offset !== undefined) params.offset = String(args.offset);
      if (args.market) params.market = args.market;

      let allItems: SavedAlbumItem[];
      let header: string;
      let pagination;
      let lines: string[];
      if (args.fetch_all) {
        params.limit = '50';
        allItems = await client.getAllPages<SavedAlbumItem>('/me/albums', params);
        const t = truncateItems(allItems, cap(args));
        pagination = paginationInfo({
          total: allItems.length,
          returned: t.items.length,
          limit: t.items.length,
        });
        header = `Saved albums (${allItems.length} fetched, showing ${t.items.length}):`;
        lines = [header];
        const detailed = rf === 'detailed';
        for (const item of t.items) renderAlbumLine(lines, item, detailed);
        if (t.truncated) {
          lines.push(`(${t.remaining} more — pass max_results to raise this call's cap)`);
        }
        return shapeResult(rf, lines.join('\n'), listStructuredContent(t.items, pagination));
      }

      const result = await client.get<SpotifyPaged<SavedAlbumItem>>('/me/albums', params);
      if (!result) throw new Error('Could not retrieve saved albums');
      const t = truncateItems(result.items, cap(args));
      pagination = paginationInfo({
        total: result.total,
        offset: args.offset ?? 0,
        limit: args.limit ?? 20,
        returned: t.items.length,
      });
      header = `Saved albums (${result.total} total, showing ${t.items.length}):`;
      lines = [header];
      const detailed = rf === 'detailed';
      for (const item of t.items) renderAlbumLine(lines, item, detailed);
      appendPaginationFooters(lines, t, pagination);
      return shapeResult(rf, lines.join('\n'), listStructuredContent(t.items, pagination));
    },
  );

  // get_saved_shows
  server.tool(
    'get_saved_shows',
    "Get podcast shows saved in the user's library. Set fetch_all=true to retrieve the entire collection. Output is capped by max_results (default: SPOTIFY_MCP_MAX_ITEMS).",
    {
      limit: z.number().int().min(1).max(50).optional().describe('1–50. Default: 20'),
      offset: z.number().int().min(0).optional().describe('Pagination offset. Default: 0'),
      fetch_all: z
        .boolean()
        .optional()
        .describe('Fetch all pages instead of one page (ignores limit/offset)'),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const rf = args.response_format;
      const params: Record<string, string> = {};
      if (!args.fetch_all) params.limit = String(args.limit ?? 20);
      if (!args.fetch_all && args.offset !== undefined) params.offset = String(args.offset);

      let allItems: SavedShowItem[];
      let header: string;
      let pagination;
      let lines: string[];
      if (args.fetch_all) {
        params.limit = '50';
        allItems = await client.getAllPages<SavedShowItem>('/me/shows', params);
        const t = truncateItems(allItems, cap(args));
        pagination = paginationInfo({
          total: allItems.length,
          returned: t.items.length,
          limit: t.items.length,
        });
        header = `Saved shows (${allItems.length} fetched, showing ${t.items.length}):`;
        lines = [header];
        const detailed = rf === 'detailed';
        for (const item of t.items) renderShowLine(lines, item, detailed);
        if (t.truncated) {
          lines.push(`(${t.remaining} more — pass max_results to raise this call's cap)`);
        }
        return shapeResult(rf, lines.join('\n'), listStructuredContent(t.items, pagination));
      }

      const result = await client.get<SpotifyPaged<SavedShowItem>>('/me/shows', params);
      if (!result) throw new Error('Could not retrieve saved shows');
      const t = truncateItems(result.items, cap(args));
      pagination = paginationInfo({
        total: result.total,
        offset: args.offset ?? 0,
        limit: args.limit ?? 20,
        returned: t.items.length,
      });
      header = `Saved shows (${result.total} total, showing ${t.items.length}):`;
      lines = [header];
      const detailed = rf === 'detailed';
      for (const item of t.items) renderShowLine(lines, item, detailed);
      appendPaginationFooters(lines, t, pagination);
      return shapeResult(rf, lines.join('\n'), listStructuredContent(t.items, pagination));
    },
  );

  // get_saved_episodes
  server.tool(
    'get_saved_episodes',
    "Get podcast episodes saved in the user's library. Set fetch_all=true to retrieve the entire collection. Output is capped by max_results (default: SPOTIFY_MCP_MAX_ITEMS).",
    {
      limit: z.number().int().min(1).max(50).optional().describe('1–50. Default: 20'),
      offset: z.number().int().min(0).optional().describe('Pagination offset. Default: 0'),
      market: z.string().optional().describe('ISO 3166-1 alpha-2 country code'),
      fetch_all: z
        .boolean()
        .optional()
        .describe('Fetch all pages instead of one page (ignores limit/offset)'),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const rf = args.response_format;
      const params: Record<string, string> = {};
      if (!args.fetch_all) params.limit = String(args.limit ?? 20);
      if (!args.fetch_all && args.offset !== undefined) params.offset = String(args.offset);
      if (args.market) params.market = args.market;

      let allItems: SavedEpisodeItem[];
      let header: string;
      let pagination;
      let lines: string[];
      if (args.fetch_all) {
        params.limit = '50';
        allItems = await client.getAllPages<SavedEpisodeItem>('/me/episodes', params);
        const t = truncateItems(allItems, cap(args));
        pagination = paginationInfo({
          total: allItems.length,
          returned: t.items.length,
          limit: t.items.length,
        });
        header = `Saved episodes (${allItems.length} fetched, showing ${t.items.length}):`;
        lines = [header];
        const detailed = rf === 'detailed';
        for (const item of t.items) renderEpisodeLine(lines, item, detailed);
        if (t.truncated) {
          lines.push(`(${t.remaining} more — pass max_results to raise this call's cap)`);
        }
        return shapeResult(rf, lines.join('\n'), listStructuredContent(t.items, pagination));
      }

      const result = await client.get<SpotifyPaged<SavedEpisodeItem>>('/me/episodes', params);
      if (!result) throw new Error('Could not retrieve saved episodes');
      const t = truncateItems(result.items, cap(args));
      pagination = paginationInfo({
        total: result.total,
        offset: args.offset ?? 0,
        limit: args.limit ?? 20,
        returned: t.items.length,
      });
      header = `Saved episodes (${result.total} total, showing ${t.items.length}):`;
      lines = [header];
      const detailed = rf === 'detailed';
      for (const item of t.items) renderEpisodeLine(lines, item, detailed);
      appendPaginationFooters(lines, t, pagination);
      return shapeResult(rf, lines.join('\n'), listStructuredContent(t.items, pagination));
    },
  );

  // save_items
  server.tool(
    'save_items',
    "Legacy per-type variant (kept for grandfathered app credentials that lack unified /me/library access). Prefer save_to_library. Save one or more items to the user's library. Accepts track, album, show, episode, and audiobook URIs (e.g. spotify:track:abc). Max 50. Set dry_run=true to preview.",
    {
      uris: z
        .array(z.string())
        .min(1)
        .max(50)
        .describe('Spotify URIs to save (e.g. ["spotify:track:abc", "spotify:album:xyz"])'),
      dry_run: DryRun,
      response_format: ResponseFormat,
    },
    async (args) => {
      const buckets = partitionSavedUris(args.uris); // validates even in preview mode
      if (args.dry_run) {
        return dryRunOut(args.response_format, 'save_items', 'user library', args.uris);
      }
      const counts: string[] = [];
      let saved = 0;
      for (const type of SAVED_URI_TYPES) {
        const ids = buckets[type];
        if (ids.length === 0) continue;
        await client.put(savedItemsPath(type, ids), IDS_AS_QUERY[type] ? undefined : { ids });
        counts.push(`${ids.length} ${type}${ids.length === 1 ? '' : 's'}`);
        saved += ids.length;
      }
      return mutationOut(
        args.response_format,
        `Saved ${saved} item(s) to library (${counts.join(', ')}).`,
        saved,
        args.uris,
      );
    },
  );

  // remove_saved_items
  server.tool(
    'remove_saved_items',
    "Legacy per-type variant (kept for grandfathered app credentials that lack unified /me/library access). Prefer remove_from_library. Remove one or more items from the user's library. Accepts track, album, show, episode, and audiobook URIs (e.g. spotify:track:abc). Max 50. Set dry_run=true to preview.",
    {
      uris: z.array(z.string()).min(1).max(50).describe('Spotify URIs to remove'),
      dry_run: z
        .boolean()
        .optional()
        .describe('Preview only: show exactly which URIs would be removed without calling the API'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const buckets = partitionSavedUris(args.uris); // validates even in preview mode
      if (args.dry_run) {
        return dryRunOut(args.response_format, 'remove_saved_items', 'user library', args.uris);
      }
      let removed = 0;
      for (const type of SAVED_URI_TYPES) {
        const ids = buckets[type];
        if (ids.length === 0) continue;
        await client.delete(savedItemsPath(type, ids), IDS_AS_QUERY[type] ? undefined : { ids });
        removed += ids.length;
      }
      return mutationOut(
        args.response_format,
        `Removed ${removed} item(s) from library.`,
        removed,
        args.uris,
      );
    },
  );

  // check_saved_items
  server.tool(
    'check_saved_items',
    "Legacy per-type variant (kept for grandfathered app credentials that lack unified /me/library access). Prefer check_in_library. Check whether items are saved in the user's library. Returns a boolean per URI. Accepts track, album, show, episode, and audiobook URIs. Max 50.",
    {
      uris: z
        .array(z.string())
        .min(1)
        .max(50)
        .describe(
          'Spotify URIs to check (accepts tracks, albums, shows, episodes, audiobooks)',
        ),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const buckets = partitionSavedUris(args.uris);
      const savedByUri = new Map<string, boolean>();
      for (const type of SAVED_URI_TYPES) {
        const ids = buckets[type];
        if (ids.length === 0) continue;
        const contains = await client.get<boolean[]>(`/me/${type}s/contains`, {
          ids: ids.join(','),
        });
        if (!contains) throw new Error(`Could not check saved ${type}s`);
        ids.forEach((id, i) => savedByUri.set(`spotify:${type}:${id}`, contains[i] ?? false));
      }

      const checks = args.uris.map((uri) => ({ uri, saved: savedByUri.get(uri) ?? false }));
      const t = truncateItems(checks, cap(args));
      const pagination = paginationInfo({ total: checks.length, returned: t.items.length });

      const lines = ['Library check:'];
      for (const c of t.items) lines.push(`  ${c.saved ? '✓' : '✗'} ${c.uri}`);
      appendPaginationFooters(lines, t, pagination);
      return shapeResult(args.response_format, lines.join('\n'), listStructuredContent(t.items, pagination));
    },
  );

  // save_to_library (#37)
  server.tool(
    'save_to_library',
    "Preferred. Accepts the widest URI mix (track, album, episode, show, audiobook, user, playlist) in one request. Save one or more items to the user's library via Spotify's unified library endpoint. Max 40. Set dry_run=true to preview.",
    {
      uris: z
        .array(z.string())
        .min(1)
        .max(40)
        .describe('Spotify URIs to save (e.g. ["spotify:track:abc", "spotify:user:xyz"])'),
      dry_run: DryRun,
      response_format: ResponseFormat,
    },
    async (args) => {
      validateLibraryUris(args.uris, LIBRARY_SAVE_TYPES); // validates even in preview mode
      if (args.dry_run) {
        return dryRunOut(args.response_format, 'save_to_library', 'user library', args.uris);
      }
      await client.put(`/me/library?${new URLSearchParams(libraryUrisParam(args.uris)).toString()}`);
      return mutationOut(
        args.response_format,
        `Saved ${args.uris.length} item(s) to library.`,
        args.uris.length,
        args.uris,
      );
    },
  );

  // remove_from_library (#37)
  server.tool(
    'remove_from_library',
    "Preferred. Accepts the widest URI mix (track, album, episode, show, audiobook, user, playlist) in one request. Remove one or more items from the user's library via Spotify's unified library endpoint. Max 40. Set dry_run=true to preview.",
    {
      uris: z
        .array(z.string())
        .min(1)
        .max(40)
        .describe('Spotify URIs to remove'),
      dry_run: z
        .boolean()
        .optional()
        .describe('Preview only: show exactly which URIs would be removed without calling the API'),
      response_format: ResponseFormat,
    },
    async (args) => {
      validateLibraryUris(args.uris, LIBRARY_SAVE_TYPES); // validates even in preview mode
      if (args.dry_run) {
        return dryRunOut(args.response_format, 'remove_from_library', 'user library', args.uris);
      }
      await client.delete(
        `/me/library?${new URLSearchParams(libraryUrisParam(args.uris)).toString()}`,
      );
      return mutationOut(
        args.response_format,
        `Removed ${args.uris.length} item(s) from library.`,
        args.uris.length,
        args.uris,
      );
    },
  );

  // check_in_library (#37)
  server.tool(
    'check_in_library',
    "Preferred. Accepts the widest URI mix (track, album, episode, show, audiobook, artist, user, playlist) in one request. Check whether items are saved in or followed by the user — this tests LIBRARY-SAVED/FOLLOWED state, distinct from check_following_artists which only tests artist FOLLOW state. Returns a boolean per URI via Spotify's unified endpoint. Max 40. To follow/unfollow artists use follow_artists/unfollow_artists.",
    {
      uris: z
        .array(z.string())
        .min(1)
        .max(40)
        .describe(
          'Spotify URIs to check (accepts tracks, albums, episodes, shows, audiobooks, artists, users, playlists)',
        ),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      validateLibraryUris(args.uris, LIBRARY_CHECK_TYPES);
      const contains = await client.get<boolean[]>(
        '/me/library/contains',
        libraryUrisParam(args.uris),
      );
      if (!contains) throw new Error('Could not check library state');

      const checks = args.uris.map((uri, i) => ({ uri, saved: contains[i] ?? false }));
      const t = truncateItems(checks, cap(args));
      const pagination = paginationInfo({ total: checks.length, returned: t.items.length });

      const lines = ['Library check:'];
      for (const c of t.items) lines.push(`  ${c.saved ? '✓' : '✗'} ${c.uri}`);
      appendPaginationFooters(lines, t, pagination);
      return shapeResult(args.response_format, lines.join('\n'), listStructuredContent(t.items, pagination));
    },
  );
}

// ---------------------------------------------------------------------------
// Item-line renderers (concise vs detailed #51)
// ---------------------------------------------------------------------------

function renderTrackLine(lines: string[], item: SavedTrackItem, detailed = false): void {
  const artists = item.track.artists.map((a) => a.name).join(', ');
  let line = `  • "${item.track.name}" by ${artists} (${formatDuration(item.track.duration_ms)}) | URI: ${item.track.uri}`;
  if (detailed) {
    const album = (item.track as { album?: { name?: string } }).album?.name;
    if (album) line += ` | Album: ${album}`;
    line += ` | Added: ${item.added_at}`;
  }
  lines.push(line);
}

function renderAlbumLine(lines: string[], item: SavedAlbumItem, detailed = false): void {
  const artists = item.album.artists.map((a) => a.name).join(', ');
  let line = `  • "${item.album.name}" by ${artists} (${item.album.total_tracks} tracks, ${item.album.release_date}) | URI: ${item.album.uri}`;
  if (detailed) line += ` | Added: ${item.added_at}`;
  lines.push(line);
}

function renderShowLine(lines: string[], item: SavedShowItem, detailed = false): void {
  let line = `  • "${item.show.name}" by ${item.show.publisher ?? 'unknown publisher'} (${item.show.total_episodes} episodes) | URI: ${item.show.uri}`;
  if (detailed) line += ` | Added: ${item.added_at}`;
  lines.push(line);
}

function renderEpisodeLine(lines: string[], item: SavedEpisodeItem, detailed = false): void {
  let line = `  • "${item.episode.name}" — ${item.episode.show.name} (${formatDuration(item.episode.duration_ms)}, ${item.episode.release_date}) | URI: ${item.episode.uri}`;
  if (detailed) line += ` | Added: ${item.added_at}`;
  lines.push(line);
}
