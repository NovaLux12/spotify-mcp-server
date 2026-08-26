/**
 * Tests for src/tools/confirm.ts — elicitation-gated confirmation (#111 item 5).
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  confirmViaElicitation,
  describeConfirmation,
  supportsElicitation,
} from '../src/tools/confirm.js';

interface StubOptions {
  /** elicitInput result, or a thrown error */
  result?: unknown;
  throwOnElicit?: boolean;
}

function stubServer(opts: StubOptions = {}) {
  const elicitRequests: Array<{ message: string; requestedSchema: unknown }> = [];
  return {
    elicitRequests,
    server: {
      getServerCapabilities: () => ({ elicitation: {} }),
      async elicitInput(request: { message: string; requestedSchema: unknown }) {
        elicitRequests.push(request);
        if (opts.throwOnElicit) throw new Error('client does not support elicitation');
        return opts.result;
      },
    },
  };
}

afterEach(() => {
  delete process.env.SPOTIFY_MCP_CONFIRM;
});

describe('supportsElicitation', () => {
  it('returns true when capability advertised', () => {
    assert.equal(supportsElicitation(stubServer().server), true);
  });

  it('returns false when missing or guarded', () => {
    assert.equal(supportsElicitation({}), false);
    assert.equal(supportsElicitation(null), false);
    assert.equal(supportsElicitation(undefined), false);
    assert.equal(
      supportsElicitation({
        getServerCapabilities: () => {
          throw new Error('boom');
        },
      }),
      false,
    );
  });
});

describe('confirmViaElicitation', () => {
  it('accept + confirm=true → confirmed', async () => {
    const { server } = stubServer({
      result: { action: 'accept', content: { confirm: true } },
    });
    const verdict = await confirmViaElicitation(server, { message: 'Proceed?' });
    assert.equal(verdict, 'confirmed');
  });

  it('accept + confirm=false → declined', async () => {
    const { server } = stubServer({ result: { action: 'accept', content: { confirm: false } } });
    assert.equal(await confirmViaElicitation(server, { message: 'x' }), 'declined');
  });

  it('decline → declined', async () => {
    const { server } = stubServer({ result: { action: 'decline' } });
    assert.equal(await confirmViaElicitation(server, { message: 'x' }), 'declined');
  });

  it('cancel → declined', async () => {
    const { server } = stubServer({ result: { action: 'cancel' } });
    assert.equal(await confirmViaElicitation(server, { message: 'x' }), 'declined');
  });

  it('elicit throws → unsupported', async () => {
    const { server } = stubServer({ throwOnElicit: true });
    assert.equal(await confirmViaElicitation(server, { message: 'x' }), 'unsupported');
  });

  it('SPOTIFY_MCP_CONFIRM=never → unsupported without calling elicit', async () => {
    process.env.SPOTIFY_MCP_CONFIRM = 'never';
    const { server, elicitRequests } = stubServer({
      result: { action: 'accept', content: { confirm: true } },
    });
    const verdict = await confirmViaElicitation(server, { message: 'x' });
    assert.equal(verdict, 'unsupported');
    assert.equal(elicitRequests.length, 0);
  });

  it('no capability → unsupported without calling elicit', async () => {
    let called = false;
    const server = {
      async elicitInput() {
        called = true;
        return { action: 'accept', content: { confirm: true } };
      },
    };
    assert.equal(await confirmViaElicitation(server, { message: 'x' }), 'unsupported');
    assert.equal(called, false);
  });

  it('requestedSchema carries single boolean confirm field with label', async () => {
    const { server, elicitRequests } = stubServer({
      result: { action: 'decline' },
    });
    await confirmViaElicitation(server, { message: 'Big op', confirmLabel: 'Nuke it' });
    assert.equal(elicitRequests.length, 1);
    assert.equal(elicitRequests[0].message, 'Big op');
    const schema = elicitRequests[0].requestedSchema as {
      properties: { confirm: { type: string; title: string } };
      required: string[];
    };
    assert.deepEqual(schema.required, ['confirm']);
    assert.equal(schema.properties.confirm.type, 'boolean');
    assert.equal(schema.properties.confirm.title, 'Nuke it');
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
