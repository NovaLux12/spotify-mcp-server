/**
 * #598 — `expand_mood_to_queries` against a REAL MCP client/server pair.
 *
 * In-process, over `InMemoryTransport`, because the three things this issue is
 * actually about are all properties of the WIRE and none of them is visible by
 * calling the handler directly:
 *
 *  1. The capability gate reads `server.server.getClientCapabilities()`, which
 *     only holds a value once a client has completed `initialize`. A unit test
 *     that constructs an `McpServer` and calls the registrar sees a server with
 *     NO client, which is indistinguishable from a client that declined
 *     sampling — so a fake could not tell the two apart. Connecting a real
 *     client that advertises `sampling` produces a genuinely different
 *     observable: one `sampling/createMessage` request arriving, or none.
 *  2. "No `sampling/createMessage` is issued" is a claim about requests, not
 *     about a return value. It is asserted here by counting the requests the
 *     host actually received, which is the only place that number exists.
 *  3. The structuredContent contract is what an agent reads. Asserting on the
 *     tool result as the SDK delivers it is the contract; asserting on an
 *     internal return value would be asserting on the implementation.
 *
 * The sampling host is a REAL `Client` with a `createMessage` handler — the
 * SDK's own sampling request handler — not a stub of the server method. That
 * distinction is the point of test 1: stubbing `server.createMessage` would let
 * this file pass even if the capability gate were deleted, because the stub
 * would answer regardless. Counting real requests is what makes the gate
 * falsifiable.
 */
import './helpers/hermetic.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CreateMessageRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import {
  MOOD_EXPANSION,
  lookupStaticExpansion,
  hostSupportsSampling,
  registerMoodExpandTools,
} from '../src/tools/moodexpand.ts';

/**
 * The sampling side of the pair, wired the way a host wires it.
 *
 * `createMessage` on a `Client` is the request handler for `sampling/
 * createMessage`: the SDK routes an incoming request of that method to it.
 * Requests are counted before the reply is chosen, so a test can assert on
 * attempts even when the reply is an error.
 */
interface SamplingHost {
  readonly client: Client;
  /** Replies, in order. The last one repeats once the list is exhausted. */
  replies: string[];
  readonly requests: Array<{ text: string; maxTokens: number }>;
}

/** The slice of a `sampling/createMessage` request this file reads. */
interface SamplingRequest {
  params?: {
    messages?: Array<{ content?: { type: string; text?: string } }>;
    maxTokens?: number;
  };
}

function samplingHost(): SamplingHost {
  const host: SamplingHost = {
    client: new Client({ name: 'sampling-host', version: '0.0.0' }, { capabilities: { sampling: {} } }),
    replies: [],
    requests: [],
  };
  host.client.setRequestHandler(
    // The SDK's own request schema, so the handler is registered against the
    // literal the server actually dispatches on rather than a hand-written
    // guess at it.
    CreateMessageRequestSchema,
    (async (request: SamplingRequest) => {
      const first = request.params?.messages?.[0]?.content;
      host.requests.push({
        text: first?.type === 'text' ? first.text ?? '' : '',
        maxTokens: request.params?.maxTokens ?? 0,
      });
      const index = Math.min(host.requests.length - 1, host.replies.length - 1);
      return {
        role: 'assistant',
        content: { type: 'text', text: host.replies[index] ?? '{}' },
        model: 'test-model-1',
      };
    }) as never,
  );
  return host;
}

function plainHost(): Client {
  // A client that never advertises sampling — the degraded-host case.
  return new Client({ name: 'plain-host', version: '0.0.0' });
}

interface Call {
  text: string;
  structured: Record<string, unknown>;
  isError: boolean;
}

async function connect(client: Client): Promise<Client> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerMoodExpandTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(clientTransport), client.connect(serverTransport)]);
  return client;
}

async function call(client: Client, args: Record<string, unknown>): Promise<Call> {
  const result = (await client.callTool({ name: 'expand_mood_to_queries', arguments: args })) as {
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  return {
    text: result.content?.[0]?.text ?? '',
    structured: result.structuredContent ?? {},
    isError: result.isError === true,
  };
}

describe('#598 — expand_mood_to_queries', () => {
  it('returns zod-validated arrays from the host model on a sampling host', async () => {
    const host = samplingHost();
    host.replies = [
      JSON.stringify({
        genres: ['indie', 'dream pop'],
        keywords: ['rainy afternoon', 'shoegaze'],
        exclude: ['dance'],
      }),
    ];
    const mcp = await connect(host.client);
    const out = await call(mcp, { mood: 'rainy afternoon' });

    assert.equal(out.isError, false);
    assert.equal(out.structured.source, 'sampling');
    assert.equal(out.structured.model, 'test-model-1');
    assert.deepEqual(out.structured.genres, ['indie', 'dream pop']);
    assert.deepEqual(out.structured.keywords, ['rainy afternoon', 'shoegaze']);
    assert.deepEqual(out.structured.exclude, ['dance']);
    assert.equal(host.requests.length, 1, 'one sampling request on the happy path');
  });

  it('strips a markdown fence but repairs nothing else', async () => {
    const host = samplingHost();
    host.replies = ['```json\n{"genres":["jazz"],"keywords":["late night"],"exclude":[]}\n```'];
    const mcp = await connect(host.client);
    const out = await call(mcp, { mood: 'late night' });

    assert.equal(out.isError, false);
    assert.deepEqual(out.structured.genres, ['jazz']);
  });

  it('issues NO sampling request when the host does not advertise the capability', async () => {
    const host = samplingHost();
    const mcp = await connect(plainHost());
    const out = await call(mcp, { mood: 'rainy afternoon' });

    assert.equal(host.requests.length, 0, 'the sampling host received nothing');
    assert.equal(out.structured.source, 'static_map');
    assert.equal(out.structured.matched, true);
    assert.deepEqual(out.structured.genres, [...MOOD_EXPANSION.rainy.genres]);
    assert.ok(
      (out.structured.genres as string[]).length > 0,
      'the static map returns a real expansion, not an empty stand-in',
    );
  });

  it('retries once on a malformed reply, then fails with a structured error', async () => {
    const host = samplingHost();
    // Prose where JSON was asked for: the classic unreadable reply.
    host.replies = ['Sure! Here are some ideas: indie rock, shoegaze.'];
    const mcp = await connect(host.client);
    const out = await call(mcp, { mood: 'focus' });

    assert.equal(host.requests.length, 2, 'exactly one retry, then it stops');
    assert.equal(out.isError, true);
    assert.equal(out.structured.returned, null, 'a failed lookup is null, never an empty expansion');
    const error = out.structured.error as Record<string, unknown>;
    assert.equal(error.tool, 'expand_mood_to_queries');
    assert.equal(error.reason, 'model_response_not_usable');
    assert.deepEqual(out.structured.genres, undefined, 'no guess was substituted for the unreadable reply');
  });

  it('recovers when the retry is well-formed', async () => {
    const host = samplingHost();
    host.replies = ['not json', JSON.stringify({ genres: ['edm'], keywords: ['sprint'], exclude: [] })];
    const mcp = await connect(host.client);
    const out = await call(mcp, { mood: 'sprint' });

    assert.equal(out.isError, false);
    assert.equal(out.structured.attempts, 2, 'the retry is counted, so a caller can see it happened');
    assert.deepEqual(out.structured.genres, ['edm']);
  });

  it('rejects JSON that parses but does not match the declared shape', async () => {
    const host = samplingHost();
    // `genres` is a string, not an array: parseable, and still wrong.
    host.replies = [JSON.stringify({ genres: 'indie', keywords: [], exclude: [] })];
    const mcp = await connect(host.client);
    const out = await call(mcp, { mood: 'focus' });

    assert.equal(out.isError, true);
    assert.match(
      out.structured.detail as string,
      /did not match the shape/,
      'the failure names the shape, not just "invalid"',
    );
  });

  it('reports a static-map miss as matched:false rather than rounding to the nearest row', async () => {
    const mcp = await connect(plainHost());
    const out = await call(mcp, { mood: 'sombre techno funeral for a deceased pet' });

    assert.equal(out.structured.source, 'static_map');
    assert.equal(out.structured.matched, false, 'nothing was matched, and it says so');
    assert.deepEqual(out.structured.genres, [], 'no genre is invented for a mood the map lacks');
    assert.match(out.text, /not in the built-in map/);
  });

  it('rejects a whitespace-only mood instead of expanding it to nothing', async () => {
    // "   " satisfies min(1). Untrimmed it normalises to "", matches no row, and
    // returns a SUCCESSFUL call carrying three empty arrays and matched=false —
    // which reads as "this mood expands to nothing" rather than "you sent
    // nothing", and is the AGENTS.md §6 shape: a successful report about an
    // input that was never there. A validation error is the honest answer.
    const mcp = await connect(plainHost());
    const out = await call(mcp, { mood: '   ' });

    assert.equal(out.isError, true, 'an empty mood is an error, not an empty expansion');
    assert.equal(out.structured.source, undefined, 'no source is reported for a call that never ran');
  });
});

describe('#598 — the static map itself', () => {
  it('keeps every genre inside Spotify\'s genre-seed vocabulary', () => {
    // The seeds below were verified against the canonical list behind
    // `GET /recommendations/available-genre-seeds` (deprecated for
    // post-Nov-2024 apps, hence checked once out of band rather than at
    // runtime). A word that is not a seed belongs under `keywords`, which is
    // free text for `search` and is held to no such list.
    const seeds = new Set([
      'pop', 'indie', 'indie-pop', 'alternative', 'alt-rock', 'acoustic', 'afrobeat',
      'ambient', 'new-age', 'piano', 'classical', 'electronic', 'edm', 'house', 'techno',
      'drum-and-bass', 'dubstep', 'trip-hop', 'chill', 'jazz', 'blues', 'soul', 'funk',
      'disco', 'dance', 'r&b', 'hip-hop', 'gospel', 'rock', 'punk', 'emo', 'ska', 'grunge',
      'garage', 'metal', 'folk', 'country', 'reggae', 'latin', 'bossanova', 'k-pop',
      'j-pop', 'singer-songwriter',
    ]);
    for (const [key, row] of Object.entries(MOOD_EXPANSION)) {
      for (const genre of row.genres) {
        assert.ok(
          seeds.has(genre),
          `MOOD_EXPANSION.${key}.genres has "${genre}", which is not a verified genre seed`,
        );
      }
    }
  });

  it('resolves a free-text mood through normalisation and stopwords', () => {
    assert.equal(lookupStaticExpansion('Rainy Day!')?.key, 'rainy', 'case and punctuation are folded');
    assert.equal(lookupStaticExpansion('some focus playlist')?.key, 'focus', 'a stopword-free token decides it');
    assert.equal(lookupStaticExpansion('late night coding')?.key, 'late night coding', 'a whole phrase hits the alias table');
    assert.equal(lookupStaticExpansion('DEEP WORK')?.key, 'deep work', 'and case-folds on the way');
    assert.equal(lookupStaticExpansion('  ')?.key, undefined, 'an empty mood matches nothing');
    assert.equal(
      lookupStaticExpansion('sombre techno funeral')?.key,
      undefined,
      'no row is close enough to be offered as a match',
    );
  });
});

describe('#598 — the capability gate is not a stub that always answers', () => {
  it('is false on an unconnected server and true only once a sampling host is connected', async () => {
    // This is the assertion that would stop passing if the gate were deleted
    // and replaced with an unconditional call: an unconnected server has no
    // client capabilities at all, so the gate must be false there.
    const bare = new McpServer({ name: 'bare', version: '0.0.0' });
    assert.equal(hostSupportsSampling(bare), false, 'no client, so no sampling');

    const host = samplingHost();
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(clientTransport), host.client.connect(serverTransport)]);
    assert.equal(hostSupportsSampling(server), true, 'a connected sampling host is visible');
  });
});

