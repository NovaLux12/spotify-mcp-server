/**
 * Tests for remove_duplicate_playlist_items (#168): keep-first/remove-rest
 * over exact URI repeats and (opt-in) relinked same-song copies, dry_run,
 * elicitation gating at the 10-item threshold, descending-position deletes,
 * and the post-mutation re-scan verification.
 */

import './helpers/hermetic.js';

import { describe, it, afterEach } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import type { PlaylistItemObject } from '../src/types/spotify.js';
import { registerPlaylistTools } from '../src/tools/playlists.js';
import { REMOVE_ELICIT_THRESHOLD } from '../src/tools/confirm.js';

// ---------------------------------------------------------------------------
// Stub plumbing
// ---------------------------------------------------------------------------

interface RecordedCall {
  method: string;
  path: string;
  arg?: unknown;
}

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

interface ElicitOptions {
  result?: unknown;
  /**
   * #1237: model a host that cannot prompt at all. elicitHost() probes for
   * `elicitInput` on the inner server, so omitting `server` entirely is what
   * produces the 'unsupported' verdict — the same shape the real MCP SDK
   * presents when the client never advertised the capability. Previously this
   * harness could only ever produce 'confirmed' or 'declined'.
   */
  unpromptable?: boolean;
}

function harness(
  playlistItems: Array<{ item: { type: string; uri: string; name: string; artists?: Array<{ name: string }> } | null }>,
  opts: ElicitOptions = {},
) {
  const registered: RegisteredTool[] = [];
  const elicitRequests: Array<{ message: string }> = [];
  const calls: RecordedCall[] = [];

  const fakeServer = {
    // Elicitation-capable client shape (mirrors tools.confirm.test.ts).
    // #1237: `unpromptable` drops the inner server, and an Error result makes
    // the prompt fail on the wire — the two verdict states the old harness
    // could not express, and the two this gate used to turn into throws.
    ...(opts.unpromptable
      ? {}
      : {
          server: {
            getClientCapabilities: () => ({ elicitation: { form: {} } }),
            async elicitInput(request: { message: string }) {
              elicitRequests.push(request);
              if (opts.result instanceof Error) throw opts.result;
              return opts.result ?? { action: 'accept', content: { confirm: true } };
            },
          },
        }),
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
      config: { description?: string; inputSchema?: z.ZodType<Record<string, unknown>> },
      handler: RegisteredTool['handler'],
    ) {
      registered.push({
        name,
        validate: (args) => (config.inputSchema as z.ZodType<Record<string, unknown>>).parse(args),
        handler,
      });
    },
  } as unknown as McpServer;

  // Simulated playlist state so deletions actually shift positions — this is
  // what makes the descending-order guarantee observable.
  let state = playlistItems.map((entry) => ({ ...entry }));

  const client = {
    async get<T>(path: string): Promise<T | null> {
      if (path === '/playlists/pl1') return { id: 'pl1', name: 'Dupes' } as T;
      return null;
    },
    async getAllPages<T>(): Promise<T[]> {
      return structuredClone(state) as T[];
    },
    // #976 moved the truncation verdict onto the walk's own result, so a stub
    // that only implements getAllPages leaves remove_duplicate_playlist_items
    // calling a method that does not exist here. Not truncated: this fixture
    // hands back the whole playlist.
    async getAllPagesWithTruncation<T>(): Promise<{ items: T[]; truncated: boolean }> {
      return { items: structuredClone(state) as T[], truncated: false };
    },
    async delete<T>(_path: string, body: unknown): Promise<T | null> {
      const tracks = (body as { tracks: Array<{ uri: string; positions: number[] }> }).tracks;
      for (const t of [...tracks].sort((a, b) => b.positions[0] - a.positions[0])) {
        calls.push({ method: 'DELETE', path: _path, arg: body });
        state.splice(t.positions[0], 1);
      }
      return { snapshot_id: 'snap-1' } as T;
    },
  };

  registerPlaylistTools(fakeServer, client as unknown as SpotifyClient);
  return {
    registered,
    calls,
    elicitRequests,
    currentState: () => state,
    invoke: async (args: Record<string, unknown>) => {
      const tool = registered.find((t) => t.name === 'remove_duplicate_playlist_items');
      assert.ok(tool, 'tool should be registered');
      return tool.handler(tool.validate({ playlist_id: 'pl1', ...args }));
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

// ---------------------------------------------------------------------------
// Exact-uri duplicates
// ---------------------------------------------------------------------------

describe('remove_duplicate_playlist_items exact repeats', () => {
  it('keeps the first occurrence and removes later repeats in descending position order', async () => {
    const h = harness([
      track('spotify:track:a', 'Song A'), // pos 0 — kept
      track('spotify:track:b', 'Song B'),
      track('spotify:track:a', 'Song A'), // pos 2 — removed
      track('spotify:track:c', 'Song C'),
      track('spotify:track:a', 'Song A'), // pos 4 — removed
    ]);
    const out = await h.invoke({});
    const p = out.structuredContent as { removed: number; kept: number; remaining_duplicates: number; ok: boolean };
    assert.equal(p.removed, 2);
    assert.equal(p.kept, 3);
    assert.equal(p.remaining_duplicates, 0);
    assert.equal(p.ok, true);
    // Deletions ran highest-position-first.
    const positions = h.calls.map((c) => (c.arg as { tracks: Array<{ positions: number[] }> }).tracks[0].positions[0]);
    assert.deepEqual(positions, [4, 2]);
    assert.match(textOf(out), /no duplicates remain/);
    assert.match(textOf(out), /Removed 2 duplicate item\(s\) from "Dupes"/);
  });

  it('is a no-op when the playlist has no duplicates', async () => {
    const h = harness([track('a', 'X'), track('b', 'Y')]);
    const out = await h.invoke({});
    assert.equal(h.calls.length, 0);
    assert.match(textOf(out), /nothing to remove/);
  });

  it('fails fast on an unknown playlist', async () => {
    const h = harness([]);
    h.registered.length; // noop
    await assert.rejects(
      () =>
        (h.invoke({ playlist_id: 'nope' })),
      /Playlist "nope" not found/,
    );
  });
});

// ---------------------------------------------------------------------------
// Relinked (same song, different URIs)
// ---------------------------------------------------------------------------

describe('remove_duplicate_playlist_items relinked copies', () => {
  const relinkedLibrary = () => [
    track('spotify:track:v1', 'Classic', 'Legend'), // pos 0
    track('spotify:track:w2', 'Other', 'Trio'),
    track('spotify:track:v9', 'classic', 'legend'), // pos 2 — relink of v1
  ];

  it('ignores relinked copies by default', async () => {
    const h = harness(relinkedLibrary());
    const out = await h.invoke({});
    assert.equal(h.calls.length, 0);
    assert.match(textOf(out), /nothing to remove/);
    // #885: the default rule is named in the payload, so "nothing to remove"
    // is a statement about exact URIs and not an unattributable zero.
    assert.equal((out.structuredContent as { match_by: string }).match_by, 'uri');
  });

  it('collapses relinked same-song entries under match_by=name_artist', async () => {
    const h = harness(relinkedLibrary());
    const out = await h.invoke({ match_by: 'name_artist' });
    const p = out.structuredContent as { removed: number; remaining_duplicates: number; match_by: string };
    assert.equal(p.match_by, 'name_artist');
    assert.equal(p.removed, 1);
    assert.equal(p.remaining_duplicates, 0);
    const positions = h.calls.map((c) => (c.arg as { tracks: Array<{ positions: number[] }> }).tracks[0].positions[0]);
    assert.deepEqual(positions, [2]);
    // Kept entry is the earliest occurrence (v1), not merely the first URI seen.
    const state = h.currentState();
    assert.ok(state.every((e) => e.item?.uri !== 'spotify:track:v9'));
  });

  it('collapses them under the retired include_relinked=true too, and says so', async () => {
    // The boolean stays callable for one release (AGENTS.md §5). It maps onto
    // name_artist, which is the rule it used to mean, and the result carries
    // the deprecation so the caller is told which input produced it.
    const h = harness(relinkedLibrary());
    const out = await h.invoke({ include_relinked: true });
    const p = out.structuredContent as {
      removed: number;
      remaining_duplicates: number;
      match_by: string;
      deprecated_inputs?: string[];
      deprecation_note?: string;
    };
    assert.equal(p.match_by, 'name_artist');
    assert.equal(p.removed, 1);
    assert.equal(p.remaining_duplicates, 0);
    assert.deepEqual(p.deprecated_inputs, ['include_relinked']);
    assert.match(p.deprecation_note ?? '', /match_by=name_artist/);
  });

  it('refuses include_relinked alongside a match_by that means something else', async () => {
    const h = harness(relinkedLibrary());
    await assert.rejects(
      () => h.invoke({ include_relinked: true, match_by: 'name' }),
      /match_by=name[\s\S]*include_relinked/,
      'a conflicting pair must fail by name rather than silently picking one',
    );
    assert.equal(h.calls.length, 0, 'the refusal must land before any Spotify write');
  });
});

// ---------------------------------------------------------------------------
// dry_run + elicitation gate
// ---------------------------------------------------------------------------

describe('remove_duplicate_playlist_items safety rails', () => {
  const twelveDupes = () =>
    Array.from({ length: 12 }, (_, i) => [
      track(`spotify:track:s${i}`, `Song ${i}`),
      track(`spotify:track:s${i}`, `Song ${i}`),
    ]).flat();

  it('dry_run previews without deleting anything', async () => {
    const h = harness(twelveDupes());
    const out = await h.invoke({ dry_run: true });
    assert.equal(h.calls.length, 0);
    assert.equal(h.elicitRequests.length, 0);
    assert.match(textOf(out), /\[dry run\]/);
    const p = out.structuredContent as { removable_items: number; dry_run: boolean };
    assert.equal(p.removable_items, 12);
    assert.equal(p.dry_run, true);
  });

  it('elicits before removing 10+ items and honours a decline', async () => {
    const h = harness(twelveDupes(), { result: { action: 'accept', content: { confirm: false } } });
    assert.ok(REMOVE_ELICIT_THRESHOLD <= 12);
    const out = await h.invoke({});
    assert.equal(h.elicitRequests.length, 1);
    assert.match(h.elicitRequests[0].message, /Remove 12 duplicate item\(s\)/);
    assert.equal(h.calls.length, 0);
    assert.match(textOf(out), /Cancelled/);
    const p = out.structuredContent as { cancelled: boolean };
    assert.equal(p.cancelled, true);
  });

  it('proceeds after an explicit confirm and cleans up fully', async () => {
    const h = harness(twelveDupes(), { result: { action: 'accept', content: { confirm: true } } });
    const out = await h.invoke({});
    assert.equal(h.elicitRequests.length, 1);
    assert.equal(h.calls.length, 12);
    const p = out.structuredContent as { remaining_duplicates: number; ok: boolean };
    assert.equal(p.remaining_duplicates, 0);
    assert.equal(p.ok, true);
  });

  it('never prompts below the threshold', async () => {
    const small = [track('a', 'X'), track('b', 'Y'), track('a', 'X')];
    const h = harness(small);
    await h.invoke({});
    assert.equal(h.elicitRequests.length, 0);
    assert.equal(h.calls.length, 1);
  });
});

// ---------------------------------------------------------------------------
// #1237 — refusal shape parity
// ---------------------------------------------------------------------------

// remove_duplicate_playlist_items hand-rolled its refusal and did it
// inconsistently within this one tool: 'declined' returned a structured
// refusal, while 'error' and 'unsupported' threw. A host that handled the
// refusal shape handled one of the three ways this gate says no. The
// expected reasons below are literals, not recomputed from the helper.
describe('#1237 remove_duplicate_playlist_items refuses in one shape', () => {
  const twelveDupes = () =>
    Array.from({ length: 12 }, (_, i) => [
      track(`spotify:track:s${i}`, `Song ${i}`),
      track(`spotify:track:s${i}`, `Song ${i}`),
    ]).flat();

  it('returns the shared refusal payload for all three verdicts, deleting nothing', async () => {
    // 12 duplicates is above REMOVE_ELICIT_THRESHOLD, so the gate is entered;
    // the accepted case below proves that rather than assuming it.
    assert.ok(12 >= REMOVE_ELICIT_THRESHOLD);
    for (const [label, opts, reason] of [
      ['declined', { result: { action: 'decline' } }, undefined],
      ['error', { result: new Error('transport failed') }, 'elicitation_failed'],
      ['unsupported', { unpromptable: true }, 'confirmation_unavailable'],
    ] as const) {
      const h = harness(twelveDupes(), opts);
      // Capture the row count rather than hardcoding it: twelveDupes() builds
      // 12 pairs, so the playlist holds 24 rows and 12 of them are removable.
      // Asserting against the fixture's own length keeps the "nothing moved"
      // claim honest if that fixture ever changes.
      const before = h.currentState().length;
      const out = await h.invoke({});
      assert.equal(h.calls.length, 0, `${label}: must issue no DELETE`);
      assert.equal(h.currentState().length, before, `${label}: playlist must be untouched`);
      const p = out.structuredContent as Record<string, unknown>;
      assert.equal(p.ok, false, label);
      assert.equal(p.cancelled, true, label);
      if (reason === undefined) assert.equal('reason' in p, false, label);
      else assert.equal(p.reason, reason, label);
    }
  });

  it('SPOTIFY_MCP_CONFIRM=never still bypasses and deletes', async () => {
    const previous = process.env.SPOTIFY_MCP_CONFIRM;
    process.env.SPOTIFY_MCP_CONFIRM = 'never';
    try {
      const h = harness(twelveDupes(), { unpromptable: true });
      await h.invoke({});
      assert.equal(h.calls.length, 12, 'the bypass must still reach the wire');
    } finally {
      if (previous === undefined) delete process.env.SPOTIFY_MCP_CONFIRM;
      else process.env.SPOTIFY_MCP_CONFIRM = previous;
    }
  });
});
