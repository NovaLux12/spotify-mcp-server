# SpotifyMCP

[![CI](https://github.com/NovaLux12/spotify-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/NovaLux12/spotify-mcp-server/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@novalux12/spotify-mcp)](https://www.npmjs.com/package/@novalux12/spotify-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22.9-brightgreen)

An MCP server that wraps the Spotify Web API, letting AI assistants (like Claude) control playback, search the full catalog including podcasts and audiobooks, manage your library and playlists, and understand your listening taste.

## Why this one

Most Spotify MCP servers are thin wrappers. This one is built to be the default:

- **Complete API surface** — 94 tools covering every non-deprecated Spotify Web API endpoint callable with a standard developer token (playback, search, catalog, audiobooks, personalization, library, playlists, following, users) *plus* agent-grade extras most servers don't have: listening reports, library hygiene analysis, playlist merge/diff/DNA curation, a podcast session composer, named playback scenes, and an audiobook chapter copilot.
- **Honest about deprecations** — Spotify removed recommendations, related artists, audio features/analysis, genre seeds, and featured playlists from new apps. Servers still exposing those ship tools that fail at runtime; this one doesn't — and the few legacy endpoints it keeps (batch lookups, public user profiles) detect the 403 and explain it instead of crashing.
- **Safe by default** — every mutating tool accepts `dry_run=true` to preview exactly what would change without touching your account. Destructive bulk playlist operations go one step further: removing 10+ items or replacing 50+ triggers an MCP elicitation prompt so a human confirms before anything is deleted (`SPOTIFY_MCP_CONFIRM=never` skips prompting for automation). Successful mutations return a receipt (post-write refetched state proving what landed), and a follow-up `verify_receipt` call re-checks it in later turns. Opt-in JSONL audit trail (`SPOTIFY_MCP_HISTORY=1`) logs every mutation for undo. And `SPOTIFY_MCP_READONLY=1` hides every write-capable module outright — a hard guarantee, not a convention.
- **Scope-aware hiding** — write-capable modules whose scopes you didn't grant at auth time are hidden from the tool list entirely, instead of sitting there failing with 403 every time your agent tries them.
- **Right-sized surface** — `SPOTIFY_MCP_TOOLSETS=playback,catalog` trims the registered tools to a subset for hosts that cap tool counts; `SPOTIFY_MCP_ENABLE_TOOLS`/`SPOTIFY_MCP_DISABLE_TOOLS` fine-tune individual modules on top.
- **Self-diagnosing** — a CLI `doctor` command and an in-server `spotify_doctor` tool classify the real failure modes: missing/expired tokens, scope gaps between your grant and the exposed write tools, Premium-only gating, rate-limit cooldowns.
- **Tested** — full unit suite over the client (token refresh, rate limiting, pagination) and every tool handler, plus an end-to-end MCP protocol smoke test. Many alternatives have zero tests.
- **Paginated everything** — `fetch_all` on library and playlist listings walks every page (capped at 500 items) instead of silently truncating at one page of 50.
- **Podcasts are first-class** — episodes work everywhere: now-playing, queue, search-and-play, and a session composer that packs saved episodes into a commute-length listening block. Several competitors can't see podcasts at all.
- **Device-aware playback** — list devices, transfer playback, hand off mid-track to another Connect device, target any command at a specific device for multi-room setups, and recall named volume/device/repeat scenes.
- **Robust auth** — PKCE flow with silent refresh, persistent mode-600 token cache, headless paste-flow (`SPOTIFY_HEADLESS=1`) for servers and containers.

## Features

94 tools across 20 tool modules, plus the top-level `verify_receipt` diagnostic:

**Playback & devices (16 tools)** — now playing / currently-playing polls, play (by URI, or `play_from_search` to play straight from a name), pause, skip, previous, seek, volume, shuffle, repeat, queue view/add, device list, transfer playback, and `handoff` to move mid-track playback to another Spotify Connect device.

**Scenes & wind-down (6 tools)** — save named playback scenes (device + volume + shuffle/repeat + optional context) to a local sidecar and re-apply them in one call (`save_scene`, `list_scenes`, `delete_scene`, `apply_scene`); `schedule_wind_down` ramps the volume down to a floor over N minutes and then pauses; `cancel_wind_down` stops a running ramp.

**Search & catalog (20 tools)** — unified `search` across tracks/artists/albums/playlists/shows/episodes/audiobooks (limit capped at 10 per Spotify's Feb 2026 change) and `search_deep`, which walks past that cap server-side (up to 5 pages of 10 results per type, deduplicated); deep lookups for tracks, artists, artist albums, albums, album tracks, shows, show episodes, episodes, and your profile (`get_me`); batch `get_several_*` lookups for tracks, albums, artists, episodes, shows, audiobooks and chapters, plus artist top-tracks / available-markets — these were removed by Spotify's February 2026 Web API changes and fail with an explanatory message on newer app registrations (they still work with credentials from a grandfathered pre-Nov-2024 app).

**Audiobooks (7 tools)** — titles, chapters, chapter lookup, and your saved audiobooks (market-gated by Spotify to US/UK/CA/IE/NZ/AU); copilot extras: `list_all_chapters` (every chapter in one complete table, untruncated the way the Spotify app truncates), `jump_to_chapter` (resume the audiobook context at a numbered chapter), and `where_was_i` (which chapter you're on, how far in, time remaining).

**Personalization & reports (4 tools)** — top tracks and artists across three time ranges, recently played, and `listening_report`: compares your top tracks between two windows (rising / constant / fading) with an era histogram, discovery ratio, repeat overlap against recently played, and hour-of-day buckets.

**Library (14 tools)** — saved tracks/albums/shows/episodes with optional full pagination; save/remove/check partitioned by type to `/me/tracks|albums|shows|episodes(/contains)` (bare IDs), plus unified `/me/library` tools accepting any mix of track/album/show/episode/audiobook URIs in one request; `library_hygiene` flags incomplete albums and consolidation candidates over your liked tracks; genre tools (`library_genre_report`, `filter_by_genre`, `tag_management`) aggregate saved items by user-declared artist tags kept in a local sidecar.

**Playlists (16 tools)** — full CRUD plus item management (add/remove/reorder/replace), cover art retrieval and custom cover upload (`ugc-image-upload` scope required for upload), and `find_duplicates_in_playlist`; power ops: `merge_playlists` (dedupe + append/create), `diff_playlists` (fully paged A/B comparison with position-change detection), `overlap_playlists` (tracks shared across playlists); and `grow_playlist`, which proposes tracks using only your own listening data (co-occurrence across your other playlists — no deprecated recommendations endpoint).

**Following & freshness (5 tools)** — followed-artists list, follow-state checks, follow/unfollow, and `whats_new`: a personal new-releases radar derived from followed artists, with a local watermark so "everything since my last check" just works.

**Users (2 tools)** — any Spotify user's public profile and their public playlists (both removed by Spotify's February 2026 changes for newer app registrations; they degrade with a clear explanation and keep working for grandfathered credentials).

**Podcast sessions (2 tools)** — `plan_podcast_session` greedy-packs your saved episodes into a session of a given length (skipping fully played ones, resuming partially played ones at their position); `start_podcast_session` queues it on a device.

**Diagnostics & receipts (2 tools)** — `spotify_doctor`, an in-server diagnostic that checks token state, scope gaps versus the write tools actually exposed, Premium-only gating, and rate-limit cooldown without touching the network; and `verify_receipt`.

Every mutating tool accepts `dry_run=true` to preview exactly what would change before touching your account. Successful mutations append a **receipt** to their result — post-write refetched state proving what landed — and `verify_receipt` looks a receipt back up in a later turn. Bulk-destructive playlist operations add a human gate on top: `remove_from_playlist` at 10+ URIs and `replace_playlist_items` at 50+ ask for confirmation via MCP elicitation before executing, and `SPOTIFY_MCP_CONFIRM=never` opts automation out of the prompt. Set `SPOTIFY_MCP_HISTORY=1` to additionally log one JSONL line per mutation for an undo/audit trail. Write-capable modules whose scopes you didn't grant are hidden from the tool list entirely (scope-aware hiding), so agents never see commands that could only fail — and `SPOTIFY_MCP_READONLY=1` hides every write-capable module regardless of scopes.

Also exposed: **MCP resources** — 11 fixed URIs (profile, player state, queue, top tracks/artists, recently played, playlists, saved albums/shows/episodes, rate-limit status), each available bare or with `?format=json` for raw machine-readable output, plus RFC-6570 templates (`spotify://playlist/{id}/tracks` paginated, `spotify://artist/{id}`, `spotify://artist/{id}/albums`, `spotify://album/{id}`, `spotify://show/{id}`, `spotify://episode/{id}`) with argument completions offered for show/episode IDs from your own library. And **10 prompt templates**: DJ set, mood playlist, taste summary, discovery alternative, playlist audit, listening recap, library migration, podcast catch-up, artist deep dive, and liked-songs triage.

## Requirements & limitations

- **Spotify Premium is required for playback control** (play, pause, skip, seek, volume, shuffle, repeat, queue, transfer). Free accounts can authenticate and use search/catalog/library/playlist tools, but every playback command will fail with a Premium-required error from Spotify.
- `fetch_all` pagination walks up to **500 items** per call (protects against runaway loops); beyond that, use `limit`/`offset` paging.
- Audiobook tools are market-gated by Spotify to US, UK, Canada, Ireland, New Zealand, and Australia.
- Spotify's developer mode allows up to 5 authorised users per app until extended quota is granted.
- **February 2026 platform caps, handled for you:** `/search` tops out at `limit=10` (default 5) — use `search_deep` to page past it; artist-albums pages top out at `limit=10`, which deep views walk client-side with a bounded page count; playlist item payloads put each row's content under `item`; new app registrations receive no artist genres and no preview URLs — output renders what exists instead of failing on missing fields.

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
| `SPOTIFY_MCP_TOOLSETS` | unset (all) | Comma-separated toolsets to register: `playback`, `catalog`, `library`, `personalization`, `playlists`, `prompts`, `resources`; `all` or unset registers everything |
| `SPOTIFY_MCP_ENABLE_TOOLS` | unset | Comma-separated module keys forced on top of the toolset trim (`disable` wins over `enable` wins over set membership) |
| `SPOTIFY_MCP_DISABLE_TOOLS` | unset | Comma-separated module keys forced off |
| `SPOTIFY_MCP_FRESHNESS_STATE` | `~/.spotify-mcp/freshness.json` | Watermark file powering `whats_new`'s `since: 'last-check'` |
| `SPOTIFY_MCP_SCENES_FILE` | `~/.spotify-mcp/scenes.json` | Location of the playback-scene sidecar written by the scene tools |
| `SPOTIFY_MCP_GENRE_TAGS_FILE` | `~/.spotify-mcp/genre-tags.json` | Artist→genre-tags sidecar consumed by the library genre tools |
| `SPOTIFY_MCP_READONLY` | unset | Set to `1`/`true`/`yes` to hide every write-capable module (playback + scenes, playlists + power ops, library + insights/sessions/receipts, following, users, audiobooks) along with resources and prompts — search, catalog, and personalization reads plus `spotify_doctor` stay available |
| `SPOTIFY_MCP_CONFIRM` | unset | Set to `never` to skip the elicitation-gated confirmation on bulk destructive playlist operations (`remove_from_playlist` at 10+ URIs, `replace_playlist_items` at 50+) — for automation and environments without elicitation support |

### Trim the surface with toolsets

Hosts that cap how many tools they expose can register a subset. Toolsets are coarse (`playback`, `catalog`, `library`, `personalization`, `playlists`, `prompts`, `resources`); module keys are fine-grained (`playback`, `search`, `catalog`, `audiobooks`, `personalization`, `library`, `following`, `playlists`, `users`, `resources`, `prompts`). Precedence: `SPOTIFY_MCP_DISABLE_TOOLS` beats `SPOTIFY_MCP_ENABLE_TOOLS` beats set membership, and scope-aware hiding applies last — a write module whose scopes you never granted stays hidden regardless.

Newer modules ride their parent key rather than adding new ones: `listening_report` under `personalization`, scenes/wind-down under `playback`, `search_deep` under `search`, the audiobook copilot under `audiobooks`, freshness under `following`, merge/diff/overlap/DNA under `playlists`, and library hygiene/genre insights/podcast sessions/receipts under `library`. `spotify_doctor` is unconditional — it always registers so diagnostics survive any trim.

```bash
# Car dashboard: playback controls only
SPOTIFY_MCP_TOOLSETS=playback npx -y @novalux12/spotify-mcp@latest

# Read-only recommender: catalog + taste, nothing that writes
SPOTIFY_MCP_TOOLSETS=catalog,personalization npx -y @novalux12/spotify-mcp@latest
```

```json
{
  "mcpServers": {
    "spotify": {
      "command": "npx",
      "args": ["-y", "@novalux12/spotify-mcp@latest"],
      "env": {
        "SPOTIFY_CLIENT_ID": "your_client_id_here",
        "SPOTIFY_MCP_TOOLSETS": "playlists,catalog",
        "SPOTIFY_MCP_DISABLE_TOOLS": "users"
      }
    }
  }
}
```

Force a single module back on despite the trim (or off despite an active set) with the override variables:

```bash
SPOTIFY_MCP_TOOLSETS=library SPOTIFY_MCP_ENABLE_TOOLS=following   # library set + following module
SPOTIFY_MCP_DISABLE_TOOLS=playlists                               # hide all playlist modules everywhere
```

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

## Publishing & distribution

Releases are cut by [release-please](https://github.com/googleapis/release-please): merge its version-bump PR and it creates the release + `v*` tag. **GitHub suppresses workflow triggers from `GITHUB_TOKEN` events**, so the tag alone does not start [`publish.yml`](.github/workflows/publish.yml) — re-fire it after merging:

```bash
git pull && git tag -d vX.Y.Z; git tag vX.Y.Z "$(git rev-list -n1 origin/main)" && git push origin vX.Y.Z
```

After re-firing, check the [Releases page](https://github.com/NovaLux12/spotify-mcp-server/releases) for a stuck **Draft** of the same version and publish it — tag re-creation can leave the release object in draft, which hides it from users.

The workflow then runs typecheck + tests, builds, publishes [`@novalux12/spotify-mcp`](https://www.npmjs.com/package/@novalux12/spotify-mcp) to npm (authenticated with the `NPM_TOKEN` repo secret; publishes carry SLSA provenance via the job's OIDC identity), and publishes the server metadata to the official [MCP Registry](https://registry.modelcontextprotocol.io) via GitHub OIDC (no secrets needed). The npm package carries `mcpName`, required by the registry's validation.

Optional hardening: migrate to [npm trusted publishing](https://docs.npmjs.com/generating-provenance-statements) — configure the package on npmjs.com (Settings → Publishing access → GitHub Actions, repo `NovaLux12/spotify-mcp-server`, workflow `publish.yml`) and remove the `NPM_TOKEN` secret. A GitHub App token for release-please would additionally let tag pushes fire `publish.yml` natively instead of the manual re-fire step above.

[Smithery](https://smithery.ai) discovers the server via the root [`smithery.yaml`](smithery.yaml); claiming the package on Smithery is a one-time manual step for a maintainer.

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

### Live gauntlet

Exercises every registered tool against the real Spotify API in one pass and proves no mutation occurred:

```bash
node scripts/live-gauntlet.mjs [report.json]                                  # reads only — mutators are skipped
node scripts/live-gauntlet.mjs --include-mutating=create_playlist,save_items report.json   # opt-in dry-run coverage
```

- Discovers tools via `tools/list`, seeds minimal IDs from `get_me` / `search` / `get_user_playlists`, and calls every SAFE (read) tool with the smallest valid arguments; missing prerequisites are reported as SKIP with a reason, never as failures.
- MUTATING tools are skipped unless named in `--include-mutating=a,b` **and** they declare a `dry_run` input; allowlisted calls always send `dry_run:true` and only pass when the response confirms the preview — so even the opt-in path cannot change your account.
- Prints a per-tool status/latency table plus a mutation proof (`mutations performed: NONE`); pass a path to also write the full JSON report.

Prereqs: `npm run build`, `.env` with your Client ID, and completed `npm run auth`.

## Testing

```bash
npm test   # node:test runner — unit tests for the client and every tool module, plus an MCP protocol smoke test
```

## Acknowledgements

- [calebWei/SpotifyMCP](https://github.com/calebWei/SpotifyMCP) — original auth flow and playback scaffolding this project grew from.
- [varunneal/spotify-mcp](https://github.com/varunneal/spotify-mcp) — the reference implementation used as the quality bar for tool coverage and ergonomics.

## License

[MIT](LICENSE) © Carme99 and NovaLux12 contributors.
