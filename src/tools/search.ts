import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import type {
  SearchResponse,
  SpotifyAudiobookSimple,
  SpotifyPlaylistSimple,
} from '../types/spotify.js';
import {
  ResponseFormat,
  MaxResults,
  resolveMaxResults,
  truncateItems,
  paginationInfo,
} from '../shaping.js';

// Spotify's search endpoint returns an `audiobooks` key when `type=audiobook`
// is requested (issue #44), but the shared SearchResponse interface does not
// carry it yet. Widen locally so the formatter can render that section
// without touching src/types/spotify.ts.
type SearchResults = SearchResponse & {
  audiobooks?: { items: SpotifyAudiobookSimple[]; total: number };
};

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// Spotify only returns the requested types in the response body. When the
// caller asks for `types: ["artist"]`, the response has `artists` but no
// `tracks` / `albums` / etc. \`.tracks\` etc are optional for that reason.
// This helper pulls a section's items out as a guaranteed non-empty array
// OR returns \`null\` for 'section not present' — which is what the caller
// checks before formatting.
function sectionItems<K extends keyof SearchResults>(
  results: SearchResults,
  key: K,
): NonNullable<SearchResults[K]> | null {
  const section = results[key] as { items?: unknown[] } | undefined;
  if (!Array.isArray(section?.items)) return null;
  // Spotify can return literal `null` entries inside `items[]` for content
  // unavailable in the market (issue #16) — strip them and write the filtered
  // array back so every formatter loop below iterates only valid rows.
  const items = section!.items.filter(Boolean);
  if (items.length === 0) return null;
  section!.items = items;
  return section as NonNullable<SearchResults[K]>;
}

export function registerSearchTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'search',
    "Search Spotify's catalog for tracks, artists, albums, playlists, shows, episodes, or audiobooks. Pass `types` as an array (e.g. `[\"artist\"]`) to search a single kind — no track/album fallback noise.",
    {
      query: z.string().describe('Search query'),
      types: z
        .array(z.enum(['track', 'artist', 'album', 'playlist', 'show', 'episode', 'audiobook']))
        .optional()
        .describe(
          'Content types to search, as an array. Default: ["track","artist","album"]. ' +
            'Pass e.g. ["artist"] for an artist-only search. ' +
            '"audiobook" is only available in the US, UK, CA, IE, NZ and AU markets.',
        ),
      // Feb 2026: Spotify reduced the /search limit maximum from 50 to 10
      // (400 "Invalid limit" above 10) and the default from 20 to 5.
      limit: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('Results per type, 1–10. Default: 5'),
      offset: z
        .number()
        .int()
        .min(0)
        .max(1000)
        .optional()
        .describe('Index of the first result to return, 0–1000. Use with limit to page through results'),
      include_external: z
        .enum(['audio'])
        .optional()
        .describe('Pass "audio" to include externally-hosted audio items marked as playable'),
      market: z.string().optional().describe('ISO 3166-1 alpha-2 country code'),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const types = args.types ?? ['track', 'artist', 'album'];
      const limit = args.limit ?? 5;
      const offset = args.offset ?? 0;

      const params: Record<string, string> = {
        q: args.query,
        type: types.join(','),
        limit: String(limit),
      };
      if (args.offset !== undefined) params.offset = String(args.offset);
      if (args.include_external) params.include_external = args.include_external;
      if (args.market) params.market = args.market;

      const results = await client.get<SearchResponse>('/search', params);
      if (!results) {
        return { content: [{ type: 'text', text: 'No results found.' }] };
      }

      // json mode (#51): raw API object — every field the prose drops stays
      // reachable for chaining agents. Spread keeps this a checked literal
      // assignable to Record<string, unknown> without an unchecked cast.
      if (args.response_format === 'json') {
        const raw: Record<string, unknown> = { ...results };
        return {
          content: [{ type: 'text', text: JSON.stringify(results) }],
          structuredContent: raw,
        };
      }

      const all = results as SearchResults;
      const cap = resolveMaxResults(args.max_results);
      const detailed = args.response_format === 'detailed';

      const lines: string[] = [`Search results for "${args.query}":\n`];
      // Machine-readable sections emitted as structuredContent (#52).
      const sections: Record<string, unknown> = {};
      let sawSection = false;

      const emit = <T>(
        label: string,
        section: { items: T[]; total: number },
        row: (item: T) => string,
      ): void => {
        sawSection = true;
        const shaped = truncateItems(section.items, cap);
        lines.push(`${label} (${section.total} total):`);
        shaped.items.forEach((item) => lines.push(`  • ${row(item)}`));
        if (shaped.footer) {
          lines.push(`  (${shaped.footer})`);
        }
        lines.push('');
        const page = paginationInfo({
          total: section.total,
          offset,
          limit,
          returned: section.items.length,
        });
        sections[label.toLowerCase()] = {
          items: shaped.items,
          total: section.total,
          next_offset: page.next_offset,
        };
      };

      // Issue #5: when the caller asks for types=["artist"], Spotify returns
      // only the `artists` field in the response. Each section therefore needs
      // an independent optional-chain guard, and \`items\` on each row needs an
      // array guard because some Spotify responses omit `genres` etc.
      const tracks = sectionItems(all, 'tracks');
      if (tracks) {
        emit('TRACKS', { items: tracks.items, total: tracks.total }, (t) => {
          const artists = t.artists.map((a) => a.name).join(', ');
          let line = `"${t.name}" by ${artists} — ${t.album.name} (${formatDuration(t.duration_ms)}) | URI: ${t.uri}`;
          // /search rows carry popularity even though the shared track type
          // omits it — narrow with `in` instead of an unchecked cast.
          if (detailed && 'popularity' in t && typeof t.popularity === 'number') {
            line += ` | Popularity: ${t.popularity}`;
          }
          return line;
        });
      }

      const artists = sectionItems(all, 'artists');
      if (artists) {
        emit('ARTISTS', { items: artists.items, total: artists.total }, (a) => {
          const genreList =
            Array.isArray(a.genres) && a.genres.length > 0
              ? a.genres.slice(0, 3).join(', ')
              : null;
          const genres = genreList ? ` — ${genreList}` : '';
          let line = `${a.name}${genres} | URI: ${a.uri}`;
          if (detailed && 'popularity' in a && typeof a.popularity === 'number') {
            line += ` | Popularity: ${a.popularity}`;
          }
          return line;
        });
      }

      const albums = sectionItems(all, 'albums');
      if (albums) {
        emit('ALBUMS', { items: albums.items, total: albums.total }, (al) => {
          const albumArtists = al.artists.map((a) => a.name).join(', ');
          return `"${al.name}" by ${albumArtists} (${al.release_date}, ${al.total_tracks} tracks) | URI: ${al.uri}`;
        });
      }

      const playlists = sectionItems(all, 'playlists');
      if (playlists) {
        // Feb 2026: curated playlists are filtered to null per-slot; drop them
        // before rendering. Track count moved from `tracks.total` to `items.total`.
        const playlistRows = playlists.items.filter(
          (p): p is SpotifyPlaylistSimple => p !== null,
        );
        emit('PLAYLISTS', { items: playlistRows, total: playlists.total }, (p) =>
          `"${p.name}" by ${p.owner.display_name ?? p.owner.id} (${p.items?.total ?? 0} tracks) | URI: ${p.uri}`,
        );
      }

      const shows = sectionItems(all, 'shows');
      if (shows) {
        emit('SHOWS', { items: shows.items, total: shows.total }, (s) =>
          `"${s.name}" by ${s.publisher ?? 'unknown publisher'} (${s.total_episodes} episodes) | URI: ${s.uri}`,
        );
      }

      const episodes = sectionItems(all, 'episodes');
      if (episodes) {
        emit('EPISODES', { items: episodes.items, total: episodes.total }, (e) =>
          `"${e.name}" — ${e.show.name} (${formatDuration(e.duration_ms)}, ${e.release_date}) | URI: ${e.uri}`,
        );
      }

      const audiobooks = sectionItems(all, 'audiobooks');
      if (audiobooks) {
        emit('AUDIOBOOKS', { items: audiobooks.items, total: audiobooks.total }, (ab) => {
          const authors = ab.authors.map((a) => a.name).join(', ');
          return `"${ab.name}" by ${authors} (${ab.publisher ?? 'unknown publisher'}, ${ab.total_chapters} chapters) | URI: ${ab.uri}`;
        });
      }

      // Issue #45: surface the next offset so agents can keep paging without
      // recomputing it from per-section totals.
      const maxTotal = Math.max(
        0,
        ...[all.tracks, all.artists, all.albums, all.playlists, all.shows, all.episodes, all.audiobooks].map(
          (s) => s?.total ?? 0,
        ),
      );
      if (limit + offset < maxTotal) {
        lines.push(`Next page: offset=${offset + limit}`);
      }

      // Only the header line means every section was absent or empty —
      // Spotify returned a body with no usable results.
      if (!sawSection) {
        return { content: [{ type: 'text', text: 'No results found.' }] };
      }
      return {
        content: [{ type: 'text', text: lines.join('\n').trim() }],
        structuredContent: { query: args.query, types, sections },
      };
    },
  );
}
