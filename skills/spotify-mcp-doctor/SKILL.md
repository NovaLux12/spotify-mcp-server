---
name: spotify-mcp-doctor
description: Diagnose and repair NovaLux12/spotify-mcp-server failures — auth, permissions, devices, rate limits, OpenClaw wiring. Use when Spotify tool calls fail or setup stalls.
---

# Spotify MCP Doctor

Diagnose a failing Spotify MCP server installation
(NovaLux12/spotify-mcp-server). Work top-down through these probes; stop at
the first red flag, apply its fix, then re-run from the top. Never modify
files under the user's `~/.spotify-mcp/` beyond what a fix requires.

## Probe 0 — Diagnose inside the MCP host

This probe requires only the active MCP connection: no shell, repository, or
local build. It is the first probe for OpenClaw and other host-only agents.

1. Call `spotify_doctor` with `verbose: true`.
2. Call `toolset_report` on the same connection.
3. Interpret the live rows rather than assuming the configuration:
   - `token` / `token_refresh`: missing, unreadable, or corrupt tokens are
     failures; an expired access token with a refresh token is a warning
     because the next API call refreshes it; a missing refresh token requires
     re-authentication.
   - `scopes`: compare the granted scopes with write capabilities in the
     active toolsets. Re-authenticate when the report names a gap.
   - `account` / `account_premium`: distinguish Free-account playback limits
     from transport or auth failures.
   - `rate_limit`: respect an active cooldown and its `Retry-After` value.
   - `config`: use the reported token path and fetch/shaping caps; do not
     substitute a guessed path.
4. Use `toolset_report.structuredContent.registered_tools` as the live
   registered-tool count. Use its active toolsets/modules to explain why a
   tool is missing; a toolset trim is different from a registration failure.

`spotify_doctor` is registered unconditionally outside toolset trimming. If the
connection works but `spotify_doctor` is absent, the host is connected to an
older or different server; continue with the wiring and process probes.

If the MCP connection itself is unavailable, ask the user for the next
command's output and continue as a coordinator. Do not claim that a shell
probe ran when you only have an MCP host.

## Probe 1 — Is the server wired up?

Ask the user to inspect the MCP server entry in their host configuration. For
OpenClaw, inspect the Spotify MCP server entry; for Claude Desktop, inspect
`claude_desktop_config.json`. Never ask them to paste a client secret or token.

- A published-package entry should run
  `npx -y @novalux12/spotify-mcp@latest` (the README's current setup).
- A checkout entry may run `npm start` or
  `node --env-file-if-exists=.env dist/index.js` after `npm run build`.
- `env.SPOTIFY_CLIENT_ID` must be set to the dashboard app's client ID.
- `SPOTIFY_CLIENT_SECRET` is not used by this PKCE server. If one is present in
  configuration, remove it unless another process needs it.

Fix the entry or environment, restart the host, and re-test through MCP.

## Probe 2 — Does the entry answer initialize?

If the user has a checkout, the current package commands are:

```bash
npm run build
node --env-file-if-exists=.env dist/index.js
```

`npm start` is the equivalent package-script form. If `.env` is absent, Node
continues with the host environment instead of failing while loading the file.
Then send this newline-delimited JSON-RPC line to the process's stdin:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"doctor","version":"0"}}}
```

Expect one JSON response whose `result.serverInfo.name` is `spotify-mcp`.
If the entry cannot find `dist/index.js`, run `npm run build`; if it exits
before initialize, check Node `>=22.9` with `node --version` and read stderr.

No shell access: ask the user to paste the host's Spotify MCP entry (with
secrets redacted), Node version, and server stderr. Do not ask them for access
tokens.

## Probe 3 — Can the host reach Spotify without user auth?

The unauthenticated probe should return **401**. That is the expected result
and proves an HTTPS request reached Spotify's API; it does not validate the
app's client ID.

```bash
node --input-type=module -e "const r = await fetch('https://api.spotify.com/v1/search?q=test&type=track&limit=1'); console.log('unauthed probe:', r.status)"
```

A network error is an egress/proxy problem. To validate a dashboard app
credential pair independently of user PKCE auth, exchange a client-credentials
grant:

```text
POST https://accounts.spotify.com/api/token
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
```

- **200**: the app credentials work. Use the returned bearer token for a
  read-only `GET /v1/search?q=test&type=track`; a valid result has
  `tracks.items`.
- **400 invalid_client**: check the dashboard ID/secret pair.
- **401 on the unauthenticated search** without a bearer token: expected.

No shell access: ask the user to run only the unauthenticated Node probe, or
skip this optional credential check and rely on the authenticated `get_me`
probe. The in-server doctor is the primary path.

## Probe 4 — Are account tokens present and fresh?

The effective token file is shown in the doctor `config` row. It defaults to
`~/.spotify-mcp/tokens.json` and can be changed by `SPOTIFY_MCP_TOKEN_FILE` or
profile selection.

- Missing, corrupt, or unreadable: run
  `SPOTIFY_CLIENT_ID=<id> npm run auth` in a checkout, or
  `SPOTIFY_CLIENT_ID=<id> npx -y @novalux12/spotify-mcp@latest auth` for an
  installed/published entry. Add `SPOTIFY_HEADLESS=1` when no browser can open
  on that machine.
- Access token expired with a refresh token: let the next API call refresh it;
  use the doctor report to verify the outcome.
- Refresh rejected (`invalid_grant`): re-run auth. Delete or rename the stale
  token file only as a last resort.
- File permissions should be `600`; warn if the token file is group- or
  world-readable.

No shell access: use Probe 0's token rows and ask the user to run
`npx -y @novalux12/spotify-mcp@latest doctor` only if the in-server rows cannot
be obtained. Never ask them to paste token JSON.

## Error catalogue

| Symptom | Cause | Fix |
|---|---|---|
| `INVALID_CLIENT: Invalid redirect URI` | Dashboard redirect differs from the configured callback | Match `SPOTIFY_REDIRECT_URI` character-for-character in the dashboard; the default is `http://127.0.0.1:8888/callback` |
| Auth page says client invalid but ID looks right | Account is not allowed to use a development-mode app | Dashboard → User Management → add the account |
| Playback tools fail, search works | Free account | Playback control needs Premium; there is no Web API workaround |
| `403 Forbidden` on a registration-gated or removed family | Spotify app registration or current API restrictions | Read the tool's error; do not add a phantom endpoint or reinstall around it |
| Audiobook tools 403/404 | Market or app-registration gating | Use an explicit supported market; check Spotify's error and `docs/faq.md` |
| `429` responses | Rate limit | Honor `Retry-After`; the client waits and retries with backoff |
| `503` | Spotify service unavailable | Wait and retry; check Spotify status |
| Port 8888 busy during auth | Callback listener conflict | Stop the stale listener or set a loopback `SPOTIFY_REDIRECT_URI` and add the exact same URI to the dashboard |

## Probe 5 — Live end-to-end through the host

After fixes, call the read-only `get_me` tool through the actual MCP
connection. It proves transport, token refresh, and read scopes together.
Restart the host first when its config or environment changed so it starts a
new server process.

## Escalation

If all probes pass individually but the host still fails, capture the host's
server stderr, the exact failing tool name and arguments, and the relevant
doctor/toolset rows before escalating. Redact tokens, client secrets, and
authorization headers.
