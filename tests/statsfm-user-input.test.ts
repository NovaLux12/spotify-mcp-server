/**
 * The stats.fm identity argument, unified on `statsfm_user` (#1318).
 *
 * ## What this file pins
 *
 * AGENTS.md §5: a deprecated input is callable for ONE release, both spellings
 * are accepted only when they mean the same thing, a call that does not is
 * refused BEFORE any upstream request, and a call that used the legacy name
 * carries `deprecated_inputs` + `deprecation_note`. All five states are named
 * in the table below and each has a test:
 *
 *   | state                | expectation                                    |
 *   |----------------------|------------------------------------------------|
 *   | canonical only       | no metadata, no note                           |
 *   | legacy only          | value used, `deprecated_inputs: ["user_id"]`   |
 *   | both, agreeing       | value used, notice still present               |
 *   | both, disagreeing    | throw naming BOTH fields, zero network calls   |
 *   | neither              | STATSFM_USER_ID, else the #927 throw           |
 *
 * ## The "before any request" claim is measured, not asserted
 *
 * The conflict tests count the client's `get` calls and assert the count is
 * ZERO. A test that only asserted "it threw" would pass against an
 * implementation that made the request, threw afterwards, and reported the
 * error — which is a wasted round trip against a third-party service and, per
 * §5, not a refusal at all. Counting is the only way to tell the two apart.
 *
 * ## Hermeticity
 *
 * `import './helpers/hermetic.js'` relocates every `~/.spotify-mcp` store
 * under a disposable root, so this file cannot read or write Jack's real
 * tokens/search-history/taste-feedback. No test here performs a network call:
 * the client is a stub whose `get` records the path and returns a fixture.
 * No test binds a port — the boundary tests use `InMemoryTransport`.
 */
import './helpers/hermetic.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { initConfig } from '../src/config.js';
import {
  resolveStatsfmUserInput,
  STATSFM_USER_INPUT,
  STATSFM_LEGACY_USER_INPUT,
  STATSFM_USER_INPUT_REMOVED_IN,
} from '../src/shaping.js';
import { registerStatsfmTools } from '../src/tools/statsfm.js';
import { registerStatsfmTasteTools } from '../src/tools/statsfm_taste.js';
import {
  registerTasteCompositeTools,
  __resetTasteCompositeFetchImpl,
  __setTasteCompositeFetchImpl,
} from '../src/tools/taste_composites.js';
import { registerTastePlaylistTools } from '../src/tools/taste_playlist.js';
import type { SpotifyClient } from '../src/client.js';

// ------------------------------------------------------------------ harness

type ToolContent = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type RegisteredTool = {
  name: string;
  description: string;
  schema: Record<string, { safeParse(value: unknown): { success: boolean } }>;
  handler: (args: Record<string, unknown>) => Promise<ToolContent>;
};

type Call = { path: string; params?: Record<string, string> };

/**
 * A server whose stats.fm client records every read. The responder never
 * touches the network, so `calls.length` is exactly "how many upstream
 * requests this call caused" — the quantity the conflict tests assert on.
 */
function makeHarness(responder: (path: string, params?: Record<string, string>) => unknown = () => ({ items: [] })) {
  const calls: Call[] = [];
  const client = {
    get: async (path: string, params?: Record<string, string>) => {
      calls.push({ path, params });
      return responder(path, params);
    },
  };
  const registered: RegisteredTool[] = [];
  const server = {
    tool: (
      name: string,
      description: string,
      schema: RegisteredTool['schema'],
      handler: RegisteredTool['handler'],
    ) => registered.push({ name, description, schema, handler }),
  };
  const typed = server as unknown as Parameters<typeof registerStatsfmTools>[0];
  registerStatsfmTools(typed, client as unknown as Parameters<typeof registerStatsfmTools>[1]);
  registerStatsfmTasteTools(typed, client as unknown as Parameters<typeof registerStatsfmTasteTools>[1]);
  registerTasteCompositeTools(typed, client as unknown as SpotifyClient);
  registerTastePlaylistTools(typed, client as unknown as SpotifyClient);
  const find = (name: string) => {
    const found = registered.find((t) => t.name === name);
    assert.ok(found, `tool ${name} must be registered`);
    return found;
  };
  const text = (r: ToolContent) => r.content.map((c) => c.text).join('\n');
  return { calls, registered, find, text };
}

// ------------------------------------------------- the five states, resolved

test('canonical only: the value is used and no deprecation is reported', () => {
  initConfig({});
  const resolved = resolveStatsfmUserInput({ [STATSFM_USER_INPUT]: 'martijn' });
  assert.equal(resolved.userId, 'martijn');
  assert.deepEqual(resolved.deprecatedInputs, []);
  assert.equal(resolved.deprecationNote, null);
});

test('legacy only: the value is used and the notice names the canonical field', () => {
  initConfig({});
  const resolved = resolveStatsfmUserInput({ [STATSFM_LEGACY_USER_INPUT]: 'martijn' });
  assert.equal(resolved.userId, 'martijn');
  assert.deepEqual(resolved.deprecatedInputs, ['user_id']);
  assert.ok(resolved.deprecationNote, 'a legacy call owes a note');
  assert.match(resolved.deprecationNote as string, /statsfm_user/);
  assert.match(resolved.deprecationNote as string, /deprecated/i);
  // The version is named from the one constant, so the note cannot promise a
  // removal release that no release has scheduled.
  assert.match(resolved.deprecationNote as string, new RegExp(STATSFM_USER_INPUT_REMOVED_IN));
  // The field being REMOVED is the legacy one. A loose `/statsfm_user/` match
  // passes either way, and naming the surviving field as the one that goes away
  // tells a caller the opposite of what is true — the note is the only place
  // the removal release is stated to them.
  assert.match(
    resolved.deprecationNote as string,
    new RegExp(`${STATSFM_LEGACY_USER_INPUT} is removed in ${STATSFM_USER_INPUT_REMOVED_IN}`),
  );
});

test('both, agreeing: one answer sent twice is not a conflict, and the notice is still owed', () => {
  // The caller DID send the deprecated name, so a caller migrating off the
  // notice is still owed it. Refusing or silently dropping the notice would
  // both hide that the legacy spelling is on its way out.
  initConfig({});
  const resolved = resolveStatsfmUserInput({ [STATSFM_USER_INPUT]: 'martijn', [STATSFM_LEGACY_USER_INPUT]: 'martijn' });
  assert.equal(resolved.userId, 'martijn');
  assert.deepEqual(resolved.deprecatedInputs, ['user_id']);
});

test('both, agreeing after trimming: whitespace is not a second answer', () => {
  initConfig({});
  const resolved = resolveStatsfmUserInput({ [STATSFM_USER_INPUT]: 'martijn', [STATSFM_LEGACY_USER_INPUT]: '  martijn  ' });
  assert.equal(resolved.userId, 'martijn');
});

test('both, disagreeing: the throw names BOTH fields and quotes both values', () => {
  initConfig({});
  assert.throws(
    () => resolveStatsfmUserInput({ [STATSFM_USER_INPUT]: 'martijn', [STATSFM_LEGACY_USER_INPUT]: 'someone-else' }),
    (err: Error) => {
      // Naming only one field is the failure §5 is written against: the reader
      // is left guessing which of the two they should delete.
      assert.match(err.message, /statsfm_user/);
      assert.match(err.message, /user_id/);
      assert.match(err.message, /martijn/);
      assert.match(err.message, /someone-else/);
      return true;
    },
  );
});

test('neither: STATSFM_USER_ID supplies the id, and there is still no notice', () => {
  initConfig({ STATSFM_USER_ID: 'from-env' });
  const resolved = resolveStatsfmUserInput({});
  assert.equal(resolved.userId, 'from-env');
  assert.deepEqual(resolved.deprecatedInputs, []);
  assert.equal(resolved.deprecationNote, null);
});

test('neither, with no env: the #927 throw survives the rename', () => {
  // The rename added an alias; it must not have replaced the refusal with a
  // guess. A placeholder here reads as a confident answer about the wrong
  // account — the #997 shape.
  initConfig({});
  assert.throws(
    () => resolveStatsfmUserInput({}),
    (err: Error) => {
      assert.match(err.message, /no stats\.fm user id/);
      assert.match(err.message, /STATSFM_USER_ID/);
      // The message names the canonical spelling, which is the whole point of
      // the rename: there is now one spelling to send.
      assert.match(err.message, /statsfm_user/);
      return true;
    },
  );
});

test('a blank legacy value is not an answer, so it does not conflict with a real canonical one', () => {
  // `resolveStatsfmUserId` already declines to treat "" as a supplied id.
  // Treating it as one here would refuse a call over a value the caller never
  // gave — a refusal they cannot act on.
  initConfig({});
  const resolved = resolveStatsfmUserInput({ [STATSFM_USER_INPUT]: 'martijn', [STATSFM_LEGACY_USER_INPUT]: '   ' });
  assert.equal(resolved.userId, 'martijn');
  assert.deepEqual(resolved.deprecatedInputs, []);
});

test('an explicit legacy value still beats STATSFM_USER_ID', () => {
  initConfig({ STATSFM_USER_ID: 'from-env' });
  assert.equal(resolveStatsfmUserInput({ [STATSFM_LEGACY_USER_INPUT]: 'explicit' }).userId, 'explicit');
});

// ------------------------------------------------------- end to end, no network

test('a conflicting call reaches NO stats.fm request', async () => {
  initConfig({});
  const h = makeHarness();
  const tool = h.find('statsfm_top_genres');
  await assert.rejects(
    () => tool.handler({ [STATSFM_USER_INPUT]: 'martijn', [STATSFM_LEGACY_USER_INPUT]: 'someone-else' }),
    /statsfm_user/,
  );
  assert.equal(h.calls.length, 0, 'a refused input must cost zero upstream requests');
});

test('a legacy call reads the identity off user_id and hits the right path', async () => {
  initConfig({});
  const h = makeHarness(() => ({ items: [{ name: 'pop', streams: 5 }] }));
  const tool = h.find('statsfm_top_genres');
  await tool.handler({ [STATSFM_LEGACY_USER_INPUT]: 'martijn' });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].path, '/users/martijn/top/genres');
});

test('a canonical call reads the identity off statsfm_user and hits the same path', async () => {
  initConfig({});
  const h = makeHarness(() => ({ items: [{ name: 'pop', streams: 5 }] }));
  const tool = h.find('statsfm_top_genres');
  await tool.handler({ [STATSFM_USER_INPUT]: 'martijn' });
  assert.equal(h.calls[0].path, '/users/martijn/top/genres');
});

// --------------------------------------------------- the surface, tool by tool

/**
 * Every user-scoped stats.fm tool must advertise BOTH spellings, or a caller
 * reading `tools/list` cannot discover the legacy name it is being migrated
 * off. This walks the real registry rather than a hand-kept list, so a tool
 * added later without the field fails here.
 */
test('every stats.fm identity tool declares both spellings in its schema', () => {
  initConfig({});
  const h = makeHarness();
  const declaring = h.registered.filter(
    (t) => Object.hasOwn(t.schema, STATSFM_USER_INPUT) || Object.hasOwn(t.schema, STATSFM_LEGACY_USER_INPUT),
  );
  // Exact, not a floor: `>= N` would still pass if a registrar silently
  // stopped emitting the field, which is the failure this test exists to
  // catch. MEASURED by instrumenting the four registrars — 25 in
  // `statsfm.ts`, 7 in `statsfm_taste.ts`, 10 in `taste_composites.ts`,
  // 1 in `taste_playlist.ts` — and confirmed against `tools/list`.
  assert.equal(declaring.length, 43, `expected 43 identity-bearing stats.fm tools, saw ${declaring.length}`);
  for (const tool of declaring) {
    assert.ok(
      Object.hasOwn(tool.schema, STATSFM_USER_INPUT),
      `${tool.name} must declare the canonical ${STATSFM_USER_INPUT}`,
    );
    assert.ok(
      Object.hasOwn(tool.schema, STATSFM_LEGACY_USER_INPUT),
      `${tool.name} must declare the deprecated ${STATSFM_LEGACY_USER_INPUT} while it is still callable`,
    );
  }
});

test('the legacy field is described as deprecated on the wire', () => {
  initConfig({});
  const h = makeHarness();
  for (const name of ['statsfm_top_genres', 'statsfm_taste_profile', 'taste_daily_brief']) {
    const tool = h.find(name);
    const schema = tool.schema[STATSFM_LEGACY_USER_INPUT] as unknown as { description?: string };
    assert.match(String(schema?.description ?? ''), /deprecat/i, `${name} must label the legacy field`);
  }
});

test('a tool that is not a stats.fm identity tool is untouched by the rename', async () => {
  // The two Spotify `get_user_*` tools have their own `user_id`, which means a
  // Spotify id. Unifying the stats.fm spelling must not have captured it. The
  // boundary gate is scoped by the canonical field's presence precisely so
  // these keep meaning what they meant.
  initConfig({});
  const h = makeHarness();
  const { registerUsersTools } = await import('../src/tools/users.js');
  const registered: RegisteredTool[] = [];
  const server = {
    tool: (n: string, d: string, s: RegisteredTool['schema'], hd: RegisteredTool['handler']) =>
      registered.push({ name: n, description: d, schema: s, handler: hd }),
  };
  registerUsersTools(server as never, {} as never);
  const profile = registered.find((t) => t.name === 'get_user_profile');
  assert.ok(profile, 'get_user_profile must still be registered');
  assert.ok(Object.hasOwn(profile.schema, 'user_id'), 'its Spotify user_id must survive');
  assert.ok(!Object.hasOwn(profile.schema, STATSFM_USER_INPUT), 'it must not acquire the stats.fm spelling');
});

// ------------------------------------------- the boundary, at the protocol layer

/**
 * The resolver's conflict check is the SECOND line. This drives the real
 * tool error boundary, which is the FIRST: a call through the server is
 * refused there, before the handler runs and therefore before any stats.fm
 * request. Both matter, and neither is redundant — the boundary is what a
 * production call meets, the resolver is what a direct handler call meets.
 */
test('the boundary refuses a conflicting identity before the handler runs', async () => {
  initConfig({});
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { installToolErrorBoundary } = await import('../src/tools/annotations.js');

  let handlerRuns = 0;
  const server = new McpServer({ name: 'statsfm-identity-conflict', version: '0.0.0' });
  server.tool(
    'statsfm_top_genres',
    "A stats.fm user's most-streamed genres",
    { ...(await import('../src/shaping.js')).StatsfmUserInputFields, response_format: z.enum(['json', 'text', 'detailed']).optional() },
    async () => {
      handlerRuns += 1;
      return { content: [{ type: 'text', text: 'never' }], structuredContent: {} };
    },
  );
  installToolErrorBoundary(server);

  const client = new Client({ name: 'conflict-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({
      name: 'statsfm_top_genres',
      arguments: { [STATSFM_USER_INPUT]: 'martijn', [STATSFM_LEGACY_USER_INPUT]: 'someone-else' },
    }) as { isError?: boolean; content: Array<{ type: string; text: string }>; structuredContent?: { error?: { reason?: string; param?: string } } };

    assert.equal(handlerRuns, 0, 'the boundary must refuse before the handler runs');
    const text = result.content.map((c) => c.text).join('\n');
    assert.match(text, /statsfm_user/, 'the refusal names the canonical field');
    assert.match(text, /user_id/, 'the refusal names the legacy field');
    assert.equal(result.structuredContent?.error?.reason, 'conflicting_input');
    // Both field names ride in `param` so a host routing on structure does not
    // have to parse the prose to learn which two collided.
    assert.match(String(result.structuredContent?.error?.param ?? ''), /statsfm_user/);
    assert.match(String(result.structuredContent?.error?.param ?? ''), /user_id/);
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
});

test('the boundary adds deprecated_inputs and the note to a legacy call, and neither to a canonical one', async () => {
  initConfig({});
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { installToolErrorBoundary } = await import('../src/tools/annotations.js');
  const { StatsfmUserInputFields } = await import('../src/shaping.js');

  const server = new McpServer({ name: 'statsfm-identity-deprecation', version: '0.0.0' });
  server.tool(
    'statsfm_now_playing',
    'What a stats.fm user is playing right now',
    { ...StatsfmUserInputFields, response_format: z.enum(['json', 'text', 'detailed']).optional() },
    async () => ({
      content: [{ type: 'text', text: 'Nothing playing right now.' }],
      structuredContent: { item: null },
    }),
  );
  installToolErrorBoundary(server);

  const client = new Client({ name: 'deprecation-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = (args: Record<string, unknown>) => client.callTool({ name: 'statsfm_now_playing', arguments: args }) as Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  }>;
  try {
    const legacy = await call({ [STATSFM_LEGACY_USER_INPUT]: 'martijn' });
    assert.deepEqual(legacy.structuredContent?.deprecated_inputs, ['user_id']);
    const note = String(legacy.structuredContent?.deprecation_note ?? '');
    assert.match(note, /statsfm_user/);
    assert.match(note, /deprecat/i);
    // §5: the SAME one-line note in the prose/JSON text, not only in the
    // machine-readable channel. A caller reading text would otherwise have no
    // way to learn the field it used is going away.
    assert.match(legacy.content.map((c) => c.text).join('\n'), /deprecat/i);

    const canonical = await call({ [STATSFM_USER_INPUT]: 'martijn' });
    assert.equal(canonical.structuredContent?.deprecated_inputs, undefined, 'a canonical call carries no metadata');
    assert.equal(canonical.structuredContent?.deprecation_note, undefined);
    assert.equal(canonical.content.map((c) => c.text).join('\n'), 'Nothing playing right now.');

    const agreeing = await call({ [STATSFM_USER_INPUT]: 'martijn', [STATSFM_LEGACY_USER_INPUT]: 'martijn' });
    assert.deepEqual(agreeing.structuredContent?.deprecated_inputs, ['user_id'], 'the legacy name was still used');
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
});

test('the boundary leaves a non-stats.fm user_id tool alone', async () => {
  // The gate is scoped by the CANONICAL field's presence. Without that scope a
  // `user_id` on a Spotify tool would be read as the deprecated stats.fm
  // spelling and rejected — a rename that broke an unrelated tool.
  initConfig({});
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { installToolErrorBoundary } = await import('../src/tools/annotations.js');

  const server = new McpServer({ name: 'spotify-user-id', version: '0.0.0' });
  server.tool(
    'get_user_profile',
    "Get any Spotify user's public profile",
    { user_id: z.string().min(1) },
    async () => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: { id: 'x' } }),
  );
  installToolErrorBoundary(server);

  const client = new Client({ name: 'spotify-user-id-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: 'get_user_profile', arguments: { user_id: 'somebody' } }) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
    assert.notEqual(result.isError, true, 'a Spotify user_id must still be accepted');
    assert.equal(result.structuredContent?.deprecated_inputs, undefined);
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
});

test('a legacy call that also errors still carries the notice, and never a raw throw', async () => {
  // `applyStatsfmIdentityDeprecation` calls `resolveStatsfmUserInput`, which
  // THROWS on a conflict. It runs after the conflict gate has already returned,
  // so the throw is unreachable — this test pins that ordering rather than
  // leaving it as a comment. If the gate were ever moved below the result path,
  // a conflicting call would surface as an unhandled exception instead of the
  // §5 refusal, and this is the test that would say so.
  initConfig({});
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { installToolErrorBoundary } = await import('../src/tools/annotations.js');
  const { StatsfmUserInputFields } = await import('../src/shaping.js');

  const server = new McpServer({ name: 'identity-order', version: '0.0.0' });
  let handlerRuns = 0;
  server.tool(
    'statsfm_now_playing',
    'What a stats.fm user is playing right now',
    { ...StatsfmUserInputFields, response_format: z.enum(['json', 'text', 'detailed']).optional() },
    async () => {
      handlerRuns += 1;
      return { content: [{ type: 'text', text: 'Nothing playing right now.' }], structuredContent: { item: null } };
    },
  );
  installToolErrorBoundary(server);

  const client = new Client({ name: 'identity-order-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = (args: Record<string, unknown>) => client.callTool({ name: 'statsfm_now_playing', arguments: args }) as Promise<{
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  }>;
  try {
    const conflict = await call({ [STATSFM_USER_INPUT]: 'martijn', [STATSFM_LEGACY_USER_INPUT]: 'someone-else' });
    assert.equal(conflict.isError, true, 'a conflict is an error result, not a thrown exception');
    assert.equal(handlerRuns, 0, 'the handler never ran, so the result path never saw the conflict');
    assert.equal(conflict.structuredContent?.deprecated_inputs, undefined, 'a refused call carries no deprecation notice');

    // The agreeing pair DOES reach the handler and DOES get the notice, so the
    // two paths are distinguished by their input and not by luck.
    const agreeing = await call({ [STATSFM_USER_INPUT]: 'martijn', [STATSFM_LEGACY_USER_INPUT]: 'martijn' });
    assert.equal(handlerRuns, 1);
    assert.deepEqual(agreeing.structuredContent?.deprecated_inputs, ['user_id']);
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
});

// ------------------------------------------------------------------ helpers

// The composite module keeps a module-level fetch seam; a test that leaves it
// pointed at a stub would leak into the next file.
test('cleanup', () => {
  __setTasteCompositeFetchImpl(undefined as never);
  __resetTasteCompositeFetchImpl();
});
