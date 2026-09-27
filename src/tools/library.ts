import { z } from 'zod';
import { MARKET_CODE } from './catalog.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SpotifyApiError, type SpotifyClient } from '../client.js';
import type {
  SpotifyPaged,
  SavedTrackItem,
  SavedAlbumItem,
  SavedAudiobookItem,
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
import {
  issueReceipt,
  formatReceipt,
  type IssueReceiptOpts,
  type Receipt,
  type ReceiptClient,
} from '../receipts.js';
import { getConfig } from '../config.js';
import { publisherByline } from '../removed.js';
import {
  classifySpotifyReference,
  spotifyUriFromClassification,
  type SpotifyReferenceKind,
} from '../refs.js';

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

/**
 * Issue a receipt, tolerating an unreadable verification (#748).
 * `issueReceipt` refetches live state and can throw; every caller in this file
 * has already committed a write by the time it runs, so a failed read must
 * never become a lost result. `error` names the failure and the receipt is
 * null — a failed read is not a verdict.
 */
async function guardedReceipt(
  client: ReceiptClient,
  opts: IssueReceiptOpts,
): Promise<{ receipt: Receipt | null; error?: string }> {
  try {
    return { receipt: await issueReceipt(client, opts) };
  } catch (err) {
    return { receipt: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Render a receipt, or say plainly that none could be issued. One wording for
 * both callers so the fallback cannot drift between the partial-bucket result
 * and the single-request one.
 */
function receiptLines(
  receipt: Receipt | null,
  error: string | undefined,
  opts: { expectPresent?: boolean },
  followUp: string,
): string {
  return receipt
    ? formatReceipt(receipt, opts)
    : `No receipt: verification failed (${error}).${followUp}`;
}

/**
 * Mutation confirmation + post-mutation verification receipt (#112 idea 11):
 * refetches minimal state so the agent sees explicit confirmation of what
 * landed in the same turn as the write.
 *
 * #748: the write has already landed by the time the receipt is read, so a
 * failed verification read must not be reported as a failed write — that
 * would hide committed work behind a bare error and invite a duplicate retry.
 * The mutation result stands: `ok` stays true and `affected`/`uris` stay the
 * full requested set, with `receipt: null` + `receipt_error` saying why the
 * receipt is missing.
 */
async function mutationOutVerified(
  rf: ResponseFormatValue,
  client: ReceiptClient,
  kind: 'library',
  prose: string,
  n: number,
  uris: readonly string[],
  receiptOpts: { expectPresent?: boolean } = {},
): Promise<ToolOut> {
  const base = mutationOut(rf, prose, n, uris);
  const { receipt, error: receiptError } = await guardedReceipt(client, {
    kind,
    uris: [...uris],
    ...receiptOpts,
  });
  // json mode must stay parseable: the receipt rides structuredContent only.
  const text =
    rf === 'json'
      ? base.content[0].text
      : `${base.content[0].text}\n${receiptLines(receipt, receiptError, receiptOpts, '')}`;
  return {
    content: [{ type: 'text', text }],
    structuredContent: {
      ...(base.structuredContent ?? {}),
      receipt: receipt as unknown as Record<string, unknown> | null,
      ...(receiptError ? { receipt_error: receiptError } : {}),
    },
  };
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

/**
 * Why a collection produced no count (#749). `status` separates a gated read
 * (403) from a throttled one (429); `reason` and `retry_after_sec` appear only
 * when the client had them to give. Omitted rather than defaulted, so "we don't
 * know" never renders as a fabricated value.
 */
interface UnreadableCollection {
  message: string;
  status?: number;
  reason?: string;
  retry_after_sec?: number;
}

/**
 * Date filter bounds for `search_saved_*` (#750): an unparsable bound is a
 * caller error, never a filter result. `Date.parse('last tuesday')` is NaN and
 * every comparison against NaN is false, so a malformed `added_after` used to
 * match zero items while a malformed `added_before` (guarded by an
 * `isFinite` check that skipped the filter) matched everything — both silent,
 * neither named. Parse once, up front — before the walk so a bad bound costs
 * no API calls — and name the offending parameter in the error.
 */
function parseDateBound(param: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(
      `${param} is not a valid date: ${JSON.stringify(value)} — ` +
        'use an ISO 8601 date or datetime, e.g. "2026-01-31" or "2026-01-31T00:00:00Z"',
    );
  }
  return ms;
}

// #638: `check_saved_items` was deleted here, and with it `SAVED_URI_TYPES`,
// `SavedUriType`, `ParsedSavedUris` and `partitionSavedUris`. The `canonicalUris`
// half of `partitionSavedUris` was the only thing that canonicalised a
// short-id / URI / URL reference before the bucket walk; `canonicalLibraryUris`
// below does the same job for every remaining caller and is what
// `check_in_library` uses.

// #638: the per-type library WRITE machinery used to live here --
// `savedItemsPath`, `savedBucketWrite`, `runSavedBuckets`, `legacyContainsClient`
// and `savedBucketsPartialOut` -- and it went with `save_items` /
// `remove_saved_items`. It existed for one reason, quoted from those tools'
// own descriptions: "kept for grandfathered app credentials that lack unified
// /me/library access". Spotify's February 2026 changes removed every endpoint
// those helpers addressed (`PUT`/`DELETE /me/{tracks,albums,shows,episodes,
// audiobooks}`), so the credential class they were written for can no longer
// exist: a caller that cannot reach `/me/library` now has no per-type write to
// fall back to either. `save_to_library` and `remove_from_library` are the
// only remaining path, and the receipt `writes` field that recorded which
// bucket a mutation used was removed with it -- `undo_mutation` now has one
// library write to invert through, and it is the one that still exists.

// Unified library endpoints (#37): the modern path accepting any mix of URI
// types — including artist/user/playlist follow state on contains — in a
// single request against /me/library instead of per-type bucket loops.
const LIBRARY_SAVE_TYPES = [
  'track',
  'album',
  'episode',
  'show',
  'audiobook',
  'user',
  'playlist',
] as const satisfies readonly SpotifyReferenceKind[];
const LIBRARY_CHECK_TYPES = [...LIBRARY_SAVE_TYPES, 'artist'] as const satisfies readonly SpotifyReferenceKind[];

function canonicalLibraryUris(
  refs: string[],
  supported: readonly SpotifyReferenceKind[],
): string[] {
  return refs.map((ref) => {
    const parsed = classifySpotifyReference(ref, undefined, { allowShortIds: true });
    if (!parsed.valid || !parsed.kind || !supported.includes(parsed.kind)) {
      throw new Error(
        `Unsupported URI type: ${ref} (supported: ${supported.map((kind) => `spotify:${kind}:`).join(', ')})`,
      );
    }
    const uri = spotifyUriFromClassification(parsed);
    if (!uri) throw new Error(`Invalid Spotify reference: ${ref}`);
    return uri;
  });
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
      limit: z.coerce.number().int().min(1).max(50).optional().describe('1–50. Default: 20'),
      offset: z.number().int().min(0).optional().describe('Pagination offset. Default: 0'),
      market: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 country code, e.g. \'US\''),
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
      limit: z.coerce.number().int().min(1).max(50).optional().describe('1–50. Default: 20'),
      offset: z.number().int().min(0).optional().describe('Pagination offset. Default: 0'),
      market: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 country code, e.g. \'US\''),
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
      limit: z.coerce.number().int().min(1).max(50).optional().describe('1–50. Default: 20'),
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
      limit: z.coerce.number().int().min(1).max(50).optional().describe('1–50. Default: 20'),
      offset: z.number().int().min(0).optional().describe('Pagination offset. Default: 0'),
      market: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 country code, e.g. \'US\''),
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

  // #638: `check_saved_items` was deleted here. It read
  // `GET /me/{tracks,albums,shows,episodes,audiobooks}/contains`, which Spotify
  // removed in February 2026 with `GET /me/library/contains` named as the
  // replacement, and its own description gave the same dead rationale as
  // `save_items` / `remove_saved_items`: it was "kept for grandfathered app
  // credentials that lack unified /me/library access". A registration that
  // cannot reach `/me/library` no longer has a per-type read to fall back to
  // either, so the audience it existed for is empty. It was also a strict
  // subset of `check_in_library` on the day it shipped -- fewer URI types
  // (`LIBRARY_CHECK_TYPES` also accepts artist, user and playlist) and a
  // smaller batch cap (40, not 50) -- so nothing it could answer is now
  // unanswerable. Its bucket helpers (`SAVED_URI_TYPES`, `SavedUriType`,
  // `ParsedSavedUris`, `partitionSavedUris`) went with it; they had no other
  // caller.
  //
  // Unlike the write half, this read had a *second*, worse defect: a failed
  // per-type read was the only thing standing between a caller and a confident
  // wrong answer. It threw on a null body, but `contains[i] ?? false` and
  // `savedByUri.get(uri) ?? false` turned a SHORT or non-boolean body into
  // "✗ not saved" for every row, and a bucket that was never requested at all
  // produced the same. That is the #803 shape -- a read that failed being
  // reported as a read that returned nothing -- and it is why removing the
  // tool was the right move rather than pointing it at `/me/library/contains`:
  // a migrated copy would have inherited the same silent-false default.

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
      const uris = canonicalLibraryUris(args.uris, LIBRARY_SAVE_TYPES);
      if (args.dry_run) {
        return dryRunOut(args.response_format, 'save_to_library', 'user library', uris);
      }
      await client.put(`/me/library?${new URLSearchParams(libraryUrisParam(uris)).toString()}`);
      return mutationOutVerified(
        args.response_format,
        client,
        'library',
        `Saved ${uris.length} item(s) to library.`,
        uris.length,
        uris,
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
      const uris = canonicalLibraryUris(args.uris, LIBRARY_SAVE_TYPES);
      if (args.dry_run) {
        return dryRunOut(args.response_format, 'remove_from_library', 'user library', uris);
      }
      await client.delete(
        `/me/library?${new URLSearchParams(libraryUrisParam(uris)).toString()}`,
      );
      return mutationOutVerified(
        args.response_format,
        client,
        'library',
        `Removed ${uris.length} item(s) from library.`,
        uris.length,
        uris,
        { expectPresent: false },
      );
    },
  );

  // get_saved_counts (#296, #749)
  server.tool(
    'get_saved_counts',
    "Library size snapshot: counts for tracks/albums/shows/episodes/audiobooks/playlists via limit=1 reads — no item paging. The total covers library saves only: playlists are owned and followed collections, so their count is reported alongside the library rows and excluded from the total. A collection that could not be read (rate limited, gated, or erroring) is reported as unreadable with its reason and left out of the total — it is never reported as 0. One attempt per collection: a rate limit is surfaced, not retried. Quota: 6 GETs.",
    {
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      // `/me/playlists` is owned *and* followed collections, not a save: it is
      // a different kind of thing from the five library-save collections, and
      // folding it into "how big is this user's library" is a category error
      // that inflates the number a caller sizes a backup or budget from. It is
      // still read and still reported — just not as a library row, and never
      // in the total (#749).
      const libraryEndpoints: Array<[string, string]> = [
        ['tracks', '/me/tracks'],
        ['albums', '/me/albums'],
        ['shows', '/me/shows'],
        ['episodes', '/me/episodes'],
        ['audiobooks', '/me/audiobooks'],
      ];
      const nonLibraryEndpoints: Array<[string, string]> = [['playlists', '/me/playlists']];
      const NON_LIBRARY_REASON = 'owned and followed playlists are a separate collection, not a library save';
      const libraryKeys = new Set(libraryEndpoints.map(([key]) => key));
      const nonLibraryKeys = new Set(nonLibraryEndpoints.map(([key]) => key));
      const endpoints = [...libraryEndpoints, ...nonLibraryEndpoints];
      // A count is only recorded when the read actually produced one (#749).
      // Anything else — a thrown 429/403/5xx, a null body, a missing or
      // non-numeric `total` — is "could not read", which is a different fact
      // from "read it and it was empty", and must not be flattened into 0.
      const counts: Record<string, number> = {};
      const unreadable: Record<string, UnreadableCollection> = {};
      for (const [key, path] of endpoints) {
        try {
          // Exactly one attempt: retrying into a rate limit is worse than
          // reporting the limit. When the client is already cooling down, the
          // remaining reads fast-fail and land here too — which is precisely
          // the partial-read case this list exists to surface.
          const res = await client.get<{ total?: number }>(path, { limit: '1' });
          const total = res?.total;
          if (typeof total !== 'number' || !Number.isFinite(total)) {
            unreadable[key] = {
              message: 'Spotify returned no usable total for this collection',
            };
            continue;
          }
          counts[key] = total;
        } catch (err) {
          // Carry the API's own diagnosis, not just its prose: `status` tells
          // a gated (403) collection apart from a throttled one (429), and
          // `reason`/`retryAfterSec` let a caller decide wait-vs-abort without
          // pattern-matching the message (#749).
          const api = err as Partial<SpotifyApiError>;
          unreadable[key] = {
            message: err instanceof Error ? err.message : String(err),
            ...(typeof api.status === 'number' ? { status: api.status } : {}),
            ...(api.reason ? { reason: api.reason } : {}),
            ...(typeof api.retryAfterSec === 'number'
              ? { retry_after_sec: api.retryAfterSec }
              : {}),
          };
        }
      }
      // The total is over library saves only. `counts.playlists` is still
      // reported, under the same key as before, but a playlist is not a
      // saved track or album, so folding one into "how big is this library"
      // produces a number no caller can reason about (#749).
      const libraryCounts = Object.fromEntries(
        Object.entries(counts).filter(([k]) => libraryKeys.has(k)),
      );
      const total = Object.values(libraryCounts).reduce((a, b) => a + b, 0);
      const unreadableKeys = Object.keys(unreadable);
      // Only a library collection missing from the read can make the total
      // partial; an unreadable playlist count leaves the library figure whole.
      const libraryUnreadableKeys = unreadableKeys.filter((k) => libraryKeys.has(k));
      const lines = ['Library counts:'];
      for (const [k, v] of Object.entries(libraryCounts)) lines.push(`  ${k}: ${v}`);
      // Non-library collections get their own block, never a library row.
      for (const [k, v] of Object.entries(counts)) {
        if (nonLibraryKeys.has(k)) lines.push(`  ${k}: ${v} — not a library collection (${NON_LIBRARY_REASON})`);
      }
      for (const k of unreadableKeys) {
        lines.push(
          nonLibraryKeys.has(k)
            ? `  ${k}: unreadable — ${unreadable[k].message} (not a library collection; the total is unaffected)`
            : `  ${k}: unreadable — ${unreadable[k].message}`,
        );
      }
      const notes: string[] = [];
      if (libraryUnreadableKeys.length > 0) {
        notes.push(
          `${libraryUnreadableKeys.length} unreadable (${libraryUnreadableKeys.join(', ')}) and excluded from this total`,
        );
      }
      if (nonLibraryKeys.size > 0) {
        notes.push(`${[...nonLibraryKeys].join(', ')} excluded from this total — ${NON_LIBRARY_REASON}`);
      }
      lines.push(
        notes.length === 0
          ? `Total: ${total}`
          : `Total: ${total} — across ${Object.keys(libraryCounts).length} of ${libraryEndpoints.length} library collections; ${notes.join('; ')}.`,
      );
      const payload = {
        counts,
        total,
        unreadable,
        unreadable_count: unreadableKeys.length,
        collections_read: Object.keys(libraryCounts).length,
        collections_total: libraryEndpoints.length,
        total_is_partial: libraryUnreadableKeys.length > 0,
        excluded_from_total: Object.fromEntries(
          [...nonLibraryKeys].map((k) => [k, NON_LIBRARY_REASON]),
        ),
      };
      if (rf === 'json') return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
      return shapeResult(rf as ResponseFormatValue, lines.join('\n'), payload as unknown as Record<string, unknown>);
    },
  );

  // search_saved_albums (#264)
  server.tool(
    'search_saved_albums',
    'Search saved albums (client-side filter over bounded walk). Quota: GET /me/albums paged.',
    {
      query: z.string().optional().describe('Substring match against album name/artist'),
      artist: z.string().optional().describe('Substring match against album artist'),
      added_after: z.string().optional().describe('ISO date — only albums added after this'),
      max_results: MaxResults,
      scan_cap: z.number().int().min(1).max(2000).optional().describe('Max albums to scan (default fetchAllCap)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const addedAfter = parseDateBound('added_after', args.added_after);
      const capN = args.scan_cap ?? getConfig().fetchAllCap;
      const all = await client.getAllPages<SavedAlbumItem>('/me/albums', { limit: '50' }, { maxItems: capN });
      // A saved row can come back with a null `album` — content Spotify can no
      // longer serve. It cannot be matched, and every facet below
      // dereferences `album`, so it is dropped here and reported rather than
      // crashing the filter or counting as a match (#761).
      const albums = all.filter((i) => i?.album);
      const unavailable = all.length - albums.length;
      let filtered = albums;
      if (args.query) { const q = args.query.toLowerCase(); filtered = filtered.filter(i => i.album.name.toLowerCase().includes(q) || i.album.artists.some(a => a.name.toLowerCase().includes(q))); }
      if (args.artist) { const q = args.artist.toLowerCase(); filtered = filtered.filter(i => i.album.artists.some(a => a.name.toLowerCase().includes(q))); }
      if (addedAfter !== undefined) { filtered = filtered.filter(i => Date.parse(i.added_at) > addedAfter); }
      const t = truncateItems(filtered, cap(args));
      const pagination = paginationInfo({ total: filtered.length, returned: t.items.length });
      const lines = [`Saved albums search: ${filtered.length} match(es), showing ${t.items.length} (scanned ${all.length}):`];
      for (const it of t.items) renderAlbumLine(lines, it, rf === 'detailed');
      if (t.footer) lines.push(`(${t.footer})`);
      if (all.length >= capN) lines.push('(truncated at fetch_all_cap)');
      if (unavailable > 0) lines.push(`(${unavailable} saved row(s) carried no album payload and could not be matched)`);
      return shapeResult(rf as ResponseFormatValue, lines.join('\n'), listStructuredContent(t.items, pagination, { scanned: all.length, matched: filtered.length, unavailable_rows: unavailable }));
    },
  );

  // search_saved_shows (#265)
  server.tool(
    'search_saved_shows',
    'Search saved podcast shows (bounded walk + client-side filter). Quota: GET /me/shows paged.',
    {
      query: z.string().optional().describe('Substring match against show name and publisher. Spotify removed `publisher` from show payloads in February 2026, so the publisher half can only match on an app registration created before November 2024; on a current registration this is a name search that reports 0 publisher matches rather than pretending to have searched publishers.'),
      max_results: MaxResults,
      scan_cap: z.number().int().min(1).max(2000).optional().describe('Maximum saved items to scan; defaults to SPOTIFY_MCP_FETCH_ALL_CAP'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const capN = args.scan_cap ?? getConfig().fetchAllCap;
      const all = await client.getAllPages<SavedShowItem>('/me/shows', { limit: '50' }, { maxItems: capN });
      // A saved row can come back with a null `show` — content Spotify can no
      // longer serve. It cannot be matched, and both the facet and the render
      // below dereference `show`, so it is dropped here and reported rather
      // than crashing the search or counting as a match (#761).
      const shows = all.filter((i) => i?.show);
      const unavailable = all.length - shows.length;
      let filtered = shows;
      // #639: `publisher` is gone from show payloads, so this clause matches
      // nothing on any registration created after November 2024. It is KEPT
      // rather than deleted, for the same reason `publisherByline` keeps a
      // publisher a payload really carried: a grandfathered registration still
      // sends the field, and dropping the clause would take away a search that
      // works for those users. What was wrong was never the matching — it is
      // that a 0-result publisher search was indistinguishable from a library
      // with no shows by that publisher, so the description now says the half
      // only matches pre-Nov-2024 registrations.
      if (args.query) { const q = args.query.toLowerCase(); filtered = filtered.filter(i => i.show.name.toLowerCase().includes(q) || (i.show.publisher ?? '').toLowerCase().includes(q)); }
      const t = truncateItems(filtered, cap(args));
      const pagination = paginationInfo({ total: filtered.length, returned: t.items.length });
      const lines = [`Saved shows search: ${filtered.length} match(es), showing ${t.items.length} (scanned ${all.length}):`];
      for (const it of t.items) renderShowLine(lines, it, rf === 'detailed');
      if (t.footer) lines.push(`(${t.footer})`);
      if (all.length >= capN) lines.push('(truncated at fetch_all_cap)');
      if (unavailable > 0) lines.push(`(${unavailable} saved row(s) carried no show payload and could not be matched)`);
      return shapeResult(rf as ResponseFormatValue, lines.join('\n'), listStructuredContent(t.items, pagination, { scanned: all.length, matched: filtered.length, unavailable_rows: unavailable }));
    },
  );

  // search_saved_episodes (#266)
  server.tool(
    'search_saved_episodes',
    'Search saved episodes (bounded walk + client-side filter). Quota: GET /me/episodes paged.',
    {
      query: z.string().optional().describe('Substring against episode/show name'),
      show: z.string().optional().describe('Substring against show name'),
      max_results: MaxResults,
      scan_cap: z.number().int().min(1).max(2000).optional().describe('Maximum saved items to scan; defaults to SPOTIFY_MCP_FETCH_ALL_CAP'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const capN = args.scan_cap ?? getConfig().fetchAllCap;
      const all = await client.getAllPages<SavedEpisodeItem>('/me/episodes', { limit: '50' }, { maxItems: capN });
      // A saved row can come back with a null `episode`; it cannot be matched
      // and both facets below dereference it, so drop + report (#761).
      const episodes = all.filter((i) => i?.episode);
      const unavailable = all.length - episodes.length;
      let filtered = episodes;
      if (args.query) { const q = args.query.toLowerCase(); filtered = filtered.filter(i => i.episode.name.toLowerCase().includes(q)); }
      if (args.show) { const q = args.show.toLowerCase(); filtered = filtered.filter(i => i.episode.show.name.toLowerCase().includes(q)); }
      const t = truncateItems(filtered, cap(args));
      const pagination = paginationInfo({ total: filtered.length, returned: t.items.length });
      const lines = [`Saved episodes search: ${filtered.length} match(es), showing ${t.items.length} (scanned ${all.length}):`];
      for (const it of t.items) renderEpisodeLine(lines, it, rf === 'detailed');
      if (t.footer) lines.push(`(${t.footer})`);
      if (all.length >= capN) lines.push('(truncated at fetch_all_cap)');
      if (unavailable > 0) lines.push(`(${unavailable} saved row(s) carried no episode payload and could not be matched)`);
      return shapeResult(rf as ResponseFormatValue, lines.join('\n'), listStructuredContent(t.items, pagination, { scanned: all.length, matched: filtered.length, unavailable_rows: unavailable }));
    },
  );

  // search_saved_audiobooks (#267)
  server.tool(
    'search_saved_audiobooks',
    'Search saved audiobooks (bounded walk + client-side filter). Quota: GET /me/audiobooks paged.',
    {
      query: z.string().optional().describe('Substring against audiobook name/author'),
      max_results: MaxResults,
      scan_cap: z.number().int().min(1).max(2000).optional().describe('Maximum saved items to scan; defaults to SPOTIFY_MCP_FETCH_ALL_CAP'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format;
      const capN = args.scan_cap ?? getConfig().fetchAllCap;
      // The `/me/audiobooks` row, read through the shared shape: the local
      // `SavedAudiobookItem` that stood here shadowed the src/types/spotify.ts
      // export with a three-field audiobook the payload never shrank to.
      const all = await client.getAllPages<SavedAudiobookItem>('/me/audiobooks', { limit: '50' }, { maxItems: capN });
      // A saved row can come back with a null `audiobook`; it cannot be matched
      // and both the facet and the render below dereference it (#761).
      const audiobooks = all.filter((i) => i?.audiobook);
      const unavailable = all.length - audiobooks.length;
      let filtered = audiobooks;
      if (args.query) { const q = args.query.toLowerCase(); filtered = filtered.filter(i => i.audiobook.name.toLowerCase().includes(q) || i.audiobook.authors.some(a => a.name.toLowerCase().includes(q))); }
      const t = truncateItems(filtered, cap(args));
      const pagination = paginationInfo({ total: filtered.length, returned: t.items.length });
      const lines = [`Saved audiobooks search: ${filtered.length} match(es), showing ${t.items.length} (scanned ${all.length}):`];
      for (const it of t.items) lines.push(`  • "${it.audiobook.name}" by ${it.audiobook.authors.map(a=>a.name).join(', ')} | URI: ${it.audiobook.uri} | Added: ${it.added_at}`);
      if (t.footer) lines.push(`(${t.footer})`);
      if (all.length >= capN) lines.push('(truncated at fetch_all_cap)');
      if (unavailable > 0) lines.push(`(${unavailable} saved row(s) carried no audiobook payload and could not be matched)`);
      return shapeResult(rf as ResponseFormatValue, lines.join('\n'), listStructuredContent(t.items, pagination, { scanned: all.length, matched: filtered.length, unavailable_rows: unavailable }));
    },
  );

  // check_in_library (#37)
  server.tool(
    'check_in_library',
    "Preferred. Accepts the widest URI mix (track, album, episode, show, audiobook, artist, user, playlist) in one request. Check whether items are saved in or followed by the user — this tests LIBRARY-SAVED/FOLLOWED state, distinct from check_following_artists which only tests artist FOLLOW state. Returns a boolean per URI via Spotify's unified endpoint. Max 40. Following an artist is no longer expressible: Spotify's February 2026 changes removed PUT/DELETE /me/following, and this endpoint's save side does not accept spotify:artist: URIs, so there is no endpoint that can follow or unfollow an artist. This read still answers the question for artist URIs.",
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
      const uris = canonicalLibraryUris(args.uris, LIBRARY_CHECK_TYPES);
      const contains = await client.get<boolean[]>(
        '/me/library/contains',
        libraryUrisParam(uris),
      );
      // #638: the read itself is not gated, but the *shape* of its answer is
      // load-bearing here — `contains[i]` is positionally matched to `uris[i]`,
      // so a short, long or non-boolean body is not a partial answer, it is a
      // mislabelled one. The old guard was `if (!contains) throw`, which let a
      // 3-element body through for 5 URIs and rendered the two missing rows as
      // "✗ not saved" via `?? false`. That is the #803 shape (a read that failed
      // reported as a read that found nothing) wearing a `saved: boolean` type,
      // and it now fails closed. The same shape is checked by `followsArtistIds`
      // in following.ts and `libraryContains` in swarm3_shows.ts.
      if (!Array.isArray(contains) || contains.length !== uris.length) {
        const got = Array.isArray(contains) ? `${contains.length} of ${uris.length}` : typeof contains;
        throw new Error(
          `Could not check library state: GET /me/library/contains returned ${got} ` +
            `for ${uris.length} URI${uris.length === 1 ? '' : 's'}, so the per-URI flags cannot be ` +
            'matched to the request. Nothing is reported as saved or unsaved from a partial read.',
        );
      }
      if (contains.some((value) => typeof value !== 'boolean')) {
        throw new Error(
          'Could not check library state: GET /me/library/contains returned a non-boolean flag. ' +
            'Nothing is reported as saved or unsaved from an untyped read.',
        );
      }

      const checks = uris.map((uri, i) => ({ uri, saved: contains[i] }));
      const t = truncateItems(checks, cap(args));
      const pagination = paginationInfo({ total: checks.length, returned: t.items.length });

      const lines = ['Library check:'];
      for (const c of t.items) lines.push(`  ${c.saved ? '✓' : '✗'} ${c.uri}`);
      appendPaginationFooters(lines, t, pagination);
      return shapeResult(args.response_format, lines.join('\n'), listStructuredContent(t.items, pagination));
    },
  );

  // search_saved_tracks (#229)
  server.tool(
    'search_saved_tracks',
    'Search your Liked Songs (saved tracks) by text query and optional facets — client-side filter over a bounded walk of /me/tracks. For catalog-wide search use search. Reports walk truncation.',
    {
      query: z.string().optional().describe('Substring to match against track name, artist name, or album name (case-insensitive). Omit to list by facets/sort only.'),
      artist: z.string().optional().describe('Filter to tracks where any artist name contains this substring'),
      album: z.string().optional().describe('Filter to tracks where album name contains this substring'),
      added_after: z.string().optional().describe('ISO date — only tracks added after this date'),
      added_before: z.string().optional().describe('ISO date — only tracks added before this date'),
      sort_by: z.enum(['added_desc','added_asc','name_asc','artist_asc']).optional().default('added_desc').describe('Sort order'),
      limit: z.coerce.number().int().min(1).max(100).optional().default(20).describe('Max results to return'),
      max_items: z.number().int().min(1).max(10000).optional().describe('How many saved tracks to walk (default SPOTIFY_MCP_FETCH_ALL_CAP)'),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const rf = args.response_format;
      const addedAfter = parseDateBound('added_after', args.added_after);
      const addedBefore = parseDateBound('added_before', args.added_before);
      const walkCap = args.max_items ?? getConfig().fetchAllCap;
      const all = await client.getAllPages<SavedTrackItem>('/me/tracks', { limit: '50' }, { maxItems: walkCap });
      const truncated = all.length >= walkCap;
      // `/me/tracks` documents `track` as nullable: a saved track Spotify can
      // no longer serve comes back as `{ added_at, track: null }`. The
      // artist/album facets and the name/artist sorts below all dereference
      // `s.track`, so those rows are dropped once here — reported, never
      // counted as a match (#761).
      const tracks = all.filter((s) => s?.track);
      const unavailable = all.length - tracks.length;
      let filtered = tracks;
      const q = args.query?.toLowerCase();
      if (q) filtered = filtered.filter(s => {
        const tr = s.track;
        const hay = [tr.name ?? '', ...(tr.artists ?? []).map(a=>a.name), tr.album?.name ?? ''].join(' ').toLowerCase();
        return hay.includes(q);
      });
      if (args.artist) { const a = args.artist.toLowerCase(); filtered = filtered.filter(s => (s.track.artists ?? []).some(ar => ar.name.toLowerCase().includes(a))); }
      if (args.album) { const a = args.album.toLowerCase(); filtered = filtered.filter(s => (s.track.album?.name ?? '').toLowerCase().includes(a)); }
      if (addedAfter !== undefined) filtered = filtered.filter(s => Date.parse(s.added_at) > addedAfter);
      if (addedBefore !== undefined) filtered = filtered.filter(s => Date.parse(s.added_at) < addedBefore);
      const sort = args.sort_by ?? 'added_desc';
      filtered = [...filtered].sort((a,b)=>{
        if(sort==='added_asc') return Date.parse(a.added_at)-Date.parse(b.added_at);
        if(sort==='added_desc') return Date.parse(b.added_at)-Date.parse(a.added_at);
        if(sort==='name_asc') return (a.track.name??'').localeCompare(b.track.name??'');
        if(sort==='artist_asc') return ((a.track.artists?.[0]?.name??'').localeCompare(b.track.artists?.[0]?.name??''));
        return 0;
      });
      const totalMatches = filtered.length;
      const limit = args.limit ?? 20;
      const sliced = filtered.slice(0, Math.min(limit, cap(args)));
      const lines = [`Saved tracks search: ${totalMatches} match(es) across ${all.length} walked${truncated ? ` (walk truncated at ${walkCap})` : ''}, showing ${sliced.length}:`];
      for (const s of sliced) {
        const tr = s.track; const artists = (tr.artists??[]).map(a=>a.name).join(', '); const album = tr.album?.name ?? '';
        lines.push(`  • "${tr.name}" by ${artists} — ${album} (added ${s.added_at}) | URI: ${tr.uri}`);
      }
      if (truncated) lines.push(`(walk hit cap ${walkCap} — pass max_items to scan more)`);
      if (unavailable > 0) lines.push(`(${unavailable} saved row(s) carried no track payload and could not be matched)`);
      const payload = { total_matches: totalMatches, walked: all.length, unavailable_rows: unavailable, scan_cap: walkCap, truncated, items: sliced.map(s=>({ track: s.track, added_at: s.added_at })), returned: sliced.length };
      return shapeResult(rf, lines.join('\n'), payload as unknown as Record<string, unknown>);
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
  let line = `  • "${item.show.name}"${publisherByline(item.show.publisher)} (${item.show.total_episodes} episodes) | URI: ${item.show.uri}`;
  if (detailed) line += ` | Added: ${item.added_at}`;
  lines.push(line);
}

function renderEpisodeLine(lines: string[], item: SavedEpisodeItem, detailed = false): void {
  let line = `  • "${item.episode.name}" — ${item.episode.show.name} (${formatDuration(item.episode.duration_ms)}, ${item.episode.release_date}) | URI: ${item.episode.uri}`;
  if (detailed) line += ` | Added: ${item.added_at}`;
  lines.push(line);
}
