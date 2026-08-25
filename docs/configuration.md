# Configuration reference

Every environment variable read by `@novalux12/spotify-mcp`, with defaults and
examples. Set them in your MCP host config, on the command line before the
binary, or in a local `.env` file (picked up automatically by `npm run dev`
on Node 22.9+).

## Summary

| Variable | Default | Purpose |
| --- | --- | --- |
| `SPOTIFY_CLIENT_ID` | none (required) | OAuth Client ID of your Spotify app; used for login and token refresh. |
| `SPOTIFY_REDIRECT_URI` | `http://127.0.0.1:8888/callback` | OAuth redirect URI; must match your Spotify app settings exactly. |
| `SPOTIFY_MCP_TOKEN_FILE` | `~/.spotify-mcp/tokens.json` | Path of the persistent token cache (written with mode 600). |
| `SPOTIFY_HEADLESS` | unset | Set to `1` to use the browserless paste-flow authentication. |
| `SPOTIFY_REQUEST_TIMEOUT_MS` | `30000` | Per-request HTTP timeout in ms for every API call and token refresh. |
| `SPOTIFY_MCP_MAX_ITEMS` | `50` | Default per-call item cap for list-type tools; `max_results` overrides per call. |
| `SPOTIFY_MCP_FETCH_ALL_CAP` | `500` | Hard cap on `fetch_all=true` pagination walks. |
| `SPOTIFY_MCP_HISTORY` | unset | Set to `1` to log one JSONL line per agent-driven mutation. |
| `SPOTIFY_MCP_HISTORY_DIR` | `~/.spotify-mcp/history` | Directory holding the mutation JSONL log (`mutations.jsonl`). |

## Details

### `SPOTIFY_CLIENT_ID`

Required for both `auth` and normal server operation (refreshing expired
tokens). Get it from [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
after creating an app. This server uses the PKCE flow, so a client secret is
never required.

```bash
export SPOTIFY_CLIENT_ID=your_client_id_here
```

```json
"env": { "SPOTIFY_CLIENT_ID": "your_client_id_here" }
```

### `SPOTIFY_REDIRECT_URI`

Overrides the redirect URL sent to Spotify during authentication. It must
match a Redirect URI configured in your Spotify app settings character for
character — Spotify rejects the login otherwise.

The local callback listener derives its bind port and route path from this
value (default `http://127.0.0.1:8888/callback`), so an override such as
`http://127.0.0.1:9000/callback` is honored end-to-end. The host must be a
loopback address (`localhost`, `127.0.0.0/8` or `::1`) — the callback server
binds loopback only, and Spotify requires loopback redirect URIs for
native-app flows. Whatever you set here must also match your Spotify app
settings character for character.

### `SPOTIFY_MCP_TOKEN_FILE`

Where access and refresh tokens are persisted after a successful auth flow.
The file is created with mode 600 and refreshed in place by the client, so
you only authenticate once per account. Override it when running multiple
accounts side by side or when the home directory is read-only or ephemeral
(mount a volume elsewhere and point this at it).

```bash
SPOTIFY_MCP_TOKEN_FILE=/var/lib/spotify-mcp/tokens.json npx -y @novalux12/spotify-mcp@latest
```

### `SPOTIFY_HEADLESS`

Set to `1` to switch authentication to the paste flow for hosts without a
browser (cloud VMs, Docker containers, CI runners): instead of opening a
browser and listening on the callback port, the auth URL is printed to stdout;
complete it in any browser on any machine, then paste the resulting redirect
URL back into the prompt.

Only affects the `auth` command; runtime tool calls are unaffected.

```bash
SPOTIFY_HEADLESS=1 SPOTIFY_CLIENT_ID=your_client_id_here \
  npx -y @novalux12/spotify-mcp@latest auth
```

### `SPOTIFY_REQUEST_TIMEOUT_MS`

Every outbound HTTP request — Spotify API calls and token refreshes alike —
carries an abort timer so a hung connection cannot stall the server's
serialized request queue forever. Raise it on slow links or VPNs:

```bash
SPOTIFY_REQUEST_TIMEOUT_MS=60000
```

### `SPOTIFY_MCP_MAX_ITEMS`

Default per-call cap applied by list-type tools before truncation. A tool
call can still pass an explicit `max_results` argument to override it for
that single call; this variable changes the default for the whole process.

### `SPOTIFY_MCP_FETCH_ALL_CAP`

When a library/playlist listing is called with `fetch_all=true`, the walk of
every page stops here. This protects against runaway loops over very large
libraries; beyond the cap, page explicitly with `limit`/`offset`. Also caps
the saved-library resources (`spotify://me/saved/*`).

### `SPOTIFY_MCP_HISTORY`

Opt-in audit trail: when set to `1`, every agent-driven mutation (playlist
create/add/remove/reorder, library saves, follows) appends one JSON line
recording method, path and `snapshot_id` to `mutations.jsonl` under the
history directory. Only whitelisted fields are written — tokens and request
bodies never reach the file.

### `SPOTIFY_MCP_HISTORY_DIR`

Overrides where the mutation JSONL lives (default `~/.spotify-mcp/history`,
file `mutations.jsonl`). Point it at a persistent volume in containers.

## Not used

`SPOTIFY_CLIENT_SECRET` is deliberately not supported: the PKCE flow proves
the app's identity without a secret, so there is nothing to leak.
