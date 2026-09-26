import test from 'node:test';
import assert from 'node:assert/strict';
import { registerBrowseTools } from '../src/tools/browse.js';
import { SpotifyApiError } from '../src/client.js';
import { installGatedPathContract } from '../src/gating.js';
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

function parseArgs(tool: RegisteredTool, args: Record<string, unknown>): Record<string, unknown> {
  const parsed: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(args)) {
    const field = tool.schema[name];
    assert.ok(field, `missing schema field ${name}`);
    const result = field.safeParse(value);
    assert.equal(result.success, true, `invalid ${name}`);
    parsed[name] = result.data;
  }
  return parsed;
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

test('browse tools validate canonical market and deprecated country aliases', () => {
  const { registered } = makeHarness();
  for (const name of ['get_categories', 'get_category_playlists']) {
    const tool = find(registered, name);
    assert.ok(tool.schema.market);
    assert.ok(tool.schema.country);
    assert.equal(tool.schema.market.safeParse('gb').data, 'GB');
    assert.equal(tool.schema.country.safeParse('us').data, 'US');
    assert.equal(tool.schema.market.safeParse('USA').success, false);
    assert.equal(tool.schema.market.safeParse('G').success, false);
    assert.equal(tool.schema.country.safeParse('1A').success, false);
    assert.match(tool.schema.country.description ?? '', /Deprecated compatibility spelling/);
  }
});

test('browse tools forward canonical and deprecated market spellings as market', async () => {
  const { registered, calls } = makeHarness((path) => {
    if (path === '/browse/categories') return { categories: { items: [], total: 0, limit: 20, offset: 0 } };
    return { playlists: { items: [], total: 0, limit: 20, offset: 0 } };
  });
  const categories = find(registered, 'get_categories');
  const playlists = find(registered, 'get_category_playlists');

  await categories.handler(parseArgs(categories, { market: 'gb' }));
  await categories.handler(parseArgs(categories, { country: 'ca' }));
  await playlists.handler(parseArgs(playlists, { category_id: 'mood', market: 'de' }));
  await playlists.handler(parseArgs(playlists, { category_id: 'mood', country: 'fr' }));

  assert.deepEqual(calls.map((call) => call.params), [
    { market: 'GB' },
    { market: 'CA' },
    { market: 'DE' },
    { market: 'FR' },
  ]);
});

test('browse tools reject conflicting market spellings before calling Spotify', async () => {
  const { registered, calls } = makeHarness(() => null);
  const categories = find(registered, 'get_categories');
  const playlists = find(registered, 'get_category_playlists');

  await assert.rejects(
    categories.handler(parseArgs(categories, { market: 'GB', country: 'US' })),
    /Conflicting values: market \("GB"\) and deprecated country \("US"\) differ/,
  );
  await assert.rejects(
    playlists.handler(parseArgs(playlists, { category_id: 'mood', market: 'GB', country: 'US' })),
    /Conflicting values: market \("GB"\) and deprecated country \("US"\) differ/,
  );
  assert.equal(calls.length, 0);
});

test('browse tools accept matching canonical and deprecated market spellings', async () => {
  const { registered, calls } = makeHarness((path) => {
    if (path === '/browse/categories') return { categories: { items: [], total: 0, limit: 20, offset: 0 } };
    return { playlists: { items: [], total: 0, limit: 20, offset: 0 } };
  });
  const categories = find(registered, 'get_categories');
  const playlists = find(registered, 'get_category_playlists');

  await categories.handler(parseArgs(categories, { market: 'gb', country: 'GB' }));
  await playlists.handler(parseArgs(playlists, { category_id: 'mood', market: 'GB', country: 'gb' }));

  assert.deepEqual(calls.map((call) => call.params), [{ market: 'GB' }, { market: 'GB' }]);
});

// #1013: Spotify's February 2026 changelog removed GET /browse/categories and
// GET /browse/categories/{id} with no replacement. Before the fix the two
// category tools turned that dead endpoint into a confident wrong answer: a
// 403/404 read as "not found", and a response with no payload read as an empty
// category list.
function assertNamesRemovedEndpoint(err: unknown): boolean {
  const message = (err as Error).message;
  assert.match(message, /February 2026 Web API changes/);
  assert.match(message, /no replacement endpoint/);
  assert.doesNotMatch(message, /No categories found|No playlists found/);
  return true;
}

test('#1013 get_categories names the removed endpoint on 403 instead of an empty list', async () => {
  const { registered } = makeHarness((path) => {
    if (path === '/browse/categories') throw new SpotifyApiError(403, 'Forbidden');
    return null;
  });
  await assert.rejects(() => find(registered, 'get_categories').handler({}), assertNamesRemovedEndpoint);
});

test('#1013 get_categories names the removed endpoint on 404, not a missing object', async () => {
  const { registered } = makeHarness((path) => {
    if (path === '/browse/categories') throw new SpotifyApiError(404, 'Not found.');
    return null;
  });
  await assert.rejects(
    () => find(registered, 'get_categories').handler({}),
    (err: Error) => {
      assertNamesRemovedEndpoint(err);
      assert.match(err.message, /Spotify answered 404 — Not found\./);
      return true;
    },
  );
});

test('#1013 get_categories reports a payload-less response as unreadable, not as zero categories', async () => {
  const { registered } = makeHarness(() => ({}));
  await assert.rejects(
    () => find(registered, 'get_categories').handler({}),
    (err: Error) => {
      assert.match(err.message, /no categories payload/);
      assert.doesNotMatch(err.message, /No categories found/);
      return true;
    },
  );
});

test('#1013 get_category_playlists names the removed endpoint on 403', async () => {
  const { registered } = makeHarness((path) => {
    if (path === '/browse/categories/mood/playlists') throw new SpotifyApiError(403, 'Forbidden');
    return null;
  });
  await assert.rejects(
    () => find(registered, 'get_category_playlists').handler({ category_id: 'mood' }),
    assertNamesRemovedEndpoint,
  );
});

test('#1013 get_category_playlists reports a payload-less response as unreadable, not as zero playlists', async () => {
  const { registered } = makeHarness(() => ({}));
  await assert.rejects(
    () => find(registered, 'get_category_playlists').handler({ category_id: 'mood' }),
    (err: Error) => {
      assert.match(err.message, /no playlists payload/);
      assert.doesNotMatch(err.message, /No playlists found/);
      return true;
    },
  );
});

test('#1013 a non-removal failure from the categories family is passed through unchanged', async () => {
  const { registered } = makeHarness((path) => {
    if (path === '/browse/categories') throw new SpotifyApiError(429, 'API rate limit exceeded');
    return null;
  });
  await assert.rejects(
    () => find(registered, 'get_categories').handler({}),
    (err: Error) => {
      assert.doesNotMatch(err.message, /February 2026/);
      assert.match(err.message, /API rate limit exceeded/);
      return true;
    },
  );
});

test('#1013 get_categories names the removal when the gated contract re-raises the 403', async () => {
  // The production shape: index.ts installs installGatedPathContract on every
  // client, so the 403 arrives as a plain Error, not a SpotifyApiError. The
  // tool must still recognise it as the removed endpoint rather than passing
  // on a message that only says "gated".
  const client = {
    get: async () => {
      throw new SpotifyApiError(403, 'Forbidden');
    },
  };
  installGatedPathContract(client as never);
  const registered: RegisteredTool[] = [];
  const server = {
    tool: (name: string, description: string, schema: RegisteredTool['schema'], handler: RegisteredTool['handler']) =>
      registered.push({ name, description, schema, handler }),
  };
  registerBrowseTools(server as never, client as never);
  await assert.rejects(
    () => find(registered, 'get_categories').handler({}),
    (err: Error) => {
      assert.match(err.message, /February 2026 Web API changes/);
      assert.match(err.message, /Spotify returned 403 for \/browse\/categories/);
      assert.match(err.message, /app-registration-gated/);
      return true;
    },
  );
});
