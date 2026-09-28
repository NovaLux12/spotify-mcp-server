import './helpers/hermetic.js';

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SpotifyApiError, type SpotifyClient } from '../src/client.js';
import { DEFAULT_TOKEN_FILE } from './helpers/hermetic.js';
import { GATED_PATH_PATTERNS, graceful403Message, installGatedPathContract, isGatedError, isGatedPath } from '../src/gating.js';
import { registerExhaust2EnggatingTools } from '../src/tools/exhaust2_enggating.js';
import { registerExhaust2CatalogTools } from '../src/tools/exhaust2_catalog.js';
import { registerCatalogTools } from '../src/tools/catalog.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { StdioJsonRpcChild } from './helpers/stdio-child.js';
import { structured } from './helpers/structured.js';
import { armFileDeadline, FLEET_FILE_BUDGET_MS } from './helpers/file-deadline.js';

type ToolContent = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> };
type RegisteredTool = { name: string; description: string; schema: Record<string, unknown>; handler: (a: Record<string, unknown>) => Promise<ToolContent> };
type Call = { method: string; path: string; params?: Record<string, string> };

interface FakeClient {
  // Mirrored from the real `SpotifyClient.tokenFile: string` (src/client.ts).
  // The account stores key by it (#1385), so a double without it is not a
  // client the stores can route through.
  tokenFile: string;
  get: (path: string, params?: Record<string, string>, opts?: { priority?: 'normal' | 'low' }) => Promise<unknown>;
  getAllPages: (path: string, params?: Record<string, string>) => Promise<unknown[]>;
  calls: Call[];
}

/**
 * The registrar's `client` parameter, as the value this file hands it.
 *
 * `SpotifyClient` is a CLASS with private state (the 429 queue, the TTL cache,
 * the token loader), so no structural double can satisfy it — and this double
 * is deliberately structural, because its job is to record the calls that
 * `installGatedPathContract` wraps. The cast is therefore confined to the one
 * place the two meet: the object literal is still built and checked as a
 * `FakeClient` first, so the members it claims are verified, and `calls`
 * survives into the return type so assertions read the real log.
 *
 * What the cast stops catching: changes to the ~65 members of `SpotifyClient`
 * this file never invokes. The alternative was that cast at each of the 11
 * call sites, which is 11 chances to cast the wrong thing.
 */
type RegistrarClient = SpotifyClient & Pick<FakeClient, 'calls'>;

function makeFakeClient(respond?: (path: string, params?: Record<string, string>) => unknown): RegistrarClient {
  const calls: Call[] = [];
  const self: FakeClient = {
    calls,
    // The real SpotifyClient always sets this at construction (#1385).
    tokenFile: DEFAULT_TOKEN_FILE,
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
  return self as unknown as RegistrarClient;
}

/**
 * The recording double for the registrar's `server` argument.
 *
 * Cast ONCE here rather than at each registration: the cast is a claim about
 * this file's harness (a `tool()` recorder, not an SDK server), and the
 * literal is still checked against `RegisteredTool` first.
 */
function makeServer(registered: RegisteredTool[]): McpServer {
  return {
    tool: (name: string, description: string, schema: Record<string, unknown>, handler: RegisteredTool['handler']) =>
      registered.push({ name, description, schema, handler }),
  } as unknown as McpServer;
}

function find(registered: RegisteredTool[], name: string): RegisteredTool {
  const t = registered.find((x) => x.name === name);
  assert.ok(t, `missing tool ${name}`);
  return t!;
}

function text(r: ToolContent): string {
  return r.content.map((c) => c.text).join('\n');
}

/**
 * The whole-file bound (#1569).
 *
 * This file spawns real child processes, so a child whose tree still holds an
 * inherited stdio write end can keep this process's `PipeWrap` registered and the
 * loop undrainable — the #1365 failure, which is silent and unbounded because the
 * runner is invoked with no `--test-timeout`. See `helpers/file-deadline.ts`.
 *
 * Armed at module scope, above every hook, because a bound a teardown can clear is
 * not a bound. The timer is `unref`'d, so it cannot itself delay this file.
 */
armFileDeadline({
  label: 'tests/exhaust2_enggating.test.ts',
  budgetMs: FLEET_FILE_BUDGET_MS,
  children: () => [],
});

test('isGatedPath classifies the #329 and #725 gated families', () => {
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
    // #725: the multi-id batch endpoints. After the query string is
    // stripped, the bare plural paths land in the gated class so a 403
    // annotation lets `fetchSeveral` fall back to per-item GETs.
    '/tracks',
    '/tracks?ids=a,b',
    '/albums',
    '/artists',
    '/episodes',
    '/shows',
    '/audiobooks',
    '/chapters',
  ];
  for (const p of gated) assert.ok(isGatedPath(p), `expected gated: ${p}`);

  const notGated = [
    '/me/tracks',
    '/me/albums',
    '/playlists/pl1/tracks',
    '/playlists/pl1/followers',
    '/artists/art1/albums',
    '/artists/art1',
    '/tracks/trk1',
    '/albums/alb1',
    '/browse/featured-playlists',
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
//
// #638 removed `get_categories` / `get_category_playlists` outright rather than
// re-wrapping them: a removed endpoint has no graceful shape left, and a
// 403-tolerant wrapper would only have turned the removal into a soft, wrong
// answer. `browse_category_deepdive` is the surviving caller of the same two
// paths, so the #428 contract is now asserted against it — one leg on the
// category read, one on the playlists read it follows up with.

test('browse_category_deepdive returns the graceful message instead of raw Forbidden (#428)', async () => {
  const client = makeFakeClient((path) =>
    path.startsWith('/browse/categories') ? new SpotifyApiError(403, 'Forbidden') : null,
  );
  const catalog: RegisteredTool[] = [];
  registerCatalogTools(makeServer(catalog) as never, client as never);
  installGatedPathContract(client as never);

  await assert.rejects(
    find(catalog, 'browse_category_deepdive').handler({ category_id: 'mood' }),
    (err: Error & { cause?: unknown }) => {
      // #765: the wrapper keeps the SpotifyApiError instance, so
      // isRemovedEndpointFailure still matches on the 403 status and the
      // tool throws browseCategoryUnavailable with the gated Spotify
      // message embedded in the detail line and as the error cause.
      assert.match(err.message, /browse-category lookup/);
      assert.match(err.message, /\(\/browse\/categories\/mood\)/);
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

test('browse_category_deepdive discloses a gated 403 on its playlists read too (#428)', async () => {
  // The category read succeeds; only the follow-up `/playlists` read is gated.
  // Both legs must carry the same contract, and the second must name the path
  // that actually failed rather than the one the tool started on.
  const client = makeFakeClient((path) => {
    if (path === '/browse/categories/mood') return { id: 'mood', name: 'Mood' };
    if (path === '/browse/categories/mood/playlists') return new SpotifyApiError(403, 'Forbidden');
    return null;
  });
  const catalog: RegisteredTool[] = [];
  registerCatalogTools(makeServer(catalog) as never, client as never);
  installGatedPathContract(client as never);

  await assert.rejects(
    find(catalog, 'browse_category_deepdive').handler({ category_id: 'mood' }),
    (err: Error & { cause?: unknown }) => {
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

// ------------------------------------------------- #605 documented family metadata

test('GATED_PATH_PATTERNS is derived from GATED_FAMILIES, not maintained beside it (#605)', async () => {
  // The README's gated table is generated from GATED_FAMILIES, and the runtime
  // classifier from GATED_PATH_PATTERNS. If those are two lists, the table
  // drifts from the code -- which is the bug #605 exists to close. Assert the
  // classifier IS the families, in order.
  const { GATED_FAMILIES } = await import('../src/gating.js');
  assert.deepEqual(
    GATED_PATH_PATTERNS.map((re) => re.source),
    GATED_FAMILIES.map((f) => f.pattern.source),
    'GATED_PATH_PATTERNS must be GATED_FAMILIES.map(f => f.pattern); a second list is what let the README disagree with the code',
  );
});

test('every documented family example is accepted by its own pattern (#605)', async () => {
  // A family whose README row names a path its own classifier rejects is the
  // exact drift this guards. Revert the fix and this must fail.
  const { GATED_FAMILIES } = await import('../src/gating.js');
  for (const family of GATED_FAMILIES) {
    assert.ok(
      family.pattern.test(family.example),
      `family ${family.id} documents ${family.example}, which its own pattern rejects`,
    );
  }
});

test('every family names the tools it ships, and a shipped tool names a real family (#605)', async () => {
  const { GATED_FAMILIES } = await import('../src/gating.js');
  const ids = GATED_FAMILIES.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, 'family ids must be unique — the README keys its rows on them');
  for (const family of GATED_FAMILIES) {
    assert.ok(family.label.trim().length > 0, `family ${family.id} has no label`);
    assert.ok(['replaced', 'explained'].includes(family.fallback), `family ${family.id} has an unknown fallback`);
    assert.ok(['removal', 'gated'].includes(family.reason), `family ${family.id} has an unknown reason`);
  }
  // Three families are retained with no call site after their tools migrated onto
  // replacements or were deleted. They must stay in the list — a family with no
  // caller today is still the classifier that covers a future one — but the
  // README has to say so. #638 emptied a fourth into this set by migrating
  // every `/me/{type}/contains` reader onto `/me/library/contains`, which is
  // NOT gated (it answered 200 on the same probe that 403'd these).
  const callSiteFree = GATED_FAMILIES.filter((f) => f.tools.length === 0);
  assert.deepEqual(
    callSiteFree.map((f) => f.id).sort(),
    ['browse-new-releases', 'me-type-contains', 'playlist-followers-contains'],
    'the set of families with no shipped call site changed; update the README notes that explain why they are kept',
  );
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

interface ToolCall { tool: string; args: Record<string, unknown> }

interface Probe {
  toolNames: Set<string>;
  /** tools/call result per called tool, or the JSON-RPC error envelope. */
  results: Record<string, Record<string, unknown>>;
}

/** An empty `calls` list probes the registered surface only. */
async function probeServer(env: Record<string, string>, calls: ToolCall[]): Promise<Probe> {
  const { stub, tokens } = await serverFixture();
  // `helpers/stdio-child.js`, not the `ServerSession` this used to carry
  // (#1404). That class had a pending map and a 20 s watchdog and *no*
  // `child.on('exit')`, so a child killed mid-request settled nothing: the
  // write went to a stdin nobody was reading and the test reported
  // `tools/call timed out after 20s`, naming a hang when the cause was a crash.
  // A SIGKILL leaves no stderr, so the captured stderr was the only evidence
  // and it was not part of the message.
  const session = StdioJsonRpcChild.spawn({
    label: 'exhaust2-enggating',
    command: 'node',
    args: ['--import', 'tsx', '--import', pathToFileURL(stub).href, 'src/index.ts'],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      SPOTIFY_CLIENT_ID: 'enggating-test',
      SPOTIFY_MCP_TOKEN_FILE: tokens,
      // The baseline is the FULL surface, pinned explicitly rather than left
      // to the default: every canary in this file (category_resolver,
      // market_validate, get_artist_genres) lives outside the curated `core`
      // set that has been the default since #889, and a baseline measured on a
      // trimmed surface would compare a trimmed profile against another trim
      // and prove nothing. A caller that passes its own SPOTIFY_MCP_TOOLSETS
      // still wins — the spread order is unchanged, which is what the
      // SPOTIFY_MCP_TOOLSETS=playlists leg below relies on.
      SPOTIFY_MCP_TOOLSETS: 'all',
      ...env,
    },
    // The bound this file has always used, kept so migrating the harness did
    // not quietly quadruple the worst case for a starved child.
    requestTimeoutMs: 20_000,
  });
  try {
    await session.initialize('enggating-stdio-test');

    const listed = await session.request('tools/list');
    assert.equal(listed.error, undefined, `tools/list failed: ${JSON.stringify(listed.error)}\nstderr:\n${session.stderr}`);
    const toolNames = new Set(((listed.result?.tools ?? []) as Array<{ name: string }>).map((t) => t.name));

    const results: Record<string, Record<string, unknown>> = {};
    for (const call of calls) {
      assert.ok(toolNames.has(call.tool), `tool ${call.tool} is not registered in this configuration`);
      const called = await session.request('tools/call', { name: call.tool, arguments: call.args });
      results[call.tool] = (called.error !== undefined ? { rpcError: called.error } : called.result ?? {}) as Record<string, unknown>;
    }
    return { toolNames, results };
  } finally {
    await session.dispose();
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
    // The canary must be a module this profile does NOT opt back in, or the
    // assertion passes/fails for the wrong reason. It opts `exhaust2catalog`
    // and `catalog` in explicitly, so `category_resolver` (an exhaust2catalog
    // tool) is correctly present; `browse` is not opted in, so the browse
    // canary is the honest witness that the profile really changed.
    trimmed.toolNames.size < baseline.toolNames.size && !trimmed.toolNames.has('get_artist_genres'),
    `the trimmed profile must genuinely exclude the catalog set, not merely look different: ${trimmed.toolNames.size} tools, get_artist_genres present=${trimmed.toolNames.has('get_artist_genres')}`,
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
  // `browse` carries get_artist_genres, and disabling it alongside the gating
  // module changes the tool list. (#638 retargeted this canary off
  // `get_categories`, which no longer registers; the module key is unchanged,
  // so the guard is the same one.)
  const control = await probeServer({ SPOTIFY_MCP_DISABLE_TOOLS: 'exhaust2enggating,browse' }, []);
  const ungated = await probeServer({ SPOTIFY_MCP_DISABLE_TOOLS: 'exhaust2enggating' }, []);
  assert.ok(ungated.toolNames.has('get_artist_genres'), 'get_artist_genres must be registered when only the gating module is disabled');
  assert.ok(!control.toolNames.has('get_artist_genres'), 'disabling the browse key must remove get_artist_genres from tools/list');
  assert.ok(control.toolNames.size < ungated.toolNames.size, 'the disabled-module profile must have a strictly smaller tool list');
});

// ------------------------------------------- #1359: the three live call sites
//
// #1359 filed against AGENTS.md's never-call table naming /browse/categories
// while the family still had three live call sites. The table row moved above
// it; these tests hold the RUNTIME half of that claim, which the doc row and
// the census's per-tool cross-check both rest on: each of the three must fail
// loudly, and none may report a failed read as an empty category tree.
//
// The premise was re-derived for this change, not inherited: the Feb 2026
// changelog marks /browse/categories and /browse/categories/{id} [REMOVED] but
// names no [REMOVED] entry for /{id}/playlists, and the live OpenAPI schema
// still publishes all three carrying `deprecated: true` with documented 200
// responses. So the family's runtime truth is registration-dependent, which is
// why the honest per-tool outcome is a disclosure and not a deletion. Nothing
// here asserts a live HTTP status — these are fakes, and no probe was run.

/**
 * Registers the three live callers against a client driven by `respond`, keyed
 * BY NAME. Returning a bare array was a trap actually taken while writing
 * these tests: `const [resolver] = browseCallers(...)` destructures the FIRST
 * element (`get_category`), not `category_resolver`, and the test then passed
 * against the wrong tool. A keyed lookup makes that unrepresentable.
 */
function browseCallers(respond: (path: string) => unknown): Map<string, RegisteredTool> {
  const client = makeFakeClient((path) => respond(path));
  installGatedPathContract(client);
  const registered: RegisteredTool[] = [];
  // No `as never` here: both factories now return the types the registrars
  // declare, so a change to either signature is a compile error in this file
  // rather than something the cast was swallowing.
  registerCatalogTools(makeServer(registered), client);
  registerExhaust2CatalogTools(makeServer(registered), client);
  const names = ['get_category', 'browse_category_deepdive', 'category_resolver'];
  return new Map(names.map((name) => [name, find(registered, name)]));
}

/** The one tool that reads the category LIST, for the list-shaped failures. */
function resolverOf(respond: (path: string) => unknown): RegisteredTool {
  const tool = browseCallers(respond).get('category_resolver');
  assert.ok(tool, 'category_resolver is not registered; the tests below cannot be trusted');
  return tool;
}

test('#1359 all three browse-categories callers disclose a gated 403', async () => {
  // The 403 is the state a current registration is expected to hit. Each tool
  // must SAY so. `category_resolver` returns a `gated: true` body (its
  // documented contract); the two catalog tools throw a message naming the
  // February 2026 removal. None may answer with a category list.
  const tools = browseCallers((path) =>
    path.startsWith('/browse/categories') ? new SpotifyApiError(403, 'Forbidden') : null,
  );
  // Every declared caller is exercised: if the family grows a tool, the
  // Set comparison below fails rather than silently testing three of four.
  assert.deepEqual([...tools.keys()].sort(), ['browse_category_deepdive', 'category_resolver', 'get_category']);
  for (const tool of tools.values()) {
    if (tool.name === 'category_resolver') {
      const out = await tool.handler({ text: 'chill' });
      assert.equal(out.structuredContent?.gated, true, `${tool.name} must disclose gated: true on a 403`);
      assert.equal(out.structuredContent?.endpoint, '/browse/categories');
      assert.match(text(out), /app-registration gated/);
      continue;
    }
    await assert.rejects(
      tool.handler({ category_id: 'mood' }),
      (err: Error) => {
        assert.match(err.message, /browse-category lookup/, `${tool.name} must name the failed lookup`);
        assert.match(err.message, /Spotify answered 403/);
        assert.match(err.message, /February 2026/, `${tool.name} must name the removal`);
        return true;
      },
      `${tool.name} must throw on a gated 403 rather than return a category`,
    );
  }
});

test('#1359 category_resolver names the removal on 404 and 410 (#803 class)', async () => {
  // Before the fix these two statuses rethrew a bare "Forbidden" with nothing
  // saying the endpoint is gone — the caller could not tell a removed endpoint
  // from a bad query. A removed endpoint answering is exactly the case the
  // never-call discussion is about, and it must not surface as raw status.
  for (const status of [404, 410]) {
    const resolver = resolverOf((path) =>
      path.startsWith('/browse/categories') ? new SpotifyApiError(status as 404, 'Forbidden') : null,
    );
    await assert.rejects(
      resolver.handler({ text: 'chill' }),
      (err: Error & { cause?: unknown }) => {
        assert.match(err.message, new RegExp(`Spotify answered ${status}`), `status ${status} must be reported`);
        assert.match(err.message, /browse-category lookup/);
        assert.match(err.message, /not a missing category/);
        assert.match(err.message, /February 2026/);
        assert.match(err.message, /No endpoint serves the browse category tree/);
        assert.ok(err.cause instanceof SpotifyApiError, `status ${status} must keep the Spotify error as the cause`);
        return true;
      },
      `a ${status} on /browse/categories must name the removal, not rethrow raw`,
    );
  }
});

test('#1359 category_resolver never reports an unreadable page as an empty catalog', async () => {
  // The #803 failure mode: a read that did not happen, coerced into a
  // confident claim about the market. A 204 (client.get resolves null) and a
  // 200 carrying no `categories.items` both used to become "No browse
  // categories returned (empty catalog for this market)" — telling the caller
  // their market has no categories when the truth is that nothing was read.
  const shapes: Array<[string, unknown]> = [
    ['204 / no body', null],
    ['200 without a categories key', {}],
    ['200 with a non-array items', { categories: { items: 'not-an-array' } }],
  ];
  for (const [label, body] of shapes) {
    const resolver = resolverOf(() => body);
    await assert.rejects(
      resolver.handler({ text: 'chill' }),
      (err: Error) => {
        assert.match(
          err.message,
          /could not be answered/,
          `${label}: must report the read as unanswered, not as an empty catalog`,
        );
        assert.match(err.message, /nothing was read/, `${label}: must say nothing was read`);
        assert.ok(
          !/empty catalog for this market/.test(err.message),
          `${label}: must not claim the market's catalog is empty when nothing was read`,
        );
        // The message must not turn the observation into a verdict. The runtime
        // status of this path is genuinely unestablished (changelog [REMOVED],
        // schema deprecated), so claiming the endpoint IS removed here would
        // assert a cause the response does not show.
        assert.ok(
          !/was removed by Spotify/.test(err.message),
          `${label}: must not assert the removal as the cause; only the status was observed`,
        );
        return true;
      },
      `${label} must fail loudly rather than report a soft empty answer`,
    );
  }
});

test('#1359 a genuine empty page still reports an empty catalog', async () => {
  // The guard above must not swallow the one case the old message was right
  // about: a well-formed 200 whose categories.items really is empty. Proved by
  // running it, so a fix that simply rejected every empty result would fail.
  const resolver = resolverOf(() => ({ categories: { items: [], total: 0 } }));
  await assert.rejects(
    resolver.handler({ text: 'chill' }),
    /No browse categories returned \(empty catalog for this market\)/,
    'a well-formed empty page must keep its own distinct message',
  );
});

test('#1359 a healthy page still resolves the best match', async () => {
  // The vacuity guard for the whole file: if the fix made the happy path
  // unreachable, the four tests above would pass while the tool was broken.
  const resolver = resolverOf((path) =>
    path.startsWith('/browse/categories')
      ? { categories: { items: [{ id: 'chill', name: 'Chill' }, { id: 'mood', name: 'Mood' }], total: 2 } }
      : null,
  );
  const out = await resolver.handler({ text: 'chill' });
  // `best_match` is `{ id, name, score } | null` on the wire
  // (exhaust2_catalog.ts), and `structuredContent` is an untyped record, so
  // both levels are narrowed here rather than read through `?.` — the point of
  // this test is that a match IS found, and `undefined?.id` would have passed
  // just as happily as the id it is checking.
  const best = structured<{ best_match: { id: string; name: string; score: number } | null }>(out).best_match;
  assert.ok(best, 'an exact category id must resolve to a best match');
  assert.equal(best.id, 'chill');
  assert.match(text(out), /Best match for "chill"/);
});
