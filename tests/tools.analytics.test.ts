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

function harness(responder: Responder = () => null) {
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
  registerAnalyticsTools(fakeServer, client as unknown as SpotifyClient);

  const invoke = async (args: Record<string, unknown> = {}) => {
    const tool = registered.find((t) => t.name === 'listening_report');
    assert.ok(tool, 'listening_report should be registered');
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
    assert.equal(registered.length, 1);
    assert.equal(registered[0].name, 'listening_report');
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

  it('walks recently-played via after cursors, at most 3 pages / ≤150 items', async () => {
    // Two full pages then a short page → 3 walks total; the page-3 cursor is
    // present but never followed.
    const fullPage = Array.from({ length: 50 }, (_, i) => ({
      trackId: `r${i}`,
      playedAt: new Date(2026, 7, 26, 10, 0).toISOString(),
    }));
    let page = 0;
    let recentCalls = 0;
    const base = standardResponder();
    const { calls, invoke } = harness((path, params) => {
      if (path !== '/me/player/recently-played') return base(path, params);
      recentCalls += 1;
      page += 1;
      if (page <= 2) {
        return {
          items: fullPage.map((r) => recentItem(r.trackId, r.playedAt)),
          cursors: { before: 'b', after: `cursor-${page}` },
          next: 'next-url',
        };
      }
      return {
        items: [recentItem('tail', new Date(2026, 7, 26, 10, 0).toISOString())],
        cursors: { before: 'b', after: 'cursor-3' }, // present but never followed
        next: 'next-url',
      };
    });
    void recentCalls;
    const out = await invoke({});
    const payload = payloadOf(out);
    assert.equal(page, 3); // ≤3 cursor walks
    assert.equal(payload.fetched.recently_played, 101); // 50+50+1 ≤ 150
    assert.equal(payload.fetched.recent_pages_walked, 3);
    const walkCalls = calls.filter((c) => c.path === '/me/player/recently-played');
    assert.equal(walkCalls[0].params?.after, undefined);
    assert.equal(walkCalls[1].params?.after, 'cursor-1');
    assert.equal(walkCalls[2].params?.after, 'cursor-2');
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
