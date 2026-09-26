# Contributing to SpotifyMCP

Thanks for your interest in improving SpotifyMCP! This document covers everything you need to get a development environment running and land a PR.

## Development setup

Requirements: **Node.js >= 22.9** (the dev scripts rely on `--env-file-if-exists`, added in Node 22.9).
Toolchain: **TypeScript 7** / `@types/node` 26 (via `npm ci`; `tsc` must pass — see CI).

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
- **Tool surface growth is budgeted.** Registration order, per-module schema baselines, and ceilings are defined by the shared manifest in `src/tools/annotations.ts`; see [schema budgets](docs/schema-budgets.md). Do not raise a ceiling without updating its measured baseline and documenting the host-payload impact in that page or the PR rationale.
- Keep PRs focused: one logical change per PR. Update the PR template checklist before submitting.

## Releasing

Releases are cut from `main` by release-please. The release PR is the
version-bump and changelog change; do not edit `CHANGELOG.md` or
`package.json` by hand to create a release.

### 1. Prepare and merge the release PR

1. Merge the tested changes to `main` using Conventional Commit titles. A
   `feat:` merge produces a minor release, while `fix:` and other patch-level
   changes produce a patch release.
2. Wait for the **Release Please** workflow to open its
   `chore(main): release X.Y.Z` pull request. Review the generated version in
   `package.json`, `.github/release-please-manifest.json`, and `server.json`,
   plus the new `CHANGELOG.md` section. The configured changelog sections are
   Features, Bug Fixes, Performance Improvements, Dependencies, Reverts,
   Documentation, Tests, Code Refactoring, Styles, Miscellaneous Chores, and
   Continuous Integration.
3. Merge the release PR only after the normal `CI` check is green. Release
   Please then creates the `vX.Y.Z` tag and GitHub release.

```bash
RELEASE_PR="$(gh pr list --state open --search 'chore(main): release' \
  --json number --jq '.[0].number')"
test -n "$RELEASE_PR"
VERSION="$(gh pr view "$RELEASE_PR" --json title \
  --jq '.title | split("release ")[1]')"
TAG="v${VERSION}"

gh pr view "$RELEASE_PR"
gh pr merge "$RELEASE_PR" --merge
gh release view "$TAG" --json tagName,isDraft,isPrerelease,url
```

`gh release view` should show the requested tag and a published (not draft)
release. If release-please did not open a PR, inspect the **Release Please**
run on the latest `main` push before creating a tag manually.

### 2. Publish the tag

`release.yml` creates the tag, and **that tag push starts `publish.yml`** — the
`publish-npm` job runs on its own. Do not dispatch it manually.

This section previously instructed a manual
`gh workflow run publish.yml --ref "$TAG"` on the grounds that a
`GITHUB_TOKEN`-created tag does not trigger a workflow. **That is wrong for
this repo.** The manual dispatch races the tag-push run, and npm versions are
immutable, so the second attempt fails on a version that already exists. It
caused a double publish on 2026-09-25.

To watch the run the tag started:

```bash
RUN_ID="$(gh run list --workflow publish.yml --limit 20 \
  --json databaseId,headBranch,status,conclusion,url \
  --jq "map(select(.headBranch == \"${TAG}\")) | .[0].databaseId")"
test -n "$RUN_ID"
gh run watch "$RUN_ID" --exit-status
```

**If `publish-mcp-registry` fails with `version 'X.Y.Z' was not found`, that is
an npm propagation race, not a broken artifact.** npm takes minutes to serve a
newly published version, and the registry job validates that npm actually has
it. Recover with a failed-jobs-only re-run, which does not re-attempt the
immutable npm publish:

```bash
gh run rerun "$RUN_ID" --failed
```

**Do not trust a local `npm view` to verify a release.** During 2.1.0 it served
a stale `dist-tags.latest` and a 404 for a version that was already published.
Query the registry directly, cache-busted:

```bash
curl -sS "https://registry.npmjs.org/@novalux12%2Fspotify-mcp?cb=$(date +%s)" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["dist-tags"])'
```

Also beware: a green **PR Labeler** check on the same SHA is not a passing
suite. `pull_request_target` runs the Labeler, which typechecks nothing and runs
no tests, while `pull_request` runs CI. A per-commit "one failure, one success"
pairing is the two workflows, not a flaky test.

The `Publish` workflow checks out the tagged commit, runs `npm ci`,
`npx tsc --noEmit`, `npm test`, and `npm run build`, publishes
`@novalux12/spotify-mcp` with provenance (trusted publishing/OIDC or the
configured `NPM_TOKEN` fallback), and then publishes `server.json` to the
official MCP Registry using GitHub OIDC. A rerun is safe after a partial
failure: the npm job skips a version that is already present and the registry
job can be retried.


### 3. Verify the published artifacts

```bash
git fetch --tags origin

# npm: output must be the exact tag version (without the leading v).
npm view "@novalux12/spotify-mcp@${VERSION}" version --json

# The tagged metadata must have the same version in both locations.
git show "${TAG}:server.json" | jq -e \
  --arg version "$VERSION" \
  '.version == $version and .packages[0].version == $version'

# The latest Registry response must be this version and marked latest.
curl --fail --silent --show-error \
  "https://registry.modelcontextprotocol.io/v0/servers/io.github.NovaLux12%2Fspotify-mcp-server/versions/latest" \
  | jq -e --arg version "$VERSION" \
      '.server.version == $version
       and ._meta["io.modelcontextprotocol.registry/official"].isLatest == true'
```

Expected results are the exact version (for example, `1.30.1`), `true` for
the `server.json` check, and `true` for the Registry check. Also inspect the
workflow URL printed by `gh run view "$RUN_ID"` if any verification fails.

Only `…/versions/latest` is authoritative, and the other two endpoints look
like verification while reporting the opposite of the truth:

| Query | What it actually reports |
|---|---|
| `…/versions/latest` | the published version — **authoritative** |
| `/v0/servers?search=…` | a stale index version, many releases behind |
| `…/versions` | an empty array, even for a server that is published |

A stale `?search=` result is the expensive one: it looks like the project
stopped shipping, and it invites re-publishing a version that is already out.
Before concluding a publish failed, check npm — if
`@novalux12/spotify-mcp@$VERSION` resolves, the release shipped and what you
are looking at is registry-side indexing. Do not re-publish on the strength of
a search or list result.

### Rollback and recovery

- **Before the tag:** do not merge the release PR. Correct the Conventional
  Commit or release input on `main`; release-please will prepare a new release
  PR. Never manufacture a tag to bypass release-please.
- **After the tag but before/during publishing:** keep the tag, fix the
  workflow or release metadata on `main`, merge that fix, and rerun the
  publish workflow for the same tag with `gh run rerun "$RUN_ID" --failed`.
  The workflow's version check makes the npm step idempotent. Then repeat all
  three artifact checks above.
- **A published version is immutable:** do not retag or try to overwrite the
  same npm version. If the artifact is unsafe, deprecate the npm version with
  `npm deprecate "@novalux12/spotify-mcp@${VERSION}" "Please upgrade to a fixed release"`,
  mark the MCP Registry version `deprecated` through the registry's normal
  status-management path, and cut a new patch release containing the fix.
- **A failed check after publication:** record the failed check and its run
  URL, recover the service with a patch release, and retain the original tag
  and changelog for traceability.

## Filing issues

Please use the issue templates:

- **Bug report** — include the affected tool name, repro steps, expected vs actual behavior, the MCP client you used, and any logs.
- **Feature request** — describe the problem you're solving and the proposed Spotify endpoint/behavior.

## Code of conduct

By participating you agree to abide by the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
