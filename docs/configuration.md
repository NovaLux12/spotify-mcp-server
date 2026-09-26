# Configuration reference

The variables below are read at the documented call sites; set them in your MCP host config, command line, or `.env` (loaded by `npm run dev` on Node 22.9+). There is no unified environment registry or config file.

## Summary

| Variable | Default | Purpose |
| --- | --- | --- |
| `SPOTIFY_CLIENT_ID` | none (required) | OAuth Client ID of your Spotify app; used for login and token refresh. |
| `SPOTIFY_REDIRECT_URI` | `http://127.0.0.1:8888/callback` | OAuth redirect URI; must match your Spotify app settings exactly. |
| `SPOTIFY_MCP_TOKEN_FILE` | `~/.spotify-mcp/tokens.json` | Persistent token cache (written with mode 600). Explicit path wins over profile and default. |
| `SPOTIFY_MCP_PROFILE` | unset | Profile name for `~/.spotify-mcp/tokens.<profile>.json`; `auth --profile <name>` is the CLI equivalent. |
| `SPOTIFY_SCOPES` | unset (17 default scopes) | Space- or comma-separated OAuth scopes to request; unknown scopes fail startup. |
| `SPOTIFY_MCP_MARKET` | unset (account country) | Default ISO 3166-1 alpha-2 market for market-gated lookups; explicit tool argument wins. |
| `SPOTIFY_HEADLESS` | unset | `1`, `true`, `yes`, or `on` enables browserless paste-flow authentication. |
| `SPOTIFY_REQUEST_TIMEOUT_MS` | `30000` | Per-request timeout for Spotify API calls and token refresh. |
| `SPOTIFY_MCP_MAX_ITEMS` | `50` | Default per-call item cap for list tools; `max_results` overrides per call. |
| `SPOTIFY_MCP_FETCH_ALL_CAP` | `500` | Hard cap for `fetch_all=true` pagination walks. |
| `SPOTIFY_MCP_HISTORY` | unset | `1`, `true`, `yes`, or `on` logs one JSONL line per agent-driven mutation. |
| `SPOTIFY_MCP_HISTORY_DIR` | `~/.spotify-mcp/history` | Directory containing `mutations.jsonl`. |
| `SPOTIFY_MCP_TOOLSETS` | unset (all) | Comma-separated toolsets to register. `all`, empty, or unset registers everything. |
| `SPOTIFY_MCP_ENABLE_TOOLS` | unset | Comma-separated registration-key overrides forced on. |
| `SPOTIFY_MCP_DISABLE_TOOLS` | unset | Comma-separated registration-key overrides forced off; disable wins over enable. |
| `SPOTIFY_MCP_READONLY` | unset | `1`, `true`, `yes`, or `on` (case-insensitive, trimmed) hides Spotify-mutating registration modules. One parser backs this flag, the `spotify_doctor` report, the `whats_new` annotations and the freshness-watermark hold, so they cannot disagree. Read-only modules, resources, and prompts remain subject to their normal gates. |
| `SPOTIFY_MCP_CONFIRM` | unset | `never` is the only explicit bypass for confirmation-gated destructive operations; callers that require confirmation otherwise fail closed when the client cannot elicit. |
| `SPOTIFY_MCP_FRESHNESS_STATE` | `~/.spotify-mcp/freshness.json` | Watermark file powering `whats_new` with `since: "last-check"`. |
| `SPOTIFY_MCP_FRESHNESS_BUDGET` | `25` | Per-call budget for `whats_new` artist and show lookups. |
| `SPOTIFY_MCP_SCENES_FILE` | `~/.spotify-mcp/scenes.json` | Playback scene sidecar. |
| `SPOTIFY_MCP_GENRE_TAGS_FILE` | `~/.spotify-mcp/genre-tags.json` | Artist-to-genre-tags sidecar. |
| `SPOTIFY_MCP_DATA_DIR` | `~/.spotify-mcp` for watchlists; `~/.spotify-mcp/playlist-snapshots` for playlist-health snapshots | Data directory read by the artist-watchlist, portability-watchlist, and playlist-health call sites. The watchlist default no longer depends on the process working directory. |
| `SPOTIFY_MCP_BACKUP_DIR` | `~/.spotify-mcp/backups` | Directory for `backup_library` snapshots. |
| `SPOTIFY_MCP_PORTABILITY_DIR` | `~/.spotify-mcp/portability` | Output root for the five `export_*` family tools. |
| `SPOTIFY_MCP_EXPORT_DIR` | `~/.spotify-mcp/exports` | Output root for `export_playlist` and `export_profile_state`. |
| `SPOTIFY_MCP_ALLOW_PATHS` | unset | Extra directories `import_playlist` may read from, `:`-separated. The default read roots are `SPOTIFY_MCP_PORTABILITY_DIR`, `SPOTIFY_MCP_BACKUP_DIR` and `SPOTIFY_MCP_EXPORT_DIR`. |
| `SPOTIFY_MCP_MAX_DOCUMENT_MB` | `32` | Per-document read cap. A larger `input_path` or inline `content` is refused before it is read. |
| `SPOTIFY_MCP_RECEIPTS` | unset | `1`, `true`, `yes`, or `on` persists mutation receipts to a JSONL file so `verify_receipt` and `undo_*` survive a restart. Entries older than 24h are dropped. |
| `SPOTIFY_MCP_TIMEZONE` | `UTC` | IANA zone for `listening_heatmap` day/hour buckets. Host time is never used implicitly; the same payload is produced in every host zone. |
| `SPOTIFY_MCP_PORTABILITY_DIR` | `~/.spotify-mcp/portability` | Default output directory for library/history portability exports. |
| `SPOTIFY_MCP_SNAPSHOT_DIR` | `~/.spotify-mcp/playlist-snapshots` | Playlist snapshot sidecar directory. |
| `SPOTIFY_MCP_SEARCH_HISTORY_FILE` | `~/.spotify-mcp/search-history.json` | Local search-history sidecar. |
| `SPOTIFY_MCP_PLAYBACKEXT_FILE` | `~/.spotify-mcp/playback-ext.json` | Playback extension sidecar. |
| `SPOTIFY_MCP_EXHAUST2_PLAYBACK_FILE` | `~/.spotify-mcp/exhaust2-playback.json` | Playback helper sidecar. |
| `SPOTIFY_MCP_EXHAUST2_MISC_FILE` | `~/.spotify-mcp/exhaust2-misc.json` | Miscellaneous helper sidecar. |


## Details

### Auth and OAuth

`SPOTIFY_CLIENT_ID` is required for `auth` and normal server operation because the client refreshes expired tokens. Create an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard). The server uses PKCE, so a client secret is never required.

`SPOTIFY_REDIRECT_URI` must match a redirect URI configured in the app character for character. The callback listener derives its loopback bind address, port, and route from this value. Use `http://127.0.0.1` for local development, not `http://localhost`.

`SPOTIFY_MCP_TOKEN_FILE` and `SPOTIFY_MCP_PROFILE` select the persistent token file. Explicit `SPOTIFY_MCP_TOKEN_FILE` wins; otherwise a profile uses `~/.spotify-mcp/tokens.<profile>.json`; the unprofiled default is `~/.spotify-mcp/tokens.json`. Token files are created with mode 600.

### Local files: reads and writes are confined

Every tool that writes a local file resolves its destination against a configured root — `SPOTIFY_MCP_EXPORT_DIR` for `export_playlist` and `export_profile_state`, `SPOTIFY_MCP_PORTABILITY_DIR` for the five `export_*` family tools. A relative `output_path` or `output_dir` resolves **inside** that root rather than against the process working directory; an absolute path outside it, a `..` escape, or a symlink leaving it is refused with the resolved path and the root in the message. `export_playlist` also refuses to replace an existing file unless you pass `overwrite: true`.

Reads are confined the same way, in reverse. `import_playlist` will read only from `SPOTIFY_MCP_PORTABILITY_DIR`, `SPOTIFY_MCP_BACKUP_DIR`, `SPOTIFY_MCP_EXPORT_DIR`, and anything you add to `SPOTIFY_MCP_ALLOW_PATHS`. Anything else, any non-regular file (directory, FIFO, socket, device), and any document over `SPOTIFY_MCP_MAX_DOCUMENT_MB` is refused before a byte is read.

Containment is decided on the *real* path — every component is resolved before the root comparison, so a symlink is collapsed rather than string-matched. Files are written with mode 600 and `O_NOFOLLOW`.

`SPOTIFY_HEADLESS=1` affects only the `auth` command. The auth URL is printed for a browserless host; complete it anywhere and paste the redirect URL back.

`SPOTIFY_SCOPES` accepts spaces or commas and rejects unknown scope names. When unset, the default scopes in `src/config.ts` are requested. `SPOTIFY_MCP_MARKET` accepts a two-letter ISO 3166-1 alpha-2 code; invalid values are ignored with a warning, and an explicit tool `market` argument takes precedence.

### Runtime limits and requests

`SPOTIFY_REQUEST_TIMEOUT_MS` applies an abort timer to every outbound Spotify request and token refresh. `SPOTIFY_MCP_MAX_ITEMS` sets the default list truncation cap; a call can still pass its own `max_results`. `SPOTIFY_MCP_FETCH_ALL_CAP` bounds `fetch_all=true` pagination and related scan walks; page explicitly with `limit`/`offset` when the cap is reached.

### Mutation history

Set `SPOTIFY_MCP_HISTORY=1` to append one JSONL record per agent-driven mutation. `SPOTIFY_MCP_HISTORY_DIR` changes the directory; the file is `mutations.jsonl`. Records contain only the mutation method, path, and receipt/snapshot metadata — never tokens or request bodies.

### Toolsets and registration keys

`SPOTIFY_MCP_TOOLSETS` accepts a comma-separated subset of these toolsets, or `all`/empty/unset for the full surface:

`core`, `playback`, `playbackintel`, `catalog`, `playlists`, `library`, `personalization`, `statsfm`, `portability`, `taste`, `discovery`, `resources`, and `prompts`.

`SPOTIFY_MCP_ENABLE_TOOLS` and `SPOTIFY_MCP_DISABLE_TOOLS` take registration keys, not individual tool names. The complete key list is:

`search`, `playback`, `playlists`, `playlistbatch`, `playlistmisc`, `library`, `following`, `users`, `portability`, `statsfm`, `swarm3meta`, `queueops`, `playbackext`, `playbackintel`, `exhaust2playback`, `swarm3playback`, `catalog`, `audiobooks`, `browse`, `artistwatch`, `searchhistory`, `exhaust2catalog`, `exhaust2enggating`, `swarm3discovery`, `swarm3bdiscovery`, `swarm3shows`, `swarm3refs`, `playlisthealth`, `exhaust2playlists`, `exhaust2extra`, `swarm3playlistops`, `swarm3snapshots`, `swarm4playlists`, `libraryanalytics`, `episodemgmt`, `exhaust2misc`, `swarm3library`, `personalization`, `swarm3analytics`, `taste`, `tastecomposites`, `resources`, and `prompts`.

`disable` wins over `enable`, and both are layered on top of set membership. Unknown keys are reported and ignored. `spotify_doctor` and the discovery metadata tools remain available independently of the trim.

An unknown-only toolset spec fails startup with the valid set names. A mixed known+unknown spec starts normally and reports the ignored names.

### Read-only and confirmation safety

`SPOTIFY_MCP_READONLY=1` (also `true`, `yes` or `on`; case-insensitive, surrounding whitespace ignored) prevents registration of Spotify-mutating modules such as playback and scenes, playlist and library mutations, following, users, audiobooks, and destructive helpers. It does **not** imply that every remaining tool is side-effect-free: local-only tools such as the taste feedback store remain available. It also does not bypass the independent toolset, registration-key, or scope gates. Read-only resources and prompts remain available when their own gates permit.

For confirmation-gated destructive operations, a missing MCP elicitation capability produces an `unsupported` result. Callers that require confirmation must treat that result as refusal; they proceed without prompting only when `SPOTIFY_MCP_CONFIRM=never` explicitly selects the automation bypass. A declined prompt or elicitation failure also fails closed.

### Freshness and local sidecars

`SPOTIFY_MCP_FRESHNESS_STATE` is the `whats_new` watermark. `SPOTIFY_MCP_FRESHNESS_BUDGET` limits artist album and show episode lookups; `max_artists` or the relevant per-call argument overrides it for one call. A truncated or quota-hit scan holds the watermark so a later `since: "last-check"` does not skip unseen items. The saved-show radar uses this same freshness budget.

`SPOTIFY_MCP_SCENES_FILE` stores named device/volume/shuffle/repeat/context presets. `SPOTIFY_MCP_GENRE_TAGS_FILE` stores user-declared artist genre tags. `SPOTIFY_MCP_SEARCH_HISTORY_FILE`, `SPOTIFY_MCP_PLAYBACKEXT_FILE`, `SPOTIFY_MCP_EXHAUST2_PLAYBACK_FILE`, and `SPOTIFY_MCP_EXHAUST2_MISC_FILE` override their respective local sidecars.

`SPOTIFY_MCP_DATA_DIR` is read directly by the artist-watchlist, portability-watchlist, and playlist-health paths; there is no shared configuration object behind the variable. Without it, the watchlist call sites use `~/.spotify-mcp/artist-watchlist.json` and playlist-health uses `~/.spotify-mcp/playlist-snapshots`; a pre-v2 `./data/artist-watchlist.json` is read once and migrated to the new location on the next write. `SPOTIFY_MCP_SNAPSHOT_DIR` separately controls the swarm3 playlist-snapshot sidecar. `SPOTIFY_MCP_BACKUP_DIR` and `SPOTIFY_MCP_PORTABILITY_DIR` control backup and export destinations.

## Registration-gated endpoints

Some Spotify Web API endpoints are denied at the app-registration level: on current app registrations they return `403 Forbidden` regardless of the OAuth scopes granted or the account's subscription tier. Verified by live probe on 2026-08-27 ([#329](https://github.com/NovaLux12/spotify-mcp-server/issues/329)):

| Response | Endpoints |
|---|---|
| `403 Forbidden` | `/browse/new-releases`, `/browse/categories` (and `/browse/categories/{id}/playlists`), `/markets`, `/artists/{id}/top-tracks`, `/users/{id}` (and `/users/{id}/playlists`), every documented `/me/{type}/contains` check (tracks, albums, shows, episodes, audiobooks, following), `/playlists/{id}/followers/contains` |
| `404 Not Found` | `/recommendations`, `/recommendations/available-genre-seeds` |
| `410 Gone` | `/me/apps`, `/me/chapters` |

Tools wrapping these endpoints remain exposed for legacy registrations and return a plain-English 403 explanation on current registrations. The undocumented `/me/library/contains` check is not gated and powers duplicate-cleanup tooling. Batch lookup and top-tracks tools are wrapped, but registration-gated families are listed above rather than described as generally available.

## Not used

`SPOTIFY_CLIENT_SECRET` is deliberately not supported: the PKCE flow proves the app's identity without a secret, so there is nothing to leak.
