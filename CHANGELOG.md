# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.1.1](https://github.com/NovaLux12/spotify-mcp-server/compare/v3.1.0...v3.1.1) (2026-10-09)


### Documentation

* the runtime escape hatch and the doctor payload fields ([#1673](https://github.com/NovaLux12/spotify-mcp-server/issues/1673)) ([6b70f55](https://github.com/NovaLux12/spotify-mcp-server/commit/6b70f55b78279e109b7f0088f1b147237fca1e40))


### Miscellaneous Chores

* **repo:** gitignore the local .claude/ agent scaffolding ([#1675](https://github.com/NovaLux12/spotify-mcp-server/issues/1675)) ([dfe456f](https://github.com/NovaLux12/spotify-mcp-server/commit/dfe456f354d7fbf808b9f407a2a714d57734ec62))
* **src:** remove dead imports, types, locals and params ([#1676](https://github.com/NovaLux12/spotify-mcp-server/issues/1676)) ([77084f6](https://github.com/NovaLux12/spotify-mcp-server/commit/77084f6763317183a24cfae7cde04879193290c4))

## [3.1.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v3.0.1...v3.1.0) (2026-10-08)


### Features

* **doctor:** report the surface's payload cost in the unit the gate enforces ([#1628](https://github.com/NovaLux12/spotify-mcp-server/issues/1628)) ([#1670](https://github.com/NovaLux12/spotify-mcp-server/issues/1670)) ([27d52fb](https://github.com/NovaLux12/spotify-mcp-server/commit/27d52fb5386745ba810e13efa790939e92d24871))
* **tools:** call_tool dispatcher and runtime toolset activation ([#1601](https://github.com/NovaLux12/spotify-mcp-server/issues/1601)) ([#1669](https://github.com/NovaLux12/spotify-mcp-server/issues/1669)) ([b84e1aa](https://github.com/NovaLux12/spotify-mcp-server/commit/b84e1aa4c493ecad375c4d2606089d022d97f86b))


### Bug Fixes

* **publish:** wait for the npm release to be visible before publishing to the MCP registry ([#1664](https://github.com/NovaLux12/spotify-mcp-server/issues/1664)) ([19a9443](https://github.com/NovaLux12/spotify-mcp-server/commit/19a9443f70beeb1855c0bfcf72c33036114f0953))
* **tests:** reap every sweep-loop child in a hook, so a leak costs seconds not 8 minutes ([#1569](https://github.com/NovaLux12/spotify-mcp-server/issues/1569)) ([#1672](https://github.com/NovaLux12/spotify-mcp-server/issues/1672)) ([c463e7c](https://github.com/NovaLux12/spotify-mcp-server/commit/c463e7cb11c2fe1c1014f4ded306a495bd46eb3f))


### Tests

* gate the default vocabulary — prose defaults, cap names, name families ([#1621](https://github.com/NovaLux12/spotify-mcp-server/issues/1621), [#1626](https://github.com/NovaLux12/spotify-mcp-server/issues/1626)) ([#1671](https://github.com/NovaLux12/spotify-mcp-server/issues/1671)) ([32cac6e](https://github.com/NovaLux12/spotify-mcp-server/commit/32cac6e923a228ae7a6d8384f37e4b4cc2ed76d1))

## [3.0.1](https://github.com/NovaLux12/spotify-mcp-server/compare/v3.0.0...v3.0.1) (2026-10-01)


### Bug Fixes

* **errors:** a token store that cannot be read is an auth failure, not an internal one ([#1659](https://github.com/NovaLux12/spotify-mcp-server/issues/1659)) ([0de957d](https://github.com/NovaLux12/spotify-mcp-server/commit/0de957d1c2a44bba7225866606802b6861eb98d8))
* **repo:** stop tracking a self-referential `node_modules` symlink ([#1660](https://github.com/NovaLux12/spotify-mcp-server/issues/1660)) ([407f8b8](https://github.com/NovaLux12/spotify-mcp-server/commit/407f8b8e9179ee709001c38afc43ff681865e2e7))
* **tests:** release-history fixture must agree with the branch it runs on ([#1663](https://github.com/NovaLux12/spotify-mcp-server/issues/1663)) ([86899bd](https://github.com/NovaLux12/spotify-mcp-server/commit/86899bda57f2079b0d2c486dd9d4f13b43c467ab))
* **tests:** the release-history guard's own fixture went stale at 3.0.0 ([#1662](https://github.com/NovaLux12/spotify-mcp-server/issues/1662)) ([69caef4](https://github.com/NovaLux12/spotify-mcp-server/commit/69caef4cba583bb26f7c5e49f2bee38c4720b979))


### Miscellaneous Chores

* **release:** re-trigger release-please after clearing the stale autorelease state ([2f416b6](https://github.com/NovaLux12/spotify-mcp-server/commit/2f416b67b05a152340a90ad1802ac0714ad91550))

## [3.0.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v2.1.2...v3.0.0) (2026-09-28)


### ⚠ BREAKING CHANGES

* **playback:** one transfer tool and one volume tool ([#848](https://github.com/NovaLux12/spotify-mcp-server/issues/848)) (#1492)
* **playbackext:** one playback-position record, and a migration that keeps every record ([#1490](https://github.com/NovaLux12/spotify-mcp-server/issues/1490))
* **playback:** collapse the eight queue-read tools into get_queue and peek_next ([#1489](https://github.com/NovaLux12/spotify-mcp-server/issues/1489))
* **shaping:** one shared row cap for json mode and structuredContent ([#895](https://github.com/NovaLux12/spotify-mcp-server/issues/895)) (#1472)
* **registry:** the default registered surface shrinks from the whole registry to the curated `core` set (128 tools, measured). Hosts relying on a tool outside `core` must set `SPOTIFY_MCP_TOOLSETS` explicitly, or `SPOTIFY_MCP_TOOLSETS=all` to restore the previous surface. The eight `taste_*` alias tool names are no longer registered or advertised; they return an error naming their `statsfm_*` replacement unless `SPOTIFY_MCP_LEGACY_ALIASES=1` is set.
* **prompts:** `prompts/get` now refuses an argument the prompt does not declare, where it previously stripped the key and rendered the prompt from defaults. A caller sending an undeclared key to satisfy a tool-shaped habit now gets `-32602` instead of a rendered prompt. Tool behaviour is unchanged and was already strict. Strictness is about argument NAMES only: a declared argument still accepts what it accepted before, and the numeric prompt arguments still coerce from the protocol string, so a host that can only express a scalar is still served.
* **import:** import_profile_state no longer imports stores.mutations_history in either mode. An archive carrying it reports the key as "skipped: export-only store" instead of appending or replacing the local ledger, and an archive whose ledger records are malformed is now rejected rather than accepted. The export side is unchanged.
* **playlists:** playlist_trim asks before it deletes, and a client that cannot prompt is refused rather than served. Unattended automation has to set SPOTIFY_MCP_CONFIRM=never, which remains the only bypass and must be exactly "never". A trim that used to report "nothing to trim" on a playlist larger than the walk cap now asks instead, because that playlist did have rows to lose.
* **gauntlet:** the sweep report's mutation_proof block is replaced. The constant `mutations performed: NONE` and the empty `mutations_performed` array are gone; the block now carries a derived status (PASS/INCOMPLETE/UNVERIFIED/MUTATIONS_DETECTED), the fingerprint diff it was computed from, and the unverified and unaccounted tools behind the verdict. The gauntlet also exits non-zero on UNVERIFIED and MUTATIONS_DETECTED, so a loop that treated a non-zero exit as a hard failure will stop on a partially-covered or unattributable run.
* **registry:** 8 tools are removed from the registry. follow_artists / unfollow_artists have no replacement (Spotify removed the follow write and /mutate /me/library does not accept spotify:artist: URIs). get_categories / get_category_playlists -> browse_category_deepdive. save_items / remove_saved_items / check_saved_items -> save_to_library / remove_from_library / check_in_library. The removed names are pinned absent in tests/tool.surface.test.ts and listed in scripts/check-doc-tool-names.mjs retiredToolNames so a migration note can name what replaces them; the gate itself is not weakened.
* **playlistfollow:** pin_playlist/unpin_playlist follow — they never pinned ([#1280](https://github.com/NovaLux12/spotify-mcp-server/issues/1280))

### Features

* **#633:** add an unforgeable untrusted-text delimiter, and fence dry-run prose ([97123c8](https://github.com/NovaLux12/spotify-mcp-server/commit/97123c8f43864b9122215b65609bc15a0ccfcc32)), closes [#633](https://github.com/NovaLux12/spotify-mcp-server/issues/633)
* **#731:** give search_within_playlist a kind filter and walk coverage ([#1200](https://github.com/NovaLux12/spotify-mcp-server/issues/1200)) ([0752101](https://github.com/NovaLux12/spotify-mcp-server/commit/0752101086d3616d9b4f3b38d023a695ee68f7a7)), closes [#731](https://github.com/NovaLux12/spotify-mcp-server/issues/731)
* **#884:** give get_playlist the playlist read filters and the shared pager ([#1188](https://github.com/NovaLux12/spotify-mcp-server/issues/1188)) ([33a9966](https://github.com/NovaLux12/spotify-mcp-server/commit/33a9966caf8975f562c82a5de81ccfc9c094d232))
* **accounts:** account registry with list_accounts and switch_account ([#1363](https://github.com/NovaLux12/spotify-mcp-server/issues/1363)) ([df58147](https://github.com/NovaLux12/spotify-mcp-server/commit/df58147bab022f2161d0bdc88c419e03034378b2))
* **auth:** default to the core scope profile, opt in to the writes ([#700](https://github.com/NovaLux12/spotify-mcp-server/issues/700)) ([#1415](https://github.com/NovaLux12/spotify-mcp-server/issues/1415)) ([f6c4fb0](https://github.com/NovaLux12/spotify-mcp-server/commit/f6c4fb06e7460ebbc6326e8ddcc27dff65f4bd7b))
* **backups:** clean_backup_artifacts, the sibling delete_backup never had ([#1592](https://github.com/NovaLux12/spotify-mcp-server/issues/1592)) ([#1614](https://github.com/NovaLux12/spotify-mcp-server/issues/1614)) ([003babf](https://github.com/NovaLux12/spotify-mcp-server/commit/003babf38a0588d97a24c160c463b3ad04c17f49))
* **cli:** add spotify-mcp logout to disconnect and erase local stores ([#704](https://github.com/NovaLux12/spotify-mcp-server/issues/704)) ([#1264](https://github.com/NovaLux12/spotify-mcp-server/issues/1264)) ([1413b16](https://github.com/NovaLux12/spotify-mcp-server/commit/1413b167e7cb11cfdeec741f0d4a9d7bba50870d))
* **cli:** tools, call, watch, export and init subcommands ([#606](https://github.com/NovaLux12/spotify-mcp-server/issues/606)) ([#1548](https://github.com/NovaLux12/spotify-mcp-server/issues/1548)) ([76aad00](https://github.com/NovaLux12/spotify-mcp-server/commit/76aad008e240cd657a8b0d40150c0c21793c0395))
* **compliance:** attribute rendered rows and link them back to Spotify ([#696](https://github.com/NovaLux12/spotify-mcp-server/issues/696)) ([#1526](https://github.com/NovaLux12/spotify-mcp-server/issues/1526)) ([707cdb9](https://github.com/NovaLux12/spotify-mcp-server/commit/707cdb9a8b37d8da8a727f7f61cb1a0208358962))
* **history:** cap, expire and purge the mutation ledger ([#703](https://github.com/NovaLux12/spotify-mcp-server/issues/703)) ([#1512](https://github.com/NovaLux12/spotify-mcp-server/issues/1512)) ([12b249a](https://github.com/NovaLux12/spotify-mcp-server/commit/12b249abaae0915e0c8a5f1eba15b68ff01d2553))
* **http:** add an opt-in authenticated Streamable HTTP transport ([#1433](https://github.com/NovaLux12/spotify-mcp-server/issues/1433)) ([bba75c7](https://github.com/NovaLux12/spotify-mcp-server/commit/bba75c753b20e82114a90e15209452935369696e))
* **instructions:** host guidance on the initialize wire ([#690](https://github.com/NovaLux12/spotify-mcp-server/issues/690)) ([#1470](https://github.com/NovaLux12/spotify-mcp-server/issues/1470)) ([77f35a7](https://github.com/NovaLux12/spotify-mcp-server/commit/77f35a7af8113ff3c71f9f8b6beae1b9da537eb9))
* **moodexpand:** sampling-backed expand_mood_to_queries, with a static-map fallback ([#1475](https://github.com/NovaLux12/spotify-mcp-server/issues/1475)) ([d5fca0f](https://github.com/NovaLux12/spotify-mcp-server/commit/d5fca0f6e93388bb98786e8b9438db489530ae35))
* **playback:** collapse the eight queue-read tools into get_queue and peek_next ([#1489](https://github.com/NovaLux12/spotify-mcp-server/issues/1489)) ([6a340a3](https://github.com/NovaLux12/spotify-mcp-server/commit/6a340a35a9aa5e273efd392609ca7aaed429ee32))
* **playbackext:** one playback-position record, and a migration that keeps every record ([#1490](https://github.com/NovaLux12/spotify-mcp-server/issues/1490)) ([479d11f](https://github.com/NovaLux12/spotify-mcp-server/commit/479d11f6f18e2027ac593a24ab2a5f1eb5cdcb55))
* **prose:** add --reanchor so a reword is recorded as a reword, not a deletion ([#1527](https://github.com/NovaLux12/spotify-mcp-server/issues/1527)) ([218e0bd](https://github.com/NovaLux12/spotify-mcp-server/commit/218e0bd0f5c27599d068c1bdb2dfc1f279284405))
* **registry:** curate the default tool surface and drop the legacy taste aliases ([#889](https://github.com/NovaLux12/spotify-mcp-server/issues/889), [#607](https://github.com/NovaLux12/spotify-mcp-server/issues/607), [#908](https://github.com/NovaLux12/spotify-mcp-server/issues/908)) ([#1441](https://github.com/NovaLux12/spotify-mcp-server/issues/1441)) ([373199b](https://github.com/NovaLux12/spotify-mcp-server/commit/373199bc908132b78f0fbc8dac91cae8c6be88d8))
* **registry:** remove the tools whose only endpoint Spotify deleted in Feb 2026 ([#1270](https://github.com/NovaLux12/spotify-mcp-server/issues/1270)) ([31fd64f](https://github.com/NovaLux12/spotify-mcp-server/commit/31fd64f92b8299eef30fdb96b9063e22f9810394))
* **resources:** advertise and implement resource subscriptions ([#597](https://github.com/NovaLux12/spotify-mcp-server/issues/597)) ([#1531](https://github.com/NovaLux12/spotify-mcp-server/issues/1531)) ([3ad7465](https://github.com/NovaLux12/spotify-mcp-server/commit/3ad74650ccfb4da31eda2b276963844253089dc0))
* **resources:** query parameters, audiobook templates and player devices ([#1360](https://github.com/NovaLux12/spotify-mcp-server/issues/1360)) ([005d5ef](https://github.com/NovaLux12/spotify-mcp-server/commit/005d5efefe8129b8e06b0227b82954c11b0463ab))
* **shaping:** one shared response byte cap for json mode and structuredContent ([#1263](https://github.com/NovaLux12/spotify-mcp-server/issues/1263)) ([98c6d84](https://github.com/NovaLux12/spotify-mcp-server/commit/98c6d84c34a5ec9967b42359caf861c92010642d))
* **shaping:** publish outputSchema for prose-safe tools ([#687](https://github.com/NovaLux12/spotify-mcp-server/issues/687)) ([#1494](https://github.com/NovaLux12/spotify-mcp-server/issues/1494)) ([6799a77](https://github.com/NovaLux12/spotify-mcp-server/commit/6799a77a33663b7471810d925cbf1701383010f9))
* **statsfm:** implement STATSFM_USER_ID and correct the stats.fm/taste docs ([#1317](https://github.com/NovaLux12/spotify-mcp-server/issues/1317)) ([91bd211](https://github.com/NovaLux12/spotify-mcp-server/commit/91bd211ee024a658f80461266eddd336de797813))
* **statsfm:** named UTC range buckets on statsfm_recent_streams ([#730](https://github.com/NovaLux12/spotify-mcp-server/issues/730)) ([#1474](https://github.com/NovaLux12/spotify-mcp-server/issues/1474)) ([5509597](https://github.com/NovaLux12/spotify-mcp-server/commit/55095979d352ffeefeb938d2346a7d6bab9efc69))
* **tasks:** return MCP task handles for the operations that take minutes ([#600](https://github.com/NovaLux12/spotify-mcp-server/issues/600)) ([#1530](https://github.com/NovaLux12/spotify-mcp-server/issues/1530)) ([0ba0757](https://github.com/NovaLux12/spotify-mcp-server/commit/0ba075712a32dbd343aedbe55c6fd7e103cbcf6f))
* **tools:** a server-side lane registry for playlist writes, and a stats.fm jukebox ([#727](https://github.com/NovaLux12/spotify-mcp-server/issues/727), [#726](https://github.com/NovaLux12/spotify-mcp-server/issues/726)) ([#1541](https://github.com/NovaLux12/spotify-mcp-server/issues/1541)) ([9ee5a5d](https://github.com/NovaLux12/spotify-mcp-server/commit/9ee5a5d069ee8597541da5a033fd49b4cedf9bb1))


### Bug Fixes

* **#1004:** read artists per id — GET /artists?ids= was removed in Feb 2026 ([#1194](https://github.com/NovaLux12/spotify-mcp-server/issues/1194)) ([82bc880](https://github.com/NovaLux12/spotify-mcp-server/commit/82bc8803e08d032945d60db9bb82e0e1b7631edf)), closes [#1004](https://github.com/NovaLux12/spotify-mcp-server/issues/1004)
* **#1051:** collapse four sidecar loaders onto shared policy module ([870e9e8](https://github.com/NovaLux12/spotify-mcp-server/commit/870e9e8069776c5a7d6f41aba5796ade9455162c))
* **#1051:** fix imports after rebase ([8af71bf](https://github.com/NovaLux12/spotify-mcp-server/commit/8af71bfc7c7f3fddccd09bb8196bcdbc2db3fd8c))
* **#1051:** keep loadGenreTags inline to preserve [#1052](https://github.com/NovaLux12/spotify-mcp-server/issues/1052) cap behavior ([5681b05](https://github.com/NovaLux12/spotify-mcp-server/commit/5681b05fbf1afa160291529e0753426c4636051e))
* **#1051:** re-add readFileSync import for inline [#1052](https://github.com/NovaLux12/spotify-mcp-server/issues/1052) cap logic ([1f36b9c](https://github.com/NovaLux12/spotify-mcp-server/commit/1f36b9cfd5cd17a29408e1f5e40c3bd69cd63a0c))
* **#1052:** bound the .corrupt.N chain and reuse identical copies ([e5caad7](https://github.com/NovaLux12/spotify-mcp-server/commit/e5caad73c38e6854162736b7ea2b23f4a7b33e4d))
* **#1053:** playlist_from_tags honours genre-tag corruption contract ([b440c64](https://github.com/NovaLux12/spotify-mcp-server/commit/b440c64253664e25e8c8614256ead4660c6d2e51))
* **#1070:** device_sync_state reads stores independently, surfaces scenes load_error ([422b7c1](https://github.com/NovaLux12/spotify-mcp-server/commit/422b7c10b2c5dff411ce2c2db215d3e455ab6cfa))
* **#1084:** re-assert 0600 on sidecar writes and tmp-then-rename paths ([d50da31](https://github.com/NovaLux12/spotify-mcp-server/commit/d50da317c15d6d39984ed8c03be9a080159a93b5))
* **#1092:** collapse resolveRuleCandidates onto shared loadCandidates and disclose ceilings ([ecad765](https://github.com/NovaLux12/spotify-mcp-server/commit/ecad765e71b1b18590180729114a9366de53c24a))
* **#1093:** three exhaust2_catalog batch tools disclose unresolved ids ([3a01226](https://github.com/NovaLux12/spotify-mcp-server/commit/3a01226c79f416e79c734f3c06f99cff5e0ded7a))
* **#1095:** receipt routing records per-type writes so undo targets the right endpoint ([d765e79](https://github.com/NovaLux12/spotify-mcp-server/commit/d765e7947aae503938a3c68f6f0542c13428b82d))
* **#1100:** make unpin_playlist refuse in the same shape as pin_playlist ([#1235](https://github.com/NovaLux12/spotify-mcp-server/issues/1235)) ([93a06ba](https://github.com/NovaLux12/spotify-mcp-server/commit/93a06babb60020900fde0a08d6282b5c68376068))
* **#1101:** classify backup_library as read-only via OVERRIDES ([55ea363](https://github.com/NovaLux12/spotify-mcp-server/commit/55ea363c093327a43ff42a02ffc4d7bfd9c567aa))
* **#1126:** retry the registry publish so npm propagation lag is not a red build ([c252534](https://github.com/NovaLux12/spotify-mcp-server/commit/c252534a0fdbe47c82b8e6bd3b39e8845fa96978))
* **#1128:** size a gated module's ceiling for the surface it can reach ([f7b8f93](https://github.com/NovaLux12/spotify-mcp-server/commit/f7b8f938fff656492c410e1f10fa90449b61332e))
* **#1130:** identify and fix the intermittent suite failure ([#1132](https://github.com/NovaLux12/spotify-mcp-server/issues/1132)) ([8d81c05](https://github.com/NovaLux12/spotify-mcp-server/commit/8d81c05ce95f882cf2d957e53db022c37a636a58))
* **#1135:** unique per-writer temp name in artistwatch saveStore ([534d951](https://github.com/NovaLux12/spotify-mcp-server/commit/534d9519f0aab049650d6883e9e16c0af993e505))
* **#1207:** isolate the search-history tests from the developer's real sidecar ([#1221](https://github.com/NovaLux12/spotify-mcp-server/issues/1221)) ([b848aa3](https://github.com/NovaLux12/spotify-mcp-server/commit/b848aa3946d52dd4396d6a845717f078936d2781))
* **#1209:** clamp every /artists/{id}/albums read to the schema maximum ([#1223](https://github.com/NovaLux12/spotify-mcp-server/issues/1223)) ([b65fde4](https://github.com/NovaLux12/spotify-mcp-server/commit/b65fde42822d6a71ba2b23d099823f80f61e4cd0)), closes [#1209](https://github.com/NovaLux12/spotify-mcp-server/issues/1209)
* **#1224:** read albums/tracks per id — six sites hard-failed on removed ?ids= ([#1233](https://github.com/NovaLux12/spotify-mcp-server/issues/1233)) ([123c445](https://github.com/NovaLux12/spotify-mcp-server/commit/123c445c5e772d6211468fd56d4a873e48e147cf))
* **#1225:** let queue_playlist's albums fallback actually run ([#1232](https://github.com/NovaLux12/spotify-mcp-server/issues/1232)) ([1b64561](https://github.com/NovaLux12/spotify-mcp-server/commit/1b645614e94b15f3765e9490d4d02432f2db7e5d)), closes [#1225](https://github.com/NovaLux12/spotify-mcp-server/issues/1225)
* **#1266, #1279:** report a cache save lost to a termination that runs no JS ([#1296](https://github.com/NovaLux12/spotify-mcp-server/issues/1296)) ([546d918](https://github.com/NovaLux12/spotify-mcp-server/commit/546d9182bc01822be30d3c26b8803b7ceb6e61d6)), closes [#1266](https://github.com/NovaLux12/spotify-mcp-server/issues/1266) [#1279](https://github.com/NovaLux12/spotify-mcp-server/issues/1279)
* **#1423:** one name for the bounded-read disclosure, and a gate that holds it ([#1456](https://github.com/NovaLux12/spotify-mcp-server/issues/1456)) ([696b8e3](https://github.com/NovaLux12/spotify-mcp-server/commit/696b8e3598bca7022024d15e0d6984ca1e5b1a2f))
* **#1495:** a scanner that cannot see a thing must not report it as safe ([#1524](https://github.com/NovaLux12/spotify-mcp-server/issues/1524)) ([8dca449](https://github.com/NovaLux12/spotify-mcp-server/commit/8dca449a9d43265c3560ed9f23ec599ff211a8ea))
* **#1600,#1625:** enumerate the stats.fm read set, state its real cost, widen the gate ([#1642](https://github.com/NovaLux12/spotify-mcp-server/issues/1642)) ([c9f1220](https://github.com/NovaLux12/spotify-mcp-server/commit/c9f1220b043af7f6bb40703545fc60788c55b639))
* **#579:** make the READONLY gate fail closed for alwaysActive rows ([#1269](https://github.com/NovaLux12/spotify-mcp-server/issues/1269)) ([0606122](https://github.com/NovaLux12/spotify-mcp-server/commit/060612240796ec353c5a077c4b30a25df82361a7))
* **#617:** reject empty --profile and --scopes instead of falling back to defaults ([#1191](https://github.com/NovaLux12/spotify-mcp-server/issues/1191)) ([d6fa2cd](https://github.com/NovaLux12/spotify-mcp-server/commit/d6fa2cd2aeff61526bd5a06ad263df12c0d78911)), closes [#617](https://github.com/NovaLux12/spotify-mcp-server/issues/617)
* **#669:** derive toolset parity from the registration sources, not a kept key list ([#1205](https://github.com/NovaLux12/spotify-mcp-server/issues/1205)) ([1222e1f](https://github.com/NovaLux12/spotify-mcp-server/commit/1222e1f1d8042a8415a83a35d955debd5f5adde2)), closes [#669](https://github.com/NovaLux12/spotify-mcp-server/issues/669)
* **#670:** derive the prompt tool-name allow-list from the live registry ([#1217](https://github.com/NovaLux12/spotify-mcp-server/issues/1217)) ([b8fa661](https://github.com/NovaLux12/spotify-mcp-server/commit/b8fa6610f5be52d157b9ffadda931652697c28b8)), closes [#670](https://github.com/NovaLux12/spotify-mcp-server/issues/670)
* **#671:** 429 handling runs on every attempt, not just first ([3e57df2](https://github.com/NovaLux12/spotify-mcp-server/commit/3e57df2d72d5823daa72de04292d558808be80ec))
* **#674:** never let an unreadable mutation body fail a write that landed ([#1197](https://github.com/NovaLux12/spotify-mcp-server/issues/1197)) ([7bb4d15](https://github.com/NovaLux12/spotify-mcp-server/commit/7bb4d152519a6631a84644998c838cd65bc5fe07)), closes [#674](https://github.com/NovaLux12/spotify-mcp-server/issues/674)
* **#675:** bounded retry with backoff for 5xx, parse Retry-After HTTP-dates ([#1177](https://github.com/NovaLux12/spotify-mcp-server/issues/1177)) ([fb26b43](https://github.com/NovaLux12/spotify-mcp-server/commit/fb26b4361f8d823ebb4adaed42a88989a9bb7486))
* **#677:** classify token-endpoint failures instead of calling them outages ([#1212](https://github.com/NovaLux12/spotify-mcp-server/issues/1212)) ([cf55e7c](https://github.com/NovaLux12/spotify-mcp-server/commit/cf55e7c4e4082e52391efdbbf750bb5574dfc5c4)), closes [#677](https://github.com/NovaLux12/spotify-mcp-server/issues/677)
* **#688:** report an unknown receipt as a failed lookup, and ungate verify_receipt ([#1176](https://github.com/NovaLux12/spotify-mcp-server/issues/1176)) ([f4d90c0](https://github.com/NovaLux12/spotify-mcp-server/commit/f4d90c0bfe9282e88202c5214f556c40da23de8a)), closes [#688](https://github.com/NovaLux12/spotify-mcp-server/issues/688)
* **#712:** cookbook recipes carry risk lines and route dedupe through the guarded tool ([4f575b4](https://github.com/NovaLux12/spotify-mcp-server/commit/4f575b44cc359fed159e220287e9392dca1b35d0))
* **#713:** honour response_format in find_tool, inspect_tool and toolset_report ([#1181](https://github.com/NovaLux12/spotify-mcp-server/issues/1181)) ([b53eb7b](https://github.com/NovaLux12/spotify-mcp-server/commit/b53eb7b9fdeb71ecfee082f4b0574fd49e502159)), closes [#713](https://github.com/NovaLux12/spotify-mcp-server/issues/713)
* **#716:** prompt steps use real tool names and parameter names ([d6c8cbd](https://github.com/NovaLux12/spotify-mcp-server/commit/d6c8cbd0889de5d8b6a345672aef494e4340a25d))
* **#720:** one stats.fm range enum, shared by all three modules ([#1199](https://github.com/NovaLux12/spotify-mcp-server/issues/1199)) ([8b72d6d](https://github.com/NovaLux12/spotify-mcp-server/commit/8b72d6d752f9559cc36a763ba914384456617695)), closes [#720](https://github.com/NovaLux12/spotify-mcp-server/issues/720)
* **#725:** batch lookups fall back to per-item on 403, mark degraded ([fc1370d](https://github.com/NovaLux12/spotify-mcp-server/commit/fc1370dba2a06fa326f067adc91882902cd0f932))
* **#728:** progress only emitted when caller supplied a token, result last ([f87f78f](https://github.com/NovaLux12/spotify-mcp-server/commit/f87f78f1502acb4edd2d09aa5818d12291c7d9d6))
* **#729:** batch-write receipt reports actual playlist total, not walk-window count ([b0db652](https://github.com/NovaLux12/spotify-mcp-server/commit/b0db652231e1ea1f602ee2de738c1a988fc59886))
* **#732:** saved_vs_playlist_coverage reads item, falls back to track, discloses unreadable ([bdd9c62](https://github.com/NovaLux12/spotify-mcp-server/commit/bdd9c627188bae379e3bdaa6502130d757236c5b))
* **#733:** genre analytics source declared tags, mark unavailable dimensions ([cfccb6a](https://github.com/NovaLux12/spotify-mcp-server/commit/cfccb6a887993bc4eb97a1d4afe989f76c801597))
* **#734:** restore_library_snapshot uses CHUNK_CAPS.library_writes (40) for PUT ([b3cb7a2](https://github.com/NovaLux12/spotify-mcp-server/commit/b3cb7a2676df849314051f25bf3d2a203d800863))
* **#737:** reserve restore playlist names against a complete playlist walk ([#1198](https://github.com/NovaLux12/spotify-mcp-server/issues/1198)) ([6954edf](https://github.com/NovaLux12/spotify-mcp-server/commit/6954edf2fb871ec3d2c1041eceab8225b9419b64))
* **#751:** disclose per-playlist caps and failures in export_all_playlists ([#1182](https://github.com/NovaLux12/spotify-mcp-server/issues/1182)) ([d8f738f](https://github.com/NovaLux12/spotify-mcp-server/commit/d8f738ffb16e58a8d82e85dbdfe7f11cfcb28b54)), closes [#751](https://github.com/NovaLux12/spotify-mcp-server/issues/751)
* **#765:** graceful-403 wrapper preserves SpotifyApiError instance, annotates gated ([b6c25d4](https://github.com/NovaLux12/spotify-mcp-server/commit/b6c25d43dde54daae32597a99c6a7615c9c60282))
* **#781:** print the paging signal the search tools already computed ([#1183](https://github.com/NovaLux12/spotify-mcp-server/issues/1183)) ([626bfe3](https://github.com/NovaLux12/spotify-mcp-server/commit/626bfe35792f77efa5acfe6b5c24d9fb14e639a4)), closes [#781](https://github.com/NovaLux12/spotify-mcp-server/issues/781)
* **#782:** apply the profile-country market default to show and episode walks ([#1193](https://github.com/NovaLux12/spotify-mcp-server/issues/1193)) ([ba0124f](https://github.com/NovaLux12/spotify-mcp-server/commit/ba0124f178a9ef915e43c51d4872d6b7bd42daad)), closes [#782](https://github.com/NovaLux12/spotify-mcp-server/issues/782)
* **#801:** top_genre_census resolves every census artist in chunks ([32dd65b](https://github.com/NovaLux12/spotify-mcp-server/commit/32dd65bc78702a4466cc66c9620270bc4f684e93))
* **#802:** artist_scout_from_playlists scans the configured cap, discloses truncation ([5783393](https://github.com/NovaLux12/spotify-mcp-server/commit/5783393e6e3fcfc2da38c8e8207f92330c2a13fd))
* **#807:** taste_shift_report reports missing data, not Jaccard 1, for empty windows ([#1189](https://github.com/NovaLux12/spotify-mcp-server/issues/1189)) ([a255d96](https://github.com/NovaLux12/spotify-mcp-server/commit/a255d96390eee38be5091eaf3962f06cf5809152)), closes [#807](https://github.com/NovaLux12/spotify-mcp-server/issues/807)
* **#827:** default dry_run to true on discover_weekly_diff's archive replace ([#1180](https://github.com/NovaLux12/spotify-mcp-server/issues/1180)) ([925d68b](https://github.com/NovaLux12/spotify-mcp-server/commit/925d68bc0944b6dbadcdd04f702579858e9a95a6))
* **#833:** resume_playback_position issues /me/player/play, restore uses context_uri ([7a1d39b](https://github.com/NovaLux12/spotify-mcp-server/commit/7a1d39babb633e7aa20244a47f9c72853d4b5182)), closes [#833](https://github.com/NovaLux12/spotify-mcp-server/issues/833)
* **#835:** save_show_digest writes radar episodes to existing playlist ([#1172](https://github.com/NovaLux12/spotify-mcp-server/issues/1172)) ([16cebb0](https://github.com/NovaLux12/spotify-mcp-server/commit/16cebb083598039a95747ba8d41a849f9bc8d228))
* **#836:** publish one dry_run default for the playback mutations ([#1203](https://github.com/NovaLux12/spotify-mcp-server/issues/1203)) ([70d1b45](https://github.com/NovaLux12/spotify-mcp-server/commit/70d1b45d9ec1f927a23429eb7d850a7da6a780e5)), closes [#836](https://github.com/NovaLux12/spotify-mcp-server/issues/836)
* **#839:** stop a corrupt search-history sidecar being silently reset ([#1257](https://github.com/NovaLux12/spotify-mcp-server/issues/1257)) ([2978cec](https://github.com/NovaLux12/spotify-mcp-server/commit/2978cec2266510c9e04b3ed62c5c81da41823340))
* **#840:** write playlist items through /items in queueops and exhaustmisc ([7d69af8](https://github.com/NovaLux12/spotify-mcp-server/commit/7d69af8ed10d307ccb627c6f24709b3185e2e4dc))
* **#845:** context-inspect walk advances by raw page length, reads item field ([b952fd1](https://github.com/NovaLux12/spotify-mcp-server/commit/b952fd195c10ff8d8ba077217195c9a04119b039))
* **#851:** probe markets concurrently and stop reading deprecated available_markets ([#1239](https://github.com/NovaLux12/spotify-mcp-server/issues/1239)) ([145eae3](https://github.com/NovaLux12/spotify-mcp-server/commit/145eae3ff281bb32791b494ee665360a5ce89aec)), closes [#851](https://github.com/NovaLux12/spotify-mcp-server/issues/851)
* **#860:** refuse full-sequence playlist rewrites over unavailable rows ([#1184](https://github.com/NovaLux12/spotify-mcp-server/issues/1184)) ([9e66a07](https://github.com/NovaLux12/spotify-mcp-server/commit/9e66a07b30a138040554b7c65655ba075fb91390)), closes [#860](https://github.com/NovaLux12/spotify-mcp-server/issues/860)
* **#865:** count committed URIs across every chunk, not just the last ([#1204](https://github.com/NovaLux12/spotify-mcp-server/issues/1204)) ([d4fb9ce](https://github.com/NovaLux12/spotify-mcp-server/commit/d4fb9cee92b155a6f889f9db3e8e576e50ca8ccf))
* **#865:** report partial-write state when a chunked playlist write fails mid-batch ([#1175](https://github.com/NovaLux12/spotify-mcp-server/issues/1175)) ([affafc6](https://github.com/NovaLux12/spotify-mcp-server/commit/affafc619d11453a16557f698fd152eaa577ecbf))
* **#866:** remove only the transferred occurrences in mode=move ([#1192](https://github.com/NovaLux12/spotify-mcp-server/issues/1192)) ([cbf90a0](https://github.com/NovaLux12/spotify-mcp-server/commit/cbf90a01615150c1780293c4a91509501623e871)), closes [#866](https://github.com/NovaLux12/spotify-mcp-server/issues/866)
* **#867:** resolveSourceUris reports per-source failures, uses caller market ([f8122fb](https://github.com/NovaLux12/spotify-mcp-server/commit/f8122fb4c30ce68b285d99c7c39c3798659bb31b))
* **#868:** playlist_names_bulk_normalize checks real ownership, resumes on failure ([ba40a87](https://github.com/NovaLux12/spotify-mcp-server/commit/ba40a8775097a0f1c4eafc82187ed02704b397a1))
* **#879:** verify playlist writes with receipts in the swarm3/exhaust2 helpers ([#1196](https://github.com/NovaLux12/spotify-mcp-server/issues/1196)) ([bcea5d3](https://github.com/NovaLux12/spotify-mcp-server/commit/bcea5d36d02b294221c8b42dd87149255c4e8ffa)), closes [#879](https://github.com/NovaLux12/spotify-mcp-server/issues/879)
* **#880:** share one guarded cover-image fetch with timeout across cover tools ([#1171](https://github.com/NovaLux12/spotify-mcp-server/issues/1171)) ([742c698](https://github.com/NovaLux12/spotify-mcp-server/commit/742c698df53b4a060003d42061fd809e7b900633))
* **#887:** name the schema parameter in playlist errors, not a CLI flag ([#1236](https://github.com/NovaLux12/spotify-mcp-server/issues/1236)) ([57c3bc4](https://github.com/NovaLux12/spotify-mcp-server/commit/57c3bc4d6806576264505e51a216544375787085)), closes [#887](https://github.com/NovaLux12/spotify-mcp-server/issues/887)
* **#888:** keep the documented empty-uris clear, and stop reporting it as confirmed when the receipt is unreadable ([#1195](https://github.com/NovaLux12/spotify-mcp-server/issues/1195)) ([a76d777](https://github.com/NovaLux12/spotify-mcp-server/commit/a76d7778190a27d1855fe3cbfc077810b9fc50d5)), closes [#888](https://github.com/NovaLux12/spotify-mcp-server/issues/888)
* **#892:** bounded concurrency and a shared rate-limit gate in the request funnel ([#1206](https://github.com/NovaLux12/spotify-mcp-server/issues/1206)) ([5a59f97](https://github.com/NovaLux12/spotify-mcp-server/commit/5a59f97d976e87db481f2c5887a8420d03566705))
* **#893:** scope cache invalidation, and close the read/write race it was hiding ([#1249](https://github.com/NovaLux12/spotify-mcp-server/issues/1249)) ([1ffdc53](https://github.com/NovaLux12/spotify-mcp-server/commit/1ffdc53c7e584f28c7b56c538134d116faf070ee))
* **#894:** bound the read cache by bytes and pin key identity ([#1190](https://github.com/NovaLux12/spotify-mcp-server/issues/1190)) ([03901b3](https://github.com/NovaLux12/spotify-mcp-server/commit/03901b39fac6e8d74099b6afcb97602b09695d24))
* **#896:** make dry-run previews truthful, short-circuiting, and honest ([#1271](https://github.com/NovaLux12/spotify-mcp-server/issues/1271)) ([a318957](https://github.com/NovaLux12/spotify-mcp-server/commit/a31895783d96ae823ff44be395df06b1b3f94f6d))
* **#898:** cap the exhaust2 playlist walk, project URIs only, disclose the clip ([#1211](https://github.com/NovaLux12/spotify-mcp-server/issues/1211)) ([f4d08d3](https://github.com/NovaLux12/spotify-mcp-server/commit/f4d08d32215442123b1df8f16a400db795be2a49))
* **#899:** bound playlist list arguments and report the read cost they imply ([#1214](https://github.com/NovaLux12/spotify-mcp-server/issues/1214)) ([e4be2d9](https://github.com/NovaLux12/spotify-mcp-server/commit/e4be2d92e25b39cae0a3b1c313ada809f2211b72))
* **#901:** stop the artist-completeness fan-out on the first gated top-tracks answer ([#1185](https://github.com/NovaLux12/spotify-mcp-server/issues/1185)) ([ffc1bb9](https://github.com/NovaLux12/spotify-mcp-server/commit/ffc1bb96898c115978bce0d687af971d8990ea6c)), closes [#901](https://github.com/NovaLux12/spotify-mcp-server/issues/901)
* **#905:** bound the taste feedback store and make history growth observable ([#1254](https://github.com/NovaLux12/spotify-mcp-server/issues/1254)) ([699ccb3](https://github.com/NovaLux12/spotify-mcp-server/commit/699ccb38476327b1541240f27234c7302f3e999a))
* **#907:** one timed-out, retried, cached client for every stats.fm read ([#1240](https://github.com/NovaLux12/spotify-mcp-server/issues/1240)) ([e09eedc](https://github.com/NovaLux12/spotify-mcp-server/commit/e09eedc1cbe44d92b3f1e507a9a0560e047b725f)), closes [#907](https://github.com/NovaLux12/spotify-mcp-server/issues/907)
* **#922:** await the registry pass, which had gone silently vacuous ([d3c129f](https://github.com/NovaLux12/spotify-mcp-server/commit/d3c129f5aee52ef6d2830fedc59e4ed4bd6f613e))
* **#922:** re-measure every manifest baseline on the merged tree ([15c3a1b](https://github.com/NovaLux12/spotify-mcp-server/commit/15c3a1b64bc5b356caca81d41b996a549c066eb8))
* **#922:** re-measure playbackintel on the tree that also carries [#1239](https://github.com/NovaLux12/spotify-mcp-server/issues/1239) ([09ec168](https://github.com/NovaLux12/spotify-mcp-server/commit/09ec168346b121080336c65d498cd127c2a36042))
* **#922:** state quota cost in words, and drop the cross-sell breadcrumbs ([32711d2](https://github.com/NovaLux12/spotify-mcp-server/commit/32711d2c6f80bfcbe81381d981d0d76791e91c91)), closes [#922](https://github.com/NovaLux12/spotify-mcp-server/issues/922)
* **#932:** reconcile SECURITY, changelog, distribution and SPEC release facts ([#1320](https://github.com/NovaLux12/spotify-mcp-server/issues/1320)) ([b6e4742](https://github.com/NovaLux12/spotify-mcp-server/commit/b6e47426d46d6b0f2a926fc827fd77fe564adcf3)), closes [#932](https://github.com/NovaLux12/spotify-mcp-server/issues/932)
* **403:** stop four messages prescribing a grandfathered app ([#1468](https://github.com/NovaLux12/spotify-mcp-server/issues/1468)) ([#1485](https://github.com/NovaLux12/spotify-mcp-server/issues/1485)) ([1db5e4c](https://github.com/NovaLux12/spotify-mcp-server/commit/1db5e4c85c1b70d12c3fcd918cf8522cb3cf38b9))
* **accountkey:** refuse an unnamed account instead of answering with the default one ([#1425](https://github.com/NovaLux12/spotify-mcp-server/issues/1425)) ([fa49aa8](https://github.com/NovaLux12/spotify-mcp-server/commit/fa49aa80efb6893d854aa101e6c3f8ec8b3f302e)), closes [#1385](https://github.com/NovaLux12/spotify-mcp-server/issues/1385)
* **accounts:** the registry has one writer, and it is not `auth` ([#1465](https://github.com/NovaLux12/spotify-mcp-server/issues/1465)) ([#1498](https://github.com/NovaLux12/spotify-mcp-server/issues/1498)) ([57558f7](https://github.com/NovaLux12/spotify-mcp-server/commit/57558f7eb3acd3323e4de9216fb129dc5961751e))
* **analytics:** gate derived listening metrics behind an explicit opt-in ([#1424](https://github.com/NovaLux12/spotify-mcp-server/issues/1424)) ([47f40b4](https://github.com/NovaLux12/spotify-mcp-server/commit/47f40b4875e659b3fe16bab874e4b33c61c777c3)), closes [#695](https://github.com/NovaLux12/spotify-mcp-server/issues/695)
* **analytics:** one UTC frame for weekday_heatmap, and name it ([#1638](https://github.com/NovaLux12/spotify-mcp-server/issues/1638), [#1639](https://github.com/NovaLux12/spotify-mcp-server/issues/1639)) ([#1643](https://github.com/NovaLux12/spotify-mcp-server/issues/1643)) ([d5e37fd](https://github.com/NovaLux12/spotify-mcp-server/commit/d5e37fd6ca44a4a9c8e0b338f99faf8a24d272a9))
* **annotations:** name perToolMaxBytes instead of quoting its value ([#1344](https://github.com/NovaLux12/spotify-mcp-server/issues/1344)) ([f5ab354](https://github.com/NovaLux12/spotify-mcp-server/commit/f5ab35465a51ab7c4dc434503f174aed127fc5df)), closes [#1332](https://github.com/NovaLux12/spotify-mcp-server/issues/1332)
* **annotations:** state the SWEEP-2026-09 mechanism, not two figures that rot ([#1350](https://github.com/NovaLux12/spotify-mcp-server/issues/1350)) ([#1371](https://github.com/NovaLux12/spotify-mcp-server/issues/1371)) ([e3e3510](https://github.com/NovaLux12/spotify-mcp-server/commit/e3e3510c7a93741672d9d35a67ed68ff6188b578))
* **annotations:** stop quoting a live constant through a warrant name ([#1332](https://github.com/NovaLux12/spotify-mcp-server/issues/1332)) ([#1380](https://github.com/NovaLux12/spotify-mcp-server/issues/1380)) ([d291e89](https://github.com/NovaLux12/spotify-mcp-server/commit/d291e894ffd8d0e2a4b0933a84ddcbdaa33493a1))
* **attribution:** cover MCP resource reads with the boundary ([#1525](https://github.com/NovaLux12/spotify-mcp-server/issues/1525)) ([#1534](https://github.com/NovaLux12/spotify-mcp-server/issues/1534)) ([5ff44a9](https://github.com/NovaLux12/spotify-mcp-server/commit/5ff44a9159f51f2ae4c7437e6fe97d1ef61bcfeb))
* **auth:** a token refresh silently drops `scope`, failing scope-aware tool hiding open ([#1563](https://github.com/NovaLux12/spotify-mcp-server/issues/1563)) ([3f9cfa7](https://github.com/NovaLux12/spotify-mcp-server/commit/3f9cfa75bd1053d9a647f68c430e47a01f52ae22)), closes [#1559](https://github.com/NovaLux12/spotify-mcp-server/issues/1559)
* **auth:** bound the browser callback wait and name the port-busy cause ([#614](https://github.com/NovaLux12/spotify-mcp-server/issues/614)) ([#1262](https://github.com/NovaLux12/spotify-mcp-server/issues/1262)) ([8b36685](https://github.com/NovaLux12/spotify-mcp-server/commit/8b3668528988e0cb7b033e3df5abf1a896bdc6eb))
* **auth:** resolve one profile-aware token path for refresh and doctor ([#1326](https://github.com/NovaLux12/spotify-mcp-server/issues/1326)) ([6561b08](https://github.com/NovaLux12/spotify-mcp-server/commit/6561b083dc2f6044e6e7a0d55c0e32fbac94054f))
* **backup:** make the per-playlist item ceiling configurable ([#1603](https://github.com/NovaLux12/spotify-mcp-server/issues/1603)) ([#1631](https://github.com/NovaLux12/spotify-mcp-server/issues/1631)) ([043793a](https://github.com/NovaLux12/spotify-mcp-server/commit/043793a1ed924a3f4e0568b2e522c3e5dfa79e99))
* **budget:** charge outputSchema bytes to the schema budget ([#1393](https://github.com/NovaLux12/spotify-mcp-server/issues/1393)) ([587ae0d](https://github.com/NovaLux12/spotify-mcp-server/commit/587ae0da6f80750ee876475113e5d58a3a1c532b))
* **budget:** grant the remaining v2 backlog sweep 13KB of aggregate headroom ([#1219](https://github.com/NovaLux12/spotify-mcp-server/issues/1219)) ([47ca891](https://github.com/NovaLux12/spotify-mcp-server/commit/47ca89182960dbe0bc8168752682808258b5fa6e)), closes [#1215](https://github.com/NovaLux12/spotify-mcp-server/issues/1215)
* **catalog:** move browse-categories out of the never-call table; stop category_resolver reporting an unreadable page as empty ([#1382](https://github.com/NovaLux12/spotify-mcp-server/issues/1382)) ([e2ca408](https://github.com/NovaLux12/spotify-mcp-server/commit/e2ca408d9f20b3791dd6df32dd66926f08cb0fdd))
* **census:** fail closed when the TOOLSETS parse matches nothing ([#1522](https://github.com/NovaLux12/spotify-mcp-server/issues/1522)) ([f2790fd](https://github.com/NovaLux12/spotify-mcp-server/commit/f2790fdf35210f1ee383250c737944e15c22c101)), closes [#1513](https://github.com/NovaLux12/spotify-mcp-server/issues/1513)
* **census:** install the artifact only when the run succeeded ([#1487](https://github.com/NovaLux12/spotify-mcp-server/issues/1487)) ([#1496](https://github.com/NovaLux12/spotify-mcp-server/issues/1496)) ([528b959](https://github.com/NovaLux12/spotify-mcp-server/commit/528b959f164a8c1e5690e701595746c6bac45f3f))
* **census:** make an unpinned paragraph fail --prose-report, and pin the four that merged unseen ([#1532](https://github.com/NovaLux12/spotify-mcp-server/issues/1532)) ([43b3254](https://github.com/NovaLux12/spotify-mcp-server/commit/43b325472102cdb310553ecf9bb7f75cd919530b))
* **census:** name which way round the prose counts differ, and stop the count being the gate ([#1460](https://github.com/NovaLux12/spotify-mcp-server/issues/1460)) ([#1471](https://github.com/NovaLux12/spotify-mcp-server/issues/1471)) ([ba607d7](https://github.com/NovaLux12/spotify-mcp-server/commit/ba607d70fd7edd1ca7fbde39dafa0db02c7f743c))
* **census:** report the aggregate budget for the opted-in surface, and refuse a second gated flag ([#1493](https://github.com/NovaLux12/spotify-mcp-server/issues/1493)) ([#1515](https://github.com/NovaLux12/spotify-mcp-server/issues/1515)) ([b36cd40](https://github.com/NovaLux12/spotify-mcp-server/commit/b36cd40c93a46b380d9179ef13a7d91711d6d317))
* **census:** sever the prose pin from the architecture gate, and gate the toolsets block ([#1436](https://github.com/NovaLux12/spotify-mcp-server/issues/1436), [#1438](https://github.com/NovaLux12/spotify-mcp-server/issues/1438)) ([#1443](https://github.com/NovaLux12/spotify-mcp-server/issues/1443)) ([f27cfd2](https://github.com/NovaLux12/spotify-mcp-server/commit/f27cfd25725a235fcfb1f7ff4b0505272bedc69b))
* **ci:** make the sweep lock reclaimable, and stop a signal waiting out the pause ([#1322](https://github.com/NovaLux12/spotify-mcp-server/issues/1322)) ([144721a](https://github.com/NovaLux12/spotify-mcp-server/commit/144721ae9e8830d1fb5c79dc7632f33260478efa)), closes [#656](https://github.com/NovaLux12/spotify-mcp-server/issues/656)
* **ci:** make the test-tree typecheck budget two-way, not a one-sided ceiling ([#1478](https://github.com/NovaLux12/spotify-mcp-server/issues/1478)) ([#1511](https://github.com/NovaLux12/spotify-mcp-server/issues/1511)) ([5e8bc35](https://github.com/NovaLux12/spotify-mcp-server/commit/5e8bc35124b7f8d8a6a68d64f668d203da8335b1))
* **ci:** name what a live harness is missing, instead of timing out ([#644](https://github.com/NovaLux12/spotify-mcp-server/issues/644)) ([#1519](https://github.com/NovaLux12/spotify-mcp-server/issues/1519)) ([48aa3e2](https://github.com/NovaLux12/spotify-mcp-server/commit/48aa3e239b71c9ca2c64e6511bf1ad7be076d66b))
* **ci:** run the release-history gate even when an earlier step failed ([#1462](https://github.com/NovaLux12/spotify-mcp-server/issues/1462)) ([35634d8](https://github.com/NovaLux12/spotify-mcp-server/commit/35634d8282cbe69c4c68037e34157910aca45c42))
* **ci:** run the surface census and its gate when an earlier step failed ([#1486](https://github.com/NovaLux12/spotify-mcp-server/issues/1486)) ([fd5e091](https://github.com/NovaLux12/spotify-mcp-server/commit/fd5e09163a10ee4abd99eef2a66d836e6666546a))
* **ci:** validate server.json against the registry schema it declares ([#655](https://github.com/NovaLux12/spotify-mcp-server/issues/655)) ([#1357](https://github.com/NovaLux12/spotify-mcp-server/issues/1357)) ([4446661](https://github.com/NovaLux12/spotify-mcp-server/commit/4446661a47f4b9fb58d98ae2ab885524fb1333bf))
* **client:** thread cancellation through the walk loop and handlers ([#1351](https://github.com/NovaLux12/spotify-mcp-server/issues/1351)) ([6a30741](https://github.com/NovaLux12/spotify-mcp-server/commit/6a3074104f9f921901635f9d355dd19408e715ed))
* **compliance:** drop the third-party marks and the stats.fm User-Agent token ([#698](https://github.com/NovaLux12/spotify-mcp-server/issues/698)) ([#1276](https://github.com/NovaLux12/spotify-mcp-server/issues/1276)) ([765bf3d](https://github.com/NovaLux12/spotify-mcp-server/commit/765bf3d318a25cf21a400282da55fa09c19e528f))
* **compliance:** record the v2 name decision and put the non-affiliation notice on every entry point ([#1370](https://github.com/NovaLux12/spotify-mcp-server/issues/1370)) ([5c76f16](https://github.com/NovaLux12/spotify-mcp-server/commit/5c76f16fe59e3602027f5548dfdbd857782750bb))
* **config:** one source for the scope vocabulary, READONLY and the env docs ([#1230](https://github.com/NovaLux12/spotify-mcp-server/issues/1230)) ([0b2a4a6](https://github.com/NovaLux12/spotify-mcp-server/commit/0b2a4a6c45fb99f8b5af4b11166574e688071cf6))
* **config:** single-source every local store path in config.ts ([#1410](https://github.com/NovaLux12/spotify-mcp-server/issues/1410)) ([5f9f611](https://github.com/NovaLux12/spotify-mcp-server/commit/5f9f611f90c3aa2093b053d9684573c29342de2b)), closes [#711](https://github.com/NovaLux12/spotify-mcp-server/issues/711)
* **confirm:** route the last six hand-rolled refusal shapes through the shared guard ([#1277](https://github.com/NovaLux12/spotify-mcp-server/issues/1277)) ([9bc7926](https://github.com/NovaLux12/spotify-mcp-server/commit/9bc792689d42f2177f5bda68b878f9afd104443d))
* **distribution:** bound the DERIVED_SURFACES exemption instead of naming it ([#1437](https://github.com/NovaLux12/spotify-mcp-server/issues/1437)) ([#1452](https://github.com/NovaLux12/spotify-mcp-server/issues/1452)) ([69ae86d](https://github.com/NovaLux12/spotify-mcp-server/commit/69ae86dc9f7eb16392a15f72967bf611cff6eaa3))
* **docs:** align documented ranges, defaults and enum members with the live schemas ([#1330](https://github.com/NovaLux12/spotify-mcp-server/issues/1330)) ([f2faecb](https://github.com/NovaLux12/spotify-mcp-server/commit/f2faecb1042e1a35ef993b595acdaaeb6b81c679)), closes [#929](https://github.com/NovaLux12/spotify-mcp-server/issues/929)
* **docs:** correct the fanout default and the logout store claim ([#892](https://github.com/NovaLux12/spotify-mcp-server/issues/892) landed) ([#1406](https://github.com/NovaLux12/spotify-mcp-server/issues/1406)) ([e10f93a](https://github.com/NovaLux12/spotify-mcp-server/commit/e10f93a28bf47eb98ca08144e18adbd411fbbfe0))
* **docs:** derive AGENTS.md's generated-block list from the census inventory ([#1234](https://github.com/NovaLux12/spotify-mcp-server/issues/1234)) ([50be699](https://github.com/NovaLux12/spotify-mcp-server/commit/50be699b47504d6332ea4de80031f6ddc33b5780)), closes [#1231](https://github.com/NovaLux12/spotify-mcp-server/issues/1231)
* **docs:** derive the planted line, and scan every comment shape ([#1327](https://github.com/NovaLux12/spotify-mcp-server/issues/1327)) ([d2b6bb8](https://github.com/NovaLux12/spotify-mcp-server/commit/d2b6bb810667c6b9cede063d26351596d2a62e4f))
* **docs:** gate orphaned generated blocks, and stop cutting endpoint claims at a `?` ([#1284](https://github.com/NovaLux12/spotify-mcp-server/issues/1284)) ([89fbe2b](https://github.com/NovaLux12/spotify-mcp-server/commit/89fbe2bdb62ae12455c100cff9ae011a7d4981b7)), closes [#1238](https://github.com/NovaLux12/spotify-mcp-server/issues/1238) [#1258](https://github.com/NovaLux12/spotify-mcp-server/issues/1258)
* **docs:** gate registry tool counts, and drop the three present-tense ones ([#1314](https://github.com/NovaLux12/spotify-mcp-server/issues/1314)) ([2d3d7ca](https://github.com/NovaLux12/spotify-mcp-server/commit/2d3d7ca4286216f7241d4fc15337b55026f049ae))
* **docs:** gate the hand-written prose a mixed document cannot lose ([#1431](https://github.com/NovaLux12/spotify-mcp-server/issues/1431)) ([fb32493](https://github.com/NovaLux12/spotify-mcp-server/commit/fb324933d507d872402281d54e3998c90257d20b)), closes [#1384](https://github.com/NovaLux12/spotify-mcp-server/issues/1384)
* **docs:** gate the links the 403 message sends a reader to ([#931](https://github.com/NovaLux12/spotify-mcp-server/issues/931)) ([#1312](https://github.com/NovaLux12/spotify-mcp-server/issues/1312)) ([791eb33](https://github.com/NovaLux12/spotify-mcp-server/commit/791eb33074baa08c36197f951196a3371bf8964d))
* **docs:** generate the aggregate surface figures instead of hand-typing them ([#1261](https://github.com/NovaLux12/spotify-mcp-server/issues/1261)) ([7a4da1d](https://github.com/NovaLux12/spotify-mcp-server/commit/7a4da1d28d9425d3b193f79ab76d91d9b86c1436))
* **docs:** generate the cookbook recipe count instead of hand-typing it ([#1288](https://github.com/NovaLux12/spotify-mcp-server/issues/1288)) ([#1321](https://github.com/NovaLux12/spotify-mcp-server/issues/1321)) ([1e596e8](https://github.com/NovaLux12/spotify-mcp-server/commit/1e596e851ecae068f6cf3437cb681fde7717b9f2))
* **docs:** generate the two hand-typed env name lists instead of typing them ([#1521](https://github.com/NovaLux12/spotify-mcp-server/issues/1521)) ([b1a30af](https://github.com/NovaLux12/spotify-mcp-server/commit/b1a30af2dc643b88e7430af1c9285e7040881f7f))
* **docs:** make the recipe gate check argument values, not just names ([#928](https://github.com/NovaLux12/spotify-mcp-server/issues/928)) ([#1374](https://github.com/NovaLux12/spotify-mcp-server/issues/1374)) ([9cf7044](https://github.com/NovaLux12/spotify-mcp-server/commit/9cf70449eea2c6a5e3eff84b9eeaa1121b1336fd))
* **docs:** make three documented constants agree with the code, and gate the class ([#1476](https://github.com/NovaLux12/spotify-mcp-server/issues/1476)) ([#1497](https://github.com/NovaLux12/spotify-mcp-server/issues/1497)) ([ff07fdf](https://github.com/NovaLux12/spotify-mcp-server/commit/ff07fdf7255e515c105d2d23a084e3f829535ede))
* **docs:** re-stamp prose provenance after [#1456](https://github.com/NovaLux12/spotify-mcp-server/issues/1456) landed ([#1483](https://github.com/NovaLux12/spotify-mcp-server/issues/1483)) ([25ef2c2](https://github.com/NovaLux12/spotify-mcp-server/commit/25ef2c287a83b050e0bb345678b43bea84d7273f))
* **docs:** re-stamp prose provenance at main's tip ([#1464](https://github.com/NovaLux12/spotify-mcp-server/issues/1464)) ([#1479](https://github.com/NovaLux12/spotify-mcp-server/issues/1479)) ([bbeb51e](https://github.com/NovaLux12/spotify-mcp-server/commit/bbeb51e2ec4dcad9b80c5ec529459ece13a788bd))
* **docs:** re-stamp prose provenance at main's tip after [#1474](https://github.com/NovaLux12/spotify-mcp-server/issues/1474) ([#1484](https://github.com/NovaLux12/spotify-mcp-server/issues/1484)) ([70ba245](https://github.com/NovaLux12/spotify-mcp-server/commit/70ba245bbe0a35562e6372be82be83e49543abb0))
* **docs:** replace three procedures and a header that no longer match the code ([#1445](https://github.com/NovaLux12/spotify-mcp-server/issues/1445)) ([c743f74](https://github.com/NovaLux12/spotify-mcp-server/commit/c743f746c8d9e44c5a31ae55b1ab3c7cac5e6718)), closes [#1435](https://github.com/NovaLux12/spotify-mcp-server/issues/1435) [#1414](https://github.com/NovaLux12/spotify-mcp-server/issues/1414) [#1416](https://github.com/NovaLux12/spotify-mcp-server/issues/1416)
* **docs:** repoint the Releasing link at the renamed heading ([#1598](https://github.com/NovaLux12/spotify-mcp-server/issues/1598)) ([5dfe1bb](https://github.com/NovaLux12/spotify-mcp-server/commit/5dfe1bb3eafd93c3b885cf994d7fa4d4eb6f99de))
* **docs:** stop gating the module map on a per-file line count ([#1453](https://github.com/NovaLux12/spotify-mcp-server/issues/1453)) ([fba8797](https://github.com/NovaLux12/spotify-mcp-server/commit/fba8797acef127bdcd9071f0187cab487a909275))
* **docs:** unwrap angle-bracket link destinations in the doc-link guard ([#1323](https://github.com/NovaLux12/spotify-mcp-server/issues/1323)) ([87614c2](https://github.com/NovaLux12/spotify-mcp-server/commit/87614c2cd24e2ae55c44cdeff69fde30d322610e))
* **doctor:** one report behind the CLI subcommand and the tool ([#1253](https://github.com/NovaLux12/spotify-mcp-server/issues/1253)) ([7e1fbd1](https://github.com/NovaLux12/spotify-mcp-server/commit/7e1fbd1fc726f232f5a20442cd859ff54acc73b0)), closes [#581](https://github.com/NovaLux12/spotify-mcp-server/issues/581)
* **doctor:** read the effective scope surface, and cover ugc-image-upload ([#681](https://github.com/NovaLux12/spotify-mcp-server/issues/681)) ([#1387](https://github.com/NovaLux12/spotify-mcp-server/issues/1387)) ([890fc73](https://github.com/NovaLux12/spotify-mcp-server/commit/890fc73e20debc0622379f0e8b4fff72a5e4fd9f))
* **encoding:** one encoding contract for host-native arguments ([#694](https://github.com/NovaLux12/spotify-mcp-server/issues/694)) ([#1520](https://github.com/NovaLux12/spotify-mcp-server/issues/1520)) ([d1130e7](https://github.com/NovaLux12/spotify-mcp-server/commit/d1130e7d0517f7a78a1e0a0e6166808209b40510))
* **errors:** relay a registered zod custom issue's message to the caller ([#1518](https://github.com/NovaLux12/spotify-mcp-server/issues/1518)) ([b6d1203](https://github.com/NovaLux12/spotify-mcp-server/commit/b6d1203b338fcb6f28e08b2b897efa8e45b1d0e5))
* **exhaust2_misc:** dead_library_finder withholds the deleted-track record instead of truncating it ([#1517](https://github.com/NovaLux12/spotify-mcp-server/issues/1517)) ([#1546](https://github.com/NovaLux12/spotify-mcp-server/issues/1546)) ([f56b950](https://github.com/NovaLux12/spotify-mcp-server/commit/f56b950a510ec5900c575788fa4a81db93ad6089))
* **exhaust2_misc:** gate dead_library_finder library removal behind elicitation ([#1544](https://github.com/NovaLux12/spotify-mcp-server/issues/1544)) ([#1551](https://github.com/NovaLux12/spotify-mcp-server/issues/1551)) ([44d395d](https://github.com/NovaLux12/spotify-mcp-server/commit/44d395ddeaab2395d4dd5ae0621bee59774a17a7))
* **export:** an export into a pre-existing file was never actually made 0600 ([#1560](https://github.com/NovaLux12/spotify-mcp-server/issues/1560)) ([#1564](https://github.com/NovaLux12/spotify-mcp-server/issues/1564)) ([ee7799e](https://github.com/NovaLux12/spotify-mcp-server/commit/ee7799e2907f0f38a577a10c7ebb01d187c3687e))
* **export:** stop reporting a capped walk's length as the playlist's total ([#1533](https://github.com/NovaLux12/spotify-mcp-server/issues/1533)) ([#1554](https://github.com/NovaLux12/spotify-mcp-server/issues/1554)) ([6f38339](https://github.com/NovaLux12/spotify-mcp-server/commit/6f3833984a9c58a1377c700293b02a2636ee7033))
* **gate:** widen the error-parameter scan past src/tools, and fix what it found ([#1523](https://github.com/NovaLux12/spotify-mcp-server/issues/1523)) ([52ea1f6](https://github.com/NovaLux12/spotify-mcp-server/commit/52ea1f60c9d85bf1bd569558f9a203df31bccfd5))
* **gating:** attribute the gated-endpoint scan per tool, not per file ([#1301](https://github.com/NovaLux12/spotify-mcp-server/issues/1301)) ([4b8c025](https://github.com/NovaLux12/spotify-mcp-server/commit/4b8c02539c94db5acaa7eb536c0479498b3565dd))
* **gauntlet:** call the two tools [#1336](https://github.com/NovaLux12/spotify-mcp-server/issues/1336) gated off, and name the rest ([#1376](https://github.com/NovaLux12/spotify-mcp-server/issues/1376)) ([7eccf78](https://github.com/NovaLux12/spotify-mcp-server/commit/7eccf7876fb8dd2d5fcc4dea0c6b396665df1fa7))
* **harness:** run the live harness scripts in a throwaway HOME ([#1397](https://github.com/NovaLux12/spotify-mcp-server/issues/1397)) ([#1454](https://github.com/NovaLux12/spotify-mcp-server/issues/1454)) ([d05c615](https://github.com/NovaLux12/spotify-mcp-server/commit/d05c6155dec88b5d53ae0b82db0063f1411c6f6b))
* **import:** count the duplicates a document actually holds ([#632](https://github.com/NovaLux12/spotify-mcp-server/issues/632)) ([#1174](https://github.com/NovaLux12/spotify-mcp-server/issues/1174)) ([ed0b6e3](https://github.com/NovaLux12/spotify-mcp-server/commit/ed0b6e3debcc776aa5f5deb95be69882021e7d06))
* **import:** stop import_profile_state writing the mutation ledger ([#1337](https://github.com/NovaLux12/spotify-mcp-server/issues/1337)) ([9025d58](https://github.com/NovaLux12/spotify-mcp-server/commit/9025d58cc86e0b980241c8f5316fb2e00a8e1526)), closes [#629](https://github.com/NovaLux12/spotify-mcp-server/issues/629)
* **library-hygiene:** share the album metadata the walk already carried ([#897](https://github.com/NovaLux12/spotify-mcp-server/issues/897)) ([#1507](https://github.com/NovaLux12/spotify-mcp-server/issues/1507)) ([49524a6](https://github.com/NovaLux12/spotify-mcp-server/commit/49524a695b56288f55cd548c2ae2cc49daff3708))
* **library:** an omitted dry_run committed the save, as it did the removal ([#1587](https://github.com/NovaLux12/spotify-mcp-server/issues/1587)) ([504a963](https://github.com/NovaLux12/spotify-mcp-server/commit/504a96371fa82e71567fa49c983d67a1cce5fce6))
* **libraryanalytics:** read playlist items via /items, never the deprecated /tracks path ([#1179](https://github.com/NovaLux12/spotify-mcp-server/issues/1179)) ([b3254de](https://github.com/NovaLux12/spotify-mcp-server/commit/b3254dec8dd2a27dc095d866060b945f8b648a89)), closes [#1173](https://github.com/NovaLux12/spotify-mcp-server/issues/1173)
* **logout:** erase every profile's pending marker, not only the active one ([#1368](https://github.com/NovaLux12/spotify-mcp-server/issues/1368)) ([7219f8d](https://github.com/NovaLux12/spotify-mcp-server/commit/7219f8dc528d04e08015547035b8f1cb0058a294)), closes [#1356](https://github.com/NovaLux12/spotify-mcp-server/issues/1356)
* **logout:** erase the account registry and taste feedback ([#1426](https://github.com/NovaLux12/spotify-mcp-server/issues/1426), [#1434](https://github.com/NovaLux12/spotify-mcp-server/issues/1434)) ([#1448](https://github.com/NovaLux12/spotify-mcp-server/issues/1448)) ([6c3cdd7](https://github.com/NovaLux12/spotify-mcp-server/commit/6c3cdd721b7825186e51d6726ff38799755dd8a4))
* **logout:** erase the persisted read cache for every profile ([#1307](https://github.com/NovaLux12/spotify-mcp-server/issues/1307)) ([9d63ccf](https://github.com/NovaLux12/spotify-mcp-server/commit/9d63ccf391cf6dc2542d5035b543bfc65e5e719d))
* **logout:** refuse a store whose kind is not the one declared ([#1309](https://github.com/NovaLux12/spotify-mcp-server/issues/1309)) ([#1354](https://github.com/NovaLux12/spotify-mcp-server/issues/1354)) ([81f6177](https://github.com/NovaLux12/spotify-mcp-server/commit/81f61774ef414e70d2ca552c7a085921bc884f2f))
* **logout:** resolve one home for the stores and the erasure guard ([#1372](https://github.com/NovaLux12/spotify-mcp-server/issues/1372)) ([c7fc1c9](https://github.com/NovaLux12/spotify-mcp-server/commit/c7fc1c9e71322103e0277cb07ac5535af2d7889a))
* **logout:** shred every profile's token file, not just the resolved one ([#1591](https://github.com/NovaLux12/spotify-mcp-server/issues/1591)) ([2c4a507](https://github.com/NovaLux12/spotify-mcp-server/commit/2c4a507e018f5cd9fba53710dddfeb41850f402c))
* **manifest:** correct a stale baseline comment and guard the class ([#1227](https://github.com/NovaLux12/spotify-mcp-server/issues/1227)) ([b3c94a7](https://github.com/NovaLux12/spotify-mcp-server/commit/b3c94a74ed22ea54693e7def8c4eef77b6651e23))
* **paths:** fold the `~`-expansion summary into the [#711](https://github.com/NovaLux12/spotify-mcp-server/issues/711) docstring ([#1429](https://github.com/NovaLux12/spotify-mcp-server/issues/1429)) ([bbd4107](https://github.com/NovaLux12/spotify-mcp-server/commit/bbd41070a59d63abc71fe3801f5b01ca1350f34b))
* **payload:** read playlist rows and saved-library values through the boundary helpers ([#1501](https://github.com/NovaLux12/spotify-mcp-server/issues/1501)) ([f99d819](https://github.com/NovaLux12/spotify-mcp-server/commit/f99d81957bc822a7e1156f6d4e85ae87139bb461)), closes [#1202](https://github.com/NovaLux12/spotify-mcp-server/issues/1202)
* **playlistfollow:** pin_playlist/unpin_playlist follow — they never pinned ([#1280](https://github.com/NovaLux12/spotify-mcp-server/issues/1280)) ([d59eca6](https://github.com/NovaLux12/spotify-mcp-server/commit/d59eca6a01cf14861331bb50377acdeee4e81537)), closes [#1099](https://github.com/NovaLux12/spotify-mcp-server/issues/1099)
* **playlists:** a capped walk's row count is not a playlist's size ([#1555](https://github.com/NovaLux12/spotify-mcp-server/issues/1555)) ([#1585](https://github.com/NovaLux12/spotify-mcp-server/issues/1585)) ([3a6d29c](https://github.com/NovaLux12/spotify-mcp-server/commit/3a6d29c792d7a3c495f71bf22cf00eef039c01fe))
* **playlists:** a count Spotify never stated rendered as 0 tracks ([#1556](https://github.com/NovaLux12/spotify-mcp-server/issues/1556)) ([#1583](https://github.com/NovaLux12/spotify-mcp-server/issues/1583)) ([4305a06](https://github.com/NovaLux12/spotify-mcp-server/commit/4305a067f67cefdfd4025e99aef9c8ede5fb0ec8))
* **playlists:** disclose playlist_balance's read coverage instead of implying the playlist's ([#1420](https://github.com/NovaLux12/spotify-mcp-server/issues/1420)) ([85c62e4](https://github.com/NovaLux12/spotify-mcp-server/commit/85c62e402bcef485f6cf0f9a8c2cebea86c1bfc9))
* **playlists:** gate the four ungated bulk removals at the family's own threshold ([#1568](https://github.com/NovaLux12/spotify-mcp-server/issues/1568)) ([#1575](https://github.com/NovaLux12/spotify-mcp-server/issues/1575)) ([4895340](https://github.com/NovaLux12/spotify-mcp-server/commit/4895340dcad9c59697b3c3f30b7e1c23aa3087a3))
* **playlists:** gate the trim overwrite, and stop the false "nothing to trim" ([#1331](https://github.com/NovaLux12/spotify-mcp-server/issues/1331)) ([3fd6110](https://github.com/NovaLux12/spotify-mcp-server/commit/3fd6110bedc821f8eae449af0382713ec5b1e995)), closes [#872](https://github.com/NovaLux12/spotify-mcp-server/issues/872)
* **playlists:** one sentence per position base, stated on every playlist position ([#883](https://github.com/NovaLux12/spotify-mcp-server/issues/883)) ([#1367](https://github.com/NovaLux12/spotify-mcp-server/issues/1367)) ([5ad8a12](https://github.com/NovaLux12/spotify-mcp-server/commit/5ad8a1227378aa83dc4021a84d52fe8fe18748be))
* **playlists:** refuse a swarm4 rewrite built on a truncated read (Refs [#1362](https://github.com/NovaLux12/spotify-mcp-server/issues/1362)) ([#1381](https://github.com/NovaLux12/spotify-mcp-server/issues/1381)) ([e76e6a7](https://github.com/NovaLux12/spotify-mcp-server/commit/e76e6a7b43c2d52b4b8d20f4f4ed7e2d94c23baf))
* **playlists:** refuse a truncated rewrite instead of deleting the unread tail ([#1345](https://github.com/NovaLux12/spotify-mcp-server/issues/1345)) ([cb0e4f0](https://github.com/NovaLux12/spotify-mcp-server/commit/cb0e4f06b7dd03b861f5b6440442f1f7edae26e8)), closes [#1310](https://github.com/NovaLux12/spotify-mcp-server/issues/1310) [#1311](https://github.com/NovaLux12/spotify-mcp-server/issues/1311)
* **playlists:** remove the legacy playlist input aliases in 3.0 ([#1305](https://github.com/NovaLux12/spotify-mcp-server/issues/1305)) ([d648979](https://github.com/NovaLux12/spotify-mcp-server/commit/d648979f0ada93506f34147be313349ae0325d92))
* **privacy:** document the account registry in the local-stores table ([#1450](https://github.com/NovaLux12/spotify-mcp-server/issues/1450)) ([#1463](https://github.com/NovaLux12/spotify-mcp-server/issues/1463)) ([4a4eb23](https://github.com/NovaLux12/spotify-mcp-server/commit/4a4eb23f44a629d61d2d085cd50f22691a65fd52))
* **prompts:** degrade resource hints when the resources module is trimmed ([#715](https://github.com/NovaLux12/spotify-mcp-server/issues/715)) ([#1407](https://github.com/NovaLux12/spotify-mcp-server/issues/1407)) ([e814593](https://github.com/NovaLux12/spotify-mcp-server/commit/e8145932e3e30f6449b8888435aa162012e2a24f))
* **prompts:** reject undeclared prompt arguments and name what was expected ([#689](https://github.com/NovaLux12/spotify-mcp-server/issues/689)) ([#1369](https://github.com/NovaLux12/spotify-mcp-server/issues/1369)) ([2745412](https://github.com/NovaLux12/spotify-mcp-server/commit/2745412296307f9e885d64bb0c0c89d278b273dc))
* **prose:** accept a &lt;file&gt;:<hash> --to on --prose-sync --reanchor ([#1552](https://github.com/NovaLux12/spotify-mcp-server/issues/1552)) ([#1557](https://github.com/NovaLux12/spotify-mcp-server/issues/1557)) ([376deec](https://github.com/NovaLux12/spotify-mcp-server/commit/376deec52e7720d7d9ee81e704e833c3f972bf16))
* **prose:** let a retirement reason be corrected, not only contradicted ([#1502](https://github.com/NovaLux12/spotify-mcp-server/issues/1502)) ([#1506](https://github.com/NovaLux12/spotify-mcp-server/issues/1506)) ([122cc1a](https://github.com/NovaLux12/spotify-mcp-server/commit/122cc1a8793f136b2be6da469d42c85ff195dcab))
* **prose:** re-sync the prose manifest against main, which was red ([#1439](https://github.com/NovaLux12/spotify-mcp-server/issues/1439)) ([a37a182](https://github.com/NovaLux12/spotify-mcp-server/commit/a37a182b0dbf1cf770ec53b5fc4ecb6822a23948))
* **prose:** stamp the commit the tree was built on, not the branch tip ([#1482](https://github.com/NovaLux12/spotify-mcp-server/issues/1482)) ([#1504](https://github.com/NovaLux12/spotify-mcp-server/issues/1504)) ([8ac07a8](https://github.com/NovaLux12/spotify-mcp-server/commit/8ac07a825ac01b9395c8a27f69c91b5f58fd6eb3))
* **provenance:** record purpose and consent when stored data drives a write ([#1432](https://github.com/NovaLux12/spotify-mcp-server/issues/1432)) ([6208496](https://github.com/NovaLux12/spotify-mcp-server/commit/6208496821fb0b839c6d912ffe3a8bb9b3bf8c6d)), closes [#708](https://github.com/NovaLux12/spotify-mcp-server/issues/708)
* **ratchet:** one accessor for the SDK's private registry, not five inline casts ([#1505](https://github.com/NovaLux12/spotify-mcp-server/issues/1505)) ([35f46f1](https://github.com/NovaLux12/spotify-mcp-server/commit/35f46f14668cf962651e0d0eacc54d03b4e1120e))
* **reads:** bound and validate every local file read ([#1285](https://github.com/NovaLux12/spotify-mcp-server/issues/1285)) ([1c58ed7](https://github.com/NovaLux12/spotify-mcp-server/commit/1c58ed7dd2e19ca203463051751c03d4ad3f3b30))
* **receipts:** an unread verification read is not an empty one ([#1252](https://github.com/NovaLux12/spotify-mcp-server/issues/1252)) ([#1265](https://github.com/NovaLux12/spotify-mcp-server/issues/1265)) ([08de14b](https://github.com/NovaLux12/spotify-mcp-server/commit/08de14b98c01c3de6f1a4bbe3a315418198e3458))
* **receipts:** key the receipt store and mutation ledger by account ([#1377](https://github.com/NovaLux12/spotify-mcp-server/issues/1377)) ([d53a7b3](https://github.com/NovaLux12/spotify-mcp-server/commit/d53a7b3c7fc1f0b7a6b1ed49d6efea548c6db70e))
* **receipts:** require a real baseline before reporting VERIFIED ([#1251](https://github.com/NovaLux12/spotify-mcp-server/issues/1251)) ([463b19d](https://github.com/NovaLux12/spotify-mcp-server/commit/463b19d97a5a4307dd7404fea1a8a3ff8262793a)), closes [#626](https://github.com/NovaLux12/spotify-mcp-server/issues/626)
* **refs:** close the kind vocabulary and hoist the searchable-kind list ([#1324](https://github.com/NovaLux12/spotify-mcp-server/issues/1324)) ([6131f18](https://github.com/NovaLux12/spotify-mcp-server/commit/6131f18163be010bfdb1f966c4d6db49f2c95d6c)), closes [#584](https://github.com/NovaLux12/spotify-mcp-server/issues/584)
* **refs:** one matching vocabulary, one resolver, one validity oracle ([#1428](https://github.com/NovaLux12/spotify-mcp-server/issues/1428)) ([e06ef70](https://github.com/NovaLux12/spotify-mcp-server/commit/e06ef70a2bebedc981b03b9c5b0cc2e95eef100c))
* **refs:** route every entity-id parameter through the shared resolver ([#914](https://github.com/NovaLux12/spotify-mcp-server/issues/914)) ([#1510](https://github.com/NovaLux12/spotify-mcp-server/issues/1510)) ([ec1d561](https://github.com/NovaLux12/spotify-mcp-server/commit/ec1d561a8cdc4751e2f2963c22e43a895fee1005))
* **refs:** stop echoing an unbounded caller string into a rejection ([#1536](https://github.com/NovaLux12/spotify-mcp-server/issues/1536)) ([#1547](https://github.com/NovaLux12/spotify-mcp-server/issues/1547)) ([2641259](https://github.com/NovaLux12/spotify-mcp-server/commit/2641259d1a899e6d6dc5fa5b3bc6e69334e046cf))
* **registry-schema:** a 200 carrying no schema is an outage, not a fetched schema ([#1499](https://github.com/NovaLux12/spotify-mcp-server/issues/1499)) ([a966b03](https://github.com/NovaLux12/spotify-mcp-server/commit/a966b03751888f1e4852849d99c99ed37447830e)), closes [#1491](https://github.com/NovaLux12/spotify-mcp-server/issues/1491)
* **registry:** let an explicit disable outrank the alwaysActive exemption, and document the keys it accepts ([#1537](https://github.com/NovaLux12/spotify-mcp-server/issues/1537)) ([f465876](https://github.com/NovaLux12/spotify-mcp-server/commit/f465876ab46dc73059e05256855b61f308d81932))
* **registry:** pin [#1584](https://github.com/NovaLux12/spotify-mcp-server/issues/1584)'s module-count additions and stop the warrant quoting a stale baseline ([dfbf385](https://github.com/NovaLux12/spotify-mcp-server/commit/dfbf38588b1293723139aafc1b22bae22123d1e7))
* **removed-fields:** stop reading the response fields Spotify removed in February 2026 ([#639](https://github.com/NovaLux12/spotify-mcp-server/issues/639)) ([#1303](https://github.com/NovaLux12/spotify-mcp-server/issues/1303)) ([473026e](https://github.com/NovaLux12/spotify-mcp-server/commit/473026e604317ea59e831cc63faf6088d722f923))
* **resources:** match advertised URI templates the way RFC 6570 expands them ([#1444](https://github.com/NovaLux12/spotify-mcp-server/issues/1444)) ([3e2472a](https://github.com/NovaLux12/spotify-mcp-server/commit/3e2472a1789be45474c8387393efe1604ee9090d))
* **resources:** one resource template per URI shape, and no shadowing twins ([#685](https://github.com/NovaLux12/spotify-mcp-server/issues/685)) ([#1488](https://github.com/NovaLux12/spotify-mcp-server/issues/1488)) ([079ba9e](https://github.com/NovaLux12/spotify-mcp-server/commit/079ba9eb52fc29a1a5eda211e68aeb7f95acc1b9))
* **resources:** report the genre heatmap's real source and coverage ([#604](https://github.com/NovaLux12/spotify-mcp-server/issues/604)) ([#1389](https://github.com/NovaLux12/spotify-mcp-server/issues/1389)) ([7ac9a7d](https://github.com/NovaLux12/spotify-mcp-server/commit/7ac9a7d7f5640cd1387889f76ebe48c1f2037de3))
* **resources:** stop a head expression at the query it was swallowing ([#1558](https://github.com/NovaLux12/spotify-mcp-server/issues/1558)) ([#1574](https://github.com/NovaLux12/spotify-mcp-server/issues/1574)) ([4b7a375](https://github.com/NovaLux12/spotify-mcp-server/commit/4b7a375120c7b53cc4ad82cacd606115b7e0060a))
* **scopefilter:** drop the dead write-module set and the gate it misdescribed ([#1572](https://github.com/NovaLux12/spotify-mcp-server/issues/1572)) ([#1586](https://github.com/NovaLux12/spotify-mcp-server/issues/1586)) ([2a58bce](https://github.com/NovaLux12/spotify-mcp-server/commit/2a58bce637452eade6a87682d93ad841f4311453))
* **scripts:** declare the prose-manifest exports [#1451](https://github.com/NovaLux12/spotify-mcp-server/issues/1451) added, and gate the declaration against drift ([#1467](https://github.com/NovaLux12/spotify-mcp-server/issues/1467)) ([c3a2de1](https://github.com/NovaLux12/spotify-mcp-server/commit/c3a2de1d8161fc8fefd67c60fdb5b2faa9677527))
* **scripts:** make the live gate harnesses actually gate, and cover the gated contract without a token ([#645](https://github.com/NovaLux12/spotify-mcp-server/issues/645)) ([#1553](https://github.com/NovaLux12/spotify-mcp-server/issues/1553)) ([52a80c5](https://github.com/NovaLux12/spotify-mcp-server/commit/52a80c5a9503d455be938da4c20a65eda679c25e))
* **scripts:** redact identity, isolate report paths, and honour Retry-After ([#1353](https://github.com/NovaLux12/spotify-mcp-server/issues/1353)) ([560d54a](https://github.com/NovaLux12/spotify-mcp-server/commit/560d54a6ee0d6fbbc8dec25fb972a031e43f7859))
* **scripts:** write the edge probe's token store atomically ([#1459](https://github.com/NovaLux12/spotify-mcp-server/issues/1459)) ([#1469](https://github.com/NovaLux12/spotify-mcp-server/issues/1469)) ([801895a](https://github.com/NovaLux12/spotify-mcp-server/commit/801895a4547bf8564dcf4e6960c5b587be60562e))
* **security:** delimit third-party names in swarm4 commit-path prose ([#1457](https://github.com/NovaLux12/spotify-mcp-server/issues/1457)) ([a26f6eb](https://github.com/NovaLux12/spotify-mcp-server/commit/a26f6eb95e61213da782b4710e3ac2abd8e0293b)), closes [#1422](https://github.com/NovaLux12/spotify-mcp-server/issues/1422)
* **shaping:** one shared row cap for json mode and structuredContent ([#895](https://github.com/NovaLux12/spotify-mcp-server/issues/895)) ([#1472](https://github.com/NovaLux12/spotify-mcp-server/issues/1472)) ([2bae937](https://github.com/NovaLux12/spotify-mcp-server/commit/2bae9375a058da20fa561fb7fe1658bb6152328d))
* **shaping:** stop quoting two live budget constants in a comment ([#1341](https://github.com/NovaLux12/spotify-mcp-server/issues/1341)) ([7cb8fdd](https://github.com/NovaLux12/spotify-mcp-server/commit/7cb8fdd9f9dcadaa63afc5cc230c4e796ce60525))
* **shaping:** stop reusing max_results as a walk cap, and withdraw it properly ([#886](https://github.com/NovaLux12/spotify-mcp-server/issues/886)) ([#1509](https://github.com/NovaLux12/spotify-mcp-server/issues/1509)) ([1aca628](https://github.com/NovaLux12/spotify-mcp-server/commit/1aca62842515368713cd4aaf983f88404c751a9e))
* **shaping:** type the structuredContent boundary instead of casting it ([#1412](https://github.com/NovaLux12/spotify-mcp-server/issues/1412)) ([4531bc3](https://github.com/NovaLux12/spotify-mcp-server/commit/4531bc3dd01da82b8170e8d0cd940eff4c5b0d8a))
* **shows:** read the show from the shelf, not from a field no episode payload carries ([#1508](https://github.com/NovaLux12/spotify-mcp-server/issues/1508)) ([#1516](https://github.com/NovaLux12/spotify-mcp-server/issues/1516)) ([21724f1](https://github.com/NovaLux12/spotify-mcp-server/commit/21724f118ae14c4a0edcc9b68a4ae523d1113578))
* **skill:** gate the sweep skill’s outbound writes behind explicit approval ([#1375](https://github.com/NovaLux12/spotify-mcp-server/issues/1375)) ([2eabdea](https://github.com/NovaLux12/spotify-mcp-server/commit/2eabdea950addca80cc648ff564817d42d925aa0))
* **statsfm:** name what the read actually selected, in both disclosure branches ([0c93346](https://github.com/NovaLux12/spotify-mcp-server/commit/0c93346b9b420c0ef7aa313e07a7e84fd0cca1ab))
* **statsfm:** one identity argument, `user_id` a deprecated alias ([#1318](https://github.com/NovaLux12/spotify-mcp-server/issues/1318)) ([#1449](https://github.com/NovaLux12/spotify-mcp-server/issues/1449)) ([a2979da](https://github.com/NovaLux12/spotify-mcp-server/commit/a2979da577627936091ae0964128ea5b87138a9d))
* **statsfm:** read the per-entity total that already exists ([#1006](https://github.com/NovaLux12/spotify-mcp-server/issues/1006)) ([#1295](https://github.com/NovaLux12/spotify-mcp-server/issues/1295)) ([dc8a71a](https://github.com/NovaLux12/spotify-mcp-server/commit/dc8a71ab62f62e5b4fb7afc01a19b61055a85023))
* **statsfm:** restore the lifetime clause, drop guessed parameter names ([4dc98e0](https://github.com/NovaLux12/spotify-mcp-server/commit/4dc98e0898a7f064ff135446aede66539d957b64))
* **statsfm:** stop reporting one stream page as a lifetime total ([#997](https://github.com/NovaLux12/spotify-mcp-server/issues/997)) ([15a15e4](https://github.com/NovaLux12/spotify-mcp-server/commit/15a15e43507daff3d4f5daaec1a30fd0c789b316)), closes [#810](https://github.com/NovaLux12/spotify-mcp-server/issues/810)
* **statsfm:** stop shipping a real account handle as the identity example ([#1514](https://github.com/NovaLux12/spotify-mcp-server/issues/1514)) ([#1528](https://github.com/NovaLux12/spotify-mcp-server/issues/1528)) ([fb4dc5e](https://github.com/NovaLux12/spotify-mcp-server/commit/fb4dc5ed3bb394d7ee2431ceaab2d3f16db8f398))
* **statsfm:** window the scoped top routes, which ignore limit/offset ([#1297](https://github.com/NovaLux12/spotify-mcp-server/issues/1297)) ([#1328](https://github.com/NovaLux12/spotify-mcp-server/issues/1328)) ([d8cca8e](https://github.com/NovaLux12/spotify-mcp-server/commit/d8cca8e1029651ff2bb3b90d5a845f9e68b1579b))
* **swarm3_playlistops:** read the playlist total, never the capped row count ([#1529](https://github.com/NovaLux12/spotify-mcp-server/issues/1529)) ([96fee30](https://github.com/NovaLux12/spotify-mcp-server/commit/96fee30a366425f90ee025d4fc5678b309f50c37))
* **sweep-loop:** stop the loop reading a detected mutation as a clean batch ([#1394](https://github.com/NovaLux12/spotify-mcp-server/issues/1394)) ([10701d1](https://github.com/NovaLux12/spotify-mcp-server/commit/10701d1066f019355112a5ad4c2630d0552bfd63)), closes [#1346](https://github.com/NovaLux12/spotify-mcp-server/issues/1346)
* **taste,gating:** remove an unsourced rate and an unfollowable citation ([#1259](https://github.com/NovaLux12/spotify-mcp-server/issues/1259), [#1260](https://github.com/NovaLux12/spotify-mcp-server/issues/1260)) ([#1272](https://github.com/NovaLux12/spotify-mcp-server/issues/1272)) ([94ba3d5](https://github.com/NovaLux12/spotify-mcp-server/commit/94ba3d5a248c00e2dd3acde8df9a8c329f6538fa))
* **tests:** give the smoke file a bound nothing can clear ([#1365](https://github.com/NovaLux12/spotify-mcp-server/issues/1365)) ([#1400](https://github.com/NovaLux12/spotify-mcp-server/issues/1400)) ([5711087](https://github.com/NovaLux12/spotify-mcp-server/commit/5711087d14573a9869cf6d51794e1cf56438c3a2))
* **tests:** name the signal when a spawned child dies ([#1404](https://github.com/NovaLux12/spotify-mcp-server/issues/1404), [#1405](https://github.com/NovaLux12/spotify-mcp-server/issues/1405)) ([#1442](https://github.com/NovaLux12/spotify-mcp-server/issues/1442)) ([3487e27](https://github.com/NovaLux12/spotify-mcp-server/commit/3487e27a817e0f68001f4fdb61eabd8adaaff461))
* **tests:** repair the type errors three test files arrived with ([#1461](https://github.com/NovaLux12/spotify-mcp-server/issues/1461)) ([959c49c](https://github.com/NovaLux12/spotify-mcp-server/commit/959c49cac96a5c38617fe6c43c0e9f6cb43fa34b))
* **tests:** separate a dead subprocess from a product defect ([#1335](https://github.com/NovaLux12/spotify-mcp-server/issues/1335)) ([#1361](https://github.com/NovaLux12/spotify-mcp-server/issues/1361)) ([38b116c](https://github.com/NovaLux12/spotify-mcp-server/commit/38b116c66d83b21bf4550ac11d66d5082fd69bbc))
* **tests:** settle the global handle count instead of sleeping past it ([#1418](https://github.com/NovaLux12/spotify-mcp-server/issues/1418)) ([e4ed7e3](https://github.com/NovaLux12/spotify-mcp-server/commit/e4ed7e3a4387089cd70070f7d0d60df2c52acaa4)), closes [#1413](https://github.com/NovaLux12/spotify-mcp-server/issues/1413)
* **tests:** stop npm test writing into the real $HOME/.spotify-mcp ([#1289](https://github.com/NovaLux12/spotify-mcp-server/issues/1289)) ([8adb02f](https://github.com/NovaLux12/spotify-mcp-server/commit/8adb02f3b34adaa7acc1cd0e4c85759c8d5b1dd2))
* **tests:** the task-surface test builds the manifest context [#1537](https://github.com/NovaLux12/spotify-mcp-server/issues/1537) widened ([#1543](https://github.com/NovaLux12/spotify-mcp-server/issues/1543)) ([d4dbb0c](https://github.com/NovaLux12/spotify-mcp-server/commit/d4dbb0cd2b9546a6cd9f1f4a6a9037e3d8e98a1f))
* **tests:** typecheck tests/ under a ratcheting budget, and fix the defects it found ([#1447](https://github.com/NovaLux12/spotify-mcp-server/issues/1447)) ([f108f83](https://github.com/NovaLux12/spotify-mcp-server/commit/f108f835ba9a647aabfab84e4ed0346fc426e619))
* **tests:** typecheck the test tree to zero errors and record that as the budget ([#585](https://github.com/NovaLux12/spotify-mcp-server/issues/585), [#1408](https://github.com/NovaLux12/spotify-mcp-server/issues/1408)) ([#1535](https://github.com/NovaLux12/spotify-mcp-server/issues/1535)) ([bd7d83b](https://github.com/NovaLux12/spotify-mcp-server/commit/bd7d83b646a6a37987505459cad15bb45a430be6))
* **whatsnew:** track the freshness watermark per kind, and stop advancing it on an explicit since ([#1298](https://github.com/NovaLux12/spotify-mcp-server/issues/1298)) ([44de010](https://github.com/NovaLux12/spotify-mcp-server/commit/44de010a7fdb6b5629dd8ff83985bfbbcffb6a42))


### Performance Improvements

* **#783:** bound the freshness-radar fan-out concurrency ([#1220](https://github.com/NovaLux12/spotify-mcp-server/issues/1220)) ([56610f5](https://github.com/NovaLux12/spotify-mcp-server/commit/56610f54198b5199e207712933248f947452eec6)), closes [#783](https://github.com/NovaLux12/spotify-mcp-server/issues/783)
* **#900:** route artist release probes through one cacheable canonical helper ([#1208](https://github.com/NovaLux12/spotify-mcp-server/issues/1208)) ([c793fa8](https://github.com/NovaLux12/spotify-mcp-server/commit/c793fa803c3a69543b25a9c48bbe970523aaa31d))
* **#902:** project and stream merge_playlists source reads ([#1213](https://github.com/NovaLux12/spotify-mcp-server/issues/1213)) ([4f71a50](https://github.com/NovaLux12/spotify-mcp-server/commit/4f71a50c8e41f4443d598add34777ce4f9a36ac9)), closes [#902](https://github.com/NovaLux12/spotify-mcp-server/issues/902)
* **#903:** replace linear scans in playlist and taste hot loops with maps ([#1187](https://github.com/NovaLux12/spotify-mcp-server/issues/1187)) ([451c777](https://github.com/NovaLux12/spotify-mcp-server/commit/451c7773ff83f6a53c7c74898bdeed9fe873311b)), closes [#903](https://github.com/NovaLux12/spotify-mcp-server/issues/903)
* **#906:** load tool modules lazily behind the toolset gate ([#1222](https://github.com/NovaLux12/spotify-mcp-server/issues/1222)) ([6f830da](https://github.com/NovaLux12/spotify-mcp-server/commit/6f830dab92523c0f7ae01d7b57724a99094f2d7b)), closes [#906](https://github.com/NovaLux12/spotify-mcp-server/issues/906)


### Documentation

* **#1051:** refresh module-map ([bdd3046](https://github.com/NovaLux12/spotify-mcp-server/commit/bdd30464482c3420d5cbf2557e6117e7d8c1ddd9))
* **#1052:** refresh module-map after rebasing onto current main ([7be0d5b](https://github.com/NovaLux12/spotify-mcp-server/commit/7be0d5b3ae278e49d5e7895b390c21c58b5e67d4))
* **#1084:** refresh module-map after rebase ([a3ad6b6](https://github.com/NovaLux12/spotify-mcp-server/commit/a3ad6b675cacda6f0ec3e9309063980c2879f148))
* **#1127:** say which Registry endpoint is authoritative, and why ([#1134](https://github.com/NovaLux12/spotify-mcp-server/issues/1134)) ([e0cf35c](https://github.com/NovaLux12/spotify-mcp-server/commit/e0cf35c89685e1d0095c7f3e7e049f5363fd8735))
* **#1571:** the dry_run convention is per tool, not per family ([#1589](https://github.com/NovaLux12/spotify-mcp-server/issues/1589)) ([9929884](https://github.com/NovaLux12/spotify-mcp-server/commit/9929884410431df5e114daec1fb8c34cf8e1d23b))
* **#1576:** a duplicate publish run skips npm — the registry job is the unguarded half ([#1593](https://github.com/NovaLux12/spotify-mcp-server/issues/1593)) ([595ab86](https://github.com/NovaLux12/spotify-mcp-server/commit/595ab86694431ce5093e9ac6bf00247de91445c1))
* **#605:** make the README gated-endpoint claims match the shipped surface ([#1226](https://github.com/NovaLux12/spotify-mcp-server/issues/1226)) ([5ae2d2e](https://github.com/NovaLux12/spotify-mcp-server/commit/5ae2d2e8716c8baacc3dbc9699b0787e201e606f)), closes [#605](https://github.com/NovaLux12/spotify-mcp-server/issues/605)
* **#716:** refresh ARCHITECTURE.md generated block ([acc6594](https://github.com/NovaLux12/spotify-mcp-server/commit/acc65947c2fcde12763f4c123db1b8ee19c5fc36))
* **#733:** refresh module-map ([4bfb002](https://github.com/NovaLux12/spotify-mcp-server/commit/4bfb0025698463bee6645793a7b35e3a74c8b437))
* **#765:** refresh module-map ([a7eb395](https://github.com/NovaLux12/spotify-mcp-server/commit/a7eb395e2155bebf067e2771b8d65d8000c3aa2c))
* **#833:** refresh module-map ([4055736](https://github.com/NovaLux12/spotify-mcp-server/commit/4055736123a21422fa674d5063a11e6a42685eb6))
* a 3.0 migration guide generated from the retirement tables ([#1630](https://github.com/NovaLux12/spotify-mcp-server/issues/1630), [#1612](https://github.com/NovaLux12/spotify-mcp-server/issues/1612)) ([#1634](https://github.com/NovaLux12/spotify-mcp-server/issues/1634)) ([a829c79](https://github.com/NovaLux12/spotify-mcp-server/commit/a829c792c04e00658bade795759769c79f4b848e))
* **agents:** distinguish removed-for-all from registration-dependent endpoints ([#1242](https://github.com/NovaLux12/spotify-mcp-server/issues/1242)) ([ba970a3](https://github.com/NovaLux12/spotify-mcp-server/commit/ba970a38221bdde4115a697fb29b7af419fdf9f5)), closes [#1228](https://github.com/NovaLux12/spotify-mcp-server/issues/1228)
* **agents:** move the /users family out of the never-call table ([#1338](https://github.com/NovaLux12/spotify-mcp-server/issues/1338)) ([#1355](https://github.com/NovaLux12/spotify-mcp-server/issues/1355)) ([0815076](https://github.com/NovaLux12/spotify-mcp-server/commit/0815076c6a3580c2bb9531fa5668c59ebb0cce1e))
* **agents:** the endpoint table conflated two removal states, and the gate order named the wrong file ([#1609](https://github.com/NovaLux12/spotify-mcp-server/issues/1609)) ([9ded7ce](https://github.com/NovaLux12/spotify-mcp-server/commit/9ded7ce111cdf0e9d9b8c4704a89798b041f0713))
* **budget:** stop claiming the aggregate gate bounds the whole payload ([#1396](https://github.com/NovaLux12/spotify-mcp-server/issues/1396)) ([#1403](https://github.com/NovaLux12/spotify-mcp-server/issues/1403)) ([0d2fcbe](https://github.com/NovaLux12/spotify-mcp-server/commit/0d2fcbe6370224e7faab2f70d37f3076551455c0))
* **concurrency:** [#892](https://github.com/NovaLux12/spotify-mcp-server/issues/892) landed; stop describing the request funnel as pending ([#1565](https://github.com/NovaLux12/spotify-mcp-server/issues/1565)) ([424c45a](https://github.com/NovaLux12/spotify-mcp-server/commit/424c45a6e5d953ed65b327aecc29b36d10b78a72))
* **configuration:** four claims the code stopped matching ([#1599](https://github.com/NovaLux12/spotify-mcp-server/issues/1599)) ([819a16d](https://github.com/NovaLux12/spotify-mcp-server/commit/819a16d0d90178621055e129ffeaf9263d75b375))
* **contributing:** document every CI gate and fix the release file list ([#1596](https://github.com/NovaLux12/spotify-mcp-server/issues/1596)) ([f6adc7a](https://github.com/NovaLux12/spotify-mcp-server/commit/f6adc7ae38e5038b9be362bc2412f44334da4497))
* **contributing:** make the release dispatch block match the tag-push trigger ([#1597](https://github.com/NovaLux12/spotify-mcp-server/issues/1597)) ([2184b1a](https://github.com/NovaLux12/spotify-mcp-server/commit/2184b1a67ec8a3a416ab3cf417686cfec0e596c1)), closes [#1577](https://github.com/NovaLux12/spotify-mcp-server/issues/1577)
* **cookbook:** name every playlist_meta issuer and the real orphan predicate ([#1590](https://github.com/NovaLux12/spotify-mcp-server/issues/1590)) ([a77bc28](https://github.com/NovaLux12/spotify-mcp-server/commit/a77bc28cd67d10d398ae2fdc72d37d256b1c96b9))
* correct five claims the code stopped matching ([#1570](https://github.com/NovaLux12/spotify-mcp-server/issues/1570)) ([16f8338](https://github.com/NovaLux12/spotify-mcp-server/commit/16f8338efc7da45a532b562942872e0830f8d99e))
* correct four prose claims the gates do not re-derive ([#1607](https://github.com/NovaLux12/spotify-mcp-server/issues/1607)) ([781184b](https://github.com/NovaLux12/spotify-mcp-server/commit/781184b1a5206ab353afb6f38d82ca25402d3e32))
* correct two README claims the tree contradicts ([#1402](https://github.com/NovaLux12/spotify-mcp-server/issues/1402)) ([a95aa3e](https://github.com/NovaLux12/spotify-mcp-server/commit/a95aa3e727d32e7e9957e89732ed26858834ab88))
* **distribution:** retract the manual publish dispatch and give the rerun recovery ([#1250](https://github.com/NovaLux12/spotify-mcp-server/issues/1250)) ([06bd681](https://github.com/NovaLux12/spotify-mcp-server/commit/06bd681db051a3589c00113b81828f356859a4a1)), closes [#1246](https://github.com/NovaLux12/spotify-mcp-server/issues/1246)
* five claims where the documented mechanism does not do what is said ([#1409](https://github.com/NovaLux12/spotify-mcp-server/issues/1409)) ([e7767a3](https://github.com/NovaLux12/spotify-mcp-server/commit/e7767a3301e14d39845d3c2f91fab21856779e97))
* **gated:** drop the last grandfathered-registration claim and gate all prose ([#1399](https://github.com/NovaLux12/spotify-mcp-server/issues/1399)) ([#1466](https://github.com/NovaLux12/spotify-mcp-server/issues/1466)) ([4b2779a](https://github.com/NovaLux12/spotify-mcp-server/commit/4b2779a288038fcc1e28af69d0f0325f36d96bf9))
* **gated:** stop asserting the unverified grandfathered-200 premise ([#1338](https://github.com/NovaLux12/spotify-mcp-server/issues/1338)) ([#1390](https://github.com/NovaLux12/spotify-mcp-server/issues/1390)) ([e6b9b10](https://github.com/NovaLux12/spotify-mcp-server/commit/e6b9b10dc9fb30ec39406a79f79c3f613dfe4726))
* make closing the issue a step, not a side effect of merging ([#1392](https://github.com/NovaLux12/spotify-mcp-server/issues/1392)) ([d4e1f74](https://github.com/NovaLux12/spotify-mcp-server/commit/d4e1f74189393e081e4ceb827924402f1dd4b9d3))
* name the check that catches a stale generated block ([#1275](https://github.com/NovaLux12/spotify-mcp-server/issues/1275)) ([8aa75d7](https://github.com/NovaLux12/spotify-mcp-server/commit/8aa75d73bb86992fd2a9596b92d8efa38654dc77))
* **privacy:** name the store families the retention sweep does not cover ([#1595](https://github.com/NovaLux12/spotify-mcp-server/issues/1595)) ([cb97b68](https://github.com/NovaLux12/spotify-mcp-server/commit/cb97b68fea17578ec002865758708260550623e7)), closes [#1579](https://github.com/NovaLux12/spotify-mcp-server/issues/1579)
* **privacy:** say what --keep-backups and --profile actually leave behind ([#1594](https://github.com/NovaLux12/spotify-mcp-server/issues/1594)) ([68571d7](https://github.com/NovaLux12/spotify-mcp-server/commit/68571d70eae51dbf4b892fdca1a6c983cb0a3565)), closes [#1581](https://github.com/NovaLux12/spotify-mcp-server/issues/1581)
* **statsfm,taste:** second pass on the two files the first pass cleared ([#1273](https://github.com/NovaLux12/spotify-mcp-server/issues/1273)) ([c3e0b8c](https://github.com/NovaLux12/spotify-mcp-server/commit/c3e0b8c28c0064e7c6d69d1cb24c21bbb87902e3))
* sweep hand-written prose for claims the code does not support ([#1292](https://github.com/NovaLux12/spotify-mcp-server/issues/1292)) ([32cabdf](https://github.com/NovaLux12/spotify-mcp-server/commit/32cabdf775a2a396467150e6ce88ff0b19ac5a06))
* sweep the hand-written prose against the code ([#1242](https://github.com/NovaLux12/spotify-mcp-server/issues/1242)) ([#1267](https://github.com/NovaLux12/spotify-mcp-server/issues/1267)) ([1fab1e3](https://github.com/NovaLux12/spotify-mcp-server/commit/1fab1e3ac9c51870fa37bdc9e1515567f768380e))
* **sweep:** correct a false safety claim, a stale tool count, and a retired alias ([2e4276a](https://github.com/NovaLux12/spotify-mcp-server/commit/2e4276a414fa96ef5f8f94cb6bc37e607153756b))
* the road to 3.0 — a roadmap page, linked from the README ([#1458](https://github.com/NovaLux12/spotify-mcp-server/issues/1458)) ([14a5e8b](https://github.com/NovaLux12/spotify-mcp-server/commit/14a5e8b290260fe8828ecdd256c7132c31a900cd))
* **v2:** write the non-goals list and mirror it in the README ([#1316](https://github.com/NovaLux12/spotify-mcp-server/issues/1316)) ([b200bc4](https://github.com/NovaLux12/spotify-mcp-server/commit/b200bc4c6a1499af07458bdf02bc2d1a1a6d3558)), closes [#608](https://github.com/NovaLux12/spotify-mcp-server/issues/608)


### Tests

* **#575:** cover queueanalysis, resources/uritemplate and tools/encoding ([#1561](https://github.com/NovaLux12/spotify-mcp-server/issues/1561)) ([ee165e3](https://github.com/NovaLux12/spotify-mcp-server/commit/ee165e3f98aa914bb51fa360cfbca994c8a1386e))
* **#657:** kill four assertions that could not fail ([#1304](https://github.com/NovaLux12/spotify-mcp-server/issues/1304)) ([2219f12](https://github.com/NovaLux12/spotify-mcp-server/commit/2219f1298b7fd47b1c254c34c7c81730774dc4dd))
* **#664:** pin the clock in exhaust2_misc and gate test-source debug output ([#1210](https://github.com/NovaLux12/spotify-mcp-server/issues/1210)) ([4d760c5](https://github.com/NovaLux12/spotify-mcp-server/commit/4d760c5a10fdaa66a34e05c31b1e39a1e1571193)), closes [#664](https://github.com/NovaLux12/spotify-mcp-server/issues/664)
* **#666:** cover StatsfmClient HTTP behaviour with an injected fetchFn ([#1218](https://github.com/NovaLux12/spotify-mcp-server/issues/1218)) ([18bd30d](https://github.com/NovaLux12/spotify-mcp-server/commit/18bd30d9992ad2eb50010fd0484511918fa1347e)), closes [#666](https://github.com/NovaLux12/spotify-mcp-server/issues/666)
* **#881:** cover the thirteen playlist tools against a stateful stub ([#1313](https://github.com/NovaLux12/spotify-mcp-server/issues/1313)) ([ecb399d](https://github.com/NovaLux12/spotify-mcp-server/commit/ecb399d0b24196cc9c468628203e47e5c529d2d9)), closes [#881](https://github.com/NovaLux12/spotify-mcp-server/issues/881)
* **annotations:** scan shaping.ts again, the exclusion's reason is gone ([#1349](https://github.com/NovaLux12/spotify-mcp-server/issues/1349)) ([f5ceb80](https://github.com/NovaLux12/spotify-mcp-server/commit/f5ceb80923e91e0f52e02b4afe8c94735584f576)), closes [#1332](https://github.com/NovaLux12/spotify-mcp-server/issues/1332)
* **branding:** a killed CLI child is not a CLI child that printed nothing ([#1411](https://github.com/NovaLux12/spotify-mcp-server/issues/1411)) ([6be051c](https://github.com/NovaLux12/spotify-mcp-server/commit/6be051cdb3a3194b37aad4206399917bc640b45f)), closes [#1378](https://github.com/NovaLux12/spotify-mcp-server/issues/1378)
* **cache:** give ValidatorStore an injectable clock ([#1386](https://github.com/NovaLux12/spotify-mcp-server/issues/1386)) ([#1419](https://github.com/NovaLux12/spotify-mcp-server/issues/1419)) ([a8192a7](https://github.com/NovaLux12/spotify-mcp-server/commit/a8192a7fbd1527f26d56a9f22907cd410660fd9c))
* **ci:** one shared stub client, so a paging regression reaches a tool test ([#1302](https://github.com/NovaLux12/spotify-mcp-server/issues/1302)) ([2d66f48](https://github.com/NovaLux12/spotify-mcp-server/commit/2d66f480356b79549c0b94b3f1b4e0e0e235e3f9))
* **client:** cover the read cache — hits, invalidation, volatile bypass ([#660](https://github.com/NovaLux12/spotify-mcp-server/issues/660)) ([#1308](https://github.com/NovaLux12/spotify-mcp-server/issues/1308)) ([ab07026](https://github.com/NovaLux12/spotify-mcp-server/commit/ab07026c6d80b2c990efe04bd289c5b3f5c2b98f))
* **config-readonly:** carry the doctor output in the spelling-loop assertion ([#1340](https://github.com/NovaLux12/spotify-mcp-server/issues/1340)) ([4a4a327](https://github.com/NovaLux12/spotify-mcp-server/commit/4a4a327e5a73f60347886587daa827c39ad5d2a6)), closes [#1334](https://github.com/NovaLux12/spotify-mcp-server/issues/1334)
* **coverage:** gate per-tool coverage with an explicit allow-list ([#1325](https://github.com/NovaLux12/spotify-mcp-server/issues/1325)) ([aec0105](https://github.com/NovaLux12/spotify-mcp-server/commit/aec010594ba862fa7a4992c51173009641caec7f))
* **docs:** scan the env names the guard was blind to, in one alternation ([#926](https://github.com/NovaLux12/spotify-mcp-server/issues/926)) ([9bb68b4](https://github.com/NovaLux12/spotify-mcp-server/commit/9bb68b44151a189ba8ee93148f33afb36968b82f))
* **freshness:** drive planCallCost's aggregate with a non-zero podcasts term ([#1306](https://github.com/NovaLux12/spotify-mcp-server/issues/1306)) ([c42a917](https://github.com/NovaLux12/spotify-mcp-server/commit/c42a917167c4e1aa6f7afdabeaf688462091942a)), closes [#1291](https://github.com/NovaLux12/spotify-mcp-server/issues/1291)
* **gauntlet:** derive mutating-tool classification from the registry ([#1336](https://github.com/NovaLux12/spotify-mcp-server/issues/1336)) ([6d4a9ae](https://github.com/NovaLux12/spotify-mcp-server/commit/6d4a9ae08ba5fdc6574731fde99665176b3e9ef7))
* **harness:** reject requests made against an already-dead child ([#1395](https://github.com/NovaLux12/spotify-mcp-server/issues/1395)) ([845032b](https://github.com/NovaLux12/spotify-mcp-server/commit/845032b4b23b24ea06ed407ccf4b89a69bf47a88)), closes [#1366](https://github.com/NovaLux12/spotify-mcp-server/issues/1366)
* **harness:** report a killed server child as killed, not as a timeout ([#1373](https://github.com/NovaLux12/spotify-mcp-server/issues/1373)) ([7de3d0d](https://github.com/NovaLux12/spotify-mcp-server/commit/7de3d0db0beb450d5a8f5e5d457b408c1bf75927)), closes [#1366](https://github.com/NovaLux12/spotify-mcp-server/issues/1366)
* **packaging,attribution:** ask the two suites for the thing they were not checking ([#1623](https://github.com/NovaLux12/spotify-mcp-server/issues/1623), [#1610](https://github.com/NovaLux12/spotify-mcp-server/issues/1610)) ([#1633](https://github.com/NovaLux12/spotify-mcp-server/issues/1633)) ([c9c81d3](https://github.com/NovaLux12/spotify-mcp-server/commit/c9c81d3f87ae65fef3862f38191b2717b8febd65))
* **prose:** derive the retirement fixture instead of naming a paragraph ([#1618](https://github.com/NovaLux12/spotify-mcp-server/issues/1618)) ([adee5d2](https://github.com/NovaLux12/spotify-mcp-server/commit/adee5d2e34c455f90755294bbbd9e7a9e0d5d252))
* **registry:** cover the READONLY and toolset env switches at tools/list ([#1315](https://github.com/NovaLux12/spotify-mcp-server/issues/1315)) ([45a01e8](https://github.com/NovaLux12/spotify-mcp-server/commit/45a01e8d6b050bf8004eafe19ac5c73a6001628e)), closes [#661](https://github.com/NovaLux12/spotify-mcp-server/issues/661)
* **registry:** pin the manifest, duplicates, schema validity and byte budget ([#662](https://github.com/NovaLux12/spotify-mcp-server/issues/662)) ([#1283](https://github.com/NovaLux12/spotify-mcp-server/issues/1283)) ([9d54703](https://github.com/NovaLux12/spotify-mcp-server/commit/9d54703b50cba6df68da34426416c71d21eb1166))
* **registry:** stop the byte-budget prose from asserting figures that rot ([#1319](https://github.com/NovaLux12/spotify-mcp-server/issues/1319)) ([42c6b17](https://github.com/NovaLux12/spotify-mcp-server/commit/42c6b17fc6862e06f8c61b778a890fa99ebe87e0))
* **resources:** a split read registry is caught by polling through the production call site ([#1542](https://github.com/NovaLux12/spotify-mcp-server/issues/1542)) ([#1545](https://github.com/NovaLux12/spotify-mcp-server/issues/1545)) ([ba655e9](https://github.com/NovaLux12/spotify-mcp-server/commit/ba655e902900e9aa2fa3b3aed9e1bd2e1a77c4ca))
* **swarm3:** drive the 22 handlers [#668](https://github.com/NovaLux12/spotify-mcp-server/issues/668) found uninvoked, and fix the double-? it exposed ([#1299](https://github.com/NovaLux12/spotify-mcp-server/issues/1299)) ([fe6844a](https://github.com/NovaLux12/spotify-mcp-server/commit/fe6844a4b794e4c5bab4a0ca109aacef9b38124c))
* three claims that were not true — a mis-named test, a phantom record, a partial sweep ([#1640](https://github.com/NovaLux12/spotify-mcp-server/issues/1640)) ([2db98c8](https://github.com/NovaLux12/spotify-mcp-server/commit/2db98c88f8a9427af76be231e3e645c96fbe45a8))
* **tool.surface:** derive the core-vs-full ratio instead of a stale literal ([#1562](https://github.com/NovaLux12/spotify-mcp-server/issues/1562)) ([#1573](https://github.com/NovaLux12/spotify-mcp-server/issues/1573)) ([de656dd](https://github.com/NovaLux12/spotify-mcp-server/commit/de656ddfabb6443a364b41766a4ed480caa3db3d))
* **undo:** cover the receipt tools at the tool level, and fix their annotations ([#1293](https://github.com/NovaLux12/spotify-mcp-server/issues/1293)) ([656699f](https://github.com/NovaLux12/spotify-mcp-server/commit/656699f046c47e6da350313cc13798ab12f493f8))
* **wire:** a committed, reproducible, hermetic wire-equivalence harness ([#1481](https://github.com/NovaLux12/spotify-mcp-server/issues/1481)) ([#1503](https://github.com/NovaLux12/spotify-mcp-server/issues/1503)) ([b3a2194](https://github.com/NovaLux12/spotify-mcp-server/commit/b3a21944cbbfcee58a0834437b18f73bba509a19))


### Code Refactoring

* **#758:** type the payload boundaries and gate `as any` in CI ([#1201](https://github.com/NovaLux12/spotify-mcp-server/issues/1201)) ([3a856ba](https://github.com/NovaLux12/spotify-mcp-server/commit/3a856bac676fb52e71037b414ddf00d5b4cd95a3)), closes [#758](https://github.com/NovaLux12/spotify-mcp-server/issues/758)
* **#788:** one definition of the render and market helpers ([#1268](https://github.com/NovaLux12/spotify-mcp-server/issues/1268)) ([fdcf425](https://github.com/NovaLux12/spotify-mcp-server/commit/fdcf425d634ee16376870fa3a4d7a4296149a061))
* **playback:** one transfer tool and one volume tool ([#848](https://github.com/NovaLux12/spotify-mcp-server/issues/848)) ([#1492](https://github.com/NovaLux12/spotify-mcp-server/issues/1492)) ([f3b6ee8](https://github.com/NovaLux12/spotify-mcp-server/commit/f3b6ee80bac713525946da9991c23afa0c1bd7d2))
* **result:** one textResult and one emit, in src/result.ts ([#582](https://github.com/NovaLux12/spotify-mcp-server/issues/582)) ([#1477](https://github.com/NovaLux12/spotify-mcp-server/issues/1477)) ([4187787](https://github.com/NovaLux12/spotify-mcp-server/commit/4187787f9a8c020aa44e36ed003a111970045b57))


### Miscellaneous Chores

* **distribution:** retire the unmaintained smithery manifest ([#1342](https://github.com/NovaLux12/spotify-mcp-server/issues/1342)) ([2ec53d5](https://github.com/NovaLux12/spotify-mcp-server/commit/2ec53d5889b79058381c7de6d083268c57b75fca)), closes [#710](https://github.com/NovaLux12/spotify-mcp-server/issues/710)
* **docs:** regenerate the module-map LOC cell after [#1380](https://github.com/NovaLux12/spotify-mcp-server/issues/1380) ([8b84b76](https://github.com/NovaLux12/spotify-mcp-server/commit/8b84b767b913a75d7628d7d49cdcdb9cc6cf8ab9))
* **prompts:** make body numbering consistent and drop the unused ranges binding ([#1348](https://github.com/NovaLux12/spotify-mcp-server/issues/1348)) ([a9cf1c5](https://github.com/NovaLux12/spotify-mcp-server/commit/a9cf1c5b3769d06c0c2a830318392cdb63b970a6)), closes [#714](https://github.com/NovaLux12/spotify-mcp-server/issues/714)

## [2.1.2](https://github.com/NovaLux12/spotify-mcp-server/compare/v2.1.1...v2.1.2) (2026-09-26)


### Bug Fixes

* **#583:** source every batch-loop bound from the shared CHUNK_CAPS table ([#1117](https://github.com/NovaLux12/spotify-mcp-server/issues/1117)) ([691b623](https://github.com/NovaLux12/spotify-mcp-server/commit/691b623af221b81c4a07c453505a98c548096dc8)), closes [#583](https://github.com/NovaLux12/spotify-mcp-server/issues/583)
* **#741:** a capped shows or episodes walk is truncated too ([#1034](https://github.com/NovaLux12/spotify-mcp-server/issues/1034)) ([e0663a7](https://github.com/NovaLux12/spotify-mcp-server/commit/e0663a78f77b5d927f80d4b5520718194730c7e4))
* **audiobookcopilot:** disclose the fetch-all cap in list_all_chapters ([#980](https://github.com/NovaLux12/spotify-mcp-server/issues/980)) ([738b229](https://github.com/NovaLux12/spotify-mcp-server/commit/738b22914f8c99dd09fb1879abfaa8cfc2dd2061)), closes [#786](https://github.com/NovaLux12/spotify-mcp-server/issues/786)
* **backup:** name the store envelope's actual key in list_backups ([#1125](https://github.com/NovaLux12/spotify-mcp-server/issues/1125)) ([f8a2a10](https://github.com/NovaLux12/spotify-mcp-server/commit/f8a2a1089269f1afb560b672b794bb01970b84f4))


### Documentation

* **#697:** document SPOTIFY_MCP_BACKUP_RETENTION_DAYS ([#1043](https://github.com/NovaLux12/spotify-mcp-server/issues/1043)) ([8764ab6](https://github.com/NovaLux12/spotify-mcp-server/commit/8764ab687ad4b76ffc812135fc3d804fc96956a6)), closes [#697](https://github.com/NovaLux12/spotify-mcp-server/issues/697)

## [2.1.1](https://github.com/NovaLux12/spotify-mcp-server/compare/v2.1.0...v2.1.1) (2026-09-25)


### Bug Fixes

* **ci:** do not let a documentation gate silence the test suite ([#999](https://github.com/NovaLux12/spotify-mcp-server/issues/999)) ([de21b61](https://github.com/NovaLux12/spotify-mcp-server/commit/de21b61df1cd14c8753c08a8dc15e8266e08436c))
* **gauntlet,docs:** correct the endpoint table, publish rule, and expected-fail set ([#1012](https://github.com/NovaLux12/spotify-mcp-server/issues/1012)) ([75b8b0d](https://github.com/NovaLux12/spotify-mcp-server/commit/75b8b0d52a899ccb1535641cf6ec47ccbd8bfdcc))
* **gauntlet:** mark browse/categories tools expected-fail too ([#1016](https://github.com/NovaLux12/spotify-mcp-server/issues/1016)) ([77d723f](https://github.com/NovaLux12/spotify-mcp-server/commit/77d723f74641208d23b78e06f2e06b387d73e379))


### Documentation

* **agents:** correct two release facts that were actively wrong ([#1010](https://github.com/NovaLux12/spotify-mcp-server/issues/1010)) ([0e6324d](https://github.com/NovaLux12/spotify-mcp-server/commit/0e6324d4d9ded810b3798b7bca263decb8a201fb))
* **agents:** resolve a self-contradiction the previous commit introduced ([#1014](https://github.com/NovaLux12/spotify-mcp-server/issues/1014)) ([b8c5138](https://github.com/NovaLux12/spotify-mcp-server/commit/b8c5138df89635ad679972a9411ebc1f6c58c271))

## [2.1.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v2.0.0...v2.1.0) (2026-09-25)


### Features

* **following:** add fetch_all paging and normalise artist references ([846297f](https://github.com/NovaLux12/spotify-mcp-server/commit/846297f24126de07cb31c0e1a46afca821d946b7)), closes [#744](https://github.com/NovaLux12/spotify-mcp-server/issues/744) [#745](https://github.com/NovaLux12/spotify-mcp-server/issues/745)


### Bug Fixes

* **#627:** gate undo behind confirmation and default dry_run to true ([241b49a](https://github.com/NovaLux12/spotify-mcp-server/commit/241b49a9fd58d413964b80d4840d437d342879c4)), closes [#627](https://github.com/NovaLux12/spotify-mcp-server/issues/627)
* **#755:** disclose the fetch-all cap in library genre tools ([d3c3ef6](https://github.com/NovaLux12/spotify-mcp-server/commit/d3c3ef6f2ded4432f21bebcacf05987f826725f2)), closes [#755](https://github.com/NovaLux12/spotify-mcp-server/issues/755)
* **#829:** report the real playlist length in playlist_cover_from_track ([3c9f2d9](https://github.com/NovaLux12/spotify-mcp-server/commit/3c9f2d9865abb9d2d5a5b4474edf9a8e2d1a4c48)), closes [#829](https://github.com/NovaLux12/spotify-mcp-server/issues/829)
* **analytics:** cursor pagination and one UTC time frame ([#806](https://github.com/NovaLux12/spotify-mcp-server/issues/806), [#823](https://github.com/NovaLux12/spotify-mcp-server/issues/823), [#824](https://github.com/NovaLux12/spotify-mcp-server/issues/824)) ([fe45fe2](https://github.com/NovaLux12/spotify-mcp-server/commit/fe45fe2d278f09b0d4983cfd3c34685647c9034c))
* **analytics:** fall back to the id when a top-artist row has no name ([a3c4ef9](https://github.com/NovaLux12/spotify-mcp-server/commit/a3c4ef923b705126f4fe6e593f880d1eaa79e074))
* **analytics:** honour max_items in listening_streaks; ship top_artists_by_range deltas ([528e00d](https://github.com/NovaLux12/spotify-mcp-server/commit/528e00daf646b005b63e5ab6e00e199fa3e21b46)), closes [#805](https://github.com/NovaLux12/spotify-mcp-server/issues/805) [#804](https://github.com/NovaLux12/spotify-mcp-server/issues/804)
* **analytics:** honour max_items in listening_streaks; ship top_artists_by_range deltas ([e7e1b57](https://github.com/NovaLux12/spotify-mcp-server/commit/e7e1b5738b0f8c484e1e778e86b917275acc433b)), closes [#805](https://github.com/NovaLux12/spotify-mcp-server/issues/805) [#804](https://github.com/NovaLux12/spotify-mcp-server/issues/804)
* **analytics:** honour max_items, ship top_artists_by_range deltas, report unreadable stats.fm friends ([#804](https://github.com/NovaLux12/spotify-mcp-server/issues/804), [#805](https://github.com/NovaLux12/spotify-mcp-server/issues/805), [#803](https://github.com/NovaLux12/spotify-mcp-server/issues/803)) ([12ce5bb](https://github.com/NovaLux12/spotify-mcp-server/commit/12ce5bbe1d76c19676f91586d57aae0a97e2c289))
* **catalog:** route catalog id params through the shared reference resolver ([6aaacd9](https://github.com/NovaLux12/spotify-mcp-server/commit/6aaacd9ed6e863e1567a6aa7a8722c826f2c2799)), closes [#789](https://github.com/NovaLux12/spotify-mcp-server/issues/789)
* **client:** map player-namespace 404s to a no-active-device message ([#849](https://github.com/NovaLux12/spotify-mcp-server/issues/849)) ([9c0e85c](https://github.com/NovaLux12/spotify-mcp-server/commit/9c0e85cb9daa5733c4900fca35f9d909b66327fb))
* **exhaust2-misc:** page artist albums, read show.total_episodes ([875500d](https://github.com/NovaLux12/spotify-mcp-server/commit/875500d9e923fe2f88842659dff4359584343c78)), closes [#828](https://github.com/NovaLux12/spotify-mcp-server/issues/828) [#826](https://github.com/NovaLux12/spotify-mcp-server/issues/826)
* **export:** confine export writes to an output root and neutralise CSV formulas ([a920cb4](https://github.com/NovaLux12/spotify-mcp-server/commit/a920cb4eadbe3ac307e5147b1f7974db74fa201e))
* **export:** fold attacker-controlled metadata out of #EXTINF lines ([9169318](https://github.com/NovaLux12/spotify-mcp-server/commit/9169318c885a75c309c1f9e45e820b83bb512766))
* **history:** redact URIs, re-assert 0600, rotate and bound reads ([00fde2c](https://github.com/NovaLux12/spotify-mcp-server/commit/00fde2c0debeba9e13961ac6cd585c6e39150a90)), closes [#628](https://github.com/NovaLux12/spotify-mcp-server/issues/628)
* **import:** confine local reads, stop metadata hijacking URIs, make imports idempotent ([d1377e9](https://github.com/NovaLux12/spotify-mcp-server/commit/d1377e9428df1d930bad4f2c5abf2a3ec9da59fd))
* **library-analytics:** truthful coverage, growth and heatmap scopes ([d75b340](https://github.com/NovaLux12/spotify-mcp-server/commit/d75b34016d9914238fac8c1ba8272676761af008)), closes [#738](https://github.com/NovaLux12/spotify-mcp-server/issues/738) [#739](https://github.com/NovaLux12/spotify-mcp-server/issues/739) [#740](https://github.com/NovaLux12/spotify-mcp-server/issues/740) [#741](https://github.com/NovaLux12/spotify-mcp-server/issues/741)
* **library:** stop reporting unreadable collections and bad date bounds as results ([f7cd930](https://github.com/NovaLux12/spotify-mcp-server/commit/f7cd93027e4aebc5fafc7dc288e4b4bf0855c3e4)), closes [#749](https://github.com/NovaLux12/spotify-mcp-server/issues/749) [#750](https://github.com/NovaLux12/spotify-mcp-server/issues/750)
* **mute:** remember volume only after the mute write lands ([fc0c3ef](https://github.com/NovaLux12/spotify-mcp-server/commit/fc0c3ef020862b0809fbd4b5f9de55bcde3a4223)), closes [#843](https://github.com/NovaLux12/spotify-mcp-server/issues/843)
* **personalization:** cursor continuation for get_recently_played, not next_offset ([#806](https://github.com/NovaLux12/spotify-mcp-server/issues/806)) ([98109f1](https://github.com/NovaLux12/spotify-mcp-server/commit/98109f1fa1f57ae1099c5db3acc066bbb4b096cd))
* **playbackext:** rebuild smart playlists and restore the saved context ([#834](https://github.com/NovaLux12/spotify-mcp-server/issues/834), [#833](https://github.com/NovaLux12/spotify-mcp-server/issues/833)) ([06d4140](https://github.com/NovaLux12/spotify-mcp-server/commit/06d414091ea85047ff9335ae5d0b13205dee5a94))
* **playbackintel:** play_at contract parity and baseline refresh ([#838](https://github.com/NovaLux12/spotify-mcp-server/issues/838), [#842](https://github.com/NovaLux12/spotify-mcp-server/issues/842)) ([d2c13a9](https://github.com/NovaLux12/spotify-mcp-server/commit/d2c13a914780fe31cebf5c6153e5d28d3c5d9ee4))
* **playbackintel:** play_at enforces play's URI and offset contract ([#842](https://github.com/NovaLux12/spotify-mcp-server/issues/842)) ([73404aa](https://github.com/NovaLux12/spotify-mcp-server/commit/73404aa41c4efabda99cc70c466f993ab94395df))
* **playback:** read item/items in get_context_inspect rows ([#838](https://github.com/NovaLux12/spotify-mcp-server/issues/838)) ([649fcb9](https://github.com/NovaLux12/spotify-mcp-server/commit/649fcb910c3d1a1531504cad217f05b58f29bc65))
* **playback:** read item/items, not deprecated track aliases ([#838](https://github.com/NovaLux12/spotify-mcp-server/issues/838)) ([77d6d31](https://github.com/NovaLux12/spotify-mcp-server/commit/77d6d31e09c4216cf8fec73109ec005589242aec))
* **playback:** render ad/unknown player items without throwing ([149c257](https://github.com/NovaLux12/spotify-mcp-server/commit/149c25738c1b32136d0862196955f9e12272c32c)), closes [#852](https://github.com/NovaLux12/spotify-mcp-server/issues/852)
* **playback:** send volume_percent on every /me/player/volume write ([cd478ee](https://github.com/NovaLux12/spotify-mcp-server/commit/cd478ee515d4d833d9a5bed21406c7bd1fb4f6c8)), closes [#830](https://github.com/NovaLux12/spotify-mcp-server/issues/830)
* **playback:** skip id-less devices in volume plans ([#853](https://github.com/NovaLux12/spotify-mcp-server/issues/853)) ([df5d6a2](https://github.com/NovaLux12/spotify-mcp-server/commit/df5d6a20c4888b3d4e14f81c3513edf7d72329d4))
* **playback:** stop rendering absent volume as "undefined%" and report a failed play_on shuffle ([5144415](https://github.com/NovaLux12/spotify-mcp-server/commit/51444155dfbaee5cd250f43e0b2925662bfd76a5)), closes [#855](https://github.com/NovaLux12/spotify-mcp-server/issues/855) [#837](https://github.com/NovaLux12/spotify-mcp-server/issues/837)
* resolve two merge conflicts in source, not tests ([b7f3e73](https://github.com/NovaLux12/spotify-mcp-server/commit/b7f3e7378a9d7808120ce3d42c2b9effc3b13cce))
* **search:** add offset paging to search_deep ([#792](https://github.com/NovaLux12/spotify-mcp-server/issues/792)) ([2dbd08c](https://github.com/NovaLux12/spotify-mcp-server/commit/2dbd08cc7d63922be18e82f90427aaee8a31f3f2))
* **showradar:** disclose the /me/shows listing cap and drop mutation dry_run ([64909a5](https://github.com/NovaLux12/spotify-mcp-server/commit/64909a58a9b4225206f00201ea3b067138890ddf)), closes [#673](https://github.com/NovaLux12/spotify-mcp-server/issues/673) [#794](https://github.com/NovaLux12/spotify-mcp-server/issues/794)
* **statsfm:** do not claim unreadable profiles for an empty friend list ([#803](https://github.com/NovaLux12/spotify-mcp-server/issues/803)) ([214036f](https://github.com/NovaLux12/spotify-mcp-server/commit/214036f3cce46449fa2a7c256f01653e860cd9c6))
* **statsfm:** report unreadable friends in the people chart instead of charting 0 ([2e2c754](https://github.com/NovaLux12/spotify-mcp-server/commit/2e2c754287ddb6207b5cd5585a0d5c008126b226)), closes [#803](https://github.com/NovaLux12/spotify-mcp-server/issues/803)
* **statsfm:** report unreadable friends in the people chart instead of charting 0 ([92b35a2](https://github.com/NovaLux12/spotify-mcp-server/commit/92b35a2a993439c2f7b0a1d0502457856affe62e)), closes [#803](https://github.com/NovaLux12/spotify-mcp-server/issues/803)
* **swarm3-analytics:** report a true quietest hour and one UTC time frame ([c67d6d0](https://github.com/NovaLux12/spotify-mcp-server/commit/c67d6d0de9f902dd2a4f2bda6bb4dd02377e5009)), closes [#823](https://github.com/NovaLux12/spotify-mcp-server/issues/823) [#824](https://github.com/NovaLux12/spotify-mcp-server/issues/824)
* **users:** guard null playlist owner and route user_id through src/refs ([86ee5c4](https://github.com/NovaLux12/spotify-mcp-server/commit/86ee5c430a00163bcfd2e4e74ead53ad30e66687)), closes [#762](https://github.com/NovaLux12/spotify-mcp-server/issues/762) [#789](https://github.com/NovaLux12/spotify-mcp-server/issues/789)


### Documentation

* **agents:** replace CLAUDE.md with AGENTS.md ([0a91ad9](https://github.com/NovaLux12/spotify-mcp-server/commit/0a91ad91ea68de25096e2e535157097d711b6eea))
* document the six env vars the wave introduced, and the confinement rule ([8fe69bb](https://github.com/NovaLux12/spotify-mcp-server/commit/8fe69bb338a7645cc5fdf681e356741c28f68427))
* regenerate the module map after the artist-name fallback ([723b3c1](https://github.com/NovaLux12/spotify-mcp-server/commit/723b3c19cddc861662f5982b0e6626dade3395ae))
* regenerate the module map after the volume-parameter fix ([#830](https://github.com/NovaLux12/spotify-mcp-server/issues/830)) ([a7eb329](https://github.com/NovaLux12/spotify-mcp-server/commit/a7eb329c791303ced837b3796b5de637b1788a9e))
* regenerate the module map after the wave-3 playback fixes ([#849](https://github.com/NovaLux12/spotify-mcp-server/issues/849), [#843](https://github.com/NovaLux12/spotify-mcp-server/issues/843), [#852](https://github.com/NovaLux12/spotify-mcp-server/issues/852)) ([47c4ea5](https://github.com/NovaLux12/spotify-mcp-server/commit/47c4ea5775f8f111cafa3ad2246dedab7acd9661))


### Tests

* **refs:** pin exact open.spotify.com host policy for the reference tools ([562460a](https://github.com/NovaLux12/spotify-mcp-server/commit/562460adb718f2249da5f219dd14eb7aa197aaad)), closes [#825](https://github.com/NovaLux12/spotify-mcp-server/issues/825)


### Miscellaneous Chores

* regenerate generated blocks and refresh baselines after waves 5-7 ([aeb31c2](https://github.com/NovaLux12/spotify-mcp-server/commit/aeb31c23e381b7689986d8e6e36318df463cbbe8))
* regenerate generated blocks and refresh baselines after waves 5-7 ([9f16703](https://github.com/NovaLux12/spotify-mcp-server/commit/9f16703c36294b234b75e44ba6b7bc72590e8787))

## [2.0.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.31.0...v2.0.0) (2026-09-25)


### ⚠ BREAKING CHANGES

* **registry:** destructive writes fail closed when the client cannot elicit (unless SPOTIFY_MCP_CONFIRM=never); playlist_subtract takes an explicit base_playlist_id with the positional form still accepted; the retired get_show_episodes alias is gone (use list_show_episodes); unknown arguments are rejected rather than ignored; union/subtract results report returned counts beside true-impact totals.
* **registry:** tools whose input schema changed shape or whose required parameters were renamed now reject old callers with a typed `validation` error instead of silently ignoring the input:

### Features

* add structured MCP error boundary ([8ddf4b7](https://github.com/NovaLux12/spotify-mcp-server/commit/8ddf4b76cc58dbfa0a339f564774c1b818942c0a))
* enforce per-module schema budgets ([99fb345](https://github.com/NovaLux12/spotify-mcp-server/commit/99fb345100e6d6128ed9f400a97c7c1c7b13d874))
* make truncation advice schema-aware ([44e41e4](https://github.com/NovaLux12/spotify-mcp-server/commit/44e41e43f0dabca756c4506768271a980ca4919c))
* **registry:** replace inline registration gates with a registrar manifest ([e00adfc](https://github.com/NovaLux12/spotify-mcp-server/commit/e00adfc9f7b5ed4d939ac65cb5c2617568475ca2))
* **registry:** v2 contract spine — registrar manifest, structured errors, generated docs ([#954](https://github.com/NovaLux12/spotify-mcp-server/issues/954)) ([f88d3cd](https://github.com/NovaLux12/spotify-mcp-server/commit/f88d3cd7a29787cefda54e082575496297b4943e))
* unify playlist set-operation inputs ([b03be82](https://github.com/NovaLux12/spotify-mcp-server/commit/b03be82bdea70f0e6ad590d4ac1309975c84ccc7))


### Bug Fixes

* align census and contract guards with manifest ([9dd2215](https://github.com/NovaLux12/spotify-mcp-server/commit/9dd22154e2509693e914840aa00b5104d7ec2771))
* align final schema and safety contracts ([7fa2fdb](https://github.com/NovaLux12/spotify-mcp-server/commit/7fa2fdb24a025f3ea4d6c1b4d4cc95cc327ebc06))
* canonicalize Spotify links before writes ([9f8526e](https://github.com/NovaLux12/spotify-mcp-server/commit/9f8526e6948d2d57ba50678a62cab9049fa97761))
* **census:** align generated registry documentation ([e84d8ec](https://github.com/NovaLux12/spotify-mcp-server/commit/e84d8ec18355846fba5cb00b79dd14196e3c9ccc))
* classify curated URI dedupe as read-only ([66b5ed0](https://github.com/NovaLux12/spotify-mcp-server/commit/66b5ed05b63d4e135fed2a8f2d8f5c1b85b6a797))
* close integrated budget and truncation regressions ([d646d8f](https://github.com/NovaLux12/spotify-mcp-server/commit/d646d8ffa543458c2c0ec764cb513cf9b555e10a))
* close the merge gate's findings on truncation totals, references and budgets ([68646e4](https://github.com/NovaLux12/spotify-mcp-server/commit/68646e48c44b6371acaec756211e9ff3368aee30))
* correct the 2.0 migration story in the docs and the two exits it missed ([c9eddf1](https://github.com/NovaLux12/spotify-mcp-server/commit/c9eddf11f017591262f2a0d8bb4237a5adf23e65))
* derive census attribution from registrar manifest ([c6ee31a](https://github.com/NovaLux12/spotify-mcp-server/commit/c6ee31ac367e0f2c46c2fe16227a407a6209b644))
* enforce aggregate tool surface budget ([45b5d46](https://github.com/NovaLux12/spotify-mcp-server/commit/45b5d4682ffa61102b2e872431ee77092bb2a20c))
* fail closed destructive gates and redact caught errors ([a1ed1d0](https://github.com/NovaLux12/spotify-mcp-server/commit/a1ed1d06544c3840bb170ebffb228713803558c7))
* finalize census and readonly contracts ([bda0543](https://github.com/NovaLux12/spotify-mcp-server/commit/bda054338595674598e66cfa931fbd778221408f))
* finalize security contracts and documentation ([1aa6097](https://github.com/NovaLux12/spotify-mcp-server/commit/1aa6097dcc791b61814ca6562993cb3d8806dd87))
* gate playlist replacement on destructive impact ([f02c60e](https://github.com/NovaLux12/spotify-mcp-server/commit/f02c60e45103020eeb9da1407cbf674f5e6c5225))
* gate playlist subtraction on impact ([9c526c6](https://github.com/NovaLux12/spotify-mcp-server/commit/9c526c65ff215bb3daa7f2969ed5e66b78db4659))
* hide mixed show writers in readonly mode ([33b62d2](https://github.com/NovaLux12/spotify-mcp-server/commit/33b62d249e33862a2eba364a0b81fa123015e64f))
* honor max items truncation capability ([0280bce](https://github.com/NovaLux12/spotify-mcp-server/commit/0280bce5768b1f00d7f02073b686349a9eb52f4f))
* isolate census measurements and readonly gates ([f797b46](https://github.com/NovaLux12/spotify-mcp-server/commit/f797b46b2b5774ad68a7ac9df13645bc8732466c))
* **playlists:** disclose a truncated source walk in the union confirmation ([f0e3416](https://github.com/NovaLux12/spotify-mcp-server/commit/f0e34166778bce2b8023bcf7a7630c233f092a87))
* **playlists:** unify plural inputs and gate union replacements ([9401475](https://github.com/NovaLux12/spotify-mcp-server/commit/94014751b7721706fffb74e218fa1cddc1150ae8))
* preserve live truncation counts ([e95c16f](https://github.com/NovaLux12/spotify-mcp-server/commit/e95c16fbb0183dcd748125fb67d1000a5b65575e))
* preserve typed statsfm errors ([266e38a](https://github.com/NovaLux12/spotify-mcp-server/commit/266e38a493c4610625e14d316e71e63241990da3))
* redact protected MCP diagnostics ([1c05d68](https://github.com/NovaLux12/spotify-mcp-server/commit/1c05d685e5749e61f39e36bbb1caa9d24de014b5))
* refresh measured schema budget baselines ([4705cae](https://github.com/NovaLux12/spotify-mcp-server/commit/4705cae4a80aea1d7276b302af6cf61018b030be))
* **release:** target repository when dispatching publish ([#952](https://github.com/NovaLux12/spotify-mcp-server/issues/952)) ([940101c](https://github.com/NovaLux12/spotify-mcp-server/commit/940101ce75d21daf4921381ee28c77d2137313bf))
* require elicitation for bulk episode archive ([22df09f](https://github.com/NovaLux12/spotify-mcp-server/commit/22df09f053bd2363fcd3b87926c027717898ff12))
* reuse finalized census in docs gates ([456de31](https://github.com/NovaLux12/spotify-mcp-server/commit/456de31d5a6b9060032ea95c345bb355402b8fd4))
* share canonical playlist reference grammar ([f6355f4](https://github.com/NovaLux12/spotify-mcp-server/commit/f6355f49de171563d988048f31778c71a26d41bc))
* tighten schema budget parity reporting ([26c17b6](https://github.com/NovaLux12/spotify-mcp-server/commit/26c17b691de32910c2b7f349c8d551e8afffa38a))
* type taste transport failures ([654b433](https://github.com/NovaLux12/spotify-mcp-server/commit/654b43351b6158e99e78de3adabb7d5fa7565e83))


### Documentation

* add the 2.0 upgrade note and the error-kind vocabulary ([56f37ac](https://github.com/NovaLux12/spotify-mcp-server/commit/56f37acfca81ffc8095fb599e76ceb6be8b91aa8))
* align configuration and endpoint guidance ([216b87d](https://github.com/NovaLux12/spotify-mcp-server/commit/216b87d2c7567be1d7d05458b2e9d000847b54b4))
* align configuration and endpoint guidance ([be14a14](https://github.com/NovaLux12/spotify-mcp-server/commit/be14a14b3828fb3440d28b4591887d6aabce35a4))
* correct taste and stats.fm contracts ([2dfdee4](https://github.com/NovaLux12/spotify-mcp-server/commit/2dfdee4112a4b53099140f95169713c2b10e2237))
* generate live surface and architecture inventory ([22c98a5](https://github.com/NovaLux12/spotify-mcp-server/commit/22c98a5c31ada4fa289eddbf667acc50144cd4b4))
* generate live surface and architecture inventory ([16c75aa](https://github.com/NovaLux12/spotify-mcp-server/commit/16c75aa64bcb356042fe8a3dca8830e5026af9c1))
* generate registry-backed architecture truth ([62ce636](https://github.com/NovaLux12/spotify-mcp-server/commit/62ce636efa1b7e05f01d75b25d08b1da1ede056f))
* link schema budget reference ([61ab3b2](https://github.com/NovaLux12/spotify-mcp-server/commit/61ab3b20e15ad7255c44f1573410e5423cdf0b13))
* make cookbook recipes executable ([acd6d19](https://github.com/NovaLux12/spotify-mcp-server/commit/acd6d1953f0c5b2427f71841b278da454536cb92))
* make the alias table per-tool and record the returned/total count split ([cf49192](https://github.com/NovaLux12/spotify-mcp-server/commit/cf4919290df80b1120a264e5848b028c4f0fa46b))
* make the per-tool alias mapping explicit and fix the list rendering ([8630096](https://github.com/NovaLux12/spotify-mcp-server/commit/8630096501d6985af0346e897d2c88bab11a5b3f))
* refresh architecture after final budget headroom ([94beefc](https://github.com/NovaLux12/spotify-mcp-server/commit/94beefccf160bf8edf900a52e46d58e1ae0843ea))
* regenerate surface census after contract cuts ([623a122](https://github.com/NovaLux12/spotify-mcp-server/commit/623a122511752e2fe07baef8065ecda19f703f9a))


### Tests

* align surface fixtures with live contracts ([b0de802](https://github.com/NovaLux12/spotify-mcp-server/commit/b0de8025591787baa8632349fb30b6a441a61150))
* cover truncation boundary integration ([0f4df36](https://github.com/NovaLux12/spotify-mcp-server/commit/0f4df3609ed280793d01ed2c5b550ee8e718cb3c))
* derive documentation parameter names from registry ([74b7632](https://github.com/NovaLux12/spotify-mcp-server/commit/74b7632b45c2b277ffe29906adff5946c99d0a22))
* harden registry documentation guards ([55941b5](https://github.com/NovaLux12/spotify-mcp-server/commit/55941b5c74d0488206d3970b9b82a3cdaa69571e))
* preserve explicit batch confirmation bypass ([4261522](https://github.com/NovaLux12/spotify-mcp-server/commit/426152216006536c0402c9f158afe3e5ec65fc36))
* preserve playlist health cap coverage ([80e8810](https://github.com/NovaLux12/spotify-mcp-server/commit/80e88104e4cd59f5f58b1038a4333db8afbe0e8c))
* use canonical artist IDs in swarm fixtures ([c2b512f](https://github.com/NovaLux12/spotify-mcp-server/commit/c2b512fa328be631289106709e26a12d1d34c64b))


### Code Refactoring

* complete single-source Spotify references ([8a9f1f6](https://github.com/NovaLux12/spotify-mcp-server/commit/8a9f1f6ce972e550a860a1831b3f75f896ac0b45))
* enforce MCP surface contracts ([06d8cb5](https://github.com/NovaLux12/spotify-mcp-server/commit/06d8cb5478204eb85e4cdaeb4d90e918d8bd2b3a))
* standardize playlist operation contracts ([2c3d0de](https://github.com/NovaLux12/spotify-mcp-server/commit/2c3d0de5012016c91a0312dc364f1338615c7a0d))
* unify Spotify reference contracts ([e311b0b](https://github.com/NovaLux12/spotify-mcp-server/commit/e311b0b7dcb5485d91cacde5eeef133ae2060d95))
* unify Spotify reference contracts ([336a6d1](https://github.com/NovaLux12/spotify-mcp-server/commit/336a6d1e18e4fd490116875130a63c90cb956bb1))

## [1.31.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.30.1...v1.31.0) (2026-09-25)


### Features

* add dry_run preview to follow_artists ([#941](https://github.com/NovaLux12/spotify-mcp-server/issues/941)) ([a7082ac](https://github.com/NovaLux12/spotify-mcp-server/commit/a7082ac78c7bdaf5dbfa7393200e294a73b50c8e)), closes [#933](https://github.com/NovaLux12/spotify-mcp-server/issues/933)
* **quota:** request/quota tracking with pre-flight for heavy scans ([#945](https://github.com/NovaLux12/spotify-mcp-server/issues/945)) ([bf57b13](https://github.com/NovaLux12/spotify-mcp-server/commit/bf57b13f8fe664c9a5fe57ece693759e0cc6c6a9)), closes [#904](https://github.com/NovaLux12/spotify-mcp-server/issues/904)
* **surface:** annotate every tool and gate the surface budget ([#938](https://github.com/NovaLux12/spotify-mcp-server/issues/938)) ([0addf8c](https://github.com/NovaLux12/spotify-mcp-server/commit/0addf8c8e4c33476319367610d564c20f65545b6))
* **toolsets:** fail loud on unknown-only SPOTIFY_MCP_TOOLSETS spec ([#942](https://github.com/NovaLux12/spotify-mcp-server/issues/942)) ([1f6da1f](https://github.com/NovaLux12/spotify-mcp-server/commit/1f6da1fb1f3583e006a0afcd4c64fc7bbae841c3)), closes [#910](https://github.com/NovaLux12/spotify-mcp-server/issues/910)


### Bug Fixes

* **annotations:** fail-closed classification; stop inflating the payload ([#939](https://github.com/NovaLux12/spotify-mcp-server/issues/939)) ([41a9c59](https://github.com/NovaLux12/spotify-mcp-server/commit/41a9c59cf6b95244332fe7a7b08696f944f7d4e4))
* capability-based plan/preview annotations with audited never-mutating set ([#940](https://github.com/NovaLux12/spotify-mcp-server/issues/940)) ([233b1f8](https://github.com/NovaLux12/spotify-mcp-server/commit/233b1f8bf04d3103e0668d6e4457410b57937855))
* **ci:** align Dependabot group schema ([#951](https://github.com/NovaLux12/spotify-mcp-server/issues/951)) ([965427a](https://github.com/NovaLux12/spotify-mcp-server/commit/965427a093d74e2c1276de4fdfce261da8c37a17))
* data-integrity fixes (positional deletes, coverage reader, undo direction) ([#691](https://github.com/NovaLux12/spotify-mcp-server/issues/691)) ([1fceca5](https://github.com/NovaLux12/spotify-mcp-server/commit/1fceca5c528c86e0f2ff5acd0d2b1844bf502ac2))
* **discovery:** make find_tool / inspect_tool / toolset_report read the real registry ([#935](https://github.com/NovaLux12/spotify-mcp-server/issues/935)) ([5f0f132](https://github.com/NovaLux12/spotify-mcp-server/commit/5f0f132af5549c3fac6b8302b9eafa0099c5644b))
* elicitation gate actually gates; SPOTIFY_MCP_READONLY stops leaking writers ([#934](https://github.com/NovaLux12/spotify-mcp-server/issues/934)) ([21bdcd1](https://github.com/NovaLux12/spotify-mcp-server/commit/21bdcd172d7070f2f89f62278d90514abb4a4fc7))
* **v2:** close first correctness and safety wave ([#950](https://github.com/NovaLux12/spotify-mcp-server/issues/950)) ([14b161c](https://github.com/NovaLux12/spotify-mcp-server/commit/14b161c367ba55165817ed48bd9e02a93a6d1e02))


### Documentation

* sync quota tracking and conformance guard into SPEC/ARCH/README/distribution ([#947](https://github.com/NovaLux12/spotify-mcp-server/issues/947)) ([6fb66bf](https://github.com/NovaLux12/spotify-mcp-server/commit/6fb66bf112f90b41ea4c5dcf1db67ac56d0df0bd))
* sync tool counts, dependency versions and env facts with the code ([#937](https://github.com/NovaLux12/spotify-mcp-server/issues/937)) ([de4c0a3](https://github.com/NovaLux12/spotify-mcp-server/commit/de4c0a31c4f4b26e1543aaa6bc9bfeba08375fa4))


### Tests

* **determinism:** remove wall-clock dependence from two time-bombed tests ([#692](https://github.com/NovaLux12/spotify-mcp-server/issues/692)) ([13d7b13](https://github.com/NovaLux12/spotify-mcp-server/commit/13d7b13efb3b6cbdf364e068bbe88029e0d0ebe1))
* **guard:** registry-wide dry_run/response_format conformance guard ([#944](https://github.com/NovaLux12/spotify-mcp-server/issues/944)) ([fe92183](https://github.com/NovaLux12/spotify-mcp-server/commit/fe92183d5f77fcd5a440f0f99e3546c411f7c233))


### Miscellaneous Chores

* **deps-dev:** bump @types/node in the dev-dependencies group ([#563](https://github.com/NovaLux12/spotify-mcp-server/issues/563)) ([ad7088a](https://github.com/NovaLux12/spotify-mcp-server/commit/ad7088ad0c93fd2266872bf22ab3ddf6c5c6c5b9))
* **deps-dev:** bump @types/node in the dev-dependencies group ([#949](https://github.com/NovaLux12/spotify-mcp-server/issues/949)) ([760c3c0](https://github.com/NovaLux12/spotify-mcp-server/commit/760c3c041231e05ce4ef8ef98a74ab1d55ac390c))
* **deps:** bump the dependencies group with 2 updates ([#562](https://github.com/NovaLux12/spotify-mcp-server/issues/562)) ([bdb513c](https://github.com/NovaLux12/spotify-mcp-server/commit/bdb513cbab52d0d5411e97bc18b7a1788c7ee75a))
* **deps:** bump the dependencies group with 2 updates ([#948](https://github.com/NovaLux12/spotify-mcp-server/issues/948)) ([22ae847](https://github.com/NovaLux12/spotify-mcp-server/commit/22ae84786bef02b7f3d4c7416997f35e5cf8af66))

## [1.30.1](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.30.0...v1.30.1) (2026-09-10)


### Bug Fixes

* bump server.json via release-please extra-files ([#561](https://github.com/NovaLux12/spotify-mcp-server/issues/561)) ([5d4f344](https://github.com/NovaLux12/spotify-mcp-server/commit/5d4f344cf0face22c44ff0fc1cd850413535263e))
* sync server.json to 1.30.0 + pin registry metadata in tests ([#559](https://github.com/NovaLux12/spotify-mcp-server/issues/559)) ([1272079](https://github.com/NovaLux12/spotify-mcp-server/commit/1272079eb8b75ec074bafdf2fb4f62674b174346))

## [1.30.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.29.0...v1.30.0) (2026-09-08)


### Features

* **taste:** 11 composite tools toward 600 ([#555](https://github.com/NovaLux12/spotify-mcp-server/issues/555)) ([a3af7f9](https://github.com/NovaLux12/spotify-mcp-server/commit/a3af7f9d687af181b294a6dfa7c600cf90850aae))


### Bug Fixes

* **taste:** resolve nested stats.fm entity names in taste_profile ([#552](https://github.com/NovaLux12/spotify-mcp-server/issues/552)) ([afc9e46](https://github.com/NovaLux12/spotify-mcp-server/commit/afc9e46196202c4e90258ca3a4db95d9d5ad6024))

## [1.29.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.28.2...v1.29.0) (2026-09-05)


### Features

* **statsfm:** 30 read-only stats.fm endpoint tools ([deed7ab](https://github.com/NovaLux12/spotify-mcp-server/commit/deed7ab4e65b06c4db270a7964d01464584cced0))
* **taste:** stats.fm taste-intelligence tools (v2) ([97e6ff4](https://github.com/NovaLux12/spotify-mcp-server/commit/97e6ff47c5a145695ecd3a12633817236ca4e9b2))

> **Note:** Going forward, releases are cut via [release-please](https://github.com/googleapis/release-please)
> from [Conventional Commits](https://www.conventionalcommits.org/). Entries below v1.0.4 were
> backfilled by hand from git history.

## [1.28.2](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.28.1...v1.28.2) (2026-09-04)


### Bug Fixes

* sync release-please manifest with package.json (1.28.1) ([#547](https://github.com/NovaLux12/spotify-mcp-server/issues/547)) ([c380028](https://github.com/NovaLux12/spotify-mcp-server/commit/c3800281373babbc9d8bcefd66bb06bb302598fa))

## [1.26.1](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.26.0...v1.26.1) (2026-08-28)


### Bug Fixes

* **ci:** repair publish.yml — id-token write permission and NODE_AUTH_TOKEN expr were redaction-corrupted to YAML-invalid *** ([#441](https://github.com/NovaLux12/spotify-mcp-server/issues/441)) ([4a4945f](https://github.com/NovaLux12/spotify-mcp-server/commit/4a4945fbc9dd31fb606adba2e6506285077b94fe))

## [1.26.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.25.0...v1.26.0) (2026-08-28)


### Features

* **tools:** swarm3 push — 550 registered tools across 60 modules ([#442](https://github.com/NovaLux12/spotify-mcp-server/issues/442)) ([#442](https://github.com/NovaLux12/spotify-mcp-server/issues/442)) ([ee814a2](https://github.com/NovaLux12/spotify-mcp-server/commit/ee814a2e36cd36b76ec55bbfe66a6b0ee57c3e2b))

## [1.25.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.24.0...v1.25.0) (2026-08-27)


### Features

* **gauntlet:** re-point gated /me/*/contains checks to ungated /me/library/contains ([#330](https://github.com/NovaLux12/spotify-mcp-server/issues/330)) ([#439](https://github.com/NovaLux12/spotify-mcp-server/issues/439)) ([e737feb](https://github.com/NovaLux12/spotify-mcp-server/commit/e737febb5e01e9e3b2706b83f8666c95a46e883d))

## [1.24.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.23.0...v1.24.0) (2026-08-27)


### Features

* **catalog:** exhaust2 catalog slice — 19 typed-search, bundle, and stats tools (closes [#335](https://github.com/NovaLux12/spotify-mcp-server/issues/335), closes [#336](https://github.com/NovaLux12/spotify-mcp-server/issues/336), closes [#337](https://github.com/NovaLux12/spotify-mcp-server/issues/337), closes [#342](https://github.com/NovaLux12/spotify-mcp-server/issues/342), closes [#343](https://github.com/NovaLux12/spotify-mcp-server/issues/343), closes [#344](https://github.com/NovaLux12/spotify-mcp-server/issues/344), closes [#345](https://github.com/NovaLux12/spotify-mcp-server/issues/345), closes [#346](https://github.com/NovaLux12/spotify-mcp-server/issues/346), closes [#347](https://github.com/NovaLux12/spotify-mcp-server/issues/347), closes [#348](https://github.com/NovaLux12/spotify-mcp-server/issues/348), closes [#349](https://github.com/NovaLux12/spotify-mcp-server/issues/349), closes [#350](https://github.com/NovaLux12/spotify-mcp-server/issues/350), closes [#351](https://github.com/NovaLux12/spotify-mcp-server/issues/351), closes [#352](https://github.com/NovaLux12/spotify-mcp-server/issues/352), closes [#353](https://github.com/NovaLux12/spotify-mcp-server/issues/353), closes [#354](https://github.com/NovaLux12/spotify-mcp-server/issues/354), closes [#355](https://github.com/NovaLux12/spotify-mcp-server/issues/355), closes [#356](https://github.com/NovaLux12/spotify-mcp-server/issues/356), closes [#357](https://github.com/NovaLux12/spotify-mcp-server/issues/357)) ([#435](https://github.com/NovaLux12/spotify-mcp-server/issues/435)) ([986c32a](https://github.com/NovaLux12/spotify-mcp-server/commit/986c32a3509ca5ad8338e90d32f938b4b4f0ecb7))
* **enggating:** graceful-403 gating contract for the [#329](https://github.com/NovaLux12/spotify-mcp-server/issues/329) app-registration-gated surface (closes [#428](https://github.com/NovaLux12/spotify-mcp-server/issues/428), closes [#429](https://github.com/NovaLux12/spotify-mcp-server/issues/429)) ([#431](https://github.com/NovaLux12/spotify-mcp-server/issues/431)) ([1541531](https://github.com/NovaLux12/spotify-mcp-server/commit/1541531669b6d160a2e1fc8a5036f40a0b046102))
* **misc:** add 27 exhaust2 tools ([#401](https://github.com/NovaLux12/spotify-mcp-server/issues/401)-[#427](https://github.com/NovaLux12/spotify-mcp-server/issues/427)) ([#433](https://github.com/NovaLux12/spotify-mcp-server/issues/433)) ([f65ba06](https://github.com/NovaLux12/spotify-mcp-server/commit/f65ba06b422f88b7aa401d575d533786d7fd257c))
* **playback:** exhaust2 playback slice — 22 tools (closes [#358](https://github.com/NovaLux12/spotify-mcp-server/issues/358)-[#379](https://github.com/NovaLux12/spotify-mcp-server/issues/379)) ([#432](https://github.com/NovaLux12/spotify-mcp-server/issues/432)) ([00e037c](https://github.com/NovaLux12/spotify-mcp-server/commit/00e037c5c5420794fe03c88f9eadbc5896f81251))
* **playlists:** exhaust2 playlists slice — 18 set-algebra, curation, and analytics tools (closes [#372](https://github.com/NovaLux12/spotify-mcp-server/issues/372), closes [#373](https://github.com/NovaLux12/spotify-mcp-server/issues/373), closes [#374](https://github.com/NovaLux12/spotify-mcp-server/issues/374), closes [#375](https://github.com/NovaLux12/spotify-mcp-server/issues/375), closes [#376](https://github.com/NovaLux12/spotify-mcp-server/issues/376), closes [#377](https://github.com/NovaLux12/spotify-mcp-server/issues/377), closes [#378](https://github.com/NovaLux12/spotify-mcp-server/issues/378), closes [#379](https://github.com/NovaLux12/spotify-mcp-server/issues/379), closes [#380](https://github.com/NovaLux12/spotify-mcp-server/issues/380), closes [#381](https://github.com/NovaLux12/spotify-mcp-server/issues/381), closes [#382](https://github.com/NovaLux12/spotify-mcp-server/issues/382), closes [#383](https://github.com/NovaLux12/spotify-mcp-server/issues/383), closes [#384](https://github.com/NovaLux12/spotify-mcp-server/issues/384), closes [#385](https://github.com/NovaLux12/spotify-mcp-server/issues/385), closes [#386](https://github.com/NovaLux12/spotify-mcp-server/issues/386), closes [#387](https://github.com/NovaLux12/spotify-mcp-server/issues/387), closes [#388](https://github.com/NovaLux12/spotify-mcp-server/issues/388), closes [#389](https://github.com/NovaLux12/spotify-mcp-server/issues/389)) ([#434](https://github.com/NovaLux12/spotify-mcp-server/issues/434)) ([47ef6e0](https://github.com/NovaLux12/spotify-mcp-server/commit/47ef6e04ccb9ce585ab0302f3bf351d7366541bc))
* **playlists:** final three playlists-surface tools — fill-from-search, set-algebra evaluator, cover-from-track (closes [#398](https://github.com/NovaLux12/spotify-mcp-server/issues/398), closes [#399](https://github.com/NovaLux12/spotify-mcp-server/issues/399), closes [#400](https://github.com/NovaLux12/spotify-mcp-server/issues/400)) ([#437](https://github.com/NovaLux12/spotify-mcp-server/issues/437)) ([68a61e4](https://github.com/NovaLux12/spotify-mcp-server/commit/68a61e43d2b0a72e8ed10879e569a29f0e1d9474))

## [1.23.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.22.0...v1.23.0) (2026-08-26)


### Features

* **auth,config,doctor:** auth hardening + scopes/profiles/market/doctor TTL ([#246](https://github.com/NovaLux12/spotify-mcp-server/issues/246)) ([9a8b90e](https://github.com/NovaLux12/spotify-mcp-server/commit/9a8b90e19a7de7a0ba6b5f73dcbc18c0b41b716d))
* **auth:** configurable OAuth scopes via SPOTIFY_SCOPES and auth ([9a8b90e](https://github.com/NovaLux12/spotify-mcp-server/commit/9a8b90e19a7de7a0ba6b5f73dcbc18c0b41b716d))
* **auth:** multi-profile token management via SPOTIFY_MCP_PROFILE and ([9a8b90e](https://github.com/NovaLux12/spotify-mcp-server/commit/9a8b90e19a7de7a0ba6b5f73dcbc18c0b41b716d))
* **catalog:** typed search family + category gaps ([#322](https://github.com/NovaLux12/spotify-mcp-server/issues/322)) ([4c0aa1b](https://github.com/NovaLux12/spotify-mcp-server/commit/4c0aa1bf7aa24d66aec2a1b0b5d8f523b63cdf02))
* **config:** SPOTIFY_MCP_MARKET default-market with arg&gt;env>account> ([9a8b90e](https://github.com/NovaLux12/spotify-mcp-server/commit/9a8b90e19a7de7a0ba6b5f73dcbc18c0b41b716d))
* **doctor:** report token TTL/expiry ETA, refresh_token presence, token ([9a8b90e](https://github.com/NovaLux12/spotify-mcp-server/commit/9a8b90e19a7de7a0ba6b5f73dcbc18c0b41b716d))
* **exhaust-misc:** mop-up 10 tools to close 60/60 sweep (search_within_playlist, history stats, audiobook progress + 7 deferred) ([#323](https://github.com/NovaLux12/spotify-mcp-server/issues/323)) ([636e247](https://github.com/NovaLux12/spotify-mcp-server/commit/636e2478c7ebe83a14b2fa3f7246b4d1a8497658))
* **exhaust-remnants:** close final 14 gaps to 95/95 (265-267,301-307,311-314) ([#324](https://github.com/NovaLux12/spotify-mcp-server/issues/324)) ([f2eee0f](https://github.com/NovaLux12/spotify-mcp-server/commit/f2eee0f0fc08eb6f16b7d553de7e1cef48724438))
* **library,playlists,smart:** library/smart/discovery cluster ([#236](https://github.com/NovaLux12/spotify-mcp-server/issues/236) [#234](https://github.com/NovaLux12/spotify-mcp-server/issues/234) [#229](https://github.com/NovaLux12/spotify-mcp-server/issues/229) [#225](https://github.com/NovaLux12/spotify-mcp-server/issues/225) [#219](https://github.com/NovaLux12/spotify-mcp-server/issues/219) [#237](https://github.com/NovaLux12/spotify-mcp-server/issues/237)) ([#244](https://github.com/NovaLux12/spotify-mcp-server/issues/244)) ([e81d6f3](https://github.com/NovaLux12/spotify-mcp-server/commit/e81d6f38b0496032d6487c71a6b1cc449fd042ab))
* **playback:** exhaustive playback/queue/player intel — 15 tools ([#320](https://github.com/NovaLux12/spotify-mcp-server/issues/320)) ([a579b64](https://github.com/NovaLux12/spotify-mcp-server/commit/a579b6407aafa349a70d3dc81f5a2ca78ed12e5b))
* **playlists/library/following:** exhaustive sweep — 18 tools ([#284](https://github.com/NovaLux12/spotify-mcp-server/issues/284)-[#297](https://github.com/NovaLux12/spotify-mcp-server/issues/297) + saved-search trio) ([#319](https://github.com/NovaLux12/spotify-mcp-server/issues/319)) ([f25eb90](https://github.com/NovaLux12/spotify-mcp-server/commit/f25eb9031fab1367479dab8ebfba6f1690fa8a38)), closes [#285](https://github.com/NovaLux12/spotify-mcp-server/issues/285) [#286](https://github.com/NovaLux12/spotify-mcp-server/issues/286) [#287](https://github.com/NovaLux12/spotify-mcp-server/issues/287) [#288](https://github.com/NovaLux12/spotify-mcp-server/issues/288) [#289](https://github.com/NovaLux12/spotify-mcp-server/issues/289) [#290](https://github.com/NovaLux12/spotify-mcp-server/issues/290) [#291](https://github.com/NovaLux12/spotify-mcp-server/issues/291) [#292](https://github.com/NovaLux12/spotify-mcp-server/issues/292) [#293](https://github.com/NovaLux12/spotify-mcp-server/issues/293) [#294](https://github.com/NovaLux12/spotify-mcp-server/issues/294) [#295](https://github.com/NovaLux12/spotify-mcp-server/issues/295) [#296](https://github.com/NovaLux12/spotify-mcp-server/issues/296)
* **portability:** profile portability cluster — fixes + exports + resources ([#240](https://github.com/NovaLux12/spotify-mcp-server/issues/240) [#238](https://github.com/NovaLux12/spotify-mcp-server/issues/238) [#223](https://github.com/NovaLux12/spotify-mcp-server/issues/223) [#220](https://github.com/NovaLux12/spotify-mcp-server/issues/220) [#218](https://github.com/NovaLux12/spotify-mcp-server/issues/218)) ([#245](https://github.com/NovaLux12/spotify-mcp-server/issues/245)) ([33d05e2](https://github.com/NovaLux12/spotify-mcp-server/commit/33d05e29c8c6267cbbd3d0c3126e5f643a4cf4d6))
* **quota:** dry_run + quota disclosure for coverage, duplicates, backup, export ([#255](https://github.com/NovaLux12/spotify-mcp-server/issues/255)) ([628ff9f](https://github.com/NovaLux12/spotify-mcp-server/commit/628ff9f13a6b1b46de21050defd4201d9a9715d8))


### Bug Fixes

* **auth:** callback server binds dual-stack for localhost redirects; ([9a8b90e](https://github.com/NovaLux12/spotify-mcp-server/commit/9a8b90e19a7de7a0ba6b5f73dcbc18c0b41b716d))
* exhaustive portability/analytics/resources/prompts (sweep P0-P2) ([#321](https://github.com/NovaLux12/spotify-mcp-server/issues/321)) ([391754a](https://github.com/NovaLux12/spotify-mcp-server/commit/391754aa59c7c6e31fe7a8b395036246ce498ea7))
* **freshness:** budget, quota recovery and watermark hold ([#243](https://github.com/NovaLux12/spotify-mcp-server/issues/243)) ([2b04285](https://github.com/NovaLux12/spotify-mcp-server/commit/2b042853a4b361ff765c6d7a99697c2e17f94b43))
* **queue,episodes:** remove 4 phantom tools, add save_queue_as_playlist, shared ID resolver, music_briefing prompt ([#248](https://github.com/NovaLux12/spotify-mcp-server/issues/248)) ([a4bdf73](https://github.com/NovaLux12/spotify-mcp-server/commit/a4bdf73d46c22023ec028662e298f1e1f2cc4854))
* **quota:** budget, dry_run and quota recovery for showradar + artistwatch ([#249](https://github.com/NovaLux12/spotify-mcp-server/issues/249) [#250](https://github.com/NovaLux12/spotify-mcp-server/issues/250)) ([#254](https://github.com/NovaLux12/spotify-mcp-server/issues/254)) ([34f3665](https://github.com/NovaLux12/spotify-mcp-server/commit/34f3665bfe682fd3bf41877297c2c69373a97bea))
* **safety:** safety/receipts/readonly/undo/backup cluster ([#241](https://github.com/NovaLux12/spotify-mcp-server/issues/241) [#233](https://github.com/NovaLux12/spotify-mcp-server/issues/233) [#235](https://github.com/NovaLux12/spotify-mcp-server/issues/235) [#217](https://github.com/NovaLux12/spotify-mcp-server/issues/217) [#216](https://github.com/NovaLux12/spotify-mcp-server/issues/216)) ([#247](https://github.com/NovaLux12/spotify-mcp-server/issues/247)) ([0f41271](https://github.com/NovaLux12/spotify-mcp-server/commit/0f4127107e905dbce2e1b84d2425339053e67eb0))

## [1.22.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.21.0...v1.22.0) (2026-08-26)


### Features

* big-release 1.22 — 30 issues, 154 tools (orchestrated) ([#213](https://github.com/NovaLux12/spotify-mcp-server/issues/213)) ([99ecaeb](https://github.com/NovaLux12/spotify-mcp-server/commit/99ecaeb5656d25471fd230a14e357646bc4b6db9))


### Bug Fixes

* trio [#195](https://github.com/NovaLux12/spotify-mcp-server/issues/195) docs drift + [#196](https://github.com/NovaLux12/spotify-mcp-server/issues/196) backup scope gate + [#210](https://github.com/NovaLux12/spotify-mcp-server/issues/210) import 404 probe ([#211](https://github.com/NovaLux12/spotify-mcp-server/issues/211)) ([5c25dff](https://github.com/NovaLux12/spotify-mcp-server/commit/5c25dffb7b697fb09a7f8b4610fdfddaca6ef656))

## [1.21.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.20.0...v1.21.0) (2026-08-26)


### Features

* **playlists:** clean_all_playlists — account-wide duplicate cleanup ([#171](https://github.com/NovaLux12/spotify-mcp-server/issues/171)) ([#174](https://github.com/NovaLux12/spotify-mcp-server/issues/174)) ([60c2368](https://github.com/NovaLux12/spotify-mcp-server/commit/60c236859e26539d34dfa0d05486f94f0bb29207))
* **playlists:** create_smart_playlist — rule-based generation from own data ([#172](https://github.com/NovaLux12/spotify-mcp-server/issues/172)) ([#176](https://github.com/NovaLux12/spotify-mcp-server/issues/176)) ([2f6510f](https://github.com/NovaLux12/spotify-mcp-server/commit/2f6510f408a41767110ddf390edfcbd4f7984f18))
* **shows:** show_new_episodes — radar across saved podcast shows ([#173](https://github.com/NovaLux12/spotify-mcp-server/issues/173)) ([#177](https://github.com/NovaLux12/spotify-mcp-server/issues/177)) ([5b8c261](https://github.com/NovaLux12/spotify-mcp-server/commit/5b8c261ac1e17fd1e45f9635986ed5d3deff058b))

## [1.20.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.19.0...v1.20.0) (2026-08-26)


### Features

* **playlists:** remove_duplicate_playlist_items — one-shot duplicate cleanup ([#168](https://github.com/NovaLux12/spotify-mcp-server/issues/168)) ([#169](https://github.com/NovaLux12/spotify-mcp-server/issues/169)) ([c14bc10](https://github.com/NovaLux12/spotify-mcp-server/commit/c14bc10d74a26efe6cd02c7153896e2c31ee26bb))

## [1.19.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.18.0...v1.19.0) (2026-08-26)


### Features

* **dedupe:** optional playlist_id cross-reference in find_duplicate_saved_tracks ([#161](https://github.com/NovaLux12/spotify-mcp-server/issues/161)) ([#163](https://github.com/NovaLux12/spotify-mcp-server/issues/163)) ([7404ade](https://github.com/NovaLux12/spotify-mcp-server/commit/7404ade0de01e43d84e9ccf2be9ddaeeb5851a62))
* **import:** import_playlist — restore M3U/CSV documents into a playlist ([#165](https://github.com/NovaLux12/spotify-mcp-server/issues/165)) ([#166](https://github.com/NovaLux12/spotify-mcp-server/issues/166)) ([b6752e1](https://github.com/NovaLux12/spotify-mcp-server/commit/b6752e119f0565c2267466e10042019c2fb3a124))

## [1.18.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.17.0...v1.18.0) (2026-08-26)


### Features

* **backup:** backup_library + list_backups local library snapshots ([#159](https://github.com/NovaLux12/spotify-mcp-server/issues/159)) ([d69932d](https://github.com/NovaLux12/spotify-mcp-server/commit/d69932dcf918515686525c64e4d464b92ffcb0f6))
* **restore:** restore_library_snapshot — strictly additive snapshot restore ([#160](https://github.com/NovaLux12/spotify-mcp-server/issues/160)) ([9efadff](https://github.com/NovaLux12/spotify-mcp-server/commit/9efadff9f4f0ee4acd9dce40d30c3990451ab244))
* wire backup_library/list_backups + restore_library_snapshot into the server ([6c473c1](https://github.com/NovaLux12/spotify-mcp-server/commit/6c473c11910abb205727ba873657a3f0636689c4))

## [1.17.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.16.1...v1.17.0) (2026-08-26)


### Features

* **#155:** export_playlist — M3U/CSV export of full playlist item lists ([bfb9bff](https://github.com/NovaLux12/spotify-mcp-server/commit/bfb9bff6b537ceccbc1dfb4fc623cd7195d38ea2))
* **playlists:** elicit-confirm visibility flips toward public in update_playlist ([#157](https://github.com/NovaLux12/spotify-mcp-server/issues/157)) ([fdc2815](https://github.com/NovaLux12/spotify-mcp-server/commit/fdc2815f4054748be0ba9f1291e3cd1beeb314d9))
* **tools:** add find_duplicate_saved_tracks read-only dedupe tool ([#156](https://github.com/NovaLux12/spotify-mcp-server/issues/156)) ([1c63b82](https://github.com/NovaLux12/spotify-mcp-server/commit/1c63b822c74e452bfce978c28daf8948bda1ee97))
* wire export_playlist + find_duplicate_saved_tracks into the server ([8096c79](https://github.com/NovaLux12/spotify-mcp-server/commit/8096c798e37a01925b8413303812b90a64459354))


### Bug Fixes

* actually register export_playlist + find_duplicate_saved_tracks ([bcae236](https://github.com/NovaLux12/spotify-mcp-server/commit/bcae236d73a8646665175d04954f7d732ee52d8d))
* scope gates on export/dedupe registrations (parity with all other modules) ([3acd24d](https://github.com/NovaLux12/spotify-mcp-server/commit/3acd24d3e5410b4c6c639641eccec0db99b6861a))

## [1.16.1](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.16.0...v1.16.1) (2026-08-26)


### Bug Fixes

* **#111 item 5:** elicitation capability check read the wrong accessor ([9fc51c9](https://github.com/NovaLux12/spotify-mcp-server/commit/9fc51c96704c306a2ce701e313fd48b3f3845df3))

## [1.16.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.15.0...v1.16.0) (2026-08-26)


### Features

* **#133/#112 follow-up:** direction-aware mutation receipts ([80a8cb9](https://github.com/NovaLux12/spotify-mcp-server/commit/80a8cb9f5d62fd2edfea26c439c287349cea62c9))

## [1.15.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.14.0...v1.15.0) (2026-08-26)


### Features

* **#112 idea 11 completion:** wire mutation receipts into the unified library tools ([6966773](https://github.com/NovaLux12/spotify-mcp-server/commit/696677349aa841c83694a17606c9e855ea1e30f6))

## [1.14.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.13.0...v1.14.0) (2026-08-26)


### Features

* **#110 finding 11:** harmonize check-tool output shapes ([9fae097](https://github.com/NovaLux12/spotify-mcp-server/commit/9fae0973f2d92969017fc08539d3ae433af723e1))


### Bug Fixes

* drop semantically-wrong saved alias from check_following_artists rows ([6d64784](https://github.com/NovaLux12/spotify-mcp-server/commit/6d6478419f90edcef1718f3f6e40a81e65a52c53))
* restore the check_in_library tool-name line consumed by the description edit ([b43b0ce](https://github.com/NovaLux12/spotify-mcp-server/commit/b43b0ce07351932ba48895a6e0791e58cb34f4b6))

## [1.13.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.12.0...v1.13.0) (2026-08-26)


### Features

* elicitation-gated confirmation for destructive playlist ops ([#111](https://github.com/NovaLux12/spotify-mcp-server/issues/111) item 5) ([5abafb7](https://github.com/NovaLux12/spotify-mcp-server/commit/5abafb75a8ec1b3d37a196e5616f7b3b26d8a695))

## [1.12.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.11.0...v1.12.0) (2026-08-26)


### Features

* **#111:** SPOTIFY_MCP_READONLY mode — write-capable modules hidden on demand ([0a73e15](https://github.com/NovaLux12/spotify-mcp-server/commit/0a73e15f94cc63ab015869cc90a4631167987975))

## [1.11.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.10.0...v1.11.0) (2026-08-26)


### Features

* **#133:** waiter aging — LOW tasks promoted after 15s to prevent walk starvation ([41a2b81](https://github.com/NovaLux12/spotify-mcp-server/commit/41a2b81cb1545517b78ced2d0a5914be7c6f1d00))

## [1.10.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.9.0...v1.10.0) (2026-08-26)


### Features

* **#133:** two-lane request scheduler — interactive reads drain before bulk walks ([301517e](https://github.com/NovaLux12/spotify-mcp-server/commit/301517eeea752876b5402af5b6ce1f0ecd05005a))

## [1.9.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.8.0...v1.9.0) (2026-08-26)


### Features

* **auth:** persist auth-time scopes; add scopefilter for scope-aware module hiding ([#111](https://github.com/NovaLux12/spotify-mcp-server/issues/111) item 6) ([9da8bfa](https://github.com/NovaLux12/spotify-mcp-server/commit/9da8bfa74ea5602065b996eb8156fa5aa13463b5))
* **toolsets:** per-tool opt-in/opt-out layered on toolsets ([#111](https://github.com/NovaLux12/spotify-mcp-server/issues/111) item 7) ([42d97b6](https://github.com/NovaLux12/spotify-mcp-server/commit/42d97b6ae488a0fa2c1f457ce73e7525c205b30b))
* wire wave-9 — scope-aware hiding + per-tool opt-in/opt-out ([9de646f](https://github.com/NovaLux12/spotify-mcp-server/commit/9de646f2f77d82a96ae9043b0b22ee33d177a479))


### Bug Fixes

* **#110:** final polish — audit prompt uses find_duplicates; honest queue pagination ([0a931f1](https://github.com/NovaLux12/spotify-mcp-server/commit/0a931f1751dc2664f302cb5467e9b48e3b520dca))

## [1.8.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.7.0...v1.8.0) (2026-08-26)


### Features

* **doctor:** spotify_doctor diagnostic tool ([#111](https://github.com/NovaLux12/spotify-mcp-server/issues/111) idea 9) ([310ccb1](https://github.com/NovaLux12/spotify-mcp-server/commit/310ccb1b52cd06f5b68af77308a4b9211ad04584))
* **tools:** add library_hygiene — album completion & consolidation analysis ([#112](https://github.com/NovaLux12/spotify-mcp-server/issues/112) idea 5) ([ddbcb59](https://github.com/NovaLux12/spotify-mcp-server/commit/ddbcb59585a840a9a80ce66bbd60bad3f45095d8))
* wire wave-8 — library hygiene, spotify_doctor tool, ergonomics batch ([09ddffc](https://github.com/NovaLux12/spotify-mcp-server/commit/09ddffcd4b02b23c8c30e9a92311cbb21cccedfa))


### Bug Fixes

* **#110:** normalize market params, disambiguate now-playing tools, typed additional_types, cursor hint, split play offset errors ([158ab5c](https://github.com/NovaLux12/spotify-mcp-server/commit/158ab5c21efd94740f2f9ed9e3b30972df484d89))

## [1.7.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.6.0...v1.7.0) (2026-08-26)


### Features

* **analytics:** listening_report tool ([#97](https://github.com/NovaLux12/spotify-mcp-server/issues/97)) ([0acf487](https://github.com/NovaLux12/spotify-mcp-server/commit/0acf4876a91d0ad406cf2b2481605c4654a2f60f))
* integrate wave-7 — listening analytics + auth hardening; repair lost wiring ([7b9cacc](https://github.com/NovaLux12/spotify-mcp-server/commit/7b9caccb16ffdbb43c173b496a983d976ed54148))


### Bug Fixes

* **auth:** atomic token persistence, refresh race guard, failure classification ([#109](https://github.com/NovaLux12/spotify-mcp-server/issues/109)) ([1c31e84](https://github.com/NovaLux12/spotify-mcp-server/commit/1c31e8476494a17df8e9d1facce8e576f200f38a))

## [1.6.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.5.0...v1.6.0) (2026-08-25)


### Features

* **prompts:** add triage_liked_songs prompt ([#112](https://github.com/NovaLux12/spotify-mcp-server/issues/112) idea 8) ([c26e7a9](https://github.com/NovaLux12/spotify-mcp-server/commit/c26e7a94c3a47c75341d0eb04b25b5967c6599bc))


### Bug Fixes

* **#110:** structuredContent contract breaks + explicit fetch_all semantics ([b31ca33](https://github.com/NovaLux12/spotify-mcp-server/commit/b31ca33af5d75d56f22e1f4497de5d9b4dbd57a2))

## [1.5.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.4.0...v1.5.0) (2026-08-25)


### Features

* **#111:** argument completions for show/episode resource templates ([90b0197](https://github.com/NovaLux12/spotify-mcp-server/commit/90b0197bffd109df679ca9f47c6d2e512b7d1ac5))
* **receipts:** mutation receipts with post-mutation verification ([#112](https://github.com/NovaLux12/spotify-mcp-server/issues/112) idea 11) ([1bd6e5c](https://github.com/NovaLux12/spotify-mcp-server/commit/1bd6e5cdc2cb5105f8ba182cf5dc46a9242fc2eb))
* **tools:** grow_playlist — Playlist DNA co-occurrence curation ([#112](https://github.com/NovaLux12/spotify-mcp-server/issues/112) idea 6) ([d1677a7](https://github.com/NovaLux12/spotify-mcp-server/commit/d1677a7b12880b0c940b0ad985522fac88bb70e5))


### Bug Fixes

* **#110:** standardise playlist-ID params on playlist_id with id alias ([4b92dec](https://github.com/NovaLux12/spotify-mcp-server/commit/4b92dec286143cd7c25b74746cb268d0ff5d07dc))

## [1.4.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.3.0...v1.4.0) (2026-08-25)


### Features

* **#110:** dry_run coverage for all mutating playlist tools ([edd3515](https://github.com/NovaLux12/spotify-mcp-server/commit/edd3515d59928ac89b7c63e20b1cb374c5eb171d))
* **podcast:** podcast session composer tools ([#112](https://github.com/NovaLux12/spotify-mcp-server/issues/112) idea 3) ([609f6ec](https://github.com/NovaLux12/spotify-mcp-server/commit/609f6ec116df8be0a9d9f18265cf91f1b5f06df2))
* **resources:** RFC-6570 resource templates over single-get catalog endpoints ([a4ccf46](https://github.com/NovaLux12/spotify-mcp-server/commit/a4ccf46d676ebf2c7216ee9c2167030b01cd0f2f))
* **scenes:** named playback scenes + in-process wind-down fade ([#112](https://github.com/NovaLux12/spotify-mcp-server/issues/112) ideas 7+12) ([12ebd99](https://github.com/NovaLux12/spotify-mcp-server/commit/12ebd994bb45474b203d6b6c46ac0878b67b7f1a))
* **tools:** audiobook chapter copilot ([#112](https://github.com/NovaLux12/spotify-mcp-server/issues/112) idea 4) ([e7e88ac](https://github.com/NovaLux12/spotify-mcp-server/commit/e7e88ac06116b928d79c5fe97d50efb8988754a9))
* wire wave-4 modules into server startup ([ce8d0e4](https://github.com/NovaLux12/spotify-mcp-server/commit/ce8d0e488c4a22780828ddda18170aa78a58ee25))

## [1.3.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.2.1...v1.3.0) (2026-08-25)


### Features

* **#112:** handoff tool — lossless device move preserving track position ([1c6bc57](https://github.com/NovaLux12/spotify-mcp-server/commit/1c6bc574196d7c96186f36f3e254784d5b551717))
* **#95:** add TOOLSETS registry with resolveToolsets/isActive/toolsetEnvHelp ([6efdf0e](https://github.com/NovaLux12/spotify-mcp-server/commit/6efdf0e921a1cbe5b6235d381e1d5a5bbda00600))
* **#95:** wire SPOTIFY_MCP_TOOLSETS into server startup ([df02eaa](https://github.com/NovaLux12/spotify-mcp-server/commit/df02eaac5c00e21490dbbb5b6fdc403c014ce669))
* codify live gauntlet — full-tool live sweep with mutation proof ([f384cf9](https://github.com/NovaLux12/spotify-mcp-server/commit/f384cf985dbf18b56169777c0ed7dde07eba1c5d))
* **library-insights:** sidecar genre tags + library report/filter tools ([#112](https://github.com/NovaLux12/spotify-mcp-server/issues/112) idea 1) ([bfab550](https://github.com/NovaLux12/spotify-mcp-server/commit/bfab5505429c93df247be484fe2a8a39f7e0fe9d))
* **search:** add search_deep paged search tool ([128dcef](https://github.com/NovaLux12/spotify-mcp-server/commit/128dcef3c3318e39943a1621c8cc35bc91352405))
* **tools:** add merge_playlists, diff_playlists, overlap_playlists ([#96](https://github.com/NovaLux12/spotify-mcp-server/issues/96)) ([d551bfd](https://github.com/NovaLux12/spotify-mcp-server/commit/d551bfdd91d191bd5c402be3a8a22bf3ec1e3ced))
* whats_new freshness radar tool ([#112](https://github.com/NovaLux12/spotify-mcp-server/issues/112) idea 2) ([84b3643](https://github.com/NovaLux12/spotify-mcp-server/commit/84b364310cc0d5a56138f1d335395035bd4609a1))


### Bug Fixes

* **#108:** differentiate QUOTA_EXCEEDED from burst 429s; cap in-queue sleep ([9d8865f](https://github.com/NovaLux12/spotify-mcp-server/commit/9d8865f544827fcc8ec709d2a73b720043ff6bfe))
* **#95:** use Object.hasOwn for known-set lookup; add prototype-name test ([4c9b7b2](https://github.com/NovaLux12/spotify-mcp-server/commit/4c9b7b26b9dadf5033036c5e8347e774a67ea4e0))
* **#96:** adopt Feb-2026 playlist item shape ('item'); wire into playlists toolset ([8859967](https://github.com/NovaLux12/spotify-mcp-server/commit/885996724b972bee01f8bb54c80f1e1f25ff52ce))
* **ci:** pin @modelcontextprotocol/sdk; idempotent npm publish ([68e8a2a](https://github.com/NovaLux12/spotify-mcp-server/commit/68e8a2a88a6342437d1e83fa8e8b04d455137069))
* **platform:** artist-albums limit hard-capped at 10 (Feb 2026) ([ced75fa](https://github.com/NovaLux12/spotify-mcp-server/commit/ced75fadd55b31b4157aeff67b8b12ea14ec026c))
* **platform:** playlist items nest under 'item', not 'track' (Feb 2026) ([675e400](https://github.com/NovaLux12/spotify-mcp-server/commit/675e400ed2fd11f4cb1085b570bb598a4861eed8))
* **security:** supply-chain + file-permission hardening (SecReview findings) ([9342533](https://github.com/NovaLux12/spotify-mcp-server/commit/9342533bba3d85117fd62cc5a29686764949b3b2))

## [1.2.1](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.2.0...v1.2.1) (2026-08-25)


### Bug Fixes

* **registry:** correct MCP Registry namespace casing; add mcpName linkage ([7515eab](https://github.com/NovaLux12/spotify-mcp-server/commit/7515eab51378414779f4bdf493ffd8f04e90f27b))

## [1.2.0](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.1.1...v1.2.0) (2026-08-25)


### Features

* **distribution:** MCP Registry publishing, Smithery manifest, npm release wiring ([7cc7b79](https://github.com/NovaLux12/spotify-mcp-server/commit/7cc7b79c8edd49620c0a70c14cd2489c30fd1476))


### Bug Fixes

* **platform:** align with Spotify's February 2026 Web API changes ([6b66d35](https://github.com/NovaLux12/spotify-mcp-server/commit/6b66d35ffa978ebf14f2eb3d4a66a68217f000b9))
* **tools:** dry_run previews for create/save tools; id alias for playlist reads ([32b1c2d](https://github.com/NovaLux12/spotify-mcp-server/commit/32b1c2d2acef42468408736a9d71c4ef93002c3d))

## [1.1.1](https://github.com/NovaLux12/spotify-mcp-server/compare/v1.1.0...v1.1.1) (2026-08-25)


### Bug Fixes

* **client:** wire TTL cache reads + mutation history; docs sweep for v1.1.0 ([69bf757](https://github.com/NovaLux12/spotify-mcp-server/commit/69bf757894067b4c8e7ab535ef6241191763db29))

## [1.1.0] — 2026-08-25

Audit-closure release shipping every finding from the 2026-08-25 full audit,
organised into three epics: [#31 — endpoint parity](https://github.com/NovaLux12/spotify-mcp-server/issues/31),
[#32 — MCP experience](https://github.com/NovaLux12/spotify-mcp-server/issues/32),
[#33 — bug + security batch](https://github.com/NovaLux12/spotify-mcp-server/issues/33).
Registered tools grew from ~50 to 69; the test suite grew from 123 to 346 tests;
resources from 7 fixed URIs to 11 plus a paginated playlist template with JSON
variants; prompts from 4 to 9.

### Security

- **Reflected HTML injection (XSS) in the OAuth callback error page fixed (#19)** —
  every interpolated value (`error`, `error_description`, state) is HTML-escaped
  before being rendered into the response ([#19](https://github.com/NovaLux12/spotify-mcp-server/issues/19)).
- **Fetch timeouts on every outbound HTTP call (#11)** — raw API requests and token
  exchange/refresh now carry an `AbortSignal.timeout` (default 30 s, override with
  `SPOTIFY_REQUEST_TIMEOUT_MS`), so a hung connection can no longer stall the
  serialized request queue indefinitely ([#11](https://github.com/NovaLux12/spotify-mcp-server/issues/11)).

### Added — endpoint parity (#34–#50, #67)

- `follow_artists` / `unfollow_artists` — complete the artist-follow loop using the
  already-granted `user-follow-modify` scope; up to 50 IDs per call via query params
  ([#34](https://github.com/NovaLux12/spotify-mcp-server/issues/34),
  [#35](https://github.com/NovaLux12/spotify-mcp-server/issues/35)).
- Library tools accept `spotify:audiobook:` URIs, routed to `/me/audiobooks` with
  ids as query params ([#36](https://github.com/NovaLux12/spotify-mcp-server/issues/36)).
- New unified-library tools `save_to_library` / `remove_from_library` /
  `check_in_library` on the non-deprecated `/me/library` endpoints (any mix of
  track/album/episode/show/audiobook URIs; contains also covers artist); legacy
  per-type tools kept working ([#37](https://github.com/NovaLux12/spotify-mcp-server/issues/37)).
- `get_artist_top_tracks` with market support and graceful 403 handling
  ([#38](https://github.com/NovaLux12/spotify-mcp-server/issues/38));
  `get_available_markets` ([#49](https://github.com/NovaLux12/spotify-mcp-server/issues/49)).
- `get_several_*` batch family — tracks, albums, artists, episodes, shows,
  audiobooks, chapters — with per-type caps (50, albums 20) and automatic chunking
  through the rate-limited queue ([#43](https://github.com/NovaLux12/spotify-mcp-server/issues/43)).
- `get_user_profile` and paginated `get_user_playlists_by_id` in a new users module
  ([#39](https://github.com/NovaLux12/spotify-mcp-server/issues/39),
  [#40](https://github.com/NovaLux12/spotify-mcp-server/issues/40)).
- `replace_playlist_items` (atomic overwrite, >100 URIs chunked as PUT + appends)
  ([#41](https://github.com/NovaLux12/spotify-mcp-server/issues/41)); standalone
  paginated `get_playlist_items` on the non-deprecated `/items` path with
  `market`/`fields`/`additional_types` ([#42](https://github.com/NovaLux12/spotify-mcp-server/issues/42)).
- Playlist mutation precision: returned `snapshot_id` surfaced on add/remove/reorder/
  replace; optional `snapshot_id` input targets a specific version on removal; per-URI
  `positions[]` removes a single occurrence of duplicated tracks
  ([#50](https://github.com/NovaLux12/spotify-mcp-server/issues/50)).
- Search: `audiobook` type added (US/UK/CA/IE/NZ/AU markets)
  ([#44](https://github.com/NovaLux12/spotify-mcp-server/issues/44)), `offset`
  param and limit cap raised to the API maximum of 50
  ([#45](https://github.com/NovaLux12/spotify-mcp-server/issues/45)),
  `include_external=audio` passthrough ([#46](https://github.com/NovaLux12/spotify-mcp-server/issues/46)).
- Parameter completeness: `market` + `offset` on artist-albums, `market` on album
  and album-tracks lookups, `offset` on top tracks/artists
  ([#47](https://github.com/NovaLux12/spotify-mcp-server/issues/47));
  `market` and `additional_types` exposed on now-playing/currently-playing reads
  ([#48](https://github.com/NovaLux12/spotify-mcp-server/issues/48)).

### Added — MCP experience (#51–#62, #63–#65)

- Shared `response_format` option (`concise` | `detailed` | `json`) on every tool;
  `json` returns the raw API object, `detailed` surfaces fields the prose drops
  (popularity, release dates, restrictions, publishers…)
  ([#51](https://github.com/NovaLux12/spotify-mcp-server/issues/51)).
- Machine-readable `structuredContent` with pagination info (`total`,
  `next_offset`) on all list-type outputs
  ([#52](https://github.com/NovaLux12/spotify-mcp-server/issues/52)).
- Truncation controls: shared `max_results` param with an `SPOTIFY_MCP_MAX_ITEMS`
  env default and a "(N more — pass offset or fetch_all)" footer
  ([#53](https://github.com/NovaLux12/spotify-mcp-server/issues/53)).
- Cross-request TTL cache (~5 min LRU) for immutable catalog reads, bypassed for
  player/top/recently-played/mutations — fewer 429s in agentic loops
  ([#54](https://github.com/NovaLux12/spotify-mcp-server/issues/54)).
- Fetch-all cap configurable via `SPOTIFY_MCP_FETCH_ALL_CAP` instead of hardcoded
  500 ([#55](https://github.com/NovaLux12/spotify-mcp-server/issues/55)).
- Rate-limit visibility: post-throttle status lines, enriched errors carrying
  `retryAfterSec` after retry exhaustion, and a `spotify://me/rate-limit` resource
  ([#56](https://github.com/NovaLux12/spotify-mcp-server/issues/56)).
- `dry_run` mode on destructive operations (removals, unfollows, playback overwrites):
  validates inputs and previews exactly what would change with zero mutating calls
  ([#57](https://github.com/NovaLux12/spotify-mcp-server/issues/57)).
- Confirmation-friendly batch summaries on mutations ("N items affected: uri0,
  uri1…") ([#58](https://github.com/NovaLux12/spotify-mcp-server/issues/58)).
- Resources: saved albums/shows/episodes, templated paginated
  `spotify://playlist/{id}/tracks`, and `?format=json` variants for programmatic
  consumers ([#59](https://github.com/NovaLux12/spotify-mcp-server/issues/59)).
- Prompts: five new (`playlist_audit`, `listening_recap`, `migrate_library`,
  `podcast_catchup`, `artist_deep_dive`) referencing real tool names; existing
  prompts parameterized with optional `time_range`/`size` args
  ([#60](https://github.com/NovaLux12/spotify-mcp-server/issues/60)).
- Consolidated `SPOTIFY_MCP_*` config family documented in README +
  docs/configuration.md + fresh `.env.example`
  ([#61](https://github.com/NovaLux12/spotify-mcp-server/issues/61)).
- `spotify-mcp doctor` subcommand: resolved config, token expiry/state, live
  authenticated `/me` probe ([#62](https://github.com/NovaLux12/spotify-mcp-server/issues/62)).
- Duplicate-aware playlists: `find_duplicates_in_playlist` (exact-URI and relinked
  name+artist grouping with positions) and opt-in `check_duplicates` pre-check on
  `add_to_playlist` ([#63](https://github.com/NovaLux12/spotify-mcp-server/issues/63)).
- Opt-in session history JSONL under `~/.spotify-mcp/history` recording
  who/what/snapshot_id for mutations (strict field whitelist, never tokens);
  enabled via `SPOTIFY_MCP_HISTORY` ([#64](https://github.com/NovaLux12/spotify-mcp-server/issues/64)).
- MCP progress notifications emitted per page during multi-page walks so hosts no
  longer show long fetches as hung ([#65](https://github.com/NovaLux12/spotify-mcp-server/issues/65)).

### Fixed

- Shows library saves/removes sent IDs as a JSON body where `/me/shows` requires
  `?ids=` query params — writes silently no-op'd (#12).
- Rejected token-load promise cached forever, pinning "Not authenticated" after
  successful re-auth until restart (#13).
- Callback server ignored the port in `SPOTIFY_REDIRECT_URI` and always bound 8888 (#14).
- `get_recently_played` crashed on null track entries (#15); search formatter
  crashed on null items[] rows (#16).
- Pagination: `fetch_all` restarted near offset 0 when resuming mid-list (#17);
  `getAllPages` truncated to one page when responses omitted `total` (#22);
  offset-resume math made absolute by the #67 refactor onto `getAllPages`.
- `spotify://player/state` resource crashed on non-track/non-episode items such as
  ads (#18); `spotify://me/playlists` claimed all playlists but returned one page —
  now fully paginated (#27).
- Garbage `Retry-After` headers produced NaN, permanently disabling backoff —
  parsed defensively with sane fallback (#20).
- `client.get()` threw a raw SyntaxError on non-JSON 200 bodies — now throws a
  descriptive `SpotifyApiError`, consistent with `post()` (#21).
- `play` accepted >100 uris and empty-uris bypassed the context mutual-exclusion
  check (#23); numeric offset validated against artist contexts (#24).
- `remove_from_playlist` rejected at the schema level above the API's 100-URI cap (#25).
- `public=true` + `collaborative=true` combination rejected up front (#26).
- `play_from_search` forwarded no market and could play null rows — market passed
  through, nulls skipped (#28).
- Audiobook/chapter/show/episode lookups gained market fallback for market-gated
  accounts (#29).
- Code hygiene: unreachable not-found guards removed or made ID-bearing, dead
  deprecated-endpoint types deleted, catalog errors preserve status + Spotify's own
  message instead of generic replacements (#30).
- `check_saved_items` cap raised from 40 to the API maximum of 50 (#66).

## [1.0.3] — 2026-08-24

Package health + README accuracy (`f9d06a5`).

### Added

- `publishConfig.access: "public"` declared explicitly for the scoped npm package.
- `engines` field pinning Node `>=22.9`.

### Fixed

- README library section corrected: save/remove/check operations are partitioned
  by type to `/me/tracks|albums|shows|episodes(/contains)` rather than the unified
  `/me/library` endpoints.

## [1.0.2] — 2026-08-24

Ten confirmed bug fixes from issue triage (#1–#10) (`8350cfd`, fix commit `1d10d11`). Test suite updated to assert corrected contracts.

### Fixed

- Null guards: `Array.isArray` check on `artist.genres` in catalog/resources tools (#1, #8).
- `post()` client method handles non-JSON `200` responses — `/me/player/queue` returns text/plain (#2).
- MCP server version read from `package.json` instead of hardcoded `1.0.0` (#3).
- `publisher ?? 'unknown publisher'` fallbacks in library/search/catalog output (#4).
- Library save/remove/check partitioned by URI type to `/me/tracks|albums|shows|episodes(/contains)` instead of the non-existent-per-type `/me/library` usage (#5).
- `check_following_artists` corrected to `/me/following/contains?type=artist&ids=…` instead of `/me/library/contains` (#6).
- `ugc-image-upload` scope added so playlist cover upload works (#7).
- Null-device guard for `get_now_playing` tool and `spotify://player/state` resource when no device is active (#8).
- `play` rejects `context_uri` combined with `uris` up front instead of surfacing an API 400 (#9).
- `fetch_all` pagination forces `limit=50` instead of the API default of 20, roughly 2.5× fewer requests per full fetch (#10).

## [1.0.1] — 2026-08-23

CLI ergonomics (`3a26ea7`).

### Added

- `--help` / `-h` flag printing usage, subcommands, and environment variables.
- `--version` / `-v` flag printing the installed version from `package.json`.

## [1.0.0] — 2026-08-23

Initial scoped-npm publication as `@novalux12/spotify-mcp` (`bcffd3f`; launch-prep commit `f5dcf1d`, tagged `v1.0.0`).

### Added

- Package renamed/published to the `@novalux12/spotify-mcp` scope; docs switched from the stale npx name.
- Live E2E harness (`scripts/live-e2e.mjs`): real-account MCP-over-stdio verification against live Spotify.
- `skills/spotify-mcp-doctor`: procedural troubleshooting skill for agents.
- README: Command for AI agents, OpenClaw config how-to, npx staleness note.
- `package.json`: honest description, NovaLux12 repository URL, `--env-file-if-exists` (fresh-clone safe); docs aligned to Node 22.9+.
- Premium requirement, pagination cap, and audiobook market gating disclosed in docs (`8636d2f`).
- Rebrand as NovaLux12/spotify-mcp-server with MIT license and acknowledgements (`e9c3567`).

[Unreleased]: https://github.com/NovaLux12/spotify-mcp-server/compare/v1.2.1...HEAD
[1.1.0]: https://github.com/NovaLux12/spotify-mcp-server/compare/v1.0.3...v1.1.0
[1.0.3]: https://github.com/NovaLux12/spotify-mcp-server/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/NovaLux12/spotify-mcp-server/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/NovaLux12/spotify-mcp-server/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/NovaLux12/spotify-mcp-server/releases/tag/v1.0.0
