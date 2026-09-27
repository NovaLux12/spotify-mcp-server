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
applied, so its budget covers the payload hosts actually receive.

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
caps the total serialized `tools/list` payload a host session receives. It is
**not** a description-plus-inputSchema figure — each tool is serialized as
`{name, title, description, inputSchema, annotations, execution, _meta}`, so a
measurable share of the budgeted bytes are names, titles and metadata that the
per-module table excludes. Size a raise against the aggregate number.

<!-- BEGIN:generated aggregate-budget -->
| Figure | Value | Where it comes from |
|---|---:|---|
| `TOOL_SURFACE_BUDGET.defaultMaxTools` | 620 tools | code constant, `src/tools/annotations.ts` |
| `TOOL_SURFACE_BUDGET.defaultMaxBytes` | 620,000B | code constant, `src/tools/annotations.ts` |
| `AGGREGATE_SURFACE_LIMITS.maxBytes` (enforced) | 621,000B | the ceiling plus 1,000B of post-registration annotation metadata |
| Measured `tools/list` payload | 607,227B | `collectAggregateSurfaceMeasurement` over the finalized registry, after annotations |
| Of which outside the per-module table | 68,978B | 11.4% of the payload — tool names, titles, annotations and boundary metadata |
| Headroom | 13,773B | 2.2% of the enforced limit |

Headroom is **13,773B** of the 621,000B enforced limit — 2.2% — so the aggregate budget is **tight**.

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
| catalog | 31 | 26,883 | 31 | 26,883 | 32 | 29,572 |
| library | 16 | 14,932 | 16 | 14,932 | 17 | 16,426 |
| playback | 16 | 12,077 | 16 | 12,077 | 17 | 13,285 |
| following | 5 | 3,948 | 5 | 3,948 | 6 | 4,343 |
| users | 2 | 1,613 | 2 | 1,613 | 3 | 1,775 |
| audiobooks | 4 | 3,715 | 4 | 3,715 | 5 | 4,087 |
| audiobookcopilot | 3 | 1,985 | 3 | 1,985 | 4 | 2,184 |
| playlists | 26 | 26,214 | 26 | 26,214 | 27 | 28,836 |
| playlistops | 3 | 5,348 | 3 | 5,348 | 4 | 5,883 |
| playlistbatch | 3 | 4,896 | 3 | 4,896 | 4 | 5,386 |
| playlistfollow | 2 | 1,449 | 2 | 1,449 | 3 | 1,594 |
| playlistmisc | 1 | 1,089 | 1 | 1,089 | 2 | 1,198 |
| personalization | 3 | 2,532 | 3 | 2,532 | 4 | 2,786 |
| analytics | 4 | 2,817 | 4 | 2,817 | 5 | 3,099 |
| statsfm | 30 | 22,917 | 30 | 22,917 | 31 | 25,209 |
| taste | 16 | 14,005 | 16 | 14,005 | 17 | 15,406 |
| tastecomposites | 10 | 8,040 | 10 | 8,040 | 11 | 8,844 |
| tasteplaylist | 1 | 1,723 | 1 | 1,723 | 2 | 1,896 |
| doctor | 1 | 750 | 1 | 750 | 2 | 826 |
| swarm3meta | 3 | 2,023 | 3 | 2,023 | 4 | 2,226 |
| libraryanalytics | 4 | 3,351 | 4 | 3,351 | 5 | 3,687 |
| portability | 11 | 10,036 | 11 | 10,036 | 12 | 11,040 |
| libraryinsights | 3 | 2,751 | 3 | 2,751 | 4 | 3,027 |
| libraryhygiene | 1 | 754 | 1 | 754 | 2 | 830 |
| showradar | 1 | 2,125 | 1 | 2,125 | 2 | 2,338 |
| saveddedupe | 1 | 1,438 | 1 | 1,438 | 2 | 1,582 |
| podcastsession | 2 | 3,427 | 2 | 3,427 | 3 | 3,770 |
| backupfirst | 1 | 513 | 1 | 513 | 2 | 565 |
| backup | 2 | 1,632 | 2 | 1,632 | 3 | 1,796 |
| backupdelete | 1 | 959 | 1 | 959 | 2 | 1,055 |
| restore | 1 | 1,888 | 1 | 1,888 | 2 | 2,077 |
| undo | 2 | 1,663 | 2 | 1,663 | 3 | 1,830 |
| receipts | 1 | 626 | 1 | 626 | 2 | 689 |
| episodemgmt | 1 | 1,053 | 1 | 1,053 | 2 | 1,159 |
| freshness | 1 | 2,235 | 1 | 2,235 | 2 | 2,459 |
| searchdive | 1 | 1,683 | 1 | 1,683 | 2 | 1,852 |
| searchhistory | 2 | 1,096 | 2 | 1,096 | 3 | 1,206 |
| browse | 3 | 2,634 | 3 | 2,634 | 4 | 2,898 |
| artistwatch | 6 | 6,284 | 6 | 6,284 | 7 | 6,913 |
| queueops | 3 | 3,293 | 3 | 3,293 | 4 | 3,623 |
| playbackext | 13 | 8,178 | 13 | 8,178 | 14 | 8,996 |
| playbackintel | 15 | 11,773 | 15 | 11,773 | 16 | 12,951 |
| scenes | 7 | 4,514 | 7 | 4,514 | 8 | 4,966 |
| playlisthealth | 8 | 5,080 | 8 | 5,080 | 9 | 5,588 |
| playlistdna | 1 | 1,310 | 1 | 1,310 | 2 | 1,442 |
| export | 1 | 1,363 | 1 | 1,363 | 2 | 1,500 |
| import | 1 | 1,211 | 1 | 1,211 | 2 | 1,333 |
| smart | 1 | 2,364 | 1 | 2,364 | 2 | 2,601 |
| exhaustmisc | 10 | 8,324 | 10 | 8,324 | 11 | 9,157 |
| exhaust2catalog | 19 | 19,443 | 19 | 19,443 | 20 | 21,388 |
| exhaust2enggating | 0 | 0 | 0 | 0 | 1 | 0 |
| exhaust2playback | 23 | 17,473 | 23 | 17,473 | 24 | 19,221 |
| exhaust2playlists | 18 | 23,326 | 18 | 23,326 | 19 | 25,659 |
| exhaust2misc | 27 | 23,866 | 27 | 23,866 | 28 | 26,253 |
| exhaust2extra | 3 | 4,024 | 3 | 4,024 | 4 | 4,427 |
| swarm3discovery | 24 | 22,286 | 24 | 22,286 | 25 | 24,515 |
| swarm3bdiscovery | 24 | 19,952 | 24 | 19,952 | 25 | 21,948 |
| swarm3shows | 24 | 21,075 | 24 | 21,075 | 25 | 23,183 |
| swarm3refs | 6 | 4,331 | 6 | 4,331 | 7 | 4,765 |
| swarm3analytics | 24 | 18,951 | 24 | 18,951 | 25 | 20,847 |
| swarm3library | 24 | 18,092 | 24 | 18,092 | 25 | 19,902 |
| swarm3playback | 24 | 14,043 | 24 | 14,043 | 25 | 15,448 |
| swarm3playlistops | 24 | 31,587 | 24 | 31,587 | 25 | 34,746 |
| swarm3snapshots | 24 | 23,449 | 24 | 23,449 | 25 | 25,794 |
| swarm4playlists | 18 | 22,016 | 18 | 22,016 | 19 | 24,218 |
<!-- END:generated schema-budget-table -->

To change a baseline, measure the real `tools/list` output, update the shared
manifest, run `npm run count:tools -- --write`, and document the host-session
payload impact in this page or the PR rationale.
