# SpotifyMCP

An MCP server that wraps the Spotify Web API, letting AI assistants (like Claude) control playback, search the full catalog including podcasts and audiobooks, manage your library and playlists, and understand your listening taste.

## Why this one

Most Spotify MCP servers are thin wrappers. This one is built to be the default:

- **Complete API surface** — every non-deprecated Spotify Web API endpoint callable with a standard developer token is covered by a tool (playback, search, catalog, audiobooks, personalization, library, playlists, following).
- **Honest about deprecations** — Spotify removed recommendations, related artists, audio features/analysis, genre seeds, and featured playlists from new apps. Servers still exposing those ship tools that fail at runtime; this one doesn't.
- **Tested** — full unit suite over the client (token refresh, rate limiting, pagination) and every tool handler, plus an end-to-end MCP protocol smoke test. Many alternatives have zero tests.
- **Paginated everything** — `fetch_all` on library and playlist listings walks every page (capped at 500 items) instead of silently truncating at one page of 50.
- **Podcasts are first-class** — episodes work everywhere: now-playing, queue, search-and-play. Several competitors can't see podcasts at all.
- **Device-aware playback** — list devices, transfer playback, and target any command at a specific device for multi-room setups.
- **Robust auth** — PKCE flow with silent refresh, persistent mode-600 token cache, headless paste-flow (`SPOTIFY_HEADLESS=1`) for servers and containers.

## Features

**Playback (15 tools)** — now playing / currently-playing polls, play (by URI, or `play_from_search` to play straight from a name), pause, skip, previous, seek, volume, shuffle, repeat, queue view/add, device list, transfer playback.

**Search & catalog** — unified search across tracks/artists/albums/playlists/shows/episodes; deep lookups for tracks, artists, artist albums, albums, album tracks, shows, show episodes, episodes, and your profile (`get_me`).

**Audiobooks** — titles, chapters, chapter lookup, and your saved audiobooks (market-gated by Spotify to US/UK/CA/IE/NZ/AU).

**Personalization** — top tracks and artists across three time ranges, recently played.

**Library** — saved tracks/albums/shows/episodes with optional full pagination; unified save/remove/check via `/me/library` URIs.

**Playlists** — full CRUD plus item management (add/remove/reorder), cover art retrieval and custom cover upload (`ugc-image-upload` scope required for upload).

**Following** — followed-artists list and follow-state checks.

Also exposed: **7 MCP resources** (profile, player state, queue, top tracks/artists, recently played, playlists) and **4 prompt templates** (DJ set, mood playlist, taste summary, discovery alternative).

## Requirements & limitations

- **Spotify Premium is required for playback control** (play, pause, skip, seek, volume, shuffle, repeat, queue, transfer). Free accounts can authenticate and use search/catalog/library/playlist tools, but every playback command will fail with a Premium-required error from Spotify.
- `fetch_all` pagination walks up to **500 items** per call (protects against runaway loops); beyond that, use `limit`/`offset` paging.
- Audiobook tools are market-gated by Spotify to US, UK, Canada, Ireland, New Zealand, and Australia.
- Spotify's developer mode allows up to 5 authorised users per app until extended quota is granted.

## Quick setup

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

**Headless / remote hosts** (no browser on the machine running the MCP server):

```bash
SPOTIFY_HEADLESS=1 SPOTIFY_CLIENT_ID=your_client_id_here npx -y @novalux12/spotify-mcp@latest auth
```

The auth URL is printed; complete the flow in any browser (e.g. on your laptop), then paste the redirect URL back into the prompt. Useful for homelabs, CI, and agent runtimes.

### Headless authentication (browserless hosts)

If you're running this MCP server on a host that doesn't have a browser
(e.g., a cloud VM, a Docker container, a remote server), set the
`SPOTIFY_HEADLESS=1` environment variable. The auth flow will skip the
local HTTP callback server and instead prompt you to paste the
redirect URL after authorizing the app in your browser.

#### Steps

1. Set `SPOTIFY_HEADLESS=1` in your environment
2. Run the server — it will print a URL to authorize the app
3. Open the URL in a browser on a different machine
4. After authorizing, your browser will redirect to the redirect URI
5. Copy the full URL from the address bar
6. Paste it back into the server prompt

#### Why

The default auth flow opens a browser via the `open` package and runs a
local HTTP callback server on `127.0.0.1:8888`. That breaks when the MCP
server runs on a headless host (homelab, CI, agent runtime) where there
is no browser to `open()`, and the `127.0.0.1:8888` callback can't be
reached from the user's machine.

`SPOTIFY_HEADLESS=1` switches to a paste-URL flow: the auth URL is
printed to stdout, the operator completes the flow in any browser (their
laptop, phone), then pastes the full redirect URL back. The code +
state are extracted and exchanged server-side. Works across machines.

**Windows (Command Prompt):**
```cmd
set SPOTIFY_CLIENT_ID=your_client_id_here && npx -y @novalux12/spotify-mcp@latest auth
```

**Windows (PowerShell):**
```powershell
$env:SPOTIFY_CLIENT_ID="your_client_id_here"; npx -y @novalux12/spotify-mcp@latest auth
```

### 3. Configure Claude Desktop

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

### Alternative: Claude Code

If you use Claude Code, add the server without editing JSON by hand:

```bash
claude mcp add spotify -- npx -y @novalux12/spotify-mcp@latest
# then set SPOTIFY_CLIENT_ID in your shell or MCP env:
export SPOTIFY_CLIENT_ID=your_client_id_here
```

Or add it to `.mcp.json` in your project root — same `command`/`args`/`env` shape as above.

### Command for AI agents

Any coding agent (Claude Code, OpenClaw, Cursor, Aider, …) can install,
build, authenticate and register the server in one paste. Give it your
Client ID and let it run:

```bash
git clone https://github.com/NovaLux12/spotify-mcp-server.git && cd spotify-mcp-server \
  && npm ci && npm run build \
  && SPOTIFY_CLIENT_ID=your_client_id_here npm run auth
```

Then point your host's MCP config at `<repo>/dist/index.js` with
`SPOTIFY_CLIENT_ID` in its env (shapes below). Agents should finish by
calling the `get_me` tool once — it proves auth, scopes and transport in a
single round-trip.

### OpenClaw

Add to `mcp.servers` in `~/.openclaw/openclaw.json`:

```json
"spotify": {
  "command": "node",
  "args": ["/path/to/spotify-mcp-server/dist/index.js"],
  "cwd": "/path/to/spotify-mcp-server",
  "env": { "SPOTIFY_CLIENT_ID": "your_client_id_here" }
}
```

Then restart the OpenClaw gateway so it respawns the server. Headless box?
Run the auth step with `SPOTIFY_HEADLESS=1` on any machine with a browser
(see above) — tokens land in `~/.spotify-mcp/tokens.json` either way.

### When things go wrong: install the doctor skill

This repo ships [`skills/spotify-mcp-doctor/SKILL.md`](skills/spotify-mcp-doctor/SKILL.md) —
a procedural diagnostic your agent can execute instead of you re-reading
this README. It walks the real failure modes in order: wiring → binary →
app credentials → token freshness → error classification (Premium vs
dev-mode allowlist vs market gating vs deprecations). Install:

```bash
cp -r skills/spotify-mcp-doctor ~/.openclaw/workspace/skills/   # OpenClaw
# or drop it into .claude/skills/ for Claude Code projects
```

Then just ask your agent: *"Spotify tools are failing — run the spotify
doctor skill."*

## Usage

Once connected, you can ask Claude things like:

- "What are my top Spotify tracks?"
- "Create a playlist of chill lo-fi songs for studying"
- "Add the song Blinding Lights to my workout playlist"
- "What artists have I been listening to most lately?"
- "Make me a playlist with a late night driving vibe"

## Troubleshooting

- **"Not authenticated" on first tool call** — run `npx -y @novalux12/spotify-mcp@latest auth` (or `npm run auth` from a clone) and complete the browser flow. Tokens are stored at `~/.spotify-mcp/tokens.json` and refreshed automatically.
- **Redirect URI mismatch** — the Spotify app's redirect URI must be *exactly* `http://127.0.0.1:8888/callback` (no trailing slash). Save the app settings and retry.
- **Port 8888 busy** — another process is holding the callback port; stop it or pick a free port via `SPOTIFY_REDIRECT_URI=http://127.0.0.1:8888/callback` with a different port and matching Dashboard setting.
- **Headless / Docker** — set `SPOTIFY_HEADLESS=1` before `auth`; paste the redirect URL back when prompted (see above).

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
