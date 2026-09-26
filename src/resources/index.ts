import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { SpotifyApiError, type SpotifyClient } from '../client.js';
import type {
  PlaybackState,
  SpotifyQueue,
  SpotifyPlaylistSimple,
  SpotifyTrack,
  SpotifyEpisode,
  RecentlyPlayedResponse,
  UserProfile,
  SpotifyArtistFull,
  SpotifyPaged,
  SavedAlbumItem,
  SavedShowItem,
  SavedEpisodeItem,
  SavedTrackItem,
} from '../types/spotify.js';
import { playlistItemTotal } from '../types/spotify.js';
import { getConfig } from '../config.js';
import { truncationAdvice, type TruncationCapabilities } from '../shaping.js';
import { walkFollowedArtists } from '../tools/following.js';

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

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

export function registerResources(server: McpServer, client: SpotifyClient): void {
  // #59 freshness note: every resource below goes through the shared client,
  // so catalog-backed reads are served from the short-TTL cache (~5 min)
  // while /me/player* paths bypass it and stay live (#32/#54).
  //
  // Every resource is registered twice: once at its bare URI (exact-string
  // lookup in the SDK) and once as a `{?format}` template — the SDK's
  // form-style query operator only matches when a query string is present,
  // so bare requests hit the fixed entry and `?…` requests hit the twin.
  // Both share one renderer; `wantsJson` picks prose vs raw JSON.

  /** Register `render` at `uri` and at its `?format=json` template twin. */
  const registerResourcePair = (
    name: string,
    uri: string,
    description: string,
    render: (url: URL) => Promise<ResourceContents>,
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
    server.resource(name, uri, { description, mimeType: 'text/plain' }, renderWithApiErrors);
    server.resource(
      `${name}-query`,
      new ResourceTemplate(`${uri}{?format}`, { list: undefined }),
      {
        description: `Query-string variant of '${uri}' (?format=json returns raw JSON)`,
        mimeType: 'text/plain',
      },
      renderWithApiErrors,
    );
  };

  // spotify://me — current user profile
  registerResourcePair(
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
  registerResourcePair(
    'player-state',
    'spotify://player/state',
    "Current Spotify playback state (live; '?format=json' returns the raw API object)",
    async (url) => {
      const state = await client.get<Omit<PlaybackState, 'item'> & { item: RenderableItem | null }>('/me/player', {
        additional_types: 'track,episode,audiobook',
      });
      if (!state || !state.item) {
        return text('spotify://player/state', 'Nothing is currently playing.');
      }
      if (wantsJson(url)) return json('spotify://player/state', state);
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
  registerResourcePair(
    'player-queue',
    'spotify://player/queue',
    "Current playback queue ('?format=json' returns the raw API object)",
    async (url) => {
      const queue = await client.get<SpotifyQueue>('/me/player/queue');
      if (!queue) {
        return text('spotify://player/queue', 'No active playback session.');
      }
      if (wantsJson(url)) return json('spotify://player/queue', queue);
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

  // spotify://me/top/tracks — top tracks (medium term)
  registerResourcePair(
    'top-tracks',
    'spotify://me/top/tracks',
    "User's top tracks (medium term; '?format=json' returns the raw API object)",
    async (url) => {
      const result = await client.get<SpotifyPaged<SpotifyTrack>>('/me/top/tracks', {
        time_range: 'medium_term',
        limit: '20',
      });
      if (!result) throw new Error('Could not retrieve top tracks');
      if (wantsJson(url)) return json('spotify://me/top/tracks', result);
      const lines = result.items.map((track, i) => {
        const artists = track.artists.map((a) => a.name).join(', ');
        return `  ${i + 1}. "${track.name}" by ${artists} | URI: ${track.uri}`;
      });
      return text('spotify://me/top/tracks', `Top tracks (medium term):\n${lines.join('\n')}`);
    },
  );

  // spotify://me/top/artists — top artists (medium term)
  registerResourcePair(
    'top-artists',
    'spotify://me/top/artists',
    "User's top artists (medium term; '?format=json' returns the raw API object)",
    async (url) => {
      const result = await client.get<{ items: SpotifyArtistFull[] }>('/me/top/artists', {
        time_range: 'medium_term',
        limit: '20',
      });
      if (!result) throw new Error('Could not retrieve top artists');
      if (wantsJson(url)) return json('spotify://me/top/artists', result);
      const lines = result.items.map((artist, i) => {
        const genres =
          Array.isArray(artist.genres) && artist.genres.length > 0 ? artist.genres.join(', ') : 'no genres';
        return `  ${i + 1}. ${artist.name} — ${genres} | URI: ${artist.uri}`;
      });
      return text('spotify://me/top/artists', `Top artists (medium term):\n${lines.join('\n')}`);
    },
  );

  // spotify://me/recently-played — last 20 played tracks
  registerResourcePair(
    'recently-played',
    'spotify://me/recently-played',
    "Last 20 recently played tracks ('?format=json' returns the raw API object)",
    async (url) => {
      const result = await client.get<RecentlyPlayedResponse>('/me/player/recently-played', {
        limit: '20',
      });
      if (!result) throw new Error('Could not retrieve recently played');
      if (wantsJson(url)) return json('spotify://me/recently-played', result);
      const lines = result.items.map((item) => {
        const artists = item.track.artists.map((a) => a.name).join(', ');
        const playedAt = new Date(item.played_at).toLocaleString();
        return `  • "${item.track.name}" by ${artists} — ${playedAt} | URI: ${item.track.uri}`;
      });
      return text('spotify://me/recently-played', `Recently played:\n${lines.join('\n')}`);
    },
  );

  // spotify://me/playlists — all user playlists
  registerResourcePair(
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
  const registerSavedResource = <T>(
    name: string,
    uri: string,
    apiPath: string,
    label: string,
    renderProse: (items: T[]) => string,
  ): void => {
    registerResourcePair(name, uri, label, async (url) => {
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
      return text(uri, withCapFooter(uri, renderProse(walk.items), disclosure, cap));
    });
  };

  // spotify://me/saved/albums
  registerSavedResource<SavedAlbumItem>(
    'saved-albums',
    'spotify://me/saved/albums',
    '/me/albums',
    'Albums saved in your library',
    (items) => {
      if (items.length === 0) return 'No saved albums.';
      const lines = items.map(({ added_at, album }) => {
        const artists = album.artists.map((a) => a.name).join(', ');
        return `  • "${album.name}" — ${artists} (${album.release_date}, ${album.total_tracks} tracks, added ${added_at.slice(0, 10)}) | ID: ${album.id}`;
      });
      return `Saved albums (${items.length}):\n${lines.join('\n')}`;
    },
  );

  // spotify://me/saved/shows
  registerSavedResource<SavedShowItem>(
    'saved-shows',
    'spotify://me/saved/shows',
    '/me/shows',
    'Podcast shows saved in your library',
    (items) => {
      if (items.length === 0) return 'No saved shows.';
      const lines = items.map(({ added_at, show }) =>
        `  • "${show.name}" — ${show.publisher ?? 'unknown publisher'} (${show.total_episodes} episodes, added ${added_at.slice(0, 10)}) | ID: ${show.id}`,
      );
      return `Saved shows (${items.length}):\n${lines.join('\n')}`;
    },
  );

  // spotify://me/saved/episodes
  registerSavedResource<SavedEpisodeItem>(
    'saved-episodes',
    'spotify://me/saved/episodes',
    '/me/episodes',
    'Podcast episodes saved in your library',
    (items) => {
      if (items.length === 0) return 'No saved episodes.';
      const lines = items.map(({ added_at, episode }) =>
        `  • "${episode.name}" — ${episode.show.name} (${formatDuration(episode.duration_ms)}, released ${episode.release_date.slice(0, 10)}, added ${added_at.slice(0, 10)}) | ID: ${episode.id}`,
      );
      return `Saved episodes (${items.length}):\n${lines.join('\n')}`;
    },
  );

  // --- #218: additional saved-library resources --------------------------------

  // spotify://me/saved/tracks — paginated with ?offset&limit, prose "name by artist | URI"
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
    server.resource('saved-tracks', uri, { description: "Tracks saved in your library, paginated via ?offset&limit ('?format=json' returns raw paged object)", mimeType: 'text/plain' }, async (u: URL) => render(u));
    server.resource('saved-tracks-query', new ResourceTemplate(`${uri}{?format,offset,limit}`, { list: undefined }), { description: "Query-string variant of 'spotify://me/saved/tracks' (?format=json, ?offset, ?limit)", mimeType: 'text/plain' }, async (u: URL) => render(u));
    server.resource('saved-tracks-qs', new ResourceTemplate(`${uri}{+qs}`, { list: undefined }), { description: "Catch-all query variant of 'spotify://me/saved/tracks'", mimeType: 'text/plain' }, async (u: URL) => render(u));
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
    registerResourcePair('followed-artists', uri, "Artists you follow ('?format=json' returns the raw items)", render);
  })();

  // spotify://me/saved/audiobooks — /me/audiobooks
  (() => {
    const uri = 'spotify://me/saved/audiobooks';
    const render = async (url: URL): Promise<ResourceContents> => {
      type AudiobookRow = { added_at: string; audiobook: { id: string; name: string; uri: string; authors?: Array<{ name: string }> } };
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
      const lines = items.map(({ added_at, audiobook }) => {
        const authors = (audiobook.authors ?? []).map((a) => a.name).join(', ') || 'unknown author';
        return `  • "${audiobook.name}" — ${authors} (added ${added_at.slice(0, 10)}) | ID: ${audiobook.id}`;
      });
      return text(
        uri,
        withCapFooter(uri, `Saved audiobooks (${items.length}):\n${lines.join('\n')}`, disclosure, cap),
      );
    };
    registerResourcePair('saved-audiobooks', uri, "Audiobooks saved in your library ('?format=json' returns the raw items)", render);
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

  server.resource(
    'playlist-tracks',
    new ResourceTemplate('spotify://playlist/{id}/tracks', { list: undefined }),
    {
      description:
        "A playlist's tracks, paginated via ?offset/&limit ('?format=json' returns the raw API object)",
        mimeType: 'text/plain',
    },
    async (uri: URL) => renderPlaylistTracks(uri.href),
  );
  // …and URIs carrying ?format/?offset/?limit hit this one: a single {+qs}
  // capture absorbs ANY query string, because the SDK's {?…} form-style
  // operator would require every named parameter to be present and ordered.
  server.resource(
    'playlist-tracks-query',
    new ResourceTemplate('spotify://playlist/{id}/tracks{+qs}', { list: undefined }),
    { description: 'Query-string variant of playlist-tracks (?format=json, ?offset, ?limit)', mimeType: 'text/plain' },
    async (uri: URL) => renderPlaylistTracks(uri.href),
  );

  // spotify://me/listening-history — last 20 recently played (live)
  registerResourcePair(
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

  // spotify://me/genre-heatmap — local sidecar derived
  registerResourcePair(
    'genre-heatmap',
    'spotify://me/genre-heatmap',
    "Genre heatmap from followed_artists sidecar ('?format=json' returns raw counts)",
    async (url) => {
      // Best-effort: read followed_artists.json if present, else live fetch
      const genres: Record<string, number> = {};
      let artists: SpotifyArtistFull[];
      try {
        artists = await client.getAllPages<SpotifyArtistFull>('/me/top/artists', { limit: '50' }, { maxItems: 50 });
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
      for (const a of artists) for (const g of (a.genres ?? [])) genres[g] = (genres[g] ?? 0) + 1;
      if (wantsJson(url)) return json('spotify://me/genre-heatmap', { genres });
      const top = Object.entries(genres).sort((a, b) => b[1] - a[1]).slice(0, 10);
      const lines = top.map(([g, n]) => `  ${g}: ${n}`);
      return text('spotify://me/genre-heatmap', top.length ? `Top genres:\n${lines.join('\n')}` : 'No genre data available.');
    },
  );

  // spotify://me/rate-limit — last throttle state (#56/#59): surfaces the
  // most recent Retry-After/backoff event so agents can make informed
  // wait-vs-abort decisions without a tool call.
  registerResourcePair(
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
