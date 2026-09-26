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
  client: { get<T>(path: string, params?: Record<string, string>): Promise<T | null> },
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

const SAVED_URI_TYPES = ['track', 'album', 'show', 'episode', 'audiobook'] as const;
type SavedUriType = (typeof SAVED_URI_TYPES)[number];

interface ParsedSavedUris {
  buckets: Record<SavedUriType, string[]>;
  canonicalUris: string[];
}

function partitionSavedUris(uris: string[]): ParsedSavedUris {
  const buckets: Record<SavedUriType, string[]> = {
    track: [],
    album: [],
    show: [],
    episode: [],
    audiobook: [],
  };
  const canonicalUris: string[] = [];
  for (const uri of uris) {
    const parsed = classifySpotifyReference(uri, undefined, { allowShortIds: true });
    if (!parsed.valid || !parsed.kind || !SAVED_URI_TYPES.includes(parsed.kind as SavedUriType)) {
      throw new Error(
        `Unsupported URI type: ${uri} (supported: ${SAVED_URI_TYPES.map((kind) => `spotify:${kind}:`).join(', ')})`,
      );
    }
    const canonical = spotifyUriFromClassification(parsed);
    if (!canonical) throw new Error(`Invalid Spotify reference: ${uri}`);
    buckets[parsed.kind as SavedUriType].push(parsed.id!);
    canonicalUris.push(canonical);
  }
  return { buckets, canonicalUris };
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

/**
 * The wire shape a per-type write takes for the legacy library endpoints
 * (#1095). `path` is the full request path, including `?ids=` for show /
 * audiobook buckets; `body` is the JSON body when one is needed (tracks /
 * albums / episodes) and `undefined` when ids already ride the URL. Exposed
 * so `undo_mutation` can invert a legacy `save_items` / `remove_saved_items`
 * receipt through the same per-type endpoint the mutation used, on
 * credentials that cannot reach `/me/library`.
 */
export interface SavedBucketWriteTarget {
  path: string;
  body?: { ids: string[] };
}

export function savedBucketWrite(type: SavedUriType, ids: string[]): SavedBucketWriteTarget {
  if (IDS_AS_QUERY[type]) return { path: savedItemsPath(type, ids) };
  return { path: `/me/${type}s`, body: { ids } };
}

/**
 * One per-URI-type bucket outcome from the legacy per-type save/remove loops
 * (#748). These loops write one bucket per type in sequence; a rejection in
 * bucket N used to discard the successes of buckets 1..N-1 behind a bare
 * error — a silent partial mutation with no receipt, so `undo_last_mutation`
 * had nothing to invert. Every bucket is now attempted on its own and reported
 * here, with the rejection's status/retry-after/reason carried through.
 */
interface SavedBucketOutcome {
  type: SavedUriType;
  /** URIs in this bucket, as partitioned from the caller's request. */
  requested: number;
  /** Raw ids the bucket sent to Spotify. Recorded so the receipt can replay
   * the per-type write on undo (#1095), without re-parsing the caller's uris. */
  ids: string[];
  ok: boolean;
  /** Rejection message; absent when the bucket landed. */
  error?: string;
  /** HTTP status of the rejection, when the client reported one. */
  status?: number;
  /** Retry-after hint of the rejection, when the client reported one. */
  retry_after_sec?: number;
  /** Spotify `error.reason` of the rejection, when present. */
  reason?: string;
}

interface SavedBucketRun {
  outcomes: SavedBucketOutcome[];
  /** Canonical URIs whose bucket landed, in bucket order. */
  committed: string[];
  /**
   * The per-type buckets that landed (#1095). Carried verbatim into the
   * receipt so `undo_mutation` can replay each bucket through its per-type
   * endpoint (`/me/tracks`, `/me/albums`, `/me/shows?ids=…`, …) instead of
   * `/me/library`, which is exactly the endpoint the legacy tools exist to
   * avoid on grandfathered credentials.
   */
  writes: Array<{ type: SavedUriType; ids: string[] }>;
  /** First rejection, rethrown verbatim when nothing landed. */
  firstError: unknown;
}

/**
 * Attempt every non-empty bucket independently so one rejection cannot erase
 * the buckets that already succeeded. `firstError` is the original error
 * object, status/retry-after intact, for the all-failed case.
 */
async function runSavedBuckets(
  buckets: Record<SavedUriType, string[]>,
  write: (type: SavedUriType, ids: string[]) => Promise<unknown>,
): Promise<SavedBucketRun> {
  const outcomes: SavedBucketOutcome[] = [];
  const committed: string[] = [];
  const writes: Array<{ type: SavedUriType; ids: string[] }> = [];
  let firstError: unknown;
  for (const type of SAVED_URI_TYPES) {
    const ids = buckets[type];
    if (ids.length === 0) continue;
    try {
      await write(type, ids);
      const copy = [...ids];
      outcomes.push({ type, requested: ids.length, ids: copy, ok: true });
      writes.push({ type, ids: copy });
      committed.push(...copy.map((id) => `spotify:${type}:${id}`));
    } catch (err) {
      firstError ??= err;
      const api = err instanceof SpotifyApiError ? err : undefined;
      outcomes.push({
        type,
        requested: ids.length,
        ids: [...ids],
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        ...(api ? { status: api.status } : {}),
        ...(api?.retryAfterSec !== undefined ? { retry_after_sec: api.retryAfterSec } : {}),
        ...(api?.reason ? { reason: api.reason } : {}),
      });
    }
  }
  return { outcomes, committed, writes, firstError };
}

/**
 * `/me/library/contains` is the unified endpoint these legacy per-type tools
 * deliberately do not depend on — a grandfathered credential that cannot use
 * `/me/library` at all is exactly the credential that produces a partial
 * write (#748). Translate the receipt's verification read into the per-type
 * `/me/{type}s/contains` calls `check_saved_items` already uses, so the
 * committed subset is verifiable wherever the buckets themselves are writable.
 * Any rejection propagates unchanged: a failed read is not an absent item.
 */
function legacyContainsClient(client: SpotifyClient): ReceiptClient {
  return {
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      const uris = path === '/me/library/contains' ? params?.uris : undefined;
      if (uris === undefined) return client.get<T>(path, params);
      const wanted = uris.split(',');
      const flags = new Array<boolean>(wanted.length).fill(false);
      const slots: Record<SavedUriType, number[]> = {
        track: [],
        album: [],
        show: [],
        episode: [],
        audiobook: [],
      };
      wanted.forEach((uri, i) => {
        const parsed = classifySpotifyReference(uri, undefined, { allowShortIds: true });
        const type = parsed.kind as SavedUriType | undefined;
        if (!parsed.valid || !parsed.id || !type || !SAVED_URI_TYPES.includes(type)) return;
        slots[type].push(i);
      });
      for (const type of SAVED_URI_TYPES) {
        const indexes = slots[type];
        if (indexes.length === 0) continue;
        const ids = indexes.map((i) => wanted[i]!.split(':').slice(2).join(':'));
        const contains = await client.get<boolean[]>(`/me/${type}s/contains`, {
          ids: ids.join(','),
        });
        if (!contains) throw new Error(`Could not check saved ${type}s`);
        indexes.forEach((uriIndex, j) => {
          if (contains[j]) flags[uriIndex] = true;
        });
      }
      return flags as T;
    },
  };
}

/**
 * Partial save/remove result (#748). `ok: false` because the requested set did
 * not fully land, `affected` counts only the buckets that did, and `results`
 * names every bucket with its own outcome — an unread or rejected group is
 * reported as such, never counted as saved. The receipt covers exactly the
 * committed URIs so undo inverts the committed subset and nothing else; when
 * even the verification read fails, `receipt` is null with `receipt_error`
 * saying so rather than a fabricated verdict.
 */
async function savedBucketsPartialOut(
  rf: ResponseFormatValue,
  client: SpotifyClient,
  verb: 'Saved' | 'Removed',
  outcomes: SavedBucketOutcome[],
  committed: readonly string[],
  writes: ReadonlyArray<{ type: SavedUriType; ids: string[] }>,
  expectPresent: boolean,
): Promise<ToolOut> {
  const failed = outcomes.filter((o) => !o.ok);
  const requestedTotal = outcomes.reduce((a, o) => a + o.requested, 0);
  const failedText = failed.map((o) => `${o.type} (${o.requested}): ${o.error}`).join('; ');
  const groups = `${outcomes.length - failed.length} of ${outcomes.length} groups landed`;
  const { receipt, error: receiptError } = await guardedReceipt(legacyContainsClient(client), {
    kind: 'library',
    uris: [...committed],
    expectPresent,
    // Record the per-type buckets so undo replays them through the same
    // endpoints the mutation used — not /me/library, which is the endpoint
    // these legacy tools exist to avoid (#1095).
    ...(writes.length > 0 ? { writes: writes.map((w) => ({ type: w.type, ids: [...w.ids] })) } : {}),
  });
  const prose =
    `${verb} ${committed.length} of ${requestedTotal} item(s) (${groups}) — ` +
    `not ${verb.toLowerCase()}: ${failedText}.\n` +
    receiptLines(
      receipt,
      receiptError,
      { expectPresent },
      ' Confirm the committed subset with check_saved_items.',
    );
  return shapeResult(rf, prose, {
    ok: false,
    partial: true,
    affected: committed.length,
    requested: requestedTotal,
    uris: [...committed],
    results: outcomes,
    receipt: receipt as unknown as Record<string, unknown> | null,
    ...(receiptError ? { receipt_error: receiptError } : {}),
  });
}

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
      const { buckets, canonicalUris: uris } = partitionSavedUris(args.uris);
      if (args.dry_run) {
        return dryRunOut(args.response_format, 'save_items', 'user library', uris);
      }
      // #748: each bucket stands alone — a rejection in one no longer discards
      // the buckets that already landed, and the committed subset gets a receipt.
      const { outcomes, committed, writes, firstError } = await runSavedBuckets(buckets, (type, ids) =>
        client.put(savedItemsPath(type, ids), IDS_AS_QUERY[type] ? undefined : { ids }),
      );
      if (outcomes.some((o) => !o.ok)) {
        // Nothing landed: the original error still answers, status/retry-after intact.
        if (committed.length === 0) throw firstError;
        return savedBucketsPartialOut(args.response_format, client, 'Saved', outcomes, committed, writes, true);
      }
      const counts = outcomes.map((o) => `${o.requested} ${o.type}${o.requested === 1 ? '' : 's'}`);
      return mutationOut(
        args.response_format,
        `Saved ${committed.length} item(s) to library (${counts.join(', ')}).`,
        committed.length,
        uris,
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
      const { buckets, canonicalUris: uris } = partitionSavedUris(args.uris);
      if (args.dry_run) {
        return dryRunOut(args.response_format, 'remove_saved_items', 'user library', uris);
      }
      // #748: mirror of save_items — a rejected bucket must not erase the
      // removals that already landed, and those removals get a receipt.
      const { outcomes, committed, writes, firstError } = await runSavedBuckets(buckets, (type, ids) =>
        client.delete(savedItemsPath(type, ids), IDS_AS_QUERY[type] ? undefined : { ids }),
      );
      if (outcomes.some((o) => !o.ok)) {
        if (committed.length === 0) throw firstError;
        return savedBucketsPartialOut(
          args.response_format,
          client,
          'Removed',
          outcomes,
          committed,
          writes,
          false,
        );
      }
      return mutationOut(
        args.response_format,
        `Removed ${committed.length} item(s) from library.`,
        committed.length,
        uris,
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
      const { buckets, canonicalUris: uris } = partitionSavedUris(args.uris);
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

      const checks = uris.map((uri) => ({ uri, saved: savedByUri.get(uri) ?? false }));
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
    "Library size snapshot: counts for tracks/albums/shows/episodes/audiobooks/playlists via limit=1 reads — no item paging. The total covers library saves only: playlists are owned and followed collections, so their count is reported alongside the library rows and excluded from the total. A collection that could not be read (rate limited, gated, or erroring) is reported as unreadable with its reason and left out of the total — it is never reported as 0. One attempt per collection: a rate limit is surfaced, not retried. Quota: 🟢 6 GETs.",
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
    'Search saved albums (client-side filter over bounded walk). Quota: 🟢 GET /me/albums paged.',
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
    'Search saved podcast shows (bounded walk + client-side filter). Quota: 🟢 GET /me/shows paged.',
    {
      query: z.string().optional().describe('Substring match against show name/publisher'),
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
    'Search saved episodes (bounded walk + client-side filter). Quota: 🟢 GET /me/episodes paged.',
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
    'Search saved audiobooks (bounded walk + client-side filter). Quota: 🟢 GET /me/audiobooks paged.',
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
      const uris = canonicalLibraryUris(args.uris, LIBRARY_CHECK_TYPES);
      const contains = await client.get<boolean[]>(
        '/me/library/contains',
        libraryUrisParam(uris),
      );
      if (!contains) throw new Error('Could not check library state');

      const checks = uris.map((uri, i) => ({ uri, saved: contains[i] ?? false }));
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
  let line = `  • "${item.show.name}" by ${item.show.publisher ?? 'unknown publisher'} (${item.show.total_episodes} episodes) | URI: ${item.show.uri}`;
  if (detailed) line += ` | Added: ${item.added_at}`;
  lines.push(line);
}

function renderEpisodeLine(lines: string[], item: SavedEpisodeItem, detailed = false): void {
  let line = `  • "${item.episode.name}" — ${item.episode.show.name} (${formatDuration(item.episode.duration_ms)}, ${item.episode.release_date}) | URI: ${item.episode.uri}`;
  if (detailed) line += ` | Added: ${item.added_at}`;
  lines.push(line);
}
