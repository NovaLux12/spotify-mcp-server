/**
 * Tests for src/tools/freshness.ts (whats_new — #112 idea 2).
 *
 * Fixture-driven: stub MCP server + stub SpotifyClient (records every call,
 * returns canned data) — no network, no token file access.
 * The stub client mirrors SpotifyClient.getAllPages semantics so the saved
 * shows walk is exercised against real pagination behavior.
 *
 * Run: node --import tsx --test tests/tools.freshness.test.ts
 */

import { describe, it } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import type { SpotifyPaged } from '../src/types/spotify.js';
import { registerFreshnessTools } from '../src/tools/freshness.js';
import { initConfig } from '../src/config.js';

// ---------------------------------------------------------------------------
// Stub plumbing (same harness shape as tests/tools.playlists-following.test.ts)
// ---------------------------------------------------------------------------

interface RecordedCall {
  method: 'GET' | 'POST' | 'PUT' | 'PUT_RAW' | 'DELETE';
  path: string;
  arg?: unknown;
}

type Responder = (path: string, arg: unknown) => unknown;

interface RegisteredTool {
  name: string;
  description: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (
    args: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  }>;
}

function makeStubClient(responder: Responder = () => null) {
  const calls: RecordedCall[] = [];
  let respond: Responder = responder;

  const client = {
    calls,
    setResponder(fn: Responder) {
      respond = fn;
    },
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      calls.push({ method: 'GET', path, arg: params });
      return respond(path, params) as T | null;
    },
    async getAllPages<T>(
      path: string,
      params?: Record<string, string>,
      opts?: { maxItems?: number },
    ): Promise<T[]> {
      const maxItems = opts?.maxItems ?? 500;
      const all: T[] = [];
      let offset = 0;
      for (;;) {
        const page = await this.get<SpotifyPaged<T>>(path, { ...params, offset: String(offset) });
        if (!page || !Array.isArray(page.items)) break;
        all.push(...page.items);
        if (all.length >= maxItems) return all.slice(0, maxItems);
        const limit =
          typeof page.limit === 'number' && page.limit > 0 ? page.limit : page.items.length;
        offset += limit;
        if (page.items.length === 0 || page.items.length < limit) break;
        if (typeof page.total === 'number' && offset >= page.total) break;
      }
      return all;
    },
  };
  return client;
}

function harness(responder: Responder = () => null) {
  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(
      name: string,
      description: string,
      schema: z.ZodRawShape,
      handler: RegisteredTool['handler'],
    ) {
      registered.push({
        name,
        description,
        validate: (args) => z.object(schema).parse(args),
        handler,
      });
    },
  } as unknown as McpServer;
  const client = makeStubClient(responder);
  registerFreshnessTools(fakeServer, client as unknown as SpotifyClient);

  return {
    registered,
    client,
    invoke: async (name: string, args: Record<string, unknown>) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

const textOf = (out: { content: Array<{ text: string }> }) => out.content[0].text;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const followedPage = (
  ids: string[],
  after: string | null,
) => ({
  artists: {
    items: ids.map((id) => ({ id, name: `Artist ${id}`, uri: `spotify:artist:${id}` })),
    total: ids.length,
    cursors: after ? { after } : null,
    next: after ? 'next' : null,
  },
});

const albumsOf = (artistId: string, albums: Array<[string, string, string]>) =>
  // [id, name, release_date]
  ({
    items: albums.map(([id, name, release_date]) => ({
      id,
      name,
      release_date,
      album_type: 'album',
      uri: `spotify:album:${id}`,
      artists: [{ name: `Artist ${artistId}` }],
    })),
  });

const showEntry = (id: string, name: string) => ({
  added_at: '2026-01-01T00:00:00Z',
  show: { id, name, uri: `spotify:show:${id}`, total_episodes: 10 },
});

const episodesOf = (showId: string, eps: Array<[string, string, string]>) =>
  // [id, name, release_date]
  ({
    items: eps.map(([id, name, release_date]) => ({
      id,
      name,
      release_date,
      duration_ms: 1_800_000,
      uri: `spotify:episode:${id}`,
      show: { id: showId, name: `Show ${showId}` },
    })),
  });

/** Restore the process-wide config snapshot after a test rebinds it. */
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
// whats_new
// ---------------------------------------------------------------------------

describe('whats_new', () => {
  it('registers exactly one tool with the expected name', () => {
    const h = harness();
    assert.deepEqual(h.registered.map((t) => t.name), ['whats_new']);
  });

  it('walks followed artists via the after cursor and fetches each artist album page', async () => {
    const h = harness((path, params) => {
      if (path === '/me/following') {
        return params?.after
          ? followedPage(['b2'], null)
          : followedPage(['a1'], 'cursor-1');
      }
      const artistId = path.match(/^\/artists\/([^/]+)\/albums$/)?.[1];
      assert.ok(artistId, `unexpected path ${path}`);
      return albumsOf(artistId, [
        [`${artistId}-alb`, `${artistId} new album`, '2026-08-20'],
      ]);
    });

    const out = await h.invoke('whats_new', { since: '2026-08-01', kinds: ['albums'] });

    const followingCalls = h.client.calls.filter((c) => c.path === '/me/following');
    assert.equal(followingCalls.length, 2);
    assert.equal(followingCalls[0].arg?.after, undefined);
    assert.equal(followingCalls[1].arg?.after, 'cursor-1');
    const albumPaths = h.client.calls.map((c) => c.path).filter((p) => p.endsWith('/albums'));
    assert.deepEqual(albumPaths, ['/artists/a1/albums', '/artists/b2/albums']);

    const text = textOf(out);
    assert.match(text, /a1 new album/);
    assert.match(text, /b2 new album/);
    const payload = out.structuredContent as { counts: { albums: number } };
    assert.equal(payload.counts.albums, 2);
  });

  it('filters releases older than the cutoff out of text and payload', async () => {
    const h = harness((path) =>
      path === '/me/following'
        ? followedPage(['a1'], null)
        : albumsOf('a1', [
            ['new-one', 'Fresh LP', '2026-08-15'],
            ['old-one', 'Ancient LP', '2024-03-02'],
          ]),
    );

    const out = await h.invoke('whats_new', { since: '2026-08-01', kinds: ['albums'] });

    const text = textOf(out);
    assert.match(text, /Fresh LP/);
    assert.doesNotMatch(text, /Ancient LP/);
    const payload = out.structuredContent as {
      items: Array<{ id: string }>;
      counts: { albums: number };
    };
    assert.equal(payload.counts.albums, 1);
    assert.deepEqual(payload.items.map((i) => i.id), ['new-one']);
  });
  it('stops artist lookups at SPOTIFY_MCP_FETCH_ALL_CAP and stops walking the follow cursor', async () => {
    await withEnv({ SPOTIFY_MCP_FETCH_ALL_CAP: '2' }, async () => {
      const h = harness((path, params) =>
        path === '/me/following'
          ? params?.after
            ? followedPage(['c3'], null)
            : followedPage(['a1', 'b2'], 'cursor-1')
          : albumsOf(path.match(/^\/artists\/([^/]+)\//)?.[1] ?? '', [
              [`x-${path}`, `Release`, '2026-08-10'],
            ]),
      );

      const out = await h.invoke('whats_new', { since: '2026-08-01', kinds: ['albums'] });

      // Cap 2 reached inside the first follow page: exactly two album lookups,
      // and the second follow page is never fetched.
      const albumPaths = h.client.calls.map((c) => c.path).filter((p) => p.endsWith('/albums'));
      assert.deepEqual(albumPaths, ['/artists/a1/albums', '/artists/b2/albums']);
      assert.equal(h.client.calls.filter((c) => c.path === '/me/following').length, 1);

      const payload = out.structuredContent as {
        lookups: { artist_album_calls: number; albums_truncated_by_cap: boolean };
      };
      assert.equal(payload.lookups.artist_album_calls, 2);
      assert.equal(payload.lookups.albums_truncated_by_cap, true);
    });
  });

  it('scans saved shows through getAllPages paging and filters episodes by cutoff', async () => {
    const h = harness((path) => {
      if (path === '/me/shows') return { items: [showEntry('s1', 'Tech Weekly')], total: 1 };
      if (path === '/shows/s1/episodes') {
        return episodesOf('s1', [
          ['ep-new', 'Episode 42', '2026-08-22'],
          ['ep-old', 'Episode 1', '2025-01-05'],
        ]);
      }
      return followedPage([], null);
    });

    const out = await h.invoke('whats_new', { kinds: ['podcasts'], since: '2026-08-01' });

    // No artist lookups when podcasts-only.
    assert.ok(!h.client.calls.some((c) => c.path.includes('/artists/')));
    const text = textOf(out);
    assert.match(text, /Episode 42 — Tech Weekly \| 2026-08-22 \| URI: spotify:episode:ep-new/);
    assert.doesNotMatch(text, /Episode 1/);
    const payload = out.structuredContent as { counts: { episodes: number }; items: Array<{ kind: string }> };
    assert.equal(payload.counts.episodes, 1);
    assert.deepEqual(payload.items.map((i) => i.kind), ['episode']);
  });

  it('merges both kinds sorted newest-first in one list', async () => {
    const h = harness((path) => {
      if (path === '/me/following') return followedPage(['a1'], null);
      if (path === '/artists/a1/albums') return albumsOf('a1', [['alb', 'Mid Album', '2026-08-10']]);
      if (path === '/me/shows') return { items: [showEntry('s1', 'Pod')], total: 1 };
      if (path === '/shows/s1/episodes') return episodesOf('s1', [['ep1', 'Newest Episode', '2026-08-21']]);
      throw new Error(`unexpected path ${path}`);
    });

    const out = await h.invoke('whats_new', { since: '2026-08-01' });

    const payload = out.structuredContent as { items: Array<{ id: string; date_key: string }> };
    assert.deepEqual(
      payload.items.map((i) => i.id),
      ['ep1', 'alb'],
    );
    assert.ok(payload.items[0].date_key >= payload.items[1].date_key);
  });

  it('dry_run makes zero API calls and reports the plan + cutoff', async () => {
    const h = harness(() => {
      throw new Error('no API call expected during dry_run');
    });

    const out = await h.invoke('whats_new', { since: '2026-08-01', dry_run: true });

    assert.equal(h.client.calls.length, 0);
    const text = textOf(out);
    assert.match(text, /\[dry run\]/);
    assert.match(text, /2026-08-01/);
    assert.match(text, /\/me\/following/);
    assert.match(text, /\/shows\/\{id\}\/episodes/);
    const payload = out.structuredContent as Record<string, unknown>;
    assert.equal(payload.dry_run, true);
    assert.equal(payload.cutoff, '2026-08-01');
  });

  it("since='last-check' reads the watermark, uses it as cutoff, and advances it to today", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'freshness-test-'));
    const statePath = join(dir, 'freshness.json');
    try {
      await writeFile(statePath, JSON.stringify({ last_check: '2026-07-01' }, null, 2), {
        mode: 0o600,
      });
      await withEnv({ SPOTIFY_MCP_FRESHNESS_STATE: statePath }, async () => {
        const h = harness((path) => {
          if (path === '/me/following') return followedPage(['a1'], null);
          if (path === '/artists/a1/albums') return albumsOf('a1', [['alb', 'July Drop', '2026-07-15']]);
          throw new Error(`unexpected path ${path}`);
        });

        const out = await h.invoke('whats_new', { since: 'last-check', kinds: ['albums'] });

        const payload = out.structuredContent as {
          cutoff: string;
          previous_watermark: string | null;
          watermark: string;
        };
        assert.equal(payload.previous_watermark, '2026-07-01');
        assert.equal(payload.cutoff, '2026-07-01');

        // July 15 drop included (>= cutoff); watermark advanced to today UTC.
        assert.match(textOf(out), /July Drop/);
        const today = new Date().toISOString().slice(0, 10);
        assert.equal(payload.watermark, today);
        const stored = JSON.parse(await readFile(statePath, 'utf8')) as { last_check: string };
        assert.equal(stored.last_check, today);
        assert.equal((await stat(statePath)).mode & 0o777, 0o600);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("missing watermark file falls back to days_back and reports no previous watermark", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'freshness-test-'));
    const statePath = join(dir, 'absent.json');
    try {
      await withEnv({ SPOTIFY_MCP_FRESHNESS_STATE: statePath }, async () => {
        const h = harness((path) => {
          if (path === '/me/following') return followedPage(['a1'], null);
          if (path === '/artists/a1/albums') return albumsOf('a1', []);
          throw new Error(`unexpected path ${path}`);
        });

        const out = await h.invoke('whats_new', { since: 'last-check', kinds: ['albums'] });

        // No stored watermark: cutoff falls back to days_back (30), no
        // previous watermark reported — and the run still writes one.
        const expectedCutoff = (() => {
          const d = new Date();
          d.setUTCDate(d.getUTCDate() - 30);
          return d.toISOString().slice(0, 10);
        })();
        const payload = out.structuredContent as {
          cutoff: string;
          previous_watermark: string | null;
          watermark: string;
        };
        assert.equal(payload.previous_watermark, null);
        assert.equal(payload.cutoff, expectedCutoff);
        const today = new Date().toISOString().slice(0, 10);
        assert.equal(payload.watermark, today);
        const stored = JSON.parse(await readFile(statePath, 'utf8')) as { last_check: string };
        assert.equal(stored.last_check, today);
        assert.equal((await stat(statePath)).mode & 0o777, 0o600);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects an invalid since value through schema validation', async () => {
    const h = harness();
    await assert.rejects(
      () => h.invoke('whats_new', { since: 'not-a-date' }),
      /Invalid|expected|matched/i,
    );
  });

  it('json mode emits the raw payload as text alongside structuredContent', async () => {
    const h = harness((path) => {
      if (path === '/me/following') return followedPage(['a1'], null);
      if (path === '/artists/a1/albums') return albumsOf('a1', [['alb', 'JSON LP', '2026-08-12']]);
      throw new Error(`unexpected path ${path}`);
    });

    const out = await h.invoke('whats_new', { since: '2026-08-01', kinds: ['albums'], response_format: 'json' });

    const parsed = JSON.parse(textOf(out)) as typeof out.structuredContent;
    assert.deepEqual(parsed, out.structuredContent);
    assert.ok((out.structuredContent as { items: unknown[] }).items.length > 0);
  });

  it('defaults to a 30-day cutoff when no inputs are given', async () => {
    const h = harness((path) => {
      if (path === '/me/following') return followedPage(['a1'], null);
      if (path === '/artists/a1/albums') return albumsOf('a1', []);
      throw new Error(`unexpected path ${path}`);
    });

    const out = await h.invoke('whats_new', { kinds: ['albums'] });

    const expectedCutoff = (() => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - 30);
      return d.toISOString().slice(0, 10);
    })();
    assert.equal((out.structuredContent as { cutoff: string }).cutoff, expectedCutoff);
  });

  // -----------------------------------------------------------------------
  // #239 — watermark hold on truncated scans
  // -----------------------------------------------------------------------

  it('holds watermark (does not advance) when scan is truncated by cap', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'freshness-test-'));
    const statePath = join(dir, 'freshness.json');
    try {
      await writeFile(statePath, JSON.stringify({ last_check: '2026-07-01' }, null, 2), { mode: 0o600 });
      await withEnv({ SPOTIFY_MCP_FRESHNESS_STATE: statePath, SPOTIFY_MCP_FETCH_ALL_CAP: '1' }, async () => {
        const h = harness((path, params) =>
          path === '/me/following'
            ? (params as Record<string, string>)?.after
              ? followedPage(['b2'], null)
              : followedPage(['a1', 'b2'], 'cursor-1')
            : albumsOf((path.match(/^\/artists\/([^/]+)\//)?.[1] ?? ''), [['alb', 'New LP', '2026-08-10']]),
        );
        const out = await h.invoke('whats_new', { since: 'last-check', kinds: ['albums'] });
        const payload = out.structuredContent as {
          watermark: string | null; watermark_advanced: boolean; watermark_held: boolean; watermark_reason: string;
        };
        assert.equal(payload.watermark_advanced, false);
        assert.equal(payload.watermark_held, true);
        assert.equal(payload.watermark, null);
        assert.match(payload.watermark_reason, /truncated by cap/i);
        assert.match(textOf(out), /watermark held/i);
        // Watermark file must NOT have been advanced
        const stored = JSON.parse(await readFile(statePath, 'utf8')) as { last_check: string };
        assert.equal(stored.last_check, '2026-07-01');
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // -----------------------------------------------------------------------
  // #242 — quota budget & dry_run cost disclosure
  // -----------------------------------------------------------------------

  it('dry_run reports cost_estimate and max_artists without making API calls', async () => {
    const h = harness(() => { throw new Error('no API call expected'); });
    const out = await h.invoke('whats_new', { since: '2026-08-01', dry_run: true });
    assert.equal(h.client.calls.length, 0);
    const payload = out.structuredContent as { cost_estimate: string; max_artists: number; dry_run: boolean };
    assert.equal(payload.dry_run, true);
    assert.ok(typeof payload.cost_estimate === 'string' && payload.cost_estimate.length > 0);
    assert.match(payload.cost_estimate, /N\+1|N followed artists/i);
    assert.ok(typeof payload.max_artists === 'number' && payload.max_artists > 0);
    assert.match(textOf(out), /Cost estimate/i);
  });

  it('max_artists budget caps lookups independently of fetchAllCap', async () => {
    await withEnv({ SPOTIFY_MCP_FETCH_ALL_CAP: '500', SPOTIFY_MCP_FRESHNESS_BUDGET: '1' }, async () => {
      const h = harness((path, params) =>
        path === '/me/following'
          ? (params as Record<string, string>)?.after
            ? followedPage(['b2'], null)
            : followedPage(['a1', 'b2'], 'cursor-1')
          : albumsOf((path.match(/^\/artists\/([^/]+)\//)?.[1] ?? ''), [['alb', 'LP', '2026-08-10']]),
      );
      const out = await h.invoke('whats_new', { since: '2026-08-01', kinds: ['albums'] });
      const payload = out.structuredContent as { lookups: { artist_album_calls: number; budget: number; fetch_all_cap: number } };
      assert.equal(payload.lookups.artist_album_calls, 1);
      assert.equal(payload.lookups.budget, 1);
      assert.equal(payload.lookups.fetch_all_cap, 500);
    });
  });

  it('per-call max_artists param overrides the env budget', async () => {
    await withEnv({ SPOTIFY_MCP_FRESHNESS_BUDGET: '25' }, async () => {
      const h = harness((path, params) =>
        path === '/me/following'
          ? (params as Record<string, string>)?.after
            ? followedPage(['c3'], null)
            : followedPage(['a1', 'b2'], 'cursor-1')
          : albumsOf((path.match(/^\/artists\/([^/]+)\//)?.[1] ?? ''), [['alb', 'LP', '2026-08-10']]),
      );
      const out = await h.invoke('whats_new', { since: '2026-08-01', kinds: ['albums'], max_artists: 1 });
      const payload = out.structuredContent as { lookups: { artist_album_calls: number } };
      assert.equal(payload.lookups.artist_album_calls, 1);
    });
  });

  it('mid-walk QUOTA_EXCEEDED returns partial results with quota_hit and holds watermark', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'freshness-test-'));
    const statePath = join(dir, 'freshness.json');
    try {
      await writeFile(statePath, JSON.stringify({ last_check: '2026-07-01' }, null, 2), { mode: 0o600 });
      await withEnv({ SPOTIFY_MCP_FRESHNESS_STATE: statePath }, async () => {
        let callCount = 0;
        const h = harness((path) => {
          if (path === '/me/following') return followedPage(['a1', 'b2'], null);
          callCount++;
          if (callCount === 1) return albumsOf('a1', [['alb1', 'LP One', '2026-08-10']]);
          // Second artist lookup throws QUOTA_EXCEEDED
          const err = Object.assign(new Error('quota'), { status: 429, reason: 'QUOTA_EXCEEDED', retryAfterSec: 3600 });
          throw err;
        });
        const out = await h.invoke('whats_new', { since: '2026-08-01', kinds: ['albums'] });
        const payload = out.structuredContent as {
          quota_hit: boolean; retry_after: number; counts: { albums: number }; watermark_held: boolean; watermark_advanced: boolean;
        };
        assert.equal(payload.quota_hit, true);
        assert.equal(payload.retry_after, 3600);
        assert.equal(payload.counts.albums, 1); // partial results preserved
        assert.equal(payload.watermark_held, true);
        assert.equal(payload.watermark_advanced, false);
        assert.match(textOf(out), /Quota exceeded/i);
        // Watermark must not have been advanced
        const stored = JSON.parse(await readFile(statePath, 'utf8')) as { last_check: string };
        assert.equal(stored.last_check, '2026-07-01');
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
