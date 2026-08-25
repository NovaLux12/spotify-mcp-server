/**
 * RFC-6570 resource templates over single-get catalog endpoints (#111,
 * pattern 2). Mirrors the house style of src/resources/index.ts: every
 * template is registered twice — a bare pattern (matches exact-shape URIs)
 * and a `{+qs}` twin that absorbs any query string, because form-style
 * operators like `{?market}` only match when the parameter is present.
 * One renderer per resource; `wantsJson` picks prose vs raw JSON
 * (`?format=json`, #59).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { SpotifyClient } from '../client.js';
import type {
  SpotifyArtistFull,
  SpotifyArtistAlbumsResponse,
  SpotifyAlbumItem,
  SpotifyAlbumFull,
  SpotifyShowFull,
  SpotifyEpisodeFull,
} from '../types/spotify.js';

type ResourceContents = ReadResourceResult;

function text(uri: string, body: string): ResourceContents {
  return { contents: [{ uri, text: body, mimeType: 'text/plain' }] };
}

function json(uri: string, payload: unknown): ResourceContents {
  return {
    contents: [{ uri, text: JSON.stringify(payload, null, 2), mimeType: 'application/json' }],
  };
}

function wantsJson(url: URL): boolean {
  return url.searchParams.get('format') === 'json';
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

// Feb-2026 platform cap: artist-albums pages top out at limit=10, so we walk
// pages client-side but never more than MAX_PAGES of them — hosts reading the
// resource get a bounded response with an explicit truncation footer instead
// of an unbounded fetch.
const ARTIST_ALBUMS_PAGE_LIMIT = 10;
const ARTIST_ALBUMS_MAX_PAGES = 5;

export function registerTemplateResources(server: McpServer, client: SpotifyClient): void {
  /**
   * Argument completions (#111): for templates whose {id} space is cheaply
   * enumerable from the user's own library, a suggester returns candidate IDs.
   * The SDK wires these into completion/complete automatically when the
   * ResourceTemplate carries a `complete` map. Absent suggester = no completions.
   */
  /** First N saved-item IDs from a saved-library listing endpoint. */
  const savedIdSuggestions = async (
    path: '/me/shows' | '/me/episodes',
    unwrap: (row: { show?: { id: string }; episode?: { id: string } }) => string | undefined,
    n: number,
  ): Promise<string[]> => {
    try {
      const rows = await client.getAllPages<{ show?: { id: string }; episode?: { id: string } }>(path, {
        limit: '20',
      });
      return rows
        .map((r) => unwrap(r))
        .filter((id): id is string => typeof id === 'string')
        .slice(0, n);
    } catch {
      return [];
    }
  };

  /** Register `render` at `pattern` and at its `{+qs}` query-absorbing twin. */
  const registerTemplatePair = (
    name: string,
    pattern: string,
    description: string,
    render: (rawUrl: string) => Promise<ResourceContents>,
    completeId?: () => Promise<string[]>,
  ): void => {
    const templateOpts = completeId
      ? {
          list: undefined as undefined,
          complete: {
            id: async (): Promise<string[]> => completeId(),
          },
        }
      : ({ list: undefined } as const);
    server.resource(name, new ResourceTemplate(pattern, templateOpts), { description }, async (uri: URL) =>
      render(uri.href),
    );
    server.resource(
      `${name}-query`,
      new ResourceTemplate(`${pattern}{+qs}`, { list: undefined }),
      { description: `Query-string variant of ${pattern} (?format=json returns raw JSON)` },
      async (uri: URL) => render(uri.href),
    );
  };

  // Registration ORDER matters here: the SDK matches read requests against
  // templates in insertion order, and `{+qs}` compiles to `(.+)` — so the
  // artist {+qs} twin would also swallow `spotify://artist/{id}/albums`
  // URIs. The nested albums pair is therefore registered before the bare
  // artist pair so the more specific pattern always wins.

  // spotify://artist/{id}/albums — GET /artists/{id}/albums?limit=10, walked
  // client-side up to ARTIST_ALBUMS_MAX_PAGES pages (Feb-2026 page cap).
  registerTemplatePair(
    'artist-albums',
    'spotify://artist/{id}/albums',
    "An artist's albums (first 5×10 via the Feb-2026 page cap; '?format=json' returns the aggregated payload)",
    async (rawUrl) => {
      const match = /spotify:\/\/artist\/([^/?#]+)\/albums/.exec(rawUrl.split('?')[0] ?? '');
      if (!match?.[1]) throw new Error(`Malformed artist albums URI: ${rawUrl}`);
      const id = match[1];
      const url = new URL(rawUrl);
      const uri = `spotify://artist/${id}/albums`;

      const albums: SpotifyAlbumItem[] = [];
      let total = 0;
      let pages = 0;
      let truncated = false;
      while (pages < ARTIST_ALBUMS_MAX_PAGES) {
        const page = await client.get<SpotifyArtistAlbumsResponse>(`/artists/${id}/albums`, {
          limit: String(ARTIST_ALBUMS_PAGE_LIMIT),
          offset: String(albums.length),
        });
        if (!page) throw new Error(`Could not retrieve albums for artist ${id}`);
        total = typeof page.total === 'number' ? page.total : albums.length + page.items.length;
        albums.push(...page.items);
        pages += 1;
        if (
          page.items.length < ARTIST_ALBUMS_PAGE_LIMIT ||
          (typeof page.total === 'number' && albums.length >= page.total)
        ) {
          break;
        }
      }
      truncated = typeof total === 'number' && albums.length < total;

      if (wantsJson(url)) {
        return json(uri, { id, total, retrieved: albums.length, truncated, items: albums });
      }
      const albumLines = albums.map((album, i) => {
        const artists = album.artists.map((a) => a.name).join(', ');
        return `  ${i + 1}. "${album.name}" — ${artists} (${album.release_date}, ${album.total_tracks} tracks) | ID: ${album.id}`;
      });
      let body = `Albums for artist ${id} — showing ${albums.length}${total ? ` of ${total}` : ''} (limit ${ARTIST_ALBUMS_PAGE_LIMIT}/page):\n${albumLines.join('\n')}`;
      if (truncated) {
        body += `\n... and ${total - albums.length} more — truncated at ${ARTIST_ALBUMS_MAX_PAGES} pages × ${ARTIST_ALBUMS_PAGE_LIMIT} albums; use search or catalog tools for the rest.`;
      }
      return text(uri, body);
    },
  );

  // spotify://artist/{id} — GET /artists/{id}. Feb-2026 artist payloads carry
  // no genres; prose sticks to name/ID/URI.
  registerTemplatePair(
    'artist',
    'spotify://artist/{id}',
    "An artist's profile ('?format=json' returns the raw API object)",
    async (rawUrl) => {
      const match = /spotify:\/\/artist\/([^/?#]+)$/.exec(rawUrl.split('?')[0] ?? '');
      if (!match?.[1]) throw new Error(`Malformed artist URI: ${rawUrl}`);
      const id = match[1];
      const url = new URL(rawUrl);
      const uri = `spotify://artist/${id}`;
      const artist = await client.get<SpotifyArtistFull>(`/artists/${id}`);
      if (!artist) throw new Error(`Could not retrieve artist ${id}`);
      if (wantsJson(url)) return json(uri, artist);
      return text(uri, `Artist: ${artist.name}\nID: ${artist.id}\nURI: ${artist.uri}`);
    },
  );

  // spotify://album/{id} — GET /albums/{id}
  registerTemplatePair(
    'album',
    'spotify://album/{id}',
    "An album's details including its track listing ('?format=json' returns the raw API object)",
    async (rawUrl) => {
      const match = /spotify:\/\/album\/([^/?#]+)$/.exec(rawUrl.split('?')[0] ?? '');
      if (!match?.[1]) throw new Error(`Malformed album URI: ${rawUrl}`);
      const id = match[1];
      const url = new URL(rawUrl);
      const uri = `spotify://album/${id}`;
      const album = await client.get<SpotifyAlbumFull>(`/albums/${id}`);
      if (!album) throw new Error(`Could not retrieve album ${id}`);
      if (wantsJson(url)) return json(uri, album);
      const artists = album.artists.map((a) => a.name).join(', ');
      const lines: string[] = [
        `Album: ${album.name}`,
        `Artists: ${artists}`,
        `Released: ${album.release_date} | Type: ${album.album_type} | Tracks: ${album.total_tracks}`,
        `ID: ${album.id}\nURI: ${album.uri}`,
      ];
      if (album.tracks?.items?.length) {
        lines.push('Tracks:');
        album.tracks.items.forEach((track) => {
          const trackArtists = track.artists.map((a) => a.name).join(', ');
          lines.push(`  ${track.track_number}. "${track.name}" — ${trackArtists} (${formatDuration(track.duration_ms)})`);
        });
      }
      return text(uri, lines.join('\n'));
    },
  );

  // spotify://show/{id} — GET /shows/{id}; optional ?market passthrough.
  registerTemplatePair(
    'show',
    'spotify://show/{id}',
    "A podcast show's details ('?market=US' narrows availability; '?format=json' returns the raw API object)",
    async (rawUrl) => {
      const match = /spotify:\/\/show\/([^/?#]+)$/.exec(rawUrl.split('?')[0] ?? '');
      if (!match?.[1]) throw new Error(`Malformed show URI: ${rawUrl}`);
      const id = match[1];
      const url = new URL(rawUrl);
      const uri = `spotify://show/${id}`;
      const market = url.searchParams.get('market') ?? undefined;
      const show = await client.get<SpotifyShowFull>(`/shows/${id}`, market ? { market } : undefined);
      if (!show) throw new Error(`Could not retrieve show ${id}`);
      if (wantsJson(url)) return json(uri, show);
      const lines: string[] = [
        `Show: ${show.name}`,
        show.publisher ? `Publisher: ${show.publisher}` : '',
        `Episodes: ${show.total_episodes}`,
        `Description: ${show.description}`,
        `ID: ${show.id}\nURI: ${show.uri}`,
      ].filter((line) => line !== '');
      return text(uri, lines.join('\n'));
    },
    () => savedIdSuggestions('/me/shows', (r) => r.show?.id, 10),
  );

  // spotify://episode/{id} — GET /episodes/{id}; optional ?market passthrough.
  registerTemplatePair(
    'episode',
    'spotify://episode/{id}',
    "A podcast episode's details ('?market=US' narrows availability; '?format=json' returns the raw API object)",
    async (rawUrl) => {
      const match = /spotify:\/\/episode\/([^/?#]+)$/.exec(rawUrl.split('?')[0] ?? '');
      if (!match?.[1]) throw new Error(`Malformed episode URI: ${rawUrl}`);
      const id = match[1];
      const url = new URL(rawUrl);
      const uri = `spotify://episode/${id}`;
      const market = url.searchParams.get('market') ?? undefined;
      const episode = await client.get<SpotifyEpisodeFull>(`/episodes/${id}`, market ? { market } : undefined);
      if (!episode) throw new Error(`Could not retrieve episode ${id}`);
      if (wantsJson(url)) return json(uri, episode);
      const lines: string[] = [
        `Episode: ${episode.name}`,
        `Show: ${episode.show.name}`,
        `Duration: ${formatDuration(episode.duration_ms)} | Released: ${episode.release_date.slice(0, 10)}`,
      ];
      if (episode.resume_point) {
        lines.push(
          episode.resume_point.fully_played
            ? 'Resume point: fully played'
            : `Resume point: ${formatDuration(episode.resume_point.resume_position_ms)}`,
        );
      }
      lines.push(`Description: ${episode.description}`);
      lines.push(`ID: ${episode.id}\nURI: ${episode.uri}`);
      return text(uri, lines.join('\n'));
    },
    () => savedIdSuggestions('/me/episodes', (r) => r.episode?.id, 10),
  );
}
