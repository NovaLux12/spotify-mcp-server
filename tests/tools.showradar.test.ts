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
    async getAllPages<T>(path: string): Promise<T[]> {
      if (path === '/me/shows') {
        return shows.map((s) => ({ added_at: '2026-01-01T00:00:00Z', show: s }) as unknown as T);
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
