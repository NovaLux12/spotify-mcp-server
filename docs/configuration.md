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

Note that the local callback listener always binds `127.0.0.1:8888`
(hardcoded in the browser flow), so this value should normally stay at the
default `http://127.0.0.1:8888/callback`. Changing the port does not move the
listener — Spotify would then redirect your browser to a port nothing is
listening on and authentication would hang.

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

## Not used

`SPOTIFY_CLIENT_SECRET` is deliberately not supported: the PKCE flow proves
the app's identity without a secret, so there is nothing to leak.
