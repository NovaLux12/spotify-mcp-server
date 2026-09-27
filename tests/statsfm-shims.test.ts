/**
 * One stats.fm HTTP client (#907) — consolidation, and the guard that keeps it
 * one.
 *
 * The defect was never a wrong calculation. It was structural: three parallel
 * stacks each held their own base-URL constant and their own transport, so the
 * timeout, the retry and the cache that already existed in
 * `src/lib/statsfm-client.ts` applied to a minority of the reads, and the
 * ~124 KB `/users/{u}/streams` page that ~ten taste tools all want was
 * downloaded once per tool. Nothing downstream of a tool can observe that; a
 * behavioural test can only cover the call sites its author happened to invoke.
 * So this file is both:
 *
 *   - behavioural: the acceptance criteria from the issue, driven through the
 *     real registrars (one `/streams` request for two tools, a timeout instead
 *     of a hang, one retry after the advertised Retry-After, identical error
 *     shape from both tool modules); and
 *   - a source-scanning guard over every file in `src/`, so the call sites
 *     nobody wrote a test for are covered too.
 *
 * Every guard here has an explicit anti-vacuity test: a scanner that silently
 * stops matching would leave the real assertion passing for the wrong reason,
 * and a test that cannot fail is worse than no test (AGENTS.md §6).
 *
 * Zero network: every client below is built with an injected `fetchFn` or an
 * injected parsed-payload seam.
 */

import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { initConfig } from '../src/config.js';
import {
  StatsfmApiError,
  StatsfmClient,
  __resetStatsfmClient,
  __resetStatsfmSleepImpl,
  __setStatsfmClient,
  __setStatsfmSleepImpl,
  statsfmClient,
} from '../src/lib/statsfm-client.js';
import {
  registerStatsfmTasteTools,
  __resetStatsfmFetchImpl,
  __setStatsfmFetchImpl,
} from '../src/tools/statsfm_taste.js';
import {
  registerTasteCompositeTools,
  __resetTasteCompositeFetchImpl,
  __setTasteCompositeFetchImpl,
} from '../src/tools/taste_composites.js';
// Reused from the `as any` gate: blanks comments and string-literal bodies so
// a scan sees code, not prose. Without it, the prose in the files this guard
// reads — and in this one — would match its own patterns.
import { blankNonCode } from '../scripts/check-no-explicit-any.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const BASE_LITERAL = 'https://api.stats.fm';

// ------------------------------------------------------------------ harness

type ToolContent = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type RegisteredTool = {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<ToolContent>;
};

type Server = Parameters<typeof registerStatsfmTasteTools>[0];
type TasteArgs = Parameters<typeof registerStatsfmTasteTools>[1];

/**
 * Register BOTH stats.fm tool modules into one handler table, so a test can
 * drive a `statsfm_taste_*` tool and a `taste_*` composite back to back and
 * watch what the shared client does with the reads in between.
 */
function makeHarness(): { find: (name: string) => RegisteredTool } {
  const registered: RegisteredTool[] = [];
  const server = {
    tool: (
      name: string,
      _description: string,
      _schema: unknown,
      handler: (args: Record<string, unknown>) => Promise<ToolContent>,
    ) => registered.push({ name, handler }),
  };
  registerStatsfmTasteTools(server as unknown as Server, {} as unknown as TasteArgs);
  registerTasteCompositeTools(server as unknown as Server, {} as unknown as TasteArgs);
  return {
    find: (name: string) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `expected ${name} to be registered`);
      return tool;
    },
  };
}

function streamRow(id: string, name: string, artist: string, playedAt: string) {
  return {
    id,
    track: { id, name, artists: [{ name: artist }] },
    playedAt,
  };
}

function fixturePayload(url: string): unknown {
  if (url.includes('/top/artists')) {
    return { items: [{ id: 'a1', name: 'Core Band', streams: 120, count: 120 }] };
  }
  if (url.includes('/top/genres')) {
    return { items: [{ name: 'indie rock', count: 200 }] };
  }
  if (url.includes('/top/tracks')) {
    return {
      items: [
        { id: 't1', name: 'Hit Single', streams: 90, track: { id: 't1', name: 'Hit Single', artists: [{ name: 'Core Band' }] } },
        { id: 't2', name: 'Deep Cut', streams: 40, track: { id: 't2', name: 'Deep Cut', artists: [{ name: 'Second Act' }] } },
      ],
    };
  }
  if (url.includes('/streams')) {
    return { items: [streamRow('t1', 'Hit Single', 'Core Band', '2026-09-01T08:04:00Z')] };
  }
  throw new Error(`unexpected stats.fm path: ${url}`);
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

function resetAll(): void {
  __resetStatsfmFetchImpl();
  __resetTasteCompositeFetchImpl();
  __resetStatsfmClient();
  __resetStatsfmSleepImpl();
}

// ===========================================================================
// Acceptance criteria, driven through the real registrars
// ===========================================================================

describe('one client serves both stats.fm tool modules', () => {
  it('two taste tools in one session issue exactly one /users/{u}/streams read', async () => {
    const seen: string[] = [];
    __setStatsfmFetchImpl(async (url: string) => {
      seen.push(url);
      return fixturePayload(url);
    });
    try {
      const h = makeHarness();
      // `statsfm_artist_affinity` and `statsfm_exposure_check` are two separate
      // tools in the same module that each want the same 500-stream page.
      await h.find('statsfm_artist_affinity').handler({ statsfm_user: 'demo', artist: 'Core Band' });
      await h.find('statsfm_exposure_check').handler({ statsfm_user: 'demo', subject: 'Core Band' });

      const streamReads = seen.filter((u) => u.includes('/users/demo/streams'));
      assert.equal(
        streamReads.length,
        1,
        `the 500-stream page must be downloaded once, got: ${JSON.stringify(streamReads)}`,
      );
    } finally {
      resetAll();
    }
  });

  it('the page is shared ACROSS modules, not merely within one', async () => {
    const seen: string[] = [];
    __setStatsfmFetchImpl(async (url: string) => {
      seen.push(url);
      return fixturePayload(url);
    });
    try {
      const h = makeHarness();
      await h.find('statsfm_artist_affinity').handler({ statsfm_user: 'demo', artist: 'Core Band' });
      await h.find('taste_daily_brief').handler({ statsfm_user: 'demo' });

      const streamReads = seen.filter((u) => u.includes('/users/demo/streams'));
      assert.equal(
        streamReads.length,
        1,
        `statsfm_taste and taste_composites must share one client, got: ${JSON.stringify(streamReads)}`,
      );
    } finally {
      resetAll();
    }
  });

  it('a different query is still a different read — the cache keys on params', async () => {
    const seen: string[] = [];
    __setStatsfmFetchImpl(async (url: string) => {
      seen.push(url);
      return fixturePayload(url);
    });
    try {
      const h = makeHarness();
      await h.find('statsfm_artist_affinity').handler({ statsfm_user: 'demo', artist: 'Core Band' });
      // `statsfm_taste_profile` asks for limit=100; a cache keyed on path alone
      // would answer that with the limit=500 payload, which is a wrong number
      // rather than a merely stale one.
      await h.find('statsfm_taste_profile').handler({ statsfm_user: 'demo' });

      assert.ok(
        seen.some((u) => u.includes('/streams?limit=100')),
        'the limit=100 read must still go out on the wire',
      );
    } finally {
      resetAll();
    }
  });
});

describe('the timeout is the client’s, and it fires', () => {
  it('a stub that never resolves rejects with a timeout error instead of hanging', async () => {
    // The stub ignores `init`, so it ignores the AbortSignal too. The client
    // enforces the deadline itself rather than delegating it to the transport,
    // which is the only way an injected stub can be bounded too.
    __setStatsfmClient(new StatsfmClient(() => new Promise<Response>(() => {}), { timeoutMs: 60 }));
    try {
      const h = makeHarness();
      const started = Date.now();
      await assert.rejects(
        () => h.find('statsfm_artist_affinity').handler({ statsfm_user: 'demo', artist: 'Core Band' }),
        (error: unknown) => {
          assert.ok(error instanceof StatsfmApiError, `expected StatsfmApiError, got ${String(error)}`);
          assert.equal(error.status, 408);
          assert.equal(error.reason, 'timeout');
          // The path carries the caller's own user id; it must not be echoed.
          assert.doesNotMatch(error.message, /demo/);
          return true;
        },
      );
      assert.ok(Date.now() - started < 5_000, 'the timeout must bound the call, not the suite');
    } finally {
      resetAll();
    }
  });

  it('the default deadline is the configured request timeout, not a local constant', async () => {
    // If the client had grown its own STATSFM_TIMEOUT_MS this re-bind would be
    // ignored and the 150ms budget below would not be what fires.
    const original = globalThis.fetch;
    globalThis.fetch = () => new Promise<Response>(() => {});
    initConfig({ ...process.env, SPOTIFY_REQUEST_TIMEOUT_MS: '150' });
    try {
      const h = makeHarness();
      const started = Date.now();
      await assert.rejects(
        () => h.find('statsfm_artist_affinity').handler({ statsfm_user: 'demo', artist: 'Core Band' }),
        (error: unknown) => error instanceof StatsfmApiError && error.status === 408,
      );
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 5_000, `expected the configured 150ms deadline, took ${elapsed}ms`);
    } finally {
      globalThis.fetch = original;
      initConfig(process.env);
      resetAll();
    }
  });
});

describe('the retry is the client’s, and it is the advertised wait', () => {
  it('a 429 is retried once, after the Retry-After, and then reported', async () => {
    let dispatches = 0;
    const waits: number[] = [];
    const client = new StatsfmClient(
      async () => {
        dispatches += 1;
        return json({ message: 'slow down', reason: 'QUOTA_EXCEEDED' }, {
          status: 429,
          headers: { 'retry-after': '3' },
        });
      },
      { sleepFn: async (ms) => { waits.push(ms); } },
    );
    await assert.rejects(
      () => client.get('/users/busy'),
      (error: unknown) => {
        assert.ok(error instanceof StatsfmApiError);
        assert.equal(error.status, 429);
        // Still reported after the retry — the caller is told when it may try again.
        assert.equal(error.retryAfterSec, 3);
        return true;
      },
    );
    assert.equal(dispatches, 2, 'exactly one retry, not a loop');
    assert.deepEqual(waits, [3000], 'the advertised Retry-After is the wait');
  });

  it('a 404 is not retried — re-sending a settled answer earns nothing', async () => {
    let dispatches = 0;
    const client = new StatsfmClient(
      async () => {
        dispatches += 1;
        return json({ message: 'nope', reason: 'RESOURCE_NOT_FOUND' }, { status: 404 });
      },
      { sleepFn: async () => {} },
    );
    await assert.rejects(() => client.get('/users/missing'), StatsfmApiError);
    assert.equal(dispatches, 1);
  });
});

describe('both modules surface one error shape', () => {
  it('a statsfm_taste tool and a taste_composites tool report the identical failure', async () => {
    __setStatsfmClient(new StatsfmClient(
      async () => json(
        { message: 'private https://example.test/users/alice?token=secret' },
        { status: 500 },
      ),
      { sleepFn: async () => {} },
    ));
    try {
      const h = makeHarness();
      const shape = async (tool: string) => {
        try {
          await h.find(tool).handler({ statsfm_user: 'alice', artist: 'Core Band' });
          assert.fail(`${tool} should have rejected`);
        } catch (error) {
          assert.ok(error instanceof StatsfmApiError, `${tool} threw ${String(error)}`);
          return error;
        }
      };
      const fromTaste = await shape('statsfm_artist_affinity');
      const fromComposite = await shape('taste_daily_brief');

      assert.equal(fromTaste.message, 'stats.fm HTTP 500');
      assert.equal(
        fromComposite.message,
        fromTaste.message,
        'a raw per-module HTTP string here means the shims are split again',
      );
      assert.equal(fromTaste.status, fromComposite.status);
      // The two old shims each threw a bare `stats.fm API HTTP ${status} for
      // ${url}` built from the upstream body, which echoes private paths.
      for (const error of [fromTaste, fromComposite]) {
        assert.doesNotMatch(error.message, /example\.test|alice|token|secret/);
        assert.doesNotMatch(error.message, /^stats\.fm API HTTP/);
      }
    } finally {
      resetAll();
    }
  });

  it('a transport failure in either module is the same typed error', async () => {
    __setStatsfmFetchImpl(async () => {
      throw new TypeError('fetch failed for https://example.test/users/alice?token=secret');
    });
    try {
      const h = makeHarness();
      for (const tool of ['statsfm_artist_affinity', 'taste_daily_brief']) {
        await assert.rejects(
          () => h.find(tool).handler({ statsfm_user: 'alice', artist: 'Core Band' }),
          (error: unknown) => {
            assert.ok(error instanceof StatsfmApiError, `${tool} threw ${String(error)}`);
            assert.equal(error.status, 0);
            assert.equal(error.reason, 'transport_error');
            assert.doesNotMatch(error.message, /example\.test|alice|token|secret/);
            return true;
          },
        );
      }
    } finally {
      resetAll();
    }
  });
});

describe('the shared client is shared', () => {
  it('statsfmClient() is one instance, and a reset gives a genuinely fresh one', async () => {
    assert.equal(statsfmClient(), statsfmClient());
    const before = statsfmClient();
    __resetStatsfmClient();
    const after = statsfmClient();
    assert.notEqual(after, before, 'a reset must not hand back a cache that still holds old reads');
  });
});

// ===========================================================================
// Source-scanning guards
// ===========================================================================

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Files permitted to call the global `fetch`.
 *
 * `src/client.ts` is the Spotify request funnel, `src/auth.ts` is the Spotify
 * token exchange — neither touches stats.fm, and both have their own timeout
 * story. `src/lib/statsfm-client.ts` is the one place the consolidation allows
 * a transport at all.
 */
const FETCH_HOLDERS: ReadonlySet<string> = new Set([
  join('src', 'client.ts'),
  join('src', 'auth.ts'),
  join('src', 'lib', 'statsfm-client.ts'),
]);

/** Paths of `fetch(` calls in `source`, as offsets — code only, prose blanked. */
function fetchCallOffsets(source: string): number[] {
  const code = blankNonCode(source);
  const hits: number[] = [];
  for (const m of code.matchAll(/\bfetch\s*\(/g)) hits.push(m.index ?? -1);
  return hits;
}

/**
 * Per-module copies of the client's policy: an UPPER_CASE constant naming a
 * timeout / cache lifetime / retry wait, or any use of `AbortSignal`, declared
 * in a stats.fm tool module. `src/lib/statsfm-client.ts` is where those belong.
 *
 * The constant is matched by its whole name rather than by a hand-written
 * regex over a known prefix: a new module naming its own `STATSFM_TTL_MS` or
 * `COMPOSITE_TIMEOUT_MS` is exactly the drift this is meant to catch, and a
 * pattern that only knows the prefixes that exist today would wave it through.
 */
const POLICY_WORDS = /TIMEOUT|TTL|CACHE|MAX_AGE|RETRY|BACKOFF|ABORT/;

function policyConstantOffsets(source: string): Array<{ label: string; offset: number }> {
  const code = blankNonCode(source);
  const hits: Array<{ label: string; offset: number }> = [];
  for (const m of code.matchAll(/\b[A-Z][A-Z0-9_]{3,}\b/g)) {
    if (POLICY_WORDS.test(m[0])) hits.push({ label: 'timeout/TTL/cache constant', offset: m.index ?? -1 });
  }
  for (const m of code.matchAll(/\bAbortSignal\b/g)) {
    hits.push({ label: 'AbortSignal', offset: m.index ?? -1 });
  }
  return hits;
}

function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

describe('no stats.fm HTTP shim survives outside the client', () => {
  it('the scanner reports a bare fetch( in synthetic source (anti-vacuity)', () => {
    // If this stopped matching, every real-source assertion below would pass
    // because the scanner found nothing — the failure mode a source guard is
    // most prone to.
    const source = 'const r = await fetch(url);';
    const hits = fetchCallOffsets(source);
    assert.equal(hits.length, 1, 'a bare transport call must be reported');
    assert.equal(source.slice(hits[0]), 'fetch(url);');
    assert.deepEqual(fetchCallOffsets('await this.fetchFn(url, init);'), []);
    // `fetchFn(` / `fetchWithTimeout(` are not the global transport.
    assert.deepEqual(fetchCallOffsets('await fetchWithTimeout(url, {});'), []);
    assert.deepEqual(fetchCallOffsets('// we used to call fetch(url) here'), []);
    assert.deepEqual(fetchCallOffsets('const s = "fetch(url)";'), []);
  });

  it('the policy scanner reports a locally declared timeout or TTL (anti-vacuity)', () => {
    for (const decl of [
      'const TASTE_COMPOSITE_TIMEOUT_MS = 5000;',
      'const STATSFM_CACHE_TTL_MS = 120_000;',
      'const TASTE_RETRY_BACKOFF_MS = 250;',
    ]) {
      const flagged = policyConstantOffsets(decl);
      assert.equal(flagged.length, 1, `${decl} must be flagged`);
      assert.equal(flagged[0].label, 'timeout/TTL/cache constant');
    }
    const abort = policyConstantOffsets('signal: AbortSignal.timeout(ms)');
    assert.equal(abort.length, 1);
    assert.equal(abort[0].label, 'AbortSignal');
    // An ordinary tool-module constant is not a policy declaration.
    assert.deepEqual(policyConstantOffsets("const MAX_RESULTS = 50;\nconst DEFAULT_RANGE = 'lifetime';"), []);
    assert.deepEqual(policyConstantOffsets('const timeoutMs = 5000;'), []);
  });

  it('it scans the real stats.fm tool modules, so the guards above are not vacuous', () => {
    const files = sourceFiles(SRC).map((f) => relative(ROOT, f).split(sep).join('/'));
    for (const required of [
      'src/tools/statsfm.ts',
      'src/tools/statsfm_taste.ts',
      'src/tools/taste_composites.ts',
      'src/lib/statsfm-client.ts',
    ]) {
      assert.ok(files.includes(required), `the scan must cover ${required}`);
    }
    assert.ok(files.length > 40, `expected the whole src tree, saw ${files.length} files`);
  });

  it('no module outside the client calls the global fetch', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(ROOT, file).split(sep).join('/');
      if (FETCH_HOLDERS.has(rel.split('/').join(sep))) continue;
      const source = readFileSync(file, 'utf8');
      for (const offset of fetchCallOffsets(source)) {
        offenders.push(`${rel}:${lineOf(source, offset)}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `stats.fm (or anything else) must not open its own transport outside the client:\n${offenders.join('\n')}`,
    );
  });

  it('the stats.fm base URL has exactly one definition in src/', () => {
    // The issue's acceptance criterion verbatim: `grep -r 'https://api.stats.fm'
    // src` returns one line. Scanned raw, not blanked — a base-URL constant IS
    // a string literal, so blanking non-code would delete the thing being
    // counted.
    const found: Array<{ file: string; line: number }> = [];
    for (const file of sourceFiles(SRC)) {
      const source = readFileSync(file, 'utf8');
      for (const m of source.matchAll(new RegExp(BASE_LITERAL.replace(/\./g, '\\.'), 'g'))) {
        found.push({ file: relative(ROOT, file), line: lineOf(source, m.index ?? 0) });
      }
    }
    assert.equal(
      found.length,
      1,
      `expected one stats.fm base URL, found ${found.length}: ${JSON.stringify(found)}`,
    );
    assert.equal(found[0].file, join('src', 'lib', 'statsfm-client.ts'));
  });

  it('no stats.fm tool module declares its own timeout or cache lifetime', () => {
    const offenders: string[] = [];
    const targets = ['statsfm.ts', 'statsfm_taste.ts', 'taste_composites.ts', 'taste_playlist.ts'];
    for (const file of targets.map((n) => join(SRC, 'tools', n))) {
      const source = readFileSync(file, 'utf8');
      for (const { label, offset } of policyConstantOffsets(source)) {
        offenders.push(`${relative(ROOT, file)}:${lineOf(source, offset)} (${label})`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `timeout/cache policy belongs to the client:\n${offenders.join('\n')}`,
    );
  });

  it('the tool modules read through the client, not a hand-rolled path join', () => {
    // The seam is the only sanctioned way a test injects a fixture; if a module
    // kept its own `fetchImpl` variable, a test could stub one module and leave
    // the other two talking to the live API.
    for (const rel of ['src/tools/statsfm_taste.ts', 'src/tools/taste_composites.ts']) {
      const code = blankNonCode(readFileSync(join(ROOT, rel), 'utf8'));
      assert.ok(
        /statsfmClient\(\)/.test(code),
        `${rel} must resolve its reads through the shared client`,
      );
      assert.doesNotMatch(
        code,
        /\blet\s+fetchImpl\b/,
        `${rel} kept a private transport variable — the shim is back`,
      );
    }
  });
});
