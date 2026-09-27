/**
 * Cancellation plumbing for #676: the client, the pagination walk, and the
 * tool-handler seam.
 *
 * The defect this pins: nothing could stop work in flight.
 * `fetchWithTimeout` overwrote any caller signal with its own timeout, no
 * client method accepted an `AbortSignal`, `getAllPages` never checked for a
 * cancellation between pages, and every tool handler ignored the SDK's second
 * `extra` argument carrying the request's abort signal. A cancelled MCP
 * request therefore kept spending the account's quota.
 *
 * The load-bearing assertion in this file is NOT `error.status === 499` or any
 * other flag. A cancellation that reports success while the walk keeps
 * hammering the API is exactly the failure mode the issue describes, so every
 * test here counts the fetches the stub actually served and asserts the count
 * STOPS GROWING after the signal. `cancelled` is proven by the absence of
 * further requests, not by a property of the returned value.
 *
 * Run with: node --import tsx --test tests/cancellation.test.ts
 *
 * NOTE: the token path is resolved per CALL by getTokenFilePath() (#609), so
 * the env vars MUST be set before the dynamic imports below. Tokens are only
 * ever written under os.tmpdir(), and `helpers/hermetic.js` additionally
 * relocates $HOME so no store default can reach the real ~/.spotify-mcp.
 */

import './helpers/hermetic.js';

import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const tokenDir = await mkdtemp(path.join(tmpdir(), 'spotify-mcp-cancel-test-'));
process.env.SPOTIFY_MCP_TOKEN_FILE = path.join(tokenDir, 'tokens.json');
process.env.SPOTIFY_CLIENT_ID = 'cancel-test-client';
// A cap far above every page count used below, so the cap is never what ends a
// walk: only cancellation is.
process.env.SPOTIFY_MCP_FETCH_ALL_CAP = '100000';

const { SpotifyClient, SpotifyApiError } = await import('../src/client.ts');
const { getTokenFilePath } = await import('../src/auth.ts');
const { initConfig } = await import('../src/config.ts');
const { installCancellationContextBoundary, runInCancellationContext, currentRequestSignal } =
  await import('../src/cancellation.ts');

initConfig();

/** The single path the auth store reads and writes; env already points at mkdtemp. */
const TOKEN_PATH = getTokenFilePath();

const realFetch = globalThis.fetch;

/** Pages the stubbed endpoint will serve before it runs dry. */
const TOTAL_PAGES = 40;
const PER_PAGE = 20;

/** Every request the stub actually served, and the offsets it served them for. */
interface Fetches {
  count: number;
  offsets: number[];
  /** Offsets requested at or after `mark()`, i.e. after the signal fired. */
  sinceMark: () => number[];
  mark: () => void;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** What undici's `fetch` throws when its signal aborts. */
function abortError(): Error {
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * A page endpoint that would happily serve `TOTAL_PAGES` pages. Nothing here
 * knows about cancellation: if a walk keeps asking, it keeps getting pages,
 * and the fetch count in `fetches` is the only evidence of whether it stopped.
 */
function pageStub(): Fetches {
  let mark = 0;
  const offsets: number[] = [];
  return {
    get count() {
      return offsets.length;
    },
    offsets,
    sinceMark: () => offsets.slice(mark),
    mark: () => {
      mark = offsets.length;
    },
  };
}

async function seedTokens(): Promise<void> {
  await writeFile(
    TOKEN_PATH,
    JSON.stringify({
      access_token: 'tok-initial',
      refresh_token: 'ref-initial',
      expires_at: Date.now() + 3600_000,
      scope: '',
    }),
    'utf8',
  );
}

describe('#676 cancellation', () => {
  let fetches: Fetches;
  /**
   * When set, the stub holds every page response open until the test calls
   * `releaseGate()`. That is what makes "aborts while a request is in flight"
   * reachable deterministically instead of racing the event loop.
   */
  let gate: Promise<void> | null;
  let releaseGate: (() => void) | null;

  beforeEach(async () => {
    fetches = pageStub();
    gate = null;
    releaseGate = null;
    await rm(TOKEN_PATH, { force: true });
    await seedTokens();
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('accounts.spotify.com')) {
        return jsonResponse({ access_token: 'tok', expires_in: 3600, token_type: 'Bearer' });
      }
      const offset = Number(new URL(href).searchParams.get('offset') ?? 0);
      // Counted on ENTRY, not on return: the request is spent against the
      // account the moment it is dispatched, whether or not a response ever
      // comes back. Counting on return would make a request that was
      // cancelled mid-flight look free, which is precisely the accounting
      // error the issue is about.
      if (offset < TOTAL_PAGES * PER_PAGE) fetches.offsets.push(offset);
      // A real `fetch` REJECTS when its signal aborts, and the abort cuts the
      // response short even if the handler is mid-body. The stub has to do
      // both or it is not modelling the thing under test: without the abort
      // check, an in-flight cancellation would resolve successfully and the
      // "aborting mid-flight rejects" test would be testing the stub.
      const signal = init?.signal;
      if (gate) {
        await Promise.race([
          gate,
          new Promise<void>((_, rej) => {
            if (!signal) return;
            if (signal.aborted) rej(abortError());
            signal.addEventListener('abort', () => rej(abortError()), { once: true });
          }),
        ]);
      }
      if (signal?.aborted) throw abortError();
      if (offset >= TOTAL_PAGES * PER_PAGE) {
        // Past the end. Serving an empty page would end the walk on data
        // grounds, which would hide a walk that ran past its budget.
        return jsonResponse({ items: [], total: TOTAL_PAGES * PER_PAGE, limit: PER_PAGE, offset });
      }
      return jsonResponse({
        items: Array.from({ length: PER_PAGE }, (_, i) => ({ id: `item-${offset + i}` })),
        total: TOTAL_PAGES * PER_PAGE,
        limit: PER_PAGE,
        offset,
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  after(async () => {
    await rm(tokenDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Layer 1 — the client
  // -------------------------------------------------------------------------

  describe('client: an already-aborted signal dispatches no request', () => {
    it('get() rejects without issuing a single fetch', async () => {
      const client = new SpotifyClient({ disableCache: true });
      const ac = new AbortController();
      ac.abort();

      await assert.rejects(
        () => client.get('/me/tracks', { limit: '20' }, { signal: ac.signal }),
        (err: unknown) => {
          assert.ok(err instanceof SpotifyApiError, `expected SpotifyApiError, got ${String(err)}`);
          assert.equal(err.status, 499);
          return true;
        },
      );

      // The whole point: a signal that was already dead when the call was made
      // must cost the account nothing.
      assert.equal(fetches.count, 0, 'an already-aborted signal must dispatch no fetch');
    });

    it('refuses a warm CACHE hit too — a cancelled call returns no result at all', async () => {
      // A TTL-cached read returns before the queue, the token refresh, and the
      // fetch: nothing is dispatched, so the only thing that can stop a
      // cancelled call from being SERVED is the check at the entry of `get`.
      // This is the one behaviour that distinguishes that check from the
      // queue's dropped-task path, which can only refuse work it was given.
      const client = new SpotifyClient({ maxConcurrency: 4 });
      const first = await client.get<{ items: unknown[] }>('/me/tracks', { limit: '20' });
      assert.equal(first?.items.length, PER_PAGE, 'the first read populates the cache');
      assert.equal(fetches.count, 1, 'the warm-up read costs one request');

      const ac = new AbortController();
      ac.abort();

      // Serving the cached body here would be the worst version of this bug:
      // the host asked for nothing, no quota was spent, and it still received
      // a result for work it cancelled.
      await assert.rejects(
        () => client.get('/me/tracks', { limit: '20' }, { signal: ac.signal }),
        (err: unknown) => {
          assert.ok(err instanceof SpotifyApiError, `expected SpotifyApiError, got ${String(err)}`);
          assert.equal(err.status, 499);
          return true;
        },
      );
      assert.equal(fetches.count, 1, 'the cancelled read must not reach the cache or the network');
    });

    it('names the cancellation in the error, so a host is not told to retry', async () => {
      const client = new SpotifyClient({ disableCache: true });
      const ac = new AbortController();
      ac.abort();

      await assert.rejects(
        () => client.get('/me/tracks', { limit: '20' }, { signal: ac.signal }),
        (err: unknown) => {
          assert.ok(err instanceof SpotifyApiError);
          assert.match(err.message, /cancel/i);
          // A timeout is 408 and says "timed out"; conflating the two would
          // tell a caller that gave up on purpose to retry shortly.
          assert.notEqual(err.status, 408);
          return true;
        },
      );
    });
  });

  describe('client: an in-flight abort stops the request and is not retried', () => {
    it('rejects with the cancellation status, and spends exactly one request', async () => {
      const client = new SpotifyClient({ disableCache: true });
      const ac = new AbortController();
      // Hold the response open so the abort lands while the fetch is in flight,
      // the case a post-hoc flag check could never catch.
      gate = new Promise<void>((r) => { releaseGate = r; });

      const pending = client.get('/me/tracks', { limit: '20' }, { signal: ac.signal });
      // Wait for the request to actually reach the stub — not a fixed sleep.
      // The queue holds a 100 ms start gap before dispatching, so a timed wait
      // would race it and sometimes abort before anything was ever sent, which
      // would silently turn this into the already-aborted case.
      for (let i = 0; i < 200 && fetches.count === 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.equal(fetches.count, 1, 'the request must be in flight before the abort lands');
      ac.abort();
      releaseGate!();
      gate = null;

      await assert.rejects(
        () => pending,
        (err: unknown) => {
          assert.ok(err instanceof SpotifyApiError, `expected SpotifyApiError, got ${String(err)}`);
          assert.equal(err.status, 499);
          return true;
        },
      );

      // One request went out and no retry followed it. A cancellation that
      // re-entered the retry ladder would spend MAX_ATTEMPTS against an account
      // whose caller had already walked away.
      assert.equal(fetches.count, 1, `expected exactly 1 request, got ${fetches.count}: ${fetches.offsets}`);
    });

    it('rejects IMMEDIATELY on cancel, without sitting in the retry backoff', async () => {
      const client = new SpotifyClient({ disableCache: true, maxConcurrency: 1 });
      const ac = new AbortController();
      gate = new Promise<void>((r) => { releaseGate = r; });

      const pending = client.get('/me/tracks', { limit: '20' }, { signal: ac.signal });
      for (let i = 0; i < 200 && fetches.count === 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.equal(fetches.count, 1, 'the request must be in flight before the abort lands');

      const abortedAt = Date.now();
      ac.abort();
      releaseGate!();
      gate = null;
      await assert.rejects(() => pending, (err: unknown) => {
        assert.ok(err instanceof SpotifyApiError);
        assert.equal(err.status, 499);
        return true;
      });
      const elapsed = Date.now() - abortedAt;

      // A cancellation that fell through to the transport-failure branch would
      // sleep RETRY_BACKOFF_BASE_MS (250ms) + jitter before the retry was
      // refused — and it would do that INSIDE the serialized queue, holding a
      // permit the whole time. Every other caller pays that delay for a call
      // its own peer abandoned. The fix refuses before the backoff, so this
      // must be immediate. 250ms is the floor of the backoff, so a threshold
      // below it cannot be met by a backoff that happened.
      assert.ok(elapsed < 200, `cancellation must reject without a backoff hold, took ${elapsed}ms`);
    });

    it('leaves a non-aborted call untouched: a plain get still succeeds', async () => {
      const client = new SpotifyClient({ disableCache: true });
      const ac = new AbortController();

      const result = await client.get<{ items: unknown[] }>('/me/tracks', { limit: '20' }, { signal: ac.signal });
      assert.equal(result?.items.length, PER_PAGE);
      assert.equal(fetches.count, 1);
    });
  });

  // -------------------------------------------------------------------------
  // Layer 2 — the pagination walk
  // -------------------------------------------------------------------------

  describe('walk: aborting mid-walk stops further page requests', () => {
    it('stops within one page and leaves no queued work behind', async () => {
      const client = new SpotifyClient({ disableCache: true, maxConcurrency: 4 });
      const ac = new AbortController();
      const pagesServed: number[] = [];

      const walk = client.getAllPages<{ id: string }>(
        '/me/tracks',
        { limit: String(PER_PAGE) },
        {
          signal: ac.signal,
          onPage: (info) => {
            pagesServed.push(info.page);
            // Cancel from a page callback, which is exactly the "between pages"
            // position: the page that just landed is committed, the next one
            // has not been requested.
            if (info.page === 3) ac.abort();
          },
        },
      );

      await assert.rejects(
        () => walk,
        (err: unknown) => {
          assert.ok(err instanceof SpotifyApiError, `expected SpotifyApiError, got ${String(err)}`);
          assert.equal(err.status, 499);
          return true;
        },
      );

      // Mark the signal as fired and prove nothing more arrived afterwards.
      fetches.mark();
      await new Promise((r) => setTimeout(r, 150));

      assert.deepEqual(
        fetches.sinceMark(),
        [],
        `no request may follow the signal; saw offsets ${JSON.stringify(fetches.sinceMark())}`,
      );

      // The walk had 37 pages still ahead of it. It got 3 and stopped.
      assert.ok(
        fetches.count < TOTAL_PAGES,
        `walk must not run to completion: ${fetches.count} requests of ${TOTAL_PAGES} pages`,
      );
      assert.equal(fetches.count, 3, `expected 3 pages served, got ${fetches.count}`);
      assert.deepEqual(pagesServed, [1, 2, 3], 'the walk reports exactly the pages it committed');

      // And the queue is empty: the next caller is not held by a phantom task.
      assert.equal(client.requestsTotal, 3, 'a cancelled walk leaves no queued requests behind');
    });

    it('a signal arriving BETWEEN pages stops at a page boundary, not mid-page', async () => {
      const client = new SpotifyClient({ disableCache: true, maxConcurrency: 4 });
      const ac = new AbortController();
      let page = 0;

      const walk = client.getAllPages<{ id: string }>('/me/tracks', { limit: String(PER_PAGE) }, {
        signal: ac.signal,
        onPage: (info) => {
          page = info.page;
          // Abort AFTER the progress event for page 2 has already been
          // emitted — so the commit for that page is done, and the stop must
          // happen before page 3 is requested.
          if (info.page === 2) ac.abort();
        },
      });

      await assert.rejects(() => walk, (err: unknown) => {
        assert.ok(err instanceof SpotifyApiError);
        assert.equal(err.status, 499);
        return true;
      });

      assert.equal(page, 2, 'the walk stopped after the page that had already been committed');
      assert.equal(fetches.count, 2, `expected 2 page requests, got ${fetches.count}`);
      // The boundary is the point: a partial third page was never requested, so
      // there is no half-built page to mistake for a complete result.
      assert.deepEqual(fetches.offsets, [0, PER_PAGE], 'the walk stops on a page boundary');
    });

    it('does not return a partially-accumulated result that looks complete', async () => {
      const client = new SpotifyClient({ disableCache: true, maxConcurrency: 4 });
      const ac = new AbortController();

      const walk = client.getAllPagesWithTruncation<{ id: string }>(
        '/me/tracks',
        { limit: String(PER_PAGE) },
        { signal: ac.signal, onPage: (info) => { if (info.page === 2) ac.abort(); } },
      );

      // The verdict API is the dangerous one: it returns items plus a
      // `truncated` flag, so a cancelled walk that returned would be read as
      // "2 pages, and that is all of them". It must throw instead.
      await assert.rejects(() => walk, (err: unknown) => {
        assert.ok(err instanceof SpotifyApiError);
        assert.equal(err.status, 499);
        return true;
      });
    });

    it('a task cancelled while QUEUED is never dispatched at all', async () => {
      // maxConcurrency 1: the first call holds the only permit, so the second
      // call is sitting in the LANE when the abort lands. This is the case a
      // check at the walk loop cannot see — the request has not been made
      // yet, so only the queue can stop it.
      const client = new SpotifyClient({ disableCache: true, maxConcurrency: 1 });
      gate = new Promise<void>((r) => { releaseGate = r; });

      const holder = client.get('/me/tracks', { limit: '20' });
      for (let i = 0; i < 200 && fetches.count === 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.equal(fetches.count, 1, 'the first call must hold the permit');

      const ac = new AbortController();
      const queued = client.get('/me/tracks', { limit: '20' }, { signal: ac.signal });
      // Let the queued task actually reach the lane before cancelling it.
      await new Promise((r) => setTimeout(r, 30));
      ac.abort();

      // Release the holder so the permit frees and the cancelled task is
      // dequeued. The order matters: a task can only be dropped when the queue
      // reaches it, so releasing after awaiting the rejection would deadlock
      // against the 30 s request timeout.
      releaseGate!();
      gate = null;
      await holder;
      const afterRelease = fetches.count;

      await assert.rejects(() => queued, (err: unknown) => {
        assert.ok(err instanceof SpotifyApiError, `expected SpotifyApiError, got ${String(err)}`);
        assert.equal(err.status, 499);
        return true;
      });
      await new Promise((r) => setTimeout(r, 200));

      // The load-bearing assertion: the cancelled task spent NOTHING. Not a
      // request (the stub saw none), and not a counted request either — the
      // queue counts a dispatch in `recordRequest()` before the task body
      // runs, so a task that was dequeued and only then refused would inflate
      // the quota figure a caller is told to budget against.
      assert.equal(fetches.count, afterRelease, 'a cancelled queued task must dispatch no request');
      assert.equal(
        client.requestsTotal,
        1,
        `a cancelled queued task must not be counted as issued: requestsTotal=${client.requestsTotal}`,
      );
    });

    it('an uncancelled walk over the same stub still returns every page', async () => {
      const client = new SpotifyClient({ disableCache: true, maxConcurrency: 4 });
      const ac = new AbortController();

      const items = await client.getAllPages<{ id: string }>(
        '/me/tracks',
        { limit: String(PER_PAGE) },
        { signal: ac.signal },
      );

      assert.equal(items.length, TOTAL_PAGES * PER_PAGE, 'a live signal must not truncate anything');
      assert.equal(ac.signal.aborted, false);
    });

    it('omitting the signal entirely still walks to completion', async () => {
      const client = new SpotifyClient({ disableCache: true, maxConcurrency: 4 });

      const items = await client.getAllPages<{ id: string }>('/me/tracks', { limit: String(PER_PAGE) });

      assert.equal(items.length, TOTAL_PAGES * PER_PAGE);
      assert.equal(fetches.count, TOTAL_PAGES);
    });
  });

  // -------------------------------------------------------------------------
  // Layer 3 — the tool-handler seam
  // -------------------------------------------------------------------------

  describe('handler seam: the SDK abort signal reaches the walk', () => {
    it('the ambient context carries the request signal into the client', async () => {
      const client = new SpotifyClient({ disableCache: true, maxConcurrency: 4 });
      const ac = new AbortController();

      // This is the shape a tool handler gets: no explicit signal argument, the
      // request's signal arrives ambiently and must be picked up by the walk.
      const walk = runInCancellationContext(ac.signal, () => {
        assert.equal(currentRequestSignal(), ac.signal, 'the handler sees its own request signal');
        return client.getAllPages<{ id: string }>('/me/tracks', { limit: String(PER_PAGE) }, {
          onPage: (info) => { if (info.page === 2) ac.abort(); },
        });
      });

      await assert.rejects(() => walk, (err: unknown) => {
        assert.ok(err instanceof SpotifyApiError, `expected SpotifyApiError, got ${String(err)}`);
        assert.equal(err.status, 499);
        return true;
      });

      fetches.mark();
      await new Promise((r) => setTimeout(r, 150));

      assert.deepEqual(fetches.sinceMark(), [], 'the ambient signal must stop the walk, not just report it');
      assert.equal(fetches.count, 2, `expected the walk to stop after 2 pages, got ${fetches.count}`);
    });

    it('concurrent walks keep their OWN signal (no cross-talk)', async () => {
      const client = new SpotifyClient({ disableCache: true, maxConcurrency: 4 });
      const a = new AbortController();
      const b = new AbortController();

      const walkA = runInCancellationContext(a.signal, () => client.getAllPages<{ id: string }>(
        '/me/tracks',
        { limit: String(PER_PAGE) },
        { onPage: (info) => { if (info.page === 2) a.abort(); } },
      ));
      const walkB = runInCancellationContext(b.signal, () => client.getAllPages<{ id: string }>(
        '/me/tracks',
        { limit: String(PER_PAGE) },
      ));

      await assert.rejects(() => walkA, (err: unknown) => {
        assert.ok(err instanceof SpotifyApiError);
        assert.equal(err.status, 499);
        return true;
      });

      // Walk B's signal was never aborted, so cancelling A must not truncate B.
      // Sharing one signal across calls is the failure this guards: one
      // cancelled request silently gutting an unrelated one.
      const itemsB = await walkB;
      assert.equal(itemsB.length, TOTAL_PAGES * PER_PAGE, "cancelling walk A must not truncate walk B");
    });

    it('the boundary wrapper installs the SDK extra.signal at the tool seam', async () => {
      // Stand in for the SDK's McpServer: registerTool(name, config, cb), where
      // cb receives (args, extra) and extra.signal is the request's signal.
      const registered: ((args: unknown, extra: unknown) => unknown)[] = [];
      const fakeServer = {
        tool: (...args: unknown[]) => {
          const cb = args[args.length - 1];
          if (typeof cb === 'function') registered.push(cb as (a: unknown, e: unknown) => unknown);
        },
        registerTool: (...args: unknown[]) => {
          const cb = args[args.length - 1];
          if (typeof cb === 'function') registered.push(cb as (a: unknown, e: unknown) => unknown);
        },
      };
      installCancellationContextBoundary(fakeServer as unknown as McpServer);

      const seen: (AbortSignal | undefined)[] = [];
      fakeServer.registerTool('walk_thing', { description: 'x' }, async () => {
        seen.push(currentRequestSignal());
        return 'done';
      });

      assert.equal(registered.length, 1, 'the wrapper must register exactly one handler');
      const ac = new AbortController();
      await registered[0]({}, { signal: ac.signal, _meta: {} });
      assert.deepEqual(seen, [ac.signal], 'the handler runs under the request signal');

      // No signal supplied (a host that never cancels): the context is empty
      // and the handler still runs, rather than throwing on a missing field.
      await registered[0]({}, { _meta: {} });
      assert.deepEqual(seen, [ac.signal, undefined], 'a request with no signal still runs');
    });
  });
});
