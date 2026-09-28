/**
 * Error-message parameter names (#887).
 *
 * Five playlist tools told a caller to pass something they cannot pass. The
 * message said `--prefix`, `--values`, `--query`, `--artist`, `--market` — CLI
 * flags on a server that is reached over MCP, where there is no argv. An
 * agent that took one literally would look for a flag, find none, and either
 * invent a shell invocation or give up.
 *
 * Nothing about that failure is observable in a return value. The same call
 * raises the same error either way; only the text changes, and the text is
 * the whole of the remedy. So the guard is a source scan, in the same shape
 * as `tests/explicit-any-guard.test.ts` and `tests/artist-albums-limit-guard.test.ts`,
 * with the collector in `scripts/check-error-param-names.mjs` so the negative
 * cases can drive synthetic sources instead of asserting a stored verdict.
 *
 * Two halves, because either alone would be decoration:
 *
 *   • the source guard, holding the real tree at zero and firing on a flag or
 *     an undeclared name that comes back;
 *   • a behavioural half that calls the five tools for real and checks the
 *     message against the zod schema the tool was actually registered with —
 *     the strongest form of "names a parameter this tool declares", because it
 *     reads the same object a host sees rather than a re-parse of the source.
 *
 * The anti-vacuity cases matter most. A guard that silently stopped matching
 * would report zero violations for the rest of the repo's life and look like
 * a clean bill of health, so the collector is driven against synthetic sources
 * where the answer is known, and its reach over the real call sites is pinned
 * by name and count.
 */
import './helpers/hermetic.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';

import {
  blankNonCode,
  collectErrorParamViolations,
  collectModuleViolations,
  collectThrownMessages,
  isCommandLineModule,
  parameterVocabulary,
  registrations,
  stringLiterals,
  toolNameVocabulary,
} from '../scripts/check-error-param-names.mjs';
import { registerExhaust2PlaylistsTools } from '../src/tools/exhaust2_playlists.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOOLS_DIR = join(ROOT, 'src', 'tools');
const SRC_DIR = join(ROOT, 'src');

function walkSources(dir: string): Array<{ file: string; source: string }> {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => ({ file: relative(ROOT, join(dir, e.name)), source: readFileSync(join(dir, e.name), 'utf8') }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

const SOURCES = walkSources(TOOLS_DIR);
// The vocabulary spans every module under `src/`, not just the tool modules:
// a parameter declared by a shared zod shape in `src/shaping.ts` and spread
// into a tool is a declared parameter, and reading only the inline shapes
// called it undeclared (#1500). The spread is followed, so `src/shaping.ts`
// contributes only the field objects a registration actually spreads.
const ALL_SOURCES = walkTree(SRC_DIR);
const VOCAB = parameterVocabulary(ALL_SOURCES);
const TOOL_NAMES = toolNameVocabulary(ALL_SOURCES.map((s) => s.source));

/** A minimal registration whose handler raises the given message. */
const toolWith = (name: string, schema: string, handler: string) =>
  `server.tool(\n  '${name}',\n  'description',\n  {${schema}},\n  async (args) => {\n${handler}\n  },\n);\n`;

/** A vocabulary wide enough that a name can be a real parameter elsewhere. */
const SOMEWHERE_ELSE = new Set([
  'values', 'prefix', 'market', 'query', 'artist', 'keep_by', 'source_playlist_ids',
]);

test('#887 — the real tree names no un-passable flag and no undeclared parameter', () => {
  assert.ok(SOURCES.length > 20, `the walk found only ${SOURCES.length} tool modules, so this proves nothing`);

  const found = SOURCES.flatMap(({ file, source }) =>
    collectErrorParamViolations(source, file, VOCAB, TOOL_NAMES));

  assert.deepEqual(
    found,
    [],
    `an error message names something the caller cannot pass. Name the schema parameter:\n${found.join('\n')}`,
  );
});

test('#887 — the per-tool rules are keyed on a registration, so a shared module is not their scope', () => {
  // This is the limit #1500 widened past, pinned so the split stays visible:
  // `src/auth.ts` registers no MCP tools, so `collectErrorParamViolations` has
  // nothing to attribute a message to there. It is the module rule, not this
  // one, that reads it now — and the CLI exemption that keeps `auth --profile`
  // out of that rule is asserted in the #1500 block below.
  const auth = readFileSync(join(ROOT, 'src', 'auth.ts'), 'utf8');
  assert.match(auth, /Invalid --profile/);
  assert.equal(registrations(auth).length, 0, 'src/auth.ts registers no MCP tools, so nothing there is in scope');
  assert.deepEqual(
    collectErrorParamViolations(auth, 'src/auth.ts', VOCAB, TOOL_NAMES),
    [],
    'the per-tool rules must not reach a module that registers nothing',
  );
});

// ---------------------------------------------------------------------------
// Anti-vacuity. A guard that cannot fail reports zero violations forever.
// ---------------------------------------------------------------------------

test('#887 — the collector fires on a flag that comes back, and names the tool', () => {
  const source = toolWith('demo', "\n      prefix: z.string().optional(),\n    ", "    throw new Error('demo op requires --prefix');");
  const found = collectErrorParamViolations(source, 'src/tools/demo.ts', SOMEWHERE_ELSE);
  assert.equal(found.length, 1, `expected the flag to be caught, got: ${JSON.stringify(found)}`);
  assert.match(found[0]!, /demo: command-line flag syntax "--prefix"/);
});

test('#887 — the collector fires on a flag in a returned payload value, not only in a throw', () => {
  // The `try --market` case was a verdict string in structuredContent, never a
  // throw. A guard scoped to `throw` would have reported the tree clean while
  // the wrong advice was still reaching callers.
  const source = toolWith(
    'era_demo',
    "\n      market: MARKET_CODE.optional(),\n    ",
    "    const verdict = years.length === 0 ? 'UNKNOWN (try --market)' : 'CURRENT';\n    return { verdict };",
  );
  const found = collectErrorParamViolations(source, 'src/tools/era_demo.ts', SOMEWHERE_ELSE);
  assert.equal(found.length, 1, `expected the payload flag to be caught, got: ${JSON.stringify(found)}`);
  assert.match(found[0]!, /era_demo: command-line flag syntax "--market"/);
});

test('#887 — the collector fires on a parameter the throwing tool does not declare', () => {
  // The wrong-name form of the same defect: right sentence, wrong key. `market`
  // is a real parameter elsewhere and is not one of this tool's — a message
  // saying so sends the caller to edit their request and get nowhere.
  const source = toolWith(
    'keep_demo',
    "\n      keep_by: z.enum(['uris']).describe('mode'),\n      values: z.array(z.string()).optional(),\n    ",
    "    if (!args.values?.length) throw new Error('keep_by=uris requires `market`');",
  );
  const found = collectErrorParamViolations(source, 'src/tools/keep_demo.ts', SOMEWHERE_ELSE);
  assert.equal(found.length, 1, `expected the wrong name to be caught, got: ${JSON.stringify(found)}`);
  assert.match(found[0]!, /keep_demo: names "market", which keep_demo does not declare/);
});

test('#887 — a bare snake_case name is a claim too, and an ordinary word is not', () => {
  // `values` with the backticks stripped is still a name. A bare single word
  // is not: "create the playlist" must not be read as naming a `playlist`
  // parameter, or the guard would fire on ordinary English and get switched
  // off inside a release.
  const bare = toolWith(
    'bare_demo',
    "\n      keep_by: z.enum(['uris']).describe('mode'),\n    ",
    "    throw new Error('nothing to work from — provide source_playlist_ids');",
  );
  const found = collectErrorParamViolations(bare, 'src/tools/bare_demo.ts', SOMEWHERE_ELSE);
  assert.equal(found.length, 1, `expected the bare name to be caught, got: ${JSON.stringify(found)}`);
  assert.match(found[0]!, /bare_demo: names "source_playlist_ids"/);

  const prose = toolWith(
    'prose_demo',
    "\n      keep_by: z.enum(['uris']).describe('mode'),\n    ",
    "    throw new Error('no candidate tracks — save or play some first');",
  );
  assert.deepEqual(collectErrorParamViolations(prose, 'src/tools/prose_demo.ts', SOMEWHERE_ELSE), []);
});

test('#887 — the collector accepts a name the tool does declare', () => {
  const source = toolWith(
    'keep_ok',
    "\n      keep_by: z.enum(['uris']).describe('mode'),\n      values: z.array(z.string()).optional(),\n    ",
    "    if (!args.values?.length) throw new Error('keep_by=uris requires `values`');",
  );
  assert.deepEqual(collectErrorParamViolations(source, 'src/tools/keep_ok.ts', SOMEWHERE_ELSE), []);
});

test('#887 — a tool name is not a parameter claim', () => {
  // "run album_id first" names a tool. `album_id` is also a declared key of
  // real schemas, so without the exclusion this is a false positive waiting
  // for the next message that names a sibling tool.
  const source = toolWith(
    'delta_demo',
    "\n      snapshot_id: z.string().optional(),\n    ",
    "    throw new Error('No local backups found — run album_id first.');",
  );
  assert.ok(VOCAB.has('album_id'), 'test bug: album_id is not a real parameter name, so the case proves nothing');
  assert.ok(TOOL_NAMES.has('album_id'), 'test bug: album_id is not a real tool name, so the exclusion is untested');
  assert.deepEqual(collectErrorParamViolations(source, 'src/tools/delta_demo.ts', VOCAB, TOOL_NAMES), []);
  // …and the same message IS reported when the tool names are not passed in,
  // which is what proves the exclusion is doing the work.
  assert.equal(collectErrorParamViolations(source, 'src/tools/delta_demo.ts', VOCAB, new Set()).length, 1);
});

test('#887 — a flag in a comment, or outside any registration, is not a violation', () => {
  // This is the case a plain `grep --` gets wrong in both directions: it
  // flags prose, and it cannot tell a comment from a message.
  const source = [
    '// the old message said `--prefix`, which no caller can pass',
    "export const note = 'rewrite this --prefix usage';",
    toolWith('clean', "\n      prefix: z.string().optional(),\n    ", "    throw new Error('set `prefix` first');"),
  ].join('\n');
  assert.deepEqual(collectErrorParamViolations(source, 'src/tools/clean.ts', SOMEWHERE_ELSE), []);
});

test('#887 — a spread schema is opaque, so an unseen key is not called undeclared', () => {
  // `merge_playlists` spreads `playlistListInputFields` and friends. The scan
  // cannot see those keys, so claiming `target_playlist_id` is undeclared
  // would be guessing. Rule 1 still applies — it needs no schema.
  const source = toolWith(
    'spread_demo',
    "\n      ...sharedListFields,\n      response_format: ResponseFormat,\n    ",
    "    throw new Error('provide exactly one of `target_playlist_id` or `new_name`');",
  );
  const reg = registrations(source).find((r) => r.name === 'spread_demo');
  assert.ok(reg, 'the registration was not found at all');
  assert.equal(reg!.opaque, true, 'a spread schema should be reported as opaque');
  assert.deepEqual(collectErrorParamViolations(source, 'src/tools/spread_demo.ts', VOCAB, TOOL_NAMES), []);

  // The flag rule is independent of the schema, so it must still fire here.
  const flagged = toolWith(
    'spread_flag',
    "\n      ...sharedListFields,\n    ",
    "    throw new Error('pass --target to choose');",
  );
  assert.equal(collectErrorParamViolations(flagged, 'src/tools/spread_flag.ts', VOCAB, TOOL_NAMES).length, 1);
});

test('#887 — registerTool\'s nested inputSchema is read, not its options wrapper', () => {
  // `server.registerTool(name, { description, inputSchema: z.object({…}) }, h)`
  // puts the schema one level down. Reading the outer object reports every
  // parameter in the file as undeclared — 93 tools use one form or the other.
  const source = [
    'server.registerTool(',
    "  'merge_demo',",
    "  { description: 'd', inputSchema: z.object({",
    '      target_playlist_id: z.string().optional(),',
    '      new_name: z.string().optional(),',
    '    }) },',
    '  async (args) => {',
    "    throw new Error('pass one of `target_playlist_id` or `new_name`');",
    '  },',
    ');',
  ].join('\n');
  const reg = registrations(source).find((r) => r.name === 'merge_demo');
  assert.ok(reg, 'the nested registration was not found at all');
  assert.equal(reg!.opaque, false);
  assert.deepEqual([...reg!.keys].sort(), ['new_name', 'target_playlist_id']);
  assert.deepEqual(collectErrorParamViolations(source, 'src/tools/merge_demo.ts', VOCAB, TOOL_NAMES), []);
});

test('#887 — a value that merely looks like a key is not read as one', () => {
  // `z.string()` in a value position once read as the key `string`, which
  // left the depth counter short and dropped every key after the first
  // `.describe(` — the schema looked empty and the guard went quiet.
  const source = toolWith(
    'desc_demo',
    "\n      name: z.string().min(1).describe('Playlist name'),\n      limit: z.number().optional().describe('How many'),\n      dry_run: DryRun,\n    ",
    "    if (!args.name) throw new Error('set `limit` and `dry_run`');",
  );
  const reg = registrations(source).find((r) => r.name === 'desc_demo');
  assert.deepEqual([...reg!.keys].sort(), ['dry_run', 'limit', 'name']);
  assert.deepEqual(collectErrorParamViolations(source, 'src/tools/desc_demo.ts', VOCAB, TOOL_NAMES), []);
});

test('#887 — a template literal ends at its own backtick', () => {
  // The first reader tracked hole depth but not nesting, so a template
  // containing a template ran past its closer and swallowed the next tool —
  // which is how a five-site defect first looked like a 600-line one.
  const source = toolWith(
    'tpl_demo',
    "\n      name: z.string().optional(),\n    ",
    "    const label = `${args.name} ${n > 0 ? `(${n})` : ''}`;\n    throw new Error('set `name`');",
  );
  const thrown = collectThrownMessages(source);
  assert.equal(thrown.length, 1, `expected exactly one throw, got: ${JSON.stringify(thrown)}`);
  assert.equal(thrown[0]!.message, 'set `name`');
  assert.deepEqual(collectErrorParamViolations(source, 'src/tools/tpl_demo.ts', VOCAB, TOOL_NAMES), []);
});

test('#887 — the collector reaches the real call sites it claims to cover', () => {
  // If the scan silently stopped matching, the real-tree test above would
  // report zero violations and look healthy. So pin its reach: the throws it
  // attributes to each of the five tools in the issue, by name.
  const exhaust = SOURCES.find((s) => s.file.endsWith('exhaust2_playlists.ts'))!;
  const thrown = collectThrownMessages(exhaust.source);
  assert.ok(thrown.length >= 15, `only ${thrown.length} thrown messages found in exhaust2_playlists.ts`);

  const byTool = (name: string) => thrown.filter((t) => t.tool === name).map((t) => t.message);
  assert.ok(
    byTool('playlist_names_bulk_normalize').some((m) => m.includes('op="prefix"')),
    'the prefix message is no longer attributed to playlist_names_bulk_normalize',
  );
  assert.ok(
    byTool('playlist_names_bulk_normalize').some((m) => m.includes('op="suffix"')),
    'the suffix message is no longer attributed to playlist_names_bulk_normalize',
  );
  for (const mode of ['uris', 'artist', 'query']) {
    assert.ok(
      byTool('playlist_keep_only').some((m) => m.includes(`keep_by=${mode}`)),
      `the keep_by=${mode} message is no longer attributed to playlist_keep_only`,
    );
  }

  // The `market` advice is a payload value, so it is reached through rule 1's
  // literal scan rather than the throw scan.
  const era = registrations(exhaust.source).find((r) => r.name === 'playlist_era_profile')!;
  assert.ok(era, 'playlist_era_profile is no longer found in exhaust2_playlists.ts');
  const eraText = stringLiterals(exhaust.source, era.handlerStart, era.handlerEnd).map((l) => l.text).join('\n');
  assert.match(eraText, /no release dates resolved/);
  assert.match(eraText, /`market`/);
});

// ---------------------------------------------------------------------------
// Behavioural half: call the tools, check the message against the real schema.
// ---------------------------------------------------------------------------

type ToolContent = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> };
/**
 * These modules register a raw `ZodRawShape`, the object the MCP SDK turns
 * into a tool's `inputSchema` — so its own keys ARE the declared parameters.
 * Reading them off the captured object is the strongest form of "names a
 * parameter this tool declares": it is the same shape a host is shown, not a
 * re-parse of the source by the guard that is under test.
 */
type RegisteredTool = {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  handler: (a: Record<string, unknown>) => Promise<ToolContent>;
};

/**
 * A playlist with one track whose album carries no release date, which is what
 * puts `playlist_era_profile` on its UNKNOWN branch. Reads are served; every
 * mutating call throws, so a guard regression that let a write through fails
 * loudly instead of passing on an empty assertion.
 */
const UNDATED_PLAYLIST = {
  id: 'p1',
  name: 'No Dates',
  items: [
    {
      added_at: '2024-01-01T00:00:00Z',
      item: { type: 'track', uri: 'spotify:track:t1', id: 't1', name: 'One', album: { id: 'al1' } },
    },
  ],
};

const NO_WRITE = (method: string) => () => {
  throw new Error(`unexpected ${method} — these calls are supposed to reject first`);
};

function fakeClient() {
  return {
    get: async (path: string) =>
      path === '/playlists/p1' ? { id: 'p1', name: 'No Dates' } : undefined,
    getAllPages: async (path: string) => (path.includes('/items') ? UNDATED_PLAYLIST.items : []),
    // #1555: the playlist walk now goes through the verdict-returning method,
    // so a fake that stubs only `getAllPages` fails before the validation this
    // file exists to inspect is ever reached. Reports a complete read.
    getAllPagesWithTruncation: async (path: string) => {
      const items = path.includes('/items') ? UNDATED_PLAYLIST.items : [];
      return { items, truncated: false, truncatedByCap: false, reportedTotal: items.length };
    },
    getWithGating: async () => undefined,
    post: NO_WRITE('POST'),
    put: NO_WRITE('PUT'),
    delete: NO_WRITE('DELETE'),
  };
}

function capture(client: unknown): RegisteredTool[] {
  const registered: RegisteredTool[] = [];
  const server = {
    tool: (name: string, description: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) => {
      registered.push({ name, description, schema, handler });
    },
  };
  registerExhaust2PlaylistsTools(server as never, client as never);
  return registered;
}

const TOOLS = capture(fakeClient());
const tool = (name: string): RegisteredTool => {
  const t = TOOLS.find((x) => x.name === name);
  assert.ok(t, `missing tool ${name}`);
  return t!;
};

/** The parameter names the tool was actually registered with. */
const declared = (name: string): string[] => Object.keys(tool(name).schema);

async function rejectionMessage(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    await tool(name).handler(args);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  assert.fail(`${name} was expected to reject, and it did not`);
}

const FAILURES: Array<{ tool: string; args: Record<string, unknown>; param: string }> = [
  { tool: 'playlist_names_bulk_normalize', args: { op: 'prefix' }, param: 'prefix' },
  { tool: 'playlist_names_bulk_normalize', args: { op: 'suffix' }, param: 'suffix' },
  { tool: 'playlist_keep_only', args: { keep_by: 'uris', playlist_id: 'p1' }, param: 'values' },
  { tool: 'playlist_keep_only', args: { keep_by: 'artist', playlist_id: 'p1' }, param: 'artist' },
  { tool: 'playlist_keep_only', args: { keep_by: 'query', playlist_id: 'p1' }, param: 'query' },
];

test('#887 — the harness registered the tools this test needs', () => {
  // Without this, `tool()` would assert on a name list nothing registered and
  // the five cases below would pass having checked nothing.
  for (const { tool: name } of FAILURES) {
    assert.ok(TOOLS.some((t) => t.name === name), `${name} was not registered — the cases below prove nothing`);
  }
  assert.ok(declared('playlist_keep_only').length > 0, 'the registered schema declared no parameters');
});

test('#887 — each missing-parameter message names the param and no flag', async () => {
  for (const { tool: name, args, param } of FAILURES) {
    const message = await rejectionMessage(name, args);
    assert.ok(
      declared(name).includes(param),
      `test bug: ${name} does not declare \`${param}\` (declares: ${declared(name).join(', ')})`,
    );
    assert.match(message, new RegExp('`' + param + '`'), `${name}: "${message}" does not name the \`${param}\` param`);
    assert.doesNotMatch(message, /(^|\s)--[a-z]/, `${name}: "${message}" still tells the caller to pass a flag`);
  }
});

test('#887 — every param the missing-parameter messages name is declared by that tool', async () => {
  // The issue's acceptance criterion, checked against the zod object handed to
  // server.tool rather than a re-parse of the source: read each message, take
  // the backticked words, and require every one of them to be a real key.
  for (const { tool: name, args } of FAILURES) {
    const keys = new Set(declared(name));
    const message = await rejectionMessage(name, args);
    const named = [...message.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]);
    assert.ok(named.length > 0, `${name}: "${message}" names no param at all`);
    for (const token of named) {
      assert.ok(
        keys.has(token),
        `${name} names \`${token}\`, which its schema does not declare (declares: ${[...keys].sort().join(', ')})`,
      );
    }
  }
});

test('#887 — the era-profile miss names the market param, not a flag', async () => {
  // The playlist has no resolvable release dates, so the tool takes the
  // UNKNOWN branch and has to say how to get a real answer. This one is a
  // payload value rather than a throw, which is why the source guard has to
  // scan handler strings and not only `throw new Error`.
  const era = tool('playlist_era_profile');
  const result = await era.handler({ playlist_id: 'p1', response_format: 'json' });
  const verdict = String(result.structuredContent?.verdict);
  assert.match(verdict, /no release dates resolved/);
  assert.match(verdict, /`market`/, `the UNKNOWN verdict does not name the market param: "${verdict}"`);
  assert.doesNotMatch(verdict, /(^|\s)--[a-z]/, `the UNKNOWN verdict still tells the caller to pass a flag: "${verdict}"`);

  const keys = new Set(declared('playlist_era_profile'));
  const named = [...verdict.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]);
  assert.ok(named.length > 0, `the verdict names no param: "${verdict}"`);
  for (const token of named) {
    assert.ok(keys.has(token), `the verdict names \`${token}\`, which playlist_era_profile does not declare`);
  }
});

// ---------------------------------------------------------------------------
// #1500 — the scope gap. The two rules above are keyed on a registration, and
// a shared module under `src/` registers nothing, so a message composed in
// `shaping.ts` / `result.ts` / `accounts.ts` and surfaced verbatim by a tool
// was never read. The concrete miss was `registerAccount` telling a caller to
// re-run `spotify-mcp auth --profile`, which creates a token file and never
// reaches the registry (#1465).
// ---------------------------------------------------------------------------

/** Every `.ts` file under `src/`, recursively — the region the gate covers. */
function walkTree(dir: string): Array<{ file: string; source: string }> {
  const out: Array<{ file: string; source: string }> = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkTree(p));
    else if (e.name.endsWith('.ts')) {
      out.push({ file: relative(ROOT, p), source: readFileSync(p, 'utf8') });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

const TREE = walkTree(SRC_DIR);

test('#1500 — the walk reaches every module under src/, not just src/tools', () => {
  // If this shrinks back to src/tools the scope gap is open again and every
  // module test below would be checking a region nothing scans. Pin both
  // counts: the tools half and the shared half.
  const inTools = TREE.filter((f) => f.file.startsWith('src/tools/'));
  const outside = TREE.filter((f) => !f.file.startsWith('src/tools/'));
  assert.ok(inTools.length > 20, `only ${inTools.length} tool modules found`);
  assert.ok(
    outside.length > 20,
    `only ${outside.length} shared modules found — the walk is not covering src/`,
  );
  for (const required of ['src/shaping.ts', 'src/result.ts', 'src/accounts.ts', 'src/paths.ts']) {
    assert.ok(
      TREE.some((f) => f.file === required),
      `${required} is not in the walk; the uncovered region is not the one the issue names`,
    );
  }
});

test('#1500 — the shared tree names no un-passable flag and no undeclared parameter', () => {
  const found = TREE.flatMap(({ file, source }) =>
    collectModuleViolations(source, file, VOCAB, TOOL_NAMES));

  assert.deepEqual(
    found,
    [],
    `a message composed in a shared module misnames a parameter to every tool that surfaces it:\n${found.join('\n')}`,
  );
});

test('#1500 — the module scan fires on a --flag remediation composed outside a tool', () => {
  // The exact shape of the #1465 defect, in a module with no registration and
  // so no schema the per-tool rules could ever have checked it against.
  const source = [
    'export function registerThing(input: { profile: string }): void {',
    "  if (!input.profile) throw new Error('Re-run \"spotify-mcp auth --profile\" once, then retry.');",
    '}',
  ].join('\n');
  const found = collectModuleViolations(source, 'src/registerthing.ts', VOCAB, TOOL_NAMES);
  assert.equal(found.length, 1, `expected the flag to be caught, got: ${JSON.stringify(found)}`);
  assert.match(found[0]!, /command-line flag syntax "--profile"/);
});

test('#1500 — the module scan fires on a parameter no tool declares', () => {
  // Rule 2's per-tool form cannot run here: there is no schema to check the
  // name against. The schema-less form still catches the wrong-name defect —
  // `match_bys` for `match_by` is #830 in a different costume.
  const source = [
    'export function resolveMatch(inputs: { match_by?: string }): string {',
    "  if (!inputs.match_by) throw new Error('Provide `match_bys` to choose a rule.');",
    '  return inputs.match_by;',
    '}',
  ].join('\n');
  const found = collectModuleViolations(source, 'src/match.ts', VOCAB, TOOL_NAMES);
  assert.equal(found.length, 1, `expected the wrong name to be caught, got: ${JSON.stringify(found)}`);
  assert.match(found[0]!, /names "match_bys", which no registered tool declares/);
  // …and a real parameter name is left alone: the module cannot know which
  // tool surfaces it, so it must not guess that a declared name is wrong.
  const ok = [
    'export function resolveMatch(inputs: { match_by?: string }): string {',
    "  if (!inputs.match_by) throw new Error('Provide `match_by` to choose a rule.');",
    '  return inputs.match_by;',
    '}',
  ].join('\n');
  assert.deepEqual(collectModuleViolations(ok, 'src/match.ts', VOCAB, TOOL_NAMES), []);
});

test('#1500 — a flag in a shared module is judged by structure, not by a filename list', () => {
  // `auth --profile` and `logout --profile` are real flags of the shipped CLI.
  // The exemption used to be implicit — those files were simply never scanned
  // — so widening the walk without widening the exemption would have turned
  // both into violations. It is now a property of the module: a function whose
  // parameter list names `argv`, or a module that reads `process.argv`.
  assert.equal(
    isCommandLineModule(readFileSync(join(ROOT, 'src', 'auth.ts'), 'utf8')),
    true,
    'src/auth.ts parses argv, so it must be recognised as the CLI surface',
  );
  assert.equal(
    isCommandLineModule(readFileSync(join(ROOT, 'src', 'logout.ts'), 'utf8')),
    true,
    'src/logout.ts parses argv, so it must be recognised as the CLI surface',
  );
  for (const shared of ['shaping.ts', 'result.ts', 'accounts.ts', 'paths.ts']) {
    assert.equal(
      isCommandLineModule(readFileSync(join(ROOT, 'src', shared), 'utf8')),
      false,
      `${shared} is not the CLI, so a --flag in it is a defect and must not be exempted`,
    );
  }

  // A module that merely *mentions* argv in prose is not the CLI.
  const mention = [
    '// the docs mention argv but this module has no parser',
    'export function check(input: { profile: string }): void {',
    "  if (!input.profile) throw new Error('Pass --profile to choose.');",
    '}',
  ].join('\n');
  assert.equal(isCommandLineModule(mention), false);
  assert.equal(collectModuleViolations(mention, 'src/check.ts', VOCAB, TOOL_NAMES).length, 1);

  // And an argv-taking function IS exempt, in a file the guard has never seen.
  const cli = [
    'export function parseThing(argv: string[]): string {',
    "  if (!argv[0]) throw new Error('--profile requires a profile name');",
    '  return argv[0];',
    '}',
  ].join('\n');
  assert.equal(isCommandLineModule(cli), true);
  assert.deepEqual(collectModuleViolations(cli, 'src/parse.ts', VOCAB, TOOL_NAMES), []);
});

test('#1500 — the dispatch module is recognised as the CLI, because it reads process.argv', () => {
  // `src/index.ts` IS the command line: it reads `process.argv[2]` at top
  // level and branches to `--help`, `--version`, `auth`, `doctor` and `logout`.
  // It declares no function with an `argv` parameter, so the argv-parameter
  // half of the exemption called it a shared module — and the first honest
  // `--flag` remediation written at the dispatch point would have been a false
  // positive. The file already carries `--help` prose at `src/index.ts:431`,
  // which is what made this worth fixing before it cost anyone a message.
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8');
  assert.match(index, /process\s*\.\s*argv\s*\[2\]/, 'test bug: src/index.ts no longer dispatches on process.argv[2]');
  assert.equal(
    registrations(index).length,
    0,
    'test bug: src/index.ts registers tools itself, so the argv-parameter half would cover it',
  );
  assert.equal(
    isCommandLineModule(index),
    true,
    'src/index.ts reads process.argv, so it must be recognised as the CLI surface',
  );

  // The shape that was actually misjudged: a `--flag` remediation thrown at
  // the dispatch point, in a module with no argv-taking function.
  const dispatch = [
    'const command = process.argv[2];',
    "if (command === 'doctor') {",
    "  throw new Error('Re-run with --verbose to see the token path.');",
    '}',
  ].join('\n');
  assert.equal(isCommandLineModule(dispatch), true, 'a module reading process.argv is the CLI');
  assert.deepEqual(
    collectModuleViolations(dispatch, 'src/dispatch.ts', VOCAB, TOOL_NAMES),
    [],
    'a --flag in the module that reads the process command line is a real flag, not bad advice',
  );

  // …and the shared module that does NOT read argv is still convicted, which is
  // what stops the exemption being a blanket.
  const shared = [
    'export function check(input: { profile: string }): void {',
    "  if (!input.profile) throw new Error('Re-run with --verbose to see the token path.');",
    '}',
  ].join('\n');
  assert.equal(isCommandLineModule(shared), false, 'a module that never reads process.argv is not the CLI');
  const found = collectModuleViolations(shared, 'src/check.ts', VOCAB, TOOL_NAMES);
  assert.equal(found.length, 1, `expected the shared module's flag to be caught, got: ${JSON.stringify(found)}`);
  assert.match(found[0]!, /command-line flag syntax "--verbose"/);
});

test('#1500 — process.argv inside a comment or a string does not make a module the CLI', () => {
  // The other direction, and the one that would have been missed: an exemption
  // that fires on the word rather than on the code. `blankNonCode` blanks both,
  // so a module that only TALKS about the command line is still judged.
  const prose = [
    '// argv is only available in the process, not over MCP',
    "export const NOTE = 'callers cannot pass process.argv here';",
    'export function check(input: { profile: string }): void {',
    "  if (!input.profile) throw new Error('Re-run with --verbose to see the token path.');",
    '}',
  ].join('\n');
  assert.equal(
    isCommandLineModule(prose),
    false,
    'a module that only mentions process.argv in a comment or a string is not the CLI',
  );
  assert.equal(
    collectModuleViolations(prose, 'src/prose.ts', VOCAB, TOOL_NAMES).length,
    1,
    'and its --flag must still be caught',
  );
});

test('#1500 — the vocabulary is parameters, not every identifier a shape object happens to carry', () => {
  // The module rule asks "is this name a real parameter anywhere", not "is this
  // name well-formed". Unioning every `z.object({…})` and every const-object
  // key across all of `src/` answered the looser question: `email` and `scopes`
  // are fields of an account record and of an OAuth token, not keys any tool
  // accepts, and a message misnaming a parameter for either cleared the rule
  // with no finding.
  for (const notAParameter of ['email', 'scopes', 'displayName', 'tokenFile', 'lastUsed']) {
    assert.equal(
      VOCAB.has(notAParameter),
      false,
      `${notAParameter} is not a parameter any tool accepts, so it must not be in the vocabulary`,
    );
  }

  // …and a misnaming for one of them is now caught, where it was silent.
  for (const wrong of ['email', 'scopes']) {
    const source = [
      'export function resolveAccount(inputs: { match_by?: string }): string {',
      `  if (!inputs.match_by) throw new Error('Pass \`${wrong}\` to choose an account.');`,
      '  return inputs.match_by;',
      '}',
    ].join('\n');
    const found = collectModuleViolations(source, 'src/account.ts', VOCAB, TOOL_NAMES);
    assert.equal(found.length, 1, `expected ${wrong} to be caught, got: ${JSON.stringify(found)}`);
    assert.match(found[0]!, new RegExp(`names "${wrong}", which no registered tool declares`));
  }

  // `displayName` and `tokenFile` are a different, older limit and are pinned
  // as such. A backticked claim is `` /`([a-z][a-z0-9_]*)`/ `` — lower case, so
  // a camelCase identifier is not read as a NAME at all, before the vocabulary
  // is consulted. Narrowing the vocabulary did not and cannot change that, and
  // the review that asked for all four words to be caught was half right about
  // them: `email` and `scopes` were silenced by the vocabulary, and these two
  // were never claims. Widening the claim pattern is a separate decision (it
  // would find 0 camelCase claims in the whole tree today) and is recorded
  // rather than taken here.
  for (const camel of ['displayName', 'tokenFile']) {
    const source = [
      'export function resolveAccount(inputs: { match_by?: string }): string {',
      `  if (!inputs.match_by) throw new Error('Pass \`${camel}\` to choose an account.');`,
      '  return inputs.match_by;',
      '}',
    ].join('\n');
    assert.deepEqual(
      collectModuleViolations(source, 'src/account.ts', VOCAB, TOOL_NAMES),
      [],
      `${camel} is camelCase and is not a claim under either pattern; this test pins that limit, it does not bless it`,
    );
  }

  // The narrowing must not cost a real parameter. `match_by` is declared by a
  // tool and stays declared; `match_bys` is not declared by anything and is
  // the wrong-name defect both rules exist for.
  assert.ok(VOCAB.has('match_by'), 'match_by is a declared parameter, so narrowing must not have dropped it');
  assert.equal(VOCAB.has('match_bys'), false, 'match_bys is a typo, not a parameter');
  const ok = [
    'export function resolveMatch(inputs: { match_by?: string }): string {',
    "  if (!inputs.match_by) throw new Error('Provide `match_by` to choose a rule.');",
    '  return inputs.match_by;',
    '}',
  ].join('\n');
  assert.deepEqual(collectModuleViolations(ok, 'src/match.ts', VOCAB, TOOL_NAMES), []);
  const typo = [
    'export function resolveMatch(inputs: { match_by?: string }): string {',
    "  if (!inputs.match_by) throw new Error('Provide `match_bys` to choose a rule.');",
    '  return inputs.match_by;',
    '}',
  ].join('\n');
  const caught = collectModuleViolations(typo, 'src/match.ts', VOCAB, TOOL_NAMES);
  assert.equal(caught.length, 1, `expected match_bys to be caught, got: ${JSON.stringify(caught)}`);
  assert.match(caught[0]!, /names "match_bys", which no registered tool declares/);
});

test('#1500 — a spread field object keeps its keys in the vocabulary, and only a spread one does', () => {
  // `playlist_a` and `playlist_b` are declared in `PlaylistPairFields` and reach
  // four tools by spread, so `registrations()` cannot see them inline. Narrowing
  // the vocabulary to inline keys alone would have called two real parameters
  // undeclared, and the fix is to follow the spread — not to widen the set back
  // to every identifier in `src/`.
  for (const key of ['playlist_a', 'playlist_b']) {
    assert.ok(
      VOCAB.has(key),
      `${key} is declared by PlaylistPairFields and spread into a registration, so it is a parameter`,
    );
  }
  const source = [
    'export function resolvePair(inputs: { match_by?: string }): string {',
    "  if (!inputs.match_by) throw new Error('Provide `playlist_a` and `playlist_b` together.');",
    '  return inputs.match_by;',
    '}',
  ].join('\n');
  assert.deepEqual(collectModuleViolations(source, 'src/pair.ts', VOCAB, TOOL_NAMES), []);

  // …and the spread has to be a real one. A field object nobody spreads
  // contributes nothing, which is the bound that keeps the vocabulary narrow.
  const unspread = walkTree(join(ROOT, 'src')).find((f) => f.file === 'src/shaping.ts')!;
  const fields = /export const (\w*Fields)\s*=\s*\{/.exec(unspread.source);
  assert.ok(fields, 'test bug: no shared field object was found in src/shaping.ts to spread');
  const spreadDemo = [
    'export const UnusedFields = { playlist_a: z.string() };',
    'export function resolvePair(inputs: { match_by?: string }): string {',
    "  if (!inputs.match_by) throw new Error('Provide `limit_offset` to choose.');",
    '  return inputs.match_by;',
    '}',
  ].join('\n');
  assert.equal(
    collectModuleViolations(spreadDemo, 'src/unused.ts', VOCAB, TOOL_NAMES).length,
    1,
    'a field object no registration spreads must not enter the vocabulary',
  );
  assert.ok(VOCAB.has('limit_offset') === false, 'test bug: limit_offset should not be a parameter');
});

test('#1500 — one violation in a tool handler is one finding, not two', () => {
  // Both rules ran over `src/tools` at once, so a single `--prefix` in a
  // handler was reported twice under two different messages, and the module
  // rule's version claimed the message reached "every caller" when it reached
  // one tool. The per-tool rule names the tool; the module rule cannot, so
  // `src/tools` belongs to the per-tool rule alone.
  const source = toolWith(
    'probe_tool',
    "\n      prefix: z.string().optional(),\n    ",
    "    throw new Error('probe_tool op requires --prefix');",
  );
  const perTool = collectErrorParamViolations(source, 'src/tools/probe_tool.ts', VOCAB, TOOL_NAMES);
  const perModule = collectModuleViolations(source, 'src/tools/probe_tool.ts', VOCAB, TOOL_NAMES);

  assert.deepEqual(
    perModule,
    [],
    'the module rule must not judge a registered tool handler at all',
  );
  assert.equal(
    perTool.length + perModule.length,
    1,
    `one defect must produce one finding, got: ${JSON.stringify([...perTool, ...perModule])}`,
  );
  assert.match(perTool[0]!, /probe_tool: command-line flag syntax "--prefix"/, 'and it must be the one that names the tool');

  // The partition is by directory, not by file: a shared module beside it is
  // still the module rule's, and a real one still fires.
  const shared = [
    "import { z } from 'zod';",
    'export function resolveThing(input: { profile: string }): void {',
    "  if (!input.profile) throw new Error('Pass --profile to choose.');",
    '}',
  ].join('\n');
  assert.equal(collectModuleViolations(shared, 'src/resolve.ts', VOCAB, TOOL_NAMES).length, 1);
  assert.equal(collectModuleViolations(shared, 'src/tools/resolve.ts', VOCAB, TOOL_NAMES).length, 0);
});

test('#1500 — the real CLI flag in src/auth.ts is still not a violation', () => {
  // Belt and braces on the one message the original scope comment named: if
  // this ever fails, the exemption moved rather than the code.
  const found = TREE.flatMap(({ file, source }) =>
    file === 'src/auth.ts' || file === 'src/logout.ts'
      ? collectModuleViolations(source, file, VOCAB, TOOL_NAMES)
      : []);
  assert.deepEqual(found, [], `the CLI surface was reported: ${found.join('\n')}`);
});

test('#1500 — the mask survives a regex literal containing a quote', () => {
  // `/"/g` reads as an *opening* double quote to a scanner that only knows
  // about strings, and the mask then swallows the rest of the file as string
  // body. That made `src/auth.ts` lose 12 of its 15 throw sites and
  // `swarm3_discovery.ts` lose 7 of its 24 registrations, so the guard
  // reported those regions clean having not read them at all.
  const source = [
    'const esc = (s: string) => s.replace(/"/g, \'&quot;\').replace(/\'/g, \'&#39;\');',
    'export function go(): void { throw new Error("reached"); }',
  ].join('\n');
  const mask = blankNonCode(source);
  assert.equal(mask.length, source.length, 'the mask must stay offset-identical to the source');
  assert.ok(mask.includes('throw new Error'), 'the code after the regex literal was blanked away');
  assert.ok(!mask.includes('reached'), 'the string body was left visible');

  // The invariant across the real tree, not just this synthetic source.
  const broken = TREE.filter(({ source: s }) => blankNonCode(s).length !== s.length);
  assert.deepEqual(
    broken.map((b) => b.file),
    [],
    'these files desync the mask, so every offset the scan reads past the break is wrong',
  );
});

test('#1500 — the mask fix recovers registrations the broken mask was hiding', () => {
  // Not a count. These seven tools live after a regex literal containing a
  // quote in `swarm3_discovery.ts`; with the mask broken they were invisible,
  // so no rule could have judged anything they said.
  const names = registrations(readFileSync(join(ROOT, 'src', 'tools', 'swarm3_discovery.ts'), 'utf8'))
    .map((r: { name: string }) => r.name);
  for (const tool of [
    'artistwatch_new_additions',
    'album_representative_plan',
    'front_to_back_plan',
    'b_sides_finder',
    'album_focus_report',
    'artist_catalog_stats',
    'lyric_snippet_search',
  ]) {
    assert.ok(names.includes(tool), `${tool} is invisible to the guard again — the mask regressed`);
  }
});

test('#1500 — a regex literal is not mistaken for a division or a comment', () => {
  // The two ways the mask can be over-eager and blank real code.
  const source = [
    'const ratio = total / count;',
    'const half = (total) / 2 / 1;',
    "const pathed = value.replace(/a\\/b/g, '-');",
    'export function go(): void { throw new Error("reached"); }',
  ].join('\n');
  const mask = blankNonCode(source);
  assert.equal(mask.length, source.length);
  assert.ok(mask.includes('throw new Error'), 'code after a division was blanked');
  assert.ok(mask.includes('total / count'), 'a division was read as a regex and blanked');
  assert.ok(mask.includes('(total) / 2 / 1'), 'a division after `)` was read as a regex');
  assert.ok(!mask.includes('a\\/b'), 'the regex body itself should be blanked');
});

test('#1500 — a `+`-joined message is read whole, not just its first literal', () => {
  // The shape the #1465 remediation actually has: a long message written as a
  // run of concatenated literals, with the offending `--flag` in the LAST one.
  // Reading only the first literal reported the real defect clean, which is
  // how a guard built for exactly this class missed it twice.
  const source = [
    'export function registerThing(input: { profile: string }): void {',
    '  if (!input.profile) {',
    '    throw new Error(',
    '      `Cannot register profile "${input.profile}": /me returned neither account_id nor id. ` +',
    "        'The profile is authenticated and the session is acting as it. ' +",
    "        'Re-run \"spotify-mcp auth --profile X\" once /me serves account_id.',",
    '    );',
    '  }',
    '}',
  ].join('\n');
  const thrown = collectThrownMessages(source);
  assert.equal(thrown.length, 1, `expected one throw, got: ${JSON.stringify(thrown)}`);
  assert.match(thrown[0]!.message, /--profile/, 'the concatenated tail was not read');
  const found = collectModuleViolations(source, 'src/registerthing.ts', VOCAB, TOOL_NAMES);
  assert.equal(found.length, 1, `expected the flag to be caught, got: ${JSON.stringify(found)}`);
  assert.match(found[0]!, /command-line flag syntax "--profile"/);

  // And a parameter claim in the tail counts the same as one in the head.
  const named = [
    'export function pick(inputs: { match_by?: string }): string {',
    '  if (!inputs.match_by) throw new Error(',
    "    'Provide one of `match_by` or `match_bys` to choose a rule.',",
    '  );',
    '  return inputs.match_by;',
    '}',
  ].join('\n');
  const hits = collectModuleViolations(named, 'src/pick.ts', VOCAB, TOOL_NAMES);
  assert.equal(hits.length, 1, `expected the tail claim to be caught, got: ${JSON.stringify(hits)}`);
  assert.match(hits[0]!, /names "match_bys"/);
});

test('#1500 — a `+` after a non-literal ends the message instead of running on', () => {
  // The walk stops at the first `+` that is not followed by a string. Reading
  // past it would swallow the next statement into this message.
  const source = [
    'export function go(a: number, b: number): number {',
    '  const c = a + b;',
    "  if (!c) throw new Error('zero');",
    '  return c;',
    '}',
  ].join('\n');
  const thrown = collectThrownMessages(source);
  assert.equal(thrown.length, 1, `expected one throw, got: ${JSON.stringify(thrown)}`);
  assert.equal(thrown[0]!.message, 'zero');
});
