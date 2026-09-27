/**
 * #694 — the one encoding contract, on both surfaces.
 *
 * Before this, the server accepted exactly the encoding its `inputSchema`
 * advertised. A host that flattens a multi-select into a CSV string, stringifies
 * a number, or upper-cases an enum label got a `-32602` that read as a server
 * bug, and the agent retried the same shape two or three times. The only
 * tolerance that existed was hand-rolled per tool — `following.ts`,
 * `boundedPlaylistArray` and `playlist_fill_from_search` each carried their own
 * `split(',')` — so the behaviour could not be learned from one failure and
 * applied to the next call.
 *
 * The layer is `src/tools/encoding.ts`, derived from the SAME JSON Schema the
 * host read out of `tools/list` and installed in front of validation on both
 * `tools/call` and `prompts/get`. These tests are wire-level on purpose: they
 * drive raw JSON-RPC so the assertions are about the frame the server put on the
 * wire, not about the SDK client's re-wrapping (the same reason
 * `errors.argument-contract.test.ts` does).
 *
 * The three encodings, and the one thing that is deliberately NOT tolerated:
 *
 *  - array ← CSV string, JSON array string, or one bare value
 *  - number ← a strict numeric string
 *  - enum ← a case variant, mapped to the canonical member
 *  - boolean ← NOTHING. `'false'` is a truthy string in JavaScript, and a
 *    `dry_run` that read as `true` because a host quoted it is the shipped
 *    #830 shape.
 *
 * The tests are written so that each one FAILS with the layer removed. In
 * particular `equalResults` and `accepted` compare against a call the schema
 * already accepts rather than asserting the message text, so a boundary that
 * merely reworded the refusal could not pass them.
 */
import './helpers/hermetic.js';

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { registerCatalogTools } from '../src/tools/catalog.js';
import { registerPlaybackTools } from '../src/tools/playback.js';
import { registerSearchTools } from '../src/tools/search.js';
import { installPromptErrorBoundary, installToolErrorBoundary } from '../src/tools/annotations.js';
import { StubSpotifyClient, type StubCall } from './helpers/stub-client.js';

/** Real 22-character Spotify track ids — `spotifyId` rejects anything shorter. */
const TRACK_A = '4iV5W9uYEdYUVa79Axb7Rh';
const TRACK_B = '1301WleyT98MSxVHPZCA6M';

interface JsonRpc {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

let closeHarness: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeHarness?.();
  closeHarness = undefined;
});

type Ask = (method: string, params?: Record<string, unknown>) => Promise<JsonRpc>;

/** A server driven over raw JSON-RPC, so `error.message` is the server's own. */
async function surface(build: (server: McpServer, client: StubSpotifyClient) => void): Promise<Ask> {
  const server = new McpServer({ name: 'encoding-tolerance', version: '0.0.0' });
  const client = new StubSpotifyClient();
  client
    .get_('/tracks', {
      respond: (call: StubCall) => {
        const ids = String((call.arg as { ids?: string } | undefined)?.ids ?? '').split(',');
        return {
          tracks: ids.map((id) => ({ id, name: `Track ${id}`, uri: `spotify:track:${id}`, duration_ms: 1000, artists: [] })),
        };
      },
    })
    .get_('/me/player/queue', {
      respond: () => ({
        currently_playing: { id: 'now', name: 'Now', uri: 'spotify:track:now', duration_ms: 1000 },
        queue: [
          { id: TRACK_A, name: 'Up next', uri: `spotify:track:${TRACK_A}`, duration_ms: 2000 },
          { id: TRACK_B, name: 'Then', uri: `spotify:track:${TRACK_B}`, duration_ms: 3000 },
        ],
      }),
    })
    .get_('/search', {
      respond: (call: StubCall) => {
        const types = String((call.arg as { type?: string } | undefined)?.type ?? 'track');
        // Echo the requested type back in the payload's shape so a test can tell
        // which search actually ran.
        return { [types]: { items: [{ id: 'x', name: 'Hit', uri: 'spotify:track:x' }], total: 1 } };
      },
    });
  build(server, client);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let next = 1;
  const pending = new Map<number, (value: JsonRpc) => void>();
  clientTransport.onmessage = (message) => {
    const frame = message as JsonRpc;
    if (typeof frame.id !== 'number') return;
    const resolve = pending.get(frame.id);
    if (!resolve) return;
    pending.delete(frame.id);
    resolve(frame);
  };
  await server.connect(serverTransport);
  await clientTransport.start();

  const ask: Ask = async (method, params = {}) => {
    const id = next++;
    const { promise, resolve, reject } = Promise.withResolvers<JsonRpc>();
    pending.set(id, resolve);
    await clientTransport.send({ jsonrpc: '2.0', id, method, params } as never);
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15_000).unref();
    return await promise;
  };

  const init = await ask('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'encoding-tolerance', version: '0.0.0' },
  });
  assert.equal(init.error, undefined, `initialize failed: ${JSON.stringify(init.error)}`);
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as never);

  closeHarness = async () => {
    await clientTransport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  };
  return ask;
}

/** The three real registrars plus the production boundary. */
function toolSurface(): Promise<Ask> {
  return surface((server, client) => {
    registerCatalogTools(server, client);
    registerPlaybackTools(server, client);
    registerSearchTools(server, client);
    installToolErrorBoundary(server);
  });
}

function call(ask: Ask, name: string, args: Record<string, unknown>): Promise<JsonRpc> {
  return ask('tools/call', { name, arguments: args });
}

/** The refusal text for a call the boundary rejected. */
async function refusal(ask: Ask, name: string, args: Record<string, unknown>): Promise<string> {
  const frame = await call(ask, name, args);
  const structured = frame.result?.structuredContent as { error?: { text?: string } } | undefined;
  const text = structured?.error?.text ?? (frame.result?.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? '';
  assert.notEqual(text, '', `${name} ${JSON.stringify(args)} produced no text: ${JSON.stringify(frame)?.slice(0, 300)}`);
  return text;
}

/**
 * A call the boundary ACCEPTED, asserted against a call the schema already
 * accepts. This is the assertion a reworded error message cannot satisfy: it
 * compares two successful results, so it only passes when the tolerated encoding
 * reached the handler and produced the same answer as the canonical one.
 */
async function accepted(ask: Ask, name: string, tolerated: Record<string, unknown>, canonical: Record<string, unknown>): Promise<void> {
  const got = await call(ask, name, tolerated);
  const want = await call(ask, name, canonical);
  const gotText = (got.result?.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? '';
  const wantText = (want.result?.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? '';
  assert.equal(got.error, undefined, `${name} ${JSON.stringify(tolerated)} was refused: ${JSON.stringify(got.error)}`);
  assert.equal(want.error, undefined, `${name} ${JSON.stringify(canonical)} was refused: ${JSON.stringify(want.error)}`);
  assert.equal(gotText, wantText, `${name}: the tolerated encoding and the canonical one must agree`);
  assert.equal(
    JSON.stringify(got.result?.structuredContent),
    JSON.stringify(want.result?.structuredContent),
    `${name}: the tolerated encoding and the canonical one must publish the same structuredContent`,
  );
}

// ---------------------------------------------------------------------------
// arrays
// ---------------------------------------------------------------------------

describe('#694 a CSV list is the list the schema declares', () => {
  it('a CSV ids call and its JSON-array equivalent produce identical results', async () => {
    const ask = await toolSurface();
    await accepted(ask, 'get_several_tracks', { ids: `${TRACK_A},${TRACK_B}` }, { ids: [TRACK_A, TRACK_B] });
  });

  it('a bare single value is a one-item list', async () => {
    const ask = await toolSurface();
    await accepted(ask, 'get_several_tracks', { ids: TRACK_A }, { ids: [TRACK_A] });
  });

  it('a JSON-array string is the list it spells out', async () => {
    const ask = await toolSurface();
    await accepted(ask, 'get_several_tracks', { ids: `["${TRACK_A}","${TRACK_B}"]` }, { ids: [TRACK_A, TRACK_B] });
  });

  it('trims padding and drops empty cells', async () => {
    const ask = await toolSurface();
    await accepted(ask, 'get_several_tracks', { ids: ` ${TRACK_A} ,, ${TRACK_B} ` }, { ids: [TRACK_A, TRACK_B] });
  });

  it('the JSON form is the escape hatch for a value that really contains a comma', async () => {
    // The split is a guess about a list, so the rule has to leave a way to be
    // exact. `create_smart_playlist.artist_filter` is the clearest case: an
    // artist whose name contains a comma.
    const ask = await surface((server) => {
      server.tool(
        'filter_by_artist',
        'filter by artist name',
        { artists: z.array(z.string().min(1)).max(20) },
        async (args) => ({ content: [{ type: 'text' as const, text: JSON.stringify(args.artists) }] }),
      );
      installToolErrorBoundary(server);
    });
    const frame = await call(ask, 'filter_by_artist', { artists: '["Tyler, The Creator"]' });
    const text = (frame.result?.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? '';
    assert.deepEqual(JSON.parse(text), ['Tyler, The Creator']);
  });
});

describe('#694 a split that would not validate is discarded whole', () => {
  it('reports the real problem instead of a partial list', async () => {
    const ask = await toolSurface();
    // `nope` is not a Spotify track reference, so the split to
    // `[TRACK_A, "nope"]` cannot validate. The caller must be told the argument
    // is wrong, NOT handed a one-item list with the bad cell quietly gone —
    // that would be a value the API could contradict (#803).
    const message = await refusal(ask, 'get_several_tracks', { ids: `${TRACK_A},nope` });
    assert.match(message, /rejected parameter ids/);
    assert.doesNotMatch(message, /Track nope/, 'the discarded entry must not reappear as a result row');
  });

  it('an unknown enum cell in a CSV list is not silently dropped', async () => {
    const ask = await toolSurface();
    const message = await refusal(ask, 'get_queue', { include: 'runtime,nope' });
    assert.match(message, /rejected parameter include/);
  });
});

// ---------------------------------------------------------------------------
// numbers
// ---------------------------------------------------------------------------

describe('#694 a numeric string is the number it spells', () => {
  it('accepts a stringified integer where a number is declared', async () => {
    const ask = await toolSurface();
    const got = await call(ask, 'get_queue', { max_results: '1', response_format: 'json' });
    const want = await call(ask, 'get_queue', { max_results: 1, response_format: 'json' });
    assert.equal(got.error, undefined, `refused: ${JSON.stringify(got.error)}`);
    assert.equal(
      JSON.stringify(got.result?.structuredContent),
      JSON.stringify(want.result?.structuredContent),
    );
  });

  it('does not read an empty string as zero', async () => {
    // The #803 shape: a value that could not be read coerced into a plausible
    // number. `Number('')` is 0, so a permissive coercion would answer
    // "zero items" for a caller who sent nothing.
    const ask = await toolSurface();
    const message = await refusal(ask, 'get_queue', { max_results: '' });
    assert.match(message, /expected a number/);
  });

  it('does not read a non-numeric string as a number', async () => {
    const ask = await toolSurface();
    const message = await refusal(ask, 'get_queue', { max_results: 'twenty' });
    assert.match(message, /expected a number/);
  });

  it('does not read a float into an integer field', async () => {
    const ask = await toolSurface();
    const message = await refusal(ask, 'get_queue', { max_results: '1.5' });
    assert.match(message, /rejected parameter max_results/);
  });
});

// ---------------------------------------------------------------------------
// enums
// ---------------------------------------------------------------------------

describe('#694 an enum matches case-insensitively', () => {
  it('folds a case variant onto the canonical member', async () => {
    const ask = await toolSurface();
    await accepted(ask, 'get_queue', { response_format: 'JSON' }, { response_format: 'json' });
  });

  it('folds a case variant inside a CSV list', async () => {
    const ask = await toolSurface();
    const got = await call(ask, 'get_queue', { include: 'RUNTIME', response_format: 'json' });
    const want = await call(ask, 'get_queue', { include: ['runtime'], response_format: 'json' });
    assert.equal(got.error, undefined, `refused: ${JSON.stringify(got.error)}`);
    assert.equal(
      JSON.stringify(got.result?.structuredContent),
      JSON.stringify(want.result?.structuredContent),
    );
  });

  it('folds a case variant in a multi-value list', async () => {
    const ask = await toolSurface();
    await accepted(ask, 'search', { query: 'q', types: 'Album,Track' }, { query: 'q', types: ['album', 'track'] });
  });

  it('names every legal member when the value is not one at any casing', async () => {
    const ask = await toolSurface();
    const message = await refusal(ask, 'get_queue', { response_format: 'xml' });
    assert.match(message, /one of "concise", "detailed", or "json"/);
  });
});

// ---------------------------------------------------------------------------
// what is deliberately NOT tolerated
// ---------------------------------------------------------------------------

describe('#694 a boolean is never read out of a string', () => {
  it('refuses "false" rather than treating a truthy string as a set flag', async () => {
    const ask = await surface((server) => {
      server.tool(
        'set_flag',
        'set a flag',
        { flag: z.boolean().optional() },
        async (args) => ({ content: [{ type: 'text' as const, text: JSON.stringify(args.flag) }] }),
      );
      installToolErrorBoundary(server);
    });
    const message = await refusal(ask, 'set_flag', { flag: 'false' });
    assert.match(message, /expected a boolean/);
  });
});

// ---------------------------------------------------------------------------
// the strict-schema interaction
// ---------------------------------------------------------------------------

describe('#694 tolerance does not weaken unknown-key rejection', () => {
  it('still refuses a genuinely unknown argument and names the key', async () => {
    const ask = await toolSurface();
    const frame = await call(ask, 'get_queue', { max_resultz: '5' });
    const structured = frame.result?.structuredContent as { error?: { kind?: string; param?: string } } | undefined;
    assert.equal(structured?.error?.kind, 'unknown_param');
    assert.equal(structured?.error?.param, 'max_resultz');
    const message = await refusal(ask, 'get_queue', { max_resultz: '5' });
    assert.match(message, /does not accept parameter max_resultz; remove it and use "max_results" instead/);
  });

  it('still refuses a near-miss key even when its value would have been tolerated', async () => {
    const ask = await toolSurface();
    const frame = await call(ask, 'get_several_tracks', { ids_: `${TRACK_A},${TRACK_B}` });
    const structured = frame.result?.structuredContent as { error?: { kind?: string } } | undefined;
    assert.equal(structured?.error?.kind, 'unknown_param');
  });
});

// ---------------------------------------------------------------------------
// prompts/get
// ---------------------------------------------------------------------------

describe('#694 prompts/get observes the same contract', () => {
  it('folds a case variant enum argument', async () => {
    const ask = await surface((server) => {
      server.prompt(
        'mood_report',
        { range: z.enum(['short_term', 'medium_term', 'long_term']) },
        (args) => ({ messages: [{ role: 'user', content: { type: 'text', text: `range=${(args as { range: string }).range}` } }] }),
      );
      installPromptErrorBoundary(server);
    });
    const frame = await ask('prompts/get', { name: 'mood_report', arguments: { range: 'LONG_TERM' } });
    assert.equal(frame.error, undefined, `refused: ${JSON.stringify(frame.error)}`);
    const content = (frame.result?.messages as Array<{ content: { text: string } }>)[0].content;
    assert.equal(content.text, 'range=long_term');
  });

  it('splits a CSV list argument', async () => {
    const ask = await surface((server) => {
      server.prompt(
        'multi_tag',
        { tags: z.array(z.string().min(1)).min(1) },
        (args) => ({ messages: [{ role: 'user', content: { type: 'text', text: JSON.stringify((args as { tags: string[] }).tags) } }] }),
      );
      installPromptErrorBoundary(server);
    });
    const frame = await ask('prompts/get', { name: 'multi_tag', arguments: { tags: 'jazz,soul' } });
    assert.equal(frame.error, undefined, `refused: ${JSON.stringify(frame.error)}`);
    const content = (frame.result?.messages as Array<{ content: { text: string } }>)[0].content;
    assert.deepEqual(JSON.parse(content.text), ['jazz', 'soul']);
  });

  it('still names every legal member for an argument that is not one', async () => {
    const ask = await surface((server) => {
      server.prompt(
        'mood_report',
        { range: z.enum(['short_term', 'medium_term', 'long_term']) },
        () => ({ messages: [] }),
      );
      installPromptErrorBoundary(server);
    });
    const frame = await ask('prompts/get', { name: 'mood_report', arguments: { range: 'yearly' } });
    assert.ok(frame.error, 'a non-member must be refused');
    assert.equal(frame.error?.code, -32602);
    assert.match(frame.error?.message ?? '', /one of "short_term", "medium_term", or "long_term"/);
  });
});
