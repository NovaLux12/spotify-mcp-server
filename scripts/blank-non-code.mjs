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
