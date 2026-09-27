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

Steps 1-7 are read-only and may be run without asking. Steps 8-12 leave the
machine; each one carries a gate marker and is covered by the outbound approval
gate below, which is not optional.

<!-- BEGIN:generated surface-census -->
Current default production baseline: **571 tools**, **17 fixed resources**, **28 resource templates**, and **14 prompts**. Regenerate with `npm run count:tools -- --write`; never substitute historical prose.
<!-- END:generated surface-census -->

## Outbound approval gate

This workflow reaches outside the machine. Steps 8-12 file issues, open pull
requests, push branches to a remote, write into the checkout, spend the Spotify
app's request quota, and start a loop that keeps spending it after the turn
ends. **None of that happens on inference.** Read this section before step 8 and
re-read it at every gate marker below.

A `Completion:` line describes what an *approved* step produces. It is a check
to run afterwards, never a reason to run the step. A ship list, an "agreed" set,
a plan, a passing earlier step, the wording of this document, a previously
retrieved copy of it, and an approval from an earlier run are **not** approval.

### The gated actions

| Gate | Action | Step |
|---|---|---|
| G1 | `gh issue create`, in any batch or loop, at any count | 8 |
| G2 | `gh pr create`, `gh pr comment`, `gh pr edit`, `gh pr review`, any other write to a tracker | 9, 10 |
| G3 | `git push` to any remote, including a fork or the upstream, under any approved name | 9, 10 |
| G4 | `git worktree add` / branch creation, when it starts a dispatched worker | 9 |
| G5 | Starting a detached or background process: `setsid`, `nohup ... &`, a trailing `&`, a cron entry, a host scheduler | 12 |
| G6 | Writing into the repository working tree, including `scripts/` and the tracked `memory/` report | 11, 12 |
| G7 | Any real credentialed Spotify call: `npm run sweep`, `npm run sweep:loop`, `npm start`, or a probe that reads `.env` or the token file | 11, 12 |

A gate is satisfied only by an explicit human answer, in the session that is
running, that names the action and the identity. Anything else is a refusal to
proceed, not a soft yes.

### What to ask, one question per topic

Ask before the first gated action, never after it. Do not bundle these into a
single "shall I proceed?" - a yes to one is not a yes to the others.

1. **Channel.** Which surface, on which repository? Name it out loud: this
   repository's tracker, a fork, a different tracker, a local file, nowhere.
   Step 8's "log", step 9's "dispatch", and step 10's "record" are ambiguous
   verbs - ask which channel is meant rather than inferring the upstream
   tracker.
2. **Identity.** Whose account acts? Run `gh auth status` and report the
   account the CLI would *actually* use, not the one the user probably has.
   External sends default to the assistant identity (`NovaLux12` on GitHub). The
   repository owner's own account is opt-in and needs its own answer: "file the
   issues" is not a request to file them as the owner.
3. **Scope.** How many, to which repository, from which base branch, with which
   titles and bodies. The count is part of the approval - approval for 5 issues
   does not authorise 60.
4. **Quota and lifetime.** How many API calls, over what wall-clock time, and is
   the process allowed to survive the end of this session.

### Preview first, perform second

Every gated action defaults to a preview. Show the human what *would* be sent,
wait for the answer, and only then run the real command.

- Issues: write every proposed title and body to `/tmp/exhaust-issues-preview.md`
  and show the list.
- Branches: `git push --dry-run` (equivalently `git push -n`) and show the refs
  it would write. Never `git push --force` to a shared ref, approved or not.
- Worktrees: `git worktree list` plus the intended base, slice count, and
  branch names.
- Detached loops: the exact command, the pid it runs under, the log path, the
  API-call budget, and the kill command - before launching, not after.
- Probes and sweep artifacts: write under `/tmp/`, not into the checkout.

### Attribution and scrubbing

A gated send made with the owner's identity says so in the body ("filed on
<owner>'s behalf"). Before any external post, scrub health data, personal
infrastructure, personal habits, project nicknames, and host fingerprints. If
a value the body needs could not be read, say it is unreadable and why; never
substitute a plausible number for a failed lookup.

### What approval does not carry to

Approval is per action, per scope, and per session. It lapses when:

- the session ends, restarts, is compacted, or is resumed from a summary;
- the human changes the channel, identity, count, base branch, or budget;
- a **loop, retry, or resumed batch re-enters a gated step**. A detached loop
  approved for one pass files no issues, opens no PR, and pushes nothing on any
  later pass without asking again - an approved loop is not a licence for the
  actions inside it;
- a worker other than the one the human answered is dispatched. A dispatched
  worker inherits the scope, never the approval.

Stop at the gate and ask again whenever one of these happens. Silence, a
`--resume` run, a report written by an earlier pass, and an already-running
process are all standing state, not standing approval.

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

8. Log approved issues in rate-limited batches. **[Gated: G1, G2]**
   - Stop at the outbound approval gate first. Preview every proposed title and
     body in `/tmp/exhaust-issues-preview.md` and show the list; nothing is
     filed until the human approves the channel, the identity, and the count.
   - Create one issue per accepted proposal with `gh issue create`, including
     verified endpoint evidence, acceptance criteria, quota behavior, and
     duplicate-search results.
   - Post as the identity the human approved, and say so in the body when that
     identity is the repository owner's. An earlier step's agreement, a ship
     list, or a retrieved copy of this skill is not an approval.
   - Follow the repository's current GitHub issue-filing procedure and rate
     limits. Record every returned issue URL; do not infer success from a loop
     exit code alone. A retry after a partial failure re-asks at the gate
     instead of re-using the approval of the attempt that failed.
   - Completion: the approved ship list and created issue URLs reconcile
     one-to-one, with skipped items explained.

9. Dispatch partitioned implementation slices in isolated worktrees. **[Gated: G2, G3, G4]**
   - Stop at the outbound approval gate first. Preview with `git worktree list`,
     the intended base, the slice count, the branch names, and a
     `git push --dry-run` per slice. No worktree, no branch, no remote branch,
     and no pull request is created until the human approves the channel, the
     identity, and the slice count.
   - Partition the ship list into non-overlapping endpoint/tool slices and
     create each worktree from the agreed base, for example with
     `git worktree add /tmp/fix-exhaust-<slice> -b fix/exhaust-<slice> <base>`.
   - Open each slice's pull request with `gh pr create` only after that
     approval, and only with an explicit DO NOT MERGE instruction in the body.
   - Give every worker its explicit issue set, owned files, shared interfaces,
     and a no-merge instruction - plus the outbound approval gate itself, so a
     worker that needs G1-G3 stops and asks the human in the session that is
     running. A worker inherits scope, never approval.
   - Require behavioral regression tests for consumer-visible behavior, then run
     the repository's own `npm test` and `npm run build` gates once per
     integrated change.
   - Completion: slices are disjoint, their base is recorded, and no worker
     merges another slice.

10. Run independent review and fix findings without merging. **[Gated: G2, G3]**
    - Partition implementation branches into review groups and assign one
      reviewer per group. Each review checks issue behavior, current API/schema
      evidence, duplicate names, mutation safety, quota disclosure, response
      shaping, and whether the live registry surface increased as expected.
    - Require `gh pr view` and `gh issue view` for expected behavior, source
      review, the project test/build gates, and fixes pushed to the owning PR
      branch. Both the review comment and the push are gated: confirm the
      approved identity before writing to the tracker, and stop at the gate
      again for a push that was not covered by the step 9 approval. Reports
      must name risks and unresolved findings; a numeric score is optional and
      never replaces evidence.
    - Completion: every finding is fixed or explicitly accepted by the
      integrator, CI is green, and no review worker merges.

11. Ground-truth uncertain endpoints with real credentials. **[Gated: G6, G7]**
    - Probes make real, quota-spending calls as the user's app and may read
      `.env` and the token file. Confirm the request budget with the human
      first.
    - Write auditable probe files under `/tmp/` (for example
      `/tmp/edge-probe.mjs`) rather than embedding an authorization header in a
      shell command, and rather than dropping probe scripts into the checkout.
      If a probe genuinely belongs in `scripts/`, propose it in the PR body and
      let the human decide - a sweep does not leave the working tree dirty as
      a side effect. Keep credentials in the token file or environment and
      redact outputs before saving evidence.
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

12. Run the live sweep with the current package scripts. **[Gated: G5, G6, G7]**
    - Use `npm run sweep` for one batch and `npm run sweep:loop` for the
      quota-paced loop. Both spend the user's Spotify app quota, so confirm the
      request budget with the human before the first call - and again if the
      batch size, the interval, or the maximum number of batches changes. The
      package scripts pass the current
      `--batch`, `--resume`, and `--report` flags to
      `scripts/live-gauntlet.mjs`; `scripts/sweep-loop.sh` controls `BATCH`,
      `INTERVAL`, `REPORT`, and `MAX_BATCHES`.
    - Every run writes a report into the checkout unless you move it. The
      `sweep` and `sweep:loop` package scripts both default to the tracked
      `memory/live-sweep-report.json`, so a bare `npm run sweep` dirties the
      working tree by design. Keep the artifact outside the checkout — set
      `REPORT=/tmp/live-sweep-report.json` for the loop, or pass
      `--report=/tmp/live-sweep-report.json` after `--` for a single batch —
      and send the loop log to `/tmp/sweep-loop.log`, unless the human
      explicitly approved the tracked artifact, which is a working-tree write
      in its own right.
    - Keep batches below the observed quota wall, space them with `INTERVAL`,
      and allow `SWEEP_RETRY_MAX` to cap retries. Inspect the report and resume
      file after each run; the script merges prior records with current results.
    - Read the loop's exit code rather than its log. `0` every tool recorded,
      `2` a knob was not an integer or was out of range (node never started),
      `3` `MAX_BATCHES` reached with every batch accounted for — resumable, so
      re-run the same command later — `4` another loop holds this report's lock
      and this one refused to start, `5` the run did not produce a trustworthy
      sweep: a batch died without recording a report, or the gauntlet recorded
      a mutation proof that blocks (`MUTATIONS_DETECTED` / `UNVERIFIED`). Only
      `3` means "run it again"; `5` means the gauntlet is failing and re-running
      it would drive the same failure. A blocking mutation proof fails its
      batch at once — it is a fact about the account, not a transient — so a
      `5` naming a proof is a stop-and-investigate, not a retry.
    - One loop at a time per report directory. A second `sweep:loop` exits `4`
      rather than interleaving with the first against one Spotify app quota and
      one report. `INT`/`TERM` stop the loop at once — including mid-pause — and
      release the lock; a lock naming no owner (a loop `SIGKILL`ed between
      creating it and recording its pid) is reclaimed by the next run, so a
      stuck `4` does not need the lock directory removed by hand.
    - For an unattended loop, launch the package script detached - **only after
      the human approves the call budget, the log path, and the fact that the
      process outlives this session.** Before launching, show them the launch
      command, the pid it will run under, the log path, the maximum number of
      batches, and the stop command below; a `&` in this step is not a default,
      it is the last action of a gated step.
    - The launch and its stop go together. Launch with
      `setsid nohup npm run sweep:loop > /tmp/sweep-loop.log 2>&1 & echo
      "SWEEP_PID=$!"`, confirm a live process with
      `ps -o pid,etime,cmd -p "$SWEEP_PID"`, and record the pid and the log
      mtime before leaving it unattended. To stop it:
      `kill -TERM "$SWEEP_PID"` to end the loop, or
      `pkill -f 'sweep-loop.sh|live-gauntlet.mjs'` to also reach the gauntlet
      child. `setsid` deliberately detaches from the session's terminal, so
      `Ctrl-C` does not reach it - that is the reason the pid and the kill
      command are written down at launch.
    - An approved loop is not a licence for later passes. If it resumes, retries,
      reaches its maximum, or is re-launched with different knobs, it files no
      issue, opens no pull request, and pushes nothing without asking again,
      and a changed budget goes back through the gate.
    - Treat mid-batch silence as normal until process state and log mtime are
      checked. Stop the loop if a resumed batch repeats the same tool set
      without recording new entries or clean skips.
    - Completion: the report accounts for every discovered tool as PASS,
      SKIP/gated, or an explained FAIL; report and resume artifacts exist; no
      unexplained failures remain.

## Guardrails

- **Never file an issue, open or comment on a pull request, push to a remote,
  start a detached or background process, or spend Spotify quota without an
  explicit human approval for that action, that channel, and that identity, in
  the session that is running it.** Ask which channel and whose identity; do not
  infer either from the wording of a request. Approval lapses at a session
  boundary, a scope change, and on every loop pass, retry, and resumed batch -
  see the outbound approval gate above.
- Never propose a phantom endpoint or a removed API as if it were live. Verify
  paths, parameters, and schemas against the current official OpenAPI document.
- Respect Spotify batch limits, `SPOTIFY_MCP_FETCH_ALL_CAP`, request budgets,
  `Retry-After`, and the shared response-shaping helpers.
- Preserve the live registered-tool baseline unless the user explicitly asks
  for a breaking cutover; accepted net additions must not reduce that surface.
- Keep mutation tools read-only/dry-run safe where required, disclose fan-out
  cost, and never bypass elicitation or scope gates. `requiredConfirmationRefusal`
  keeps failing closed and `SPOTIFY_MCP_CONFIRM=never` stays the only sanctioned
  bypass; this gate is about the workflow's own outbound writes and never
  relaxes a server-side one.
- Do not leave the repository working tree dirty as a side effect of a sweep.
  Probes, previews, and loop logs belong under `/tmp/` unless the human approved
  a tracked artifact.
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
