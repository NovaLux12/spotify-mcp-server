/**
 * stats.fm tools (read-only): listening stats, tops, catalog and social
 * lookups against the public stats.fm API.
 *
 * No Spotify auth required — the StatsfmClient does unauthenticated GETs,
 * so this module is never scope-gated and stays visible under
 * SPOTIFY_MCP_READONLY. Registration key: `statsfm` (own toolset, on by
 * default, additive only).
 *
 * Reads default to the process-wide client in `lib/statsfm-client.ts` rather
 * than to a fresh one per registrar call, so this module shares its timeout,
 * retry and cache with `statsfm_taste.ts` and `taste_composites.ts` (#907).
 * Passing a client explicitly is a test seam, not a second policy.
 *
 * Endpoint paths verified live 2026-09-05; stats.fm envelopes are
 * `{ item }` for singles and `{ items }` for collections.
 *
 * Re-verified 2026-09-27 for the per-entity stream totals (#1006). The
 * aggregate route is plural and nested under `/users/{id}/streams/`:
 * `/users/{id}/streams/tracks/{trackId}/stats`. The shape that reads as the
 * obvious one — `/users/{id}/streams/{trackId}` — 404s, which is what made
 * #1006 conclude no per-entity total existed. One exists, and stats.fm
 * computes it server-side; see `readEntityTotals`.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  StatsfmClient,
  StatsfmApiError,
  statsfmClient,
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
/**
 * The one ranking-window vocabulary for the whole stats.fm surface (#720).
 *
 * Verified live 2026-09-26 against `GET /users/{id}/top/artists`: stats.fm
 * answers `400 {"message":"invalid range"}` for the singular `week`/`month`
 * spellings (and for `6months`, `year`, `all-time`). `weeks`/`months`/
 * `lifetime` are the complete accepted set, so this enum is the contract
 * rather than a local guess.
 *
 * This module, `statsfm_taste.ts`, and `taste_composites.ts` all forward
 * `range` to that same upstream query parameter, so all three import this
 * schema. Three private copies previously drifted apart and the two taste
 * copies advertised values upstream rejects outright.
 */
export const STATSFM_RANGES = ['weeks', 'months', 'lifetime'] as const;

export const statsfmRangeSchema = z
  .enum(STATSFM_RANGES)
  .optional()
  .describe('Ranking window: weeks, months, or lifetime. Default: lifetime');
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

/** The per-entity stats tools all read the same family of endpoints. */
type EntityFilter = 'track' | 'artist' | 'album';

/**
 * The path segment each entity kind uses.
 *
 * Verified live 2026-09-27: the per-entity routes are plural and nested under
 * `/users/{id}/streams/` — `/users/{id}/streams/tracks/{trackId}/stats`.
 * The flat `/users/{id}/streams/{id}` shape reads as the obvious one and
 * 404s, which is how #1006 came to conclude no per-entity total existed.
 */
const ENTITY_SEGMENT: Record<EntityFilter, string> = {
  track: 'tracks',
  artist: 'artists',
  album: 'albums',
};

/**
 * One entity's aggregate, unwrapped from whichever envelope it arrived in.
 *
 * Verified live 2026-09-27: this family answers `{ items: {...} }` for tracks
 * and artists but `{ item: {...} }` for albums, so the envelope is read by
 * what is present. Assuming one shape would read the album payload's missing
 * `count` as a total of nothing.
 */
function entityStatsPayload(body: unknown, path: string): J {
  const object = responseObject(body, path);
  if (Object.prototype.hasOwnProperty.call(object, 'item')) return requiredItem(body, path);
  if (Object.prototype.hasOwnProperty.call(object, 'items')) {
    const stats = object.items;
    if (!stats || typeof stats !== 'object' || Array.isArray(stats)) {
      invalidResponse(path, 'expected items to be an object');
    }
    return stats as J;
  }
  invalidResponse(path, 'expected an item or items object');
}

/**
 * The two totals every per-entity aggregate carries, or a loud failure.
 *
 * `count` and `durationMs` are stats.fm's own figures for the whole entity
 * over the requested window — not a page of the profile's history. A payload
 * that omits either, or carries a non-number for one, is refused rather than
 * read as 0: a total that could not be read must never arrive looking like a
 * measured one (#803, #804).
 */
function entityTotals(
  stats: J,
  path: string,
): { count: number; totalMs: number; cardinality: J | null } {
  if (typeof stats.count !== 'number' || !Number.isInteger(stats.count) || stats.count < 0) {
    invalidResponse(path, 'expected count to be a non-negative integer');
  }
  if (typeof stats.durationMs !== 'number' || !Number.isFinite(stats.durationMs) || stats.durationMs < 0) {
    invalidResponse(path, 'expected durationMs to be a non-negative finite number');
  }
  const card = stats.cardinality;
  if (card !== undefined && (!card || typeof card !== 'object' || Array.isArray(card))) {
    invalidResponse(path, 'expected cardinality to be an object when present');
  }
  return { count: stats.count, totalMs: stats.durationMs, cardinality: (card as J | undefined) ?? null };
}

/** ISO form of a window edge, so the scope reads as a date rather than epoch ms. */
function windowEdge(value: string | undefined): string | null {
  if (value === undefined) return null;
  const ms = Number(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * What the read covered. No window means the entity's whole recorded history,
 * so `lifetime` is the claim the prose and the payload both make.
 */
function entityScope(params: Record<string, string>): { scope: string; lifetime: boolean } {
  const from = windowEdge(params.after);
  const to = windowEdge(params.before);
  if (!from && !to) return { scope: 'lifetime', lifetime: true };
  return {
    scope: `${from ? `after ${from}` : 'start of history'} → ${to ? `before ${to}` : 'now'}`,
    lifetime: false,
  };
}

/** The plays read alongside a total. A sample, never the entity's whole history. */
type EntitySample = {
  streams: J[];
  limit: number;
  returned: number;
  truncated: boolean;
  unreadableReason: string | null;
  oldest: string | null;
  newest: string | null;
};

/**
 * The entity's own stream records, newest first, capped at `limit`.
 *
 * Verified live 2026-09-27: unlike `/users/{id}/streams`, this route IS
 * server-filtered to the entity, honours `limit` and `after`/`before`, and
 * ignores `offset` — so a short sample is the most recent plays, never a
 * page of the profile's mixed history.
 *
 * A failure here is contained rather than fatal. The total is read separately
 * and independently, so losing the sample costs the play list and the span,
 * not the figure. What it must never do is hide a total that was read (#803).
 */
async function readEntitySample(
  client: StatsfmClient,
  path: string,
  params: Record<string, string>,
  limit: number,
): Promise<EntitySample> {
  try {
    const body = await client.get<J>(path, { ...params, limit: String(limit) });
    const streams = collectionItems(body, path);
    const ends = streams.map((s) => s.endTime).filter((t) => typeof t === 'string') as string[];
    return {
      streams,
      limit,
      returned: streams.length,
      truncated: streams.length >= limit,
      unreadableReason: null,
      oldest: ends.length > 0 ? ends.reduce((a, b) => (a < b ? a : b)) : null,
      newest: ends.length > 0 ? ends.reduce((a, b) => (a > b ? a : b)) : null,
    };
  } catch (err) {
    // A 200-status error is this module's own envelope assertion firing, so it
    // means the code is wrong rather than the read having failed; filing it as
    // an upstream problem would bury the defect. Everything else genuinely is
    // an unreadable sample.
    if (err instanceof StatsfmApiError && err.status === 200) throw err;
    return {
      streams: [],
      limit,
      returned: 0,
      truncated: false,
      unreadableReason: unreadableLookupReason(err),
      oldest: null,
      newest: null,
    };
  }
}

/** A real per-entity total, plus whatever sample of the plays could be read. */
type EntityRead = {
  count: number;
  totalMs: number;
  cardinality: J | null;
  scope: string;
  lifetime: boolean;
  sample: EntitySample;
};

/**
 * The entity's stream total, read from stats.fm's own aggregate.
 *
 * #1006 recorded that no per-entity lifetime total was reachable, on the
 * evidence that `/users/{id}/streams` silently drops the entity filter and
 * `offset`. Both hold — and both are irrelevant here, because this reads a
 * different route, one the API documents at
 * `/api/v1/users/{userId}/streams/{tracks|artists|albums}/{entityId}/stats`
 * and answers with the entity's real `count` and `durationMs`. Verified live
 * 2026-09-27 against a 98,101-stream profile: a track the top chart reports
 * 122 lifetime plays returns `count: 162` here (the chart counts the newest
 * window it ranks; this is the whole record), and a track the profile has
 * never played returns `count: 0` — a measured zero, not a failed read.
 */
async function readEntityTotals(
  client: StatsfmClient,
  userId: string,
  filter: EntityFilter,
  entityId: string,
  params: Record<string, string>,
  sampleLimit: number,
): Promise<EntityRead> {
  const base = `/users/${encodeURIComponent(userId)}/streams/${ENTITY_SEGMENT[filter]}/${encodeURIComponent(entityId)}`;
  const statsPath = `${base}/stats`;
  const body = await client.get<J>(statsPath, params);
  const totals = entityTotals(entityStatsPayload(body, statsPath), statsPath);
  const sample = await readEntitySample(client, base, params, sampleLimit);
  return { ...totals, ...entityScope(params), sample };
}

/** Machine-readable payload. `source` says the total is measured, not derived. */
function entityPayload(label: string, read: EntityRead): J {
  return {
    label,
    count: read.count,
    totalMs: read.totalMs,
    // `null`, not 0. A mean over zero plays does not exist, and 0 is a number
    // that reads as "the average play lasted 0 ms" — a measurement of a play
    // that never happened. The prose half of this same read already omits the
    // mean at zero; reporting 0 here would make the payload contradict it.
    avgMs: read.count > 0 ? Math.round(read.totalMs / read.count) : null,
    source: 'stats.fm per-entity aggregate',
    scope: read.scope,
    lifetime: read.lifetime,
    cardinality: read.cardinality,
    sample_limit: read.sample.limit,
    sample_returned: read.sample.returned,
    sample_truncated: read.sample.truncated,
    sample_unreadable_reason: read.sample.unreadableReason,
    sample_oldest: read.sample.oldest,
    sample_newest: read.sample.newest,
  };
}

function formatEntitySummary(label: string, read: EntityRead, filter: EntityFilter): string {
  const { count, totalMs, sample } = read;
  // The mean of zero plays is undefined, so it is not printed: "avg 0m"
  // beside a measured zero would read as a measurement of a play that did
  // not happen.
  const avg = count > 0 ? ` (avg ${fmtPlayed(Math.round(totalMs / count))})` : '';
  const lead = `${label}: ${count} stream${count === 1 ? '' : 's'}, ${fmtPlayed(totalMs)} total${avg}`;
  const origin = read.lifetime
    ? `Lifetime total for this ${filter}, computed by stats.fm.`
    : `Total for the ${read.scope} window, computed by stats.fm for this ${filter}.`;
  if (sample.unreadableReason) {
    return `${lead}\n${origin}\nThe list of individual plays could not be read (${sample.unreadableReason}); the total above is unaffected.`;
  }
  if (sample.returned === 0) return `${lead}\n${origin}`;
  const span = sample.oldest && sample.newest ? ` (sampled span ${sample.oldest} → ${sample.newest})` : '';
  const what = sample.truncated
    ? `Sampled the ${sample.returned} most recent of ${count} plays${span}.`
    : `All ${sample.returned} play${sample.returned === 1 ? '' : 's'}${span}.`;
  return `${lead}\n${origin}\n${what}`;
}

/** Shared body of the six per-entity tools, so no one of them can drift. */
async function runEntityStats(
  client: StatsfmClient,
  args: J,
  filter: EntityFilter,
  idField: string,
  defaultLimit: number,
): Promise<ToolResult> {
  const entityId = String(args[idField]);
  const params: Record<string, string> = {};
  if (args.after !== undefined) params.after = String(args.after);
  if (args.before !== undefined) params.before = String(args.before);
  const read = await readEntityTotals(client, args.user_id as string, filter, entityId, params, args.limit ?? defaultLimit);
  const label = `${filter} ${entityId}`;
  const payload = entityPayload(label, read);
  if (args.response_format === 'json') {
    const body = { ...payload, streams: read.sample.streams };
    return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body };
  }
  return {
    content: [{ type: 'text', text: formatEntitySummary(label, read, filter) }],
    structuredContent: { ...payload, streams: read.sample.streams.slice(0, 10) },
  };
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

export function registerStatsfmTools(server: McpServer, client: StatsfmClient = statsfmClient()): void {
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
        range: statsfmRangeSchema,
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

  // 8–10. per-entity stream totals (track / artist / album), read from
  // stats.fm's own per-entity aggregate (#1006).
  const entityStats = [
    { name: 'statsfm_track_stats', filter: 'track' as const, idField: 'track_id' },
    { name: 'statsfm_artist_stats', filter: 'artist' as const, idField: 'artist_id' },
    { name: 'statsfm_album_stats', filter: 'album' as const, idField: 'album_id' },
  ];
  for (const cfg of entityStats) {
    server.tool(
      cfg.name,
      `stats.fm's own lifetime stream total for one ${cfg.filter} in a user's history, plus a sample of the individual plays`,
      {
        user_id: userIdSchema(),
        [cfg.idField]: z.union([z.string(), z.number()]).describe(`stats.fm ${cfg.filter} id`),
        limit: limitSchema(100, 50),
        response_format: ResponseFormat,
      },
      async (args) => runEntityStats(client, args as J, cfg.filter, cfg.idField, 50),
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
        range: statsfmRangeSchema,
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
      // Only claim a read failure when one happened: an empty friend list is
      // a complete answer, not a set of unreadable profiles (#803).
      if (unreadableRows.length > 0) lines.push('  (no friend profile could be read)');
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

  // 25–27. the same per-entity totals, narrowed to an after/before window.
  const dateStats = [
    { name: 'statsfm_track_date_stats', filter: 'track' as const, idField: 'track_id' },
    { name: 'statsfm_artist_date_stats', filter: 'artist' as const, idField: 'artist_id' },
    { name: 'statsfm_album_date_stats', filter: 'album' as const, idField: 'album_id' },
  ];
  for (const cfg of dateStats) {
    server.tool(
      cfg.name,
      `stats.fm's own stream total for one ${cfg.filter} within an after/before window, plus a sample of the individual plays`,
      {
        user_id: userIdSchema(),
        [cfg.idField]: z.union([z.string(), z.number()]).describe(`stats.fm ${cfg.filter} id`),
        after: afterSchema(),
        before: beforeSchema(),
        limit: limitSchema(500, 100),
        response_format: ResponseFormat,
      },
      async (args) => runEntityStats(client, args as J, cfg.filter, cfg.idField, 100),
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
