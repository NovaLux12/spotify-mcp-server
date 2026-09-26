# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
