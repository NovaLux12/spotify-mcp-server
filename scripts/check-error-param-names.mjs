/**
 * Error-message parameter guard (#887).
 *
 * The defect this gates is a *name* defect, not a calculation defect, so no
 * behavioural test can catch it: an error message that says `--prefix` is
 * raised by exactly the same code path, on exactly the same inputs, as one
 * that says `prefix`. Nothing observable changes except the text an agent
 * reads. So this is a source scan, in the same shape as
 * `scripts/check-no-explicit-any.mjs` and the artist-albums limit guard.
 *
 * Two rules, both asserted over `src/tools`:
 *
 *   1. No command-line flag syntax in a string a registered tool can hand back
 *      to a caller. This server is reached over MCP: there is no argv, so
 *      `--prefix` names a flag nobody can pass, and an agent that takes the
 *      message literally goes looking for one. Scoped to the whole handler
 *      string surface rather than to `throw`, because the same wrong advice
 *      also reached a caller through a payload value — `try --market` in a
 *      verdict string — and a guard scoped to throws would have missed it.
 *      `src/auth.ts` is out of scope and always was: `auth --profile` is a
 *      real flag of the shipped CLI, not a message the MCP surface can
 *      mislead anyone about.
 *
 *   2. A parameter named in a thrown error message must be one the throwing
 *      tool's own input schema declares. A name counts as named if it is
 *      backticked (the house style) or snake_case, and it counts as a name
 *      only if it is a real parameter somewhere in the registry — so a
 *      message that says "Provide the playlist" is left alone. One that says
 *      `ids` where the tool declares `values` is caught, which is the same
 *      wrong-name failure as `--values` in different costume — the class that
 *      sent `volume=` where Spotify wants `volume_percent=` (#830) and read a
 *      failed lookup as `0 streams` (#803).
 *
 * Neither rule guesses at values. A message that names a parameter the schema
 * does declare is still free to be wrong about its default or its range; that
 * is a separate failure no static scan can see, and so is naming a parameter
 * the tool *does* declare but that is wrong for the branch the message sits
 * in. Both want a behavioural test.
 */

/** Registration calls that declare a tool, and therefore an input schema. */
const REGISTRATIONS = /\bserver\s*\.\s*(?:tool|registerTool)\s*\(/g;

/** A `throw new SomeError(` — the callee name is open so custom errors count. */
const THROW_SITE = /throw\s+new\s+[A-Za-z_$][\w$]*\s*\(\s*([`'"])/g;

/**
 * Words that read like parameters in a message but never are: identifiers for
 * the wire format rather than for a request, and the shared control fields
 * (`dry_run` and friends) that are on every tool's schema and so would pass
 * anyway on the tools that declare them.
 */
const NON_PARAMETER_TOKENS = new Set([
  'api_v2', 'dry_run', 'get_all_pages', 'id', 'ids', 'iso_3166_1', 'json',
  'n_1', 'no_id', 'pkce', 'spotify_uri', 'tool_id', 'uri', 'uris', 'url', 'urls',
]);

/**
 * A parameter-name claim comes in two shapes, because the two are worth very
 * different amounts of false positives.
 *
 * A backticked word is a claim whatever it looks like. Backticks are the house
 * style for naming a parameter in prose, so `` `market` `` is a name and ``the
 * `values` param`` is too, while a bare `market` is just a word. A token only
 * has to be a real parameter name somewhere in the registry to be judged, so
 * the wide pattern stays quiet in practice.
 *
 * A bare word is a claim only when it is snake_case. Bare single words are far
 * too common in a sentence to be evidence of anything, and reading them as
 * claims would produce a gate nobody could keep green. The lookbehinds keep
 * the pattern off the tail of a longer identifier and off a property access
 * like `args.prefix`.
 */
const BACKTICKED_CLAIM = /`([a-z][a-z0-9_]*)`/g;
const BARE_CLAIM = /(?<![\w$.`])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?![\w$])/g;

/** A CLI flag: `--name`. Not an em dash, a negative number, or a bare `--`. */
const FLAG_SYNTAX = /(?:^|[\s(])--[a-z][a-z0-9]*/;

const OPENERS = { '{': '}', '(': ')', '[': ']' };

/**
 * Walks the string literal whose opening quote is at `from`.
 *
 * Returns the literal text with `${…}` holes dropped — a hole is code, not
 * something a caller reads, and a parameter named inside one is a variable
 * rather than a claim. Template literals nest (a hole can hold another
 * template), so the walk tracks nesting properly; the first version of this
 * did not, and read straight past a closing backtick into the next tool.
 */
export function readStringLiteral(source, from) {
  const quote = source[from];
  let i = from + 1;
  if (quote !== '`') {
    let text = '';
    while (i < source.length && source[i] !== quote) {
      if (source[i] === '\\') { text += source[i + 1] ?? ''; i += 2; continue; }
      text += source[i];
      i++;
    }
    return { text, end: i + 1 };
  }
  let text = '';
  let depth = 0;
  let nested = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') { if (depth === 0) text += source[i + 1] ?? ''; i += 2; continue; }
    if (depth === 0) {
      if (ch === '`') break;
      if (ch === '$' && source[i + 1] === '{') { depth = 1; i += 2; continue; }
      text += ch;
      i++;
      continue;
    }
    if (nested > 0) {
      if (ch === '`') nested--;
      i++;
      continue;
    }
    if (ch === '`') { nested++; i++; continue; }
    if (ch === '$' && source[i + 1] === '{') { depth++; i += 2; continue; }
    if (ch === '}') { depth--; i++; continue; }
    i++;
  }
  return { text, end: i + 1 };
}

/**
 * Source with comments and string bodies blanked to spaces, so a structural
 * scan can never be fooled by a brace or a `throw` living inside either. The
 * output is the same length as the input, so an offset found in the mask is
 * the same offset in the source. `${…}` holes stay as code: a `throw` can
 * live in one.
 */
export function blankNonCode(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') { out += ' '; i++; }
    } else if (ch === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      const stop = close === -1 ? n : close + 2;
      for (; i < stop; i++) out += source[i] === '\n' ? '\n' : ' ';
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += quote;
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') { out += '  '; i += 2; continue; }
        if (source[i] === '\n') { out += '\n'; i++; continue; }
        out += ' ';
        i++;
      }
      out += quote;
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** Index just past the balanced closer for the opener at `open`. */
function matchBracket(source, open) {
  const stack = [OPENERS[source[open]]];
  let i = open + 1;
  while (i < source.length && stack.length > 0) {
    const ch = source[i];
    if (ch === '\\') { i += 2; continue; }
    if (OPENERS[ch]) stack.push(OPENERS[ch]);
    else if (ch === '}' || ch === ')' || ch === ']') {
      if (stack[stack.length - 1] === ch) stack.pop();
    }
    i++;
  }
  return i;
}

/**
 * The top-level keys of a zod object literal, plus whether it spreads another
 * object. A key is an identifier that opens a value and sits directly after
 * the `{` that opened the object or after a `,`; requiring that position is
 * what stops `z.string()` in a value from being read as the key `string`.
 * A spread can contribute keys this cannot see, so the returned set is a
 * lower bound — which only ever makes the guard more permissive.
 */
function schemaKeys(objectSource) {
  const keys = new Set();
  let depth = 0;
  let opaque = false;
  let i = 0;
  const n = objectSource.length;
  const before = (at) => {
    for (let k = at - 1; k >= 0; k--) if (!/\s/.test(objectSource[k])) return objectSource[k];
    return '';
  };
  while (i < n) {
    const ch = objectSource[i];
    if (OPENERS[ch]) depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
    if (depth !== 1) { i++; continue; }
    if (ch === '.' && objectSource[i + 1] === '.' && objectSource[i + 2] === '.') { opaque = true; i += 3; continue; }
    if (ch === '.') { i++; continue; }
    const key = /([A-Za-z_$][\w$]*)\s*:/y;
    key.lastIndex = i;
    const m = key.exec(objectSource);
    if (m && (i === 0 || before(i) === '{' || before(i) === ',')) {
      keys.add(m[1]);
      i += m[0].length;
      continue;
    }
    i++;
  }
  return { keys, opaque };
}

/**
 * The tool registrations in one source file: name, declared schema keys, and
 * the span of source belonging to the handler.
 */
export function registrations(source) {
  const mask = blankNonCode(source);
  const out = [];
  for (const m of mask.matchAll(REGISTRATIONS)) {
    const callOpen = m.index + m[0].length - 1;
    const callClose = matchBracket(mask, callOpen);

    // Arg 1 is the tool name and is always a plain quoted string, so the first
    // quote in the source after the call opener is its opening quote.
    const nameAt = source.indexOf("'", callOpen + 1);
    if (nameAt === -1 || nameAt > callClose) continue;
    const nameEnd = source.indexOf("'", nameAt + 1);
    if (nameEnd === -1) continue;
    const name = source.slice(nameAt + 1, nameEnd);

    // Arg 3 is the zod object literal: the first `{` opening at call depth
    // one. The description ahead of it is a string or a run of string
    // concatenations, none of which opens a brace there.
    let depth = 1;
    let schemaAt = -1;
    for (let i = callOpen + 1; i < callClose; i++) {
      const ch = mask[i];
      if (OPENERS[ch]) depth++;
      else if (ch === '}' || ch === ')' || ch === ']') depth--;
      if (ch === '{' && depth === 2) { schemaAt = i; break; }
      if (depth === 0) break;
    }
    if (schemaAt === -1) continue;

    // `server.registerTool(name, { description, inputSchema: z.object({…}) }, h)`
    // nests the schema one level down, and both registration forms are in use.
    // Reading the outer object as the schema reports every parameter in the
    // file as undeclared, so follow the nesting when it is there.
    const outerMask = mask.slice(schemaAt, callClose);
    const nested = /\binputSchema\s*:\s*z\s*\.\s*object\s*\(/.exec(outerMask);
    let schemaStart = schemaAt;
    if (nested) {
      // The match ends on `z.object(`; the schema literal is the `{` just past
      // it, which is where the key scan has to start.
      const openAt = schemaAt + nested.index + nested[0].length - 1;
      const braceAt = mask.indexOf('{', openAt);
      schemaStart = braceAt === -1 || braceAt > callClose ? openAt : braceAt;
    }
    const schemaEnd = matchBracket(mask, schemaStart);

    const parsed = schemaKeys(mask.slice(schemaStart, schemaEnd));
    out.push({
      name,
      keys: parsed.keys,
      // A spread, or a nesting this scan did not follow, means the visible key
      // set is a lower bound. Claiming a name is undeclared on that basis
      // would be guessing. Rule 1 needs no schema and still runs.
      opaque: parsed.opaque,
      handlerStart: schemaEnd,
      handlerEnd: callClose - 1,
    });
  }
  return out;
}

/** Every string literal in `source[from, to)`, with its line number. */
export function stringLiterals(source, from = 0, to = source.length) {
  const mask = blankNonCode(source);
  const out = [];
  for (let i = from; i < to; i++) {
    const ch = mask[i];
    if (ch !== "'" && ch !== '"' && ch !== '`') continue;
    const { text, end } = readStringLiteral(source, i);
    out.push({ text, line: source.slice(0, i).split('\n').length });
    i = end - 1;
  }
  return out;
}

/**
 * Every thrown error message in `source`, each attributed to the tool whose
 * handler it sits inside — or to `<module helper>` when it sits outside every
 * registration, where there is no schema to check a name against.
 */
export function collectThrownMessages(source) {
  const mask = blankNonCode(source);
  const regs = registrations(source);
  const out = [];
  for (const m of mask.matchAll(THROW_SITE)) {
    const owner = regs.find((r) => m.index >= r.handlerStart && m.index < r.handlerEnd);
    out.push({
      line: source.slice(0, m.index).split('\n').length,
      message: readStringLiteral(source, m.index + m[0].length - 1).text,
      tool: owner ? owner.name : null,
      keys: owner && !owner.opaque ? owner.keys : null,
    });
  }
  return out;
}

/** Every parameter name any registered tool in `sources` accepts. */
export function parameterVocabulary(sources) {
  const vocab = new Set();
  for (const source of sources) {
    for (const reg of registrations(source)) for (const key of reg.keys) vocab.add(key);
  }
  return vocab;
}

/** Every tool name registered anywhere in `sources`. */
export function toolNameVocabulary(sources) {
  const names = new Set();
  for (const source of sources) for (const reg of registrations(source)) names.add(reg.name);
  return names;
}

/** Every way `source` misnames a parameter to a caller, as report lines. */
export function collectErrorParamViolations(source, file, vocabulary, toolNames = new Set()) {
  const violations = [];
  const at = (line) => `${file}:${line}`;

  for (const reg of registrations(source)) {
    for (const lit of stringLiterals(source, reg.handlerStart, reg.handlerEnd)) {
      const flag = lit.text.match(FLAG_SYNTAX);
      if (flag) {
        violations.push(
          `${at(lit.line)}: ${reg.name}: command-line flag syntax "${flag[0].trim()}" in "${lit.text.trim()}"`,
        );
      }
    }
  }

  for (const t of collectThrownMessages(source)) {
    if (!t.keys) continue;
    const claims = [
      ...[...t.message.matchAll(BACKTICKED_CLAIM)].map((m) => m[1]),
      ...[...t.message.matchAll(BARE_CLAIM)].map((m) => m[1]),
    ];
    for (const token of claims) {
      if (t.keys.has(token) || NON_PARAMETER_TOKENS.has(token)) continue;
      // "run album_id first" names a tool, not a parameter.
      if (toolNames.has(token)) continue;
      if (!vocabulary.has(token)) continue;
      violations.push(`${at(t.line)}: ${t.tool}: names "${token}", which ${t.tool} does not declare`);
    }
  }
  return violations;
}
