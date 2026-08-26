/**
 * Tests for clean_all_playlists (#171): account-wide duplicate scan,
 * report-only default, apply mode with descending-position deletes per
 * playlist, global elicitation gate, and empty-account handling.
 */

import { describe, it, afterEach } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerPlaylistTools } from '../src/tools/playlists.js';

// ---------------------------------------------------------------------------
// Stub plumbing
// ---------------------------------------------------------------------------

interface RegisteredTool {
  name: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (
    args: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  }>;
}

type PlaylistItem = {
  item: { type: string; uri: string; name: string; artists?: Array<{ name: string }> } | null;
};

function harness(
  playlists: Array<{ id: string; name: string; owner: string; items: PlaylistItem[] }>,
  opts: ElicitOptions = {},
) {
  const registered: RegisteredTool[] = [];
  const elicitRequests: Array<{ message: string }> = [];
  const deletes: Array<{ playlistId: string; uri: string; position: number }> = [];

  // Live state so deletions shift positions within each playlist.
  const state = new Map<string, PlaylistItem[]>();
  for (const pl of playlists) state.set(pl.id, pl.items.map((e) => ({ ...e })));

  const fakeServer = {
    server: {
      getClientCapabilities: () => ({ elicitation: { form: {} } }),
    },
    async elicitInput(request: { message: string }) {
      elicitRequests.push(request);
      return opts.result ?? { action: 'accept', content: { confirm: true } };
    },
    tool(
      name: string,
      _description: string,
      schema: z.ZodRawShape,
      handler: RegisteredTool['handler'],
    ) {
      registered.push({
        name,
        validate: (args) => z.object(schema).parse(args),
        handler,
      });
    },
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

  const client = {
    async get<T>(path: string): Promise<T | null> {
      if (path === '/me/playlists') {
        return {
          items: playlists.map((pl) => ({
            id: pl.id,
            name: pl.name,
            uri: `spotify:playlist:${pl.id}`,
            description: null,
            owner: { display_name: pl.owner, id: pl.owner },
          })),
          total: playlists.length,
        } as T;
      }
      return null;
    },
    async getAllPages<T>(path: string): Promise<T[]> {
      if (path === '/me/playlists') {
        return playlists.map(
          (pl) =>
            ({
              id: pl.id,
              name: pl.name,
              uri: `spotify:playlist:${pl.id}`,
              description: null,
              owner: { display_name: pl.owner, id: pl.owner },
            }) as T,
        );
      }
      const match = /^\/playlists\/([^/]+)\/items$/.exec(path);
      if (!match) return [];
      return structuredClone(state.get(decodeURIComponent(match[1])) ?? []) as T[];
    },
    async delete<T>(path: string, body: unknown): Promise<T | null> {
      const playlistId = decodeURIComponent(/^\/playlists\/([^/]+)\/items$/.exec(path)![1]);
      for (const t of (body as { tracks: Array<{ uri: string; positions: number[] }> }).tracks) {
        deletes.push({ playlistId, uri: t.uri, position: t.positions[0] });
        state.get(playlistId)?.splice(t.positions[0], 1);
      }
      return { snapshot_id: 'snap-1' } as T;
    },
  };

  registerPlaylistTools(fakeServer, client as unknown as SpotifyClient);
  return {
    registered,
    deletes,
    elicitRequests,
    invoke: async (args: Record<string, unknown> = {}) => {
      const tool = registered.find((t) => t.name === 'clean_all_playlists');
      assert.ok(tool, 'clean_all_playlists should be registered');
      return tool.handler(tool.validate(args));
    },
  };
}

const textOf = (out: { content: Array<{ text: string }> }) => out.content[0].text;

const track = (uri: string, name: string, artist = 'Duo') => ({
  item: { type: 'track', uri, name, artists: [{ name: artist }] },
});

afterEach(() => {
  delete process.env.SPOTIFY_MCP_CONFIRM;
});

describe('clean_all_playlists', () => {
  it('registers report-first: apply defaults false', async () => {
    const h = harness([]);
    const tool = h.registered.find((t) => t.name === 'clean_all_playlists');
    assert.equal(tool!.validate({}).apply, false);
    assert.equal(tool!.validate({}).include_relinked, false);
  });

  it('reports per-playlist findings without deleting anything by default', async () => {
    const h = harness([
      { id: 'p1', name: 'Clean Mix', owner: 'me', items: [track('a', 'One'), track('b', 'Two')] },
      {
        id: 'p2',
        name: 'Duped',
        owner: 'me',
        items: [track('a', 'Hit'), track('x', 'Other'), track('a', 'Hit')],
      },
    ]);
    const out = await h.invoke({});
    assert.equal(h.deletes.length, 0);
    assert.match(textOf(out), /1 contain duplicates — 1 removable item/);
    assert.match(textOf(out), /"Duped".*1 group\(s\), 1 removable of 3/);
    assert.match(textOf(out), /apply=true to remove/);
    const p = out.structuredContent as { playlists_scanned: number; total_removable_items: number; applied: boolean };
    assert.equal(p.playlists_scanned, 2);
    assert.equal(p.total_removable_items, 1);
    assert.equal(p.applied, false);
  });

  it('handles an account with no duplicates and no playlists', async () => {
    const clean = harness([{ id: 'c1', name: 'Fine', owner: 'me', items: [track('a', 'A'), track('b', 'B')] }]);
    assert.match(textOf(await clean.invoke({})), /no duplicates found/);
    const empty = harness([]);
    assert.match(textOf(await empty.invoke({ apply: true })), /Scanned 0/);
    assert.equal(empty.deletes.length, 0);
  });

  it('apply mode removes across playlists, highest position first per playlist', async () => {
    const h = harness([
      {
        id: 'p1',
        name: 'Dupes One',
        owner: 'me',
        items: [track('a', 'Hit'), track('a', 'Hit'), track('a', 'Hit')], // remove pos 2, 1
      },
      {
        id: 'p2',
        name: 'Dupes Two',
        owner: 'me',
        items: [track('b', 'Song'), track('z', 'Filler'), track('b', 'Song')], // remove pos 2
      },
    ]);
    const out = await h.invoke({ apply: true });
    assert.equal(h.deletes.length, 3);
    const p1Deletes = h.deletes.filter((d) => d.playlistId === 'p1').map((d) => d.position);
    assert.deepEqual(p1Deletes, [2, 1]); // descending
    assert.deepEqual(h.deletes.filter((d) => d.playlistId === 'p2').map((d) => d.position), [2]);
    assert.match(textOf(out), /Cleaned 3 duplicate item\(s\) from 2 playlist\(s\)/);
    const p = out.structuredContent as { removed_total: number; ok: boolean; snapshot_id?: string };
    assert.equal(p.removed_total, 3);
    assert.equal(p.ok, true);
    assert.equal(p.snapshot_id, 'snap-1');
  });

  it('gates bulk applies behind one global elicitation and honours declines', async () => {
    const dupes12 = (): PlaylistItem[] =>
      Array.from({ length: 12 }, (_, i) => track(`s${i}`, `Song ${i}`)).flatMap((t) => [t, t]);
    const h = harness(
      [{ id: 'big', name: 'Big Mess', owner: 'me', items: dupes12() }],
      { result: { action: 'accept', content: { confirm: false } } },
    );
    const out = await h.invoke({ apply: true });
    assert.equal(h.elicitRequests.length, 1);
    assert.match(h.elicitRequests[0].message, /Remove 12 duplicate item\(s\) from 1 playlist\(s\)/);
    assert.equal(h.deletes.length, 0);
    assert.match(textOf(out), /Cancelled/);
  });

  it('skips elicitation entirely below the threshold', async () => {
    const h = harness([
      {
        id: 'small',
        name: 'Small Dupes',
        owner: 'me',
        items: [track('a', 'A'), track('a', 'A')],
      },
    ]);
    const out = await h.invoke({ apply: true });
    assert.equal(h.elicitRequests.length, 0);
    assert.equal(h.deletes.length, 1);
    assert.match(textOf(out), /Cleaned 1 duplicate item\(s\)/);
    void out;
  });
});
