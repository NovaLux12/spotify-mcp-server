/**
 * Source-to-source blanker shared by the repository's static gates.
 *
 * Both `check-no-explicit-any.mjs` and `check-no-test-debug-output.mjs` need to
 * search code without matching prose: a comment that explains why a cast was
 * removed is not a cast, and a test that embeds a child process's source in a
 * template literal is not the test printing to stdout. It lives in its own
 * module because the gates import it — importing a gate module to reach it
 * would run that gate's CLI as a side effect.
 */

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

/**
 * A copy of the region `[0, at)` with newlines blanked to spaces.
 *
 * The two lookups below walk backwards over it, so a newline has to read as
 * whitespace rather than as a line terminator they must not stop at.
 */
function blankToEnd(out, at) {
  const copy = out.slice(0, at);
  for (let k = 0; k < copy.length; k++) if (copy[k] === '\n') copy[k] = ' ';
  return copy;
}

/**
 * The last significant character before `at`, ignoring whitespace.
 *
 * Read over the blanked prefix rather than the raw source, so a `/` inside a
 * comment — already blanked by the time the main loop reaches it — is not
 * mistaken for an operator.
 */
function lastSignificant(out, at) {
  const blanked = blankToEnd(out, at);
  for (let k = at - 1; k >= 0; k--) {
    if (blanked[k] !== ' ') return blanked[k];
  }
  return '';
}

/** The identifier ending at `at`, or `''` when a non-identifier precedes it. */
function wordBefore(out, at) {
  const blanked = blankToEnd(out, at);
  let end = at - 1;
  while (end >= 0 && blanked[end] === ' ') end--;
  let start = end;
  while (start >= 0 && /[A-Za-z0-9_$]/.test(blanked[start])) start--;
  // `out` is a character array, so this slice is an array too — joining is what
  // makes it comparable against the keyword set.
  return blanked.slice(start + 1, end + 1).join('');
}

/** Keywords after which a `/` opens a regex rather than dividing. */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await',
]);

/**
 * Is the `/` at `at` the start of a regex literal, or a division operator?
 *
 * The usual textual heuristic, plus a safety valve: a regex literal cannot
 * contain a raw line terminator, so a scan that reaches the end of the line
 * without finding its closing `/` means this was a division after all and the
 * caller must leave the source alone. Without that valve a misread would blank
 * a run of real code, which is the one failure mode a gate built on this
 * function cannot have — it would hide the very pattern it exists to find.
 */
function isRegexStart(out, at) {
  const prev = lastSignificant(out, at);
  if (prev === '' || /[(,=:[!&|?{};+\-*%^~<>]/.test(prev)) return true;
  if (/[A-Za-z0-9_$)\]]/.test(prev)) return REGEX_PRECEDING_KEYWORDS.has(wordBefore(out, at));
  return false;
}

/**
 * The offset of the `/` closing a regex literal that starts at `at`, or `-1`
 * when the literal does not close on the same line.
 *
 * A `/` inside a character class is a literal, so `[a/]` closes at the `/` after
 * the `]` — the mistake that makes a naive scan stop early and re-open a
 * string on the regex's own tail.
 */
function regexEnd(source, at) {
  let inClass = false;
  for (let k = at + 1; k < source.length; k++) {
    const c = source[k];
    if (c === '\\') { k++; continue; }
    if (c === '\n') return -1;
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c === '/') {
      // Consume the flags so they are blanked with the body.
      let f = k + 1;
      while (f < source.length && /[a-z]/.test(source[f])) f++;
      return f - 1;
    }
  }
  return -1;
}

/**
 * Blank out everything that is not code, so a comment or a doc string that
 * *talks about* a pattern does not fail the gate, while a real one does.
 * Template-literal `${…}` holes are kept — a statement can live inside one,
 * and blanking them would hide it.
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
    } else if (source[i] === '/' && isRegexStart(out, i)) {
      // A regex body is not code and not a string, but it is full of quotes:
      // `/Spotify's February 2026/` has an apostrophe that would otherwise open
      // a phantom string and blank the rest of the file as prose.
      const end = regexEnd(source, i);
      if (end !== -1) {
        blank(i, end + 1);
        i = end + 1;
        continue;
      }
      i++;
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
