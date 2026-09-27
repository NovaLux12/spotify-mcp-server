/**
 * `outputSchema` must be declared for the tools that return `structuredContent`
 * (#687).
 *
 * ## The shape of the defect
 *
 * Every tool in this server emits `structuredContent`, and until #687 not one
 * of them declared an `outputSchema`. The consequence is not a missing
 * annotation: it is that a host reading `tools/list` cannot tell which tools
 * answer with structured data and which answer with prose, so a client that
 * prefers structured results has nothing to branch on and falls back to regexing
 * sentences — which is the recurring failure class in this repository's own
 * notes.
 *
 * ## Why this is not a blanket sweep
 *
 * Declaring a schema on a tool with a PROSE-ONLY path makes that path stop
 * working. The SDK's `validateToolOutput` and this server's own `validateOutput`
 * both refuse a result that declares an output schema and returns no
 * `structuredContent`:
 *
 *   > Output validation error: Tool X has an output schema but no structured
 *   > content was provided
 *
 * `tests/` proves that with a live call rather than asserting it from the SDK
 * source (see "the refusal is real, not inferred"). So the change is a
 * curated rollout over a classified surface, and the classification is the part
 * that can rot: a module that grows a `textResult(prose)` a year from now must
 * not silently inherit a schema it cannot satisfy.
 *
 * ## What these tests hold in place
 *
 * 1. Every module is classified — declared, prose-only, or verified-safe-and-
 *    pending. A new module in none of them fails, which is the acceptance
 *    criterion the issue states ("a test fails when a tool returns
 *    `structuredContent` without a declared `outputSchema`, with an explicit
 *    allow-list for legacy tools").
 * 2. The prose-only list is re-derived from the SOURCES, and the two must agree
 *    in both directions. The scanner below is deliberately allowed to be
 *    over-eager: a false positive costs one module its declaration, a false
 *    negative costs a production call.
 * 3. The declared families ACCEPT what the shared emitters really produce, and
 *    REJECT a wrong-typed field. Without the second half a family of
 *    `z.object({}).passthrough()` would pass everything, which is a schema that
 *    cannot fail.
 *
 * ## "I could not classify this" must not read as "safe" (#1495)
 *
 * Rules 1–3 all depend on the scanner UNDERSTANDING a module, and until #1495
 * there was no statement anywhere that it had. A module whose prose-only path
 * was built by a module-local emitter (`textOut` in `statsfm_taste.ts`) matched
 * none of the markers, so the scanner reported `proseOnly: false` — the same
 * verdict it gives a module it has genuinely cleared — and the module sat in
 * `PENDING_OUTPUT_SCHEMA_MODULES` as "verified safe, awaiting headroom", a
 * claim no test checked. Move it to `OUTPUT_SCHEMA_BY_MODULE` and the suite
 * stayed green with four prose-only call sites declared as structured.
 *
 * So the scanner now has a THIRD verdict, and it is the one that matters:
 *
 *   - `prose-only` — a marker was found;
 *   - `safe` — every result the scanner can see is accounted for;
 *   - **`unclassified` — the scanner cannot account for a result.** A module in
 *     this state FAILS, by name, instead of defaulting to safe.
 *
 * A gate that cannot tell "clear" from "never looked" is not a weak gate, it is
 * a confident wrong answer — the same failure AGENTS.md §6 records for a
 * schema-budget check that trusted a precomputed flag. The distinction is
 * enforced from both sides: `scanToolSources` refuses to report a module as
 * prose-safe while anything in it is unattributed, and the fixtures below feed
 * it the shapes it must recognise, so the rules have met the cases they exist
 * to catch rather than only the cases the tree happens to contain.
 *
 * Run: node --import tsx --test tests/output-schema-declaration.test.ts
 */
import './helpers/hermetic.js';

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { safeParseAsync } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { z } from 'zod';

import {
  applyToolOutputSchemas,
  installToolErrorBoundary,
  loadManifestRegistrars,
  registerManifestModule,
  REGISTRAR_MANIFEST,
  moduleToolNames,
} from '../src/tools/annotations.js';
import {
  CardOutput,
  ListOutput,
  MutationOutput,
  OUTPUT_SCHEMA_BY_MODULE,
  OUTPUT_SCHEMA_FAMILIES,
  PENDING_OUTPUT_SCHEMA_MODULES,
  PROSE_ONLY_MODULES,
  installTruncationBoundary,
  listStructuredContent,
  paginationInfo,
} from '../src/shaping.js';
import { requiredConfirmationRefusal } from '../src/tools/confirm.js';
import { withMarketSource } from '../src/markets.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS_DIR = join(ROOT, 'src', 'tools');

// ---------------------------------------------------------------------------
// Source scanner: which modules can produce a prose-only result?
// ---------------------------------------------------------------------------

/**
 * Blank every string literal and comment while PRESERVING byte offsets, so a
 * match index found in the scrubbed source points at the same place in the
 * original.
 *
 * Written as one left-to-right pass rather than a chain of `replace` calls
 * because the naive order is wrong in a way that hides prose-only sites: a
 * double-quoted description containing an apostrophe (`"the user's Liked
 * Songs"`) makes a naive single-quote stripper run on to the next apostrophe,
 * delete real code, and report the module as CLEAN. A scanner that under-reports
 * is worse than no scanner, because the list it produces looks authoritative.
 */
function scrubCode(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      let j = i;
      while (j < source.length && source[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      let j = i + 2;
      while (j < source.length && !(source[j] === '*' && source[j + 1] === '/')) j++;
      blank(i, Math.min(j + 2, source.length));
      i = j + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === quote) break;
        // An unterminated single-line string stops at the newline rather than
        // eating the rest of the file; a template literal legitimately spans
        // lines and is not cut.
        if (quote !== '`' && source[j] === '\n') break;
        j++;
      }
      blank(i, Math.min(j + 1, source.length));
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

/** Index just past the bracket matching the one at `open`. -1 when unbalanced. */
function bracketEnd(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** How many arguments a call at `open` (the `(`) actually passes. */
function argumentCount(code: string, open: number): number {
  let depth = 0;
  let commas = 0;
  let sawContent = false;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') {
      // A bracket at depth 1 IS argument content — `textResult(prose, {a: 1})`
      // passes a payload. Counting only top-level commas reported that
      // two-argument call as zero-argument, because the `{` branch `continue`d
      // before `sawContent` could be set, and a payload-bearing `textResult`
      // is the opposite of the marker this scanner is looking for.
      if (depth === 1) sawContent = true;
      depth++;
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return sawContent ? commas : 0;
      continue;
    }
    if (depth !== 1) continue;
    if (c === ',') { commas++; continue; }
    if (!/\s/.test(c)) sawContent = true;
  }
  return 0;
}

/** Index of the bracket matching the one at `open`, or -1 when unbalanced. */
function spanEnd(code: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  for (let i = open; i < code.length; i++) {
    const c = code[i]!;
    if (c === '(' || c === '[' || c === '{') { stack.push(pairs[c]!); continue; }
    if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/**
 * The parameter names of `(a: T, b?: U)`, splitting on TOP-LEVEL commas only.
 *
 * `<` and `>` count as brackets here — `Record<string, unknown>` is one
 * parameter, not two — but `=>` must not, and the naive version got that wrong
 * and reported every parameter after the first arrow function at the wrong
 * depth. That is not a cosmetic bug: an emitter whose payload parameter was
 * dropped is an emitter whose optional payload the scanner cannot see, and
 * #1495 is precisely that failure arriving by another route.
 */
function parameterNames(params: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < params.length; i++) {
    const c = params[i]!;
    const prev = i > 0 ? params[i - 1]! : '';
    const opensAngle = c === '<' && /[\w$>]/.test(prev) && params[i + 1] !== '=' && params[i + 1] !== '<';
    const closesAngle = c === '>' && prev !== '=' && /[\w$)\]]/.test(prev);
    if (c === '(' || c === '[' || c === '{' || opensAngle) { depth++; current += c; continue; }
    if (c === ')' || c === ']' || c === '}' || closesAngle) { depth--; current += c; continue; }
    if (c === ',' && depth === 0) { names.push(current); current = ''; continue; }
    current += c;
  }
  if (current.trim()) names.push(current);
  return names
    .map((p) => p.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').trim())
    // `b?: U` — the `?` sits BEFORE the annotation, so it has to come off
    // after the `:` split, not before it.
    .map((p) => p.split(':')[0]!.replace(/\?$/, '').split('=')[0]!.trim())
    .filter((p) => /^[A-Za-z_$][\w$]*$/.test(p));
}

/**
 * The `{` that opens a function BODY, skipping an object-literal RETURN TYPE.
 *
 * `function f(): { content: Foo[] } { return {…} }` — the first brace after the
 * parameter list is the return type, and reading it for the body silently hides
 * every result the function builds. `moodexpand.samplingFailed` is written that
 * way, and taking its annotation for its body left its real body unattributed:
 * a blind spot in the fix for blind spots.
 */
function bodyBrace(code: string, paramsEnd: number): number {
  let i = paramsEnd + 1;
  while (i < code.length) {
    if (code[i] === '(' || code[i] === '[') {
      const end = spanEnd(code, i);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (code[i] === '{') {
      let back = i - 1;
      while (back >= 0 && /\s/.test(code[back]!)) back--;
      if (back >= 0 && code[back] === ':') {
        const end = spanEnd(code, i);
        if (end < 0) return -1;
        i = end + 1;
        continue;
      }
      return i;
    }
    i++;
  }
  return -1;
}

interface BraceSpan { readonly start: number; readonly end: number; readonly keys: readonly string[] }

/**
 * Every balanced `{…}` in `code`, with its TOP-LEVEL keys, in one pass.
 *
 * The question the emitter rules ask is "are `content` and `structuredContent`
 * keys of the SAME object literal?", and that cannot be answered by searching
 * outward from one key: a decorator returns `{…output, structuredContent:
  payload, …(cond ? { content: output.content.map(…) } : {})}`, where the
 * `content` key and the `structuredContent` key are in different literals and
 * the enclosing one is a statement, not a value. A backward `lastIndexOf('{')`
 * answers that question with a different question's answer.
 */
function braceSpans(code: string): BraceSpan[] {
  const spans: BraceSpan[] = [];
  const stack: number[] = [];
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '{') { stack.push(i); continue; }
    if (code[i] !== '}') continue;
    const start = stack.pop();
    if (start === undefined) continue;
    const body = code.slice(start + 1, i);
    const keys: string[] = [];
    let depth = 0;
    let token = '';
    const flush = (): void => {
      if (token.trim()) {
        const m = /^\s*['"`]?([A-Za-z_$][\w$]*)['"`]?\s*:/.exec(token);
        if (m) keys.push(m[1]!);
      }
      token = '';
    };
    for (let k = 0; k < body.length; k++) {
      const c = body[k]!;
      const prev = k > 0 ? body[k - 1]! : '';
      const opensAngle = c === '<' && /[\w$>]/.test(prev) && body[k + 1] !== '=' && body[k + 1] !== '<';
      const closesAngle = c === '>' && prev !== '=' && /[\w$)\]]/.test(prev);
      if (c === '(' || c === '[' || c === '{' || opensAngle) { depth++; token += c; continue; }
      if (c === ')' || c === ']' || c === '}' || closesAngle) { depth--; token += c; continue; }
      if (depth === 0 && (c === ',' || c === ';' || /\s/.test(c))) { flush(); continue; }
      token += c;
    }
    flush();
    spans.push({ start, end: i, keys });
  }
  return spans.sort((a, b) => (a.start - b.start) || (b.end - a.end));
}

/**
 * A module-local function that builds a tool result, and whether the payload
 * it attaches is optional.
 *
 * `never` attaches no payload at all, so every call site is prose-only.
 * `always` puts `content` and `structuredContent` in the same literal, so no
 * call site is. `conditional` — the `textOut` shape, and the one #1495 is
 * about — attaches the payload from a PARAMETER, so a call that omits that
 * parameter returns prose.
 */
interface LocalEmitter {
  readonly name: string;
  readonly exported: boolean;
  readonly declStart: number;
  /** Offset of the function NAME — the one match that is not a call site. */
  readonly nameStart: number;
  readonly declEnd: number;
  readonly kind: 'never' | 'always' | 'conditional';
  /** Index of the parameter that decides `structuredContent`, when conditional. */
  readonly payloadIndex: number;
}

function localEmitters(code: string, spans: readonly BraceSpan[]): LocalEmitter[] {
  const emitters: LocalEmitter[] = [];
  for (const m of code.matchAll(/(?<![\w$.])function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const paramsOpen = code.indexOf('(', m.index);
    const paramsEnd = bracketEnd(code, paramsOpen);
    if (paramsEnd < 0) continue;
    const brace = bodyBrace(code, paramsEnd);
    if (brace < 0) continue;
    const bodyEnd = spanEnd(code, brace);
    if (bodyEnd < 0) continue;
    const own = spans.filter((s) => s.start >= brace && s.end <= bodyEnd);
    // A result CONSTRUCTOR: a literal whose `content` is an array literal.
    // `content: output.content.map(…)` is a decorator rewriting somebody
    // else's result, and reading it as an emitter is how a prose-safe module
    // gets misfiled the other way.
    const builds = own.some(
      (s) => s.keys.includes('content') && /\bcontent\s*:\s*\[/.test(code.slice(s.start, s.end + 1)),
    );
    if (!builds) continue;
    const body = code.slice(brace, bodyEnd + 1);
    const sharesLiteral = own.some((s) => s.keys.includes('content') && s.keys.includes('structuredContent'));
    const kind: LocalEmitter['kind'] = !/structuredContent/.test(body)
      ? 'never'
      : sharesLiteral
        ? 'always'
        : 'conditional';
    let payloadIndex = -1;
    if (kind === 'conditional') {
      // The identifier the body hands to `structuredContent`. When it is a
      // parameter, a call that omits it cannot have a payload to attach.
      const assigned = new Set<string>();
      for (const a of body.matchAll(/structuredContent\s*=\s*([A-Za-z_$][\w$]*)/g)) assigned.add(a[1]!);
      for (const a of body.matchAll(/structuredContent\s*:\s*([A-Za-z_$][\w$]*)/g)) assigned.add(a[1]!);
      payloadIndex = parameterNames(code.slice(paramsOpen + 1, paramsEnd)).findIndex((p) => assigned.has(p));
    }
    const name = m[1]!;
    const exported = new RegExp(`(?:^|[;}\\s])export\\s+function\\s+${name}\\s*\\(`)
      .test(code.slice(Math.max(0, m.index - 8), m.index + name.length + 12));
    emitters.push({
      name,
      exported,
      declStart: m.index,
      nameStart: code.indexOf(name, m.index),
      declEnd: bodyEnd,
      kind,
      payloadIndex,
    });
  }
  return emitters;
}

/** Named imports of a SIBLING `src/tools` module, as local name -> `src/tools/x.ts`. */
function siblingImports(source: string): Map<string, string> {
  // Module specifiers are string literals, and `scrubCode` blanks those, so
  // the import graph is read from a comments-only scrub.
  const code = scrubComments(source);
  const imports = new Map<string, string>();
  for (const m of code.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'\.\/([\w$]+)\.js'/g)) {
    for (const raw of m[1]!.split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop()!.trim();
      if (name) imports.set(name, `src/tools/${m[2]}.ts`);
    }
  }
  return imports;
}

/** Blank comments only, preserving byte offsets. */
function scrubComments(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') { let j = i; while (j < source.length && source[j] !== '\n') j++; blank(i, j); i = j; continue; }
    if (c === '/' && next === '*') {
      let j = i + 2;
      while (j < source.length && !(source[j] === '*' && source[j + 1] === '/')) j++;
      blank(i, Math.min(j + 2, source.length));
      i = j + 2;
      continue;
    }
    i++;
  }
  return out.join('');
}

interface ModuleMarkers {
  readonly file: string;
  readonly registers: number;
  readonly proseOnly: boolean;
  readonly reasons: string[];
  /**
   * Results the scanner could not account for — the third verdict (#1495).
   *
   * Non-empty means "I could not classify this module", which is NOT the same
   * as `proseOnly: false` and must never be allowed to read as it. A module
   * listed here fails by name.
   */
  readonly unclassified: string[];
}

interface SourceScan {
  readonly file: string;
  readonly source: string;
  readonly code: string;
  readonly spans: readonly BraceSpan[];
  readonly emitters: readonly LocalEmitter[];
  readonly registers: number;
  readonly reasons: string[];
  readonly unclassified: string[];
}

/**
 * Every module, with the prose-only markers found in it and — the part #1495 is
 * about — a verdict for every result it could not account for.
 *
 * The markers are the mechanisms this tree uses to build a result with no
 * `structuredContent`. Each is a necessary-not-sufficient signal, and the union
 * is used as a superset: over-reporting costs a module its declaration,
 * under-reporting costs a production call.
 *
 * ## Why this takes sources and not a directory
 *
 * Because the rules below have to be shown the shapes they exist to catch.
 * Scanning a directory proves they work on today's tree, which is the same
 * mistake as a guard that has only ever been shown the correct input. Passing
 * a synthetic module through the SAME code path is what turns "the regex looks
 * right" into "the regex has met this case" — see the fixtures below.
 */
function scanToolSources(sources: ReadonlyMap<string, string>): ModuleMarkers[] {
  const scans: SourceScan[] = [...sources].map(([name, source]) => {
    const code = scrubCode(source);
    const spans = braceSpans(code);
    const reasons: string[] = [];
    // Both registration APIs count, and the RECEIVER does not have to be named
    // `server`. The positional `x.tool(name, …)` and the config-object
    // `x.registerTool(name, …)` are not interchangeable, and a scanner that
    // only reads one of them silently reports `playlistbatch.ts` and
    // `playlistops.ts` as empty modules. Requiring the literal `server.` is the
    // same mistake one level up: `statsfm_taste.ts` registers through a local
    // `registerCanonicalTool` helper that calls `s.tool(...)`, and a scanner
    // that misses it reports the module as registering nothing — which is what
    // silently exempted that module from the prose-safe check below.
    const registers = [...code.matchAll(/(?<![\w.])(?:[\w$]+\.(?:tool|registerTool)|registerTool)\s*\(/g)].length;
    if (/(?<![\w.$])MUTATION_EMIT(?![\w$])/.test(code)) reasons.push('MUTATION_EMIT');
    if (/proseCarriesPayload\s*:\s*false/.test(code)) reasons.push('proseCarriesPayload:false');
    if (/(?<![\w.$])renderSingle\s*\(/.test(code)) reasons.push('renderSingle()');
    for (const m of code.matchAll(/(?<![\w.$])textResult\s*\(/g)) {
      if (argumentCount(code, m.index + m[0].length - 1) === 0) { reasons.push('textResult(prose)'); break; }
    }
    for (const m of code.matchAll(/\breturn\s*\{/g)) {
      const open = code.indexOf('{', m.index);
      const end = bracketEnd(code, open);
      if (end < 0) continue;
      const body = code.slice(open, end + 1);
      if (/\bcontent\s*:/.test(body) && !/structuredContent\s*:/.test(body)) {
        reasons.push('return { content }');
        break;
      }
    }
    return {
      file: `src/tools/${name}`,
      source,
      code,
      spans,
      emitters: localEmitters(code, spans),
      registers,
      reasons,
      unclassified: [] as string[],
    };
  });
  const byFile = new Map(scans.map((s) => [s.file, s]));

  for (const scan of scans) {
    // Emitters this module can reach: its own, plus the ones it IMPORTS. The
    // second half is the same blind spot one level up — `taste_playlist.ts`
    // calls `textOut` from `taste_composites.ts`, and a scanner that resolved
    // emitters per file would check the seven call sites it can see and say
    // nothing about the other half of the contract.
    const reachable: Array<{ emitter: LocalEmitter; from: string | null }> =
      scan.emitters.map((emitter) => ({ emitter, from: null }));
    for (const [local, target] of siblingImports(scan.source)) {
      const found = byFile.get(target)?.emitters.find((e) => e.name === local && e.exported);
      if (found) reachable.push({ emitter: found, from: target });
    }

    for (const { emitter, from } of reachable) {
      const label = `${from ? 'imported emitter' : 'local emitter'} ${emitter.name}()`;
      if (emitter.kind === 'never') {
        scan.reasons.push(`${label} attaches no payload`);
        continue;
      }
      if (emitter.kind !== 'conditional') continue;
      if (emitter.payloadIndex < 0) {
        // The body attaches `structuredContent` from somewhere this scanner
        // cannot name, so it cannot say which call sites lose it. Reporting
        // "I cannot classify this" is the whole point (#1495).
        scan.unclassified.push(`${label} attaches structuredContent from no parameter the scanner can name`);
        continue;
      }
      const calls: number[] = [];
      for (const c of scan.code.matchAll(new RegExp(`(?<![\\w$.])${emitter.name}\\s*\\(`, 'g'))) {
        // The declaration's own name is not a call site. Matching on the NAME
        // offset rather than `declStart` is what makes this exact: a recursive
        // call inside the body is a real call site, and skipping to `declEnd`
        // would drop it.
        if (!from && c.index === emitter.nameStart) continue;
        const open = scan.code.indexOf('(', c.index);
        if (open < 0) continue;
        calls.push(argumentCount(scan.code, open) + 1);
      }
      const prose = calls.filter((n) => n <= emitter.payloadIndex);
      if (prose.length) {
        scan.reasons.push(`${label} prose-only at ${prose.length}/${calls.length} call site(s)`);
      }
    }

    // Attribution: every result literal must sit inside a function this scanner
    // resolved. One that does not is a construction shape nobody has taught the
    // scanner, and the honest answer is "I cannot classify this", not "safe".
    for (const s of scan.spans) {
      if (!s.keys.includes('content')) continue;
      if (!/\bcontent\s*:\s*\[/.test(scan.code.slice(s.start, s.end + 1))) continue;
      const owned = scan.emitters.some((e) => e.declStart < s.start && s.end < e.declEnd);
      if (!owned) {
        scan.unclassified.push(`a content literal is in no function this scanner resolved as an emitter`);
      }
    }
  }

  return scans.map((s) => ({
    file: s.file,
    registers: s.registers,
    proseOnly: s.reasons.length > 0,
    reasons: s.reasons,
    unclassified: s.unclassified,
  }));
}

/** The real tree: every `.ts` under `src/tools`, keyed by file name. */
function readToolSources(): Map<string, string> {
  return new Map(
    readdirSync(TOOLS_DIR)
      .filter((f) => f.endsWith('.ts'))
      .sort()
      .map((f) => [f, readFileSync(join(TOOLS_DIR, f), 'utf8')] as const),
  );
}

function scanToolModules(): ModuleMarkers[] {
  return scanToolSources(readToolSources());
}

// ---------------------------------------------------------------------------
// A real registry
// ---------------------------------------------------------------------------

/**
 * The production registry, built the way `startMcpServer` builds it: every
 * manifest module, unconditionally, so the classification is checked against
 * the whole surface rather than the trimmed default.
 */
async function buildRegistry(): Promise<McpServer> {
  const server = new McpServer({ name: 'output-schema-test', version: '0.0.0' });
  const client = {
    get: async () => null,
    post: async () => null,
    put: async () => null,
    delete: async () => null,
    getAllPages: async () => [],
    getRateLimitStatus: () => ({ lastThrottleAt: null, retryAfterSec: null, cooldownRemainingMs: 0 }),
  } as never;
  const context = { readOnly: false, isModuleActive: () => true, scopeBlocked: () => false };
  const loaded = await loadManifestRegistrars(REGISTRAR_MANIFEST, context);
  for (const module of loaded) registerManifestModule(server, client, module, context);
  return server;
}

async function wireTools(server: McpServer): Promise<Record<string, unknown>[]> {
  installToolErrorBoundary(server);
  const client = new Client({ name: 'output-schema-wire', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const tools = (await client.listTools()).tools as unknown as Record<string, unknown>[];
  await client.close();
  await server.close();
  return tools;
}

// ---------------------------------------------------------------------------

describe('#687 every tool module is classified for outputSchema', () => {
  it('the three sets are disjoint, and every registering module is in one of them', async () => {
    const declared = Object.keys(OUTPUT_SCHEMA_BY_MODULE);
    const prose = [...PROSE_ONLY_MODULES];
    const pending = [...PENDING_OUTPUT_SCHEMA_MODULES];

    const overlap = declared.filter((m) => prose.includes(m) || pending.includes(m));
    assert.deepEqual(overlap, [], 'a module cannot be both declared and excluded');

    const server = await buildRegistry();
    try {
      const registered = REGISTRAR_MANIFEST
        .filter((module) => moduleToolNames(server, module.key).length > 0)
        .map((module) => module.file);
      const unclassified = registered.filter(
        (file) => !declared.includes(file) && !prose.includes(file) && !pending.includes(file),
      );
      assert.deepEqual(
        unclassified,
        [],
        'every module that registers a tool must be declared, prose-only, or verified-safe-and-pending',
      );

      // A set entry for a module that registers nothing is dead weight that
      // reads as coverage. Every toolset-trimmed module legitimately has no
      // names, so this asserts the reverse direction: nothing is registered
      // outside the three sets (asserted above) AND nothing is classified
      // against a module that does not exist.
      const manifestFiles = new Set(REGISTRAR_MANIFEST.map((module) => module.file));
      const unknown = [...declared, ...prose, ...pending].filter((file) => !manifestFiles.has(file));
      assert.deepEqual(unknown, [], 'a classified module that is not in the registrar manifest');
    } finally {
      await server.close().catch(() => undefined);
    }
  });

  it('a module that registers a tool and is in no set fails startup', async () => {
    // The gate has to be shown to fire, not just described. This drives the
    // real pass over a real registry with one declared module's family removed
    // from the map, and asserts the refusal names it.
    //
    // The alternative — asserting the error STRING contains a substring — would
    // pass if the pass threw for an unrelated reason, which is the failure
    // mode AGENTS.md §6 calls "a test that cannot fail".
    // The target is derived from the live map, not named: a hardcoded module
    // silently stops being a declared one when the rollout moves it to
    // PENDING, and the test then fails on its own precondition instead of
    // proving the gate — which is how it would have read as still working.
    const [target, original] = Object.entries(OUTPUT_SCHEMA_BY_MODULE)[0] ?? [];
    assert.ok(original, 'precondition: at least one module is declared');
    const server = await buildRegistry();
    try {
      // The REAL pass, with only its resolver swapped. This used to drive a
      // hand-copied loop in this file, on the grounds that a copy "would prove
      // nothing about the thing that runs at startup" — while proving exactly
      // that nothing. Deleting the `throw` from the production function left
      // all 5,142 tests green. The resolver is the only thing that varies
      // between the production call and this one, so it is the only thing
      // injected.
      const shrunk = new Map(Object.entries(OUTPUT_SCHEMA_BY_MODULE));
      shrunk.delete(target as string);
      assert.throws(
        () => applyToolOutputSchemas(server, (file) => shrunk.get(file)),
        (error: unknown) =>
          error instanceof Error
          && /unclassified for outputSchema/.test(error.message)
          && error.message.includes(target),
        'dropping a module from every classification must fail startup by name',
      );
    } finally {
      await server.close().catch(() => undefined);
    }
  });
});

describe('#687 the prose-only classification matches the sources', () => {
  it('no module listed as prose-only is free of prose-only markers', () => {
    // One direction: every module the hand list excludes must really have a
    // prose-only path. If the list is over-eager, a module loses a declaration
    // it could have had — annoying, and visible here.
    const scanned = new Map(scanToolModules().map((m) => [m.file, m]));
    const unsupported: string[] = [];
    for (const file of PROSE_ONLY_MODULES) {
      const found = scanned.get(file);
      if (!found) { unsupported.push(`${file} (no such module)`); continue; }
      if (!found.proseOnly) unsupported.push(`${file} (markers: none)`);
    }
    assert.deepEqual(
      unsupported,
      [],
      'PROSE_ONLY_MODULES must name modules that really have a prose-only path; the source scan finds none',
    );
  });

  it('no module believed prose-safe has a prose-only marker', () => {
    // The dangerous direction, and it covers BOTH sets that claim a module is
    // safe. `PENDING_OUTPUT_SCHEMA_MODULES` is not an exemption: "verified safe,
    // awaiting headroom" is a claim, and a module carrying a prose path does
    // not become safe by waiting. Scoping this to the declared set alone is
    // what let a misfiled `playback.ts` — the one module that sets
    // `proseCarriesPayload: false` — pass as pending.
    //
    // This used to read `scanToolModules().filter((m) => m.registers > 0)`,
    // which is a silent exemption: a module the scanner cannot count a
    // registration for is dropped from the check entirely and the suite reports
    // green — the check did not pass, it did not run. `statsfm_taste.ts` is the
    // live case. The filter is gone; the coverage test below now proves every
    // classified module IS scanned, so dropping one cannot quietly pass here.
    const safe = new Set([...Object.keys(OUTPUT_SCHEMA_BY_MODULE), ...PENDING_OUTPUT_SCHEMA_MODULES]);
    const missing = scanToolModules()
      .filter((module) => safe.has(module.file) && module.proseOnly)
      .map((module) => `${module.file} (${module.reasons.join(', ')})`);
    assert.deepEqual(
      missing,
      [],
      'a module in OUTPUT_SCHEMA_BY_MODULE or PENDING_OUTPUT_SCHEMA_MODULES has a prose-only path; '
      + 'it belongs in PROSE_ONLY_MODULES',
    );
  });

  it('the scanner can see every classified module', () => {
    // The general guard for the check above. A prose-only path is found by
    // SCANNING source text, so a module whose registration the scanner cannot
    // match is invisible to every test in this file: not the prose-only list,
    // not the "believed prose-safe" check, not the declared check. Each of those
    // reads "this module is fine", and none of them looked.
    //
    // Asserting coverage of the scanner is the only assertion that survives a
    // future blind spot, because it does not depend on any individual marker
    // being recognised. This is the shape AGENTS.md §6 calls out — a guard that
    // has only ever been shown the correct input has not been shown to work.
    const scanned = new Map(scanToolModules().map((m) => [m.file, m]));
    const classified = [
      ...Object.keys(OUTPUT_SCHEMA_BY_MODULE),
      ...PENDING_OUTPUT_SCHEMA_MODULES,
      ...PROSE_ONLY_MODULES,
    ];
    const unseen: string[] = [];
    for (const file of classified) {
      const found = scanned.get(file);
      if (!found) unseen.push(`${file} (not on disk under src/tools)`);
      else if (found.registers === 0) unseen.push(`${file} (no registration the scanner can match)`);
    }
    assert.deepEqual(
      unseen,
      [],
      'a classified module the source scanner cannot see; the prose-only checks below it are silent about it',
    );
  });

  it('a declared module carries no prose-only marker at all', () => {
    // The property the whole exclusion list exists to protect, asserted on the
    // DECLARED modules separately so a failure names the more consequential of
    // the two cases: these tools break on that path today, where a pending
    // module only breaks when someone moves it.
    const scanned = new Map(scanToolModules().map((m) => [m.file, m]));
    const offenders: string[] = [];
    for (const file of Object.keys(OUTPUT_SCHEMA_BY_MODULE)) {
      const found = scanned.get(file);
      if (found?.proseOnly) offenders.push(`${file} (${found.reasons.join(', ')})`);
    }
    assert.deepEqual(offenders, [], 'a module publishing an outputSchema must never have a prose-only path');
  });
});

/**
 * The fixtures below are the point of the whole block.
 *
 * Everything above proves the scanner agrees with the classification on TODAY'S
 * tree. That is the same claim as "the regex looks right", and #1495 is what
 * that claim is worth: the tree already contained a module with four prose-only
 * paths that matched nothing, and every assertion in the file read it as safe.
 * So each rule is fed the shape it exists to catch, through the SAME
 * `scanToolSources` the real tree goes through, and a rule that stops
 * recognising its own case fails here.
 */
describe('#1495 "I could not classify this" is a failure, not a safe verdict', () => {
  /** One synthetic module, scanned exactly as a real one is. */
  const only = (name: string, source: string): ModuleMarkers[] =>
    scanToolSources(new Map([[name, source]]));

  it('a module-local emitter called without its payload is prose-only', () => {
    // The shape that hid `statsfm_taste.ts`: the object is built in one
    // statement and `structuredContent` is attached conditionally in another,
    // so no shared-emitter marker can see it. The call site is the only place
    // the answer lives, which is why the rule is about ARITY and not shape.
    const [found] = only('local-emitter.ts', `
      function textOut(lines: string[], structured?: Record<string, unknown>): ToolOut {
        const out: ToolOut = { content: [{ type: 'text', text: lines.join('\\n') }] };
        if (structured) out.structuredContent = structured;
        return out;
      }
      function handler(arg: string): ToolOut {
        if (!arg) return textOut(['nothing to show']);
        return textOut([arg], { ok: true });
      }
    `);
    assert.ok(found);
    assert.equal(found.proseOnly, true, 'an emitter called with no payload argument returns prose');
    assert.match(found.reasons.join(' '), /local emitter textOut\(\) prose-only at 1\/2 call site/);
    assert.deepEqual(found.unclassified, [], 'this module IS classifiable, and the scanner must say so');
  });

  it('the same emitter called with its payload everywhere is NOT prose-only', () => {
    // The other half, and the reason the rule is not "any local emitter". A
    // module that always passes the payload keeps its declaration; if this
    // ever goes red the scanner has started flagging emitters wholesale, which
    // is the over-eager failure that would quietly gut the rollout.
    const [found] = only('local-emitter-safe.ts', `
      function textOut(lines: string[], structured: Record<string, unknown>): ToolOut {
        return { content: [{ type: 'text', text: lines.join('\\n') }], structuredContent: structured };
      }
      function handler(arg: string): ToolOut {
        return textOut([arg], { ok: true });
      }
    `);
    assert.ok(found);
    assert.equal(found.proseOnly, false);
    assert.deepEqual(found.unclassified, []);
  });

  it('an IMPORTED optional-payload emitter is checked in the importing module', () => {
    // The same blind spot one level up. `taste_playlist.ts` calls `textOut`
    // from `taste_composites.ts`; a scanner that resolved emitters per file
    // would check the definition and say nothing about the seven call sites it
    // does not own — and "the definition is safe" is how a caller with a
    // payload-less call site reads as safe.
    const sources = new Map([
      ['emitter.ts', `
        export function textOut(lines: string[], structured?: Record<string, unknown>): ToolOut {
          const out: ToolOut = { content: [{ type: 'text', text: lines.join('\\n') }] };
          if (structured) out.structuredContent = structured;
          return out;
        }
      `],
      ['caller.ts', `
        import { textOut } from './emitter.js';
        function handler(arg: string): ToolOut {
          if (!arg) return textOut(['nothing to show']);
          return textOut([arg], { ok: true });
        }
      `],
    ]);
    const byFile = new Map(scanToolSources(sources).map((m) => [m.file, m]));
    const caller = byFile.get('src/tools/caller.ts');
    assert.ok(caller, 'the importing module is scanned');
    assert.equal(caller.proseOnly, true, 'the payload-less call site is in the CALLER, not the definition');
    assert.match(caller.reasons.join(' '), /imported emitter textOut\(\) prose-only/);
  });

  it('a result built where the scanner cannot see an emitter is unclassified, not safe', () => {
    // The general tripwire. An arrow emitter is a construction shape the
    // emitter resolver does not parse, so a module that grows one today would
    // read as prose-safe — the exact failure #1495 reports, wearing new
    // syntax. It has to be loud, and it has to be loud HERE, on a module the
    // scanner has never been shown, rather than only on the two it happened
    // to get right in the tree.
    const [found] = only('arrow-emitter.ts', `
      const textOut = (lines: string[]): ToolOut => ({ content: [{ type: 'text', text: lines.join('\\n') }] });
      function handler(arg: string): ToolOut {
        if (!arg) return textOut(['nothing to show']);
        return textOut([arg]);
      }
    `);
    assert.ok(found);
    assert.notDeepEqual(
      found.unclassified,
      [],
      'a result in an unresolved construction must be reported as unclassified',
    );
    assert.equal(
      found.proseOnly,
      false,
      'note the trap: proseOnly is false here, which is EXACTLY the verdict a '
      + 'safe module gets — which is why unclassified has to be its own failing answer',
    );
  });

  it('an emitter whose payload the scanner cannot name is unclassified', () => {
    // The same principle from the other side: the body attaches
    // `structuredContent` from something that is not a parameter, so no
    // arity rule can say which call sites lose it. Guessing would be the
    // under-reporting that costs a production call.
    const [found] = only('opaque-payload.ts', `
      function textOut(lines: string[], structured?: Record<string, unknown>): ToolOut {
        const out: ToolOut = { content: [{ type: 'text', text: lines.join('\\n') }] };
        if (structured) out.structuredContent = shape(structured);
        return out;
      }
      function handler(arg: string): ToolOut {
        return textOut([arg]);
      }
    `);
    assert.ok(found);
    assert.notDeepEqual(found.unclassified, []);
    assert.match(found.unclassified.join(' '), /no parameter the scanner can name/);
  });

  it('the real tree has no module the scanner cannot classify', () => {
    // The gate. If this is green because nothing in the tree is unclassified,
    // that is a measurement; if it is green because the check is not running,
    // it is a lie. Both arms are asserted — the count is reported so a future
    // reader can tell "zero unclassified" from "the loop found no modules".
    const scanned = scanToolModules();
    assert.ok(scanned.length > 60, `precondition: the real tree was scanned (got ${scanned.length} modules)`);
    const unclassified = scanned.flatMap((m) => m.unclassified.map((why) => `${m.file} — ${why}`));
    assert.deepEqual(
      unclassified,
      [],
      'a module the source scanner cannot classify; it is NOT prose-safe, and reporting it as such is the bug',
    );
  });
});

describe('#687 the declared families describe what the emitters really produce', () => {
  it('ListOutput accepts a real listStructuredContent payload', async () => {
    const payload = listStructuredContent(
      [{ uri: 'spotify:track:1', name: 'One' }],
      paginationInfo({ total: 40, offset: 0, limit: 1, returned: 1 }),
      { total: 40, truncated: true, returned: 1, remaining: 39 },
    );
    const parsed = await safeParseAsync(ListOutput, payload);
    assert.ok(parsed.success, `list payload rejected: ${JSON.stringify(parsed)}`);
    // The nested pagination block is real and is deliberately NOT declared
    // (budget). Assert it survives, so a future `.strict()` or a passthrough
    // removal shows up here rather than as a silently stripped field.
    assert.equal((parsed.data as Record<string, unknown>).items !== undefined, true);
  });

  it('ListOutput rejects a wrong-typed field — the schema has teeth', async () => {
    const parsed = await safeParseAsync(ListOutput, { items: 'not-an-array', total: 'many' });
    assert.equal(parsed.success, false, 'a schema that accepts anything is not a contract');
  });

  it('ListOutput accepts the truncation boundary’s own metadata shape', async () => {
    // `truncated`/`returned`/`total`/`remaining` are written by
    // `installTruncationBoundary`, not by a tool module, so a type drift there
    // would break every declared list tool at once and would not show up in a
    // test that only fed it `listStructuredContent` output.
    //
    // The payload below is therefore produced BY the boundary rather than typed
    // out beside it. The first version of this test parsed a hand-written
    // literal, which is the exact copy this repository's notes call out: it
    // asserted that a shape someone imagined matches a schema, and a change to
    // `installTruncationBoundary` — the very thing the test is named for —
    // would have left it green.
    const server = new McpServer({ name: 'output-schema-list-boundary', version: '0.0.0' });
    const boundary = installTruncationBoundary(server);
    server.registerTool(
      'probe_boundary_list',
      { inputSchema: { max_results: z.number().optional() } },
      async () => ({ content: [{ type: 'text', text: '' }] }),
    );

    const items = Array.from({ length: 57 }, (_, index) => ({ uri: `spotify:track:${index}` }));
    const shaped = boundary.shape(
      'probe_boundary_list',
      { max_results: 20 },
      {
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: listStructuredContent(items, { total: 57, offset: 0, limit: 20, returned: 20, next_offset: null }),
      },
    ) as { structuredContent?: Record<string, unknown> };

    // The boundary must actually have done the work, or the assertion below is
    // testing a payload nobody produced.
    assert.equal(shaped.structuredContent?.truncated, true, 'the boundary did not truncate');
    assert.equal(shaped.structuredContent?.total, 57);

    const parsed = await safeParseAsync(ListOutput, shaped.structuredContent);
    assert.ok(parsed.success, `boundary metadata rejected: ${JSON.stringify(parsed)}`);
  });

  it('MutationOutput accepts every real confirmation refusal', async () => {
    // The payloads `requiredConfirmationRefusal` builds for every gated write
    // (`src/tools/confirm.ts`), which is the most common non-success result a
    // declared mutation tool returns. Driven from the real function across all
    // three refusing verdicts: a hand-written literal here proved nothing about
    // the emitter, because mutating `refusalFor`'s payload left the test green.
    const previous = process.env.SPOTIFY_MCP_CONFIRM;
    delete process.env.SPOTIFY_MCP_CONFIRM;
    try {
      for (const verdict of ['unsupported', 'declined', 'error'] as const) {
        const refusal = requiredConfirmationRefusal(verdict);
        assert.ok(refusal, `${verdict} must refuse — it is not a confirmation`);
        const parsed = await safeParseAsync(MutationOutput, refusal.payload);
        assert.ok(parsed.success, `${verdict} refusal rejected: ${JSON.stringify(parsed)}`);
      }
      // `confirmed` is the one verdict that is not a refusal, and a family that
      // accepted it would be asserting nothing about the refusal shape.
      assert.equal(requiredConfirmationRefusal('confirmed'), null);
    } finally {
      if (previous === undefined) delete process.env.SPOTIFY_MCP_CONFIRM;
      else process.env.SPOTIFY_MCP_CONFIRM = previous;
    }
  });

  it('MutationOutput rejects a wrong-typed receipt', async () => {
    const parsed = await safeParseAsync(MutationOutput, { ok: 'yes', receipt: 42 });
    assert.equal(parsed.success, false, 'a mutation schema that accepts anything is not a contract');
  });

  it('CardOutput accepts what withMarketSource synthesizes for a prose render', async () => {
    // `withMarketSource` writes `structuredContent` onto a result that had
    // none (`src/markets.ts`), which is the one place a prose-mode result
    // acquires a payload. A card-declaring tool routed through it must not be
    // rejected for having no other fields.
    // A named variable rather than an inline literal: `withMarketSource`'s
    // constraint is a weak type (`{ structuredContent?: … }`), and a literal
    // carrying only `content` trips both excess-property and
    // no-properties-in-common checking before the constraint is applied.
    const proseOnly: {
      content: Array<{ type: 'text'; text: string }>;
      structuredContent?: Record<string, unknown>;
    } = { content: [{ type: 'text', text: 'x' }] };
    const synthesized = withMarketSource(proseOnly, { market: 'GB', source: 'argument' });
    const parsed = await safeParseAsync(CardOutput, synthesized.structuredContent);
    assert.ok(parsed.success, `market-sourced card rejected: ${JSON.stringify(parsed)}`);
  });

  it('every published family is an OPEN object', () => {
    // A closed `z.object()` becomes `additionalProperties: false` in the
    // projected schema, which would make a host validating strictly reject a
    // perfectly good payload over an endpoint-specific key. Every family is
    // `.passthrough()`; this asserts the property that survives the zod
    // conversion rather than the zod call.
    for (const [name, family] of Object.entries(OUTPUT_SCHEMA_FAMILIES)) {
      const shape = (family as unknown as { def?: Record<string, unknown> }).def;
      assert.ok(shape, `precondition: ${name} is a zod object`);
      const catchall = (shape as { catchall?: unknown }).catchall;
      assert.notEqual(
        catchall,
        undefined,
        `${name} must stay open (.passthrough()); a closed object breaks hosts on endpoint-specific keys`,
      );
    }
  });
});

describe('#687 the wire publishes the declaration', () => {
  it('declared tools carry outputSchema and excluded tools do not', async () => {
    const server = await buildRegistry();
    let tools: Record<string, unknown>[] = [];
    try {
      const applied = applyToolOutputSchemas(server);
      assert.ok(applied.declared > 0, 'precondition: the pass declared something');
      tools = await wireTools(server);
    } finally {
      await server.close().catch(() => undefined);
    }

    const byName = new Map(tools.map((tool) => [String(tool.name), tool]));
    const declaredNames = new Set(
      Object.keys(OUTPUT_SCHEMA_BY_MODULE).flatMap((file) => {
        const entry = REGISTRAR_MANIFEST.find((module) => module.file === file);
        if (!entry) return [];
        return moduleToolNames(server, entry.key) as unknown as string[];
      }),
    );
    assert.ok(declaredNames.size > 0, 'precondition: the declared modules own tools');

    const onWire = tools.filter((tool) => tool.outputSchema !== undefined).map((tool) => String(tool.name));
    assert.deepEqual(
      onWire.sort(),
      [...declaredNames].sort(),
      'exactly the declared modules’ tools publish an outputSchema',
    );

    for (const name of onWire) {
      const schema = byName.get(name)?.outputSchema as { type?: string; additionalProperties?: unknown };
      assert.equal(schema.type, 'object', `${name}: an output schema must describe an object`);
      assert.notEqual(
        schema.additionalProperties,
        false,
        `${name}: the published schema must be open, or a host rejects endpoint-specific keys`,
      );
    }
  });

  it('the declaration is a plain object, never a raw zod schema on the wire', async () => {
    const server = await buildRegistry();
    let sample: unknown;
    try {
      applyToolOutputSchemas(server);
      const tools = await wireTools(server);
      sample = tools.find((tool) => tool.outputSchema !== undefined)?.outputSchema;
    } finally {
      await server.close().catch(() => undefined);
    }
    assert.ok(sample && typeof sample === 'object', 'precondition: something was published');
    // A raw zod schema would survive `JSON.stringify` as an object with
    // `_def`/`def` internals and no `type`. Asserting the projected shape is
    // what a host reads is the assertion that catches a missing projection.
    assert.equal((sample as { type?: string }).type, 'object');
    assert.equal('$schema' in (sample as object), false, 'the draft marker is not published (#687)');
  });
});

describe('#687 the refusal is real, not inferred', () => {
  it('a declared-schema tool that returns no structuredContent is refused', async () => {
    // This is the premise the whole exclusion list rests on. It is proved here
    // against the pinned SDK with a live client, because if a future SDK
    // version stopped enforcing it, the prose-only classification would be
    // over-cautious rather than necessary — and nobody would know.
    const server = new McpServer({ name: 'prose-only-probe', version: '0.0.0' });
    server.registerTool(
      'probe_prose_only',
      { description: 'probe', inputSchema: {}, outputSchema: ListOutput },
      async () => ({ content: [{ type: 'text', text: 'just prose' }] }),
    );
    installToolErrorBoundary(server);

    const client = new Client({ name: 'prose-only-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: 'probe_prose_only', arguments: {} });
      // The refusal arrives as a typed envelope — the pinned SDK
      // validates `structuredContent` against the declared schema on the
      // CLIENT side, so a caller never receives the prose at all. Asserting
      // the SHAPE and not merely "something went wrong" is what distinguishes
      // "refused for the declared reason" from "failed for an unrelated
      // reason and happened to look like an error".
      //
      // The kind is `output_contract`, NOT `validation` (#687). The refusal is
      // the SERVER's payload failing the SERVER's own declaration: nothing the
      // caller sent is at fault. Reporting it as `validation` would tell a host
      // to fix arguments that were already correct — and the pair of tests in
      // this block is what holds that line, because the two arms of
      // `validateOutput` used to be classified differently (see below).
      const structured = (result as { structuredContent?: { error?: { tool?: string; kind?: string; reason?: string } } }).structuredContent;
      const error = structured?.error;
      assert.ok(error, `the declared-schema prose-only call must be refused; got ${JSON.stringify(result)}`);
      assert.equal(error.tool, 'probe_prose_only');
      assert.equal(error.kind, 'output_contract');
      assert.equal(error.reason, 'structured_content_failed_declared_output_schema');
      assert.equal(
        (result as { isError?: boolean }).isError,
        true,
        'a refused call must be marked as an error, not served as a normal result',
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('both arms of the refusal classify the same way', async () => {
    // The regression this pins, measured rather than reasoned about. `validateOutput`
    // throws two messages that differ only by a trailing clause:
    //
    //     Output validation failed for X                          (wrong-typed field)
    //     Output validation failed for X: structured content is required   (no payload)
    //
    // The unanchored `required` in the input-validation arm of `publicFailure`
    // matched the second and not the first, so the SAME server-side defect was
    // reported to the caller as `validation` ("received invalid arguments; pass
    // values that match the tool schema") on one arm and as `internal` on the
    // other. A host that acted on the first — changing arguments that were
    // already correct — would have failed identically forever.
    //
    // Asserting the two arms AGREE is what makes this a gate. Asserting only the
    // expected kind of one arm would have stayed green through the bug.
    const classify = async (name: string, handler: () => unknown) => {
      const server = new McpServer({ name: 'arm-probe', version: '0.0.0' });
      server.registerTool(name, { description: 'probe', inputSchema: {}, outputSchema: ListOutput }, handler as never);
      installToolErrorBoundary(server);
      const client = new Client({ name: 'arm-client', version: '0.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const result = (await client.callTool({ name, arguments: {} })) as {
          structuredContent?: { error?: { kind?: string; reason?: string; fix?: string } };
        };
        return result.structuredContent?.error;
      } finally {
        await client.close();
        await server.close();
      }
    };

    // Arm 1: a payload that violates the declared schema — `truncated` is a
    // string where the family declares a boolean.
    const wrongType = await classify('probe_wrong_type', async () => ({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { items: [], truncated: 'yes' },
    }));
    // Arm 2: no payload at all.
    const noPayload = await classify('probe_no_structured', async () => ({
      content: [{ type: 'text', text: 'just prose' }],
    }));

    assert.equal(wrongType?.kind, 'output_contract');
    assert.equal(noPayload?.kind, 'output_contract', 'the two arms of one defect must not classify differently');
    assert.equal(noPayload?.reason, wrongType?.reason);
    // Neither may hand the host the two pieces of advice that are wrong here:
    // the `validation` arm's "fix your input", and the `internal` arm's "retry
    // once". Both are compared as the exact strings the boundary uses, rather
    // than by matching the word "retry" — the honest fix string has to be able
    // to SAY that retrying will not help, and a regex broad enough to catch the
    // wrong advice would also catch the right one.
    for (const arm of [wrongType, noPayload]) {
      assert.notEqual(
        arm?.fix,
        'Pass values that match the tool schema.',
        'a server-side defect must not be reported as bad input',
      );
      assert.notEqual(
        arm?.fix,
        'Retry once; if the failure persists, inspect protected server diagnostics.',
        'a deterministic server-side defect must not be reported as worth retrying',
      );
    }
  });

  it('the same probe without a declaration answers normally', async () => {
    // The control. Without it, the assertion above would also pass against a
    // server that refused everything.
    const server = new McpServer({ name: 'undeclared-probe', version: '0.0.0' });
    server.tool('probe_undeclared', 'probe', {}, async () => ({ content: [{ type: 'text', text: 'just prose' }] }));
    installToolErrorBoundary(server);

    const client = new Client({ name: 'undeclared-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: 'probe_undeclared', arguments: {} });
      const text = (result as { content?: Array<{ text: string }> }).content?.[0]?.text ?? '';
      assert.equal(text, 'just prose', 'an undeclared prose-only tool must keep working');
      assert.equal((result as { isError?: boolean }).isError, undefined);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('#687 the acceptance criterion the issue states', () => {
  it('a tool returning structuredContent with no declared outputSchema is reported', async () => {
    // AC#3 verbatim: "a test fails when a tool returns structuredContent
    // without a declared outputSchema (with an explicit allow-list for legacy
    // tools)". The allow-list is the two exclusion sets; what is asserted here
    // is that the accounting is complete and that a tool moved out of
    // coverage is caught.
    const server = await buildRegistry();
    try {
      const applied = applyToolOutputSchemas(server);
      const registry = (server as unknown as {
        _registeredTools?: Record<string, { outputSchema?: unknown; enabled?: boolean }>;
      })._registeredTools ?? {};
      const live = Object.entries(registry).filter(([, entry]) => entry.enabled !== false);
      assert.equal(live.length, applied.total, 'precondition: the pass saw the whole registry');
      const withoutSchema = live.filter(([, entry]) => entry.outputSchema === undefined).map(([name]) => name);
      const allowed = new Set<string>();
      for (const file of [...PROSE_ONLY_MODULES, ...PENDING_OUTPUT_SCHEMA_MODULES]) {
        const entry = REGISTRAR_MANIFEST.find((module) => module.file === file);
        if (entry) for (const name of moduleToolNames(server, entry.key)) allowed.add(name);
      }
      const unaccounted = withoutSchema.filter((name) => !allowed.has(name));
      assert.deepEqual(
        unaccounted,
        [],
        'every tool without a declared outputSchema must be on the explicit legacy allow-list',
      );
      assert.ok(withoutSchema.length > 0, 'precondition: the rollout really is partial, and the allow-list is doing work');
    } finally {
      await server.close().catch(() => undefined);
    }
  });

  it('the families are zod objects, which is what the boundary can project', () => {
    // `finalOutputSchema` returns `undefined` for anything that is not a
    // zod-compatible object, and the boundary then publishes no `outputSchema`
    // at all — silently, with the tool counted as declared. Asserting the
    // family type is what closes that hole without calling the projection.
    for (const [name, family] of Object.entries(OUTPUT_SCHEMA_FAMILIES)) {
      assert.ok(
        family instanceof z.ZodType,
        `${name} must be a zod schema; anything else projects to no outputSchema at all`,
      );
    }
  });
});
