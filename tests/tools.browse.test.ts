import './helpers/hermetic.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { registerBrowseTools } from '../src/tools/browse.js';
type ToolContent = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> };
type SchemaField = { safeParse(a: unknown): { success: boolean; data?: unknown }; description?: string };
type RegisteredTool = { name: string; description: string; schema: Record<string, SchemaField>; handler: (a: Record<string, unknown>) => Promise<ToolContent> };
type Call = { method: string; path: string; params?: Record<string,string> };
function makeHarness(getResponse?: (path: string, params?: Record<string,string>) => unknown) {
  const calls: Call[] = [];
  const client = {
    get: async (path: string, params?: Record<string,string>) => { calls.push({method:'GET',path,params}); return getResponse ? getResponse(path, params) : null; },
    post: async (path:string)=>{calls.push({method:'POST',path}); return null;},
    put: async (path:string)=>{calls.push({method:'PUT',path});},
    delete: async (path:string)=>{calls.push({method:'DELETE',path});},
    getAllPages: async () => [],
  };
  const registered: RegisteredTool[] = [];
  const server = { tool: (name:string,desc:string,schema:RegisteredTool['schema'],handler:RegisteredTool['handler'])=> registered.push({name,description:desc,schema,handler}) };
  registerBrowseTools(server as never, client as never);
  return { registered, calls };
}

function find(registered: RegisteredTool[], name:string){ const t=registered.find(x=>x.name===name); assert.ok(t, `missing ${name}`); return t!; }
function text(r:ToolContent){ return r.content.map(c=>c.text).join('\n'); }
test('get_artist_genres returns genres', async () => {
  const { registered } = makeHarness((path)=> path==='/artists/a1' ? {id:'a1',name:'Queen',uri:'spotify:artist:a1',genres:['rock','glam']} : null);
  const r = await find(registered,'get_artist_genres').handler({ artist_id:'a1' });
  assert.match(text(r), /rock/);
  assert.deepEqual(((r.structuredContent as unknown) as {genres:string[]}).genres, ['rock','glam']);
});
test('get_artist_genres handles none listed', async () => {
  const { registered } = makeHarness(()=>({id:'a1',name:'X',uri:'spotify:artist:a1',genres:[]}));
  const r = await find(registered,'get_artist_genres').handler({ artist_id:'a1' });
  assert.match(text(r), /none listed/);
});

// #638: `get_categories` and `get_category_playlists` were deleted with the
// endpoints they wrapped. Spotify's February 2026 changelog removed
// GET /browse/categories, GET /browse/categories/{id} and
// GET /browse/categories/{id}/playlists outright and names no replacement for
// any of them, so the tools were dead rather than degraded — every call failed
// on a current registration. #1013 had already made them name the removal
// instead of returning a confident empty list; this pins the end state: the
// tools are not registered at all.
test('browse module registers only get_artist_genres (#638)', () => {
  const { registered } = makeHarness();
  const names = registered.map((t) => t.name);

  assert.deepEqual(names, ['get_artist_genres']);
  assert.ok(!names.includes('get_categories'), 'get_categories must not be reachable');
  assert.ok(!names.includes('get_category_playlists'), 'get_category_playlists must not be reachable');
  // The market/country alias only ever existed to serve those two tools, and
  // the sole survivor declares neither parameter.
  assert.deepEqual(Object.keys(find(registered, 'get_artist_genres').schema).sort(), ['artist_id', 'response_format']);
});

test('browse module declares no market, country or locale parameter (#638)', () => {
  const { registered } = makeHarness();
  for (const tool of registered) {
    for (const param of ['market', 'country', 'locale']) {
      assert.ok(!tool.schema[param], `${tool.name} must not declare ${param} — the browse market alias is gone`);
    }
  }
});
