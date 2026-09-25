import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerSearchDeepTool } from '../src/tools/searchdive.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

// search_deep records the window it walked (#766); keep that sidecar in a
// temp dir so the suite never writes to the developer's real home store.
let historyDir: string;
let historyFile: string;
beforeEach(async () => {
  historyDir = await mkdtemp(join(tmpdir(), 'dive-sh-'));
  historyFile = join(historyDir, 'search-history.json');
  process.env.SPOTIFY_MCP_SEARCH_HISTORY_FILE = historyFile;
  delete process.env.SPOTIFY_MCP_SEARCH_HISTORY;
});
afterEach(async () => {
  delete process.env.SPOTIFY_MCP_SEARCH_HISTORY_FILE;
  delete process.env.SPOTIFY_MCP_SEARCH_HISTORY;
  await rm(historyDir, { recursive: true, force: true });
});

const HISTORY_ENTRY = z.object({
  query: z.string(),
  types: z.array(z.string()).optional(),
  top_result_ids: z.array(z.string()),
  limit: z.number().optional(),
  market: z.string().optional(),
  offset: z.number().optional(),
});

async function readHistory() {
  return z.array(HISTORY_ENTRY).parse(JSON.parse(await readFile(historyFile, 'utf8')));
}

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

/** The handler's structuredContent shape, asserted per call at the boundary. */
interface SearchDeepStructured {
  offset: number;
  sections: Record<string, {
    items: Array<{ id: string }>;
    next_offset: number | null;
  }>;
}

// ------------------------------------------------------------- offset paging (#792)

// Pages keyed by index so a window reached only via `offset` serves ids the
// default 0–50 window can never produce, and the last page is short (so the
// walk stops on its own) with `total` left at 0 to prove an unknown total still
// yields no bogus continuation.
function trackPageByOffset(offset: number) {
  const span = offset < 50 ? 10 : 5;
  return {
    tracks: {
      total: offset < 50 ? 100 : 0,
      items: Array.from({ length: span }, (_, i) => ({
        id: `trk-${offset + i}`,
        name: `Song ${offset + i}`,
        uri: `spotify:track:trk-${offset + i}`,
        artists: [{ name: `Artist ${offset + i}` }],
        album: { name: `Album ${offset + i}` },
      })),
    },
  };
}

test('offset walks a later window and the advertised next_offset is accepted (#792)', async () => {
  const { registered, calls } = makeHarness({
    getResponse: (_path, params) => trackPageByOffset(Number(params?.offset ?? 0)),
  });
  const searchDeep = findTool(registered, 'search_deep');

  // Row 55 is past what pages=5 from offset 0 can return, so only a caller
  // supplied offset reaches it.
  const later = await invoke(searchDeep, { query: 'queen', offset: 50 });
  assert.deepEqual(
    calls.map((c) => c.params?.offset),
    ['50'],
  );
  // One boundary cast per call, named: the handler's structuredContent shape.
  const laterWindow = later.structuredContent as SearchDeepStructured;
  assert.equal(laterWindow.sections.tracks.next_offset, null, 'a short page with no declared total is the end');
  assert.match(text(later), /Song 50/);

  // Continuation from a full page: the advertised offset is the one the next
  // call must pass, and re-passing it serves rows the first window did not.
  calls.length = 0;
  const firstWindow = await invoke(searchDeep, { query: 'queen', pages: 2 });
  const firstOut = firstWindow.structuredContent as SearchDeepStructured;
  const advertised = firstOut.sections.tracks.next_offset;
  assert.equal(advertised, 20);
  assert.match(text(firstWindow), /Next page: offset=20/);
  const firstIds = firstOut.sections.tracks.items.map((row) => row.id);

  calls.length = 0;
  const secondWindow = await invoke(searchDeep, { query: 'queen', offset: advertised ?? 0 });
  assert.equal(calls[0].params?.offset, '20');
  const secondOut = secondWindow.structuredContent as SearchDeepStructured;
  const secondIds = secondOut.sections.tracks.items.map((row) => row.id);
  assert.ok(secondIds.length > 0);
  assert.equal(
    secondIds.some((id) => firstIds.includes(id)),
    false,
    'the advertised continuation must not re-serve the window it followed',
  );
});

test('offset past Spotify\'s 1000 ceiling is rejected by the schema', () => {
  const { registered } = makeHarness();
  const offset = findTool(registered, 'search_deep').schema.offset;
  assert.ok(offset, 'offset schema field missing');
  assert.equal(offset.safeParse(1001).success, false);
  assert.equal(offset.safeParse(-1).success, false);
  assert.equal(offset.safeParse(1000).success, true);
});

test('a truncated window footer advertises offset, not a fetch_all this tool lacks', async () => {
  const { registered } = makeHarness({
    getResponse: (_path, params) => trackPageByOffset(Number(params?.offset ?? 0)),
  });
  const result = await invoke(findTool(registered, 'search_deep'), {
    query: 'queen',
    pages: 2,
    max_results: 5,
  });
  const out = text(result);
  assert.match(out, /\(15 more — raise max_results, continue with offset\)/);
  assert.doesNotMatch(out, /fetch_all/);
});

// ------------------------------------------------- search history recording

test('search_deep records the window it walked (#766)', async () => {
  const { registered } = makeHarness({ getResponse: (_p, params) => fullTrackPage(Number(params?.offset ?? 0)) });
  await invoke(findTool(registered, 'search_deep'), { query: 'queen', pages: 2, market: 'GB', offset: 20 });
  const entries = await readHistory();
  assert.equal(entries.length, 1, 'one walk, one entry — not one per page');
  assert.equal(entries[0]!.query, 'queen');
  assert.deepEqual(entries[0]!.types, ['track']);
  // The window the walk started at is what a replay must resume from.
  assert.equal(entries[0]!.offset, 20);
  assert.equal(entries[0]!.market, 'GB');
  // A rerun is a single /search, so the recorded limit is the per-request one.
  assert.equal(entries[0]!.limit, 10);
  assert.deepEqual(entries[0]!.top_result_ids, ['spotify:track:trk-20', 'spotify:track:trk-21', 'spotify:track:trk-22']);
});

test('search_deep records nothing when the walk returns no rows (#766)', async () => {
  const { registered } = makeHarness({ getResponse: () => ({ tracks: { total: 0, items: [] } }) });
  await invoke(findTool(registered, 'search_deep'), { query: 'zzz' });
  await assert.rejects(readFile(historyFile, 'utf8'), { code: 'ENOENT' });
});

test('SPOTIFY_MCP_SEARCH_HISTORY=0 leaves search_deep unrecorded but still returns rows (#766)', async () => {
  process.env.SPOTIFY_MCP_SEARCH_HISTORY = '0';
  const { registered } = makeHarness({ getResponse: (_p, params) => fullTrackPage(Number(params?.offset ?? 0)) });
  const out = text(await invoke(findTool(registered, 'search_deep'), { query: 'queen' }));
  assert.match(out, /Song 0/);
  await assert.rejects(readFile(historyFile, 'utf8'), { code: 'ENOENT' });
});
