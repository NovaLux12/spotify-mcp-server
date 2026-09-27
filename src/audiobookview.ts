/**
 * The audiobook and chapter prose renderers, shared by the audiobook tools
 * and the `spotify://audiobook/{id}`, `spotify://audiobook/{id}/chapters` and
 * `spotify://chapter/{id}` resource templates (#603).
 *
 * ## Why this module exists
 *
 * Same reason as `src/devices.ts`: the audiobook card has field reads that are
 * easy to get subtly wrong and easy to get *differently* wrong in a second
 * copy. `publisher` was removed from audiobook payloads in Feb-2026 (#639), so
 * the card has to fall back to the edition rather than opening a line with a
 * parenthesis that attributes the edition to nothing; the embedded `chapters`
 * array is a fixed ten-row preview rather than the book's chapter list, so the
 * card has to say how much of the book it stands for (#787); `narrators` may be
 * empty, and a chapter's `resume_point` is scope-dependent. Written twice, the
 * two copies drift and the resource starts telling a reader something the tool
 * would not.
 *
 * The renderers below are the ones the tools use. The resource templates call
 * the same functions, so "the resource matches the tool field-for-field" is a
 * property of the module graph rather than a promise about two renderers.
 *
 * These are pure functions over an already-fetched payload: no client, no
 * config, no market resolution. A caller that needs `?market` resolution or a
 * cap disclosure owns that itself.
 */
import type { SpotifyAudiobookFull, SpotifyChapterFull, SpotifyChapterSimple } from './types/spotify.js';
import { publisherAttribution } from './removed.js';

/** Market restriction note, shared by the tool descriptions and the resources. */
export const AUDIOBOOK_MARKET_NOTE =
  ' Audiobooks are only available in the US, UK, Canada, Ireland, New Zealand and Australia markets.';

/**
 * Rows the audiobook detail card previews. Spotify embeds a fixed handful of
 * chapters; #787 requires the card to say how much of the book that is.
 */
export const EMBEDDED_CHAPTER_PREVIEW = 10;

export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * The `get_audiobook` card, as lines. Returned as lines rather than one string
 * so the tool and the resource can each join with their own header without
 * either re-deriving the fields.
 */
export function audiobookDetailLines(audiobook: SpotifyAudiobookFull): string[] {
  const authors = audiobook.authors.map((a) => a.name).join(', ');
  const narrators = audiobook.narrators.map((n) => n.name).join(', ') || 'none listed';
  // #639: `publisher` is gone, so the fallback that used to open this line
  // printed `Unknown publisher` on every audiobook a current registration
  // returned. A real publisher still prints — the line is unchanged for a
  // pre-Nov-2024 registration — and without one the line drops to the
  // chapter count rather than opening with a parenthesis that attributes
  // the edition to nothing.
  const publisher = publisherAttribution(audiobook.publisher);
  const credits = publisher
    ? `${publisher}${audiobook.edition ? ` (${audiobook.edition})` : ''}`
    : (audiobook.edition ?? '');
  const lines = [
    `"${audiobook.name}" by ${authors}, narrated by ${narrators}`,
    credits ? `${credits} | ${audiobook.total_chapters} chapters` : `${audiobook.total_chapters} chapters`,
    audiobook.description,
    `Languages: ${audiobook.languages.join(', ')} | Explicit: ${audiobook.explicit ? 'yes' : 'no'}`,
    `URI: ${audiobook.uri}`,
  ];

  // #787: the embedded chapter array is a fixed ten-row preview, not the
  // book's chapter list. Without a count the card reads as complete, so
  // state how much of the book it stands for.
  if (audiobook.chapters?.items.length) {
    lines.push('', 'Chapters:');
    const shown = audiobook.chapters.items.slice(0, EMBEDDED_CHAPTER_PREVIEW);
    for (const chapter of shown) {
      lines.push(
        `  ${chapter.chapter_number}. "${chapter.name}" (${formatDuration(chapter.duration_ms)}) | URI: ${chapter.uri}`,
      );
    }
    const declared = typeof audiobook.total_chapters === 'number' ? audiobook.total_chapters : 0;
    const chapterTotal = Math.max(declared, audiobook.chapters.items.length);
    if (chapterTotal > shown.length) {
      lines.push(
        `  (${shown.length} of ${chapterTotal} chapters shown — use get_audiobook_chapters with fetch_all for the rest)`,
      );
    }
  }

  return lines;
}

/** The `get_chapter` card, as lines. */
export function chapterDetailLines(chapter: SpotifyChapterFull): string[] {
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
  return lines;
}

/** One row of a chapter listing, as `get_audiobook_chapters` prints it. */
export function chapterListLine(chapter: SpotifyChapterSimple): string {
  const playable = chapter.is_playable ? '' : ' [not playable]';
  return `  ${chapter.chapter_number}. "${chapter.name}" (${formatDuration(chapter.duration_ms)}, ${chapter.release_date})${playable} | URI: ${chapter.uri}`;
}
