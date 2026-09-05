# FAQ

Short answers to the failures people actually hit. Deepest reference first: `doctor` (CLI) / `spotify_doctor` (tool) diagnoses most of these without extra setup.

## Auth loop / S256 error

**Symptom:** the browser bounces back to login, or the callback complains about code-challenge / S256.

**Fix:**

1. Open a private window, log into [spotify.com](https://spotify.com) there first, then retry the auth URL in that same window. Stale Spotify sessions cause most loops.
2. Check the Redirect URI in your Spotify app settings matches **character for character**: `http://127.0.0.1:8888/callback` — no trailing slash, `http` not `https`, `127.0.0.1` not `localhost`.
3. If you changed the port via `SPOTIFY_REDIRECT_URI`, the app settings must carry the same override.

Still looping? Run `npx -y @novalux12/spotify-mcp@latest doctor` and read the token-state section.

## Port 8888 already in use

**Symptom:** auth's callback listener can't bind.

**Fix (pick one):**

- Free the port: stop the other listener (common culprits: a second auth attempt, dev servers).
- Move the callback: set `SPOTIFY_REDIRECT_URI=http://127.0.0.1:9000/callback` **and** add that exact URI to your Spotify app settings.
- Skip the listener entirely: `SPOTIFY_HEADLESS=1` uses the paste flow (see [Headless](#headless--remote-hosts)).

## Premium gating

**Symptom:** `Player command failed: Premium required` on play/pause/skip/seek/volume/queue.

**Answer:** expected on Free accounts — Spotify reserves playback control for Premium. There is no workaround and no flag that lifts it. Search, library, playlists, personalization, podcasts, and stats.fm tools all work on Free; only transport control needs Premium.

## Registration-gated endpoints (403 table)

**Symptom:** `403 Forbidden` on lookup tools even with all scopes granted and Premium active.

**Answer:** Spotify denies some endpoints **at the app-registration level** — current registrations get 403 no matter the scopes or subscription. Verified by live probe 2026-08-27. The server's tools stay exposed (legacy registrations may still have access) and return a plain-English explanation instead of crashing.

| Response | Endpoints |
|---|---|
| `403 Forbidden` | `/browse/new-releases`, `/browse/categories` (and `/browse/categories/{id}/playlists`), `/markets`, `/artists/{id}/top-tracks`, `/users/{id}` (and `/users/{id}/playlists`), every documented `/me/{type}/contains` check, `/playlists/{id}/followers/contains` |
| `404 Not Found` | `/recommendations`, `/recommendations/available-genre-seeds` |
| `410 Gone` | `/me/apps`, `/me/chapters` |

Not gated: the undocumented `/me/library/contains` check (powers duplicate cleanup) and the stats.fm surface, which is a separate upstream.

## Headless / remote hosts

**Symptom:** no browser on the machine running the server (VM, container, CI, agent runtime).

**Fix:** the paste flow.

```bash
SPOTIFY_HEADLESS=1 SPOTIFY_CLIENT_ID=your_client_id_here npx -y @novalux12/spotify-mcp@latest auth
```

It prints a URL — open it on any machine with a browser, approve, and paste the resulting redirect URL back into the prompt. Runtime tool calls are unaffected afterwards.

## Token paths

**Symptom:** "Not authenticated", multi-account confusion, read-only filesystems.

**Facts:**

- Default token file: `~/.spotify-mcp/tokens.json` (mode 600). Override with `SPOTIFY_MCP_TOKEN_FILE`.
- Multi-account: `SPOTIFY_MCP_PROFILE=<name>` (or `auth --profile <name>`) stores `tokens.<name>.json` sidecars. Precedence: `SPOTIFY_MCP_TOKEN_FILE` > `SPOTIFY_MCP_PROFILE` > default.
- "Not authenticated" almost always means: tokens file missing (re-run `auth`), wrong profile selected, or redirect URI mismatch at auth time.
- Ephemeral home directories (containers): mount a volume and point `SPOTIFY_MCP_TOKEN_FILE` at it, or auth expires with the container.

## stats.fm questions

**Do I need Premium for stats.fm tools?** No. They read stats.fm, not Spotify playback — Free accounts work.

**Lifetime stats look empty.** The history import hasn't completed. Run `statsfm_history_status`; see [stats.fm setup](statsfm.md#setup).

**Can I query someone else's profile?** Public profiles: yes, by user ID. Private profiles: no — aggregates and streams stay hidden by design. See [Privacy](statsfm.md#privacy).

**stats.fm and Spotify numbers disagree.** Different counters, different windows — stats.fm counts its imported stream log; Spotify endpoints count their own windows. See [Gotchas](statsfm.md#gotchas).

## See also

- [Configuration](configuration.md) — every environment variable
- [stats.fm second source](statsfm.md) — the full stats.fm guide
- [Cookbook](cookbook.md) — recipes that put the answers into practice
