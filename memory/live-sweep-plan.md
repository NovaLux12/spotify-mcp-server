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
counts, mutation proof, `mode` (batch/resume), and a `coverage` block.

### The committed report is a partial sweep, not a clean bill of health

**Read this before citing `memory/live-sweep-report.md` for anything.**

The committed run (2026-08-27) discovered 224 tools and **exercised 61 of
them — 27.2%**. The other **163 (72.8%) were skipped**, and a skipped tool
carries no verdict: it was never called. `fail 0` means *zero of the 61
exercised tools failed*; the 163 skips are not in that denominator at all.

The filename and the old commit subject both said otherwise. The commit read
`chore(sweep): live sweep report (224 tools, 0 fails)`, which reads as 224
tools verified. #1619 fixed the generators that produced that phrasing and
added the `coverage` block so the JSON cannot be misread on its own — but the
honest statement of the evidence is the 27.2%, not the filename.

Two further limits on the 224:

- **`tools_discovered` is not a registry size.** It is what `tools/list`
  returned on that run. A tool added since is absent from the report rather
  than passing it, and one removed before the run was never reachable. The
  registry is larger now; the report is not a measurement of it.
- **The skips are not random.** 131 of the 163 are
  `missing prereq from seed reads` and 24 are `mutating; not in
  --include-mutating allowlist`. The unexercised set is therefore the part of
  the surface that most needs a live key and a populated account, not the part
  that is known-good. Full skip reasons with counts are in the `coverage`
  block under `skip_reasons` and are rendered in the report header.

**This cannot be fixed without re-running the sweep, which needs a live
credential.** Do not reconstruct, estimate, or back-fill the missing calls, and
do not present a computed figure as a measurement. Re-running with
`--include-mutating` and a richer seed set is the only way to raise the
exercised fraction.

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