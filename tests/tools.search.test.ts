import test from 'node:test';
import assert from 'node:assert/strict';
import { registerSearchTools } from '../src/tools/search.js';

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

type Call = { method: string; path: string; params?: Record<string, string>; body?: unknown };

interface ClientOptions {
  getResponse?: (path: string, params?: Record<string, string>) => unknown;
}

function trackFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: 'Bohemian Rhapsody',
    uri: 'spotify:track:trk1',
    duration_ms: 354000,
    artists: [{ name: 'Queen' }],
    album: { name: 'A Night at the Opera' },
    ...overrides,
  };
}

function artistFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: 'Queen',
    uri: 'spotify:artist:art1',
    genres: ['classic rock', 'glam rock', 'hard rock'],
    ...overrides,
  };
}

function audiobookFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: 'The Hobbit',
    uri: 'spotify:show:ab1',
    authors: [{ name: 'J. R. R. Tolkien' }],
    narrators: [{ name: 'Andy Serkis' }],
    publisher: 'HarperCollins',
    total_chapters: 18,
    ...overrides,
  };
}

function makeHarness(opts: ClientOptions = {}) {
  const calls: Call[] = [];
  const client = {
    get: async (path: string, params?: Record<string, string>) => {
      calls.push(params === undefined ? { method: 'GET', path } : { method: 'GET', path, params });
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
  registerSearchTools(
    server as unknown as Parameters<typeof registerSearchTools>[0],
    client as unknown as Parameters<typeof registerSearchTools>[1],
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

// ------------------------------------------------------------- request shape

test('search defaults to three types with limit 5 and no optional params', async () => {
  const { registered, calls } = makeHarness();
  await invoke(findTool(registered, 'search'), { query: 'queen' });
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.method, 'GET');
  assert.equal(call.path, '/search');
  assert.deepEqual(call.params, { q: 'queen', type: 'track,artist,album', limit: '5' });
});

test('search forwards requested types including audiobook (issue #44)', async () => {
  const { registered, calls } = makeHarness();
  await invoke(findTool(registered, 'search'), { query: 'hobbit', types: ['audiobook'] });
  assert.equal(calls[0].params?.type, 'audiobook');
});

test('search forwards limit, offset and market together', async () => {
  const { registered, calls } = makeHarness();
  await invoke(findTool(registered, 'search'), {
    query: 'queen',
    limit: 50,
    offset: 1000,
    market: 'GB',
  });
  assert.deepEqual(calls[0].params, {
    q: 'queen',
    type: 'track,artist,album',
    limit: '50',
    offset: '1000',
    market: 'GB',
  });
});

test('search forwards include_external=audio passthrough (issue #46)', async () => {
  const { registered, calls } = makeHarness();
  await invoke(findTool(registered, 'search'), {
    query: 'live session',
    types: ['episode'],
    include_external: 'audio',
  });
  assert.equal(calls[0].params?.include_external, 'audio');
  assert.equal(calls[0].params?.type, 'episode');
});

// ------------------------------------------------------------ schema bounds

test('search rejects a bogus type not in the enum', () => {
  const { registered } = makeHarness();
  const search = findTool(registered, 'search');
  assert.equal(search.schema.types.safeParse(['audiobook']).success, true);
  assert.equal(search.schema.types.safeParse(['vinyl']).success, false);
});

test('search accepts limit up to the API maximum of 10 and rejects beyond it (issue #83; Feb 2026 cap)', () => {
  const { registered } = makeHarness();
  const search = findTool(registered, 'search');
  assert.equal(search.schema.limit.safeParse(10).success, true);
  assert.equal(search.schema.limit.safeParse(11).success, false);
  assert.equal(search.schema.limit.safeParse(50).success, false);
  assert.equal(search.schema.limit.safeParse(1).success, true);
  assert.equal(search.schema.limit.safeParse(0).success, false);
});

test('search validates offset within 0–1000 and rejects out-of-bounds values (issue #45)', () => {
  const { registered } = makeHarness();
  const search = findTool(registered, 'search');
  assert.equal(search.schema.offset.safeParse(0).success, true);
  assert.equal(search.schema.offset.safeParse(1000).success, true);
  assert.equal(search.schema.offset.safeParse(-1).success, false);
  assert.equal(search.schema.offset.safeParse(1001).success, false);
  assert.equal(search.schema.offset.safeParse(10.5).success, false);
});

test('search rejects an unsupported include_external value (issue #46)', () => {
  const { registered } = makeHarness();
  const search = findTool(registered, 'search');
  assert.equal(search.schema.include_external.safeParse('audio').success, true);
  assert.equal(search.schema.include_external.safeParse('video').success, false);
});

// ---------------------------------------------------------------- formatting

test('search renders every returned section with totals and URIs', async () => {
  const harness = makeHarness({
    getResponse: () => ({
      tracks: { total: 2, items: [trackFixture()] },
      artists: { total: 1, items: [artistFixture()] },
    }),
  });
  const output = text(await invoke(findTool(harness.registered, 'search'), { query: 'queen' }));
  assert.match(output, /Search results for "queen"/);
  assert.match(output, /TRACKS \(2 total\):/);
  assert.match(
    output,
    /"Bohemian Rhapsody" by Queen — A Night at the Opera \(5:54\) \| URI: spotify:track:trk1/,
  );
  assert.match(output, /ARTISTS \(1 total\):/);
  assert.match(output, /Queen — classic rock, glam rock, hard rock \| URI: spotify:artist:art1/);
  // Only sections present in the response are rendered.
  assert.doesNotMatch(output, /ALBUMS|PLAYLISTS|SHOWS|EPISODES|AUDIOBOOKS/);
});

test('search formats the audiobooks section for type=audiobook queries (issue #44)', async () => {
  const harness = makeHarness({
    getResponse: () => ({
      audiobooks: { total: 1, items: [audiobookFixture()] },
    }),
  });
  const body = text(await invoke(findTool(harness.registered, 'search'), { query: 'hobbit' }));
  assert.match(body, /AUDIOBOOKS \(1 total\):/);
  assert.match(
    body,
    /"The Hobbit" by J\. R\. R\. Tolkien \(HarperCollins, 18 chapters\) \| URI: spotify:show:ab1/,
  );
});

test('search strips null rows inside section items (issue #16 behaviour)', async () => {
  const harness = makeHarness({
    getResponse: () => ({
      tracks: {
        total: 3,
        items: [null, trackFixture({ name: 'Visible Track', uri: 'spotify:track:ok' })],
      },
    }),
  });
  const output = text(await invoke(findTool(harness.registered, 'search'), { query: 'x' }));
  assert.match(output, /"Visible Track"/);
  assert.doesNotMatch(output, /\bnull\b/);
});

test('search surfaces a next-offset hint when more results remain (issue #45)', async () => {
  const harness = makeHarness({
    getResponse: () => ({
      tracks: { total: 120, items: [trackFixture()] },
    }),
  });
  const output = text(
    await invoke(findTool(harness.registered, 'search'), { query: 'queen', limit: 5 }),
  );
  assert.match(output, /Next page: offset=5/);
});

test('search omits the next-offset hint when results are exhausted', async () => {
  const harness = makeHarness({
    getResponse: () => ({
      tracks: { total: 5, items: [trackFixture()] },
    }),
  });
  const output = text(
    await invoke(findTool(harness.registered, 'search'), { query: 'queen', limit: 5 }),
  );
  assert.doesNotMatch(output, /Next page:/);
});

test('search honours the offset in its next-page hint arithmetic', async () => {
  const harness = makeHarness({
    getResponse: () => ({
      tracks: { total: 300, items: [trackFixture()] },
    }),
  });
  const output = text(
    await invoke(findTool(harness.registered, 'search'), { query: 'queen', limit: 50, offset: 50 }),
  );
  assert.match(output, /Next page: offset=100/);
});

test('search returns friendly message on null response and empty item lists', async () => {
  const empty = makeHarness();
  assert.match(
    text(await invoke(findTool(empty.registered, 'search'), { query: 'zzz' })),
    /No results found\./,
  );

  const blank = makeHarness({ getResponse: () => ({ tracks: { total: 0, items: [] } }) });
  assert.match(
    text(await invoke(findTool(blank.registered, 'search'), { query: 'zzz' })),
    /No results found\./,
  );
});

// ----------------------------------------------- shared shaping (#51/#52/#53)

test('search json mode returns the raw API object as parseable JSON (#51)', async () => {
  const api = { tracks: { total: 1, items: [trackFixture()] } };
  const { registered } = makeHarness({ getResponse: () => api });
  const result = await invoke(findTool(registered, 'search'), {
    query: 'bohemian',
    types: ['track'],
    response_format: 'json',
  });
  assert.deepEqual(JSON.parse(text(result)), api);
  assert.deepEqual(result.structuredContent, api);
});

test('search truncates each section to max_results with footer + structuredContent (#52/#53)', async () => {
  const fiveTracks = Array.from({ length: 5 }, (_, i) =>
    trackFixture({ name: `Song ${i}`, uri: `spotify:track:s${i}` }),
  );
  const { registered } = makeHarness({
    getResponse: () => ({ tracks: { total: 12, items: fiveTracks } }),
  });
  const result = await invoke(findTool(registered, 'search'), {
    query: 'song',
    types: ['track'],
    max_results: 2,
  });
  const out = text(result);
  assert.match(out, /TRACKS \(12 total\):/);
  assert.match(out, /\(3 more — pass offset or fetch_all\)/);
  const sc = result.structuredContent as {
    query: string;
    sections: Record<string, { items: unknown[]; total: number; next_offset: number | null }>;
  };
  assert.equal(sc.query, 'song');
  assert.equal(sc.sections.tracks.items.length, 2);
  assert.equal(sc.sections.tracks.total, 12);
  // next_offset follows API-level continuation (offset 0 + full page of 5)
  assert.equal(sc.sections.tracks.next_offset, 5);
});

test('search detailed mode surfaces popularity fields (#51)', async () => {
  const { registered } = makeHarness({
    getResponse: () => ({
      tracks: { total: 1, items: [trackFixture({ popularity: 97 })] },
      artists: { total: 1, items: [artistFixture({ popularity: 80 })] },
    }),
  });
  const out = text(
    await invoke(findTool(registered, 'search'), { query: 'q', response_format: 'detailed' }),
  );
  assert.match(out, /Popularity: 97/);
  assert.match(out, /Popularity: 80/);
});

test('search drops null playlist rows and reads items.total for track counts (issue #84; Feb 2026)', async () => {
  const { registered } = makeHarness({
    getResponse: (path, params) => {
      if (path !== '/search') return null;
      const type = new URLSearchParams(params).get('type');
      if (type !== 'playlist') return null;
      return {
        playlists: {
          total: 9,
          items: [
            null,
            {
              name: 'Focus Hits',
              uri: 'spotify:playlist:pl1',
              owner: { id: 'u1', display_name: 'Owner One' },
              items: { total: 42 },
            },
          ],
        },
      };
    },
  });

  const out = text(await invoke(findTool(registered, 'search'), { query: 'focus', types: ['playlist'] }));
  assert.match(out, /"Focus Hits" by Owner One \(42 tracks\)/);
  // The filtered null slot must not render or crash.
  assert.doesNotMatch(out, /undefined|by u1 \(0 tracks\)/);
});
