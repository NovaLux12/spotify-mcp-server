# Architecture

How SpotifyMCP actually works, distilled from the source under `src/`. For the *what* (goals, contracts, full endpoint inventory), read [SPEC.md](SPEC.md); this document is the how-it-works companion and cross-references the spec where relevant.

## Component map

```mermaid
flowchart TD
    CLI["CLI dispatch (src/index.ts)<br/>auth / doctor / --help / --version / default"] --> MCP["McpServer<br/>name=spotify-mcp, version from package.json"]
    MCP --> T["StdioServerTransport<br/>(JSON-RPC over stdio)"]

    subgraph REG["generated tool-module inventory"]
        REGISTRY["src/tools/*.ts<br/>live tools/list registration"]
    end
    MCP --> REG

    MCP --> RES["resources/index.ts + resources/templates.ts<br/>fixed resources and RFC-6570 templates"]
    MCP --> PRM["prompts/index.ts<br/>workflow prompts (server-only, no client)"]

    REG --> C
    RES --> C
    C["SpotifyClient (src/client.ts)<br/>serialized queue + fetch timeouts + retries<br/>+ token refresh + rate-limit visibility"] --> API["api.spotify.com/v1"]
    AUTH["OAuth PKCE flow (src/auth.ts)<br/>runAuthFlow / loadTokens / saveTokens"] --> TOK[("~/.spotify-mcp/tokens.json<br/>(mode 600, SPOTIFY_MCP_TOKEN_FILE override)")]
    C -- "load + refresh" --> TOK
```

`index.ts` wires everything at startup: it creates one `SpotifyClient`, passes that shared instance to every active tool module and to the resource registrars, then connects a `StdioServerTransport`. The prompt registrar takes the server alone — it builds prose from arguments and needs no client. Registration is filtered by the resolved toolset (`SPOTIFY_MCP_TOOLSETS`, with `SPOTIFY_MCP_ENABLE_TOOLS`/`SPOTIFY_MCP_DISABLE_TOOLS` overrides) and, where applicable, granted Spotify scopes. `spotify_doctor` and the discovery trio (`find_tool`, `inspect_tool`, `toolset_report`) register outside toolset trimming; the trio is the discovery escape hatch for minimal toolsets and remains subject to the catalog scope gate. `verify_receipt` is likewise unconditional (#688): it reads an in-process map, so it needs no scope, and a trimmed session must still be able to look up a receipt its own mutation issued.

Tool modules load *behind* that gate (#906). The manifest holds a module specifier and a thunk rather than a static import, so `registerManifestModules` evaluates only the modules that are about to register — a module whose registration key is trimmed is never loaded at all — and then registers them in manifest order, which is why trimming the surface changes the tool list without reordering what is left. The resources and prompts registrars are imported dynamically for the same reason. Laziness changes *when* a module is evaluated, never *whether* a module that serves tools is measured: once registration returns, `startMcpServer` still runs the tool naming policy, the per-module schema budget gate, annotation application, the tool error boundary, and the aggregate surface budget gate — in that order, against the same live registry. A budget breach fails server startup, not just CI. `tests/lazy-module-loading.test.ts` proves both halves: that a trimmed module is genuinely never loaded (observed through an ESM `resolve` hook rather than the server's own bookkeeping, which would stay green if a static import reintroduced the cost elsewhere) and that each gate still trips over a lazily-built server.

## Authentication flows

Both flows share the same PKCE primitives (`code_verifier` = base64url of 32 random bytes, `S256` challenge, random 16-byte `state`) and the same token exchange against `https://accounts.spotify.com/api/token`. The redirect URI defaults to `http://127.0.0.1:8888/callback`; `SPOTIFY_REDIRECT_URI` overrides it, and the callback server's bind port and route path are **derived from that value** (#14), so an override such as `http://127.0.0.1:9000/callback` is honoured end-to-end.

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant A as auth.ts runAuthFlow
    participant B as Browser
    participant CB as Callback server on SPOTIFY_REDIRECT_URI port
    participant S as accounts.spotify.com
    participant F as tokens.json sidecar

    Note over A: code_verifier + S256 challenge + state generated up front
    A->>B: open(authorize URL with PKCE + state)
    U->>B: approves scopes
    B->>CB: GET /callback?code=...&state=...
    CB->>CB: validate state (CSRF), reject error param
    CB->>S: POST /api/token (code + code_verifier)
    S-->>CB: access_token, refresh_token, expires_in
    CB-->>U: "Authentication successful" page, server closes
    A->>F: saveTokens (mode 0600)

    alt SPOTIFY_HEADLESS=1
        A->>U: print authorize URL, prompt to paste
        U->>A: pastes full redirect URL
        A->>A: parseCallbackUrl - URL valid? error param? state match? code present?
        A->>S: POST /api/token (same exchange)
        S-->>A: tokens
        A->>F: saveTokens (mode 0600)
    end
```

The headless branch exists because the callback listener binds loopback on the machine running the MCP server (`127.0.0.1`, plus `::1` when the redirect host is `localhost`; otherwise the redirect host itself) — useful when that machine is remote (homelab, CI, agent runtime) and the operator's browser is elsewhere. `parseCallbackUrl` is a pure exported function so the state/error/code validation is unit-testable without network. When the browser flow rejects a callback carrying an OAuth `error` param, the failure page interpolates that value through `escapeHtml` before echoing it back (#19), so a crafted redirect cannot inject markup.

Tokens live in `~/.spotify-mcp/tokens.json` by default (`SPOTIFY_MCP_TOKEN_FILE` overrides it). Writes are atomic: `saveTokens` writes a `.tmp` sidecar with mode `0o600` and renames it over the target (#109), so a crash mid-write cannot leave a truncated file; granted OAuth scopes are persisted on the token object for the scope gates in `index.ts`.

## Request pipeline

Every HTTP call funnels through one private path inside `SpotifyClient`:
1. **Serialization (two-lane)** — `get`/`post`/`put`/`putRaw`/`delete` wrap their work in `enqueue()`, which lands the task on one of two priority lanes (`normal` for interactive calls, `low` for `getAllPages` walks — see [Request scheduling](#request-scheduling)). Requests are still issued strictly one at a time; a rejection is swallowed when re-linking the chain so one failure cannot poison subsequent calls.
2. **Inter-request gap** — before each request fires, the worker sleeps until at least 100 ms have passed since the previous request started.
3. **Rate-limit hold** — after any 429, `_rateLimitUntil` is set to now + `Retry-After` seconds; every later queued request additionally waits out that deadline. The `Retry-After` header is parsed by `parseRetryAfter`, which reads **both** RFC 9110 forms — delta-seconds and HTTP-date (all three of IMF-fixdate, RFC 850 and asctime) — because a `parseInt` read the date form as `NaN` and fell to the 1 s floor, retrying a window Spotify had said was minutes away and earning another 429. A past HTTP-date means retry-now, not a backwards wait; absent, unparsable, or letter-free values (`-5`, which `Date.parse` would otherwise read as a year) keep the 1 s floor, so garbage can no longer poison the deadline with `NaN` (#20, #675). The response body's `error.reason` is inspected: `QUOTA_EXCEEDED` throws immediately (with the quota message), and bursts with `Retry-After` > 10 s fail fast with the wait surfaced in the error; only small bursts are slept off in-queue (`_lastThrottle`) and retried once. Every throttle event is recorded as `_lastThrottle` (`retryAfterSec`, `waitedMs`, timestamp) and surfaced read-only via the `spotify://me/rate-limit` resource, so agents can make informed wait-vs-abort decisions without burning another tool call.
4. **Token freshness** — the token file is read once per client and memoised on a cached promise; a failed load is deliberately *not* memoised, so the next call retries from disk (e.g. after the user re-runs `spotify-mcp auth`). `ensureValidToken()` proactively refreshes when `Date.now()` is within 60 s of `expires_at`. If a call nonetheless comes back **401**, the client refreshes and retries exactly once; if that refresh throws, the original **401** is what surfaces (with the refresh reason in its message), because a failure of the token service says nothing about the caller's arguments (#1007). `doRefreshTokens` first re-reads the token file and adopts a fresher sidecar written by another process (#109); otherwise it refreshes using the stored `refresh_token`, persisting a rotated one if Spotify issues it. Malformed `expires_in` is treated as already expired so a dead token never sticks. Refresh failure throws `SpotifyApiError` with the message `Token refresh failed — re-run "spotify-mcp auth"` for revoked grants — status **401**, not the token endpoint's own 400, so the error boundary reports it as `auth` and not as "invalid arguments" (#1007). Any other token-service failure throws **503** (upstream status kept in the message) for the same reason; transient outages ride out on a still-valid access token.
5. **Fetch timeout** — every outbound call (API requests and the token-exchange/refresh calls alike) carries an `AbortSignal.timeout`, defaulting to 30 s and overridable via `SPOTIFY_REQUEST_TIMEOUT_MS`. An aborted call surfaces as `SpotifyApiError` ("`<METHOD> <url>` timed out after Ns") instead of hanging its queue slot indefinitely.
6. **Bounded 5xx and transport retry (#675)** — statuses `502`/`503`/`504` get retried inside a shared attempt budget of `MAX_ATTEMPTS = 3` (one initial dispatch plus two retries), spent jointly with the 401-refresh and the 429 backoff so no combination of them can loop. `500` is deliberately excluded: it is Spotify's own logic failing, and re-sending does not help. The wait is `Retry-After` when the response carries one, otherwise jittered exponential backoff — 250 ms · 2ⁿ plus a uniform 0–250 ms. The jitter is load-bearing, not decoration: every spotify-mcp process sharing one developer account sees the same 5xx at the same moment, and an unjittered exponential marches them all back in lockstep. A wait above the 10 s in-queue cap fails fast with the wait named in the error rather than parking the serialized queue, and a 5xx never arms `_rateLimitUntil` — that window belongs to 429 alone, and arming it on one flaky route would block every queued call behind it. A *thrown* transport error (DNS, `ECONNRESET`) is retried only for an idempotent verb (`GET`/`HEAD`/`PUT`/`DELETE`/`OPTIONS`): we never received an answer, so we never learned whether the request was applied, and re-sending a `POST` that already mutated something would silently double-apply it. Because Spotify *did* answer a 5xx, that path is safe to re-send for any verb. Exhausted transport failures are wrapped as `SpotifyApiError(503, "<METHOD> <url> failed: <cause>")` — an untyped `TypeError` would reach the tool error boundary as `internal`, which advises a blind re-run of the whole tool, exactly the retry that double-applies a mutation. A synthesized 408 timeout is passed through unchanged.
7. **Error model** — non-OK responses throw `SpotifyApiError(status, message)` where the message prefers Spotify's own `error.message` from the JSON body verbatim (e.g. "Player command failed: Premium required"). Only when the body is missing, lacks `message`, or isn't JSON does it fall back to `genericMessageFor(status)`: a hint for 403, a not-found line for 404, an availability line for 503, and a generic `"Spotify API error <status>"` otherwise. This ordering is deliberate — earlier revisions rewrote every 403 to "requires Premium", which mislabeled scope/regional/deprecation failures. A **304** is the one non-OK status that is not itself a failure: a 304 backed by a stored validator is a successful read answered from the validator (step 10), and only an unbacked one throws.
8. **Pagination** — `getAllPages<T>()` walks offset-paginated endpoints through the *same* two-lane scheduler as a `low`-priority task (each page is a normal queued `get`). It accumulates items until offset passes the server-reported `total`, the page returns zero items, or the cap is hit — the configured fetch-all cap by default (**500**, via `SPOTIFY_MCP_FETCH_ALL_CAP`), overridable per call via `{ maxItems }` (result sliced to the cap). `opts.initialOffset` seeds the cursor so callers resuming mid-list continue where they left off. Each walk carries a monotonic id which `index.ts` forwards as the `progressToken` of MCP `notifications/progress` events (best-effort; a throwing reporter never breaks a walk). Cursor-paginated endpoints (e.g. followed artists, which use an `after` cursor) remain explicit per-call loops.
9. **Read cache (#54)** — `src/cache.ts` provides an `LruTtlCache` (5-minute TTL, LRU eviction by default) plus a bypass policy (`shouldBypassCache`: never cache non-GET requests or volatile `/me/player*` and `/me/top*` paths, which covers recently-played) and a `ValidatorStore` for conditional reads (step 10). `get()` consults the cache before enqueueing and stores successful JSON responses after fetch; every successful mutation calls `afterMutation()`, which drops the whole cache (a mutation may invalidate any cached object) and records the mutation in the opt-in history JSONL.
10. **Request/quota usage tracking (#904)** — the drain path maintains a cumulative counter plus per-request timestamps (pruned to the longest exposed window). `getRateLimitStatus()` exposes `requestsTotal` / `requestsLastMinute` / `requestsLastHour`; cache hits bypass the queue and cost nothing, so they are not counted. Heavy composite scans consult the shared cooldown first (`quotaPreflight`: blocked scans return an actionable wait message and issue 0 requests) and otherwise shrink their walk budget to the remaining quota window (`quotaWindowRemaining`), disclosing `requests_made` plus `requests_planned`/`budget_shrunk` in payloads. `spotify_doctor` and the `spotify://me/rate-limit` resource report the same counts.
11. **Conditional reads (#601)** — `src/cache.ts` also provides a `ValidatorStore`: for every response carrying an `ETag`, the payload and its tag are kept per cache key (default 1-hour validator window, LRU-bounded, dropped wholesale by `afterMutation()`). The next read of that key sends `If-None-Match`. `rawRequest` returns **304** before the `!res.ok` error mapping — it is a successful conditional read, not a failure — and `get()` answers it from the validator, refreshes the entry's timestamp, and fires `opts.onNotModified` so a watch loop can branch (`unchanged: true` in the `structuredContent` of the `get_now_playing` / `get_currently_playing` polls). A stored payload is never served unvalidated: on volatile paths the request still goes out every time, and only the 304 short-circuits the body. A body that arrives without an `ETag` supersedes the stored validator, and a 304 with no validator behind it — which cannot be answered honestly — throws `SpotifyApiError(304, …)` carrying the reason `NOT_MODIFIED_WITHOUT_VALIDATOR`, because the error boundary has no 304 case of its own and would otherwise report an unnamed internal failure a host can do nothing with (#1007's lesson). Poll recipe: [Cookbook §11](docs/cookbook.md).

## Second upstream: stats.fm (v2 — implemented)

Spotify is the system of record for playback, library, and catalog. stats.fm rides alongside as a **second upstream** for lifetime listening history, cross-range top lists, and taste aggregates. The network-backed `src/tools/statsfm.ts` and `src/tools/statsfm_taste.ts` tools are read-only; the local `statsfm_record_feedback`/`record_feedback` tools write one bounded JSON sidecar (`~/.spotify-mcp/taste-feedback.json`) and touch neither Spotify nor stats.fm. `response_format` is on all 38 `statsfm_*` tools and `max_results` on 20 of them; the other 18 are single-object or fixed-shape reads that take `response_format` alone. That set is not just the obvious aggregates — it is every per-entity `*_stats`/`*_date_stats` read, every `statsfm_catalog_*` lookup, `statsfm_search`, `statsfm_resolve_user`, `statsfm_friend_count`, `statsfm_artist_affinity`, `statsfm_exposure_check` and `statsfm_record_feedback`, and it is worth reading the tool schemas rather than inferring membership from a name. Results carry `structuredContent`. Network tools have no `dry_run`, receipts, or history JSONL. Identity is a stats.fm user ID, not OAuth — passed per call as `user_id` or `statsfm_user`, with `STATSFM_USER_ID` supplying a default that an explicit argument overrides. Full guide: `docs/statsfm.md`.

```mermaid
flowchart LR
    T["statsfm.ts tools (read-only)"] --> SC["StatsfmClient<br/>paced queue + range/limit shaping"] --> SF["stats.fm API"]
    T --> ACT["Spotify write tools<br/>(search / create / add)"]
```

## Tool and response layer

Each `register*Tools(server, client)` function calls `server.tool(...)` or, for tools needing richer metadata, `server.registerTool(...)`. The glob is not the whole registrar surface: `registerDoctorTool` (`spotify_doctor`), `registerSearchDeepTool` (`search_deep`), `registerPrompts`, `registerResources`, `registerTemplateResources`, and the manifest's own `registerManifestModule`/`registerManifestModules` also register against the server, and a grep for `register*Tools` finds none of them:

- **Input validation** — per-tool zod schemas (strings, enums with `.default(...)`, `.optional()` flags, `.describe(...)` help text). The SDK validates arguments before the handler runs.
- **Handlers** — thin orchestration: one or more `client.get/post/put/delete/getAllPages` calls against typed response shapes from `src/types/spotify.ts`.
- **Mutation conformance guard (#920)** — `tests/mutations.conformance.test.ts` enumerates the live registry via `tools/list` and asserts every write-capable tool exposes `dry_run` and `response_format` unless allowlisted with a one-line reason (local sidecars only); known gaps pending sibling slices are pinned in `KNOWN_MISSING_*` lists.
- **Output formatting** — a tool takes a `response_format` parameter (`'concise'` default, `'detailed'`, or `'json'`): concise renders human-readable lines via per-module helpers like `formatDuration(ms)` and `formatItem(item: RenderableItem)` — these are module-local, not shared from `src/shaping.ts`; detailed adds context; json returns a machine-readable payload. The parameter is not universal, and the surface is not meant to be read as uniform: `tests/mutations.conformance.test.ts` enforces it on every write-capable tool, the write tools still missing it are pinned in that file's `KNOWN_MISSING_RESPONSE_FORMAT` list, and `verify_receipt` takes only `receipt_id`. Read that list rather than assuming the contract holds everywhere. List tools take `max_results` (default `SPOTIFY_MCP_MAX_ITEMS`) and attach `structuredContent` plus pagination info; the walk-bounded scans return their whole `SPOTIFY_MCP_FETCH_ALL_CAP` walk instead and disclose `fetch_all_cap`/`truncated_by_cap` when the bound bites; destructive ops take `dry_run` and mutations emit batch summaries.
- **Transport** — the MCP SDK's `StdioServerTransport` carries JSON-RPC between the host (e.g. Claude Desktop) and this process; nothing else listens on the network during normal operation.

Resources are registered through `server.resource(...)` as fixed `spotify://` URIs and RFC-6570 templates. Every fixed URI has a `{?format}` template twin, selected with `?format=json`; playlist tracks and catalog entities also have query-absorbing `{+qs}` twins where required. The generated inventory below is derived from `resources/list` and `resources/templates/list`, so it includes saved tracks/audiobooks, following, history, and genre heatmap resources without a second hand-maintained list.

## Module map

<!-- BEGIN:generated surface-census -->
A server started with no `SPOTIFY_MCP_TOOLSETS` registers **128 tools** (144,870 bytes of schema) — the curated default surface (#889). `SPOTIFY_MCP_TOOLSETS=all` registers all **556 tools**, along with **17 fixed resources**, **28 resource templates**, and **14 prompts**. Toolsets and production gates can trim a configured host further; both figures describe a real production `tools/list` after finalizers. The tool surface is attributed to 68 files under `src/tools/`.
<!-- END:generated surface-census -->

The table is generated from every TypeScript file recursively under `src/`, including nested `lib/`, `resources/`, `prompts/`, `tools/`, and `types/` modules. Tool counts come from real registrations (including loop factories). `Schema bytes` is what that file's tools add to a host's `tools/list` payload — the same per-module measurement `docs/schema-budgets.md` gates, and `—` for a runtime module that registers no tools.

That column replaced a per-file line count (#1398), and why is worth keeping: a line count is invalidated by *any* edit that changes a file's length — a comment, a blank line, a reformat — while the block's subject matter is what a file registers. So the block went red for edits that changed nothing it documents. It put `main` red twice (#1360, #1380) and cost three agents two `--write` cycles each. Schema bytes move exactly when the documented surface moves, and they answer the question a module map is read for: which module costs a host context. Line counts ranked that backwards — `src/client.ts` is the largest module in this table and registers nothing, while several of the largest schema contributors are mid-sized files.

<!-- BEGIN:generated module-map -->
| File | Responsibility | Schema bytes |
|---|---|---:|
| `src/accountkey.ts` | The account key that separates per-account on-disk stores. (0 registered tools) | — |
| `src/accounts.ts` | The account registry (#602): which local accounts exist, and which one this session is acting as. (0 registered tools) | — |
| `src/actingaccount.ts` | The acting-account echo (#602). (0 registered tools) | — |
| `src/artistreleases.ts` | One canonical artist-release probe (#900). (0 registered tools) | — |
| `src/audiobookview.ts` | The audiobook and chapter prose renderers, shared by the audiobook tools and the `spotify://audiobook/{id}`, `spotify://audiobook/{id}/chapters` and `spotify://chapter/{id}` resource templates (#603). (0 registered tools) | — |
| `src/auth.ts` | Runtime module for src/auth.ts. (0 registered tools) | — |
| `src/branding.ts` | The non-affiliation notice (#705) — the one place that owns the wording. (0 registered tools) | — |
| `src/cache.ts` | Tiny LRU + TTL cache used by SpotifyClient for immutable catalog reads (#54). (0 registered tools) | — |
| `src/cachepersist.ts` | Optional cross-process persistence for the immutable read cache (#893, A16-019). (0 registered tools) | — |
| `src/cancellation.ts` | Per-request cancellation context for MCP `tools/call` (#676). (0 registered tools) | — |
| `src/chunk.ts` | The batch-size policy for the whole server, in one place (#512, #583). (0 registered tools) | — |
| `src/client.ts` | Runtime module for src/client.ts. (0 registered tools) | — |
| `src/concurrency.ts` | Bounded-concurrency fan-out for the freshness-radar walks (#783). (0 registered tools) | — |
| `src/config.ts` | Central configuration loader for the SPOTIFY_MCP_* environment family. (0 registered tools) | — |
| `src/cover-image.ts` | Shared cover-image helpers for the three playlist cover tools (#880). (0 registered tools) | — |
| `src/csvsafe.ts` | CSV cell rendering shared by every writer that emits a spreadsheet (#630). (0 registered tools) | — |
| `src/derivedanalytics.ts` | The derived-listening-analytics opt-in (#695). (0 registered tools) | — |
| `src/devices.ts` | The one device line, shared by the `get_devices` tool and the `spotify://player/devices` resource (#603). (0 registered tools) | — |
| `src/gating.ts` | The app-registration-gated error contract (#791, #428, #429; audit A14-016/A8-036) -- the graceful 403 mapping for Spotify's app-registration-gated endpoint family, classified from Spotify's February 2026 changelog and its endpoint reference pages. (0 registered tools) | — |
| `src/history.ts` | Opt-in mutation history JSONL (#64, hardened in #628). (0 registered tools) | — |
| `src/http.ts` | The opt-in Streamable HTTP transport (#599). (0 registered tools) | — |
| `src/index.ts` | Runtime module for src/index.ts. (0 registered tools) | — |
| `src/lib/statsfm-client.ts` | The one stats.fm HTTP client (#907). (0 registered tools) | — |
| `src/logout.ts` | `spotify-mcp logout` — disconnect this machine from a Spotify account (#704). (0 registered tools) | — |
| `src/markets.ts` | Runtime module for src/markets.ts. (0 registered tools) | — |
| `src/paths.ts` | Local-path confinement for export/import tools (#622). (0 registered tools) | — |
| `src/playbackstores.ts` | Playback sidecar stores and the one device resolver (#848). (0 registered tools) | — |
| `src/playlistmatch.ts` | The one duplicate and artist matching vocabulary shared by every playlist tool (#885). (0 registered tools) | — |
| `src/positionbase.ts` | One vocabulary for playlist position bases (#883). (0 registered tools) | — |
| `src/progress.ts` | Ambient progress-token context for MCP `tools/call` requests (#728). (0 registered tools) | — |
| `src/prompts/index.ts` | Runtime module for src/prompts/index.ts. (0 registered tools) | — |
| `src/queueanalysis.ts` | Local analyses over one `GET /me/player/queue` read (#847). (0 registered tools) | — |
| `src/receipts.ts` | Mutation receipts (#112 idea 11). (0 registered tools) | — |
| `src/refs.ts` | Shared Spotify reference parser and resolver. (0 registered tools) | — |
| `src/removed.ts` | Spotify's February 2026 RESPONSE-FIELD removals (#639) — the one place this repository records which fields the Web API stopped returning. (0 registered tools) | — |
| `src/resources/index.ts` | Runtime module for src/resources/index.ts. (0 registered tools) | — |
| `src/resources/register.ts` | The one registration order for the read surface (#685). (0 registered tools) | — |
| `src/resources/templates.ts` | RFC-6570 resource templates over single-get catalog endpoints (#111, pattern 2). (0 registered tools) | — |
| `src/resources/uritemplate.ts` | RFC 6570-conformant matching for the URI templates this server advertises (#1401). (0 registered tools) | — |
| `src/result.ts` | The one place a tool result is built (#582). (0 registered tools) | — |
| `src/scopefilter.ts` | Scope-aware module gating (#111 item 6). (0 registered tools) | — |
| `src/serverinstructions.ts` | The `instructions` string a host receives in the `initialize` response (#690), built on the non-affiliation notice #705 put there. (0 registered tools) | — |
| `src/shaping.ts` | Shared shaping helpers for tool responses (#51/#52/#53/#57/#58): zod schema fragments, truncation math, pagination info, structuredContent emission, mutation batch summaries and dry-run descriptions. (0 registered tools) | — |
| `src/sidecar.ts` | Shared policy for local JSON sidecars (#839, #1051). (0 registered tools) | — |
| `src/tools/accounts.ts` | `list_accounts` and `switch_account` (#602). (2 registered tools) | 1,644 |
| `src/tools/analytics.ts` | Runtime module for src/tools/analytics.ts. (3 registered tools) | 1,908 |
| `src/tools/annotations.ts` | MCP tool annotations (#565 / A0-002, A4-005). (1 registered tool) | 626 |
| `src/tools/artistwatch.ts` | Runtime module for src/tools/artistwatch.ts. (6 registered tools) | 6,284 |
| `src/tools/audiobookcopilot.ts` | Audiobook chapter copilot (#112 idea 4): tools for navigating long-form audiobooks — full chapter tables regardless of the ~18-chapter app break (bounded by the fetch-all cap, and the bound is disclosed), 1-based chapter jumps, and "where was I?" (3 registered tools) | 1,985 |
| `src/tools/audiobooks.ts` | Runtime module for src/tools/audiobooks.ts. (4 registered tools) | 3,715 |
| `src/tools/backup.ts` | Library backup (#159): snapshot the entire reachable library — liked tracks, saved albums/shows/episodes/audiobooks, followed artists and every playlist (with items) — into a timestamped local JSON file plus a bounded metadata sidecar used by list_backups. (2 registered tools) | 1,632 |
| `src/tools/backup_delete.ts` | `delete_backup` — the one destructive tool in the library backup family (#1017), split out of backup.ts so the manifest can give it its own row. (1 registered tool) | 959 |
| `src/tools/backupfirst.ts` | backup_first (#216): pre-flight snapshot for account-wide destructive tools. (1 registered tool) | 513 |
| `src/tools/browse.ts` | Runtime module for src/tools/browse.ts. (1 registered tool) | 436 |
| `src/tools/catalog.ts` | Runtime module for src/tools/catalog.ts. (31 registered tools) | 27,222 |
| `src/tools/confirm.ts` | Elicitation-gated confirmation for destructive playlist operations (#111 item 5). (0 registered tools) | — |
| `src/tools/doctortool.ts` | spotify_doctor (#111 idea 9 + #228): the diagnostic report, as an in-server TOOL so MCP agents can self-diagnose the most common failure class — missing/expired tokens, scope gaps between the auth-time grant and the write tools exposed by the active toolsets, Premium gating they cannot introspect, and an active rate-limit cooldown. (1 registered tool) | 750 |
| `src/tools/episodemgmt.ts` | episodemgmt (#204, #187, #230): archive_played_episodes. mark_episode_played was removed in #230 — PUT /me/episodes/{id} with resume_point is not a real Spotify endpoint (real endpoint is PUT /me/episodes?ids= to save). The tool swallowed 404s and reported ok:true, which was phantom success. Removed per #85 precedent. (1 registered tool) | 1,053 |
| `src/tools/exhaust2_catalog.ts` | exhaust2 catalog slice — feature swarm v1.24.0 (issues #332–#357). (19 registered tools) | 19,443 |
| `src/tools/exhaust2_enggating.ts` | exhaust2 enggating slice -- now a registration placeholder only (#791). (0 registered tools) | 0 |
| `src/tools/exhaust2_extra.ts` | exhaust2 extra slice — the final three playlists-surface tools (#398-#400). (3 registered tools) | 4,092 |
| `src/tools/exhaust2_misc.ts` | exhaust2 misc slice — feature swarm v1.24.0. (27 registered tools) | 24,316 |
| `src/tools/exhaust2_playback.ts` | exhaust2 playback slice — feature swarm v1.24.0 (issues #358-#379). (18 registered tools) | 14,279 |
| `src/tools/exhaust2_playlists.ts` | exhaust2 playlists slice — feature swarm v1.24.0 (issues #380–#400). (18 registered tools) | 24,403 |
| `src/tools/exhaustmisc.ts` | exhaustmisc — mop-up for the 60-issue exhaustive sweep. (10 registered tools) | 7,876 |
| `src/tools/export.ts` | export_playlist (#155): dump a playlist's full item list as an M3U or CSV document — either written to a local file (mode 0600) or returned inline (truncated at max_results rows with a footer noting the full length). (1 registered tool) | 1,363 |
| `src/tools/following.ts` | Runtime module for src/tools/following.ts. (3 registered tools) | 2,502 |
| `src/tools/freshness.ts` | freshness radar (#112 idea 2): personal replacement for the removed /browse/new-releases surface. (1 registered tool) | 2,672 |
| `src/tools/import.ts` | import_playlist (#165): the inverse of export_playlist. (1 registered tool) | 1,322 |
| `src/tools/library.ts` | Runtime module for src/tools/library.ts. (13 registered tools) | 12,814 |
| `src/tools/libraryanalytics.ts` | Runtime module for src/tools/libraryanalytics.ts. (3 registered tools) | 2,498 |
| `src/tools/libraryhygiene.ts` | Album completion & consolidation hygiene (#112 idea 5). (1 registered tool) | 754 |
| `src/tools/libraryinsights.ts` | Runtime module for src/tools/libraryinsights.ts. (3 registered tools) | 2,751 |
| `src/tools/moodexpand.ts` | `expand_mood_to_queries` — the one judgement step the mood prompts used to re-invent in prose, extracted into a testable tool (#598). (1 registered tool) | 987 |
| `src/tools/personalization.ts` | Runtime module for src/tools/personalization.ts. (3 registered tools) | 2,532 |
| `src/tools/playback.ts` | Runtime module for src/tools/playback.ts. (15 registered tools) | 14,441 |
| `src/tools/playbackext.ts` | playbackext (#197, #206, #198, #180, #181): local sidecar persistence for playback states, device naming/volume presets, listening sessions, smart rules, show digest. (13 registered tools) | 8,331 |
| `src/tools/playbackintel.ts` | playbackintel — exhaustive playback/queue/player intel (#272-283 slice) 11 tools: play_on, queue_next, describe_listening_session, play_at, device_health, seek_relative, playback_timeline, repeat_queue_toggle, now_playing_history, playback_compare_states, peek_next #847 retired describe_queue into `get_queue` view='enriched'. + triage extras: get_playback_context, volume_step, market_availability Each tool states its quota cost in words in the description. (13 registered tools) | 10,315 |
| `src/tools/playbackpositions.ts` | The canonical playback-position record (#846). (0 registered tools) | — |
| `src/tools/playlistbatch.ts` | Playlist batch operations — Stream D (#183, #189, #200). (3 registered tools) | 4,896 |
| `src/tools/playlistdna.ts` | Runtime module for src/tools/playlistdna.ts. (1 registered tool) | 1,310 |
| `src/tools/playlistfollow.ts` | Playlist follow/unfollow (#1005, #1099), split out of playlistmisc.ts. (4 registered tools) | 3,027 |
| `src/tools/playlisthealth.ts` | Runtime module for src/tools/playlisthealth.ts. (8 registered tools) | 5,713 |
| `src/tools/playlistmisc.ts` | Playlist misc (#208): mood-vibe template playlists composed from the user's existing library/top data. pin/unpin (follow/unfollow) moved to playlistfollow.ts: they call /me/library, which authorises a different either-of scope set than the playlist-modify pair this file's tools need (#1005), so they need their own manifest row to be gated honestly. (1 registered tool) | 1,089 |
| `src/tools/playlistops.ts` | Playlist power tools (#96): merge_playlists, diff_playlists, overlap_playlists. (3 registered tools) | 4,392 |
| `src/tools/playlistreceipts.ts` | Shared receipt plumbing for the playlist write helpers (#879). (0 registered tools) | — |
| `src/tools/playlists.ts` | Runtime module for src/tools/playlists.ts. (26 registered tools) | 26,562 |
| `src/tools/podcastsession.ts` | Podcast session composer (#112 idea 3): greedy-packs the user's saved podcast episodes into a listening session of a fixed length in minutes, then (optionally) starts it on a device. (2 registered tools) | 3,427 |
| `src/tools/portability.ts` | Portability (#188 + #192 + #238 + #240 + #223 + #220): save_discover_weekly / save_release_radar (archive personalized playlists) + export_library_json / export_followed_artists + export_profile_state/import_profile_state + export_listening_history (11 registered tools) | 10,453 |
| `src/tools/provenance.ts` | Purpose + provenance for a write that stored Spotify data drives (#708). (0 registered tools) | — |
| `src/tools/queueops.ts` | queueops (#194, #202, #224, #231): queue_playlist + save_queue_as_playlist. queue_reorder / queue_remove / queue_clear were removed in #231 — those endpoints do not exist (only GET and POST /me/player/queue are real). (3 registered tools) | 3,293 |
| `src/tools/restore.ts` | restore_library_snapshot (#160): STRICTLY ADDITIVE restore of a library snapshot produced by backup_library (#159 contract). (1 registered tool) | 2,072 |
| `src/tools/rewritable.ts` | The unavailable-row guard for full-sequence playlist rewrites (#860), and the truncated-read guard for the same commit path (#1310). (0 registered tools) | — |
| `src/tools/saveddedupe.ts` | Saved-track duplicate detection (#156). (1 registered tool) | 1,438 |
| `src/tools/scenes.ts` | Named playback scenes (#112 ideas 7+12): save/apply/list/delete reusable "profiles" (device + volume + shuffle/repeat + context) stored in a local JSON sidecar at ~/.spotify-mcp/scenes.json (override with SPOTIFY_MCP_SCENES_FILE). (7 registered tools) | 4,514 |
| `src/tools/search.ts` | Runtime module for src/tools/search.ts. (1 registered tool) | 1,821 |
| `src/tools/searchdive.ts` | Runtime module for src/tools/searchdive.ts. (1 registered tool) | 1,683 |
| `src/tools/searchhistory.ts` | searchhistory (#205): search_history + search_rerun (90-day expiry, sidecar). (2 registered tools) | 1,096 |
| `src/tools/showradar.ts` | show_new_episodes (#173): new-episode radar across saved podcast shows. (1 registered tool) | 2,125 |
| `src/tools/smart.ts` | create_smart_playlist (#172): rule-based playlist generation from the user's OWN listening data — top tracks, recently played, or saved tracks — with optional artist filtering and per-artist uniqueness. (1 registered tool) | 2,364 |
| `src/tools/statsfm.ts` | stats.fm tools (read-only): listening stats, tops, catalog and social lookups against the public stats.fm API. (30 registered tools) | 29,181 |
| `src/tools/statsfm_taste.ts` | stats.fm taste-intelligence slice (v2 taste track). (8 registered tools) | 8,224 |
| `src/tools/swarm3_analytics.ts` | swarm3 analytics slice — 500-tool swarm v1.26.0 (issue #442). (15 registered tools) | 12,030 |
| `src/tools/swarm3_discovery.ts` | swarm3 discovery slice — 500-tool swarm v1.26.0 (issue #442). (24 registered tools) | 22,483 |
| `src/tools/swarm3_library.ts` | swarm3 library slice — feature swarm v1.25.0 (500-tool push, branch swarm3-500-tools). (24 registered tools) | 18,283 |
| `src/tools/swarm3_meta.ts` | swarm3 meta slice — 500-tool swarm v1.26.0 (issue #442). (3 registered tools) | 2,023 |
| `src/tools/swarm3_playback.ts` | swarm3 playback slice — 500-tool swarm v1.26.0 (issue #442). (17 registered tools) | 10,006 |
| `src/tools/swarm3_playlistops.ts` | swarm3 playlistops slice — 500-tool swarm v1.26.0 (issue #442). (24 registered tools) | 29,163 |
| `src/tools/swarm3_refs.ts` | Curated local Spotify-reference tools (#915). (6 registered tools) | 4,331 |
| `src/tools/swarm3_shows.ts` | swarm3 shows slice — 500-tool swarm v1.26.0 (issue #442). (24 registered tools) | 22,103 |
| `src/tools/swarm3_snapshots.ts` | swarm3 snapshots slice — 500-tool swarm v1.26.0 (issue #442). (24 registered tools) | 23,731 |
| `src/tools/swarm3b_discovery.ts` | swarm3b discovery slice (second discovery builder) — 500-tool swarm v1.26.0 (issue #442). (24 registered tools) | 20,147 |
| `src/tools/swarm4_playlists.ts` | swarm4 playlists slice — feature swarm v1.25.0 (issues #420–#437). (18 registered tools) | 23,228 |
| `src/tools/taste_composites.ts` | Wave-2 taste composites: 10 composite tools over the stats.fm PUBLIC API v1 (no auth), shaping taste data into playlist specs, briefs, and reports. (10 registered tools) | 10,242 |
| `src/tools/taste_playlist.ts` | `taste_to_playlist` — the one writer in the taste composite family (#1009). (1 registered tool) | 1,884 |
| `src/tools/undo.ts` | Undo for receipt-driven mutations (#217, #625). (2 registered tools) | 1,663 |
| `src/tools/users.ts` | Runtime module for src/tools/users.ts. (2 registered tools) | 1,696 |
| `src/toolsets.ts` | Toolsets (#95): coarse-grained grouping of registration entry points so an operator can trim the server's exposed surface via `SPOTIFY_MCP_TOOLSETS` (e.g. "playback,library" for a car dashboard, or "catalog,personalization" for a read-only recommender). (0 registered tools) | — |
| `src/types/spotify.ts` | Token storage schema (0 registered tools) | — |
<!-- END:generated module-map -->

## Request scheduling

Inside `SpotifyClient`, the old single FIFO queue is now a **two-lane scheduler** (#133): each enqueued request carries a priority — `normal` for interactive tool calls, `low` for background walks like `getAllPages`. The drain loop picks via `selectNextLaneTask`: a normal task wins unless the oldest low task has been waiting ≥ `LOW_AGING_MS` (**15 s**), in which case it is promoted so bulk pagination can never starve quick reads indefinitely. FIFO order holds within a lane, and pacing (100 ms gap) and rate-limit holds apply to every task regardless of lane.

<details><summary>Resolved design tensions (historical)</summary>

All previously listed tensions are resolved — kept here as a record:

- ~~Non-atomic token writes~~ — **resolved** (#109): `saveTokens` writes a `.tmp` file with mode `0600` and `rename`s it over `tokens.json` (POSIX rename is atomic).
- ~~Single-process refresh race~~ — **mitigated** (#109): `doRefreshTokens` re-reads `TOKEN_FILE` before refreshing and adopts a fresher sidecar if present. No file lock, so two simultaneous refreshes can both hit the network, but neither clobbers a fresher file. `invalid_grant` → "re-run auth"; transient 5xx rides out on a still-valid token.
- ~~Retry budget is per-request, fixed at one~~ — **changed** (#133-era 429 handling): `QUOTA_EXCEEDED` throws immediately; burst limits with `Retry-After` > 10 s fail fast; only small bursts (≤10 s) are slept and retried. `_rateLimitUntil` still gates every later enqueued request.
- ~~5xx and transport errors are thrown straight back to the tool~~ — **changed** (#675): a transient 502/503/504 now rides out on a bounded, jittered backoff instead of failing the call, and a transport blip is retried for idempotent verbs and reported as a typed 503 rather than a raw `TypeError`. The budget is `MAX_ATTEMPTS = 3`, shared with the 401-refresh and 429 paths.

Interactive starvation is addressed by the two-lane scheduler above. Throttle visibility is served centrally by the `spotify://me/rate-limit` resource and `spotify_doctor` — `SpotifyClient.takeThrottleNotice()` is a public method, so an embedder holding a client reaches it there; it is not a module-level export.

</details>
