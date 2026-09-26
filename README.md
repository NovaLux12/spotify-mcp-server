# SpotifyMCP

[![CI](https://github.com/NovaLux12/spotify-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/NovaLux12/spotify-mcp-server/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@novalux12/spotify-mcp)](https://www.npmjs.com/package/@novalux12/spotify-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22.9-brightgreen)

An MCP server that wraps the Spotify Web API — lets Claude and other AI assistants control playback, search the catalog (tracks, podcasts, audiobooks), and manage your library and playlists.

A broad Spotify Web API tool surface, plus extras most servers skip. Registration-gated wrappers are explained rather than hidden; see the [full list →](SPEC.md).

<!-- BEGIN:generated surface-census -->
The finalized default MCP registry exposes **592 tools**, **16 fixed resources**, **33 resource templates**, and **14 prompts**. Toolsets and production gates can trim a configured host; these totals describe the default production `tools/list` after finalizers.
<!-- END:generated surface-census -->

---

> ### 🤖 Paste this to your agent
>
> Copy the block below into Claude Code, Cursor, OpenClaw, or any coding agent — it will set SpotifyMCP up for you.
>
> ⚠️ **Never paste your Spotify credentials into a chat.** Spotify defines the Client ID as a Security Code in its [Developer Terms](https://developer.spotify.com/terms) (Sec. VI.1.a), and Sec. VI.1.c–d forbids disclosing it. Anything you type into a conversation is retained by the model provider, written to shell history, and carried in the agent's context window. The Client ID is the only credential this server needs, and it is a *Security Code* rather than a public identifier — treat it like a password.
>
> ```
> Set up the Spotify MCP server from https://github.com/NovaLux12/spotify-mcp-server.
>
> 1. Walk me through creating a Spotify app at https://developer.spotify.com/dashboard
>    with redirect URI http://127.0.0.1:8888/callback. Point me at where the dashboard
>    shows the Client ID, then stop — I will copy it myself.
> 2. Clone and build:
>    git clone https://github.com/NovaLux12/spotify-mcp-server.git
>    cd spotify-mcp-server && npm ci && npm run build
> 3. Show me which file my MCP host reads server environment from (the host's server
>    config, or a local .env — Node >=22.9 loads it via --env-file-if-exists) and
>    print the exact line to add. I will type the Client ID in myself. Do not ask me
>    for it and never echo it back.
> 4. Start the server and run the auth command yourself, then finish the browser login
>    when it opens. This server uses PKCE, so there is no client secret and no
>    credential to fetch beyond the Client ID.
> 5. Verify with the read-only spotify_doctor tool and report its rows.
> ```

---

## Why this one

| | |
|---|---|
| **Complete** | Playback, search, catalog, library, playlists, following, plus extras like duplicate cleanup, M3U/CSV import-export, podcast sessions, snapshot diffing, listening analytics, market checks, stats.fm taste imports, and taste composite briefs, playlists, and reports. |
| **Safe** | `dry_run` previews on writes, receipts that prove what landed, human confirmation for bulk deletes, and `READONLY` to hide write-capable modules. |
| **Honest** | No zombie tools for endpoints Spotify removed. Legacy lookups explain the 403 instead of crashing; registration-gated endpoints are listed below. |
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
- "What does my taste look like? Build a playlist from it"
- "Do my stats.fm lifetime genres match what I've played this month?"

## Configuration

All via env vars — no config file. Only `SPOTIFY_CLIENT_ID` is required.

| Variable | Example | Purpose |
|---|---|---|
| `SPOTIFY_MCP_TOOLSETS` | `playback,catalog` | Trim by group for hosts that cap tool counts; unset or `all` registers everything. |
| `SPOTIFY_MCP_READONLY` | `1` | Hide write-capable modules; read-only resources and prompts remain available. |
| `SPOTIFY_MCP_HISTORY` | `1` | Log mutations to JSONL for undo and audit. |
| `SPOTIFY_MCP_RECEIPTS` | `1` | Persist mutation receipts so `verify_receipt`/`undo_mutation` survive a restart. |

Full reference: [docs/configuration.md](docs/configuration.md)

`spotify_doctor` (CLI + in-server tool) diagnoses token state, scope gaps, Premium gating, rate-limit cooldowns, and request/quota usage (cumulative + rolling-window counts, #904) without extra setup.

## Upgrading to 2.0

2.0 is a contract release. One tool name is gone, four things moved, and one
guarantee tightened:

0. **`get_show_episodes` is removed.** Use `list_show_episodes` (same endpoint,
   same arguments, minus the drifted alias). It was the only name that changed;
   everything else in the 591-tool surface keeps its name.

1. **Destructive writes fail closed.** Any confirmation-gated bulk write now
   refuses when the client cannot elicit, instead of proceeding unprompted.
   `archive_played_episodes`'s `confirm: true` no longer authorises the delete
   (it is still accepted, and every result says it was ignored). For headless
   automation, set `SPOTIFY_MCP_CONFIRM=never` deliberately.
2. **Playlist set-operation inputs are canonical.** A/B pairs are
   `playlist_a`/`playlist_b`; ordered lists are `playlists`;
   `playlist_subtract` takes the base as `base_playlist_id`. The old spellings
   are still accepted through **2.0** and removed in **2.1**; a result that used
   one carries `deprecated_inputs` and a `deprecation_note`. Each tool accepts
   only its own aliases, so send the one its schema declares rather than the
   whole list below — SPEC.md's table maps every tool to its exact aliases:

   These are **per-tool** aliases, not a bundle — each tool declares exactly one
   pair or one list, and the per-tool table in SPEC.md is the contract:

   | family | canonical | the alias that tool declares |
   |---|---|---|
   | A/B pair | `playlist_a`, `playlist_b` | `a`/`b`, or `playlist_id_a`/`playlist_id_b`, or `playlist_a_id`/`playlist_b_id` — one of them, per tool |
   | ordered list | `playlists` | `playlist_ids`, or `source_playlist_ids`, or `sources` — one of them, per tool |
   | subtraction | `base_playlist_id` + `playlists` | the positional form `playlists: [base, ...sources]` |

   Sending several at once is a `validation` error naming the conflict; a name
   the tool does not declare is an `unknown_param` error.
3. **Numeric caps have canonical names.** `max_results` caps what is returned;
   `limit` and `scan_cap` cap how much of each source is read.
4. **Unknown arguments are rejected** with a typed `unknown_param` error rather
   than ignored, so a renamed parameter fails loudly instead of silently
   doing nothing.

Run `spotify_doctor` after upgrading: it reports the registered surface, the
gates that hid modules, and the granted scopes in one call.

## Docs

- [SPEC.md](SPEC.md) — every tool, resource & prompt
- [ARCHITECTURE.md](ARCHITECTURE.md) — how it's built
- [docs/configuration.md](docs/configuration.md) — all env vars
- [docs/schema-budgets.md](docs/schema-budgets.md) — per-module schema budgets and registration order
- [docs/statsfm.md](docs/statsfm.md) — stats.fm second source: setup, tool cheat sheet, gotchas
- [docs/cookbook.md](docs/cookbook.md) — ten copy-paste agent recipes
- [docs/taste.md](docs/taste.md) — anonymized taste showcase driving a playlist
- [docs/wave2-composites.md](docs/wave2-composites.md) — read-only taste composites
- [docs/distribution.md](docs/distribution.md) — distribution and release notes
- [docs/faq.md](docs/faq.md) — auth, Premium, 403s, headless, tokens
- [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup & conventions
- [CHANGELOG.md](CHANGELOG.md) — release history

## Requirements

- **Premium** for playback control (play/pause/skip/seek/volume/queue). Free accounts can still use search, library & playlists.
- Node 22.9+, Spotify app in dev mode (5 users until extended quota).
- Audiobooks gated by Spotify to US/UK/CA/IE/NZ/AU.
- A subset of endpoints is **registration-gated** — 403 on current app registrations regardless of scopes or Premium. See [Registration-gated endpoints](#registration-gated-endpoints).

### Registration-gated endpoints

Some Web API endpoints are denied **at the app-registration level**: on current Spotify app registrations they return `403 Forbidden` no matter which OAuth scopes you grant or whether the account is Premium. This is Spotify-side gating, not a misconfiguration on your end. Verified by live probe on 2026-08-27 ([#329](https://github.com/NovaLux12/spotify-mcp-server/issues/329)):

| Response | Endpoints |
|---|---|
| `403 Forbidden` | `/browse/new-releases`, `/browse/categories` (and `/browse/categories/{id}/playlists`), `/markets`, `/artists/{id}/top-tracks`, `/users/{id}` (and `/users/{id}/playlists`), every documented `/me/{type}/contains` check (tracks, albums, shows, episodes, audiobooks, following), `/playlists/{id}/followers/contains` |
| `404 Not Found` | `/recommendations`, `/recommendations/available-genre-seeds` |
| `410 Gone` | `/me/apps`, `/me/chapters` |

Notes:

- Tools wrapping a gated endpoint are **not hidden** — they still work on legacy app registrations where Spotify granted the endpoint. On a newer registration you'll get the server's plain-English 403 explanation instead of a crash.
- The undocumented `/me/library/contains` check is *not* gated (it returned 200 on the same probe) and powers the duplicate-cleanup tooling.
- Legacy lookups the server already explains gracefully (audio-features, audio-analysis, related-artists, featured-playlists) also probe as 403; their tools say so in the error message.

<details><summary>Troubleshooting</summary>

- **"Not authenticated"** → re-run `auth`; check `~/.spotify-mcp/tokens.json` exists and the redirect URI matches exactly (no trailing slash).
- **Auth loop / S256 error** → open a private window, log into spotify.com first, then retry the auth URL there.
- **Port in use (8888)** → free the port, set `SPOTIFY_REDIRECT_URI` to another port, or use `SPOTIFY_HEADLESS=1`.
- **"Premium required"** on playback → expected on Free accounts; no workaround.
- **`Forbidden` on lookup tools** (categories, markets, top-tracks, user profiles, library `contains` checks) → these endpoints are registration-gated by Spotify; see [Registration-gated endpoints](#registration-gated-endpoints).
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
