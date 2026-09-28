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
 * ## Why the count scan reaches `tests/` and not just this file's subject
 *
 * The three claims in `annotations.ts` were fixed by #1570, but the same drift
 * was still live in `tests/` — `registry-pin.test.ts` carried 66/65 and
 * `lazy-module-loading.test.ts` carried 62, all against a manifest of 70 — and
 * a guard that read only `annotations.ts` would have stayed green over every
 * one of them. A gate that is blind where the defect actually lives is worse
 * than no gate, because it reads as coverage. So the count scan walks all of
 * `src/` and `tests/`. The pair scan above deliberately does NOT widen: a pair
 * belongs to one `manifestEntry` row, and only this file has rows.
 *
 * ## A number that is not a row count
 *
 * Not every "N modules" in the tree counts manifest rows, and a guard that
 * assumes it does will demand a row count and force a CORRECT number to be
 * "fixed" into a wrong one. That failure is worse than a missed claim, so each
 * population is named and either given its own rule or deliberately excluded —
 * see `ROW_COUNT_FORMS`, `ARITY_FORM` and the exclusions below. Every
 * exclusion states what it would take to bring the population back in.
 *
 * This is a source-scanning guard for the same reason `chunk-caps.test.ts` and
 * the explicit-any guard are: the invariant is a property of the file's text,
 * so the cheapest honest check is to read the file. It also covers every
 * comment added later, which a behavioural test could not.
 */
import './helpers/hermetic.js';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { REGISTRAR_MANIFEST } from '../src/tools/annotations.js';

const REPO_ROOT = process.cwd();
const ANNOTATIONS = join(REPO_ROOT, 'src', 'tools', 'annotations.ts');

/** This file. Its doc comment quotes the claim shapes as examples, including
 *  the historical 63/66/65, so grading it by the rules it documents would have
 *  the guard red on its own explanation. Everything else is in scope. */
const SELF = 'tests/manifest-comment-baseline.test.ts';

function tsFilesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsFilesUnder(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Every `.ts` file the module-count claims are graded in, minus this one. */
const COUNT_SCOPE: string[] = [...tsFilesUnder(join(REPO_ROOT, 'src')), ...tsFilesUnder(join(REPO_ROOT, 'tests'))]
  .map((file) => relative(REPO_ROOT, file))
  .filter((file) => file !== SELF)
  .sort();

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
 * modules that are *not* the one named, so it is the row count minus that one.
 *
 * ## Why "the other N modules" accepts two numbers
 *
 * The phrase is grammatically identical in two claims that count different
 * things, and only the surrounding sentence tells them apart:
 *
 *   - `annotations.ts` — "which of the other 69 modules owns the name", in a
 *     duplicate-registration report. One module is named, so the rest is
 *     `total - 1`.
 *   - `registry-pin.test.ts` — "the first four manifest modules; the other 62
 *     modules' names are unasserted". The complement is the core-first prefix,
 *     so it is `total - CORE_FIRST_PREFIX`.
 *
 * Picking either single reading forces the other claim to be "fixed" into a
 * wrong number — the same failure as the arity population below, and worse,
 * because the phrase looks unambiguous. Accepting both legitimate readings
 * costs almost nothing in strictness: the pair is two apart (69 and 66), so a
 * drifted 62 or 65 is still caught, which is the case that actually happened.
 * A discriminator that reads the preceding line for "first four" would be
 * tighter but couples the guard to a sentence it would have to re-parse.
 *
 * Deliberately digit-only. "the five other modules" (spelled out, in
 * `annotations.ts`) is not caught; a word-number matcher would have to parse
 * English to cover it, and every claim in scope uses digits.
 */
function findCountClaims(source: string, total: number): CountClaim[] {
  const claims: CountClaim[] = [];
  for (const { line, text } of commentLines(source)) {
    for (const m of text.matchAll(/\b(?:all|every)\s+(\d+)\s+modules?\b/g)) {
      claims.push({ line, stated: Number(m[1]), expected: [total], text });
    }
    // `N-module` is only a row count when the noun is the manifest. The bare
    // form also catches "the 4-module core-first name prefix" in
    // `registry-pin.test.ts`, which is CORRECT and would be rewritten to 70.
    // Requiring "manifest" trades a little recall — a row-count claim split
    // across a line break would escape — for never forcing a right number
    // wrong, which is the worse failure. Widen it if such a claim ever lands.
    for (const m of text.matchAll(/\b(\d+)-module\s+manifest\b/g)) {
      claims.push({ line, stated: Number(m[1]), expected: [total], text });
    }
    for (const m of text.matchAll(/\bother\s+(\d+)\s+modules?\b/g)) {
      claims.push({
        line,
        stated: Number(m[1]),
        expected: [total - 1, total - CORE_FIRST_PREFIX],
        text,
      });
    }
  }
  return claims;
}

/**
 * The manifest's own size, measured from the array rather than re-counted out
 * of the text being graded. A guard whose expectation is parsed from the same
 * source it checks is checking its own homework (AGENTS.md §6).
 */
const MODULE_COUNT = REGISTRAR_MANIFEST.length;

/**
 * How many modules `tool.surface.test.ts` pins names for in the core-first
 * prefix (`search`, `catalog`, `library`, `playback`).
 *
 * Hand-maintained in two places, deliberately not merged: that test slices
 * `REGISTRAR_MANIFEST.slice(0, 4)`, and AGENTS.md §4 names the same four.
 * Reading the 4 out of the other test instead would make this expectation
 * depend on a slice literal in a file about something else — and if the prefix
 * ever changes, a guard that went red on BOTH would be one signal, not two
 * that could be resolved independently.
 */
const CORE_FIRST_PREFIX = 4;

/**
 * A claim's stated number, and the numbers the rule permits for it.
 *
 * `expected` is a list rather than a single value because "the other N
 * modules" has two legitimate readings (see `findCountClaims`). A single
 * `expected` would be the more honest shape if the phrase had one meaning.
 */
type CountClaim = { line: number; stated: number; expected: number[]; text: string };

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

// ---------------------------------------------------------------------------
// The registrar-arity population — NOT a row count
// ---------------------------------------------------------------------------

/**
 * How many manifest modules hand their registrar a `SpotifyClient`.
 *
 * This is a different population from the manifest row count, and conflating
 * them is the trap this file is most careful about. `lazy-module-loading.test.ts`
 * describes "the 62 modules taking a `SpotifyClient`", and that is neither
 * `total` (70) nor `total - 1` (69): it is 66. `statsfm` takes a
 * `StatsfmClient`; `swarm3meta` and `moodexpand` take no second parameter at
 * all; `receipts` is a local registrar with no exported signature to read. So
 * 66 + 2 + 1 + 1 = 70. Applying the row-count grammar here would demand 69 and
 * force a CORRECT 66 to be "fixed" into a wrong 69.
 *
 * `annotations.ts` states the same decomposition independently — "three
 * registrars take no client at all … and one takes a `StatsfmClient`" — which
 * is the cross-check that 66 is the right number and not 68. Counting the two
 * no-client modules as client-takers, which the loop's `else` branch does if
 * read as a tally rather than as a predicate, yields 68 and is wrong: a
 * registrar that takes no client does not take a SpotifyClient.
 *
 * So this population gets its own assertion and its own rule, and
 * `ARITY_FORM` is deliberately narrow enough that no row-count claim can match
 * it.
 *
 * The loop MIRRORS the one in `lazy-module-loading.test.ts` rather than
 * importing it, because that is the definition the prose is describing. If the
 * test's rule ever changes, this count changes with it and the guard goes red
 * — which is the right outcome, because the prose would then be describing a
 * population this no longer computes. The duplication is load-bearing and
 * deliberate; the two must move together.
 */
const ARITY_FORM = /\b(\d+)\s+modules\s+taking\s+a\s+`?SpotifyClient/g;

function arityPopulation(): number {
  let takes = 0;
  for (const module of REGISTRAR_MANIFEST) {
    if (!module.file.startsWith('src/tools/')) continue;
    const source = readFileSync(join(REPO_ROOT, module.file), 'utf8');
    const signature = new RegExp(`export (?:async )?function ${module.name}\\s*\\(([^)]*)\\)`).exec(source);
    if (!signature) continue; // a local registrar (receipts) — no signature to read
    const params = signature[1].split(',').map((part) => part.trim()).filter(Boolean);
    const takesSpotifyClient = params.length >= 2 && /^_?client\??\s*:\s*SpotifyClient/.test(params[1]);
    if (takesSpotifyClient) takes++;
  }
  return takes;
}

type ArityClaim = { file: string; line: number; stated: number; text: string };

function findArityClaims(): ArityClaim[] {
  const found: ArityClaim[] = [];
  for (const file of COUNT_SCOPE) {
    for (const { line, text } of commentLines(readFileSync(join(REPO_ROOT, file), 'utf8'))) {
      for (const m of text.matchAll(ARITY_FORM)) {
        found.push({ file, line, stated: Number(m[1]), text });
      }
    }
  }
  return found;
}

test('the module-count scanner reaches the claims it is meant to guard', () => {
  // If comment tracking or any pattern ever stops, the tests below would pass
  // for the wrong reason. A test that cannot fail is worse than no test
  // (AGENTS.md §6) — so prove the scanner sees the claims, in every shape.
  assert.ok(COUNT_SCOPE.length > 100, `expected a wide scan, found ${COUNT_SCOPE.length} files`);
  assert.ok(
    !COUNT_SCOPE.includes(SELF),
    'the guard must not grade its own doc comment, which quotes claim shapes as examples',
  );
  assert.ok(
    COUNT_SCOPE.some((f) => f.startsWith('tests/')),
    'the scan must reach tests/ — every claim that was still stale lived there',
  );

  const claims = COUNT_SCOPE.flatMap((file) =>
    findCountClaims(readFileSync(join(REPO_ROOT, file), 'utf8'), MODULE_COUNT).map((c) => ({ ...c, file })),
  );
  assert.ok(
    claims.length >= 4,
    `expected several row-count claims across src/ and tests/, found ${claims.length}`,
  );
  assert.ok(
    claims.some((c) => c.expected.length === 1 && c.expected[0] === MODULE_COUNT),
    'no claim of the "all N modules" / "N-module manifest" shape was found; one of the two patterns is dead',
  );
  assert.ok(
    claims.some((c) => c.expected.length === 2),
    'no claim of the "the other N modules" shape was found; the two-reading rule is untested',
  );
  // The arity population is reached by its own form, and the row-count grammar
  // must NOT swallow it — that overlap is the misgrading trap.
  assert.ok(findArityClaims().length >= 1, 'the registrar-arity claim is no longer found; its rule is untested');
  assert.deepEqual(
    findCountClaims('// the 68 modules taking a `SpotifyClient`', MODULE_COUNT),
    [],
    'the arity population must not match the row-count grammar',
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
  // The issue's own reproduction: mutating the claims to 999 left every gate
  // green. Drive the comparison with real claims from real files — one in
  // `src/` and one in `tests/`, so the widened scan is exercised on both sides
  // — and mutate rather than assert a precomputed answer.
  const targets = [
    { file: 'src/tools/annotations.ts', single: true },
    { file: 'tests/registry-pin.test.ts', single: false },
  ];
  for (const { file, single } of targets) {
    const source = readFileSync(join(REPO_ROOT, file), 'utf8');
    const claim = findCountClaims(source, MODULE_COUNT).find((c) => c.expected.length === (single ? 1 : 2));
    assert.ok(claim, `expected a ${single ? 'row-count' : 'complement'} claim in ${file} to mutate`);

    // A value distinct from BOTH what the comment says and every number the
    // rule permits. A hardcoded 999 is not enough: when the tree is already
    // mutated to 999 — which is when this control matters most — the rewrite is
    // a no-op and the control passes for the wrong reason, proving nothing.
    const bogus = [999, 998, 1001, 0, 1].find((n) => n !== claim.stated && !claim.expected.includes(n));
    assert.ok(bogus !== undefined, `no wrong value available for a claim stating ${claim.stated}`);

    const mutated = bumpClaimNumber(source, claim, bogus);
    const moved = findCountClaims(mutated, MODULE_COUNT).find((c) => c.line === claim.line);
    assert.ok(
      moved && moved.stated === bogus,
      `the mutation never reached the ${file} claim on line ${claim.line}; the control would pass without testing anything`,
    );
    assert.ok(
      !moved.expected.includes(moved.stated),
      `mutating the ${file} claim on line ${claim.line} to ${bogus} should fail against a manifest of ${MODULE_COUNT}, but the guard called it correct`,
    );
  }
});

test('every module count quoted in a comment matches the manifest', () => {
  const wrong = COUNT_SCOPE
    .flatMap((file) =>
      findCountClaims(readFileSync(join(REPO_ROOT, file), 'utf8'), MODULE_COUNT).map((c) => ({ ...c, file })),
    )
    .filter((c) => !c.expected.includes(c.stated));
  assert.deepEqual(
    wrong,
    [],
    wrong.length
      ? wrong
          .map(
            (c) =>
              `${c.file}:${c.line} states ${c.stated}, which counts ${c.expected.join(' or ')} — ${c.text}`,
          )
          .join('\n') +
        `\n\nREGISTRAR_MANIFEST holds ${MODULE_COUNT} modules and the core-first prefix is ${CORE_FIRST_PREFIX}. A comment restating either number is prose a reader reconciles against the array; when the two disagree the comment is the wrong one.`
      : '',
  );
});

test('the registrar-arity claim counts its own population, not manifest rows', () => {
  // Its own assertion rather than an exclusion, because the claim is a real
  // drifted instance of the same defect class (it said 62 against 68) and an
  // exclusion comment would document a hole instead of closing it.
  const claims = findArityClaims();
  assert.ok(claims.length >= 1, 'expected the registrar-arity claim to still exist');
  const expected = arityPopulation();
  const wrong = claims.filter((c) => c.stated !== expected);
  assert.deepEqual(
    wrong,
    [],
    wrong.length
      ? wrong
          .map(
            (c) =>
              `${c.file}:${c.line} states ${c.stated} modules take a \`SpotifyClient\`, but ${expected} do — ${c.text}`,
          )
          .join('\n') +
        `\n\nThis population is NOT a manifest row count: \`statsfm\` takes a \`StatsfmClient\` and \`receipts\` is a local registrar with no signature, so ${expected} + 1 + 1 = ${MODULE_COUNT}. Applying the row-count rule here would force a correct number to be rewritten.`
      : '',
  );
});
