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
          text: `Create a playlist for this mood: "${args.mood}". Use search to find 15–20 tracks that fit the vibe (search several related keywords, artists, and genres to get good variety). Then use create_playlist to make a new playlist with a fitting name and description, and add_to_playlist to fill it with the tracks you found.`,
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
          text: `Generate a personalised discovery list of ${args.size} songs for me. Use get_top_tracks (short_term) and get_recently_played to learn my recent favourites, then use search to find ${args.size} lesser-known tracks in the same artistic space — dig beyond each favourite artist's biggest hits (deep cuts, B-sides, similar smaller artists). IMPORTANT: explicitly exclude every track that appears in my top tracks or recently played, and skip each artist's most-streamed signature songs so the picks feel fresh. Focus on variety — mix up energy levels and moods while staying within my taste. Present the list with track names, artists, and URIs so I can play them.`,
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
          text: `Audit the playlist "${args.playlist}" for problems. If it was given by name, resolve it first with get_user_playlists; otherwise use its ID/URI directly. Pull every item with get_playlist_items (fetch_all=true). Then report: (1) DUPLICATES — same track appearing more than once (match on track ID, and flag near-duplicates where name + artist + duration match but IDs differ); (2) DEAD TRACKS — entries whose track is null or flagged unavailable/unplayable, including region-restricted relinks; (3) a summary table with counts per issue. For every problem entry give its position and URI so I can act with remove_from_playlist. Do NOT remove anything yet — just present findings and ask which fixes to apply.`,
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
          text: `Migrate my saved albums into one playlist. Use get_saved_albums with fetch_all=true to list everything saved. For each album${args.include_singles === 'true' ? '' : ' whose album_type is "album" (skip "single")'}, fetch its tracks with get_album_tracks. Collect ALL track URIs into one deduplicated ordered list (album by album, preserving track order). Check whether a playlist named "${args.playlist_name}" already exists via get_user_playlists — if it does, reuse its ID, otherwise create it with create_playlist (description "Tracks migrated from my saved albums"). Add the URIs to it with add_to_playlist in batches of at most 100. Finish with counts: albums walked, unique tracks added, duplicates skipped.`,
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
          text: `Catch me up on podcasts since ${args.since}. Call get_saved_shows (fetch_all=true), then for each show call get_show_episodes (limit=${Math.max(args.max_per_show * 3, 10)}). Keep only episodes whose release_date is >= ${args.since}, newest first, capped at ${args.max_per_show} per show. Present grouped by show: episode title, release date, duration, description snippet, and episode URI/ID. Flag anything longer than 90 minutes as a "long listen". At the end ask whether I want any of them queued now via add_to_queue or played directly — do not start playback unprompted.`,
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
          text: `Deep-dive into the artist "${args.artist}". Resolve the name with search (types=["artist"]) and confirm with get_artist (genres, followers, popularity). Then call get_artist_albums and pick a representative tour: their most recent album, one breakout/earlier album, and one fan favourite (highest-popularity). For each chosen album pull tracks with get_album_tracks, and enrich 2–3 signature songs with get_artist_top_tracks cross-referencing. Write up: who they are in two sentences, the era-by-era story of the albums you toured, a "start here" 8-track mini-playlist with URIs, and one deep cut worth hearing. Offer to create this as a playlist via create_playlist/add_to_playlist if I want to keep it.`,
        },
      }],
    }),
  );
}
