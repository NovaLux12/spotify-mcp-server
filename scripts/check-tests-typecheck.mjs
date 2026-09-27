#!/usr/bin/env node
/**
 * Test-tree typecheck budget (#1408).
 *
 * `tsconfig.json` includes only `src`, so `npx tsc --noEmit` — the
 * typecheck CI runs — never sees a test file. `tsx` strips types without
 * checking them, so a test that names a type which does not exist, calls a
 * generic with a type argument its receiver does not accept, or references a
 * variable out of scope all run and pass. That is the class this gate exists
 * to make visible: a test that cannot fail, or that fails for a reason other
 * than the one it names.
 *
 * The count is large (see `tsconfig.tests-baseline.json`), and landing a gate
 * green would mean fixing every error in one unreviewable diff. So this is a
 * BUDGET, in the shape the schema-budget gate already uses: the measured error
 * count is compared against a checked-in baseline, and the gate fails only on
 * an INCREASE. The count can therefore only fall, and each landed fix
 * ratchets the baseline down with `--write`.
 *
 * Design notes, because a gate nobody trusts gets switched off:
 *
 * - The count is recomputed here from a real `tsc` run. It is never read from
 *   a precomputed flag, and no assertion in the guard test derives its
 *   expected value from the same source the gate compares against.
 * - It fails CLOSED. A `tsc` that cannot be run, exits for a reason other than
 *   type errors, or emits output this script cannot parse is a gate failure,
 *   not a pass. A budget gate that returns "fine" when it could not measure is
 *   the same defect as a test that cannot fail.
 * - Per-file counts are compared too, so the count cannot be held flat by
 *   fixing one file and breaking another. Both the total and every file must
 *   be at or under baseline.
 * - `--write` refreshes the baseline from the current measurement. It is a
 *   deliberate act: the diff is the record of what changed.
 *
 * `--project <path>` runs the same comparison against another config, so the
 * guard test can drive the real CLI rather than an in-process reimplementation.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, 'tsconfig.tests-baseline.json');
const DEFAULT_PROJECT = 'tsconfig.tests.json';

/** `tests/foo.test.ts(12,3): error TS2345: …` -> `tests/foo.test.ts`. */
const DIAGNOSTIC = /^(?<file>[^\s(]+)\(\d+,\d+\):\s+error\s+(?<code>TS\d+):/;

/**
 * An error tsc reports about the RUN rather than about a file:
 * `error TS5058: The specified path does not exist: …`.
 *
 * These carry no `file(line,col)` prefix, so a parser that only matches
 * diagnostics silently reports zero errors for a run that never typechecked
 * anything — and a budget gate that reads that as "well under budget" is worse
 * than no gate, because it is green. They are collected separately and fail
 * the gate outright.
 */
const GLOBAL_ERROR = /^error\s+(?<code>TS\d+):\s*(?<message>.*)$/;

/**
 * Parse `tsc` output into one record per diagnostic.
 *
 * Exported so the guard test can drive the real parser. Multi-line
 * diagnostics (TS2339 and friends print a follow-up "  Property … does not
 * exist" line) are continued rather than counted twice, which is why the
 * anchor requires the `file(line,col): error TSxxxx:` prefix rather than a
 * looser `error TS`.
 *
 * `globalErrors` holds run-level failures (bad path, unreadable config,
 * unresolvable @types). Any non-empty value means the run is not a
 * measurement, and the caller must fail closed.
 */
export function parseDiagnostics(output) {
  const byFile = new Map();
  const globalErrors = [];
  let total = 0;
  for (const line of output.split('\n')) {
    const match = DIAGNOSTIC.exec(line);
    if (match?.groups) {
      const { file } = match.groups;
      byFile.set(file, (byFile.get(file) ?? 0) + 1);
      total += 1;
      continue;
    }
    const global = GLOBAL_ERROR.exec(line);
    if (global?.groups) globalErrors.push(`${global.groups.code}: ${global.groups.message}`);
  }
  return { total, byFile, globalErrors };
}

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) {
    throw new Error(
      `missing baseline ${BASELINE_PATH}. A budget gate with no baseline has nothing to compare against and would pass on any measurement. Create it with --write.`,
    );
  }
  const parsed = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  if (typeof parsed.total !== 'number' || typeof parsed.byFile !== 'object' || parsed.byFile === null) {
    throw new Error(`malformed baseline ${BASELINE_PATH}: expected { "total": number, "byFile": {…} }`);
  }
  return parsed;
}

function runTsc(project) {
  const result = spawnSync(
    process.execPath,
    [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '--pretty', 'false', '-p', project],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (result.error) {
    throw new Error(`could not run tsc: ${result.error.message}`);
  }
  // tsc exits 1 for type errors and 2 for a broken invocation. Only 0 and 1
  // are measurements; anything else means the run did not produce a verdict.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`tsc exited ${result.status}, which is not a typecheck result:\n${result.stdout}${result.stderr}`);
  }
  return result.stdout;
}

const projectIndex = process.argv.indexOf('--project');
const project = projectIndex >= 0 ? process.argv[projectIndex + 1] : DEFAULT_PROJECT;
if (!project) throw new Error('--project requires a config path');

const measured = parseDiagnostics(runTsc(project));

// Fail closed. A run-level error means `tsc` never produced a verdict, so
// there is no count to compare and reporting "within budget" would be a lie
// the gate could not detect. This is the fail-open this gate is built to
// avoid: a green gate that measured nothing defends nothing.
if (measured.globalErrors.length > 0) {
  console.error(
    `Test-tree typecheck could not be measured (#1408) — refusing to report a budget verdict.\n${measured.globalErrors.map((line) => `- ${line}`).join('\n')}`,
  );
  console.error(`\nProject: ${project}\nA run-level error means tsc did not typecheck the tree, so the baseline was never compared against anything.`);
  process.exit(1);
} else if (process.argv.includes('--write')) {
  const byFile = Object.fromEntries([...measured.byFile].sort(([a], [b]) => (a < b ? -1 : 1)));
  writeFileSync(BASELINE_PATH, `${JSON.stringify({ total: measured.total, byFile }, null, 2)}\n`);
  console.log(`Wrote ${BASELINE_PATH}: ${measured.total} error(s) across ${measured.byFile.size} file(s).`);
  process.exit(0);
}

const baseline = readBaseline();
const regressions = [];
if (measured.total > baseline.total) {
  regressions.push(`total: ${measured.total} errors, baseline allows ${baseline.total} (+${measured.total - baseline.total})`);
}

for (const [file, count] of [...measured.byFile].sort(([a], [b]) => (a < b ? -1 : 1))) {
  const allowed = baseline.byFile[file];
  if (allowed === undefined) {
    regressions.push(`${file}: ${count} error(s) — not in the baseline (a new file must not arrive with type errors)`);
  } else if (count > allowed) {
    regressions.push(`${file}: ${count} error(s), baseline allows ${allowed} (+${count - allowed})`);
  }
}

if (regressions.length > 0) {
  console.error(`Test-tree typecheck budget exceeded (#1408). ${regressions.length} regression(s):\n${regressions.map((line) => `- ${line}`).join('\n')}`);
  console.error(`\nMeasured: ${measured.total} error(s) across ${measured.byFile.size} file(s). Baseline: ${baseline.total} across ${Object.keys(baseline.byFile).length}.`);
  console.error('`tsx` strips types without checking them, so a test naming a symbol that does not exist runs and passes. Fix the errors rather than widening the budget; if you genuinely reduced the count, commit the refreshed baseline (`npm run check:tests-typecheck -- --write`).');
  process.exitCode = 1;
} else {
  const slack = baseline.total - measured.total;
  console.log(
    `tests/ typecheck within budget: ${measured.total} error(s) across ${measured.byFile.size} file(s), baseline ${baseline.total}` +
      (slack > 0 ? ` (${slack} to give back).` : '.'),
  );
}
