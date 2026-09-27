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

## Scope policy: no new wrappers for removed or gated endpoints

Spotify's [February 2026 changelog](https://developer.spotify.com/documentation/web-api/references/changes/february-2026) removed a batch of operations, and a further set is denied at the app-registration level. Neither is a reason to break a caller, so the surface splits into two classes. Know which one you are adding.

**No shipped tool calls these paths.** Do not add one:

- `/recommendations` and `/recommendations/available-genre-seeds`
- `/artists/{id}/related-artists`
- `/audio-features/{id}` and `/audio-analysis/{id}`
- `/browse/featured-playlists`
- `/me/apps`, `/me/chapters`
- The `/playlists/{id}/tracks` family — use `/playlists/{id}/items`

These are absent from the registry because absence is the honest answer: there is no request to make and no 403 to explain.

**A tool calls it and explains the 403.** `GATED_FAMILIES` in [`src/gating.ts`](src/gating.ts) is the authoritative list — `/browse/categories*`, `/markets`, `/artists/{id}/top-tracks`, `/users/{id}` profile reads, the per-type `/me/{type}/contains` checks, `/playlists/{id}/followers/contains`, and the `Get Several` batch paths. Their wrappers stay registered, read a documented replacement where one exists, and return a plain-English explanation rather than crashing. The census's `checkGatedEndpointTruth` holds the classifier and the docs to that array, and the README table is generated from it.

Two families in the array — `browse-new-releases` and `playlist-followers-contains` — have no live call site left, because the tools that used them moved to replacements. Their patterns are retained so a future caller stays covered by the 403 contract rather than silently losing it. An entry in the array is a runtime classifier, not a claim that a tool calls it.

So "removed" and "gated" are different answers with different code shapes. Check which class an endpoint is in before writing a handler, and check it in the source of truth rather than from memory: the OpenAPI schema still publishes many removed paths as `deprecated: true`, so the schema alone will not tell you, and neither will the changelog alone.

When adding a tool, verify the endpoint against the official [Spotify Web API reference](https://developer.spotify.com/documentation/web-api/reference) rather than guessing paths or field names — a wrong query parameter name is a 400, not a doc nit. Prefer the current unified endpoints (e.g. `/playlists/{id}/items`, `/me/library`) over their deprecated predecessors. Note that `GET /search` accepts a `limit` of at most 10, defaulting to 5.

## Where a scope question is answered

Above is the endpoint rule. The wider question — *should this server do this at all?* — is answered in [docs/non-goals.md](docs/non-goals.md), whose one-line list is mirrored in [SPEC.md §1](SPEC.md#1-goals--non-goals). Open the non-goals list before proposing a feature: several plausible ideas (a hosted multi-tenant deployment, a second third-party upstream, voice control, lyrics) are decisions rather than gaps, each with the reason and the alternative that was chosen instead.

A question that is genuinely open gets an issue, because an issue records that it was asked. The *answer* goes in the non-goals list, and `tests/non-goals.test.ts` then holds SPEC §1 and the README to it. Do not resolve a scope question in a pull-request thread: the next reader of the list cannot see that it was ever discussed.

## Brand marks, wordmarks, and attribution

This is an unofficial third-party client. Two rules pull in opposite
directions, and both are load-bearing.

**Do not put a third party's mark in this repository.** The
[Branding Guidelines](https://developer.spotify.com/branding-guidelines) are
explicit: "Your logo should not include, or look similar to the Spotify logo or
any of its brand elements (e.g. Spotify Green, the circle, and the waves)." So,
in any file under `assets/` or any source file under `src/`:

- No Spotify Green — `#1DB954` or `#1ED760` — in any casing or notation.
- No Spotify circle or waves glyph, redrawn, recoloured, rotated, or partial.
  Recomposing the mark out of circles and curves is a modification, and the
  guidelines allow no exceptions for it.
- No third-party wordmark set as artwork: no rendered `Spotify`, `stats.fm`,
  `Last.fm` or `Discogs` text, and no bar-chart or dot-chain glyph standing in
  for one. The guard applies this one to `assets/` only, because naming a
  service in prose under `src/` is required by the rule below.
- No vendored logo file. Do not commit Spotify's or anyone else's official
  asset into this MIT-licensed repository.

The same applies to the one `User-Agent` this server sets. It goes only to
stats.fm, from `src/lib/statsfm-client.ts`: `spotify-mcp
(+https://github.com/NovaLux12/spotify-mcp-server)`, this project's own name
plus a contact URL, and no third-party product token. Requests to
`api.spotify.com` set no `User-Agent` at all — only `Authorization`,
`Content-Type` and `If-None-Match` — so if you add one there, it must carry
this project's name and no third-party token either.

`tests/third-party-marks-guard.test.ts` fails the build if any of the above
returns. It is a source scan, so it sees new files without being edited.

**Do not strip out the nominative references either.** The Terms require the
attribution, so the following are correct and must stay:

- Plain-text references naming the Spotify Web API, `spotify:` URIs,
  `open.spotify.com` links, `SPOTIFY_*` environment variables, and the API's own
  field names. That is describing the platform being integrated, which is the
  point of the project.
- The non-affiliation notice, which must read as the opposite of an endorsement
  claim: this project is not affiliated with, endorsed by, or sponsored by
  Spotify AB.
- Attribution *of* Spotify content, where content is displayed.

Deleting the word "Spotify" to avoid a trademark problem would be the actual
compliance failure. The rule is not "no third-party names" — it is "no
third-party marks, and keep the required attribution".

If you need to attribute Spotify visually, do not draw it. Reference the
official full logo by URL, unmodified, and follow the size and exclusion-zone
rules in [docs/compliance.md](docs/compliance.md).

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
- **Two doc gates run in CI and have no local command of their own.** `npm run check:docs-counts` and `npm run check:doc-tool-names` must both pass. `check:docs-counts` fails when a generated block is stale, so after anything that changes the registry, run `npm run build && npm run count:tools -- --write` and commit what it rewrites — `--check` reads the working tree, so an uncommitted regeneration looks green locally and red in CI. `check:doc-tool-names` fails when a doc names a tool or argument the registry does not have.
- **Write `Closes #N`, not `fix(#N)` or `Refs #N`.** Only `Closes` / `Fixes` / `Resolves` close an issue. The other two read like a closing reference and are not, so the fix lands and the issue stays open — silently, because `gh pr merge` prints no issue lines when it matched nothing. After merging, run `scripts/close-issues-from-pr.sh <pr-number> [issue ...]`, passing the issue numbers explicitly; it closes whatever is still open and exits non-zero unless every issue it was given is verifiably closed. Check the fix is in the merged tree before you close, not just that the merge succeeded.
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

`release.yml` creates the tag and then **dispatches `publish.yml` itself**:

```bash
gh workflow run publish.yml --repo "$GITHUB_REPOSITORY" --ref "$RELEASE_TAG" -f tag="$RELEASE_TAG"
```

The dispatch is not a workaround, it is the mechanism. release-please creates
the tag with the repository's `GITHUB_TOKEN`, and a tag pushed with
`GITHUB_TOKEN` does not start a push-triggered workflow — so `publish.yml`
would otherwise never run. Both workflow files say so in their own header
comments.

`publish.yml` still carries a `push: tags: ["v*"]` trigger, and it does fire
when the tag is created by something other than `GITHUB_TOKEN`. So a tag can
start a publish run twice over: once from that push trigger, once from the
release workflow's dispatch. That is the race to avoid, and it is why a
maintainer must not add a *third* run for a tag the release workflow has
already dispatched. `concurrency` groups both under `publish-<tag>` with
`cancel-in-progress: false`, so the loser queues rather than cancels, and the
npm step skips a version that is already present rather than failing on it.

This section previously said the opposite in two directions at once — that the
tag push alone starts the workflow, and that a manual dispatch is therefore
wrong. The tag push is not sufficient, and the dispatch is exactly what the
release workflow performs. The two errors cancelled out into a runbook that
told a maintainer to do nothing and then, when no run appeared, to stop.

To watch the run the tag started:

```bash
RUN_ID="$(gh run list --workflow publish.yml --limit 20 \
  --json databaseId,headBranch,event,status,conclusion,url \
  --jq "map(select(.headBranch == \"${TAG}\")) | .[0].databaseId")"
test -n "$RUN_ID"
gh run watch "$RUN_ID" --exit-status
```

`headBranch` carries the tag for both trigger types, so the same selector finds
a `workflow_dispatch` run and a tag-push run. If more than one run exists for
the tag, read `.event` before watching one — `gh run list --json
databaseId,event,conclusion,createdAt` shows which is which.

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

The `Publish` workflow checks out the tagged commit, refuses to proceed unless
`package.json` and both `server.json` version fields match the tag, runs
`npm ci`, `npx tsc --noEmit`, and `npm test` (which builds first, so the
compiled `dist/` is what gets tested), then packs the tarball and asserts its
`dist/index.js` still starts with the `#!/usr/bin/env node` shebang before
publishing `@novalux12/spotify-mcp` with provenance (trusted publishing/OIDC or
the configured `NPM_TOKEN` fallback). A second job then syncs `server.json`'s
version from the tag, validates the synced manifest against the MCP Registry
schema its own `$schema` names, and publishes it to the official MCP Registry
using GitHub OIDC. The same schema gate runs in `ci.yml` on every pull request,
which is where a violation belongs: the registry rejects a non-conforming
manifest with a 400 that names a property, and by then `npm publish` has
already made the release public. A rerun is safe after a partial failure: the
npm job skips a version that is already present and the registry job can be
retried.


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

Expected results are the exact tag version `$VERSION`, `true` for
the `server.json` check, and `true` for the Registry check. Also inspect the
workflow URL printed by `gh run view "$RUN_ID"` if any verification fails.

Two other Registry read paths are easy to mistake for this one. They are not
equally wrong:

| Query | What it reports | Trust it? |
|---|---|---|
| `…/versions/latest` | the current version, with `isLatest` | yes — this is the check above |
| `…/versions` | every published version, newest first, each with `isLatest` and timestamps | yes — correct, and the way to audit an *older* version or its deprecation status |
| `/v0/servers?search=…` | a **paginated** slice whose first page can omit the newest release | no — see below |

`?search=` is the trap, and the shape matters. Its response carries
`metadata.nextCursor` and a `metadata.count`, and the versions it returns can
stop short of the newest published — a page of results is not the full history,
so the highest version in a search result is not evidence of what is live.
Worse, its ordering is alphabetical rather than semantic, so the first row is
not the newest (`1.10.0` sorts ahead of `1.2.1`); reading one row off a search
and believing it is how a stale-looking number gets quoted as fact.

The failure this guards against is concluding a publish failed and
re-publishing a version that is already out. npm versions are immutable and the
publish workflow skips a version that is already present, so a re-publish is
never the remedy — recover with `gh run rerun <run-id> --failed` instead, which
re-runs the registry job without re-attempting the npm publish.

If the two Registry answers disagree and you need a third read, do not reach for
a bare `npm view`: it has served a stale `latest` and a 404 for a version that
was already published. Cache-bust it —

```
curl -sS "https://registry.npmjs.org/@novalux12/spotify-mcp?cb=$(date +%s)" | jq '.["dist-tags"]'
```

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
