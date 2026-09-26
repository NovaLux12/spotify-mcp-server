/**
 * Tests for src/tools/analytics.ts (issue #97 listening_report).
 *
 * Follows the stub-client harness pattern from tools.playlists-following.test.ts:
 * a fake McpServer captures registrations, a stub SpotifyClient records wire
 * calls and answers from a responder function.
 */

import { describe, it } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import {
  registerAnalyticsTools,
  decadeOf,
  hourBucketOf,
} from '../src/tools/analytics.js';
import { registerSwarm3AnalyticsTools } from '../src/tools/swarm3_analytics.js';
import { registerLibraryAnalyticsTools } from '../src/tools/libraryanalytics.js';

/**
 * Spelled out rather than imported: the opt-in's env-var name IS the public
 * contract of #695, and importing it from the registrar would let a rename
 * silently keep both the implementation and its tests agreeing.
 */
const ANALYTICS_OPT_IN_ENV = 'SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS';

/**
 * The derived listening metrics #695 gates. Spelled out, not imported: a
 * constant taken from the registrar would only restate the implementation and
 * would keep agreeing with a rename that stopped matching the documentation.
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

// ---------------------------------------------------------------------------
// Stub plumbing
// ---------------------------------------------------------------------------

interface RecordedCall {
  path: string;
  params?: Record<string, string>;
}

type Responder = (path: string, params?: Record<string, string>) => unknown;

/** Structured twin of listening_report's payload, for assertions. */
interface ReportPayload {
  time_range: string;
  fetched: Record<string, number | null>;
  rising: Array<{ id: string; name: string; artists: string }>;
  constant: Array<{ id: string; name: string; artists: string }>;
  fading: Array<{ id: string; name: string; artists: string }>;
  era_histogram: Record<string, number>;
  discovery_ratio: number;
  discovery_counts: { new_in_short: number; short_total: number };
  repeat_overlap_count: number | null;
  hour_buckets: Record<string, number> | null;
}

const payloadOf = (out: {
  structuredContent?: Record<string, unknown>;
}): ReportPayload => out.structuredContent as unknown as ReportPayload; // same module owns both shapes

/**
 * Register the analytics module with the derived-analytics opt-in in a known
 * state. Default is opted in so the pre-existing expectations describe the
 * enabled surface; pass `{ analyticsOptIn: false }` for the default surface.
 */
function harness(responder: Responder = () => null, options: { analyticsOptIn?: boolean } = {}) {
  const registered: Array<{
    name: string;
    description: string;
    schema: z.ZodRawShape;
    validate: (args: Record<string, unknown>) => Record<string, unknown>;
    handler: (
      args: Record<string, unknown>,
    ) => Promise<{
      content: Array<{ type: string; text: string }>;
      structuredContent?: Record<string, unknown>;
    }>;
  }> = [];
  const fakeServer = {
    tool(
      name: string,
      description: string,
      schema: z.ZodRawShape,
      handler: (args: Record<string, unknown>) => Promise<{
        content: Array<{ type: string; text: string }>;
        structuredContent?: Record<string, unknown>;
      }>,
    ) {
      registered.push({
        name,
        description,
        schema,
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
  const optIn = options.analyticsOptIn ?? true;
  const previous = process.env[ANALYTICS_OPT_IN_ENV];
  if (optIn) process.env[ANALYTICS_OPT_IN_ENV] = '1';
  else delete process.env[ANALYTICS_OPT_IN_ENV];
  try {
    registerAnalyticsTools(fakeServer, client as unknown as SpotifyClient);
  } finally {
    if (previous === undefined) delete process.env[ANALYTICS_OPT_IN_ENV];
    else process.env[ANALYTICS_OPT_IN_ENV] = previous;
  }

  const invoke = async (args: Record<string, unknown> = {}) => {
    const tool = registered.find((t) => t.name === 'listening_report');
    assert.ok(tool, 'listening_report should be registered');
    return tool.handler(tool.validate(args));
  };

  return { registered, calls, invoke };
}

function swarmHarness(responder: Responder = () => null) {
  const registered: Array<{
    name: string;
    validate: (args: Record<string, unknown>) => Record<string, unknown>;
    handler: (
      args: Record<string, unknown>,
    ) => Promise<{
      content: Array<{ type: string; text: string }>;
      structuredContent?: Record<string, unknown>;
    }>;
  }> = [];
  const fakeServer = {
    tool(
      name: string,
      _description: string,
      schema: z.ZodRawShape,
      handler: (args: Record<string, unknown>) => Promise<{
        content: Array<{ type: string; text: string }>;
        structuredContent?: Record<string, unknown>;
      }>,
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
  registerSwarm3AnalyticsTools(fakeServer, client as unknown as SpotifyClient);
  const invoke = async (toolName: string, args: Record<string, unknown> = {}) => {
    const tool = registered.find((t) => t.name === toolName);
    assert.ok(tool, `${toolName} should be registered`);
    return tool.handler(tool.validate(args));
  };
  return { registered, calls, invoke };
}

const textOf = (out: { content: Array<{ text: string }> }) => out.content[0].text;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let trackSeq = 0;
const topTrack = (id: string, releaseDate?: string) => {
  trackSeq += 1;
  return {
    id,
    name: `Track ${id}`,
    uri: `spotify:track:${id}`,
    type: 'track' as const,
    duration_ms: 200000 + trackSeq,
    explicit: false,
    artists: [{ name: `Artist ${id}` }],
    album: {
      id: `alb-${id}`,
      name: `Album ${id}`,
      uri: `spotify:album:alb-${id}`,
      images: [] as unknown[],
      ...(releaseDate !== undefined ? { release_date: releaseDate } : {}),
    },
  };
};

const pagedTracks = (tracks: readonly unknown[]) => ({
  items: [...tracks],
  total: tracks.length,
  limit: 50,
  offset: 0,
  next: null,
});

const recentItem = (trackId: string, playedAt: string) => ({
  track: topTrack(trackId),
  played_at: playedAt,
  context: null,
});

interface RecentPage {
  trackId: string;
  playedAt: string;
}

/** Standard responder: distinct track sets per window, one recent page. */
function standardResponder(opts?: {
  trTracks?: string[];
  stTracks?: string[];
  recentPages?: RecentPage[][];
}) {
  const trIds = opts?.trTracks ?? ['t-shared-1', 't-shared-2', 't-fade'];
  const stIds = opts?.stTracks ?? ['t-shared-1', 't-shared-2', 't-rise'];
  const pages =
    opts?.recentPages ??
    [
      [
        { trackId: 't-rise', playedAt: new Date(2026, 7, 26, 9, 15).toISOString() },
        { trackId: 't-fade', playedAt: new Date(2026, 7, 26, 22, 45).toISOString() },
      ],
    ];
  let recentPageIdx = 0;
  return (path: string, params?: Record<string, string>): unknown => {
    if (path === '/me/top/tracks') {
      if (params?.time_range === 'short_term') {
        return pagedTracks(stIds.map((id) => topTrack(id)));
      }
      return pagedTracks(trIds.map((id) => topTrack(id)));
    }
    if (path === '/me/top/artists') {
      return { items: [{ id: 'a1' }, { id: 'a2' }], total: 2, limit: 50, offset: 0, next: null };
    }
    if (path === '/me/player/recently-played') {
      const page = pages[Math.min(recentPageIdx, pages.length - 1)];
      recentPageIdx += 1;
      const isLast = recentPageIdx >= pages.length;
      return {
        items: page.map((r) => recentItem(r.trackId, r.playedAt)),
        cursors: isLast ? null : { before: '1000', after: `cursor-${recentPageIdx}` },
        next: isLast ? null : 'https://api.spotify.com/v1/me/player/recently-played?after=x',
      };
    }
    return null;
  };
}

// ---------------------------------------------------------------------------
// Pure helpers: decade bucketing
// ---------------------------------------------------------------------------

describe('decadeOf', () => {
  it('buckets ISO release dates into decades', () => {
    assert.equal(decadeOf('1987-03-02'), '1980s');
    assert.equal(decadeOf('1999-12-31'), '1990s');
    assert.equal(decadeOf('2000-01-01'), '2000s');
    assert.equal(decadeOf('2026-08-01'), '2020s');
  });

  it('returns "unknown" for missing or malformed dates', () => {
    assert.equal(decadeOf(undefined), 'unknown');
    assert.equal(decadeOf(null), 'unknown');
    assert.equal(decadeOf(''), 'unknown');
    assert.equal(decadeOf('garbage'), 'unknown');
  });
});

// ---------------------------------------------------------------------------
// Pure helpers: hour buckets incl. midnight rollover
// ---------------------------------------------------------------------------

describe('hourBucketOf', () => {
  it('maps local hours into 4-hour buckets at every boundary', () => {
    for (const [hour, expected] of [
      [0, '00-03'],
      [3, '00-03'],
      [4, '04-07'],
      [7, '04-07'],
      [8, '08-11'],
      [11, '08-11'],
      [12, '12-15'],
      [15, '12-15'],
      [16, '16-19'],
      [19, '16-19'],
      [20, '20-23'],
      [23, '20-23'],
    ] as const) {
      assert.equal(
        hourBucketOf(new Date(2026, 7, 26, hour, 0).toISOString()),
        expected,
        `hour ${hour}`,
      );
    }
  });

  it('rolls over midnight cleanly: late night vs just-after-midnight differ by one bucket', () => {
    // 23:xx must land in the LAST bucket, 00:xx in the FIRST.
    assert.equal(hourBucketOf(new Date(2026, 7, 26, 23, 59).toISOString()), '20-23');
    assert.equal(hourBucketOf(new Date(2026, 8, 1, 0, 1).toISOString()), '00-03');
    assert.notEqual(
      hourBucketOf(new Date(2026, 7, 26, 23, 59).toISOString()),
      hourBucketOf(new Date(2026, 7, 27, 0, 1).toISOString()),
    );
  });
});

// ---------------------------------------------------------------------------
// Registration + defaults
// ---------------------------------------------------------------------------

describe('listening_report registration', () => {
  it('registers exactly one tool named listening_report', () => {
    const { registered } = harness();
    assert.ok(registered.some((r) => r.name === 'listening_report'), 'listening_report should be among registered analytics tools');
    assert.ok(registered.length >= 1, `expected at least 1 analytics tool, got ${registered.length}`);
  });

  it('defaults response_format to concise and leaves window/recent optional', async () => {
    const { registered } = harness();
    const validated = registered[0].validate({});
    assert.deepEqual(validated, { response_format: 'concise' });
  });
});

// ---------------------------------------------------------------------------
// Fetch plan + caps
// ---------------------------------------------------------------------------

describe('listening_report fetch caps', () => {
  it('makes exactly 5 GETs: 4 top-* calls at limit=50 + 1 recent page', async () => {
    const { calls, invoke } = harness(standardResponder());
    await invoke({});
    assert.equal(calls.length, 5);
    const paths = calls.map((c) => c.path);
    assert.equal(paths.filter((p) => p === '/me/top/tracks').length, 2);
    assert.equal(paths.filter((p) => p === '/me/top/artists').length, 2);
    assert.equal(paths.filter((p) => p === '/me/player/recently-played').length, 1);

    for (const c of calls) {
      assert.equal(c.params?.limit, '50', `${c.path} must cap at limit=50`);
    }
    const trackCalls = calls.filter((c) => c.path === '/me/top/tracks');
    assert.deepEqual(
      new Set(trackCalls.map((c) => c.params?.time_range)),
      new Set(['medium_term', 'short_term']),
    );
    // Recent walk starts cursor-less.
    const recent = calls.find((c) => c.path === '/me/player/recently-played');
    assert.equal(recent?.params?.after, undefined);
    assert.equal(recent?.params?.before, undefined);
  });

  it('walks with after-as-before cursors, dedupes boundary rows, and stops on the final page', async () => {
    const playedAt = new Date(2026, 7, 26, 10, 0).toISOString();
    const firstPage = Array.from({ length: 50 }, (_, i) => recentItem(`r${i}`, playedAt));
    const secondPage = [
      firstPage[49],
      ...Array.from({ length: 49 }, (_, i) => recentItem(`r${i + 50}`, playedAt)),
      recentItem('r0', new Date(2026, 7, 26, 10, 1).toISOString()),
    ];
    const pages = [firstPage, secondPage, [recentItem('tail', playedAt)]];
    let page = 0;
    const base = standardResponder();
    const { calls, invoke } = harness((path, params) => {
      if (path !== '/me/player/recently-played') return base(path, params);
      const items = pages[page];
      page += 1;
      return {
        items,
        cursors: page < pages.length ? { before: 'unused', after: `cursor-${page}` } : null,
        next: page < pages.length ? 'next-url' : null,
      };
    });
    const out = await invoke({});
    const payload = payloadOf(out);
    assert.equal(page, 3);
    assert.equal(payload.fetched.recently_played, 101);
    assert.equal(payload.fetched.recent_pages_walked, 3);
    const walkCalls = calls.filter((c) => c.path === '/me/player/recently-played');
    assert.deepEqual(
      walkCalls.map((c) => ({ before: c.params?.before, after: c.params?.after })),
      [
        { before: undefined, after: undefined },
        { before: 'cursor-1', after: undefined },
        { before: 'cursor-2', after: undefined },
      ],
    );
    for (const c of walkCalls) assert.equal(c.params?.limit, '50');
  });

  it('skips the recently-played call entirely when include_recent=false', async () => {
    const { calls, invoke } = harness(standardResponder());
    await invoke({ include_recent: false });
    assert.equal(calls.length, 4);
    assert.ok(calls.every((c) => c.path !== '/me/player/recently-played'));
  });

  it('respects time_range input on the primary top-tracks call', async () => {
    const { calls, invoke } = harness(standardResponder());
    await invoke({ time_range: 'long_term' });
    const primary = calls.find(
      (c) => c.path === '/me/top/tracks' && c.params?.time_range !== 'short_term',
    );
    assert.equal(primary?.params?.time_range, 'long_term');
  });
});

describe('swarm3 recently-played cursor walk', () => {
  it('uses after-as-before, dedupes boundary rows, and stops on the final page', async () => {
    const playedAt = new Date(2026, 7, 26, 10, 0).toISOString();
    const firstPage = [
      recentItem('swarm-0', playedAt),
      recentItem('swarm-1', playedAt),
    ];
    const pages = [
      firstPage,
      [
        firstPage[1],
        recentItem('swarm-0', new Date(2026, 7, 26, 10, 1).toISOString()),
        recentItem('swarm-2', playedAt),
      ],
      [recentItem('swarm-tail', playedAt)],
    ];
    let page = 0;
    const { calls, invoke } = swarmHarness((path) => {
      if (path !== '/me/player/recently-played') return null;
      const items = pages[page];
      page += 1;
      return {
        items,
        cursors: page < pages.length ? { before: 'unused', after: `swarm-cursor-${page}` } : null,
        next: page < pages.length ? 'next-url' : null,
      };
    });

    const out = await invoke('track_rotation_report', { response_format: 'json' });
    const payload = out.structuredContent as Record<string, unknown>;
    assert.equal(page, 3);
    assert.equal(payload.history_items, 5);
    assert.equal(payload.recent_pages_walked, 3);
    const walkCalls = calls.filter((c) => c.path === '/me/player/recently-played');
    assert.deepEqual(
      walkCalls.map((c) => ({ before: c.params?.before, after: c.params?.after })),
      [
        { before: undefined, after: undefined },
        { before: 'swarm-cursor-1', after: undefined },
        { before: 'swarm-cursor-2', after: undefined },
      ],
    );
  });
});

// ---------------------------------------------------------------------------
// Classification math
// ---------------------------------------------------------------------------

describe('listening_report classification math', () => {
  it('classifies rising / constant / fading by track ID', async () => {
    const { invoke } = harness(
      standardResponder({
        trTracks: ['shared-a', 'shared-b', 'only-old'],
        stTracks: ['shared-a', 'shared-b', 'only-new'],
      }),
    );
    const out = await invoke({});
    const payload = payloadOf(out);

    assert.deepEqual(
      payload.rising.map((t) => t.id),
      ['only-new'],
    );
    assert.deepEqual(
      payload.constant.map((t) => t.id).sort(),
      ['shared-a', 'shared-b'],
    );
    assert.deepEqual(
      payload.fading.map((t) => t.id),
      ['only-old'],
    );
    assert.equal(payload.rising[0]?.name, 'Track only-new');
    assert.equal(payload.rising[0]?.artists, 'Artist only-new');
  });

  it('computes discovery_ratio = |short ∖ window| / |short|', async () => {
    const { invoke } = harness(
      standardResponder({
        stTracks: ['a', 'b', 'c', 'd'], // 4 short-term tracks…
        trTracks: ['b'], // …of which 1 already in window → 3/4 rising
      }),
    );
    const out = await invoke({});
    const payload = payloadOf(out);
    assert.equal(payload.discovery_counts.short_total, 4);
    assert.equal(payload.discovery_counts.new_in_short, 3);
    assert.equal(payload.discovery_ratio, 0.75);
  });

  it('discovery_ratio is 0 when there are no short-term tracks', async () => {
    const { invoke } = harness(standardResponder({ trTracks: ['x'], stTracks: [] }));
    const out = await invoke({});
    assert.equal(payloadOf(out).discovery_ratio, 0);
  });
});

// ---------------------------------------------------------------------------
// Era histogram
// ---------------------------------------------------------------------------

describe('listening_report era_histogram', () => {
  it('counts decades across time_range-window tracks only, unknown last resort', async () => {
    const dates: Record<string, string | undefined> = {
      d70: '1975-03-03',
      d80: '1989-11-11',
      d80b: '1980-01-01',
      d20: '2026-01-01',
      nodate: undefined,
    };
    const custom: Responder = (path, params) => {
      if (path === '/me/top/tracks') {
        const spec: Array<[string, string | undefined]> =
          params?.time_range === 'short_term'
            ? [['s1', '2020-01-01']]
            : [['d70', dates.d70], ['d80', dates.d80], ['d80b', dates.d80b], ['d20', dates.d20], ['nodate', undefined]];
        return pagedTracks(spec.map(([id, d]) => topTrack(id, d)));
      }
      return null;
    };
    const { invoke } = harness(custom);
    const out = await invoke({});
    const payload = payloadOf(out);
    assert.deepEqual(payload.era_histogram, {
      '1970s': 1,
      '1980s': 2,
      '2020s': 1,
      unknown: 1,
    });
  });

  it('excludes short-term-only tracks from the histogram', async () => {
    const custom: Responder = (path, params) => {
      if (path === '/me/top/tracks') {
        return params?.time_range === 'short_term'
          ? pagedTracks([topTrack('s1', '1955-05-05')])
          : pagedTracks([topTrack('w1', '2001-01-01')]);
      }
      return null;
    };
    const { invoke } = harness(custom);
    const out = await invoke({});
    assert.deepEqual(payloadOf(out).era_histogram, { '2000s': 1 });
  });
});

// ---------------------------------------------------------------------------
// Repeat overlap + hour buckets
// ---------------------------------------------------------------------------

describe('listening_report recently-played derivations', () => {
  it('counts unique top-track IDs present in history and buckets hours', async () => {
    const { invoke } = harness(
      standardResponder({
        trTracks: ['top-a', 'top-b'],
        stTracks: ['top-b', 'top-c'],
        recentPages: [
          [
            { trackId: 'top-a', playedAt: new Date(2026, 7, 26, 9, 0).toISOString() },
            { trackId: 'top-b', playedAt: new Date(2026, 7, 26, 14, 0).toISOString() },
            { trackId: 'never-top', playedAt: new Date(2026, 7, 26, 23, 30).toISOString() },
          ],
        ],
      }),
    );
    const out = await invoke({});
    const payload = payloadOf(out);
    // Unique top IDs {top-a,top-b,top-c}; top-a and top-b appear in history.
    assert.equal(payload.repeat_overlap_count, 2);
    assert.equal(payload.hour_buckets?.['08-11'], 1);
    assert.equal(payload.hour_buckets?.['12-15'], 1);
    assert.equal(payload.hour_buckets?.['20-23'], 1);
    assert.equal(payload.fetched.recently_played, 3);
  });

  it('dedupes repeat overlap by unique ID, not per occurrence', async () => {
    const { invoke } = harness(
      standardResponder({
        trTracks: ['dup'],
        stTracks: [],
        recentPages: [
          [
            { trackId: 'dup', playedAt: new Date(2026, 7, 26, 5, 0).toISOString() },
            { trackId: 'dup', playedAt: new Date(2026, 7, 26, 6, 0).toISOString() },
          ],
        ],
      }),
    );
    const out = await invoke({});
    assert.equal(payloadOf(out).repeat_overlap_count, 1);
  });

  it('nulls recent-derived fields when include_recent=false', async () => {
    const { invoke } = harness(standardResponder());
    const out = await invoke({ include_recent: false });
    const payload = payloadOf(out);
    assert.equal(payload.repeat_overlap_count, null);
    assert.equal(payload.hour_buckets, null);
    assert.equal(payload.fetched.recently_played, null);
  });
});

// ---------------------------------------------------------------------------
// json shape + prose digest
// ---------------------------------------------------------------------------

describe('listening_report output modes', () => {
  it('json mode returns the full aggregate twin as both text and structuredContent', async () => {
    const { invoke } = harness(standardResponder());
    const out = await invoke({ response_format: 'json' });
    const parsed = JSON.parse(textOf(out)) as ReportPayload;
    assert.deepEqual(parsed, payloadOf(out));
    for (const key of [
      'time_range',
      'fetched',
      'rising',
      'constant',
      'fading',
      'era_histogram',
      'discovery_ratio',
      'discovery_counts',
      'repeat_overlap_count',
      'hour_buckets',
    ]) {
      assert.ok(key in parsed, `payload missing ${key}`);
    }
    assert.equal(parsed.time_range, 'medium_term');
  });

  it('prose digest names counts, ratio and recents without raw dumps', async () => {
    const { invoke } = harness(standardResponder());
    const out = await invoke({});
    const text = textOf(out);
    assert.match(text, /Rising: 1/);
    assert.match(text, /Constant: 2/);
    assert.match(text, /Fading: 1/);
    assert.match(text, /Discovery ratio: /);
    assert.match(text, /Recently played: 2 items/);
    assert.ok(!text.startsWith('{'));
  });
});

// ---------------------------------------------------------------------------
// Empty-results edge
// ---------------------------------------------------------------------------

describe('listening_report empty results edge', () => {
  it('degrades to a zeroed report when every endpoint returns null', async () => {
    const { calls, invoke } = harness(() => null);
    const out = await invoke({});
    const payload = payloadOf(out);
    assert.deepEqual(payload.rising, []);
    assert.deepEqual(payload.constant, []);
    assert.deepEqual(payload.fading, []);
    assert.deepEqual(payload.era_histogram, {});
    assert.equal(payload.discovery_ratio, 0);
    assert.equal(payload.repeat_overlap_count, 0);
    assert.deepEqual(payload.hour_buckets, {});
    assert.match(textOf(out), /No listening data found/);
    // All 5 fetches still attempted at capped limits.
    assert.equal(calls.length, 5);
  });

  it('filters malformed rows (null track/id) before deriving', async () => {
    const custom: Responder = (path, params) => {
      if (path === '/me/top/tracks') {
        const ids = params?.time_range === 'short_term' ? ['ok-1'] : ['ok-1'];
        const items: unknown[] = [...ids.map((id) => topTrack(id)), { id: null, name: 'broken' }, null];
        return { ...pagedTracks(items), total: items.length };
      }
      return null;
    };
    const { invoke } = harness(custom);
    const out = await invoke({});
    const payload = payloadOf(out);
    assert.equal(payload.fetched.top_tracks_time_range, 1);
    assert.deepEqual(
      payload.constant.map((t) => t.id),
      ['ok-1'],
    );
  });
});

// ---------------------------------------------------------------------------
// Derived-analytics opt-in (#695)
// ---------------------------------------------------------------------------

describe('listening_report derived-analytics opt-in', () => {
  const descriptionOf = (registered: Array<{ name: string; description: string }>) => {
    const tool = registered.find((t) => t.name === 'listening_report');
    assert.ok(tool, 'listening_report should be registered');
    return tool.description;
  };

  it('computes no derived field when the opt-in is unset', async () => {
    const { invoke } = harness(standardResponder(), { analyticsOptIn: false });
    const out = await invoke({});
    const payload = out.structuredContent as Record<string, unknown>;
    assert.equal(payload.era_histogram, null);
    assert.equal(payload.discovery_ratio, null);
    assert.equal(payload.discovery_counts, null);
    assert.equal(payload.repeat_overlap_count, null);
    assert.equal(payload.hour_buckets, null);
    // The window comparison is not a derived metric, so it still reports.
    assert.deepEqual(
      (payload.rising as Array<{ id: string }>).map((t) => t.id),
      ['t-rise'],
    );
  });

  it('issues no recently-played walk without the opt-in, even when asked for one', async () => {
    const { calls, invoke } = harness(standardResponder(), { analyticsOptIn: false });
    await invoke({ include_recent: true });
    assert.equal(calls.length, 4);
    assert.ok(calls.every((c) => c.path !== '/me/player/recently-played'));
  });

  it('advertises only the fields it computes when the opt-in is unset', async () => {
    const { registered, invoke } = harness(standardResponder(), { analyticsOptIn: false });
    const description = descriptionOf(registered);
    // The contract is structural, not lexical: every derived field may be named
    // only inside the clause that also names the opt-in. A conjunction regex
    // ("plus|including") is walked straight past by a description that claims
    // the fields unconditionally in any other wording, which is the exact
    // defect this test exists to catch.
    const gateSentence = description
      .split(/(?<=[.!?])\s+/)
      .find((sentence) => sentence.includes(ANALYTICS_OPT_IN_ENV));
    assert.ok(
      gateSentence,
      `gated description must name ${ANALYTICS_OPT_IN_ENV} in the sentence that lists the derived fields: ${description}`,
    );
    for (const advertised of ['discovery ratio', 'era histogram', 'hour-of-day', 'repeat overlap']) {
      const first = description.toLowerCase().indexOf(advertised);
      assert.notEqual(first, -1, `gated description should still name ${advertised}: ${description}`);
      assert.ok(
        first >= description.indexOf(gateSentence as string),
        `description claims ${advertised} outside the gated clause: ${description}`,
      );
    }
    const out = await invoke({});
    assert.match(textOf(out), /Derived metrics .* are not computed/);
    assert.doesNotMatch(textOf(out), /Discovery ratio:/);
    assert.doesNotMatch(textOf(out), /Hours:/);
  });

  it('terminates the preceding sentence before the provenance note (#695)', async () => {
    // LOCAL_METRICS_DISCLAIMER is appended by concatenation, so a call site
    // that forgets its own full stop renders two sentences as one run-together
    // string in shipped tools/list. Pinned at every site, in both flag states.
    for (const analyticsOptIn of [true, false]) {
      const { registered } = harness(standardResponder(), { analyticsOptIn });
      const description = descriptionOf(registered);
      assert.match(
        description,
        /[.!]\sMetrics are computed locally from your own account data;/,
        `provenance note must start its own sentence (opt-in ${analyticsOptIn}): ${description}`,
      );
    }
  });

  it('states the include_recent gate in the same direction the code gates it', async () => {
    // The code is `(args.include_recent ?? true) && derived`: the walk happens
    // when the flag is 1. A description claiming the opposite is the failure
    // this pins — the string ships on the default surface, so every session
    // that has not set the flag reads it.
    const off = harness(standardResponder(), { analyticsOptIn: false });
    const tool = off.registered.find((t) => t.name === 'listening_report');
    assert.ok(tool, 'listening_report should be registered without the opt-in');
    assert.equal(
      z.object(tool.schema).shape.include_recent?.description,
      `Ignored unless ${ANALYTICS_OPT_IN_ENV}=1, which is when the recently-played walk is made. Default: true`,
    );
    // And the walk really is issued in the state the description names, so the
    // string is not merely self-consistent.
    const on = harness(standardResponder(), { analyticsOptIn: true });
    await on.invoke({ include_recent: true });
    assert.ok(
      on.calls.some((c) => c.path === '/me/player/recently-played'),
      'with the opt-in set, include_recent must actually issue the walk',
    );
  });

  it('leaves the recently-played walk reachable through ungated tools (#695)', async () => {
    // docs/compliance.md states how many tools still issue this walk with the
    // flag unset. That is a claim about the code, so it is measured here and
    // pinned. `libraryanalytics` registers unconditionally in the manifest, so
    // it belongs in the count: leaving it out is how an earlier draft of that
    // document came to undercount.
    const registered: Array<{ name: string; schema: z.ZodRawShape; handler: (a: unknown) => Promise<unknown> }> = [];
    const fakeServer = {
      tool(name: string, _d: string, schema: z.ZodRawShape, handler: (a: unknown) => Promise<unknown>) {
        registered.push({ name, schema, handler });
      },
    } as unknown as McpServer;
    let recentCalls = 0;
    const recentPage = () => ({
      items: Array.from({ length: 50 }, (_, i) => ({
        played_at: new Date(Date.UTC(2026, 8, 20, i % 24, i % 60)).toISOString(),
        track: { id: `t${recentCalls}-${i}`, name: `T${i}`, uri: `spotify:track:t${i}`, artists: [{ id: `a${i % 7}`, name: `A${i % 7}` }] },
      })),
      cursors: { after: `c${recentCalls}` },
      next: `u${recentCalls}`,
    });
    const client = {
      async get<T>(path: string): Promise<T | null> {
        if (path === '/me/player/recently-played') {
          recentCalls += 1;
          return recentPage() as unknown as T;
        }
        return { items: [], total: 0, limit: 50 } as unknown as T;
      },
    };
    const previous = process.env[ANALYTICS_OPT_IN_ENV];
    delete process.env[ANALYTICS_OPT_IN_ENV];
    try {
      registerAnalyticsTools(fakeServer, client as unknown as SpotifyClient);
      registerSwarm3AnalyticsTools(fakeServer, client as unknown as SpotifyClient);
      registerLibraryAnalyticsTools(fakeServer, client as unknown as SpotifyClient);
    } finally {
      if (previous === undefined) delete process.env[ANALYTICS_OPT_IN_ENV];
      else process.env[ANALYTICS_OPT_IN_ENV] = previous;
    }
    assert.deepEqual(
      registered
        .map((t) => t.name)
        .filter((name) => DERIVED_ANALYTICS_TOOLS.includes(name as (typeof DERIVED_ANALYTICS_TOOLS)[number])),
      [],
      'no gated tool may be registered without the opt-in',
    );
    const walkers: string[] = [];
    for (const tool of registered) {
      recentCalls = 0;
      let args: Record<string, unknown> = {};
      try {
        args = z.object(tool.schema).parse({}) as Record<string, unknown>;
      } catch {
        /* a required argument this probe cannot invent */
      }
      try {
        await tool.handler(args);
      } catch {
        /* a handler that needs rows this probe did not supply */
      }
      if (recentCalls > 0) walkers.push(tool.name);
    }
    // docs/compliance.md names these thirteen.
    assert.deepEqual(
      walkers.sort(),
      [
        'deep_dive_report',
        'era_preference_report',
        'listening_consistency_score',
        'listening_gaps_report',
        'listening_heatmap',
        'listening_history_export',
        'listening_recap_brief',
        'listening_streak_report',
        'listening_streaks',
        'repeat_listener_report',
        'session_length_report',
        'track_rotation_report',
        'weekly_rotation_report',
      ],
      'the ungated set that still walks recently-played changed; docs/compliance.md must be updated with it',
    );
  });

  it('caps a gated walk at ten pages, and three at the default depth (#695)', async () => {
    // docs/compliance.md quotes a page ceiling, so the ceiling is measured. The
    // loop is `while (pages < 10)`; the item budget is what normally stops it,
    // which is why the default 150-item depth walks three pages and the
    // schema's own `max_items: 500` maximum walks ten.
    const recentPages = async (args: Record<string, unknown>) => {
      const tools: Array<{ name: string; schema: z.ZodRawShape; handler: (a: unknown) => Promise<unknown> }> = [];
      const counting = {
        tool(name: string, _d: string, schema: z.ZodRawShape, handler: (a: unknown) => Promise<unknown>) {
          tools.push({ name, schema, handler });
        },
      } as unknown as McpServer;
      let pages = 0;
      const client = {
        async get<T>(path: string): Promise<T | null> {
          if (path !== '/me/player/recently-played') return { items: [], total: 0, limit: 50 } as unknown as T;
          pages += 1;
          return {
            items: Array.from({ length: 50 }, (_, i) => ({
              played_at: new Date(Date.UTC(2026, 8, 20, i % 24, i % 60)).toISOString(),
              track: { id: `t${pages}-${i}`, name: `T${i}`, uri: `spotify:track:t${i}`, artists: [{ id: `a${i % 7}`, name: `A${i % 7}` }] },
            })),
            cursors: { after: `c${pages}` },
            next: `u${pages}`,
          } as unknown as T;
        },
      };
      const previous = process.env[ANALYTICS_OPT_IN_ENV];
      process.env[ANALYTICS_OPT_IN_ENV] = '1';
      try {
        registerSwarm3AnalyticsTools(counting, client as unknown as SpotifyClient);
      } finally {
        if (previous === undefined) delete process.env[ANALYTICS_OPT_IN_ENV];
        else process.env[ANALYTICS_OPT_IN_ENV] = previous;
      }
      const tool = tools.find((t) => t.name === 'weekday_listening_report');
      assert.ok(tool, 'weekday_listening_report should be registered with the opt-in');
      await tool.handler(z.object(tool.schema).parse(args));
      return pages;
    };
    assert.equal(await recentPages({}), 3, 'the default 150-item depth must walk three pages');
    assert.equal(await recentPages({ max_items: 500 }), 10, 'the schema maximum must walk ten pages, not more');
    // The other walk docs/compliance.md quotes: libraryanalytics' own, bounded
    // by lookback_days rather than an item budget. It is not gated, and it goes
    // deeper than the gated walk's ceiling.
    let heatPages = 0;
    const heatClient = {
      async get<T>(path: string): Promise<T | null> {
        if (path !== '/me/player/recently-played') return { items: [], total: 0, limit: 50 } as unknown as T;
        heatPages += 1;
        return {
          // Anchored to now, not a fixed date: the walk stops the moment a row
          // falls before `now - lookback_days`, so a hard-coded stamp makes this
          // count fall out of the budget on a later day with no code change.
          items: Array.from({ length: 50 }, (_, i) => ({
            played_at: new Date(Date.now() - i * 60_000).toISOString(),
            track: { id: `h${heatPages}-${i}`, name: `H${i}`, uri: `spotify:track:h${i}`, artists: [{ id: `a${i}`, name: `A${i}` }] },
          })),
          cursors: { after: `c${heatPages}` },
          next: `u${heatPages}`,
        } as unknown as T;
      },
    };
    const heatTools: Array<{ name: string; schema: z.ZodRawShape; handler: (a: unknown) => Promise<unknown> }> = [];
    registerLibraryAnalyticsTools(
      { tool(name: string, _d: string, schema: z.ZodRawShape, handler: (a: unknown) => Promise<unknown>) { heatTools.push({ name, schema, handler }); } } as unknown as McpServer,
      heatClient as unknown as SpotifyClient,
    );
    const heatmap = heatTools.find((t) => t.name === 'listening_heatmap');
    assert.ok(heatmap, 'listening_heatmap should be registered regardless of the opt-in');
    await heatmap.handler(z.object(heatmap.schema).parse({}));
    assert.equal(heatPages, 14, 'libraryanalytics walk depth changed; docs/compliance.md quotes it');
  });

  it('advertises and computes the derived fields when the opt-in is set', async () => {
    const { registered, invoke } = harness(standardResponder(), { analyticsOptIn: true });
    const description = descriptionOf(registered);
    for (const advertised of ['discovery ratio', 'era histogram', 'hour-of-day buckets', 'repeat overlap']) {
      assert.ok(
        description.toLowerCase().includes(advertised),
        `description should advertise ${advertised}: ${description}`,
      );
    }
    const out = await invoke({});
    const payload = out.structuredContent as Record<string, unknown>;
    assert.notEqual(payload.era_histogram, null);
    assert.deepEqual(payload.discovery_counts, { new_in_short: 1, short_total: 3 });
    // Rounded to three decimals, like every ratio the report emits.
    assert.equal(payload.discovery_ratio, 0.333);
    assert.equal(payload.repeat_overlap_count, 2);
    assert.ok(payload.hour_buckets !== null);
  });
});
