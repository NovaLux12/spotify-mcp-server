/**
 * Test debug-output guard (#664).
 *
 * A `console.log` left in a test is an assertion that cannot fail: the run
 * stays green, the value is printed once into whatever CI log buffer is around,
 * and the next reader has to decide whether it is evidence of anything. The one
 * that shipped printed a structured payload on the same line as the
 * `assert.equal` beside it, so the assertion was unreadable during review and
 * the payload was unowned noise in every run.
 *
 * So the guard has to do two things, and a test that only does the first is
 * decoration. It has to hold the real `tests/` tree at zero, and it has to
 * *fire* when a statement comes back. The first is asserted against the actual
 * test files; the second is driven through the same collector CI runs, plus the
 * real CLI's exit code, rather than by a precomputed verdict.
 *
 * The negative cases carry the weight. This repo has tests that legitimately
 * produce and capture output — `errors.contract.test.ts`,
 * `token-refresh-failure-classification.test.ts` and `history-write-failures.test.ts`
 * assign over `console.error` to capture a handler's stderr, and
 * `guard-sweep-loop.test.ts` embeds a child process's whole source in a
 * template literal. A gate that flagged those would be switched off within a
 * release, which is worse than having no gate, so each of those shapes is
 * pinned here as a non-hit.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectDebugOutputErrors } from '../scripts/check-no-test-debug-output.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GUARD = join(ROOT, 'scripts', 'check-no-test-debug-output.mjs');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('#664 — tests print nothing they have not asserted on', () => {
  it('holds every file under tests/ at zero debug statements', () => {
    const files = walk(join(ROOT, 'tests'));
    assert.ok(files.length > 0, 'the walk found no test files, so this proves nothing');

    const found = files.flatMap((file) =>
      collectDebugOutputErrors(readFileSync(file, 'utf8'), relative(ROOT, file)));

    assert.deepEqual(
      found,
      [],
      `a test is printing instead of asserting. Delete the statement — a print that cannot fail is not a test:\n${found.join('\n')}`,
    );
  });

  it('fires on a debug statement that comes back, and names the file and line', () => {
    const found = collectDebugOutputErrors(
      "console.log('DBG', JSON.stringify(payload));\n",
      'tests/exhaust2_misc.test.ts',
    );
    assert.equal(found.length, 1, `expected one hit, got: ${JSON.stringify(found)}`);
    assert.match(found[0]!, /^tests\/exhaust2_misc\.test\.ts:1: /);
    assert.match(found[0]!, /console\.log\('DBG'/);
  });

  it('fires on every debug channel, and on a debugger statement', () => {
    const source = [
      'console.log(1);',
      'console.debug(2);',
      'console.info(3);',
      'console.trace(4);',
      'debugger;',
    ].join('\n');
    const found = collectDebugOutputErrors(source, 'tests/x.test.ts');
    assert.equal(found.length, 5, `expected all five, got: ${JSON.stringify(found)}`);
    // Line numbers are the whole point of the report, so they are checked too.
    assert.deepEqual(found.map((f) => f.split(':')[1]), ['1', '2', '3', '4', '5']);
  });

  it('reads a debug statement inside a template-literal hole, which is still code', () => {
    const found = collectDebugOutputErrors(
      'const label = `${console.log("x")}`;',
      'tests/x.test.ts',
    );
    assert.equal(found.length, 1, 'the ${…} body is code and must still be checked');
  });

  it('leaves console.error and console.warn alone — real failures use them', () => {
    // Three tests in this repo report a genuine failure through console.error,
    // and none of them should have to argue with this gate to do it.
    const source = [
      "console.error('Error: stub gauntlet died');",
      "console.warn('deprecating this fixture');",
    ].join('\n');
    assert.deepEqual(collectDebugOutputErrors(source, 'tests/x.test.ts'), []);
  });

  it('allows the capture-and-restore idiom for asserting on tool output', () => {
    // This is how a test legitimately checks what a tool printed: replace the
    // function, run the code, restore it. An assignment is not a call, so the
    // gate must read it as the capture it is.
    const source = [
      'const seen: string[] = [];',
      'const originalConsoleError = console.error;',
      'console.error = (...args: unknown[]): void => { seen.push(String(args[0])); };',
      'runTheHandler();',
      'console.error = originalConsoleError;',
    ].join('\n');
    assert.deepEqual(collectDebugOutputErrors(source, 'tests/x.test.ts'), []);
  });

  it('stays quiet on a comment or a string that merely names a debug call', () => {
    // The removal commit for #664 says the words out loud, and
    // guard-sweep-loop.test.ts embeds a child process whose source is full of
    // them. A gate that failed on its own explanation would be switched off.
    const source = [
      "// The old `console.error('DBG', …)` line is gone as of #664.",
      "const note = 'no console.log in this file';",
      "const stub = `\n  console.error('SWEEP_COMPLETE: every tool recorded');\n`;",
      "const real = issueReceipt(client, args);",
    ].join('\n');
    assert.deepEqual(collectDebugOutputErrors(source, 'tests/x.test.ts'), []);
  });

  it('does not mistake a longer property path for the console itself', () => {
    assert.deepEqual(
      collectDebugOutputErrors(
        'const n = this.console.log(sink); const m = myconsole.debug(1);',
        'tests/x.test.ts',
      ),
      [],
    );
  });
});

describe('#664 — the guard fails CI on an introduced debug statement', () => {
  // `describe` bodies run at registration time but the `it` bodies run later,
  // so the fixture directory has to be made in a `before` hook.
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'test-debug-guard-'));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (file: string) => {
    try {
      const stdout = execFileSync(process.execPath, [GUARD, '--check-fixture', file], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, output: stdout };
    } catch (err) {
      const e = err as { status: number | null; stderr: string };
      return { code: e.status ?? -1, output: e.stderr };
    }
  };

  it('exits non-zero and reports the statement when one is present', () => {
    const file = join(dir, 'dirty.ts');
    writeFileSync(file, "console.log('DBG', payload);\n");
    const { code, output } = run(file);
    assert.notEqual(code, 0, 'the gate returned success on a file that does print');
    assert.match(output, /dirty\.ts:1:/);
  });

  it('exits zero on a file with no debug statement, so the gate is not always red', () => {
    const file = join(dir, 'clean.ts');
    writeFileSync(file, 'const album = track.album?.name;\n');
    const { code } = run(file);
    assert.equal(code, 0, 'the gate failed on a clean file, which is how a gate gets ignored');
  });

  it('exits zero on the real tests/ tree', () => {
    const stdout = execFileSync(process.execPath, [GUARD], { encoding: 'utf8', cwd: ROOT });
    assert.match(stdout, /No debug output in tests/);
    assert.match(stdout, /\d+ files checked/);
  });
});
