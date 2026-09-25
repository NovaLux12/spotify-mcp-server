# Privacy Notice

This notice describes the data practices of the `spotify-mcp` server (the **Server**) when it is run locally. It is an operational disclosure, not legal advice or a representation that every deployment has the same host, configuration, or local-disk policy. The person or organization operating the Server is the controller for data processed by its configuration.

## Who runs the Server

The project does not operate a hosted Server, account portal, or analytics service. The process runs on the machine where an MCP host launches it. The project maintainer does not receive the local files, tokens, exports, or tool results described below merely because the Server is installed.

The Server is not affiliated with, sponsored by, endorsed by, or operated by Spotify AB. Spotify is a third-party beneficiary of the Server's [End User Agreement](END_USER_AGREEMENT.md) and this notice.

## Data categories and purposes

Depending on the tools and settings a host enables, the Server may handle:

- **Spotify account and authentication data:** the Spotify Client ID, OAuth authorization code during login, PKCE verifier/challenge, state value, access token, refresh token, expiry, granted scopes, and profile fields such as display name and email when the requested scope returns them. These are used to authenticate to Spotify, refresh access, and make the API calls the user or agent requested.
- **Spotify Content and personal listening/library data:** catalog metadata (tracks, albums, artists, shows, episodes, audiobooks, playlists, images, genres, identifiers, and links), playback state and queue context, recently played and listening history, saved library items, followed artists, playlists, and playback preferences. This is used to answer tool calls, search, display, modify playback or library state when explicitly requested, create exports/backups, calculate local previews, and verify mutations.
- **Agent instructions and tool results:** prompts, tool arguments, structured results, and the user's conversation context. The Server returns these to its local MCP host. A host may pass them to an LLM or another agent for interpretation; that host's provider, retention, training, and deletion policy then applies.
- **Local operational data:** mutation history, mutation receipts, playlist snapshots, listening reports, search history, freshness watermarks, device and volume presets, listening sessions, smart rules, show digests, bookmark/checkpoint state, and artist watchlists. These are used for audit, undo, cross-session continuity, personalization, freshness checks, and efficient tool operation.
- **stats.fm identifiers and query parameters:** when a `statsfm_*` tool is called, a stats.fm user ID or custom ID, search text, date/range bounds, limits, offsets, and the requested comparison identifiers. This is used only to request read-only stats.fm data.

The Server requests only the Spotify scopes needed for the enabled tools and the user's configuration. It does not intentionally request or process Spotify passwords. OAuth authorization and token refresh are handled with the Spotify Web API and the local token store described below.

## Local stores and paths

Unless an environment-variable override is supplied, the following paths are used. Overrides let an operator place a store elsewhere; the operator is responsible for protecting that location.

| Store (default path) | Data and purpose | Default writes and deletion |
|---|---|---|
| `~/.spotify-mcp/tokens.json` (or `tokens.<profile>.json`; `SPOTIFY_MCP_TOKEN_FILE`) | Access/refresh tokens, expiry, and scopes for authentication. | Written by `spotify-mcp auth` and token refresh. The file is created owner-only where the OS supports POSIX modes. Delete the file to disconnect the local profile. |
| `~/.spotify-mcp/history/mutations.jsonl` (`SPOTIFY_MCP_HISTORY_DIR`) | Timestamped mutation method, API path, actor label, and optional snapshot ID. It intentionally excludes request bodies and tokens. | Opt-in with `SPOTIFY_MCP_HISTORY`; appended for agent-driven mutations. Delete the file or its directory to remove history. |
| `~/.spotify-mcp/backups/*.json` (`SPOTIFY_MCP_BACKUP_DIR`) | Explicit library backups: saved tracks, albums, shows, episodes, audiobooks, followed artists, playlists, item URIs/names, counts, timestamps, and optional notes. | Written only by backup tools. Delete the selected backup file or directory after use. |
| `~/.spotify-mcp/playlist-snapshots/` (`SPOTIFY_MCP_SNAPSHOT_DIR`) | Playlist and playlist-health snapshots containing playlist/item IDs, names, timestamps, and counts used for diffs, audit, restore, and health reports. | Created by snapshot/playlist-health tools; files are owner-only where supported. Delete snapshots when no longer needed. |
| `~/.spotify-mcp/scenes.json` (`SPOTIFY_MCP_SCENES_FILE`) | Named playback scenes: device hint, volume, shuffle/repeat, and context URI. | Written by scene tools. Delete the file to remove scenes. |
| `~/.spotify-mcp/genre-tags.json` (`SPOTIFY_MCP_GENRE_TAGS_FILE`) | User/artist genre tags used for local library insights and recommendations. | Written when tags are added. Delete the file to remove the tags. |
| `~/.spotify-mcp/playback-ext.json` (`SPOTIFY_MCP_PLAYBACKEXT_FILE`) | Saved playback states, device/volume presets, listening sessions, smart rules, and show digest. | Written by playback extension tools. Delete the file to remove this state. |
| `~/.spotify-mcp/search-history.json` (`SPOTIFY_MCP_SEARCH_HISTORY_FILE`) | Search terms and timestamps used to provide search-history tools. | Written when search history is enabled/used. Delete the file to remove it. |
| `~/.spotify-mcp/freshness.json` (`SPOTIFY_MCP_FRESHNESS_STATE`) | UTC `last_check` watermark for freshness scans. | Advanced after successful non-dry scans. Delete the file to reset the watermark. |
| `~/.spotify-mcp/portability/` (`SPOTIFY_MCP_PORTABILITY_DIR`) | Explicit JSON/CSV exports such as `library.json`, `followed_artists.json`, and `listening_history.json`, including the library/listening categories and export timestamps. | Written only by portability/export tools. Delete the export files or directory when no longer needed. |
| `~/.spotify-mcp/exports/profile-state-*.json` | Profile-state exports and included local sidecar state. | Written only by the profile-state export tool. Delete the export file after use. |
| `~/.spotify-mcp/exhaust2-misc.json` (`SPOTIFY_MCP_EXHAUST2_MISC_FILE`) | Taste checkpoints, chapter bookmarks, listening journal, and archived monthly reports. | Written by the corresponding tools. Delete the file to remove them. |
| `~/.spotify-mcp/exhaust2-playback.json` (`SPOTIFY_MCP_EXHAUST2_PLAYBACK_FILE`) | Mute memory, playback timers, and local playback checkpoints. | Written by playback tools. Delete the file to remove them. |
| `./data/artist-watchlist.json` (or `SPOTIFY_MCP_DATA_DIR/artist-watchlist.json`) | Artist names, watchlist creation/check timestamps, and seen release identifiers. | Written by artist-watch tools. Delete the file or configured data directory to remove it. |

`SPOTIFY_MCP_DATA_DIR` can also redirect playlist-health snapshots; the default remains `~/.spotify-mcp/playlist-snapshots`. `SPOTIFY_MCP_PORTABILITY_DIR` redirects both portability and listening-history exports. The in-memory mutation receipt store is capped at 100 entries with FIFO eviction and disappears when the process exits; it is not a durable store.
Export tools can also write to a user-supplied `output_path` (playlist export) or `output_dir` (library/listening/profile-state portability exports), outside the defaults above. The user or operator choosing that path is responsible for its protection, retention, sharing, and deletion.

Playlist exports written by `export_playlist` are **user-managed and have no expiry**. The file is an unredacted Spotify Content compilation — title, artists, album, duration, and URI per row — and the tool result reports its absolute `output_path_resolved` together with a `retention_note` stating that the user must delete it. Nothing in this Server removes such a file afterwards: removing the token file and stopping the Server — the disconnect mechanism described below — clears credentials and Server-side stores only, never a document an export tool wrote. Deleting an export is a separate, user-initiated step, and it does not cover the copies the file's location may have produced elsewhere.

If the resolved path lands inside a client-side cloud-sync directory — `~/Dropbox`, `~/Google Drive` or `~/GoogleDrive`, `~/OneDrive`, or `~/Library/Mobile Documents` (iCloud Drive) — the tool result carries a `cloud_sync_warning` naming that directory, because the file is then uploaded to that provider and retained under its own policy rather than only on this machine. Removing the local copy does not remove the provider's.

The Server does not intentionally keep a general network response cache. User-requested backups, snapshots, sidecars, and exports are the durable local copies. They are not a substitute for Spotify's service and should be kept only as long as needed. Pagination and `SPOTIFY_MCP_FETCH_ALL_CAP` limit collection, and results returned inline are bounded by the configured result cap; these limits reduce but do not eliminate sensitive data exposure.

## How Spotify data reaches an LLM or agent

The Server is an MCP tool provider, not the model host. When an agent asks for a tool result, the Server sends the result through the local MCP transport to that host. The host may place the result in a model prompt/context, a transcript, a log, a vector store, or an application database. The Server cannot inspect or control that subsequent handling.

Accordingly:

- A tool result can contain Spotify Content and Spotify Personal Data, including identifiers, metadata, library and listening information, and error text.
- The user must review the MCP host's provider, retention, training, access-control, and deletion settings before allowing an LLM or agent to use the Server.
- The Server does **not** claim to prevent model training or onward retention. The host and its provider are responsible for those choices and for obtaining any required permissions.
- Do not put access tokens, refresh tokens, raw credential material, or unnecessary personal data into prompts. Use the smallest tool result and scope needed for the task.

## Network recipients and transfers

### Spotify

Spotify account, library, playback, and catalog requests go to `api.spotify.com` and the Spotify OAuth endpoints at `accounts.spotify.com` using the configured OAuth flow. Spotify receives the API requests necessary to perform the selected tool and applies its own account, privacy, and security practices. The Server does not send these local stores to the project maintainer.

### stats.fm (third party)

The `statsfm_*` tools use `https://api.stats.fm/api/v1` without Spotify OAuth. A request sends the stats.fm user ID or custom ID supplied by the caller and query parameters needed for the requested read (for example, range, limits, offsets, date bounds, or search text). The Server does not send Spotify tokens or Spotify API response bodies to stats.fm. The returned profile, aggregate, stream, clock, or taste data is shown to the caller and may then enter the MCP host's context under the preceding LLM section.

stats.fm is an independent third party. Its public profiles and any data it exposes are subject to its service:

- [stats.fm Terms](https://stats.fm/terms)
- [stats.fm Privacy Policy](https://stats.fm/privacy/)

A public stats.fm profile can be queried by its ID; private profiles may expose less data. The caller is responsible for having permission and a lawful basis to query another person's profile. Disconnecting or deleting the local Server does not delete data held by stats.fm; use stats.fm's own controls and contact route for that service.

No other third-party advertising, data-broker, or monetization transfer is implemented by this Server. A deployment that wraps the Server, telemetry layer, proxy, or host must disclose and authorize its own transfers separately.

## Cookies and browser authentication

The Server process does not set advertising or analytics cookies and does not place third-party cookies on a user's browser. The OAuth browser flow visits Spotify's authorization pages, and a stats.fm user may visit stats.fm directly; those services may use their own cookies and privacy controls. This local Server does not read or combine those browser cookies with local stores.

## Retention, deletion, and access controls

There is no automatic age-based expiry for the durable local stores in this release. Retention is therefore user- and operator-controlled: use the smallest scopes, enable only needed tools, keep exports/backups/snapshots only as long as needed, and delete files when the purpose ends. The default `SPOTIFY_MCP_MAX_ITEMS` is 50, `SPOTIFY_MCP_FETCH_ALL_CAP` is 500, and individual result limits may be lower; these are collection/result caps, not a promise that all data is anonymized.

To disconnect the local Spotify profile, remove the relevant token file (`SPOTIFY_MCP_TOKEN_FILE` or the default/profile path) and stop the MCP Server. To erase a local store, stop the Server and delete the corresponding path above; also remove copies created by exports, backups, snapshots, the host's logs/transcripts, and any LLM or vector store. A host's retention and deletion controls must be used for data that left the process through MCP results.

Disconnecting a profile — removing the token file and stopping the Server, as described above — does not reach exports: they are written to the export, portability, or caller-chosen `output_path`/`output_dir` location, which is deliberately outside the token and history paths. A deployment that wants exports gone on disconnect must delete those files itself (or point the export root at a directory it wipes), and must also reach the copies held by any cloud-sync provider named above.

On account disconnection or an instruction to stop access, stop requesting and processing the account's Spotify Personal Data and delete local copies promptly. The current Spotify Developer Terms set a five-day deletion deadline for data following account disconnection and require deletion of Spotify Content obtained through the Platform when the Developer Terms terminate. A security incident is a different clock: the project will notify Spotify at `security@spotify.com` without undue delay and in any event within **24 hours** of becoming aware of or reasonably suspecting that Spotify Personal Data was or may have been lost, damaged, or accessed without authorization. This 24-hour duty is a notification deadline, not permission to retain data for 24 hours; deletion is not delayed while waiting for that notice. See [SECURITY.md](SECURITY.md#regulatory-and-third-party-notifications) for the reporting and incident process.

Users may request access, correction, erasure, restriction, or a copy of data held by the local operator by contacting that operator. Requests concerning Spotify's own processing should also be directed to Spotify through its privacy channels. The Server maintainer cannot retrieve a user's local files or host transcripts on the user's behalf.

## Security and content limits

Where implemented, tokens and selected local stores use owner-only file and directory modes where the operating system supports them, and token writes are atomic. These are safeguards, not a guarantee against a compromised host, an overly-permissive backup, or another process running as the same user. Operators must apply OS account isolation, disk encryption, least privilege, secure host configuration, and secret management to every store.

Spotify Content must not be used to train a machine-learning or AI model, ingested into one, or used to build unrelated derived listenership/user metrics or advertising audiences. Do not use the Server to circumvent Spotify privacy features, geographical restrictions, quotas, or access controls, and do not use it for stream ripping or unauthorized capture. The Server is intended for personal, authorized API operations and should not be used for public/commercial broadcasting or an integrated product that violates Spotify's current Developer Terms or Developer Policy.

## Changes and contact

This notice may change with the Server's data paths or the applicable Spotify terms. Review the current repository copy before installing a new release. For questions about the project or a suspected security incident, use the channels in [SECURITY.md](SECURITY.md). For privacy questions about data processed by a particular deployment, contact the person or organization that configured and runs that deployment; the project maintainer cannot see its local stores.
