/**
 * #881 — `remove_unavailable_playlist_items` against a playlist that really
 * changes.
 *
 * The existing suite for this tool (`tools.playlisthealth`) asserts the DELETE
 * BODIES: that positions were sent, and that they were sent highest first. That
 * is the right assertion for the request and the wrong one for the outcome,
 * because a stub that recorded positions without splicing them would satisfy
 * every one of those assertions while the playlist kept all its unavailable
 * rows — the post-write verification read would then have nothing to catch.
 *
 * `StatefulPlaylistClient` splices. So the assertion here is on what the
 * playlist CONTAINS afterwards, and the tool's own post-write verification is
 * exercised against state that the writes really moved.
 *
 * `OVER_CAP` (600 rows against the default fetch cap of 500) is the fixture
 * the issue's acceptance criterion asks for: the item walk has to hit the cap
 * for real, off the production `getAllPagesWithTruncation`, not off a copy that
 * hardcodes one. #1310 later gave that walk a `cap + 1` probe, so this suite's
 * `verification` expectations on an over-cap playlist are the bounded
 * `partial` verdict rather than `verified` — the row is still removed, the
 * tail is still not certified.
 *
 * Run: node --import tsx --test tests/tools.playlisthealth-unavailable-remove.test.ts
 */

import './helpers/hermetic.js';

import { afterEach, describe, it } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerPlaylistHealthTools } from '../src/tools/playlisthealth.js';
import { REMOVE_ELICIT_THRESHOLD } from '../src/tools/confirm.js';
import { StatefulPlaylistClient } from './helpers/stub-client.js';
import type { SeededPlaylist } from './helpers/stub-client.js';
import { getConfig } from '../src/config.js';

afterEach(() => {
  delete process.env.SPOTIFY_MCP_CONFIRM;
});

const P = 'P'.repeat(22);

type ToolOut = {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};

interface Harness {
  stub: StatefulPlaylistClient;
  prompts: string[];
  invoke: (name: string, args?: Record<string, unknown>) => Promise<ToolOut>;
}

function harness(seed: Record<string, SeededPlaylist>, opts: { elicit?: unknown; canElicit?: boolean } = {}): Harness {
  const { canElicit = true, elicit = { action: 'accept', content: { confirm: true } } } = opts;
  const registered: Array<{ name: string; validate: (a: Record<string, unknown>) => Record<string, unknown>; handler: (a: Record<string, unknown>) => Promise<ToolOut> }> = [];
  const prompts: string[] = [];
  const fakeServer = {
    tool(name: string, _description: string, schema: z.ZodRawShape, handler: (a: Record<string, unknown>) => Promise<ToolOut>) {
      registered.push({ name, validate: (a) => z.object(schema).parse(a), handler });
    },
    registerTool(name: string, config: { description?: string; inputSchema?: z.ZodType<Record<string, unknown>> }, handler: (a: Record<string, unknown>) => Promise<ToolOut>) {
      registered.push({ name, validate: (a) => (config.inputSchema as z.ZodType<Record<string, unknown>>).parse(a), handler });
    },
    ...(canElicit
      ? {
          server: {
            getClientCapabilities: () => ({ elicitation: { form: {} } }),
            async elicitInput(request: { message?: string }) {
              prompts.push(request?.message ?? '');
              if (elicit instanceof Error) throw elicit;
              return elicit;
            },
          },
        }
      : {}),
  } as unknown as McpServer;

  const stub = new StatefulPlaylistClient();
  for (const [id, s] of Object.entries(seed)) stub.seedPlaylist(id, s);
  registerPlaylistHealthTools(fakeServer, stub as unknown as SpotifyClient);

  return {
    stub,
    prompts,
    invoke: async (name, args = {}) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

const textOf = (out: ToolOut) => out.content[0]?.text ?? '';
const sc = (out: ToolOut) => out.structuredContent ?? {};

const uri = (i: number) => `spotify:track:${String(i).padStart(3, '0')}`;

describe('#881 remove_unavailable_playlist_items — the rows are really gone', () => {
  it('deletes highest-first and the playlist comes back without the unavailable rows', async () => {
    const h = harness({ [P]: { rows: [uri(1), null, uri(2), null, uri(3)] } });
    try {
      const out = await h.invoke('remove_unavailable_playlist_items', { playlist_id: P });

      // The observable is the store, not the request log: after a correct
      // descending splice the three healthy tracks are the three that remain,
      // in their original order. A delete that ignored its position, or that
      // ran low-to-high, would leave a different playlist.
      assert.deepEqual(
        h.stub.rowsOf(P),
        [uri(1), uri(2), uri(3)],
        'a splice that removed the wrong rows, or the wrong count, would pass a log-only assertion',
      );
      assert.deepEqual(h.stub.logOf(P).deletes, [[3], [1]], 'and the positions must be sent highest first, because earlier ones shift');

      assert.equal(sc(out).ok, true);
      assert.equal(sc(out).removed, 2);
      assert.equal(sc(out).remaining_unavailable, 0);
      assert.equal(sc(out).verification, 'verified', 'verification is a re-read of the live playlist, not a claim');
      assert.match(textOf(out), /Removed 2 unavailable item\(s\)/);
    } finally {
      /* no session state to release */
    }
  });

  it('max_removals caps the sweep and leaves the rest in place, with no false all-clear', async () => {
    const h = harness({ [P]: { rows: [uri(1), null, uri(2), null, uri(3)] } });
    try {
      const out = await h.invoke('remove_unavailable_playlist_items', { playlist_id: P, max_removals: 1 });

      assert.deepEqual(h.stub.rowsOf(P), [uri(1), uri(2), null, uri(3)]);
      assert.equal(sc(out).removed, 1);
      assert.equal(sc(out).remaining_unavailable, 1);
      // A capped sweep leaves an unavailable row behind, so it is NOT
      // `verified` — reporting it as one would tell the caller the playlist
      // is clean when it is not.
      assert.equal(sc(out).verification, 'failed', 'an incomplete sweep must not claim a clean playlist');
      assert.match(textOf(out), /verification failed/i);
      assert.deepEqual(sc(out).remaining_positions, [2]);
    } finally {
      /* no session state to release */
    }
  });

  it('a dry run deletes nothing', async () => {
    const rows = [uri(1), null, uri(2)];
    const h = harness({ [P]: { rows } });
    try {
      const out = await h.invoke('remove_unavailable_playlist_items', { playlist_id: P, dry_run: true });
      assert.equal(sc(out).dry_run, true);
      assert.deepEqual(sc(out).removed_positions, [1]);
      assert.deepEqual(h.stub.rowsOf(P), rows, 'a dry run must not touch the playlist');
      assert.deepEqual(h.stub.logOf(P).deletes, []);
    } finally {
      /* no session state to release */
    }
  });

  it('a playlist with nothing unavailable is left alone, and says so', async () => {
    const rows = [uri(1), uri(2)];
    const h = harness({ [P]: { rows } });
    try {
      const out = await h.invoke('remove_unavailable_playlist_items', { playlist_id: P });
      assert.equal(sc(out).unavailable_count, 0);
      assert.equal(sc(out).removed, 0);
      assert.match(textOf(out), /No unavailable items/);
      assert.deepEqual(h.stub.logOf(P).deletes, [], 'a clean playlist must not open a delete');
    } finally {
      /* no session state to release */
    }
  });
});

describe('#881 the removal gate fails closed', () => {
  /** `n` unavailable rows, enough to cross REMOVE_ELICIT_THRESHOLD. */
  const manyRows = (n: number) =>
    Array.from({ length: 40 }, (_, i) => (i % 3 === 0 && n > 0 ? (n--, null) : uri(i)));

  it(`asks once at ${REMOVE_ELICIT_THRESHOLD} rows and removes nothing when declined`, async () => {
    const rows = manyRows(REMOVE_ELICIT_THRESHOLD + 1);
    const h = harness({ [P]: { rows } }, { elicit: { action: 'decline' } });
    try {
      const out = await h.invoke('remove_unavailable_playlist_items', { playlist_id: P });

      assert.equal(h.prompts.length, 1, `a ${REMOVE_ELICIT_THRESHOLD}+-row sweep must ask`);
      assert.match(h.prompts[0] ?? '', /About to remove unavailable rows from playlist/);
      assert.equal(sc(out).cancelled, true);
      assert.deepEqual(h.stub.rowsOf(P), rows, 'a declined sweep is a refusal, never a silent proceed');
      assert.deepEqual(h.stub.logOf(P).deletes, []);
    } finally {
      /* no session state to release */
    }
  });

  it('a client that cannot prompt is refused, and nothing is deleted', async () => {
    const rows = manyRows(REMOVE_ELICIT_THRESHOLD + 1);
    const h = harness({ [P]: { rows } }, { canElicit: false });
    try {
      const out = await h.invoke('remove_unavailable_playlist_items', { playlist_id: P });
      assert.equal(sc(out).ok, false);
      assert.equal(sc(out).reason, 'confirmation_unavailable');
      assert.deepEqual(h.stub.rowsOf(P), rows);
      assert.deepEqual(h.stub.logOf(P).deletes, []);
    } finally {
      /* no session state to release */
    }
  });

  it('just under the threshold removes without asking', async () => {
    const rows = manyRows(REMOVE_ELICIT_THRESHOLD - 1);
    const h = harness({ [P]: { rows } });
    try {
      const out = await h.invoke('remove_unavailable_playlist_items', { playlist_id: P });
      assert.deepEqual(h.prompts, [], `${REMOVE_ELICIT_THRESHOLD - 1} rows is under the gate`);
      assert.equal(sc(out).ok, true);
      assert.equal(h.stub.rowsOf(P).filter((r) => r === null).length, 0);
    } finally {
      /* no session state to release */
    }
  });
});

describe('#881 the item walk is the production walk, cap and all', () => {
  it('finds and removes an unavailable row in a playlist past SPOTIFY_MCP_FETCH_ALL_CAP', async () => {
    const cap = getConfig().fetchAllCap;
    const overCap = cap + 100;
    assert.ok(overCap > cap, 'this fixture must exceed the cap it is testing');

    // 600+ rows with an unavailable row in the middle. The walk has to page
    // its way there; a stub whose paging stopped after one page would never
    // find it and would report a clean playlist.
    const rows = Array.from({ length: overCap }, (_, i) => (i === cap - 1 ? null : uri(i)));
    const h = harness({ [P]: { rows } });
    try {
      const out = await h.invoke('remove_unavailable_playlist_items', { playlist_id: P });

      assert.deepEqual(
        sc(out).removed_positions,
        [cap - 1],
        'the row at the last position inside the cap must be found — a single-page read would miss it',
      );
      assert.equal(sc(out).removed, 1);
      assert.deepEqual(
        h.stub.rowsOf(P).length,
        overCap - 1,
        'exactly one row leaves — the sweep is targeted, not a rebuild',
      );
      assert.equal(h.stub.rowsOf(P).filter((r) => r === null).length, 0);
      // #1311: the playlist is LARGER than the cap, so the post-write re-read
      // cannot certify the whole of it — the row at `cap - 1` was the only
      // unavailable one the tool could see, and `verified` would be claiming
      // about the 100 rows it never read. The verdict is bounded, and says so.
      assert.equal(
        sc(out).verification,
        'partial',
        'a walk that stopped at the cap cannot verify a playlist larger than the cap',
      );
      assert.equal(sc(out).truncated, true);
      assert.equal(sc(out).ok, false, 'a bounded verdict is not a clean success');
      // The read really paged: 600+ rows at 100 per page is more than one
      // request, and the count comes from the mock rather than the tool.
      assert.ok(
        h.stub.logOf(P).itemPageReads >= 5,
        `a ${overCap}-row playlist must take several page reads, took ${h.stub.logOf(P).itemPageReads}`,
      );
    } finally {
      /* no session state to release */
    }
  });
});
