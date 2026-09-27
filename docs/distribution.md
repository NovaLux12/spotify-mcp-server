# Distribution kit — submission-ready copy

One-stop copy for claiming/listing the server in directories. Keep in sync
with README + server.json when the tool surface changes.

## Canonical facts

Three things this page used to carry are gone, because each one went stale
without anyone noticing (#932):

- **The version.** A header naming a release reads as the current one to a
  directory reviewer and is wrong the moment the next release merges. The
  current version is the `version` field in `package.json`; what each release
  contains is [CHANGELOG.md](../CHANGELOG.md).
- **A "last verified" date.** Nothing re-checked it, so it could only ever get
  older.
- **A test count.** The census does not run the suite, so wiring the figure in
  would mean CI running it twice; a sentence with no number in it cannot drift.
  Read the case count from the CI run.

The surface line below is the one figure that is kept, because it is generated
by `npm run count:tools -- --write` and gated by `--check`. The thresholds in
the safety line are constants in `src/tools/confirm.ts` and
`src/tools/playlistbatch.ts`, not generated figures.

- npm: `@novalux12/spotify-mcp` — https://www.npmjs.com/package/@novalux12/spotify-mcp
- Repo: https://github.com/NovaLux12/spotify-mcp-server
- MCP Registry name: `io.github.NovaLux12/spotify-mcp-server`
- Transport: stdio (`npx @novalux12/spotify-mcp` after `npm i -g`, or via client config)
- Auth: OAuth PKCE (S256) browser flow or headless mode; tokens at `~/.spotify-mcp/tokens.json` (0600)
<!-- BEGIN:generated surface-census -->
- Surface: 571 tools, 17 fixed resources, 47 resource templates, and 14 prompts in the finalized default production registry (toolsets can trim a configured host); aligned with Spotify's current Web API plus the stats.fm public API (read-only, no auth). The registry-derived counts replace historical release snapshots; v1.30.0 added the taste composite briefs, playlist specs, and reports described in `docs/wave2-composites.md`.
<!-- END:generated surface-census -->
- Tests: node:test suite with CI on Node 22 and Node 24; the CI runner reports the exact case count.
- Safety: `dry_run` + `response_format` on every mutating tool enforced by a registry-wide conformance guard (#920); request/quota usage tracking with pre-flight gating on heavy scans (#904 — blocked scans issue 0 requests, shrunk walks disclose `requests_made`/`budget_shrunk`); elicitation-gated human confirmation on bulk playlist removals (10+ URIs) and replacements (50+); mutation receipts verifiable via `verify_receipt`; opt-in JSONL audit trail; hard read-only mode (`SPOTIFY_MCP_READONLY=1`)
- Provenance: npm publishes carry SLSA provenance; listed in the official MCP Registry as `io.github.NovaLux12/spotify-mcp-server`

## Canonical copy (single source of truth)

The short description is authored **once**, as the `CANONICAL_DESCRIPTION`
constant in `tests/registry-meta.test.ts`. No documentation file authors it —
this one used to, which is how the same sentence ended up hand-copied six
times, three of them inside the file that called itself the source. Five
surfaces mirror that one constant, and the suite fails `npm test` if any of them
drifts:

- `package.json.description` (npm)
- `server.json.description` (MCP Registry)
- the README one-liner
- the short blurb below
- the opening sentence of the long description below

To change the copy, edit the constant, re-run
`node --import tsx --test tests/registry-meta.test.ts`, then paste the new
sentence into the five mirrors. The two blurbs in this file are mirrors to keep
in step, not a sixth place to edit it.

The short description is capped at 100 characters by the MCP Registry schema
(`maxLength` on `ServerDetail.description`), which is why the detail copy lives
in the separate long description rather than being appended here.

## Short blurb (directories)

> Spotify Web API MCP: playback, library, playlists, search, podcasts. Not
> affiliated with Spotify.

## Long description (Glama / PulseMCP style)

Spotify Web API MCP: playback, library, playlists, search, podcasts. Not
affiliated with Spotify. Transport-independent playback (play/pause/skip/seek/volume/shuffle/repeat,
queue, device transfer, mid-track handoff), deep catalog lookups across tracks,
artists, albums, shows, episodes and audiobooks, complete playlist CRUD with
power operations (duplicate detection, merge/diff/overlap, listening-data-driven
growth proposals), unified library save/remove/check with genre insights and
hygiene analysis, personalization over your top artists/tracks and recently
played, listening reports, a new-releases radar for followed artists, podcast
session composition, named playback scenes, and an audiobook chapter copilot.
Guided prompts cover discovery lists, listening recaps, artist deep-dives and
library migration; live resources expose now-playing and library state for
polling clients. Built for the post-deprecation API: honest about what Spotify
removed, graceful where endpoints are restricted, dry-run previews everywhere
state changes, human-in-the-loop confirmation on bulk deletions, post-write
receipts you can verify in a later turn, and a hard read-only mode. The full
suite runs on every change and the release tag is gated on it green; TypeScript
strict, published to npm (with SLSA provenance) and the official MCP Registry.

## One-command install lines

```bash
# Claude Code
claude mcp add spotify -- npx -y @novalux12/spotify-mcp

# Generic MCP client config (JSON)
{
  "mcpServers": {
    "spotify": {
      "command": "npx",
      "args": ["-y", "@novalux12/spotify-mcp"],
      "env": { "SPOTIFY_CLIENT_ID": "<your-client-id>" }
    }
  }
}
```

First run performs the PKCE browser auth (`npm run auth` headless variant
available). Requires a Spotify developer app with Web API access.

## Release and publish runbook

Distribution is a two-stage release. The `Release Please` workflow opens a
version-bump PR on `main`; merging it creates the `vX.Y.Z` tag and GitHub
release. The `Publish` workflow is the only publisher: it runs the locked
install, typecheck, tests, and build, then publishes the npm package and the
versioned `server.json` to the official MCP Registry.

Merging the release PR is the last human step. The tag it creates starts
`Publish` on its own — `release.yml` dispatches the guarded workflow at the tag
it just pushed — so there is nothing to dispatch by hand. Do not run
`gh workflow run publish.yml` against a release tag: it races the automatic
dispatch, and npm versions are immutable, so the second attempt fails on a
version that already exists. That instruction was here once, and following it
caused a double publish on 2026-09-25.

To watch the run the tag started:

```bash
VERSION="X.Y.Z"                 # replace with the release PR version
TAG="v${VERSION}"

gh release view "$TAG" --json tagName,isDraft,isPrerelease,url
RUN_ID="$(gh run list --workflow publish.yml --limit 20 \
  --json databaseId,headBranch,status,conclusion,url \
  --jq "map(select(.headBranch == \"${TAG}\")) | .[0].databaseId")"
test -n "$RUN_ID"
gh run watch "$RUN_ID" --exit-status
```

Verify every distribution surface before announcing the release:

```bash
git fetch --tags origin

npm view "@novalux12/spotify-mcp@${VERSION}" version --json
git show "${TAG}:server.json" | jq -e --arg version "$VERSION" \
  '.version == $version and .packages[0].version == $version'
curl --fail --silent --show-error \
  "https://registry.modelcontextprotocol.io/v0/servers/io.github.NovaLux12%2Fspotify-mcp-server/versions/latest" \
  | jq -e --arg version "$VERSION" \
      '.server.version == $version
       and ._meta["io.modelcontextprotocol.registry/official"].isLatest == true'
```

A 404 from that `npm view` right after a publish is npm propagation, not a
missing artifact — do not re-publish on it. CONTRIBUTING.md §3 has the
cache-busted read.

The same lag makes `publish-mcp-registry` fail with
`version 'X.Y.Z' was not found` moments after a successful npm publish: that
job checks that npm actually serves the new version, and npm takes minutes to
make one visible. It is a propagation race, not a broken release. Recover with
a failed-jobs-only re-run, which re-runs the registry job without re-attempting
the immutable npm publish:

```bash
gh run rerun "$RUN_ID" -R NovaLux12/spotify-mcp-server --failed
```

The npm command must print the exact version without the leading `v`; both
`server.json` checks and the Registry `isLatest` check must return `true`.
The publish workflow skips an npm version that is already present, so a
partial failure is recovered with the failed-jobs-only re-run above; do not
retag or overwrite an already published version. Deprecate an unsafe npm
version with `npm deprecate`, mark the corresponding Registry version
deprecated through the Registry status path, and ship a new patch release with
the fix.

Verify against `…/versions/latest`. `…/versions` is equally correct and is the
right query when auditing an older version or its deprecation status, but
`/v0/servers?search=…` is a paginated, lagging index and is not a substitute
for either — it can omit the newest release, and its rows sort alphabetically
rather than by recency, so a single row read off it is not the current
version. That distinction, and what to do when the two disagree, is set out in
CONTRIBUTING.md §3.

## Claim checklist

- [ ] Smithery: **not pursuing a hosted listing** — decided #710, and the
  manifest that implied otherwise is gone. A hosted instance cannot complete
  this server's OAuth. The flow is native-app PKCE: `validateRedirectUri`
  accepts only a plain-HTTP loopback URL, and the callback listener binds
  `127.0.0.1`/`::1` exclusively, so the browser redirect resolves to the
  *user's* machine rather than the container and the authorization code never
  arrives. Tokens are then written to that instance's own
  `~/.spotify-mcp/tokens.json`. A listing that prompted for
  `SPOTIFY_CLIENT_ID` would therefore start cleanly and fail at the PKCE step,
  advertising a capability that does not work. `SPOTIFY_HEADLESS=1` is the one
  non-browser path, and it needs a human to paste the redirect URL back — also
  not something a hosted listing can do on the user's behalf.
  `tests/distribution-channel-guard.test.ts` fails if the manifest returns.
- [ ] **Name re-check, before any new channel goes live** (#705). The product
  keeps the name "SpotifyMCP" for v2 as a recorded, accepted risk, because
  Spotify's Developer Policy Sec. VI.2 says an SDA name "should not begin with
  'Spot'". The decision, its reasoning and the date are in
  [`docs/compliance.md`](compliance.md#naming-decision-2026-09-18); this
  checklist item is the enforcement point for it. **Adding a directory,
  marketplace or listing is a re-check trigger, not a routine release step**:
  before the listing is submitted, re-read the current text of Sec. VI.2
  against the name and either confirm the decision still holds or reopen it.
  A third-party promotion, a paid or Sponsorship conversation with Spotify, or
  a policy change that names this pattern are the same trigger. Do not submit
  a listing first and reconcile the naming question afterwards — the
  non-affiliation notice is the compensating control that makes the decision
  defensible, and it is a disclosure the listing must carry too. The short
  blurb above already ends in it, which is why the blurbs are the copy to
  paste rather than a fresh summary.
- [ ] Glama: submit via glama.ai/mcp/servers → verify tool list renders
- [ ] mcp.so / PulseMCP / Cursor directory: use short blurb above
- [ ] GitHub topic hygiene: `mcp`, `mcp-server`, `spotify`, `model-context-protocol`
