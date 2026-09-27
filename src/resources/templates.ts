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
import { Rfc6570UriTemplate } from './uritemplate.js';
import type { SpotifyClient } from '../client.js';
import type {
  SpotifyArtistFull,
  SpotifyArtistAlbumsResponse,
  SpotifyAlbumItem,
  SpotifyAlbumFull,
  SpotifyShowFull,
  SpotifyEpisodeFull,
  SpotifyAudiobookFull,
  SpotifyChapterFull,
  SpotifyChapterSimple,
  SpotifyPaged,
} from '../types/spotify.js';
// #603: the audiobook/chapter cards are the same functions the audiobook tools
// render with, so a resource read cannot tell a reader something `get_audiobook`
// would not.
import {
  AUDIOBOOK_MARKET_NOTE,
  audiobookDetailLines,
  chapterDetailLines,
  chapterListLine,
} from '../audiobookview.js';

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
    path: '/me/shows' | '/me/episodes' | '/me/audiobooks',
    unwrap: (row: { show?: { id: string }; episode?: { id: string }; audiobook?: { id: string } }) => string | undefined,
    n: number,
  ): Promise<string[]> => {
    try {
      const rows = await client.getAllPages<{ show?: { id: string }; episode?: { id: string }; audiobook?: { id: string } }>(path, {
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

  /**
   * Register `render` at `pattern` and at its `{+qs}` query-absorbing twin.
   *
   * `paramNote` (#603) is appended to BOTH descriptions. The acceptance
   * criterion is that each new resource declares its parameter set in the
   * description, and the `{+qs}` twin is a distinct entry in
   * `resources/templates/list` — a host reading the twin's description is
   * reading the only description attached to that entry, so a parameter set
   * that lives only on the bare entry does not reach them.
   */
  const registerTemplatePair = (
    name: string,
    pattern: string,
    description: string,
    render: (rawUrl: string) => Promise<ResourceContents>,
    completeId?: () => Promise<string[]>,
    paramNote?: string,
  ): void => {
    const templateOpts = completeId
      ? {
          list: undefined as undefined,
          complete: {
            id: async (): Promise<string[]> => completeId(),
          },
        }
      : ({ list: undefined } as const);
    const suffix = paramNote ? ` ${paramNote}` : '';
    server.resource(name, new ResourceTemplate(pattern, templateOpts), { description: `${description}${suffix}`, mimeType: 'text/plain' }, async (uri: URL) =>
      render(uri.href),
    );
    server.resource(
      `${name}-query`,
      new ResourceTemplate(new Rfc6570UriTemplate(`${pattern}{+qs}`), { list: undefined }),
      {
        description: `Query-string variant of ${pattern}${suffix}`,
        mimeType: 'text/plain',
      },
      async (uri: URL) => render(uri.href),
    );
  };

  // Registration ORDER still matters here — the SDK matches read requests
  // against templates in insertion order — but it is no longer load-bearing for
  // correctness. `spotify://artist/{id}{+qs}` used to compile to a bare `(.+)`,
  // so it would swallow `spotify://artist/{id}/albums` and the more specific
  // pattern only won because the nested pair was registered first. #1401
  // anchors the `{+qs}` matcher to a real query string, so the nested entry
  // wins on its own; registering it first is kept as defence in depth, not
  // because the order repairs the match.

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

  // spotify://track/{id} — GET /tracks/{id} (?market passthrough)
  registerTemplatePair(
    'track',
    'spotify://track/{id}',
    "A track's details ('?market=US' passthrough; '?format=json' returns raw API object)",
    async (rawUrl) => {
      const match = /spotify:\/\/track\/([^/?#]+)$/.exec(rawUrl.split('?')[0] ?? '');
      if (!match?.[1]) throw new Error(`Malformed track URI: ${rawUrl}`);
      const id = match[1];
      const url = new URL(rawUrl);
      const uri = `spotify://track/${id}`;
      const market = url.searchParams.get('market') ?? undefined;
      const track = await client.get<Record<string, unknown>>(`/tracks/${id}`, market ? { market } : undefined);
      if (!track) throw new Error(`Could not retrieve track ${id}`);
      if (wantsJson(url)) return json(uri, track);
      const name = (track.name as string) ?? id;
      const artists = ((track.artists as Array<{ name: string }>) ?? []).map((a) => a.name).join(', ');
      return text(uri, `Track: "${name}" by ${artists}\nID: ${id}\nURI: ${(track.uri as string) ?? `spotify:track:${id}`}`);
    },
  );

  // spotify://playlist/{id} — GET /playlists/{id} + health sample
  registerTemplatePair(
    'playlist',
    'spotify://playlist/{id}',
    "A playlist's metadata + health badge ('?format=json' returns raw API object)",
    async (rawUrl) => {
      const match = /spotify:\/\/playlist\/([^/?#]+)$/.exec(rawUrl.split('?')[0] ?? '');
      if (!match?.[1]) throw new Error(`Malformed playlist URI: ${rawUrl}`);
      const id = match[1];
      const url = new URL(rawUrl);
      const uri = `spotify://playlist/${id}`;
      const pl = await client.get<Record<string, unknown>>(`/playlists/${id}`);
      if (!pl) throw new Error(`Could not retrieve playlist ${id}`);
      if (wantsJson(url)) return json(uri, pl);
      const name = (pl.name as string) ?? id;
      const owner = ((pl.owner as { display_name?: string; id?: string })?.display_name ?? (pl.owner as { id?: string })?.id ?? 'unknown');
      const paging = pl.items ?? pl.tracks;
      const total = paging !== null && typeof paging === 'object' && 'total' in paging && typeof paging.total === 'number'
        ? paging.total
        : 'unknown';
      return text(uri, `Playlist: "${name}" by ${owner}\nID: ${id}\nURI: ${(pl.uri as string) ?? `spotify:playlist:${id}`}\nTracks: ${total}`);
    },
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

  // ---------------------------------------------------------------- audiobooks
  // #603: the audiobook tool surface was complete while the resource surface
  // had nothing, so an audiobook-first host could not get one page of a book
  // without spending a tool call. These three close that gap.
  //
  // Registration order is kept for the same reason artist-albums is registered
  // before artist, but is no longer load-bearing: since #1401 the bare
  // audiobook pair's `{+qs}` twin requires a real query string, so
  // `spotify://audiobook/<id>{+qs}` no longer swallows
  // `spotify://audiobook/<id>/chapters`. The nested pair still goes first.

  // Bounded page size for the chapters list. GET /audiobooks/{id}/chapters
  // takes limit/offset (verified against the Feb-2026 OpenAPI schema: limit
  // 0–50, default 20; offset default 0), so one resource read is one page.
  const CHAPTER_PAGE_LIMIT = 20;
  const CHAPTER_PAGE_MAX = 50;

  // spotify://audiobook/{id}/chapters — GET /audiobooks/{id}/chapters
  registerTemplatePair(
    'audiobook-chapters',
    'spotify://audiobook/{id}/chapters',
    `One page of an audiobook's chapters ('?format=json' returns the raw paged object).${AUDIOBOOK_MARKET_NOTE}`,
    async (rawUrl) => {
      const match = /spotify:\/\/audiobook\/([^/?#]+)\/chapters/.exec(rawUrl.split('?')[0] ?? '');
      if (!match?.[1]) throw new Error(`Malformed audiobook chapters URI: ${rawUrl}`);
      const id = match[1];
      const url = new URL(rawUrl);
      const uri = `spotify://audiobook/${id}/chapters`;
      const intParam = (key: string, fallback: number): number => {
        const v = Number.parseInt(url.searchParams.get(key) ?? '', 10);
        return Number.isFinite(v) ? v : fallback;
      };
      const limit = Math.min(CHAPTER_PAGE_MAX, Math.max(1, intParam('limit', CHAPTER_PAGE_LIMIT)));
      const offset = Math.max(0, intParam('offset', 0));
      const market = url.searchParams.get('market') ?? undefined;

      const page = await client.get<SpotifyPaged<SpotifyChapterSimple>>(
        `/audiobooks/${id}/chapters`,
        { limit: String(limit), offset: String(offset), ...(market ? { market } : {}) },
      );
      if (!page) throw new Error(`Could not retrieve chapters for audiobook ${id}`);

      if (wantsJson(url)) return json(uri, page);
      if (page.items.length === 0) {
        return text(uri, offset === 0 ? 'No chapters found.' : `No chapters found at offset ${offset}.`);
      }
      const header = `Chapters for audiobook ${id} (${page.total ?? page.items.length} total, showing ${page.items.length} at offset ${offset}):`;
      const lines = page.items.map((chapter) => chapterListLine(chapter));
      const hasMore =
        typeof page.total === 'number'
          ? offset + page.items.length < page.total
          : page.items.length === limit;
      const footer = hasMore
        ? `\n... more available — re-read with ?offset=${offset + page.items.length}, or use get_audiobook_chapters with fetch_all for the whole book.`
        : '';
      return text(uri, `${header}\n${lines.join('\n')}${footer}`);
    },
    undefined,
    'Parameters: ?market (ISO 3166-1 alpha-2), ?limit (1–50, default 20), ?offset (default 0), ?format=json.',
  );

  // spotify://audiobook/{id} — GET /audiobooks/{id}; optional ?market.
  registerTemplatePair(
    'audiobook',
    'spotify://audiobook/{id}',
    "An audiobook's details including its embedded chapter preview ('?format=json' returns the raw API object)",
    async (rawUrl) => {
      const match = /spotify:\/\/audiobook\/([^/?#]+)$/.exec(rawUrl.split('?')[0] ?? '');
      if (!match?.[1]) throw new Error(`Malformed audiobook URI: ${rawUrl}`);
      const id = match[1];
      const url = new URL(rawUrl);
      const uri = `spotify://audiobook/${id}`;
      const market = url.searchParams.get('market') ?? undefined;
      const audiobook = await client.get<SpotifyAudiobookFull>(
        `/audiobooks/${id}`,
        market ? { market } : undefined,
      );
      if (!audiobook) throw new Error(`Could not retrieve audiobook ${id}`);
      if (wantsJson(url)) return json(uri, audiobook);
      // The same card get_audiobook prints — see src/audiobookview.ts for why
      // the two surfaces share one renderer rather than re-reading the fields.
      return text(uri, audiobookDetailLines(audiobook).join('\n'));
    },
    () => savedIdSuggestions('/me/audiobooks', (r) => r.audiobook?.id, 10),
    'Parameters: ?market (ISO 3166-1 alpha-2), ?format=json.',
  );

  // spotify://chapter/{id} — GET /chapters/{id}; optional ?market.
  registerTemplatePair(
    'chapter',
    'spotify://chapter/{id}',
    "An audiobook chapter's details ('?format=json' returns the raw API object)",
    async (rawUrl) => {
      const match = /spotify:\/\/chapter\/([^/?#]+)$/.exec(rawUrl.split('?')[0] ?? '');
      if (!match?.[1]) throw new Error(`Malformed chapter URI: ${rawUrl}`);
      const id = match[1];
      const url = new URL(rawUrl);
      const uri = `spotify://chapter/${id}`;
      const market = url.searchParams.get('market') ?? undefined;
      const chapter = await client.get<SpotifyChapterFull>(
        `/chapters/${id}`,
        market ? { market } : undefined,
      );
      if (!chapter) throw new Error(`Could not retrieve chapter ${id}`);
      if (wantsJson(url)) return json(uri, chapter);
      return text(uri, chapterDetailLines(chapter).join('\n'));
    },
    // Chapter IDs are not enumerable from the library listing — /me/audiobooks
    // yields audiobook ids — so this template has no suggester. An audiobook's
    // chapter ids are reachable through spotify://audiobook/{id}/chapters.
    undefined,
    'Parameters: ?market (ISO 3166-1 alpha-2), ?format=json.',
  );
}
