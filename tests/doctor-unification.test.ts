/**
 * #581 — `spotify-mcp doctor` and `spotify_doctor` are one report.
 *
 * Before this, the CLI subcommand re-implemented the checks inline in
 * `src/index.ts` and the tool rendered `collectDoctorReport()` from
 * `src/tools/doctortool.ts`. Two reports of the same facts is two chances to
 * be wrong, and a caller had no way to tell which to believe: the CLI could
 * not show a scope gap, an elicitation-independent surface, the freshness of
 * the read cache, or a rate-limit cooldown, and nothing stopped a check from
 * being added to only one of them.
 *
 * The file has three jobs, and the first two are the ones a test that only
 * drove the tool would have faked:
 *
 *   1. THE SHARED FUNCTION IS THE SAME FUNCTION. Driven in-process through
 *      both call shapes — with a live registry and without one — over one
 *      token file and one env, and required to agree on every row except the
 *      ones that genuinely describe the reporting process rather than the
 *      deployment. The exception set is derived from the rows that actually
 *      differ and required to be EXACTLY `PROCESS_LOCAL_DOCTOR_ROW_IDS`, so a
 *      new process-local row cannot quietly become a second answer.
 *
 *   2. THE REAL CLI IS DRIVEN. A function that the CLI calls but nothing
 *      spawns is exactly how #611 shipped a doctor row no test could see, and
 *      the repo already paid for that lesson once. Every assertion here that
 *      is about the CLI is made against `spawnSync`'s stdout.
 *
 *   3. THE TWO AGREE WHERE THEY CAN. `spotify-mcp doctor`'s stdout is parsed
 *      back into rows and diffed against the tool's rows for the same config
 *      and token file. "The same" has to mean the same CLOCK too: the `token`
 *      row's wording embeds the remaining time, and two processes reading
 *      their own clocks is a comparison that fails about once a minute on a
 *      correctly-rendered row (#1263). Both surfaces are therefore pinned to
 *      `FIXED_NOW` — this process directly, the CLI through a preloaded
 *      `Date.now` — so a text difference means a renderer difference.
 *
 * What the two surfaces CANNOT agree on is stated rather than faked: the
 * registered-tool count, the request counters and the read-cache counters are
 * in-process state, and the CLI is a separate process with no registry and no
 * cache. The module view, the sets and the overrides on the `surface` row are
 * env-derived and DO agree, and that is asserted field by field.
 *
 * Run: node --import tsx --test tests/doctor-unification.test.ts
 */

import './helpers/hermetic.js';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { initConfig } from '../src/config.js';
import { registerDoctorTool } from '../src/tools/doctortool.js';
import {
  PROCESS_LOCAL_DOCTOR_ROW_IDS,
  collectDoctorReport,
  renderDoctorProse,
  type DoctorReport,
  type DoctorRow,
} from '../src/tools/doctortool.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A fixed, far-future expiry. Fixed rather than relative on purpose: the
 * `token` row's text embeds `expires_at`, and the CLI and the tool are two
 * processes that each read their own clock. `Date.now() + 3600_000` makes the
 * ISO timestamp and the expiry wording differ by however long the second
 * process took to start, which is exactly the kind of flake that only shows
 * up under full-suite load.
 */
const FUTURE = Date.UTC(2099, 0, 1, 0, 0, 0);

/**
 * The one clock BOTH surfaces are made to read, in seconds before `FUTURE`.
 *
 * Pinning the expiry was not enough to pin the expiry WORDING, and that is
 * what made `the CLI stdout contains the shared renderer's own text` a
 * once-a-minute coin flip rather than a test (#1263, seen on Node 22 and not
 * on Node 24 — the Node version was a coincidence, the clock was the cause).
 *
 * The `token` row's summary carries the remaining time twice — the compat
 * clause and the `formatTtl` clause — and both come from
 * `Math.floor(secLeft / 60)`. That is constant across a whole wall-clock
 * minute and drops by one at the top of the next, so a tool rendered at
 * 12:00:59 and a CLI spawned at 12:01:00 disagree by a single digit in
 * `3h 25m` and a byte-exact comparison of a correctly-rendered row fails.
 * `normaliseClockFields` could not save it: it normalises `seconds_remaining`,
 * which is only in the DETAIL line, while the minute value the summary repeats
 * is in the line under test.
 *
 * 12_345 s before expiry: comfortably inside the `token valid` branch (so the
 * branch under test is unchanged), and deliberately NOT a whole number of
 * hours, so the hour AND the minutes remainder are both non-zero and a summary
 * that dropped either would not match.
 */
const FIXED_NOW = FUTURE - 12_345_000;

/** The env var that carries the pinned clock into the CLI subprocess. */
const FIXED_NOW_ENV = 'SPOTIFY_MCP_TEST_NOW';

/**
 * Preload for the CLI subprocess. Written into the fixture's `mkdtemp` home
 * (never a shared path) and passed as a second `--import`, after `tsx` so the
 * TypeScript loader is already registered and the freeze lands before
 * `src/index.ts` runs a single check.
 *
 * Only `Date.now` is replaced. Nothing in the doctor path gates on
 * `Date.now()` as a loop deadline — the client's backoff is real timers via
 * `sleep()` — so a frozen clock costs the subprocess nothing, and it makes the
 * two surfaces agree about what time it is instead of hoping they do.
 */
const CLOCK_PRELOAD = 'Date.now = () => Number(process.env.SPOTIFY_MCP_TEST_NOW);\n';

/**
 * The TTL wording the `token` row carries when rendered at `now`.
 *
 * Written out here rather than imported from `doctortool.ts`: the assertion it
 * feeds is about the renderer, so deriving the expected value from the
 * formatter that produces it would only prove the formatter agrees with
 * itself. This is the spec of the wording, not a second call to the code.
 */
function expectedTokenTtl(now: number): string {
  const secLeft = Math.round((FUTURE - now) / 1000);
  const mins = Math.floor(secLeft / 60);
  const hours = Math.floor(mins / 60);
  return `in ${hours}h ${mins % 60}m, valid (~${hours}h ${mins % 60}m left)`;
}

/**
 * The one field that stays clock-dependent even with a pinned expiry AND a
 * pinned clock: `seconds_remaining` is rendered from the same read, so this is
 * belt-and-braces. The ISO timestamp and the expiry wording are compared
 * verbatim, which is the point of pinning the clock in the first place.
 */
const normaliseClockFields = (text: string): string =>
  text.replace(/seconds_remaining=-?\d+/g, 'seconds_remaining=<n>');

/**
 * A grant that exposes `playlists` but not completely.
 *
 * `playlists` is the only write module that can be BOTH registered and scope-
 * gapped, and that is why this grant is shaped the way it is. A module's
 * registration gate is "either-of" over the same scopes the doctor reports
 * (`moduleBlockedByScopes` vs `WRITE_REQUIREMENTS`), so a module whose
 * requirement list has a single scope — `library`, `following`, `playback` —
 * is hidden by the scope gate the moment the doctor would call it gapped, and
 * no gap is ever reported for it. `playlists` accepts
 * `playlist-modify-public` OR `playlist-modify-private`, so granting the
 * private one alone leaves the module live and the public one missing: the
 * real-world shape, and the only one where trimming a module actually changes
 * what the doctor says.
 */
const PARTIAL_GRANT = [
  'user-read-private',
  'user-read-email',
  'user-modify-playback-state',
  'playlist-modify-private',
].join(' ');

/**
 * Stub client. `getRateLimitStatus` is present so the `rate_limit` and
 * `cache` rows are emitted on both sides (the real client emits them too).
 * `counters` shifts the request and cache totals, so a caller can give the
 * two surfaces genuinely different in-process state and see the declared
 * process-local rows diverge — which is what makes the "the exception set is
 * exactly these three" assertion mean something rather than passing because
 * the two stubs happened to agree.
 *
 * `get` throws by default: the live probe's outcome depends on what network
 * the reporting process happens to have, and a test whose expected text
 * depends on that is a test that fails in someone else's CI. The probe rows
 * are compared by id, never by text.
 */
function stubClient(counters = 0): SpotifyClient {
  return ({
    getRateLimitStatus: () => ({
      lastThrottleAt: null,
      retryAfterSec: null,
      cooldownRemainingMs: 0,
      requestsTotal: counters,
      requestsLastMinute: counters,
      requestsLastHour: counters,
      cacheEntries: counters,
      cacheBytes: counters * 128,
      cacheMaxBytes: 8_388_608,
      cacheSkippedOversize: 0,
    }),
    get: async () => {
      throw new Error('stub client: no network in this test');
    },
  }) as unknown as SpotifyClient;
}

/**
 * A stand-in for the live McpServer. `collectDoctorReport` reads exactly one
 * thing off it — the registered-tool registry — and `registerDoctorTool`
 * needs a `.tool()` to attach to. The handler is captured so the tool can be
 * driven the way a host drives it, rather than by re-calling the function
 * behind it: comparing two renderings of one function proves less than
 * comparing what each entry point actually emits.
 */
function fakeServer(seededTools: number): {
  server: McpServer;
  invoke: () => Promise<{ text: string; structuredContent: DoctorReport }>;
} {
  const registry: Record<string, { enabled?: boolean }> = {};
  for (let i = 0; i < seededTools; i += 1) registry[`seed_tool_${i}`] = { enabled: true };
  let handler: ((args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; structuredContent: unknown }>) | undefined;
  const server = {
    _registeredTools: registry,
    tool(
      name: string,
      _description: string,
      _schema: z.ZodRawShape,
      registered: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; structuredContent: unknown }>,
    ) {
      registry[name] = { enabled: true };
      handler = registered;
    },
  } as unknown as McpServer;
  return {
    server,
    invoke: async () => {
      assert.ok(handler, 'spotify_doctor must be registered before it can be invoked');
      const result = await handler!({ verbose: true, response_format: 'detailed' });
      return {
        text: result.content[0].text,
        structuredContent: result.structuredContent as DoctorReport,
      };
    },
  };
}

interface TokenFile {
  path: string;
  home: string;
  historyDir: string;
  clock: string;
}

let fixture: TokenFile | null = null;
let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let savedEnvKeys: string[] = [];
const realNow = Date.now;

/**
 * Pin THIS process's clock to `FIXED_NOW`, so the tool half of every
 * cross-process comparison reads the same instant the CLI half will.
 * Unpinned in `afterEach` alongside the fixture, so a test that never called
 * `useTokenFile` cannot inherit a frozen clock from a neighbour.
 */
function pinClock(at: number): void {
  Date.now = () => at;
}

function unpinClock(): void {
  Date.now = realNow;
}

/**
 * Write a token file and align this process's HOME with the one the CLI
 * subprocess will be given, so every path either surface reports (`history`
 * row, token file) is the same path. `SPOTIFY_MCP_HISTORY_DIR` is set
 * explicitly as well — the history path is `homedir()`-derived, and a test
 * that depends on the machine's home directory is a test that passes for the
 * wrong reason somewhere else.
 *
 * The clock is pinned here too, and the preload for the subprocess is written
 * beside the token file, because a token-file fixture that leaves the two
 * surfaces reading their own clocks is a fixture that can fail for a reason
 * that has nothing to do with either surface.
 */
function useTokenFile(tokens: Record<string, unknown>): TokenFile {
  const home = mkdtempSync(join(tmpdir(), 'doctor-unify-'));
  const path = join(home, 'tokens.json');
  writeFileSync(path, JSON.stringify(tokens), 'utf8');
  const historyDir = join(home, 'history');
  const clock = join(home, 'clock.mjs');
  writeFileSync(clock, CLOCK_PRELOAD, 'utf8');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.SPOTIFY_MCP_HISTORY_DIR = historyDir;
  initConfig({ SPOTIFY_MCP_TOKEN_FILE: path, SPOTIFY_MCP_HISTORY_DIR: historyDir });
  pinClock(FIXED_NOW);
  fixture = { path, home, historyDir, clock };
  return fixture;
}

/** Subprocess env: the same token file, home, history dir and clock as this process. */
function cliEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  assert.ok(fixture, 'a token-file fixture must be installed first');
  return {
    ...process.env,
    HOME: fixture.home,
    USERPROFILE: fixture.home,
    SPOTIFY_MCP_TOKEN_FILE: fixture.path,
    SPOTIFY_MCP_HISTORY_DIR: fixture.historyDir,
    [FIXED_NOW_ENV]: String(FIXED_NOW),
    SPOTIFY_CLIENT_ID: 'test-client-id',
    ...extra,
  };
}

/**
 * Run the real `spotify-mcp doctor` and return its stdout. Asserting on the
 * process's output rather than on a function return is the whole point: a
 * test that called `collectDoctorReport` directly would still pass with the
 * CLI reverted to its own inline implementation, which is the bug #581 is.
 */
function runDoctorCli(extra: NodeJS.ProcessEnv = {}): { stdout: string; stderr: string; status: number | null } {
  assert.ok(fixture, 'a token-file fixture must be installed first');
  const result = spawnSync(
    process.execPath,
    // `tsx` first so the TypeScript loader is registered before the freeze
    // lands; `--import` modules are evaluated in order, and both run before
    // the entry point.
    ['--import', 'tsx', '--import', fixture.clock, 'src/index.ts', 'doctor'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 180_000,
      env: cliEnv(extra),
    },
  );
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

const GLYPH_STATUS: Record<string, DoctorRow['status']> = {
  '✓': 'pass',
  '✗': 'fail',
  '⚠': 'warn',
  'ℹ': 'info',
};

/**
 * Parse a RENDERED report — the CLI's stdout, or the tool's prose — back into
 * the rows its renderer emitted. Reading the report out of printed text rather
 * than grepping for one phrase is what makes "the two surfaces emit the same
 * rows" a comparison instead of a spot check, and the status is recovered from
 * the glyph so the comparison covers it too.
 */
function parseRenderedRows(rendered: string): DoctorRow[] {
  const rows: DoctorRow[] = [];
  const lines = rendered.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = /^([✓✗⚠ℹ]) \[([a-z0-9_]+)\] (.*)$/.exec(line);
    if (!match) continue;
    const status = GLYPH_STATUS[match[1]];
    assert.ok(status, `unknown glyph in ${JSON.stringify(line)}`);
    const row: DoctorRow = { id: match[2], status: status!, summary: match[3] };
    // Both surfaces render verbose here (the tool because the test asks for
    // it, the CLI because it always does), so a following indented line is
    // this row's detail.
    const next = lines[i + 1];
    if (next !== undefined && /^ {4}\S/.test(next)) row.detail = next.slice(4);
    rows.push(row);
  }
  return rows;
}

/** Rows whose text embeds a live answer from the Spotify API. */
const PROBE_ROW_IDS = new Set(['account', 'account_premium', 'account_probe']);

/** The rows a text comparison can hold both surfaces to. */
function comparableRows(rows: DoctorRow[]): DoctorRow[] {
  return rows.filter(
    (row) => !PROCESS_LOCAL_DOCTOR_ROW_IDS.includes(row.id) && !PROBE_ROW_IDS.has(row.id),
  );
}

function rowMap(rows: DoctorRow[]): Map<string, DoctorRow[]> {
  const map = new Map<string, DoctorRow[]>();
  for (const row of rows) {
    const bucket = map.get(row.id);
    if (bucket) bucket.push(row);
    else map.set(row.id, [row]);
  }
  return map;
}

beforeEach(() => {
  savedEnvKeys = [
    'SPOTIFY_MCP_TOOLSETS',
    'SPOTIFY_MCP_ENABLE_TOOLS',
    'SPOTIFY_MCP_DISABLE_TOOLS',
    'SPOTIFY_MCP_READONLY',
  ];
  for (const key of savedEnvKeys) delete process.env[key];
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
});

afterEach(() => {
  if (fixture) {
    rmSync(fixture.home, { recursive: true, force: true });
    fixture = null;
  }
  // Before anything else: a clock left frozen by a test that did not reach
  // its own cleanup would silently retime every later test in this file.
  unpinClock();
  for (const key of savedEnvKeys) delete process.env[key];
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserProfile;
  delete process.env.SPOTIFY_MCP_HISTORY_DIR;
  initConfig();
});

// ---------------------------------------------------------------------------
// 1. The shared function is the shared function
// ---------------------------------------------------------------------------

describe('#581 — one report, two call shapes', () => {
  it('reports identical rows with and without a live registry, outside the declared process-local set', async () => {
    useTokenFile({ access_token: 'at', refresh_token: 'rt', expires_at: FUTURE, scope: PARTIAL_GRANT });

    // Different in-process counters on each side, so the process-local rows
    // genuinely diverge and the exception set below is proven rather than
    // satisfied by two stubs that happened to agree.
    const withRegistry = await collectDoctorReport(stubClient(3), fakeServer(3).server);
    const withoutRegistry = await collectDoctorReport(stubClient(0));

    // Same rows, same order, same status and same text — except for the rows
    // that describe the reporting process.
    const differing: string[] = [];
    for (const [index, row] of withRegistry.rows.entries()) {
      const other = withoutRegistry.rows[index];
      if (other === undefined) {
        differing.push(`${row.id} — present with a registry, absent without one`);
        continue;
      }
      if (row.id !== other.id || row.status !== other.status || row.summary !== other.summary) {
        differing.push(row.id);
      }
    }
    differing.push(
      ...withoutRegistry.rows
        .slice(withRegistry.rows.length)
        .map((row) => `${row.id} — extra row without a registry`),
    );

    const declared = [...PROCESS_LOCAL_DOCTOR_ROW_IDS].sort();
    assert.deepEqual(
      [...new Set(differing)].sort(),
      declared,
      `the two call shapes disagreed on rows outside the declared process-local set. `
        + `PROCESS_LOCAL_DOCTOR_ROW_IDS is the contract for what cannot agree; `
        + `anything else here is a second answer to the same question. `
        + `Differing rows: ${JSON.stringify(differing)}`,
    );
  });

  it('the registry is the ONLY thing the surface row takes from the server', async () => {
    useTokenFile({ access_token: 'at', refresh_token: 'rt', expires_at: FUTURE, scope: PARTIAL_GRANT });
    process.env.SPOTIFY_MCP_READONLY = '1';

    const withRegistry = await collectDoctorReport(stubClient(), fakeServer(3).server);
    const withoutRegistry = await collectDoctorReport(stubClient());

    // Everything a user acts on — which modules are live, which are hidden and
    // why — is env-derived, so it must be identical whether or not a registry
    // was available. Only the count is not.
    const { registry_available: aAvail, registered_tools: aCount, ...a } = withRegistry.surface;
    const { registry_available: bAvail, registered_tools: bCount, ...b } = withoutRegistry.surface;
    assert.equal(aAvail, true);
    assert.equal(bAvail, false);
    assert.equal(aCount, 3);
    assert.equal(bCount, 0);
    assert.deepEqual(
      a,
      b,
      'the module view, the sets and the overrides must not depend on having a live registry — '
        + 'that is the fact the doctor exists to report',
    );
    assert.deepEqual(a.hidden_by_readonly.length > 0, true, 'the control for this test: READONLY hides something');
  });

  it('an unobservable registry does not turn a healthy report red', async () => {
    useTokenFile({ access_token: 'at', refresh_token: 'rt', expires_at: FUTURE, scope: PARTIAL_GRANT });

    const report = await collectDoctorReport(stubClient());
    const surface = report.rows.find((row) => row.id === 'surface');
    assert.ok(surface, 'surface row present');
    assert.notEqual(surface.status, 'fail', `the CLI has no registry by construction and must not exit 1 for it: ${surface.summary}`);
    assert.equal(report.ok, true, `a healthy deployment must report ok from the CLI path too. Rows: ${JSON.stringify(report.rows.map((r) => [r.id, r.status]))}`);
  });

  it('says the count is unobservable rather than reporting zero tools', async () => {
    useTokenFile({ access_token: 'at', refresh_token: 'rt', expires_at: FUTURE, scope: PARTIAL_GRANT });

    const report = await collectDoctorReport(stubClient());
    const surface = report.rows.find((row) => row.id === 'surface');
    assert.match(surface!.summary, /no live registry to count/);
    assert.match(surface!.detail ?? '', /registered_tools=not-observable/);
    assert.doesNotMatch(
      surface!.summary,
      /live registry: 0 tool/,
      'a zero here would read as "this deployment registers nothing", which is a different and wrong claim',
    );
  });

  it('still fails the report when a toolset spec matches nothing, registry or not', async () => {
    useTokenFile({ access_token: 'at', refresh_token: 'rt', expires_at: FUTURE, scope: PARTIAL_GRANT });
    process.env.SPOTIFY_MCP_TOOLSETS = 'nonexistent_set';

    for (const [label, report] of [
      ['with registry', await collectDoctorReport(stubClient(), fakeServer(3).server)],
      ['without registry', await collectDoctorReport(stubClient())],
    ] as const) {
      const surface = report.rows.find((row) => row.id === 'surface');
      assert.equal(surface?.status, 'fail', `${label}: an unknown-only spec is a real misconfiguration`);
      assert.equal(report.ok, false, `${label}: and it must fail the report`);
    }
  });
});

// ---------------------------------------------------------------------------
// 2 + 3. Both entry points, driven for real
// ---------------------------------------------------------------------------

describe('#581 — the CLI and the tool, for one config and one token file', () => {
  it('names the same missing scopes through the CLI and through the tool', async () => {
    useTokenFile({ access_token: 'at', refresh_token: 'rt', expires_at: FUTURE, scope: PARTIAL_GRANT });

    // The tool, driven through its registered handler — the same entry a host
    // calls, rendering its own report.
    const { server, invoke } = fakeServer(0);
    registerDoctorTool(server, stubClient());
    const tool = await invoke();
    const toolScopes = rowMap(parseRenderedRows(tool.text)).get('scopes') ?? [];

    const cli = runDoctorCli();
    const cliScopes = rowMap(parseRenderedRows(cli.stdout)).get('scopes') ?? [];

    assert.equal(toolScopes.length, 1, 'the tool must emit a scopes row for a partial grant');
    assert.equal(cliScopes.length, 1, `the CLI must emit the same scopes row. Output was:\n${cli.stdout}`);

    // The exact claim #581 makes: same row id, same status, same text, same
    // advice — including which scope is named as missing.
    assert.equal(cliScopes[0].id, toolScopes[0].id);
    assert.equal(cliScopes[0].status, toolScopes[0].status);
    assert.equal(cliScopes[0].summary, toolScopes[0].summary, 'the CLI and the tool must give identical scope advice');
    assert.equal(cliScopes[0].detail, toolScopes[0].detail);
    assert.match(
      toolScopes[0].detail ?? '',
      /playlist-modify-public/,
      'the control for this test: the grant really does leave playlist-modify-public missing',
    );
  });

  it('renders every check the tool can render, not a subset', async () => {
    useTokenFile({ access_token: 'at', refresh_token: 'rt', expires_at: FUTURE, scope: PARTIAL_GRANT });

    const { server, invoke } = fakeServer(3);
    registerDoctorTool(server, stubClient());
    const tool = await invoke();
    const toolIds = tool.structuredContent.rows.map((row) => row.id);
    const cli = runDoctorCli();
    const cliIds = parseRenderedRows(cli.stdout).map((row) => row.id);

    // The checks the inline CLI implementation could not produce at all.
    for (const id of ['scopes', 'history', 'premium', 'rate_limit', 'cache', 'surface', 'config']) {
      assert.ok(
        toolIds.includes(id),
        `the control for this test: the tool really does emit [${id}]`,
      );
      assert.ok(
        cliIds.includes(id),
        `the CLI did not render the [${id}] row — the inline implementation is back, or the shared renderer is not being used. Output was:\n${cli.stdout}`,
      );
    }
  });

  it('the CLI stdout contains the shared renderer\'s own text', async () => {
    useTokenFile({ access_token: 'at', refresh_token: 'rt', expires_at: FUTURE, scope: PARTIAL_GRANT });

    const { server, invoke } = fakeServer(3);
    registerDoctorTool(server, stubClient());
    const tool = await invoke();
    const cli = runDoctorCli();

    let compared = 0;
    for (const line of tool.text.split('\n')) {
      if (!/^[✓✗⚠ℹ] \[/.test(line)) continue;
      const id = /\[([a-z0-9_]+)\]/.exec(line)?.[1] ?? '';
      if (PROCESS_LOCAL_DOCTOR_ROW_IDS.includes(id) || PROBE_ROW_IDS.has(id)) continue;
      const expected = normaliseClockFields(line);
      assert.ok(
        cli.stdout.includes(expected),
        `the CLI did not print the shared row verbatim: ${expected}`,
      );
      compared += 1;
    }
    assert.ok(compared >= 4, `expected several shared rows to compare, got ${compared}`);
  });

  /**
   * The control for the test above, and the regression test for #1263.
   *
   * `the CLI stdout contains the shared renderer's own text` asserts a
   * byte-exact match between two processes. That is only a statement about the
   * RENDERER if both processes read the same clock — and they did not. The
   * `token` row's summary repeats the remaining time twice, from
   * `Math.floor(secLeft / 60)`, which is flat across a wall-clock minute and
   * decrements at the top of the next. A tool rendered at 12:00:59 and a CLI
   * spawned at 12:01:00 therefore disagreed by one digit in `3h 25m`, and the
   * comparison above failed on a correct row, from a correct renderer, about
   * nothing the doctor is supposed to be reporting.
   *
   * It could not be caught by reading the suite: it passed on Node 24 and
   * failed on Node 22 in the same CI run, which is what sent the first look at
   * a Node-version difference in `Intl`/`replaceAll`/`util.inspect`. None of
   * those are on this path — `renderDoctorProse` is a `map` and a `join`. The
   * Node version was a coincidence; the clock was the cause.
   *
   * So the invariant is stated directly, and stated so that it fails EVERY
   * time the pin is gone rather than once a minute: the expected wording is
   * computed from `FIXED_NOW`, which is years away from any wall clock, so an
   * unpinned surface cannot produce it by luck.
   */
  it('both surfaces time-stamp the token row from the one pinned clock, not their own', async () => {
    useTokenFile({ access_token: 'at', refresh_token: 'rt', expires_at: FUTURE, scope: PARTIAL_GRANT });

    const { server, invoke } = fakeServer(3);
    registerDoctorTool(server, stubClient());
    const tool = await invoke();
    const cli = runDoctorCli();

    // The control: the pin names an instant that is inside the `token valid`
    // branch and is neither a whole hour nor a whole minute, so a row that
    // reported the wrong unit, or dropped the minutes remainder, cannot match.
    const expectedTtl = expectedTokenTtl(FIXED_NOW);
    assert.equal(expectedTtl, 'in 3h 25m, valid (~3h 25m left)', 'the pinned clock moved');

    const toolToken = (rowMap(parseRenderedRows(tool.text)).get('token') ?? [])[0];
    const cliToken = (rowMap(parseRenderedRows(cli.stdout)).get('token') ?? [])[0];
    assert.ok(toolToken, `the tool emitted no [token] row:\n${tool.text}`);
    assert.ok(cliToken, `the CLI emitted no [token] row:\n${cli.stdout}`);

    // Each surface, on its own, must be reporting the PINNED clock.
    assert.ok(
      toolToken.summary.includes(expectedTtl),
      `the tool timed the token row from its own clock, not the fixture's: expected "${expectedTtl}" in ${JSON.stringify(toolToken.summary)}`,
    );
    assert.ok(
      cliToken.summary.includes(expectedTtl),
      `the CLI timed the token row from its own clock, not the fixture's: expected "${expectedTtl}" in ${JSON.stringify(cliToken.summary)}`,
    );

    // And therefore the byte-exact comparison the previous test makes is
    // reachable: same clock in, same text out — with no normalisation at all,
    // which is the property #1263 was missing.
    assert.equal(
      cliToken.summary,
      toolToken.summary,
      'the two surfaces produced different token-row text from the same pinned clock',
    );
  });

  it('emits the same non-process-local rows, in the same order, through both surfaces', async () => {
    useTokenFile({ access_token: 'at', refresh_token: 'rt', expires_at: FUTURE, scope: PARTIAL_GRANT });

    const { server, invoke } = fakeServer(3);
    registerDoctorTool(server, stubClient());
    const tool = await invoke();
    const cli = runDoctorCli();

    const toolComparable = comparableRows(tool.structuredContent.rows);
    const cliComparable = comparableRows(parseRenderedRows(cli.stdout));

    assert.deepEqual(
      cliComparable.map((row) => row.id),
      toolComparable.map((row) => row.id),
      'the two surfaces must emit the same check ids in the same order',
    );
    for (const [index, toolRow] of toolComparable.entries()) {
      const cliRow = cliComparable[index];
      assert.equal(cliRow.status, toolRow.status, `status differed on [${toolRow.id}]`);
      assert.equal(cliRow.summary, toolRow.summary, `text differed on [${toolRow.id}]`);
      if (toolRow.detail !== undefined) {
        assert.equal(
          normaliseClockFields(cliRow.detail ?? ''),
          normaliseClockFields(toolRow.detail),
          `detail differed on [${toolRow.id}]`,
        );
      }
    }
    // Non-vacuity: the comparison above is only meaningful over a real set.
    assert.ok(toolComparable.length >= 5, `expected several shared rows to compare, got ${toolComparable.length}`);
  });

  it('reports no scope gap for a module the overrides removed, through BOTH surfaces', async () => {
    useTokenFile({ access_token: 'at', refresh_token: 'rt', expires_at: FUTURE, scope: PARTIAL_GRANT });

    // Control first: with `playlists` registered, this grant leaves a real gap.
    delete process.env.SPOTIFY_MCP_DISABLE_TOOLS;
    const enabled = await collectDoctorReport(stubClient(), fakeServer(3).server);
    assert.match(
      rowMap(enabled.rows).get('scopes')?.[0].detail ?? '',
      /playlist-modify-public/,
      'the control: the doctor reports the gap when the module is registered',
    );

    process.env.SPOTIFY_MCP_DISABLE_TOOLS = 'playlists';
    initConfig({ SPOTIFY_MCP_TOKEN_FILE: fixture!.path, SPOTIFY_MCP_HISTORY_DIR: fixture!.historyDir });

    const { server, invoke } = fakeServer(3);
    registerDoctorTool(server, stubClient());
    const tool = await invoke();
    const cli = runDoctorCli({ SPOTIFY_MCP_DISABLE_TOOLS: 'playlists' });

    for (const [label, rows] of [
      ['tool', tool.structuredContent.rows],
      ['cli', parseRenderedRows(cli.stdout)],
    ] as const) {
      const scopeRows_ = rowMap(rows as DoctorRow[]).get('scopes') ?? [];
      assert.equal(scopeRows_.length, 1, `${label} must still emit a scopes row`);
      // The gap is named in the summary, never in the detail — the detail is
      // the granted list, which legitimately still contains the scope that
      // kept `playlists` registered. Asserting on the status is the direct
      // statement: the doctor stopped claiming a gap.
      assert.equal(
        scopeRows_[0].status,
        'pass',
        `${label} still reports a gap for a module that is not registered: ${scopeRows_[0].summary}`,
      );
      assert.doesNotMatch(scopeRows_[0].summary, /lacks required scopes/);
      assert.doesNotMatch(scopeRows_[0].summary, /playlist-modify-public/);
    }
    assert.ok(
      tool.structuredContent.surface.hidden_by_trim.includes('playlists'),
      'the control: playlists really is trimmed by the override on both sides',
    );
  });

  it('never asks for user-library-* scopes when the library module is trimmed', async () => {
    // The issue's literal acceptance criterion. Note what it can and cannot
    // prove: with a grant missing `user-library-modify`, the library module is
    // ALSO hidden by the scope gate, so the gap is absent either way and this
    // assertion alone would not catch a doctor that ignored the override.
    // The biting form of the same check — an override that removes a module
    // which IS scope-gapped — is the test above.
    useTokenFile({
      access_token: 'at',
      refresh_token: 'rt',
      expires_at: FUTURE,
      scope: 'user-read-private user-read-email user-modify-playback-state',
    });
    process.env.SPOTIFY_MCP_DISABLE_TOOLS = 'library';
    initConfig({ SPOTIFY_MCP_TOKEN_FILE: fixture!.path, SPOTIFY_MCP_HISTORY_DIR: fixture!.historyDir });

    const { server, invoke } = fakeServer(3);
    registerDoctorTool(server, stubClient());
    const tool = await invoke();
    const cli = runDoctorCli({ SPOTIFY_MCP_DISABLE_TOOLS: 'library' });

    for (const [label, rows] of [
      ['tool', tool.structuredContent.rows],
      ['cli', parseRenderedRows(cli.stdout)],
    ] as const) {
      const text = (rows as DoctorRow[]).map((row) => `${row.id}: ${row.summary} ${row.detail ?? ''}`).join('\n');
      assert.doesNotMatch(text, /user-library-modify/, `${label} asked for a user-library-* scope:\n${text}`);
    }
  });

  it('the surface row names the same sets and overrides through both surfaces', async () => {
    useTokenFile({ access_token: 'at', refresh_token: 'rt', expires_at: FUTURE, scope: PARTIAL_GRANT });
    process.env.SPOTIFY_MCP_TOOLSETS = 'playback,catalog';
    process.env.SPOTIFY_MCP_ENABLE_TOOLS = 'library';
    process.env.SPOTIFY_MCP_READONLY = '1';
    initConfig({ SPOTIFY_MCP_TOKEN_FILE: fixture!.path, SPOTIFY_MCP_HISTORY_DIR: fixture!.historyDir });

    const toolReport = await collectDoctorReport(stubClient(), fakeServer(3).server);
    const cli = runDoctorCli({
      SPOTIFY_MCP_TOOLSETS: 'playback,catalog',
      SPOTIFY_MCP_ENABLE_TOOLS: 'library',
      SPOTIFY_MCP_READONLY: '1',
    });
    const cliSurface = parseRenderedRows(cli.stdout).find((row) => row.id === 'surface');
    assert.ok(cliSurface, `the CLI must render a surface row. Output was:\n${cli.stdout}`);

    // The env-derived facts, verbatim, from the CLI's own printed text.
    for (const part of [
      'active_sets=playback,catalog',
      'enable_overrides=library',
      'read_only=true',
    ]) {
      assert.ok(cliSurface!.detail!.includes(part), `the CLI's surface row did not carry ${part}: ${cliSurface!.detail}`);
    }
    // The tool's structured surface says the same things.
    assert.deepEqual(toolReport.surface.active_sets, ['playback', 'catalog']);
    assert.deepEqual(toolReport.surface.enable_overrides, ['library']);
    assert.equal(toolReport.surface.read_only, true);
    assert.ok(toolReport.surface.hidden_by_trim.includes('playlists'));
  });

  it('still prints the readonly line the configuration block has always printed (#611)', async () => {
    // #1230 moved that row off the config snapshot and onto the gate
    // (`readOnlyModeEnabled`) on purpose: a startup snapshot would answer
    // about a different moment than the gate that actually ran. Unifying the
    // report must not quietly put it back.
    useTokenFile({ access_token: 'at', refresh_token: 'rt', expires_at: FUTURE, scope: PARTIAL_GRANT });
    const cli = runDoctorCli({ SPOTIFY_MCP_READONLY: '1' });
    assert.match(cli.stdout, /^\s*readonly\s+yes$/m, `the CLI's readonly row regressed. Output was:\n${cli.stdout}`);
  });
});

describe('#581 — the CLI exit code follows the shared report', () => {
  it('exits non-zero when a row failed', async () => {
    // No token file at all: the `token` row is a fail in the shared report, so
    // the CLI must exit 1 without having a token check of its own.
    const home = mkdtempSync(join(tmpdir(), 'doctor-unify-bare-'));
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', 'doctor'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, SPOTIFY_CLIENT_ID: '' },
    });
    try {
      assert.equal(result.status, 1, `expected exit 1 with no token file. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.match(result.stdout, /✗ \[token\] no token file at /, `stdout:\n${result.stdout}`);
      assert.match(result.stderr, /Doctor found problems\./);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a fully granted, untrimmed config would exit 0 from the CLI call shape', async () => {
    // Why this is asserted in-process and the exit code itself is not: the CLI
    // always runs a live GET /me, and in a test sandbox that probe cannot
    // succeed, so it renders an `account_probe` fail row and the exit code is
    // 1 whatever the rest of the report says. Asserting exit 0 there would
    // mean asserting the probe's behaviour, which depends on the runner's
    // network and credentials. What is asserted here is the part this change
    // actually moved — the report's own verdict, through the exact call shape
    // the CLI uses (no server) — and the test below pins the exit code to that
    // verdict for real, over runs that genuinely reach each side.
    useTokenFile({
      access_token: 'at',
      refresh_token: 'rt',
      expires_at: FUTURE,
      scope: [
        'user-read-private',
        'user-modify-playback-state',
        'playlist-modify-public',
        'playlist-modify-private',
        'user-library-modify',
        'user-follow-modify',
      ].join(' '),
    });

    const report = await collectDoctorReport(stubClient());
    assert.equal(
      report.ok,
      true,
      `a healthy deployment must report ok from the CLI call shape, or the CLI exits 1 for everything. `
        + `Rows: ${JSON.stringify(report.rows.map((r) => [r.id, r.status]))}`,
    );
    // The surface row is the one that used to be `fail` whenever no registry
    // could be read, which the CLI can never do. Named explicitly because it
    // is the regression that would make `spotify-mcp doctor` useless.
    const surface = report.rows.find((row) => row.id === 'surface');
    assert.notEqual(surface?.status, 'fail');
  });

  it('the exit code is a function of the rows the CLI itself printed', async () => {
    // This is the exit-code contract, pinned without needing the live probe
    // to succeed: the printed verdict line, the printed row glyphs and the
    // process exit code must all say the same thing. Asserted on runs that
    // reach BOTH sides — one with a failing row and one whose only failing
    // row is the probe — so it is not a claim that only holds when the report
    // is unhealthy.
    useTokenFile({ access_token: 'at', refresh_token: 'rt', expires_at: FUTURE, scope: PARTIAL_GRANT });

    const runs: Array<[string, ReturnType<typeof runDoctorCli>]> = [
      ['misconfigured toolsets', runDoctorCli({ SPOTIFY_CLIENT_ID: '', SPOTIFY_MCP_TOOLSETS: 'no_such_toolset' })],
      ['healthy, probe fails in the sandbox', runDoctorCli({ SPOTIFY_CLIENT_ID: '' })],
      ['healthy with a live client id', runDoctorCli({ SPOTIFY_CLIENT_ID: 'test-client-id' })],
    ];

    for (const [label, run] of runs) {
      const failed = parseRenderedRows(run.stdout).filter((row) => row.status === 'fail');
      const expected = failed.length === 0 ? 0 : 1;
      assert.equal(
        run.status,
        expected,
        `${label}: exit code did not follow the printed rows (${failed.length} failing). stdout:\n${run.stdout}`,
      );
      // And the rendered verdict agrees with both.
      const verdict = /FAILURES PRESENT|no failures/.exec(run.stdout)?.[0];
      assert.equal(verdict, failed.length === 0 ? 'no failures' : 'FAILURES PRESENT', `${label}: the header verdict disagreed with the rows`);
      if (failed.length === 0) {
        assert.match(run.stdout, /All checks passed\./, `${label}: exit 0 must say so`);
      } else {
        assert.match(run.stderr, /Doctor found problems\./, `${label}: exit 1 must say so`);
      }
    }

    assert.ok(
      parseRenderedRows(runs[1][1].stdout).some((row) => row.status === 'fail'),
      'the control: the second run really did render a failing row',
    );
  });
});
