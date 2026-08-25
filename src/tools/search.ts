import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import type { SearchResponse, SpotifyAudiobookSimple } from '../types/spotify.js';

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
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Results per type, 1–50. Default: 5'),
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

      const lines: string[] = [`Search results for "${args.query}":\n`];

      // Issue #5: when the caller asks for types=["artist"], Spotify returns
      // only the `artists` field in the response. Each section therefore needs
      // an independent optional-chain guard, and \`items\` on each row needs an
      // array guard because some Spotify responses omit `genres` etc.
      const tracks = sectionItems(results, 'tracks');
      if (tracks) {
        lines.push(`TRACKS (${tracks.total} total):`);
        for (const t of tracks.items) {
          const artists = t.artists.map((a) => a.name).join(', ');
          lines.push(
            `  • "${t.name}" by ${artists} — ${t.album.name} (${formatDuration(t.duration_ms)}) | URI: ${t.uri}`,
          );
        }
        lines.push('');
      }

      const artists = sectionItems(results, 'artists');
      if (artists) {
        lines.push(`ARTISTS (${artists.total} total):`);
        for (const a of artists.items) {
          const genreList =
            Array.isArray(a.genres) && a.genres.length > 0
              ? a.genres.slice(0, 3).join(', ')
              : null;
          const genres = genreList ? ` — ${genreList}` : '';
          lines.push(`  • ${a.name}${genres} | URI: ${a.uri}`);
        }
        lines.push('');
      }

      const albums = sectionItems(results, 'albums');
      if (albums) {
        lines.push(`ALBUMS (${albums.total} total):`);
        for (const al of albums.items) {
          const artists = al.artists.map((a) => a.name).join(', ');
          lines.push(
            `  • "${al.name}" by ${artists} (${al.release_date}, ${al.total_tracks} tracks) | URI: ${al.uri}`,
          );
        }
        lines.push('');
      }

      const playlists = sectionItems(results, 'playlists');
      if (playlists) {
        lines.push(`PLAYLISTS (${playlists.total} total):`);
        for (const p of playlists.items) {
          lines.push(
            `  • "${p.name}" by ${p.owner.display_name ?? p.owner.id} (${p.tracks.total} tracks) | URI: ${p.uri}`,
          );
        }
        lines.push('');
      }

      const shows = sectionItems(results, 'shows');
      if (shows) {
        lines.push(`SHOWS (${shows.total} total):`);
        for (const s of shows.items) {
          lines.push(
            `  • "${s.name}" by ${s.publisher ?? 'unknown publisher'} (${s.total_episodes} episodes) | URI: ${s.uri}`,
          );
        }
        lines.push('');
      }

      const episodes = sectionItems(results, 'episodes');
      if (episodes) {
        lines.push(`EPISODES (${episodes.total} total):`);
        for (const e of episodes.items) {
          lines.push(
            `  • "${e.name}" — ${e.show.name} (${formatDuration(e.duration_ms)}, ${e.release_date}) | URI: ${e.uri}`,
          );
        }
        lines.push('');
      }
      const audiobooks = sectionItems(results as SearchResults, 'audiobooks');
      if (audiobooks) {
        lines.push(`AUDIOBOOKS (${audiobooks.total} total):`);
        for (const ab of audiobooks.items) {
          const authors = ab.authors.map((a) => a.name).join(', ');
          lines.push(
            `  • "${ab.name}" by ${authors} (${ab.publisher ?? 'unknown publisher'}, ${ab.total_chapters} chapters) | URI: ${ab.uri}`,
          );
        }
        lines.push('');
      }

      // Issue #45: surface the next offset so agents can keep paging without
      // recomputing it from per-section totals.
      const all: SearchResults = results as SearchResults;
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
      if (lines.length === 1) {
        return { content: [{ type: 'text', text: 'No results found.' }] };
      }
      return { content: [{ type: 'text', text: lines.join('\n').trim() }] };
    },
  );
}
