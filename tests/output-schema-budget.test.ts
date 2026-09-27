/**
 * The schema budget must see `outputSchema` (#1376).
 *
 * `collectAggregateSurfaceMeasurement` and `serializedSchemaBytes` both built
 * their payload from a literal that listed `{name, title, description,
 * inputSchema, annotations, execution, _meta}`. `outputSchema` was not in it —
 * while the tools/list boundary, thirty lines away, emitted the field. So a
 * tool declaring an output schema was charged **nothing** for bytes every host
 * receives, and the ceiling this repository documents as enforced at startup
 * was enforced against a payload that could not contain the field.
 *
 * That is worse than a missing budget. A gate that reports "no change" for a
 * change that doubles the payload is not a weak gate, it is a confident wrong
 * answer, and the number it prints is the one that ends up in a PR rationale.
 *
 * The test therefore asserts the measurement moves by the **exact** number of
 * bytes the wire grew by — read off a real `tools/list` — rather than merely
 * asserting "it changed". A gate that counted the field but got its size wrong,
 * or counted it twice, fails here; a "not equal" assertion would not.
 *
 * Nothing in this file declares an output schema on a production tool. The
 * schema is attached to a throwaway probe server so the fix can be tested
 * without changing the shipped surface: on the real registry the measurement
 * must still be byte-identical, which is itself asserted below.
 *
 * Run: node --import tsx --test tests/output-schema-budget.test.ts
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  AGGREGATE_SURFACE_LIMITS,
  applyToolAnnotations,
  assertAggregateSurfaceBudget,
  collectAggregateSurfaceMeasurement,
  installToolErrorBoundary,
  registerManifestModules,
  serializedSchemaBytes,
} from '../src/tools/annotations.js';
import { finalInputSchema } from '../src/shaping.js';
import { SpotifyClient } from '../src/client.js';

/**
 * A representative output shape: the list/mutation envelope these tools
 * actually emit, carrying a nested array so a measurement that dropped depth
 * could not pass.
 */
const ProbeOutput = z.object({
  ok: z.boolean(),
  affected: z.number().int(),
  items: z.array(z.object({ uri: z.string(), name: z.string() })),
  pagination: z.object({ total: z.number().nullable(), next_offset: z.number().nullable() }),
});

/**
 * The tools a host actually receives, through the production boundary.
 *
 * Deliberately not `finalOutputSchema`: the whole point of these tests is that
 * the gate agrees with the wire, so the wire has to be the reference.
 */
async function listWireTools(server: McpServer): Promise<Record<string, unknown>[]> {
  installToolErrorBoundary(server);
  const client = new Client({ name: 'budget-wire', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const tools = (await client.listTools()).tools as unknown as Record<string, unknown>[];
  await client.close();
  await server.close();
  return tools;
}

describe('#1376 the schema budget counts outputSchema', () => {
  it('the aggregate measurement moves by exactly the wire payload growth', async () => {
    const name = 'budget_probe';
    const without = new McpServer({ name: 'agg-without', version: '0.0.0' });
    const withSchema = new McpServer({ name: 'agg-with', version: '0.0.0' });
    without.tool(name, 'probe', {}, async () => ({ content: [{ type: 'text', text: 'x' }] }));
    withSchema.registerTool(name, { description: 'probe', inputSchema: {}, outputSchema: ProbeOutput }, async () => ({
      content: [{ type: 'text', text: 'x' }],
      structuredContent: { ok: true, affected: 0, items: [], pagination: { total: null, next_offset: null } },
    }));

    const before = collectAggregateSurfaceMeasurement(without).schemaBytes;
    const after = collectAggregateSurfaceMeasurement(withSchema).schemaBytes;
    assert.equal(before, collectAggregateSurfaceMeasurement(without).schemaBytes, 'precondition: the baseline measurement is stable');

    // The expected number is the wire's, not a hand-tallied one: read the two
    // real tools/list payloads and diff them. The boundary is what a host
    // receives, so it is the thing the gate has to agree with.
    const bytes = async (server: McpServer): Promise<number> =>
      Buffer.byteLength(JSON.stringify(await listWireTools(server)), 'utf8');
    const wireGrowth = (await bytes(withSchema)) - (await bytes(without));

    assert.ok(wireGrowth > 0, 'precondition: the declared schema really is on the wire');
    assert.equal(after - before, wireGrowth, 'the gate must charge exactly what the wire added');
  });

  it('the per-module measurement matches the output schema the wire actually sends', async () => {
    // The gate and the boundary must serialize identically, or the gate is
    // measuring a payload nobody receives. The expectation is read off a real
    // `tools/list` — deliberately NOT from `finalOutputSchema`, which is the
    // function under test. An expectation computed from the same source as the
    // code it checks passes no matter what that code does.
    const server = new McpServer({ name: 'agree', version: '0.0.0' });
    server.registerTool('budget_probe', { description: 'probe', inputSchema: {}, outputSchema: ProbeOutput }, async () => ({
      content: [{ type: 'text', text: 'x' }],
      structuredContent: { ok: true, affected: 0, items: [], pagination: { total: null, next_offset: null } },
    }));
    const registry = (server as unknown as {
      _registeredTools: Record<string, { description?: string; inputSchema?: unknown; outputSchema?: unknown }>;
    })._registeredTools;
    const measured = serializedSchemaBytes(registry.budget_probe, 'budget_probe');

    installToolErrorBoundary(server);
    const client = new Client({ name: 'agree-wire', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const [wireTool] = (await client.listTools()).tools;
    await client.close();
    await server.close();

    assert.ok(wireTool?.outputSchema, 'precondition: the boundary puts outputSchema on the wire');
    assert.equal(wireTool.outputSchema.type, 'object');
    assert.ok(wireTool.outputSchema.properties, 'the projected schema carries its properties');

    // Recorded, not endorsed. The SDK's zod→JSON-Schema conversion closes a
    // `z.object()` on its own, so the published schema says
    // `additionalProperties: false` — while the server's own `safeParseAsync`
    // in `validateOutput` strips unknown keys and passes. The published schema
    // is therefore stricter than the payloads really are. Asserting the
    // measured value here means a future SDK change to this default shows up
    // as a failing test rather than as a silent shift in what hosts are told.
    assert.equal(
      wireTool.outputSchema.additionalProperties,
      false,
      'the SDK closes a z.object() output schema; see the note in finalOutputSchema',
    );

    const expected = Buffer.byteLength(JSON.stringify({
      description: wireTool.description ?? '',
      inputSchema: wireTool.inputSchema ?? {},
      outputSchema: wireTool.outputSchema,
    }), 'utf8');
    assert.equal(measured, expected, 'per-module bytes must equal the wire payload for the same tool');
  });

  it('the census per-module formula agrees with the gate on a schema-bearing tool', async () => {
    // `serializedFinalizedSchemaBytes` in `scripts/surface-census.mjs` is a
    // second implementation of the same measurement, and it was blind to
    // `outputSchema` for the same reason. It is not exported and the census
    // runs on import, so it cannot be called directly — but its expression can
    // be reproduced here against a real wire tool, and compared to the gate.
    //
    // Without this, the census fix is unverified: the census only produces a
    // number when the whole registry boots, and on today's tree no tool
    // declares a schema, so `--check` passes identically whether or not the
    // field is counted. The two implementations drifting apart is precisely
    // how the original bug stayed invisible.
    const server = new McpServer({ name: 'census-parity', version: '0.0.0' });
    server.registerTool('budget_probe', { description: 'probe', inputSchema: {}, outputSchema: ProbeOutput }, async () => ({
      content: [{ type: 'text', text: 'x' }],
      structuredContent: { ok: true, affected: 0, items: [], pagination: { total: null, next_offset: null } },
    }));
    const registry = (server as unknown as {
      _registeredTools: Record<string, { description?: string; inputSchema?: unknown; outputSchema?: unknown }>;
    })._registeredTools;

    const [wireTool] = await listWireTools(server);
    // The census expression, verbatim.
    const censusBytes = Buffer.byteLength(JSON.stringify({
      description: String(wireTool.description ?? ''),
      inputSchema: (wireTool.inputSchema ?? {}) as unknown,
      ...((wireTool as { outputSchema?: unknown }).outputSchema === undefined
        ? null
        : { outputSchema: (wireTool as { outputSchema?: unknown }).outputSchema }),
    }), 'utf8');
    // What the census expression reported before #1376, i.e. the bug.
    const censusBeforeFix = Buffer.byteLength(JSON.stringify({
      description: String(wireTool.description ?? ''),
      inputSchema: (wireTool.inputSchema ?? {}) as unknown,
    }), 'utf8');

    const gateBytes = serializedSchemaBytes(registry.budget_probe, 'budget_probe');
    assert.equal(censusBytes, gateBytes, 'the census formula and the gate must measure the same tool identically');
    assert.ok(
      censusBeforeFix < censusBytes,
      'precondition: the pre-fix census expression really did under-report this tool',
    );
  });

  it('a tool with no output schema measures exactly as it did before', () => {
    // The fix must be invisible on the current surface. The pre-#1376 payload
    // is the `{description, inputSchema}` literal with the SAME finalized
    // input schema the measurement builds, so the only difference under test
    // is the added key. A fix that wrote `outputSchema: {}` for a missing
    // schema, or wrote the key in a position that survives stringification,
    // moves this number and fails here.
    const inputSchema = { limit: z.number().int().optional() };
    const withoutOutput = serializedSchemaBytes({ description: 'probe', inputSchema }, 'budget_probe');
    const preFix = Buffer.byteLength(JSON.stringify({
      description: 'probe',
      inputSchema: finalInputSchema(inputSchema),
    }), 'utf8');
    assert.equal(withoutOutput, preFix, 'no schema declared must cost exactly what it cost before');
  });

  it('the real production surface is unchanged by the fix', async () => {
    // Every tool on this tree declares no output schema, so fixing the
    // measurement must not move the real number by a single byte. The
    // expectation is the aggregate's own bytes with every `outputSchema` key
    // stripped from the serialized payload, which is exactly the number the
    // gate reported before this change — so this holds as the surface moves,
    // where a hardcoded 602,553B would rot the first time a tool was added.
    const server = new McpServer({ name: 'real', version: '0.0.0' });
    await registerManifestModules(server, new SpotifyClient(), { readOnly: false, isModuleActive: () => true, scopeBlocked: () => false });
    applyToolAnnotations(server);
    const registry = (server as unknown as { _registeredTools: Record<string, { outputSchema?: unknown }> })._registeredTools;
    const declared = Object.entries(registry).filter(([, entry]) => entry.outputSchema !== undefined);
    assert.deepEqual(declared.map(([name]) => name), [], 'precondition: no production tool declares an output schema');

    const measurement = collectAggregateSurfaceMeasurement(server);
    assert.equal(measurement.toolCount, Object.keys(registry).length);

    // Re-derive the payload the pre-#1376 literal produced: the same fields,
    // minus the one this change added. Equal numbers prove the fix is a no-op
    // on a surface with no output schemas, for whatever the surface is today.
    const preFixTools = (await listWireTools(server)).map(({ outputSchema: _omitted, ...rest }) => rest);
    assert.equal(
      measurement.schemaBytes,
      Buffer.byteLength(JSON.stringify(preFixTools), 'utf8'),
      'measuring outputSchema must not change the payload of a surface that declares none',
    );
  });

  it('the aggregate gate now fails closed on output schemas alone', () => {
    // The gate must reject a surface whose *only* overage is output schemas.
    // Before the fix this passed: the overage was invisible to the measurement.
    const server = new McpServer({ name: 'gate', version: '0.0.0' });
    // A schema big enough that a handful of tools exceed the whole headroom.
    const Wide = z.object(Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [`field_${i}`, z.string()]),
    ));
    for (let i = 0; i < 200; i++) {
      server.registerTool(`wide_probe_${i}`, { description: 'probe', inputSchema: {}, outputSchema: Wide }, async () => ({
        content: [{ type: 'text', text: 'x' }],
        structuredContent: Object.fromEntries(Array.from({ length: 400 }, (_, j) => [`field_${j}`, 'v'])),
      }));
    }
    const measurement = collectAggregateSurfaceMeasurement(server);
    assert.ok(measurement.schemaBytes > AGGREGATE_SURFACE_LIMITS.maxBytes, 'precondition: these output schemas alone exceed the ceiling');
    assert.throws(
      () => assertAggregateSurfaceBudget(measurement),
      /aggregate tool surface exceeds budget/,
      'an output-schema overage must fail the startup gate, not pass unseen',
    );
  });
});
