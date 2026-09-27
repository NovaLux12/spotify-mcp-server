/**
 * The retained half of the #695 classification oracle.
 *
 * This lives in a helper rather than in the test body for the same reason
 * `tests/tool.coverage.test.ts` excludes itself from its own scan: a name
 * written here is a name a test *enumerated*, not one it *called*. The coverage
 * gate reads a string literal in a test file as evidence that the tool behind
 * it is exercised, and this list proves the opposite — it exists to assert that
 * these twenty-one tools are still REGISTERED, and no test in the tree invokes
 * a single one of their handlers. Leaving it in the test body would make the
 * coverage headline claim those tools are tested, and would fail the
 * "an allow-listed name now has a test, delete the entry" shrink check for a
 * list that is still true.
 *
 * It is a helper and not a constant in the source tree on purpose too: the
 * oracle has to be hand-written and independent of `DERIVED_ANALYTICS_TOOLS`,
 * or the totality assertion in the test compares the list against itself and
 * passes whatever the list happens to contain.
 */
export const RETAINED_ANALYTICS_TOOLS: ReadonlySet<string> = new Set([
  // analytics.ts
  'listening_streaks', 'top_artists_by_range', 'taste_shift_report',
  // libraryanalytics.ts
  'library_coverage_report', 'library_growth_report', 'genre_trends_over_time',
  // swarm3_analytics.ts
  'top_artist_ranking_delta', 'top_track_ranking_delta', 'top_artist_leaderboard',
  'top_track_leaderboard', 'artist_velocity_report', 'track_rotation_report',
  'repeat_listener_report', 'listening_streak_report', 'top_genre_census',
  'deep_dive_report', 'session_length_report', 'listening_gaps_report',
  'listening_consistency_score', 'era_preference_report', 'listening_history_export',
]);
