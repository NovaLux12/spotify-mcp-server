/**
 * #597 — resource subscriptions: the capability, the notification, and the
 * difference between "this changed" and "I looked again".
 *
 * ## What these tests are built to be able to fail at
 *
 * Every claim in SPEC.md §6 about subscriptions has a test here that fails
 * when the claim stops being true:
 *
 *  - **A change notifies; a re-check does not.** Asserted by counting
 *    notifications across a stretch of identical polls (expect zero) and then
 *    across one differing poll (expect exactly one). A manager that notified on
 *    every tick fails the first; one that never notified fails the second.
 *  - **A failed read is not a change.** A poll whose read throws, and a poll
 *    whose body is not JSON, both leave the baseline alone and send nothing.
 *    The follow-on assertion is the load-bearing one: after the read recovers,
 *    a vector differing from the LAST GOOD one notifies — so a change made
 *    while reads were failing is neither lost nor duplicated.
 *  - **An unbacked subscription is an error, not a promise.** `subscribe` on a
 *    URI outside the watchable set fails with a message naming the set, and
 *    arms nothing.
 *  - **A poll cannot outlive its unsubscribe.** See the leak describe block,
 *    which carries three cases because there are three ways to be inside a
 *    poll when the host changes its mind: between polls, inside a read, and
 *    inside the `await` of a notification it is already sending.
 *  - **The poll re-fetches rather than re-reading a cached body.** Not here —
 *    in `resource-subscriptions-cache.test.ts`, which drives the real client,
 *    because a stubbed `client.get` cannot observe the cache.
 *
 * ## The leak test, and why it has two instruments
 *
 * A poll that keeps running after `resources/unsubscribe` is invisible in a
 * short run and expensive in production: it spends the operator's rate limit on
 * nobody. Instrument 1 is `liveTimers()`, which the manager maintains itself —
 * it catches a cleared map entry whose timer was left armed, but a manager that
 * lied about its own count would satisfy it. Instrument 2 is the client's read
 * counter **stopping** across several further poll intervals, which measures
 * the effect and does not depend on the manager agreeing with itself. Both are
 * mutation-proved.
 *
 * Instrument 1 has a timing subtlety that cost a mutation round to find: a
 * re-armed timer that then fires decrements the live count again on its own
 * (the next `poll` returns immediately on its liveness check), so sampling
 * after the interval has elapsed reports zero whether or not anything was
 * re-armed. The leak cases therefore assert INSIDE the window between a re-arm
 * and the next tick, and use a long poll interval to make that window wide
 * enough to hit.
 *
 * ## The stub
 *
 * One stub with a mutable body map and a mutable failure set, so a test can
 * change a payload *and* make reads fail without swapping `client.get` out
 * from under the failure injection. Per `tests/helpers/stub-client.ts`, an
 * unregistered path throws rather than answering a plausible default, so a
 * poll that read the wrong endpoint is visible rather than silent.
 *
 * ## Hermeticity
 *
 * `import './helpers/hermetic.js'` is the FIRST import, before any server code,
 * because ES module evaluation is hoisted and `src/auth.ts` binds the token
 * file path at module load. The two spawned cases go one level further: they
 * run `src/index.ts` as a child process with `hermeticServerEnv`, so the
 * child's `HOME` and `SPOTIFY_MCP_TOKEN_FILE` are fresh temp paths and the real
 * `~/.spotify-mcp/` is not merely unread by convention but unreachable.
 *
 * Nothing here binds a port. The spawned cases are stdio, and every other case
 * runs over `InMemoryTransport`.
 */
import './helpers/hermetic.js';

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

import { hermeticServerEnv, StdioJsonRpcChild } from './helpers/stdio-child.js';
import { subscriptionPollEnv, subscriptionsEnabled, SUBSCRIPTION_POLL_RANGE } from '../src/config.js';
import { registerReadSurfaces } from '../src/resources/register.js';
import {
  createResourceReadRegistry,
  createSubscriptionManager,
  installSubscriptionHandlers,
  WATCHABLE_RESOURCES,
  type SubscriptionManager,
} from '../src/resources/subscriptions.js';
import type { ResourceReadRegistry } from '../src/resources/subscriptions.js';
import type { SpotifyClient } from '../src/client.js';
import { armFileDeadline, FLEET_FILE_BUDGET_MS } from './helpers/file-deadline.js';

// ---------------------------------------------------------------- the stub

/** A `/me/player` body carrying the fields the vector reads. */
function playerState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    is_playing: true,
    progress_ms: 12_345,
    shuffle_state: false,
    repeat_state: 'off',
    device: { id: 'dev1', name: 'Living Room', type: 'Computer' },
    item: { uri: 'spotify:track:trk1', type: 'track', name: 'Track 1', duration_ms: 200_000 },
    ...overrides,
  };
}

function queueBody(uris: string[]): Record<string, unknown> {
  return {
    currently_playing: { uri: uris[0] ?? 'spotify:track:none' },
    queue: uris.slice(1).map((uri) => ({ uri, type: 'track', name: uri })),
  };
}

function recentlyPlayedBody(rows: Array<{ at: string; uri: string }>): Record<string, unknown> {
  return {
    items: rows.map((row) => ({ played_at: row.at, track: { uri: row.uri }, context: null })),
    cursors: { before: null, after: null },
    next: null,
  };
}

interface Stub {
  client: SpotifyClient;
  reads: ResourceReadRegistry;
  server: McpServer;
  /** Replace one path's body mid-run. */
  set: (path: string, body: unknown) => void;
  /** Make these paths reject, as a 500 or a rate limit would. */
  fail: (paths: readonly string[]) => void;
  /** Every path read since the stub was built, in order. */
  calls: () => readonly string[];
  rateLimit: (status: () => Record<string, unknown>) => void;
}

/**
 * A stub client with the REAL read surface registered against it.
 *
 * The registry is populated by `registerReadSurfaces`, not by hand: a poll has
 * to read through the renderer `resources/read` uses, and a test that
 * registered its own would be testing a read path production does not have.
 */
function makeStub(): Stub {
  const bodies = new Map<string, unknown>([
    ['/me/player', playerState()],
    ['/me/player/queue', queueBody(['spotify:track:trk1', 'spotify:track:trk2'])],
    [
      '/me/player/recently-played',
      recentlyPlayedBody([{ at: '2026-09-27T10:00:00.000Z', uri: 'spotify:track:trk1' }]),
    ],
  ]);
  let failing = new Set<string>();
  const calls: string[] = [];
  let rateLimitStatus = (): Record<string, unknown> => ({
    lastThrottleAt: null,
    retryAfterSec: null,
    cooldownRemainingMs: 0,
  });

  const client = {
    get: async (path: string): Promise<unknown> => {
      calls.push(path);
      if (failing.has(path)) {
        throw Object.assign(new Error(`stubbed read failure for ${path}`), { status: 500 });
      }
      if (!bodies.has(path)) throw new Error(`stubbed client got an unregistered path: ${path}`);
      return bodies.get(path);
    },
    getAllPages: async (): Promise<unknown[]> => [],
    getAllPagesWithTruncation: async () => ({
      items: [],
      truncated: false,
      truncatedByCap: false,
      reportedTotal: null,
    }),
    getRateLimitStatus: () => rateLimitStatus(),
  };

  const reads = createResourceReadRegistry();
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerReadSurfaces(server, client as unknown as SpotifyClient, reads);

  return {
    client: client as unknown as SpotifyClient,
    reads,
    server,
    set: (path, body) => {
      if (path === '/me/rate-limit') {
        rateLimitStatus = () => body as Record<string, unknown>;
        return;
      }
      bodies.set(path, body);
    },
    fail: (paths) => {
      failing = new Set(paths);
    },
    calls: () => [...calls],
    rateLimit: (status) => {
      rateLimitStatus = status;
    },
  };
}

// -------------------------------------------------------------- test harness

const POLL_MS = 15;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for a real condition. The manager's timers are real, so the wait is
 * real time: a fake clock would exercise the scheduler this test wrote rather
 * than the one production runs.
 */
async function until(predicate: () => boolean, what: string, budgetMs = 4_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(4);
  }
  assert.fail(`timed out after ${budgetMs}ms waiting for: ${what}`);
}

interface Managed {
  manager: SubscriptionManager;
  sent: string[];
  sentCount: () => number;
}

/**
 * A manager whose notifications are captured. The default `send` records the
 * URI instead of going on the wire, so a change-count assertion is not
 * entangled with transport behaviour; the two protocol cases below install the
 * SDK's real `sendResourceUpdated` instead and count what a client received.
 */
function makeManager(reads: ResourceReadRegistry, pollMs = POLL_MS, send?: (uri: string) => Promise<void>): Managed {
  const sent: string[] = [];
  const manager = createSubscriptionManager({
    enabled: true,
    pollMs,
    reads,
    send: send ?? (async (uri) => {
      sent.push(uri);
    }),
  });
  return { manager, sent, sentCount: () => sent.length };
}

// ---------------------------------------------------------------- the tests

/**
 * The whole-file bound (#1569).
 *
 * This file spawns real child processes, so a child whose tree still holds an
 * inherited stdio write end can keep this process's `PipeWrap` registered and the
 * loop undrainable — the #1365 failure, which is silent and unbounded because the
 * runner is invoked with no `--test-timeout`. See `helpers/file-deadline.ts`.
 *
 * Armed at module scope, above every hook, because a bound a teardown can clear is
 * not a bound. The timer is `unref`'d, so it cannot itself delay this file.
 */
armFileDeadline({
  label: 'tests/resource-subscriptions.test.ts',
  budgetMs: FLEET_FILE_BUDGET_MS,
  children: () => [],
});

describe('#597 change detection', () => {
  it('a poll that finds no change sends nothing; one that finds a change sends exactly one', async () => {
    const stub = makeStub();
    const h = makeManager(stub.reads);
    try {
      h.manager.subscribe('spotify://player/state');
      // The first read establishes the baseline; it is not a change.
      await until(() => h.manager.snapshot()[0]?.vector !== null, 'the first vector to be read');
      assert.equal(h.sentCount(), 0, 'establishing a baseline notifies nobody');

      // Several idle polls. This is the assertion the whole design exists for:
      // a timer that notifies is a timer wearing a change notification's name.
      await sleep(POLL_MS * 10);
      assert.equal(h.sentCount(), 0, 'an unchanged resource must not produce a notification');

      stub.set('/me/player', playerState({ item: { uri: 'spotify:track:trk2' } }));
      await until(() => h.sentCount() === 1, 'one notification for the change');
      assert.deepEqual(h.sent, ['spotify://player/state']);

      // ...and it settles again: a change is reported once, not on every poll.
      await sleep(POLL_MS * 8);
      assert.equal(h.sentCount(), 1, 'a change is reported once, not once per poll after it');
    } finally {
      h.manager.stopAll();
    }
  });

  it('the playback position alone is NOT a change', async () => {
    // `progress_ms` advances on every read. A vector that included it would
    // notify on every poll; this test is what says it may not.
    const stub = makeStub();
    const h = makeManager(stub.reads);
    try {
      h.manager.subscribe('spotify://player/state');
      await until(() => h.manager.snapshot()[0]?.vector !== null, 'the first vector');
      for (let i = 0; i < 5; i += 1) {
        stub.set('/me/player', playerState({ progress_ms: 60_000 + i * 5_000 }));
        await sleep(POLL_MS * 3);
      }
      assert.equal(h.sentCount(), 0, 'an advancing progress_ms is not a change event');
    } finally {
      h.manager.stopAll();
    }
  });

  it('a paused-and-resumed session, and a shuffle flip, are changes', async () => {
    const stub = makeStub();
    const h = makeManager(stub.reads);
    try {
      h.manager.subscribe('spotify://player/state');
      await until(() => h.manager.snapshot()[0]?.vector !== null, 'the first vector');
      stub.set('/me/player', playerState({ is_playing: false }));
      await until(() => h.sentCount() === 1, 'the pause to notify');

      stub.set('/me/player', playerState({ is_playing: false, shuffle_state: true }));
      await until(() => h.sentCount() === 2, 'the shuffle flip to notify');
      assert.equal(h.sentCount(), 2);
    } finally {
      h.manager.stopAll();
    }
  });

  it('the rate-limit request counters are NOT a change; a new throttle event IS', async () => {
    let throttleAt: number | null = null;
    const stub = makeStub();
    stub.rateLimit(() => ({
      lastThrottleAt: throttleAt,
      retryAfterSec: throttleAt === null ? null : 3,
      cooldownRemainingMs: throttleAt === null ? 0 : 1_500,
      requestsTotal: throttleAt === null ? 100 : 101,
    }));
    const h = makeManager(stub.reads);
    try {
      h.manager.subscribe('spotify://me/rate-limit');
      await until(() => h.manager.snapshot()[0]?.vector !== null, 'the first vector');

      // The counters and the countdown move while nothing is throttled. If the
      // vector included them, this is where a notification would appear.
      await sleep(POLL_MS * 10);
      assert.equal(h.sentCount(), 0, 'request counters that moved are not a throttle event');

      throttleAt = 1_700_000_000_000;
      await until(() => h.sentCount() === 1, 'a notification for the new throttle event');
      assert.deepEqual(h.sent, ['spotify://me/rate-limit']);
    } finally {
      h.manager.stopAll();
    }
  });

  it('consecutive failed reads back off rather than retrying at the base interval', async () => {
    // The reason the backoff exists: a resource the account can never read —
    // a 403 with no Premium, say — would otherwise be polled at the full
    // interval forever, which is a request loop wearing a subscription's name.
    // The cap is a multiple of the interval, so a long enough outage settles
    // into a steady rate rather than growing without bound.
    //
    // Measured by read COUNT over a fixed window, because that is the thing
    // the operator pays for. A poll that kept retrying at the base interval
    // would read `window / POLL_MS` times; one that backs off reads far fewer,
    // and the count is the assertion.
    const stub = makeStub();
    stub.fail(['/me/player']);
    const h = makeManager(stub.reads);
    try {
      h.manager.subscribe('spotify://player/state');
      await until(() => h.manager.snapshot()[0]?.consecutiveFailures === 3, 'three consecutive failures');

      // From here the delay is 8x POLL_MS, then 16x, capped there. Count reads
      // over 30 poll intervals: an un-backed-off poll reads ~30; a backed-off
      // one reads a handful.
      const from = stub.calls().length;
      const WINDOW = POLL_MS * 30;
      await sleep(WINDOW);
      const reads = stub.calls().length - from;
      const unBackedOff = Math.floor(WINDOW / POLL_MS);
      assert.ok(
        reads < unBackedOff / 3,
        `a failing subscription must back off: ${reads} reads in ${WINDOW}ms, and an un-backed-off poll would make ${unBackedOff}`,
      );

      // And it still self-heals: backoff is not a give-up.
      stub.fail([]);
      await until(() => h.manager.snapshot()[0]?.unreadable === false, 'the reads to recover after the outage');
      assert.equal(h.manager.snapshot()[0]?.consecutiveFailures, 0, 'the failure count resets on a successful read');
    } finally {
      h.manager.stopAll();
    }
  });

  it('a failed read sends nothing, leaves the baseline alone, and a later change still notifies once', async () => {
    const stub = makeStub();
    const h = makeManager(stub.reads);
    try {
      h.manager.subscribe('spotify://player/state');
      await until(() => h.manager.snapshot()[0]?.vector !== null, 'the first vector');
      const baseline = h.manager.snapshot()[0]?.vector;

      stub.fail(['/me/player']);
      await until(() => h.manager.snapshot()[0]?.unreadable === true, 'the failed read to be recorded');
      assert.equal(h.sentCount(), 0, 'a failed read is not a change');
      assert.equal(
        h.manager.snapshot()[0]?.vector,
        baseline,
        'a failed read must not overwrite the baseline with something unreadable',
      );
      assert.match(String(h.manager.snapshot()[0]?.lastError), /stubbed read failure/);

      // The change happens WHILE reads are failing.
      stub.fail([]);
      stub.set('/me/player', playerState({ item: { uri: 'spotify:track:trk9' } }));

      // It is reported once: the read recovered and the vector differs from
      // the last GOOD one, so a change made during the outage is neither lost
      // nor delivered twice.
      await until(() => h.sentCount() === 1, 'the change made during the failed reads');
      await sleep(POLL_MS * 8);
      assert.equal(h.sentCount(), 1, 'exactly one notification for the recovered change');
      assert.equal(h.manager.snapshot()[0]?.unreadable, false, 'the subscription recovered');
    } finally {
      h.manager.stopAll();
    }
  });

  it('a body that is not JSON is a failed read, not a change', async () => {
    // `null` is the honest JSON for "no playback state" and IS a state; a body
    // that is not JSON at all is a body nobody read. Conflating the two is how
    // a subscription reports a session that never ended.
    const reads = createResourceReadRegistry();
    reads.register('spotify://player/state', async () => ({
      contents: [{ uri: 'spotify://player/state', text: 'Nothing is currently playing.', mimeType: 'text/plain' }],
    }));
    const h = makeManager(reads);
    try {
      h.manager.subscribe('spotify://player/state');
      await until(() => h.manager.snapshot()[0]?.unreadable === true, 'the unparseable body to be recorded');
      assert.equal(h.sentCount(), 0, 'an unparseable body is not a change');
      assert.equal(h.manager.snapshot()[0]?.vector, null, 'an unreadable first read establishes no baseline');
      assert.match(String(h.manager.snapshot()[0]?.lastError), /not JSON/);
    } finally {
      h.manager.stopAll();
    }
  });

  it('an idle session is JSON, not prose, on the ?format=json spelling', async () => {
    // This pins a BEHAVIOUR CHANGE made for #597 and nothing else: the two
    // `?format=json` renderers used to answer the empty-session branch first,
    // so a host that asked for JSON on an idle account received a `text/plain`
    // sentence. That made the state a subscriber most needs to notice — the
    // one where playback ended — the one state a consumer could not read as
    // JSON, and it is what the change poll reads.
    //
    // `null` is the honest JSON for "the endpoint returned no playback state",
    // and it stays distinct from an object whose `item` is null, which the API
    // does send and which this branch must not swallow.
    const stub = makeStub();
    stub.set('/me/player', null);
    const mcp = new Client({ name: 'tester', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([stub.server.connect(clientTransport), mcp.connect(serverTransport)]);
    try {
      const idle = await mcp.readResource({ uri: 'spotify://player/state?format=json' });
      const idleText = (idle.contents[0] as { text?: string }).text ?? '';
      assert.equal(idle.contents[0]?.mimeType, 'application/json', 'an idle ?format=json read must still be JSON');
      assert.equal(JSON.parse(idleText), null, 'an idle account is JSON null, not a sentence');
      // The prose spelling is unchanged: a host that wants a sentence still
      // gets one, and the reorder did not leak into it.
      const idleProse = await mcp.readResource({ uri: 'spotify://player/state' });
      assert.match((idleProse.contents[0] as { text?: string }).text ?? '', /Nothing is currently playing/);

      // A null ITEM is a different state from no state, and it keeps its
      // object shape — this is the case the reorder must not have merged.
      stub.set('/me/player', playerState({ item: null }));
      const noItem = await mcp.readResource({ uri: 'spotify://player/state?format=json' });
      const parsed = JSON.parse((noItem.contents[0] as { text?: string }).text ?? 'null') as { item: unknown } | null;
      assert.ok(parsed !== null, 'an object with a null item is not the same as no state at all');
      assert.equal(parsed?.item, null);
    } finally {
      await mcp.close();
    }
  });

  it('no active session (204 → null) is a real state, and leaving one notifies', async () => {
    const stub = makeStub();
    stub.set('/me/player', null);
    const h = makeManager(stub.reads);
    try {
      h.manager.subscribe('spotify://player/state');
      await until(() => h.manager.snapshot()[0]?.vector === 'no-session', 'the idle vector to be established');
      assert.equal(h.sentCount(), 0, 'an idle server that stays idle notifies nobody');

      stub.set('/me/player', playerState());
      await until(() => h.sentCount() === 1, 'playback starting to notify');
    } finally {
      h.manager.stopAll();
    }
  });

  it('the queue vector includes order, and a reorder is a change', async () => {
    const stub = makeStub();
    const h = makeManager(stub.reads);
    try {
      h.manager.subscribe('spotify://player/queue');
      await until(() => h.manager.snapshot()[0]?.vector !== null, 'the first queue vector');
      await sleep(POLL_MS * 5);
      assert.equal(h.sentCount(), 0, 'a stable queue is not a change');

      stub.set('/me/player/queue', queueBody(['spotify:track:trk1', 'spotify:track:trk3', 'spotify:track:trk2']));
      await until(() => h.sentCount() === 1, 'a reordered queue to notify');
    } finally {
      h.manager.stopAll();
    }
  });

  it('a new play in recently-played is a change', async () => {
    const stub = makeStub();
    const h = makeManager(stub.reads);
    try {
      h.manager.subscribe('spotify://me/recently-played');
      await until(() => h.manager.snapshot()[0]?.vector !== null, 'the first recently-played vector');
      stub.set(
        '/me/player/recently-played',
        recentlyPlayedBody([
          { at: '2026-09-27T10:05:00.000Z', uri: 'spotify:track:trk2' },
          { at: '2026-09-27T10:00:00.000Z', uri: 'spotify:track:trk1' },
        ]),
      );
      await until(() => h.sentCount() === 1, 'a new play to notify');
    } finally {
      h.manager.stopAll();
    }
  });

  it('every watchable resource is registered as subscribable and names itself in resources/list', async () => {
    const stub = makeStub();
    const client = new Client({ name: 'tester', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([stub.server.connect(clientTransport), client.connect(serverTransport)]);
    try {
      const listed = await client.listResources();
      for (const watchable of WATCHABLE_RESOURCES) {
        const entry = listed.resources.find((r) => r.uri === watchable.uri);
        assert.ok(entry, `${watchable.uri} is watchable but absent from resources/list`);
        const description = entry.description ?? '';
        assert.match(description, /Subscribable/, `${watchable.uri} is watchable but says so nowhere`);
        // The note has to say what is NOT a change, or a host subscribes to a
        // stream it will read as events and there are none.
        assert.match(description, /no change sends nothing|are not change events/);
        // And the renderer a poll would use must actually be registered.
        assert.ok(stub.reads.renderFor(watchable.uri), `${watchable.uri} has no registered reader to poll through`);
      }
    } finally {
      await client.close();
    }
  });
});

// ------------------------------------------------------------------ refusals

describe('#597 refusals', () => {
  it('subscribing to a URI outside the watchable set is an error naming the set, and arms nothing', () => {
    const stub = makeStub();
    const h = makeManager(stub.reads);
    try {
      // A URI the server READS but cannot watch: a TTL-cached library read
      // cannot honestly be polled, and accepting the subscription would be a
      // promise the server cannot keep.
      assert.throws(
        () => h.manager.subscribe('spotify://me/saved/tracks'),
        (err: unknown) => {
          const message = String((err as Error).message);
          assert.match(message, /not a subscribable resource/);
          for (const watchable of WATCHABLE_RESOURCES) {
            assert.ok(message.includes(watchable.uri), `the refusal does not name ${watchable.uri}`);
          }
          return true;
        },
      );
      assert.equal(h.manager.activeCount(), 0);
      assert.equal(h.manager.liveTimers(), 0);
    } finally {
      h.manager.stopAll();
    }
  });

  it('unsubscribing something never subscribed is an error, not a silent success', () => {
    const stub = makeStub();
    const h = makeManager(stub.reads);
    try {
      assert.throws(() => h.manager.unsubscribe('spotify://player/state'), /not currently subscribed/);
      assert.equal(h.manager.liveTimers(), 0);
    } finally {
      h.manager.stopAll();
    }
  });

  it('a repeat subscribe does not arm a second poll', async () => {
    const stub = makeStub();
    const h = makeManager(stub.reads);
    try {
      h.manager.subscribe('spotify://player/state');
      h.manager.subscribe('spotify://player/state');
      assert.equal(h.manager.activeCount(), 1);
      assert.equal(h.manager.liveTimers(), 1, 'one subscription, one armed timer');

      await until(() => h.manager.snapshot()[0]?.vector !== null, 'the first vector');
      // A doubled poll would double the read count. The band is wide enough for
      // timer jitter and tight enough that "two polls" cannot hide inside it.
      const before = stub.calls().length;
      await sleep(POLL_MS * 10);
      const delta = stub.calls().length - before;
      assert.ok(delta >= 3 && delta <= 13, `expected roughly one read per interval in 10, saw ${delta}`);
    } finally {
      h.manager.stopAll();
    }
  });
});

// ------------------------------------------------------------------- leaks

describe('#597 leaks', () => {
  it('an unsubscribe that lands while a change notification is in flight does not re-arm', async () => {
    // The narrow window the check above the `arm` exists for.
    //
    // There is a liveness check BEFORE the read and another before the re-arm.
    // The first one is enough whenever the vector did not change, because the
    // comparison and the (absent) send are synchronous — an unsubscribe cannot
    // land between them. The only way to be inside the poll when the host
    // unsubscribes is the `await send(...)`: a change was found, and the
    // notification is in flight while the host changes its mind. A test that
    // only exercises the unchanged path passes with the second check deleted,
    // which is why this one is built around a slow send on a changed vector.
    //
    // The slow send is what holds the window open; a resolved send would let
    // the unsubscribe land after the re-arm, which is a different order and
    // would be caught by a different assertion.
    const reads = createResourceReadRegistry();
    // A deferred rather than a `let release: (() => void) | null`. Both work at
    // runtime, but TypeScript narrows a `let` assigned only inside a closure
    // back to its initializer, so `release?.()` reads as "not callable" — a
    // type error about a pattern that is correct. A promise and a function
    // declared up front are both visible to the checker.
    let releaseSend: () => void = () => { throw new Error('the send gate was never opened'); };
    const sendInFlight = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let entered = 0;
    reads.register('spotify://player/state', async () => {
      entered += 1;
      return {
        contents: [
          { uri: 'spotify://player/state', text: JSON.stringify(playerState({ item: { uri: `spotify:track:t${entered}` } })), mimeType: 'application/json' },
        ],
      };
    });
    const sentDuringSend: string[] = [];
    let firstSendEntered = false;
    const h = makeManager(reads, POLL_MS, async (uri) => {
      sentDuringSend.push(uri);
      if (!firstSendEntered) {
        firstSendEntered = true;
        await sendInFlight;
      }
    });
    try {
      h.manager.subscribe('spotify://player/state');
      // The first read establishes the baseline; the second finds a change and
      // blocks inside `send`.
      await until(() => firstSendEntered, 'the first change notification to be in flight');
      assert.deepEqual(sentDuringSend, ['spotify://player/state'], 'the change did reach the send');

      h.manager.unsubscribe('spotify://player/state');
      releaseSend();
      await sleep(POLL_MS / 4);
      assert.equal(
        h.manager.liveTimers(),
        0,
        'a poll whose notification was in flight when the host unsubscribed must not re-arm',
      );
      await sleep(POLL_MS * 6);
      assert.equal(entered, 2, 'no read happened after the unsubscribe, so no poll survived it');
      assert.equal(sentDuringSend.length, 1, 'and nothing else notified on the cancelled URI');
    } finally {
      h.manager.stopAll();
    }
  });

  it('a poll does not outlive its unsubscribe', async () => {
    const stub = makeStub();
    const h = makeManager(stub.reads);
    h.manager.subscribe('spotify://player/state');
    h.manager.subscribe('spotify://player/queue');
    await until(() => h.manager.snapshot().every((s) => s.vector !== null), 'both baselines');
    assert.equal(h.manager.liveTimers(), 2, 'two subscriptions, two armed timers');

    h.manager.unsubscribe('spotify://player/state');
    h.manager.unsubscribe('spotify://player/queue');

    // Instrument 1: the manager's own timer count.
    assert.equal(h.manager.liveTimers(), 0, 'unsubscribe must clear the armed timer, not just the map entry');
    assert.equal(h.manager.activeCount(), 0);

    // Instrument 2: the effect. Reads must STOP, not merely stop being
    // reported. A leaked timer the manager had forgotten about would pass
    // instrument 1 and fail here.
    const readsAt = stub.calls().length;
    const sentAt = h.sentCount();
    await sleep(POLL_MS * 15);
    assert.equal(stub.calls().length, readsAt, 'a cancelled subscription must stop reading the API');
    assert.equal(h.sentCount(), sentAt);

    h.manager.stopAll();
  });

  it('an unsubscribe racing an in-flight read does not resurrect the poll', async () => {
    // The read resolves AFTER the unsubscribe. Without a liveness check the
    // late read re-arms the timer, and the subscription holds a live timer
    // for a URI the host explicitly stopped watching.
    //
    // The poll interval here is deliberately LONG, and that is the whole test
    // design. A re-armed timer that then fires is caught by the liveness check
    // at the top of `poll`, so it decrements the live count again on its own:
    // sampling the count after the interval has elapsed reports zero whether
    // or not the timer was ever armed, which is a check that cannot fail. The
    // assertion therefore has to be made INSIDE the window between the re-arm
    // and the next tick, which a long interval makes wide enough to hit.
    const RACE_POLL_MS = 400;
    const reads = createResourceReadRegistry();
    // Deferred rather than a nullable `let`, for the reason given in the leak
    // case above: TypeScript cannot see an assignment made inside a closure
    // and reports the call as impossible.
    let releaseRead: () => void = () => { throw new Error('the read gate was never opened'); };
    const readInFlight = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let entered = 0;
    let firstReadEntered = false;
    reads.register('spotify://player/state', async () => {
      entered += 1;
      if (entered === 1) {
        firstReadEntered = true;
        await readInFlight;
      }
      return {
        contents: [
          { uri: 'spotify://player/state', text: JSON.stringify(playerState()), mimeType: 'application/json' },
        ],
      };
    });
    const h = makeManager(reads, RACE_POLL_MS);
    h.manager.subscribe('spotify://player/state');
    await until(() => firstReadEntered, 'the read to be in flight', RACE_POLL_MS * 5);
    h.manager.unsubscribe('spotify://player/state');
    releaseRead();
    await sleep(RACE_POLL_MS / 8);
    assert.equal(h.manager.liveTimers(), 0, 'the late read must not re-arm the timer');
    // Past the tick, so the assertions above cannot pass by a timer firing.
    await sleep(RACE_POLL_MS * 2);
    assert.equal(entered, 1, 'the cancelled subscription read exactly once and no more');
    assert.deepEqual(h.sent, [], 'a cancelled subscription never notifies, not even for the read in flight');
    assert.equal(h.manager.liveTimers(), 0);
    h.manager.stopAll();
  });

  it('a body with no readable text is a failed read, not a change', async () => {
    // A `blob` content entry carries bytes and no text, so there is nothing to
    // compare. Reading it as "no playback state" would report a session that
    // never ended, and reading it as changed would report on bytes nobody read
    // — the two failure modes are different and the vector must not conflate
    // them with either.
    const reads = createResourceReadRegistry();
    reads.register('spotify://player/state', async () => ({
      contents: [{ uri: 'spotify://player/state', blob: 'AAECAwQFBgcICQ==', mimeType: 'application/octet-stream' }],
    }));
    const h = makeManager(reads);
    try {
      h.manager.subscribe('spotify://player/state');
      await until(() => h.manager.snapshot()[0]?.unreadable === true, 'the unreadable body to be recorded');
      assert.equal(h.sentCount(), 0, 'a body with no text is not a change');
      assert.equal(h.manager.snapshot()[0]?.vector, null, 'an unreadable first read establishes no baseline');
      assert.match(String(h.manager.snapshot()[0]?.lastError), /no readable body/);
    } finally {
      h.manager.stopAll();
    }
  });

  it('closing the transport clears every poll', async () => {
    const stub = makeStub();
    const h = makeManager(stub.reads);
    installSubscriptionHandlers(stub.server, h.manager);
    const client = new Client({ name: 'tester', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([stub.server.connect(clientTransport), client.connect(serverTransport)]);

    h.manager.subscribe('spotify://player/state');
    await until(() => h.manager.snapshot()[0]?.vector !== null, 'the first vector');
    assert.equal(h.manager.liveTimers(), 1);

    // The host disconnects without unsubscribing. Over the HTTP transport
    // (#599) this is the only moment the server can observe, so it has to be
    // the one that stops the poll.
    await client.close();
    await until(() => h.manager.liveTimers() === 0, 'the close hook to clear the poll');
    assert.equal(h.manager.activeCount(), 0);
    const readsAt = stub.calls().length;
    await sleep(POLL_MS * 8);
    assert.equal(stub.calls().length, readsAt, 'a closed session must not keep reading the API');
    h.manager.stopAll();
  });
});

// ------------------------------------------------------- the real protocol

describe('#597 over the real protocol', () => {
  it('a subscribing host receives exactly the spec payload, and unwatchable URIs are rejected', async () => {
    const stub = makeStub();
    // The production `send`: the SDK's own `notifications/resources/updated`,
    // so what arrives is what a host would see, not a captured string.
    const h = makeManager(stub.reads, POLL_MS, (uri) => stub.server.server.sendResourceUpdated({ uri }));
    installSubscriptionHandlers(stub.server, h.manager);

    const client = new Client({ name: 'tester', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([stub.server.connect(clientTransport), client.connect(serverTransport)]);

    const received: Array<{ uri: string; params: Record<string, unknown> }> = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      received.push({ uri: n.params.uri, params: n.params as Record<string, unknown> });
    });

    try {
      // A URI the server serves but does not watch: an error, not a promise.
      await assert.rejects(
        client.subscribeResource({ uri: 'spotify://me/saved/tracks' }),
        (err: unknown) => {
          assert.match(String((err as Error).message), /not a subscribable resource/);
          return true;
        },
      );

      await client.subscribeResource({ uri: 'spotify://player/state' });
      await until(() => h.manager.snapshot()[0]?.vector !== null, 'the first vector');
      await sleep(POLL_MS * 6);
      assert.equal(received.length, 0, 'no notification while nothing changed');

      stub.set('/me/player', playerState({ item: { uri: 'spotify:track:trk7' } }));
      await until(() => received.length === 1, 'the notification for the change');

      // The payload is the spec's `{uri}` and nothing else — the vector is
      // change-detection bookkeeping, not a wire field a spec-validating host
      // would keep.
      assert.deepEqual(Object.keys(received[0]?.params ?? {}).sort(), ['uri']);
      assert.equal(received[0]?.uri, 'spotify://player/state');

      await client.unsubscribeResource({ uri: 'spotify://player/state' });
      assert.equal(h.manager.liveTimers(), 0);
      // Unsubscribing twice is a client bug and says so, rather than the
      // second call reporting a success for a cancellation already made.
      await assert.rejects(
        client.unsubscribeResource({ uri: 'spotify://player/state' }),
        /not currently subscribed/,
      );
    } finally {
      await client.close();
      h.manager.stopAll();
    }
  });

  it('a disabled manager refuses resources/subscribe and names the switch', async () => {
    const stub = makeStub();
    const manager = createSubscriptionManager({
      enabled: false,
      pollMs: POLL_MS,
      reads: stub.reads,
      send: async () => {},
    });
    installSubscriptionHandlers(stub.server, manager);
    const client = new Client({ name: 'tester', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([stub.server.connect(clientTransport), client.connect(serverTransport)]);
    try {
      await assert.rejects(client.subscribeResource({ uri: 'spotify://player/state' }), (err: unknown) => {
        assert.match(String((err as Error).message), /SPOTIFY_MCP_SUBSCRIPTIONS=1/);
        assert.equal((err as { code?: number }).code, -32601, 'a method this server does not implement');
        return true;
      });
      assert.equal(manager.activeCount(), 0);
      assert.equal(manager.liveTimers(), 0);
    } finally {
      await client.close();
    }
  });
});

// ----------------------------------------------------- the advertised surface

/**
 * The `SPOTIFY_MCP_SUBSCRIPTIONS` gate, end to end through the real stdio
 * entry.
 *
 * In-process tests can prove the manager works and cannot prove the server
 * ADVERTISES it: `installResourceSubscriptions` is the only place the
 * capability is registered, and only `src/index.ts` calls it. So the
 * capability claim is asserted where it is made — in the `initialize`
 * response of a spawned process — in both directions, because "advertised when
 * on" alone is satisfied by a server that advertises it unconditionally.
 *
 * The single-line criterion from the issue is asserted over the whole session:
 * every frame the server writes is one JSON object on one line, which is what
 * a line-based reader needs of a notification stream. The frame itself cannot
 * be provoked here without a real Spotify account — a spawned server with a
 * temp token file has no session, so a poll can only fail, and a failed poll
 * correctly notifies nothing — so the payload shape is asserted in-process
 * above, where it is produced by the SDK's own `sendResourceUpdated`.
 */
describe('#597 the advertised capability', () => {
  const REPO_ROOT = join(import.meta.dirname, '..');
  // Long enough that no poll fires during the test: these two cases are about
  // the initialize response and the framing of what is written, and a poll
  // landing mid-assertion would make a framing failure about the wrong frame.
  const NO_POLL = '60000';

  const spawnServer = (label: string, overrides: Record<string, string>): StdioJsonRpcChild =>
    StdioJsonRpcChild.spawn({
      label,
      command: 'node',
      args: ['--import', 'tsx', 'src/index.ts'],
      cwd: REPO_ROOT,
      env: hermeticServerEnv(overrides, label).env,
    });

  interface InitCaps { resources?: { subscribe?: unknown; listChanged?: unknown } }
  const capsOf = (response: { result?: Record<string, unknown> }): InitCaps =>
    (response.result as { capabilities?: InitCaps } | undefined)?.capabilities ?? {};

  it('advertises resources.subscribe only when SPOTIFY_MCP_SUBSCRIPTIONS is set', async () => {
    const on = spawnServer('subs-on', { SPOTIFY_MCP_SUBSCRIPTIONS: '1', SPOTIFY_MCP_SUBSCRIPTION_POLL_MS: NO_POLL });
    const off = spawnServer('subs-off', {});
    try {
      const onCaps = capsOf(await on.initialize('subs-test'));
      assert.equal(onCaps.resources?.subscribe, true, 'the ON session must advertise resources.subscribe');
      // The merge must not have cost the SDK's own flag: a server that dropped
      // `listChanged` while adding `subscribe` broke a different promise.
      assert.equal(onCaps.resources?.listChanged, true, 'adding subscribe must not drop listChanged');
      // And it says so out loud, so an operator can tell a silent poll from a
      // disabled one without reading the capabilities.
      assert.match(on.stderr, /SPOTIFY_MCP_SUBSCRIPTIONS is set/);

      const offCaps = capsOf(await off.initialize('subs-test'));
      assert.equal(offCaps.resources?.subscribe, undefined, 'the default session must not advertise subscribe');
      // The OFF case has to be "unchanged", not "resources are gone" — so the
      // default surface is still there.
      const listed = await off.request('resources/list');
      assert.ok(Array.isArray((listed.result as { resources?: unknown[] }).resources));

      // A host that sends the request anyway gets a clean refusal naming the
      // switch, not a hung request and not a subscription that never fires.
      const refused = await off.request('resources/subscribe', { uri: 'spotify://player/state' });
      assert.equal(refused.error?.code, -32601);
      assert.match(String(refused.error?.message), /SPOTIFY_MCP_SUBSCRIPTIONS=1/);
    } finally {
      await on.dispose();
      await off.dispose();
    }
  });

  it('writes every frame as one JSON object on one line', async () => {
    const child = spawnServer('subs-lines', { SPOTIFY_MCP_SUBSCRIPTIONS: '1', SPOTIFY_MCP_SUBSCRIPTION_POLL_MS: NO_POLL });
    // The helper frames stdout itself and latches a failure on a line it cannot
    // parse, so a bad frame would also fail the run — but it reports its own
    // words. This listener exists so the assertion below can be the one that
    // fails, quoted with the offending line, which is the acceptance criterion
    // written as a check: a reader that splits on newlines must be able to
    // parse every frame. A trailing fragment is a chunk boundary, not a frame,
    // so it is dropped rather than asserted on.
    const lines: string[] = [];
    let tail = '';
    child.child.stdout.on('data', (chunk: Buffer) => {
      const parts = (tail + chunk.toString('utf8')).split('\n');
      tail = parts.pop() ?? '';
      for (const line of parts) if (line.trim().length > 0) lines.push(line);
    });
    try {
      await child.initialize('subs-test');
      await child.request('resources/list');
      // Subscribe over the real transport with the flag on, so the accept path
      // is exercised end to end and not only the refusal path.
      const accepted = await child.request('resources/subscribe', { uri: 'spotify://player/queue' });
      assert.equal(accepted.error, undefined, `subscribe was refused with the flag on: ${JSON.stringify(accepted.error)}`);
      assert.equal((await child.request('resources/unsubscribe', { uri: 'spotify://player/queue' })).error, undefined);
      await sleep(50);

      assert.ok(lines.length > 0, 'the session produced no frames to check');
      for (const line of lines) {
        assert.doesNotThrow(() => JSON.parse(line) as unknown, `a frame that is not one line of JSON: ${line}`);
      }
    } finally {
      await child.dispose();
    }
  });
});

/**
 * #1542 — the production call site has to hand the subscription manager the
 * SAME registry the read surface populated.
 *
 * ## Why this case is here and what the other three in this file cannot see
 *
 * `src/index.ts` builds one registry and passes it twice:
 *
 * ```ts
 * const reads = createResourceReadRegistry();
 * registerReadSurfaces(server, client, reads);
 * installResourceSubscriptions(server, reads);
 * ```
 *
 * Those two calls must share one object, and the parameter on
 * `registerReadSurfaces` is DEFAULTED. Deleting that argument therefore
 * compiles, boots, and advertises the capability exactly as before: the
 * default builds a second registry, the renderers are recorded into an object
 * nobody polls, and `resources/subscribe` is accepted forever and never fires.
 *
 * Nothing else in this file can see it, for three separate reasons:
 *
 *  1. `registerCapabilities({ resources: { subscribe: true } })` is inside
 *     `installResourceSubscriptions`, which the split does not touch — so the
 *     `initialize` assertions above still pass.
 *  2. The two cases above set `NO_POLL` on purpose, and no other spawned case
 *     lets a poll fire, so the split has no observable effect on the wire.
 *  3. The in-process cases hand-build the correct wiring (see `makeStub`),
 *     which is worth having and cannot reach the production call site.
 *
 * So this case is the one that spans the two: it drives the real
 * `src/index.ts` in a child process and lets a poll actually run.
 *
 * ## What it asserts, and what it deliberately does not
 *
 * A spawned server with a temp token file has no Spotify session, so a read
 * CANNOT succeed and a `notifications/resources/updated` can never be
 * provoked — which is why the payload shape is asserted in-process above. A
 * failed poll discloses its reason on stderr, and that reason is the
 * observable, because it is where the two wirings part company:
 *
 *  - one shared registry → the poll finds the renderer and the READ fails:
 *    `could not be read (Not authenticated — no token file at …)`;
 *  - a split registry   → the poll finds nothing at all:
 *    `could not be read (spotify://… has no registered reader; the poll
 *    cannot read it)`.
 *
 * `spotify://me/rate-limit` is the fourth watchable and it reads from local
 * throttle bookkeeping, so under the shared wiring it SUCCEEDS and discloses
 * nothing. That asymmetry is why the assertion is "no poll reported a missing
 * reader" over every URI, and why the wait below settles on a disclosure count
 * rather than on a fixed number of lines.
 */
describe('#1542 the production wiring shares one registry', () => {
  const REPO_ROOT = join(import.meta.dirname, '..');
  // The floor `src/config.ts` clamps to, and the reason this case can exist:
  // a real poll is a quota knob in production, and a test that needed a faster
  // one would otherwise have to weaken that floor. One second is already fast.
  const POLL = '1000';
  const POLL_MS = Number(POLL);
  // Measured on this box at load ~12: boot-to-registration 1.5s, first poll
  // disclosure 1.0s after subscribing, all of them settled by 1.2s. The budget
  // is ~15x that, so a loaded box costs this case time rather than failing it.
  const BUDGET_MS = 30_000;

  const spawnServer = (label: string, overrides: Record<string, string>): StdioJsonRpcChild =>
    StdioJsonRpcChild.spawn({
      label,
      command: 'node',
      args: ['--import', 'tsx', 'src/index.ts'],
      cwd: REPO_ROOT,
      env: hermeticServerEnv(overrides, label).env,
    });

  /** The per-subscription disclosure `poll` writes on its first unreadable read. */
  const disclosures = (text: string): string[] =>
    text.split('\n').filter((line) => line.includes('subscription could not be read'));

  /** The exact clause `poll` uses when the registry it was handed has no renderer. */
  const MISSING_READER = 'has no registered reader';

  it('polls every watchable resource through a reader the read surface registered', async () => {
    const child = spawnServer('subs-one-registry', { SPOTIFY_MCP_SUBSCRIPTIONS: '1', SPOTIFY_MCP_SUBSCRIPTION_POLL_MS: POLL });
    try {
      await child.initialize('subs-test');
      // Every watchable, not one of them: the split empties the whole registry,
      // and a single-URI probe would only prove it for whichever URI it picked.
      for (const watchable of WATCHABLE_RESOURCES) {
        const accepted = await child.request('resources/subscribe', { uri: watchable.uri });
        assert.equal(
          accepted.error,
          undefined,
          `${watchable.uri} was refused with subscriptions on: ${JSON.stringify(accepted.error)}`,
        );
      }

      // Wait for the polls to SETTLE rather than for a fixed sleep. `poll`
      // discloses only on its first consecutive failure and backs off after
      // that, so the count converges: three under the shared wiring (the three
      // that need a token) and four under a split (all four). Waiting for it to
      // stop growing is correct under both, and waiting for a line count would
      // encode the healthy wiring into the harness.
      let seen = -1;
      let unchangedSince = Date.now();
      await until(
        () => {
          const count = disclosures(child.stderr).length;
          if (count !== seen) {
            seen = count;
            unchangedSince = Date.now();
          }
          return seen > 0 && Date.now() - unchangedSince >= 2 * POLL_MS;
        },
        'the subscription polls to disclose their reads and stop disclosing',
        BUDGET_MS,
      );

      // `seen > 0` above is the non-vacuity anchor, and it is load-bearing: an
      // assertion of pure absence would be satisfied just as well by a server
      // that never polled at all, which is the same silent no-op in a different
      // costume. Requiring a poll to have run and disclosed first is what makes
      // the absence below a statement about the registry rather than about the
      // test's timing.
      const missing = disclosures(child.stderr).filter((line) => line.includes(MISSING_READER));
      assert.deepEqual(
        missing,
        [],
        'a poll found no registered reader, so src/index.ts did not hand installResourceSubscriptions '
          + 'the registry registerReadSurfaces populated — subscriptions would be accepted and never fire (#1542):\n'
          + missing.join('\n'),
      );
    } finally {
      await child.dispose();
    }
  });
});

// ------------------------------------------------------------- the env vars

/**
 * The two switches, read the way `src/config.ts` reads them.
 *
 * The clamp is a cost control, not a nicety: 50 ms is fifty reads a second
 * against a shared rate-limit budget, and a server that served the mistyped
 * value would spend the user's quota on it. So the bounds are asserted rather
 * than described — a future edit that drops the clamp is a test failure, not a
 * comment that has quietly stopped matching.
 */
describe('#597 the subscription env vars', () => {
  it('is off unless the flag reads as on, and fails safe on junk', () => {
    for (const value of [undefined, '', '0', 'false', 'no', 'off', 'banana', '  ']) {
      const env = value === undefined ? {} : { SPOTIFY_MCP_SUBSCRIPTIONS: value };
      assert.equal(subscriptionsEnabled(env), false, `SPOTIFY_MCP_SUBSCRIPTIONS=${JSON.stringify(value)}`);
    }
    for (const value of ['1', 'true', 'yes', 'on', 'TRUE']) {
      assert.equal(subscriptionsEnabled({ SPOTIFY_MCP_SUBSCRIPTIONS: value }), true, value);
    }
  });

  it('clamps the poll interval to the documented range and defaults on junk', () => {
    const { minMs, maxMs, defaultMs } = SUBSCRIPTION_POLL_RANGE;
    assert.equal(subscriptionPollEnv({}), defaultMs, 'unset');
    assert.equal(subscriptionPollEnv({ SPOTIFY_MCP_SUBSCRIPTION_POLL_MS: 'banana' }), defaultMs, 'unparseable');
    assert.equal(subscriptionPollEnv({ SPOTIFY_MCP_SUBSCRIPTION_POLL_MS: '' }), defaultMs, 'empty');
    assert.equal(subscriptionPollEnv({ SPOTIFY_MCP_SUBSCRIPTION_POLL_MS: '0' }), minMs, 'zero clamps up');
    assert.equal(subscriptionPollEnv({ SPOTIFY_MCP_SUBSCRIPTION_POLL_MS: '-5000' }), minMs, 'negative clamps up');
    assert.equal(subscriptionPollEnv({ SPOTIFY_MCP_SUBSCRIPTION_POLL_MS: '99999999' }), maxMs, 'absurd clamps down');
    // In range passes through untouched, and the midpoint is not the default —
    // an implementation that always returned `defaultMs` would pass every
    // clamp assertion above and fail only here.
    assert.equal(subscriptionPollEnv({ SPOTIFY_MCP_SUBSCRIPTION_POLL_MS: String((minMs + maxMs) / 2) }), (minMs + maxMs) / 2);
  });
});
