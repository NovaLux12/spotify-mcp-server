#!/usr/bin/env node
/**
 * A module that stays registered under `SPOTIFY_MCP_READONLY` must not contain
 * a mutating call (#1604).
 *
 * ## Why this is a gate and not a convention
 *
 * The read/write classification in this server is carried by two things, and
 * only one of them is checked. `MUTATING_PREFIXES` in `src/tools/annotations.ts`
 * matches a tool's **name**; a module marked `readOnlySafe: true` is the second
 * input, and it is the one that keeps a whole family registered when
 * `SPOTIFY_MCP_READONLY=1` is set.
 *
 * Both are conventions about text, and neither looks at the code that runs. A
 * module can gain a `client.post` and every derived signal stays exactly as it
 * was — the name did not change, the `readOnlySafe` flag did not change, and
 * the census does not move. The stats.fm family is the worked example:
 * `taste_to_playlist` was documented as the single writer in an otherwise
 * read-only family, and `src/tools/statsfm_jukebox.ts` grew a second one
 * (`client.delete` on `/playlists/{id}/items`, with a `client.post` beside it),
 * with the family still documented as read-only. Nothing fired, because nothing
 * read the handler.
 *
 * This asks the question a name cannot answer: **does the code behind a
 * read-only module actually write to Spotify?**
 *
 * ## Scope, and what it deliberately does not claim
 *
 * This is a source-level check, not a semantic one.
 *
 * It DOES establish: a module that survives `SPOTIFY_MCP_READONLY=1` contains no
 * POST/PUT/PATCH/DELETE against a receiver the module obtained from a
 * client-shaped name. That is the property that actually bit, and it is the
 * guarantee `readOnlySafe` implies and does not currently enforce.
 *
 * It does NOT establish that a description's prose matches its handler. Whether
 * a read tool's *output* is described accurately is not machine-checkable today
 * and is not claimed here — claiming it would be a gate that reads as broader
 * than it is, which is the failure mode AGENTS.md §6 warns about.
 *
 * ## Known blind spots, each named rather than glossed
 *
 * A blind spot is only acceptable if it is written down. The first review of
 * this gate found three that were NOT, which is worse than having them: a
 * reader who consults this list and proceeds has been told the list is
 * complete. So the list is now the contract, and the tests assert these cases
 * behave as described rather than leaving them to inspection.
 *
 *   - **A wrapper parameter.** `function wp(c) { return c.post(…) }` is
 *     invisible: `c` is not derived from a client-shaped name, so it is not a
 *     receiver this scan knows. This is the residual from the first review and
 *     is the one shape still missed that is plausibly reachable. Closing it
 *     needs real name resolution, which is a compiler, not a scanner.
 *   - **A receiver obtained by destructuring a call result** —
 *     `const { post } = makeClient()` — where the right-hand side is not a
 *     client-shaped name. A call to a factory is not tracked.
 *   - **A computed method name** (`client[verb](…)`) is not matched.
 *   - **A receiver passed across a module boundary** — imported as
 *     `import { client } from './x.js'` and used under a name this scan cannot
 *     follow. Each module is scanned on its own, by design, so a write smuggled
 *     through an imported helper is out of reach.
 *   - A write on a rare branch IS caught: the scan is over source text, not over
 *     an executed path.
 *
 * What the scan *does* follow, and which the first review found it missing:
 *
 *   - a receiver aliased from a client-shaped name (`const c = client`);
 *   - a verb destructured onto a bare name (`const { post } = client`), called
 *     anywhere and not only at the start of a line.
 *
 * The summary line prints the module and call totals, so a family silently
 * dropping to zero shows as a number rather than a quiet pass.
 *
 * Run: node --import tsx scripts/check-readonly-tools.mjs [--json]
 * Exits non-zero on any violation, naming the module, its file and the calls.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const asJson = process.argv.includes('--json');

/**
 * Mutating HTTP verbs, and the receiver names this scan treats as a client.
 *
 * `get` is deliberately absent: reading is the normal case, and including it
 * would flag every module. The Spotify Web API's write surface is exactly
 * POST/PUT/PATCH/DELETE, so those four are the whole of it.
 */
const VERBS = ['post', 'put', 'patch', 'delete'];
const RECEIVERS = ['client', 'api', 'spotify', 'rest', 'http', 'fetchJson'];

/** Escape a literal for embedding in a RegExp source. */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Blank out comments and string/template literals, preserving offsets.
 *
 * A mutating call named in a doc comment or a code fence is not a write, and a
 * scanner that cannot tell the difference produces false positives that train
 * people to ignore it. Offsets are preserved by replacing with spaces rather
 * than deleting, so a reported line number still points at the right line.
 *
 * This is a character scanner with a mode stack, and it has to be one.
 *
 * The first version used a regex for the template-literal case, and it was
 * wrong in the one direction that matters most — it produced a FALSE POSITIVE
 * on a clean tree:
 *
 *     const msg = `outer ${`client.post('/x')`} end`;
 *
 * `` /`(?:\\.|[^`\\])*`/g `` matches from the first backtick to the next one,
 * which is `` `outer ${` ``. The inner template's body is then left exposed and
 * read as code. A gate that fails the tree it defends gets deleted, so the
 * regex was replaced rather than patched.
 *
 * The stack also gets the nesting right for the substitution body, which is
 * *code* and must be scanned rather than blanked: in
 * `` `a ${client.post('/x')} b` `` the call is real, while in
 * `` `a ${`client.post('/x')`} b` `` it is a string and is not. The two differ
 * only in whether the inner backticks make it a nested template, which is
 * exactly what a mode stack is for.
 */
function blank(source) {
  const out = source.split('');
  const n = source.length;
  const blankTo = (from, to) => {
    for (let k = from; k < to && k < n; k += 1) if (source[k] !== '\n') out[k] = ' ';
  };
  // 'code' | 'subst' (a `${…}` body, which is code) | 'sq' | 'dq' | 'tpl'
  const modes = ['code'];
  // Brace depth per open substitution, so a `${ {a:1} }` object literal does
  // not close its substitution early.
  const depths = [0];
  let i = 0;

  while (i < n) {
    const mode = modes[modes.length - 1];
    const c = source[i];

    if (mode === 'sq' || mode === 'dq') {
      const quote = mode === 'sq' ? "'" : '"';
      if (c === '\\') { i += 2; continue; }
      if (c === quote) { out[i] = quote; modes.pop(); depths.pop(); i += 1; continue; }
      out[i] = ' ';
      i += 1;
      continue;
    }

    if (mode === 'tpl') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { out[i] = '`'; modes.pop(); depths.pop(); i += 1; continue; }
      if (c === '$' && source[i + 1] === '{') {
        modes.push('subst');
        depths.push(0);
        i += 2;
        continue;
      }
      out[i] = c === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }

    // 'code' and 'subst' both scan as code; 'subst' ends at its matching '}'.
    if (c === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      blankTo(i, end);
      i = end;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      blankTo(i, end);
      i = end;
      continue;
    }
    if (c === "'") { modes.push('sq'); depths.push(0); i += 1; continue; }
    if (c === '"') { modes.push('dq'); depths.push(0); i += 1; continue; }
    if (c === '`') { modes.push('tpl'); depths.push(0); i += 1; continue; }

    if (mode === 'subst') {
      if (c === '{') { depths[depths.length - 1] += 1; i += 1; continue; }
      if (c === '}') {
        if (depths[depths.length - 1] === 0) { modes.pop(); depths.pop(); i += 1; continue; }
        depths[depths.length - 1] -= 1;
        i += 1;
        continue;
      }
    }
    i += 1;
  }
  return out.join('');
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

/**
 * Receivers and bare verbs a module actually binds, read off the blanked source.
 *
 * The first review found both forms missed. `const c = client; c.post(…)` is
 * invisible to a fixed list of receiver names, and `const { post } = client`
 * followed by `return post(…)` is invisible to a call pattern that only accepts
 * a verb at the start of a line. Both are ordinary JavaScript and both are a
 * write, so both are followed now.
 */
function bindings(source) {
  const receivers = new Set(RECEIVERS);
  const bareVerbs = new Set();

  for (const m of source.matchAll(new RegExp(
    `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:this\\.)?(?:${RECEIVERS.map(esc).join('|')})\\b`,
    'g',
  ))) {
    receivers.add(m[1]);
  }

  for (const m of source.matchAll(new RegExp(
    `\\b(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*(?:this\\.)?(?:${RECEIVERS.map(esc).join('|')})\\b`,
    'g',
  ))) {
    for (const part of m[1].split(',')) {
      // `delete: del` binds `del`; `post` binds `post`.
      const name = part.split(':').pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) bareVerbs.add(name);
    }
  }

  return { receivers: [...receivers], bareVerbs: [...bareVerbs] };
}

function callsIn(file) {
  const raw = readFileSync(file, 'utf8');
  const source = blank(raw);
  const { receivers, bareVerbs } = bindings(source);
  const found = [];

  const clientCall = new RegExp(
    `\\b(?:${receivers.map(esc).join('|')})\\s*\\.\\s*(?:${VERBS.join('|')})\\s*\\(`,
    'gi',
  );
  for (const m of source.matchAll(clientCall)) {
    found.push({ line: lineOf(source, m.index), text: m[0].replace(/\s+/g, ' ').trim() });
  }

  if (bareVerbs.length > 0) {
    // Anywhere in the file, not only at the start of a line: the destructured
    // name is a local, so `return post(…)` and `const r = post(…)` are the
    // same write as `post(…)`.
    const bareCall = new RegExp(`\\b(?:${bareVerbs.map(esc).join('|')})\\s*\\(`, 'g');
    for (const m of source.matchAll(bareCall)) {
      found.push({ line: lineOf(source, m.index), text: `${m[0].replace(/\s+/g, ' ').trim()} (destructured)` });
    }
  }

  return found.sort((a, b) => a.line - b.line);
}

async function manifest() {
  // Read the TypeScript source, not compiled `dist/`, and say why.
  //
  // The first version of this gate imported `dist/tools/annotations.js` and
  // told the reader to run `npm run build` first. That is wrong twice over: the
  // `test:` job runs this step BEFORE any build, so it threw
  // `dist/tools/annotations.js is missing` on a perfectly good checkout — a
  // gate that fails on the tree it was written to defend. And the census in
  // this same job already reads the manifest the other way, via
  // `await import('../src/tools/annotations.ts')` under tsx.
  //
  // Reading the source also removes the ordering dependency entirely: the gate
  // no longer cares where `npm run build` sits in the job, so it cannot be
  // broken again by a step being moved. It still cannot drift from
  // `src/tools/annotations.ts` — that file is now the thing being read.
  const source = new URL('../src/tools/annotations.ts', import.meta.url).href;
  const mod = await import(source).catch((error) => {
    throw new Error(
      `could not load ${source}: ${error.message}\n`
        + 'This gate imports the TypeScript source, so it must run under tsx: '
        + '`node --import tsx scripts/check-readonly-tools.mjs`.',
    );
  });
  return mod.REGISTRAR_MANIFEST;
}

const entries = await manifest();
const violations = [];
let scannedModules = 0;
let totalCalls = 0;

for (const entry of entries) {
  if (entry.readOnlySafe !== true) continue;
  scannedModules += 1;
  const file = join(ROOT, entry.file);
  let found = [];
  try {
    found = callsIn(file);
  } catch (error) {
    throw new Error(`could not scan ${entry.file}: ${error.message}`);
  }
  if (found.length > 0) {
    totalCalls += found.length;
    violations.push({ key: entry.key, file: entry.file, calls: found });
  }
}

if (asJson) {
  process.stdout.write(`${JSON.stringify({ scannedModules, totalCalls, violations }, null, 2)}\n`);
  process.exit(violations.length > 0 ? 1 : 0);
}

if (violations.length === 0) {
  process.stdout.write(
    `read-only modules: ${scannedModules} scanned, 0 contain a mutating call.\n`,
  );
  process.exit(0);
}

const lines = [
  'A module marked readOnlySafe contains a mutating call (#1604).',
  '',
  'These modules stay registered when SPOTIFY_MCP_READONLY=1 is set, so a write',
  'in one defeats the flag. The classification is derived from the module\'s name',
  'and its readOnlySafe marker; neither moves when a write is added, which is why',
  'this is checked against the source.',
  '',
];
for (const v of violations) {
  lines.push(`  ${v.key}  (${v.file})`);
  for (const c of v.calls) lines.push(`      ${v.file}:${c.line}  ${c.text}`);
  lines.push('');
}
lines.push('  Fix: drop the write, move the tool into a module that is not readOnlySafe,');
lines.push('  or — if the module genuinely only writes behind a confirmation gate that');
lines.push('  SPOTIFY_MCP_READONLY still permits — say so in a comment here and re-run.');
lines.push('');
lines.push('Read the flag\'s guarantee in src/tools/annotations.ts (readOnlySafe) before');
lines.push('changing either side: the point of the flag is that nothing behind it writes.');
lines.push('');
lines.push('Blind spots this scan does NOT cover are named in the header of');
lines.push('scripts/check-readonly-tools.mjs. A wrapper parameter (`function wp(c) {');
lines.push('return c.post(...) }`) is the one that is still missed; if that is the');
lines.push('shape you are writing, this gate will not catch it and the write needs');
lines.push('either a different receiver or a note saying so.');

process.stderr.write(`${lines.join('\n')}\n`);
process.exit(1);
