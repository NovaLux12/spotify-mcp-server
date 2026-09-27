/**
 * No caller-facing string may carry a literal *approximate* numeric rate (#1259).
 *
 * `DEAD_STATSFM_IDS` in `src/tools/taste_composites.ts` shipped the string
 * "stats.fm externalIds.spotify[] are often dead (~12%)" to every agent that
 * received a track list from any of the eleven taste composites. Nothing
 * measured that 12%: `git log -S` dates its arrival to the release commit
 * `73e40ae` rather than to a change carrying provenance, and no probe,
 * fixture or sweep report produces it. An unsourced statistic presented as
 * fact is the failure AGENTS.md §6 records twice already, and this one had no
 * caller able to audit it -- it arrived in tool output, as a property of
 * stats.fm.
 *
 * The guard is deliberately narrow, because the obvious broad version does
 * not work. Banning percentages outright would reject legitimate literals that
 * are all over this surface: `0-100%` as a score range, `50%` as a volume
 * default, `>60%` as an era-split threshold, `70%-99%` defining a label. The
 * distinguishing feature is not "a percentage" but "an ESTIMATED percentage",
 * and there is a structural reason it is checkable:
 *
 *   A rate that was actually measured is computed at runtime from live data,
 *   so it appears as interpolation -- `${pct}%`, `${n}/${total}` -- and never
 *   as digits typed into a string literal. A literal that spells out an
 *   approximate rate is therefore, by construction, a number somebody
 *   asserted without measuring it.
 *
 * So the rule is: `~12%`, `approx 12%` or the `≈` forms may not appear in a
 * string or template literal under `src/`. Exact literals are untouched, and
 * the negative cases below assert that, because a guard which is right for
 * the wrong reason -- or which simply bans the word -- is not a guard.
 *
 * Comments are exempt by design: the guard exists to stop a claim reaching a
 * caller, and a comment explaining *why* a figure was removed is the opposite
 * of the defect. `src/tools/taste_composites.ts` carries the removed figure in
 * a comment for exactly that reason.
 *
 * Run: node --import tsx --test tests/approximate-rate-guard.test.ts
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { lineOf, scanFile, walkTypeScriptFiles } from './ts-source-scan.js';

/**
 * An approximate rate: a tilde or approximation sign before the number.
 *
 * The alternation includes the two ASCII spellings people reach for when the
 * `≈` glyph is awkward in a terminal, so the guard cannot be sidestepped by
 * choosing a different sigil.
 */
const APPROXIMATE_RATE = /(?:~|≈|∼|\bapprox\.?\s+)\s*\d+(?:\.\d+)?\s*%/gi;

type Hit = { path: string; line: number; text: string };

/** Every approximate rate written into a string or template literal under `root`. */
export function findApproximateRates(root = 'src'): Hit[] {
  const hits: Hit[] = [];
  for (const rel of walkTypeScriptFiles(root)) {
    const file = scanFile(rel);
    for (const match of file.code.matchAll(APPROXIMATE_RATE)) {
      const from = Math.max(0, match.index - 40);
      hits.push({
        path: rel,
        line: lineOf(file.source, match.index),
        text: file.code.slice(from, match.index + match[0].length + 20).replace(/\s+/g, ' '),
      });
    }
  }
  return hits;
}

describe('approximate-rate guard (#1259)', () => {
  it('ships no literal approximate rate in caller-facing text', () => {
    const hits = findApproximateRates();
    assert.deepEqual(
      hits,
      [],
      `Literal approximate rates in caller-facing strings. A measured rate is computed at runtime and interpolated; a literal one is an estimate nobody measured (#1259):\n${hits
        .map((h) => `  ${h.path}:${h.line}  ...${h.text}...`)
        .join('\n')}`,
    );
  });

  it('scans a real surface, and would fail if it stopped (#1259)', () => {
    // A guard that scans nothing passes. These assertions fail loudly if the
    // tokenizer or the file walk silently breaks, so "no hits" cannot mean
    // "nothing was read" (AGENTS.md §6: a test that cannot fail is worse than
    // no test). Named files rather than a hardcoded count, so the assertion
    // keeps its meaning as the tree grows.
    const files = walkTypeScriptFiles('src');
    for (const expected of ['src/tools/taste_composites.ts', 'src/tools/annotations.ts', 'src/gating.ts']) {
      assert.ok(files.includes(expected), `expected ${expected} in the scanned set (${files.length} files)`);
    }
    assert.ok(files.length > 50, `expected the real src/ tree, saw only ${files.length} files`);

    // The file the defect lived in, with its caller-facing string intact.
    const composites = scanFile('src/tools/taste_composites.ts');
    assert.match(composites.code, /export const DEAD_STATSFM_IDS/);
    assert.ok(
      composites.code.includes('do not resolve on Spotify'),
      'expected the reworded guidance string to still be present',
    );
  });

  it('flags the exact string #1259 removed, so the detector can fire', () => {
    // The historical claim, verbatim. If this ever stops matching, the guard
    // above has been silently disarmed.
    const historical = 'stats.fm externalIds.spotify[] are often dead (~12%) — if a URI 404s, run search_tracks.';
    assert.ok(APPROXIMATE_RATE.test(historical), 'detector must match the historical (~12%) claim');
    // `test`/`exec` carry lastIndex on a /g regex; reset so the shared pattern
    // is left clean for any later assertion.
    APPROXIMATE_RATE.lastIndex = 0;
  });

  it('does not flag the legitimate percentage shapes in this surface', () => {
    // The negative cases. Without these the guard could be replaced with
    // /%/, pass the positive test, and ban the score range, the volume
    // default and the era threshold that this surface genuinely needs.
    const legitimate = [
      'score each artist 0-100%',          // score range
      'falls back to 50% if nothing remembered', // volume default
      'split on >60% volume shifts',      // era threshold
      'albums where 70%-99% of tracks are saved', // label definition
      'the endpoint could not be read - this is NOT a completeness of 0%', // prose
      'report ${pct}% of streams',         // runtime-computed rate
      '12%',                               // exact, not approximate
    ];
    for (const text of legitimate) {
      assert.equal(APPROXIMATE_RATE.test(text), false, `must not flag: ${text}`);
      APPROXIMATE_RATE.lastIndex = 0;
    }
  });

  it('keeps the documented copy of the guidance identical to the emitted one', () => {
    // The task's own failure mode: a number removed from the code and left in
    // the doc. The doc quotes the emitted guidance verbatim, so equality is the
    // cheap honest check; it is normalised for whitespace because the doc
    // re-wraps the string across three lines.
    const composites = readFileSync(join(process.cwd(), 'src', 'tools', 'taste_composites.ts'), 'utf8');
    const emitted = /export const DEAD_STATSFM_IDS =\s*\n?\s*'([^']*)';/.exec(composites)?.[1];
    assert.ok(emitted, 'could not read DEAD_STATSFM_IDS from source');

    const doc = readFileSync(join(process.cwd(), 'docs', 'wave2-composites.md'), 'utf8');
    const quoted = /```text\n([\s\S]*?)\n```/.exec(doc)?.[1];
    assert.ok(quoted, 'docs/wave2-composites.md must still quote the emitted guidance');

    const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim();
    assert.equal(
      normalize(quoted),
      `${normalize(emitted)} Rows under missing[] had no Spotify id at all: search them by name.`,
      'the documented guidance block has drifted from the string the tools emit',
    );
    assert.doesNotMatch(
      quoted,
      APPROXIMATE_RATE,
      'the documented guidance must not reintroduce the unsourced rate',
    );
  });
});
