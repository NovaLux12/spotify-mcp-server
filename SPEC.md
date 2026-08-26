# SpotifyMCP — Specification

A Model Context Protocol (MCP) server that gives Claude full control over Spotify — playback, search, library management, playlist curation, and music discovery.

---

## Table of Contents

1. [Goals & Non-Goals](#1-goals--non-goals)
2. [Architecture](#2-architecture)
3. [Authentication](#3-authentication)
4. [Implementation Contracts](#4-implementation-contracts)
5. [Tools](#5-tools)
6. [Resources](#5-resources)
7. [Prompts](#6-prompts)
8. [Error Handling](#7-error-handling)
9. [Rate Limiting](#8-rate-limiting)
10. [Spotify API Constraints](#9-spotify-api-constraints)
11. [Project Structure](#10-project-structure)
12. [Configuration](#11-configuration)
13. [Claude Desktop Integration](#12-claude-desktop-integration)

---

## 1. Goals & Non-Goals

### Goals
- Let Claude control playback on any active Spotify device
- Let Claude search, discover, and recommend music via natural language
- Let Claude read and manage the user's library and playlists
- Provide personalization context (top tracks, top artists, recently played) so Claude understands the user's taste
- Work with Claude Desktop via stdio transport
- Simple one-time OAuth setup; silent token refresh thereafter

### Non-Goals
- Audio streaming or analysis (Spotify does not provide audio via Web API)
- Web UI or dashboard
- Multi-user / SaaS hosting
- Lyrics (separate licensed product)
- Spotify Connect SDK (hardware/native integration)

---

## 2. Architecture

### Transport
**stdio** — the server runs as a local child process. Claude Desktop spawns it via `npx` or an installed binary. No port binding, no network exposure.

### Stack
| Layer | Choice | Reason |
|---|---|---|
| Language | TypeScript | MCP SDK is TypeScript-first; strong typing for Spotify response shapes |
| Runtime | Node.js 22.9+ (`--env-file-if-exists`) | Native fetch, no polyfills needed |
| MCP SDK | `@modelcontextprotocol/sdk` | Official SDK, handles protocol framing |
| HTTP client | Native `fetch` | No dependencies; Spotify API is simple REST |
| Token storage | `~/.spotify-mcp/tokens.json` (path overridable via `SPOTIFY_MCP_TOKEN_FILE`) | Local file, user-owned, outside repo |
| Auth callback server | Node.js built-in `http` | No Express needed; handles one redirect then closes |
| Browser launch | `open` package | Opens auth URL in default browser cross-platform |

### Dependencies

```json
{
  "type": "module",
  "dependencies": {
    "@modelcontextprotocol/sdk": "latest",
    "open": "^10.0.0",
    "zod": "^3.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.0.0"
  },
  "scripts": {
    "build": "tsc && node scripts/add-shebang.js",
    "dev": "node --import tsx/esm src/index.ts",
    "auth": "node --import tsx/esm src/index.ts auth",
    "start": "node dist/index.js"
  }
}
```

> `zod` is used for MCP tool input schema definitions. `tsx` is a dev dependency for running TypeScript directly without a build step.

`scripts/add-shebang.js` is a small ESM helper run after `tsc`:
```js
// scripts/add-shebang.js
import { readFileSync, writeFileSync } from 'fs';
const file = 'dist/index.js';
const content = readFileSync(file, 'utf8');
if (!content.startsWith('#!')) {
  writeFileSync(file, '#!/usr/bin/env node\n' + content);
}
```

### Data flow
```
Claude Desktop
    │  stdio (JSON-RPC)
    ▼
SpotifyMCP server (Node.js process)
    │  HTTPS REST + Bearer token
    ▼
Spotify Web API (api.spotify.com)
```

---

## 3. Authentication

### Flow
1. User runs `npm run auth` locally (or `SPOTIFY_CLIENT_ID=… npx -y @novalux12/spotify-mcp@latest auth`)
2. Server starts a temporary HTTP listener on `127.0.0.1:8888`
3. Opens `https://accounts.spotify.com/authorize` in the browser with PKCE
4. User approves; Spotify redirects to `127.0.0.1:8888/callback`
5. Server exchanges code for access + refresh tokens
6. Tokens saved to `~/.spotify-mcp/tokens.json` (mode 600)
7. On each API call: if access token is expired, silently refresh and persist

### OAuth scopes requested

```
user-read-private
user-read-email
user-read-playback-state
user-modify-playback-state
user-read-currently-playing
user-read-recently-played
user-read-playback-position
user-top-read
user-library-read
user-library-modify
user-follow-read
user-follow-modify
playlist-read-private
playlist-read-collaborative
playlist-modify-public
playlist-modify-private
ugc-image-upload
```

> Note: `streaming` is **not** included — that scope is for the browser-based Spotify Web Playback SDK, not the Web API. Playback control via the Web API requires `user-modify-playback-state` (already included above).
> Note: `ugc-image-upload` IS requested by default (needed for `upload_playlist_cover`), but Spotify additionally requires enabling it on the developer-dashboard app — otherwise uploads fail with 403.

### PKCE implementation notes

- Generate a `code_verifier`: 32 random bytes, base64url-encoded (no padding)
- Derive `code_challenge`: SHA-256 hash of `code_verifier`, base64url-encoded
- Generate a `state`: 16 random bytes, base64url-encoded — verify it matches on callback to prevent CSRF
- Authorization URL params: `response_type=code`, `client_id`, `redirect_uri`, `scope`, `code_challenge_method=S256`, `code_challenge`, `state`
- Token exchange: POST to `https://accounts.spotify.com/api/token` with body `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `code_verifier`. **Do NOT include `client_secret`** — PKCE does not use it. Content-Type must be `application/x-www-form-urlencoded`.
- Token refresh: POST to `https://accounts.spotify.com/api/token` with body `grant_type=refresh_token`, `refresh_token`, `client_id`. Content-Type must be `application/x-www-form-urlencoded`.
- Compute `expires_at` from the response: `expires_at = Date.now() + expires_in * 1000` (Spotify returns `expires_in` in seconds).
- After receiving the OAuth callback, send an HTTP 200 response to the browser (e.g., `<h1>Authentication successful. You can close this tab.</h1>`) before closing the server.
- Use Node.js built-in `http` module for the callback server (no Express dependency)
- Use the `open` package to launch the authorization URL in the default browser

### Token file schema
```json
{
  "access_token": "...",
  "refresh_token": "...",
  "expires_at": 1712345678000
}
```

### Environment variables (required)
```
SPOTIFY_CLIENT_ID      — from developer.spotify.com app dashboard
SPOTIFY_REDIRECT_URI   — http://127.0.0.1:8888/callback (default)
SPOTIFY_MCP_TOKEN_FILE — optional; overrides the token storage path (default ~/.spotify-mcp/tokens.json)
```

> Note: `SPOTIFY_CLIENT_SECRET` is **not used** with the PKCE flow. Only `SPOTIFY_CLIENT_ID` is needed in code. The client secret exists in the Spotify dashboard but is never sent by this application.
> Browserless environments: set `SPOTIFY_HEADLESS=1` for the paste-flow auth (no local callback server). The full `SPOTIFY_*` configuration family — request timeouts, truncation caps, fetch-all cap, mutation history — is listed under [Configuration](#11-configuration).

---

## 4. Implementation Contracts

### 4.0.1 Entry point / CLI structure

`src/index.ts` is the MCP server plus a small command-line surface (`auth`, `doctor`, `--help`, `--version`), dispatched on `process.argv[2]`:

```ts
const command = process.argv[2];
if (command === 'auth') {
  // Run OAuth flow, save tokens, exit
  await runAuthFlow();
} else if (command === 'doctor') {
  // Print resolved config, token state/expiry, then a live authenticated
  // GET /me probe; exit non-zero when anything fails (#62)
  await runDoctor();
} else {
  // Start MCP server over stdio (the default)
  await startMcpServer();
}
```

`package.json` bin field:
```json
{ "bin": { "spotify-mcp": "dist/index.js" } }
```

`tsconfig.json` essentials:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true
  }
}
```

The compiled output must have `#!/usr/bin/env node` as the first line of `dist/index.js` (add via a build script or banner).

---

### 4.0.2 MCP server wiring

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createRequire } from 'node:module';

const { version } = createRequire(import.meta.url)('../package.json'); // single source of truth
const server = new McpServer({
  name: 'spotify-mcp',
  version,
});

// Register a tool
server.tool(
  'play',                          // tool name
  'Start or resume playback',      // description
  {                                // input schema (Zod object shape)
    context_uri: z.string().optional(),
    uris: z.array(z.string()).optional(),
    device_id: z.string().optional(),
  },
  async (args) => {                // handler — receives validated args
    await spotify.play(args);
    return { content: [{ type: 'text', text: 'Playback started.' }] };
  }
);

// Register a resource
server.resource(
  'spotify://player/state',
  'Current Spotify playback state',
  async () => ({
    contents: [{ uri: 'spotify://player/state', text: JSON.stringify(await spotify.getNowPlaying()) }]
  })
);

// Connect stdio transport and start listening
const transport = new StdioServerTransport();
await server.connect(transport);
```

**Tool module pattern** — each tool file exports a single registration function:
```ts
// tools/playback.ts
export function registerPlaybackTools(server: McpServer, client: SpotifyClient): void {
  server.tool('play', 'Start or resume playback', { ... }, async (args) => { ... });
  server.tool('pause', 'Pause playback', { ... }, async (args) => { ... });
  // ...
}
```

`src/index.ts` imports and calls all registration functions:
```ts
import { registerPlaybackTools } from './tools/playback.js';
import { registerSearchTools } from './tools/search.js';
// ...

const client = new SpotifyClient(); // singleton, holds tokens in memory

registerPlaybackTools(server, client);
registerSearchTools(server, client);
// ...
```

**Tool result format** — every tool handler must return:
```ts
{ content: [{ type: 'text', text: string }] }
```
For errors, throw an `Error` — the SDK converts it to an MCP error response automatically. Do not return error strings inside `content`.

---

### 4.0.3 SpotifyClient contract

All Spotify API calls go through a single `SpotifyClient` instance. Its responsibilities:

- **Base URL**: `https://api.spotify.com/v1`
- **Token injection**: attach `Authorization: Bearer <access_token>` to every request
- **Pre-request token check**: if `Date.now() >= expires_at - 60_000` (1 minute buffer), refresh before sending
- **Rate limit queue**: maintain an internal queue; enforce minimum 100ms between dispatched requests; on 429 drain the queue for `Retry-After` seconds
- **Response parsing**: throw a typed `SpotifyApiError` on non-2xx with `status` and `message` from the Spotify error body
- **Token memory management**: The `SpotifyClient` holds the token state in memory (not read from disk on every request). On initialization it reads `~/.spotify-mcp/tokens.json`. On successful refresh it updates its in-memory state AND writes back to disk. This ensures the long-running MCP server process doesn't repeatedly hit disk.
- **Request timeouts**: every outbound HTTP call (API requests and token refresh) carries an `AbortSignal.timeout` — 30 s by default, overridable via `SPOTIFY_REQUEST_TIMEOUT_MS`. Expiry raises a 408-style `SpotifyApiError` so a hung connection can never stall the serialised queue.
- **Read cache**: immutable catalog reads go through an LRU TTL cache (~5-minute entry lifetime, 200 entries max); mutations and player calls bypass it.
- **Rate-limit visibility**: the most recent 429 (`Retry-After` seconds, wait time, timestamp) is retained on the client, exposed via the `spotify://me/rate-limit` resource, and appended as a notice to the throttled call's result.
- **Mutation history**: when `SPOTIFY_MCP_HISTORY=1`, successful mutations append a whitelisted record (method, path, `snapshot_id` when present) to `~/.spotify-mcp/history/mutations.jsonl` (directory overridable via `SPOTIFY_MCP_HISTORY_DIR`). History failures never fail the underlying mutation.
- **Pagination walks**: `getAllPages` walks offset-paginated endpoints up to `SPOTIFY_MCP_FETCH_ALL_CAP`, accepts an `initialOffset` so callers can resume mid-list, and reports per-page progress — wired in `index.ts` to MCP progress notifications.

Minimal interface:
```ts
class SpotifyClient {
  async get<T>(path: string, params?: Record<string, string>): Promise<T | null>
  async post<T>(path: string, body?: unknown): Promise<T | null>
  async put<T>(path: string, body?: unknown): Promise<T | null>
  async delete<T>(path: string, body?: unknown): Promise<T | null>
  async putRaw(path: string, body: string, contentType?: string): Promise<void>
  async getAllPages<T>(path: string, params?: Record<string, string>, opts?: { maxItems?: number; initialOffset?: number }): Promise<T[]>
}
```

`get` appends `params` as query string; all methods prepend the base URL. The mutators return the parsed JSON response or `null` when Spotify replies `204 No Content`.

---

### 4.0.4 Spotify API endpoint reference

Quick reference for all endpoints used. All paths are relative to `https://api.spotify.com/v1`. Consult the OpenAPI schema for full parameter details.

| Tool | Method | Path |
|---|---|---|
| `get_now_playing` | GET | `/me/player` — returns 204 (no body) when nothing is playing; handle gracefully |
| `get_currently_playing` | GET | `/me/player/currently-playing` |
| `play` | PUT | `/me/player/play` |
| `pause` | PUT | `/me/player/pause` |
| `skip_next` | POST | `/me/player/next` |
| `skip_previous` | POST | `/me/player/previous` |
| `seek` | PUT | `/me/player/seek` |
| `set_volume` | PUT | `/me/player/volume` |
| `set_shuffle` | PUT | `/me/player/shuffle` |
| `set_repeat` | PUT | `/me/player/repeat` |
| `get_queue` | GET | `/me/player/queue` |
| `add_to_queue` | POST | `/me/player/queue` |
| `get_devices` | GET | `/me/player/devices` |
| `transfer_playback` | PUT | `/me/player` |
| `play_from_search` | GET + PUT | `/search`, then `/me/player/play` — combined helper |
| `search` | GET | `/search` |
| `get_me` | GET | `/me` |
| `get_user_profile` | GET | `/users/{user_id}` |
| `get_user_playlists_by_id` | GET | `/users/{user_id}/playlists` |
| `get_track` | GET | `/tracks/{id}` |
| `get_several_tracks` | GET | `/tracks?ids=…` — up to 50 per request; longer lists chunked and merged |
| `get_artist` | GET | `/artists/{id}` |
| `get_artist_top_tracks` | GET | `/artists/{id}/top-tracks` — market-gated; 403 if not enabled for the app registration |
| `get_artist_albums` | GET | `/artists/{id}/albums` |
| `get_several_artists` | GET | `/artists?ids=…` — up to 50 per request |
| `get_album` | GET | `/albums/{id}` |
| `get_album_tracks` | GET | `/albums/{id}/tracks` |
| `get_several_albums` | GET | `/albums?ids=…` — up to 20 per request |
| `get_show` | GET | `/shows/{id}` |
| `get_show_episodes` | GET | `/shows/{id}/episodes` |
| `get_several_shows` | GET | `/shows?ids=…` — up to 50 per request |
| `get_episode` | GET | `/episodes/{id}` |
| `get_several_episodes` | GET | `/episodes?ids=…` — up to 50 per request |
| `get_audiobook` | GET | `/audiobooks/{id}` — market defaults to profile country |
| `get_audiobook_chapters` | GET | `/audiobooks/{id}/chapters` |
| `get_chapter` | GET | `/chapters/{id}` |
| `get_several_audiobooks` | GET | `/audiobooks?ids=…` |
| `get_several_chapters` | GET | `/chapters?ids=…` |
| `get_available_markets` | GET | `/markets` |
| `get_top_tracks` | GET | `/me/top/tracks` |
| `get_top_artists` | GET | `/me/top/artists` |
| `get_recently_played` | GET | `/me/player/recently-played` |
| `get_saved_tracks` | GET | `/me/tracks` (`fetch_all` walks all pages) |
| `get_saved_albums` | GET | `/me/albums` |
| `get_saved_shows` | GET | `/me/shows` |
| `get_saved_episodes` | GET | `/me/episodes` |
| `get_saved_audiobooks` | GET | `/me/audiobooks` — market-gated to US/UK/CA/IE/NZ/AU |
| `save_items` | PUT | partitions URIs by type: `/me/tracks`, `/me/albums`, `/me/episodes` (body `{ids}`); `/me/shows?ids=…`, `/me/audiobooks?ids=…` (query only) |
| `remove_saved_items` | DELETE | same per-type paths as `save_items`; supports `dry_run` |
| `check_saved_items` | GET | `/me/{tracks\|albums\|shows\|episodes\|audiobooks}/contains?ids=…` per type |
| `save_to_library` | PUT | `/me/library?uris=…` — any mix of track/album/episode/show/audiobook/user/playlist URIs |
| `remove_from_library` | DELETE | `/me/library?uris=…`; supports `dry_run` |
| `check_in_library` | GET | `/me/library/contains?uris=…` — also covers artist/user/playlist follow state |
| `get_user_playlists` | GET | `/me/playlists` |
| `get_playlist` (metadata + items) | GET | `/playlists/{id}`, then `/playlists/{id}/items` (plus `/playlists/{id}/images` when no cover is embedded) |
| `get_playlist_items` | GET | `/playlists/{id}/items` |
| `create_playlist` | POST | `/me/playlists` |
| `add_to_playlist` | POST | `/playlists/{id}/items` |
| `remove_from_playlist` | DELETE | `/playlists/{id}/items` |
| `update_playlist` | PUT | `/playlists/{id}` |
| `reorder_playlist_items` | PUT | `/playlists/{id}/items` |
| `replace_playlist_items` | PUT + POST | first ≤100 via `PUT /playlists/{id}/items`, remainder appended via `POST /playlists/{id}/items` in chunks of 100 |
| `find_duplicates_in_playlist` | GET | `/playlists/{id}/items` — walks every page |
| `get_playlist_cover` | GET | `/playlists/{id}/images` |
| `upload_playlist_cover` | PUT | `/playlists/{id}/images` — raw base64 JPEG body; requires optional `ugc-image-upload` scope |
| `get_followed_artists` | GET | `/me/following?type=artist` — cursor-based pagination: `after` is the artist ID of the last returned item, not a numeric offset |
| `follow_artists` | PUT | `/me/following?type=artist&ids=…` |
| `unfollow_artists` | DELETE | `/me/following?type=artist&ids=…` |
| `check_following_artists` | GET | `/me/following/contains?type=artist&ids=…` — bare artist IDs |

---

## 5. Tools

154 registered tools across thirty-eight tool modules riding nine registration keys (playback, search, catalog, personalization, library, following, audiobooks, playlists, and users), plus the unconditional `spotify_doctor` diagnostic and top-level `verify_receipt`. All tools return a structured result object; errors surface as MCP tool errors with a human-readable message.

### Shared tool contract

Beyond their endpoint-specific arguments, every tool shares this contract:

- **`response_format`** (`'concise' | 'detailed' | 'json'`, default `'concise'`) — `'concise'` renders human-readable prose, `'detailed'` appends fields the concise view drops, and `'json'` returns the raw API payload as JSON text.
- **`structuredContent`** — every result attaches its machine-readable payload as MCP structuredContent alongside the human-readable text.
- **`max_results`** (list-type tools; positive integer, ≤ 2000) — per-call truncation cap. The default comes from `SPOTIFY_MCP_MAX_ITEMS` (50). Truncated lists state how many items were withheld; pagination info (total / offset / next offset) rides in structuredContent and a footer hints at the next page.
- **`fetch_all`** (paged reads) — walk every page via `client.getAllPages`, capped by `SPOTIFY_MCP_FETCH_ALL_CAP` (500). Long walks emit MCP progress notifications per page.
- **`dry_run`** (destructive operations) — validate inputs and describe exactly what would change without calling the mutating endpoint.
- **Batch summaries** — mutations echo a "{n} items affected: uri0, uri1, …" line (first three URIs), and playlist mutations include Spotify's returned `snapshot_id` for optimistic-locking follow-ups.


### 5.1 Playback

#### `get_now_playing`
Get the currently playing track or episode and full playback state.

**Returns:** track/episode name, artists, album, album art URL, progress ms, duration ms, is_playing, shuffle_state, repeat_state, device name/type, volume. Returns a "Nothing is currently playing" message when the API responds with 204 No Content (do not attempt to parse a body from 204 responses).

---

#### `get_currently_playing`
Lightweight poll of what is playing right now — the item, progress, and playing state only (no full playback context).

**Returns:** track/episode name, artists/show, progress ms, is_playing. Returns a "Nothing is currently playing" message when the API responds with 204 No Content.

---

#### `play`
Start or resume playback. Optionally target specific content.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `context_uri` | string | no | Spotify URI for album, artist, or playlist to play |
| `uris` | string[] | no | Up to 100 track/episode URIs to play as an ad-hoc queue |
| `offset` | number | no | Index within context to start from |
| `offset_uri` | string | no | Track URI inside the context to start from — required for artist contexts, where a numeric index is rejected |
| `position_ms` | number | no | Seek position to start at |
| `device_id` | string | no | Target device; uses active device if omitted |

---

#### `pause`
Pause playback on the active device.

**Inputs:** `device_id` (optional)

---

#### `skip_next`
Skip to the next track in the queue or context.

**Inputs:** `device_id` (optional)

---

#### `skip_previous`
Skip to the previous track. If >3 seconds in, restarts current track first.

**Inputs:** `device_id` (optional)

---

#### `seek`
Seek to a position in the current track.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `position_ms` | number | yes | Position in milliseconds |
| `device_id` | string | no | |

---

#### `set_volume`
Set playback volume.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `volume_percent` | number | yes | 0–100 |
| `device_id` | string | no | |

---

#### `set_shuffle`
Enable or disable shuffle mode.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `state` | boolean | yes | true = shuffle on |
| `device_id` | string | no | |

---

#### `set_repeat`
Set repeat mode.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `state` | `"off"` \| `"context"` \| `"track"` | yes | |
| `device_id` | string | no | |

---

#### `get_queue`
Get the current playback queue.

**Returns:** currently playing item, plus the up-next list (name, artist, duration, URI) truncated to `max_results` with pagination info in structuredContent.

---

#### `add_to_queue`
Add a track or episode to the end of the queue.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `uri` | string | yes | Spotify track or episode URI |
| `device_id` | string | no | |

---

#### `get_devices`
List available Spotify Connect devices.

**Returns:** array of devices with id, name, type (computer/smartphone/speaker), is_active, volume_percent.

---

#### `transfer_playback`
Move playback to a different device.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `device_id` | string | yes | Target device ID |
| `play` | boolean | no | Force play immediately (default: maintain current state) |

---

#### `play_from_search`
Search for a track or episode by name and start playing it — combines `search` and `play` into one call.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | Search text, e.g. a song title or podcast episode name |
| `type` | `"track"` \| `"episode"` | no | What to search for. Default: `"track"` |
| `device_id` | string | no | Target device; uses active device if omitted |

---

### 5.2 Search

#### `search`
Search Spotify's catalog.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | Search query |
| `types` | string[] | no | Any of `track`, `artist`, `album`, `playlist`, `show`, `episode`, `audiobook`. Default: `["track","artist","album"]`. (`audiobook` only in US/UK/CA/IE/NZ/AU markets) |
| `limit` | number | no | Results per type, 1–50. Default: 5 |
| `market` | string | no | ISO 3166-1 alpha-2 country code |
| `offset` | number | no | Index of the first result to return, 0–1000 — use with `limit` to page through results |
| `include_external` | string | no | Pass `"audio"` to include externally-hosted audio items marked as playable |

**Returns:** grouped results by type. Each item includes URI, name, and type-specific fields (artist names, album name, release date, duration, etc.).

---

### 5.3 Catalog Lookup

#### `get_track`
Get full details for a track by URI or ID.

**Inputs:** `id` (string, required)

**Returns:** name, artists, album, duration_ms, explicit, URI.

---

#### `get_artist`
Get artist info.

**Inputs:** `id` (string, required)

**Returns:** name, genres, URI. (Note: `popularity` and `followers` removed in Feb 2026.)

---

#### `get_artist_albums`
List an artist's albums and singles.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Artist ID |
| `include_groups` | string[] | no | `album`, `single`, `appears_on`, `compilation`. Default: `["album","single"]` |
| `limit` | number | no | 1–50. Default: 20 |

---

#### `get_album`
Get album details and track list.

**Inputs:** `id` (string, required)

**Returns:** name, artists, release_date, total_tracks, tracks (name, duration, URI), URI.

---

#### `get_album_tracks`
List an album's tracks with pagination.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Album ID |
| `limit` | number | no | 1–50. Default: 20 |
| `offset` | number | no | Pagination offset |

**Returns:** track name, artists, duration_ms, URI; plus total track count.

---

#### `get_me`
Get the current user's Spotify profile.

**Returns:** display name, user ID, email (requires `user-read-email`), country and subscription level (require `user-read-private`), URI.

---

#### `get_show`
Get full details for a podcast show.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Show ID |
| `market` | string | no | ISO 3166-1 alpha-2 country code |

**Returns:** name, description, publisher, explicit, total_episodes, languages, media_type, URI, first page of episodes (name, duration_ms, release_date, resume_point, URI).

---

#### `get_episode`
Get full details for a podcast episode.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Episode ID |
| `market` | string | no | |

**Returns:** name, description, duration_ms, release_date, explicit, languages, resume_point (position_ms + fully_played), audio_preview_url, show name, URI.

---

#### `get_show_episodes`
List a podcast show's episodes with pagination. Resume positions require the `user-read-playback-position` scope.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Show ID |
| `limit` | number | no | 1–50. Default: 20 |
| `offset` | number | no | Pagination offset |

**Returns:** episode name, description, duration_ms, release_date, resume_point, URI; plus total episode count.

#### `get_artist_top_tracks`
Get an artist's ten most-played tracks for a market.

**Inputs:** `id` (string, required), `market` (string, optional — defaults to the account's country from `GET /me`)

A 403 here usually means the endpoint isn't enabled for this app registration or a required scope is missing; the error says so explicitly.

---

#### `get_available_markets`
List the country codes of every market where Spotify is available — useful for validating `market` inputs to other tools.

**Inputs:** shared response fields only (`response_format`, `max_results`)

**Returns:** list of market entries from `GET /markets`.

---

#### The `get_several_*` batch family
Seven batch lookup tools fetch full details for several IDs in a single call per chunk, dropping IDs Spotify could not resolve:

| Tool | Endpoint | Max IDs per request |
|---|---|---|
| `get_several_tracks` | `GET /tracks?ids=…` | 50 |
| `get_several_albums` | `GET /albums?ids=…` | 20 |
| `get_several_artists` | `GET /artists?ids=…` | 50 |
| `get_several_episodes` | `GET /episodes?ids=…` | 50 |
| `get_several_shows` | `GET /shows?ids=…` | 50 |
| `get_several_audiobooks` | `GET /audiobooks?ids=…` | 50 |
| `get_several_chapters` | `GET /chapters?ids=…` | 50 |

**Inputs:** `ids` (string[], required — longer lists are fetched in chunks of the per-request maximum and merged), plus shared response fields. The audiobook variants are market-gated like the single lookups.

**Returns:** full objects per resolved ID; `response_format=json` hands back `{ items: [...] }`.

---

### 5.4 Personalization

#### `get_top_tracks`
Get the user's most-played tracks.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `time_range` | `"short_term"` \| `"medium_term"` \| `"long_term"` | no | ~4 weeks / ~6 months / all time. Default: `"medium_term"` |
| `limit` | number | no | 1–50. Default: 20 |

---

#### `get_top_artists`
Get the user's most-played artists.

**Inputs:** same as `get_top_tracks`.

---

#### `get_recently_played`
Get recently played tracks with timestamps.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `limit` | number | no | 1–50. Default: 20 |
| `after` | number | no | Unix timestamp ms — return tracks played after this time |
| `before` | number | no | Unix timestamp ms — return tracks played before this time |

---

### 5.5 Library

> **Feb 2026 note**: Save, remove, and check operations accept **Spotify URIs** (e.g., `spotify:track:abc123`) rather than bare IDs. Two families exist: the legacy trio (`save_items`, `remove_saved_items`, `check_saved_items`) partitions its URIs by type across the per-type `/me/{type}s` endpoints, while the unified trio (`save_to_library`, `remove_from_library`, `check_in_library`) issues a single call against `/me/library`.

#### `get_saved_tracks`
Get tracks saved in the user's Liked Songs.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `limit` | number | no | 1–50. Default: 20 |
| `offset` | number | no | Pagination offset. Default: 0 |
| `market` | string | no | |
| `fetch_all` | boolean | no | Fetch every page via `client.getAllPages` (capped by `SPOTIFY_MCP_FETCH_ALL_CAP`, default 500) instead of a single page |

---

#### `get_saved_albums`
Get albums saved in the user's library.

**Inputs:** `limit`, `offset`, `market`, `fetch_all` (all optional — `fetch_all` retrieves every page, capped by `SPOTIFY_MCP_FETCH_ALL_CAP`, default 500)

---

#### `get_saved_shows`
Get podcast shows saved in the user's library.

**Inputs:** `limit`, `offset`, `fetch_all` (all optional — `fetch_all` retrieves every page, capped by `SPOTIFY_MCP_FETCH_ALL_CAP`, default 500)

---

#### `get_saved_episodes`
Get podcast episodes saved in the user's library.

**Inputs:** `limit`, `offset`, `market`, `fetch_all` (all optional — `fetch_all` retrieves every page, capped by `SPOTIFY_MCP_FETCH_ALL_CAP`, default 500)

**Returns:** list of episodes with name, show name, duration_ms, release_date, resume_point, URI.

---

#### `save_items`
Save one or more items to the user's library. Accepts track, album, show, episode, and audiobook URIs; internally partitions them by type and issues one call per affected type — `PUT /me/tracks` / `PUT /me/albums` / `PUT /me/episodes` (IDs in the JSON body) and `PUT /me/shows?ids=…` / `PUT /me/audiobooks?ids=…` (these two only honour query-parameter IDs).

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `uris` | string[] | yes | Spotify URIs to save (e.g., `["spotify:track:abc", "spotify:audiobook:xyz"]`). Max 50. Accepts tracks, albums, shows, episodes, and audiobooks. |

---

#### `remove_saved_items`
Remove one or more items from the user's library. Partitions URIs by type and calls `DELETE /me/tracks` / `/me/albums` / `/me/episodes` / `DELETE /me/shows?ids=…` / `DELETE /me/audiobooks?ids=…` per affected type.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `uris` | string[] | yes | Spotify URIs to remove. Max 50. |
| `dry_run` | boolean | no | Preview exactly which URIs would be removed without calling the API |

---

#### `check_saved_items`
Check whether items are saved in the user's library. Partitions URIs by type and queries the per-type contains endpoints (`GET /me/tracks/contains`, `/me/albums/contains`, `/me/shows/contains`, `/me/episodes/contains`, `/me/audiobooks/contains`).

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `uris` | string[] | yes | Spotify URIs to check. Max 50. Accepts tracks, albums, shows, episodes, and audiobooks. |

**Returns:** array of booleans matching input order.

---

#### `save_to_library`
Save one or more items to the user's library via Spotify's unified library endpoint — a single request for any mix of URI types.

**Inputs:** `uris` (string[], required, max 40 — track, album, episode, show, audiobook, user, or playlist URIs)

Sends `PUT /me/library?uris=…`.

---

#### `remove_from_library`
Remove one or more items from the user's library via the unified endpoint in a single request.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `uris` | string[] | yes | URIs to remove (same accepted types as `save_to_library`). Max 40. |
| `dry_run` | boolean | no | Preview exactly which URIs would be removed without calling the API |

Sends `DELETE /me/library?uris=…`.

---

#### `check_in_library`
Check whether items are saved in or followed by the user via the unified contains endpoint. Unlike the legacy `check_saved_items`, this also accepts artist, user, and playlist URIs (follow state) in any mix.

**Inputs:** `uris` (string[], required, max 40 — track, album, episode, show, audiobook, artist, user, or playlist URIs)

Sends `GET /me/library/contains?uris=…`. **Returns:** array of booleans matching input order.

---

### 5.6 Playlists

#### `get_user_playlists`
List the current user's playlists.

**Inputs:** `limit` (1–50, default 20), `offset`, `fetch_all` (all optional — `fetch_all` retrieves every page via `client.getAllPages`, capped by `SPOTIFY_MCP_FETCH_ALL_CAP`, default 500)

**Returns:** id, name, description, track count, is_public, is_collaborative, owner, URI.

---

> **Feb 2026 note**: Playlist item endpoints use `/items` (not `/tracks`). The paths below reflect this — `GET/POST/DELETE /playlists/{id}/items`.

#### `get_playlist`
Get a playlist's metadata and its items. Makes two calls: `GET /playlists/{id}` for metadata, then `GET /playlists/{id}/items` for the track/episode list.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Playlist ID |
| `limit` | number | no | Items per page, 1–100. Default: 50 |
| `offset` | number | no | Pagination offset for items |
| `fetch_all` | boolean | no | Fetch every page of items via `client.getAllPages` (capped by `SPOTIFY_MCP_FETCH_ALL_CAP`, default 500) instead of a single page |

**Returns:** name, description, owner, is_public, is_collaborative, total item count, URI; plus paginated items (track/episode name, artists/show, duration_ms, added_at, URI).

---

#### `get_playlist_items`
List a playlist's items on a single page — use this instead of `get_playlist` when only the contents are needed.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `playlist_id` | string | yes | |
| `limit` | number | no | Items per page, 1–100. Default: 100 |
| `offset` | number | no | Pagination offset. Default: 0 |
| `market` | string | no | ISO 3166-1 alpha-2 country code — relinks tracks to that market and flags unavailable ones |
| `fields` | string | no | Comma-separated response fields to keep, e.g. `total,items(track(name,uri))` |
| `additional_types` | string | no | Comma-separated item types beyond the default `track`, e.g. `track,episode` |

**Returns:** items (track/episode name, artists/show, duration_ms, added_at, URI) with total count, a truncation footer when sliced, and structuredContent carrying pagination info.

---

#### `create_playlist`
Create a new playlist for the current user.

Uses a single call to `POST /me/playlists` for the current user — no `user_id` round-trip needed. The forbidden combination `public=true` + `collaborative=true` is rejected locally with a clear message instead of an upstream 400.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | |
| `description` | string | no | |
| `public` | boolean | no | Default: false |
| `collaborative` | boolean | no | Default: false |

**Returns:** playlist id, URI, external URL.

---

#### `add_to_playlist`
Add tracks or episodes to a playlist. Uses `POST /playlists/{id}/items`.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `playlist_id` | string | yes | |
| `uris` | string[] | yes | Track or episode URIs, max 100 per call |
| `check_duplicates` | boolean | no | Skip URIs already present in the playlist instead of appending them (default: false) |
| `position` | number | no | Insert at index; appends if omitted |

---

#### `remove_from_playlist`
Remove tracks or episodes from a playlist. Uses `DELETE /playlists/{id}/items`.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `uris` | string[] \| { uri, positions }[] | yes | URIs to remove; use `{ uri, positions }` to target specific occurrences of a repeated URI (the only way to de-duplicate repeats). Max 100 entries. |
| `snapshot_id` | string | no | Apply the removal against this playlist version instead of the latest |

---

#### `update_playlist`
Update a playlist's name or description.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | |
| `name` | string | no | |
| `description` | string | no | |
| `public` | boolean | no | |
| `collaborative` | boolean | no | |

---

#### `reorder_playlist_items`
Move a range of items within a playlist. Uses `PUT /playlists/{id}/items`.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `playlist_id` | string | yes | |
| `range_start` | number | yes | Index of first item to move |
| `range_length` | number | no | Number of items to move. Default: 1 |
| `insert_before` | number | yes | Index to insert before |

---

#### `replace_playlist_items`
Replace ALL items in a playlist with the supplied URIs, overwriting the current contents. `PUT /playlists/{id}/items` atomically replaces the whole playlist but accepts at most 100 URIs per call — so the first chunk performs the replacement and any remainder is appended chunk-by-chunk via `POST /playlists/{id}/items` through the serialised client queue.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `playlist_id` | string | yes | |
| `uris` | string[] | yes | Complete ordered list of track or episode URIs the playlist should contain |

**Returns:** confirmation with the total replaced count, request count, batch echo, and final `snapshot_id`.

---

#### `find_duplicates_in_playlist`
Find duplicate tracks in a playlist: exact URI repeats plus relinked copies of the same song appearing under different URIs (matched on normalised name + artists). Walks every page of items via `client.getAllPages`; reported positions are 0-based API indexes that can be fed straight back into `remove_from_playlist`'s `{ uri, positions }` entries.

**Inputs:** `playlist_id` (string, required), shared response fields (`response_format`, `max_results`)

**Returns:** per group: track label, occurrence count and kind (`same URI` vs `relinked / different URIs`), the URIs involved, and 0-based positions; structuredContent includes `scanned` item count.

---

#### `get_playlist_cover`
Get a playlist's cover image URLs.

**Inputs:** `playlist_id` (string, required)

**Returns:** array of image objects (url, width, height).

---

#### `upload_playlist_cover`
Replace a playlist's cover image with a base64-encoded JPEG (max 256 KB decoded). Requires the optional `ugc-image-upload` scope on the Spotify developer dashboard app (plus `playlist-modify-public`/`playlist-modify-private`) — without it Spotify rejects the upload with 403.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `playlist_id` | string | yes | |
| `jpeg_base64` | string | yes | Base64-encoded JPEG file contents |

---

### 5.7 Following

#### `get_followed_artists`
Get all artists the user follows.

**Inputs:** `limit` (1–50, default 20), `after` (cursor for pagination, optional)

---

#### `check_following_artists`
Check if the user follows specific artists.

**Inputs:** `ids` (string[], required, max 50 — bare artist IDs)

**Returns:** array of booleans matching input order. Uses `GET /me/following/contains?type=artist&ids=…`.

---

#### `follow_artists`
Follow one or more artists. Requires the `user-follow-modify` scope.

**Inputs:** `ids` (string[], required, 1–50 artist IDs)

Sends `PUT /me/following?type=artist&ids=…` and echoes a batch summary of the followed artists.

---

#### `unfollow_artists`
Unfollow one or more artists. Requires the `user-follow-modify` scope.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `ids` | string[] | yes | Artist IDs to unfollow (1–50) |
| `dry_run` | boolean | no | Preview which artists would be unfollowed without calling the API |

Sends `DELETE /me/following?type=artist&ids=…`.

---

### 5.8 Audiobooks

> Audiobook content is market-gated: it is only available in US, UK, Canada, Ireland, New Zealand, and Australia. When `market` is omitted on a lookup (`get_audiobook`, `get_audiobook_chapters`, `get_chapter`, `get_artist_top_tracks`), the tool defaults to the account's country from `GET /me`; if Spotify still rejects the lookup, the error carries a hint to retry with an explicit market code.

#### `get_audiobook`
Get full details for an audiobook.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Audiobook ID |
| `market` | string | no | ISO 3166-1 alpha-2 country code |

**Returns:** name, authors, narrators, description, publisher, total_chapters, media_type, URI, first page of chapters.

---

#### `get_audiobook_chapters`
List an audiobook's chapters with pagination. Resume positions require the `user-read-playback-position` scope.

**Inputs:** `id` (string, required), `limit` (1–50, default 20), `offset` (optional)

**Returns:** chapter name, description, duration_ms, release_date, resume_point, URI; plus total chapter count.

---

#### `get_chapter`
Get full details for a single audiobook chapter.

**Inputs:** `id` (string, required), `market` (optional)

**Returns:** name, description, duration_ms, release_date, explicit, resume_point, audiobook name, URI.

---

#### `get_saved_audiobooks`
Get audiobooks saved in the user's library.

**Inputs:** `limit` (1–50, default 20), `offset` (optional)

---

### 5.9 Users

#### `get_user_profile`
Get any Spotify user's public profile.

**Inputs:** `user_id` (string, required)

**Returns:** display name, user ID, URI, follower count, profile image URL, external URL. Uses `GET /users/{user_id}` (no authentication-scoped data — only public fields).

---

#### `get_user_playlists_by_id`
List another Spotify user's public playlists.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `user_id` | string | yes | Spotify user ID |
| `limit` | number | no | 1–50 per page. Default: 20 |
| `offset` | number | no | Pagination offset. Default: 0 |

**Returns:** playlist name, owner, track count, ID, URI; plus total count and pagination info in structuredContent. Output is capped by `max_results`. Uses `GET /users/{user_id}/playlists`.


## 5. Resources

MCP Resources expose read-only data as URIs Claude can reference. Eleven fixed URIs are registered, each also available as a `{?format}` template twin — appending `?format=json` to any resource URI returns the raw API payload instead of prose. A twelfth templated resource covers playlist contents.

**Fixed resources:**

| URI | Description |
|---|---|
| `spotify://me` | Current user's profile |
| `spotify://player/state` | Current playback state |
| `spotify://player/queue` | Current queue |
| `spotify://me/top/tracks` | User's top tracks (medium term) |
| `spotify://me/top/artists` | User's top artists (medium term) |
| `spotify://me/recently-played` | Last 20 played tracks |
| `spotify://me/playlists` | All user playlists (names + IDs) |
| `spotify://me/saved/albums` | Albums saved in your library |
| `spotify://me/saved/shows` | Podcast shows saved in your library |
| `spotify://me/saved/episodes` | Podcast episodes saved in your library |
| `spotify://me/rate-limit` | Last rate-limit event: `Retry-After`/wait time, or "never throttled" |

**Templated resource:**

| URI | Description |
|---|---|
| `spotify://playlist/{id}/tracks` | A playlist's tracks; paginate on the URI itself via `?offset=N&limit=M` (`?format=json` returns the raw paged payload) |

---

## 6. Prompts

Pre-built prompt templates exposed via MCP for common use cases:

| Name | Description |
|---|---|
| `dj` | "Act as a DJ. Based on my top artists and current mood, queue up a set of songs." |
| `playlist_from_mood` | "Create a playlist for a given mood. Searches for tracks and adds them to a new playlist." |
| `music_taste_summary` | "Summarize the user's music taste based on their top tracks and artists." (parameterized `time_range`, default `'all'` keeps the original three-range behaviour) |
| `discover_weekly_alternative` | "Based on my top tracks and recently played songs, find lesser-known songs I probably haven't heard." |
| `playlist_audit` | "Audit a playlist for duplicate tracks and unplayable ('dead') entries, with cleanup suggestions." |
| `listening_recap` | "Write a recap of recent listening: top tracks/artists plus recently-played context." (weekly/monthly) |
| `migrate_library` | "Collect tracks from your saved albums into a single playlist." (`playlist_name` defaults to *My Saved Albums*; opt-in `include_singles`) |
| `podcast_catchup` | "List new podcast episodes published since a date across your saved shows, and queue them if asked." |
| `artist_deep_dive` | "Tour an artist's discography: profile, albums, standout tracks." |

---

## 7. Error Handling

### Spotify API errors → MCP tool errors

| HTTP Status | Cause | MCP response |
|---|---|---|
| 401 Unauthorized | Token expired | Auto-refresh and retry once; if still 401, return error with setup instructions |
| 403 Forbidden | OAuth scope missing, deprecated endpoint, regional restriction, or a Premium-only control failure | Surface Spotify's own error message when present; otherwise a hint naming the likely cause categories (never a blanket "requires Premium" claim) |
| 404 Not Found | Entity doesn't exist | Return descriptive message |
| 429 Too Many Requests | Rate limit | Respect `Retry-After` header, retry once after delay |
| 503 Service Unavailable | Spotify down | Return error with retry suggestion |
| 408 (client timeout) | Outbound call exceeded `SPOTIFY_REQUEST_TIMEOUT_MS` (default 30 s) | `SpotifyApiError` naming the timed-out method and URL |

### No active device
When playback commands fail because no device is active (204 with no `device_id` found): return a helpful message listing available devices and asking the user to open Spotify on a device first.

---

## 8. Rate Limiting

- All API calls go through a central `SpotifyClient` class with a request queue
- Requests are serialized with a minimum 100 ms gap to avoid bursts
- On 429: pause the queue for `Retry-After` seconds and retry once; the throttle event (retry delay, wait time) is recorded on the client
- Throttle visibility: the most recent event is exposed via the `spotify://me/rate-limit` resource, and a "rate-limited by Spotify, waited Ns" notice is appended to the throttled call's result
- Batch operations issue one API call per affected content type (e.g., `save_items` partitions its URIs across `/me/tracks`, `/me/albums`, …) instead of one call per item

---

## 9. Spotify API Constraints

Known limitations to document and handle:

| Constraint | Detail |
|---|---|
| **Premium required** | All playback control: play, pause, skip, seek, volume, shuffle, repeat, queue |
| **No audio** | API provides metadata and control only — no audio streams |
| **Search limit** | Max 50 results per type per call (schema cap; default 5) |
| **Queue opacity** | `GET /me/player/queue` returns items but positions are not editable |
| **Removed endpoints** | Audio features/analysis, recommendations, related artists, genres, featured playlists, new releases — gone since Feb 2026. The batch lookups (`GET /tracks?ids=` family) and `GET /artists/{id}/top-tracks` returned in v1.1.0. |
| **Removed fields** | `popularity`, `followers`, `available_markets` no longer returned on tracks, artists, albums |
| **Unified library API** | `save_to_library`/`remove_from_library`/`check_in_library` use `PUT/DELETE/GET /me/library` with **URIs** in any mix (including artist/user/playlist follow state on check). The legacy helpers (`save_items`, `remove_saved_items`, `check_saved_items`) partition URIs across the per-type `/me/{type}s` endpoints. |
| **Playlist items path** | All playlist item operations use `/playlists/{id}/items` (not `/tracks`) as of Feb 2026 |
| **Audiobooks market-gated** | Audiobook endpoints only available in US, UK, Canada, Ireland, New Zealand, Australia |
| **Dev mode limit** | 5 authorized users max until extended quota approval |
| **Token expiry** | Access tokens expire after 1 hour; refresh tokens are long-lived |
| **Redirect URI** | Must use `http://127.0.0.1` for local development — not `http://localhost` |
| **Market sensitivity** | Some tracks/albums are region-restricted; `market` param controls availability filtering |
| **Fetch-all cap** | `fetch_all` pagination (`client.getAllPages`) walks offset pages up to `SPOTIFY_MCP_FETCH_ALL_CAP` items per call (default 500). Cursor-paginated endpoints (followed artists) are not supported by this helper. |

---

## 10. Project Structure

```
spotify-mcp/
├── src/
│   ├── index.ts              # MCP server entry point (stdio transport)
│   ├── auth.ts               # OAuth PKCE flow, token storage, refresh logic
│   ├── client.ts             # SpotifyClient — serialized queue, fetch timeouts, TTL cache, getAllPages
│   ├── cache.ts              # LRU TTL cache for immutable catalog reads (~5 minutes)
│   ├── config.ts             # SPOTIFY_* environment family loader
│   ├── history.ts            # Opt-in mutation history JSONL writer
│   ├── shaping.ts            # Shared response shaping (response_format, max_results, pagination)
│   ├── tools/
│   │   ├── analytics.ts      # listening_report
│   │   ├── artistwatch.ts    # get_artist_discography, resolve_artist, save_artist_new_releases, watch_artists, check_artist_releases, artist_release_digest
│   │   ├── audiobooks.ts     # get_audiobook, get_audiobook_chapters, get_chapter, get_saved_audiobooks
│   │   ├── audiobookcopilot.ts # list_all_chapters, jump_to_chapter, where_was_i
│   │   ├── backup.ts         # backup_library, list_backups
│   │   ├── browse.ts         # get_artist_genres, get_categories, get_category_playlists
│   │   ├── catalog.ts        # get_me, get_track, get_several_tracks, get_artist, get_artist_top_tracks, get_artist_albums, get_several_artists, get_album, get_album_tracks, get_several_albums, get_show, get_show_episodes, get_several_shows, get_episode, get_several_episodes, get_available_markets, get_several_audiobooks, get_several_chapters
│   │   ├── doctortool.ts     # spotify_doctor
│   │   ├── episodemgmt.ts    # archive_played_episodes, mark_episode_played
│   │   ├── export.ts         # export_playlist (M3U/CSV)
│   │   ├── following.ts      # get_followed_artists, follow_artists, unfollow_artists, check_following_artists
│   │   ├── freshness.ts      # whats_new (new-release radar)
│   │   ├── import.ts         # import_playlist (M3U/CSV)
│   │   ├── libraryanalytics.ts # library_coverage_report, listening_heatmap, library_growth_report, genre_trends_over_time
│   │   ├── libraryhygiene.ts # library_hygiene
│   │   ├── libraryinsights.ts # library_genre_report, filter_by_genre, tag_management
│   │   ├── library.ts        # get_saved_tracks, get_saved_albums, get_saved_shows, get_saved_episodes, save_items, remove_saved_items, check_saved_items, save_to_library, remove_from_library, check_in_library
│   │   ├── personalization.ts # get_top_tracks, get_top_artists, get_recently_played
│   │   ├── playback.ts       # get_now_playing, get_currently_playing, play, pause, skip_next, skip_previous, seek, set_volume, set_shuffle, set_repeat, get_queue, add_to_queue, get_devices, transfer_playback, play_from_search
│   │   ├── playbackext.ts    # save_playback_state, restore_playback_state, list_playback_states, rename_device, set_device_volume_preset, apply_device_presets, list_device_presets, tag_listening_session, replay_session, list_sessions, save_smart_playlist_rule, refresh_smart_playlist, save_show_digest
│   │   ├── playlistbatch.ts  # batch_add_to_playlist, copy_playlist, move_items_between_playlists
│   │   ├── playlistdna.ts    # grow_playlist (co-occurrence)
│   │   ├── playlisthealth.ts # playlist_health_check, get_playlist_followers, playlist_collaboration_report, snapshot_playlist, diff_since_snapshot, list_playlist_snapshots
│   │   ├── playlistmisc.ts   # pin_playlist, unpin_playlist, playlist_template_apply
│   │   ├── playlistops.ts    # merge_playlists, diff_playlists, overlap_playlists
│   │   ├── playlists.ts      # get_user_playlists, get_playlist, get_playlist_items, create_playlist, add_to_playlist, remove_from_playlist, update_playlist, reorder_playlist_items, replace_playlist_items, find_duplicates_in_playlist, get_playlist_cover, upload_playlist_cover
│   │   ├── podcastsession.ts # plan_podcast_session, start_podcast_session
│   │   ├── portability.ts    # save_discover_weekly, save_release_radar, export_library_json, export_followed_artists
│   │   ├── queueops.ts       # queue_playlist, queue_reorder, queue_remove, queue_clear
│   │   ├── restore.ts        # restore_library_snapshot
│   │   ├── saveddedupe.ts    # find_duplicate_saved_tracks
│   │   ├── scenes.ts         # save_scene, list_scenes, delete_scene, apply_scene, schedule_wind_down, cancel_wind_down
│   │   ├── searchdive.ts     # search_deep
│   │   ├── searchhistory.ts  # search_history, search_rerun
│   │   ├── search.ts         # search
│   │   ├── showradar.ts      # show_new_episodes
│   │   ├── smart.ts          # create_smart_playlist, clean_all_playlists, remove_duplicate_playlist_items
│   │   └── users.ts          # get_user_profile, get_user_playlists_by_id
│   ├── resources/
│   │   └── index.ts          # MCP resource handlers
│   ├── prompts/
│   │   └── index.ts          # MCP prompt definitions
│   └── types/
│       └── spotify.ts        # TypeScript types for Spotify API responses
├── package.json
├── tsconfig.json
├── .env.example
├── SPEC.md
└── README.md
```

---

## 11. Configuration

### Environment variables
```env
SPOTIFY_CLIENT_ID=            # required — from developer.spotify.com dashboard
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8888/callback
SPOTIFY_HEADLESS=1            # browserless paste-flow auth (no local callback server)
SPOTIFY_MCP_TOKEN_FILE=       # token storage override (default ~/.spotify-mcp/tokens.json)
SPOTIFY_REQUEST_TIMEOUT_MS=30000
SPOTIFY_MCP_MAX_ITEMS=50      # default per-call truncation cap for list tools
SPOTIFY_MCP_FETCH_ALL_CAP=500 # ceiling for fetch_all pagination walks
SPOTIFY_MCP_HISTORY=1         # opt-in mutation history JSONL logging
SPOTIFY_MCP_HISTORY_DIR=      # history directory override (default ~/.spotify-mcp/history)
```

### Token storage
`~/.spotify-mcp/tokens.json` by default (path overridable via the `SPOTIFY_MCP_TOKEN_FILE` environment variable) — created on first auth, file permissions set to 600 (owner read/write only).

---

## 12. Claude Desktop Integration

### `claude_desktop_config.json` entry
```json
{
  "mcpServers": {
    "spotify": {
      "command": "node",
      "args": ["/path/to/spotify-mcp-server/dist/index.js"],
      "env": {
        "SPOTIFY_CLIENT_ID": "your_client_id"
      }
    }
  }
}
```

### First-time setup
```bash
# 1. Create a Spotify app at developer.spotify.com
#    Add redirect URI: http://127.0.0.1:8888/callback

# 2. Run auth flow (PKCE — the client secret is never used)
npm run auth   # or: SPOTIFY_CLIENT_ID=xxx npm run auth

# 3. Add to claude_desktop_config.json (above)

# 4. Restart Claude Desktop
```

---

## Implementation Phases

| Phase | Scope |
|---|---|
| **Phase 1** | Auth flow + SpotifyClient + playback tools (play, pause, skip, seek, volume, shuffle, repeat, now_playing, devices, transfer) |
| **Phase 2** | Search + catalog lookup (track, artist, artist albums, album, audio features, audio analysis, show, episode) |
| **Phase 3** | Personalization (top tracks/artists, recently played, recommendations with full tuning surface, related artists, available genres, featured playlists) |
| **Phase 4** | Library management (get saved tracks/albums/shows/episodes; save_items, remove_saved_items, check_saved_items accepting URIs, partitioned across the per-type `/me/{type}s` endpoints) |
| **Phase 5** | Playlist CRUD + item management (get_user_playlists, get_playlist, create_playlist, add_to_playlist, remove_from_playlist, update_playlist, reorder_playlist_items — all using `/items` endpoints) |
| **Phase 6** | Following (get_followed_artists, follow_artists, unfollow_artists, check_following_artists via `/me/following` + `/me/following/contains`) |
| **Phase 7** | MCP Resources + Prompts |
| **Phase 8** | Package for npm (`spotify-mcp`) + README polish |
| **Phase 9** | Deprecation cleanup + coverage completion (2026-08): removed deprecated endpoints (audio features/analysis, recommendations, related artists, genres, featured playlists, follow/unfollow artist); create_playlist moved to `POST /me/playlists`; added album tracks, show episodes, get_me, audiobook family, get_currently_playing, play_from_search, playlist cover get/upload; fetch_all pagination via client.getAllPages; SPOTIFY_MCP_TOKEN_FILE override |
| **Phase 10** | v1.1.0 coverage expansion (2026-08): users module (`get_user_profile`, `get_user_playlists_by_id`); `follow_artists`/`unfollow_artists`; unified-library trio (`save_to_library`, `remove_from_library`, `check_in_library`); `get_playlist_items`, `replace_playlist_items`, `find_duplicates_in_playlist`; `get_artist_top_tracks`, `get_available_markets`, and the seven `get_several_*` batch lookups; shared response shaping (`response_format`/`max_results`/`structuredContent`); fetch timeouts, TTL read cache, rate-limit visibility resource, opt-in mutation history, and the `spotify-mcp doctor` CLI |
| **Phase 11** | v1.19–1.21 wave: `import_playlist` (M3U/CSV), `remove_duplicate_playlist_items` + `clean_all_playlists`, `create_smart_playlist`, `show_new_episodes`, backup/restore, bug trio (#195/#196/#210), 104 tools |
| **Phase 12** | **v1.22.0 big-release (2026-08-26): 50 new tools across 11 modules — 6 parallel streams: catalog/browse+artistwatch (8), library analytics (4), playlist health (6), playlist batch (3), playlist misc+portability (7), playback/queue/search/episodes (22) — wired centrally, 157 tools across 38 modules, 837 tests, smoke FORBIDDEN_TOOLS guard** |
