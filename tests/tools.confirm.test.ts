/**
 * Tests for src/tools/confirm.ts — elicitation-gated confirmation (#111 item 5,
 * #684).
 *
 * Harness is a REAL McpServer + Client over InMemoryTransport: the client
 * advertises { elicitation: { form: {} } } and answers elicitation/create.
 * Hand-rolled stub servers cannot catch the #684 failure mode — the gate
 * probed the McpServer wrapper for `elicitInput`, which only exists on the
 * inner `server.server`, so a stub "passed" by never being asked.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  confirmViaElicitation,
  describeConfirmation,
  refusalFor,
  supportsElicitation,
  type ElicitVerdict,
} from '../src/tools/confirm.js';

const GATE_MESSAGE = 'About to remove 12 item(s) from "pl1":\n- 12 tracks\n\nProceed?';

/** Wire shape of the elicitation/create params this server asks for. */
const RequestedPromptSchema = z.object({
  message: z.string(),
  requestedSchema: z.object({
    type: z.string(),
    required: z.array(z.string()),
    properties: z.object({ confirm: z.object({ type: z.string(), title: z.string() }) }),
  }),
});

interface GateOptions {
  /** Advertisement is the whole point: omit it to model a prompt-less client. */
  advertiseElicitation?: boolean;
  /** Answer the prompt with this result, or throw to fail the exchange. */
  answer?: { action: 'accept' | 'decline' | 'cancel'; confirm?: boolean } | Error;
}

interface GateOutcome {
  verdict: ElicitVerdict;
  /** Tool text the caller produced for the verdict. */
  text: string;
  structured: Record<string, unknown> | undefined;
  /** Params of every elicitation/create the client received, in order. */
  prompts: unknown[];
}

/** Server + client wired over InMemoryTransport, with one gated tool registered. */
async function gateHarness(opts: GateOptions = {}) {
  const prompts: unknown[] = [];
  const outcomes: Array<{ verdict: ElicitVerdict; text: string; structured: Record<string, unknown> }> = [];
  const server = new McpServer({ name: 'confirm-gate-test', version: '0.0.0' });

  server.registerTool(
    'gated_remove',
    { description: 'Test-only destructive op behind the elicitation gate.', inputSchema: z.object({}) },
    async () => {
      const verdict = await confirmViaElicitation(server, {
        message: GATE_MESSAGE,
        confirmLabel: 'Nuke it',
      });
      const refusal = refusalFor(verdict);
      const text = refusal ? refusal.message : 'proceeding';
      const structured = refusal ? refusal.payload : { ok: true };
      outcomes.push({ verdict, text, structured });
      return { content: [{ type: 'text' as const, text }], structuredContent: structured };
    },
  );

  const client = new Client(
    { name: 'confirm-gate-client', version: '0.0.0' },
    opts.advertiseElicitation === false ? {} : { capabilities: { elicitation: { form: {} } } },
  );
  // The SDK refuses to install the handler when the capability is not advertised.
  if (opts.advertiseElicitation !== false) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      prompts.push(request.params);
      if (opts.answer instanceof Error) throw opts.answer;
      const answer = opts.answer ?? { action: 'accept' as const, confirm: true };
      return answer.action === 'accept'
        ? { action: answer.action, content: { confirm: answer.confirm ?? true } }
        : { action: answer.action };
    });
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    prompts,
    server,
    client,
    async call(): Promise<GateOutcome> {
      const before = outcomes.length;
      const res = await client.callTool({ name: 'gated_remove', arguments: {} });
      assert.equal(outcomes.length, before + 1, 'gated tool handler did not run');
      const outcome = outcomes[outcomes.length - 1];
      const text = (res.content as Array<{ type: string } & Record<string, unknown>>)
        .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
        .join('');
      return {
        verdict: outcome.verdict,
        text,
        structured: res.structuredContent as Record<string, unknown> | undefined,
        prompts,
      };
    },
    async close(): Promise<void> {
      await Promise.all([client.close(), server.close()]);
    },
  };
}

afterEach(() => {
  delete process.env.SPOTIFY_MCP_CONFIRM;
});

describe('supportsElicitation', () => {
  it('true only once the client advertised the capability', async () => {
    const eliciting = await gateHarness();
    const silent = await gateHarness({ advertiseElicitation: false });
    try {
      assert.equal(supportsElicitation(eliciting.server), true);
      assert.equal(supportsElicitation(silent.server), false);
    } finally {
      await Promise.all([eliciting.close(), silent.close()]);
    }
  });

  it('false for non-servers and hosts that cannot prompt', () => {
    assert.equal(supportsElicitation(undefined), false);
    assert.equal(supportsElicitation(null), false);
    assert.equal(supportsElicitation({}), false);
    // Player-style object with a broken capability accessor but no prompt call.
    assert.equal(
      supportsElicitation({
        server: {
          getClientCapabilities: () => {
            throw new Error('boom');
          },
        },
      }),
      false,
    );
  });
});

describe('confirmViaElicitation over a real transport (#684)', () => {
  it('asks the client exactly once and accepts its confirmation', async () => {
    const gate = await gateHarness();
    try {
      const outcome = await gate.call();

      assert.equal(outcome.prompts.length, 1, 'expected exactly one elicitation/create');
      const prompt = RequestedPromptSchema.parse(outcome.prompts[0]);
      assert.equal(prompt.message, GATE_MESSAGE);
      assert.deepEqual(prompt.requestedSchema.required, ['confirm']);
      assert.equal(prompt.requestedSchema.properties.confirm.type, 'boolean');
      assert.equal(prompt.requestedSchema.properties.confirm.title, 'Nuke it');

      assert.equal(outcome.verdict, 'confirmed');
      assert.equal(outcome.text, 'proceeding');
      assert.deepEqual(outcome.structured, { ok: true });
    } finally {
      await gate.close();
    }
  });

  it('accept without confirm=true is a decline', async () => {
    const gate = await gateHarness({ answer: { action: 'accept', confirm: false } });
    try {
      const outcome = await gate.call();
      assert.equal(outcome.verdict, 'declined');
      assert.equal(outcome.text, 'Cancelled — nothing was changed.');
      assert.deepEqual(outcome.structured, { ok: false, cancelled: true });
    } finally {
      await gate.close();
    }
  });

  it('decline and cancel both refuse the write', async () => {
    const declining = await gateHarness({ answer: { action: 'decline' } });
    const cancelling = await gateHarness({ answer: { action: 'cancel' } });
    try {
      for (const gate of [declining, cancelling]) {
        const outcome = await gate.call();
        assert.equal(outcome.prompts.length, 1);
        assert.equal(outcome.verdict, 'declined');
        assert.match(outcome.text, /Cancelled/);
        assert.deepEqual(outcome.structured, { ok: false, cancelled: true });
      }
    } finally {
      await Promise.all([declining.close(), cancelling.close()]);
    }
  });

  it('a failed prompt refuses instead of proceeding silently', async () => {
    const gate = await gateHarness({ answer: new Error('client died mid-prompt') });
    try {
      const outcome = await gate.call();
      assert.equal(outcome.prompts.length, 1, 'the prompt was attempted');
      assert.equal(outcome.verdict, 'error');
      assert.match(outcome.text, /Elicitation failed[\s\S]*refusing to proceed/i);
      assert.deepEqual(outcome.structured, {
        ok: false,
        cancelled: true,
        reason: 'elicitation_failed',
      });
    } finally {
      await gate.close();
    }
  });

  it('a client that never advertised elicitation proceeds unprompted', async () => {
    const gate = await gateHarness({ advertiseElicitation: false });
    try {
      const outcome = await gate.call();
      assert.equal(outcome.prompts.length, 0, 'must not attempt a prompt');
      assert.equal(outcome.verdict, 'unsupported');
      assert.equal(outcome.text, 'proceeding');
    } finally {
      await gate.close();
    }
  });

  it('SPOTIFY_MCP_CONFIRM=never skips the prompt even with capability', async () => {
    process.env.SPOTIFY_MCP_CONFIRM = 'never';
    const gate = await gateHarness();
    try {
      const outcome = await gate.call();
      assert.equal(outcome.prompts.length, 0);
      assert.equal(outcome.verdict, 'unsupported');
    } finally {
      await gate.close();
    }
  });
});

describe('refusalFor', () => {
  it('stops the write on declined/error and lets only unsupported through', () => {
    assert.equal(refusalFor('confirmed'), null);
    assert.equal(refusalFor('unsupported'), null);
    assert.deepEqual(refusalFor('declined'), {
      reason: 'declined',
      message: 'Cancelled — nothing was changed.',
      payload: { ok: false, cancelled: true },
    });
    const failed = refusalFor('error');
    assert.equal(failed?.reason, 'elicitation_failed');
    assert.deepEqual(failed?.payload, {
      ok: false,
      cancelled: true,
      reason: 'elicitation_failed',
    });
    assert.match(failed?.message ?? '', /refusing to proceed/);
  });
});

describe('describeConfirmation', () => {
  it('is deterministic and lists changes', () => {
    const a = describeConfirmation('remove from playlist', 'pl1', ['Remove 2 item(s):']);
    const b = describeConfirmation('remove from playlist', 'pl1', ['Remove 2 item(s):']);
    assert.equal(a, b);
    assert.match(a, /About to remove from playlist "pl1":/);
    assert.match(a, /- Remove 2 item\(s\):/);
    assert.match(a, /Proceed\?/);
  });
});
