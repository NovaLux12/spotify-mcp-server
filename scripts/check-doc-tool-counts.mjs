#!/usr/bin/env node
/**
 * No registry-wide tool count survives in a hand-written comment or document.
 *
 * #1290 found a stale "592 tools" in six `src/` comments and one docs line and
 * explains why it survived: `tests/doc-figures.test.ts` covered three
 * documents by name, and three of the six were `.ts` comments, which no
 * document rule can see. A hand-typed registry count is a claim about the live
 * `tools/list` surface, and it goes stale on the very next tool that lands, so
 * it has no legitimate home outside a generated block.
 *
 * The rule is therefore a lint, not a refresh: a registry-scale tool count in a
 * hand-written comment or in document prose is an error, and a comment that
 * legitimately needs a count has to say what it measured and when — which is
 * what ALLOWED_TOOL_COUNT_LINES records, one reviewed line at a time.
 *
 * `--root` points the scan at a copy of the tree, so a test can break a
 * comment and watch this exact script reject it rather than re-implementing
 * the comparison. `--census-file` supplies the census the threshold is anchored
 * to; without it the census is generated here.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The line separating a registry total from a per-module count.
 *
 * Drawn at 100 because the two populations do not overlap and both ends are
 * checked against the census on every run: the registry is a 3-digit surface
 * (587 measured 2026-09-27) and the largest single module holds 31. A count
 * below the floor is a module's own tool count, which `surface-census --check`
 * already validates against the hand-maintained manifest baseline; a count at
 * or above it is a claim about the whole registry, and nothing validates that
 * but this script. `assertFloorIsDrawnCorrectly` fails loudly if either end
 * moves, so the line cannot quietly stop meaning anything.
 */
export const REGISTRY_SCALE_FLOOR = 100;

/**
 * The upper end of the same contract, and the reason `SPEC.md` may say
 * "hundreds of tools" instead of a count. One constant rather than a `1000`
 * typed in the gate and again in its test: two copies of a contract is the
 * same shape as the defect this script exists to catch.
 */
export const REGISTRY_SCALE_CEILING = 1000;

/**
 * A count the tree is still entitled to state, as `file` + a whitespace-
 * normalized fragment of the one line that carries it, plus why.
 *
 * Every entry is a *dated measurement record*: the number qualifies a byte
 * figure that was true when it was taken, so rewriting it to today's count
 * would falsify the figure it qualifies. Present-tense claims are not
 * allowed at all — a size claim in prose is a claim about a tree nobody pinned,
 * and the fix is to delete the number, not to refresh it.
 *
 * Line-scoped on purpose. A whole-file allowance would let a bare "592 tools
 * today" hide behind an unrelated warrant sentence in the same file, which is
 * the exact failure #1290 is about. Line-scoped means a reworded line fails
 * the gate and the allowance is re-read, which is the intended cost.
 */
const ALLOWED_TOOL_COUNT_LINES = [
  ...[
    ['src/tools/swarm3_analytics.ts', '500-tool swarm v1.26.0 (issue #442).'],
    ['src/tools/swarm3_discovery.ts', '500-tool swarm v1.26.0 (issue #442).'],
    ['src/tools/swarm3_library.ts', '(500-tool push, branch swarm3-500-tools).'],
    ['src/tools/swarm3_meta.ts', '500-tool swarm v1.26.0 (issue #442).'],
    ['src/tools/swarm3_playback.ts', '500-tool swarm v1.26.0 (issue #442).'],
    ['src/tools/swarm3_playlistops.ts', '500-tool swarm v1.26.0 (issue #442).'],
    ['src/tools/swarm3_shows.ts', '500-tool swarm v1.26.0 (issue #442).'],
    ['src/tools/swarm3_snapshots.ts', '500-tool swarm v1.26.0 (issue #442).'],
    ['src/tools/swarm3b_discovery.ts', '500-tool swarm v1.26.0 (issue #442).'],
  ].map(([file, contains]) => ({
    file,
    contains,
    why: "not a figure: #442's branch was named `swarm3-500-tools` and these nine headers name that project, the way a release name is quoted",
  })),
  {
    file: 'src/tools/annotations.ts',
    contains: 'Before this module, 0 of 608 tools carried `annotations`, so a host could not',
    why: 'dated: the pre-#565 surface this module was written against, before any tool carried annotations',
  },
  {
    file: 'src/tools/annotations.ts',
    contains: 'the tree carrying #1004 and this wave is 607,715B over the same 592',
    why: 'dated: 607,715B is the byte figure this count qualifies; it was measured over 592 tools',
  },
  {
    file: 'src/tools/annotations.ts',
    contains: 'some: measured on the tree carrying #1004 and the whole wave (592 tools),',
    why: 'dated: the 607,715B / 285B-of-headroom measurement, taken over 592 tools',
  },
  {
    file: 'src/tools/annotations.ts',
    contains: '+1% each, against a 592-tool tools/list payload.',
    why: "dated: #720's per-module raise warrant, sized against the aggregate as it stood",
  },
  {
    file: 'src/tools/annotations.ts',
    contains: '610738 B -> 611468 B (+730 B, +0.12%) across 592 tools, measured the same',
    why: 'dated: the #905 delta, and both byte figures it is a delta between were taken over 592 tools',
  },
  {
    file: 'src/tools/annotations.ts',
    contains: '[27, 24664] measured from the real registrar (tools: 556). The +230B over',
    why: 'dated: the 24,664B baseline beside it, measured over 556 tools on the rebased tree',
  },
  {
    file: 'src/tools/annotations.ts',
    contains: 'Host-session payload impact: aggregate tools/list 606,353 B across 587',
    why: 'dated: the 606,353B / 14,647B-headroom measurement, and the 640,000B cap it was taken against; both belong to that tree, not this one',
  },
  {
    file: 'docs/schema-budgets.md',
    contains: 'The registry was 592 tools before and after; the change\'s cost against the',
    why: 'dated: #900 changed no tools, and the point of the sentence is that the count did not move; it is the same category as the per-module raise history this file already keeps in prose',
  },
];

/**
 * Documents the scan reads. `CHANGELOG.md` and `memory/` are excluded on
 * purpose: both are generated (release-please, and the live gauntlet's report),
 * and a rule that flagged generated history would be a rule nobody could keep
 * green. `memory/live-sweep-report.md` counts the tools *a sweep pass reached*,
 * not the registry, which is a different figure entirely.
 */
const DOCUMENT_ROOTS = ['README.md', 'SPEC.md', 'ARCHITECTURE.md', 'AGENTS.md', 'CONTRIBUTING.md', 'docs', 'skills'];

/** Collapse whitespace so an allowance fragment survives a rewrap. */
function normalize(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The text a regex sees: every line kept at its original offset, so a match
 * index maps straight back to a `file:line`. A generated block is blanked to
 * spaces rather than deleted, which is what keeps the line numbers honest and
 * lets the test assert that blanking is what removed a hit.
 */
export function blankGenerated(source) {
  let inBlock = false;
  return source
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!inBlock) {
        if (trimmed.startsWith('<!-- BEGIN:generated ') || trimmed.startsWith('// BEGIN:generated ')) {
          inBlock = true;
          return ' '.repeat(line.length);
        }
        return line;
      }
      if (trimmed.startsWith('<!-- END:generated ') || trimmed.startsWith('// END:generated ')) inBlock = false;
      // Same length, not `''`: the masked text has to keep the original's
      // offsets or every reported line number is wrong.
      return ' '.repeat(line.length);
    })
    .join('\n');
}

/**
 * Reduce a TypeScript source to its comments, offset-preserving.
 *
 * A line is a comment line when its first non-space characters are `//`, `/*`
 * or `*`. A trailing `//` comment on a code line is NOT scanned, because
 * telling a comment from a string without a parser is not worth a parser. That
 * is a stated limitation rather than an assumption: the
 * `comment-only scanning of src/ costs no coverage today` case in
 * `tests/doc-figures.test.ts` compares this mask against the whole file and
 * fails if the gap ever stops being free.
 */
export function maskToComments(source) {
  const lines = source.split('\n');
  let inBlockComment = false;
  return lines
    .map((line) => {
      const trimmed = line.trimStart();
      const opensBlock = trimmed.startsWith('/*');
      if (!inBlockComment && !opensBlock && !trimmed.startsWith('//') && !trimmed.startsWith('*')) {
        return ' '.repeat(line.length);
      }
      if (opensBlock) inBlockComment = !trimmed.includes('*/');
      else if (trimmed.startsWith('*/')) inBlockComment = false;
      const prefix = /^\s*(?:\/\*|\/\/|\*)\/?\s?/.exec(line);
      // No prefix to strip on a continuation line of a block comment written
      // without leading asterisks — the whole line is the comment, so blanking
      // it would drop a comment rather than the code around it.
      if (!prefix) return line;
      return ' '.repeat(prefix[0].length) + line.slice(prefix[0].length);
    })
    .join('\n');
}

/**
 * A registry-scale tool count, in either word order.
 *
 * The lookbehind keeps a count out of a larger token, which is what stops
 * `#5-tools` (a SPEC.md anchor), `swarm3-500-tools` (a branch name) and
 * `v1.26.0` (a version) from reading as figures — `-` is in the class for the
 * branch-name case, since a hyphen ahead of the digits means the number is half
 * of a compound token rather than a figure of its own. `~` is allowed ahead of
 * the digits because an approximation is the most tempting way to write one of
 * these and the worst, since nothing can contradict it. The first arm spans
 * newlines so a count whose noun wrapped onto the next line of the same comment
 * — which is exactly how `annotations.ts` splits "the same 592" / "tools" — is
 * still seen.
 */
const TOOL_COUNT_ARMS = [
  /(?<![\w.,#-])(~?\d[\d,]*)\s*-?\s*tools?\b/g,
  /\btools?\s*[:=]\s*(~?\d[\d,]*)\b/g,
];

function lineNumberAt(source, index) {
  let line = 1;
  for (let at = 0; at < index; at += 1) {
    if (source.charCodeAt(at) === 10) line += 1;
  }
  return line;
}

/** Every registry-scale tool count in one already-masked text. */
export function registryScaleToolCounts(masked) {
  const hits = [];
  for (const arm of TOOL_COUNT_ARMS) {
    arm.lastIndex = 0;
    for (const match of masked.matchAll(arm)) {
      const figure = match[1].replace(/[~,]/g, '');
      const value = Number(figure.replace(/,/g, ''));
      if (!Number.isFinite(value) || value < REGISTRY_SCALE_FLOOR) continue;
      hits.push({ figure: match[1], index: match.index });
    }
  }
  return hits;
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

function documentFiles(root) {
  const out = [];
  for (const name of DOCUMENT_ROOTS) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    if (statSync(path).isDirectory()) out.push(...walk(path).filter((file) => /\.mdx?$/.test(file)));
    else out.push(path);
  }
  return out;
}

function sourceFiles(root) {
  const src = join(root, 'src');
  return existsSync(src) ? walk(src).filter((file) => file.endsWith('.ts')) : [];
}

/** Every file the rule reads, absolute, documents first. */
export function scannableFiles(root) {
  return [...documentFiles(root), ...sourceFiles(root)];
}

/** The masked text for source already read into memory, keyed by extension. */
export function maskSource(source, isTypeScript) {
  const withoutGenerated = blankGenerated(source);
  return isTypeScript ? maskToComments(withoutGenerated) : withoutGenerated;
}

/**
 * Every un-allowed registry-scale tool count under `root`, as
 * `file:line: figure` strings, plus a dead-allowance error for any allowance
 * no longer present in the tree.
 */
export function collectToolCountErrors(root, census) {
  assertFloorIsDrawnCorrectly(census);
  const errors = [];
  const matchedAllowances = new Set();
  for (const absolute of scannableFiles(root)) {
    const file = relative(root, absolute).split('\\').join('/');
    const source = readFileSync(absolute, 'utf8');
    const lines = source.split('\n');
    const masked = file.endsWith('.ts') ? maskToComments(blankGenerated(source)) : blankGenerated(source);
    for (const hit of registryScaleToolCounts(masked)) {
      const line = lineNumberAt(source, hit.index);
      const text = normalize(lines[line - 1] ?? '');
      const allowance = ALLOWED_TOOL_COUNT_LINES.find(
        (entry) => entry.file === file && text.includes(normalize(entry.contains)),
      );
      if (allowance) {
        matchedAllowances.add(allowance);
        continue;
      }
      errors.push(`${file}:${line}: hand-typed registry tool count "${hit.figure}" in hand-maintained text — it will be wrong the next tool that lands; say what you measured instead, or move the figure into a generated block`);
    }
  }
  for (const entry of ALLOWED_TOOL_COUNT_LINES) {
    if (!matchedAllowances.has(entry)) {
      errors.push(`allowance for ${entry.file} is dead — no line matches "${entry.contains}" (${entry.why}); delete the allowance, or re-read the rewording and re-state the allowance`);
    }
  }
  return errors;
}

/**
 * Both ends of `REGISTRY_SCALE_FLOOR`, measured rather than assumed.
 *
 * `SPEC.md` states the registry as "hundreds of tools", so the upper bound is
 * a contract the prose leans on, not a magic number: if the surface ever stops
 * being three digits this fails and the sentence has to be rewritten. The
 * lower end is the check that keeps the floor meaningful — a module that grew
 * past 100 tools would put a per-module count in scope, and a registry that
 * shrank below 100 would put every figure out of scope.
 */
export function assertFloorIsDrawnCorrectly(census) {
  const modules = Object.values(census.perModule ?? {});
  const largest = modules.length ? Math.max(...modules) : 0;
  if (census.tools < REGISTRY_SCALE_FLOOR) {
    throw new Error(`the registry is ${census.tools} tools, below the ${REGISTRY_SCALE_FLOOR} floor this rule draws; a count is no longer distinguishable from a module's own count without a redesign`);
  }
  if (census.tools >= REGISTRY_SCALE_CEILING) {
    throw new Error(`the registry is ${census.tools} tools, no longer "hundreds"; the floor still separates it from a module, but SPEC.md's "hundreds of tools" is now false`);
  }
  if (largest >= REGISTRY_SCALE_FLOOR) {
    throw new Error(`a module registers ${largest} tools, at or above the ${REGISTRY_SCALE_FLOOR} floor; a per-module count is now indistinguishable from a registry count and the rule needs a scope split`);
  }
}

function loadCensus(argv) {
  const at = argv.indexOf('--census-file');
  if (at >= 0) {
    if (!argv[at + 1]) throw new Error('--census-file requires a JSON file');
    return JSON.parse(readFileSync(resolve(argv[at + 1]), 'utf8'));
  }
  return JSON.parse(execFileSync(process.execPath, ['scripts/surface-census.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  }));
}

function main() {
  const argv = process.argv.slice(2);
  const rootAt = argv.indexOf('--root');
  if (rootAt >= 0 && !argv[rootAt + 1]) throw new Error('--root requires a directory');
  const root = rootAt >= 0 ? resolve(argv[rootAt + 1]) : ROOT;
  const errors = collectToolCountErrors(root, loadCensus(argv));
  for (const error of errors) console.error(error);
  if (errors.length) {
    console.error(`\n${errors.length} hand-typed registry tool count(s) outside a generated block.`);
    console.error('SPEC.md §5 and the generated surface-census block are the only places a registry tool count may live.');
    process.exit(1);
  }
  console.log('no hand-typed registry tool count outside a generated block');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
