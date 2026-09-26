# SpotifyMCP — Specification

A Model Context Protocol (MCP) server that gives Claude full control over Spotify — playback, search, library management, playlist curation, and music discovery.

---

## Table of Contents

1. [Goals & Non-Goals](#1-goals--non-goals)
2. [Architecture](#2-architecture)
3. [Authentication](#3-authentication)
4. [Implementation Contracts](#4-implementation-contracts)
5. [Tools](#5-tools)
6. [Resources](#6-resources)
7. [Prompts](#7-prompts)
8. [Error Handling](#8-error-handling)
9. [Rate Limiting](#9-rate-limiting)
10. [Spotify API Constraints](#10-spotify-api-constraints)
11. [Project Structure](#11-project-structure)
12. [Configuration](#12-configuration)
13. [Claude Desktop Integration](#13-claude-desktop-integration)

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

The package contract is generated directly from `package.json`; the census guard fails when dependencies, engines, or scripts drift.

<!-- BEGIN:generated package-contract -->
```json
{
  "type": "module",
  "engines": {
    "node": ">=22.9"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0",
    "open": "^11.0.1",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/node": "^26.4.1",
    "tsx": "^4.0.0",
    "typescript": "^7.0.2"
  },
  "scripts": {
    "build": "tsc && node scripts/add-shebang.js",
    "dev": "node --env-file-if-exists=.env --import tsx/esm src/index.ts",
    "auth": "node --env-file-if-exists=.env --import tsx/esm src/index.ts auth",
    "start": "node --env-file-if-exists=.env dist/index.js",
    "prepack": "npm run build",
    "test": "npm run build && node --import tsx --test 'tests/*.test.ts'",
    "test:coverage": "npm run build && node --import tsx --experimental-test-coverage --test-coverage-lines=75 --test-coverage-functions=70 --test-coverage-branches=60 --test-reporter=tap --test 'tests/*.test.ts'",
    "count:tools": "node scripts/surface-census.mjs",
    "check:docs-counts": "node scripts/surface-census.mjs --check",
    "check:doc-tool-names": "node scripts/check-doc-tool-names.mjs",
    "sweep": "node scripts/live-gauntlet.mjs --batch=40 --resume=memory/live-sweep-report.json --report=memory/live-sweep-report.json",
    "sweep:loop": "bash scripts/sweep-loop.sh"
  }
}
```
<!-- END:generated package-contract -->

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
> Browserless environments: set `SPOTIFY_HEADLESS=1` for the paste-flow auth (no local callback server). The full `SPOTIFY_*` configuration family — request timeouts, truncation caps, fetch-all cap, mutation history — is listed under [Configuration](#12-configuration).

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

`src/tools/annotations.ts` owns the `REGISTRAR_MANIFEST`, the single wiring
source for module registration, toolset keys, schema budgets, and census
attribution. `src/index.ts` creates the client and iterates that manifest through
`registerManifestModule`; it does not import each tool registrar individually:
```ts
for (const module of REGISTRAR_MANIFEST) {
  registerManifestModule(server, client, module, {
    readOnly,
    isModuleActive: (key) => isModuleActive(key, activeSets, overrides),
    scopeBlocked: (key) => moduleBlockedByScopes(key, grantedScopes),
  });
}
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
- **Request funnel**: a two-lane (normal/low) queue behind ONE shared start gate. Each launch reserves a start slot before it waits — minimum 100 ms between starts, no start during a `Retry-After` cooldown — and a permit bounds how many gated requests are open at once (`SPOTIFY_MCP_MAX_CONCURRENCY`, default 3). On 429 the gate parks every caller for the `Retry-After` window and the throttled call re-queues once behind the same gate, so one window is paid for the funnel rather than one per caller. `getRateLimitStatus()` also reports `inFlight` / `maxConcurrency` / `peakInFlight` / `throttleStreak`
- **Bounded retry**: 502/503/504 responses and idempotent-verb transport failures retry inside a shared 3-dispatch budget, waiting `Retry-After` when the response carries one and otherwise a jittered exponential backoff (250 ms·2ⁿ + 0–250 ms). A wait beyond the 10 s in-queue cap fails fast rather than holding the queue
- **Response parsing**: throw a typed `SpotifyApiError` on non-2xx with `status` and `message` from the Spotify error body
- **Mutation body parsing (#674)**: a 2xx write whose body cannot be read or parsed resolves to `null` rather than raising — never a raw `SyntaxError`. A write Spotify accepted has already landed, so an unreadable body is a lost *response*, not a failed *mutation*, and reporting it as a failure invites the caller to retry a write that succeeded (queue duplicates, double playlist adds, duplicate library saves). Post-write bookkeeping (read-cache invalidation and the history line) runs as soon as the request is accepted, so it cannot be skipped by a body that will not parse. The read path is deliberately asymmetric: there `null` is a real answer meaning "204, nothing here", so an unparseable `GET` body stays an error.
- **Token memory management**: The `SpotifyClient` holds the token state in memory (not read from disk on every request). On initialization it reads `~/.spotify-mcp/tokens.json`. On successful refresh it updates its in-memory state AND writes back to disk. This ensures the long-running MCP server process doesn't repeatedly hit disk.
- **Request timeouts**: every outbound HTTP call (API requests and token refresh) carries an `AbortSignal.timeout` — 30 s by default, overridable via `SPOTIFY_REQUEST_TIMEOUT_MS`. Expiry raises a 408-style `SpotifyApiError`, which returns the task's permit like any other failure, so a hung connection can never shrink the pool or stall the funnel.
- **Read cache**: immutable catalog reads go through an LRU TTL cache (~5-minute entry lifetime, 200 entries max); mutations and player calls bypass it. Since #894 the cache is bounded **by bytes** as well as by count (8 MB total, 1 MB per entry, both configurable): a count bound is not a memory bound when a single 100-track playlist page is ~150 KB, and an entry too large to fit the budget is refused rather than admitted and immediately evicted — refusals are counted, never absorbed, because a cache that silently stopped caching is worse than one that says so. Each entry is charged the exact UTF-8 length of the body it arrived as, so eviction is by least-recently-used until the byte total is back under the ceiling. Cache keys are canonical over method + path + params, with pairs sorted by name then value: `{limit, offset}` and `{offset, limit}` are one entry and one network read, while any real difference (a limit, an offset, an added param, a different path) keeps its own entry. `getRateLimitStatus()` exposes `cacheEntries` / `cacheBytes` / `cacheMaxBytes` / `cacheSkippedOversize`, and `spotify_doctor` reports them as the `cache` row.
- **Rate-limit visibility**: the most recent 429 (`Retry-After` seconds, wait time, timestamp) is retained on the client, exposed via the `spotify://me/rate-limit` resource, and appended as a notice to the throttled call's result.
- **Request/quota usage tracking (#904)**: the drain path maintains a cumulative request counter plus per-request timestamps (pruned to the longest exposed window); `getRateLimitStatus()` exposes `requestsTotal` / `requestsLastMinute` / `requestsLastHour` via the same resource and `spotify_doctor`. Heavy composite scans (`library_hygiene`, `saveddedupe` walks, `whats_new`, `swarm3library` fan-outs, `dead_library_finder`, `playlist_staleness_report`) consult the shared cooldown first (`quotaPreflight` — blocked scans return an actionable wait message and issue 0 requests) and otherwise shrink their walk budget to the remaining quota window (`quotaWindowRemaining`), disclosing `requests_made` plus `requests_planned`/`budget_shrunk` in payloads. Cache hits bypass the queue and cost no quota, so they are not counted.
- **Mutation history**: when `SPOTIFY_MCP_HISTORY=1`, successful mutations append a whitelisted record (method, path, `snapshot_id` when present) to `~/.spotify-mcp/history/mutations.jsonl` (directory overridable via `SPOTIFY_MCP_HISTORY_DIR`). `who` names the issuing tool, captured at the single tool-invocation boundary, and is `agent` only for a mutation that did not come through a tool. History failures never fail the underlying mutation: a lost append is counted, warns once per process on stderr, and turns the `spotify_doctor` row `history` red alongside the resolved ledger path, so a trail with gaps never reads as complete.
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

`get` appends `params` as query string; all methods prepend the base URL. The mutators return the parsed JSON response, or `null` when there is no payload to report — `204 No Content`, a non-JSON body (e.g. a queue id as `text/plain`), or a body that will not parse (#674).

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
| `get_artist_top_tracks` | GET | `/artists/{id}/top-tracks` — **removed/deprecated**; see the note below |
| `get_artist_albums` | GET | `/artists/{id}/albums` |
| `get_several_artists` | GET | `/artists?ids=…` — up to 50 per request |
| `get_album` | GET | `/albums/{id}` |
| `get_album_tracks` | GET | `/albums/{id}/tracks` |
| `get_several_albums` | GET | `/albums?ids=…` — up to 20 per request |

> **`/artists/{id}/top-tracks` status (#901).** The two platform sources disagree, so
> neither is used as a single claim of fact. The current OpenAPI schema
> (<https://developer.spotify.com/reference/web-api/open-api-schema.yaml>) still
> publishes the path, flagged `deprecated: true`; Spotify's February 2026 Web API
> changelog lists the same path as `[REMOVED]` with **no replacement named**. What
> is observable is therefore registration-dependent rather than artist-dependent:
> a registration without the grant answers 403 or 404/410, and the answer is
> identical for every artist in a fan-out. Tools that call it
> (`artist_collab_network`, `artist_completeness_score`) probe once and fail fast
> on the first gated or removed answer via the shared contract in `src/gating.ts`
> (`isGatedError` / `graceful403Message`), which annotates and rethrows the original
> `SpotifyApiError`; they never substitute a fabricated `0%` or `0` tracks for a
> read that did not happen.
| `get_show` | GET | `/shows/{id}` |
| `list_show_episodes` | GET | `/shows/{id}/episodes` |
| `show_new_episodes` | GET | `/me/shows` then `/shows/{id}/episodes` per show — the per-show reads are market-gated and default `market` (§10) |
| `get_several_shows` | GET | `/shows?ids=…` — up to 50 per request |
| `get_episode` | GET | `/episodes/{id}` |
| `get_several_episodes` | GET | `/episodes?ids=…` — up to 50 per request |
| `get_audiobook` | GET | `/audiobooks/{id}` — `market` defaults to the argument, then `SPOTIFY_MCP_MARKET`, then the account country when `GET /me` still carries one |
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

<!-- BEGIN:generated tool-surface -->
The finalized default MCP registry exposes **592 tools** (all 592 attributed to the 66 files under `src/tools/`), organized by 45 registration keys and 13 named toolsets. Registration keys: `artistwatch`, `audiobooks`, `browse`, `catalog`, `doctor`, `episodemgmt`, `exhaust2catalog`, `exhaust2enggating`, `exhaust2extra`, `exhaust2misc`, `exhaust2playback`, `exhaust2playlists`, `following`, `library`, `libraryanalytics`, `personalization`, `playback`, `playbackext`, `playbackintel`, `playlistbatch`, `playlisthealth`, `playlistmisc`, `playlists`, `portability`, `prompts`, `queueops`, `receipts`, `resources`, `search`, `searchhistory`, `statsfm`, `swarm3analytics`, `swarm3bdiscovery`, `swarm3discovery`, `swarm3library`, `swarm3meta`, `swarm3playback`, `swarm3playlistops`, `swarm3refs`, `swarm3shows`, `swarm3snapshots`, `swarm4playlists`, `taste`, `tastecomposites`, `users`. `node scripts/surface-census.mjs` derives the authoritative inventory by starting the real `src/index.ts` stdio entry and calling `tools/list`, `resources/list`, `resources/templates/list`, and `prompts/list` after production gates and finalizers, without network access.
<!-- END:generated tool-surface -->

### Shared tool contract

Beyond their endpoint-specific arguments, every tool shares this contract:

- **`response_format`** (`'concise' | 'detailed' | 'json'`, default `'concise'`) — `'concise'` renders human-readable prose, `'detailed'` appends fields the concise view drops, and `'json'` returns the raw API payload as JSON text.
- **`structuredContent`** — every result attaches its machine-readable payload as MCP structuredContent alongside the human-readable text.
- **`max_results`** (list-type tools; positive integer, ≤ 2000) — per-call truncation cap. The default comes from `SPOTIFY_MCP_MAX_ITEMS` (50). Truncated lists state how many items were withheld; pagination info (total / offset / next offset) rides in structuredContent and a footer hints at the next page.
- **Paging signal** (any tool that reads one `offset` page of a larger collection: `search`, `search_deep`, the `search_<type>` family, `search_by_isrc`, `audiobooks_by_author`, and the other typed search tools) — the offset to continue from is printed as a `Next page: offset=N` line in the prose **and** carried in the `pagination` object of structuredContent. A line-oriented agent never reads structuredContent, so the prose line is the operative one; both are derived from the same value, so they cannot disagree. The line is omitted, and the pagination object's next offset is null, once the walk is exhausted — an exhausted page must not tell the agent to keep going. `structuredContent.pagination` always reports the page that was actually requested (offset and limit as sent to `/search`, never a hardcoded zero), and a `next_offset` is only emitted for a tool that declares the `offset` control it names: the truncation boundary strips an offset a caller cannot act on, because a paging signal the caller has no way to use is not a signal.
- **`fetch_all`** (paged reads) — walk every page via `client.getAllPages`, capped by `SPOTIFY_MCP_FETCH_ALL_CAP` (500). Long walks emit MCP progress notifications per page.
- **`dry_run`** (destructive operations) — validate inputs and describe exactly what would change without calling the mutating endpoint. Conformance is enforced registry-wide by `tests/mutations.conformance.test.ts` (#920): the guard enumerates the live registry via `tools/list` and asserts every write-capable tool exposes `dry_run` and `response_format` unless allowlisted with a one-line reason (local sidecars only); known gaps pending sibling slices are pinned in `KNOWN_MISSING_*` lists.
- **`dry_run` default on mutating tools (v2, #827)** — a mutating tool declares the shared `DryRunDefault` fragment (`src/shaping.ts`), which is `dry_run` with `.default(true)`, and branches on `isDryRun(args)`. An omitted `dry_run` is therefore a **preview**; the write is an explicit `dry_run: false`. The bare `DryRun` fragment still declares no default and is only for read-only tools, so a `DryRun`-declared flag on a write path silently committed before this rule. This is a breaking change for callers that relied on the implicit commit: they must now pass `dry_run: false`. Migrating a module to the rule means replacing the inline `z.boolean().optional().default(true)` it declared locally with `DryRunDefault` — the behaviour is identical, so only the shared contract is new. The `exhaust2misc` slice is migrated in #827: `quick_save_now`, `discover_weekly_diff`, `dead_library_finder`, `week_in_review_playlist`, `chapter_bookmarks`, `playlist_from_tags` and `device_sync_state` all preview when the flag is omitted. `discover_weekly_diff` additionally always states the mode it ran in, so a `save_after` call that returns a diff reports `dry_run: false` after a committed archive replace and `dry_run: true` after a preview — the archive replace is a `PUT /playlists/{id}/items` and discards the playlist's previous item list.
- **`dry_run` default in the playback family (v2, #836) — BREAKING, and the opposite of #827.** Playback mutations commit when `dry_run` is omitted, and they say so: each declares the shared `PlaybackDryRun` fragment (`src/shaping.ts`), which is `dry_run` with `.default(false)`, so the published input schema carries `"default": false` and the field description names the commit semantics. A host reading `tools/list` now gets the same answer from every playback tool — `play`, `pause`, `mute`, `switch_device`, `queue_replace_via_playlist` and the rest all use that one fragment, replacing a state where the exhaustive playback module defaulted an omitted flag to a preview while the core playback, queue, playback-ext, playback-intel, scene and third-wave playback modules all defaulted it to a commit, and the shared `DryRun` fragment advertised no default at all. **Callers that relied on the implicit preview in the playback set must now pass `dry_run: true` explicitly.** Playback mutations are additive and reversible, which is why they keep the commit default rather than joining #827's preview default; #827's concern is the replace-shaped writes that discard prior content with no receipt. The library, playlist and podcast families are unchanged: they still preview when `dry_run` is omitted and still declare no schema default, because publishing one there would advertise a behaviour those tools do not honour. Unifying those families is a separate sweep.
- **Batch summaries** — mutations echo a "{n} items affected: uri0, uri1, …" line (first three URIs), and playlist mutations include Spotify's returned `snapshot_id` for optimistic-locking follow-ups.
- **Partial-write state on chunked playlist writes** (#865) — a playlist write that spans more than one request can fail partway through, leaving a playlist that matches neither the plan nor its prior contents. Rather than surfacing a bare error, these tools return a normal result carrying `partial_write_failure: true` and, in both prose and `structuredContent`: `attempted_chunks`, `failed_chunk_index` (0-based), `last_committed_chunk_index` (`-1` when nothing landed), `last_committed_chunk_uris` (the URIs of the last chunk that committed), `error` (Spotify's own message when present), plus the tool-specific `attempted_uris` / `committed_uris` / `remaining_uris` counts. `last_committed_chunk_uris` holds one chunk; `committed_uris` is the total across every committed chunk, so the two agree only when a single chunk committed. Because the committed chunks are always a prefix of the input list, a retry resumes at `remaining_uris` rather than re-adding what already landed. No further chunk is issued after the failure. Applies to `add_to_playlist`, `replace_playlist_items`, `batch_add_to_playlist`, `copy_playlist`, `move_items_between_playlists` (which distinguishes the add step from the remove step via `step`, and skips the remove entirely when the add is partial), `merge_playlists`, `playlist_template_apply` (which also reports the `playlist_id` of the playlist it already created, so an orphaned empty playlist can be found), and the destructive-replace family `playlist_sort` / `playlist_shuffle` / `playlist_reverse` / `playlist_union` / `playlist_subtract` / `playlist_trim`.


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
| `search_type` | `"track"` \| `"episode"` | no | What to search for. Default: `"track"` |
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
| `limit` | number | no | Results per type, 1–10. Default: 5. Use `offset` with repeated 10-result requests to page deeper |
| `market` | string | no | ISO 3166-1 alpha-2 country code |
| `offset` | number | no | Index of the first result to return, 0–1000 — use with `limit` to page through results |
| `include_external` | string | no | Pass `"audio"` to include externally-hosted audio items marked as playable |

**Returns:** grouped results by type. Each item includes URI, name, and type-specific fields (artist names, album name, release date, duration, etc.).

`playlist_fill_from_search` also sends at most 10 track results per `/search` request. It requests later offsets only when the requested number of new playlist items has not yet been found, and its plan discloses the candidate count and pages searched for every query. Its pre-read of the playlist's existing items is covered by [the exhaust2 playlist-item walk contract](#exhaust2-playlist-item-walk-contract-898).

---

#### exhaust2 playlist-item walk contract (#898)

`playlist_expression_algebra` and `playlist_fill_from_search` both read source playlists through one helper, and both turn what they read into a **write**. The walk is therefore capped by `SPOTIFY_MCP_FETCH_ALL_CAP` (default 500) and the cap is **disclosed**: a clipped walk must never reach a caller as a list that reads as the whole playlist, because that silently drops items out of the playlist it writes.

| Field | Meaning |
|---|---|
| `truncated` | `true` when at least one source playlist's walk stopped short. Present on `playlist_expression_algebra` in both dry-run and committed results. |
| `total` | Rows the source playlists hold as Spotify states them — `null` unless every ref stated a count, never a partial sum. |
| `returned` | URIs actually read across all refs. |
| `truncated_refs` | The refs whose walk stopped short. Empty when nothing was clipped. |
| `ref_scans` | Per ref: `ref`, `returned`, `total`, `truncated`, `truncated_by_cap`, `scan_cap`. |
| `scan_cap` | The `SPOTIFY_MCP_FETCH_ALL_CAP` value in force. |
| `existing_truncated`, `existing_scanned`, `existing_total`, `existing_truncated_by_cap` | `playlist_fill_from_search`'s view of the same walk for its single target playlist. `existing_truncated` is what says the already-present exclusion set is incomplete — a pick may duplicate an item the walk never read. |
| `now_total` | `playlist_fill_from_search` only: the playlist's length after the write, computed from a **complete** pre-read. `null` when the pre-read was capped, because `existing + added` would be arithmetic over a count nobody verified. |

`truncated` and `truncated_by_cap` are different questions and both are reported. A walk can end at the cap having cut nothing off (cap exactly equals the reported total): `truncated_by_cap` is then `true` and `truncated` is `false`, and only the second one means rows are missing.

Item pages request `fields=items(item(uri)),total,limit`. The set algebra reads only URIs, so no nested track object is transferred or retained; `total` and `limit` stay in the filter because the walk reads them to tell a short page that was the end of the list from one that was not. Each ref costs 1 `GET /playlists/{id}` plus up to `⌈SPOTIFY_MCP_FETCH_ALL_CAP / 100⌉` item pages — a multi-ref expression multiplies that by the number of distinct refs.

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

**Returns:** name, description, publisher, explicit, total_episodes, languages, media_type, URI, and a ten-row episode preview (name, duration_ms, release_date, resume_point, URI). When the show holds more, the card states how many episodes of how many it showed and points at `list_show_episodes`.

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

#### `list_show_episodes`
List one podcast show's episodes newest-first from `GET /shows/{id}/episodes`.

**Inputs:** `show_id` (string, required), `offset` (number, optional), `market` (string, optional), plus shared `response_format` and `max_results` controls. Use `offset` for the next page; `max_results` caps returned rows.

**Returns:** episode name, release date, duration, URI, and pagination metadata.

---

#### `get_artist_top_tracks`
Get an artist's ten most-played tracks for a market.

**Inputs:** `id` (string, required), `market` (string, optional — defaults to `SPOTIFY_MCP_MARKET`; §4.0.4 has the full precedence)

A 403 here usually means the endpoint isn't enabled for this app registration or a required scope is missing; the error says so explicitly.

---

#### `get_available_markets`
List the country codes of every market where Spotify is available — useful for validating `market` inputs to other tools.

**Inputs:** shared response fields only (`response_format`, `max_results`)

**Returns:** list of market entries from `GET /markets`.

---

#### The `get_several_*` batch family
Seven batch lookup tools fetch full details for several IDs in a single call per chunk. Every requested ID is accounted for: IDs Spotify could not resolve are named in prose and listed under `counts.missing_ids` instead of vanishing, and a request that resolves none fails with the unresolved IDs in the error.

| Tool | Endpoint | Max IDs per request |
|---|---|---|
| `get_several_tracks` | `GET /tracks?ids=…` | 50 |
| `get_several_albums` | `GET /albums?ids=…` | 20 |
| `get_several_artists` | `GET /artists?ids=…` | 50 |
| `get_several_episodes` | `GET /episodes?ids=…` | 50 |
| `get_several_shows` | `GET /shows?ids=…` | 50 |
| `get_several_audiobooks` | `GET /audiobooks?ids=…` | 50 |
| `get_several_chapters` | `GET /chapters?ids=…` | 50 |

These limits, the 100-uri playlist item writes, the 40-uri `/me/library`
writes and the 50-uri `/me/library/contains` reads are the rows of
`CHUNK_CAPS` in `src/chunk.ts`. A batch loop under `src/tools/` takes its
bound from that table through `capFor(kind)` or `chunk(items, kind)`; a bare
number there is rejected by `tests/chunk-caps.test.ts` unless the line says
`cap-exempt:` and why. `spotify_doctor`'s config row and `toolset_report`
both print the resolved table, so the live policy is observable without
reading the code. `restore.ts` and `undo.ts` still hold their own named
chunk constants pending their own migration.

**Inputs:** `ids` (string[], required — longer lists are fetched in chunks of the per-request maximum and merged), plus shared response fields. The audiobook variants are market-gated like the single lookups.

**Returns:** full objects per resolved ID plus a `counts` block (`requested`, `resolved`, and `counts.missing_ids`); `response_format=json` hands back the items together with the same `counts` block.

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

#### `taste_shift_report`
Compare the `short_term` and `long_term` top-track and top-artist lists, reporting per domain what is rising, what is falling, and how much the two windows overlap (Jaccard). Quota: 4× `GET /me/top/*`.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `limit` | number | no | 1–50, applied to each window. Default: 20 |

**Returns** (`structuredContent`): `window_sizes` — `short_term` / `long_term` item counts totalled across both top lists — plus `tracks` and `artists`, each carrying its own `window_sizes` pair, a `jaccard`, and up to 10 `rising` and 10 `falling` ids.

`jaccard` is `null` when **both** windows of that domain are empty: the two sets have no union to divide by, so the comparison was never made and the maximum-similarity answer is refused. A single empty side yields `0`, which is what the same arithmetic always produced. Whenever any of the four lists comes back empty the prose leads with `insufficient history to compare` and names the empty side, while the domains that did compute still print their value. Hosts must read `null` as "not enough data", not as a score.

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

#### Playlist write receipts (#879)

Every tool that commits playlist items issues a mutation receipt per written chunk and reports the outcome of its own verification. A write the API accepted and then silently dropped is reported as a failure rather than a completed change, which is why these tools re-read `/playlists/{id}/items` after writing instead of trusting the `2xx`.

**`structuredContent` additions** (prose gains one `formatReceipt` block per receipt, in issue order):

| Field | Meaning |
|---|---|
| `ok` | `false` as soon as one receipt fails verification. Never a hard-coded `true` on a committed write. |
| `expected` | Rows the write asked the API to land — uris confirmed present for an add, rows written for a replace, uris removed for a removal. |
| `actual` | Rows the re-read confirmed. Derived from the receipts' own `missing` / `after` values, never from the request the tool sent, so a short read surfaces as a low count. |
| `receipts` | The receipt records (below), in issue order. |

**What each receipt checks**, by write shape — a receipt that cannot fail for its write shape is worse than no receipt, so the checks differ:

- **Add / append** — every written uri is present. A no-op leaves rows the uris were never in, so presence alone catches it.
- **Remove** — every removed uri is absent, with the row count checked against the pre-mutation `before` total. A bare-uri delete uses the absence check; a positions-targeted delete states its `targetedPositions` so a playlist holding a duplicate of the same uri is not reported as still holding it.
- **Replace** (`PUT /playlists/{id}/items`) — presence, PLUS the post-write row count, PLUS the row order the first chunk wrote from position 0. The count and order are what catch a dropped replace: a no-op `PUT` leaves the old rows in place, and a reorder such as a reverse preserves both the multiset and the count, so a presence- or count-only check would certify a dropped reverse as verified.

A response carrying no `total` leaves the row-count check unset rather than guessed at, and the walk is never padded into a pass. When a check that is not about uris fails, the reason is reported in the receipt's `unmet` (e.g. `row count 5 ≠ expected 2`), kept out of `missing`, which is documented as uris the walk did not find and is consumed as data by `undo_mutation`.

**Tools carrying the contract:** `apply_snapshot_changes`, `balance_playlist_pairs`, `collab_mix_from_followed`, `dedupe_playlist_apply`, `extract_playlist_range`, `filter_playlist_by_artist`, `filter_playlist_by_duration`, `filter_playlist_by_era`, `interleave_playlists_plan`, `library_to_playlist`, `merge_playlists_plan`, `move_tracks_between_playlists`, `playlist_add_by_search`, `playlist_clone_live`, `playlist_difference_plan`, `playlist_expression_algebra`, `playlist_exclude_artists`, `playlist_fill_from_search`, `playlist_intersect`, `playlist_keep_only`, `playlist_move_to_top`, `playlist_slice`, `playlist_strip_episodes`, `playlist_trim_to_duration`, `queue_replace_via_playlist`, `remove_playlist_range`, `replay_session`, `restore_library_snapshot`, `restore_playlist_from_snapshot`, `reverse_playlist_plan`, `rotate_playlist_plan`, `save_queue_as_playlist`, `saved_tracks_roulette`, `sort_playlist_apply`, `split_playlist`, `split_playlist_by_count`, `split_playlist_by_duration`, `split_queue_plan`.

`dry_run` results are unchanged: no request is sent, nothing is verified, and these fields describe the write as it would land rather than as it landed.

#### Playlist set/diff input contract (#912)

All playlist set-operation, diff, overlap, intersection, union, subtraction, merge, following, and pair-analysis tools compose the same typed fragments from `src/shaping.ts`. Playlist references accept a raw ID, `spotify:playlist:` URI, or Spotify playlist URL and are normalized to the ID used in `/playlists/{id}` paths.

| Tool family | Tools | Canonical input | Legacy aliases (supported through v2.0; removed in v2.1) |
|---|---|---|---|
| Ordered multi-playlist operation (one alias each, per tool) | `playlist_intersection`, `playlist_overlap_matrix`, `playlist_intersect`, `playlist_union`, `merge_playlists`, `merge_playlists_plan`, `interleave_playlists_plan`, `playlist_union_preview`, `find_duplicate_tracks_across_playlists`, `balance_playlist_pairs` | `playlists` | The tool's prior plural name: `playlist_ids`, `source_playlist_ids`, or `sources` |
| Ordered overlap analysis | `overlap_playlists` | `playlists` | None; canonical-only input |
| Base-minus-set operation | `playlist_subtract`, `playlist_difference_plan` | `base_playlist_id` plus `playlists` for the sources to subtract | `subtract_playlist_ids`, and the positional form `playlists: [base, ...sources]` |
| A/B comparison | `diff_playlists`, `playlist_diff`, `playlist_pair_check`, `compare_playlist_covers`, `playlist_symmetric_difference` | `playlist_a`, then `playlist_b` | one per tool, not a bundle: `diff_playlists` takes `a`/`b`, `compare_playlist_covers` and `playlist_symmetric_difference` take `playlist_id_a`/`playlist_id_b`, `playlist_diff` and `playlist_pair_check` take `playlist_a_id`/`playlist_b_id` |
| Following fan-out | `check_playlist_following` | `playlists` | `playlist_ids` (retains its historical 1–50 bound) |

**Returned versus total counts.** Where a set operation returns arrays, `removed`/`kept` (and `uris`/`removed_uris` beside them) count only the rows actually returned, bounded by `max_results`; `removed_total`/`kept_total` carry the true impact the confirmation prompt quoted. A capped response therefore never reports a count its own arrays contradict.

**Planned-move arrays.** `balance_playlist_pairs` plans one move object per track, so the plan is bounded by the same `max_results` cap as its prose: `moves` in structuredContent carries the capped rows, and `moves_total` / `moves_returned` / `moves_withheld` / `moves_truncated` disclose the full plan the array withheld. `response_format: 'json'` is the full-record opt-in — it returns every move and reports `moves_withheld: 0`.
**Empty results clear the playlist (#888).** When `playlist_subtract` removes every track, or `playlist_union` merges only empty sources, the target list is empty and the tool sends one `PUT /playlists/{id}/items` with `{ "uris": [] }`. This is the endpoint's documented clear — the OpenAPI description for `reorder-or-replace-playlists-items` states that the operation "can be used for replacing or clearing items in a playlist", and the body's `uris` array declares no `minItems` — so it is not emulated with a descending sweep of position-based `DELETE`s (N requests instead of 1, and a half-emptied playlist if one fails). A full wipe still passes the destructive confirmation gate, because emptying makes the replacement non-identical. Such a result reports `emptied: true` and its own prose line (`Playlist emptied` / `Emptied <id>`). The 200 body is `{snapshot_id: string}` with no `required` list, so the clear can come back with no readable receipt; when that happens the result is `ok: false` with `reason: "clear_unconfirmed"` and `snapshot_read: false`, and the prose says the clear was *sent* but is unconfirmed — an unreadable receipt is never reported as a confirmed clear over a null `snapshot_id`.

**Migration note (v2.0 → v2.1):** legacy names remain callable through v2.0 and are removed in v2.1. Supplying both canonical and legacy values is accepted only when they normalize to the same values in the same order; missing, incomplete, differently ordered, or conflicting inputs fail before any Spotify request and name both conflicting fields. Legacy results include `deprecated_inputs` plus `deprecation_note` in structuredContent and the same one-line note in prose/JSON text. Canonical-only calls omit both fields.

#### Full-sequence rewrite contract (#860)

`playlist_sort`, `playlist_shuffle`, `playlist_reverse`, `playlist_trim`, `playlist_union` (existing `target_playlist_id` only) and `playlist_subtract` (the `base_playlist_id` only) commit through one atomic `PUT /playlists/{id}/items` built from a URI-filtered list. Spotify returns a removed, relabelled or region-unavailable row with `item: null`, so that row carries no URI and a URI-based replace cannot restore it: the first PUT deletes it from the live playlist, and the counts reported afterwards come from the already-filtered list, so nothing in the response reveals the loss.

Each of these tools therefore **refuses before the first PUT** when the playlist being overwritten holds an unavailable row, naming the count, the 1-based position(s) (up to ten, with `…` beyond that) and `remove_unavailable_playlist_items` as the remedy. The refusal is a thrown error, not a soft `ok: false` result, and it fires ahead of the elicitation gate — a prompt can name a loss and still be approved, which is not consent worth acting on for an irreversible row deletion. Nothing is written, and the caller's existing confirmation gate is unchanged for playlists with no unavailable rows.

Two consequences callers can observe:

- `dry_run: true` still renders its plan, and appends the refusal beneath it. A preview that promised a write the apply path throws on would be the same false claim in a new place.
- `playlist_union` and `playlist_subtract` dry-run payloads gain `would_refuse`; where the plan would otherwise prompt, `would_confirm` is now `false` in that state. `target_unrepresentable` / `base_unrepresentable` are unchanged and still report the count on the preview.
- A union that creates a new playlist (`target_name`) is not gated: no live rows are being destroyed.

**Migration note (breaking, v2.0):** a call that previously committed over a playlist with unavailable rows now fails. The tool names the count and the positions; run `remove_unavailable_playlist_items` (or `playlist_health_check` to find them) and retry.

#### `get_playlist`
Get a playlist's metadata and its items. Makes two calls: `GET /playlists/{id}` for metadata, then `GET /playlists/{id}/items` for the track/episode list.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `playlist_id` | string | yes | Playlist ID (`id` is a back-compat alias, per the alias table above) |
| `limit` | number | no | Items per page, 1–100. Default: 50 |
| `offset` | number | no | Pagination offset for items |
| `market` | string | no | ISO 3166-1 alpha-2 country code — relinks tracks to that market and flags unavailable ones. Forwarded to **both** the metadata read and the item pages |
| `fields` | string | no | Comma-separated response fields to keep, e.g. `total,items(track(name,uri))`. Forwarded to **both** calls |
| `additional_types` | string[] | no | Item types beyond the default `track`; the schema accepts `track` and `episode`, sent comma-separated. Forwarded to **both** calls |
| `fetch_all` | boolean | no | Fetch every page of items via `client.getAllPages` (capped by `SPOTIFY_MCP_FETCH_ALL_CAP`, default 500) instead of a single page |

**Returns:** name, description, owner, is_public, is_collaborative, total item count, URI; plus paginated items (track/episode name, artists/show, duration_ms, added_at, URI).

**Fetch-all paging.** The walk after the first page runs through `client.getAllPages`, so pages enqueue at LOW priority and report progress like the rest of the `fetch_all` family. It resumes from the caller's `offset` plus the rows already collected — the offsets ascend by the real page size, not by the count collected so far (#884).

**Unavailable items.** An item with no playable track is enumerated as `[unavailable in this market]`, exactly as `get_playlist_items` renders the same row, so the numbered list and the "showing N" count above it always agree (#884).

**Note on `fields` with `json`.** `json` mode returns the raw Spotify objects, so a `fields` filter that excludes `owner` yields a playlist object without one. The prose renderer reads `owner` defensively and falls back to `unknown owner` rather than throwing (#884).

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

#### `search_within_playlist` (#731)
Text search inside one playlist, as a client-side filter over the rows the walk read. For a narrow query that is cheaper than paging `get_playlist_items` yourself; the trade-off is that the filter can only ever see the window the walk read, so the payload says how much of the playlist that was. Text is matched (case-insensitively) against the item name, artist names, album name and show name. `kind` narrows a mixed playlist — the same `/playlists/{id}/items` rows carry both shapes, and before this tool existed an agent looking for episodes had to walk the whole playlist by hand.

The walk uses `get_playlist_items`' cap and its truncation verdict: `SPOTIFY_MCP_FETCH_ALL_CAP` bounds the walk, and a scan that hits the cap says so rather than reporting a narrow result as a complete one.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `playlist_id` | string | no | Playlist ID (or pass it as `id`) |
| `id` | string | no | Alias for `playlist_id`, matching `get_playlist_items`; passing both is allowed only when they agree, and conflicting values fail before any API call |
| `query` | string | yes | Substring to match against track/episode name, artist, album, show name |
| `kind` | string | no | `track`, `episode`, or `any`. Default: `any` — which is the pre-2.0 behaviour, since the text match already reached episodes, so widening is not a silent behaviour change for existing callers |
| `market` | string | no | ISO 3166-1 alpha-2 country code, for track relinking |
| `response_format` | string | no | shared |
| `max_results` | number | no | shared — how many MATCHES are returned, not how many rows are scanned |

**Returns:** the matching rows (name, artist or show, URI, and the row's kind), the pagination block, and the walk's own coverage: `scanned_items` (rows the filter actually saw), `matched`, `scan_cap`, `scan_truncated`, plus the resolved `playlist_id`, `query` and `kind`. Rows that identify as neither shape are excluded from a `track`/`episode` filter and counted as `items_of_unknown_kind` rather than filed under a kind nobody confirmed. A truncated walk also appends the playlist family's shared `TRUNCATED` prose clause.

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

#### `move_items_between_playlists`
Bulk rehome items between playlists. `mode: copy` leaves the source intact; `mode: move` copies to the
target and then removes **exactly the occurrences it transferred** from the source.

A move addresses the source by playlist position (`{ uri, positions: [p] }`), never by bare URI, and
issues the removals in descending position order. Both matter: a bare URI removes **every** occurrence
of that track, so moving out of a playlist with intentional repeats would silently discard the extra
copies while the receipt counted one; and descending order is what keeps positions valid across a
request, because a removal only re-indexes the rows above it. Rows outside the filter and copies that
were never transferred stay in the source.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `source_playlist_id` | string | yes | Source playlist ID, `spotify:playlist:` URI, or URL |
| `target_playlist_id` | string | yes | Target playlist ID, `spotify:playlist:` URI, or URL |
| `mode` | `'copy' \| 'move'` | no | `copy` = leave source intact; `move` = remove from source after copy (default: `copy`) |
| `dedupe` | boolean | no | Skip tracks already in target, and de-duplicate repeats within the source. Default: `true` |
| `filter` | string | no | Only transfer tracks whose name or artist name contains this string (case-insensitive) |
| `dry_run` | boolean | no | Preview only |
| `limit` | integer | no | Source page size, 1–100 (default: 100) |
| `scan_cap` | integer | no | Maximum source rows to scan; bounded by `SPOTIFY_MCP_FETCH_ALL_CAP` |

**Returns:** `transferred` (items copied to the target), removed_occurrences (source occurrences
actually removed — equal to `transferred` in `move` mode, `0` in `copy` mode), skipped_duplicates,
add_batches / remove_batches, `snapshot_id`, and remove_snapshot. A `move` whose removal count
disagrees with `transferred` throws rather than reporting success. Elicitation fires at 50+ items.
`dry_run` returns would_transfer and would_remove_occurrences and issues no writes.

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

> Audiobook content is market-gated: it is only available in US, UK, Canada, Ireland, New Zealand, and Australia. When `market` is omitted on a lookup (`get_audiobook`, `get_audiobook_chapters`, `get_chapter`, `get_artist_top_tracks`), the market comes from the `market` argument, then `SPOTIFY_MCP_MARKET`, then the account country when `GET /me` still carries one — Spotify removed `country` from `GET /me` in its February 2026 changes, so on a current registration nothing supplies a default, the request is sent unscoped, and the result reports `market_source: "none"`; if Spotify still rejects the lookup, the error carries a hint to retry with an explicit market code.

#### `get_audiobook`
Get full details for an audiobook.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Audiobook ID |
| `market` | string | no | ISO 3166-1 alpha-2 country code |

**Returns:** name, authors, narrators, description, publisher, total_chapters, media_type, URI, and a ten-row chapter preview. When the book holds more, the card states how many chapters of how many it showed and points at `get_audiobook_chapters`.

---

#### `get_audiobook_chapters`
List an audiobook's chapters with pagination. Resume positions require the `user-read-playback-position` scope.

**Inputs:** `id` (string, required), `limit` (1–50, default 20), `offset` (optional), `fetch_all` (boolean, default false)

**Returns:** chapter name, description, duration_ms, release_date, resume_point, URI; plus total chapter count. `fetch_all: true` walks every page up to `SPOTIFY_MCP_FETCH_ALL_CAP` instead of returning one page, and reports the walk's verdict — in the prose, in `structuredContent` and in json mode — so a walk stopped at the cap never reads as a complete chapter list. Without it, a page cut short of the total prints the next `offset`.

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

### 5.10 stats.fm (v2 — implemented)

Second upstream: long-range listening history, cross-range top lists, and taste aggregates from the stats.fm public API (`https://api.stats.fm/api/v1`, no auth). Network-backed stats.fm tools are read-only; the local feedback tools mutate only process memory. They pair with the Spotify write tools above (see `docs/cookbook.md` recipe 1 and `docs/taste.md`). Setup, ranges, limits, and privacy: `docs/statsfm.md`.

Three registration keys are default ON: `statsfm` (endpoint tools in `src/tools/statsfm.ts` over `src/lib/statsfm-client.ts`), `taste` (canonical taste-intelligence tools in `src/tools/statsfm_taste.ts`), and `tastecomposites` (composite tools in `src/tools/taste_composites.ts`). Structured failures use `{kind, reason, fix, text, status?, retryAfterSec?}`: stats.fm 401 maps to `auth`, 403 to `forbidden`, 404 to `not_found` with a bounded `statsfm_resource_not_found` reason, 429 to `rate_limited` with `retryAfterSec`, and 503 to `unavailable`. No `PRIVATE_PROFILE` code is emitted.

#### Endpoint tools (`statsfm_*`)

`statsfm_resolve_user` — customId/display name → canonical userId (always call first). `statsfm_top_tracks` / `statsfm_top_artists` / `statsfm_top_albums` / `statsfm_top_genres` — ranked lists for `range` = lifetime|weeks|months (lowercase only), paged `limit` ≤ 100 + `offset`. `statsfm_top_tracks_from_artist` / `statsfm_top_albums_from_artist` / `statsfm_top_tracks_from_album` — scoped tops. `statsfm_recent_streams` — newest-first (API returns a fixed 50, `limit` ignored upstream). `statsfm_now_playing` — live track + device, null when idle. `statsfm_track_stats` / `statsfm_artist_stats` / `statsfm_album_stats` (+ `*_date_stats` per-day variants) — lifetime obsession scores for one entity, Spotify-ID ↔ stats.fm-ID mapped via `externalIds.spotify[]`. `statsfm_streams_stats` — totals + percentiles + cardinality (singular object, not an array). `statsfm_search` — users/tracks/artists/albums. `statsfm_recaps` — weekly/monthly/seasonal/yearly/artist/time-capsule digests. `statsfm_catalog_track` / `statsfm_catalog_artist` / `statsfm_catalog_album` — catalog lookup. `statsfm_genre_artists` — genre drill-down (`genre.tag`, not `.name`). `statsfm_charts_tracks` / `statsfm_charts_artists` / `statsfm_charts_albums` / `statsfm_charts_users` — honest compositions over verified user endpoints (the public API exposes no global charts endpoint). `statsfm_friends` / `statsfm_friend_count` / `statsfm_records_artists` — social + records.

#### Taste-intelligence tools (`statsfm_*` canonical names; `taste`/`tastecomposites` keys)

Canonical tools are `statsfm_taste_profile`, `statsfm_artist_affinity`, `statsfm_exposure_check`, `statsfm_listening_eras`, `statsfm_listening_sessions`, `statsfm_forgotten_favorites`, `statsfm_taste_recommendations`, and `statsfm_record_feedback`. The corresponding `taste_profile`, `artist_affinity`, `exposure_check`, `listening_eras`, `listening_sessions`, `forgotten_favorites`, `taste_recommendations`, and `record_feedback` names are legacy aliases. `statsfm_record_feedback`/`record_feedback` store local-only in-memory verdicts (love/like/mixed/boring/dislike) and never touch the network.

### 5.11 Mutation receipts (`verify_receipt`, `undo_mutation`, `undo_last_mutation`)

A mutation that can be reverted issues a receipt; the three receipt tools below are the undo surface and none of them touch Spotify until a human approves the rollback. `verify_receipt` is the only read-only one, and since #688 it registers **unconditionally** — outside `SPOTIFY_MCP_TOOLSETS` trimming and the scope filter — so a session trimmed to a single toolset can still look up a receipt its own mutation issued. It reads an in-process `Map`, so it requires no Spotify scope.

**`verify_receipt`** takes `receipt_id`, validated against `rcpt_<bootId>-<n>` (the bare `rcpt_<n>` form a pre-#587 `receipts.jsonl` can still hold is also accepted). A malformed id fails schema validation with a message naming the expected shape, rather than reading as "unknown receipt" — an id only ever comes from a mutation result, so a malformed one is a mistyped call, not a missing receipt.

Both outcomes carry `structuredContent.found`, so a caller branches on one field instead of parsing prose:

| Outcome | `isError` | `structuredContent` |
|---|---|---|
| Found | absent | `{ found: true, ...receipt }` — the receipt's own fields stay flattened (`verified`, `missing`, `expect_present`, `before`/`after`, `writes`, …) so hosts already reading them are unaffected |
| Unknown or expired | `true` | `{ found: false, receipt_id, reason: 'unknown', receipts_kept: 100 }` |

The miss is an error because it is a failed **lookup**. Reporting it as a plain result lets an agent that branches on `result.isError` — and a host that renders green on success — read it as "the write was checked and is fine", when in fact the store simply no longer holds the id.

**Scope of the store.** The store keeps the 100 most recent mutations, in memory only unless `SPOTIFY_MCP_RECEIPTS` is set, and ids are boot-scoped so an id from an earlier process can never resolve to a *different* mutation — it resolves to nothing. A miss therefore says nothing about whether the mutation landed; only a found receipt does. See `docs/configuration.md` for the persistence flags and TTL.
### 5.12 Discovery and registry introspection

Three pure-introspection tools register outside toolset trimming (`alwaysActive`, catalog scope key) so they survive a minimal toolset — the escape hatch for a 592-tool surface. They call no Spotify endpoint. `response_format` on these three differs from the shared contract above, because "json = raw API object" is the wrong promise for a tool that never calls the API:

| `response_format` | `find_tool` / `inspect_tool` / `toolset_report` emit |
|---|---|
| `concise` (default) | the prose bullet list / the tool's description and pretty-printed schema / the active toolsets, per-module schema budget and batch caps |
| `detailed` | the same prose — these payloads are already complete in prose, so the switch is a parse contract, not a detail level |
| `json` | `JSON.stringify(payload, null, 2)` of exactly the `structuredContent` that rides alongside it |

All three emit through one helper, `shapeDiscoveryResult` in `src/shaping.ts`, so the modes cannot drift per tool. `find_tool` and `inspect_tool` advertised `response_format` without reading it before #713; `toolset_report` did not declare it at all.

#### `find_tool`
**Inputs:** `query` (string, required, ≥2 chars — case-insensitive substring matched against tool names and descriptions), `response_format` (see the table above), `limit` (number, optional, 1–100, default 25 — bounds the match list in every mode).

**Returns:** `structuredContent` carries `query`, `total_registered`, `matched`, and `tools` (an array of `{name, description}`); `response_format=json` returns that object as parseable JSON text. A registry the SDK will not expose is reported as `error: 'registry_unavailable'`, never as an empty surface.

#### `inspect_tool`
**Inputs:** `tool_name` (string, required — exact registered name), `response_format` (see the table above).

**Returns:** `structuredContent` carries `found`, and on a hit `name`, `description`, and `input_schema` (the tool's JSON Schema). `response_format=json` returns the input schema as parseable JSON text, so an agent can build a valid follow-up call without reading prose. A miss returns `found: false` plus close matches in the prose.

#### `toolset_report`
**Inputs:** `response_format` (see the table above).

**Returns:** `structuredContent` carries `registered_tools`, `active_toolsets`, `active_modules`, `read_only`, `toolsets`, `module_schema_budgets` (the per-module measurements from `src/tools/annotations.ts`), `registration_exclusions`, and `batch_caps` (the resolved `CHUNK_CAPS` table).


## 6. Resources

MCP Resources expose read-only data as URIs Claude can reference. Fixed resources and template inventories are generated from the live registry:

<!-- BEGIN:generated resource-surface -->
The finalized default registry contains **16 fixed resources** and **33 resource templates**. Fixed URIs: `spotify://me`, `spotify://me/followed/artists`, `spotify://me/genre-heatmap`, `spotify://me/listening-history`, `spotify://me/playlists`, `spotify://me/rate-limit`, `spotify://me/recently-played`, `spotify://me/saved/albums`, `spotify://me/saved/audiobooks`, `spotify://me/saved/episodes`, `spotify://me/saved/shows`, `spotify://me/saved/tracks`, `spotify://me/top/artists`, `spotify://me/top/tracks`, `spotify://player/queue`, `spotify://player/state`. Template URIs: `spotify://album/{id}`, `spotify://album/{id}{+qs}`, `spotify://artist/{id}`, `spotify://artist/{id}/albums`, `spotify://artist/{id}/albums{+qs}`, `spotify://artist/{id}{+qs}`, `spotify://episode/{id}`, `spotify://episode/{id}{+qs}`, `spotify://me/followed/artists{?format}`, `spotify://me/genre-heatmap{?format}`, `spotify://me/listening-history{?format}`, `spotify://me/playlists{?format}`, `spotify://me/rate-limit{?format}`, `spotify://me/recently-played{?format}`, `spotify://me/saved/albums{?format}`, `spotify://me/saved/audiobooks{?format}`, `spotify://me/saved/episodes{?format}`, `spotify://me/saved/shows{?format}`, `spotify://me/saved/tracks{+qs}`, `spotify://me/saved/tracks{?format,offset,limit}`, `spotify://me/top/artists{?format}`, `spotify://me/top/tracks{?format}`, `spotify://me{?format}`, `spotify://player/queue{?format}`, `spotify://player/state{?format}`, `spotify://playlist/{id}`, `spotify://playlist/{id}/tracks`, `spotify://playlist/{id}/tracks{+qs}`, `spotify://playlist/{id}{+qs}`, `spotify://show/{id}`, `spotify://show/{id}{+qs}`, `spotify://track/{id}`, `spotify://track/{id}{+qs}`.
<!-- END:generated resource-surface -->


---

## 7. Prompts

Pre-built prompt templates exposed via MCP for common use cases:

<!-- BEGIN:generated prompt-surface -->
The finalized default registry exposes **14 prompts**: `artist_deep_dive`, `crate_digging`, `discover_weekly_alternative`, `dj`, `listening_recap`, `migrate_library`, `morning_briefing`, `music_briefing`, `music_taste_summary`, `playlist_audit`, `playlist_from_mood`, `podcast_catchup`, `triage_liked_songs`, `weekly_digest`.
<!-- END:generated prompt-surface -->

---

## 8. Error Handling

### Spotify API errors → MCP tool errors

| HTTP Status | Cause | MCP response |
|---|---|---|
| 401 Unauthorized | Token expired | Auto-refresh and retry once; if still 401, return error with setup instructions |
| 403 Forbidden | OAuth scope missing, deprecated endpoint, regional restriction, or a Premium-only control failure | Surface Spotify's own error message when present; otherwise a hint naming the likely cause categories (never a blanket "requires Premium" claim) |
| 404 Not Found | Entity doesn't exist | Return descriptive message |
| 429 Too Many Requests | Rate limit | Respect `Retry-After` header (delta-seconds **or** HTTP-date), retry once after delay |
| 500 Internal Server Error | Spotify's own logic failed | Not retried — return Spotify's error message |
| 502 / 503 / 504 Gateway, Service Unavailable, Gateway Timeout | Spotify or its edge is temporarily down | Retry within a shared attempt budget of 3 dispatches, waiting `Retry-After` when present and otherwise 250 ms·2ⁿ + 0–250 ms jitter; a wait above the 10 s in-queue cap fails fast with the wait named in the error |
| 503 (transport) | DNS failure, connection reset, socket hang-up | Retried only for an idempotent verb (`GET`/`HEAD`/`PUT`/`DELETE`/`OPTIONS`) — never for a `POST`, which may already have been applied. Exhausted, it is a `SpotifyApiError` naming the method, URL and cause, not a raw `TypeError` |
| 408 (client timeout) | Outbound call exceeded `SPOTIFY_REQUEST_TIMEOUT_MS` (default 30 s) | `SpotifyApiError` naming the timed-out method and URL |

### No active device
When playback commands fail because no device is active (204 with no `device_id` found): return a helpful message listing available devices and asking the user to open Spotify on a device first.

---

## 9. Rate Limiting

- All API calls go through a central `SpotifyClient` class with a request queue
- **One shared start gate.** Every launch reserves a start slot on a single gate, so starts stay a minimum 100 ms apart and none begins during a `Retry-After` cooldown. There is no per-caller sleep and no second limiter
- **Bounded concurrency.** At most `SPOTIFY_MCP_MAX_CONCURRENCY` (default 3, clamped to 32) requests are in flight at once; `1` is the strictly serial funnel. This is the process-wide width and the only concurrency knob: it covers requests a single tool fans out as well as one-off reads, because all of them pass through this funnel. A permit is taken before the gate wait and returned on every exit — success, HTTP error, thrown exception and gate rejection alike — so a failing request cannot shrink the pool. A 5xx backoff holds its own permit for at most ~500 ms, which is what keeps the in-task retry backoff from parking the whole funnel
- **Tool-side fan-out width is not a second knob (#783).** A tool that walks many items concurrently still resolves its width *from* `SPOTIFY_MCP_MAX_CONCURRENCY`; it does not introduce an independent default, because two independent defaults bounding the same quantity make the effective width whichever is smaller, chosen by a comparison no operator can see and no payload can honestly report. The narrow per-scan width that a bulk scan uses is a *scheduling* decision the funnel cannot make for itself: the funnel bounds requests in flight but has no notion of a scan that has decided to stop, so it cannot end a walk early once a quota wall answers.
- On 429: the gate parks all callers for `Retry-After` seconds; the throttled call re-queues once behind the same gate rather than sleeping in place, so the wait is paid once for the whole funnel instead of once per throttled caller. `Retry-After` is read in both RFC 9110 forms — delta-seconds and HTTP-date — so a server asking for minutes is honoured rather than retried after the 1 s fallback. A `Retry-After` above the 10 s in-queue cap, a quota-exhaustion body, and a second 429 on the same call all fail fast with the wait attached in `retryAfterSec` rather than blocking. Three consecutive 429s inside 30 s latch a breaker that refuses new work — without sending it — until the window passes; any request that settles without a throttle clears the streak. The throttle event (retry delay, wait time) is recorded on the client
- One shared attempt budget (`MAX_ATTEMPTS = 3`) covers the 401-refresh, the 429 re-queue, the 5xx backoff and transport-error retries, so no combination of them can loop. 5xx backoff is jittered, and a transport failure is retried only for an idempotent verb so a mutation is never silently re-sent
- Throttle visibility: the most recent event is exposed via the `spotify://me/rate-limit` resource, and a "rate-limited by Spotify, waited Ns" notice is appended to the throttled call's result
- Batch operations issue one API call per affected content type (e.g., `save_items` partitions its URIs across `/me/tracks`, `/me/albums`, …) instead of one call per item

---

## 10. Spotify API Constraints

Known limitations to document and handle:

| Constraint | Detail |
|---|---|
| **Premium required** | All playback control: play, pause, skip, seek, volume, shuffle, repeat, queue |
| **No audio** | API provides metadata and control only — no audio streams |
| **Search limit** | Max 10 results per type per `/search` request (schema and runtime cap; default 5). Tools needing deeper results must page with successive offsets. |
| **Queue opacity** | `GET /me/player/queue` returns items but positions are not editable |
| **Registration-gated reads** | The batch lookup wrappers (`GET /tracks?ids=` family) and `GET /artists/{id}/top-tracks` remain registered, but current app registrations can return a generic `403`. The single runtime classification source is `GATED_PATH_PATTERNS` in `src/tools/exhaust2_enggating.ts`; see the README's [Registration-gated endpoints](README.md#registration-gated-endpoints) table for the complete family list, including `/me/{type}/contains`. |
| **Removed fields** | `popularity`, `followers`, `available_markets` no longer returned on tracks, artists, albums |
| **Unified library API** | `save_to_library`/`remove_from_library`/`check_in_library` use `PUT/DELETE/GET /me/library` with **URIs** in any mix (including artist/user/playlist follow state on check). The legacy helpers (`save_items`, `remove_saved_items`, `check_saved_items`) partition URIs across the per-type `/me/{type}s` endpoints. |
| **Playlist items path** | All playlist item operations use `/playlists/{id}/items` (not `/tracks`) as of Feb 2026 |
| **Audiobooks market-gated** | Audiobook endpoints only available in US, UK, Canada, Ireland, New Zealand, Australia |
| **Dev mode limit** | 5 authorized users max until extended quota approval |
| **Token expiry** | Access tokens expire after 1 hour; refresh tokens are long-lived |
| **Redirect URI** | Must use `http://127.0.0.1` for local development — not `http://localhost` |
| **Market sensitivity** | Some tracks/albums are region-restricted; `market` param controls availability filtering |
| **Fetch-all cap** | `fetch_all` pagination (`client.getAllPages`) walks offset pages up to `SPOTIFY_MCP_FETCH_ALL_CAP` items per call (default 500). Cursor-paginated endpoints (followed artists) are not supported by this helper. |
| **Default market** | A market-gated lookup with no `market` argument resolves in this order: the argument, `SPOTIFY_MCP_MARKET`, then the account country when `GET /me` still carries one. The last source is gone — `country` was removed from `GET /me` in Feb 2026 — so on a current registration nothing supplies a default, the request goes out without `market`, and the result reports `market_source: "none"` rather than leaving the fact unstated. `market` codes are validated against a bundled ISO 3166-1 alpha-2 list, so validation needs no `GET /markets` round-trip. The show/episode walks — `show_new_episodes`, `plan_podcast_session` and `start_podcast_session` with `kind: "shows"` or `saved_only: false` — resolve the same way and report the pair a resolved market always reports, `market: "GB" | null, market_source: "none" | "argument" | "config" | "account"`. A saved-episodes-only session reads no market-gated endpoint, so it reports neither field rather than claiming a scoping no request carried. |

---

## 11. Project Structure

```
spotify-mcp/
├── src/
│   ├── index.ts              # MCP server entry point (stdio transport)
│   ├── auth.ts               # OAuth PKCE flow, token storage, refresh logic
│   ├── client.ts             # SpotifyClient — request funnel (shared start gate + bounded concurrency), fetch timeouts, TTL cache, getAllPages
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
│   │   ├── catalog.ts        # get_me, get_track, get_several_tracks, get_artist, get_artist_top_tracks, get_artist_albums, get_several_artists, get_album, get_album_tracks, get_several_albums, get_show, get_several_shows, get_episode, get_several_episodes, get_available_markets, get_several_audiobooks, get_several_chapters
│   │   ├── doctortool.ts     # spotify_doctor
│   │   ├── episodemgmt.ts    # archive_played_episodes
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
│   │   ├── playlists.ts      # clean_all_playlists, remove_duplicate_playlist_items, get_user_playlists, get_playlist, get_playlist_items, create_playlist, add_to_playlist, remove_from_playlist, update_playlist, reorder_playlist_items, replace_playlist_items, find_duplicates_in_playlist, get_playlist_cover, upload_playlist_cover
│   │   ├── podcastsession.ts # plan_podcast_session, start_podcast_session
│   │   ├── portability.ts    # save_discover_weekly, save_release_radar, export_library_json, export_followed_artists
│   │   ├── queueops.ts       # queue_playlist, save_queue_as_playlist, batch_add_to_queue
│   │   ├── restore.ts        # restore_library_snapshot
│   │   ├── saveddedupe.ts    # find_duplicate_saved_tracks
│   │   ├── scenes.ts         # save_scene, list_scenes, delete_scene, apply_scene, schedule_wind_down, cancel_wind_down
│   │   ├── searchdive.ts     # search_deep
│   │   ├── searchhistory.ts  # search_history, search_rerun
│   │   ├── search.ts         # search
│   │   ├── showradar.ts      # show_new_episodes
│   │   ├── smart.ts          # create_smart_playlist
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

## 12. Configuration

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

## 13. Claude Desktop Integration

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
| **Phase 11** | v1.19–1.21 wave: `import_playlist` (M3U/CSV), `remove_duplicate_playlist_items` + `clean_all_playlists`, `create_smart_playlist`, `show_new_episodes`, backup/restore, bug trio (#195/#196/#210) |
| **Phase 12** | **v1.22.0 big-release (2026-08-26): catalog/browse and artist-watch, library analytics, playlist health/batch/misc/portability, and playback/queue/search/episode tools — wired centrally with a smoke `FORBIDDEN_TOOLS` guard** |
| **Phase 13** | **v1.23.0 exhaust-remnants (2026-08-26): typed search, category helpers, catalog batch/validate, library insights, playlist operations, and freshness/scene/market tools** |
| **Phase 14** | **v1.24.0 exhaust2 swarm (2026-08-27): graceful-403 gating, playback/device/session, portability/analytics/workflow, playlist set-algebra/curation, and catalog typed-search depth** |
| **Phase 15** | **v1.26.0 swarm3 push (2026-08-28): playback, playlist operations, discovery, library, podcast/session, listening analytics, Spotify reference, local snapshot, and registry-introspection tools — live gauntlet and `tools/list` verified** |
