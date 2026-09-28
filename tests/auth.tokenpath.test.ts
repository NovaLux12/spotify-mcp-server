/**
 * #609 — ONE profile-aware token path, for the refresh guard and the doctor.
 *
 * ## The defect this file exists for
 *
 * Three resolvers were live at once, and they disagreed:
 *
 *   - `loadTokens` / `saveTokens` — `getTokenFile(parseAuthArgs().profile)`,
 *     argv-aware. The CORRECT answer.
 *   - `src/client.ts`'s cross-process refresh guard — a module-level
 *     `TOKEN_FILE = getTokenFile()` bound at import time, env-only.
 *   - the doctor — `getConfig().tokenFile`, which is `resolveTokenFile(env)`,
 *     also env-only.
 *
 * So `spotify-mcp --profile work` loaded `tokens.work.json` and then, on every
 * refresh, read `tokens.json`. If the default profile's `expires_at` was
 * higher, the guard adopted that file's `TokenData` VERBATIM and every
 * subsequent request carried the other account's access token — silently, with
 * no error raised. The same misread defeats the guard itself (#109): both
 * processes refresh, and Spotify can invalidate the older refresh token.
 *
 * ## Why these are two separate profiles and not one
 *
 * A test that seeds only `tokens.work.json` proves nothing: the buggy code
 * reads `tokens.json`, finds nothing, and "passes" for the wrong reason — or
 * fails for a reason that has nothing to do with profiles. Every client test
 * below writes BOTH files with DIFFERENT access tokens and DIFFERENT
 * expiries, and asserts which token the client actually sent on the wire. The
 * default profile's token is deliberately the fresher one in the first case,
 * because "the guard adopted the wrong file" is only observable when the wrong
 * file is the more attractive one.
 *
 * Run: node --import tsx --test tests/auth.tokenpath.test.ts
 */

import './helpers/hermetic.js';

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpotifyClient } from '../src/client.js';
import { armFileDeadline, FLEET_FILE_BUDGET_MS } from './helpers/file-deadline.js';

/**
 * Imported lazily, on purpose. A static import of an export that does not exist
 * yet fails the WHOLE FILE at module instantiation, which reports as one
 * uninformative SyntaxError: a red test that never ran is not evidence. These
 * are dynamic so that against the unfixed code the behavioural cases below
 * execute and fail on their own assertions — the wrong token on the wire, the
 * wrong file in the doctor's output — which is the evidence that matters.
 */
async function tokenPath(env?: NodeJS.ProcessEnv, argv?: string[]): Promise<string> {
  const auth = await import('../src/auth.js') as { getTokenFilePath?: (e?: NodeJS.ProcessEnv, a?: string[]) => string };
  assert.equal(
    typeof auth.getTokenFilePath,
    'function',
    'src/auth.ts must export getTokenFilePath(): the one profile-aware resolver (#609)',
  );
  return (auth.getTokenFilePath as (e?: NodeJS.ProcessEnv, a?: string[]) => string)(env, argv);
}

// ---------------------------------------------------------------------------
// Fixtures. Everything lives under os.tmpdir(); HOME is redirected so the
// DEFAULT token path is inside the temp home too. Jack's real
// ~/.spotify-mcp/tokens.json is never read, let alone written.
// ---------------------------------------------------------------------------

let home = '';
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousArgv: string[];

const DEFAULT_TOKEN = 'DEFAULT-ACCOUNT-TOKEN';
const WORK_TOKEN = 'WORK-ACCOUNT-TOKEN';
/** What the stubbed token endpoint mints when a refresh really happens. */
const REFRESHED_WORK_TOKEN = 'REFRESHED-WORK-TOKEN';

interface TokenFile {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope?: string;
}

async function seed(file: string, tokens: TokenFile): Promise<void> {
  await writeFile(join(home, '.spotify-mcp', file), JSON.stringify(tokens), { mode: 0o600 });
}

/** The default account's token file — present unless a test removes it. */
function defaultFile(): string {
  return join(home, '.spotify-mcp', 'tokens.json');
}

/** The `work` profile's token file. */
function workFile(): string {
  return join(home, '.spotify-mcp', 'tokens.work.json');
}

/** Expiring inside the 60s refresh window, so a request must refresh. */
function nearlyExpired(token: string): TokenFile {
  return { access_token: token, refresh_token: `refresh-${token}`, expires_at: Date.now() + 5_000 };
}

/** Also inside the 60s window, but with an expiries ordering the caller chose. */
function expiringIn(ms: number, token: string): TokenFile {
  return { access_token: token, refresh_token: `refresh-${token}`, expires_at: Date.now() + ms };
}

/** Genuinely past. The doctor distinguishes this from "expiring in Ns". */
function expired(token: string): TokenFile {
  return { access_token: token, refresh_token: `refresh-${token}`, expires_at: Date.now() - 600_000 };
}

function validUntil(ms: number, token: string): TokenFile {
  return { access_token: token, refresh_token: `refresh-${token}`, expires_at: Date.now() + ms };
}

/** Drive the resolver as if the process had been launched with `argv`. */
// `T | Promise<T>`, not `Promise<T>`: the stores resolve a path from
// `process.argv` and return it synchronously, and this helper is about the
// argv swap, not about the callback being async.
async function withArgvAsync<T>(argv: string[], fn: () => T | Promise<T>): Promise<T> {
  const saved = process.argv;
  process.argv = ['node', 'spotify-mcp', ...argv];
  try {
    return await fn();
  } finally {
    process.argv = saved;
  }
}

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
  label: 'tests/auth.tokenpath.test.ts',
  budgetMs: FLEET_FILE_BUDGET_MS,
  children: () => [],
});

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'x609-home-'));
  await mkdir(join(home, '.spotify-mcp'), { recursive: true });
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  previousArgv = process.argv;
  // hermetic.js already redirected HOME; this narrows it to a directory this
  // file owns, so the default `~/.spotify-mcp/tokens.json` is a fixture too.
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // The whole point is the argv/env profile resolution, so the override that
  // would short-circuit it must not be set.
  delete process.env.SPOTIFY_MCP_TOKEN_FILE;
  delete process.env.SPOTIFY_MCP_PROFILE;
});

after(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(defaultFile(), { force: true });
  await rm(workFile(), { force: true });
  // Two accounts, two different access tokens. Present for every client test
  // unless the test deliberately removes one.
  await seed('tokens.json', validUntil(7_200_000, DEFAULT_TOKEN));
  await seed('tokens.work.json', validUntil(7_200_000, WORK_TOKEN));
});

afterEach(() => {
  process.argv = previousArgv;
  delete process.env.SPOTIFY_MCP_TOKEN_FILE;
  delete process.env.SPOTIFY_MCP_PROFILE;
});

// ---------------------------------------------------------------------------
// 1. The resolver itself
// ---------------------------------------------------------------------------

describe('getTokenFilePath', () => {
  it('resolves a --profile from argv to that profile’s token file', async () => {
    assert.equal(
      await withArgvAsync(['--profile', 'work'], () => tokenPath()),
      workFile(),
      '--profile work must select tokens.work.json',
    );
    assert.equal(
      await withArgvAsync(['--profile=work'], () => tokenPath()),
      workFile(),
      '--profile=work must select the same file as the space-separated form',
    );
  });

  it('resolves the default account when no profile is named, from the LIVE argv', async () => {
    // No arguments injected: this is the real process argv a test runner has,
    // which carries no --profile. If a test harness ever grew one, this fails
    // loudly rather than silently asserting a profile-aware path is the default.
    assert.equal(await tokenPath(), defaultFile());
  });

  it('SPOTIFY_MCP_TOKEN_FILE outranks both profile sources', async () => {
    const override = '/tmp/x609-override/tokens.json';
    await withArgvAsync(['--profile', 'work'], async () => {
      process.env.SPOTIFY_MCP_TOKEN_FILE = override;
      assert.equal(await tokenPath(), override, 'the env override wins over --profile');
      assert.equal(
        await tokenPath({ SPOTIFY_MCP_TOKEN_FILE: override, SPOTIFY_MCP_PROFILE: 'home' }, ['--profile', 'work']),
        override,
        'the env override wins over an env profile AND a CLI profile',
      );
    });
  });

  it('falls back to SPOTIFY_MCP_PROFILE when argv names none', async () => {
    assert.equal(
      await tokenPath({ SPOTIFY_MCP_PROFILE: 'home' }, []),
      join(home, '.spotify-mcp', 'tokens.home.json'),
    );
  });

  it('an explicit --profile outranks SPOTIFY_MCP_PROFILE', async () => {
    // The precedence the module documents and the rest of the server already
    // implements: `cliProfile ?? env.SPOTIFY_MCP_PROFILE`.
    assert.equal(
      await tokenPath({ SPOTIFY_MCP_PROFILE: 'home' }, ['--profile', 'work']),
      workFile(),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. The cross-process refresh guard reads the ACTIVE profile's file
// ---------------------------------------------------------------------------

/**
 * `RequestInit['headers']` is a union — `Headers`, `[string, string][]`, or a
 * plain record — so `init.headers?.Authorization` only typechecks against one
 * of the three. This reads the header the way `fetch` itself would, and
 * returns `undefined` when it is genuinely absent rather than guessing. The
 * type is reached through `RequestInit` rather than named as `HeadersInit`,
 * because the test tree compiles with `lib: ["ES2024"]` and no DOM.
 */
function headerValue(headers: RequestInit['headers'], name: string): string | undefined {
  if (headers === undefined) return undefined;
  if (Array.isArray(headers)) {
    const hit = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return hit?.[1];
  }
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) ?? undefined;
  }
  const record = headers as Record<string, string>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : record[key];
}

interface FetchCall {
  url: string;
  auth: string | undefined;
  body: string | undefined;
}

describe('the refresh guard follows the active profile', () => {
  const realFetch = globalThis.fetch;
  let calls: FetchCall[] = [];

  beforeEach(() => {
    calls = [];
    // The guard sits BEHIND this check inside doRefreshTokens, so without a
    // client id the run aborts before the guard is ever reached and the test
    // would be measuring the wrong thing.
    process.env.SPOTIFY_CLIENT_ID = 'test-client-id';
    globalThis.fetch = (async (url: unknown, init: RequestInit) => {
      calls.push({
        url: String(url),
        auth: headerValue(init.headers, 'Authorization'),
        body: typeof init.body === 'string' ? init.body : undefined,
      });
      if (String(url).includes('accounts.spotify.com')) {
        return new Response(
          JSON.stringify({ access_token: 'REFRESHED-WORK-TOKEN', refresh_token: 'refresh-REFRESHED', expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ id: 'listener', type: 'user' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.SPOTIFY_CLIENT_ID;
  });

  /** Every Bearer the client put on the wire, in order. */
  function bearers(): string[] {
    return calls.filter((c) => c.auth).map((c) => c.auth as string);
  }

  function refreshes(): FetchCall[] {
    return calls.filter((c) => c.url.includes('accounts.spotify.com'));
  }

  it('refuses to adopt a fresher tokens.json while --profile work is active', async () => {
    // The exact shape of the bug: the ACTIVE profile is inside the 60s refresh
    // window, and the DEFAULT profile holds a much fresher access token. A
    // guard reading the wrong file adopts it and every later request leaves the
    // box as the wrong account, with no error anywhere and no refresh at all.
    await seed('tokens.work.json', nearlyExpired(WORK_TOKEN));
    await seed('tokens.json', validUntil(7_200_000, DEFAULT_TOKEN));

    const { SpotifyClient } = await import('../src/client.js');
    await withArgvAsync(['--profile', 'work'], async () => {
      const client = new SpotifyClient({ disableCache: true });
      await client.get('/me');
    });

    const sent = bearers();
    assert.equal(
      refreshes().length,
      1,
      `the active profile was due for a refresh and must actually perform one; calls: ${JSON.stringify(calls)}`,
    );
    assert.ok(
      !sent.includes(`Bearer ${DEFAULT_TOKEN}`),
      `the default account's token was sent while --profile work was active: ${JSON.stringify(sent)}`,
    );
    assert.equal(
      sent[0],
      `Bearer ${REFRESHED_WORK_TOKEN}`,
      'the first request must carry the work profile’s own (refreshed) token',
    );
  });

  it('adopts a fresher tokens.work.json while --profile work is active', async () => {
    // The guard still has to work — the fix must not delete it to make the test
    // above pass. Reproducing what the guard is FOR (#109): this process loaded
    // tokens.work.json, ANOTHER process then refreshed that same file, and the
    // network round-trip is now pure waste. Both files are written, with the
    // default profile's deliberately STALER, so a guard still pointed at
    // tokens.json declines to adopt and refreshes for nothing.
    //
    // The clock is pinned because the guard only runs inside the 60s pre-expiry
    // window: without a clock the client's own copy and the on-disk copy are the
    // same value and `stored.expires_at > tokens.expires_at` is false for
    // reasons that have nothing to do with which file was read.
    const realNow = Date.now;
    const T0 = realNow();
    try {
      await seed('tokens.work.json', { access_token: 'WORK-STALE-TOKEN', refresh_token: 'r-work', expires_at: T0 + 120_000 });
      await seed('tokens.json', { access_token: 'DEFAULT-STALE-TOKEN', refresh_token: 'r-def', expires_at: T0 - 600_000 });

      const { SpotifyClient } = await import('../src/client.js');
      await withArgvAsync(['--profile', 'work'], async () => {
        Date.now = () => T0;
        const client = new SpotifyClient({ disableCache: true });
        // Primes the in-memory copy. Not due yet, so this is a plain read.
        await client.get('/me');
        assert.deepEqual(bearers(), ['Bearer WORK-STALE-TOKEN'], 'the control: the first read is unrefreshed');
        calls = [];

        // Another spotify-mcp process refreshes the SAME profile.
        await seed('tokens.work.json', { access_token: 'WORK-ADOPTED-TOKEN', refresh_token: 'r-work2', expires_at: T0 + 180_000 });
        // And moves the clock into this process's refresh window.
        Date.now = () => T0 + 70_000;
        await client.get('/me');
      });
    } finally {
      Date.now = realNow;
    }

    assert.equal(
      refreshes().length,
      0,
      `the guard must adopt the fresher active-profile token instead of refreshing; calls: ${JSON.stringify(calls)}`,
    );
    assert.deepEqual(
      bearers(),
      ['Bearer WORK-ADOPTED-TOKEN'],
      'the adopted token must come from the work profile’s file, not the default profile’s',
    );
  });

  it('still reads the default account when no profile is named', async () => {
    // The control: with no --profile, the default file IS the active one, so
    // the guard must adopt from it exactly as before.
    await seed('tokens.json', validUntil(7_200_000, 'DEFAULT-FRESH-TOKEN'));
    await seed('tokens.work.json', nearlyExpired(WORK_TOKEN));

    const { SpotifyClient } = await import('../src/client.js');
    const client = new SpotifyClient({ disableCache: true });
    await client.get('/me');

    assert.equal(refreshes().length, 0, 'the default profile’s fresher token must be adopted');
    assert.deepEqual(bearers(), ['Bearer DEFAULT-FRESH-TOKEN']);
  });

  it('names the ACTIVE profile’s token file in a refresh failure message', async () => {
    // The classification messages appended `TOKEN_FILE` for the same reason
    // (#677: a multi-profile install cannot otherwise tell which file is
    // broken). Naming the wrong one points the operator at the wrong file.
    await seed('tokens.work.json', nearlyExpired(WORK_TOKEN));
    globalThis.fetch = (async (url: unknown) => {
      calls.push({ url: String(url), auth: undefined, body: undefined });
      return new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const { SpotifyClient } = await import('../src/client.js');
    {
      await withArgvAsync(['--profile', 'work'], async () => {
        const client = new SpotifyClient({ disableCache: true });
        await assert.rejects(() => client.get('/me'), (err: Error) => {
          assert.match(err.message, /token file/);
          assert.ok(
            err.message.includes(workFile()),
            `the failure must name the active profile's file ${workFile()}, got: ${err.message}`,
          );
          assert.ok(
            !err.message.includes(`${defaultFile()}`),
            `the failure named the default profile's file instead: ${err.message}`,
          );
          return true;
        });
      });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The persisted read cache is named after the SAME profile (#609)
// ---------------------------------------------------------------------------

describe('the persisted cache follows the same token path', () => {
  it('gives a --profile session its own cache file, not the default account’s', async () => {
    // The cache is per-account state, derived from the token file's own name
    // (#1249). It called `getTokenFile(undefined, env)`, and that `undefined`
    // reads as "no profile" while actually DISCARDING `--profile work` — so a
    // named-profile server persisted its reads into the default account's
    // `cache.json`, and the next account to authenticate inherited them. Same
    // cross-account read leak as the token bug, one layer out.
    const { cachePersistPath, cachePendingPath } = await import('../src/cachepersist.js');
    const store = join(home, '.spotify-mcp');

    assert.equal(
      await withArgvAsync(['--profile', 'work'], () => cachePersistPath()),
      join(store, 'cache.work.json'),
      '--profile work must not write into the default account’s cache.json',
    );
    assert.equal(
      cachePersistPath(),
      join(store, 'cache.json'),
      'the control: with no profile the default cache name is unchanged',
    );
    assert.equal(
      await withArgvAsync(['--profile', 'work'], () => cachePendingPath()),
      join(store, 'cache.work.json.pending'),
      'the pending-save marker inherits the same profile suffix',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. The doctor reads and prints the ACTIVE profile's token file
// ---------------------------------------------------------------------------

function escapeRe(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A client that refuses every network call — the doctor must not need one. */
function offlineClient(): SpotifyClient {
  return {
    get: async () => {
      throw new Error('offline stub: no network in this test');
    },
    getRateLimitStatus: () => ({
      lastThrottleAt: null,
      retryAfterSec: null,
      cooldownRemainingMs: 0,
      requestsTotal: 0,
      requestsLastMinute: 0,
      requestsLastHour: 0,
      cacheEntries: 0,
      cacheBytes: 0,
      cacheMaxBytes: 0,
      cacheSkippedOversize: 0,
    }),
  } as unknown as SpotifyClient;
}

describe('the doctor follows the active profile', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    // The in-server tool drives a REAL client, and a real client authenticates
    // — so the wire has to be stubbed, or this test would reach Spotify with a
    // fixture token.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: 'listener', type: 'user', country: 'GB' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('defaults to the CLIENT’S token file when the caller names none', async () => {
    // The in-server `spotify_doctor` tool calls `collectDoctorReport(client)`
    // with no third argument, so the DEFAULT resolution is what that surface
    // gets. It has to be the client's own `tokenFile` — the very file the
    // client authenticates with — not the env-only config snapshot, which is
    // what this used to read and which names the default account whenever argv
    // named a profile.
    await seed('tokens.json', expired(DEFAULT_TOKEN));
    await seed('tokens.work.json', validUntil(7_200_000, WORK_TOKEN));

    const { SpotifyClient } = await import('../src/client.js');
    const { collectDoctorReport } = await import('../src/tools/doctortool.js') as {
      collectDoctorReport: (c: SpotifyClient, s?: unknown, o?: { tokenFile?: string }) => Promise<{ rows: { id: string; status: string; summary: string }[] }>;
    };
    const report = await withArgvAsync(['--profile', 'work'], async () =>
      collectDoctorReport(new SpotifyClient({ disableCache: true })));

    const token = report.rows.find((r) => r.id === 'token');
    assert.equal(
      token!.status,
      'pass',
      `the work profile's token is valid; the doctor said: ${token!.summary}`,
    );
    assert.ok(
      token!.summary.includes(workFile()),
      `the report must default to the client's own token file: ${token!.summary}`,
    );
  });

  it('reads the named profile’s token file, not the default one', async () => {
    // The default account's token is EXPIRED and the work account's is valid.
    // A doctor that reads tokens.json reports a perfectly healthy session as
    // needing re-auth — and tells the operator to re-auth a profile that is
    // already authenticated.
    await seed('tokens.json', expired(DEFAULT_TOKEN));
    await seed('tokens.work.json', validUntil(7_200_000, WORK_TOKEN));

    const { collectDoctorReport } = await import('../src/tools/doctortool.js') as {
      collectDoctorReport: (c: SpotifyClient, s?: unknown, o?: { tokenFile?: string }) => Promise<{ rows: { id: string; status: string; summary: string }[] }>;
    };
    const tokenFile = await withArgvAsync(['--profile', 'work'], () => tokenPath());
    const report = await collectDoctorReport(offlineClient(), undefined, { tokenFile });

    const token = report.rows.find((r) => r.id === 'token');
    assert.ok(token, 'the doctor must emit a token row');
    assert.equal(
      token!.status,
      'pass',
      `the work profile's token is valid; the doctor said: ${token!.summary}`,
    );
    assert.ok(
      token!.summary.includes(workFile()),
      `the token row must name the active profile's file: ${token!.summary}`,
    );

    const config = report.rows.find((r) => r.id === 'config');
    assert.ok(
      config!.summary.includes(`token_file=${workFile()}`),
      `the config row must name the active profile's file: ${config!.summary}`,
    );
  });

  it('reports the EXPIRED token of the named profile instead of the healthy default one', async () => {
    await seed('tokens.work.json', expired(WORK_TOKEN));
    await seed('tokens.json', validUntil(7_200_000, DEFAULT_TOKEN));

    const { collectDoctorReport } = await import('../src/tools/doctortool.js') as {
      collectDoctorReport: (c: SpotifyClient, s?: unknown, o?: { tokenFile?: string }) => Promise<{ rows: { id: string; status: string; summary: string }[] }>;
    };
    const tokenFile = await withArgvAsync(['--profile', 'work'], () => tokenPath());
    const report = await collectDoctorReport(offlineClient(), undefined, { tokenFile });

    const token = report.rows.find((r) => r.id === 'token');
    assert.equal(
      token!.status,
      'warn',
      `the work profile's token is expired; the doctor said: ${token!.summary}`,
    );
    assert.match(token!.summary, /EXPIRED/);
  });

  it('`spotify-mcp doctor --profile work` prints the work file and a profile row', () => {
    // The CLI is the surface a user pastes into a bug report, so what it
    // PRINTS is the contract, not just what it reads. Spawned rather than
    // called in-process: a test that invoked runDoctor directly would still
    // pass with the CLI reverted to its own inline resolution.
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/index.ts', 'doctor', '--profile', 'work'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 120_000,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          SPOTIFY_CLIENT_ID: 'test-client-id',
        },
      },
    );
    const stdout = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    // Matched on a whitespace-tolerant basis: the column padding is cosmetic,
    // the PATH is the contract.
    assert.match(
      stdout,
      new RegExp(`^\\s*token file\\s+${escapeRe(workFile())}\\s*$`, 'm'),
      `the CLI must print the active profile's token file. Output was:\n${stdout}`,
    );
    assert.match(
      stdout,
      /^\s*profile\s+work\s*$/m,
      `the CLI must print a profile row for the argv profile. Output was:\n${stdout}`,
    );
    assert.doesNotMatch(
      stdout,
      new RegExp(`^\\s*token file\\s+${escapeRe(defaultFile())}\\s*$`, 'm'),
      `the CLI printed the default profile's file instead. Output was:\n${stdout}`,
    );
    assert.match(stdout, /\[token\] token valid/, `the work token is valid; the CLI said:\n${stdout}`);
  });
});
