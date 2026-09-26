import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SpotifyApiError, type SpotifyClient } from '../src/client.js';
import { registerSwarm3AnalyticsTools } from '../src/tools/swarm3_analytics.js';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type RegisteredTool = {
  name: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};

interface RecentItem {
  played_at: string;
  track: { id: string; name: string; uri: string; artists: Array<{ id: string; name: string }> };
}

function playedAt(id: string, played_at: string): RecentItem {
  return {
    played_at,
    track: {
      id,
      name: `Track ${id}`,
      uri: `spotify:track:${id}`,
      artists: [{ id: `artist-${id}`, name: `Artist ${id}` }],
    },
  };
}

function harness(recent: RecentItem[]) {
  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(name: string, _description: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
      registered.push({ name, validate: (args) => z.object(schema).parse(args), handler });
    },
  } as unknown as McpServer;

  const client = {
    async get<T>(path: string): Promise<T | null> {
      if (path === '/me/player/recently-played') {
        return { items: recent, cursors: null, next: null } as unknown as T;
      }
      if (path === '/me/top/tracks' || path === '/me/top/artists') {
        return { items: [] } as unknown as T;
      }
      return null;
    },
    async getAllPages<T>(): Promise<T[]> {
      return [] as unknown as T[];
    },
  };

  registerSwarm3AnalyticsTools(fakeServer, client as unknown as SpotifyClient);
  const byName = new Map(registered.map((tool) => [tool.name, tool]));
  return {
    async invoke(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
      const tool = byName.get(name);
      assert.ok(tool, `${name} is registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

/** Run a body under a forced process time zone. Node re-reads TZ for Date's
 * local-time accessors, so a host-local implementation cannot pass these. */
async function inTimeZone<T>(tz: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

describe('listening_clock quietest hour (#823)', () => {
  it('names the true minimum-count hour when one bucket is strictly quietest', async () => {
    // One play in every hour 00:00..23:00 except 04:00, which stays at zero.
    const hours = Array.from({ length: 24 }, (_, h) => h);
    const recent = hours.filter((h) => h !== 4).map((h) =>
      playedAt(`t${h}`, `2026-09-20T${h.toString().padStart(2, '0')}:30:00Z`),
    );

    const out = await harness(recent).invoke('listening_clock');
    const payload = out.structuredContent as {
      hour_histogram: Record<string, number>;
      quietest_hour: string | null;
      quietest_plays: number;
      quietest_tied_hours: string[];
    };

    assert.equal(payload.hour_histogram['04:00'], 0);
    assert.equal(payload.quietest_hour, '04:00');
    assert.equal(payload.quietest_plays, 0);
    assert.deepEqual(payload.quietest_tied_hours, ['04:00']);
    assert.match(out.content[0].text, /Quietest 04:00 \(0 plays\)/);
  });

  it('reports a tie instead of naming the largest label when the sample is too thin', async () => {
    // 12 plays in 12 distinct UTC hours leaves 12 buckets tied at zero. The
    // pre-fix code took the tail of the count-descending sort, which for that
    // tie is the largest label: 23:00.
    const recent = Array.from({ length: 12 }, (_, h) =>
      playedAt(`t${h}`, `2026-09-20T${h.toString().padStart(2, '0')}:15:00Z`),
    );

    const out = await harness(recent).invoke('listening_clock');
    const payload = out.structuredContent as {
      hour_histogram: Record<string, number>;
      quietest_hour: string | null;
      quietest_plays: number;
      quietest_tied_hours: string[];
    };

    assert.equal(payload.quietest_hour, null, 'pre-fix this was the arbitrary label 23:00');
    assert.equal(payload.quietest_plays, 0);
    assert.equal(payload.quietest_tied_hours.length, 12);
    assert.deepEqual(
      payload.quietest_tied_hours,
      Array.from({ length: 12 }, (_, h) => `${(h + 12).toString().padStart(2, '0')}:00`),
      'every untraversed hour 12:00-23:00 holds the minimum',
    );
    assert.match(out.content[0].text, /No single quietest hour: 12 hours tie at 0 play\(s\)/);
  });

  it('takes the true minimum, not the largest label, when the minimum is tied at a nonzero count', async () => {
    // Hours 01:00-22:00 get two plays; 00:00 and 23:00 tie at one. The true
    // minimum is 1, but the reversal picked 23:00 as the "quietest" hour and
    // the other tied hour went unnamed.
    const recent = [
      playedAt('a', '2026-09-20T00:30:00Z'),
      playedAt('b', '2026-09-20T23:30:00Z'),
      ...Array.from({ length: 22 }, (_, h) =>
        Array.from({ length: 2 }, (_, i) =>
          playedAt(`c${h}-${i}`, `2026-09-20T${(h + 1).toString().padStart(2, '0')}:30:00Z`),
        ),
      ).flat(),
    ];

    const out = await harness(recent).invoke('listening_clock');
    const payload = out.structuredContent as {
      hour_histogram: Record<string, number>;
      quietest_hour: string | null;
      quietest_plays: number;
      quietest_tied_hours: string[];
    };

    assert.equal(payload.hour_histogram['00:00'], 1);
    assert.equal(payload.hour_histogram['01:00'], 2);
    assert.equal(payload.quietest_plays, 1);
    assert.equal(payload.quietest_hour, null, 'a tied minimum must not name one hour');
    assert.deepEqual(payload.quietest_tied_hours, ['00:00', '23:00']);
  });
});

describe('swarm3 analytics time frame (#824)', () => {
  // 2026-09-20T22:40Z and 2026-09-20T23:50Z are Sunday and Sunday; the third
  // play lands on 2026-09-21T00:10Z (Monday). Every one of them shifts date or
  // hour under a non-UTC host zone, so a local-time implementation buckets all
  // three differently.
  const nearMidnight: RecentItem[] = [
    playedAt('x1', '2026-09-20T22:40:00Z'),
    playedAt('x2', '2026-09-20T23:50:00Z'),
    playedAt('x3', '2026-09-21T00:10:00Z'),
  ];

  for (const tz of ['UTC', 'Pacific/Kiritimati', 'America/Los_Angeles', 'Asia/Tokyo']) {
    it(`buckets hour, weekday and day rows in the same UTC frame under TZ=${tz}`, async () => {
      await inTimeZone(tz, async () => {
        const h = harness(nearMidnight);

        const clock = (await h.invoke('listening_clock')).structuredContent as {
          hour_histogram: Record<string, number>;
          history_items: number;
        };
        const weekdays = (await h.invoke('weekday_listening_report')).structuredContent as {
          weekdays: Array<{ weekday: string; plays: number }>;
        };
        const rotation = (await h.invoke('weekly_rotation_report')).structuredContent as {
          days: Array<{ date: string; weekday: string; plays: number }>;
        };
        const heatmap = (await h.invoke('listening_clock_heatmap')).structuredContent as {
          active_cells: number;
        };
        const score = (await h.invoke('listening_consistency_score')).structuredContent as {
          components: { day_coverage: { ratio: number }; hour_spread: { ratio: number } };
        };

        // Hours come from the UTC clock: 22, 23 and 00 respectively.
        assert.equal(clock.history_items, 3);
        assert.equal(clock.hour_histogram['22:00'], 1);
        assert.equal(clock.hour_histogram['23:00'], 1);
        assert.equal(clock.hour_histogram['00:00'], 1);
        assert.equal(Object.values(clock.hour_histogram).reduce((a, b) => a + b, 0), 3);

        // Weekday comes from the same UTC frame: the 2026-09-21 play is Monday.
        // Rows come back in Mon-Sun order, not play order.
        assert.deepEqual(
          weekdays.weekdays.filter((d) => d.plays > 0).map((d) => [d.weekday, d.plays]),
          [['Mon', 1], ['Sun', 2]],
        );

        // The day rows already used the raw UTC date prefix; their weekday
        // label must agree with the hour and weekday buckets beside them.
        assert.deepEqual(
          rotation.days.map((d) => [d.date, d.weekday]),
          [['2026-09-20', 'Sun'], ['2026-09-21', 'Mon']],
        );
        // 00:10Z and 22:40Z/23:50Z are three distinct UTC hours, and the
        // weekday × hour grid must see exactly those three cells.
        assert.equal(heatmap.active_cells, 3);
        // Two distinct UTC dates out of the two-day span, three distinct
        // hours — the same UTC frame the histogram above used.
        assert.equal(score.components.day_coverage.ratio, 1);
        assert.equal(score.components.hour_spread.ratio, 0.125);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// top_genre_census — walks every census id in chunks (#801)
// ---------------------------------------------------------------------------

/**
 * The listening_clock harness mocks `/me/top/*` to an empty page. For the
 * genre-census tests we need 120 distinct artists unioned across the three
 * windows — 40 ids per window with no overlap makes a 120-id union.
 */
function genreHarness(
  responder: (
    path: string,
    params: Record<string, string> | undefined,
  ) => unknown,
): { invoke: (name: string, args?: Record<string, unknown>) => Promise<ToolResult> } {
  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(name: string, _description: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
      registered.push({ name, validate: (args) => z.object(schema).parse(args), handler });
    },
  } as unknown as McpServer;

  const client = {
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      return responder(path, params) as T | null;
    },
    async getAllPages<T>(): Promise<T[]> {
      return [] as unknown as T[];
    },
  };

  registerSwarm3AnalyticsTools(fakeServer, client as unknown as SpotifyClient);
  const byName = new Map(registered.map((tool) => [tool.name, tool]));
  return {
    async invoke(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
      const tool = byName.get(name);
      assert.ok(tool, `${name} is registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

describe('top_genre_census reads every census id per-id (#1004)', () => {
  // 120 distinct ids: 40 per window, no overlap, so the union size is 120.
  const windowArtists = (start: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({ id: `a${(start + i).toString().padStart(3, '0')}`, name: `Artist ${start + i}` }));

  const topArtistsByWindow = {
    short_term: windowArtists(0, 40),
    medium_term: windowArtists(40, 40),
    long_term: windowArtists(80, 40),
  };

  const topArtistsResponder = (path: string, params?: Record<string, string>) => {
    if (path === '/me/top/artists') {
      const tr = params?.time_range ?? 'short_term';
      return { items: topArtistsByWindow[tr as keyof typeof topArtistsByWindow] ?? [] };
    }
    return undefined;
  };

  // #1004: `GET /artists?ids=` ("Get Several Artists") is one of the endpoints
  // Spotify's February 2026 changelog removed outright, and it names no
  // replacement. The old code called it first and only fell back to per-id
  // GETs on a gated 403, which means on a current registration every census
  // burned a request on a route that can only fail. The census now goes
  // straight to the per-id read, and this is the assertion that pins it: a
  // single call to the removed route fails the test, it does not degrade.
  it('never requests the removed batch artist route and resolves all 120 ids per-id', async () => {
    const perIdCalls: string[] = [];
    const removedRouteCalls: string[] = [];
    const h = genreHarness((path, params) => {
      const top = topArtistsResponder(path, params);
      if (top !== undefined) return top;
      if (path === '/artists' || path.startsWith('/artists?')) {
        removedRouteCalls.push(path);
        return { artists: [] };
      }
      const single = /^\/artists\/(.+)$/.exec(path);
      if (single) {
        const id = decodeURIComponent(single[1]);
        perIdCalls.push(id);
        return { id, name: `Artist ${id}`, genres: [`g-${id}`] };
      }
      return null;
    });

    const out = await h.invoke('top_genre_census');
    const payload = out.structuredContent as {
      artists_census: number;
      resolved: number;
      unresolved_ids: string[];
      artist_requests: number;
      items: Array<{ genre: string; weighted_score: number }>;
    };

    assert.deepEqual(removedRouteCalls, [], 'a removed-endpoint request went out');
    // #801 acceptance, restated for the per-id read: every census id is
    // looked at, not just the first window's worth.
    assert.equal(payload.artists_census, 120, 'union of 3 × 40 distinct ids');
    assert.equal(payload.resolved, 120, 'every id resolved');
    assert.deepEqual(payload.unresolved_ids, [], 'no ids dropped');
    assert.equal(perIdCalls.length, 120, 'one /artists/{id} call per census id');
    assert.equal(payload.artist_requests, 120, 'the fan-out publishes its real request count');

    // No "unknown" bucket once every id resolved with a genre.
    assert.equal(payload.items.find((r) => r.genre === 'unknown'), undefined);
    // 120 distinct ids → 120 distinct genres; the items list is truncated by
    // the default max_results cap (50), but pagination.total reports all of
    // them so the caller can tell 120 was resolved, not 50.
    assert.equal(payload.items.length, 50, 'capped at the default max_results');
    const pagination = (out.structuredContent as { pagination: { total: number } }).pagination;
    assert.equal(pagination.total, 120, 'all 120 genres accounted for in pagination');
  });

  // #1004: a per-id read that fails is named, with the reason, and it is not
  // folded into an "unknown" genre as though the artist had no tags.
  it('names the ids whose per-id read failed, and reports the reason', async () => {
    const h = genreHarness((path, params) => {
      const top = topArtistsResponder(path, params);
      if (top !== undefined) return top;
      const single = /^\/artists\/(.+)$/.exec(path);
      if (single) {
        const id = decodeURIComponent(single[1]);
        if (id.endsWith('9')) throw new SpotifyApiError(429, 'Rate limited');
        return { id, name: `Artist ${id}`, genres: [`g-${id}`] };
      }
      return null;
    });

    const out = await h.invoke('top_genre_census');
    const payload = out.structuredContent as {
      artists_census: number;
      resolved: number;
      unresolved_ids: string[];
      unresolved: Array<{ id: string; reason: string }>;
    };

    // Ids ending in 9 across the three windows: a009, a019, a029, a039, a049,
    // …, a119 — 12 of the 120.
    assert.equal(payload.artists_census, 120);
    assert.equal(payload.unresolved_ids.length, 12);
    assert.equal(payload.resolved, 108);
    assert.equal(payload.unresolved.length, 12);
    assert.match(payload.unresolved[0].reason, /Rate limited/);
    // requested == resolved + unresolved, the accounting the header relies on.
    assert.equal(payload.artists_census, payload.resolved + payload.unresolved_ids.length);
    // The prose names them rather than reporting a confident total.
    assert.match(out.content[0].text, /12 ids unresolved/);
  });
});
