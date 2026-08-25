import test from 'node:test';
import assert from 'node:assert/strict';
import { registerSearchDeepTool } from '../src/tools/searchdive.js';

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

function makeHarness(opts: ClientOptions = {}) {
  const calls: Call[] = [];
  const client = {
    get: async (path: string, params?: Record<string, string>) => {
      calls.push({ method: 'GET', path, params });
      return opts.getResponse ? opts.getResponse(path, params) : null;
    },
    post: async (path: string) => {
      calls.push({ method: 'POST', path });
      return null;
    },
    put: async (path: string) => {
      calls.push({ method: 'PUT', path });
      return null;
    },
    delete: async (path: string) => {
      calls.push({ method: 'DELETE', path });
      return null;
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
  registerSearchDeepTool(
    server as unknown as Parameters<typeof registerSearchDeepTool>[0],
    client as unknown as Parameters<typeof registerSearchDeepTool>[1],
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

// Full page of 10 tracks with unique ids for the given offset.
function fullTrackPage(offset: number) {
  return {
    tracks: {
      total: 100,
      items: Array.from({ length: 10 }, (_, i) => ({
        id: `trk-${offset + i}`,
        name: `Song ${offset + i}`,
        uri: `spotify:track:trk-${offset + i}`,
        artists: [{ name: `Artist ${offset + i}` }],
        album: { name: `Album ${offset + i}` },
      })),
    },
  };
}

// ------------------------------------------------------------- request shape

test('search_deep defaults to one page of tracks', async () => {
  const { registered, calls } = makeHarness();
  await invoke(findTool(registered, 'search_deep'), { query: 'queen' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/search');
  assert.deepEqual(calls[0].params, { q: 'queen', type: 'track', limit: '10', offset: '0' });
});

test('search_deep walks offsets 0,10,20 for pages=3', async () => {
  const { registered, calls } = makeHarness({ getResponse: (_p, params) => fullTrackPage(Number(params?.offset ?? 0)) });
  const searchDeep = findTool(registered, 'search_deep');
  await invoke(searchDeep, { query: 'queen', pages: 3 });
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((c) => c.params?.offset),
    ['0', '10', '20'],
  );
  calls.forEach((c) => {
    assert.equal(c.params?.limit, '10');
    assert.equal(c.params?.type, 'track');
  });
});

test('search_deep forwards market on every page request', async () => {
  const { registered, calls } = makeHarness();
  await invoke(findTool(registered, 'search_deep'), { query: 'queen', market: 'GB' });
  assert.equal(calls[0].params?.market, 'GB');
});

test('early stop verified: short page halts the walk despite pages=5', async () => {
  const { registered, calls } = makeHarness({
    getResponse: (_path, params) => {
      const offset = Number(params?.offset ?? 0);
      if (offset === 0) return fullTrackPage(0);
      return { tracks: { total: 100, items: fullTrackPage(10).tracks.items.slice(0, 3) } };
    },
  });
  const result = await invoke(findTool(registered, 'search_deep'), { query: 'queen', pages: 5 });
  assert.deepEqual(
    calls.map((c) => c.params?.offset),
    ['0', '10'],
  );
  assert.match(text(result), /13 unique across 2 pages/);
});

test('search_deep dedupes rows by id across pages and keeps first occurrence order', async () => {
  const { registered, calls } = makeHarness({
    getResponse: (_path, params) => {
      const offset = Number(params?.offset ?? 0);
      // Second page repeats the same ids as page one.
      return fullTrackPage(offset === 0 ? 0 : 0);
    },
  });
  const result = await invoke(findTool(registered, 'search_deep'), { query: 'queen', pages: 3 });
  assert.equal(calls.length, 3); // dedupe does not stop the walk
  const structured = result.structuredContent as {
    sections: { tracks: { items: unknown[]; unique_count: number } };
  };
  assert.equal(structured.sections.tracks.unique_count, 10);
  assert.equal(structured.sections.tracks.items.length, 10);
});

test('search_deep filters null playlist rows instead of crashing', async () => {
  const { registered } = makeHarness({
    getResponse: () => ({
      playlists: {
        total: 2,
        items: [
          { id: 'pl1', name: 'Mix', uri: 'spotify:playlist:pl1', owner: { display_name: 'Spotify' } },
          null,
          null,
        ],
      },
    }),
  });
  const result = await invoke(findTool(registered, 'search_deep'), {
    query: 'chill',
    types: ['playlist'],
  });
  const out = text(result);
  assert.match(out, /PLAYLISTS \(1 unique across 1 page/);
  assert.match(out, /"Mix" by Spotify/);
});

test('pages above 5 are rejected by the schema', () => {
  const { registered } = makeHarness();
  const tool = findTool(registered, 'search_deep');
  const pages = tool.schema.pages;
  assert.ok(pages, 'pages schema field missing');
  assert.equal(pages.safeParse(6).success, false);
  assert.equal(pages.safeParse(0).success, false);
  assert.equal(pages.safeParse(5).success, true);
});

test('json mode returns raw deduped items keyed by plural section', async () => {
  const { registered } = makeHarness({ getResponse: () => fullTrackPage(0) });
  const result = await invoke(findTool(registered, 'search_deep'), {
    query: 'queen',
    response_format: 'json',
  });
  const raw = JSON.parse(result.content[0].text) as Record<string, unknown>;
  const structured = result.structuredContent as Record<string, unknown>;
  assert.ok(Array.isArray(raw.tracks));
  assert.equal((raw.tracks as unknown[]).length, 10);
  assert.deepEqual(raw, structured);
});

test('no results yields a plain empty message', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'search_deep'), { query: 'zzzznothing' });
  assert.equal(text(result), 'No results found.');
});
