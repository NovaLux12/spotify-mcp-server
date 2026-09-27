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
 * A comment sentence anchored to a dated tree — a commit sha, or the phrasing
 * the decision logs use (`measured`, `warrant`, `grant`).
 *
 * The sha arm requires a digit as well as hex letters, because a bare `[0-9a-f]{7}`
 * also matches English (`defaced`, `facaded`) and a false anchor exempts a real
 * defect. Git shas essentially always contain a digit; hex-only words never do.
 */
const DATED_TREE = /\b(?:measured|re-?measur\w*|measuring|warrants?|grants?)\b|(?<![0-9a-z])[0-9a-f]*[0-9][0-9a-f]{6,39}(?![0-9a-z])/i;

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
    contains: 'Then 11,882 -> 11,773B (-109) when #922 reworded this module',
    why:
      'dated: the #922 `playbackintel` re-measure. The figure is the manifest baseline it set; the sentence qualifying it ("The two deltas compose, and neither is measured off the other’s tree — this figure is the merged measurement.") is the NEXT one, so the anchoring test cannot reach it from here.',
  },
];

/** `620,000` and `620_000` are the same value; so are `64 000` and `64000`. */
function normalise(figure: string): number {
  return Number(figure.replace(/[,_]/g, ''));
}

function byteFigures(text: string): { value: number; raw: string }[] {
  const out: { value: number; raw: string }[] = [];
  BYTE_FIGURE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BYTE_FIGURE.exec(text)) !== null) {
    const value = normalise(match[1]);
    if (Number.isFinite(value) && value >= FIGURE_FLOOR) out.push({ value, raw: match[1] });
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
      if (!Number.isFinite(value) || value < FIGURE_FLOOR) continue;
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
        for (const figure of byteFigures(sentence.text)) {
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
      { path: 'src/log2.ts', source: `// sits inside the 620,000B carried by WARRANT SWEEP-2026-09 above.\n${CEILING}\n` },
    ]);
    assert.deepEqual(quotes, []);
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
