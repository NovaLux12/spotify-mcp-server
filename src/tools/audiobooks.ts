import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import type {
  SpotifyAudiobookFull,
  SpotifyChapterFull,
  SpotifyChapterSimple,
  SpotifyPaged,
  SavedAudiobookItem,
} from '../types/spotify.js';

const MARKET_NOTE =
  ' Audiobooks are only available in the US, UK, Canada, Ireland, New Zealand and Australia markets.';

const MARKET_PARAM = z
  .string()
  .optional()
  .describe(
    `ISO 3166-1 alpha-2 country code. If given, only content available in that market is returned.${MARKET_NOTE}`,
  );

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function registerAudiobookTools(server: McpServer, client: SpotifyClient): void {
  // get_audiobook
  server.tool(
    'get_audiobook',
    `Get full details for an audiobook by ID.${MARKET_NOTE}`,
    {
      id: z.string().describe('Spotify audiobook ID'),
      market: MARKET_PARAM,
    },
    async (args) => {
      const params: Record<string, string> = {};
      if (args.market) params.market = args.market;

      const audiobook = await client.get<SpotifyAudiobookFull>(
        `/audiobooks/${encodeURIComponent(args.id)}`,
        params,
      );
      if (!audiobook) throw new Error('Audiobook not found');

      const authors = audiobook.authors.map((a) => a.name).join(', ');
      const narrators = audiobook.narrators.map((n) => n.name).join(', ') || 'none listed';
      const lines = [
        `"${audiobook.name}" by ${authors}, narrated by ${narrators}`,
        `${audiobook.publisher ?? 'Unknown publisher'}${audiobook.edition ? ` (${audiobook.edition})` : ''} | ${audiobook.total_chapters} chapters`,
        audiobook.description,
        `Languages: ${audiobook.languages.join(', ')} | Explicit: ${audiobook.explicit ? 'yes' : 'no'}`,
        `URI: ${audiobook.uri}`,
      ];

      if (audiobook.chapters?.items.length) {
        lines.push('', 'Chapters:');
        for (const chapter of audiobook.chapters.items.slice(0, 10)) {
          lines.push(
            `  ${chapter.chapter_number}. "${chapter.name}" (${formatDuration(chapter.duration_ms)}) | URI: ${chapter.uri}`,
          );
        }
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // get_audiobook_chapters
  server.tool(
    'get_audiobook_chapters',
    `List the chapters of an audiobook with pagination.${MARKET_NOTE}`,
    {
      id: z.string().describe('Spotify audiobook ID'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Results per page, 1–50. Default: 20'),
      offset: z.number().int().min(0).optional().describe('Index of the first chapter to return. Default: 0'),
      market: MARKET_PARAM,
    },
    async (args) => {
      const params: Record<string, string> = {
        limit: String(args.limit ?? 20),
        offset: String(args.offset ?? 0),
      };
      if (args.market) params.market = args.market;

      const result = await client.get<SpotifyPaged<SpotifyChapterSimple>>(
        `/audiobooks/${encodeURIComponent(args.id)}/chapters`,
        params,
      );
      if (!result) throw new Error('Audiobook not found');

      const lines = [`Chapters for audiobook (${result.total} total):`];
      for (const chapter of result.items) {
        const playable = chapter.is_playable ? '' : ' [not playable]';
        lines.push(
          `  ${chapter.chapter_number}. "${chapter.name}" (${formatDuration(chapter.duration_ms)}, ${chapter.release_date})${playable} | URI: ${chapter.uri}`,
        );
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // get_chapter
  server.tool(
    'get_chapter',
    `Get full details for a single audiobook chapter by ID. Resume position requires the user-read-playback-position scope.${MARKET_NOTE}`,
    {
      id: z.string().describe('Spotify chapter ID'),
      market: MARKET_PARAM,
    },
    async (args) => {
      const params: Record<string, string> = {};
      if (args.market) params.market = args.market;

      const chapter = await client.get<SpotifyChapterFull>(
        `/chapters/${encodeURIComponent(args.id)}`,
        params,
      );
      if (!chapter) throw new Error('Chapter not found');

      const lines = [
        `Chapter ${chapter.chapter_number}: "${chapter.name}"`,
        chapter.description,
        `Duration: ${formatDuration(chapter.duration_ms)} | Released: ${chapter.release_date}`,
        `Explicit: ${chapter.explicit ? 'yes' : 'no'} | Playable in given market: ${chapter.is_playable ? 'yes' : 'no'}`,
      ];

      if (chapter.resume_point) {
        const status = chapter.resume_point.fully_played
          ? 'Fully played'
          : `Resume at ${formatDuration(chapter.resume_point.resume_position_ms)}`;
        lines.push(`Resume point: ${status}`);
      }

      lines.push(`URI: ${chapter.uri}`);

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // get_saved_audiobooks
  server.tool(
    'get_saved_audiobooks',
    "List the audiobooks saved in the current user's Spotify library. Requires the user-library-read scope.",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Results per page, 1–50. Default: 20'),
      offset: z.number().int().min(0).optional().describe('Index of the first audiobook to return. Default: 0'),
    },
    async (args) => {
      const params: Record<string, string> = {
        limit: String(args.limit ?? 20),
        offset: String(args.offset ?? 0),
      };

      const result = await client.get<SpotifyPaged<SavedAudiobookItem>>('/me/audiobooks', params);
      if (!result) throw new Error('Could not fetch saved audiobooks');

      const lines = [`Saved audiobooks (${result.total} total):`];
      for (const item of result.items) {
        const authors = item.audiobook.authors.map((a) => a.name).join(', ');
        lines.push(
          `  • "${item.audiobook.name}" by ${authors} (${item.audiobook.total_chapters} chapters, saved ${item.added_at}) | URI: ${item.audiobook.uri}`,
        );
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );
}
