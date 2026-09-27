import { z } from 'zod';
import { issueReceipt, formatReceipt } from '../receipts.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { capFor, runChunkedPlaylistWrite } from '../chunk.js';
import { getConfig } from '../config.js';
import { fetchCoverJpeg, validateCoverJpegBuffer } from '../cover-image.js';
import {
  confirmViaElicitation,
  describeConfirmation,
  requiredConfirmationRefusal,
  REMOVE_ELICIT_THRESHOLD,
  REPLACE_ELICIT_THRESHOLD,
} from './confirm.js';
import {
  assertPlaylistRewritable,
  unavailableRowNotice,
  unavailableRowPositions,
} from './rewritable.js';
import {
  DryRun,
  PlaylistId,
  PAGED_WALK_LIST_REASON,
  PlaylistListFields,
  PlaylistPairFields,
  TargetPlaylistFields,
  describeDryRun,
  batchSummary,
  playlistListFields,
  listStructuredContent,
  ResponseFormat,
  normalizePlaylistReference,
  paginationInfo,
  resolvePlaylistInput,
  resolveMaxResults,
  MaxResults,
  sharedListFields,
  truncateItems,
  withPlaylistInputMetadata,
  withPlaylistInputNote,
  type ResponseFormatValue,
} from '../shaping.js';
import type {
  SpotifyPaged,
  SpotifyPlaylistPage,
  SpotifyPlaylistSimple,
  SpotifyPlaylistVisibilityRow,
  SpotifyPlaylistWithImages,
  PlaylistItemObject,
  PlaylistItemsResponse,
  SpotifyImage,
  SpotifyTrack,
  SpotifyEpisode,
} from '../types/spotify.js';
import { playlistItemTotal } from '../types/spotify.js';

type TextContent = { type: 'text'; text: string };
type ToolResult = { content: TextContent[]; structuredContent?: Record<string, unknown> };
/**
 * `GET /me/library/contains` takes "Maximum: 40 URIs" per request
 * (Spotify reference: Check User's Saved Items). Requests over the cap are
 * rejected, so a chunk that reads as a count would be a silent false.
 */
const LIBRARY_CONTAINS_CHUNK = 40;

/**
 * #860: what to do when a full-sequence rewrite is refused. The refusal names
 * the tool that actually removes the rows, so the caller has one next step
 * instead of a description of the problem.
 */
const UNAVAILABLE_REMEDY = 'Run remove_unavailable_playlist_items to delete them first, then retry.';

/**
 * A dry run that previewed a commit the apply path will refuse is its own
 * false claim (#860), so the refusal rides along under the plan instead of
 * replacing it — the caller still sees what it asked for.
 */
function planWithNotice(plan: string, notice: string | null): string {
  return notice === null ? plan : `${plan}\n${notice}`;
}

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
/**
 * The effective source-walk ceiling. The walk clamps `scan_cap` to the
 * configured FETCH_ALL_CAP, so every payload must report THIS value rather than
 * the raw request: a caller passing scan_cap: 5000 against a 500 ceiling would
 * otherwise be told the walk stopped at 5000, which is the figure the
 * destructive-impact arithmetic and the confirmation prompt were derived from.
 */
function effectiveScanCap(args: { scan_cap?: number }): number {
  return Math.min(args.scan_cap ?? getConfig().fetchAllCap, getConfig().fetchAllCap);
}

/**
 * Truncation disclosure for a capped playlist walk (#864). One wording for
 * every playlist-family call site so "this scan stopped short" always reads
 * the same. Returns null when the walk reached the end, so callers can splice
 * it straight into prose and payloads and stay silent on every ordinary
 * playlist.
 *
 * The clause names the OFFSET the walk died at, not an age. Spotify's
 * offset-paged playlist endpoints are append-ordered, so the rows past a
 * 500-row cap are the NEWER ones; the shared `completenessFooter` says
 * "older items were not analyzed", which is false here and reads as a
 * self-contradiction when appended to this clause. Its wording is left alone
 * for the offset-paged endpoints it was written for — #864 fixes only the
 * playlist walks, which compose their own clause.
 */
export function walkTruncationNotice(
  scanned: number,
  cap: number,
  truncated: boolean,
): string | null {
  if (!truncated) return null;
  return `TRUNCATED: scanned ${scanned} item(s), cap ${cap}`
    + ` — items past offset ${scanned} were not analyzed; resume at offset ${scanned}`
    + ' or raise SPOTIFY_MCP_FETCH_ALL_CAP to scan the rest';
}

/** Walk controls for a two-playlist (A/B) read: the read bounds, not a list. */
const PlaylistPairWalkFields = {
  limit: z.number().int().min(1).max(100).optional().describe('Source page size, 1–100. Default: 100'),
  scan_cap: z.number().int().min(1).max(10_000).optional().describe('Maximum rows to read from each playlist; bounded by SPOTIFY_MCP_FETCH_ALL_CAP'),
};

const PlaylistSetWalkFields = {
  // Walk controls: how much of each source is READ.
  limit: z.number().int().min(1).max(100).optional().describe('Source page size, 1–100. Default: 100'),
  scan_cap: z.number().int().min(1).max(10_000).optional().describe('Maximum source rows to scan; bounded by SPOTIFY_MCP_FETCH_ALL_CAP'),
  // Render cap: how much of the computed set is RETURNED. Without it the
  // payloads below carry the whole union/remainder, which for ten sources at
  // the default walk ceiling is thousands of URIs in one result.
  max_results: MaxResults,
};

/**
 * The read filters Spotify accepts on BOTH `GET /playlists/{playlist_id}` and
 * `GET /playlists/{playlist_id}/items}` (#884). Declared ONCE because
 * `get_playlist` and `get_playlist_items` read the same endpoint pair: two
 * copies of a query-parameter list drift, and a wrong or missing one is a
 * runtime 400 from Spotify, not a schema error. Verified against the official
 * OpenAPI schema (`QueryMarket`, `fields`, `QueryAdditionalTypes`) — all three
 * are optional query parameters on both paths, spelled exactly as here.
 *
 * `additional_types` takes `track` and `episode`, the only types the schema
 * documents, and is sent comma-separated (`track,episode`) on the wire.
 */
const PlaylistReadFilterFields = {
  market: z
    .string()
    .regex(/^[A-Za-z]{2}$/, 'market must be a 2-letter ISO 3166-1 alpha-2 country code, e.g. "US"')
    .transform((code) => code.toUpperCase())
    .optional()
    .describe("ISO 3166-1 alpha-2 country code, e.g. 'GB'; relinks tracks to that market and flags unavailable ones"),
  fields: z
    .string()
    .optional()
    .describe("Comma-separated list of response fields to keep, e.g. 'total,items(track(name,uri))'"),
  additional_types: z
    .array(z.enum(['track', 'episode']))
    .optional()
    .describe("Item types to include beyond the default 'track', e.g. ['track', 'episode']"),
};

/** Renders the read filters into the wire spelling Spotify expects. */
function playlistReadFilterParams(args: {
  market?: string;
  fields?: string;
  additional_types?: ('track' | 'episode')[];
}): Record<string, string> {
  const params: Record<string, string> = {};
  if (args.market !== undefined) params.market = args.market;
  if (args.fields !== undefined) params.fields = args.fields;
  if (args.additional_types !== undefined) {
    params.additional_types = args.additional_types.join(',');
  }
  return params;
}

// #157: visibility flips are gated by DIRECTION, not size — any change that
// makes a playlist more visible (private→public, or enabling collaboration)
// elicits; toward-private flips never do. The threshold counts how many
// toward-visible field flips trigger prompting (1 = any single flip).
const VISIBILITY_ELICIT_THRESHOLD = 1;

// Human label for a possibly-unknown visibility flag in confirmation text.
function visibilityLabel(v: boolean | null | undefined): string {
  return v === true ? 'true' : v === false ? 'false' : 'unknown';
}

// One-line human description of a playlist item, shared by get_playlist and
// get_playlist_items. Returns null for unavailable items (null track), which
// callers render or skip as they see fit.
function formatPlaylistItem(item: PlaylistItemObject): string | null {
  const track = item.item;
  if (!track) return null;
  if (track.type === 'track') {
    const artists = track.artists.map((a) => a.name).join(', ');
    return `"${track.name}" by ${artists} (${formatDuration(track.duration_ms)}) | URI: ${track.uri}`;
  }
  return `"${track.name}" — ${track.show.name} (${formatDuration(track.duration_ms)}) | URI: ${track.uri}`;
}

// What overwriting an existing playlist actually costs, in rows. The union gate
// is driven by this rather than by the size of the incoming union: a 2-row
// union can silently delete 100 rows, while a 400-row union into a brand-new
// playlist destroys nothing. Multiset-aware, so repeated URIs are classified
// correctly instead of being collapsed by a plain set difference.
interface ReplacementImpact {
  /** True when the target already holds exactly these URIs in this order. */
  identical: boolean;
  /** Existing rows the incoming list would drop. */
  removed: number;
  /** Rows the incoming list would introduce. */
  added: number;
  /** Same rows as today, different order — still a rewrite of every row. */
  reordered: boolean;
}

function replacementImpact(current: string[], next: string[]): ReplacementImpact {
  // Sorted merge walk: one pass, no hashing, and duplicates cancel pairwise.
  const before = [...current].sort();
  const after = [...next].sort();
  let i = 0;
  let j = 0;
  let removed = 0;
  let added = 0;
  while (i < before.length || j < after.length) {
    const left = before[i];
    const right = after[j];
    if (left === undefined || (right !== undefined && right < left)) {
      added += 1;
      j += 1;
    } else if (right === undefined || left < right) {
      removed += 1;
      i += 1;
    } else {
      i += 1;
      j += 1;
    }
  }
  // Equal multisets imply equal lengths, so a positional mismatch here is a
  // pure reorder rather than an add/remove we have already counted.
  const reordered = removed === 0 && added === 0 && current.some((uri, index) => uri !== next[index]);
  return { identical: removed === 0 && added === 0 && !reordered, removed, added, reordered };
}

// Appends the snapshot_id Spotify returns from playlist mutations so agents
// can pin versions in concurrent-edit workflows.
function withSnapshot(text: string, snapshotId: string | undefined): string {
  return snapshotId ? `${text}\nSnapshot ID: ${snapshotId}` : text;
}

// #110 finding 1: the canonical playlist-ID parameter across every playlist
// tool is `playlist_id`. Tools that historically exposed `id` (get_playlist,
// get_playlist_items, get_playlist_cover, update_playlist) keep it as a
// documented back-compat alias. Supplying both is allowed only when they
// agree; conflicting values are rejected before any API round-trip.
//
// #731: exported so search_within_playlist resolves its playlist reference
// through this one implementation instead of a third copy of the playlist_id /
// id convention.
export function resolvePlaylistId(playlistId: string | undefined, legacyId: string | undefined): string {
  if (playlistId !== undefined && legacyId !== undefined && playlistId !== legacyId) {
    throw new Error(
      `Conflicting values: playlist_id ("${playlistId}") and id ("${legacyId}") differ — pass only one.`,
    );
  }
  const raw = playlistId ?? legacyId;
  if (!raw) {
    throw new Error('Provide the playlist as playlist_id (or pass it as id)');
  }
  return raw;
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
          `Fetch every playlist (up to ${getConfig().fetchAllCap}), continuing FROM offset rather than restarting at 0. limit is the page size. Note: library tools' fetch_all instead ignores offset — contracts differ between modules (#110).`,
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
        // #110: json text ≡ structuredContent payload — both carry the
        // max_results-truncated view plus identical pagination info.
        const pagination = paginationInfo({
          total,
          offset: args.offset ?? 0,
          limit: args.limit ?? 20,
          returned: shown.length,
        });
        const payload = { total, items: shown, pagination };
        return textResult(jsonText(payload), listStructuredContent(shown, pagination));
      }

      const lines = [`Your playlists (${total} total, showing ${shown.length}):`];
      for (const pl of shown) {
        const trackCount = pl.items?.total ?? 0;
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
    "Get a playlist's metadata (including cover image) and items. Use market to relink tracks and flag unavailable ones, and fields/additional_types to trim the payload — both are forwarded to the metadata read and the item pages.",
    {
      ...sharedListFields,
      // #110: canonical `playlist_id`; `id` retained as a documented alias.
      playlist_id: z.string().optional().describe('Playlist ID'),
      id: z.string().optional().describe("Alias for playlist_id"),
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
      // #884: the same read filters `get_playlist_items` exposes, forwarded to
      // BOTH calls this tool makes — Spotify documents market/fields/
      // additional_types on `GET /playlists/{id}` as well as on the items path.
      ...PlaylistReadFilterFields,
      fetch_all: z
        .boolean()
        .optional()
        .describe(
          `Fetch all items across pages (up to ${getConfig().fetchAllCap}), continuing FROM offset. limit is the page size. Note: library tools' fetch_all ignores offset — contracts differ between modules (#110).`,
        ),
    },
    async (args) => {
      const id = encodeURIComponent(resolvePlaylistId(args.playlist_id, args.id));
      const itemLimit = String(args.limit ?? 50);
      const itemParams: Record<string, string> = { limit: itemLimit };
      if (args.offset !== undefined) itemParams.offset = String(args.offset);
      Object.assign(itemParams, playlistReadFilterParams(args));
      // The metadata GET takes the same three filters, so a caller narrowing
      // the payload narrows both halves of this tool's answer (#884).
      const metadataParams = playlistReadFilterParams(args);

      const [metadata, firstPage] = await Promise.all([
        client.get<SpotifyPlaylistWithImages>(`/playlists/${id}`, metadataParams),
        client.get<PlaylistItemsResponse>(`/playlists/${id}/items`, itemParams),
      ]);
      if (!metadata) throw new Error('Playlist not found');

      let items = firstPage;
      if (args.fetch_all && firstPage) {
        const collected = [...firstPage.items];
        // #884: the walk goes through the client's paged helper instead of a
        // hand-rolled offset loop, so every page enqueues at LOW priority and
        // reports progress like the rest of the fetch_all family. The first
        // page already arrived at the caller's offset, so the walk resumes
        // from the real number of rows collected — not from `offset` itself,
        // which is what the old loop's `collected.length` was silently
        // assuming when a caller passed both.
        if (collected.length < Math.min(firstPage.total, FETCH_ALL_CAP())) {
          const rest = await client.getAllPages<PlaylistItemObject>(
            `/playlists/${id}/items`,
            itemParams,
            {
              maxItems: FETCH_ALL_CAP() - collected.length,
              initialOffset: (args.offset ?? 0) + collected.length,
            },
          );
          collected.push(...rest);
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

      // #884: `fields` is forwarded to this metadata GET too, so a caller who
      // narrows the payload may legitimately drop `owner`. Read it defensively
      // rather than throwing on a shape the tool itself asked Spotify to send.
      const owner = metadata.owner?.display_name ?? metadata.owner?.id ?? 'unknown owner';

      // #51: json mode hands the raw API objects straight to the caller.
      if (args.response_format === 'json') {
        const payload = { playlist: metadata, items: items ?? null };
        return {
          content: [{ type: 'text', text: jsonText(payload) }],
          structuredContent: payload,
        };
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
          } else {
            // #884: an unavailable item is a ROW the server returned, so it
            // gets a line. Skipping it silently made the enumerated list run
            // short of the "showing N" count beside it, and disagreed with
            // get_playlist_items, which marks the same fixture identically.
            lines.push(`  ${trackNum}. [unavailable in this market]`);
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
      // Issue #80: accept `id` as an alias so the read tools share
      // get_playlist's parameter convention.
      playlist_id: z.string().optional().describe("Playlist ID (or pass it as 'id')"),
      id: z.string().optional().describe("Alias for playlist_id, matching get_playlist"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Items per page, 1–100. Default: 100'),
      offset: z.number().int().min(0).optional().describe('Pagination offset. Default: 0'),
      // Shared with get_playlist — the same three parameters, declared once (#884).
      ...PlaylistReadFilterFields,
      fetch_all: z
        .boolean()
        .optional()
        .describe(
          `Fetch every item across pages (up to ${getConfig().fetchAllCap}), continuing FROM offset rather than restarting at 0. limit is the page size. Note: library tools' fetch_all instead ignores offset — contracts differ between modules (#110).`,
        ),
    },
    async (args) => {
      const id = encodeURIComponent(
        resolvePlaylistId(args.playlist_id, args.id),
      );
      const params: Record<string, string> = { limit: String(args.limit ?? 100) };
      if (args.offset !== undefined) params.offset = String(args.offset);
      Object.assign(params, playlistReadFilterParams(args));

      const page = await client.get<PlaylistItemsResponse>(`/playlists/${id}/items`, params);
      if (!page) throw new Error(`Could not retrieve items for playlist ${args.playlist_id}`);

      let items = page.items;
      let total = page.total;
      if (args.fetch_all && page) {
        const collected = [...page.items];
        while (collected.length < Math.min(page.total, FETCH_ALL_CAP())) {
          const nextPage = await client.get<PlaylistItemsResponse>(`/playlists/${id}/items`, {
            limit: String(args.limit ?? 100),
            offset: String(collected.length),
          });
          if (!nextPage || nextPage.items.length === 0) break;
          collected.push(...nextPage.items);
        }
        if (collected.length > FETCH_ALL_CAP()) collected.length = FETCH_ALL_CAP();
        items = collected;
      }

      // #51/#52/#53: truncate to max_results, expose pagination, and offer a
      // raw-JSON view of the page for programmatic consumers.
      const fmt: ResponseFormatValue = args.response_format;
      const view = args.fetch_all
        ? { items, footer: undefined }
        : truncateItems(items, resolveMaxResults(args.max_results));
      const pag = paginationInfo({
        total,
        offset: args.offset ?? 0,
        limit: args.limit ?? 100,
        returned: view.items.length,
      });

      if (fmt === 'json') {
        const payload = args.fetch_all
          ? { total, items: view.items, offset: args.offset ?? 0, limit: args.limit ?? 100 }
          : page;
        return textResult(jsonText(payload), listStructuredContent(view.items, pag));
      }

      const lines = [`Playlist items (${total} total, showing ${view.items.length}):`];
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
      // Issue #80: same `id` alias as get_playlist_items.
      playlist_id: z.string().optional().describe("Playlist ID (or pass it as 'id')"),
      id: z.string().optional().describe("Alias for playlist_id, matching get_playlist"),
    },
    async (args) => {
      const images = await client.get<SpotifyImage[]>(
        `/playlists/${encodeURIComponent(resolvePlaylistId(args.playlist_id, args.id))}/images`,
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
      dry_run: DryRun,
    },
    async (args) => {
      // Validate before spending the round-trip: JPEG magic bytes in base64
      // start with /9j, and Spotify caps cover uploads at 256 KB. The buffer
      // validator is the same one fetchCoverJpeg uses after a real fetch, so
      // both cover paths agree on what "valid JPEG under the cap" means (#880).
      const buf = Buffer.from(args.jpeg_base64, 'base64');
      validateCoverJpegBuffer(buf);

      if (args.dry_run) {
        return {
          content: [{
            type: 'text',
            text: describeDryRun('upload cover image', args.playlist_id, [
              `Upload ${Math.round(buf.length / 1024)} KB JPEG cover`,
            ]),
          }],
        };
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
      description:
        'Create a new playlist for the current user. Set dry_run=true to preview without creating.',
      inputSchema: z
        .object({
          name: z.string().describe('Playlist name'),
          description: z.string().optional().describe('Playlist description'),
          public: z.boolean().optional().describe('Whether the playlist is public. Default: false'),
          collaborative: z
            .boolean()
            .optional()
            .describe('Whether the playlist is collaborative. Default: false'),
          dry_run: DryRun,
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

      // Issue #79: preview mode matches the destructive tools (#57).
      if (args.dry_run) {
        const visibility = args.collaborative ? 'collaborative' : args.public ? 'public' : 'private';
        const changes = [
          `Would create ${visibility} playlist "${args.name}"` +
            (args.description ? ` — "${args.description}"` : ''),
        ];
        return {
          content: [{
            type: 'text',
            text: `[dry run] create_playlist — nothing was changed.\n${changes.join('\n')}`,
          }],
          structuredContent: { ok: true, dry_run: true, changes },
        };
      }

      const result = await client.post<{
        id: string;
        uri: string;
        external_urls: { spotify: string };
      }>('/me/playlists', body);
      if (!result) throw new Error('Could not create playlist');

      // Receipt (#112 idea 11): confirm the created playlist actually resolves.
      const meta = await issueReceipt(client, {
        kind: 'playlist_meta',
        id: result.id,
        uris: [],
      });
      return {
        content: [{
          type: 'text',
          text: `Created playlist "${args.name}"\nID: ${result.id}\nURI: ${result.uri}\nURL: ${result.external_urls.spotify}\n${formatReceipt(meta)}`,
        }],
        structuredContent: {
          ok: true,
          id: result.id,
          uri: result.uri,
          url: result.external_urls.spotify,
          name: args.name,
          receipt: meta as unknown as Record<string, unknown>,
        },
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
      dry_run: DryRun,
    },
    async (args) => {
      const id = encodeURIComponent(args.playlist_id);
      // #864: the duplicate guard's presence set comes from a capped walk, so
      // every path that used it has to disclose how much of the playlist that
      // set actually covers. Without it, "Would add 8 track(s)" on a
      // 1,204-item playlist reads as a complete dedupe when only the first 500
      // rows ever entered the set. The POST body is untouched — the guard
      // itself is unchanged, only its coverage is now reported.
      let scanTruncated = false;
      let scanCap: number | null = null;
      let scanned = 0;
      // #110: preview honors check_duplicates reads (safe) but makes no writes.
      if (args.dry_run) {
        let wouldAdd = args.uris;
        if (args.check_duplicates) {
          scanCap = getConfig().fetchAllCap;
          const existing = await client.getAllPagesWithTruncation<PlaylistItemObject>(
            `/playlists/${id}/items`,
            { limit: '100' },
            { maxItems: scanCap },
          );
          const present = new Set<string>();
          for (const item of existing.items) {
            if (item.item?.uri) present.add(item.item.uri);
          }
          wouldAdd = args.uris.filter((u) => !present.has(u));
          scanned = existing.items.length;
          scanTruncated = existing.truncated;
        }
        const notice = scanCap === null ? null : walkTruncationNotice(scanned, scanCap, scanTruncated);
        return {
          content: [{
            type: 'text',
            text: describeDryRun('add to playlist', args.playlist_id, wouldAdd)
              + (notice ? `\n${notice}` : ''),
          }],
          structuredContent: {
            ok: true,
            dry_run: true,
            changes: wouldAdd,
            skipped: args.uris.length - wouldAdd.length,
            scanned: scanCap === null ? null : scanned,
            scan_truncated: scanTruncated,
            scan_cap: scanCap,
          },
        };
      }

      // #63: opt-in duplicate guard — pre-fetch what the playlist already
      // contains and silently skip URIs that are already present.
      let toAdd = args.uris;
      let skipped = 0;
      if (args.check_duplicates) {
        scanCap = getConfig().fetchAllCap;
        const existing = await client.getAllPagesWithTruncation<PlaylistItemObject>(
          `/playlists/${id}/items`,
          { limit: '100' },
          { maxItems: scanCap },
        );
        const present = new Set<string>();
        for (const item of existing.items) {
          if (item.item?.uri) present.add(item.item.uri);
        }
        scanned = existing.items.length;
        scanTruncated = existing.truncated;
        toAdd = [];
        for (const uri of args.uris) {
          if (present.has(uri)) skipped++;
          else toAdd.push(uri);
        }
      }

      const notice = scanCap === null ? null : walkTruncationNotice(scanned, scanCap, scanTruncated);
      const scanMeta = {
        scanned: scanCap === null ? null : scanned,
        scan_truncated: scanTruncated,
        scan_cap: scanCap,
      };

      if (toAdd.length === 0) {
        return textResult(
          `All ${args.uris.length} URI(s) already present in playlist — nothing added.`
            + (notice ? `\n${notice}` : ''),
          // `skipped` is in scope and equals args.uris.length here: this
          // branch is only reachable when every requested URI was found
          // present. Reporting 0 would contradict the dry-run payload's
          // `skipped` for the same call.
          { ok: true, added: 0, skipped, ...scanMeta },
        );
      }

      const body: Record<string, unknown> = { uris: toAdd };
      if (args.position !== undefined) body.position = args.position;

      // #865: add_to_playlist is capped at 100 URIs so it is normally a single
      // chunk, but a 5xx or rejected POST with nothing committed still has to
      // surface the partial state in the same shape as the multi-chunk tools.
      // Using runChunkedPlaylistWrite keeps the contract uniform — a future
      // cap lift would not need a second codepath.
      const write = await runChunkedPlaylistWrite(toAdd, toAdd.length, () => client.post<{ snapshot_id?: string }>(`/playlists/${id}/items`, body));
      if (!write.ok) {
        // toAdd is at most 100, so attempted_chunks is always 1 here.
        return textResult(
          `add_to_playlist failed before any URI landed on playlist ${args.playlist_id}: ${write.error}. Nothing was added.`,
          { ...write, playlist_id: args.playlist_id, attempted_uris: toAdd.length, committed_uris: 0, remaining_uris: toAdd.length, ...scanMeta },
        );
      }
      const res = write.snapshot_id ? { snapshot_id: write.snapshot_id } : undefined;
      // Receipt (#112 idea 11): verify the added URIs actually landed.
      const receipt = await issueReceipt(client, {
        kind: 'playlist_items',
        id: args.playlist_id,
        uris: toAdd,
        // A positional add is not an append: without this the receipt derives
        // the added row as the uri's LAST occurrence, which is a row that
        // predates the add, and `undo` would delete that one instead (#625).
        ...(args.position !== undefined ? { insertPosition: args.position } : {}),
      });
      // #58: confirmation-friendly batch echo alongside the snapshot anchor.
      const lines = [`Added ${toAdd.length} item(s) to playlist.`];
      if (skipped > 0) lines.push(`Skipped ${skipped} duplicate(s) already in the playlist.`);
      if (notice) lines.push(notice);
      lines.push(batchSummary(toAdd.length, toAdd));
      return textResult(
        withSnapshot(`${lines.join('\n')}\n${formatReceipt(receipt)}`, res?.snapshot_id),
        listStructuredContent(toAdd, paginationInfo({
          total: toAdd.length,
          offset: 0,
          limit: toAdd.length,
          returned: toAdd.length,
        }), { ...scanMeta, receipt: receipt as unknown as Record<string, unknown> }),
      );
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
      dry_run: DryRun,
    },
    async (args) => {
      // #241: count total affected ROWS, not entries — one entry with positions:[0..99] removes 100 rows
      const totalAffected = args.uris.reduce((sum, entry) => sum + (typeof entry === 'string' ? 1 : entry.positions.length), 0);
      // bare URIs remove every occurrence — note this so the confirmation is honest
      const hasBareUris = args.uris.some((e) => typeof e === 'string');
      if (args.dry_run) {
        const targets = args.uris.map((entry) =>
          typeof entry === 'string' ? `${entry} (removes every occurrence)` : `${entry.uri} @ ${entry.positions.join(',')}`,
        );
        const note = totalAffected !== args.uris.length || hasBareUris
          ? `Would affect ${totalAffected} row(s)${hasBareUris ? ' — bare URIs remove every occurrence' : ''}:`
          : `Would affect ${targets.length} item(s):`;
        return {
          content: [{
            type: 'text',
            text: `[dry run] remove from playlist on ${args.playlist_id} — nothing was changed.\n${note}\n${targets.map((t) => `  - ${t}`).join('\n')}`,
          }],
          structuredContent: { ok: true, dry_run: true, total_affected: totalAffected, targets } as unknown as Record<string, unknown>,
        };
      }
      if (totalAffected >= REMOVE_ELICIT_THRESHOLD) {
        const targets = args.uris.map((entry) =>
          typeof entry === 'string' ? `${entry} (every occurrence)` : `${entry.uri} @ ${entry.positions.join(',')}`,
        );
        const header = `Remove ${totalAffected} row(s)${hasBareUris ? ' (bare URIs remove every occurrence)' : ''}:`;
        const verdict = await confirmViaElicitation(server, {
          message: describeConfirmation('remove from playlist', args.playlist_id, [
            header,
            ...targets,
          ]),
        });
        // #1237: the shared fail-closed guard. The hand-rolled branches this
        // replaced threw on 'error' and on an unpromptable host, so a host
        // that parsed the refusal got a result for a decline and an exception
        // for the other two ways the same gate says no. Nothing about the gate
        // is weakened — see requiredConfirmationRefusal.
        const refusal = requiredConfirmationRefusal(verdict);
        if (refusal) return textResult(refusal.message, refusal.payload);
      }
      const tracks = args.uris.map((entry) =>
        typeof entry === 'string'
          ? { uri: entry }
          : { uri: entry.uri, positions: entry.positions },
      );
      // Receipt (#112 idea 11): removal verifies ABSENCE; for targeted positions pass targetedPositions so #233 verification is per-position
      const targetedPositions = tracks.some((t) => t.positions !== undefined)
        ? tracks.flatMap((t) => t.positions !== undefined ? t.positions.map((p) => ({ uri: t.uri, position: p })) : [])
        : undefined;
      // #626: a positional removal is verified by comparing the post-write row
      // count against the pre-write one, so the baseline has to be captured
      // BEFORE the delete — after it, the playlist total is the post-mutation
      // one and comparing it to itself would prove nothing. It is read only
      // when positions were used, since that is the only path that compares
      // counts; a bare-URI removal verifies by absence and needs no baseline.
      //
      // Best-effort on purpose: a failed read leaves `before` unset, and the
      // receipt then reports UNVERIFIED naming the missing baseline. An
      // unreadable baseline is a reason to withhold a claim, never a reason to
      // block a write the user asked for — this adds a precondition to the
      // VERIFIED verdict, and removes none.
      let before: number | undefined;
      if (targetedPositions) {
        try {
          before = await getPlaylistRowTotal(args.playlist_id);
        } catch {
          before = undefined;
        }
      }
      const body: Record<string, unknown> = { tracks };
      if (args.snapshot_id !== undefined) body.snapshot_id = args.snapshot_id;

      const res = await client.delete<{ snapshot_id?: string }>(
        `/playlists/${encodeURIComponent(args.playlist_id)}/items`,
        body,
      );
      // Also count total rows removed for the result text (#241)
      const removedRows = tracks.reduce((sum, t) => sum + (t.positions?.length ?? 1), 0);
      const receipt = await issueReceipt(client, {
        kind: 'playlist_items',
        id: args.playlist_id,
        uris: tracks.map((t) => t.uri),
        expectPresent: false,
        ...(targetedPositions ? { targetedPositions } : {}),
        ...(before !== undefined ? { before } : {}),
        ...(removedRows !== tracks.length ? { expectedRemovedCount: removedRows } : {}),
      });
      // #58: echo exactly which URIs were touched for the audit trail.
      const text = withSnapshot(
        `Removed ${removedRows} item(s) from playlist.\n${batchSummary(
          removedRows,
          tracks.map((t) => t.uri),
        )}`,
        res?.snapshot_id,
      );
      return textResult(
        `${text}\n${formatReceipt(receipt, { expectPresent: false })}`,
        { ok: true, removed: removedRows, total_affected: removedRows, snapshot_id: res?.snapshot_id, receipt: receipt as unknown as Record<string, unknown> },
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
          // #110: canonical `playlist_id`; legacy `id` retained as an alias.
          playlist_id: z.string().optional().describe('Playlist ID'),
          id: z.string().optional().describe("Alias for playlist_id"),
          name: z.string().optional().describe('New name'),
          description: z.string().optional().describe('New description'),
          public: z.boolean().optional().describe('New public state'),
          collaborative: z.boolean().optional().describe('New collaborative state'),
          dry_run: DryRun,
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
      const playlistId = resolvePlaylistId(args.playlist_id, args.id);
      if (args.dry_run) {
        const changes = [
          ...(args.name !== undefined ? [`name → "${args.name}"`] : []),
          ...(args.description !== undefined ? [`description → "${args.description}"`] : []),
          ...(args.public !== undefined ? [`public → ${args.public}`] : []),
          ...(args.collaborative !== undefined ? [`collaborative → ${args.collaborative}`] : []),
        ];
        return {
          content: [{ type: 'text', text: describeDryRun('update playlist', playlistId, changes) }],
        };
      }
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

      // #157: flipping a playlist toward MORE visible (private→public, or
      // enabling collaboration) is elicitation-gated. Renames/description
      // edits and toward-private flips never prompt, and the current-state
      // GET happens only when a toward-visible flip is possible. Every verdict
      // except explicit acceptance (or the documented automation bypass) stops
      // the write.
      const towardPublic = args.public === true;
      const towardCollaborative = args.collaborative === true;
      let currentPublic: boolean | null | undefined;
      let currentCollaborative: boolean | undefined;
      if (towardPublic || towardCollaborative) {
        const meta = await client.get<SpotifyPlaylistVisibilityRow>(
          `/playlists/${encodeURIComponent(playlistId)}`,
        );
        currentPublic = meta?.public;
        currentCollaborative = meta?.collaborative;
      }
      const increasing = [
        ...(towardPublic && currentPublic !== true
          ? [`public: ${visibilityLabel(currentPublic)} → true`]
          : []),
        ...(towardCollaborative && currentCollaborative !== true
          ? [`collaborative: ${visibilityLabel(currentCollaborative)} → true`]
          : []),
      ];
      if (increasing.length >= VISIBILITY_ELICIT_THRESHOLD) {
        const verdict = await confirmViaElicitation(server, {
          message: describeConfirmation(
            'make playlist public',
            args.playlist_id ?? playlistId,
            increasing,
          ),
        });
        // #1237: shared fail-closed guard — see the note on
        // remove_from_playlist above. This is the visibility gate on a PUT
        // that can overwrite a playlist, so the refusal shape is the part
        // that matters most here.
        const refusal = requiredConfirmationRefusal(verdict);
        if (refusal) return textResult(refusal.message, refusal.payload);
      }

      await client.put(`/playlists/${encodeURIComponent(playlistId)}`, body);
      const changed = {
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.public !== undefined ? { public: args.public } : {}),
        ...(args.collaborative !== undefined ? { collaborative: args.collaborative } : {}),
      };
      // Receipt (#112 idea 11): confirm the mutated playlist still resolves.
      const metaReceipt = await issueReceipt(client, {
        kind: 'playlist_meta',
        id: playlistId,
        uris: [],
      });
      return {
        content: [{
          type: 'text',
          text: `Playlist updated.${args.name !== undefined ? ` Name: "${args.name}".` : ''}\n${formatReceipt(metaReceipt)}`,
        }],
        structuredContent: {
          ok: true,
          playlist_id: playlistId,
          changed,
          receipt: metaReceipt as unknown as Record<string, unknown>,
        },
      };
    },
  );

  // reorder_playlist_items
  server.tool(
    'reorder_playlist_items',
    'Move a range of items within a playlist. Spotify semantics: when insert_before > range_start, the effective destination shifts down by range_length because the moved range is lifted out first (e.g. moving [2] to insert_before=4 lands it AT index 3).',
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
      dry_run: DryRun,
    },
    async (args) => {
      if (args.dry_run) {
        const moved = args.range_length ?? 1;
        return {
          content: [{
            type: 'text',
            text: describeDryRun(
              'reorder playlist items',
              args.playlist_id,
              [`Move ${moved} item(s) from index ${args.range_start} toward insert_before=${args.insert_before} (lift-then-insert semantics)`],
            ),
          }],
        };
      }
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
      dry_run: DryRun,
    },
    async (args) => {
      if (args.dry_run) {
        return {
          content: [{
            type: 'text',
            text: describeDryRun(
              'replace playlist items',
              args.playlist_id,
              [`Overwrite ALL existing items with ${args.uris.length} URI(s), sent in chunks of ≤100`],
            ),
          }],
        };
      }
      if (args.uris.length >= REPLACE_ELICIT_THRESHOLD) {
        const verdict = await confirmViaElicitation(server, {
          message: describeConfirmation('replace playlist items', args.playlist_id, [
            `Overwrite ALL existing items with ${args.uris.length} URI(s).`,
          ]),
        });
        // #1237: shared fail-closed guard — see the note on
        // remove_from_playlist above.
        const refusal = requiredConfirmationRefusal(verdict);
        if (refusal) return textResult(refusal.message, refusal.payload);
      }
      const id = encodeURIComponent(args.playlist_id);
      // #865: replace_playlist_items atomically PUTs the first chunk, then
      // POSTs the remainder. A failure on chunk N (a later POST, a 5xx on
      // the PUT itself, etc.) left the caller with no way to know what was
      // on the playlist. The performChunk callback chooses PUT for chunk 0
      // and POST for the rest, mirroring the old for-loop.
      const writeCap = capFor('playlist_writes');
      const write = await runChunkedPlaylistWrite(args.uris, writeCap, (chunk, chunkIndex) => {
        const body = { uris: chunk };
        return chunkIndex === 0
          ? client.put<{ snapshot_id?: string }>(`/playlists/${id}/items`, body)
          : client.post<{ snapshot_id?: string }>(`/playlists/${id}/items`, body);
      });
      if (!write.ok) {
        const committedCount = write.committed_uris;
        const lastUri = write.last_committed_chunk_uris[write.last_committed_chunk_uris.length - 1];
        // The PUT chunk 0 is the only "true" replace — anything later is an
        // append onto the replaced playlist, so a partial failure still
        // means the playlist now holds a *partial* new contents, not its old
        // contents. The retry must skip the already-committed prefix.
        const committedUpTo = lastUri ? ` Last URI committed: ${lastUri}.` : '';
        const prose = write.failed_chunk_index === 0
          ? `replace_playlist_items aborted before any URI landed on playlist ${args.playlist_id}: ${write.error}. Nothing was changed.`
          : `Partial replace on playlist ${args.playlist_id}: chunk 0 was a successful atomic replace, chunks 1–${write.failed_chunk_index} appended (${committedCount} URI(s) total), chunk ${write.failed_chunk_index + 1} of ${write.attempted_chunks} failed.${committedUpTo} Retry the remaining ${args.uris.length - committedCount} URI(s); the playlist currently holds the committed prefix. (${write.error})`;
        return textResult(prose, { ...write, playlist_id: args.playlist_id, attempted_uris: args.uris.length, remaining_uris: args.uris.length - committedCount });
      }
      const snapshotId = write.snapshot_id;
      const requestCount = write.chunks;

      // Receipt (#112 idea 11): replace is present-semantics — verify the
      // new contents actually landed.
      const receipt = await issueReceipt(client, {
        kind: 'playlist_items',
        id: args.playlist_id,
        uris: args.uris,
      });
      // #58: confirmation-friendly batch echo alongside the snapshot anchor.
      return textResult(
        withSnapshot(
          `Replaced playlist contents with ${args.uris.length} item(s) across ${requestCount} request(s).\n${batchSummary(args.uris.length, args.uris)}\n${formatReceipt(receipt)}`,
          snapshotId,
        ),
        listStructuredContent(args.uris, paginationInfo({
          total: args.uris.length,
          offset: 0,
          limit: args.uris.length,
          returned: args.uris.length,
        }), { receipt: receipt as unknown as Record<string, unknown> }),
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
      const scan = await client.getAllPagesWithTruncation<PlaylistItemObject>(
        `/playlists/${id}/items`,
        { limit: '100' },
      );
      const items = scan.items;
      // #864: the scan above dies at fetchAllCap, and a scan that stopped
      // short cannot certify a clean playlist. Carry the fact in the payload
      // and the prose rather than reporting a clean bill of health for rows
      // nobody read.
      const scanTruncated = scan.truncated;
      const scanCap = getConfig().fetchAllCap;
      const notice = walkTruncationNotice(items.length, scanCap, scanTruncated);

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
        const track = item.item;
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
      const extra = {
        playlist_id: args.playlist_id,
        scanned: items.length,
        scan_truncated: scanTruncated,
        scan_cap: scanCap,
      };

      if (args.response_format === 'json') {
        return textResult(jsonText({ ...extra, groups: view.items }), listStructuredContent(view.items, pag, extra));
      }

      if (groups.length === 0) {
        // "No duplicates found" is a claim about the WHOLE playlist, so it
        // only survives a walk that read all of it.
        return textResult(
          notice
            ? `No duplicate item(s) among the first ${items.length} scanned item(s) — ${notice}`
            : `No duplicates found across ${items.length} scanned item(s).`,
          // Always attached, clean scan or not: a field that reads `false` on
          // a truncated scan and `undefined` on a clean one is a footgun for
          // every consumer, and "the scan coverage is on the wire" has to be
          // true on both paths.
          listStructuredContent([], pag, extra),
        );
      }

      const lines = [
        `Found ${groups.length} duplicate group(s) across ${items.length} scanned item(s):`,
      ];
      // Prefix, not a footnote: the group list below is a lower bound and the
      // reader has to know that before they act on it.
      if (notice) lines.unshift(notice);
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
      lines.push('Remove specific occurrences with remove_from_playlist using { uri, positions },');
      lines.push('or use remove_duplicate_playlist_items to clean them up in one safe call.');
      return textResult(lines.join('\n'), listStructuredContent(view.items, pag, extra));
    },
  );

  // remove_duplicate_playlist_items (#168)
  // One-shot cleanup companion to find_duplicates_in_playlist: pages the
  // playlist, keeps the FIRST occurrence of every duplicate group (exact URI
  // repeats always; relinked same-song copies on opt-in) and removes the
  // rest. Deletions run highest-position-first so indices never shift under
  // us; bulk removals are elicitation-gated like other destructive ops; a
  // post-mutation re-scan verifies the playlist is actually clean.

  /**
   * Shared keep-first/remove-rest scan (#168/#171): over already-paged items,
   * returns removal occurrences ordered HIGHEST position first plus the
   * duplicate-group count. Exact URI repeats always count; relinked same-song
   * copies join only when includeRelinked.
   */
  function collectDuplicateRemovals(
    items: readonly PlaylistItemObject[],
    includeRelinked: boolean,
  ): { ordered: Array<{ uri: string; position: number; label: string }>; groups: number } {
    interface Occurrence {
      uri: string;
      position: number;
      label: string;
    }
    const byUri = new Map<string, Occurrence[]>();
    const byIdentity = new Map<string, Map<string, Occurrence[]>>();

    let position = 0;
    for (const item of items) {
      const track = item.item;
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

        if (includeRelinked) {
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
      }
      // Unavailable items still occupy a playlist position.
      position++;
    }

    // Keep-first/remove-rest over positions; a Map keyed by position makes
    // the exact-uri and relinked passes compose without double-removals.
    const removals = new Map<number, Occurrence>();
    let groups = 0;
    for (const occs of byUri.values()) {
      if (occs.length > 1) {
        groups++;
        for (const occ of occs.slice(1)) removals.set(occ.position, occ);
      }
    }
    if (includeRelinked) {
      for (const uriMap of byIdentity.values()) {
        if (uriMap.size < 2) continue;
        groups++;
        const all = [...uriMap.values()].flat().sort((a, b) => a.position - b.position);
        for (const occ of all.slice(1)) removals.set(occ.position, occ);
      }
    }

    return {
      ordered: [...removals.values()].sort((a, b) => b.position - a.position),
      groups,
    };
  }

  server.tool(
    'remove_duplicate_playlist_items',
    'Remove duplicate items from a playlist: keeps the first occurrence of each track and removes '
      + 'later repeats. Exact URI repeats are always cleaned; pass include_relinked=true to also '
      + 'collapse same-song entries that appear under different URIs (remasters/relinks). '
      + 'Supports dry_run; removals of 10+ items ask for confirmation via elicitation.',
    {
      playlist_id: z.string().describe('Playlist ID'),
      include_relinked: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Also collapse same-song duplicates under different URIs (relinks/remasters). '
            + 'Default false — only exact URI repeats are removed.',
        ),
      dry_run: DryRun,
    },
    async (args) => {
      const id = encodeURIComponent(args.playlist_id);
      const meta = await client.get<{ id?: string; name?: string }>(`/playlists/${id}`);
      if (!meta) throw new Error(`Playlist "${args.playlist_id}" not found`);

      const scan = await client.getAllPagesWithTruncation<PlaylistItemObject>(
        `/playlists/${id}/items`,
        { limit: '100' },
      );
      const items = scan.items;
      // #864: a walk that stopped at the cap is a partial duplicate scan —
      // both the removals it planned and the "nothing to remove" verdict it
      // did NOT reach are only statements about the rows it actually read.
      const scanTruncated = scan.truncated;
      const scanCap = getConfig().fetchAllCap;
      const notice = walkTruncationNotice(items.length, scanCap, scanTruncated);

      const { ordered, groups } = collectDuplicateRemovals(items, args.include_relinked);

      const preview = ordered
        .slice(0, 20)
        .map((o) => `${o.label} @ position ${o.position} (${o.uri})`);
      const extra = {
        playlist_id: args.playlist_id,
        scanned: items.length,
        scan_truncated: scanTruncated,
        scan_cap: scanCap,
        duplicate_groups: groups,
        removable_items: ordered.length,
      };

      if (ordered.length === 0) {
        return textResult(
          notice
            ? `No duplicate item(s) among the first ${items.length} scanned item(s) — ${notice}`
            : `No duplicate item(s) found across ${items.length} scanned item(s) — nothing to remove.`,
          { ...extra, ok: true, removed: 0 },
        );
      }

      if (args.dry_run) {
        return textResult(
          describeDryRun(
            'remove duplicates from playlist',
            args.playlist_id,
            [
              `Would keep ${items.length - ordered.length} of ${items.length} item(s) and remove ${ordered.length}:`,
              ...preview,
              ...(ordered.length > preview.length ? [`(…and ${ordered.length - preview.length} more)`] : []),
              ...(notice ? [notice] : []),
            ],
          ),
          { ...extra, ok: true, dry_run: true },
        );
      }

      if (ordered.length >= REMOVE_ELICIT_THRESHOLD) {
        const verdict = await confirmViaElicitation(server, {
          message: describeConfirmation('remove duplicates from playlist', meta.name ?? args.playlist_id, [
            `Remove ${ordered.length} duplicate item(s), keeping the first occurrence of each:`,
            ...preview,
            ...(ordered.length > preview.length ? [`(…and ${ordered.length - preview.length} more)`] : []),
          ]),
        });
        // #1237: shared fail-closed guard — see the note on
        // remove_from_playlist above.
        const refusal = requiredConfirmationRefusal(verdict);
        if (refusal) return textResult(refusal.message, refusal.payload);
      }

      // One DELETE per occurrence, highest position first: each request sees
      // a playlist where lower indices are untouched, so original positions
      // stay valid without snapshot juggling.
      const itemsPath = `/playlists/${id}/items`;
      let lastSnapshotId: string | undefined;
      for (const occ of ordered) {
        const res = await client.delete<{ snapshot_id?: string }>(itemsPath, {
          tracks: [{ uri: occ.uri, positions: [occ.position] }],
        });
        if (res?.snapshot_id) lastSnapshotId = res.snapshot_id;
      }

      // Post-mutation re-scan proves the cleanup actually landed.
      const rescan = await client.getAllPagesWithTruncation<PlaylistItemObject>(`/playlists/${id}/items`, {
        limit: '100',
      });
      const after = rescan.items;
      // #864: the re-scan is a second capped walk. A truncated re-scan cannot
      // certify the playlist is clean, so it must not report "no duplicates
      // remain" — nor may the payload claim ok:true off the back of it.
      const rescanTruncated = rescan.truncated;
      const rescanNotice = walkTruncationNotice(after.length, scanCap, rescanTruncated);
      const seenUris = new Set<string>();
      let remainingExact = 0;
      const afterIdentity = new Map<string, Set<string>>();
      let remainingRelinkedGroups = 0;
      for (const item of after) {
        const track = item.item;
        if (!track?.uri) continue;
        if (seenUris.has(track.uri)) remainingExact++;
        seenUris.add(track.uri);
        const key = trackIdentityKey(track);
        const uris = afterIdentity.get(key);
        if (uris) {
          if (!uris.has(track.uri)) remainingRelinkedGroups++;
          uris.add(track.uri);
        } else {
          afterIdentity.set(key, new Set([track.uri]));
        }
      }
      const remainingDuplicates = args.include_relinked
        ? remainingExact + remainingRelinkedGroups
        : remainingExact;

      const verified = remainingDuplicates === 0;
      const rescanLine = rescanNotice
        ? `Re-scan INCOMPLETE: ${verified ? 'no duplicate(s) among the rows read' : `${remainingDuplicates} duplicate(s) REMAIN — investigate`} — ${rescanNotice}`
        : `Re-scan: ${verified ? 'no duplicates remain.' : `${remainingDuplicates} duplicate(s) REMAIN — investigate.`}`;
      const text = withSnapshot(
        `Removed ${ordered.length} duplicate item(s) from "${meta.name ?? args.playlist_id}" `
          + `(kept ${after.length} item(s)).`
          + `\n${batchSummary(ordered.length, ordered.map((o) => o.uri))}`
          + `\n${rescanLine}`,
        lastSnapshotId,
      );
      return textResult(text, {
        ...extra,
        // A truncated re-scan proves nothing about the rows past the cap, so
        // it is never reported as a verified clean result (#864).
        ok: verified && !rescanTruncated,
        removed: ordered.length,
        kept: after.length,
        remaining_duplicates: remainingDuplicates,
        rescan_truncated: rescanTruncated,
        snapshot_id: lastSnapshotId,
      });
    },
  );

  // clean_all_playlists (#171)
  // Batch cleanup across EVERY playlist in the account. Report-only by
  // default; apply=true executes keep-first/remove-rest per playlist after a
  // single global elicitation when the total crosses the bulk threshold.
  server.tool(
    'clean_all_playlists',
    'Scan every playlist in your library for duplicate items (repeated URIs, and on opt-in '
      + 'same-song copies under different URIs). Reports per-playlist findings by default; '
      + 'pass apply=true to remove them (keeps the first occurrence of each group). Bulk '
      + 'removals ask for one confirmation before anything is deleted.',
    {
      include_relinked: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Also count/collapse same-song entries under different URIs (relinks/remasters).',
        ),
      dry_run: DryRun.describe(
        'Preview only — when true, nothing is changed; when false via dry_run=false or apply=true, executes the cleanup',
      ),
      apply: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Deprecated alias for dry_run — prefer dry_run. false (default): report only. true: execute the cleanup '
            + 'across all playlists with duplicates. If both are given, dry_run wins.',
        ),
      ...sharedListFields,
    },
    async (args) => {
      // dry_run is the canonical flag; apply is a deprecated alias for backwards compat
      const rawDryRun = args.dry_run;
      const rawApply = args.apply;
      const effectiveApply = rawDryRun !== undefined ? !rawDryRun : !!rawApply;
      const effectiveDryRun = !effectiveApply;
      const listScan = await client.getAllPagesWithTruncation<SpotifyPlaylistSimple>('/me/playlists', {
        limit: '50',
      });
      const playlists = listScan.items;
      // #864: two independent ways this scan can come up short — the playlist
      // list itself hitting the cap, and each per-playlist item walk hitting
      // it. Both have to be reported, or "scanned 12 playlists — no
      // duplicates found" is a claim about a slice of the account.
      const playlistsTruncated = listScan.truncated;
      let truncatedPlaylists = 0;

      interface PlaylistFinding {
        id: string;
        name: string;
        owner: string;
        scanned: number;
        scan_truncated: boolean;
        duplicate_groups: number;
        removable_items: number;
        removals?: Array<{ uri: string; position: number }>; // apply mode only
      }

      const findings: PlaylistFinding[] = [];
      let totalRemovable = 0;
      let playlistsScanned = 0;
      for (const pl of playlists) {
        if (!pl?.id) continue;
        playlistsScanned++;
        const plScan = await client.getAllPagesWithTruncation<PlaylistItemObject>(
          `/playlists/${encodeURIComponent(pl.id)}/items`,
          { limit: '100' },
        );
        const items = plScan.items;
        const plTruncated = plScan.truncated;
        if (plTruncated) truncatedPlaylists++;
        const { ordered, groups } = collectDuplicateRemovals(items, args.include_relinked);
        totalRemovable += ordered.length;
        findings.push({
          id: pl.id,
          name: pl.name ?? '(unnamed)',
          owner: pl.owner?.display_name ?? 'unknown',
          scanned: items.length,
          scan_truncated: plTruncated,
          duplicate_groups: groups,
          removable_items: ordered.length,
          ...(effectiveApply && ordered.length > 0 ? { removals: ordered.map((o) => ({ uri: o.uri, position: o.position })) } : {}),
        });
      }

      const scanCap = getConfig().fetchAllCap;
      const scanTruncated = playlistsTruncated || truncatedPlaylists > 0;
      // One line naming every short walk, so the report below cannot be read
      // as a whole-account verdict when it was not one.
      const notice = scanTruncated
        ? [
          truncatedPlaylists > 0
            ? `${truncatedPlaylists} of ${playlistsScanned} playlist item walk(s) stopped at cap ${scanCap}`
            : null,
          playlistsTruncated
            ? `the /me/playlists walk stopped at cap ${scanCap} — playlists beyond it were never scanned`
            : null,
        ].filter((p): p is string => p !== null).join('; ')
          + ' — results are a lower bound; raise SPOTIFY_MCP_FETCH_ALL_CAP to scan the rest'
        : null;

      const dirty = findings.filter((f) => f.removable_items > 0);
      const view = truncateItems(dirty, resolveMaxResults(args.max_results));
      const pag = paginationInfo({ returned: view.items.length });
      const extra = {
        playlists_scanned: playlistsScanned,
        playlists_with_duplicates: dirty.length,
        total_removable_items: totalRemovable,
        applied: effectiveApply,
        scan_truncated: scanTruncated,
        truncated_playlists: truncatedPlaylists,
        playlists_truncated: playlistsTruncated,
        scan_cap: scanCap,
      };

      // "no duplicates found" is an account-wide verdict, so it only stands
      // when every walk in this scan reached the end of its data.
      const cleanVerdict = notice
        ? `Scanned ${playlistsScanned} playlist(s) — no duplicate item(s) among the rows read. Nothing to clean in what was scanned, but the scan was incomplete: ${notice}`
        : `Scanned ${playlistsScanned} playlist(s) — no duplicates found. Nothing to clean.`;

      const renderRow = (f: PlaylistFinding): string =>
        `• "${f.name}" (${f.owner}) — ${f.duplicate_groups} group(s), ${f.removable_items} removable of ${f.scanned}`
        + (f.scan_truncated ? ' [TRUNCATED]' : '');

      if (!effectiveApply) {
        if (dirty.length === 0) {
          return textResult(
            cleanVerdict,
            { ...extra, ok: true, results: findings },
          );
        }
        const lines = [
          `Scanned ${playlistsScanned} playlist(s); ${dirty.length} contain duplicates — ${totalRemovable} removable item(s):`,
          '',
          ...(notice ? [notice] : []),
          ...view.items.map(renderRow),
          ...(view.footer ? [view.footer] : []),
          '',
          args.include_relinked
            ? 'Report only — re-run with apply=true to remove these items (or dry_run=false).'
            : 'Report only — re-run with include_relinked=true to widen matching, or apply=true to remove (or dry_run=false).',
        ];
        return textResult(lines.join('\n'), listStructuredContent(view.items, pag, extra));
      }

      // Apply mode.
      if (dirty.length === 0) {
        return textResult(
          cleanVerdict,
          { ...extra, ok: true, removed_total: 0 },
        );
      }

      if (totalRemovable >= REMOVE_ELICIT_THRESHOLD) {
        const verdict = await confirmViaElicitation(server, {
          message: describeConfirmation('remove duplicates across playlists', `${playlistsScanned} playlists`, [
            `Remove ${totalRemovable} duplicate item(s) from ${dirty.length} playlist(s):`,
            ...view.items.slice(0, 10).map(renderRow),
            ...(dirty.length > 10 ? [`(…and ${dirty.length - 10} more playlists)`] : []),
          ]),
        });
        // #1237: shared fail-closed guard — see the note on
        // remove_from_playlist above. A server-wide sweep, so the refusal is
        // one result rather than a throw for a host that wants to branch.
        const refusal = requiredConfirmationRefusal(verdict);
        if (refusal) return textResult(refusal.message, refusal.payload);
      }

      let removedTotal = 0;
      let lastSnapshotId: string | undefined;
      for (const f of findings) {
        if (!f.removals || f.removals.length === 0) continue;
        const itemsPath = `/playlists/${encodeURIComponent(f.id)}/items`;
        for (const r of f.removals) {
          const res = await client.delete<{ snapshot_id?: string }>(itemsPath, {
            tracks: [{ uri: r.uri, positions: [r.position] }],
          });
          removedTotal++;
          if (res?.snapshot_id) lastSnapshotId = res.snapshot_id;
        }
      }

      const lines = [
        `Cleaned ${removedTotal} duplicate item(s) from ${dirty.length} playlist(s) `
          + `(scanned ${playlistsScanned} in total).`,
        ...view.items.map(renderRow),
        ...(notice ? [notice] : []),
        ...(view.footer ? [view.footer] : []),
      ];
      return textResult(withSnapshot(lines.join('\n'), lastSnapshotId), {
        ...extra,
        ok: true,
        removed_total: removedTotal,
        snapshot_id: lastSnapshotId,
      });
    },
  );

  // Helpers for new exhaustive playlist tools
  /**
   * A playlist's ordered item rows, plus how many rows the endpoint actually
   * returned. `rowCount` can exceed `uris.length`: Spotify returns
   * unavailable/local items with a null URI, and a URI-based replace cannot
   * put them back. Callers that decide whether a rewrite is destructive need
   * both numbers to avoid calling a lossy overwrite a no-op.
   *
   * #860: `unavailablePositions` names WHERE those rows are, 1-based, so a
   * caller about to replace the playlist can refuse before the PUT instead of
   * reporting an impact measured from the rows that survived the filter.
   */
  async function getPlaylistRows(playlistId: string, options: { limit?: number; scan_cap?: number } = {}): Promise<{ uris: string[]; rowCount: number; unavailablePositions: number[]; truncated: boolean }> {
    const cap = Math.min(options.scan_cap ?? getConfig().fetchAllCap, getConfig().fetchAllCap);
    const pageLimit = Math.min(options.limit ?? 100, 100);
    // One row past the cap is the only way to tell "exactly cap rows" (the
    // walk reached the end) from "more than cap rows" (it did not). A
    // `length >= cap` test reports truncation for a complete playlist and
    // raises a spurious destructive confirmation on every exact-cap source.
    const rows = await client.getAllPages<PlaylistItemObject>(`/playlists/${encodeURIComponent(playlistId)}/items`, { limit: String(pageLimit) }, { maxItems: cap + 1 });
    // Drop the probe row before anything else sees it: `uris` and `rowCount`
    // feed the union/subtract replacement set and the "rows without a URI"
    // count, so an extra row would make a destructive write carry one item
    // more than the cap the confirmation just quoted.
    const truncated = rows.length > cap;
    const kept = truncated ? rows.slice(0, cap) : rows;
    return {
      uris: kept.map(i => i.item?.uri).filter((u): u is string => !!u),
      rowCount: kept.length,
      unavailablePositions: unavailableRowPositions(kept),
      truncated,
    };
  }
  async function getAllUris(playlistId: string, options: { limit?: number; scan_cap?: number } = {}): Promise<string[]> {
    return (await getPlaylistRows(playlistId, options)).uris;
  }
  /**
   * How many rows Spotify says the playlist holds, or undefined when the
   * metadata read cannot tell us. The item walk is capped by fetchAllCap, so
   * this is how a caller proves its read reached the end of the playlist.
   *
   * Reads `items.total`, not `tracks.total`: the OpenAPI schema marks
   * PlaylistObject.tracks deprecated in favour of `items` (which is a
   * PagingPlaylistTrackObject, and PagingObject requires `total`).
   * `playlistItemTotal` is that precedence, in one shared place (#589).
   */
  async function getPlaylistRowTotal(playlistId: string): Promise<number | undefined> {
    const meta = await client.get<SpotifyPlaylistPage>(`/playlists/${encodeURIComponent(playlistId)}`);
    return playlistItemTotal(meta);
  }
  // #865: replaceWithUris is shared by the destructive-replace family
  // (sort / shuffle / reverse / union / subtract / trim). Until this fix a
  // mid-batch failure bubbled the thrown error up to the caller with no
  // chunk context. Now we return a partial-write failure and let each
  // caller render it in its own prose/structuredContent shape; the helper
  // surfaces every field the multi-chunk contract requires.
  //
  // #888 — what a full-content replace actually PROVED, not just what it sent.
  //
  // Replacing a playlist's contents with an empty `uris` array is the
  // documented way to CLEAR one, so the empty-array write stays: the OpenAPI
  // description for `reorder-or-replace-playlists-items` states "This
  // operation can be used for replacing or clearing items in a playlist", and
  // the request body's `uris` carries no `minItems`, so `{uris: []}` is a
  // schema-valid clear. Emulating it with a descending sweep of position-based
  // DELETEs would cost N requests instead of 1, leave a half-emptied playlist
  // if one failed, and contradict the endpoint's own documented semantics.
  //
  // What the schema does NOT guarantee is a RECEIPT. The 200 body is
  // `{snapshot_id: string}` with no `required` list, and `jsonOrNull`
  // (src/client.ts) returns null for a 204 or any non-JSON content-type — so
  // a clear can come back with nothing readable in it. A missing receipt is
  // not the same answer as "Spotify returned no snapshot", and on the empty
  // path the two are separated by every track in the playlist. So the ok:true
  // arm carries `receipt_read` and the empty callers report its own state
  // instead of coercing a null receipt under a flat ok:true — the same rule
  // #864 applied to a truncated re-scan.
  async function replaceWithUris(playlistId: string, uris: string[]): Promise<
    | { ok: true; snapshot_id: string | undefined; receipt_read: boolean }
    | ({ ok: false; partial_write_failure: true; playlist_id: string; attempted_uris: number; committed_uris: number; remaining_uris: number; attempted_chunks: number; failed_chunk_index: number; last_committed_chunk_index: number; last_committed_chunk_uris: string[]; error: string })
  > {
    const enc = encodeURIComponent(playlistId);
    const writeCap = capFor('playlist_writes');
    // An empty URI list is a single PUT (chunked path returns 0 chunks); the
    // empty-PUT branch is preserved exactly so trim/clear still emit one call.
    if (uris.length === 0) {
      try {
        const res = await client.put<{ snapshot_id?: string }>(`/playlists/${enc}/items`, { uris: [] });
        return { ok: true, snapshot_id: res?.snapshot_id, receipt_read: Boolean(res?.snapshot_id) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, partial_write_failure: true, playlist_id: playlistId, attempted_uris: 0, committed_uris: 0, remaining_uris: 0, attempted_chunks: 1, failed_chunk_index: 0, last_committed_chunk_index: -1, last_committed_chunk_uris: [], error: message };
      }
    }
    const write = await runChunkedPlaylistWrite(uris, writeCap, (chunk, chunkIndex) => {
      const body = { uris: chunk };
      return chunkIndex === 0
        ? client.put<{ snapshot_id?: string }>(`/playlists/${enc}/items`, body)
        : client.post<{ snapshot_id?: string }>(`/playlists/${enc}/items`, body);
    });
    if (!write.ok) {
      return { ...write, playlist_id: playlistId, attempted_uris: uris.length, remaining_uris: uris.length - write.committed_uris };
    }
    return { ok: true, snapshot_id: write.snapshot_id, receipt_read: Boolean(write.snapshot_id) };
  }

  // check_playlist_following (#284, fixed #862) — follow state via the
  // library-membership check, batched at the documented URI cap.
  //
  // #862: the old code read GET /playlists/{id}/followers/contains and coerced
  // every outcome — a rejected request included — into a confident
  // `following: false`. There is no follow-specific read left to migrate to:
  // the Feb 2026 changelog marks BOTH follow-contains routes REMOVED
  // (/playlists/{id}/followers/contains and /me/following/contains, replaced
  // by GET /me/library/contains), and GET /me/following pins its type to
  // artist|user, so `type=playlist` was never a legal value there. Following
  // a playlist IS library membership for that playlist, and
  // GET /me/library/contains accepts `spotify:playlist:<id>` and answers with
  // an order-preserving boolean array. A read that fails, or that comes back
  // without a verdict for an id, is reported as unreadable with its reason —
  // never as "not followed".
  server.tool('check_playlist_following', 'Check if you follow 1–50 playlists. Follow state: GET /me/library/contains?uris=spotify:playlist:<id>,… (40/req, 1–2 GETs). Unreadable state reports unknown, never not-followed.', { ...playlistListFields({ min: 1, max: 50, limitReason: 'follow state is read with batched GET /me/library/contains requests, not one paged walk per playlist' }), ...sharedListFields }, async (args) => {
    const input = resolvePlaylistInput(args, { kind: 'list', aliases: ['playlist_ids'] });
    // `following` is a tri-state on purpose: null means "we could not read
    // this", which is not the same answer as false (#862).
    const results: Array<{ playlist_id: string; following: boolean | null; error?: string }> = [];
    const ids = input.values;
    for (let i = 0; i < ids.length; i += LIBRARY_CONTAINS_CHUNK) {
      const batch = ids.slice(i, i + LIBRARY_CONTAINS_CHUNK);
      let verdicts: boolean[] | null = null;
      let failure: string | undefined;
      try {
        const r = await client.get<boolean[]>('/me/library/contains', { uris: batch.map((p) => `spotify:playlist:${p}`).join(',') });
        if (Array.isArray(r)) verdicts = r;
        else failure = 'Spotify returned no usable follow verdicts for this request';
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      }
      // Verdicts map back in INPUT order. A short/missing verdict is a failed
      // read, not a negative answer — coercing it to false is the #862 bug.
      results.push(...batch.map((pid, idx) => {
        if (failure !== undefined) return { playlist_id: pid, following: null, error: failure };
        const v = verdicts![idx];
        if (typeof v !== 'boolean') return { playlist_id: pid, following: null, error: `Spotify returned no follow verdict for this id (position ${idx} of ${batch.length})` };
        return { playlist_id: pid, following: v };
      }));
    }
    const t = truncateItems(results, resolveMaxResults(args.max_results));
    const pag = paginationInfo({ total: results.length, returned: t.items.length });
    const unreadable = results.filter(r => r.following === null).length;
    const payload = withPlaylistInputMetadata({ ...listStructuredContent(t.items, pag), playlists: input.values, results: t.items, unreadable_count: unreadable, total_is_partial: unreadable > 0 }, input);
    if (args.response_format === 'json') return textResult(jsonText(payload), payload);
    const lines = [`Playlist following (${results.length} checked, showing ${t.items.length}${unreadable ? `, ${unreadable} unreadable` : ''}):`];
    for (const r of t.items) lines.push(r.error ? `  ? ${r.playlist_id} — unreadable (${r.error})` : `  ${r.following ? '✓' : '✗'} ${r.playlist_id}`);
    if (t.footer) lines.push(`(${t.footer})`);
    if (unreadable) lines.push(`(${unreadable} of ${results.length} follow check(s) could not be read — their state is unknown, NOT "not followed".)`);
    return textResult(withPlaylistInputNote(lines.join('\n'), input), payload);
  });

  // clone_playlist_cover (#285)
  server.tool('clone_playlist_cover', 'Copy cover image from source playlist to target. Quota: GET images + PUT images (plus image fetch).', { source_playlist_id: PlaylistId.describe('Source playlist ID, URI, or URL'), target_playlist_id: PlaylistId.describe('Target playlist ID, URI, or URL'), image_index: z.number().int().min(0).optional().describe('Which cover image to copy (0-based). Default 0'), dry_run: DryRun }, async (args) => {
    const images = await client.get<SpotifyImage[]>(`/playlists/${encodeURIComponent(args.source_playlist_id)}/images`);
    if (!images || images.length === 0) throw new Error('Source playlist has no custom cover image');
    const idx = args.image_index ?? 0;
    if (idx >= images.length) throw new Error(`image_index ${idx} out of range (${images.length} image(s))`);
    const url = images[idx].url;
    if (args.dry_run) return textResult(describeDryRun('clone cover', args.target_playlist_id, [`Copy ${url} → ${args.target_playlist_id}`]));
    // Shared helper: validates content-type + JPEG magic bytes + 256 KB cap,
    // and uses fetchWithTimeout so a stalled CDN fails fast on timeout rather
    // than hanging the calling process (#880).
    const { buf } = await fetchCoverJpeg(url);
    const b64 = buf.toString('base64');
    await client.putRaw(`/playlists/${encodeURIComponent(args.target_playlist_id)}/images`, b64);
    return textResult(`Cloned cover from ${args.source_playlist_id} → ${args.target_playlist_id} (${Math.round(buf.length/1024)} KB)`);
  });

  // compare_playlist_covers (#286)
  server.tool('compare_playlist_covers', 'Compare two playlists covers: URL equality, dimensions. Quota: 2 GETs.', { ...PlaylistPairFields, ...PlaylistPairWalkFields, ...sharedListFields }, async (args) => {
    const input = resolvePlaylistInput(args, { kind: 'pair', aliases: [['playlist_id_a', 'playlist_id_b']] });
    const [playlistA, playlistB] = input.values;
    const [aImgs, bImgs] = await Promise.all([client.get<SpotifyImage[]>(`/playlists/${encodeURIComponent(playlistA)}/images`), client.get<SpotifyImage[]>(`/playlists/${encodeURIComponent(playlistB)}/images`)]);
    const a = aImgs?.[0] ?? null; const b = bImgs?.[0] ?? null;
    const sameUrl = a?.url === b?.url && !!a;
    const payload = withPlaylistInputMetadata({ playlist_a: playlistA, playlist_b: playlistB, a: a ?? null, b: b ?? null, same: sameUrl, a_has_custom: !!a, b_has_custom: !!b }, input);
    if (args.response_format === 'json') return textResult(jsonText(payload), payload);
    const lines = ['Cover comparison:'];
    lines.push(`  A (${playlistA}): ${a ? `${a.url} ${a.width}x${a.height}` : 'no custom cover (mosaic)'}`);
    lines.push(`  B (${playlistB}): ${b ? `${b.url} ${b.width}x${b.height}` : 'no custom cover (mosaic)'}`);
    lines.push(`  Same: ${sameUrl ? 'yes' : 'no'}`);
    return textResult(withPlaylistInputNote(lines.join('\n'), input), payload);
  });

  // get_playlist_snapshot (#295)
  server.tool('get_playlist_snapshot', 'Expose snapshot_id + item count for optimistic concurrency. Quota: 2 GETs.', { playlist_id: z.string().describe('Playlist ID, spotify:playlist: URI, or URL'), ...sharedListFields }, async (args) => {
    const id = encodeURIComponent(normalizePlaylistReference(args.playlist_id));
    const [meta, page] = await Promise.all([client.get<{ snapshot_id?: string; name?: string }>(`/playlists/${id}`), client.get<PlaylistItemsResponse>(`/playlists/${id}/items`, { limit: '1' })]);
    const payload = { playlist_id: args.playlist_id, snapshot_id: meta?.snapshot_id ?? null, total: page?.total ?? 0, name: meta?.name ?? null };
    if (args.response_format === 'json') return textResult(jsonText(payload), payload as unknown as Record<string, unknown>);
    return textResult(`Playlist ${args.playlist_id}: snapshot ${payload.snapshot_id ?? 'none'}, ${payload.total} item(s)`, payload as unknown as Record<string, unknown>);
  });

  // playlist_collab_toggle (#294)
  server.tool('playlist_collab_toggle', 'Toggle collaborative/public flags (guards public=true && collaborative=true 400). Quota: GET + PUT.', { playlist_id: z.string().describe('Playlist ID, spotify:playlist: URI, or URL'), collaborative: z.boolean().optional().describe('Target collaborative state for the playlist'), public: z.boolean().optional().describe('Target visibility: true makes the playlist public'), dry_run: DryRun }, async (args) => {
    if (args.collaborative === undefined && args.public === undefined) throw new Error('Provide at least one of collaborative or public');
    if (args.collaborative === true && args.public === true) throw new Error('A playlist cannot be both public and collaborative');
    const playlistId = normalizePlaylistReference(args.playlist_id);
    const body: Record<string, unknown> = {};
    if (args.collaborative !== undefined) body.collaborative = args.collaborative;
    if (args.public !== undefined) body.public = args.public;
    if (args.dry_run) return textResult(describeDryRun('collab toggle', playlistId, [JSON.stringify(body)]));
    // guard via GET to catch contradictory final state
    const current = await client.get<{ public?: boolean; collaborative?: boolean }>(`/playlists/${encodeURIComponent(playlistId)}`);
    const finalPublic = args.public !== undefined ? args.public : current?.public;
    const finalCollab = args.collaborative !== undefined ? args.collaborative : current?.collaborative;
    if (finalPublic === true && finalCollab === true) throw new Error('Result would be public=true && collaborative=true — Spotify rejects this');
    // #871: this tool performs the same toward-visible flip that
    // update_playlist gates for #157, so it goes through the same gate. Before
    // this, the sibling tool re-derived the final state inline and PUT anyway,
    // which made the #157 privacy guard bypassable by calling the other tool.
    // Direction, not size, decides: any flip that makes the playlist more
    // visible (private→public, or collaborative→true) elicits exactly once
    // against VISIBILITY_ELICIT_THRESHOLD; toward-private flips never prompt.
    // The current-state GET above is unconditional, so the delta is free here.
    const increasing = [
      ...(args.public === true && current?.public !== true
        ? [`public: ${visibilityLabel(current?.public)} → true`]
        : []),
      ...(args.collaborative === true && current?.collaborative !== true
        ? [`collaborative: ${visibilityLabel(current?.collaborative)} → true`]
        : []),
    ];
    if (increasing.length >= VISIBILITY_ELICIT_THRESHOLD) {
      const verdict = await confirmViaElicitation(server, {
        message: describeConfirmation('make playlist public', playlistId, increasing),
      });
      // Fails closed: declined, a mid-flight elicitation error, and a client
      // that cannot prompt all stop the write. Only explicit acceptance — or the
      // documented SPOTIFY_MCP_CONFIRM=never automation bypass — PUTs.
      const refusal = requiredConfirmationRefusal(verdict);
      if (refusal) return textResult(refusal.message, refusal.payload);
    }
    await client.put(`/playlists/${encodeURIComponent(playlistId)}`, body);
    return textResult(`Playlist ${playlistId} updated: ${JSON.stringify(body)}`);
  });

  // playlist_sort (#287)
  server.tool('playlist_sort', 'Sort a playlist in place by added_at/name/artist/duration. Quota: GET all + PUT/POST. popularity is not a sort key: the API no longer returns it on playlist items.', { playlist_id: z.string().describe('Playlist ID, spotify:playlist: URI, or URL'), sort_by: z.enum(['added_asc','added_desc','name_asc','name_desc','artist_asc','duration_asc','duration_desc']).default('name_asc').describe('Sort key applied to the playlist'), dry_run: DryRun, ...sharedListFields }, async (args) => {
    const playlistId = normalizePlaylistReference(args.playlist_id);
    const items = await client.getAllPages<PlaylistItemObject>(`/playlists/${encodeURIComponent(playlistId)}/items`, { limit: '100' }, { maxItems: getConfig().fetchAllCap });
    const entries = items.map((row, idx) => ({ uri: row.item?.uri ?? '', name: (row.item as SpotifyTrack | undefined)?.name ?? '', artist: ((row.item as SpotifyTrack | undefined)?.artists?.[0]?.name ?? ''), duration: (row.item as SpotifyTrack | undefined)?.duration_ms ?? 0, added: row.added_at, idx })).filter(e => !!e.uri);
    const keyOf = (e: (typeof entries)[number]): string | number => {
      switch (args.sort_by) {
        case 'added_asc':
        case 'added_desc': return e.added ?? '';
        case 'artist_asc': return e.artist;
        case 'duration_asc':
        case 'duration_desc': return e.duration;
        default: return e.name;
      }
    };
    const keyed = entries.map((e) => ({ e, k: keyOf(e) }));
    // #861: the commit path is a full destructive replace, so a key every row
    // shares — any field the API stopped returning collapses to one value —
    // cannot move a single item. Compare before the write: afterwards the
    // playlist has been rewritten to its own order and the tool would still
    // report a sort that never happened.
    const distinct = new Set(keyed.map(({ k }) => `${typeof k}:${k}`));
    if (entries.length > 1 && distinct.size <= 1) {
      return textResult(
        `Refused to sort ${playlistId} by ${args.sort_by}: no comparable values — all ${entries.length} item(s) share the same ${args.sort_by} value, so the sort would not change the order. Nothing was changed.`,
        { ok: false, reason: 'no_comparable_values', playlist: playlistId, sort_by: args.sort_by, items: entries.length, distinct_values: distinct.size, changed: false, dry_run: args.dry_run },
      );
    }
    const sign = args.sort_by.endsWith('_desc') ? -1 : 1;
    const sorted = keyed.sort((a, b) => (typeof a.k === 'number' && typeof b.k === 'number' ? sign * (a.k - b.k) : sign * String(a.k).localeCompare(String(b.k)))).map(x => x.e);
    const uris = sorted.map(e=>e.uri);
    // #860: `entries` dropped every row with no URI, so the sorted list is
    // already lossy — the first PUT below would delete those rows from the
    // live playlist. Refuse before the write, not after. The plan still
    // renders, with the refusal appended, so a preview is never blocked and
    // never promises a commit that will be refused.
    const unavailable = unavailableRowPositions(items);
    if (args.dry_run) return textResult(planWithNotice(describeDryRun('sort playlist', playlistId, [`Would sort ${uris.length} items by ${args.sort_by}`, ...uris.slice(0,5)]), unavailableRowNotice(playlistId, unavailable, { remedy: UNAVAILABLE_REMEDY })));
    assertPlaylistRewritable(playlistId, unavailable, { remedy: UNAVAILABLE_REMEDY });
    const write = await replaceWithUris(playlistId, uris);
    if (!write.ok) {
      const lastUri = write.last_committed_chunk_uris[write.last_committed_chunk_uris.length - 1];
      const prose = write.failed_chunk_index === 0
        ? `Sort aborted before any URI landed on playlist ${playlistId}: ${write.error}. Nothing was changed.`
        : `Partial sort on playlist ${playlistId}: chunk 0 sorted ${write.last_committed_chunk_uris.length} URI(s) atomically, chunks 1–${write.failed_chunk_index} appended the rest, chunk ${write.failed_chunk_index + 1} of ${write.attempted_chunks} failed.${lastUri ? ` Last URI committed: ${lastUri}.` : ''} Retry the remaining ${write.remaining_uris} URI(s); the playlist currently holds the committed prefix. (${write.error})`;
      return textResult(prose, write);
    }
    return textResult(withSnapshot(`Sorted ${uris.length} item(s) by ${args.sort_by}`, write.snapshot_id));
  });

  // playlist_shuffle (#288)
  server.tool('playlist_shuffle', 'Fisher-Yates shuffle a playlist (seeded optional). Quota: GET all + PUT/POST.', { playlist_id: z.string().describe('Playlist ID, spotify:playlist: URI, or URL'), seed: z.string().optional().describe('Deterministic shuffle seed; omit for a random order'), dry_run: DryRun }, async (args) => {
    const playlistId = normalizePlaylistReference(args.playlist_id);
    const { uris, unavailablePositions, truncated } = await getPlaylistRows(playlistId);
    let shuffled = [...uris];
    let rng = Math.random;
    if (args.seed) { let h = 0; for (let i=0;i<args.seed.length;i++) h = (h*31 + args.seed.charCodeAt(i))>>>0; let s=h; rng = () => { s = (s*1664525+1013904223)>>>0; return s/0x100000000; }; }
    for (let i=shuffled.length-1;i>0;i--){ const j=Math.floor(rng()*(i+1)); [shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]]; }
    if (args.dry_run) return textResult(planWithNotice(describeDryRun('shuffle playlist', playlistId, [`Would shuffle ${uris.length} items`, ...shuffled.slice(0,5)]), unavailableRowNotice(playlistId, unavailablePositions, { truncated, remedy: UNAVAILABLE_REMEDY })));
    assertPlaylistRewritable(playlistId, unavailablePositions, { truncated, remedy: UNAVAILABLE_REMEDY });
    const write = await replaceWithUris(playlistId, shuffled);
    if (!write.ok) {
      const lastUri = write.last_committed_chunk_uris[write.last_committed_chunk_uris.length - 1];
      const prose = write.failed_chunk_index === 0
        ? `Shuffle aborted before any URI landed on playlist ${playlistId}: ${write.error}. Nothing was changed.`
        : `Partial shuffle on playlist ${playlistId}: chunk 0 replaced ${write.last_committed_chunk_uris.length} URI(s) atomically, chunks 1–${write.failed_chunk_index} appended the rest, chunk ${write.failed_chunk_index + 1} of ${write.attempted_chunks} failed.${lastUri ? ` Last URI committed: ${lastUri}.` : ''} Retry the remaining ${write.remaining_uris} URI(s); the playlist currently holds the committed prefix. (${write.error})`;
      return textResult(prose, write);
    }
    return textResult(withSnapshot(`Shuffled ${shuffled.length} item(s)`, write.snapshot_id));
  });

  // playlist_reverse (#289)
  server.tool('playlist_reverse', 'Reverse a playlist in one atomic replace. Quota: GET all + PUT/POST.', { playlist_id: z.string().describe('Playlist ID, spotify:playlist: URI, or URL'), dry_run: DryRun }, async (args) => {
    const playlistId = normalizePlaylistReference(args.playlist_id);
    const { uris, unavailablePositions, truncated } = await getPlaylistRows(playlistId);
    const rev = [...uris].reverse();
    if (args.dry_run) return textResult(planWithNotice(describeDryRun('reverse playlist', playlistId, [`Would reverse ${uris.length} items`]), unavailableRowNotice(playlistId, unavailablePositions, { truncated, remedy: UNAVAILABLE_REMEDY })));
    assertPlaylistRewritable(playlistId, unavailablePositions, { truncated, remedy: UNAVAILABLE_REMEDY });
    const write = await replaceWithUris(playlistId, rev);
    if (!write.ok) {
      const lastUri = write.last_committed_chunk_uris[write.last_committed_chunk_uris.length - 1];
      const prose = write.failed_chunk_index === 0
        ? `Reverse aborted before any URI landed on playlist ${playlistId}: ${write.error}. Nothing was changed.`
        : `Partial reverse on playlist ${playlistId}: chunk 0 reversed ${write.last_committed_chunk_uris.length} URI(s) atomically, chunks 1–${write.failed_chunk_index} appended the rest, chunk ${write.failed_chunk_index + 1} of ${write.attempted_chunks} failed.${lastUri ? ` Last URI committed: ${lastUri}.` : ''} Retry the remaining ${write.remaining_uris} URI(s); the playlist currently holds the committed prefix. (${write.error})`;
      return textResult(prose, write);
    }
    return textResult(withSnapshot(`Reversed ${rev.length} item(s)`, write.snapshot_id));
  });

  // playlist_union (#290)
  server.tool('playlist_union', 'Union of 2–10 playlists into target (deduped, first-seen order). An empty union empties the target the same way subtract does. Quota: N GETs + PUT/POST; replacing an existing target also reads its current items and its playlist metadata to measure the destructive impact.', { ...PlaylistListFields, ...TargetPlaylistFields, ...PlaylistSetWalkFields, response_format: ResponseFormat, dedupe: z.boolean().default(true).describe('Drop duplicate URIs across the merged sources. Default true'), dry_run: DryRun }, async (args) => {
    const input = resolvePlaylistInput(args, { kind: 'list', aliases: ['source_playlist_ids'] });
    if ((args.target_playlist_id === undefined) === (args.target_name === undefined)) {
      throw new Error('Invalid arguments: provide exactly one of target_playlist_id (replace an existing playlist) or target_name (create a new playlist).');
    }
    const creatingNew = args.target_name !== undefined;
    const seen = new Set<string>(); const union: string[] = []; let sourceTruncated = false;
    for (const pid of input.values){ const source = await getPlaylistRows(pid, args); sourceTruncated ||= source.truncated; for (const u of source.uris) if (!args.dedupe || !seen.has(u)){ seen.add(u); union.push(u); } }
    let target: { uris: string[]; rowCount: number; unavailablePositions: number[]; truncated: boolean } | undefined;
    let targetImpact: ReplacementImpact | undefined;
    let targetUnrepresentable = 0;
    let targetReadWhole = true;
    let targetTotal: number | undefined;
    if (args.target_playlist_id) {
      target = await getPlaylistRows(args.target_playlist_id, args);
      targetImpact = replacementImpact(target.uris, union);
      targetUnrepresentable = target.rowCount - target.uris.length;
      targetTotal = await getPlaylistRowTotal(args.target_playlist_id);
      targetReadWhole = targetTotal === target.rowCount;
    }
    // Render cap, computed once: every payload below returns at most this many URIs.
    const unionView = truncateItems(union, resolveMaxResults(args.max_results));
    const destructive = sourceTruncated || (targetImpact !== undefined && (!targetImpact.identical || targetUnrepresentable > 0 || !targetReadWhole));
    // The dry-run preview must predict the prompt the apply path would really
    // raise: an identical, fully read target answers without prompting, and a
    // new target (target_name) prompts about nothing because it destroys no
    // existing rows. `destructive` alone overstates both cases.
    const identicalNoOp = target !== undefined && targetImpact !== undefined
      && targetImpact.identical && targetReadWhole && targetUnrepresentable === 0 && !sourceTruncated;
    const wouldConfirm = !identicalNoOp && destructive && target !== undefined && targetImpact !== undefined;
    // #860: a target holding rows with no URI is refused outright rather than
    // confirmed, so the preview has to say THAT — "would_confirm: true" for a
    // commit the apply path throws on is the same false claim in a new place.
    const refuseNotice = target
      ? unavailableRowNotice(args.target_playlist_id!, target.unavailablePositions, { truncated: target.truncated, remedy: UNAVAILABLE_REMEDY })
      : null;
    if (args.dry_run) {
      const impactNote = targetImpact
        ? `; target impact: ${targetImpact.removed} removed, ${targetImpact.added} added${targetImpact.reordered ? ', reordered' : ''}`
        : '';
      const text = planWithNotice(describeDryRun('union playlists', args.target_playlist_id ?? args.target_name!, [`Would union ${union.length} uri(s) from ${input.values.length} playlists${impactNote}${sourceTruncated ? `; source walk reached the configured cap of ${effectiveScanCap(args)} rows; totals may be incomplete` : ''}`]), refuseNotice);
      const payload = withPlaylistInputMetadata({
        ok: true,
        dry_run: true,
        playlists: input.values,
        uri_count: union.length,
        total: union.length,
        returned: unionView.items.length,
        uris: unionView.items,
        limit: args.limit ?? null,
        scan_cap: effectiveScanCap(args),
        target_existing_rows: target?.rowCount ?? 0,
        target_unrepresentable: targetUnrepresentable,
        target_read_whole: targetReadWhole,
        source_truncated: sourceTruncated,
        would_confirm: refuseNotice === null && wouldConfirm,
        would_refuse: refuseNotice !== null,
        impact: targetImpact,
      }, input);
      return textResult(args.response_format === 'json' ? jsonText(payload) : withPlaylistInputNote(text, input), payload);
    }
    // Refuse before the prompt: an operator who approves "drop 3 items" has
    // still lost the rows, and the request to delete them is a decision worth
    // taking deliberately with a tool that deletes rows.
    if (refuseNotice !== null) throw new Error(refuseNotice);
    // A provably identical, fully read target is a no-op: prompting "replace
    // N items" and then changing nothing is a lie, so that case answers
    // before the prompt. A truncated source walk can never prove it, so it
    // keeps prompting and keeps writing.
    if (identicalNoOp) {
      const payload = withPlaylistInputMetadata({
        ok: true,
        unchanged: true,
        dry_run: false,
        target_playlist: args.target_playlist_id!,
        target_playlist_id: args.target_playlist_id!,
        playlists: input.values,
        uri_count: union.length,
        total: union.length,
        returned: unionView.items.length,
        uris: unionView.items,
        created: false,
        limit: args.limit ?? null,
        scan_cap: effectiveScanCap(args),
        source_truncated: sourceTruncated,
      }, input);
      return textResult(args.response_format === 'json' ? jsonText(payload) : withPlaylistInputNote(`Union target already contains all ${union.length} URI(s); nothing was changed.`, input), payload);
    }
    if (wouldConfirm && target && targetImpact) {
      const changes = [
        `Replace ${target.rowCount} existing item(s) with ${union.length} unioned URI(s) from ${input.values.length} playlist(s).`,
      ];
      if (targetImpact.removed > 0) changes.push(`Remove ${targetImpact.removed} existing item(s) absent from the union.`);
      if (targetImpact.reordered) changes.push(`Reorder ${target.uris.length} item(s): the union reorders the rows already there.`);
      if (targetImpact.added > 0) changes.push(`Add ${targetImpact.added} new item(s).`);
      // No "drop the rows with no URI" line: #860 refuses the call before this
      // prompt is built, so there is nothing here that can arrive with one.
      if (!targetReadWhole) changes.push(`Only ${target.rowCount} of ${targetTotal ?? 'an unknown number of'} existing row(s) could be read, so the true impact may be larger.`);
      // The impact above was measured against a union that may be missing rows.
      // Without this the operator is shown a definitive-looking set difference
      // computed from a partial read — the one case where the prompt is the
      // only place the incompleteness can still be disclosed.
      if (sourceTruncated) changes.push(`Source walk reached the configured cap of ${effectiveScanCap(args)} rows; the union is incomplete, so items missing from it would be removed.`);
      const verdict = await confirmViaElicitation(server, {
        message: describeConfirmation('replace playlist items', args.target_playlist_id!, changes),
      });
      const refusal = requiredConfirmationRefusal(verdict);
      if (refusal) {
        const payload = withPlaylistInputMetadata(refusal.payload, input);
        return textResult(args.response_format === 'json' ? jsonText(payload) : withPlaylistInputNote(refusal.message, input), payload);
      }
    }
    let targetId = args.target_playlist_id;
    if (args.target_playlist_id && target && targetImpact) {
      const latest = await getPlaylistRows(args.target_playlist_id, args);
      const latestImpact = replacementImpact(latest.uris, union);
      const latestUnrepresentable = latest.rowCount - latest.uris.length;
      const latestTotal = await getPlaylistRowTotal(args.target_playlist_id);
      const latestReadWhole = latestTotal === latest.rowCount;
      if (latest.rowCount !== target.rowCount || latestUnrepresentable !== targetUnrepresentable || latestReadWhole !== targetReadWhole
        || latestImpact.identical !== targetImpact.identical || latestImpact.removed !== targetImpact.removed
        || latestImpact.added !== targetImpact.added || latestImpact.reordered !== targetImpact.reordered
        || latest.uris.join('\n') !== target.uris.join('\n')) {
        throw new Error('target playlist changed during union; re-run to review the new destructive impact');
      }
    }
    if (!targetId){ const created = await client.post<{id:string}>(`/me/playlists`, { name: args.target_name, public: false }); if(!created?.id) throw new Error('Could not create playlist'); targetId = created.id; }
    const write = await replaceWithUris(targetId!, union);
    if (!write.ok) {
      const lastUri = write.last_committed_chunk_uris[write.last_committed_chunk_uris.length - 1];
      const prose = write.failed_chunk_index === 0
        ? `Union aborted before any URI landed on playlist ${targetId}: ${write.error}. Nothing was changed.`
        : `Partial union on playlist ${targetId}: chunk 0 replaced ${write.last_committed_chunk_uris.length} URI(s) atomically, chunks 1–${write.failed_chunk_index} appended the rest, chunk ${write.failed_chunk_index + 1} of ${write.attempted_chunks} failed.${lastUri ? ` Last URI committed: ${lastUri}.` : ''} Retry the remaining ${write.remaining_uris} URI(s); the playlist currently holds the committed prefix. (${write.error})`;
      return textResult(args.response_format === 'json' ? jsonText(write) : withPlaylistInputNote(prose, input), withPlaylistInputMetadata(write, input));
    }
    const snap = write.snapshot_id;
    // #888: an empty union clears the target. An unread receipt there is a
    // playlist wiped with nothing to show for it, so it is reported as its own
    // state rather than a clean ok:true over a null receipt.
    const emptied = union.length === 0;
    const unconfirmed = emptied && !write.receipt_read;
    const payload = withPlaylistInputMetadata({
      ok: !unconfirmed,
      target_playlist: targetId,
      target_playlist_id: targetId,
      target_name: args.target_name ?? null,
      playlists: input.values,
      uri_count: union.length,
      total: union.length,
      returned: unionView.items.length,
      uris: unionView.items,
      created: creatingNew,
      limit: args.limit ?? null,
      scan_cap: effectiveScanCap(args),
      source_truncated: sourceTruncated,
      snapshot_id: snap ?? null,
      emptied,
      ...(unconfirmed ? { reason: 'clear_unconfirmed', snapshot_read: false } : {}),
    }, input);
    const unionText = emptied
      ? unconfirmed
        ? `Emptied ${targetId}: the clear was sent but Spotify returned no snapshot_id, so the result is unconfirmed — re-read the playlist before treating it as cleared.`
        : `Emptied ${targetId}`
      : `Union ${union.length} item(s) → ${targetId}`;
    return textResult(args.response_format === 'json' ? jsonText(payload) : withPlaylistInputNote(unconfirmed ? unionText : withSnapshot(unionText, snap), input), payload);
  });

  // playlist_subtract (#291)
  server.tool('playlist_subtract', 'Remove tracks of B..N from A. Subtracting every track empties A via one PUT with an empty uris array (Spotify\'s documented clear); a reply with no snapshot_id reports unconfirmed, not ok. Quota: N GETs + PUT.', { base_playlist_id: PlaylistId.describe('Base playlist ID, URI, or URL. Required; list only the subtraction sources in playlists.'), ...playlistListFields({ min: 1, max: 10, limitReason: PAGED_WALK_LIST_REASON }), ...PlaylistSetWalkFields, response_format: ResponseFormat, dry_run: DryRun }, async (args) => {
    const input = resolvePlaylistInput(args, { kind: 'list', aliases: ['subtract_playlist_ids'] });
    // #1287: the pre-2.0 positional form (`playlists: [A, B, C]` meaning
    // "A minus B and C") was on the same removal schedule as the alias names and
    // has gone with them. `base_playlist_id` is now required rather than
    // optional, so the schema itself refuses an omitted base instead of the
    // handler guessing which playlist was meant.
    const basePlaylistId = normalizePlaylistReference(args.base_playlist_id);
    const subtractValues = input.values;
    if (subtractValues.some((pid) => normalizePlaylistReference(pid) === basePlaylistId)) {
      throw new Error('Invalid arguments: the subtraction sources must not include the base playlist.');
    }
    const base = await getPlaylistRows(basePlaylistId, args);
    const subtractSet = new Set<string>();
    let sourceTruncated = false;
    for (const pid of subtractValues){ const source = await getPlaylistRows(pid, args); sourceTruncated ||= source.truncated; for (const u of source.uris) subtractSet.add(u); }
    const remaining = base.uris.filter(u => !subtractSet.has(u));
    const removedUris = base.uris.filter((uri) => subtractSet.has(uri));
    const impact = replacementImpact(base.uris, remaining);
    const removed = impact.removed;
    const unrepresentable = base.rowCount - base.uris.length;
    const total = await getPlaylistRowTotal(basePlaylistId);
    const readWholePlaylist = total === base.rowCount;
    // Render caps, computed once: a subtraction can carry both halves of a
    // large playlist, so both arrays are bounded independently.
    const removedView = truncateItems(removedUris, resolveMaxResults(args.max_results));
    const keptView = truncateItems(remaining, resolveMaxResults(args.max_results));
    const destructive = sourceTruncated || !impact.identical || unrepresentable > 0 || !readWholePlaylist;
    // #860: same contract as the union target — a base holding rows with no
    // URI is refused, not confirmed, so the preview must say so rather than
    // promising a prompt.
    const refuseNotice = unavailableRowNotice(basePlaylistId, base.unavailablePositions, { truncated: base.truncated, remedy: UNAVAILABLE_REMEDY });
    if (args.dry_run) {
      const text = planWithNotice(describeDryRun('subtract playlists', basePlaylistId, [`Would remove ${removed} item(s), keep ${remaining.length}${sourceTruncated ? `; source walk reached the configured cap of ${effectiveScanCap(args)} rows; totals may be incomplete` : ''}`]), refuseNotice);
      const payload = withPlaylistInputMetadata({
        ok: true,
        dry_run: true,
        base_playlist: basePlaylistId,
        playlist_a: basePlaylistId,
        playlists: subtractValues,
        removed: removedView.items.length,
        removed_total: removed,
        removed_uris: removedView.items,
        kept: keptView.items.length,
        kept_total: remaining.length,
        uris: keptView.items,
        limit: args.limit ?? null,
        scan_cap: effectiveScanCap(args),
        base_existing_rows: base.rowCount,
        base_unrepresentable: unrepresentable,
        base_read_whole: readWholePlaylist,
        source_truncated: sourceTruncated,
        would_confirm: refuseNotice === null && destructive,
        would_refuse: refuseNotice !== null,
        impact,
      }, input);
      return textResult(args.response_format === 'json' ? jsonText(payload) : withPlaylistInputNote(text, input), payload);
    }
    // Refuse before the prompt, for the reason in the union path: approving a
    // described loss still loses the rows.
    if (refuseNotice !== null) throw new Error(refuseNotice);
    if (destructive) {
      const changes = [
        `Overwrite ALL ${base.rowCount} existing item(s) with ${remaining.length} URI(s), removing ${removed} URI(s) from subtraction sources.`,
      ];
      if (sourceTruncated) changes.push(`Source walk reached the configured cap of ${effectiveScanCap(args)} rows; the removal set may be incomplete.`);
      // No "drop the rows with no URI" line: #860 refuses above, so a prompt
      // can no longer arrive carrying one.
      if (!readWholePlaylist) changes.push(`Only ${base.rowCount} of ${total ?? 'an unknown number of'} existing row(s) could be read, so the true impact may be larger.`);
      const verdict = await confirmViaElicitation(server, {
        message: describeConfirmation('replace playlist items', basePlaylistId, changes),
      });
      const refusal = requiredConfirmationRefusal(verdict);
      if (refusal) {
        // The refusal is the path a headless legacy caller hits first, and it is
        // exactly when the positional note matters most — so it rides along.
        const payload = withPlaylistInputMetadata(refusal.payload, input);
        return textResult(args.response_format === 'json' ? jsonText(payload) : withPlaylistInputNote(refusal.message, input), payload);
      }
    }
    if (!destructive && impact.identical && readWholePlaylist && unrepresentable === 0) {
      const payload = withPlaylistInputMetadata({
        ok: true,
        unchanged: true,
        dry_run: false,
        base_playlist: basePlaylistId,
        playlist_a: basePlaylistId,
        playlists: subtractValues,
        removed: 0,
        removed_total: 0,
        removed_uris: [],
        kept: keptView.items.length,
        kept_total: remaining.length,
        uris: keptView.items,
        limit: args.limit ?? null,
        scan_cap: effectiveScanCap(args),
        source_truncated: false,
      }, input);
      return textResult(args.response_format === 'json' ? jsonText(payload) : withPlaylistInputNote('Subtraction sources remove nothing; the playlist was not changed.', input), payload);
    }
    const latestBase = await getPlaylistRows(basePlaylistId, args);
    const latestImpact = replacementImpact(latestBase.uris, remaining);
    const latestTotal = await getPlaylistRowTotal(basePlaylistId);
    const latestReadWhole = latestTotal === latestBase.rowCount;
    if (latestBase.rowCount !== base.rowCount || latestBase.uris.length !== base.uris.length || latestBase.uris.join('\n') !== base.uris.join('\n') || latestReadWhole !== readWholePlaylist || latestImpact.removed !== removed) {
      throw new Error('base playlist changed during subtract; re-run to review the new destructive impact');
    }
    const write = await replaceWithUris(basePlaylistId, remaining);
    if (!write.ok) {
      const lastUri = write.last_committed_chunk_uris[write.last_committed_chunk_uris.length - 1];
      const prose = write.failed_chunk_index === 0
        ? `Subtract aborted before any URI landed on playlist ${basePlaylistId}: ${write.error}. Nothing was changed.`
        : `Partial subtract on playlist ${basePlaylistId}: chunk 0 replaced ${write.last_committed_chunk_uris.length} URI(s) atomically, chunks 1–${write.failed_chunk_index} appended the rest, chunk ${write.failed_chunk_index + 1} of ${write.attempted_chunks} failed.${lastUri ? ` Last URI committed: ${lastUri}.` : ''} Retry the remaining ${write.remaining_uris} URI(s); the playlist currently holds the committed prefix. (${write.error})`;
      return textResult(args.response_format === 'json' ? jsonText(write) : withPlaylistInputNote(prose, input), withPlaylistInputMetadata(write, input));
    }
    const snap = write.snapshot_id;
    // #888: subtracting every track empties the base. The empty-uris PUT is
    // the documented clear (see replaceWithUris), so it is still sent — but a
    // clear with no readable receipt is a wiped playlist we cannot show a
    // receipt for, and it is reported as unconfirmed rather than as a clean
    // ok:true over a null snapshot.
    const emptied = remaining.length === 0;
    const unconfirmed = emptied && !write.receipt_read;
    const payload = withPlaylistInputMetadata({
      ok: !unconfirmed,
      base_playlist: basePlaylistId,
      playlist_a: basePlaylistId,
      playlists: subtractValues,
      removed: removedView.items.length,
      removed_total: removed,
      removed_uris: removedView.items,
      kept: keptView.items.length,
      kept_total: remaining.length,
      uris: keptView.items,
      source_truncated: sourceTruncated,
      limit: args.limit ?? null,
      scan_cap: effectiveScanCap(args),
      snapshot_id: snap ?? null,
      emptied,
      ...(unconfirmed ? { reason: 'clear_unconfirmed', snapshot_read: false } : {}),
    }, input);
    const subtractText = emptied
      ? unconfirmed
        ? `Playlist emptied: removed ${removed}, but Spotify returned no snapshot_id, so the clear is unconfirmed — re-read the playlist before treating it as empty.`
        : `Playlist emptied: removed ${removed}`
      : `Subtract: removed ${removed}, kept ${remaining.length}`;
    return textResult(args.response_format === 'json' ? jsonText(payload) : withPlaylistInputNote(unconfirmed ? subtractText : withSnapshot(subtractText, snap), input), payload);
  });

  // playlist_symmetric_difference (#292)
  server.tool('playlist_symmetric_difference', 'Tracks in exactly one of two playlists (XOR). Quota: 2 GETs.', { ...PlaylistPairFields, ...PlaylistPairWalkFields, ...sharedListFields }, async (args) => {
    const input = resolvePlaylistInput(args, { kind: 'pair', aliases: [['playlist_id_a', 'playlist_id_b']] });
    const [playlistA, playlistB] = input.values;
    const [aUris, bUris] = await Promise.all([getAllUris(playlistA, args), getAllUris(playlistB, args)]);
    const setA = new Set(aUris); const setB = new Set(bUris);
    const sym = [...aUris.filter(u=>!setB.has(u)), ...bUris.filter(u=>!setA.has(u))];
    const uniq = [...new Set(sym)];
    const view = truncateItems(uniq, resolveMaxResults(args.max_results));
    const pag = paginationInfo({ total: uniq.length, returned: view.items.length });
    const payload = withPlaylistInputMetadata(listStructuredContent(view.items, pag, { playlist_a: playlistA, playlist_b: playlistB, symmetric_difference: view.items, total: uniq.length }), input);
    if (args.response_format === 'json') return textResult(jsonText(payload), payload);
    const lines = [`Symmetric difference: ${uniq.length} uri(s) (showing ${view.items.length}):`];
    for (const u of view.items) lines.push(`  • ${u}`);
    if (view.footer) lines.push(`(${view.footer})`);
    return textResult(withPlaylistInputNote(lines.join('\n'), input), payload);
  });

  // playlist_trim (#293)
  server.tool('playlist_trim', 'Trim playlist to N items (keep first/last/random). Quota: GET all + PUT/POST.', { playlist_id: z.string().describe('Playlist ID, spotify:playlist: URI, or URL'), keep: z.number().int().min(1).max(500).describe('How many items to keep'), keep_which: z.enum(['first','last','random']).default('first').describe('Which end of the playlist to keep items from. Default first'), dry_run: DryRun }, async (args) => {
    const playlistId = normalizePlaylistReference(args.playlist_id);
    const { uris, unavailablePositions, truncated } = await getPlaylistRows(playlistId);
    if (uris.length <= args.keep) return textResult(`Playlist already ${uris.length} ≤ ${args.keep} — nothing to trim`);
    let kept: string[];
    if (args.keep_which === 'first') kept = uris.slice(0, args.keep);
    else if (args.keep_which === 'last') kept = uris.slice(-args.keep);
    else { const shuffled=[...uris]; for(let i=shuffled.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];} kept=shuffled.slice(0,args.keep); }
    if (args.dry_run) return textResult(planWithNotice(describeDryRun('trim playlist', playlistId, [`Would trim ${uris.length} → ${kept.length} (${args.keep_which})`]), unavailableRowNotice(playlistId, unavailablePositions, { truncated, remedy: UNAVAILABLE_REMEDY })));
    assertPlaylistRewritable(playlistId, unavailablePositions, { truncated, remedy: UNAVAILABLE_REMEDY });
    const write = await replaceWithUris(playlistId, kept);
    if (!write.ok) {
      const lastUri = write.last_committed_chunk_uris[write.last_committed_chunk_uris.length - 1];
      const prose = write.failed_chunk_index === 0
        ? `Trim aborted before any URI landed on playlist ${playlistId}: ${write.error}. Nothing was changed.`
        : `Partial trim on playlist ${playlistId}: chunk 0 replaced ${write.last_committed_chunk_uris.length} URI(s) atomically, chunks 1–${write.failed_chunk_index} appended the rest, chunk ${write.failed_chunk_index + 1} of ${write.attempted_chunks} failed.${lastUri ? ` Last URI committed: ${lastUri}.` : ''} Retry the remaining ${write.remaining_uris} URI(s); the playlist currently holds the committed prefix. (${write.error})`;
      return textResult(prose, write);
    }
    return textResult(withSnapshot(`Trimmed ${uris.length} → ${kept.length} (${args.keep_which})`, write.snapshot_id));
  });
}
