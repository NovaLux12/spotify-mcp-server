# Live sweep plan — full tool surface vs the real account

Status: **ready to run** · Created 2026-08-27 00:15 BST · Repo: NovaLux12/spotify-mcp-server

## Why

Cover **every registered tool** (224 on a live key — see #327; docs say 212) with a
per-tool live result against Jack's real Spotify account, without tripping the
July-2026 per-developer-account quota (observed: first ~45 calls pass, then
cascading Retry-After stalls — the gauntlet's own documented behaviour).

## How it works

`scripts/live-gauntlet.mjs` now supports:

- `--batch=N` — perform at most N tool calls per run (seeds excluded), write the
  partial report, exit.
- `--resume=FILE` — skip tools already recorded in FILE; **FAILs are retried**,
  PASS/GATED/SKIP entries are kept, so quota stalls are never cached as FAILs.
- `--report=FILE` — cumulative report path (JSON).
- GATED classification — the app-registration-gated family (contains variants,
  browse categories, markets, top-tracks, users-by-id, …) is recorded SKIP with a
  reason when it errors, and PASS-with-`gated:true` when the tool answers but the
  snippet smells of 403/Forbidden/removed (GATE_SNIFF).
- `SWEEP_COMPLETE` — when nothing is left to record, the run prints it and exits 0.

Mutating tools are **never called** unless allowlisted with
`--include-mutating=a,b` — and even then only with `dry_run: true`, verified to
have produced no mutation. The safe sweep therefore proves "zero mutations".

## Run it

Rebuild once (tool surface is frozen at build time):

```bash
npm run build
```

One batch (manual, e.g. while watching):

```bash
npm run sweep          # 40 calls, resume-aware, report → memory/live-sweep-report.json
```

Full auto loop (spaced batches until done):

```bash
npm run sweep:loop                       # BATCH=40, 30 min gaps
BATCH=60 INTERVAL=3600 npm run sweep:loop  # tune for quota mood
```

First batch should start when quota is fresh (it was exhausted ~00:00 BST;
allow an hour +). Typical shape: 5–7 batches of ~40 calls, then a final short
batch. Expect the four removed-by-Spotify tools + gated family to SKIP, not
FAIL — that is correct.

## Report

`memory/live-sweep-report.json` — per tool: `tool`, `class` (SAFE/MUTATING),
`status` (PASS/FAIL/SKIP), `latency_ms`, `gated` flag, `reason`, plus summary
counts, mutation proof, and `mode` (batch/resume).

Follow-up analysis: compare PASS-per-tool against the documented tool list
(SPEC.md), eyeball `gated: true` entries (real 403s vs graceful explanations),
and use the FAIL list to file bugs. Sweep evidence should land in
memory/live-sweep-report.json + a summary in the daily memory file
(memory/YYYY-MM-DD.md).

## Open threads it feeds

- #327 count drift 224 vs 212 (sweep discovers the true count)
- #328 browse family raw Forbidden (sweep will show exactly which tools)
- #329 app-registration-gated disclosure (sweep gives the evidence table)
- #330 gauntlet GATED/batch/resume (implemented here)

## Resume here (when returning to this session)

```bash
cd ~/.openclaw/projects/d3e4a3d09c243613/spotify-mcp-server
npm run build
npm run sweep:loop
```

Then summarise: counts table (pass / gated / fail / skip), the gated list, any
new FAILs worth issues, and append the summary to memory/YYYY-MM-DD.md.