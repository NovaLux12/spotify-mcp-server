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


import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StubFromResponder } from './helpers/stub-client.js';
import type { LegacyResponder } from './helpers/stub-client.js';
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
  let respond: Responder = responder;
  // #659: the paging walk below used to be a hand copy of
  // `getAllPagesWithTruncation` with a hardcoded `?? 500` cap, so a change to
  // the real cap, short-page break or `pages` count could not reach a test in
  // this file. It is now INHERITED from SpotifyClient via the shared stub.
  //
  // The quota surface upstream added alongside it is kept and now sits on the
  // real client's `getRateLimitStatus`, so `requests_made` (counted here) and
  // `cost.requests` (summed in freshness.ts) are still produced by different
  // code and must still agree.
  let cooldownRemainingMs = 0;
  // #659: the request counter counts DISPATCHED calls, because the real
  // client increments `requestsTotal` inside its own request path and the stub
  // short-circuits that. Counting here — once per route hit, on the object the
  // recorder also pushes to — is what keeps `requests_made` and
  // `cost.requests` cross-checkable against `h.client.calls.length`, which is
  // the whole point of upstream's assertions.
  let requestsTotal = 0;
  const client = new StubFromResponder((path, arg) => (respond as LegacyResponder)(path, arg));
  client.route('GET', /.*/, {
    respond: (call) => {
      requestsTotal++;
      return (respond as LegacyResponder)(call.path, call.arg);
    },
  });
  const realQuota = client.getRateLimitStatus.bind(client);
  Object.defineProperty(client, 'getRateLimitStatus', {
    value: () => ({ ...realQuota(), requestsTotal, cooldownRemainingMs }),
  });
  Object.defineProperty(client, 'setResponder', {
    value: (fn: Responder) => { respond = fn; },
  });
  Object.defineProperty(client, 'setCooldown', {
    value: (ms: number) => { cooldownRemainingMs = ms; },
  });
  const calls = client.calls as unknown as RecordedCall[];
  return { calls, client };
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
  const stub = makeStubClient(responder);
  registerFreshnessTools(fakeServer, stub.client);

  return {
    registered,
    client: stub.client,
    calls: stub.calls,
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

/**
 * Cursor-paged `/me/following` over `total` artists at the walk's real page
 * size of 50. `after` is the index the next page starts at, so a 60-artist
 * library really does take two follow pages — the case the old flat "+1"
 * undercounted.
 */
const followedListing = (total: number) => (after: unknown) => {
  const start = typeof after === 'string' ? Number(after.replace('cursor-', '')) : 0;
  const end = Math.min(start + 50, total);
  return {
    artists: {
      items: Array.from({ length: end - start }, (_, i) => {
        const id = `a${start + i}`;
        return { id, name: `Artist ${id}`, uri: `spotify:artist:${id}` };
      }),
      total,
      cursors: end < total ? { after: `cursor-${end}` } : null,
      next: end < total ? 'next' : null,
    },
  };
};

/**
 * Offset-paged `/me/shows` over `total` saved shows at the walk's page size of
 * 50, echoing `limit` back the way Spotify does so the walk's offset arithmetic
 * advances correctly.
 */
const showsListing = (total: number) => (offset: unknown) => {
  const start = typeof offset === 'string' ? Number(offset) : 0;
  const end = Math.min(start + 50, total);
  return {
    items: Array.from({ length: end - start }, (_, i) => showEntry(`s${start + i}`, `Show ${start + i}`)),
    total,
    limit: 50,
  };
};

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

  it('holds the freshness watermark in READONLY mode', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'spotify-freshness-'));
    const state = join(temp, 'freshness.json');
    try {
      await withEnv({ SPOTIFY_MCP_READONLY: '1', SPOTIFY_MCP_FRESHNESS_STATE: state }, async () => {
        const h = harness((path) =>
          path === '/me/following'
            ? followedPage(['a1'], null)
            : albumsOf('a1', [['fresh-one', 'Fresh LP', '2026-08-20']]),
        );
        const out = await h.invoke('whats_new', { since: '2026-08-01', kinds: ['albums'] });
        const payload = out.structuredContent as {
          watermark_advanced: boolean;
          watermark_held: boolean;
          watermark_reason: string;
        };
        assert.equal(payload.watermark_advanced, false);
        assert.equal(payload.watermark_held, true);
        assert.match(payload.watermark_reason, /READONLY/);
        await assert.rejects(stat(state), { code: 'ENOENT' });
      });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
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

  // #1084: a stale world-readable `.tmp` left over from an earlier run must
  // not bleed into the renamed watermark file.
  it('tightens a leftover world-readable .tmp + destination to 0600 on the final file (#1084)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'freshness-test-'));
    const statePath = join(dir, 'freshness.json');
    const tmpPath = `${statePath}.tmp`;
    try {
      // Pre-existing destination AND tmp, both world-readable — the rename
      // carries the tmp's inode across, so the tmp's mode is what matters.
      await writeFile(statePath, JSON.stringify({ last_check: '2026-07-01' }, null, 2), {
        mode: 0o644,
      });
      await writeFile(tmpPath, 'stale', { mode: 0o666 });
      await chmod(statePath, 0o644);
      await chmod(tmpPath, 0o666);
      await withEnv({ SPOTIFY_MCP_FRESHNESS_STATE: statePath }, async () => {
        const h = harness((path) => {
          if (path === '/me/following') return followedPage(['a1'], null);
          if (path === '/artists/a1/albums') return albumsOf('a1', [['alb', 'July Drop', '2026-07-15']]);
          throw new Error(`unexpected path ${path}`);
        });
        await h.invoke('whats_new', { since: 'last-check', kinds: ['albums'] });
      });
      assert.equal((await stat(statePath)).mode & 0o777, 0o600);
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

  // #683 — a day that does not exist on the calendar must be rejected by name,
  // never rolled into a neighbouring month the way `new Date()` silently does
  // (2026-02-30 -> 2026-03-02, 2026-02-29 -> 2026-03-01).
  const IMPOSSIBLE_SINCE: Array<[string, RegExp]> = [
    ['2026-02-30', /2026-02 has 28 days.*day 30 does not exist/],
    ['2026-02-29', /2026-02 has 28 days.*day 29 does not exist/],
    ['2026-13-01', /month 13 does not exist/],
  ];

  for (const [since, expected] of IMPOSSIBLE_SINCE) {
    it(`rejects since="${since}" naming the since field, before any API call`, async () => {
      const h = harness((path) => {
        if (path === '/me/following') return followedPage(['a1'], null);
        if (path === '/artists/a1/albums') return albumsOf('a1', [['alb', 'Drop', '2026-03-05']]);
        throw new Error(`unexpected path ${path}`);
      });

      const err = await h.invoke('whats_new', { since, kinds: ['albums'] }).then(
        () => null,
        (e: unknown) => e,
      );
      assert.ok(err, `since="${since}" must be rejected`);
      const message = err instanceof Error ? err.message : String(err);
      // Names the offending field, echoes the offending value, explains why.
      assert.match(message, /since/);
      assert.ok(message.includes(since), `error should echo ${since}: ${message}`);
      assert.match(message, expected);
      // Rejected at validation: no scan happened, so no window was queried.
      assert.equal(h.client.calls.length, 0, 'no API call may be made for an impossible since');
    });
  }

  it('accepts a real leap day since=2028-02-29 and scans that window', async () => {
    const h = harness((path) => {
      if (path === '/me/following') return followedPage(['a1'], null);
      if (path === '/artists/a1/albums') {
        return albumsOf('a1', [['pre', 'Before', '2028-02-28'], ['on', 'Leap Day LP', '2028-02-29']]);
      }
      throw new Error(`unexpected path ${path}`);
    });

    const out = await h.invoke('whats_new', { since: '2028-02-29', kinds: ['albums'] });

    const payload = out.structuredContent as { cutoff: string; items: Array<{ name: string }> };
    assert.equal(payload.cutoff, '2028-02-29');
    // Inclusive on the boundary day, exclusive before it.
    assert.deepEqual(payload.items.map((i) => i.name), ['Leap Day LP']);
  });

  it('drops an impossible upstream release_date instead of rolling it forward', async () => {
    const h = harness((path) => {
      if (path === '/me/following') return followedPage(['a1'], null);
      if (path === '/artists/a1/albums') {
        return albumsOf('a1', [
          ['bogus', 'Impossible Day', '2026-02-30'],
          ['real', 'Real Day', '2026-03-05'],
        ]);
      }
      throw new Error(`unexpected path ${path}`);
    });

    const out = await h.invoke('whats_new', { since: '2026-01-01', kinds: ['albums'] });

    const payload = out.structuredContent as { items: Array<{ name: string; date_key: string }> };
    assert.deepEqual(payload.items.map((i) => i.name), ['Real Day']);
    // The bogus date must not surface as the rolled-over 2026-03-02.
    assert.ok(!textOf(out).includes('2026-03-02'));
  });

  it('rejects a stored watermark that is not a real calendar day', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'freshness-test-'));
    const statePath = join(dir, 'freshness.json');
    try {
      await writeFile(statePath, JSON.stringify({ last_check: '2026-02-30' }, null, 2), {
        mode: 0o600,
      });
      await withEnv({ SPOTIFY_MCP_FRESHNESS_STATE: statePath }, async () => {
        const h = harness((path) => {
          if (path === '/me/following') return followedPage(['a1'], null);
          throw new Error(`unexpected path ${path}`);
        });

        await assert.rejects(
          () => h.invoke('whats_new', { since: 'last-check', kinds: ['albums'] }),
          (e: unknown) => {
            const message = e instanceof Error ? e.message : String(e);
            assert.match(message, /watermark/);
            assert.ok(message.includes('2026-02-30'), `error should echo the stored value: ${message}`);
            return true;
          },
        );
        // The corrupt watermark must not be used as a cutoff or re-persisted.
        const stored = JSON.parse(await readFile(statePath, 'utf8')) as { last_check: string };
        assert.equal(stored.last_check, '2026-02-30');
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

  // #679 — the `N+1` this asserted was the defect: one flat "+1" charged a
  // single follow page for a walk that issues one per 50 artists. The bound is
  // now in the walk's own pager, and it says it is a bound.
  it('dry_run reports cost_estimate and max_artists without making API calls', async () => {
    const h = harness(() => { throw new Error('no API call expected'); });
    const out = await h.invoke('whats_new', { since: '2026-08-01', dry_run: true });
    assert.equal(h.client.calls.length, 0);
    const payload = out.structuredContent as { cost_estimate: string; max_artists: number; dry_run: boolean };
    assert.equal(payload.dry_run, true);
    assert.ok(typeof payload.cost_estimate === 'string' && payload.cost_estimate.length > 0);
    assert.match(payload.cost_estimate, /at most 25 album lookups \+ at most 1 follow page\(s\) of 50/);
    assert.ok(typeof payload.max_artists === 'number' && payload.max_artists > 0);
    assert.match(textOf(out), /Cost ESTIMATE \(a budget bound, not a measurement/i);
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

// ---------------------------------------------------------------------------
// #679 — the cost estimate and the per-source scan counters
// ---------------------------------------------------------------------------

interface SourceScanRow {
  source: 'albums' | 'podcasts';
  requested: boolean;
  walked: boolean;
  scanned: number;
  lookups: number;
  listing_requests: number | null;
  listing_truncated: boolean;
  partial: boolean;
  stopped_by: 'cap' | 'quota' | null;
}

interface CallPayload {
  scanned: {
    artists: number;
    shows: number;
    total: number;
    partial: boolean;
    sources: SourceScanRow[];
  };
  cost: {
    kind: 'budget_bound' | 'measured' | 'measured_lower_bound';
    measured: boolean;
    requests: number | null;
    requests_floor?: number;
    requests_note?: string;
    basis?: string;
    assumes_full_pages?: boolean;
    breakdown: {
      follow_pages: number;
      album_lookups: number;
      show_listing_pages: number | null;
      show_episode_calls: number;
    };
    planned?: { max_requests: number };
    albums?: { max_lookups: number; max_listing_pages: number; max_requests: number; listing_page_size: number } | null;
    podcasts?: { max_lookups: number; max_listing_pages: number; max_requests: number; listing_page_size: number } | null;
  };
  lookups: {
    artists_seen: number;
    artist_album_calls: number;
    follow_pages: number;
    shows_seen: number;
    show_episode_calls: number;
    show_listing_pages: number | null;
    shows_walked: boolean;
    shows_listing_truncated: boolean;
    albums_truncated_by_cap: boolean;
    shows_truncated_by_cap: boolean;
  };
  quota_hit?: boolean;
  quota_source?: 'albums' | 'podcasts' | null;
  scanned_artists?: number;
  requests_made?: number;
  watermark_advanced: boolean;
  watermark_held: boolean;
  watermark_reason?: string;
}

const rowOf = (payload: CallPayload, source: 'albums' | 'podcasts'): SourceScanRow => {
  const row = payload.scanned.sources.find((s) => s.source === source);
  assert.ok(row, `a ${source} source row must be published`);
  return row;
};

const quotaError = (retryAfterSec: number) =>
  Object.assign(new Error('quota'), { status: 429, reason: 'QUOTA_EXCEEDED', retryAfterSec });

describe('whats_new cost estimate and per-source scan counters (#679)', () => {
  it('charges the follow walk for every page it pages, not a flat +1', async () => {
    const h = harness(() => { throw new Error('dry_run must make no API call'); });

    const out = await h.invoke('whats_new', { since: '2026-08-01', dry_run: true, max_artists: 60, kinds: ['albums'] });
    const { cost } = out.structuredContent as CallPayload;

    // Hand arithmetic, not a re-run of the code under test: 60 artists at the
    // walk's page size of 50 needs ceil(60/50) = 2 follow pages, plus the 60
    // album lookups the budget allows → 62 requests. The pre-fix estimate said
    // "N+1 ... at most 61", which is what let a caller budget 3 requests short.
    assert.equal(cost.albums?.max_listing_pages, 2);
    assert.equal(cost.albums?.max_lookups, 60);
    assert.equal(cost.albums?.max_requests, 62);
    assert.equal(cost.albums?.listing_page_size, 50);
    assert.equal(cost.max_requests, 62);
    assert.doesNotMatch(String((out.structuredContent as { cost_estimate: string }).cost_estimate), /N\+1/);
  });

  it('labels the dry-run figure a bound rather than a measurement', async () => {
    const h = harness(() => { throw new Error('dry_run must make no API call'); });

    const out = await h.invoke('whats_new', { since: '2026-08-01', dry_run: true, max_artists: 60, kinds: ['albums'] });
    const { cost } = out.structuredContent as CallPayload;

    assert.equal(cost.kind, 'budget_bound');
    assert.equal(cost.measured, false);
    // The one assumption the bound rests on is part of the contract, so a
    // caller can see what it would take for the figure to be wrong.
    assert.equal(cost.assumes_full_pages, true);
    assert.match(String(cost.basis), /unknown until the walk runs/);
    assert.match(textOf(out), /not a measurement/);
  });

  it('the dry-run bound covers what the same budget actually spends', async () => {
    const follow = followedListing(60);
    const h = harness((path, params) =>
      path === '/me/following'
        ? follow(params?.after)
        : albumsOf(path.match(/^\/artists\/([^/]+)\//)?.[1] ?? '', [['alb', 'LP', '2026-08-10']]),
    );

    const dry = await h.invoke('whats_new', { since: '2026-08-01', dry_run: true, max_artists: 60, kinds: ['albums'] });
    const bound = (dry.structuredContent as CallPayload).cost.albums!.max_requests;

    const out = await h.invoke('whats_new', { since: '2026-08-01', max_artists: 60, kinds: ['albums'] });
    const payload = out.structuredContent as CallPayload;

    // 2 follow pages for 60 artists — the page the flat "+1" did not charge.
    assert.equal(payload.lookups.follow_pages, 2);
    assert.equal(h.client.calls.filter((c) => c.path === '/me/following').length, 2);
    assert.equal(payload.cost.kind, 'measured');
    assert.equal(payload.cost.requests, 62);
    // Cross-check against the transport's own record, not against the tool's
    // own counters: a self-consistent sum would pass even if the sum were wrong.
    assert.equal(payload.cost.requests, h.client.calls.length);
    assert.equal(payload.requests_made, h.client.calls.length);
    // And the bound an agent would have budgeted against must not be short.
    assert.ok(payload.cost.requests! <= bound, `spent ${payload.cost.requests} against a bound of ${bound}`);
  });

  it('counts a podcast scan when the quota wall lands mid-podcast walk', async () => {
    const listing = showsListing(3);
    const h = harness((path, params) => {
      if (path === '/me/shows') return listing(params?.offset);
      if (path === '/shows/s0/episodes') return episodesOf('s0', [['e0', 'Ep 0', '2026-08-20']]);
      if (path === '/shows/s1/episodes') return episodesOf('s1', [['e1', 'Ep 1', '2026-08-20']]);
      // Third show hits the wall.
      if (path === '/shows/s2/episodes') throw quotaError(3600);
      throw new Error(`unexpected path ${path}`);
    });

    const out = await h.invoke('whats_new', { since: '2026-08-01', kinds: ['podcasts'] });
    const payload = out.structuredContent as CallPayload;

    assert.equal(payload.quota_hit, true);
    assert.equal(payload.quota_source, 'podcasts');
    // The bug: the podcasts quota catch recorded the ARTIST counter, so a
    // podcasts-only run published scanned_artists: 0 and read as "nothing was
    // scanned" — which is what provokes an immediate retry against an
    // exhausted quota.
    assert.equal(payload.scanned_artists, 0);
    assert.equal(payload.scanned.shows, 2, 'two shows were actually read');
    assert.equal(payload.scanned.artists, 0);
    assert.equal(payload.scanned.total, 2, 'scanned_artists is not the scan total');
    const podcasts = rowOf(payload, 'podcasts');
    assert.equal(podcasts.walked, true);
    assert.equal(podcasts.scanned, 2);
    assert.equal(podcasts.stopped_by, 'quota');
    // The request that threw still cost quota, so it is charged (#818's rule).
    assert.equal(podcasts.lookups, 3);
    assert.equal(payload.lookups.show_episode_calls, 3);
    // And the total is cross-checked against the transport record: 1 listing
    // page + 3 episode requests, the last of which failed.
    assert.equal(payload.cost.requests, 4);
    assert.equal(payload.cost.requests, h.client.calls.length);
    assert.match(textOf(out), /2 shows scanned/);
    assert.match(textOf(out), /podcasts leg/);
  });

  it('never reports an unwalked source as a source that returned nothing', async () => {
    const h = harness((path) => {
      if (path === '/me/following') return followedPage(['a1', 'a2'], null);
      if (path === '/artists/a1/albums') return albumsOf('a1', [['alb', 'LP', '2026-08-20']]);
      // Second artist hits the wall, so the podcasts leg never runs.
      throw quotaError(1800);
    });

    const out = await h.invoke('whats_new', { since: '2026-08-01' });
    const payload = out.structuredContent as CallPayload;

    assert.equal(payload.quota_source, 'albums');
    const podcasts = rowOf(payload, 'podcasts');
    assert.equal(podcasts.requested, true);
    assert.equal(podcasts.walked, false, 'the podcasts leg never ran');
    assert.equal(podcasts.scanned, 0);
    // A skipped source is not a clean zero: nothing about it was read, so it is
    // not "scanned, found none" and must not read as a completed scan.
    assert.equal(podcasts.partial, true);
    assert.equal(payload.scanned.partial, true);
    assert.equal(payload.scanned.sources.length, 2);
    assert.match(textOf(out), /podcasts NOT walked/);
    assert.match(textOf(out), /not a statement about your saved shows/);
    // No listing request was ever made for podcasts.
    assert.equal(h.client.calls.some((c) => c.path === '/me/shows'), false);
  });

  it('marks a clipped saved-shows listing as a partial source and holds the watermark', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'freshness-679-'));
    const statePath = join(dir, 'freshness.json');
    try {
      await writeFile(statePath, JSON.stringify({ last_check: '2026-07-01' }), { mode: 0o600 });
      // 120 saved shows, budget 2: the listing's first page already carries more
      // rows than the walk can use, so the read is clipped.
      const listing = showsListing(120);
      await withEnv({ SPOTIFY_MCP_FRESHNESS_STATE: statePath }, async () => {
        const h = harness((path, params) => {
          if (path === '/me/shows') return listing(params?.offset);
          if (path.startsWith('/shows/') && path.endsWith('/episodes')) {
            return episodesOf(path.split('/')[2]!, [['e', 'Ep', '2026-08-20']]);
          }
          throw new Error(`unexpected path ${path}`);
        });

        const out = await h.invoke('whats_new', { since: 'last-check', kinds: ['podcasts'], max_artists: 2 });
        const payload = out.structuredContent as CallPayload;
        const look = payload.lookups;

        // The listing's own verdict, not the episode loop's: the two episode
        // lookups below the cap all succeeded, so nothing but the listing
        // reveals that 118 of the 120 saved shows were never read.
        assert.equal(look.shows_listing_truncated, true);
        assert.equal(look.shows_truncated_by_cap, false);
        const podcasts = rowOf(payload, 'podcasts');
        assert.equal(podcasts.listing_truncated, true);
        assert.equal(podcasts.partial, true);
        assert.equal(podcasts.stopped_by, 'cap');
        assert.equal(payload.scanned.partial, true);
        // The listing was clipped, so the scan did not finish: the watermark
        // must be held or the unreached shows would be skipped forever.
        assert.equal(payload.watermark_advanced, false);
        assert.match(String(payload.watermark_reason), /truncated by cap/i);
        assert.match(textOf(out), /listing TRUNCATED/);
        const stored = JSON.parse(await readFile(statePath, 'utf8')) as { last_check: string };
        assert.equal(stored.last_check, '2026-07-01');
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('degrades the request total to a floor when the saved-shows listing fails', async () => {
    const h = harness((path) => {
      if (path === '/me/shows') throw quotaError(900);
      throw new Error(`unexpected path ${path}`);
    });

    const out = await h.invoke('whats_new', { since: '2026-08-01', kinds: ['podcasts'] });
    const payload = out.structuredContent as CallPayload;

    // The page count never came back, so it is unknown — NOT zero, and not a
    // total. A request was issued and did cost quota, so the floor counts it.
    assert.equal(payload.lookups.show_listing_pages, null);
    assert.equal(payload.cost.requests, null);
    assert.equal(payload.cost.kind, 'measured_lower_bound');
    assert.equal(payload.cost.requests_floor, 1);
    assert.equal(h.client.calls.length, 1, 'the failed listing request was really issued');
    assert.match(String(payload.cost.requests_note), /floor, not a total/);
    assert.match(textOf(out), /at least 1 request\(s\)/);
  });

  it('charges an album lookup that threw, so a quota wall is never free', async () => {
    const h = harness((path) => {
      if (path === '/me/following') return followedPage(['a1', 'a2'], null);
      if (path === '/artists/a1/albums') return albumsOf('a1', [['alb', 'LP', '2026-08-20']]);
      throw quotaError(600);
    });

    const out = await h.invoke('whats_new', { since: '2026-08-01', kinds: ['albums'] });
    const payload = out.structuredContent as CallPayload;

    assert.equal(payload.quota_hit, true);
    // Two album lookups issued, one read. Counting only the one that returned
    // would report a request the caller never made.
    assert.equal(payload.lookups.artist_album_calls, 2);
    assert.equal(payload.scanned.artists, 1);
    assert.equal(payload.cost.breakdown.album_lookups, 2);
    assert.equal(payload.cost.requests, h.client.calls.length);
  });

  it('reports the paged bound, not a flat +1, on the cooldown gate', async () => {
    const h = harness((path) => {
      if (path === '/me/following') return followedPage(['a1'], null);
      throw new Error(`unexpected path ${path}`);
    });
    h.client.setCooldown(60_000);

    const out = await h.invoke('whats_new', { since: '2026-08-01', max_artists: 60, kinds: ['albums'] });
    const payload = out.structuredContent as { cost: CallPayload['cost']; requests_made: number };

    assert.equal(payload.requests_made, 0, 'the gate issues no requests');
    assert.equal(payload.cost.kind, 'budget_bound');
    assert.equal(payload.cost.albums?.max_listing_pages, 2);
    assert.equal(payload.cost.albums?.max_requests, 62);
    assert.equal(h.client.calls.length, 0);
  });

  it('restates the planned bound on a real call so the next one can be budgeted', async () => {
    const follow = followedListing(60);
    const h = harness((path, params) =>
      path === '/me/following'
        ? follow(params?.after)
        : albumsOf(path.match(/^\/artists\/([^/]+)\//)?.[1] ?? '', [['alb', 'LP', '2026-08-10']]),
    );

    const out = await h.invoke('whats_new', { since: '2026-08-01', max_artists: 60, kinds: ['albums'] });
    const payload = out.structuredContent as CallPayload;

    assert.equal(payload.cost.kind, 'measured');
    assert.equal(payload.cost.planned?.max_requests, 62);
    assert.equal(payload.cost.requests, 62);
  });
});

// ---------------------------------------------------------------------------
// Concurrent watermark writes (#1130)
// ---------------------------------------------------------------------------

describe('watermark write concurrency', () => {
  it('survives concurrent writers sharing one state path', async () => {
    // The flake this pins: writeWatermark went through a FIXED `${target}.tmp`.
    // Two writers on a shared state path both create that file, the first
    // rename moves it away, and the second fails with
    //   ENOENT: rename '<state>.tmp' -> '<state>'
    // The state path defaults to ~/.spotify-mcp/freshness.json, so this is not
    // confined to tests: two server processes, or a server and a CLI run, race
    // on the user's real watermark the same way.
    //
    // A green run of this test proves only that the race did not happen on
    // this attempt, so it fires enough concurrent writers to make interleaving
    // the likely case rather than the lucky one.
    const dir = await mkdtemp(join(tmpdir(), 'freshness-race-'));
    const statePath = join(dir, 'freshness.json');
    try {
      await withEnv({ SPOTIFY_MCP_FRESHNESS_STATE: statePath }, async () => {
        const h = harness((path) => {
          if (path === '/me/following') return followedPage(['a1'], null);
          if (path === '/artists/a1/albums') return albumsOf('a1', [['alb', 'Drop', '2026-08-15']]);
          throw new Error(`unexpected path ${path}`);
        });

        // Every one of these reaches writeWatermark. Before the fix at least
        // one rejected with ENOENT; assert.rejects would not be right here,
        // because the point is that NONE of them may fail.
        const results = await Promise.allSettled(
          Array.from({ length: 16 }, () =>
            h.invoke('whats_new', { since: '2026-08-01', kinds: ['albums'] }),
          ),
        );

        const failures = results.filter((r) => r.status === 'rejected');
        assert.deepEqual(
          failures.map((f) => String((f as PromiseRejectedResult).reason?.message ?? f)),
          [],
          'every concurrent watermark write must succeed',
        );

        // …and the file a writer left behind must be complete, not a torn
        // temp: the last rename wins, and it renames a fully written file.
        const stored = JSON.parse(await readFile(statePath, 'utf8')) as { last_check: string };
        const today = new Date().toISOString().slice(0, 10);
        assert.equal(stored.last_check, today);

        // A unique temp name means a crash cannot leave litter behind for
        // nothing to clean up.
        const leftovers = (await readdir(dir)).filter((f) => f.endsWith('.tmp'));
        assert.deepEqual(leftovers, [], 'no temp files may survive a successful write');
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reclaims a temp stranded under the pre-fix fixed name', async () => {
    // The unique temp name fixes the race, but it also means a crash under
    // the OLD `${target}.tmp` name leaves a file the catch block will never
    // see, because this call did not create it. Every write now clears that
    // name on the way past, the way auth.ts does.
    //
    // Fails without the fix: the stranded file is still there afterwards.
    const dir = await mkdtemp(join(tmpdir(), 'freshness-legacy-'));
    const statePath = join(dir, 'freshness.json');
    const legacy = `${statePath}.tmp`;
    try {
      await writeFile(legacy, 'half-written garbage', 'utf8');
      await withEnv({ SPOTIFY_MCP_FRESHNESS_STATE: statePath }, async () => {
        const h = harness((path) => {
          if (path === '/me/following') return followedPage(['a1'], null);
          if (path === '/artists/a1/albums') return albumsOf('a1', [['alb', 'Drop', '2026-08-15']]);
          throw new Error(`unexpected path ${path}`);
        });
        await h.invoke('whats_new', { since: '2026-08-01', kinds: ['albums'] });
      });

      assert.equal(existsSync(legacy), false, 'the stranded pre-fix temp must be reclaimed');
      const stored = JSON.parse(await readFile(statePath, 'utf8')) as { last_check: string };
      assert.equal(stored.last_check, new Date().toISOString().slice(0, 10), 'the watermark still advanced');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
