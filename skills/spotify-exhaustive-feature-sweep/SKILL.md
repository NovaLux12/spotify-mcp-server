---
name: "spotify-exhaustive-feature-sweep"
description: "Exhaustive feature sweep across Spotify domains — enumerate all endpoints into quantity-first tool proposals with quota flags and batched GitHub logging"
---

# Spotify Exhaustive Feature Sweep

## When to Use

Use this workflow for an exhaustive or quantity-first feature sweep: finding
maximum viable candidates across Catalog/Search/Browse,
Playback/Queue/Devices, Playlists/Library/Social, and
Portability/Analytics/Resources/Prompts.

Ground every inventory and candidate in the current checkout, live MCP
registry, official Spotify OpenAPI schema, and (when credentials are available)
a real API response. Historical issue numbers, branch names, and prose counts
are leads at most, never current truth.

<!-- BEGIN:generated surface-census -->
Current default production baseline: **592 tools**, **16 fixed resources**, **33 resource templates**, and **14 prompts**. Regenerate with `npm run count:tools -- --write`; never substitute historical prose.
<!-- END:generated surface-census -->

## Procedure

1. Inventory current coverage per domain.
   - Connect to the current server and call `toolset_report`; record
     `registered_tools`, `active_toolsets`, and `active_modules` as the live
     tool baseline. `tools/list` is the equivalent protocol evidence.
   - Call `resources/list`, `resources/templates/list`, and `prompts/list` and
     record their live sizes separately.
   - Map endpoints to registrations by reading `src/index.ts`, `src/toolsets.ts`,
     `src/resources/index.ts`, `src/resources/templates.ts`, `src/prompts/index.ts`,
     and the relevant `src/tools/*.ts` modules. A grep count of
     `server.tool` / `registerTool` is not a registry count because it misses
     factories and includes gated or unused modules.
   - Read `SPEC.md` section 10 as project history, then verify removals and
     registration gates against the official schema and live responses. Do not
     assume an endpoint is current merely because prose names it.
   - Completion: live primitive counts, active modules, and an endpoint-to-tool
     map distinguish wrapped, gated, removed, and genuine gaps.

2. Inventory open work to avoid duplicates.
   - Use `gh pr list --state all` and `gh issue list --state all` to inspect
     current and recently closed work. Filter by endpoint/tool names from the
     inventory, not by old issue-number ranges.
   - Inspect candidate branches/worktrees only when they still exist; record the
     exact branch and compare it with the current base before treating a tool
     as unshipped.
   - Completion: an endpoint/name-based duplicate table records shipped, active,
     closed-unmerged, and genuinely open work.

3. Enumerate Spotify endpoints by domain, quantity-first.
   - Start from the current official Spotify OpenAPI schema. Cover Search,
     Browse, Catalog, Player, Playlists, Library, Follow, User, Show/Episode,
     Audiobook/Chapter, and current stats.fm surfaces where relevant.
   - Verify every query parameter, body field, and response key in the schema.
     Mark `SPEC.md` section 9 entries as historical leads; classify live
     removal (`404`/`410`), app-registration gating (`403` with a generic
     reason), and operational status separately.
   - Completion: every current endpoint is mapped to a tool/resource/prompt,
     a verified gap, or a documented reason it is out of scope.

4. Expand each real gap into ergonomic wrappers.
   - Consider typed-search splits, filtered saved-library families, batch
     lookups, deep-dive bundles, market previews, `include_groups` shortcuts,
     portability sidecars, analytics, resources, and prompts only when they
     serve a concrete consumer job.
   - Preserve the existing shaping contract: `response_format`,
     `max_results`, truncation disclosure, and `getAllPages` caps. Reuse
     `makeTypedSearchTool` in `src/tools/catalog.ts` and the shared helpers in
     `src/client.ts` and `src/shaping.ts`; do not create a parallel convention.
   - Completion: each card has a unique name, pitch, verified endpoint(s),
     parameters, use case, quota cost, implementation reuse, and ship bucket.

5. Flag quota cost and phantom-endpoint risk.
   - Tag single-call work as low cost, bounded multi-call work as moderate, and
     N+1/fan-out work as high with an explicit request-budget disclosure.
   - If Spotify has no endpoint for a desired verb, propose an honest local or
     multi-call workaround and label it as such. Never invent reorder, remove,
     clear, recommendation, audio-feature, or related-artist endpoints.
   - Completion: every ranked card includes quota behavior, pagination/caps,
     partial-failure behavior, and whether it is read-only or mutating.

6. Write the per-domain deliverable.
   - Write `/tmp/exhaust-<domain>.md` with the live baseline, endpoint map,
     ranked table, proposal cards, quick reference, ship buckets, and the top
     five ordered by value, ergonomics, and quota efficiency.
   - Express count impact as `live registered_tools + accepted net additions`;
     do not hardcode a historical total or predict the final total before
     dedupe and review.
   - Completion: another agent can implement each P0/P1 card from the card and
     endpoint evidence without rediscovering the baseline.

7. Audit and dedupe across domains before logging.
   - Merge by normalized endpoint, user job, and proposed tool name. Drop
     duplicates, already-shipped work, removed endpoints, and unsupported
     assumptions. Keep P2/high-cost ideas in the backlog rather than forcing
     them into the ship set.
   - Re-run the registry comparison after the ship set is chosen; accepted
     proposals must not reduce the current live registered-tool surface.
   - Completion: `/tmp/exhaust-audit.md` records raw → unique → accepted counts,
     duplicate decisions, priority table, and final ship list.

8. Log agreed issues in rate-limited batches.
   - Create one issue per accepted proposal with `gh issue create`, including
     verified endpoint evidence, acceptance criteria, quota behavior, and
     duplicate-search results.
   - Follow the repository's current GitHub issue-filing procedure and rate
     limits. Record every returned issue URL; do not infer success from a loop
     exit code alone.
   - Completion: the accepted ship list and created issue URLs reconcile
     one-to-one, with skipped items explained.

9. Dispatch partitioned implementation slices in isolated worktrees.
   - Partition the ship list into non-overlapping endpoint/tool slices and
     create each worktree from the agreed base, for example with
     `git worktree add /tmp/fix-exhaust-<slice> -b fix/exhaust-<slice> <base>`.
   - Give every worker its explicit issue set, owned files, shared interfaces,
     and a no-merge instruction. Require behavioral regression tests for
     consumer-visible behavior, then run the repository's own `npm test` and
     `npm run build` gates once per integrated change.
   - Completion: slices are disjoint, their base is recorded, and no worker
     merges another slice.

10. Run independent review and fix findings without merging.
    - Partition implementation branches into review groups and assign one
      reviewer per group. Each review checks issue behavior, current API/schema
      evidence, duplicate names, mutation safety, quota disclosure, response
      shaping, and whether the live registry surface increased as expected.
    - Require `gh pr view` and `gh issue view` for expected behavior, source
      review, the project test/build gates, and fixes pushed to the owning PR
      branch. Reports must name risks and unresolved findings; a numeric score
      is optional and never replaces evidence.
    - Completion: every finding is fixed or explicitly accepted by the
      integrator, CI is green, and no review worker merges.

11. Ground-truth uncertain endpoints with real credentials.
    - Write auditable probe files under `scripts/` rather than embedding an
      authorization header in a shell command. Keep credentials in the token
      file or environment and redact outputs before saving evidence.
    - Classify responses carefully: `200` alive; `404` removed/not found;
      `410` gone; a generic `403 Forbidden` may be app-registration gating,
      while a scope error has a distinct message. Confirm scope-related reads
      before blaming the token.
    - Verify tool behavior through the built stdio server. After
      `npm run build`, start it with
      `node --env-file-if-exists=.env dist/index.js` (or `npm start`) and drive
      JSON-RPC over stdin/stdout. Use `tools/list` or `toolset_report` for the
      live count, and call candidate tools with minimal read-only arguments.
    - Record gated/dead endpoints in the live sweep report and gauntlet skip
      sets. Do not turn a prior app-registration observation into a permanent
      universal claim.
    - Completion: an evidence record maps each uncertain endpoint to status,
      response, timestamp, and the tool/resource behavior observed.

12. Run the live sweep with the current package scripts.
    - Use `npm run sweep` for one batch and `npm run sweep:loop` for the
      quota-paced loop. The package scripts pass the current
      `--batch`, `--resume`, and `--report` flags to
      `scripts/live-gauntlet.mjs`; `scripts/sweep-loop.sh` controls `BATCH`,
      `INTERVAL`, `REPORT`, and `MAX_BATCHES`.
    - Keep batches below the observed quota wall, space them with `INTERVAL`,
      and allow `SWEEP_RETRY_MAX` to cap retries. Inspect the report and resume
      file after each run; the script merges prior records with current results.
    - For an unattended loop, launch the package script detached, for example
      `setsid nohup npm run sweep:loop > memory/sweep-loop.log 2>&1 &`.
      Confirm a live process with
      `ps -eo pid,etime,cmd | grep -E 'sweep-loop|live-gauntlet'` and check the
      log mtime before leaving it unattended.
    - Treat mid-batch silence as normal until process state and log mtime are
      checked. Stop the loop if a resumed batch repeats the same tool set
      without recording new entries or clean skips.
    - Completion: the report accounts for every discovered tool as PASS,
      SKIP/gated, or an explained FAIL; report and resume artifacts exist; no
      unexplained failures remain.

## Guardrails

- Never propose a phantom endpoint or a removed API as if it were live. Verify
  paths, parameters, and schemas against the current official OpenAPI document.
- Respect Spotify batch limits, `SPOTIFY_MCP_FETCH_ALL_CAP`, request budgets,
  `Retry-After`, and the shared response-shaping helpers.
- Preserve the live registered-tool baseline unless the user explicitly asks
  for a breaking cutover; accepted net additions must not reduce that surface.
- Keep mutation tools read-only/dry-run safe where required, disclose fan-out
  cost, and never bypass elicitation or scope gates.
- Verify a workflow or script path exists on the target ref before invoking it;
  a missing file is not a transient GitHub Actions failure.
- Do not present a proposal, historical issue, or documented endpoint as
  shipped. Re-check `tools/list`, the issue tracker, and the current source.

## References

- `package.json` — package scripts and MCP SDK dependency.
- `src/index.ts` — live registration gates and stdio entry.
- `src/toolsets.ts` — active-set and per-module override semantics.
- `src/tools/*.ts` — tool implementations and graceful endpoint handling.
- `src/resources/index.ts` and `src/resources/templates.ts` — live resource
  and template registrations, including show/episode ID completions.
- `src/prompts/index.ts` — prompt registrations.
- `src/client.ts`, `src/config.ts`, and `src/shaping.ts` — pagination, caps,
  and response shaping.
- `scripts/live-gauntlet.mjs` and `scripts/sweep-loop.sh` — live sweep flags,
  safety classifications, retry, and report behavior.
- `docs/configuration.md`, `docs/faq.md`, `docs/cookbook.md`, and
  `docs/distribution.md` — current operator and packaging context.
- `memory/live-sweep-report.json` — latest persisted sweep evidence; refresh it
  rather than treating an old run as current truth.
- Official Spotify OpenAPI schema:
  `https://developer.spotify.com/reference/web-api/open-api-schema.yaml`.
