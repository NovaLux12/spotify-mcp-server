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
 * This is a source-scanning guard for the same reason `chunk-caps.test.ts` and
 * the explicit-any guard are: the invariant is a property of the file's text,
 * so the cheapest honest check is to read the file. It also covers every
 * comment added later, which a behavioural test could not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
