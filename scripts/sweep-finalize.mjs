#!/usr/bin/env node
// Post-sweep finalize: renders the per-tool live report, files template-
// conforming GitHub issues for GENUINE failures (deduped against open issues),
// classifies quota timeouts + gated 403s separately, and commits the evidence.
//
// Usage: node scripts/sweep-finalize.mjs [report.json] [--render-only]
//   --render-only  rewrite memory/live-sweep-report.md from the JSON and stop
//                  (no issue filing, no daily-log append, no commit/push).
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// #644: GATE_SNIFF was a byte-for-byte copy of the one in live-gauntlet.mjs, applied
// to the two files' different inputs (a response's text there, a failure's reason
// here). A drifted copy would have made the filed-issue count disagree with the
// sweep report about the same run.
import { looksGated } from './lib/mcp-client.mjs';

const reportPath = process.argv[2] ?? 'memory/live-sweep-report.json';
const repo = 'NovaLux12/spotify-mcp-server';
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const results = report.results ?? [];
const summary = report.summary ?? {};
const discovered = report.tools_discovered ?? results.length;

// #1619. The counts are RECOMPUTED from `results` on every render rather than
// read out of the report's `coverage` block. The block is written by the
// gauntlet from the same rows, so the two agree at write time — but a report
// that was hand-edited, or merged from two runs, can carry a `coverage` block
// that no longer describes its own `results`, and trusting it would render
// confident numbers from a stale block. The narrative fields (`fail_meaning`,
// `skip_reasons`) are taken from the block when present, since those are prose
// rather than arithmetic; the counts never are. `exercised` is PASS + FAIL
// only: a skip is a tool the sweep never called, and counting it as tested is
// the specific misreading that made "224 tools, 0 fails" look like 224 tools
// were verified.
const passCount = results.filter((r) => r.status === 'PASS').length;
const failCount = results.filter((r) => r.status === 'FAIL').length;
const exercisedCount = passCount + failCount;
const skippedCount = results.filter((r) => r.status === 'SKIP').length;
const pctOf = (n) => (discovered === 0 ? null : Math.round((n / discovered) * 1000) / 10);
const coverage = {
  tools_discovered: discovered,
  tools_exercised: exercisedCount,
  tools_skipped: skippedCount,
  pct_of_discovered_exercised: pctOf(exercisedCount),
  pct_of_discovered_skipped: pctOf(skippedCount),
  fail_meaning: report.coverage?.fail_meaning ??
    `${failCount} of ${exercisedCount} exercised tools failed; ${skippedCount} of ${discovered} discovered were skipped and are not evidence of anything`,
  // `summary` is recomputed alongside the coverage counts, for the same reason.
  // A `summary` that disagrees with its own `results` would otherwise put two
  // contradictory counts in one header line.
  pass: passCount,
  fail: failCount,
  // Recomputed, never read back from the stored block. A `count` is arithmetic,
  // not prose: `fail_meaning` above is a sentence a human wrote and may
  // legitimately be carried, but a `skip_reasons` entry read from the block
  // would render a fabricated tally directly beneath the headline that says
  // how many were skipped, and the two would not have to agree with anything.
  skip_reasons:
    Object.entries(
      results.filter((r) => r.status === 'SKIP').reduce((acc, r) => {
        const why = r.reason ?? 'unspecified';
        acc[why] = (acc[why] ?? 0) + 1;
        return acc;
      }, {}),
    ).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
};

const headline =
  `**${coverage.tools_exercised} of ${coverage.tools_discovered} discovered tools exercised** ` +
  `(${coverage.pct_of_discovered_exercised}%) · pass ${coverage.pass} · fail ${coverage.fail} · ` +
  `**${coverage.tools_skipped} skipped (${coverage.pct_of_discovered_skipped}%)** · gated ${summary.gated ?? 0} · ` +
  `mode ${JSON.stringify(report.mode ?? {})}`;

const TIMEOUT = /^timeout:/i;

// --- tool -> issue-template family mapping (best effort; Other fallback) ---
function familyOf(name) {
  const n = name.toLowerCase();
  const has = (re) => re.test(n);
  if (has(/handoff|scene|wind|play|pause|seek|volume|shuffle|repeat|queue|device|transfer|skip|now_playing|currently/)) return 'Playback';
  if (has(/^search|search_/)) return 'Search';
  if (has(/audiobook|chapter|podcast_session/)) return 'Audiobooks';
  if (has(/follow/)) return 'Following';
  if (has(/playlist|merge|diff_|overlap|grow|dna|export|import|smart|batch/)) return 'Playlists';
  if (has(/saved|check_in|library|hygiene|backup|restore|dedupe|insight|coverage|undo|tag_|genre/)) return 'Library';
  if (has(/top_|recently|listening/)) return 'Personalization';
  if (has(/track|artist|album|show|episode|browse|categor|market|release|genre_seed|recommend/)) return 'Catalog Lookup';
  return 'Other / not tool-specific (auth, install, server startup)';
}

// --- classify -----------------------------------------------------------------
// #1338: `gatedRows` counts EVERY row the classifier flagged app-registration
// gated, not just the `status === 'FAIL'` ones. The old loop only ever pushed
// into `gated` from inside the `FAIL` branch, so a tool that correctly caught
// its own 403 and disclosed it landed as `PASS (gated)` in the table and then
// vanished from the "Gated 403s" section — which is how a sweep with 13 gated
// rows rendered a section headed "Gated 403s (0)". A reader scanning that
// section concluded the sweep found no gated endpoints at all.
const fails = [], timeouts = [], gatedFails = [], gatedRows = [];
for (const r of results) {
  if (r.gated) gatedRows.push(r);
  if (r.status !== 'FAIL') continue;
  const reason = r.reason ?? '';
  if (TIMEOUT.test(reason)) timeouts.push(r.tool);
  else if (looksGated(reason)) gatedFails.push(r.tool);
  else fails.push(r);
}

// --- render markdown report ----------------------------------------------------
const rows = results.map((r) =>
  `| ${r.tool} | ${r.status}${r.gated ? ' (gated)' : ''} | ${r.latency_ms}ms | ${(r.reason ?? '').slice(0, 140).replace(/\|/g, '\\|')} |`);
// #1338: the title must date the SWEEP, not the act of re-rendering. A plain
// `new Date()` is right on the sweep path (finalize runs seconds after the run)
// but wrong for `--render-only`, which deliberately re-renders an old run to
// correct a defect in it: that would silently restamp a month-old piece of
// evidence with today and make it look freshly collected. Preserve the title
// already in the file when re-rendering.
const REPORT_MD = 'memory/live-sweep-report.md';
const existingTitle = existsSync(REPORT_MD)
  ? readFileSync(REPORT_MD, 'utf8').match(/^# Live sweep report — (.+)$/m)?.[1]
  : undefined;
const runStamp =
  (process.argv.includes('--render-only') ? existingTitle : undefined) ??
  report.generated_at ??
  new Date().toISOString();
const md = [
  `# Live sweep report — ${runStamp}`,
  '',
  headline,
  '',
  // #1619: the standing statement of what this artefact is and is not. The
  // filename says "live sweep report" and the commit subject said "224 tools,
  // 0 fails", and both read as a clean bill for 224 tools. Neither is
  // evidence about tools this run skipped. The skip reasons are the load
  // -bearing half: most skips are a missing prerequisite, which means the
  // unexercised set is the part of the surface that most needs a live key.
  `> **This is a partial sweep, not a clean bill of health.** Of the`,
  `> ${coverage.tools_discovered} tools this run discovered,`,
  `> **${coverage.tools_exercised} were actually called**`,
  `> (${coverage.pct_of_discovered_exercised}%) and`,
  `> **${coverage.tools_skipped} were skipped**`,
  `> (${coverage.pct_of_discovered_skipped}%). \`fail ${coverage.fail}\` means`,
  `> ${coverage.fail} of the ${coverage.tools_exercised} exercised tools failed — the`,
  `> ${coverage.tools_skipped} skips are excluded from that count entirely, and a`,
  `> skipped tool is not a passing tool. \`tools_discovered\` is what`,
  `> \`tools/list\` returned on this run; it is not the registry, so a tool added`,
  `> since is absent from it rather than passing.`,
  '',
  '> Why the rest was skipped:',
  '>',
  ...(() => {
    const all = coverage.skip_reasons ?? [];
    const shown = all.slice(0, 8);
    const rest = all.slice(8);
    const restCount = rest.reduce((n, s) => n + (s.count ?? 0), 0);
    return [
      ...shown.map((s) => `> - ${s.count}× ${s.reason}`),
      // A silent truncation here made the bullets sum to 162 against a header
      // stating 163: nine reasons, eight rendered, the ninth dropped with no
      // marker. In the one block whose whole job is the honest accounting, a
      // partial list reads as a complete one — so the remainder is named, and
      // the counts add up to the total the headline claims.
      ...(rest.length
        ? [`> - …and ${rest.length} more reason${rest.length === 1 ? '' : 's'}, ${restCount} skipped`]
        : []),
    ];
  })(),
  '',
  // #1338: the standing note that stops this report being read as the evidence
  // it cannot be. `PASS (gated)` means the tool made the call, took a 403, and
  // disclosed it — the server behaving correctly, not the endpoint answering.
  // AGENTS.md §2 once asserted "a grandfathered registration still answers
  // 200" and pointed here; this sweep used one registration, which was itself
  // gated, so it is evidence for a 403 and for nothing else.
  `> **How to read \`PASS (gated)\`.** The tool made the call, received a 403`,
  `> from Spotify, and reported the refusal instead of degrading. That is the`,
  `> server working as designed — it is **not** a sign the endpoint is alive.`,
  `> Every gated row in this report is a 403 observed on **this run's single`,
  `> app registration**. A \`PASS (gated)\` row is therefore never evidence that`,
  `> a *different*, grandfathered (pre-Nov-2024) registration would answer`,
  `> \`200\`: this sweep cannot observe one, and nothing in this repository`,
  `> establishes that it would. Do not cite this report for that claim.`,
  '',
  `| tool | status | latency | reason |`,
  `|---|---|---|---|`,
  ...rows,
  '',
  `## Genuine failures (${fails.length}) — issues filed`,
  ...(fails.map((f) => `- \`${f.tool}\` — ${f.reason ?? ''}`)),
  '',
  `## Quota timeouts (${timeouts.length}) — retry in a later sweep, not tool bugs`,
  ...(timeouts.map((t) => `- \`${t}\``)),
  '',
  `## Gated 403s (${gatedRows.length}) — app-registration class, tracked in #329`,
  ...(gatedRows.map((r) => `- \`${r.tool}\` (${r.status}) — ${r.reason ?? ''}`)),
  '',
  `## Verdict`,
  (fails.length === 0 ? '' : `${fails.length} tool(s) failed and have issues filed. `) +
  `${coverage.tools_exercised} of ${coverage.tools_discovered} discovered tools ` +
  `(${coverage.pct_of_discovered_exercised}%) were exercised against the live API; ` +
  `${coverage.tools_skipped} (${coverage.pct_of_discovered_skipped}%) were skipped and ` +
  `carry no verdict at all. "No failures" is a statement about the first number only.`,
  '',
].join('\n');
writeFileSync(REPORT_MD, md);
console.log(`report → ${REPORT_MD} (${results.length} rows)`);

// #1338: `--render-only` stops here. Re-rendering an already-committed report
// — to correct a defect in it, without inventing a new sweep — must not file
// GitHub issues, append to the daily memory log, or `git push origin main`.
// The header line above ("files template-conforming GitHub issues ... and
// commits the evidence") describes the sweep path; that path is the wrong tool
// for amending a checked-in artefact, and a docs fix should not be able to
// reach a push to `main`.
if (process.argv.includes('--render-only')) {
  console.log('render-only: stopped before issue filing, daily log, and commit');
  process.exit(fails.length ? 1 : 0);
}

// --- file issues for genuine failures, deduped against open issues -------------
const openTitles = execSync(
  `gh issue list -R ${repo} --state open --limit 300 --json title -q '.[].title'`,
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
).split('\n').filter(Boolean);

let filed = 0;
for (const f of fails) {
  const title = `Live sweep FAIL: ${f.tool}`;
  if (openTitles.some((t) => t.includes(f.tool))) {
    console.log(`skip (dedupe): ${f.tool} already mentioned in an open issue`);
    continue;
  }
  const body = [
    '### Description',
    '',
    `Live-sweep failure (${new Date().toISOString()}): tool \`${f.tool}\` failed against the real Spotify API during the full-surface sweep.`,
    '',
    '### Affected tool family',
    '',
    familyOf(f.tool),
    '',
    '### Reproduction steps',
    '',
    '1. `npm run build` with a live token in `~/.spotify-mcp/tokens.json`',
    `2. Call \`${f.tool}\` with the sweep's standard minimal arguments`,
    '3. Observe the failure below',
    '',
    '### Expected behavior',
    '',
    `\`${f.tool}\` returns a successful result against a valid authenticated account.`,
    '',
    '### Actual behavior',
    '',
    `\`\`\`\n${(f.reason ?? '').slice(0, 500)}\n\`\`\``,
    '',
    '### MCP client used',
    '',
    'OpenClaw / live gauntlet (scripts/live-gauntlet.mjs)',
    '',
    '### Logs / stderr output',
    '',
    `Full sweep evidence: memory/live-sweep-report.json (run ${report.generated_at ?? reportPath}).`,
    '',
  ].join('\n');
  const bodyFile = join(tmpdir(), `sweep-issue-${f.tool}.md`);
  writeFileSync(bodyFile, body);
  const url = execSync(
    `gh issue create -R ${repo} --title ${JSON.stringify(title)} --body-file ${bodyFile} --label bug`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim();
  console.log(`filed: ${title} → ${url}`);
  filed++;
}
console.log(`\nfinalize: ${fails.length} genuine failures, ${filed} issues filed (rest deduped), ${timeouts.length} quota timeouts, ${gatedRows.length} gated 403s (${gatedFails.length} of them FAILs)`);

// --- daily memory + commit the evidence ----------------------------------------
const daily = `memory/${new Date().toISOString().slice(0, 10)}.md`;
try {
  appendFileSync(
    daily,
    `\n## Live sweep completed (${new Date().toISOString()}) <!-- project: github.com/novalux12/spotify-mcp-server -->\n` +
    `- ${coverage.tools_exercised}/${coverage.tools_discovered} tools discovered were exercised (${coverage.pct_of_discovered_exercised}%) · pass ${coverage.pass} · fail ${coverage.fail} · ${coverage.tools_skipped} skipped (${coverage.pct_of_discovered_skipped}%) · gated ${summary.gated ?? 0}\n` +
    `- issues filed this sweep: ${filed}; deduped: ${fails.length - filed}; quota timeouts: ${timeouts.length}; gated 403s: ${gatedRows.length}\n` +
    `- evidence: memory/live-sweep-report.md + memory/live-sweep-report.json\n`,
  );
} catch { /* daily file may not exist yet — fine */ }

try {
  execSync(
    'git add memory/live-sweep-report.md memory/live-sweep-report.json memory/sweep-loop.log && ' +
    // #1619: the old subject was `live sweep report (224 tools, 0 fails)`, which
    // reads as 224 tools verified. It is the committed history of this repo
    // that a reader scans, so the convention has to carry the coverage
    // fraction or the summary line is the only accurate statement in the
    // commit. Exercised/discovered first, skips named, fails last.
    `git commit -q -m "chore(sweep): live sweep report (${coverage.tools_exercised}/${coverage.tools_discovered} tools exercised, ${coverage.tools_skipped} skipped, ${fails.length} fails)" && ` +
    `git push -q origin main 2>/dev/null || true`,
    { stdio: 'ignore' },
  );
  console.log('evidence committed');
} catch (e) {
  console.log(`commit skipped: ${e.message.slice(0, 120)}`);
}

process.exit(fails.length ? 1 : 0);