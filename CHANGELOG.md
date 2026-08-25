# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note:** Going forward, releases are cut via [release-please](https://github.com/googleapis/release-please)
> from [Conventional Commits](https://www.conventionalcommits.org/). Entries below v1.0.4 were
> backfilled by hand from git history.

## [1.1.1](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.1.0...v1.1.1) (2026-08-25)


### Bug Fixes

* **client:** wire TTL cache reads + mutation history; docs sweep for v1.1.0 ([69bf757](https://github.com/NovaLux12/spotify-mcp-server/commit/69bf757894067b4c8e7ab535ef6241191763db29))

## [1.1.0] — 2026-08-25

Audit-closure release shipping every finding from the 2026-08-25 full audit,
organised into three epics: [#31 — endpoint parity](https://github.com/NovaLux12/spotify-mcp-server/issues/31),
[#32 — MCP experience](https://github.com/NovaLux12/spotify-mcp-server/issues/32),
[#33 — bug + security batch](https://github.com/NovaLux12/spotify-mcp-server/issues/33).
Registered tools grew from ~50 to 69; the test suite grew from 123 to 346 tests;
resources from 7 fixed URIs to 11 plus a paginated playlist template with JSON
variants; prompts from 4 to 9.

### Security

- **Reflected HTML injection (XSS) in the OAuth callback error page fixed (#19)** —
  every interpolated value (`error`, `error_description`, state) is HTML-escaped
  before being rendered into the response ([#19](https://github.com/NovaLux12/spotify-mcp-server/issues/19)).
- **Fetch timeouts on every outbound HTTP call (#11)** — raw API requests and token
  exchange/refresh now carry an `AbortSignal.timeout` (default 30 s, override with
  `SPOTIFY_REQUEST_TIMEOUT_MS`), so a hung connection can no longer stall the
  serialized request queue indefinitely ([#11](https://github.com/NovaLux12/spotify-mcp-server/issues/11)).

### Added — endpoint parity (#34–#50, #67)

- `follow_artists` / `unfollow_artists` — complete the artist-follow loop using the
  already-granted `user-follow-modify` scope; up to 50 IDs per call via query params
  ([#34](https://github.com/NovaLux12/spotify-mcp-server/issues/34),
  [#35](https://github.com/NovaLux12/spotify-mcp-server/issues/35)).
- Library tools accept `spotify:audiobook:` URIs, routed to `/me/audiobooks` with
  ids as query params ([#36](https://github.com/NovaLux12/spotify-mcp-server/issues/36)).
- New unified-library tools `save_to_library` / `remove_from_library` /
  `check_in_library` on the non-deprecated `/me/library` endpoints (any mix of
  track/album/episode/show/audiobook URIs; contains also covers artist); legacy
  per-type tools kept working ([#37](https://github.com/NovaLux12/spotify-mcp-server/issues/37)).
- `get_artist_top_tracks` with market support and graceful 403 handling
  ([#38](https://github.com/NovaLux12/spotify-mcp-server/issues/38));
  `get_available_markets` ([#49](https://github.com/NovaLux12/spotify-mcp-server/issues/49)).
- `get_several_*` batch family — tracks, albums, artists, episodes, shows,
  audiobooks, chapters — with per-type caps (50, albums 20) and automatic chunking
  through the rate-limited queue ([#43](https://github.com/NovaLux12/spotify-mcp-server/issues/43)).
- `get_user_profile` and paginated `get_user_playlists_by_id` in a new users module
  ([#39](https://github.com/NovaLux12/spotify-mcp-server/issues/39),
  [#40](https://github.com/NovaLux12/spotify-mcp-server/issues/40)).
- `replace_playlist_items` (atomic overwrite, >100 URIs chunked as PUT + appends)
  ([#41](https://github.com/NovaLux12/spotify-mcp-server/issues/41)); standalone
  paginated `get_playlist_items` on the non-deprecated `/items` path with
  `market`/`fields`/`additional_types` ([#42](https://github.com/NovaLux12/spotify-mcp-server/issues/42)).
- Playlist mutation precision: returned `snapshot_id` surfaced on add/remove/reorder/
  replace; optional `snapshot_id` input targets a specific version on removal; per-URI
  `positions[]` removes a single occurrence of duplicated tracks
  ([#50](https://github.com/NovaLux12/spotify-mcp-server/issues/50)).
- Search: `audiobook` type added (US/UK/CA/IE/NZ/AU markets)
  ([#44](https://github.com/NovaLux12/spotify-mcp-server/issues/44)), `offset`
  param and limit cap raised to the API maximum of 50
  ([#45](https://github.com/NovaLux12/spotify-mcp-server/issues/45)),
  `include_external=audio` passthrough ([#46](https://github.com/NovaLux12/spotify-mcp-server/issues/46)).
- Parameter completeness: `market` + `offset` on artist-albums, `market` on album
  and album-tracks lookups, `offset` on top tracks/artists
  ([#47](https://github.com/NovaLux12/spotify-mcp-server/issues/47));
  `market` and `additional_types` exposed on now-playing/currently-playing reads
  ([#48](https://github.com/NovaLux12/spotify-mcp-server/issues/48)).

### Added — MCP experience (#51–#62, #63–#65)

- Shared `response_format` option (`concise` | `detailed` | `json`) on every tool;
  `json` returns the raw API object, `detailed` surfaces fields the prose drops
  (popularity, release dates, restrictions, publishers…)
  ([#51](https://github.com/NovaLux12/spotify-mcp-server/issues/51)).
- Machine-readable `structuredContent` with pagination info (`total`,
  `next_offset`) on all list-type outputs
  ([#52](https://github.com/NovaLux12/spotify-mcp-server/issues/52)).
- Truncation controls: shared `max_results` param with an `SPOTIFY_MCP_MAX_ITEMS`
  env default and a "(N more — pass offset or fetch_all)" footer
  ([#53](https://github.com/NovaLux12/spotify-mcp-server/issues/53)).
- Cross-request TTL cache (~5 min LRU) for immutable catalog reads, bypassed for
  player/top/recently-played/mutations — fewer 429s in agentic loops
  ([#54](https://github.com/NovaLux12/spotify-mcp-server/issues/54)).
- Fetch-all cap configurable via `SPOTIFY_MCP_FETCH_ALL_CAP` instead of hardcoded
  500 ([#55](https://github.com/NovaLux12/spotify-mcp-server/issues/55)).
- Rate-limit visibility: post-throttle status lines, enriched errors carrying
  `retryAfterSec` after retry exhaustion, and a `spotify://me/rate-limit` resource
  ([#56](https://github.com/NovaLux12/spotify-mcp-server/issues/56)).
- `dry_run` mode on destructive operations (removals, unfollows, playback overwrites):
  validates inputs and previews exactly what would change with zero mutating calls
  ([#57](https://github.com/NovaLux12/spotify-mcp-server/issues/57)).
- Confirmation-friendly batch summaries on mutations ("N items affected: uri0,
  uri1…") ([#58](https://github.com/NovaLux12/spotify-mcp-server/issues/58)).
- Resources: saved albums/shows/episodes, templated paginated
  `spotify://playlist/{id}/tracks`, and `?format=json` variants for programmatic
  consumers ([#59](https://github.com/NovaLux12/spotify-mcp-server/issues/59)).
- Prompts: five new (`playlist_audit`, `listening_recap`, `migrate_library`,
  `podcast_catchup`, `artist_deep_dive`) referencing real tool names; existing
  prompts parameterized with optional `time_range`/`size` args
  ([#60](https://github.com/NovaLux12/spotify-mcp-server/issues/60)).
- Consolidated `SPOTIFY_MCP_*` config family documented in README +
  docs/configuration.md + fresh `.env.example`
  ([#61](https://github.com/NovaLux12/spotify-mcp-server/issues/61)).
- `spotify-mcp doctor` subcommand: resolved config, token expiry/state, live
  authenticated `/me` probe ([#62](https://github.com/NovaLux12/spotify-mcp-server/issues/62)).
- Duplicate-aware playlists: `find_duplicates_in_playlist` (exact-URI and relinked
  name+artist grouping with positions) and opt-in `check_duplicates` pre-check on
  `add_to_playlist` ([#63](https://github.com/NovaLux12/spotify-mcp-server/issues/63)).
- Opt-in session history JSONL under `~/.spotify-mcp/history` recording
  who/what/snapshot_id for mutations (strict field whitelist, never tokens);
  enabled via `SPOTIFY_MCP_HISTORY` ([#64](https://github.com/NovaLux12/spotify-mcp-server/issues/64)).
- MCP progress notifications emitted per page during multi-page walks so hosts no
  longer show long fetches as hung ([#65](https://github.com/NovaLux12/spotify-mcp-server/issues/65)).

### Fixed

- Shows library saves/removes sent IDs as a JSON body where `/me/shows` requires
  `?ids=` query params — writes silently no-op'd (#12).
- Rejected token-load promise cached forever, pinning "Not authenticated" after
  successful re-auth until restart (#13).
- Callback server ignored the port in `SPOTIFY_REDIRECT_URI` and always bound 8888 (#14).
- `get_recently_played` crashed on null track entries (#15); search formatter
  crashed on null items[] rows (#16).
- Pagination: `fetch_all` restarted near offset 0 when resuming mid-list (#17);
  `getAllPages` truncated to one page when responses omitted `total` (#22);
  offset-resume math made absolute by the #67 refactor onto `getAllPages`.
- `spotify://player/state` resource crashed on non-track/non-episode items such as
  ads (#18); `spotify://me/playlists` claimed all playlists but returned one page —
  now fully paginated (#27).
- Garbage `Retry-After` headers produced NaN, permanently disabling backoff —
  parsed defensively with sane fallback (#20).
- `client.get()` threw a raw SyntaxError on non-JSON 200 bodies — now throws a
  descriptive `SpotifyApiError`, consistent with `post()` (#21).
- `play` accepted >100 uris and empty-uris bypassed the context mutual-exclusion
  check (#23); numeric offset validated against artist contexts (#24).
- `remove_from_playlist` rejected at the schema level above the API's 100-URI cap (#25).
- `public=true` + `collaborative=true` combination rejected up front (#26).
- `play_from_search` forwarded no market and could play null rows — market passed
  through, nulls skipped (#28).
- Audiobook/chapter/show/episode lookups gained market fallback for market-gated
  accounts (#29).
- Code hygiene: unreachable not-found guards removed or made ID-bearing, dead
  deprecated-endpoint types deleted, catalog errors preserve status + Spotify's own
  message instead of generic replacements (#30).
- `check_saved_items` cap raised from 40 to the API maximum of 50 (#66).

## [1.0.3] — 2026-08-24

Package health + README accuracy (`f9d06a5`).

### Added

- `publishConfig.access: "public"` declared explicitly for the scoped npm package.
- `engines` field pinning Node `>=22.9`.

### Fixed

- README library section corrected: save/remove/check operations are partitioned
  by type to `/me/tracks|albums|shows|episodes(/contains)` rather than the unified
  `/me/library` endpoints.

## [1.0.2] — 2026-08-24

Ten confirmed bug fixes from issue triage (#1–#10) (`8350cfd`, fix commit `1d10d11`). Test suite updated to assert corrected contracts.

### Fixed

- Null guards: `Array.isArray` check on `artist.genres` in catalog/resources tools (#1, #8).
- `post()` client method handles non-JSON `200` responses — `/me/player/queue` returns text/plain (#2).
- MCP server version read from `package.json` instead of hardcoded `1.0.0` (#3).
- `publisher ?? 'unknown publisher'` fallbacks in library/search/catalog output (#4).
- Library save/remove/check partitioned by URI type to `/me/tracks|albums|shows|episodes(/contains)` instead of the non-existent-per-type `/me/library` usage (#5).
- `check_following_artists` corrected to `/me/following/contains?type=artist&ids=…` instead of `/me/library/contains` (#6).
- `ugc-image-upload` scope added so playlist cover upload works (#7).
- Null-device guard for `get_now_playing` tool and `spotify://player/state` resource when no device is active (#8).
- `play` rejects `context_uri` combined with `uris` up front instead of surfacing an API 400 (#9).
- `fetch_all` pagination forces `limit=50` instead of the API default of 20, roughly 2.5× fewer requests per full fetch (#10).

## [1.0.1] — 2026-08-23

CLI ergonomics (`3a26ea7`).

### Added

- `--help` / `-h` flag printing usage, subcommands, and environment variables.
- `--version` / `-v` flag printing the installed version from `package.json`.

## [1.0.0] — 2026-08-23

Initial scoped-npm publication as `@novalux12/spotify-mcp` (`bcffd3f`; launch-prep commit `f5dcf1d`, tagged `v1.0.0`).

### Added

- Package renamed/published to the `@novalux12/spotify-mcp` scope; docs switched from the stale npx name.
- Live E2E harness (`scripts/live-e2e.mjs`): real-account MCP-over-stdio verification against live Spotify.
- `skills/spotify-mcp-doctor`: procedural troubleshooting skill for agents.
- README: Command for AI agents, OpenClaw config how-to, npx staleness note.
- `package.json`: honest description, NovaLux12 repository URL, `--env-file-if-exists` (fresh-clone safe); docs aligned to Node 22.9+.
- Premium requirement, pagination cap, and audiobook market gating disclosed in docs (`8636d2f`).
- Rebrand as NovaLux12/spotify-mcp-server with MIT license and acknowledgements (`e9c3567`).

[Unreleased]: https://github.com/NovaLux12/spotify-mcp-server/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/NovaLux12/spotify-mcp-server/compare/v1.0.3...v1.1.0
[1.0.3]: https://github.com/NovaLux12/spotify-mcp-server/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/NovaLux12/spotify-mcp-server/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/NovaLux12/spotify-mcp-server/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/NovaLux12/spotify-mcp-server/releases/tag/v1.0.0
