/**
 * The env reference's name lists cannot drift from the code (#926).
 *
 * ## Why this exists
 *
 * `docs/configuration.md` documents which names `SPOTIFY_MCP_TOOLSETS`,
 * `SPOTIFY_MCP_ENABLE_TOOLS` and `SPOTIFY_MCP_DISABLE_TOOLS` accept, and it
 * listed them by hand. Hand-maintained means unmaintained, and it had already
 * drifted: `accounts` is a real toolset — added in #602, with its own entry in
 * `TOOLSETS` as well as membership in `core` — and it appeared in neither list
 * on the page. An operator reading the reference could not name the one set
 * that exists to answer "which account is this session acting as?", and the
 * omission was invisible: `resolveToolsets` accepts the name regardless, the
 * startup warning for a genuine misspelling names the sets it knows, and every
 * other gate in this repository passes on a page that is wrong.
 *
 * The same class of drift is the reason the counts in this file are not read
 * back out of a doc comment. `docs/schema-budgets.md` once measured a per-file
 * line count, so an unrelated comment made its block stale (AGENTS.md §6), and
 * a census figure that moved for a reason its block does not describe costs two
 * agents two `--write` cycles. So the expectations here are the code's own
 * values, imported rather than re-derived, and the doc is the thing under test.
 *
 * ## What it asserts, and what it deliberately does not
 *
 * Both generated blocks are pinned to the live module: the toolset names to
 * `Object.keys(TOOLSETS)`, the registration keys to `allRegistrationKeys()`.
 * The second is the *validation* set `resolveToolOverrides` accepts, not the
 * wider manifest union the SPEC census prints. That distinction is the whole
 * point of pinning against the module rather than against the other document:
 * `doctor`, `moodexpand` and `receipts` are `ungated` and register
 * unconditionally, so they are real registration keys that the trim variables
 * would reject as unknown. Asserting this list against the SPEC union would
 * have passed a document advertising three names the parser refuses.
 *
 * Nothing here re-implements the block renderer. The blocks are owned by
 * `scripts/surface-census.mjs` and `npm run count:tools -- --check` is what
 * fails when they go stale; this test asserts the *claim* those blocks make
 * about the code, which is the half `--check` structurally cannot see — it
 * compares a document against the census's own render of the census's own
 * inputs, so a block that renders a faithful copy of a wrong list stays green
 * there. A test that reads the rendered names back and compares them to the
 * module is the only thing that catches the wrong list.
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOLSETS, allRegistrationKeys } from '../src/toolsets.ts';

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)));
const CONFIG_DOC = readFileSync(join(ROOT, 'docs/configuration.md'), 'utf8');

/** The backticked names inside one generated block of the env reference. */
function namesInBlock(name: string): string[] {
  const start = CONFIG_DOC.indexOf(`<!-- BEGIN:generated ${name} -->`);
  const end = CONFIG_DOC.indexOf(`<!-- END:generated ${name} -->`);
  assert.ok(
    start >= 0 && end > start,
    `docs/configuration.md has no \`${name}\` block — run \`npm run count:tools -- --write\``,
  );
  return [...CONFIG_DOC.slice(start, end).matchAll(/`([a-z0-9]+)`/g)].map((m) => m[1]!);
}

describe('the documented toolset names are the real ones (#926)', () => {
  const real = Object.keys(TOOLSETS);
  const documented = namesInBlock('env-toolsets');

  it('names every toolset the server accepts', () => {
    assert.deepEqual(
      [...documented].sort(),
      [...real].sort(),
      'docs/configuration.md does not list exactly `Object.keys(TOOLSETS)`. '
        + `Missing from the page: ${real.filter((n) => !documented.includes(n)).join(', ') || '(none)'}. `
        + `Listed but not a toolset: ${documented.filter((n) => !real.includes(n)).join(', ') || '(none)'}.`,
    );
  });

  it('lists each name once', () => {
    // A duplicated name renders as two backticked items in one sentence and
    // reads to an operator as two distinct sets.
    assert.equal(
      new Set(documented).size,
      documented.length,
      `docs/configuration.md lists a toolset twice: ${documented.join(', ')}`,
    );
  });

  it('scans a real surface (a broken pattern would make the check vacuous)', () => {
    // The `accounts` omission is the regression this test was written for, so
    // it is pinned explicitly rather than left to the deepEqual above: a change
    // to the extraction that quietly dropped the LAST name would otherwise make
    // the comparison pass with one fewer name than the module has.
    assert.ok(
      documented.includes('accounts'),
      'the env-toolsets block no longer names `accounts` — the #926 drift is back',
    );
    assert.equal(documented.length, real.length, 'the block and the module disagree on how many toolsets there are');
  });
});

describe('the documented registration keys are the ones the trim accepts (#926)', () => {
  // `resolveToolOverrides` validates against ALL_KEYS, which is what
  // `allRegistrationKeys` re-exports. Sorted and deduped because a key can
  // belong to more than one set; the doc block is rendered the same way, so the
  // comparison is over sets rather than declaration order.
  const real = [...new Set(allRegistrationKeys)].sort();
  const documented = namesInBlock('env-registration-keys');

  it('names every key the trim accepts, and nothing it does not', () => {
    assert.deepEqual(
      [...documented].sort(),
      real,
      'docs/configuration.md does not list exactly the keys '
        + '`SPOTIFY_MCP_ENABLE_TOOLS` / `SPOTIFY_MCP_DISABLE_TOOLS` accept. '
        + `Missing: ${real.filter((n) => !documented.includes(n)).join(', ') || '(none)'}. `
        + `Listed but rejected by the parser: ${documented.filter((n) => !real.includes(n)).join(', ') || '(none)'}.`,
    );
  });

  it('does not advertise the ungated keys the parser would reject', () => {
    // `doctor`, `moodexpand` and `receipts` are real registration keys — the
    // SPEC census counts them — but they are `ungated` in the manifest and
    // register whatever the trim says. Printing them next to the trim variables
    // would promise a name `resolveToolOverrides` reports as unknown, which is
    // the same defect as a missing name, pointing the other way.
    const ungated = ['doctor', 'moodexpand', 'receipts'].filter((key) => real.includes(key) === false);
    // The filter is what makes the loop below able to run out of work: give one
    // of these a toolset membership and `ungated` shrinks, and if it ever
    // empties the loop asserts nothing and passes forever. So the emptiness is
    // itself the failure — it means the premise above no longer holds and the
    // check needs re-reading, not that there is nothing left to check.
    assert.ok(
      ungated.length > 0,
      'none of doctor/moodexpand/receipts is ungated any more — the check below would run zero times and pass vacuously, so re-read it against the manifest',
    );
    for (const key of ungated) {
      assert.ok(!documented.includes(key), `the env-registration-keys block lists \`${key}\`, which the trim rejects`);
    }
  });

  it('scans a real surface (a broken pattern would make the check vacuous)', () => {
    assert.ok(
      real.length >= 40,
      `only ${real.length} registration keys were derived — the block would be too thin to be the complete list`,
    );
    assert.equal(
      documented.length,
      real.length,
      'the block and the module disagree on how many registration keys there are',
    );
    assert.ok(
      documented.includes('accounts'),
      'the env-registration-keys block no longer names `accounts` — the #926 drift is back',
    );
  });
});

describe('the blocks are gated, not merely present (#926)', () => {
  const census = readFileSync(join(ROOT, 'scripts/surface-census.mjs'), 'utf8');

  it('claims both blocks in the census `blocks` array', () => {
    // A marker pair with no `blocks` entry is an orphan: `--write` never
    // refreshes it and `--check` can never report it stale, so it drifts
    // silently and forever. `markerTreeReport` fails on one too, but only once
    // someone runs the tree scan; this asserts the claim directly.
    //
    // Matched per line and anchored past any leading `//`, because a plain
    // `includes` over the whole file also matches the entry inside a commented-
    // out line — which is how commenting the claim out passed the first version
    // of this test.
    const claims = new Set(
      census
        .split('\n')
        .map((line) => /^\s*\[\s*'docs\/configuration\.md'\s*,\s*'([a-z0-9-]+)'/.exec(line)?.[1])
        .filter((name): name is string => name !== undefined),
    );
    assert.deepEqual(
      [...claims].sort(),
      ['env-registration-keys', 'env-toolsets'],
      'scripts/surface-census.mjs no longer claims exactly the two env-reference '
        + `blocks, so nothing regenerates them: ${[...claims].sort().join(', ') || '(none)'}`,
    );
  });

  it('renders each block from the module, not from a literal in the script', () => {
    // Both generators read `src/toolsets.ts` through `parseToolsetsModule`. A
    // literal name list inside the census would move the drift one file over
    // rather than remove it, and would look identical to this test.
    //
    // The body is bounded by the closing brace at column 0 — a `[\s\S]*?` that
    // ran to the end of the file would match a call sitting in some LATER
    // function, which is exactly the vacuity this assertion exists to catch:
    // the first version of it passed with a hard-coded array in place. An
    // unmatched function yields an empty body, which then fails the match
    // below rather than passing on absence.
    const toolsetBody = /function toolsetNameList\(\) \{\n((?:[^\n]*\n)*?)\}\n/.exec(census)?.[1] ?? '';
    assert.match(
      toolsetBody,
      /parseToolsetsModule\(\)/,
      'toolsetNameList no longer derives its names from src/toolsets.ts — a literal list here re-creates the #926 drift one file over',
    );

    const keyBody = /function registrationKeyList\(\) \{\n((?:[^\n]*\n)*?)\}\n/.exec(census)?.[1] ?? '';
    assert.match(
      keyBody,
      /allRegistrationKeysFromSource\(\)/,
      'registrationKeyList no longer derives its names from src/toolsets.ts — a literal list here re-creates the #926 drift one file over',
    );
  });
});
