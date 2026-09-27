/**
 * Issue-close guard: a landed fix must leave its issue closed.
 *
 * Eight issues in this repository were fixed, merged, and left open —
 * #1332, #1338, #1350, #1358, #1359, #1362, #1364 and #722. Every one of them
 * had a PR subject or body that *read* like a closing reference and was not one:
 * `fix(#N)` and `Refs #N` are ordinary text to GitHub, only `Closes` / `Fixes` /
 * `Resolves` close an issue.
 *
 * The failure is silent in the specific way this repo's §6 lessons keep finding.
 * `gh pr merge` prints no issue lines when the keyword matched nothing, so the
 * merge reports clean, the code is on `main`, the test suite is green, and the
 * issue is still open. Nothing in the tree can tell "fixed" from "fixed and
 * still open" — so the next person redoes the work.
 *
 * **What this test can and cannot do.** It reads the *repository*, not GitHub.
 * It cannot know which PR closed which issue at runtime, so it does not pretend
 * to. What it can do is the part that actually rots: assert that the guidance
 * telling an author to use `Closes` and to reconcile after merging is present in
 * both places a contributor reads, that the reconciling script exists, is
 * executable, and refuses to report success unless the issues are verifiably
 * closed. Those are the three things whose absence produced the eight.
 */

import './helpers/hermetic.js';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
const SCRIPT = 'scripts/close-issues-from-pr.sh';

test('the reconciling script exists and is executable', () => {
  const path = join(ROOT, SCRIPT);
  assert.ok(existsSync(path), `${SCRIPT} is missing — nothing reconciles a stranded issue`);
  // A non-executable script is a script nobody runs. Assert the bit, not the
  // mode string: 0o111 catches the three execute bits without asserting a umask.
  assert.ok(
    statSync(path).mode & 0o111,
    `${SCRIPT} is not executable (mode ${(statSync(path).mode & 0o777).toString(8)})`,
  );
});

test('the script verifies the merge actually happened before closing anything', () => {
  const src = read(SCRIPT);
  // The single most important property: it must not close an issue for a PR
  // that is not merged. That is how an issue ends up closed with no code behind
  // it, which is strictly worse than an issue left open.
  assert.match(src, /state.*MERGED|!=\s*"MERGED"/s, `${SCRIPT} does not check that the PR merged`);
  assert.match(src, /REFUSING/, `${SCRIPT} refuses loudly rather than closing for an unmerged PR`);
});

test('the script exits non-zero unless every issue is verifiably closed', () => {
  const src = read(SCRIPT);
  // `gh issue close` can report success while the state did not change, and a
  // close that reports success without closing is the exact failure this script
  // exists to prevent — so it re-reads state after closing and sets `bad`.
  assert.match(src, /bad=1/, `${SCRIPT} has no failure accumulator`);
  assert.match(src, /\bbad\b[\s\S]*exit 1|exit 1[\s\S]*\bbad\b/, `${SCRIPT} never exits non-zero on an incomplete reconcile`);
  assert.match(
    src,
    /already CLOSED[\s\S]*continue/,
    `${SCRIPT} must tolerate GitHub having processed the keyword after all`,
  );
});

test('the script accepts explicit issue numbers, not only body keywords', () => {
  const src = read(SCRIPT);
  // A squash subject reading `Refs #N` gives a keyword scan nothing to find.
  // Requiring the caller to pass the numbers is what makes it usable for the
  // common case in this repo: the branch is `issues=("$@")` under a `$# -gt 0`
  // test, and the loop must then iterate the caller's numbers.
  assert.match(
    src,
    /if \[ "\$#" -gt 0 \]; then\s*\n\s*issues=\("\$@"\)/,
    `${SCRIPT} does not take explicitly supplied issues when given them`,
  );
  assert.match(
    src,
    /for n in "\$\{issues\[@\]\}"/,
    `${SCRIPT} does not iterate the supplied issue numbers`,
  );
  assert.match(
    src,
    /\[issue \.\.\.\]|\[expected-issue \.\.\.\]/,
    `${SCRIPT} does not document an explicit-issue form in its usage`,
  );
});

test('AGENTS.md tells an author that Closes is the only closing keyword', () => {
  const md = read('AGENTS.md');
  assert.match(
    md,
    /Closes #N`? \/ `?Fixes #N`? \/ `?Resolves #N`?|only `?Closes/,
    'AGENTS.md does not state that Closes/Fixes/Resolves are the closing keywords',
  );
  // The two near-misses must be named explicitly. A rule that only says "use
  // Closes" leaves the reader choosing between three spellings that all look
  // right, which is how `fix(#N)` and `Refs #N` got written in the first place.
  for (const decoy of ['fix(#N)', 'Refs #N']) {
    assert.ok(md.includes(decoy), `AGENTS.md never names \`${decoy}\` as a non-closing spelling`);
  }
});

test('AGENTS.md points the closing step at the script by name', () => {
  const md = read('AGENTS.md');
  assert.ok(
    md.includes(SCRIPT),
    `AGENTS.md never names ${SCRIPT}, so the instruction to reconcile has nothing to invoke`,
  );
  // The PR checklist is where an author actually looks last. If the closing
  // step is not in the checklist it does not happen.
  const checklist = md.slice(md.indexOf('## 7. Before you open a PR'));
  assert.ok(checklist.includes(SCRIPT), `the §7 PR checklist does not mention ${SCRIPT}`);
});

test('CONTRIBUTING.md states the rule for human contributors', () => {
  const md = read('CONTRIBUTING.md');
  assert.ok(
    md.includes(SCRIPT),
    `CONTRIBUTING.md does not mention ${SCRIPT}, so a human contributor has no way to learn the reconcile step exists`,
  );
  for (const decoy of ['fix(#N)', 'Refs #N']) {
    assert.ok(md.includes(decoy), `CONTRIBUTING.md never names \`${decoy}\` as a non-closing spelling`);
  }
});
