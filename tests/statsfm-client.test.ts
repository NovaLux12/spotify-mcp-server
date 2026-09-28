/**
 * StatsfmClient's HTTP layer (src/lib/statsfm-client.ts) — #666.
 *
 * stats.fm is a THIRD-PARTY API, not Spotify, and the docs that cover
 * Spotify's status handling do not apply to it. Its error envelope is
 * `{"status": 400, "message": "invalid range"}` and it will hand that back
 * with an HTTP 200 (see the 200-envelope cases below), which a Spotify-shaped
 * reader would read as a working call with an empty body. Everything the
 * client does on the wire was therefore unexercised: the query builder, the
 * non-2xx path, the 200-with-envelope path, and the transport mapping.
 *
 * Zero network, zero live token. Every client below is constructed with an
 * explicit stub `fetchFn`, and the final test enforces that as a property of
 * the whole test tree.
 *
 * What is asserted is what the code DOES, not what a comment claims. The
 * client deliberately redacts the upstream message (`stats.fm HTTP <status>`,
 * reason code only) because stats.fm echoes private request paths into it;
 * several tests pin that redaction, since a client that started surfacing the
 * raw text would pass every other assertion here and leak the path.
 *
 * Run with: node --import tsx --test tests/statsfm-client.test.ts
 */

import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

import { StatsfmApiError, StatsfmClient } from '../src/lib/statsfm-client.js';
// Reused from the `as any` gate: blanks comments and string-literal bodies so a
// scan sees code, not prose. Without it this guard matches the sentences in its
// own file that say `new StatsfmClient()`.
import { blankNonCode } from '../scripts/check-no-explicit-any.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BASE = 'https://api.stats.fm/api/v1';

// ------------------------------------------------------------------ stub

/**
 * A stub `fetchFn` that RECORDS the URL it was handed.
 *
 * The recording is the point. Asserting only the return value would let the
 * query builder emit a malformed URL and every behavioural test below would
 * still pass, because a stub answers whatever it is asked.
 *
 * The backoff wait is stubbed to nothing. Since #907 the client retries a 429
 * or 5xx once, and a stub that answers the same status twice would otherwise
 * spend the advertised `Retry-After` — 10s for the HTTP-date case below — on
 * every classification assertion. The wait is not what these tests are about;
 * how long it is, and that it happens at all, is asserted in
 * `statsfm-shims.test.ts`.
 */
function recordingClient(respond: (url: string) => Response | Promise<Response>) {
  const urls: string[] = [];
  const client = new StatsfmClient(
    async (url) => {
      urls.push(url);
      return await respond(url);
    },
    { sleepFn: async () => {} },
  );
  return {
    client,
    urls,
    lastUrl: () => urls[urls.length - 1],
  };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

/** A body that will not parse — a proxy error page, a truncated body. */
const unparseable = (init: ResponseInit = {}) =>
  new Response('<html>502 Bad Gateway</html>', { status: 200, ...init });

/** Assert an error is a StatsfmApiError with exactly these fields. */
function isApiError(
  error: unknown,
  expected: { status: number; reason?: string; retryAfterSec?: number },
): boolean {
  assert.ok(error instanceof StatsfmApiError, `expected StatsfmApiError, got ${String(error)}`);
  assert.equal(error.status, expected.status);
  assert.equal(error.reason, expected.reason);
  assert.equal(error.retryAfterSec, expected.retryAfterSec);
  return true;
}

// ------------------------------------------------------- query building

describe('the query builder is what actually goes on the wire', () => {
  it('encodes keys and values, so a path-like value cannot forge a second param', async () => {
    const h = recordingClient(() => json({ items: [] }));
    await h.client.get('/search', { query: 'a&b=c d/e' });
    assert.equal(
      h.lastUrl(),
      `${BASE}/search?query=a%26b%3Dc%20d%2Fe`,
      'an unencoded & or = in a value would silently add or overwrite a parameter',
    );
  });

  it('encodes keys too — a key is caller data, not a fixed name', async () => {
    const h = recordingClient(() => json({ items: [] }));
    await h.client.get('/search', { 'a&b': 'c' });
    assert.equal(h.lastUrl(), `${BASE}/search?a%26b=c`);
  });

  it('joins multiple params in order and stringifies numbers', async () => {
    const h = recordingClient(() => json({ items: [] }));
    await h.client.get('/users/u/top/tracks', { range: 'months', limit: 5, offset: 10 });
    assert.equal(h.lastUrl(), `${BASE}/users/u/top/tracks?range=months&limit=5&offset=10`);
  });

  it('drops an empty value instead of sending a bare `k=`', async () => {
    // An empty `range=` is not the same request as no `range` at all: the API
    // validates the value it is given, and `''` is a value.
    const h = recordingClient(() => json({ items: [] }));
    await h.client.get('/users/u/top/tracks', { range: '', limit: 5 });
    assert.equal(h.lastUrl(), `${BASE}/users/u/top/tracks?limit=5`);
  });

  it('drops undefined and null values, leaving a bare `?` that parses as an empty query', async () => {
    // Recorded as the client actually builds it, not as it "should". The `?`
    // is left behind when every value is filtered out; stats.fm parses an
    // empty query the same as none, so this is cosmetic and deliberately not
    // a source change here (#666 is a coverage issue). Pinned so a future
    // tidy-up is a decision, not a silent diff.
    const h = recordingClient(() => json({ items: [] }));
    // `as unknown as`, and deliberately: the client's parameter type forbids
    // nullish values, and the whole point of this case is to pin that it
    // drops them anyway. The two-step says "out of contract"; a single
    // `as` is rejected outright because the shapes do not overlap.
    await h.client.get('/users/u', { a: undefined, b: null } as unknown as Record<string, string | number>);
    assert.equal(h.lastUrl(), `${BASE}/users/u?`, 'neither undefined nor null may reach the wire');

    await h.client.get('/users/u', {});
    assert.equal(h.lastUrl(), `${BASE}/users/u?`, 'an empty params object is not a query string');

    await h.client.get('/users/u');
    assert.equal(h.lastUrl(), `${BASE}/users/u`, 'omitted params must not append `?undefined`');
  });

  it('omits the query string entirely when no params are passed', async () => {
    const h = recordingClient(() => json({ item: null }));
    await h.client.get('/users/u/now_playing');
    assert.equal(h.lastUrl(), `${BASE}/users/u/now_playing`);
  });
});

// ------------------------------------------------------------- the 200 + envelope quirk

describe('a 200 carrying an error envelope is an error, not an empty result', () => {
  it('throws with the envelope status when a 200 body is {status: 400, message}', async () => {
    // The documented stats.fm range failure, verified live: HTTP 200 whose
    // body is {"status":400,"message":"invalid range"}. Read as a success this
    // is a tool that answers "no data" for a request the API rejected.
    const h = recordingClient(() => json({ status: 400, message: 'invalid range' }));
    await assert.rejects(
      () => h.client.get('/users/u/top/tracks', { range: 'all-time' }),
      (error: unknown) => isApiError(error, { status: 400, reason: undefined }),
    );
  });

  it('takes the retry hint from the envelope, not from a header that is absent', async () => {
    const h = recordingClient(() => json({ status: 429, message: 'slow down', retryAfterSec: 12.4 }));
    await assert.rejects(
      () => h.client.get('/users/u/top/tracks'),
      (error: unknown) => isApiError(error, { status: 429, retryAfterSec: 13 }),
    );
  });

  it('treats a 200 envelope of status < 400 as a success and returns the body', async () => {
    // The guard is `>= 400`. A body that merely happens to carry `status` and
    // `message` fields is a normal response and must not be turned into a
    // failure — otherwise a future envelope field breaks unrelated tools.
    const h = recordingClient(() => json({ status: 200, message: 'ok', items: [{ id: 1 }] }));
    const body = await h.client.get<{ status: number; message: string; items: unknown[] }>('/users/u');
    assert.equal(body?.status, 200);
    assert.deepEqual(body?.items, [{ id: 1 }]);
  });

  it('does not invent a failure from an envelope with a non-numeric status', async () => {
    const h = recordingClient(() => json({ status: '400', message: 'invalid range' }));
    const body = await h.client.get<{ status: string }>('/users/u/top/tracks');
    assert.equal(body?.status, '400', 'a string status is not the documented numeric envelope');
  });

  it('redacts the envelope message, which may echo a private request path', async () => {
    const h = recordingClient(() => json({
      status: 404,
      message: 'no such user https://api.stats.fm/api/v1/users/alice?token=secret',
      reason: 'RESOURCE_NOT_FOUND',
    }));
    await assert.rejects(
      () => h.client.get('/users/alice'),
      (error: unknown) => {
        assert.ok(error instanceof StatsfmApiError);
        assert.equal(error.message, 'stats.fm HTTP 404');
        assert.equal(error.reason, 'RESOURCE_NOT_FOUND');
        assert.doesNotMatch(error.message, /alice|secret|api\.stats\.fm/);
        return true;
      },
    );
  });
});

// --------------------------------------------------------------- non-2xx

describe('a non-2xx status is classified, whatever the body holds', () => {
  it('prefers the Retry-After header over the body hint', async () => {
    const h = recordingClient(() => json(
      { status: 429, message: 'slow down', reason: 'QUOTA_EXCEEDED', retryAfterSec: 5 },
      { status: 429, headers: { 'retry-after': '30' } },
    ));
    await assert.rejects(
      () => h.client.get('/users/u'),
      (error: unknown) => isApiError(error, { status: 429, reason: 'QUOTA_EXCEEDED', retryAfterSec: 30 }),
    );
  });

  it('reads a Retry-After HTTP-date against a pinned clock', async (t) => {
    // The date branch is the only arithmetic in the client that reads the
    // wall clock, so the clock is pinned: with the real one this asserts
    // nothing, and nothing is ever actually waited on.
    const now = Date.parse('2026-09-26T12:00:00.000Z');
    t.mock.timers.enable({ apis: ['Date'], now });
    try {
      const h = recordingClient(() => json(
        { message: 'slow down', reason: 'QUOTA_EXCEEDED' },
        { status: 429, headers: { 'retry-after': new Date(now + 45_000).toUTCString() } },
      ));
      await assert.rejects(
        () => h.client.get('/users/u'),
        (error: unknown) => isApiError(error, { status: 429, reason: 'QUOTA_EXCEEDED', retryAfterSec: 45 }),
      );
    } finally {
      t.mock.timers.reset();
    }
  });

  it('never reports a negative wait for a Retry-After date already in the past', async (t) => {
    const now = Date.parse('2026-09-26T12:00:00.000Z');
    t.mock.timers.enable({ apis: ['Date'], now });
    try {
      const h = recordingClient(() => json(
        { message: 'slow down' },
        { status: 429, headers: { 'retry-after': new Date(now - 60_000).toUTCString() } },
      ));
      await assert.rejects(
        () => h.client.get('/users/u'),
        (error: unknown) => isApiError(error, { status: 429, retryAfterSec: 0 }),
      );
    } finally {
      t.mock.timers.reset();
    }
  });

  it('ignores an unparseable Retry-After rather than propagating NaN', async () => {
    const h = recordingClient(() => json(
      { message: 'slow down' },
      { status: 429, headers: { 'retry-after': 'soonish' } },
    ));
    await assert.rejects(
      () => h.client.get('/users/u'),
      (error: unknown) => isApiError(error, { status: 429, retryAfterSec: undefined }),
    );
  });

  it('reads a reason nested under `error` when there is no top-level one', async () => {
    const h = recordingClient(() => json(
      { status: 404, message: 'nope', error: { reason: 'RESOURCE_NOT_FOUND' } },
      { status: 404 },
    ));
    await assert.rejects(
      () => h.client.get('/users/missing'),
      (error: unknown) => isApiError(error, { status: 404, reason: 'RESOURCE_NOT_FOUND' }),
    );
  });

  it('throws on a non-2xx whose body will not parse, rather than returning null', async () => {
    // Swallowing the body must not swallow the status: a 502 proxy page is a
    // failed read, and reporting it as "no data" is the #803 failure again.
    const h = recordingClient(() => unparseable({ status: 502 }));
    await assert.rejects(
      () => h.client.get('/users/u'),
      (error: unknown) => isApiError(error, { status: 502, reason: undefined }),
    );
  });

  it('throws on a 404 with an empty body', async () => {
    const h = recordingClient(() => new Response(null, { status: 404 }));
    await assert.rejects(
      () => h.client.get('/users/missing'),
      (error: unknown) => isApiError(error, { status: 404 }),
    );
  });
});

// ----------------------------------------------------------------- 2xx bodies

describe('a 2xx body is returned as read, including when it is empty', () => {
  it('returns null for a 200 that will not parse', async () => {
    // `get` is documented as returning null on transport-level emptiness. A
    // caller cannot tell an empty read from a failed one unless the failed one
    // throws — so this pins that the 2xx path stays non-throwing.
    const h = recordingClient(() => unparseable());
    assert.equal(await h.client.get('/users/u'), null);
  });

  it('returns a JSON null body as null, not as an envelope', async () => {
    const h = recordingClient(() => json(null));
    assert.equal(await h.client.get('/users/u'), null);
  });

  it('returns the envelope container, not its contents', async () => {
    // The client is a transport: `{item: {...}}` reaches the caller intact.
    // Flattening here would make every consumer's unwrap silently redundant.
    const h = recordingClient(() => json({ item: { id: 'u1' } }));
    const body = await h.client.get<{ item: { id: string } }>('/users/u1');
    assert.deepEqual(body, { item: { id: 'u1' } });
  });

  it('sends exactly one request per get', async () => {
    const h = recordingClient(() => json({ items: [] }));
    await h.client.get('/users/u');
    assert.equal(h.urls.length, 1, 'no silent retry on a successful read');
  });
});

// ------------------------------------------------------------ transport

describe('a transport failure is redacted and classified, not leaked', () => {
  it('maps a rejected fetch to a status-0 transport error', async () => {
    const h = recordingClient(() => { throw new TypeError('fetch failed'); });
    await assert.rejects(
      () => h.client.get('/private'),
      (error: unknown) => isApiError(error, { status: 0, reason: 'transport_error', retryAfterSec: undefined }),
    );
  });

  it('does not put the underlying message — which names the URL — in the error', async () => {
    const h = recordingClient(() => { throw new TypeError('connect ECONNREFUSED https://api.stats.fm/api/v1/users/alice'); });
    await assert.rejects(
      () => h.client.get('/users/alice'),
      (error: unknown) => {
        assert.ok(error instanceof StatsfmApiError);
        assert.equal(error.message, 'stats.fm request failed');
        assert.doesNotMatch(error.message, /alice|ECONNREFUSED|api\.stats\.fm/);
        return true;
      },
    );
  });

  it('re-throws a StatsfmApiError from the fetch unchanged', async () => {
    // A retry policy upstream of the transport (a cache, a queue) raises the
    // client's own error type. Flattening it to a status-0 transport error
    // would discard the 429 and its retry hint.
    const original = new StatsfmApiError(429, 'stats.fm HTTP 429', 42, 'QUOTA_EXCEEDED');
    const h = recordingClient(() => { throw original; });
    await assert.rejects(
      () => h.client.get('/users/u'),
      (error: unknown) => {
        assert.equal(error, original, 'the very same error instance must reach the caller');
        assert.equal((error as StatsfmApiError).retryAfterSec, 42);
        return true;
      },
    );
  });
});

// -------------------------------------------------- the no-live-network guard

/**
 * The stub seam is only a guarantee if nothing else reaches out. This scans
 * the test tree for the two ways a test acquires a real client — constructing
 * one with no `fetchFn`, or calling `registerStatsfmTools` without passing one
 * (its second parameter defaults to a live one).
 *
 * A guard that cannot fire is decoration, so the same collector is driven over
 * a synthetic fixture below and required to reject it.
 */
function countBareStatsfmClients(raw: string): string[] {
  const hits: string[] = [];
  const source = blankNonCode(raw);

  for (const m of source.matchAll(/new\s+StatsfmClient\s*\(\s*\)/g)) hits.push('bare new StatsfmClient()');

  // `registerStatsfmTools(server)` — one argument at depth 1 means the client
  // default parameter builds a live client.
  for (const m of source.matchAll(/registerStatsfmTools\s*\(/g)) {
    let depth = 0;
    let commas = 0;
    for (let i = m.index + m[0].length; i < source.length; i++) {
      const ch = source[i];
      if (ch === '(' || ch === '{' || ch === '[') depth++;
      else if (ch === ')' || ch === '}' || ch === ']') {
        if (depth === 0) break;
        depth--;
      } else if (ch === ',' && depth === 0) commas++;
    }
    if (commas === 0) hits.push('registerStatsfmTools(<one arg>)');
  }
  return hits;
}

describe('no test can reach api.stats.fm without an injected stub', () => {
  it('the collector rejects a bare construction and a defaulted registration', () => {
    // The negative case first: if this passes vacuously the real scan proves
    // nothing.
    assert.deepEqual(countBareStatsfmClients('new StatsfmClient()'), ['bare new StatsfmClient()']);
    assert.deepEqual(
      countBareStatsfmClients('registerStatsfmTools(server);'),
      ['registerStatsfmTools(<one arg>)'],
    );
    assert.deepEqual(countBareStatsfmClients('new StatsfmClient(async () => r)'), []);
    assert.deepEqual(countBareStatsfmClients('registerStatsfmTools(server, stub)'), []);
    assert.deepEqual(countBareStatsfmClients('registerStatsfmTools(server, stub, extra)'), []);
  });

  it('the collector ignores prose and string literals, not just code', () => {
    // The file carrying the guard names the forbidden call in its own comments
    // and fixtures. If the scan read raw text it would flag those and go
    // permanently red.
    assert.deepEqual(
      countBareStatsfmClients('// do not write new StatsfmClient() in a test\nconst ok = 1;'),
      [],
      'a comment is not a call',
    );
    assert.deepEqual(
      countBareStatsfmClients('const s = "new StatsfmClient()";'),
      [],
      'a string literal is not a call',
    );
    assert.deepEqual(
      countBareStatsfmClients('const c = new StatsfmClient();\n// and registerStatsfmTools(s)'),
      ['bare new StatsfmClient()'],
      'blanking must not hide a real call next to prose',
    );
  });

  it('the whole test tree holds at zero live stats.fm clients', () => {
    const dir = join(ROOT, 'tests');
    const offenders: string[] = [];
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const file = join(dir, name);
      for (const hit of countBareStatsfmClients(readFileSync(file, 'utf8'))) {
        offenders.push(`${relative(ROOT, file)}: ${hit}`);
      }
    }
    assert.deepEqual(offenders, [], `these tests would reach api.stats.fm:\n${offenders.join('\n')}`);
  });
});
