# Distribution kit — submission-ready copy

One-stop copy for claiming/listing the server in directories. Keep in sync
with README + server.json when the tool surface changes.

## Canonical facts (2026-08-26, v1.16.1)

- npm: `@novalux12/spotify-mcp` — https://www.npmjs.com/package/@novalux12/spotify-mcp
- Repo: https://github.com/NovaLux12/spotify-mcp-server
- MCP Registry name: `io.github.NovaLux12/spotify-mcp-server`
- Transport: stdio (`npx @novalux12/spotify-mcp` after `npm i -g`, or via client config)
- Auth: OAuth PKCE (S256) browser flow or headless mode; tokens at `~/.spotify-mcp/tokens.json` (0600)
- Surface: 104 tools across 27 tool modules plus the top-level `verify_receipt` diagnostic + 11 fixed resource URIs + RFC-6570 templates + 10 prompts (toolsets can trim); aligned with Spotify's post-Feb-2026 API
- Tests: 638-case node:test suite, CI on Node 22
- Safety: `dry_run` previews on every mutating tool; elicitation-gated human confirmation on bulk playlist removals (10+ URIs) and replacements (50+); mutation receipts verifiable via `verify_receipt`; opt-in JSONL audit trail; hard read-only mode (`SPOTIFY_MCP_READONLY=1`)
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
receipts you can verify in a later turn, and a hard read-only mode. 630+ tests,
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

## Claim checklist

- [ ] Smithery: https://smithery.ai — repo already carries `smithery.yaml`
- [ ] Glama: submit via glama.ai/mcp/servers → verify tool list renders
- [ ] mcp.so / PulseMCP / Cursor directory: use short blurb above
- [ ] GitHub topic hygiene: `mcp`, `mcp-server`, `spotify`, `model-context-protocol`
