/**
 * The derived-listening-analytics opt-in (#695).
 *
 * ## What is being withheld, and why
 *
 * Spotify's Developer Policy Sec. III.13 prohibits analysing Spotify Content
 * or the Service to create "new or derived listenership metrics, benchmarking,
 * functionality, usage statistics, user metrics, or building profiles of
 * users". This server does that on purpose: it buckets recently-played history
 * into hour-of-day and daypart histograms, breaks it down by weekday, and
 * scores it into discovery ratios, binge scores and listening consistency
 * numbers. Those outputs are exactly the shape Sec. III.13 names.
 *
 * The project does not read Sec. III.13 as forbidding the work outright — a
 * single-user personal client computing over its own account's own data is an
 * arguable case, and that argument is recorded in `docs/compliance.md` rather
 * than settled here. What is NOT arguable is that the default should be the
 * argued side. So the derived tools are withheld unless an operator sets
 * SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS, and the non-analytics path is the
 * default for everyone who sets nothing.
 *
 * ## What is NOT withheld
 *
 * Re-presentations of what Spotify itself returned stay registered, because a
 * summary of your own top tracks is not a metric computed about you — it is
 * the API's answer, re-shaped. `get_top_artists`, `get_top_tracks`,
 * `get_recently_played`, `top_artists_by_range`, `taste_shift_report`,
 * `listening_history_export` and the rest of the leaderboard/delta tools are
 * all in that class and are unaffected. The line is drawn on the OUTPUT, not
 * on the module: `analytics.ts` keeps three of its four tools and loses one.
 *
 * ## Why the gate is name-driven, and why that is safe here
 *
 * `DERIVED_ANALYTICS_TOOLS` is a curated list, and a curated list is only as
 * good as the process that keeps it total. The hazard is a future derived tool
 * added to one of the three analytics modules and shipped registered by
 * default because nobody added its name here. That hazard is closed by
 * `tests/derived-analytics-gate.test.ts`, which asserts the partition is TOTAL
 * and DISJOINT: every tool the three modules register with the opt-in ON must
 * be in this set or in the test's own retained list. A new tool therefore
 * cannot register-by-default unnoticed — the test goes red until it is
 * classified either way. The same total-partition guard is what `NEVER_MUTATING_PLANS`
 * relies on in src/tools/annotations.ts.
 *
 * Note the direction of the default is REGISTER, not withhold: an unlisted name
 * is not treated as derived. Combined with the total-partition test that is
 * safe, and it is the smaller hand-typed surface — the alternative (an
 * allowlist of every retained name) would mean hand-typing 21 more names that
 * the test would then have to keep in sync.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { experimentalAnalyticsEnv } from './config.js';

/**
 * Every tool whose OUTPUT is a derived listening metric, histogram, bucket,
 * ratio, score, or behavioural profile — the Sec. III.13 shape.
 *
 * Grouped by the module that registers it, and named individually rather than
 * matched by a prefix, because a prefix rule cannot tell `listening_clock`
 * (gated) from `listening_history_export` (not gated) and `listening_report`
 * (gated) from `listening_streaks` (not gated) — the two families differ by one
 * character and sit in different modules.
 */
export const DERIVED_ANALYTICS_TOOLS: ReadonlySet<string> = new Set([
  // src/tools/analytics.ts — one aggregate whose payload is era histogram plus
  // discovery ratio plus hour-of-day buckets. The ungated part of it (track
  // ranks across two windows) is already served, ungated, by `taste_shift_report`
  // in the same module, so withholding the aggregate costs no reachable answer.
  'listening_report',
  // src/tools/libraryanalytics.ts — 168 hourly slots (24h x 7d) with a peak and
  // a least hour. The other three tools in this module are library-shape
  // summaries, not listening-clock metrics, and stay.
  'listening_heatmap',
  // src/tools/swarm3_analytics.ts — the nine the issue names plus the two
  // composites it describes by their contents.
  'discovery_ratio',
  'listening_clock',
  'listening_clock_heatmap',
  'artist_listening_clock',
  'mood_bucket_report',
  'weekday_listening_report',
  'weekly_rotation_report',
  'binge_detector_report',
  // Reports peak hour, busiest weekday and discovery ratio in one call, so it
  // cannot be answered without the three metrics withheld above. Gating the
  // composite is also what keeps the default surface from advertising an
  // analytics capability in a single glance at `tools/list`.
  'listening_recap_brief',
]);

/**
 * Whether derived listening analytics are registered.
 *
 * Reads `process.env` LIVE for the same reason `readOnlyModeEnabled` does: the
 * answer is consulted at registration time and again when the surface census
 * measures, and a snapshot bound at startup could answer for a different moment
 * than the gate that actually ran. The PARSE stays in config.ts
 * (`experimentalAnalyticsEnv`, one `truthyEnv`), so there is one definition of
 * what counts as a boolean and one place that warns about a value naming none.
 */
export function derivedAnalyticsEnabled(): boolean {
  return experimentalAnalyticsEnv();
}

/**
 * Wrap `server` so a registrar can register its full tool set and the gate
 * drops the derived ones.
 *
 * Shaped like `readOnlyToolServer` in src/tools/annotations.ts and for the same
 * reason: a per-call-site `if` scattered through three registrars is a
 * classification that a later edit can quietly break, and it reindents large
 * handler bodies for no gain. Here the registrar still reads as a flat list of
 * `server.tool(...)` calls, the gate is one line at the top of each registrar,
 * and the withheld names are stated once, in this file.
 *
 * Every other property is forwarded to the real server with `this` bound to it,
 * so a registrar that reads `_registeredTools` still sees the true registry —
 * `registerSwarm3AnalyticsTools` and its siblings do not, but the doctor and
 * swarm3_meta do, and they are not wrapped by this.
 */
export function derivedAnalyticsToolServer(server: McpServer): McpServer {
  if (derivedAnalyticsEnabled()) return server;
  return new Proxy(server, {
    get(target, property) {
      if (property === 'tool' || property === 'registerTool') {
        return (...args: unknown[]): void => {
          const name: unknown = args[0];
          if (typeof name === 'string' && DERIVED_ANALYTICS_TOOLS.has(name)) return;
          const register = Reflect.get(target, property, target) as (...call: unknown[]) => unknown;
          register.apply(target, args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
