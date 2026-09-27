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

**Do not reach for `as any` to read a payload.** It is the cast that turns off
the compiler at exactly the place a field rename would otherwise be caught, and
the value then arrives as `undefined` wearing a plausible type. `src/tools` is
at zero and CI fails if one comes back (`node scripts/check-no-explicit-any.mjs`).
The fix is to widen the shared shape in `src/types/spotify.ts` — which is owned
by one file on purpose — or to narrow the read to a typed helper. `as unknown
as` and `: any` are not covered by that gate.

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
server ships no tools for them and you should not add any. A struck-through row
is the exception: it is a different state (removed outright, or gated) and its
Status cell says so — see the next section before reading one as "never
wrapped":

| Endpoint | Status |
|---|---|
| `GET /recommendations`, `GET /recommendations/available-genre-seeds` | Blocked for post-Nov-2024 apps |
| `GET /artists/{id}/related-artists` | Blocked for post-Nov-2024 apps |
| `GET /audio-features/{id}`, `GET /audio-analysis/{id}` | Blocked for post-Nov-2024 apps |
| ~~`GET /browse/categories`~~ | **REMOVED Feb 2026** — `get_categories` / `get_category_playlists` were **deleted** (#638). No endpoint serves the browse category tree; nothing replaced them. The family still has live callers — see the registration-dependent section below before concluding the path is dead |
| `GET /browse/new-releases`, `GET /browse/featured-playlists` | Blocked/removed — do not use |
| Lyrics endpoints | Not available via the Web API — do not use |

### February 2026: two different states, and the label is not one of them

Spotify's
[February 2026 changelog](https://developer.spotify.com/documentation/web-api/references/changes/february-2026)
marks a batch of operations `[REMOVED]`. That label is not a single runtime
fact, and reading it as one is how this section used to tell you that correct
code was broken code. Sort a path into one of two buckets before you act on it.

**Registration-dependent — keep calling these, and do not file a bug against
the callers.** The changelog marks them `[REMOVED]`, but the live OpenAPI
schema still publishes the same paths carrying `deprecated: true`. What a
request does depends on the *registration*, not on the endpoint, so a tool that
calls one of these is doing its job: a `403` is a gating outcome the server
turns into a stated reason or a documented replacement read, never a silent
wrong answer. A tool that calls a gated path and handles the 403 correctly is
not degraded, and deleting its wrapper makes it worse.

> **Unverified — do not build on it.** Whether a *grandfathered* (pre-Nov-2024)
> registration still answers `200` on these paths is **established nowhere in
> this repository**, and this section used to assert it. Worse, the artefact it
> was sourced to says the opposite. That citation was a dated probe JSON under
> `memory/`, which `.gitignore` drops — so it was removed as an unfalsifiable
> reference in #1260, leaving the claim standing without its evidence (the rot
> §6 calls out). It is still recoverable from history, and what it records is
> `403`:
>
> ```
> $ git show 1a53544:memory/edge-probe-2026-08-26.json
> {"label":"user-profile-by-id (app-gated?)",    "path":"/v1/users/j.lee12",
>  "status":403, "cls":"GATED/REMOVED",
>  "snippet":"{\"error\": {\"status\": 403, \"message\": \"Forbidden\" } }"}
> {"label":"user-playlists-by-id (app-gated?)", "path":"/v1/users/j.lee12/playlists?limit=3",
>  "status":403, "cls":"GATED/REMOVED",
>  "snippet":"{\"error\": {\"status\": 403, \"message\": \"Forbidden\" } }"}
> ```
>
> All thirteen `200`s in that same probe are `/me/*` or `search` paths; neither
> `/users` path is among them. The 2026-08-27 sweep
> (`memory/live-sweep-report.md`) is likewise no help: its `PASS (gated)` rows
> for these two tools are a regex sniff over prose that matched *403*, on a
> registration that was itself gated. No pre-Nov-2024 registration has ever been
> exercised here — no client id and no app age is on record. Treat "a
> grandfathered registration still works" as an **open question**, and do not
> cite this file or the sweep for it. The keep-it decision below does not rest
> on it.

**The authoritative list is `GATED_FAMILIES` in `src/gating.ts`** —
`GATED_PATH_PATTERNS` is derived from it, and the README's
[Registration-gated endpoints](README.md#registration-gated-endpoints) table is
generated from that array. Read the array instead of a list restated here: it
records, per family, `reason` (what the changelog says) and `fallback` (whether
a 403 is met by a replacement read or a plain-English explanation), and those
two fields are why "removed" and "registration-dependent" are not synonyms.
Verified against the array, not this paragraph.

`/users/{id}` and `/users/{id}/playlists` are the family worth naming here,
because the obvious reading puts them in the never-call table below instead.
There is **no `/me/*` replacement** for them — a tool reading an **arbitrary**
`user_id` has nothing honest to migrate onto, since `/me` is only ever the
caller — so no migration exists, and repointing a `user_id`-taking tool at
`/me` would answer "user X's profile" with the caller's own. All three live
call sites — `get_user_profile` and `get_user_playlists_by_id` in
`src/tools/users.ts`, and `get_playlist_followers` in
`src/tools/playlisthealth.ts` (owner profile, behind `include_profiles`) — make
the call and **disclose a 403 instead of degrading**: `playlisthealth.ts` states
`owner_profile_error` in both prose and payload rather than dropping the field
silently. That is the whole of the reason they stay and are not in the
never-call table. It is a reason to keep an honest failure, **not** a claim
that the path works for anyone — see the unverified note above. They are
`fallback: 'explained'` in `GATED_FAMILIES`. `get_user_playlists` is
deliberately **not** in that family: despite the name it reads
`GET /me/playlists`, which was never removed.

`/browse/categories*` is the second family worth naming here, and it is the
clearer case of the two, because **the table used to contain it** (it was
removed under #1359). What keeps it out is the same reason: the family has live
call sites, and they disclose rather than degrade. `get_category` and
`browse_category_deepdive` (`src/tools/catalog.ts`) throw a message naming the
Feb 2026 removal on a 403/404/410, and `category_resolver`
(`src/tools/exhaust2_catalog.ts`) returns `{ gated: true }` naming the gate on a
403 — so no failure is ever smoothed into an empty category list. All three are
declared by the `browse-categories` family in `GATED_FAMILIES`, which is the
whole of the reason they are not deleted — a reason to keep an honest
disclosure, not a claim that the path works for anyone (see the unverified note
above).

Do not read that as "the endpoint is live". The changelog marks
`GET /browse/categories` and `GET /browse/categories/{id}` `[REMOVED]`, and it
names **no** `[REMOVED]` entry for `GET /browse/categories/{id}/playlists` at
all — the label appears in the page's endpoint index but never in its removal
list. The live OpenAPI schema still publishes all three paths carrying
`deprecated: true` with documented 200 responses. So what a call does depends on
the registration, which is the definition of this section, and it is why the
honest per-tool behaviour is a disclosure rather than either a deletion or a
silent empty shape.

**Never call these — no replacement, or superseded with no live call site.**
Nothing in this table is a runtime classifier, because there is no graceful
shape left to give the failure:

| Endpoint | Status |
|---|---|
| `PUT/DELETE /me/following?type=artist` | **No replacement — unrecoverable, see below.** `follow_artists` / `unfollow_artists` were **deleted** (#638); the read half survives as `check_following_artists` on `GET /me/library/contains` |
| `PUT/DELETE /me/{tracks,albums,shows,episodes,audiobooks}` | Replaced by `PUT/DELETE /me/library`. Every call site migrated and `save_items` / `remove_saved_items` were **deleted** (#638) |
| `GET /me/{tracks,albums,shows,episodes,audiobooks,following}/contains` | Replaced by `GET /me/library/contains`. Every call site migrated and `check_saved_items` was **deleted** (#638) |
| `PUT/DELETE /playlists/{id}/followers` | Replaced by `PUT/DELETE /me/library` with a `spotify:playlist:` URI (#594) — already migrated, no live call site |
| `GET /playlists/{id}/followers/contains` | Replaced by `GET /me/library/contains` (#862) — already migrated, no live call site |
| `POST/GET/PUT/DELETE /playlists/{id}/tracks` | Superseded by the `/items` equivalents; no shipped tool calls it (#638) |

A tool in this bucket is **broken, not merely degraded** — a `403`-tolerant
wrapper will happily turn a removed endpoint into a soft, wrong answer, so
graceful handling is not a mitigation and you should not add nicer errors to
re-wrap one. Two honest outcomes exist and nothing between them: **delete the
tool** when the endpoint has no replacement, or **migrate the call** to the
replacement the changelog names. Both happened under #638:

| Removed tool | Replacement |
|---|---|
| `follow_artists`, `unfollow_artists` | none — see below; the read half is `check_following_artists` |
| `save_items`, `remove_saved_items` | `save_to_library`, `remove_from_library` (`/me/library`) |
| `check_saved_items` | `check_in_library` (`/me/library/contains`) |
| `get_categories`, `get_category_playlists` | none — no endpoint serves the browse category tree |

A caller that reaches for a retired name now gets an unknown-tool error. The
retired names are listed in `retiredToolNames` in
`scripts/check-doc-tool-names.mjs` **only** so a migration note can name what it
replaces; the doc gate still rejects any other unbackticked name, so that set
cannot become a graveyard.

**Following an artist is no longer expressible, and there is no migration.**
`PUT`/`DELETE /me/library` accept track, album, episode, show, audiobook, user
and playlist URIs — **not** `spotify:artist:`. `GET /me/library/contains` *does*
accept artist URIs, so the read half migrated cleanly and the write half has no
target. A `PUT /me/library?uris=spotify:artist:<id>` would look migrated and
follow nothing. The repo already encoded this: `LIBRARY_SAVE_TYPES` in
`src/tools/library.ts` omits `artist` while `LIBRARY_CHECK_TYPES` adds it.
Verified against the endpoint reference pages, not the changelog summary.

`/me/library` authorises three alternative scopes — `user-library-modify`,
`user-follow-modify`, **or** `playlist-modify-public`. Check which one a
caller actually holds before concluding a migration will 403.

`GET /me/following` (the cursor-paged followed-artists **list**) is still available —
only its `PUT`/`DELETE`/`/contains` siblings were removed. That asymmetry is easy to
get wrong. `GET /search`'s `limit` maximum also dropped from 50 to **10** and its
default from 20 to **5**.

**When you touch a tool that calls any endpoint above, check the changelog before
assuming the endpoint is live — and check `GATED_FAMILIES` before assuming a
`403` means the tool is broken.** `AGENTS.md` has now been wrong about this
family twice in the same direction: first by listing the whole set as "verified
operational", then by listing it as uniformly broken. Both were true of neither.

---

## 3. Commands

| Command | What it does |
|---|---|
| `npm ci` | Reproducible install from the lockfile. The census script refuses to run against a `node_modules` that is not repository-local. |
| `npm run build` | `tsc`, then adds the shebang to `dist/index.js`. |
| `npm test` | Builds, then runs the `node:test` suite via `tsx` over `tests/*.test.ts`. |
| `npm run test:coverage` | Adds `--test-coverage-lines=75 --test-coverage-functions=70 --test-coverage-branches=60`. CI runs this and additionally asserts pass count equals test count. |
| `npm run count:tools` | `scripts/surface-census.mjs`. Prints JSON: tool names, prompt names, resource URIs, parameter names, per-module measurements. |
| `npm run count:tools -- --write` | Refreshes the generated documentation blocks listed below. Nothing else. |
| `npm run count:tools -- --check` | Fails if any generated block is stale. CI runs this. |
| `npm run check:doc-tool-names` | Fails if any doc names a tool or argument that the finalized registry does not have. CI runs this. |
| `npm run check:tests-typecheck` | Typechecks `tests/` and fails only on an INCREASE over `tsconfig.tests-baseline.json`, in total or in any single file (#1408). CI runs this. `--write` refreshes the baseline. |
| `node scripts/check-doc-tool-counts.mjs` | Fails if a registry-scale tool count (100+, measured) appears in a hand-written `src/` comment or in document prose. Has no npm script — `tests/doc-figures.test.ts` drives it, so CI runs it. `--census-file <path>` reuses a census; `--root <dir>` points it at a copy of the tree. |
| `node scripts/check-release-history.mjs` | Fails if a release tag has no `CHANGELOG.md` section, a section has no tag, or `package.json` is ahead of the changelog. CI runs this, and CI first runs `git fetch --tags` — `actions/checkout` fetches no tags at the default depth, and the gate exits non-zero rather than comparing an empty list. |
| `node scripts/check-no-explicit-any.mjs` | Fails if any `as any` appears under `src/tools`. CI runs this. Comments and string literals are blanked first, so prose about the cast does not trip it; `Record<string, any>` is a type argument, not a cast. |
| `node --import tsx/esm scripts/check-doc-links.mjs` | Fails if a relative Markdown link names a missing file or a missing heading, or if the graceful-403 message points at a README section that does not exist (#931). CI runs this. Remote URLs are out of scope by design — a flaky network check is worse than none. `--check-fixture <dir>` runs the same collector over a scratch tree, which is how `tests/doc-links.test.ts` proves the gate rejects rather than assumes. |
| `npm run dev` | Runs the server from source against `.env` if present. |
| `npm run auth` | The PKCE walkthrough; stores tokens at `~/.spotify-mcp/tokens.json`. |

Both doc gates accept `--census-file <path>` so CI generates the census once and
feeds the same JSON to both. Do not run them independently in a loop.

**A tool count belongs in a generated block, or nowhere.** The count that
appears in a `.ts` comment or in prose is a claim about a tree nobody pinned,
and it goes stale on the next tool that lands. A comment that genuinely needs
one — a raise warrant, a dated measurement — records what it measured and when,
and `scripts/check-doc-tool-counts.mjs` allowlists that one line by line. A
present-tense claim — "N tools today", "the escape hatch for an N-tool surface"
— gets its number deleted, not refreshed: the sentence usually does not need it.
Writing the number into this rule would trip the rule, which is the intended
outcome.

### Generated blocks vs hand-maintained baselines

`--write` only rewrites content between `<!-- BEGIN:generated <name> -->` /
`<!-- ... END -->` markers (and the `// BEGIN:generated` comment form in
`.ts` files). Those blocks are:

<!-- BEGIN:generated generated-blocks -->
- `README.md`: `surface-census`, `gated-endpoints`
- `ARCHITECTURE.md`: `surface-census`, `module-map`
- `SPEC.md`: `package-contract`, `tool-surface`, `resource-surface`, `prompt-surface`
- `docs/schema-budgets.md`: `schema-budget-table`, `aggregate-budget`, `response-cap`
- `docs/wave2-composites.md`: `surface-census`
- `docs/distribution.md`: `surface-census`
- `docs/cookbook.md`: `recipe-index`
- `skills/spotify-exhaustive-feature-sweep/SKILL.md`: `surface-census`
- `skills/spotify-mcp-competitor-comparison/SKILL.md`: `surface-census`
- `src/toolsets.ts`: `surface-census`
<!-- END:generated generated-blocks -->

That list is itself one of the generated blocks. Its body is rendered from the
`blocks` array in `scripts/surface-census.mjs` — the same inventory `--write`
iterates and `--check` verifies — so adding a block there makes this section
stale until you re-run `--write`, and the list can no longer disagree with the
blocks it describes. It is excluded from its own body: the entry for
`AGENTS.md` is deliberately absent above.

**The `[toolCount, schemaBytes]` baselines in `src/tools/annotations.ts` are
hand-maintained and `--write` does not touch them.** Measure the real
`tools/list` output, update the manifest by hand, then run `--write` to
regenerate the tables. If you raise a ceiling, document the host-session payload
impact in docs/schema-budgets.md or the PR rationale.

### Resolving a conflict in a file that mixes both (#1384)

Every file in the generated list above is a **mixed** file: it interleaves
hand-written prose with generated blocks. `--write` is marker-bounded, so it
can only replace what sits between a BEGIN/END pair — but **you** resolving a
rebase conflict are not marker-bounded, and in a mixed file `--ours` or
`--theirs` is a whole-file decision that silently discards whatever hand-written
prose the losing side carried. The generator has no copy of that prose, so
nothing restores it, and the generated-block staleness check has no claim on it.
Both documentation gates stay green on a document that has just lost a section.

This is not hypothetical. During the #1350 work, a rebase conflicted in
`ARCHITECTURE.md`; `--theirs` reverted a hand-written stats.fm paragraph that
the incoming commit had just rewritten. It was caught only because an agent
diffed its own commit, saw a hunk it could not explain, and investigated — which
is diligence, not a process.

**In a file that mixes generated and hand-written regions, a whole-file conflict
resolution is not a conflict resolution. It is a silent content deletion with a
green CI.**

Recover the correct way, in this order. `--write` is a **generated-block** repair
and nothing else: it rewrites what sits between BEGIN/END markers, it has never
held a copy of your prose, and it exits 1 while a pinned paragraph is missing.
So diagnose first, then repair each half with the tool that owns it.

```bash
git checkout --ours ARCHITECTURE.md    # during a rebase, "ours" is the branch you are onto
npm run count:tools -- --prose-report  # read-only; exits 1 and names the paragraph if prose was lost
npm run count:tools -- --write         # rewrites only what is between markers
npm run count:tools -- --check         # both gates green
```

When `--prose-report` exits 0, the whole-file resolution lost no prose, `--write`
does the generated half, and the sequence ends green. That is the common case.

When it names a paragraph, **nothing in that sequence turns it green**: `--write`
exits 1 for exactly as long as the paragraph is missing, and the pin is keyed on
content, so a reworded paragraph reads the same as a deleted one. No command here
restores it — the generator only ever held the text between the markers, so those
bytes live in exactly one place, the ref you are about to drop. Take them from
it:

```bash
git show <the-ref-you-dropped>:ARCHITECTURE.md   # then hand-restore the named paragraph
```

Hand-merge when both sides edited the same prose — keep both sides' text.
`--ours` and `--theirs` are correct answers to "which generated block", and
silent content deletions to "which paragraph".

**The gate (#1384).** `scripts/doc-prose-manifest.json` pins every hand-written
prose block outside the generated regions, keyed by content hash.
`npm run count:tools -- --check` fails when a pinned block is no longer in its
file, naming the paragraph, and `--write` refuses to report success while one is
missing. Three things follow:

- **Adding prose is free.** A new tool adds a contract paragraph; the pin is
  keyed on content, so a key that was never pinned cannot be missing. This is
  deliberate — a gate that punishes ordinary work gets routed around within a
  week, and a routed-around gate catches nothing.
- **Changing or deleting prose needs `--prose-sync`.** That command **refuses**
  to drop a pinned entry and names what vanished. Only
  `--prose-sync --retire "<reason>"` removes one, and it records the reason and
  the date permanently. Losing prose has to be a named, dated act, not a side
  effect.
- **The pin is hand-maintained on purpose.** It is not in a generated block
  because `--write` would refresh it, and `--write` is the generated-block step
  of the documented recovery above: a generated pin would have gone green one
  command after the prose was lost, defeating the gate with its own repair
  recipe. **Do not move it into a generated block.**

The reasoning, and the alternative that was rejected, are in
`scripts/prose-manifest.mjs`.

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
`save_to_library` as dangerous as `remove_from_library`. Do not add `title`
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
`ARCHIVE_ELICIT_THRESHOLD = 50` (episodemgmt.ts). Five operations gate with no
threshold at all and always ask:
`unfollow_playlist` (and its deprecated `unpin_playlist` alias, which shares the
one handler), the union replace, the subtract replace, the trim replace
(`playlist_trim`, #872), and library
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
  **next minor**. The legacy playlist input names were promised for 2.0/2.1 and
  shipped un-removed through 2.1.2 (#1287); they were withdrawn in **3.0**,
  where the schema dropped them and a call carrying one is refused by name
  before any Spotify request. A notice and its removal land in ONE commit — the
  failure #1287 records is a notice that outlived the promise, and it is worse
  than no notice because a caller plans around it.
- Accept both only when they normalize to the same values; incomplete,
  differently ordered, or conflicting inputs fail before any Spotify request
  and name both conflicting fields. A **removed** name is not a conflict: refuse
  it as its own kind (`validation` / `reason: retired_input`) naming both the
  retired field and its replacement, rather than letting it fall through to
  `unknown_param`, which claims the server never had the name.
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

### The test-tree typecheck budget

`tsconfig.json` includes only `src`, so `npx tsc --noEmit` has never seen a
test file, and `tsx` strips types rather than checking them. A test that names a
type which does not exist, calls a generic with a type argument its receiver
does not accept, or references a variable out of scope runs and passes.
`tsconfig.tests.json` adds `tests/` and the gate measures the result.

It is a **budget, not a zero gate**. The count is large and fixing it is a
mechanical change across ~100 files, so the gate compares against
`tsconfig.tests-baseline.json` and fails only on an **increase** — in the total
or in any single file, so the count cannot be held flat by fixing one file and
breaking another. A file with no baseline entry is an automatic failure, so a
new test cannot arrive carrying errors. `--write` refreshes the baseline; the
diff is the record of what changed.

Two things make it trustworthy, and both are asserted in
`tests/tests-typecheck-budget-gate.test.ts`:

- **It fails closed.** `tsc` reports a bad path or an unreadable config as a
  run-level error (`TS5058`, `TS2688`) with *no* `file(line,col)` prefix. A
  parser that only matches per-file diagnostics reads that as "zero errors" and
  the gate reports a comfortable pass having measured nothing. Run-level errors
  are collected separately and exit non-zero.
- **It is proven to fail.** Lowering the baseline, introducing a real type
  error, and pointing the gate at an unreadable project each assert a non-zero
  exit — against the real CLI, not a reimplementation of it.

Do not silence a new error with `@ts-nocheck`, a blanket `any`, or by widening
the baseline. The remaining errors are mostly `FakeClient`-shaped test doubles
drifting from `SpotifyClient`, and they are worth fixing at the source
signature. When the count reaches 0, this budget is replaced by `tests/**/*`
joining the main typecheck. Related: #585.

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

Merging the release PR with CI green creates the `vX.Y.Z` tag, and `release.yml`
then **dispatches `publish.yml` itself** with
`gh workflow run publish.yml --repo "$GITHUB_REPOSITORY" --ref "$RELEASE_TAG" -f
tag="$RELEASE_TAG"`. That dispatch is the mechanism, not a workaround:
release-please creates the tag with the repository's `GITHUB_TOKEN`, and a tag
pushed with `GITHUB_TOKEN` does not start a push-triggered workflow, so without
the dispatch nothing would publish. **Do not dispatch it manually a second
time** — a manual `gh workflow run publish.yml --ref vX.Y.Z` races the run the
release workflow already started, and npm versions are immutable, so the second
attempt fails on a version that already exists. That is what caused the double
publish on 2026-09-25. `publish.yml` keeps a `push: tags: ["v*"]` trigger for
tags created by something other than `GITHUB_TOKEN`, and both trigger types land
in the `publish-<tag>` concurrency group with `cancel-in-progress: false`. The
previous wording here said the opposite — that the tag push alone starts the
workflow and a dispatch is therefore wrong — which is right as advice and wrong
as mechanism, and it left a maintainer with no run to watch and no dispatch to
make. See CONTRIBUTING.md §2 for the full runbook.

`publish-mcp-registry` runs after `publish-npm` and validates that npm actually
serves the new version. **npm propagation is not instantaneous**, so that job
routinely 400s with *"version 'X.Y.Z' was not found"* moments after a
successful publish. That is a propagation race, not a broken artifact. Recover
with a failed-jobs-only re-run, which does not re-attempt the immutable npm
publish:

```
gh run rerun <run-id> -R NovaLux12/spotify-mcp-server --failed
```

Then verify. Do not trust a local `npm view` for this — it served a stale
`latest` and a 404 for a version that was already published. Query the registry
directly, cache-busted:

```
curl -sS "https://registry.npmjs.org/<pkg>?cb=$(date +%s)" | jq '.["dist-tags"]'
```

Check the npm version, the tagged `server.json`, and the MCP Registry's
`latest` response. CONTRIBUTING.md §Releasing has the exact commands and the
rollback rules.

`…/versions/latest` is that check. Do not substitute `/v0/servers?search=…`
for it: search is a paginated index whose first page can omit the newest
release, and its rows sort alphabetically rather than by recency (`1.10.0`
precedes `1.2.1`), so one row read off a search is not the current version.
`…/versions` is correct, and is the right query for auditing an older version
or its deprecation status. Both endpoints are data, not the authoritative
answer — reading one row off either and calling it "the published version" is
the mistake, not a shortcut.

### Closing the issue is a separate step from landing the fix

Only `Closes #N` / `Fixes #N` / `Resolves #N` close an issue. A subject line
reading `fix(#N)` or `Refs #N` — both of which read like a closing reference
and are not — leaves the issue open after a merge that fixed it. This has
happened at least eight times: #1332, #1338, #1350, #1358, #1359, #1362, #1364
and #722 all landed fully fixed and stayed open.

The failure is silent in the worst way. `gh pr merge` prints no issue lines
when it matched nothing, which reads as success — the merge genuinely did
succeed, and the work genuinely is on `main`, and the issue is still open. The
next person reads the open issue, does the work again, and merges a second PR
for a fix that shipped hours earlier.

So after the merge:

```
scripts/close-issues-from-pr.sh <pr-number> [issue ...]
```

It re-reads the body, closes what is still open, and **exits non-zero unless
every issue it was told about is verifiably closed** — which is the part that
matters, because the failure mode it exists for is a close that reports success
without happening. Pass the issue numbers explicitly; a squash subject that says
only `Refs #N` gives the script nothing to reconcile from.

Closing on the merge signal alone is not enough. Verify the fix is in the
merged tree first — two issues in this repo (#1207, #883) were closed on
verified substance rather than on a commit message, which is the only reason
that is the rule.

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

**`--check` reads the working tree, so a green run cannot mean the commit is
current.** #1262 at `cc3b080` and #1268 at `d1fdcc5` each pushed a commit whose
regenerated block was never committed, and CI failed on a stale `module-map` and
a stale `aggregate-budget` block. `699ccb3` did worse: it reached `main` with
`docs/schema-budgets.md` 730 bytes behind the measured surface (`607,227B`
committed against a measured `607,957B`) under a message claiming `--check` "is
then green, which proves the block is byte-stable." It was not, and the block sat
on `main` red until an unrelated PR's `--write` happened to correct it.
Regenerate a block and `--check` compares the regenerated tree against itself. A
rebase makes the omission near-certain: taking upstream's side of a
generated-block conflict restores upstream's line counts, so the committed table
is stale the instant the rebased commit lands. The signal that predicts the CI
failure is not the exit code but `git status --porcelain` coming back empty after
`--write` — anything it lists is a file the commit does not yet match.

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

**Two documents that must agree are not gated by checking each one.** The
graceful-403 message in `src/gating.ts` names a README section as both prose and
an anchor, and the census only required README to *have* a "Registration-gated
endpoints" heading — never that the message pointed at it. Measured on #931:
with the message aimed at a nonexistent heading, `count:tools -- --check`,
`check:doc-tool-names` and `check-no-explicit-any` all exited 0. Each gate was
green about its own subject while the pair had drifted, and the drift is
invisible until someone has already hit a 403 and is hunting a section that is
not there. `scripts/check-doc-links.mjs` reads the section out of the *rendered*
message and resolves it against README; a message that is renamed is now a red
build. The general form: if A asserts something about B, the gate has to compare
them, not validate each alone.

**A guard that only ever sees the correct input has never been shown it works.**
The first version of that script imported `graceful403Message()` itself, so its
tests could only exercise the shipped message — replacing the check body with
`return []` left all fourteen tests green. Taking the rendered message as an
*argument* is what let a test aim it at a section that does not exist. If you
cannot write the failing case, the check is not wired to anything.

---

## 7. Before you open a PR

- `npm run build` and `npm test` pass.
- `npm run check:doc-tool-names` passes.
- If you changed what a tool accepts or returns, SPEC.md matches.
- If you changed the registry, the manifest baselines are updated, **and**
  `npm run count:tools -- --write` has been run, **and `git status --porcelain`
  is empty afterwards** — commit whatever it listed. `--check` reads the working
  tree, so it turns green the moment you regenerate and stays green if you never
  commit the result. An uncommitted diff after `--write` is the only local signal
  that predicts the CI failure.
- Behavior changes have a regression test that fails without the fix.
- Conventional Commit title; a `Closes #NNN` footer per issue you actually
  fixed. The changelog is generated — do not write it.
- After merging, `scripts/close-issues-from-pr.sh <pr>` has been run and every
  issue it names is verifiably closed. See §5.5 — a squash-merged PR does not
  close what its subject only *references*.
