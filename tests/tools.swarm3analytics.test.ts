import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
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
