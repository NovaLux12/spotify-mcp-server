# SpotifyMCP

[![CI](https://github.com/NovaLux12/spotify-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/NovaLux12/spotify-mcp-server/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@novalux12/spotify-mcp)](https://www.npmjs.com/package/@novalux12/spotify-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22.9-brightgreen)

An MCP server that wraps the Spotify Web API — lets Claude and other AI assistants control playback, search the catalog (tracks, podcasts, audiobooks), and manage your library and playlists.

212 tools. Every non-deprecated endpoint, plus extras most servers skip. [Full list →](SPEC.md)

---

> ### 🤖 Paste this to your agent
>
> Copy the block below into Claude Code, Cursor, OpenClaw, or any coding agent — it will set SpotifyMCP up for you.
>
> ```
> Set up the Spotify MCP server from https://github.com/NovaLux12/spotify-mcp-server.
>
> 1. Walk me through creating a Spotify app at https://developer.spotify.com/dashboard
>    with redirect URI http://127.0.0.1:8888/callback, or use the Client ID I paste below.
> 2. Clone, build, and authenticate:
>    git clone https://github.com/NovaLux12/spotify-mcp-server.git
>    cd spotify-mcp-server && npm ci && npm run build
>    SPOTIFY_CLIENT_ID=<paste-here> npm run auth
> 3. Wire it into my MCP host config and verify with the get_me tool.
>
> My Spotify Client ID: <paste here or say "help me create one">
> ```

---

## Why this one

| | |
|---|---|
| **Complete** | 212 tools — playback, search, catalog, library, playlists, following + extras like duplicate cleanup, M3U/CSV import-export, podcast sessions and market checks. |
| **Safe** | `dry_run` previews on every write, receipts that prove what landed, human confirmation for bulk deletes, and `READONLY` to hide all writes. |
| **Honest** | No zombie tools for endpoints Spotify removed. Legacy lookups explain the 403 instead of crashing. |
| **Polished** | Paginated (up to 500), podcasts first-class, device-aware playback, `spotify_doctor` self-diagnosis, real test suite. |

## Quick start

### 1. Create a Spotify app

[Spotify Developer Dashboard](https://developer.spotify.com/dashboard) → Create app → add this Redirect URI exactly:

```
http://127.0.0.1:8888/callback
```

Copy the **Client ID**.

### 2. Authenticate

```bash
SPOTIFY_CLIENT_ID=your_client_id_here npx -y @novalux12/spotify-mcp@latest auth
```

Opens a browser, saves tokens to `~/.spotify-mcp/tokens.json`, auto-refreshes after.

<details><summary>Windows & headless</summary>

**Windows (Command Prompt):**
```cmd
set SPOTIFY_CLIENT_ID=your_client_id_here && npx -y @novalux12/spotify-mcp@latest auth
```

**Windows (PowerShell):**
```powershell
$env:SPOTIFY_CLIENT_ID="your_client_id_here"; npx -y @novalux12/spotify-mcp@latest auth
```

**Headless / remote host:**
```bash
SPOTIFY_HEADLESS=1 SPOTIFY_CLIENT_ID=your_client_id_here npx -y @novalux12/spotify-mcp@latest auth
# prints a URL → open it on any machine → paste the redirect back
```

Check: `npx -y @novalux12/spotify-mcp@latest doctor` — exit 0 means you're good.

</details>

### 3. Add to your MCP host

```json
{
  "mcpServers": {
    "spotify": {
      "command": "npx",
      "args": ["-y", "@novalux12/spotify-mcp@latest"],
      "env": { "SPOTIFY_CLIENT_ID": "your_client_id_here" }
    }
  }
}
```

Restart the host. A hammer icon in the chat input means it's connected.

<details><summary>Claude Code · OpenClaw · other hosts</summary>

**Claude Code (no JSON editing):**
```bash
claude mcp add spotify -- npx -y @novalux12/spotify-mcp@latest
export SPOTIFY_CLIENT_ID=your_client_id_here
```

**OpenClaw** — `~/.openclaw/openclaw.json` → `mcp.servers`:
```json
"spotify": {
  "command": "node",
  "args": ["/path/to/spotify-mcp-server/dist/index.js"],
  "cwd": "/path/to/spotify-mcp-server",
  "env": { "SPOTIFY_CLIENT_ID": "your_client_id_here" }
}
```

Any spec-compliant host works — same `command`/`args`/`env` shape under `mcpServers` or `servers`. If the host can't pass env vars, authenticate once beforehand; the token cache persists.

</details>

## What you can ask

- "What are my top tracks this month?"
- "Make a late-night driving playlist"
- "Add Blinding Lights to my workout playlist"
- "What podcasts have new episodes?"
- "Clean duplicates across all my playlists"

## Configuration

All via env vars — no config file. Only `SPOTIFY_CLIENT_ID` is required.

| Variable | Example | Purpose |
|---|---|---|
| `SPOTIFY_MCP_TOOLSETS` | `playback,catalog` | Trim by group for hosts that cap tool counts |
| `SPOTIFY_MCP_READONLY` | `1` | Hide every write tool |
| `SPOTIFY_MCP_HISTORY` | `1` | Log mutations to JSONL for undo |

Full reference: [docs/configuration.md](docs/configuration.md)

`spotify_doctor` (CLI + in-server tool) diagnoses token state, scope gaps, Premium gating, and rate-limit cooldowns without extra setup.

## Docs

- [SPEC.md](SPEC.md) — every tool, resource & prompt
- [ARCHITECTURE.md](ARCHITECTURE.md) — how it's built
- [docs/configuration.md](docs/configuration.md) — all env vars
- [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup & conventions
- [CHANGELOG.md](CHANGELOG.md) — release history

## Requirements

- **Premium** for playback control (play/pause/skip/seek/volume/queue). Free accounts can still use search, library & playlists.
- Node 22.9+, Spotify app in dev mode (5 users until extended quota).
- Audiobooks gated by Spotify to US/UK/CA/IE/NZ/AU.

<details><summary>Troubleshooting</summary>

- **"Not authenticated"** → re-run `auth`; check `~/.spotify-mcp/tokens.json` exists and the redirect URI matches exactly (no trailing slash).
- **Auth loop / S256 error** → open a private window, log into spotify.com first, then retry the auth URL there.
- **Port in use (8888)** → free the port, set `SPOTIFY_REDIRECT_URI` to another port, or use `SPOTIFY_HEADLESS=1`.
- **"Premium required"** on playback → expected on Free accounts; no workaround.
- **Still stuck?** `npx -y @novalux12/spotify-mcp@latest doctor` or ask your agent to run the [spotify-mcp-doctor skill](skills/spotify-mcp-doctor/SKILL.md).

</details>

## Development

```bash
git clone https://github.com/NovaLux12/spotify-mcp-server.git && cd spotify-mcp-server
npm ci && npm run build
cp .env.example .env  # add your Client ID
npm run auth          # one-time login
npm run dev           # run from source
npm test              # unit + MCP smoke tests
```

---

*Not affiliated with Spotify. Use per the [Spotify Developer Terms](https://developer.spotify.com/terms).*

[MIT](LICENSE) © Carme99 and NovaLux12 contributors · Acknowledges [calebWei/SpotifyMCP](https://github.com/calebWei/SpotifyMCP) and [varunneal/spotify-mcp](https://github.com/varunneal/spotify-mcp).
