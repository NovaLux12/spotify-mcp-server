# SpotifyMCP

[![CI](https://github.com/NovaLux12/spotify-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/NovaLux12/spotify-mcp-server/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@novalux12/spotify-mcp)](https://www.npmjs.com/package/@novalux12/spotify-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22.9-brightgreen)

An MCP server that wraps the Spotify Web API, letting AI assistants (like Claude) control playback, search the full catalog including podcasts and audiobooks, manage your library and playlists, and understand your listening taste.

## Why this one

Most Spotify MCP servers are thin wrappers. This one is built to be the default:

- **Complete API surface** — every non-deprecated Spotify Web API endpoint callable with a standard developer token is covered by a tool (playback, search, catalog, audiobooks, personalization, library, playlists, following, users).
- **Honest about deprecations** — Spotify removed recommendations, related artists, audio features/analysis, genre seeds, and featured playlists from new apps. Servers still exposing those ship tools that fail at runtime; this one doesn't.
- **Tested** — full unit suite over the client (token refresh, rate limiting, pagination) and every tool handler, plus an end-to-end MCP protocol smoke test. Many alternatives have zero tests.
- **Paginated everything** — `fetch_all` on library and playlist listings walks every page (capped at 500 items) instead of silently truncating at one page of 50.
- **Podcasts are first-class** — episodes work everywhere: now-playing, queue, search-and-play. Several competitors can't see podcasts at all.
- **Device-aware playback** — list devices, transfer playback, and target any command at a specific device for multi-room setups.
- **Robust auth** — PKCE flow with silent refresh, persistent mode-600 token cache, headless paste-flow (`SPOTIFY_HEADLESS=1`) for servers and containers.

## Features

69 tools across 9 modules:

**Playback (15 tools)** — now playing / currently-playing polls, play (by URI, or `play_from_search` to play straight from a name), pause, skip, previous, seek, volume, shuffle, repeat, queue view/add, device list, transfer playback.

**Search & catalog** — unified search across tracks/artists/albums/playlists/shows/episodes/audiobooks (limit capped at 10 per Spotify's Feb 2026 change); deep lookups for tracks, artists, artist albums, albums, album tracks, shows, show episodes, episodes, and your profile (`get_me`); plus batch `get_several_*` lookups for tracks, albums, artists, episodes, shows, audiobooks and chapters — these and the artist top-tracks / available-markets lookups were removed by Spotify's February 2026 Web API changes and fail with an explanatory message on newer app registrations (they still work with credentials from a grandfathered pre-Nov-2024 app).

**Audiobooks** — titles, chapters, chapter lookup, and your saved audiobooks (market-gated by Spotify to US/UK/CA/IE/NZ/AU).

**Personalization** — top tracks and artists across three time ranges, recently played.

**Library** — saved tracks/albums/shows/episodes with optional full pagination; save/remove/check partitioned by type to `/me/tracks|albums|shows|episodes(/contains)` (bare IDs), plus unified `/me/library` tools accepting any mix of track/album/show/episode/audiobook/artist/user/playlist URIs in one request.

**Playlists** — full CRUD plus item management (add/remove/reorder), cover art retrieval and custom cover upload (`ugc-image-upload` scope required for upload).

**Following** — followed-artists list and follow-state checks.

**Users** — any Spotify user's public profile and their public playlists.

Also exposed: **MCP resources** — 11 fixed URIs (profile, player state, queue, top tracks/artists, recently played, playlists, saved albums/shows/episodes, rate-limit status) plus a paginated `spotify://playlist/{id}/tracks` template; every URI accepts `?format=json` for raw machine-readable output. And **9 prompt templates** (DJ set, mood playlist, taste summary, discovery alternative, playlist audit, listening recap, library migration, podcast catch-up, artist deep dive).

## Requirements & limitations

- **Spotify Premium is required for playback control** (play, pause, skip, seek, volume, shuffle, repeat, queue, transfer). Free accounts can authenticate and use search/catalog/library/playlist tools, but every playback command will fail with a Premium-required error from Spotify.
- `fetch_all` pagination walks up to **500 items** per call (protects against runaway loops); beyond that, use `limit`/`offset` paging.
- Audiobook tools are market-gated by Spotify to US, UK, Canada, Ireland, New Zealand, and Australia.
- Spotify's developer mode allows up to 5 authorised users per app until extended quota is granted.

## Installation

### 1. Create a Spotify app

Each user needs their own Spotify app to get a Client ID — this is how Spotify identifies which app is making API requests.

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and create a new app.
2. In the app settings, add the following **Redirect URI** exactly (Spotify will reject the login if this doesn't match):
   ```
   http://127.0.0.1:8888/callback
   ```
3. Save. Copy your **Client ID**.

### 2. Authenticate

Run the command below once to log in to your Spotify account. Replace `your_client_id_here` with the Client ID from step 1. It opens a browser window, and after you approve, saves tokens to `~/.spotify-mcp/tokens.json`. The server refreshes them automatically — you won't need to do this again.

**macOS / Linux:**
```bash
SPOTIFY_CLIENT_ID=your_client_id_here npx -y @novalux12/spotify-mcp@latest auth
```

**Windows (Command Prompt):**
```cmd
set SPOTIFY_CLIENT_ID=your_client_id_here && npx -y @novalux12/spotify-mcp@latest auth
```

**Windows (PowerShell):**
```powershell
$env:SPOTIFY_CLIENT_ID="your_client_id_here"; npx -y @novalux12/spotify-mcp@latest auth
```

**Headless / remote hosts** (no browser on the machine running the MCP server):

```bash
SPOTIFY_HEADLESS=1 SPOTIFY_CLIENT_ID=your_client_id_here npx -y @novalux12/spotify-mcp@latest auth
```

The auth URL is printed; complete the flow in any browser (e.g. on your laptop), then paste the redirect URL back into the prompt. Useful for homelabs, CI, and agent runtimes. The default flow runs a local HTTP callback server on `127.0.0.1:8888` and opens the browser via the `open` package; `SPOTIFY_HEADLESS=1` replaces both with the paste flow, so it works across machines.

**Verify the setup:** run `SPOTIFY_CLIENT_ID=your_client_id_here npx -y @novalux12/spotify-mcp@latest doctor` — it prints the resolved configuration, checks the token cache's state and expiry, then probes Spotify with a live authenticated request. Exit code 0 means you are ready to connect your MCP host.

### 3. Connect your MCP host

#### Claude Desktop

Open your `claude_desktop_config.json`:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** Open Claude Desktop → Settings → Developer → Edit Config

Add the `mcpServers` block (replace `your_client_id_here` with your Client ID):

```json
{
  "mcpServers": {
    "spotify": {
      "command": "npx",
      "args": ["-y", "@novalux12/spotify-mcp@latest"],
      "env": {
        "SPOTIFY_CLIENT_ID": "your_client_id_here"
      }
    }
  }
}
```

Fully quit and restart Claude Desktop. A hammer icon in the chat input confirms the server is connected.

#### Generic MCP hosts

The server speaks MCP over stdio, so any spec-compliant host works with the same shape: command `npx`, arguments `-y @novalux12/spotify-mcp@latest`, with `SPOTIFY_CLIENT_ID` in the environment. Adapt the JSON above to your host's config format — most use an identical `command`/`args`/`env` structure under an `mcpServers` or `servers` key. If your host cannot pass environment variables, authenticate once beforehand; the token cache at `~/.spotify-mcp/tokens.json` persists across restarts.

#### Claude Code

If you use Claude Code, add the server without editing JSON by hand:

```bash
claude mcp add spotify -- npx -y @novalux12/spotify-mcp@latest
# then set SPOTIFY_CLIENT_ID in your shell or MCP env:
export SPOTIFY_CLIENT_ID=your_client_id_here
```

Or add it to `.mcp.json` in your project root — same `command`/`args`/`env` shape as above.

#### OpenClaw

Add to `mcp.servers` in `~/.openclaw/openclaw.json`:

```json
"spotify": {
  "command": "node",
  "args": ["/path/to/spotify-mcp-server/dist/index.js"],
  "cwd": "/path/to/spotify-mcp-server",
  "env": { "SPOTIFY_CLIENT_ID": "your_client_id_here" }
}
```

Then restart the OpenClaw gateway so it respawns the server. Headless box? Run the auth step with `SPOTIFY_HEADLESS=1` on any machine with a browser (see above) — tokens land in `~/.spotify-mcp/tokens.json` either way.

#### Command for AI agents

Any coding agent (Claude Code, OpenClaw, Cursor, Aider, …) can install, build, authenticate and register the server in one paste. Give it your Client ID and let it run:

```bash
git clone https://github.com/NovaLux12/spotify-mcp-server.git && cd spotify-mcp-server \
  && npm ci && npm run build \
  && SPOTIFY_CLIENT_ID=your_client_id_here npm run auth
```

Then point your host's MCP config at `<repo>/dist/index.js` with `SPOTIFY_CLIENT_ID` in its env (shapes above). Agents should finish by calling the `get_me` tool once — it proves auth, scopes and transport in a single round-trip.

### Install the doctor skill

This repo ships [`skills/spotify-mcp-doctor/SKILL.md`](skills/spotify-mcp-doctor/SKILL.md) —
a procedural diagnostic your agent can execute instead of you re-reading
this README. It walks the real failure modes in order: wiring → binary →
app credentials → token freshness → error classification (Premium vs
dev-mode allowlist vs market gating vs deprecations). Install:

```bash
cp -r skills/spotify-mcp-doctor ~/.openclaw/workspace/skills/   # OpenClaw
# or drop it into .claude/skills/ for Claude Code projects
```

Then just ask your agent: *"Spotify tools are failing — run the spotify doctor skill."*

## Configuration

All settings come from environment variables — no config file required:

| Variable | Default | Purpose |
| --- | --- | --- |
| `SPOTIFY_CLIENT_ID` | none (required) | OAuth Client ID of your Spotify app; used for login and token refresh |
| `SPOTIFY_REDIRECT_URI` | `http://127.0.0.1:8888/callback` | OAuth redirect URI; must match your dashboard setting exactly |
| `SPOTIFY_MCP_TOKEN_FILE` | `~/.spotify-mcp/tokens.json` | Token cache location (mode 600) |
| `SPOTIFY_HEADLESS` | unset | Set to `1` for browserless paste-flow auth |
| `SPOTIFY_REQUEST_TIMEOUT_MS` | `30000` | Per-request HTTP timeout (ms) for API calls and token refresh |
| `SPOTIFY_MCP_MAX_ITEMS` | `50` | Default per-call item cap for list-type tools (`max_results` overrides per call) |
| `SPOTIFY_MCP_FETCH_ALL_CAP` | `500` | Hard cap on `fetch_all=true` pagination walks |
| `SPOTIFY_MCP_HISTORY` | unset | Set to `1` to log one JSONL line per agent-driven mutation (undo/audit trail) |
| `SPOTIFY_MCP_HISTORY_DIR` | `~/.spotify-mcp/history` | Directory for the mutation JSONL log (`mutations.jsonl`) |

## Usage

Once connected, you can ask Claude things like:

- "What are my top Spotify tracks?"
- "Create a playlist of chill lo-fi songs for studying"
- "Add the song Blinding Lights to my workout playlist"
- "What artists have I been listening to most lately?"
- "Make me a playlist with a late night driving vibe"

## Troubleshooting

### Auth problems

- **"Not authenticated" on first tool call** — the token cache is missing or unreadable. Run `npx -y @novalux12/spotify-mcp@latest auth` (or `npm run auth` from a clone) and complete the browser flow. Tokens are stored at `~/.spotify-mcp/tokens.json` and refreshed automatically afterwards.
- **Auth loop — login succeeds but the next call asks again** — usually one of: (a) the Spotify app's redirect URI doesn't *exactly* match `http://127.0.0.1:8888/callback` (or your `SPOTIFY_REDIRECT_URI`) — no trailing slash, correct scheme; (b) the server process can't write the token file — check the directory exists and is writable, or set `SPOTIFY_MCP_TOKEN_FILE` to a writable path; (c) `SPOTIFY_MCP_TOKEN_FILE` differs between the auth command and the server process — use the same value for both.
- **Error page mentioning S256 / code challenge during authorization** — Spotify failed to establish the PKCE session, typically because the browser is signed into a different account than the one you're authorizing, or a blocker interfered. Open a private/incognito window, log in to Spotify directly at spotify.com first, then retry the auth URL in that same window.
- **Port already in use** — another process holds the callback listener's port (`8888` by default). Free the port (stop or reconfigure the other process), point `SPOTIFY_REDIRECT_URI` at a different free loopback port — the local callback server binds whatever host and port your redirect URI specifies — or bypass the listener entirely by authenticating with `SPOTIFY_HEADLESS=1`; the paste flow never opens a port.

### Playback problems

- **"Premium required" errors on play/pause/skip/seek/volume/shuffle/repeat/queue/transfer** — Spotify reserves playback control for Premium accounts. Free accounts can still use search, catalog lookups, library, and playlist management tools. There is no workaround at the API level.
- **Audiobook tools return empty results or errors** — Spotify gates audiobooks by market to US, UK, Canada, Ireland, New Zealand, and Australia. Check your profile's country (`get_me` returns it); outside those markets the endpoints will not return data regardless of account type.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — how the server is structured: client, transports, tool modules.
- [CHANGELOG.md](CHANGELOG.md) — release history and notable changes.
- [CONTRIBUTING.md](CONTRIBUTING.md) — development setup, conventions, PR expectations.
- [SPEC.md](SPEC.md) — the tool/resource/prompt specification this implementation follows.
- [SECURITY.md](SECURITY.md) — security policy and how to report vulnerabilities.
- [docs/configuration.md](docs/configuration.md) — environment variable reference.

## Disclaimer

This is a personal project, not affiliated with or endorsed by Spotify. It is provided as-is with no warranties or guarantees of any kind. Use it responsibly and in accordance with the [Spotify Developer Terms of Service](https://developer.spotify.com/terms). The author is not responsible for any misuse or consequences arising from use of this software.

## Development

```bash
git clone https://github.com/NovaLux12/spotify-mcp-server.git
cd spotify-mcp-server
npm install
npm run build
```

Copy `.env.example` to `.env` and fill in your Client ID, then:

```bash
npm run auth   # authenticate with Spotify
npm run dev    # run from source (no build needed)
```

Requires Node 22.9+ (`--env-file-if-exists` support). No `.env` file is needed — env vars come from your host config or the command line.

## Testing

```bash
npm test   # node:test runner — unit tests for the client and every tool module, plus an MCP protocol smoke test
```

## Acknowledgements

- [calebWei/SpotifyMCP](https://github.com/calebWei/SpotifyMCP) — original auth flow and playback scaffolding this project grew from.
- [varunneal/spotify-mcp](https://github.com/varunneal/spotify-mcp) — the reference implementation used as the quality bar for tool coverage and ergonomics.

## License

[MIT](LICENSE) © Carme99 and NovaLux12 contributors.
