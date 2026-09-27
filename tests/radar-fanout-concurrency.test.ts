/**
 * #783 — the freshness-radar fan-outs run overlapped, under a width bound.
 *
 * Four tools used to issue one awaited request per show / artist / search type
 * from a serial loop, so a default-budget `show_new_episodes` was 25 round
 * trips back to back. These tests pin the three properties that matter and are
 * easy to get wrong independently:
 *
 *  1. **The bound holds.** The fake client counts requests in flight and
 *     remembers the peak. A run that merely "happens to be parallel" is not
 *     enough — a helper that fires everything at once would also satisfy
 *     "concurrency > 1", so the ceiling is asserted too.
 *  2. **Correctness survives.** Every input is still requested exactly once, and
 *     the output order is the input order — the radar renders and persists what
 *     it returns, so settle order leaking into it would make two runs of the
 *     same watchlist disagree.
 *  3. **A 429 stops scheduling, it does not retry.** The remaining budget is
 *     never sent, and the rows already paid for are still returned.
 *
 * Nothing here waits on a clock. The "slow" fake requests resolve after a fixed
 * number of microtask turns, so overlap is observable (a worker is suspended
 * between two turns) while the test's wall clock stays at zero and the ordering
 * is the same on every run.
 */

import './helpers/hermetic.js';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { mapLimit } from '../src/concurrency.js';
import { registerShowRadarTools, resetProfileCountryCache } from '../src/tools/showradar.js';
import { registerArtistWatchTools } from '../src/tools/artistwatch.js';
import { registerSearchDeepTool } from '../src/tools/searchdive.js';
import { DEFAULT_MAX_CONCURRENCY, MAX_CONCURRENCY_CEILING, initConfig } from '../src/config.js';

// ---------------------------------------------------------------------------
// Clock-free concurrency
// ---------------------------------------------------------------------------

/**
 * Yield `turns` microtask turns. A request that returns after several turns is
 * observable as in-flight overlap to anything counting entry and exit, and —
 * unlike a real sleep — costs no wall clock and never reorders.
 */
function afterTurns(turns: number): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < turns; i++) p = p.then(() => undefined);
  return p;
}

/** Peaks measured in microtask turns are stable, but not worth being exact about. */
const TURNS = 6;

/** Tracks how many fake requests are outstanding at once and which ones. */
class InFlight {
  current = 0;
  peak = 0;
  readonly started: string[] = [];

  async run<T>(id: string, value: () => T, turns = TURNS): Promise<T> {
    this.started.push(id);
    this.current++;
    if (this.current > this.peak) this.peak = this.current;
    try {
      await afterTurns(turns);
      return value();
    } finally {
      this.current--;
    }
  }
}

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};
type RegisteredTool = {
  name: string;
  validate: (a: Record<string, unknown>) => Record<string, unknown>;
  handler: (a: Record<string, unknown>) => Promise<ToolResult>;
};

/** A server stub that records registrations instead of serving MCP. */
function fakeServer(): { server: McpServer; registered: RegisteredTool[] } {
  const registered: RegisteredTool[] = [];
  const server = {
    tool(n: string, _d: string, schema: z.ZodRawShape, h: RegisteredTool['handler']) {
      registered.push({ name: n, validate: (a) => z.object(schema).parse(a), handler: h });
    },
  } as unknown as McpServer;
  return { server, registered };
}

const pick = (registered: RegisteredTool[], name: string): RegisteredTool => {
  const t = registered.find((r) => r.name === name);
  assert.ok(t, `${name} registered`);
  return t;
};

/**
 * Pin the fan-out width and re-read the config snapshot the tools read.
 *
 * `SPOTIFY_MCP_MAX_CONCURRENCY` is cleared as well as the tool's own knob: the
 * funnel's width takes precedence (#892), so a test that set only
 * `SPOTIFY_MCP_FANOUT_CONCURRENCY` would silently get the funnel's number on
 * any machine that exports it, and the test would assert the wrong width while
 * still passing. Tests that mean to exercise the precedence pass both.
 */
async function withFanout(
  width: number | undefined,
  fn: () => Promise<void>,
  opts: { funnel?: number } = {},
): Promise<void> {
  const prev = process.env.SPOTIFY_MCP_FANOUT_CONCURRENCY;
  const prevFunnel = process.env.SPOTIFY_MCP_MAX_CONCURRENCY;
  if (width === undefined) delete process.env.SPOTIFY_MCP_FANOUT_CONCURRENCY;
  else process.env.SPOTIFY_MCP_FANOUT_CONCURRENCY = String(width);
  if (opts.funnel === undefined) delete process.env.SPOTIFY_MCP_MAX_CONCURRENCY;
  else process.env.SPOTIFY_MCP_MAX_CONCURRENCY = String(opts.funnel);
  initConfig(process.env);
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.SPOTIFY_MCP_FANOUT_CONCURRENCY;
    else process.env.SPOTIFY_MCP_FANOUT_CONCURRENCY = prev;
    if (prevFunnel === undefined) delete process.env.SPOTIFY_MCP_MAX_CONCURRENCY;
    else process.env.SPOTIFY_MCP_MAX_CONCURRENCY = prevFunnel;
    initConfig(process.env);
  }
}

/** Point the artist-watchlist sidecar at a directory this test owns. */
async function withTmpDir(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'fanout-'));
  const prev = process.env.SPOTIFY_MCP_DATA_DIR;
  process.env.SPOTIFY_MCP_DATA_DIR = dir;
  try {
    await fn();
  } finally {
    process.env.SPOTIFY_MCP_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
const recent = daysAgo(1);

// ---------------------------------------------------------------------------
// mapLimit itself
// ---------------------------------------------------------------------------

describe('mapLimit (#783)', () => {
  it('keeps results in input order however the work settles', async () => {
    // Settle order is the reverse of input order on purpose: if the helper
    // pushed results as they landed, this would come back reversed.
    const out = await mapLimit([0, 1, 2, 3, 4, 5], 6, async (i) => {
      await afterTurns(6 - i);
      return i * 10;
    });
    assert.deepEqual(out.results, [0, 10, 20, 30, 40, 50]);
    assert.equal(out.started, 6);
    assert.equal(out.succeeded, 6);
    assert.equal(out.stoppedEarly, false);
  });

  it('never exceeds the width, however fast the work is', async () => {
    const gauge = new InFlight();
    await mapLimit([0, 1, 2, 3, 4, 5, 6, 7], 3, (i) => gauge.run(`w${i}`, () => i, 1));
    assert.equal(gauge.peak, 3);
  });

  it('collects rejections instead of throwing, and keeps the good slots', async () => {
    const out = await mapLimit([0, 1, 2], 3, async (i) => {
      if (i === 1) throw new Error('boom');
      return i;
    });
    assert.deepEqual(out.results, [0, undefined, 2]);
    assert.equal(out.errors.length, 1);
    assert.equal(out.errors[0]?.index, 1);
    assert.match(String((out.errors[0]?.error as Error).message), /boom/);
    assert.equal(out.succeeded, 2);
  });

  it('stops scheduling once shouldStop turns true, and starts nothing new', async () => {
    const issued: number[] = [];
    let stop = false;
    // Two workers start; the first flips the flag only after a few turns, so
    // the second is genuinely mid-request when it does. A stop checked only at
    // spawn time would pass this test without ever consulting the flag.
    const out = await mapLimit([0, 1, 2, 3, 4, 5], 2, async (i) => {
      issued.push(i);
      await afterTurns(2);
      if (i === 0) stop = true;
      await afterTurns(4);
      return i;
    }, { shouldStop: () => stop });
    assert.equal(stop, true);
    // Worker 0 was already in flight when the flag went up, and its answer is
    // kept — a request that was sent is not un-sent by ignoring it. But
    // neither worker picks up a third item.
    assert.deepEqual(issued, [0, 1]);
    assert.equal(out.stoppedEarly, true);
    assert.equal(out.started, 2);
    assert.deepEqual(out.results, [0, 1, undefined, undefined, undefined, undefined]);
  });

  it('treats a nonsensical width as 1 rather than scanning nothing', async () => {
    for (const width of [0, -5, Number.NaN]) {
      const out = await mapLimit([1, 2, 3], width, async (i) => i);
      assert.deepEqual(out.results, [1, 2, 3], `width ${width}`);
    }
  });
});

// ---------------------------------------------------------------------------
// show_new_episodes
// ---------------------------------------------------------------------------

interface ShowRadarHarness {
  invoke: (args?: Record<string, unknown>) => Promise<ToolResult>;
  gauge: InFlight;
}

function showRadarHarness(opts: {
  shows: number;
  /** Show id (without the `s` prefix) whose episode read hits the quota wall. */
  quotaOn?: string;
}): ShowRadarHarness {
  const { server, registered } = fakeServer();
  const gauge = new InFlight();
  const showId = (i: number) => `s${i}`;

  const client = {
    async getAllPages<T>(path: string): Promise<T[]> {
      if (path === '/me/shows') {
        return Array.from({ length: opts.shows }, (_, i) => ({
          added_at: '2026-01-01T00:00:00Z',
          // Episode release dates and show names are arranged so the radar's
          // own sort (newest first, then show name) is the tie-break under
          // test: every show has exactly one episode, all equally recent, so
          // the rendered order is decided by show_name alone.
          show: { id: showId(i), name: `Show ${String(i).padStart(2, '0')}`, uri: `spotify:show:${showId(i)}` },
        })) as unknown as T[];
      }
      return [];
    },
    async get<T>(path: string): Promise<T | null> {
      const m = /^\/shows\/([^/]+)\/episodes$/.exec(path);
      if (!m) return null;
      const id = decodeURIComponent(m[1] as string);
      if (opts.quotaOn && id === opts.quotaOn) {
        await gauge.run(id, () => {
          throw Object.assign(new Error('quota'), {
            status: 429,
            reason: 'QUOTA_EXCEEDED',
            retryAfterSec: 5,
          });
        }, 1);
      }
      return gauge.run(id, () => ({
        items: [{
          id: `e${id}`,
          name: `Episode ${id}`,
          uri: `spotify:episode:e${id}`,
          duration_ms: 60_000,
          release_date: recent,
        }],
        total: 1,
      })) as T;
    },
  };

  registerShowRadarTools(server, client as unknown as SpotifyClient);
  const tool = pick(registered, 'show_new_episodes');
  return {
    gauge,
    invoke: (args = {}) => tool.handler(tool.validate({ days: 7, per_show_limit: 5, ...args })),
  };
}

describe('show_new_episodes fan-out (#783)', () => {
  afterEach(() => resetProfileCountryCache());

  it('overlaps a 6-show scan and never exceeds the configured width', async () => {
    const h = showRadarHarness({ shows: 6 });
    const out = await h.invoke();
    const p = out.structuredContent as {
      fanout_concurrency: number;
      fanout_concurrency_source: string;
      shows_scanned: number;
      episodes: Array<{ show_name: string; episode_id: string }>;
    };

    // The bound: neither knob is set, so the width is the funnel's own
    // resolved default (#892) — the scan is longer than that, so a
    // run-everything-at-once implementation would peak at 6 and fail here.
    assert.equal(p.fanout_concurrency, DEFAULT_MAX_CONCURRENCY);
    assert.equal(p.fanout_concurrency_source, 'default');
    assert.equal(h.gauge.peak, DEFAULT_MAX_CONCURRENCY);

    // The overlap: a serial loop peaks at exactly 1.
    assert.ok(h.gauge.peak > 1, `expected overlap, peak was ${h.gauge.peak}`);

    // Correctness: every show was read, and the rows come back in show order.
    assert.equal(p.shows_scanned, 6);
    assert.equal(p.episodes.length, 6);
    assert.deepEqual(p.episodes.map((e) => e.show_name), [
      'Show 00', 'Show 01', 'Show 02', 'Show 03', 'Show 04', 'Show 05',
    ]);
  });

  it('honours a narrower SPOTIFY_MCP_FANOUT_CONCURRENCY and names it in the payload', async () => {
    await withFanout(2, async () => {
      const h = showRadarHarness({ shows: 6 });
      const out = await h.invoke();
      const p = out.structuredContent as { fanout_concurrency: number; fanout_concurrency_source: string };
      assert.equal(p.fanout_concurrency, 2);
      assert.equal(p.fanout_concurrency_source, 'SPOTIFY_MCP_FANOUT_CONCURRENCY');
      assert.equal(h.gauge.peak, 2);
    });
  });

  it('a width of 1 is the old strictly-serial walk, not a broken scan', async () => {
    await withFanout(1, async () => {
      const h = showRadarHarness({ shows: 6 });
      const out = await h.invoke();
      const p = out.structuredContent as { shows_scanned: number; episodes: unknown[] };
      assert.equal(h.gauge.peak, 1);
      assert.equal(p.shows_scanned, 6);
      assert.equal(p.episodes.length, 6);
    });
  });

  it('yields to the request funnel width and reports that source, not its own (#892)', async () => {
    // The funnel's knob wins, so the scan runs at the funnel's width and says
    // so. If the precedence were reversed the tool would report 2 while the
    // funnel permits 3 — a disclosure describing a concurrency that never
    // happened, which is the AGENTS.md §6 failure, not a style nit.
    await withFanout(2, async () => {
      const h = showRadarHarness({ shows: 6 });
      const out = await h.invoke();
      const p = out.structuredContent as { fanout_concurrency: number; fanout_concurrency_source: string };
      assert.equal(p.fanout_concurrency, 3);
      assert.equal(p.fanout_concurrency_source, 'SPOTIFY_MCP_MAX_CONCURRENCY');
      // The bound must be the one reported, not merely the one configured:
      // reporting 3 while peaking at 2 is fine, reporting 3 while peaking at 4
      // would mean the disclosure does not describe the run.
      assert.equal(h.gauge.peak, 3);
      assert.equal(p.shows_scanned, 6);
    }, { funnel: 3 });
  });

  it('a wider funnel width is not truncated to the tool default', async () => {
    // The precedence must be a real read, not a clamp: an operator who raises
    // the funnel to 8 has asked for 8, and silently capping at 4 would make
    // SPOTIFY_MCP_MAX_CONCURRENCY a knob that does less than it says.
    await withFanout(1, async () => {
      const h = showRadarHarness({ shows: 8 });
      const out = await h.invoke();
      const p = out.structuredContent as { fanout_concurrency: number; fanout_concurrency_source: string };
      assert.equal(p.fanout_concurrency, 8);
      assert.equal(p.fanout_concurrency_source, 'SPOTIFY_MCP_MAX_CONCURRENCY');
      assert.equal(h.gauge.peak, 8);
    }, { funnel: 8 });
  });

  it('an UNSET funnel knob resolves to the funnel default, not a second default (#892)', async () => {
    // The funnel does not treat an unset knob as absent — it resolves it to
    // DEFAULT_MAX_CONCURRENCY. A resolver that fell through to its OWN default
    // (4) whenever the variable was unset reported a fan-out of 4 while the
    // funnel permitted 3, in the fully unconfigured default case. The reported
    // number has to be the one that can actually occur.
    await withFanout(undefined, async () => {
      const h = showRadarHarness({ shows: 6 });
      const out = await h.invoke();
      const p = out.structuredContent as { fanout_concurrency: number; fanout_concurrency_source: string };
      assert.equal(p.fanout_concurrency, DEFAULT_MAX_CONCURRENCY);
      // Nothing was set, so nothing may be reported as the source.
      assert.equal(p.fanout_concurrency_source, 'default');
      assert.equal(h.gauge.peak, DEFAULT_MAX_CONCURRENCY);
    });
  });

  it('an over-ceiling funnel width is clamped before it is reported (#892)', async () => {
    // SPOTIFY_MCP_MAX_CONCURRENCY=5000 is clamped to MAX_CONCURRENCY_CEILING
    // for the funnel. Read raw, the resolver reported 5000 — a width 156x
    // larger than any request could reach, under a field named
    // fanout_concurrency. The clamp has to apply to the reported number too.
    await withFanout(undefined, async () => {
      const h = showRadarHarness({ shows: 6 });
      const out = await h.invoke();
      const p = out.structuredContent as { fanout_concurrency: number; fanout_concurrency_source: string };
      assert.equal(p.fanout_concurrency, MAX_CONCURRENCY_CEILING);
      assert.equal(p.fanout_concurrency_source, 'SPOTIFY_MCP_MAX_CONCURRENCY');
      // The scan cannot peak above the shows it has, so the observable
      // consequence is that all 6 went out together rather than throttled to
      // some smaller number — the unreachability of 5000 is the assertion.
      assert.equal(h.gauge.peak, 6);
      assert.equal(p.shows_scanned, 6);
    }, { funnel: 5000 });
  });

  it('a 429 on the second show stops scheduling and keeps the rows already read', async () => {
    // 6 shows at an EXPLICIT width of 4 (pinned rather than inherited from the
    // funnel default, which is 3 — the scheduling arithmetic below is stated
    // in terms of 4): s0..s3 are issued together, s1 hits the wall, and s4/s5
    // must never be requested at all.
    await withFanout(4, async () => {
    const h = showRadarHarness({ shows: 6, quotaOn: 's1' });
    const out = await h.invoke();
    const p = out.structuredContent as {
      quota_hit: boolean;
      retry_after: number;
      shows_scanned: number;
      shows_scan_issued: number;
      shows_not_issued: number;
      effective_cap: number;
      new_episodes: number;
    };

    assert.equal(p.quota_hit, true);
    assert.equal(p.retry_after, 5);

    // No retry, and no more scheduling: s4 and s5 were never asked for.
    assert.equal(h.gauge.started.length, 4);
    assert.deepEqual([...h.gauge.started].sort(), ['s0', 's1', 's2', 's3']);
    assert.equal(h.gauge.peak, 4);

    // The siblings already in flight landed and are still reported — those
    // requests were spent, and dropping their answers would lose real rows.
    assert.equal(p.shows_scanned, 3);
    assert.equal(p.new_episodes, 3);
    assert.equal(p.shows_scan_issued, 4);
    assert.equal(p.shows_not_issued, 2);
    // The count is bounded by the shows in scope, not by the cap: this library
    // holds 6, so a cap of 25 must not report 21 shows as never asked about.
    assert.equal(p.effective_cap, 25);
    assert.ok(p.effective_cap > 6, 'the cap is wider than this library, on purpose');

    // And the payload says so in prose rather than presenting a short list as
    // a complete scan.
    assert.match(out.content[0].text, /Quota exceeded mid-scan/);
    assert.match(out.content[0].text, /2 of the 6 shows in scope were never sent/);
    });
  });
});

// ---------------------------------------------------------------------------
// check_artist_releases / artist_release_digest
// ---------------------------------------------------------------------------

function artistHarness(opts: { artists: number; rateLimitOn?: string }) {
  const { server, registered } = fakeServer();
  const gauge = new InFlight();
  const id = (i: number) => `art${i}`;

  const client = {
    get: async (path: string) => {
      const m = /^\/artists\/([^/]+)\/albums$/.exec(path);
      if (!m) return null;
      const artistId = decodeURIComponent(m[1] as string);
      if (opts.rateLimitOn && artistId === opts.rateLimitOn) {
        await gauge.run(artistId, () => {
          throw Object.assign(new Error('rate limited'), { status: 429, retryAfterSec: 3 });
        }, 1);
      }
      return gauge.run(artistId, () => ({
        // One album per artist, named so the rendered order is observable.
        items: [{
          id: `${artistId}-al`,
          name: `Album ${artistId}`,
          uri: `spotify:album:${artistId}-al`,
          album_type: 'album',
          release_date: recent,
          total_tracks: 1,
          artists: [{ id: artistId, name: `Artist ${artistId}` }],
        }],
        total: 1,
      }));
    },
    put: async () => undefined,
    post: async () => null,
    delete: async () => undefined,
    getAllPages: async () => [],
  };

  registerArtistWatchTools(server, client as unknown as SpotifyClient);
  return {
    gauge,
    registered,
    ids: Array.from({ length: opts.artists }, (_, i) => id(i)),
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const tool = pick(registered, name);
      return tool.handler(tool.validate(args)) as Promise<ToolResult>;
    },
  };
}

describe('check_artist_releases fan-out (#783)', () => {
  it('overlaps the artist lookups without exceeding the width, and keeps watchlist order', async () => {
    await withTmpDir(async () => {
      const h = artistHarness({ artists: 6 });
      await h.call('watch_artists', { artist_ids: h.ids });
      const out = await h.call('check_artist_releases', {});
      const p = out.structuredContent as {
        fanout_concurrency: number;
        artists_scanned: number;
        artists_read: number;
        total: number;
        items: Array<{ artist_id: string; album: { name: string } }>;
      };

      assert.equal(h.gauge.peak, DEFAULT_MAX_CONCURRENCY);
      assert.ok(h.gauge.peak > 1, `expected overlap, peak was ${h.gauge.peak}`);
      assert.equal(p.fanout_concurrency, DEFAULT_MAX_CONCURRENCY);
      assert.equal(p.artists_scanned, 6);
      assert.equal(p.artists_read, 6);
      assert.equal(p.total, 6);
      // Order is the watchlist's, not the order the responses landed in.
      assert.deepEqual(p.items.map((i) => i.artist_id), h.ids);
    });
  });

  it('a burst 429 stops scheduling and reports what was never attempted', async () => {
    await withTmpDir(async () => {
    // Explicit width 4: the expectations below (4 issued, 3 read, 4 never
    // attempted) are arithmetic in terms of 4, so it is pinned here rather
    // than inherited from the funnel's default of 3 (#892).
    await withFanout(4, async () => {
      const h = artistHarness({ artists: 8, rateLimitOn: 'art1' });
      await h.call('watch_artists', { artist_ids: h.ids });
      const out = await h.call('check_artist_releases', {});
      const p = out.structuredContent as {
        rate_limited: boolean;
        retry_after: number;
        artists_scanned: number;
        artists_read: number;
        artists_not_attempted: number;
        effective_cap: number;
        watchlist_size: number;
        failures: unknown[];
        items: Array<{ artist_id: string }>;
      };

      assert.equal(p.rate_limited, true);
      assert.equal(p.retry_after, 3);
      // A burst limit is still not this artist's fault: no failure rows.
      assert.deepEqual(p.failures, []);
      // Only the first window went out; nothing was retried and nothing
      // past the window was sent.
      assert.deepEqual([...h.gauge.started].sort(), ['art0', 'art1', 'art2', 'art3']);
      assert.equal(p.artists_scanned, 4);
      assert.equal(p.artists_read, 3);
      assert.equal(p.artists_not_attempted, 4);
      // Bounded by the 8 artists the watchlist actually holds, not by the
      // cap (freshnessBudget = 25 by default), which would claim 21.
      assert.equal(p.effective_cap, 25);
      assert.equal(p.watchlist_size, 8);
      assert.deepEqual(p.items.map((i) => i.artist_id), ['art0', 'art2', 'art3']);
    });
    });
  });

  it('a stale id is a named failure, not a reason to stop the scan (#772)', async () => {
    await withTmpDir(async () => {
      const { server, registered } = fakeServer();
      const gauge = new InFlight();
      const client = {
        get: async (path: string) => {
          const m = /^\/artists\/([^/]+)\/albums$/.exec(path);
          if (!m) return null;
          const artistId = decodeURIComponent(m[1] as string);
          if (artistId === 'stale') {
            await gauge.run(artistId, () => {
              throw Object.assign(new Error('non-existing id'), { status: 404, reason: 'NOT_FOUND' });
            }, 1);
          }
          return gauge.run(artistId, () => ({
            items: [{ id: `${artistId}-al`, name: `Album ${artistId}`, uri: `spotify:album:${artistId}-al`, album_type: 'album', release_date: recent, total_tracks: 1, artists: [] }],
            total: 1,
          }));
        },
        put: async () => undefined,
        post: async () => null,
        delete: async () => undefined,
        getAllPages: async () => [],
      };
      registerArtistWatchTools(server, client as unknown as SpotifyClient);
      const call = async (name: string, args: Record<string, unknown> = {}) =>
        pick(registered, name).handler(pick(registered, name).validate(args)) as Promise<ToolResult>;

      const ids = ['a1', 'stale', 'a2', 'a3', 'a4'];
      await call('watch_artists', { artist_ids: ids });
      const out = await call('check_artist_releases', {});
      const p = out.structuredContent as {
        artists_failed: number;
        failures: Array<{ artist_id: string }>;
        artists_scanned: number;
        total: number;
        items: Array<{ artist_id: string }>;
      };

      // The 404 is recorded and the scan carried on past it.
      assert.equal(p.artists_failed, 1);
      assert.deepEqual(p.failures.map((f) => f.artist_id), ['stale']);
      assert.equal(p.artists_scanned, 5);
      assert.equal(p.total, 4);
      assert.deepEqual(p.items.map((i) => i.artist_id), ['a1', 'a2', 'a3', 'a4']);
    });
  });

  it('artist_release_digest overlaps too and advances `seen` for every artist read', async () => {
    await withTmpDir(async () => {
      const h = artistHarness({ artists: 6 });
      await h.call('watch_artists', { artist_ids: h.ids });
      const out = await h.call('artist_release_digest', {});
      const p = out.structuredContent as {
        fanout_concurrency: number;
        artists_scanned: number;
        artists_read: number;
        total: number;
        items: Array<{ artist_id: string }>;
      };
      assert.equal(h.gauge.peak, DEFAULT_MAX_CONCURRENCY);
      assert.equal(p.artists_scanned, 6);
      assert.equal(p.artists_read, 6);
      assert.equal(p.total, 6);
      assert.deepEqual(p.items.map((d) => d.artist_id), h.ids);

      const second = await h.call('artist_release_digest', {});
      // artist_release_digest deliberately does not advance `seen` (it is a
      // read; check_artist_releases is the one that persists), so there is no
      // second-run assertion here. What this guards is the thing a fan-out
      // could plausibly break: no artist's rows dropped on the way out.
    });
  });
});

// ---------------------------------------------------------------------------
// search_deep
// ---------------------------------------------------------------------------

describe('search_deep fan-out (#783)', () => {
  // search_deep feeds the shared search_history sidecar (#766). Point it at a
  // file this suite owns — left alone it would write the developer's real
  // ~/.spotify-mcp/search-history.json, and the suites that assert on the
  // "no history yet" case would then read our rows.
  let historyDir = '';
  let prevHistoryFile: string | undefined;
  let prevHistory: string | undefined;

  beforeEach(async () => {
    historyDir = await mkdtemp(join(tmpdir(), 'fanout-sh-'));
    prevHistoryFile = process.env.SPOTIFY_MCP_SEARCH_HISTORY_FILE;
    prevHistory = process.env.SPOTIFY_MCP_SEARCH_HISTORY;
    process.env.SPOTIFY_MCP_SEARCH_HISTORY_FILE = join(historyDir, 'search-history.json');
    process.env.SPOTIFY_MCP_SEARCH_HISTORY = '0';
  });

  afterEach(async () => {
    if (prevHistoryFile === undefined) delete process.env.SPOTIFY_MCP_SEARCH_HISTORY_FILE;
    else process.env.SPOTIFY_MCP_SEARCH_HISTORY_FILE = prevHistoryFile;
    if (prevHistory === undefined) delete process.env.SPOTIFY_MCP_SEARCH_HISTORY;
    else process.env.SPOTIFY_MCP_SEARCH_HISTORY = prevHistory;
    await rm(historyDir, { recursive: true, force: true });
  });

  function searchHarness(types: string[]) {
    const { server, registered } = fakeServer();
    const gauge = new InFlight();
    const client = {
      get: async (path: string, params?: Record<string, string>) => {
        assert.equal(path, '/search');
        const type = params?.type as string;
        return gauge.run(type, () => ({
          [`${type}s`]: { items: [{ id: `${type}-1`, name: `Row ${type}`, uri: `spotify:${type}:${type}-1` }], total: 1 },
        }));
      },
      getAllPages: async () => [],
    };
    registerSearchDeepTool(server, client as unknown as SpotifyClient);
    const tool = pick(registered, 'search_deep');
    return {
      gauge,
      invoke: (args: Record<string, unknown> = {}) => tool.handler(tool.validate({ query: 'q', types, ...args })),
    };
  }

  it('overlaps the per-type walks under the width bound and keeps the requested section order', async () => {
    const types = ['track', 'album', 'artist', 'playlist', 'show', 'episode'];
    const h = searchHarness(types);
    const out = await h.invoke({ pages: 2, response_format: 'json' });
    const p = out.structuredContent as Record<string, unknown>;

    assert.equal(h.gauge.peak, DEFAULT_MAX_CONCURRENCY);
    assert.ok(h.gauge.peak > 1, `expected overlap, peak was ${h.gauge.peak}`);
    assert.equal(p.fanout_concurrency, DEFAULT_MAX_CONCURRENCY);
    // Section order is the caller's `types` order, whatever the settle order:
    // the disclosure keys lead, then the sections in request order.
    assert.deepEqual(Object.keys(p), [
      'fanout_concurrency',
      'fanout_concurrency_source',
      ...types.map((t) => `${t}s`),
    ]);
    // The JSON text and structuredContent are the same object — a caller that
    // diffs the two must not find fields that exist in only one.
    assert.deepEqual(JSON.parse(out.content[0].text) as unknown, p);
  });

  it('a type walk that fails propagates instead of reporting a half-walked type', async () => {
    const { server, registered } = fakeServer();
    const client = {
      get: async (path: string, params?: Record<string, string>) => {
        if (params?.type === 'album') throw new Error('search exploded');
        return { [`${params?.type}s`]: { items: [{ id: 'x', name: 'X', uri: 'u' }], total: 1 } };
      },
      getAllPages: async () => [],
    };
    registerSearchDeepTool(server, client as unknown as SpotifyClient);
    const tool = pick(registered, 'search_deep');
    await assert.rejects(
      () => tool.handler(tool.validate({ query: 'q', types: ['track', 'album'] })),
      /search exploded/,
    );
  });
});
