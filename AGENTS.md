# AGENTS.md — working on SpotifyMCP

This repository wraps the Spotify Web API as an MCP server. The rules below are
the ones that are easy to get wrong and expensive when you do. The Spotify
account-level rules (scopes, redirects, blocked endpoints) encode facts you
cannot infer from the code. The repo-level rules (gates, manifests, budgets)
encode the reasons the tree is shaped the way it is.

- **Contribution and release process for humans:** CONTRIBUTING.md
- **Tool contracts:** SPEC.md
- **Architecture and module map:** ARCHITECTURE.md
- **Env vars:** docs/configuration.md
- **Schema budgets:** docs/schema-budgets.md

---

## 1. Spotify facts you must not guess

The authoritative source is the official OpenAPI schema, not your memory:

- **OpenAPI schema:** https://developer.spotify.com/reference/web-api/open-api-schema.yaml
- **API reference:** https://developer.spotify.com/documentation/web-api/reference

Do not guess endpoint paths, query parameter names, or response field names.
Look them up. Spotify will 400 on a wrong query parameter name and this server
has shipped more than one such bug (see §6).

### Authorization

- Use **Authorization Code with PKCE** for all user-specific data. This is what
  the server implements; only a Client ID is needed, there is no client secret.
  - https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow
- The **Authorization Code flow** with a client secret on a secure backend is
  also acceptable if a backend component is added.
  - https://developer.spotify.com/documentation/web-api/tutorials/code-flow
- Use **Client Credentials** only for non-user, public catalog data.
- **Never use the Implicit Grant flow.** It is deprecated by Spotify.

### Redirect URIs

- Always use `https://` redirect URIs in production.
- For local development, use `http://127.0.0.1` — not `http://localhost`.
  The default is `http://127.0.0.1:8888/callback` and it must be registered
  exactly in the Spotify Developer Dashboard.
- Never use wildcard URIs.
- https://developer.spotify.com/documentation/web-api/concepts/redirect_uri

### OAuth scopes

- Request only the **minimum scopes** required for the feature.
- Do not request broad scopes preemptively "just in case."
- https://developer.spotify.com/documentation/web-api/concepts/scopes

### Token management

- Store tokens in a local file with restricted permissions (mode 600), never in
  source control. Never commit tokens or `.env`.
- **Never expose the Client Secret in client-side or committed code.**
- Always implement token refresh. Access tokens expire after one hour.
- https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens

### Rate limiting

- On HTTP **429**, read the `Retry-After` header and wait that many seconds
  before retrying.
- Use **exponential backoff** for repeated failures.
- Never retry immediately in a tight loop.

### Error handling

- Handle the codes documented in the OpenAPI schema. Read `error.message` from
  Spotify's error body and surface it — do not replace it with a blanket
  "requires Spotify Premium" claim.
  - `401` — token expired; refresh and retry once.
  - `403` — forbidden (commonly Premium required, or a deprecated endpoint).
    Say so clearly.
  - `404` — entity not found.
  - `429` — rate limited; see above.
  - `503` — Spotify service unavailable; retry with backoff.

### Developer Terms of Service

- Do not cache Spotify content beyond what is needed for immediate use.
- Always attribute content to Spotify where displayed.
- Do not use the API to train machine learning models on Spotify data.
- https://developer.spotify.com/terms

---

## 2. Endpoints that are blocked or deprecated

Check this list before you wrap anything new. The schema flags several endpoint
families as deprecated; for this project they split into two buckets.

Playlist item management targets `/playlists/{id}/items`. The `/tracks`
variants are the legacy path; every playlist tool here already uses `/items`.

### Blocked for post-Nov-2024 apps — deliberately not wrapped

These fail at runtime on app registrations created after November 2024. This
server ships no tools for them and you should not add any:

| Endpoint | Status |
|---|---|
| `GET /recommendations`, `GET /recommendations/available-genre-seeds` | Blocked for post-Nov-2024 apps |
| `GET /artists/{id}/related-artists` | Blocked for post-Nov-2024 apps |
| `GET /audio-features/{id}`, `GET /audio-analysis/{id}` | Blocked for post-Nov-2024 apps |
| `GET /browse/categories` | Live — wrapped by get_categories / get_category_playlists |
| `GET /browse/new-releases`, `GET /browse/featured-playlists` | Blocked/removed — do not use |
| Lyrics endpoints | Not available via the Web API — do not use |

### Schema-flagged deprecated but verified operational — wrapped with graceful 403 handling

Verified live against the current schema for this project's app registration.
Kept during transition; each wrapper catches Spotify's 403 and degrades
gracefully instead of surfacing a raw failure:

| Endpoint | Wrapped by |
|---|---|
| `GET /artists/{id}/top-tracks` | `get_artist_top_tracks` (#38) |
| Batch `GET /albums?ids=` / `/artists?ids=` / `/episodes?ids=` / `/shows?ids=` / `/audiobooks?ids=` / `/chapters?ids=` | the `get_several_*` tools (#43) |
| Per-type library writes `PUT/DELETE /me/tracks\|albums\|shows\|episodes` and `GET /me/{type}s/contains` | `save_items` / `remove_saved_items` / `check_saved_items`; prefer the unified `/me/library` tools (`save_to_library` / `remove_from_library` / `check_in_library`, #37) for new work |
| `PUT/DELETE /me/following?type=artist`, `GET /me/following/contains` | `follow_artists` / `unfollow_artists` / `check_following_artists` |

---

## 3. Commands

| Command | What it does |
|---|---|
| `npm ci` | Reproducible install from the lockfile. The census script refuses to run against a `node_modules` that is not repository-local. |
| `npm run build` | `tsc`, then adds the shebang to `dist/index.js`. |
| `npm test` | Builds, then runs the `node:test` suite via `tsx` over `tests/*.test.ts`. |
| `npm run test:coverage` | Adds `--test-coverage-lines=75 --test-coverage-functions=70 --test-coverage-branches=60`. CI runs this and additionally asserts pass count equals test count. |
| `npm run count:tools` | `scripts/surface-census.mjs`. Prints JSON: tool names, prompt names, resource URIs, parameter names, per-module measurements. |
| `npm run count:tools -- --write` | Refreshes the 13 generated documentation blocks listed below. Nothing else. |
| `npm run count:tools -- --check` | Fails if any generated block is stale. CI runs this. |
| `npm run check:doc-tool-names` | Fails if any doc names a tool or argument that the finalized registry does not have. CI runs this. |
| `npm run dev` | Runs the server from source against `.env` if present. |
| `npm run auth` | The PKCE walkthrough; stores tokens at `~/.spotify-mcp/tokens.json`. |

Both doc gates accept `--census-file <path>` so CI generates the census once and
feeds the same JSON to both. Do not run them independently in a loop.

### Generated blocks vs hand-maintained baselines

`--write` only rewrites content between `<!-- BEGIN:generated <name> -->` /
`<!-- ... END -->` markers (and the `// BEGIN:generated` comment form in
`.ts` files). Those blocks are:

`README.md` (surface-census), `ARCHITECTURE.md` (surface-census, module-map),
`SPEC.md` (package-contract, tool-surface, resource-surface, prompt-surface),
`docs/schema-budgets.md` (schema-budget-table), `docs/wave2-composites.md`,
`docs/distribution.md`, `skills/spotify-exhaustive-feature-sweep/SKILL.md`,
`skills/spotify-mcp-competitor-comparison/SKILL.md`, `src/toolsets.ts`.

**The `[toolCount, schemaBytes]` baselines in `src/tools/annotations.ts` are
hand-maintained and `--write` does not touch them.** Measure the real
`tools/list` output, update the manifest by hand, then run `--write` to
regenerate the tables. If you raise a ceiling, document the host-session payload
impact in docs/schema-budgets.md or the PR rationale.

---

## 4. The registrar manifest and schema budgets

`src/tools/annotations.ts` owns `REGISTRAR_MANIFEST` — the single list of
modules. Each entry records its module key, the toolset registration key, its
source file, its registrar function, a measured baseline, and explicit
ceilings. The same manifest drives startup registration, the census
attribution, the CI audit, and the per-module table `toolset_report` returns.
**Tests must not maintain a second registrar list.**

`src/index.ts` iterates the manifest and then runs, in order: the tool naming
policy, the per-module schema budget gate, annotation application, the tool
error boundary, and the aggregate surface budget gate. A budget breach fails
server startup, not just CI.

Per module the budget is measured as tool count plus UTF-8 bytes of compact
JSON of the tool `description` and the emitted `inputSchema` — the same payload
a host receives from `tools/list`. Effective ceilings are derived in the
manifest as **baseline tools + 1** and **110% of baseline schema bytes**, and
those derived values are authoritative.

Registration order is core-first and deterministic: the `search` / `catalog` /
`library` / `playback` prefix, then following/users/audiobooks and common
playlist workflows, then the rest. `tests/tool.surface.test.ts` pins the exact
prefix name sequence and derives its length from the first four manifest
baselines, so do not repeat that count in prose — it moves whenever a baseline
moves.

**Adding a tool therefore means:** the module's registrar in
`src/tools/*.ts`; the manifest entry (and its baseline) in
`src/tools/annotations.ts`; the toolset registration key in `src/toolsets.ts`
if it is not `alwaysActive`; the SPEC.md section for the contract; and
`npm run count:tools -- --write` for the tables.

### Annotations are fail-closed

Classification is name-driven and fail-closed: a tool is read-only only when
its name starts with an allowlisted read verb **and** starts with no mutating
prefix. Name suffixes prove nothing — most `*_plan` tools accept a commit path,
so a new plan or preview tool is a write until someone verifies its handler and
adds it to `NEVER_MUTATING_PLANS`. Every write states `destructiveHint`
explicitly, because MCP's default is `true` and silence would advertise
`save_to_library` as dangerous as `remove_saved_items`. Do not add `title`
keys; hosts fall back to the tool name and duplicating it cost ~25 KB.

---

## 5. Confirmation, deprecation, releases

### Confirmation is elicitation, not an input flag

Destructive bulk mutations ask a human through MCP elicitation
(`src/tools/confirm.ts`). `requiredConfirmationRefusal()` **fails closed** when
the client cannot prompt: an `unsupported` verdict is a refusal, and a prompt
that fails mid-flight is a refusal, never a silent proceed.

Most gates are threshold-based, and the thresholds are spread across modules,
not just `confirm.ts`: `REMOVE_ELICIT_THRESHOLD = 10` and
`REPLACE_ELICIT_THRESHOLD = 50` (confirm.ts), `BATCH_ADD_ELICIT_THRESHOLD =
100` and `MOVE_ELICIT_THRESHOLD = 50` (playlistbatch.ts),
`VISIBILITY_ELICIT_THRESHOLD = 1` (playlists.ts), and
`ARCHIVE_ELICIT_THRESHOLD = 50` (episodemgmt.ts). Four operations gate with no threshold at all and always ask:
`unpin_playlist`, the union replace, the subtract replace, and library
snapshot restore.

`SPOTIFY_MCP_CONFIRM=never` is the **only** automation bypass, and the value
must be exactly `never`. Set it deliberately, in automation you control.

Annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) are a separate
mechanism: static host hints applied after registration. They never prompt and
they do not replace the elicitation gate.

`SPOTIFY_MCP_READONLY` hides write-capable tools from the registry. If you add
a write tool, check that the read-only gate still hides it.

### Deprecating a tool input

- Keep the legacy name callable for **one release**, then remove it in the
  **next minor**. Legacy playlist input names are supported through 2.0 and
  removed in 2.1.
- Accept both only when they normalize to the same values; incomplete,
  differently ordered, or conflicting inputs fail before any Spotify request
  and name both conflicting fields.
- When a legacy name was used, the result carries `deprecated_inputs` and
  `deprecation_note` in `structuredContent`, and the same one-line note in
  prose/JSON text. Canonical-only calls omit both fields. `src/shaping.ts`
  provides `resolvePlaylistInput`, `withPlaylistInputMetadata`, and
  `withPlaylistInputNote`; use them rather than hand-rolling.
- Each tool declares exactly one alias pair or list. Send what that tool's
  schema declares.
- Retiring a *tool name* is different: delete it, pin its absence in
  `tests/tool.surface.test.ts`, and add the name to `retiredToolNames` in
  `scripts/check-doc-tool-names.mjs` **only** so a migration note can name what
  it replaces.

### The doc-name gate

`npm run check:doc-tool-names` fails when a doc backticks an unknown
snake_case name, shows a JSON tool example with an argument the tool does not
declare, shows a call recipe or Inputs table that disagrees with the schema, or
shows a module map (`playlists.ts  # get_playlist, …`) listing a tool that no
longer exists. It checks `README.md`, `SPEC.md`, `ARCHITECTURE.md`,
everything under `docs/` and `skills/`. Add a snake_case identifier to
`parameterAllowlist` only if it is genuinely not a tool parameter.

### Releases

Conventional Commits, `type(scope): description`. release-please owns the
version: it reads the commit history on `main`, opens a
`chore(main): release X.Y.Z` PR that bumps `package.json`, both `server.json`
version fields, and writes `CHANGELOG.md`. **Never hand-edit the version or
the changelog.**

- `feat:` → minor, `fix:` and other patch-level changes → patch.
- A breaking change is a `!` after the type/scope plus a `BREAKING CHANGE:`
  footer in the commit body — e.g. `feat(registry)!: v2 contract spine`. That
  is what produces a major.

Merging the release PR with CI green creates the `vX.Y.Z` tag. A tag created
with `GITHUB_TOKEN` does not start a push-triggered workflow, so publish does
not fire automatically: dispatch it yourself —
`gh workflow run publish.yml --ref vX.Y.Z` — then verify the npm version, the
tagged `server.json`, and the MCP Registry's `latest` response. CONTRIBUTING.md
§Releasing has the exact commands and the rollback rules.

---

## 6. Lessons that cost us a bug

Each of these is a real fix in this repository's history, not a hypothetical.

**Every documented count is generated and gated, so a hand-edited number is
wrong within one release.** Tool counts, module maps, and the schema-budget
table all live in generated blocks. After changing the registry, run
`npm run count:tools -- --write`; never type a count into a doc. Remember that
`--write` does not refresh the hand-maintained baselines in
`src/tools/annotations.ts` — the two halves of a surface change are updated
separately, and the "stale generated block" error is usually the second half
still missing.

**A correctly named payload field can still lie about its value.** Two shipped
bugs were the same mistake: a value that could not be read was coerced into a
plausible number. A throttled or private stats.fm friend's failed stream lookup
was recorded as `0 streams`, so the chart told the reader their friend
streammed nothing (#803). Five call sites sent `volume=` where Spotify requires
`volume_percent=`; the write was rejected, and where the error was swallowed the
tool reported a volume that was never applied (#830). If a lookup fails, say
so — exclude the row, list it as unreadable with the reason, count it in the
summary, and never guess. A field the API could contradict the declared type of
(`name: string` arriving as `undefined`) is the same failure one field over
(#804): fall back to something that cannot itself be wrong, like the id.

**A test that cannot fail is worse than no test.** A schema-budget gate once
trusted a precomputed `withinBudget` flag instead of recomputing its verdict
from the measurements, and its failing-path test injected the answer rather
than driving the comparison — so it passed whatever the code did. Another
assertion recomputed its expected value from the same census fields it was
checking. Assertions that live inside a conditional that never fires, and
assertions derived from the same source as the code under test, are decoration.
The fix pattern for both: make the test exercise the comparison, then revert
the source change and confirm the test actually fails.

**A failing test tells you the truth — read the assertion, not the summary.**
The failure line names the value that broke and where. Skimming the test name
or the `AssertionError` headline and guessing at the cause is how a
straightforward parameter-name fix turns into an afternoon.

**The summary is not the contract.** A delta comment once asserted that
`/me/top/artists` had been observed without a name — an unsourced platform fact
that contradicted the module's own live-verified header. Remove the claim
rather than the interface. Same class: a time frame described as "one" while
hour buckets came from local time and day metrics from the UTC date prefix, so
one payload mixed two frames (fe45fe2). Naming is not documentation; the wire
format is.

---

## 7. Before you open a PR

- `npm run build` and `npm test` pass.
- `npm run count:tools -- --check` and `npm run check:doc-tool-names` pass.
- If you changed what a tool accepts or returns, SPEC.md matches.
- If you changed the registry, the manifest baselines are updated **and**
  `--write` has been run.
- Behavior changes have a regression test that fails without the fix.
- Conventional Commit title; a `Closes #NNN` footer per issue you actually
  fixed. The changelog is generated — do not write it.
