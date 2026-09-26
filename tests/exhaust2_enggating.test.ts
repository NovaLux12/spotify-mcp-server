import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { SpotifyApiError } from '../src/client.js';
import { GATED_PATH_PATTERNS, graceful403Message, installGatedPathContract, isGatedPath, spotifyMessageOf } from '../src/gating.js';
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

test('403 on a gated path short-circuits into the graceful contract (#428)', async () => {
  const client = makeFakeClient((path) =>
    path.startsWith('/browse/categories') ? new SpotifyApiError(403, 'Forbidden') : null,
  );
  installGatedPathContract(client);

  await assert.rejects(
    client.get('/browse/categories', { limit: '20' }),
    (err: Error) => {
      assert.match(err.message, /Spotify returned 403 for \/browse\/categories/);
      assert.match(err.message, /app-registration-gated/);
      assert.match(err.message, /not an OAuth scope problem/);
      assert.match(err.message, /spotify-mcp auth/);
      assert.match(err.message, /will not help/);
      assert.match(err.message, /grandfathered/);
      assert.match(err.message, /Registration-gated endpoints/);
      return true;
    },
  );
});

test('a gated 403 is annotated in place, not replaced by a plain Error (#429/#765)', async () => {
  // The wire error the client produced, captured so the test can prove the
  // SAME instance comes back out rather than a copy or a wrapper.
  const wire = new SpotifyApiError(403, 'Forbidden by app settings', 7, 'PREMIUM_REQUIRED');
  const client = makeFakeClient(() => wire);
  installGatedPathContract(client);

  await assert.rejects(client.get('/markets'), (err: unknown) => {
    assert.equal(err, wire, 'the contract must rethrow the error it was handed, not a substitute');
    assert.ok(err instanceof SpotifyApiError, 'a tool branching on the 403 must still recognise it');
    assert.equal(err.status, 403);
    // The fields a rate-limit or quota handler reads survive the hop.
    assert.equal(err.retryAfterSec, 7);
    assert.equal(err.reason, 'PREMIUM_REQUIRED');
    return true;
  });
  // `message` carries the contract so a caller with no handler of its own
  // still gets the explanation; Spotify's own text is kept alongside it.
  assert.match(wire.message, /app-registration-gated/);
  assert.match(wire.message, /Forbidden by app settings/);
  assert.equal(spotifyMessageOf(wire), 'Forbidden by app settings');
});

test('a retried read does not nest the contract inside itself (#765)', async () => {
  // A retry hands the SAME error instance back through the wrapper. The
  // contract text must be rebuilt from the wire message, never from the
  // previous contract text, or the second attempt explains the first.
  const wire = new SpotifyApiError(403, 'Forbidden by app settings');
  const client = makeFakeClient(() => wire);
  installGatedPathContract(client);

  await assert.rejects(client.get('/markets'), () => true);
  const first = wire.message;
  await assert.rejects(client.get('/markets'), () => true);
  assert.equal(wire.message, first, 'a second classification must be byte-identical to the first');
  assert.equal(spotifyMessageOf(wire), 'Forbidden by app settings');
  assert.doesNotMatch(wire.message, /-- Spotify returned 403/);
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
  installGatedPathContract(client);
  installGatedPathContract(client);
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

test('registerExhaust2EnggatingTools registers no tools and installs nothing (#791)', () => {
  const client = makeFakeClient();
  const registered: RegisteredTool[] = [];
  registerExhaust2EnggatingTools(makeServer(registered) as never, client as never);
  assert.equal(registered.length, 0);
  // The gating contract must not be reachable through the module's toolset
  // key: the marker stays unset, so the wrapper never lands on the client.
  assert.equal((client as unknown as Record<string, unknown>).__graceful403Installed__, undefined);
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
  installGatedPathContract(client as never);

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

// -------------------------- #765 contract + tool-level degradation composed

/**
 * The two halves of the graceful-403 story used to be tested in isolation:
 * `src/gating.ts` proved the wrapper rewrites a gated 403, and the tool
 * modules proved their handlers degrade a `SpotifyApiError` 403. Nothing
 * drove both at once -- which is why replacing the error with a plain `Error`
 * (#765) shipped green: every tool with a designed 403 degradation on a
 * gated path hard-failed in the real composition.
 */

const COLLAB_ALBUM = {
  id: 'alb1', name: 'Collab LP', uri: 'spotify:album:alb1', album_type: 'album',
  release_date: '2022', total_tracks: 1, images: [],
  artists: [
    { id: 'a1', name: 'Artist', uri: 'spotify:artist:a1' },
    { id: 'g1', name: 'Guest', uri: 'spotify:artist:g1' },
  ],
};

/**
 * One wired client: the contract is installed exactly as the production path
 * installs it, and `gated` names the paths that answer 403 the way Spotify
 * answers them on a registration that was never granted the gated surface.
 */
function composedClient(gated: readonly string[]): FakeClient {
  const client = makeFakeClient((path) => {
    if (gated.some((g) => path === g)) return new SpotifyApiError(403, 'Forbidden');
    if (path === '/me') return { id: 'me1', country: 'GB', product: 'premium' };
    if (path.startsWith('/artists/') && path.endsWith('/albums')) return { items: [COLLAB_ALBUM] };
    if (path.startsWith('/artists/')) return { id: 'a1', name: 'Artist', uri: 'spotify:artist:a1', genres: [] };
    return null;
  });
  installGatedPathContract(client as never);
  return client;
}

test('category_resolver still returns its gated disclosure with the contract installed (#765)', async () => {
  const registered: RegisteredTool[] = [];
  registerExhaust2CatalogTools(makeServer(registered) as never, composedClient(['/browse/categories']) as never);

  // concise keeps `structuredContent` AND the prose the caller actually reads.
  const res = await find(registered, 'category_resolver').handler({ text: 'chill electronic', response_format: 'concise' });
  const structured = res.structuredContent as { gated?: unknown; endpoint?: unknown };
  assert.equal(structured.gated, true);
  assert.equal(structured.endpoint, '/browse/categories');
  assert.match(text(res), /app-registration gated/);
});

test('artist_collab_network still falls back to albums with the contract installed (#765)', async () => {
  const registered: RegisteredTool[] = [];
  registerExhaust2CatalogTools(makeServer(registered) as never, composedClient(['/artists/a1/top-tracks']) as never);

  const res = await find(registered, 'artist_collab_network').handler({ artist_id: 'a1', response_format: 'concise' });
  const structured = res.structuredContent as {
    top_tracks_available?: unknown;
    collaborators?: Array<{ name: string }>;
  };
  assert.equal(structured.top_tracks_available, false);
  assert.equal(structured.collaborators?.[0]?.name, 'Guest');
  assert.match(text(res), /top-tracks GATED/);
});

test('market_validate still returns its note + account market with the contract installed (#765)', async () => {
  const registered: RegisteredTool[] = [];
  registerCatalogTools(makeServer(registered) as never, composedClient(['/markets']) as never);

  const res = await find(registered, 'market_validate').handler({
    markets: ['GB'], include_account_market: true, response_format: 'json',
  });
  const structured = res.structuredContent as { note?: unknown; account_market?: unknown; verdict?: unknown };
  assert.match(String(structured.note), /\/markets returned 403/);
  assert.equal(structured.account_market, 'GB');
  assert.match(String(structured.verdict), /unknown/);
});

test('a 403 on a non-gated path still reaches the caller as the original SpotifyApiError (#765)', async () => {
  const registered: RegisteredTool[] = [];
  // /artists/{id} is outside GATED_PATH_PATTERNS: the contract must leave it
  // alone, and the tool must not mistake it for a designed degradation.
  registerExhaust2CatalogTools(makeServer(registered) as never, composedClient(['/artists/a1']) as never);

  await assert.rejects(
    find(registered, 'artist_collab_network').handler({ artist_id: 'a1', response_format: 'concise' }),
    (err: unknown) => {
      assert.ok(err instanceof SpotifyApiError, `expected a SpotifyApiError, got ${String(err)}`);
      assert.equal((err as SpotifyApiError).status, 403);
      assert.equal((err as SpotifyApiError).message, 'Forbidden');
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
 * /markets lookup the issue names. Both handlers branch on the error being a
 * SpotifyApiError and both are therefore observably gate-dependent: with the
 * contract installed they degrade into a disclosure, without it they fail --
 * so whatever the contract decides, it must decide it in every configuration.
 */
const GATED_CALLS: ToolCall[] = [
  { tool: 'category_resolver', args: { text: 'chill electronic' } },
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

  // The 403 really was mapped: the contract hands each canary back a
  // SpotifyApiError 403, and each handler turns that into its OWN designed
  // degradation rather than a failure. Until #765 the contract replaced the
  // error type, so both canaries could only ever produce the error envelope
  // this loop used to assert -- the graceful path was unreachable in the
  // real composition, which is exactly the defect.
  const categoryPayload = baseline.results.category_resolver?.structuredContent as { gated?: unknown; endpoint?: unknown } | undefined;
  assert.deepEqual(categoryPayload, { gated: true, endpoint: '/browse/categories' });
  const marketPayload = baseline.results.market_validate?.structuredContent as { note?: unknown; verdict?: unknown } | undefined;
  assert.match(String(marketPayload?.note), /\/markets returned 403/);
  assert.match(String(marketPayload?.verdict), /unknown/);
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
