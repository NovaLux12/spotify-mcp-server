/**
 * The dispatcher and the runtime toolset activation (#1601).
 *
 * This is the acceptance criterion itself, not a proxy for it: a real `Client`
 * over a real `InMemoryTransport`, against a server built the way production
 * builds one — the same `installToolErrorBoundary` boundary, the same swarm3
 * meta registrar. `tests/tools.discovery.test.ts` drives the registry readers
 * with a stub `server` object, which is the right shape for testing what the
 * discovery trio READS; it cannot exercise a dispatch, because a dispatch has
 * to arrive as a JSON-RPC request and leave as a JSON-RPC result.
 *
 * The two criteria this closes:
 *
 *  - #578: "the dispatcher path is proven end-to-end in a host-shaped
 *    integration test (core 40 tools → find → call)". The `find_tool` →
 *    `call_tool` case below is that test, and it calls a tool it did not name in
 *    the source.
 *  - #566: "a host can start with ≤40 tools, discover and enable a toolset at
 *    runtime, and receive a `list_changed` notification". The activation case
 *    asserts the notification arrives on a client that connected to a server
 *    whose tool list was shorter.
 *
 * Run: node --import tsx --test tests/tools.dispatcher.test.ts
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
  REGISTRAR_MANIFEST,
  applyToolAnnotations,
  installToolErrorBoundary,
  registerManifestModules,
} from '../src/tools/annotations.js';
import { registerSwarm3MetaTools } from '../src/tools/swarm3_meta.js';
import type { SpotifyClient } from '../src/client.js';

/** A client stub that never reaches Spotify: no tool here calls out. */
function clientStub(): SpotifyClient {
  return {
    get: async () => null,
    post: async () => null,
    put: async () => null,
    delete: async () => null,
    getAllPages: async () => [],
  } as unknown as SpotifyClient;
}

interface Handles {
  readonly server: McpServer;
  readonly client: Client;
  /** Every `notifications/tools/list_changed` the client received. */
  readonly listChanged: () => number;
  close: () => Promise<void>;
}

/**
 * Build one server the way production does, plus a real client against it.
 *
 * `extraTools` are registered BEFORE the boundary on purpose. That is the
 * production order in `src/server.ts` — every module registers, then
 * `installToolErrorBoundary` replaces the two request handlers — so a test that
 * registered them afterwards would be exercising an order no host sees.
 */
async function connect(options: { extraTools?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<Handles> {
  const previous = { ...options.env };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const server = new McpServer({ name: 'dispatcher-test', version: '0.0.0' });
  server.tool(
    'echo_reading',
    'A read-shaped tool used to prove dispatch reaches a registered handler.',
    { value: z.number().int().optional().describe('Echoed back') },
    async (args) => ({
      content: [{ type: 'text' as const, text: `echo ${args.value ?? 0}` }],
      structuredContent: { kind: 'echo_reading', value: args.value ?? 0 },
    }),
  );
  server.tool(
    'echo_writing',
    'A write-shaped tool used to prove dispatch reaches a registered handler.',
    { value: z.number().int().optional().describe('Echoed back') },
    async (args) => ({
      content: [{ type: 'text' as const, text: `wrote ${args.value ?? 0}` }],
      structuredContent: { kind: 'echo_writing', value: args.value ?? 0 },
    }),
  );
  // The discovery module is registered THROUGH THE MANIFEST, not by calling its
  // registrar directly, because `activateRegistrationKeys` decides "already
  // active" from the module-ownership metadata that only `registerManifestModule`
  // writes. A server that calls the registrar directly has no such metadata, so
  // every activation would look like a first one — the test would pass for a
  // reason that does not hold in production.
  await registerManifestModules(
    server,
    clientStub(),
    {
      readOnly: false,
      isModuleActive: () => true,
      disableOverrides: new Set<string>(),
      scopeBlocked: () => false,
    },
    REGISTRAR_MANIFEST.filter((module) => module.key === 'swarm3meta'),
  );
  if (options.extraTools !== false) {
    // The production order, from `src/server.ts`: modules register, then the
    // annotations are applied, then the boundary is installed. Skipping the
    // annotation pass would test a server that annotates nothing, and the
    // `call_tool` hint assertion below would pass for the wrong reason.
    applyToolAnnotations(server);
    installToolErrorBoundary(server);
  }

  let notifications = 0;
  const client = new Client({ name: 'dispatcher-test-client', version: '0.0.0' });
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { notifications += 1; });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    server,
    client,
    listChanged: () => notifications,
    close: async () => {
      await client.close();
      await server.close();
      for (const key of Object.keys(options.env ?? {})) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    },
  };
}

interface ListedTool {
  name: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

async function listTools(client: Client): Promise<ListedTool[]> {
  // The SDK's own `listTools`, so this reads the list a host reads — including
  // the annotations the production `applyToolAnnotations` pass stamped.
  const listed = await client.listTools();
  return listed.tools as ListedTool[];
}

interface CallOutcome {
  readonly isError?: boolean;
  readonly content: Array<{ type: string; text?: string }>;
  readonly structuredContent?: Record<string, unknown>;
}

/**
 * The structured error envelope `errorResult` builds: `{ error: { tool, kind,
 * reason, fix } }`. Nested, not flat — which is the whole reason these
 * assertions read `.error.kind` rather than `.kind`.
 */
function envelope(result: CallOutcome): { tool?: string; kind?: string; reason?: string; param?: string; fix?: string } {
  const error = result.structuredContent?.error;
  return (error ?? {}) as { tool?: string; kind?: string; reason?: string; param?: string; fix?: string };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<CallOutcome> {
  return (await client.callTool({ name, arguments: args })) as CallOutcome;
}

describe('#1601 — call_tool dispatches through the same boundary', () => {
  it('calls a registered tool by name and returns its own result', async () => {
    const h = await connect();
    try {
      const result = await call(h.client, 'call_tool', { name: 'echo_reading', arguments: { value: 7 } });
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent?.value, 7, 'the inner result must come back verbatim, not wrapped');
      assert.equal(result.structuredContent?.kind, 'echo_reading');
      assert.equal(result.content[0]?.text, 'echo 7');
    } finally {
      await h.close();
    }
  });

  it('reaches a write-capable tool, because the dispatcher is not a read path', async () => {
    const h = await connect();
    try {
      const result = await call(h.client, 'call_tool', { name: 'echo_writing', arguments: { value: 3 } });
      assert.equal(result.structuredContent?.kind, 'echo_writing');
      assert.match(String(result.content[0]?.text), /^wrote 3$/);
    } finally {
      await h.close();
    }
  });

  it('refuses to call itself, rather than recursing', async () => {
    const h = await connect();
    try {
      const result = await call(h.client, 'call_tool', { name: 'call_tool', arguments: {} });
      assert.equal(result.structuredContent?.error, 'self_dispatch_refused');
      assert.match(String(result.content[0]?.text), /cannot call itself/);
    } finally {
      await h.close();
    }
  });

  it('refuses a name that is not registered, and names the near-matches', async () => {
    const h = await connect();
    try {
      // `library_hygiene` is a real tool in an inactive module — the exact case
      // the curated default surface leaves unreachable.
      const result = await call(h.client, 'call_tool', { name: 'library_hygiene' });
      assert.equal(envelope(result).kind, 'unknown_tool');
      const text = String(result.content[0]?.text);
      assert.match(text, /is not an available tool/i, `the refusal must say what happened:\n${text}`);
    } finally {
      await h.close();
    }
  });

  it('a validation failure is the dispatcher\'s target schema failing, not a wrapper\'s', async () => {
    const h = await connect();
    try {
      const result = await call(h.client, 'call_tool', {
        name: 'echo_reading',
        arguments: { value: 'not a number' },
      });
      // The refusal envelope is the inner tool's own, not a wrapper's: the
      // `tool` field names what refused, and the `param` field names the
      // argument. A dispatcher that pre-validated against its own schema would
      // report neither.
      assert.equal(envelope(result).kind, 'validation');
      assert.equal(envelope(result).reason, 'validation_failed');
      assert.equal(envelope(result).tool, 'echo_reading', 'the refusal must name the inner tool');
      assert.equal(envelope(result).param, 'value', 'the refusal must name the inner parameter');
    } finally {
      await h.close();
    }
  });
});

describe('#578 — core → find → call, over a real client', () => {
  it('find_tool a tool the test never names, then call it', async () => {
    const h = await connect();
    try {
      const found = await call(h.client, 'find_tool', { query: 'echo' });
      const tools = (found.structuredContent?.tools as Array<{ name: string }>).map((t) => t.name);
      assert.deepEqual(tools, ['echo_reading', 'echo_writing'], `found: ${tools.join(', ')}`);

      // The name below is derived from what the registry actually reported, so
      // this fails if `find_tool` stops reading the live registry — which is the
      // original #A0-004 defect returning.
      const target = tools.find((name) => name === 'echo_reading');
      assert.ok(target, 'find_tool must report a tool that is really registered');
      const called = await call(h.client, 'call_tool', { name: target, arguments: { value: 11 } });
      assert.equal(called.structuredContent?.value, 11);
    } finally {
      await h.close();
    }
  });
});

describe('#1601 — call_tool cannot reach what the session did not register', () => {
  it('is annotated as a write, because the verb says nothing about it', async () => {
    const h = await connect();
    try {
      // `call` is in neither READ_ONLY_PREFIXES nor MUTATING_PREFIXES, so
      // name-driven classification would return `destructiveHint: false` — the
      // hint a host reads as "safe to auto-approve" for a tool that can reach
      // `delete_playlist`.
      const tools = await listTools(h.client);
      const callTool = tools.find((t) => t.name === 'call_tool');
      assert.ok(callTool, 'call_tool must be on the default surface');
      assert.equal(callTool.annotations?.destructiveHint, true, 'a dispatcher must not be advertised read-safe');
      assert.notEqual(callTool.annotations?.readOnlyHint, true);
    } finally {
      await h.close();
    }
  });

  it('a tool the registry never held stays unreachable through the dispatcher', async () => {
    const h = await connect();
    try {
      const before = (await listTools(h.client)).length;
      const refused = await call(h.client, 'call_tool', { name: 'statsfm_recent_streams' });
      assert.equal(envelope(refused).kind, 'unknown_tool');
      const after = (await listTools(h.client)).length;
      assert.equal(before, after, 'a refused dispatch must not change the surface');
    } finally {
      await h.close();
    }
  });
});

describe('#1601 — the dispatcher is the same boundary, not a lookalike', () => {
  it('a retired tool name is refused identically through tools/call and through call_tool', async () => {
    const h = await connect();
    try {
      // `handoff` is one of the ten names v3.0 retired (#848). It is not in the
      // registry, so the refusal has to come from the dispatcher's own
      // retired-forward table — which only the shared `dispatchToolCall` holds.
      const viaWire = await call(h.client, 'handoff', {});
      const viaDispatcher = await call(h.client, 'call_tool', { name: 'handoff', arguments: {} });

      assert.equal(envelope(viaWire).kind, envelope(viaDispatcher).kind, 'the same kind of refusal');
      assert.equal(envelope(viaWire).reason, envelope(viaDispatcher).reason, 'the same reason');
      assert.equal(
        viaWire.content[0]?.text,
        viaDispatcher.content[0]?.text,
        'the same sentence — a dispatcher that re-implemented the refusal would word it differently',
      );
      assert.match(String(viaDispatcher.content[0]?.text), /transfer_playback/, 'the migration note must survive');
    } finally {
      await h.close();
    }
  });

  it('the deprecated-input fold is shared, not re-implemented', async () => {
    const h = await connect();
    try {
      // The boundary folds a legacy spelling into its canonical name BEFORE
      // validation and stamps `deprecated_inputs` on the result. That stamp is
      // the observable half of the fold, so asserting it through the dispatcher
      // is what proves the fold is shared rather than re-derived.
      const result = await call(h.client, 'call_tool', { name: 'echo_reading', arguments: {} });
      // `echo_reading` declares no deprecated input, so this is the negative
      // control: no fold happened, and the payload must say so.
      assert.equal(result.structuredContent?.deprecated_inputs, undefined);
      assert.equal(result.structuredContent?.deprecation_note, undefined);
    } finally {
      await h.close();
    }
  });
});

describe('#566 — enable a toolset at runtime and receive list_changed', () => {
  it('registers an inactive module into the live session and notifies once', async () => {
    const h = await connect();
    try {
      const before = (await listTools(h.client)).map((t) => t.name);
      assert.ok(!before.includes('statsfm_recent_streams'), 'the statsfm family must start inactive');

      const notificationsBefore = h.listChanged();
      const activated = await call(h.client, 'enable_toolset', { sets: ['statsfm'] });
      assert.equal(activated.structuredContent?.ok, true, String(activated.content[0]?.text));
      const added = activated.structuredContent?.added_tools as string[];
      assert.ok(added.length > 0, 'activation must register tools');
      assert.ok(added.includes('statsfm_recent_streams'), 'the statsfm family must be the module that registered');
      assert.equal(activated.structuredContent?.list_changed_sent, true);

      // The criterion's own words: the notification must reach a client that
      // connected to a shorter list. Asserted on the count the handler saw, not
      // on a flag the server set.
      assert.equal(
        h.listChanged() - notificationsBefore,
        1,
        'exactly one notification for one change, no partial frames — the SDK emits one per registerTool and a 30-tool activation must not send 30',
      );

      const after = (await listTools(h.client)).map((t) => t.name);
      for (const name of added) assert.ok(after.includes(name), `${name} must be listed after activation`);

      // The activated tool is now reachable through the dispatcher, which is
      // the whole point of the pair: discovery, activation, then call.
      const streamed = await call(h.client, 'call_tool', { name: 'statsfm_recent_streams' });
      assert.notEqual(streamed.structuredContent?.error, 'unknown_tool', 'an activated tool must dispatch');
    } finally {
      await h.close();
    }
  });

  it('an already-active set activates nothing and notifies nobody', async () => {
    const h = await connect();
    try {
      // `swarm3meta` is alwaysActive, so it is active on every surface.
      const notificationsBefore = h.listChanged();
      const result = await call(h.client, 'enable_toolset', { sets: ['discovery'] });
      assert.equal(result.structuredContent?.list_changed_sent, false);
      assert.equal(h.listChanged() - notificationsBefore, 0, 'no change means no notification');
      assert.ok(
        ((result.structuredContent?.already_active as string[]) ?? []).includes('swarm3meta'),
        'the already-active row must be reported, not silently dropped',
      );
    } finally {
      await h.close();
    }
  });

  it('an unknown toolset is refused and activates nothing', async () => {
    const h = await connect();
    try {
      const notificationsBefore = h.listChanged();
      const before = (await listTools(h.client)).length;
      const result = await call(h.client, 'enable_toolset', { sets: ['nope'] });
      assert.equal(result.structuredContent?.error, 'unknown_toolset');
      assert.equal(h.listChanged() - notificationsBefore, 0);
      assert.equal((await listTools(h.client)).length, before);
    } finally {
      await h.close();
    }
  });

  it('refuses a module SPOTIFY_MCP_READONLY hides', async () => {
    // The read-only gate is an operator's hard guarantee, so a call from inside
    // the session must not be able to undo it — the same reason `call_tool`
    // cannot reach an unregistered module.
    const h = await connect({ env: { SPOTIFY_MCP_READONLY: '1' } });
    try {
      const notificationsBefore = h.listChanged();
      const before = (await listTools(h.client)).length;
      const result = await call(h.client, 'enable_toolset', { sets: ['library'] });
      assert.equal(result.structuredContent?.error, 'activation_refused', String(result.content[0]?.text));
      assert.match(String(result.content[0]?.text), /SPOTIFY_MCP_READONLY/);
      assert.equal(h.listChanged() - notificationsBefore, 0, 'a refused activation must not notify');
      assert.equal((await listTools(h.client)).length, before, 'a refused activation must not change the surface');
    } finally {
      await h.close();
    }
  });
});
