# v4 implementation plan — agent ergonomics

**Status:** plan only. No implementation code. Branch contains this document alone.
**Target:** v3.1.1 → v4.
**Decisions pre-agreed** (do not re-litigate):

1. The goal is **agent ergonomics**, not distribution. Marketing work is out of scope.
2. Collapse to **orthogonal primitives**, with the full capability set behind a catalog.
3. **Breaking changes allowed.** Do not preserve the 562 tool names. Delete what does not earn its
   place, and ship a generated migration doc.
4. Validate by **dogfooding against a real account**, not a synthetic benchmark alone.

---

## 1. Diagnosis (measured at v3.1.1)

### 1.1 This is an ambiguity problem, not a discovery problem

`find_tool` works: a live call with `{"query":"podcast"}` returned 8 correct tools from 131
registered. Discovery is functional.

The problem is what discovery compensates for. `whats_new`'s description is **943 characters** and
ends:

> "Decision guide: whats_new for personal follows radar; search_fresh for query-scoped tag:new,
> search/search_deep for general catalog, search_by_isrc for ISRC-exact."

That is a bad tool boundary explained in prose. An agent must read a paragraph to choose between
four tools that are one operation ("find me things I don't have yet"). Every decision guide is a
permanent per-turn tax on every user.

### 1.2 The numbers

| metric | value |
|---|---|
| tools registered with no env | **131** |
| schema bytes with no env | **150,111** (~37.5k tokens at 4 B/token) |
| sum of description text, default surface | **32,373 chars** |
| descriptions as share of default payload | **22%** |
| mean description length, default surface | **247 chars** |
| longest description, default surface | **1,047** (`import_from_sidecar`) |
| tools with `SPOTIFY_MCP_TOOLSETS=all` | **562** |
| aggregate schema bytes, all tools | **605,374** against a **620,000** enforced cap |
| aggregate headroom | **15,626 B = 2.52%** |
| headroom with experimental analytics opted in | **5,638 B = 0.91%** ("effectively exhausted") |
| metadata overhead (17 resources + 28 templates + 14 prompts) | 65,633 B = 10.8% |
| tool module files | 71 |
| registration keys | 49 |

**The repo is at its architectural ceiling. It cannot add tools.** That is the strongest argument
for v4 — arithmetic, not aesthetics.

### 1.3 The surface is combinatorial, not 562 distinct ideas

Trailing-token analysis over all 562 names:

Counts are **`endsWith`** on all 562 names — the unambiguous measure. (`contains` gives very
different, misleading figures: "snapshot" matches 32 names and "stats" 47, because those tokens
appear mid-name in unrelated tools.)

| suffix | count |
|---|---:|
| `_report` | 34 |
| `_plan` | 19 |
| `_stats` | 14 |
| `_snapshot` | 11 |
| `_census` | 6 |
| `_timeline` | 6 |
| `_brief` | 2 |
| `_analytics` | 1 |

**The report-like view family is 56 tools**, defined as
`endsWith("_report" | "_brief" | "_census" | "_stats")` — the four suffixes that are always a shaped
read, never a mutation. Within those 56:

- **9 belong to stats.fm or taste** (`statsfm_*_stats` ×7, `taste_shift_report`, `taste_daily_brief`).
  They depend on a separate stats.fm account and their own opt-in gate, so they are `report` *views*
  only if v4 decides that integration is a view family at all — see §5.6. **Do not bulk-delete
  them** (§6, M3).
- **47 are the core view family** that folds into one `report` primitive.

Each of the 47 is one query plus a shaping function. `collab_density_report` is not a different
capability from `artist_velocity_report`; they are two *views* over the same catalog data. As
separate MCP tools each costs a schema and gives an agent one more thing to disambiguate.

**Thesis:** 47 shaped-read tools are one `report` primitive with 47 view values, plus the separate
`_plan` family of 19 (§3.5a).

**`_snapshot` is not a view family.** 11 names end with `_snapshot`, but they are snapshot *CRUD* —
save, delete, restore, diff, list — not shaped reads. They fold into `write` (`op:"snapshot"`) or
stay as one grouped tool; they do **not** belong in `report`. The earlier draft of this plan
conflated the two, which would have produced a `report` view for an operation that mutates state.

This is also the moat: a competitor with 31 hand-written tools cannot copy it without rebuilding
their registry.

---

## 2. What already exists — reuse, do not reinvent

The repo is further along than a from-scratch plan would assume.

### 2.1 `REGISTRAR_MANIFEST` — a declarative manifest already exists

In `src/tools/annotations.ts`. Find them by symbol, not line — both drift as comments accrete:
`grep -n "export const REGISTRAR_MANIFEST\|export const manifestEntry" src/tools/annotations.ts`.
Each row is:

```ts
manifestEntry(
  'search',                                          // key
  'search',                                          // registrationKey
  lazyModule('./search.js', 'registerSearchTools'),   // RegistrarSpec: file + name + load()
  [1, 1821],                                         // baseline: [toolCount, schemaBytes]
  { readOnlySafe: true },
)
```

`manifestEntry` **derives a ceiling**: `toolCount + 1`, and `schemaBytes * 1.1`. Rows with a
`gatedSurface` are sized against the larger of default and opted-in figures. A startup gate refuses
to serve `tools/list` when a module breaches its ceiling.

House rule recorded in the file and worth preserving: *when a module grows, zero the baseline, let
the gate fail with the real figure, then write that figure back — never hand-raise a ceiling.*

There is **one row per module file (71)**. This is the registry-to-catalog seam v4 needs.

### 2.2 Lazy module loading already exists

`lazyModule('./x.js', 'registerXTools')` builds a thunk; `loadManifestRegistrars` resolves them. A
static import would evaluate all 71 modules before the toolset gate could answer — which is why
trimming once shrank payload but not startup or RSS. **A module whose key is inactive is never
evaluated.**

Consequence for v4: the catalog can describe capabilities from modules that were never loaded, as
long as `discover` does not instantiate their handlers.

### 2.3 `dispatchRegisteredTool` — the dispatch layer already exists

`src/tools/annotations.ts` (search for `export async function dispatchRegisteredTool`):

```ts
export async function dispatchRegisteredTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown> | undefined,
  extra: unknown,
): Promise<CallToolResult>
```

It reads the SDK registry and calls `dispatchToolCall`, producing results identical to a real
`tools/call` — including unknown-name refusals with near-matches, retired-alias refusals and
validation errors. `call_tool` uses it.

**v4 primitives must route through this**, not a private dispatch, so there is one behaviour and one
error vocabulary.

### 2.4 The discovery tools already exist

`src/tools/swarm3_meta.ts` (~418 lines) registers `find_tool`, `inspect_tool`, `call_tool`,
`enable_toolset`. Its header records two traps:

- The SDK stores tools in `_registeredTools` **keyed by name**; the value has no `name` field.
  Reading `tool.name` produced an empty registry, so every discovery tool reported "0 tools"
  regardless of the real count. **The key is the name.**
- All three declare `response_format` and emit via `shapeDiscoveryResult`; there is deliberately no
  `=== 'json'` branch in that file.

`enable_toolset` activates modules at runtime, emits exactly one
`notifications/tools/list_changed`, and reverts atomically on budget breach.

### 2.5 Annotations are applied post-registration and fail closed

`src/tools/annotations.ts` classifies every tool: read-only only if the name starts with an
allowlisted non-mutating verb and not a mutating one, except names in `NEVER_MUTATING_PLANS`. Wire
cost is minimised on purpose — `title` is omitted because duplicating the tool name cost ~25 KB.

**v4 must keep this.** A `write` primitive annotated `readOnlyHint` would let a host skip
confirmation on a destructive call. This is the highest-severity failure mode in the project.

### 2.6 Cost previews, receipts, dry-run and READONLY already exist

- `cost_preview` / `dry_run` pattern established (`show_new_episodes`, `whats_new`).
- Receipts: `formatReceipt`, `MAX_RECEIPTS`, `RECEIPT_ID_PATTERN`, `verifyReceipt`, plus
  `verify_receipt` / `undo_mutation` tools.
- `SPOTIFY_MCP_READONLY`, `SPOTIFY_MCP_HISTORY`, `SPOTIFY_MCP_RECEIPTS` gates.
- 47 module files reference `dry_run`; 34 receipt/undo references; 35 `READONLY` references.

v4 does not invent these — it makes them uniform across six primitives.

---

## 3. Target surface

Six MCP tools registered by default. Target **≤ 8 tools, ≤ 12,000 B schema** (from 131 / 150,111 B).
Every tool orthogonal: no description may need to explain when to use another tool.

### 3.1 `search` — find anything by intent

Collapses `search`, `search_deep`, `search_fresh`, `search_by_isrc`, `search_shows`,
`search_episodes`, `search_audiobooks`, `search_saved_*`, `whats_new`, `find_show_by_publisher`,
`added_on_this_day` and the search-history family.

```ts
search({
  query: string,
  kinds?: ("track"|"album"|"artist"|"playlist"|"show"|"episode"|"audiobook"|"chapter")[],
  scope?: "catalog" | "library" | "follows" | "history",    // default "catalog"
  sort?:  "relevance" | "newest" | "oldest" | "popularity",  // default "relevance"
  limit?: number,
  offset?: number,
})
```

**`scope` is the entire design.** It replaces the 943-character decision guide:

| v3 tool | v4 call |
|---|---|
| `whats_new` | `search({scope:"follows", sort:"newest"})` |
| `search_fresh` | `search({scope:"catalog", sort:"newest"})` |
| `search_by_isrc` | `search({query:isrc, kinds:["track"]})` — ISRC detected by shape |
| `search_saved_episodes` | `search({scope:"library", kinds:["episode"]})` |
| `search_deep` | `search({..., limit:50})` |

### 3.2 `read` — fetch records by id/URI

Collapses `get_*` (56 tools), the `get_several_*` batch family (7), and most resource templates.

```ts
read({
  uris: string[],                                        // spotify: URI, bare id, or URL
  expand?: ("tracks"|"episodes"|"albums"|"chapters")[],   // follow collection edges
  fields?: string[],
})
```

Batch-by-default retires `get_several_tracks/albums/artists/episodes/shows/audiobooks/chapters` and
turns the existing 403→per-id batch degradation into an implementation detail rather than a
documented `degraded_reason` contract to maintain.

### 3.3 `write` — mutate with receipts, dry-run by default

Collapses `add_to_playlist`, `remove_*`, `save_*`, `reorder`, `update_playlist`, `create_playlist`,
`clean_*`, `merge`, `split`, `trim`, `copy`, `move`, batch ops, snapshots and restore.

```ts
write({
  op: "add"|"remove"|"reorder"|"create"|"update"|"save"|"unsave"|"dedupe"|"merge"|"split"|"trim"|"copy"|"move"|"restore",
  target: string,
  items?: string[],
  dry_run?: boolean,     // DEFAULT TRUE — must be explicitly false to commit
  confirm?: boolean,     // for destructive ops
})
```

Return: `{ ok, receipt_id, preview?, applied?, inverse? }`; `receipt_id` feeds `undo_mutation`.

### 3.4 `playback` — player and session control

Collapses `play*`, `pause`, `resume`, `skip_*`, `seek`, `set_volume`, `adjust_volume`, `queue*`,
`transfer_playback`, `set_shuffle`, `set_repeat`, the podcast session pair, and wind-down
scheduling.

```ts
playback({
  op: "play"|"pause"|"resume"|"next"|"previous"|"seek"|"volume"|"queue"|"transfer"|"shuffle"|"repeat"|"plan"|"start",
  device?: string,
  uri?: string, context?: string,
  position_ms?: number, volume?: number,
  session_minutes?: number,      // for op:"plan"
  dry_run?: boolean,
})
```

**Carry forward this real limitation** (currently documented on `start_podcast_session`): Spotify
cannot apply resume offsets when queueing, so only the first episode can start at its resume point;
later episodes play from the beginning.

### 3.5 `report` — the view engine that absorbs the 47

```ts
report({
  view: string,          // enum or validated string
  range?: "1d"|"1w"|"1m"|"3m"|"6m"|"1y"|"all",
  group_by?: "artist"|"album"|"genre"|"year"|"month"|"device"|"hour",
  compare_to?: "previous_period"|"previous_year",
  limit?: number,
})
```

**Two-tier exposure — decide by measurement in M2, not by taste:**

- Tier 1: ~10 most common views as an enum in the schema.
- Tier 2: the rest reachable via `view` validated against the catalog and surfaced by `discover`.

An enum of 47 is still context; a free-string view costs an error round-trip. Measure both.

**Scope boundary — pick one and forbid the other in the catalog:** "what did I listen to most this
month" is arguably `report({view:"monthly_listening"})` *or*
`search({scope:"history", sort:"popularity"})`. Two tools that answer the same question is exactly
the ambiguity §1.1 diagnoses. Decide at M1 and encode the decision as a catalog invariant, so
`discover` can never return both for one intent.

### 3.5a `plan` — the 19 `*_plan` tools

`_plan` is a distinct family from `_report` and must not be folded into it. The 19 plans
(`album_representative_plan`, `dedupe_playlist_plan`, `merge_playlists_plan`,
`mark_episode_played_plan`, `decade_sampler_plan`, …) are **proposals that a caller then applies**,
which makes them the natural front half of `write`, not of `report`:

```ts
write({ op: "plan", view: "merge_playlists", args: {...}, dry_run: true })
```

Open decision for M1: give `write` an `op:"plan"` that returns the proposal plus a `receipt`-style
token the agent can apply in a second call, **or** keep `plan` as a sixth-and-a-half surface. The
former is cleaner but makes `write`'s `op` enum wider, which is already §5.2's weak point.

### 3.6 `discover` — the catalog front door

Replaces `find_tool` + `inspect_tool` + `call_tool` + `enable_toolset`.

```ts
discover({
  intent?: string,          // natural language
  capability?: string,      // exact id → schema + examples
  primitive?: Primitive,
  limit?: number,
})
```

**Hard rule: `discover` returns EXECUTABLE results, not names.**

```json
{ "matches": [
  { "capability": "monthly_listening",
    "primitive": "report",
    "args": { "view": "monthly_listening", "range": "1m" },
    "why": "monthly listening totals over a one-month window",
    "cost": { "requests": 2 } } ] }
```

If it returns a list of names, the agent needs a second round-trip and v4 becomes *slower* than v3 —
the project's central failure mode (§5.1).

`discover` must also describe capabilities from **inactive** modules (trimmed by toolset) without
loading them, activating only when the agent actually invokes one.

### 3.7 Escape hatch

Every primitive accepts `capability: string` + `args: object` to call a catalog entry directly,
bypassing the enum. This preserves v3's `call_tool` ergonomics for a caller that already knows the
name, without adding a seventh tool.

---

## 4. Architecture

### 4.1 The capability catalog

New: `src/catalog/types.ts`, `src/catalog/index.ts`.

```ts
export type Primitive = 'search' | 'read' | 'write' | 'playback' | 'report' | 'discover';

export interface Capability {
  id: string;                     // stable: "artist_velocity"
  primitive: Primitive;
  summary: string;                // ONE sentence, <=120 chars, NO decision guide
  paragraph?: string;             // detail shown only by discover({capability})
  args: z.ZodTypeAny;             // validated at CALL time, not registration time
  view?: string;                  // report view id
  scope?: 'catalog'|'library'|'follows'|'history';   // search scope mapping
  scopes: SpotifyScope[];
  cost: { requests: number | ((a: unknown) => number) };
  readOnly: boolean;
  destructive?: boolean;
  handler: (args: unknown, ctx: HandlerContext) => Promise<Result>;
  examples: { intent: string; args: object }[];      // powers discover ranking
  legacyNames?: string[];         // v3 names this replaced
}
```

`legacyNames` is load-bearing: it generates the migration table, powers one release of alias
resolution, and lets `discover` answer "what happened to `whats_new`".

### 4.2 Bridging the existing manifest

Do **not** rewrite the 71 module files. Two stages:

1. Each `registerXxxTools` module additionally exports `capabilities: Capability[]` next to its
   existing `server.tool(...)` calls. Existing registrations stay until M3.
2. `src/catalog/index.ts` aggregates them lazily under the same `lazyModule` discipline, so an
   inactive module's handlers are never instantiated.

This keeps the diff reviewable: 71 small files gain an export; one new directory; one primitive
registrar.

### 4.3 Registration

`registerPrimitives(server, client, catalog)` must:

- honour `SPOTIFY_MCP_READONLY` (hide `write`), the v4 flag during M2, and toolset trims;
- apply annotations **fail-closed and correctly** — `search`/`read`/`report`/`discover` are
  `readOnlyHint: true`; `write` is destructive per op; `playback` is **not** read-only when the op
  mutates;
- emit one `notifications/tools/list_changed` if the surface changes at runtime.

### 4.4 The schema-budget gate will fight you

`collectAggregateSurfaceMeasurement` + `assertAggregateSurfaceBudget` enforce 620,000 B, and the tree
sits at **605,374 B** (2.5% headroom; 0.9% with analytics opted in).

While v3 and v4 coexist the surface **grows**, and the gate will refuse to start. Plan for it:

- During M1/M2, either gate the v4 primitives out of the measurement, or make **one deliberate,
  documented cap change** for the coexistence period in the same comment style the file already uses.
  The house rule forbids hand-raising a ceiling to let a breach pass; an explained temporary cap for
  a known period is a different thing, and must read like one.
- At M3 the surface **shrinks by an order of magnitude**, and the cap should be *lowered* to
  something meaningful — which is itself a headline result.

### 4.5 Regenerate, never hand-edit

- `scripts/surface-census.mjs` (`npm run count:tools`, `--check`, `--write`) generates the
  `BEGIN/END:generated surface-census` blocks in `README.md` and `docs/configuration.md`.
- `scripts/check-doc-tool-names.mjs` (`npm run check:doc-tool-names`) validates that docs name real
  registered tools. **It will fail loudly after v4 removes names** — that is the gate working.
- `SPEC.md` (3,420 lines) enumerates every tool, resource and prompt. Regenerate it or it becomes a
  lie.
- `scripts/prose-manifest.mjs` + `doc-prose-manifest.json` handle prose checks.

---

## 5. Risks, ranked by likelihood of killing the project

### 5.1 Fewer tools can mean MORE turns

If `discover` is not excellent, an agent spends a round-trip discovering before acting, and v4 is
slower than v3 while looking tidier. **This is why a baseline harness is M0 and why it scores turns
and characters read, not just correctness.** Mitigations: executable `discover` results; the
`capability` escape hatch; a Tier-1 enum for common report views.

### 5.2 `write` loses per-op schema precision

An `op` enum means the advertised schema is looser, so an agent can send a plausible-but-wrong
argument. A discriminated union would fix it *if the SDK projects one usefully* — verify that first,
before designing around it. Otherwise validate hard and return a corrective error naming the right
shape.

### 5.3 Annotation errors become safety incidents

See §2.5. Add a test that fails if any mutating primitive is annotated read-only.

### 5.4 The budget gate blocks coexistence

See §4.4. Expect a refusal to start on the first M2 build; treat it as working as designed.

### 5.5 Breaking 562 names breaks saved prompts

Accepted. Ship `docs/migration-v4.md` generated from `legacyNames`, not hand-written prose.

### 5.6 Stats.fm and experimental analytics are awkward fits

`statsfm` is 30 tools / 29,481 B and needs a separate username; `SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS`
gates 11 more for Developer-Policy reasons (derived listenership metrics). Decide early whether
these become `report` views, stay separate tools, or are pruned. They are the largest remaining
block after the reports.

---

## 6. Milestones

Do not start M(n+1) until M(n)'s measurement is written down.

### M0 — Baseline harness (no production risk)

- [ ] Build in a **separate worktree** so the published `dist/` is never replaced mid-session.
- [ ] `docs-internal/eval/intents.json` — ~40 realistic intents across search/read/report/playback/
      write, including **6 deliberate ambiguity traps** ("what's new", "my top stuff", "clean up
      duplicates", "what am I into", "queue some podcasts", "find that album").
- [ ] `docs-internal/eval/run.mjs` — spawn the server over stdio, `tools/list`, then per intent drive
      a scripted turn and record `{chosen_tool, args, turns, description_chars_read, correct}`.
- [ ] Record baseline: mean turns/task, mean chars read, correct-primitive rate.

### M1 — Catalog + `discover` (additive)

- [ ] `src/catalog/{types,index}.ts`; `Capability`; aggregate from module exports.
- [ ] Descriptors for all 562 — mostly mechanical: one `summary` each with decision guides stripped.
      **This is the bulk of the writing work.**
- [ ] `discover` with keyword/heuristic ranking. Do **not** add a model dependency to a local stdio
      server; start with curated `examples[].intent` scoring and measure.
- [ ] Ship behind a flag, alongside the v3 surface.

### M2 — Six primitives alongside v3

- [ ] Implement all six against the catalog, routing through `dispatchRegisteredTool` where a v3
      handler is reused.
- [ ] Flag-on registers primitives **instead of** the legacy surface, to keep the budget honest.
- [ ] Measure both surfaces on the same 40 intents with the same harness.
- [ ] Settle `report` tiering by measurement.

### M3 — Flip the default, delete dead weight

- [ ] Six tools by default; legacy names resolvable only via `discover` + alias map for one release.
- [ ] Delete the 47 core view tools, the 19 `*_plan`, `get_several_*` (7) and the `search_*`
      variants.
      **Do NOT bulk-delete `_stats`.** 7 of the 14 `_stats` tools are `statsfm_*_stats` and belong
      to the separate stats.fm opt-in; deleting by suffix would silently remove a whole integration.
      Delete by explicit name list generated from the catalog, and assert the count before and after
      so an over-broad pattern cannot pass review.
- [ ] Lower the aggregate schema cap; re-baseline every `manifestEntry` ceiling per house rule.
- [ ] Generate `docs/migration-v4.md`; regenerate census blocks and `SPEC.md`.

### M4 — Harden and document

- [ ] `cost.requests` drives every `cost_preview`/`dry_run` figure — replace 300-word WARNING prose
      in descriptions with structured cost.
- [ ] Receipts on every `write` op; undo proven by round-trip test.
- [ ] Annotation fail-closed test.
- [ ] Docs overhaul (§7).

---

## 7. Docs overhaul

Current: `README.md` (344 lines), `SPEC.md` (3,420 lines), `ARCHITECTURE.md`, `CONTRIBUTING.md`,
`CHANGELOG.md`, and 14 files in `docs/`.

> **Line numbers drift.** These were measured at `1fff538`; upstream has since reworded the release
> banner, which shifts prose without moving the headings. Re-measure before quoting any of them —
> `grep -n '^## ' README.md` and `wc -l README.md` are the two commands.

Measured problems:

- `## Quick start` sat at **line 72** at `1fff538` (line 62 was `Why this one`). Badges, a release
  banner, a five-step paste-this-to-your-agent block with a terms citation and a `Why this one`
  table all precede the install. A reader decides in ~15 seconds and the install is ~70 lines down.
- The real default surface number is buried in a generated comment block near the top of the file.
- `faq`/`non-goals`/`compliance` overlap substantially on gating.

Proposed:

- **README** ≤ 120 lines: what it is → one-line install → the six tools in a table → three example
  prompts → docs links.
- `docs/getting-started.md` — install, auth, first calls, doctor.
- `docs/tools.md` — the six primitives, **generated** from the catalog.
- `docs/catalog.md` — every capability, **generated**.
- `docs/costs.md` — request model, `cost_preview`, quotas. Replaces warning prose.
- `docs/writes.md` — dry-run, receipts, undo, READONLY. The safety story in one place.
- `docs/migration-v4.md` — **generated** from `legacyNames`.
- Fold `faq.md`/`non-goals.md`/`compliance.md` overlap into one compliance doc.

**Rule:** any doc stating a count or a tool name must be generated or checked by
`surface-census --check` / `check-doc-tool-names`. The tooling exists; the overhaul should make a
hand-written stale number impossible.

---

## 8. Validation protocol

- Harness talks to a **worktree build**, never the published `dist/`.
- Reads only; any write intent runs with `dry_run:true`. Nothing in a real account changes.
- Rate limits are real: a dev-mode app has a small quota, and a personal-new-releases scan can cost
  one request per saved show. Budget the corpus and cache between runs.
- Score `correct_primitive`, `correct_args`, `turns`, `description_chars_read`, `requests_issued`.
- **v4 ships only if correctness >= baseline AND turns < baseline.**
- Run the six ambiguity traps every time: a six-tool surface can look better on tidy intents while
  being worse exactly where v3 was bad.

---

## 9. Open questions

1. Do discriminated unions for `write`/`playback` ops project usefully through the SDK? (§5.2)
2. Report tiering: 10-view enum plus free string, or all 47 in the enum? Measure in M2.
3. `statsfm` and experimental analytics: report views, separate tools, or prune? (§5.6)
4. Does `discover` need embeddings? Prefer not. Start with curated intent examples; measure first.
5. Where does `search` stop and `report` start? "What did I listen to most" is arguably
   `search({scope:"history", sort:"popularity"})`. Pick one, forbid the other in the catalog.
6. Do `verify_receipt` / `undo_mutation` remain tools, or fold into `write`'s result? Leaning: fold
   in, keep the escape hatch.

---

## 10. Frozen baseline (re-measure after any pull)

v3.1.1, measured 2026-11-08:

```
tools_total ................. 562
tools_default ............... 131
default_schema_bytes ........ 150,111
sum_default_descriptions .... 32,373 chars (22% of payload)
mean_description_chars ...... 247
resources ................... 17
resource_templates .......... 28
prompts ..................... 14
tool_module_files ........... 71
registration_keys ........... 49
aggregate measured .......... 562 tools / 605,374 B
aggregate cap ............... 620,000 B (enforced 621,000)
headroom .................... 15,626 B (2.52%)
headroom w/ analytics ....... 5,638 B (0.91%) "effectively exhausted"
metadata overhead ........... 65,633 B (10.8%)
per-module schema total ..... 539,741 B
```

**Target for v4:** ≤ 8 tools, ≤ 12,000 B default schema — a **92% surface reduction**, with
capability preserved behind `discover`.

---

## 11. First actions on resume

```bash
cd /path/to/spotify-mcp-server
git status --short          # expect clean
git pull                    # was 10 commits behind at planning time
grep '"version"' package.json
npm ci && npm run build
npm run count:tools         # re-measure §10 before trusting any figure here

# only then:
git worktree add ../smt-v4 -b feat/v4-agent-surface
cd ../smt-v4 && npm ci && npm run build
```

Then M0. Do not write a primitive before the baseline harness exists — without it every v4 claim is
unfalsifiable, and the project repeats the mistake its own README apologises for.

---

## 12. Self-critique — errors found in this plan and fixed

Recorded so a resumer does not re-introduce them. Each was caught by checking the plan against the
census rather than against memory.

| # | Defect | Fix |
|---|---|---|
| 1 | **"44 report tools"** came from a `contains` regex `report\|brief\|census\|analytics\|insight\|dna`. That both **under**-counted (`_stats` was excluded entirely, so 14 shaped reads were invisible) and mis-grouped. | Replaced with explicit `endsWith` counts: the shaped-read family is **56**, of which **47** core and **9** stats.fm/taste. |
| 2 | **"Delete the 44 `*_report\|census\|brief\|stats`"** in M3 — following that would have deleted **7 `statsfm_*_stats` tools**, silently removing a whole opt-in integration. | M3 now says delete by generated explicit name list from the catalog, with a count assertion before/after, and carries an explicit "do not bulk-delete `_stats`" warning. |
| 3 | **`_snapshot` was listed as a view family** ("same for snapshot (11)"). All 11 are snapshot CRUD (save/delete/restore/diff/list) — mutations, not shaped reads. Folding them into `report` would have produced a report view that changes state. | §1.3 now states `_snapshot` belongs to `write` (`op:"snapshot"`), not `report`. |
| 4 | **`_plan` (19) had no home.** It was mentioned in a count table and then never assigned to a primitive, so 19 tools were unaccounted for between M2 and M3. | New §3.5a: plans are proposals-then-apply, so they are `write({op:"plan"})`; the alternative is stated with its trade-off. |
| 5 | **Duplicate answer paths not closed.** "What did I listen to most this month" is answerable by both `report({view:"monthly_listening"})` and `search({scope:"history",sort:"popularity"})`. Two tools answering one question is precisely the ambiguity §1.1 diagnoses, and v4 would have shipped it. | §3.5 adds a scope boundary to be decided at M1 and enforced as a catalog invariant, so `discover` cannot return both for one intent. |
| 6 | **Hard-pinned line numbers** (`annotations.ts ~1708/~1600`, `README.md line 72`, `line 15`) which upstream already invalidated by rewording the release banner. | Replaced with symbol `grep`s and an explicit "line numbers drift, re-measure" note. |
| 7 | **Stale gate reference** — the plan cited `check:tests-typecheck`, which upstream **deleted** (script removed, folded into a plain `tsc --noEmit`). | Removed from the plan; `lint:scripts`, `check:docs-counts` and `check:doc-tool-names` are the live gates, all three verified green. |

Still open, and deliberately not resolved here (they need measurement, not thought): §5.2
discriminated unions, §3.5 report tiering, §5.6 stats.fm placement.

**What the critique did not change:** the core thesis. 47 shaped-read tools collapsing into one
`report` primitive with 47 views is still true, still measured, and still the strongest argument —
the correction made the family *larger* (47, not a mis-derived 44), not smaller.
