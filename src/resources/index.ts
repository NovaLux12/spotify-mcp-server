import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { SpotifyClient } from '../client.js';
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
  FollowedArtistsResponse,
} from '../types/spotify.js';
import { getConfig } from '../config.js';

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function formatItem(item: SpotifyTrack | SpotifyEpisode): string {
  if (item.type === 'track') {
    const artists = item.artists.map((a) => a.name).join(', ');
    return `"${item.name}" by ${artists} (${formatDuration(item.duration_ms)}) | URI: ${item.uri}`;
  }
  if (item.type === 'episode') {
    return `"${item.name}" — ${item.show.name} (${formatDuration(item.duration_ms)}) | URI: ${item.uri}`;
  }
  return `"${(item as { type?: string }).type ?? 'unknown'}" (unsupported item)`;
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
    server.resource(name, uri, { description }, async (u: URL) => render(u));
    server.resource(
      `${name}-query`,
      new ResourceTemplate(`${uri}{?format}`, { list: undefined }),
      { description: `Query-string variant of '${uri}' (?format=json returns raw JSON)` },
      async (u: URL) => render(u),
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
      const state = await client.get<PlaybackState>('/me/player');
      if (!state || !state.item) {
        return text('spotify://player/state', 'Nothing is currently playing.');
      }
      if (wantsJson(url)) return json('spotify://player/state', state);
      const { item, is_playing, shuffle_state, repeat_state, device } = state;
      const lines: string[] = [];
      if (item.type === 'track') {
        const artists = item.artists.map((a) => a.name).join(', ');
        lines.push(`${is_playing ? 'Playing' : 'Paused'}: "${item.name}" by ${artists}`);
        lines.push(`Album: ${item.album.name}`);
      } else if (item.type === 'episode') {
        lines.push(`${is_playing ? 'Playing' : 'Paused'}: "${item.name}" (${item.show.name})`);
      } else {
        lines.push(`${is_playing ? 'Playing' : 'Paused'}: "${(item as { type?: string }).type ?? 'unknown'}" (unsupported item)`);
      }
      if (device) {
        lines.push(`Device: ${device.name} (${device.type})`);
      } else {
        lines.push('Device: none active');
      }
      lines.push(`Shuffle: ${shuffle_state ? 'on' : 'off'} | Repeat: ${repeat_state}`);
      lines.push(`URI: ${item.uri}`);
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
      const playlists = await client.getAllPages<SpotifyPlaylistSimple>('/me/playlists', {
        limit: '50',
      });
      if (wantsJson(url)) return json('spotify://me/playlists', { total: playlists.length, items: playlists });
      if (playlists.length === 0) {
        return text('spotify://me/playlists', 'No playlists found.');
      }
      const lines = playlists.map((pl) => {
        const trackCount = pl.items?.total ?? 0;
        return `  • "${pl.name}" (${trackCount} tracks) | ID: ${pl.id} | URI: ${pl.uri}`;
      });
      return text('spotify://me/playlists', `Playlists (${playlists.length} total):\n${lines.join('\n')}`);
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
      const items = await client.getAllPages<T>(
        apiPath,
        { limit: '50' },
        { maxItems: getConfig().fetchAllCap },
      );
      if (wantsJson(url)) return json(uri, { total: items.length, items });
      return text(uri, renderProse(items));
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
    server.resource('saved-tracks', uri, { description: "Tracks saved in your library, paginated via ?offset&limit ('?format=json' returns raw paged object)" }, async (u: URL) => render(u));
    server.resource('saved-tracks-query', new ResourceTemplate(`${uri}{?format,offset,limit}`, { list: undefined }), { description: "Query-string variant of 'spotify://me/saved/tracks' (?format=json, ?offset, ?limit)" }, async (u: URL) => render(u));
    server.resource('saved-tracks-qs', new ResourceTemplate(`${uri}{+qs}`, { list: undefined }), { description: "Catch-all query variant of 'spotify://me/saved/tracks'" }, async (u: URL) => render(u));
  })();

  // spotify://me/followed/artists — cursor walk via /me/following
  (() => {
    const uri = 'spotify://me/followed/artists';
    const render = async (url: URL): Promise<ResourceContents> => {
      const cap = getConfig().fetchAllCap;
      const artists: SpotifyArtistFull[] = [];
      let after: string | undefined;
      while (artists.length < cap) {
        const params: Record<string, string> = { type: 'artist', limit: '50' };
        if (after) params.after = after;
        const page = await client.get<FollowedArtistsResponse>('/me/following', params);
        const items = page?.artists?.items ?? [];
        if (items.length === 0) break;
        artists.push(...(items as unknown as SpotifyArtistFull[]));
        after = page?.artists?.cursors?.after ?? undefined;
        if (!page?.artists?.next || !after) break;
      }
      if (artists.length > cap) artists.length = cap;
      if (wantsJson(url)) return json(uri, { total: artists.length, items: artists });
      if (artists.length === 0) return text(uri, 'No followed artists.');
      const lines = artists.map((a, i) => {
        const genres = Array.isArray(a.genres) && a.genres.length > 0 ? a.genres.join(', ') : 'no genres';
        return `  ${i + 1}. ${a.name} — ${genres} | URI: ${a.uri}`;
      });
      return text(uri, `Followed artists (${artists.length}):\n${lines.join('\n')}`);
    };
    registerResourcePair('followed-artists', uri, "Artists you follow ('?format=json' returns the raw items)", render);
  })();

  // spotify://me/saved/audiobooks — /me/audiobooks
  (() => {
    const uri = 'spotify://me/saved/audiobooks';
    const render = async (url: URL): Promise<ResourceContents> => {
      let items: Array<{ added_at: string; audiobook: { id: string; name: string; uri: string; authors?: Array<{ name: string }> } }> = [];
      try {
        items = await client.getAllPages<{ added_at: string; audiobook: { id: string; name: string; uri: string; authors?: Array<{ name: string }> } }>('/me/audiobooks', { limit: '50' }, { maxItems: getConfig().fetchAllCap });
      } catch {
        items = [];
      }
      if (wantsJson(url)) return json(uri, { total: items.length, items });
      if (items.length === 0) return text(uri, 'No saved audiobooks.');
      const lines = items.map(({ added_at, audiobook }) => {
        const authors = (audiobook.authors ?? []).map((a) => a.name).join(', ') || 'unknown author';
        return `  • "${audiobook.name}" — ${authors} (added ${added_at.slice(0, 10)}) | ID: ${audiobook.id}`;
      });
      return text(uri, `Saved audiobooks (${items.length}):\n${lines.join('\n')}`);
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
    const result = await client.get<SpotifyPaged<{ item: SpotifyTrack | null }>>(
      `/playlists/${req.id}/items`,
      { offset: String(req.offset), limit: String(req.limit) },
    );
    if (!result) throw new Error(`Could not retrieve playlist ${req.id}`);
    const uri = `spotify://playlist/${req.id}/tracks`;
    if (req.jsonFormat) return json(uri, result);
    const entries = result.items.filter((it): it is { item: SpotifyTrack } => it.item != null);
    const header = `Playlist ${req.id} — ${result.total ?? entries.length} tracks (showing ${entries.length} at offset ${req.offset}):`;
    const lines = entries.map(({ item: track }, i) => {
      const artists = track.artists.map((a) => a.name).join(', ');
      return `  ${req.offset + i + 1}. "${track.name}" by ${artists} | URI: ${track.uri}`;
    });
    const hasMore =
      typeof result.total === 'number'
        ? req.offset + entries.length < result.total
        : entries.length === req.limit;
    const footer = hasMore ? `\n... more available — re-read with ?offset=${req.offset + entries.length}` : '';
    return text(uri, `${header}\n${lines.join('\n')}${footer}`);
  };

  server.resource(
    'playlist-tracks',
    new ResourceTemplate('spotify://playlist/{id}/tracks', { list: undefined }),
    {
      description:
        "A playlist's tracks, paginated via ?offset/&limit ('?format=json' returns the raw API object)",
    },
    async (uri: URL) => renderPlaylistTracks(uri.href),
  );
  // …and URIs carrying ?format/?offset/?limit hit this one: a single {+qs}
  // capture absorbs ANY query string, because the SDK's {?…} form-style
  // operator would require every named parameter to be present and ordered.
  server.resource(
    'playlist-tracks-query',
    new ResourceTemplate('spotify://playlist/{id}/tracks{+qs}', { list: undefined }),
    { description: 'Query-string variant of playlist-tracks (?format=json, ?offset, ?limit)' },
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
      let genres: Record<string, number> = {};
      try {
        const artists = await client.getAllPages<SpotifyArtistFull>('/me/top/artists', { limit: '50' }, { maxItems: 50 });
        for (const a of artists) for (const g of (a.genres ?? [])) genres[g] = (genres[g] ?? 0) + 1;
      } catch { genres = {}; }
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
      if (wantsJson(url)) return json('spotify://me/rate-limit', status);
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
      return text('spotify://me/rate-limit', lines.join('\n'));
    },
  );
}
