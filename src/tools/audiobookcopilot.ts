/**
 * Audiobook chapter copilot (#112 idea 4): tools for navigating long-form
 * audiobooks — full chapter tables regardless of the ~18-chapter app break
 * (bounded by the fetch-all cap, and the bound is disclosed), 1-based chapter
 * jumps, and "where was I?" resume orientation.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import type { SpotifyChapterSimple } from '../types/spotify.js';
import {
  ResponseFormat,
  DryRun,
  completenessFooter,
  describeDryRun,
  listStructuredContent,
  paginationInfo,
} from '../shaping.js';
import { getConfig } from '../config.js';

/**
 * The chapters listing endpoint returns `resume_point` on each item even
 * though the shared simple-chapter type omits it (verified live).
 */
type ChapterListing = SpotifyChapterSimple & {
  resume_point?: { fully_played: boolean; resume_position_ms: number };
};

/** GET /me/player payload subset this module reads. */
interface PlaybackState {
  item: { uri: string } | null;
  progress_ms: number | null;
  is_playing: boolean;
}

const CHAPTERS_PAGE_LIMIT = 50; // endpoint cap, verified live

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function describeResumePoint(chapter: ChapterListing): string {
  const rp = chapter.resume_point;
  if (!rp) return 'no resume point';
  if (rp.fully_played) return 'fully played';
  return `resume at ${formatDuration(rp.resume_position_ms)}`;
}

/** Structured row per chapter (1-based position). */
function chapterRow(chapter: ChapterListing, index1: number): Record<string, unknown> {
  return {
    chapter: index1,
    name: chapter.name,
    uri: chapter.uri,
    duration_ms: chapter.duration_ms,
    ...(chapter.resume_point
      ? {
          resume_position_ms: chapter.resume_point.resume_position_ms,
          fully_played: chapter.resume_point.fully_played,
        }
      : {}),
  };
}

/** Result of the chapter walk, including whether the fetch-all cap truncated it (#786). */
interface ChapterWalk {
  chapters: ChapterListing[];
  /** Configured fetch-all cap the walk was bounded by. */
  cap: number;
  /** True when the walk stopped at the cap, so the listing is a prefix of the book. */
  truncatedByCap: boolean;
}

/**
 * Fetch chapters by walking GET /audiobooks/{id}/chapters at the endpoint's
 * page cap until exhausted or the configured fetch-all cap is exceeded. The
 * walk deliberately asks for one chapter past the cap so saturation can be
 * proven rather than assumed: a book with exactly `cap` chapters is complete
 * and must not be reported as truncated, so the listing is only flagged when a
 * (cap+1)-th chapter was actually seen (#786). Same probe as the saved-library
 * scan in libraryhygiene.ts. Throws when the audiobook does not exist or
 * exposes no chapters.
 */
async function fetchAllChapters(
  client: SpotifyClient,
  audiobookId: string,
): Promise<ChapterWalk> {
  const cap = getConfig().fetchAllCap;
  const walked = await client.getAllPages<ChapterListing>(
    `/audiobooks/${encodeURIComponent(audiobookId)}/chapters`,
    { limit: String(CHAPTERS_PAGE_LIMIT) },
    { maxItems: cap + 1 },
  );
  if (walked.length === 0) {
    throw new Error(`Audiobook "${audiobookId}" not found or has no chapters`);
  }
  return {
    chapters: walked.slice(0, cap),
    cap,
    truncatedByCap: walked.length > cap,
  };
}

export function registerAudiobookCopilotTools(server: McpServer, client: SpotifyClient): void {
  // list_all_chapters -------------------------------------------------------
  server.tool(
    'list_all_chapters',
    'List every chapter of an audiobook in one table (index, name, duration, resume point). Walks all pages of the chapters endpoint, unlike the ~18-chapter app limit, but stops at the configured fetch-all cap: when the cap is reached the result is a PREFIX of the book and reports truncated_by_cap=true with the first N chapters only.',
    {
      audiobook_id: z.string().describe('Spotify audiobook ID'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const { chapters, cap, truncatedByCap } = await fetchAllChapters(client, args.audiobook_id);

      if (args.response_format === 'json') {
        const raw = {
          audiobook_id: args.audiobook_id,
          total: chapters.length,
          fetch_all_cap: cap,
          truncated_by_cap: truncatedByCap,
          items: chapters.map((c, i) => ({ ...chapterRow(c, i + 1), ...c })),
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(raw) }],
          structuredContent: raw,
        };
      }

      const lines = [
        truncatedByCap
          ? `Chapters of audiobook ${args.audiobook_id} (first ${chapters.length} fetched — fetch-all cap ${cap} reached):`
          : `Chapters of audiobook ${args.audiobook_id} (${chapters.length} total):`,
        ...chapters.map(
          (c, i) =>
            `  ${i + 1}. "${c.name}" (${formatDuration(c.duration_ms)}) | ${describeResumePoint(c)} | URI: ${c.uri}`,
        ),
      ];
      if (truncatedByCap) {
        lines.push(
          `${completenessFooter({ fetched: chapters.length, cap, truncated: true, subject: 'chapters' })}.`,
          `This is a PREFIX of the book, not the whole book: chapters 1-${chapters.length} only. Later chapters were never fetched — do not summarise this audiobook as fully covered.`,
        );
      }
      const structured = listStructuredContent(
        chapters.map((c, i) => chapterRow(c, i + 1)),
        paginationInfo({ total: chapters.length, returned: chapters.length }),
        {
          audiobook_id: args.audiobook_id,
          fetch_all_cap: cap,
          truncated_by_cap: truncatedByCap,
        },
      );
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: structured,
      };
    },
  );

  // jump_to_chapter ---------------------------------------------------------
  server.tool(
    'jump_to_chapter',
    'Start playing a specific audiobook chapter (1-based number) by resuming the audiobook context at that chapter. Use dry_run to preview without touching playback.',
    {
      audiobook_id: z.string().describe('Spotify audiobook ID'),
      chapter: z.number().int().min(1).describe('Chapter to play, 1-based (first chapter = 1)'),
      device_id: z.string().optional().describe('Device to play on. Default: active device'),
      dry_run: DryRun,
    },
    async (args) => {
      const { chapters, cap, truncatedByCap } = await fetchAllChapters(client, args.audiobook_id);
      if (args.chapter > chapters.length) {
        // A capped walk cannot claim the book "has only N chapters" — it only
        // knows the first N are addressable (#786).
        const known = truncatedByCap
          ? `only the first ${chapters.length} chapters are listed (fetch-all cap ${cap} reached), so chapter ${args.chapter} is not reachable here`
          : `has only ${chapters.length} chapters`;
        throw new Error(
          `Audiobook "${args.audiobook_id}" ${known}; cannot jump to chapter ${args.chapter}.`,
        );
      }
      const target = chapters[args.chapter - 1];
      const contextUri = `spotify:audiobook:${args.audiobook_id}`;
      const detail = `"${target.name}" (${formatDuration(target.duration_ms)})`;

      // dry_run (#57): the chapter lookup above resolved the concrete target;
      // stop here instead of overwriting playback via PUT /me/player/play.
      if (args.dry_run) {
        return {
          content: [
            {
              type: 'text',
              text: describeDryRun('start playback', target.uri, [
                `Play chapter ${args.chapter}: ${detail}`,
                `context_uri=${contextUri}, offset.uri=${target.uri}`,
              ]),
            },
          ],
          structuredContent: {
            ok: true,
            dry_run: true,
            chapter: args.chapter,
            name: target.name,
            uri: target.uri,
            context_uri: contextUri,
          },
        };
      }

      const path = args.device_id
        ? `/me/player/play?device_id=${encodeURIComponent(args.device_id)}`
        : '/me/player/play';
      await client.put(path, { context_uri: contextUri, offset: { uri: target.uri } });

      return {
        content: [
          {
            type: 'text',
            text: `Playing chapter ${args.chapter} of ${chapters.length}: ${detail}`,
          },
        ],
        structuredContent: {
          ok: true,
          chapter: args.chapter,
          name: target.name,
          uri: target.uri,
          context_uri: contextUri,
          ...(args.device_id ? { device_id: args.device_id } : {}),
        },
      };
    },
  );

  // where_was_i -------------------------------------------------------------
  server.tool(
    'where_was_i',
    'Orient yourself in an audiobook: matches current playback against the full chapter list and reports which chapter you are on, how far into it, and how much listening time remains.',
    {
      audiobook_id: z.string().describe('Spotify audiobook ID'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const { chapters } = await fetchAllChapters(client, args.audiobook_id);
      const state = await client.get<PlaybackState>('/me/player');

      if (!state || !state.item) {
        const first = chapters[0];
        return {
          content: [
            {
              type: 'text',
              text: [
                'Nothing is currently playing.',
                `This audiobook has ${chapters.length} chapters. Next up when you start: Chapter 1 "${first.name}" (${formatDuration(first.duration_ms)}), ${formatDuration(
                  chapters.reduce((sum, c) => sum + c.duration_ms, 0),
                )} of listening time in total.`,
              ].join('\n'),
            },
          ],
          structuredContent: {
            ok: true,
            status: 'nothing_playing',
            total_chapters: chapters.length,
            next_chapter: 1,
            listening_time_remaining_ms: chapters.reduce((sum, c) => sum + c.duration_ms, 0),
          },
        };
      }

      const idx = chapters.findIndex((c) => c.uri === state.item!.uri);
      if (idx === -1) {
        // Playback is live but not inside this book (or the app is stuck on a
        // chapter beyond what the listing exposes): treat as not started.
        const first = chapters[0];
        return {
          content: [
            {
              type: 'text',
              text: [
                `You are not currently listening to this audiobook (playing something else${state.is_playing ? '' : ', paused'}).`,
                `When you start "${args.audiobook_id}", you will begin at Chapter 1 "${first.name}".`,
              ].join('\n'),
            },
          ],
          structuredContent: {
            ok: true,
            status: 'not_started',
            total_chapters: chapters.length,
            next_chapter: 1,
          },
        };
      }

      const current = chapters[idx];
      const progressMs = Math.max(state.progress_ms ?? 0, 0);
      const remainingInChapter = Math.max(current.duration_ms - progressMs, 0);
      let remainingTotalMs = remainingInChapter;
      for (let i = idx + 1; i < chapters.length; i++) remainingTotalMs += chapters[i].duration_ms;

      const lines = [
        `Chapter ${idx + 1} of ${chapters.length}: "${current.name}"`,
        `Position in chapter: ${formatDuration(progressMs)} of ${formatDuration(current.duration_ms)} (${remainingInChapter === 0 ? 'chapter finished' : `${formatDuration(remainingInChapter)} left`})`,
        `${chapters.length - (idx + 1)} chapters remaining after this one.`,
        `Listening time left: ${formatDuration(remainingTotalMs)}.`,
      ];

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: {
          ok: true,
          status: state.is_playing ? 'playing' : 'paused',
          current_chapter: {
            number: idx + 1,
            name: current.name,
            uri: current.uri,
            duration_ms: current.duration_ms,
            position_ms: progressMs,
            remaining_ms: remainingInChapter,
          },
          chapters_remaining: chapters.length - (idx + 1),
          listening_time_remaining_ms: remainingTotalMs,
        },
      };
    },
  );
}
