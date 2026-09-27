/**
 * #1550 — `remove_from_library` and the bulk-removal family.
 *
 * The defect this file exists for: `remove_from_library` declared
 * `dry_run: z.boolean().optional()` with no default, and its handler branched
 * on `if (args.dry_run)`. An omitted flag was therefore `undefined`, i.e.
 * falsy, i.e. COMMIT — one call could unsave 40 items with no preview. The
 * module also had no `confirmViaElicitation` anywhere, so even an explicit
 * `dry_run=false` on 40 items went straight to `client.delete`.
 *
 * ## Why a REAL McpServer, not the stub server
 *
 * The shared elicitation gate resolves the host by probing the INNER
 * `server.server` for `elicitInput` and `getClientCapabilities` (#684). A
 * hand-rolled stub can be shaped to pass that probe without any client ever
 * being asked, so a stub would let a gate that is silently dead look green.
 * This file drives the library tools through a real `McpServer` + `Client` over
 * `InMemoryTransport`, exactly as `tests/tools.confirm.test.ts` does, so
 * "no prompt was sent" is an observed fact about the wire and not an
 * assumption about a fake.
 *
 * The Spotify side is still a stub that records every call: the assertions
 * that matter are about which requests reached it, and no test may touch
 * Jack's real `~/.spotify-mcp/` or a live token.
 */

import './helpers/hermetic.js';

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { registerLibraryTools } from '../src/tools/library.js';
import type { SpotifyClient } from '../src/client.js';
import { DEFAULT_TOKEN_FILE } from './helpers/hermetic.js';

interface RecordedCall {
  method: 'GET' | 'DELETE' | 'PUT';
  path: string;
}

/** Tracks every mutating request so "nothing was deleted" is observable. */
function makeStubClient() {
  const calls: RecordedCall[] = [];
  const client = {
    calls,
    tokenFile: DEFAULT_TOKEN_FILE,
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      calls.push({ method: 'GET', path });
      // The post-write receipt reads /me/library/contains. A removal expects
      // absence, but the value is irrelevant here: what matters is that this
      // is a GET and the DELETE above it is the only mutation.
      if (path === '/me/library/contains') return [false] as unknown as T;
      return null;
    },
    async post<T>(): Promise<T | null> {
      return null;
    },
    async put(path: string): Promise<void> {
      calls.push({ method: 'PUT', path });
    },
    async delete(path: string): Promise<void> {
      calls.push({ method: 'DELETE', path });
    },
  };
  return { client, calls };
}

interface HarnessOptions {
  /** Omit to model a client that never advertised elicitation. */
  advertiseElicitation?: boolean;
  /** Accept / decline / cancel, or throw to fail the exchange mid-flight. */
  answer?: { action: 'accept' | 'decline' | 'cancel'; confirm?: boolean } | Error;
}

const uris = (n: number) => Array.from({ length: n }, (_, i) => `spotify:track:id${i}`);

/** Real MCP server + client, stubbed Spotify. */
async function harness(opts: HarnessOptions = {}) {
  // The stub's OWN log. Reading a different array here is what made an
  // earlier draft of this file assert `deepEqual(deletes(), [])` against a
  // list nothing ever wrote to — a passing test that could not fail.
  const { client: clientStub, calls } = makeStubClient();
  const prompts: unknown[] = [];

  const server = new McpServer({ name: 'library-gate-test', version: '0.0.0' });
  registerLibraryTools(server, clientStub as unknown as SpotifyClient);

  const client = new Client(
    { name: 'library-gate-client', version: '0.0.0' },
    opts.advertiseElicitation === false ? {} : { capabilities: { elicitation: { form: {} } } },
  );
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
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    prompts,
    /** Every mutating request the Spotify stub saw. */
    deletes: () => calls.filter((c) => c.method === 'DELETE').map((c) => c.path),
    async call(name: string, args: Record<string, unknown>) {
      const res = await client.callTool({ name, arguments: args });
      return {
        text: (res.content as Array<{ type: string } & Record<string, unknown>>)
          .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
          .join(''),
        structured: res.structuredContent as Record<string, unknown> | undefined,
      };
    },
    async schemaFor(name: string) {
      const res = await client.listTools();
      const tool = (res.tools as Array<{ name: string; inputSchema: { properties?: Record<string, { default?: unknown }> } }>)
        .find((t) => t.name === name);
      assert.ok(tool, `${name} missing from tools/list`);
      return tool.inputSchema;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

afterEach(() => {
  delete process.env.SPOTIFY_MCP_CONFIRM;
});

// ---------------------------------------------------------------------------
// 1. The omitted flag must not delete
// ---------------------------------------------------------------------------

describe('#1550 the omitted dry_run flag previews instead of deleting', () => {
  it('remove_from_library with no dry_run key makes zero DELETE calls', async () => {
    const h = await harness();
    try {
      const out = await h.call('remove_from_library', { uris: ['spotify:track:abc'] });

      assert.deepEqual(
        h.deletes(),
        [],
        'an omitted dry_run reached client.delete — this is the #1550 defect',
      );
      assert.equal(out.structured?.dry_run, true, 'the result must report a preview');
      assert.deepEqual(out.structured?.would_affect, ['spotify:track:abc']);
      assert.match(out.text, /^\[dry run\] remove_from_library on/);
    } finally {
      await h.close();
    }
  });

  it('the OMITTED case holds at the maximum batch size too (40 URIs)', async () => {
    const h = await harness();
    try {
      const out = await h.call('remove_from_library', { uris: uris(40) });
      assert.deepEqual(h.deletes(), [], '40 unsaved items on an omitted flag');
      assert.deepEqual(out.structured?.would_affect, uris(40));
    } finally {
      await h.close();
    }
  });

  it('an explicitly null dry_run also previews rather than deleting', async () => {
    // `undefined` is the omission; `null` is what a host that serialises a
    // missing field as JSON null sends. Neither may mean "commit".
    const h = await harness();
    try {
      await h.call('remove_from_library', { uris: ['spotify:track:abc'], dry_run: null });
      assert.deepEqual(h.deletes(), []);
    } finally {
      await h.close();
    }
  });

  it('an explicit dry_run=false still deletes (the fix did not disable the tool)', async () => {
    const h = await harness();
    try {
      const out = await h.call('remove_from_library', { uris: ['spotify:track:abc'], dry_run: false });
      assert.equal(h.deletes().length, 1, 'dry_run=false must still reach the DELETE');
      assert.match(out.text, /Removed 1 item\(s\) from library\./);
    } finally {
      await h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The EMITTED schema must tell the host the default
// ---------------------------------------------------------------------------

describe('#1550 the published tools/list schema states the default', () => {
  it('remove_from_library advertises default: true for dry_run', async () => {
    const h = await harness();
    try {
      const schema = await h.schemaFor('remove_from_library');
      // A host reads the schema, not the source. Before the fix this property
      // carried no `default` at all, so an omitted flag looked like a commit.
      assert.equal(
        schema.properties?.dry_run?.default,
        true,
        'tools/list must state default:true or the safety is invisible to every host',
      );
    } finally {
      await h.close();
    }
  });

  it('the description tells the caller the default is preview', async () => {
    const h = await harness();
    try {
      const res = await h.client.listTools();
      const tool = (res.tools as Array<{ name: string; description: string }>)
        .find((t) => t.name === 'remove_from_library');
      assert.ok(tool);
      assert.match(tool.description, /PREVIEWS BY DEFAULT/);
      assert.match(tool.description, /dry_run=false to commit/);
    } finally {
      await h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The elicitation gate
// ---------------------------------------------------------------------------

describe('#1550 remove_from_library gates bulk removals at the shared threshold', () => {
  it('below the threshold (9 URIs) commits without asking', async () => {
    const h = await harness();
    try {
      await h.call('remove_from_library', { uris: uris(9), dry_run: false });
      assert.equal(h.deletes().length, 1, '9 items is under REMOVE_ELICIT_THRESHOLD (10)');
      assert.equal(h.prompts.length, 0, 'no prompt expected under the threshold');
    } finally {
      await h.close();
    }
  });

  it('at the threshold (10 URIs) asks, and an accept commits', async () => {
    const h = await harness();
    try {
      await h.call('remove_from_library', { uris: uris(10), dry_run: false });
      assert.equal(h.prompts.length, 1, 'the gate must prompt at exactly 10');
      assert.equal(h.deletes().length, 1);
    } finally {
      await h.close();
    }
  });

  it('the prompt names the operation and how many items are at stake', async () => {
    const h = await harness();
    try {
      await h.call('remove_from_library', { uris: uris(12), dry_run: false });
      const prompt = h.prompts[0] as { params?: { message?: string } };
      const message = prompt?.params?.message ?? JSON.stringify(h.prompts[0]);
      assert.match(message, /remove from library/i);
      assert.match(message, /Remove 12 item\(s\)/);
      assert.match(message, /and 2 more/);
    } finally {
      await h.close();
    }
  });

  it('a DECLINE refuses with zero deletes', async () => {
    const h = await harness({ answer: { action: 'decline' } });
    try {
      const out = await h.call('remove_from_library', { uris: uris(10), dry_run: false });
      assert.deepEqual(h.deletes(), [], 'a declined prompt must write nothing');
      assert.equal(out.structured?.cancelled, true);
      assert.match(out.text, /Cancelled — nothing was changed\./);
    } finally {
      await h.close();
    }
  });

  it('an `unsupported` verdict — a client that cannot prompt — REFUSES with zero deletes', async () => {
    // The fail-closed arm: there was no human to ask, so the write does not
    // happen. This is the case that made #1550 worst.
    const h = await harness({ advertiseElicitation: false });
    try {
      const out = await h.call('remove_from_library', { uris: uris(40), dry_run: false });
      assert.deepEqual(h.deletes(), [], 'an unpromptable client must not become an unprompted delete');
      assert.equal(out.structured?.reason, 'confirmation_unavailable');
      assert.match(out.text, /Confirmation is unavailable/);
    } finally {
      await h.close();
    }
  });

  it('a prompt that FAILS mid-flight refuses with zero deletes', async () => {
    // #684: a gate that throws must not degrade into an ungated write.
    const h = await harness({ answer: new Error('elicitation exploded mid-flight') });
    try {
      const out = await h.call('remove_from_library', { uris: uris(40), dry_run: false });
      assert.deepEqual(h.deletes(), [], 'a failed prompt must not fall through to the DELETE');
      assert.equal(out.structured?.reason, 'elicitation_failed');
      assert.match(out.text, /Elicitation failed on the wire/);
    } finally {
      await h.close();
    }
  });

  it('a confirm=false answer to an accepted prompt is still a refusal', async () => {
    // `action: 'accept'` with the checkbox unticked is not consent.
    const h = await harness({ answer: { action: 'accept', confirm: false } });
    try {
      const out = await h.call('remove_from_library', { uris: uris(10), dry_run: false });
      assert.deepEqual(h.deletes(), []);
      assert.equal(out.structured?.cancelled, true);
    } finally {
      await h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. The automation bypass, on exact terms
// ---------------------------------------------------------------------------

describe('#1550 SPOTIFY_MCP_CONFIRM=never is the only bypass', () => {
  it('the exact string "never" lets an unpromptable client commit', async () => {
    process.env.SPOTIFY_MCP_CONFIRM = 'never';
    const h = await harness({ advertiseElicitation: false });
    try {
      await h.call('remove_from_library', { uris: uris(40), dry_run: false });
      assert.equal(h.deletes().length, 1, 'the deliberate automation bypass must be honoured');
    } finally {
      await h.close();
    }
  });

  it('the bypass does NOT weaken the preview default', async () => {
    process.env.SPOTIFY_MCP_CONFIRM = 'never';
    const h = await harness({ advertiseElicitation: false });
    try {
      await h.call('remove_from_library', { uris: ['spotify:track:abc'] });
      assert.deepEqual(
        h.deletes(),
        [],
        'the bypass removes the PROMPT, never the dry-run default',
      );
    } finally {
      await h.close();
    }
  });

  for (const value of ['NEVER', 'Never', 'no', 'false', '1', 'true', ' ']) {
    it(`refuses when SPOTIFY_MCP_CONFIRM=${JSON.stringify(value)} — only exactly "never" bypasses`, async () => {
      process.env.SPOTIFY_MCP_CONFIRM = value;
      const h = await harness({ advertiseElicitation: false });
      try {
        const out = await h.call('remove_from_library', { uris: uris(10), dry_run: false });
        assert.deepEqual(
          h.deletes(),
          [],
          `SPOTIFY_MCP_CONFIRM=${JSON.stringify(value)} must not act as a bypass`,
        );
        assert.equal(out.structured?.reason, 'confirmation_unavailable');
      } finally {
        await h.close();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 5. The rest of the bulk-removal family, through the same threshold
// ---------------------------------------------------------------------------

describe('#1550 the family shares one threshold and one guard', () => {
  it('remove_from_library is annotated destructive, not read-only', async () => {
    // The name starts with `remove`, a mutating prefix, so the fail-closed
    // classifier must not call it read-only; and the write must say so
    // explicitly, since MCP defaults destructiveHint to true and silence
    // would advertise a save as dangerous as a drop.
    const { classifyToolAnnotations } = await import('../src/tools/annotations.js');
    const ann = classifyToolAnnotations('remove_from_library');
    // The convention is fail-closed by ABSENCE: a mutating tool omits
    // readOnlyHint rather than stating `false`, and states destructiveHint
    // explicitly because MCP's own default is `true` and silence would
    // advertise a save as dangerous as a drop.
    assert.notEqual(ann.readOnlyHint, true, 'a removal must never be classified read-only');
    assert.equal(ann.destructiveHint, true, 'the removal must state destructiveHint');
  });

  it('the whole audited removal family stays classified as mutating', async () => {
    const { classifyToolAnnotations } = await import('../src/tools/annotations.js');
    // These are the tools this issue changed. Each one deletes; none may be
    // advertised as read-only, and none may be left to the destructiveHint
    // default of `true` by omission.
    const family = [
      'remove_from_library',
      'remove_from_library_by_playlist',
      'unsave_orphan_tracks',
      'remove_saved_shows',
      'remove_saved_episode',
      'archive_played_episodes',
      'dead_library_finder',
    ];
    for (const name of family) {
      const ann = classifyToolAnnotations(name);
      assert.notEqual(ann.readOnlyHint, true, `${name} must not be read-only`);
      assert.equal(ann.destructiveHint, true, `${name} must state destructiveHint`);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. SPOTIFY_MCP_READONLY must still hide the family
// ---------------------------------------------------------------------------

describe('#1550 the read-only session still hides every tool the family changed', () => {
  it('none of the family is registered under SPOTIFY_MCP_READONLY', async () => {
    // The gate is module-level (`module.readOnlySafe !== true`), so this is a
    // whole-registry read rather than a per-tool one — but the brief's
    // condition is per-tool, so assert it per tool. The floor check comes
    // first: a registry that came back empty would satisfy every absence
    // assertion below while proving nothing, and that has shipped here before.
    const { McpServer: S } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { SpotifyClient } = await import('../src/client.js');
    const { registerManifestModules } = await import('../src/tools/annotations.js');

    const server = new S({ name: 'readonly-1550', version: '0.0.0' });
    await registerManifestModules(server, new SpotifyClient(), {
      readOnly: true,
      disableOverrides: new Set<string>(),
      isModuleActive: () => true,
      scopeBlocked: () => false,
    });
    const names = new Set(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools
        ? Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools)
        : [],
    );
    assert.ok(
      names.size > 150,
      `read-only registry collapsed to ${names.size} names — the assertions below would be vacuous`,
    );
    // Named so a reader can see the floor is met by a real surface, not a
    // stub: the ungated registry at this commit is ~556 tools and a READONLY
    // session is a strict subset of it.

    for (const name of [
      'remove_from_library',
      'remove_from_library_by_playlist',
      'unsave_orphan_tracks',
      'remove_saved_shows',
      'remove_saved_episode',
      'archive_played_episodes',
      'dead_library_finder',
    ]) {
      assert.equal(names.has(name), false, `${name} must not be registered in a read-only session`);
    }
  });
});
