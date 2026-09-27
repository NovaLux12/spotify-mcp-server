/**
 * Procedure guard for the AGENTS.md §3 conflicted-document recovery (#1435).
 *
 * The recovery used to read "take the merge base, then run `--write`" — a
 * two-command procedure whose LAST step exits 1 on exactly the file the
 * procedure exists for. `--write` is marker-bounded, so it rewrites the
 * generated blocks and then fails the prose pin; the documented recipe therefore
 * ended in a command that could not report success. The error it printed
 * recommended the same recipe, so the loop closed on itself.
 *
 * Nothing caught it, for the reason `tests/issue-close-keyword.test.ts` exists:
 * the prose gate pins text but never checks that a documented command is
 * runnable, and no test asserted what `--write`'s exit code means. A procedure
 * can rot silently when the only thing gating it is that a paragraph is still
 * spelled the same.
 *
 * So this test asserts the two properties that actually rot — the ORDER of the
 * documented commands, and whether the flags named are flags the script accepts
 * — and deliberately says nothing about wording. A reword that keeps the order
 * and the flags is fine; a reword that drops the order is not.
 */

import './helpers/hermetic.js';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

/** The §3 conflict-recovery section, up to the next top-level heading. */
function recovery(): string {
  const agents = read('AGENTS.md');
  const start = agents.indexOf('### Resolving a conflict in a file that mixes both');
  assert.ok(start > -1, 'AGENTS.md no longer has the §3 conflicted-document recovery section');
  const end = agents.indexOf('\n## ', start);
  return agents.slice(start, end === -1 ? undefined : end);
}

/**
 * The lines in the section that actually invoke the census, paired with their
 * position. Ordered by first appearance in the section, so `find` gives the
 * order the reader is told to run them in.
 *
 * Filtering to `npm run count:tools` matters twice over: the section also
 * contains `git checkout --ours` and prose about --ours/--theirs, and — the
 * reason this is not a plain `indexOf` over the whole section — the section's
 * own explanation of *why* --write is unsafe mentions --write before any
 * command does. Asserting on bare offsets would test the explanation, not the
 * procedure.
 */
function censusCommands(): { line: string; index: number }[] {
  return recovery()
    .split('\n')
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.includes('npm run count:tools'));
}

test('§3 diagnoses with --prose-report before it runs --write (#1435)', () => {
  const commands = censusCommands();
  const at = (flag: string): number | undefined => commands.find(({ line }) => line.includes(flag))?.index;
  const diagnose = at('--prose-report');
  const write = at('--write');
  assert.ok(
    diagnose !== undefined,
    'the recovery must document a `npm run count:tools -- --prose-report` step. Without it the reader reaches --write first, which is the step that fails.',
  );
  assert.ok(write !== undefined, 'the recovery must still document how to rewrite the generated blocks');
  assert.ok(
    diagnose < (write as number),
    `the --prose-report command (line ${diagnose}) must come before the --write command (line ${write}): running the write first is the dead end this issue is about`,
  );
});

test('§3 says the lost paragraph comes back by hand, not from a command (#1435)', () => {
  const section = recovery();
  // The generator only ever held the text between the markers, so the bytes
  // exist in the dropped ref. A recovery that omits this leaves the reader
  // looking for a flag that restores prose.
  assert.match(
    section,
    /git show/,
    'the recovery must say where the lost prose comes from — no command in this repo holds a copy of it',
  );
  // #1435 proposed a `--prose-restore` flag. It was never implemented; naming
  // it would be a second dead end wearing the costume of the first fix.
  assert.doesNotMatch(
    section,
    /--prose-restore/,
    'AGENTS.md §3 must not document --prose-restore: no such flag exists in scripts/surface-census.mjs',
  );
});

test('every census flag §3 documents is one the script accepts (#1435)', () => {
  const documented = new Set(censusCommands().flatMap(({ line }) => line.match(/--[a-z][a-z-]*/g) ?? []));
  assert.ok(documented.size > 0, 'the recovery no longer documents any census command');

  const script = read('scripts/surface-census.mjs');
  for (const flag of documented) {
    assert.match(
      script,
      new RegExp(`'${flag}'`),
      `AGENTS.md §3 documents \`${flag}\`, which scripts/surface-census.mjs does not accept — a documented command that does not run is the #1435 failure again`,
    );
  }
});
