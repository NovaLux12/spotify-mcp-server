/**
 * Audiobook chapter copilot (#112 idea 4): tools for navigating long-form
 * audiobooks — full chapter tables regardless of the ~18-chapter app break
 * (bounded by the fetch-all cap, and the bound is disclosed), 1-based chapter
 * jumps, and "where was I?" resume orientation.
 *
 * All three tools walk chapters through `fetchAllChapters`, so all three are
 * bounded by the same cap and all three disclose it. Under a cap no tool
 * publishes a whole-book field name for a prefix figure: `total_chapters` and
 * `list_all_chapters`'s `total` are withheld in favour of `chapters_fetched`,
 * `where_was_i`'s remaining counts and time become
 * `*_in_fetched_prefix*`, and an unmatched current chapter is never called
 * "not started" when the cap could be hiding it (#786).
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
    'List every chapter of an audiobook in one table (index, name, duration, resume point). Walks all pages of the chapters endpoint, unlike the ~18-chapter app limit, but stops at the fetch-all cap: a capped result is a PREFIX of the book, flagged truncated_by_cap=true.',
    {
      audiobook_id: z.string().describe('Spotify audiobook ID'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const { chapters, cap, truncatedByCap } = await fetchAllChapters(client, args.audiobook_id);

      if (args.response_format === 'json') {
        const raw = {
          audiobook_id: args.audiobook_id,
          // A capped prefix cannot answer "how long is this book", so the
          // whole-book name is withheld rather than filled with a prefix
          // count (#786) — the same rule where_was_i applies to
          // `total_chapters`. `chapters_fetched` sits beside `truncated_by_cap`
          // so a consumer can still recover what the number would have been.
          ...(truncatedByCap ? { chapters_fetched: chapters.length } : { total: chapters.length }),
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
    'Orient yourself in an audiobook: matches current playback against the fetched chapter list (fetch-all cap may bound it) and reports which chapter you are on, how far into it, and how much listening time is left in that fetched prefix.',
    {
      audiobook_id: z.string().describe('Spotify audiobook ID'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const { chapters, cap, truncatedByCap } = await fetchAllChapters(client, args.audiobook_id);
      const state = await client.get<PlaybackState>('/me/player');

      // Every figure below describes the chapters this walk actually fetched.
      // When the walk saturated the cap they are only a PREFIX of the book, so
      // the bound is disclosed on every branch and `total_chapters` is withheld:
      // only a complete walk can speak for the book's own length (#786 — the
      // disclosure list_all_chapters and jump_to_chapter already make).
      const fetchedMs = chapters.reduce((sum, c) => sum + c.duration_ms, 0);
      const walkScope = {
        chapters_fetched: chapters.length,
        fetch_all_cap: cap,
        truncated_by_cap: truncatedByCap,
        ...(truncatedByCap ? {} : { total_chapters: chapters.length }),
      };

      if (!state || !state.item) {
        const first = chapters[0];
        const lines = ['Nothing is currently playing.'];
        if (truncatedByCap) {
          // Never "This audiobook has N chapters" from a capped prefix (#786).
          lines.push(
            `Only the first ${chapters.length} chapters of this audiobook were fetched (fetch-all cap ${cap} reached), so the book is longer than this.`,
            `Next up when you start: Chapter 1 "${first.name}" (${formatDuration(first.duration_ms)}). The ${chapters.length} fetched chapters hold ${formatDuration(fetchedMs)} of listening time — the book's own total was not fetched.`,
          );
        } else {
          lines.push(
            `This audiobook has ${chapters.length} chapters. Next up when you start: Chapter 1 "${first.name}" (${formatDuration(first.duration_ms)}), ${formatDuration(fetchedMs)} of listening time in total.`,
          );
        }
        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: {
            ok: true,
            status: 'nothing_playing',
            next_chapter: 1,
            // With nothing playing the whole fetched span is "remaining", but
            // under a cap that is the prefix's time, not the book's (#786).
            ...(truncatedByCap
              ? { listening_time_remaining_in_fetched_prefix_ms: fetchedMs }
              : { listening_time_remaining_ms: fetchedMs }),
            ...walkScope,
          },
        };
      }

      const idx = chapters.findIndex((c) => c.uri === state.item!.uri);
      if (idx === -1) {
        const first = chapters[0];
        if (truncatedByCap) {
          // The walk never saw past the cap, so a miss is NOT proof that
          // playback is outside the book — the current chapter may simply be
          // beyond the fetched prefix. Say that instead of "not started" (#786).
          return {
            content: [
              {
                type: 'text',
                text: [
                  `You are playing "${state.item!.uri}", which is not among the first ${chapters.length} chapters fetched for "${args.audiobook_id}" (fetch-all cap ${cap} reached).`,
                  `"${args.audiobook_id}" is longer than the ${chapters.length} chapters fetched, so that may be a later chapter of this book or something outside it — this tool cannot tell the two apart at this cap.`,
                  `Re-run with a higher SPOTIFY_MCP_FETCH_ALL_CAP, or use list_all_chapters to inspect the ${chapters.length}-chapter prefix.`,
                ].join('\n'),
              },
            ],
            structuredContent: {
              ok: true,
              status: 'match_unresolved_beyond_cap',
              current_item_uri: state.item!.uri,
              ...walkScope,
            },
          };
        }
        // Playback is live and the walk exhausted the whole book without a
        // match, so it really is something else.
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
            next_chapter: 1,
            ...walkScope,
          },
        };
      }

      const current = chapters[idx];
      const progressMs = Math.max(state.progress_ms ?? 0, 0);
      const remainingInChapter = Math.max(current.duration_ms - progressMs, 0);
      let remainingTotalMs = remainingInChapter;
      for (let i = idx + 1; i < chapters.length; i++) remainingTotalMs += chapters[i].duration_ms;

      // A capped walk cannot say "of N" about the book or "X chapters
      // remaining" past its prefix — both cover the fetched chapters only (#786).
      const remaining = chapters.length - (idx + 1);
      const lines = [
        truncatedByCap
          ? `Chapter ${idx + 1} of the first ${chapters.length} chapters fetched (fetch-all cap ${cap} reached): "${current.name}"`
          : `Chapter ${idx + 1} of ${chapters.length}: "${current.name}"`,
        `Position in chapter: ${formatDuration(progressMs)} of ${formatDuration(current.duration_ms)} (${remainingInChapter === 0 ? 'chapter finished' : `${formatDuration(remainingInChapter)} left`})`,
        truncatedByCap
          ? `${remaining} chapters remaining after this one within the fetched prefix — "${args.audiobook_id}" has more chapters than the ${cap} fetched.`
          : `${remaining} chapters remaining after this one.`,
        truncatedByCap
          ? `Listening time left: ${formatDuration(remainingTotalMs)} within the fetched prefix — a lower bound, since later chapters were never fetched.`
          : `Listening time left: ${formatDuration(remainingTotalMs)}.`,
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
          // Same rule in the field names: a capped walk has not seen the book's
          // tail, so the whole-book names are not published for prefix figures
          // — `chapters_remaining`/`listening_time_remaining_ms` mean "of the
          // book" everywhere else in this surface (#786).
          ...(truncatedByCap
            ? {
                chapters_remaining_in_fetched_prefix: remaining,
                listening_time_remaining_in_fetched_prefix_ms: remainingTotalMs,
              }
            : { chapters_remaining: remaining, listening_time_remaining_ms: remainingTotalMs }),
          ...walkScope,
        },
      };
    },
  );
}
