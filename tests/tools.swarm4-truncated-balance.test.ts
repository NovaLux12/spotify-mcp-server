/**
 * #1388 — `playlist_balance` must not report a truncated read as the playlist.
 *
 * ## The bug
 *
 * `playlist_balance` is the one tool in `src/tools/swarm4_playlists.ts` that
 * #1362 left alone. It reads the source with the same bounded walk as its ten
 * siblings — `fetchAllItems`, `maxItems: cap + 1`, then clipped back to
 * `fetchAllCap` — and it kept the walk's verdict on the `LoadedPlaylist`; it
 * just never looked at it. The sibling tools answer a truncated read with
 * `assertPlaylistReadWhole(p)`, which throws. This one split what it read and
 * wrote the count into the result:
 *
 * ```
 * Split "…" (500 items) into 3 interleave playlists:
 * ```
 *
 * On a 600-row playlist at the default cap of 500, that sentence names the cap
 * as if it were the playlist's size, and nothing else in the response corrects
 * it. It is AGENTS.md §6's shape exactly: a correctly named payload field that
 * lies about its value, and a caller with no way to detect it.
 *
 * ## Why this is disclosure and not refusal
 *
 * `playlist_balance` is the only non-committing reader in the slice. It creates
 * NEW playlists and never writes to the source, so there is no atomic replace
 * for a short read to be mistaken for, and nothing the caller had yesterday is
 * gone after the call. The refusal in `rewritable.ts` rests on exactly that
 * asymmetry — "there is no partial-damage outcome to warn about, only rows the
 * caller still had" — and it does not transfer here. What does transfer is the
 * requirement that the answer be honest about its SCOPE, which is what
 * `merge_playlists`' `truncated` / `truncated_by_cap` / `rows_read` /
 * `reported_total` and `remove_unavailable_playlist_items`' `verification:
 * "partial"` already do on their own bounded reads.
 *
 * So the fix discloses. The tests below therefore assert the strong form: a
 * caller holding ONLY the response can tell a partial split from a whole one.
 *
 * ## What the assertions are made of
 *
 * `StatefulPlaylistClient`'s LIVE store, exactly as the #1362 suite does. The
 * stub inherits production `getAllPagesWithTruncation` and serves a real
 * `SpotifyPaged` with a live `total`, so the cap arithmetic and the `cap + 1`
 * probe are decided by production code. The cap is never written into these
 * tests: they move when `SPOTIFY_MCP_FETCH_ALL_CAP` moves.
 *
 * Run: node --import tsx --test tests/tools.swarm4-truncated-balance.test.ts
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
  description: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolOut>;
}

function harness() {
  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(name: string, description: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
      registered.push({ name, description, validate: (a) => z.object(schema).parse(a), handler });
    },
  } as unknown as McpServer;

  const stub = new StatefulPlaylistClient();
  registerSwarm4PlaylistsTools(fakeServer, stub as unknown as SpotifyClient);

  return {
    stub,
    seed: (id: string, rows: (string | null)[]) => stub.seedPlaylist(id, { rows }),
    descriptionOf: (name: string) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return tool.description;
    },
    invoke: async (name: string, args: Record<string, unknown>) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

const textOf = (out: ToolOut) => out.content[0]?.text ?? '';
const payloadOf = (out: ToolOut) => (out.structuredContent ?? {}) as Record<string, unknown>;

/** Run a real (non-dry-run) split and return both halves of the answer. */
async function split(
  h: ReturnType<typeof harness>,
  id: string,
  extra: Record<string, unknown> = {},
): Promise<ToolOut> {
  return h.invoke('playlist_balance', { playlist_id: id, parts: 3, dry_run: false, ...extra });
}

describe('#1388 a truncated read must be disclosed, not reported as the playlist', () => {
  it('cap+1: the payload says the split is partial and by how much', async () => {
    // The `cap + 1` probe row is the case. With `maxItems === cap + 1` a
    // cap+1-row playlist is not an overflow to the walk's own arithmetic, so
    // only the clip back to `cap` rows proves there was one more — and a
    // disclosure built on the walk's verdict alone goes quiet here.
    const cap = getConfig().fetchAllCap;
    const h = harness();
    h.seed(A, trackUris(cap + 1));

    const out = await split(h, A);
    const payload = payloadOf(out);

    assert.equal(payload.truncated, true, 'the split must report that the read was truncated');
    assert.equal(payload.items_read, cap, 'and how many rows it actually read');
    assert.equal(payload.items_total, cap + 1, "and the playlist's own size, so the gap is computable");
    assert.ok(
      (payload.items_total as number) > (payload.items_read as number),
      'items_total must be the SOURCE size, not the read size echoed back',
    );
  });

  it('cap+1: the probe row is absent from every created playlist', async () => {
    // The disclosure is only honest if the shortfall is real. A payload that
    // says `truncated: true` over a split that somehow covered the last row
    // would be the same lie wearing a warning label, and the probe row is what
    // tells the two apart.
    const cap = getConfig().fetchAllCap;
    const rows = trackUris(cap + 1);
    const h = harness();
    h.seed(A, rows);

    const out = await split(h, A);
    assert.equal(h.stub.created.length, 3, 'three parts are still created');
    const placed = h.stub.created.flatMap((c) => h.stub.urisOf(c.id));
    assert.equal(placed.length, cap, `the split placed ${placed.length} of ${rows.length} rows`);
    assert.ok(
      !placed.includes(rows[rows.length - 1]!),
      'the row past the cap was never read, so it cannot be in any part',
    );
    assert.deepEqual(
      [...new Set(placed)].sort(),
      rows.slice(0, cap).sort(),
      'what WAS split must be exactly the prefix that was read — the interleave may reorder, not invent or drop',
    );
    assert.ok(
      payloadOf(out).ok,
      'the split itself is a real, successful operation: new playlists exist, the source is untouched',
    );
  });

  it('a caller can tell a partial split from a whole one from the response alone', async () => {
    // The property the issue asks for, in the form a host consumes it: both
    // responses are read the same way, and they are not the same answer. No
    // prose, no call-site knowledge, no second request.
    const cap = getConfig().fetchAllCap;
    const h = harness();
    h.seed(A, trackUris(cap + 100));
    h.seed(B, trackUris(200));

    const partial = payloadOf(await split(h, A));
    const whole = payloadOf(await split(h, B, { response_format: 'json' }));

    assert.equal(partial.truncated, true);
    assert.equal(whole.truncated, false, 'a 200-row playlist at a 500 cap is a whole read');
    assert.equal(whole.items_read, 200);
    assert.equal(whole.items_total, 200);
    assert.notEqual(
      partial.items_total,
      partial.items_read,
      'a partial split must be distinguishable from a whole one by fields alone',
    );
    // The truncation-only fields must not be fabricated on a whole read, so a
    // caller cannot read `fetch_all_cap` as though the cap had bound anything.
    assert.equal(whole.fetch_all_cap, undefined, 'no cap was named, because no cap bound the read');
    assert.equal(whole.truncated_by_cap, undefined);
    assert.equal(partial.fetch_all_cap, cap, 'and on a partial split the ceiling is named');
    assert.equal(partial.truncated_by_cap, true, 'and so is which ceiling');
  });

  it('the prose cannot read as the playlist\'s size', async () => {
    // `Would affect 500 items:` in the dry run, and a summary of three part
    // counts that sum to the cap, are the false sentences #1388 is filed on.
    // The assertion that matters is the negative one: the cap must never be
    // rendered as a count of the playlist's items anywhere a caller can read
    // it. The only legitimate rendering of 500 here is "read 500 of 600".
    const cap = getConfig().fetchAllCap;
    const h = harness();
    h.seed(A, trackUris(cap + 100));

    for (const dryRun of [true, false] as const) {
      const out = await h.invoke('playlist_balance', { playlist_id: A, parts: 3, dry_run: dryRun });
      const text = textOf(out);
      const where = dryRun ? 'the dry run' : 'the commit';
      assert.doesNotMatch(
        text,
        new RegExp(`\\b${cap} items?\\b`),
        `${where} renders the cap as a count of the playlist's items — the false claim this issue is filed on`,
      );
      assert.match(
        text,
        new RegExp(`read ${cap} of ${cap + 100} row\\(s\\)`),
        `${where} has to name what was read out of what the playlist holds`,
      );
      assert.match(text, /PARTIAL SPLIT/, `${where} has to say the parts are partial`);
      assert.match(
        text,
        /SPOTIFY_MCP_FETCH_ALL_CAP/,
        `${where} names no remedy, so a partial answer gets no retry`,
      );
    }
  });

  it('a dry run discloses the same way the commit does', async () => {
    // The #1362 suite pins the mirror image for refusals: a preview that
    // promises something the outcome will not deliver is not a preview. Here
    // the outcome DOES deliver — a partial split — so the preview has to
    // describe the partial split, or the caller commits on a plan that reads
    // as whole.
    const cap = getConfig().fetchAllCap;
    const h = harness();
    h.seed(A, trackUris(cap + 100));

    const out = await h.invoke('playlist_balance', { playlist_id: A, parts: 3, dry_run: true });
    assert.equal(payloadOf(out).truncated, true, 'the preview reports the same verdict as the commit');
    assert.equal(h.stub.created.length, 0, 'and it still creates nothing');
    assert.match(textOf(out), new RegExp(`read\\s+${cap} of ${cap + 100}\\b`));
  });

  it('a source whose own count is unreadable reports null, never the read size', async () => {
    // The rule from `loadPlaylistFull`: an unread count is never substituted
    // with the count that could be read. `items_total: 500` on a walk that
    // stopped at 500 would turn "I don't know how big this is" into "this is
    // the whole thing", which is the defect again, one layer in.
    const cap = getConfig().fetchAllCap;
    const h = harness();
    h.seed(A, trackUris(cap + 100));
    // Same regex route the mock registered, re-registered later so it wins:
    // metadata that carries no count at all, and an item page that reports no
    // `total` either. The walk still stops at the cap.
    h.stub.route('GET', /^\/playlists\/[^/]+$/, {
      respond: () => ({ id: A, name: 'Sourceless', items: {} }),
    });
    h.stub.route('GET', /^\/playlists\/[^/]+\/items$/, {
      respond: (call) => {
        const offset = Number(((call.arg ?? {}) as { offset?: string }).offset ?? 0) || 0;
        const slice = trackUris(cap + 100).slice(offset, offset + 100);
        return {
          items: slice.map((uri) => ({ added_at: '2026-01-01T00:00:00Z', item: { type: 'track', id: uri, uri } })),
          limit: 100,
          offset,
          next: offset + slice.length < cap + 100 ? `offset=${offset + slice.length}` : null,
        };
      },
    });

    const payload = payloadOf(await split(h, A));
    assert.equal(payload.truncated, true, 'the walk stopped early, so it is still truncated');
    assert.equal(payload.items_total, null, 'an unread total is null — never the rows that were read');
    assert.equal(payload.items_read, cap);
  });

  it('a whole read is unchanged: no disclosure, no cap, no refusal', async () => {
    // The half of the pair a 600-row fixture cannot reach. A test that only
    // ever asserts "truncated says true" is satisfied by a tool that says true
    // unconditionally, which would be a worse bug than the one being fixed.
    const cap = getConfig().fetchAllCap;
    const h = harness();
    h.seed(A, trackUris(cap));

    const out = await split(h, A);
    const payload = payloadOf(out);
    assert.equal(payload.truncated, false, 'exactly the cap is a whole read');
    assert.equal(payload.items_read, cap);
    assert.equal(payload.items_total, cap);
    assert.equal(h.stub.created.length, 3, 'and the split still happens');
    assert.equal(
      h.stub.created.flatMap((c) => h.stub.urisOf(c.id)).length,
      cap,
      'every row read is placed in some part',
    );
    assert.doesNotMatch(textOf(out), /SPOTIFY_MCP_FETCH_ALL_CAP/, 'nothing on a whole read names a shortfall');
  });

  it('the source is never written, on a whole read or a short one', async () => {
    // The property that decides the whole design: whatever the read, the
    // premise of the tool is that the source is left alone. If a future change
    // made it rewrite, the disclosure would be downgrading a destruction
    // rather than disclosing a copy.
    const cap = getConfig().fetchAllCap;
    for (const size of [cap, cap + 100]) {
      const h = harness();
      const rows = trackUris(size);
      h.seed(A, rows);
      await split(h, A);
      assert.deepEqual(h.stub.rowsOf(A), rows, `a ${size}-row source must come back exactly as seeded`);
      assert.deepEqual(h.stub.logOf(A).replaces, [], 'and must never be PUT over');
      assert.deepEqual(h.stub.logOf(A).deletes, [], 'and must never be spliced');
    }
  });
});

describe('#1388 the tool description has to survive being conditionally true', () => {
  it('the interleave claim names the span it actually dealt', async () => {
    // `"round-robin deal, so every part samples the whole span"` is visible to
    // every host BEFORE the call, on a tool that will happily deal a truncated
    // span. It is a claim about which rows the parts contain, and after #1388
    // the answer is "the rows the read returned", so the description has to say
    // which rows those are. The first assertion is a precondition: if the
    // interleave claim were reworded out of the description the second would
    // pass vacuously.
    const description = harness().descriptionOf('playlist_balance');
    assert.match(description, /whole span/, 'the interleave claim still stands, and is still legible');
    assert.match(
      description,
      /span[^.]*\bread\b/i,
      'the sentence that promises a whole span has to also name the read, or it is a claim about the playlist',
    );
    assert.match(
      description,
      /SPOTIFY_MCP_FETCH_ALL_CAP|fetch-all cap/i,
      'a host that only ever reads descriptions has to learn the span can be bounded',
    );
  });

  it('the description admits a partial split rather than promising a whole one', () => {
    const description = harness().descriptionOf('playlist_balance');
    assert.match(
      description,
      /partial|part of the playlist|only part/i,
      'the caller has to be able to learn from the description alone that a big playlist is not split whole',
    );
  });
});

describe('#1388 the shortfall is disclosed wherever a count is reported', () => {
  it('the too-few-items early return does not claim the playlist has n items', async () => {
    // `has N item(s) — fewer than the parts requested` is the same false count
    // in the branch a short read is most likely to reach: a walk that ends on
    // a short page with rows still unread can leave n below `parts` while the
    // playlist itself holds far more, and then the tool refuses a split it
    // could have made. The refusal stands; what it may not do is state the
    // playlist's size as a number it did not read.
    const h = harness();
    h.seed(B, ['spotify:track:a', 'spotify:track:b']);
    const out = await h.invoke('playlist_balance', { playlist_id: B, parts: 3, dry_run: true });
    const payload = payloadOf(out);
    assert.equal(payload.ok, false);
    assert.equal(payload.items_read, 2, 'the count is named for what it is');
    assert.equal(payload.items_total, 2, 'and the source count beside it');
    assert.equal(payload.truncated, false, 'a 2-row playlist read whole is not truncated');
  });
});

// Kept as a source-level guard alongside the behavioural ones. The behavioural
// tests drive the tool; this one pins the shape that makes the disclosure
// impossible to drop by accident — the truncation verdict is READ in this tool
// the way the ten siblings read theirs, and `items` never regains a meaning
// that "rows the playlist has".
describe('#1388 the disclosure cannot be dropped by accident', () => {
  it('the tool reads the walk verdict, and no `items: n` is left standing in for it', () => {
    const src = readFileSync(new URL('../src/tools/swarm4_playlists.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf("'playlist_balance',"));
    const end = body.indexOf('\n  );\n}');
    const tool = body.slice(0, end > -1 ? end : undefined);

    assert.match(
      tool,
      /p\.truncated/,
      'playlist_balance must read the truncation verdict #1362 already put on the LoadedPlaylist',
    );
    assert.match(tool, /items_read/, 'and report what it read, by a name that says so');
    assert.match(tool, /items_total/, "beside the playlist's own size");
    assert.doesNotMatch(
      tool,
      /^\s*items:\s*n\s*,?\s*$/m,
      'a bare `items: n` is the field this issue exists to remove: it reads as the playlist, not the read',
    );
  });
});
