# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note:** Going forward, releases are cut via [release-please](https://github.com/googleapis/release-please)
> from [Conventional Commits](https://www.conventionalcommits.org/). Entries below v1.0.4 were
> backfilled by hand from git history.

## [1.1.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.0.3...v1.1.0) (2026-08-25)


### Features

* best-in-class MCP experience ([#51](https://github.com/NovaLux12/spotify-mcp-server/issues/51)-[#62](https://github.com/NovaLux12/spotify-mcp-server/issues/62), [#63](https://github.com/NovaLux12/spotify-mcp-server/issues/63)-[#65](https://github.com/NovaLux12/spotify-mcp-server/issues/65)) ([b5bea4a](https://github.com/NovaLux12/spotify-mcp-server/commit/b5bea4a554a12b34b33129d1e84d59d499c5c057))
* endpoint parity — wrap remaining live Web API surface ([#34](https://github.com/NovaLux12/spotify-mcp-server/issues/34)-[#50](https://github.com/NovaLux12/spotify-mcp-server/issues/50), [#67](https://github.com/NovaLux12/spotify-mcp-server/issues/67)) ([d08daab](https://github.com/NovaLux12/spotify-mcp-server/commit/d08daab548afea4689b5e6f84c2a8d8dcc309538))


### Bug Fixes

* **prompts:** advertise optional args without relying on zod .default() required-flag semantics ([a26674d](https://github.com/NovaLux12/spotify-mcp-server/commit/a26674d320c3de3ce0bdf2b08683d7aa9624d58b))
* v1.0.4 bug+security batch ([#11](https://github.com/NovaLux12/spotify-mcp-server/issues/11)-[#30](https://github.com/NovaLux12/spotify-mcp-server/issues/30), [#66](https://github.com/NovaLux12/spotify-mcp-server/issues/66)) ([1d420d0](https://github.com/NovaLux12/spotify-mcp-server/commit/1d420d0f28630c3000e98ad24d451df7f7e1477b))

## [Unreleased]

Full audit of the server completed on 2026-08-25. Findings are filed as GitHub issues under three epics:

- **[#31 — Feature parity](https://github.com/NovaLux12/spotify-mcp-server/issues/31):** wrap every remaining live Spotify Web API endpoint.
- **[#32 — Best-in-class MCP experience](https://github.com/NovaLux12/spotify-mcp-server/issues/32):** caching, response shaping, safety, resources, and prompts.
- **[#33 — Bug + security batch](https://github.com/NovaLux12/spotify-mcp-server/issues/33):** confirmed bug fixes and hardening from the security audit.

Repository polish batch also in progress: CI workflow, community health files, and architecture documentation.

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

[Unreleased]: https://github.com/NovaLux12/spotify-mcp-server/compare/v1.0.3...HEAD
[1.0.3]: https://github.com/NovaLux12/spotify-mcp-server/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/NovaLux12/spotify-mcp-server/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/NovaLux12/spotify-mcp-server/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/NovaLux12/spotify-mcp-server/releases/tag/v1.0.0
