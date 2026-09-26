import test from 'node:test';
import assert from 'node:assert/strict';
import { registerAudiobookTools, resetProfileCountryCache } from '../src/tools/audiobooks.js';
import { SpotifyApiError } from '../src/client.js';
import { initConfig } from '../src/config.js';

// #787: the audiobook surfaces used to hide how much of a book they showed.
// The detail card sliced chapters to ten with no note, and the chapter pager
// had no way to read past one 50-row page.

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

type Walk = { items: unknown[]; truncated: boolean };

interface ClientOptions {
  getResponse?: (path: string, params?: Record<string, string>) => unknown;
  walk?: (path: string, params?: Record<string, string> | undefined, opts?: { maxItems?: number }) => Walk;
}

function makeHarness(register: (server: never, client: never) => void, opts: ClientOptions = {}) {
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
    },
    delete: async (path: string) => {
      calls.push({ method: 'DELETE', path });
    },
    getAllPages: async () => [],
    getAllPagesWithTruncation: async (
      path: string,
      params?: Record<string, string>,
      walkOpts?: { maxItems?: number },
    ) => {
      calls.push({ method: 'WALK', path, params: params ?? {} });
      if (!opts.walk) throw new Error(`test harness has no walk stub for ${path}`);
      return opts.walk(path, params, walkOpts);
    },
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

function chapterFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ch1',
    name: 'Chapter 1',
    uri: 'spotify:chapter:ch1',
    chapter_number: 1,
    duration_ms: 1_500_000,
    release_date: '2021-05-04',
    is_playable: true,
    ...overrides,
  };
}

function chapterList(count: number) {
  return Array.from({ length: count }, (_, i) =>
    chapterFixture({
      id: `ch${i + 1}`,
      name: `Chapter ${i + 1}`,
      uri: `spotify:chapter:ch${i + 1}`,
      chapter_number: i + 1,
    }),
  );
}

function audiobookFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ab1',
    name: 'Project Hail Mary',
    uri: 'spotify:audiobook:ab1',
    authors: [{ name: 'Andy Weir' }],
    narrators: [{ name: 'Ray Porter' }],
    publisher: 'Audible Studios',
    edition: 'Unabridged',
    total_chapters: 40,
    explicit: false,
    languages: ['en'],
    description: 'A lone astronaut must save the earth.',
    chapters: { items: chapterList(40), total: 40 },
    ...overrides,
  };
}

/** Rows the chapter renderers print: lines that open with an indented number. */
function chapterRows(out: string): string[] {
  return out.split('\n').filter((line) => /^ {2}\d+\. "/.test(line));
}

// ------------------------------------------------------------ detail card

test('get_audiobook discloses that the card previews 10 of a 40-chapter book', async () => {
  const { registered } = makeHarness(registerAudiobookTools, {
    getResponse: (path) => (path === '/audiobooks/ab1' ? audiobookFixture() : undefined),
  });

  const out = text(await invoke(findTool(registered, 'get_audiobook'), { id: 'ab1', market: 'US' }));

  // Ten rows are printed — and the card says that is ten of forty, so the
  // collection cannot read as complete (#787).
  assert.equal(chapterRows(out).length, 10);
  assert.match(out, /10 of 40 chapters shown/);
  assert.match(out, /get_audiobook_chapters/);
  assert.doesNotMatch(out, /11\. "Chapter 11"/);
});

test('get_audiobook prints no truncation note for a 5-chapter book', async () => {
  const { registered } = makeHarness(registerAudiobookTools, {
    getResponse: (path) =>
      path === '/audiobooks/ab1'
        ? audiobookFixture({ total_chapters: 5, chapters: { items: chapterList(5), total: 5 } })
        : undefined,
  });

  const out = text(await invoke(findTool(registered, 'get_audiobook'), { id: 'ab1', market: 'US' }));

  assert.equal(chapterRows(out).length, 5);
  assert.doesNotMatch(out, /chapters shown/);
});

test('get_audiobook counts a short embedded preview against the declared total', async () => {
  // Spotify embeds fewer rows than the preview limit on some books; the count
  // that matters is the declared total, not the embedded array length.
  const { registered } = makeHarness(registerAudiobookTools, {
    getResponse: (path) =>
      path === '/audiobooks/ab1'
        ? audiobookFixture({ total_chapters: 300, chapters: { items: chapterList(4), total: 300 } })
        : undefined,
  });

  const out = text(await invoke(findTool(registered, 'get_audiobook'), { id: 'ab1', market: 'US' }));

  assert.equal(chapterRows(out).length, 4);
  assert.match(out, /4 of 300 chapters shown/);
});

// -------------------------------------------------------------- fetch_all

test('get_audiobook_chapters fetch_all walks the pages and returns all 40 chapters', async () => {
  // The stub stands in for the client's paging walk, so the tool is judged on
  // what it asks for and what it returns, not on an array handed back to it.
  const all = chapterList(40);
  const pageSize = 20;
  const { registered, calls } = makeHarness(registerAudiobookTools, {
    // The single-page endpoint still answers, so a build without fetch_all
    // returns a real 20-row page rather than an error: that page IS the defect.
    getResponse: (path) =>
      path === '/audiobooks/ab1/chapters' ? { items: all.slice(0, 20), total: 40 } : undefined,
    walk: (_path, _params, walkOpts) => {
      const max = walkOpts?.maxItems ?? all.length;
      const items: unknown[] = [];
      for (let offset = 0; offset < all.length; offset += pageSize) {
        items.push(...all.slice(offset, offset + pageSize));
        if (items.length >= max) {
          return { items: items.slice(0, max), truncated: items.length < all.length };
        }
      }
      return { items, truncated: false };
    },
  });

  const result = await invoke(findTool(registered, 'get_audiobook_chapters'), {
    id: 'ab1',
    market: 'US',
    fetch_all: true,
  });

  assert.deepEqual(
    calls.filter((c) => c.method === 'GET'),
    [],
    'fetch_all must walk pages instead of issuing a single GET',
  );
  assert.equal(calls.filter((c) => c.method === 'WALK').length, 1);

  const payload = result.structuredContent as {
    items: unknown[];
    pagination: { next_offset: number | null };
    fetch_all_cap: number;
  };
  assert.equal(payload.items.length, 40, 'all forty rows, not one 20-row page');
  assert.equal(payload.pagination.next_offset, null, 'a completed walk has no next page to offer');
  assert.equal(payload.fetch_all_cap, 500, 'the walk is bounded by the fetch-all cap');
  const out = text(result);
  assert.equal(chapterRows(out).length, 40);
  assert.match(out, /walked 40 — every chapter read, cap not reached/);
  assert.match(out, /40\. "Chapter 40"/);
});

test('get_audiobook_chapters fetch_all says so when the walk stops at the fetch-all cap', async () => {
  initConfig({ ...process.env, SPOTIFY_MCP_FETCH_ALL_CAP: '10' });
  try {
    const all = chapterList(40);
    const { registered } = makeHarness(registerAudiobookTools, {
      walk: (_path, _params, walkOpts) => {
        const max = walkOpts?.maxItems ?? all.length;
        // The walk ran into the cap while the book still had rows left.
        return { items: all.slice(0, max), truncated: true };
      },
    });

    const result = await invoke(findTool(registered, 'get_audiobook_chapters'), {
      id: 'ab1',
      market: 'US',
      fetch_all: true,
    });

    const out = text(result);
    assert.equal(chapterRows(out).length, 10, 'the walk returns exactly the rows it read');
    assert.match(out, /fetch-all cap 10 REACHED, chapters past it were not read/);
    const payload = result.structuredContent as {
      fetch_all: boolean;
      fetch_all_cap: number;
      truncated_by_cap: boolean;
    };
    assert.equal(payload.fetch_all, true);
    assert.equal(payload.fetch_all_cap, 10);
    assert.equal(payload.truncated_by_cap, true);
  } finally {
    initConfig(process.env);
  }
});

test('get_audiobook_chapters fetch_all does not call a full-size book truncated', async () => {
  // A book with exactly cap chapters is complete. The verdict comes from the
  // walk itself, not from comparing the row count to the cap (#864).
  initConfig({ ...process.env, SPOTIFY_MCP_FETCH_ALL_CAP: '10' });
  try {
    const all = chapterList(10);
    const { registered } = makeHarness(registerAudiobookTools, {
      walk: () => ({ items: all, truncated: false }),
    });

    const result = await invoke(findTool(registered, 'get_audiobook_chapters'), {
      id: 'ab1',
      market: 'US',
      fetch_all: true,
    });

    const out = text(result);
    assert.equal(chapterRows(out).length, 10);
    assert.doesNotMatch(out, /REACHED/);
    assert.match(out, /every chapter read, cap not reached/);
    const payload = result.structuredContent as { truncated_by_cap: boolean };
    assert.equal(payload.truncated_by_cap, false);
  } finally {
    initConfig(process.env);
  }
});

test('get_audiobook_chapters publishes fetch_all and still pages one page without it', async () => {
  const { registered, calls } = makeHarness(registerAudiobookTools, {
    getResponse: (path) =>
      path === '/audiobooks/ab1/chapters' ? { items: chapterList(20), total: 40 } : undefined,
  });
  const tool = findTool(registered, 'get_audiobook_chapters');

  assert.ok(
    tool.schema.fetch_all,
    'fetch_all must be part of the published schema — without it a 50-row page was the ceiling',
  );
  assert.equal(tool.schema.fetch_all.safeParse(true).success, true);

  const out = text(await invoke(tool, { id: 'ab1', market: 'US' }));

  assert.deepEqual(calls, [
    {
      method: 'GET',
      path: '/audiobooks/ab1/chapters',
      params: { limit: '20', offset: '0', market: 'US' },
    },
  ]);
  assert.match(out, /Chapters for audiobook \(40 total\)/);
  assert.match(out, /More pages available — pass offset=20/);
});

test('get_audiobook_chapters json mode carries the walk verdict, not a bare page', async () => {
  initConfig({ ...process.env, SPOTIFY_MCP_FETCH_ALL_CAP: '2' });
  try {
    const all = chapterList(40);
    const { registered } = makeHarness(registerAudiobookTools, {
      walk: (_path, _params, walkOpts) => ({
        items: all.slice(0, walkOpts?.maxItems ?? 0),
        truncated: true,
      }),
    });

    const result = await invoke(findTool(registered, 'get_audiobook_chapters'), {
      id: 'ab1',
      market: 'US',
      fetch_all: true,
      response_format: 'json',
    });

    // The raw page shape survives; the cap verdict joins it. A json consumer
    // must not be the one surface that reports a capped walk as complete.
    const payload = JSON.parse(text(result)) as {
      items: unknown[];
      total: number;
      fetch_all: boolean;
      fetch_all_cap: number;
      truncated_by_cap: boolean;
    };
    assert.equal(payload.items.length, 2);
    assert.equal(payload.total, 2);
    assert.equal(payload.fetch_all, true);
    assert.equal(payload.fetch_all_cap, 2);
    assert.equal(payload.truncated_by_cap, true);
  } finally {
    initConfig(process.env);
  }
});

test('get_audiobook_chapters walks under the profile-country market when none is given', async () => {
  resetProfileCountryCache();
  const { registered, calls } = makeHarness(registerAudiobookTools, {
    getResponse: (path) => (path === '/me' ? { country: 'AU' } : undefined),
    walk: () => ({ items: chapterList(1), truncated: false }),
  });

  await invoke(findTool(registered, 'get_audiobook_chapters'), { id: 'ab1', fetch_all: true });

  const walk = calls.find((c) => c.method === 'WALK');
  assert.ok(walk, 'expected a page walk');
  assert.deepEqual(walk!.params, { market: 'AU' });
  resetProfileCountryCache();
});

test('get_audiobook_chapters fetch_all keeps the market-gate hint the paged path has', async () => {
  // A default-market walk that Spotify rejects must say why, exactly as the
  // single-GET path does — otherwise fetch_all silently loses the hint.
  resetProfileCountryCache();
  const { registered } = makeHarness(registerAudiobookTools, {
    getResponse: (path) => (path === '/me' ? { country: 'SE' } : undefined),
    walk: () => {
      throw new SpotifyApiError(404, 'not found');
    },
  });

  await assert.rejects(
    () => invoke(findTool(registered, 'get_audiobook_chapters'), { id: 'ab1', fetch_all: true }),
    (err: Error) => {
      assert.match(err.message, /Spotify returned 404/);
      assert.match(err.message, /market SE/);
      assert.match(err.message, /market-gated/);
      return true;
    },
  );
});
