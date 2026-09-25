/**
 * #871: `playlist_collab_toggle` must go through the same toward-visible
 * elicitation gate as `update_playlist` (#157).
 *
 * Before the fix the sibling tool re-derived the final visibility state inline,
 * checked only the public&&collaborative contradiction, and PUT regardless — a
 * silent bypass of the #157 privacy guard, reachable by any agent (or injected
 * instruction) that knew the sibling tool existed.
 *
 * Uses a stub MCP server + stub SpotifyClient: no network, no token file access.
 *
 * Run: node --import tsx --test tests/tools.playlist-collab-gate.test.ts
 */

import { describe, it } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerPlaylistTools } from '../src/tools/playlists.js';

interface RecordedCall {
  method: 'GET' | 'POST' | 'PUT' | 'PUT_RAW' | 'DELETE';
  path: string;
  arg?: unknown;
}

type Responder = (path: string, arg: unknown) => unknown;

interface ToolOut {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}

interface RegisteredTool {
  name: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolOut>;
}

interface StubClient {
  calls: RecordedCall[];
  get: <T>(path: string, params?: Record<string, string>) => Promise<T | null>;
  post: <T>(path: string, body?: unknown) => Promise<T | null>;
  put: <T>(path: string, body?: unknown) => Promise<T | null>;
  putRaw: (path: string, body: string) => Promise<void>;
  delete: <T>(path: string, body?: unknown) => Promise<T | null>;
  getAllPages: <T>(path: string, params?: Record<string, string>) => Promise<T[]>;
}

interface Harness {
  elicitCalls: Array<{ message: string }>;
  client: StubClient;
  invoke: (name: string, args: Record<string, unknown>) => Promise<ToolOut>;
}

const accept = { action: 'accept', content: { confirm: true } };

function makeStubClient(responder: Responder): StubClient {
  const calls: RecordedCall[] = [];
  const record =
    (method: RecordedCall['method']) =>
    async <T>(path: string, body?: unknown): Promise<T | null> => {
      calls.push({ method, path, arg: body });
      return responder(path, body) as T | null;
    };
  return {
    calls,
    get: record('GET'),
    post: record('POST'),
    put: record('PUT'),
    async putRaw(path: string, body: string) {
      calls.push({ method: 'PUT_RAW', path, arg: body });
      await responder(path, body);
    },
    delete: record('DELETE'),
    async getAllPages<T>(path: string, params?: Record<string, string>) {
      const page = await record('GET')<T & { items?: T[] }>(path, params);
      if (!page) return [];
      return Array.isArray(page) ? (page as T[]) : (page.items ?? []);
    },
  };
}

/**
 * `elicitResult` present → the stub server advertises elicitation and
 * `elicitInput` resolves to it (or throws when it is an Error instance).
 * Omitted → the server advertises no elicitation capability at all, which is
 * the fail-closed case.
 */
function harness(responder: Responder, elicitResult?: unknown): Harness {
  const registered: RegisteredTool[] = [];
  const elicitCalls: Array<{ message: string }> = [];
  const fakeServer = {
    // Legacy SDK shape: (name, description, ZodRawShape, handler)
    tool(
      name: string,
      _description: string,
      schema: z.ZodRawShape,
      handler: RegisteredTool['handler'],
    ) {
      registered.push({ name, validate: (args) => z.object(schema).parse(args), handler });
    },
    ...(elicitResult !== undefined
      ? {
          // Real McpServer shape: the capability accessor and elicitation both
          // live on the inner Server that McpServer exposes as `.server`.
          server: {
            getClientCapabilities: () => ({ elicitation: { form: {} } }),
            async elicitInput(request: { message?: string }) {
              elicitCalls.push({ message: request?.message ?? '' });
              if (elicitResult instanceof Error) throw elicitResult;
              return elicitResult;
            },
          },
        }
      : {}),
    // Newer SDK shape: (name, { description, inputSchema: full ZodObject }, handler)
    registerTool(
      name: string,
      config: { description?: string; inputSchema?: z.ZodType },
      handler: RegisteredTool['handler'],
    ) {
      registered.push({
        name,
        validate: (args) => (config.inputSchema as z.ZodType).parse(args),
        handler,
      });
    },
  } as unknown as McpServer;

  const client = makeStubClient(responder);
  registerPlaylistTools(fakeServer, client as unknown as SpotifyClient);

  return {
    elicitCalls,
    client,
    invoke: async (name, args) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

const textOf = (out: ToolOut) => out.content[0].text;

/** Answers GET /playlists/{id} with the given visibility flags. */
const withVisibility = (flags: { public?: boolean; collaborative?: boolean }): Responder =>
  (path) =>
    path.startsWith('/playlists/') ? { id: 'AbCdEfGhIjKlMnOpQrStUv', name: 'Mix', ...flags } : null;

const privatePlaylist = withVisibility({ public: false, collaborative: false });
const putsOf = (h: Harness) => h.client.calls.filter((c) => c.method === 'PUT');

describe('playlist_collab_toggle toward-visible gate (#871)', () => {
  it('public:true on a private playlist elicits exactly once and PUTs only on accept', async () => {
    const h = harness(privatePlaylist, accept);
    await h.invoke('playlist_collab_toggle', { playlist_id: 'AbCdEfGhIjKlMnOpQrStUv', public: true });
    assert.equal(h.elicitCalls.length, 1, 'exactly one elicitation');
    assert.match(h.elicitCalls[0].message, /make playlist public/);
    assert.match(h.elicitCalls[0].message, /public: false → true/);
    assert.equal(putsOf(h).length, 1);
    assert.deepEqual(putsOf(h)[0].arg, { public: true });
  });

  it('public:true declined issues NO PUT and reports cancelled', async () => {
    const h = harness(privatePlaylist, { action: 'decline' });
    const out = await h.invoke('playlist_collab_toggle', { playlist_id: 'AbCdEfGhIjKlMnOpQrStUv', public: true });
    assert.equal(h.elicitCalls.length, 1);
    // Only the current-state GET happened — nothing was written.
    assert.deepEqual(
      h.client.calls.map((c) => c.method),
      ['GET'],
    );
    assert.match(textOf(out), /Cancelled — nothing was changed\./);
    assert.deepEqual(out.structuredContent, { ok: false, cancelled: true });
  });

  it('cancel verdict is a refusal, not a silent proceed', async () => {
    const h = harness(privatePlaylist, { action: 'cancel' });
    const out = await h.invoke('playlist_collab_toggle', { playlist_id: 'AbCdEfGhIjKlMnOpQrStUv', public: true });
    assert.equal(putsOf(h).length, 0);
    assert.deepEqual(out.structuredContent, { ok: false, cancelled: true });
  });

  it('fails closed when the client cannot prompt (no elicitation capability)', async () => {
    const h = harness(privatePlaylist); // no elicitation advertised
    const out = await h.invoke('playlist_collab_toggle', { playlist_id: 'AbCdEfGhIjKlMnOpQrStUv', public: true });
    assert.equal(putsOf(h).length, 0, 'unsupported elicitation must not write');
    assert.match(textOf(out), /Confirmation is unavailable/);
    assert.deepEqual(out.structuredContent, {
      ok: false,
      cancelled: true,
      reason: 'confirmation_unavailable',
    });
  });

  it('a mid-flight elicitation failure refuses and writes nothing', async () => {
    const h = harness(privatePlaylist, new Error('transport died'));
    const out = await h.invoke('playlist_collab_toggle', { playlist_id: 'AbCdEfGhIjKlMnOpQrStUv', public: true });
    assert.equal(putsOf(h).length, 0);
    assert.match(textOf(out), /Elicitation failed/);
    assert.deepEqual(out.structuredContent, {
      ok: false,
      cancelled: true,
      reason: 'elicitation_failed',
    });
  });

  it('collaborative:true from a private playlist elicits and gates the PUT', async () => {
    const accepted = harness(privatePlaylist, accept);
    await accepted.invoke('playlist_collab_toggle', { playlist_id: 'AbCdEfGhIjKlMnOpQrStUv', collaborative: true });
    assert.equal(accepted.elicitCalls.length, 1);
    assert.match(accepted.elicitCalls[0].message, /collaborative: false → true/);
    assert.equal(putsOf(accepted).length, 1);

    const declined = harness(privatePlaylist, { action: 'decline' });
    await declined.invoke('playlist_collab_toggle', { playlist_id: 'AbCdEfGhIjKlMnOpQrStUv', collaborative: true });
    assert.equal(putsOf(declined).length, 0);
  });

  it('already-public → public:true is not a flip and never elicits', async () => {
    const h = harness(
      withVisibility({ public: true, collaborative: false }),
      new Error('must not elicit'),
    );
    await h.invoke('playlist_collab_toggle', { playlist_id: 'AbCdEfGhIjKlMnOpQrStUv', public: true });
    assert.equal(putsOf(h).length, 1);
  });

  it('toward-private flips never prompt (parity with the #157 update_playlist gate)', async () => {
    const h = harness(privatePlaylist, new Error('must not elicit'));
    await h.invoke('playlist_collab_toggle', { playlist_id: 'AbCdEfGhIjKlMnOpQrStUv', public: false });
    assert.equal(h.elicitCalls.length, 0);
    assert.equal(putsOf(h).length, 1);
  });

  it('SPOTIFY_MCP_CONFIRM=never is the documented automation bypass', async () => {
    const prev = process.env.SPOTIFY_MCP_CONFIRM;
    process.env.SPOTIFY_MCP_CONFIRM = 'never';
    try {
      const h = harness(privatePlaylist);
      await h.invoke('playlist_collab_toggle', { playlist_id: 'AbCdEfGhIjKlMnOpQrStUv', public: true });
      assert.equal(putsOf(h).length, 1);
    } finally {
      if (prev === undefined) delete process.env.SPOTIFY_MCP_CONFIRM;
      else process.env.SPOTIFY_MCP_CONFIRM = prev;
    }
  });

  it('dry_run previews with no GET, no elicitation, no PUT', async () => {
    const h = harness(undefined, new Error('must not elicit'));
    const out = await h.invoke('playlist_collab_toggle', {
      playlist_id: 'AbCdEfGhIjKlMnOpQrStUv',
      public: true,
      dry_run: true,
    });
    assert.equal(h.client.calls.length, 0);
    assert.match(textOf(out), /\[dry run\] collab toggle/);
  });

  it('the contradictory-state guard still runs before any write or elicitation', async () => {
    // args.collaborative is undefined, so the current collaborative:true
    // survives the merge and the requested public:true would land the playlist
    // in Spotify's rejected public && collaborative state.
    const h = harness(withVisibility({ public: false, collaborative: true }), accept);
    await assert.rejects(
      h.invoke('playlist_collab_toggle', { playlist_id: 'AbCdEfGhIjKlMnOpQrStUv', public: true }),
      /public=true && collaborative=true/,
    );
    assert.equal(putsOf(h).length, 0);
    assert.equal(h.elicitCalls.length, 0, 'an impossible write must not even prompt');
  });
});
