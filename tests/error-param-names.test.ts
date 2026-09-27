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
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';

import {
  collectErrorParamViolations,
  collectThrownMessages,
  parameterVocabulary,
  registrations,
  stringLiterals,
  toolNameVocabulary,
} from '../scripts/check-error-param-names.mjs';
import { registerExhaust2PlaylistsTools } from '../src/tools/exhaust2_playlists.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOOLS_DIR = join(ROOT, 'src', 'tools');

function walkSources(dir: string): Array<{ file: string; source: string }> {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => ({ file: relative(ROOT, join(dir, e.name)), source: readFileSync(join(dir, e.name), 'utf8') }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

const SOURCES = walkSources(TOOLS_DIR);
const VOCAB = parameterVocabulary(SOURCES.map((s) => s.source));
const TOOL_NAMES = toolNameVocabulary(SOURCES.map((s) => s.source));

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

test('#887 — the guard is scoped to src/tools, so auth\'s real CLI flag is untouched', () => {
  // `auth --profile` is a flag of the shipped CLI, not advice the MCP surface
  // gives anybody. If this ever starts failing the scope moved, not the code.
  const auth = readFileSync(join(ROOT, 'src', 'auth.ts'), 'utf8');
  assert.match(auth, /Invalid --profile/);
  assert.equal(registrations(auth).length, 0, 'src/auth.ts registers no MCP tools, so nothing there is in scope');
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
