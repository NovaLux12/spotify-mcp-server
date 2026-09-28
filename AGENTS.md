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

`as unknown as T` and `: any` are ratcheted separately, by
`tests/payload-casts.test.ts`, which counts both per file, requires every file
that still holds one to be listed in its `BASELINE` table with a stated reason,
and fails on any new one. `as unknown as Record<string, unknown>` is excluded
and deliberately so: widening a payload to the wire's own type asserts nothing
the reader did not already believe, and `structuredContent()` in `src/shaping.ts`
is the blessed form of it. Declaring a payload as a `type` rather than an
`interface` is what closes the gap the cast was papering over — a `type` alias
of an object literal type is assignable to `Record<string, unknown>`, an
`interface` is not, and that difference is the whole reason `as unknown as` was
needed at all.

**Dead locals.** `tsconfig.json` sets `strict` but not `noUnusedLocals` /
`noUnusedParameters`. Turning them on was measured for #1202 and is not landed:
`npx tsc --noEmit --noUnusedLocals --noUnusedParameters` reports **128 errors
across 128 files** on `main` (f3b6ee80), the large majority unused *imports*
after module splits. That is a mechanical sweep across a quarter of `src/`, not
a cast fix, and bundling it here would have buried the six files this change
actually touches. It wants its own PR, one that does nothing else.

**The two `void _x;` statements.** `src/tools/playlistdna.ts` and
`src/tools/statsfm_taste.ts` each discard a parameter a shared registrar
signature requires them to accept. A deliberate verdict rather than a shared
prefix: these are not dead locals in the #758 sense — the parameter exists
because `src/index.ts` passes the same arguments to every registrar, and the
alternative is a signature that lies about what these two tools do. They stay,
and they say why in a comment on the line.

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

These fail at runtime on app registrations created after November 2024, and on
existing apps still in **development mode** without a pending extension request
— the restriction is not only about app age. This server ships no tools for them
and you should not add any. A struck-through row is the exception: it is a
different state (removed outright, or gated) and its Status cell says so — see
the next section before reading one as "never wrapped":

| Endpoint | Status |
|---|---|
| `GET /recommendations` | Blocked for post-Nov-2024 apps |
| `GET /artists/{id}/related-artists` | Blocked for post-Nov-2024 apps |
| `GET /audio-features/{id}`, `GET /audio-analysis/{id}` | Blocked for post-Nov-2024 apps |
| `GET /browse/featured-playlists` | Blocked for post-Nov-2024 apps |
| ~~`GET /browse/categories`~~ | **REMOVED Feb 2026** — `get_categories` / `get_category_playlists` were **deleted** (#638). No endpoint serves the browse category tree; nothing replaced them. The family still has live callers — see the registration-dependent section below before concluding the path is dead |
| `GET /browse/new-releases` | **REMOVED Feb 2026**, not a Nov-2024 restriction — do not use |
| `GET /recommendations/available-genre-seeds` | **Deprecated, same family as Recommendations** (`get-recommendation-genres`, `deprecated: true` in the OpenAPI schema). Whether the Nov 2024 restriction reaches it has not been established from Spotify's own changelog — see below. Do not wrap it |
| Lyrics endpoints | Not available via the Web API — do not use |

**One row above is an open question, not a settled fact.**
`GET /recommendations/available-genre-seeds` is `deprecated: true` in the
OpenAPI schema, and the schema also marks `/recommendations`,
`/artists/{id}/related-artists`, `/audio-features/{id}` and
`/browse/featured-playlists` the same way — so the schema alone does not
distinguish "restricted since Nov 2024" from "deprecated at some point". The
`get-recommendations` and `get-recommendation-genres` reference pages both say
only "Deprecated" and name no date or scope. An earlier draft of this file
asserted the Nov 2024 post excludes genre-seeds by name; that could not be
confirmed, because the changelog entry is not reachable at a stable URL and the
`references/changes` index is client-rendered. **Do not resolve it from this
file, from `src/tools/moodexpand.ts` (which repeats the same unverified
claim), or from memory** — read the changelog entry itself, then correct all
three places together. Until then the conservative reading stands: treat it as
restricted, and do not wrap it.

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
| `npm run check:doc-tool-names` | Fails if any doc names a tool or argument the finalized registry does not have, or states a constraint or a live constant the registry contradicts (#929, #1476). CI runs this. |
| `npm run check:tests-typecheck` | Typechecks `tests/` and compares every file against `tsconfig.tests-baseline.json`, in **both** directions — above it is a regression, below it is stale slack (#1408, #1478). CI runs this. `--write` reclaims a lowered count; raising one takes `--allow-increase "<reason>"`. |
| `node scripts/check-doc-tool-counts.mjs` | Fails if a registry-scale tool count (100+, measured) appears in a hand-written `src/` comment or in document prose. Has no npm script — `tests/doc-figures.test.ts` drives it, so CI runs it. `--census-file <path>` reuses a census; `--root <dir>` points it at a copy of the tree. |
| `node scripts/check-release-history.mjs` | Fails if a release tag has no `CHANGELOG.md` section, a section has no tag, or `package.json` is ahead of the changelog. CI runs this, and CI first runs `git fetch --tags` — `actions/checkout` fetches no tags at the default depth, and the gate exits non-zero rather than comparing an empty list. |
| `node scripts/check-no-explicit-any.mjs` | Fails if any `as any` appears under `src/tools`. CI runs this. Comments and string literals are blanked first, so prose about the cast does not trip it; `Record<string, any>` is a type argument, not a cast. |
| `node --import tsx/esm scripts/check-doc-links.mjs` | Fails if a relative Markdown link names a missing file or a missing heading, or if the graceful-403 message points at a README section that does not exist (#931). CI runs this. Remote URLs are out of scope by design — a flaky network check is worse than none. `--check-fixture <dir>` runs the same collector over a scratch tree, which is how `tests/doc-links.test.ts` proves the gate rejects rather than assumes. |
| `npm run wire:equivalence -- --out <file>` | `scripts/wire-equivalence.mjs`. Records every tool's `tools/list` schema and its `tools/call` result across a five-case argument matrix, into a one-line-per-invocation snapshot plus an FNV-1a digest. The clock, the RNG, the locale and the timezone are pinned and the four per-run value sources are masked, so an unchanged tree gives a byte-identical file. It writes only into its own `mkdtemp` sandbox under the OS temp root and never into a real `$HOME`. |
| `npm run wire:equivalence:compare -- <base> <head>` | Compares two snapshots and prints `CHANGED` / `ADDED` / `REMOVED` / `REORDERED` per invocation. Exit 0 when identical, 1 when they differ. Use it to answer "did this refactor change what a host receives?" — the question #1477's probe was written for and could not be re-run against. |
| `npm run dev` | Runs the server from source against `.env` if present. |
| `npm run auth` | The PKCE walkthrough; stores tokens at `~/.spotify-mcp/tokens.json`. |

Both doc gates accept `--census-file <path>` so CI generates the census once and
feeds the same JSON to both. Do not run them independently in a loop.

`npm run count:tools -- --out <path>` writes the census to a file and installs
it only if the run succeeded, so the file's existence means generation
succeeded. CI uses it rather than a shell redirect, because a redirect truncates
its target *before* the command runs: a failed census left a zero-byte
`.surface-census.json` behind, and the three readers above — all of which are
guarded, so all of them ran anyway — reported a JSON parse error that named
neither the census nor the failure (#1487).

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
- `docs/v3-roadmap.md`: `v3-headline`
- `docs/migration-v3.md`: `migration-tables`
- `docs/configuration.md`: `env-toolsets`, `env-registration-keys`
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
content, so a reworded paragraph reads the same as a deleted one. (One reading
of "names a paragraph" is not this one: a paragraph the pin has *never* seen is
named as `unpinned` rather than `missing`, and `--prose-sync` is the step that
ends it. See "Adding prose is free" below — the sequence above is already green
for that case, and the fix is one command.) No command here
restores a *lost* paragraph — the generator only ever held the text between the markers, so those
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

- **Adding prose is free for `--check`, and named by `--prose-report`.** A new
  tool adds a contract paragraph; the pin is keyed on content, so a key that was
  never pinned cannot be missing, and `--check` stays green. That is deliberate —
  a gate that punishes ordinary work gets routed around within a week, and a
  routed-around gate catches nothing. What the argument does not reach is the
  *next* edit: an unpinned paragraph is precisely the one whose later deletion or
  reword the guard cannot report, because there is no key for it to lose. Four
  `AGENTS.md` lessons merged that way in #1523 — the four newest entries in the
  file that records this repository's hard-won ones, all four invisible to the
  guard, and `--prose-report` still exited 0 while naming them. So
  `--prose-report` **exits 1 and names every unpinned paragraph**, by file and by
  label, in the same shape as a paragraph that went missing. Ordinary work still
  survives: the repair is `npm run count:tools -- --prose-sync`, which adds the
  key and retires nothing — commit the paragraph, run the sync, commit the pin.
- **Changing or deleting prose needs `--prose-sync`, and the two are not the
  same command.** That command **refuses** to drop a pinned entry and names what
  vanished, because the pin is keyed on content and a reword hashes exactly like
  a deletion. Losing prose has to be a named, dated act, not a side effect, and
  the other thing that makes a key disappear needs its own record too. A
  **deliberate deletion** is `--prose-sync --retire "<reason>"`, which records
  the reason and the date permanently and names no successor, because there is
  none. A **reword in place** is `--prose-sync --reanchor "<file>:<hash>" --to
  "<new prose>" --why "<why>"` ([#1527](https://github.com/NovaLux12/spotify-mcp-server/issues/1527)),
  which records the old hash, the new hash and the reason, and **refuses unless
  the replacement is already in the file**. That condition is the whole operation:
  it is what stops a reanchor being a quiet way to drop a pin, and it is why
  restoring prose stays hand-work from the ref you dropped rather than becoming a
  flag. `--to` takes the paragraph's text or its hash, and `--prose-report` names
  a paragraph that is new to the pin under `coverage.unpinned` — so the hash it
  prints is the one to hand `--to`. `--prose-report` reads the resulting
  `reanchored` list too, and fails on a record that contradicts a live
  retirement, so the two records cannot drift into disagreeing about one
  paragraph.
- **A retirement reason is a claim about a tree, and `--prose-sync` records
  which one** ([#1440](https://github.com/NovaLux12/spotify-mcp-server/issues/1440)).
  It refuses before it writes when the tree cannot be attested: a pinned
  document with uncommitted changes (no override), or a branch that does not
  contain `origin/main` / a checkout where `origin/main` does not resolve
  (`--allow-stale "<why>"`, recorded in the manifest's `provenance` block). The
  second refusal is the one that matters: a branch that predates a docs PR sees
  that PR's reworded paragraphs as *absent*, retires them, and records a reason
  describing a change the tree never saw — which is what #1439 shipped. Rebase
  or merge `origin/main` and re-run. That refusal also names any pending
  retirement whose paragraph is **still present upstream**, matched by content
  hash: a reason like "reworded by #NNNN" cannot be true of a paragraph sitting
  in the branch you are merging into. `--check` then confirms the pin's recorded
  commit is still an ancestor of `HEAD`, and reports `verified` / `rewritten` /
  `unverifiable` from `--prose-report`; `unverifiable` is the normal state of a
  `fetch-depth: 1` CI checkout and is deliberately not an error.
  **The commit the stamp is judged on is the merge base, not your branch tip**
  ([#1482](https://github.com/NovaLux12/spotify-mcp-server/issues/1482)), so a
  prose PR does not orphan its own pin. `main` squash-merges, which makes a
  branch tip an ancestor of nothing the moment it lands: stamping `HEAD` meant
  every prose PR reddened `main` on a tree whose paragraphs were all still
  pinned, and the recovery was an identical second commit. `--prose-sync` records
  both commits — `head`, the tree the author was looking at, and `base`, the
  commit `HEAD` and `origin/main` last share — and the read side asks about
  `base`, which is an ancestor of both sides and so survives a squash, a
  rebase-merge or a true merge alike. Nothing to do per PR, and a manifest
  stamped before `base` existed is still judged on its `head` alone. The price is
  that the stamp cannot now see a rebase or an amend, which the *content* check
  covers instead: a rebased paragraph is a pinned paragraph `--check` reports as
  missing, by content hash, in the same run. A tree that shares no commit with
  `origin/main` has no base to record, so the run warns that its stamp will not
  survive rather than refusing — refusing is what `--allow-stale` exists to
  avoid.
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

`src/server.ts` registers the manifest in order and then runs, in order: the
tool naming policy, output-schema publication, the per-module schema budget
gate, annotation application, task-support stamping, the tool error boundary,
and the aggregate surface budget gate. Output schemas are published **before**
either budget gate on purpose — both measure `outputSchema`, so a declaration
made after them would be free. (`src/index.ts` only calls `buildMcpServer`.)
A budget breach fails
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

A verb prefix is only an allowlist in the safe direction when it is a VERB. A
product prefix is not one, so a family named for the thing it talks to rather
than what it does cannot be granted read-only by name — `statsfm_*` was, which
meant a future stats.fm writer inherited the grant and nothing had to notice
(#1600). That family is instead positively enumerated in `STATSFM_READ_ONLY`
and consulted **before** the verb prefixes, so a name outside the set is a write
and a name added to the set is a read. Note the ordering requirement if you
extend it: the `stats` alternative alone already matches every `statsfm_*`
string, so a family check placed after the prefix test could never fire and
would look like a fix while changing nothing. The same `^`-anchoring shadows the
destructive verbs too — strip the family prefix before testing for one.

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
`tsconfig.tests-baseline.json` — in the total and in every single file, so the
count cannot be held flat by fixing one file and breaking another. A file with
no baseline entry is an automatic failure, so a new test cannot arrive carrying
errors.

**The baseline is a measurement of this tree, in both directions (#1478).**
Above it is a regression; below it is slack, and slack fails too. This is the
half the gate used to be missing, and it is not a cosmetic one: a comparison
that only fired on an increase meant an allowance outlived the errors it
allowed, and the slack accumulated silently. On `main` it had reached three
entries totalling five errors for files that typechecked clean — the exact
"5 to give back" the gate printed while exiting 0. Nobody could spend those
five honestly, because `--write` refreshes every entry, so taking them meant
taking them in files you had not fixed.

So: **fix errors in the test, then `--write`.** A PR that lowers a file's error
count has to re-baseline, and its own diff is the record of what changed. The
narrower rule — failing only on entries that have reached *zero* — reclaims
those five and leaves every partially-improved file's slack in place, so a gate
built on it still reports a 19-error ceiling as current when the file carries
15. Narrowing the class of drift that is caught is not the same as closing it.

**`--write` reclaims; it does not widen.** Re-baselining downwards needs no
ceremony. Raising a ceiling — the total, or any one file's — is refused, because
AGENTS.md says to fix the errors rather than widen the budget and a `--write`
that raised one silently would be a one-command escape from the very budget it
maintains. If the increase is real, it takes `--allow-increase "<reason>"`, and
the reason, the date and the delta are recorded in the baseline. (Same shape as
`--prose-sync --retire "<reason>"` in §3: a change nobody named is a change
nobody reviews, so it has to be a dated, reasoned act rather than a side
effect.)

The baseline is a measurement of the tree **as rebased onto the current
`origin/main`**, not of whatever the count was when the gate was written. If
`main` moves and lands test changes of its own, the gate will report the drift
— in whichever direction it fell — even though your branch touched none of
those files. Check `git diff --name-only origin/main...HEAD -- tests/` before
concluding you introduced it, and re-`--write` if the drift is `main`'s.
Attribute the delta per file before doing anything else: a rebase that lands on
a newer `main` is routinely a net *decrease* against the new base, and a
decrease now needs the same `--write` an increase does.

`--baseline <path>` and `--project <path>` point the gate at another config and
another baseline. The guard test needs them: node:test runs sibling `describe`
blocks concurrently, so a test that proved the gate fires by writing a doctored
checked-in baseline would race the sibling asserting the real tree is accepted,
and a passing run could leave the real baseline silently rewritten. Scratch
baselines in `mkdtemp`, never the checked-in file.

Three things make it trustworthy, and all are asserted in
`tests/tests-typecheck-budget-gate.test.ts`:

- **It fails closed.** `tsc` reports a bad path or an unreadable config as a
  run-level error (`TS5058`, `TS2688`) with *no* `file(line,col)` prefix. A
  parser that only matches per-file diagnostics reads that as "zero errors" and
  the gate reports a comfortable pass having measured nothing. Run-level errors
  are collected separately and exit non-zero, as does a baseline that will not
  parse.
- **It is proven to fail in the direction it did not have.** The stale-entry
  assertions — a file that is now clean, a file that improved but is not, a
  ceiling naming a file the tree no longer measures — each drive the real CLI
  and assert a non-zero exit, with an exact-match baseline asserted green beside
  them so "exits non-zero" cannot be satisfied by a gate that fails for any
  reason at all.
- **The regression path still works.** Lowering the baseline, a real type
  error, and an unreadable project each still assert a non-zero exit — against
  the real CLI, not a reimplementation of it. Widening the rule must not have
  cost the gate the direction it already had.

Do not silence a new error with `@ts-nocheck`, a blanket `any`, or by widening
the baseline. The remaining errors are mostly `FakeClient`-shaped test doubles
drifting from `SpotifyClient`, and they are worth fixing at the source
signature. When the count reaches 0, this budget is replaced by `tests/**/*`
joining the main typecheck. Related: #585, #1478.

### The doc-name gate

`npm run check:doc-tool-names` fails when a doc backticks an unknown
snake_case name, shows a JSON tool example with an argument the tool does not
declare, shows a call recipe or Inputs table that disagrees with the schema, or
shows a module map (`playlists.ts  # get_playlist, …`) listing a tool that no
longer exists. It checks `README.md`, `SPEC.md`, `ARCHITECTURE.md`,
everything under `docs/` and `skills/`. Add a snake_case identifier to
`parameterAllowlist` only if it is genuinely not a tool parameter.

**The last two claims are about values, not names, and both were added
because nothing compared them.** A tool can be named correctly, its argument
named correctly, and the constraint the doc states about that argument still be
false — a range the schema clamps, a default it contradicts (#929). And a
**shared-contract bullet** (`` - **`field`** (`'a' | 'b'`, default `'a'`) ``)
belongs to no single tool, so nothing attributed it to a schema at all:
`response_format` was documented with a first member no input schema declares,
and the aggregate ceiling was stated as 620,000B against a live
`TOOL_SURFACE_BUDGET.defaultMaxBytes` of 611,000 — 9,000B of headroom a reader
would have believed in, which is the wrong direction to be wrong (#1476). The
figures are compared against the census, not against a second reading of the
constant, and the comparison is deliberately narrow: a field no schema types as
an enum is skipped rather than guessed at, a field with several live enum
variants passes if the document matches any one of them, and a number is only
read as a constant's value if it sits before the sentence ends. A gate that
guesses is a gate that gets switched off.

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
release workflow already started. The npm step is guarded, not failing: it runs
`npm view "@novalux12/spotify-mcp@$VERSION"` first and skips a version already
on npm, so a duplicate run is not a red npm publish. The registry job has no
equivalent check and re-attempts `mcp-publisher publish`, and the npm guard has
been in `publish.yml` since 2026-08-25 — a month before the double publish on
2026-09-25 — so npm immutability is not the mechanism that date recorded.
`publish.yml` keeps a `push: tags: ["v*"]` trigger for tags created by
something other than `GITHUB_TOKEN`, and both trigger types land
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

**A guard's scope is part of its contract, and widening it is a measurement
before it is a fix.** `scripts/check-error-param-names.mjs` walked `src/tools`
and nothing else, so a message naming a parameter that does not exist could sit
in `shaping.ts`, `result.ts` or `accounts.ts` with the gate green — the modules
that own the shared error paths. Widening the walk turned the gate **red**, and
that is the part worth reading: the fix was never "change a glob". What shipped
is a partition, not a wider glob — the two registration-keyed rules are still
asserted over `src/tools` and nothing else, and a third, module-scope rule runs
over all of `src/`. Measured on
the tree the guard was written against, the findings ran 15 → 11 → 4 → 0, one
decision at a time — four were the shipped CLI's own flags, seven were the
guard's own vocabulary being incomplete (`playlist_a` and `playlist_b` reach
five tools by spread from `PlaylistPairFields`; `subject_type` is a real
parameter of a tool registered through `registerCanonicalTool`, a registration
form the original scanner never matched), three were not parameter claims at
all, and one
was a genuine bad message. Widening the scope *and* fixing the vocabulary *and*
fixing the one bad message were three separate pieces of work that a scope-only
patch would have hidden. Assert the widened rule over the whole tree, or it is
decoration — the same failure as the test that cannot fail, one level up. The
number belongs to a measurement, so re-derive it before quoting it: an earlier
version of this paragraph said "ten findings" and could not be reproduced from
any state of the tree, which is the whole failure in miniature.

**A falsifier you derived yourself is the only proof a guard is wired.** The
original defect was a `--profile` in a `+`-joined message; the scanner read only
the first literal. Reintroducing that exact defect into `src/accounts.ts` left
the gate green, which is how the fourth defect surfaced. A green run on a test
you did not break is not evidence.

**An exemption is a guard too, and it fails on the module that matters most.**
The `--flag` exemption for the shipped CLI was "the module declares a function
whose parameter list names `argv`", which is true of `auth.ts` and `logout.ts`
and false of `src/index.ts` — the dispatch, which reads `process.argv[2]` at top
level and declares no such function. The first honest `--flag` remediation at
the dispatch point would have been reported as bad advice, in the one file where
it is good advice. A list of exempt files would have been wrong in the other
direction: it needs a human to remember the next entrypoint, and it cannot be
checked. Ask instead what the exemption is *for* — here, that a `--name` in a
module reading the process command line names a flag the process will parse —
and test the property the exemption is for, on the file that exercises it. The
same file also carries `--help` prose today, so the gap was latent rather than
firing, and latent is the state this is easiest to leave in.

**A vocabulary a negative check judges against has to be the thing being asked
about.** The module rule asks whether a named parameter is real *anywhere* in
the registry, and the first version answered a looser question by unioning in
every zod-object key and every const-object key in `src/` — 1,319 names of which
982 were not parameters at all. `email` and `scopes` are fields of an
account record and of an OAuth token; a message misnaming a parameter for
either cleared the rule with no finding, which is the exact defect the rule
exists to catch. "Over-approximating is the right direction for a NEGATIVE
check" is true of a *type* check and false here: a wider union makes the check
unable to convict, and a guard that cannot convict is not a guard. Narrowing it
to registration-derived keys cost two real parameters, `playlist_a` and
`playlist_b`, which reach five tools by spread — the fix was to follow the
spread, which is bounded because a field object only counts when a registration
actually spreads it, not to widen the set back. Measure how many names the
union adds and name a few of them; that measurement is the whole argument.

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

**A cast at the structuredContent boundary is a decision to stop checking.**
`payload as unknown as SomeResult` does not tell the compiler the payload is
`SomeResult`; it tells the compiler to stop asking, and the value is then
confidently wrong at runtime with no compile error to explain why. That is the
same failure as the two bugs above, wearing a type instead of a default. Two
shipped instances of the same mistake: `library_hygiene` and `saved_dedupe`
declared `ok: true` as a *literal* type and then cast a quota-cooldown payload
saying `ok: false` into it, so the contradiction was invisible until someone read
the wire; and `get_playlist_added_dates` laundered each row's `added_at` through
a cast and defaulted it to `''`, which sorts *before* every real date — a show
of undated rows as the oldest.

So this boundary **fails closed**, in the same spirit as
`classifyToolAnnotations` and `requiredConfirmationRefusal()`: untrusted data is
*marked*, not defaulted. `src/shaping.ts` exports the readers —
`readString`, `readNumber` and `asRecord` all check the runtime type and return
`undefined` when it does not hold, and `structuredContent()` is the one way a
shaped payload enters the wire. An absent or wrongly-typed field is
*unanswered*, which is not `false` and not `0`; a value that could not be read
gets a `null` or an `undefined` the caller can disclose, and a row that cannot
be addressed at all gets skipped rather than turned into a URL that names
nothing. Where the type itself was the lie, fix the type: declare the payload as
a `type` union with the refusal as its own member (an `interface` has no
implicit index signature, which is the whole reason several of these casts
existed in the first place). Where `Record<string, unknown>` really is the
honest type, the cast is fine and should be left alone — `tests/structuredcontent-boundary.test.ts`
gates only the specific-shape class, because flagging the idiomatic widening
would be a gate nobody could keep green.

**A helper that names `T` once is not a check.** The issue this came from
suggested a `toStructuredContent<T>()` that coerces at the boundary and names the
target type one time. That is the same unverified assertion behind a friendlier
name, and it makes the trust decision *harder* to find, not easier. The value has
to earn its type at runtime; when it cannot, the honest representation is
`T | undefined`.

**A scanner that cannot see a thing must not report it as safe.** Two blind
spots in the same gate, and the second one is the lesson. The `outputSchema`
classifier infers "this module registers no tools" from a source regex; a module
registering through a module-local helper was invisible, and a
`filter(m => m.registers > 0)` then DROPPED it from the check entirely — the
check did not pass, it did not run. Broadening the matcher fixes that one. But
the module it had exempted then *still* matched no prose-only marker, because its
emitter was module-local too, so it went on to sit in
`PENDING_OUTPUT_SCHEMA_MODULES` as "verified safe, awaiting headroom" — a claim
nothing checked. Declaring it took four live prose-only call sites past a green
suite.

The transferable part is not either regex. It is that **"I found nothing" and
"I looked and it is clear" were the same value**, so a gate only ever shown the
correct input reported a confident wrong answer. Three attempts to close the gap
with a wider marker list all failed, structurally: the property is semantic —
*does this call site attach a payload?* — and the scanner answers it
syntactically. So the scanner has a third verdict now. A result it cannot account
for is **unclassified**, unclassified is a **failure by name**, and the rules are
fed the shapes they exist to catch through the same code path the real tree
uses, because a guard that has only ever met the correct input has not been shown
to work. Same shape of mistake as the `withinBudget` flag and as an assertion
computed from the fields it is checking.

**The floor is arithmetic, not meaning.** The arity rule that closes the loop is
`calls.filter(n => n <= emitter.payloadIndex)` — a count, with no analysis of
what was actually passed — so a call site handing over a present-but-empty
`undefined`, `null` or `{}` reads as carrying a payload. No `textOut(` call site
in the tree has that shape, so this is a known floor rather than a live miss, and
it is written down here so the next author reads the limit instead of
rediscovering it the hard way.

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
  issue it names is verifiably closed. See §5, *Closing the issue is a separate
  step from landing the fix* — a squash-merged PR does not
  close what its subject only *references*.
