# Tool schema budgets

`src/tools/annotations.ts` owns the shared `REGISTRAR_MANIFEST`. Each entry records
its stable module key, existing toolset registration key, source file, registrar,
measured baseline, and explicit byte/tool-count ceilings. The same manifest drives
startup registration, the CI audit, and the per-module table returned by
`toolset_report`; tests must not maintain a second registrar list.

## Measurement

The deterministic audit registers every active module on a real `McpServer` and
reads the resulting surface over `InMemoryTransport`. For each module it measures:

- tool count;
- UTF-8 bytes of compact JSON containing the tool `description` and emitted
  `inputSchema` JSON Schema (the same schema hosts receive from `tools/list`).

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

The first 65 names are the stable core prefix asserted by
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
| search | 1 | 1,832 | 1 | 1,832 | 2 | 2,016 |
| catalog | 32 | 27,331 | 32 | 27,331 | 33 | 30,065 |
| library | 16 | 14,651 | 16 | 14,651 | 17 | 16,117 |
| playback | 16 | 12,391 | 16 | 12,391 | 17 | 13,631 |
| following | 5 | 3,634 | 5 | 3,634 | 6 | 3,998 |
| users | 2 | 1,561 | 2 | 1,561 | 3 | 1,718 |
| audiobooks | 4 | 3,627 | 4 | 3,627 | 5 | 3,990 |
| audiobookcopilot | 3 | 1,939 | 3 | 1,939 | 4 | 2,133 |
| playlists | 26 | 23,887 | 26 | 23,887 | 27 | 26,276 |
| playlistops | 3 | 4,737 | 3 | 4,737 | 4 | 5,211 |
| playlistbatch | 3 | 4,106 | 3 | 4,106 | 4 | 4,517 |
| playlistmisc | 3 | 2,390 | 3 | 2,390 | 4 | 2,629 |
| personalization | 3 | 2,601 | 3 | 2,601 | 4 | 2,862 |
| analytics | 4 | 2,687 | 4 | 2,687 | 5 | 2,956 |
| statsfm | 30 | 23,411 | 30 | 23,411 | 31 | 25,753 |
| taste | 16 | 14,327 | 16 | 14,327 | 17 | 15,760 |
| tastecomposites | 11 | 9,354 | 11 | 9,354 | 12 | 10,290 |
| doctor | 1 | 773 | 1 | 773 | 2 | 851 |
| swarm3meta | 3 | 1,693 | 3 | 1,693 | 4 | 1,863 |
| libraryanalytics | 4 | 3,224 | 4 | 3,224 | 5 | 3,547 |
| portability | 11 | 9,061 | 11 | 9,061 | 12 | 9,968 |
| libraryinsights | 3 | 2,820 | 3 | 2,820 | 4 | 3,103 |
| libraryhygiene | 1 | 704 | 1 | 704 | 2 | 775 |
| showradar | 1 | 1,552 | 1 | 1,552 | 2 | 1,708 |
| saveddedupe | 1 | 1,585 | 1 | 1,585 | 2 | 1,744 |
| podcastsession | 2 | 2,805 | 2 | 2,805 | 3 | 3,086 |
| backupfirst | 1 | 536 | 1 | 536 | 2 | 590 |
| backup | 2 | 1,489 | 2 | 1,489 | 3 | 1,638 |
| restore | 1 | 1,874 | 1 | 1,874 | 2 | 2,062 |
| undo | 2 | 1,476 | 2 | 1,476 | 3 | 1,624 |
| receipts | 1 | 338 | 1 | 338 | 2 | 372 |
| episodemgmt | 1 | 712 | 1 | 712 | 2 | 784 |
| freshness | 1 | 2,066 | 1 | 2,066 | 2 | 2,273 |
| searchdive | 1 | 1,349 | 1 | 1,349 | 2 | 1,484 |
| searchhistory | 2 | 1,050 | 2 | 1,050 | 3 | 1,155 |
| browse | 3 | 2,734 | 3 | 2,734 | 4 | 3,008 |
| artistwatch | 6 | 5,705 | 6 | 5,705 | 7 | 6,276 |
| queueops | 3 | 3,518 | 3 | 3,518 | 4 | 3,870 |
| playbackext | 13 | 7,494 | 13 | 7,494 | 14 | 8,244 |
| playbackintel | 15 | 11,960 | 15 | 11,960 | 16 | 13,157 |
| scenes | 7 | 4,617 | 7 | 4,617 | 8 | 5,079 |
| playlisthealth | 8 | 5,469 | 8 | 5,469 | 9 | 6,016 |
| playlistdna | 1 | 1,333 | 1 | 1,333 | 2 | 1,467 |
| export | 1 | 1,111 | 1 | 1,111 | 2 | 1,223 |
| import | 1 | 1,158 | 1 | 1,158 | 2 | 1,274 |
| smart | 1 | 2,205 | 1 | 2,205 | 2 | 2,426 |
| exhaustmisc | 10 | 8,143 | 10 | 8,143 | 11 | 8,958 |
| exhaust2catalog | 19 | 18,643 | 19 | 18,643 | 20 | 20,508 |
| exhaust2enggating | 0 | 0 | 0 | 0 | 1 | 0 |
| exhaust2playback | 23 | 17,835 | 23 | 17,835 | 24 | 19,619 |
| exhaust2playlists | 18 | 23,858 | 18 | 23,858 | 19 | 26,244 |
| exhaust2misc | 27 | 23,391 | 27 | 23,391 | 28 | 25,731 |
| exhaust2extra | 3 | 3,764 | 3 | 3,764 | 4 | 4,141 |
| swarm3discovery | 24 | 22,108 | 24 | 22,108 | 25 | 24,319 |
| swarm3bdiscovery | 24 | 19,731 | 24 | 19,731 | 25 | 21,705 |
| swarm3shows | 24 | 20,739 | 24 | 20,739 | 25 | 22,813 |
| swarm3refs | 6 | 4,433 | 6 | 4,433 | 7 | 4,877 |
| swarm3analytics | 24 | 19,000 | 24 | 19,000 | 25 | 20,900 |
| swarm3library | 24 | 18,539 | 24 | 18,539 | 25 | 20,393 |
| swarm3playback | 24 | 14,799 | 24 | 14,799 | 25 | 16,279 |
| swarm3playlistops | 24 | 32,265 | 24 | 32,265 | 25 | 35,492 |
| swarm3snapshots | 24 | 24,296 | 24 | 24,296 | 25 | 26,726 |
| swarm4playlists | 18 | 23,008 | 18 | 23,008 | 19 | 25,309 |
<!-- END:generated schema-budget-table -->

To change a baseline, measure the real `tools/list` output, update the shared
manifest, run `npm run count:tools -- --write`, and document the host-session
payload impact in this page or the PR rationale.
