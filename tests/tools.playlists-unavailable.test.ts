/**
 * Regression tests for #860 — full-sequence rewrites of a playlist that holds
 * unavailable rows.
 *
 * Spotify returns a removed, relabelled or region-unavailable row with
 * `item: null`, so it carries no URI. Every ordered rewrite in playlists.ts
 * commits through one atomic `PUT /playlists/{id}/items` built from a
 * URI-filtered list, so the first PUT deleted those rows from the live
 * playlist — and the counts reported afterwards came from the already-filtered
 * list, so nothing in the response revealed the loss.
 *
 * The rewrite is now REFUSED before the first PUT, naming the count and the
 * 1-based positions. A dry run still renders its plan; it also says the commit
 * will be refused, because a preview that promises a write the apply path
 * throws on is the same false claim in a new place.
 *
 * Run: node --import tsx --test tests/tools.playlists-unavailable.test.ts
 */

import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import type { PlaylistItemObject } from '../src/types/spotify.js';
import { StubFromResponder } from './helpers/stub-client.js';
import type { LegacyResponder, StubCall } from './helpers/stub-client.js';
import { registerPlaylistTools } from '../src/tools/playlists.js';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

interface RegisteredTool {
  name: string;
  description: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

// #659: the shared stub records exactly this shape, so the per-file recorder
// is deleted rather than kept in step with a second copy of it.
type RecordedCall = StubCall;

/** Anything that would change Spotify: the first PUT is the atomic replace. */
const writes = (calls: RecordedCall[]) =>
  calls.filter((c) => c.method === 'PUT' || c.method === 'POST' || c.method === 'DELETE');

/** Spotify playlist IDs are 22 base62 characters. */
const BASE = 'A'.repeat(22);
const SOURCE = 'B'.repeat(22);
const TARGET = 'C'.repeat(22);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const trackRow = (id: string, name: string): PlaylistItemObject =>
  ({
    added_at: '2026-01-01T00:00:00Z',
    item: {
      type: 'track',
      uri: `spotify:track:${id}`,
      name,
      duration_ms: 200_000,
      artists: [{ id: `artist-${id}`, name: `Artist ${id}` }],
      album: { id: `album-${id}`, name: `Album ${id}` },
    },
  }) as unknown as PlaylistItemObject;

/** What Spotify actually returns for a row it can no longer serve. */
const unavailableRow = (): PlaylistItemObject =>
  ({ added_at: '2026-01-01T00:00:00Z', item: null }) as unknown as PlaylistItemObject;

/** The #860 shape: a healthy playlist with one row Spotify can no longer serve. */
const playlistWithOneUnavailable = () => [trackRow('a', 'Alpha'), unavailableRow(), trackRow('b', 'Beta')];

// ---------------------------------------------------------------------------
// Harness: stub MCP server + stub SpotifyClient recording every call
// ---------------------------------------------------------------------------

function harness(playlists: Record<string, PlaylistItemObject[]>) {
  const registered: RegisteredTool[] = [];
  const calls: RecordedCall[] = [];
  const server = {
    tool(name: string, description: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
      registered.push({ name, description, validate: (a) => z.object(schema).parse(a), handler });
    },
    registerTool(
      name: string,
      config: { description?: string; inputSchema?: z.ZodType<Record<string, unknown>> },
      handler: RegisteredTool['handler'],
    ) {
      registered.push({
        name,
        description: config.description ?? '',
        validate: (a) => (config.inputSchema as z.ZodType<Record<string, unknown>>).parse(a),
        handler,
      });
    },
  } as unknown as McpServer;

  const rowsFor = (path: string): PlaylistItemObject[] | null => {
    const match = /^\/playlists\/([^/]+)\/items$/.exec(path);
    if (!match) return null;
    return playlists[decodeURIComponent(match[1]!)] ?? null;
  };

  // #659: same hand-copied loop with its hardcoded `?? 500` cap, and the same
  // argument-dropping `putRaw()`/`delete()`. The shared stub runs the
  // production walk and records the body of every write.
  const read: LegacyResponder = (path, params) => {
    const rows = rowsFor(path);
    if (rows) {
      const offset = Number((params as Record<string, string> | undefined)?.offset ?? 0);
      return {
        items: rows.slice(offset, offset + 100),
        total: rows.length,
        limit: 100,
        offset,
      };
    }
    const id = decodeURIComponent(path.replace('/playlists/', ''));
    return { id, name: `Playlist ${id}`, items: { total: playlists[id]?.length ?? 0 } };
  };
  const client = new StubFromResponder(read, {
    writes: {
      POST: (path) => (path === '/me/playlists' ? { id: 'newPlaylist' } : { snapshot_id: 'snap-post' }),
      PUT: () => ({ snapshot_id: 'snap-put' }),
      DELETE: () => null,
      PUT_RAW: () => undefined,
    },
  });

  registerPlaylistTools(server, client);

  return {
    calls: client.calls,
    client,
    // Schema-validating invoke: mirrors how the MCP server screens args
    // before a handler ever sees them.
    async invoke(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

const textOf = (out: ToolResult) => out.content[0].text;

/**
 * The refusal is an error, not a soft result: an agent that reads
 * `structuredContent.ok === false` and proceeds is exactly the failure this
 * guard exists to stop.
 */
const assertRefusal = async (run: () => Promise<unknown>, at: number, label: string) => {
  await assert.rejects(
    run,
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /contains 1 unavailable item\(s\)/, 'the count must be named');
      assert.match(message, new RegExp(`at 1-based position\\(s\\) ${at}\\b`), 'the 1-based position must be named');
      assert.match(message, /A full rewrite would drop them from the playlist\./);
      assert.match(message, /remove_unavailable_playlist_items/, 'the refusal must name its remedy');
      assert.match(message, new RegExp(label), 'the refusal must name the playlist');
      return true;
    },
  );
};

// ---------------------------------------------------------------------------
// playlist_sort
// ---------------------------------------------------------------------------

describe('playlist_sort refuses a playlist with unavailable rows (#860)', () => {
  it('refuses before the atomic replace and issues no write at all', async () => {
    const h = harness({ [BASE]: playlistWithOneUnavailable() });

    await assertRefusal(
      () => h.invoke('playlist_sort', { playlist_id: BASE, sort_by: 'name_asc', dry_run: false }),
      2,
      BASE,
    );

    assert.deepEqual(writes(h.calls), [], 'the atomic replace must not be issued');
  });

  it('still renders the plan on a dry run, and says the commit will be refused', async () => {
    const h = harness({ [BASE]: playlistWithOneUnavailable() });

    const out = await h.invoke('playlist_sort', { playlist_id: BASE, sort_by: 'name_asc', dry_run: true });

    assert.deepEqual(writes(h.calls), []);
    assert.match(textOf(out), /Would sort 2 items by name_asc/, 'a preview is never blocked');
    assert.match(textOf(out), /contains 1 unavailable item\(s\) at 1-based position\(s\) 2/);
  });

  it('does not mention unavailable rows when there are none', async () => {
    // The guard must be a predicate, not a blanket refusal: a healthy
    // playlist still commits, and its plan carries no warning.
    const h = harness({ [BASE]: [trackRow('b', 'Beta'), trackRow('a', 'Alpha')] });

    const out = await h.invoke('playlist_sort', { playlist_id: BASE, sort_by: 'name_asc', dry_run: true });

    assert.doesNotMatch(textOf(out), /unavailable/);
    const committed = await h.invoke('playlist_sort', { playlist_id: BASE, sort_by: 'name_asc', dry_run: false });
    const put = writes(h.calls).find((c) => c.method === 'PUT');
    assert.ok(put, 'a healthy playlist still commits');
    assert.deepEqual(put.arg, { uris: ['spotify:track:a', 'spotify:track:b'] });
    assert.match(textOf(committed), /Sorted 2 item\(s\) by name_asc/);
  });
});

// ---------------------------------------------------------------------------
// playlist_shuffle
// ---------------------------------------------------------------------------

describe('playlist_shuffle refuses a playlist with unavailable rows (#860)', () => {
  it('refuses before the atomic replace and issues no write at all', async () => {
    const h = harness({ [BASE]: playlistWithOneUnavailable() });

    await assertRefusal(() => h.invoke('playlist_shuffle', { playlist_id: BASE, dry_run: false }), 2, BASE);

    assert.deepEqual(writes(h.calls), []);
  });

  it('still renders the plan on a dry run', async () => {
    const h = harness({ [BASE]: playlistWithOneUnavailable() });

    const out = await h.invoke('playlist_shuffle', { playlist_id: BASE, dry_run: true });

    assert.deepEqual(writes(h.calls), []);
    assert.match(textOf(out), /Would shuffle 2 items/);
    assert.match(textOf(out), /contains 1 unavailable item\(s\) at 1-based position\(s\) 2/);
  });

  it('refuses the truncated read before it publishes a count it cannot vouch for', async () => {
    // 501 rows against the default fetch-all cap of 500. Two things are true
    // about this playlist: it holds one unavailable row, and the walk never
    // reached the end. #1310 made the SECOND fact the one that decides, and
    // that is the right order — "contains 1 unavailable item(s)" is a number
    // derived from an incomplete read, and leading with it is the same
    // coerced-plausible-count failure the issue is filed on. The lower-bound
    // wording still exists for the callers that DO disclose a truncated read
    // (union / subtract, below); here the refusal refuses.
    const long = Array.from({ length: 500 }, (_, i) => trackRow(`t${i}`, `Track ${i}`));
    const h = harness({ [BASE]: [unavailableRow(), ...long] });

    await assert.rejects(
      () => h.invoke('playlist_shuffle', { playlist_id: BASE, dry_run: false }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /could only be read to the configured fetch-all cap of 500 row\(s\)/);
        assert.match(message, /past position 500/);
        assert.doesNotMatch(message, /contains 1 unavailable item\(s\)/, 'a truncated read does not get to state a count');
        return true;
      },
    );
    assert.deepEqual(writes(h.calls), []);
  });
});

// ---------------------------------------------------------------------------
// playlist_reverse
// ---------------------------------------------------------------------------

describe('playlist_reverse refuses a playlist with unavailable rows (#860)', () => {
  it('refuses before the atomic replace and issues no write at all', async () => {
    const h = harness({ [BASE]: playlistWithOneUnavailable() });

    await assertRefusal(() => h.invoke('playlist_reverse', { playlist_id: BASE, dry_run: false }), 2, BASE);

    assert.deepEqual(writes(h.calls), []);
  });

  it('still renders the plan on a dry run', async () => {
    const h = harness({ [BASE]: playlistWithOneUnavailable() });

    const out = await h.invoke('playlist_reverse', { playlist_id: BASE, dry_run: true });

    assert.match(textOf(out), /Would reverse 2 items/);
    assert.match(textOf(out), /contains 1 unavailable item\(s\) at 1-based position\(s\) 2/);
    assert.deepEqual(writes(h.calls), []);
  });
});

// ---------------------------------------------------------------------------
// playlist_trim
// ---------------------------------------------------------------------------

describe('playlist_trim refuses a playlist with unavailable rows (#860)', () => {
  it('refuses before the atomic replace and issues no write at all', async () => {
    // keep=1 is below the addressable count of 2, so the trim would have run
    // — the guard is what stops it, not a no-op comparison.
    const h = harness({ [BASE]: playlistWithOneUnavailable() });

    await assertRefusal(() => h.invoke('playlist_trim', { playlist_id: BASE, keep: 1, dry_run: false }), 2, BASE);

    assert.deepEqual(writes(h.calls), []);
  });

  it('still renders the plan on a dry run', async () => {
    const h = harness({ [BASE]: playlistWithOneUnavailable() });

    const out = await h.invoke('playlist_trim', { playlist_id: BASE, keep: 1, dry_run: true });

    assert.match(textOf(out), /Would trim 2 → 1 \(first\)/);
    assert.match(textOf(out), /contains 1 unavailable item\(s\) at 1-based position\(s\) 2/);
    assert.deepEqual(writes(h.calls), []);
  });

  it('leaves a genuinely shorter playlist alone without mentioning a refusal', async () => {
    // Nothing to trim is a real no-op and must not be dressed up as a refusal.
    const h = harness({ [BASE]: [trackRow('a', 'Alpha'), unavailableRow()] });

    const out = await h.invoke('playlist_trim', { playlist_id: BASE, keep: 5, dry_run: false });

    // #872: the count is the playlist's ROW count, not the URI-filtered walk.
    // It used to say "already 1 ≤ 5" for a playlist holding 2 rows, so the
    // no-op line understated what the playlist actually contained.
    assert.match(textOf(out), /already 2 ≤ 5 — nothing to trim/);
    assert.deepEqual(out.structuredContent, {
      ok: true,
      unchanged: true,
      playlist: BASE,
      existing_rows: 2,
      keep: 5,
      changed: false,
    });
    assert.deepEqual(writes(h.calls), []);
  });
});

// ---------------------------------------------------------------------------
// playlist_subtract
// ---------------------------------------------------------------------------

describe('playlist_subtract refuses a base with unavailable rows (#860)', () => {
  it('refuses before the atomic replace and issues no write at all', async () => {
    const h = harness({ [BASE]: playlistWithOneUnavailable(), [SOURCE]: [trackRow('b', 'Beta')] });

    await assertRefusal(
      () => h.invoke('playlist_subtract', { base_playlist_id: BASE, playlists: [SOURCE], dry_run: false }),
      2,
      BASE,
    );

    assert.deepEqual(writes(h.calls), []);
  });

  it('previews the removal set and flags the refusal rather than promising a prompt', async () => {
    const h = harness({ [BASE]: playlistWithOneUnavailable(), [SOURCE]: [trackRow('b', 'Beta')] });

    const out = await h.invoke('playlist_subtract', {
      base_playlist_id: BASE,
      playlists: [SOURCE],
      dry_run: true,
      response_format: 'json',
    });

    const payload = out.structuredContent as Record<string, unknown>;
    assert.equal(payload.removed_total, 1, 'the plan still describes the removal');
    assert.equal(payload.kept_total, 1);
    // The base is the playlist being overwritten, so it is the one refused.
    assert.equal(payload.would_refuse, true);
    assert.equal(payload.would_confirm, false, 'there is no prompt to promise — the call throws');
    assert.deepEqual(writes(h.calls), []);
  });

  it('states the position count as a lower bound when the base walk hit the cap (#1310)', async () => {
    // The single-playlist rewrites REFUSE a truncated read before they get
    // this far (there is no prompt there to disclose into). Subtract is the
    // other kind of caller: it discloses the incompleteness in its payload and
    // puts it in front of an elicitation the caller cannot skip. So the
    // lower-bound wording has to stay live on THIS path — it is the only place
    // left where a truncated count is shown to a human at all.
    const long = Array.from({ length: 500 }, (_, i) => trackRow(`t${i}`, `Track ${i}`));
    const h = harness({ [BASE]: [unavailableRow(), ...long], [SOURCE]: [trackRow('t0', 'Track 0')] });

    await assert.rejects(
      () => h.invoke('playlist_subtract', { base_playlist_id: BASE, playlists: [SOURCE], dry_run: false }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /contains 1 unavailable item\(s\) at 1-based position\(s\) 1/);
        assert.match(message, /stopped at the configured cap/);
        assert.match(message, /lower bound/);
        return true;
      },
    );
    assert.deepEqual(writes(h.calls), []);
  });

  it('still routes a destructive subtraction with no unavailable rows through the elicitation gate', async () => {
    // The guard must not swallow the gate it now runs in front of. This host
    // cannot prompt, so the gate fails closed exactly as it did before #860.
    const h = harness({ [BASE]: [trackRow('a', 'Alpha'), trackRow('b', 'Beta')], [SOURCE]: [trackRow('b', 'Beta')] });

    const out = await h.invoke('playlist_subtract', {
      base_playlist_id: BASE,
      playlists: [SOURCE],
      dry_run: false,
      response_format: 'json',
    });

    const payload = out.structuredContent as Record<string, unknown>;
    assert.equal(payload.ok, false);
    assert.equal(payload.reason, 'confirmation_unavailable');
    assert.doesNotMatch(textOf(out), /unavailable item\(s\)/, 'the #860 guard did not fire');
    assert.deepEqual(writes(h.calls), [], 'an unconfirmed replace still writes nothing');
  });
});

// ---------------------------------------------------------------------------
// playlist_union
// ---------------------------------------------------------------------------

describe('playlist_union refuses a target with unavailable rows (#860)', () => {
  it('refuses the existing target before the atomic replace', async () => {
    const h = harness({
      [BASE]: [trackRow('a', 'Alpha')],
      [SOURCE]: [trackRow('b', 'Beta')],
      [TARGET]: playlistWithOneUnavailable(),
    });

    await assertRefusal(
      () =>
        h.invoke('playlist_union', {
          playlists: [BASE, SOURCE],
          target_playlist_id: TARGET,
          dry_run: false,
        }),
      2,
      TARGET,
    );

    assert.deepEqual(writes(h.calls), []);
  });

  it('still unions into a new playlist — no live rows are being destroyed', async () => {
    // The guard is about the playlist a replace would overwrite. Creating one
    // destroys nothing, so the same unreadable source rows must not block it.
    const h = harness({
      [BASE]: playlistWithOneUnavailable(),
      [SOURCE]: [trackRow('b', 'Beta')],
    });

    const out = await h.invoke('playlist_union', { playlists: [BASE, SOURCE], target_name: 'Fresh', dry_run: false });

    const created = writes(h.calls).filter((c) => c.path === '/me/playlists');
    assert.equal(created.length, 1, 'the new playlist is still created');
    assert.match(textOf(out), /Union 2 item\(s\)/);
  });

  it('previews the union and flags the refusal', async () => {
    const h = harness({
      [BASE]: [trackRow('a', 'Alpha')],
      [SOURCE]: [trackRow('b', 'Beta')],
      [TARGET]: playlistWithOneUnavailable(),
    });

    const out = await h.invoke('playlist_union', {
      playlists: [BASE, SOURCE],
      target_playlist_id: TARGET,
      dry_run: true,
      response_format: 'json',
    });

    const payload = out.structuredContent as Record<string, unknown>;
    assert.equal(payload.uri_count, 2, 'the plan still describes the union');
    assert.equal(payload.would_refuse, true);
    assert.equal(payload.would_confirm, false);
    assert.deepEqual(writes(h.calls), []);
  });
});
