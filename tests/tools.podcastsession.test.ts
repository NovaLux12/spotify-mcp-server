/**
 * Tests for src/tools/podcastsession.ts — podcast session composer (#112
 * idea 3). Stub MCP server + stub SpotifyClient (records every call); no
 * network.
 *
 * Run: node --import tsx --test tests/tools.podcastsession.test.ts
 */

import { describe, it } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import type { SpotifyPaged } from '../src/types/spotify.js';
import { registerPodcastSessionTools } from '../src/tools/podcastsession.js';

// ---------------------------------------------------------------------------
// Stub plumbing (mirrors tests/tools.playlists-following.test.ts)
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
    async post<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'POST', path, arg: body });
      return respond(path, body) as T | null;
    },
    async put<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'PUT', path, arg: body });
      return respond(path, body) as T | null;
    },
    async putRaw(path: string, body: string): Promise<void> {
      calls.push({ method: 'PUT_RAW', path, arg: body });
    },
    async delete<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'DELETE', path, arg: body });
      return respond(path, body) as T | null;
    },
    async getAllPages<T>(
      path: string,
      params?: Record<string, string>,
      opts?: { maxItems?: number; initialOffset?: number },
    ): Promise<T[]> {
      const maxItems = opts?.maxItems ?? 500;
      const all: T[] = [];
      let offset = opts?.initialOffset ?? 0;
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
  return client as unknown as SpotifyClient & {
    calls: RecordedCall[];
    setResponder: (fn: Responder) => void;
  };
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
  registerPodcastSessionTools(fakeServer, client);
  const byName = new Map(registered.map((t) => [t.name, t]));
  return { registered, client, byName };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MIN = 60_000;

let seq = 0;
function ep(opts: {
  name: string;
  duration_ms: number;
  resume_position_ms?: number;
  fully_played?: boolean;
  uri?: string;
}) {
  seq++;
  return {
    added_at: '2026-08-01T00:00:00Z',
    episode: {
      id: `ep${seq}`,
      uri: opts.uri ?? `spotify:episode:${seq}`,
      name: opts.name,
      duration_ms: opts.duration_ms,
      release_date: '2026-07-01',
      explicit: false,
      description: '',
      languages: ['en'],
      ...(opts.resume_position_ms !== undefined || opts.fully_played !== undefined
        ? {
            resume_point: {
              fully_played: Boolean(opts.fully_played),
              resume_position_ms: opts.resume_position_ms ?? 0,
            },
          }
        : {}),
      show: { id: 'show1', name: 'Test Show', uri: 'spotify:show:show1' },
    },
  };
}

/** Saved-episodes responder over a single page. */
function savedEpisodes(items: ReturnType<typeof ep>[]) {
  return (_path: string) =>
    ({ items, limit: items.length, total: items.length, offset: 0 });
}

// ---------------------------------------------------------------------------
// plan_podcast_session
// ---------------------------------------------------------------------------

describe('plan_podcast_session', () => {
  it('packs greedy in order and computes fill percent', async () => {
    // 30 min budget; episodes of 20 + 15 min → only the first two fit (35 > 30).
    const h = harness(
      savedEpisodes([
        ep({ name: 'A', duration_ms: 20 * MIN }),
        ep({ name: 'B', duration_ms: 10 * MIN }),
        ep({ name: 'C', duration_ms: 15 * MIN }),
      ]),
    );
    const res = await h.byName.get('plan_podcast_session')!.handler({ minutes: 30 });

    const sc = res.structuredContent!;
    assert.equal(sc.episodes.length, 2); // C (15 min) would overrun 0 left → stop
    assert.equal(sc.planned_ms, 30 * MIN);
    assert.equal(sc.fill_percent, 100);
    assert.equal(sc.stopped_reason, 'next_episode_exceeds_budget');
    assert.match(res.content[0].text, /100% of 30 min budget/);
  });

  it('exact fit consumes the whole budget', async () => {
    const h = harness(savedEpisodes([ep({ name: 'A', duration_ms: 45 * MIN })]));
    const res = await h.byName.get('plan_podcast_session')!.handler({ minutes: 45 });
    assert.equal(res.structuredContent!.fill_percent, 100);
    assert.equal(res.structuredContent!.planned_ms, 45 * MIN);
  });

  it('skips fully played episodes without consuming budget', async () => {
    const h = harness(
      savedEpisodes([
        ep({ name: 'played', duration_ms: 60 * MIN, fully_played: true }),
        ep({ name: 'fresh', duration_ms: 25 * MIN }),
      ]),
    );
    const res = await h.byName.get('plan_podcast_session')!.handler({ minutes: 30 });
    assert.deepEqual(
      res.structuredContent!.episodes.map((e: { name: string }) => e.name),
      ['fresh'],
    );
    assert.equal(res.structuredContent!.skipped_fully_played, 1);
    assert.equal(res.structuredContent!.planned_ms, 25 * MIN);
  });

  it('subtracts resume position from remaining time', async () => {
    // 40 min episode, listened to 15 min → 25 min remaining fits a 30 min budget.
    const h = harness(
      savedEpisodes([
        ep({ name: 'partial', duration_ms: 40 * MIN, resume_position_ms: 15 * MIN }),
      ]),
    );
    const res = await h.byName.get('plan_podcast_session')!.handler({ minutes: 30 });
    const item = res.structuredContent!.episodes[0];
    assert.equal(item.remaining_ms, 25 * MIN);
    assert.equal(item.resume_position_ms, 15 * MIN);
    assert.equal(res.structuredContent!.planned_ms, 25 * MIN);
    assert.equal(res.structuredContent!.fill_percent, 83);
  });

  it('stops at the first unplayed episode that overruns the budget', async () => {
    const h = harness(
      savedEpisodes([
        ep({ name: 'big', duration_ms: 90 * MIN }),
        ep({ name: 'small-fits', duration_ms: 5 * MIN }),
      ]),
    );
    const res = await h.byName.get('plan_podcast_session')!.handler({ minutes: 30 });
    // Greedy in-order: big overruns → stop; small-fits is never considered.
    assert.equal(res.structuredContent!.episodes.length, 0);
    assert.equal(res.structuredContent!.stopped_reason, 'next_episode_exceeds_budget');
    assert.match(res.content[0].text, /No playable episodes fit/);
  });

  it('json response_format returns the raw plan', async () => {
    const h = harness(savedEpisodes([ep({ name: 'A', duration_ms: MIN })]));
    const res = await h.byName.get('plan_podcast_session')!.handler({
      minutes: 5,
      response_format: 'json',
    });
    const raw = JSON.parse(res.content[0].text);
    assert.equal(raw.episodes.length, 1);
    assert.equal(raw.fill_percent, 20);
  });

  it('rejects minutes outside 1–480', async () => {
    const h = harness();
    assert.throws(() =>
      h.byName.get('plan_podcast_session')!.validate({ minutes: 0 }),
    );
    assert.throws(() =>
      h.byName.get('plan_podcast_session')!.validate({ minutes: 481 }),
    );
  });

  it("kind='shows' reads saved shows then their episode pages", async () => {
    const seen: string[] = [];
    const h = harness((path) => {
      seen.push(path.split('?')[0]);
      if (path === '/me/shows') {
        return {
          items: [{ added_at: '', show: { id: 's1', name: 'Show One', uri: 'spotify:show:s1' } }],
          limit: 50,
          total: 1,
          offset: 0,
        };
      }
      if (path === '/shows/s1/episodes') {
        return {
          items: [
            {
              id: 'e1',
              uri: 'spotify:episode:e1',
              name: 'Show Ep',
              duration_ms: 30 * MIN,
              release_date: '',
              explicit: false,
              description: '',
            },
          ],
          limit: 25,
          total: 1,
          offset: 0,
        };
      }
      return { items: [], total: 0 };
    });
    const res = await h.byName.get('plan_podcast_session')!.handler({ minutes: 60, kind: 'shows' });
    assert.ok(seen.includes('/me/shows'));
    assert.ok(seen.includes('/shows/s1/episodes'));
    assert.ok(!seen.includes('/me/episodes'), 'saved episodes must be skipped for kind=shows');
    assert.equal(res.structuredContent!.episodes[0].name, 'Show Ep');
  });

  it('makes zero mutating calls', async () => {
    const h = harness(
      savedEpisodes([ep({ name: 'A', duration_ms: 10 * MIN })]),
    );
    await h.byName.get('plan_podcast_session')!.handler({ minutes: 15 });
    for (const c of h.client.calls) assert.equal(c.method, 'GET');
  });
});

// ---------------------------------------------------------------------------
// start_podcast_session
// ---------------------------------------------------------------------------

describe('start_podcast_session', () => {
  function startHarness() {
    const fixtures = [
      ep({ name: 'first', duration_ms: 20 * MIN, resume_position_ms: 5 * MIN }),
      ep({ name: 'second', duration_ms: 10 * MIN }),
      ep({ name: 'third', duration_ms: 10 * MIN }),
    ];
    const uris = fixtures.map((f) => f.episode.uri);
    return { ...harness(savedEpisodes(fixtures)), uris };
  }

  const enc = (uri: string): string => uri.replaceAll(':', '%3A');

  it('starts first at its resume point via play+offset, queues the rest in order', async () => {
    const h = startHarness();
    const res = await h.byName.get('start_podcast_session')!.handler({ minutes: 40 });

    const mutators = h.client.calls.filter((c) => c.method !== 'GET');
    // 1 × PUT play + 2 × POST queue
    assert.equal(mutators.length, 3);

    const [play, q1, q2] = mutators;
    assert.equal(play.method, 'PUT');
    assert.equal(play.path, '/me/player/play');
    assert.deepEqual(play.arg, {
      context_uri: 'spotify:show:show1',
      offset: { uri: h.uris[0] },
    });

    assert.equal(q1.method, 'POST');
    assert.match(q1.path, new RegExp(`uri=${enc(h.uris[1])}`));
    assert.equal(q2.method, 'POST');
    assert.match(q2.path, new RegExp(`uri=${enc(h.uris[2])}`));

    // Call order across ALL recorded calls: play before both queues.
    const kinds = h.client.calls.map((c) => `${c.method} ${c.path.split('?')[0]}`);
    assert.ok(kinds.indexOf('PUT /me/player/play') < kinds.indexOf('POST /me/player/queue'));

    assert.match(res.content[0].text, /resume position/);
    assert.equal(res.structuredContent!.ok, true);
  });

  it('unresumable first episode queues everything without a PUT play', async () => {
    const first = ep({ name: 'first', duration_ms: 10 * MIN });
    const second = ep({ name: 'second', duration_ms: 10 * MIN });
    const h = harness(savedEpisodes([first, second]));
    await h.byName.get('start_podcast_session')!.handler({ minutes: 30 });
    const mutators = h.client.calls.filter((c) => c.method !== 'GET');
    assert.equal(mutators.filter((c) => c.method === 'PUT').length, 0);
    assert.equal(mutators.filter((c) => c.method === 'POST').length, 2);
    assert.match(mutators[0].path, new RegExp(`uri=${enc(first.episode.uri)}`));
    assert.match(mutators[1].path, new RegExp(`uri=${enc(second.episode.uri)}`));
  });

  it('dry_run performs reads only — zero mutating calls', async () => {
    const h = startHarness();
    const res = await h.byName.get('start_podcast_session')!.handler({
      minutes: 40,
      dry_run: true,
    });
    for (const c of h.client.calls) assert.equal(c.method, 'GET');
    assert.equal(res.structuredContent!.ok, true);
    assert.equal(res.structuredContent!.dry_run, true);
    assert.match(res.content[0].text, /\[dry run\]/);
    assert.ok(res.content[0].text.includes(`queue ${h.uris[1]}`));
    assert.match(res.content[0].text, /nothing was changed/);
  });

  it('passes device_id through on play and queue paths', async () => {
    const h = startHarness();
    await h.byName.get('start_podcast_session')!.handler({ minutes: 40, device_id: 'dev9' });
    const mutators = h.client.calls.filter((c) => c.method !== 'GET');
    assert.equal(mutators[0].path, '/me/player/play?device_id=dev9');
    for (const q of mutators.slice(1)) {
      assert.match(q.path, /^\/me\/player\/queue\?.*device_id=dev9/);
    }
  });

  it('no device_id keeps device-scoped parameters off every path', async () => {
    const h = startHarness();
    await h.byName.get('start_podcast_session')!.handler({ minutes: 40 });
    for (const c of h.client.calls) {
      assert.ok(!c.path.includes('device_id'), `unexpected device_id in ${c.path}`);
    }
  });

  it('documents the queue-seek limitation in its description', () => {
    const h = startHarness();
    const desc = h.registered.find((t) => t.name === 'start_podcast_session')!.description;
    assert.match(desc, /cannot apply resume offsets when queueing/i);
    assert.match(desc, /from the beginning|play from the start/i);
  });

  it('does nothing mutating when nothing fits', async () => {
    const h = harness(savedEpisodes([ep({ name: 'huge', duration_ms: 400 * MIN })]));
    const res = await h.byName.get('start_podcast_session')!.handler({ minutes: 30 });
    assert.equal(h.client.calls.filter((c) => c.method !== 'GET').length, 0);
    assert.equal(res.structuredContent!.ok, false);
  });
});
