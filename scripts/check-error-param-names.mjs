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
 * Two rules, both asserted over `src/tools`, plus a module-scope pair over
 * all of `src/` (see the scope section below):
 *
 *   1. No command-line flag syntax in a string a registered tool can hand back
 *      to a caller. This server is reached over MCP: there is no argv, so
 *      `--prefix` names a flag nobody can pass, and an agent that takes the
 *      message literally goes looking for one. Scoped to the whole handler
 *      string surface rather than to `throw`, because the same wrong advice
 *      also reached a caller through a payload value — `try --market` in a
 *      verdict string — and a guard scoped to throws would have missed it.
 *      The shipped CLI's own flags are exempt, and the exemption is structural
 *      rather than a filename list — see `isCommandLineModule`.
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
 *
 * ## Scope, and what it cost to widen it (#1500)
 *
 * Both rules above are keyed on a registration, so both were asserted over
 * `src/tools` and nowhere else. That left the shared modules — `shaping.ts`,
 * `result.ts`, `accounts.ts`, `paths.ts` and 42 others — unscanned, and they
 * are exactly where user-facing remediation text is written, because a helper
 * under `src/` is what a tool surfaces verbatim. `registerAccount` telling a
 * caller to re-run `spotify-mcp auth --profile` is the concrete miss: that
 * command creates a token file and never reaches the registry, so following it
 * exits 0 and reaches no different state.
 *
 * `collectModuleViolations` closes that, and widening the scan turned the gate
 * RED on the existing tree rather than green — ten findings, each reviewed:
 *
 *   - Six were the guard's own vocabulary being incomplete, not bad messages.
 *     `playlist_a` and `playlist_b` are declared in `src/shaping.ts:459` and
 *     reach tools by spread, so the registration-only vocabulary called them
 *     undeclared; `subject_type` is a real parameter of a tool registered
 *     through `registerCanonicalTool`, a form the registration scan does not
 *     parse. Fixed by widening the vocabulary, not by silencing the messages.
 *   - Three are not parameter claims: `top_result_ids` names a field of a
 *     persisted sidecar record, `record_feedback` is a legacy tool alias
 *     passed as an argument, and `play_failed` is a bare error code.
 *   - One was a real message defect: `swarm3_playlistops.ts` told a caller to
 *     use "`keep_only` style tools", which is not a tool name and not a
 *     parameter. The message was fixed to name `playlist_keep_only`.
 *
 * The mask was broken underneath all of this. A regex literal containing a
 * quote — `/"/g`, in four files — read as an *opening* string delimiter, and
 * the mask then swallowed the rest of the file as string body, so
 * `src/auth.ts` lost 12 of its 15 throw sites and `swarm3_discovery.ts` lost 7
 * of its 24 registrations. Those regions were reported clean because nothing
 * read them. See `blankNonCode`.
 *
 * What is still not covered, and is a real limit rather than an oversight: a
 * message composed in a shared module is not checked against the schema of
 * the tool that surfaces it. Deciding which tool surfaces which message is
 * dataflow this scan does not model, so the module rule asks only whether a
 * name is a parameter *at all*. A shared helper that names a real parameter of
 * the wrong tool will not be caught here.
 */

/** Registration calls that declare a tool, and therefore an input schema. */
const REGISTRATIONS = /\bserver\s*\.\s*(?:tool|registerTool)\s*\(/g;

/** A `throw new SomeError(` — the callee name is open so custom errors count. */
const THROW_SITE = /throw\s+new\s+[A-Za-z_$][\w$]*\s*\(\s*([`'"])/g;

/** A named `function` declaration and the `(` that opens its parameter list. */
const FUNCTION_WITH_PARAMS = /(?:^|[^\w$.])(?:async\s+)?function\s*\*?\s*[A-Za-z_$][\w$]*\s*\(/g;

/** `z.object({` — the opening of a parameter shape, wherever it is written. */
const ZOD_OBJECT = /\bz\s*\.\s*object\s*\(\s*\{/g;

/**
 * A `ZodRawShape` object literal: `{ key: SomeZodThing, … }`, the argument
 * both registration forms take and the shape shared field objects are written
 * in. This is the form that actually carries the tree's parameters —
 * `PlaylistPairFields` in `src/shaping.ts` and the `registerCanonicalTool`
 * params in `src/tools/statsfm_taste.ts` are both bare objects, and neither
 * is reachable through `z.object({`. A key counts when it opens a value and
 * sits directly after the `{` or a `,`, which is what keeps a zod builder
 * method in value position from being read as a key.
 */
const RAW_SHAPE_KEY = /(?:^|[{,])\s*([a-z_$][\w$]*)\s*:(?!:)/g;

/**
 * The declaration of a named field object: `export const PlaylistPairFields = {`.
 * A shared field object is exactly this — a const whose value is an object of
 * schema fields, spread into a tool's shape — and it is not reachable from any
 * registration, so nothing else in the scan sees its keys.
 */
const NAMED_FIELD_OBJECT = /(?:^|[\n;}])[ \t]*(?:export[ \t]+)?const[ \t]+[A-Za-z_$][\w$]*[ \t]*(?::[^=]*)?=[ \t]*\{/g;

/**
 * A shape object wider than this is a payload or a config, not a parameter
 * shape. The widest real one here is a few hundred characters; the bound keeps
 * the reader from walking into a large unrelated object.
 */
const MAX_SHAPE_SPAN = 4000;

/**
 * A registration call whose tool name is the first string argument. Broader
 * than `REGISTRATIONS` on purpose: this is the "is this word a tool name"
 * vocabulary, and a name missed here is reported as an undeclared parameter.
 * Over-approximating costs nothing — a word that merely looks like a tool name
 * is exempted from a check, never convicted by one.
 */
const ANY_REGISTRATION = /\.\s*(?:tool|registerTool)\s*\(\s*'([a-z][a-z0-9_]*)'/g;

/** `registerCanonicalTool('name', 'alias', …)` — the statsfm registration form. */
const CANONICAL_REGISTRATION = /\bregisterCanonicalTool\s*\(\s*\n?\s*'([a-z][a-z0-9_]*)'/g;

/** Every tool name any registration form in `source` declares. */
export function declaredToolNames(source) {
  const mask = blankNonCode(source);
  const names = new Set();
  for (const re of [ANY_REGISTRATION, CANONICAL_REGISTRATION]) {
    for (const m of mask.matchAll(re)) names.add(m[1]);
  }
  return names;
}

/**
 * Words that read like parameters in a message but never are: identifiers for
 * the wire format rather than for a request, and the shared control fields
 * (`dry_run` and friends) that are on every tool's schema and so would pass
 * anyway on the tools that declare them.
 */
const NON_PARAMETER_TOKENS = new Set([
  'api_v2', 'dry_run', 'get_all_pages', 'id', 'ids', 'iso_3166_1', 'json',
  'n_1', 'no_id', 'pkce', 'spotify_uri', 'tool_id', 'uri', 'uris', 'url', 'urls',
  // The last three were added when the module scan was widened (#1500). Each
  // was reviewed, not silenced: all three are real, and none is a parameter.
  // `top_result_ids` is a field of the persisted sidecar record, and the
  // message that names it is about that file's shape, not about a caller's
  // request. `record_feedback` is the legacy alias argument of
  // `registerCanonicalTool` — a tool name, which the tool-name vocabulary
  // does cover but which arrives here as the second argument rather than the
  // first. `play_failed` is a bare error code with no parameter around it.
  'play_failed', 'record_feedback', 'top_result_ids',
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
 * The token before `at`, skipping whitespace — the only context a `/` needs to
 * tell a regex literal from a division. Reading it backwards from the slash
 * itself keeps it correct inside a parenthesised subexpression, where the
 * character ahead of the `/` is a space or nothing at all.
 */
function tokenBefore(source, at) {
  for (let i = at - 1; i >= 0; i--) {
    if (/\s/.test(source[i])) continue;
    return source[i];
  }
  return '';
}

/**
 * Index just past the closing `/` of the regex literal opening at `open`, or
 * -1 when this `/` is not a regex after all. A `/` in value position is a
 * division or a comment, not a pattern; a character class may hold an unescaped
 * `/`, so the scan tracks `[…]`; a newline ends the pattern because a regex
 * literal cannot span one.
 */
function regexLiteralEnd(source, open) {
  const before = tokenBefore(source, open);
  // A `/` after one of these is unambiguously division, so it is not a pattern.
  if (before === ')' || before === ']' || before === '}') return -1;
  let i = open + 1;
  let inClass = false;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '\n') return -1;
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) return i;
    i++;
  }
  return -1;
}

/**
 * Source with comments, string bodies and regex bodies blanked to spaces, so a
 * structural scan can never be fooled by a brace or a `throw` living inside
 * any of them. The output is the same length as the input, so an offset found
 * in the mask is the same offset in the source. `${…}` holes stay as code: a
 * `throw` can live in one.
 *
 * Regex literals are blanked because a quote inside one is not a string
 * delimiter. `/"/g` — a replace of double quotes, in four files in this tree —
 * read as an *opening* double quote, and the mask then swallowed the rest of
 * the file as string body: `src/auth.ts` lost 12 of its 15 throw sites and
 * `swarm3_discovery.ts` lost 7 of its 24 registrations, so the guard reported
 * those regions clean having not read them. The length invariant held only by
 * luck, which is why the desync was invisible until the scan was widened.
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
    } else if (ch === '/') {
      const end = regexLiteralEnd(source, i);
      if (end === -1) { out += ch; i++; continue; }
      // Blank the pattern and its flags; the `/` delimiters become spaces so a
      // later `//` cannot be read as a comment opener.
      for (let k = i; k <= end; k++) out += ' ';
      i = end + 1;
      while (i < n && /[a-z]/i.test(source[i])) { out += ' '; i++; }
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
/**
 * The whole first argument of a `throw new SomeError(…)`, as the text a caller
 * reads.
 *
 * A long message is written as a `+`-joined run of string literals — that is
 * the house style, and the `accounts.ts` remediation the issue names is four of
 * them. Reading only the first literal therefore read one line of a four-line
 * message, and the `--profile` it was written to report was in the last one:
 * the guard reported the real defect clean. So the run is followed to its end.
 *
 * A hole in any literal is dropped rather than interpolated: it is code, and a
 * parameter named inside `${…}` is a variable, not a claim. What survives is
 * joined with a space, which is what the caller sees.
 */
function readThrownMessage(source, mask, from) {
  const parts = [];
  let i = from;
  for (;;) {
    const quote = source[i];
    if (quote !== "'" && quote !== '"' && quote !== '`') break;
    const { text, end } = readStringLiteral(source, i);
    parts.push(text);
    i = end;
    // Step over whitespace and a `+` to the next literal of the same run. A
    // comma or a closer ends the argument, which is what stops the walk from
    // running into the next statement.
    let j = i;
    while (j < source.length && /\s/.test(source[j])) j++;
    if (source[j] !== '+') break;
    j++;
    while (j < source.length && /\s/.test(source[j])) j++;
    if (source[j] !== "'" && source[j] !== '"' && source[j] !== '`') break;
    i = j;
  }
  void mask;
  return parts.join(' ');
}

export function collectThrownMessages(source) {
  const mask = blankNonCode(source);
  const regs = registrations(source);
  const out = [];
  for (const m of mask.matchAll(THROW_SITE)) {
    const owner = regs.find((r) => m.index >= r.handlerStart && m.index < r.handlerEnd);
    out.push({
      line: source.slice(0, m.index).split('\n').length,
      message: readThrownMessage(source, mask, m.index + m[0].length - 1),
      tool: owner ? owner.name : null,
      keys: owner && !owner.opaque ? owner.keys : null,
    });
  }
  return out;
}

/**
 * Every parameter name declared anywhere in `source`, by any of the shapes a
 * tool's input is written in: a `z.object({…})`, a bare `ZodRawShape` literal,
 * or a shared field object spread into either.
 *
 * `registrations()` reads only the shape passed inline to a `server.tool()`
 * call, so the vocabulary it builds is a LOWER BOUND: a tool that spreads a
 * shared field object declares its parameters somewhere the registration scan
 * never looks. `playlist_a` and `playlist_b` are declared in
 * `src/shaping.ts:459` and reach tools by spread, so both were absent from the
 * vocabulary while being real, declared parameters — and the module rule below
 * called them undeclared.
 *
 * Over-approximating is the right direction for a NEGATIVE check. The rule
 * asks "is this name a parameter at all?", so reading more shapes can only ever
 * silence a true positive, never invent a false one.
 */
export function zodShapeKeys(source) {
  const mask = blankNonCode(source);
  const keys = new Set();
  for (const m of mask.matchAll(ZOD_OBJECT)) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(mask, open);
    for (const key of mask.slice(open + 1, close - 1).matchAll(RAW_SHAPE_KEY)) keys.add(key[1]);
  }
  // A shared field object is a const whose value is a `ZodRawShape` literal.
  // It is spread into tool schemas, so it declares real parameters while being
  // reachable from no registration at all.
  for (const m of mask.matchAll(NAMED_FIELD_OBJECT)) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(mask, open);
    if (close - open > MAX_SHAPE_SPAN) continue;
    for (const key of mask.slice(open + 1, close - 1).matchAll(RAW_SHAPE_KEY)) keys.add(key[1]);
  }
  return keys;
}

/**
 * Every parameter name any registered tool accepts, plus every name any zod
 * shape in the scanned sources declares. The second half is what makes the
 * module rule sound: without it, a parameter declared by a shared field object
 * and spread into a tool reads as a name nothing declares.
 */
export function parameterVocabulary(sources) {
  const vocab = new Set();
  for (const source of sources) {
    for (const reg of registrations(source)) for (const key of reg.keys) vocab.add(key);
    for (const key of zodShapeKeys(source)) vocab.add(key);
  }
  return vocab;
}

/**
 * Every tool name registered anywhere in `sources`.
 *
 * Includes the two registration forms `registrations()` does not parse —
 * `registerCanonicalTool(` and a `server` held in a local alias — because a
 * name the guard cannot see is a name the "a tool name is not a parameter
 * claim" exclusion cannot protect, and `record_feedback` was reported as an
 * undeclared parameter for exactly that reason.
 */
export function toolNameVocabulary(sources) {
  const names = new Set();
  for (const source of sources) {
    for (const reg of registrations(source)) names.add(reg.name);
    for (const name of declaredToolNames(source)) names.add(name);
  }
  return names;
}

/**
 * A module that owns a command-line surface, where `--name` is a real flag a
 * human can type rather than advice an MCP caller can act on.
 *
 * The property is structural, not a filename list: the module declares a
 * function whose parameter list names `argv`. `src/auth.ts` has always been
 * exempt for exactly this reason and the exemption was implicit — it was never
 * scanned, because the scan stopped at `src/tools`. Widening the scan without
 * widening the exemption is what would have turned `auth --profile` into a
 * violation, so the two halves have to move together.
 *
 * A filename list would have been the wrong shape twice over: it needs a
 * human to remember to add the next CLI subcommand, and it cannot be checked.
 * This can be, and is.
 */
export function isCommandLineModule(source) {
  const mask = blankNonCode(source);
  for (const m of mask.matchAll(FUNCTION_WITH_PARAMS)) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(mask, open);
    if (/(^|[\s,([])\s*argv\s*[,)=:]/.test(source.slice(open + 1, close - 1))) return true;
  }
  return false;
}

/**
 * The two ways a message composed outside a tool module can still misname a
 * parameter to a caller, as report lines.
 *
 * This is the half of the guard that issue #1500 is about. A shared module
 * under `src/` — `shaping.ts`, `result.ts`, `accounts.ts` and the rest — owns
 * the error paths a tool surfaces verbatim, and none of it was scanned: both
 * rules above are keyed on a registration, and a shared module registers
 * nothing. The concrete miss was `registerAccount` in `src/accounts.ts`
 * telling a caller to re-run `spotify-mcp auth --profile`, a command that
 * creates a token file and never reaches the registry (#1465).
 *
 * Reachability is not decidable by a scan, so the rules are the two that stay
 * sound without it:
 *
 *   1. Flag syntax in a thrown message. There is no argv on the MCP surface,
 *      so a `--flag` in a message a tool can surface is wrong unless the module
 *      is the CLI itself.
 *
 *   2. A name that is not a real parameter *anywhere* in the registry. The
 *      per-tool rule above cannot run here — there is no schema to check
 *      against — so this asks the weaker, still-decidable question: is the
 *      word a parameter at all? A shared helper naming `match_by` is right;
 *      one naming `match_bys` is the same wrong-name defect as #830, and no
 *      amount of schema-less scope can prove otherwise.
 *
 * Deliberately NOT checked: whether the name is declared *by the tool that
 * surfaces it*. That is the dataflow question the module boundary hides, and
 * guessing at it is how this guard would start crying wolf.
 */
export function collectModuleViolations(source, file, vocabulary, toolNames = new Set()) {
  if (isCommandLineModule(source)) return [];
  const violations = [];
  for (const t of collectThrownMessages(source)) {
    const at = `${file}:${t.line}`;
    const flag = t.message.match(FLAG_SYNTAX);
    if (flag) {
      violations.push(
        `${at}: command-line flag syntax "${flag[0].trim()}" in a message shared with every caller: "${t.message.trim()}"`,
      );
      continue;
    }
    const claims = [
      ...[...t.message.matchAll(BACKTICKED_CLAIM)].map((m) => m[1]),
      ...[...t.message.matchAll(BARE_CLAIM)].map((m) => m[1]),
    ];
    for (const token of claims) {
      if (NON_PARAMETER_TOKENS.has(token)) continue;
      if (toolNames.has(token)) continue;
      if (vocabulary.has(token)) continue;
      violations.push(
        `${at}: names "${token}", which no registered tool declares as a parameter`,
      );
    }
  }
  return violations;
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
