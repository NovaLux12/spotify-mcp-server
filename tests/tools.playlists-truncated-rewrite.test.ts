/**
 * #1310 / #1311 — a rewrite must REFUSE an over-cap playlist, and a cleanup
 * must never say "clean" over a walk that stopped at the cap.
 *
 * ## The bug
 *
 * `playlist_sort` / `shuffle` / `reverse` / `trim` commit through one atomic
 * full-content `PUT /playlists/{id}/items`. The URI list they send is built
 * from a walk capped at `SPOTIFY_MCP_FETCH_ALL_CAP` (default 500). On a
 * 600-row playlist the rows past the cap are absent from the PUT, the replace
 * deletes them for good, and the tool reports "Reversed 500 item(s)".
 *
 * #1311 is the other half: `remove_unavailable_playlist_items` — the remedy
 * #1310's refusal names — walked to the same cap and issued
 * `verification: "verified"` while an unavailable row sat at index 550.
 *
 * Both are the AGENTS.md §6 failure class: a value that could not be read was
 * coerced into a plausible number, and the plausible number is what the caller
 * reads.
 *
 * ## What the assertions are made of
 *
 * The observable is `StatefulPlaylistClient`'s LIVE store. `PUT` really
 * replaces, so a truncated walk loses rows in the mock exactly as it would on
 * a real playlist — the reproduction below is a genuine 600 → 500, not a mock
 * artifact. The cap itself is never written here: the mock hands the inherited
 * `getAllPages` a real envelope and production decides, so these tests move
 * when `SPOTIFY_MCP_FETCH_ALL_CAP` moves.
 *
 * Run: node --import tsx --test tests/tools.playlists-truncated-rewrite.test.ts
 */

import './helpers/hermetic.js';

import { afterEach, describe, it } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerPlaylistTools } from '../src/tools/playlists.js';
import { registerPlaylistHealthTools } from '../src/tools/playlisthealth.js';
import { StatefulPlaylistClient, StubFromResponder, trackRowForUri, trackUris } from './helpers/stub-client.js';
import type { SeededPlaylist } from './helpers/stub-client.js';
import { getConfig } from '../src/config.js';

afterEach(() => {
  delete process.env.SPOTIFY_MCP_CONFIRM;
});

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

interface Harness {
  stub: StatefulPlaylistClient;
  prompts: string[];
  invoke: (name: string, args?: Record<string, unknown>) => Promise<ToolOut>;
}

function harness(
  seed: Record<string, SeededPlaylist>,
  opts: { elicit?: unknown; canElicit?: boolean } = {},
): Harness {
  const { canElicit = true, elicit = { action: 'accept', content: { confirm: true } } } = opts;
  const registered: RegisteredTool[] = [];
  const prompts: string[] = [];
  const fakeServer = {
    tool(name: string, _d: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
      registered.push({ name, validate: (a) => z.object(schema).parse(a), handler });
    },
    registerTool(name: string, config: { inputSchema?: z.ZodType<Record<string, unknown>> }, handler: RegisteredTool['handler']) {
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
  for (const [id, seeded] of Object.entries(seed)) stub.seedPlaylist(id, seeded);
  registerPlaylistTools(fakeServer, stub as unknown as SpotifyClient);
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

/** The four single-playlist tools that commit an atomic full replace. */
const REWRITES: Array<{ tool: string; args: Record<string, unknown> }> = [
  { tool: 'playlist_reverse', args: {} },
  { tool: 'playlist_shuffle', args: { seed: 'deterministic' } },
  { tool: 'playlist_sort', args: { sort_by: 'name_asc' } },
  { tool: 'playlist_trim', args: { keep: 3, keep_which: 'last' } },
];

describe('#1310 the data loss, reproduced', () => {
  for (const { tool, args } of REWRITES) {
    it(`${tool} on a playlist past the cap must not delete what it never read`, async () => {
      const cap = getConfig().fetchAllCap;
      const rows = trackUris(cap + 100);
      const h = harness({ [A]: { rows } });

      // The refusal is the point. A tool that proceeded would return here with
      // a happy answer, and the two assertions below are the loss.
      const out = await h.invoke(tool, { playlist_id: A, ...args }).then(
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

  it('the refusal is distinguishable from the unrelated-row refusal', async () => {
    // A caller told "I refused because a row has no URI" and a caller told
    // "I refused because I never read the playlist" need different remedies —
    // one points at remove_unavailable_playlist_items, the other at the cap.
    const cap = getConfig().fetchAllCap;
    const h = harness({ [A]: { rows: trackUris(cap + 100) } });
    const truncated = await h.invoke('playlist_reverse', { playlist_id: A }).catch((e: Error) => e);

    const withNulls = harness({ [B]: { rows: ['spotify:track:a', null, 'spotify:track:b'] } });
    const unavailable = await withNulls.invoke('playlist_reverse', { playlist_id: B }).catch((e: Error) => e);

    assert.ok(truncated instanceof Error, 'the over-cap rewrite refuses');
    assert.ok(unavailable instanceof Error, 'the unavailable-row rewrite refuses');
    assert.doesNotMatch(truncated.message, /unavailable item\(s\)/, 'a truncated read is not an unavailable row');
    assert.doesNotMatch(unavailable.message, /fetch-all cap/, 'and vice versa');
    assert.match(truncated.message, /SPOTIFY_MCP_FETCH_ALL_CAP/, 'the truncation refusal names the knob to raise');
  });
});

describe('#1310 the +1 probe boundary: 500 succeeds, 501 refuses', () => {
  it('a playlist of EXACTLY the cap row is rewritten whole', async () => {
    // This is the half of the pair a "600 rows" test cannot reach. A
    // `length >= cap` truncation test reports every exact-cap playlist as
    // truncated, and the tool would refuse work it can actually do correctly.
    const cap = getConfig().fetchAllCap;
    for (const { tool, args } of REWRITES) {
      const rows = trackUris(cap);
      const h = harness({ [A]: { rows } });
      const out = await h.invoke(tool, { playlist_id: A, ...args });

      const expected = cap === 0 ? 0 : cap;
      assert.equal(
        h.stub.rowsOf(A).length,
        tool === 'playlist_trim' ? 3 : expected,
        `${tool} must rewrite an exact-cap playlist, not refuse it`,
      );
      assert.notEqual(
        textOf(out),
        '',
        `${tool} must still answer`,
      );
      assert.doesNotMatch(
        textOf(out),
        /fetch-all cap/,
        `${tool} must not claim truncation on an exactly-at-cap playlist`,
      );
      assert.equal(h.stub.logOf(A).replaces.length, 1, `${tool} must actually commit at the cap`);
      // #872 gives `playlist_trim` a mandatory overwrite gate, so its commit
      // below is reached only if the gate ran AND was accepted. Asserting the
      // prompt exists is what proves the new refusal did not quietly shadow
      // the gate: a refusal here would leave `prompts` empty and this assert
      // would catch it, rather than the commit looking like a pass either way.
      if (tool === 'playlist_trim') {
        assert.equal(h.prompts.length, 1, 'at the cap, trim must still reach #872\'s gate and commit once it is accepted');
      }
    }
  });

  it('trim keeps `first` on #872\'s gate and refuses only the ends it cannot see', async () => {
    // The asymmetry, stated as a test because it is the whole reason the
    // #1310 refusal on `playlist_trim` is narrower than the other three.
    //
    // `first` takes a prefix of what was read, which IS the playlist's real
    // prefix; the unread tail is exactly what the trim deletes anyway, and
    // #872's gate discloses the partial read before anyone approves it. So it
    // must still work over a truncated walk — refusing it would be a
    // regression against a fix that is already merged and tested.
    //
    // `last` and `random` need rows the walk never read, so their kept set is
    // the wrong set, and the prompt can only say how MUCH is deleted.
    const cap = getConfig().fetchAllCap;
    const rows = trackUris(cap + 100);

    const first = harness({ [A]: { rows } });
    const firstOut = await first.invoke('playlist_trim', { playlist_id: A, keep: 3, keep_which: 'first' });
    assert.equal(first.prompts.length, 1, '`first` must still reach #872\'s overwrite gate over a truncated read');
    assert.doesNotMatch(textOf(firstOut), /could only be read/, 'and must not be turned into a #1310 refusal');
    assert.deepEqual(
      first.stub.rowsOf(A).slice(0, 3),
      rows.slice(0, 3),
      '`first` must keep the playlist\'s real first three rows, not three rows from the end of the read',
    );
    assert.equal(first.stub.rowsOf(A).length, 3, '`first` over a truncated read still trims to the asked-for length');

    for (const keep_which of ['last', 'random'] as const) {
      const h = harness({ [A]: { rows } });
      await h.invoke('playlist_trim', { playlist_id: A, keep: 3, keep_which }).catch((e: Error) => e);
      assert.deepEqual(h.prompts, [], `\`${keep_which}\` must refuse rather than ask — the kept rows are the wrong rows`);
      assert.deepEqual(h.stub.rowsOf(A), rows, `\`${keep_which}\` must not rewrite the playlist from a read that never reached its end`);
    }
  });

  it('a playlist of cap + 1 rows refuses', async () => {
    const cap = getConfig().fetchAllCap;
    for (const { tool, args } of REWRITES) {
      const rows = trackUris(cap + 1);
      const h = harness({ [A]: { rows } });
      await h.invoke(tool, { playlist_id: A, ...args }).catch((e: Error) => e);

      assert.equal(
        h.stub.rowsOf(A).length,
        rows.length,
        `${tool} must refuse one row past the cap, not quietly drop that row`,
      );
      assert.deepEqual(h.stub.logOf(A).replaces, [], `${tool} must not open a replace one row past the cap`);
      // The refusal fires BEFORE any gate, so no prompt is shown. This is the
      // distinction that keeps #1310 from being a softer #872: one row past the
      // cap must not become a question the operator can answer "yes" to, and
      // #872's own prompt ("the true impact may be larger") would have been
      // exactly that question.
      assert.deepEqual(
        h.prompts,
        [],
        `${tool} must refuse outright rather than asking — a truncated read makes the RESULT wrong, not just its size`,
      );
    }
  });

  it('a dry run previews the refusal and writes nothing', async () => {
    // #860's rule: a preview is never blocked, so the caller can SEE that the
    // commit would be refused rather than discovering it at write time.
    const cap = getConfig().fetchAllCap;
    const rows = trackUris(cap + 1);
    const h = harness({ [A]: { rows } });
    const out = await h.invoke('playlist_reverse', { playlist_id: A, dry_run: true });

    assert.match(textOf(out), /\[dry run\]/);
    assert.match(textOf(out), /fetch-all cap/, 'the preview has to disclose the same refusal the commit would raise');
    assert.deepEqual(h.stub.rowsOf(A), rows);
    assert.deepEqual(h.stub.logOf(A).replaces, []);
  });

  it('refuses a walk that ended on a SHORT page while the server still counted more rows', async () => {
    // The second truncation shape, and the one the `cap + 1` probe alone
    // cannot see. A page that comes back with fewer items than the `limit` the
    // walk asked for is the normal end-of-data signal — but when Spotify's own
    // `total` still counts more rows, it is not the end, and a walk that
    // believes it is has read, say, 50 of 600 rows. `rows.length > cap` is
    // false at 50, so the pre-fix verdict says "read the whole playlist" and
    // the replace deletes the other 550. This is why the walk takes the
    // client's own verdict (#718/#864) instead of re-deriving it.
    const cap = getConfig().fetchAllCap;
    const total = cap + 100;
    const rows = trackUris(total);
    const shortPage = Math.floor(cap / 10); // 50 rows, well under the cap

    const client = new StubFromResponder(
      (path, params) => {
        const offset = Number((params as Record<string, string> | undefined)?.offset ?? 0) || 0;
        return {
          items: rows.slice(offset, offset + shortPage).map((u) => trackRowForUri(u)),
          // The server's own count says the walk is nowhere near done.
          total,
          limit: 100,
          offset,
        };
      },
      {
        writes: {
          POST: () => ({ snapshot_id: 'snap-post' }),
          PUT: () => ({ snapshot_id: 'snap-put' }),
          DELETE: () => null,
          PUT_RAW: () => undefined,
        },
      },
    );
    const registered: Array<{ name: string; validate: (a: Record<string, unknown>) => Record<string, unknown>; handler: (a: Record<string, unknown>) => Promise<ToolOut> }> = [];
    const fakeServer = {
      tool(name: string, _d: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
        registered.push({ name, validate: (a) => z.object(schema).parse(a), handler });
      },
      registerTool(name: string, config: { inputSchema?: z.ZodType<Record<string, unknown>> }, handler: RegisteredTool['handler']) {
        registered.push({ name, validate: (a) => (config.inputSchema as z.ZodType<Record<string, unknown>>).parse(a), handler });
      },
    } as unknown as McpServer;
    registerPlaylistTools(fakeServer, client as unknown as SpotifyClient);

    const tool = registered.find((t) => t.name === 'playlist_reverse');
    assert.ok(tool, 'playlist_reverse should be registered');
    await assert.rejects(
      () => tool.handler(tool.validate({ playlist_id: A })),
      (e: unknown) => e instanceof Error && /could only be read/.test(e.message),
      `a walk that read ${shortPage} of ${total} rows must refuse, not replace the playlist with ${shortPage} URIs`,
    );
    assert.deepEqual(
      client.calls.filter((c) => c.method === 'PUT' || c.method === 'POST' || c.method === 'DELETE'),
      [],
      'and it must not have opened a write of any kind',
    );
  });
});

describe('#1311 remove_unavailable_playlist_items never says "clean" over a capped walk', () => {
  it('does not issue an all-clear when an unavailable row sits past the cap', async () => {
    const cap = getConfig().fetchAllCap;
    // 0-based index 550 is past the 500-row walk and INSIDE the 601-row
    // playlist, so the tool reads 500 clean rows and the row it cannot see is
    // real. Reporting `verified` here is the false claim #1311 is filed on.
    const total = cap + 100;
    const rows: Array<string | null> = trackUris(total).map((u) => u);
    rows[cap + 50] = null;
    const h = harness({ [A]: { rows } });

    const out = await h.invoke('remove_unavailable_playlist_items', { playlist_id: A });

    assert.notEqual(
      sc(out).verification,
      'verified',
      `a walk that stopped at the cap cannot verify a playlist larger than the cap, yet the tool reported verification: "${sc(out).verification}"`,
    );
    assert.equal(sc(out).ok, false, 'an unverifiable all-clear is not a success');
    assert.equal(sc(out).truncated, true, 'the payload has to publish the completeness verdict');
    assert.equal(
      sc(out).unread_from_position,
      cap,
      'and name where the unread region begins, so the caller knows the gap is positional',
    );
    assert.match(
      textOf(out),
      /fetch-all cap/,
      'the prose has to say the walk was bounded — a bare `partial` in a field nobody reads is the same lie in a quieter voice',
    );
  });

  it('reports a bounded verdict, not `verified`, after removing what it did find', async () => {
    const cap = getConfig().fetchAllCap;
    const total = cap + 100;
    const rows: Array<string | null> = trackUris(total).map((u) => u);
    rows[10] = null; // inside the walk
    rows[cap + 50] = null; // past it
    const h = harness({ [A]: { rows } });

    const out = await h.invoke('remove_unavailable_playlist_items', { playlist_id: A });

    assert.equal(sc(out).removed, 1, 'the row it could see is genuinely removed');
    assert.deepEqual(
      h.stub.rowsOf(A).filter((r) => r === null).length,
      1,
      'the row past the cap is still there — the sweep can only see what it read',
    );
    assert.notEqual(
      sc(out).verification,
      'verified',
      'the post-write re-read is capped the same way, so it cannot certify the tail',
    );
    assert.equal(sc(out).truncated, true);
  });

  it('an at-cap playlist still gets a real all-clear', async () => {
    // The other half of the pair: refusing or downgrading every call would
    // make this tool useless on exactly the playlists it can handle.
    const cap = getConfig().fetchAllCap;
    const h = harness({ [A]: { rows: trackUris(cap) } });
    const out = await h.invoke('remove_unavailable_playlist_items', { playlist_id: A });

    assert.equal(sc(out).verification, 'verified');
    assert.equal(sc(out).ok, true);
    assert.equal(sc(out).truncated, false);
  });

  it('an at-cap playlist whose LAST row is unavailable is still verified', async () => {
    // Same cap, but now the last row IS unavailable and IS inside the read:
    // this is the pre-existing behaviour the fix must not break.
    const cap = getConfig().fetchAllCap;
    const rows: Array<string | null> = trackUris(cap).map((u) => u);
    rows[cap - 1] = null;
    const h = harness({ [A]: { rows } });

    const out = await h.invoke('remove_unavailable_playlist_items', { playlist_id: A });

    assert.equal(sc(out).removed, 1);
    assert.equal(sc(out).verification, 'verified');
    assert.equal(h.stub.rowsOf(A).filter((r) => r === null).length, 0);
  });
});
