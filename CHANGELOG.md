# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note:** Going forward, releases are cut via [release-please](https://github.com/googleapis/release-please)
> from [Conventional Commits](https://www.conventionalcommits.org/). Entries below v1.0.4 were
> backfilled by hand from git history.

## [1.15.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.14.0...v1.15.0) (2026-08-26)


### Features

* **#112 idea 11 completion:** wire mutation receipts into the unified library tools ([6966773](https://github.com/NovaLux12/spotify-mcp-server/commit/696677349aa841c83694a17606c9e855ea1e30f6))

## [1.14.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.13.0...v1.14.0) (2026-08-26)


### Features

* **#110 finding 11:** harmonize check-tool output shapes ([9fae097](https://github.com/NovaLux12/spotify-mcp-server/commit/9fae0973f2d92969017fc08539d3ae433af723e1))


### Bug Fixes

* drop semantically-wrong saved alias from check_following_artists rows ([6d64784](https://github.com/NovaLux12/spotify-mcp-server/commit/6d6478419f90edcef1718f3f6e40a81e65a52c53))
* restore the check_in_library tool-name line consumed by the description edit ([b43b0ce](https://github.com/NovaLux12/spotify-mcp-server/commit/b43b0ce07351932ba48895a6e0791e58cb34f4b6))

## [1.13.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.12.0...v1.13.0) (2026-08-26)


### Features

* elicitation-gated confirmation for destructive playlist ops ([#111](https://github.com/NovaLux12/spotify-mcp-server/issues/111) item 5) ([5abafb7](https://github.com/NovaLux12/spotify-mcp-server/commit/5abafb75a8ec1b3d37a196e5616f7b3b26d8a695))

## [1.12.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.11.0...v1.12.0) (2026-08-26)


### Features

* **#111:** SPOTIFY_MCP_READONLY mode — write-capable modules hidden on demand ([0a73e15](https://github.com/NovaLux12/spotify-mcp-server/commit/0a73e15f94cc63ab015869cc90a4631167987975))

## [1.11.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.10.0...v1.11.0) (2026-08-26)


### Features

* **#133:** waiter aging — LOW tasks promoted after 15s to prevent walk starvation ([41a2b81](https://github.com/NovaLux12/spotify-mcp-server/commit/41a2b81cb1545517b78ced2d0a5914be7c6f1d00))

## [1.10.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.9.0...v1.10.0) (2026-08-26)


### Features

* **#133:** two-lane request scheduler — interactive reads drain before bulk walks ([301517e](https://github.com/NovaLux12/spotify-mcp-server/commit/301517eeea752876b5402af5b6ce1f0ecd05005a))

## [1.9.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.8.0...v1.9.0) (2026-08-26)


### Features

* **auth:** persist auth-time scopes; add scopefilter for scope-aware module hiding ([#111](https://github.com/NovaLux12/spotify-mcp-server/issues/111) item 6) ([9da8bfa](https://github.com/NovaLux12/spotify-mcp-server/commit/9da8bfa74ea5602065b996eb8156fa5aa13463b5))
* **toolsets:** per-tool opt-in/opt-out layered on toolsets ([#111](https://github.com/NovaLux12/spotify-mcp-server/issues/111) item 7) ([42d97b6](https://github.com/NovaLux12/spotify-mcp-server/commit/42d97b6ae488a0fa2c1f457ce73e7525c205b30b))
* wire wave-9 — scope-aware hiding + per-tool opt-in/opt-out ([9de646f](https://github.com/NovaLux12/spotify-mcp-server/commit/9de646f2f77d82a96ae9043b0b22ee33d177a479))


### Bug Fixes

* **#110:** final polish — audit prompt uses find_duplicates; honest queue pagination ([0a931f1](https://github.com/NovaLux12/spotify-mcp-server/commit/0a931f1751dc2664f302cb5467e9b48e3b520dca))

## [1.8.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.7.0...v1.8.0) (2026-08-26)


### Features

* **doctor:** spotify_doctor diagnostic tool ([#111](https://github.com/NovaLux12/spotify-mcp-server/issues/111) idea 9) ([310ccb1](https://github.com/NovaLux12/spotify-mcp-server/commit/310ccb1b52cd06f5b68af77308a4b9211ad04584))
* **tools:** add library_hygiene — album completion & consolidation analysis ([#112](https://github.com/NovaLux12/spotify-mcp-server/issues/112) idea 5) ([ddbcb59](https://github.com/NovaLux12/spotify-mcp-server/commit/ddbcb59585a840a9a80ce66bbd60bad3f45095d8))
* wire wave-8 — library hygiene, spotify_doctor tool, ergonomics batch ([09ddffc](https://github.com/NovaLux12/spotify-mcp-server/commit/09ddffcd4b02b23c8c30e9a92311cbb21cccedfa))


### Bug Fixes

* **#110:** normalize market params, disambiguate now-playing tools, typed additional_types, cursor hint, split play offset errors ([158ab5c](https://github.com/NovaLux12/spotify-mcp-server/commit/158ab5c21efd94740f2f9ed9e3b30972df484d89))

## [1.7.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.6.0...v1.7.0) (2026-08-26)


### Features

* **analytics:** listening_report tool ([#97](https://github.com/NovaLux12/spotify-mcp-server/issues/97)) ([0acf487](https://github.com/NovaLux12/spotify-mcp-server/commit/0acf4876a91d0ad406cf2b2481605c4654a2f60f))
* integrate wave-7 — listening analytics + auth hardening; repair lost wiring ([7b9cacc](https://github.com/NovaLux12/spotify-mcp-server/commit/7b9caccb16ffdbb43c173b496a983d976ed54148))


### Bug Fixes

* **auth:** atomic token persistence, refresh race guard, failure classification ([#109](https://github.com/NovaLux12/spotify-mcp-server/issues/109)) ([1c31e84](https://github.com/NovaLux12/spotify-mcp-server/commit/1c31e8476494a17df8e9d1facce8e576f200f38a))

## [1.6.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.5.0...v1.6.0) (2026-08-25)


### Features

* **prompts:** add triage_liked_songs prompt ([#112](https://github.com/NovaLux12/spotify-mcp-server/issues/112) idea 8) ([c26e7a9](https://github.com/NovaLux12/spotify-mcp-server/commit/c26e7a94c3a47c75341d0eb04b25b5967c6599bc))


### Bug Fixes

* **#110:** structuredContent contract breaks + explicit fetch_all semantics ([b31ca33](https://github.com/NovaLux12/spotify-mcp-server/commit/b31ca33af5d75d56f22e1f4497de5d9b4dbd57a2))

## [1.5.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.4.0...v1.5.0) (2026-08-25)


### Features

* **#111:** argument completions for show/episode resource templates ([90b0197](https://github.com/NovaLux12/spotify-mcp-server/commit/90b0197bffd109df679ca9f47c6d2e512b7d1ac5))
* **receipts:** mutation receipts with post-mutation verification ([#112](https://github.com/NovaLux12/spotify-mcp-server/issues/112) idea 11) ([1bd6e5c](https://github.com/NovaLux12/spotify-mcp-server/commit/1bd6e5cdc2cb5105f8ba182cf5dc46a9242fc2eb))
* **tools:** grow_playlist — Playlist DNA co-occurrence curation ([#112](https://github.com/NovaLux12/spotify-mcp-server/issues/112) idea 6) ([d1677a7](https://github.com/NovaLux12/spotify-mcp-server/commit/d1677a7b12880b0c940b0ad985522fac88bb70e5))


### Bug Fixes

* **#110:** standardise playlist-ID params on playlist_id with id alias ([4b92dec](https://github.com/NovaLux12/spotify-mcp-server/commit/4b92dec286143cd7c25b74746cb268d0ff5d07dc))

## [1.4.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.3.0...v1.4.0) (2026-08-25)


### Features

* **#110:** dry_run coverage for all mutating playlist tools ([edd3515](https://github.com/NovaLux12/spotify-mcp-server/commit/edd3515d59928ac89b7c63e20b1cb374c5eb171d))
* **podcast:** podcast session composer tools ([#112](https://github.com/NovaLux12/spotify-mcp-server/issues/112) idea 3) ([609f6ec](https://github.com/NovaLux12/spotify-mcp-server/commit/609f6ec116df8be0a9d9f18265cf91f1b5f06df2))
* **resources:** RFC-6570 resource templates over single-get catalog endpoints ([a4ccf46](https://github.com/NovaLux12/spotify-mcp-server/commit/a4ccf46d676ebf2c7216ee9c2167030b01cd0f2f))
* **scenes:** named playback scenes + in-process wind-down fade ([#112](https://github.com/NovaLux12/spotify-mcp-server/issues/112) ideas 7+12) ([12ebd99](https://github.com/NovaLux12/spotify-mcp-server/commit/12ebd994bb45474b203d6b6c46ac0878b67b7f1a))
* **tools:** audiobook chapter copilot ([#112](https://github.com/NovaLux12/spotify-mcp-server/issues/112) idea 4) ([e7e88ac](https://github.com/NovaLux12/spotify-mcp-server/commit/e7e88ac06116b928d79c5fe97d50efb8988754a9))
* wire wave-4 modules into server startup ([ce8d0e4](https://github.com/NovaLux12/spotify-mcp-server/commit/ce8d0e488c4a22780828ddda18170aa78a58ee25))

## [1.3.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.2.1...v1.3.0) (2026-08-25)


### Features

* **#112:** handoff tool — lossless device move preserving track position ([1c6bc57](https://github.com/NovaLux12/spotify-mcp-server/commit/1c6bc574196d7c96186f36f3e254784d5b551717))
* **#95:** add TOOLSETS registry with resolveToolsets/isActive/toolsetEnvHelp ([6efdf0e](https://github.com/NovaLux12/spotify-mcp-server/commit/6efdf0e921a1cbe5b6235d381e1d5a5bbda00600))
* **#95:** wire SPOTIFY_MCP_TOOLSETS into server startup ([df02eaa](https://github.com/NovaLux12/spotify-mcp-server/commit/df02eaac5c00e21490dbbb5b6fdc403c014ce669))
* codify live gauntlet — full-tool live sweep with mutation proof ([f384cf9](https://github.com/NovaLux12/spotify-mcp-server/commit/f384cf985dbf18b56169777c0ed7dde07eba1c5d))
* **library-insights:** sidecar genre tags + library report/filter tools ([#112](https://github.com/NovaLux12/spotify-mcp-server/issues/112) idea 1) ([bfab550](https://github.com/NovaLux12/spotify-mcp-server/commit/bfab5505429c93df247be484fe2a8a39f7e0fe9d))
* **search:** add search_deep paged search tool ([128dcef](https://github.com/NovaLux12/spotify-mcp-server/commit/128dcef3c3318e39943a1621c8cc35bc91352405))
* **tools:** add merge_playlists, diff_playlists, overlap_playlists ([#96](https://github.com/NovaLux12/spotify-mcp-server/issues/96)) ([d551bfd](https://github.com/NovaLux12/spotify-mcp-server/commit/d551bfdd91d191bd5c402be3a8a22bf3ec1e3ced))
* whats_new freshness radar tool ([#112](https://github.com/NovaLux12/spotify-mcp-server/issues/112) idea 2) ([84b3643](https://github.com/NovaLux12/spotify-mcp-server/commit/84b364310cc0d5a56138f1d335395035bd4609a1))


### Bug Fixes

* **#108:** differentiate QUOTA_EXCEEDED from burst 429s; cap in-queue sleep ([9d8865f](https://github.com/NovaLux12/spotify-mcp-server/commit/9d8865f544827fcc8ec709d2a73b720043ff6bfe))
* **#95:** use Object.hasOwn for known-set lookup; add prototype-name test ([4c9b7b2](https://github.com/NovaLux12/spotify-mcp-server/commit/4c9b7b26b9dadf5033036c5e8347e774a67ea4e0))
* **#96:** adopt Feb-2026 playlist item shape ('item'); wire into playlists toolset ([8859967](https://github.com/NovaLux12/spotify-mcp-server/commit/885996724b972bee01f8bb54c80f1e1f25ff52ce))
* **ci:** pin @modelcontextprotocol/sdk; idempotent npm publish ([68e8a2a](https://github.com/NovaLux12/spotify-mcp-server/commit/68e8a2a88a6342437d1e83fa8e8b04d455137069))
* **platform:** artist-albums limit hard-capped at 10 (Feb 2026) ([ced75fa](https://github.com/NovaLux12/spotify-mcp-server/commit/ced75fadd55b31b4157aeff67b8b12ea14ec026c))
* **platform:** playlist items nest under 'item', not 'track' (Feb 2026) ([675e400](https://github.com/NovaLux12/spotify-mcp-server/commit/675e400ed2fd11f4cb1085b570bb598a4861eed8))
* **security:** supply-chain + file-permission hardening (SecReview findings) ([9342533](https://github.com/NovaLux12/spotify-mcp-server/commit/9342533bba3d85117fd62cc5a29686764949b3b2))

## [1.2.1](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.2.0...v1.2.1) (2026-08-25)


### Bug Fixes

* **registry:** correct MCP Registry namespace casing; add mcpName linkage ([7515eab](https://github.com/NovaLux12/spotify-mcp-server/commit/7515eab51378414779f4bdf493ffd8f04e90f27b))

## [1.2.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.1.1...v1.2.0) (2026-08-25)


### Features

* **distribution:** MCP Registry publishing, Smithery manifest, npm release wiring ([7cc7b79](https://github.com/NovaLux12/spotify-mcp-server/commit/7cc7b79c8edd49620c0a70c14cd2489c30fd1476))


### Bug Fixes

* **platform:** align with Spotify's February 2026 Web API changes ([6b66d35](https://github.com/NovaLux12/spotify-mcp-server/commit/6b66d35ffa978ebf14f2eb3d4a66a68217f000b9))
* **tools:** dry_run previews for create/save tools; id alias for playlist reads ([32b1c2d](https://github.com/NovaLux12/spotify-mcp-server/commit/32b1c2d2acef42468408736a9d71c4ef93002c3d))

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

[Unreleased]: https://github.com/NovaLux12/spotify-mcp-server/compare/v1.2.1...HEAD
[1.1.0]: https://github.com/NovaLux12/spotify-mcp-server/compare/v1.0.3...v1.1.0
[1.0.3]: https://github.com/NovaLux12/spotify-mcp-server/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/NovaLux12/spotify-mcp-server/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/NovaLux12/spotify-mcp-server/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/NovaLux12/spotify-mcp-server/releases/tag/v1.0.0
