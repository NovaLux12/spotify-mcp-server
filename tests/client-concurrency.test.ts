/**
 * Bounded concurrency + the shared rate-limit gate in the request funnel (#892).
 *
 * ## What this file is for
 *
 * `tests/client.test.ts` covers what the funnel does with a request; this file
 * covers how many it has open at once, and what a throttled burst costs the
 * process as a whole. Both failure modes are invisible from a single request's
 * point of view:
 *
 *  - a bound that is never ENFORCED is indistinguishable from no bound at all
 *    until Spotify rate-limits you, so the assertion is on the OBSERVED peak
 *    in flight, not on the fact that the calls returned;
 *  - a bound that is never REACHED is indistinguishable from a bound that is
 *    too tight, so the same test asserts the cap is actually saturated.
 *
 * Together those two make the test unsatisfiable by accident: a client that
 * stays serial fails the "reaches the cap" half, a client with no bound fails
 * the "never exceeds" half.
 *
 * ## Determinism
 *
 * No test here spends real time waiting. `setTimeout` AND `Date` are both
 * mocked, so the gate's pacing arithmetic and the backoff sleeps advance only
 * when the test ticks. The mock `fetch` returns a promise the test resolves by
 * hand, so "a slow request" is something this file decides rather than
 * something it waits out. Timing assertions are made on the mocked clock.
 *
 * Two harness details that are load-bearing rather than incidental:
 *
 *  - `pump` yields through a REAL timer, not `setImmediate`. Node runs the poll
 *    phase between the timers and check phases; yielding only via `setImmediate`
 *    (the check phase) can starve it, and the pending token-file read that
 *    `ensureValidToken` awaits then never lands — the funnel deadlocks and the
 *    test fails on a harness bug it did not write.
 *  - every measured section is preceded by `warmUp`, which pays that same token
 *    read. The tokens are cached on the client afterwards, so the one-off fs
 *    cost cannot land in the middle of the first paced batch and make request
 *    #1 look like it started after the ones queued behind it.
 *
 * ## A note on the issue's "< 200ms" acceptance criterion
 *
 * #892 asks for three concurrent 100ms requests to resolve in under 200ms
 * while ALSO requiring the existing 100ms start-gap pacing test to keep
 * passing. Those two cannot both hold: starts are pinned a minimum 100ms
 * apart, so the third request cannot begin before T+200 and a 100ms fetch
 * cannot finish before T+300. The tests below therefore assert what the bound
 * actually buys — three times the concurrency, and a throttled burst charged
 * one window instead of one per caller — rather than a number that would
 * require deleting the pacing the same issue insists on keeping.
 *
 * Run with: node --import tsx --test tests/client-concurrency.test.ts
 */

import './helpers/hermetic.js';

import { describe, it, before, after, beforeEach, afterEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Env MUST be set before the dynamic import: TOKEN_FILE binds at module load.
const tokenDir = await mkdtemp(path.join(tmpdir(), 'spotify-mcp-concurrency-test-'));
process.env.SPOTIFY_MCP_TOKEN_FILE = path.join(tokenDir, 'tokens.json');
process.env.SPOTIFY_CLIENT_ID = 'test-client-id';

const { SpotifyClient, SpotifyApiError } = await import('../src/client.ts');
const { TOKEN_FILE } = await import('../src/auth.ts');
const { loadConfig, DEFAULT_MAX_CONCURRENCY, MAX_CONCURRENCY_CEILING } =
  await import('../src/config.ts');

/**
 * The REAL `setTimeout`, captured at module load — before any test enables
 * mock timers, so it still reaches the original implementation afterwards.
 * See the header's determinism note for why `pump` needs it.
 */
const realSetTimeout = globalThis.setTimeout;

/** A realistic epoch for the mocked clock. */
const EPOCH = Date.parse('2026-09-26T12:00:00.000Z');

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

async function seedTokens(expiresAt: number): Promise<void> {
  await writeFile(
    TOKEN_FILE,
    JSON.stringify({ access_token: 'tok', refresh_token: 'ref', expires_at: expiresAt }),
    'utf8',
  );
}

/**
 * Advance the mocked clock `steps` increments of `msPerStep`.
 *
 * Stepping rather than ticking once matters: a single large tick fires every
 * due timer at the same instant, which would let a task claim a start slot
 * before the request it was paced behind has run at all.
 */
async function pump(t: TestContext, steps: number, msPerStep = 100): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await new Promise<void>((resolve) => realSetTimeout(resolve, 1));
    t.mock.timers.tick(msPerStep);
  }
}

/**
 * Drive the mocked clock until `work` settles. Awaiting the work directly
 * would deadlock: a throttled or backing-off request waits on a mocked timer
 * that only this function can fire.
 */
async function pumpUntilSettled(
  t: TestContext,
  work: Promise<unknown>,
  maxRounds = 400,
): Promise<void> {
  let done = false;
  // Attaching both handlers also marks the rejection handled, so work that
  // rejects while we pump is not an unhandledRejection.
  work.then(() => { done = true; }, () => { done = true; });
  for (let rounds = 0; rounds < maxRounds && !done; rounds++) await pump(t, 1);
  assert.ok(done, 'the funnel did not settle within the virtual-clock budget');
}

describe('request funnel — bounded concurrency and the shared start gate (#892)', () => {
  const realFetch = globalThis.fetch;
  let responder: (url: string) => Response | Promise<Response>;
  let calls: string[];

  beforeEach(async () => {
    calls = [];
    responder = (url) => jsonResponse({ url });
    await rm(TOKEN_FILE, { force: true });
    globalThis.fetch = (async (url: unknown) => {
      const href = String(url);
      if (href.startsWith('https://accounts.spotify.com/')) {
        return jsonResponse({ access_token: 'tok-refreshed', expires_in: 3600 });
      }
      calls.push(href);
      return responder(href);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  after(async () => {
    await rm(tokenDir, { recursive: true, force: true });
  });

  /** Mock both the timer and the clock, so pacing and backoff are fully virtual. */
  function virtualClock(t: TestContext): void {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: EPOCH });
  }

  /**
   * Pay the one-off token-file read before a measured section runs. Issued
   * against the current `responder`, so tests install their own responder (and
   * reset their counters) afterwards.
   */
  async function warmUp(t: TestContext, client: InstanceType<typeof SpotifyClient>): Promise<void> {
    await pumpUntilSettled(t, client.get('/__warmup').catch(() => null));
  }

  describe('the in-flight bound', () => {
    it('never exceeds the cap, and does reach it', async (t) => {
      virtualClock(t);
      await seedTokens(EPOCH + 3_600_000);

      const CAP = 3;
      const client = new SpotifyClient({ maxConcurrency: CAP });
      await warmUp(t, client);

      // A request that stays open until THIS test releases it: the fetch
      // duration is chosen here, so "slow request" never costs wall time and
      // the peak in flight is a direct reading rather than an inference.
      let inFlight = 0;
      let peak = 0;
      const releases: Array<() => void> = [];
      responder = (url) =>
        new Promise<Response>((resolve) => {
          inFlight++;
          if (inFlight > peak) peak = inFlight;
          releases.push(() => {
            inFlight--;
            resolve(jsonResponse({ url }));
          });
        });

      const paths = ['/a', '/b', '/c', '/d', '/e', '/f', '/g', '/h'];
      let settled = 0;
      const pending = Promise.all(paths.map((p) => client.get(p).then(() => { settled++; })));

      // Let the funnel fill every permit before anything is released.
      await pump(t, 20);
      assert.ok(
        peak <= CAP,
        `observed max in flight ${peak} must never exceed the cap ${CAP}`,
      );
      assert.equal(
        peak,
        CAP,
        `the cap must be REACHED, or this test is not exercising the bound (peak=${peak})`,
      );
      assert.equal(
        client.getRateLimitStatus().inFlight,
        CAP,
        'getRateLimitStatus reports the same count the bound is enforced on',
      );

      // Release a cohort at a time and confirm the pool refills to the cap each
      // round rather than draining to one as permits leak.
      for (let round = 0; round < 100 && settled < paths.length; round++) {
        if (releases.length > 0) for (const release of releases.splice(0)) release();
        await pump(t, 4);
      }
      await pending;

      assert.equal(settled, paths.length, 'every request completed');
      assert.equal(calls.length, paths.length + 1, 'each path fetched once, plus the warm-up');
      assert.ok(
        peak <= CAP,
        `observed max in flight ${peak} must never exceed the cap ${CAP} across the whole run`,
      );
      assert.equal(peak, CAP, 'the bound is saturated, so it is a real bound');
      assert.equal(client.getRateLimitStatus().inFlight, 0, 'every permit was returned');
      assert.equal(
        client.getRateLimitStatus().peakInFlight,
        CAP,
        'the client reports the peak it actually reached',
      );
    });

    it('is strictly serial at maxConcurrency=1 (v1 behaviour preserved)', async (t) => {
      virtualClock(t);
      await seedTokens(EPOCH + 3_600_000);

      const client = new SpotifyClient({ maxConcurrency: 1 });
      await warmUp(t, client);

      let inFlight = 0;
      let peak = 0;
      const releases: Array<() => void> = [];
      responder = (url) =>
        new Promise<Response>((resolve) => {
          inFlight++;
          if (inFlight > peak) peak = inFlight;
          releases.push(() => {
            inFlight--;
            resolve(jsonResponse({ url }));
          });
        });

      const paths = ['/a', '/b', '/c'];
      let settled = 0;
      const pending = Promise.all(paths.map((p) => client.get(p).then(() => { settled++; })));

      await pump(t, 20);
      // Only one request may ever be open. This is the assertion that makes
      // the knob mean "serial", and the one a default-3 client fails.
      assert.equal(peak, 1, 'maxConcurrency=1 keeps exactly one request in flight');

      for (let round = 0; round < 100 && settled < paths.length; round++) {
        if (releases.length > 0) for (const release of releases.splice(0)) release();
        await pump(t, 4);
      }
      await pending;
      assert.equal(peak, 1, 'peak in flight never exceeded one across the whole run');
      assert.equal(calls.length, 4, 'three requests plus the warm-up');
    });

    it('returns the permit on every exit — error, throw and success alike', async (t) => {
      virtualClock(t);
      await seedTokens(EPOCH + 3_600_000);

      responder = (url) => {
        if (url.endsWith('/missing')) return jsonResponse({ error: { message: 'Not found.' } }, 404);
        if (url.endsWith('/explode')) throw new Error('mock responder blew up');
        return jsonResponse({ url });
      };

      const client = new SpotifyClient({ maxConcurrency: 2 });
      await warmUp(t, client);

      // Far more failures than the pool has permits. If a single failure leaked
      // its permit the queue would wedge partway and the trailing requests would
      // never run at all — a pool that shrinks silently, with nothing reporting
      // an error, is the failure mode worth catching.
      const work = Promise.allSettled([
        client.get('/missing'),
        client.get('/explode'),
        client.get('/missing'),
        client.get('/explode'),
        client.get('/ok1'),
        client.get('/ok2'),
        client.get('/ok3'),
      ]);
      await pumpUntilSettled(t, work);
      const results = await work;

      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
      assert.equal(results.filter((r) => r.status === 'rejected').length, 4);
      assert.equal(client.getRateLimitStatus().inFlight, 0, 'no permit was leaked');
      assert.ok(
        client.getRateLimitStatus().peakInFlight <= 2,
        `the bound held while the pool churned through failures (peak=${
          client.getRateLimitStatus().peakInFlight
        })`,
      );
    });

    it('keeps starts a minimum 100ms apart even while several are in flight', async (t) => {
      virtualClock(t);
      await seedTokens(EPOCH + 3_600_000);

      const client = new SpotifyClient({ maxConcurrency: 4 });
      await warmUp(t, client);

      const starts: number[] = [];
      const releases: Array<() => void> = [];
      responder = (url) =>
        new Promise<Response>((resolve) => {
          starts.push(Date.now());
          releases.push(() => resolve(jsonResponse({ url })));
        });

      const paths = ['/a', '/b', '/c', '/d'];
      const work = Promise.all(paths.map((p) => client.get(p)));
      for (let round = 0; round < 100 && releases.length < paths.length; round++) {
        await pump(t, 2);
      }
      for (const release of releases.splice(0)) release();
      await pumpUntilSettled(t, work);
      await work;

      // Pacing is a property of the process, so concurrent launches must not
      // collapse it: bounding concurrency without pacing would just be a burst.
      assert.equal(starts.length, 4, 'all four requests started');
      for (let i = 1; i < starts.length; i++) {
        assert.ok(
          starts[i]! - starts[i - 1]! >= 100,
          `start ${i} at ${starts[i]} must be >=100ms after start ${i - 1} at ${starts[i - 1]}`,
        );
      }
    });
  });

  describe('the 429 shared gate', () => {
    it('charges a burst ONE window, not one window per throttled caller', async (t) => {
      virtualClock(t);
      await seedTokens(EPOCH + 3_600_000);

      const client = new SpotifyClient({ maxConcurrency: 3 });
      await warmUp(t, client);

      const RETRY_AFTER_SEC = 5;
      let apiCount = 0;
      responder = () => {
        apiCount++;
        // Only the first two calls are throttled. The third caller's SUCCESS
        // breaks the streak before it can reach the breaker's trip count, so
        // both throttled callers are re-queued onto the shared gate instead of
        // being refused — which is the case that separates "one shared wait"
        // from "one wait each".
        if (apiCount <= 2) {
          return new Response('', {
            status: 429,
            headers: { 'Retry-After': String(RETRY_AFTER_SEC) },
          });
        }
        return jsonResponse({ ok: true });
      };

      const work = Promise.allSettled([client.get('/a'), client.get('/b'), client.get('/c')]);
      const startedAt = Date.now();
      await pumpUntilSettled(t, work);
      const elapsed = Date.now() - startedAt;
      const results = await work;

      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3, 'all three recovered');
      assert.equal(apiCount, 5, 'two throttled calls, one retry each, plus the third caller');

      // The whole point: the process paid the 5s window ONCE. The serial
      // in-task sleep this replaced cost one window per throttled caller, so
      // this is exactly where the two implementations separate.
      assert.ok(
        elapsed < 2 * RETRY_AFTER_SEC * 1000,
        `a 2-caller burst must cost one ${RETRY_AFTER_SEC}s window, took ${elapsed}ms`,
      );
      assert.ok(
        elapsed >= RETRY_AFTER_SEC * 1000,
        `the shared gate must still honour the full window, took ${elapsed}ms`,
      );
    });

    it('refuses new work without sending it once the streak breaker latches', async (t) => {
      virtualClock(t);
      await seedTokens(EPOCH + 3_600_000);

      const client = new SpotifyClient({ maxConcurrency: 3 });
      await warmUp(t, client);

      let apiCount = 0;
      responder = () => {
        apiCount++;
        return new Response('', { status: 429, headers: { 'Retry-After': '5' } });
      };

      const work = Promise.allSettled([client.get('/a'), client.get('/b'), client.get('/c')]);
      await pumpUntilSettled(t, work);
      const results = await work;

      assert.equal(
        results.filter((r) => r.status === 'rejected').length,
        3,
        'a run of consecutive 429s is answered, not waited out',
      );
      for (const result of results) {
        assert.equal(result.status, 'rejected');
        const err = (result as PromiseRejectedResult).reason as SpotifyApiError;
        assert.ok(err instanceof SpotifyApiError);
        assert.equal(err.status, 429);
        assert.equal(typeof err.retryAfterSec, 'number', 'the caller is told how long to wait');
        assert.ok(err.retryAfterSec! > 0, 'retryAfterSec is a real wait, not zero');
      }
      assert.ok(
        client.getRateLimitStatus().throttleStreak >= 3,
        'the burst recorded a consecutive-429 run',
      );

      // The claim the breaker exists to make: work that arrives while the
      // window is still up is REFUSED, not issued. Asserting on apiCount here
      // rather than on the burst's request count is deliberate — a retry
      // admitted before the streak completed is legitimately in flight, and
      // counting those would pin an implementation detail instead of the rule.
      const issuedBefore = apiCount;
      const late = Promise.allSettled([client.get('/late')]);
      await pumpUntilSettled(t, late);
      const lateResults = await late;
      assert.equal(lateResults[0]!.status, 'rejected', 'a latched breaker answers immediately');
      assert.equal(
        apiCount,
        issuedBefore,
        'the refused request was never sent — no fetch was issued behind the wall',
      );
      const lateErr = (lateResults[0] as PromiseRejectedResult).reason as SpotifyApiError;
      assert.equal(lateErr.status, 429);
      assert.ok(lateErr.retryAfterSec! > 0, 'even a refused call carries the wait');
    });

    it('answers a throttled burst in well under one window, holding no permit to do it', async (t) => {
      virtualClock(t);
      await seedTokens(EPOCH + 3_600_000);

      // Deliberately serial. The breaker can only fail a caller fast if that
      // caller has not already been admitted, and admission is what the bound
      // decides: at concurrency 3 the second and third callers are legitimately
      // in flight and parked at the gate when the streak completes, so they are
      // past the check by the time the wall is proven. That is a race the bound
      // allows, not a defect — but it does mean only the serial funnel shows
      // what the burst costs the process as a whole, which is what this asserts.
      const client = new SpotifyClient({ maxConcurrency: 1 });
      await warmUp(t, client);

      const WINDOW_SEC = 5;
      let apiCount = 0;
      responder = () => {
        apiCount++;
        return new Response('', { status: 429, headers: { 'Retry-After': String(WINDOW_SEC) } });
      };

      const work = Promise.allSettled([client.get('/a'), client.get('/b'), client.get('/c')]);
      const startedAt = Date.now();
      await pumpUntilSettled(t, work);
      const elapsed = Date.now() - startedAt;
      const results = await work;

      assert.equal(
        results.filter((r) => r.status === 'rejected').length,
        3,
        'a run of consecutive 429s is answered, not waited out',
      );
      for (const result of results) {
        const err = (result as PromiseRejectedResult).reason as SpotifyApiError;
        assert.ok(err instanceof SpotifyApiError);
        assert.equal(err.status, 429);
        assert.ok(err.retryAfterSec! > 0, 'even a refused call carries the wait');
      }

      // The load-bearing claim. Each caller arrives, is throttled, and hands
      // its permit back; once the streak proves the wall the rest are refused
      // before a request is issued. So the process pays windows to establish
      // the streak and nothing after that. A caller that instead slept through
      // its own Retry-After inside the request would spend the full attempt
      // budget — three windows — for EVERY caller, while holding the permit
      // for each one, and the three callers here would cost nine windows
      // between them.
      assert.ok(
        apiCount <= 3,
        `the wall must be proven once, not re-paid per caller per attempt: ${apiCount} fetches for 3 callers`,
      );
      assert.ok(
        elapsed < 3 * WINDOW_SEC * 1000,
        `a throttled burst must cost fewer windows than it has callers x attempts, took ${elapsed}ms`,
      );
      assert.equal(
        client.getRateLimitStatus().inFlight,
        0,
        'a refused throttled caller gives its permit back rather than sleeping on it',
      );
    });

    it('resets the consecutive-429 streak when a request settles without a throttle', async (t) => {
      virtualClock(t);
      await seedTokens(EPOCH + 3_600_000);

      const client = new SpotifyClient({ maxConcurrency: 3 });
      await warmUp(t, client);

      // Retry-After: 0 records the streak without parking the process for a
      // real window, which is what isolates the streak bookkeeping itself.
      let throttled = true;
      responder = () =>
        throttled
          ? new Response('', { status: 429, headers: { 'Retry-After': '0' } })
          : jsonResponse({ ok: true });

      const work = Promise.allSettled([client.get('/a'), client.get('/b'), client.get('/c')]);
      await pumpUntilSettled(t, work);
      await work;
      // Each caller's single re-queued attempt is itself throttled, so the
      // exact total is an implementation detail; what matters is that a run
      // was recorded rather than reset by the failures themselves.
      assert.ok(
        client.getRateLimitStatus().throttleStreak >= 3,
        `a burst of consecutive 429s records a streak, got ${
          client.getRateLimitStatus().throttleStreak
        }`,
      );

      throttled = false;
      const recovered = client.get('/ok');
      await pumpUntilSettled(t, recovered);
      assert.deepEqual(await recovered, { ok: true }, 'the client recovered once Spotify did');
      assert.equal(
        client.getRateLimitStatus().throttleStreak,
        0,
        'a settled non-429 clears the streak, so the breaker cannot latch forever',
      );
    });
  });

  describe('SPOTIFY_MCP_MAX_CONCURRENCY configuration', () => {
    it('defaults to 3 and clamps a larger value', () => {
      assert.equal(DEFAULT_MAX_CONCURRENCY, 3);
      assert.equal(loadConfig({}).maxConcurrency, 3);
      assert.equal(loadConfig({ SPOTIFY_MCP_MAX_CONCURRENCY: '1' }).maxConcurrency, 1);
      assert.equal(loadConfig({ SPOTIFY_MCP_MAX_CONCURRENCY: '8' }).maxConcurrency, 8);
      // Unbounded concurrency is the failure this knob exists to prevent, so an
      // absurd value is clamped rather than honoured.
      assert.equal(
        loadConfig({ SPOTIFY_MCP_MAX_CONCURRENCY: '5000' }).maxConcurrency,
        MAX_CONCURRENCY_CEILING,
      );
      // Nonsense falls back to the default rather than disabling the bound.
      assert.equal(loadConfig({ SPOTIFY_MCP_MAX_CONCURRENCY: 'lots' }).maxConcurrency, 3);
      assert.equal(loadConfig({ SPOTIFY_MCP_MAX_CONCURRENCY: '0' }).maxConcurrency, 3);
    });

    it('is the bound the client uses when no explicit override is passed', () => {
      assert.equal(new SpotifyClient().getRateLimitStatus().maxConcurrency, 3);
      assert.equal(new SpotifyClient({ maxConcurrency: 1 }).getRateLimitStatus().maxConcurrency, 1);
    });
  });
});
