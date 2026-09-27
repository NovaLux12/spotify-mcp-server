import './helpers/hermetic.js';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cliStdout, runCliSubcommand, type CliRun } from './helpers/cli-child.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Run one of the fixtures below through the promoted harness.
 *
 * The `env` is not the ambient one: a child that inherited this box's `HOME`
 * would read and write the real `~/.spotify-mcp`, which is the leak
 * `tests/helpers/hermetic.ts` exists to prevent. The helper takes the env from
 * its caller for exactly this reason, so there is no default to forget.
 *
 * `cwd` and `env` are **not** in the accepted options, which is the point. They
 * are applied after the caller's fields, so a test cannot spread its way into
 * the ambient environment — and with them absent from the parameter type, a test
 * that tried would not compile. The alternative (`{ cwd, env, ...options }`)
 * put the caller's values *last*: a silent no-op in every test here, since none
 * of them pass either field, and a live `HOME` leak in the first one that did.
 */
function cli(
  options: Omit<Parameters<typeof runCliSubcommand>[0], 'cwd' | 'env'>,
): Promise<CliRun> {
  return runCliSubcommand({
    ...options,
    cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: tmpdir() },
  });
}

/**
 * The one-shot CLI harness, tested (#1378, promoted to `tests/helpers/` by #1379).
 *
 * These four cases moved here from `tests/branding-notice-guard.test.ts`
 * unchanged in substance, because they test the harness and the harness now
 * lives in `tests/helpers/cli-child.ts`. The defect they were written for, and
 * the measured table behind it, are documented on that module — a reader
 * chasing #1378 should find the reason at the code, not at one of its first
 * call sites.
 *
 * They are also the answer to #1379's own regression ask: *a child driven to a
 * signal-kill must fail naming the signal, in each harness that spawns one*.
 * There are now exactly two harnesses, and this is the CLI one —
 * `tests/stdio-child.test.ts` is the stdio one, and its first case is the same
 * assertion against a different child.
 *
 * The four fixtures are real children, one per outcome, because a synthetic
 * `{signal: 'SIGKILL'}` would only prove the helper agrees with a shape its
 * author imagined.
 */
describe('the CLI harness tells a killed child from a silent one (#1378)', () => {
  /**
   * Real children, one per outcome. `killed` is the OOM killer's exact shape:
   * a process that dies by signal having printed nothing.
   */
  const FIXTURES: Readonly<Record<string, string>> = {
    killed: 'process.kill(process.pid, "SIGKILL");\n',
    wedged: 'setInterval(() => {}, 1000);\n',
    exits1: 'process.exit(1);\n',
    exits0: 'process.exit(0);\n',
  };

  let fixtures: string;
  before(async () => {
    fixtures = await mkdtemp(path.join(tmpdir(), 'x1378-cli-'));
    await Promise.all(
      Object.entries(FIXTURES).map(([name, body]) =>
        writeFile(path.join(fixtures, `${name}.mjs`), body, 'utf8'),
      ),
    );
  });
  after(async () => {
    await rm(fixtures, { recursive: true, force: true });
  });

  const fixture = (name: string): string => path.join(fixtures, `${name}.mjs`);

  /** The reason from a run that did not reach a verdict, or a hard failure if it did. */
  function reasonOf(result: CliRun): string {
    if (result.ok) {
      assert.fail(
        `expected the child not to have exited, but it exited ${result.code} `
          + `with stdout ${JSON.stringify(result.stdout)}`,
      );
    }
    return result.reason;
  }

  it('reports a SIGKILLed child as killed, and never as a child that printed nothing', async () => {
    // The regression, driven rather than described. A real child killed by a
    // real signal, the shape a loaded box produces and the shape the old
    // `e.stdout ?? ''` returned as `''`.
    const result = await cli({ entry: fixture('killed') });

    const reason = reasonOf(result);

    // Named in #1335's vocabulary, so a grep finds one convention repo-wide.
    assert.match(reason, /killed by SIGKILL/, 'the cause must be the signal, by name');
    // A signalled child has no exit code; saying so keeps the OOM kill from
    // being filed under "exited with no status".
    assert.match(reason, /code=null/, 'a signalled child has no exit code and the report must say so');
    assert.match(reason, /signal=SIGKILL/);
    // The line that answers the reader's only question: box or code?
    assert.match(reason, /host pressure:/, 'the report must carry the host pressure reading');
    // And it must not read as the compliance regression it is not.
    assert.match(reason, /NOT a compliance failure/, 'a signal kill must not be reported as a missing notice');

    // The caller side, which is what the notice assertions actually go through.
    assert.throws(
      () => cliStdout(result),
      /killed by SIGKILL/,
      'a notice assertion must fail with the cause, not with an empty expected value',
    );
  });

  it('tells the harness deadline apart from an unexplained signal', async () => {
    // A hang and an OOM kill are the same three fields on the wire
    // (`code: null`, `signal: 'SIGKILL'`) and different diagnoses: one points at
    // this file's `CLI_TIMEOUT_MS`, the other at the machine. Filing the
    // deadline as a kill sends the reader after a process failure they caused.
    const result = await cli({ entry: fixture('wedged'), timeoutMs: 1_000 });

    const reason = reasonOf(result);

    assert.match(reason, /ETIMEDOUT/, 'the deadline must be named as one');
    assert.match(reason, /1000ms deadline/, 'the report must say the child ran the full deadline, not that it vanished');
    assert.doesNotMatch(
      reason,
      /killed by SIGKILL/,
      'the harness\'s own deadline must not be reported as an unexplained signal kill',
    );
    // It is a hang, so the "not a product failure" wording is different: a
    // child that ran for 30s may genuinely be stuck, and saying so is the point.
    assert.doesNotMatch(reason, /NOT a compliance failure/, 'a hang is a different diagnosis from a signal kill');
  });

  it('still returns the empty output of a child that ran and exited non-zero', async () => {
    // The anti-overcorrection, and the case that matters most, because it is the
    // real one: `doctor` exits 1 whenever any check fails. A fix that failed
    // every non-exit-zero run would break the notice guard outright, and a fix
    // that failed every *empty* one would pass the kill case above while
    // breaking a child that legitimately printed nothing.
    const result = await cli({ entry: fixture('exits1') });

    assert.equal(result.ok, true, 'a non-zero exit is a verdict, not a crash');
    if (result.ok) {
      assert.equal(result.code, 1, 'the exit code must survive rather than be flattened');
      assert.equal(cliStdout(result), '', 'empty output from a child that ran is a legitimate answer');
    }
  });

  it('still returns the empty output of a child that exited cleanly', async () => {
    // The other direction through the same code, and the one that would catch a
    // `cli()` that failed whenever the notice was *absent* rather than whenever
    // the child was gone.
    const result = await cli({ entry: fixture('exits0') });

    assert.equal(result.ok, true, 'a clean exit is the normal path');
    assert.equal(cliStdout(result), '', 'a silent clean exit must not be reported as a harness failure');
  });
});
