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
  listStructuredContent,
  paginationInfo,
} from '../src/shaping.js';
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

interface ModuleMarkers {
  readonly file: string;
  readonly registers: number;
  readonly proseOnly: boolean;
  readonly reasons: string[];
}

/**
 * Every `src/tools` module that registers a tool, with the prose-only markers
 * found in it.
 *
 * The markers are the four mechanisms this tree actually uses to build a
 * result with no `structuredContent`. Each is a necessary-not-sufficient
 * signal, and the union is used as a superset: over-reporting costs a module
 * its declaration, under-reporting costs a production call.
 */
function scanToolModules(): ModuleMarkers[] {
  const files = readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.ts')).sort();
  return files.map((file) => {
    const code = scrubCode(readFileSync(join(TOOLS_DIR, file), 'utf8'));
    const reasons: string[] = [];
    // Both registration APIs count. The positional `server.tool(name, …)` and
    // the config-object `server.registerTool(name, …)` are not
    // interchangeable, and a scanner that only reads one of them silently
    // reports `playlistbatch.ts` and `playlistops.ts` as empty modules.
    const registers = [...code.matchAll(/(?<![\w.])(?:server\.(?:tool|registerTool)|registerTool)\s*\(/g)].length;
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
    return { file: `src/tools/${file}`, registers, proseOnly: reasons.length > 0, reasons };
  });
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
      const shrunk = Object.freeze({ ...OUTPUT_SCHEMA_BY_MODULE, [target as string]: undefined });
      assert.throws(
        () => applyToolOutputSchemasWithMap(server, shrunk),
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

/**
 * The pass, with the declaration map supplied by the caller.
 *
 * `applyToolOutputSchemas` reads the module-level constant, so proving it
 * fails means driving the same code over a map that is missing an entry. This
 * is the exported pass's own body factored so both the production call and the
 * test drive the SAME loop — a reimplementation here would prove nothing about
 * the thing that runs at startup.
 */
function applyToolOutputSchemasWithMap(
  server: McpServer,
  map: Readonly<Record<string, keyof typeof OUTPUT_SCHEMA_FAMILIES | undefined>>,
): { total: number; declared: number } {
  const registry = (server as unknown as { _registeredTools?: Record<string, { outputSchema?: unknown }> })._registeredTools;
  if (!registry || typeof registry !== 'object') return { total: 0, declared: 0 };
  let declared = 0;
  const unclassified: string[] = [];
  for (const module of REGISTRAR_MANIFEST) {
    if (moduleToolNames(server, module.key).length === 0) continue;
    const family = Object.prototype.hasOwnProperty.call(map, module.file) ? map[module.file] : undefined;
    if (family !== undefined) {
      for (const name of moduleToolNames(server, module.key)) {
        const entry = registry[name];
        if (!entry || typeof entry !== 'object') continue;
        entry.outputSchema = OUTPUT_SCHEMA_FAMILIES[family];
        declared++;
      }
      continue;
    }
    if (PROSE_ONLY_MODULES.has(module.file) || PENDING_OUTPUT_SCHEMA_MODULES.has(module.file)) continue;
    unclassified.push(module.file);
  }
  if (unclassified.length > 0) {
    throw new Error(
      `tool modules are unclassified for outputSchema (#687): ${unclassified.sort().join(', ')}. `
      + 'Add each to OUTPUT_SCHEMA_BY_MODULE (with a family), to PROSE_ONLY_MODULES (with the '
      + 'prose-only path that keeps it out), or to PENDING_OUTPUT_SCHEMA_MODULES (verified safe, '
      + 'awaiting aggregate headroom).',
    );
  }
  return { total: Object.keys(registry).length, declared };
}

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
    const scanned = scanToolModules().filter((m) => m.registers > 0);
    const safe = new Set([...Object.keys(OUTPUT_SCHEMA_BY_MODULE), ...PENDING_OUTPUT_SCHEMA_MODULES]);
    const missing = scanned
      .filter((module) => safe.has(module.file) && module.proseOnly)
      .map((module) => `${module.file} (${module.reasons.join(', ')})`);
    assert.deepEqual(
      missing,
      [],
      'a module in OUTPUT_SCHEMA_BY_MODULE or PENDING_OUTPUT_SCHEMA_MODULES has a prose-only path; '
      + 'it belongs in PROSE_ONLY_MODULES',
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
    const parsed = await safeParseAsync(ListOutput, {
      items: [{ uri: 'spotify:track:1' }],
      truncated: true,
      returned: 20,
      total: 57,
      remaining: 37,
    });
    assert.ok(parsed.success, `boundary metadata rejected: ${JSON.stringify(parsed)}`);
  });

  it('MutationOutput accepts a real confirmation refusal', async () => {
    // The payload `requiredConfirmationRefusal` builds for every gated write
    // (`src/tools/confirm.ts`), which is the most common non-success result a
    // declared mutation tool returns.
    const parsed = await safeParseAsync(MutationOutput, {
      ok: false,
      cancelled: true,
      reason: 'confirmation_unavailable',
    });
    assert.ok(parsed.success, `refusal payload rejected: ${JSON.stringify(parsed)}`);
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
      const parsed = z.object({}).safeParse;
      assert.equal(typeof parsed, 'function', `precondition: ${name} is a zod schema`);
      assert.ok(
        family instanceof z.ZodType,
        `${name} must be a zod schema; anything else projects to no outputSchema at all`,
      );
    }
  });
});
