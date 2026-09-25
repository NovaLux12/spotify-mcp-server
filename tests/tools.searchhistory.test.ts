import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSearchHistoryTools, appendSearchHistory, loadSearchHistory } from '../src/tools/searchhistory.js';
import { registerSearchTools } from '../src/tools/search.js';
import type { SpotifyClient } from '../src/client.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};
type Registered = {
  name: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (args: unknown) => Promise<ToolResult>;
};

const ENTRY = z.object({
  id: z.string(),
  query: z.string(),
  timestamp: z.string(),
  top_result_ids: z.array(z.string()),
  types: z.array(z.string()).optional(),
  limit: z.number().optional(),
  market: z.string().optional(),
  offset: z.number().optional(),
});

let dir: string;
let historyFile: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sh-'));
  historyFile = join(dir, 'search-history.json');
  process.env.SPOTIFY_MCP_SEARCH_HISTORY_FILE = historyFile;
  delete process.env.SPOTIFY_MCP_SEARCH_HISTORY;
});
afterEach(async () => {
  delete process.env.SPOTIFY_MCP_SEARCH_HISTORY_FILE;
  delete process.env.SPOTIFY_MCP_SEARCH_HISTORY;
  await rm(dir, { recursive: true, force: true });
});

function track(id: string) {
  return {
    id,
    name: `Track ${id}`,
    uri: `spotify:track:${id}`,
    duration_ms: 200_000,
    artists: [{ name: 'Queen' }],
    album: { name: 'A Night at the Opera' },
  };
}

const searchResponse = () => ({ tracks: { items: [track('t1')], total: 1 } });

/** Register the search tools and the history readers over one fake client. */
function harness(getResponse: (path: string, params?: Record<string, string>) => unknown = searchResponse) {
  const registered: Registered[] = [];
  const gets: Array<{ path: string; params?: Record<string, string> }> = [];
  const client = {
    async get(path: string, params?: Record<string, string>) {
      gets.push({ path, params });
      return getResponse(path, params);
    },
  } as unknown as SpotifyClient;
  const server = {
    tool(name: string, _description: string, schema: Record<string, z.ZodTypeAny>, handler: (args: unknown) => Promise<ToolResult>) {
      registered.push({ name, schema, handler });
    },
  } as unknown as McpServer;
  registerSearchHistoryTools(server, client);
  registerSearchTools(server, client);
  const invoke = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const tool = registered.find((r) => r.name === name);
    assert.ok(tool, `expected tool ${name} to be registered`);
    return tool.handler(z.object(tool.schema).parse(args));
  };
  return { registered, invoke, gets };
}

async function readEntries() {
  const raw = await readFile(historyFile, 'utf8');
  return z.array(ENTRY).parse(JSON.parse(raw));
}

describe('searchhistory', () => {
  it('registers 2 tools', () => {
    const h = harness();
    assert.equal(h.registered.filter((r) => r.name === 'search_history' || r.name === 'search_rerun').length, 2);
  });

  it('a search is listed by search_history afterwards (#766)', async () => {
    const h = harness();
    await h.invoke('search', { query: 'bohemian', types: ['track'] });
    const out = await h.invoke('search_history', {});
    assert.match(out.content[0]!.text, /bohemian/i);
    const entries = await readEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.query, 'bohemian');
    assert.deepEqual(entries[0]!.types, ['track']);
    assert.deepEqual(entries[0]!.top_result_ids, ['spotify:track:t1']);
    assert.ok(Date.parse(entries[0]!.timestamp) > 0, 'entry carries a parseable timestamp');
  });

  it('search_history structured payload carries the recorded id (#766)', async () => {
    const h = harness();
    await h.invoke('search', { query: 'bohemian', types: ['track'], response_format: 'json' });
    const out = await h.invoke('search_history', { response_format: 'json' });
    const entries = z.array(ENTRY).parse((out.structuredContent as { entries: unknown }).entries);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.query, 'bohemian');
    assert.ok(entries[0]!.id.length > 0);
  });

  it('search_rerun re-executes a search recorded by the search tool (#766)', async () => {
    const h = harness();
    await h.invoke('search', { query: 'jazz', types: ['track'] });
    const [entry] = await readEntries();
    const out = await h.invoke('search_rerun', { history_id: entry!.id });
    assert.match(out.content[0]!.text, /Re-ran/i);
    const searchCalls = h.gets.filter((g) => g.path === '/search');
    assert.equal(searchCalls.length, 2, 'the rerun issues its own /search');
    assert.equal(searchCalls[1]!.params?.q, 'jazz');
    assert.equal(searchCalls[1]!.params?.type, 'track');
  });

  it('a recorded search round-trips market, offset and limit for replay (#766)', async () => {
    const h = harness();
    await h.invoke('search', { query: 'queen', types: ['track'], market: 'gb', offset: 20, limit: 7 });
    const [entry] = await readEntries();
    assert.equal(entry!.market, 'GB');
    assert.equal(entry!.offset, 20);
    assert.equal(entry!.limit, 7);

    const out = await h.invoke('search_rerun', { history_id: entry!.id });
    assert.equal(out.structuredContent?.ok, true);
    const replay = h.gets.filter((g) => g.path === '/search')[1]!;
    assert.equal(replay.params?.market, 'GB');
    assert.equal(replay.params?.offset, '20');
    assert.equal(replay.params?.limit, '7');
  });

  it('search_history filters by query substring', async () => {
    const h = harness();
    await h.invoke('search', { query: 'radiohead', types: ['track'] });
    await h.invoke('search', { query: 'beatles', types: ['track'] });
    const out = await h.invoke('search_history', { query: 'radio' });
    assert.match(out.content[0]!.text, /radiohead/i);
    assert.doesNotMatch(out.content[0]!.text, /beatles/i);
  });

  it('a search returning no results records nothing (#766)', async () => {
    const h = harness(() => ({ tracks: { items: [], total: 0 } }));
    await h.invoke('search', { query: 'nothing here', types: ['track'] });
    await assert.rejects(readFile(historyFile, 'utf8'), { code: 'ENOENT' });
  });

  it('SPOTIFY_MCP_SEARCH_HISTORY=0 records nothing and the search still returns results', async () => {
    process.env.SPOTIFY_MCP_SEARCH_HISTORY = '0';
    const h = harness();
    const out = await h.invoke('search', { query: 'bohemian', types: ['track'] });
    assert.match(out.content[0]!.text, /Track t1/);
    await assert.rejects(readFile(historyFile, 'utf8'), { code: 'ENOENT' });
    const history = await h.invoke('search_history', {});
    assert.match(history.content[0]!.text, /No search history/i);
  });

  it('an unwritable sidecar does not fail the search (#766)', async () => {
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'not a directory');
    process.env.SPOTIFY_MCP_SEARCH_HISTORY_FILE = join(blocker, 'search-history.json');
    const h = harness();
    const out = await h.invoke('search', { query: 'bohemian', types: ['track'] });
    assert.match(out.content[0]!.text, /Track t1/);
  });

  it('drops entries older than 90 days when appending', async () => {
    await appendSearchHistory({ id: 'old', query: 'old', timestamp: new Date(Date.now() - 100 * 86400000).toISOString(), top_result_ids: [] });
    await appendSearchHistory({ id: 'new', query: 'new', timestamp: new Date().toISOString(), top_result_ids: [] });
    const entries = await loadSearchHistory();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.id, 'new');
  });

  it('search_history returns empty when no entries', async () => {
    const h = harness();
    const out = await h.invoke('search_history', {});
    assert.match(out.content[0]!.text, /No search history/i);
  });

  it('search_rerun errors on unknown id', async () => {
    const h = harness();
    const out = await h.invoke('search_rerun', { history_id: 'nope' });
    assert.match(out.content[0]!.text, /No history entry/i);
  });
});
