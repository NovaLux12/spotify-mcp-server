import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { installPromptErrorBoundary } from '../tools/annotations.js';
import { derivedAnalyticsEnabled } from '../derivedanalytics.js';

/**
 * Shared optional time-range argument (#60): defaults preserve old behaviour.
 * Prompt arguments travel as protocol strings, so numeric/boolean options use
 * coerce/enum shapes instead of raw z.number()/z.boolean().
 */
const TimeRange = z
  .enum(['short_term', 'medium_term', 'long_term'])
  .optional()
  .describe('Spotify time range: short_term (4 weeks), medium_term (6 months), long_term (all time)');

/**
 * The rate-limit clause of the standard footer, in the two forms it can
 * honestly take (#715).
 *
 * `resources` and `prompts` are INDEPENDENT toolsets (`src/toolsets.ts`), so a
 * host can serve the prompt surface with no resources registered at all. A
 * footer that names `spotify://me/rate-limit` regardless is a field that lies
 * about its value (AGENTS.md §6): the URI is syntactically fine and resolves to
 * nothing, and a hint pointing at nothing is worse than no hint, because the
 * agent routes work toward it and finds an absence it cannot explain.
 *
 * The degraded clause names the mechanism that IS present in every
 * configuration: the 429 error itself. The tool error boundary already maps a
 * 429 to `kind: 'rate_limited'` and puts the parsed `Retry-After` in
 * `structuredContent.error.retryAfterSec` and in the message text
 * (`src/tools/annotations.ts`), so the agent already holds the number in the
 * failed call's own result. No second surface has to be reachable for the
 * guidance to be actionable.
 *
 * The alternative — pointing at a rate-limit TOOL — is deliberately not taken:
 * every tool module is behind its own toolset key, so naming one reproduces
 * this exact defect one level down, on a surface the same trim can remove.
 * The error the agent is already holding cannot be trimmed away from it.
 */
const RATE_LIMIT_CLAUSE_WITH_RESOURCES =
  'If a tool is unavailable (toolset-trimmed) or rate-limited (429), note it with data from spotify://me/rate-limit, wait and retry once before skipping that section';
const RATE_LIMIT_CLAUSE_WITHOUT_RESOURCES =
  'If a tool is unavailable (toolset-trimmed), note it and skip that section. If a call is rate-limited (429), the failure already carries the wait: the message names the Retry-After seconds and structuredContent.error.retryAfterSec holds the same number — wait that long and retry once before skipping that section';

/**
 * Shared footer for every numbered prompt. `resourceHints` is false when the
 * `resources` module is not registered in this session, which is the only
 * condition under which the resource clause is a claim the server cannot keep.
 */
function standardFooter(resourceHints: boolean): string {
  const rateLimit = resourceHints ? RATE_LIMIT_CLAUSE_WITH_RESOURCES : RATE_LIMIT_CLAUSE_WITHOUT_RESOURCES;
  return `If any read returns empty (0 tracks/artists/playlists), report it explicitly and suggest a fallback instead of presenting an empty list. ${rateLimit} — never fail the whole task for one missing step. Validate user-supplied strings (dates as YYYY-MM-DD, playlist names by resolving via get_user_playlists) and ask for clarification rather than guessing.`;
}

/**
 * The shared first step for the four mood-curation prompts (#598).
 *
 * `moodExpression` is the literal `mood=` value the caller passes — the
 * prompt's own argument where it has one, and a phrase the host model writes
 * for itself in `dj`, which takes no mood argument. Keeping the clause in one
 * place is the point: four prompts each naming the tool in their own words is
 * how they drift, and the third one to be reworded is the one an agent ends up
 * trusting least.
 *
 * The clause states both outcomes rather than promising one. The tool takes
 * the sampling path on a host that advertises that capability and the static
 * map otherwise, and `structuredContent.source` says which — so a prompt that
 * described only the good path would be describing a host this server cannot
 * promise. The `isError` sentence matters for the same reason: the tool
 * refuses to invent a substitute when the model reply is unreadable, and a
 * prompt that then quietly invented one would undo that.
 */
function moodExpansionClause(moodExpression: string): string {
  return `Begin with expand_mood_to_queries(mood=${moodExpression}) and build your searches from the genres and keywords it returns, honouring its exclude list. It uses the host model when the host advertises the sampling capability and a built-in map otherwise; structuredContent.source says which, and source=static_map with matched=false means it has no row for that mood. If it returns isError, do not substitute a guess — say so and pick your own search terms.`;
}

export interface PromptRegistrationOptions {
  /**
   * Whether the `resources` MCP surface is registered in this session (#715).
   *
   * Passed in rather than resolved here because `registerPrompts` cannot see
   * the toolsets: the decision is made once in `src/index.ts` and the same
   * boolean must gate BOTH resource registration and the prompt text. Two
   * independent derivations of "are resources on" are two answers to one
   * question, and the one that drifts is the one that ships a dead hint.
   */
  readonly resourceHints: boolean;
}

export function registerPrompts(server: McpServer, options: PromptRegistrationOptions): void {
  const { resourceHints } = options;
  // Resolved once: every prompt below shares this footer, and the two forms
  // differ only in the rate-limit clause.
  const footer = standardFooter(resourceHints);
  // The `prompts/get` boundary is installed HERE rather than in `src/index.ts`
  // beside `installToolErrorBoundary`, because `registerPrompts` is the only
  // way a prompt surface is ever built: production and every test go through
  // this function, so the guarantee cannot be lost to a call site that forgot
  // it. `server.prompt()` registers a plain `z.object()`, which STRIPS unknown
  // arguments — before this, a call carrying a misspelled argument rendered a
  // complete prompt from defaults and said nothing. See #689.

  // dj — act as a DJ based on user's top artists and mood (#455, #462, #460)
  server.prompt(
    'dj',
    'Act as a DJ. Based on my top artists and current mood, queue up a set of songs.',
    async () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            'Act as a DJ. Use get_top_artists and get_recently_played to understand my music taste and what I have been listening to lately.',
            moodExpansionClause('"the vibe you are playing to"'),
            'Then use search with combined genre/mood/artist queries (types=["track"], limit 10 per call, 2–3 broad queries rather than one per track) to find 5–10 tracks that fit the vibe.',
            'Queue them with batch_add_to_queue in one call (or preview first with batch_add_to_queue(dry_run=true) / add_to_queue(dry_run=true)).',
            'If get_top_artists or search returns empty, fall back to recently-played seed artists and report what was missing.',
            'If no active device, note it and present the queue as a playlist alternative via create_playlist.',
            resourceHints
              ? 'If rate-limited (429), check spotify://me/rate-limit and retry once.'
              : 'If rate-limited (429), the failed call already carries the wait: structuredContent.error.retryAfterSec holds the Retry-After seconds — wait that long and retry once.',
            footer,
          ].join(' '),
        },
      }],
    }),
  );

  // playlist_from_mood — create a playlist for a given mood (#452, #460)
  server.prompt(
    'playlist_from_mood',
    'Create a playlist for a given mood. Searches for tracks and adds them to a new playlist.',
    {
      mood: z.string().describe('The mood or vibe for the playlist (e.g. "rainy afternoon", "morning run", "late night coding")'),
    },
    async (args) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Create a playlist for this mood: "${args.mood}". ${moodExpansionClause(`"${args.mood}"`)} Use up to 6 search_deep calls with combined keywords, artists, and genres (types=["track"], pages 2 — two 10-result pages per call) to find 15–20 tracks that fit the vibe. Then use create_playlist to make a new playlist with a fitting name and description, and add_to_playlist to fill it with the tracks you found. IMPORTANT: preview the plan with create_playlist(dry_run=true) and add_to_playlist(dry_run=true) before committing. If search_deep returns 0 results, report it and suggest a broader mood. ${footer}`,
        },
      }],
    }),
  );

  // music_taste_summary — summarize the user's music taste (#514, #460)
  server.prompt(
    'music_taste_summary',
    "Summarize the user's music taste based on their top tracks and artists.",
    {
      time_range: z
        .enum(['short_term', 'medium_term', 'long_term', 'all'])
        .optional()
        .describe("Which range(s) of listening history to analyze; 'all' compares short, medium, and long term"),
    },
    async (rawArgs) => {
      const args = { ...rawArgs, time_range: rawArgs.time_range ?? 'all' };
      const isAll = args.time_range === 'all';
      const calls = isAll
        ? 'all 6 calls in parallel (Promise.all: get_top_tracks and get_top_artists for short_term, medium_term, long_term)'
        : `get_top_tracks (${args.time_range}) and get_top_artists (${args.time_range}) in parallel`;
      const scope = isAll
        ? 'across all three time ranges'
        : `for the ${args.time_range} window only`;
      // The zero-tool-call shortcut is a RESOURCE read, so it cannot survive a
      // trim. Replaced rather than deleted: the agent still wants a cheap
      // snapshot, and the same data is one tool call away on a surface that a
      // `resources` trim does not touch. Args are named in the tool's own
      // vocabulary so `findUndeclaredPromptArgs` keeps holding this to the schema.
      const snapshotShortcut = resourceHints
        ? 'For a quick medium_term snapshot without tool calls, read spotify://me/top/tracks and spotify://me/top/artists; those two resources take ?time_range (long_term, medium_term, short_term), ?limit and ?offset, so read spotify://me/top/tracks?time_range=short_term&limit=5 for a recent snapshot.'
        : 'For a quick medium_term snapshot without summarizing every range, call get_top_tracks (time_range=medium_term, limit=20) and get_top_artists (time_range=medium_term, limit=20); use time_range=short_term, limit=5 for a recent snapshot.';
      return {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `Summarize my music taste ${scope}. Call ${calls}. Then write a detailed summary of my taste: genres I gravitate toward, artists I keep coming back to, how my taste has shifted over time${isAll ? '' : ' within this window'}, and what that says about my listening habits. If any range returns 0 items, note it as 'not enough history for this window' rather than inventing genres. ${snapshotShortcut} If a tool is unavailable (toolset-trimmed), skip that range with a one-line note. ${footer}`,
          },
        }],
      };
    },
  );

  // discover_weekly_alternative — personalized discovery based on top tracks (#452, #462, #460)
  server.prompt(
    'discover_weekly_alternative',
    "Based on my top tracks and recently played songs, find lesser-known songs I probably haven't heard.",
    {
      size: z.coerce.number().int().positive().max(50).optional().describe('How many discovery picks to return (default 20)'),
    },
    async (rawArgs) => {
      const args = { ...rawArgs, size: rawArgs.size ?? 20 };
      return ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Generate a personalised discovery list of ${args.size} songs for me. Use get_top_tracks (short_term) and get_recently_played to learn my recent favourites. ${moodExpansionClause('"the energy and mood range around those favourites"')} Then use search_deep (types=["track"], pages 2 — two 10-result pages per call, 2–3 broad combined genre/mood/artist queries rather than one search per target track) to find ${args.size} lesser-known tracks in the same artistic space — dig beyond each favourite artist's biggest hits (deep cuts, B-sides, similar smaller artists). IMPORTANT: explicitly exclude every track that appears in my top tracks or recently played, and skip each artist's most-streamed signature songs so the picks feel fresh. If combined searches yield <${args.size} candidates after exclusions, issue one more broadened search or paginate the most promising query (offset=20) and report if you could only find N < ${args.size} fresh picks and why. Flag region-unavailable/null items. Focus on variety — mix up energy levels and moods while staying within my taste. Present the list with track names, artists, and URIs so I can play them. ${footer}`,
        },
      }],
    });
  }
  );

  // playlist_audit — dedupe / dead-track health check for one playlist (#509, #460).
  // The findings are an explicit, contiguous three-item list (#714). The body
  // used to open with a bare "(3)" whose items (1) and (2) existed only as
  // prose, so the marker implied two sections the prompt never named. Every
  // numbered prompt here renders its steps as their own `N. ` line
  // (music_briefing, triage_liked_songs); this one is the third.
  server.prompt(
    'playlist_audit',
    "Audit a playlist for duplicate tracks and unplayable ('dead') entries, with cleanup suggestions.",
    {
      playlist: z.string().describe('Playlist name, ID, or URI'),
    },
    async (args) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Audit the playlist "${args.playlist}" for problems. If it was given by name, resolve it first with get_user_playlists (fetch_all=true) — page until found; otherwise use its ID/URI directly. If no playlist matches the name, report the miss and list the closest name matches rather than proceeding with a wrong ID. Pull every item with get_playlist_items (fetch_all=true), then run find_duplicates_in_playlist. Report exactly three sections, in this order and no others:`,
            '(1) DUPLICATES — the groups returned by find_duplicates_in_playlist, verbatim (it also catches relinked copies that ID-matching misses).',
            '(2) DEAD TRACKS — entries whose track is null or flagged unavailable/unplayable, including region-restricted relinks.',
            '(3) SUMMARY TABLE — a summary table with counts per issue.',
            'For every problem entry give its position and URI so I can act with remove_from_playlist. Do NOT remove anything yet — just present findings and ask which fixes to apply.',
            footer,
          ].join('\n'),
        },
      }],
    }),
  );

  // listening_recap — weekly/monthly summary of what I've been playing (#60).
  server.prompt(
    'listening_recap',
    'Write a recap of recent listening: top tracks/artists plus recently-played context.',
    {
      time_range: TimeRange,
      size: z.coerce.number().int().positive().max(50).optional().describe('How many top tracks/artists to feature (default 10)'),
    },
    async (rawArgs) => {
      const args = { ...rawArgs, time_range: rawArgs.time_range ?? 'medium_term', size: rawArgs.size ?? 10 };
      return ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Give me a listening recap for my ${args.time_range} history. Call get_top_tracks (time_range=${args.time_range}, limit=${args.size}), get_top_artists (time_range=${args.time_range}, limit=${args.size}), and get_recently_played (limit=50) in parallel where possible. Then write an engaging recap: my ${args.size} most-played tracks and artists, patterns across genres/moods/eras, how recently-played confirms or diverges from the charts, one "on repeat" callout, and one "you might be burning out on" callout based on repetition. End with three concrete follow-up suggestions (e.g. a playlist to revisit or an album to try) using real URIs. ${footer}`,
        },
      }],
    });
  }
  );

  // migrate_library — turn saved albums into a playlist (#506, #460).
  server.prompt(
    'migrate_library',
    'Collect tracks from your saved albums into a single playlist.',
    {
      playlist_name: z.string().optional().describe('Name for the destination playlist (default: My Saved Albums)'),
      include_singles: z.enum(['true', 'false']).optional().describe("Also include tracks from singles/EPs, not just full albums ('true'/'false')"),
    },
    async (rawArgs) => {
      const args = { ...rawArgs, playlist_name: rawArgs.playlist_name ?? 'My Saved Albums', include_singles: rawArgs.include_singles ?? 'false' };
      return ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Migrate my saved albums into one playlist. Use get_saved_albums with fetch_all=true to list everything saved. Collect every album ID, then fetch album metadata in chunks of 20 using get_several_albums. From those results, pick albums matching the type filter${args.include_singles === 'true' ? '' : ' (keep only album_type=="album", skip "single" and "compilation")'}. Extract track URIs directly from the album objects returned by get_several_albums (they already include tracks.items for albums ≤50 tracks) — do NOT call get_album_tracks per album. Only call get_album_tracks for albums where total_tracks > 50 or where tracks are missing. If no albums match the type filter, report 0 and skip playlist creation. Collect ALL track URIs into one deduplicated ordered list preserving album order. Check whether a playlist named "${args.playlist_name}" already exists via get_user_playlists (fetch_all=true) — page through every playlist until found, otherwise a name match deeper in the user's library would be missed; if it does exist, reuse its ID, otherwise create it with create_playlist (description "Tracks migrated from my saved albums"). Use add_to_playlist in batches of at most 100. IMPORTANT: preview the full plan with create_playlist(dry_run=true) and add_to_playlist(dry_run=true) before committing. Finish with counts: albums walked, unique tracks added, duplicates skipped. ${footer}`,
        },
      }],
    });
  }
  );

  // podcast_catchup — new episodes since a date across followed shows (#456, #516, #460, #716).
  server.prompt(
    'podcast_catchup',
    'List new podcast episodes published recently across your saved shows, and queue them if asked.',
    {
      days: z.coerce.number().int().positive().max(365).optional().describe('Lookback window in days for show_new_episodes (default 7)'),
      per_show_limit: z.coerce.number().int().positive().max(50).optional().describe('Max latest episodes to check per show (default 3)'),
      max_shows: z.coerce.number().int().positive().max(500).optional().describe('Per-call budget for show episode lookups (default 25)'),
    },
    async (rawArgs) => {
      const args = {
        days: rawArgs.days ?? 7,
        per_show_limit: rawArgs.per_show_limit ?? 3,
        max_shows: rawArgs.max_shows ?? 25,
      };
      return ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Catch me up on podcasts from the last ${args.days} day(s). Prefer show_new_episodes (days=${args.days}, per_show_limit=${args.per_show_limit}, max_shows=${args.max_shows}) to aggregate across saved shows in one call; only fall back to get_saved_shows (fetch_all=true) + list_show_episodes per show if show_new_episodes is unavailable (toolset-trimmed). Keep capped at ${args.per_show_limit} per show, newest first. If no saved shows or no episodes in the lookback window, say so explicitly rather than presenting an empty list. For the list_show_episodes fallback, fetch max_results=${Math.max(args.per_show_limit * 3, 10)} and keep per_show_limit small (default 3) unless I explicitly ask for more. Present grouped by show: episode title, release date, duration, description snippet, and episode URI/ID. Flag anything longer than 90 minutes as a "long listen". At the end ask whether I want any of them queued now via batch_add_to_queue or played directly — do not start playback unprompted. ${footer}`,
        },
      }],
    });
  }
  );

  // artist_deep_dive — guided discography tour for one artist (#457, #462, #460).
  server.prompt(
    'artist_deep_dive',
    "Tour an artist's discography: profile, albums, standout tracks.",
    {
      artist: z.string().describe('Artist name, ID, or URI'),
    },
    async (args) => {
      const rateLimitHint = resourceHints
        ? 'Note rate limits: 3 album-track fetches are expected; wait and retry once on 429 via spotify://me/rate-limit.'
        : 'Note rate limits: 3 album-track fetches are expected; on 429 the failed call already carries the wait — structuredContent.error.retryAfterSec holds the Retry-After seconds, so wait that long and retry once.';
      return ({
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `Deep-dive into the artist "${args.artist}". Resolve the name with search (types=["artist"], limit 10) and confirm with get_artist (genres, images). If search returns 0 artists, report 'no match for "${args.artist}"' and stop. Then call get_artist_albums and get_artist_top_tracks (to identify hits to skip); pick a representative tour: their most recent album, one breakout/earlier album, and one fan favourite (use track order and your judgement — popularity fields are no longer exposed by the API). If get_artist_albums is empty, say so. For each chosen album pull tracks with get_album_tracks (limit 50; if total >50, paginate with offset) and flag unavailable/null tracks. If a track fetch partially fails, present the albums you did retrieve and note the missing one. ${rateLimitHint} Write up: who they are in two sentences, the era-by-era story of the albums you toured, a "start here" 8-track mini-playlist with URIs, and one deep cut worth hearing. When offering to keep the 8-track list as a playlist, preview with create_playlist(dry_run=true) and add_to_playlist(dry_run=true) before committing. NOTE: get_artist_top_tracks may 403 on app registrations created after November 2024 — Spotify removed GET /artists/{id}/top-tracks in the February 2026 Web API changes. If it 403s, skip the call and infer hits to skip from the artist's most-streamed albums via get_artist_albums + get_album_tracks ordering instead. ${footer}`,
          },
        }],
      });
    },
  );

  // music_briefing — daily/weekly briefing from radar tools (#227).
  server.prompt(
    'music_briefing',
    'Daily or weekly music briefing: new podcast episodes, new releases from followed artists, catalog freshness, and recently played — composed from radar tools.',
    {
      interval: z.enum(['daily', 'weekly']).optional().describe('Briefing cadence: daily (default) or weekly'),
      max_shows: z.coerce.number().int().positive().max(20).optional().describe('Max shows to check for new episodes (default 3)'),
      max_artists: z.coerce.number().int().positive().max(20).optional().describe('Max followed artists to check for new releases (default 5)'),
      brief: z.enum(['true', 'false']).optional().describe("When 'true', keep each section to one line (default 'false')"),
    },
    async (rawArgs) => {
      const args = {
        interval: (rawArgs.interval as string) ?? 'daily',
        max_shows: (rawArgs.max_shows as number) ?? 3,
        max_artists: (rawArgs.max_artists as number) ?? 5,
        brief: (rawArgs.brief as string) ?? 'false',
      };
      const horizon = args.interval === 'weekly' ? 'past 7 days' : 'past 24 hours';
      const detail = args.brief === 'true' ? 'Keep each section to a single concise line.' : 'Give a short paragraph per section with names, dates, and URIs where available.';
      return {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Write my ${args.interval} music briefing for the ${horizon}. Work through these sections in order; if a tool is unavailable (toolset-trimmed), skip that section with a one-line note and continue — never fail the whole briefing for one missing tool.`,
              `1. New podcast episodes — call show_new_episodes (or get_saved_shows + list_show_episodes if show_new_episodes is unavailable) for up to ${args.max_shows} shows; present as "New podcast episodes" with show, episode title, release date, and URI.`,
              `2. New releases — call get_followed_artists (fetch_all=true) to list up to ${args.max_artists} followed artists, then get_artist_albums (include_groups=["album","single"], fetch_all=true, limit=10) per artist to enumerate recent releases; present as "New releases" with artist, release name, type, and URI. (artist_release_digest is NOT a release-fetch tool — it reads a local watchlist sidecar — so prefer the followed-artists + per-artist albums path; only mention artist_release_digest if the user has explicitly set up a watchlist and asks to consult it.)`,
              `3. Catalog freshness — call whats_new; present as "Catalog freshness" with a one-line freshness summary.`,
              `4. You were listening to — call get_recently_played (limit 10); present as "You were listening to" with track/episode, artist/show, and when played.`,
              `5. Close with a single suggestion line tying the briefing together (e.g. "Try queuing X next" or "Catch up on Y").`,
              detail,
            ].join('\n'),
          },
        }],
      };
    },
  );
  server.prompt('morning_briefing', 'Morning briefing: new releases + listening streak + top track.', async () => ({
    messages: [{ role: 'user', content: { type: 'text', text: `Give me a morning briefing: call listening_streaks, get_top_tracks (short_term, limit 5), and get_recently_played (limit 10). Summarize streak, top track, and 3 “play next” suggestions with URIs. If a tool is unavailable (toolset-trimmed), skip that section with a one-line note and continue — never fail the whole briefing for one missing tool. If a data call returns 0 items, note it explicitly rather than inventing content. ${footer}` } }],
  }));
  server.prompt('weekly_digest', 'Weekly digest: taste shift + streaks + recommendations.', async () => {
    // #695: `listening_report` is a derived listening metric and registers only
    // under SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS, so a prompt that names it
    // unconditionally instructs the agent to call a tool this server does not
    // serve. The prompt text is therefore built from the same gate the registry
    // acted on rather than hardcoded — a prompt that advertised a missing tool
    // would be the same defect as a tool description pointing at one.
    const rollup = derivedAnalyticsEnabled()
      ? 'listening_report (medium_term)'
      : 'top_artists_by_range (long_term) — the window-based roll-up; derived listening metrics are not registered on this server (see SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS)';
    return {
      messages: [{ role: 'user', content: { type: 'text', text: `Weekly digest: call taste_shift_report, listening_streaks, and ${rollup}. Write a 7-day roll-up: rising artist, streak summary, library vibe, and one crate-digging pick with URIs. If a tool is unavailable (toolset-trimmed), skip that section with a one-line note and continue — never fail the whole briefing for one missing tool. If a data call returns 0 items, note it explicitly. ${footer}` } }],
    };
  });
  server.prompt('crate_digging', 'Crate dig deep cuts for your top artists.', { depth: z.coerce.number().int().positive().max(5).optional().describe('Deep cuts per artist (default 3)') }, async (rawArgs) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `Crate digging: for up to 5 artists from get_top_artists (short_term) — if fewer than 5, dig only the ones available and note the shortfall — find ${(rawArgs as { depth?: number }).depth ?? 3} non-hit deep cuts per artist. Use get_artist_top_tracks to identify hits to skip in one call per artist, ${moodExpansionClause('"the sound you are digging for"')} then use 1–2 broad search_deep queries (types=["track"], pages 2 — two 10-result pages per call) covering multiple artists/genres rather than one per deep cut, plus get_artist_albums and get_album_tracks (limit 50, paginate if needed) to surface deep cuts. Propose a playlist with URIs. If I want to keep it, create it with create_playlist and add_to_playlist — preview with dry_run=true before committing. If per-artist searches return 0 deep cuts, report it and suggest broadening. NOTE: get_artist_top_tracks may 403 on app registrations created after November 2024 — Spotify removed GET /artists/{id}/top-tracks in the February 2026 Web API changes. If it 403s for an artist, skip just that artist's hit-skip step and rely on get_artist_albums + get_album_tracks ordering for the same signal; do not abort the whole dig. ${footer}` } }],
  }));

  // triage_liked_songs — walk the saved-tracks backlog into bucket
  // playlists (#112 idea 8).
  server.prompt(
    'triage_liked_songs',
    'Triage your Liked Songs backlog into era- or genre-bucket playlists.',
    {
      bucket_by: z.enum(['decade', 'genre', 'artist']).optional()
        .describe("Bucketing key: 'decade' (album release era), 'genre' (sidecar artist tags), or 'artist' (primary artist) (default: 'decade')"),
      batch_size: z.coerce.number().int().positive().max(100).optional()
        .describe('Max URIs per add_to_playlist call; playlists are filled per pass of this size (default 100)'),
      confirm: z.enum(['true', 'false']).optional()
        .describe("When 'true', present a plan and ask before any playlist is created or modified (default: 'true')"),
    },
    async (rawArgs) => {
      const args = {
        bucket_by: rawArgs.bucket_by ?? 'decade',
        batch_size: rawArgs.batch_size ?? 100,
        confirm: rawArgs.confirm ?? 'true',
      };
      const guard = args.confirm === 'true'
        ? 'CONFIRM-FIRST MODE: present the plan above and STOP for my approval before any create_playlist or add_to_playlist call goes through; attach a dry_run=true preview next to every planned write.'
        : 'AUTO MODE: proceed without waiting for approval, but still run each planned write once with dry_run=true before doing it for real.';
      const bucketing =
        args.bucket_by === 'decade'
          ? 'Collect distinct album IDs from step 1, then fetch album metadata in chunks of 20 using get_several_albums (cache lookups; do not re-fetch). Read each release_date and assign the track to a decade bucket such as "Liked · 2010s".'
          : args.bucket_by === 'genre'
            ? 'Call library_genre_report to see which of my artists carry sidecar genre tags, then filter_by_genre once per tag to collect matching saved-track URIs into genre buckets such as "Liked · Jazz". If the report comes back empty, ask ME for an artist-to-genre mapping on this first pass instead of guessing.'
            : 'Group tracks by their primary artist name straight from the saved-track data (no extra lookups), one bucket per major artist such as "Liked · Queen".';
      return {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Triage my Liked Songs backlog into playlists, bucketed by ${args.bucket_by}.`,
              '1. Page through get_saved_tracks with fetch_all=true and collect every liked track URI.',
              `2. ${bucketing}`,
              '3. Present a plan: one proposed playlist per bucket worth a full pass plus a catch-all "Liked · Everything Else", each with its track count.',
              `4. Once approved, check get_user_playlists (fetch_all=true) for existing names to reuse — page through every playlist so a name match deeper in the user's library is not missed — create any missing playlists with create_playlist, then fill them with add_to_playlist in batches of at most ${Math.min(args.batch_size, 100)} URIs.`,
              guard,
              '5. Finish with per-playlist counts (tracks added, duplicates skipped) and remind me that undo is remove_from_playlist with those same URIs.',
            ].join('\n'),
          },
        }],
      };
    },
  );

  // Must come after every `server.prompt(...)` above: the boundary reads the
  // registry to learn each prompt's argument names.
  installPromptErrorBoundary(server);
}
