/**
 * Regressions for src/tools/analytics.ts:
 *   #805 listening_streaks published `max_items` but the walker ignored it and
 *         reported no read total; the full 3×50 walk was paid regardless.
 *   #804 top_artists_by_range advertised short↔long rank deltas behind a
 *         `ranges.length === 2` guard that no real request shape can satisfy
 *         ('all' → 3 windows, explicit window → 1), so deltas never shipped.
 *
 * Stub-client harness pattern from tools.analytics.test.ts: a fake McpServer
 * captures registrations, a stub SpotifyClient records wire calls and answers
 * from a responder function.
 */

import { describe, it } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerAnalyticsTools } from '../src/tools/analytics.js';

// ---------------------------------------------------------------------------
// Stub plumbing
// ---------------------------------------------------------------------------

interface RecordedCall {
  path: string;
  params?: Record<string, string>;
}

type Responder = (path: string, params?: Record<string, string>) => unknown;

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}

function harness(responder: Responder) {
  const registered: Array<{
    name: string;
    validate: (args: Record<string, unknown>) => Record<string, unknown>;
    handler: (args: Record<string, unknown>) => Promise<ToolResult>;
  }> = [];
  const fakeServer = {
    tool(
      name: string,
      _description: string,
      schema: z.ZodRawShape,
      handler: (args: Record<string, unknown>) => Promise<ToolResult>,
    ) {
      registered.push({
        name,
        validate: (args) => z.object(schema).parse(args),
        handler,
      });
    },
  } as unknown as McpServer;

  const calls: RecordedCall[] = [];
  const client = {
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      calls.push({ path, params });
      return responder(path, params) as T | null;
    },
  };
  registerAnalyticsTools(fakeServer, client as unknown as SpotifyClient);

  const invoke = async (toolName: string, args: Record<string, unknown> = {}) => {
    const tool = registered.find((t) => t.name === toolName);
    assert.ok(tool, `${toolName} should be registered`);
    return tool.handler(tool.validate(args));
  };

  return { calls, invoke };
}

const payloadOf = (out: ToolResult) => (out.structuredContent ?? {}) as Record<string, unknown>;

const recentItem = (trackId: string, playedAt: string) => ({
  track: { id: trackId, name: `Track ${trackId}`, type: 'track' },
  played_at: playedAt,
  context: null,
});

/** N recent-played rows spread one per day, newest first, so every row is its
 * own date and the expected date count is trivially `items_read`. */
const dailyRows = (start: Date, n: number) =>
  Array.from({ length: n }, (_, i) => {
    const at = new Date(start.getTime() - i * 86400000);
    return recentItem(`t-${i}`, at.toISOString());
  });

/** Three fully-populated pages, each with a live `after` cursor, so a walk that
 * ignores `max_items` really does spend all three calls. */
function pagingRecentResponder(days: number) {
  const today = new Date();
  let call = 0;
  return (path: string): unknown => {
    if (path !== '/me/player/recently-played') return null;
    const page = call;
    call += 1;
    const rows = dailyRows(new Date(today.getTime() - page * days * 86400000), days);
    return {
      items: rows,
      cursors: { before: '0', after: `cursor-${page + 1}` },
      next: 'https://api.spotify.com/v1/me/player/recently-played?after=x',
    };
  };
}

/** Top artists per window; each window gets its own ordered id list. */
function artistsResponder(byRange: Record<string, string[]>) {
  return (path: string, params?: Record<string, string>): unknown => {
    if (path !== '/me/top/artists') return null;
    const ids = byRange[params?.time_range ?? ''] ?? [];
    return {
      items: ids.map((id) => ({ id, name: `Artist ${id}` })),
      total: ids.length,
      limit: 50,
      offset: 0,
      next: null,
    };
  };
}

// ---------------------------------------------------------------------------
// #805 — listening_streaks honours max_items and reports what it read
// ---------------------------------------------------------------------------

describe('listening_streaks max_items (#805)', () => {
  it('stops the cursor walk at max_items instead of walking the full 150', async () => {
    const { calls, invoke } = harness(pagingRecentResponder(50));

    const out = await invoke('listening_streaks', { max_items: 5 });
    const payload = payloadOf(out);

    const recentCalls = calls.filter((c) => c.path === '/me/player/recently-played');
    assert.equal(
      recentCalls.length,
      1,
      'max_items: 5 must resolve in a single page, not the full 3-page walk',
    );
    assert.equal(
      recentCalls[0]?.params?.limit,
      '5',
      'the page must be sized to the budget rather than the 50-item page cap',
    );

    // The reported total has to be the number of items actually read.
    assert.equal(payload.items_read, 5);
    assert.equal(payload.max_items, 5);
    assert.equal(payload.pages_walked, 1);
    assert.equal(payload.dates_count, 5, 'streaks must be derived from the 5 read items');
  });

  it('truncates a partially-usable page to the budget and keeps the freshest rows', async () => {
    // One page of 50 rows with a live cursor: honouring max_items must cut the
    // page down to 6 rather than keeping all 50.
    const { calls, invoke } = harness(pagingRecentResponder(50));

    const out = await invoke('listening_streaks', { max_items: 6 });
    const payload = payloadOf(out);

    assert.equal(calls.filter((c) => c.path === '/me/player/recently-played').length, 1);
    assert.equal(payload.items_read, 6);
    assert.equal(payload.dates_count, 6);
  });

  it('defaults to the full 150-item ceiling when max_items is absent', async () => {
    const { calls, invoke } = harness(pagingRecentResponder(50));

    const out = await invoke('listening_streaks', {});
    const payload = payloadOf(out);

    const recentCalls = calls.filter((c) => c.path === '/me/player/recently-played');
    assert.equal(recentCalls.length, 3, 'the default budget still walks all 3 pages');
    assert.equal(recentCalls[0]?.params?.limit, '50');
    assert.equal(payload.items_read, 150);
    assert.equal(payload.max_items, 150);
    assert.equal(payload.pages_walked, 3);
    // 150 consecutive days is one unbroken streak, computed from what was read.
    assert.equal(payload.dates_count, 150);
    assert.equal((payload.streaks as unknown[]).length, 1);
  });

  it('reports the read total on the empty-history path too', async () => {
    const { calls, invoke } = harness(() => null);

    const out = await invoke('listening_streaks', { max_items: 5 });
    const payload = payloadOf(out);

    assert.equal(calls.filter((c) => c.path === '/me/player/recently-played').length, 1);
    assert.equal(payload.items_read, 0);
    assert.equal(payload.max_items, 5);
    assert.equal(payload.dates_count, 0);
  });

  it('returns the same key set on the empty and populated paths', async () => {
    const empty = harness(() => null);
    const populated = harness(pagingRecentResponder(3));

    const emptyKeys = Object.keys(
      payloadOf(await empty.invoke('listening_streaks', { max_items: 5 })),
    ).sort();
    const fullKeys = Object.keys(
      payloadOf(await populated.invoke('listening_streaks', { max_items: 5 })),
    ).sort();

    // An agent must not be handed a key that only exists on one of the two
    // paths — the empty branch used to carry a leftover `dates: []` array
    // alongside the `dates_count` the populated branch reports.
    assert.deepEqual(emptyKeys, fullKeys);
    assert.ok(!emptyKeys.includes('dates'));
  });
});

// ---------------------------------------------------------------------------
// #804 — top_artists_by_range ships the delta it advertises
// ---------------------------------------------------------------------------

describe('top_artists_by_range rank deltas (#804)', () => {
  it('emits short_term↔long_term rank deltas for the default time_range=all', async () => {
    const { calls, invoke } = harness(
      artistsResponder({
        // 'a2' climbs 3→1, 'a1' slips 1→2, 'a4' is new to the short window.
        short_term: ['a2', 'a1', 'a4'],
        medium_term: ['a1', 'a2'],
        long_term: ['a1', 'a3', 'a2'],
      }),
    );

    const out = await invoke('top_artists_by_range', {});
    const payload = payloadOf(out);

    assert.equal(
      calls.filter((c) => c.path === '/me/top/artists').length,
      3,
      "time_range 'all' fetches all three windows",
    );

    const deltas = payload.deltas as Array<{
      id: string;
      short_rank: number;
      long_rank: number;
      delta: number;
    }>;
    assert.ok(Array.isArray(deltas), 'deltas must be present for time_range=all');
    assert.deepEqual(
      deltas.map((d) => [d.id, d.short_rank, d.long_rank, d.delta]),
      [
        ['a2', 1, 3, 2],
        ['a1', 2, 1, -1],
      ],
      'biggest riser first, with explicit ranks on both sides',
    );

    const basis = payload.deltas_basis as {
      from: string;
      to: string;
      compared: number;
      only_in_short_term: string[];
      only_in_long_term: string[];
    };
    assert.equal(basis.from, 'short_term');
    assert.equal(basis.to, 'long_term');
    assert.equal(basis.compared, 2);
    // Windows absent from the other's capped list get named, not given a
    // fabricated rank.
    assert.deepEqual(basis.only_in_short_term, ['a4']);
    assert.deepEqual(basis.only_in_long_term, ['a3']);
  });

  it('reports deltas as null for a single-window request, which has no pair to compare', async () => {
    const { calls, invoke } = harness(
      artistsResponder({ short_term: ['a1', 'a2'], medium_term: ['a9'], long_term: ['a1'] }),
    );

    const out = await invoke('top_artists_by_range', { time_range: 'short_term' });
    const payload = payloadOf(out);

    assert.equal(
      calls.filter((c) => c.path === '/me/top/artists').length,
      1,
      'a single window costs a single call',
    );
    assert.equal(payload.deltas, null);
    assert.equal(payload.deltas_basis, null);
  });

  it("issues the 'all' window reads concurrently instead of serializing three round-trips", async () => {
    let inFlight = 0;
    let peak = 0;
    const { invoke } = harness((path) => {
      if (path !== '/me/top/artists') return null;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const { promise, resolve } = Promise.withResolvers<unknown>();
      setImmediate(() => {
        inFlight -= 1;
        resolve({ items: [{ id: 'a1', name: 'Artist a1' }], total: 1, limit: 50, offset: 0, next: null });
      });
      return promise;
    });

    await invoke('top_artists_by_range', {});

    // Observable as latency, not as source shape: a sequential walk would
    // never have more than one request outstanding.
    assert.equal(peak, 3, 'all three window reads must be outstanding at once');
  });
});
