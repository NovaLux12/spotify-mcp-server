/**
 * The hand-maintained prose declaration must cover every export of the module
 * beside it.
 *
 * `scripts/prose-manifest.d.mts` exists because `tsconfig.tests.json` does not
 * include `scripts`, so an importing test would otherwise bind to `any`. Its own
 * header says the accepted cost is that it "can drift from the `.mjs` beside
 * it" — and that cost was paid the moment the module grew: #1451 added five
 * exports and the declaration kept its original six, so a test importing them
 * failed `npm run check:tests-typecheck` with five TS2305s while `tsx` — which
 * strips types without checking them — ran the suite green.
 *
 * **The typecheck gate cannot be the guard for this.** It only speaks when
 * something *imports* the missing name, so it found the five the new test
 * happened to reach and said nothing about `stampProvenance`'s neighbours
 * `short` and `readFilesAtRef`, which were undeclared too and are imported by
 * nobody. A declaration can therefore be missing an export, indefinitely,
 * without any gate noticing — which is the same shape as every other
 * "the check matched nothing" failure this repository keeps having to fix.
 *
 * So the coverage is asserted directly: every runtime export of the `.mjs` must
 * be declared. The comparison is written as a pure function and then exercised
 * against a synthetic pair, because a test that only ever compares two sets
 * which already agree cannot distinguish "complete" from "compared nothing"
 * (AGENTS.md §6). The vacuity half is the assertion that matters; the real-tree
 * half is the one that would be vacuous without it.
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = join(ROOT, 'scripts/prose-manifest.mjs');
const DECLARATION = join(ROOT, 'scripts/prose-manifest.d.mts');

/**
 * Value exports the declaration binds, read from its text.
 *
 * `export type` is deliberately not matched: a type has no runtime identity, so
 * requiring one would be nonsense, and the direction that matters is the other
 * one — a value the module exports and the declaration cannot name.
 */
const DECLARED_VALUE = /^export (?:declare )?(?:async )?(?:function|const|let|var|class) (\w+)/gm;

async function declaredExports(): Promise<Set<string>> {
  const source = await readFile(DECLARATION, 'utf8');
  return new Set(Array.from(source.matchAll(DECLARED_VALUE), (match) => match[1] as string));
}

/** The names `runtime` offers that `declared` cannot name. */
const undeclared = (runtime: readonly string[], declared: ReadonlySet<string>): string[] =>
  runtime.filter((name) => !declared.has(name));

describe('the prose manifest declaration covers its module', () => {
  it('declares every export the module actually offers', async () => {
    const runtime = Object.keys(await import('../scripts/prose-manifest.mjs'));
    const declared = await declaredExports();
    assert.deepEqual(
      undeclared(runtime, declared),
      [],
      `scripts/prose-manifest.d.mts is hand-maintained and does not declare every export of the .mjs beside it. `
        + `Add the missing signature(s) with their real types — do not widen a caller's cast, and do not delete the export.`,
    );
  });

  it('compares against a module that really has these exports', async () => {
    // Non-vacuity, in both directions, because a module that had lost every
    // export would satisfy the test above for the wrong reason: an empty
    // `runtime` has nothing undeclared in it. Pin the real surface instead of
    // reconstructing it, so this fails if the module is emptied *or* reshaped.
    const runtime = Object.keys(await import('../scripts/prose-manifest.mjs'));
    assert.ok(runtime.length >= 12, `expected the module to export at least 12 names, found ${runtime.length}`);
    for (const name of [
      'splitProseUnits',
      'proseUnitLabel',
      'proseUnitHash',
      'describeDocument',
      'proseDrift',
      'syncProseManifest',
      'stampProvenance',
      'gitProvenanceIn',
      'proseSyncRefusals',
      'proseProvenanceVerdict',
      'readFilesAtRef',
      'contradictedByUpstream',
    ]) {
      assert.ok(runtime.includes(name), `expected scripts/prose-manifest.mjs to export ${name}`);
    }
  });

  it('detects a missing declaration, which is the failure this guard exists for', () => {
    // The half that makes the first test mean something. `runtime` here is
    // synthetic, so the only way this passes is if `undeclared` genuinely
    // reports a name the declaration cannot name — if the comparison were
    // stubbed, inverted, or comparing the wrong sides, this would fail.
    assert.deepEqual(undeclared(['keep', 'missing'], new Set(['keep'])), ['missing']);
    assert.deepEqual(undeclared(['keep'], new Set(['keep', 'extra'])), [], 'a spare declaration is not a defect');
    assert.deepEqual(undeclared([], new Set<string>()), [], 'an empty module is handled without throwing');
  });
});
