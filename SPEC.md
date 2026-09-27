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

What v2 will deliberately not do. Each line is a decision carrying a one-line
rationale; the evidence, the alternative offered in its place, and the source
each rests on are in **[docs/non-goals.md](docs/non-goals.md)**, which is the
maintained record. That page also names the scope questions still open in other
issues, so the absence of a line here is not read as a decision either way.

- **Audio streaming, audio analysis, and offline playback** — the Web API serves metadata rather than audio, and the analysis endpoints belong to a class this project ships no wrapper for at all.
- **A web UI, a dashboard, or an MCP UI surface** — the server is a local stdio process; `spotify_doctor`, the MCP resources and each tool's structured result cover what a page would show.
- **Multi-tenant or hosted operation** — one process serves one user's credentials, and the loopback-only OAuth callback cannot complete a hosted login.
- **Sharing one user's credentials across users** — no token pooling and no caller-supplied credentials; a process holding several people's tokens could not say whose library a call touched.
- **Lyrics** — the public API has no lyrics endpoint, so `lyric_snippet_search` matches a remembered phrase against track metadata instead.
- **The Spotify Connect SDK and native client integration** — the Web API is the only surface spoken; `get_devices`, `switch_device` and `transfer_playback` are the device control it does expose.
- **Voice control** — capturing audio is a different product with a different consent surface; a host's own voice layer can call this server with ordinary text.
- **Training a model on Spotify data, or exporting derived profiles** — prohibited by Spotify's Developer Terms, and already restated in this repository's [End User Agreement](END_USER_AGREEMENT.md) and [Privacy Notice](PRIVACY.md).
- **A second third-party upstream, ad-tech, or monetization egress** — stats.fm is the only non-Spotify API called, and a new recipient is a disclosure change before it is a code change.
- **Working around Spotify's own controls** — no stream ripping and no quota, regional or access-control circumvention; a registration-gated endpoint explains its 403 rather than being routed around.

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
    "check:tests-typecheck": "node scripts/check-tests-typecheck.mjs",
    "sweep": "node scripts/live-gauntlet.mjs --batch=40 --resume=memory/live-sweep-report.json --report=memory/live-sweep-report.json",
    "sweep:loop": "bash scripts/sweep-loop.sh",
    "probe:edge": "node scripts/edge-probe.mjs",
    "probe:contains": "node scripts/contains-check.mjs"
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

Steps 2–4 are bounded by `SPOTIFY_AUTH_TIMEOUT_MS` (default `300000`). On expiry the listener is closed, the port released, and the failure names the redirect, the port and the elapsed bound. A listener that could not bind fails earlier and differently: the message names `EADDRINUSE`, the port, and the default redirect, because the common cause is a previous auth run that is still holding the port.

### OAuth scope profiles

The scopes `auth` asks for are chosen by a **profile**, not written out ad hoc. `SPOTIFY_MCP_SCOPE_PROFILE` (or `auth --scope-profile <name>`) selects one; an explicit `SPOTIFY_SCOPES` / `auth --scopes` list overrides it, and may itself name a profile (`--scopes full`). The default is **`core`**.

| Profile | Scopes | What it unlocks |
| --- | --- | --- |
| `read` | 10 read scopes | Browsing only. Nothing in it can change Spotify state. |
| **`core`** (default) | `read` + `user-modify-playback-state` | The above plus playback control. |
| `write` | `core` + `user-library-modify`, `playlist-modify-public`, `playlist-modify-private`, `user-follow-modify`, `ugc-image-upload` | The full write tool surface. |
| `full` | `write` + `user-read-email` | The maximal 17-scope grant this server shipped before #700. |

Default `core` requests these 11 scopes:

```
user-read-private
user-read-playback-state
user-read-currently-playing
user-read-recently-played
user-read-playback-position
user-top-read
user-library-read
user-follow-read
playlist-read-private
playlist-read-collaborative
user-modify-playback-state
```

Before #700 an unconfigured `auth` run requested all 17, so a user who only wanted read-only browsing consented to library, playlist, follow and cover-upload writes, and to disclosing the account email. That is the "request only the minimum, never preemptively" rule (AGENTS.md §1, Spotify Developer Terms Sec. V.3) stated but never enforced. `auth` now prints the requested scopes grouped with a one-line rationale **before** it opens the browser, and marks every non-read group, so a group can still be declined at the point where declining is free.

**What a profile does and does not promise.** A profile decides what the consent screen *asks for*. What a granted token can then *see* is decided separately, per manifest ROW, by the scope gate (`scopeKey` / `WRITE_SCOPE_REQUIREMENTS` in `src/scopefilter.ts`). The unit is the row, not the tool — see #1005, #1009, #1017. So no profile here claims "this one tool needs exactly this one scope": that is not expressible in this architecture, and a profile implying it would be the same defect #1005 shipped. A row whose `readOnlySafe` flag is set is never scope-filtered, because `WRITE_SCOPE_REQUIREMENTS` is a table of *write* requirements and such a row has no writes to withhold.

A grant that lacks a write scope therefore does not 403 on those tools — the row registers with its write half removed, so the caller gets an unknown-tool error rather than a tool that fails at the API. `spotify_doctor` reports the profile a token matches and the granted-vs-required scopes per module, including the modules the grant is withholding.

> Note: `streaming` and `app-remote-control` are in **no** profile — both are for the browser Web Playback SDK and the WebSocket control API respectively, neither of which the Web API wrapper uses. They remain accepted by `SPOTIFY_SCOPES` / `--scopes`.
> Note: `ugc-image-upload` is needed by `upload_playlist_cover` but is **not** in the default profile; it requires the `write` profile or above, and Spotify additionally requires enabling it on the developer-dashboard app — otherwise uploads fail with 403.
> Note: `user-read-email` is in the `full` profile only. **No shipped tool reads it**; it was in the standing grant for a capability this server never calls.

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
SPOTIFY_AUTH_TIMEOUT_MS — optional; bounds the browser callback wait (default 300000)
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
  // Print the resolved configuration, then the shared diagnostic report;
  // exit non-zero when the report is not ok (#62, #581)
  await runDoctor();
} else {
  // Start MCP server over stdio (the default)
  await startMcpServer();
}
```

#### The doctor is one report, rendered twice (#581)

`spotify-mcp doctor` and the `spotify_doctor` tool are two entry points onto
`collectDoctorReport()` in `src/tools/doctortool.ts`, rendered by
`renderDoctorProse()`. The CLI subcommand does **not** re-implement the checks:
for one config and one token file, both surfaces emit the same row ids, the
same statuses and the same text. That is the whole point — before #581 the CLI
re-derived token state and the `/me` probe inline in `src/index.ts`, so it
could not show a scope gap, the mutation-history trail, the read-cache
pressure or a rate-limit cooldown, and nothing stopped a new check from landing
in only one of the two.

What the CLI adds on top is a **Configuration block**: a dump of resolved
config keys (`token file`, `profile`, `redirect URI`, `headless`, `max items`,
`fetch-all cap`, `mutation history`, `readonly`, `market`, `scopes`). It is a
dump, not a check — it has no pass/fail verdict and nothing in the tool's report
contradicts it, because the checks are the rows. Three of its lines are
deliberately CLI-only today (`redirect URI`, `headless`, and the `scopes`
override rendering): the auth-time configuration a user is about to run
`spotify-mcp auth` against, which the tool's own rows do not need to restate.

The CLI exits `0` when `report.ok` and `1` otherwise — the shared report's
verdict, not a second judgment. This changed two exit codes the old inline
implementation produced: a probe that could not reach Spotify, and one that was
rate-limited (`429`), used to exit `1` and now exit `0`, because the shared
report classifies both as `info`/`warn` rather than failures. A rejected token
(`401`/`403`) and any other HTTP error still exit `1`.

Three rows **cannot** be byte-identical between the surfaces, and
`PROCESS_LOCAL_DOCTOR_ROW_IDS` in `src/tools/doctortool.ts` names them so the
difference is stated rather than discovered. Each describes the process doing
the reporting, not the deployment:

| Row | Why it differs |
|---|---|
| `surface` | The registered-tool **count**. The tool counts the live registry it runs inside; the CLI is a separate process with no registry, and says `registered_tools=not-observable` rather than reporting a zero that would read as "this deployment registers nothing". Every other field on that row — `active_modules`, `exposed_modules`, `hidden_by_trim`/`_scopes`/`_readonly`, `active_sets`, `inactive_sets`, the override lists, `read_only` — is env-derived and **is** identical. |
| `rate_limit` | Cumulative and rolling-window request counters, which count the requests the reporting process has made since it started. |
| `cache` | The read cache's entry/byte counters, which measure a cache that only exists inside a running server. The CLI's probe client is built with `disableCache: true`, so it reports `read cache disabled on this reporting path` — the client's `cacheStats()` reserves an absent set of cache fields for "the cache is off" precisely so a caller can tell that from "the cache is empty". |

A fourth pair of rows, `account` / `account_probe` / `account_premium`, depends
on what live `/me` call the reporting process could make, so their text is the
API's answer rather than a local fact.

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

**Local sidecar corruption (#839).** The JSON sidecars under `~/.spotify-mcp` are user data. A file that
exists but cannot be turned back into a store — an unreadable path, invalid JSON, or a well-formed
document of the wrong shape — is never reported as an empty store. The shared policy lives in
`src/sidecar.ts` and applies to every sidecar loader: the original file is left byte-for-byte alone, its
bytes are copied to `<file>.corrupt` (or `<file>.corrupt.N`, so a second corruption cannot clobber the
first preserved copy), and a `SidecarUnreadableError` naming the file, the actual parse or read failure,
and the preserved path is raised. A *missing* file is not corruption — it is a first run, and it yields
the empty store with no warning.

The **write path refuses.** A writer loads the existing store before writing, so a store that cannot be
read makes the write unreachable and the user's bytes stay where they are. Overwriting would discard the
data the preserved copy is the only evidence of, at the path every other tool reads; "append" has no
meaning for a file that is not valid JSON to append to. The refusal is reported, not swallowed:
`search_history`, `search_rerun` and `search_history_stats` answer `ok: false` with `error:
"load_error"`, `load_error` and `preserved_as`, and report `count`/`total` as `null` rather than `0`,
because zero is a real answer — it is what a first run and an all-expired store return — and reporting
it for a store that could not be read is a measurement the file does not support. Searches recorded
while the store was unreadable are dropped, counted, and disclosed as `refused_writes` on the first read
after the file is repaired; that gap is the one part of the failure the preserved copy cannot recover.

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
- **Token memory management**: The `SpotifyClient` holds the token state in memory (not read from disk on every request). On initialization it reads the resolved token file (`~/.spotify-mcp/tokens.json` unless `SPOTIFY_MCP_TOKEN_FILE` / `--profile` / `SPOTIFY_MCP_PROFILE` name another — #609). On successful refresh it updates its in-memory state AND writes back to disk. This ensures the long-running MCP server process doesn't repeatedly hit disk.
- **Acting-account switch (#602)**: `switchAccount(tokenFile)` re-points the client at another account for every subsequent call, and it is a four-part operation, not a string assignment. (1) `tokenFile` is re-pointed, and `loadTokens`/`saveTokens` take that path as an ARGUMENT precisely so they cannot re-resolve it from the environment and land back on the startup account. (2) `tokens`/`loadPromise` are cleared — the memoized access token of the previous account would otherwise be sent as the new account's credential, producing a 401 that reads as bad credentials rather than as a switch. (3) The in-memory read cache is replaced with a fresh, EMPTY one, because its key is method + path + params with **no account component**: a surviving entry is a `/me`- or library-scoped response handed to the account that did not fetch it. (4) The ETag validator store is replaced for the same reason with a sharper edge — a conditional read presents an ETag and a 304 answers from the stored payload, so a surviving validator produces "not modified" carrying the PREVIOUS account's bytes, with no request in which to notice. The persist controller is rebuilt against the new account's cache file and the old one is flushed first; that path is resolved from the client's own `tokenFile` rather than re-resolved from the environment, which after a switch would still name the account the process started as. A switch must not race live requests — one already past the token check would finish against the new account and write its response into the new account's cache — so `switch_account` calls `drainPendingRequests()` first, which waits on the scheduler's own change notification and **fails after 5 s rather than hanging**.
- **Request timeouts**: every outbound HTTP call (API requests and token refresh) carries an `AbortSignal.timeout` — 30 s by default, overridable via `SPOTIFY_REQUEST_TIMEOUT_MS`. Expiry raises a 408-style `SpotifyApiError`, which returns the task's permit like any other failure, so a hung connection can never shrink the pool or stall the funnel.
- **Read cache**: immutable catalog reads go through an LRU TTL cache (~5-minute entry lifetime, 200 entries max); mutations and player calls bypass it. Since #894 the cache is bounded **by bytes** as well as by count (8 MB total, 1 MB per entry, both configurable): a count bound is not a memory bound when a single 100-track playlist page is ~150 KB, and an entry too large to fit the budget is refused rather than admitted and immediately evicted — refusals are counted, never absorbed, because a cache that silently stopped caching is worse than one that says so. Each entry is charged the exact UTF-8 length of the body it arrived as, so eviction is by least-recently-used until the byte total is back under the ceiling. Cache keys are canonical over method + path + params, with pairs sorted by name then value: `{limit, offset}` and `{offset, limit}` are one entry and one network read, while any real difference (a limit, an offset, an added param, a different path) keeps its own entry. `getRateLimitStatus()` exposes `cacheEntries` / `cacheBytes` / `cacheMaxBytes` / `cacheSkippedOversize`, and `spotify_doctor` reports them as the `cache` row. Those fields are absent when the cache is off — `cacheStats()` returns an empty object rather than zeros so a caller can report "no cache" instead of "cache is empty", and the `cache` row reports exactly that distinction (see [The doctor is one report, rendered twice](#the-doctor-is-one-report-rendered-twice-581)).
- **Scoped cache invalidation (#893)**: a mutation drops only the reads it could have made stale, instead of clearing the whole cache. `POST|PUT|DELETE /playlists/{id}/...` drops that playlist's own reads and the user's playlist list; other `/me/*` writes (library saves, follows) drop the `/me/` read family; `/me/player/*` and `/me/top/*` writes drop **no payload** — those paths are never cached — while still dropping their **volatile ETag validators**, which are. Both halves matter and they are not the same claim: a 304 on a stale validator returns a pre-mutation body, so dropping only the payload would leave the validator to resurrect it. Which is what stops an unrelated `add_to_queue` from costing an agent its whole cached walk. Any write endpoint the policy does not recognise falls back to a full clear rather than to a guess, because an entry that cannot be invalidated serves stale data as if it were fresh. Prefix matching is boundary-aware: keys are `GET <path> <params>`, so `/playlists/A` never matches `/playlists/AB`.
- **Reads that race a write are not cached (#893)**: the request funnel runs several requests at once, so a read issued *before* a write can complete *after* it. Its body describes the pre-write world, and storing it would re-seed the entry the write just invalidated — a stale value then served for the full TTL while looking fresh. A monotonic invalidation epoch is captured before the request and re-checked before the result is written into the cache or the ETag validator store; on a mismatch the result is returned to its caller (a truthful answer to the read it made) but not stored. This closes a window that the previous wholesale `clear()` did not close either. The check is **scoped, not global**: each mutation records the prefixes it dropped into a bounded log (last 64 events) and the check asks only whether *this key* was among them. A global epoch comparison would also discard the results of reads the mutation could not possibly have staled — the old behaviour's cost, paid on every unrelated write. When the log no longer reaches back far enough to answer, the check **fails closed** (assumes invalidated) rather than returning a clean bill of health on the strength of a log it can no longer see.
- **Optional cache persistence (#893)**: `SPOTIFY_MCP_CACHE_PERSIST=1` also writes the cache to disk (owner-only 0600, atomic temp-then-rename, size-capped) so a host that restarts the server per session does not re-walk the same catalog. The file is named after the same profile as the token file — `cache.json`, or `cache.<profile>.json` — and resolved through the *same* profile-resolution call the token path uses, so two profiles can never share one cache and the two paths cannot drift apart. Only **resource identities** are written — tracks, albums, artists, shows, episodes, audiobooks, genres, and the public `/users/{id}` profile — under an **allowlist, not a denylist**, so a newly added `/me/*` read is excluded by default. The allowlist is keyed on the path *shape and its depth*, not on the root: `/users/u1` is a public profile and is persisted, while `/users/u1/top/artists` and the stats.fm listening data under the same shape are not, because a root-only check admitted them. `/me/*` keys and playlists are never persisted: a second process would serve them without having seen the mutation that changed them. Each entry keeps the expiry it had in memory and is re-checked on load, so persisting never extends an entry's life. Each entry is serialized **once**, and the byte cap is applied arithmetically as entries are admitted — an entry too large for the remaining budget is skipped, not truncated, and the later ones still fit. The alternative (re-serializing the growing document per entry, `break`ing at the cap) is quadratic in both time and allocation. `getRateLimitStatus()` reports `cachePersist` / `cacheRestored` / `cachePersistFailed` / `cachePersistRefused` / `cachePersistOversize`, and `spotify_doctor` folds them into the `cache` row, with a failed write surfacing as a warning and a dropped entry counted — a persisted cache that is silently not working looks exactly like one that is. A pending save is flushed on `exit` (including `process.exit()` and an uncaught throw, whose listeners run synchronously) and on `SIGINT`/`SIGTERM`/`SIGHUP`/`SIGQUIT`, each of which re-raises so the process still dies of the signal. A termination that runs no JavaScript — `SIGKILL`, an OOM-kill, a supervisor hard-stop, a power loss — cannot be flushed and is not claimed to be: instead, a `cache.json.pending` marker armed before the debounce timer and cleared when the write resolves lets the NEXT process report `cachePersistLost` (surfaced by `spotify_doctor` as `cache_persist_lost`) and warn. That marker is a count and a PID, never a payload: it reports a loss, it does not repair one, and a marker whose owner is still alive is neither reported nor removed. `docs/configuration.md` § When a pending save is lost states the boundary in full.
- **Rate-limit visibility**: the most recent 429 (`Retry-After` seconds, wait time, timestamp) is retained on the client, exposed via the `spotify://me/rate-limit` resource, and appended as a notice to the throttled call's result.
- **One canonical artist-release probe (#900)**: five tools want the same read — the newest release of one artist — and each used to spell its own request (`limit` 5 in three call sites in the swarm3 discovery module, `limit` 10 with no `include_groups` in `whats_new`), so the read cache above could never share an entry. All of them now go through `probeArtistReleases()` in `src/artistreleases.ts`, which issues exactly one request shape — `GET /artists/{id}/albums?include_groups=album,single&limit=10`, the live endpoint read at the schema's documented `limit` maximum. That maximum is the shared `ARTIST_ALBUM_PAGE_LIMIT` (`tools/catalog.ts`), the same constant every other `/artists/{id}/albums` read derives from after #1209; the helper aliases it rather than restating it, and `tests/artist-albums-limit-guard.test.ts` scans all of `src/` so a literal above the cap cannot reappear at any call site. The helper trims to fewer rows in memory for callers that want them. A caller's `rows` option never reaches the wire, because a different `limit` is a different cache key. The artist id is in the path, so one artist's entry can never answer another's probe. `whats_new` (`lookups.artist_probes` / `artist_probe_cache_hits` / `artist_probe_requests`), `artistwatch_new_additions`, `new_music_from_top_artists`, `discovery_digest` and `artist_name_disambiguator` (`artist_probes` / `artist_probe_cache_hits` / `artist_probe_requests` at the top level) all disclose the split, and the four discovery tools repeat it in prose: probes asked for, requests actually issued, and hits served from the cache. `fromCache` is read out of the cache before the request, so a miss is never reported as a hit and a hit is never reported as a miss.
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

  // #602 — the acting-account switch. `drainPendingRequests` must be awaited
  // first; it rejects rather than switching under a request in flight.
  readonly tokenFile: string
  async switchAccount(tokenFile: string): Promise<void>
  async drainPendingRequests(timeoutMs?: number): Promise<void>
  async flushCachePersist(): Promise<void>
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
> publishes the path, flagged `deprecated: true`, and documents a `403` among its
> responses; Spotify's February 2026 Web API changelog lists the same path as
> `[REMOVED]` with **no replacement named**. What is observable is therefore
> registration-dependent rather than artist-dependent: a registration without the
> grant answers 403 or 404/410, and the answer is identical for every artist in a
> fan-out. Every tool that calls it routes the answer through the shared contract
> in `src/gating.ts` (`isGatedError` / `isRemovedEndpointFailure` /
> `graceful403Message`), which annotates and rethrows the original
> `SpotifyApiError`; none of them substitutes a fabricated `0%` or `0` tracks for a
> read that did not happen. What they do with a gated or removed answer differs by
> what the tool can still do without it, so this list is not a single shared
> behaviour:
>
> - `get_artist_top_tracks` (#901) — the tool *is* the read; a 403 becomes an
>   explanatory error and there is nothing to fall back to.
> - `artist_collab_network`, `artist_completeness_score` (#901) — probe once and
>   fail fast on the first gated or removed answer, because the answer is a
>   property of the registration and repeating it per artist changes nothing.
> - `batch_add_to_playlist` (#867) — records the artist source under `failed`
>   with reason `gated` / `not_found` and keeps the rest of the batch.
> - `queue_playlist` (#1225) — falls back to the artist's most recent albums,
>   which sit in the module already, and discloses it: `resolved_via: "albums"`
>   plus a `note` naming the failed read.
>
> **`?ids=` batch-route status (#1224).** The February 2026 changelog marks the
> multi-id collection reads (`/tracks`, `/albums`, `/artists`, `/episodes`,
> `/shows`, `/audiobooks`, `/chapters`, each with `?ids=`) `[REMOVED]`; the live
> OpenAPI schema still publishes them, flagged `deprecated: true`. As with
> top-tracks, the observable behaviour is registration-dependent — a registration
> without the grant answers 403 — and unlike top-tracks there is a named
> replacement: the per-id read (`GET /albums/{id}`), which is not gated. Every
> server-side caller of a batch route has been migrated to it: `fetchCatalogPerId`
> in `src/tools/catalog.ts` de-dupes the id list, fans out at a fixed width
> (`PER_ID_FANOUT_WIDTH`, 5), settles every id independently, and returns
> `{ byId, unresolved, throttled, requests }`. An id whose read fails is **named**
> in `unresolved` with its status and reason and is absent from `byId` — never
> silently dropped, and never recorded as a found-nothing, which is the #803
> failure. `requested == resolved + unresolved.length` therefore continues to
> hold, in the same request order as before. The `get_several_*` family
> (§5.3) keeps the batch route deliberately: it is a user-facing lookup whose
> whole contract is "one call per chunk", and it already degrades through the
> shared 403 wrapper in `src/gating.ts` rather than hard-failing.
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
| `check_following_artists` | GET | `/me/library/contains?uris=spotify:artist:…` — one URI per artist, same order as the input |

### 4.0.5 Matching vocabulary: duplicates and artist credits (#885)

Sibling playlist tools that agents treat as interchangeable used to apply
different rules, so one playlist produced a different duplicate count per tool
and a different artist count per tool, with nothing in the payload saying which
rule produced it. The vocabulary below is defined once, in
`src/playlistmatch.ts`, and every tool that reports or collapses duplicates or
matches a track against an artist goes through it. There is no per-tool
alternative.

**`match_by` — when two playlist items are the same.** One parameter, declared
once, accepted by all five duplicate tools: `playlist_health_check`,
`find_duplicates_in_playlist`, `playlist_dedupe_advanced`,
`remove_duplicate_playlist_items`, `clean_all_playlists`.

| `match_by` | Rule | Catches |
|---|---|---|
| `uri` (default) | exact URI | the same track object added twice |
| `name_artist` | case-insensitive name + the full set of credited artist names | a relink or remaster published under a new URI |
| `name` | case-insensitive name only | the widest rule; two different songs sharing a title collapse into one group |

Two consequences are deliberate. `name_artist` **sorts** the artist names before
comparing, so `"A feat. B"` and `"B feat. A"` do not split one song into two
groups. And a row with no URI — an unavailable or local item — is never grouped
or collapsed against anything, because grouping it under an empty key would
report every unavailable row as a duplicate of every other one.

Every duplicate tool echoes the rule it applied as `match_by` in both
`structuredContent` and the prose, including when it found nothing. A zero is a
statement about a named rule; a zero with no rule named is indistinguishable
from a matcher that matched nothing.

`remove_duplicate_playlist_items` and `clean_all_playlists` also accept the
retired `include_relinked` boolean for one release. `true` maps to
`name_artist` and `false` to `uri` — the only two rules it could express. A call
carrying both inputs where they mean different rules is refused by name rather
than silently resolved, and a call that used the boolean carries
`deprecated_inputs` and `deprecation_note` in `structuredContent` plus the same
one-line note in the text.

**`include_featured` — whether a featured credit counts.** One parameter,
declared once, accepted by every artist tool: `playlist_artist_heat`,
`playlist_exclude_artists`, `playlist_remove_artist`, `playlist_keep_artist`,
`playlist_keep_only`, `playlist_move_to_top`. The default is `true`: count
every credited artist. `false` credits only the primary (first) credit on each
track, which is the measurement `playlist_artist_heat` used to produce.

**How an artist reference is matched.** A reference is resolved through the
shared reference policy (§4.0.4), so a bare 22-character id, a
`spotify:artist:…` URI and an open.spotify.com artist URL all land on the same
id, and anything else is treated as a name. A track matches on id **or**
case-insensitive name, never on a rule that silently excludes one of them — an
id-shaped reference is tried as an id and, if the row carries no matching id,
as the literal text the caller passed. `playlist_exclude_artists` additionally
returns `matched_artists` and `unmatched_artists`, which partition the caller's
input, so "this artist has no track here" and "this reference was compared
against the wrong field" are distinguishable from the result alone.

The parity test that holds all of this together is
`tests/playlistmatch.test.ts`: for one fixture containing a URI repeat, a
relink, a featured credit and a same-title/different-artist pair, every
duplicate tool reports the same group count for the same `match_by`, and every
artist tool agrees on the track count for the same `include_featured`.

---

## 5. Tools

<!-- BEGIN:generated tool-surface -->
The full MCP registry exposes **564 tools** (all 564 attributed to the 67 files under `src/tools/`), organized by 46 registration keys and 14 named toolsets; the curated default surface a server registers with no `SPOTIFY_MCP_TOOLSETS` is **128 tools** / 142,559 bytes (#889), and `SPOTIFY_MCP_TOOLSETS=all` restores the full one. Registration keys: `accounts`, `artistwatch`, `audiobooks`, `browse`, `catalog`, `doctor`, `episodemgmt`, `exhaust2catalog`, `exhaust2enggating`, `exhaust2extra`, `exhaust2misc`, `exhaust2playback`, `exhaust2playlists`, `following`, `library`, `libraryanalytics`, `personalization`, `playback`, `playbackext`, `playbackintel`, `playlistbatch`, `playlisthealth`, `playlistmisc`, `playlists`, `portability`, `prompts`, `queueops`, `receipts`, `resources`, `search`, `searchhistory`, `statsfm`, `swarm3analytics`, `swarm3bdiscovery`, `swarm3discovery`, `swarm3library`, `swarm3meta`, `swarm3playback`, `swarm3playlistops`, `swarm3refs`, `swarm3shows`, `swarm3snapshots`, `swarm4playlists`, `taste`, `tastecomposites`, `users`. `node scripts/surface-census.mjs` derives the authoritative inventory by starting the real `src/index.ts` stdio entry and calling `tools/list`, `resources/list`, `resources/templates/list`, and `prompts/list` after production gates and finalizers, without network access — twice, once for the full surface and once with `SPOTIFY_MCP_TOOLSETS` unset, so neither figure is inferred from the other.
<!-- END:generated tool-surface -->

### Shared tool contract

Beyond their endpoint-specific arguments, every tool shares this contract:

- **Argument contract (#689)** — every advertised input object is **closed** (`additionalProperties: false`), and the boundary `installToolErrorBoundary` installs at startup refuses an argument the schema does not declare **before the handler runs**, so a mistyped name costs no Spotify request. The refusal is a typed result rather than a protocol error, in the envelope §8 describes:
  - an **undeclared** name answers `kind: "unknown_param"`, naming the argument and suggesting the real declared names within edit distance of it (a misspelling of `playlist_id` gets `playlist_id` back; `limit` gets `offset` / `max_results` where those are the pagination controls);
  - a **declared but invalid** value answers `kind: "validation"`, naming the argument, the constraint the schema actually enforces, and the field's own description as the concrete next step — `playlist_sort rejected parameter playlist_id: expected a string (Playlist ID, spotify:playlist: URI, or URL)`.

  Strict rejection, not stripping: a call carrying an undeclared key is refused rather than run with that key silently dropped, because a caller whose argument did not arrive otherwise gets a confident answer to a question it never asked. Two rules govern the message, and the second is the one that is easy to get wrong — **it never claims a constraint the schema does not enforce.** A message that named a type the schema does not check would be the `name: string` arriving as `undefined` failure (#804) in prose, so a validation failure whose zod issue carries no readable expectation says nothing about the expectation and points at the schema instead. §7 states the same contract for `prompts/get`, which shares this boundary's helpers.
- **`response_format`** (`'concile' | 'detailed' | 'json'`, default `'concile'`) — `'concile'` renders human-readable prose, `'detailed'` appends fields the concise view drops, and `'json'` returns the raw API payload as JSON text.
- **`structuredContent`** — every result attaches its machine-readable payload as MCP structuredContent alongside the human-readable text.
- **`max_results`** (list-type tools; positive integer, ≤ 2000) — per-call truncation cap. The default comes from `SPOTIFY_MCP_MAX_ITEMS` (50). Truncated lists state how many items were withheld; pagination info (total / offset / next offset) rides in structuredContent and a footer hints at the next page.
- **Response byte cap (#895)** — `response_format: 'json'` and `structuredContent` are bounded by `MAX_RESPONSE_BYTES` (64,000) serialized bytes, applied by the single shared helper `applyResponseCap` in `src/shaping.ts` at the truncation boundary. json-mode text is not capped separately: it is a serialization of the same object, so it is re-emitted from the capped object and the two channels cannot disagree about what was returned. The cap is a **backstop** behind `max_results`, not a substitute for it — a tool that declares `max_results` caps itself at a far finer grain and never reaches this. It bounds a **per-call** cost and is sized against the aggregate **one-time** schema budget (`TOOL_SURFACE_BUDGET.defaultMaxBytes`, 620,000B) at roughly 1/10 of it, so ten capped calls cost about what the schema surface cost once; it does not raise or lower any schema ceiling, because the aggregate gate measures `tools/list` and a response-time constant cannot affect it. A capped result is never silently small: it carries a `response_cap` object in `structuredContent` — `response_capped: true`, `cap_bytes`, the measured `actual_bytes`, `retained_fields`, `omitted_fields` (each `{ field, bytes }`), `omitted_field_count`, and a `note` stating in words that the result is **not** the full payload. `omitted_fields` is populated only by measuring the uncapped payload, never estimated. Trimming is **top-level only**, smallest-fields-first: the cheap fields in a shaped result are the ones that describe what happened (`truncated`, `returned`, `total`, `pagination`, `counts`) and the expensive one is the bulk, so a capped result still says how much there was and the caller can page. Deep trimming is deliberately not done — dropping half a nested object would require inventing a value for the other half, which is the `name: string` arriving as `undefined` failure (#804); a field is therefore wholly present or wholly absent, and an absent field is named rather than implied. Human prose is not affected; it is capped by each tool's own `max_results` plus a footer. An `isError` result is not capped. The one case with no shared object — a bare JSON array in the text block with no `structuredContent` beside it — is capped as a byte-fitting prefix, and the disclosure follows the JSON in that same text block, which is the only channel available.
- **Paging signal** (any tool that reads one `offset` page of a larger collection: `search`, `search_deep`, the `search_<type>` family, `search_by_isrc`, `audiobooks_by_author`, and the other typed search tools) — the offset to continue from is printed as a `Next page: offset=N` line in the prose **and** carried in the `pagination` object of structuredContent. A line-oriented agent never reads structuredContent, so the prose line is the operative one; both are derived from the same value, so they cannot disagree. The line is omitted, and the pagination object's next offset is null, once the walk is exhausted — an exhausted page must not tell the agent to keep going. `structuredContent.pagination` always reports the page that was actually requested (offset and limit as sent to `/search`, never a hardcoded zero), and a `next_offset` is only emitted for a tool that declares the `offset` control it names: the truncation boundary strips an offset a caller cannot act on, because a paging signal the caller has no way to use is not a signal.
- **`fetch_all`** (paged reads) — walk every page via `client.getAllPages`, capped by `SPOTIFY_MCP_FETCH_ALL_CAP` (500). Long walks emit MCP progress notifications per page.
- **Bounded-read disclosure (#1423) — one name, repo-wide.** A tool that reads a collection under a cap and must say the read was partial discloses it with exactly this pair:

  | Field | Meaning |
  |---|---|
  | `rows_read` | Rows the bounded walk actually returned. The cap is a cap on *rows* — pagination is per-row — so this counts rows, not requests and not entities of some other type. |
  | `reported_total` | The collection's OWN reported size, or `null` when the server's count was not readable. Never the read size echoed back, and never rounded down to `rows_read` when the total is unknown. |

  with `truncated` beside them, `truncated_by_cap` when the cap is the reason rather than a walk that ended on a short page while the server's own total still counted rows, and whichever cap was in force (`scan_cap`, `fetch_all_cap`, `item_walk_cap`). Full members: `merge_playlists`, `remove_unavailable_playlist_items`, `playlist_balance`. `take_playlist_snapshot` reports the same `reported_total` but names its read side `track_count` and its verdict `cap_reached`, because it writes a snapshot file rather than answering a question about a live read.

  **Why it is stated once, here.** The field was spelled four ways and `items_read` meant two unrelated things in two tools. A caller that wants to check "was this read truncated?" cannot do it generically when the key carrying the disclosure has to be guessed per tool — and that is the §6 shape, a count that is real but that a caller reading the wrong key finds absent. `tests/truncation-disclosure.test.ts` enforces this over `src/tools/` and `tests/truncation-disclosure.test.ts` is where an exemption has to be argued for.

  Four neighbours are deliberately **not** part of this convention, and each was measured rather than assumed:
  - **`requests_read`** (`merge_playlists`, `diff_playlists`, `overlap_playlists`, `playlist_expression_algebra`, `playlist_fill_from_search`) counts source item **pages fetched**, measured per page rather than inferred from the row count. A different quantity, already named for it.
  - **`<entity>_scanned`** (`playlists_scanned`, `saved_albums_scanned`, `releases_scanned`, …) names the *entity type* a scan examined and carries no total beside it. `playlists_scanned: 12` tells a caller how many playlists were examined; `rows_read: 12` would not, and would be wrong for every other entity count on the same payload.
  - **`<field>_total` / `_returned` / `_withheld` / `_truncated`** — fifteen `swarm4_playlists` tools emit these through `budgetedArray`, which builds the keys by computation (`` [`${field}_total`] ``) from a `field` bound at each call site. They disclose what a per-call **`max_results` display cap** withheld from a rendered list, which is a *different mechanism* from a walk that could not fetch the rows: no walk, no cap on fetching, and no truncation verdict. `items_total` on this family is released and stays. It is also the key `playlist_balance` was wrongly using for its walk cap — one name, two mechanisms — which is what the rename above separates.
  - **`listening_streaks.items_read`** is the one field on a released wire contract that keeps a different name. It counts `/me/player/recently-played` **history entries**, not collection rows, and it has no reported total to sit beside. It shipped in **v2.1.0** and every release since; the repo's deprecation path (`resolvePlaylistInput` / `withPlaylistInputMetadata` / `withPlaylistInputNote`) is shaped around tool *inputs* and has no output-field equivalent, so renaming it would break real callers with no migration behind the break. It is listed in `RELEASED_DISCLOSURE_EXCEPTIONS` in `src/shaping.ts` so the exception is held open deliberately rather than by oversight.
- **`dry_run`** (destructive operations) — validate inputs and describe exactly what would change without calling the mutating endpoint. Conformance is enforced registry-wide by `tests/mutations.conformance.test.ts` (#920): the guard enumerates the live registry via `tools/list` and asserts every write-capable tool exposes `dry_run` and `response_format` unless allowlisted with a one-line reason (local sidecars only); known gaps pending sibling slices are pinned in `KNOWN_MISSING_*` lists.
- **`dry_run` default on mutating tools (v2, #827)** — a mutating tool declares the shared `DryRunDefault` fragment (`src/shaping.ts`), which is `dry_run` with `.default(true)`, and branches on `isDryRun(args)`. An omitted `dry_run` is therefore a **preview**; the write is an explicit `dry_run: false`. The bare `DryRun` fragment still declares no default and is only for read-only tools, so a `DryRun`-declared flag on a write path silently committed before this rule. This is a breaking change for callers that relied on the implicit commit: they must now pass `dry_run: false`. Migrating a module to the rule means replacing the inline `z.boolean().optional().default(true)` it declared locally with `DryRunDefault` — the behaviour is identical, so only the shared contract is new. The `exhaust2misc` slice is migrated in #827: `quick_save_now`, `discover_weekly_diff`, `dead_library_finder`, `week_in_review_playlist`, `chapter_bookmarks`, `playlist_from_tags` and `device_sync_state` all preview when the flag is omitted. `discover_weekly_diff` additionally always states the mode it ran in, so a `save_after` call that returns a diff reports `dry_run: false` after a committed archive replace and `dry_run: true` after a preview — the archive replace is a `PUT /playlists/{id}/items` and discards the playlist's previous item list.
- **`dry_run` default in the playback family (v2, #836) — BREAKING, and the opposite of #827.** Playback mutations commit when `dry_run` is omitted, and they say so: each declares the shared `PlaybackDryRun` fragment (`src/shaping.ts`), which is `dry_run` with `.default(false)`, so the published input schema carries `"default": false` and the field description names the commit semantics. A host reading `tools/list` now gets the same answer from every playback tool — `play`, `pause`, `mute`, `switch_device`, `queue_replace_via_playlist` and the rest all use that one fragment, replacing a state where the exhaustive playback module defaulted an omitted flag to a preview while the core playback, queue, playback-ext, playback-intel, scene and third-wave playback modules all defaulted it to a commit, and the shared `DryRun` fragment advertised no default at all. **Callers that relied on the implicit preview in the playback set must now pass `dry_run: true` explicitly.** Playback mutations are additive and reversible, which is why they keep the commit default rather than joining #827's preview default; #827's concern is the replace-shaped writes that discard prior content with no receipt. The library, playlist and podcast families are unchanged: they still preview when `dry_run` is omitted and still declare no schema default, because publishing one there would advertise a behaviour those tools do not honour. Unifying those families is a separate sweep.
- **`dry_run` on read-only SCAN tools (v2, #896) — a preview is a bound, not a sample.** A read-only scan declares the shared `DryRunScan` fragment (`src/shaping.ts`): `dry_run` with no default, so an omitted flag still runs the scan and the preview is opt-in. This is the opposite default to `DryRunDefault` above, and deliberately so — these tools change nothing, so previewing by default would suppress the report rather than protect anything. A conforming scan preview therefore:
  - **issues ZERO requests.** The dry-run branch is placed before every read, and this is asserted on the client's recorded call count rather than on anything the preview says about itself. `dead_library_finder` used to branch on `isDryRun(args)` only *after* `/me/tracks`, up to 1000 recently-played and up to `max_playlists` playlists paged 500 items each — and because its `dry_run` defaults to true, the documented-safe path was the most expensive call in its module.
  - **reports a request BOUND derived from the inputs**, never from performing the scan. The bound must be a whole number of requests and must cover the requests the executed path actually spends. A bound that multiplies a per-collection cost by the number of collections the runtime will discover — `saved_vs_playlist_coverage` added the per-playlist item pages once instead of once per playlist, under-reporting a 500-item cap by roughly 100× — is worse than no bound, because the caller budgets against the number and then spends it.
  - **says explicitly which part of the answer it cannot compute.** Where the plan is genuinely not knowable from the arguments, the preview reports `null` for it plus a `*_known: false` marker and a note naming why — never `0`, never `[]`. `dead_library_finder` qualifies a track only if it is in neither the recent 90 days of plays nor any scanned playlist, so its preview reports the cost and states the candidate list is unknown; returning `count: 0` there would be indistinguishable from "you have no dead tracks" and would invite a commit that removes nothing. This is the same rule §6 records for #803 and #804: a value that could not be read is never coerced into a plausible one.
  
  Members: `saved_vs_playlist_coverage`, `dead_library_finder`, `playlist_staleness_report` (gains the flag in #896; it previously had no preview at all while defaulting to ~251 requests), and the `swarm3library` module's other scan previews, which already declared the same fragment locally — the fragment moved into `src/shaping.ts` so the three modules can no longer disagree about what the flag means. `playlist_staleness_report` also degrades on a mid-walk 429 — the single call can spend up to 251 requests, so a throttle part-way through returns the rows gathered so far with `quota_hit_at_playlist` and `complete: false` rather than discarding a mostly-complete report.
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
Read the playback queue. This and `peek_next` are the only two queue-read entry points (#847); the six registrations they replaced — `describe_queue`, `get_queue_snapshot`, `queue_runtime_report`, `queue_duplicate_check`, `queue_profile` and `predict_next_tracks` — are retired, and a call naming one is refused with `reason: "retired_tool_alias"` and a `fix` naming the exact replacement call below.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `view` | `"raw"` \| `"enriched"` | no | `raw` (default) = the queue as returned. `enriched` = plus `context_label` (the source playlist/album name) and `total_remaining_ms`. |
| `include` | `("runtime"\|"duplicates"\|"profile")[]` | no | Local analyses over the same read, default `[]`. `runtime` = total/average/longest/shortest, the time left on the current track, and a `timeline` of every row with its cumulative `plays_at_ms`. `duplicates` = repeated rows and the runtime they waste. `profile` = unique artists/albums/shows, track-vs-episode mix, longest single-artist run. |
| `max_results` | number | no | Truncates the returned item list only. |
| `response_format` | enum | no | |

**Quota:** exactly one `GET /me/player/queue` per call, whatever `view` and `include` are. `view: "enriched"` and `include: ["runtime"]` each add one `GET /me/player`; a call asking for both reads it once, and the context label adds one catalog read. `duplicates` and `profile` are local compute and cost nothing.

**Returns:** currently playing item, plus the up-next list (name, artist, duration, URI) truncated to `max_results` with pagination info in structuredContent. Analyses run over the **whole** queue, never the truncated page, and appear under `runtime` / `duplicates` / `profile` only when requested.

`runtime.current_track_remaining_ms` needs a second endpoint. If that read fails it is `null` with `current_track_remaining_error` naming the failure, and `estimated_total_wait_ms` and `runtime.timeline` are `null` too — never `0` and never a column of plausible offsets, which would read as "the current track is already over" and as real start times (#803). `timeline` entries are the full row (`position`, `uri`, `name`, `subtitle`, `duration_ms`, `is_episode`, plus the album/show/artist context) with `plays_at_ms` added, which is the retired `predict_next_tracks` `items[]` widened. It is not capped by `max_results`: the page is a page, a total that quietly covered one is a wrong number wearing the right field name.

---

#### `peek_next`
Short lookahead at the queue: the next N items with durations and total runway. One of the two queue-read entry points (#847) — the other is `get_queue`, which answers for the whole queue, its runtime, duplicates and composition.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `count` | number | no | How many to peek, 1–50 (default 5). Alias for `max_results`. |
| `max_results` | number | no | |
| `response_format` | enum | no | |

**Quota:** 1 read. The per-item ETA the retired `predict_next_tracks` returned is `runtime.timeline` from `get_queue` with `include: ["runtime"]` — it needs a second endpoint, which this lookahead does not pay for.

---

#### `add_to_queue`
Add a track or episode to the end of the queue.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `uri` | string | yes | Spotify track or episode URI |
| `device_id` | string | no | |

---

#### `queue_playlist`
Queue every track behind a playlist, album, artist, track or episode URI, in order.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `source_uri` | string | yes | `spotify:playlist:`, `:album:`, `:artist:`, `:track:` or `:episode:` |
| `mode` | `"append"` | no | `"replace"` is not supported — Spotify has no queue-clear endpoint, so it is refused with `ok: false` rather than silently appended |
| `limit` | number | no | Cap on queued tracks (1–200, default 100) |
| `device_id` | string | no | Target device id |

**Returns:** `queued` / `failed` counts with a per-URI reason, plus `resolved_via` —
which read produced the list. For an artist source that is `top_tracks`, or
`albums` when the top-tracks read could not answer and the artist's recent albums
supplied the list instead. In that second case `note` carries the disclosure
(naming the endpoint, the status, and that the tracks are **not** a top-tracks
selection), because a gated `/artists/{id}/top-tracks` is a property of the app
registration, not of the artist — see the `/artists/{id}/top-tracks` status note
in §4.0.4. A successful-but-empty top-tracks read walks the albums too and
carries **no** `note`: the read happened and genuinely returned nothing.

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

#### `market_availability`
Check whether a track, episode, or album is available in each of 1–10 markets.
All markets are probed in **one concurrent batch** (`N× GET /{type}/{id}?market=X`);
the requests pass through the shared request funnel, so the process-wide
concurrency ceiling and the shared rate-limit gate still bound what goes out.
Results are reported in the caller's market order regardless of which probe
resolved first.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `uri` | string | yes | Spotify URI (track/episode/album) |
| `markets` | string[] | yes | 1–10 market codes to test, e.g. `["US","JP","DE"]` |
| `response_format` | `"concise"` \| `"detailed"` \| `"json"` | no | Output shape — the shared response modes, not this tool's own |

**Returns:** `per_market[]` with one row per probed market, each carrying
`market`, `available` (the read returned a payload), `is_playable`,
`name?`, and `error?` (why the probe failed, when it did), plus
`available_count`, `playable_count`, and `playable_unknown_count`.

`is_playable` is `true`, `false`, or **`null`**, and the `null` case is
load-bearing. The current OpenAPI schema publishes `is_playable` on track and
episode objects but **not on album objects**, and on a track it appears only
when relinking applied — so an absent field is an unanswered question, and it
is never coerced to `false` (that would report an unavailability Spotify never
stated). `playable_unknown_count` counts those markets.

This tool no longer reads `available_markets`, which the schema flags
`deprecated: true` on every object that carries it. It previously reported
that field as the authoritative global answer and, when the field came back
empty, as `Full available_markets: 0` — a degradation the module's own rules
forbid. The per-market `is_playable` is the API's own answer.

A 404 means "not available in this market"; a 429 or transport failure is a
statement about the run, not about the market, and is reported as such with
its reason so a throttled sweep cannot read as a clean sweep of
unavailability.

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

`playlist_fill_from_search` also sends at most 10 track results per `/search` request. It requests later offsets only when the requested number of new playlist items has not yet been found, and its plan discloses the candidate count and pages searched for every query. Its pre-read of the playlist's existing items is covered by [the exhaust2 playlist-item walk contract](#exhaust2-playlist-item-walk-contract-898). It accepts `queries` as an array of at most 25 entries or as one comma-separated string bounded by the same 25, and reports `requests_read` (every paged read the call issued, including the target playlist's metadata read and existing-items walk) alongside `search_requests_read` (the `/search` pages alone).

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
| `limit` | number | no | 1–10. Default: 10 |

`GET /artists/{id}/albums` hard-caps `limit` at 10 and answers **400** above it, so 10 is this tool's ceiling, not a local choice. A discography longer than one page is read with `offset`, or whole with `fetch_all` (bounded by `SPOTIFY_MCP_FETCH_ALL_CAP`), both of which disclose what the walk read.

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

**Returns:** display name, user ID, URI. Spotify removed `email`, `country`, `product`, `followers` and `explicit_content` from `GET /me` in February 2026, so on a current registration they are not returned and are omitted rather than placeholdered; a grandfathered registration that still sends one has it printed.

---

#### `get_show`
Get full details for a podcast show.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Show ID |
| `market` | string | no | ISO 3166-1 alpha-2 country code |

**Returns:** name, description, explicit, total_episodes, languages, media_type, URI, and a ten-row episode preview (name, duration_ms, release_date, resume_point, URI). `publisher` was removed from show payloads in February 2026, so it is omitted from this card rather than printed as a placeholder. When the show holds more, the card states how many episodes of how many it showed and points at `list_show_episodes`.

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

**Why these seven keep the batch route (#1224).** Every *other* caller of a
`?ids=` route was migrated to the per-id read when the February 2026 changelog
removed it (see the note in §4.0.4). This family is the deliberate exception: it
is the user-facing surface for "look these up in one call", it keeps the shared
`CHUNK_CAPS` contract above, and its requests go through the graceful-403
wrapper in `src/gating.ts`, so a registration without the grant degrades to a
disclosed partial rather than throwing. Un-migrating it is #638's call, not this
section's.

#### Per-id fan-in reporting (#1224)

Six tools read a list of catalog ids and now do it one `GET /{type}/{id}` at a
time (see the `?ids=` note in §4.0.4): `track_enrichment_batch` (its track,
album and artist legs), `albums_runtime_batch`, `library_hygiene`, and the seven
`swarm3discovery` / seven `swarm3bdiscovery` tools that fan in full album
payloads. One contract covers all of them:

- **Requests are disclosed, not summarised.** Each fan-in publishes the number
  of requests it actually issued (`album_requests`, `artist_requests`,
  `album_lookups.requests`), which replaces the old "one batch call" figure. The
  honest cost went up; a cost that cannot be measured is worse than a cost that
  is merely higher.
- **A failed read is named, never absorbed.** Every unresolved id appears with
  its reason and HTTP status (`track_unresolved`, `album_unresolved`,
  `artist_unresolved`, `album_lookups.unresolved`), in the order it was
  requested. An album that could not be read is *not* an album with no label, no
  tracks and no deep cuts — `label_explorer` excludes it from the census rather
  than filing it under `(unknown label)`, and `artist_latest_release_report`
  prints `label UNREAD` rather than `label unknown`.
- **A field Spotify removed is never a bucket (#639).** A *failed read* is only
  half the way a value can go missing, and #639 is the other half: Spotify
  removed `label` and `publisher` from Album/Show payloads in February 2026, so
  a `?? '(unknown label)'` fallback did not file the failures under a placeholder
  — it filed every **successful** read there, and published
  `distinct_labels: 1` as a finding. Every rollup that groups on a removed field
  now groups only the rows that actually carry one, publishes the coverage that
  makes its totals checkable (`albums_labelled`/`albums_without_label`,
  `shows_with_publisher`/`shows_without_publisher`,
  `releases_labelled`/`releases_without_label`), and returns
  `available: false` with a `reason` naming the changelog when **no** row carries
  the field. The tools that matched on it, rather than counted it, are the worse
  case and are handled separately below. `src/removed.ts` holds the one
  transcribed list; the fixture-backed guard is `tests/removed-fields.test.ts`.
- **A removed facet that is searched is not "no results" (#639).**
  `find_show_by_publisher` matched on `publisher`, which is gone, so its
  predicate degraded to a substring test against the literal placeholder — a real
  query ("Wondery") matched nothing and was reported as `0 publisher match(es)`
  with a scan note blaming page coverage, while a query of `"unknown"` matched
  every row and marked each one `publisher_match: true`. It now detects the
  absent facet, falls back to name matching only, reports
  `publisher_facet_available: false` and `publisher_matches: null` (**not** `0`,
  which is indistinguishable from "this publisher publishes none of these"), and
  says in prose that the zero means "not searched", not "none found".
  `search_saved_shows` had the same dead clause — `show.publisher ?? ''` can
  never match a non-empty query — and is name-only now.
- **#1093 accounting is unchanged.** `counts.requested == counts.resolved +
  counts.missing_ids.length` still holds; a per-id `unresolved` entry plays the
  part the null slot played in the batch response. `albums_runtime_batch` keeps
  `counts` to exactly those three keys and publishes the reasons beside it as
  `album_unresolved`, so the #1093 contract is byte-identical.
- **Rate limiting still degrades, it does not abort.** The fan-out records the
  first 429 (`{ message, retry_after_sec }`) rather than throwing, so
  `library_hygiene`'s #763 partial-with-`Retry-After` path survives: the run
  finishes, reports the albums it did read, and names the throttled ones.
  `library_hygiene` also drops the obsolete `batch_requests` / `batch_size` keys
  from `album_lookups` in favour of `requests`, `request_mode: 'per_id'`,
  `fanout_width` and `unresolved`; its `dry_run` reports `request_mode`,
  `fanout_width` and `estimated_album_requests`.

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

> **Feb 2026 note**: Save, remove, and check operations accept **Spotify URIs** (e.g., `spotify:track:abc123`) rather than bare IDs. There is now only one family. A legacy trio (`save_items`, `remove_saved_items`, `check_saved_items`) partitioned its URIs by type across `PUT`/`DELETE /me/{type}s` and `GET /me/{type}s/contains`; Spotify removed all of those in February 2026, and #638 deleted the three tools. Use `save_to_library`, `remove_from_library` and `check_in_library`, which issue a single call against `/me/library` and accept a wider URI mix.

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

#### Retired: the per-type library trio

`save_items`, `remove_saved_items` and `check_saved_items` are **removed** (breaking, #638). They partitioned their URIs by type and called `PUT`/`DELETE /me/{tracks,albums,shows,episodes,audiobooks}` and `GET /me/{type}s/contains`; Spotify's February 2026 changes deleted every one of those endpoints, naming `PUT`/`DELETE /me/library` and `GET /me/library/contains` as the replacements. Their stated purpose — being kept for grandfathered app credentials that lack unified `/me/library` access — described a credential class that can no longer exist: a registration that cannot reach `/me/library` has no per-type endpoint left to fall back to either.

| Retired tool | Use instead | Behaviour change |
|---|---|---|
| `save_items` | `save_to_library` | max 50 → max 40 URIs; one request instead of one per type |
| `remove_saved_items` | `remove_from_library` | max 50 → max 40 URIs; one request instead of one per type |
| `check_saved_items` | `check_in_library` | also accepts artist, user and playlist URIs |

All three also had a second defect that the replacement does not inherit: a read or write that failed part-way was reported as a confident, complete answer. `check_saved_items` rendered a short or non-boolean contains body as "✗ not saved" for every row, and the write pair recorded only the committed subset while still reporting the whole batch as done. `check_in_library` now **fails closed** instead — see below.

#### `save_to_library`
Save one or more items to the user's library via Spotify's unified library endpoint — a single request for any mix of URI types.

**Inputs:** `uris` (string[], required, max 40 — track, album, episode, show, audiobook, user, or playlist URIs)

Sends `PUT /me/library?uris=…`.

---

#### `remove_from_library`
Remove one or more items from the user's library via the unified endpoint in a single request.

For a single playlist there is also the always-gated `unfollow_playlist` (see [Playlist follow family](#playlist-follow-family-1099)), which prompts before writing and refuses `public=false` outright.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `uris` | string[] | yes | URIs to remove (same accepted types as `save_to_library`). Max 40. |
| `dry_run` | boolean | no | Preview exactly which URIs would be removed without calling the API |

Sends `DELETE /me/library?uris=…`.

---

#### `check_in_library`
Check whether items are saved in or followed by the user via the unified contains endpoint. Accepts artist, user, and playlist URIs (follow state) in any mix.

**Inputs:** `uris` (string[], required, max 40 — track, album, episode, show, audiobook, artist, user, or playlist URIs)

Sends `GET /me/library/contains?uris=…`. **Returns:** array of booleans matching input order.

The response is **positionally** matched to the request, so a body that is not an array, is not the same length as the request, or holds a non-boolean is rejected rather than padded: a partial read used to render its missing rows as "✗ not saved", which is a failed lookup reported as a confirmed negative. The same guard is applied by `check_following_artists`, `restore_library_snapshot` and the `check_episode_saved` / `remove_saved_episode` pair in the shows module.

> **The read half accepts more URI types than the write half.** `contains` takes eight kinds including `artist`; `PUT`/`DELETE /me/library` take seven and exclude it. Playlist URIs are accepted by all three, so playlist follow/unfollow is fully expressible and an artist follow is not — see [Playlist follow family](#playlist-follow-family-1099).

**Note on following an artist**: this tool *reads* follow state for artist URIs, but nothing can *write* it. `PUT /me/library` does not accept `spotify:artist:` URIs, and Spotify removed `PUT`/`DELETE /me/following` in February 2026 with no replacement, so no endpoint can follow or unfollow an artist. The read half migrating to `/me/library/contains` is what makes this look migrated; the write half has no target.

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
- **Remove** — every removed uri is absent, with the row count checked against the pre-mutation `before` total. A bare-uri delete uses the absence check; a positions-targeted delete states its `targetedPositions` so a playlist holding a duplicate of the same uri is not reported as still holding it. A targeted delete's only check is that count, so it needs both numbers to compare: `remove_from_playlist` therefore reads the row count *before* its `DELETE` and passes it as `before`. A targeted receipt with no baseline is `UNVERIFIED` with `unmet` naming the missing baseline, never `VERIFIED` (#626) — and a baseline that could not be read withholds the claim without blocking the write.
- **Replace** (`PUT /playlists/{id}/items`) — presence, PLUS the post-write row count, PLUS the row order the first chunk wrote from position 0. The count and order are what catch a dropped replace: a no-op `PUT` leaves the old rows in place, and a reorder such as a reverse preserves both the multiset and the count, so a presence- or count-only check would certify a dropped reverse as verified.

A response carrying no `total` leaves the row-count check unset rather than guessed at, and the walk is never padded into a pass. When a check that is not about uris fails, the reason is reported in the receipt's `unmet` (e.g. `row count 5 ≠ expected 2`), kept out of `missing`, which is documented as uris the walk did not find and is consumed as data by `undo_mutation`.

**An empty result set is not evidence of success** (#1252). Every check above compares a re-read against what the write claimed, and an unreadable read produces the same shape as a genuinely empty one — a `204`, an empty body, a non-JSON payload and a walk that stopped mid-list all leave the comparison with nothing to say. That is a value which could not be read being coerced into a plausible one, so each check now requires the read it depends on:

| Check | Requires | Without it |
|---|---|---|
| Bare-uri removal — absence | the walk saw the **whole** playlist | `UNVERIFIED`, `unmet` naming the unread read, `missing` empty, `after` unset |
| `library` removal — absence | every `/me/library/contains` chunk answered | `UNVERIFIED`, `unmet` naming how many uris went unread, `missing` holding only what the chunks that answered observed, `after` unset |
| `library` save — presence | every chunk answered | `UNVERIFIED`, `unmet`, and `missing` empty — an unread chunk is not a set of missing uris |

`missing` is left empty on an unread read because it is a *uri list* consumed as data by `undo_mutation` and `writeVerdict`; a chunk that did not answer observed neither presence nor absence, and filing either there would be a guess. `after` is left unset rather than counted, so a read that never happened cannot become a `0` or a full count. A chunk whose flag array is short or non-array is treated as unreadable for the same reason — the indexes it does not cover were never answered. Because `unmet` is set, the receipt's prose prints the reason and no `all uris confirmed` line, which is a claim only a `VERIFIED` verdict earns.

**Tools carrying the contract:** `apply_snapshot_changes`, `balance_playlist_pairs`, `collab_mix_from_followed`, `dedupe_playlist_apply`, `extract_playlist_range`, `filter_playlist_by_artist`, `filter_playlist_by_duration`, `filter_playlist_by_era`, `interleave_playlists_plan`, `library_to_playlist`, `merge_playlists_plan`, `move_tracks_between_playlists`, `playlist_add_by_search`, `playlist_clone_live`, `playlist_difference_plan`, `playlist_expression_algebra`, `playlist_exclude_artists`, `playlist_fill_from_search`, `playlist_intersect`, `playlist_keep_only`, `playlist_move_to_top`, `playlist_slice`, `playlist_strip_episodes`, `playlist_trim_to_duration`, `queue_replace_via_playlist`, `remove_playlist_range`, `replay_session`, `restore_library_snapshot`, `restore_playlist_from_snapshot`, `reverse_playlist_plan`, `rotate_playlist_plan`, `save_queue_as_playlist`, `saved_tracks_roulette`, `sort_playlist_apply`, `split_playlist`, `split_playlist_by_count`, `split_playlist_by_duration`, `split_queue_plan`.

`dry_run` results are unchanged: no request is sent, nothing is verified, and these fields describe the write as it would land rather than as it landed.

#### Confirmation-refusal payload contract (#1100)

A confirmation-gated write that is refused returns a **result**, never an exception. The refusal is a normal tool result whose `structuredContent` carries `ok: false` and `cancelled: true`, and — where the verdict distinguishes one refusal from another — a machine-readable `reason` discriminator:

| Verdict | `reason` | Meaning |
|---|---|---|
| `declined` | *(absent)* | The human explicitly declined. The bare `{ok: false, cancelled: true}` **is** the signature; a reason field here would imply the tool could not tell a "no" from a failure. |
| `error` | `elicitation_failed` | The prompt was attempted and failed on the wire. A dead gate must not become an ungated write, so the write is refused. |
| `unsupported` | `confirmation_unavailable` | The client never advertised elicitation, and `SPOTIFY_MCP_CONFIRM` is not `never`. There was never a human to ask. |

**This is the contract for every tool that gates on `confirmViaElicitation` + `requiredConfirmationRefusal`**, which is the fail-closed pair in `src/tools/confirm.ts`. `SPOTIFY_MCP_CONFIRM=never` remains the only bypass, and it is deliberate: an operator must set that value on purpose. No other `ElicitVerdict` member proceeds, and the closed-union default refuses rather than falling through.

Two properties are worth stating because they are the ones a host depends on:

- **The verdict is machine-readable, not prose.** A caller distinguishes "the human said no" from "we could not ask" from the parsed `reason` field, never by matching text. Both halves of the follow pair return an identical payload for the same verdict, so a host needs no per-tool special case for a tool and its own inverse. That parity holds across the four registered names (#1099), because the aliases share the canonical handlers rather than reimplementing them.
- **A refusal is a result, not a crash.** An unpromptable host previously got a bare thrown `Error` from the unfollow half on the failure verdicts while the follow half returned a structured refusal (#1100). That is fixed, and it is a visible behaviour change for any host that distinguished the two: a failure to establish confirmation is a refusal, not an exceptional condition. The gate itself is unchanged — every verdict other than `confirmed` still stops the write.

#1237 closed the same gap in the last six writes that still hand-rolled the decision: `remove_from_playlist`, `update_playlist` (the visibility gate), `replace_playlist_items`, `remove_duplicate_playlist_items`, `clean_all_playlists`, and `restore_library_snapshot`. Each returned a structured refusal for `declined` but **threw** for `error` and `unsupported`, so within a single tool a host that handled the refusal shape handled one of the three ways the gate says no. All six now call `requiredConfirmationRefusal`, which makes the sentence above true of *every* gated write in the server rather than of the follow/unfollow pair. This is the same behaviour change #1100 called out, extended to the remaining sites: a host that distinguished a refusal from an exception must switch to reading `reason`.

`restore_library_snapshot` is the one site whose `response_format` shaping is bespoke — a rich `cancelled` plan summary rather than the one-line refusal text the other gated writes return. Its guard payload is **merged onto** that summary rather than replacing it, so `status: 'cancelled'` and the per-category plan a host already parses survive alongside the `ok`/`cancelled`/`reason` fields. A caller reading `status` is unaffected; a caller branching on `reason` gets it without losing the plan.

The *conditions* under which any of these six prompts are unchanged by #1237 — only the shape of a refusal moved. The thresholds (`REMOVE_ELICIT_THRESHOLD`, `REPLACE_ELICIT_THRESHOLD`, `VISIBILITY_ELICIT_THRESHOLD`) and the operations that gate with no threshold at all are the same as before, and the regression tests pin each gate from both sides of its threshold so a future change to either fails rather than passing silently.

Annotations are orthogonal to this gate and do not substitute for it. `destructiveHint: true` is a static host hint applied after registration; it never prompts, and a tool carrying it is still gated (and vice versa). `unfollow_playlist` carries it because it removes a library entry the user may have curated by hand, and `unfollow` matches a `DESTRUCTIVE_PREFIXES` entry, so it needs no `OVERRIDES` row. The deprecated `unpin_playlist` alias still does: `unpin` matches no entry in either prefix list, so the hint is stated through `OVERRIDES` rather than by widening a prefix. That row retires in 2.1 with the alias; adding `unpin` to a prefix list instead would leave a live rule behind encoding a verb no tool then has.

#### Purpose and provenance on stored-data writes (#708)

Six tools write Spotify state from data this Server stored locally. Each publishes two top-level `structuredContent` keys on **every** result — planned, executed, cancelled or nothing-to-add — plus the same facts in the confirmation prompt and in the prose:

| Tool | Stored source | Declared date read from |
|---|---|---|
| `restore_library_snapshot` | library backup file | `_meta.created` |
| `playlist_clone_snapshot` | library backup file | `_meta.created` |
| `restore_playlist_from_snapshot` | playlist snapshot file | `_meta.taken_at` |
| `apply_snapshot_changes` | two playlist snapshot files | `_meta.taken_at` of the target-state file |
| `import_from_sidecar` | `library.json` sidecar | `exported_at` |
| `import_playlist` | M3U/CSV document, or inline content | *(none — the format declares no date)* |

- **`consent_note`** — one sentence: the source, the date (or the named reason there is none), the item count, the single use, the purpose limitation, and the consent outcome. The prompt and this note are rendered from one object, so the words a human approved and the words an audit later reads cannot drift.
- **`provenance`** — the same facts as fields: `source_kind`, `source_path`, `source_related_paths` (a two-snapshot merge names both files), `source_created`, `source_created_field`, `source_missing_date_reason`, `source_items`, `purpose`, and `consent`.

**Consent is a four-state value, never a boolean.** A write driven by stored data very often has no human in the loop, and a flat `confirmed: true` written in either of those cases would be a fabrication wearing a compliance label:

| `consent.state` | Meaning |
|---|---|
| `confirmed` | A prompt was shown and a human accepted it. |
| `declined` | A prompt was shown and a human refused it; nothing was written. |
| `not_requested` | No prompt was issued. `because` names why — a size threshold, a dry run, or a tool that has no gate. |
| `bypassed` | The gate was reached but `SPOTIFY_MCP_CONFIRM=never` let the write through unprompted. `via` names it. |

The state is derived from the guard's own `reason`, not from a fresh read of the environment: an `unsupported` verdict followed by a `confirmation_unavailable` refusal and an `unsupported` verdict followed by the `SPOTIFY_MCP_CONFIRM=never` bypass are the same verdict and opposite facts, and re-deriving that from the environment is how a refused write would end up recorded as an approved one.

**The date is what the file declares, and nothing else.** A snapshot written before the schema that stamps it declares no date; the record carries `source_created: null` and a `source_missing_date_reason` naming which field is absent. The file's mtime is never substituted — copying a file resets it, so an mtime is a date the filesystem guesses about a path, not one the file states about itself. `import_playlist` has no declared date in either mode: the M3U and CSV formats carry no creation timestamp, and its record says exactly that.

**Purpose is the operation, not a motive.** The Server cannot observe why a caller wants stored data written back, and a plausible invented reason would be a fabricated answer reading as a real one. Each `purpose` states the write that is about to happen. No caller-supplied purpose is accepted.

This changes consent *content* and adds no gate. Every threshold, every `dry_run` default, and every `confirmViaElicitation` call is unchanged; the three snapshot tools that have no gate still have none, and now say so in their record.

#### Playlist follow family (#1099)

`follow_playlist` and `unfollow_playlist` save and remove a playlist in the caller's own library. Both gate on `confirmViaElicitation` + `requiredConfirmationRefusal` with **no threshold** — they always ask.

| Tool | Sends | `dry_run` default | Notes |
|---|---|---|---|
| `follow_playlist` | `PUT /me/library?uris=spotify:playlist:{id}` | `true` | Opt-out of preview (#870): following is a write, and this family in particular was committing while callers believed they were previewing. |
| `unfollow_playlist` | `DELETE /me/library?uris=spotify:playlist:{id}` | `false` | Always asks. |

**These tools do not pin, and never have.** The endpoint Spotify's February 2026 changelog retired — `PUT`/`DELETE /playlists/{id}/followers` — was a *follow*, not a pin: it added the caller to the playlist's followers. Nothing ever pinned. The two were named `pin_playlist` / `unpin_playlist` while doing that, so a caller reading the tool name had no way to learn the difference, and the only place it was documented was prose inside the description. #1099 renamed them.

**What a follow now does, exactly.** It saves the playlist URI to your library. The old endpoint's request body carried a `public` flag that published the playlist to the caller's public profile; `PUT /me/library` takes no body, so that side effect has no equivalent. `public` is therefore rejected rather than silently ignored: `public: false` throws before any Spotify request, and `public: true` is accepted for call-site compatibility but reaches neither the request nor the confirmation prompt.

**Why playlists and not artists.** `GET /me/library/contains` accepts `spotify:artist:` URIs; `PUT`/`DELETE /me/library` do not. Following an artist is therefore unexpressible as a write, and `follow_artists` is being removed for that reason. Playlist URIs are accepted by the read *and* the write, so this family migrated cleanly and what remained was purely a naming defect.

**Returns** (canonical calls): `{ ok: true, playlist_id, followed: boolean }` on commit, `{ ok: true, dry_run: true, playlist_id, would_follow | would_unfollow: true }` on preview, or the refusal payload above.

#### Deprecated tool names — one release, then removed

`pin_playlist` and `unpin_playlist` remain registered as **deprecated aliases**. They were promised for removal in 2.1 and 2.1 shipped with both still served; **they are still registered**, and their notice no longer dates a removal no release has scheduled. #1287 removed the legacy playlist *input* names (a different deprecation, same one-release rule); retiring these two tool NAMES is not part of it, because §5 makes it a different change — deleting the names, pinning their absence in `tests/tool.surface.test.ts`, adding them to `retiredToolNames`, and dropping the now-dead `unpin` `destructiveHint` OVERRIDES row. Until that change lands, the honest notice is "deprecated, here is the replacement" rather than a version that already came and went.

| Deprecated | Use instead |
|---|---|
| `pin_playlist` | `follow_playlist` |
| `unpin_playlist` | `unfollow_playlist` |

Each alias is registered against the **same handler** as its replacement, with the same input schema — not a copy — so the two cannot drift in behaviour and the alias is not a route around the confirmation gate. A call that used a deprecated name carries `deprecated_inputs` and `deprecation_note` in `structuredContent`, plus the same one-line note in the prose/JSON text; a canonical call carries neither:

```json
{ "ok": true, "playlist_id": "pl1", "followed": true,
  "deprecated_inputs": ["pin_playlist"],
  "deprecation_note": "Deprecated tool name pin_playlist; use follow_playlist." }
```

`deprecated_inputs` carries the legacy *spelling the caller used* — here the tool name itself, not a parameter. The tool's parameters are `playlist_id` / `public` / `dry_run` / `response_format`, none of which appears in that array; the note says "tool name" in words for that reason.

**Migration:** replace the tool name in any prompt, saved recipe, or host allowlist. No input changes — the schemas are identical, and the requests the two names issue are byte-identical.

#### Playlist set/diff input contract (#912)

All playlist set-operation, diff, overlap, intersection, union, subtraction, merge, following, and pair-analysis tools compose the same typed fragments from `src/shaping.ts`. Playlist references accept a raw ID, `spotify:playlist:` URI, or Spotify playlist URL and are normalized to the ID used in `/playlists/{id}` paths.

| Tool family | Tools | Canonical input | Retired spellings (accepted through v2.0; **removed in v3.0**, #1287) |
|---|---|---|---|
| Ordered multi-playlist operation (one alias each, per tool) | `playlist_intersection`, `playlist_overlap_matrix`, `playlist_intersect`, `playlist_union`, `merge_playlists`, `merge_playlists_plan`, `interleave_playlists_plan`, `playlist_union_preview`, `find_duplicate_tracks_across_playlists`, `balance_playlist_pairs` | `playlists` | The tool's prior plural name: `playlist_ids`, `source_playlist_ids`, or `sources` |
| Ordered overlap analysis | `overlap_playlists` | `playlists` | None; canonical-only input |
| Base-minus-set operation | `playlist_subtract`, `playlist_difference_plan` | `base_playlist_id` plus `playlists` for the sources to subtract | `subtract_playlist_ids`, and the positional form `playlists: [base, ...sources]` |
| A/B comparison | `diff_playlists`, `playlist_diff`, `playlist_pair_check`, `compare_playlist_covers`, `playlist_symmetric_difference` | `playlist_a`, then `playlist_b` | one per tool, not a bundle: `diff_playlists` takes `a`/`b`, `compare_playlist_covers` and `playlist_symmetric_difference` take `playlist_id_a`/`playlist_id_b`, `playlist_diff` and `playlist_pair_check` take `playlist_a_id`/`playlist_b_id` |
| Following fan-out | `check_playlist_following` | `playlists` | `playlist_ids` (retains its historical 1–50 bound) |
| Single playlist identifier (not a set — see the note below) | `get_playlist`, `get_playlist_items`, `get_playlist_cover`, `update_playlist`, `search_within_playlist` | `playlist_id` | `id` — **not** on the v2.1 removal schedule below; still supported, no removal announced |

**The single-identifier family is a different shape from the rows above.** Every row in this table so far describes a *collection* input (a plural list, or an A/B pair) built from the shared `src/shaping.ts` fragments, and its legacy names are plural collection names retired on a stated schedule. The `playlist_id`/`id` pair is neither: it is a single playlist reference, and its alias has no announced removal because `playlist_id` is the canonical name the rest of the tool surface moved to and `id` is the spelling these five tools shipped with. They are listed here rather than folded into a row above because a row claiming `playlist_id` was the legacy alias of a plural list would be false.

Both spellings resolve through the one exported helper `resolvePlaylistId` (`src/tools/playlists.ts`), so the two rules below are uniform across all five tools and are enforced before any Spotify request:

- **Supplying both is allowed only when they agree.** Conflicting values are refused with both names quoted, before the tool dispatches anything.
- **Supplying neither is a handler-level error, not a schema error.** Neither spelling is marked required in the JSON Schema, so a call that omits both passes validation and then raises `Provide the playlist as playlist_id (or pass it as id)` once the handler runs. This is why the per-tool tables below record the identifier as `yes (runtime)` rather than a plain `yes`: the field is genuinely required for the call to succeed, but schema validation will not catch its absence.

**Returned versus total counts.** Where a set operation returns arrays, `removed`/`kept` (and `uris`/`removed_uris` beside them) count only the rows actually returned, bounded by `max_results`; `removed_total`/`kept_total` carry the true impact the confirmation prompt quoted. A capped response therefore never reports a count its own arrays contradict.

**Planned-move arrays.** `balance_playlist_pairs` plans one move object per track, so the plan is bounded by the same `max_results` cap as its prose: `moves` in structuredContent carries the capped rows, and `moves_total` / `moves_returned` / `moves_withheld` / `moves_truncated` disclose the full plan the array withheld. `response_format: 'json'` is the full-record opt-in — it returns every move and reports `moves_withheld: 0`.
**Empty results clear the playlist (#888).** When `playlist_subtract` removes every track, or `playlist_union` merges only empty sources, the target list is empty and the tool sends one `PUT /playlists/{id}/items` with `{ "uris": [] }`. This is the endpoint's documented clear — the OpenAPI description for `reorder-or-replace-playlists-items` states that the operation "can be used for replacing or clearing items in a playlist", and the body's `uris` array declares no `minItems` — so it is not emulated with a descending sweep of position-based `DELETE`s (N requests instead of 1, and a half-emptied playlist if one fails). A full wipe still passes the destructive confirmation gate, because emptying makes the replacement non-identical. Such a result reports `emptied: true` and its own prose line (`Playlist emptied` / `Emptied <id>`). The 200 body is `{snapshot_id: string}` with no `required` list, so the clear can come back with no readable receipt; when that happens the result is `ok: false` with `reason: "clear_unconfirmed"` and `snapshot_read: false`, and the prose says the clear was *sent* but is unconfirmed — an unreadable receipt is never reported as a confirmed clear over a null `snapshot_id`.

**Bounded playlist lists and the read cost they imply (#899).** Every `playlists` / legacy-alias list above is capped per tool, and the cap is a READ-COST ceiling: each entry is one paged walk, so the bound limits requests per call rather than the size of a single Spotify request. `merge_playlists` takes at most 10 `playlists`, `overlap_playlists` and the other `PlaylistListFields` tools at most 10 `playlists`, `playlist_fill_from_search` at most 25 `queries`, and `check_playlist_following` keeps its 1–50 `playlists` bound.

- **A comma-separated string is accepted** wherever one of these lists is expected (for example `playlists: "idA, idB, idC"`, `queries: "jazz,ambient"`). It is split on commas, trimmed, emptied parts dropped, and then bounded by the same limit, so the scalar form cannot carry a longer list than the array form — the string is normalised *before* the bound applies, not exempt from it. This exists for hosts that cannot express a JSON array; it is not a second, looser contract. The advertised JSON Schema is unchanged by it: the bound still reaches hosts as `minItems`/`maxItems`.
- **Over-limit rejections name the limit and the reason.** The message says which tool refused, what the cap is, and what the cap buys — for example `merge_playlists pages every source before it writes: max 10 per call`, or the shared `each listed playlist is read in full, so this is a read-cost ceiling: one paged walk per playlist: max 10 per call`. The reason is a required argument of the shared list helpers, so no tool can inherit a cost claim its handler does not make: `check_playlist_following`, which batches ids into `GET /me/library/contains` requests rather than paging each playlist, names that instead.
- **The read cost is reported.** `merge_playlists`, `diff_playlists`, `overlap_playlists`, `playlist_fill_from_search`, and `playlist_expression_algebra` emit `requests_read` in `structuredContent` — the paged read requests the walk actually issued, counted where each request fires rather than derived from the row count, so a walk that ends on a short page still reports what it spent. `requests_read` is a TOTAL of the read phase, not one phase of it: `playlist_fill_from_search` counts its playlist metadata read and its existing-items walk as well as its search pages, and also reports the search-only figure as `search_requests_read` for readers who want to separate the two. Prose carries the same figure in `merge_playlists`, `diff_playlists`, `overlap_playlists` and `playlist_fill_from_search` (`Read cost: N paged read request(s) across M playlist(s).`); `playlist_expression_algebra` reports it in `structuredContent` only. A dry-run `merge_playlists` reports it too, because a preview pages every source for real and would otherwise understate the cost of the call it previews.
- The count is of *paged reads*, one per page. A 401-refresh or 429-backoff retry inside a single page read is not a second read, and a TTL-cached page is counted because the walk asked for it — the figure is what a caller can act on, not a socket-level byte count.

**Migration note (v2.0 → v3.0, #1287): the retired names are GONE, not deprecated.** AGENTS.md §5 promised "supported through 2.0, removed in 2.1"; 2.1 shipped with all eighteen still in the registry, so 2.1.2 was serving them alongside a `deprecation_note` promising a removal that had not been scheduled. The next release from that branch is 3.0.0, and the removal lands there.

The contract that replaced the old one:

- **No retired spelling appears in any tool's `inputSchema`.** The `legacyPlaylistListFields` / `legacyPlaylistPairFields` builders are deleted rather than left unused; nothing can re-add a field without also updating `RETIRED_PLAYLIST_INPUTS`.
- **A call carrying one is refused before any Spotify request**, with `kind: "validation"` and `reason: "retired_input"` — not `unknown_param`. The two are different claims: `unknown_param` says the server never had that name, while these names were published until 3.0 and the caller is following a notice this server served. The refusal names every retired field the call carried and the canonical replacement, and the tool error boundary answers it ahead of every handler, so no read is issued first.
- **`playlist_subtract` requires `base_playlist_id` again.** The positional form `playlists: [base, ...sources]` was on the same schedule and went with them; with it gone the schema itself refuses an omitted base instead of the handler inferring which playlist was meant.
- **The `deprecated_inputs` / `deprecation_note` mechanism is unchanged, not deleted.** It now carries only the deprecated TOOL NAMES (`pin_playlist` / `unpin_playlist`), which are a separate deprecation. A canonical call omits both fields, and no playlist-input call can produce them.

The per-tool retirement record is `RETIRED_PLAYLIST_INPUTS` in `src/shaping.ts` — one entry per tool, one alias pair or one alias list each, and the single place a retired name is written down. The tool-name aliases were left registered on purpose: retiring a tool NAME is a different change under §5 (it also drops the `unpin` `destructiveHint` OVERRIDES row), and their notice was corrected to stop dating the 2.1 removal rather than repeat it.

#### Full-sequence rewrite contract (#860)

`playlist_sort`, `playlist_shuffle`, `playlist_reverse`, `playlist_trim`, `playlist_union` (existing `target_playlist_id` only) and `playlist_subtract` (the `base_playlist_id` only) commit through one atomic `PUT /playlists/{id}/items` built from a URI-filtered list. Spotify returns a removed, relabelled or region-unavailable row with `item: null`, so that row carries no URI and a URI-based replace cannot restore it: the first PUT deletes it from the live playlist, and the counts reported afterwards come from the already-filtered list, so nothing in the response reveals the loss.

Each of these tools therefore **refuses before the first PUT** when the playlist being overwritten holds an unavailable row, naming the count, the 1-based position(s) (up to ten, with `…` beyond that) and `remove_unavailable_playlist_items` as the remedy. The refusal is a thrown error, not a soft `ok: false` result, and it fires ahead of the elicitation gate — a prompt can name a loss and still be approved, which is not consent worth acting on for an irreversible row deletion. Nothing is written, and the caller's existing confirmation gate is unchanged for playlists with no unavailable rows.

Two consequences callers can observe:

- `dry_run: true` still renders its plan, and appends the refusal beneath it. A preview that promised a write the apply path throws on would be the same false claim in a new place.
- `playlist_union` and `playlist_subtract` dry-run payloads gain `would_refuse`; where the plan would otherwise prompt, `would_confirm` is now `false` in that state. `target_unrepresentable` / `base_unrepresentable` are unchanged and still report the count on the preview.
- A union that creates a new playlist (`target_name`) is not gated: no live rows are being destroyed.

**Migration note (breaking, v2.0):** a call that previously committed over a playlist with unavailable rows now fails. The tool names the count and the positions; run `remove_unavailable_playlist_items` (or `playlist_health_check` to find them) and retry.

#### The overwrite gate on the set-algebra family (#872)

`playlist_union` (into an existing `target_playlist_id`), `playlist_subtract` and `playlist_trim` each rewrite their target through that same atomic replace, so every row the incoming list does not contain is DELETED. Each measures what the overwrite costs before the first PUT and asks through elicitation, unless it can prove nothing is lost. The prompt names the overwrite itself (`Overwrite ALL <n> existing item(s) with <m> URI(s)`), how many rows the write would delete, how many existing rows carry no URI and therefore cannot be written back, and — when the item walk did not reach the end of the playlist — that the true impact may be larger.

`playlist_trim` was the one that gated on nothing. Its description said "Trim playlist to N items (keep first/last/random)" and never named the deletion; it asked nothing before removing every row outside the kept set; and its no-op test compared the URI-filtered walk against `keep`, so a 20-row playlist read under a 12-row walk cap was `12 <= 12` — the tool reported an already-trimmed playlist that still held all 20 rows, and the caller was left believing a trim it never ran had nothing to do. It now reads the playlist's row total the way the other two already did, claims the no-op only for a whole read, and gates every other trim. The no-op result now reports the playlist's row count rather than the filtered walk, and carries the same `ok`/`unchanged` shape `playlist_union` and `playlist_subtract` return for their own no-ops. `playlist_subtract`'s description, which said it "removes" tracks from the base without saying it rewrites every row of it, now says so; its gate, its prompt and its refusal shape are unchanged.

What #872 found already working, and left alone: `playlist_union` measures the target before the prompt, refuses the target-change race, and is ungated only when it creates a new playlist (`target_name`, which destroys no live rows); `playlist_subtract` measures the base the same way. All three now re-read the playlist after the prompt and refuse the write if it changed, so a plan no operator saw is never committed.

A refusal here is a **result**, not a write, and carries the same payload as every other gated write in the server: `declined`/`cancel` → `{ok: false, cancelled: true}`; a prompt that fails on the wire → `reason: "elicitation_failed"`; a client that never advertised elicitation → `reason: "confirmation_unavailable"`. `SPOTIFY_MCP_CONFIRM=never` remains the only bypass, and the value must be exactly `never`. An operation that provably deletes nothing never asks.

**Migration note (breaking, v2.0):** `playlist_trim` now asks before it deletes, and a client that cannot prompt is refused rather than served. Automation that trims unattended sets `SPOTIFY_MCP_CONFIRM=never`; everything else sees the prompt. A trim that used to report "nothing to trim" on a playlist larger than the walk cap now asks instead, because that playlist did have rows to lose.

#### Truncated-read refusal on the single-playlist rewrites (#1310)

`playlist_sort`, `playlist_shuffle`, `playlist_reverse` and `playlist_trim` build the URI list they replace with from a walk bounded by `SPOTIFY_MCP_FETCH_ALL_CAP` (default 500). On a playlist larger than the cap the rows past it are **absent from the PUT**, and an absent row is a deleted row: before this, a 600-row playlist came back 500 rows long and the tool reported `Reversed 500 item(s)`. The count in that sentence was the cap, not the playlist.

Those tools therefore **refuse before the first PUT** when the walk did not reach the end, naming the cap, the number of rows read, the first unread position, and — when Spotify's `items.total` was readable — how many rows past the cap went unread. The remedy is `SPOTIFY_MCP_FETCH_ALL_CAP`, not `remove_unavailable_playlist_items`; the two refusals are worded differently so a caller can tell which one it hit.

`playlist_trim` is refused for `keep_which` `last` and `random` only, and that asymmetry is deliberate. `first` takes a prefix of what was read, which is the playlist's real prefix, and the unread tail is exactly the region a trim deletes anyway — so #872's overwrite gate already discloses the partial read (`only N of M existing row(s) could be read, so the true impact may be larger`) and gates the write, and refusing there would reject a correct, disclosed and consented operation. `last` and `random` need rows the walk never read: their kept set is a *different* set, not a smaller correct one, and the prompt can only say how much is deleted, never which rows survive. Disclosure cannot repair a wrong answer, so those two refuse ahead of the gate.

The walk is bounded, not complete-or-not, so the refusal fires in the second shape too: a page that returns fewer items than the requested `limit` is the normal end-of-data signal, but when the server's own `total` still counts more rows it is not the end. A walk that reads 50 of 600 rows that way is refused as firmly as one that stops at the cap.

What did **not** change, deliberately:

- `playlist_union` and `playlist_subtract` still **disclose** an incomplete read rather than refusing it. They already put the shortfall in the confirmation prompt, and every destructive impact they compute goes through a mandatory elicitation the caller cannot skip, so there is a place for the disclosure to land. A refusal there would remove a prompt that was already doing the honest thing.
- The #860 unavailable-row guard is unchanged and still fires. On a playlist that is BOTH truncated and holds unavailable rows, the truncation refusal comes first: `contains 1 unavailable item(s)` is a count derived from an incomplete read, and leading with it is the same failure the issue is filed on. The lower-bound wording survives on the union/subtract path, which is the only place a truncated count is still shown to a human.
- No confirmation gate was added, removed or relaxed. #872's mandatory overwrite gate on `playlist_trim` is untouched and still runs for every non-no-op trim, `first` included; where #1310 refuses (`last`, `random`) it throws ahead of that gate, before any write. `playlist_sort`, `playlist_shuffle` and `playlist_reverse` still have no prompt at all, so for those three the refusal is the only place the shortfall could have been disclosed.

**Migration note (breaking):** a call that previously committed over a playlist larger than `SPOTIFY_MCP_FETCH_ALL_CAP` now fails. Raise the cap above the playlist's row count (or split the playlist) and retry. A `dry_run` still renders its plan with the refusal appended.

**Known gap, closed in #1362 — the `swarm4_*` slice.** This paragraph used to record that `swarm4_playlists.ts` was the one commit path the refusal did not cover. It now does. Its `fetchAllItems` had the same bounded walk as `playlist_sort`, returned a bare `PlaylistItemObject[]` and therefore kept no verdict, so `assertRewritable` there could not see one and a `swarm4_*` rewrite of a playlist larger than the cap deleted the unread tail while reporting the cap as a count. It walks with `getAllPagesWithTruncation` and the same `cap + 1` probe now, and carries the verdict on the loaded playlist.

The refusal is enforced at `atomicReplace`, the single write choke point, which now takes the whole `LoadedPlaylist` rather than a bare target id: all ten of its call sites build `uris` from `p.items` and target `p.id`, so that is the one point where "the read was whole" and "the write is about to happen" are provably the same playlist, and a tool added later inherits the guard by calling the function. The same predicate also runs per tool, ahead of the `dry_run` branch — not redundantly, but because a preview issues no write and is the only enforcement a dry run can reach. Without it a `dry_run` renders `would reverse 500 item(s)` over a 600-row playlist, which is the same false count as a commit, one step earlier.

The affected tools are `playlist_flip_order`, `playlist_resequence`, `playlist_seed_shuffle`, `playlist_rotate`, `playlist_move_block`, `playlist_swap_positions`, `playlist_dedupe_advanced`, `playlist_remove_artist`, `playlist_keep_artist` and `playlist_filter_runtime`. `playlist_balance` is deliberately not among them: it creates new playlists and leaves the source untouched, so a truncated read there deletes nothing — which is also why refusing is the wrong answer there, and why it **discloses** the partial split instead (#1388, below).

#### Bounded verdicts in `remove_unavailable_playlist_items` (#1311)

The tool this contract names as its remedy walked to the same cap and then reported on the whole playlist as if it had seen all of it: with an unavailable row at index 550 of a 600-row playlist it answered `ok: true`, `verification: "verified"`, `total: 500`, and the prose `No unavailable items in playlist … (500 tracks)`. The post-write re-read was bounded the same way, so `verification: "verified"` meant "the first 500 rows are clean".

`verification` is now a three-valued verdict, and the walk carries the same `cap + 1` probe the rewrites use:

| Value | Meaning | `ok` |
|---|---|---|
| `verified` | The whole playlist was read before and after the write, and no unavailable row is left. | `true` |
| `partial` | A walk stopped at the cap, so the verdict covers the rows that were read and nothing else. Rows from `unread_from_position` onward are unverified, and unavailable rows past the cap may still be present. | `false` |
| `failed` | The whole playlist was read and unavailable rows are still there — a real negative result. | `false` |

`partial` is deliberately not `failed`: the re-read did not find unavailable rows it never saw. A payload carrying `partial` also gains `truncated: true`, `scan_cap`, `rows_read` and `unread_from_position`; the prose names the cap and the position the unread region starts at. `remove_unavailable_playlist_items` is unchanged on playlists at or below the cap — those still get a real `verified`. A bulk removal over a truncated walk adds one line to the confirmation prompt saying so; the gate itself is unchanged and still fails closed.

#### Truncated-read refusal on the `swarm4_*` rewrites (#1362)

The ten `swarm4_*` tools that commit through one atomic full-content replace had the #1310 fault and none of the #1310 guard. They build their URI list from the same bounded walk, but `fetchAllItems` returned a bare `PlaylistItemObject[]`, and a bare array cannot distinguish "this is the whole playlist" from "this is its first `cap` rows". So the verdict could not be inferred by the guard that was already there, and it was not: on a 600-row playlist at the default cap of 500, `playlist_flip_order` returned the playlist 500 rows long and reported `Reversed "…" (500 item(s))`. The 100 rows past the cap were absent from the `PUT`, and an absent row in a full-content replace is a deleted row.

They now behave as the `playlists.ts` rewrites do, with the same wording and the same remedy. The walk keeps its verdict and the refusal names the cap, the rows read, the first unread position and — because `loadPlaylistFull` already fetches playlist metadata — how many rows went unread. The refusal is a **refusal, not a warning**, and the asymmetry with `playlist_union` is deliberate rather than an inconsistency: a partial-read warning is acceptable only where something else stands between the short read and the damage, which is what a mandatory elicitation on every destructive impact is. None of these ten has such a gate on this path, and their write is a full replace, so there is no partial-damage outcome to warn about — only rows the caller still had when the call returned and would not have afterwards. The rewrite is also *computed* from the rows that were read, so on a truncated read the answer is a different answer rather than a smaller one: a reversal of the first 500 rows, a dedupe that never saw rows 501–600, a runtime filter that kept a track because the tracks that should have displaced it were past the cap.

Two enforcement points, deliberately, and they are not the same check twice:

- `atomicReplace` — the single write choke point — now takes the whole `LoadedPlaylist` rather than a bare target id and refuses there, before the first `PUT`. All ten of its call sites build `uris` from `p.items` and target `p.id`, so that is the one place where "the read was whole" and "the write is about to happen" are provably the same playlist, and a tool added later inherits the guard by calling the function rather than by remembering it.
- The same predicate also runs per tool ahead of the `dry_run` branch, which is the only enforcement a dry run can reach: a preview issues no write, and without it a `dry_run` renders `would reverse 500 item(s)` over a 600-row playlist — the same false count as a commit, one step earlier. `swarm4_*` already refused the sibling #860 unavailable-row fault on the `dry_run` path for the same reason.

`playlist_balance` is the one tool in the slice this refusal does not cover, and the reason is the one thing it does not do: it creates new playlists and leaves the source untouched. It is covered instead, by disclosure — see the next section.

**Migration note (breaking):** a `swarm4_*` rewrite of a playlist larger than `SPOTIFY_MCP_FETCH_ALL_CAP` now fails instead of deleting the unread tail. Raise the cap above the playlist's row count and retry. Tool descriptions, schemas, annotations and the registry are unchanged — this is a behavioural refusal on a path that previously destroyed data, not a new tool or a new argument.

#### Bounded-read disclosure on `playlist_balance` (#1388)

`playlist_balance` reads the source with the same bounded walk as its ten siblings — `fetchAllItems`, `maxItems: cap + 1`, clipped back to `fetchAllCap` — and since #1362 it has carried the walk's verdict on the `LoadedPlaylist`. It just never read it. It split what it read, wrote the parts to new playlists, and reported the count of the read as though it were the count of the playlist: a 600-row playlist at the default cap of 500 came back as three parts holding 500 rows, `ok: true`, and nothing anywhere in the response saying a hundred rows had never been fetched.

That is the #6 shape — a correctly named payload field that lies about its value — and it is the one the two obvious fixes both fail:

- **Refusing** would be the consistent choice, and it is wrong here. The refusal in `rewritable.ts` is argued on irreversibility: "there is no partial-damage outcome to warn about, only rows the user still had when the call returned and would not have afterwards." Nothing in that sentence is true of this tool. There is no full-content replace for a short read to be mistaken for, the source is intact when the call returns, and re-running at a higher cap costs the caller nothing but a re-read. Refusing would also mean a caller who cannot raise `SPOTIFY_MCP_FETCH_ALL_CAP` — a hosted server, a fixed environment — could never split a playlist larger than the cap at all. That is a permanent functional hole bought with no safety.
- **Disclosing while leaving `items: n` alone** is what the tool already did, and it is the field the issue is filed on. A caller reading `items: 500` from a 600-row playlist has no way to know. The field is gone rather than redefined.

So it discloses, and the disclosure is the caller's to act on:

| Field | Meaning |
|---|---|
| `rows_read` | Rows the walk returned, and the only ones the parts can contain. |
| `reported_total` | The source playlist's own `items.total`, or `null` when Spotify's count was not readable. Never the read size echoed back — that substitution is the fault one layer in. |
| `truncated` | The walk stopped short of the end of the source. |
| `truncated_by_cap` | The cap is the reason, as opposed to a walk that ended on a short page while the server's `total` still counted rows. Present only when `truncated`. |
| `fetch_all_cap` | The ceiling that was in force. Present only when `truncated`, because a whole read was not capped. |

The coverage fields ride on the `ok: false` too-few-items return as well, so no branch of the tool reports a count the walk did not produce. The prose leads with `PARTIAL SPLIT — …` in the dry run and in the commit, above `describeDryRun`'s own header rather than inside its change list, and it names the ceiling, the rows read, the shortfall, and the remedy. A preview rendering `Would affect 500 items:` for a 600-row playlist is the same false count as a commit, one step earlier.

`ok` stays `true` on a truncated split, and that is not a hedge: the three playlists exist, the source is untouched, and the operation succeeded. `truncated` beside it is the scope of the answer, not a failure of the call. This is `merge_playlists`' shape (`truncated` / `truncated_by_cap` / `rows_read` / `reported_total`, `ok: true`) applied to the other bounded non-destructive read in the tree; `remove_unavailable_playlist_items` uses `ok: false` there because its `verification` is a claim about its own effect, which a partial re-read cannot support.

The tool description changed with it, and that is the part a host reads before the call. `interleave (round-robin deal, so every part samples the whole span)` was false on a truncated read — the deal sampled the *read's* span — so the description now says the span is what the read returned, names `SPOTIFY_MCP_FETCH_ALL_CAP`, and points at the coverage fields. A description that is only true on a whole read has to say which read it means.

**A playlist at or below the cap is unchanged**: `truncated: false`, `rows_read === reported_total`, no `fetch_all_cap` or `truncated_by_cap` in the payload, and no shortfall sentence in the prose. A caller must be able to tell the two apart from the response alone, in either direction.

**Not a migration:** no call that succeeded before fails now, and no call that produced a complete answer produces anything different. What changes is that a partial answer says so. The module's schema baseline moved — description text only, tool count unchanged. The authoritative figures are the generated `schema-budget-table` in `docs/schema-budgets.md`, which is regenerated from the live registry on every change; a hand-copied pair of numbers here is only a second place for the figure to be wrong, and this module is shared with `playlist_clone_snapshot`, so any sibling change moves it again.

#### `merge_playlists`
Merge several source playlists into one. Duplicates are dropped by track URI (falling back to track ID), keeping the **first-seen order across sources**; the merged URIs are then added in batches of 100. Passing `target_playlist_id` APPENDS — the target is never cleared — while `new_name` creates a fresh playlist first.

**Inputs:** `playlists` (source references, 1–10; the `sources` spelling was removed in v3.0), plus exactly one of `target_playlist_id` (append into an existing playlist) or `new_name` + `public` (create one). `limit` (source page size, 1–100), `scan_cap` (maximum source rows to scan), `dry_run`, `response_format`, `max_results`.

**Source read phase (#902).** Every source is walked concurrently (`Promise.all`), so all of their first pages are in flight before any source's second page, and the walks are consumed in the order the caller listed them — interleaving the requests does not reorder the merge. Each item page is requested with the projection `items(item(uri,name)),limit,next,total`, because only `uri` and `name` are read; a full track object would drag nested `album`/`artists` payloads across the wire and into memory for nothing. `limit` and `total` stay in the projection because the walk's end-of-data and truncation tests read them — dropping them would change which rows a merge sees.

**The cap is per source, so the combined total is a sum (#902).** `scan_cap` bounds each source independently, so a merge reads up to `scan_cap × sources` rows. Every walk's verdict is therefore accumulated across sources before anything is reported: `rows_read` is the sum of rows actually read, and `reported_total` is the sum of the totals Spotify itself reported for each source. A four-source merge of 500-item playlists under a 100-row cap reads 400 of 2,000 and says so — naming the cap alone would understate the shortfall by the source count and read as though the merge had been whole. When any source reports no `total`, `reported_total` is `null`: the combined size is unknown, and it is never rounded down to `rows_read`. `truncated` is true when any source came back short, and `truncated_by_cap` distinguishes the cap being the reason from a walk that ended before the last row the server reported. The same sentence renders in prose for the dry run, the successful write, and `diff_playlists` / `overlap_playlists`, so a preview and its outcome cannot describe one walk differently.

**Returns:** `target_playlist`, `created_new_playlist`, `playlists` (the source references), `added`, `duplicates_skipped`, `unavailable_items_skipped`, `rows_read`, `reported_total`, `requests_read` (source item pages actually fetched, measured per page rather than inferred from the row count), `batches_sent` (write requests), `snapshot_id` when Spotify returned one, plus `truncated`/`truncated_by_cap`/`scan_cap`.

#### `get_playlist`
Get a playlist's metadata and its items. Makes two calls: `GET /playlists/{id}` for metadata, then `GET /playlists/{id}/items` for the track/episode list.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `playlist_id` | string | yes (runtime) | Playlist ID. `id` is a back-compat alias (see the single-identifier row in the alias table above) |
| `id` | string | no | Alias for `playlist_id`, matching the rest of the playlist family. Passing both is allowed only when they agree, and conflicting values fail before any Spotify request |
| `limit` | number | no | Items per page, 1–100. Default: 50 |
| `offset` | number | no | Pagination offset for items |
| `market` | string | no | ISO 3166-1 alpha-2 country code — relinks tracks to that market and flags unavailable ones. Forwarded to **both** the metadata read and the item pages |
| `fields` | string | no | Comma-separated response fields to keep, e.g. `total,items(track(name,uri))`. Forwarded to **both** calls |
| `additional_types` | string[] | no | Item types to include beyond the default `track`, e.g. `["track","episode"]`. The schema is a closed two-value enum — `track` and `episode` only, and an array, so the bare string `"track,episode"` is rejected. The server joins the array with commas for the wire. Forwarded to **both** calls |
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
| `playlist_id` | string | yes (runtime) | Playlist ID. `id` is a back-compat alias (see the single-identifier row in the alias table above) |
| `id` | string | no | Alias for `playlist_id`, matching `get_playlist`. Passing both is allowed only when they agree, and conflicting values fail before any Spotify request |
| `limit` | number | no | Items per page, 1–100. Default: 100 |
| `offset` | number | no | Pagination offset. Default: 0 |
| `market` | string | no | ISO 3166-1 alpha-2 country code — relinks tracks to that market and flags unavailable ones |
| `fields` | string | no | Comma-separated response fields to keep, e.g. `total,items(track(name,uri))` |
| `additional_types` | string[] | no | Item types to include beyond the default `track`, e.g. `["track","episode"]`. The schema is a closed two-value enum — `track` and `episode` only, and an array, so the bare string `"track,episode"` is rejected. The server joins the array with commas for the wire |

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
| `playlist_id` | string | yes | Playlist ID |
| `uris` | string[] \| { uri, positions }[] | yes | URIs to remove; use `{ uri, positions }` to target specific occurrences of a repeated URI (the only way to de-duplicate repeats). Max 100 entries. |
| `snapshot_id` | string | no | Apply the removal against this playlist version instead of the latest |

---

#### `update_playlist`
Update a playlist's name, description, or visibility.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `playlist_id` | string | yes (runtime) | Playlist ID. `id` is a back-compat alias (see the single-identifier row in the alias table above) |
| `id` | string | no | Alias for `playlist_id`. Passing both is allowed only when they agree, and conflicting values fail before any Spotify request |
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
| `range_start` | number | yes | Index of the first item to move. 0-based index into the playlist's current item order (0 = the first item). |
| `range_length` | number | no | Number of items to move. Default: 1 |
| `insert_before` | number | yes | Index to insert the range before. 0-based index into the playlist's current item order (0 = the first item). |

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
Find duplicate tracks in a playlist under one published rule. `match_by` selects which, and defaults to `uri` (exact repeats). Walks every page of items via `client.getAllPages`; reported positions are 0-based API indexes that can be fed straight back into `remove_from_playlist`'s `{ uri, positions }` entries.

**Inputs:** `playlist_id` (string, required), `match_by` (see [§4.0.5](#405-matching-vocabulary-duplicates-and-artist-credits-885); `uri` | `name_artist` | `name`, default `uri`), shared response fields (`response_format`, `max_results`)

**Returns:** per group: track label, occurrence count, the rule that produced the group, the URIs involved, and 0-based positions; structuredContent includes `scanned` and the applied `match_by`. The post-removal verification re-applies the same rule, so "no duplicates remain" is a statement about the rule the caller asked for.

Before #885 this tool counted an exact-URI group and a relinked group as two separate groups and reported no rule, so the same playlist yielded a different count here than in `playlist_health_check` or `playlist_dedupe_advanced`.

---

#### `search_within_playlist` (#731)
Text search inside one playlist, as a client-side filter over the rows the walk read. For a narrow query that is cheaper than paging `get_playlist_items` yourself; the trade-off is that the filter can only ever see the window the walk read, so the payload says how much of the playlist that was. Text is matched (case-insensitively) against the item name, artist names, album name and show name. `kind` narrows a mixed playlist — the same `/playlists/{id}/items` rows carry both shapes, and before this tool existed an agent looking for episodes had to walk the whole playlist by hand.

The walk uses `get_playlist_items`' cap and its truncation verdict: `SPOTIFY_MCP_FETCH_ALL_CAP` bounds the walk, and a scan that hits the cap says so rather than reporting a narrow result as a complete one.

**Inputs:**
| Field | Type | Required | Description |
|---|---|---|---|
| `playlist_id` | string | yes (runtime) | Playlist ID. `id` is a back-compat alias (see the single-identifier row in the alias table above) |
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

**Inputs:** `playlist_id` (string, required at runtime) — the canonical name; `id` is a back-compat alias (see the single-identifier row in the alias table above). Passing both is allowed only when they agree.

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

**Inputs:** `ids` (string[], required, max 50 — bare artist IDs or `spotify:artist:` URIs)

**Returns:** array of booleans matching input order. Uses `GET /me/library/contains` with one `spotify:artist:<id>` URI per input, in input order. `GET /me/following/contains` was removed in February 2026; `/me/library/contains` is its named replacement and is not registration-gated. A response that is not an array, is not the same length as the request, or holds a non-boolean is rejected rather than defaulted to "not followed".

#### Retired: `follow_artists`, `unfollow_artists`

**Removed** (breaking, #638). Both targeted `PUT`/`DELETE /me/following?type=artist`, which Spotify removed in February 2026 **with no replacement**. `PUT`/`DELETE /me/library` accept track, album, episode, show, audiobook, user and playlist URIs — not `spotify:artist:` — so a `PUT /me/library?uris=spotify:artist:<id>` would look migrated and follow nothing. Following an artist is no longer expressible over this API.

**There is no migration for the write.** `check_following_artists` still answers the read half, and `get_followed_artists` / `following_analytics` still list the followed set. A caller that needs to change follow state must do it outside this server.

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

**Returns:** name, authors, narrators, description, edition, total_chapters, media_type, URI, and a ten-row chapter preview. `publisher` was removed from audiobook payloads in February 2026 and is omitted. When the book holds more, the card states how many chapters of how many it showed and points at `get_audiobook_chapters`.

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

**Returns:** display name, user ID, URI, profile image URL, external URL. Uses `GET /users/{user_id}` (no authentication-scoped data — only public fields). Spotify removed `followers` from user profiles in February 2026, so on a current registration there is no follower count to report and the line is omitted rather than printed as `0`; a grandfathered registration that still sends one has it printed. The endpoint itself was removed in the same changelog, so a current registration gets a 403 that names the grandfathering requirement instead of a profile.

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

Second upstream: long-range listening history, cross-range top lists, and taste aggregates from the stats.fm public API (`https://api.stats.fm/api/v1`, no auth). Network-backed stats.fm tools are read-only; the local feedback tools mutate only a bounded local sidecar, never the network. They pair with the Spotify write tools above (see `docs/cookbook.md` recipe 1 and `docs/taste.md`). Setup, ranges, limits, and privacy: `docs/statsfm.md`.

**Identity.** stats.fm has no OAuth: a user-scoped read needs only a public profile id. There is now **one** spelling, `statsfm_user`, declared by all 43 user-scoped stats.fm tools (25 in `statsfm.ts`, 7 in `statsfm_taste.ts`, 10 in `taste_composites.ts`, 1 in `taste_playlist.ts`); `user_id` is a **deprecated alias** kept callable for one release and removed in v2.2 (AGENTS.md §5). Both accept an id or a customId, and both default to `STATSFM_USER_ID` when it is set. Precedence is explicit argument > `STATSFM_USER_ID` > error, and the error names the canonical field and the variable (`no stats.fm user id: pass statsfm_user or set STATSFM_USER_ID`). With neither, a user-scoped call fails rather than defaulting to a profile: a guessed id returns a well-formed answer about the wrong account, which is worse than a refusal. Catalog lookups, `statsfm_search` and `statsfm_genre_artists` take no identity argument, and `statsfm_record_feedback`/`record_feedback` is local-only.

Sending both spellings is accepted only when they agree after trimming; two different values are refused as `validation` / `conflicting_input` **before any stats.fm request**, with both field names in the message and in `error.param`. A call that sends the legacy name — alone, or beside an agreeing canonical one — carries `deprecated_inputs: ["user_id"]` and a one-line `deprecation_note` in `structuredContent`, and the same note in the text. The two Spotify `get_user_*` tools keep their own `user_id` (a Spotify id, not a stats.fm one) and are outside this contract.

**On the wire the name is a path segment, not a parameter.** Every user-scoped read is `GET /users/{id}/…` — verified against the official `statsfm.js` client, whose `UsersManager` builds exactly those paths and whose `SearchManager` passes the id as the `query` parameter of `/search`. The MCP argument name is a surface concern only; renaming it changes no upstream request.

Three registration keys are default ON: `statsfm` (endpoint tools in `src/tools/statsfm.ts` over `src/lib/statsfm-client.ts`), `taste` (canonical taste-intelligence tools in `src/tools/statsfm_taste.ts`), and `tastecomposites` (composite tools in `src/tools/taste_composites.ts`). Structured failures use `{kind, reason, fix, text, status?, retryAfterSec?}`: stats.fm 401 maps to `auth`, 403 to `forbidden`, 404 to `not_found` with a bounded `statsfm_resource_not_found` reason, 429 to `rate_limited` with `retryAfterSec`, and 503 to `unavailable`. No `PRIVATE_PROFILE` code is emitted.

#### Endpoint tools (`statsfm_*`)

`statsfm_recent_streams` also takes a named `range` of `today`|`week`|`month`|`year`|`lifetime` (#730), resolved to **UTC** boundaries (`today` = since 00:00 UTC; `week` = since Monday 00:00 UTC, ISO; `month` = since the 1st; `year` = since 1 January; `lifetime` = unbounded) and applied to the rows in hand. The lower bound is inclusive, the upper bound exclusive, and a bucket has no upper bound. An explicit `after`/`before` **wins**: it replaces the bucket's edges, and a bucket supplied alongside one explicit bound fills only the edge the caller left open. The applied window is echoed in `structuredContent.range_resolved` (`requested`, `applied`, `after`, `before`, `timezone: 'UTC'`, `label`) and in prose, alongside `returned_before_window` / `returned_after_window` / `excluded_by_window` / `unreadable_timestamps`. **This window is a local filter, not an upstream one**: `/users/{id}/streams/recent` ignores `after`, `before`, `limit` and `offset` (live-verified 2026-09-27 — a bound in the year 2100 and one in 2001 both return the unfiltered page; the same bounds *are* honoured on `/users/{id}/streams`, `/users/{id}/top/*` and the per-entity `/stats` aggregate, so this is a per-route fact), so the buckets are enforced on the returned rows while the bounds still go on the wire for forward-compatibility. A row whose play time cannot be read is excluded and counted in `unreadable_timestamps`, never counted into the window. Because the route returns a fixed unpaged recent page, a bucket wider than that page is reported with `page_may_not_cover_window: true` plus `page_oldest` / `page_newest`, so a filtered page is never read as a complete count for the window. This `range` is deliberately **not** the shared `statsfmRangeSchema`: that enum is forwarded verbatim to a stats.fm query parameter which answers `400 {"message":"invalid range"}` for `year` and every other bucket value, so merging them would advertise a value that fails on every ranking call.

`statsfm_resolve_user` — customId/display name → canonical userId (always call first). `statsfm_top_tracks` / `statsfm_top_artists` / `statsfm_top_albums` / `statsfm_top_genres` — ranked lists for `range` = lifetime|weeks|months (lowercase only), paged `limit` ≤ 100 + `offset`. `statsfm_top_tracks_from_artist` / `statsfm_top_albums_from_artist` / `statsfm_top_tracks_from_album` — scoped tops. These three routes (`/users/{id}/top/artists/{artistId}/{tracks,albums}`, `/users/{id}/top/albums/{albumId}/tracks`) **ignore `limit` and `offset` upstream** — their swagger entry declares no parameters at all, and live-verified 2026-09-27 the bodies for `limit=1`, `limit=5`, `limit=1000` and `offset=40` are byte-identical to the unbounded read. The window is therefore applied server-side, and `pagination.total` is the whole ranking's cardinality rather than the page length. The routes also cap the response at 100 rows, and the envelope carries no `total`, so a 100-row response is a **floor and not a count**: it reports `total: null` with `total_unreadable: true` and `received: 100`, and the prose says "at least 100" rather than asserting a size that was never read. `limit`/`offset` are still sent on the wire, so a stats.fm that starts honouring them will not cause a double slice. The four flat `/users/{id}/top/{kind}` routes are unaffected and keep their upstream paging. `statsfm_recent_streams` — newest-first (API returns a fixed 50, `limit` ignored upstream). `statsfm_now_playing` — live track + device, null when idle. `statsfm_track_stats` / `statsfm_artist_stats` / `statsfm_album_stats` — stats.fm's own stream total for one entity, read from the per-entity aggregate at `/users/{id}/streams/{tracks|artists|albums}/{entityId}/stats`; `statsfm_track_date_stats` / `statsfm_artist_date_stats` / `statsfm_album_date_stats` are the same read narrowed to an `after`/`before` window, which is forwarded to the aggregate. These return a **measured** total, not a page: `count` and `totalMs` are stats.fm's own figures for the whole entity (`avgMs` is derived from those two, and is `null` when `count` is 0 — a mean over no plays does not exist, and `0` would read as a measurement of a play), with `source`, `scope` (`lifetime`, or the window in ISO edges), `lifetime` and `cardinality` alongside. An aggregate that arrives without a usable `count`/`durationMs` fails the call rather than reading as 0. The per-entity aggregate answers `{ items }` for tracks and artists but `{ item }` for albums. `limit` sizes the accompanying play sample only — read from the entity-scoped `/users/{id}/streams/{seg}/{entityId}` route, server-filtered, newest-first, `offset` ignored upstream — and never moves the total; it is reported as `sample_limit` / `sample_returned` / `sample_truncated` / `sample_oldest` / `sample_newest`, so a sample's span is never read as the entity's whole history. A play sample that cannot be read leaves the total standing and records `sample_unreadable_reason`. Resolve a Spotify ID to a stats.fm entity id via `externalIds.spotify[]` on the catalog tools. `statsfm_streams_stats` — totals + percentiles + cardinality (singular object, not an array). `statsfm_search` — users/tracks/artists/albums. `statsfm_recaps` — weekly/monthly/seasonal/yearly/artist/time-capsule digests. `statsfm_catalog_track` / `statsfm_catalog_artist` / `statsfm_catalog_album` — catalog lookup. `statsfm_genre_artists` — genre drill-down (`genre.tag`, not `.name`). `statsfm_charts_tracks` / `statsfm_charts_artists` / `statsfm_charts_albums` / `statsfm_charts_users` — honest compositions over verified user endpoints (the public API exposes no global charts endpoint). `statsfm_friends` / `statsfm_friend_count` / `statsfm_records_artists` — social + records.

#### Taste-intelligence tools (`statsfm_*` canonical names; `taste`/`tastecomposites` keys)

Canonical tools are `statsfm_taste_profile`, `statsfm_artist_affinity`, `statsfm_exposure_check`, `statsfm_listening_eras`, `statsfm_listening_sessions`, `statsfm_forgotten_favorites`, `statsfm_taste_recommendations`, and `statsfm_record_feedback`. These eight are the only names this module registers. `statsfm_record_feedback` stores local-only verdicts (love/like/mixed/boring/dislike) and never touches the network. Since #905 the store is a capped sidecar (`<SPOTIFY_MCP_DATA_DIR>/taste-feedback.json`, default `~/.spotify-mcp`), not process memory, so verdicts survive a restart.

**The legacy `taste_*` names were retired in v3.0 (#908).** `taste_profile`, `artist_affinity`, `exposure_check`, `listening_eras`, `listening_sessions`, `forgotten_favorites`, `taste_recommendations`, and `record_feedback` were each a second registration of the tool above it: same zod params, same handler, description differing only by a suffix. Eight duplicate rows in every host's context bought no capability and gave the model a coin flip to make between two behaviourally identical tools. They no longer appear in `tools/list`. A call naming one is refused with `kind: "unknown_tool"`, `reason: "retired_tool_alias"`, and a `fix` that names the canonical replacement. Setting `SPOTIFY_MCP_LEGACY_ALIASES=1` restores dispatch for one release — the rewrite happens in the CallTool boundary, so the names cost nothing in the payload while the window is open, and it is inert unless the `taste` toolset is registered too.

It is bounded three ways, because no one bound is sufficient alone: one record (`subject` ≤ 200 chars, `note` ≤ 500, everything else an enum or a timestamp), a record count (`SPOTIFY_MCP_TASTE_FEEDBACK_MAX_ENTRIES`, default 500), and a byte size (`SPOTIFY_MCP_TASTE_FEEDBACK_MAX_BYTES`, default 1 MiB). Eviction is oldest-first until all three hold, and the lifetime `recorded`/`evicted` counters are persisted so a capped store never reads as an empty one. Retention is a ring buffer, not a TTL: a TTL cannot bound a store an agent fills within one session, while the count cap also bounds the read response.

#### Wave-2 composite tools (`taste_*`; `tastecomposites` key)

Ten composites register in `src/tools/taste_composites.ts` and an eleventh, `taste_to_playlist`, in `src/tools/taste_playlist.ts` — split because it is the one writer in the family (it creates a Spotify playlist) and so carries its own `readOnlySafe: false` manifest row. The eleven rows below are that whole surface, measured by registering both modules (`docs/wave2-composites.md` is the per-tool contract). Three other `taste_*` names are deliberately absent: `taste_shift_report` and `taste_checkpoint` are registered by `src/tools/analytics.ts` and `taste_checkpoint_diff` by `src/tools/exhaust2_misc.ts`, so they are not this key's tools and are not covered by the identity contract below — they read the Spotify account's own top lists, not a stats.fm profile.

`statsfm_user` is the identity argument on all eleven, and it is optional on every one: with neither the argument nor `STATSFM_USER_ID`, each of the eleven refuses rather than resolving an identity. The deprecated `user_id` alias is accepted here too, under the contract in the Identity paragraph above.

| Tool | What it returns |
|---|---|
| `taste_daily_brief` | Yesterday (or a given date): top-3 tracks, 2 revival picks, novelty share vs the lifetime core. |
| `taste_weekly_recap` | Week in review: stream count, top artists/tracks of the window, busiest day, novelty share. |
| `taste_listening_clock` | Day-part split (UTC), peak window, and a sequencing note for playlist order. |
| `taste_novelty_loyalty` | Loyalty-vs-novelty report: top-5 share, recent-outside-core share, and a verdict. |
| `taste_obsession_ladder` | Artists ranked by stream share, each with an exposure tier. |
| `taste_genre_bridge` | Picks spanning two genres, with evidence and risk per pick. |
| `taste_forgotten_bangers` | Lifetime tops missing from the recent sample, ranked with a revival pick. |
| `taste_diamond_rotation` | Mid-tier lifetime tracks (rank ~20–60) absent from recent streams. |
| `taste_era_playlist` | A listening era selected by window, as a representative track list. |
| `taste_revival_queue` | Ordered re-listen queue from forgotten favorites + dormant-affinity artists. |
| `taste_to_playlist` | Taste profile → Spotify playlist. Previews by default; writes only with `dry_run: false`. |

`action=list` takes an optional `limit` (default 20, max 500) and returns a bounded page of the newest verdicts plus `returned`, `retained`, `truncated`, the retained, recorded, evicted and cap counts; it no longer returns the whole store. A store that cannot be read is returned as `{ok: false, reason: 'store_unreadable', error}` with the corrupt bytes preserved at `<file>.corrupt[N]` (shared `src/sidecar.ts` policy, #839/#1051) rather than reset, and a write that cannot land is returned as `{ok: false, reason: 'store_unwritable', path, error}` rather than reported as a recorded verdict. Writes are atomic (unique temp file, `fsync`, `rename(2)`) and serialised, because the store is a single JSON document: an in-place rewrite that died mid-write would lose every record, not one line. `spotify_doctor` reports both this store and the mutation-history ledger's sizes, cap and record count.

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

**Scope of the store, per account (#1364).** The store is also **per account**: a receipt is looked up as the account that is acting now, and an id minted under a different account on the same machine is a miss, not an attestation about this one. Both halves of the store are partitioned — the in-process `Map` and, when persistence is on, `receipts.<profile>.jsonl` — because the `Map` alone is the store in the default configuration, so a partitioned path with a shared `Map` would have left the default configuration exposed. A receipt is an undo **capability**, and redemption applies the recorded inverse to whatever library the session is currently acting on, so an id that resolves across accounts is an authority transfer rather than a stale-cache surprise. `undo_last_mutation` scans the acting account's receipts only, and `receipt_lookup` and `undo_preview` do the same.

The account key is the **token file**, not Spotify's `account_id`: reading `account_id` costs a live `GET /me` and is allowed to come back unreadable, and a store keyed on a value that can be missing is a store that silently merges accounts. The default account — no profile, the plain `tokens.json` — keeps the un-keyed `receipts.jsonl`, so an install that has been running this server reads and writes the file it already has; a named profile gets `receipts.<profile>.jsonl` and starts empty.

#### `undo_mutation` / `undo_last_mutation`

`undo_mutation` takes `receipt_id` and inverts **that** receipt. `undo_last_mutation` takes no id: it scans the store newest-first and takes the first entry that is both a reversible kind (`playlist_items`, `library`) and carries at least one URI. A newer metadata receipt and a newer URI-less receipt are both skipped, so "last" means the last mutation that can actually be inverted. When nothing qualifies it returns `ok: false` with `reason: 'no_reversible'` rather than choosing one. Both take `response_format` and `dry_run`; **`dry_run` defaults to `true`**, the opposite of the shared default, because an undo is a destructive write and the safe reading is the one the schema advertises.

Direction is read from the receipt, never assumed. An `added` receipt (add/save) is undone by removing; a `removed` receipt is undone by re-adding. A receipt written before direction tracking carries no field, and `added` is assumed — the assumption is stated in every branch that uses it, as `direction_assumed: true` in `structuredContent` and as a line of prose, because the alternative (re-adding) duplicates rows that cannot be deduplicated back.

Executing is a write and says so: both tools carry `destructiveHint: true` and no `readOnlyHint`, so a host that auto-approves on those hints cannot wave a rollback through. A preview issues no request and asks nothing. An execute asks through MCP elicitation first, and `requiredConfirmationRefusal` fails closed — a client that never advertised the capability, or a prompt that fails mid-flight, returns `ok: false` with `reason: 'confirmation_unavailable'` and **zero** writes.

Refusals decided before the prompt, so a rollback that cannot happen never spends the user's attention:

| `reason` | Meaning |
|---|---|
| `unknown_receipt` | The id is not in the store — never issued, evicted past the cap, or expired. Prose is the shared miss message, which names the store's scope. No writes, and no receipt. |
| `not_reversible` | A `playlist_meta` receipt; the kind is named back rather than an inverse being guessed. |
| `no_uris` | A reversible receipt carrying no URIs, so there is nothing to write. |
| `no_reversible` | `undo_last_mutation` only: nothing in the store qualifies. |
| `occurrences_unrecorded` | A playlist add whose receipt does not record which rows it created. A bare-URI delete would remove *every* copy of each URI, including rows that predate the mutation, so the undo refuses and asks for an explicit removal instead. |
| `confirmation_unavailable` | The client cannot prompt. Fails closed. |

A successful execute returns `ok`, `undone_receipt`, `direction`, `inverted_to`, `requests`, `verified`, `expected_absent`, `expected_present`, `snapshot_id` and `receipt` — the last being a fresh receipt for the post-state, so the rollback is itself verifiable and can itself be undone.

**A failed undo says so, and certifies nothing.** A rollback is several requests; when one fails, the result is `ok: false` with `reason: 'partial_write_failure'`, `completed_requests` and `attempted_requests` — the two counts differ precisely because a partial write is what happened — and **no receipt is issued**, so nothing can later read a half-applied state as verified. The original receipt stays resolvable, because a failed undo does not invalidate the record of the mutation it was trying to reverse. If the writes landed but the post-state refetch did not confirm them, `ok` is `false` with `reason: 'post_state_mismatch'` and `unconfirmed_uris` naming exactly which URIs were not observed as expected, or `post_state_unverified` when the check could not run at all. A receipt that could not be checked is not a passing one.

**Known gap (#658).** Both tools declare `response_format` but neither handler reads it, so `json` returns the same prose as `concise` — where the shared controls section above promises a raw API payload. The registry-wide conformance gate in `tests/mutations.conformance.test.ts` checks that a write-capable tool *exposes* `dry_run` and `response_format`, not that it honours them, so this is invisible to it. `tests/tools.undo-receipts.test.ts` deliberately asserts nothing about `response_format`'s effect rather than ratifying the mismatch.
### 5.12 Discovery and registry introspection

Three pure-introspection tools register outside toolset trimming (`alwaysActive`, catalog scope key) so they survive a minimal toolset — the escape hatch for a registry of hundreds of tools. `scripts/check-doc-tool-counts.mjs` refuses a registry tool count in hand-maintained text anywhere but a generated block, and fails if the registry ever leaves the three-digit range "hundreds" describes. They call no Spotify endpoint. `response_format` on these three differs from the shared contract above, because "json = raw API object" is the wrong promise for a tool that never calls the API:

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


### 5.13 Accounts and the acting account (#602)

Two tools in the `accounts` module (registration key `accounts`, in the `core` preset and selectable on its own). Before this, multi-account support was environment-only: `getTokenFile()` picked ONE token file at startup and every downstream store followed it, so a user with a personal and a work account had to run two processes, and nothing at call time could say which account a result belonged to.

#### The registry

`~/.spotify-mcp/accounts.json` (override with `SPOTIFY_MCP_ACCOUNTS_FILE`), written owner-only and atomically. It is a local index keyed by Spotify's `account_id` — the field the API documents as "a public, immutable, pseudoanonymous identifier … use this field for account linking rather than the `id` field" — and each entry records `{ accountId, profile, tokenFile, displayName?, scopes?, lastUsed? }`.

It is a file rather than a `/me` sweep on purpose: an account's identity is only knowable through an authenticated request, so enumerating would mean one live request per candidate token file on every listing, and one revoked token in the set would fail the whole listing instead of reporting the accounts that still work. Populated by `switch_account` and by `spotify-mcp auth --profile <name>`, both of which are already authenticated when they write.

**`tokenFile` is a path, and a path is not a credential.** The doctor already discloses the path and the operator named it on the command line; an operator debugging a switch needs to know which file backs an account. The bytes behind it are the secret, and no `access_token` / `refresh_token` value is ever read into an entry, written to the file, or returned by a tool. `list_accounts` projects through `AccountSummary`, a type with **no field that can hold a token**, so the guarantee is structural rather than a matter of remembering to redact at each call site.

A registry file that is not valid JSON is REFUSED, never overwritten: there is no honest partial answer, and silently replacing it would discard every registration the operator has. A single malformed ENTRY is dropped and the rest are reported — one unreadable row does not take the listing down with it.

#### `list_accounts`
**Inputs:** `response_format` (the shared contract, §5).

**Returns:** `structuredContent` carries `accounts` (one `AccountSummary` per registered account: `account_id`, `profile`, `display_name`, `token_file`, `scopes`, `last_used`, `active`), `active_account_id`, `active_display_name`, `active_token_file`, and `registry_file`. Exactly one row is `active`. The acting account always has a row even when the registry has never seen it — a server started with `--profile work` that has not switched since would otherwise list nothing and report no active account, which is the one answer a caller is guaranteed to want.

Reads the local registry and issues at most one `GET /me` (for the acting account's identity, cached per session). No mutation requests.

#### `switch_account`
**Inputs:** `profile` (string, required — the value `--profile <name>` takes, or the literal `default` for the account the server started as; the name must already have been authenticated, this tool does not run the auth flow), `response_format`.

A registered entry resolves through its stored `tokenFile`; an unregistered name resolves through `getTokenFile`, the same resolver the server itself uses, so `switch_account("work")` selects exactly the file `--profile work` would have. `default` is special-cased rather than handed to `getTokenFile`, because `--profile default` is a real file (`tokens.default.json`), not the default account.

**This is a write and it is confirmed.** Changing the acting account changes whose library every subsequent mutation lands in, so it asks through elicitation with **no threshold** — the count-based gates in `confirm.ts` measure how MANY things a call destroys, and one switch is not safer for destroying one account's session. The gate fails closed through `requiredConfirmationRefusal` on every verdict but `confirmed`: a host that cannot prompt (`unsupported`) and a prompt that fails on the wire (`error`) are both refusals. `SPOTIFY_MCP_CONFIRM=never` remains the only bypass. Its static annotations state `destructiveHint: true` explicitly — `switch` matches neither mutating nor destructive verb prefix, so the name-driven fallback would have advertised a re-pointed session as a safe no-op.

**Returns:** `structuredContent` carries `ok`, `changed` (false when the session was already acting as that profile), `profile`, `token_file`, `acting_account_id`, `acting_display_name`, `registry_file`, plus `identity_note` when Spotify served no `account_id` and `registration_warning` when the registry write failed. A warning does not undo the switch and is not reported as a failed switch: the session genuinely IS acting as the new account, and saying otherwise would be a lie about its state. It also drains the request queue first — see §4.0.3.

#### The acting-account echo

Every tool result with a `structuredContent` carries `account_id` and `display_name` for the account that produced it, added at a single boundary (`src/actingaccount.ts`) that wraps `server.tool`/`registerTool` — the same mechanism the truncation (#53) and progress (#65) boundaries use, installed last so it sees the finished result. A field on 587 call sites is 587 chances to forget, and the ones forgotten are the writes.

**When the identity cannot be read, nothing is added** — not `null`, not a placeholder. A present-but-empty field reads as a fact ("this account has no id") when what is true is "we could not find out", and a caller has to be able to tell the two apart. The identity is resolved at most once per account per session and cached against the client's own `tokenFile`, so a switch re-points the key and the previous account's cached identity is simply never looked up again — no code has to remember to clear it. `list_accounts` is exempt: it reports the acting account as its subject.

#### The audit trail is per account

The issue's fourth suggestion asks for the history and receipt stores to be keyed by account so that switching accounts cannot "interleave audit trails". The read cache was the first half: a switch drops it, so no cached read crosses accounts, and the persisted cache file was already per-token-file (#1249). The mutation ledger and the receipt store were the second half, and until now they were not: both paths resolved a DIRECTORY, not a per-account name, so a session that switched from `personal` to `work` appended both accounts' mutations to the same `mutations.jsonl`, and a receipt id minted under one account could be redeemed by `undo` under the other. Both are keyed now — see §5.11 for the receipt half.

The key is the **token file**, not `account_id`, which is a deliberate deviation from what the issue suggested and from what this section originally proposed. `account_id` costs a live `GET /me`, is allowed to come back unreadable (`resolveActingAccount` returns `undefined` rather than substituting the user `id`), and would make every store lookup either a network call or a fallback that reintroduces the merge it is meant to prevent. `client.tokenFile` is a plain public field, assigned in the constructor and re-pointed by `switchAccount`, so it is available wherever a store is read or written, with no network round trip, and it cannot be absent. It also matches the read cache's existing `cacheFileNameFor`, so there is one derivation on the box rather than a second one that can disagree with it.

The acting-account echo is not a substitute for any of this, and still is not. It attributes tool RESULTS; a receipt is written on the mutation path, and a ledger line is written on the mutation path. Both now carry the profile segment in their filename and, for a named profile, in the record's `account` field, so a reader can tell which of two accounts a line belongs to.

**Existing files.** The default account's two stores keep their pre-#1364 names byte-for-byte, so there is no migration and no silent "receipt not found" after an upgrade. A named profile's pre-existing lines are **not** migrated and **not** read: they predate any attribution, and serving them to a profile is the cross-account confusion being fixed. That is the only visible regression, it is bounded to machines that already ran a profile with a ledger, and it is stated here rather than left to be discovered. The `spotify-mcp logout` store report enumerates both stores across accounts, so erasure reaches every account's file rather than only the active one.

#### `spotify_doctor`
The `account` row names the acting account's `account_id`, its `id`, its `display_name`, and **the token file the identity was read through** — a report that named the account but not the file could not answer "which of the accounts on this box am I looking at". An absent `account_id` is reported as `not returned`, never substituted with the `id`: a near-miss built from `id` would look like a registry match.

**The `scopes` row asks about the tools this run registers, and the scope gate does not silence it (#681).** The row compares the auth-time grant against the write tools the *effective* configuration exposes — the modules `SPOTIFY_MCP_TOOLSETS`, `SPOTIFY_MCP_ENABLE_TOOLS` / `SPOTIFY_MCP_DISABLE_TOOLS` and `SPOTIFY_MCP_READONLY` actually leave registered, resolved through the same `isModuleActive(key, sets, overrides)` call `src/index.ts` makes. It reads `active_modules`, **not** `exposed_modules`: a module appears in the surface's scope-hidden list only *because* its write scope is missing, so filtering the requirements by the scope-filtered surface cancelled the check against its own subject — the larger the gap, the quieter the row, and only a token whose `scope` was empty (which fails open) ever produced a warning.

Requirements are **either-of** where the scope gate is either-of: a caller holding only `playlist-modify-public` can create a playlist, so the doctor does not also ask for `playlist-modify-private`. `upload_playlist_cover` is its own group requiring `ugc-image-upload` **in addition to** a playlist-modify scope, and is not reported at all when neither modify scope is granted — the precondition gap is the actionable one. Under `SPOTIFY_MCP_READONLY` the row is a single `info` explaining that write tools are unregistered, because "the grant is sufficient" would be a verdict on a comparison that did not happen. Skipped requirements are named in the row's detail (`not checked — …`) so an absent gap is legible rather than silent.


### 5.14 Spotify reference inspection (#915)

Six local, zero-network tools that parse and canonicalise references using the **same** policy an entity-id parameter is built from. They make no Spotify API call; their purpose is inspection and canonicalisation.

| Tool | Purpose |
|---|---|
| `parse_spotify_uri` | one reference → `{ form, kind, id, valid, canonical_uri, error }` |
| `parse_spotify_uris` | up to 500 references through the same policy |
| `format_spotify_uri` | build a `spotify:<kind>:<id>` URI from a reference |
| `canonicalize_spotify_uri` | every accepted form → the one canonical URI |
| `dedupe_spotify_uris` | order-preserving unique URIs |
| `spotify_uri_stats` | count references, `group_by` `form` or `kind` |

`parse_spotify_uri` is the tool an agent reaches for to ask "is this a valid reference?", so it must not disagree with the resolver that actually gates the request. `tests/refs.parity.test.ts` is that guarantee: a table of 28 references — every documented form, a lookalike host, an unrelated host, kind mismatches, malformed lengths, an unknown kind, and four `Object.prototype` keys used as entity kinds — is fed to `parse_spotify_uri` **and** to `spotifyId()`, the schema every resolver-backed parameter is built from, and both must return the same verdict and the same bare id.

**The policy, stated once.** A reference is a bare catalog id of exactly 22 URL-safe characters (`user` ids are one or more URL-safe characters), a `spotify:<kind>:<id>` URI, a `spotify://<kind>/<id>` link, or an `open.spotify.com` share URL — including its localised `/intl-<locale>/` form and any query string. The host check is exact-string: `open.spotify.com.evil.test` is rejected. Kinds come from a `Map`, not an object literal, so `spotify:constructor:<id>` cannot resolve a kind. A kind mismatch (`spotify:playlist:…` where a track was expected) is rejected, not reinterpreted.

The other `spotify:`-shaped patterns in `src/` are not a second parser: `src/resources/index.ts` matches a *resource address* (`spotify://playlist/<id>/tracks`) to route a host read, which is a different namespace from an entity reference, and prompt text quotes reference syntax in prose.

### 5.15 Queue-read migration (#847)

Eight registered tools read `GET /me/player/queue`. Two are left; the other six are retired and a call naming one is refused with `kind: "unknown_tool"`, `reason: "retired_tool_alias"`, and a `fix` naming the exact replacement call.

| Retired name | Call that replaces it | What moved |
|---|---|---|
| `describe_queue` | `get_queue` with `view: "enriched"` | `context_label` and `total_remaining_ms`. Its `include_context: false` has no equivalent — `view: "raw"` is the "do not resolve the context" answer, and the total is not returned there. Three of its fields do **not** come across, and none of them is a measurement: `queue_length` is `items.length`, and `insertion: "tail"` and `workaround: "queue is append-only"` were two renderings of the constant that Spotify's queue is append-only. They are named here so the omission is a decision on the page rather than a field a caller discovers missing. |
| `get_queue_snapshot` | `get_queue` with `include: ["runtime"]` | `total_runtime_ms`; its `total` is now `runtime.upcoming_count`. |
| `queue_runtime_report` | `get_queue` with `include: ["runtime"]` | Every field, unchanged, now nested under `runtime`. |
| `queue_duplicate_check` | `get_queue` with `include: ["duplicates"]` | Every field, now nested under `duplicates`. |
| `queue_profile` | `get_queue` with `include: ["profile"]` | Every field, now nested under `profile`. Still counts the playing item. |
| `predict_next_tracks` | `peek_next` with `count` for the item list; `get_queue` with `include: ["runtime"]` for the ETA | Every field. `items[]` is `runtime.timeline` — same rows, same cumulative `plays_at_ms`, widened with the album/show/artist context and not capped. `current_track_remaining_ms` is `runtime.current_track_remaining_ms`. |

**These six are deliberately NOT reachable through `SPOTIFY_MCP_LEGACY_ALIASES=1`.** The eight `taste_*` aliases that flag restores were argument-identical to their canonical tools, so rewriting the name preserved the call. None of these six is: `queue_runtime_report` sends no arguments and its answer is the runtime analysis, while `get_queue` with no arguments answers with the raw queue. A name-only rewrite would return a different, entirely plausible answer under a name that used to be right — the same defect class as #803 and #830. The flag means "same call, new name", not "same name, different question".


## 6. Resources

MCP Resources expose read-only data as URIs Claude can reference. Fixed resources and template inventories are generated from the live registry:

<!-- BEGIN:generated resource-surface -->
The finalized default registry contains **17 fixed resources** and **47 resource templates**. Fixed URIs: `spotify://me`, `spotify://me/followed/artists`, `spotify://me/genre-heatmap`, `spotify://me/listening-history`, `spotify://me/playlists`, `spotify://me/rate-limit`, `spotify://me/recently-played`, `spotify://me/saved/albums`, `spotify://me/saved/audiobooks`, `spotify://me/saved/episodes`, `spotify://me/saved/shows`, `spotify://me/saved/tracks`, `spotify://me/top/artists`, `spotify://me/top/tracks`, `spotify://player/devices`, `spotify://player/queue`, `spotify://player/state`. Template URIs: `spotify://album/{id}`, `spotify://album/{id}{+qs}`, `spotify://artist/{id}`, `spotify://artist/{id}/albums`, `spotify://artist/{id}/albums{+qs}`, `spotify://artist/{id}{+qs}`, `spotify://audiobook/{id}`, `spotify://audiobook/{id}/chapters`, `spotify://audiobook/{id}/chapters{+qs}`, `spotify://audiobook/{id}{+qs}`, `spotify://chapter/{id}`, `spotify://chapter/{id}{+qs}`, `spotify://episode/{id}`, `spotify://episode/{id}{+qs}`, `spotify://me/followed/artists{?format}`, `spotify://me/genre-heatmap{?format}`, `spotify://me/listening-history{?format}`, `spotify://me/playlists{?format}`, `spotify://me/rate-limit{?format}`, `spotify://me/recently-played{+qs}`, `spotify://me/recently-played{?format,limit,after,before}`, `spotify://me/saved/albums{+qs}`, `spotify://me/saved/albums{?format,limit,offset}`, `spotify://me/saved/audiobooks{+qs}`, `spotify://me/saved/audiobooks{?format,limit,offset}`, `spotify://me/saved/episodes{+qs}`, `spotify://me/saved/episodes{?format,limit,offset}`, `spotify://me/saved/shows{+qs}`, `spotify://me/saved/shows{?format,limit,offset}`, `spotify://me/saved/tracks{+qs}`, `spotify://me/saved/tracks{?format,offset,limit}`, `spotify://me/top/artists{+qs}`, `spotify://me/top/artists{?format,time_range,limit,offset}`, `spotify://me/top/tracks{+qs}`, `spotify://me/top/tracks{?format,time_range,limit,offset}`, `spotify://me{?format}`, `spotify://player/devices{?format}`, `spotify://player/queue{?format}`, `spotify://player/state{?format}`, `spotify://playlist/{id}`, `spotify://playlist/{id}/tracks`, `spotify://playlist/{id}/tracks{+qs}`, `spotify://playlist/{id}{+qs}`, `spotify://show/{id}`, `spotify://show/{id}{+qs}`, `spotify://track/{id}`, `spotify://track/{id}{+qs}`.
<!-- END:generated resource-surface -->

### 6.1 Query parameters on paged resources

A fixed resource that reads a paged endpoint accepts its window in the URI. The window travels on the URI because a resource read has no arguments field — the URI is the only thing a host controls — and because a host that polls `spotify://me/top/tracks?time_range=short_term&limit=5` can cache the answer against the URI it asked for.

Each parameterised resource registers three entries, not one: the bare URI, a form-style template naming the parameters (`{?format,time_range,limit,offset}`), and a `{+qs}` catch-all.

**Expansion is the host's job, so the server's job is to match a pattern against a concrete URI.** `resources/templates/list` returns template strings; `resources/read` takes a concrete `uri`, and nothing in a read request can carry the braces. That makes the server's obligation precise: match the concrete URI a conforming host built from the template it was advertised.

**The SDK's own matcher did not meet that obligation, so the server supplies one (#1401).** The MCP SDK's `UriTemplate` compiles a form-style expression to a *conjunctive, ordered* regex, which is stricter than RFC 6570:

```
spotify://me/top/tracks{?format,time_range,limit,offset}
  →  ^spotify://me/top/tracks\?format=([^&]+)&time_range=([^&]+)&limit=([^&]+)&offset=([^&]+)$
```

Every named parameter must be present, and in declaration order. RFC 6570 §3.2.8 says the opposite: a form-style expression expands with *whatever variables are defined*, joined by `&` in declaration order, and with none defined it expands to the empty string. The SDK therefore disagrees with its own expander — `expand({time_range:'short_term', limit:'5'})` returns `spotify://me/top/tracks?time_range=short_term&limit=5`, and `match()` of that same string returns `null`.

Before #1401 the server routed around this by depending on the `{+qs}` twin, so every advertised `{?…}` entry was decorative: a host that expanded the template correctly landed on the catch-all, not on the entry it was told to build a URI from. `src/resources/uritemplate.ts` (`Rfc6570UriTemplate`, a `UriTemplate` subclass) now compiles these templates the way RFC 6570 expands them, and every `{?…}` and `{+qs}` template in `src/resources/` is registered with it. `toString()` is unchanged, so `resources/templates/list` still advertises the same strings.

**The `{+qs}` twin is the catch-all for query strings this server does not model** — a typo, an undeclared parameter, a parameter sent in an order the template does not expand to. It also has to *not* match a path difference, and the SDK's `(.+)` could not do that: `spotify://me/saved/tracks{+qs}` matched `spotify://me/saved/tracksX`, and the server served saved tracks for a URI that names no such resource. The corrected matcher requires a real `?`, so that URI is now rejected.

A read of the advertised `uriTemplate` string itself also resolves, to the unparameterised default, rather than failing with "resource not found" against a URI the server published. `tests/resources-uri-template-matching.test.ts` covers all of this, including the general property that every registered template matches the URI the SDK's own expander produces from it — so the next template that gets this wrong is caught here rather than by a host. `tests/resources-603.test.ts` still pins the SDK's stricter behaviour, so an SDK that relaxes it to true RFC 6570 turns that test red rather than making the override's reason disappear quietly.


| Resource | Parameters | Upstream endpoint |
|---|---|---|
| `spotify://me/top/tracks` | `time_range`, `limit`, `offset` | `GET /me/top/tracks` |
| `spotify://me/top/artists` | `time_range`, `limit`, `offset` | `GET /me/top/artists` |
| `spotify://me/recently-played` | `limit`, `after`, `before` | `GET /me/player/recently-played` |
| `spotify://me/saved/albums` | `limit`, `offset` | `GET /me/albums` |
| `spotify://me/saved/shows` | `limit`, `offset` | `GET /me/shows` |
| `spotify://me/saved/episodes` | `limit`, `offset` | `GET /me/episodes` |
| `spotify://me/saved/audiobooks` | `limit`, `offset` | `GET /me/audiobooks` |
| `spotify://me/saved/tracks` | `offset`, `limit` | `GET /me/tracks` (pre-existing) |

**`spotify://me/recently-played` has no `offset`, and advertising one would break the read.** `GET /me/player/recently-played` is a cursor endpoint: the OpenAPI schema gives it `limit`, `after` and `before` and no `offset`. Spotify rejects an undeclared query parameter with a 400, so a resource that offered `?offset` here would fail rather than page. The forward cursor is the earliest `played_at` on the page just read, and the prose names it when a full page comes back — a full page means the walk stopped on `limit`, not that the history ended.

**`time_range` is validated, not forwarded.** The schema carries no `enum` for it, only a description naming `long_term` / `medium_term` / `short_term`. A value outside that set is not sent: Spotify would answer 400, and a resource read failing on a typo is worse than one that reads the default.

**A window is not a truncated walk, and does not borrow its disclosure.** The saved-library resources default to walking the whole library up to `SPOTIFY_MCP_FETCH_ALL_CAP` and reporting the walk's own verdict (`total`, `truncated`, `truncation_note`). Supplying `?limit` or `?offset` switches the read to a single paged request instead. The walk stays the default precisely because it is the reading that carries the #718 disclosure; a one-page read is not a truncated library, so the window path reports the API's own `total` and a continuation hint rather than a cap verdict it did not earn.

`limit` is bounded to 1–50 and `offset` to ≥0 before forwarding, matching the tool schemas and the OpenAPI maxima. An unparseable value falls back to the endpoint default rather than failing the read.

**Normalising silently is a reason to publish the bound, so the bound is in the description.** Each parameterised resource states its range, its default and — for `time_range` and the cursors — its unit and legal values, on all three of its registered entries, so a host reads the contract from `resources/list` before it builds the URI rather than inferring it from a shortened response. `?limit` and `?offset` are zero-anchored numbers a natural-language request becomes ("the next ten"), so the same failure #883 fixed for playlist position bases applies here in the other direction: a guessed bound produces a *narrower* window than asked for and nothing in the body says the request was rewritten. `?after` and `?before` are **Unix epoch milliseconds**, not seconds and not an ISO date — a seconds cursor selects 1970 and returns an empty page. `tests/resources-603.test.ts` fails if any advertised parameter loses its bound.

### 6.2 Audiobook and chapter templates

`spotify://audiobook/{id}`, `spotify://audiobook/{id}/chapters` and `spotify://chapter/{id}` close the gap between a complete audiobook **tool** surface and a resource surface that had no audiobook URI at all.

| Template | Endpoint | Parameters |
|---|---|---|
| `spotify://audiobook/{id}` | `GET /audiobooks/{id}` | `?market`, `?format=json` |
| `spotify://audiobook/{id}/chapters` | `GET /audiobooks/{id}/chapters` | `?market`, `?limit` (1–50), `?offset`, `?format=json` |
| `spotify://chapter/{id}` | `GET /chapters/{id}` | `?market`, `?format=json` |

**The chapters pair registers before the bare audiobook pair.** `spotify://audiobook/{id}{+qs}` compiles to `(.+)`, so registered first it would swallow `spotify://audiobook/{id}/chapters`. This is the same ordering constraint that puts `artist-albums` ahead of `artist`, and it is why registration order in `src/resources/templates.ts` is a correctness property rather than a cosmetic one.

`{id}` completions come from `/me/audiobooks` for the audiobook template, following the `artist-albums`/`show`/`episode` pattern. The chapter template has no suggester: `/me/audiobooks` yields audiobook ids, and a chapter's id is only reachable through `spotify://audiobook/{id}/chapters`.

**The cards are the tool's cards.** The prose comes from `src/audiobookview.ts` — `audiobookDetailLines`, `chapterDetailLines`, `chapterListLine` — which `get_audiobook`, `get_chapter` and `get_audiobook_chapters` also call. The field reads that matter are not duplicated: the #639 removal of `publisher` (fall back to the edition, never print `Unknown publisher`), the #787 fact that the embedded `chapters` array is a fixed ten-row preview rather than the book's chapter list, and an absent or empty `narrators` array.

`spotify://audiobook/{id}/chapters` reads **one page**, bounded to `limit` ≤ 50. The full-book walk is `get_audiobook_chapters` with `fetch_all`, and the prose footer says so when a page came back full.

### 6.3 `spotify://player/devices`

`spotify://player/devices` lists the Spotify Connect devices available to the account, live, with the active one flagged. It exists because device discovery is ambient state: without it, every playback command on a toolset-trimming host started with a `get_devices` call that cost a turn and quota to learn something that does not change between commands.

It renders `id`, `name`, `type`, `is_active` and `volume_percent` through `deviceLine` in `src/devices.ts`, which `get_devices` also calls — so the two surfaces cannot drift on the #855 `volume_percent` guard, where the field is omitted on some devices and `null` on others. A volume-capable device with no reported level prints `volume: unknown`; one that cannot report volume at all prints no volume.

The endpoint takes no query parameters (the OpenAPI schema declares none), so this resource has no `{?…}` template beyond the standard `?format=json` twin. `get_devices`'s tool description names the resource, so an agent that has the tool list can discover the cheaper read.

### 6.4 `spotify://me/genre-heatmap` coverage contract (#604)

The heatmap counts genres over a **live sample of your top artists**
(`GET /me/top/artists`, `time_range: medium_term`, up to 50). It is not a
followed-artist census. The resource description used to promise a
`followed_artists` sidecar that no code path reads, so the claim was removed
rather than implemented, and the payload now states what was actually read.

`?format=json` returns the counts together with the coverage that produced them:

| Field | Meaning |
|---|---|
| `source` | Always `top_artists_sample`. Names the read that ran. |
| `time_range` | Always `medium_term` — the endpoint's documented default. |
| `artists_counted` | Artist rows the walk returned. |
| `artists_with_genres` | Rows that carried a readable `genres` array. |
| `artists_unreadable` | Rows excluded because their `genres` could not be read. |
| `unreadable_artists` | Present only when `artists_unreadable > 0`; one `{id, name, reason}` per excluded row. |
| `truncated` | Rows are missing from the sample. |
| `truncated_by_cap` | The 50-artist cap is what ended the walk, rather than a reported total outrunning it. |
| `total` | The API's own count, or `null` when it sent none. |
| `genres` | The counts, over readable rows only. |

**An unreadable row is never a zero.** `ArtistObject` declares no `required`
fields and marks `genres` deprecated, so a row can arrive without it. Such a row
is excluded from `genres`, listed in `unreadable_artists` with the reason, and
counted in `artists_unreadable`; the prose says the counts are a lower bound. A
row that genuinely carries `genres: []` is a *read* of an unclassified artist
and is **not** reported as unreadable — the two are different facts and the
output distinguishes them. Rows are labelled by `id` when `name` is also absent,
since the id is the one field that cannot itself be missing.

`truncated` distinguishes a cap that bound from a walk that came up short of a
reported total without the cap applying, matching the walk disclosure the
capped library resources use (#718/#864).


---

## 7. Prompts

Pre-built prompt templates exposed via MCP for common use cases:

<!-- BEGIN:generated prompt-surface -->
The finalized default registry exposes **14 prompts**: `artist_deep_dive`, `crate_digging`, `discover_weekly_alternative`, `dj`, `listening_recap`, `migrate_library`, `morning_briefing`, `music_briefing`, `music_taste_summary`, `playlist_audit`, `playlist_from_mood`, `podcast_catchup`, `triage_liked_songs`, `weekly_digest`.
<!-- END:generated prompt-surface -->

### Prompt argument contract (#689)

`prompts/get` carries the argument contract §5 states for tools, installed by `installPromptErrorBoundary` at the **end of `registerPrompts`**. It lives there rather than in `src/index.ts` beside `installToolErrorBoundary` because `registerPrompts` is the only way a prompt surface is ever built — production and every test go through that one function, so the guarantee cannot be lost to a new call site that forgets it.

**A prompt is strict about argument names.** `server.prompt()` registers a plain `z.object()`, which *strips*: before this, a call carrying a misspelled argument rendered a complete prompt built from defaults and signalled nothing, so a caller received a confident answer to a question it had not asked. `dj`, which declares no arguments at all, accepted any object. It is a rejection rather than a strip for the same reason `tools/call` rejects: one server, one contract, and the lenient surface would be the one that silently drops work.

A refusal is JSON-RPC **`-32602` (Invalid params)** with a **one-line** message, because `prompts/get` has no `isError` channel — its result type has no such field, so a protocol error is the only way to refuse one:

| Call | Message |
|---|---|
| `music_taste_summary {time_rang: "week"}` | `music_taste_summary does not accept argument time_rang; remove it and use "time_range" instead` |
| `dj {mood: "chill"}` | `dj does not accept argument mood; remove it, dj takes no arguments` |
| `playlist_audit {}` | `playlist_audit rejected argument playlist: expected a string (Playlist name, ID, or URI)` |
| `listening_recap {time_range: "weekly"}` | `listening_recap rejected argument time_range: expected one of "short_term", "medium_term", or "long_term"` |
| `discover_weekly_alternative {size: "250"}` | `discover_weekly_alternative rejected argument size: expected a value at most 50 (How many discovery picks to return (default 20))` |

Three properties hold for every one of them, and each is asserted against the **raw JSON-RPC frame** rather than through the SDK client, which re-wraps every response error and would re-add the prefix this contract removes:

- **It names the prompt and the argument.** A caller can act on "that argument" without re-reading the schema.
- **It says what was expected**, read off the schema's own failure and never inferred, and it carries the argument's own `.describe()` text as the concrete next step — the same sentence `prompts/list` already advertises, so the error and the schema cannot disagree. An enum lists every legal member and omits the description, which would only restate it; a type or a bound is incomplete alone and takes it.
- **It carries no SDK or zod wording.** No `MCP error -32602:` prefix, no `Invalid arguments for prompt …`, no zod issue array. A non-string argument value is refused in this shape too: MCP prompt arguments are `{"[key": "string"}` on the wire, and the SDK's own request schema used to reject a number before any handler ran, as a `-32603` whose message was a pretty-printed zod issue array.

**Strictness is about argument names, not encodings.** A *declared* argument still accepts everything it accepted before: the numeric prompt arguments (`size`, `limit`, `batch_size`) are `z.coerce.number()` and keep taking the protocol string, so a host that can only express a scalar is still served. Nothing here decides what a *value* may be spelled as — that is #694, and it is untouched.

### Resource hints degrade with the resources module (#715)

A prompt may name a `spotify://` resource **only when this session registered one.** `prompts` and `resources` are independent toolsets, so the prompt surface can be served with no resources at all: `SPOTIFY_MCP_TOOLSETS=prompts`, or `SPOTIFY_MCP_ENABLE_TOOLS=prompts`, or `SPOTIFY_MCP_DISABLE_TOOLS=resources` under any other spec. In those configurations three prompts named a resource in prose of their own and the shared footer named a fourth — all of which resolve to nothing, and a hint that points at nothing is worse than no hint, because the agent routes work toward it and finds an absence it cannot explain.

The degraded form keeps the guidance and drops the URI:

| | Resources registered | Resources trimmed |
|---|---|---|
| Shared footer (12 prompts) | `…rate-limited (429), note it with data from spotify://me/rate-limit, wait and retry once…` | `…on 429 the failure already carries the wait: the message names the Retry-After seconds and structuredContent.error.retryAfterSec holds the same number — wait that long and retry once…` |
| `music_taste_summary` | "read `spotify://me/top/tracks?time_range=short_term&limit=5` for a recent snapshot" (a zero-tool-call read) | "call `get_top_tracks (time_range=short_term, limit=5)`" — the same data, one tool call away |
| `dj`, `artist_deep_dive` | "check `spotify://me/rate-limit` and retry once" | the same 429 sentence as the footer |

**The fallback is the failure the agent is already holding, not a second surface.** A 429 arrives as `kind: 'rate_limited'` with the parsed `Retry-After` in the message text and in `structuredContent.error.retryAfterSec` (§8), so the degraded guidance is actionable with nothing else reachable. Naming a rate-limit *tool* instead was rejected deliberately: every tool module sits behind its own toolset key, so that would reproduce this exact defect one level down, on a surface the same trim can remove. A mechanism the agent is already holding cannot be trimmed away from it.

**`registerPrompts(server, options)` takes a required `resourceHints`.** `src/index.ts` resolves "are resources on" once and uses that one boolean both to register the resources and to write the prompt text — two independent derivations of one question are two answers to one, and the drifting one ships a dead hint. The option is required rather than defaulted so no call site can silently receive a lying prompt, for the reason §7's argument contract already states about `installPromptErrorBoundary`.

A trimmed deployment is also reported by `spotify_doctor`: the `surface` row gains `prompts_without_resources` and says so in its summary (§9). `music_briefing` and `triage_liked_songs` never carried a resource clause, so they render identically in both configurations.

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
| 499 (caller cancellation) | The request's own `AbortSignal` fired — an MCP `notifications/cancelled`, or a host disconnect | `SpotifyApiError` with `reason: "CANCELLED"`, mapped to `kind: "cancelled"`. **Never retried**, and never served from the read cache. Not a timeout: the two abort causes are combined with `AbortSignal.any` and told apart by *which* signal aborted, so a cancellation is never reported as "timed out, retry shortly" |

### Cancellation

Every `tools/call` carries a cancellation signal, and it reaches the network
layer without any tool handler having to mention it.

- **The seam.** The MCP SDK hands each handler an `extra` whose `signal` is the
  request's `AbortController` — the one `notifications/cancelled` aborts.
  `installCancellationContextBoundary` (`src/cancellation.ts`) reads it at the
  single tool-invocation boundary and runs the handler under an
  `AsyncLocalStorage`, exactly as the progress token and the mutation actor
  already are. This is why no `src/tools` handler signature changed.
- **The client.** `get()` and `getAllPages()` take an optional `signal` and fall
  back to the ambient one; `mutate`/`post`/`put`/`delete`/`putRaw` use the
  ambient one. The signal is resolved in the CALLER's async context and carried
  explicitly — a queued task runs under the scheduler's context, so reading the
  store down there would sample the wrong request.
- **The walk.** A cancelled `getAllPages` stops **at a page boundary**: the
  refusal happens in `get()` before the URL is built and before the request is
  enqueued, so the page that landed is fully committed and no half-written page
  is left in the accumulator. A walk never returns a partial result that could
  be read as complete — it throws, including `getAllPagesWithTruncation`, whose
  `items` + `truncated` shape would otherwise read as "N pages, and that is all
  of them".
- **The queue.** A task whose signal fired is dropped at dequeue time, *before*
  the start gate and *before* `recordRequest()` — a permit spent on an abandoned
  call delays the next live caller, and a request counted for one that was never
  sent inflates the quota figures a caller budgets against.
- **No backoff hold.** A cancelled request never enters the retry ladder, so it
  never sleeps `250 ms·2ⁿ` inside the serialized queue.
- **Not confusable with a timeout.** Every other error kind tells the host to do
  something — retry, re-auth, request access, wait for a window. `cancelled` is
  the one whose correct action is to do nothing.

Two `AbortSignal.any` details are load-bearing: the caller's signal and the
request timeout are *combined* (the pre-fix code assigned the timeout after a
spread, silently discarding any caller signal), and `any` is used rather than a
manual listener because the SDK's request signal outlives every request it
aborts, so a listener left on it would accumulate one entry per Spotify call
for the life of the session.

### No active device
When playback commands fail because no device is active (204 with no `device_id` found): return a helpful message listing available devices and asking the user to open Spotify on a device first.

### Token-endpoint failures (`https://accounts.spotify.com/api/token`)

A refresh can fail for genuinely different reasons, and they are classified by
**what the response actually said** — never by the nearest plausible-looking
cause. Each class carries a `reason` code, because several of them share a
status and the status alone cannot tell them apart.

| Evidence | Class | `reason` | Surfaced as | Retried? |
|---|---|---|---|---|
| Body `{"error":"invalid_client"}` | Spotify refused the configured app id | `TOKEN_INVALID_CLIENT` | 401, fix naming `SPOTIFY_CLIENT_ID` and the Developer Dashboard | No — a config fault no retry can fix |
| Body `{"error":"invalid_grant"}` | Stored refresh token is dead | `TOKEN_INVALID_GRANT` | 401, "run `spotify-mcp auth`" | No |
| Body `{"error":"<other code>"}` | A named code with no known fix — reported verbatim, cause not asserted | `TOKEN_REQUEST_REJECTED` | 401, code quoted in the message and the log | No |
| HTTP 429 | Token endpoint is rate limiting | `TOKEN_RATE_LIMITED` | 429 with `retryAfterSec` from `Retry-After` (falls back to 1 s, and the message says so when the header was absent) | No — the wait belongs in the error, and re-sending sooner extends the limit |
| HTTP 5xx | Fault on Spotify's side | `TOKEN_SERVER_ERROR` | 503 — the only token failure entitled to availability wording | Yes, on the shared `MAX_ATTEMPTS` budget |
| No HTTP response at all (DNS, refused, reset) | Local network failure, classified from the thrown error's own shape (`code` off the `cause`/`errors` chain) | `TOKEN_NETWORK_UNREACHABLE` | 503, cause quoted, explicitly "not a Spotify outage" | Yes, on the shared budget |
| Our own abort | The refresh exceeded `SPOTIFY_REQUEST_TIMEOUT_MS` | `TOKEN_NETWORK_UNREACHABLE` (status 408) | 408, fix naming the env var | No — already a full timeout wait |
| 2xx whose body will not parse | Spotify answered with something unreadable | `TOKEN_UNREADABLE_RESPONSE` | 503 | No |
| 4xx with no readable `error` string | **Cause unknown** | `TOKEN_UNCLASSIFIED` | 401, stating that it could not be classified and whether the body parsed | No |

Rules that hold for every row:

- **An unclassifiable failure is reported as unclassified.** It is never mapped
  onto a nearby category, because a misclassified error sends the operator down
  a path the response never mentioned.
- **A 4xx body's `error` is read only as a string.** The Web API's
  `{"error":{"message":…}}` object is prose about an API call and is not a grant
  code, so it yields `TOKEN_UNCLASSIFIED` rather than an invented class.
- **No token failure is described as a service outage unless the status is a
  genuine 5xx.**
- **A transport failure is never conflated with a response-borne one.** It has
  no body and no status, so it is classified from the thrown error alone.
- **Every token-failure message names the resolved token file**, so a
  multi-profile install can tell which install is broken.
- A transient failure (`server_error`, `network_unreachable`) is **ridden out**
  on a still-valid access token so the current request proceeds; a
  non-transient one (a refused client id, a dead grant) is surfaced even when
  the old token would have worked, so the misconfiguration is not hidden.

---

## 9. Rate Limiting

- All API calls go through a central `SpotifyClient` class with a request queue
- **One shared start gate.** Every launch reserves a start slot on a single gate, so starts stay a minimum 100 ms apart and none begins during a `Retry-After` cooldown. There is no per-caller sleep and no second limiter
- **Bounded concurrency.** At most `SPOTIFY_MCP_MAX_CONCURRENCY` (default 3, clamped to 32) requests are in flight at once; `1` is the strictly serial funnel. This is the process-wide width and the only concurrency knob: it covers requests a single tool fans out as well as one-off reads, because all of them pass through this funnel. A permit is taken before the gate wait and returned on every exit — success, HTTP error, thrown exception and gate rejection alike — so a failing request cannot shrink the pool. A 5xx backoff holds its own permit for at most ~500 ms, which is what keeps the in-task retry backoff from parking the whole funnel
- **Tool-side fan-out width is not a second knob (#783).** A tool that walks many items concurrently still resolves its width *from* `SPOTIFY_MCP_MAX_CONCURRENCY`; it does not introduce an independent default, because two independent defaults bounding the same quantity make the effective width whichever is smaller, chosen by a comparison no operator can see and no payload can honestly report. The narrow per-scan width that a bulk scan uses is a *scheduling* decision the funnel cannot make for itself: the funnel bounds requests in flight but has no notion of a scan that has decided to stop, so it cannot end a walk early once a quota wall answers.
- On 429: the gate parks all callers for `Retry-After` seconds; the throttled call re-queues once behind the same gate rather than sleeping in place, so the wait is paid once for the whole funnel instead of once per throttled caller. `Retry-After` is read in both RFC 9110 forms — delta-seconds and HTTP-date — so a server asking for minutes is honoured rather than retried after the 1 s fallback. A `Retry-After` above the 10 s in-queue cap, a quota-exhaustion body, and a second 429 on the same call all fail fast with the wait attached in `retryAfterSec` rather than blocking. Three consecutive 429s inside 30 s latch a breaker that refuses new work — without sending it — until the window passes; any request that settles without a throttle clears the streak. The throttle event (retry delay, wait time) is recorded on the client
- One shared attempt budget (`MAX_ATTEMPTS = 3`) covers the 401-refresh, the 429 re-queue, the 5xx backoff and transport-error retries, so no combination of them can loop. 5xx backoff is jittered, and a transport failure is retried only for an idempotent verb so a mutation is never silently re-sent
- Throttle visibility: the most recent event is exposed via the `spotify://me/rate-limit` resource, and a "rate-limited by Spotify, waited Ns" notice is appended to the throttled call's result
- Batch operations issue one API call per **batch**, not one call per item and not one call per content type: a 100-URI library write is 3 requests against `/me/library` at the 40-URI library-writes batch cap, not 100 requests and not one per URI type

---

## 10. Spotify API Constraints

Known limitations to document and handle:

| Constraint | Detail |
|---|---|
| **Premium required** | All playback control: play, pause, skip, seek, volume, shuffle, repeat, queue |
| **No audio** | API provides metadata and control only — no audio streams |
| **Search limit** | Max 10 results per type per `/search` request (schema and runtime cap; default 5). Tools needing deeper results must page with successive offsets. |
| **Queue opacity** | `GET /me/player/queue` returns items but positions are not editable |
| **Registration-gated reads** | The batch lookup wrappers (`GET /tracks?ids=` family) and `GET /artists/{id}/top-tracks` remain registered, but an app registration without the relevant grant answers `403`. This is registration-dependent, not a per-endpoint property of the tool: whether a grandfathered registration still answers `200` is **unverified** (#1338), while the same paths are still published by Spotify's live OpenAPI schema carrying `deprecated: true` even where the February 2026 changelog marks them `[REMOVED]`. The single runtime classification source is `GATED_FAMILIES` in `src/gating.ts` (`GATED_PATH_PATTERNS` is derived from it, and `src/tools/exhaust2_enggating.ts` re-exports the pair for historical import paths). Each family records the tools it ships and whether a 403 is met by a replacement read or a plain-English explanation. The family list includes `/artists/{id}/top-tracks` and the multi-id batch paths; `/me/{type}/contains` is still classified but has **no live call site**, because every reader moved onto `/me/library/contains`, which is not gated. The README's [Registration-gated endpoints](README.md#registration-gated-endpoints) table is generated from that array, so it cannot name a family the classifier rejects. |
| **Removed ≠ gated** | A `[REMOVED]` changelog label is not by itself a single runtime fact, and the two halves must not be confused. A **gated** family has a graceful shape left: the call still happens and the 403 becomes a stated reason or a replacement read, so the tool still answers, and deleting its wrapper makes it worse. An endpoint with **no live call site** must have none, because a 403-tolerant wrapper will happily degrade a removed endpoint into a soft, wrong answer — there the *call* is the bug and the only honest outcomes are to migrate it or delete the tool. #638 removed six tools on that second basis; see [AGENTS.md §2](AGENTS.md#2-endpoints-that-are-blocked-or-deprecated). |
| **Removed fields** | The authoritative list lives in `src/removed.ts`, transcribed from Spotify's [February 2026 changelog](https://developer.spotify.com/documentation/web-api/references/changes/february-2026) and cross-checked against the live OpenAPI schema. Removed: `album_group`, `available_markets` (album/audiobook/chapter/show/track), `label`, `popularity` (album/artist/track), `followers` (artist/user), `publisher` (show/audiobook), `linked_from`, and on the user profile `country`, `email`, `explicit_content`, `followers`, `product`. **Not** removed: `album.external_ids` and `track.external_ids` — both were marked `[REMOVED]` in February and restored by the [March 2026 changelog](https://developer.spotify.com/documentation/web-api/references/changes/march-2026), so code reading them is correct. The changelog and the OpenAPI schema disagree (the schema still declares `available_markets` on `TrackObject` and the removed user-profile fields on `PrivateUserObject`); the changelog wins, because it is the dated statement of intent. A removed field is omitted, or reported as unavailable with a reason — never defaulted to `0`, `''`, a placeholder string, or a bucket key. |
| **Unified library API** | `save_to_library`/`remove_from_library`/`check_in_library` use `PUT/DELETE/GET /me/library` with **URIs** in any mix (including artist/user/playlist follow state on check). It is the **only** library write/read path: the per-type `/me/{type}s` write endpoints and the `/me/{type}s/contains` reads were removed by Spotify in February 2026, and the three tools that used them were deleted in #638. The `/me/{type}s` **list** endpoints (`GET /me/tracks` and friends) are unaffected and still live. |
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
│   ├── cache.ts              # LRU TTL cache for immutable catalog reads (~5 minutes) + invalidation policy (#893)
│   ├── cachepersist.ts       # Optional cross-process persistence for catalog reads (#893)
│   ├── config.ts             # SPOTIFY_* environment family loader
│   ├── history.ts            # Opt-in mutation history JSONL writer
│   ├── shaping.ts            # Shared response shaping (response_format, max_results, pagination)
│   ├── tools/
│   │   ├── analytics.ts      # listening_streaks, top_artists_by_range, taste_shift_report, listening_report (opt-in)
│   │   ├── artistwatch.ts    # get_artist_discography, resolve_artist, save_artist_new_releases, watch_artists, check_artist_releases, artist_release_digest
│   │   ├── audiobooks.ts     # get_audiobook, get_audiobook_chapters, get_chapter, get_saved_audiobooks
│   │   ├── audiobookcopilot.ts # list_all_chapters, jump_to_chapter, where_was_i
│   │   ├── backup.ts         # backup_library, list_backups
│   │   ├── browse.ts         # get_artist_genres
│   │   ├── catalog.ts        # get_me, get_track, get_several_tracks, get_artist, get_artist_top_tracks, get_artist_albums, get_several_artists, get_album, get_album_tracks, get_several_albums, get_show, get_several_shows, get_episode, get_several_episodes, get_available_markets, get_several_audiobooks, get_several_chapters
│   │   ├── doctortool.ts     # spotify_doctor
│   │   ├── episodemgmt.ts    # archive_played_episodes
│   │   ├── export.ts         # export_playlist (M3U/CSV)
│   │   ├── following.ts      # get_followed_artists, check_following_artists, following_analytics
│   │   ├── freshness.ts      # whats_new (new-release radar)
│   │   ├── import.ts         # import_playlist (M3U/CSV)
│   │   ├── libraryanalytics.ts # library_coverage_report, library_growth_report, genre_trends_over_time, listening_heatmap (opt-in)
│   │   ├── libraryhygiene.ts # library_hygiene
│   │   ├── libraryinsights.ts # library_genre_report, filter_by_genre, tag_management
│   │   ├── library.ts        # get_saved_tracks, get_saved_albums, get_saved_shows, get_saved_episodes, get_saved_audiobooks, get_saved_counts, save_to_library, remove_from_library, check_in_library
│   │   ├── personalization.ts # get_top_tracks, get_top_artists, get_recently_played
│   │   ├── playback.ts       # get_now_playing, get_currently_playing, play, pause, skip_next, skip_previous, seek, set_volume, set_shuffle, set_repeat, get_queue, add_to_queue, get_devices, transfer_playback, play_from_search
│   │   ├── playbackext.ts    # save_playback_state, restore_playback_state, list_playback_states, rename_device, set_device_volume_preset, apply_device_presets, list_device_presets, tag_listening_session, replay_session, list_sessions, save_smart_playlist_rule, refresh_smart_playlist, save_show_digest
│   │   ├── playlistbatch.ts  # batch_add_to_playlist, copy_playlist, move_items_between_playlists
│   │   ├── playlistdna.ts    # grow_playlist (co-occurrence)
│   │   ├── playlisthealth.ts # playlist_health_check, get_playlist_followers, playlist_collaboration_report, snapshot_playlist, diff_since_snapshot, list_playlist_snapshots
│   │   ├── playlistfollow.ts # follow_playlist, unfollow_playlist (+ deprecated pin_playlist, unpin_playlist aliases)
│   │   ├── playlistmisc.ts   # playlist_template_apply
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
SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS=1 # opt-in derived listening analytics (default OFF)
```

### Derived listening analytics are opt-in (#695)

Eleven tools compute a derived listening metric — an hour-of-day or daypart
histogram, a weekday profile, a discovery ratio, an era histogram, a binge or
listening-consistency score, a behavioural recap — out of the account's own
`/me/top/*` and `/me/player/recently-played` responses. Spotify's Developer
Policy Sec. III.13 prohibits analysing Spotify Content to create "new or derived
listenership metrics … or building profiles of users", and those outputs are
the shape it names. The interpretation this project relies on, and the reason
it is a gate rather than a deletion, is recorded in `docs/compliance.md`.

**The default is the non-analytics path.** These tools are not registered at
all unless `SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS` is set, so a host that sets
nothing never sees these names in `tools/list`. The registry total is in the
generated inventory at the top of this file; this section does not restate it,
because a figure written here would be wrong the next time a tool lands:

| Module | Withheld (opt-in only) |
|---|---|
| `analytics.ts` | `listening_report` |
| `libraryanalytics.ts` | `listening_heatmap` |
| `swarm3_analytics.ts` | `discovery_ratio`, `listening_clock`, `listening_clock_heatmap`, `artist_listening_clock`, `mood_bucket_report`, `weekday_listening_report`, `weekly_rotation_report`, `binge_detector_report`, `listening_recap_brief` |

With the flag set the registry is byte-for-byte what it was before this change,
and each of the eleven returns the same payload it always did.

**A value that names no boolean is OFF, and says so.** The flag is parsed
through the shared `truthyEnv` convention (#611), so `1`, `true`, `yes` and `on`
enable it (case-insensitive, trimmed) and `0`, `false`, `no` and `off` do not.
Anything else — `SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS=enabled` — leaves the
analytics OFF and prints a line on stderr naming the accepted spellings, rather
than failing to start or quietly reading as true. This is the same trap and the
same treatment `SPOTIFY_MCP_READONLY` has since #611, and the direction of the
failure is why the warning matters here too: the default is already the safe
path, so a typo would otherwise leave an operator believing they had enabled
eleven tools that are not registered.

**This gate is not the read-only gate.** `SPOTIFY_MCP_READONLY` hides
write-capable *modules*; this hides individual read-only *tools* inside modules
that are otherwise fully active. They are independent in both directions — a
read-only host may still hold derived analytics, and an analytics-opted-in host
is still fully writable — so neither implies the other and neither reports the
other's state. The startup log, the `spotify-mcp doctor` configuration block
and the `surface` row of `spotify_doctor` each disclose the flag separately.

**Nothing is silently zeroed.** The eleven tools are absent rather than
returning an empty result, so no caller can read "no hourly listening" out of a
gate that is actually off. Re-presentations of the account's own data are
unaffected and stay registered by default: `get_top_artists`, `get_top_tracks`,
`get_recently_played`, `top_artists_by_range`, `taste_shift_report`,
`listening_history_export` and the rest of the leaderboard and rank-delta tools.
`taste_shift_report` in particular still serves the track/artist window
comparison that `listening_report` used to be the only way to get, which is why
the aggregate is withheld whole rather than partly.

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

## Implementation phases (build history)

**This table is a record of build waves, not a statement about the current
surface.** Nothing in it is authoritative: the tools that exist are the ones
`tools/list` returns, and the counts are generated into `README.md`,
`ARCHITECTURE.md` and `docs/schema-budgets.md` by
`npm run count:tools -- --write` and gated by `--check`. For what shipped in
each release, read [CHANGELOG.md](CHANGELOG.md) — release-please generates it
from the Conventional Commits on `main`, and it is never hand-edited. It has a
section for every tagged release except four: `1.27.0`, `1.27.1`, `1.28.0` and
`1.28.1` were tagged without release-please's manifest ever naming them, so no
section exists for them and none ever will.
`node scripts/check-release-history.mjs` records those four with the commit
that tagged each, and fails on the next release that loses its section. Adding
a row per release to the table below would duplicate that generated file by
hand, which is how this one came to end at v1.26.0 while the project shipped on
through 2.x (#932).

| Phase | Scope |
|---|---|
| **Phase 1** | Auth flow + SpotifyClient + playback tools (play, pause, skip, seek, volume, shuffle, repeat, now_playing, devices, transfer) |
| **Phase 2** | Search + catalog lookup (track, artist, artist albums, album, audio features, audio analysis, show, episode) |
| **Phase 3** | Personalization (top tracks/artists, recently played, recommendations with full tuning surface, related artists, available genres, featured playlists) |
| **Phase 4** | Library management (get saved tracks/albums/shows/episodes; save_items, remove_saved_items, check_saved_items accepting URIs, partitioned across the per-type `/me/{type}s` endpoints) — the trio was **retired in #638** when Spotify removed those endpoints; see §5.5 |
| **Phase 5** | Playlist CRUD + item management (get_user_playlists, get_playlist, create_playlist, add_to_playlist, remove_from_playlist, update_playlist, reorder_playlist_items — all using `/items` endpoints) |
| **Phase 6** | Following (get_followed_artists, follow_artists, unfollow_artists, check_following_artists via `/me/following` + `/me/following/contains`) — the write pair was **retired in #638** (no replacement endpoint exists); see §5.7 |
| **Phase 7** | MCP Resources + Prompts |
| **Phase 8** | Package for npm (`spotify-mcp`) + README polish |
| **Phase 9** | Deprecation cleanup + coverage completion (2026-08): removed deprecated endpoints (audio features/analysis, recommendations, related artists, genres, featured playlists, follow/unfollow artist); create_playlist moved to `POST /me/playlists`; added album tracks, show episodes, get_me, audiobook family, get_currently_playing, play_from_search, playlist cover get/upload; fetch_all pagination via client.getAllPages; SPOTIFY_MCP_TOKEN_FILE override |
| **Phase 10** | v1.1.0 coverage expansion (2026-08): users module (`get_user_profile`, `get_user_playlists_by_id`); `follow_artists`/`unfollow_artists`; unified-library trio (`save_to_library`, `remove_from_library`, `check_in_library`); `get_playlist_items`, `replace_playlist_items`, `find_duplicates_in_playlist`; `get_artist_top_tracks`, `get_available_markets`, and the seven `get_several_*` batch lookups; shared response shaping (`response_format`/`max_results`/`structuredContent`); fetch timeouts, TTL read cache, rate-limit visibility resource, opt-in mutation history, and the `spotify-mcp doctor` CLI |
| **Phase 11** | v1.19–1.21 wave: `import_playlist` (M3U/CSV), `remove_duplicate_playlist_items` + `clean_all_playlists`, `create_smart_playlist`, `show_new_episodes`, backup/restore, bug trio (#195/#196/#210) |
| **Phase 12** | **v1.22.0 big-release (2026-08-26): catalog/browse and artist-watch, library analytics, playlist health/batch/misc/portability, and playback/queue/search/episode tools — wired centrally with a smoke `FORBIDDEN_TOOLS` guard** |
| **Phase 13** | **v1.23.0 exhaust-remnants (2026-08-26): typed search, category helpers, catalog batch/validate, library insights, playlist operations, and freshness/scene/market tools** |
| **Phase 14** | **v1.24.0 exhaust2 swarm (2026-08-27): graceful-403 gating, playback/device/session, portability/analytics/workflow, playlist set-algebra/curation, and catalog typed-search depth** |
| **Phase 15** | **#638 (2026-09): February-2026 removal cleanup.** Retired `save_items`, `remove_saved_items`, `check_saved_items`, `follow_artists`, `unfollow_artists`, `get_categories` and `get_category_playlists`; migrated every surviving `PUT`/`DELETE /me/{type}s` and `GET /me/{type}s/contains` call site onto `/me/library` and `/me/library/contains`; made the positional `/me/library/contains` reads fail closed instead of defaulting a failed read to "not saved" |
| **Phase 16** | **v1.26.0 swarm3 push (2026-08-28): playback, playlist operations, discovery, library, podcast/session, listening analytics, Spotify reference, local snapshot, and registry-introspection tools — live gauntlet and `tools/list` verified** |
