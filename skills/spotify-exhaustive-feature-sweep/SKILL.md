---
name: "spotify-exhaustive-feature-sweep"
description: "Exhaustive feature sweep across Spotify domains — enumerate all endpoints into quantity-first tool proposals with quota flags and batched GitHub logging"
---

# Spotify Exhaustive Feature Sweep

## When to Use
- Asked to do exhaustive/quantity-first sweep, beat N tools, find maximum candidates, or scout new features across Spotify domains (Catalog/Search/Browse, Playback/Queue/Devices, Playlists/Library/Social, Portability/Analytics/Resources/Prompts).

## Procedure

1. Inventory current coverage per domain.
   - Count `grep -r "server\.tool" src/tools/*.ts | wc -l` (e.g., 538 server-wide as of v1.27.1) and per-domain files (playback.ts 16 + playbackext.ts 13 + queueops.ts 3 + scenes.ts 6 =38); read `SPEC.md §9` removed list and `src/tools/*.ts` for existing endpoint coverage.
   - Completion: baseline tool count and removed-endpoint list recorded; endpoint→tool map drafted showing wrapped vs gap.

2. Inventory open work to avoid duplicates.
   - List `git branch -a` and diff each open `swarm/*` and `fix/quota-*` branch vs main; note PRs #243-255 tools (e.g., search_saved_tracks, export_listening_history, save_queue_as_playlist already open).
   - Completion: table of open branches → new tools noted; duplicates excluded from candidates.

3. Enumerate every non-deprecated endpoint in each domainquantity-first.
   - For assigned domain, list all live reads/writes (Search GET /search, Browse /browse/categories*, Catalog /tracks|albums|artists|shows|episodes|audiobooks|chapters, Player /me/player*, Playlists /playlists/{id}*, Follow /me/following, User /me, etc.); mark SPEC §9 deprecated as excluded (recommendations, audio-features, audio-analysis, related-artists, featured/new-releases).
   - Completion: checklist with ≥1 candidate per live endpoint; deprecated explicitly marked excluded.

4. Expand each endpoint into 1-3 ergonomic wrappers.
   - Apply expansion patterns: typed-search split (one endpoint ×7 type wrappers), saved-library filter family (/me/{type} + client filter), batch fan-out (catalog_batch_lookup mixed URIs, playlist set-algebra union/subtract/symmetric-difference), deep-dive bundles (category→playlists→peek, listening_session snapshot), market previews, include_groups shortcuts, portability sidecars (export/delta/snapshot-diff), analytics and resources/prompts.
   - Completion: 20±2 ranked proposals per domain; each card has name, pitch, endpoint(s), params, use case, quota flag, ship bucket (P0/P1/P2/P3).

5. Flag quota cost and phantom-endpoint policy for every candidate.
   - Tag 🟢 single call, 🟡 moderate (2-3 calls or optional getAllPages), 🔴 N+1/fan-out with disclosure line; enforce phantom-endpoint policy: if endpoint does not exist (e.g., only GET+POST /me/player/queue are real, no reorder/remove/clear), propose honest-workaround with disclosure contract rather than claiming phantom.
   - Completion: ranked table includes Quota column and factory reuse note (makeTypedSearchTool in src/tools/catalog.ts, fetchSeveral chunking at 20-50, getAllPages in src/client.ts).

6. Write per-domain deliverable and highlight top 5.
   - Write `/tmp/exhaust-<domain>.md` with ranked table, detailed cards, endpoint quick-reference, ship buckets, and top-5 ordered by ergonomics × selling power × quota efficiency; include tool-count impact (e.g., 538→~598 as of v1.27.1).
   - Completion: markdown ≥15k with ranked table, 5 highlighted with rationale, count summary.

7. Audit and dedupe across domains before logging.
   - Merge all scout outputs: intra-dedupe, skip already-open issues (e.g., #229, #220, #224), drop deprecated, produce 73 unique → cap ship to 60 P0/P1 to avoid flooding, defer P2/🔴 to backlog; verify monotonic tool count beyond baseline floor (154, current 538 as of v1.27.1).
   - Completion: audit file `/tmp/exhaust-audit.md` ≥10k with raw→unique→ship counts, priority table, and ship list.

8. Log GitHub issues in rate-limited batch.
   - Create issues with `gh issue create` in loop with 1s sleep to respect rate limit; monitor with `gh issue list --state open --json number --jq 'length'`; forward full stdout on success; handle long-pole (60 creates ~60s) without re-triggering scouts.
   - Completion: up to 60 issues created; final open count and URLs reported.

9. Dispatch partitioned swarm and hold merges for review.
   - Partition ship list into non-overlapping slices (e.g., catalog 15, playback 12, playlists 15, portability 12, misc 10) and open one isolated worktree per slice via `git worktree add /tmp/fix-exhaust-<slice> -b fix/exhaust-<slice> origin/main`; assign each slice its explicit `closes #N` set and an explicit DO NOT MERGE instruction.
   - Require each worker subagent to reuse shaping helpers (`resolveMaxResults`/`truncateItems`/`getAllPages`/`resolveDeviceHint`), add 1-2 tests per tool, pass `npm test` and `npm run build`, commit conventionally (`feat(<domain>): ...`), push branch, and open PR via `gh pr create` listing its closes; report PR URL without merging.
   - Completion: one PR per slice opened against `origin/main` with no merges; closed-issue sets are disjoint and sum to ship list.

10. Run independent adversarial review-and-fix swarm before any merge (hold merges).
    - Partition PRs into groups (e.g., 3 PRs/group, 5 groups for 14 PRs) and delegate one reviewer per group, using the project's preferred task-delegation mechanism; give each group explicit DO NOT MERGE, fix-by-pushing-to-PR-branch instructions and per-PR checklists (watermark hold, budget cap, dry_run cost disclosure, 429 partial recovery, phantom-queue disclosure, tool-count monotonic 154→, duplicate tool names, deprecated endpoints, quota flags).
    - Require per PR: `gh pr view` + `gh issue view` for expected behavior, `git worktree` isolation, source review vs issue, `npm test` + `npm run build` with fixes in place, doc counts verification, `fix(review): <detail>` commit and `git push origin HEAD:<branch>`, 100/100 score and `/tmp/review-<group>-report.md` with scores, fixes, risks, PR URLs.
    - Completion: all PRs scored 100/100, failing checks fixed and pushed, reports present, no merges performed.

11. Ground-truth live accessibility against a real key before trusting SPEC §9 alone.
   - Probe the undocumented/removed/dubious surface with a real token. Write probes as files under scripts/ (e.g., edge-probe.mjs); never inline `node -e` with an Authorization header — the redaction layer mangles `Bearer` expressions to `***` and breaks syntax, while file-based scripts run clean. The redactor also masks identifier-shaped text in edit/write/exec args and file-write content: property names that read as secrets (a counter's PASS member, pass-prefixed keys, token-property dot-access) get elided to `***`/ellipsis forms, silently corrupting programmatic patches (observed 2026-08-27: an invalid object key written to disk; a mangled edit needle that applied as a no-op). Build such strings via string concatenation inside file-based patcher scripts, and verify every programmatic patch — `node --check` for JS targets, a read-back diff otherwise.
   - Classify every response: 200 ALIVE; 404 removed-dead; 410 gone; blanket `403 {"error":{"status":403,"message":"Forbidden"}}` with no reason field = app-registration gating, NOT a scope problem (scope errors carry distinct messages; if scope-requiring reads such as saved-tracks/top-artists return 200 while many documented endpoints 403 identically, the 403 family is app-gated, not a token defect).
   - Verify tool-level behaviour by spawning the built server (`node --env-file=.env dist/index.js`) and driving JSON-RPC over stdio. Use the live `tools/list` count as ground truth (docs drift observed 2026-08-27: 224 registered vs 212 documented) and call candidate tools with minimal read-only args to expose raw vs graceful 403 handling.
   - Record gated endpoints in the gauntlet REMOVED set as SKIP, never FAIL; prefer live fallbacks when verified (undocumented `/me/library/contains` returned 200 while every documented `/me/*/contains` variant 403'd, verified 2026-08-27).
   - Completion: endpoint map (alive/dead/gone/gated) recorded in memory/ with probe scripts kept in scripts/, REMOVED set covers the gated class, drift counts filed as issues.

12. Run the live sweep loop staggered and adaptive, never as one burst.
   - Size each batch under the observed quota ceiling (e.g., BATCH=40 vs a ~45-call wall), sleep a fixed INTERVAL (default 1800s) between batches, and let FAILs retry on later batches so a mid-sweep wall never poisons results.
   - Guard against wasted batches: after 3 consecutive failures, abort the batch with a `QUOTA_WALL` marker and have the loop double its sleep; the client fails fast on `QUOTA_EXCEEDED` (throws with `retryAfterSec`), so a wall costs seconds of timeouts, not minutes.
   - Verify persistence separately from the run's summary line: after any smoke run that claims to write its report, `ls` the artifact — a clean "8 passed" summary can still mean the report silently never saved; confirm every new CLI flag (`--report=`) is actually parsed by the target script (a flag the script still only reads positionally drops the output), and rerun smoke until artifact + resume file exist.
   - Make the batch report cumulative or the loop never finishes: each run must merge prior records with its own before writing (`new Map(done)` seeded from the resume load, then `merged.set(r.tool, r)` for this run, write the union, count the summary over the union). If a run overwrites the report with only its own records, `--resume` skips just the previous batch's records and later batches re-run the same early tools instead of progressing (observed 2026-08-27: batch 3 re-ran batch 1's tool list; loop would have cycled to MAX_BATCHES without completing).
   - Cap FAIL retries (e.g., 2 attempts via `SWEEP_RETRY_MAX`): record `attempts` on each FAIL and skip resuming tools at the cap, or 120s quota timeouts get retried every batch and starve the batch budget forever.
   - Launch the loop detached so host restarts cannot reap it: `setsid nohup bash scripts/sweep-loop.sh ... &`, never a plain background exec session — a gateway/exec restart kills session-anchored children silently and leaves only the latest batch header in the log. After launching, confirm a live `sweep-loop`/`live-gauntlet` pid (`ps -eo pid,etime,cmd | grep -E 'sweep-loop|live-gauntlet'`) and a fresh log mtime before walking away.
   - Distinguish running from dead before diagnosing a silent loop: the loop echoes a batch's output only after the batch completes, so mid-batch silence is normal — check ps plus log mtime first; "LOOP NOT RUNNING" plus a stale mtime means the loop died and must be relaunched with the detached command above.
   - Verify progression between batches before leaving a loop unattended: diff consecutive batch tool lists in the loop log — each batch must record new tool names or cleanly resumed skips. A batch repeating an earlier batch's list means resume state is lost: stop the loop, fix the merge, archive the stale report (rename, never delete), restart.
   - Completion: sweep runs in staggered batches to a complete report with zero FAILs; report and resume files exist after every batch; consecutive batches show new tool names.

## Guardrails
- Never propose SPEC §9 removed endpoints; respect batch limits (chunk at 20-50) and SPOTIFY_MCP_FETCH_ALL_CAP; keep response_format/max_results/truncateItems shaping consistent.
- Keep monotonic tool count: never propose restorations that drop below published floor (154 at v1.22.0, current 538 at v1.27.1); net adds only.

## References
- Sources: SPEC.md §9, src/tools/*.ts, src/client.ts getAllPages, src/config.ts caps (DEFAULT_FETCH_ALL_CAP), src/shaping.ts helpers, audit-quota-lurkers.md.
- Prior patterns: spotify-exhaustive-catalog-sweep (domain-specific), swarm PRs #243-248, fix/quota PRs #254-255.
