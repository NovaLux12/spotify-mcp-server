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
| Runtime | Node.js 22+ | Native fetch, no polyfills needed |
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
1. User runs `npx spotify-mcp auth` (or `npm run auth` locally)
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
```

> Note: `streaming` is **not** included — that scope is for the browser-based Spotify Web Playback SDK, not the Web API. Playback control via the Web API requires `user-modify-playback-state` (already included above).
> Note: `ugc-image-upload` is **not** requested by default. It is only needed for `upload_playlist_cover`; users who want playlist cover uploads must enable it on their Spotify developer dashboard app and re-run auth.

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

---

## 4. Implementation Contracts

### 4.0.1 Entry point / CLI structure

`src/index.ts` is both the MCP server and the auth CLI. Distinguish via `process.argv`:

```ts
const command = process.argv[2];
if (command === 'auth') {
  // Run OAuth flow, save tokens, exit
  await runAuthFlow();
} else {
  // Start MCP server over stdio
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

const server = new McpServer({
  name: 'spotify-mcp',
  version: '1.0.0',
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

Minimal interface:
```ts
class SpotifyClient {
  async get<T>(path: string, params?: Record<string, string>): Promise<T>
  async post<T>(path: string, body?: unknown): Promise<T>
  async put(path: string, body?: unknown): Promise<void>
  async delete(path: string, body?: unknown): Promise<void>
}
```

`get` appends `params` as query string. All methods prepend the base URL. `put` and `delete` return `void` because Spotify typically returns `204 No Content` for mutations.

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
| `get_track` | GET | `/tracks/{id}` |
| `get_artist` | GET | `/artists/{id}` |
| `get_artist_albums` | GET | `/artists/{id}/albums` |
| `get_album` | GET | `/albums/{id}` |
| `get_album_tracks` | GET | `/albums/{id}/tracks` |
| `get_show` | GET | `/shows/{id}` |
| `get_show_episodes` | GET | `/shows/{id}/episodes` |
| `get_episode` | GET | `/episodes/{id}` |
| `get_audiobook` | GET | `/audiobooks/{id}` |
| `get_audiobook_chapters` | GET | `/audiobooks/{id}/chapters` |
| `get_chapter` | GET | `/chapters/{id}` |
| `get_saved_audiobooks` | GET | `/me/audiobooks` — market-gated to US/UK/CA/IE/NZ/AU |
| `get_top_tracks` | GET | `/me/top/tracks` |
| `get_top_artists` | GET | `/me/top/artists` |
| `get_recently_played` | GET | `/me/player/recently-played` |
| `get_saved_tracks` | GET | `/me/tracks` |
| `get_saved_albums` | GET | `/me/albums` |
| `get_saved_shows` | GET | `/me/shows` |
| `get_saved_episodes` | GET | `/me/episodes` |
| `save_items` | PUT | `/me/library` |
| `remove_saved_items` | DELETE | `/me/library` |
| `check_saved_items` | GET | `/me/library/contains` |
| `get_user_playlists` | GET | `/me/playlists` |
| `get_playlist` (metadata) | GET | `/playlists/{id}` |
| `get_playlist` (items) | GET | `/playlists/{id}/items` |
| `create_playlist` | POST | `/me/playlists` |
| `add_to_playlist` | POST | `/playlists/{id}/items` |
| `remove_from_playlist` | DELETE | `/playlists/{id}/items` |
| `update_playlist` | PUT | `/playlists/{id}` |
| `reorder_playlist_items` | PUT | `/playlists/{id}/items` |
| `get_playlist_cover` | GET | `/playlists/{id}/images` |
| `upload_playlist_cover` | PUT | `/playlists/{id}/images` — base64 JPEG; requires optional `ugc-image-upload` scope |
| `get_followed_artists` | GET | `/me/following?type=artist` — cursor-based pagination: `after` is the artist ID of the last returned item, not a numeric offset |
| `check_following_artists` | GET | `/me/library/contains` — pass `spotify:artist:{id}` URIs |

---

## 5. Tools

All tools return a structured result object. Errors surface as MCP tool errors with a human-readable message.

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

**Returns:** currently playing item, list of up to 20 queued items (name, artist, duration, URI).

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
| `types` | string[] | no | Any of `track`, `artist`, `album`, `playlist`, `show`, `episode`. Default: `["track","artist","album"]` |
| `limit` | number | no | Results per type, 1–10 (API max). Default: 5 |
| `market` | string | no | ISO 3166-1 alpha-2 country code |

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

> **Feb 2026 note**: Save, remove, and check operations now use the unified `/me/library` endpoints which accept **Spotify URIs** (e.g., `spotify:track:abc123`) rather than bare IDs. The tools below reflect this.

#### `get_saved_tracks`
Get tracks saved in the user's Liked Songs.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `limit` | number | no | 1–50. Default: 20 |
| `offset` | number | no | Pagination offset. Default: 0 |
| `market` | string | no | |
| `fetch_all` | boolean | no | Fetch every page (up to 500 liked songs) instead of a single page |

---

#### `get_saved_albums`
Get albums saved in the user's library.

**Inputs:** `limit`, `offset`, `market`, `fetch_all` (all optional — `fetch_all` retrieves every page, capped at 500 albums)

---

#### `get_saved_shows`
Get podcast shows saved in the user's library.

**Inputs:** `limit`, `offset`, `fetch_all` (all optional — `fetch_all` retrieves every page, capped at 500 shows)

---

#### `get_saved_episodes`
Get podcast episodes saved in the user's library.

**Inputs:** `limit`, `offset`, `market`, `fetch_all` (all optional — `fetch_all` retrieves every page, capped at 500 episodes)

**Returns:** list of episodes with name, show name, duration_ms, release_date, resume_point, URI.

---

#### `save_items`
Save one or more items to the user's library. Replaces type-specific save endpoints (`/me/tracks`, `/me/albums`, `/me/shows`, `/me/episodes`). Uses `PUT /me/library`.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `uris` | string[] | yes | Spotify URIs to save (e.g., `["spotify:track:abc", "spotify:album:xyz"]`). Max 50. Accepts tracks, albums, shows, and episodes. |

---

#### `remove_saved_items`
Remove one or more items from the user's library. Uses `DELETE /me/library`.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `uris` | string[] | yes | Spotify URIs to remove. Max 50. |

---

#### `check_saved_items`
Check whether items are saved in the user's library. Replaces type-specific check endpoints. Uses `GET /me/library/contains`.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `uris` | string[] | yes | Spotify URIs to check. Max 40. Accepts tracks, albums, shows, episodes, artists, and playlists. |

**Returns:** array of booleans matching input order.

---

### 5.6 Playlists

#### `get_user_playlists`
List the current user's playlists.

**Inputs:** `limit` (1–50, default 20), `offset`, `fetch_all` (all optional — `fetch_all` retrieves every page, capped at 500 playlists)

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
| `fetch_all` | boolean | no | Fetch every page of items (up to 500) instead of a single page |

**Returns:** name, description, owner, is_public, is_collaborative, total item count, URI; plus paginated items (track/episode name, artists/show, duration_ms, added_at, URI).

---

#### `create_playlist`
Create a new playlist for the current user.

Uses a single call to `POST /me/playlists` for the current user — no `user_id` round-trip needed.

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
| `position` | number | no | Insert at index; appends if omitted |

---

#### `remove_from_playlist`
Remove tracks or episodes from a playlist. Uses `DELETE /playlists/{id}/items`.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `playlist_id` | string | yes | |
| `uris` | string[] | yes | URIs to remove |

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
Check if the user follows specific artists. Uses the unified `GET /me/library/contains` endpoint (passing `spotify:artist:` URIs), since the type-specific `/me/following/contains` endpoint is deprecated as of Feb 2026.

**Inputs:** `ids` (string[], required, max 50 — bare artist IDs; the tool converts them to `spotify:artist:{id}` URIs internally)

**Returns:** array of booleans matching input order.

---

### 5.8 Audiobooks

> Audiobook content is market-gated: it is only available in US, UK, Canada, Ireland, New Zealand, and Australia.

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

## 5. Resources

MCP Resources expose read-only data as URIs Claude can reference.

| URI | Description |
|---|---|
| `spotify://me` | Current user's profile |
| `spotify://me/top/tracks` | User's top tracks (medium term) |
| `spotify://me/top/artists` | User's top artists (medium term) |
| `spotify://me/recently-played` | Last 20 played tracks |
| `spotify://me/playlists` | All user playlists (names + IDs) |
| `spotify://player/state` | Current playback state |
| `spotify://player/queue` | Current queue |

---

## 6. Prompts

Pre-built prompt templates exposed via MCP for common use cases:

| Name | Description |
|---|---|
| `dj` | "Act as a DJ. Based on my top artists and current mood, queue up a set of songs." |
| `playlist_from_mood` | "Create a playlist for: {mood}. Search for tracks and add them to a new playlist." |
| `music_taste_summary` | "Summarize my music taste based on my top tracks and artists across all time ranges." |
| `discover_weekly_alternative` | "Based on my top tracks, recommend 20 songs I probably haven't heard." |

---

## 7. Error Handling

### Spotify API errors → MCP tool errors

| HTTP Status | Cause | MCP response |
|---|---|---|
| 401 Unauthorized | Token expired | Auto-refresh and retry once; if still 401, return error with setup instructions |
| 403 Forbidden | Premium required | Return clear message: "This action requires Spotify Premium" |
| 404 Not Found | Entity doesn't exist | Return descriptive message |
| 429 Too Many Requests | Rate limit | Respect `Retry-After` header, retry once after delay |
| 503 Service Unavailable | Spotify down | Return error with retry suggestion |

### No active device
When playback commands fail because no device is active (204 with no `device_id` found): return a helpful message listing available devices and asking the user to open Spotify on a device first.

---

## 8. Rate Limiting

- All API calls go through a central `SpotifyClient` class with a request queue
- Requests are serialized with a minimum 100ms gap to avoid bursts
- On 429: pause the queue for `Retry-After` seconds, then resume
- Batch operations (e.g., `save_items` with multiple URIs) use single API calls instead of loops

---

## 9. Spotify API Constraints

Known limitations to document and handle:

| Constraint | Detail |
|---|---|
| **Premium required** | All playback control: play, pause, skip, seek, volume, shuffle, repeat, queue |
| **No audio** | API provides metadata and control only — no audio streams |
| **Search limit** | Max 10 results per type per call (reduced Feb 2026) |
| **Queue opacity** | `GET /me/player/queue` returns items but positions are not editable |
| **Removed endpoints** | `GET /artists/{id}/top-tracks`, batch `GET /albums`, `GET /artists`, `GET /episodes`, `GET /shows`, new releases — gone as of Feb 2026 |
| **Removed fields** | `popularity`, `followers`, `available_markets` no longer returned on tracks, artists, albums |
| **Unified library API** | Save/remove/check library items now uses `PUT/DELETE/GET /me/library` with **URIs** (not bare IDs). Type-specific endpoints (`/me/tracks`, `/me/albums`, etc.) are deprecated. |
| **Playlist items path** | All playlist item operations use `/playlists/{id}/items` (not `/tracks`) as of Feb 2026 |
| **Audiobooks market-gated** | Audiobook endpoints only available in US, UK, Canada, Ireland, New Zealand, Australia |
| **Dev mode limit** | 5 authorized users max until extended quota approval |
| **Token expiry** | Access tokens expire after 1 hour; refresh tokens are long-lived |
| **Redirect URI** | Must use `http://127.0.0.1` for local development — not `http://localhost` |
| **Market sensitivity** | Some tracks/albums are region-restricted; `market` param controls availability filtering |
| **Fetch-all cap** | `fetch_all` pagination (`client.getAllPages`) walks offset pages up to a maximum of 500 items per call |

---

## 10. Project Structure

```
spotify-mcp/
├── src/
│   ├── index.ts              # MCP server entry point (stdio transport)
│   ├── auth.ts               # OAuth flow, token storage, refresh logic
│   ├── client.ts             # SpotifyClient — fetch wrapper, rate limiting, token injection
│   ├── tools/
│   │   ├── audiobooks.ts     # get_audiobook, get_audiobook_chapters, get_chapter, get_saved_audiobooks
│   │   ├── playback.ts       # play, pause, skip_next, skip_previous, seek, set_volume, set_shuffle, set_repeat, get_now_playing, get_currently_playing, play_from_search, get_queue, add_to_queue, get_devices, transfer_playback
│   │   ├── search.ts         # search
│   │   ├── catalog.ts        # get_me, get_track, get_artist, get_artist_albums, get_album, get_album_tracks, get_show, get_show_episodes, get_episode
│   │   ├── personalization.ts # get_top_tracks, get_top_artists, get_recently_played
│   │   ├── library.ts        # get_saved_tracks, get_saved_albums, get_saved_shows, get_saved_episodes, save_items, remove_saved_items, check_saved_items
│   │   ├── playlists.ts      # get_user_playlists, get_playlist, create_playlist, add_to_playlist, remove_from_playlist, update_playlist, reorder_playlist_items, get_playlist_cover, upload_playlist_cover
│   │   └── following.ts      # get_followed_artists, check_following_artists
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

### `.env.example`
```env
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8888/callback
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
      "command": "npx",
      "args": ["-y", "spotify-mcp"],
      "env": {
        "SPOTIFY_CLIENT_ID": "your_client_id",
        "SPOTIFY_CLIENT_SECRET": "your_client_secret"
      }
    }
  }
}
```

### First-time setup
```bash
# 1. Create a Spotify app at developer.spotify.com
#    Add redirect URI: http://127.0.0.1:8888/callback

# 2. Run auth flow
SPOTIFY_CLIENT_ID=xxx SPOTIFY_CLIENT_SECRET=yyy npx spotify-mcp auth

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
| **Phase 4** | Library management (get saved tracks/albums/shows/episodes; unified save_items, remove_saved_items, check_saved_items via `/me/library`) |
| **Phase 5** | Playlist CRUD + item management (get_user_playlists, get_playlist, create_playlist, add_to_playlist, remove_from_playlist, update_playlist, reorder_playlist_items — all using `/items` endpoints) |
| **Phase 6** | Following (follow_artist, unfollow_artist, get_followed_artists, check_following_artists via unified `/me/library/contains`) |
| **Phase 7** | MCP Resources + Prompts |
| **Phase 8** | Package for npm (`spotify-mcp`) + README polish |
| **Phase 9** | Deprecation cleanup + coverage completion (2026-08): removed deprecated endpoints (audio features/analysis, recommendations, related artists, genres, featured playlists, follow/unfollow artist); create_playlist moved to `POST /me/playlists`; added album tracks, show episodes, get_me, audiobook family, get_currently_playing, play_from_search, playlist cover get/upload; fetch_all pagination via client.getAllPages; SPOTIFY_MCP_TOKEN_FILE override |
