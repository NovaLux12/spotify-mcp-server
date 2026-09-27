import './helpers/hermetic.js';

/**
 * #908 — the eight legacy `taste_*` tool names.
 *
 * Each was a SECOND registration of a canonical `statsfm_*` tool: same zod
 * params, same handler, description differing only by a suffix. Eight duplicate
 * rows in every host's `tools/list` bought no capability, cost ~7.7 KB of schema
 * per session, and gave a model choosing between two behaviourally identical
 * tools a coin flip.
 *
 * ## What this file pins
 *
 * The removal is a change to the REGISTRY, not to the product. Three claims
 * have to hold together, and each has broken before:
 *
 *  1. the canonical names are still registered, and the legacy names are not;
 *  2. a legacy name is REFUSED with a typed answer naming its replacement,
 *     rather than falling through to the generic unknown-tool path and leaving
 *     the caller to a Levenshtein guess;
 *  3. `SPOTIFY_MCP_LEGACY_ALIASES=1` restores dispatch — and does so ONLY when
 *     the canonical tool is actually registered, so the compat window cannot
 *     dispatch into a module the toolset gate removed.
 *
 * Claim 3's second half is the one that is easy to ship wrong: an opt-in rewrite
 * that runs before the "is this tool registered?" check would resurrect a tool
 * on a server that deliberately trimmed the `taste` toolset. That is why the
 * flag rides the `enable` path for the toolset and the registry check for the
 * name, and why there is a test below that disables the canonical tool and
 * expects a refusal.
 */
import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { installToolErrorBoundary } from '../src/tools/annotations.js';
import { registerStatsfmTasteTools } from '../src/tools/statsfm_taste.js';
import { LEGACY_TOOL_ALIASES, LEGACY_TOOL_ALIAS_NAMES } from '../src/shaping.js';

const STUB_CLIENT = {} as SpotifyClient;

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

const textOf = (result: ToolResult): string =>
  result.content.map((part) => part.text ?? '').join('\n');

const errorOf = (result: ToolResult): Record<string, unknown> | undefined =>
  result.structuredContent?.error as Record<string, unknown> | undefined;

/**
 * A server with the real taste module behind the real CallTool boundary, and a
 * client wired to it in-process. In-process rather than over stdio because
 * these tests assert on the boundary's REWRITE, and a stdio round trip would
 * only add a transport that could fail for unrelated reasons.
 */
async function withTasteServer(
  run: (call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>) => Promise<void>,
): Promise<void> {
  const server = new McpServer({ name: 'alias-test', version: '0.0.0' });
  registerStatsfmTasteTools(server, STUB_CLIENT);
  installToolErrorBoundary(server);
  const client = new Client({ name: 'alias-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    await run(async (name, args = {}) => (await client.callTool({ name, arguments: args })) as ToolResult);
  } finally {
    await client.close().catch(() => undefined);
  }
}

describe('legacy taste_* aliases (#908)', () => {
  let savedFlag: string | undefined;

  beforeEach(() => {
    savedFlag = process.env.SPOTIFY_MCP_LEGACY_ALIASES;
    // Off is the default the issue asks for; set it explicitly rather than
    // relying on the ambient environment, or a developer's exported value would
    // decide what the "off" test means.
    delete process.env.SPOTIFY_MCP_LEGACY_ALIASES;
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env.SPOTIFY_MCP_LEGACY_ALIASES;
    else process.env.SPOTIFY_MCP_LEGACY_ALIASES = savedFlag;
  });

  it('the alias table is eight pairs, all pointing at real canonical names', async () => {
    assert.equal(LEGACY_TOOL_ALIAS_NAMES.length, 8);
    const server = new McpServer({ name: 'alias-table', version: '0.0.0' });
    registerStatsfmTasteTools(server, STUB_CLIENT);
    const registered = new Set(Object.keys((server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {}));
    for (const [alias, canonical] of Object.entries(LEGACY_TOOL_ALIASES)) {
      assert.ok(registered.has(canonical), `${canonical} (replacement for ${alias}) is not registered`);
      assert.ok(!registered.has(alias), `${alias} is still registered`);
      assert.notEqual(alias, canonical);
      assert.match(alias, /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/, `${alias} is not a snake_case tool name`);
    }
  });

  it('every canonical name is present and every alias absent from tools/list', async () => {
    const server = new McpServer({ name: 'alias-list', version: '0.0.0' });
    registerStatsfmTasteTools(server, STUB_CLIENT);
    installToolErrorBoundary(server);
    const client = new Client({ name: 'alias-list-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const { tools } = await client.listTools();
      const names = new Set(tools.map((tool) => tool.name));
      assert.equal(tools.length, 8, `the taste module should register exactly 8 tools, got ${tools.length}`);
      for (const [alias, canonical] of Object.entries(LEGACY_TOOL_ALIASES)) {
        assert.ok(names.has(canonical), `${canonical} is missing from tools/list`);
        assert.ok(!names.has(alias), `${alias} is still in tools/list`);
      }
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it('refuses every legacy name, naming the replacement and the removal version', async () => {
    await withTasteServer(async (call) => {
      for (const [alias, canonical] of Object.entries(LEGACY_TOOL_ALIASES)) {
        const result = await call(alias);
        assert.equal(result.isError, true, `${alias} was accepted with the rewrite off`);
        const message = textOf(result);
        assert.ok(message.includes(alias), `${alias} refusal did not name the alias: ${message}`);
        assert.ok(message.includes(canonical), `${alias} refusal did not name ${canonical}: ${message}`);
        // The literal version. A regex built from the same constant the message
        // is built from cannot fail however the release is re-dated, and
        // "removed in v3.0" is the string a caller greps for.
        assert.match(message, /removed in v3\.0/, `${alias} refusal did not state the removal version`);
        const error = errorOf(result);
        assert.equal(error?.kind, 'unknown_tool', `${alias} refusal was not an unknown_tool`);
        // The stable discriminator. Without it a host cannot tell "we withdrew
        // this name on purpose" from "you mistyped", and the two deserve
        // different handling.
        assert.equal(error?.reason, 'retired_tool_alias', `${alias} refusal reason was not retired_tool_alias`);
        assert.ok(String(error?.fix ?? '').includes(canonical), `${alias} fix did not name the replacement`);
      }
    });
  });

  it('still answers a genuine unknown name as a plain unknown tool', async () => {
    await withTasteServer(async (call) => {
      const result = await call('taste_definitely_not_a_tool');
      assert.equal(result.isError, true);
      const error = errorOf(result);
      // The discriminator must not leak: an unrelated typo is a typo, and a
      // host that treats every `retired_tool_alias` as a migration signal would
      // act on a name that never existed. `tool_not_registered` is the reason
      // the generic unknown-tool path has always used, read from
      // `defaultReason('unknown_tool')` — asserted as a literal on purpose, so a
      // change to the shared default is a visible decision rather than a silent
      // no-op.
      assert.equal(error?.kind, 'unknown_tool');
      assert.equal(error?.reason, 'tool_not_registered', 'a genuine unknown name was reported as a retired alias');
    });
  });

  it('SPOTIFY_MCP_LEGACY_ALIASES=1 dispatches the legacy name to the canonical handler', async () => {
    process.env.SPOTIFY_MCP_LEGACY_ALIASES = '1';
    await withTasteServer(async (call) => {
      // `action: "list"` is the local-only half: it reads the capped sidecar
      // under the hermetic HOME and never touches the network, so this asserts
      // the rewrite REACHED the real handler without needing a stats.fm
      // account. A refusal here means the rewrite did not happen; a schema
      // error would mean it happened but the arguments were mangled.
      const viaAlias = await call('record_feedback', { action: 'list' });
      const viaCanonical = await call('statsfm_record_feedback', { action: 'list' });
      assert.notEqual(viaAlias.isError, true, `the alias call was refused: ${textOf(viaAlias)}`);
      assert.equal(textOf(viaAlias), textOf(viaCanonical), 'the alias did not reach the canonical handler');
    });
  });

  it('the rewrite is off by default and only the exact truthy spellings enable it', async () => {
    await withTasteServer(async (call) => {
      // `record_feedback`, not `taste_profile`, throughout: with the rewrite ON
      // the call reaches the real handler, and seven of the eight are
      // network-backed. A test that asserts a flag took effect must not also
      // depend on reaching stats.fm — on an offline box that is a hang, not a
      // failure.
      for (const value of ['', '0', 'false', 'no', 'off', 'enabled']) {
        process.env.SPOTIFY_MCP_LEGACY_ALIASES = value;
        const result = await call('record_feedback', { action: 'list' });
        assert.equal(result.isError, true, `SPOTIFY_MCP_LEGACY_ALIASES=${JSON.stringify(value)} enabled the rewrite`);
        assert.equal(errorOf(result)?.reason, 'retired_tool_alias');
      }
      for (const value of ['1', 'true', 'yes', 'on', 'ON', ' on ']) {
        process.env.SPOTIFY_MCP_LEGACY_ALIASES = value;
        // A truthy value must not produce a REFUSAL for the alias. The call
        // itself may still fail for its own reasons, so the assertion is the
        // shape of the answer rather than its success: a `retired_tool_alias`
        // refusal would mean the flag did not take effect.
        const result = await call('record_feedback', { action: 'list' });
        assert.notEqual(
          errorOf(result)?.reason,
          'retired_tool_alias',
          `SPOTIFY_MCP_LEGACY_ALIASES=${JSON.stringify(value)} did not enable the rewrite`,
        );
      }
    });
  });

  it('does not dispatch when the canonical tool is not registered', async () => {
    process.env.SPOTIFY_MCP_LEGACY_ALIASES = '1';
    // A server that trimmed the `taste` toolset has no canonical tool at all.
    // The rewrite must not be a way around that: it is a compatibility window
    // for NAMES, not a second registration path that ignores the toolset gate.
    const server = new McpServer({ name: 'no-taste', version: '0.0.0' });
    const called: string[] = [];
    server.tool('some_other_tool', 'unrelated', {}, async () => {
      called.push('some_other_tool');
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    });
    installToolErrorBoundary(server);
    const client = new Client({ name: 'no-taste-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const result = (await client.callTool({ name: 'taste_profile', arguments: {} })) as ToolResult;
      assert.equal(result.isError, true, 'a legacy name dispatched on a server with no taste module');
      assert.equal(errorOf(result)?.reason, 'retired_tool_alias');
      assert.deepEqual(called, [], 'the rewrite reached a handler on a trimmed server');
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
