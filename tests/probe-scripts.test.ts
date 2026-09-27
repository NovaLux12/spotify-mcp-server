/**
 * Guard for the standalone probe scripts (#646).
 *
 * `scripts/contains-check.mjs` and `scripts/edge-probe.mjs` are the only files
 * in this repository that talk to a live Spotify account on purpose, and they
 * are run by a human rather than by CI. That combination is why the three
 * defects this pins are all invisible to the rest of the suite:
 *
 *  - **Identity.** Both scripts fetch `/v1/me` and both wrote what came back.
 *    `contains-check.mjs` also carried the maintainer's own username and a
 *    private playlist id as literals in a public file. A probe report is
 *    precisely the artifact people paste into an issue, so "it is in a gitignored
 *    directory" was never a control.
 *  - **Report paths.** The default filename was a literal date string written
 *    when the script was authored, the directory was never created, and the
 *    file was written 0664. A clean checkout lost the whole run to ENOENT *after*
 *    ~37 live requests, and two runs on one day silently overwrote each other.
 *  - **Quota.** A 429 was a classification label. The loop then slept a fixed
 *    800 ms and kept going, so one throttle cost ~40 more requests inside the
 *    penalty window against a developer app registration that the interactive
 *    server shares.
 *
 * Nothing here runs against Spotify. The transport is replaced at `globalThis`
 * by a stub loaded with `--import` (the same seam the scripts already use for
 * `fetch`), and the timing assertions are driven by an injected `sleep`, so
 * the suite asserts the delay the script *decides* rather than waiting it out.
 * The subprocess tests spawn the real script so the argv handling, the report
 * write and the exit codes are observed rather than asserted about.
 *
 * No test in this file reads or writes `~/.spotify-mcp/`: every run gets a
 * `mkdtemp` home and an explicit `SPOTIFY_MCP_TOKEN_FILE` under it.
 */

import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EDGE_PROBE = join(ROOT, 'scripts/edge-probe.mjs');
const CONTAINS_CHECK = join(ROOT, 'scripts/contains-check.mjs');
const RUN_TIMEOUT_MS = 60_000;

/** The id the stubbed `/v1/me` reports. Nothing else may emit it. */
const FAKE_UID = 'probeuidABCDEFGHIJKLMNOP';

/**
 * A synthetic playlist id, in the 22-character Spotify shape the script checks
 * for. Deliberately not a real one: the id this replaced was the maintainer's
 * private playlist, and moving it from `scripts/contains-check.mjs` into a test
 * fixture would have shipped exactly the identity the fix exists to remove. A
 * test asserting "the private id is gone from the source" must not carry the
 * private id itself, or the assertion is theatre.
 */
const FAKE_PLAYLIST_ID = '4Gh2ZqT0cQWJmB8nR1xLpA';

/** Profile fields the stubbed `/v1/users/{id}` and `/v1/me` bodies carry. */
const FAKE_EMAIL = 'maintainer@example.invalid';
const FAKE_DISPLAY_NAME = 'Maintainer Example';

/**
 * Replaces `globalThis.fetch` before the script under test runs. The plan is an
 * ordered list of `{status, headers?, body?}`; each probe consumes one entry and
 * the last entry repeats forever, so a plan can be "429, 429, 200, then 200".
 */
const STUB = `
import { appendFileSync } from 'node:fs';

const plan = JSON.parse(process.env.PROBE_STUB_PLAN || '[]');
const log = process.env.PROBE_STUB_LOG;
let call = 0;
let uid = null;

globalThis.fetch = async (rawUrl, init = {}) => {
  const url = String(rawUrl);
  const json = (status, body, headers = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const record = (status) => {
    if (log) appendFileSync(log, JSON.stringify({ t: Date.now(), url, method: init.method || 'GET', status }) + '\\n');
  };

  if (url.startsWith('https://accounts.spotify.com/')) {
    // #1459: the refresh is the ONE write this script makes to the operator's
    // live token store, and until the token endpoint can be made to answer 200
    // no test here ever reached it. \`refreshBody\` is what Spotify returns on a
    // successful refresh; the default stays invalid_grant so every pre-existing
    // test keeps its "no refresh happened" precondition.
    const refreshBody = JSON.parse(process.env.PROBE_STUB_REFRESH || 'null');
    if (refreshBody) {
      record(200);
      return json(200, refreshBody);
    }
    return json(400, { error: 'invalid_grant' });
  }
  // /v1/me is setup, not a probe: it answers from the stub's own data and must
  // not consume a step of the probe plan, or the script's first probe would
  // see a step the test meant for a later one.
  if (url === 'https://api.spotify.com/v1/me') {
    record(200);
    uid = ${JSON.stringify(FAKE_UID)};
    return json(200, {
      id: uid,
      display_name: ${JSON.stringify(FAKE_DISPLAY_NAME)},
      email: ${JSON.stringify(FAKE_EMAIL)},
      country: 'GB',
      product: 'premium',
      uri: 'spotify:user:' + uid,
    });
  }
  const step = plan[Math.min(call, plan.length - 1)] || { status: 200, body: { ok: true } };
  call += 1;
  const headers = {};
  if (step.headers) for (const [k, v] of Object.entries(step.headers)) headers[k] = v;
  record(step.status);
  return json(step.status, step.body ?? { status: step.status, message: 'stubbed' }, headers);
};
`;

/** One stubbed probe step. */
type Step = { status: number; headers?: Record<string, string>; body?: unknown };

/** One recorded request: when it went, where, and what the stub answered. */
type Call = { t: number; url: string; method: string; status: number };

type Run = { status: number | null; output: string; calls: Call[] };

type Sandbox = {
  dir: string;
  home: string;
  log: string;
  /** The sandbox's own token store — never the operator's real one. */
  tokenFile: string;
  run(script: 'edge-probe' | 'contains-check', args: string[], plan: Step[], env?: Record<string, string>): Run;
  reportDir(): string;
  /** Requests recorded so far across every run in this sandbox. */
  callsMade(): number;
};

/**
 * A throwaway checkout: the real scripts, a fake `.env` and a fake token file.
 * The scripts resolve `ROOT` from their own location and `~` from `$HOME`, so
 * copying them into a temp tree is what keeps the run off the real repository
 * and the real `~/.spotify-mcp/`.
 */
function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'probe-guard-'));
  const home = join(dir, 'home');
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(home, '.spotify-mcp'), { recursive: true });
  copyFileSync(EDGE_PROBE, join(dir, 'scripts/edge-probe.mjs'));
  copyFileSync(CONTAINS_CHECK, join(dir, 'scripts/contains-check.mjs'));
  // Copied when present so the sandbox mirrors the real scripts directory; the
  // import of it is a separate, per-test step (see `loadLib`) so a missing
  // module fails one assertion rather than cancelling the whole file.
  const libPath = join(ROOT, 'scripts/probe-lib.mjs');
  if (existsSync(libPath)) copyFileSync(libPath, join(dir, 'scripts/probe-lib.mjs'));
  writeFileSync(join(dir, '.env'), 'SPOTIFY_CLIENT_ID=stub-client-id\n');
  const tokenFile = join(home, '.spotify-mcp/tokens.json');
  writeFileSync(
    tokenFile,
    JSON.stringify({ access_token: 'stub-access', refresh_token: 'stub-refresh', expires_at: Date.now() + 3_600_000 }),
  );
  writeFileSync(join(dir, 'stub.mjs'), STUB);
  const log = join(dir, 'calls.jsonl');

  return {
    dir,
    home,
    log,
    tokenFile,
    reportDir: () => join(dir, 'memory'),
    callsMade: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0),
    run: (script, args, plan, env = {}) => {
      const result: SpawnSyncReturns<string> = spawnSync(
        process.execPath,
        ['--import', join(dir, 'stub.mjs'), join(dir, `scripts/${script}.mjs`), ...args],
        {
          cwd: dir,
          encoding: 'utf8',
          timeout: RUN_TIMEOUT_MS,
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            PROBE_STUB_PLAN: JSON.stringify(plan),
            PROBE_STUB_LOG: log,
            ...env,
          },
        },
      );
      assert.equal(result.error, undefined, `the script failed to launch: ${String(result.error)}`);
      const calls = (existsSync(log) ? readFileSync(log, 'utf8') : '')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Call);
      return { status: result.status, output: `${result.stdout}\n${result.stderr}`, calls };
    },
  };
}

/** Every file the probe may have left behind, relative to the sandbox root. */
function artefacts(box: Sandbox): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'home' || entry.name === 'stub.mjs' || entry.name === 'calls.jsonl') continue;
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), `${rel}/`);
      else out.push(rel);
    }
  };
  walk(box.dir, '');
  return out;
}

function reportOf(box: Sandbox): { path: string; json: Record<string, unknown> } {
  const dir = box.reportDir();
  assert.ok(existsSync(dir), 'the report directory was never created');
  const files = readdirSync(dir);
  assert.equal(files.length, 1, `expected exactly one report, found ${JSON.stringify(files)}`);
  const path = join(dir, files[0]!);
  return { path, json: JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> };
}

// --- the module under test, imported for the decisions rather than the run ---

type Sleep = (ms: number) => Promise<void>;
type ProbeRun = {
  quotaWall: boolean;
  results: Array<{ label: string; status: number; cls: string; snippet: string; path: string }>;
  runAt: string;
  user: string | null;
};

type ProbeLib = {
  runProbes: (options: Record<string, unknown>) => Promise<ProbeRun>;
  redactSnippet: (body: string, uid: string) => string;
  redactUser: (uid: string) => string | null;
  resolveReportPath: (raw: string | undefined, options: Record<string, unknown>) => string;
  parseRetryAfterSeconds: (header: string | null, now?: number) => number;
};

/**
 * Loaded on first use rather than at module scope: a module that will not
 * import must fail the tests that need it, not cancel the whole file and take
 * the subprocess assertions — the ones that observe the real scripts — with it.
 */
let pending: Promise<ProbeLib> | null = null;
function loadLib(): Promise<ProbeLib> {
  pending ??= import(pathToFileURL(join(ROOT, 'scripts/probe-lib.mjs')).href) as Promise<ProbeLib>;
  return pending;
}

/** A `sleep` that records what it was asked to wait and returns immediately. */
function recordingSleep(): Sleep & { delays: number[] } {
  const delays: number[] = [];
  const sleep = (async (ms: number) => {
    delays.push(ms);
  }) as Sleep & { delays: number[] };
  sleep.delays = delays;
  return sleep;
}

/** A fetch that answers with the given steps, in order, repeating the last. */
function stubFetch(plan: Step[]): { impl: (url: string) => Promise<Response>; calls: () => number } {
  let call = 0;
  let uid: string | null = null;
  const impl = async (rawUrl: string): Promise<Response> => {
    const url = String(rawUrl);
    const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      });
    if (url === 'https://api.spotify.com/v1/me') {
      uid = FAKE_UID;
      return json(200, { id: uid, display_name: FAKE_DISPLAY_NAME, email: FAKE_EMAIL, country: 'GB', product: 'premium' });
    }
    const step = plan[Math.min(call, plan.length - 1)] ?? { status: 200 };
    call += 1;
    return json(step.status, step.body ?? { status: step.status }, step.headers ?? {});
  };
  return { impl, calls: () => call };
}

const MINIMAL_PROBES = [
  ['alpha', 'GET', '/v1/alpha'],
  ['beta', 'GET', '/v1/beta'],
  ['gamma', 'GET', '/v1/gamma'],
] as const;

const BASE = {
  probes: MINIMAL_PROBES.map(([label, method, path]) => [label, method, path]),
  token: {},
  log: () => {},
  intervalMs: 0,
  reportPath: join(tmpdir(), 'probe-guard-unit.json'),
  now: () => '2026-09-27T00:00:00.000Z',
  attemptTimeoutMs: 15_000,
};

describe('probe-lib quota handling (#646)', () => {
  it('waits exactly the Retry-After the server asked for, before the retry leaves', async () => {
    const lib = await loadLib();

    // Two different values, so a fixed fallback cannot pass both.
    for (const seconds of ['7', '3']) {
      const sleep = recordingSleep();
      const fetch = stubFetch([
        { status: 429, headers: { 'retry-after': seconds } },
        { status: 200 },
        { status: 200 },
        { status: 200 },
      ]);

      const run = await lib.runProbes({ ...BASE, fetchImpl: fetch.impl, sleep, runAt: () => BASE.now() });

      assert.equal(
        sleep.delays[0],
        Number(seconds) * 1000,
        `Retry-After: ${seconds} must be honoured to the millisecond, not approximated: ${JSON.stringify(sleep.delays)}`,
      );
      assert.equal(run.results[0]!.status, 200, 'the probe has to be re-sent once the wait is over');
    }
  });

  it('doubles the wait on a repeated 429, and gives up into a quota wall rather than looping', async () => {
    const lib = await loadLib();

    const sleep = recordingSleep();
    const fetch = stubFetch([{ status: 429, headers: { 'retry-after': '7' } }]);

    const run = await lib.runProbes({ ...BASE, fetchImpl: fetch.impl, sleep, runAt: () => BASE.now() });

    assert.deepEqual(
      sleep.delays.slice(0, 2),
      [7000, 14000],
      `a second 429 on the same probe must wait longer than the first: ${JSON.stringify(sleep.delays)}`,
    );
    assert.equal(
      fetch.calls(),
      3,
      'three dispatches per probe is the bound; a fourth would be a tight retry loop against a live API',
    );
    assert.equal(run.quotaWall, true, 'a probe that never escapes 429 is a quota wall, not a QUOTA label');
    assert.equal(
      run.results.filter((r) => r.cls === 'NOT-RUN').length,
      2,
      'the probes that were never sent must be recorded, not silently dropped from the total',
    );
  });

  it('never issues a second request inside the penalty window, measured on the wire', async () => {
    const box = sandbox();
    const before = Date.now();
    const run = box.run(
      'edge-probe',
      ['--only', 'markets', '--interval-ms', '0'],
      [{ status: 429, headers: { 'retry-after': '2' } }, { status: 200 }, { status: 200 }],
    );
    const elapsed = Date.now() - before;

    assert.equal(run.status, 0, run.output);
    // Only the gap that follows a 429 is governed by the penalty window; the
    // first probe is a normal request and the /v1/me read before it is not one
    // the script delayed for any reason.
    const afterThrottle = run.calls
      .map((call, i) => ({ call, next: run.calls[i + 1] }))
      .filter((pair) => pair.call.status === 429 && pair.next !== undefined)
      .map((pair) => (pair.next as Call).t - pair.call.t);
    assert.ok(afterThrottle.length > 0, `no 429 was recorded, so nothing was measured: ${JSON.stringify(run.calls)}`);
    assert.ok(
      afterThrottle.every((gap) => gap >= 2000),
      `a retry must land outside the 2 s penalty window, gaps were ${JSON.stringify(afterThrottle)}`,
    );
    assert.ok(elapsed >= 2000, `the run took ${elapsed}ms; the wait was skipped`);
  });

  it('honours an HTTP-date Retry-After and a past one means retry now', async () => {
    const lib = await loadLib();

    const now = Date.parse('2026-09-27T00:00:00.000Z');
    assert.equal(lib.parseRetryAfterSeconds('Sun, 27 Sep 2026 00:00:20 GMT', now), 20);
    assert.equal(lib.parseRetryAfterSeconds('Sun, 27 Sep 2026 00:00:00 GMT', now), 0);
    // Absent, garbage and a bare signed number all keep a usable floor rather
    // than poisoning the wait with NaN.
    assert.ok(Number.isFinite(lib.parseRetryAfterSeconds(null)));
    assert.ok(Number.isFinite(lib.parseRetryAfterSeconds('soon')));
    assert.equal(lib.parseRetryAfterSeconds('-5', now), 1, 'Date.parse reads a bare number as a year');
  });

  it('backs off exponentially on 5xx the way the client does, without inventing retries for a 404', async () => {
    const lib = await loadLib();

    const sleep = recordingSleep();
    const fetch = stubFetch([{ status: 503 }, { status: 503 }, { status: 200 }, { status: 200 }]);

    const run = await lib.runProbes({ ...BASE, fetchImpl: fetch.impl, sleep, runAt: () => BASE.now() });

    assert.deepEqual(sleep.delays.slice(0, 2), [250, 500], `expected the client's 250/500 ms ladder: ${JSON.stringify(sleep.delays)}`);
    assert.equal(run.results[0]!.status, 200);

    const gone = recordingSleep();
    const goneFetch = stubFetch([{ status: 404 }, { status: 404 }, { status: 404 }]);
    const goneRun = await lib.runProbes({ ...BASE, fetchImpl: goneFetch.impl, sleep: gone, runAt: () => BASE.now() });
    assert.deepEqual(gone.delays, [], 'a 404 is an answer, not a transient failure');
    assert.equal(goneRun.results.filter((r) => r.cls === 'DEAD').length, 3);
  });

  it('records a 200 with an empty body instead of throwing on it', async () => {
    const lib = await loadLib();

    // A 200 whose body is zero-length is a real answer, and the sweep
    // reclassifies it to ALIVE(empty) on the way into the report. The row is
    // built after the retry loop, so a binding that cannot be reassigned
    // throws here — and it throws after the request was already sent, which is
    // the expensive place to lose a sweep.
    const sleep = recordingSleep();
    const fetch = stubFetch([{ status: 200, body: '' }]);

    const run = await lib.runProbes({ ...BASE, fetchImpl: fetch.impl, sleep, runAt: () => BASE.now() });

    assert.equal(run.results[0]!.cls, 'ALIVE(empty)');
    assert.equal(run.results.length, 3, 'the sweep must continue past an empty body');
  });
});

describe('probe-lib identity redaction (#646)', () => {
  it('sends the real id but records a redacted path, so the probe still asks its question', async () => {
    const lib = await loadLib();

    const sleep = recordingSleep();
    const requested: string[] = [];
    const impl = async (url: string): Promise<Response> => {
      if (url === 'https://api.spotify.com/v1/me') {
        return new Response(JSON.stringify({ id: FAKE_UID }), { status: 200 });
      }
      requested.push(url);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const probes = [
      ['me-profile', 'GET', '/v1/users/{{uid}}'],
      ['me-playlists', 'GET', '/v1/users/{{uid}}/playlists?limit=3'],
    ];

    const run = await lib.runProbes({ ...BASE, probes, fetchImpl: impl, sleep, runAt: () => BASE.now() });
    const serialised = JSON.stringify(run);

    assert.ok(!serialised.includes(FAKE_UID), `the account id reached the report: ${serialised}`);
    // The request is the half that has to keep the real id: redacting it would
    // turn an app-gating question into a 404 about a placeholder, and the
    // probe would report a wrong answer while looking like it worked.
    assert.ok(
      requested.every((url) => url.includes(FAKE_UID)),
      `the request must carry the real id or the probe answers a different question: ${JSON.stringify(requested)}`,
    );
    assert.equal(run.results[0]!.path, '/v1/users/<redacted>', 'the recorded path is the request with the id removed');
    assert.equal(run.results[1]!.path, '/v1/users/<redacted>/playlists?limit=3');
  });

  it('keeps the account id out of every field of the run, including the probe paths', async () => {
    const lib = await loadLib();

    const sleep = recordingSleep();
    const fetch = stubFetch([{ status: 200 }]);
    const probes = [
      ['me-profile', 'GET', '/v1/users/{{uid}}'],
      ['me-playlists', 'GET', '/v1/users/{{uid}}/playlists?limit=3'],
    ];

    const run = await lib.runProbes({ ...BASE, probes, fetchImpl: fetch.impl, sleep, runAt: () => BASE.now() });
    const serialised = JSON.stringify(run);

    assert.ok(!serialised.includes(FAKE_UID), `the account id reached the report: ${serialised}`);
    assert.ok(run.user !== null, 'a readable /v1/me must leave a user field, even if redacted');
    assert.ok(
      !String(run.user).includes(FAKE_UID) && !String(run.user).includes(FAKE_UID.slice(0, 4)),
      `the user field must be a redaction, not the id or a prefix of it: ${String(run.user)}`,
    );
    assert.equal(run.results[0]!.path, '/v1/users/<redacted>', 'a path that carries the id is still the id');
  });

  it('scrubs identity fields out of a response snippet, and keeps a diagnosable one', async () => {
    const lib = await loadLib();

    // A profile object *and* the error envelope a real 4xx arrives in, so the
    // assertion covers both halves: the identifying fields go, the status and
    // message a reader needs to act on stay.
    const body = JSON.stringify({
      error: { status: 404, message: 'non existing user' },
      id: FAKE_UID,
      display_name: FAKE_DISPLAY_NAME,
      email: FAKE_EMAIL,
      country: 'GB',
      product: 'premium',
      uri: `spotify:user:${FAKE_UID}`,
      external_urls: { spotify: `https://open.spotify.com/user/${FAKE_UID}` },
    });

    const redacted = lib.redactSnippet(body, FAKE_UID);

    for (const secret of [FAKE_UID, FAKE_DISPLAY_NAME, FAKE_EMAIL]) {
      assert.ok(!redacted.includes(secret), `${secret} survived redaction: ${redacted}`);
    }
    assert.match(redacted, /non existing user/, 'a Spotify error body must stay diagnosable after redaction');
    assert.match(redacted, /404/, 'the status code is the part a probe report exists to record');
    assert.match(redacted, /<redacted>/, 'a blanked field is shown as blank, not silently dropped');
    // Compared as a value, not as text: the redaction round-trips the body
    // through JSON, so `429` legitimately comes back as `"429"`.
    assert.deepEqual(
      JSON.parse(lib.redactSnippet(JSON.stringify({ error: { status: 429, message: 'rate limited' } }), FAKE_UID)),
      { error: { status: 429, message: 'rate limited' } },
      'a body carrying no account identity must survive redaction intact',
    );
  });

  it('redacts the id in prose, not only in JSON', async () => {
    const lib = await loadLib();

    assert.equal(
      lib.redactSnippet(`no such user: ${FAKE_UID} (id ${FAKE_UID})`, FAKE_UID).includes(FAKE_UID),
      false,
    );
    assert.equal(lib.redactUser(''), null, 'an unreadable /v1/me is null, not an empty string that looks like an id');
  });
});

describe('probe-lib report paths (#646)', () => {
  it('defaults to a dated, per-run name and refuses a path that is not a .json file', async () => {
    const lib = await loadLib();

    const created: string[] = [];
    const mk = (path: string) => {
      created.push(path);
      return { isDirectory: () => false, existsSync: () => false };
    };
    const day = '2026-09-27';

    const first = lib.resolveReportPath(undefined, {
      root: '/repo',
      runAt: `${day}T09:00:00.000Z`,
      existsSync: mk,
      isDirectory: () => false,
    });
    const second = lib.resolveReportPath(undefined, {
      root: '/repo',
      runAt: `${day}T10:30:00.000Z`,
      existsSync: mk,
      isDirectory: () => false,
    });

    assert.match(first, new RegExp(`${day}`), `the default name must carry the run date: ${first}`);
    assert.notEqual(first, second, 'two runs on one day must not write the same file');
    assert.equal(first.startsWith('/repo/memory/'), true, `reports belong under the repo: ${first}`);

    for (const bad of ['', '   ', 'report', 'report.json\nrm -rf /', 'sub/../../escape.json\tx']) {
      assert.throws(
        () => lib.resolveReportPath(bad, { root: '/repo', runAt: `${day}T09:00:00.000Z`, existsSync: mk, isDirectory: () => false }),
        /\.json/,
        `a report path must be validated, but ${JSON.stringify(bad)} was accepted`,
      );
    }
  });
});

describe('contains-check.mjs (#646)', () => {
  it('carries no maintainer identity in its source', () => {
    const source = readFileSync(CONTAINS_CHECK, 'utf8');
    assert.doesNotMatch(source, /j\.lee12/, 'the hardcoded maintainer username must be gone');
    assert.doesNotMatch(
      source,
      /37i9dQZF1DXcBWIGoYBM5M/,
      'the hardcoded private playlist id must be gone — it is a parameter, not a constant',
    );
  });

  it('prints a one-line usage message and reaches no network when the ids are missing', () => {
    const box = sandbox();

    const run = box.run('contains-check', [], [{ status: 200 }]);

    assert.equal(run.status, 2, run.output);
    assert.match(run.output, /usage: node scripts\/contains-check\.mjs <user-id> <playlist-id>/);
    assert.deepEqual(run.calls, [], 'a usage error must not spend a request against a live account');

    // The message has to name the arity, not the id shape. Without the arity
    // guard a missing argument falls through to the shape check, and
    // "playlist-id undefined is not a Spotify id" is what the caller is told —
    // which describes a value they never typed.
    assert.match(run.output, /expected exactly a user id and a playlist id/);
  });

  it('refuses an extra argument rather than silently dropping it', () => {
    const box = sandbox();

    // Both ids are valid here, so the shape check passes them and the arity
    // guard is the only thing standing between three arguments and a run that
    // quietly probes with the first two. A caller who pasted a user id, a
    // playlist id and a track id would otherwise get a clean exit 0 and no
    // indication that their third argument was discarded.
    const run = box.run('contains-check', ['someone', FAKE_PLAYLIST_ID, '4uLU6hMCjMI75M1A2tKUQC'], [{ status: 200 }]);

    assert.equal(run.status, 2, run.output);
    assert.match(run.output, /expected exactly a user id and a playlist id/);
    assert.deepEqual(run.calls, [], 'a refused run must not spend a request against a live account');
  });

  it('refuses a user id carrying a control character, before it is used or printed', () => {
    const box = sandbox();

    // The playlist id is a path segment and the user id is a query value, so
    // the user id is not held to a 22-character shape. It still is held to
    // "printable, one line": an id with a newline in it is not a Spotify id,
    // and every place the script echoes a rejected value is a place a newline
    // would otherwise break the line a human is reading.
    const run = box.run('contains-check', ['someone\ninjected: line', FAKE_PLAYLIST_ID], [{ status: 200 }]);

    assert.equal(run.status, 2, run.output);
    assert.match(run.output, /user-id .* is not a Spotify id/);
    assert.deepEqual(run.calls, [], 'a refused run must not spend a request against a live account');
  });

  it('probes the supplied ids, URL-encoded, and resolves the token the way config.ts does', () => {
    const box = sandbox();

    // The user id carries a slash and dots, so the assertion can tell an
    // encoded value from a raw interpolation; the playlist id is a real one so
    // the path segment assertion is against a shape the server accepts.
    const run = box.run('contains-check', ['user/../id', FAKE_PLAYLIST_ID], [{ status: 200 }]);

    assert.equal(run.status, 0, run.output);
    const followers = run.calls.find((c) => c.url.includes('/followers/contains'));
    assert.ok(followers, `no followers/contains probe was issued: ${run.output}`);
    // `.` is an unreserved character and is correctly left alone; the `/`
    // separators are what percent-encoding has to catch here.
    assert.match(
      followers.url,
      new RegExp(`\\/v1\\/playlists\\/${FAKE_PLAYLIST_ID}\\/followers\\/contains\\?ids=user%2F\\.\\.%2Fid`),
    );
    assert.doesNotMatch(followers.url, /ids=user\/\.\.\/id/, 'an id must be percent-encoded, not interpolated raw');

    // A playlist id that would traverse the path is refused before any request
    // is built from it — the path segment and the query value need different
    // rules, and this is the one that matters for the path.
    const before = box.callsMade();
    const traversal = box.run('contains-check', ['someone', '../../me/player'], [{ status: 200 }]);
    assert.equal(traversal.status, 2, traversal.output);
    assert.match(traversal.output, /playlist-id .* is not a Spotify id/);
    assert.equal(box.callsMade(), before, 'the refused run must not have spent a request against a live account');

    // The profile-aware token file, proved by removing the default one: a
    // script that read the hardcoded path would now find nothing.
    const profiled = sandbox();
    rmSync(join(profiled.home, '.spotify-mcp/tokens.json'));
    writeFileSync(
      join(profiled.home, '.spotify-mcp/tokens.work.json'),
      JSON.stringify({ access_token: 'stub-work', expires_at: Date.now() + 3_600_000 }),
    );
    const run2 = profiled.run('contains-check', ['someone', FAKE_PLAYLIST_ID], [{ status: 200 }], {
      SPOTIFY_MCP_PROFILE: 'work',
    });
    assert.equal(run2.status, 0, run2.output);
    assert.ok(run2.calls.length > 0, 'the profiled run must actually have probed something');

    const missing = sandbox();
    rmSync(join(missing.home, '.spotify-mcp/tokens.json'));
    const noProfile = missing.run('contains-check', ['someone', FAKE_PLAYLIST_ID], [{ status: 200 }]);
    assert.equal(noProfile.status, 1, noProfile.output);
    assert.match(noProfile.output, /npm run auth/, 'a missing token file needs the command that makes one');
  });

  it('is discoverable through an npm script', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    assert.match(pkg.scripts['probe:contains'] ?? '', /contains-check\.mjs/, 'the script is dead code if no npm entry names it');
  });
});

describe('edge-probe.mjs subprocess behaviour (#646)', () => {
  it('explains a missing .env instead of dying with ENOENT', () => {
    const box = sandbox();
    rmSync(join(box.dir, '.env'));

    const run = box.run('edge-probe', [], [{ status: 200 }]);

    assert.equal(run.status, 1, run.output);
    assert.doesNotMatch(run.output, /ENOENT/, `the raw fs error is what this defect was: ${run.output}`);
    assert.match(run.output, /\.env\.example/);
    assert.deepEqual(run.calls, [], 'the friendly check has to come before any request');
  });

  it('creates the report directory, names the file for today, and keeps it owner-only', () => {
    const box = sandbox();

    const run = box.run('edge-probe', ['--only', 'markets', '--interval-ms', '0'], [{ status: 200 }]);

    assert.equal(run.status, 0, run.output);
    const { path, json } = reportOf(box);
    const today = new Date().toISOString().slice(0, 10);
    assert.ok(
      readFileSync(path, 'utf8').length > 0 && path.includes(today),
      `the report name must carry today's date, got ${path}`,
    );
    assert.equal(statSync(path).mode & 0o777, 0o600, 'a report naming a live account is not world-readable');
    assert.equal(statSync(box.reportDir()).mode & 0o777, 0o700);
    assert.equal(typeof json['total'], 'number');
  });

  it('refuses to overwrite a previous report unless told to, and never runs a mutation', () => {
    const box = sandbox();
    mkdirSync(box.reportDir(), { recursive: true });
    const existing = join(box.reportDir(), 'edge-probe-prior.json');
    writeFileSync(existing, JSON.stringify({ total: 1, results: [{ label: 'prior' }] }));

    const refused = box.run('edge-probe', [existing, '--interval-ms', '0'], [{ status: 200 }]);
    assert.equal(refused.status, 2, refused.output);
    assert.match(refused.output, /already exists/);
    assert.equal(readFileSync(existing, 'utf8'), JSON.stringify({ total: 1, results: [{ label: 'prior' }] }));

    const forced = box.run('edge-probe', [existing, '--force', '--interval-ms', '0'], [{ status: 200 }]);
    assert.equal(forced.status, 0, forced.output);
    assert.notEqual(readFileSync(existing, 'utf8'), JSON.stringify({ total: 1, results: [{ label: 'prior' }] }));

    // Every probe is a GET, and a 405 probe is still a GET: the wrong-method
    // rows are the reason a POST-shaped path appears in the list at all.
    const box2 = sandbox();
    const all = box2.run('edge-probe', ['--interval-ms', '0'], [{ status: 200 }]);
    assert.equal(all.status, 0, all.output);
    assert.ok(
      all.calls.length > 20,
      `the full sweep did not run: ${all.calls.length} requests`,
    );
    assert.ok(
      all.calls.every((c) => c.method === 'GET'),
      `a probe issued a non-GET: ${all.calls.filter((c) => c.method !== 'GET').map((c) => c.method).join(', ')}`,
    );
  });

  it('writes a report that carries no account identity, in any file it leaves behind', () => {
    const box = sandbox();

    const run = box.run('edge-probe', ['--interval-ms', '0'], [{ status: 200 }]);

    assert.equal(run.status, 0, run.output);
    const secret = [FAKE_UID, FAKE_DISPLAY_NAME, FAKE_EMAIL];
    for (const file of artefacts(box)) {
      if (file === '.env' || file.startsWith('scripts/')) continue;
      const content = readFileSync(join(box.dir, file), 'utf8');
      for (const value of secret) {
        assert.ok(!content.includes(value), `${file} leaked ${value}`);
      }
    }
    // stdout is the other half of "anything they emit" — a report pasted into
    // an issue is usually the console transcript, not the file.
    for (const value of secret) {
      assert.ok(!run.output.includes(value), `stdout leaked ${value}:\n${run.output}`);
    }
  });

  it('exits resumable on a quota wall, and records the probes it never sent', () => {
    const box = sandbox();

    // The full sweep, not a filtered one: a quota wall is only worth anything
    // if the report says which probes the wall cost, and a single-probe run has
    // nothing left to mark.
    const run = box.run('edge-probe', ['--interval-ms', '0'], [
      { status: 429, headers: { 'retry-after': '1' } },
    ]);

    assert.equal(run.status, 3, run.output);
    assert.match(run.output, /QUOTA WALL/);
    const { json } = reportOf(box);
    const results = json['results'] as Array<{ cls: string }>;
    const notRun = results.filter((r) => r.cls === 'NOT-RUN');
    assert.ok(notRun.length > 20, `the wall should have spared most of the sweep, only ${notRun.length} were NOT-RUN`);
    assert.equal(
      results.filter((r) => r.cls === 'QUOTA').length,
      1,
      'the probe that hit the wall is the only one that may be recorded as QUOTA',
    );
    assert.equal(
      results.length,
      json['total'],
      'the total has to count the unsent probes, or the report reads as a completed sweep',
    );
    // One probe, three dispatches, and nothing after it: the defect this pins
    // was ~40 more requests fired into the penalty window.
    assert.ok(
      run.calls.filter((c) => c.url.includes('api.spotify.com') && !c.url.endsWith('/v1/me')).length <= 3,
      `a quota wall must end the run, not merely label a row: ${run.calls.length} requests went out`,
    );
  });

  it('resolves the token file the way config.ts does, not a hardcoded path', () => {
    const box = sandbox();
    const explicit = join(box.dir, 'explicit-tokens.json');
    writeFileSync(explicit, JSON.stringify({ access_token: 'stub-explicit', expires_at: Date.now() + 3_600_000 }));

    const run = box.run('edge-probe', ['--only', 'markets', '--interval-ms', '0'], [{ status: 200 }], {
      SPOTIFY_MCP_TOKEN_FILE: explicit,
    });

    assert.equal(run.status, 0, run.output);
    assert.ok(existsSync(explicit), 'an explicit token file must be the one that is read');
  });

  it('rejects an invalid profile instead of building a path out of it', () => {
    const box = sandbox();

    const run = box.run('edge-probe', ['--only', 'markets'], [{ status: 200 }], {
      SPOTIFY_MCP_PROFILE: '../escape',
    });

    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /SPOTIFY_MCP_PROFILE/);
    assert.doesNotMatch(run.output, /escape/);
    assert.deepEqual(run.calls, []);
  });
});

/**
 * The token refresh is the one write `edge-probe.mjs` makes, and it lands on
 * the operator's LIVE credential store (#1459).
 *
 * It was invisible to the suite for a structural reason rather than an
 * oversight: the stub answered `400 invalid_grant` to every call to
 * `accounts.spotify.com`, and the refresh only fires when the stored token is
 * within 60s of expiry. Every run therefore took the "token is still fresh"
 * branch, and the `writeFileSync` at the end of `refresh()` was never reached.
 * The stub can now answer 200, and the token store is seeded expired, so the
 * real script really performs the write.
 *
 * Why atomicity is asserted on an open file descriptor rather than on the
 * bytes at the path: the failure this issue describes is not "the new contents
 * are wrong", it is "the operator's only copy of a refresh token Spotify has
 * already rotated is destroyed mid-write". Holding an fd open across the write
 * models the crash exactly — the fd is a reader that was already looking at the
 * old document when the rename happened. Under `writeFileSync` that reader
 * watches the document it opened get truncated and rewritten underneath it; under
 * temp-file + `rename(2)` it keeps reading the complete previous document, and
 * the path swaps to a new inode atomically. The two are distinguished by inode
 * identity and by what the pre-existing fd can still read, both of which are
 * deterministic — no timing, no polling, nothing that can pass for the wrong
 * reason on a slow machine.
 */
describe('edge-probe.mjs token refresh (#1459)', () => {
  /** A token store that is already expired, so `refresh()` is not optional. */
  function seedExpired(box: Sandbox): string {
    const before = `${JSON.stringify({ access_token: 'stub-access', refresh_token: 'stub-refresh', expires_at: Date.now() - 60_000 }, null, 2)}\n`;
    writeFileSync(box.tokenFile, before);
    return before;
  }

  /** What Spotify returns on a successful refresh — note the ROTATED token. */
  const REFRESHED = { access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600 };

  it('never truncates the live token store: a reader holding the old document keeps it', () => {
    const box = sandbox();
    const before = seedExpired(box);
    // A reader that opened the store before the write — the crash model.
    const fd = openSync(box.tokenFile, 'r');
    try {
      const run = box.run('edge-probe', ['--only', 'markets', '--interval-ms', '0'], [{ status: 200 }], {
        PROBE_STUB_REFRESH: JSON.stringify(REFRESHED),
      });

      assert.equal(run.status, 0, run.output);
      assert.match(run.output, /token refreshed/, `the refresh never ran, so nothing was written:\n${run.output}`);
      // The whole point: this fd was opened on the pre-refresh document, and it
      // must still be able to read it in full. A truncating write destroys it.
      const stillOpen = Buffer.alloc(before.length);
      const read = readSync(fd, stillOpen, 0, stillOpen.length, 0);
      assert.equal(
        stillOpen.subarray(0, read).toString('utf8'),
        before,
        'the document a reader already had open was rewritten underneath it — the write is not atomic',
      );
    } finally {
      closeSync(fd);
    }

    // And the new store really is published, with the rotated refresh token.
    const after = JSON.parse(readFileSync(box.tokenFile, 'utf8')) as Record<string, unknown>;
    assert.equal(after['refresh_token'], REFRESHED.refresh_token, 'the rotated refresh token must reach the store');
    assert.equal(after['access_token'], REFRESHED.access_token);
    assert.equal(statSync(box.tokenFile).mode & 0o777, 0o600, 'a rotated credential is not world-readable');
  });

  it('replaces the store by rename, so the path is never the file being written', () => {
    const box = sandbox();
    seedExpired(box);
    const before = statSync(box.tokenFile).ino;

    const run = box.run('edge-probe', ['--only', 'markets', '--interval-ms', '0'], [{ status: 200 }], {
      PROBE_STUB_REFRESH: JSON.stringify(REFRESHED),
    });

    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /token refreshed/, run.output);
    // An in-place `writeFileSync` keeps the same inode; temp + rename(2) does
    // not. This is the signal that distinguishes the two implementations.
    assert.notEqual(
      statSync(box.tokenFile).ino,
      before,
      'the store kept its inode, so it was truncated in place rather than replaced by a rename',
    );
  });

  it('leaves no staging file behind, on the success path or when the write cannot land', () => {
    const box = sandbox();
    seedExpired(box);

    const run = box.run('edge-probe', ['--only', 'markets', '--interval-ms', '0'], [{ status: 200 }], {
      PROBE_STUB_REFRESH: JSON.stringify(REFRESHED),
    });
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(
      readdirSync(join(box.home, '.spotify-mcp')),
      ['tokens.json'],
      'a partial temp file must not survive for the next run to trip over',
    );

    // Now make the publish fail: a directory at the target path makes the
    // rename fail with EISDIR/ENOTEMPTY on every platform Node supports.
    const blocked = sandbox();
    seedExpired(blocked);
    const blockedPath = join(blocked.home, '.spotify-mcp/tokens.json');
    rmSync(blockedPath);
    mkdirSync(blockedPath, { recursive: true });

    const failed = blocked.run('edge-probe', ['--only', 'markets', '--interval-ms', '0'], [{ status: 200 }], {
      PROBE_STUB_REFRESH: JSON.stringify(REFRESHED),
    });
    assert.notEqual(failed.status, 0, `a failed publish must not report success:\n${failed.output}`);
    assert.deepEqual(
      readdirSync(join(blocked.home, '.spotify-mcp')).filter((name) => name !== 'tokens.json'),
      [],
      'a failed write must clean up its own temp file',
    );
  });

  it('does not claim to be read-only while it writes the live token store', () => {
    const source = readFileSync(EDGE_PROBE, 'utf8');
    const header = source.slice(0, source.indexOf('\nimport '));

    // The claim has to be about the PROBES. A bare "READ-ONLY" covering the
    // whole script is what misled a reader deciding whether it was safe to run
    // against a real account, so it may not reappear unscoped.
    assert.doesNotMatch(
      header,
      /READ-ONLY/,
      `the header still claims the script is read-only, but refresh() writes ~/.spotify-mcp/tokens.json:\n${header}`,
    );
    // ...and the write has to be admitted rather than merely un-claimed.
    assert.match(
      header,
      /token store/,
      `the header must say the refresh writes the token store:\n${header}`,
    );
    assert.match(header, /SPOTIFY_MCP_TOKEN_FILE/, 'the safe way to run it must be discoverable from the header');
  });

  it('still refreshes into the file the operator pointed it at, not the home default', () => {
    // The escape hatch only means something if the write follows it. A probe
    // aimed at a scratch store must leave the real one untouched.
    const box = sandbox();
    seedExpired(box);
    const explicit = join(box.dir, 'scratch-tokens.json');
    writeFileSync(explicit, `${JSON.stringify({ access_token: 'a', refresh_token: 'scratch-rt', expires_at: Date.now() - 60_000 }, null, 2)}\n`);
    const homeBefore = readFileSync(box.tokenFile, 'utf8');

    const run = box.run('edge-probe', ['--only', 'markets', '--interval-ms', '0'], [{ status: 200 }], {
      PROBE_STUB_REFRESH: JSON.stringify(REFRESHED),
      SPOTIFY_MCP_TOKEN_FILE: explicit,
    });

    assert.equal(run.status, 0, run.output);
    assert.equal(
      (JSON.parse(readFileSync(explicit, 'utf8')) as Record<string, unknown>)['refresh_token'],
      REFRESHED.refresh_token,
      'the rotated token must land in the file the operator named',
    );
    assert.equal(readFileSync(box.tokenFile, 'utf8'), homeBefore, 'the home store was written despite the override');
  });
});
