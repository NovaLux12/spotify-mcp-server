/**
 * #1332 — a comment must not restate a live constant's value.
 *
 * `annotations.ts` is a decision log, and most of its byte figures are supposed
 * to be there: *"measured on this tree at b8fa661, 607,715B"* records a pinned
 * tree, and refreshing it would falsify the figure it qualifies. The problem is
 * the other shape — `` `perToolMaxBytes` (6,000B) `` — which asserts what a
 * constant *is now*. It was correct when written; raise the constant and the
 * prose silently becomes false, and nothing re-derives it. `check-doc-tool-counts.mjs`
 * does not see these: it looks for registry-scale tool counts, not byte figures.
 *
 * The anchoring test is applied PER SENTENCE, never by pattern, because
 * `annotations.ts` is one comment block in which a decision log and a
 * present-tense quote sit a few lines apart. Anchoring the whole block would
 * let `:307` hide behind a warrant sentence; anchoring nothing at all would
 * fail fifteen legitimate records. `ALLOWED` below is deliberately small and
 * exists for the records whose anchor lives in an adjacent sentence.
 *
 * Two-sided on purpose (§6): a guard whose negative case was never run is the
 * thing §6 warns about twice, so `detector accepts and rejects` drives the
 * comparison directly rather than asserting a precomputed answer.
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskToComments } from '../scripts/check-doc-tool-counts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Smallest figure worth a gate. Below this, a collision is arithmetic coincidence. */
const FIGURE_FLOOR = 1_000;

/**
 * A byte-denominated figure: a number immediately followed by a byte unit.
 *
 * The `B` requirement is what keeps this from flagging every year in the tree
 * (`2026` collides with a literal in `markets.ts`), every `ISO 3166-1` mention,
 * and port `8888`. Unqualified numbers are not byte figures and are not claims
 * about a byte budget.
 */
const BYTE_FIGURE = /(\d{1,3}(?:[,_]\d{3})+|\d+)\s*(B\b|bytes?\b|byte\b|KB\b|kB\b|MB\b|GB\b|KiB\b|MiB\b)/g;

/**
 * A comment sentence anchored to a dated tree — a commit sha, the phrasing the
 * decision logs use (`measured`), or a warrant/grant ANNOUNCEMENT.
 *
 * The sha arm requires a digit as well as hex letters, because a bare `[0-9a-f]{7}`
 * also matches English (`defaced`, `facaded`) and a false anchor exempts a real
 * defect. Git shas essentially always contain a digit; hex-only words never do.
 *
 * WHY `warrant`/`grant` NEED A COLON (#1332). The bare word was an anchor, and
 * that is what let the defect through: "sits inside the 620,000B carried by
 * WARRANT SWEEP-2026-09 above" names a warrant in order to *cross-reference*
 * one, and the gate read the name as proof the sentence was dated. It was
 * correct by accident — the sentence sits twelve lines from a real warrant
 * header, and the word did the work the header should have done. Cross-reference
 * and announcement are opposite claims, so they get opposite arms: a warrant
 * anchors a figure only where it *opens* one (`WARRANT SWEEP-2026-09: …`), which
 * is the shape every genuine record in the file already has.
 *
 * Measured rather than assumed, on this tree, `620_000` included: the bare-word
 * anchor found 0 unanchored figures and the colon arm finds 2 — this sentence
 * and the `10,000B` coincidence at `:273`, which is an unrelated `max(10000)`
 * in `exhaust2_misc.ts` and earns an `ALLOWED` entry. Dropping the arm outright
 * was measured too and is not cheaper: it flags the same 2 plus nothing, but it
 * would also strip the anchor from every `WARRANT #866:`-shaped record, and
 * those are records this file exists to keep. The colon is the narrower change.
 */
const DATED_TREE = /\b(?:measured|re-?measur\w*|measuring)\b|(?:warrant|grant)s?\b[^.:;]{0,24}:|(?<![0-9a-z])[0-9a-f]*[0-9][0-9a-f]{6,39}(?![0-9a-z])/i;

/**
 * Records the anchoring test cannot reach, because the sentence carrying the
 * date marker is a *neighbour* of the one holding the figure.
 *
 * Each entry is a decision to re-read, not a permanent pardon: an entry whose
 * text no longer appears fails as a dead allowance, so deleting or rewording
 * one of these lines asks the question again.
 */
const ALLOWED: { file: string; contains: string; why: string }[] = [
  {
    file: 'src/tools/annotations.ts',
    contains: 'and the first raise was 19x its warrant',
    why:
      'NOT a live-constant quote, and the collision is arithmetic coincidence: this is the record of the 19x over-raise the CORRECTIONS note is about, while the 10_000 it matches is `max(10000)` on `min_hours` (backlog hours) in `exhaust2_misc.ts` — a queue-depth bound with no relationship to a byte budget. Surfaced only by the narrowed `warrant` anchor in #1332; the figure is frozen history, so it stays.',
  },
];

/** `620,000` and `620_000` are the same value; so are `64 000` and `64000`. */
function normalise(figure: string): number {
  return Number(figure.replace(/[,_]/g, ''));
}

function byteFigures(
  text: string,
  pattern: RegExp = BYTE_FIGURE,
  floor: number = FIGURE_FLOOR,
): { value: number; raw: string }[] {
  const out: { value: number; raw: string }[] = [];
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const value = normalise(match[1]);
    if (Number.isFinite(value) && value >= floor) out.push({ value, raw: match[1] });
  }
  return out;
}

/** Contiguous runs of comment lines, prefix stripped, with the line each starts on. */
function commentBlocks(source: string): { startLine: number; lines: string[] }[] {
  const blocks: { startLine: number; lines: string[] }[] = [];
  let current: { startLine: number; lines: string[] } | null = null;
  let inBlockComment = false;

  source.split('\n').forEach((line, index) => {
    const trimmed = line.trimStart();
    const opensBlock = trimmed.startsWith('/*');
    const isComment = inBlockComment || opensBlock || trimmed.startsWith('//') || trimmed.startsWith('*');
    if (!isComment) {
      current = null;
      inBlockComment = false;
      return;
    }
    if (opensBlock) inBlockComment = !trimmed.includes('*/');
    else if (trimmed.startsWith('*/')) inBlockComment = false;

    if (!current) {
      current = { startLine: index + 1, lines: [] };
      blocks.push(current);
    }
    const prefix = /^\s*(?:\/\*|\/\/|\*)\/?\s?/.exec(line);
    current.lines.push(prefix ? line.slice(prefix[0].length) : line);
  });
  return blocks;
}

export interface Quote {
  file: string;
  line: number;
  figure: string;
  value: number;
  definedAt: string[];
  sentence: string;
}

/**
 * A comment block split into sentences, each carrying the line it starts on.
 *
 * Terminators are `.` and `;` only. A colon is not a sentence terminator in
 * prose — it introduces a list, which in this tree is exactly where the date
 * marker sits ("… rather than carried over from a pre-rebase branch:
 * exhaust2playback 17,306 -> 17,683B") — and splitting on it strands the list
 * from the "Measured" that qualifies it.
 */
const SENTENCE_TERMINATOR = /(?<=[.;])\s+/g;

function blockSentences(block: { startLine: number; lines: string[] }): { text: string; line: number }[] {
  const joined = block.lines.join('\n');
  const out: { text: string; line: number }[] = [];
  let cursor = 0;
  let line = block.startLine;

  SENTENCE_TERMINATOR.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SENTENCE_TERMINATOR.exec(joined)) !== null) {
    const end = match.index + match[0].length;
    out.push({ text: joined.slice(cursor, match.index), line });
    line += countNewlines(joined.slice(cursor, end));
    cursor = end;
  }
  const tail = joined.slice(cursor);
  if (tail.trim()) out.push({ text: tail, line });
  return out;
}

function countNewlines(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') count += 1;
  return count;
}

/**
 * Every comment figure that restates a value a constant in the same tree also
 * defines, minus the ones anchored to a dated tree.
 *
 * The comment/code split reuses `maskToComments`, the helper the sibling
 * `check-doc-tool-counts.mjs` gate already uses, rather than a second lexer:
 * a digit run that survives masking is comment text, one that was blanked to
 * spaces is a code literal. Two homes for one rule is the defect this test exists
 * to catch, so it does not get one.
 */
export function findLiveConstantQuotes(
  files: { path: string; source: string }[],
  allowed: { file: string; contains: string; why: string }[] = ALLOWED,
  datedTree: RegExp = DATED_TREE,
  figurePattern: RegExp = BYTE_FIGURE,
  figureFloor: number = FIGURE_FLOOR,
): { quotes: Quote[]; deadAllowances: string[] } {
  const codeValues = new Map<number, string[]>();
  const quotes: Quote[] = [];
  const allowanceHits = new Set<string>();

  // TWO PASSES, and the first one is not an optimisation. Harvesting constants
  // and scanning comments in the same loop iteration makes the result depend on
  // file order: `shaping.ts` is walked before `annotations.ts`, so the moment
  // `defaultMaxBytes: 620_000` has not been read yet, and a comment quoting
  // 620,000B reads as clean. That is the failure this whole gate exists to
  // catch, reproduced inside the gate — the first draft of this file had it, and
  // a test run against the unfixed tree said "all clear" while sitting on the
  // defect. Every constant in the tree is therefore known before any comment is
  // read.
  for (const { path, source } of files) {
    const masked = maskToComments(source);
    const digits = /\d[\d,_]*/g;
    let match: RegExpExecArray | null;
    while ((match = digits.exec(source)) !== null) {
      const value = normalise(match[0]);
      if (!Number.isFinite(value) || value < figureFloor) continue;
      const survived = /\d/.test(masked.slice(match.index, match.index + match[0].length));
      if (survived) continue; // comment text, judged in the second pass
      const line = source.slice(0, match.index).split('\n').length;
      const sites = codeValues.get(value) ?? [];
      sites.push(`${path}:${line}`);
      codeValues.set(value, sites);
    }
  }

  for (const { path, source } of files) {
    for (const block of commentBlocks(source)) {
      // Sentences, not lines: a figure and the date marker qualifying it are
      // routinely a line apart, and a line-scoped test flags the second without
      // ever seeing the first. The block is joined first so a sentence that
      // wraps is one unit, then split on the terminator with offsets walked
      // explicitly — a map/reduce over per-line splits would cut a wrapped
      // sentence back apart and lose the anchor sitting on its first line.
      for (const sentence of blockSentences(block)) {
        if (datedTree.test(sentence.text)) continue;
        for (const figure of byteFigures(sentence.text, figurePattern, figureFloor)) {
          const definedAt = codeValues.get(figure.value);
          if (!definedAt) continue;
          const text = sentence.text.trim();
          const allowance = allowed.find((a) => a.file === path && text.includes(a.contains));
          if (allowance) {
            allowanceHits.add(`${path} ${allowance.contains}`);
            continue;
          }
          quotes.push({ file: path, line: sentence.line, figure: figure.raw, value: figure.value, definedAt, sentence: text });
        }
      }
    }
  }

  const deadAllowances = allowed
    .filter((a) => !allowanceHits.has(`${a.file} ${a.contains}`))
    .map((a) => `${a.file}: ${a.contains}`);

  return { quotes, deadAllowances };
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('#1332 — comments must not restate a live constant', () => {
  it('finds no unanchored comment figure that a constant also defines', () => {
    const files = sourceFiles(join(ROOT, 'src')).map((path) => ({
      path: path.slice(ROOT.length + 1),
      source: readFileSync(path, 'utf8'),
    }));
    assert.ok(files.length > 20, `expected the src/ tree, scanned ${files.length} files`);

    const { quotes, deadAllowances } = findLiveConstantQuotes(files);
    assert.deepEqual(
      deadAllowances,
      [],
      'allowance no longer matches anything — delete it or re-read the line it covered',
    );
    assert.deepEqual(
      quotes.map((q) => `${q.file}:${q.line} ${q.figure} (also defined at ${q.definedAt[0]})\n    ${q.sentence}`),
      [],
      'a comment restates a live constant; name the constant and point at its home instead',
    );
  });

  it('has no allowance that names a figure the tree no longer carries', () => {
    // The figure each allowance excuses must still exist, or the record it
    // protects is gone and the exemption is hiding a different line.
    const annotations = readFileSync(join(ROOT, 'src/tools/annotations.ts'), 'utf8');
    for (const entry of ALLOWED.filter((a) => a.file.endsWith('annotations.ts'))) {
      assert.ok(annotations.includes(entry.contains), `allowance text missing from annotations.ts: ${entry.contains}`);
    }
  });
});

describe('#1332 — the detector can actually reject', () => {
  const CEILING = 'export const CEIL = 620_000;';

  it('flags a present-tense quote of a live constant', () => {
    const { quotes } = findLiveConstantQuotes([
      { path: 'src/quote.ts', source: `// \`CEIL\` (620,000B) is a ONE-TIME cost.\n${CEILING}\n` },
    ]);
    assert.equal(quotes.length, 1);
    assert.equal(quotes[0].value, 620_000);
    assert.equal(quotes[0].figure, '620,000');
  });

  it('normalises 620,000 in prose against 620_000 in code', () => {
    // The reason the gate exists: the two spellings differ, the value does not.
    const { quotes } = findLiveConstantQuotes([
      { path: 'src/quote.ts', source: `// the budget is 620,000B today.\n${CEILING}\n` },
    ]);
    assert.equal(quotes.length, 1, '620,000 in prose must collide with 620_000 in code');
  });

  it('catches a cross-file quote even when the constant sorts later', () => {
    // Regression for an ordering bug in this file's first draft: constants were
    // harvested and comments scanned in the same loop iteration, so a figure
    // defined in a file read AFTER the comment was invisible. `aaa.ts` < `zzz.ts`
    // is the whole shape of it. The run against the unfixed tree reported clean
    // while `shaping.ts:685` was sitting right there.
    const { quotes } = findLiveConstantQuotes([
      { path: 'src/aaa.ts', source: '// - `BUDGET.ceiling` (620,000B) is a ONE-TIME cost.\nexport const X = 1;\n' },
      { path: 'src/zzz.ts', source: 'export const BUDGET = { ceiling: 620_000 };\n' },
    ]);
    assert.equal(quotes.length, 1, 'a constant in a later-sorted file must still be visible');
    assert.equal(quotes[0].file, 'src/aaa.ts');
    assert.deepEqual(quotes[0].definedAt, ['src/zzz.ts:1']);
  });

  it('does not flag the same figure once it is anchored to a dated tree', () => {
    const { quotes } = findLiveConstantQuotes([
      { path: 'src/log.ts', source: `// measured on this tree at b8fa661: 620,000B.\n${CEILING}\n` },
    ]);
    assert.deepEqual(quotes, []);
  });

  it('accepts a warrant ANNOUNCEMENT, which is a dated record', () => {
    // The half of the warrant anchor that earns its keep: `WARRANT #866: +112B, …`
    // opens a record and the figure belongs to it. Narrowing the arm to a colon
    // must not cost these, or the gate would push every warrant header in
    // `annotations.ts` into `ALLOWED` — which is the allowlist-growth trap the
    // header warns about, reached by the opposite road.
    const { quotes } = findLiveConstantQuotes([
      { path: 'src/log.ts', source: `// WARRANT SWEEP-2026-09: 620,000B carried by the sweep grant.\n${CEILING}\n` },
      { path: 'src/log2.ts', source: `// GRANT BACKFILL-2026-09: +620,000B reclaimed from prose.\n${CEILING}\n` },
    ]);
    assert.deepEqual(quotes, [], 'a warrant header is a record, not a cross-reference');
  });

  it('flags a warrant CROSS-REFERENCE that hides a live constant', () => {
    // #1332, second instance. The shipped gate read the word "WARRANT" in this
    // sentence as proof it was dated, so the gate passed the defect it was
    // written for: the sentence points at a warrant, and in doing so quotes the
    // constant that warrant set. It is the *named* warrant doing the exempting,
    // which is the whole defect — the name is a pointer, not a date.
    const { quotes } = findLiveConstantQuotes([
      { path: 'src/log.ts', source: `// sits inside the 620,000B carried by WARRANT SWEEP-2026-09 above.\n${CEILING}\n` },
    ]);
    assert.equal(quotes.length, 1, 'a cross-reference must not exempt a live constant');
    assert.equal(quotes[0].figure, '620,000');
  });

  it('keeps the gate clean on the real file — a reintroduction would fail here', () => {
    // Binds the narrowed anchor to the tree rather than to a fixture, so the
    // `annotations.ts:250` sentence cannot come back wearing the old wording.
    // The `deadAllowances` check covers the other direction: an allowance whose
    // text is gone fails too, so neither the defect nor the pardon can rot.
    //
    // The WHOLE `src/` tree, not just `annotations.ts`: the `10,000B` collision
    // this allowance covers is defined in `exhaust2_misc.ts`, so scanning one
    // file leaves every allowance dead and fails for the wrong reason. A test
    // that goes red on a technicality teaches the reader to ignore red.
    const files = sourceFiles(join(ROOT, 'src')).map((path) => ({
      path: path.slice(ROOT.length + 1),
      source: readFileSync(path, 'utf8'),
    }));
    const { quotes, deadAllowances } = findLiveConstantQuotes(files, ALLOWED);
    assert.deepEqual(deadAllowances, []);
    assert.deepEqual(
      quotes.map((q) => `${q.file}:${q.line} ${q.figure} — ${q.sentence}`),
      [],
      'a comment in src/ restates a live constant',
    );
    const annotations = readFileSync(join(ROOT, 'src/tools/annotations.ts'), 'utf8');
    assert.ok(
      !/620,000B carried by WARRANT/.test(annotations),
      'the cross-reference sentence from #1332 is back',
    );
  });

  it('ignores a figure no constant defines, and an unqualified number', () => {
    const { quotes } = findLiveConstantQuotes([
      { path: 'src/other.ts', source: '// measured 999,999B on a tree nobody pinned.\nexport const X = 620_000;\n' },
      { path: 'src/year.ts', source: '// February 2026 changelog removed the field.\nexport const Y = 2026;\n' },
    ]);
    assert.deepEqual(quotes, []);
  });

  it('reports an allowance whose line is gone as dead', () => {
    const { deadAllowances } = findLiveConstantQuotes(
      [{ path: 'src/quote.ts', source: `// nothing to see here.\n${CEILING}\n` }],
      [{ file: 'src/quote.ts', contains: 'a line that was deleted', why: 'stale' }],
    );
    assert.deepEqual(deadAllowances, ['src/quote.ts: a line that was deleted']);
  });
});

/**
 * #1350 — why the shipped pattern has no `%` arm.
 *
 * The reasoning lives in `annotations.ts` as a decision record, and a decision
 * record that nothing can check is the same rot this file exists to stop: raise
 * `FIGURE_FLOOR` or widen `BYTE_FIGURE` and the prose's claim that widening does
 * not help goes quietly false. So the claim is driven here instead of trusted.
 *
 * The counterfactual is a REGEX, not a guess at intent. These do not assert
 * that widening is bad forever; they assert that TODAY's evidence says so, and
 * they fail loudly when the evidence moves. The last test in the block is the
 * regression test for the fix itself and is the only one that goes red when
 * `annotations.ts` is reverted — the first four describe why the fix was the
 * right shape, and a suite in which all of them passed on the unfixed tree
 * would be the §6 failure this repository keeps making.
 */
describe('#1350 — the % arm was measured, declined, and the reason is executable', () => {
  /** The proposed widening: byte units plus a percent sign. */
  const WITH_PERCENT =
    /(\d{1,3}(?:[,_]\d{3})+|\d+(?:\.\d+)?)\s*(B\b|bytes?\b|byte\b|KB\b|kB\b|MB\b|GB\b|KiB\b|MiB\b|%)/g;

  it('the shipped pattern has no % arm — the coverage hole is real, not a misreading', () => {
    // Bound to the PATTERN, not to the detector's verdict. The first draft of
    // this test drove `findLiveConstantQuotes` and asserted "no quotes", which
    // stayed green when a `%` arm was actually added to `BYTE_FIGURE` — the
    // floor swallows the difference, so it could not tell a widened detector
    // from an unwidened one and proved nothing (verified by mutation). Asserting
    // on the regex itself is the only way this goes red on a widening.
    assert.ok(
      !BYTE_FIGURE.source.includes('%'),
      'BYTE_FIGURE has gained a % arm — re-measure the #1350 decision record in annotations.ts against the new pattern',
    );
    // The unit really is the discriminator, not a general blindness: with the
    // floor dropped so a figure can qualify at all, a byte unit matches and a
    // percent sign does not.
    assert.equal(byteFigures('620,000B', BYTE_FIGURE, 0).length, 1, 'the byte arm must still match');
    assert.equal(byteFigures('2.1%', BYTE_FIGURE, 0).length, 0, 'the shipped pattern must not match a percentage');
    assert.equal(byteFigures('2.1%', WITH_PERCENT, 0).length, 1, 'the proposed widening would match it — that is the change being declined');
  });

  it('a % arm would not have caught the figure it was added for', () => {
    // The load-bearing measurement. `FIGURE_FLOOR` is 1,000 and a percentage is
    // structurally below it, so a % arm cannot match the 2.1% that motivated the
    // change. The numerator here IS a live constant and the percentage is in an
    // unanchored sentence, so the only reason it goes uncaught is the floor.
    const { quotes } = findLiveConstantQuotes(
      [
        { path: 'src/a.ts', source: '// the surface would have to grow 2.1% to breach.\n' },
        { path: 'src/b.ts', source: 'export const CEIL = 620_000;\nexport const NARROW = 2.1;\n' },
      ],
      [],
      DATED_TREE,
      WITH_PERCENT,
    );
    assert.deepEqual(quotes, [], '2.1 IS a constant and 620,000B matches, yet nothing was caught — re-measure the record');
  });

  it('a % arm reaches only arithmetic coincidence, which is why it was declined', () => {
    // The cost side, on a shape that actually appears in `src/`. The floor is
    // dropped to 0 HERE and only here: at the shipped floor a `%` arm is inert
    // (the previous test), and these collisions are what appears the moment
    // someone lowers the floor to make it work. `0%` is innocent prose whose
    // integer happens to equal a `0` literal in unrelated code, and each hit
    // would need an ALLOWED entry — the allowlist growth the record cites.
    // Asserted rather than assumed, so "coincidence" stays a measured property
    // of this tree and not a belief in a comment.
    const { quotes } = findLiveConstantQuotes(
      [
        { path: 'src/a.ts', source: '// trims 0% of the tools without shrinking startup.\n' },
        { path: 'src/b.ts', source: 'export const M = Math.max(0, 1);\n' },
      ],
      [],
      DATED_TREE,
      WITH_PERCENT,
      0,
    );
    assert.equal(quotes.length, 1, 'expected exactly the 0% coincidence');
    assert.equal(quotes[0].value, 0);
  });

  it('at the shipped floor a % arm is inert on the same tree', () => {
    // The control for the test above, and the reason the floor is not simply
    // lowered: with `FIGURE_FLOOR` intact the widened pattern finds nothing at
    // all. A wider net that must also dismantle the floor to find anything is
    // not a wider net.
    const { quotes } = findLiveConstantQuotes(
      [
        { path: 'src/a.ts', source: '// trims 0% of the tools without shrinking startup.\n' },
        { path: 'src/b.ts', source: 'export const M = Math.max(0, 1);\n' },
      ],
      [],
      DATED_TREE,
      WITH_PERCENT,
    );
    assert.deepEqual(quotes, [], 'a % arm at the shipped floor must find nothing here');
  });

  it('the SWEEP-2026-09 block states the mechanism, not a derived figure', () => {
    // The regression test for the fix itself, and the only test here that goes
    // red when `annotations.ts` is reverted. The others pin the REASONING; those
    // pass on the unfixed tree, which is precisely the "a test that cannot fail"
    // shape §6 warns about. This one reads the actual comment.
    const annotations = readFileSync(join(ROOT, 'src/tools/annotations.ts'), 'utf8');
    const start = annotations.indexOf('WARRANT SWEEP-2026-09:');
    const sweep = annotations.slice(start, annotations.indexOf('defaultMaxBytes: 620_000'));
    assert.ok(sweep.length > 0, 'could not locate the SWEEP-2026-09 block');

    // 1. No present-tense open-issue tally. Scoped to the SWEEP block, because
    // the distinction that matters is exactly this one: a DATED count in the
    // decision log is legitimate, a present-tense one is not.
    assert.ok(
      !/\b\d[\d,_]*\s+open issues?\b/i.test(sweep),
      'the SWEEP block carries a present-tense open-issue tally — the figure #1350 removed cannot come back',
    );
    // 2. No derived growth percentage — the sentence the fix rewrote.
    assert.ok(
      !/would have to grow[^.]*\d+(\.\d+)?\s*%/.test(sweep),
      'the SWEEP block restates a growth percentage — state the mechanism instead (#1350)',
    );
    // 3. The mechanism is actually present, so this cannot be satisfied by
    // deleting the sentences outright.
    assert.ok(
      /small surplus/.test(sweep),
      'the replacement sentence is missing — this test must not pass on an emptied block',
    );
  });
});
