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
`scope_blocked`, or `read_only_hidden`; inactive rows report zero live tools and
list what host trimming drops.

## Registration order

Registration is core-first and deterministic:

1. `search`
2. `catalog`
3. `library`
4. `playback`
5. `following`, `users`, `audiobooks`, and common playlist workflows
6. discovery, library operations, portability, analytics, and specialised slices
7. swarm/specialised modules

The first 64 names are the stable core prefix asserted by
`tests/tool.surface.test.ts`: all of `search`, then all of `catalog`, then all of
`library`, then all of `playback`. Every manifest module is registered exactly once,
and the audit proves each live tool belongs to exactly one module. The aggregate
ceilings constrain module weight; they do not constitute a complete historical
tool-name inventory.

## Checked-in baseline and ceilings

The generated table below is produced from the shared manifest and the same
per-module registry measurement used by startup and `toolset_report`. The
`surface-census --check` guard rejects a stale row or a baseline that no longer
matches the finalized registry. The source manifest derives current ceilings as
**baseline tools + 1** and **110% of baseline schema bytes**; these effective
ceilings are authoritative and are reported by `toolset_report`. A schema change
above either ceiling fails CI and server startup.

<!-- BEGIN:generated schema-budget-table -->
| Module | Tools | Schema bytes | Baseline tools | Baseline bytes | Effective tool ceiling | Effective byte ceiling |
|---|---:|---:|---:|---:|---:|---:|
| search | 1 | 1,821 | 1 | 1,821 | 2 | 2,004 |
| catalog | 31 | 26,957 | 31 | 26,957 | 32 | 29,653 |
| library | 16 | 14,957 | 16 | 14,957 | 17 | 16,453 |
| playback | 16 | 12,287 | 16 | 12,287 | 17 | 13,516 |
| following | 5 | 3,921 | 5 | 3,921 | 6 | 4,314 |
| users | 2 | 1,613 | 2 | 1,613 | 3 | 1,775 |
| audiobooks | 4 | 3,715 | 4 | 3,715 | 5 | 4,087 |
| audiobookcopilot | 3 | 1,870 | 3 | 1,870 | 4 | 2,057 |
| playlists | 26 | 25,998 | 26 | 25,998 | 27 | 28,598 |
| playlistops | 3 | 5,489 | 3 | 5,489 | 4 | 6,038 |
| playlistbatch | 3 | 4,784 | 3 | 4,784 | 4 | 5,263 |
| playlistmisc | 3 | 2,538 | 3 | 2,538 | 4 | 2,792 |
| personalization | 3 | 2,532 | 3 | 2,532 | 4 | 2,786 |
| analytics | 4 | 2,753 | 4 | 2,753 | 5 | 3,029 |
| statsfm | 30 | 22,721 | 30 | 22,721 | 31 | 24,994 |
| taste | 16 | 13,959 | 16 | 13,959 | 17 | 15,355 |
| tastecomposites | 11 | 9,717 | 11 | 9,717 | 12 | 10,689 |
| doctor | 1 | 750 | 1 | 750 | 2 | 826 |
| swarm3meta | 3 | 1,624 | 3 | 1,624 | 4 | 1,787 |
| libraryanalytics | 4 | 3,350 | 4 | 3,350 | 5 | 3,686 |
| portability | 11 | 10,095 | 11 | 10,095 | 12 | 11,105 |
| libraryinsights | 3 | 2,751 | 3 | 2,751 | 4 | 3,027 |
| libraryhygiene | 1 | 734 | 1 | 734 | 2 | 808 |
| showradar | 1 | 1,675 | 1 | 1,675 | 2 | 1,843 |
| saveddedupe | 1 | 1,562 | 1 | 1,562 | 2 | 1,719 |
| podcastsession | 2 | 2,759 | 2 | 2,759 | 3 | 3,035 |
| backupfirst | 1 | 513 | 1 | 513 | 2 | 565 |
| backup | 3 | 2,584 | 3 | 2,584 | 4 | 2,843 |
| restore | 1 | 1,851 | 1 | 1,851 | 2 | 2,037 |
| undo | 2 | 1,663 | 2 | 1,663 | 3 | 1,830 |
| receipts | 1 | 315 | 1 | 315 | 2 | 347 |
| episodemgmt | 1 | 1,053 | 1 | 1,053 | 2 | 1,159 |
| freshness | 1 | 2,043 | 1 | 2,043 | 2 | 2,248 |
| searchdive | 1 | 1,561 | 1 | 1,561 | 2 | 1,718 |
| searchhistory | 2 | 1,096 | 2 | 1,096 | 3 | 1,206 |
| browse | 3 | 2,634 | 3 | 2,634 | 4 | 2,898 |
| artistwatch | 6 | 5,944 | 6 | 5,944 | 7 | 6,539 |
| queueops | 3 | 3,449 | 3 | 3,449 | 4 | 3,794 |
| playbackext | 13 | 7,857 | 13 | 7,857 | 14 | 8,643 |
| playbackintel | 15 | 11,663 | 15 | 11,663 | 16 | 12,830 |
| scenes | 7 | 4,456 | 7 | 4,456 | 8 | 4,902 |
| playlisthealth | 8 | 5,285 | 8 | 5,285 | 9 | 5,814 |
| playlistdna | 1 | 1,310 | 1 | 1,310 | 2 | 1,442 |
| export | 1 | 1,363 | 1 | 1,363 | 2 | 1,500 |
| import | 1 | 1,211 | 1 | 1,211 | 2 | 1,333 |
| smart | 1 | 2,364 | 1 | 2,364 | 2 | 2,601 |
| exhaustmisc | 10 | 7,924 | 10 | 7,924 | 11 | 8,717 |
| exhaust2catalog | 19 | 19,176 | 19 | 19,176 | 20 | 21,094 |
| exhaust2enggating | 0 | 0 | 0 | 0 | 1 | 0 |
| exhaust2playback | 23 | 17,306 | 23 | 17,306 | 24 | 19,037 |
| exhaust2playlists | 18 | 23,511 | 18 | 23,511 | 19 | 25,863 |
| exhaust2misc | 27 | 23,234 | 27 | 23,234 | 28 | 25,558 |
| exhaust2extra | 3 | 3,695 | 3 | 3,695 | 4 | 4,065 |
| swarm3discovery | 24 | 21,887 | 24 | 21,887 | 25 | 24,076 |
| swarm3bdiscovery | 24 | 20,039 | 24 | 20,039 | 25 | 22,043 |
| swarm3shows | 24 | 21,075 | 24 | 21,075 | 25 | 23,183 |
| swarm3refs | 6 | 4,331 | 6 | 4,331 | 7 | 4,765 |
| swarm3analytics | 24 | 18,880 | 24 | 18,880 | 25 | 20,768 |
| swarm3library | 24 | 17,987 | 24 | 17,987 | 25 | 19,786 |
| swarm3playback | 24 | 14,247 | 24 | 14,247 | 25 | 15,672 |
| swarm3playlistops | 24 | 31,777 | 24 | 31,777 | 25 | 34,955 |
| swarm3snapshots | 24 | 23,744 | 24 | 23,744 | 25 | 26,119 |
| swarm4playlists | 18 | 22,594 | 18 | 22,594 | 19 | 24,854 |
<!-- END:generated schema-budget-table -->

To change a baseline, measure the real `tools/list` output, update the shared
manifest, run `npm run count:tools -- --write`, and document the host-session
payload impact in this page or the PR rationale.
