/**
 * #1362 — a `swarm4_*` rewrite must REFUSE a playlist it could not read whole.
 *
 * ## The bug
 *
 * Every committing tool in `src/tools/swarm4_playlists.ts` builds its URI list
 * from `fetchAllItems`, which walked `/playlists/{id}/items` with
 * `maxItems: getConfig().fetchAllCap` (default 500) and returned a bare
 * `PlaylistItemObject[]`. A bare array cannot distinguish "this is the whole
 * playlist" from "this is its first 500 rows". Ten tools then committed that
 * list through `atomicReplace` — one `PUT /playlists/{id}/items` that replaces
 * the ENTIRE playlist — so on a 600-row playlist the 100 rows past the cap
 * were absent from the PUT, and an absent row in a full-content replace is a
 * deleted row. The tool then reported the cap as the count:
 * `Reversed "…" (500 item(s))`.
 *
 * `rewritable.ts` already documented this hole rather than closing it: it
 * names `swarm4_playlists.ts` as the one commit path the #1310 truncation guard
 * did not cover, because that file "keeps no verdict, so `assertRewritable`
 * there passes no `truncated` flag and the guard cannot infer one". This is
 * that change.
 *
 * ## What the assertions are made of
 *
 * The observable is `StatefulPlaylistClient`'s LIVE store. `PUT` really
 * replaces, so the reproduction below is a genuine 600 → 500 rather than a mock
 * artifact, and `PUT ... { uris: [] }` is the documented clear — which is why
 * the assertions also check the write log, not only the surviving row count.
 *
 * The stub inherits production `getAllPagesWithTruncation` and serves a real
 * `SpotifyPaged` envelope with a live `total`, so the cap arithmetic is decided
 * by production code. The cap itself is never written here: these tests move
 * when `SPOTIFY_MCP_FETCH_ALL_CAP` moves.
 *
 * Run: node --import tsx --test tests/tools.swarm4-truncated-rewrite.test.ts
 */

import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerSwarm4PlaylistsTools } from '../src/tools/swarm4_playlists.js';
import { StatefulPlaylistClient, trackUris } from './helpers/stub-client.js';
import { getConfig } from '../src/config.js';

const A = 'A'.repeat(22);
const B = 'B'.repeat(22);

type ToolOut = {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};

interface RegisteredTool {
  name: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolOut>;
}

function harness() {
  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(name: string, _d: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
      registered.push({ name, validate: (a) => z.object(schema).parse(a), handler });
    },
  } as unknown as McpServer;

  const stub = new StatefulPlaylistClient();
  registerSwarm4PlaylistsTools(fakeServer, stub as unknown as SpotifyClient);

  return {
    stub,
    seed: (id: string, rows: (string | null)[]) => stub.seedPlaylist(id, { rows }),
    invoke: async (name: string, args: Record<string, unknown>) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

const textOf = (out: ToolOut) => out.content[0]?.text ?? '';

/**
 * The ten `swarm4_*` tools that commit through `atomicReplace` — one full
 * `PUT` that replaces the whole playlist. Each entry is a call that DOES
 * reorder or filter the playlist when the read is whole, so an exactly-at-cap
 * run below is a real commit and not an early return.
 *
 * `playlist_balance` is deliberately absent: it creates NEW playlists and
 * leaves the source untouched, so a truncated read there cannot delete
 * anything. It has its own, separate disclosure gap — see the PR body.
 */
const REWRITES: Array<{ tool: string; args: Record<string, unknown> }> = [
  { tool: 'playlist_flip_order', args: {} },
  { tool: 'playlist_resequence', args: { sort_by: 'name' } },
  { tool: 'playlist_seed_shuffle', args: { seed: 7 } },
  { tool: 'playlist_rotate', args: { positions: 3 } },
  { tool: 'playlist_move_block', args: { start: 1, count: 3, to_position: 10 } },
  { tool: 'playlist_swap_positions', args: { position_a: 1, position_b: 5 } },
  { tool: 'playlist_dedupe_advanced', args: { keep: 'first' } },
  { tool: 'playlist_remove_artist', args: { artist: 'Artist 0' } },
  { tool: 'playlist_keep_artist', args: { artist: 'Artist 0' } },
  { tool: 'playlist_filter_runtime', args: { min_sec: 0, max_sec: 400 } },
];

describe('#1362 the data loss, reproduced', () => {
  for (const { tool, args } of REWRITES) {
    it(`${tool} on a playlist past the cap must not delete what it never read`, async () => {
      const cap = getConfig().fetchAllCap;
      const rows = trackUris(cap + 100);
      const h = harness();
      h.seed(A, rows);

      // The refusal is the point. A tool that proceeded returns a happy answer
      // here, and the assertions below are the loss.
      const out = await h.invoke(tool, { playlist_id: A, dry_run: false, ...args }).then(
        (o) => o,
        (e: unknown) => e as Error,
      );
      const message = out instanceof Error ? out.message : textOf(out);

      const after = h.stub.rowsOf(A);
      assert.equal(
        after.length,
        rows.length,
        `${tool} committed a replace built from a truncated read: ${rows.length} rows went in, ${after.length} came out — ${rows.length - after.length} DELETED, and the tool reported success`,
      );
      assert.deepEqual(after, rows, `${tool} must leave the playlist exactly as it found it when it refuses`);
      assert.deepEqual(
        h.stub.logOf(A).replaces,
        [],
        `${tool} opened a full replace over a walk that never reached the end of the playlist`,
      );
      assert.match(message, /fetch-all cap/, 'the refusal has to name the read, not just fail');
      assert.match(
        message,
        new RegExp(`past position ${cap}`),
        'and it has to name what was not read, so the caller can tell this apart from a successful rewrite',
      );
    });
  }

  it('the refusal is distinguishable from the unrelated unavailable-row refusal', async () => {
    // A caller told "I refused because a row has no URI" and a caller told
    // "I refused because I never read the playlist" need different remedies —
    // one points at remove_unavailable_playlist_items, the other at the cap.
    const cap = getConfig().fetchAllCap;
    const h = harness();
    h.seed(A, trackUris(cap + 100));
    h.seed(B, ['spotify:track:a', null, 'spotify:track:b']);

    const truncated = await h.invoke('playlist_flip_order', { playlist_id: A, dry_run: false }).catch((e: Error) => e);
    const unavailable = await h.invoke('playlist_flip_order', { playlist_id: B, dry_run: false }).catch((e: Error) => e);

    assert.ok(truncated instanceof Error, 'the over-cap rewrite refuses');
    assert.ok(unavailable instanceof Error, 'the unavailable-row rewrite refuses');
    assert.doesNotMatch(truncated.message, /unavailable item\(s\)/, 'a truncated read is not an unavailable row');
    assert.doesNotMatch(unavailable.message, /fetch-all cap/, 'and vice versa');
    assert.match(truncated.message, /SPOTIFY_MCP_FETCH_ALL_CAP/, 'the truncation refusal names the knob to raise');
  });

  it('a playlist that is BOTH truncated and unavailable is refused for truncation first', async () => {
    // `contains 1 unavailable item(s)` is a count derived from an INCOMPLETE
    // read: on a walk that stopped at the cap, the unavailable rows past it
    // were never seen, so leading with that count repeats the fault this issue
    // is filed on. The truncation refusal is the honest one, so it goes first —
    // which is also the order `playlists.ts` uses, and the reason is stated
    // there rather than invented here.
    const cap = getConfig().fetchAllCap;
    const h = harness();
    // An unavailable row INSIDE the cap, so the playlist is genuinely both.
    h.seed(A, ['spotify:track:a', null, ...trackUris(cap)]);
    const err = await h.invoke('playlist_flip_order', { playlist_id: A, dry_run: false }).catch((e: Error) => e);
    assert.ok(err instanceof Error);
    assert.match(err.message, /fetch-all cap/, 'the truncation refusal leads');
    assert.doesNotMatch(err.message, /unavailable item\(s\)/, 'a count off an incomplete read must not be the headline');
  });

  it('names how much was never read, not a count of what survived', async () => {
    // "Reversed 500 item(s)" is the false claim #1362 is filed on. The refusal
    // has to distinguish the rows it read from the playlist it did not.
    const cap = getConfig().fetchAllCap;
    const h = harness();
    h.seed(A, trackUris(cap + 100));
    const err = await h.invoke('playlist_flip_order', { playlist_id: A, dry_run: false }).catch((e: Error) => e);
    assert.ok(err instanceof Error);
    assert.match(err.message, new RegExp(`at least 100 more row\\(s\\) were never read`));
    assert.match(err.message, /Nothing was changed/, 'and it says the playlist was left alone');
  });

  it('dry_run is refused too — a preview that promises a commit is not a preview', async () => {
    // swarm4 already refuses its sibling unavailable-row fault in the dry-run
    // branch, for the same reason. Without this a dry run renders "would
    // reverse 500 items" over a 600-row playlist and the caller commits on a
    // plan the commit path will reject.
    const cap = getConfig().fetchAllCap;
    const h = harness();
    h.seed(A, trackUris(cap + 100));
    const out = await h.invoke('playlist_flip_order', { playlist_id: A, dry_run: true }).then(
      (o) => o,
      (e: unknown) => e as Error,
    );
    assert.ok(out instanceof Error, 'a truncated read must not render a committable plan');
    assert.match(out.message, /fetch-all cap/);
  });
});

describe('#1362 the choke point is structural', () => {
  // Behavioural tests above all route through a tool. This one guards the
  // shape that makes the guard unmissable: `atomicReplace` takes the loaded
  // playlist, not a bare id, so "the read was whole" and "the write is about
  // to happen" are the same object. A future tool that calls it inherits the
  // refusal. Reverting the signature to `(client, targetId, uris)` would
  // silently restore the defect with every behavioural test still green —
  // the ten call sites would pass an id, and the guard would have nothing to
  // read a verdict from.
  it('atomicReplace takes the LoadedPlaylist, and every call site passes it', () => {
    const src = readFileSync(new URL('../src/tools/swarm4_playlists.ts', import.meta.url), 'utf8');
    assert.match(
      src,
      /async function atomicReplace\(\s*client: SpotifyClient,\s*target: LoadedPlaylist,/,
      'atomicReplace must take the loaded playlist so the write cannot be reached by an unchecked read',
    );
    const calls = src.match(/atomicReplace\(client, [^)]*\)/g) ?? [];
    assert.equal(calls.length, 10, 'ten committing tools reach the write path');
    for (const call of calls) {
      assert.match(call, /atomicReplace\(client, p, uris\)/, `${call} must pass the loaded playlist, not a bare id`);
    }
    // And the choke point must actually assert, before the loop that issues
    // the first PUT.
    const body = src.slice(src.indexOf('async function atomicReplace'));
    const assertAt = body.indexOf('assertPlaylistReadWhole(target)');
    const firstPutAt = body.indexOf('await client.put<');
    assert.ok(assertAt > -1, 'the choke point must refuse');
    assert.ok(
      assertAt < firstPutAt,
      'the refusal has to come before the first PUT, not after the playlist is already replaced',
    );
  });
});

describe('#1362 the +1 probe boundary: exactly the cap commits, one past it refuses', () => {
  it('a playlist of EXACTLY the cap rows is rewritten whole', async () => {
    // The half of the pair a "600 rows" test cannot reach. A `rows.length >=
    // cap` truncation test reports every exact-cap playlist as truncated, and
    // the tool would refuse work it can do correctly.
    const cap = getConfig().fetchAllCap;
    for (const { tool, args } of REWRITES) {
      const rows = trackUris(cap);
      const h = harness();
      h.seed(A, rows);
      const out = await h.invoke(tool, { playlist_id: A, dry_run: false, ...args });

      assert.doesNotMatch(
        textOf(out),
        /fetch-all cap/,
        `${tool} must not claim truncation on an exactly-at-cap playlist`,
      );
      assert.equal(h.stub.logOf(A).replaces.length, 1, `${tool} must still commit at the cap`);
      // Not a per-tool row count: two of these legitimately shrink the
      // playlist (remove_artist, filter_runtime), and re-deriving each tool's
      // arithmetic here would be re-testing the tool rather than the read. The
      // claim under test is that the commit HAPPENED on a whole read — so a
      // replace was issued and it was not the `{ uris: [] }` clear.
      assert.ok(
        h.stub.rowsOf(A).length > 0,
        `${tool} must rewrite an exact-cap playlist, not clear it`,
      );
    }
  });

  it('a playlist of cap+1 rows refuses — the probe row is what proves the overflow', async () => {
    // The walk stops at `maxItems`, so with maxItems === cap+1 a cap+1 row
    // playlist is not itself an overflow to the client's own arithmetic; only
    // the clip back to `cap` rows shows there was one more. Drop the probe and
    // this boundary goes quiet.
    const cap = getConfig().fetchAllCap;
    const h = harness();
    h.seed(A, trackUris(cap + 1));
    const err = await h.invoke('playlist_flip_order', { playlist_id: A, dry_run: false }).catch((e: Error) => e);
    assert.ok(err instanceof Error, 'cap+1 rows must refuse');
    assert.match(err.message, /fetch-all cap/);
    assert.equal(h.stub.rowsOf(A).length, cap + 1, 'and it must not have committed anything');
  });
});
