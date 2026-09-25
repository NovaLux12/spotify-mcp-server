/**
 * Tests for show_new_episodes (#173): saved-show radar filtering by
 * release_date window, per_show_limit, saved-episode cross-reference,
 * sorting, and empty-library handling.
 */

import { describe, it } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerShowRadarTools } from '../src/tools/showradar.js';
import { initConfig } from '../src/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function show(id: string, name = id) {
  return { id, name, uri: `spotify:show:${id}`, description: '', publisher: 'P', explicit: false, total_episodes: 10, languages: ['en'], media_type: 'audio' };
}

function ep(id: string, release_date: string, name = id) {
  return {
    id,
    name,
    uri: `spotify:episode:${id}`,
    duration_ms: 1800_000,
    release_date,
    explicit: false,
    description: '',
    show: show('s1'),
  };
}

interface RegisteredTool {
  name: string;
  validate: (a: Record<string, unknown>) => Record<string, unknown>;
  handler: (a: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> }>;
}

function harness(opts: {
  shows?: ReturnType<typeof show>[];
  episodesByShow?: Record<string, ReturnType<typeof ep>[]>;
  savedEpisodeUris?: string[];
} = {}) {
  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(n: string, _d: string, schema: z.ZodRawShape, h: RegisteredTool['handler']) {
      registered.push({ name: n, validate: (a) => z.object(schema).parse(a), handler: h });
    },
  } as unknown as McpServer;

  const shows = opts.shows ?? [];
  const episodesByShow = opts.episodesByShow ?? {};
  const savedUris = new Set(opts.savedEpisodeUris ?? []);

  const client = {
    async getAllPages<T>(path: string, _params?: Record<string, string>, opts?: { maxItems?: number }): Promise<T[]> {
      if (path === '/me/shows') {
        const listed = shows.map((s) => ({ added_at: '2026-01-01T00:00:00Z', show: s }) as unknown as T);
        // Mirror SpotifyClient.getAllPages: a walk that hits maxItems returns
        // exactly maxItems and never says the listing stopped.
        return opts?.maxItems != null && listed.length >= opts.maxItems
          ? listed.slice(0, opts.maxItems)
          : listed;
      }
      if (path === '/me/episodes') {
        return [...savedUris].map((uri) => ({ added_at: '2026-01-02T00:00:00Z', episode: { uri } }) as unknown as T);
      }
      return [];
    },
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      const m = /^\/shows\/([^/]+)\/episodes$/.exec(path);
      if (!m) return null;
      const showId = decodeURIComponent(m[1]);
      const all = episodesByShow[showId] ?? [];
      const limit = Number(params?.limit ?? 20);
      return { items: all.slice(0, limit), total: all.length } as T;
    },
  };

  registerShowRadarTools(fakeServer, client as unknown as SpotifyClient);
  return {
    registered,
    invoke: async (args: Record<string, unknown> = {}) => {
      const tool = registered.find((t) => t.name === 'show_new_episodes');
      assert.ok(tool, 'tool registered');
      return tool.handler(tool.validate(args));
    },
  };
}

const textOf = (out: { content: Array<{ text: string }> }) => out.content[0].text;
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

async function withEnv(env: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, env);
    initConfig(process.env);
    await fn();
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
    Object.assign(process.env, saved);
    initConfig(process.env);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('show_new_episodes', () => {
  it('reports no saved shows', async () => {
    const out = await harness({ shows: [] }).invoke({});
    assert.match(textOf(out), /No saved shows/);
    const p = out.structuredContent as { saved_shows: number; new_episodes: number };
    assert.equal(p.saved_shows, 0);
    assert.equal(p.new_episodes, 0);
  });

  it('filters to episodes within the lookback window', async () => {
    const sA = show('sA', 'Show A');
    const sB = show('sB', 'Show B');
    const h = harness({
      shows: [sA, sB],
      episodesByShow: {
        sA: [ep('e1', today, 'Fresh A'), ep('eOld', daysAgo(30), 'Ancient')],
        sB: [ep('e2', daysAgo(2), 'Fresh B')],
      },
    });
    const out = await h.invoke({ days: 7, per_show_limit: 10 });
    const p = out.structuredContent as { new_episodes: number; episodes: Array<{ episode_id: string }> };
    assert.equal(p.new_episodes, 2);
    // newest first
    assert.equal(p.episodes[0].episode_id, 'e1');
    assert.match(textOf(out), /Found 2 new episode\(s\) across 2 saved show\(s\)/);
    assert.doesNotMatch(textOf(out), /Ancient/);
  });

  it('marks already-saved episodes', async () => {
    const s = show('s1', 'My Show');
    const fresh = ep('fresh', today, 'New One');
    const h = harness({
      shows: [s],
      episodesByShow: { s1: [fresh] },
      savedEpisodeUris: [fresh.uri],
    });
    const out = await h.invoke({ days: 7 });
    assert.match(textOf(out), /\[saved\]/);
    const p = out.structuredContent as { episodes: Array<{ saved: boolean }> };
    assert.equal(p.episodes[0].saved, true);
  });

  it('honours per_show_limit', async () => {
    const s = show('s1');
    const h = harness({
      shows: [s],
      episodesByShow: {
        s1: [ep('e1', today), ep('e2', today), ep('e3', today), ep('e4', today)],
      },
    });
    const out = await h.invoke({ days: 7, per_show_limit: 2 });
    const p = out.structuredContent as { new_episodes: number };
    // only first 2 per show fetched, so at most 2 in window
    assert.equal(p.new_episodes, 2);
  });

  it('reports no new episodes when window is narrow', async () => {
    const s = show('s1');
    const h = harness({
      shows: [s],
      episodesByShow: { s1: [ep('old', daysAgo(20), 'Oldie')] },
    });
    const out = await h.invoke({ days: 1 });
    assert.match(textOf(out), /No new episodes found/);
    const p = out.structuredContent as { new_episodes: number };
    assert.equal(p.new_episodes, 0);
  });

  it('supports json response_format', async () => {
    const s = show('s1', 'S');
    const h = harness({ shows: [s], episodesByShow: { s1: [ep('e1', today)] } });
    const out = await h.invoke({ days: 7, response_format: 'json' });
    const parsed = JSON.parse(textOf(out)) as { new_episodes: number };
    assert.equal(parsed.new_episodes, 1);
  });
});

describe('show_new_episodes cost_preview', () => {
  // #794: show_new_episodes mutates nothing, so it must not carry the shared
  // mutation `dry_run` fragment. `dry_run: true` replaced the requested
  // episode list with a cost estimate, and a defensive agent that set the
  // flag on this read-only tool got a preview where it expected results.
  interface PreviewTool {
    schema: z.ZodRawShape;
    validate: (a: Record<string, unknown>) => Record<string, unknown>;
    handler: (a: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> }>;
  }

  function registerPreviewTool(): { tool: PreviewTool; wasCalled: () => boolean } {
    const registered: Array<{ name: string; tool: PreviewTool }> = [];
    const fakeServer = {
      tool(n: string, _d: string, schema: z.ZodRawShape, h: PreviewTool['handler']) {
        registered.push({ name: n, tool: { schema, validate: (a) => z.object(schema).parse(a), handler: h } });
      },
    } as unknown as McpServer;
    let getCalled = false;
    // client that would fail if called
    const client = {
      async getAllPages() { getCalled = true; return []; },
      async get() { getCalled = true; return null; },
    };
    registerShowRadarTools(fakeServer, client as unknown as SpotifyClient);
    const found = registered.find((t) => t.name === 'show_new_episodes');
    assert.ok(found, 'show_new_episodes registered');
    return { tool: found.tool, wasCalled: () => getCalled };
  }

  it('does not advertise the mutation dry_run parameter', () => {
    const { tool } = registerPreviewTool();
    assert.equal('dry_run' in tool.schema, false, 'dry_run must not be in the schema');
    assert.ok(tool.schema.cost_preview, 'cost_preview is the read-only preview parameter');
  });

  it('dry_run:true no longer swaps the episode list for a preview', async () => {
    // An agent that set dry_run defensively on this read-only tool used to get
    // a cost estimate back. The flag is gone, so the call returns the list.
    const h = harness({ shows: [show('s1')], episodesByShow: { s1: [ep('e1', today, 'Fresh One')] } });
    const out = await h.invoke({ days: 7, dry_run: true });
    const p = out.structuredContent as Record<string, unknown>;
    assert.equal(p.cost_preview, undefined);
    assert.equal(p.cost_estimate, undefined);
    assert.equal(p.new_episodes, 1);
    assert.match(textOf(out), /Found 1 new episode/);
    assert.match(textOf(out), /Fresh One/);
  });

  it('cost_preview returns a cost estimate and no episode list', async () => {
    const { tool, wasCalled } = registerPreviewTool();
    const out = await tool.handler(tool.validate({ cost_preview: true, max_shows: 10 }));
    assert.equal(wasCalled(), false);
    assert.match(textOf(out), /cost preview/i);
    assert.match(textOf(out), /Cost estimate/i);
    assert.doesNotMatch(textOf(out), /dry run/i);
    const p = out.structuredContent as Record<string, unknown>;
    assert.equal(p.cost_preview, true);
    assert.equal(p.dry_run, undefined);
    assert.equal(p.episodes_returned, false);
    assert.equal(p.max_shows, 10);
    assert.ok(p.cost_estimate);
  });
});

describe('show_new_episodes budget/quota', () => {

  it('caps scan at max_shows and reports truncated_by_budget', async () => {
    const shows = [show('s1'), show('s2'), show('s3'), show('s4'), show('s5')];
    const h = harness({
      shows,
      episodesByShow: { s1: [ep('e1', today)], s2: [ep('e2', today)], s3: [ep('e3', today)], s4: [ep('e4', today)], s5: [ep('e5', today)] },
    });
    const out = await h.invoke({ days: 7, per_show_limit: 5, max_shows: 2 });
    const p = out.structuredContent as any;
    assert.equal(p.truncated_by_budget, true);
    assert.equal(p.shows_scanned, 2);
    assert.equal(p.saved_shows_total, 5);
  });

  it('recovers partial on 429 quota mid-loop', async () => {
    const registered: any[] = [];
    const fakeServer = {
      tool(n: string, _d: string, schema: z.ZodRawShape, h: any) {
        registered.push({ name: n, validate: (a: any) => z.object(schema).parse(a), handler: h });
      },
    } as unknown as McpServer;
    const shows = [show('s1'), show('s2'), show('s3')];
    const client = {
      async getAllPages<T>(path: string): Promise<T[]> {
        if (path === '/me/shows') return shows.map((s) => ({ added_at: '2026-01-01T00:00:00Z', show: s }) as unknown as T);
        if (path === '/me/episodes') return [] as unknown as T[];
        return [];
      },
      async get<T>(path: string): Promise<T | null> {
        if (path === '/shows/s1/episodes') return { items: [ep('e1', today)], total: 1 } as T;
        // quota on second show
        if (path === '/shows/s2/episodes') throw Object.assign(new Error('quota'), { status: 429, reason: 'QUOTA_EXCEEDED', retryAfterSec: 5 });
        return { items: [], total: 0 } as T;
      },
    };
    const { registerShowRadarTools: reg2 } = await import('../src/tools/showradar.js');
    reg2(fakeServer, client as unknown as SpotifyClient);
    const tool = registered.find((t: any) => t.name === 'show_new_episodes');
    const out = await tool.handler(tool.validate({ days: 7 }));
    const p = out.structuredContent as any;
    assert.equal(p.quota_hit, true);
    assert.equal(p.retry_after, 5);
    assert.equal(p.new_episodes, 1);
  });
});

// #673: the /me/shows walk stops at the fetch-all cap and reports nothing
// about it, so a capped listing read as the whole library — a partial scan
// announced itself as a complete one.
describe('show_new_episodes /me/shows listing cap', () => {
  const threeShows = {
    shows: [show('s1'), show('s2'), show('s3')],
    episodesByShow: { s1: [ep('e1', today, 'Fresh 1')], s2: [ep('e2', today, 'Fresh 2')], s3: [ep('e3', today, 'Fresh 3')] },
  };

  it('discloses a capped listing and that the scan stopped early', async () => {
    await withEnv({ SPOTIFY_MCP_FETCH_ALL_CAP: '1' }, async () => {
      const h = harness(threeShows);
      const out = await h.invoke({ days: 7, per_show_limit: 5 });
      const p = out.structuredContent as Record<string, unknown>;
      // Only 1 show could be listed, yet the run looks complete unless it says so.
      assert.equal(p.shows_listing_truncated, true);
      assert.equal(p.shows_list_cap, 1);
      assert.equal(p.shows_scanned, 1);
      assert.match(textOf(out), /listing capped/i);
      assert.match(textOf(out), /incomplete/);
      assert.match(textOf(out), /SPOTIFY_MCP_FETCH_ALL_CAP/);
    });
  });

  it('discloses the cap on a zero-result scan, not just a populated one', async () => {
    await withEnv({ SPOTIFY_MCP_FETCH_ALL_CAP: '1' }, async () => {
      // "No new episodes" is the answer most likely to be reported as fact.
      const h = harness({ shows: threeShows.shows, episodesByShow: { s1: [ep('old', daysAgo(20))] } });
      const out = await h.invoke({ days: 7 });
      const p = out.structuredContent as Record<string, unknown>;
      assert.equal(p.new_episodes, 0);
      assert.equal(p.shows_listing_truncated, true);
      assert.match(textOf(out), /No new episodes found/);
      assert.match(textOf(out), /incomplete/);
    });
  });

  it('reports an uncapped listing as complete', async () => {
    await withEnv({ SPOTIFY_MCP_FETCH_ALL_CAP: '500' }, async () => {
      const out = await harness(threeShows).invoke({ days: 7, per_show_limit: 5 });
      const p = out.structuredContent as Record<string, unknown>;
      assert.equal(p.shows_listing_truncated, false);
      assert.equal(p.shows_list_cap, 500);
      assert.equal(p.shows_scanned, 3);
      assert.equal(p.new_episodes, 3);
      assert.doesNotMatch(textOf(out), /listing capped/i);
    });
  });
});
