import test from 'node:test';
import assert from 'node:assert/strict';
import { registerPersonalizationTools } from '../src/tools/personalization.js';

// ---------------------------------------------------------------- fixtures

type ToolContent = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type RegisteredTool = {
  name: string;
  description: string;
  schema: Record<string, { safeParse(value: unknown): { success: boolean } }>;
  handler: (args: Record<string, unknown>) => Promise<ToolContent>;
};

type Call = { method: string; path: string; params?: Record<string, string> };

interface ClientOptions {
  getResponse?: (path: string, params?: Record<string, string>) => unknown;
}

function trackFixture(name = 'Track One') {
  return {
    id: 'trk1',
    name,
    uri: `spotify:track:${name}`,
    type: 'track',
    duration_ms: 210000,
    artists: [{ name: 'Artist One' }],
    album: { name: 'Album One' },
  };
}

function artistFixture(name = 'Artist One', genres: string[] = ['rock']) {
  return { id: 'art1', name, uri: `spotify:artist:${name}`, genres };
}

function makeHarness(opts: ClientOptions = {}) {
  const calls: Call[] = [];
  const client = {
    get: async (path: string, params?: Record<string, string>) => {
      calls.push({ method: 'GET', path, params });
      return opts.getResponse ? opts.getResponse(path, params) : null;
    },
    getAllPages: async () => [],
  };
  const registered: RegisteredTool[] = [];
  const server = {
    tool: (
      name: string,
      description: string,
      schema: RegisteredTool['schema'],
      handler: RegisteredTool['handler'],
    ) => registered.push({ name, description, schema, handler }),
  };
  registerPersonalizationTools(
    server as unknown as Parameters<typeof registerPersonalizationTools>[0],
    client as unknown as Parameters<typeof registerPersonalizationTools>[1],
  );
  return { registered, calls };
}

function findTool(registered: RegisteredTool[], name: string): RegisteredTool {
  const tool = registered.find((t) => t.name === name);
  assert.ok(tool, `expected tool ${name} to be registered`);
  return tool;
}

async function invoke(tool: RegisteredTool, args: Record<string, unknown> = {}) {
  return (tool.handler as (a: Record<string, unknown>) => Promise<ToolContent>)(args);
}

function text(result: ToolContent): string {
  return result.content.map((c) => c.text).join('\n');
}

// ------------------------------------------------------------ get_top_tracks

test('get_top_tracks forwards defaults including offset 0 (#47)', async () => {
  const { registered, calls } = makeHarness({
    getResponse: () => ({ items: [trackFixture()], total: 1 }),
  });
  await invoke(findTool(registered, 'get_top_tracks'));
  const call = calls.find((c) => c.path === '/me/top/tracks');
  assert.deepEqual(call?.params, {
    time_range: 'medium_term',
    limit: '20',
    offset: '0',
  });
});

test('get_top_tracks forwards explicit offset, limit, and time_range', async () => {
  const { registered, calls } = makeHarness({
    getResponse: () => ({ items: [trackFixture('Deep Cut')], total: 51 }),
  });
  const out = text(
    await invoke(findTool(registered, 'get_top_tracks'), {
      time_range: 'long_term',
      limit: 10,
      offset: 50,
    }),
  );
  const call = calls.find((c) => c.path === '/me/top/tracks');
  assert.deepEqual(call?.params, {
    time_range: 'long_term',
    limit: '10',
    offset: '50',
  });
  assert.match(out, /Top tracks \(51 total, showing 1\)/);
  assert.match(out, /"Deep Cut" by Artist One \(3:30\)/);
});

test('get_top_tracks rejects negative offsets but allows deep paging via zod schema', () => {
  const { registered } = makeHarness();
  const schema = findTool(registered, 'get_top_tracks').schema.offset;
  assert.equal(schema.safeParse(-1).success, false);
  assert.equal(schema.safeParse(0).success, true);
  assert.equal(schema.safeParse(50).success, true);
  assert.equal(schema.safeParse(10000).success, true);
});

// ----------------------------------------------------------- get_top_artists

test('get_top_artists forwards defaults including offset 0 (#47)', async () => {
  const { registered, calls } = makeHarness({
    getResponse: () => ({ items: [artistFixture()], total: 1 }),
  });
  await invoke(findTool(registered, 'get_top_artists'));
  const call = calls.find((c) => c.path === '/me/top/artists');
  assert.deepEqual(call?.params, {
    time_range: 'medium_term',
    limit: '20',
    offset: '0',
  });
});

test('get_top_artists forwards explicit offset and renders formatted lines', async () => {
  const { registered, calls } = makeHarness({
    getResponse: () => ({ items: [artistFixture('Obscure Band', [])], total: 60 }),
  });
  const out = text(await invoke(findTool(registered, 'get_top_artists'), { offset: 50 }));
  const call = calls.find((c) => c.path === '/me/top/artists');
  assert.equal(call?.params?.offset, '50');
  assert.match(out, /Top artists \(60 total, showing 1\)/);
  assert.match(out, /Obscure Band — no genres listed \| URI: spotify:artist:Obscure Band/);
});

test('get_top_artists rejects negative offsets but allows deep paging via zod schema', () => {
  const { registered } = makeHarness();
  const schema = findTool(registered, 'get_top_artists').schema.offset;

  assert.equal(schema.safeParse(-1).success, false);
  assert.equal(schema.safeParse(50).success, true);
});
// ----------------------------------------------- shared shaping (#51/#52/#53)

function pagedTracks(n: number, total = n) {
  return { items: Array.from({ length: n }, (_, i) => trackFixture(`T${i}`)), total };
}

test('get_top_tracks json mode returns the raw API payload parseable (#51)', async () => {
  const api = pagedTracks(2);
  const { registered } = makeHarness({ getResponse: () => api });
  const result = await invoke(findTool(registered, 'get_top_tracks'), {
    response_format: 'json',
  });
  assert.deepEqual(JSON.parse(text(result)), api);
  assert.deepEqual(result.structuredContent, api);
});

test('get_top_tracks truncates to max_results with shared footer + pagination (#52/#53)', async () => {
  const { registered } = makeHarness({ getResponse: () => pagedTracks(6, 40) });
  const result = await invoke(findTool(registered, 'get_top_tracks'), { max_results: 2 });
  const out = text(result);
  assert.match(out, /Top tracks \(40 total, showing 2\)/);
  assert.match(out, /\(4 more — pass offset or fetch_all\)/);
  const sc = result.structuredContent as {
    items: unknown[];
    truncated: boolean;
    remaining: number;
    pagination: { total: number; next_offset: number | null };
  };
  assert.equal(sc.items.length, 2);
  // next_offset follows API-level continuation (offset 0 + the full page of
  // 6), never skipping items that truncation hid from this call.
  assert.equal(sc.pagination.next_offset, 6);
  assert.equal(sc.truncated, true);
  assert.equal(sc.remaining, 4);
});

test('get_top_artists detailed mode surfaces followers and popularity (#51)', async () => {
  const artist = { ...artistFixture('Big Band'), followers: { total: 1234 }, popularity: 88 };
  const { registered } = makeHarness({ getResponse: () => ({ items: [artist], total: 1 }) });
  const out = text(
    await invoke(findTool(registered, 'get_top_artists'), { response_format: 'detailed' }),
  );
  assert.match(out, /Followers: 1234 \| Popularity: 88/);
});

test('get_recently_played truncates with footer and exposes the next cursor (#52/#53)', async () => {
  const items = Array.from({ length: 5 }, (_, i) => ({
    track: trackFixture(`R${i}`),
    played_at: '2026-08-01T10:00:00Z',
    context: null,
  }));
  const { registered } = makeHarness({
    getResponse: () => ({ items, cursors: { before: 'b', after: 'a9' }, next: null }),
  });
  const result = await invoke(findTool(registered, 'get_recently_played'), {
    max_results: 2,
  });
  assert.match(text(result), /\(3 more — pass offset or fetch_all\)/);
  assert.match(text(result), /Pass after=a9 to continue\./);
  const sc = result.structuredContent as { next_cursor: string | null; truncated: boolean };
  assert.equal(sc.next_cursor, 'a9');
  assert.equal(sc.truncated, true);
});
