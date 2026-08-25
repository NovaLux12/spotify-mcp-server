import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { getConfig } from '../config.js';
import {
  batchSummary,
  listStructuredContent,
  paginationInfo,
  resolveMaxResults,
  sharedListFields,
  truncateItems,
  type ResponseFormatValue,
} from '../shaping.js';
import type {
  SpotifyPaged,
  SpotifyPlaylistSimple,
  PlaylistItemObject,
  PlaylistItemsResponse,
  SpotifyImage,
  SpotifyTrack,
  SpotifyEpisode,
} from '../types/spotify.js';

type TextContent = { type: 'text'; text: string };
type ToolResult = { content: TextContent[]; structuredContent?: Record<string, unknown> };

/** Build a tool result; attaches structuredContent when provided (#52). */
function textResult(text: string, structured?: Record<string, unknown>): ToolResult {
  const content: TextContent[] = [{ type: 'text', text }];
  return structured ? { content, structuredContent: structured } : { content };
}

/** Stable identity key over name + artist names for relinked-duplicate grouping (#63). */
function trackIdentityKey(track: SpotifyTrack | SpotifyEpisode): string {
  const artists =
    'artists' in track && Array.isArray(track.artists)
      ? track.artists.map((a) => a.name.toLowerCase()).sort().join(',')
      : '';
  return `${track.name.toLowerCase()}|${artists}`;
}

const jsonText = (data: unknown): string => JSON.stringify(data, null, 2);

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// Hard cap for fetch_all pagination loops (SPOTIFY_MCP_FETCH_ALL_CAP, #55)
const FETCH_ALL_CAP = () => getConfig().fetchAllCap;

// Playlist metadata as returned by GET /playlists/{id}, which includes cover
// images (unlike the simplified playlists in paged listings)
interface PlaylistWithImages extends SpotifyPlaylistSimple {
  images?: SpotifyImage[] | null;
}

// One-line human description of a playlist item, shared by get_playlist and
// get_playlist_items. Returns null for unavailable items (null track), which
// callers render or skip as they see fit.
function formatPlaylistItem(item: PlaylistItemObject): string | null {
  const track = item.track;
  if (!track) return null;
  if (track.type === 'track') {
    const artists = track.artists.map((a) => a.name).join(', ');
    return `"${track.name}" by ${artists} (${formatDuration(track.duration_ms)}) | URI: ${track.uri}`;
  }
  return `"${track.name}" — ${track.show.name} (${formatDuration(track.duration_ms)}) | URI: ${track.uri}`;
}

// Appends the snapshot_id Spotify returns from playlist mutations so agents
// can pin versions in concurrent-edit workflows.
function withSnapshot(text: string, snapshotId: string | undefined): string {
  return snapshotId ? `${text}\nSnapshot ID: ${snapshotId}` : text;
}

export function registerPlaylistTools(server: McpServer, client: SpotifyClient): void {
  // get_user_playlists
  server.tool(
    'get_user_playlists',
    "List the current user's playlists",
    {
      ...sharedListFields,
      limit: z.number().int().min(1).max(50).optional().describe('1–50. Default: 20'),
      offset: z.number().int().min(0).optional().describe('Pagination offset. Default: 0'),
      fetch_all: z
        .boolean()
        .optional()
        .describe(
          `Fetch every page (up to ${getConfig().fetchAllCap} playlists) instead of a single page`,
        ),
    },
    async (args) => {
      const fmt: ResponseFormatValue = args.response_format;
      const limit = String(args.limit ?? 20);
      const params: Record<string, string> = { limit };
      if (args.offset !== undefined) params.offset = String(args.offset);

      const result = await client.get<SpotifyPaged<SpotifyPlaylistSimple>>('/me/playlists', params);
      if (!result) throw new Error('Could not retrieve playlists');

      let total = result.total;
      const items = [...result.items];
      if (args.fetch_all && items.length < Math.min(total, FETCH_ALL_CAP())) {
        // Resume from the absolute position we have already collected rather
        // than restarting at offset 0; pagination logic lives in the client.
        const rest = await client.getAllPages<SpotifyPlaylistSimple>(
          '/me/playlists',
          { limit },
          {
            maxItems: FETCH_ALL_CAP() - items.length,
            initialOffset: (args.offset ?? 0) + items.length,
          },
        );
        items.push(...rest);
        if (items.length > FETCH_ALL_CAP()) items.length = FETCH_ALL_CAP();
      }

      // #53: render at most max_results listings regardless of how many the
      // page(s) carried back; the footer tells the agent how to continue.
      const view = truncateItems(items, resolveMaxResults(args.max_results));
      const shown = view.items;

      if (fmt === 'json') {
        return textResult(jsonText({ total, items }), listStructuredContent(shown, paginationInfo({
          total,
          offset: args.offset ?? 0,
          limit: args.limit ?? 20,
          returned: shown.length,
        })));
      }

      const lines = [`Your playlists (${total} total, showing ${shown.length}):`];
      for (const pl of shown) {
        const trackCount = pl.tracks?.total ?? 0;
        const owner = pl.owner.display_name ?? pl.owner.id;
        lines.push(
          `  • "${pl.name}" by ${owner} (${trackCount} tracks) | ID: ${pl.id} | URI: ${pl.uri}`,
        );
        if (fmt === 'detailed' && pl.description) lines.push(`    Description: ${pl.description}`);
      }
      if (view.footer) lines.push(`(${view.footer})`);
      return textResult(
        lines.join('\n'),
        listStructuredContent(shown, paginationInfo({
          total,
          offset: args.offset ?? 0,
          limit: args.limit ?? 20,
          returned: shown.length,
        })),
      );
    },
  );

  // get_playlist
  server.tool(
    'get_playlist',
    "Get a playlist's metadata (including cover image) and items",
    {
      ...sharedListFields,
      id: z.string().describe('Playlist ID'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Items per page, 1–100. Default: 50'),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Pagination offset for items. Default: 0'),
      fetch_all: z
        .boolean()
        .optional()
        .describe(
          `Fetch all items across pages (up to ${getConfig().fetchAllCap}) instead of a single page`,
        ),
    },
    async (args) => {
      const id = encodeURIComponent(args.id);
      const itemLimit = String(args.limit ?? 50);
      const itemParams: Record<string, string> = { limit: itemLimit };
      if (args.offset !== undefined) itemParams.offset = String(args.offset);

      const [metadata, firstPage] = await Promise.all([
        client.get<PlaylistWithImages>(`/playlists/${id}`),
        client.get<PlaylistItemsResponse>(`/playlists/${id}/items`, itemParams),
      ]);
      if (!metadata) throw new Error('Playlist not found');

      let items = firstPage;
      if (args.fetch_all && firstPage) {
          const collected = [...firstPage.items];
          while (collected.length < Math.min(firstPage.total, FETCH_ALL_CAP())) {
            const page = await client.get<PlaylistItemsResponse>(`/playlists/${id}/items`, {
              limit: itemLimit,
              offset: String(collected.length),
            });
            if (!page || page.items.length === 0) break;
            collected.push(...page.items);
          }
          if (collected.length > FETCH_ALL_CAP()) collected.length = FETCH_ALL_CAP();
          items = { ...firstPage, items: collected };
      }

      // Cover image: prefer the one embedded in the playlist object, else ask
      // the images endpoint explicitly
      let coverUrl = metadata.images?.[0]?.url ?? null;
      if (!coverUrl) {
        const images = await client.get<SpotifyImage[]>(`/playlists/${id}/images`);
        coverUrl = images?.[0]?.url ?? null;
      }

      const owner = metadata.owner.display_name ?? metadata.owner.id;

      // #51: json mode hands the raw API objects straight to the caller.
      if (args.response_format === 'json') {
        return textResult(jsonText({ playlist: metadata, items: items ?? null }));
      }

      const lines = [`"${metadata.name}" by ${owner}`];
      if (metadata.description) lines.push(`Description: ${metadata.description}`);
      lines.push(`URI: ${metadata.uri}`);
      if (coverUrl) lines.push(`Cover image: ${coverUrl}`);

      if (items && items.items.length > 0) {
        lines.push(`\nTracks (${items.total} total, showing ${items.items.length}):`);
        let trackNum = (args.offset ?? 0) + 1;
        for (const item of items.items) {
          const description = formatPlaylistItem(item);
          if (description) {
            lines.push(`  ${trackNum}. ${description}`);
            if (args.response_format === 'detailed' && item.added_at) {
              lines.push(`     Added: ${item.added_at}`);
            }
          }
          trackNum++;
        }
      } else {
        lines.push('\nPlaylist is empty.');
      }

      return textResult(lines.join('\n'));
    },
  );

  // get_playlist_items
  server.tool(
    'get_playlist_items',
    "List a playlist's items on a single page. Use market to relink tracks and flag unavailable ones, and fields/additional_types to trim the payload.",
    {
      ...sharedListFields,
      playlist_id: z.string().describe('Playlist ID'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Items per page, 1–100. Default: 100'),
      offset: z.number().int().min(0).optional().describe('Pagination offset. Default: 0'),
      market: z
        .string()
        .optional()
        .describe("ISO 3166-1 alpha-2 country code, e.g. 'GB'; relinks tracks to that market and flags unavailable ones"),
      fields: z
        .string()
        .optional()
        .describe("Comma-separated list of response fields to keep, e.g. 'total,items(track(name,uri))'"),
      additional_types: z
        .string()
        .optional()
        .describe("Comma-separated item types beyond the default 'track', e.g. 'track,episode'"),
    },
    async (args) => {
      const id = encodeURIComponent(args.playlist_id);
      const params: Record<string, string> = { limit: String(args.limit ?? 100) };
      if (args.offset !== undefined) params.offset = String(args.offset);
      if (args.market !== undefined) params.market = args.market;
      if (args.fields !== undefined) params.fields = args.fields;
      if (args.additional_types !== undefined) {
        params.additional_types = args.additional_types;
      }

      const page = await client.get<PlaylistItemsResponse>(`/playlists/${id}/items`, params);
      if (!page) throw new Error(`Could not retrieve items for playlist ${args.playlist_id}`);

      // #51/#52/#53: truncate to max_results, expose pagination, and offer a
      // raw-JSON view of the page for programmatic consumers.
      const fmt: ResponseFormatValue = args.response_format;
      const view = truncateItems(page.items, resolveMaxResults(args.max_results));
      const pag = paginationInfo({
        total: page.total,
        offset: args.offset ?? 0,
        limit: args.limit ?? 100,
        returned: view.items.length,
      });

      if (fmt === 'json') {
        return textResult(jsonText(page), listStructuredContent(view.items, pag));
      }

      const lines = [`Playlist items (${page.total} total, showing ${view.items.length}):`];
      let position = (args.offset ?? 0) + 1;
      for (const item of view.items) {
        const description = formatPlaylistItem(item);
        if (description) {
          lines.push(`  ${position}. ${description}`);
          if (fmt === 'detailed' && item.added_at) lines.push(`     Added: ${item.added_at}`);
        } else {
          lines.push(`  ${position}. [unavailable in this market]`);
        }
        position++;
      }
      if (view.footer) lines.push(`(${view.footer})`);
      return textResult(lines.join('\n'), listStructuredContent(view.items, pag));
    },
  );

  // get_playlist_cover
  server.tool(
    'get_playlist_cover',
    "Get a playlist's cover image URLs",
    {
      ...sharedListFields,
      playlist_id: z.string().describe('Playlist ID'),
    },
    async (args) => {
      const images = await client.get<SpotifyImage[]>(
        `/playlists/${encodeURIComponent(args.playlist_id)}/images`,
      );
      if (!images || images.length === 0) {
        return {
          content: [{ type: 'text', text: 'This playlist has no custom cover image.' }],
        };
      }
      if (args.response_format === 'json') {
        return textResult(jsonText(images));
      }
      const lines = [`Cover images (${images.length}):`];
      for (const img of images) {
        const dims =
          img.width != null && img.height != null ? ` (${img.width}x${img.height})` : '';
        lines.push(`  • ${img.url}${dims}`);
      }
      return textResult(lines.join('\n'));
    },
  );

  // upload_playlist_cover
  server.tool(
    'upload_playlist_cover',
    "Replace a playlist's cover image with a base64-encoded JPEG. Requires the ugc-image-upload scope on the Spotify developer dashboard app (plus playlist-modify-public/private); without it Spotify rejects the upload with 403.",
    {
      playlist_id: z.string().describe('Playlist ID'),
      jpeg_base64: z.string().min(1).describe('Base64-encoded JPEG file contents (max 256 KB decoded)'),
    },
    async (args) => {
      // Validate before spending the round-trip: JPEG magic bytes in base64
      // start with /9j, and Spotify caps cover uploads at 256 KB
      if (!args.jpeg_base64.startsWith('/9j')) {
        throw new Error('jpeg_base64 does not look like a JPEG (base64 data should start with "/9j")');
      }
      if (Buffer.from(args.jpeg_base64, 'base64').length > 256 * 1024) {
        throw new Error('Decoded JPEG exceeds the 256 KB limit for playlist covers');
      }

      await client.putRaw(
        `/playlists/${encodeURIComponent(args.playlist_id)}/images`,
        args.jpeg_base64,
      );
      return {
        content: [{ type: 'text', text: 'Cover image uploaded.' }],
      };
    },
  );

  // create_playlist
  // Spotify forbids public=true together with collaborative=true ("to create
  // a collaborative playlist you must also set public to false"), so reject
  // the combination locally with a clear message instead of an upstream 400.
  server.registerTool(
    'create_playlist',
    {
      description: 'Create a new playlist for the current user',
      inputSchema: z
        .object({
          name: z.string().describe('Playlist name'),
          description: z.string().optional().describe('Playlist description'),
          public: z.boolean().optional().describe('Whether the playlist is public. Default: false'),
          collaborative: z
            .boolean()
            .optional()
            .describe('Whether the playlist is collaborative. Default: false'),
        })
        .superRefine((args, ctx) => {
          if (args.public === true && args.collaborative === true) {
            ctx.addIssue({
              code: 'custom',
              path: ['collaborative'],
              message:
                'A playlist cannot be both public and collaborative. Set public to false when collaborative is true.',
            });
          }
        }),
    },
    async (args) => {
      const body: Record<string, unknown> = {
        name: args.name,
        public: args.public ?? false,
        collaborative: args.collaborative ?? false,
      };
      if (args.description) body.description = args.description;

      const result = await client.post<{
        id: string;
        uri: string;
        external_urls: { spotify: string };
      }>('/me/playlists', body);
      if (!result) throw new Error('Could not create playlist');

      return {
        content: [{
          type: 'text',
          text: `Created playlist "${args.name}"\nID: ${result.id}\nURI: ${result.uri}\nURL: ${result.external_urls.spotify}`,
        }],
      };
    },
  );

  // add_to_playlist
  server.tool(
    'add_to_playlist',
    'Add tracks or episodes to a playlist. Max 100 URIs per call.',
    {
      playlist_id: z.string().describe('Playlist ID'),
      uris: z.array(z.string()).min(1).max(100).describe('Track or episode URIs to add'),
      check_duplicates: z
        .boolean()
        .optional()
        .describe('Skip URIs that are already in the playlist instead of appending them (default: false)'),
      position: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Insert at index; appends if omitted'),
    },
    async (args) => {
      const id = encodeURIComponent(args.playlist_id);

      // #63: opt-in duplicate guard — pre-fetch what the playlist already
      // contains and silently skip URIs that are already present.
      let toAdd = args.uris;
      let skipped = 0;
      if (args.check_duplicates) {
        const existing = await client.getAllPages<PlaylistItemObject>(
          `/playlists/${id}/items`,
          { limit: '100' },
        );
        const present = new Set<string>();
        for (const item of existing) {
          if (item.track?.uri) present.add(item.track.uri);
        }
        toAdd = [];
        for (const uri of args.uris) {
          if (present.has(uri)) skipped++;
          else toAdd.push(uri);
        }
      }

      if (toAdd.length === 0) {
        return textResult(
          `All ${args.uris.length} URI(s) already present in playlist — nothing added.`,
        );
      }

      const body: Record<string, unknown> = { uris: toAdd };
      if (args.position !== undefined) body.position = args.position;

      const res = await client.post<{ snapshot_id?: string }>(`/playlists/${id}/items`, body);
      // #58: confirmation-friendly batch echo alongside the snapshot anchor.
      const lines = [`Added ${toAdd.length} item(s) to playlist.`];
      if (skipped > 0) lines.push(`Skipped ${skipped} duplicate(s) already in the playlist.`);
      lines.push(batchSummary(toAdd.length, toAdd));
      return textResult(withSnapshot(lines.join('\n'), res?.snapshot_id));
    },
  );

  // remove_from_playlist
  // A bare URI removes every occurrence of that item; supplying positions[]
  // ({ uri, positions: [i] }) targets specific occurrences instead — the only
  // way to de-duplicate a playlist containing repeats.
  server.tool(
    'remove_from_playlist',
    'Remove tracks or episodes from a playlist. Max 100 entries per call.',
    {
      playlist_id: z.string().describe('Playlist ID'),
      uris: z
        .array(
          z.union([
            z.string(),
            z.object({
              uri: z.string(),
              positions: z.array(z.number().int().min(0)).min(1),
            }),
          ]),
        )
        .min(1)
        .max(100)
        .describe('URIs to remove; use { uri, positions } to target specific occurrences of a repeated URI'),
      snapshot_id: z
        .string()
        .optional()
        .describe('Apply the removal against this playlist version instead of the latest'),
    },
    async (args) => {
      const tracks = args.uris.map((entry) =>
        typeof entry === 'string'
          ? { uri: entry }
          : { uri: entry.uri, positions: entry.positions },
      );
      const body: Record<string, unknown> = { tracks };
      if (args.snapshot_id !== undefined) body.snapshot_id = args.snapshot_id;

      const res = await client.delete<{ snapshot_id?: string }>(
        `/playlists/${encodeURIComponent(args.playlist_id)}/items`,
        body,
      );
      // #58: echo exactly which URIs were touched for the audit trail.
      return textResult(
        withSnapshot(
          `Removed ${tracks.length} item(s) from playlist.\n${batchSummary(
            tracks.length,
            tracks.map((t) => t.uri),
          )}`,
          res?.snapshot_id,
        ),
      );
    },
  );

  // update_playlist
  // Same public/collaborative constraint as create_playlist: reject the
  // forbidden combination before it reaches the API.
  server.registerTool(
    'update_playlist',
    {
      description: "Update a playlist's name, description, or visibility",
      inputSchema: z
        .object({
          id: z.string().describe('Playlist ID'),
          name: z.string().optional().describe('New name'),
          description: z.string().optional().describe('New description'),
          public: z.boolean().optional().describe('New public state'),
          collaborative: z.boolean().optional().describe('New collaborative state'),
        })
        .superRefine((args, ctx) => {
          if (args.public === true && args.collaborative === true) {
            ctx.addIssue({
              code: 'custom',
              path: ['collaborative'],
              message:
                'A playlist cannot be both public and collaborative. Set public to false when collaborative is true.',
            });
          }
        }),
    },
    async (args) => {
      const body: Record<string, unknown> = {};
      if (args.name !== undefined) body.name = args.name;
      if (args.description !== undefined) body.description = args.description;
      if (args.public !== undefined) body.public = args.public;
      if (args.collaborative !== undefined) body.collaborative = args.collaborative;

      if (Object.keys(body).length === 0) {
        throw new Error(
          'Provide at least one field to update (name, description, public, collaborative)',
        );
      }

      await client.put(`/playlists/${encodeURIComponent(args.id)}`, body);
      return { content: [{ type: 'text', text: 'Playlist updated.' }] };
    },
  );

  // reorder_playlist_items
  server.tool(
    'reorder_playlist_items',
    'Move a range of items within a playlist',
    {
      playlist_id: z.string().describe('Playlist ID'),
      range_start: z.number().int().min(0).describe('Index of the first item to move'),
      range_length: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Number of items to move. Default: 1'),
      insert_before: z.number().int().min(0).describe('Index to insert the range before'),
    },
    async (args) => {
      const body: Record<string, unknown> = {
        range_start: args.range_start,
        insert_before: args.insert_before,
      };
      if (args.range_length !== undefined) body.range_length = args.range_length;

      const res = await client.put<{ snapshot_id?: string }>(
        `/playlists/${encodeURIComponent(args.playlist_id)}/items`,
        body,
      );
      // #58: reorder affects a range rather than URIs; still echo the count.
      const moved = args.range_length ?? 1;
      return textResult(
        withSnapshot(`Playlist items reordered.\n${batchSummary(moved, [])}`, res?.snapshot_id),
      );
    },
  );
  // replace_playlist_items
  // PUT /playlists/{id}/items atomically overwrites the entire playlist but
  // accepts at most 100 URIs per call — and each PUT replaces the whole
  // playlist, so sequential PUTs would leave only the last chunk behind.
  // The first chunk therefore performs the atomic replacement and any
  // remainder is appended chunk-by-chunk via POST through the same
  // serialised client queue.
  server.tool(
    'replace_playlist_items',
    'Replace ALL items in a playlist with the supplied URIs, overwriting the current contents. Lists longer than 100 URIs are sent in chunks internally (replace + appends).',
    {
      playlist_id: z.string().describe('Playlist ID'),
      uris: z
        .array(z.string())
        .min(1)
        .describe('Complete ordered list of track or episode URIs the playlist should contain'),
    },
    async (args) => {
      const id = encodeURIComponent(args.playlist_id);
      let snapshotId: string | undefined;
      let requestCount = 0;
      for (let start = 0; start < args.uris.length; start += 100) {
        const chunk = { uris: args.uris.slice(start, start + 100) };
        const res =
          start === 0
            ? await client.put<{ snapshot_id?: string }>(`/playlists/${id}/items`, chunk)
            : await client.post<{ snapshot_id?: string }>(`/playlists/${id}/items`, chunk);
        requestCount++;
        if (res?.snapshot_id) snapshotId = res.snapshot_id;
      }

      // #58: confirmation-friendly batch echo alongside the snapshot anchor.
      return textResult(
        withSnapshot(
          `Replaced playlist contents with ${args.uris.length} item(s) across ${requestCount} request(s).\n${batchSummary(args.uris.length, args.uris)}`,
          snapshotId,
        ),
      );
    },
  );

  // find_duplicates_in_playlist (#63)
  // Pages the whole playlist via getAllPages, then reports two kinds of
  // duplicates: exact URI repeats, and relinked copies of the same song
  // (identical normalized name+artist key) under different URIs. Positions
  // are 0-based API indexes so they can be fed straight back into
  // remove_from_playlist's { uri, positions } entries.
  server.tool(
    'find_duplicates_in_playlist',
    'Find duplicate tracks in a playlist: repeated URIs plus relinked copies of the same song appearing under different URIs.',
    {
      ...sharedListFields,
      playlist_id: z.string().describe('Playlist ID'),
    },
    async (args) => {
      const id = encodeURIComponent(args.playlist_id);
      const items = await client.getAllPages<PlaylistItemObject>(`/playlists/${id}/items`, {
        limit: '100',
      });

      interface Occurrence {
        uri: string;
        position: number;
        label: string;
      }
      const byUri = new Map<string, Occurrence[]>();
      // Identity key (normalized name+artist) -> distinct URIs -> occurrences
      const byIdentity = new Map<string, Map<string, Occurrence[]>>();

      let position = 0;
      for (const item of items) {
        const track = item.track;
        if (track?.uri) {
          const artists =
            'artists' in track && Array.isArray(track.artists)
              ? track.artists.map((a) => a.name).join(', ')
              : ('show' in track && track.show ? track.show.name : '');
          const occ: Occurrence = {
            uri: track.uri,
            position,
            label: `"${track.name}"${artists ? ` by ${artists}` : ''}`,
          };
          const uriOccs = byUri.get(track.uri);
          if (uriOccs) uriOccs.push(occ);
          else byUri.set(track.uri, [occ]);

          const key = trackIdentityKey(track);
          const uriMap = byIdentity.get(key);
          if (uriMap) {
            const occs = uriMap.get(track.uri);
            if (occs) occs.push(occ);
            else uriMap.set(track.uri, [occ]);
          } else {
            byIdentity.set(key, new Map([[track.uri, [occ]]]));
          }
        }
        // Unavailable items still occupy a playlist position.
        position++;
      }

      type DupGroup = {
        kind: 'exact-uri' | 'relinked-name';
        label: string;
        uris: string[];
        positions: number[];
      };
      const groups: DupGroup[] = [];
      for (const [uri, occs] of byUri) {
        if (occs.length > 1) {
          groups.push({
            kind: 'exact-uri',
            label: occs[0].label,
            uris: [uri],
            positions: occs.map((o) => o.position),
          });
        }
      }
      for (const uriMap of byIdentity.values()) {
        if (uriMap.size < 2) continue; // single-URI repeats are exact-uri groups
        const occs = [...uriMap.values()].flat();
        groups.push({
          kind: 'relinked-name',
          label: occs[0].label,
          uris: [...uriMap.keys()],
          positions: occs.map((o) => o.position),
        });
      }

      const view = truncateItems(groups, resolveMaxResults(args.max_results));
      const pag = paginationInfo({ returned: view.items.length });
      const extra = { playlist_id: args.playlist_id, scanned: items.length };

      if (args.response_format === 'json') {
        return textResult(jsonText({ ...extra, groups: view.items }), listStructuredContent(view.items, pag, extra));
      }

      if (groups.length === 0) {
        return textResult(`No duplicates found across ${items.length} scanned item(s).`);
      }

      const lines = [
        `Found ${groups.length} duplicate group(s) across ${items.length} scanned item(s):`,
      ];
      let groupNum = 1;
      for (const g of view.items) {
        lines.push(
          `${groupNum}. ${g.label} — ${g.positions.length} occurrence(s) [${
            g.kind === 'exact-uri' ? 'same URI' : 'relinked / different URIs'
          }]`,
        );
        lines.push(`   ${g.uris.length === 1 ? 'URI' : 'URIs'}: ${g.uris.join(', ')}`);
        lines.push(`   Positions (0-based): ${g.positions.join(', ')}`);
        groupNum++;
      }
      if (view.footer) lines.push(`(${view.footer})`);
      lines.push('Remove specific occurrences with remove_from_playlist using { uri, positions }.');
      return textResult(lines.join('\n'), listStructuredContent(view.items, pag, extra));
    },
  );
}
