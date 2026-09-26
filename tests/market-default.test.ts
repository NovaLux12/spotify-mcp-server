import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerCatalogTools, resetProfileCountryCache } from '../src/tools/catalog.js';
import { registerAudiobookTools } from '../src/tools/audiobooks.js';
import { registerPlaybackTools } from '../src/tools/playback.js';
import { initConfig } from '../src/config.js';
import type { z } from 'zod';

// #595: the default market is resolved from configuration, because the
// account fallback the chain used to end at — GET /me.country — was removed
// by Spotify's February 2026 changes. These tests pin the whole chain:
// what reaches the wire, and what the result says when nothing did.

type ToolContent = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};
type RegisteredTool = {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, unknown>) => Promise<ToolContent>;
};
type Call = { path: string; params?: Record<string, string> };

const ALBUM = {
  id: 'alb1',
  name: 'A Night at the Opera',
  uri: 'spotify:album:alb1',
  release_date: '1975-10-31',
  total_tracks: 1,
  artists: [{ name: 'Queen' }],
  tracks: { items: [] },
};

const AUDIOBOOK = {
  id: 'bk1',
  name: 'A Book',
  uri: 'spotify:audiobook:bk1',
  authors: [],
  narrators: [],
  languages: ['en'],
  explicit: false,
  total_chapters: 0,
};

/**
 * A current registration: the `/me` payload carries no `country`, which is
 * the whole point — the account can no longer supply a default market.
 */
function makeHarness(register: (server: never, client: never) => void, meCountry?: string) {
  const calls: Call[] = [];
  const record = (path: string, params?: Record<string, string>) => {
    calls.push(params === undefined ? { path } : { path, params });
  };
  const client = {
    get: async (path: string, params?: Record<string, string>) => {
      record(path, params);
      if (path === '/me') return { id: 'usr1', ...(meCountry ? { country: meCountry } : {}) };
      if (path === '/albums/alb1') return ALBUM;
      if (path === '/audiobooks/bk1') return AUDIOBOOK;
      if (path === '/me/player') return { device: { id: 'dev1' }, item: null };
      return null;
    },
    post: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
    getAllPages: async () => [],
  };
  const registered: RegisteredTool[] = [];
  const server = {
    tool: (
      name: string,
      description: string,
      schema: Record<string, z.ZodTypeAny>,
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

function callsTo(calls: Call[], path: string): Call[] {
  return calls.filter((c) => c.path === path);
}

/** Run `value` through a tool's own market schema, the way the SDK does. */
function parseMarket(schema: z.ZodTypeAny, value: unknown): unknown {
  const parsed = schema.safeParse(value);
  assert.equal(parsed.success, true, `market ${String(value)} was rejected: ${JSON.stringify(parsed)}`);
  return (parsed as { data: unknown }).data;
}

function useConfiguredMarket(code: string): void {
  process.env.SPOTIFY_MCP_MARKET = code;
  initConfig(process.env);
}

beforeEach(() => {
  resetProfileCountryCache();
});
afterEach(() => {
  // getConfig() memoises process-wide, so one test's env must not leak a
  // default market into the next.
  delete process.env.SPOTIFY_MCP_MARKET;
  initConfig(process.env);
  resetProfileCountryCache();
});

test('a configured SPOTIFY_MCP_MARKET reaches the wire even when /me carries no country', async () => {
  useConfiguredMarket('GB');
  const { registered, calls } = makeHarness(registerCatalogTools);

  await findTool(registered, 'get_album').handler({ id: 'alb1' });

  // Asserted on the request itself, not on a value recomputed from the
  // handler: this parameter is what Spotify actually received.
  assert.deepEqual(callsTo(calls, '/albums/alb1')[0].params, { market: 'GB' });
  // A configured default also removes the need to ask the account at all.
  assert.deepEqual(callsTo(calls, '/me'), []);
});

test('the result says which source supplied the market', async () => {
  useConfiguredMarket('GB');
  const { registered } = makeHarness(registerCatalogTools);

  const out = await findTool(registered, 'get_album').handler({ id: 'alb1' });

  assert.equal(out.structuredContent?.market_source, 'config');
  assert.equal(out.structuredContent?.market, 'GB');
});

test('an explicit market argument outranks the configured default', async () => {
  useConfiguredMarket('GB');
  const { registered, calls } = makeHarness(registerCatalogTools);
  const album = findTool(registered, 'get_album');

  const out = await album.handler({ id: 'alb1', market: parseMarket(album.schema.market, 'de') });

  assert.deepEqual(callsTo(calls, '/albums/alb1')[0].params, { market: 'DE' });
  assert.equal(out.structuredContent?.market_source, 'argument');
});

test('with no configured market and no /me country the lookup is unscoped and says so', async () => {
  const { registered, calls } = makeHarness(registerCatalogTools);

  const out = await findTool(registered, 'get_album').handler({ id: 'alb1' });

  // The parameter is genuinely absent, not defaulted to a placeholder.
  assert.equal('market' in (callsTo(calls, '/albums/alb1')[0].params ?? {}), false);
  // ...and the result states that, so an empty catalogue cannot be misread
  // as "nothing is available in this region".
  assert.equal(out.structuredContent?.market_source, 'none');
  assert.equal(out.structuredContent?.market, null);
});

test('a /me payload that still carries a country is used as the last resort', async () => {
  const { registered, calls } = makeHarness(registerCatalogTools, 'AU');

  const out = await findTool(registered, 'get_album').handler({ id: 'alb1' });

  assert.deepEqual(callsTo(calls, '/albums/alb1')[0].params, { market: 'AU' });
  assert.equal(out.structuredContent?.market_source, 'account');
});

test('the dead /me lookup is memoised, so a missing country costs one call per process', async () => {
  const { registered, calls } = makeHarness(registerCatalogTools);
  const album = findTool(registered, 'get_album');

  await album.handler({ id: 'alb1' });
  await album.handler({ id: 'alb1' });

  assert.equal(callsTo(calls, '/me').length, 1);
  assert.equal(callsTo(calls, '/albums/alb1').length, 2);
});

test('an unassigned market code is rejected locally, with no /markets round-trip', () => {
  const { registered, calls } = makeHarness(registerCatalogTools);
  const market = findTool(registered, 'get_album').schema.market;

  // XX is two letters but is not an assigned ISO 3166-1 alpha-2 code. The
  // pre-fix regex accepted it, so the failure only surfaced as a bad request
  // after a round-trip to an endpoint that now always 403s.
  assert.equal(market.safeParse('XX').success, false);
  assert.equal(market.safeParse('USA').success, false);
  // A genuinely assigned code in the wrong case still normalises.
  assert.equal(parseMarket(market, 'jp'), 'JP');
  assert.deepEqual(callsTo(calls, '/markets'), []);
});

test('the audiobook family resolves from the same chain', async () => {
  useConfiguredMarket('CA');
  const { registered, calls } = makeHarness(registerAudiobookTools);

  const out = await findTool(registered, 'get_audiobook').handler({ id: 'bk1' });

  assert.deepEqual(callsTo(calls, '/audiobooks/bk1')[0].params, { market: 'CA' });
  assert.equal(out.structuredContent?.market_source, 'config');
  assert.deepEqual(callsTo(calls, '/me'), []);
});

test('playback reads apply the configured market instead of promising an account default', async () => {
  useConfiguredMarket('IE');
  const { registered, calls } = makeHarness(registerPlaybackTools);

  await findTool(registered, 'get_now_playing').handler({});

  assert.equal(callsTo(calls, '/me/player')[0].params?.market, 'IE');
});

test('no tool description promises an account-country default', () => {
  const { registered } = makeHarness((server, client) => {
    registerCatalogTools(server, client);
    registerAudiobookTools(server, client);
    registerPlaybackTools(server, client);
  });

  // Checked against the published surface — the tool and parameter
  // descriptions an agent actually reads — not against the source text. The
  // claim under test is a promised *default*; a tool that merely offers to
  // read the account market is a different claim.
  const promisedDefault = /defaults?\s+to\s+(?:the\s+|your\s+)?account\s+(?:country|market)/i;
  const promises: string[] = [];
  for (const tool of registered) {
    if (promisedDefault.test(tool.description)) promises.push(tool.name);
    for (const [field, schema] of Object.entries(tool.schema)) {
      const described = schema.description;
      if (typeof described === 'string' && promisedDefault.test(described)) {
        promises.push(`${tool.name}.${field}`);
      }
    }
  }

  assert.deepEqual(promises, []);
});
