# Distribution kit — submission-ready copy

One-stop copy for claiming/listing the server in directories. Keep in sync
with README + server.json when the tool surface changes.

## Canonical facts (2026-09-21)

- npm: `@novalux12/spotify-mcp` — https://www.npmjs.com/package/@novalux12/spotify-mcp
- Repo: https://github.com/NovaLux12/spotify-mcp-server
- MCP Registry name: `io.github.NovaLux12/spotify-mcp-server`
- Transport: stdio (`npx @novalux12/spotify-mcp` after `npm i -g`, or via client config)
- Auth: OAuth PKCE (S256) browser flow or headless mode; tokens at `~/.spotify-mcp/tokens.json` (0600)
<!-- BEGIN:generated surface-census -->
- Surface: 610 tools, 16 fixed resources, 33 resource templates, and 14 prompts in the finalized default production registry (toolsets can trim a configured host); aligned with Spotify's current Web API plus the stats.fm public API (read-only, no auth). The registry-derived counts replace historical release snapshots; v1.30.0 added the taste composite briefs, playlist specs, and reports described in `docs/wave2-composites.md`.
<!-- END:generated surface-census -->
- Tests: node:test suite with CI on Node 22 and Node 24; the CI runner reports the exact case count.
- Safety: `dry_run` + `response_format` on every mutating tool enforced by a registry-wide conformance guard (#920); request/quota usage tracking with pre-flight gating on heavy scans (#904 — blocked scans issue 0 requests, shrunk walks disclose `requests_made`/`budget_shrunk`); elicitation-gated human confirmation on bulk playlist removals (10+ URIs) and replacements (50+); mutation receipts verifiable via `verify_receipt`; opt-in JSONL audit trail; hard read-only mode (`SPOTIFY_MCP_READONLY=1`)
- Provenance: npm publishes carry SLSA provenance; listed in the official MCP Registry as `io.github.NovaLux12/spotify-mcp-server`

## Short blurb (directories)

> The most complete Spotify MCP server: playback control, library and playlist
> management, search, podcasts and audiobooks, personalization, guided prompt
> workflows and live resources — aligned with Spotify's current Web API, with
> dry-run previews for every destructive operation, elicitation-gated
> confirmation on bulk deletions, verifiable mutation receipts, and a hard
> read-only mode.

## Long description (Glama / PulseMCP style)

Spotify MCP turns any MCP client into a full Spotify control surface:
transport-independent playback (play/pause/skip/seek/volume/shuffle/repeat,
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
receipts you can verify in a later turn, and a hard read-only mode. 830+ tests,
TypeScript strict, published to npm (with SLSA provenance) and the official MCP
Registry.

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

Because release-please creates the tag with `GITHUB_TOKEN`, GitHub suppresses
the tag event that would normally start `Publish`. After the release is
visible, dispatch it explicitly at the tag:

```bash
VERSION="X.Y.Z"                 # replace with the release PR version
TAG="v${VERSION}"

gh release view "$TAG" --json tagName,isDraft,isPrerelease,url
gh workflow run publish.yml --ref "$TAG"
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

The npm command must print the exact version without the leading `v`; both
`server.json` checks and the Registry `isLatest` check must return `true`.
The publish workflow skips an npm version that is already present, so a
partial failure is recovered with `gh run rerun "$RUN_ID" --failed`; do not
retag or overwrite an already published version. Deprecate an unsafe npm
version with `npm deprecate`, mark the corresponding Registry version
deprecated through the Registry status path, and ship a new patch release with
the fix.

## Claim checklist

- [ ] Smithery: https://smithery.ai — repo already carries `smithery.yaml`
- [ ] Glama: submit via glama.ai/mcp/servers → verify tool list renders
- [ ] mcp.so / PulseMCP / Cursor directory: use short blurb above
- [ ] GitHub topic hygiene: `mcp`, `mcp-server`, `spotify`, `model-context-protocol`
