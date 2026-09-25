import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerSwarm3AnalyticsTools } from '../src/tools/swarm3_analytics.js';
/**
 * Spelled out rather than imported: the opt-in's env-var name IS the public
 * contract of #695, and importing it from the registrar would let a rename
 * silently keep both the implementation and its tests agreeing.
 */
const ANALYTICS_OPT_IN_ENV = 'SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS';

/**
 * The derived listening metrics #695 gates. Hard-coded here on purpose: a
 * constant imported from the registrar would only restate the implementation.
 */
const DERIVED_ANALYTICS_TOOLS = [
  'binge_detector_report',
  'discovery_ratio',
  'listening_clock',
  'listening_clock_heatmap',
  'mood_bucket_report',
  'artist_listening_clock',
  'weekday_listening_report',
] as const;

/** Ungated members of the same module — the gate must not take these. */
const UNGATED_ANALYTICS_TOOLS = [
  'listening_history_export',
  'weekly_rotation_report',
] as const;


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

/** `artistId` is separate from the track id so several tracks can belong to
 * one artist — the binge detector counts plays per artist, not per track. */
function playedAt(id: string, played_at: string, artistId = `artist-${id}`): RecentItem {
  return {
    played_at,
    track: {
      id,
      name: `Track ${id}`,
      uri: `spotify:track:${id}`,
      artists: [{ id: artistId, name: `Artist ${artistId}` }],
    },
  };
}

/**
 * Register the module with the derived-analytics opt-in in a known state.
 * Registration reads the env once, so it is set only around the call and the
 * process env is restored before any handler runs.
 */
function harness(recent: RecentItem[], options: { analyticsOptIn?: boolean } = {}) {
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

  const optIn = options.analyticsOptIn ?? true;
  const previous = process.env[ANALYTICS_OPT_IN_ENV];
  if (optIn) process.env[ANALYTICS_OPT_IN_ENV] = '1';
  else delete process.env[ANALYTICS_OPT_IN_ENV];
  try {
    registerSwarm3AnalyticsTools(fakeServer, client as unknown as SpotifyClient);
  } finally {
    if (previous === undefined) delete process.env[ANALYTICS_OPT_IN_ENV];
    else process.env[ANALYTICS_OPT_IN_ENV] = previous;
  }

  const byName = new Map(registered.map((tool) => [tool.name, tool]));
  return {
    names: registered.map((tool) => tool.name),
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
// Derived-analytics opt-in (#695)
// ---------------------------------------------------------------------------

describe('derived listening analytics opt-in', () => {
  const recent = [
    playedAt('a', '2026-09-20T10:00:00Z'),
    playedAt('a', '2026-09-20T11:00:00Z'),
    playedAt('b', '2026-09-20T12:00:00Z'),
    ...Array.from({ length: 3 }, (_, i) => playedAt(`c${i}`, '2026-09-20T13:00:00Z', 'artist-loop')),
    ...Array.from({ length: 3 }, (_, i) => playedAt(`c${i}`, '2026-09-21T14:00:00Z', 'artist-loop')),
  ];

  it('registers none of the derived metrics when the opt-in is unset', () => {
    const { names } = harness(recent, { analyticsOptIn: false });
    for (const name of DERIVED_ANALYTICS_TOOLS) {
      assert.ok(!names.includes(name), `${name} must not be registered without ${ANALYTICS_OPT_IN_ENV}`);
    }
  });

  it('keeps the ungated members of the same module registered without the opt-in', () => {
    const { names } = harness(recent, { analyticsOptIn: false });
    for (const name of UNGATED_ANALYTICS_TOOLS) {
      assert.ok(names.includes(name), `${name} must stay available without ${ANALYTICS_OPT_IN_ENV}`);
    }
  });

  it('registers every derived metric when the opt-in is set', () => {
    const { names } = harness(recent, { analyticsOptIn: true });
    for (const name of DERIVED_ANALYTICS_TOOLS) {
      assert.ok(names.includes(name), `${name} must be registered with ${ANALYTICS_OPT_IN_ENV}=1`);
    }
  });

  it('returns the same payload as before once opted in (binge detector)', async () => {
    const out = await harness(recent, { analyticsOptIn: true }).invoke('binge_detector_report');
    const payload = out.structuredContent as { threshold: number; binges: Array<{ id: string; plays: number }> };
    assert.equal(payload.threshold, 5);
    // Only the looped artist clears the default threshold of 5 plays.
    assert.deepEqual(payload.binges.map((b) => [b.id, b.plays]), [['artist-loop', 6]]);
  });

  it('returns the same payload as before once opted in (weekday report)', async () => {
    const out = await harness(recent, { analyticsOptIn: true }).invoke('weekday_listening_report');
    const payload = out.structuredContent as {
      weekdays: Array<{ weekday: string; plays: number }>;
      busiest_weekday: string;
    };
    // 2026-09-20 is a Sunday, 2026-09-21 a Monday.
    assert.deepEqual(
      payload.weekdays.filter((d) => d.plays > 0).map((d) => [d.weekday, d.plays]),
      [['Mon', 3], ['Sun', 6]],
    );
    assert.equal(payload.busiest_weekday, 'Sun');
  });
});
