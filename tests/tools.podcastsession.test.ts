/**
 * Tests for src/tools/podcastsession.ts — podcast session composer (#112
 * idea 3). Stub MCP server + stub SpotifyClient (records every call); no
 * network.
 *
 * Run: node --import tsx --test tests/tools.podcastsession.test.ts
 */

import './helpers/hermetic.js';

import { afterEach, beforeEach, describe, it } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StubFromResponder } from './helpers/stub-client.js';
import type { LegacyResponder } from './helpers/stub-client.js';
import type { SpotifyPaged } from '../src/types/spotify.js';
import { initConfig } from '../src/config.js';
import { registerPodcastSessionTools, resetProfileCountryCache } from '../src/tools/podcastsession.js';

// ---------------------------------------------------------------------------
// Stub plumbing (mirrors tests/tools.playlists-following.test.ts)
// ---------------------------------------------------------------------------

interface RecordedCall {
  method: 'GET' | 'POST' | 'PUT' | 'PUT_RAW' | 'DELETE';
  path: string;
  arg?: unknown;
}

// The harness responder IS the shared stub's `LegacyResponder`. Declaring a
// narrower local signature instead forced the three `as LegacyResponder` casts
// at the construction site below — casts of a type the value already had.
type Responder = LegacyResponder;

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

/**
 * A tool result whose `structuredContent` has been PROVED present.
 *
 * Both tools here return through a payload-attaching emitter, so the
 * optional in {@link RegisteredTool} is MCP's wire shape rather than a fact
 * about these tools. `byName` proves it once (see `harness`), which is what
 * lets the payload reads below be reads of a field rather than of a promise
 * the compiler cannot check.
 */
type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent: Record<string, unknown>;
};

/**
 * `payload.episodes` as an array, naming the field when it is not one.
 *
 * The planner's rows are read with `.length`, `[0]` and `.map`; off an
 * untyped payload each of those is a read of `unknown`, and a payload that
 * carried no `episodes` at all would have failed with a `TypeError` naming
 * nothing. An absent row array is UNANSWERED, not empty (#803).
 */
function episodesAt(payload: Record<string, unknown>): unknown[] {
  const rows = payload.episodes;
  assert.ok(Array.isArray(rows), `payload.episodes should be an array, got ${typeof rows}`);
  return rows;
}

/** Narrow an `unknown` to a record, naming the row when it is not one. */
function recordOf(value: unknown, label: string): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label} should be an object, got ${value === null ? 'null' : typeof value}`,
  );
  return value as Record<string, unknown>;
}

function makeStubClient(responder: Responder = () => null) {
  // #659: the shared stub. `getAllPages` is INHERITED from SpotifyClient, so the
  // cap comes from `getConfig().fetchAllCap` and the short-page / total breaks
  // are the production ones. This file's hand-copied loop (hardcoded `?? 500`)
  // could not catch a regression in any of that.
  const client = new StubFromResponder(responder, {
    writes: {
    POST: responder,
    PUT: responder,
    DELETE: responder,
    // The old putRaw recorded the upload and answered nothing — a real 202.
    PUT_RAW: () => undefined,
    },
  });
  return { calls: client.calls, client };
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
  registerPodcastSessionTools(fakeServer, stub.client);
  // The map's handlers PROVE `structuredContent` rather than leaving each call
  // site to write `!`. The field is optional on the wire; it is not optional
  // here, and a tool that stopped populating it should fail by name.
  const byName = new Map(
    registered.map((t) => [
      t.name,
      {
        ...t,
        handler: async (args: Record<string, unknown>): Promise<ToolResult> => {
          const res = await t.handler(args);
          assert.ok(res.structuredContent, `tool "${t.name}" returned no structuredContent`);
          return { ...res, structuredContent: res.structuredContent };
        },
      },
    ]),
  );
  return { registered, client: stub.client, byName };
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

    const sc = res.structuredContent;
    assert.equal(episodesAt(sc).length, 2); // C (15 min) would overrun 0 left → stop
    assert.equal(sc.planned_ms, 30 * MIN);
    assert.equal(sc.fill_percent, 100);
    assert.equal(sc.stopped_reason, 'budget_filled');
    assert.match(res.content[0].text, /100% of 30 min budget/);
  });

  it('exact fit consumes the whole budget and reports budget filled', async () => {
    const h = harness(savedEpisodes([ep({ name: 'A', duration_ms: 45 * MIN })]));
    const res = await h.byName.get('plan_podcast_session')!.handler({ minutes: 45 });
    assert.equal(res.structuredContent.fill_percent, 100);
    assert.equal(res.structuredContent.planned_ms, 45 * MIN);
    assert.equal(res.structuredContent.stopped_reason, 'budget_filled');
    assert.match(res.content[0].text, /budget filled/i);
    assert.doesNotMatch(res.content[0].text, /exceeds/i);
  });

  it('reports scan-cap exhaustion when a truncated candidate set leaves budget', async () => {
    initConfig({ ...process.env, SPOTIFY_MCP_FETCH_ALL_CAP: '2' });
    try {
      const h = harness(savedEpisodes([
        ep({ name: 'A', duration_ms: 10 * MIN }),
        ep({ name: 'B', duration_ms: 10 * MIN }),
        ep({ name: 'C', duration_ms: 10 * MIN }),
      ]));
      const res = await h.byName.get('plan_podcast_session')!.handler({ minutes: 40 });
      assert.equal(res.structuredContent.candidates_truncated, true);
      assert.equal(res.structuredContent.stopped_reason, 'scan_cap_reached');
      assert.match(res.content[0].text, /stopped at scan cap \(2\)/);
      const fullButNotTruncated = harness(savedEpisodes([
        ep({ name: 'A', duration_ms: 10 * MIN }),
        ep({ name: 'B', duration_ms: 10 * MIN }),
      ]));
      const fullRes = await fullButNotTruncated.byName.get('plan_podcast_session')!.handler({ minutes: 40 });
      assert.equal(fullRes.structuredContent.candidates_truncated, false);
      assert.equal(fullRes.structuredContent.stopped_reason, 'candidates_exhausted');
    } finally {
      initConfig();
    }
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
      episodesAt(res.structuredContent).map((e) => recordOf(e, 'episodes[]').name),
      ['fresh'],
    );
    assert.equal(res.structuredContent.skipped_fully_played, 1);
    assert.equal(res.structuredContent.planned_ms, 25 * MIN);
  });

  it('subtracts resume position from remaining time', async () => {
    // 40 min episode, listened to 15 min → 25 min remaining fits a 30 min budget.
    const h = harness(
      savedEpisodes([
        ep({ name: 'partial', duration_ms: 40 * MIN, resume_position_ms: 15 * MIN }),
      ]),
    );
    const res = await h.byName.get('plan_podcast_session')!.handler({ minutes: 30 });
    const item = recordOf(episodesAt(res.structuredContent)[0], 'episodes[0]');
    assert.equal(item.remaining_ms, 25 * MIN);
    assert.equal(item.resume_position_ms, 15 * MIN);
    assert.equal(res.structuredContent.planned_ms, 25 * MIN);
    assert.equal(res.structuredContent.fill_percent, 83);
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
    assert.equal(episodesAt(res.structuredContent).length, 0);
    assert.equal(res.structuredContent.stopped_reason, 'next_episode_exceeds_budget');
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
    assert.equal(recordOf(episodesAt(res.structuredContent)[0], 'episodes[0]').name, 'Show Ep');
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
    assert.equal(res.structuredContent.ok, true);
    assert.equal(res.structuredContent.queued, 2);
    assert.deepEqual(res.structuredContent.failed, []);
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

  it('accounts for every URI when all queue writes succeed', async () => {
    const fixtures = Array.from({ length: 4 }, (_, index) =>
      ep({ name: `episode-${index + 1}`, duration_ms: 10 * MIN }),
    );
    const h = harness(savedEpisodes(fixtures));
    const res = await h.byName.get('start_podcast_session')!.handler({ minutes: 40 });
    assert.equal(h.client.calls.filter((call) => call.method === 'POST').length, 4);
    assert.equal(res.structuredContent.queued, 4);
    assert.equal(res.structuredContent.queue_total, 4);
    assert.deepEqual(res.structuredContent.failed, []);
    assert.match(res.content[0].text, /Queue result: 4\/4 queued/);
  });

  it('continues after a queue failure and reports the failing URI', async () => {
    const fixtures = Array.from({ length: 4 }, (_, index) =>
      ep({ name: `episode-${index + 1}`, duration_ms: 10 * MIN }),
    );
    const failingUri = fixtures[1].episode.uri;
    const h = harness((path) => {
      if (path === '/me/episodes') {
        return { items: fixtures, limit: fixtures.length, total: fixtures.length, offset: 0 };
      }
      if (path.startsWith('/me/player/queue?')) {
        const uri = new URL(path, 'https://spotify.test').searchParams.get('uri');
        if (uri === failingUri) throw Object.assign(new Error('slow down'), { status: 429 });
      }
      return null;
    });
    const res = await h.byName.get('start_podcast_session')!.handler({ minutes: 40 });
    const failed = res.structuredContent.failed as Array<{ uri: string; reason: string }>;
    assert.equal(h.client.calls.filter((call) => call.method === 'POST').length, 4);
    assert.equal(res.structuredContent.queued, 3);
    assert.equal(res.structuredContent.queue_total, 4);
    assert.equal(res.structuredContent.ok, false);
    assert.equal(res.structuredContent.dominant_cause, '429 rate limited');
    assert.deepEqual(failed, [{ uri: failingUri, reason: '429 rate limited: slow down' }]);
    assert.match(res.content[0].text, /Queue result: 3\/4 queued/);
    assert.ok(res.content[0].text.includes(failingUri));
    assert.match(res.content[0].text, /429 rate limited/);
  });

  it('dry_run performs reads only — zero mutating calls', async () => {
    const h = startHarness();
    const res = await h.byName.get('start_podcast_session')!.handler({
      minutes: 40,
      dry_run: true,
    });
    for (const c of h.client.calls) assert.equal(c.method, 'GET');
    assert.equal(res.structuredContent.ok, true);
    assert.equal(res.structuredContent.dry_run, true);
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
    assert.equal(res.structuredContent.ok, false);
  });
});

// ---------------------------------------------------------------------------
// #782 — the saved-show walk reads /shows/{id}/episodes, which is market-gated
// and used to send no market at all.
// ---------------------------------------------------------------------------

/** One saved show with one recent episode; `meCountry` is what /me reports. */
function showPlanHarness(meCountry?: string) {
  return harness((path) => {
    if (path === '/me') return { id: 'usr1', country: meCountry };
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
            duration_ms: 20 * MIN,
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
}

/** The parameters the show-episode read actually went out with. */
function showEpisodeRead(client: { calls: RecordedCall[] }): Record<string, string> {
  const read = client.calls.find((c) => c.path === '/shows/s1/episodes');
  assert.ok(read, 'the saved-show episode read happened');
  return (read.arg ?? {}) as Record<string, string>;
}

describe('saved-show market default (#782)', () => {
  beforeEach(() => {
    // Memoised process-wide: one test's /me answer would otherwise become
    // every later test's default market.
    resetProfileCountryCache();
  });

  afterEach(() => {
    delete process.env.SPOTIFY_MCP_MARKET;
    initConfig(process.env);
    resetProfileCountryCache();
  });

  it('defaults the show-episode request to the account country', async () => {
    const h = showPlanHarness('GB');

    const res = await h.byName.get('plan_podcast_session')!.handler({ minutes: 40, kind: 'shows' });

    // Asserted on what the fake client received, not on a value recomputed
    // from the handler.
    assert.equal(showEpisodeRead(h.client).market, 'GB');
    assert.equal(res.structuredContent.market, 'GB');
    assert.equal(res.structuredContent.market_source, 'account');
  });

  it('an explicit market argument wins, and does not fall through to the account', async () => {
    const h = showPlanHarness('GB');

    const res = await h.byName
      .get('plan_podcast_session')!
      .handler({ minutes: 40, kind: 'shows', market: 'DE' });

    // Not vacuous: the account country is a different code, and a lookup that
    // merely echoed the argument would also have to be the thing that skipped /me.
    assert.equal(showEpisodeRead(h.client).market, 'DE');
    assert.equal(h.client.calls.filter((c) => c.path === '/me').length, 0);
    assert.equal(res.structuredContent.market, 'DE');
    assert.equal(res.structuredContent.market_source, 'argument');
  });

  it('prefers SPOTIFY_MCP_MARKET over the account country', async () => {
    process.env.SPOTIFY_MCP_MARKET = 'JP';
    initConfig(process.env);
    const h = showPlanHarness('GB');

    const res = await h.byName.get('plan_podcast_session')!.handler({ minutes: 40, kind: 'shows' });

    assert.equal(showEpisodeRead(h.client).market, 'JP');
    assert.equal(h.client.calls.filter((c) => c.path === '/me').length, 0);
    assert.equal(res.structuredContent.market_source, 'config');
  });

  it('with nothing to default from, sends no market and says the plan is unscoped', async () => {
    const h = showPlanHarness();

    const res = await h.byName.get('plan_podcast_session')!.handler({ minutes: 40, kind: 'shows' });

    // The parameter is genuinely absent, not defaulted to a placeholder.
    assert.equal('market' in showEpisodeRead(h.client), false);
    assert.equal(res.structuredContent.market, null);
    assert.equal(res.structuredContent.market_source, 'none');
  });

  it('reports no market for a saved-episodes-only plan, which reads no gated endpoint', async () => {
    const h = showPlanHarness('GB');

    const res = await h.byName.get('plan_podcast_session')!.handler({ minutes: 40 });

    assert.equal(h.client.calls.filter((c) => c.path === '/shows/s1/episodes').length, 0);
    // Echoing GB here would claim a scoping no request carried.
    assert.equal('market' in res.structuredContent, false);
  });

  it('start_podcast_session applies the same default on the show walk', async () => {
    const h = showPlanHarness('GB');

    const res = await h.byName
      .get('start_podcast_session')!
      .handler({ minutes: 40, kind: 'shows', dry_run: true });

    assert.equal(showEpisodeRead(h.client).market, 'GB');
    assert.equal(res.structuredContent.market_source, 'account');
  });

  it('rejects an unassigned market code locally, before any request', async () => {
    const h = showPlanHarness('GB');
    const tool = h.byName.get('plan_podcast_session')!;

    assert.throws(() => tool.validate({ minutes: 40, kind: 'shows', market: 'XX' }), /ISO 3166-1/);
    assert.deepEqual(h.client.calls, []);
  });
});
