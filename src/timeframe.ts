/**
 * The server's UTC calendar frame: how a `played_at` instant becomes an hour
 * of day and a day of the week.
 *
 * These two functions live here, and not in a tool module, because two tool
 * modules need them. `weekday_heatmap` (exhaust2_playback) and the swarm3
 * analytics family both bucket recently-played rows, and when only one of them
 * read the host's zone the two tools reported different answers for the same
 * rows on any machine not set to UTC (#1638; the same split inside a single
 * payload was #823/#824).
 *
 * A tool module cannot simply import the other: `tests/lazy-module-loading.test.ts`
 * holds that a trimmed `TOOLSETS=` surface must not evaluate a module whose
 * registration key is inactive, and a static tool-to-tool import evaluates it
 * at load time regardless of the toolset. So the primitive is here, in a
 * module no toolset owns, and both sides import the same one. That is the
 * whole reason for the file: there is now one idiom for reading the frame, in
 * one place, and a fourth accessor cannot quietly appear beside it.
 */

/** Hour-of-day in the UTC frame: the calendar hour written into played_at, not
 * the host's local one. Every hour/daypart/weekday bucket reads its calendar
 * fields this way so a single payload never mixes UTC day metrics with
 * host-local hour metrics. */
export function utcHour(iso: string): number {
  return Number.parseInt(iso.slice(11, 13), 10);
}

/** Day-of-week of the UTC calendar date, as 0=Sunday..6=Saturday (the
 * `Date.prototype.getUTCDay()` convention), from a full ISO instant or a bare
 * YYYY-MM-DD prefix. Parsed as a date, never as a local instant, so the result
 * cannot drift with the host time zone.
 *
 * Returns the index rather than a name so each caller keeps its own label
 * table — the analytics family orders Mon-first, `weekday_heatmap` Sun-first —
 * without either re-deriving the day itself. */
export function utcDayIndex(iso: string): number {
  const y = Number.parseInt(iso.slice(0, 4), 10);
  const m = Number.parseInt(iso.slice(5, 7), 10);
  const d = Number.parseInt(iso.slice(8, 10), 10);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
