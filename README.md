# SpotifyMCP

[![CI](https://github.com/NovaLux12/spotify-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/NovaLux12/spotify-mcp-server/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@novalux12/spotify-mcp)](https://www.npmjs.com/package/@novalux12/spotify-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22.9-brightgreen)

Spotify Web API MCP: playback, library, playlists, search, podcasts. Not affiliated with Spotify.

A broad Spotify Web API tool surface, plus extras most servers skip. Registration-gated wrappers are explained rather than hidden; see [Registration-gated endpoints](#registration-gated-endpoints) for the generated list.

**What you get by default, and what to do about the rest.** A server started with no environment registers a curated surface — search, playback, playlists, library, following — sized so the tool list does not dominate the context window before you have typed anything. `SPOTIFY_MCP_TOOLSETS=all` registers the entire registry instead, and the stats.fm tools are opt-in with `SPOTIFY_MCP_STATSFM=1`. Both are one line in [docs/configuration.md](docs/configuration.md#toolsets-and-registration-keys).

<!-- BEGIN:generated surface-census -->
A server started with no `SPOTIFY_MCP_TOOLSETS` registers **128 tools** (141,637 bytes of schema) — the curated default surface (#889). `SPOTIFY_MCP_TOOLSETS=all` registers all **570 tools**, along with **17 fixed resources**, **47 resource templates**, and **14 prompts**. Toolsets and production gates can trim a configured host further; both figures describe a real production `tools/list` after finalizers.
<!-- END:generated surface-census -->

### 🚧 3.0 is landing

**3.0 is the release where the open issue list goes to zero** — every epic, every
issue under it, every contradiction we turned up auditing ourselves. Most of that
backlog was never "bugs" in the crashing sense; it was places where this server
reported a value it had not actually checked, which is the only kind of wrong
that is genuinely dangerous.

It also *removes* tools, because Spotify deleted the endpoints underneath them in
February 2026 — including artist follows, which have no migration target at all.

→ **[Read the 3.0 roadmap](docs/v3-roadmap.md)**

---

> ### 🤖 Paste this to your agent
>
> Copy the block below into Claude Code, Cursor, OpenClaw, or any coding agent — it will set SpotifyMCP up for you.
>
> ⚠️ **Never paste your Spotify credentials into a chat.** Spotify's [Developer Terms](https://developer.spotify.com/terms) treat the Client ID as a credential: §VI.1.1 groups "I.D.s, client I.D.s, keys, passwords, security codes, or tokens" together as *Security Codes*, §VI.1.3 forbids disclosing them to any other party, and §VI.1.4 makes you responsible for their confidentiality. Anything you type into a conversation is retained by the model provider, written to shell history, and carried in the agent's context window. The Client ID is the only credential this server needs, and it is a *Security Code* rather than a public identifier — treat it like a password.
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
> 3. Show me which file my MCP host reads server environment from. The host's server
>    config is the one that always works; a local .env is read only when you launch
>    through this repo's npm run dev or npm start, which pass --env-file-if-exists
>    on Node >=22.9 — the published binary does not read it. Print the exact line to
>    add. I will type the Client ID in myself. Do not ask me for it and never echo
>    it back.
> 4. Start the server and run the auth command yourself, then finish the browser login
>    when it opens. This server uses PKCE, so there is no client secret and no
>    credential to fetch beyond the Client ID.
> 5. Verify with the read-only spotify_doctor tool and report its rows.
> ```

---

## Why this one

| | |
|---|---|
| **Complete** | Playback, search, catalog, library, playlists, following, plus extras like duplicate cleanup, M3U/CSV import-export, podcast sessions, snapshot diffing, listening analytics, market checks, stats.fm taste reads, and taste composite briefs, playlists, and reports. |
| **Safe** | `dry_run` previews on writes, receipts that prove what landed, human confirmation for bulk deletes, and `READONLY` to hide write-capable modules. |
| **Honest about the surface** | Tools that turn your listening history into derived metrics — hourly histograms, weekday profiles, discovery ratios — are off unless you ask for them with `SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS=1`, because Spotify's Developer Policy Sec. III.13 prohibits building derived listenership metrics. The rest of the analytics surface, which re-presents your own data, is always on. See [docs/compliance.md](docs/compliance.md#derived-listening-analytics-the-policy-and-the-interpretation). |
| **Honest** | No tool claims to work when it cannot. Gated endpoints keep their wrappers, read replacements where one exists, and explain the 403 in plain English instead of crashing — see [Registration-gated endpoints](#registration-gated-endpoints), generated from `src/gating.ts`. |
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
| `SPOTIFY_MCP_TOOLSETS` | `all` | Trim by group for hosts that cap tool counts. Unset registers the curated default surface; `all` registers everything. |
| `SPOTIFY_MCP_STATSFM` | `1` | Register the 49 stats.fm tools. Off by default — they need a separate stats.fm username. |
| `SPOTIFY_MCP_READONLY` | `1` | Hide write-capable modules; read-only resources and prompts remain available. |
| `SPOTIFY_MCP_HISTORY` | `1` | Log mutations to JSONL for undo and audit. |
| `SPOTIFY_MCP_RECEIPTS` | `1` | Persist mutation receipts so `verify_receipt`/`undo_mutation` survive a restart. |

Full reference: [docs/configuration.md](docs/configuration.md)

`spotify_doctor` (CLI + in-server tool) diagnoses token state, scope gaps, Premium gating, rate-limit cooldowns, request/quota usage (cumulative + rolling-window counts, #904), and read-cache pressure (entries held, bytes retained, responses too large to cache, #894) without extra setup.

## Upgrading to 2.0

2.0 is a contract release. One tool name is gone, four things moved, and one
guarantee tightened:

0. **`get_show_episodes` is removed.** Use `list_show_episodes` (same endpoint,
   same arguments, minus the drifted alias). It was the only name that changed;
   everything else in the surface keeps its name. The exact registry totals are
   generated at the top of this file, so this sentence deliberately carries no
   count of its own to fall behind.

1. **Destructive writes fail closed.** Any confirmation-gated bulk write now
   refuses when the client cannot elicit, instead of proceeding unprompted.
   `archive_played_episodes`'s `confirm: true` no longer authorises the delete
   (it is still accepted, and every result says it was ignored). For headless
   automation, set `SPOTIFY_MCP_CONFIRM=never` deliberately.
2. **Playlist set-operation inputs are canonical.** A/B pairs are
   `playlist_a`/`playlist_b`; ordered lists are `playlists`;
   `playlist_subtract` takes the base as `base_playlist_id`. This was the 2.0
   contract; the old spellings it was allowed to keep alongside it were
   withdrawn in **3.0** (#1287). They are no longer in any tool's schema, and a
   call that still sends one is refused before any Spotify request with a
   `validation` error whose `reason` is `retired_input`, naming both what was
   sent and what to send instead. Each tool declared exactly one alias pair or
   one alias list, so the table below is a per-tool migration map rather than a
   bundle:

   | family | canonical | the spelling that tool used to declare |
   |---|---|---|
   | A/B pair | `playlist_a`, `playlist_b` | `a`/`b`, or `playlist_id_a`/`playlist_id_b`, or `playlist_a_id`/`playlist_b_id` — one of them, per tool |
   | ordered list | `playlists` | `playlist_ids`, or `source_playlist_ids`, or `sources` — one of them, per tool |
   | subtraction | `base_playlist_id` + `playlists` | `subtract_playlist_ids`, or the positional form `playlists: [base, ...sources]` — one of them, per tool |

   `base_playlist_id` is required again: with the positional form gone there is
   no longer a base for a caller to omit. A name the tool does not declare, and
   is not a retired spelling, is an `unknown_param` error — a different claim
   from `retired_input`, which says the server published that name until 3.0.
3. **Numeric caps have canonical names.** `max_results` caps what is returned;
   `limit` and `scan_cap` cap how much of each source is read.
4. **Unknown arguments are rejected** with a typed `unknown_param` error rather
   than ignored, so a renamed parameter fails loudly instead of silently
   doing nothing.

Run `spotify_doctor` after upgrading: it reports the registered surface, the
gates that hid modules, and the granted scopes in one call.

## Docs

- [docs/v3-roadmap.md](docs/v3-roadmap.md) — **what's coming in 3.0**, and the one bug underneath all of it
- [SPEC.md](SPEC.md) — every tool, resource & prompt
- [ARCHITECTURE.md](ARCHITECTURE.md) — how it's built
- [docs/configuration.md](docs/configuration.md) — all env vars
- [docs/schema-budgets.md](docs/schema-budgets.md) — per-module schema budgets and registration order
- [docs/statsfm.md](docs/statsfm.md) — stats.fm second source: setup, tool cheat sheet, gotchas
- [docs/cookbook.md](docs/cookbook.md) — copy-paste agent recipes
- [docs/non-goals.md](docs/non-goals.md) — what v2 will not do, why, and what it offers instead
- [docs/taste.md](docs/taste.md) — anonymized taste showcase driving a playlist
- [docs/wave2-composites.md](docs/wave2-composites.md) — read-only taste composites
- [docs/distribution.md](docs/distribution.md) — distribution and release notes
- [docs/faq.md](docs/faq.md) — auth, Premium, 403s, headless, tokens
- [docs/compliance.md](docs/compliance.md) — brand marks, attribution & the outbound `User-Agent`
- [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup & conventions
- [CHANGELOG.md](CHANGELOG.md) — release history

## Requirements

- **Premium** for playback control (play/pause/skip/seek/volume/queue). Free accounts can still use search, library & playlists.
- Node 22.9+, Spotify app in dev mode (5 users until extended quota).
- Audiobooks gated by Spotify to US/UK/CA/IE/NZ/AU.
- A subset of endpoints is **registration-gated** — 403 on current app registrations regardless of scopes or Premium. Whether a grandfathered registration still answers `200` is **unverified** (#1338). This is a property of your app registration, not of the tool. See [Registration-gated endpoints](#registration-gated-endpoints).

### Registration-gated endpoints

Some Web API endpoints are denied **at the app-registration level**: on current Spotify app registrations they return `403 Forbidden` no matter which OAuth scopes you grant or whether the account is Premium. This is Spotify-side gating, not a misconfiguration on your end.

**Nothing here is simply "removed".** Three sources describe this class and they do not agree, which is why the table below states the runtime behaviour instead of a verdict:

- Spotify's [February 2026 changelog](https://developer.spotify.com/documentation/web-api/references/changes/february-2026) marks a batch of operations `[REMOVED]`.
- The [live OpenAPI schema](https://developer.spotify.com/reference/web-api/open-api-schema.yaml) still publishes most of those same paths, carrying `deprecated: true` rather than deleting them — `/artists/{id}/top-tracks` and all seven `Get Several` batch paths among them.
- The runtime truth is neither document: it is what **your** app registration is allowed to read. A registration without the grant answers `403`/`404`/`410`. Whether a grandfathered registration still answers `200` is **unverified** (#1338): no probe in this repository shows it, and the one probe artefact that was once cited for it records `403` on every such path.

So a 403 here is a property of the registration, not of the tool. No tool is hidden for being gated, no gated tool is a zombie: each one either reads a documented replacement and answers, or makes the call and explains the 403 in plain English. The authoritative list is the `GATED_FAMILIES` array in [`src/gating.ts`](src/gating.ts) — `GATED_PATH_PATTERNS` is derived from it, so the classifier and this table cannot drift apart.

<!-- BEGIN:generated gated-endpoints -->
| Endpoint family | Shipped tools that call it | On a current registration |
|---|---|---|
| `browse-categories` — `/browse/categories*` (list, `{id}`, `{id}/playlists`) | `get_category`, `browse_category_deepdive`, `category_resolver` | 403 explained |
| `browse-new-releases` — `/browse/new-releases` | *(none — no shipped tool reads this path)* | Replaced; no call site |
| `markets` — `/markets` | `get_available_markets`, `market_validate` | 403 explained |
| `artist-top-tracks` — `/artists/{id}/top-tracks` | `get_artist_top_tracks`, `queue_playlist`, `artist_collab_network`, `artist_completeness_score`, `batch_add_to_playlist`, `copy_playlist`, `move_items_between_playlists` | 403 explained |
| `user-profile` — `/users/{id}` and `/users/{id}/playlists` | `get_user_profile`, `get_user_playlists_by_id`, `get_playlist_followers` | 403 explained |
| `me-type-contains` — the documented `/me/{type}/contains` checks (tracks, albums, shows, episodes, audiobooks, following) | *(none — migrated to `GET /me/library/contains`)* | Replaced; no call site |
| `playlist-followers-contains` — `/playlists/{id}/followers/contains` | *(none — migrated to `GET /me/library/contains`)* | Replaced; no call site |
| `batch-several` — the multi-id `?ids=` batch endpoints (`/tracks`, `/albums`, `/artists`, `/episodes`, `/shows`, `/audiobooks`, `/chapters`) | `get_several_tracks`, `get_several_albums`, `get_several_artists`, `get_several_episodes`, `get_several_shows`, `get_several_audiobooks`, `get_several_chapters`, `catalog_batch_lookup` | Replaced with per-id reads |

All 8 families above are operations Spotify's February 2026 changelog marks `[REMOVED]`.
<!-- END:generated gated-endpoints -->

Confirm the list yourself against the source of truth:

```bash
grep -n "id: '" src/gating.ts        # the families, with tools and fallback per row
```

Notes:

- A family in that list is a runtime **classifier**, not a promise that a tool calls it. Three families (`browse-new-releases`, `me-type-contains`, `playlist-followers-contains`) have no live call site left — the tools that used them were migrated onto replacements — and their patterns are retained so a future caller is still covered by the 403 contract rather than silently losing it.
- `GET /me/library/contains` is **not** gated (it returned 200 on the same probe) and backs the saved-state reads behind `check_playlist_following`, `restore_library_snapshot` and receipt verification. The `contains` families above are the *documented* per-type checks, which the changelog marks removed in favour of this one. (The playlist duplicate-cleanup tools are not in that set — they page `/playlists/{id}/items`.)
- **Batch fallback ([#725](https://github.com/NovaLux12/spotify-mcp-server/issues/725)).** When a `Get Several` batch endpoint answers 403, `fetchSeveral` retries through per-id `GET /<kind>/{id}` calls on the client's existing queue/backoff. Per-id paths are not in the gated class, so the read still succeeds. The response carries `degraded: true` and a `[degraded: batch endpoint returned 403; … fetched individually]` footer in prose, plus `degraded_reason` in `structuredContent`, so a caller can tell a per-item round-trip from a clean batch read.
- Endpoints Spotify lists as removed that this server does **not** wrap at all (no shipped tool, so nothing to explain): `/recommendations`, `/recommendations/available-genre-seeds`, `/me/apps`, `/me/chapters`, the `/artists/{id}/related-artists`, `/audio-features`, `/audio-analysis` and `/browse/featured-playlists` reads, and the `/playlists/{id}/tracks` family (superseded by `/playlists/{id}/items`). These are absent from the table above because absence of a tool is the honest answer for them — there is no 403 to explain.

<details><summary>Troubleshooting</summary>

- **"Not authenticated"** → re-run `auth`; check `~/.spotify-mcp/tokens.json` exists and the redirect URI matches exactly (no trailing slash).
- **Auth loop / S256 error** → open a private window, log into spotify.com first, then retry the auth URL there.
- **Port in use (8888)** → free the port, set `SPOTIFY_REDIRECT_URI` to another port, or use `SPOTIFY_HEADLESS=1`. The message names `EADDRINUSE` and the port because the usual cause is a previous `auth` still holding it.
- **Timed out waiting for the browser callback** → not a port conflict; the listener bound and has been closed. Retry, and check the redirect URI is registered exactly. Bound it with `SPOTIFY_AUTH_TIMEOUT_MS` (default 5 min).
- **"Premium required"** on playback → expected on Free accounts; no workaround.
- **`Forbidden` on lookup tools** (categories, markets, top-tracks, user profiles, the per-type `contains` checks) → these endpoints are registration-gated by Spotify; see [Registration-gated endpoints](#registration-gated-endpoints). (`GET /me/library/contains` is *not* one of them, so a 403 there is a real problem, not a gated registration.)
- **Still stuck?** `npx -y @novalux12/spotify-mcp@latest doctor` or ask your agent to run the [spotify-mcp-doctor skill](skills/spotify-mcp-doctor/SKILL.md).

</details>

### What this server is not

v2 has a written non-goals list, so a request for something outside it gets an
answer rather than a maybe. Each entry below carries its reasoning in
[SPEC §1](SPEC.md#1-goals--non-goals), and
[docs/non-goals.md](docs/non-goals.md) is the record behind both: what each one
rules out, the source it rests on, and what the server offers instead.

- Audio streaming, audio analysis, and offline playback
- A web UI, a dashboard, or an MCP UI surface
- Multi-tenant or hosted operation
- Sharing one user's credentials across users
- Lyrics
- The Spotify Connect SDK and native client integration
- Voice control
- Training a model on Spotify data, or exporting derived profiles
- A second third-party upstream, ad-tech, or monetization egress
- Working around Spotify's own controls

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
