/**
 * The committed live-sweep report must not read as full coverage (#1619).
 *
 * `memory/live-sweep-report.json` is checked into the repository, and its
 * filename, its commit subject (`chore(sweep): live sweep report (224 tools, 0
 * fails)`) and its `summary` block all read as a clean bill for 224 tools. The
 * run actually exercised 61 of the 224 it discovered — 27.2% — and skipped the
 * other 163. `fail: 0` counted only the 61.
 *
 * This test exists so the correction cannot be quietly undone. It asserts three
 * separate things, and the third is the one that would have caught the original
 * defect:
 *
 *   1. the committed report carries a `coverage` block;
 *   2. every figure in it is reproducible from the `results` array in the same
 *      file — it is arithmetic, not a claim, so a hand-edited number disagrees;
 *   3. BOTH renderers put the coverage in the reader's path. The .md header and
 *      the generated commit subject are where the misreading actually happened,
 *      so a `coverage` block that exists but is never surfaced is not a fix.
 *
 * The report cannot be re-run here — a live sweep needs a real credential, and
 * there is none on this box. So nothing here re-derives a sweep result. The
 * assertions are about arithmetic on rows already recorded, which is the only
 * kind of claim this artefact can still support.
 *
 * Run: node --import tsx --test tests/sweep-report-coverage.test.ts
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = join(ROOT, 'memory/live-sweep-report.json');

interface Row { tool: string; status: string; reason?: string; gated?: boolean }
interface Report {
  tools_discovered: number;
  summary: { pass: number; fail: number; skip: number };
  results: Row[];
  coverage?: {
    tools_discovered: number;
    tools_exercised: number;
    tools_skipped: number;
    pct_of_discovered_exercised: number;
    pct_of_discovered_skipped: number;
    fail_meaning: string;
    skip_reasons?: { reason: string; count: number }[];
  };
}

const report: Report = JSON.parse(readFileSync(REPORT, 'utf8'));

/** Recompute from `results` — the same rows the report ships, not a second opinion. */
function derive(r: Report) {
  const discovered = r.tools_discovered;
  const exercised = r.results.filter((x) => x.status === 'PASS' || x.status === 'FAIL').length;
  const skipped = r.results.filter((x) => x.status === 'SKIP').length;
  const pct = (n: number) => (discovered === 0 ? null : Math.round((n / discovered) * 1000) / 10);
  return { discovered, exercised, skipped, pctEx: pct(exercised), pctSkip: pct(skipped) };
}

describe('the committed live-sweep report discloses its coverage (#1619)', () => {
  it('carries a coverage block whose figures come from its own results', () => {
    assert.ok(report.coverage, 'committed report has no `coverage` block — it reads as full coverage again');
    const d = derive(report);
    assert.equal(report.coverage.tools_discovered, d.discovered);
    assert.equal(report.coverage.tools_exercised, d.exercised, 'exercised count disagrees with the PASS/FAIL rows');
    assert.equal(report.coverage.tools_skipped, d.skipped, 'skipped count disagrees with the SKIP rows');
    assert.equal(report.coverage.pct_of_discovered_exercised, d.pctEx);
    assert.equal(report.coverage.pct_of_discovered_skipped, d.pctSkip);
    // The invariant the whole issue turns on. If this ever reads 100%, the
    // coverage block is counting skips as exercises and the report is lying in
    // the new way instead of the old one.
    assert.ok(
      d.pctEx !== null && d.pctEx < 100,
      `every discovered tool is marked exercised (${d.pctEx}%) — either the sweep really did run everything, or skips are being counted as passes`,
    );
    assert.equal(d.exercised + d.skipped, report.results.length, 'a row is neither exercised nor skipped');
  });

  it('states in words that fail counts only the exercised', () => {
    // A consumer reading `summary.fail` without this string is exactly the
    // misreading #1619 is about, and `summary` is the obvious field to read.
    const d = derive(report);
    assert.ok(report.coverage);
    assert.match(
      report.coverage.fail_meaning,
      new RegExp(`0 of ${d.exercised} exercised tools failed`),
      'fail_meaning must name the exercised denominator, not the discovered one',
    );
    assert.match(report.coverage.fail_meaning, new RegExp(`${d.skipped} of ${d.discovered} discovered were skipped`));
  });

  it('breaks the skips down by reason, so the unexercised set is legible', () => {
    // The reason matters as much as the count: 131 of the skips are a missing
    // prerequisite, which means the untested set is the part of the surface
    // that most needs a live key, not a part that is known-good. A bare
    // "163 skipped" does not let a reader see that.
    assert.ok(report.coverage?.skip_reasons?.length, 'no skip_reasons — the skip count has no explanation attached');
    const total = report.coverage!.skip_reasons!.reduce((n, s) => n + s.count, 0);
    assert.equal(total, report.coverage!.tools_skipped, 'skip_reasons do not account for every skipped tool');
    const dominant = report.coverage!.skip_reasons![0];
    assert.ok(
      dominant.count > report.coverage!.tools_skipped / 2,
      'expected one dominant skip reason; the reasons are too fragmented to tell a reader why coverage is partial',
    );
  });

  it('renders the coverage in the markdown header, not only in the JSON', () => {
    // The JSON carrying the fact is not the fix. A reader opens the .md.
    const md = readFileSync(join(ROOT, 'memory/live-sweep-report.md'), 'utf8');
    const d = derive(report);
    const header = md.split('\n').slice(0, 5).join('\n');
    assert.match(
      header,
      new RegExp(`${d.exercised} of ${d.discovered} discovered tools exercised`),
      'the .md header does not lead with the exercised/discovered fraction',
    );
    assert.match(header, new RegExp(`${d.skipped} skipped`), 'the .md header does not name the skipped count');
    assert.match(md, /partial sweep, not a clean bill of health/i, 'the .md carries no standing scope disclaimer');
  });

  it('generates a commit subject that cannot read as full coverage', () => {
    // The convention is the thing that produced
    // `chore(sweep): live sweep report (224 tools, 0 fails)`. Asserted against
    // the actual generator source AND against a real render, so renaming the
    // variable cannot satisfy it while the string stays misleading.
    const src = readFileSync(join(ROOT, 'scripts/sweep-finalize.mjs'), 'utf8');
    assert.doesNotMatch(
      src,
      /live sweep report \(\$\{discovered\} tools/,
      'the commit-subject convention still leads with tools_discovered',
    );
    assert.match(src, /tools exercised/);

    // Render for real, into a sandbox, from a report whose rows say something
    // different from its own `summary` — every PASS flipped to SKIP. This is
    // the case that catches a renderer trusting a stored count: it must
    // recompute from `results`, or the header puts "0 exercised" next to
    // "pass 61" and is wrong in the new way instead of the old one.
    //
    // Rendered twice: once with the `coverage` block present and once without
    // it, because an older committed report has no block and the fallback is
    // the path that has to work for it.
    for (const keepCoverage of [true, false]) {
      const sandbox = mkdtempSync(join(tmpdir(), 'sweep-coverage-'));
      try {
        const sandboxMemory = join(sandbox, 'memory');
        execFileSync('mkdir', ['-p', sandboxMemory]);
        const { coverage: _drop, ...withoutCoverage } = report;
        const fake = {
          ...(keepCoverage ? report : withoutCoverage),
          // tools_discovered deliberately left at 224 while only 10 rows exist:
          // the header must report the discrepancy, not quietly re-derive 10.
          results: report.results.slice(0, 10).map((r) => ({ ...r, status: 'SKIP' as const, reason: r.reason ?? 'x' })),
          summary: { pass: 61, fail: 0, skip: 163 },
        };
        writeFileSync(join(sandboxMemory, 'live-sweep-report.json'), JSON.stringify(fake));
        execFileSync(
          process.execPath,
          [join(ROOT, 'scripts/sweep-finalize.mjs'), join(sandboxMemory, 'live-sweep-report.json'), '--render-only'],
          { cwd: sandbox, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        );
        const outMd = readFileSync(join(sandboxMemory, 'live-sweep-report.md'), 'utf8');
        const fd = derive(fake as Report);
        const where = `coverage block ${keepCoverage ? 'present' : 'absent'}`;
        assert.equal(fd.exercised, 0, 'fixture is wrong: expected zero exercised');
        assert.match(
          outMd.split('\n').slice(0, 5).join('\n'),
          new RegExp(`\\*\\*${fd.exercised} of ${fd.discovered} discovered tools exercised\\*\\*`),
          `${where}: header does not lead with the recomputed exercised/discovered fraction`,
        );
        assert.doesNotMatch(
          outMd.split('\n').slice(0, 5).join('\n'),
          /pass 61/,
          `${where}: header printed the stale summary.pass next to the recomputed count`,
        );
        assert.match(outMd, /`fail 0` means/, `${where}: rendered scope disclaimer is missing`);
        assert.match(outMd, /partial sweep, not a clean bill of health/i, `${where}: no standing scope disclaimer`);
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    }
  });

  it('recomputes skip_reasons from rows, so a stale block cannot render a fabricated tally', () => {
    // The headline counts were recomputed from `results`; `skip_reasons` was
    // not. It read `report.coverage?.skip_reasons ?? <recompute>`, so a stored
    // block won — and a `count` is arithmetic, not prose, rendered directly
    // beneath a header stating how many were skipped. A doctored block
    // claiming 999 of something printed, next to a truthful total, and the two
    // numbers had no obligation to agree.
    //
    // The second assertion is the truncation. The committed report has nine
    // reasons; the renderer printed eight and dropped the ninth silently, so
    // the bullets summed to 162 under a header saying 163. In the one block
    // whose whole job is the honest accounting, a partial list reads as a
    // complete one.
    //
    // Both are exercised against the real committed report, not a fixture
    // trimmed to fit: it has nine reasons, so the remainder path is the one
    // under test.
    const sandbox = mkdtempSync(join(tmpdir(), 'sweep-reasons-'));
    try {
      const sandboxMemory = join(sandbox, 'memory');
      execFileSync('mkdir', ['-p', sandboxMemory]);
      const fake = {
        ...report,
        coverage: {
          ...report.coverage!,
          skip_reasons: [{ reason: 'STALE INJECTED REASON', count: 999 }],
        },
      };
      writeFileSync(join(sandboxMemory, 'live-sweep-report.json'), JSON.stringify(fake));
      execFileSync(
        process.execPath,
        [join(ROOT, 'scripts/sweep-finalize.mjs'), join(sandboxMemory, 'live-sweep-report.json'), '--render-only'],
        { cwd: sandbox, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const outMd = readFileSync(join(sandboxMemory, 'live-sweep-report.md'), 'utf8');

      assert.doesNotMatch(
        outMd,
        /STALE INJECTED REASON/,
        'a stale coverage.skip_reasons rendered — the renderer trusted the stored block instead of recomputing from results',
      );

      const block = outMd.split('Why the rest was skipped:')[1]?.split('\n\n')[0] ?? '';
      const bullets = [...block.matchAll(/- (\d+)×/g)].map((m) => Number(m[1]));
      const remainder = block.match(/and \d+ more reasons?, (\d+) skipped/);
      const rendered = bullets.reduce((a, b) => a + b, 0) + (remainder ? Number(remainder[1]) : 0);
      const stated = Number(outMd.match(/\*\*(\d+) skipped/)?.[1]);
      assert.ok(stated > 0, 'fixture is wrong: expected a non-zero skipped total');
      // Checked against the SOURCE report, not the rendered bullets. Asserting
      // on the render would only re-test the renderer — which is the thing
      // under suspicion — and would fire before the arithmetic that actually
      // catches the truncation.
      assert.ok(
        (report.coverage?.skip_reasons?.length ?? 0) > 8,
        'fixture is wrong: the committed report has eight or fewer skip reasons, so the remainder path is not under test',
      );
      assert.equal(
        rendered,
        stated,
        'the rendered skip-reason bullets do not add up to the stated skipped total — a reason was dropped without a remainder',
      );
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
