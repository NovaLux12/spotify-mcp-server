#!/usr/bin/env node
/**
 * Mutation harness for #676.
 *
 * Each mutation reverts ONE part of the fix to its pre-fix behaviour and
 * asserts the cancellation tests go RED. A mutation that silently fails to
 * apply is indistinguishable from a test that passes, so every mutation here:
 *
 *   - ASSERTS its anchor was found in the source (abort loudly otherwise),
 *   - PRINTS the post-mutation state of the anchor,
 *   - exits non-zero if the script itself errored, and
 *   - restores the file from an in-memory copy, so no mutation can escape.
 *
 * Usage: node scripts/mutate-676.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * MUTATIONS[i] = { name, file, from, to, tests }
 * `from` MUST appear exactly once in `file`; that is the anchor.
 */
const MUTATIONS = [
  {
    // The walk's between-pages boundary lives here: `get` refuses at its entry
    // before the URL is built and before the request is enqueued, so a signal
    // arriving while page N is in flight stops the walk before page N+1.
    name: 'M1 client: get() no longer refuses an aborted read at its entry',
    file: 'src/client.ts',
    from: '    if (signal?.aborted) throw cancelledError(\'GET\', path);\n',
    to: '',
    tests: ['tests/cancellation.test.ts', 'tests/cancellation-sdk.test.ts'],
  },
  {
    name: 'M2 queue: dispatch a task even when its signal is already aborted',
    file: 'src/client.ts',
    from: '      if (task.signal?.aborted) {\n        task.reject(cancelledError(undefined, undefined));\n        return;\n      }\n',
    to: '',
    tests: ['tests/cancellation.test.ts'],
  },
  {
    name: 'M3 client: stop combining the caller signal with the timeout',
    file: 'src/client.ts',
    from: '  const effective = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);',
    to: '  const effective = timeoutSignal;',
    tests: ['tests/cancellation.test.ts', 'tests/cancellation-sdk.test.ts'],
  },
  {
    name: 'M4 client: fall through to the retry backoff on a cancelled request',
    file: 'src/client.ts',
    from: '      if (signal?.aborted) throw cancelledError(method, url);\n      // A thrown transport error',
    to: '      // A thrown transport error',
    tests: ['tests/cancellation.test.ts'],
  },
  {
    name: 'M5 seam: the tool boundary stops installing the request signal',
    file: 'src/cancellation.ts',
    from: '        return runInCancellationContext(extra?.signal, () => cb(...cbArgs));',
    to: '        return runInCancellationContext(undefined, () => cb(...cbArgs));',
    tests: ['tests/cancellation.test.ts', 'tests/cancellation-sdk.test.ts'],
  },
  {
    name: 'M6 ambient context: resolve the walk signal from the store per page',
    file: 'src/client.ts',
    from: '    const signal = opts?.signal ?? currentRequestSignal();\n    const all: T[] = [];',
    to: '    const all: T[] = [];',
    tests: ['tests/cancellation.test.ts', 'tests/cancellation-sdk.test.ts'],
  },
  {
    // Regression guard for a bug this test file actually caught while it was
    // being written: `get()` resolved a signal and then failed to hand it to
    // `enqueue`, so the queued task carried the ambient signal instead and a
    // caller-supplied one was lost the moment the request hit the lane.
    name: 'M7 get(): stop handing the resolved signal to the queue',
    file: 'src/client.ts',
    from: '      // in the lane could not be dropped when that signal fired (#676).\n      signal,\n    );\n    if (servedFrom304) return result;',
    to: '      // in the lane could not be dropped when that signal fired (#676).\n    );\n    if (servedFrom304) return result;',
    tests: ['tests/cancellation.test.ts'],
  },
];

function run(cmd, args) {
  return execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function countTests(output) {
  const m = /# pass (\d+)[\s\S]*?# fail (\d+)/.exec(output) ?? /pass (\d+)[\s\S]*?fail (\d+)/.exec(output);
  return m ? { pass: Number(m[1]), fail: Number(m[2]) } : { pass: -1, fail: -1 };
}

const rows = [];
let harnessErrored = false;

for (const m of MUTATIONS) {
  const abs = path.join(root, m.file);
  let original;
  try {
    original = readFileSync(abs, 'utf8');
  } catch (err) {
    console.error(`ABORT: cannot read ${m.file}: ${err}`);
    harnessErrored = true;
    break;
  }

  const occurrences = original.split(m.from).length - 1;
  if (occurrences !== 1) {
    // The whole point of the harness. A mutation whose anchor is absent or
    // ambiguous is NOT a passing test — it is a mutation that never happened.
    console.error(
      `ABORT: anchor for "${m.name}" found ${occurrences} times in ${m.file} (expected exactly 1).\n` +
      `       The mutation did NOT apply; the run below would be meaningless.`,
    );
    harnessErrored = true;
    break;
  }

  const mutated = original.replace(m.from, m.to);
  const after = mutated.split(m.from).length - 1;
  if (after !== 0) {
    console.error(`ABORT: mutation for "${m.name}" did not remove its anchor (still ${after} present).`);
    harnessErrored = true;
    break;
  }

  try {
    writeFileSync(abs, mutated, 'utf8');
  } catch (err) {
    console.error(`ABORT: cannot write ${m.file}: ${err}`);
    harnessErrored = true;
    break;
  }

  // Print the post-mutation state so the applied change is visible, not assumed.
  const state = mutated.includes(m.to) ? m.to.trim().split('\n')[0] : '(anchor removed)';
  console.log(`\n--- ${m.name} ---`);
  console.log(`    anchor : ${m.from.trim().split('\n')[0]}`);
  console.log(`    now    : ${state}`);

  let outcome;
  try {
    for (const t of m.tests) {
      const out = run('npx', ['tsx', '--test', t]);
      const { pass, fail } = countTests(out);
      outcome = outcome ?? { pass: 0, fail: 0 };
      outcome.pass += pass;
      outcome.fail += fail;
    }
  } catch (err) {
    // A non-zero exit from the test runner is the EXPECTED outcome here.
    const out = `${err.stdout ?? ''}\n${err.stderr ?? ''}`;
    const { pass, fail } = countTests(out);
    outcome = { pass, fail };
  } finally {
    writeFileSync(abs, original, 'utf8');
  }

  if (!outcome) {
    console.error(`ABORT: no test output captured for "${m.name}".`);
    harnessErrored = true;
    break;
  }

  const verdict = outcome.fail > 0 ? 'RED (good)' : 'GREEN (BAD — test cannot detect this)';
  console.log(`    result : pass=${outcome.pass} fail=${outcome.fail} -> ${verdict}`);
  rows.push({ mutation: m.name, pass: outcome.pass, fail: outcome.fail, detected: outcome.fail > 0 });
  if (outcome.fail === 0) harnessErrored = true;
}

console.log('\n================ MUTATION TABLE ================');
for (const r of rows) {
  console.log(
    `${r.detected ? 'DETECTED ' : 'MISSED  '} ${r.mutation}  (pass=${r.pass} fail=${r.fail})`,
  );
}
console.log('================================================');

if (harnessErrored) {
  console.error('\nHARNESS REPORTED A PROBLEM — do not read this run as "tests pass".');
  process.exit(1);
}
console.log('\nAll mutations were detected.');
