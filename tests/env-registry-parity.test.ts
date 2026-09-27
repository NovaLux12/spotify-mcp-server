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
 * `Object.keys(TOOLSETS)`, the registration keys to the vocabulary
 * `resolveToolOverrides` actually validates.
 *
 * That vocabulary is the **union** of the toolset members and
 * `UNGATED_REGISTRATION_KEYS`, and the union is the whole point. It was
 * `ALL_KEYS` alone when #1521 landed, which was correct then: the four
 * `ungated` rows (`doctor`, `swarm3meta`, `moodexpand`, `receipts`) register
 * whatever the trim says, so #580 gave the resolver a second input and the
 * keys became nameable — a key the operator cannot name is a key they cannot
 * use to turn a module off. Pinning the block to `ALL_KEYS` after that would
 * have asserted the opposite of the truth: the block would stay green while
 * omitting names the parser accepts, which is #1521's own defect (a document
 * disagreeing with the resolver) arriving from the other direction.
 *
 * So this still pins against the module rather than against the SPEC census's
 * wider manifest union, and it still holds the property #1521 was built for:
 * **a name the parser rejects must not be documented.** Only the *direction*
 * of the disagreement changed. Asserting against the SPEC union instead would
 * still pass a document advertising keys the parser refuses, and that check is
 * the one worth keeping.
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

import { TOOLSETS, allRegistrationKeys, UNGATED_REGISTRATION_KEYS } from '../src/toolsets.ts';

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
  // `resolveToolOverrides` builds its `known` map from `[...ALL_KEYS,
  // ...UNGATED_REGISTRATION_KEYS]`, so the vocabulary it accepts is that UNION —
  // `allRegistrationKeys` re-exports only the first term, which is why reading
  // it alone is what made this block under-report after #580. Sorted and
  // deduped because a key can belong to more than one set and `swarm3meta` is
  // both ungated and a toolset member; the doc block is rendered the same way,
  // so the comparison is over sets rather than declaration order.
  const real = [...new Set([...allRegistrationKeys, ...UNGATED_REGISTRATION_KEYS])].sort();
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

  it('documents every ungated key, so a module can be turned off by name', () => {
    // The direction #1521 checked, unchanged in substance: a name an operator
    // cannot find is a name they cannot use. #580 made these four nameable —
    // `resolveToolOverrides` accepts them — so omitting one would document a
    // surface smaller than the one the operator can actually trim. This is the
    // same defect as a listed key the parser rejects, pointing the other way,
    // and it is the half a `documented ⊆ real` comparison cannot see.
    for (const key of UNGATED_REGISTRATION_KEYS) {
      assert.ok(
        documented.includes(key),
        `the env-registration-keys block omits \`${key}\`, which \`resolveToolOverrides\` accepts — `
        + 'an operator who cannot name the key cannot disable the module through the documented override',
      );
    }
  });

  it('advertises no key the parser would reject', () => {
    // #1521's actual protection, and the reason the block is pinned to the
    // module rather than to the SPEC census's wider manifest union: a name the
    // parser refuses is reported "Unknown ... entry ignored" at startup, so
    // documenting one promises an override that does nothing. The comparison is
    // driven off the union above, so this holds independently of which keys are
    // ungated — it fails on a block that grows a name the resolver has never
    // heard of, which is the failure this file was written for.
    const bogus = documented.filter((name) => !real.includes(name));
    assert.deepEqual(
      bogus,
      [],
      'the env-registration-keys block lists keys `resolveToolOverrides` rejects as unknown, '
      + 'so the page promises an override that silently does nothing:\n  ' + bogus.join('\n  '),
    );
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
