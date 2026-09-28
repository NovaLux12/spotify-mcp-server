/**
 * Every `[toolCount, schemaBytes]` figure stated in a manifest comment must
 * equal the baseline on the `manifestEntry` line it describes.
 *
 * The manifest is hand-maintained (AGENTS.md §3) and its comments carry the
 * reasoning behind each number — which issue moved it, by how much, and why.
 * That makes the comments load-bearing, and it makes a stale one a real defect
 * rather than cosmetic: `exhaust2catalog` carried a header reading
 * `[19, 19241]` for a baseline of `[19, 19467]`, left behind when #781 added
 * 226 bytes and the baseline moved without the header. A reader reconciling
 * the two would conclude the baseline was wrong — the comment is the more
 * visible of the pair, and it was the wrong one.
 *
 * The same comments also restate how many modules the manifest holds, in
 * prose, and the pair guard cannot see those: they are not `[n, m]`, so
 * nothing checked them. They drifted for exactly that reason — `annotations.ts`
 * said "all 63 modules" and "a 66-module manifest … the other 65 modules"
 * against a manifest of 70, and mutating all three to 999 left every gate
 * green (#1570 found them by reading, not by a failing test). So the module
 * count is guarded here too, against `REGISTRAR_MANIFEST.length` — the array
 * itself, not a second count parsed out of the same text.
 *
 * This is a source-scanning guard for the same reason `chunk-caps.test.ts` and
 * the explicit-any guard are: the invariant is a property of the file's text,
 * so the cheapest honest check is to read the file. It also covers every
 * comment added later, which a behavioural test could not.
 */
import './helpers/hermetic.js';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REGISTRAR_MANIFEST } from '../src/tools/annotations.js';

const ANNOTATIONS = join(process.cwd(), 'src', 'tools', 'annotations.ts');

type Mismatch = { line: number; key: string; stated: string; actual: string };

/**
 * The full text of a `manifestEntry(...)` call starting at `from`, up to its
 * balanced close.
 *
 * Entries are not all single-line: the self-referential `receipts` entry spans
 * twenty-odd lines because it inlines a registrar. A scanner that reads one
 * line at a time therefore sees a `manifestEntry(` with no baseline and has to
 * give up on it — which is exactly how a guard ends up silently covering less
 * than it appears to.
 */
function callTextFrom(source: string, from: number): string {
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') {
      depth--;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  return source.slice(from);
}

type Scan = { mismatches: Mismatch[]; seen: Set<string> };

function scan(source: string): Scan {
  const found: Mismatch[] = [];
  const seen = new Set<string>();
  // Offsets (not line numbers) so the two coordinate systems cannot drift.
  let pos = 0;
  let commentRun: Array<{ line: number; text: string }> = [];
  let line = 1;

  const lineOf = (offset: number): number => source.slice(0, offset).split('\n').length;

  while (pos < source.length) {
    const nl = source.indexOf('\n', pos);
    const end = nl === -1 ? source.length : nl;
    const text = source.slice(pos, end);
    const trimmed = text.trim();

    if (trimmed.startsWith('//')) {
      commentRun.push({ line, text: trimmed });
    } else if (trimmed === '') {
      // A blank line does not break a comment run; the comments above an entry
      // are routinely separated from it by one.
    } else if (trimmed.startsWith('manifestEntry(')) {
      const call = callTextFrom(source, pos);
      const baseline = call.match(/\[(\d+),\s*(\d+)\]/);
      const key = trimmed.match(/^manifestEntry\('([^']+)'/)?.[1] ?? '<unparsed>';
      seen.add(key);
      if (!baseline) {
        found.push({ line, key, stated: '<no baseline found in call>', actual: '<missing>' });
      } else {
        for (const comment of commentRun) {
          for (const m of comment.text.matchAll(/\[(\d+),\s*(\d+)\]/g)) {
            if (m[0] !== baseline[0]) {
              found.push({ line: comment.line, key, stated: m[0], actual: baseline[0] });
            }
          }
        }
      }
      commentRun = [];
      // Skip past the call so its interior lines are not re-read as top-level.
      pos = pos + call.length;
      line = lineOf(pos);
      continue;
    } else {
      commentRun = [];
    }

    pos = end + 1;
    line++;
  }
  return { mismatches: found, seen };
}

function findMismatches(source: string): Mismatch[] {
  return scan(source).mismatches;
}

test('the scanner actually reaches manifest comments, so it is not vacuous', () => {
  // If the comment-run tracking ever stops, every other test here would pass
  // for the wrong reason. A test that cannot fail is worse than no test
  // (AGENTS.md §6) — so prove the scanner sees the comments it is meant to.
  const source = readFileSync(ANNOTATIONS, 'utf8');
  const commentsWithBaselines = source
    .split('\n')
    .filter((l) => l.trim().startsWith('//') && /\[\d+,\s*\d+\]/.test(l));
  assert.ok(
    commentsWithBaselines.length >= 2,
    `expected at least 2 manifest comments to quote a [n, m] figure, found ${commentsWithBaselines.length}`,
  );

  // And prove it reaches every entry, multi-line ones included.
  const entries = source.match(/^\s*manifestEntry\(/gm) ?? [];
  const seen = scan(source).seen;
  assert.ok(entries.length > 50, `expected a large manifest, found ${entries.length} entries`);
  assert.equal(
    seen.size,
    entries.length,
    `the scanner reached ${seen.size} of ${entries.length} entries; it is not covering the manifest`,
  );
});

test('the scanner parses a baseline out of every manifest entry', () => {
  // The `receipts` entry inlines its registrar and spans many lines. A
  // line-at-a-time scanner reads its `manifestEntry(` as having no baseline,
  // and quietly stops covering it.
  const source = readFileSync(ANNOTATIONS, 'utf8');
  const missing = findMismatches(source).filter((m) => m.actual === '<missing>');
  assert.deepEqual(
    missing.map((m) => `line ${m.line}: ${m.key}`),
    [],
    'every manifestEntry must expose a [toolCount, schemaBytes] the scanner can read',
  );
});

test('every [n, m] quoted in a manifest comment matches its entry baseline', () => {
  const source = readFileSync(ANNOTATIONS, 'utf8');
  const mismatches = findMismatches(source).filter((m) => m.actual !== '<missing>');
  assert.deepEqual(
    mismatches,
    [],
    mismatches.length
      ? mismatches
          .map((m) => `src/tools/annotations.ts:${m.line} quotes ${m.stated} for ${m.key}, but the entry declares ${m.actual}`)
          .join('\n')
      : '',
  );
});

// ---------------------------------------------------------------------------
// Module-count claims
// ---------------------------------------------------------------------------

/**
 * The manifest's real size.
 *
 * Read from the array, not by re-counting `manifestEntry(` in the text it
 * grades. A guard whose expected value is parsed out of the same source it
 * checks is checking its own homework (AGENTS.md §6); the prose and the array
 * have to be independent readings, or a parser that silently stops matching
 * takes the expectation down with the thing it was supposed to catch.
 */
const MODULE_COUNT = REGISTRAR_MANIFEST.length;

type CountClaim = { line: number; stated: number; expected: number; text: string };

/**
 * Every line of a comment in the file, with its 1-based line number.
 *
 * A whole-file pass rather than a reuse of the comment-run tracking above,
 * because a module count is not attached to any one entry — "all 70 modules" is
 * a statement about the manifest as a whole, and the run tracker drops it
 * because no `manifestEntry(` follows. Covering line comments and block-comment
 * bodies is the whole requirement: a count stated in code would be a computed
 * value, not a claim to grade.
 */
function commentLines(source: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let inBlock = false;
  source.split('\n').forEach((raw, index) => {
    const trimmed = raw.trim();
    if (inBlock) {
      if (trimmed.startsWith('*/')) inBlock = false;
      else out.push({ line: index + 1, text: trimmed });
      return;
    }
    if (trimmed.startsWith('/*')) {
      inBlock = true;
      // A block comment may open and say something on one line; only the
      // delimiters are stripped, so the text survives.
      const inner = trimmed.replace(/^\/\*+/, '').replace(/\*+\/$/, '').trim();
      if (inner) out.push({ line: index + 1, text: inner });
      return;
    }
    if (trimmed.startsWith('//')) out.push({ line: index + 1, text: trimmed });
  });
  return out;
}

/**
 * The two shapes a module-count claim takes, and why they need different rules.
 *
 * `all 70 modules` and `70-module manifest` restate the manifest's size, so
 * the stated number is the row count. `the other 69 modules` counts the
 * modules that are *not* the one raising the collision, so it is the row count
 * minus the one being named. That offset is the whole reason the form needs
 * its own rule, and it is why the third claim is the likeliest to drift
 * silently: after a module is added it still reads like a plausible module
 * count, just one short.
 *
 * Deliberately digit-only. "the five other modules" (spelled out) is not
 * caught, and a word-number matcher would have to parse English to cover it;
 * both claims in this file, and every one found across `src/`, use digits.
 */
function findCountClaims(source: string, total: number): CountClaim[] {
  const claims: CountClaim[] = [];
  for (const { line, text } of commentLines(source)) {
    for (const m of text.matchAll(/\b(?:all|every)\s+(\d+)\s+modules?\b/g)) {
      claims.push({ line, stated: Number(m[1]), expected: total, text });
    }
    for (const m of text.matchAll(/\b(\d+)-module\b/g)) {
      claims.push({ line, stated: Number(m[1]), expected: total, text });
    }
    for (const m of text.matchAll(/\bother\s+(\d+)\s+modules?\b/g)) {
      claims.push({ line, stated: Number(m[1]), expected: total - 1, text });
    }
  }
  return claims;
}

/**
 * Rewrite the first occurrence of a claim's number on its own line.
 *
 * Line-scoped so the control below cannot quietly reword a neighbouring
 * number instead of the claim, which would leave the guard correctly silent
 * for the wrong reason — the failure mode a negative control has to rule out.
 */
function bumpClaimNumber(source: string, claim: CountClaim, to: number): string {
  const lines = source.split('\n');
  const at = claim.line - 1;
  lines[at] = lines[at].replace(String(claim.stated), String(to));
  return lines.join('\n');
}

test('the module-count scanner reaches the claims it is meant to guard', () => {
  // If comment tracking or either pattern ever stops, the real-tree test below
  // would pass for the wrong reason. A test that cannot fail is worse than no
  // test (AGENTS.md §6) — so prove the scanner sees the claims, in both shapes.
  const source = readFileSync(ANNOTATIONS, 'utf8');
  const claims = findCountClaims(source, MODULE_COUNT);
  assert.ok(
    claims.length >= 2,
    `expected the manifest comments to restate the module count at least twice, found ${claims.length}`,
  );
  assert.ok(
    claims.some((c) => c.expected === MODULE_COUNT),
    'no claim of the "all N modules" / "N-module manifest" shape was found; one of the two patterns is dead',
  );
  assert.ok(
    claims.some((c) => c.expected === MODULE_COUNT - 1),
    'no claim of the "the other N modules" shape was found; the collision-offset rule is untested',
  );
  // And the comment filter is doing something: the same sentence in code is not
  // a claim about the manifest, and grading it would couple the guard to text
  // it has no business reading.
  assert.deepEqual(
    findCountClaims(`const note = 'all ${MODULE_COUNT} modules are lazy';`, MODULE_COUNT),
    [],
    'a module count outside a comment is not a prose claim',
  );
});

test('a wrong module count in a comment is caught, not read as correct', () => {
  // The issue's own reproduction: mutating all three claims to 999 left every
  // gate green. Drive the comparison with a real claim from the real file, so
  // this fails if the finder, the rule or the total stops mattering — and it
  // exercises the mutation rather than asserting a precomputed answer.
  const source = readFileSync(ANNOTATIONS, 'utf8');
  const claim = findCountClaims(source, MODULE_COUNT)[0];
  assert.ok(claim, 'expected at least one module-count claim to mutate');

  // A value distinct from BOTH what the comment says and what the manifest
  // holds. A hardcoded 999 is not enough: when the tree is already mutated to
  // 999 — which is exactly when this control matters most — the rewrite is a
  // no-op and the control passes for the wrong reason, proving nothing.
  const bogus = [999, 998, 1001, 0, 1].find((n) => n !== claim.stated && n !== claim.expected);
  assert.ok(bogus !== undefined, `no wrong value available for a claim stating ${claim.stated}`);

  const mutated = bumpClaimNumber(source, claim, bogus);
  const moved = findCountClaims(mutated, MODULE_COUNT).find((c) => c.line === claim.line);
  assert.ok(
    moved && moved.stated === bogus,
    `the mutation never reached the claim on line ${claim.line}; the control would pass without testing anything`,
  );
  assert.ok(
    moved.stated !== moved.expected,
    `mutating the claim on line ${claim.line} to ${bogus} should fail against a manifest of ${MODULE_COUNT}, but the guard called it correct`,
  );
});

test('every module count quoted in a manifest comment matches the manifest', () => {
  const source = readFileSync(ANNOTATIONS, 'utf8');
  const wrong = findCountClaims(source, MODULE_COUNT).filter((c) => c.stated !== c.expected);
  assert.deepEqual(
    wrong,
    [],
    wrong.length
      ? wrong
          .map(
            (c) =>
              `src/tools/annotations.ts:${c.line} states ${c.stated} where the manifest holds ${c.expected} — ${c.text}`,
          )
          .join('\n') +
        `\n\nREGISTRAR_MANIFEST holds ${MODULE_COUNT} modules. A comment restating that number is prose a reader reconciles against the array below it; when the two disagree the comment is the wrong one.`
      : '',
  );
});
