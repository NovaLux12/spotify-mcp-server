/**
 * Tests for #1401 — RFC 6570 matching of advertised resource templates.
 *
 * The defect this covers is not "the braces are a literal string": the MCP SDK
 * already pattern-matches (`server/mcp.js` runs `uriTemplate.match(uri)` in
 * registration order). It is that the SDK's own `UriTemplate` is stricter than
 * RFC 6570, which leaves every advertised `{?…}` template unable to match a URI
 * a conforming host would build from it, and turned each `{+qs}` catch-all into
 * an unanchored `(.+)` prefix match that also accepted URIs that were not this
 * resource at all. #685 removed those catch-alls once the matcher no longer
 * needed them, so this file now asserts the property over every template.
 *
 * The first group drives the real SDK over `InMemoryTransport`, so routing is
 * exercised the way a host exercises it. The second group asserts the general
 * property — every URI the server advertises is one it can actually match — so
 * the next template that gets this wrong is caught here rather than by a host.
 */
import './helpers/hermetic.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { UriTemplate } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';

import { registerResources } from '../src/resources/index.js';
import { registerTemplateResources } from '../src/resources/templates.js';
import type { SpotifyClient } from '../src/client.js';

type Call = { method: string; path: string; params?: Record<string, string> };

function makeClientStub(): { client: SpotifyClient; calls: Call[] } {
  const calls: Call[] = [];
  const empty = { items: [], total: 0, limit: 20, offset: 0, next: null };
  const stub = {
    get: async (path: string, params?: Record<string, string>) => {
      calls.push(params === undefined ? { method: 'GET', path } : { method: 'GET', path, params });
      return empty;
    },
    getAllPages: async () => [],
    getAllPagesWithTruncation: async () => ({
      items: [],
      truncated: false,
      truncatedByCap: false,
      reportedTotal: null,
    }),
    getRateLimitStatus: () => ({
      lastThrottleAt: null as number | null,
      retryAfterSec: null as number | null,
      cooldownRemainingMs: 0,
    }),
  };
  return { client: stub as unknown as SpotifyClient, calls };
}

async function connect(client: SpotifyClient): Promise<Client> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerResources(server, client);
  registerTemplateResources(server, client);
  const mcpClient = new Client({ name: 'tester', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
  return mcpClient;
}

/**
 * The `ResourceTemplate` objects the SDK will actually route with, read off a
 * live server rather than rebuilt from a template string.
 *
 * This matters: constructing a `Rfc6570UriTemplate` in a test and matching with
 * it proves only that the class works, not that the registry is wired to it. A
 * test that builds its own subject passes even with the wiring reverted, which
 * is the "a test that cannot fail" trap. Reaching into the SDK's registry is
 * the only way to assert about the templates a host is actually offered.
 */
function registeredTemplates(): { uriTemplate: string; matcher: (uri: string) => unknown }[] {
  const server = new McpServer({ name: 'registry-probe', version: '0.0.0' });
  const { client } = makeClientStub();
  registerResources(server, client);
  registerTemplateResources(server, client);
  const registry = (server as unknown as {
    _registeredResourceTemplates: Record<
      string,
      { resourceTemplate: { uriTemplate: { toString(): string; match(uri: string): unknown } } }
    >;
  })._registeredResourceTemplates;
  return Object.values(registry).map((entry) => ({
    uriTemplate: entry.resourceTemplate.uriTemplate.toString(),
    matcher: (uri: string) => entry.resourceTemplate.uriTemplate.match(uri),
  }));
}

const SAVED_TRACKS = 'spotify://me/saved/tracks';
const SAVED_TRACKS_TEMPLATE = `${SAVED_TRACKS}{?format,offset,limit}`;

// ------------------------------------------------- routing, through the SDK

test('the bare template string the server advertises resolves (#1401)', async () => {
  const { client } = makeClientStub();
  const mcp = await connect(client);
  // A host that hands back the `uriTemplate` it just read must not be told the
  // resource does not exist. The MCP client percent-encodes the leading brace,
  // which is why the delivered URI is not the literal template string.
  const res = await mcp.readResource({ uri: SAVED_TRACKS_TEMPLATE });
  assert.equal(res.contents[0]?.uri, SAVED_TRACKS);
});

test('a concrete URI with a query resolves, however few of the declared parameters it carries (#1401)', async () => {
  const { client, calls } = makeClientStub();
  const mcp = await connect(client);

  // One declared parameter of three. Under the SDK's old matcher this matched
  // neither the `{?format,offset,limit}` entry nor the bare resource.
  await mcp.readResource({ uri: `${SAVED_TRACKS}?limit=5` });
  assert.deepEqual(calls.at(-1)?.params, { limit: '5', offset: '0' });

  // Two of three, in declaration order.
  await mcp.readResource({ uri: `${SAVED_TRACKS}?format=json&limit=5` });
  assert.equal(calls.at(-1)?.path, '/me/tracks');

  // All three, and an undeclared parameter alongside them.
  await mcp.readResource({ uri: `${SAVED_TRACKS}?format=json&offset=10&limit=5` });
  assert.deepEqual(calls.at(-1)?.params, { limit: '5', offset: '10' });
});

test('a concrete URI with no query resolves to the documented defaults (#1401)', async () => {
  const { client, calls } = makeClientStub();
  const mcp = await connect(client);
  const res = await mcp.readResource({ uri: SAVED_TRACKS });
  assert.equal(res.contents[0]?.uri, SAVED_TRACKS);
  assert.deepEqual(calls.at(-1)?.params, { limit: '20', offset: '0' });
});

test('a URI that is not this resource is still rejected, with no API call (#1401)', async () => {
  const { client, calls } = makeClientStub();
  const mcp = await connect(client);

  // Each of these was accepted before the fix: the `{+qs}` twin compiled to a
  // bare `(.+)`, so anything with the base as a *prefix* matched and was
  // served saved tracks. A matcher that matches too much is as wrong as one
  // that matches nothing.
  for (const uri of [
    `${SAVED_TRACKS}X`,
    `${SAVED_TRACKS}/extra`,
    `${SAVED_TRACKS}extra?limit=5`,
    'spotify://me/saved',
    'spotify://me/saved/tracks-nope?format=json&offset=0&limit=1',
  ]) {
    await assert.rejects(
      mcp.readResource({ uri }),
      (err: Error) => /not found/i.test(err.message),
      `expected ${uri} to be rejected`,
    );
  }
  assert.equal(calls.length, 0, 'a rejected URI must not reach the Spotify API');
});

test('an undeclared or out-of-order query parameter still routes (#1401)', async () => {
  const { client } = makeClientStub();
  const mcp = await connect(client);
  // `Rfc6570UriTemplate`'s form-style matcher reads the declared names as an
  // ordered subsequence and permits undeclared pairs, so this server's
  // addressing stays open to query strings it does not model. #685 removed the
  // `{+qs}` twin that used to be the mechanism; the door must stay open.
  await mcp.readResource({ uri: `${SAVED_TRACKS}?market=GB` });
  await mcp.readResource({ uri: `${SAVED_TRACKS}?limit=5&format=json` });
});

test('a nested template is not swallowed by its parent resource (#685, #1401)', async () => {
  const { client, calls } = makeClientStub();
  const mcp = await connect(client);
  // `spotify://audiobook/{id}{+qs}` compiled to a prefix match that used to
  // accept `spotify://audiobook/bk1/chapters`. The chapters entry must win —
  // and must still win now that the catch-all twin is gone.
  await mcp.readResource({ uri: 'spotify://audiobook/bk1/chapters?limit=5&offset=10' });
  assert.equal(calls.at(-1)?.path, '/audiobooks/bk1/chapters');
});

// --------------------------------------- the advertised list, as a property

/** Plausible values for the variable names this server's templates declare. */
const SAMPLE_VALUES: Record<string, string> = {
  id: 'abc123',
  format: 'json',
  limit: '5',
  offset: '10',
  time_range: 'short_term',
  after: '1700000000000',
  before: '1800000000000',
  market: 'GB',
  qs: '?format=json',
};

test('every registered template matches the URI a host expands it to (#1401)', () => {
  const registry = registeredTemplates();
  assert.ok(registry.length > 0);

  const unmatched: string[] = [];
  for (const { uriTemplate, matcher } of registry) {
    // Expansion is the host's job, so use the SDK's own expander to produce the
    // concrete URI, then require the template the registry actually holds to
    // accept it.
    const sdk = new UriTemplate(uriTemplate);
    const variables = Object.fromEntries(sdk.variableNames.map((n) => [n, SAMPLE_VALUES[n] ?? 'x']));
    const expanded = sdk.expand(variables);
    if (!matcher(expanded)) unmatched.push(`${uriTemplate} -> ${expanded}`);
  }
  assert.deepEqual(unmatched, [], 'advertised templates a host cannot route to');
});

test('every form-style registered template also matches with only some variables defined (#1401)', () => {
  // Only templates whose sole expression is a query-string operator. Dropping a
  // path variable is a different proposition: RFC 6570 expands an undefined
  // simple variable to nothing, so `spotify://artist/{id}` with no `id` is
  // `spotify://artist/` — a URI with an empty id segment, which must NOT match,
  // and which the SDK's `([^/,]+)` already gets right.
  const registry = registeredTemplates().filter(
    ({ uriTemplate }) => (uriTemplate.match(/\{\S+?\}/g) ?? []).length === 1 && /\{[?&#]/.test(uriTemplate),
  );
  assert.ok(registry.length > 0, 'expected form-style templates to be registered');

  const unmatched: string[] = [];
  for (const { uriTemplate, matcher } of registry) {
    const names = new UriTemplate(uriTemplate).variableNames;
    // RFC 6570: a form-style expression expands with whatever is defined, so a
    // host that supplies one variable of three must still land on the entry it
    // was advertised.
    for (const drop of names) {
      const variables = Object.fromEntries(
        names.filter((n) => n !== drop).map((n) => [n, SAMPLE_VALUES[n] ?? 'x']),
      );
      const expanded = new UriTemplate(uriTemplate).expand(variables);
      if (!matcher(expanded)) unmatched.push(`${uriTemplate} (without ${drop}) -> ${expanded}`);
    }
  }
  assert.deepEqual(unmatched, []);
});

test('no registered template absorbs a URI that is not a query on that resource (#685, #1401)', () => {
  const registry = registeredTemplates();
  assert.ok(registry.length > 0);

  // #685 removed the `{+qs}` catch-all twins, so this is now a property of
  // every template rather than of the ones that used to be catch-alls: a bare
  // `(.+)` accepted any URI with the resource as a *prefix*, so
  // `spotify://me/saved/tracksX` — a different resource — was served saved
  // tracks. Only templates whose base ends in a LITERAL are asserted here:
  // where the base ends in a variable (`spotify://artist/{id}{?format}`),
  // appending `X` does not extend the path, it makes a different id.
  const literalEnding = registry.filter(({ uriTemplate }) => {
    const head = uriTemplate.replace(/\{[?#][^}]*\}$/, '');
    return head.length > 0 && !head.endsWith('}');
  });
  assert.ok(literalEnding.length > 0, 'expected literal-ending templates to be registered');

  const overMatched: string[] = [];
  for (const { uriTemplate, matcher } of literalEnding) {
    // A real URI, not the template text: expand the path variables and let the
    // query-string expression collapse to nothing.
    const head = uriTemplate.replace(/\{[?#][^}]*\}$/, '');
    const base = new UriTemplate(head).expand({ id: SAMPLE_VALUES.id });
    for (const suffix of ['X', '/extra', 'extra?limit=5']) {
      if (matcher(base + suffix)) overMatched.push(`${uriTemplate} accepted ${base}${suffix}`);
    }
  }
  assert.deepEqual(overMatched, []);
});

test('a template with no variables defined expands to the bare URI and matches (#1401)', () => {
  const registered = registeredTemplates().find((t) => t.uriTemplate === SAVED_TRACKS_TEMPLATE);
  assert.ok(registered, `expected ${SAVED_TRACKS_TEMPLATE} to be registered`);
  // RFC 6570 expands `{?format,offset,limit}` with nothing defined to the empty
  // string, leaving the bare URI. The old matcher required all three.
  assert.equal(new UriTemplate(SAVED_TRACKS_TEMPLATE).expand({}), SAVED_TRACKS);
  assert.ok(registered.matcher(SAVED_TRACKS), 'the zero-variable expansion must match');
});
