import { describe, it } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import type { SpotifyPaged } from '../src/types/spotify.js';
import { registerLibraryAnalyticsTools } from '../src/tools/libraryanalytics.js';

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
    const { SpotifyApiError } = await import('../src/client.js');
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
