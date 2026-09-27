# Configuration reference

The variables below are read at the documented call sites; set them in your MCP host config, command line, or `.env` (loaded by `npm run dev` on Node 22.9+). There is no unified environment registry or config file.

## Summary

| Variable | Default | Purpose |
| --- | --- | --- |
| `SPOTIFY_CLIENT_ID` | none (required) | OAuth Client ID of your Spotify app; used for login and token refresh. |
| `SPOTIFY_REDIRECT_URI` | `http://127.0.0.1:8888/callback` | OAuth redirect URI; must match your Spotify app settings exactly. |
| `SPOTIFY_MCP_TOKEN_FILE` | `~/.spotify-mcp/tokens.json` | Persistent token cache (written with mode 600). Explicit path wins over profile and default. |
| `SPOTIFY_MCP_PROFILE` | unset | Profile name for `~/.spotify-mcp/tokens.<profile>.json`; `--profile <name>` is the CLI equivalent, and it applies to the WHOLE invocation — `spotify-mcp --profile work` (server), `spotify-mcp auth --profile work`, `spotify-mcp doctor --profile work` and `spotify-mcp logout --profile work` all act on that account. An explicit `--profile` outranks this variable. Every per-account store resolves through one function, so a named profile cannot leave the token file, the refresh guard, the persisted read cache, or the doctor pointing at the default account's files (#609). The CLI flag rejects an empty or missing name instead of falling back to the default token file. |
| `SPOTIFY_MCP_ACCOUNTS_FILE` | `~/.spotify-mcp/accounts.json` | The account registry added in #602: which local accounts exist, and which one a session is acting as. Read by `list_accounts`; written by `switch_account` alone. `spotify-mcp auth --profile <name>` creates the token file a profile is named by, and does not register the account — a freshly-authenticated profile reaches this file when something switches to it. Owner-only (0600) and written atomically, like the token files. **It never contains token material** — an entry is an `account_id`, a profile name, a label and the PATH of the token file, and the listing a tool returns is projected through a type that has no field able to hold one. A file that is not valid JSON is refused rather than overwritten. |
| `SPOTIFY_SCOPES` | unset (the `core` profile, 11 scopes) | Space- or comma-separated OAuth scopes to request; a profile name (`read`, `core`, `write`, `full`) is also accepted. Unknown scopes fail startup, and so does a value that is set but names no scope. |
| `SPOTIFY_MCP_SCOPE_PROFILE` | unset (`core`) | Which scope profile `auth` requests: `read`, `core`, `write` or `full`. `core` asks for reads plus playback control and **no** library / playlist / follow writes, so a read-only user is not consented to mutation on first login. Ignored when `SPOTIFY_SCOPES` or `--scopes` names an explicit list. An unknown name fails startup rather than falling back. |
| `SPOTIFY_MCP_MARKET` | unset (no market applied) | Default ISO 3166-1 alpha-2 market for market-gated lookups. Precedence: the tool's `market` argument, then this variable, then the account country when `GET /me` still carries one. Spotify removed `country` from `GET /me` in its February 2026 changes, so on a current registration nothing supplies a default and the result reports `market_source: "none"`. |
| `SPOTIFY_HEADLESS` | unset | `1`, `true`, `yes`, or `on` enables browserless paste-flow authentication. |
| `SPOTIFY_AUTH_TIMEOUT_MS` | `300000` | How long the browser flow waits for the OAuth callback before giving up and closing the listener. |
| `SPOTIFY_REQUEST_TIMEOUT_MS` | `30000` | Per-request timeout for Spotify API calls and token refresh. |
| `SPOTIFY_MCP_TRANSPORT` | `stdio` | `http` serves the same server over MCP Streamable HTTP instead of stdio. Opt-in and unchanged by default: with the variable unset, the process reads none of the other `SPOTIFY_MCP_HTTP_*` variables. An unrecognised value is a startup error, never a silent fall back to stdio. |
| `SPOTIFY_MCP_HTTP_TOKEN` | none (required for `SPOTIFY_MCP_TRANSPORT=http`) | The bearer token the HTTP endpoint requires. There is no default and no anonymous mode. At least 16 printable-ASCII characters with no spaces. Mutually exclusive with `SPOTIFY_MCP_HTTP_TOKEN_FILE`; setting both is a startup error. |
| `SPOTIFY_MCP_HTTP_TOKEN_FILE` | unset | Read the HTTP bearer token from a file instead, so the secret is not in the process environment. One trailing newline is trimmed. The file is warned about (not refused) if it is group- or other-readable. |
| `SPOTIFY_MCP_HTTP_BIND` | `127.0.0.1` | HTTP listen address. A non-loopback value is **refused** unless `SPOTIFY_MCP_HTTP_ALLOW_NON_LOOPBACK` is also set — two settings, so a typo cannot publish the server. `0.0.0.0` and `::` are not loopback. |
| `SPOTIFY_MCP_HTTP_PORT` | `9871` | HTTP listen port. Not 8888: that is the OAuth callback redirect's. `0` binds a kernel-assigned port and prints it in the startup line. |
| `SPOTIFY_MCP_HTTP_PATH` | `/mcp` | Path the MCP endpoint is served on. Any other path is a 404, so an unauthenticated caller cannot walk paths to find one that skips the credential check. |
| `SPOTIFY_MCP_HTTP_MAX_BODY_BYTES` | `1048576` | Ceiling on one HTTP request body. Counted on the stream, so a chunked body that declares no length is bounded too. |
| `SPOTIFY_MCP_HTTP_RATE_LIMIT` | `600` | Requests per minute per client address. Applied **before** authentication, so guessing the token is throttled rather than being an unlimited oracle. |
| `SPOTIFY_MCP_HTTP_MAX_SESSIONS` | `8` | Live HTTP sessions allowed at once; past it a new session gets a 503. Each session holds its own tool registry, so this is a memory bound rather than a throughput claim. |
| `SPOTIFY_MCP_HTTP_ALLOW_NON_LOOPBACK` | unset | The second, separate opt-in required before `SPOTIFY_MCP_HTTP_BIND` may name a non-loopback address. Setting it alone changes nothing: the bind stays loopback. |
| `SPOTIFY_MCP_MAX_ITEMS` | `50` | Default per-call item cap for list tools; `max_results` overrides per call. |
| `SPOTIFY_MCP_FETCH_ALL_CAP` | `500` | Hard cap for `fetch_all=true` pagination walks. |
| `SPOTIFY_MCP_HISTORY` | unset | `1`, `true`, `yes`, or `on` logs one JSONL line per agent-driven mutation. |
| `SPOTIFY_MCP_HISTORY_DIR` | `~/.spotify-mcp/history` | Directory containing `mutations.jsonl`. |
| `SPOTIFY_MCP_HISTORY_MAX_BYTES` | `1048576` | Size in **bytes** at which `mutations.jsonl` rotates to `mutations.jsonl.1`. Only consulted when `SPOTIFY_MCP_HISTORY` is on. Unset, non-numeric, zero, and negative values fall back to the default rather than disabling rotation. Exactly one generation is kept, so the ledger on disk never exceeds twice this, and `spotify_doctor` reports the live and archive sizes against the cap plus the record count. |
| `SPOTIFY_MCP_HISTORY_MAX_ROWS` | `5000` | Records retained across the whole mutation ledger, live file plus its rotated generation. Bytes bound the file; this bounds how many dated records it holds, which is the number a user asking "how much of my history is still here" actually wants. There is no off value: unset, non-numeric, zero, and negative values fall back to the default, so a typo cannot make the ledger unbounded. |
| `SPOTIFY_MCP_HISTORY_RETENTION_DAYS` | `90` | How long a mutation record survives. Records older than the window are dropped oldest-first, on every append and once at startup, across every account's ledger. `0` disables age-based pruning entirely and leaves the row cap as the only bound; unset, non-numeric, and negative values fall back to the default, so an unusable value cannot expire the ledger. A record with no readable `ts` is never expired. `spotify-mcp logout` erases the ledger outright. |
| `SPOTIFY_MCP_RECEIPTS` | unset | `1`, `true`, `yes`, or `on` persists mutation receipts to `receipts.jsonl` so `verify_receipt` and `undo_mutation` survive a restart. Unset keeps them in process memory only, and every miss says so. |
| `SPOTIFY_MCP_RECEIPTS_DIR` | `~/.spotify-mcp` | Directory containing `receipts.jsonl`; falls back to `SPOTIFY_MCP_HISTORY_DIR` when unset. |
| `SPOTIFY_MCP_RECEIPTS_TTL_HOURS` | `24` | How long a persisted receipt stays resolvable; `0` disables expiry. The newest 100 receipts are kept either way, FIFO. |
| `SPOTIFY_MCP_TOOLSETS` | unset (`core,resources,prompts`) | Comma-separated toolsets to register. Unset or empty registers the curated default surface — `core`, plus resources and prompts. `all` registers everything. |
| `SPOTIFY_MCP_STATSFM` | unset | `1`, `true`, `yes`, or `on` registers the stats.fm families without naming them in `SPOTIFY_MCP_TOOLSETS`. They are off by default because they need a separate stats.fm username (`STATSFM_USER_ID`) and are of no use without one. `SPOTIFY_MCP_DISABLE_TOOLS` still wins over it. |
| `SPOTIFY_MCP_LEGACY_ALIASES` | unset | `1`, `true`, `yes`, or `on` still dispatches the `taste_*` tool names retired in v3.0 to their canonical `statsfm_*` handlers. Off by default; the retired names are never advertised in `tools/list`, so the compat window costs no schema bytes. Inert unless the `taste` toolset is registered. |
| `SPOTIFY_MCP_ENABLE_TOOLS` | unset | Comma-separated registration-key overrides forced on. |
| `SPOTIFY_MCP_DISABLE_TOOLS` | unset | Comma-separated registration-key overrides forced off; disable wins over enable. |
| `SPOTIFY_MCP_READONLY` | unset | `1`, `true`, `yes`, or `on` (case-insensitive, trimmed) hides Spotify-mutating registration modules. One parser backs this flag, the `spotify_doctor` report, the `whats_new` annotations and the freshness-watermark hold, so they cannot disagree. Read-only modules, resources, and prompts remain subject to their normal gates. |
| `SPOTIFY_MCP_CONFIRM` | unset | `never` is the only explicit bypass for confirmation-gated destructive operations; callers that require confirmation otherwise fail closed when the client cannot elicit. |
| `SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS` | unset (off) | `1`, `true`, `yes`, or `on` (case-insensitive, trimmed) registers the eleven **derived listening-analytics tools**; unset or any other value does not, and an unrecognised value also prints a stderr line naming the accepted spellings. Independent of `SPOTIFY_MCP_READONLY`: that one hides write-capable *modules*, this one hides individual read-only *tools* inside modules that stay active. See [Derived listening analytics](#derived-listening-analytics). |
| `SPOTIFY_MCP_FRESHNESS_STATE` | `~/.spotify-mcp/freshness.json` | Per-kind watermark file powering `whats_new` with `since: "last-check"`. Written by that tool, mode 0600. |
| `SPOTIFY_MCP_FRESHNESS_BUDGET` | `25` | Per-call budget for `whats_new` artist and show lookups. |
| `SPOTIFY_MCP_MAX_CONCURRENCY` | `3` | **The one concurrency knob**: the ceiling on Spotify requests in flight at once for the whole process. Every request passes through the funnel, including those a single tool fans out, so this is the width that applies everywhere. Starts are still paced a minimum 100 ms apart and still stop entirely during a `Retry-After` cooldown; `1` restores the strictly serial funnel. Clamped to 32 — a larger value is not honoured, so unbounded concurrency cannot be configured by accident. |
| `SPOTIFY_MCP_SHOWRADAR_BUDGET` | unset (falls back to `SPOTIFY_MCP_FRESHNESS_BUDGET`) | Per-call episode-lookup budget for `show_new_episodes` only. Takes precedence over the shared freshness budget; a `max_shows` argument still wins for one call. |
| `SPOTIFY_MCP_FANOUT_CONCURRENCY` | unset (falls back to `SPOTIFY_MCP_MAX_CONCURRENCY`, default `3`) | How many requests a freshness-radar fan-out keeps in flight at once: the per-show lookups in `show_new_episodes`, the per-artist album lookups in `check_artist_releases` and `artist_release_digest`, and the per-type walks in `search_deep`. Bounds burst size, not request count — the number of requests a scan makes is unchanged. `1` restores the old strictly-serial walk. Every affected payload reports the width it used as `fanout_concurrency` / `fanout_concurrency_source`. **Yields to `SPOTIFY_MCP_MAX_CONCURRENCY`**: that request-funnel knob (#892) takes precedence for these tools, so the two can never disagree about how much is in flight. |
| `SPOTIFY_MCP_SCENES_FILE` | `~/.spotify-mcp/scenes.json` | Playback scene sidecar. |
| `SPOTIFY_MCP_GENRE_TAGS_FILE` | `~/.spotify-mcp/genre-tags.json` | Artist-to-genre-tags sidecar. |
| `SPOTIFY_MCP_DATA_DIR` | `~/.spotify-mcp` for watchlists; `~/.spotify-mcp/playlist-snapshots` for playlist-health snapshots | Data directory read by the artist-watchlist, portability-watchlist, and playlist-health call sites, and by the persisted read cache when `SPOTIFY_MCP_CACHE_PERSIST` is on. The watchlist default no longer depends on the process working directory. |
| `SPOTIFY_MCP_CACHE_PERSIST` | unset (off) | Set to `1` to also persist the read cache to disk, so a host that restarts the server per session does not re-walk the same catalog. Only **resource identities** are written — tracks, albums, artists, shows, episodes, audiobooks, genres, and the public `/users/{id}` profile. **Your own data (`/me/*`), playlists, and everything below a public profile are never persisted** (`/users/{id}/top/artists`, and the stats.fm listening data that sits under the same path shape): a second process would serve them without ever having seen the mutation that changed them. The allowlist is keyed on the path *shape* and its depth, not on the root alone, so widening a resource's path cannot silently widen what is stored. Each entry keeps the expiry it had in memory and is re-checked on load, so persisting never extends an entry's life. The file is written owner-only (0600) and atomically, and named after the same profile as the token file (`cache.json`, or `cache.<profile>.json`) so two profiles never share one cache. A burst of reads is debounced into one write, so a short session can end before that write is due; the pending save is flushed when the process exits, is stopped by SIGINT/SIGTERM/SIGHUP/SIGQUIT, or throws, so a per-session host still persists what it read. What that does **not** cover, and what is done about it instead, is set out under [When a pending save is lost](#when-a-pending-save-is-lost). An entry too large for the remaining budget is skipped rather than truncating the file, and the count of skipped entries is reported by the doctor tool. Default off, because a cache that outlives the process can outlive the invalidation meant to govern it. |
| `SPOTIFY_MCP_BACKUP_DIR` | `~/.spotify-mcp/backups` | Directory for `backup_library` snapshots. |
| `SPOTIFY_MCP_BACKUP_RETENTION_DAYS` | `30` | Whole days a `backup_library` snapshot is kept before it is pruned. `0` disables pruning entirely. Any unusable value (empty, non-numeric, negative, fractional) falls back to the default, never to "keep forever"; the smallest enabled window is `1` day. |
| `SPOTIFY_MCP_EXPORT_DIR` | `~/.spotify-mcp/exports` | Output root for `export_playlist` and `export_profile_state`. |
| `SPOTIFY_MCP_PORTABILITY_DIR` | `~/.spotify-mcp/portability` | Default output directory for library/history portability exports; also the output root for the five `export_*` family tools. |
| `SPOTIFY_MCP_ALLOW_PATHS` | unset | Extra directories `import_playlist` may read from, `:`-separated. The default read roots are `SPOTIFY_MCP_PORTABILITY_DIR`, `SPOTIFY_MCP_BACKUP_DIR` and `SPOTIFY_MCP_EXPORT_DIR`. |
| `SPOTIFY_MCP_MAX_DOCUMENT_MB` | `32` | Per-document read cap. A larger `input_path` or inline `content` is refused before it is read. |
| `SPOTIFY_MCP_TIMEZONE` | `UTC` | IANA zone for the `listening_heatmap` day/hour buckets, which registers only under `SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS`. Host time is never used implicitly; the same payload is produced in every host zone. |
| `SPOTIFY_MCP_SNAPSHOT_DIR` | `~/.spotify-mcp/playlist-snapshots` | Playlist snapshot sidecar directory. |
| `SPOTIFY_MCP_SEARCH_HISTORY_FILE` | `~/.spotify-mcp/search-history.json` | Local search-history sidecar. |
| `SPOTIFY_MCP_SEARCH_HISTORY` | unset (enabled) | `0`, `false`, `no`, or `off` (case-insensitive, trimmed) stops the search-history tools from recording or replaying queries. Any other value, including unset, keeps history on. |
| `SPOTIFY_MCP_TASTE_FEEDBACK_FILE` | `<SPOTIFY_MCP_DATA_DIR>/taste-feedback.json` | Store for verdicts written by `statsfm_record_feedback`. The full path wins; otherwise the file is `taste-feedback.json` inside `SPOTIFY_MCP_DATA_DIR` (`~/.spotify-mcp`). Written at 0600, atomically (temp file, fsync, rename), and loaded through the shared sidecar policy in `src/sidecar.ts`: a missing file reads as an empty store, and a corrupt or truncated one is preserved at `<file>.corrupt[N]` and reported rather than reset. |
| `SPOTIFY_MCP_TASTE_FEEDBACK_MAX_ENTRIES` | `500` | Verdicts retained in the taste feedback store. Past this the oldest are evicted; the number dropped is persisted and reported, so a shrinking store never reads as an empty one. |
| `SPOTIFY_MCP_TASTE_FEEDBACK_MAX_BYTES` | `1048576` | Size cap for `taste-feedback.json`. Evicts oldest-first until the file fits, so raising `SPOTIFY_MCP_TASTE_FEEDBACK_MAX_ENTRIES` past what the byte cap allows cannot unbound the store. |
| `STATSFM_USER_ID` | unset (the per-call argument is required) | Default stats.fm user id or customId for the user-scoped stats.fm tools, so you need not pass one on every call. A per-call `user_id` or `statsfm_user` argument always wins. Blank and whitespace-only values count as unset. |
| `SPOTIFY_MCP_PLAYBACKEXT_FILE` | `~/.spotify-mcp/playback-ext.json` | Playback extension sidecar. |
| `SPOTIFY_MCP_EXHAUST2_PLAYBACK_FILE` | `~/.spotify-mcp/exhaust2-playback.json` | Playback helper sidecar. |
| `SPOTIFY_MCP_EXHAUST2_MISC_FILE` | `~/.spotify-mcp/exhaust2-misc.json` | Miscellaneous helper sidecar. |


## Details

### Auth and OAuth

`SPOTIFY_CLIENT_ID` is required for `auth` and normal server operation because the client refreshes expired tokens. Create an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard). The server uses PKCE, so a client secret is never required.

`SPOTIFY_REDIRECT_URI` must match a redirect URI configured in the app character for character. The callback listener derives its loopback bind address, port, and route from this value. Use `http://127.0.0.1` for local development, not `http://localhost`.

#### The callback wait is bounded, and its two failures read differently

`SPOTIFY_AUTH_TIMEOUT_MS` (default `300000`) bounds how long the browser flow waits for the OAuth redirect. The wait used to end only when a callback request arrived, so an abandoned flow — closed tab, dismissed consent screen, a redirect URI that was never registered — held the callback port until the process was killed, and the next attempt failed on a bare `listen EADDRINUSE` that never mentioned the run that was holding it. The bound is chosen to clear the time a person needs to log in and approve (roughly 2–3× a slow mobile login); a blank, non-numeric or non-positive value falls back to the default rather than removing the bound, since the unbounded case is the one with no diagnosis. Lower it for CI or unattended hosts; the listener is closed and the port released on every path.

The two ways the wait can fail produce different messages, because the operator's next action differs:

| What you see | What happened | What to do |
|---|---|---|
| `Port <N> is already in use (EADDRINUSE)`, naming the port and the default `http://127.0.0.1:8888/callback` | The listener never started. Usually an earlier `spotify-mcp auth` still waiting on its redirect | End that process (`ss -lptn 'sport = :<N>'` or `lsof -i :<N>`), or set `SPOTIFY_REDIRECT_URI` to a free loopback port and register that exact URI in the dashboard |
| `Timed out after … waiting for the browser callback`, naming the redirect, the port, and the elapsed bound | The listener bound and stayed up, but no redirect ever arrived. The port is free again | Retry; if it repeats, check the approval page completed, and that the exact URI (host `127.0.0.1`, not `localhost`, same port and path) is registered in the dashboard |

`SPOTIFY_MCP_TOKEN_FILE` and `SPOTIFY_MCP_PROFILE` select the persistent token file. Explicit `SPOTIFY_MCP_TOKEN_FILE` wins; otherwise a profile uses `~/.spotify-mcp/tokens.<profile>.json`; the unprofiled default is `~/.spotify-mcp/tokens.json`. Token files are created with mode 600. The `auth` command's `--profile` flag must name a profile: `--profile=`, `--profile "$UNSET_VAR"`, and a dangling trailing `--profile` are errors, because the silent alternative was to write into the shared default file while the operator believed a named profile existed.

#### Reading a token-refresh failure

A refresh that fails is classified by what the response actually said, so the message names the cause instead of reporting every failure as a Spotify outage. The categories you will see, and what each one means for you:

| What you see | What happened | What to do |
|---|---|---|
| `SPOTIFY_CLIENT_ID` was refused (`invalid_client`) | The app id does not match the one your grant was issued to — a recreated dashboard app, or a rotated id | Set `SPOTIFY_CLIENT_ID` to the Client ID in the Developer Dashboard, then re-run `spotify-mcp auth`. Retrying will not help |
| `re-run "spotify-mcp auth"` (`invalid_grant`) | The stored refresh token was revoked or expired | Re-run `spotify-mcp auth` |
| `rate limited … retry in Ns` | `accounts.spotify.com` is limiting refreshes, usually several sessions sharing one developer account | Wait the stated number of seconds. Refreshing sooner extends the limit |
| `HTTP 5xx`, "a server-side failure at Spotify" | Spotify's token endpoint failed | Retry shortly. Nothing local to change |
| `no HTTP response was received`, with a DNS/TLS/connection cause | The request never reached Spotify — local connectivity, not an outage | Check the connection, then retry |
| `timed out after Ns` | The refresh exceeded `SPOTIFY_REQUEST_TIMEOUT_MS` | Retry, or raise `SPOTIFY_REQUEST_TIMEOUT_MS` on a slow link |
| `the cause could not be classified` | The response carried no machine-readable error, so the cause is genuinely unknown | Read the status, body-parse result and token file path in the server log, then verify `SPOTIFY_CLIENT_ID` |

A named code this server has no fix for is quoted verbatim rather than being folded into one of the categories above, and a failure it cannot classify is reported as unclassified rather than guessed at. Every one of these messages names the resolved token file, so with several profiles installed you can tell which token file is the broken one. A transient failure (5xx, unreachable network) is ridden out silently when your current access token is still valid and the call proceeds normally.

#### Disconnecting: `spotify-mcp logout`

There are two separate things to undo when you stop using this server, and only one of them can be done from the command line.

**Local stores.** `spotify-mcp logout` erases the token file and every other **Spotify-side** local store listed in [PRIVACY.md](../PRIVACY.md#local-stores-and-paths), including the account registry and the taste-feedback file. Each store is resolved through the module that writes it, so the command cannot drift from where the server actually keeps things. A store that is one file per account — the persisted read cache is named `cache.json` for the default profile and `cache.<profile>.json` for a named one — is enumerated by running that module's own naming rule over the token files present, so `logout` erases every profile's cache rather than the active one. Every path it removes is printed, including the files inside a moved directory, so the report can be checked against the disk.

Stores are moved, not deleted: to the freedesktop trash (`gio trash`) where the filesystem supports it, otherwise into a `.spotify-mcp-logout-quarantine-<stamp>` directory beside the original, which the command also prints. Nothing is ever removed by a recursive delete. The token file is the single exception — it is overwritten and unlinked, because it holds a live refresh token and leaving that readable in a trash directory would defeat the purpose.

**The Spotify grant itself.** Spotify publishes no token-revocation endpoint. The official OpenAPI schema has no revoke path, and revocation appears there only as an error condition describing something the *user* does. No client, including this one, can end the access. Remove it at [spotify.com/account/apps](https://www.spotify.com/account/apps/) → Connected Apps → Remove. `logout` prints that address every time so the step cannot be missed, and the exit code reflects only the local half.

What `logout` refuses to erase, and reports instead:

- a store whose real path resolves outside the directory its own module places it in
- a symlinked store — the link is not this server's to follow
- a filesystem root, the home directory, or an ancestor of the store's own directory
- the data directory itself, when `SPOTIFY_MCP_DATA_DIR` is set, because the playlist-health snapshot store resolves to it and it is the parent directory of the stores that variable relocates; those stores are erased individually instead. The other stores — the token file, the mutation ledgers, the scene and search-history sidecars, `backups/`, and the rest — resolve under `~/.spotify-mcp/` whether or not `SPOTIFY_MCP_DATA_DIR` is set, so the data directory is a parent of a few stores rather than a superset of all of them
- a store that is the wrong kind on disk — most often a **directory** sitting where the config declares a single file, such as a folder named `scenes.json`. Anything running as you can create one, and containment cannot catch it, because a directory at that path is inside its own store directory by construction. `logout` refuses rather than moving it, names the entries at the top level so you can recognise the path, and leaves it in place. Removing it is yours to do by hand.

A refusal or a failure is a non-zero exit. Reporting success while a live token remained on disk is the failure this command exists to prevent.

| Flag | Effect |
|---|---|
| `--dry-run` | List what would be erased; erase nothing and ask nothing |
| `--keep-backups` | Leave the `backups/` library in place — it is your library, not session state |
| `--profile <name>` | Act on a named profile's token file, as `auth --profile` does |
| `--purge-data` | Ask for the erasure explicitly. Accepted and recorded, but it changes no decision: `logout` erases the stores whether or not it is passed, so the flag is for scripts that want to say so rather than for a narrower sweep |

`logout` is a CLI command and deliberately **not** a tool: a destructive tool would join the `tools/list` surface and hand every MCP host the ability to erase your credentials unattended.

Before erasing, `logout` asks for confirmation on a terminal and refuses outright when there is none, so it cannot run unattended by accident. The gate is the same `requiredConfirmationRefusal()` that guards destructive tools, and `SPOTIFY_MCP_CONFIRM=never` is the same single bypass — not a second one.

### Local files: reads and writes are confined

Every tool that writes a local file resolves its destination against a configured root — `SPOTIFY_MCP_EXPORT_DIR` for `export_playlist` and `export_profile_state`, `SPOTIFY_MCP_PORTABILITY_DIR` for the five `export_*` family tools. A relative `output_path` or `output_dir` resolves **inside** that root rather than against the process working directory; an absolute path outside it, a `..` escape, or a symlink leaving it is refused with the resolved path and the root in the message. `export_playlist` also refuses to replace an existing file unless you pass `overwrite: true`.

Reads are confined the same way, in reverse. `import_playlist` will read only from `SPOTIFY_MCP_PORTABILITY_DIR`, `SPOTIFY_MCP_BACKUP_DIR`, `SPOTIFY_MCP_EXPORT_DIR`, and anything you add to `SPOTIFY_MCP_ALLOW_PATHS`. Anything else, any non-regular file (directory, FIFO, socket, device), and any document over `SPOTIFY_MCP_MAX_DOCUMENT_MB` is refused before a byte is read.

Containment is decided on the *real* path — every component is resolved before the root comparison, so a symlink is collapsed rather than string-matched. Files are written with mode 600 and `O_NOFOLLOW`.

`SPOTIFY_HEADLESS=1` affects only the `auth` command. The auth URL is printed for a browserless host; complete it anywhere and paste the redirect URL back.

### Scope profiles

`auth` asks for a **profile** of scopes, not a hand-written list. Pick one with `SPOTIFY_MCP_SCOPE_PROFILE` or `spotify-mcp auth --scope-profile <name>`:

| Profile | What it requests | What it unlocks |
| --- | --- | --- |
| `read` | the 10 read scopes | Browsing only; nothing in it can change Spotify state. |
| **`core`** *(default)* | `read` + `user-modify-playback-state` | The above plus playback control. |
| `write` | `core` + `user-library-modify`, `playlist-modify-public`, `playlist-modify-private`, `user-follow-modify`, `ugc-image-upload` | The full write tool surface. |
| `full` | `write` + `user-read-email` | The maximal 17-scope grant this server shipped before #700. |

Before #700 an unconfigured `auth` run requested all 17, so a user who only wanted to browse consented on first login to library, playlist, follow and cover-upload writes — and to disclosing the account email, which **no shipped tool reads**. That is why the default is now `core`.

`auth` prints the requested scopes grouped with a one-line rationale, marking every non-read group, **before** it opens the browser. Declining a group is only free at that point; afterwards the remedy is a re-auth.

Two things a profile does *not* promise. It decides what the consent screen **asks for**; what a granted token can then **see** is decided separately, per manifest row, by the scope gate. The unit there is the row, not the tool, so no profile claims "this one tool needs exactly this one scope" — that is not expressible in this architecture, and a profile implying it would be the same defect #1005 shipped. And a grant that lacks a write scope does not 403 on those tools: the row registers with its write half removed, so a caller gets an unknown-tool error rather than a tool that fails at the API. Run `spotify_doctor` to see the profile your token matches and the granted-vs-required scopes per module, including the modules the grant is withholding.

**Existing tokens are unaffected** — grants are stored per token, so only new auth runs change.

`SPOTIFY_SCOPES` accepts spaces or commas and rejects unknown scope names; a profile name is accepted there too, so `SPOTIFY_SCOPES=full` and `--scopes full` are the same request as `--scope-profile full`. An explicit list in `SPOTIFY_SCOPES` or `--scopes` overrides the profile. A variable that is *set but names no scope* (`SPOTIFY_SCOPES=`, `SPOTIFY_SCOPES=" "`) fails rather than falling back: it used to be read as "unset" and silently widened the request to every scope, five of which are mutation scopes. Unset the variable instead of emptying it. `SPOTIFY_MCP_MARKET` accepts a two-letter ISO 3166-1 alpha-2 code; invalid values are ignored with a warning, and an explicit tool `market` argument takes precedence.

### Runtime limits and requests

`SPOTIFY_REQUEST_TIMEOUT_MS` applies an abort timer to every outbound Spotify request and token refresh. `SPOTIFY_MCP_MAX_ITEMS` sets the default list truncation cap; a call can still pass its own `max_results`. `SPOTIFY_MCP_FETCH_ALL_CAP` bounds `fetch_all=true` pagination and related scan walks; page explicitly with `limit`/`offset` when the cap is reached.

`SPOTIFY_MCP_FANOUT_CONCURRENCY` bounds how many of a scan's requests are outstanding at once. The freshness-radar tools used to issue them one at a time, so a 25-show `show_new_episodes` cost 25 serial round trips; they now overlap under this width. It is a concurrency bound and not a rate limiter — it never retries anything, and a 429 still stops the scan rather than being re-sent. The request count is the same either way, so raising it trades latency against burst size without changing what a call costs.

It is a **fallback, not the authority**, and the authority is the request funnel (#892), which is merged. The three cases, as `resolveFanoutConcurrency` resolves them:

| `SPOTIFY_MCP_MAX_CONCURRENCY` | `SPOTIFY_MCP_FANOUT_CONCURRENCY` | `fanout_concurrency` | `fanout_concurrency_source` |
|---|---|---|---|
| set | anything | that value, `positiveInt`-resolved and clamped to 32 | `SPOTIFY_MCP_MAX_CONCURRENCY` |
| unset | set | that value, clamped to 32 | `SPOTIFY_MCP_FANOUT_CONCURRENCY` |
| unset | unset | `3` | `default` |

So setting this variable has no effect on the radar tools while `SPOTIFY_MCP_MAX_CONCURRENCY` is set, and governs their width when it is not. With **neither** set the width is the funnel's own resolved default, `3` — not this variable's own constant. `DEFAULT_FANOUT_CONCURRENCY` (`4`) survives in `src/config.ts` for reference only; falling through to it would report a fan-out of 4 while the funnel permitted 3, in the unconfigured case, with nothing set to explain the disagreement. Two knobs bounding the same quantity from different places would multiply rather than add — the narrower one would win silently, and no payload could report which — so they are deliberately kept in agreement instead. `fanout_concurrency_source` names the variable actually in force, which is how you tell a funnel-derived width from one you chose here.

### Streamable HTTP transport (opt-in)

`SPOTIFY_MCP_TRANSPORT=http` serves the same MCP server over the Streamable HTTP transport instead of stdio. It is off by default and the stdio path is unchanged: with the variable unset, `resolveHttpConfig` returns immediately and reads none of the variables below it, so a stdio host cannot be affected by a stale `SPOTIFY_MCP_HTTP_*` in its environment.

```sh
SPOTIFY_MCP_TRANSPORT=http \
SPOTIFY_MCP_HTTP_TOKEN="$(openssl rand -hex 24)" \
node dist/index.js
# [spotify-mcp] Streamable HTTP transport listening on http://127.0.0.1:9871/mcp
```

The startup line carries the port, because with `SPOTIFY_MCP_HTTP_PORT=0` there is no other way to learn it. It never carries a token, and neither credential is written to stdout or stderr anywhere in the transport.

#### The authentication scheme, and why it is this one

A **pre-provisioned static bearer token**, compared in constant time. There is no default, no anonymous mode, and no way to start the listener without one — a refusal exits non-zero having registered nothing.

The alternative would be a resource-server OAuth design, and it is deliberately not here: it needs an authorization server, a token endpoint, and per-caller identity, and it collides with a decision this repo has already made. `src/auth.ts` refuses any non-loopback `SPOTIFY_REDIRECT_URI`, so a hosted process cannot complete a Spotify login at all without a separate design. Shipping half of that would put a token endpoint on a server nobody has threat-modelled. A shared secret is the smallest thing that makes the socket non-world-readable, and it is honest about its scope: **one user, one process, one account, one token**. It is a network credential guarding a network transport; it is not a Spotify credential and grants no Spotify scope.

The token guards the endpoint; it does not replace the Spotify token in the profile's token file. Both are needed, for different reasons, and neither is ever sent to the other.

#### Threat model

- **Single user.** Every session of one process acts on the same account, chosen by `SPOTIFY_MCP_PROFILE`. There is no per-caller identity and no tenancy.
- **Per-session isolation.** The MCP SDK's `Server` holds one transport, so each session gets its own `McpServer` **and its own `SpotifyClient`**. Sharing the client would give the second session the single `setProgressReporter` slot and redirect the first session's progress notifications onto the second session's stream.
- **No cross-session token sharing.** No session can name another's `mcp-session-id` into anything but a 404, and a client that lost its session state cannot mint a new registry per request.
- **Loopback unless deliberately opened twice.** `SPOTIFY_MCP_HTTP_BIND` off loopback needs `SPOTIFY_MCP_HTTP_ALLOW_NON_LOOPBACK` as well. On a loopback bind the `Host` header is also required to be a loopback name, which is the DNS-rebinding defence: a browser page that resolves its own domain to 127.0.0.1 cannot get a 401 it can read, and cannot get a 200 at all.
- **Bounded input.** Bodies are capped on the stream, requests are rate-limited per address before authentication, live sessions are capped, and past the tracking cap unseen addresses share one bucket so flooding cannot grow the limiter's memory.
- **Multi-user and SaaS hosting is a non-goal** — see [`docs/non-goals.md`](non-goals.md) § "Multi-tenant or hosted operation". A user who needs several accounts runs one process per account.

#### What is refused, and how it fails

Every one of these is a startup error with a non-zero exit, not a warning:

| Situation | What happens |
| --- | --- |
| `SPOTIFY_MCP_TRANSPORT=http`, no token set | exit 1, naming both ways to set one |
| A token under 16 characters, or containing a space, CR or LF | exit 1 — a space cannot be sent in an `Authorization` header, and CR/LF is request splitting |
| Both token variables set | exit 1 — two sources for one secret means the wrong one can win silently |
| `SPOTIFY_MCP_HTTP_TOKEN_FILE` unreadable | exit 1, naming the path |
| `SPOTIFY_MCP_HTTP_BIND` off loopback without the second opt-in | exit 1, naming `SPOTIFY_MCP_HTTP_ALLOW_NON_LOOPBACK` |
| `SPOTIFY_MCP_TRANSPORT` set to anything but `stdio`/`http` | exit 1 — never a silent fall back to stdio |
| A request with no, or a wrong, `Authorization` header | 401 before any MCP work, disclosing no tool, session or count |
| A `Host` header that is not loopback, on a loopback bind | 403 |
| A body over `SPOTIFY_MCP_HTTP_MAX_BODY_BYTES` | 413 |
| More than `SPOTIFY_MCP_HTTP_RATE_LIMIT` requests per minute from one address | 429 with `Retry-After` |
| More than `SPOTIFY_MCP_HTTP_MAX_SESSIONS` live sessions | 503 with `Retry-After` |

The 401 and the 429 body are deliberately identical for a wrong token and for no token: a difference would be an oracle telling an attacker which half of the guess was right.

#### Exposing it beyond this machine

If you set `SPOTIFY_MCP_HTTP_ALLOW_NON_LOOPBACK`, you have taken responsibility for the boundary this server does not build: TLS termination, and a real network policy in front of the listener. The bearer token is sent in a header on every request, so it crosses that boundary in the clear unless something terminates TLS first. Do not put this listener directly on a public interface.

### Mutation history

Set `SPOTIFY_MCP_HISTORY=1` to append one JSONL record per agent-driven mutation. `SPOTIFY_MCP_HISTORY_DIR` changes the directory; the file is `mutations.jsonl`. Records contain only the mutation method, path, and receipt/snapshot metadata — never tokens or request bodies.

**Rotation.** The ledger is bounded rather than cumulative. Before each append the live file's size is read, and if the existing size plus the incoming line would exceed `SPOTIFY_MCP_HISTORY_MAX_BYTES` (default **1 MiB**, i.e. `1048576` bytes), `mutations.jsonl` is renamed to `mutations.jsonl.1` and a fresh one is started. `rename(2)` replaces any existing archive atomically, so exactly one generation is kept and total on-disk history is bounded at roughly twice the threshold; the oldest records are what is lost, and the archive's owner-only mode is re-asserted on rotation because `rename` preserves the old inode's mode. The check happens per append, so a record can push the file just past the threshold before the next append rotates it. Rotation bounds what is kept *on disk*; it does not bound what a read returns, so `history_search` walks the tail by a fixed-size backward read that keeps at most 500 records in memory regardless of the file's size.

A value that is unset, empty, non-numeric, zero, or negative falls back to the default rather than disabling rotation, so a typo cannot turn a bounded ledger into a never-rotating one. This is the same intent as `SPOTIFY_MCP_BACKUP_RETENTION_DAYS`, but the two parse differently and the difference is worth knowing: retention is read with `Number()` and rejects a fractional value, while this threshold is read with `parseInt(…, 10)` and **truncates** it. `"2.5"` therefore means 2 bytes here, not the default, and surrounding whitespace is tolerated. Raise this only deliberately — a value below the size of a single record rotates the ledger on every append.

Each record's `who` field names the tool that issued the mutation (e.g. `add_to_playlist`), falling back to `agent` only when the call did not come through a tool. `history_search` matches on it, and the `spotify_doctor` row `history` reports the resolved ledger path, the live and archive sizes against the cap, the record count, and how many appends have been lost. A lost append never fails the mutation it describes, but it warns once per process on stderr and turns that doctor row red, because a trail with gaps otherwise reads as complete when it is not.

**Row cap.** A byte bound is not a retention policy: it stops the file growing without limit, but it does not say how many dated records that is, so "how much of my history is still here" had no answer. `SPOTIFY_MCP_HISTORY_MAX_ROWS` (default **5000**) is that answer, enforced over the whole ledger — the live file *and* the rotated `mutations.jsonl.1`, because the archive is where the oldest records live. When the count is exceeded, the ledger is rewritten keeping the newest rows, so the oldest are what is lost, exactly as with rotation. Unset, empty, non-numeric, zero and negative values fall back to the default: there is deliberately no way to switch this bound off, and a typo must not turn a bounded ledger into an unbounded one.

**Retention.** `SPOTIFY_MCP_HISTORY_RETENTION_DAYS` (default **90**) is how long a record survives. Records whose `ts` is older than the window are dropped, oldest first, in the same pass that enforces the row cap. This one *is* switchable: `0` means no age-based pruning at all, leaving the row cap as the only thing that removes a record. Unset, non-numeric and negative values fall back to the default rather than the other way round, so an unusable value cannot expire the whole ledger on the next append. A record carrying no readable `ts` is **not** expired — an unknown age is not a verdict, so a hand-written or pre-`ts` line is kept rather than silently discarded, and the row cap is what bounds it. (Same rule as the receipt TTL below.) An undated line is also **not** a date the ledger may borrow from the record behind it: the window is measured from the oldest record that actually carries a `ts`, so an undated line sitting at the head of the file cannot exempt the expired records after it.

Pruning runs on every append and once at server startup, across every account's ledger — including profiles you have stopped using, since no append will ever reach those. Startup is what makes it a retention window rather than a cleanup: a ledger nobody wrote to for a month still ages, and pruning on append alone would leave the oldest records on disk for exactly as long as you did nothing.

The rewrite is atomic: a uniquely-named temp file in the same directory, `fsync`, then `rename(2)` over the target, at mode 0600 like every other write to this store. A crash mid-prune leaves the previous ledger whole rather than a half-pruned one, and no temp file is left behind.

**Erasing it.** `spotify-mcp logout` removes the ledger and its rotated generation, and prints both paths so the result can be checked against the disk — see [Disconnecting](#disconnecting-spotify-mcp-logout) and [PRIVACY.md](../PRIVACY.md#local-stores-and-paths). There is no tool that does this: `logout` is deliberately a CLI command, not a `tools/list` entry, so no MCP host can hand itself the ability to erase your data unattended. `spotify_doctor` reports the same thing from the other side — the exact row count against the cap, the oldest record's date, the configured window, and `history_purge=spotify-mcp logout` — so a trail you forgot you had can be found before you need it gone.

### Taste feedback store

`statsfm_record_feedback` stores verdicts locally and never touches the network. The store is a file, not process memory, so a verdict recorded in one session is still there in the next — and, because it is a file, it is bounded and it can be corrupted, both of which it now handles explicitly.

**The cap is three bounds, because no one of them is sufficient on its own.**

- **One record.** `subject` is capped at 200 characters and `note` at 500; every other field is an enum or a timestamp. This is the bound a count cap alone cannot supply: before it, a single `subject` was unbounded and could have flushed the whole store on its own.
- **A record count** — `SPOTIFY_MCP_TASTE_FEEDBACK_MAX_ENTRIES`, default 500. This is what bounds memory and the size of one `action=list` response.
- **A byte size** — `SPOTIFY_MCP_TASTE_FEEDBACK_MAX_BYTES`, default 1 MiB. Defence in depth: the on-disk promise that survives someone later raising the count or the field caps.

Eviction is oldest-first until all three hold, and the lifetime `recorded` and `evicted` counters are persisted. A store that quietly dropped your verdicts would otherwise read as an agent with no history.

**Retention is a ring buffer, not a TTL.** A verdict's value is that it is recent, but a TTL cannot bound a store an agent fills within a single session; it would add a clock read to every record and every list while leaving the count unbounded. (The mutation history uses byte rotation instead, because an append-only log of fixed small lines is the opposite shape — there the cap is enforced by rotating the file, not by rewriting it.)

**A corrupt or truncated store is preserved, not reset.** Loading follows the shared policy in `src/sidecar.ts` (#839, #1051), the same one the scene, genre-tag and playback-extension sidecars use: a missing file reads as an empty store, and every other read, parse or validation failure preserves the exact bytes at `<file>.corrupt` (or `<file>.corrupt.N`, opened `O_EXCL` so a later corruption cannot clobber an earlier preserved copy) at 0600 and reports the path. The original file is left where it is. Rotation and eviction make a malformed file *more* likely to appear, not less, so the write is built so that it does not create one.

**The write is atomic.** The store is a single JSON document, so a write that truncated the target in place and died mid-write would lose *every* record rather than one line. Instead: a uniquely named temp file in the same directory, `fsync`, then `rename(2)` over the target. The rename is the only mutation of the real path, so a crash before it leaves the previous store whole. The temp name carries the pid and random bytes because a fixed `<path>.tmp` is a race between concurrent `statsfm_record_feedback` calls (#1135). A write that fails is **reported** as a failure — a verdict that reads as recorded but is not on disk is the #764 watchlist failure.

`spotify_doctor` reports both stores: the `history` row carries the ledger's sizes, cap and record count, and the taste-feedback row carries the store's path, how many verdicts are retained, and how many the cap has dropped.

### stats.fm identity

stats.fm has no OAuth and no token, so "identity" here is only *which public profile* the user-scoped reads are about. `STATSFM_USER_ID` supplies that default so the same id is not repeated on every call.

The precedence is: **explicit per-call argument > `STATSFM_USER_ID` > error.** The last step is deliberate and is the part worth knowing. The argument used to be strictly required, so the SDK's own validation produced the error when it was missing; making it optional to admit this default removed that guarantee, so each handler now resolves the value through one shared helper that throws naming both ways to supply it (`no stats.fm user id: pass user_id or set STATSFM_USER_ID`). It throws rather than falling back to a placeholder: a guessed id would return a confident, well-formed answer about *somebody else's* public profile, which is a worse failure than a refusal. The spelling follows the tool — the endpoint tools in `statsfm.ts` declare `user_id`, the taste tools and composites declare `statsfm_user`, and the error names whichever one that tool actually declares.

A value that is unset, empty, or only whitespace counts as unset. No other normalization is applied: stats.fm ids and customIds are opaque, and there is no authority in this repository for their canonical spelling, so guessing at one would produce a 404 against a real profile that reads as "no such user".

`spotify_doctor`'s `config` row reports whether the variable is `set` or `unset`, never the value — a doctor report is the kind of output that ends up pasted into an issue.

### Mutation receipts

Set `SPOTIFY_MCP_RECEIPTS=1` to persist each mutation receipt to `receipts.jsonl` and reload the newest 100 on startup, so `verify_receipt` and `undo_mutation` still work after a host restart, a crash, or a session longer than 100 mutations. `SPOTIFY_MCP_RECEIPTS_DIR` sets the directory (it falls back to `SPOTIFY_MCP_HISTORY_DIR`, then `~/.spotify-mcp`); `SPOTIFY_MCP_RECEIPTS_TTL_HOURS` sets the retention window (default 24 hours, `0` for no expiry). Receipt ids are scoped to the process that issued them (`rcpt_<bootId>-<n>`), so an id from an earlier session resolves to nothing rather than to a different mutation. With persistence off the store is process-local, and a miss reports that scope and the retention rule instead of implying account history.

### Backup snapshot retention

`SPOTIFY_MCP_BACKUP_DIR` holds one dated library compilation per `backup_library` run, so the
store is bounded rather than cumulative. `SPOTIFY_MCP_BACKUP_RETENTION_DAYS` is how long a
snapshot survives: **30 days by default**. The window is enforced as a prune pass that runs at
the start of every `backup_library` and every `list_backups` call, and each run reports the
snapshots it removed and the bytes freed.

Set it to `0` to disable pruning entirely — nothing is ever expired, and each snapshot's
`_meta.retention_until` is `null`. That is the only way to opt into keep-forever retention; the
1-day floor is the smallest *enabled* window, so `1` is the tightest expiry you can configure.

An unusable value never becomes an unbounded window. Empty, non-numeric, negative, and
fractional values (`""`, `"abc"`, `"-1"`, `"2.5"`) all fall back to the **default of 30 days**
rather than to "keep forever", because a typo should expire data, not retain it indefinitely.
`SPOTIFY_MCP_BACKUP_RETENTION_DAYS=0` is the deliberate, explicit exception and is honoured
exactly as written. Every snapshot also records `_meta.retention_until` at write time, so a
file stays self-describing even after the variable changes; `list_backups` additionally
reports `dir_bytes`, `oldest_created`, and the oldest survivor's `oldest_retention_until`.

To remove one snapshot ahead of its window, use the `delete_backup` tool, which is
confirmation-gated, dry-run by default, and path-confined to `SPOTIFY_MCP_BACKUP_DIR`.
 dcb6adcf111cd0992e9ae4911cf119373a6280a8
### Toolsets and registration keys

`SPOTIFY_MCP_TOOLSETS` accepts a comma-separated subset of these toolsets, or `all` for the full surface:

<!-- BEGIN:generated env-toolsets -->
`core`, `playback`, `playbackintel`, `catalog`, `playlists`, `library`, `personalization`, `statsfm`, `portability`, `taste`, `discovery`, `resources`, `prompts`, `accounts`
<!-- END:generated env-toolsets -->

**The default is `core`, not everything (#889).** A server started with no `SPOTIFY_MCP_TOOLSETS` registers the `core` set plus `resources` and `prompts` — the search, playback, playlist, library and following tools, and the three MCP surfaces that cost no tool-schema context. Unset used to mean the whole registry, which cost a host ~600 KB of schema before its first user message; the curated default is about a quarter of that. `SPOTIFY_MCP_TOOLSETS=all` restores the full surface, and the startup log names the default so a trimmed server is never silent about it. The exact tool and byte counts for both surfaces are in the generated surface-census block of [README.md](../README.md).

**The stats.fm families are opt-in (#607).** `statsfm`, `taste` and `tastecomposites` are not in the default: 49 tools that need a separate stats.fm username, advertised to every user whether or not they have one. Set `SPOTIFY_MCP_STATSFM=1`, or name them — `SPOTIFY_MCP_TOOLSETS=core,taste,statsfm` — and read [docs/statsfm.md](statsfm.md) for what they require.

`SPOTIFY_MCP_ENABLE_TOOLS` and `SPOTIFY_MCP_DISABLE_TOOLS` take registration keys, not individual tool names. The complete key list is:

<!-- BEGIN:generated env-registration-keys -->
`accounts`, `artistwatch`, `audiobooks`, `browse`, `catalog`, `episodemgmt`, `exhaust2catalog`, `exhaust2enggating`, `exhaust2extra`, `exhaust2misc`, `exhaust2playback`, `exhaust2playlists`, `following`, `library`, `libraryanalytics`, `personalization`, `playback`, `playbackext`, `playbackintel`, `playlistbatch`, `playlisthealth`, `playlistmisc`, `playlists`, `portability`, `prompts`, `queueops`, `resources`, `search`, `searchhistory`, `statsfm`, `swarm3analytics`, `swarm3bdiscovery`, `swarm3discovery`, `swarm3library`, `swarm3meta`, `swarm3playback`, `swarm3playlistops`, `swarm3refs`, `swarm3shows`, `swarm3snapshots`, `swarm4playlists`, `taste`, `tastecomposites`, `users`
<!-- END:generated env-registration-keys -->

`disable` wins over `enable`, and both are layered on top of set membership. Unknown keys are reported and ignored. `spotify_doctor` and the discovery metadata tools remain available independently of the trim.

An unknown-only toolset spec fails startup with the valid set names. A mixed known+unknown spec starts normally and reports the ignored names.

### Read-only and confirmation safety

`SPOTIFY_MCP_READONLY=1` (also `true`, `yes` or `on`; case-insensitive, surrounding whitespace ignored) prevents registration of Spotify-mutating modules such as playback and scenes, playlist and library mutations, following, users, audiobooks, and destructive helpers. It does **not** imply that every remaining tool is side-effect-free: local-only tools such as the taste feedback store remain available. It also does not bypass the independent toolset, registration-key, or scope gates. Read-only resources and prompts remain available when their own gates permit.

For confirmation-gated destructive operations, a missing MCP elicitation capability produces an `unsupported` result. Callers that require confirmation must treat that result as refusal; they proceed without prompting only when `SPOTIFY_MCP_CONFIRM=never` explicitly selects the automation bypass. A declined prompt or elicitation failure also fails closed.

### Derived listening analytics

`SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS=1` (also `true`, `yes` or `on`; case-insensitive, surrounding whitespace ignored) registers eleven tools that turn the account's own `/me/top/*` and `/me/player/recently-played` responses into **derived** listening metrics: hour-of-day and daypart histograms, weekday profiles, discovery ratios, era histograms, and binge or listening-consistency scores. Spotify's Developer Policy Sec. III.13 prohibits analysing Spotify Content to create "new or derived listenership metrics … or building profiles of users", and those outputs are the shape it names.

**Unset is the non-analytics path, and that is the default for everyone.** The eleven tools are then absent from `tools/list` — not registered and returning an empty result — so no caller can read "you did not listen at 3am" out of a gate that is actually switched off. The startup log names them, and so does the `surface` row of `spotify_doctor` (`derived_analytics=false`).

The withheld set is `listening_report`, `listening_heatmap`, `discovery_ratio`, `listening_clock`, `listening_clock_heatmap`, `artist_listening_clock`, `mood_bucket_report`, `weekday_listening_report`, `weekly_rotation_report`, `binge_detector_report` and `listening_recap_brief`. With the flag set, the registry is exactly what it was before the gate and each tool returns the payload it always did.

An unrecognised value — `enabled`, `2`, `y` — leaves the analytics **off** and prints a stderr line naming the accepted spellings. It is not a startup failure: the default is already the safe path, so refusing to start would take a working host offline over a cosmetic mistake. The value is parsed by the same `truthyEnv` convention as `SPOTIFY_MCP_READONLY`, so the two switches cannot drift into disagreeing about what counts as a boolean.

This gate is independent of `SPOTIFY_MCP_READONLY` in both directions. A read-only host may still hold derived analytics; an analytics-opted-in host is still fully writable. Tools that re-present the account's own data — `get_top_artists`, `get_top_tracks`, `get_recently_played`, `top_artists_by_range`, `taste_shift_report`, `listening_history_export` and the leaderboard and rank-delta tools — are never gated. The policy reading behind the gate is written out in [`docs/compliance.md`](compliance.md#derived-listening-analytics-the-policy-and-the-interpretation).

### Freshness and local sidecars

`SPOTIFY_MCP_FRESHNESS_STATE` is the `whats_new` watermark. `SPOTIFY_MCP_FRESHNESS_BUDGET` limits artist album and show episode lookups; `max_artists` or the relevant per-call argument overrides it for one call. A truncated or quota-hit scan holds the watermark so a later `since: "last-check"` does not skip unseen items — and "truncated" includes a saved-shows listing that stopped short of the library even when every episode lookup below the budget succeeded, which is the case where nothing else in the payload would otherwise show that shows were never read. The saved-show radar (`show_new_episodes`) uses this same budget unless `SPOTIFY_MCP_SHOWRADAR_BUDGET` is set, in which case that variable replaces it for that tool; a `max_shows` argument still wins for a single call, and the response states in prose which of the three was in force.

#### The watermark is per kind, and an explicit `since` never moves it

`whats_new` is registered as a read, so its writes to this sidecar are disclosed here, in the prose it emits, and in `PRIVACY.md` rather than only in the source.

The file holds one checkpoint per kind:

```json
{
  "last_check": "2026-09-27",
  "kinds": { "albums": "2026-09-27", "podcasts": "2026-09-18" }
}
```

A kind is recorded in `kinds` **only after that kind's own scan ran to the end** — no cap truncation, no quota wall, READONLY off. A `kinds: ["albums"]` call therefore cannot move the mark a `kinds: ["podcasts"]` call reads, which is what previously made a podcast scan report "nothing new" purely because an album scan had run first. `last_check` is a derived compatibility field (the most recent day any kind holds) that an older build still reads; the current code does not read it for a kind that has a `kinds` entry, and never copies it into `kinds` for a kind that has not completed a scan.

**An explicit `since` date never writes this file at all.** An explicit window is a question about the past, not a claim that everything released up to today has been seen, so moving the incremental mark forward on one would hide genuinely new items from the next `since: "last-check"` call. `since: "last-check"` and a plain `days_back` window both still advance, because both return everything released since the mark.

Reading `since: "last-check"` uses the **oldest** mark among the requested kinds. Taking the newest would hide everything released since it, for whichever requested kind is furthest behind. If any requested kind has no mark of its own, the whole call falls back to `days_back` for the same reason, and says so in `cutoff_reason`.

##### Migrating a pre-2.2 flat watermark

Files written before the per-kind change hold a single `{"last_check": "YYYY-MM-DD"}`. Reading one **uses that mark as the cutoff for kinds that have no entry of their own**, so the position a user had before the upgrade is preserved rather than reset — and the response reports it as `legacy_watermark_migrated_from`.

What it deliberately does **not** do is copy the flat mark into `kinds` for a kind that has not completed a scan. A flat mark cannot say which kinds the scan that wrote it actually covered — with the old code an `albums`-only call wrote it just as readily as a both-kinds call — so adopting it as a per-kind checkpoint would mark an unscanned kind as caught up to a date its items were never filtered against, and that window would never reappear. That is the same permanent, silent loss this change exists to prevent.

The first write that advances a kind replaces the flat file with the per-kind shape, after which the legacy fallback no longer applies. A kind that has not yet been re-scanned therefore falls back to `days_back` on its next `last-check` call — a **wider** window, not a narrower one. Widening is recoverable and self-healing; hiding is neither, and a one-time re-read of a few weeks of a followed artist's discography is a far smaller cost than episodes that silently never appear again. `logout` erases this file along with the other local sidecars, and deleting it by hand resets every kind to `days_back`.

An older build reading the new shape finds no top-level `last_check`-only record, falls back to `days_back`, and shows a wider window. It cannot read the per-kind map, so downgrade is lossy in precision rather than in data — the dates themselves stay in the file.

`SPOTIFY_MCP_SCENES_FILE` stores named device/volume/shuffle/repeat/context presets. `SPOTIFY_MCP_GENRE_TAGS_FILE` stores user-declared artist genre tags. `SPOTIFY_MCP_SEARCH_HISTORY_FILE`, `SPOTIFY_MCP_PLAYBACKEXT_FILE`, `SPOTIFY_MCP_EXHAUST2_PLAYBACK_FILE`, and `SPOTIFY_MCP_EXHAUST2_MISC_FILE` override their respective local sidecars.

A sidecar that exists but cannot be read is never reset. The file is left exactly as it is, a byte-for-byte copy is placed beside it as `<file>.corrupt` (or `<file>.corrupt.N` if that name is taken), and the tools that read it report the file and the parse failure instead of an empty result — `search_history`, `search_rerun` and `search_history_stats` answer with `error: "load_error"` and a `preserved_as` path, and report their counts as `null` rather than `0`. Writes into an unreadable store are refused rather than merged, so nothing is lost; searches run normally but are not recorded, and the number dropped is reported on the first read after the file is repaired. Repair the file (or move it aside) to resume recording. A sidecar that does not exist is a first run, not a corruption, and is not reported as one.

`SPOTIFY_MCP_DATA_DIR` is read by the artist-watchlist, portability-watchlist, and playlist-health paths. Without it, the watchlist call sites use `~/.spotify-mcp/artist-watchlist.json` and playlist-health uses `~/.spotify-mcp/playlist-snapshots`; a pre-v2 `./data/artist-watchlist.json` is read once and migrated to the new location on the next write. `SPOTIFY_MCP_SNAPSHOT_DIR` separately controls the swarm3 playlist-snapshot sidecar. `SPOTIFY_MCP_BACKUP_DIR` and `SPOTIFY_MCP_PORTABILITY_DIR` control backup and export destinations.

Every local store's path and its default are listed in one place in the source — `LOCAL_STORES` in `src/config.ts` — and each module that owns a store resolves it from there rather than restating it. This document is the human-readable view of that list, not a second copy of it: a store added to the server is added to `LOCAL_STORES`, and a test fails if a store path is spelled anywhere else in `src/`, if a store is missing from `logout`'s erasure list, or if a row here stops matching what the resolver returns. The rows above are checked against the resolvers, so if one drifts, the suite is what notices.

Two stores are named per account rather than per environment, because their file name carries the account key: the mutation ledger and the write-receipt store keep `mutations.jsonl` / `receipts.jsonl` for the default account and `mutations.<profile>.jsonl` / `receipts.<profile>.jsonl` for a named profile. `SPOTIFY_MCP_HISTORY_DIR` and `SPOTIFY_MCP_RECEIPTS_DIR` set the DIRECTORY for all of them; the account segment is not configurable.

### When a pending save is lost

With `SPOTIFY_MCP_CACHE_PERSIST=1` a burst of reads is coalesced into one debounced write. What happens to a write that is still pending when the process ends depends entirely on **how** the process ends, and the two classes are not the same size. This section states the boundary, because "the save is flushed on shutdown" is otherwise read as unconditional and is not.

**The pending save IS written** when the process ends by:

| Termination | Mechanism | Verified by |
|---|---|---|
| Running out of work | The debounce timer fires on its own; a pending timer keeps the loop alive | test |
| `process.exit()` | The `exit` event, whose listeners run **synchronously** | test |
| An uncaught throw | The same synchronous `exit` path | test |
| `SIGINT`, `SIGTERM`, `SIGHUP`, `SIGQUIT` | An installed handler, which re-raises so the process still dies *of* the signal (status 128+n) | test |

The `exit` path cannot `await`, so the shutdown write is the synchronous writer. That is why the row for `process.exit()` is not a gap: a promise started there would be discarded, so the write is issued synchronously instead.

**The pending save is NOT written** — and nothing in this server can make it so — when the process is terminated by something that runs no JavaScript at all: `SIGKILL` / `kill -9`, an OOM-kill, a supervisor's hard-stop after its grace period, `docker kill`, a container eviction, a power loss, or a kernel panic. There is no callback to fire; the process is already gone before Node regains control. **This is a real, unfixed limitation, not a configuration to change.** It is a test, not a comment: the suite asserts that a `SIGKILL`ed process really does leave no `cache.json`, so the claim stays measured.

Because the loss cannot be prevented, it is made **visible instead**. While a save is pending, a marker file `cache.json.pending` sits beside the cache file, holding the owning process's PID and the number of entries at stake. It is armed before the debounce timer is scheduled and removed as soon as the write resolves — by the timer, or by the shutdown flush. A termination that runs no JavaScript can leave the marker behind, and the **next** process to start reports it:

- `spotify_doctor` shows `cache_persist_lost=<n>` and downgrades the `cache` row to a warning.
- `getRateLimitStatus()` reports `cachePersistLost`.

Two limits on that report, so it is not read as more than it is:

- **It is a report, not a repair.** The marker holds a count, never a payload. The entries are gone; the next process is telling you they were never written, not offering them back. A test pins this, so the mechanism cannot quietly turn into a journal.
- **It is reported once, and only for a dead owner.** A marker belonging to a process that is still running — this one, or a second server sharing the cache — is neither reported nor deleted: that save is in flight, not lost.

`cachePersistFailed` stays `0` across a hard kill, because the process that lost the write never ran the code that would have counted it. That silence is the specific thing this marker exists to end.

## Registration-gated endpoints

Some Spotify Web API endpoints are denied at the app-registration level: on current app registrations they return `403 Forbidden` regardless of the OAuth scopes granted or the account's subscription tier. The table below records the observed runtime behaviour rather than a verdict, because the sources that describe this class do not agree: Spotify's [February 2026 changelog](https://developer.spotify.com/documentation/web-api/references/changes/february-2026) marks a batch of operations `[REMOVED]`, while the [live OpenAPI schema](https://developer.spotify.com/reference/web-api/open-api-schema.yaml) still publishes most of those same paths carrying `deprecated: true`. The README [explains the disagreement in full](../README.md#registration-gated-endpoints). The classifier that decides which family is gated is `GATED_FAMILIES` in `src/gating.ts`. The `403` rows below come from a dated edge probe (recoverable as `git show 1a53544:memory/edge-probe-2026-08-26.json`; the file itself is dropped by `.gitignore`, which is why it is named here rather than linked) reported in [#329](https://github.com/NovaLux12/spotify-mcp-server/issues/329).

| Response | Endpoints |
|---|---|
| `403 Forbidden` | `/browse/new-releases`, `/browse/categories` (and `/browse/categories/{id}/playlists`), `/markets`, `/artists/{id}/top-tracks`, `/users/{id}` (and `/users/{id}/playlists`), every documented `/me/{type}/contains` check (tracks, albums, shows, episodes, audiobooks, following), `/playlists/{id}/followers/contains` |
| `404 Not Found` | `/recommendations`, `/recommendations/available-genre-seeds` |
| `410 Gone` | `/me/apps`, `/me/chapters` |

Tools wrapping these endpoints stay registered and return a plain-English 403 explanation on current registrations. They are kept for a reason that is checkable in this tree — their callers disclose the 403 rather than degrading into a wrong answer — not because they are known to work elsewhere. Whether a *grandfathered* (pre-Nov-2024) registration answers `200` on any of these paths is **unverified** (#1338, #1399): no pre-Nov-2024 client id or app age is on record here, and the one probe artefact that was once cited for it records `403` for both `/users` paths. The authoritative list of gated families is `GATED_FAMILIES` in `src/gating.ts`, which is what the [README table](../README.md#registration-gated-endpoints) is generated from. The undocumented `/me/library/contains` check is not gated and powers duplicate-cleanup tooling. Batch lookup and top-tracks tools are wrapped, but registration-gated families are listed above rather than described as generally available.

## Not used

`SPOTIFY_CLIENT_SECRET` is deliberately not supported: the PKCE flow proves the app's identity without a secret, so there is nothing to leak.
