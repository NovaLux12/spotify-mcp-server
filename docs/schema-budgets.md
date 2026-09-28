# Tool schema budgets

`src/tools/annotations.ts` owns the shared `REGISTRAR_MANIFEST`. Each entry records
its stable module key, existing toolset registration key, source file, registrar,
measured baseline, and explicit byte/tool-count ceilings. The same manifest drives
startup registration, the CI audit, and the per-module table returned by
`toolset_report`; tests must not maintain a second registrar list.

## Measurement

The deterministic audit starts the real production entry over stdio, reads the
result after all finalizers, and attributes those tool names through the shared
manifest. For each module it measures:

- tool count;
- UTF-8 bytes of compact JSON containing the tool `description` and emitted
  `inputSchema` JSON Schema (the same schema hosts receive from `tools/list`).

The production `tools/list` boundary, module measurements, and aggregate gate all
use the same finalized input-schema projection: SDK-compatible normalization,
input-direction JSON Schema, `additionalProperties: false`, and no `$schema`
key. The aggregate gate runs after annotations and final boundary metadata are
applied, so it measures the payload after every finalizer that shapes it. It is
still not the whole payload: the gate does not charge `outputSchema`, which is
the one field the wire can carry and the gate cannot see. What it bounds is
stated in full under
[the aggregate ceiling](#aggregate-ceiling-and-the-payload-it-guards).

Annotations, tool names, resources, and prompts are intentionally excluded from
this module-attribution measurement. A module is `active`, `toolset_trimmed`,
`scope_filtered`, or `read_only_hidden`; inactive rows report zero live tools
and list what host trimming drops. A `scope_filtered` row is the exception: the
module registered the tools `classifyToolAnnotations` proves read-only and
withheld the writers its granted scopes cannot reach (#1020), so it is still
measured against its ceiling.

## Registration order

Registration is core-first and deterministic:

1. `search`
2. `catalog`
3. `library`
4. `playback`
5. `following`, `users`, `audiobooks`, and common playlist workflows
6. discovery, library operations, portability, analytics, and specialised slices
7. swarm/specialised modules

The stable core prefix asserted by `tests/tool.surface.test.ts` runs from the
start of `search` to the end of `playback`; the test derives its length from the
first four manifest baselines, so this page deliberately does not repeat the
count. Every manifest module is registered exactly once, and the audit proves
each live tool belongs to exactly one module. The aggregate ceilings constrain
module weight; they do not constitute a complete historical tool-name
inventory.

### Baseline raises

Baselines are hand-maintained in `src/tools/annotations.ts` and must be moved
to the measured value whenever a module's real `tools/list` weight changes —
`--write` refreshes the table below but never the manifest. A module left at a
stale baseline silently loses its 10% headroom for the next contributor.

- **#900** — `freshness` 2,043 → 2,235 and `swarm3discovery` 21,825 → 22,277
  schema bytes, both description text only. The tools' inputs, outputs and
  counts are unchanged (1 and 24). Five descriptions quoted a per-artist cost
  — "N followed artists = N+1 API requests", "1 small albums call per followed
  artist", "N small API calls" — that became conditionally false once those
  lookups became the one shared canonical release probe: a repeat scan inside
  the read-cache window spends a probe and no request. They now say that.
  The registry was 592 tools before and after; the change's cost against the
  aggregate ceiling is in the generated block below, not here. No aggregate
  raise, and no ceiling moved to make a breach disappear.

  These figures describe the tree this branch sits on. `main` moves under this
  work, and both module baselines have already drifted once under it
  (`swarm3discovery` was 21,887 before #1227's neighbourhood landed), so a
  figure that was true against an earlier base stops being true against this
  one. The manifest entries beside this note are the live values; re-measure
  rather than trusting the prose if you are reading this much later.

## Checked-in baseline and ceilings

The generated table below is produced from the shared manifest and the same
per-module registry measurement used by startup and `toolset_report`. The
`surface-census --check` guard rejects a stale row or a baseline that no longer
matches the finalized registry. The source manifest derives current ceilings as
**baseline tools + 1** and **110% of baseline schema bytes**; these effective
ceilings are authoritative and are reported by `toolset_report`. A schema change
above either ceiling fails CI and server startup.

### Aggregate ceiling and the payload it guards

The per-module ceilings above bound one module each. A second gate bounds the
whole default surface: `AGGREGATE_SURFACE_LIMITS` in `src/tools/annotations.ts`
caps the serialized `tools/list` payload a host session receives. It is
**not** a description-plus-inputSchema figure — each tool is serialized as
`{name, title, description, inputSchema, annotations, execution, _meta}`, so a
measurable share of the budgeted bytes are names, titles and metadata that the
per-module table excludes. Size a raise against the aggregate number.

**What that field list is, and the one field in it that is not charged.** The
list above is the literal in `collectAggregateSurfaceMeasurement`
(`src/tools/annotations.ts`), and it is the same projection the `tools/list`
boundary in `installToolErrorBoundary` serves, field for field — *except* for
`outputSchema`, which the boundary emits and the gate omits. A tool declaring
one is charged nothing for bytes every host receives, so the gate is enforced
against a payload that cannot contain the field it is blind to ([#1396]).

That is a statement about the gate's reach, not about the figures above. **No
tool on this tree declares an `outputSchema`**, so today the measured payload
and the wire payload are the same bytes and every number on this page is
complete. The two stop being the same on the day one is declared, which is why
the omission is recorded here rather than left to be discovered: a ceiling that
silently stops covering part of the payload is worse than one that never
claimed to, because it prints a confident number. Do not read a passing gate as
evidence that an `outputSchema` was counted. #1393 fixes the measurement;
until it merges, the honest scope of this gate is the field list above.

<!-- BEGIN:generated aggregate-budget -->
| Figure | Value | Where it comes from |
|---|---:|---|
| `TOOL_SURFACE_BUDGET.defaultMaxTools` | 620 tools | code constant, `src/tools/annotations.ts` |
| `TOOL_SURFACE_BUDGET.defaultMaxBytes` | 611,000B | code constant, `src/tools/annotations.ts` |
| `AGGREGATE_SURFACE_LIMITS.maxBytes` (enforced) | 612,000B | the ceiling plus 1,000B of post-registration annotation metadata |
| Measured `tools/list` payload | 601,469B | `collectAggregateSurfaceMeasurement` over the finalized registry, after annotations |
| Of which outside the per-module table | 65,294B | 10.9% of the payload — tool names, titles, annotations and boundary metadata |
| Headroom | 10,531B | 1.7% of the enforced limit |

Headroom is **10,531B** of the 612,000B enforced limit — 1.7% — so the aggregate budget is **tight**.

The limit above is enforced at startup against whichever surface the process
registered, so the figure that matters is the one for the surface you run.
With `SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS` set, that is:

| Opted-in surface (`tools/list`) | Value | Where it comes from |
|---|---:|---|
| `SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS=1` | 611,457B | 570 tools — the same measurement, registered with the opt-in on |
| Added by the opt-in | 9,988B | +11 tools over the default surface, measured rather than summed (see below) |
| Headroom with the opt-in | 543B | 0.1% of the enforced limit — **effectively exhausted** |

The default surface reports 19.39× as much room — 10,531B against the opt-in's 543B. Neither surface breaches the limit today; an opted-in install is simply the one with less room to grow.

The byte figure is measured, not derived from the manifest. The per-module `gatedSurface` byte deltas sum to **8,683B** against a measured **9,988B**, a 1,305B shortfall: the per-module budget charges description + input schema + output schema, while the aggregate charges every tool's name, title, annotations, execution and `_meta` as well. A derived ceiling would under-report by more than a kilobyte. The tool count has no such gap — the manifest declares 11 and the measurement finds 11 — so it is cross-checked rather than measured twice.

Regenerate with `npm run count:tools -- --write`. `--check` fails when any
figure above stops matching the constants or the live measurement, so a
ceiling raise lands in this file as a diff you can read, not as prose that
quietly keeps describing the old one.
<!-- END:generated aggregate-budget -->

**Nothing in that block is hand-typed, and that is the whole point.** The
version of this page that carried those numbers inline had frozen at an
intermediate raise: the ceiling, the enforced limit, the measurement, the
headroom, and the "the budget is effectively exhausted" conclusion drawn from
them were all copied off a tree that no longer existed, and together they
understated the real headroom by an order of magnitude. The conclusion is now a
band over the measured ratio, so it moves when the surface moves and nobody has
to remember to re-argue it (#1241).

**A raise is argued for, never spent.** The history of raises, and the measured
warrant behind each, lives in the `TOOL_SURFACE_BUDGET` comment trail in
`src/tools/annotations.ts` — which is where a number that has to stay true
belongs. Copying one out of there into this page is precisely how the two
diverged.

**Re-measure before trusting a recorded figure.** Recorded budgets on this
project have been stale in both directions: one overstated the pressure by a
rounding error, another overstated the headroom by tens of kilobytes. Both
errors point the same way, because prose invites you to write the number you
expect. Measure by building the registry the way `src/index.ts` does and calling
`collectAggregateSurfaceMeasurement`; `assertAggregateSurfaceBudget` puts the
measured byte count in its error message if you lower the limit to force one.
The census does exactly that, which is why the block above is generated rather
than maintained.

<!-- BEGIN:generated schema-budget-table -->
| Module | Tools | Schema bytes | Baseline tools | Baseline bytes | Effective tool ceiling | Effective byte ceiling |
|---|---:|---:|---:|---:|---:|---:|
| search | 1 | 1,821 | 1 | 1,821 | 2 | 2,004 |
| catalog | 31 | 27,222 | 31 | 27,222 | 32 | 29,945 |
| library | 13 | 13,095 | 13 | 13,095 | 14 | 14,405 |
| playback | 15 | 14,441 | 15 | 14,441 | 16 | 15,886 |
| following | 3 | 2,502 | 3 | 2,502 | 4 | 2,753 |
| users | 2 | 1,696 | 2 | 1,696 | 3 | 1,866 |
| audiobooks | 4 | 3,715 | 4 | 3,715 | 5 | 4,087 |
| audiobookcopilot | 3 | 1,985 | 3 | 1,985 | 4 | 2,184 |
| playlists | 26 | 26,562 | 26 | 26,562 | 27 | 29,219 |
| playlistops | 3 | 4,392 | 3 | 4,392 | 4 | 4,832 |
| playlistbatch | 3 | 5,558 | 3 | 5,558 | 4 | 6,114 |
| playlistfollow | 4 | 3,807 | 4 | 3,807 | 5 | 4,188 |
| playlistmisc | 1 | 1,089 | 1 | 1,089 | 2 | 1,198 |
| personalization | 3 | 2,532 | 3 | 2,532 | 4 | 2,786 |
| analytics | 3 | 1,908 | 3 | 1,908 | 5 | 3,099 |
| statsfm | 30 | 29,481 | 30 | 29,481 | 31 | 32,430 |
| taste | 8 | 8,308 | 8 | 8,308 | 9 | 9,139 |
| tastecomposites | 10 | 10,362 | 10 | 10,362 | 11 | 11,399 |
| tasteplaylist | 1 | 1,896 | 1 | 1,896 | 2 | 2,086 |
| tastejukebox | 1 | 2,371 | 1 | 2,371 | 2 | 2,609 |
| doctor | 1 | 825 | 1 | 825 | 2 | 908 |
| accounts | 2 | 1,644 | 2 | 1,644 | 3 | 1,809 |
| swarm3meta | 3 | 2,248 | 3 | 2,248 | 4 | 2,473 |
| moodexpand | 1 | 987 | 1 | 987 | 2 | 1,086 |
| libraryanalytics | 3 | 2,498 | 3 | 2,498 | 5 | 3,687 |
| portability | 11 | 10,453 | 11 | 10,453 | 12 | 11,499 |
| libraryinsights | 3 | 2,751 | 3 | 2,751 | 4 | 3,027 |
| libraryhygiene | 1 | 804 | 1 | 804 | 2 | 885 |
| showradar | 1 | 2,125 | 1 | 2,125 | 2 | 2,338 |
| saveddedupe | 1 | 1,438 | 1 | 1,438 | 2 | 1,582 |
| podcastsession | 2 | 3,427 | 2 | 3,427 | 3 | 3,770 |
| backupfirst | 1 | 513 | 1 | 513 | 2 | 565 |
| backup | 2 | 1,724 | 2 | 1,724 | 3 | 1,897 |
| backupdelete | 1 | 959 | 1 | 959 | 2 | 1,055 |
| restore | 1 | 2,072 | 1 | 2,072 | 2 | 2,280 |
| undo | 2 | 1,663 | 2 | 1,663 | 3 | 1,830 |
| receipts | 1 | 626 | 1 | 626 | 2 | 689 |
| episodemgmt | 1 | 1,139 | 1 | 1,139 | 2 | 1,253 |
| freshness | 1 | 2,672 | 1 | 2,672 | 2 | 2,940 |
| searchdive | 1 | 1,683 | 1 | 1,683 | 2 | 1,852 |
| searchhistory | 2 | 1,096 | 2 | 1,096 | 3 | 1,206 |
| browse | 1 | 436 | 1 | 436 | 2 | 480 |
| artistwatch | 6 | 6,284 | 6 | 6,284 | 7 | 6,913 |
| queueops | 3 | 3,293 | 3 | 3,293 | 4 | 3,623 |
| playbackext | 13 | 8,331 | 13 | 8,331 | 14 | 9,165 |
| playbackintel | 13 | 10,315 | 13 | 10,315 | 14 | 11,347 |
| scenes | 7 | 4,514 | 7 | 4,514 | 8 | 4,966 |
| playlisthealth | 8 | 5,713 | 8 | 5,713 | 9 | 6,285 |
| playlistdna | 1 | 1,310 | 1 | 1,310 | 2 | 1,442 |
| lanes | 2 | 1,824 | 2 | 1,824 | 3 | 2,007 |
| export | 1 | 1,363 | 1 | 1,363 | 2 | 1,500 |
| import | 1 | 1,322 | 1 | 1,322 | 2 | 1,455 |
| smart | 1 | 2,364 | 1 | 2,364 | 2 | 2,601 |
| exhaustmisc | 10 | 8,291 | 10 | 8,291 | 11 | 9,121 |
| exhaust2catalog | 19 | 19,443 | 19 | 19,443 | 20 | 21,388 |
| exhaust2enggating | 0 | 0 | 0 | 0 | 1 | 0 |
| exhaust2playback | 18 | 14,279 | 18 | 14,279 | 19 | 15,707 |
| exhaust2playlists | 18 | 24,403 | 18 | 24,403 | 19 | 26,844 |
| exhaust2misc | 27 | 24,664 | 27 | 24,664 | 28 | 27,131 |
| exhaust2extra | 3 | 4,092 | 3 | 4,092 | 4 | 4,502 |
| swarm3discovery | 24 | 22,483 | 24 | 22,483 | 25 | 24,732 |
| swarm3bdiscovery | 24 | 20,147 | 24 | 20,147 | 25 | 22,162 |
| swarm3shows | 24 | 22,344 | 24 | 22,344 | 25 | 24,579 |
| swarm3refs | 6 | 4,331 | 6 | 4,331 | 7 | 4,765 |
| swarm3analytics | 15 | 12,030 | 15 | 12,030 | 25 | 20,847 |
| swarm3library | 24 | 18,283 | 24 | 18,283 | 25 | 20,112 |
| swarm3playback | 17 | 10,006 | 17 | 10,006 | 18 | 11,007 |
| swarm3playlistops | 24 | 29,163 | 24 | 29,163 | 25 | 32,080 |
| swarm3snapshots | 24 | 23,829 | 24 | 23,829 | 25 | 26,212 |
| swarm4playlists | 18 | 23,228 | 18 | 23,228 | 19 | 25,551 |
<!-- END:generated schema-budget-table -->

To change a baseline, measure the real `tools/list` output, update the shared
manifest, run `npm run count:tools -- --write`, and document the host-session
payload impact in this page or the PR rationale.

## Response payload cap — a different budget from this one (#895)

This page budgets **one-time** bytes: what a host reads once from `tools/list`
and then carries for the whole session. #895 added a cap on a different
quantity — **per-call** bytes, the size of one tool *result* — and the two are
easy to conflate because both are "how big does a host's context get".

They are sized against each other, and the relationship is worth stating
plainly because it is the only reason the cap is the number it is:

<!-- BEGIN:generated response-cap -->
| | what it bounds | how often the host pays | ceiling |
|---|---|---|---|
| Schema budget (above) | `tools/list` — every tool's description and input schema | once per session | 611,000B |
| Response cap (`MAX_RESPONSE_BYTES`) | one `tools/call` result's json text + `structuredContent` | once per **call**, repeatable | 64,000B |

`MAX_RESPONSE_BYTES` is ~1/10 of the schema budget: 10 capped calls cost about what the schema surface cost once. That is the whole argument for the ratio.
<!-- END:generated response-cap -->

That ratio holds because an
unbounded result was measured at 124KB (one 500-stream stats.fm page) and up to
500KB (`diff_playlists` over two 5,000-track playlists), which is a quarter to
four fifths of the entire schema surface, from a single repeatable call.

Three consequences worth keeping straight:

- **The response cap is not part of any budget measured here.** It is a
  response-time constant in `src/shaping.ts`. It cannot raise or lower a schema
  ceiling, because the aggregate gate measures `tools/list` and no tool's
  description or input schema depends on it. Adding it required no baseline
  re-measurement and no warrant.
- **It is a backstop, not the primary control.** A tool declaring `max_results`
  caps itself at a far finer grain and never reaches the ceiling above. What the
  response cap guarantees is narrower and still worth having: no tool can
  return an unbounded payload *even if it forgot to*.
- **A cap that truncates silently is worse than no cap.** A caller cannot tell a
  capped result from a complete one, and will report it as complete — the same
  failure class as #803 and #804. So a capped result always carries a
  `response_cap` receipt naming every field it dropped and how large each was.
  See SPEC.md § Shared tool contract for the shape.
