/**
 * RFC-6570 resource templates over single-get catalog endpoints (#111,
 * pattern 2).
 *
 * **One template per URI shape (#685).** Each entity used to be registered
 * twice — a bare pattern plus a `{+qs}` catch-all twin — and the bare pattern
 * could not match a URI carrying a query string while the twin could not be
 * told apart from it, so `resources/templates/list` advertised 22 entries for
 * 10 resources and every one of the bare entries was shadowed by its own twin
 * for the bare URI. One template per shape now carries the whole parameter
 * set in a trailing form-style expression, which RFC 6570 §3.2.8 expands to
 * the empty string when nothing is defined, so the same entry serves
 * `spotify://artist/x1`, `spotify://artist/x1?format=json` and
 * `spotify://artist/x1?market=GB`.
 *
 * One renderer per resource, registered once; `wantsJson` picks prose vs raw
 * JSON (`?format=json`, #59), and every renderer parses its own query string
 * from the raw href rather than from the match variables.
 *
 * Registration order is no longer a correctness property and nothing in this
 * file depends on it — see `src/resources/register.ts` for why, and
 * `tests/resources-template-dedup.test.ts` for the test that holds it.
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
import { formatDuration } from '../result.js';

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

// Feb-2026 platform cap: artist-albums pages top out at limit=10, so we walk
// pages client-side but never more than MAX_PAGES of them — hosts reading the
// resource get a bounded response with an explicit truncation footer instead
// of an unbounded fetch.
const ARTIST_ALBUMS_PAGE_LIMIT = 10;
const ARTIST_ALBUMS_MAX_PAGES = 5;

/** The `?market` contract, stated once and attached to every template taking it. */
const MARKET_PARAM_NOTE = 'Parameters: ?market (ISO 3166-1 alpha-2), ?format=json.';

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
   * Register ONE template for `pattern` (#685), carrying every query parameter
   * the renderer reads in a trailing form-style expression.
   *
   * The expression is compiled by `Rfc6570UriTemplate`, so the entry matches
   * exactly the concrete URIs RFC 6570 says the template expands to: the
   * declared parameters in declaration order, any subset of them, undeclared
   * pairs allowed between, and the empty string — hence the bare URI — when
   * nothing is defined. That is what lets a single entry replace the bare
   * pattern and its `{+qs}` twin without closing a door: a typo, an undeclared
   * parameter, or a declared one sent in an order the template does not expand
   * to still routes, and a *path* difference (`spotify://artist/x1/albums`
   * against `spotify://artist/{id}`, or `spotify://me/saved/tracksX` against
   * `spotify://me/saved/tracks`) still matches nothing.
   *
   * `paramNote` (#603) is the parameter set as prose. There is now exactly one
   * entry in `resources/templates/list` per entity, so this description is the
   * only one a host reads for it.
   */
  const registerTemplate = (
    name: string,
    pattern: string,
    description: string,
    render: (rawUrl: string) => Promise<ResourceContents>,
    options: {
      /** Query parameters the renderer reads, beyond `?format`. */
      query?: readonly string[];
      /** `{id}` argument completion, for ids cheap to enumerate (#111). */
      completeId?: () => Promise<string[]>;
      paramNote?: string;
    } = {},
  ): void => {
    const query = ['format', ...(options.query ?? [])];
    const templateOpts: ConstructorParameters<typeof ResourceTemplate>[1] = options.completeId
      ? {
          list: undefined,
          complete: { id: async (): Promise<string[]> => (options.completeId as () => Promise<string[]>)() },
        }
      : { list: undefined };
    const suffix = options.paramNote ? ` ${options.paramNote}` : '';
    server.resource(
      name,
      new ResourceTemplate(new Rfc6570UriTemplate(`${pattern}{?${query.join(',')}}`), templateOpts),
      { description: `${description}${suffix}`, mimeType: 'text/plain' },
      async (uri: URL) => render(uri.href),
    );
  };

  // spotify://artist/{id}/albums — GET /artists/{id}/albums?limit=10, walked
  // client-side up to ARTIST_ALBUMS_MAX_PAGES pages (Feb-2026 page cap).
  registerTemplate(
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
    { paramNote: 'Parameters: ?format=json.' },
  );

  // spotify://artist/{id} — GET /artists/{id}. Feb-2026 artist payloads carry
  // no genres; prose sticks to name/ID/URI.
  registerTemplate(
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
    { paramNote: 'Parameters: ?format=json.' },
  );

  // spotify://album/{id} — GET /albums/{id}
  registerTemplate(
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
          lines.push(`  ${track.track_number}. "${track.name}" — ${trackArtists} (${formatDuration(track.duration_ms, 'rounded')})`);
        });
      }
      return text(uri, lines.join('\n'));
    },
    { paramNote: 'Parameters: ?format=json.' },
  );

  // spotify://show/{id} — GET /shows/{id}; optional ?market passthrough.
  registerTemplate(
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
    { query: ['market'], completeId: () => savedIdSuggestions('/me/shows', (r) => r.show?.id, 10), paramNote: MARKET_PARAM_NOTE },
  );

  // spotify://track/{id} — GET /tracks/{id} (?market passthrough)
  registerTemplate(
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
    { query: ['market'], paramNote: MARKET_PARAM_NOTE },
  );

  // spotify://playlist/{id} — GET /playlists/{id} + health sample
  registerTemplate(
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
    { paramNote: 'Parameters: ?format=json.' },
  );

  // spotify://episode/{id} — GET /episodes/{id}; optional ?market passthrough.
  registerTemplate(
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
        `Duration: ${formatDuration(episode.duration_ms, 'rounded')} | Released: ${episode.release_date.slice(0, 10)}`,
      ];
      if (episode.resume_point) {
        lines.push(
          episode.resume_point.fully_played
            ? 'Resume point: fully played'
            : `Resume point: ${formatDuration(episode.resume_point.resume_position_ms, 'rounded')}`,
        );
      }
      lines.push(`Description: ${episode.description}`);
      lines.push(`ID: ${episode.id}\nURI: ${episode.uri}`);
      return text(uri, lines.join('\n'));
    },
    { query: ['market'], completeId: () => savedIdSuggestions('/me/episodes', (r) => r.episode?.id, 10), paramNote: MARKET_PARAM_NOTE },
  );

  // ---------------------------------------------------------------- audiobooks
  // #603: the audiobook tool surface was complete while the resource surface
  // had nothing, so an audiobook-first host could not get one page of a book
  // without spending a tool call. These three close that gap.
  //
  // `spotify://audiobook/{id}` and `spotify://audiobook/{id}/chapters` are two
  // distinct shapes of the same entity and are registered as two disjoint
  // templates, so neither can shadow the other whatever order they go in.

  // Bounded page size for the chapters list. GET /audiobooks/{id}/chapters
  // takes limit/offset (verified against the Feb-2026 OpenAPI schema: limit
  // 0–50, default 20; offset default 0), so one resource read is one page.
  const CHAPTER_PAGE_LIMIT = 20;
  const CHAPTER_PAGE_MAX = 50;

  // spotify://audiobook/{id}/chapters — GET /audiobooks/{id}/chapters
  registerTemplate(
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
    { query: ['market', 'limit', 'offset'], paramNote: 'Parameters: ?market (ISO 3166-1 alpha-2), ?limit (1–50, default 20), ?offset (default 0), ?format=json.' },
  );

  // spotify://audiobook/{id} — GET /audiobooks/{id}; optional ?market.
  registerTemplate(
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
    { query: ['market'], completeId: () => savedIdSuggestions('/me/audiobooks', (r) => r.audiobook?.id, 10), paramNote: MARKET_PARAM_NOTE },
  );

  // spotify://chapter/{id} — GET /chapters/{id}; optional ?market.
  registerTemplate(
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
    {
      query: ['market'],
      // Chapter IDs are not enumerable from the library listing —
      // /me/audiobooks yields audiobook ids — so this template has no
      // suggester. An audiobook's chapter ids are reachable through
      // spotify://audiobook/{id}/chapters.
      paramNote: MARKET_PARAM_NOTE,
    },
  );
}
