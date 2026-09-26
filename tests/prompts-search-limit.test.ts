/**
 * Issue #596: the search limit cap of 10 must reach the artefacts agents read.
 *
 * `src/tools/search.ts` caps `limit` at `SPOTIFY_SEARCH_MAX_LIMIT` (10 since
 * Spotify's Feb-2026 /search change), but the prompts and SPEC.md are what an
 * agent actually follows. A prompt prescribing `limit 20` makes the agent send
 * a value its own zod schema rejects — a wasted turn, invisible to CI.
 *
 * These checks render every registered prompt through the real MCP routing and
 * cross-reference each numeric search `limit` against the live bound, and pin
 * SPEC.md's search rows to the same number so the documents cannot drift.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { registerPrompts } from '../src/prompts/index.js';
import { SPOTIFY_SEARCH_MAX_LIMIT } from '../src/tools/search.js';

/** `search_deep` walks `pages` of 10; its own bound comes from searchdive.ts. */
const SEARCH_DEEP_MAX_PAGES = 5;

/**
 * A tool mention: the bare word `search` (which `\b` keeps distinct from
 * `search_deep`/`search_fresh`) or any snake_case tool name.
 */
const TOOL_MENTION = /\b(?:search|[a-z][a-z0-9]*_[a-z0-9_]+)\b/g;
/** `limit 20`, `limit=20`, and the ranges the prompts write as `limit 15–20`. */
const LIMIT_TOKEN = /limit[ =](\d+(?:\s*[–-]\s*\d+)?)/g;

/** The tool a `limit` at `index` belongs to — the nearest mention before it. */
function owningTool(text: string, index: number): string | null {
  let owner: string | null = null;
  for (const mention of text.matchAll(TOOL_MENTION)) {
    if (mention.index >= index) break;
    owner = mention[0];
  }
  return owner;
}

/** Every number a limit token asks for — `15–20` yields both. */
function limitValues(token: string): number[] {
  return [...token.matchAll(/\d+/g)].map((m) => Number(m[0]));
}

/** A count promise like `15–20 tracks` or `20 songs`; returns the largest number. */
function promisedResultCeiling(text: string): number {
  let ceiling = 0;
  for (const match of text.matchAll(/(\d+(?:\s*[–-]\s*\d+)?)\s+(?:tracks?|songs?)\b/g)) {
    for (const n of limitValues(match[1])) ceiling = Math.max(ceiling, n);
  }
  return ceiling;
}

async function renderAllPrompts(): Promise<Map<string, string>> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerPrompts(server);
  const client = new Client({ name: 'tester', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(clientTransport), client.connect(serverTransport)]);

  const { prompts } = await client.listPrompts();
  const rendered = new Map<string, string>();
  for (const prompt of prompts) {
    // A prompt's defaults render on their own, so probe with `{}` first and
    // only supply what a required argument demands. The filler is a value the
    // prompt only echoes back — it cannot mask or manufacture a limit token.
    const fillers: Record<string, string> = { since: '2026-01-01' };
    let result;
    try {
      result = await client.getPrompt({ name: prompt.name, arguments: {} });
    } catch {
      const supplied: Record<string, string> = {};
      for (const arg of (prompt.arguments ?? []).filter((a) => a.required)) {
        supplied[arg.name] = fillers[arg.name] ?? 'probe';
      }
      result = await client.getPrompt({ name: prompt.name, arguments: supplied });
    }
    rendered.set(
      prompt.name,
      result.messages
        .map((m) => (m.content.type === 'text' ? m.content.text : ''))
        .join(' '),
    );
  }
  await client.close();
  return rendered;
}

test('no prompt prescribes a search limit above the schema bound (#596)', async () => {
  const rendered = await renderAllPrompts();
  assert.ok(rendered.size >= 14, `expected the full prompt registry, saw ${rendered.size}`);

  const offenders: string[] = [];
  for (const [name, text] of rendered) {
    for (const match of text.matchAll(LIMIT_TOKEN)) {
      if (owningTool(text, match.index) !== 'search') continue;
      // One report per token: a `limit 15–20` range trips twice otherwise.
      if (limitValues(match[1]).some((value) => value > SPOTIFY_SEARCH_MAX_LIMIT)) {
        offenders.push(`${name}: "limit ${match[1]}" > ${SPOTIFY_SEARCH_MAX_LIMIT}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `prompts prescribe a limit their schema rejects:\n${offenders.join('\n')}`);
});

test('search_deep page prescriptions stay within its own bound (#596)', async () => {
  const rendered = await renderAllPrompts();
  const offenders: string[] = [];
  let checked = 0;
  for (const [name, text] of rendered) {
    // The argument list sits inside `(...)`, so the gap between the tool name
    // and `pages` may contain an open paren.
    for (const match of text.matchAll(/\bsearch_deep\b.{0,80}?pages[ =](\d+)/g)) {
      checked += 1;
      const value = Number(match[1]);
      if (value < 1 || value > SEARCH_DEEP_MAX_PAGES) {
        offenders.push(`${name}: "pages ${value}" outside 1-${SEARCH_DEEP_MAX_PAGES}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `prompts prescribe an out-of-range page walk:\n${offenders.join('\n')}`);
  // Without this the test passes on a regex that matches nothing at all.
  assert.ok(checked >= 3, `expected a search_deep pages prescription per routed prompt, matched ${checked}`);
});

test('a promise of more than one search page is routed through search_deep (#596)', async () => {
  const rendered = await renderAllPrompts();
  const unrouted: string[] = [];
  for (const [name, text] of rendered) {
    // Scoped to prompts that actually reach for /search: a count like
    // "albums ≤50 tracks" in a prompt that never searches is not a search page.
    if (!/\bsearch\b/.test(text)) continue;
    if (promisedResultCeiling(text) <= SPOTIFY_SEARCH_MAX_LIMIT) continue;
    if (!text.includes('search_deep')) unrouted.push(name);
  }
  assert.deepEqual(
    unrouted,
    [],
    `these promises more tracks than one /search page returns but never names search_deep: ${unrouted.join(', ')}`,
  );
});

test("SPEC.md's search bounds match the live schema cap (#596)", async () => {
  const spec = await readFile(
    fileURLToPath(new URL('../SPEC.md', import.meta.url)),
    'utf8',
  );
  const constraints = spec.match(/^\|\s*\*\*Search limit\*\*\s*\|\s*(.+?)\s*\|$/m);
  assert.ok(constraints, 'SPEC.md section 10 lost its Search limit row');
  assert.match(
    constraints[1],
    new RegExp(`Max ${SPOTIFY_SEARCH_MAX_LIMIT} results per type`),
    'SPEC.md section 10 states a cap other than the schema bound',
  );

  const searchInputs = spec.match(/^#### `search`\n[\s\S]*?^\| `limit` \| number \| no \| (.+?) \|$/m);
  assert.ok(searchInputs, 'SPEC.md section 5.2 lost the search `limit` input row');
  assert.match(
    searchInputs[1],
    new RegExp(`1[–-]${SPOTIFY_SEARCH_MAX_LIMIT}\\b`),
    'SPEC.md section 5.2 states a limit range other than the schema bound',
  );
});
