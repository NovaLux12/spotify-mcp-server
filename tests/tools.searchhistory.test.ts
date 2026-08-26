import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSearchHistoryTools, loadSearchHistory, saveSearchHistory } from '../src/tools/searchhistory.js';
import type { SpotifyClient } from '../src/client.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'sh-')); process.env.SPOTIFY_MCP_SEARCH_HISTORY_FILE = join(dir, 'search-history.json'); });
afterEach(async () => { delete process.env.SPOTIFY_MCP_SEARCH_HISTORY_FILE; await rm(dir, { recursive: true, force: true }); });

function harness() {
  const registered: any[] = [];
  const gets: string[] = [];
  const client = {
    async get(path: string, params?: any) { gets.push(`${path}?${JSON.stringify(params)}`); return { tracks: { items: [{ id: 't1' }] } } as any; },
  } as unknown as SpotifyClient;
  const s = { tool(n: string, _d: string, sch: any, h: any) { registered.push({ name: n, schema: sch, handler: h }); } } as unknown as McpServer;
  registerSearchHistoryTools(s, client);
  const invoke = async (name: string, args: any) => {
    const t = registered.find((r: any) => r.name === name); assert.ok(t);
    return t.handler(z.object(t.schema).parse(args));
  };
  return { registered, invoke, gets };
}

describe('searchhistory', () => {
  it('registers 2 tools', () => {
    const h = harness(); assert.equal(h.registered.length, 2);
  });
  it('load/save filters 90-day expiry', async () => {
    await saveSearchHistory([
      { id: 'old', query: 'old', timestamp: new Date(Date.now() - 100 * 86400000).toISOString(), top_result_ids: [] },
      { id: 'new', query: 'new', timestamp: new Date().toISOString(), top_result_ids: [] },
    ]);
    const entries = await loadSearchHistory();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, 'new');
  });
  it('search_history returns empty when no entries', async () => {
    const h = harness();
    const out = await h.invoke('search_history', {});
    assert.match(out.content[0].text, /No search history/i);
  });
  it('search_history filters by query substring', async () => {
    await saveSearchHistory([
      { id: '1', query: 'radiohead', timestamp: new Date().toISOString(), top_result_ids: ['spotify:track:1'] },
      { id: '2', query: 'beatles', timestamp: new Date().toISOString(), top_result_ids: ['spotify:track:2'] },
    ]);
    const h = harness();
    const out = await h.invoke('search_history', { query: 'radio' });
    assert.match(out.content[0].text, /radiohead/i);
  });
  it('search_rerun re-executes stored search', async () => {
    await saveSearchHistory([{ id: 'abc', query: 'jazz', types: ['track'], timestamp: new Date().toISOString(), top_result_ids: ['spotify:track:x'] }]);
    const h = harness();
    const out = await h.invoke('search_rerun', { history_id: 'abc' });
    assert.match(out.content[0].text, /Re-ran/i);
    assert.ok((h.gets[0] ?? '').includes('/search'));
  });
  it('search_rerun errors on unknown id', async () => {
    const h = harness();
    const out = await h.invoke('search_rerun', { history_id: 'nope' });
    assert.match(out.content[0].text, /No history entry/i);
  });
});
