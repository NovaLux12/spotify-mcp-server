# Contributing to SpotifyMCP

Thanks for your interest in improving SpotifyMCP! This document covers everything you need to get a development environment running and land a PR.

## Development setup

Requirements: **Node.js >= 22.9** (the dev scripts rely on `--env-file-if-exists`, added in Node 22.9).

```bash
git clone https://github.com/NovaLux12/spotify-mcp-server.git
cd spotify-mcp-server
npm ci          # reproducible install from the lockfile
npm run build   # tsc, then adds the shebang to dist/index.js
npm test        # node:test runner via tsx — unit tests for the client and every tool module, plus an MCP protocol smoke test
```

### Environment variables and authentication

No `.env` file is required — env vars can come from your host config or the command line. To use one:

1. Copy `.env.example` to `.env`.
2. Fill in `SPOTIFY_CLIENT_ID` (a PKCE flow is used, so **only the Client ID is needed** — there is no client secret). The default redirect URI is `http://127.0.0.1:8888/callback`; add exactly that URI in your [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) app settings.
3. Run the PKCE walkthrough:

```bash
npm run auth    # opens a browser, completes Authorization Code + PKCE, stores tokens at ~/.spotify-mcp/tokens.json
```

For browserless hosts, see the headless (`SPOTIFY_HEADLESS=1`) instructions in the [README](README.md#2-authenticate).

Tokens are stored mode-600 at `~/.spotify-mcp/tokens.json` and refreshed automatically. Never commit tokens or `.env`.

## Scope policy: non-deprecated endpoints only

This server deliberately wraps **only Spotify Web API endpoints that are available to standard developer apps**. Do not add tools for deprecated/removed endpoints; they fail at runtime for new apps. The blocked set:

- Recommendations
- Related artists
- Audio features / audio analysis
- Genre seeds (recommendation seeds)
- Featured playlists
- Browse categories
- New releases
- Lyrics

When adding a tool, verify the endpoint against the official [Spotify Web API reference](https://developer.spotify.com/documentation/web-api/reference) rather than guessing paths or field names. Prefer the current unified endpoints (e.g. `/playlists/{id}/items`, `/me/library`) over their deprecated predecessors.

## Commit messages: Conventional Commits

All commits must follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): description`. Examples:

```
feat(playback): add seek tool with position_ms validation
fix(library): guard null items in saved-tracks pagination
docs(readme): correct audiobook market list
test(client): cover 429 Retry-After handling
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `ci`.

## Pull request expectations

- **Behavior changes need tests.** Add or update tests under `tests/` covering the new or fixed behavior; `npm test` should pass.
- **Tool contract changes need SPEC.md updates.** If you change what a tool accepts or returns (inputs, outputs, endpoint mapping, pagination behavior), update the matching section of [SPEC.md](SPEC.md).
- **Changelog is automated.** Release notes/version bumps are handled by release automation from Conventional Commit messages — do not edit CHANGELOG entries manually.
- Keep PRs focused: one logical change per PR. Update the PR template checklist before submitting.

## Filing issues

Please use the issue templates:

- **Bug report** — include the affected tool name, repro steps, expected vs actual behavior, the MCP client you used, and any logs.
- **Feature request** — describe the problem you're solving and the proposed Spotify endpoint/behavior.

## Code of conduct

By participating you agree to abide by the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
