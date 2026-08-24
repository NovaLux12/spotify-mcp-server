import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import type { SearchResponse } from '../types/spotify.js';

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
function sectionItems<K extends keyof SearchResponse>(
  results: SearchResponse,
  key: K,
): NonNullable<SearchResponse[K]> | null {
  const section = results[key] as { items?: unknown[] } | undefined;
  const items = Array.isArray(section?.items) ? section!.items : [];
  return items.length > 0 ? (section as NonNullable<SearchResponse[K]>) : null;
}

export function registerSearchTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'search',
    "Search Spotify's catalog for tracks, artists, albums, playlists, shows, or episodes. Pass `types` as an array (e.g. `[\"artist\"]`) to search a single kind — no track/album fallback noise.",
    {
      query: z.string().describe('Search query'),
      types: z
        .array(z.enum(['track', 'artist', 'album', 'playlist', 'show', 'episode']))
        .optional()
        .describe(
          'Content types to search, as an array. Default: ["track","artist","album"]. ' +
            'Pass e.g. ["artist"] for an artist-only search.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('Results per type, 1–10. Default: 5'),
      market: z.string().optional().describe('ISO 3166-1 alpha-2 country code'),
    },
    async (args) => {
      const types = args.types ?? ['track', 'artist', 'album'];
      const limit = args.limit ?? 5;

      const params: Record<string, string> = {
        q: args.query,
        type: types.join(','),
        limit: String(limit),
      };
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

      const output = lines.join('\n').trim();
      return { content: [{ type: 'text', text: output || 'No results found.' }] };
    },
  );
}
