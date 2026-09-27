import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { Rfc6570UriTemplate } from './uritemplate.js';
import { SpotifyApiError, type SpotifyClient } from '../client.js';
import type {
  PlaybackState,
  SpotifyQueue,
  SpotifyPlaylistSimple,
  SpotifyTrack,
  SpotifyEpisode,
  RecentlyPlayedResponse,
  UserProfile,
  SpotifyArtistRow,
  SpotifyArtistFull,
  GetDevicesResponse,
  SpotifyPaged,
  SavedAlbumItem,
  SavedShowItem,
  SavedEpisodeItem,
  SavedTrackItem,
} from '../types/spotify.js';
import { playlistItemTotal } from '../types/spotify.js';
import { getConfig } from '../config.js';
import { truncationAdvice, type TruncationCapabilities } from '../shaping.js';
import { publisherAttribution, publisherByline } from '../removed.js';
import { walkFollowedArtists } from '../tools/following.js';
// #603: the device row renderer is the one get_devices uses, so the resource
// and the tool cannot drift on the #855 volume guard.
import { deviceLine, DEVICES_EMPTY_MESSAGE } from '../devices.js';
import { formatDuration } from '../result.js';
import { createResourceReadRegistry, watchableFor, type ResourceReadRegistry } from './subscriptions.js';

type RenderableItem = {
  type?: string;
  name?: string;
  uri?: string;
  duration_ms?: number;
  artists?: Array<{ name?: string }>;
  album?: { name?: string };
  show?: { name?: string };
  audiobook?: { name?: string; authors?: Array<{ name?: string }> };
  authors?: Array<{ name?: string }>;
};

function itemDetail(item: RenderableItem): string {
  if (item.type === 'track') {
    const artists = (item.artists ?? []).map((a) => a.name ?? 'unknown artist').join(', ') || 'unknown artist';
    return `by ${artists}${item.album?.name ? ` — ${item.album.name}` : ''}`;
  }
  if (item.type === 'episode' && item.show?.name) return `from ${item.show.name}`;
  if (item.type === 'chapter') {
    const book = item.audiobook;
    const authors = (book?.authors ?? []).map((a) => a.name ?? 'unknown author').join(', ');
    return `from ${book?.name ?? 'unknown audiobook'}${authors ? ` by ${authors}` : ''}`;
  }
  if (item.type === 'audiobook') {
    const authors = (item.authors ?? []).map((a) => a.name ?? 'unknown author').join(', ') || 'unknown author';
    return `by ${authors}`;
  }
  return item.type ?? 'item';
}

function formatItem(item: RenderableItem): string {
  const name = item.name ?? 'Untitled';
  const type = item.type ?? 'item';
  const duration = typeof item.duration_ms === 'number' ? ` (${formatDuration(item.duration_ms)})` : '';
  return `"${name}" (${type}) — ${itemDetail(item)}${duration} | URI: ${item.uri ?? 'unknown'}`;
}

function playlistTotal(playlist: SpotifyPlaylistSimple): number | 'unknown' {
  // `items.total` is canonical; `tracks.total` is the pre-Feb-2026 spelling and
  // only a fallback. Neither present is 'unknown', never 0 (#589).
  return playlistItemTotal(playlist) ?? 'unknown';
}

type ResourceError = SpotifyApiError | { status: number; retryAfterSec?: number };

function resourceError(error: unknown): ResourceError | null {
  if (error instanceof SpotifyApiError) return error;
  if (error === null || typeof error !== 'object' || !('status' in error)) return null;
  const status = error.status;
  if (typeof status !== 'number') return null;
  const retryAfterSec = 'retryAfterSec' in error && typeof error.retryAfterSec === 'number'
    ? error.retryAfterSec
    : undefined;
  return { status, retryAfterSec };
}

function gatedResourceResult(
  url: URL,
  uri: string,
  error: ResourceError,
  subject: string,
  rateLimitRetryAfterSec?: number | null,
): ResourceContents | null {
  if (![403, 404, 429].includes(error.status)) return null;
  const waitSeconds = error.retryAfterSec ?? rateLimitRetryAfterSec ?? undefined;
  const detail = error.status === 429
    ? `Spotify rate limited this resource (429). Retry after ${waitSeconds ?? 'an unspecified number of'} seconds.`
    : `${subject} is unavailable in this market or OAuth scope (${error.status}).`;
  if (wantsJson(url)) {
    return json(uri, {
      error: String(error.status),
      partial: false,
      ...(error.status === 429 && waitSeconds !== undefined ? { retry_after: waitSeconds } : {}),
    });
  }
  return text(uri, detail);
}

/**
 * Read-callback result. Aliased to the SDK's type because its zod-inferred
 * shape carries an index signature a hand-rolled interface cannot match.
 */
type ResourceContents = ReadResourceResult;

function text(uri: string, body: string): ResourceContents {
  return { contents: [{ uri, text: body, mimeType: 'text/plain' }] };
}

/** Raw-JSON variant (#59): programmatic consumers read this instead of prose. */
function json(uri: string, payload: unknown): ResourceContents {
  return {
    contents: [{ uri, text: JSON.stringify(payload, null, 2), mimeType: 'application/json' }],
  };
}

/**
 * True when the requested URI opted into the machine-readable variant
 * (`?format=json` on any resource URI, #59). Any other query still renders
 * prose.
 */
function wantsJson(url: URL): boolean {
  return url.searchParams.get('format') === 'json';
}

/**
 * For every resource whose walk is bounded by SPOTIFY_MCP_FETCH_ALL_CAP: the
 * tool a reader should use for the rest, and the continuation controls that
 * tool actually accepts (#718). The advice is rendered by the shared
 * `truncationAdvice` helper, so a capped resource names only controls its own
 * reader takes — the contract #919 established for tool footers.
 */
const CAPPED_RESOURCE_READERS: Record<string, { tool: string; capabilities: TruncationCapabilities }> = {
  'spotify://me/playlists': {
    tool: 'get_user_playlists',
    capabilities: { maxResults: true, offset: true, fetchAll: true },
  },
  'spotify://me/saved/albums': {
    tool: 'get_saved_albums',
    capabilities: { maxResults: true, offset: true, fetchAll: true },
  },
  'spotify://me/saved/shows': {
    tool: 'get_saved_shows',
    capabilities: { maxResults: true, offset: true, fetchAll: true },
  },
  'spotify://me/saved/episodes': {
    tool: 'get_saved_episodes',
    capabilities: { maxResults: true, offset: true, fetchAll: true },
  },
  'spotify://me/saved/audiobooks': {
    tool: 'get_saved_audiobooks',
    capabilities: { maxResults: true, limit: true, offset: true },
  },
  'spotify://me/followed/artists': {
    tool: 'get_followed_artists',
    capabilities: { maxResults: true, limit: true, fetchAll: true },
  },
};

/** What a capped walk proved, reconciled against what the API reported. */
interface WalkDisclosure {
  /** Rows the walk returned. */
  fetched: number;
  /**
   * True when rows are missing. Either the cap stopped the walk, or the
   * server's own `total` outran what the walk collected — a short page is
   * the normal end-of-data signal, but a `total` that disagrees with it
   * means the walk stopped short, and "complete" would be a completeness
   * nobody checked.
   */
  truncated: boolean;
  /** True only when the cap is what ended the walk, so the footer can say so. */
  cappedByCap: boolean;
  /**
   * The API-reported size, else null when a truncated walk could not read
   * one. A walked count is the number of rows returned, never the size of
   * the library — so a truncated walk with no reported total reports null.
   */
  total: number | null;
}

/**
 * Reconcile one capped walk into a single disclosure (#718).
 *
 * The verdict and the total come from the walk and the API's own number, and
 * are never inferred from the array length: a follow list or a saved library
 * that happens to END at exactly the cap dropped nothing, and a cap is a
 * ceiling, not a count. `truncated` says rows are missing; `cappedByCap` says
 * the cap is why, so the footer names the cap only when the cap is the reason
 * and otherwise says the walk came up short of a reported total — which is
 * what actually happened.
 */
function walkDisclosure(input: {
  fetched: number;
  truncated: boolean;
  cappedByCap: boolean;
  reportedTotal: number | null;
}): WalkDisclosure {
  // A reported total larger than the rows in hand proves rows are missing even
  // where the walk called itself complete, so the two are reconciled here
  // rather than trusting either one alone.
  const shortOfReportedTotal =
    input.reportedTotal !== null && input.reportedTotal > input.fetched;
  const truncated = input.truncated || shortOfReportedTotal;
  return {
    fetched: input.fetched,
    truncated,
    cappedByCap: input.cappedByCap,
    // The walked count is the number of rows returned, never the size of the
    // library: it stands in for `total` only on a walk that dropped nothing.
    total: input.reportedTotal ?? (truncated ? null : input.fetched),
  };
}

/**
 * The one truncation footer for a capped resource walk: which cap bit, how
 * much was read, and the controls the reader tool really has. A missing
 * reader row is a programming error, not a reason to stay silent.
 */
function capFooter(uri: string, disclosure: WalkDisclosure, cap: number): string {
  const reader = CAPPED_RESOURCE_READERS[uri];
  if (!reader) throw new Error(`No reader tool recorded for capped resource ${uri}`);
  // Name the cap only when the cap is the reason. A walk that stopped short
  // of the server's reported total without reaching the cap did not hit the
  // cap, and saying so would blame a ceiling that never bound it.
  const cause = disclosure.cappedByCap
    ? `truncated at SPOTIFY_MCP_FETCH_ALL_CAP (${cap})`
    : `incomplete: the API reports ${disclosure.total} and this walk read ${disclosure.fetched}`;
  return (
    `... ${cause} — read ${disclosure.fetched}; ` +
    `use ${reader.tool} for the rest: ${truncationAdvice(reader.capabilities)}`
  );
}

/** Prose body, with the truncation footer appended only when rows are missing. */
function withCapFooter(
  uri: string,
  body: string,
  disclosure: WalkDisclosure,
  cap: number,
): string {
  return disclosure.truncated ? `${body}\n${capFooter(uri, disclosure, cap)}` : body;
}

/**
 * Machine-readable capped-walk payload (#718). `total` is what the API
 * reported, and stays null when a truncated walk could not read it.
 */
function cappedJson(
  uri: string,
  items: unknown[],
  disclosure: WalkDisclosure,
  cap: number,
): ResourceContents {
  return json(uri, {
    total: disclosure.total,
    truncated: disclosure.truncated,
    cap,
    ...(disclosure.truncated ? { truncation_note: capFooter(uri, disclosure, cap) } : {}),
    items,
  });
}

/** Prose count line shared by the resources that report an API total. */
function shownCount(disclosure: WalkDisclosure): string {
  if (disclosure.total === null) return `${disclosure.fetched} read`;
  return disclosure.truncated
    ? `${disclosure.total} total, showing ${disclosure.fetched}`
    : `${disclosure.total} total`;
}

/**
 * @param reads
 *   Where the renderers of every *watchable* resource are recorded (#597), so
 *   a subscription poll re-reads through the same function `resources/read`
 *   uses. It defaults to a private registry, so a caller that wants no
 *   subscriptions — every existing test, and every toolset trimming that keeps
 *   resources — pays nothing and registers nothing extra. The three parameters
 *   of `buildMcpServer` are the only production path that passes one.
 */
export function registerResources(
  server: McpServer,
  client: SpotifyClient,
  reads: ResourceReadRegistry = createResourceReadRegistry(),
): void {
  // #59 freshness note: every resource below goes through the shared client,
  // so catalog-backed reads are served from the short-TTL cache (~5 min)
  // while /me/player* paths bypass it and stay live (#32/#54).
  //
  // A resource is registered at its bare URI and, once, as a query-absorbing
  // template. Two entries rather than one because the MCP SDK resolves
  // `resources/read` by **exact URI string** first, so a fixed registration can
  // only ever answer the bare URI — `spotify://me?format=json` is a different
  // key and reaches the template. Two rather than three because the third —
  // a `{+qs}` catch-all beside the `{?…}` template — is gone (#685): the
  // `{?…}` entry, compiled by `Rfc6570UriTemplate`, already matches the bare
  // URI, every declared parameter in any order, any subset, and any undeclared
  // pair. Both entries share one renderer, so `?format=json` and the bare read
  // are two spellings of one answer; `wantsJson` picks prose vs raw JSON.

  /**
   * Register `render` at `uri` and at the one query-absorbing template that
   * serves every URI carrying a query string (#685).
   *
   * `params` is a list of `[name, doc]` pairs rather than bare names, so the
   * bound, default and valid values of every parameter are stated once in the
   * registry and reach both registered entries. #883's lens applies to
   * resources for the same reason it applies to tools: these parameters are
   * where a natural-language request becomes a number, and this read
   * *silently* normalises rather than failing. `?limit=999` clamps to 50 and
   * `?time_range=all_time` falls back to `medium_term` — a caller that guessed
   * the bound gets a shorter window than it asked for, or the wrong window
   * entirely, and nothing in the response says the request was rewritten. The
   * number is the only warning, and a number is not a warning. So the range,
   * the default and the legal values of an enum are stated in the description
   * the caller reads before building the URI.
   *
   * The template is the advertising surface: it names the parameter set a host
   * may build a URI from, and its own zero-variable expansion is the bare URI,
   * so a host that hands back the `uriTemplate` string it just read resolves to
   * the documented defaults rather than to "resource not found".
   */
  const registerResource = (
    name: string,
    uri: string,
    description: string,
    render: (url: URL) => Promise<ResourceContents>,
    params?: readonly (readonly [string, string])[],
  ): void => {
    const renderWithApiErrors = async (url: URL): Promise<ResourceContents> => {
      try {
        return await render(url);
      } catch (error) {
        const expected = resourceError(error);
        if (!expected) throw error;
        const rateLimit = client.getRateLimitStatus();
        const result = gatedResourceResult(url, uri, expected, name, rateLimit.retryAfterSec);
        if (result) return result;
        throw error;
      }
    };
    // #603: when a resource takes real query parameters, BOTH the parameter set
    // and the `?format=json` form are named on every registered entry. Each
    // entry is its own line in a listing with its own description, and a host
    // reading the template entry sees only that one — a parameter set
    // documented solely on the bare entry does not reach the reader who is
    // about to build a URI with it.
    //
    // #597: a watchable resource says so HERE, on both of its entries, because
    // this description is the only place a host learns it may subscribe. The
    // note is appended to both entries for the same reason the parameter set
    // is: a note documented on one entry does not reach a host reading the
    // other. It states the *promise* and, more importantly, what is not a
    // change — a host that subscribes on the strength of a sentence that did not
    // say the playback position advances is subscribed to a stream of noise.
    const watch = watchableFor(uri);
    if (watch) reads.register(uri, render);
    const watchNote = watch ? ` ${watch.note}` : '';
    const suffix =
      params && params.length > 0 ? ` Parameters: ${params.map(([p, doc]) => `?${p} (${doc})`).join(', ')}.` : '';
    const jsonNote = ' (?format=json returns raw JSON)';
    const query = ['format', ...(params ?? []).map(([p]) => p)];
    server.resource(name, uri, { description: `${description}${suffix}${watchNote}`, mimeType: 'text/plain' }, renderWithApiErrors);
    // #1401: the `{?…}` entry is a real router, not one plus a decoy. It used
    // to be the SDK's stricter `^…\?a=([^&]+)&b=([^&]+)&c=([^&]+)$`, which
    // needed every parameter present and adjacent, so
    // `…?time_range=short_term&limit=5` matched nothing and the advertised
    // entry could never route. What it replaced — a `{+qs}` catch-all — is
    // gone, and the thing that has to keep working in its place is spelled
    // out above: an undeclared parameter, a typo, or a declared one sent in
    // an order the template does not expand to still routes here, because
    // `matchFormStyle` reads the declared names as an ordered subsequence and
    // lets everything else through. A *path* difference still matches nothing:
    // the matcher requires a real `?`, so `spotify://me/saved/tracksX` is a
    // different resource and is rejected, where the SDK's bare `(.+)` matched
    // it and served saved tracks.
    server.resource(
      `${name}-query`,
      new ResourceTemplate(new Rfc6570UriTemplate(`${uri}{?${query.join(',')}}`), { list: undefined }),
      {
        description: `Query-string variant of '${uri}'${jsonNote}${suffix}${watchNote}`,
        mimeType: 'text/plain',
      },
      renderWithApiErrors,
    );
  };

  // --- #603: query-parameter parsing for the paged resources -----------------
  //
  // Bounds are the Feb-2026 OpenAPI values for these endpoints: `limit` is
  // 0–50 (the repo's tool schemas use 1–50, and 0 is a useless page size), and
  // `offset` is unbounded above in the schema. An unparseable or out-of-range
  // value falls back to the API default rather than failing the read, matching
  // how `spotify://me/saved/tracks` already behaves (#603 pattern).
  const intParam = (url: URL, key: string, fallback: number, min: number, max: number): number => {
    const parsed = Number.parseInt(url.searchParams.get(key) ?? '', 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  };

  /** The three windows Spotify documents for `/me/top/{type}`'s `time_range`. */
  const TIME_RANGES = new Set(['long_term', 'medium_term', 'short_term']);

  /**
   * `time_range` is the one parameter here that is not a number, and the
   * OpenAPI schema carries no `enum` for it — only a description naming
   * `long_term` / `medium_term` / `short_term`. An unrecognised window is not
   * forwarded: Spotify would answer 400 for a value it does not accept, and a
   * resource read failing on a typo is worse than one that reads the default.
   */
  const timeRangeParam = (url: URL): string => {
    const raw = url.searchParams.get('time_range');
    return raw && TIME_RANGES.has(raw) ? raw : 'medium_term';
  };

  // #603/#883: the parameter contract, stated once. These strings are not
  // decoration — they are the same bounds `intParam` and `timeRangeParam`
  // enforce a few lines above, written down so a caller can read the limit
  // instead of inferring it from a silently-clamped response. If a bound moves,
  // move it here and the registered description follows.
  const LIMIT_DOC = '1-50, default 20; values outside the range are clamped';
  const OFFSET_DOC = 'zero-based, default 0';
  /** The playlist-items page is the one window here that is 1–100, not 1–50. */
  const PLAYLIST_TRACKS_LIMIT_DOC = '1-100, default 100; values outside the range are clamped';
  const TIME_RANGE_DOC = 'long_term | medium_term | short_term, default medium_term; any other value reads medium_term';
  const CURSOR_DOC = 'Unix epoch milliseconds';

  // spotify://me — current user profile
  registerResource(
    'me',
    'spotify://me',
    "Current user profile ('?format=json' returns the raw API object)",
    async (url) => {
      const profile = await client.get<UserProfile>('/me');
      if (!profile) throw new Error('Could not retrieve user profile');
      if (wantsJson(url)) return json('spotify://me', profile);
      return text(
        'spotify://me',
        `User: ${profile.display_name ?? profile.id}\nID: ${profile.id}\nURI: ${profile.uri}`,
      );
    },
  );

  // spotify://player/state — current playback state (live; never cached)
  registerResource(
    'player-state',
    'spotify://player/state',
    "Current Spotify playback state (live; '?format=json' returns the raw API object)",
    async (url) => {
      const state = await client.get<Omit<PlaybackState, 'item'> & { item: RenderableItem | null }>('/me/player', {
        additional_types: 'track,episode,audiobook',
      });
      // #597: the JSON spelling is answered BEFORE the idle check. `/me/player`
      // answers 204 with no body when there is no active session, and the
      // client surfaces that as `null`; the prose branch below turns it into a
      // `text/plain` sentence, so a consumer that asked for JSON — including
      // this server's own change poll — got something it could not parse, and
      // the one state a subscriber most needs to notice (playback ended) was
      // the one state that could not be read. `null` is the honest JSON for
      // "the endpoint returned no state", and it is distinct from an object
      // with a null item, which the API does send.
      if (wantsJson(url)) return json('spotify://player/state', state ?? null);
      if (!state || !state.item) {
        return text('spotify://player/state', 'Nothing is currently playing.');
      }
      const { item, is_playing, shuffle_state, repeat_state, device, progress_ms } = state;
      const lines: string[] = [
        `${is_playing ? 'Playing' : 'Paused'}: ${formatItem(item)}`,
        `Progress: ${formatDuration(progress_ms ?? 0)}${typeof item.duration_ms === 'number' ? ` / ${formatDuration(item.duration_ms)}` : ''}`,
      ];
      if (item.album?.name) lines.push(`Album: ${item.album.name}`);
      if (item.show?.name) lines.push(`Show: ${item.show.name}`);
      if (device) {
        lines.push(`Device: ${device.name} (${device.type})`);
      } else {
        lines.push('Device: none active');
      }
      lines.push(`Shuffle: ${shuffle_state ? 'on' : 'off'} | Repeat: ${repeat_state}`);
      return text('spotify://player/state', lines.join('\n'));
    },
  );

  // spotify://player/queue — current queue (live)
  registerResource(
    'player-queue',
    'spotify://player/queue',
    "Current playback queue ('?format=json' returns the raw API object)",
    async (url) => {
      const queue = await client.get<SpotifyQueue>('/me/player/queue');
      // Same #597 reorder as `spotify://player/state`: the JSON spelling is
      // answered before the empty-session branch, so "no active session" is
      // readable as JSON rather than arriving as a sentence.
      if (wantsJson(url)) return json('spotify://player/queue', queue ?? null);
      if (!queue) {
        return text('spotify://player/queue', 'No active playback session.');
      }
      const lines: string[] = [];
      if (queue.currently_playing) {
        lines.push(`Currently playing: ${formatItem(queue.currently_playing)}`);
      }
      if (queue.queue.length === 0) {
        lines.push('Queue is empty.');
      } else {
        lines.push('Up next:');
        queue.queue.slice(0, 20).forEach((item, i) => {
          lines.push(`  ${i + 1}. ${formatItem(item)}`);
        });
        if (queue.queue.length > 20) lines.push(`  ... and ${queue.queue.length - 20} more`);
      }
      return text('spotify://player/queue', lines.join('\n'));
    },
  );

  // spotify://player/devices — available Spotify Connect devices (live) (#603).
  // The gap this closes: every playback command on an OpenClaw-style host used
  // to start with a `get_devices` tool call, costing a turn and quota to learn
  // a fact that is ambient state. Same row renderer as the tool, so the two
  // cannot drift on the #855 volume guard — see src/devices.ts.
  registerResource(
    'player-devices',
    'spotify://player/devices',
    "Available Spotify Connect devices, with the active one flagged (live; '?format=json' returns the raw API object)",
    async (url) => {
      const result = await client.get<GetDevicesResponse>('/me/player/devices');
      if (!result || result.devices.length === 0) {
        return text('spotify://player/devices', DEVICES_EMPTY_MESSAGE);
      }
      if (wantsJson(url)) return json('spotify://player/devices', result);
      const devices = result.devices;
      const lines = ['Devices:'];
      for (const device of devices) lines.push(deviceLine(device));
      const active = devices.find((d) => d.is_active);
      // #603's acceptance criterion is that this lists the same devices as
      // get_devices including the active flag, so name the active one here
      // rather than making a reader scan the [ACTIVE] marker.
      lines.push(
        active
          ? `Active device: ${active.name} (${active.type}) — ID: ${active.id ?? 'n/a'}`
          : 'No active device. Open Spotify on a device to make it available.',
      );
      return text('spotify://player/devices', lines.join('\n'));
    },
  );

  // spotify://me/top/tracks — top tracks, windowed by query parameters (#603).
  // The rows and the header shape are the ones get_top_tracks prints, so a
  // host that has read one has read the other.
  registerResource(
    'top-tracks',
    'spotify://me/top/tracks',
    "User's top tracks ('?format=json' returns the raw API object)",
    async (url) => {
      const timeRange = timeRangeParam(url);
      const limit = intParam(url, 'limit', 20, 1, 50);
      const offset = intParam(url, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
      const result = await client.get<SpotifyPaged<SpotifyTrack>>('/me/top/tracks', {
        time_range: timeRange,
        limit: String(limit),
        offset: String(offset),
      });
      if (!result) throw new Error('Could not retrieve top tracks');
      if (wantsJson(url)) return json('spotify://me/top/tracks', result);
      // Same defensive shape as get_top_tracks: Spotify can answer 200 with a
      // null/undefined `items`, and reading `.length` on that crashes.
      const items = Array.isArray(result.items) ? result.items : [];
      const total = typeof result.total === 'number' ? result.total : items.length;
      const uri = 'spotify://me/top/tracks';
      if (items.length === 0) {
        return text(uri, `No top tracks found (${timeRange}; total: ${total}).`);
      }
      const lines = [`Top tracks (${timeRange}; ${total} total, showing ${items.length} at offset ${offset}):`];
      items.forEach((track, i) => {
        const artists = track.artists.map((a) => a.name).join(', ');
        lines.push(
          `  ${offset + i + 1}. "${track.name}" by ${artists} (${formatDuration(track.duration_ms)}) | URI: ${track.uri}`,
        );
      });
      // Say so when rows are left: a windowed read that stops at `limit` is a
      // page, and a page printed without its continuation reads as the whole
      // list. This is the same failure class #718 fixed for the saved walks.
      const hasMore = typeof result.total === 'number' ? offset + items.length < result.total : items.length === limit;
      if (hasMore) {
        lines.push(`... more available — re-read with ?offset=${offset + items.length} (or ?limit=50).`);
      }
      return text(uri, lines.join('\n'));
    },
    [
      ['time_range', TIME_RANGE_DOC],
      ['limit', LIMIT_DOC],
      ['offset', OFFSET_DOC],
    ],
  );

  // spotify://me/top/artists — top artists, windowed by query parameters (#603).
  registerResource(
    'top-artists',
    'spotify://me/top/artists',
    "User's top artists ('?format=json' returns the raw API object)",
    async (url) => {
      const timeRange = timeRangeParam(url);
      const limit = intParam(url, 'limit', 20, 1, 50);
      const offset = intParam(url, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
      const result = await client.get<SpotifyPaged<SpotifyArtistRow>>('/me/top/artists', {
        time_range: timeRange,
        limit: String(limit),
        offset: String(offset),
      });
      if (!result) throw new Error('Could not retrieve top artists');
      if (wantsJson(url)) return json('spotify://me/top/artists', result);
      const items = Array.isArray(result.items) ? result.items : [];
      const total = typeof result.total === 'number' ? result.total : items.length;
      const uri = 'spotify://me/top/artists';
      if (items.length === 0) {
        return text(uri, `No top artists found (${timeRange}; total: ${total}).`);
      }
      const lines = [`Top artists (${timeRange}; ${total} total, showing ${items.length} at offset ${offset}):`];
      items.forEach((artist, i) => {
        const genres =
          Array.isArray(artist.genres) && artist.genres.length > 0 ? artist.genres.join(', ') : 'no genres listed';
        lines.push(`  ${offset + i + 1}. ${artist.name} — ${genres} | URI: ${artist.uri}`);
      });
      const hasMore = typeof result.total === 'number' ? offset + items.length < result.total : items.length === limit;
      if (hasMore) {
        lines.push(`... more available — re-read with ?offset=${offset + items.length} (or ?limit=50).`);
      }
      return text(uri, lines.join('\n'));
    },
    [
      ['time_range', TIME_RANGE_DOC],
      ['limit', LIMIT_DOC],
      ['offset', OFFSET_DOC],
    ],
  );

  // spotify://me/recently-played — recently played, windowed by query parameters
  // (#603).
  //
  // NO `offset`. GET /me/player/recently-played is a cursor endpoint: the
  // OpenAPI schema gives it `limit`, `after` and `before`, and no `offset`
  // (verified against the Feb-2026 schema). The issue's parameter list names
  // `time_range, limit, offset` generically, but forwarding `offset` here would
  // be sending a parameter the endpoint does not declare — Spotify rejects
  // unknown query parameters with a 400, so a resource that advertised `?offset`
  // would fail rather than page. `after`/`before` are Unix-ms cursors: page
  // forward with the earliest `played_at` on the page.
  registerResource(
    'recently-played',
    'spotify://me/recently-played',
    "Recently played tracks ('?format=json' returns the raw API object)",
    async (url) => {
      const limit = intParam(url, 'limit', 20, 1, 50);
      // `after`/`before` are unbounded cursors, not bounded page controls, so
      // they are only forwarded when they parse as a timestamp.
      const cursorParam = (key: string): string | undefined => {
        const raw = url.searchParams.get(key);
        if (raw === null) return undefined;
        const parsed = Number.parseInt(raw, 10);
        return Number.isFinite(parsed) && parsed >= 0 ? String(parsed) : undefined;
      };
      const after = cursorParam('after');
      const before = cursorParam('before');
      const result = await client.get<RecentlyPlayedResponse>('/me/player/recently-played', {
        limit: String(limit),
        ...(after ? { after } : {}),
        ...(before ? { before } : {}),
      });
      if (!result) throw new Error('Could not retrieve recently played');
      if (wantsJson(url)) return json('spotify://me/recently-played', result);
      const items = Array.isArray(result.items) ? result.items : [];
      if (items.length === 0) {
        return text('spotify://me/recently-played', 'No recently played tracks for that window.');
      }
      const lines = [`Recently played (${items.length}${items.length === limit ? ', more available' : ''}):`];
      for (const item of items) {
        const artists = item.track.artists.map((a) => a.name).join(', ');
        const playedAt = new Date(item.played_at).toLocaleString();
        lines.push(`  • "${item.track.name}" by ${artists} — ${playedAt} | URI: ${item.track.uri}`);
      }
      // A full page means the walk stopped on the cap, not that the history
      // ended. The next cursor is the earliest played_at on this page, and
      // naming it is the only way a host can page a cursor endpoint.
      if (items.length === limit) {
        const oldest = items.reduce((min, i) => (Date.parse(i.played_at) < min ? Date.parse(i.played_at) : min), Infinity);
        if (Number.isFinite(oldest)) {
          lines.push(`... page further back with ?after=${oldest} (the oldest played_at on this page).`);
        }
      }
      return text('spotify://me/recently-played', lines.join('\n'));
    },
    [
      ['limit', LIMIT_DOC],
      ['after', `${CURSOR_DOC}; page further back`],
      ['before', `${CURSOR_DOC}; page forward`],
    ],
  );

  // spotify://me/playlists — all user playlists
  registerResource(
    'playlists',
    'spotify://me/playlists',
    "All user playlists, names and IDs ('?format=json' returns the raw items)",
    async (url) => {
      const cap = getConfig().fetchAllCap;
      // The API reports the true playlist count on page 1. Reading it means a
      // walk stopped at the cap can still say how many playlists exist instead
      // of reporting the rows it managed to collect. It is the same request
      // the walk's first page makes, so the TTL cache serves it.
      const firstPage = await client.get<SpotifyPaged<SpotifyPlaylistSimple>>('/me/playlists', {
        limit: '50',
        offset: '0',
      });
      const walk = await client.getAllPagesWithTruncation<SpotifyPlaylistSimple>(
        '/me/playlists',
        { limit: '50' },
        { maxItems: cap },
      );
      // The walk reports both the verdict and the cause; the first-page read
      // exists only because `/me/playlists` can be asked for its total, and
      // the TTL cache serves it (same request, same key) so it costs no call.
      const disclosure = walkDisclosure({
        fetched: walk.items.length,
        truncated: walk.truncated,
        cappedByCap: walk.truncatedByCap,
        reportedTotal: walk.reportedTotal ?? (typeof firstPage?.total === 'number' ? firstPage.total : null),
      });
      if (wantsJson(url)) {
        return cappedJson('spotify://me/playlists', walk.items, disclosure, cap);
      }
      if (walk.items.length === 0) {
        return text('spotify://me/playlists', 'No playlists found.');
      }
      const lines = walk.items.map((pl) => {
        const count = playlistTotal(pl);
        return `  • "${pl.name}" (${count === 'unknown' ? 'unknown item count' : `${count} items`}) | ID: ${pl.id} | URI: ${pl.uri}`;
      });
      return text(
        'spotify://me/playlists',
        withCapFooter(
          'spotify://me/playlists',
          `Playlists (${shownCount(disclosure)}):\n${lines.join('\n')}`,
          disclosure,
          cap,
        ),
      );
    },
  );

  // --- Saved library resources (#59): hosts polling these get library
  // visibility without tool calls; served through the TTL-cached catalog
  // path, capped at SPOTIFY_MCP_FETCH_ALL_CAP.
  //
  // #603 adds `?limit`/`?offset`. Supplying either switches the read from the
  // capped whole-library walk to a SINGLE paged read of that window. The
  // walk stays the default precisely because it is the reading that carries the
  // #718 cap verdict: a one-page read is not a truncated library and must not be
  // dressed up with a truncation footer it did not earn. The window path
  // therefore reports the API's own `total` and a continuation hint instead.
  const registerSavedResource = <T>(
    name: string,
    uri: string,
    apiPath: string,
    label: string,
    collection: string,
    renderProse: (items: T[], header: string) => string,
  ): void => {
    registerResource(
      name,
      uri,
      label,
      async (url) => {
        const windowed = url.searchParams.has('limit') || url.searchParams.has('offset');
        if (windowed) {
          const limit = intParam(url, 'limit', 20, 1, 50);
          const offset = intParam(url, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
          const page = await client.get<SpotifyPaged<T>>(apiPath, {
            limit: String(limit),
            offset: String(offset),
          });
          if (!page) throw new Error(`Could not retrieve ${collection.toLowerCase()}`);
          if (wantsJson(url)) return json(uri, page);
          const items = Array.isArray(page.items) ? page.items : [];
          if (items.length === 0) {
            return text(uri, `No saved items at offset ${offset}.`);
          }
          const total = typeof page.total === 'number' ? page.total : items.length;
          const header = `${collection} — ${items.length} of ${total}, at offset ${offset}:`;
          // A page is a page: report the window, and name the continuation.
          const continuation =
            offset + items.length < total ? `\n... more available — re-read with ?offset=${offset + items.length}` : '';
          return text(uri, `${renderProse(items, header)}${continuation}`);
        }

        const cap = getConfig().fetchAllCap;
        const walk = await client.getAllPagesWithTruncation<T>(
          apiPath,
          { limit: '50' },
          { maxItems: cap },
        );
        const disclosure = walkDisclosure({
          fetched: walk.items.length,
          truncated: walk.truncated,
          cappedByCap: walk.truncatedByCap,
          reportedTotal: walk.reportedTotal,
        });
        if (wantsJson(url)) {
          return cappedJson(uri, walk.items, disclosure, cap);
        }
        return text(uri, withCapFooter(uri, renderProse(walk.items, `${collection} (${walk.items.length}):`), disclosure, cap));
      },
      [
        ['limit', LIMIT_DOC],
        ['offset', OFFSET_DOC],
      ],
    );
  };

  // spotify://me/saved/albums
  registerSavedResource<SavedAlbumItem>(
    'saved-albums',
    'spotify://me/saved/albums',
    '/me/albums',
    'Albums saved in your library',
    'Saved albums',
    (items, header) => {
      if (items.length === 0) return 'No saved albums.';
      const lines = items.map(({ added_at, album }) => {
        const artists = album.artists.map((a) => a.name).join(', ');
        return `  • "${album.name}" — ${artists} (${album.release_date}, ${album.total_tracks} tracks, added ${added_at.slice(0, 10)}) | ID: ${album.id}`;
      });
      return `${header}\n${lines.join('\n')}`;
    },
  );

  // spotify://me/saved/shows
  registerSavedResource<SavedShowItem>(
    'saved-shows',
    'spotify://me/saved/shows',
    '/me/shows',
    'Podcast shows saved in your library',
    'Saved shows',
    (items, header) => {
      if (items.length === 0) return 'No saved shows.';
      // #639: `publisher` was removed from Show payloads in Feb 2026, and this
      // line used to fill the byline with the literal string
      // `unknown publisher` — a stand-in press name that reads exactly like a
      // show published by someone called "unknown publisher". The byline is
      // now dropped instead, and the reason is stated ONCE below the list
      // rather than repeated on every row: a reader who sees a show with no
      // byline needs to know the field is gone, not guess that this server
      // forgot it. A grandfathered registration that still sends `publisher`
      // keeps its byline, because a real name is not the problem.
      const withoutPublisher = items.filter(({ show }) => !publisherAttribution(show.publisher)).length;
      const lines = items.map(({ added_at, show }) =>
        `  • "${show.name}"${publisherByline(show.publisher)} (${show.total_episodes} episodes, added ${added_at.slice(0, 10)}) | ID: ${show.id}`,
      );
      if (withoutPublisher > 0) {
        lines.push(
          `(${withoutPublisher} of ${items.length} show(s) carry no byline: Spotify removed \`publisher\` from show payloads in`
            + ' February 2026, so it cannot be read. Shows that still report one are printed above.)',
        );
      }
      return `${header}\n${lines.join('\n')}`;
    },
  );

  // spotify://me/saved/episodes
  registerSavedResource<SavedEpisodeItem>(
    'saved-episodes',
    'spotify://me/saved/episodes',
    '/me/episodes',
    'Podcast episodes saved in your library',
    'Saved episodes',
    (items, header) => {
      if (items.length === 0) return 'No saved episodes.';
      const lines = items.map(({ added_at, episode }) =>
        `  • "${episode.name}" — ${episode.show.name} (${formatDuration(episode.duration_ms)}, released ${episode.release_date.slice(0, 10)}, added ${added_at.slice(0, 10)}) | ID: ${episode.id}`,
      );
      return `${header}\n${lines.join('\n')}`;
    },
  );

  // --- #218: additional saved-library resources --------------------------------

  // spotify://me/saved/tracks — paginated with ?offset&limit, prose "name by artist | URI".
  // #685: this was the one resource still registering its three entries by
  // hand, with the parameter set written out twice. It is the same
  // bare-plus-one-query-template shape `registerResource` describes, so it
  // goes through it and keeps its own renderer and bounds — the difference is
  // the wording in the description, not the wiring.
  (() => {
    const uri = 'spotify://me/saved/tracks';
    const parseWithPagination = (url: URL) => {
      const intParam = (key: string, fallback: number): number => {
        const v = Number.parseInt(url.searchParams.get(key) ?? '', 10);
        return Number.isFinite(v) ? v : fallback;
      };
      return {
        offset: Math.max(0, intParam('offset', 0)),
        limit: Math.min(50, Math.max(1, intParam('limit', 20))),
        jsonFormat: wantsJson(url),
      };
    };
    const render = async (url: URL): Promise<ResourceContents> => {
      const { offset, limit, jsonFormat } = parseWithPagination(url);
      const result = await client.get<SpotifyPaged<SavedTrackItem>>('/me/tracks', {
        limit: String(limit),
        offset: String(offset),
      });
      if (!result) throw new Error('Could not retrieve saved tracks');
      if (jsonFormat) return json(uri, result);
      const entries = result.items ?? [];
      if (entries.length === 0) return text(uri, offset === 0 ? 'No saved tracks.' : `No saved tracks at offset ${offset}.`);
      const header = `Saved tracks (${result.total ?? entries.length} total, showing ${entries.length} at offset ${offset}):`;
      const lines = entries.map(({ added_at, track }, i) => {
        const artists = track.artists.map((a) => a.name).join(', ');
        return `  ${offset + i + 1}. "${track.name}" by ${artists} | URI: ${track.uri} (added ${added_at.slice(0, 10)})`;
      });
      const hasMore = typeof result.total === 'number' ? offset + entries.length < result.total : entries.length === limit;
      const footer = hasMore ? `\n... more available — re-read with ?offset=${offset + entries.length}` : '';
      return text(uri, `${header}\n${lines.join('\n')}${footer}`);
    };
    registerResource(
      'saved-tracks',
      uri,
      "Tracks saved in your library, paginated via ?offset&limit ('?format=json' returns raw paged object)",
      render,
      [
        ['offset', OFFSET_DOC],
        ['limit', LIMIT_DOC],
      ],
    );
  })();

  // spotify://me/followed/artists — cursor walk via /me/following
  (() => {
    const uri = 'spotify://me/followed/artists';
    const render = async (url: URL): Promise<ResourceContents> => {
      const cap = getConfig().fetchAllCap;
      // The same cursor walk get_followed_artists runs (#744): it reports the
      // cap verdict and the server-reported total instead of slicing silently,
      // so the resource cannot present a capped walk as the whole follow list.
      const walk = await walkFollowedArtists(client);
      const disclosure = walkDisclosure({
        fetched: walk.items.length,
        // The cursor walk reports its own verdict; rows are also missing when
        // the server's total outruns what the walk collected.
        truncated: walk.truncatedByCap || (walk.reportedTotal !== null && walk.reportedTotal > walk.items.length),
        cappedByCap: walk.truncatedByCap,
        reportedTotal: walk.reportedTotal,
      });
      if (wantsJson(url)) {
        return cappedJson(uri, walk.items, disclosure, cap);
      }
      if (walk.items.length === 0) return text(uri, 'No followed artists.');
      const lines = walk.items.map((a, i) => {
        const genres = Array.isArray(a.genres) && a.genres.length > 0 ? a.genres.join(', ') : 'no genres';
        return `  ${i + 1}. ${a.name} — ${genres} | URI: ${a.uri}`;
      });
      return text(
        uri,
        withCapFooter(uri, `Followed artists (${shownCount(disclosure)}):\n${lines.join('\n')}`, disclosure, cap),
      );
    };
    registerResource('followed-artists', uri, "Artists you follow ('?format=json' returns the raw items)", render);
  })();

  // spotify://me/saved/audiobooks — /me/audiobooks
  (() => {
    const uri = 'spotify://me/saved/audiobooks';
    type AudiobookRow = { added_at: string; audiobook: { id: string; name: string; uri: string; authors?: Array<{ name: string }> } };
    const renderRows = (items: AudiobookRow[]) =>
      items.map(({ added_at, audiobook }) => {
        const authors = (audiobook.authors ?? []).map((a) => a.name).join(', ') || 'unknown author';
        return `  • "${audiobook.name}" — ${authors} (added ${added_at.slice(0, 10)}) | ID: ${audiobook.id}`;
      });
    const render = async (url: URL): Promise<ResourceContents> => {
      // #603: `?limit`/`?offset` read one paged window instead of walking the
      // whole library. Same rule as the other saved resources: the walk is the
      // default because it is the reading that carries the #718 cap verdict, so
      // a single page must not be presented as a truncated walk.
      if (url.searchParams.has('limit') || url.searchParams.has('offset')) {
        const limit = intParam(url, 'limit', 20, 1, 50);
        const offset = intParam(url, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
        const page = await client.get<SpotifyPaged<AudiobookRow>>('/me/audiobooks', {
          limit: String(limit),
          offset: String(offset),
        });
        if (!page) throw new Error('Could not retrieve saved audiobooks');
        if (wantsJson(url)) return json(uri, page);
        const items = Array.isArray(page.items) ? page.items : [];
        if (items.length === 0) return text(uri, `No saved audiobooks at offset ${offset}.`);
        const total = typeof page.total === 'number' ? page.total : items.length;
        const header = `Saved audiobooks — ${items.length} of ${total}, at offset ${offset}:`;
        const continuation =
          offset + items.length < total ? `\n... more available — re-read with ?offset=${offset + items.length}` : '';
        return text(uri, `${header}\n${renderRows(items).join('\n')}${continuation}`);
      }

      let items: AudiobookRow[];
      let truncated: boolean;
      let truncatedByCap: boolean;
      let reportedTotal: number | null;
      const cap = getConfig().fetchAllCap;
      try {
        const walk = await client.getAllPagesWithTruncation<AudiobookRow>(
          '/me/audiobooks',
          { limit: '50' },
          { maxItems: cap },
        );
        items = walk.items;
        truncated = walk.truncated;
        truncatedByCap = walk.truncatedByCap;
        reportedTotal = walk.reportedTotal;
      } catch (error) {
        const expected = resourceError(error);
        if (expected) {
          const rateLimit = client.getRateLimitStatus();
          const result = gatedResourceResult(url, uri, expected, 'Audiobooks', rateLimit.retryAfterSec);
        }
        throw error;
      }
      const disclosure = walkDisclosure({
        fetched: items.length,
        truncated,
        cappedByCap: truncatedByCap,
        reportedTotal,
      });
      if (wantsJson(url)) {
        return cappedJson(uri, items, disclosure, cap);
      }
      if (items.length === 0) return text(uri, 'No saved audiobooks.');
      return text(
        uri,
        withCapFooter(uri, `Saved audiobooks (${items.length}):\n${renderRows(items).join('\n')}`, disclosure, cap),
      );
    };
    registerResource('saved-audiobooks', uri, "Audiobooks saved in your library ('?format=json' returns the raw items)", render, [
      ['limit', LIMIT_DOC],
      ['offset', OFFSET_DOC],
    ]);
  })();

  // spotify://playlist/{id}/tracks — templated resource (#59): hosts that
  // poll resources can follow playlist contents without tool calls.
  // Pagination rides on the URI itself: append ?offset=N&limit=M;
  // ?format=json switches to the raw paged payload.
  interface PlaylistTracksRequest {
    id: string;
    offset: number;
    limit: number;
    jsonFormat: boolean;
  }

  const parsePlaylistTracksUri = (url: URL): PlaylistTracksRequest | null => {
    // spotify:// is a non-special scheme: URL puts "playlist" in the host and
    // the id at the head of pathname ('spotify://playlist/pl1/tracks' ->
    // host 'playlist', pathname '/pl1/tracks'). Match on the raw href so the
    // parse is independent of that normalization.
    const match = /spotify:\/\/playlist\/([^/?#]+)\/tracks/.exec(url.href);
    if (!match) return null;
    const intParam = (key: string, fallback: number): number => {
      const parsed = Number.parseInt(url.searchParams.get(key) ?? '', 10);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    return {
      id: match[1],
      offset: Math.max(0, intParam('offset', 0)),
      limit: Math.min(100, Math.max(1, intParam('limit', 100))),
      jsonFormat: wantsJson(url),
    };
  };

  const renderPlaylistTracks = async (rawUrl: string): Promise<ResourceContents> => {
    const req = parsePlaylistTracksUri(new URL(rawUrl));
    if (!req) throw new Error(`Malformed playlist tracks URI: ${rawUrl}`);
    const result = await client.get<Omit<SpotifyPaged<{ item: RenderableItem | null }>, 'total'> & { total?: number }>(
      `/playlists/${req.id}/items`,
      { offset: String(req.offset), limit: String(req.limit), additional_types: 'track,episode,audiobook' },
    );
    if (!result) throw new Error(`Could not retrieve playlist ${req.id}`);
    const uri = `spotify://playlist/${req.id}/tracks`;
    if (req.jsonFormat) return json(uri, result);
    const entries = result.items.filter((entry): entry is { item: RenderableItem } => entry.item != null);
    const total = typeof result.total === 'number' ? String(result.total) : 'unknown';
    const header = `Playlist ${req.id} — ${total} items (showing ${entries.length} at offset ${req.offset}):`;
    const lines = entries.map(({ item: playlistItem }, i) =>
      `  ${req.offset + i + 1}. ${formatItem(playlistItem)}`,
    );
    const hasMore = typeof result.total === 'number'
      ? req.offset + result.items.length < result.total
      : result.items.length === req.limit;
    const footer = hasMore ? `\n... more available — re-read with ?offset=${req.offset + result.items.length}` : '';
    return text(uri, `${header}\n${lines.join('\n')}${footer}`);
  };

  // #685: ONE template for this shape, carrying ?offset/?limit/?format in a
  // trailing form-style expression, so the bare URI and every query variant
  // reach the same renderer. It used to be two entries — a bare pattern the
  // SDK could not match with a query string, and a `{+qs}` catch-all standing in
  // for one it could. The two shapes are disjoint from
  // `spotify://playlist/{id}` in `src/resources/templates.ts` because that
  // pattern's `([^/,]+)` capture must be followed by end-of-string, so
  // whichever module is registered first `spotify://playlist/pl1/tracks` routes
  // here and `spotify://playlist/pl1` routes there.
  server.resource(
    'playlist-tracks',
    new ResourceTemplate(
      new Rfc6570UriTemplate('spotify://playlist/{id}/tracks{?format,offset,limit}'),
      { list: undefined },
    ),
    {
      description:
        "A playlist's tracks, paginated via ?offset/&limit ('?format=json' returns the raw API object)"
        + ` Parameters: ?offset (${OFFSET_DOC}), ?limit (${PLAYLIST_TRACKS_LIMIT_DOC}), ?format=json.`,
      mimeType: 'text/plain',
    },
    async (uri: URL) => renderPlaylistTracks(uri.href),
  );

  // spotify://me/listening-history — last 20 recently played (live)
  registerResource(
    'listening-history',
    'spotify://me/listening-history',
    "Recent listening history (last 20, live; '?format=json' returns raw API object)",
    async (url) => {
      const result = await client.get<RecentlyPlayedResponse>('/me/player/recently-played', { limit: '20' });
      if (!result) throw new Error('Could not retrieve listening history');
      if (wantsJson(url)) return json('spotify://me/listening-history', result);
      const lines = result.items.map((item) => {
        const artists = item.track.artists.map((a) => a.name).join(', ');
        return `  • "${item.track.name}" by ${artists} — ${new Date(item.played_at).toLocaleString()} | URI: ${item.track.uri}`;
      });
      return text('spotify://me/listening-history', `Listening history (${result.items.length}):\n${lines.join('\n')}`);
    },
  );

  // spotify://me/genre-heatmap — live top-artists sample (#604)
  //
  // The description used to promise a `followed_artists` sidecar this
  // resource has never read: nothing in the server writes one, and the walk
  // below has always been a live `/me/top/artists` fetch. The comment above
  // it ("read followed_artists.json if present, else live fetch") described a
  // branch that did not exist, so the sidecar path is removed rather than
  // implemented — the honest reading is the one that actually runs, and
  // #604's acceptance criteria explicitly allow dropping the claim.
  registerResource(
    'genre-heatmap',
    'spotify://me/genre-heatmap',
    "Genre counts over a live sample of your top artists (medium term, up to 50 — not your followed artists); the rendered output names the source and how many artists were read ('?format=json' returns the counts with their coverage)",
    async (url) => {
      const genres: Record<string, number> = {};
      // An artist whose `genres` could not be read is neither readable nor
      // zero-genre. `ArtistObject` declares no `required` fields and marks
      // `genres` deprecated, so a row can arrive without the field; the old
      // `a.genres ?? []` folded that case into the same bucket as an artist
      // Spotify genuinely classified as having no genres, and the heatmap
      // asserted a completeness it had not checked. Recorded with the id as
      // the fallback label — the one field on the row that cannot itself be
      // missing in a way that misleads (#804).
      const unreadableArtists: Array<{ id: string; name: string | null; reason: string }> = [];
      let walk: { items: SpotifyArtistFull[]; truncated: boolean; truncatedByCap: boolean; reportedTotal: number | null };
      try {
        // The truncation verdict travels with the walk (#864): a 50-item
        // sample that stopped at the cap is a partial read, and the bare
        // array this used to call could not tell that from a complete one.
        walk = await client.getAllPagesWithTruncation<SpotifyArtistFull>(
          '/me/top/artists',
          { limit: '50' },
          { maxItems: 50 },
        );
      } catch (error) {
        const expected = resourceError(error);
        if (expected) {
          const rateLimit = client.getRateLimitStatus();
          const result = gatedResourceResult(
            url,
            'spotify://me/genre-heatmap',
            expected,
            'Genre data',
            rateLimit.retryAfterSec,
          );
        }
        throw error;
      }
      for (const a of walk.items) {
        if (!Array.isArray(a.genres)) {
          unreadableArtists.push({
            id: a.id ?? '',
            name: typeof a.name === 'string' ? a.name : null,
            reason: 'the API returned this artist with no genres field',
          });
          continue;
        }
        for (const g of a.genres) genres[g] = (genres[g] ?? 0) + 1;
      }
      const artistsCounted = walk.items.length;
      const coverage = {
        source: 'top_artists_sample' as const,
        time_range: 'medium_term' as const,
        artists_counted: artistsCounted,
        artists_with_genres: artistsCounted - unreadableArtists.length,
        artists_unreadable: unreadableArtists.length,
        truncated: walk.truncated,
        truncated_by_cap: walk.truncatedByCap,
        total: walk.reportedTotal,
      };
      if (wantsJson(url)) {
        return json('spotify://me/genre-heatmap', {
          ...coverage,
          ...(unreadableArtists.length > 0 ? { unreadable_artists: unreadableArtists } : {}),
          genres,
        });
      }
      const top = Object.entries(genres).sort((a, b) => b[1] - a[1]).slice(0, 10);
      const lines = [`Top genres (source: ${coverage.source}, ${coverage.time_range} — ${artistsCounted} artist(s) read, not your followed artists):`];
      if (top.length > 0) for (const [g, n] of top) lines.push(`  ${g}: ${n}`);
      else lines.push('  (none — no genre was returned for any artist in this sample)');
      // Same shape as the #803 stats.fm fix: say what could not be read, name
      // the rows, and say the counts are a lower bound — never render an
      // unreadable row as a zero.
      if (unreadableArtists.length > 0) {
        lines.push(
          `(${unreadableArtists.length} of ${artistsCounted} artist(s) could not be read and are excluded from these counts — genre counts are a lower bound: ${unreadableArtists.map((u) => `${u.name ?? u.id} (${u.id}) — ${u.reason}`).join(', ')})`,
        );
      }
      if (walk.truncated) {
        const cause = walk.truncatedByCap
          ? 'truncated at 50 artists (this sample is a top-artists window, not a full history)'
          : `the API reports ${walk.reportedTotal ?? 'an unknown number of'} artists and this walk read ${artistsCounted}`;
        lines.push(`(... ${cause} — use get_top_artists with offset for more)`);
      }
      return text('spotify://me/genre-heatmap', lines.join('\n'));
    },
  );

  // spotify://me/rate-limit — last throttle state (#56/#59): surfaces the
  // most recent Retry-After/backoff event so agents can make informed
  // wait-vs-abort decisions without a tool call.
  registerResource(
    'rate-limit',
    'spotify://me/rate-limit',
    "Last rate-limit event: Retry-After/wait or 'never throttled'",
    async (url) => {
      const status = client.getRateLimitStatus();
      if (wantsJson(url)) {
        return json('spotify://me/rate-limit', {
          ...status,
          ...(typeof status.requestsTotal === 'number'
            ? { requests_total: status.requestsTotal, requests_last_min: status.requestsLastMinute, requests_last_hour: status.requestsLastHour }
            : {}),
        });
      }
      const lines: string[] = [];
      if (status.lastThrottleAt == null) {
        lines.push('never throttled');
      } else {
        lines.push(
          `Last throttle: ${new Date(status.lastThrottleAt).toISOString()} — Retry-After was ${status.retryAfterSec}s`,
        );
      }
      lines.push(
        status.cooldownRemainingMs > 0
          ? `Active cooldown: ~${Math.round(status.cooldownRemainingMs / 1000)}s remaining`
          : 'No active cooldown',
      );
      if (typeof status.requestsTotal === 'number') {
        lines.push(
          `Requests: ${status.requestsTotal} total, ${status.requestsLastMinute ?? '?'} last min, ${status.requestsLastHour ?? '?'} last hour`,
        );
      }
      return text('spotify://me/rate-limit', lines.join('\n'));
    },
  );
}
