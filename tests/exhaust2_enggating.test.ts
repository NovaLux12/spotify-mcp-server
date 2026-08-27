import test from 'node:test';
import assert from 'node:assert/strict';
import { SpotifyApiError } from '../src/client.js';
import {
  GATED_PATH_PATTERNS,
  graceful403Message,
  installGraceful403Contract,
  isGatedPath,
  registerExhaust2EnggatingTools,
} from '../src/tools/exhaust2_enggating.js';
import { registerBrowseTools } from '../src/tools/browse.js';

type ToolContent = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> };
type RegisteredTool = { name: string; description: string; schema: Record<string, unknown>; handler: (a: Record<string, unknown>) => Promise<ToolContent> };
type Call = { method: string; path: string; params?: Record<string, string> };

interface FakeClient {
  get: (path: string, params?: Record<string, string>, opts?: { priority?: 'normal' | 'low' }) => Promise<unknown>;
  getAllPages: (path: string, params?: Record<string, string>) => Promise<unknown[]>;
  calls: Call[];
}

function makeFakeClient(respond?: (path: string, params?: Record<string, string>) => unknown): FakeClient {
  const calls: Call[] = [];
  const self: FakeClient = {
    calls,
    get: async (path, params) => {
      calls.push({ method: 'GET', path, params });
      const out = respond ? respond(path, params) : null;
      if (out instanceof Error) throw out;
      return out;
    },
    // Mirrors SpotifyClient.getAllPages, which walks pages via this.get so
    // the instance-level wrapper covers paging helpers too.
    getAllPages: async function (this: FakeClient, path: string, params?: Record<string, string>) {
      const page = (await this.get(path, params)) as { items?: unknown[] } | null;
      return page?.items ?? [];
    },
  };
  return self;
}

function makeServer(registered: RegisteredTool[]): unknown {
  return {
    tool: (name: string, description: string, schema: Record<string, unknown>, handler: RegisteredTool['handler']) =>
      registered.push({ name, description, schema, handler }),
  };
}

function find(registered: RegisteredTool[], name: string): RegisteredTool {
  const t = registered.find((x) => x.name === name);
  assert.ok(t, `missing tool ${name}`);
  return t!;
}

function text(r: ToolContent): string {
  return r.content.map((c) => c.text).join('\n');
}

test('isGatedPath classifies the #329 gated families', () => {
  const gated = [
    '/browse/categories',
    '/browse/categories?country=GB',
    '/browse/categories/mood',
    '/browse/categories/mood/playlists',
    '/browse/new-releases',
    '/markets',
    '/artists/4YRxDV8wJFPHPTeXepOstw/top-tracks',
    '/users/j.lee12',
    '/users/j.lee12/playlists',
    '/me/albums/contains',
    '/me/tracks/contains',
    '/me/episodes/contains',
    '/me/shows/contains',
    '/me/audiobooks/contains',
    '/playlists/pl1/followers/contains',
  ];
  for (const p of gated) assert.ok(isGatedPath(p), `expected gated: ${p}`);

  const notGated = [
    '/me/tracks',
    '/me/albums',
    '/playlists/pl1/tracks',
    '/playlists/pl1/followers',
    '/artists/art1/albums',
    '/browse/featured-playlists',
    '/tracks?ids=a,b',
    '/recommendations/available-genre-seeds',
    '/me',
  ];
  for (const p of notGated) assert.ok(!isGatedPath(p), `expected NOT gated: ${p}`);
});

test('GATED_PATH_PATTERNS never matches a query string verbatim', () => {
  assert.ok(isGatedPath('/browse/categories?limit=20'));
  assert.ok(!isGatedPath('/browse/categoriesx'));
});

test('403 on a gated path short-circuits into the graceful contract (#428)', async () => {
  const client = makeFakeClient((path) =>
    path.startsWith('/browse/categories') ? new SpotifyApiError(403, 'Forbidden') : null,
  );
  installGraceful403Contract(client);

  await assert.rejects(
    client.get('/browse/categories', { limit: '20' }),
    (err: Error) => {
      assert.match(err.message, /Spotify returned 403 for \/browse\/categories/);
      assert.match(err.message, /app-registration-gated/);
      assert.match(err.message, /not an OAuth scope problem/);
      assert.match(err.message, /spotify-mcp auth/);
      assert.match(err.message, /will not help/);
      assert.match(err.message, /grandfathered/);
      assert.match(err.message, /Registration-gated surface/);
      return true;
    },
  );
});

test('graceful error preserves the original SpotifyApiError as cause (#429)', async () => {
  const client = makeFakeClient(() => new SpotifyApiError(403, 'Forbidden'));
  installGraceful403Contract(client);

  await assert.rejects(
    client.get('/markets'),
    (err: Error & { cause?: unknown }) => {
      assert.ok(err.cause instanceof SpotifyApiError);
      assert.equal((err.cause as SpotifyApiError).status, 403);
      return true;
    },
  );
});

test('403 on a non-gated path passes through untouched', async () => {
  const client = makeFakeClient(() => new SpotifyApiError(403, 'Premium required'));
  installGraceful403Contract(client);

  await assert.rejects(
    client.get('/me/player/play'),
    (err: unknown) => err instanceof SpotifyApiError && err.status === 403 && err.message === 'Premium required',
  );
});

test('non-403 errors on gated paths pass through untouched', async () => {
  for (const status of [404, 429, 500]) {
    const client = makeFakeClient(() => new SpotifyApiError(status, 'Boom'));
    installGraceful403Contract(client);
    await assert.rejects(
      client.get('/browse/categories'),
      (err: unknown) => err instanceof SpotifyApiError && err.status === status,
    );
  }
});

test('successful responses pass through unchanged', async () => {
  const client = makeFakeClient((path) =>
    path === '/browse/categories' ? { categories: { items: [{ id: 'mood', name: 'Mood' }] } } : null,
  );
  installGraceful403Contract(client);

  const data = (await client.get('/browse/categories')) as { categories: { items: Array<{ id: string }> } };
  assert.equal(data.categories.items[0]?.id, 'mood');
});

test('getAllPages walks over gated endpoints get the same contract', async () => {
  const client = makeFakeClient(() => new SpotifyApiError(403, 'Forbidden'));
  installGraceful403Contract(client);

  await assert.rejects(client.getAllPages('/browse/categories'), (err: Error) => {
    assert.match(err.message, /app-registration-gated/);
    return true;
  });
});

test('install is idempotent -- no stacked wrappers, marker set once', async () => {
  let calls = 0;
  const client = makeFakeClient(() => {
    calls += 1;
    return new SpotifyApiError(403, 'Forbidden');
  });
  installGraceful403Contract(client);
  installGraceful403Contract(client);
  assert.equal(calls, 0);

  await assert.rejects(client.get('/browse/categories'), (err: Error) => {
    // A stacked double wrapper would still produce one graceful message, but
    // the underlying wire call must have happened exactly once.
    assert.match(err.message, /app-registration-gated/);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal((client as unknown as Record<string, unknown>).__graceful403Installed__, true);
});

test('registerExhaust2EnggatingTools installs the contract and registers no tools', () => {
  const client = makeFakeClient();
  const registered: RegisteredTool[] = [];
  registerExhaust2EnggatingTools(makeServer(registered) as never, client as never);
  assert.equal(registered.length, 0);
  assert.equal((client as unknown as Record<string, unknown>).__graceful403Installed__, true);
});

// ------------------------------------------------- #428 end-to-end over browse

test('get_categories returns the graceful message instead of raw Forbidden (#428)', async () => {
  const client = makeFakeClient((path) =>
    path.startsWith('/browse/categories') ? new SpotifyApiError(403, 'Forbidden') : null,
  );
  const browse: RegisteredTool[] = [];
  registerBrowseTools(makeServer(browse) as never, client as never);
  registerExhaust2EnggatingTools(makeServer([]) as never, client as never);

  await assert.rejects(
    find(browse, 'get_categories').handler({}),
    (err: Error) => {
      assert.match(err.message, /app-registration-gated/);
      assert.match(err.message, /will not help/);
      assert.match(err.message, /grandfathered/);
      return true;
    },
  );
});

test('get_category_playlists gets the graceful contract through the same choke point (#428)', async () => {
  const client = makeFakeClient((path) =>
    path.startsWith('/browse/categories') ? new SpotifyApiError(403, 'Forbidden') : null,
  );
  const browse: RegisteredTool[] = [];
  registerBrowseTools(makeServer(browse) as never, client as never);
  registerExhaust2EnggatingTools(makeServer([]) as never, client as never);

  await assert.rejects(
    find(browse, 'get_category_playlists').handler({ category_id: 'mood' }),
    (err: Error) => {
      assert.match(err.message, /Spotify returned 403 for \/browse\/categories\/mood\/playlists/);
      assert.match(err.message, /not an OAuth scope problem/);
      return true;
    },
  );
});

test('graceful403Message embeds Spotify\u2019s own message when present', () => {
  const msg = graceful403Message('/users/j.lee12', new SpotifyApiError(403, 'Forbidden by app settings'));
  assert.match(msg, /Spotify returned 403 for \/users\/j\.lee12 -- Forbidden by app settings/);
  const bare = graceful403Message('/markets', new SpotifyApiError(403, 'Forbidden'));
  assert.ok(!bare.includes(' -- Forbidden'));
});

test('every canonical family regex is anchored at the start', () => {
  for (const re of GATED_PATH_PATTERNS) assert.ok(re.source.startsWith('^'), `unanchored: ${re.source}`);
});
