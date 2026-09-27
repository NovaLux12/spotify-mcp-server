/**
 * #685 — one resource template per entity, and no shadowing twins.
 *
 * ## The defect this covers
 *
 * The resource surface registered every entity twice: a bare pattern and a
 * `{+qs}` catch-all beside it (and, for the fixed `spotify://` resources, a
 * third `{+qs}` beside the `{?…}` form-style twin). The two entries for one
 * entity could both match the same concrete URI, and the MCP SDK resolves
 * `resources/read` by running every registered template's `match()` in
 * **insertion order** — so the first one silently won and the second became an
 * entry in `resources/templates/list` that no read could ever reach. 47
 * advertised templates described 28 readable shapes, and the server carried no
 * test that could see the duplication: `resources-prompts.test.ts` registered
 * only `registerResources`, `resources.templates.test.ts` only
 * `registerTemplateResources`.
 *
 * ## What is asserted here
 *
 *  1. No catch-all twin survives (no `{+…}` expression, no `-qs` name).
 *  2. **No two registered templates claim the same concrete URI.** This is the
 *     shadowing invariant itself, checked over every URI the registry can
 *     expand to rather than over a hand-written list.
 *  3. Every advertised template is actually readable — a read either succeeds
 *     or fails with an upstream error, never with a routing error.
 *  4. The prose and `?format=json` forms of one URI come from ONE renderer.
 *  5. Registration order does not change routing, in both directions.
 *
 * Every group reads the templates off a live `McpServer` registry rather than
 * rebuilding them, so a reverted `src/` change is what turns these red.
 */
import './helpers/hermetic.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { registerReadSurfaces } from '../src/resources/register.js';
import { registerResources } from '../src/resources/index.js';
import { registerTemplateResources } from '../src/resources/templates.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

import type { SpotifyClient } from '../src/client.js';

// ---------------------------------------------------------------- fixtures

type Call = { method: string; path: string; params?: Record<string, string> };

/**
 * Plausible values for every variable the templates declare, so a template can
 * be expanded into a concrete URI a host would actually build.
 */
const SAMPLE_VALUES: Record<string, string> = {
  id: 'pl1',
  format: 'json',
  limit: '5',
  offset: '10',
  time_range: 'short_term',
  after: '1700000000000',
  before: '1800000000000',
  market: 'GB',
};

const EMPTY_PAGE = { items: [], total: 0, limit: 20, offset: 0, next: null };

const TRACK = {
  id: 'trk1',
  name: 'Bohemian Rhapsody',
  uri: 'spotify:track:trk1',
  type: 'track',
  duration_ms: 355000,
  artists: [{ id: 'art1', name: 'Queen', uri: 'spotify:artist:art1' }],
  album: { id: 'alb1', name: 'A Night at the Opera', uri: 'spotify:album:alb1' },
};

const SHOW = { id: 'sh1', name: 'The Daily', uri: 'spotify:show:sh1', total_episodes: 1, description: 'd' };
const AUDIOBOOK = { id: 'bk1', name: 'A Book', uri: 'spotify:audiobook:bk1' };

function payloadFor(path: string): unknown {
  if (path === '/me') return { id: 'user1', display_name: 'Jack', uri: 'spotify:user:user1' };
  if (path === '/me/player') return { is_playing: true, progress_ms: 0, shuffle_state: false, repeat_state: 'off', device: null, item: TRACK };
  if (path === '/me/player/queue') return { currently_playing: TRACK, queue: [TRACK] };
  if (path === '/me/player/devices') return { devices: [{ id: 'd1', name: 'Speaker', type: 'Speaker', is_active: true, volume_percent: 50 }] };
  if (path === '/me/following') return { artists: { items: [{ id: 'art1', name: 'Queen', uri: 'spotify:artist:art1', genres: ['rock'] }], total: 1, cursors: { after: null } } };
  if (path === '/me/tracks') return { ...EMPTY_PAGE, total: 1, items: [{ added_at: '2026-01-01T00:00:00Z', track: TRACK }] };
  if (path === '/me/albums') return { ...EMPTY_PAGE, items: [{ added_at: '2026-01-01T00:00:00Z', album: { id: 'alb1', name: 'A Night at the Opera', uri: 'spotify:album:alb1', release_date: '1975-11-21', total_tracks: 1, artists: [{ name: 'Queen' }] } }] };
  if (path === '/me/shows') return { ...EMPTY_PAGE, items: [{ added_at: '2026-01-01T00:00:00Z', show: SHOW }] };
  if (path === '/me/episodes') return { ...EMPTY_PAGE, items: [{ added_at: '2026-01-01T00:00:00Z', episode: { id: 'ep1', name: 'E', uri: 'spotify:episode:ep1', duration_ms: 1000, release_date: '2026-01-01T00:00:00Z', show: SHOW } }] };
  if (path === '/me/audiobooks') return { ...EMPTY_PAGE, items: [{ added_at: '2026-01-01T00:00:00Z', audiobook: AUDIOBOOK }] };
  if (path === '/me/top/tracks' || path === '/me/top/artists' || path === '/me/playlists') {
    return { ...EMPTY_PAGE, items: [TRACK] };
  }
  if (path === '/me/player/recently-played') return { ...EMPTY_PAGE, items: [{ played_at: '2026-01-01T00:00:00Z', track: TRACK }] };
  if (/^\/playlists\/[^/]+\/items$/.test(path)) return { ...EMPTY_PAGE, total: 1, items: [{ item: TRACK }] };
  if (/^\/playlists\/[^/]+$/.test(path)) return { id: 'pl1', name: 'P', uri: 'spotify:playlist:pl1', owner: { id: 'o' }, items: { total: 1 } };
  if (/\/albums$/.test(path)) return { ...EMPTY_PAGE, items: [{ id: 'alb1', name: 'A', uri: 'spotify:album:alb1', album_type: 'album', release_date: '1975-11-21', total_tracks: 1, artists: [{ name: 'Queen' }] }] };
  if (/^\/artists\/[^/]+$/.test(path)) return { id: 'art1', name: 'Queen', uri: 'spotify:artist:art1', genres: [] };
  if (/^\/albums\/[^/]+$/.test(path)) return { id: 'alb1', name: 'A Night at the Opera', uri: 'spotify:album:alb1', album_type: 'album', release_date: '1975-11-21', total_tracks: 1, artists: [{ name: 'Queen' }], tracks: { total: 1, items: [{ id: 'trk1', name: 'Bohemian Rhapsody', uri: 'spotify:track:trk1', duration_ms: 355000, track_number: 1, artists: [{ name: 'Queen' }] }] } };
  if (/^\/shows\/[^/]+$/.test(path)) return SHOW;
  if (/^\/episodes\/[^/]+$/.test(path)) return { id: 'ep1', name: 'E', uri: 'spotify:episode:ep1', duration_ms: 1000, release_date: '2026-01-01T00:00:00Z', description: 'd', show: SHOW };
  if (/^\/tracks\/[^/]+$/.test(path)) return TRACK;
  if (/^\/audiobooks\/[^/]+\/chapters$/.test(path)) return EMPTY_PAGE;
  if (/^\/audiobooks\/[^/]+$/.test(path)) {
    return {
      ...AUDIOBOOK,
      authors: [{ name: 'A. Author', uri: 'spotify:artist:art1' }],
      narrators: [{ name: 'N. Narrator', uri: 'spotify:artist:art1' }],
      languages: ['en'],
      explicit: false,
      total_chapters: 0,
      description: 'A description.',
      chapters: { items: [], total: 0 },
    };
  }
  if (/^\/chapters\/[^/]+$/.test(path)) return { id: 'ch1', name: 'C', uri: 'spotify:chapter:ch1', audiobook: AUDIOBOOK, duration_ms: 60000, resume_point: { fully_played: false, resume_position_ms: 0 } };
  return EMPTY_PAGE;
}

function makeClientStub(): { client: SpotifyClient; calls: Call[] } {
  const calls: Call[] = [];
  const stub = {
    get: async (path: string, params?: Record<string, string>) => {
      calls.push(params === undefined ? { method: 'GET', path } : { method: 'GET', path, params });
      return payloadFor(path);
    },
    getAllPages: async () => [],
    getAllPagesWithTruncation: async () => ({
      items: [],
      truncated: false,
      truncatedByCap: false,
      reportedTotal: 0,
    }),
    getRateLimitStatus: () => ({
      lastThrottleAt: null as number | null,
      retryAfterSec: null as number | null,
      cooldownRemainingMs: 0,
    }),
  };
  return { client: stub as unknown as SpotifyClient, calls };
}

interface RegisteredTemplate {
  name: string;
  uriTemplate: string;
  match: (uri: string) => unknown;
}

/**
 * The `ResourceTemplate` objects the SDK routes with, read off a live server
 * the way a host sees them.
 */
function liveTemplates(server: McpServer): RegisteredTemplate[] {
  const registry = (server as unknown as {
    _registeredResourceTemplates: Record<
      string,
      { resourceTemplate: { uriTemplate: { toString(): string; match(uri: string): unknown } } }
    >;
  })._registeredResourceTemplates;
  return Object.entries(registry).map(([name, entry]) => ({
    name,
    uriTemplate: entry.resourceTemplate.uriTemplate.toString(),
    match: (uri: string) => entry.resourceTemplate.uriTemplate.match(uri),
  }));
}

function newServer(): McpServer {
  return new McpServer({ name: 'test', version: '0.0.0' });
}

/**
 * The first content item's text. A `resources/read` result is a union of a text
 * item and a blob item, so this narrows on the discriminant rather than casting
 * — a cast here would be the same "stop checking" the repo's own guidance
 * warns about, and it would let a blob read through as an empty string.
 */
function textOf(result: { contents: ReadResourceResult['contents'] }): string {
  const first = result.contents[0];
  return first !== undefined && 'text' in first ? first.text : '';
}

async function connect(server: McpServer): Promise<Client> {
  const client = new Client({ name: 'tester', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** One `McpServer` carrying the production read surface, plus a stub client. */
async function productionServer(): Promise<{ server: McpServer; client: Client; calls: Call[]; stub: SpotifyClient }> {
  const { client: stub, calls } = makeClientStub();
  const server = newServer();
  registerReadSurfaces(server, stub);
  return { server, client: await connect(server), calls, stub };
}

/**
 * The readable form of an advertised pattern: its head with every expression
 * resolved and its query tail dropped. `spotify://playlist/{id}/tracks{?format,
 * offset,limit}` and a `…{+qs}` catch-all beside it name the same read, so both
 * reduce to `spotify://playlist/pl1/tracks` — which is exactly the URI two
 * registrations of one entity would both claim.
 */
function concreteUri(uriTemplate: string): string {
  const head = uriTemplate.replace(/(?:\{[?+][^}]*\})+$/, '');
  return head.replace(/\{([^}]+)\}/g, (_whole, name: string) => SAMPLE_VALUES[name] ?? 'sample');
}

/** Every concrete URI a registered template can name, with a sample id. */
function expansions(templates: readonly RegisteredTemplate[]): { uri: string; from: string }[] {
  return templates.map(({ uriTemplate }) => ({ uri: concreteUri(uriTemplate), from: uriTemplate }));
}

// ------------------------------------------------- 1. no catch-all twin

test('no registered template is a {+qs} catch-all, and no template name is a -qs twin (#685)', () => {
  const templates = liveTemplates(newServerWithBoth());
  assert.ok(templates.length > 0);

  const catchAlls = templates.filter((t) => /\{\+/.test(t.uriTemplate));
  assert.deepEqual(catchAlls.map((t) => `${t.name} ${t.uriTemplate}`), []);

  const twins = templates.filter((t) => /-qs$/.test(t.name));
  assert.deepEqual(twins.map((t) => t.name), []);
});

test('every entity has exactly one template, and no pattern appears twice (#685)', () => {
  const templates = liveTemplates(newServerWithBoth());
  const patterns = templates.map((t) => t.uriTemplate);

  // Same shape advertised under two names is the twin defect restated.
  const seen = new Map<string, string[]>();
  for (const { name, uriTemplate } of templates) {
    seen.set(uriTemplate, [...(seen.get(uriTemplate) ?? []), name]);
  }
  const duplicated = [...seen.entries()].filter(([, names]) => names.length > 1);
  assert.deepEqual(duplicated, [], 'a pattern advertised under more than one name');

  // One template per readable shape, so the advertised count is the count of
  // shapes rather than a multiple of it: 10 entity shapes from
  // `src/resources/templates.ts`, plus one query-absorbing template for each of
  // the 17 fixed resources and one for `spotify://playlist/{id}/tracks`.
  assert.equal(patterns.length, 28, 'template count changed — re-measure and re-justify');
});

function newServerWithBoth(): McpServer {
  const server = newServer();
  const { client } = makeClientStub();
  registerReadSurfaces(server, client);
  return server;
}

// ------------------------------------------- 2. the shadowing invariant

test('no two registered templates claim the same concrete URI (#685)', () => {
  const templates = liveTemplates(newServerWithBoth());
  const corpus = expansions(templates);

  const shadowed: string[] = [];
  for (const { uri } of corpus) {
    const owners = templates.filter((t) => t.match(uri) !== null);
    if (owners.length > 1) {
      shadowed.push(`${uri} claimed by ${owners.map((o) => `${o.name} (${o.uriTemplate})`).join(' AND ')}`);
    }
  }
  assert.deepEqual(shadowed, [], 'two templates can route the same URI; the first silently wins');

  // The corpus is not vacuous: every entry is claimed by exactly one template,
  // so the assertion above is measuring a real registry rather than a set of
  // URIs that match nothing.
  for (const { uri } of corpus) {
    assert.equal(
      templates.filter((t) => t.match(uri) !== null).length,
      1,
      `${uri} must be claimed by exactly one template`,
    );
  }
});

test('a fixed resource URI is not shadowed by a template of the same shape (#685)', () => {
  const server = newServer();
  const { client } = makeClientStub();
  registerReadSurfaces(server, client);
  const templates = liveTemplates(server);
  const fixed = Object.keys(
    (server as unknown as { _registeredResources: Record<string, unknown> })._registeredResources,
  );

  // The SDK resolves exact URIs before any template, so a fixed resource wins
  // its own bare URI outright. What must not happen is a template claiming a
  // fixed URI's *query* form as something other than that same resource — the
  // one template that may match is the one registered for that URI.
  for (const uri of fixed) {
    const withQuery = `${uri}?format=json`;
    const owners = templates.filter((t) => t.match(withQuery) !== null);
    assert.equal(owners.length, 1, `${withQuery} must be claimed by exactly one template`);
    assert.ok(
      owners[0].uriTemplate.startsWith(uri),
      `${withQuery} was claimed by ${owners[0].uriTemplate}, which is not that resource`,
    );
  }
});

// --------------------------------------- 3. every advertised template reads

test('every advertised template reads, and never with a routing error (#685)', async () => {
  const { client, server } = await productionServer();
  const corpus = expansions(liveTemplates(server));
  assert.ok(corpus.length > 0, 'expected templates to be registered');

  for (const { uri, from } of corpus) {
    let failure: Error | null = null;
    try {
      await client.readResource({ uri });
    } catch (error) {
      failure = error as Error;
    }
    // A routing failure is the server refusing its OWN addressing scheme —
    // "Malformed … URI" means the URI matched an entry whose renderer then
    // rejected the address. An upstream failure is a different thing entirely:
    // it means the renderer ran and Spotify (here: the stub) declined.
    assert.equal(
      failure,
      null,
      `${from} expanded to ${uri}, which failed to read: ${failure?.message ?? ''}`,
    );
  }
});

test('spotify://playlist/pl1/tracks and its ?offset/?limit and ?format=json forms route (#685)', async () => {
  const { client, calls } = await productionServer();

  const prose = await client.readResource({ uri: 'spotify://playlist/pl1/tracks' });
  assert.equal(prose.contents[0]?.mimeType, 'text/plain');
  assert.match(textOf(prose), /^Playlist pl1 — 1 items/);

  const windowed = await client.readResource({ uri: 'spotify://playlist/pl1/tracks?offset=100&limit=2' });
  assert.match(textOf(windowed), /at offset 100/);
  const paged = calls.at(-1);
  assert.equal(paged?.path, '/playlists/pl1/items');
  assert.equal(paged?.params?.offset, '100');
  assert.equal(paged?.params?.limit, '2');

  const raw = await client.readResource({ uri: 'spotify://playlist/pl1/tracks?format=json' });
  assert.equal(raw.contents[0]?.mimeType, 'application/json');
  assert.equal((JSON.parse(textOf(raw)) as { items: unknown[] }).items.length, 1);
});

test('spotify://playlist/pl1 still routes to the playlist card, not to its tracks (#685)', async () => {
  const { client, calls } = await productionServer();
  const res = await client.readResource({ uri: 'spotify://playlist/pl1' });
  assert.match(textOf(res), /^Playlist: "P" by o/);
  assert.equal(calls.at(-1)?.path, '/playlists/pl1');
});

// -------------------------------- 4. prose and JSON come from one renderer

test('a URI read bare and with ?format=json is answered by the same renderer (#685)', async () => {
  const { client, server, calls } = await productionServer();
  const templates = liveTemplates(server);
  const fixed = Object.keys(
    (server as unknown as { _registeredResources: Record<string, unknown> })._registeredResources,
  );
  const bases = [...new Set([...fixed, ...expansions(templates).map(({ uri }) => uri)])].sort();

  const problems: string[] = [];
  for (const base of bases) {
    const before = calls.length;
    let prose: Awaited<ReturnType<Client['readResource']>> | null = null;
    try {
      prose = await client.readResource({ uri: base });
    } catch (error) {
      problems.push(`${base} failed bare: ${(error as Error).message}`);
    }
    const prosePaths = calls.slice(before).map((c) => `${c.method} ${c.path}`);

    const beforeJson = calls.length;
    let raw: Awaited<ReturnType<Client['readResource']>> | null = null;
    try {
      raw = await client.readResource({ uri: `${base}?format=json` });
    } catch (error) {
      problems.push(`${base}?format=json failed: ${(error as Error).message}`);
    }
    const jsonPaths = calls.slice(beforeJson).map((c) => `${c.method} ${c.path}`);

    if (prose && prose.contents[0]?.mimeType !== 'text/plain') {
      problems.push(`${base} should render prose bare, got ${prose.contents[0]?.mimeType}`);
    }
    if (raw && raw.contents[0]?.mimeType !== 'application/json') {
      problems.push(`${base}?format=json should return JSON, got ${raw.contents[0]?.mimeType}`);
    }
    if (raw) {
      try {
        JSON.parse(textOf(raw));
      } catch {
        problems.push(`${base}?format=json is not JSON`);
      }
    }
    // Same upstream calls, in the same order: the two spellings went through
    // one renderer rather than to a duplicate registration that happens to
    // produce a similar body.
    if (JSON.stringify(jsonPaths) !== JSON.stringify(prosePaths)) {
      problems.push(`${base} and ${base}?format=json took different upstream reads`);
    }
  }
  assert.deepEqual(problems, [], `rendering problems:\n${problems.join('\n')}`);
});

// ------------------------------------------------ 5. order does not matter

test('registration order changes nothing about routing (#685)', async () => {
  const { client: forward, calls: forwardCalls } = await productionServer();

  const { client: stubClient, calls: reverseCalls } = makeClientStub();
  const reverse = newServer();
  // Production order, then the two modules the other way round.
  registerResources(reverse, stubClient);
  registerTemplateResources(reverse, stubClient);
  const reverseClient = await connect(reverse);

  const templates = liveTemplates(newServerWithBoth());
  const corpus = expansions(templates).map(({ uri }) => uri);

  for (const uri of corpus) {
    forwardCalls.length = 0;
    reverseCalls.length = 0;
    let forwardText = '';
    let reverseText = '';
    let forwardError: string | null = null;
    let reverseError: string | null = null;
    try {
      forwardText = textOf(await forward.readResource({ uri }));
    } catch (error) {
      forwardError = (error as Error).message;
    }
    try {
      reverseText = textOf(await reverseClient.readResource({ uri }));
    } catch (error) {
      reverseError = (error as Error).message;
    }
    assert.equal(forwardError, reverseError, `${uri} read differently in the two registration orders`);
    assert.equal(forwardText, reverseText, `${uri} rendered differently in the two registration orders`);
    assert.deepEqual(
      forwardCalls.map((c) => `${c.method} ${c.path} ${JSON.stringify(c.params ?? {})}`),
      reverseCalls.map((c) => `${c.method} ${c.path} ${JSON.stringify(c.params ?? {})}`),
      `${uri} reached the API differently in the two registration orders`,
    );
  }
});
