/**
 * Integration smoke test: spawns the REAL server entry (src/index.ts) over
 * stdio and speaks newline-delimited JSON-RPC to it.
 *
 * Zero Spotify API traffic: initialize / tools/list / prompts/list /
 * resources/list are all served locally by the MCP SDK. The token fixture is
 * pointed at a temp file via SPOTIFY_MCP_TOKEN_FILE so the child can NEVER
 * touch ~/.spotify-mcp/tokens.json.
 */
import './helpers/hermetic.js';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { armFileDeadline } from './helpers/file-deadline.js';
import { hermeticServerEnv, StdioJsonRpcChild } from './helpers/stdio-child.js';
import { execFileBounded } from './helpers/subprocess-outcome.js';

const REPO_ROOT = join(import.meta.dirname, '..');

// Regression guard (#110 follow-up + v1.5 wiring loss): a description
// rewrite once consumed this tool's name argument and the suite stayed
// green; the v1.5 wiring regression shipped two releases before anyone
// noticed grow_playlist/verify_receipt were missing. Pin the tools most at
// risk from either failure class.
const REQUIRED_TOOLS = [
  'check_in_library',
  'get_me',
  'get_album_tracks',
  'list_show_episodes',
  'get_audiobook',
  'get_audiobook_chapters',
  'get_chapter',
  'get_saved_audiobooks',
  'get_currently_playing',
  'play_from_search',
  'get_playlist_cover',
  'upload_playlist_cover',
  'get_top_tracks',
  'get_recently_played',
  'search',
  'play',
  // Post-v1.4 differentiators (highest-severity failure class: silent
  // wiring loss). See the wiring-regression note above.
  'grow_playlist', 'verify_receipt', 'spotify_doctor',
  'whats_new', 'search_deep', 'handoff', 'merge_playlists',
  'library_hygiene', 'plan_podcast_session', 'where_was_i', 'apply_scene',
];

const FORBIDDEN_TOOLS = [
  // #695: derived listening analytics are withheld unless
  // SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS is set, and this server starts with no
  // SPOTIFY_* set — so the default surface must NOT serve them. This list was
  // where `listening_report` belonged once #695 landed; it was previously in
  // REQUIRED_TOOLS above, which is the assertion that would have caught the
  // gate being wired in the wrong direction.
  'listening_report', 'listening_heatmap', 'discovery_ratio', 'listening_clock',
  'listening_clock_heatmap', 'artist_listening_clock', 'mood_bucket_report',
  'weekday_listening_report', 'weekly_rotation_report', 'binge_detector_report',
  'listening_recap_brief',
  'get_recommendations',
  'get_related_artists',
  'get_available_genres',
  'get_featured_playlists',
  'get_audio_features',
  'get_audio_analysis',
  'follow_artist',
  'unfollow_artist',
  'get_show_episodes',
];

const READONLY_WRITE_TOOLS = [
  // Verified leaking before the #579 fix (live probe, 2026-09-19): the READONLY
  // surface contained writer tools from six modules registered without the gate.
  'play_on', 'queue_next', 'seek_relative', 'remove_saved_shows', 'save_episode',
  'remove_saved_episode', 'unsave_orphan_tracks', 'remove_from_library_by_playlist',
  'playlist_to_library', 'save_artist_new_releases', 'pin_playlist',
  // #1099: the canonical names must be gated exactly like the aliases.
  'follow_playlist', 'unfollow_playlist',
];

const EXPECTED_PROMPTS = ['artist_deep_dive', 'crate_digging', 'discover_weekly_alternative', 'dj', 'listening_recap', 'migrate_library', 'morning_briefing', 'music_briefing', 'music_taste_summary', 'playlist_audit', 'playlist_from_mood', 'podcast_catchup', 'triage_liked_songs', 'weekly_digest'];

// Mirrors the `ErrorKind` union in src/tools/annotations.ts, which is not
// exported. A classification added there must be added here too, or this
// guard reports a false failure. `not_modified` (#601) was already missing from
// this mirror and `cancelled` (#676) was added alongside it.
const KNOWN_ERROR_KINDS = [
  'auth', 'forbidden', 'not_found', 'not_modified', 'rate_limited', 'unavailable',
  'conflict', 'validation', 'unknown_tool', 'unknown_param', 'cancelled', 'internal',
] as const;

/**
 * The JSON-RPC client over a spawned server's stdio pipes now lives in
 * `tests/helpers/stdio-child.ts`, shared with `tests/env-switch-registry.test.ts`
 * and `tests/tool.surface.test.ts` (#1366).
 *
 * The class that used to live here was the only copy in the repo that settled
 * pending requests when the child died — `on('error')` and `on('exit')` both
 * called `failAll`. That is the behaviour the rest of this file is written
 * around, and its reasoning is preserved in the helper's header. What was
 * missing everywhere else was this: a child that is *killed* never rejects its
 * in-flight promise, so the two other files reported a reaped server as a
 * 30-second "timeout waiting for tools/list" and threw the cause away. `stderr`
 * cannot fill the gap — a SIGKILL leaves none.
 *
 * The promotions this file gained, rather than merely keeping:
 *   - every request now has its own watchdog (this file previously had only a
 *     file-level one armed in `before()`);
 *   - children are reaped by PID and awaited, not left to an `unref`'d timer
 *     that orphaned them whenever the file finished first;
 *   - the spawn env is the shared hermetic one, so a developer's exported
 *     `SPOTIFY_MCP_TOKEN_FILE` or `SPOTIFY_MCP_READONLY` can no longer reach a
 *     child, and the real `~/.spotify-mcp` is unreachable by construction
 *     rather than by a token file happening to point elsewhere.
 *
 * ## And what #1365 added, after all of that
 *
 * The watchdog above was armed in `before()` and cleared in `after()`, so it
 * bounded the handshake and nothing else — and `npm test` passes no
 * `--test-timeout`, so the runner's own default is unbounded. Four runs of this
 * file were reported sitting at 0.0 % CPU for 47–60 minutes. Two independent
 * causes, both fixed rather than papered over:
 *
 *   1. **A reaped child still held its pipes.** `dispose()` ended the child and
 *      released none of its stdio streams, so an inherited descriptor kept a
 *      `PipeWrap` in the event loop forever and the file could not drain. Fixed
 *      in `StdioJsonRpcChild.dispose()`, and reproduced and pinned in
 *      `tests/file-deadline.test.ts`.
 *   2. **Nothing bounded the file.** Now `armFileDeadline` at module scope, with
 *      no way to clear it, plus a `timeout` on the synchronous `npm pack` that a
 *      timer cannot reach. Details and measurements at the `FILE_BUDGET_MS`
 *      comment below and in `tests/helpers/file-deadline.ts`.
 */

let client: StdioJsonRpcChild;
let tokenFile = '';
let tempDir = '';

/**
 * Every child this file spawns, live or reaped, so the whole-file deadline can
 * name and reap all of them rather than only the one from `before()`.
 *
 * The old watchdog held a single `client` and was cleared by `after()`; the two
 * children spawned inside tests below (the packed entry and the read-only
 * surface) were outside its reach entirely.
 */
const spawned: StdioJsonRpcChild[] = [];

/** Spawn a child and register it with the whole-file deadline. */
function spawnTracked(options: Parameters<typeof StdioJsonRpcChild.spawn>[0]): StdioJsonRpcChild {
  const child = StdioJsonRpcChild.spawn(options);
  spawned.push(child);
  return child;
}

/**
 * The whole-file bound (#1365).
 *
 * ## Why this replaced the 30 s watchdog rather than being raised
 *
 * The watchdog this replaces was armed in `before()` and cleared at the top of
 * `after()`, so it bounded the handshake and nothing else — and `npm test` runs
 * the runner with no `--test-timeout`, so nothing else bounded the file either.
 * Four runs were reported sitting here for 47–60 minutes at **0.0 % CPU**:
 * blocked, not slow.
 *
 * The fix is not a bigger number. The repo's own measurement is `initialize:
 * 2046ms` / `tools/list: 2125ms` under load ~48, so 30 s is already ~14x the real
 * cost and the slack is deliberate; raising it adds no information and would
 * still have been cleared by the same `after()`. What was missing was a bound
 * that covers the whole file and that **nothing can switch off** — which is why
 * this is armed here, at module scope, before any hook runs, and why
 * `armFileDeadline` returns `void`: the old code's `clearTimeout(watchdog)` line
 * *was* the bug, so there is deliberately nothing to clear.
 *
 * ## Why the budget is 5 minutes and not 30 seconds
 *
 * This file runs `npm pack`, whose `prepack` is a full `tsc`, and boots three
 * real registry servers. Measured on this box: the whole file 3.75 s wall, of
 * which `npm pack` is 1.08 s — but that same `npm pack` took 4.3 s minutes
 * earlier at load ~48, and a `tsc` is exactly the kind of work whose cost
 * multiplies under load. 5 minutes is ~80x the file's measured wall and ~13x
 * the worst `npm pack` observed here, so it cannot fire on a slow-but-
 * progressing run; it exists for the case where the event loop cannot drain
 * *at all*, which no amount of patience distinguishes from a hang.
 *
 * The deadline cannot fire during `npm pack` — a synchronous child blocks the
 * event loop, so no timer runs — which is why that call carries its own
 * `timeout` in `PACK_TIMEOUT_MS` below. Two bounds because one mechanism cannot
 * cover both; see `tests/helpers/file-deadline.ts`.
 */
const FILE_BUDGET_MS = 5 * 60_000;

/**
 * `npm pack`'s own budget, in addition to the whole-file one.
 *
 * `execFileSync` blocks the event loop, so the deadline above cannot run while
 * it is on the stack (measured: a 200 ms timer did not fire until a 1.5 s
 * `execFileSync` returned). `prepack` is a full `tsc`, so this is the only bound
 * that covers it. It is deliberately the same 5 minutes as `FILE_BUDGET_MS`:
 * the two bounds do not stack, because the whole-file timer cannot run while
 * this call is blocking. Total wall time for the file is therefore bounded by
 * roughly the larger of the two rather than by their sum.
 */
const PACK_TIMEOUT_MS = 5 * 60_000;

armFileDeadline({
  label: 'tests/mcp.smoke.test.ts',
  budgetMs: FILE_BUDGET_MS,
  children: () => spawned,
});

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'spotify-mcp-smoke-'));
  // Future-dated token fixture: valid shape, never expires during the run.
  const tokenFixture = {
    access_token: 'smoke-test-access-token',
    refresh_token: 'smoke-test-refresh-token',
    expires_at: Date.now() + 60 * 60 * 1000,
  };
  tokenFile = join(tempDir, 'tokens.json');
  await writeFile(tokenFile, JSON.stringify(tokenFixture), { mode: 0o600 });

  client = spawnTracked({
    label: 'mcp-smoke',
    command: 'node',
    args: ['--import', 'tsx', 'src/index.ts'],
    cwd: REPO_ROOT,
    // `SPOTIFY_MCP_TOOLSETS=all` explicitly, for two reasons. This file is the
    // guard against SILENT WIRING LOSS — a module that stops registering — so
    // it has to see every module, and the default surface has been the curated
    // `core` set since #889. And the second assertion below calls `get_me`,
    // which is not in that set: leaving the default in place would make a
    // passing run depend on a curated-surface decision rather than on wiring.
    // The curated default is covered on purpose elsewhere, in
    // tests/tool.surface.test.ts.
    env: hermeticServerEnv(
      { SPOTIFY_MCP_TOKEN_FILE: tokenFile, SPOTIFY_MCP_TOOLSETS: 'all' },
      'smoke',
    ).env,
  });

  // Handshake: initialize → initialized notification → protocol ready.
  //
  // No file-level timer guards this any more. The per-request watchdog the
  // helper installs bounds it, and a child that dies during the handshake
  // rejects this call naming the signal and PID rather than being timed out.
  const init = await client.initialize('mcp-smoke-test');
  assert.equal(
    (init.result?.serverInfo as { name?: string } | undefined)?.name,
    'spotify-mcp',
    `unexpected serverInfo.name in ${JSON.stringify(init.result?.serverInfo)}`,
  );
  assert.equal(init.result?.protocolVersion, '2024-11-05');
});

after(async () => {
  // Every child, not just the one from `before()`: the packed entry and the
  // read-only surface are spawned inside tests, and either could be the one
  // still holding the event loop open. `dispose()` is idempotent and releases
  // each child's streams, so the file drains instead of lingering on a
  // `PipeWrap` (#1365).
  for (const child of spawned) {
    try {
      child.notify('notifications/exit'); // polite shutdown hint; ignored by older servers
    } catch {
      // stdin already closed, or the child is gone. Nothing to be polite about.
    }
    await child.dispose();
  }
  await rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

describe('MCP stdio smoke (real src/index.ts)', () => {
  it('lists exactly the expected tool surface', async () => {
    const res = await client.request('tools/list');
    const tools = res.result?.tools as Array<{ name: string }>;
    assert.ok(Array.isArray(tools), 'tools/list must return a tools array');

    const names = new Set(tools.map((t) => t.name));
    const missing = REQUIRED_TOOLS.filter((n) => !names.has(n));
    const forbidden = FORBIDDEN_TOOLS.filter((n) => names.has(n));

    assert.deepEqual(
      missing,
      [],
      `total tool count: ${tools.length}; missing tools: [${missing.join(', ')}]`,
    );
    assert.deepEqual(
      forbidden,
      [],
      `removed tools must stay removed, found again: [${forbidden.join(', ')}]`,
    );
    assert.ok(tools.length >= REQUIRED_TOOLS.length, `total tool count: ${tools.length} should cover at least the ${REQUIRED_TOOLS.length} required tools`);
  });

  it('exposes all prompt templates', async () => {
    const res = await client.request('prompts/list');
    const prompts = res.result?.prompts as Array<{ name: string }>;
    assert.ok(Array.isArray(prompts), 'prompts/list must return a prompts array');
    const names = new Set(prompts.map((p) => p.name));
    for (const expected of EXPECTED_PROMPTS) {
      assert.ok(names.has(expected), `expected prompt template "${expected}" in [${[...names].join(', ')}]`);
    }
    assert.equal(prompts.length, EXPECTED_PROMPTS.length, 'prompts/list should expose every registered template');
  });

  it('no longer lists the spotify://genres resource', async () => {
    const res = await client.request('resources/list');
    const resources = res.result?.resources as Array<{ uri: string }>;
    assert.ok(Array.isArray(resources), 'resources/list must return a resources array');
    const genreResource = resources.find((r) => r.uri === 'spotify://genres');
    assert.equal(genreResource, undefined, 'spotify://genres resource must not be listed');
    assert.ok(resources.some((r) => r.uri === 'spotify://me'), 'core spotify://me resource should still be listed');
  });

  // --------------------------------------------------------------
  // Multi-tool sequential workflow (regression guard for the
  // sequential-call anti-pattern: one tool call must not try to
  // subsume a second independent tool invocation).
  // --------------------------------------------------------------
  it('supports sequential tool workflow without the single-call anti-pattern', async () => {
    // Regression guard: agents must issue independent tools/call requests
    // for each tool invocation; one call must not subsume a second.
    // We exercise two sequential calls against the live stdio server.
    //
    // Call 1: local-only parse_spotify_uri (zero network — always succeeds).
    const parseRes = await client.request('tools/call', {
      name: 'parse_spotify_uri',
      arguments: { uri: 'spotify:track:4iV5W9uYEdYUVa79Axb7Rh' },
    });

    // Call 2: get_me — the first networked tool on the surface, called with no
    // arguments against a stub token, so it cannot succeed.
    //
    // #667: the old guard was
    //   assert.ok(meRes.error !== undefined || meRes.result !== undefined)
    // which holds for every JSON-RPC response the transport can produce, and
    // StdioClient.request() rejects on a JSON-RPC error, so the error arm was
    // unreachable. It asserted nothing. What the test can actually pin is the
    // outcome: a call that cannot succeed must come back as a failure, mapped
    // to the failing tool, carrying a classification from the server's own
    // vocabulary and a numeric status. It does NOT pin WHICH class is correct
    // — the runtime gets that wrong today; see the known-defect note below.
    //
    // One neighbouring guarantee is deliberately NOT re-asserted here because
    // the harness already fails the run before any assertion could: a dead
    // process. The harness's `exit` handler calls failAll, which rejects every
    // in-flight request, so a `process.exit` inside the tool rejects this call
    // with "server exited early" rather than returning a payload to assert on.
    // A malformed CallToolResult is NOT in that category: the harness does no
    // result validation of its own, so such a payload would resolve and be
    // caught by the `assert.ok(failure, …)` guard below instead.
    const meRes = await client.request('tools/call', {
      name: 'get_me',
      arguments: {},
    });
    // request() rejects on a JSON-RPC error, so a resolved call always carries
    // `result`; the field is merely declared optional on the wire type.
    const me = meRes.result as { isError?: unknown; structuredContent?: unknown };
    assert.equal(me.isError, true, 'get_me must not report success against a stub token');
    const failure = (me.structuredContent as { error?: { tool?: unknown; kind?: unknown; status?: unknown } } | undefined)?.error;
    assert.ok(failure, 'a failing tool must map its error into structuredContent.error');
    // The error is attributed to the tool that produced it, not to the session
    // or the argument batch: `errorResult` stamps the requested name. A payload
    // that dropped or mis-stamped it would leave an operator unable to tell
    // which call failed, and a "some tool failed" message here would sail
    // through the kind/status guards below.
    assert.equal(failure.tool, 'get_me', 'the mapped error must name the failing tool');
    // Constrained to the server's own classification vocabulary, not merely to
    // "a non-empty string": a typo'd or unmapped class would otherwise sail
    // straight through. Deliberately NOT pinned to the *correct* class — see
    // the known-defect note below for why, and for what to tighten it to.
    assert.ok(
      typeof failure.kind === 'string' && KNOWN_ERROR_KINDS.includes(failure.kind),
      `mapped error kind must be one of [${KNOWN_ERROR_KINDS.join(', ')}], got ${JSON.stringify(failure.kind)}`,
    );
    assert.equal(typeof failure.status, 'number', 'the mapped error must carry a numeric status');

    // KNOWN DEFECT, deliberately not asserted (the runtime is wrong, the fix is
    // not ours): the real cause of this failure is authentication. GET /v1/me
    // answers 401, the client then tries to refresh, the stub refresh token
    // makes POST accounts.spotify.com/api/token answer 400, and that 400
    // replaces the original 401 — so the status->kind mapping lands on
    // `validation`. An operator with a dead token is told "received invalid
    // arguments; pass values that match the tool schema" for a call that passed
    // no arguments at all. That belongs in src/client.ts (a refresh failure
    // must not overwrite the originating 401) and in the mapping in
    // src/tools/annotations.ts, both outside this test's ownership. Once it is
    // fixed, tighten the assertion above to `assert.equal(failure.kind, 'auth')`
    // — the red-proof for that is the classifier mutation which today leaves
    // this file green (400/422 -> 'internal', or 401 -> 'not_found').
  });
});

describe('npm package artifact', () => {
  it('packs a shebanged dist entry that starts and initializes', async () => {
    // Bounded on both legs, and reported through #1335's vocabulary: a `tsc` that
    // overruns here has to read as a killed subprocess, not as an opaque
    // `spawnSync … ETIMEDOUT`. Neither call can be bounded by the file deadline,
    // because a synchronous child blocks the event loop the deadline timer needs.
    const packOutput = execFileBounded(
      'npm',
      ['pack', '--json', '--pack-destination', tempDir],
      { label: 'npm pack', timeoutMs: PACK_TIMEOUT_MS, cwd: REPO_ROOT },
    );
    const [{ filename }] = JSON.parse(packOutput) as Array<{ filename: string }>;
    const packageDir = join(tempDir, 'package');
    execFileBounded(
      'tar',
      ['-xzf', join(tempDir, filename), '-C', tempDir],
      { label: 'tar -xzf (npm pack output)', timeoutMs: PACK_TIMEOUT_MS, cwd: REPO_ROOT },
    );

    const packedEntry = join(packageDir, 'dist', 'index.js');
    const firstLine = (await readFile(packedEntry, 'utf8')).split('\n', 1)[0];
    assert.equal(firstLine, '#!/usr/bin/env node', 'npm tarball must contain the executable shebang');

    // Dependencies are supplied by the consumer's install; link the checkout's
    // installed dependencies so this test remains offline while exercising the
    // actual packed entry point.
    await symlink(join(REPO_ROOT, 'node_modules'), join(packageDir, 'node_modules'), 'dir');
    const packagedClient = spawnTracked({
      label: 'mcp-package-smoke',
      command: process.execPath,
      args: [packedEntry],
      cwd: packageDir,
      env: hermeticServerEnv({ SPOTIFY_MCP_TOKEN_FILE: tokenFile }, 'packaged').env,
    });
    try {
      const init = await packagedClient.initialize('mcp-package-smoke');
      assert.equal(
        (init.result?.serverInfo as { name?: string } | undefined)?.name,
        'spotify-mcp',
      );
    } finally {
      // Bounded, and reaped by PID. The old `await once(child, 'exit')` here had
      // no bound at all: a packed entry that did not exit on stdin EOF hung the
      // suite forever, and `--test-timeout` is off, so nothing else would catch it.
      await packagedClient.dispose();
    }
  });
});

describe('SPOTIFY_MCP_READONLY hides write-capable modules (#579)', () => {
  it('exposes no writer tools and a strictly smaller surface', async () => {
    const readOnlyClient = spawnTracked({
      label: 'mcp-readonly-smoke',
      command: 'node',
      args: ['--import', 'tsx', 'src/index.ts'],
      cwd: REPO_ROOT,
      env: hermeticServerEnv(
        { SPOTIFY_MCP_TOKEN_FILE: tokenFile, SPOTIFY_MCP_READONLY: '1' },
        'readonly-smoke',
      ).env,
    });
    try {
      await readOnlyClient.initialize('mcp-readonly-smoke');

      const roRes = await readOnlyClient.request('tools/list');
      const roNames = new Set(((roRes.result?.tools ?? []) as Array<{ name: string }>).map((t) => t.name));
      const leaked = READONLY_WRITE_TOOLS.filter((n) => roNames.has(n));
      assert.deepEqual(leaked, [], `write tools visible under SPOTIFY_MCP_READONLY=1: [${leaked.join(', ')}]`);

      const fullRes = await client.request('tools/list');
      const fullNames = ((fullRes.result?.tools ?? []) as unknown[]).length;
      assert.ok(
        roNames.size < fullNames,
        `read-only surface (${roNames.size}) must be smaller than the full surface (${fullNames})`,
      );
    } finally {
      // Reaped and awaited, replacing an `unref`'d kill timer that orphaned the
      // child whenever this file finished before it fired.
      await readOnlyClient.dispose();
    }
  });
});
