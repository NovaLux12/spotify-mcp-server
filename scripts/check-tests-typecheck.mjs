#!/usr/bin/env node
/**
 * Test-tree typecheck budget (#1408, #1478).
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
 * count is compared against a checked-in baseline. What it compares is
 * stricter than a one-sided ceiling, and the reason is the failure #1478
 * recorded.
 *
 * #1478: the comparison used to fail only when the count ROSE. A file whose
 * errors were fixed kept its allowance forever, so slack accumulated
 * silently. The measured consequence on `main` was three baseline entries
 * totalling 5 errors for files that typechecked completely clean — the exact
 * "5 to give back" the gate advertised, and a total the gate would have
 * refused to let anyone spend honestly, because `--write` refreshes every
 * entry. A budget whose slack is a fiction does not bound anything.
 *
 * So the baseline is a **measurement of this tree**, and it is a measurement
 * in both directions:
 *
 *   - measured ABOVE baseline is a regression: the count went up. Fix the
 *     errors.
 *   - measured BELOW baseline is stale slack: the count came down and the
 *     baseline was never told. `--write` reclaims it. This is not a
 *     punishment — it is the ratchet, and the person who fixed the errors is
 *     the person best placed to record it.
 *
 * A narrower fix was considered and rejected: failing only on entries that
 * have reached ZERO. It reclaims the 5 errors #1478 measured, but it leaves
 * every partially-improved file's slack in place, and a gate that reports
 * "the baseline is current" while a file's 19-error ceiling sits above its
 * actual 15 is the same defect one number smaller. Narrowing the class of
 * drift that is caught is not the same as closing it, and this repository
 * keeps finding gates that were green about the wrong thing.
 *
 * Design notes, because a gate nobody trusts gets switched off:
 *
 * - The count is recomputed here from a real `tsc` run. It is never read from
 *   a precomputed flag, and no assertion in the guard test derives its
 *   expected value from the same source the gate compares against.
 * - It fails CLOSED. A `tsc` that cannot be run, exits for a reason other than
 *   type errors, or emits output this script cannot parse is a gate failure,
 *   not a pass. A budget gate that returns "fine" when it could not measure is
 *   the same defect as a test that cannot fail. So is a baseline that will not
 *   parse: the message names the file, because the person who hits it is about
 *   to go looking.
 * - Per-file counts are compared too, so the count cannot be held flat by
 *   fixing one file and breaking another — and so a per-file ceiling cannot
 *   quietly become a spendable allowance for whichever file reaches for it.
 * - `--write` refuses to WIDEN the budget. Re-baselining downwards is a
 *   routine act and needs no ceremony; raising a ceiling is the thing AGENTS.md
 *   tells contributors not to do, and a `--write` that raises one silently is
 *   a one-command escape from the very budget it maintains. Raising one takes
 *   `--allow-increase "<reason>"`, and the reason and the date are recorded in
 *   the baseline so the widening is auditable rather than invisible.
 * - The module is safe to import. `parseDiagnostics` is exported for the guard
 *   test, and running the gate as a side effect of importing it meant the
 *   test's own process typechecked the whole tree before its first assertion.
 *
 * `--project <path>` and `--baseline <path>` run the same comparison against
 * another config and another baseline, so the guard test can drive the real CLI
 * rather than an in-process reimplementation. `--baseline` exists so a test can
 * exercise the failure paths without editing the checked-in baseline: node:test
 * runs sibling describes concurrently, so a test that doctored the real file to
 * prove the gate fires would race the tests that assert the real tree is
 * accepted, and both would read whichever write landed last.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

function readBaseline(path) {
  if (!existsSync(path)) {
    throw new Error(
      `missing baseline ${path}. A budget gate with no baseline has nothing to compare against and would pass on any measurement. Create it with --write.`,
    );
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed.total !== 'number' || typeof parsed.byFile !== 'object' || parsed.byFile === null) {
    throw new Error(`malformed baseline ${path}: expected { "total": number, "byFile": {…} }`);
  }
  for (const [file, allowed] of Object.entries(parsed.byFile)) {
    if (typeof allowed !== 'number' || !Number.isInteger(allowed) || allowed < 0) {
      throw new Error(`malformed baseline ${path}: ${file} allows ${JSON.stringify(allowed)}, expected a non-negative integer`);
    }
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

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Compare a measurement against a baseline, in BOTH directions.
 *
 * `regressions` is the half #1408 was built for: the tree now carries more
 * errors than the budget allows, somewhere. `stale` is the half it was
 * missing: the tree carries FEWER, and the baseline still claims the old
 * figure. They are reported separately because the remedy is different — one
 * is fixed in the test, the other in the baseline — and a message that named
 * both under the word "exceeded" would send the reader to the wrong file.
 */
function compareTrees(measured, baseline) {
  const regressions = [];
  const stale = [];

  if (measured.total > baseline.total) {
    regressions.push(`total: ${measured.total} error(s), baseline allows ${baseline.total} (+${measured.total - baseline.total})`);
  } else if (measured.total < baseline.total) {
    stale.push(`total: tree measures ${measured.total}, baseline allows ${baseline.total} (${measured.total - baseline.total})`);
  }

  for (const [file, count] of [...measured.byFile].sort(([a], [b]) => byName(a, b))) {
    const allowed = baseline.byFile[file];
    if (allowed === undefined) {
      regressions.push(`${file}: ${count} error(s) — not in the baseline (a new file must not arrive with type errors)`);
    } else if (count > allowed) {
      regressions.push(`${file}: ${count} error(s), baseline allows ${allowed} (+${count - allowed})`);
    } else if (count < allowed) {
      stale.push(`${file}: tree measures ${count}, baseline allows ${allowed} (${count - allowed})`);
    }
  }

  // A ceiling for a file that measures nothing at all. That is one state with
  // three possible causes — the errors were fixed, the file was deleted, or
  // it stopped being part of the project — and the gate cannot tell them
  // apart, so it does not claim to. All three are the same defect: an
  // allowance nothing can spend.
  for (const file of Object.keys(baseline.byFile).sort(byName)) {
    if (measured.byFile.has(file)) continue;
    stale.push(
      `${file}: baseline allows ${baseline.byFile[file]}, the tree measures 0 — the file is fixed, deleted, or no longer part of the project`,
    );
  }

  return { regressions, stale };
}

/** Ceilings the given write would RAISE, by either measure. */
function wideningWrite(measured, previous) {
  const raised = [...measured.byFile]
    .filter(([file, count]) => count > (previous.byFile[file] ?? 0))
    .map(([file]) => file);
  const totalUp = measured.total > previous.total;
  return totalUp || raised.length > 0 ? { raised, totalUp } : undefined;
}

function renderBaseline(measured, widened) {
  const byFile = Object.fromEntries([...measured.byFile].sort(([a], [b]) => byName(a, b)));
  const doc = { total: measured.total, byFile };
  // Recorded only when the write that produced THIS baseline raised a
  // ceiling. A later write that holds or lowers the total drops the record,
  // because the file it describes is no longer the one on disk.
  if (widened) {
    doc.widened = {
      reason: widened.reason,
      date: new Date().toISOString().slice(0, 10),
      totalFrom: widened.totalFrom,
      totalTo: measured.total,
      raisedFiles: widened.raised.length,
    };
  }
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function main(argv) {
  let project;
  let baselinePath;
  let allowIncrease;
  try {
    project = argValue(argv, '--project') ?? DEFAULT_PROJECT;
    baselinePath = argValue(argv, '--baseline') ?? BASELINE_PATH;
    allowIncrease = argValue(argv, '--allow-increase');
  } catch (err) {
    // A bad flag is a gate failure, and a stack trace is not a report: it
    // names a line in this file rather than the mistake on the command line.
    console.error(`check:tests-typecheck — ${err.message}`);
    return 1;
  }
  const writing = argv.includes('--write');

  if (allowIncrease !== undefined && !writing) {
    console.error(
      '--allow-increase only means something with --write. Passing it alone is a no-op, and a flag that does nothing is worse than no flag: it reads as a widening that was authorised and was not.',
    );
    return 1;
  }

  let measured;
  try {
    measured = parseDiagnostics(runTsc(project));
  } catch (err) {
    console.error(`Test-tree typecheck could not be measured (#1408) — refusing to report a budget verdict.\n${err.message}`);
    return 1;
  }

  // Fail closed. A run-level error means `tsc` never produced a verdict, so
  // there is no count to compare and reporting "within budget" would be a lie
  // the gate could not detect. This is the fail-open this gate is built to
  // avoid: a green gate that measured nothing defends nothing.
  if (measured.globalErrors.length > 0) {
    console.error(
      `Test-tree typecheck could not be measured (#1408) — refusing to report a budget verdict.\n${measured.globalErrors.map((line) => `- ${line}`).join('\n')}`,
    );
    console.error(`\nProject: ${project}\nA run-level error means tsc did not typecheck the tree, so the baseline was never compared against anything.`);
    return 1;
  }

  // A baseline that will not parse is a gate failure rather than an exception
  // with a stack trace: the message has to name the file, because the person
  // who hits it is about to go looking for it. Under `--write` it is not a
  // failure at all — writing a fresh measurement is the repair, and refusing
  // to repair would strand the file.
  let previous;
  try {
    previous = readBaseline(baselinePath);
  } catch (err) {
    if (!writing) {
      console.error(`Test-tree typecheck budget could not be read (#1408) — refusing to report a verdict.\n${err.message}`);
      return 1;
    }
    previous = undefined;
  }

  if (writing) {
    const widening = previous ? wideningWrite(measured, previous) : undefined;
    if (widening && allowIncrease === undefined) {
      const lines = [];
      if (widening.totalUp) lines.push(`  - total: ${previous.total} -> ${measured.total}`);
      if (widening.raised.length > 0) {
        lines.push(`  - ${widening.raised.length} per-file ceiling(s) raised: ${widening.raised.join(', ')}`);
      }
      console.error(
        `Refusing to write a baseline that WIDENS the tests/ typecheck budget (#1408).\n--write would raise:\n${lines.join('\n')}`,
      );
      console.error(
        '\nAGENTS.md says to fix the errors rather than widen the budget, so this is a no-argument default: `--write` reclaims a count that came down, and raising one is a separate, recorded act.',
      );
      console.error('If the increase is real and unavoidable, record why:\n  npm run check:tests-typecheck -- --write --allow-increase "<reason>"');
      console.error(`\n${baselinePath} was not modified.`);
      return 1;
    }
    const record = widening
      ? { reason: allowIncrease, raised: widening.raised, totalFrom: previous.total }
      : undefined;
    writeFileSync(baselinePath, renderBaseline(measured, record));
    const widened = widening ? ` (widened: ${allowIncrease})` : '';
    console.log(`Wrote ${baselinePath}: ${measured.total} error(s) across ${measured.byFile.size} file(s)${widened}.`);
    return 0;
  }

  const { regressions, stale } = compareTrees(measured, previous);
  const measuredLine = `Measured: ${measured.total} error(s) across ${measured.byFile.size} file(s). Baseline: ${previous.total} across ${Object.keys(previous.byFile).length}.`;

  if (regressions.length > 0) {
    console.error(`Test-tree typecheck budget exceeded (#1408). ${regressions.length} regression(s):\n${regressions.map((line) => `- ${line}`).join('\n')}`);
    if (stale.length > 0) {
      console.error(`\n…and ${stale.length} stale entr(y/ies) at the same time:\n${stale.map((line) => `- ${line}`).join('\n')}`);
    }
    console.error(`\n${measuredLine}`);
    console.error('`tsx` strips types without checking them, so a test naming a symbol that does not exist runs and passes. Fix the errors rather than widening the budget; if the increase is main\'s after a rebase, re-run `npm run check:tests-typecheck -- --write --allow-increase "<reason>"`.');
    return 1;
  }

  if (stale.length > 0) {
    console.error(`Test-tree typecheck baseline is stale (#1478). ${stale.length} entr(y/ies) no longer describe this tree:\n${stale.map((line) => `- ${line}`).join('\n')}`);
    console.error(`\n${measuredLine}`);
    console.error(
      'An allowance above what the tree actually carries is slack nobody can spend honestly: `--write` refreshes every entry, so taking it means taking it in files you did not fix. That is how the 5-error "slack" this gate advertised in #1478 accumulated without anyone noticing.\nReclaim it: `npm run check:tests-typecheck -- --write` (it only lowers here; it refuses to widen). Commit the diff — it is the record of what changed.',
    );
    return 1;
  }

  console.log(
    `tests/ typecheck within budget: ${measured.total} error(s) across ${measured.byFile.size} file(s) — the baseline is a current measurement.`,
  );
  return 0;
}

// Run the gate only when this file IS the entry point. The guard test imports
// `parseDiagnostics` from here, and without this guard that import typechecked
// the whole tree and printed a verdict into the middle of the test run.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
