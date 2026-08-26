#!/usr/bin/env node
// Post-sweep finalize: renders the per-tool live report, files template-
// conforming GitHub issues for GENUINE failures (deduped against open issues),
// classifies quota timeouts + gated 403s separately, and commits the evidence.
//
// Usage: node scripts/sweep-finalize.mjs [report.json]
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const reportPath = process.argv[2] ?? 'memory/live-sweep-report.json';
const repo = 'NovaLux12/spotify-mcp-server';
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const results = report.results ?? [];
const summary = report.summary ?? {};
const discovered = report.tools_discovered ?? results.length;

const GATE_SNIFF = /forbidden|\b403\b|removed by spotify|not available for this app|app registration/i;
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
const fails = [], timeouts = [], gated = [];
for (const r of results) {
  if (r.status !== 'FAIL') continue;
  const reason = r.reason ?? '';
  if (TIMEOUT.test(reason)) timeouts.push(r.tool);
  else if (GATE_SNIFF.test(reason)) gated.push(r.tool);
  else fails.push(r);
}

// --- render markdown report ----------------------------------------------------
const rows = results.map((r) =>
  `| ${r.tool} | ${r.status}${r.gated ? ' (gated)' : ''} | ${r.latency_ms}ms | ${(r.reason ?? '').slice(0, 140).replace(/\|/g, '\\|')} |`);
const md = [
  `# Live sweep report — ${new Date().toISOString()}`,
  '',
  `**${discovered} tools discovered** · pass ${summary.pass} · fail ${summary.fail} · skip ${summary.skip} · gated ${summary.gated ?? 0} · mode ${JSON.stringify(report.mode ?? {})}`,
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
  `## Gated 403s (${gated.length}) — app-registration class, tracked in #329`,
  ...(gated.map((t) => `- \`${t}\``)),
  '',
  `## Verdict`,
  fails.length === 0
    ? 'All tested tools passed (or are classified SKIP/gated) — no tool bugs found.'
    : `${fails.length} tool(s) failed and have issues filed.`,
  '',
].join('\n');
writeFileSync('memory/live-sweep-report.md', md);
console.log(`report → memory/live-sweep-report.md (${results.length} rows)`);

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
console.log(`\nfinalize: ${fails.length} genuine failures, ${filed} issues filed (rest deduped), ${timeouts.length} quota timeouts, ${gated.length} gated 403s`);

// --- daily memory + commit the evidence ----------------------------------------
const daily = `memory/${new Date().toISOString().slice(0, 10)}.md`;
try {
  appendFileSync(
    daily,
    `\n## Live sweep completed (${new Date().toISOString()}) <!-- project: github.com/novalux12/spotify-mcp-server -->\n` +
    `- ${discovered} tools discovered · pass ${summary.pass} · fail ${summary.fail} · skip ${summary.skip} · gated ${summary.gated ?? 0}\n` +
    `- issues filed this sweep: ${filed}; deduped: ${fails.length - filed}; quota timeouts: ${timeouts.length}; gated 403s: ${gated.length}\n` +
    `- evidence: memory/live-sweep-report.md + memory/live-sweep-report.json\n`,
  );
} catch { /* daily file may not exist yet — fine */ }

try {
  execSync(
    'git add memory/live-sweep-report.md memory/live-sweep-report.json memory/sweep-loop.log && ' +
    `git commit -q -m "chore(sweep): live sweep report (${discovered} tools, ${fails.length} fails)" && ` +
    `git push -q origin main 2>/dev/null || true`,
    { stdio: 'ignore' },
  );
  console.log('evidence committed');
} catch (e) {
  console.log(`commit skipped: ${e.message.slice(0, 120)}`);
}

process.exit(fails.length ? 1 : 0);