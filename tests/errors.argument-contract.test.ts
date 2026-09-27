/**
 * #689 — the argument contract on BOTH surfaces: reject what the schema does
 * not declare, and say what was expected when it does.
 *
 * The tool half of this already shipped in `installToolErrorBoundary`; the
 * assertions here keep it honest and pin the one part it left generic (a tool
 * validation message named the parameter but not the constraint). The prompt
 * half is the defect this file exists for:
 *
 *  - `server.prompt()` registers a PLAIN `z.object()`, which STRIPS. A call
 *    carrying a misspelled argument rendered a complete prompt built from
 *    defaults and said nothing at all, so a caller got a plausible answer to a
 *    question it had not asked. `dj`, which declares no arguments, accepted
 *    anything.
 *  - A real validation failure came back through `McpError` as
 *    `MCP error -32602: Invalid arguments for prompt playlist_audit: Invalid
 *    input: expected string, received undefined at playlist` — the prefix and
 *    the raw zod wording, neither of which a caller can act on.
 *  - And a non-string argument value was rejected by the SDK's own request
 *    schema (`z.record(z.string(), z.string())`) before any handler ran, as a
 *    `-32603` carrying a pretty-printed zod issue array.
 *
 * The tests drive RAW JSON-RPC rather than the SDK `Client` on purpose. The
 * client re-wraps every response error in `McpError`, which re-adds the
 * `MCP error <code>: ` prefix this contract removes — so asserting through it
 * would test the client's formatting rather than the server's message. What is
 * asserted below is the frame the server put on the wire.
 */
import './helpers/hermetic.js';

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { registerPrompts } from '../src/prompts/index.js';
import { installToolErrorBoundary } from '../src/tools/annotations.js';

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

/**
 * A server driven over raw JSON-RPC: `ask` returns the frame verbatim, so
 * `error.code` and `error.message` are the server's own.
 */
async function surface(build: (server: McpServer) => void): Promise<Ask> {
  const server = new McpServer({ name: 'argument-contract', version: '0.0.0' });
  build(server);

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
    // Watchdog only: a hang must fail the run rather than sit on it.
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15_000).unref();
    return await promise;
  };

  const init = await ask('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'argument-contract', version: '0.0.0' },
  });
  assert.equal(init.error, undefined, `initialize failed: ${JSON.stringify(init.error)}`);
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as never);

  closeHarness = async () => {
    await clientTransport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  };
  return ask;
}

/** The real prompt surface, boundary included: `registerPrompts` installs it. */
function promptSurface(): Promise<Ask> {
  return surface((server) => registerPrompts(server));
}

/** A tool surface with a described parameter and one without. */
function toolSurface(): Promise<Ask> {
  return surface((server) => {
    server.tool(
      'sort_playlist',
      'sort a playlist',
      { playlist_id: z.string().describe('Playlist ID, spotify:playlist: URI, or URL') },
      async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    );
    server.tool(
      'count_things',
      'count things',
      { count: z.number() },
      async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    );
    installToolErrorBoundary(server);
  });
}

/** The failure the caller sees, with the shape guarantees asserted once. */
async function refusal(ask: Ask, method: string, params: Record<string, unknown>): Promise<string> {
  const frame = await ask(method, params);
  assert.ok(frame.error, `${method} ${JSON.stringify(params)} must be refused, got: ${JSON.stringify(frame.result)?.slice(0, 200)}`);
  assert.equal(frame.error.code, -32602, `a bad argument is Invalid params (-32602), not ${frame.error.code}`);
  const message = frame.error.message;
  assert.ok(message.length > 0, 'a refusal must say something');
  assert.equal(message.includes('\n'), false, `a refusal must be one line: ${message}`);
  // The two shapes this contract exists to remove.
  assert.equal(message.startsWith('MCP error'), false, `the SDK error prefix reached the wire: ${message}`);
  assert.equal(message.includes('Invalid input:'), false, `raw zod wording reached the wire: ${message}`);
  assert.equal(message.includes('"code"'), false, `a raw zod issue array reached the wire: ${message}`);
  assert.equal(message.includes('Invalid arguments for prompt'), false, `the SDK's own wording reached the wire: ${message}`);
  return message;
}

function firstText(frame: JsonRpc): string {
  const messages = frame.result?.messages;
  assert.ok(Array.isArray(messages) && messages.length > 0, `expected a rendered prompt, got: ${JSON.stringify(frame)}`);
  const content = (messages[0] as { content?: { text?: unknown } }).content;
  assert.equal(typeof content?.text, 'string');
  return content.text as string;
}

describe('prompts/get rejects arguments the prompt does not declare (#689)', () => {
  it('refuses a misspelled argument and names the real one', async () => {
    const ask = await promptSurface();
    assert.equal(
      await refusal(ask, 'prompts/get', { name: 'music_taste_summary', arguments: { time_rang: 'week' } }),
      'music_taste_summary does not accept argument time_rang; remove it and use "time_range" instead',
    );
  });

  it('refuses a dropped argument instead of rendering a prompt from defaults', async () => {
    // The regression in one line. Before the boundary, `bogus_arg` was stripped
    // by the plain z.object() and this returned a complete, plausible
    // `music_taste_summary` — a silent answer to a question nobody asked.
    const ask = await promptSurface();
    const message = await refusal(ask, 'prompts/get', { name: 'music_taste_summary', arguments: { bogus_arg: 'x' } });
    assert.match(message, /does not accept argument bogus_arg/);
    assert.match(message, /prompts\/list/);
  });

  it('says so when the prompt declares no arguments at all', async () => {
    const ask = await promptSurface();
    assert.equal(
      await refusal(ask, 'prompts/get', { name: 'dj', arguments: { mood: 'chill' } }),
      'dj does not accept argument mood; remove it, dj takes no arguments',
    );
  });

  it('does not answer an unknown prompt name out of Object.prototype', async () => {
    const ask = await promptSurface();
    const message = await refusal(ask, 'prompts/get', { name: 'toString', arguments: {} });
    assert.match(message, /^Prompt toString is not an available prompt/);
  });
});

describe('prompts/get says what it expected (#689)', () => {
  it('names the prompt, the argument, the type, and the field description', async () => {
    const ask = await promptSurface();
    assert.equal(
      await refusal(ask, 'prompts/get', { name: 'playlist_audit', arguments: {} }),
      'playlist_audit rejected argument playlist: expected a string (Playlist name, ID, or URI)',
    );
  });

  it('lists every legal member when the argument is an enum', async () => {
    const ask = await promptSurface();
    assert.equal(
      await refusal(ask, 'prompts/get', { name: 'listening_recap', arguments: { time_range: 'weekly' } }),
      'listening_recap rejected argument time_range: expected one of "short_term", "medium_term", or "long_term"',
    );
  });

  it('quotes the bound when the argument is out of range', async () => {
    const ask = await promptSurface();
    const message = await refusal(ask, 'prompts/get', { name: 'discover_weekly_alternative', arguments: { size: '250' } });
    assert.match(message, /^discover_weekly_alternative rejected argument size: expected a value at most 50/);
    assert.match(message, /How many discovery picks to return/);
  });

  it('refuses a non-string argument value as invalid params, not an internal error', async () => {
    // MCP prompt arguments travel as strings. The SDK's request schema used to
    // enforce that with a `-32603` whose message was a zod issue array, thrown
    // before the boundary could answer it.
    const ask = await promptSurface();
    const message = await refusal(ask, 'prompts/get', { name: 'playlist_audit', arguments: { playlist: 42 } });
    assert.match(message, /^playlist_audit rejected argument playlist: expected a string/);
  });

  it('still refuses a bad enum member (#112)', async () => {
    const ask = await promptSurface();
    const message = await refusal(ask, 'prompts/get', { name: 'triage_liked_songs', arguments: { bucket_by: 'bogus' } });
    assert.match(message, /triage_liked_songs rejected argument bucket_by: expected one of "decade", "genre", or "artist"/);
  });
});

describe('the prompt boundary refuses only what is undeclared (#689)', () => {
  it('serves every well-formed call it used to serve', async () => {
    const ask = await promptSurface();
    const taste = await ask('prompts/get', { name: 'music_taste_summary', arguments: { time_range: 'long_term' } });
    assert.equal(taste.error, undefined, `a declared argument must be served: ${JSON.stringify(taste.error)}`);
    assert.match(firstText(taste), /long_term/);

    const noArgs = await ask('prompts/get', { name: 'dj', arguments: {} });
    assert.equal(noArgs.error, undefined, `a prompt that takes no arguments must be served: ${JSON.stringify(noArgs.error)}`);
    assert.match(firstText(noArgs), /Act as a DJ/);

    // Numeric prompt arguments are coerced from the protocol string, which is
    // what lets a host that can only express a scalar use them at all.
    const sized = await ask('prompts/get', { name: 'discover_weekly_alternative', arguments: { size: '25' } });
    assert.equal(sized.error, undefined, `a coerced numeric argument must be served: ${JSON.stringify(sized.error)}`);
    assert.match(firstText(sized), /\b25\b/);

    const defaulted = await ask('prompts/get', { name: 'music_taste_summary', arguments: {} });
    assert.equal(defaulted.error, undefined, `defaults must still apply: ${JSON.stringify(defaulted.error)}`);
  });

  it('leaves prompts/list advertising every declared argument', async () => {
    const ask = await promptSurface();
    const listed = await ask('prompts/list');
    assert.equal(listed.error, undefined);
    const prompts = listed.result?.prompts as Array<{ name: string; arguments?: Array<{ name: string; required?: boolean }> }>;
    const recap = prompts.find((p) => p.name === 'listening_recap');
    assert.ok(recap, 'listening_recap must still be advertised');
    assert.deepEqual(recap.arguments?.map((a) => a.name), ['time_range', 'size']);
  });
});

describe('the tool boundary says what it expected too (#689)', () => {
  it('names the parameter, the type, and the description the schema advertises', async () => {
    const ask = await toolSurface();
    const frame = await ask('tools/call', { name: 'sort_playlist', arguments: {} });
    assert.equal(frame.result?.isError, true, `a missing required parameter must be refused: ${JSON.stringify(frame)}`);
    const content = frame.result?.content as Array<{ text?: string }>;
    assert.equal(
      content[0]?.text,
      'sort_playlist rejected parameter playlist_id: expected a string (Playlist ID, spotify:playlist: URI, or URL)',
    );
  });

  it('drops the parenthetical when the field carries no description', async () => {
    // Nothing to add, so nothing is added. A message that named a constraint
    // the schema does not enforce is #803 in prose.
    const ask = await toolSurface();
    const frame = await ask('tools/call', { name: 'count_things', arguments: {} });
    const content = frame.result?.content as Array<{ text?: string }>;
    assert.equal(content[0]?.text, 'count_things rejected parameter count: expected a number');
  });

  it('still refuses an unknown parameter before the handler runs', async () => {
    const ask = await toolSurface();
    const frame = await ask('tools/call', { name: 'sort_playlist', arguments: { playlist_id: 'p', playlist: 'p' } });
    const content = frame.result?.content as Array<{ text?: string }>;
    assert.equal(
      content[0]?.text,
      'sort_playlist does not accept parameter playlist; remove it and use "playlist_id" instead.',
    );
  });
});
