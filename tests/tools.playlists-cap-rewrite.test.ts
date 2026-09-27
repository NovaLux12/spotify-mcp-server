/**
 * #881 — behaviour tests for the playlist rewrite family against REAL state.
 *
 * The seven tools here (sort, shuffle, reverse, trim, union, subtract,
 * symmetric_difference) commit through one shared helper,
 * `replaceWithUris`, and every one of them is a *sequence* rather than a
 * single call: walk the playlist, decide an order, `PUT` the first chunk,
 * `POST` the rest. Until now the harnesses answered every call from a fixed
 * table, so they could pin the first `PUT` and nothing after it — the
 * questions that decide whether a destructive tool is correct (did chunk 2
 * land, does the store really hold the new order, is a >100-URI write split
 * at 100) had no observable subject.
 *
 * `StatefulPlaylistClient` gives them one: `PUT` replaces, `POST` appends,
 * `DELETE` splices the named positions, and the item read pages the CURRENT
 * rows with the CURRENT count. The route table is still strict — an unseeded
 * playlist id throws rather than answering as an empty playlist — so this is
 * a mutable mock, not a permissive one.
 *
 * The cap is likewise not copied here. The mock never names
 * `SPOTIFY_MCP_FETCH_ALL_CAP`; it hands the inherited `getAllPages` a real
 * envelope and lets production decide. `OVER_CAP` is 600 rows against the
 * default cap of 500, which is the fixture the issue's acceptance criterion
 * asks for.
 *
 * Run: node --import tsx --test tests/tools.playlists-cap-rewrite.test.ts
 */

import './helpers/hermetic.js';

import { afterEach, describe, it } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerPlaylistTools } from '../src/tools/playlists.js';
import { StatefulPlaylistClient, trackUris } from './helpers/stub-client.js';
import type { SeededPlaylist } from './helpers/stub-client.js';
import { CHUNK_CAPS } from '../src/chunk.js';
import { getConfig } from '../src/config.js';

// Every gate in this file resolves "unsupported, allowed" when this is set,
// which would silently reopen the fail-closed case. The other confirmation
// suites in the repo clear it in afterEach; so does this one.
afterEach(() => {
  delete process.env.SPOTIFY_MCP_CONFIRM;
});

/** Spotify playlist ids are 22 base62 characters. */
const A = 'A'.repeat(22);
const B = 'B'.repeat(22);
const C = 'C'.repeat(22);

/** 600 rows: past the default SPOTIFY_MCP_FETCH_ALL_CAP of 500. */
const OVER_CAP = 600;
/** 250 rows: past the 100-per-request playlist write cap, under the read cap. */
const CHUNKED = 250;
/** The write chunk size every tool in this family commits through. */
const WRITE_CAP = CHUNK_CAPS.playlist_writes;

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

interface Harness {
  stub: StatefulPlaylistClient;
  /** Confirmation prompts the tools raised, in order. */
  prompts: string[];
  registered: () => RegisteredTool[];
  invoke: (name: string, args?: Record<string, unknown>) => Promise<ToolOut>;
}

/** How the fake client answers a confirmation prompt. */
interface HarnessOptions {
  /** The elicitation reply. Omit for the operator accepting. */
  elicit?: unknown;
  /**
   * `false` models a client that advertised no elicitation capability at all,
   * so `confirmViaElicitation` cannot even ask. Distinct from omitting
   * `elicit`, which would silently fall back to the accepting default.
   */
  canElicit?: boolean;
}

/**
 * A stub MCP server that advertises elicitation, plus the stateful client.
 */
function harness(seed: Record<string, SeededPlaylist>, opts: HarnessOptions = {}): Harness {
  const { canElicit = true, elicit = { action: 'accept', content: { confirm: true } } } = opts;
  const registered: RegisteredTool[] = [];
  const prompts: string[] = [];
  const fakeServer = {
    tool(name: string, description: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
      registered.push({ name, description, validate: (a) => z.object(schema).parse(a), handler });
    },
    registerTool(name: string, config: { description?: string; inputSchema?: z.ZodType }, handler: RegisteredTool['handler']) {
      registered.push({ name, description: config.description ?? '', validate: (a) => (config.inputSchema as z.ZodType).parse(a), handler });
    },
    ...(canElicit
      ? {
          // Real McpServer shape: both the capability accessor and the prompt
          // live on the inner Server the wrapper exposes as `.server`.
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

  return {
    stub,
    prompts,
    registered: () => registered,
    invoke: async (name, args = {}) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

const textOf = (out: ToolOut) => out.content[0]?.text ?? '';
const sc = (out: ToolOut) => out.structuredContent ?? {};

/** Rows whose names sort in a known order, so the committed order is checkable. */
function orderedRows(n: number, start = 0): string[] {
  // Zero-padded so lexical order matches numeric order; the mock derives
  // `Track <id>` as the name, and `playlist_sort` sorts on that name.
  return Array.from({ length: n }, (_, i) => `spotify:track:${String(i + start).padStart(4, '0')}`);
}

describe('#881 the rewrite family is registered', () => {
  it('registers all seven tools with a description each', () => {
    const h = harness({ [A]: { rows: [] } });
    const byName = new Map(h.registered().map((t) => [t.name, t]));
    for (const name of [
      'playlist_sort',
      'playlist_shuffle',
      'playlist_reverse',
      'playlist_trim',
      'playlist_union',
      'playlist_subtract',
      'playlist_symmetric_difference',
    ]) {
      const tool = byName.get(name);
      assert.ok(tool, `${name} should be registered by registerPlaylistTools`);
      assert.ok(tool.description.length > 20, `${name} should carry a real description`);
    }
  });
});

describe('#881 playlist_sort commits the sorted order', () => {
  it('sorts by name and the store ends up in that order', async () => {
    const h = harness({ [A]: { rows: orderedRows(5).reverse() } });
    try {
      const out = await h.invoke('playlist_sort', { playlist_id: A, sort_by: 'name_asc' });

      assert.match(textOf(out), /Sorted 5 item\(s\) by name_asc/);
      assert.deepEqual(
        h.stub.urisOf(A),
        orderedRows(5),
        'the observable is the LIVE store, not the order the tool claims it wrote',
      );
      // And the write actually happened through the atomic replace, once.
      assert.equal(h.stub.logOf(A).replaces.length, 1);
    } finally {
      /* no session state to release */
    }
  });

  it('descending is the mirror image, so the sign is not hardcoded', async () => {
    const h = harness({ [A]: { rows: orderedRows(5) } });
    await h.invoke('playlist_sort', { playlist_id: A, sort_by: 'name_desc' });
    assert.deepEqual(h.stub.urisOf(A), orderedRows(5).reverse());
  });

  it('sorting by duration uses the duration key, so it lands in a different order than a name sort', async () => {
    // The mock varies `duration_ms` with the numeric tail of each uri, so a
    // tool that ignored `sort_by` and fell back to the name would produce the
    // name order and fail the assertion below. A fixture with one duration
    // everywhere would pass either way, which is why the mock varies it.
    const rows = orderedRows(8);
    const byName = harness({ [A]: { rows: rows.slice().reverse() } });
    await byName.invoke('playlist_sort', { playlist_id: A, sort_by: 'name_asc' });
    const nameOrder = byName.stub.urisOf(A);

    const byDuration = harness({ [A]: { rows: rows.slice().reverse() } });
    await byDuration.invoke('playlist_sort', { playlist_id: A, sort_by: 'duration_asc' });
    const durationOrder = byDuration.stub.urisOf(A);

    const durations = (uris: string[]) => uris.map((u) => 60_000 + (Number(/(\d+)$/.exec(u)?.[1] ?? 0) % 7) * 30_000);
    assert.deepEqual(
      durations(durationOrder),
      [...durations(durationOrder)].sort((x, y) => x - y),
      'the committed order must be non-decreasing in duration',
    );
    assert.notDeepEqual(durationOrder, nameOrder, 'a duration sort that produced the name order would be a name sort');
  });

  it('a dry run writes nothing and previews the order it would commit', async () => {
    const before = orderedRows(4).reverse();
    const h = harness({ [A]: { rows: before } });
    const out = await h.invoke('playlist_sort', { playlist_id: A, sort_by: 'name_asc', dry_run: true });

    assert.match(textOf(out), /\[dry run\]/);
    assert.match(textOf(out), /Would sort 4 items by name_asc/);
    assert.deepEqual(h.stub.rowsOf(A), before, 'a dry run must not touch the playlist');
    assert.deepEqual(h.stub.logOf(A).replaces, [], 'a dry run must issue no replace');
  });
});

describe('#881 a >100-URI replace is chunked at the documented cap', () => {
  it('playlist_sort PUTs the first chunk and POSTs the rest', async () => {
    const rows = orderedRows(CHUNKED).reverse();
    const h = harness({ [A]: { rows } });
    try {
      await h.invoke('playlist_sort', { playlist_id: A, sort_by: 'name_asc', max_results: 5 });

      const log = h.stub.logOf(A);
      const expectedChunks = Math.ceil(CHUNKED / WRITE_CAP);
      assert.equal(log.replaces.length, 1, 'the first chunk is the atomic PUT; only the overflow POSTs');
      assert.equal(log.replaces[0]?.uris.length, WRITE_CAP, 'the first chunk is exactly the write cap');
      assert.deepEqual(
        log.appends.map((a) => a.uris.length),
        [WRITE_CAP, CHUNKED - 2 * WRITE_CAP],
        'the overflow is split at the same cap',
      );
      assert.equal(log.appends.length + 1, expectedChunks);
      assert.deepEqual(
        h.stub.urisOf(A),
        orderedRows(CHUNKED),
        'every row survived, in the sorted order — a lost chunk would be visible here',
      );
    } finally {
      /* no session state to release */
    }
  });

  it('playlist_reverse writes the whole reversed order across the same chunks', async () => {
    const rows = orderedRows(CHUNKED);
    const h = harness({ [A]: { rows } });
    try {
      await h.invoke('playlist_reverse', { playlist_id: A });
      assert.deepEqual(h.stub.urisOf(A), rows.slice().reverse());
      assert.equal(h.stub.logOf(A).replaces[0]?.uris.length, WRITE_CAP);
      assert.equal(h.stub.logOf(A).appends.length, Math.ceil(CHUNKED / WRITE_CAP) - 1);
    } finally {
      /* no session state to release */
    }
  });
});

describe('#881 playlist_shuffle', () => {
  it('a seeded shuffle is deterministic: the same seed lands the same order twice', async () => {
    const rows = orderedRows(30);
    const first = harness({ [A]: { rows } });
    await first.invoke('playlist_shuffle', { playlist_id: A, seed: 'reproducible' });
    const order = first.stub.urisOf(A);

    const second = harness({ [A]: { rows } });
    await second.invoke('playlist_shuffle', { playlist_id: A, seed: 'reproducible' });

    assert.deepEqual(
      second.stub.urisOf(A),
      order,
      'a seeded shuffle must be a function of the seed and the input, not of Math.random',
    );
    assert.deepEqual([...order].sort(), [...rows].sort(), 'a shuffle is a permutation, never a lossy rewrite');
    assert.notDeepEqual(order, rows, 'and it must actually reorder — an identity permutation would satisfy the line above too');
  });

  it('a different seed produces a different order', async () => {
    const rows = orderedRows(30);
    const a = harness({ [A]: { rows } });
    await a.invoke('playlist_shuffle', { playlist_id: A, seed: 'one' });
    const b = harness({ [A]: { rows } });
    await b.invoke('playlist_shuffle', { playlist_id: A, seed: 'two' });
    assert.notDeepEqual(a.stub.urisOf(A), b.stub.urisOf(A));
  });

  it('a dry run shuffles nothing', async () => {
    const rows = orderedRows(10);
    const h = harness({ [A]: { rows } });
    const out = await h.invoke('playlist_shuffle', { playlist_id: A, seed: 'x', dry_run: true });
    assert.match(textOf(out), /\[dry run\] shuffle playlist/);
    assert.match(textOf(out), /Would shuffle 10 items/);
    assert.deepEqual(h.stub.rowsOf(A), rows);
    assert.deepEqual(h.stub.logOf(A).replaces, []);
  });
});

describe('#881 playlist_reverse', () => {
  it('reverses the full order', async () => {
    const rows = orderedRows(6);
    const h = harness({ [A]: { rows } });
    const out = await h.invoke('playlist_reverse', { playlist_id: A });
    assert.match(textOf(out), /Reversed 6 item\(s\)/);
    assert.deepEqual(h.stub.urisOf(A), rows.slice().reverse());
  });

  it('a dry run writes nothing', async () => {
    const rows = orderedRows(6);
    const h = harness({ [A]: { rows } });
    const out = await h.invoke('playlist_reverse', { playlist_id: A, dry_run: true });
    assert.match(textOf(out), /\[dry run\] reverse playlist/);
    assert.match(textOf(out), /Would reverse 6 items/);
    assert.deepEqual(h.stub.rowsOf(A), rows);
    assert.deepEqual(h.stub.logOf(A).replaces, []);
  });
});

describe('#881 playlist_trim', () => {
  const rows = orderedRows(12);

  it('keep first trims to the first N', async () => {
    const h = harness({ [A]: { rows } });
    const out = await h.invoke('playlist_trim', { playlist_id: A, keep: 4, keep_which: 'first' });
    assert.match(textOf(out), /Trimmed 12 → 4 \(first\)/);
    assert.deepEqual(h.stub.urisOf(A), rows.slice(0, 4));
  });

  it('keep last trims to the last N, and is not the same answer as first', async () => {
    const h = harness({ [A]: { rows } });
    await h.invoke('playlist_trim', { playlist_id: A, keep: 4, keep_which: 'last' });
    assert.deepEqual(h.stub.urisOf(A), rows.slice(-4), 'a `last` trim that kept the head would pass an identity check but not this one');
  });

  it('keep random keeps exactly N, all of them real rows of this playlist', async () => {
    const h = harness({ [A]: { rows } });
    await h.invoke('playlist_trim', { playlist_id: A, keep: 5, keep_which: 'random' });
    const kept = h.stub.urisOf(A);
    assert.equal(kept.length, 5);
    assert.deepEqual([...kept].sort(), rows.filter((u) => kept.includes(u)).sort(), 'every kept URI must come from the playlist');
    assert.equal(new Set(kept).size, 5, 'a trim must not duplicate a row');
  });

  it('a playlist already at or below the target is left alone, with no write at all', async () => {
    const h = harness({ [A]: { rows: rows.slice(0, 4) } });
    const out = await h.invoke('playlist_trim', { playlist_id: A, keep: 4 });
    assert.match(textOf(out), /already 4 ≤ 4 — nothing to trim/);
    assert.deepEqual(h.stub.logOf(A).replaces, [], 'a no-op trim must not open a rewrite');
  });

  it('a dry run writes nothing', async () => {
    const h = harness({ [A]: { rows } });
    const out = await h.invoke('playlist_trim', { playlist_id: A, keep: 3, dry_run: true });
    assert.match(textOf(out), /\[dry run\] trim playlist/);
    assert.match(textOf(out), /Would trim 12 → 3/);
    assert.deepEqual(h.stub.rowsOf(A), rows);
  });
});

describe('#881 playlist_union', () => {
  it('merges in first-seen order and drops cross-source duplicates by default', async () => {
    const h = harness({
      [A]: { rows: ['spotify:track:1', 'spotify:track:2', 'spotify:track:3'] },
      [B]: { rows: ['spotify:track:2', 'spotify:track:4'] },
      [C]: { rows: [] },
    });
    try {
      const out = await h.invoke('playlist_union', { playlists: [A, B, C], target_playlist_id: A });

      assert.equal(sc(out).uri_count, 4, 'dedupe is on by default');
      assert.deepEqual(
        h.stub.urisOf(A),
        ['spotify:track:1', 'spotify:track:2', 'spotify:track:3', 'spotify:track:4'],
        'first-seen order, with the shared row kept where it first appeared',
      );
    } finally {
      /* no session state to release */
    }
  });

  it('dedupe:false keeps the repeat, so the flag is not decorative', async () => {
    const h = harness({
      [A]: { rows: ['spotify:track:1'] },
      [B]: { rows: ['spotify:track:1'] },
    });
    try {
      const out = await h.invoke('playlist_union', { playlists: [A, B], target_playlist_id: A, dedupe: false });
      assert.equal(sc(out).uri_count, 2);
      assert.deepEqual(h.stub.urisOf(A), ['spotify:track:1', 'spotify:track:1']);
    } finally {
      /* no session state to release */
    }
  });

  it('creates the target when given a name, and nothing is created when an id is given', async () => {
    const created = harness({ [A]: { rows: ['spotify:track:1'] }, [B]: { rows: ['spotify:track:2'] } });
    try {
      const out = await created.invoke('playlist_union', { playlists: [A, B], target_name: 'Merged' });
      assert.equal(sc(out).created, true);
      assert.deepEqual(created.stub.created, [{ id: 'created0', name: 'Merged', public: false }]);
      assert.deepEqual(created.stub.urisOf('created0'), ['spotify:track:1', 'spotify:track:2']);
    } finally {
      /* no session state to release */
    }

    const existing = harness({ [A]: { rows: ['spotify:track:1'] }, [B]: { rows: [] }, [C]: { rows: [] } });
    try {
      await existing.invoke('playlist_union', { playlists: [B, C], target_playlist_id: A });
      assert.deepEqual(existing.stub.created, [], 'an existing target must not be re-created');
    } finally {
      /* no session state to release */
    }
  });

  it('a target that already holds exactly the union is a no-op: no prompt, no write', async () => {
    const h = harness({
      [A]: { rows: ['spotify:track:1', 'spotify:track:2'] },
      [B]: { rows: ['spotify:track:1'] },
    });
    try {
      const out = await h.invoke('playlist_union', { playlists: [A, B], target_playlist_id: A });
      assert.equal(sc(out).unchanged, true);
      assert.deepEqual(h.stub.logOf(A).replaces, [], 'a proven no-op must not open a rewrite');
      assert.deepEqual(h.prompts, [], 'and must not ask to replace something with itself');
    } finally {
      /* no session state to release */
    }
  });

  it('a destructive union asks first, and a declined prompt leaves the playlist alone', async () => {
    const accepted = harness({
      [A]: { rows: ['spotify:track:1', 'spotify:track:2'] },
      [B]: { rows: ['spotify:track:9'] },
      [C]: { rows: [] },
    });
    try {
      await accepted.invoke('playlist_union', { playlists: [B, C], target_playlist_id: A });
      assert.equal(accepted.prompts.length, 1, 'dropping rows makes impact non-identical, so the gate must fire');
      assert.match(accepted.prompts[0] ?? '', /About to replace playlist items/);
      assert.match(accepted.prompts[0] ?? '', /Remove 2 existing item\(s\) absent from the union/);
      assert.deepEqual(accepted.stub.urisOf(A), ['spotify:track:9']);
    } finally {
      /* no session state to release */
    }

    const declined = harness(
      { [A]: { rows: ['spotify:track:1'] }, [B]: { rows: ['spotify:track:9'] }, [C]: { rows: [] } },
      { elicit: { action: 'decline' } },
    );
    try {
      const out = await declined.invoke('playlist_union', { playlists: [B, C], target_playlist_id: A });
      assert.equal(sc(out).cancelled, true);
      assert.deepEqual(declined.stub.rowsOf(A), ['spotify:track:1'], 'a decline is a refusal, never a silent proceed');
      assert.deepEqual(declined.stub.logOf(A).replaces, []);
    } finally {
      /* no session state to release */
    }
  });
});

describe('#881 the fetch-all cap is real, and the union path says so', () => {
  it('a source past SPOTIFY_MCP_FETCH_ALL_CAP is walked only to the cap and reported truncated', async () => {
    const cap = getConfig().fetchAllCap;
    assert.ok(
      OVER_CAP > cap,
      `this fixture must exceed the cap it is testing; ${OVER_CAP} rows against a cap of ${cap}`,
    );
    const h = harness({ [A]: { rows: trackUris(OVER_CAP) }, [B]: { rows: [] }, [C]: { rows: [] } });
    try {
      const out = await h.invoke('playlist_union', {
        playlists: [A, C],
        target_playlist_id: B,
        dry_run: true,
        max_results: 3,
      });

      assert.equal(sc(out).source_truncated, true, 'a walk that stopped at the cap must be reported, not summarised as "read it all"');
      assert.equal(sc(out).scan_cap, cap, 'the payload names the cap that bound the walk');
      assert.match(textOf(out), new RegExp(`reached the configured cap of ${cap} rows`));
      assert.equal(sc(out).total, cap, 'the union carries the cap worth of rows, not the 600 the playlist holds');
      assert.equal(sc(out).uris.length, 3, 'the render cap is separate from the read cap');
      assert.deepEqual(h.stub.logOf(B).replaces, [], 'a dry run issues no write whatever the cap did');
    } finally {
      /* no session state to release */
    }
  });

  it('a destructive union over a truncated source puts the incompleteness in the prompt', async () => {
    const cap = getConfig().fetchAllCap;
    const h = harness({ [A]: { rows: trackUris(OVER_CAP) }, [B]: { rows: [] }, [C]: { rows: [] } });
    try {
      await h.invoke('playlist_union', { playlists: [A, C], target_playlist_id: B });

      assert.equal(h.prompts.length, 1);
      assert.match(
        h.prompts[0] ?? '',
        /union is incomplete, so items missing from it would be removed/,
        'the only place the incomplete read can still be disclosed is the prompt that authorises the loss',
      );
      assert.equal(h.stub.urisOf(B).length, cap);
    } finally {
      /* no session state to release */
    }
  });

  it('a base past the cap is reported as not fully read, and the prompt says the impact may be larger', async () => {
    const cap = getConfig().fetchAllCap;
    const rows = trackUris(OVER_CAP);
    const h = harness({ [A]: { rows }, [B]: { rows: [rows[0]!] } });
    try {
      // Dry run first: this is where the payload names the completeness
      // verdict, so the flag is asserted where it is actually published.
      const preview = await h.invoke('playlist_subtract', { base_playlist_id: A, playlists: [B], dry_run: true, max_results: 2 });
      assert.equal(sc(preview).base_read_whole, false, 'a base read to the cap is not a read of the whole base');
      assert.equal(sc(preview).base_existing_rows, cap, 'the read stopped at the cap');
      assert.equal(sc(preview).scan_cap, cap);

      // And the commit path has to say it in the one place the operator can
      // still act on it: the prompt that authorises the overwrite.
      const out = await h.invoke('playlist_subtract', { base_playlist_id: A, playlists: [B] });
      assert.equal(h.prompts.length, 1);
      assert.match(
        h.prompts[0] ?? '',
        new RegExp(`Only ${cap} of ${OVER_CAP} existing row\\(s\\) could be read, so the true impact may be larger`),
        'a partial read is disclosed at the prompt, or the operator authorises a loss nobody quantified',
      );
      assert.equal(h.stub.urisOf(A).length, cap - 1);
      assert.equal(sc(out).removed_total, 1);
    } finally {
      /* no session state to release */
    }
  });
});

describe('#881 playlist_subtract', () => {
  it('removes the subtraction set and keeps the rest, in the base order', async () => {
    const rows = ['spotify:track:1', 'spotify:track:2', 'spotify:track:3', 'spotify:track:4'];
    const h = harness({ [A]: { rows }, [B]: { rows: ['spotify:track:2', 'spotify:track:4'] } });
    try {
      const out = await h.invoke('playlist_subtract', { base_playlist_id: A, playlists: [B] });

      assert.equal(sc(out).removed_total, 2);
      assert.equal(sc(out).kept_total, 2);
      assert.deepEqual(h.stub.urisOf(A), ['spotify:track:1', 'spotify:track:3'], 'the survivors keep their original order');
    } finally {
      /* no session state to release */
    }
  });

  it('a source that shares nothing leaves the base alone and never prompts', async () => {
    const rows = ['spotify:track:1'];
    const h = harness({ [A]: { rows }, [B]: { rows: ['spotify:track:99'] } });
    try {
      const out = await h.invoke('playlist_subtract', { base_playlist_id: A, playlists: [B] });
      assert.equal(sc(out).unchanged, true);
      assert.deepEqual(h.stub.logOf(A).replaces, []);
      assert.deepEqual(h.prompts, []);
    } finally {
      /* no session state to release */
    }
  });

  it('refuses a base that is also a subtraction source', async () => {
    const h = harness({ [A]: { rows: ['spotify:track:1'] } });
    await assert.rejects(
      () => h.invoke('playlist_subtract', { base_playlist_id: A, playlists: [A] }),
      /must not include the base playlist/,
    );
    assert.deepEqual(h.stub.logOf(A).replaces, []);
  });

  it('a dry run previews the removal set and writes nothing', async () => {
    const rows = ['spotify:track:1', 'spotify:track:2', 'spotify:track:3'];
    const h = harness({ [A]: { rows }, [B]: { rows: ['spotify:track:2'] } });
    try {
      const out = await h.invoke('playlist_subtract', { base_playlist_id: A, playlists: [B], dry_run: true });
      assert.deepEqual(sc(out).removed_uris, ['spotify:track:2']);
      assert.deepEqual(sc(out).uris, ['spotify:track:1', 'spotify:track:3']);
      assert.deepEqual(h.stub.rowsOf(A), rows);
      assert.deepEqual(h.stub.logOf(A).replaces, []);
    } finally {
      /* no session state to release */
    }
  });

  it('a client that cannot prompt is refused, and nothing is written', async () => {
    // `requiredConfirmationRefusal()` fails closed on an unsupported client.
    // Elicit the verdict, assert the refusal, and prove the store is intact —
    // a permissive stub here would let the write through and the test would
    // still be green, because the write is the thing that must not happen.
    const rows = ['spotify:track:1', 'spotify:track:2'];
    const h = harness({ [A]: { rows }, [B]: { rows: ['spotify:track:1'] } }, { canElicit: false });
    try {
      const out = await h.invoke('playlist_subtract', { base_playlist_id: A, playlists: [B] });
      assert.equal(sc(out).ok, false);
      assert.equal(sc(out).cancelled, true);
      assert.equal(sc(out).reason, 'confirmation_unavailable');
      assert.deepEqual(h.stub.rowsOf(A), rows, 'an unpromptable confirmation is a refusal, never a silent proceed');
      assert.deepEqual(h.stub.logOf(A).replaces, []);
    } finally {
      /* no session state to release */
    }
  });
});

describe('#881 playlist_symmetric_difference', () => {
  it('keeps the rows in exactly one playlist, first-seen, deduped', async () => {
    const h = harness({
      [A]: { rows: ['spotify:track:1', 'spotify:track:2', 'spotify:track:3'] },
      [B]: { rows: ['spotify:track:2', 'spotify:track:3', 'spotify:track:4'] },
    });
    try {
      const out = await h.invoke('playlist_symmetric_difference', { playlist_a: A, playlist_b: B });
      const payload = sc(out);

      assert.deepEqual(
        payload.symmetric_difference,
        ['spotify:track:1', 'spotify:track:4'],
        'shared rows appear in neither; the symmetric difference is 1,4 and not 1,4 plus the shared pair',
      );
      assert.equal(payload.total, 2);
      assert.match(textOf(out), /Symmetric difference: 2 uri\(s\)/);
      // Read-only: two GETs, no writes.
      assert.deepEqual(h.stub.logOf(A).replaces, []);
      assert.deepEqual(h.stub.logOf(B).replaces, []);
      assert.equal(
        h.stub.calls.filter((c) => c.method !== 'GET').length,
        0,
        'a set read must issue no write of any kind',
      );
    } finally {
      /* no session state to release */
    }
  });

  it('an identical pair has an empty difference, not the shared rows', async () => {
    const h = harness({
      [A]: { rows: ['spotify:track:1', 'spotify:track:2'] },
      [B]: { rows: ['spotify:track:1', 'spotify:track:2'] },
    });
    try {
      const out = await h.invoke('playlist_symmetric_difference', { playlist_a: A, playlist_b: B });
      assert.deepEqual(sc(out).symmetric_difference, []);
      assert.match(textOf(out), /Symmetric difference: 0 uri\(s\)/);
    } finally {
      /* no session state to release */
    }
  });

  it('json output carries the same list the prose does', async () => {
    const h = harness({
      [A]: { rows: ['spotify:track:1'] },
      [B]: { rows: ['spotify:track:2'] },
    });
    try {
      const out = await h.invoke('playlist_symmetric_difference', {
        playlist_a: A,
        playlist_b: B,
        response_format: 'json',
      });
      const parsed = JSON.parse(textOf(out)) as { symmetric_difference: string[] };
      assert.deepEqual(parsed.symmetric_difference, ['spotify:track:1', 'spotify:track:2']);
    } finally {
      /* no session state to release */
    }
  });
});
