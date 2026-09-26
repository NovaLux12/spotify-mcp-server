import test from 'node:test';
import assert from 'node:assert/strict';
import { registerCatalogTools } from '../src/tools/catalog.js';

// #787: get_show printed ten embedded episodes with no count, so a 300-episode
// show read as a ten-episode show.

type ToolContent = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type RegisteredTool = {
  name: string;
  description: string;
  schema: Record<string, { safeParse(value: unknown): { success: boolean; data?: unknown } }>;
  handler: (args: Record<string, unknown>) => Promise<ToolContent>;
};

type Call = { method: string; path: string; params?: Record<string, string> };

function makeHarness(register: (server: never, client: never) => void, getResponse: (path: string) => unknown) {
  const calls: Call[] = [];
  const client = {
    get: async (path: string, params?: Record<string, string>) => {
      calls.push(params === undefined ? { method: 'GET', path } : { method: 'GET', path, params });
      return getResponse(path);
    },
    post: async (path: string) => {
      calls.push({ method: 'POST', path });
      return null;
    },
    put: async (path: string) => {
      calls.push({ method: 'PUT', path });
    },
    delete: async (path: string) => {
      calls.push({ method: 'DELETE', path });
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
  register(server as never, client as never);
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

function episodeFixture(index: number) {
  return {
    id: `ep${index}`,
    name: `Episode ${index}`,
    uri: `spotify:episode:ep${index}`,
    duration_ms: 1_800_000,
    release_date: '2026-01-01',
    explicit: false,
    description: 'An episode',
    resume_point: undefined,
  };
}

function showFull(embedded: number, totalEpisodes: number) {
  return {
    id: 'shw1',
    name: 'Great Podcast',
    uri: 'spotify:show:shw1',
    description: 'A great show',
    publisher: 'Acme Media',
    total_episodes: totalEpisodes,
    languages: ['en'],
    media_type: 'audio',
    explicit: false,
    episodes: {
      items: Array.from({ length: embedded }, (_, i) => episodeFixture(i + 1)),
      total: totalEpisodes,
    },
  };
}

/** Rows the detail card prints for episodes: bullet lines. */
function episodeRows(out: string): string[] {
  return out.split('\n').filter((line) => line.startsWith('  • "'));
}

test('get_show discloses that the card previews 10 of a 300-episode show', async () => {
  const { registered, calls } = makeHarness(registerCatalogTools, (path) =>
    path === '/shows/shw1' ? showFull(10, 300) : undefined,
  );

  const out = text(await invoke(findTool(registered, 'get_show'), { id: 'shw1', market: 'US' }));

  assert.equal(calls[0].path, '/shows/shw1');
  assert.equal(episodeRows(out).length, 10, 'the card still previews ten rows');
  assert.match(out, /Episodes: 300 \|/);
  assert.match(out, /10 of 300 episodes shown/);
  assert.match(out, /list_show_episodes/, 'the note must name the tool that pages the rest');
  assert.doesNotMatch(out, /• "Episode 11"/);
});

test('get_show prints no truncation note for a 5-episode show', async () => {
  const { registered } = makeHarness(registerCatalogTools, (path) =>
    path === '/shows/shw1' ? showFull(5, 5) : undefined,
  );

  const out = text(await invoke(findTool(registered, 'get_show'), { id: 'shw1', market: 'US' }));

  assert.equal(episodeRows(out).length, 5);
  assert.doesNotMatch(out, /episodes shown/);
});

test('get_show counts a short embedded preview against the declared total', async () => {
  const { registered } = makeHarness(registerCatalogTools, (path) =>
    path === '/shows/shw1' ? showFull(3, 120) : undefined,
  );

  const out = text(await invoke(findTool(registered, 'get_show'), { id: 'shw1', market: 'US' }));

  assert.equal(episodeRows(out).length, 3);
  assert.match(out, /3 of 120 episodes shown/);
});

test('get_show json mode is unchanged by the preview note', async () => {
  const payload = showFull(10, 300);
  const { registered } = makeHarness(registerCatalogTools, (path) =>
    path === '/shows/shw1' ? payload : undefined,
  );

  const result = await invoke(findTool(registered, 'get_show'), {
    id: 'shw1',
    market: 'US',
    response_format: 'json',
  });

  // json mode is the raw API object; the disclosure is prose, so the payload
  // must not grow a synthetic field the API never sent.
  const parsed = JSON.parse(text(result)) as Record<string, unknown>;
  assert.equal(parsed.total_episodes, 300);
  assert.equal((parsed.episodes as { items: unknown[] }).items.length, 10);
  assert.equal('truncated_by_cap' in parsed, false);
});
