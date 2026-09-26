import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { SpotifyApiError } from '../src/client.js';
import { GATED_PATH_PATTERNS, graceful403Message, installGatedPathContract, isGatedError, isGatedPath } from '../src/gating.js';
import { registerExhaust2EnggatingTools } from '../src/tools/exhaust2_enggating.js';
import { registerBrowseTools } from '../src/tools/browse.js';
import { registerExhaust2CatalogTools } from '../src/tools/exhaust2_catalog.js';
import { registerCatalogTools } from '../src/tools/catalog.js';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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
    '/me/following/contains',
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

test('403 on a gated path is annotated and rethrown as the original SpotifyApiError (#765, was #428)', async () => {
  const client = makeFakeClient((path) =>
    path.startsWith('/browse/categories') ? new SpotifyApiError(403, 'Forbidden') : null,
  );
  installGatedPathContract(client);

  await assert.rejects(
    client.get('/browse/categories', { limit: '20' }),
    (err: unknown) => {
      // #765: the wrapper no longer replaces the error type. The instance
      // IS the SpotifyApiError, with its status, message and cause intact --
      // the only addition is the gated-surface annotation that
      // tool-level fallbacks branch on.
      assert.ok(err instanceof SpotifyApiError, 'gated 403 must remain a SpotifyApiError');
      assert.equal((err as SpotifyApiError).status, 403);
      assert.equal((err as SpotifyApiError).message, 'Forbidden');
      assert.equal((err as unknown as { gatedSurface?: boolean }).gatedSurface, true);
      assert.equal((err as unknown as { gatedPath?: string }).gatedPath, '/browse/categories');
      assert.ok(isGatedError(err));
      return true;
    },
  );
});

test('graceful annotation preserves the original SpotifyApiError (cause chain untouched) (#765, was #429)', async () => {
  const client = makeFakeClient(() => new SpotifyApiError(403, 'Forbidden'));
  installGatedPathContract(client);

  await assert.rejects(
    client.get('/markets'),
    (err: unknown) => {
      // The wrapper is transparent: the same instance that Spotify raised is
      // what callers see, so any `cause` the client attached upstream still
      // walks through unchanged.
      assert.ok(err instanceof SpotifyApiError);
      assert.equal((err as SpotifyApiError).status, 403);
      assert.equal((err as unknown as { gatedSurface?: boolean }).gatedSurface, true);
      assert.equal((err as unknown as { gatedPath?: string }).gatedPath, '/markets');
      return true;
    },
  );
});

test('403 on a non-gated path passes through untouched', async () => {
  const client = makeFakeClient(() => new SpotifyApiError(403, 'Premium required'));
  installGatedPathContract(client);

  await assert.rejects(
    client.get('/me/player/play'),
    (err: unknown) => err instanceof SpotifyApiError && err.status === 403 && err.message === 'Premium required',
  );
});

test('non-403 errors on gated paths pass through untouched', async () => {
  for (const status of [404, 429, 500]) {
    const client = makeFakeClient(() => new SpotifyApiError(status, 'Boom'));
    installGatedPathContract(client);
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
  installGatedPathContract(client);

  const data = (await client.get('/browse/categories')) as { categories: { items: Array<{ id: string }> } };
  assert.equal(data.categories.items[0]?.id, 'mood');
});

test('getAllPages walks over gated endpoints get the same contract', async () => {
  const client = makeFakeClient(() => new SpotifyApiError(403, 'Forbidden'));
  installGatedPathContract(client);

  await assert.rejects(client.getAllPages('/browse/categories'), (err: unknown) => {
    // #765: the wrapper annotates the same SpotifyApiError instance, so a
    // paged read over a gated endpoint sees the annotation too.
    assert.ok(err instanceof SpotifyApiError);
    assert.equal((err as unknown as { gatedSurface?: boolean }).gatedSurface, true);
    assert.equal((err as unknown as { gatedPath?: string }).gatedPath, '/browse/categories');
    return true;
  });
});

test('install is idempotent -- no stacked wrappers, marker set once', async () => {
  let calls = 0;
  const client = makeFakeClient(() => {
    calls += 1;
    return new SpotifyApiError(403, 'Forbidden');
  });
  installGatedPathContract(client);
  installGatedPathContract(client);
  assert.equal(calls, 0);

  await assert.rejects(client.get('/browse/categories'), (err: unknown) => {
    // A stacked double wrapper would still annotate the same instance, but
    // the underlying wire call must have happened exactly once.
    assert.ok(err instanceof SpotifyApiError);
    assert.equal((err as unknown as { gatedSurface?: boolean }).gatedSurface, true);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal((client as unknown as Record<string, unknown>).__gatedPathContractInstalled__, true);
});

test('registerExhaust2EnggatingTools registers no tools and installs nothing (#791)', () => {
  const client = makeFakeClient();
  const registered: RegisteredTool[] = [];
  registerExhaust2EnggatingTools(makeServer(registered) as never, client as never);
  assert.equal(registered.length, 0);
  // The gating contract must not be reachable through the module's toolset
  // key: the marker stays unset, so the wrapper never lands on the client.
  assert.equal((client as unknown as Record<string, unknown>).__gatedPathContractInstalled__, undefined);
});

// ------------------------------------------------- #428 end-to-end over browse

test('get_categories returns the graceful message instead of raw Forbidden (#428)', async () => {
  const client = makeFakeClient((path) =>
    path.startsWith('/browse/categories') ? new SpotifyApiError(403, 'Forbidden') : null,
  );
  const browse: RegisteredTool[] = [];
  registerBrowseTools(makeServer(browse) as never, client as never);
  installGatedPathContract(client as never);

  await assert.rejects(
    find(browse, 'get_categories').handler({}),
    (err: Error & { cause?: unknown }) => {
      // #765: the wrapper keeps the SpotifyApiError instance, so
      // isRemovedEndpointFailure still matches on the 403 status and the
      // tool throws browseCategoriesUnavailable with the gated Spotify
      // message embedded in the detail line and as the error cause.
      assert.match(err.message, /browse-categories lookup/);
      assert.match(err.message, /Spotify answered 403/);
      assert.match(err.message, /Forbidden/);
      assert.match(err.message, /removed by Spotify’s February 2026 Web API changes/);
      assert.match(err.message, /grandfathered/);
      assert.ok(err.cause instanceof SpotifyApiError);
      assert.equal((err.cause as SpotifyApiError).status, 403);
      assert.equal((err.cause as unknown as { gatedSurface?: boolean }).gatedSurface, true);
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
  installGatedPathContract(client as never);

  await assert.rejects(
    find(browse, 'get_category_playlists').handler({ category_id: 'mood' }),
    (err: Error & { cause?: unknown }) => {
      // Same shape as get_categories: the 403 is gated, the tool surfaces
      // the removal path with the Spotify message embedded.
      assert.match(err.message, /\/browse\/categories\/mood\/playlists/);
      assert.match(err.message, /Spotify answered 403/);
      assert.match(err.message, /removed by Spotify’s February 2026 Web API changes/);
      assert.ok(err.cause instanceof SpotifyApiError);
      assert.equal((err.cause as unknown as { gatedSurface?: boolean }).gatedSurface, true);
      assert.equal((err.cause as unknown as { gatedPath?: string }).gatedPath, '/browse/categories/mood/playlists');
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

// ------------------------------------------------- #765 composition over real tools

/**
 * #765 composition: the wrapper is transparent (annotates the SpotifyApiError
 * and rethrows), so tool handlers with their own designed 403 degradation on a
 * gated path see the same `err instanceof SpotifyApiError && err.status === 403`
 * shape they were written against. Three canaries cover three gated families:
 *   - `category_resolver` (/browse/categories)        -> `gated: true`
 *   - `artist_collab_network` (/artists/{id}/top-tracks) -> `top_tracks_available: false`
 *   - `market_validate` (/markets)                    -> `note` + `account_market`
 * Plus a control that a 403 on a non-gated path still surfaces as the
 * original SpotifyApiError -- the wrapper is a no-op outside its class.
 */
test('composition: gated 403 reaches tool handlers as SpotifyApiError and triggers designed degradations (#765)', async () => {
  const client = makeFakeClient((path) => {
    if (
      path === '/browse/categories' ||
      path === '/browse/categories?limit=50&offset=0' ||
      /^\/artists\/[^/]+\/top-tracks$/.test(path) ||
      path === '/markets'
    ) {
      return new SpotifyApiError(403, 'Forbidden');
    }
    // Bare artist lookup (artist_collab_network walks it first, before
    // top-tracks), and the albums walk it falls back to.
    if (path === '/artists/a1') {
      return { id: 'a1', name: 'Artist', uri: 'spotify:artist:a1', genres: [] };
    }
    if (/^\/artists\/[^/]+\/albums$/.test(path)) {
      return { items: [], total: 0, limit: 10, offset: 0 };
    }
    if (path === '/me') {
      return { id: 'u1', display_name: 'me', country: 'GB', product: 'premium', email: null, uri: 'spotify:user:u1' };
    }
    return null;
  });
  installGatedPathContract(client);

  const exhaust2: RegisteredTool[] = [];
  registerExhaust2CatalogTools(makeServer(exhaust2) as never, client as never);
  const catalog: RegisteredTool[] = [];
  registerCatalogTools(makeServer(catalog) as never, client as never);

  const category = find(exhaust2, 'category_resolver').handler({
    text: 'chill electronic',
    response_format: 'json',
  });
  const catResult = (await category) as { structuredContent: { gated?: boolean; endpoint?: string } };
  assert.equal(catResult.structuredContent.gated, true, 'category_resolver must emit `gated: true`');
  assert.equal(catResult.structuredContent.endpoint, '/browse/categories');

  const collab = find(exhaust2, 'artist_collab_network').handler({
    artist_id: 'a1',
    response_format: 'json',
  });
  const collabResult = (await collab) as { structuredContent: { top_tracks_available?: boolean } };
  assert.equal(
    collabResult.structuredContent.top_tracks_available,
    false,
    'artist_collab_network must emit `top_tracks_available: false`',
  );

  const market = find(catalog, 'market_validate').handler({
    markets: ['GB'],
    include_account_market: true,
    response_format: 'json',
  });
  const marketResult = (await market) as { structuredContent: { note?: string; account_market?: string | null } };
  assert.match(marketResult.structuredContent.note ?? '', /\/markets returned 403/);
  assert.equal(marketResult.structuredContent.account_market, 'GB');
});

test('composition: non-gated 403 still surfaces as the original SpotifyApiError, unannotated (#765 control)', async () => {
  // Control: the wrapper is a no-op outside the gated class, so a non-gated 403
  // (e.g. a Premium wall on /me/player/play) reaches the tool exactly as
  // Spotify raised it -- no gatedSurface annotation, no wrapping Error.
  const client = makeFakeClient(() => new SpotifyApiError(403, 'Premium required'));
  installGatedPathContract(client);

  await assert.rejects(
    client.get('/me/player/play'),
    (err: unknown) => {
      assert.ok(err instanceof SpotifyApiError, 'non-gated 403 must remain a SpotifyApiError');
      assert.equal((err as SpotifyApiError).message, 'Premium required');
      assert.equal((err as unknown as { gatedSurface?: boolean }).gatedSurface, undefined);
      assert.ok(!isGatedError(err), 'isGatedError must NOT classify a non-gated 403 as gated');
      return true;
    },
  );
});

// ------------------------------------------- #791 production-path composition

/**
 * The unit tests above install the contract by hand. These drive the real
 * entry point (src/index.ts) over stdio, because the defect was never in the
 * wrapper: it was that the production path installed it only while the
 * `exhaust2enggating` registration key was active.
 *
 * `category_resolver` is the canary. Its handler converts a raw gated 403 into
 * its own `gated: true` disclosure, and only when the error still IS a
 * SpotifyApiError -- so the same platform condition produced a disclosure on
 * one host configuration and a different failure on another. Whatever the
 * contract decides, it must decide it identically in every configuration.
 */

const REPO_ROOT = join(import.meta.dirname, '..');

/**
 * Preloaded ahead of src/index.ts: every api.spotify.com request comes back as
 * Spotify's blanket registration-gated 403, with no network and no token.
 */
const FETCH_STUB_SOURCE = `
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.includes('api.spotify.com')) {
    return new Response(JSON.stringify({ error: { status: 403, message: 'Forbidden' } }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }
  return real(input, init);
};
`;

let stubDir: string | undefined;
let tokenFile: string | undefined;

async function serverFixture(): Promise<{ stub: string; tokens: string }> {
  if (!stubDir || !tokenFile) {
    stubDir = await mkdtemp(join(tmpdir(), 'spotify-mcp-enggating-'));
    await writeFile(join(stubDir, 'gated-403-fetch-stub.mjs'), FETCH_STUB_SOURCE);
    tokenFile = join(stubDir, 'tokens.json');
    await writeFile(
      tokenFile,
      JSON.stringify({ access_token: 'enggating-test', refresh_token: 'enggating-test', expires_at: Date.now() + 3_600_000 }),
      { mode: 0o600 },
    );
  }
  return { stub: join(stubDir, 'gated-403-fetch-stub.mjs'), tokens: tokenFile };
}

after(async () => {
  if (stubDir) await rm(stubDir, { recursive: true, force: true });
});

interface JsonRpcResponse { error?: { code: number; message: string }; result?: Record<string, unknown> }

/** Minimal newline-delimited JSON-RPC client over the spawned server's stdio. */
class ServerSession {
  private buffer = '';
  private nextId = 0;
  private stderrText = '';
  private readonly pending = new Map<number, (res: JsonRpcResponse) => void>();
  readonly child: ChildProcessWithoutNullStreams;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.on('data', (chunk: string) => { this.stderrText += chunk; });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      const message = JSON.parse(line) as JsonRpcResponse & { id?: number };
      if (typeof message.id !== 'number') continue;
      const resolve = this.pending.get(message.id);
      if (!resolve) continue;
      this.pending.delete(message.id);
      resolve(message);
    }
  }

  /** Every request is deadline-bounded: a wedged child must fail, not hang. */
  request(method: string, params: Record<string, unknown> = {}): Promise<JsonRpcResponse> {
    const id = ++this.nextId;
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.child.kill('SIGKILL');
        reject(new Error(`${method} timed out after 20s\nstderr:\n${this.stderrText}`));
      }, 20_000);
      this.pending.set(id, (res) => { clearTimeout(timer); resolve(res); });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  stderr(): string {
    return this.stderrText;
  }

  stop(): void {
    this.child.stdin.end();
    setTimeout(() => this.child.kill('SIGKILL'), 2000).unref();
  }
}

interface ToolCall { tool: string; args: Record<string, unknown> }

interface Probe {
  toolNames: Set<string>;
  /** tools/call result per called tool, or the JSON-RPC error envelope. */
  results: Record<string, Record<string, unknown>>;
}

/** An empty `calls` list probes the registered surface only. */
async function probeServer(env: Record<string, string>, calls: ToolCall[]): Promise<Probe> {
  const { stub, tokens } = await serverFixture();
  const child = spawn(
    'node',
    ['--import', 'tsx', '--import', pathToFileURL(stub).href, 'src/index.ts'],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, SPOTIFY_CLIENT_ID: 'enggating-test', SPOTIFY_MCP_TOKEN_FILE: tokens, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const session = new ServerSession(child);
  try {
    const init = await session.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'enggating-stdio-test', version: '1.0.0' },
    });
    assert.equal(init.error, undefined, `initialize failed: ${JSON.stringify(init.error)}\nstderr:\n${session.stderr()}`);
    session.notify('notifications/initialized');

    const listed = await session.request('tools/list');
    assert.equal(listed.error, undefined, `tools/list failed: ${JSON.stringify(listed.error)}\nstderr:\n${session.stderr()}`);
    const toolNames = new Set(((listed.result?.tools ?? []) as Array<{ name: string }>).map((t) => t.name));

    const results: Record<string, Record<string, unknown>> = {};
    for (const call of calls) {
      assert.ok(toolNames.has(call.tool), `tool ${call.tool} is not registered in this configuration`);
      const called = await session.request('tools/call', { name: call.tool, arguments: call.args });
      results[call.tool] = (called.error !== undefined ? { rpcError: called.error } : called.result ?? {}) as Record<string, unknown>;
    }
    return { toolNames, results };
  } finally {
    session.stop();
  }
}

/**
 * Two canaries on two different gated families: /browse/categories and the
 * /markets lookup the issue names. After #765 both handlers branch on the
 * error being a SpotifyApiError, so both convert the gated 403 into their
 * own graceful disclosure rather than surfacing it as an error envelope --
 * the same platform condition produces the same disclosure on every host
 * configuration, which is the property the test enforces.
 */
const GATED_CALLS: ToolCall[] = [
  { tool: 'category_resolver', args: { text: 'chill electronic', response_format: 'json' } },
  { tool: 'market_validate', args: { markets: ['GB'], response_format: 'json' } },
];

test('the graceful-403 contract is installed regardless of the exhaust2enggating gate (real stdio server, #791)', async () => {
  const baseline = await probeServer({}, GATED_CALLS);

  // Leg 1: the registration key is switched off outright.
  const disabled = await probeServer({ SPOTIFY_MCP_DISABLE_TOOLS: 'exhaust2enggating' }, GATED_CALLS);
  assert.deepEqual(
    disabled.results,
    baseline.results,
    `a gated 403 changed shape with SPOTIFY_MCP_DISABLE_TOOLS=exhaust2enggating\nbaseline: ${JSON.stringify(baseline.results)}\ndisabled: ${JSON.stringify(disabled.results)}`,
  );

  // Leg 2: a hand-built toolset profile that trims the whole `catalog` set --
  // the only set carrying the exhaust2enggating key -- and opts the two
  // canary modules back in.
  const trimmed = await probeServer(
    { SPOTIFY_MCP_TOOLSETS: 'playlists', SPOTIFY_MCP_ENABLE_TOOLS: 'exhaust2catalog,catalog' },
    GATED_CALLS,
  );
  assert.ok(
    trimmed.toolNames.size < baseline.toolNames.size && !trimmed.toolNames.has('get_categories'),
    `the trimmed profile must genuinely exclude the catalog set, not merely look different: ${trimmed.toolNames.size} tools, get_categories present=${trimmed.toolNames.has('get_categories')}`,
  );
  assert.deepEqual(
    trimmed.results,
    baseline.results,
    `a gated 403 changed shape under SPOTIFY_MCP_TOOLSETS=playlists\nbaseline: ${JSON.stringify(baseline.results)}\ntrimmed: ${JSON.stringify(trimmed.results)}`,
  );

  // #765: the contract annotates the SpotifyApiError in place and rethrows it,
  // so the tool handlers convert it to their own graceful shape rather than
  // surfacing it through the error boundary. The wire-level evidence the
  // gated path was classified is the disclosure itself: category_resolver
  // emits `gated: true` for /browse/categories, and market_validate emits
  // the /markets note naming the same 403.
  assert.equal((baseline.results['category_resolver']?.structuredContent as { gated?: boolean })?.gated, true);
  assert.match(
    (baseline.results['market_validate']?.structuredContent as { note?: string })?.note ?? '',
    /\/markets returned 403/,
  );
});


test('SPOTIFY_MCP_DISABLE_TOOLS is honoured on the production path (#791 vacuity guard)', async () => {
  // The comparison above would also hold if the disable env were ignored
  // outright, so prove the same env family really does remove a registration:
  // `browse` carries get_categories, and disabling it alongside the gating
  // module changes the tool list.
  const control = await probeServer({ SPOTIFY_MCP_DISABLE_TOOLS: 'exhaust2enggating,browse' }, []);
  const ungated = await probeServer({ SPOTIFY_MCP_DISABLE_TOOLS: 'exhaust2enggating' }, []);
  assert.ok(ungated.toolNames.has('get_categories'), 'get_categories must be registered when only the gating module is disabled');
  assert.ok(!control.toolNames.has('get_categories'), 'disabling the browse key must remove get_categories from tools/list');
  assert.ok(control.toolNames.size < ungated.toolNames.size, 'the disabled-module profile must have a strictly smaller tool list');
});
