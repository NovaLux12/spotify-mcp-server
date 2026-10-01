/**
 * MCP tool annotations (#565 / A0-002, A4-005).
 *
 * Before this module, 0 of 608 tools carried `annotations`, so a host could not
 * tell `get_track` (safe read) from `remove_duplicate_playlist_items` (destroys
 * playlist rows) and had to either prompt for everything or nothing. The SDK
 * projects `annotations` straight from its registry and exposes
 * `registeredTool.update({ annotations })` — so classification is applied once,
 * after registration, from this table rather than at 500+ call sites.
 *
 * Classification is FAIL-CLOSED: a tool is read-only only when its name starts
 * with an allowlisted non-mutating verb AND does not start with a mutating one —
 * except for the plans and previews listed in NEVER_MUTATING_PLANS below. Name
 * suffixes alone prove nothing: most `dry_run`-carrying `*_plan` tools accept a
 * commit path, so a new plan/preview tool defaults to "write" until someone
 * verifies its handler and adds it to that set. Anything unknown advertises as
 * a write and the host keeps its confirmation.
 *
 * Wire cost is kept low on purpose (the host pays it every session):
 *  - read-only tools emit `{ readOnlyHint: true }` (+ `idempotentHint` when true);
 *  - destructive tools emit `{ destructiveHint: true }`;
 *  - other writes emit `{ destructiveHint: false }`, because MCP's default for
 *    `destructiveHint` is TRUE — omitting it would advertise `save_to_library`
 *    as dangerous as `remove_saved_items`;
 *  - no `title` (hosts fall back to the tool name; duplicating it cost ~25 KB).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { StatsfmApiError } from '../lib/statsfm-client.js';
import { readOnlyEnv, legacyAliasesEnv } from '../config.js';
// Tool modules are NOT imported here (#906). The manifest below names each
// one and loads it through a thunk, so a module whose registration key is
// inactive is never evaluated. A static `import { registerXTools }` would
// force evaluation of all 71 modules before the toolset gate could answer —
// which is why trimming the surface used to shrink the payload without
// shrinking startup or RSS. See RegistrarSpec and loadManifestRegistrars.
import { formatReceipt, MAX_RECEIPTS, RECEIPT_ID_PATTERN, RECEIPT_ID_SHAPE, receiptMissMessage, verifyReceipt } from '../receipts.js';
import { z } from 'zod';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  type CallToolResult,
  type ServerResult,
} from '@modelcontextprotocol/sdk/types.js';
import { isTaskCapable, startTask, type PersistentTaskStore } from '../tasks.js';
import { getObjectShape, getSchemaDescription, safeParseAsync, type AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { finalInputSchema, finalOutputSchema, OUTPUT_SCHEMA_FAMILIES, outputSchemaFamilyForModule, type OutputSchemaFamily, PROSE_ONLY_MODULES, PENDING_OUTPUT_SCHEMA_MODULES, RETIRED_PLAYLIST_INPUTS, retiredInputMessage, retiredInputsOnCall, resolveLegacyToolAlias, retiredToolAliasMessage, retiredWalkCapMessage, retiredWalkCapOnCall, resolveStatsfmUserInput, withPlaylistInputMetadata, withPlaylistInputNote, STATSFM_USER_INPUT, STATSFM_LEGACY_USER_INPUT, resolveRetiredQueueTool, retiredQueueToolMessage, resolveRetiredToolForward, retiredToolForwardNote, normalizeDeprecatedInputs, deprecatedInputResolution, type PlaylistInputResolution } from '../shaping.js';
import { SpotifyApiError, isTokenFailureReason, CANCELLED_STATUS } from '../client.js';
import { trustedCustomMessage } from '../custom-issues.js';
import { encodingPlanFor, type EncodingPlan } from './encoding.js';

/**
 * v2 registry policy (#909/#918). Prefix allowances are a frozen baseline, not
 * a target: a new family gets the default budget of three, while these legacy
 * entity/verb families are allowed to shrink but never to grow silently.
 */
export const TOOL_SURFACE_BUDGET = Object.freeze({
  defaultMaxTools: 620,
  // Raised 600_000 -> 601_000 (2026-09-26) for the `include_track_features`
  // disclosure on `artist_collab_network`, then -> 602_000 (2026-09-27) when
  // #979 and #791 together added ~904B more legitimate disclosure, then
  // -> 603_000 (2026-09-27) for the batch landing #821/#773/#839 — the
  // discovery-walk cap disclosure, the `peek_error` field, and the
  // sidecar-corruption `load_error`/`preserved_as` pair. Measured cost of
  // that batch over 602,000: +1,015B, of which the decorative-clause trim on
  // four `swarm3b_discovery` descriptions gave back 250B inside the same edit.
  //
  // Then -> 604_000 (2026-09-26) TWICE, by two independent raises that landed
  // on the same figure from branches cut before the other merged, so the
  // aggregate they actually produce is the sum, not either measurement alone:
  //   #827 moved the seven mutating tools in `exhaust2_misc.ts` onto the shared
  //        `DryRunDefault` fragment. +602B (23,264B -> 23,866B), measured both
  //        against the aggregate and against the per-module delta.
  //   #688 rewrote `verify_receipt`'s description and `receipt_id` pattern.
  //        +330B, of which ~210B is the sentence telling the agent that
  //        receipts are session-scoped and lost on restart. That sentence is
  //        the fix: an agent that does not know the store is process-local will
  //        treat a receipt it can no longer look up as evidence about the
  //        mutation, which is the exact failure #688 reports.
  // Each was measured against a 603,999B base, so neither number survives the
  // merge on its own. Measured after merging both: 604,906B — slightly under
  // the 603,999 + 602 + 330 = 604,931B the arithmetic predicts, because #688
  // also rewrote a description whose neighbours shifted. Re-measure rather than
  // trusting either this line or the sum.
  //
  // Then -> 607_000 (2026-09-26) once, as a single explicitly sized raise for
  // the whole in-flight wave rather than a per-PR one. The two raises above were
  // each legitimate but both sized against a base that excluded the other, so
  // they collided: 604,906B landed with 94B left, which is not headroom, it is
  // a trap for the next agent who adds a real sentence. Several PRs were in
  // flight at once, each measuring its own delta in isolation, so none could see
  // the collision coming and the repo had no way to accept all of them. The
  // lesson is that this budget is a SHARED resource and per-branch measurement
  // cannot price it; only a single measurement of the merged tree can.
  //
  // WARRANT — every open branch at the time of writing, each delta measured
  // per-module and confirmed against the aggregate:
  //   #827  +602B — publishes the `dry_run` default on seven mutating tools.
  //         The one that matters most: without it a host cannot tell a preview
  //         from a commit, and `discover_weekly_diff` with `save_after` and no
  //         `dry_run` replaced a playlist's entire contents with no preview and
  //         no confirmation.
  //   #713  +399B — makes `response_format` do what its schema already promised
  //         on find_tool / inspect_tool / toolset_report.
  //   #884  +647B — market / fields / additional_types on get_playlist, verified
  //         against the OpenAPI schema. Also fixes a loop that ignored the
  //         caller's `offset` and silently re-read the head of a playlist.
  //   #781  +226B — declares the `offset` the paging signal depends on, so a
  //         `next_offset` is actionable rather than advisory.
  //   #901  +105B — states the fail-fast when artist top-tracks is gated.
  //   #688  +330B — receipts are session-scoped and lost on restart. (Already
  //         landed in main; listed because it is part of the same accounting.)
  //   #782  +960B — `market` on `show_new_episodes`, `plan_podcast_session` and
  //         `start_podcast_session`, all three reads being market-gated. Without
  //         the parameter an account outside Spotify's default market silently
  //         loses episode rows, and a shorter list reads as "no more episodes".
  //         Measured on the merged tree this branch rebased onto, not against
  //         the older base its own PR quoted, so the whole cost is absorbed by
  //         the 607,000B already granted above and this PR needs no raise of its
  //         own. The per-module baselines move to the measured 1967B and 3427B.
  //         (Its draft quoted the aggregate as 579,136B. The measured figure on
  //         the tree carrying #1004 and this wave is 607,715B over the same 592
  //         tools — the smaller number is missing the ~27KB of names, titles,
  //         annotations and execution metadata the aggregate gate actually
  //         budgets. Both cleared 608,000B, the ceiling of that day, so neither
  //         moved it; the figure is corrected only so the next author is not
  //         quoted 27KB of headroom that does not exist.)
  //   #1004 +136B — the three tools that read artists had to re-quote their
  //         request quota now that `GET /artists?ids=` is gone, so each
  //         describes the per-id `GET /artists/{id}` fan-out it actually
  //         performs and discloses the requests it made (exhaust2catalog
  //         19,176 -> 19,241 and swarm3analytics 18,880 -> 18,951 per module,
  //         +65 and +71). Measured on a 603,999B base like the two raises
  //         above, so it is in the same accounting and not a separate raise:
  //         its branch proposed 604,000, which this 607,000 supersedes.
  //   Total ~3,405B. 604,000 -> 607,000 is +3,000B against the warrants known
  //   when it was granted: a ~30% margin, which is the discipline this file
  //   exists to enforce. The first raise in this history was 19x its warrant;
  //   this is deliberately not that.
  //
  //   Sizing note for the next author: measure the aggregate BEFORE promising a
  //   number in prose, and measure it on the MERGED tree. Two independent
  //   measurements in this file's own history were each arithmetically right
  //   and jointly wrong, because each was taken on a tree missing the other
  //   branch. A per-branch estimate is not a substitute, however carefully it
  //   is derived.

  // Read the numbers below before sizing another raise; AGENTS.md §3 requires
  // this record to be accurate about host-session payload impact, and my first
  // attempt at that record was wrong in three ways (see "CORRECTIONS").
  //
  // WHAT IS MEASURED: `collectAggregateSurfaceMeasurement` serialises each tool
  // as {name, title, description, inputSchema, annotations, execution, _meta} and
  // budgets the total. It is NOT a {description, inputSchema}-only figure — the
  // per-module baselines (`serializedSchemaBytes`, description + inputSchema
  // only) sum to ~532KB against a measured aggregate of 602KB. The difference
  // (~70KB, 11.5% of the budgeted payload) is tool names, titles, annotations
  // and execution metadata. Size future raises against the AGGREGATE number.
  //
  // WARRANT: +524B for `include_track_features`, then +914B across #979 (the
  // four falsified-value fixes, whose whole point is honest disclosure) and
  // #791 (the graceful-403 contract), then +602B for #827 and +136B for #1004.
  // Total +2,176B of real disclosure across five changes; every byte of it buys
  // a sentence that stops a tool asserting something false about its own
  // result — or, in #827's case, publishing the `dry_run` default so a host can
  // tell a preview from a commit without probing the handler. #827's +602B is
  // the `dry_run` fragment swap across seven tools plus the
  // `discover_weekly_diff` description naming the archive replace it performs.
  //
  // HEADROOM: the enforced limit is `defaultMaxBytes + 1_000` (that 1KB covers
  // final MCP annotation metadata added after registration), so the real
  // ceiling is that constant plus the allowance named on the line above. Both
  // halves are live, and neither is restated here: read the constant for the
  // ceiling and the generated `aggregate-budget` block in
  // `docs/schema-budgets.md` for the measured payload and the headroom, because
  // the census re-measures that block on every `--check` and nothing re-measures
  // a number typed here. This paragraph outlived the ceiling it used to name,
  // which is the whole argument for that arrangement. What it does preserve is
  // the history — the wave this raise was sized for had landed and then
  // some: measured on the tree carrying #1004 and the whole wave (592 tools),
  // 607,715B — 285B of headroom against the ceiling of that day, which is not
  // headroom.
  //
  // Read that as the successor to the 94B trap that forced the 607,000 raise in
  // the first place: that figure was 94B, and the honest conclusion then was
  // that the budget is a shared resource that per-branch measurement cannot
  // price. The wave has now spent it again, without a single PR asking to.
  // #1004's own warrant is +136B, so raising for it here would be a ~7x raise
  // against its warrant — the same reflex this file exists to prevent, and the
  // first raise in its history was 19x. So this change does NOT raise the
  // ceiling. It records the exhaustion instead, which is the cheaper half of
  // the rule: the next honest sentence lands in a conversation with whoever
  // owns the surface, rather than discovering the ceiling in a failed
  // startup.
  //
  // 607,715B is a measurement on the MERGED tree, not an estimate: build the
  // registry the way `src/index.ts` does and call
  // `collectAggregateSurfaceMeasurement`; `assertAggregateSurfaceBudget` puts
  // the measured byte count in its error message if you lower the limit to
  // force one. Every figure in this file that was computed rather than
  // measured has been wrong at least once — including, on the sibling #782,
  // one that was low by ~27KB, and the "measured 603,100B" line above, which
  // was high by ~900B. Re-measure; do not trust the numbers in prose.
  //
  // #1004's own branch proposed 604_000, sized against a 603,999B base that
  // predated this whole wave. The 607_000 raise supersedes it — the merged
  // aggregate fitted under the 608,000B of that day without it — so its cost
  // is recorded above as a warrant line, not as a second raise.
  //
  // WHY A WARRANT WAS NEEDED AT ALL (#1004). The record written with the
  // 603,000 raise said "measured 603,100B"; by the time #1004 was cut, later
  // PRs had taken the real figure to 603,999B — one byte under the 604,000B
  // ceiling that `defaultMaxBytes: 603_000` implies. A budget whose stated
  // headroom has silently evaporated breaches on the next honest sentence, so
  // build the registry the way `src/index.ts` does and call
  // `collectAggregateSurfaceMeasurement` before trusting any number in this
  // comment; `assertAggregateSurfaceBudget` puts the measured byte count in its
  // error message if you lower the limit to force one.
  //
  // A breach should still land in a conversation, not be pre-authorised. The
  // right first move is to reclaim bytes from decorative prose in the same edit
  // that needs them, exactly as the 603,000 batch did when it took 250B back
  // out of four `swarm3b_discovery` descriptions — disclosure that prevents a
  // wrong answer is worth its bytes, but prose that only restates the schema is
  // not.

  //
  // WARRANT #713: +399B, the whole cost of honouring `response_format` in the
  // discovery trio. `toolset_report` gained a declared `response_format` and
  // all three discovery tools now describe their own modes instead of promising
  // a "raw API object" they never produce. Measured, not estimated: the
  // `swarm3meta` per-module figure moves 1,624 -> 2,023 (+399B, tool count
  // unchanged at 3) and the aggregate moves by the same +399B. Fits under the
  // existing 605,000B ceiling with ~270B to spare, so this raise needs no
  // budget change of its own — recorded because a later author measuring the
  // delta against `swarm3meta` should find the arithmetic already done.
  //
  // WARRANT #866: +130B, spent entirely on stating that
  // `move_items_between_playlists` in mode=move removes exactly the transferred
  // occurrences rather than every repeat of the track. A caller that does not
  // know this cannot tell a deliberate repeat from a lost one. This supersedes
  // the 604,434B / 605,000B state the branch recorded against a pre-wave
  // ceiling; the gate below is the authority on whether it still fits.
  // WARRANT #836: the playback family published no `dry_run` default at all, so
  // a host reading `tools/list` could not tell an omitted flag from an explicit
  // `false`. #827 established preview-by-default for the mutating tools it
  // touched; an agent that learned that rule could therefore carry it across
  // the family boundary and believe an omitted `dry_run` previews when it in
  // fact commits. #836 rolls the playback mutations onto `PlaybackDryRun` (see
  // `shaping.ts`), which publishes `"default": false` and names the commit
  // semantics in the field description. The cost is ~16B of JSON key per tool
  // (~736B across the family) plus the rewritten descriptions.
  //
  // Those bytes ARE the fix, and that is the reason this warrant reads
  // differently from the ones above: this is the first entry whose warrant is a
  // schema field a host actually reads rather than prose describing a
  // behaviour the schema already carried.
  //
  // COST RECORD, NOT A RAISE. #836 needs no ceiling of its own: the aggregate
  // it lands on already sits inside what the SWEEP-2026-09 grant above stands
  // behind, which is a grant sized for the queue rather than for any single
  // warrant. An earlier cut of this branch raised 607,000 -> 609,000 on its own
  // +1,097B warrant; that raise was withdrawn once the sweep grant landed,
  // because a second raise for bytes a grant already covers is exactly the
  // reflex the CORRECTIONS note below is about. The measured deltas are kept
  // here because they are the per-family record, and they are what a future
  // reclaim-first pass should target.
  //
  // Measured per module via `surface-census --check`, never summed from
  // per-tool estimates, and re-measured after each merge rather than carried
  // over from a pre-rebase branch: exhaust2playback 17,306 -> 17,683B (+377),
  // playback 12,287 -> 12,635B (+348), playbackintel 11,663 -> 11,837B (+174),
  // playbackext 8,033 -> 8,178B (+145), queueops 3,449 -> 3,536B (+87), scenes
  // 4,456 -> 4,514B (+58), and swarm3playback 14,247 -> 14,155B (-92).
  // swarm3playback SHRINKS because it drops a private default-true fragment for
  // the shared one; the six that grow are paying for a `default` key they
  // previously did not publish at all. Those baselines are hand-maintained in
  // the manifest below.
  //
  // CORRECTIONS to my first record of this raise, kept because the next author
  // should not repeat them: the headroom figure ignored the +1_000 derivation;
  // the justification described a {description, inputSchema}-only budget when
  // 11.5% of the payload is not that; and the first raise was 19x its warrant
  // (+10,000B against a +524B need), which is precisely the reflex this budget
  // exists to prevent.
  //
  // WARRANT #807: +64B, the `analytics` per-module baseline moving
  // 2,753 -> 2,817 (tool count unchanged at 4). It is the sentence in
  // `taste_shift_report`'s own description stating that `jaccard` is null when
  // both windows of a domain are empty — without it a host reading a null has
  // to guess whether the tool broke or there was simply nothing to compare.
  // This needs no raise of its own: it was authored against a 604,000B ceiling
  // and lands well inside the 607,000B this file now carries.
  //
  // WARRANT SWEEP-2026-09: +13,000B, a standing grant covering the remainder of the
  // v2 backlog sweep rather than any single warrant.
  //
  // Measured on this tree at b8fa661 by driving `dist/index.js` over stdio and
  // byte-counting the real `tools/list` response — the same path the production
  // registry uses, NOT a reconstruction from census JSON:
  //
  //   607,715B against the 608,000B enforced ceiling = 285B of headroom.
  //
  // 285B is not headroom. The smallest warrants open at the time were #898 at
  // +344B and #900 at +452B — both since closed — so the next two changes to
  // land would have breached a startup tripwire for reasons unrelated to
  // themselves. The ceiling had stopped being a constraint and become a coin
  // flip that happened to land green.
  //
  // A NOTE ON MEASURING THIS, because it has already gone wrong twice: a figure
  // derived by re-serialising the census's `toolDefinitions` came out at
  // 606,986B — 729B LOW, because that reconstruction omits part of what the gate
  // actually budgets. Two agents measuring independently got 607,291B and
  // 607,579B on nearby commits. Only the stdio figure is authoritative. This is
  // the CORRECTIONS note above happening again, so: measure through the real
  // registry, never by re-summing a tool that was meant to be a convenience.
  //
  // Sized against the queue, not against ambition: work is still queued, and
  // the ones that add prose do so because they add *disclosure* — a sentence
  // telling a host that a walk was truncated, or that a receipt was unreadable.
  // 13,000B is roughly 30 warrants at the observed median delta.
  //
  // NO TALLY, and that is a decision rather than an omission (#1350). This
  // sentence used to carry an approximate count of open issues, which was
  // already wrong by the time it was written and could only rot further: the
  // count is a property of the tracker, not of this tree, so nothing here
  // re-derives it and no gate can. The argument it supported — queued work
  // lands as *disclosure*, and disclosure is what the aggregate ceiling is
  // sized for — survives the deletion intact, and a tally was the one part
  // that could not be kept true.
  //
  // This does not weaken the gate. `perToolMaxBytes` and every
  // per-module ceiling are unchanged and do the fine-grained work, and the
  // aggregate ceiling has a small surplus over the surface rather than a wide
  // one — measured headroom is the surplus, not a percentage of it, because a
  // percentage is the derived figure that decays (#1350). The alternative is
  // startups failing for reasons unrelated to the change that caused them,
  // which is the failure mode a startup tripwire exists to prevent.
  //
  // WHY THE % DETECTOR WAS NOT ADDED, because the two sentences above are
  // exactly what a wider net would have been for (#1350). `live-constant-comment
  // .test.ts` matches a byte figure beside a constant name, and a byte unit is
  // required, so no percentage can match — the defect is real and the fix above
  // is not optional. But widening `BYTE_FIGURE` with a `%` arm was measured on
  // this tree before being declined, and it fails on both counts:
  //
  //   1. IT STILL MISSES THE DEFECT IT WAS ADDED FOR. A % arm only matches
  //      `FIGURE_FLOOR` (1,000) and above, and a percentage is structurally
  //      below that floor — there is no percentage in common use that reaches
  //      it. Re-run with the floor removed, it still misses: the arm fires on a
  //      percentage only when the *numerator* equals a live constant, and the
  //      numerator of the figure that motivated the change is not one. The
  //      defect it was added for is the one defect it would never have caught.
  //   2. WHAT IT CATCHES INSTEAD IS ARITHMETIC COINCIDENCE. With the floor
  //      removed it adds eight hits, every one a small integer colliding with an
  //      unrelated constant: `0%` against `Math.max(0, …)`, `60%` against a
  //      `seconds < 60` bound, `10%` and `1%` against roundings and a
  //      `127.0.0.1` literal. Each would need an ALLOWED entry, which is the
  //      allowlist-growth trap the gate's own docs warn about.
  //
  // So the gate keeps its scope and the prose stops quoting what the gate cannot
  // police. If someone still wants the wider net, the burden is to show it
  // catches a real defect without an allowlist that swallows the class — the
  // measurement above says a `FIGURE_FLOOR`-respecting arm cannot, because
  // percentages are structurally below the floor.
  //
  // Two queued changes will move this the other way and should be re-measured
  // rather than assumed: #908 drops eight `taste_*` alias registrations, and
  // #889 defaults to a curated core surface. If either lands, take the surplus
  // back rather than carrying a ceiling sized for a surface that no longer
  // exists.
  //
  // REPAID (#908 + #889). #908 dropped the eight legacy `taste_*` alias
  // registrations, measured on a real stdio `tools/list` of the `all` surface:
  // 602,553B -> 594,005B, so the eight aliases were worth 8,548B.
  // `defaultMaxBytes` is 620,000 -> 611,000, which puts the enforced ceiling at
  // 612,000B and headroom back where it was before the aliases were carried:
  // 17,995B, 2.94%, against 18,447B / 2.97% on the tree that granted the
  // 13,000B sweep allowance above. That allowance is spent and is not revived
  // by this edit. (The tool counts behind both figures are in
  // `docs/schema-budgets.md`, generated; the byte figures are what this ceiling
  // is reasoned about, so they are the ones written here.) RE-MEASURED after
  // rebasing onto the current main, which had moved the surface under the first
  // measurement: 585,201B through this gate's own projection
  // (`collectAggregateSurfaceMeasurement`, the same number startup enforces),
  // so the headroom is 26,799B rather than the 17,995B the pre-rebase tree
  // gave. The surplus grew because main removed tools; it is not spent here,
  // and taking it back below what the surface actually needs would just move
  // the failure to a future edit.
  //
  // #889 flips the DEFAULT surface, which buys a host that starts the server
  // with no env 585,201B -> 139,718B (both measured on the post-rebase tree
  // through this gate's own projection). It does NOT move this number, and the
  // reason matters: the census and this gate both measure the surface the
  // session actually registered, and `SPOTIFY_MCP_TOOLSETS=all` still
  // registers the whole registry. The default flip is paid for by the startup
  // log line, not by a ceiling. A curated default that let `all` keep running
  // was the point — a
  // default that broke the full surface would be a removal, not a default.
  //
  // Reclaim-first remains the rule for any single edit. This grant is for the
  // queue; it is not a licence to spend 13,000B on one warrant.
  // WARRANT #866: +112B, the `playlistbatch` baseline moving 4,784 -> 4,896
  // (tool count unchanged at 3). It is the sentence in
  // `move_items_between_playlists`' own description stating that mode=move
  // removes exactly the transferred occurrences, addressed by playlist
  // position, rather than every repeat of the track — without it a host
  // reading the result cannot tell a deliberate repeat from a lost one.
  //
  // Reclaim-first is the rule and it is honoured here: the sentence said the
  // same thing twice ("leaving any other copy of the same track in the source"
  // -> "leaving any other copy in the source"), which is why the warrant is
  // +112B rather than the +130B it was first measured at. What remains lands
  // inside the SWEEP-2026-09 grant above, so this branch raises no ceiling of
  // its own and the aggregate gate keeps every per-tool and per-module ceiling
  // it had.
  // `defaultMaxBytes` no longer describes a *default* surface: since #889 the
  // default is the curated `core` set, measured at 139,718B, which this ceiling
  // is nowhere near. What it bounds is the LARGEST surface a session can
  // register — `SPOTIFY_MCP_TOOLSETS=all` at 585,201B. Read it as "the full
  // surface, with headroom", not "the default".
  //
  // WARRANT #1592: +1,898B for `clean_backup_artifacts`, measured on the
  // merged origin/main this branch cut from, and measured as a DELTA — the
  // absolute tool counts live in the generated `aggregate-budget` block in
  // docs/schema-budgets.md, which the census re-measures on every --check, and
  // are not restated here. The tool is 744B of description and 1,009B of
  // inputSchema, and +1,898B on the aggregate including the
  // name/annotation/execution metadata the aggregate charges and the per-module
  // figure does not. The per-module figure is deliberately not written here: it
  // is a live baseline in this same file, and a comment that quotes a live
  // constant is a comment that reads as a fact long after it stops being one.
  //
  // What those bytes buy, in the order a caller needs them: which four name
  // shapes this tool owns and under which directory; that library backups and
  // their `.meta.json` sidecars are refused here and belong to `delete_backup`;
  // that the files are local and unrecoverable; that preview is the default and
  // executing needs a prompt the client may not be able to raise; that the age
  // floor is a mtime rather than a recorded date; and that the retention window
  // is a different env var from the library one. Every one of those is a
  // sentence whose absence produces a wrong action — deleting a library backup
  // believing it is an artifact, or believing an artifact was never eligible.
  //
  // Reclaim-first was considered and not taken, deliberately. The rule exists
  // to stop decorative prose being paid for out of a shared budget, and there
  // is no decorative prose in this edit to reclaim: the prose being added is
  // the contract. The honest reclaim targets are four `swarm3b_discovery`
  // descriptions, which belong to a different change and would make this PR's
  // diff unreadable against its own subject. A caller can price that trim
  // separately; what this warrant is for is stated above, in bytes, measured.
  //
  // 611,000 -> 613,500 is +2,500B against a 1,898B warrant — roughly a 30%
  // margin, the same discipline the 604_000 -> 607_000 grant used and the one
  // this file exists to enforce. The first raise in this history was 19x its
  // warrant; the 94B-headroom trap recorded above is what a raise sized to the
  // last byte produces, and this is not that. Sizing note for the next author
  // unchanged and still load-bearing: measure the AGGREGATE, and measure it on
  // the MERGED tree, because two raises in this file's history were each
  // arithmetically right and jointly wrong.
  // 613,500 -> 620,000 is +6,500B (#1620).
  //
  // ## Why
  //
  // The opt-in surface had **1,021B** of headroom against a measured **908B**
  // per gated tool (the 11 tools behind SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS
  // contribute 9,988B). So the next gated tool of typical size is roughly 0.9x
  // the entire remaining headroom, and crossing it fails SERVER STARTUP for
  // anyone running with the flag on — not a CI failure, and not on the default
  // path, so the default-surface run stays green the whole way.
  //
  // That is the failure mode this budget exists to prevent, arriving from the
  // other side: the gate is not too lax, it is out of room. +6,500B buys about
  // seven gated tools at the measured average, which is a working margin rather
  // than a raise sized to the next commit.
  //
  // ## What it costs
  //
  // This is a deliberate trade and is recorded as one. A larger opt-in ceiling
  // costs context for the users who opt in: 6,500B is ~1.6k tokens, on a
  // surface already at ~613kB. The DEFAULT surface is untouched — this ceiling
  // is only reached by a process that sets the analytics flag, and the
  // default-surface headroom (~11kB) is unaffected.
  //
  // The warrant discipline above still holds and is why this is not larger:
  // measured on the MERGED tree, not predicted, and sized for several tools
  // rather than for the next one. The 94B-headroom trap recorded earlier in
  // this file is what a raise sized to the last byte produces.
  defaultMaxBytes: 620_000,
  perToolMaxBytes: 6_000,
  coreMaxTools: 200,
  coreMaxBytes: 220_000,
  defaultPrefixBudget: 3,
  prefixBudgets: Object.freeze({
    // `delete` sits at the default budget of 3 (delete_scene, delete_playback_bookmark,
    // delete_playlist_snapshot). Raised to 4 deliberately for `delete_backup` (#697) rather
    // than renaming the tool into a fresh verb family: the budget table exists to force this
    // decision to be visible, not to be routed around. The tool unlinks a file the user cannot
    // recover, so its name should say what it does.
    album: 8, apply: 4, artist: 35, check: 6, delete: 4, episode: 5, export: 10,
    // `list` 11 -> 12 for `list_accounts` (#602), then 12 -> 13 for
    // `list_lanes` (#727). The budget table exists to make this decision
    // visible rather than to route around it, and the decision is the same
    // both times: a registry listing belongs in the `list` family with the
    // other reads beside it. It IS a read, it answers "what is here", and a
    // new verb family for one tool would cost a host a prefix to learn.
    // `list_lanes` reads the lane manifest and issues one
    // `GET /playlists/{id}` per lane — the same read cost as the
    // `list_scenes` / `list_backups` registry listings above it.
    // `statsfm` 38 -> 39 for `statsfm_jukebox` (#726). Same decision as the
    // `list` raise above: the tool reads a stats.fm account and refreshes a
    // Spotify playlist from it, so `statsfm_` is what it does and a new verb
    // family for one tool would cost a host a prefix to learn. The budget table
    // exists to make that choice visible, not to be routed around.
    filter: 4, find: 11, get: 59, library: 8, list: 13, listening: 17,
    play: 4, playback: 4, playlist: 54, queue: 8, remove: 9, restore: 4,
    save: 11, saved: 11, search: 22, set: 4, show: 8, snapshot: 12,
    split: 5, statsfm: 39, taste: 16, top: 6, track: 4, uri: 4,
  }),
});


const LEGACY_BANNED_PREFIXES: Readonly<Record<string, true>> = Object.freeze({
  normalize: true, format: true, make: true, archive: true, prune: true, trim: true,
});

/** Existing names retained only until their owning modules can be migrated. */
export const LEGACY_NAMING_EXCEPTIONS: Readonly<Record<string, true>> = Object.freeze({
  archive_played_episodes: true,
  format_spotify_uri: true,
  normalize_spotify_uri: true,
  make_spotify_uri: true,
  prune_old_snapshots: true,
});

export type ToolClassification = 'read' | 'write';

export interface ToolNamingMetadata {
  name: string;
  prefix: string;
  prefixBudget: number;
  classification: ToolClassification;
}

export function toolNamingMetadata(name: string): ToolNamingMetadata {
  const prefix = name.split('_', 1)[0] ?? name;
  const budget = (TOOL_SURFACE_BUDGET.prefixBudgets as Record<string, number>)[prefix]
    ?? TOOL_SURFACE_BUDGET.defaultPrefixBudget;
  return {
    name,
    prefix,
    prefixBudget: budget,
    classification: classifyToolAnnotations(name).readOnlyHint === true ? 'read' : 'write',
  };
}

/** Fail startup when a newly registered name violates the frozen v2 policy. */
export function assertToolNamingPolicy(toolNames: Iterable<string>): void {
  const counts = new Map<string, number>();
  const violations: string[] = [];
  for (const name of toolNames) {
    if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(name)) {
      violations.push(`${name}: expected lower_snake_case verb_entity naming`);
    }
    if (Object.hasOwn(LEGACY_BANNED_PREFIXES, name.split('_', 1)[0]) && !Object.hasOwn(LEGACY_NAMING_EXCEPTIONS, name)) {
      violations.push(`${name}: banned canonical verb`);
    }
    const prefix = name.split('_', 1)[0] ?? name;
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  for (const [prefix, count] of counts) {
    const budget = (TOOL_SURFACE_BUDGET.prefixBudgets as Record<string, number>)[prefix]
      ?? TOOL_SURFACE_BUDGET.defaultPrefixBudget;
    if (count > budget) violations.push(`${prefix}*: ${count} tools exceeds prefix budget ${budget}`);
  }
  if (violations.length > 0) {
    throw new Error(`Tool naming policy violation:\n- ${violations.join('\n- ')}`);
  }
}


export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}
/**
 * Defaults a host can rely on without reading prose. Every entry here must be a
 * property the tool actually declares: `applyStableListDefaults` skips unknown
 * properties silently, so a row naming `offset` for a tool that only declares
 * `response_format`/`max_results` is dead config that reads as a promise.
 * tests/tool.surface.test.ts asserts this mapping against the real schemas.
 */
export const STABLE_LIST_DEFAULTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = Object.freeze({
  search: Object.freeze({ offset: 0 }),
  get_saved_tracks: Object.freeze({ offset: 0, fetch_all: false }),
});

function applyStableListDefaults(toolName: string, schema: Record<string, unknown>): Record<string, unknown> {
  const defaults = STABLE_LIST_DEFAULTS[toolName];
  const properties = schema.properties;
  if (!defaults || !properties || typeof properties !== 'object' || Array.isArray(properties)) return schema;
  const propertySchemas = properties as Record<string, unknown>;
  for (const [property, defaultValue] of Object.entries(defaults)) {
    const propertySchema = propertySchemas[property];
    if (!propertySchema || typeof propertySchema !== 'object' || Object.hasOwn(propertySchema, 'default')) continue;
    Object.defineProperty(propertySchema, 'default', { value: defaultValue, configurable: true, enumerable: true });
  }
  return schema;
}

/**
 * Reads can only start with one of these. Being an allowlist is the point: a new
 * mutating tool whose name we failed to anticipate defaults to "write".
 *
 * #1600: `statsfm` is deliberately NOT an alternative here, and the omission is
 * load-bearing. The family used to be granted read-only by NAME, which was
 * fail-OPEN in the one direction that matters: the next stats.fm tool to mutate
 * anything would inherit the grant and be advertised to hosts as a read, with
 * nothing in the tree obliged to notice. Note also that the `stats` alternative
 * alone still matches every `statsfm_*` string, so deleting the `statsfm`
 * alternative from this regex is a no-op on its own — the family is governed by
 * STATSFM_READ_ONLY below, which is consulted first and is a closed set. Keeping
 * `statsfm` listed here would have read as a second, live source of truth.
 */
export const READ_ONLY_PREFIXES =
  /^(get|list|search|check|inspect|find|show|describe|report|count|is|has|read|lookup|compare|diff|history|stats|summary|summarize|summarise|analyze|analyse|validate|estimate|diagnose|resolve|quiz|census|audit|review|coverage|timeline|heatmap|trends?|insights?|distribution|breakdown|matrix|explorer|probe|digest|briefing|radar|where)/;

/**
 * Writes. Bare `plan` is deliberately NOT in this list: a `_plan` suffix alone
 * is not evidence of mutation, so plans are classified by capability via
 * NEVER_MUTATING_PLANS instead.
 */
export const MUTATING_PREFIXES =
  /^(apply|start|save|add|create|update|set|replace|import|move|copy|remove|delete|unfollow|unsave|follow|pin|fill|merge|split|sort|shuffle|reorder|transfer|restore|cancel|clean|clear|trim|cull|archive|mark|queue|play|pause|skip|seek|generate|grow|balance|reschedule|migrate|handoff|dj|undo|export|backup|write|upload|rename|retag|sync|dedupe|take|snapshot|volume|sleep|transfer_playback|recently|retry|revert|reset|purge|wipe|drop|erase|revoke|disconnect|logout)/;

/**
 * Irreversible operations: they delete or overwrite user data.
 *
 * Exported so a test can assert the premise behind an OVERRIDES row — that the
 * name alone does NOT classify as destructive — against this exact regex
 * rather than a copy of it that could drift from the real policy.
 */
export const DESTRUCTIVE_PREFIXES =
  /^(remove|delete|unfollow|unsave|replace|overwrite|purge|wipe|clear|clean|cull|trim|drop|erase|revoke|reset|empty|trash|garbage|strip)/;

/** Names whose behaviour the verb patterns cannot infer. They win outright. */
const OVERRIDES: Record<string, ToolAnnotations> = {
  verify_receipt: { readOnlyHint: true, idempotentHint: true },
  spotify_doctor: { readOnlyHint: true, idempotentHint: true },
  // Writes that read like reads, and reads that read like writes.
  // Local reference normalization never calls Spotify or mutates server state.
  dedupe_spotify_uris: { readOnlyHint: true, idempotentHint: true },
  parse_spotify_uri: { readOnlyHint: true, idempotentHint: true },
  parse_spotify_uris: { readOnlyHint: true, idempotentHint: true },
  format_spotify_uri: { readOnlyHint: true, idempotentHint: true },
  canonicalize_spotify_uri: { readOnlyHint: true, idempotentHint: true },
  spotify_uri_stats: { readOnlyHint: true, idempotentHint: true },

  // #726/#1600: `statsfm_record_feedback` writes a bounded local sidecar. It
  // never reached Spotify, so no write scope covers it, and it must not be
  // advertised as a read.
  //
  // #1600: this row is now REDUNDANT and kept only as an explicit statement of
  // intent. The family rule in `classifyToolAnnotations` classifies every
  // `statsfm_*` name outside STATSFM_READ_ONLY as a write, so this name would be
  // a write with or without the row. It is left in place because a reader
  // arriving at the name deserves to find the reasoning rather than infer it,
  // and because a row that is currently doing nothing is a row someone can read
  // before deleting.
  //
  // #908 note, still true and still the reason there is no `record_feedback`
  // alias row: this table is keyed by REGISTERED name, and a stale row is not
  // harmless — `classifyToolAnnotations` consults OVERRIDES first, so an
  // unreachable row for a name that later comes back to life would silently
  // inherit someone else's annotation.
  statsfm_record_feedback: { destructiveHint: false },
  // #726: `statsfm_jukebox` reads a stats.fm account AND, on `dry_run: false`,
  // removes playlist rows and adds others. A host that auto-approves on
  // `readOnlyHint` waves a playlist mutation through with no prompt at all, so
  // this tool must not be advertised as a read. The name is not a plan, so
  // NEVER_MUTATING_PLANS is the wrong table — that set makes names read-only.
  //
  // #1600 supersedes the mechanism this row used to need. It read: "the
  // `statsfm` verb prefix is allowlisted as a READ, so without this row the
  // classifier advertises a writer as read-only" — which was true, and which
  // is also exactly the fail-open shape the issue was filed about: a hand list
  // was the only thing between the family prefix and a write advertised as a
  // read. The family is now governed by STATSFM_READ_ONLY, so this row is
  // redundant and is kept for the reason given on the row above.
  //
  // `destructiveHint: false`, not `true`, and the reason is the NAME rather than
  // the behaviour: #726 specifies `statsfm_jukebox` and the naming policy
  // reserves `destructiveHint: true` for names a verb pattern already calls a
  // write. Advertising a read-prefixed name as destructive would train hosts to
  // distrust an annotation that is supposed to mean something. What actually
  // carries the safety is in the handler, and it is not the annotation:
  // `dry_run` defaults to true, the commit path elicits with NO threshold, and
  // `requiredConfirmationRefusal` fails closed, so a client that never prompts
  // gets zero writes rather than an unprompted one. The row is what stops the
  // tool being advertised as a read, which is the half that was actually wrong.
  statsfm_jukebox: { destructiveHint: false },
  export_playlist: { destructiveHint: false },
  // backup_library makes no Spotify write — every call is a GET, and the only
  // writes are to the local backup directory. Its name starts with `backup`,
  // which the MUTATING_PREFIXES regex counts as a write, so it belongs here
  // (#1101) rather than in a blanket change to the prefix. Same shape as
  // verify_receipt, spotify_doctor, and dedupe_spotify_uris above.
  backup_library: { readOnlyHint: true, idempotentHint: true },
  play: { destructiveHint: false },
  pause: { destructiveHint: false },
  next_track: { destructiveHint: false },
  previous_track: { destructiveHint: false },
  // undo_mutation / undo_last_mutation state their destructiveness HERE rather
  // than by being omitted above, because omitting them was not enough: neither
  // name matches DESTRUCTIVE_PREFIXES, so the name-based fallback reached
  // `destructive ? { destructiveHint: true } : { destructiveHint: false }` and
  // handed the host `destructiveHint: false` — telling an auto-approving client
  // a rollback is safe when it deletes real library/playlist rows (#658). The
  // rows are the explicit claim AGENTS.md requires of every write; readOnlyHint
  // stays absent (MCP defaults it false), which is the truth for a write.
  //
  // (No read-only overrides for undo_preview / restore_playlist_plan here — they
  // live in NEVER_MUTATING_PLANS below with the per-handler audit notes.)
  restore_playback: { destructiveHint: false },
  undo_mutation: { destructiveHint: true },
  undo_last_mutation: { destructiveHint: true },
  restore_playlist_from_snapshot: { destructiveHint: true },
  apply_snapshot_changes: { destructiveHint: true },
  merge_snapshot_changes: { destructiveHint: true },
  // #1100: unpin_playlist REMOVES a library entry the user may have curated by
  // hand, but `unpin` matches no entry in DESTRUCTIVE_PREFIXES (which has
  // `unfollow`, not `unpin`), so the name-driven policy advertised it as
  // destructiveHint: false. Understating it is the failure mode that matters:
  // this is the only signal a host gets before deciding to auto-approve.
  //
  // It is an override rather than a new DESTRUCTIVE_PREFIXES entry on purpose.
  // #1099 renamed the pair to follow_playlist/unfollow_playlist and kept the
  // old names callable for one release as deprecated aliases, so this row is
  // STILL LOADED — `unfollow_playlist` needs no row of its own because
  // `unfollow` is already in DESTRUCTIVE_PREFIXES, but the alias it backs still
  // does. This entry retires in 2.1 with the alias. Widening the prefix list
  // instead would leave a live `unpin` rule behind after the alias is gone,
  // encoding a verb no tool then has.
  //
  // This is a static host hint applied after registration (AGENTS.md §4): it
  // never prompts and it does not replace the elicitation gate. The gate in
  // src/tools/confirm.ts is untouched and still fails closed on every verdict
  // but 'confirmed'.
  unpin_playlist: { destructiveHint: true },
  // #1544: `dead_library_finder` issues `DELETE /me/library` for every scan
  // candidate when `dry_run` is false — one per candidate in `library_writes`
  // chunks, over a set bounded by `fetchAllCap` rather than by anything the
  // caller chose. `dead` matches no entry in either prefix list (it is not
  // `remove`, `unsave`, or `delete`), so the name-driven fallback reached
  // `destructive ? {destructiveHint:true} : {destructiveHint:false}` and handed
  // the host `destructiveHint: false` — telling an auto-approving client that
  // gutting a saved library is a safe no-op. That is the #1100 failure mode
  // exactly, and it is worse here than on `unpin_playlist` because of the
  // scale: the name says "finder", so a host or an agent reading the registry
  // has every reason to believe the word.
  //
  // The `find` prefix does not reach this name either (the verb is the SECOND
  // word), so the read-side regex missed it too — which is why this is an
  // override on the one name rather than a change to the prefixes, and why
  // `readOnlyHint` stays ABSENT: MCP defaults it false, which is the truth for
  // a tool whose commit path writes.
  //
  // This is a static host hint applied after registration (AGENTS.md §4). It
  // never prompts and it does not replace the elicitation gate: the handler
  // still calls `requiredConfirmationRefusal` and still fails closed on every
  // verdict but `confirmed`, with `SPOTIFY_MCP_CONFIRM=never` the only bypass.
  dead_library_finder: { destructiveHint: true },
  // #896: `playlist_staleness_report` issues only GETs — /me/playlists and then
  // each playlist's items — and writes nothing, but its name starts with
  // `playlist`, which carries no read verb, so the name-driven policy
  // advertised a pure report as a write. Same shape and same reasoning as
  // `backup_library` above: an override on this one name rather than a change
  // to the prefixes, which would misclassify the many genuinely-mutating
  // `playlist_*` tools alongside it. The practical cost of leaving it out is
  // that SPOTIFY_MCP_READONLY hides a read-only report, and that the #827
  // dry_run gate cannot mechanically tell a read-only scan preview from a
  // mutating tool's commit guard.
  playlist_staleness_report: { readOnlyHint: true, idempotentHint: true },

  // #602: `switch_account` changes which account every subsequent call — every
  // WRITE — acts as, and it issues no Spotify request of its own, so both name
  // patterns miss it: `switch` is in neither MUTATING_PREFIXES nor
  // DESTRUCTIVE_PREFIXES. Left to the name-driven fallback it would have been
  // handed `destructiveHint: false` — telling an auto-approving host that
  // re-pointing a session at a different library is a safe no-op. It is not one:
  // it is the single most consequential local change this server makes, and
  // the elicitation gate in the handler is the second half of saying so.
  //
  // This is a static host hint applied after registration (AGENTS.md §4). It
  // never prompts, and it does not replace the gate: the handler still calls
  // `requiredConfirmationRefusal` and still fails closed on every verdict but
  // 'confirmed', with `SPOTIFY_MCP_CONFIRM=never` the only bypass.
  switch_account: { readOnlyHint: false, destructiveHint: true },

  // #1550: `archive_played_episodes` DELETEs up to 500 saved episodes in one
  // call, and its name matches no destructive prefix — `archive` is in
  // MUTATING_PREFIXES but not in DESTRUCTIVE_PREFIXES — so the name-driven
  // fallback reached it and handed the host `destructiveHint: false`, telling
  // an auto-approving client that erasing saved episodes is a safe no-op.
  // That is the #1100 failure mode. The handler's own gate is
  // `ARCHIVE_ELICIT_THRESHOLD` (episodemgmt.ts), so the hint and the handler
  // now agree.
  //
  // An override on this one name rather than a new DESTRUCTIVE_PREFIXES entry,
  // for the same reason `switch_account` above: `archive_` is a shared first
  // word, and widening the prefix lists would misclassify every other tool
  // that starts with them. `dead_library_finder` needs the same treatment and
  // carries its own entry above (#1544) — on its own threshold, since it
  // unsaves from the library rather than from the episode store.
  archive_played_episodes: { readOnlyHint: false, destructiveHint: true },

  // #1347: two genuine read-only reports whose names carry no read verb, so
  // the name-driven policy advertised them as writes and the live gauntlet
  // gated them off. Same shape and same reasoning as `backup_library` and
  // `playlist_staleness_report` above — an override on these two names rather
  // than a change to the prefixes, which would misclassify the many genuinely
  // mutating tools that share their first word.
  //
  // Neither issues a Spotify write. `library_genre_report` walks the saved
  // library with GETs only; `filter_by_genre` issues no Spotify request at all
  // and returns saved URIs from the same local genre sidecar.
  //
  // Stated precisely, because it is not the same claim: both DO have one local
  // write path. `loadGenreTags` quarantines an already-corrupt sidecar by
  // copying its bytes into a NEW server-owned slot (`flag: 'wx'`, never
  // overwriting, original left intact — src/tools/libraryinsights.ts:133). That
  // is a defensive preservation write, not a mutation of the user's data, and
  // it is the same category as `backup_library`'s local writes above; but it is
  // a write, and the row is not claiming otherwise. Nothing here can change
  // account state, which is the property the gauntlet's mutation proof
  // measures.
  //
  // The cost of leaving them out was concrete: the gauntlet's fail-closed
  // classifier reads the absence of readOnlyHint as "a write", so both landed
  // on the gated path and the live sweep stopped calling tools it had called
  // before #1336. `idempotentHint` is true of both for the same reason — a
  // report recomputed from the same library is the same report.
  library_genre_report: { readOnlyHint: true, idempotentHint: true },
  filter_by_genre: { readOnlyHint: true, idempotentHint: true },
};

/**
 * Tools in OVERRIDES whose entry declares readOnlyHint: true. Together with
 * NEVER_MUTATING_PLANS, this is the AUDITED set of names that may override a
 * MUTATING_PREFIXES verdict — `tests/tool.surface.test.ts` reads it live so a
 * future read-only override on a mutating verb cannot ship without showing up
 * here (#1101).
 */
export const READ_ONLY_OVERRIDES: ReadonlySet<string> = new Set(
  Object.entries(OVERRIDES)
    .filter(([, annotations]) => annotations.readOnlyHint === true)
    .map(([name]) => name),
);

/**
 * Tools in OVERRIDES whose entry declares destructiveHint: true — the
 * destructive-side mirror of READ_ONLY_OVERRIDES, and the audited set a name
 * must appear in to be advertised as destructive without a mutating verb.
 *
 * `tests/tool.surface.test.ts` reads this live. It exists because the audit
 * "every destructive tool has a mutating verb" is a real safety property that
 * cannot simply be relaxed: without an audited set, a blanket
 * `destructiveHint: true` in OVERRIDES would silence it wholesale. Deriving the
 * set from OVERRIDES rather than a second hand-kept list keeps one source of
 * truth, so a row cannot be added to one and not the other.
 *
 * The three snapshot rows predate this set and were already exempted by name
 * in the test (`/snapshot_changes/`); they are included here so the audit has
 * exactly one escape rather than two that can drift.
 */
export const DESTRUCTIVE_OVERRIDES: ReadonlySet<string> = new Set(
  Object.entries(OVERRIDES)
    .filter(([, annotations]) => annotations.destructiveHint === true)
    .map(([name]) => name),
);

/**
 * The gate for SPOTIFY_MCP_READONLY. Every read-only decision — module gating,
 * the doctor report, the freshness watermark hold, `whats_new` annotation —
 * must agree, or one env value yields two contradictory safety states (modules
 * visible but the watermark frozen, say).
 *
 * It reads process.env LIVE rather than the config snapshot on purpose. It is
 * consulted once at registration and again on every write-capable call, and
 * `spotify_doctor` builds a registry in-process to report a surface — a
 * snapshot bound at startup would answer for a different moment than the gate
 * that actually ran. Delegating to config's `readOnlyEnv` keeps the PARSE in
 * one place (#611) without freezing the ANSWER.
 *
 * The CLI doctor therefore reports this function's value, not the snapshot's,
 * so the disclosure is what the registry acted on rather than a field that
 * could drift from it. `tests/config-readonly.test.ts` pins the two to agree.
 */

export function readOnlyModeEnabled(): boolean {
  return readOnlyEnv();
}
/**
 * Plans and previews whose handlers provably never mutate — each entry was
 * verified against its handler (GET/local-file reads and local computation
 * only; no `client.post/put/delete`, no local file writes, no commit branch):
 *
 * - undo_preview (exhaust2_misc.ts) — verifyReceipt plus one optional playlist
 *   GET; the description's own dry-run framing matches the code.
 * - decade_sampler_plan (swarm3_discovery.ts) — saved-album walks only.
 * - album_representative_plan (swarm3_discovery.ts) — GET /albums/{id} plus a
 *   paged tracks walk; returns a sampling computation.
 * - front_to_back_plan (swarm3_discovery.ts) — GET /albums/{id} plus a paged
 *   tracks walk; returns cumulative start times.
 * - plan_volume_level_across_devices (swarm3_playback.ts) — RETIRED by #848
 *   into `set_volume` with `dry_run: true`. It was here because it issued no
 *   request; the rewriter that forwards it FORCES `dry_run: true` so the
 *   read-only contract survives the retirement. Dropped from the set because
 *   the audited names are asserted to be REGISTERED, and a forwarded name is
 *   not — its surviving spelling, `set_volume`, is a write, and correctly so.
 * - queue_prune_plan (swarm3_playback.ts) — queue GET only; there is no
 *   queue-removal endpoint, so the output can only be acted on by playing it.
 * - sleep_timer_plan (swarm3_playback.ts) — queue GET plus a greedy fill;
 *   the "final pause call" is returned as data, not issued.
 * - sort_playlist_plan (swarm3_playlistops.ts) — GET plus a pure in-memory
 *   reorder; the commit path lives in the separate sort_playlist_apply.
 * - playlist_union_preview (swarm3_playlistops.ts) — GET plus exclusivity
 *   stats; no dry_run param exists at all.
 * - dedupe_playlist_plan (swarm3_playlistops.ts) — GET plus a duplicate
 *   census; its description names dedupe_playlist_apply as the committer.
 * - stale_saved_shows_plan (swarm3_shows.ts) — GET plus prune-candidate
 *   computation; "read-only by design … never unfollows anything".
 * - mark_episode_played_plan (swarm3_shows.ts) — GET resume points; "Read-only
 *   by design" because Spotify removed the mark-played API (#230).
 * - show_backlog_plan (swarm3_shows.ts) — GET plus ordering; "dry-run only,
 *   never mutates".
 * - restore_playlist_plan (swarm3_snapshots.ts) — live-state GET plus snapshot
 *   file reads; "Read-only plan … never mutates".
 * - merge_snapshot_changes_plan (swarm3_snapshots.ts) — GET plus snapshot file
 *   reads; no commit branch exists in the handler.
 * - snapshot_retention_plan (swarm3_snapshots.ts) — local snapshot file reads
 *   only; execution lives in prune_old_snapshots.
 * - playlist_chunk_preview (swarm4_playlists.ts) — GET plus arithmetic;
 *   "Read-only pagination preview".
 * - plan_podcast_session (podcastsession.ts) — candidate GETs returning a
 *   packing; no dry_run param and no commit branch (that lives in the
 *   separate start_podcast_session).
 *
 * Anything named `*_plan`/`*_preview` that is NOT in this set is classified as
 * a write, even when its description says "read-only": preview-by-default
 * handlers that accept dry_run=false execute (apply_volume_plan,
 * split_queue_plan, reverse_/rotate_/interleave_/merge_/difference_playlist_plan).
 */
// dedupe_spotify_uris is local classification/canonicalization only; no API or filesystem writes.
export const NEVER_MUTATING_PLANS: ReadonlySet<string> = new Set([
  'undo_preview',
  'decade_sampler_plan',
  'album_representative_plan',
  'front_to_back_plan',
  'queue_prune_plan',
  'sleep_timer_plan',
  'sort_playlist_plan',
  'playlist_union_preview',
  'dedupe_playlist_plan',
  'dedupe_spotify_uris',
  'stale_saved_shows_plan',
  'mark_episode_played_plan',
  'show_backlog_plan',
  'restore_playlist_plan',
  'merge_snapshot_changes_plan',
  'snapshot_retention_plan',
  'playlist_chunk_preview',
  'plan_podcast_session',
]);

/**
 * #1600: the `statsfm_` family, positively enumerated.
 *
 * Every other read is admitted by a verb prefix, which is an allowlist in the
 * fail-closed direction — a name nobody anticipated is a write. The stats.fm
 * family was the exception, and the exception was backwards. `statsfm_` is a
 * PRODUCT prefix, not a verb: a future `statsfm_mark_jukebox_replayed` or
 * `statsfm_sync_playlists` is a write whose name would still have been granted
 * read-only by the allowlist. The only thing standing between such a tool and a
 * host that trusts `readOnlyHint: true` was a hand-listing in OVERRIDES, and a
 * hand list nobody has to consult does not fail anything.
 *
 * So the polarity is inverted for this family only: a `statsfm_*` tool is
 * read-only if and only if its name is in this set, and anything unclassified is
 * classified as a write. A new stats.fm tool is therefore a write until someone
 * reads its handler and adds it here — and the cost of getting that wrong is
 * the nuisance one, not the dangerous one. A read left out is classified as a
 * non-destructive write, so it loses `readOnlyHint`/`idempotentHint` and a host
 * that keys confirmation off those hints may ask a human to approve a harmless
 * read.
 *
 * What that mistake does NOT cost is VISIBILITY, which is the part a reader
 * naturally assumes it does. `SPOTIFY_MCP_READONLY` is enforced per manifest
 * MODULE and never per tool: `registerManifestModule` returns
 * `read_only_hidden` when `readOnly && module.readOnlySafe !== true`, and
 * nothing anywhere filters `tools/list` by `readOnlyHint`. The two writes
 * demonstrate the split directly — both are absent from this set and both
 * classify as writes, yet `statsfm_record_feedback` (in the `readOnlySafe`
 * `taste` module) still registers under a read-only session while
 * `statsfm_jukebox` (in `tastejukebox`, which is not `readOnlySafe`) does not.
 * Identical set-membership, opposite visibility, so the module flag — not this
 * set — is what decides. #1600 closed a real fail-open grant; the guarantee
 * that survives it is the module flag, and a comment implying otherwise makes
 * a real fix look load-bearing when it is not.
 *
 * The 37 names are the read-only half of the 39-tool family as measured from the
 * live registry. The two writes are `statsfm_jukebox` and
 * `statsfm_record_feedback`, and both carry OVERRIDES rows — but those rows
 * exist to un-apply a grant, which is the fail-open shape; they are now
 * redundant and are kept only as explicit statements of intent.
 *
 * Exported so the test can assert this set against the live registry in both
 * directions. Without that, a new stats.fm tool would silently classify as a
 * write and nobody would find out until a user reported a read-only tool
 * asking them to confirm something harmless.
 */
export const STATSFM_READ_ONLY: ReadonlySet<string> = new Set([
  'statsfm_album_date_stats',
  'statsfm_album_stats',
  'statsfm_artist_affinity',
  'statsfm_artist_date_stats',
  'statsfm_artist_stats',
  'statsfm_catalog_album',
  'statsfm_catalog_artist',
  'statsfm_catalog_track',
  'statsfm_charts_albums',
  'statsfm_charts_artists',
  'statsfm_charts_tracks',
  'statsfm_charts_users',
  'statsfm_exposure_check',
  'statsfm_forgotten_favorites',
  'statsfm_friend_count',
  'statsfm_friends',
  'statsfm_genre_artists',
  'statsfm_listening_eras',
  'statsfm_listening_sessions',
  'statsfm_now_playing',
  'statsfm_recaps',
  'statsfm_recent_streams',
  'statsfm_records_artists',
  'statsfm_resolve_user',
  'statsfm_search',
  'statsfm_streams_stats',
  'statsfm_taste_profile',
  'statsfm_taste_recommendations',
  'statsfm_top_albums',
  'statsfm_top_albums_from_artist',
  'statsfm_top_artists',
  'statsfm_top_genres',
  'statsfm_top_tracks',
  'statsfm_top_tracks_from_album',
  'statsfm_top_tracks_from_artist',
  'statsfm_track_date_stats',
  'statsfm_track_stats',
]);

/** The product prefix, as opposed to the verb prefixes in READ_ONLY_PREFIXES. */
const STATSFM_FAMILY_PREFIX = 'statsfm_';
const STATSFM_FAMILY = new RegExp(`^${STATSFM_FAMILY_PREFIX}`);

/**
 * Classify one tool. Returns only the fields worth putting on the wire:
 * non-default values plus an explicit `destructiveHint` for every write (MCP
 * defaults it to true, so silence means "may destroy").
 */
export function classifyToolAnnotations(toolName: string): ToolAnnotations {
  if (toolName === 'whats_new') {
    return readOnlyModeEnabled()
      ? { readOnlyHint: true, idempotentHint: true }
      : { destructiveHint: false };
  }
  const override = OVERRIDES[toolName];
  if (override) return { ...override };
  if (NEVER_MUTATING_PLANS.has(toolName)) return { readOnlyHint: true, idempotentHint: true };

  // #1600: consulted before the verb prefixes, because `statsfm_` names are
  // admitted by the `stats` alternative regardless — a check placed after the
  // prefix test could never fire, and would look like a fix while changing
  // nothing. Explicit OVERRIDES and audited plans still win above, so the two
  // known writers keep their hand-stated annotations.
  if (STATSFM_FAMILY.test(toolName)) {
    if (STATSFM_READ_ONLY.has(toolName)) return { readOnlyHint: true, idempotentHint: true };
    // Falling out of the family is a statement about read-only-ness, not about
    // how much damage the tool can do, so the destructive test still runs — and
    // it has to run on the name WITH the family prefix stripped. The regexes
    // are `^`-anchored, so `DESTRUCTIVE_PREFIXES.test('statsfm_delete_x')` is
    // false however obviously destructive the name is: `statsfm_` shadows the
    // verb exactly the way it shadowed the read grant. Testing the remainder
    // keeps the verb the author actually chose.
    const verb = toolName.slice(STATSFM_FAMILY_PREFIX.length);
    return DESTRUCTIVE_PREFIXES.test(verb)
      ? { destructiveHint: true }
      : { destructiveHint: false };
  }

  const mutating = MUTATING_PREFIXES.test(toolName);
  const readOnly = !mutating && READ_ONLY_PREFIXES.test(toolName);
  if (readOnly) return { readOnlyHint: true, idempotentHint: true };

  const destructive = DESTRUCTIVE_PREFIXES.test(toolName);
  return destructive ? { destructiveHint: true } : { destructiveHint: false };
}

type SdkSchema = NonNullable<Parameters<typeof getObjectShape>[0]>;
type ToolHandler =
  | ((...args: unknown[]) => unknown)
  | { createTask: (...args: unknown[]) => unknown };

interface RegistryEntry {
  title?: string;
  description?: string;
  inputSchema?: SdkSchema;
  outputSchema?: SdkSchema;
  annotations?: unknown;
  handler?: ToolHandler;
  enabled?: boolean;
  execution?: unknown;
  _meta?: Record<string, unknown>;
  update?: (u: { annotations?: ToolAnnotations }) => void;
}

/**
 * The SDK's private tool registry, read once for the whole module.
 *
 * Every reader here reached the same field through its own
 * `server as unknown as { _registeredTools?: … }`, which repeats a claim about
 * the SDK's internals at each site and re-types it at each site — so a change to
 * the registry's shape had to be reconciled in five places, and the copy at each
 * one was free to disagree. This is deliberately two functions rather than one
 * generic: a `readRegistry<T>()` would name its result type once and hand back
 * whatever the caller asked for, which is the unverified assertion behind a
 * friendlier name (AGENTS.md §6).
 */
function registeredToolEntries(server: McpServer): Record<string, RegistryEntry> | undefined {
  return (server as unknown as { _registeredTools?: Record<string, RegistryEntry> })._registeredTools;
}

/**
 * Attach annotations to every registered tool, using the SDK's `update()` when
 * available (it also notifies hosts) and assigning directly otherwise. Returns
 * counts so startup can log a silent no-op instead of shipping unannotated tools.
 */
export function applyToolAnnotations(server: McpServer): { total: number; annotated: number } {
  const registry = registeredToolEntries(server);
  if (!registry || typeof registry !== 'object') return { total: 0, annotated: 0 };
  let annotated = 0;
  for (const [name, entry] of Object.entries(registry)) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.annotations && Object.keys(entry.annotations).length > 0) {
      annotated++;
      continue;
    }
    const annotations = classifyToolAnnotations(name);
    try {
      if (typeof entry.update === 'function') entry.update({ annotations });
      else entry.annotations = annotations;
      annotated++;
    } catch {
      // A registry that rejects updates is a host-shape change: leaving a tool
      // unannotated is safer than failing server startup.
    }
  }
  return { total: Object.keys(registry).length, annotated };
}

/**
 * Publish an `outputSchema` on every tool whose module is listed in
 * `OUTPUT_SCHEMA_BY_MODULE` (#687).
 *
 * WHY A POST-REGISTRATION PASS AND NOT A REGISTRATION ARGUMENT. The SDK has two
 * registration APIs and only one of them can carry an output schema:
 * `registerTool(name, config, cb)` reads `config.outputSchema`, while the
 * positional `server.tool(name, description, shape, cb)` this tree uses
 * everywhere hardcodes `outputSchema: undefined` at the point it builds the
 * registry entry. Migrating the declaration would therefore mean rewriting the
 * registration call of every tool in the list — hundreds of edits whose only
 * content is a schema the module already implies, and every one of them a place
 * for the schema and the tool to drift apart. Assigning after registration is
 * the same model `applyToolAnnotations` above already uses, and it means the
 * declaration is data (`OUTPUT_SCHEMA_BY_MODULE`) rather than something repeated
 * in each module.
 *
 * The assignment is direct rather than through `update({ outputSchema })` on
 * purpose: the SDK's `update` runs its argument through `objectFromShape`,
 * which expects a zod RAW SHAPE (`{ field: z.string() }`) and would wrap a
 * `z.object()` inside another object. The registered entry holds the zod schema
 * itself — which is what `finalOutputSchema`, `validateOutput` and the SDK's own
 * output check all read.
 *
 * ORDERING IS LOAD-BEARING. This runs before `assertModuleSchemaBudgets` and
 * before `assertAggregateSurfaceBudget`, because both measure `outputSchema` and
 * a declaration that neither gate can see is a declaration nobody is paying for.
 * `scripts/surface-census.mjs` runs this same function between its own
 * registration and its aggregate measurement for the same reason.
 *
 * A module named in `OUTPUT_SCHEMA_BY_MODULE` that registers no tools is
 * skipped, not complained about: an opt-in module this session trimmed away is
 * a normal outcome, and `metadata.tools` only holds names for modules that
 * actually registered. Every module that DID register has to be in exactly one
 * of the three sets — declared, prose-only, or verified-safe-and-pending — and
 * a module in none of them fails startup. That is the acceptance criterion #687
 * asks for ("a test fails when a tool returns structuredContent without a
 * declared outputSchema, with an explicit allow-list for legacy tools") running
 * at startup rather than only in CI, so a module that slipped past review is
 * caught before a host sees the surface.
 */
/**
 * @param familyFor  How a module's file resolves to a family. Injectable ONLY
 *   so the test can drive THIS loop with a map that is missing an entry — the
 *   pass's own body used to be duplicated in the test to allow exactly that, and
 *   the copy was a test that could not fail: deleting this function's `throw`
 *   left the whole 5,142-test suite green, because the test proved the copy
 *   fired rather than this. A default parameter is the whole fix; the loop
 *   below is the only implementation of the policy.
 */
export function applyToolOutputSchemas(
  server: McpServer,
  familyFor: (file: string) => OutputSchemaFamily | undefined = outputSchemaFamilyForModule,
): { total: number; declared: number } {
  const registry = registeredToolEntries(server);
  if (!registry || typeof registry !== 'object') return { total: 0, declared: 0 };
  let declared = 0;
  const unclassified: string[] = [];
  for (const module of REGISTRAR_MANIFEST) {
    // A module this session trimmed or gated away registered nothing, so there
    // is nothing to declare and nothing to classify. That is a normal outcome,
    // not a gap in the map.
    const names = moduleToolNames(server, module.key);
    if (names.length === 0) continue;
    const family = familyFor(module.file);
    if (family !== undefined) {
      const schema = OUTPUT_SCHEMA_FAMILIES[family];
      for (const name of names) {
        const entry = registry[name];
        if (!entry || typeof entry !== 'object') continue;
        entry.outputSchema = schema;
        declared++;
      }
      continue;
    }
    if (PROSE_ONLY_MODULES.has(module.file) || PENDING_OUTPUT_SCHEMA_MODULES.has(module.file)) continue;
    unclassified.push(module.file);
  }
  if (unclassified.length > 0) {
    throw new Error(
      `tool modules are unclassified for outputSchema (#687): ${unclassified.sort().join(', ')}. `
      + 'Add each to OUTPUT_SCHEMA_BY_MODULE (with a family), to PROSE_ONLY_MODULES (with the '
      + 'prose-only path that keeps it out), or to PENDING_OUTPUT_SCHEMA_MODULES (verified safe, '
      + 'awaiting aggregate headroom).',
    );
  }
  return { total: Object.keys(registry).length, declared };
}

export type ModuleRegistrationStatus =
  | 'active'
  | 'toolset_trimmed'
  | 'scope_filtered'
  | 'read_only_hidden';

export interface ModuleSchemaBudget {
  readonly module: string;
  readonly registrationKey: string;
  readonly file: string;
  readonly status: ModuleRegistrationStatus;
  readonly toolCount: number;
  readonly schemaBytes: number;
  readonly baselineToolCount: number;
  readonly baselineSchemaBytes: number;
  readonly maxToolCount: number;
  readonly maxSchemaBytes: number;
  readonly withinBudget: boolean;
}

export const AGGREGATE_SURFACE_LIMITS = {
  maxTools: TOOL_SURFACE_BUDGET.defaultMaxTools,
  // 1 KB headroom covers final MCP annotation metadata added after registration.
  maxBytes: TOOL_SURFACE_BUDGET.defaultMaxBytes + 1_000,
} as const;

export interface AggregateSurfaceMeasurement {
  readonly toolCount: number;
  readonly schemaBytes: number;
}

export function collectAggregateSurfaceMeasurement(server: McpServer): AggregateSurfaceMeasurement {
  const registry = (server as unknown as { _registeredTools?: Record<string, SchemaRegistryEntry & { annotations?: unknown; title?: string; execution?: unknown; _meta?: unknown }> })._registeredTools ?? {};
  const tools = Object.entries(registry).filter(([, tool]) => tool.enabled !== false).map(([name, tool]) => ({
    name,
    title: tool.title,
    description: tool.description,
    inputSchema: applyStableListDefaults(name, finalInputSchema(tool.inputSchema)),
    // `outputSchema` was missing from this literal while the boundary emitted
    // it (#1376), so a tool declaring one was charged nothing for bytes every
    // host receives. `finalOutputSchema` is the boundary's own projection, so
    // this measures the payload rather than a second reconstruction of it.
    // The key is still written for every tool: `JSON.stringify` drops an
    // `undefined` value, so a tool that declares none costs the same as before.
    outputSchema: finalOutputSchema(tool.outputSchema),
    annotations: tool.annotations,
    execution: tool.execution,
    _meta: tool._meta,
  }));
  return { toolCount: tools.length, schemaBytes: Buffer.byteLength(JSON.stringify(tools), 'utf8') };
}

export function assertAggregateSurfaceBudget(measurement: AggregateSurfaceMeasurement): void {
  if (measurement.toolCount <= AGGREGATE_SURFACE_LIMITS.maxTools && measurement.schemaBytes <= AGGREGATE_SURFACE_LIMITS.maxBytes) {
    return;
  }
  // #1620. The single aggregate line names a byte budget and not the tool that
  // crossed it, so a contributor who adds a gated tool sees a startup failure
  // several files from the change that caused it, and the default-surface CI
  // run is green throughout. The per-module table already exists — it is what
  // `toolset_report` returns and what the manifest budgets against — so the
  // information is present at the point of failure and was simply not carried
  // into the message.
  //
  // Reported rather than enforced. A module can be inside its own ceiling and
  // still contribute to an aggregate breach, because the aggregate also charges
  // per-tool name, title, annotations and `_meta` that the per-module budget
  // does not; naming the largest modules is a pointer to where the bytes are,
  // not an accusation that one of them is at fault. Saying so here is the
  // difference between a diagnosis and a false attribution.
  const largest = [...REGISTRAR_MANIFEST]
    .map((entry) => ({ key: entry.key, file: entry.file, bytes: entry.ceiling.schemaBytes, tools: entry.ceiling.toolCount }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 5)
    .map((m) => `  ${m.key} (${m.file}): ${m.tools} tools / ${m.bytes}B of its own ceiling`)
    .join('\n');
  throw new Error(
    `aggregate tool surface exceeds budget: ${measurement.toolCount} tools/${measurement.schemaBytes}B `
      + `> ${AGGREGATE_SURFACE_LIMITS.maxTools} tools/${AGGREGATE_SURFACE_LIMITS.maxBytes}B\n`
      + `Largest module surfaces by their own ceiling (a pointer to where the bytes are, not an attribution — `
      + `the aggregate also charges per-tool name, title, annotations and _meta that a module ceiling does not):\n`
      + `${largest}\n`
      + `See docs/schema-budgets.md for how the aggregate is measured and what headroom remains.`,
  );
}

/**
 * The larger surface a module can reach when `gatedBy` is set (#1128).
 *
 * `baseline` stays the DEFAULT surface, because the census deliberately strips
 * `SPOTIFY_*` from the environment (surface-census.mjs) so every generated
 * surface table reports what an ordinary install actually serves. But the
 * schema budget is a *startup* gate, and a process that opted in registers more
 * tools than the default baseline describes — so a module with a gated surface
 * needs its ceiling sized for the larger of the two, or the opted-in server
 * refuses to boot while the default path stays green in CI.
 */
export interface GatedSurface {
  /** Env var whose presence switches the module to its larger surface. */
  readonly gatedBy: string;
  readonly toolCount: number;
  readonly schemaBytes: number;
}

/**
 * The env vars whose presence enlarges the AGGREGATE surface (#1493) — the
 * aggregate-level counterpart of the per-module `gatedSurface` above.
 *
 * Derived from the manifest rather than typed here, for the same reason the
 * per-module figures live on the entries they describe: a second hand-typed
 * list of env vars is a list that can name a gate the manifest no longer
 * declares, and it would fail silently — the survey would find no gated
 * modules and report a default surface as if it were the only one.
 *
 * A length other than 0 or 1 is a manifest the aggregate gate cannot honestly
 * cover, so it throws rather than picking one: two flags means two opt-in
 * surfaces, and sizing the budget for one of them is the defect #1493 reports
 * in a new place.
 */
export function aggregateGatedEnvVars(): readonly string[] {
  const flags = [...new Set(REGISTRAR_MANIFEST.filter((entry) => entry.gatedSurface).map((entry) => entry.gatedSurface!.gatedBy))].sort();
  assertSingleAggregateGatedFlag(flags);
  return flags;
}

/**
 * The invariant behind `aggregateGatedEnvVars`, split out so it is testable.
 *
 * The census LABELS the opted-in table from the declared flags but MEASURES it
 * by flipping the one flag it knows (`surface-census.mjs`). A second declared
 * flag would publish a table captioned with both while measuring only one — a
 * figure describing an installation that does not exist. This claim used to live
 * in four comments and no code, so a second flag would have shipped silently,
 * and the test that "pinned" it was a `deepEqual` on a constant that reads the
 * same whether or not the guard exists.
 */
export function assertSingleAggregateGatedFlag(flags: readonly string[]): void {
  if (flags.length > 1) {
    throw new Error(
      `aggregateGatedEnvVars: ${flags.length} gated flags declared (${flags.join(', ')}). ` +
        'The aggregate opt-in measurement flips exactly one known flag, so a second ' +
        'declared flag would caption the table with a surface it never measured. ' +
        'Teach surface-census.mjs to measure the new flag before declaring it.',
    );
  }
}

/**
 * The tool-count delta the manifest's gated entries declare, summed.
 *
 * Exact, and unlike the byte figure it is a property of the manifest alone, so
 * it can be asserted against a live measurement of the opted-in surface. The
 * census does exactly that (`checkAggregateSurfaceTruth`): if a module gains or
 * loses a gated tool without its `gatedSurface` being updated, the declared sum
 * stops matching what the opt-in actually registers.
 *
 * There is deliberately no byte counterpart. Summing the per-module
 * `schemaBytes` understates the aggregate cost of the same opt-in, because the
 * per-module budget charges `description + inputSchema + outputSchema` while
 * `collectAggregateSurfaceMeasurement` also charges every tool's name, title,
 * annotations, execution and `_meta`. On this tree that gap is 1,305B across
 * the eleven opted-in tools, so a derived byte ceiling would be short by more
 * than a thousand bytes and would report headroom nobody actually has. The
 * aggregate's opted-in byte count is therefore MEASURED — registered twice, once
 * with the flag set — and never derived.
 */
export function declaredGatedToolDelta(): number {
  return REGISTRAR_MANIFEST.reduce(
    (total, entry) => total + (entry.gatedSurface ? entry.gatedSurface.toolCount - entry.baseline.toolCount : 0),
    0,
  );
}

/**
 * A module's registration function.
 *
 * `client` is optional because three registrars take no client at all
 * (`registerSwarm3MetaTools`, `registerMoodExpandTools`, and the local receipts
 * registrar) and one takes a `StatsfmClient` rather than a `SpotifyClient` —
 * see `lazyModule`'s `adapt`.
 * `registerManifestModule` always passes it; the type only says a module is
 * not required to consume it.
 */
export type ModuleRegistrar = (server: McpServer, client?: SpotifyClient) => void;

/**
 * A registrar that cannot be called without the client (#1385).
 *
 * `ModuleRegistrar` makes `client` optional because several modules take no
 * client at all. A registrar that keys a store BY ACCOUNT has no such luxury:
 * with no client it has no account, and the `?? ''` it used to reach answered
 * with the default account's store — a cross-account merge with no error. This
 * is the shape those registrars declare instead, so omitting the client is a
 * compile error at the manifest entry rather than a silent fallback at runtime.
 * `localModule` and `lazyModule` both accept it and store it as a
 * `ModuleRegistrar`, exactly as they already do for imported registrars.
 */
export type ClientBoundRegistrar = (server: McpServer, client: SpotifyClient) => void;

export interface RegistrarSpec {
  /**
   * Repo-relative source path, used in budget-breach messages and in the
   * generated census module map. Derived from the specifier by `lazyModule` so
   * it cannot drift away from the module that is actually imported.
   */
  readonly file: string;
  /**
   * The registrar's export name. Carried as data because a thunk has no
   * `.name`, and the census module map has always named the export a reader
   * can grep for.
   */
  readonly name: string;
  /** Import the module and return its registrar. Memoized. */
  readonly load: () => Promise<ModuleRegistrar>;
}

/** Resolve an export out of a freshly imported module, failing loudly. */
async function resolveExport(specifier: string, name: string): Promise<ModuleRegistrar> {
  const imported = await import(specifier) as Record<string, unknown>;
  const registrar = imported[name];
  if (typeof registrar !== 'function') {
    throw new Error(`tool module ${specifier} has no callable export "${name}"`);
  }
  return registrar as ModuleRegistrar;
}

/**
 * A tool module the manifest imports on demand (#906).
 *
 * The thunk is the whole point. A manifest that held `registerSearchTools`
 * directly would have had to import `./search.js` in order to name it, so every
 * module was evaluated before the toolset gate could answer — which is why
 * trimming 83% of the tools used to shrink the payload without shrinking
 * startup or RSS. Here the specifier is a string, so nothing is fetched until
 * `load()` is called for a module that is about to register.
 *
 * `adapt` exists for the one module whose second parameter is NOT a
 * `SpotifyClient`. `registerStatsfmTools` takes a `StatsfmClient` with a
 * default, and the manifest used to hide that behind a `(server) => ...`
 * wrapper which dropped the client it was handed. Calling the export directly
 * would have passed Spotify's client into a stats.fm tool, sending its
 * requests to api.spotify.com — a runtime bug that no schema comparison in the
 * test suite can see.
 */
export function lazyModule(
  specifier: string,
  name: string,
  adapt?: (registrar: ModuleRegistrar) => ModuleRegistrar,
): RegistrarSpec {
  let pending: Promise<ModuleRegistrar> | undefined;
  return {
    file: specifier.replace(/^\.\//, 'src/tools/').replace(/\.js$/, '.ts'),
    name,
    load: async () => {
      pending ??= resolveExport(specifier, name);
      const registrar = await pending;
      return adapt ? adapt(registrar) : registrar;
    },
  };
}

/**
 * A registrar defined in this file rather than in an imported module (the
 * receipts tool). Nothing to import, so `load` resolves immediately — but it
 * goes through the same field so the manifest has exactly one shape and
 * `registerManifestModules` needs no special case for it.
 */
export function localModule(
  file: string,
  name: string,
  registrar: ModuleRegistrar | ClientBoundRegistrar,
): RegistrarSpec {
  // The cast is what lets a client-bound registrar live in the same field:
  // `registerManifestModule` always passes a client, so the narrower
  // signature is satisfied at every call site that matters.
  return { file, name, load: async () => registrar as ModuleRegistrar };
}

export interface RegistrarManifestEntry extends RegistrarSpec {
  readonly key: string;
  readonly registrationKey: string;
  /**
   * The resolved registrar, present only on entries returned by
   * `loadManifestRegistrars`. `registerManifestModule` requires it for any
   * module that will actually register, and throws rather than silently
   * registering nothing when it is missing.
   */
  readonly registrar?: ModuleRegistrar;
  readonly scopeKey?: string;
  readonly alwaysActive?: boolean;
  readonly readOnlySafe?: boolean;
  readonly baseline: { readonly toolCount: number; readonly schemaBytes: number };
  readonly ceiling: { readonly toolCount: number; readonly schemaBytes: number };
  /** Present only for a module whose tool surface depends on configuration. */
  readonly gatedSurface?: GatedSurface;
}

export interface RegistrarManifestContext {
  readonly readOnly: boolean;
  readonly isModuleActive: (registrationKey: string) => boolean;
  /**
   * The registration keys named in `SPOTIFY_MCP_DISABLE_TOOLS`, already
   * resolved and lowercased by `resolveToolOverrides`.
   *
   * This is a SET rather than a second predicate because it has to be told
   * apart from the toolset trim: `isModuleActive` returns false both for a
   * module whose set was trimmed AND for one the operator explicitly disabled,
   * and the two are not the same question. Collapsing them is what made
   * `alwaysActive` swallow the override (#580) — the flag short-circuited the
   * only call that carried the answer. A set is also the one shape a test
   * stub cannot get wrong by accident: `new Set()` says "nothing disabled"
   * and is true of every row, where a `() => false` predicate is a claim about
   * a specific row that a test can accidentally invert.
   */
  readonly disableOverrides: ReadonlySet<string>;
  readonly scopeBlocked: (scopeKey: string) => boolean;
}

/**
 * Build one manifest row, deriving its ceiling.
 *
 * Exported so a test can drive the derivation with a real gated baseline rather
 * than asserting against whatever module happens to carry one today (#1128).
 */
export const manifestEntry = (
  key: string,
  registrationKey: string,
  spec: RegistrarSpec,
  baseline: readonly [toolCount: number, schemaBytes: number],
  options: Partial<Omit<RegistrarManifestEntry, 'key' | 'registrationKey' | 'file' | 'name' | 'load' | 'registrar' | 'baseline' | 'ceiling'>> = {},
): RegistrarManifestEntry => ({
  key,
  registrationKey,
  ...spec,
  scopeKey: registrationKey,
  readOnlySafe: false,
  ...options,
  baseline: { toolCount: baseline[0], schemaBytes: baseline[1] },
  // Ten percent schema headroom and one additional tool force a deliberate
  // baseline/ceiling update whenever a registrar grows. A module with a gated
  // surface is sized against the LARGER of the default and opted-in figures, so
  // both surfaces clear the same ceiling (#1128) — sizing it on the default
  // alone makes the opted-in server refuse to start, which is invisible until a
  // user sets the flag.
  ceiling: (() => {
    const gated = options.gatedSurface;
    const toolBase = gated ? Math.max(baseline[0], gated.toolCount) : baseline[0];
    const byteBase = gated ? Math.max(baseline[1], gated.schemaBytes) : baseline[1];
    return {
      toolCount: toolBase + 1,
      schemaBytes: Math.ceil(byteBase * 1.1),
    };
  })(),
});

/**
 * The `verify_receipt` tool (#688), which lives in this file rather than in
 * `src/tools/`.
 *
 * It was an inline arrow passed straight to `manifestEntry`, which cost the
 * census module map its one honest label: an arrow has no `.name`, so the map
 * fell back to the module key and printed `receipts` where every other row
 * printed the export a reader can grep for. Naming it costs one declaration and
 * lets `localModule` keep the manifest on a single shape (#906).
 */
function registerVerifyReceiptTool(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'verify_receipt',
    // Session scope is the single most common way this tool misleads: the
    // store is process-local and FIFO-capped, so an id from a previous
    // session is simply gone — which says nothing about whether the
    // mutation landed. State it here, where the agent reads it, rather than
    // only in the miss message it will see too late.
    `Verify that a previous mutation actually landed on Spotify by looking up its receipt. `
      + `Receipts are session-scoped: the ${MAX_RECEIPTS} most recent mutations, in this process only, `
      + `and lost on restart unless SPOTIFY_MCP_RECEIPTS is set. `
      + `An unknown or expired id returns isError with found:false — a fact about the lookup, not about the mutation.`,
    {
      receipt_id: z
        .string()
        .regex(RECEIPT_ID_PATTERN, `Receipt ID must look like ${RECEIPT_ID_SHAPE} — copy it verbatim from a receipt-bearing mutation result.`)
        .describe(`Receipt ID copied verbatim from a receipt-bearing mutation result (${RECEIPT_ID_SHAPE})`),
    },
    async (args) => {
      // Looked up as the ACTING account, so a receipt id from another account
      // on this machine is a miss rather than an attestation about this one
      // (#1364). The client is the only carrier of that identity here; the
      // registrar used to discard it, which is how the store ended up global.
      //
      // The client is REQUIRED and carries a required `tokenFile` (#1385).
      // This line used to be `client?.tokenFile ?? ''`, and that `?? ''` was
      // the fail-open this issue is about: a registrar called without a client
      // read the default account's store, so a receipt minted under a profile
      // verified as the default account's own. `registerManifestModule` has
      // always passed a client, so this costs nothing in production and closes
      // the branch.
      //
      // The `?.` is NOT the fallback it replaced — it is here so that a caller
      // which bypasses the required type lands in `accountStoreKey` and gets
      // the one canonical "no account was named" error, instead of a TypeError
      // about reading a property of undefined. `verifyReceipt` calls it below.
      const tokenFile = client?.tokenFile;
      const receipt = verifyReceipt(args.receipt_id, tokenFile);
      if (!receipt) {
        // A miss is a failed lookup, not a successful one. Without isError
        // an agent that branches on `result.isError` (and a host that
        // renders green on success) reads this as "the receipt was checked
        // and the write is fine" (#688).
        return {
          content: [{ type: 'text', text: receiptMissMessage(args.receipt_id, process.env, tokenFile) }],
          isError: true,
          structuredContent: {
            found: false,
            receipt_id: args.receipt_id,
            reason: 'unknown',
            receipts_kept: MAX_RECEIPTS,
          },
        };
      }
      // `found` is the one field both branches share, so a caller can branch
      // on it instead of parsing prose. The receipt's own fields stay
      // flattened on top: hosts already read `verified` / `missing` /
      // `expect_present` here, and nesting them under `receipt` would
      // silently break every one of them.
      return {
        content: [{ type: 'text', text: formatReceipt(receipt) }],
        structuredContent: { found: true, ...receipt },
      };
    },
  );
}

export const REGISTRAR_MANIFEST: readonly RegistrarManifestEntry[] = [
  // #638, RE-MEASURED on the post-rebase tree. The pre-rebase branch figures
  // for library and following were measured before main moved, and main had
  // since reworded these descriptions — so carrying either side's number
  // forward would put a lie in a hand-maintained baseline the startup gate
  // treats as ground truth, and a slightly-stale value usually still sits
  // under its own derived ceiling, so no gate would catch it. Every module this
  // commit's diff touches under src/tools/ was re-measured the same way: zero
  // the baseline so the derived ceiling is 0, let the startup gate fail loudly
  // with the real figure, then write that figure back. No ceiling was raised.
  manifestEntry('search', 'search', lazyModule('./search.js', 'registerSearchTools'), [1, 1821], { readOnlySafe: true }),
  // #639: descriptions only, same tool count in every one of these seven
  // modules. Nothing here adds, removes or re-shapes a tool or an input
  // property — the byte movement is entirely the tool descriptions, which now
  // say what Spotify stopped sending instead of quietly reading it. `label`,
  // `publisher` and `product` are gone from live payloads, and a description
  // that tells a caller to read `get_me.product` or to group a census by
  // `album.label` now points at a field that is always `undefined`.
  //
  // MEASURED, not estimated, and not hand-raised. Each of the seven baselines
  // was first set to zero tools / 0 B, and the server's own startup budget gate
  // then refused to serve tools/list — printing every module's real figure in
  // its refusal message, which is where the right-hand column below comes from:
  //
  //     catalog          31 tools / 26883B -> 31 tools / 27222B  (+339B)
  //     library          13 tools / 12521B -> 13 tools / 12814B  (+293B)
  //     users             2 tools /  1613B ->  2 tools /  1696B  ( +83B)
  //     swarm3discovery  24 tools / 22286B -> 24 tools / 22483B  (+197B)
  //     swarm3bdiscovery 24 tools / 19952B -> 24 tools / 20147B  (+195B)
  //     swarm3shows      24 tools / 21457B -> 24 tools / 22103B  (+646B)
  //     swarm3library    24 tools / 18092B -> 24 tools / 18283B  (+191B)
  //
  // Every tool count is UNCHANGED, which is the point worth recording: this is
  // a re-measure of the same surface, not a ceiling raise to let a breach pass.
  // Total +1,944 B of description across the seven.
  //
  // Host-session payload impact: aggregate tools/list 606,353 B across 587
  // tools, against the 640,000 B enforced cap — 14,647 B of headroom (2.36%),
  // which is the tightest reading in the tree and is stated here rather than
  // discovered later. No input schema changed, so the delta is entirely prose
  // the caller reads once at registration. Re-measured after the rebase onto
  // main, which had moved the aggregate under this branch: the per-module
  // ceilings above are unchanged by it, the aggregate is not.

  manifestEntry('catalog', 'catalog', lazyModule('./catalog.js', 'registerCatalogTools'), [31, 27222], { readOnlySafe: true }),
  // #1550: 13 tools / 12814B -> 13 tools / 13018B (+204B), same 13 tools —
  // MEASURED off the real `tools/list`, not estimated. `remove_from_library`'s
  // `dry_run` moved from the bare opt-in `DryRun` fragment to `DryRunDefault`, so
  // the published schema now carries `default: true`, and both the description and
  // the elicitation clause grew. Same tool count: no tool was added or removed.
  // #1567: 13018 -> 13095 measured. `save_to_library` moved from the bare
  // opt-in `DryRun` to `DryRunDefault`, which publishes a longer description
  // and the `"default": true` the host reads, and its own description now says
  // PREVIEWS BY DEFAULT. Same 13 tools, +77 bytes; the derived ceiling moves
  // with the baseline, so nothing is raised here.
  manifestEntry('library', 'library', lazyModule('./library.js', 'registerLibraryTools'), [13, 13095]),
  // #603: playback 12,077 -> 12,210B (+133), same 16 tools — MEASURED, not
  // estimated: the real `tools/list` payload for this module. The get_devices
  // description now names the spotify://player/devices resource so an agent
  // prefers the zero-tool-call read over a call that costs a turn and quota.
  // Then 12,210 -> 13,076B (+866), same 16 tools — #847. `get_queue` absorbed
  // describe_queue, get_queue_snapshot, queue_runtime_report,
  // queue_duplicate_check, predict_next_tracks and queue_profile, and pays for
  // the `view` and `include` parameters and the decision-rule description that
  // replaced six cross-reference descriptions. It is 866B for six tools that
  // cost 2,686B between them, and the six are gone rather than reworded.
  // Re-measure with `npm run count:tools` before raising it again.
  // Re-measured on the merged tree, 2026-09-27, on the module that carries
  // #847, #846 and #848 at once. Two figures, and neither side's own number is
  // the merged one, so quoting either would misattribute the delta:
  //
  //   * #847 added the enriched `get_queue` and the `resolveContextLabel` helper
  //     beside it. That is this module's *base*, not a delta measured here.
  //   * #848 extended `set_volume` and `transfer_playback` to carry the UNION
  //     of the flags the twelve tools they replaced each needed, and retired
  //     `handoff` — the only one of the ten that lived in this module. Re-measured
  //     on this tree that is 16 -> 15 tools; the two survivors are wider, not
  //     more numerous.
  //
  // Re-measured, the byte delta is +1,309B and it is not a saving: the union
  // schemas and the two prose arms they gained cost more than the ten retired
  // rows saved across the five modules, which is what a union is supposed to
  // do. The other nine retirements live in the four modules below and are
  // attributed there, so no single line here has to carry the whole collapse.
  manifestEntry('playback', 'playback', lazyModule('./playback.js', 'registerPlaybackTools'), [15, 14441]),
  // --- from the #848 branch ---
  //
  // #848: the four transfer and eight volume writers became `transfer_playback`
  // and `set_volume`, whose two schemas carry the union of the flags they
  // replaced. Count and bytes are the measured baseline on the line below.
  //
  // Host-session payload impact, measured on the post-rebase tree against
  // `origin/main` rather than derived: the AGGREGATE tools/list went DOWN by ten
  // tools and 5,564 B of per-module schema (533,869 → 528,305 B), so headroom
  // against the AGGREGATE_SURFACE_LIMITS ceiling rose 11,526 → 18,166 B
  // (1.883% → 2.968%). That is the number a host session pays, and it improved.
  // The tool counts themselves are in the generated census block, not here.
  //
  // This module's own ceiling FELL, because it derives from the baseline and the
  // collapsed pair is smaller than the ten tools it replaced — so a caller that
  // loads the `playback` toolset in a trimmed session reads a smaller payload
  // under a smaller bound. Both halves of the ratio improved.
  // --- from origin/main (#846/#847) ---
  // Re-measured when the `runtime` analysis gained `timeline` — the per-item
  // `plays_at_ms` the retired `predict_next_tracks` returned, so the union
  // claim is the union and not a summary of it: 13,076 -> 13,132B (+56). The
  // cost is one clause in the `include` description; the payload it restores
  // is free, because `structuredContent` is not part of the schema a host
  // pays for. Re-measure with `npm run count:tools` before raising it again.
  manifestEntry('following', 'following', lazyModule('./following.js', 'registerFollowingTools'), [3, 2502]),
  manifestEntry('users', 'users', lazyModule('./users.js', 'registerUsersTools'), [2, 1696]),
  manifestEntry('audiobooks', 'audiobooks', lazyModule('./audiobooks.js', 'registerAudiobookTools'), [4, 3715]),
  manifestEntry('audiobookcopilot', 'audiobooks', lazyModule('./audiobookcopilot.js', 'registerAudiobookCopilotTools'), [3, 1985]),

  // #888: +210B across the two playlist tool descriptions. The warrant is
  // disclosure, not decoration: `playlist_subtract` and `playlist_union` can
  // both empty a playlist, and neither said so. `playlist_subtract` also
  // advertised a quota line ("DELETE or PUT") that named a DELETE the tool
  // never issues — it only ever PUTs — so correcting it paid for part of the
  // sentence that states what a full subtraction actually does. 26 tools is
  // unchanged; the byte baseline is the measured value, not a round number.
  //
  // #884: +647B on top of that, 26,329 -> 26,976. `get_playlist` gained the
  // market / fields / additional_types trio `get_playlist_items` already had —
  // 479B of parameters, declared once and forwarded to both calls the tool
  // makes, plus 168B naming them in the description so an agent can find
  // them. The same edit fixes a paging loop that passed `collected.length` as
  // the next offset, so a caller supplying both `offset` and `fetch_all`
  // re-read the head of the playlist. This figure was measured on the merged
  // tree carrying both #888 and #884, not derived by adding the two warrants:
  // 26,119 + 210 + 647 happens to land on the measurement, but the addition is
  // a coincidence of two independent edits and is not how the number was
  // obtained.
  //
  // #1287, RE-MEASURED. Removing the legacy playlist input spellings shrank
  // this module by 2,353B and `playlistops` by 956B; the five other modules
  // that carried a spelling (exhaustmisc, exhaust2playlists, swarm3playlistops,
  // swarm4playlists, playlistfollow) were re-measured the same way — each
  // baseline zeroed, the startup gate allowed to fail loudly, and the figure
  // it reported written back. Every one of the seven ceilings therefore FELL
  // rather than rose: the reclaimed bytes are the alias descriptions, and no
  // warrant was needed because nothing here needed more room. The deltas are
  // the removal itself, not an estimate: 26,214 -> 23,861, 5,348 -> 4,392,
  // 8,324 -> 7,876, 23,326 -> 22,423, 31,587 -> 28,891, 22,016 -> 21,084,
  // 3,065 -> 3,027 (-8,326B in total, which is also the aggregate drop).
  //
  // #872, RE-MEASURED: 23,861 -> 24,253 (+392B) for the SAME 26 tools and the
  // same input schemas — every byte is in two descriptions, and both are the
  // same defect. `playlist_trim` never named the overwrite it performs (it
  // deletes every row outside the kept set), never said the overwrite is
  // confirmed first, and quoted a cost that excluded the two reads the gate
  // and the pre-write re-check add; `playlist_subtract` said it "removes"
  // tracks without saying it rewrites the whole base. A description that
  // understates what a tool destroys is the #922 class this module keeps
  // paying down. Measured, not derived.
  manifestEntry('playlists', 'playlists', lazyModule('./playlists.js', 'registerPlaylistTools'), [26, 26562]),
  manifestEntry('playlistops', 'playlists', lazyModule('./playlistops.js', 'registerPlaylistOpsTools'), [3, 4392]),
  // #727: `batch_add_to_playlist` and `move_items_between_playlists` each gained
  // a lane alternative to their target. Same 3 tools; the byte move is entirely
  // the four new `*_lane` inputs and the reworded descriptions that name them.
  // MEASURED by zeroing the baseline and reading the startup gate's own
  // figure, not estimated.
  manifestEntry('playlistbatch', 'playlistbatch', lazyModule('./playlistbatch.js', 'registerPlaylistBatchTools'), [3, 5558], { scopeKey: 'playlists' }),
  manifestEntry('playlistfollow', 'playlistmisc', lazyModule('./playlistfollow.js', 'registerPlaylistFollowTools'), [4, 3807], { scopeKey: 'playlistfollow' }),
  manifestEntry('playlistmisc', 'playlistmisc', lazyModule('./playlistmisc.js', 'registerPlaylistMiscTools'), [1, 1089], { scopeKey: 'playlists' }),
  manifestEntry('personalization', 'personalization', lazyModule('./personalization.js', 'registerPersonalizationTools'), [3, 2532], { readOnlySafe: true }),
  // #695: baseline is the DEFAULT surface (3 tools). `listening_report` is a
  // derived listening aggregate and registers only under
  // SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS, so the opted-in surface is declared
  // here and the ceiling is sized for the larger of the two — otherwise the
  // gate refuses to START the opted-in server while CI, which measures the
  // default, stays green. See `gatedSurface` and #1128.
  manifestEntry('analytics', 'personalization', lazyModule('./analytics.js', 'registerAnalyticsTools'), [3, 1908], {
    readOnlySafe: true,
    gatedSurface: { gatedBy: 'SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS', toolCount: 4, schemaBytes: 2817 },
  }),

  // #720: the range parameter description now names its accepted values, and
  // statsfm_taste/taste_composites share the one exported schema. Tool counts
  // are unchanged; schema bytes rose 196/46/46 for the longer description, so
  // the derived ceilings move from 24994/15355/8794 to 25208/15405/8844 — under
  // +1% each, against a 592-tool tools/list payload.
  //
  // #906: the only registrar whose 2nd parameter is not a SpotifyClient.
  // stats.fm has its own client and the export's default must win, so the
  // adapt drops the client it is handed rather than passing Spotify's into a
  // stats.fm request.
  // #1006: the six per-entity stream tools now read stats.fm's own per-entity
  // aggregate, and their descriptions say so ("stats.fm's own lifetime stream
  // total … plus a sample of the individual plays"). Tool count is unchanged
  // at 30; the 366 bytes are description text. MEASURED by
  // `npm run count:tools` on 2026-09-27, not estimated.
  //
  // #927: `user_id` became optional so STATSFM_USER_ID can supply it, and the
  // description names that default. Tool count is unchanged at 30. The
  // first draft of that description also carried "; required when that
  // variable is unset", which the thrown error states better and the schema
  // does not need.
  //
  // #1318: `user_id` is now a DEPRECATED ALIAS beside the canonical
  // `statsfm_user`, so the 25 tools in this module that took the old spelling
  // gained a second field rather than renaming one. Both are optional strings
  // with a one-line description, so the cost is the added field alone.
  // MEASURED with `npm run count:tools` on 2026-09-27: 24073 B -> 28623 B
  // (+4550 B, +18.9%). Tool count unchanged at 30. That is a real
  // host-session cost and is stated as one rather than absorbed: a host that
  // reads the schema to choose a field now pays for the notice. The
  // alternative — advertising only the canonical name while still accepting
  // the legacy one — would save these bytes but make a working argument
  // invisible, which is worse than a documented cost.
  //
  // #1297: the three scoped-top tools' `limit`/`offset` descriptions say the
  // bound is applied by this server rather than by stats.fm, because those
  // three routes ignore both parameters upstream. No parameter was added or
  // removed by either change; both are description text. The 24073 B is
  // RE-MEASURED on the merged tree carrying both: 23283 B -> 23575 B for #927
  // (+292 B) and 23283 B -> 23781 B for #1297 (+498 B), and the two overlap
  // on the same three tools rather than adding, so the merged figure is not
  // their sum. MEASURED with `npm run count:tools` on 2026-09-27.
  // #730: `statsfm_recent_streams` gained a `range` parameter — the named
  // stream-window buckets (`today`/`week`/`month`/`year`/`lifetime`). No tool
  // was added, so the count is unchanged at 30; the delta is one parameter's
  // schema and the tool description.
  //
  // The 29181 B is MEASURED on this tree with `node scripts/surface-census.mjs`
  // (`perModuleSchemaBytes.statsfm`), not taken from a branch side and not
  // computed by hand. Note the census's `schemaBudgets` block echoes the
  // manifest baseline rather than the measurement, so it is not the field to
  // read here.
  //
  // It was 24631 B when #730 was written. The rebase onto #1449 (the
  // statsfm identity unification) and #1456 lifted it by ~4.5 KB, because that
  // module now carries the windowing fields, the `range_resolved` block and the
  // longer bounded-read disclosure. The 10% derived ceiling is therefore
  // 32100 B, and the aggregate `tools/list` payload is unchanged by this —
  // a per-module baseline is a measurement of what is there, not a licence.
  //
  // The `range` parameter is deliberately NOT shared with the ranking tools'
  // `statsfmRangeSchema`: this one is resolved locally, while that one is
  // forwarded verbatim to a stats.fm query parameter that answers
  // `400 invalid range` for `year` and every other bucket value.
  //
  // #1514: the shared `statsfm_user` description shipped a real stats.fm
  // account handle as its worked example, in bytes every MCP host receives.
  // The placeholder is 10 B longer than the handle it replaces, and the field
  // is declared on all 30 of this module's tools. MEASURED with
  // `npm run count:tools` on 2026-09-27: 29181 B -> 29481 B (+300 B), tool
  // count unchanged at 30. The `statsfm` ceiling is DERIVED from this baseline
  // (10% over), so it rises with it.
  manifestEntry('statsfm', 'statsfm', lazyModule('./statsfm.js', 'registerStatsfmTools', (register) => (server) => register(server)), [30, 29481], { readOnlySafe: true }),
  // #905: record_feedback gained a `limit` (the list page is bounded now, so
  // the response no longer scales with the store) and its description names
  // the store file and the cap. Tool count is unchanged at 16.
  //
  // MEASURED, not estimated: dist/index.js driven over stdio, tools/list read
  // back, and the budget's own formula applied to the finalized description +
  // inputSchema. 14005 B -> 14735 B (+730 B). The derived ceiling moves with
  // the baseline, so the headroom stays 10% as before rather than being
  // widened to make a breach pass; #927 below moves the baseline again, and
  // the ceiling follows it rather than being restated here.
  //
  // #927: `statsfm_user` became optional with the same STATSFM_USER_ID
  // default, on 7 tools. MEASURED with `npm run count:tools` on 2026-09-27:
  // 14735 B -> 14717 B, NEGATIVE — the schema change drops the field from the
  // JSON Schema's `required` array and the trimmed description costs less than
  // that saves. Tool count unchanged at 16.
  //
  // Host-session payload impact: the whole tools/list response goes
  // 610738 B -> 611468 B (+730 B, +0.12%) across 592 tools, measured the same
  // way on origin/main and on this branch.
  // #908: the eight legacy `taste_*` alias registrations are gone; the module
  // registers its eight canonical `statsfm_*` names only, and the aliases are
  // resolved at the CallTool boundary instead. MEASURED with `npm run
  // count:tools` on 2026-09-27: 16 tools / 14,717 B -> 8 tools / 7,062 B, so the
  // duplicate half was 7,655 B of schema. The baseline moves with the surface —
  // leaving the old one in place would have made the derived ceiling a ceiling
  // for a module that can no longer exist. (A `[n, m]` in this comment is the
  // entry's own baseline; the before/after above is prose on purpose, so
  // `tests/manifest-comment-baseline.test.ts` cannot mistake a superseded
  // figure for a claim about the current surface.)
  //
  // #1318: the seven network-backed tools gain the deprecated `user_id` alias
  // beside `statsfm_user`. MEASURED with `npm run count:tools` on 2026-09-27
  // against this rebased tree: 7062 B -> 8224 B (+1162 B), tool count unchanged
  // at 8. The eighth tool, `statsfm_record_feedback`, makes no network call and
  // declares no identity argument, so it is untouched by the rename.
  //
  // #1514: the `statsfm_user` example handle moved to a placeholder, +10 B on
  // the 7 tools here that declare it. MEASURED with `npm run count:tools` on
  // 2026-09-27: 8224 B -> 8308 B (+84 B), tool count unchanged at 8.
  manifestEntry('taste', 'taste', lazyModule('./statsfm_taste.js', 'registerStatsfmTasteTools'), [8, 8308], { readOnlySafe: true }),
  // #927: same optional `statsfm_user` default as `taste`, on 10 tools.
  // MEASURED with `npm run count:tools` on 2026-09-27: 8040 B -> 7990 B, the
  // same -50 B for the same reason: out of `required`, shorter description.
  // Tool count unchanged at 10.
  // #895 + #1318: both raised this module's schema bytes, and the merged
  // surface is their UNION, so the baseline is measured on the merged tree
  // rather than taken from either side — #895 alone measured 8582 B and
  // #1318 alone measured 9650 B, and neither is the number the other
  // produces. #895 gave 4 of the 10 `max_results` so the shared row cap has a
  // control the caller can raise; #1318 added the same deprecated `user_id`
  // alias across all 10. MEASURED with `node scripts/surface-census.mjs` on
  // 2026-09-27 after merging both onto current main: 10242 B, tool count
  // unchanged at 10. The ceiling is DERIVED by `manifestEntry` (110%), so
  // `Math.ceil(10242 * 1.1)` = 11267 B and this sits inside budget with 1025 B
  // spare.
  //
  // The first measurement of the merged tree read 9924 B, which was 318 B
  // short: the merge had dropped `...StatsfmUserInputFields` from
  // `taste_listening_clock` while its handler still called
  // `resolveStatsfmUserInput`. `check:doc-tool-names` caught it (the cookbook
  // shows that tool taking `statsfm_user`); the schema was restored and the
  // baseline re-measured. A baseline measured against a tree where a tool had
  // lost an input is a ratchet that would have locked the loss in.
  //
  // #1514: the `statsfm_user` example handle moved to a placeholder, +10 B on
  // each of this module's 10 tools. MEASURED with `npm run count:tools` on
  // 2026-09-27: 10242 B -> 10362 B (+120 B), tool count unchanged at 10.
  manifestEntry('tastecomposites', 'tastecomposites', lazyModule('./taste_composites.js', 'registerTasteCompositeTools'), [10, 10362], { readOnlySafe: true }),
  // #927: `taste_to_playlist` declares the same optional `statsfm_user`, so it
  // moves with the module it imports the schema from. MEASURED with
  // `npm run count:tools` on 2026-09-27: 1723 B -> 1718 B, -5 B. Tool count
  // unchanged at 1.
  // #1318: `taste_to_playlist` gains the alias too. MEASURED with
  // `npm run count:tools` on 2026-09-27: 1718 B -> 1884 B (+166 B). Tool
  // count unchanged at 1.
  //
  // #1514: +10 B from the `statsfm_user` placeholder. MEASURED with
  // `npm run count:tools` on 2026-09-27: 1884 B -> 1896 B (+12 B), tool count
  // unchanged at 1.
  manifestEntry('tasteplaylist', 'tastecomposites', lazyModule('./taste_playlist.js', 'registerTastePlaylistTools'), [1, 1896], { scopeKey: 'playlists' }),
  // #726: `statsfm_jukebox` — one tool that proposes playlist replacements and
  // appends from a stats.fm rotation, and applies them only on `dry_run=false`.
  // `scopeKey: 'playlists'` because the commit path writes playlist items, so
  // the playlists scope gate (and the read-only gate, via the module's
  // non-readOnlySafe default) both apply. NOT `readOnlySafe`: the module holds a
  // write, and a read-only session must not see it at all rather than see it and
  // have it refuse.
  //
  // MEASURED, not estimated: the baseline below was zeroed, the server started,
  // and the figure came from the startup budget gate's own report. Writing an
  // estimate here would have set a ceiling that the first real `tools/list` on
  // any host either clears by luck or breaches.
  //
  // #1514 moved the shared `statsfm_user` example handle to a placeholder
  // (+10 B on the field's description). This tool spreads
  // `StatsfmUserInputFields`, so it pays the same +12 B as `tasteplaylist`.
  // RE-MEASURED on the rebased tree, not carried over: 2359 B -> 2371 B
  // (+12 B), tool count unchanged at 1. Carrying the pre-#1514 figure forward
  // would have set a ceiling the tree does not actually meet.
  manifestEntry('tastejukebox', 'tastejukebox', lazyModule('./statsfm_jukebox.js', 'registerStatsfmJukeboxTools'), [1, 2371], { scopeKey: 'playlists' }),
  manifestEntry('doctor', 'doctor', lazyModule('./doctortool.js', 'registerDoctorTool'), [1, 825], { alwaysActive: true, readOnlySafe: true }),
  // #602. `readOnlySafe: true` is a claim about the MODULE, and the module
  // holds a write: what makes that safe is that `readOnlyToolServer` drops
  // `switch_account` per-tool in a SPOTIFY_MCP_READONLY session (it does not
  // start with a read verb, so the allowlist classifier withholds it) while
  // `list_accounts` survives. Marking the module `readOnlySafe: false` instead
  // would hide the listing too, and a read-only operator asking which account
  // they are on is the question that gate most needs to answer.
  // MEASURED, not estimated: the census drives the built server over stdio,
  // reads back the real tools/list, and applies the budget's own formula to the
  // finalized description + inputSchema of the two tools. The baseline pair
  // below is that measurement, and the ceiling is DERIVED from it by
  // `derivePerModuleCeilings` in this file — 10% headroom, unchanged, rather
  // than a ceiling raised to make a breach pass. The host-session payload
  // impact is one more tool's worth on top of the measured origin/main total,
  // recorded in docs/schema-budgets.md.
  manifestEntry('accounts', 'accounts', lazyModule('./accounts.js', 'registerAccountsTools'), [2, 1644], { readOnlySafe: true }),
  // 1624 -> 2023 (#713): toolset_report gained a declared `response_format`, and
  // all three discovery tools now carry the mode-specific description instead of
  // the shared "json = raw API object" wording. +399B once, on a 3-tool module.
  manifestEntry('swarm3meta', 'swarm3meta', lazyModule('./swarm3_meta.js', 'registerSwarm3MetaTools'), [3, 2248], { alwaysActive: true, scopeKey: 'catalog', readOnlySafe: true }),
  // #598. `alwaysActive` for the same reason `swarm3meta` above carries it:
  // the DEFAULT session serves the `prompts` set, and `dj` /
  // `playlist_from_mood` / `discover_weekly_alternative` / `crate_digging` now
  // name this tool. A helper the default prompts reference but that a toolset
  // trim can remove is a name in prose that resolves to nothing, which is the
  // same defect the rate-limit footer was rebuilt to avoid (#715). It is one
  // read-only tool, and the cost of carrying it in every session is the
  // per-module figure measured below.
  //
  // `readOnlySafe: true` is a claim about the MODULE, and it holds: the tool
  // calls no Spotify endpoint and writes no server state. It does issue a
  // `sampling/createMessage` request to the HOST on a sampling-capable
  // session, which spends host tokens — not a mutation of this server or the
  // account, which is the axis `readOnlyHint` describes.
  //
  // Baseline pair MEASURED, not estimated: seeded a deliberately oversized
  // pair, built, then read this module's tool count and schema bytes out of
  // `perModule` / `perModuleSchemaBytes` in `node scripts/surface-census.mjs`.
  // Deliberately NOT read from the census's `schemaBudgets` output, which
  // echoes the manifest baseline back and would only have confirmed the seed.
  // (The seed's own numbers are left out of this comment on purpose: prose
  // that quotes a tool count is read as a claim about this module, which is
  // the same trap `tests/doc-figures.test.ts` exists to catch.)
  //
  // The 987B is the description + inputSchema, which is what the per-module
  // budget measures. The tool's actual cost to the aggregate tools/list was
  // measured separately, by reverting this entry and re-running the census:
  // 591,276B -> 592,376B, so +1,100B. The 113B difference is the tool name and
  // its registry metadata, which the per-module formula excludes by design and
  // the aggregate count includes.
  manifestEntry('moodexpand', 'moodexpand', lazyModule('./moodexpand.js', 'registerMoodExpandTools'), [1, 987], { alwaysActive: true, readOnlySafe: true }),
  // #695: baseline is the DEFAULT surface (3 tools); `listening_heatmap` is a
  // derived listening-clock metric and registers only under
  // SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS. Sized for the larger surface.
  manifestEntry('libraryanalytics', 'libraryanalytics', lazyModule('./libraryanalytics.js', 'registerLibraryAnalyticsTools'), [3, 2498], {
    readOnlySafe: true,
    scopeKey: 'library',
    gatedSurface: { gatedBy: 'SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS', toolCount: 4, schemaBytes: 3351 },
  }),
  // +151B: import_profile_state's description now says the mutation ledger is
  // export-only, so a caller does not expect its history to be restored (#629).
  // The tool count is unchanged.
  // #708: descriptions only, same 11 tools and same input schemas. The baseline
  // in the entry below moved because import_from_sidecar's description now
  // names the path, the date the sidecar declares (exported_at, or the named
  // reason it declares none), the row count, the single use, and
  // consent_note. Measured off the live registry over stdio, not estimated;
  // the derived ceiling follows that baseline.
  manifestEntry('portability', 'portability', lazyModule('./portability.js', 'registerPortabilityTools'), [11, 10453], { scopeKey: 'library' }),
  manifestEntry('libraryinsights', 'library', lazyModule('./libraryinsights.js', 'registerLibraryInsightsTools'), [3, 2751], { scopeKey: 'library' }),
  // +50B: #897 changed only the description, and only to say where the album
  // totals come from — off the /me/tracks walk, with the per-id fan-in as the
  // fallback — because that is now the actual request behaviour. Same 1 tool,
  // same input schema. Host-session impact: +50 B of a 144,943 B default
  // `tools/list` payload (0.03%), on a tool that is NOT in the default
  // toolset, so the always-on session cost is zero. The description was
  // trimmed to fit rather than the ceiling raised beyond the derived 110%.
  manifestEntry('libraryhygiene', 'library', lazyModule('./libraryhygiene.js', 'registerLibraryHygieneTools'), [1, 804], { scopeKey: 'library' }),
  manifestEntry('showradar', 'library', lazyModule('./showradar.js', 'registerShowRadarTools'), [1, 2125], { readOnlySafe: true, scopeKey: 'library' }),
  manifestEntry('saveddedupe', 'library', lazyModule('./saveddedupe.js', 'registerSavedDedupeTools'), [1, 1438], { scopeKey: 'library' }),
  manifestEntry('podcastsession', 'library', lazyModule('./podcastsession.js', 'registerPodcastSessionTools'), [2, 3427], { scopeKey: 'library' }),
  manifestEntry('backupfirst', 'library', lazyModule('./backupfirst.js', 'registerBackupFirstTools'), [1, 513], { readOnlySafe: true, scopeKey: 'library' }),
  manifestEntry('backup', 'library', lazyModule('./backup.js', 'registerBackupTools'), [2, 1844], { readOnlySafe: true, scopeKey: 'library' }),
  manifestEntry('backupdelete', 'library', lazyModule('./backup_delete.js', 'registerBackupDeleteTools'), [1, 959], { readOnlySafe: false, scopeKey: 'library' }),
  // #1592 — the sibling `delete_backup` was missing. Four writers share
  // SPOTIFY_MCP_BACKUP_DIR and only the library-backup one was reachable, so
  // its own row, for the same reason as the row above: a per-registrar row is
  // what makes `readOnlySafe` a property of one safety class rather than of
  // whichever module it happens to be filed under.
  manifestEntry('backupcleanup', 'library', lazyModule('./backup_cleanup.js', 'registerBackupCleanupTools'), [1, 1786], { readOnlySafe: false, scopeKey: 'library' }),
  // #708: descriptions only, same 1 tool and same input schema. The baseline in
  // the entry below moved because restore_library_snapshot's description now
  // names the source, the file-declared date, the item count and the single
  // use, and says explicitly that a missing date is named rather than borrowed
  // from the mtime. Measured off the live registry over stdio, not estimated;
  // the derived ceiling follows that baseline.
  manifestEntry('restore', 'library', lazyModule('./restore.js', 'registerRestoreTools'), [1, 2072], { scopeKey: 'library' }),
  manifestEntry('undo', 'library', lazyModule('./undo.js', 'registerUndoTools'), [2, 1663], { scopeKey: 'library' }),
  manifestEntry('receipts', 'receipts', localModule('src/tools/annotations.ts', 'registerVerifyReceiptTool', registerVerifyReceiptTool), [1, 626], { alwaysActive: true, readOnlySafe: true }),
  // #1550: 1 tool / 1053B -> 1 tool / 1139B (+86B), same 1 tool — MEASURED off the
  // real `tools/list`. `archive_played_episodes` moved to `DryRunDefault` and its
  // description now states the preview default. Its elicitation threshold of 50 is
  // deliberate and documented in the module; this change does not touch it.
  manifestEntry('episodemgmt', 'episodemgmt', lazyModule('./episodemgmt.js', 'registerEpisodeMgmtTools'), [1, 1139], { scopeKey: 'library' }),
  // #900: 2,043 -> 2,235 bytes, description text only. The tool count, its
  // input schema and its output are unchanged. `whats_new`'s quota sentence
  // said "N followed artists = N+1 API requests ... each lookup is an API
  // request", which became conditionally false the moment the album lookup
  // became the shared canonical probe: a repeat scan inside the cache window
  // spends a probe and no request. The sentence now says that. Left at 2,043
  // the module's 10% ceiling would have been 2,248, and the reworded
  // description at 2,235 would have cleared it by 13 bytes; re-baselined to
  // the measured 2,235 the ceiling is 2,459 and it clears by 224.
  //
  // Re-measured on the post-rebase tree, not carried over from the pre-rebase
  // branch: the number is read off the live registry, not computed from the
  // description. It happens to land on the same 2,235 the branch measured
  // before the rebase, but that is a coincidence of this description, not a
  // reason to have skipped the measurement.
  // TWO issues land on this one module key, and both of them reworded the same
  // `whats_new` description — so their baselines were never independent and
  // neither number survived the rebase on its own. `whats_new` IS the freshness
  // module; there is no separate `whatsnew` entry, and a rebase that treated
  // these as two modules would silently keep whichever wrote last.
  //
  //   #900: 2,043 -> 2,235. The quota sentence said "N followed artists = N+1
  //   API requests ... each lookup is an API request", which became
  //   conditionally false when the album lookup became the shared canonical
  //   probe: a repeat scan inside the cache window spends a probe and no
  //   request.
  //   #679: 2,043 -> 2,284. The same sentence stated the wrong arithmetic: the
  //   walk pages /me/following at 50 per request, so a budget above 50 costs
  //   MORE than one follow page, and the flat "+1" ignored the podcasts leg.
  //
  //   Both corrections are in the merged text, so the baseline is neither
  //   2,235 nor 2,284: it is measured at 2,499 on the merged tree, against the
  //   2,459 ceiling the 2,235 baseline would have derived. Re-measured, not
  //   carried — a stale baseline here sits UNDER its own derived ceiling, so
  //   no gate would have caught it.
  //
  //   Measured by the startup gate's own `serializedSchemaBytes` (the
  //   authoritative per-module figure — compact JSON of description +
  //   finalized inputSchema, the payload tools/list serves), which reported
  //   "freshness ... 1 tools/2499B". Tool count, input schema and output are
  //   unchanged by either issue; the delta is description text only. Derived
  //   ceiling: 1 + 1 = 2 tools, ceil(2,499 * 1.1) = 2,749B. No ceiling raised
  //   above what the measurement warrants.
  //
  //   #724 is a third issue on the same module key, and the same rule applies
  //   to it: its own `since` description text is the only thing that moved, and
  //   it moved because the watermark is now per kind and an explicit date no
  //   longer writes the file — a host picks arguments from the schema, not from
  //   docs/configuration.md, so the sentence has to be there. Re-measured on
  //   the tree this lands in, not carried from the branch: 2,499 -> 2,672.
  //   Tool count still 1; derived ceiling still 2 tools, now
  //   ceil(2,672 * 1.1) = 2,940B.
  //
  //   This one needed no raise to get in: 2,672 clears the 2,749 ceiling that
  //   the pre-#724 baseline of 2,499 already derived, by 77 bytes. The
  //   re-baseline to the measured 2,672 is the same bookkeeping as #900/#679 —
  //   the row must keep meaning "measured" — so 2,940 is headroom for a future
  //   change, not an admission of this one.
  manifestEntry('freshness', 'following', lazyModule('./freshness.js', 'registerFreshnessTools'), [1, 2672], { readOnlySafe: true, scopeKey: 'following' }),
  manifestEntry('searchdive', 'search', lazyModule('./searchdive.js', 'registerSearchDeepTool'), [1, 1683], { readOnlySafe: true, scopeKey: 'search' }),
  manifestEntry('searchhistory', 'searchhistory', lazyModule('./searchhistory.js', 'registerSearchHistoryTools'), [2, 1096], { readOnlySafe: true, scopeKey: 'search' }),
  manifestEntry('browse', 'browse', lazyModule('./browse.js', 'registerBrowseTools'), [1, 436], { readOnlySafe: true, scopeKey: 'catalog' }),
  manifestEntry('artistwatch', 'artistwatch', lazyModule('./artistwatch.js', 'registerArtistWatchTools'), [6, 6284], { scopeKey: 'catalog' }),
  manifestEntry('queueops', 'queueops', lazyModule('./queueops.js', 'registerQueueOpsTools'), [3, 3293], { scopeKey: 'playback' }),
  // Re-measured on the merged tree, 2026-09-27, carrying #846, #847 and #848.
  // #846 alone took this module 13 -> 14 tools and 8,178 -> 8,852B — the one
  // tool that writes the canonical playback-position record. #848 then retired
  // `apply_device_presets` into `set_volume { op: 'preset' }`, so 14 -> 13.
  // Re-measured after that, bytes fell by 521: the retired row, less the one
  // clause the survivor's `op` description gained.
  manifestEntry('playbackext', 'playbackext', lazyModule('./playbackext.js', 'registerPlaybackExtTools'), [13, 8331], { scopeKey: 'playback' }),
  // --- from the #848 branch ---

  // --- from origin/main (#846/#847) ---
  // Re-measured on the tree that carries BOTH #846 and #847, 2026-09-27:
  // 13 -> 14 tools and 8,178 -> 8,852B (+674). #846 adds the one tool that
  // writes the canonical playback-position record; #847's queue collapse does
  // not touch this module, so this figure is the #846 delta measured on a
  // post-#847 tree rather than either change's own measurement.
  // playbackintel 11,837 -> 11,882B (+45) is #851: market_availability's
  // description now names the concurrent batch, is_playable, and the
  // per-market failure reason it reports. Tool count is unchanged at 15 — the
  // tool is not retired, its return shape is. Measured from the real
  // `tools/list` over stdio, not estimated.
  // Then 11,882 -> 11,773B (-109) when #922 reworded this module's quota
  // cost in words: the quota-circle glyphs and the cross-sell breadcrumbs
  // come out of the 15 descriptions. The two deltas compose, and neither is
  // Re-measured on the merged tree, 2026-09-27. The 14 tools #847 left is the
  // figure this tree inherits; #848 retired `volume_step` into
  // `set_volume { op: 'level', delta_step }`, so 14 -> 13. Re-measured, bytes
  // fell by 783 — the retired row is most of it, the rest the `set_volume`
  // cross-sell the survivor's description picked up. A merged measurement, not
  // either change's own.
  manifestEntry('playbackintel', 'playbackintel', lazyModule('./playbackintel.js', 'registerPlaybackIntelTools'), [13, 10315], { scopeKey: 'playback' }),
  // --- from the #848 branch ---
  // measured off the other's tree.
  // #848 re-measured the module at 10,990B: volume_step became set_volume's
  // `delta_step`, so this is 14 tools rather than 15. Measured from the real
  // `tools/list` over stdio, on the branch, not estimated.
  // --- from origin/main (#846/#847) ---
  // measured off the other's tree — this figure is the merged measurement.
  // Re-measured after #847, which retired describe_queue into `get_queue`
  // view='enriched' and gave peek_next the decision rule that used to be
  // spread across a See-also chain: 15 -> 14 tools and 11,773 -> 11,098B
  // (-675). 737B of the reduction is describe_queue's own row; the rest is
  // the cross-sell breadcrumbs those two descriptions carried.
  manifestEntry('scenes', 'playback', lazyModule('./scenes.js', 'registerScenesTools'), [7, 4514], { scopeKey: 'playback' }),
  manifestEntry('playlisthealth', 'playlisthealth', lazyModule('./playlisthealth.js', 'registerPlaylistHealthTools'), [8, 5713], { scopeKey: 'playlists' }),
  manifestEntry('playlistdna', 'playlists', lazyModule('./playlistdna.js', 'registerPlaylistDnaTools'), [1, 1310], { readOnlySafe: true, scopeKey: 'playlists' }),
  // #727: the lane registry. Two READ-ONLY tools, so `readOnlySafe: true` —
  // `list_lanes` and `lane_status` issue `GET /playlists/{id}` reads and no
  // write of any kind, which is what keeps them visible in a read-only session.
  // The lane→playlist RESOLUTION lives in `src/lanes.ts` and is called by the
  // writing tools (playlistbatch), not here; this row is the read side.
  // 1,824B is MEASURED — the baseline was zeroed and the startup gate printed
  // `2 tools/1824B`, the same projection `tools/list` gives a host. No ceiling
  // was hand-raised: the derived ceiling is 1 tool / 2,007B, so the next tool
  // or description edit to this module has to come back through here.
  manifestEntry('lanes', 'lanes', lazyModule('./lanes.js', 'registerLaneTools'), [2, 1824], { readOnlySafe: true, scopeKey: 'playlists' }),
  manifestEntry('export', 'playlists', lazyModule('./export.js', 'registerExportTools'), [1, 1363], { scopeKey: 'playlists' }),
  // #708: descriptions only, same 1 tool and same input schema. The baseline in
  // the entry below moved because import_playlist's description now names the
  // record it publishes and the fact that a batch under 100 new URIs is not
  // gated. The detail had to stay out of the description and into SPEC.md §5.6
  // — this module's derived 110% ceiling is the gate that says a longer version
  // of that sentence is not worth a ceiling raise. Measured off the live
  // registry over stdio, not estimated.
  manifestEntry('import', 'playlists', lazyModule('./import.js', 'registerImportTools'), [1, 1322], { scopeKey: 'playlists' }),
  manifestEntry('smart', 'playlists', lazyModule('./smart.js', 'registerSmartTools'), [1, 2364], { scopeKey: 'playlists' }),
  // #1550: 10 tools / 7876B -> 10 tools / 8291B (+415B), same 10 tools — MEASURED
  // off the real `tools/list`. `unsave_orphan_tracks` and
  // `remove_from_library_by_playlist` both moved to `DryRunDefault`; the schema
  // gain is two `default: true` keys, the rest is description prose stating the
  // confirmation requirement.
  manifestEntry('exhaustmisc', 'playlists', lazyModule('./exhaustmisc.js', 'registerExhaustMiscTools'), [10, 8291], { scopeKey: 'exhaustmisc' }),



  // Measured post-#1004 (the artist leg reads /artists/{id} now), of which
  // +226B is #781: `search_by_isrc` and `audiobooks_by_author` gained the
  // `offset` input their paging signal already pointed at. Not a new tool and
  // not a wider payload — a control that makes an already-emitted next_offset
  // actionable, and the truncation boundary keeps it only because the schema
  // declares it. Then -95B when #922 removed the quota-circle glyphs and the
  // cross-sell breadcrumbs from this module's descriptions, which cost nothing
  // and read less to a model that does not weight emoji. #1224 then added 71B
  // for the same 19 tools: the three read legs now name the per-id fan-out
  // they perform instead of a batch call Spotify removed.
  // [19, 19443]
  manifestEntry('exhaust2catalog', 'exhaust2catalog', lazyModule('./exhaust2_catalog.js', 'registerExhaust2CatalogTools'), [19, 19443], { readOnlySafe: true, scopeKey: 'catalog' }),
  manifestEntry('exhaust2enggating', 'exhaust2enggating', lazyModule('./exhaust2_enggating.js', 'registerExhaust2EnggatingTools'), [0, 0], { readOnlySafe: true, scopeKey: 'catalog' }),
  // #695 moved two words in this module's descriptions: `most_replayed` and
  // `weekday_heatmap` no longer point at `listening_report` / `listening_heatmap`
  // by name, because those are derived analytics the default registry does not
  // serve and a description must not advertise a tool that is absent. +45B.
  // Re-measured on the merged tree, 2026-09-27. The figure this tree inherits
  // from #846 and #847 was 22 tools; #848 moved `mute`, `unmute`,
  // `switch_device` and `room_level` into `set_volume` and `transfer_playback`
  // in playback.ts, where the duplicate writers already were, so 22 -> 18.
  // Re-measured, bytes fell by 3,034 — the largest per-module share of the
  // collapse. The timer/ramp family stayed here because a scheduled ramp is a
  // different operation, not a differently-spelled one.
  // #1638: `weekday_heatmap`'s description now names the frame it buckets in
  // ("UTC weekday"), so this module's measured schema bytes moved. The figure
  // on the line below is a measurement -- take it from
  // `node scripts/surface-census.mjs`, never from the length of the edit.
  manifestEntry('exhaust2playback', 'exhaust2playback', lazyModule('./exhaust2_playback.js', 'registerExhaust2PlaybackTools'), [18, 14283], { scopeKey: 'playback' }),
  // --- from the #848 branch ---

  // --- from origin/main (#846/#847) ---
  // Re-measured after #847 retired queue_profile into `get_queue`
  // include=['profile']: 23 -> 22 tools, 17,518 -> 17,050B. The module's
  // other 22 tools are untouched, so the whole delta is that one row leaving
  // the surface.
  // 22 tools is #847's figure and it holds on this tree; #846 changed no
  // registration here, only the descriptions of the ones that stayed. Bytes
  // are re-measured, not composed: 17,050 -> 17,313B (+263) on the tree that
  // carries both changes. The 23 -> 22 step and the byte rise have different
  // causes, and quoting either side's number would attribute both to one.
  manifestEntry('exhaust2playlists', 'exhaust2playlists', lazyModule('./exhaust2_playlists.js', 'registerExhaust2PlaylistsTools'), [18, 24403], { scopeKey: 'playlists' }),
  // [27, 24664] measured from the real registrar (tools: 556). The +230B over
  // #896's 24,316B is #1533: `export_playlist_json`'s description now names
  // the item walk's cap, the two truncation keys, and what `total_tracks` is
  // (and is not) — a description that only held on a whole read has to say
  // which read it means, the same rule #1388 applied to `playlist_balance`.
  // The earlier +450B was #896: `playlist_staleness_report` gained the shared
  // `DryRunScan` preview and the two scan tools' longer truthful-cost prose.
  // Tool count is unchanged at 27 across both — new INPUT properties and
  // description text, not new tools — so this is a re-measure of the same
  // surface, not a ceiling raise to make a breach pass. The derived ceiling
  // follows the baseline (ceil(24664 * 1.1) = 27131B).
  //
  // The 24,664B is measured on this tree after the rebase onto main, not
  // carried over from either side of the conflict: main quoted 24,434B and
  // this branch quoted 24,546B, and the surface here matches neither. A
  // baseline is a measurement of the tree it sits in, and the registry-wide
  // count it would have to be qualified against is itself a generated figure.
  manifestEntry('exhaust2misc', 'exhaust2misc', lazyModule('./exhaust2_misc.js', 'registerExhaust2MiscTools'), [27, 24664], { scopeKey: 'library' }),
  // #898: 3,695 -> 4,039 bytes (+344B, +9.3%) for the SAME three tools and the
  // same input schemas — every byte is the two descriptions, which now state
  // what the playlist walk costs per ref and that a capped walk reports
  // `truncated` with `total` and `returned`. Tool count is unchanged, re-measured
  // at 3 tools / 4,039B on the merged tree. Aggregate re-measured through the
  // real registry over stdio at 610,728B against the 621,000B enforced ceiling
  // (the SWEEP-2026-09 grant) — 10,272B of headroom, so this is absorbed without
  // a raise of AGGREGATE_SURFACE_LIMITS. The old quota line says "N GETs" for a
  // walk that issues up to N x (1 + fetchAllCap/100) requests, so the agents
  // paying for that are the ones this sentence is for.
  manifestEntry('exhaust2extra', 'exhaust2extra', lazyModule('./exhaust2_extra.js', 'registerExhaust2ExtraTools'), [3, 4092], { scopeKey: 'playlists' }),
  // #900 + #1224: descriptions only, same 24 tools and same input schemas.
  // #900 reworded four descriptions that quoted a per-artist cost that a warm
  // read cache invalidates, so each now names the shared canonical probe and
  // what it costs when the cache already holds it. #1224 then reworded those
  // same descriptions again: the batched `?ids=` read is gone, so they now
  // describe the per-id `GET /albums/{id}` fan-in these tools actually perform.
  //
  // RE-MEASURED on the merged tree carrying both changes. The pre-rebase branch
  // figure was measured before main moved, and main had since reworded this
  // module; carrying either side's number forward would be a lie in a
  // hand-maintained baseline the startup gate treats as ground truth, and a
  // slightly-stale value usually still sits under its own derived ceiling, so
  // no gate would catch it. Read off the live registry after the rebase.
  manifestEntry('swarm3discovery', 'swarm3discovery', lazyModule('./swarm3_discovery.js', 'registerSwarm3DiscoveryTools'), [24, 22483], { readOnlySafe: true, scopeKey: 'catalog' }),
  // #1224 +33B, same 24 tools: six tool descriptions now quote one
  // GET /albums/{id} per release rather than a batched /albums lookup.
  manifestEntry('swarm3bdiscovery', 'swarm3bdiscovery', lazyModule('./swarm3b_discovery.js', 'registerSwarm3bDiscoveryTools'), [24, 20147], { readOnlySafe: true, scopeKey: 'catalog' }),
  // #1550: 24 tools / 22103B -> 24 tools / 22344B (+241B), same 24 tools — MEASURED
  // off the real `tools/list`. `remove_saved_shows` and `remove_saved_episode`
  // already previewed by default; this change adds only the missing elicitation
  // gate and the description clause that names it. No schema field changed.
  manifestEntry('swarm3shows', 'swarm3shows', lazyModule('./swarm3_shows.js', 'registerSwarm3ShowsTools'), [24, 22344], { scopeKey: 'catalog' }),
  manifestEntry('swarm3refs', 'swarm3refs', lazyModule('./swarm3_refs.js', 'registerSwarm3RefsTools'), [6, 4331], { readOnlySafe: true, scopeKey: 'catalog' }),
  // The figures this module used to carry — 24 tools, 18951B, measured
  // post-#1004 (top_genre_census reads /artists/{id} now) — are now its
  // `gatedSurface` below rather than its baseline. Written without bracket
  // notation on purpose: this comment is scanned for [n, m] pairs and a
  // quoted pair here would read as a claim about the baseline.
  // #695: baseline is the DEFAULT surface (15 tools). Nine of these 24 compute
  // derived listening metrics and register only under
  // SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS. Sized for the larger surface, so the
  // opted-in server passes the same startup budget gate the default one does.
  manifestEntry('swarm3analytics', 'swarm3analytics', lazyModule('./swarm3_analytics.js', 'registerSwarm3AnalyticsTools'), [15, 12030], {
    readOnlySafe: true,
    scopeKey: 'personalization',
    gatedSurface: { gatedBy: 'SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS', toolCount: 24, schemaBytes: 18951 },
  }),
  manifestEntry('swarm3library', 'swarm3library', lazyModule('./swarm3_library.js', 'registerSwarm3LibraryTools'), [24, 18283], { readOnlySafe: true, scopeKey: 'library' }),
  // Re-measured on the merged tree, 2026-09-27. The figure this tree inherits
  // from #847 and #846 was 20 tools; #848 retired
  // `plan_volume_level_across_devices`, `apply_volume_plan` and
  // `transfer_playback_with_state` into the two playback.ts survivors, so
  // 20 -> 17. Re-measured, bytes fell by 2,535. The queue planners that remain
  // — split_queue_plan, queue_prune_plan, sleep_timer_plan — are untouched by
  // any of the three changes.
  manifestEntry('swarm3playback', 'swarm3playback', lazyModule('./swarm3_playback.js', 'registerSwarm3PlaybackTools'), [17, 10006], { scopeKey: 'playback' }),
  // --- from the #848 branch ---

  // --- from origin/main (#846/#847) ---
  // Re-measured after #847 retired get_queue_snapshot, queue_runtime_report,
  // queue_duplicate_check and predict_next_tracks into `get_queue`:
  // 24 -> 20 tools, 14,043 -> 12,113B. The four local analyses they ran live
  // on in src/queueanalysis.ts, and the queue planners that remain
  // (split_queue_plan, queue_prune_plan, sleep_timer_plan) are unchanged.
  // 20 tools is #847's figure (24 -> 20, the four queue readers it retired),
  // and it holds on this tree. Bytes re-measured: 12,113 -> 12,541B (+428),
  // which is #846 rewiring the survivors onto the shared record rather than
  // any change in how many there are.
  manifestEntry('swarm3playlistops', 'swarm3playlistops', lazyModule('./swarm3_playlistops.js', 'registerSwarm3PlaylistopsTools'), [24, 29163], { scopeKey: 'playlists' }),
  // #708: descriptions only, same 24 / 18 tools and same input schemas.
  // restore_playlist_from_snapshot and apply_snapshot_changes now say that
  // their result records the snapshot source, the file-declared date and the
  // use — and that neither tool gates — so an agent can tell a recorded
  // purpose from an approved one.
  manifestEntry('swarm3snapshots', 'swarm3snapshots', lazyModule('./swarm3_snapshots.js', 'registerSwarm3SnapshotsTools'), [24, 23829], { scopeKey: 'playlists' }),
  // Two description changes, measured together on the merged tree: #708's
  // provenance wording and #1388's disclosure wording. Neither side's number
  // survives the merge — each was measured on a tree that lacked the other's
  // text — so both are re-measured below rather than picked.
  //
  // #1388, and the +192B is entirely one description: `playlist_balance`
  // claimed "interleave (round-robin deal, so every part samples the whole
  // span)" and then split a walk bounded at `SPOTIFY_MCP_FETCH_ALL_CAP`, so
  // the span it sampled was the READ's span and not the playlist's — and the
  // description said otherwise to every host before the call. It now names
  // the ceiling and points at the payload fields that say whether the split
  // was whole. The tool's answer is unchanged for any playlist at or below
  // the cap, so this is description text paying for a claim that was false.
  manifestEntry('swarm4playlists', 'swarm4playlists', lazyModule('./swarm4_playlists.js', 'registerSwarm4PlaylistsTools'), [18, 23228], { scopeKey: 'playlists' }),


] as const;

interface SchemaRegistryEntry {
  description?: string;
  inputSchema?: unknown;
  /**
   * A tool's declared output schema (#1376). Present in the SDK registry and
   * emitted by the tools/list boundary, but absent from this interface until
   * now — which is how a budget could be computed over a registry whose type
   * did not admit the field it was failing to charge for.
   */
  outputSchema?: unknown;
  enabled?: boolean;
}

/**
 * The same private registry, read for the budget paths. `SchemaRegistryEntry` is
 * a narrower view of the same value — the fields a schema budget measures — so
 * this is a second named shape rather than a second inline cast.
 */
function schemaRegistryEntries(server: McpServer): Record<string, SchemaRegistryEntry> {
  return (server as unknown as { _registeredTools?: Record<string, SchemaRegistryEntry> })._registeredTools ?? {};
}

interface ServerModuleMetadata {
  statuses: Map<string, ModuleRegistrationStatus>;
  tools: Map<string, string[]>;
  budgetRows?: readonly ModuleSchemaBudget[];
}

const SERVER_METADATA = new WeakMap<McpServer, ServerModuleMetadata>();

function serverMetadata(server: McpServer): ServerModuleMetadata {
  const existing = SERVER_METADATA.get(server);
  if (existing) return existing;
  const created: ServerModuleMetadata = { statuses: new Map(), tools: new Map() };
  SERVER_METADATA.set(server, created);
  (server as unknown as { __spotifyModuleSchemaBudgets?: () => ModuleSchemaBudget[] }).__spotifyModuleSchemaBudgets =
    () => collectModuleSchemaBudgets(server);
  return created;
}

/**
 * The names of every tool this server has registered, right now.
 *
 * Exported because the naming-policy check in `src/server.ts` needs the same
 * list, and the alternative was for that call site to repeat the private-field
 * cast this module already owns. One reader of `_registeredTools`, used by
 * everyone: a second cast is a second claim about the SDK's internals, and the
 * `tests/payload-casts.test.ts` ratchet counts claims.
 */
export function registeredToolNames(server: McpServer): string[] {
  const registry = schemaRegistryEntries(server);
  return Object.keys(registry);
}

export function moduleRegistrationStatus(
  module: RegistrarManifestEntry,
  context: RegistrarManifestContext,
): ModuleRegistrationStatus {
  // The hard gates stay ahead of the scope filter: a toolset-trimmed or
  // read-only-hidden module registers nothing at all, so a reduced scope
  // grant must not become a way to surface its tools in a READONLY session
  // (#111). Scope filtering only ever splits a module that would otherwise
  // have been fully active — a missing write scope hides the writes (which
  // could only 403) instead of the reads the grant still carries (#1020).
  //
  // `alwaysActive` buys a row exemption from the TOOLSET gate only, which is
  // what it was introduced for (doctor/receipts/swarm3meta must survive a
  // trimmed SPOTIFY_MCP_TOOLSETS so they can report the trimming). It was
  // never a safety claim. Applying it to the read-only gate as well made that
  // gate fail OPEN for a whole class of rows: a manifest entry added as
  // `alwaysActive: true` without `readOnlySafe: true` registered its tools in
  // SPOTIFY_MCP_READONLY sessions, which is precisely the "hides every
  // write-capable module" guarantee being sold and not kept (#579). The three
  // rows that carry the flag today are all `readOnlySafe`, so no shipped
  // surface changes — what changes is that the next such row fails closed.
  //
  // An explicit `SPOTIFY_MCP_DISABLE_TOOLS` entry outranks that exemption
  // (#580). `alwaysActive` was introduced to keep doctor/receipts/swarm3meta
  // on the surface under a trimmed SPOTIFY_MCP_TOOLSETS so a trimmed server
  // can still explain itself — it is a statement about SET MEMBERSHIP, not a
  // claim that the operator cannot name the key. Reading it as the latter made
  // `DISABLE_TOOLS=swarm3meta` a no-op that the resolver accepted, so the key
  // produced neither a registered module nor a warning: the one failure mode
  // where the override is both documented and silently untrue. The disable term
  // is therefore consulted on its own, before the exemption is applied. It
  // lands on the same status as a trim, because from the host's side it is
  // the same fact — this module registers nothing — and a status that named
  // the operator's own request differently would read as a bug.
  if (context.disableOverrides.has(module.registrationKey.toLowerCase())) return 'toolset_trimmed';
  if (!module.alwaysActive && !context.isModuleActive(module.registrationKey)) return 'toolset_trimmed';
  if (context.readOnly && module.readOnlySafe !== true) return 'read_only_hidden';
  // A row the manifest declares `readOnlySafe` has, by that declaration, no
  // writes to hide — and `WRITE_SCOPE_REQUIREMENTS` is a table of WRITE
  // requirements. Scope-filtering such a row runs the name-driven
  // classification over a module that cannot mutate, so a tool whose name does
  // not start with an allowlisted read verb (`whats_new`, `library_coverage_report`,
  // `saved_albums_by_year`, `grow_playlist`) is dropped from a grant that
  // authorises it. That is the #1005 shape — an unknown-tool error for a
  // legitimate call — reached from the other direction. Measured on the `core`
  // grant: 7 readOnlySafe rows are scope-blocked, and every tool in them whose
  // name is not an allowlisted read verb is dropped — 29 of them, together the
  // difference between a first-time user's read surface with and without this
  // line. (The counts are deliberately not written here: a bare registry-scale
  // figure in hand-maintained text is what scripts/check-doc-tool-counts.mjs
  // exists to reject. tests/scope-profile.test.ts measures the surface
  // instead.)
  //
  // It only became visible at the default, not at the edges: #700 narrowed the
  // unconfigured grant to the `core` profile, so EVERY fresh auth run now
  // scope-filters these rows, where before only a user who had hand-narrowed
  // SPOTIFY_SCOPES saw it.
  //
  // Fail-open by design, and made safe by an enforced invariant rather than by
  // trust: tests/manifest-readonly-rows.test.ts already fails if any
  // `readOnlySafe` row registers a tool that calls client.post/put/delete/patch
  // (or one of the commit helpers that wraps them). A row that grows a real
  // Spotify write therefore has to lose the flag — or that test goes red —
  // before this exemption can expose it.
  if (module.readOnlySafe === true) return 'active';
  return context.scopeBlocked(module.scopeKey ?? module.registrationKey) ? 'scope_filtered' : 'active';
}

/**
 * Wrap `server` so a module whose write scope was not granted can still
 * register the tools that only read. Registration calls for anything
 * `classifyToolAnnotations` cannot prove read-only are dropped, so the gate
 * hides the writes (which could only 403) instead of hiding the reads the
 * consent screen still asked for — `get_saved_tracks` used to disappear from
 * tools/list together with `save_to_library` (#1020).
 *
 * The classifier is an allowlist: a name that does not start with a read verb
 * is classified a write, so an unanticipated tool is withheld rather than
 * exposed. Every other property is forwarded to the real server with `this`
 * bound to it, so registrars that read `_registeredTools` (doctor, swarm3_meta)
 * still see the true registry.
 */
function readOnlyToolServer(server: McpServer): McpServer {
  const isReadable = (name: unknown): boolean =>
    typeof name === 'string' && classifyToolAnnotations(name).readOnlyHint === true;
  return new Proxy(server, {
    get(target, property) {
      if (property === 'tool' || property === 'registerTool') {
        return (...args: unknown[]): void => {
          if (!isReadable(args[0])) return;
          const register = Reflect.get(target, property, target) as (...call: unknown[]) => unknown;
          register.apply(target, args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Which manifest module already owns a tool name, or undefined.
 *
 * Ownership is only recorded for modules that registered through
 * `registerManifestModule`, which is every module: the manifest is the single
 * list and `src/index.ts` iterates nothing else.
 */
function owningModuleKey(metadata: ServerModuleMetadata, toolName: string): string | undefined {
  for (const [key, names] of metadata.tools) {
    if (names.includes(toolName)) return key;
  }
  return undefined;
}

/**
 * The MCP SDK aborts a duplicate registration with `Tool <name> is already
 * registered`, which names the collision and nothing about who caused it. In a
 * 71-module manifest the stack points at the second registration, so the report
 * leaves the reader to work out which of the other 70 modules owns the name —
 * and startup dies before any test can add that context. #662 wants both
 * modules named, so recover the name from the SDK's own message and annotate.
 *
 * Falls through to the original error when the message does not match: an
 * unrecognised failure must keep its own diagnostics rather than be rewritten
 * as a collision that did not happen.
 */
function annotateDuplicateRegistration(
  error: unknown,
  metadata: ServerModuleMetadata,
  module: RegistrarManifestEntry,
): unknown {
  const message = error instanceof Error ? error.message : String(error);
  const collision = /^Tool (\S+) is already registered$/.exec(message)?.[1];
  if (!collision) return error;
  const owner = owningModuleKey(metadata, collision);
  if (!owner || owner === module.key) return error;
  return new Error(
    `${message} — "${collision}" is registered by the "${owner}" module and re-registered by ` +
    `"${module.key}" (${module.file}). A name may belong to exactly one module; rename or remove one.`,
    { cause: error },
  );
}

/** Register one manifest module and retain its exact tool-name ownership. */
export function registerManifestModule(
  server: McpServer,
  client: SpotifyClient,
  module: RegistrarManifestEntry,
  context: RegistrarManifestContext,
): void {
  const metadata = serverMetadata(server);
  const status = moduleRegistrationStatus(module, context);
  metadata.statuses.set(module.key, status);
  if (status === 'toolset_trimmed' || status === 'read_only_hidden') return;
  if (!module.registrar) {
    // Fail loudly rather than registering nothing. A caller that skipped
    // `loadManifestRegistrars` used to get every tool in the manifest; now it
    // would get a silently emptier tools/list that still passes every budget
    // gate, because a module with no tools is exempt from its own ceiling.
    throw new Error(
      `manifest module "${module.key}" (${module.file}) has no loaded registrar: `
        + 'resolve it with loadManifestRegistrars() before registering',
    );
  }
  const before = new Set(registeredToolNames(server));
  try {
    module.registrar(status === 'scope_filtered' ? readOnlyToolServer(server) : server, client);
  } catch (error) {
    throw annotateDuplicateRegistration(error, metadata, module);
  }
  metadata.tools.set(module.key, registeredToolNames(server).filter((name) => !before.has(name)));
  metadata.budgetRows = undefined;
}

/**
 * Whether a module will register anything at all under `context` — the
 * complement of `registerManifestModule`'s early return.
 *
 * Kept next to that early return on purpose: the load decision and the
 * registration decision have to be the same predicate, or a module could be
 * imported for nothing (the cost #906 is removing) or loaded-but-skipped.
 */
function moduleWillRegister(module: RegistrarManifestEntry, context: RegistrarManifestContext): boolean {
  const status = moduleRegistrationStatus(module, context);
  return status !== 'toolset_trimmed' && status !== 'read_only_hidden';
}

/**
 * Import every module that is about to register, and return the manifest with
 * those registrars resolved (#906).
 *
 * The returned array keeps manifest order, and trimmed modules come back
 * unresolved rather than dropped, so the caller still walks the full manifest
 * and `registerManifestModule` still records a status row for every module —
 * which `toolset_report` and the per-module budget table both read.
 *
 * Imports run concurrently. That does not reorder registration: registration
 * happens afterwards, in a plain `for` loop over this array, so `tools/list`
 * order is byte-identical to the pre-lazy tree. (Module *evaluation* order is
 * not guaranteed, but the registrars are pure function definitions — the tree
 * already evaluated them in import order and nothing read a module-level
 * side effect during evaluation.)
 */
export async function loadManifestRegistrars(
  modules: readonly RegistrarManifestEntry[],
  context: RegistrarManifestContext,
): Promise<RegistrarManifestEntry[]> {
  const resolved = await Promise.all(modules.map(async (module) =>
    moduleWillRegister(module, context) ? { ...module, registrar: await module.load() } : module));
  return resolved;
}

/**
 * The production registration path: import only what registers, then register
 * in manifest order.
 *
 * Everything downstream — the naming policy, the per-module schema budget
 * gate, annotation application, the error boundary and the aggregate surface
 * gate — still runs in `startMcpServer` after this returns, against a registry
 * that holds every tool the process will serve. Laziness changes WHEN a module
 * is evaluated, never WHETHER a module that serves tools is measured.
 */
export async function registerManifestModules(
  server: McpServer,
  client: SpotifyClient,
  context: RegistrarManifestContext,
  modules: readonly RegistrarManifestEntry[] = REGISTRAR_MANIFEST,
): Promise<void> {
  for (const module of await loadManifestRegistrars(modules, context)) {
    registerManifestModule(server, client, module, context);
  }
}

/** Tool names owned by one manifest module for wire-level audit tests/reports. */
export function moduleToolNames(server: McpServer, moduleKey: string): readonly string[] {
  return serverMetadata(server).tools.get(moduleKey) ?? [];
}

/** UTF-8 bytes for description + the same JSON Schema emitted by tools/list. */
export function serializedSchemaBytes(
  schema: Pick<SchemaRegistryEntry, 'description' | 'inputSchema' | 'outputSchema'>,
  toolName?: string,
): number {
  const inputSchema = applyStableListDefaults(toolName ?? '', finalInputSchema(schema.inputSchema));
  return Buffer.byteLength(JSON.stringify({
    description: String(schema.description ?? ''),
    inputSchema,
    // Same omission the aggregate measurement had (#1376): an output schema is
    // bytes a host receives, so a module declaring one must be charged for it
    // against its own ceiling. `undefined` is dropped by JSON.stringify, so a
    // module declaring none measures exactly as it did before.
    outputSchema: finalOutputSchema(schema.outputSchema),
  }), 'utf8');
}

export function collectModuleSchemaBudgets(server: McpServer): ModuleSchemaBudget[] {
  const metadata = serverMetadata(server);
  if (metadata.budgetRows) return [...metadata.budgetRows];
  const registry = schemaRegistryEntries(server);
  const rows = REGISTRAR_MANIFEST.map((module): ModuleSchemaBudget => {
    const status = metadata.statuses.get(module.key) ?? 'active';
    const names = metadata.tools.get(module.key) ?? [];
    let schemaBytes = 0;
    for (const name of names) schemaBytes += serializedSchemaBytes(registry[name] ?? {}, name);
    const toolCount = names.length;
    return {
      module: module.key,
      registrationKey: module.registrationKey,
      file: module.file,
      status,
      toolCount,
      schemaBytes,
      baselineToolCount: module.baseline.toolCount,
      baselineSchemaBytes: module.baseline.schemaBytes,
      maxToolCount: module.ceiling.toolCount,
      maxSchemaBytes: module.ceiling.schemaBytes,
      // Measured whenever the module registered anything: a scope_filtered row
      // is a real subset of the surface, not an absent module, so it must not
      // buy budget exemption by being partially withheld.
      withinBudget: toolCount === 0 || (toolCount <= module.ceiling.toolCount && schemaBytes <= module.ceiling.schemaBytes),
    };
  });
  metadata.budgetRows = rows;
  return [...rows];
}

export function assertModuleSchemaBudgets(rows: readonly ModuleSchemaBudget[]): void {
  // Recompute the verdict from the measurements rather than trusting a
  // precomputed `withinBudget` field: a caller (or a future edit to the row
  // builder) could otherwise flip the flag without the comparison ever running,
  // and the per-module budget gate would be dead while still reporting healthy.
  const over = rows.filter((row) => row.toolCount > 0
    && (row.toolCount > row.maxToolCount || row.schemaBytes > row.maxSchemaBytes));
  if (over.length === 0) return;
  throw new Error(over.map((row) =>
    `${row.module} (${row.file}) exceeds schema budget: ${row.toolCount} tools/${row.schemaBytes}B ` +
    `> ${row.maxToolCount} tools/${row.maxSchemaBytes}B`,
  ).join('; '));
}

type ErrorKind =
  | 'auth'
  | 'forbidden'
  | 'not_found'
  // 304 with no stored ETag backing it: the origin honoured a conditional
  // request we cannot answer. Its own kind, because folding it into
  // `unavailable` would report Spotify as down when it answered correctly.
  | 'not_modified'
  | 'rate_limited'
  | 'unavailable'
  | 'conflict'
  | 'validation'
  | 'unknown_tool'
  | 'unknown_param'
  // The caller withdrew the request (#676). Its own kind because every other
  // class tells the host to DO something — retry, re-auth, request access,
  // wait for a window — and the one correct action here is to do nothing. A
  // cancellation reported as `unavailable` (408-shaped) would have the host
  // re-issue the very request it just cancelled.
  | 'cancelled'
  // #687: the tool returned a payload its OWN declared `outputSchema` refuses.
  // Its own kind because every neighbouring class points the host at its input
  // or tells it to retry, and neither is true: nothing the caller sent is at
  // fault, and the failure is deterministic, so a retry fails identically. The
  // fix is in this server — see the `output validation failed` arm of
  // `publicFailure`, which claims this class before the input-validation arm
  // below it can match the word "required" in the message.
  | 'output_contract'
  // The token store could not be READ: no file, or one that fails
  // `isTokenData`. Its own class because the one correct action is re-auth, and
  // every neighbouring class is wrong here — `internal` tells the host to retry,
  // which fails identically forever; `unavailable` tells it to wait, which
  // changes nothing. `loadTokens` already says "run `npm run auth` again", and
  // that instruction was being discarded by the fallback arm below. Nothing the
  // caller sent is at fault and nothing is transient, so the message has to name
  // the fix rather than a retry.
  | 'auth'
  | 'internal';

interface ErrorFields {
  kind: ErrorKind;
  reason: string;
  fix: string;
  text: string;
  status?: number;
  retryAfterSec?: number;
  param?: string;
}

function getToolRegistry(server: McpServer): Record<string, RegistryEntry> {
  const registry = registeredToolEntries(server);
  if (!registry || typeof registry !== 'object') {
    throw new Error('Spotify MCP tool registry is unavailable; refusing to start without its error boundary');
  }
  return registry;
}

function safeIdentifier(value: string): string {
  const oneLine = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return (oneLine.replace(/[^A-Za-z0-9_.:-]+/g, '?').slice(0, 96) || '(unnamed)');
}

function levenshtein(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const substitution = previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        substitution,
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function nearestNames(name: string, candidates: string[]): string[] {
  return candidates
    .map((candidate) => ({ candidate, distance: levenshtein(name, candidate) }))
    .filter(({ distance }) => distance > 0 && distance <= 3)
    .sort((left, right) => left.distance - right.distance || left.candidate.localeCompare(right.candidate))
    .slice(0, 3)
    .map(({ candidate }) => candidate);
}

function humanList(values: string[]): string {
  if (values.length === 1) return `"${values[0]}"`;
  if (values.length === 2) return `"${values[0]}" or "${values[1]}"`;
  return `"${values[0]}", "${values[1]}", or "${values[2]}"`;
}

function findTypedApiError(error: unknown): SpotifyApiError | StatsfmApiError | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (current instanceof SpotifyApiError || current instanceof StatsfmApiError) return current;
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}


function safeStatsfmReason(reason: unknown): string | undefined {
  if (typeof reason !== 'string') return undefined;
  if (/registration[-_ ]?gated/i.test(reason)) return 'registration_gated';
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(reason) ? reason : undefined;
}

function statsfmFailure(tool: string, error: StatsfmApiError): ErrorFields {
  let kind: ErrorKind;
  let reason: string;
  let fix: string;
  let text: string;
  if (error.status === 401) {
    kind = 'auth';
    reason = safeStatsfmReason(error.reason) ?? 'statsfm_authentication_required';
    fix = 'Retry when stats.fm authentication is available.';
    text = `${tool} could not authenticate with stats.fm; retry later.`;
  } else if (error.status === 403) {
    kind = 'forbidden';
    reason = safeStatsfmReason(error.reason) ?? (error.reason && /registration[-_ ]?gated/i.test(error.reason)
      ? 'registration_gated'
      : 'statsfm_access_forbidden');
    fix = 'Use a permitted stats.fm tool, or request the required access.';
    text = `${tool} is not available from stats.fm for this request; use a permitted tool or request access.`;
  } else if (error.status === 404) {
    kind = 'not_found';
    reason = safeStatsfmReason(error.reason) ?? 'statsfm_resource_not_found';
    fix = 'Verify the stats.fm identifier and retry.';
    text = `${tool} could not find the requested stats.fm resource; verify its identifier and retry.`;
  } else if (error.status === 429) {
    kind = 'rate_limited';
    reason = safeStatsfmReason(error.reason) ?? 'statsfm_rate_limited';
    fix = typeof error.retryAfterSec === 'number'
      ? `Wait ${error.retryAfterSec} seconds before retrying.`
      : 'Wait before retrying.';
    text = typeof error.retryAfterSec === 'number'
      ? `${tool} was rate-limited by stats.fm; retry after ${error.retryAfterSec} seconds.`
      : `${tool} was rate-limited by stats.fm; retry later.`;
  } else if (error.status === 503) {
    kind = 'unavailable';
    reason = safeStatsfmReason(error.reason) ?? 'statsfm_unavailable';
    fix = 'Retry shortly.';
    text = `${tool} could not reach stats.fm because the service is unavailable; retry shortly.`;
  } else if (error.status === 408) {
    // Our own deadline, raised by StatsfmClient (#907), not a stats.fm status.
    // Without this it would fall through to the generic branch and tell the
    // caller to "inspect protected server diagnostics" for what is a plain
    // slow upstream. Mirrors the Spotify 408 mapping.
    kind = 'unavailable';
    reason = 'statsfm_timeout';
    fix = 'Retry shortly.';
    text = `${tool} timed out while waiting for stats.fm; retry shortly.`;
  } else {
    kind = 'internal';
    reason = safeStatsfmReason(error.reason) ?? 'statsfm_error';
    fix = 'Retry once; if the failure persists, inspect protected server diagnostics.';
    text = `${tool} failed unexpectedly; retry once and inspect protected server diagnostics if it persists.`;
  }
  return {
    kind,
    reason,
    fix,
    text,
    status: error.status,
    ...(kind === 'rate_limited' && typeof error.retryAfterSec === 'number'
      ? { retryAfterSec: error.retryAfterSec }
      : {}),
  };
}

function validationParam(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('issues' in error) || !Array.isArray(error.issues)) {
    return undefined;
  }
  for (const issue of error.issues) {
    if (issue === null || typeof issue !== 'object' || !('path' in issue) || !Array.isArray(issue.path)) continue;
    const first = issue.path[0];
    if (typeof first === 'string' && first.length > 0) return safeIdentifier(first);
    if (typeof first === 'number') return safeIdentifier(String(first));
  }
  return undefined;
}

function safeSpotifyReason(reason: unknown): string | undefined {
  return typeof reason === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(reason) ? reason : undefined;
}

function defaultReason(kind: ErrorKind): string {
  switch (kind) {
    case 'auth': return 'authentication_required';
    case 'forbidden': return 'spotify_access_forbidden';
    case 'not_found': return 'spotify_resource_not_found';
    case 'rate_limited': return 'spotify_rate_limited';
    case 'unavailable': return 'spotify_unavailable';
    case 'conflict': return 'playlist_changed_since_read';
    case 'validation': return 'validation_failed';
    case 'not_modified': return 'not_modified_without_validator';
    case 'unknown_tool': return 'tool_not_registered';
    case 'unknown_param': return 'parameter_not_accepted';
    case 'cancelled': return 'cancelled_by_caller';
    case 'output_contract': return 'structured_content_failed_declared_output_schema';
    case 'auth': return 'spotify_auth_required';
    case 'internal': return 'internal_error';
  }
}

/**
 * Operator-facing text for a classified token-endpoint failure (#677).
 *
 * The status alone cannot carry this: several genuinely different refresh
 * failures share one status, and a 503 read as "the service is unavailable"
 * told an operator with a refused client id to retry a configuration fault
 * that no retry can fix. Keyed by the reason the classifier minted, so this
 * only fires for a failure that was actually classified — a token reason is
 * never minted anywhere else.
 *
 * Returns undefined for a reason with no override, and specifically for
 * `TOKEN_INVALID_GRANT`, which the default 401 mapping already describes
 * correctly ("run spotify-mcp auth"). The switch is exhaustive with no
 * fallthrough: a new reason must be given its own text here rather than
 * inheriting the last branch's, which is how a dead grant briefly came back
 * described as an unreachable network.
 */
function tokenFailureFields(tool: string, error: SpotifyApiError): ErrorFields | undefined {
  const reason = error.reason;
  if (!isTokenFailureReason(reason)) return undefined;
  const base = { reason, status: error.status };

  switch (reason) {
    case 'TOKEN_INVALID_CLIENT':
      return {
        ...base,
        kind: 'auth',
        text: `${tool} could not authenticate: Spotify refused the configured client id at the token endpoint. `
          + 'Set SPOTIFY_CLIENT_ID to the Client ID of your app in the Spotify Developer Dashboard, then re-run '
          + '"spotify-mcp auth" (PKCE uses no client secret).',
        fix: 'Set SPOTIFY_CLIENT_ID to the app id from the Spotify Developer Dashboard, then re-run "spotify-mcp auth".',
      };
    case 'TOKEN_REQUEST_REJECTED':
      return {
        ...base,
        kind: 'auth',
        text: `${tool} could not refresh the Spotify access token: the token endpoint refused the refresh with an `
          + 'error this server has no fix for, so no cause is asserted here. The exact code is in the server log.',
        fix: 'Read the exact error code in the server log before changing anything; re-run "spotify-mcp auth" if the stored grant is suspect.',
      };
    case 'TOKEN_UNCLASSIFIED':
      return {
        ...base,
        kind: 'auth',
        text: `${tool} could not refresh the Spotify access token, and the token endpoint's response carried no `
          + 'machine-readable error, so the cause is unknown. The HTTP status, whether the body parsed, and the token '
          + 'file path are in the server log.',
        fix: 'Inspect the server log for the token endpoint status and token file path, then verify SPOTIFY_CLIENT_ID and re-run "spotify-mcp auth".',
      };
    case 'TOKEN_RATE_LIMITED': {
      const wait = error.retryAfterSec;
      return {
        ...base,
        kind: 'rate_limited',
        text: typeof wait === 'number'
          ? `${tool}'s access token could not be refreshed because the Spotify token endpoint is rate limiting; retry after ${wait} seconds.`
          : `${tool}'s access token could not be refreshed because the Spotify token endpoint is rate limiting; retry later.`,
        fix: typeof wait === 'number'
          ? `Wait ${wait} seconds before retrying; refreshing sooner extends the limit.`
          : 'Wait before retrying; refreshing sooner extends the limit.',
        ...(typeof wait === 'number' ? { retryAfterSec: wait } : {}),
      };
    }
    case 'TOKEN_SERVER_ERROR':
      return {
        ...base,
        kind: 'unavailable',
        text: `${tool}'s access token could not be refreshed because Spotify's token endpoint returned a server error. `
          + 'This is a fault at Spotify, not a local configuration problem; retry shortly.',
        fix: 'Retry shortly.',
      };
    case 'TOKEN_UNREADABLE_RESPONSE':
      return {
        ...base,
        kind: 'unavailable',
        text: `${tool}'s access token could not be refreshed because the Spotify token endpoint answered with a body `
          + 'that could not be read as JSON. No access token was obtained; retry, and if it persists the stored token '
          + 'file is suspect.',
        fix: 'Retry once; if it persists, re-run "spotify-mcp auth" to rewrite the token file.',
      };
    case 'TOKEN_NETWORK_UNREACHABLE':
      // 408 is our own abort; 503 is a transport failure. They are both "no
      // response arrived" and both are connectivity problems, but only one of
      // them is a timeout, and the fix differs.
      return error.status === 408
        ? {
            ...base,
            kind: 'unavailable',
            text: `${tool}'s access token could not be refreshed: the request to Spotify's token endpoint timed out with `
              + 'no response received. Retry shortly, or raise SPOTIFY_REQUEST_TIMEOUT_MS on a slow link.',
            fix: 'Retry shortly, or raise SPOTIFY_REQUEST_TIMEOUT_MS.',
          }
        : {
            ...base,
            kind: 'unavailable',
            text: `${tool}'s access token could not be refreshed because the request to Spotify's token endpoint never got a `
              + 'response (network, DNS or TLS failure). This is a local connectivity problem, not a Spotify outage; '
              + 'check the connection and retry.',
            fix: 'Check local network/DNS connectivity, then retry.',
          };
    case 'TOKEN_INVALID_GRANT':
    default:
      // No override: the default 401 mapping already says "run spotify-mcp
      // auth", which is exactly right for a revoked grant.
      return undefined;
  }
}

function publicFailure(tool: string, error: unknown): ErrorFields {
  const typedError = findTypedApiError(error);
  if (typedError instanceof StatsfmApiError) return statsfmFailure(tool, typedError);
  if (typedError instanceof SpotifyApiError) {
    const spotifyError = typedError;
    const tokenFailure = tokenFailureFields(tool, spotifyError);
    if (tokenFailure) return tokenFailure;
    const status = spotifyError.status;
    let kind: ErrorKind;
    let text: string;
    let fix: string;
    if (status === 401) {
      kind = 'auth';
      text = `${tool} could not authenticate with Spotify; run "spotify-mcp auth" and retry.`;
      fix = 'Run "spotify-mcp auth" and retry.';
    } else if (status === 403) {
      kind = 'forbidden';
      text = `${tool} is not available for this Spotify app registration or account; use a permitted tool or request the required access.`;
      fix = 'Use a permitted tool, or request the required Spotify access for this app registration.';
    } else if (status === 404) {
      kind = 'not_found';
      text = `${tool} could not find the requested Spotify resource; verify its identifier and retry.`;
      fix = 'Verify the Spotify identifier and retry.';
    } else if (status === 429) {
      kind = 'rate_limited';
      const wait = spotifyError.retryAfterSec;
      text = typeof wait === 'number'
        ? `${tool} was rate-limited by Spotify; retry after ${wait} seconds.`
        : `${tool} was rate-limited by Spotify; retry later.`;
      fix = typeof wait === 'number' ? `Wait ${wait} seconds before retrying.` : 'Wait before retrying.';
    } else if (status === 408 || status === 503) {
      kind = 'unavailable';
      text = status === 408
        ? `${tool} timed out while waiting for Spotify; retry shortly.`
        : `${tool} could not reach Spotify because the service is unavailable; retry shortly.`;
      fix = 'Retry shortly.';
    } else if (status === 304) {
      // A 304 backed by a stored validator is a successful cache hit and never
      // reaches here; only the unbacked one throws (#601). It is a missing
      // validator, not an outage and not a bad argument, so it gets its own
      // kind and a fix that names the real next step.
      kind = 'not_modified';
      text = `${tool} was answered 304 Not Modified with no stored ETag to match it; the read cannot be served from cache.`;
      fix = 'Re-read without a validator (do not send If-None-Match).';
    } else if (status === CANCELLED_STATUS) {
      // #676: the caller's own `notifications/cancelled` reached us. The text
      // must name cancellation, because this is the tool result a host reads
      // to decide the request is finished — a host that read "failed
      // unexpectedly" here would have no way to tell its own cancellation
      // apart from a real fault.
      kind = 'cancelled';
      text = `${tool} was cancelled by the caller; no further Spotify requests were made for this call.`;
      fix = 'Do not retry a cancelled call; re-issue only if the request is still wanted.';
    } else if (status === 400 || status === 422) {
      kind = 'validation';
      text = `${tool} received invalid arguments; pass values that match the tool schema.`;
      fix = 'Pass values that match the tool schema.';
    } else {
      kind = 'internal';
      text = `${tool} failed unexpectedly; retry once and inspect protected server diagnostics if it persists.`;
      fix = 'Retry once; if the failure persists, inspect protected server diagnostics.';
    }
    return {
      kind,
      reason: status === 403 && safeSpotifyReason(spotifyError.reason) === 'REGISTRATION_GATED'
        ? 'registration_gated'
        : safeSpotifyReason(spotifyError.reason) ?? defaultReason(kind),
      fix,
      text,
      status,
      ...(kind === 'rate_limited' && typeof spotifyError.retryAfterSec === 'number'
        ? { retryAfterSec: spotifyError.retryAfterSec }
        : {}),
    };
  }

  const message = (error instanceof Error ? error.message : String(error)).replace(/^MCP error -\d+:\s*/, '').trim();
  const lower = message.toLowerCase();
  if (/not authenticated|no token file|token refresh failed|spotify-mcp auth|spotify auth error/.test(lower)) {
    return {
      kind: 'auth',
      reason: defaultReason('auth'),
      fix: 'Run "spotify-mcp auth" and retry.',
      text: `${tool} could not authenticate with Spotify; run "spotify-mcp auth" and retry.`,
    };
  }
  if (/app-registration gated|registration-gated|forbidden|access denied|premium required|oauth scope|scope .*missing|market-gated/.test(lower)) {
    return {
      kind: 'forbidden',
      reason: lower.includes('gated') ? 'registration_gated' : defaultReason('forbidden'),
      fix: 'Use a permitted tool, or request the required Spotify access for this app registration.',
      text: `${tool} is not available for this Spotify app registration or account; use a permitted tool or request the required access.`,
    };
  }
  if (/\bnot found\b|does not exist/.test(lower)) {
    return {
      kind: 'not_found',
      reason: defaultReason('not_found'),
      fix: 'Verify the Spotify identifier and retry.',
      text: `${tool} could not find the requested Spotify resource; verify its identifier and retry.`,
    };
  }
  if (/rate.?limit|retry-after|quota exceeded/.test(lower)) {
    return {
      kind: 'rate_limited',
      reason: defaultReason('rate_limited'),
      fix: 'Wait before retrying.',
      text: `${tool} was rate-limited by Spotify; retry later.`,
    };
  }
  if (/temporarily unavailable|service unavailable|retry shortly|fetch failed|econnreset|socket hang up/.test(lower)) {
    return {
      kind: 'unavailable',
      reason: defaultReason('unavailable'),
      fix: 'Retry shortly.',
      text: `${tool} could not reach Spotify because the service is unavailable; retry shortly.`,
    };
  }
  // A guard that aborts because the playlist changed under it is neither an
  // unexpected crash nor a bad argument: nothing was written, and the caller
  // must re-read and re-run to see the new impact. Classifying it as internal
  // throws that instruction away and invites a blind retry.
  if (/changed during|re-run to review|out of date|stale (?:playlist|snapshot|state)|snapshot .* mismatch/.test(lower)) {
    return {
      kind: 'conflict',
      reason: defaultReason('conflict'),
      fix: 'Re-read the playlist and re-run to review the new destructive impact.',
      text: `${tool} refused to write because the playlist changed since it was read; re-read it and re-run to review the new destructive impact.`,
    };
  }
  // #687: the tool's own declared `outputSchema` refused the payload the tool
  // returned. Claimed HERE, above the input-validation arm, and that placement is
  // the whole point rather than a style choice: the two messages
  // `validateOutput` throws differ only by a trailing clause, and the longer one
  // ends `... structured content is required`. The unanchored `required` in the
  // arm below would match it and report a server-side defect as the caller
  // having sent bad arguments — the AGENTS.md §6 shape, a check matching the
  // wrong thing. With only the shorter message it fell through to `internal`,
  // whose advice to "retry once" is equally wrong for a deterministic defect.
  // So the class is named rather than left to which of two strings a function
  // happened to build.
  if (/^output validation failed\b/.test(lower)) {
    return {
      kind: 'output_contract',
      reason: defaultReason('output_contract'),
      fix: 'This is a server-side defect and is deterministic; retrying will not change it.',
      text: `${tool} returned a payload that does not match its declared output schema; this is a server-side defect and retrying will not change it.`,
    };
  }
  // The token store itself could not be read. Claimed HERE, above the
  // input-validation arm and the internal fallback, because both give advice
  // that is actively wrong for this: `internal` says "retry once", which cannot
  // succeed against a file that `isTokenData` rejects, and it sends the host to
  // "protected server diagnostics" instead of the one command that fixes it.
  // `loadTokens` already carries the actionable half — "run `npm run auth`
  // again" — and every class below threw that away.
  if (/tokens are corrupted|no token file at|not authenticated|(?:npm run|spotify-mcp) auth|client_?id (?:environment|is) (?:not|is) (?:set|missing)/.test(lower)) {
    return {
      kind: 'auth',
      reason: defaultReason('auth'),
      fix: 'Re-authenticate the server, then retry.',
      text: `${tool} could not read saved Spotify credentials; re-run the Spotify login for this server, then retry.`,
    };
  }
  if (/^(?:invalid (?:(?:playable )?(?:spotify )?(?:reference|uris?)|spotify track\/episode uri|playlist reference)|(?:no resolvable|no valid).*uris?\b)|invalid arguments?|input validation|must |required|provide at least|pass either|not both|expected /.test(lower)) {
    return {
      kind: 'validation',
      reason: defaultReason('validation'),
      fix: 'Pass values that match the tool schema.',
      text: `${tool} received invalid arguments; pass values that match the tool schema.`,
    };
  }
  return {
    kind: 'internal',
    reason: defaultReason('internal'),
    fix: 'Retry once; if the failure persists, inspect protected server diagnostics.',
    text: `${tool} failed unexpectedly; retry once and inspect protected server diagnostics if it persists.`,
  };
}

function errorResult(tool: string, fields: ErrorFields, diagnostic: unknown) {
  const correlationId = globalThis.crypto.randomUUID();
  const safeReason = /^[a-z][a-z0-9_]{0,63}$/.test(fields.reason) ? fields.reason : 'classified_error';
  const status = fields.status === undefined ? 'none' : String(fields.status);
  // The breadcrumb an operator actually reads: which tool, which class, and —
  // for an unknown tool or parameter — what was asked for. Sanitised like every
  // other log line, so a caller-supplied name cannot inject newlines or paths
  // that the redaction policy exists to keep off stderr.
  const detail = typeof diagnostic === 'string' ? ` detail=${safeIdentifier(diagnostic.slice(0, 120))}` : '';
  console.error(
    `[spotify-mcp] error correlation_id=${correlationId} tool=${safeIdentifier(tool)} kind=${fields.kind} status=${status} reason=${safeReason}${detail}`,
  );

  const error: Record<string, unknown> = {
    tool,
    kind: fields.kind,
    reason: fields.reason,
    fix: fields.fix,
  };
  if (fields.status !== undefined) error.status = fields.status;
  if (fields.retryAfterSec !== undefined) error.retryAfterSec = fields.retryAfterSec;
  if (fields.param !== undefined) error.param = fields.param;
  return {
    content: [{ type: 'text' as const, text: fields.text }],
    structuredContent: { error },
    isError: true,
  };
}

function unknownToolResult(registry: Record<string, RegistryEntry>, requested: string) {
  const tool = safeIdentifier(requested);
  const suggestions = nearestNames(requested, Object.keys(registry));
  const suggestionText = suggestions.length > 0
    ? `call ${humanList(suggestions)} instead.`
    : 'call a tool advertised by tools/list instead.';
  return errorResult(tool, {
    kind: 'unknown_tool',
    reason: defaultReason('unknown_tool'),
    fix: suggestions.length > 0 ? `Call ${humanList(suggestions)} instead.` : 'Call a tool advertised by tools/list instead.',
    text: `${tool} is not an available tool; ${suggestionText}`,
  }, `unknown tool ${JSON.stringify(requested)}`);
}

/**
 * The refusal for a call carrying a playlist input spelling removed in v3.0
 * (#1287), or `undefined` when the call carries none.
 *
 * `kind` is `validation`, not `unknown_param`: the input is not a typo, it is a
 * name this server published under a deprecation notice and then withdrew, and
 * a host routing on `kind` should be able to tell that apart from a genuine
 * unknown name without parsing prose. `reason` is the stable discriminator
 * `retired_input`, and the retired names ride along in `param` so the caller
 * can see which spelling was rejected without matching the message text.
 */
function retiredInputResult(tool: string, requested: string, args: Readonly<Record<string, unknown>>) {
  // `Object.hasOwn`, not a bare index: the table is a frozen object LITERAL, so
  // it still carries Object.prototype. A bare `RETIRED_PLAYLIST_INPUTS[requested]`
  // answers `constructor` or `toString` with a function, which has no `kind` or
  // `aliases` and would throw out of the boundary rather than return a refusal.
  // The registry check upstream makes this unreachable today — every name that
  // reaches here is registered, and registered names are snake_case — but the
  // guard is the difference between a table that is exactly as long as it reads
  // and one that silently answers for keys it does not contain.
  if (!Object.hasOwn(RETIRED_PLAYLIST_INPUTS, requested)) return undefined;
  const config = RETIRED_PLAYLIST_INPUTS[requested];
  if (!config) return undefined;
  const { retired, canonical } = retiredInputsOnCall(args, config);
  if (retired.length === 0) return undefined;
  const message = retiredInputMessage(retired, canonical);
  return errorResult(tool, {
    kind: 'validation',
    reason: 'retired_input',
    fix: `Remove ${humanList(retired.map(safeIdentifier))} and pass ${canonical} instead.`,
    text: `${tool} rejected ${humanList(retired.map(safeIdentifier))}: ${message}`,
    param: retired.map(safeIdentifier).join(', '),
  }, `retired playlist input ${JSON.stringify(retired.join(', '))}`);
}

/**
 * The refusal for a call still sending `max_results` to a tool that withdrew it
 * as a walk cap (#886), or `undefined` when this call is not one.
 *
 * This exists because the generic unknown-parameter path gets the KIND wrong
 * for a name the server published. `unknown_param` reads "we never had that
 * name" and tells the caller to use only what the schema advertises — but
 * `max_results` was on `take_playlist_snapshot` and `backup_library` through
 * 2.1.2, SPEC.md documented it, and its description told callers it was the
 * walk cap. A caller upgrading is following a contract, not mistyping, so AGENTS
 * §5 puts a withdrawn name in the same class as the retired playlist spellings:
 * `validation` / `retired_input`, naming both the retired field and its
 * replacement.
 *
 * It names the replacement because the alternative leaves the caller to
 * re-read a schema to discover that `item_cap` and `walk_cap` are what they
 * want, which is the work this refusal exists to do.
 */
function retiredWalkCapResult(tool: string, args: Readonly<Record<string, unknown>>) {
  const retirement = retiredWalkCapOnCall(tool, args);
  if (!retirement) return undefined;
  return errorResult(tool, {
    kind: 'validation',
    reason: 'retired_input',
    fix: `Remove ${safeIdentifier(retirement.retired)} and pass ${retirement.canonical} instead.`,
    text: `${tool} rejected ${safeIdentifier(retirement.retired)}: ${retiredWalkCapMessage(retirement)}`,
    param: retirement.retired,
  }, `retired walk cap ${JSON.stringify(retirement.retired)}`);
}

/**
 * The canonical tool name a retired legacy alias should dispatch to, or
 * `undefined` when this call is not one (#908).
 *
 * Three conditions, and all three have to hold:
 *  - the name is a known retired alias ({@link resolveLegacyToolAlias});
 *  - `SPOTIFY_MCP_LEGACY_ALIASES` is on — the rewrite is an opt-in
 *    compatibility window, off by default, because the whole point of #908 was
 *    to stop paying for names nobody should be calling any more;
 *  - the canonical name is registered AND enabled in THIS session. A caller who
 *    set the flag but did not enable the `taste` toolset must get the refusal
 *    below, not a dispatch into a module the toolset gate removed.
 */
function legacyAliasTarget(
  requested: string,
  registry: Record<string, RegistryEntry>,
): string | undefined {
  if (!legacyAliasesEnv()) return undefined;
  const canonical = resolveLegacyToolAlias(requested);
  if (canonical === undefined) return undefined;
  const entry = registry[canonical];
  if (!entry || entry.enabled === false) return undefined;
  return canonical;
}

/**
 * What a caller who hit a retired alias can actually DO about it, appended to
 * the refusal's `fix`.
 *
 * Two knobs, and the order matters: the toolset gate is checked first at
 * dispatch, so `SPOTIFY_MCP_LEGACY_ALIASES=1` alone does nothing on a server
 * that trimmed `taste`. Naming only the compat flag would send a caller to set
 * an env var and hit the same refusal again.
 */
const LEGACY_ALIAS_COMPAT_HINT =
  ' (enable the taste toolset with SPOTIFY_MCP_TOOLSETS=taste, and set ' +
  'SPOTIFY_MCP_LEGACY_ALIASES=1 to keep accepting the old name)';

/**
 * The refusal for a call on one of the ten #848 names, or `undefined` when
 * `requested` was not one.
 *
 * v3.0 is the release those names promised to stop being callable in, and it is
 * the release that removed the forwarding, so this is now every call's answer
 * rather than the answer for a session that happened to trim the toolset
 * owning the survivor. The name is gone either way; what changed is that the
 * refusal says so instead of the generic unknown-tool `nearestNames` guess,
 * which would have been offered to someone who did not mistype anything.
 *
 * `kind` and `reason` are the same pair the retired queue-read names refuse
 * with (#847), so a caller routing on those two fields sees one coherent "this
 * name was withdrawn on purpose" answer across both families rather than
 * having to know which issue withdrew which. `fix` carries the exact
 * replacement call, including the flags the forward used to supply — the four
 * of those a caller cannot re-derive from the survivor's schema are the whole
 * reason the record in `shaping.ts` outlived the rewriter.
 */
function retiredForwardRefusal(requested: string) {
  const record = resolveRetiredToolForward(requested);
  if (record === undefined) return undefined;
  const tool = safeIdentifier(requested);
  return errorResult(tool, {
    kind: 'unknown_tool',
    reason: 'retired_tool_alias',
    fix: `Call ${record.tool} instead — ${record.note}`,
    text: `${tool} is not an available tool; ${retiredToolForwardNote(requested, record)}`,
  }, `retired tool ${JSON.stringify(requested)}`);
}

/**
 * Attach one deprecation notice to a result's structured content AND its prose.
 *
 * The two-channel rule is the repo's, from #1318: a machine-readable claim that
 * appears in only one of them is a claim a host reading the other one cannot
 * see.
 *
 * A result with no `structuredContent` used to be returned untouched rather than
 * given prose-only metadata. That is right in general and wrong here (#848):
 * the tools these notices exist for -- `transfer_playback`, `set_volume` --
 * return `MUTATION_EMIT`, which sets `proseCarriesPayload: false` and so has no
 * structured half at all in the default prose format. The notice therefore
 * reached only callers who had opted into `json`, and the default caller, who is
 * the one a deprecation is written for, was told nothing that `handoff` had been
 * retired. Prose-only is strictly more than silence: `deprecated_inputs` is the
 * convenience, the note is the contract, and the release that removes the name
 * has to be in writing where the caller will actually read it.
 */
function stampDeprecation(result: unknown, resolution: PlaylistInputResolution): unknown {
  if (result === null || typeof result !== 'object') return result;
  const output = result as { content?: unknown; structuredContent?: unknown };
  const hasStructured = output.structuredContent !== undefined && typeof output.structuredContent === 'object';
  const mapText = Array.isArray(output.content)
    ? {
      content: output.content.map((part) => (
        part !== null && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
          ? { ...part, text: withPlaylistInputNote(String((part as { text?: unknown }).text ?? ''), resolution) }
          : part
      )),
    }
    : {};

  if (!hasStructured) return { ...output, ...mapText };

  const payload = withPlaylistInputMetadata(output.structuredContent as Record<string, unknown>, resolution);
  return { ...output, structuredContent: payload, ...mapText };
}

/**
 * The refusal for a call that named a retired alias while the rewrite is off,
 * or `undefined` when `requested` was not one.
 *
 * `kind` stays `unknown_tool` — the name genuinely is not in the registry, and
 * a host routing on `kind` should not be told it was a validation failure. The
 * stable discriminator is `reason: 'retired_tool_alias'`, matching the
 * `retired_input` shape one function up, so a caller can tell "you used a name
 * we withdrew on purpose, here is its replacement" from a genuine typo without
 * parsing prose. It replaces the generic unknown-tool answer for these eight
 * names, whose replacement is known exactly — `nearestNames` would only guess
 * it, and would guess wrong for `record_feedback` if the canonical names ever
 * moved again.
 */
function retiredAliasResult(requested: string) {
  const canonical = resolveLegacyToolAlias(requested);
  if (canonical === undefined) {
    // #847: a retired queue-read name. Not in LEGACY_TOOL_ALIASES and not
    // dispatched by SPOTIFY_MCP_LEGACY_ALIASES — the surviving tools take
    // arguments the retired ones did not, so a rewrite would answer a
    // different question. Same `kind` and same stable discriminator as the row
    // above: a host routing on `kind` sees one coherent "this name was
    // withdrawn on purpose" refusal, and `fix` carries the exact call.
    const queue = resolveRetiredQueueTool(requested);
    if (queue === undefined) return undefined;
    const queueTool = safeIdentifier(requested);
    return errorResult(queueTool, {
      kind: 'unknown_tool',
      reason: 'retired_tool_alias',
      fix: `Call ${queue.call} instead.`,
      text: `${queueTool} is not an available tool; ${retiredQueueToolMessage(requested, queue)}.`,
    }, `retired tool ${JSON.stringify(requested)}`);
  }
  const tool = safeIdentifier(requested);
  return errorResult(tool, {
    kind: 'unknown_tool',
    reason: 'retired_tool_alias',
    fix: `Call ${canonical} instead${LEGACY_ALIAS_COMPAT_HINT}.`,
    text: `${tool} is not an available tool; ${retiredToolAliasMessage(requested, canonical)}.`,
  }, `retired tool alias ${JSON.stringify(requested)}`);
}

/**
 * The stats.fm identity conflict gate (#1318).
 *
 * `undefined` when the call is not a conflicting-identity call, which is every
 * call on a tool that declares no identity argument and every call that sends
 * at most one spelling.
 *
 * It runs HERE, ahead of the handler and therefore ahead of any stats.fm
 * request, because AGENTS.md §5 requires an incomplete or conflicting input to
 * fail before the upstream call — a refusal that arrives after the request has
 * been made is not a refusal, it is a wasted round trip plus a confusing
 * error. It is the first line; {@link resolveStatsfmUserInput} in the handler
 * is the second, for a handler invoked directly (which is what a test drives).
 *
 * A tool that declares NO identity argument is not consulted: a tool with a
 * `user_id` of its own (the two Spotify `get_user_*` tools) must keep meaning
 * whatever it means, so the gate is scoped by asking the tool's own schema
 * whether it carries the canonical field.
 */
function statsfmIdentityConflict(tool: string, shape: Record<string, AnySchema> | undefined, args: Readonly<Record<string, unknown>>) {
  if (!shape || !Object.hasOwn(shape, STATSFM_USER_INPUT)) return undefined;
  if (!Object.hasOwn(args, STATSFM_USER_INPUT) || !Object.hasOwn(args, STATSFM_LEGACY_USER_INPUT)) return undefined;
  try {
    resolveStatsfmUserInput(args);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'the two spellings disagree';
    return errorResult(tool, {
      kind: 'validation',
      reason: 'conflicting_input',
      fix: `Remove ${safeIdentifier(STATSFM_LEGACY_USER_INPUT)} and pass only ${safeIdentifier(STATSFM_USER_INPUT)}.`,
      text: `${tool} rejected the call: ${detail}`,
      param: `${STATSFM_USER_INPUT}, ${STATSFM_LEGACY_USER_INPUT}`,
    }, `conflicting stats.fm identity ${JSON.stringify([STATSFM_USER_INPUT, STATSFM_LEGACY_USER_INPUT])}`);
  }
  return undefined;
}

/**
 * Attach the identity deprecation notice to one successful result (#1318).
 *
 * Applied HERE, at the single place every tool result passes, rather than in
 * the 43 handlers: a notice threaded by hand is a notice that is missing on
 * whichever tool someone forgot, and a caller that reads `deprecated_inputs`
 * off one tool has no way to tell a missing key from an absent deprecation.
 * The repo already resolves the same problem the same way for the retired
 * playlist spellings — {@link retiredInputResult} lives in this file.
 *
 * A result with no `structuredContent` is left alone. Adding the metadata to
 * prose alone would put a machine-readable claim in one channel and not the
 * other; a tool that publishes structured output gets both or neither.
 */
function applyStatsfmIdentityDeprecation(
  result: unknown,
  shape: Record<string, AnySchema> | undefined,
  args: Readonly<Record<string, unknown>>,
): unknown {
  if (!shape || !Object.hasOwn(shape, STATSFM_USER_INPUT)) return result;
  if (!Object.hasOwn(args, STATSFM_LEGACY_USER_INPUT)) return result;
  if (result === null || typeof result !== 'object') return result;
  const output = result as { content?: unknown; structuredContent?: unknown };
  if (output.structuredContent === undefined || typeof output.structuredContent !== 'object') return result;

  const resolution = resolveStatsfmUserInput(args);
  if (resolution.deprecatedInputs.length === 0) return result;
  const payload = withPlaylistInputMetadata(output.structuredContent as Record<string, unknown>, resolution);
  return {
    ...output,
    structuredContent: payload,
    ...(Array.isArray(output.content)
      ? {
        content: output.content.map((part) => (
          part !== null && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
            ? { ...part, text: withPlaylistInputNote(String((part as { text?: unknown }).text ?? ''), resolution) }
            : part
        )),
      }
      : {}),
  };
}

function unknownParamResult(tool: string, param: string, candidates: string[]) {

  let suggestions = nearestNames(param, candidates);
  if (suggestions.length === 0 && param === 'limit' && candidates.includes('offset')) {
    suggestions = ['offset'];
    if (candidates.includes('max_results')) suggestions.push('max_results');
  }
  const replacement = suggestions.length > 0
    ? `use ${humanList(suggestions)} instead.`
    : 'use only parameters advertised by the tool schema instead.';
  return errorResult(tool, {
    kind: 'unknown_param',
    reason: defaultReason('unknown_param'),
    fix: suggestions.length > 0
      ? `Remove ${safeIdentifier(param)} and use ${humanList(suggestions)}.`
      : `Remove ${safeIdentifier(param)} and use only advertised parameters.`,
    text: `${tool} does not accept parameter ${safeIdentifier(param)}; remove it and ${replacement}`,
    param: safeIdentifier(param),
  }, `unknown parameter ${JSON.stringify(param)}`);
}

function validationResult(tool: string, shape: Record<string, AnySchema> | undefined, error: unknown) {
  const param = validationParam(error);
  return errorResult(tool, validationEnvelope(tool, 'tool', 'parameter', shape, error, param), param ? `schema validation failed for parameter ${param}` : 'schema validation failed');
}

/**
 * The shared validation envelope for both surfaces (#689).
 *
 * Two rules, and the second is the one that is easy to get wrong:
 *
 *  1. Name the offending argument and say what was expected. `expected` is
 *     read off the zod issue itself, never inferred, and the argument's own
 *     `.describe()` text rides along as the concrete next step — that text is
 *     the same string `tools/list` already advertises, so the error and the
 *     schema cannot disagree.
 *  2. When the issue does not carry a readable expectation, say nothing rather
 *     than something plausible. A message that names a type the schema does
 *     not enforce is #803 in prose: a caller who acts on it is wrong and
 *     cannot tell. So an unreadable issue falls back to pointing at the schema,
 *     which is always true.
 */
function validationEnvelope(
  subject: string,
  kind: 'tool' | 'prompt',
  noun: 'parameter' | 'argument',
  shape: Record<string, AnySchema> | undefined,
  error: unknown,
  param: string | undefined,
) {
  const nouned = param ? `${noun} ${safeIdentifier(param)}` : 'arguments';
  const expectation = expectationPhrase(firstIssue(error));
  // A `stated` custom message is already a complete sentence written for the
  // caller, so it is relayed whole: no `expected …` in front of it (which
  // reads "expected not a recognisable Spotify ID"), and no field description
  // behind it (which restates the rule the message just gave). A `phrase` is a
  // fragment, so it keeps both.
  //
  // An enum already enumerates every legal value, so the field description
  // would only restate it (`one of "short_term"… (short_term (4 weeks)…)`).
  // Everything else — a type, a bound — is incomplete on its own and the
  // description is what turns it into something a caller can act on.
  const stated = expectation?.form === 'stated' ? expectation.text : undefined;
  const hint = expectation?.form === 'phrase' && !expectation.exhaustive ? fieldHint(shape, param) : undefined;
  const detail = expectation
    ? expectation.form === 'stated'
      ? expectation.text
      : `expected ${expectation.text}${hint ? ` (${hint})` : ''}`
    : undefined;
  return {
    kind: 'validation' as const,
    reason: defaultReason('validation'),
    // A stated message is the emitter's own instruction ("Set public to false
    // when collaborative is true"), so it is the fix as written. Prefixing
    // `Pass ` would turn it into "Pass A playlist cannot be both…" and, for the
    // reference messages, "Pass not a recognisable Spotify ID".
    fix: stated
      ? stated
      : detail
        ? `Pass ${detail}.`
        : param ? `Pass a valid value for ${safeIdentifier(param)}.` : `Pass values that match the ${kind} schema.`,
    text: detail
      ? `${subject} rejected ${nouned}: ${detail}`
      : `${subject} rejected ${nouned}; pass a valid value according to the ${kind} schema.`,
    ...(param ? { param: safeIdentifier(param) } : {}),
  };
}

/** The first zod issue, or `undefined` when the failure is not a zod error. */
function firstIssue(error: unknown): unknown {
  if (error === null || typeof error !== 'object' || !('issues' in error) || !Array.isArray(error.issues)) {
    return undefined;
  }
  return error.issues[0];
}

/**
 * What the schema actually demands, phrased for a caller: `a string`, `one of
 * "decade" or "genre"`, `a value at most 5`. Returns `undefined` for any issue
 * whose shape this does not read, and the caller then says nothing (#689
 * rule 2).
 *
 * The two forms are not interchangeable, and the difference is the whole of
 * #1518:
 *
 *  - A **`phrase`** is a fragment the envelope completes — `expected a string
 *    (Playlist ID, …)`. `exhaustive` marks the ones that already list every
 *    legal value, so the caller knows not to pad them with the field
 *    description.
 *  - A **`stated`** message is a whole sentence its own author wrote for a
 *    caller. Completing it with `expected …` produces a grammar error
 *    ("expected not a recognisable Spotify ID") and padding it with the field
 *    description restates the rule it already states, so it is relayed whole
 *    and bare.
 *
 * A `custom` issue only reaches the `stated` form when it carries this repo's
 * trust marker; see `src/custom-issues.ts` for why that is gated rather than
 * assumed, and for what an unmarked issue falls back to.
 */
type Expectation =
  | { readonly form: 'phrase'; readonly text: string; readonly exhaustive: boolean }
  | { readonly form: 'stated'; readonly text: string };

function expectationPhrase(issue: unknown): Expectation | undefined {
  if (issue === null || typeof issue !== 'object') return undefined;
  const record = issue as Record<string, unknown>;
  switch (record.code) {
    case 'invalid_type':
      return typeof record.expected === 'string'
        ? { form: 'phrase', text: `${/^[aeiou]/i.test(record.expected) ? 'an' : 'a'} ${record.expected}`, exhaustive: false }
        : undefined;
    case 'invalid_value': {
      if (!Array.isArray(record.values)) return undefined;
      // `humanList` adds the quotes, so pre-quoting here would double them.
      const options = record.values
        .filter((value): value is string | number | boolean => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
        .map((value) => String(value));
      return options.length > 0 ? { form: 'phrase', text: `one of ${humanList(options)}`, exhaustive: true } : undefined;
    }
    case 'too_big':
      return typeof record.maximum === 'number'
        ? { form: 'phrase', text: `a value ${record.inclusive === false ? 'below' : 'at most'} ${record.maximum}`, exhaustive: false }
        : undefined;
    case 'too_small':
      return typeof record.minimum === 'number'
        ? { form: 'phrase', text: `a value ${record.inclusive === false ? 'above' : 'at least'} ${record.minimum}`, exhaustive: false }
        : undefined;
    case 'not_multiple_of':
      return typeof record.divisor === 'number' ? { form: 'phrase', text: `a multiple of ${record.divisor}`, exhaustive: true } : undefined;
    case 'invalid_format':
      return typeof record.format === 'string' ? { form: 'phrase', text: `a value formatted as ${record.format}`, exhaustive: true } : undefined;
    // #1518. The arm the `default` used to swallow, for the one issue code this
    // repo authors by hand. `trustedCustomMessage` is the trust boundary: it
    // returns the message only for an issue stamped by `trustedCustomIssue`,
    // and `undefined` for a `custom` issue from anywhere else, which then takes
    // the generic phrase below exactly as it did before this arm existed.
    case 'custom': {
      const stated = trustedCustomMessage(record);
      return stated ? { form: 'stated', text: stated } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * The argument's own description — one line, capped. This is the concrete next
 * step in a validation message, and it is the same sentence the host already
 * read in `tools/list` / `prompts/list`, so the two cannot drift.
 */
function fieldHint(shape: Record<string, AnySchema> | undefined, param: string | undefined): string | undefined {
  if (!shape || !param || !Object.hasOwn(shape, param)) return undefined;
  const field = shape[param];
  if (field === null || typeof field !== 'object') return undefined;
  return singleLine(getSchemaDescription(field), 160);
}

/** Collapse a schema description to one bounded line, or `undefined` if empty. */
function singleLine(value: string | undefined, cap: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const oneLine = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (oneLine.length === 0) return undefined;
  return oneLine.length > cap ? `${oneLine.slice(0, cap - 1).trimEnd()}…` : oneLine;
}

/**
 * Apply {@link encodingPlanFor} to one call's arguments (#694).
 *
 * The per-field verification is the whole safety argument, so it is done here
 * rather than inside the plan: a candidate value is written back only after the
 * FIELD'S OWN schema accepts it. A guess that does not hold therefore costs the
 * caller nothing — the raw value is kept and the boundary's normal refusal runs
 * against it, naming the parameter and what it expected. Splitting `"a,b,c"`
 * into three entries and having entry two fail the field's pattern is exactly
 * the case that must not turn into a confusing partial error, and it does not:
 * the split is discarded whole.
 *
 * `shape` is the tool's zod object shape, so this validates a candidate against
 * the same schema the whole-object parse will. A field the shape does not know
 * (which the unknown-parameter check has already refused by this point) keeps
 * its raw value rather than being rewritten on the plan's word alone.
 *
 * Returns the original object identity when nothing changed, which is the
 * common case: a call that already encodes its arguments correctly is handed to
 * `safeParseAsync` exactly as it was before this layer existed.
 */
async function encodingTolerantArgs(
  plan: EncodingPlan,
  shape: Record<string, AnySchema> | undefined,
  args: Readonly<Record<string, unknown>>,
): Promise<Readonly<Record<string, unknown>>> {
  let out: Record<string, unknown> | undefined;
  for (const [name, value] of Object.entries(args)) {
    const coercion = plan[name];
    if (!coercion || value === undefined || !shape || !Object.hasOwn(shape, name)) continue;
    let candidate: unknown;
    try {
      candidate = coercion(value);
    } catch {
      continue;
    }
    if (candidate === value) continue;
    let accepted = false;
    try {
      accepted = (await safeParseAsync(shape[name], candidate)).success;
    } catch {
      accepted = false;
    }
    if (!accepted) continue;
    out ??= { ...args };
    out[name] = candidate;
  }
  return out ?? args;
}

async function invokeHandler(entry: RegistryEntry, args: unknown, extra: unknown): Promise<unknown> {
  const handler = entry.handler;
  if (typeof handler === 'function') {
    return entry.inputSchema ? handler(args, extra) : handler(extra);
  }
  if (handler && typeof handler.createTask === 'function') {
    return entry.inputSchema ? handler.createTask(args, extra) : handler.createTask(extra);
  }
  throw new Error(`Tool handler is unavailable for ${String(handler)}`);
}

async function validateOutput(entry: RegistryEntry, result: unknown, tool: string, isTaskRequest: boolean): Promise<void> {
  if (!entry.outputSchema || isTaskRequest || result === null || typeof result !== 'object' || !('content' in result)) return;
  const output = result as { isError?: unknown; structuredContent?: unknown };
  if (output.isError === true) return;
  if (output.structuredContent === undefined) {
    throw new Error(`Output validation failed for ${tool}: structured content is required`);
  }
  const parsed = await safeParseAsync(entry.outputSchema, output.structuredContent);
  if (!parsed.success) throw new Error(`Output validation failed for ${tool}`);
}

/**
 * The `extra` a detached task run is given (#600).
 *
 * Only the signal is replaced, and it is replaced with the TASK's signal rather
 * than the request's. That distinction is the whole of cancellation: by the
 * time the detached run starts, the `tools/call` it belongs to has already been
 * answered, so the request's controller is spent, and a host that dropped the
 * connection would abort a task that is exactly the work it stopped waiting for.
 *
 * Everything else — `_meta` (and with it the progress token), `sessionId`,
 * `sendNotification`, `sendRequest`, `taskStore` — is carried through
 * unchanged. `_meta` is what keeps the tool's own progress reporting alive
 * during the background run, and it is the same field a confirmation prompt is
 * answered over, so a client that can prompt synchronously can prompt here.
 */
function withTaskSignal(extra: unknown, signal: AbortSignal): unknown {
  if (extra === null || typeof extra !== 'object') return { signal };
  return { ...extra, signal };
}

/**
 * The refusal for a task-augmented call this tool cannot serve (#600).
 *
 * A client that sends `task` to a tool advertising `taskSupport: 'forbidden'`
 * negotiated something the server did not offer, which is an invalid-params
 * mistake by the caller and not a server fault. Thrown rather than returned:
 * see the call site for why a returned result cannot carry the message.
 *
 * Carries `code` directly instead of using `McpError`, which would prefix the
 * sentence the client actually reads with `MCP error -32602:` — the same
 * reason `invalidParams` below avoids it. `Protocol._onrequest` reads
 * `error.code`, so a plain `Error` carrying a numeric code serialises to the
 * right code with a clean message.
 */
function taskAugmentationRefused(tool: string, capable: boolean): Error {
  const reason = capable
    ? 'this server was started without an MCP task store'
    : `${tool} does not support MCP tasks`;
  return Object.assign(
    new Error(`Task augmentation refused: ${reason}. Call ${tool} without a task to run it synchronously.`),
    { code: ErrorCode.InvalidParams },
  );
}

/**
 * Replace the SDK's two early tools handlers with the final production boundary.
 * It advertises closed root input objects, rejects unknown keys before any
 * callback runs, preserves parsed handler/output semantics, and turns every
 * failure into a one-line public envelope with diagnostics confined to stderr.
 */
export function installToolErrorBoundary(
  server: McpServer,
  options: { taskStore?: PersistentTaskStore } = {},
): number {
  const registry = getToolRegistry(server);
  const lowLevelServer = server.server;
  // #600. Optional so the test harnesses that register a handful of tools keep
  // working unchanged; a server built by `buildMcpServer` always passes one,
  // and without one a task-augmented call is refused rather than run inline.
  const taskStore = options.taskStore;

  lowLevelServer.removeRequestHandler('tools/list');
  lowLevelServer.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: Object.entries(registry)
      .filter(([, entry]) => entry.enabled !== false)
      .map(([name, entry]) => {
        const inputSchema = applyStableListDefaults(name, finalInputSchema(entry.inputSchema));

        const definition: Record<string, unknown> = { name, inputSchema };
        if (entry.title !== undefined) definition.title = entry.title;
        if (entry.description !== undefined) definition.description = entry.description;
        if (entry.annotations !== undefined) definition.annotations = entry.annotations;
        if (entry.execution !== undefined) definition.execution = entry.execution;
        if (entry._meta !== undefined) definition._meta = entry._meta;
        if (entry.outputSchema) {
          // `finalOutputSchema` is the same projection the schema budget
          // measures with (#1376). Both sides call it so the gate and the wire
          // cannot disagree about what an output schema serializes to.
          const outputSchema = finalOutputSchema(entry.outputSchema);
          if (outputSchema) definition.outputSchema = outputSchema;
        }
        return definition;
      }),
  }) as unknown as ServerResult);

  lowLevelServer.removeRequestHandler('tools/call');
  lowLevelServer.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const requested = request.params.name;
    // #908: a retired legacy alias. `aliasTarget` is set only when the rewrite
    // is switched on AND the canonical name is actually registered, so an
    // opt-in rewrite can never dispatch into a module this session trimmed —
    // the `taste` toolset being off has to win over SPOTIFY_MCP_LEGACY_ALIASES.
    const aliasTarget = legacyAliasTarget(requested, registry);
    const registered = registry[requested];
    const resolved = aliasTarget ?? (registered && registered.enabled !== false ? requested : undefined);
    if (resolved === undefined) {
      // #848: one of the ten retired transfer/volume names. They are not in
      // `registry` — #848 withdrew those rows when the families collapsed —
      // and v3.0 removed the forwarding that used to make the name answer
      // anyway, so this is the whole path for them now.
      return retiredAliasResult(requested)
        ?? retiredForwardRefusal(requested)
        ?? unknownToolResult(registry, requested);
    }

    const entry = registry[resolved];
    const tool = safeIdentifier(resolved);
    const shape = getObjectShape(entry.inputSchema);
    const knownParams = shape ? Object.keys(shape) : [];
    // #848: fold this tool's still-accepted deprecated input spellings into
    // their canonical names, before validation, because `transfer_playback`'s
    // canonical `device` is REQUIRED, so a caller sending only `device_id`
    // would be refused `required_param` if the fold happened later. The legacy
    // key is removed here, which is what lets it stay out of the published
    // schema and cost no bytes on every `tools/list`.
    const { args, deprecated } = normalizeDeprecatedInputs(resolved, request.params.arguments ?? {});
    // #1287: a retired playlist input spelling is answered as its own typed
    // refusal BEFORE the unknown-parameter fallback, because the two claims are
    // different. `unknown_param` says "we never had that name"; these names were
    // in the registry until v3.0 and the caller is following a deprecation
    // notice we served them. It runs here, ahead of every handler and therefore
    // ahead of any Spotify request, which is where the removal contract says a
    // refused input must fail.
    const retired = retiredInputResult(tool, resolved, args);
    if (retired) return retired;
    // #1318: a stats.fm identity sent under both spellings with different
    // values is refused here, before the handler runs and therefore before any
    // stats.fm request, naming both fields.
    const identityConflict = statsfmIdentityConflict(tool, shape, args);
    if (identityConflict) return identityConflict;
    // #886: same reasoning as the playlist retirement above, for the walk caps
    // withdrawn from `take_playlist_snapshot` and `backup_library`. Ahead of
    // the unknown-parameter fallback for the same reason: the two claims are
    // different, and only one of them is true.
    const walkCap = retiredWalkCapResult(tool, args);
    if (walkCap) return walkCap;
    const unknown = Object.keys(args).find((param) => !knownParams.includes(param));
    if (unknown) return unknownParamResult(tool, unknown, knownParams);

    // #694: one encoding contract, in front of validation on every call. After
    // the unknown-key check, because a tolerated encoding is a VALUE and never a
    // key — a call carrying a genuinely unknown argument is still refused above,
    // which is the interaction the strict-schema unit asked to be guarded.
    const tolerantArgs = entry.inputSchema
      ? await encodingTolerantArgs(encodingPlanFor(entry.inputSchema), shape, args)
      : args;

    let parsedArgs: unknown;
    try {
      if (entry.inputSchema) {
        const parsed = await safeParseAsync(entry.inputSchema, tolerantArgs);
        if (!parsed.success) return validationResult(tool, shape, parsed.error);
        parsedArgs = parsed.data;
      }
    } catch {
      return validationResult(tool, shape, undefined);
    }

    // #600: a task-augmented call on a tool that advertises task support. The
    // work runs detached and the caller gets a task handle; the handle is
    // returned before any of it has happened, which is the entire point and
    // also why the confirmation gate below has to be the tool's own.
    if (request.params.task !== undefined) {
      if (!taskStore || !isTaskCapable(resolved)) {
        // A THROWN error, not a returned result. The SDK's `tools/call` wrapper
        // validates any response to a request that carried `task` against
        // `CreateTaskResultSchema`, so a `CallToolResult` handed back here is
        // turned into an opaque `-32602 Invalid task creation result` before it
        // reaches the client — the refusal would be written and never read.
        // Throwing bypasses that validation and delivers the sentence.
        //
        // Running it synchronously instead would be worse still: the client is
        // holding a task handle it never received, and a multi-minute tool
        // would block on a request the client already considers asynchronous.
        throw taskAugmentationRefused(tool, isTaskCapable(resolved));
      }
      return (await startTask({
        args: parsedArgs,
        extra,
        request,
        taskParams: request.params.task,
        store: taskStore,
        run: (signal) => invokeHandler(entry, parsedArgs, withTaskSignal(extra, signal)) as Promise<CallToolResult>,
      })) as ServerResult;
    }

    try {
      const result = await invokeHandler(entry, parsedArgs, extra);
      await validateOutput(entry, result, tool, request.params.task !== undefined);
      const statsfm = applyStatsfmIdentityDeprecation(result, shape, args);
      return (deprecated.length === 0
        ? statsfm
        : stampDeprecation(statsfm, deprecatedInputResolution(deprecated))) as ServerResult;
    } catch (error) {
      return errorResult(tool, publicFailure(tool, error), error) as ServerResult;
    }
  });

  return Object.keys(registry).length;
}

interface PromptRegistryEntry {
  argsSchema?: AnySchema;
  callback: (args: never, extra: unknown) => unknown;
  enabled?: boolean;
}

function getPromptRegistry(server: McpServer): Record<string, PromptRegistryEntry> {
  const registry = (server as unknown as { _registeredPrompts?: Record<string, PromptRegistryEntry> })._registeredPrompts;
  if (!registry || typeof registry !== 'object') {
    throw new Error('Spotify MCP prompt registry is unavailable; refusing to start without its error boundary');
  }
  return registry;
}

/**
 * A JSON-RPC error the caller can act on: `-32602` (Invalid params) and a
 * one-line message.
 *
 * Deliberately NOT `new McpError(ErrorCode.InvalidParams, …)`. `McpError`
 * formats its own message as `MCP error ${code}: ${message}`, so the prefix
 * lands in the string the protocol puts on the wire — which is exactly the
 * noise #689 asks to remove. `Protocol._onrequest` reads `error.code` and
 * `error.message` directly and never inspects the constructor, so an `Error`
 * carrying a numeric `code` serialises to the same `code` with a clean message.
 */
function invalidParams(message: string): Error {
  // `singleLine`, not `safeIdentifier`: the latter is for identifiers and would
  // turn every space and quote in a sentence into `?`. Caller-supplied names
  // inside the message were already run through `safeIdentifier` by the
  // message builders, so this only has to keep the string on one line.
  return Object.assign(new Error(singleLine(message, 400) ?? 'Invalid prompt arguments'), { code: ErrorCode.InvalidParams });
}

/**
 * Replace the SDK's `prompts/get` with the prompt-surface half of the same
 * boundary `installToolErrorBoundary` installs for tools (#689).
 *
 * The tool side already rejected unknown keys; prompts did not, and the gap
 * was worse than a missing check. `server.prompt()` builds a PLAIN
 * `z.object()`, which strips: a call carrying a misspelled argument rendered a
 * complete prompt built from defaults, with no signal that the argument the
 * caller cared about was dropped. `dj` declares no arguments at all and still
 * accepted `{mood: "chill"}`. And when validation did fire, the SDK rethrew
 * zod's own wording through `McpError`, so the wire read
 * `MCP error -32602: Invalid arguments for prompt playlist_audit: Invalid
 * input: expected string, received undefined at playlist`.
 *
 * So both halves of the tool boundary are mirrored here: reject an unknown key
 * before the callback, naming it and suggesting the real near-misses; and
 * normalise a schema failure into the same one-line envelope the tools return,
 * with the same rule about never claiming a constraint the schema does not
 * enforce.
 *
 * Strict rejection, not stripping, and the tools side is the deciding evidence:
 * a caller that misnames a tool argument is refused, so a caller that misnames
 * a prompt argument is refused too. One server, one contract — a boundary that
 * stripped here would make `prompts/get` and `tools/call` disagree about the
 * same mistake, and the lenient one would be the one that silently drops work.
 *
 * This does not narrow what a caller may put IN a known argument. Prompt
 * arguments already arrive as protocol strings and the numeric ones use
 * `z.coerce.number()`, so a host that can only express a scalar is served
 * today and still is.
 *
 * The handler is installed on the request-handler map directly rather than
 * through `setRequestHandler`, because that wrapper validates the request
 * against `GetPromptRequestSchema` — whose `arguments` are
 * `z.record(z.string(), z.string())` — and a caller that sends a number gets a
 * `-32603 InternalError` whose message is a pretty-printed zod issue array,
 * thrown before this boundary is ever entered. That is the exact failure #689
 * names, so the boundary has to see the request to answer it. The tools side
 * has no such trap: `CallToolRequestParamsSchema` declares
 * `z.record(z.string(), z.unknown())`, so a mistyped value reaches the tool
 * boundary and is answered in the tool envelope. If the map is not where the
 * SDK keeps it, refuse to start rather than serve the leaky boundary.
 */
export function installPromptErrorBoundary(server: McpServer): number {
  const registry = getPromptRegistry(server);
  const names = Object.keys(registry);
  // No prompts registered means the `prompts` capability was never declared
  // (a trimmed toolset), and the SDK refuses a `prompts/get` handler it
  // cannot justify. Nothing to guard, so nothing to install.
  if (names.length === 0) return 0;

  const lowLevelServer = server.server;
  const handlers = (lowLevelServer as unknown as { _requestHandlers?: unknown })._requestHandlers;
  if (!(handlers instanceof Map)) {
    throw new Error('Spotify MCP prompt error boundary cannot be installed; refusing to serve prompts with unvalidated arguments');
  }
  handlers.set('prompts/get', async (request: { params?: Record<string, unknown> }, extra: unknown) => {
    const params = (request?.params ?? {}) as { name?: unknown; arguments?: Record<string, unknown> };
    // The request schema no longer runs, so the one field it really did check
    // — that `name` is a string — is checked here instead.
    const requested = typeof params.name === 'string' ? params.name : '';
    // `Object.hasOwn`, not a bare index: the registry is a bare object literal,
    // so `getPrompt({name: "toString"})` must not reach Object.prototype.
    const entry = Object.hasOwn(registry, requested) ? registry[requested] : undefined;
    if (!entry) {
      const suggestions = nearestNames(requested, names);
      throw invalidParams(`Prompt ${safeIdentifier(requested)} is not an available prompt; ${suggestions.length > 0 ? `call ${humanList(suggestions)} instead.` : 'call a prompt advertised by prompts/list instead.'}`);
    }
    if (entry.enabled === false) {
      throw invalidParams(`Prompt ${safeIdentifier(requested)} is disabled; call a prompt advertised by prompts/list instead.`);
    }

    const shape = getObjectShape(entry.argsSchema);
    const knownArgs = shape ? Object.keys(shape) : [];
    const args = params.arguments ?? {};
    const unknown = Object.keys(args).find((arg) => !knownArgs.includes(arg));
    if (unknown) throw invalidParams(unknownPromptArg(requested, unknown, knownArgs));

    // A non-string argument value never reached the schema either: the request
    // parse that used to reject it is gone, and zod's own `invalid_type` is the
    // honest report. Name the argument and say what MCP asked for.
    const nonString = Object.keys(args).find((arg) => typeof args[arg] !== 'string');
    if (nonString !== undefined) {
      throw invalidParams(promptNonStringArg(requested, nonString));
    }

    if (!entry.argsSchema) return await Promise.resolve(entry.callback(undefined as never, extra)) as ServerResult;

    // #694: the same encoding contract as `tools/call`, so the two surfaces
    // cannot disagree about the same value. It matters most here because EVERY
    // prompt argument arrives as a string — MCP's own request schema is
    // `z.record(z.string(), z.string())` — so a numeric or enum argument from a
    // host is a quoted scalar by construction, not by that host's mistake.
    const tolerantArgs = await encodingTolerantArgs(encodingPlanFor(entry.argsSchema), shape, args);

    let outcome: { ok: true; args: unknown } | { ok: false; message: string };
    try {
      const parsed = await safeParseAsync(entry.argsSchema, tolerantArgs);
      outcome = parsed.success
        ? { ok: true, args: parsed.data }
        : { ok: false, message: promptValidationText(requested, shape, parsed.error) };
    } catch {
      outcome = { ok: false, message: `${requested} rejected arguments; pass values that match the prompt schema.` };
    }
    if (!outcome.ok) throw invalidParams(outcome.message);
    return await Promise.resolve(entry.callback(outcome.args as never, extra)) as ServerResult;
  });

  return names.length;
}

function unknownPromptArg(prompt: string, arg: string, candidates: string[]) {
  const name = safeIdentifier(prompt);
  if (candidates.length === 0) {
    return `${name} does not accept argument ${safeIdentifier(arg)}; remove it, ${name} takes no arguments`;
  }
  const suggestions = nearestNames(arg, candidates);
  if (suggestions.length === 0) {
    return `${name} does not accept argument ${safeIdentifier(arg)}; remove it and use only arguments advertised by prompts/list instead`;
  }
  return `${name} does not accept argument ${safeIdentifier(arg)}; remove it and use ${humanList(suggestions)} instead`;
}

/**
 * MCP prompt arguments are `z.record(z.string(), z.string())` on the wire — the
 * spec's `{"[key": "string"}`. A caller that sends a number is wrong, and used
 * to be told so by a `-32603` carrying a zod issue array. Say the same thing
 * in the form the caller can act on.
 */
function promptNonStringArg(prompt: string, arg: string) {
  return `${safeIdentifier(prompt)} rejected argument ${safeIdentifier(arg)}: expected a string, because MCP prompt arguments are transmitted as strings; pass the value as a string`;
}

function promptValidationText(prompt: string, shape: Record<string, AnySchema> | undefined, error: unknown) {
  const envelope = validationEnvelope(safeIdentifier(prompt), 'prompt', 'argument', shape, error, validationParam(error));
  return envelope.text;
}
