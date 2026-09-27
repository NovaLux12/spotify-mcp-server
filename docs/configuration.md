# Configuration reference

The variables below are read at the documented call sites; set them in your MCP host config, command line, or `.env` (loaded by `npm run dev` on Node 22.9+). There is no unified environment registry or config file.

## Summary

| Variable | Default | Purpose |
| --- | --- | --- |
| `SPOTIFY_CLIENT_ID` | none (required) | OAuth Client ID of your Spotify app; used for login and token refresh. |
| `SPOTIFY_REDIRECT_URI` | `http://127.0.0.1:8888/callback` | OAuth redirect URI; must match your Spotify app settings exactly. |
| `SPOTIFY_MCP_TOKEN_FILE` | `~/.spotify-mcp/tokens.json` | Persistent token cache (written with mode 600). Explicit path wins over profile and default. |
| `SPOTIFY_MCP_PROFILE` | unset | Profile name for `~/.spotify-mcp/tokens.<profile>.json`; `auth --profile <name>` is the CLI equivalent. The CLI flag rejects an empty or missing name instead of falling back to the default token file. |
| `SPOTIFY_SCOPES` | unset (17 default scopes) | Space- or comma-separated OAuth scopes to request; unknown scopes fail startup, and so does a value that is set but names no scope. |
| `SPOTIFY_MCP_MARKET` | unset (no market applied) | Default ISO 3166-1 alpha-2 market for market-gated lookups. Precedence: the tool's `market` argument, then this variable, then the account country when `GET /me` still carries one. Spotify removed `country` from `GET /me` in its February 2026 changes, so on a current registration nothing supplies a default and the result reports `market_source: "none"`. |
| `SPOTIFY_HEADLESS` | unset | `1`, `true`, `yes`, or `on` enables browserless paste-flow authentication. |
| `SPOTIFY_AUTH_TIMEOUT_MS` | `300000` | How long the browser flow waits for the OAuth callback before giving up and closing the listener. |
| `SPOTIFY_REQUEST_TIMEOUT_MS` | `30000` | Per-request timeout for Spotify API calls and token refresh. |
| `SPOTIFY_MCP_MAX_ITEMS` | `50` | Default per-call item cap for list tools; `max_results` overrides per call. |
| `SPOTIFY_MCP_FETCH_ALL_CAP` | `500` | Hard cap for `fetch_all=true` pagination walks. |
| `SPOTIFY_MCP_HISTORY` | unset | `1`, `true`, `yes`, or `on` logs one JSONL line per agent-driven mutation. |
| `SPOTIFY_MCP_HISTORY_DIR` | `~/.spotify-mcp/history` | Directory containing `mutations.jsonl`. |
| `SPOTIFY_MCP_HISTORY_MAX_BYTES` | `1048576` | Size in **bytes** at which `mutations.jsonl` rotates to `mutations.jsonl.1`. Only consulted when `SPOTIFY_MCP_HISTORY` is on. Unset, non-numeric, zero, and negative values fall back to the default rather than disabling rotation. Exactly one generation is kept, so the ledger on disk never exceeds twice this, and `spotify_doctor` reports the live and archive sizes against the cap plus the record count. |
| `SPOTIFY_MCP_RECEIPTS` | unset | `1`, `true`, `yes`, or `on` persists mutation receipts to `receipts.jsonl` so `verify_receipt` and `undo_mutation` survive a restart. Unset keeps them in process memory only, and every miss says so. |
| `SPOTIFY_MCP_RECEIPTS_DIR` | `~/.spotify-mcp` | Directory containing `receipts.jsonl`; falls back to `SPOTIFY_MCP_HISTORY_DIR` when unset. |
| `SPOTIFY_MCP_RECEIPTS_TTL_HOURS` | `24` | How long a persisted receipt stays resolvable; `0` disables expiry. The newest 100 receipts are kept either way, FIFO. |
| `SPOTIFY_MCP_TOOLSETS` | unset (all) | Comma-separated toolsets to register. `all`, empty, or unset registers everything. |
| `SPOTIFY_MCP_ENABLE_TOOLS` | unset | Comma-separated registration-key overrides forced on. |
| `SPOTIFY_MCP_DISABLE_TOOLS` | unset | Comma-separated registration-key overrides forced off; disable wins over enable. |
| `SPOTIFY_MCP_READONLY` | unset | `1`, `true`, `yes`, or `on` (case-insensitive, trimmed) hides Spotify-mutating registration modules. One parser backs this flag, the `spotify_doctor` report, the `whats_new` annotations and the freshness-watermark hold, so they cannot disagree. Read-only modules, resources, and prompts remain subject to their normal gates. |
| `SPOTIFY_MCP_CONFIRM` | unset | `never` is the only explicit bypass for confirmation-gated destructive operations; callers that require confirmation otherwise fail closed when the client cannot elicit. |
| `SPOTIFY_MCP_FRESHNESS_STATE` | `~/.spotify-mcp/freshness.json` | Watermark file powering `whats_new` with `since: "last-check"`. |
| `SPOTIFY_MCP_FRESHNESS_BUDGET` | `25` | Per-call budget for `whats_new` artist and show lookups. |
| `SPOTIFY_MCP_MAX_CONCURRENCY` | `3` | **The one concurrency knob**: the ceiling on Spotify requests in flight at once for the whole process. Every request passes through the funnel, including those a single tool fans out, so this is the width that applies everywhere. Starts are still paced a minimum 100 ms apart and still stop entirely during a `Retry-After` cooldown; `1` restores the strictly serial funnel. Clamped to 32 — a larger value is not honoured, so unbounded concurrency cannot be configured by accident. |
| `SPOTIFY_MCP_SHOWRADAR_BUDGET` | unset (falls back to `SPOTIFY_MCP_FRESHNESS_BUDGET`) | Per-call episode-lookup budget for `show_new_episodes` only. Takes precedence over the shared freshness budget; a `max_shows` argument still wins for one call. |
| `SPOTIFY_MCP_FANOUT_CONCURRENCY` | `4` | How many requests a freshness-radar fan-out keeps in flight at once: the per-show lookups in `show_new_episodes`, the per-artist album lookups in `check_artist_releases` and `artist_release_digest`, and the per-type walks in `search_deep`. Bounds burst size, not request count — the number of requests a scan makes is unchanged. `1` restores the old strictly-serial walk. Every affected payload reports the width it used as `fanout_concurrency` / `fanout_concurrency_source`. **Yields to `SPOTIFY_MCP_MAX_CONCURRENCY`**: that request-funnel knob (#892) takes precedence for these tools, so the two can never disagree about how much is in flight. It is read here whether or not the bounded funnel has landed, so setting it always has the same effect on the radar scans rather than a different one depending on which build you run. |
| `SPOTIFY_MCP_SCENES_FILE` | `~/.spotify-mcp/scenes.json` | Playback scene sidecar. |
| `SPOTIFY_MCP_GENRE_TAGS_FILE` | `~/.spotify-mcp/genre-tags.json` | Artist-to-genre-tags sidecar. |
| `SPOTIFY_MCP_DATA_DIR` | `~/.spotify-mcp` for watchlists; `~/.spotify-mcp/playlist-snapshots` for playlist-health snapshots | Data directory read by the artist-watchlist, portability-watchlist, and playlist-health call sites. The watchlist default no longer depends on the process working directory. |
| `SPOTIFY_MCP_BACKUP_DIR` | `~/.spotify-mcp/backups` | Directory for `backup_library` snapshots. |
| `SPOTIFY_MCP_BACKUP_RETENTION_DAYS` | `30` | Whole days a `backup_library` snapshot is kept before it is pruned. `0` disables pruning entirely. Any unusable value (empty, non-numeric, negative, fractional) falls back to the default, never to "keep forever"; the smallest enabled window is `1` day. |
| `SPOTIFY_MCP_EXPORT_DIR` | `~/.spotify-mcp/exports` | Output root for `export_playlist` and `export_profile_state`. |
| `SPOTIFY_MCP_PORTABILITY_DIR` | `~/.spotify-mcp/portability` | Default output directory for library/history portability exports; also the output root for the five `export_*` family tools. |
| `SPOTIFY_MCP_ALLOW_PATHS` | unset | Extra directories `import_playlist` may read from, `:`-separated. The default read roots are `SPOTIFY_MCP_PORTABILITY_DIR`, `SPOTIFY_MCP_BACKUP_DIR` and `SPOTIFY_MCP_EXPORT_DIR`. |
| `SPOTIFY_MCP_MAX_DOCUMENT_MB` | `32` | Per-document read cap. A larger `input_path` or inline `content` is refused before it is read. |
| `SPOTIFY_MCP_TIMEZONE` | `UTC` | IANA zone for `listening_heatmap` day/hour buckets. Host time is never used implicitly; the same payload is produced in every host zone. |
| `SPOTIFY_MCP_SNAPSHOT_DIR` | `~/.spotify-mcp/playlist-snapshots` | Playlist snapshot sidecar directory. |
| `SPOTIFY_MCP_SEARCH_HISTORY_FILE` | `~/.spotify-mcp/search-history.json` | Local search-history sidecar. |
| `SPOTIFY_MCP_SEARCH_HISTORY` | unset (enabled) | `0`, `false`, `no`, or `off` (case-insensitive, trimmed) stops the search-history tools from recording or replaying queries. Any other value, including unset, keeps history on. |
| `SPOTIFY_MCP_TASTE_FEEDBACK_FILE` | `<SPOTIFY_MCP_DATA_DIR>/taste-feedback.json` | Store for verdicts written by `statsfm_record_feedback`. The full path wins; otherwise the file is `taste-feedback.json` inside `SPOTIFY_MCP_DATA_DIR` (`~/.spotify-mcp`). Written at 0600, atomically (temp file, fsync, rename), and loaded through the shared sidecar policy in `src/sidecar.ts`: a missing file reads as an empty store, and a corrupt or truncated one is preserved at `<file>.corrupt[N]` and reported rather than reset. |
| `SPOTIFY_MCP_TASTE_FEEDBACK_MAX_ENTRIES` | `500` | Verdicts retained in the taste feedback store. Past this the oldest are evicted; the number dropped is persisted and reported, so a shrinking store never reads as an empty one. |
| `SPOTIFY_MCP_TASTE_FEEDBACK_MAX_BYTES` | `1048576` | Size cap for `taste-feedback.json`. Evicts oldest-first until the file fits, so raising `SPOTIFY_MCP_TASTE_FEEDBACK_MAX_ENTRIES` past what the byte cap allows cannot unbound the store. |
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

### Local files: reads and writes are confined

Every tool that writes a local file resolves its destination against a configured root — `SPOTIFY_MCP_EXPORT_DIR` for `export_playlist` and `export_profile_state`, `SPOTIFY_MCP_PORTABILITY_DIR` for the five `export_*` family tools. A relative `output_path` or `output_dir` resolves **inside** that root rather than against the process working directory; an absolute path outside it, a `..` escape, or a symlink leaving it is refused with the resolved path and the root in the message. `export_playlist` also refuses to replace an existing file unless you pass `overwrite: true`.

Reads are confined the same way, in reverse. `import_playlist` will read only from `SPOTIFY_MCP_PORTABILITY_DIR`, `SPOTIFY_MCP_BACKUP_DIR`, `SPOTIFY_MCP_EXPORT_DIR`, and anything you add to `SPOTIFY_MCP_ALLOW_PATHS`. Anything else, any non-regular file (directory, FIFO, socket, device), and any document over `SPOTIFY_MCP_MAX_DOCUMENT_MB` is refused before a byte is read.

Containment is decided on the *real* path — every component is resolved before the root comparison, so a symlink is collapsed rather than string-matched. Files are written with mode 600 and `O_NOFOLLOW`.

`SPOTIFY_HEADLESS=1` affects only the `auth` command. The auth URL is printed for a browserless host; complete it anywhere and paste the redirect URL back.

`SPOTIFY_SCOPES` accepts spaces or commas and rejects unknown scope names. When unset, the default scopes in `src/config.ts` are requested. A variable that is *set but names no scope* (`SPOTIFY_SCOPES=`, `SPOTIFY_SCOPES=" "`) also fails: it used to be read as "unset" and silently widened the request to all 17 default scopes, five of which are mutation scopes. Unset the variable instead of emptying it. The `auth` command's `--scopes` flag follows the same rule. `SPOTIFY_MCP_MARKET` accepts a two-letter ISO 3166-1 alpha-2 code; invalid values are ignored with a warning, and an explicit tool `market` argument takes precedence.

### Runtime limits and requests

`SPOTIFY_REQUEST_TIMEOUT_MS` applies an abort timer to every outbound Spotify request and token refresh. `SPOTIFY_MCP_MAX_ITEMS` sets the default list truncation cap; a call can still pass its own `max_results`. `SPOTIFY_MCP_FETCH_ALL_CAP` bounds `fetch_all=true` pagination and related scan walks; page explicitly with `limit`/`offset` when the cap is reached.

`SPOTIFY_MCP_FANOUT_CONCURRENCY` bounds how many of a scan's requests are outstanding at once. The freshness-radar tools used to issue them one at a time, so a 25-show `show_new_episodes` cost 25 serial round trips; they now overlap under this width. It is a concurrency bound and not a rate limiter — it never retries anything, and a 429 still stops the scan rather than being re-sent. The request count is the same either way, so raising it trades latency against burst size without changing what a call costs.

It is a **fallback, not the authority**. If `SPOTIFY_MCP_MAX_CONCURRENCY` is set — the request funnel's own width knob, from #892 — it wins: the radar tools read it first, so their `fanout_concurrency` reports that number and this variable has no effect on them. It is read on every build, merged funnel or not, so the precedence does not change shape when #892 lands; on the current serial client it simply acts as the tool-side width. Two knobs bounding the same quantity from different places would multiply rather than add — the narrower one would win silently, and no payload could report which — so they are deliberately kept in agreement instead. `fanout_concurrency_source` names the variable actually in force, which is how you tell a funnel-derived width from one you chose here.

### Mutation history

Set `SPOTIFY_MCP_HISTORY=1` to append one JSONL record per agent-driven mutation. `SPOTIFY_MCP_HISTORY_DIR` changes the directory; the file is `mutations.jsonl`. Records contain only the mutation method, path, and receipt/snapshot metadata — never tokens or request bodies.

**Rotation.** The ledger is bounded rather than cumulative. Before each append the live file's size is read, and if the existing size plus the incoming line would exceed `SPOTIFY_MCP_HISTORY_MAX_BYTES` (default **1 MiB**, i.e. `1048576` bytes), `mutations.jsonl` is renamed to `mutations.jsonl.1` and a fresh one is started. `rename(2)` replaces any existing archive atomically, so exactly one generation is kept and total on-disk history is bounded at roughly twice the threshold; the oldest records are what is lost, and the archive's owner-only mode is re-asserted on rotation because `rename` preserves the old inode's mode. The check happens per append, so a record can push the file just past the threshold before the next append rotates it. Rotation bounds what is kept *on disk*; it does not bound what a read returns, so `history_search` walks the tail by a fixed-size backward read that keeps at most 500 records in memory regardless of the file's size.

A value that is unset, empty, non-numeric, zero, or negative falls back to the default rather than disabling rotation, so a typo cannot turn a bounded ledger into a never-rotating one. This is the same intent as `SPOTIFY_MCP_BACKUP_RETENTION_DAYS`, but the two parse differently and the difference is worth knowing: retention is read with `Number()` and rejects a fractional value, while this threshold is read with `parseInt(…, 10)` and **truncates** it. `"2.5"` therefore means 2 bytes here, not the default, and surrounding whitespace is tolerated. Raise this only deliberately — a value below the size of a single record rotates the ledger on every append.

Each record's `who` field names the tool that issued the mutation (e.g. `add_to_playlist`), falling back to `agent` only when the call did not come through a tool. `history_search` matches on it, and the `spotify_doctor` row `history` reports the resolved ledger path, the live and archive sizes against the cap, the record count, and how many appends have been lost. A lost append never fails the mutation it describes, but it warns once per process on stderr and turns that doctor row red, because a trail with gaps otherwise reads as complete when it is not.

### Taste feedback store

`statsfm_record_feedback` stores verdicts locally and never touches the network. The store is a file, not process memory, so a verdict recorded in one session is still there in the next — and, because it is a file, it is bounded and it can be corrupted, both of which it now handles explicitly.

**The cap is three bounds, because no one of them is sufficient on its own.**

- **One record.** `subject` is capped at 200 characters and `note` at 500; every other field is an enum or a timestamp. This is the bound a count cap alone cannot supply: before it, a single `subject` was unbounded and could have flushed the whole store on its own.
- **A record count** — `SPOTIFY_MCP_TASTE_FEEDBACK_MAX_ENTRIES`, default 500. This is what bounds memory and the size of one `action=list` response.
- **A byte size** — `SPOTIFY_MCP_TASTE_FEEDBACK_MAX_BYTES`, default 1 MiB. Defence in depth: the on-disk promise that survives someone later raising the count or the field caps.

Eviction is oldest-first until all three hold, and the lifetime `recorded` and `evicted` counters are persisted. A store that quietly dropped your verdicts would otherwise read as an agent with no history.

**Retention is a ring buffer, not a TTL.** A verdict's value is that it is recent, but a TTL cannot bound a store an agent fills within a single session; it would add a clock read to every record and every list while leaving the count unbounded. (The mutation history uses byte rotation instead, because an append-only log of fixed small lines is the opposite shape — there the cap is enforced by rotating the file, not by rewriting it.)

**A corrupt or truncated store is preserved, not reset.** Loading follows the shared policy in `src/sidecar.ts` (#839, #1051), the same one the scene, genre-tag and playback-extension sidecars use: a missing file reads as an empty store, and every other read, parse or validation failure preserves the exact bytes at `<file>.corrupt` (or `<file>.corrupt.N`, opened `O_EXCL` so a later corruption cannot clobber an earlier preserved copy) at 0600 and reports the path. The original file is left where it is. Rotation and eviction make a malformed file *more* likely to appear, not less, so the write is built so that it does not create one.

**The write is atomic.** The store is a single JSON document, so a write that truncated the target in place and died mid-write would lose *every* record rather than one line. Instead: a uniquely named temp file in the same directory, `fsync`, then `rename(2)` over the target. The rename is the only mutation of the real path, so a crash before it leaves the previous store whole. The temp name carries the pid and random bytes because a fixed `<path>.tmp` is a race between concurrent `record_feedback` calls (#1135). A write that fails is **reported** as a failure — a verdict that reads as recorded but is not on disk is the #764 watchlist failure.

`spotify_doctor` reports both stores: the `history` row carries the ledger's sizes, cap and record count, and the taste-feedback row carries the store's path, how many verdicts are retained, and how many the cap has dropped.

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

`SPOTIFY_MCP_FRESHNESS_STATE` is the `whats_new` watermark. `SPOTIFY_MCP_FRESHNESS_BUDGET` limits artist album and show episode lookups; `max_artists` or the relevant per-call argument overrides it for one call. A truncated or quota-hit scan holds the watermark so a later `since: "last-check"` does not skip unseen items. The saved-show radar (`show_new_episodes`) uses this same budget unless `SPOTIFY_MCP_SHOWRADAR_BUDGET` is set, in which case that variable replaces it for that tool; a `max_shows` argument still wins for a single call, and the response states in prose which of the three was in force.

`SPOTIFY_MCP_SCENES_FILE` stores named device/volume/shuffle/repeat/context presets. `SPOTIFY_MCP_GENRE_TAGS_FILE` stores user-declared artist genre tags. `SPOTIFY_MCP_SEARCH_HISTORY_FILE`, `SPOTIFY_MCP_PLAYBACKEXT_FILE`, `SPOTIFY_MCP_EXHAUST2_PLAYBACK_FILE`, and `SPOTIFY_MCP_EXHAUST2_MISC_FILE` override their respective local sidecars.

A sidecar that exists but cannot be read is never reset. The file is left exactly as it is, a byte-for-byte copy is placed beside it as `<file>.corrupt` (or `<file>.corrupt.N` if that name is taken), and the tools that read it report the file and the parse failure instead of an empty result — `search_history`, `search_rerun` and `search_history_stats` answer with `error: "load_error"` and a `preserved_as` path, and report their counts as `null` rather than `0`. Writes into an unreadable store are refused rather than merged, so nothing is lost; searches run normally but are not recorded, and the number dropped is reported on the first read after the file is repaired. Repair the file (or move it aside) to resume recording. A sidecar that does not exist is a first run, not a corruption, and is not reported as one.

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
