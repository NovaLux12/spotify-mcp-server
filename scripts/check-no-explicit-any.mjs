#!/usr/bin/env node
/**
 * Payload-shape guard (#758).
 *
 * `as any` is the cast that turns off the one check this server relies on to
 * survive Spotify's wire format moving. A field rename at a payload boundary
 * compiles clean through it, and the value silently arrives as `undefined` —
 * which is how `library.ts` read a missing album as an empty string and how a
 * throttled stats.fm friend was recorded as `0 streams` (#803). The bug is not
 * that the cast exists; it is that it exists *exactly where the shape is read*
 * and *exactly where the compiler would have caught the rename*.
 *
 * This fails on any `as any` under `src/tools`, with the file, the line, and
 * the source text, so the fix is to widen the shared shape in
 * `src/types/spotify.ts` rather than to silence the cast again.
 *
 * Scope note: the issue asked for `src/tools`. That is the payload-shape
 * boundary the tool modules read Spotify responses through, so that is what is
 * enforced here. The rest of `src/` is also at zero, but `src/client.ts` and
 * the retry/error paths legitimately reason about unknown error objects, and a
 * wider gate would be a separate decision with a separate baseline.
 *
 * `--check-fixture <path>` runs the same collector over one file and exits
 * non-zero on a hit, so the gate can be proved to fire instead of assumed to.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUARDED_DIR = 'src/tools';

const fixtureIndex = process.argv.indexOf('--check-fixture');
if (fixtureIndex >= 0 && !process.argv[fixtureIndex + 1]) {
  throw new Error('--check-fixture requires a file path');
}

/**
 * Blank out everything that is not code, so a comment or a doc string that
 * *talks about* `as any` does not fail the gate, while a real cast does.
 * Template-literal `${…}` holes are kept — a cast can live inside one, and
 * blanking them would hide it.
 *
 * Returns the source with every non-code character replaced by a space, so
 * offsets and line numbers still line up with the original text.
 */
export function blankNonCode(source) {
  const out = source.split('');
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const end = source.indexOf('\n', i);
      blank(i, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end;
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      blank(i, end === -1 ? source.length : end + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (source[i] === '"' || source[i] === "'" || source[i] === '`') {
      const quote = source[i];
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === quote) break;
        // A line terminator closes an unterminated single/double-quoted string
        // rather than swallowing the rest of the file.
        if (quote !== '`' && source[j] === '\n') break;
        j++;
      }
      if (quote === '`') {
        // Re-scan the literal body as code so `${…}` holes stay visible.
        blank(i, j);
        for (const hole of templateHoles(source, i, j)) {
          const inner = blankNonCode(hole.text);
          for (let k = 0; k < inner.length; k++) {
            if (out[hole.offset + k] === ' ') out[hole.offset + k] = inner[k];
          }
        }
      } else {
        blank(i + 1, j);
        if (source[j] === quote) out[j] = quote;
      }
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

/** Offsets and text of each `${…}` interpolation inside a template literal. */
function templateHoles(source, open, close) {
  const holes = [];
  let i = open + 1;
  while (i < close) {
    if (source[i] === '\\') { i += 2; continue; }
    if (source[i] === '$' && source[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      while (j < close && depth > 0) {
        if (source[j] === '{') depth++;
        else if (source[j] === '}') depth--;
        if (depth === 0) break;
        j++;
      }
      holes.push({ offset: i + 2, text: source.slice(i + 2, j) });
      i = j + 1;
    } else {
      i++;
    }
  }
  return holes;
}

/** A cast to `any`, but not a type argument like `Record<string, any>`. */
const AS_ANY = /(?<![\w$.])as\s+any(?![\w$])/g;

/**
 * Every `as any` in one source file, as `file:line: text`. Returns `[]` when
 * the file is clean — that empty array is the comparison the gate turns on, so
 * it is computed here rather than injected by a caller.
 */
export function collectExplicitAnyErrors(source, file) {
  const code = blankNonCode(source);
  const found = [];
  for (const match of code.matchAll(AS_ANY)) {
    const line = code.slice(0, match.index).split('\n').length;
    const text = source.split('\n')[line - 1]?.trim() ?? '';
    found.push(`${file}:${line}: ${text}`);
  }
  return found;
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const file = join(directory, entry);
    if (statSync(file).isDirectory()) files.push(...walk(file));
    else if (file.endsWith('.ts')) files.push(file);
  }
  return files;
}

function checkFile(file) {
  return collectExplicitAnyErrors(readFileSync(file, 'utf8'), relative(ROOT, file));
}

if (fixtureIndex >= 0) {
  const fixturePath = resolve(process.argv[fixtureIndex + 1]);
  const found = checkFile(fixturePath);
  for (const error of found) console.error(error);
  process.exit(found.length > 0 ? 1 : 0);
}

const guarded = walk(join(ROOT, GUARDED_DIR)).sort();
const errors = guarded.flatMap(checkFile);

if (errors.length > 0) {
  console.error(`Explicit-any guard failed (${errors.length} cast${errors.length === 1 ? '' : 's'} under ${GUARDED_DIR}):\n${errors.map((line) => `- ${line}`).join('\n')}`);
  console.error('Type the payload instead of casting it away: widen the shared shape in src/types/spotify.ts, or narrow the read to a typed helper. An `as any` here is a field the compiler can no longer check for you.');
  process.exitCode = 1;
} else {
  console.log(`No \`as any\` casts under ${GUARDED_DIR} (${guarded.length} files checked).`);
}
