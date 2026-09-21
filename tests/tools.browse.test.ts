import test from 'node:test';
import assert from 'node:assert/strict';
import { registerBrowseTools } from '../src/tools/browse.js';
type ToolContent = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> };
type RegisteredTool = { name: string; description: string; schema: Record<string, { safeParse(a: unknown): { success: boolean } }>; handler: (a: Record<string, unknown>) => Promise<ToolContent> };
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
test('get_categories and get_category_playlists', async () => {
  const { registered, calls } = makeHarness((path)=>{
    if (path==='/browse/categories') return { categories:{ items:[{id:'mood',name:'Mood'},{id:'party',name:'Party'}], total:2, limit:20, offset:0 }};
    if (path==='/browse/categories/mood/playlists') return { playlists:{ items:[{name:'Chill',uri:'spotify:playlist:c1',owner:{id:'spotify'}}], total:1, limit:20, offset:0 }};
    return null;
  });
  const r1 = await find(registered,'get_categories').handler({});
  assert.match(text(r1), /Mood/);
  const r2 = await find(registered,'get_category_playlists').handler({ category_id:'mood' });
  assert.match(text(r2), /Chill/);
  assert.ok(calls.some(c=>c.path==='/browse/categories/mood/playlists'));
});
test('get_category_playlists empty', async () => {
  const { registered } = makeHarness(()=>({ playlists:{ items:[], total:0, limit:20, offset:0 }}));
  const r = await find(registered,'get_category_playlists').handler({ category_id:'mood' });
  assert.match(text(r), /No playlists/);
});
test('get_categories maps market to the locale wire param', async () => {
  const { registered, calls } = makeHarness(()=>({ categories:{ items:[], total:0, limit:20, offset:0 }}));
  await find(registered,'get_categories').handler({ market:'GB' });
  assert.deepEqual(calls[0].params, { locale:'en_GB' });
  assert.equal(new URLSearchParams(calls[0].params).toString(), 'locale=en_GB');
});
test('get_category_playlists maps market to the locale wire param', async () => {
  const { registered, calls } = makeHarness(()=>({ playlists:{ items:[], total:0, limit:20, offset:0 }}));
  await find(registered,'get_category_playlists').handler({ category_id:'mood', market:'gb' });
  assert.deepEqual(calls[0].params, { locale:'en_GB' });
  assert.equal(new URLSearchParams(calls[0].params).toString(), 'locale=en_GB');
});
test('browse tools send no locale key when market omitted', async () => {
  const { registered, calls } = makeHarness((path)=>{
    if (path==='/browse/categories') return { categories:{ items:[], total:0, limit:20, offset:0 }};
    if (path==='/browse/categories/mood/playlists') return { playlists:{ items:[], total:0, limit:20, offset:0 }};
    return null;
  });
  await find(registered,'get_categories').handler({});
  assert.ok(!('locale' in (calls[0].params ?? {})));
  assert.ok(!('country' in (calls[0].params ?? {})));
  await find(registered,'get_category_playlists').handler({ category_id:'mood' });
  assert.ok(!('locale' in (calls[1].params ?? {})));
  assert.ok(!('country' in (calls[1].params ?? {})));
});
test('get_categories explicit locale wins over market', async () => {
  const { registered, calls } = makeHarness(()=>({ categories:{ items:[], total:0, limit:20, offset:0 }}));
  await find(registered,'get_categories').handler({ market:'GB', locale:'sv_SE' });
  assert.deepEqual(calls[0].params, { locale:'sv_SE' });
});
test('deprecated country alias resolves like market on both tools', async () => {
  const { registered, calls } = makeHarness((path)=>{
    if (path==='/browse/categories') return { categories:{ items:[], total:0, limit:20, offset:0 }};
    if (path==='/browse/categories/mood/playlists') return { playlists:{ items:[], total:0, limit:20, offset:0 }};
    return null;
  });
  await find(registered,'get_categories').handler({ country:'de' });
  assert.deepEqual(calls[0].params, { locale:'de_DE' });
  await find(registered,'get_category_playlists').handler({ category_id:'mood', country:'JP' });
  assert.deepEqual(calls[1].params, { locale:'ja_JP' });
});
test('market wins over country; explicit locale wins over both', async () => {
  const { registered, calls } = makeHarness(()=>({ categories:{ items:[], total:0, limit:20, offset:0 }}));
  await find(registered,'get_categories').handler({ market:'GB', country:'DE' });
  assert.deepEqual(calls[0].params, { locale:'en_GB' });
  await find(registered,'get_categories').handler({ market:'GB', country:'DE', locale:'sv_SE' });
  assert.deepEqual(calls[1].params, { locale:'sv_SE' });
});
test('browse tools declare market canonical plus deprecated country alias, send no country wire key', async () => {
  const { registered, calls } = makeHarness((path)=>{
    if (path==='/browse/categories') return { categories:{ items:[], total:0, limit:20, offset:0 }};
    if (path==='/browse/categories/mood/playlists') return { playlists:{ items:[], total:0, limit:20, offset:0 }};
    return null;
  });
  for (const name of ['get_categories','get_category_playlists']) {
    const t = find(registered,name);
    assert.ok('market' in t.schema, `${name} missing market`);
    assert.ok('country' in t.schema, `${name} missing deprecated country alias`);
  }
  await find(registered,'get_categories').handler({ market:'GB', country:'DE' });
  assert.deepEqual(calls[0].params, { locale:'en_GB' });
  await find(registered,'get_category_playlists').handler({ category_id:'mood', market:'GB', country:'DE' });
  assert.deepEqual(calls[1].params, { locale:'en_GB' });
});
