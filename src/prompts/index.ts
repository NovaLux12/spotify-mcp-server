import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Shared optional time-range argument (#60): defaults preserve old behaviour.
 * Prompt arguments travel as protocol strings, so numeric/boolean options use
 * coerce/enum shapes instead of raw z.number()/z.boolean().
 */
const TimeRange = z
  .enum(['short_term', 'medium_term', 'long_term'])
  .optional()
  .describe('Spotify time range: short_term (4 weeks), medium_term (6 months), long_term (all time)');

export function registerPrompts(server: McpServer): void {
  // dj — act as a DJ based on user's top artists and mood
  server.prompt(
    'dj',
    'Act as a DJ. Based on my top artists and current mood, queue up a set of songs.',
    async () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: 'Act as a DJ. Use get_top_artists and get_recently_played to understand my music taste and what I have been listening to lately, then use search to find tracks that fit that vibe. Queue them up using add_to_queue one by one. Aim for a cohesive set of 5–10 tracks that flows well.',
        },
      }],
    }),
  );

  // playlist_from_mood — create a playlist for a given mood
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
          text: `Create a playlist for this mood: "${args.mood}". Use up to 6 search calls with combined keywords, artists, and genres to find 15–20 tracks that fit the vibe. Then use create_playlist to make a new playlist with a fitting name and description, and add_to_playlist to fill it with the tracks you found. IMPORTANT: preview the plan with create_playlist(dry_run=true) and add_to_playlist(dry_run=true) before committing.`,
        },
      }],
    }),
  );

  // music_taste_summary — summarize the user's music taste (#60: now
  // parameterized; default 'all' keeps the original three-range behaviour)
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
      const ranges = args.time_range === 'all'
        ? ['short_term', 'medium_term', 'long_term']
        : [args.time_range];
      const calls = ranges.map((r) => `get_top_tracks (${r}) and get_top_artists (${r})`).join(', then ');
      const scope = args.time_range === 'all'
        ? 'across all three time ranges'
        : `for the ${args.time_range} window only`;
      return {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `Summarize my music taste ${scope}. Call ${calls}. Then write a detailed summary of my taste: genres I gravitate toward, artists I keep coming back to, how my taste has shifted over time${args.time_range === 'all' ? '' : ' within this window'}, and what that says about my listening habits.`,
          },
        }],
      };
    },
  );

  // discover_weekly_alternative — personalized discovery based on top tracks
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
          text: `Generate a personalised discovery list of ${args.size} songs for me. Use get_top_tracks (short_term) and get_recently_played to learn my recent favourites, then use search with combined genre/mood/artist queries to find ${args.size} lesser-known tracks in the same artistic space — dig beyond each favourite artist's biggest hits (deep cuts, B-sides, similar smaller artists). Use broad queries rather than one search per target track. IMPORTANT: explicitly exclude every track that appears in my top tracks or recently played, and skip each artist's most-streamed signature songs so the picks feel fresh. Focus on variety — mix up energy levels and moods while staying within my taste. Present the list with track names, artists, and URIs so I can play them.`,
        },
      }],
    });
  }
  );

  // playlist_audit — dedupe / dead-track health check for one playlist (#60).
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
          text: `Audit the playlist "${args.playlist}" for problems. If it was given by name, resolve it first with get_user_playlists; otherwise use its ID/URI directly. Pull every item with get_playlist_items (fetch_all=true). Then run find_duplicates_in_playlist and report its groups verbatim as the DUPLICATES section (it also catches relinked copies that ID-matching misses); additionally flag DEAD TRACKS — entries whose track is null or flagged unavailable/unplayable, including region-restricted relinks; (3) a summary table with counts per issue. For every problem entry give its position and URI so I can act with remove_from_playlist. Do NOT remove anything yet — just present findings and ask which fixes to apply.`,
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
          text: `Give me a listening recap for my ${args.time_range} history. Call get_top_tracks (time_range=${args.time_range}, limit=${args.size}), get_top_artists (time_range=${args.time_range}, limit=${args.size}), and get_recently_played (limit=50). Then write an engaging recap: my ${args.size} most-played tracks and artists, patterns across genres/moods/eras, how recently-played confirms or diverges from the charts, one "on repeat" callout, and one "you might be burning out on" callout based on repetition. End with three concrete follow-up suggestions (e.g. a playlist to revisit or an album to try) using real URIs.`,
        },
      }],
    });
  }
  );

  // migrate_library — turn saved albums into a playlist (#60).
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
          text: `Migrate my saved albums into one playlist. Use get_saved_albums with fetch_all=true to list everything saved. Collect every album ID, then fetch album metadata in chunks of 20 using get_several_albums. From those results, pick albums matching the type filter${args.include_singles === 'true' ? '' : ' (keep only album_type=="album", skip "single" and "compilation")'}, then fetch their tracks. Collect ALL track URIs into one deduplicated ordered list preserving album order. Check whether a playlist named "${args.playlist_name}" already exists via get_user_playlists — if it does, reuse its ID, otherwise create it with create_playlist (description "Tracks migrated from my saved albums"). Use add_to_playlist in batches of at most 100. IMPORTANT: preview the full plan with create_playlist(dry_run=true) and add_to_playlist(dry_run=true) before committing. Finish with counts: albums walked, unique tracks added, duplicates skipped.`,
        },
      }],
    });
  }
  );

  // podcast_catchup — new episodes since a date across followed shows (#60).
  server.prompt(
    'podcast_catchup',
    'List new podcast episodes published since a date across your saved shows, and queue them if asked.',
    {
      since: z.string().describe('Only include episodes released on or after this date (YYYY-MM-DD)'),
      max_per_show: z.coerce.number().int().positive().max(10).optional().describe('Max episodes to list per show (default 3)'),
    },
    async (rawArgs) => {
      const args = { ...rawArgs, max_per_show: rawArgs.max_per_show ?? 3 };
      return ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Catch me up on podcasts since ${args.since}. Call get_saved_shows (fetch_all=true), then for each show call get_show_episodes (limit=${Math.max(args.max_per_show * 3, 10)}). Keep only episodes whose release_date is >= ${args.since}, newest first, capped at ${args.max_per_show} per show. For efficiency, keep max_per_show small (default 3) unless I explicitly ask for more. Present grouped by show: episode title, release date, duration, description snippet, and episode URI/ID. Flag anything longer than 90 minutes as a "long listen". At the end ask whether I want any of them queued now via batch_add_to_queue or played directly — do not start playback unprompted.`,
        },
      }],
    });
  }
  );

  // artist_deep_dive — guided discography tour for one artist (#60).
  server.prompt(
    'artist_deep_dive',
    "Tour an artist's discography: profile, albums, standout tracks.",
    {
      artist: z.string().describe('Artist name, ID, or URI'),
    },
    async (args) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Deep-dive into the artist "${args.artist}". Resolve the name with search (types=["artist"]) and confirm with get_artist (genres, images). Then call get_artist_albums and pick a representative tour: their most recent album, one breakout/earlier album, and one fan favourite (use track order and your judgement — popularity fields are no longer exposed by the API). For each chosen album pull tracks with get_album_tracks. Write up: who they are in two sentences, the era-by-era story of the albums you toured, a "start here" 8-track mini-playlist with URIs, and one deep cut worth hearing. Offer to create this as a playlist via create_playlist/add_to_playlist if I want to keep it.`,
        },
      }],
    }),
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
              `1. New podcast episodes — call show_new_episodes (or get_saved_shows + get_show_episodes if show_new_episodes is unavailable) for up to ${args.max_shows} shows; present as "New podcast episodes" with show, episode title, release date, and URI.`,
              `2. New releases — call artist_release_digest (or get_followed_artists + get_artist_albums if unavailable) for up to ${args.max_artists} followed artists; present as "New releases" with artist, release name, type, and URI.`,
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
    messages: [{ role: 'user', content: { type: 'text', text: 'Give me a morning briefing: call listening_streaks, get_top_tracks (short_term, limit 5), and get_recently_played (limit 10). Summarize streak, top track, and 3 “play next” suggestions with URIs.' } }],
  }));
  server.prompt('weekly_digest', 'Weekly digest: taste shift + streaks + recommendations.', async () => ({
    messages: [{ role: 'user', content: { type: 'text', text: 'Weekly digest: call taste_shift_report, listening_streaks, and listening_report (medium_term). Write a 7-day roll-up: rising artist, streak summary, library vibe, and one crate-digging pick with URIs.' } }],
  }));
  server.prompt('crate_digging', 'Crate dig deep cuts for your top artists.', { depth: z.coerce.number().int().positive().max(5).optional().describe('Deep cuts per artist (default 3)') }, async (rawArgs) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `Crate digging: for each of your top 5 artists (get_top_artists short_term), find ${(rawArgs as { depth?: number }).depth ?? 3} non-hit deep cuts via search + get_artist_albums + get_album_tracks, skipping each artist's top tracks. Propose a playlist with URIs. If I want to keep it, create it with create_playlist and add_to_playlist — preview with dry_run=true before committing.` } }],
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
              `4. Once approved, check get_user_playlists for existing names to reuse, create any missing playlists with create_playlist, then fill them with add_to_playlist in batches of at most ${Math.min(args.batch_size, 100)} URIs.`,
              guard,
              '5. Finish with per-playlist counts (tracks added, duplicates skipped) and remind me that undo is remove_from_playlist with those same URIs.',
            ].join('\n'),
          },
        }],
      };
    },
  );
}
