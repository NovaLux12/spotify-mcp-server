import { describe, it } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { SpotifyApiError } from '../src/client.js';
import { registerLibraryAnalyticsTools } from '../src/tools/libraryanalytics.js';
import { initConfig, getConfig } from '../src/config.js';

interface RegisteredTool {
  name: string; validate: (a: Record<string, unknown>) => Record<string, unknown>;
  handler: (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; structuredContent?: Record<string, unknown> }>;
}
type Responder = (path: string, params?: Record<string, string>) => unknown;

function makeStubClient(responder: Responder) {
  const calls: Array<{ path: string; params?: Record<string, string> }> = [];
  const client = {
    calls,
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      calls.push({ path, params });
      return responder(path, params) as T | null;
    },
    async getAllPages<T>(path: string, params?: Record<string, string>, opts?: { maxItems?: number }): Promise<T[]> {
      const maxItems = opts?.maxItems ?? 500;
      const all: T[] = [];
      let offset = Number(params?.offset ?? 0);
      for (;;) {
        const pageParams = { ...params, offset: String(offset) };
        const page = await this.get<SpotifyPaged<T>>(path, pageParams);
        if (!page || !Array.isArray(page.items)) break;
        all.push(...page.items);
        if (all.length >= maxItems) return all.slice(0, maxItems);
        const limit = typeof page.limit === 'number' && page.limit > 0 ? page.limit : page.items.length;
        offset += limit;
        if (page.items.length === 0 || page.items.length < limit) break;
        if (typeof page.total === 'number' && offset >= page.total) break;
      }
      return all;
    },
  };
  return client;
}

function harness(responder: Responder) {
  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(name: string, _desc: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
      registered.push({ name, validate: (a) => z.object(schema).parse(a), handler });
    },
  } as unknown as McpServer;
  const client = makeStubClient(responder);
  registerLibraryAnalyticsTools(fakeServer, client as unknown as SpotifyClient);
  return {
    registered, client,
    invoke: async (name: string, args: Record<string, unknown>) => {
      const t = registered.find((x) => x.name === name)!;
      assert.ok(t, `tool ${name} registered`);
      return t.handler(t.validate(args));
    },
  };
}
const textOf = (o: { content: Array<{ text: string }> }) => o.content[0].text;

function pagedResponder(fixtures: Record<string, unknown[]>, perPage = 50): Responder {
  return (path, params) => {
    const items = fixtures[path] ?? [];
    // for paged wrappers like /me/tracks etc, return paged object
    // For recently-played, handle specially if fixtures contains that key as object
    if (path === '/me/player/recently-played' && !Array.isArray((fixtures as Record<string, unknown>)[path])) {
      // if fixture is Already shaped response
    }
    const offset = Number(params?.offset ?? 0);
    const limit = perPage;
    const slice = items.slice(offset, offset + limit);
    return { items: slice, total: items.length, limit, offset, next: offset + limit < items.length ? 'next' : null, cursors: null };
  };
}

const trackItem = (id: string, added_at = '2026-06-15T12:00:00Z', genres: string[] = []) => ({
  added_at,
  track: { id, name: `Track ${id}`, uri: `spotify:track:${id}`, artists: [{ name: `Artist ${id}`, genres }] },
});
const albumItem = (id: string, added_at = '2026-06-15T12:00:00Z') => ({
  added_at, album: { id, name: `Album ${id}`, uri: `spotify:album:${id}`, artists: [{ name: `Artist ${id}` }] },
});

describe('registration', () => {
  it('registers four tools', () => {
    const h = harness(() => ({ items: [], total: 0, limit: 50, offset: 0, next: null }));
    assert.deepEqual(h.registered.map((r) => r.name).sort(), ['genre_trends_over_time', 'library_coverage_report', 'library_growth_report', 'listening_heatmap']);
  });
});

describe('library_coverage_report', () => {
  it('empty library: coverage 0, no orphans', async () => {
    const h = harness(pagedResponder({ '/me/tracks': [], '/me/playlists': [] }));
    const out = await h.invoke('library_coverage_report', {});
    assert.equal(out.structuredContent?.total_saved, 0);
    assert.equal(out.structuredContent?.coverage_ratio, 0);
    assert.deepEqual(out.structuredContent?.items, []);
  });

  it('orphan detection: saved not in playlist', async () => {
    const h = harness((path, params) => {
      if (path === '/me/tracks') return pagedResponder({ '/me/tracks': [trackItem('t1'), trackItem('t2')] })(path, params);
      if (path === '/me/playlists') return { items: [{ id: 'pl1', name: 'P1', owner: { display_name: 'me', id: 'me' } }], total: 1, limit: 50, offset: 0, next: null };
      if (path.startsWith('/playlists/')) {
        // pl1 contains t1 only
        return { items: [{ track: { id: 't1', name: 'Track t1', uri: 'spotify:track:t1' } }], total: 1, limit: 100, offset: 0, next: null };
      }
      return { items: [], total: 0, limit: 50, offset: 0, next: null };
    });
    const out = await h.invoke('library_coverage_report', {});
    assert.equal(out.structuredContent?.orphan_count, 1);
    assert.equal((out.structuredContent?.items as unknown[]).length, 1);
    assert.equal(out.structuredContent?.coverage_ratio, 0.5);
    const unsaved = out.structuredContent?.unsaved_playlist_items as unknown[];
    assert.equal(unsaved.length, 0);
  });

  it('unsaved playlist items detected', async () => {
    const h = harness((path, params) => {
      if (path === '/me/tracks') return pagedResponder({ '/me/tracks': [trackItem('t1')] })(path, params);
      if (path === '/me/playlists') return { items: [{ id: 'pl1', name: 'P1', owner: { display_name: 'me', id: 'me' } }], total: 1, limit: 50, offset: 0, next: null };
      if (path.startsWith('/playlists/')) {
        return { items: [{ track: { id: 't1', uri: 'spotify:track:t1' } }, { track: { id: 't9', uri: 'spotify:track:t9' } }], total: 2, limit: 100, offset: 0, next: null };
      }
      return { items: [], total: 0, limit: 50, offset: 0, next: null };
    });
    const out = await h.invoke('library_coverage_report', { include_not_saved: true });
    assert.equal(out.structuredContent?.total_unsaved, 1);
  });

  it('respects max_results truncation', async () => {
    const tracks = [trackItem('t1'), trackItem('t2'), trackItem('t3')];
    const h = harness((path, params) => {
      if (path === '/me/tracks') return pagedResponder({ '/me/tracks': tracks })(path, params);
      if (path === '/me/playlists') return { items: [], total: 0, limit: 50, offset: 0, next: null };
      return { items: [], total: 0, limit: 50, offset: 0, next: null };
    });
    const out = await h.invoke('library_coverage_report', { max_results: 1 });
    const sc = out.structuredContent as { items: unknown[]; pagination: { total: number; next_offset: number | null } };
    assert.equal(sc.items.length, 1);
    assert.equal(sc.pagination.total, 3);
    assert.match(textOf(out), /more/);
  });

  it('json mode returns parseable payload', async () => {
    const h = harness(pagedResponder({ '/me/tracks': [], '/me/playlists': [] }));
    const out = await h.invoke('library_coverage_report', { response_format: 'json' });
    const parsed = JSON.parse(textOf(out));
    assert.deepEqual(parsed, out.structuredContent);
  });
});

describe('listening_heatmap', () => {
  it('buckets recently-played by hour×day (168 slots)', async () => {
    const now = new Date();
    const iso = now.toISOString();
    const h = harness((path) => {
      if (path === '/me/player/recently-played') {
        return { items: [{ played_at: iso, track: { name: 'T', uri: 'spotify:track:t1' } }], cursors: null, next: null };
      }
      return { items: [], total: 0, limit: 50, offset: 0, next: null };
    });
    const out = await h.invoke('listening_heatmap', {});
    const buckets = out.structuredContent?.buckets as Array<{ count: number }>;
    assert.equal(buckets.length, 168);
    const total = (buckets as Array<{ count: number }>).reduce((a, b) => a + b.count, 0);
    assert.equal(total, 1);
    assert.equal(out.structuredContent?.total_plays, 1);
  });

  it('empty history handled', async () => {
    const h = harness(() => ({ items: [], cursors: null, next: null }));
    const out = await h.invoke('listening_heatmap', {});
    assert.match(textOf(out), /No recently-played/);
    assert.equal(out.structuredContent?.total_plays, 0);
  });
});

describe('listening_heatmap time frame and disclosure (#740)', () => {
  it('buckets the same played_at identically under any host TZ (default frame is UTC)', async () => {
    // One play an hour ago, so it is inside the lookback window whatever the clock.
    const playedAt = new Date(Date.now() - 3600_000).toISOString();
    const responder = (path: string) => {
      if (path === '/me/player/recently-played') {
        return { items: [{ played_at: playedAt, track: { name: 'T', uri: 'spotify:track:t1' } }], cursors: null, next: null };
      }
      return { items: [], total: 0, limit: 50, offset: 0, next: null };
    };

    // The same fixture under four host time zones must produce identical
    // payloads: the default frame is UTC, never the host's (the #824 contract).
    const originalTz = process.env.TZ;
    const payloads: string[] = [];
    try {
      for (const tz of ['UTC', 'Pacific/Kiritimati', 'America/Los_Angeles', 'Asia/Tokyo']) {
        process.env.TZ = tz;
        const h = harness(responder);
        const out = await h.invoke('listening_heatmap', {});
        payloads.push(JSON.stringify(out.structuredContent?.buckets));
        assert.equal(out.structuredContent?.timezone, 'UTC', `default frame must be UTC under TZ=${tz}`);
      }
    } finally {
      if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz;
    }
    assert.equal(new Set(payloads).size, 1, 'buckets must not depend on the host time zone');
  });

  it('discloses a truncated walk instead of claiming the whole lookback window', async () => {
    // 400 plays, 50 per page, so 8 pages exist and the budget must bind.
    const plays = Array.from({ length: 400 }, (_, i) => ({
      played_at: new Date(Date.now() - i * 60_000).toISOString(),
      track: { name: `T${i}`, uri: `spotify:track:t${i}` },
    }));
    const h = harness((path, params) => {
      if (path === '/me/player/recently-played') {
        const after = Number(params?.after ?? 0);
        const slice = plays.slice(after, after + 50);
        const next = after + 50;
        return { items: slice, cursors: { after: String(next) }, next: next < plays.length ? 'n' : null };
      }
      return { items: [], total: 0, limit: 50, offset: 0, next: null };
    });
    // lookback 4 => page budget 2, with 8 pages of real history behind it.
    const out = await h.invoke('listening_heatmap', { lookback_days: 4, limit: 50 });
    assert.equal(out.structuredContent?.truncated, true);
    assert.equal(out.structuredContent?.pages_walked, 2);
    assert.ok(out.structuredContent?.window_covered_from, 'oldest play seen must be reported');
    assert.ok(out.structuredContent?.total_plays as number > 0);
    const prose = textOf(out);
    assert.match(prose, /NOT fully covered/);
    assert.doesNotMatch(prose, /plays covering the 4-day lookback window/);
  });

  it('names the least busy slots by real play count, not the first idle hours', async () => {
    // Activity only Mon-Fri 09:00, with different counts per day. Anchored to
    // the most recent Monday so the plays are always inside the lookback window.
    const now = new Date();
    const monday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - ((now.getUTCDay() + 6) % 7) * 86_400_000;
    const day = 86_400_000;
    // [Mon, Tue, Wed, Thu, Fri] play counts.
    const plays = [3, 1, 2, 1, 4].flatMap((n, i) =>
      Array.from({ length: n }, (_, k) => ({
        played_at: new Date(monday + i * day + 9 * 3_600_000 + k * 60_000).toISOString(),
        track: { name: 'T', uri: 'spotify:track:t1' },
      })),
    );
    const h = harness((path) => {
      if (path === '/me/player/recently-played') return { items: plays, cursors: null, next: null };
      return { items: [], total: 0, limit: 50, offset: 0, next: null };
    });
    const out = await h.invoke('listening_heatmap', { lookback_days: 7, limit: 50, timezone: 'UTC' });
    const quiet = out.structuredContent?.quiet_slots as Array<{ day: number; hour: number; count: number }>;
    assert.ok(quiet.length > 0, 'least-busy slots must be reported');
    // Counts ascend, and the true minimum (Tue=1, Wed=1) leads.
    assert.deepEqual(quiet.map((q) => q.count), [...quiet.map((q) => q.count)].sort((a, b) => a - b));
    assert.equal(quiet[0].count, 1);
    assert.equal(quiet[0].hour, 9);
    // Every reported slot actually has plays — never an unmeasured idle hour.
    for (const q of quiet) assert.ok(q.count > 0, 'quiet slots must exclude unmeasured zero-count hours');
    const prose = textOf(out);
    assert.match(prose, /Least busy slots \(non-zero\)/);
    assert.doesNotMatch(prose, /Sun 00:00/);
  });

  it('honours an explicit timezone argument: the same instant lands in a different bucket', async () => {
    const playedAt = new Date(Date.now() - 3600_000).toISOString();
    const responder = (path: string) => {
      if (path === '/me/player/recently-played') {
        return { items: [{ played_at: playedAt, track: { name: 'T', uri: 'spotify:track:t1' } }], cursors: null, next: null };
      }
      return { items: [], total: 0, limit: 50, offset: 0, next: null };
    };
    const slotOf = (buckets: Array<{ day: number; hour: number; count: number }>) =>
      buckets.findIndex((b) => b.count > 0);

    const utc = await harness(responder).invoke('listening_heatmap', { timezone: 'UTC' });
    const tokyo = await harness(responder).invoke('listening_heatmap', { timezone: 'Asia/Tokyo' });

    assert.equal(utc.structuredContent?.timezone, 'UTC');
    assert.equal(tokyo.structuredContent?.timezone, 'Asia/Tokyo');
    const uBuckets = utc.structuredContent?.buckets as Array<{ day: number; hour: number; count: number }>;
    const tBuckets = tokyo.structuredContent?.buckets as Array<{ day: number; hour: number; count: number }>;
    assert.equal(uBuckets[slotOf(uBuckets)].count, 1);
    assert.equal(tBuckets[slotOf(tBuckets)].count, 1);
    // Tokyo is UTC+9, so an hour boundary must move the slot.
    const uSlot = uBuckets[slotOf(uBuckets)];
    const tSlot = tBuckets[slotOf(tBuckets)];
    assert.notDeepEqual([tSlot.day, tSlot.hour], [uSlot.day, uSlot.hour],
      'Asia/Tokyo must re-frame the same instant into a different day/hour slot');
    assert.match(textOf(tokyo), /Time zone: Asia\/Tokyo/);
  });
});

describe('library_growth_report', () => {
  it('buckets counts per period with deltas', async () => {
    // use current month so it falls in lookback
    const now = new Date();
    const iso = now.toISOString();
    const older = new Date(now); older.setUTCMonth(now.getUTCMonth() - 1);
    const h = harness((path, params) => {
      if (path === '/me/tracks') return pagedResponder({ '/me/tracks': [trackItem('t1', iso), trackItem('t2', iso), trackItem('t3', older.toISOString())] })(path, params);
      if (path === '/me/albums') return pagedResponder({ '/me/albums': [albumItem('a1', iso)] })(path, params);
      if (path === '/me/shows' || path === '/me/episodes') return { items: [], total: 0, limit: 50, offset: 0, next: null };
      return { items: [], total: 0, limit: 50, offset: 0, next: null };
    });
    const out = await h.invoke('library_growth_report', { period: 'monthly', lookback: 2 });
    const buckets = out.structuredContent?.buckets as Array<{ total: number }>;
    assert.equal(buckets.length, 2);
    // last bucket should have 3 (2 tracks +1 album), previous 1
    assert.equal(buckets[1].total, 3);
    assert.equal(buckets[0].total, 1);
    const deltas = out.structuredContent?.deltas as number[];
    assert.equal(deltas[1], 2);
  });

  it('json mode parseable', async () => {
    const h = harness((path, params) => {
      if (path === '/me/tracks' || path === '/me/albums') return pagedResponder({ [path]: [] })(path, params);
      return { items: [], total: 0, limit: 50, offset: 0, next: null };
    });
    const out = await h.invoke('library_growth_report', { response_format: 'json', period: 'yearly', lookback: 2 });
    assert.deepEqual(JSON.parse(textOf(out)), out.structuredContent);
  });
});

describe('genre_trends_over_time', () => {
  it('tracks genre counts per period with emerging/declining', async () => {
    const now = new Date();
    const curIso = now.toISOString();
    const prev = new Date(now); prev.setUTCMonth(now.getUTCMonth() - 1);
    const prevIso = prev.toISOString();
    const h = harness((path, params) => {
      if (path === '/me/tracks') {
        return pagedResponder({
          '/me/tracks': [
            trackItem('t1', prevIso, ['pop']),
            trackItem('t2', curIso, ['pop', 'indie']),
            trackItem('t3', curIso, ['indie']),
          ],
        })(path, params);
      }
      return { items: [], total: 0, limit: 50, offset: 0, next: null };
    });
    const out = await h.invoke('genre_trends_over_time', { period: 'monthly', lookback: 2 });
    const periods = out.structuredContent?.periods as Array<{ period: string; top_genres: Array<{ genre: string; count: number }> }>;
    assert.equal(periods.length, 2);
    // previous period had pop=1, current has pop=1 indie=2
    const declining = out.structuredContent?.declining as unknown[];
    const emerging = out.structuredContent?.emerging as Array<{ genre: string }>;
    assert.ok(emerging.some((e) => e.genre === 'indie'));
  });

  it('empty library yields no-trend message', async () => {
    const h = harness(pagedResponder({ '/me/tracks': [] }));
    const out = await h.invoke('genre_trends_over_time', {});
    assert.match(textOf(out), /No saved tracks/);
  });
  // Every genre count here is derived from one capped walk of /me/tracks, so
  // a walk stopped at fetchAllCap makes `total_saved_tracks` and each bucket
  // count a floor rather than a library size (#741).
  it('discloses a capped tracks walk instead of reporting the floor as the library size', async () => {
    initConfig({ ...process.env, SPOTIFY_MCP_FETCH_ALL_CAP: '3' });
    const iso = new Date().toISOString();
    const build = (count: number) => harness((path, params) => {
      if (path === '/me/tracks') {
        return pagedResponder({
          '/me/tracks': Array.from({ length: count }, (_, i) => trackItem(`t${i}`, iso, ['rock'])),
        })(path, params);
      }
      return { items: [], total: 0, limit: 50, offset: 0, next: null };
    });
    try {
      assert.equal(getConfig().fetchAllCap, 3);

      // 5 saved tracks, so the walk really does stop at 3.
      const capped = await build(5).invoke('genre_trends_over_time', { period: 'monthly', lookback: 2 });
      const c = capped.structuredContent as { truncated: boolean; scan_cap: number; total_saved_tracks: number };
      assert.equal(c.total_saved_tracks, 3, 'the tracks walk really did stop at the cap');
      assert.equal(c.truncated, true, 'a capped tracks walk must not be reported as a complete scan');
      assert.equal(c.scan_cap, 3);
      assert.match(textOf(capped), /walk capped at 3/);
      assert.match(textOf(capped), /lower bound/);

      // Under the cap: no false truncation and no cap note.
      const whole = await build(2).invoke('genre_trends_over_time', { period: 'monthly', lookback: 2 });
      const w = whole.structuredContent as { truncated: boolean; scan_cap: number; total_saved_tracks: number };
      assert.equal(w.total_saved_tracks, 2);
      assert.equal(w.truncated, false, 'a walk under the cap is not truncated');
      assert.equal(w.scan_cap, 3, 'the cap is reported even when it did not bind');
      assert.doesNotMatch(textOf(whole), /walk capped/);
    } finally {
      initConfig();
    }
  });

});

describe('library_coverage_report dry_run + quota', () => {
  it('dry_run returns cost estimate without API calls', async () => {
    let calls = 0;
    const h = harness(() => { calls++; return { items: [], total: 0, limit: 50, offset: 0, next: null }; });
    const out = await h.invoke('library_coverage_report', { dry_run: true, max_playlists: 10, scan_cap: 100 });
    assert.equal(calls, 0, 'dry_run must make zero API calls');
    assert.equal(out.structuredContent?.dry_run, true);
    assert.equal(out.structuredContent?.would_scan_playlists, 10);
    assert.equal(out.structuredContent?.estimated_requests, 2 + 10 * 1);
    assert.match(textOf(out), /dry run/);
  });
  it('dry_run warns when >25 playlists', async () => {
    const h = harness(() => ({ items: [], total: 0, limit: 50, offset: 0, next: null }));
    const out = await h.invoke('library_coverage_report', { dry_run: true, max_playlists: 50 });
    assert.match(textOf(out), /Warning/);
  });
  it('quota partial recovery on per-playlist 429', async () => {
    let playlistCall = 0;
    const h = harness((path) => {
      if (path === '/me/tracks') return { items: [{ track: { id: 't1', name: 'T1', uri: 'spotify:track:t1' } }], total: 1, limit: 50, offset: 0, next: null };
      if (path === '/me/playlists') return { items: [{ id: 'pl1', name: 'P1' }, { id: 'pl2', name: 'P2' }], total: 2, limit: 50, offset: 0, next: null };
      if (path.startsWith('/playlists/')) {
        playlistCall++;
        if (playlistCall === 2) throw new SpotifyApiError(429, 'quota', 60, 'QUOTA_EXCEEDED');
        return { items: [{ track: { id: 't1', uri: 'spotify:track:t1' } }], total: 1, limit: 100, offset: 0, next: null };
      }
      return { items: [], total: 0, limit: 50, offset: 0, next: null };
    });
    const out = await h.invoke('library_coverage_report', { max_playlists: 2 });
    assert.equal(out.structuredContent?.quota_hit, true);
    assert.equal(out.structuredContent?.retry_after, 60);
    assert.match(textOf(out), /Quota hit/);
  });
});

describe('library_coverage_report unreadable playlists (#739) and scan envelope (#738)', () => {
  it('records a 403 playlist as unreadable instead of empty, and marks coverage incomplete', async () => {
    const h = harness((path) => {
      if (path === '/me/tracks') {
        return { items: [{ track: { id: 't1', name: 'T1', uri: 'spotify:track:t1' } }], total: 1, limit: 50, offset: 0, next: null };
      }
      if (path === '/me/playlists') {
        return { items: [{ id: 'pl1', name: 'Readable' }, { id: 'pl2', name: 'Collaborative' }], total: 2, limit: 50, offset: 0, next: null };
      }
      if (path.includes('pl2')) throw new SpotifyApiError(403, 'Forbidden', undefined, 'FORBIDDEN');
      if (path.startsWith('/playlists/')) {
        return { items: [], total: 0, limit: 100, offset: 0, next: null };
      }
      return { items: [], total: 0, limit: 50, offset: 0, next: null };
    });
    const out = await h.invoke('library_coverage_report', { max_playlists: 2 });
    const unreadable = out.structuredContent?.unreadable_playlists as Array<{ playlist_id: string; error: string }>;
    assert.equal(unreadable.length, 1);
    assert.equal(unreadable[0].playlist_id, 'pl2');
    assert.match(unreadable[0].error, /Forbidden/);
    assert.equal(out.structuredContent?.coverage_complete, false);
    assert.equal(out.structuredContent?.coverage_ratio_is_lower_bound, true);
    const prose = textOf(out);
    assert.match(prose, /could not be read/);
    assert.match(prose, /lower bound/);
    // The orphan list is not presented as fact when a playlist was unread.
    assert.match(prose, /NOT a full orphan list/);
    assert.doesNotMatch(prose, /Orphan saved tracks \(not in any playlist\)/);
  });

  it('reports coverage_complete true when every playlist was read (non-vacuous)', async () => {
    const h = harness((path) => {
      if (path === '/me/tracks') {
        return { items: [{ track: { id: 't1', name: 'T1', uri: 'spotify:track:t1' } }], total: 1, limit: 50, offset: 0, next: null };
      }
      if (path === '/me/playlists') return { items: [{ id: 'pl1', name: 'P1' }], total: 1, limit: 50, offset: 0, next: null };
      if (path.startsWith('/playlists/')) {
        return { items: [{ track: { id: 't1', name: 'T1', uri: 'spotify:track:t1' } }], total: 1, limit: 100, offset: 0, next: null };
      }
      return { items: [], total: 0, limit: 50, offset: 0, next: null };
    });
    const out = await h.invoke('library_coverage_report', { max_playlists: 5 });
    assert.equal(out.structuredContent?.coverage_complete, true);
    assert.equal(out.structuredContent?.coverage_ratio_is_lower_bound, false);
    assert.deepEqual(out.structuredContent?.unreadable_playlists, []);
    assert.equal(out.structuredContent?.orphan_count, 0);
    assert.match(textOf(out), /Orphan saved tracks \(not in any playlist\)/);
  });

  it('scans playlists via /items only, never the legacy /tracks path (#738)', async () => {
    const h = harness((path) => {
      if (path === '/me/tracks') return { items: [], total: 0, limit: 50, offset: 0, next: null };
      if (path === '/me/playlists') {
        return { items: [{ id: 'pl1', name: 'P1' }, { id: 'pl2', name: 'P2' }, { id: 'pl3', name: 'P3' }], total: 3, limit: 50, offset: 0, next: null };
      }
      if (path.startsWith('/playlists/')) {
        return { items: [{ track: { id: 't1', name: 'T1', uri: 'spotify:track:t1' } }], total: 1, limit: 100, offset: 0, next: null };
      }
      return { items: [], total: 0, limit: 50, offset: 0, next: null };
    });
    await h.invoke('library_coverage_report', { max_playlists: 3 });
    const playlistCalls = h.client.calls.filter((c) => c.path.startsWith('/playlists/'));
    assert.equal(playlistCalls.length, 3, 'exactly one request per playlist');
    for (const c of playlistCalls) assert.match(c.path, /\/items$/, 'must target /items, not the legacy /tracks path');
    assert.equal(playlistCalls.filter((c) => c.path.endsWith('/tracks')).length, 0);
  });

  it('discloses playlists skipped by the max_playlists slice (#738)', async () => {
    const playlists = Array.from({ length: 60 }, (_, i) => ({ id: `pl${i}`, name: `P${i}` }));
    const h = harness((path, params) => {
      if (path === '/me/tracks') return { items: [], total: 0, limit: 50, offset: 0, next: null };
      if (path === '/me/playlists') return pagedResponder({ '/me/playlists': playlists })(path, params);
      if (path.startsWith('/playlists/')) return { items: [], total: 0, limit: 100, offset: 0, next: null };
      return { items: [], total: 0, limit: 50, offset: 0, next: null };
    });
    const out = await h.invoke('library_coverage_report', {});
    assert.equal(out.structuredContent?.playlists_available, 60);
    assert.equal(out.structuredContent?.playlists_scanned, 50);
    assert.equal(out.structuredContent?.playlists_skipped, 10);
    assert.equal(out.structuredContent?.coverage_complete, false);
    assert.match(textOf(out), /only the first 50 of 60 playlists were scanned/);
  });
});

describe('library_growth_report scanned vs in-window (#741)', () => {
  it('separates the walk total from additions inside the window', async () => {
    const now = new Date();
    const curIso = now.toISOString();
    const oldIso = new Date(Date.UTC(2020, 0, 15, 12, 0, 0)).toISOString();
    const h = harness((path, params) => {
      if (path === '/me/tracks') {
        return pagedResponder({ '/me/tracks': [trackItem('t1', oldIso), trackItem('t2', curIso)] })(path, params);
      }
      if (path === '/me/albums' || path === '/me/shows' || path === '/me/episodes') {
        return { items: [], total: 0, limit: 50, offset: 0, next: null };
      }
      return { items: [], total: 0, limit: 50, offset: 0, next: null };
    });
    const out = await h.invoke('library_growth_report', { period: 'monthly', lookback: 2 });
    const sc = out.structuredContent as {
      scanned_totals: { total: number }; added_in_window: number; older_than_window: number;
    };
    assert.equal(sc.scanned_totals.total, 2, 'both saves were walked');
    assert.equal(sc.added_in_window, 1, 'only the current-month save is an in-window addition');
    assert.equal(sc.older_than_window, 1, 'the 2020 save is reported as outside the window');
    const prose = textOf(out);
    assert.match(prose, /1 item\(s\) added in the window/);
    assert.match(prose, /Scanned: 2 saved item\(s\) walked/);
    assert.doesNotMatch(prose, /2 item\(s\) total in lookback/);
  });

  it('marks a failed shows walk unavailable rather than reporting zero', async () => {
    const h = harness((path, params) => {
      if (path === '/me/tracks') return pagedResponder({ '/me/tracks': [] })(path, params);
      if (path === '/me/albums') return pagedResponder({ '/me/albums': [] })(path, params);
      if (path === '/me/shows') throw new SpotifyApiError(403, 'Forbidden', undefined, 'FORBIDDEN');
      if (path === '/me/episodes') return { items: [], total: 0, limit: 50, offset: 0, next: null };
      return { items: [], total: 0, limit: 50, offset: 0, next: null };
    });
    const out = await h.invoke('library_growth_report', { period: 'monthly', lookback: 2 });
    const partial = out.structuredContent?.partial as Record<string, string>;
    assert.equal(partial.shows, 'unavailable');
    assert.equal(partial.episodes, undefined);
    assert.equal((out.structuredContent?.scanned_totals as { shows: number }).shows, 0);
    assert.match(textOf(out), /shows unavailable/);
  });

  // A scan total is only honest if the walk that produced it was complete. All
  // four collections are capped at fetchAllCap, so any of them hitting the cap
  // makes "Scanned: N saved item(s) walked" a floor, not a library size (#741).
  it('flags a capped shows or episodes walk as truncated, not just tracks/albums', async () => {
    initConfig({ ...process.env, SPOTIFY_MCP_FETCH_ALL_CAP: '3' });
    const iso = new Date().toISOString();
    const savedShow = (i: number) => ({ added_at: iso, show: { id: `s${i}`, name: `Show ${i}` } });
    const savedEpisode = (i: number) => ({ added_at: iso, episode: { id: `e${i}`, name: `Ep ${i}` } });
    const build = (shows: number, episodes: number) => harness((path, params) => {
      if (path === '/me/shows') return pagedResponder({ '/me/shows': Array.from({ length: shows }, (_, i) => savedShow(i)) })(path, params);
      if (path === '/me/episodes') return pagedResponder({ '/me/episodes': Array.from({ length: episodes }, (_, i) => savedEpisode(i)) })(path, params);
      return pagedResponder({})(path, params);
    });
    try {
      assert.equal(getConfig().fetchAllCap, 3);

      // 5 saved shows, so the walk stops at the cap of 3.
      const capped = await build(5, 0).invoke('library_growth_report', { period: 'monthly', lookback: 2 });
      const c = capped.structuredContent as { truncated: boolean; scan_cap: number; scanned_totals: { shows: number } };
      assert.equal(c.scanned_totals.shows, 3, 'the shows walk really did stop at the cap');
      assert.equal(c.truncated, true, 'a capped shows walk must not be reported as a complete scan');
      assert.equal(c.scan_cap, 3);
      assert.match(textOf(capped), /walk capped at 3/);

      // The episodes walk is capped identically, so it discloses identically.
      const cappedEp = await build(0, 5).invoke('library_growth_report', { period: 'monthly', lookback: 2 });
      assert.equal(cappedEp.structuredContent?.truncated, true, 'a capped episodes walk must not be reported as a complete scan');
      assert.match(textOf(cappedEp), /walk capped at 3/);

      // Nothing at the cap: no false truncation, and no cap note in the prose.
      const whole = await build(2, 1).invoke('library_growth_report', { period: 'monthly', lookback: 2 });
      assert.equal(whole.structuredContent?.truncated, false, 'a walk under the cap is not truncated');
      assert.doesNotMatch(textOf(whole), /walk capped/);
    } finally {
      initConfig();
    }
  });
});

// Each per-playlist item walk is capped at scan_cap just as the /me/tracks and
// /me/playlists walks are. A playlist that reaches the cap was only read to its
// head, so the ids past it are invisible: a saved track past the cap is listed
// as an orphan that does not exist, and unsaved items past it go uncounted.
// That is a partial read, and it must not be reported as a complete one (#741).
describe('library_coverage_report per-playlist walk cap (#741)', () => {
  const playlistItem = (id: string) => ({ track: { id } });
  const build = (playlistItems: Array<{ track: { id: string } }>, savedIds: string[], scanCap: number) =>
    harness((path, params) => {
      if (path === '/me/tracks') return pagedResponder({ '/me/tracks': savedIds.map((id) => trackItem(id)) })(path, params);
      if (path === '/me/playlists') return pagedResponder({ '/me/playlists': [{ id: 'p1', name: 'Big' }] })(path, params);
      if (path === '/playlists/p1/items') return pagedResponder({ '/playlists/p1/items': playlistItems })(path, params);
      return { items: [], total: 0, limit: 50, offset: 0, next: null };
    });

  it('names a playlist whose items hit the cap and downgrades the coverage verdict', async () => {
    // 10-item playlist read at scan_cap=3: the walk sees u0..u2 only.
    const h = build(Array.from({ length: 10 }, (_, i) => playlistItem(`u${i}`)), ['u7'], 3);
    const out = await h.invoke('library_coverage_report', { scan_cap: 3, include_not_saved: true });
    const sc = out.structuredContent as {
      truncated: boolean; scan_cap: number; coverage_complete: boolean;
      coverage_ratio_is_lower_bound: boolean; capped_playlists: Array<{ playlist_id: string; name: string | null }>;
      unsaved_playlist_items: Array<{ unsaved_count: number }>;
    };
    assert.equal(sc.scan_cap, 3);
    assert.equal(sc.unsaved_playlist_items[0].unsaved_count, 3, 'the item walk really did stop at the cap');
    assert.deepEqual(sc.capped_playlists, [{ playlist_id: 'p1', name: 'Big' }]);
    assert.equal(sc.truncated, true, 'a capped playlist walk must not be reported as a complete scan');
    assert.equal(sc.coverage_complete, false, 'a partially read playlist is not a complete coverage scan');
    assert.equal(sc.coverage_ratio_is_lower_bound, true);
    const prose = textOf(out);
    assert.match(prose, /1 playlist\(s\) hit scan_cap=3/);
    assert.match(prose, /Big/);
    // u7 really is saved and really is in the playlist — the cap is the only
    // reason it is listed as an orphan, which is why the verdict must say so.
    assert.match(prose, /NOT a full orphan list/);
  });

  it('reports a playlist read entirely under the cap as complete, with no cap note', async () => {
    const h = build([playlistItem('u0'), playlistItem('u1')], ['u0'], 3);
    const out = await h.invoke('library_coverage_report', { scan_cap: 3, include_not_saved: true });
    const sc = out.structuredContent as {
      truncated: boolean; coverage_complete: boolean; coverage_ratio_is_lower_bound: boolean;
      capped_playlists: unknown[]; unsaved_playlist_items: Array<{ unsaved_count: number }>;
    };
    assert.equal(sc.unsaved_playlist_items[0].unsaved_count, 1);
    assert.deepEqual(sc.capped_playlists, []);
    assert.equal(sc.truncated, false, 'a walk under the cap is not truncated');
    assert.equal(sc.coverage_complete, true, 'every playlist was read in full, so coverage is exact');
    assert.equal(sc.coverage_ratio_is_lower_bound, false);
    assert.doesNotMatch(textOf(out), /hit scan_cap/);
  });
});
