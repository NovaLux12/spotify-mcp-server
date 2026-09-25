# Compliance notes: listening analytics

This server talks to one Spotify account — the account its owner configures — and
every response it gets is that account's own data. Even so, some of what the
analytics family computes is a *derived listening metric*, and the Spotify
Developer Policy restricts those. This page records what the project derives,
which of it is on by default, and the interpretation the project relies on.

## The policy clause

Spotify's Developer Policy, Section III.13 ("Prohibited Applications"), limits
what may be done with Spotify Content and the Service. The part this project
plans around:

> you must not, and may not encourage others to, analyse Spotify Content or the
> Service in order to create new or derived listenership metrics, benchmarking,
> functionality, usage statistics, user metrics, or building profiles of users.

Terms of Service Section IX.8.d is the enforcement hook: a breach can lead to the
Software Development Agreement being disabled and Security Codes revoked.

Whether III.13 reaches a single-user, personal client that never transmits a
metric anywhere is arguable — the audit that produced this page recorded it as
unadjudicated. The project therefore does not rely on the argument alone. It ships
the reading it can defend, makes the operator choose, and documents the choice.

## The interpretation this project relies on

1. **Local only.** Every derived number is computed in-process, in the operator's
   own server, from responses to that operator's own account. Nothing derived is
   sent to Spotify, to a third party, or to any telemetry sink. A derived metric
   does not leave the machine that produced it.
2. **No third-party listening data.** The project never receives another user's
   listening data — there is no path that could. "Analytics" here always means
   "metrics about the account this server is authenticated as".
3. **No profile, no persistence.** The server holds no database of listening
   history and writes no profile. Metrics are computed per call from the rows
   Spotify returns in that call and are discarded when the response is sent.
4. **Not a benchmark.** Nothing here compares this account against other users,
   a population, or a leaderboard assembled from other people's data. Comparing
   two time windows of the *same* account is a re-presentation of the account's
   own data.
5. **Operator's choice, not the package's.** The metrics the project reads as
   genuinely "derived" are opt-in and off by default, so a user who does not want
   them is never exposed to them.

## The opt-in

Derived listening analytics are gated behind one environment variable:

    SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS=1

Accepted truthy values are `1`, `true`, `yes`, `on` (case-insensitive), matching
the server's existing env convention. Unset or any other value means **off**.

- **Off (default).** The gated tools are not registered at all. They do not
  appear in `tools/list`, cannot be called, and cost no quota. Tools that stay
  registered but compute derived fields return `null` for those fields instead of
  a fabricated zero or an empty object.
- **On.** Every gated tool is registered and returns exactly the payload it
  returned before the gate existed.

The flag is read once, when the server registers its tools, so a running server
keeps one consistent surface: a tool never advertises a field it will not compute.

## What is derived from listening data

### Gated — derived metrics (off by default)

These do not return a re-presentation of Spotify's rows. They aggregate, bin,
ratio, or classify them, and the result is a new statement about the listener.
Each carries the one-line note "Metrics are computed locally from your own
account data; not derived from third-party listening data."

| Tool | What it derives |
| --- | --- |
| discovery_ratio | Share of recent plays that fall outside the account's top-tracks window — a new "discovery vs staple" ratio |
| listening_clock | 24-bucket hour-of-day histogram, daypart totals, peak and quietest hour |
| listening_clock_heatmap | Weekday × hour matrix with a peak cell |
| artist_listening_clock | Per-artist hour-of-day profile and daypart split |
| mood_bucket_report | Daypart × familiarity cross-tabulation presented as a "listening-mood proxy" |
| weekday_listening_report | Per-weekday play/unique-track/unique-artist profile and busiest day |
| binge_detector_report | Per-artist play counts above a threshold, ranked by intensity |

The gated tool names are written without code formatting in this file on
purpose: the documentation tool-name check resolves names against the *default*
registry, where these tools do not exist until the flag is set, and a
backticked name it cannot resolve fails that check.

### Always available — re-presentations of the account's own data

These return Spotify's own top-items and recently-played rows, summarised. They
are not gated, and the project reads them as "your data, summarised":

`listening_history_export`, `weekly_rotation_report`, `listening_gaps_report`,
`session_length_report`, `track_rotation_report`, `repeat_listener_report`,
`listening_streak_report`, `listening_streaks`, `listening_consistency_score`,
`era_preference_report`, `top_genre_census`, `deep_dive_report`,
`top_artist_leaderboard`, `top_track_leaderboard`, `top_artist_ranking_delta`,
`top_track_ranking_delta`, `artist_velocity_report`, `listening_recap_brief`,
`listening_report`, `top_artists_by_range`, `taste_shift_report`.

Some of these still summarise rather than dump (a streak is a run of days, not a
row). The project's line is drawn at "does this produce a statement about the
listener that the API did not already make", and the seven gated tools are the
ones where the answer is clearly yes.

`listening_report` straddles the line, which is why it is registered in both
states: the two-window rising/constant/fading comparison of the account's own
top tracks is always computed, while its era histogram, discovery ratio,
recently-played overlap, and hour-of-day buckets are computed only with the flag
set. With the flag unset the tool's description says so, and the derived fields
come back `null` — the description never advertises a field the handler skips.

## Which data the derived metrics read

Only endpoints scoped to the authenticated account:

- `GET /me/player/recently-played` — a bounded cursor walk (at most three pages)
  for the hour, weekday, rotation, and binge breakdowns.
- `GET /me/top/tracks` and `GET /me/top/artists` — the account's own time-window
  rankings, used as the "known music" baseline for discovery ratios.
- `GET /artists?ids=` — genres for the genre census only.

The gating also removes the quota cost the issue flagged: the analytics family is
among the heaviest users of the recently-played walk, and with the flag unset
those walks are not issued at all.

## Which option the project took

The issue left two options for keeping the derived tools available: keep issuing
fresh Spotify Content requests, or compute only from a snapshot the user had
already exported. **This project kept fresh requests and gated them behind the
opt-in.** The reason is that the local-snapshot path still derives the same
metrics from the same Spotify Content, so it changes where the rows come from but
not what the server computes; only an explicit operator choice changes that. The
gated tools therefore issue the same requests they always did when the flag is
set, and no requests at all when it is not.

## Known gaps

- `listening_recap_brief` composes peak hour, busiest weekday, and discovery ratio
  into one brief, and stays registered without the flag. Its window summary is
  therefore narrower than the gate implies. Gating it is follow-up work.
- Streak, rotation, repeat, and consistency metrics are read as summaries of the
  account's own rows and are not gated. A stricter reading of III.13 would gate
  them too; that reading is recorded here so the choice is visible rather than
  implicit.
