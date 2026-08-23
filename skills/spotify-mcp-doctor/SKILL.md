---
name: spotify-mcp-doctor
description: Diagnose and repair NovaLux12/spotify-mcp-server failures — auth, permissions, devices, rate limits, OpenClaw wiring. Use when Spotify tool calls fail or setup stalls.
---

# Spotify MCP Doctor

You are diagnosing a failing Spotify MCP server installation
(NovaLux12/spotify-mcp-server). Work top-down through these probes; stop at
the first red flag, apply its fix, then re-run from the top. Never modify
files under the user's `~/.spotify-mcp/` beyond what a fix requires.

## Probe 1 — Is the server wired up?

Check the host config (OpenClaw: `mcp.servers.spotify` in
`~/.openclaw/openclaw.json`; Claude Desktop: `claude_desktop_config.json`).

- `command` must point at the built entry (`dist/index.js`) of THIS repo,
  run with plain `node`.
- `env.SPOTIFY_CLIENT_ID` must be set (16-hex app id from the dashboard).
- No `SPOTIFY_CLIENT_SECRET` is needed anywhere — this server uses PKCE.
  If a secret is configured it is ignored, not harmful.

Fix: point the entry at the repo checkout and restart the host (OpenClaw:
restart the gateway process). Re-test.

## Probe 2 — Does the binary answer?

```bash
cd <repo> && node --env-file=.env dist/index.js &   # then send stdin line:
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"doctor","version":"0"}}}
```

Expect one JSON line back naming `serverInfo.name: "spotify-mcp"`. If the
process exits instantly: run `npm run build` (missing `dist/`) and check
Node ≥ 20 (`node --version`).

## Probe 3 — App credentials valid? (no user login needed)

```bash
node --input-type=module -e "
const id=process.env.SPOTIFY_CLIENT_ID;
const r=await fetch('https://api.spotify.com/v1/search?q=test&type=track&limit=1');
console.log('unauthed probe:', r.status);"
```

Then exchange a client-credentials grant (needs the dashboard secret):

```
POST https://accounts.spotify.com/api/token
Authorization: Basic base64(client_id:client_secret)
body: grant_type=client_credentials
```

- **200** → app is healthy; continue to Probe 4.
- **400 invalid_client** → wrong id/secret pair; check the dashboard.
- Network refused → egress/proxy problem, not Spotify.

With that token, `GET /v1/search?q=test&type=track` must return JSON with
`tracks.items`. This also confirms the app can reach the current API shape
(response keys are `items`, not `tracks` — old servers crash here).

## Probe 4 — Account tokens present and fresh?

Token file: `$SPOTIFY_MCP_TOKEN_FILE` or `~/.spotify-mcp/tokens.json`.

- Missing → run the auth flow: `SPOTIFY_CLIENT_ID=<id> npm run auth`
  (add `SPOTIFY_HEADLESS=1` on hosts without a browser).
- Present but every call returns **401 invalid_grant / refresh fails**
  → the refresh token died (password change, app removed, >1yr idle).
  Re-run auth. Delete the stale file only as a last resort.
- File perms must be 600. Warn if wider.

## Error catalogue

| Symptom | Cause | Fix |
|---|---|---|
| `INVALID_CLIENT: Invalid redirect URI` | Dashboard redirect ≠ `http://127.0.0.1:8888/callback` exactly (no trailing slash) | Fix in dashboard, retry auth |
| Auth page says client invalid but ID looks right | Account not in app's **User Management** (dev mode) | Dashboard → User Management → add the account |
| Playback tools fail, search works | Free account | Playback control needs Premium — no workaround via Web API |
| `403 Forbidden` on recommendations/audio-features/related-artists/featured-playlists | Spotify removed these for new apps (Nov 2024+) | Not fixable — this server intentionally omits them; don't reinstall servers that expose them |
| Audiobook tools 404/403 | Market gating | Only US, UK, CA, IE, NZ, AU accounts; pass `market` explicitly |
| `429` responses | Rate limit | Server auto-waits per `Retry-After`; if persistent, space out bulk calls |
| `503` | Spotify outage | Wait; check status.spotify.com |
| Port 8888 busy during auth | Stale listener | Kill it or set `SPOTIFY_REDIRECT_URI=http://127.0.0.1:<other>/callback` (+ matching dashboard entry) |

## Probe 5 — Live end-to-end through the host

After fixes, call a read-only tool through the actual MCP connection
(`get_me` is ideal — proves auth + scope + transport in one shot). In
OpenClaw, restart the gateway first so the new env/config is picked up;
a running server caches its token file handle state in memory.

## Escalation

If all probes pass individually but the host still fails, capture the
host's stderr for the server process and the exact failing tool name +
arguments before escalating to the repo issues page.
