/**
 * #1423 — the bounded-read disclosure has ONE name, and this is the gate.
 *
 * ## The bug
 *
 * "I read N things and there may have been more" is the one thing in this
 * server a caller must be able to check, and it was reported under three
 * different field names. Worse, `items_read` meant two unrelated things:
 *
 * | Tool | Shipped | Counted |
 * |---|---|---|
 * | `merge_playlists` | `rows_read` / `reported_total` | playlist item rows |
 * | `remove_unavailable_playlist_items` | `rows_read` | playlist item rows |
 * | `playlist_balance` | `items_read` / `items_total` | playlist item rows — the SAME thing, differently named |
 * | `listening_streaks` | `items_read` | listening-history entries — a DIFFERENT thing, same name |
 *
 * A host rendering "showing 500 of 12,000" has to know all three spellings, and
 * gets `undefined` — not an error, not a flag — on whichever tool it guessed
 * wrong about. That is AGENTS.md §6's shape: a count that is perfectly real,
 * carried by a key the caller never looks for, so the shortfall reads as
 * "there was no shortfall".
 *
 * ## What the fix was, and what this file holds open
 *
 * `rows_read` / `reported_total` is now the convention, exported from
 * `src/shaping.ts` as `ROWS_READ_FIELD` / `REPORTED_TOTAL_FIELD` so the
 * expectation below is written once. `playlist_balance` moved onto it — both of
 * its old names were unreleased, so that cost no caller anything.
 *
 * `listening_streaks` KEEPS `items_read`. Two reasons, both load-bearing:
 *
 *  1. It counts a different thing. Its cap bounds a cursor walk of
 *     `/me/player/recently-played`; there is no collection total to sit beside
 *     it, and calling those history entries "rows" would be the same
 *     wrong-but-plausible naming in the other direction.
 *  2. **It shipped.** `git grep` over the `v2.1.0`, `v2.1.1` and `v2.1.2` tags
 *     finds `items_read` in `analytics.ts` in all three; `rows_read`,
 *     `items_total` and `requests_read` appear in none. The repo's deprecation
 *     path (`resolvePlaylistInput` / `withPlaylistInputMetadata` /
 *     `withPlaylistInputNote`) is shaped around tool INPUTS. There is no
 *     output-field equivalent, so renaming a released output field would break
 *     real callers with no migration behind the break. It is listed in
 *     `RELEASED_DISCLOSURE_EXCEPTIONS`, and the gate below holds that list
 *     honest rather than letting the exception exist by oversight.
 *
 * ## Why the gate observes registration instead of grepping
 *
 * The second half of this file is a registry-wide assertion, and the obvious
 * way to write it — `grep '\.tool('` over `src/tools/` — is wrong here in a way
 * this repo has already been bitten by. A literal-name grep MISSES 40 of the
 * 570 registered tools, because four registrar idioms are not a literal name:
 *
 *   - `server.registerTool('name', …)` — `merge_playlists`, a `rows_read`
 *     emitter, is registered this way and a `.tool(`-only grep never sees it;
 *   - `registerCanonicalTool(canonical, alias, …)` — eight `statsfm_*` tools;
 *   - `for (const cfg of <table>) { … .tool(cfg.name, …) }` — one declaration
 *     site, N tools (the `statsfm_*` per-entity and chart loops);
 *   - `<IMPORTED_TABLE>.forEach(<factory>)` — the seven `search_*`.
 *
 * So the tool set is observed where it is authoritative: every one of those
 * idioms bottoms out in a call to `server.tool` or `server.registerTool`, so
 * wrapping those two methods and running the real registrars (the same
 * technique `tests/mutations.conformance.test.ts` uses) yields the complete
 * name set with no parsing and no guessing about table contents.
 *
 * Source text is still scanned, because a name alone does not say which fields
 * a tool writes. That scan is validated against the observed set — every
 * registered tool must have a resolvable body — because a scanner that quietly
 * drops a registrar is worse than grep: it looks rigorous while asserting
 * nothing. The scanner resolves the same four idioms, and the coverage check
 * fails loudly with the exact missing names rather than a bare count.
 *
 * Run: node --import tsx --test tests/truncation-disclosure.test.ts
 */

import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerSwarm4PlaylistsTools } from '../src/tools/swarm4_playlists.js';
import { REGISTRAR_MANIFEST, loadManifestRegistrars } from '../src/tools/annotations.js';
import { StatefulPlaylistClient, trackUris } from './helpers/stub-client.js';
import { ROWS_READ_FIELD, REPORTED_TOTAL_FIELD, RELEASED_DISCLOSURE_EXCEPTIONS } from '../src/shaping.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const A = 'A'.repeat(22);

type ToolOut = {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};

interface RegisteredTool {
  name: string;
  description: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolOut>;
}

function harness() {
  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(name: string, description: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
      registered.push({ name, description, validate: (a) => z.object(schema).parse(a), handler });
    },
  } as unknown as McpServer;

  const stub = new StatefulPlaylistClient();
  registerSwarm4PlaylistsTools(fakeServer, stub as unknown as SpotifyClient);
  return {
    stub,
    seed: (id: string, rows: (string | null)[]) => stub.seedPlaylist(id, { rows }),
    descriptionOf: (name: string) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return tool.description;
    },
    invoke: async (name: string, args: Record<string, unknown>) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

const payloadOf = (out: ToolOut) => (out.structuredContent ?? {}) as Record<string, unknown>;

// ---------------------------------------------------------------------------
// Part 1 — the payload actually emits the convention's names.
// ---------------------------------------------------------------------------

describe('#1423 the disclosure a caller can predict', () => {
  it('a partial split reports the read and the source size under the convention names', async () => {
    // The behavioural half. Before the fix this payload carried `items_read`
    // and `items_total`; both assertions below were `undefined` against it, so
    // the test fails without the rename rather than merely passing beside it.
    const cap = Number(process.env.SPOTIFY_MCP_FETCH_ALL_CAP ?? 500);
    const h = harness();
    h.seed(A, trackUris(cap + 1));

    const payload = payloadOf(await h.invoke('playlist_balance', { playlist_id: A, parts: 3, dry_run: true }));

    assert.equal(payload[ROWS_READ_FIELD], cap, 'the walk reports how many rows it read');
    assert.equal(payload[REPORTED_TOTAL_FIELD], cap + 1, 'beside the source size, so the gap is computable');
    assert.equal(
      payload.items_read,
      undefined,
      '`items_read` must be gone: it is the same quantity under a second name, and a caller cannot tell which spelling a tool uses',
    );
    assert.equal(payload.items_total, undefined, '`items_total` is the same dead spelling for the total');
  });

  it('the tool description names the same fields the payload emits', () => {
    // A description that advertises a key the payload does not carry is the
    // same defect one channel over: the host reads the description, believes
    // the field exists, and renders `undefined` into the "showing N of M" slot.
    const description = harness().descriptionOf('playlist_balance');
    assert.match(description, new RegExp(ROWS_READ_FIELD));
    assert.match(description, new RegExp(REPORTED_TOTAL_FIELD));
    assert.doesNotMatch(description, /items_read|items_total/, 'and must not advertise a field it stopped emitting');
  });
});

// ---------------------------------------------------------------------------
// Part 2 — the registry gate. Observes registration, because grep cannot.
// ---------------------------------------------------------------------------

/**
 * Every tool name the real registrars produce, observed at the two registration
 * methods every registrar idiom bottoms out in. The stub client answers
 * nothing: no handler runs, because only registration is being watched.
 */
async function observeRegisteredToolNames(): Promise<Set<string>> {
  const stub = { get: async () => null } as unknown as SpotifyClient;
  const server = new McpServer({ name: 'disclosure-probe', version: '0.0.0' });
  const wrappable = server as unknown as {
    tool: (...args: unknown[]) => unknown;
    registerTool: (...args: unknown[]) => unknown;
  };
  const observed = new Set<string>();
  const origTool = wrappable.tool.bind(server);
  const origRegisterTool = wrappable.registerTool.bind(server);
  wrappable.tool = (...args: unknown[]) => { observed.add(args[0] as string); return origTool(...args); };
  wrappable.registerTool = (...args: unknown[]) => { observed.add(args[0] as string); return origRegisterTool(...args); };

  const resolved = await loadManifestRegistrars(REGISTRAR_MANIFEST, {
    readOnly: false,
    isModuleActive: () => true,
    scopeBlocked: () => false,
  });
  for (const { key, registrar } of resolved) {
    assert.ok(registrar, `${key} must be resolved before registration`);
    registrar(server, stub);
  }
  await server.close().catch(() => undefined);
  return observed;
}

/** Same length as input; string bodies and comments become spaces. */
function scrub(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && d === '*') { out += '  '; i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; } out += '  '; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += ' ';
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        if (src[i] === quote) { out += ' '; i += 1; break; }
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Index just past the bracketed run that starts at `at`. */
function bodyEnd(scrubbed: string, at: number): number {
  let depth = 0;
  for (let i = at; i < scrubbed.length; i += 1) {
    const c = scrubbed[i];
    if (c === '(' || c === '{' || c === '[') depth += 1;
    else if (c === ')' || c === '}' || c === ']') { depth -= 1; if (depth === 0) return i; }
  }
  return scrubbed.length;
}

/**
 * Map every registered tool to the source text of its registration.
 *
 * Resolves the four registrar idioms. The `name` in the table-driven cases is
 * read from the table itself rather than assumed, because assuming it is how a
 * gate ends up asserting over six of seven tools and calling that coverage.
 */
function readToolBodies(): Map<string, string> {
  const refs = readFileSync(join(REPO_ROOT, 'src/refs.ts'), 'utf8');
  const bodies = new Map<string, string>();
  const toolsDir = join(REPO_ROOT, 'src/tools');

  for (const file of readdirSync(toolsDir).filter((f) => f.endsWith('.ts'))) {
    const raw = readFileSync(join(toolsDir, file), 'utf8');
    const scrubbed = scrub(raw);

    // 1 + 2. a literal name, on either `tool` or `registerTool`.
    for (const m of raw.matchAll(/\.(?:tool|registerTool)\(\s*(['"`])([a-z0-9_]+)\1/g)) {
      bodies.set(m[2], raw.slice(m.index, bodyEnd(scrubbed, m.index)));
    }

    // 3. `registerCanonicalTool(canonical, alias, …)` in statsfm_taste.ts.
    for (const m of raw.matchAll(/\bregisterCanonicalTool\(\s*'([a-z0-9_]+)'\s*,\s*'([a-z0-9_]+)'/g)) {
      bodies.set(m[1], raw.slice(m.index, bodyEnd(scrubbed, m.index)));
    }

    // 4. `for (const cfg of <localTable>) { … .tool(cfg.name, …) }`.
    for (const m of raw.matchAll(/for\s*\(\s*const\s+\w+\s+of\s+([A-Za-z_$][\w$]*)\s*\)/g)) {
      const loopBody = raw.slice(m.index, bodyEnd(scrubbed, raw.indexOf('{', m.index)));
      if (!/\.(?:tool|registerTool)\(/.test(loopBody)) continue;
      const decl = raw.lastIndexOf(`const ${m[1]} =`, m.index);
      if (decl < 0 || m.index - decl > 4000) continue;
      for (const name of raw.slice(decl, m.index).matchAll(/name:\s*'([a-z0-9_]+)'/g)) {
        bodies.set(name[1], loopBody);
      }
    }

    // 5. `<IMPORTED_TABLE>.forEach(<factory>)` — the seven `search_*`.
    for (const m of raw.matchAll(/([A-Z_][A-Z0-9_]*)\.forEach\((\w+)\)/g)) {
      const fnAt = raw.indexOf(`function ${m[2]}(`);
      if (fnAt < 0) continue;
      const fnBody = raw.slice(raw.indexOf('{', fnAt), bodyEnd(scrubbed, raw.indexOf('{', fnAt)));
      const tableAt = refs.indexOf(`export const ${m[1]} =`);
      if (tableAt < 0) continue;
      for (const kind of refs.slice(tableAt, tableAt + 1200).matchAll(/'([a-z]+)'/g)) {
        const metaAt = raw.indexOf(`${kind[1]}: {`);
        if (metaAt < 0) continue;
        const toolName = raw.slice(metaAt, metaAt + 200).match(/tool:\s*'([a-z0-9_]+)'/)?.[1];
        if (toolName) bodies.set(toolName, fnBody);
      }
    }
  }
  return bodies;
}

/**
 * Which `<field>_total` keys each tool emits through `budgetedArray`'s computed
 * disclosure, resolved from the call sites rather than from a literal.
 *
 * This resolver exists because the first version of this gate missed the whole
 * mechanism and the full suite caught the miss. `items_total` appears NOWHERE
 * in `src/` as a literal — fifteen tools emit it as `` [`${field}_total`] ``
 * with `field` bound at the call site. A scanner that reads only literal keys
 * reports `items_total` as a dead spelling, which is the precise opposite of
 * the truth, and it is the spelling `playlist_balance` had wrongly borrowed.
 *
 * Only a call whose result is actually SPREAD (`…budget.disclosure`) reaches
 * the wire. `playlist_balance` calls `budgetedArray` and reads `.total` off the
 * result into a `bucket_totals` key of its own, so it is a *use* of the helper
 * and not an *emitter* — the same use-site/emitter-site gap that made a plain
 * grep wrong at the registrar level, one level down.
 */
function readBudgetedArrayEmitters(): Map<string, Set<string>> {
  const raw = readFileSync(join(REPO_ROOT, 'src/tools/swarm4_playlists.ts'), 'utf8');
  const fieldOf = new Map<string, string>();
  for (const m of raw.matchAll(/const\s+(\w+)\s*=\s*budgetedArray\(([^)]*)\)/g)) {
    const args = m[2].split(',');
    fieldOf.set(m[1], (args[2] ?? "'items'").trim().replace(/'/g, ''));
  }
  const tools = [...raw.matchAll(/\.(?:tool|registerTool)\(\s*'([a-z0-9_]+)'/g)];
  const emitters = new Map<string, Set<string>>();
  for (const m of raw.matchAll(/\.\.\.(\w+)\.disclosure/g)) {
    let owner = '(unknown)';
    for (let i = tools.length - 1; i >= 0; i -= 1) {
      if (tools[i].index < m.index) { owner = tools[i][1]; break; }
    }
    const field = fieldOf.get(m[1]);
    // An unresolved field is the case that must not vanish: it means a call
    // site grew an argument this resolver cannot read.
    const key = field ? `${field}_total` : '?';
    if (!emitters.has(owner)) emitters.set(owner, new Set());
    (emitters.get(owner) as Set<string>).add(key);
  }
  return emitters;
}


describe('#1423 the convention is gated over the registry, not swept once', () => {
  const bodies = readToolBodies();
  let registered: Set<string> = new Set();

  it('observes the real registry, and the scanner resolves every tool in it', async () => {
    // Everything below depends on this. A scanner that quietly fails to
    // resolve a registrar idiom would make every other assertion in this file
    // vacuous — it would pass by not looking. So the tool set comes from live
    // registration and the scanner is held to covering all of it, by name.
    registered = await observeRegisteredToolNames();
    assert.ok(registered.size > 0, 'the manifest must resolve some tools; an empty set proves nothing');

    // These three are the tools a `.tool(`-only grep cannot see at all, and
    // `merge_playlists` is a `rows_read` emitter, so a scanner that missed it
    // would not notice the defect it exists to prevent.
    assert.ok(bodies.has('merge_playlists'), 'registerTool(\'merge_playlists\', …) must resolve');
    assert.ok(bodies.has('search_tracks'), 'the IMPORTED_TABLE.forEach factory must resolve the search tools');
    assert.ok(bodies.has('statsfm_track_stats'), 'the local-table loop must resolve its three sibling tools');

    const missing = [...registered].filter((t) => !bodies.has(t)).sort();
    assert.deepEqual(missing, [], `scanner resolved ${bodies.size} tools; these registered ones have no body`);
  });

  it('no tool discloses a bounded read under `items_read` except the released exception', () => {
    // The half of #1423 that is a real wire-contract decision. `items_read` on
    // `playlist_balance` was unreleased and is renamed; `items_read` on
    // `listening_streaks` shipped in v2.1.0 and is argued for in
    // RELEASED_DISCLOSURE_EXCEPTIONS. A third appearance is the bug returning.
    const offenders = [...bodies.entries()]
      .filter(([, body]) => /\bitems_read\s*:/.test(body))
      .map(([name]) => name)
      .sort();

    assert.deepEqual(offenders, Object.keys(RELEASED_DISCLOSURE_EXCEPTIONS).sort());
  });

  it('every exemption is a real registered tool, with a reason recorded', () => {
    for (const [tool, reason] of Object.entries(RELEASED_DISCLOSURE_EXCEPTIONS)) {
      assert.ok(registered.has(tool), `${tool} is allowlisted but registers no tool — drop the entry`);
      assert.match(reason, /\S/, `${tool} needs a stated reason, not an empty string`);
    }
  });

  it('`items_total` stays the display-cap key and never becomes a walk-cap one again', () => {
    // The collision that made `playlist_balance`'s name wrong in the first
    // place, and the reason this is not a "the old spelling is dead" check.
    //
    // `items_total` is a LIVE, RELEASED key on fifteen playlist tools, and it
    // means something else entirely: `budgetedArray` emits
    // `` [`${field}_total`] `` to disclose what a per-call `max_results` cap
    // withheld from a DISPLAY list. It is not a walk cap and it has no
    // truncation verdict. `playlist_balance` was emitting it for the opposite
    // purpose — rows a bounded WALK could not fetch — which put one name on two
    // mechanisms. Renaming that tool onto `rows_read` / `reported_total` is
    // what separates them; these two assertions keep them separated.
    const emitters = readBudgetedArrayEmitters();
    const unresolved = [...emitters.entries()].filter(([, keys]) => keys.has('?')).map(([name]) => name);
    assert.deepEqual(unresolved, [], 'a budgetedArray call site grew an argument this resolver cannot read');

    // The display-cap family is a real contract; hold it to its real size so a
    // renamed field cannot quietly shrink it.
    const displayCapTools = [...emitters.entries()].filter(([, keys]) => keys.has('items_total')).map(([name]) => name);
    assert.ok(
      displayCapTools.length > 1,
      '`items_total` is expected to be a live display-cap key on several tools, not one; '
      + 'if the helper changed, re-measure rather than deleting this assertion',
    );

    // And the actual rule: no tool may carry both disclosures at once.
    const both = displayCapTools.filter((name) => /\brows_read\s*:/.test(bodies.get(name) ?? '')).sort();
    assert.deepEqual(
      both,
      [],
      'a tool carrying both `rows_read` (a walk cap) and the computed `items_total` (a display cap) '
      + 'has put one name on two mechanisms — that is what #1423 was',
    );
  });

  it('no tool writes `items_total` as a literal key', () => {
    // The computed form above is the only legitimate one. A literal
    // `items_total:` in a payload would be a hand-written key shadowing the
    // helper's, and nothing in the tree should be reaching for it.
    const hits: string[] = [];
    for (const file of readdirSync(join(REPO_ROOT, 'src/tools')).filter((f) => f.endsWith('.ts'))) {
      if (/items_total\s*:/.test(readFileSync(join(REPO_ROOT, 'src/tools', file), 'utf8'))) {
        hits.push(file);
      }
    }
    assert.deepEqual(hits, [], '`items_total` is only ever the computed `<field>_total` of the display-cap helper');
  });

  it('every `rows_read` disclosure is accompanied by a truncation verdict', () => {
    // A row count beside no `truncated` flag is the #6 shape again: a caller
    // cannot tell 500-of-500 from 500-of-12,000 without doing the comparison
    // itself, and the tool that read the verdict already had it in hand.
    // Both `truncated: x` and the `{ truncated }` shorthand count.
    const silent = [...bodies.entries()]
      .filter(([, body]) => /\brows_read\s*:/.test(body) && !/\btruncated\s*[:,]/.test(body))
      .map(([name]) => name)
      .sort();
    assert.deepEqual(silent, [], '`rows_read` with no `truncated` beside it discloses a count and not its scope');
  });
});
