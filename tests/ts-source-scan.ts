/**
 * A minimal TypeScript source tokenizer, shared by the two provenance guards
 * (`approximate-rate-guard.test.ts` for #1259, `source-citation-guard.test.ts`
 * for #1260).
 *
 * Both guards ask the same shape of question -- "what does this file SAY, as
 * opposed to what does it DO?" -- and answering it needs the same two views of
 * a file: the code with comments blanked out, and the comments themselves. A
 * guard that cannot tell a comment from a string literal either flags prose in
 * a comment (a false positive on every explanatory note) or misses the very
 * citation it was written to catch, because most citations in this repository
 * live in doc comments.
 *
 * This is a scanner, not a parser. It walks the source once, tracking string,
 * template and comment state, and replaces every comment character with a
 * space. Blanking rather than deleting keeps byte offsets stable, so a caller
 * can still map a match in the stripped text back to a line number in the
 * original. That is the only property the guards rely on; anything deeper
 * (expressions, types, JSX) is out of scope, and a file this scanner
 * mis-reads fails loudly at the guards' "scanned a real surface" assertions
 * rather than quietly passing.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = process.cwd();

/** A view of one source file: the code with comments blanked, plus the comments. */
export interface ScannedFile {
  /** Repo-relative path, for assertion messages. */
  path: string;
  /** Absolute path, for reading. */
  abs: string;
  /** Original source text. */
  source: string;
  /** Source with every comment character replaced by a space (offsets preserved). */
  code: string;
  /** Every block and line comment, in source order. */
  comments: string[];
}

/**
 * Split `source` into a comment-blanked copy and the list of comments.
 *
 * Exported so each guard can be mutated independently: the tokenizer is shared,
 * but a guard that stops scanning must fail on its own assertion rather than
 * on a shared helper's.
 */
export function splitCommentsAndCode(source: string): { code: string; comments: string[] } {
  const out: string[] = [];
  const comments: string[] = [];
  let i = 0;
  const n = source.length;
  // Tracks `${` nesting inside a template literal so a `}` in an interpolation
  // does not terminate the template early.
  let templateDepth = 0;

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      comments.push(source.slice(i, stop));
      out.push(' '.repeat(stop - i));
      i = stop;
      continue;
    }

    if (c === '/' && next === '/') {
      let end = source.indexOf('\n', i);
      if (end === -1) end = n;
      comments.push(source.slice(i, end));
      out.push(' '.repeat(end - i));
      i = end;
      continue;
    }

    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === c) {
          j += 1;
          break;
        }
        j += 1;
      }
      // The literal is kept verbatim (comments are never inside a string), so
      // the caller can scan text a caller would actually receive.
      out.push(source.slice(i, j));
      i = j;
      continue;
    }

    if (c === '`') {
      let j = i + 1;
      while (j < n) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === '$' && source[j + 1] === '{') {
          templateDepth += 1;
          j += 2;
          continue;
        }
        if (source[j] === '}' && templateDepth > 0) {
          templateDepth -= 1;
          j += 1;
          continue;
        }
        if (source[j] === '`' && templateDepth === 0) {
          j += 1;
          break;
        }
        j += 1;
      }
      out.push(source.slice(i, j));
      i = j;
      continue;
    }

    out.push(c);
    i += 1;
  }

  return { code: out.join(''), comments };
}

/** Every `.ts` file under `dir`, repo-relative and sorted for stable messages. */
export function walkTypeScriptFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const child = join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('.ts')) found.push(relative(REPO_ROOT, child));
    }
  };
  walk(join(REPO_ROOT, dir));
  return found;
}

/** Read and tokenize one repo-relative file. */
export function scanFile(relPath: string): ScannedFile {
  const abs = join(REPO_ROOT, relPath);
  const source = readFileSync(abs, 'utf8');
  const { code, comments } = splitCommentsAndCode(source);
  return { path: relPath, abs, source, code, comments };
}

/** 1-based line number of `offset` within `source`. */
export function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

/** Collapse whitespace, so a doc that re-wraps a quoted string still compares equal. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
