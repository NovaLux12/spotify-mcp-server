/**
 * Regression tests for #888 — the empty-`uris` rewrite path.
 *
 * `playlist_subtract` reaches the empty branch of `replaceWithUris` whenever
 * the subtraction removes every track, and `playlist_union` reaches it when
 * every source is empty. Both then send `PUT /playlists/{id}/items` with
 * `{uris: []}`.
 *
 * That PUT is not an unverified guess and is not a bug: the OpenAPI schema for
 * `reorder-or-replace-playlists-items` documents it as the way to clear a
 * playlist ("This operation can be used for replacing or clearing items in a
 * playlist"), and the body's `uris` array carries no `minItems`, so
 * `{uris: []}` is schema-valid. Emulating the clear with a descending sweep of
 * position-based DELETEs would cost N requests instead of 1 and leave a
 * half-emptied playlist if one failed.
 *
 * What was genuinely broken is the RESULT. The 200 body is
 * `{snapshot_id: string}` with no `required` list, and `jsonOrNull` returns
 * null for a 204 or a non-JSON content-type — so the clear can come back with
 * no readable receipt. The old code dropped that, reported `ok: true`, and
 * emitted `snapshot_id: null`, which reads as "Spotify returned no snapshot"
 * when the truth is "we could not read one". On the empty path the two answers
 * are separated by every track in the playlist, so an unreadable receipt is
 * now reported as its own unconfirmed state.
 *
 * Run: node --import tsx --test tests/tools.playlists-empty-clear.test.ts
 */

import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { SpotifyClient } from '../src/client.js';
import { registerPlaylistTools } from '../src/tools/playlists.js';
import type { PlaylistItemObject, SpotifyTrack } from '../src/types/spotify.js';

type ToolResponse = {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};

const BASE = 'B'.repeat(22);
const SOURCE = 'S'.repeat(22);
const SOURCE2 = 'R'.repeat(22);
const TARGET = 'T'.repeat(22);

const BASE_URI = 'spotify:track:a0';

interface HarnessOptions {
  /** What the clearing PUT returns; `null` models a 204 / non-JSON body. */
  clearResponse?: { snapshot_id: string } | Record<string, never> | null;
  /** URIs the subtraction source yields. Defaults to the whole base. */
  subtractUris?: string[];
  /** Sources are all empty, so the union result is empty. */
  emptySources?: boolean;
  /** The target starts with rows, so emptying it destroys something. */
  targetUris?: string[];
}

interface Harness {
  /** Every recorded wire call, e.g. `PUT /playlists/<id>/items`. */
  calls: string[];
  /** Bodies sent to the clearing PUT, in order. */
  putBodies: unknown[];
  prompts: string[];
  /** Tool descriptions as the live registry serves them. */
  descriptions: Record<string, string>;
  invoke: (name: string, args: Record<string, unknown>) => Promise<ToolResponse>;
  close: () => Promise<void>;
}

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const {
    clearResponse = { snapshot_id: 'snap-clear' },
    subtractUris = [BASE_URI],
    emptySources = false,
    targetUris = [],
  } = options;
  const calls: string[] = [];
  const putBodies: unknown[] = [];
  const prompts: string[] = [];

  const client = {
    // Playlist metadata: `items.total` is the current field (`tracks` is
    // deprecated), so the read is complete when total matches the walk.
    async get<T>(path: string): Promise<T | null> {
      const id = path.split('/').pop() ?? '';
      const total = id === BASE ? 1 : id === TARGET ? targetUris.length : 0;
      return { id, name: 'Playlist', items: { total } } as T;
    },
    async getAllPages<T>(path: string): Promise<T[]> {
      if (path.includes(`/${BASE}/items`)) {
        return [{ item: { id: 'a0', uri: BASE_URI, name: 'Track a0' } as SpotifyTrack }] as T[];
      }
      if (path.includes(`/${SOURCE}/items`) || path.includes(`/${SOURCE2}/items`)) {
        const uris = emptySources ? [] : subtractUris;
        return uris.map((uri, i) => ({ item: { id: uri, uri, name: `Track ${i}` } as SpotifyTrack })) as T[];
      }
      if (path.includes(`/${TARGET}/items`)) {
        const items: PlaylistItemObject[] = targetUris.map((uri, i) => ({
          added_at: '2026-01-01T00:00:00Z',
          item: { id: uri, uri, name: `Track ${i}` } as SpotifyTrack,
        }));
        return items as T[];
      }
      return [] as T[];
    },
    // #1310: the item walk moved from the bare-array `getAllPages` to the
    // truncation-aware `getAllPagesWithTruncation`, so a hand-rolled client has
    // to answer it. Delegating to the same `getAllPages` above keeps ONE
    // answer per path in this harness — a second, subtly different copy is
    // how a stub starts disagreeing with the code it is standing in for.
    // Every fixture here is far below the cap, so the verdict is "read whole".
    async getAllPagesWithTruncation<T>(path: string, params?: Record<string, string>, opts?: { maxItems?: number }): Promise<{ items: T[]; truncated: boolean; truncatedByCap: boolean; reportedTotal: number | null; pages: number }> {
      const items = await this.getAllPages<T>(path, params);
      const max = opts?.maxItems ?? items.length;
      const truncated = items.length > max;
      return { items: truncated ? items.slice(0, max) : items, truncated, truncatedByCap: truncated, reportedTotal: items.length, pages: 1 };
    },
    async post<T>(path: string): Promise<T | null> {
      calls.push(`POST ${path}`);
      return { id: 'created', snapshot_id: 'snap-post' } as T;
    },
    async put<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push(`PUT ${path}`);
      putBodies.push(body);
      // A null return models the 204 / non-JSON body that carries no receipt.
      return (clearResponse === null ? null : clearResponse) as T | null;
    },
    async delete<T>(): Promise<T | null> {
      calls.push('DELETE');
      return null;
    },
  } as unknown as SpotifyClient;

  const server = new McpServer({ name: 'empty-clear', version: '0.0.0' });
  registerPlaylistTools(server, client);
  const caller = new Client(
    { name: 'empty-clear-client', version: '0.0.0' },
    { capabilities: { elicitation: { form: {} } } },
  );
  caller.setRequestHandler(ElicitRequestSchema, async (request) => {
    prompts.push(request.params.message);
    return { action: 'accept', content: { confirm: true } };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([caller.connect(clientTransport), server.connect(serverTransport)]);
  const listed = (await caller.listTools()).tools;
  return {
    calls,
    putBodies,
    prompts,
    descriptions: Object.fromEntries(listed.map((t) => [t.name, t.description ?? ''])),
    invoke: async (name, args) => (await caller.callTool({ name, arguments: args })) as ToolResponse,
    close: () => caller.close(),
  };
}

const textOf = (out: ToolResponse) => out.content[0]?.text ?? '';

describe('#888 — the empty-uris rewrite path', () => {
  it('subtracting every track clears the base with one documented empty-uris PUT', async () => {
    const h = await makeHarness();
    try {
      const out = await h.invoke('playlist_subtract', {
        base_playlist_id: BASE,
        playlists: [SOURCE],
      });

      // The clear is ONE PUT of `{ uris: [] }` on /items — never the legacy
      // /tracks path, and never a DELETE sweep emulating the clear.
      assert.deepEqual(
        h.calls.filter((c) => c.startsWith('PUT') || c.startsWith('POST') || c.startsWith('DELETE')),
        [`PUT /playlists/${BASE}/items`],
        'a full subtraction must be exactly one PUT, with no DELETE sweep',
      );
      assert.deepEqual(h.putBodies, [{ uris: [] }], 'the clear must send an empty uris array');
      assert.ok(!h.calls.some((c) => c.includes('/tracks')), 'must not use the legacy /tracks path');

      // A readable receipt is a real success with its own message.
      assert.equal(out.structuredContent?.ok, true);
      assert.equal(out.structuredContent?.emptied, true);
      assert.equal(out.structuredContent?.kept_total, 0);
      assert.equal(out.structuredContent?.removed_total, 1);
      assert.equal(out.structuredContent?.snapshot_id, 'snap-clear');
      assert.match(textOf(out), /Playlist emptied/);
      assert.match(textOf(out), /Snapshot ID: snap-clear/);
      assert.equal(out.structuredContent?.reason, undefined, 'a confirmed clear is not a failure');
    } finally {
      await h.close();
    }
  });

  it('reports an unreadable clear receipt as unconfirmed, not as a clean success', async () => {
    // The regression: this used to return ok:true with snapshot_id:null, which
    // reads as "Spotify said there is no snapshot" when nothing was readable.
    for (const body of [null, {}]) {
      const h = await makeHarness({ clearResponse: body as { snapshot_id: string } | null });
      try {
        const out = await h.invoke('playlist_subtract', {
          base_playlist_id: BASE,
          playlists: [SOURCE],
        });
        assert.equal(out.structuredContent?.ok, false, 'an unreadable receipt must not be ok:true');
        assert.equal(out.structuredContent?.reason, 'clear_unconfirmed');
        assert.equal(out.structuredContent?.snapshot_read, false);
        assert.equal(out.structuredContent?.emptied, true, 'the clear was still sent');
        assert.match(textOf(out), /unconfirmed/i);
        assert.ok(!/Snapshot ID:/.test(textOf(out)), 'no receipt means no snapshot line');
      } finally {
        await h.close();
      }
    }
  });

  it('confirms before emptying, and reports what the prompt promised', async () => {
    const h = await makeHarness();
    try {
      await h.invoke('playlist_subtract', {
        base_playlist_id: BASE,
        playlists: [SOURCE],
      });
      // A full wipe makes impact.identical false, so the destructive gate
      // must fire before the playlist is cleared.
      assert.equal(h.prompts.length, 1, 'emptying a playlist must ask first');
      assert.match(h.prompts[0] ?? '', /Overwrite ALL 1 existing item\(s\)/);
    } finally {
      await h.close();
    }
  });

  it('an empty union clears the target the same way, and says so', async () => {
    const h = await makeHarness({ emptySources: true, targetUris: [BASE_URI] });
    try {
      const out = await h.invoke('playlist_union', {
        playlists: [SOURCE, SOURCE2],
        target_playlist_id: TARGET,
      });
      assert.deepEqual(h.putBodies, [{ uris: [] }]);
      assert.equal(out.structuredContent?.ok, true);
      assert.equal(out.structuredContent?.emptied, true);
      assert.match(textOf(out), /Emptied/);
    } finally {
      await h.close();
    }
  });

  it('an empty union with no readable receipt is unconfirmed too', async () => {
    const h = await makeHarness({ emptySources: true, targetUris: [BASE_URI], clearResponse: null });
    try {
      const out = await h.invoke('playlist_union', {
        playlists: [SOURCE, SOURCE2],
        target_playlist_id: TARGET,
      });
      assert.equal(out.structuredContent?.ok, false);
      assert.equal(out.structuredContent?.reason, 'clear_unconfirmed');
      assert.match(textOf(out), /unconfirmed/i);
    } finally {
      await h.close();
    }
  });

  it('a non-empty subtraction still reads as a normal subtract, not an empty one', async () => {
    // Guards the `emptied` flag against over-firing: only a genuinely empty
    // result may claim the playlist was emptied.
    const h = await makeHarness();
    try {
      const out = await h.invoke('playlist_subtract', {
        base_playlist_id: BASE,
        playlists: [SOURCE],
        dry_run: true,
      });
      assert.equal(out.structuredContent?.dry_run, true);
      assert.equal(out.structuredContent?.emptied, undefined, 'a dry run writes nothing');
      assert.deepEqual(h.putBodies, [], 'a dry run must not PUT');
    } finally {
      await h.close();
    }
  });

  it('states the empty-result behaviour in the tool descriptions', async () => {
    // Read the live registry, so this fails if the disclosure is dropped.
    const h = await makeHarness();
    try {
      const desc = (n: string) => h.descriptions[n] ?? '';
      assert.match(desc('playlist_subtract'), /empties/i, 'subtract must state that a full subtraction empties the playlist');
      assert.match(desc('playlist_union'), /empt/i, 'union must state that an empty union empties the target');
      assert.ok(!/DELETE or PUT/.test(desc('playlist_subtract')), 'subtract never issues a DELETE; the old quota line claimed it did');
    } finally {
      await h.close();
    }
  });
});
