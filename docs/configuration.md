# Configuration reference

Every environment variable read by `@novalux12/spotify-mcp` — set in your MCP host config, on the command line, or in `.env` (picked up by `npm run dev` on Node 22.9+).

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
| `SPOTIFY_MCP_TOOLSETS` | unset (all) | Comma-separated toolsets to register: `playback`, `catalog`, `library`, `personalization`, `playlists`, `prompts`, `resources`; `all` or unset registers everything. |
| `SPOTIFY_MCP_ENABLE_TOOLS` | unset | Comma-separated module keys forced on top of the toolset trim (`disable` wins over `enable` wins over set membership). |
| `SPOTIFY_MCP_DISABLE_TOOLS` | unset | Comma-separated module keys forced off. |
| `SPOTIFY_MCP_FRESHNESS_STATE` | `~/.spotify-mcp/freshness.json` | Watermark file powering `whats_new`'s `since: 'last-check'`. |
| `SPOTIFY_MCP_FRESHNESS_BUDGET` | `25` | Per-call budget for `whats_new` artist/show lookups; `max_artists` overrides per call. |
| `SPOTIFY_MCP_SCENES_FILE` | `~/.spotify-mcp/scenes.json` | Location of the playback-scene sidecar written by the scene tools. |
| `SPOTIFY_MCP_GENRE_TAGS_FILE` | `~/.spotify-mcp/genre-tags.json` | Artist→genre-tags sidecar consumed by the library genre tools. |
| `SPOTIFY_MCP_READONLY` | unset | Set to `1`/`true`/`yes` to hide every write-capable module (plus resources and prompts) — reads and diagnostics stay available. |
| `SPOTIFY_MCP_CONFIRM` | unset | Set to `never` to skip the elicitation-gated confirmation on bulk destructive playlist operations. |

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

### `SPOTIFY_MCP_TOOLSETS`

Trims which modules register at startup for hosts that cap tool counts.
Toolsets are coarse groups: `playback`, `catalog` (search + catalog +
audiobooks), `library` (saved items + following), `personalization`,
`playlists` (playlist tools + user lookups + power ops), `prompts`,
`resources`. Unset, empty, or `all` registers everything.

```bash
SPOTIFY_MCP_TOOLSETS=playback,catalog npx -y @novalux12/spotify-mcp@latest
```

Unknown set names are reported on stderr and ignored.

### `SPOTIFY_MCP_ENABLE_TOOLS` / `SPOTIFY_MCP_DISABLE_TOOLS`

Fine-grained overrides layered on top of the toolset trim. Both take
comma-separated **module keys** — the registration units, not individual
tool names: `playback`, `search`, `catalog`, `audiobooks`,
`personalization`, `library`, `following`, `playlists`, `users`,
`resources`, `prompts`.

Newer modules ride their parent key rather than adding new ones: `listening_report` under `personalization`, scenes/wind-down under `playback`, `search_deep` under `search`, the audiobook copilot under `audiobooks`, freshness under `following`, merge/diff/overlap/DNA under `playlists`, and library hygiene/genre insights/podcast sessions/receipts under `library`. `spotify_doctor` is unconditional — it always registers so diagnostics survive any trim.

Precedence is `disable` > `enable` > set membership:

```bash
# library set plus the following module even though it lives in another set
SPOTIFY_MCP_TOOLSETS=library SPOTIFY_MCP_ENABLE_TOOLS=following

# hide every playlist module everywhere
SPOTIFY_MCP_DISABLE_TOOLS=playlists
```

Unknown keys are reported on stderr and ignored. Scope-aware hiding applies
after both: a write module whose scopes you never granted stays hidden no
matter what these variables say.

### `SPOTIFY_MCP_FRESHNESS_BUDGET`

Per-call budget for `whats_new` artist album and show episode lookups —
how many `GET /artists/{id}/albums` / `GET /shows/{id}/episodes` requests
the walk will make before truncating and reporting the remainder. Default
`25`; override per call with `max_artists`. The walk is capped at
`min(SPOTIFY_MCP_FETCH_ALL_CAP, freshness budget)`. `N` followed artists
means `N+1` API requests (1 follow page + N lookups); a large library can
exhaust small dev-account quotas in one call — use `dry_run` first to
preview the cost and keep the budget small. On mid-walk `429
QUOTA_EXCEEDED` the tool returns partial results with `quota_hit: true`
and `Retry-After` instead of a bare error. When truncation or a quota hit
occurs the watermark is held (not advanced) so the next
`since: 'last-check'` does not permanently skip unreached releases.

### `SPOTIFY_MCP_FRESHNESS_STATE`

Watermark file used by the `whats_new` tool so `since: 'last-check'`
resolves without you tracking dates. After a successful non-truncated,
non-quota-hit run the watermark advances to today (UTC); truncated or
quota-hit scans hold the watermark so the next `since: 'last-check'` does
not permanently skip unreached releases (see `watermark_advanced` /
`watermark_held` in the response). Override the default path when running
multiple accounts side by side.

### `SPOTIFY_MCP_SCENES_FILE`

The playback-scene sidecar (`save_scene` / `list_scenes` / `delete_scene` /
`apply_scene`) stores named device/volume/shuffle/repeat/context presets
here. The file never holds credentials — just playback preferences — but is
kept owner-only (0600 file, 0700 dir) like the token cache. Missing or
corrupt files yield an empty store.

### `SPOTIFY_MCP_GENRE_TAGS_FILE`

Artist→genre-tags sidecar in the shape
`{ "version": 1, "tags": { "<Artist Name>": ["pop", "indie"] } }`.
`tag_management` writes it; `library_genre_report` and `filter_by_genre`
read it. Lookups are case-insensitive; the first-seen artist-name spelling
wins.

### `SPOTIFY_MCP_READONLY`

Set to `1`, `true`, or `yes` (case-insensitive) for a hard read-only guarantee:
every write-capable module is hidden from the tool list at startup — playback
and scenes, playlists and their power ops, library saves plus insights/sessions/
receipt verification, following, users, audiobooks — along with resources and
prompts. Search, catalog, personalization reads, and `spotify_doctor` remain
available. Unlike scope-aware hiding, which depends on what you granted at auth
time, this hides modules regardless of granted scopes.

```bash
SPOTIFY_MCP_READONLY=1 npx -y @novalux12/spotify-mcp@latest
```

### `SPOTIFY_MCP_CONFIRM`

Bulk-destructive playlist operations ask the human operator to confirm via MCP
elicitation before executing: `remove_from_playlist` at 10 or more URIs and
`replace_playlist_items` at 50 or more. The prompt only fires when the
connected client advertised elicitation support; set `SPOTIFY_MCP_CONFIRM=never`
to skip prompting entirely so automation and readonly contexts are never blocked.

```bash
SPOTIFY_MCP_CONFIRM=never npx -y @novalux12/spotify-mcp@latest
```

## Not used

`SPOTIFY_CLIENT_SECRET` is deliberately not supported: the PKCE flow proves
the app's identity without a secret, so there is nothing to leak.
