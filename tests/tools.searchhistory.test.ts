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

/**
 * Write the sidecar as bytes. The imported / hand-written class this file
 * defends against never passed through `appendSearchHistory`, so the tests
 * below must be able to put a value there our own writer never emits.
 */
async function writeSidecar(entries: Array<Record<string, unknown>>) {
  await writeFile(historyFile, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
}

function sidecarEntry(id: string, extra: Record<string, unknown>) {
  return { id, query: 'queen', types: ['track'], timestamp: new Date().toISOString(), top_result_ids: [], ...extra };
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

  it('search_rerun clamps a pre-Feb-2026 stored limit and replays the recorded market (#793)', async () => {
    // A sidecar written before the February-2026 /search cap — or imported from
    // another install — can carry limit: 50. The live tool's schema rejects
    // that value, so a verbatim replay is the only way it reaches the wire,
    // and it is a 400 the caller cannot fix from its own arguments.
    await appendSearchHistory({
      id: 'legacy',
      query: 'queen',
      types: ['track'],
      timestamp: new Date().toISOString(),
      top_result_ids: ['spotify:track:t1'],
      limit: 50,
      market: 'GB',
    });
    // Stand in for the live endpoint: it rejects anything above the cap, so a
    // test that only asserted the params would still pass on a throwing call.
    const h = harness((path, params) => {
      if (path === '/search' && Number(params?.limit) > 10) throw new Error('400 Invalid limit');
      return searchResponse();
    });

    const out = await h.invoke('search_rerun', { history_id: 'legacy' });
    assert.equal(out.structuredContent?.ok, true);
    const call = h.gets.find((g) => g.path === '/search');
    assert.ok(call, 'the rerun issues a /search');
    assert.equal(call!.params?.limit, '10', 'replayed limit is clamped to the Feb-2026 cap');
    assert.equal(call!.params?.q, 'queen');
    assert.equal(call!.params?.type, 'track');
    assert.equal(call!.params?.market, 'GB', 'the recorded market reproduces the original scope');
    assert.equal(out.structuredContent?.limit_used, 10);
    assert.equal(out.structuredContent?.limit_clamped_from, 50, 'the payload shows what was dropped');
    assert.equal(out.structuredContent?.market_used, 'GB');
  });

  it('search_rerun reports no clamp when the stored limit is already in range (#793)', async () => {
    await appendSearchHistory({
      id: 'inrange',
      query: 'bowie',
      types: ['track'],
      timestamp: new Date().toISOString(),
      top_result_ids: ['spotify:track:t1'],
      limit: 7,
    });
    const h = harness();
    const out = await h.invoke('search_rerun', { history_id: 'inrange' });
    assert.equal(h.gets.find((g) => g.path === '/search')?.params?.limit, '7', 'in-range limit passes through untouched');
    assert.equal(out.structuredContent?.limit_used, 7);
    assert.equal(out.structuredContent?.limit_clamped_from, undefined, 'no clamp is claimed when none happened');
    assert.equal(out.structuredContent?.market_used, null, 'an entry without a market reports none');
  });

  it('search_rerun coerces a sidecar limit that is not a JSON number (#793)', async () => {
    // The imported / hand-written class named above: the file is under no
    // obligation to hold a number, and pre-fix `"50"` was dropped for the
    // default 5 while the payload claimed no adjustment had happened.
    await writeSidecar([sidecarEntry('stringy', { limit: '50' })]);
    const h = harness((path, params) => {
      if (path === '/search' && Number(params?.limit) > 10) throw new Error('400 Invalid limit');
      return searchResponse();
    });

    const out = await h.invoke('search_rerun', { history_id: 'stringy' });
    assert.equal(out.structuredContent?.ok, true);
    assert.equal(h.gets.find((g) => g.path === '/search')?.params?.limit, '10', 'the string is read, then clamped to the live cap');
    assert.equal(out.structuredContent?.limit_used, 10);
    assert.equal(out.structuredContent?.limit_clamped_from, 50, 'the payload reports the adjustment the coercion made visible');
  });

  it('search_rerun names a stored limit it could not read as a number (#793)', async () => {
    await writeSidecar([sidecarEntry('garbage', { limit: 'lots' }), sidecarEntry('nulled', { limit: null })]);
    const h = harness();

    const garbage = await h.invoke('search_rerun', { history_id: 'garbage' });
    assert.equal(h.gets.find((g) => g.path === '/search')?.params?.limit, '5', 'an unreadable limit falls back to the default');
    assert.equal(garbage.structuredContent?.limit_used, 5);
    assert.equal(garbage.structuredContent?.limit_clamped_from, 'lots', 'the discarded value is reported, not passed off as a chosen default');

    const nulled = await h.invoke('search_rerun', { history_id: 'nulled' });
    assert.equal(nulled.structuredContent?.limit_used, 5);
    assert.equal(nulled.structuredContent?.limit_clamped_from, null, 'a stored null is a discarded limit, reported as such');
  });

  it('search_rerun does not read a blank or boolean limit as zero (#793)', async () => {
    // `Number('')`, `Number('  ')` and `Number(false)` are all 0, so a plain
    // coercion treats them as a recorded 0 — which clamps the replay *up* to a
    // single result and reports `limit_clamped_from: 0`, a number the sidecar
    // never carried. A value that holds no number is a discarded value.
    await writeSidecar([
      sidecarEntry('blank', { limit: '' }),
      sidecarEntry('padded', { limit: '  ' }),
      sidecarEntry('flagged', { limit: false }),
    ]);
    const h = harness();

    for (const id of ['blank', 'padded', 'flagged']) {
      const out = await h.invoke('search_rerun', { history_id: id });
      assert.equal(h.gets.filter((g) => g.path === '/search').at(-1)?.params?.limit, '5', `${id}: a value that is not a number falls back to the default`);
      assert.equal(out.structuredContent?.limit_used, 5, `${id}: no fabricated one-result replay`);
      assert.equal(out.structuredContent?.limit_clamped_from, id === 'blank' ? '' : id === 'padded' ? '  ' : false, `${id}: the raw stored value is what gets reported`);
    }
  });

  it('search_rerun clamps a stored zero up to the floor and says so (#793)', async () => {
    // Unlike a blank, a 0 is a number the sidecar really carried, so it is a
    // real clamp against a real value rather than a discarded one.
    await writeSidecar([sidecarEntry('zero', { limit: 0 })]);
    const h = harness();
    const out = await h.invoke('search_rerun', { history_id: 'zero' });
    assert.equal(h.gets.find((g) => g.path === '/search')?.params?.limit, '1', 'zero clamps up to the 1-result floor');
    assert.equal(out.structuredContent?.limit_used, 1);
    assert.equal(out.structuredContent?.limit_clamped_from, 0);
  });

  it('search_rerun claims no clamp when the sidecar records no limit at all (#793)', async () => {
    await writeSidecar([sidecarEntry('bare', {})]);
    const h = harness();
    const out = await h.invoke('search_rerun', { history_id: 'bare' });
    assert.equal(h.gets.find((g) => g.path === '/search')?.params?.limit, '5', 'no stored limit means the default');
    assert.equal(out.structuredContent?.limit_used, 5);
    assert.equal(out.structuredContent?.limit_clamped_from, undefined, 'a default nobody overrode is not an adjustment');
  });

  it('search_rerun reports no market when the stored market never reached the wire (#793)', async () => {
    // `market` is only sent when the stored value is truthy, so an empty one
    // stays off the wire. `market_used` is read off the entry, so pre-fix it
    // reported the replay as market-scoped when no market param was sent.
    await writeSidecar([sidecarEntry('blank', { market: '' })]);
    const h = harness();
    const out = await h.invoke('search_rerun', { history_id: 'blank' });
    const params = h.gets.find((g) => g.path === '/search')?.params;
    assert.ok(params && !('market' in params), 'no market parameter reached /search');
    assert.equal(out.structuredContent?.market_used, null, 'the payload describes the wire, not the entry');
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
