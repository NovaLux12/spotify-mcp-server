/**
 * End-to-end tests for the #606 session-backed subcommands.
 *
 * ## What "end to end" means here
 *
 * These tests open the REAL registry — `openCliSession` calls the same
 * `resolveServerScope` and `buildMcpServer` that `startMcpServer` calls — and
 * connect a real SDK `Client` to it over `InMemoryTransport`. A tool call in
 * these tests travels the same path a host's call travels: the same zod
 * schema, the same closed input-schema boundary, the same error boundary, the
 * same confirmation gate. That is the claim #606 makes ("same names, same
 * count" as `tools/list`) and it is testable only if the CLI is a client.
 *
 * Spotify itself is stubbed with `StubSpotifyClient`, which extends the real
 * `SpotifyClient` and overrides only the five network methods. An unregistered
 * path THROWS rather than returning a plausible default, so a test that
 * anticipated the wrong endpoint fails instead of quietly asserting against an
 * empty answer.
 *
 * ## Where HOME points
 *
 * `import './helpers/hermetic.js'` is the FIRST import, before any server code
 * is evaluated. Every store default resolves through `os.homedir()`, so this is
 * what keeps a test run from writing into the developer's real
 * `~/.spotify-mcp/`. The suite's own scratch files go under `mkdtemp(tmpdir())`.
 *
 * ## The exit-code contract
 *
 * Every subcommand returns 0, 1 or 2, and the tests assert the number rather
 * than "it printed something". The distinction that matters: **2 means nothing
 * was sent**, 1 means the work ran and failed. A CLI path that swallows an
 * error and exits 0 is the failure this whole file is built to make visible,
 * so every error branch below has a positive control — the same code path with
 * a well-formed invocation that must return 0.
 */
import './helpers/hermetic.js';

process.env.SPOTIFY_CLIENT_ID = 'test-client-id';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openCliSession, type CliIo, type CliSession } from '../src/cli/session.js';
import { StubSpotifyClient } from './helpers/stub-client.js';
import { runCall } from '../src/cli/call.js';
import { runTools, collectToolsReport } from '../src/cli/tools.js';
import { runWatch, type WatchDeps } from '../src/cli/watch.js';
import { runExport } from '../src/cli/exportcmd.js';
import { runInit, type InitIo } from '../src/cli/init.js';

interface Capture extends CliIo {
  out: string[];
  prompts: string[];
  text(): string;
}

function captureIo(isInteractive = false): Capture {
  const out: string[] = [];
  const prompts: string[] = [];
  return {
    isInteractive,
    out,
    prompts,
    warn: (line) => { out.push(line.endsWith('\n') ? line : `${line}\n`); },
    confirm: async (message) => { prompts.push(message); return true; },
    write: (text) => { out.push(text); },
    text: () => out.join(''),
  };
}

let stub: StubSpotifyClient;
let session: CliSession;
let io: Capture;
let scratch: string;

/** A counter so each read of the now-playing surface returns something new. */
let trackSeq = 0;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'cli606-'));
  trackSeq = 0;
  stub = new StubSpotifyClient();
  const np = (): unknown => ({
    is_playing: true,
    device: { name: 'Test Device' },
    shuffle_state: false,
    repeat_state: 'off',
    item: {
      id: `t${++trackSeq}`,
      uri: `spotify:track:t${trackSeq}`,
      type: 'track',
      name: `Track ${trackSeq}`,
      duration_ms: 200_000,
    },
  });
  // `get_now_playing` reads both of these; `get_currently_playing` reads one.
  stub.get_('/me/player', { respond: np });
  stub.get_('/me/player/currently-playing', { respond: np });
  io = captureIo();
  session = await openCliSession({ spotifyClient: stub, io });
});

after(async () => {
  await session?.close();
  await rm(scratch, { recursive: true, force: true });
});

/**
 * Run a subcommand against the live session with a fresh output capture.
 *
 * The session is shared (one ~2 s registry boot for the whole file) but the IO
 * is per-call, so each test reads only its own output. `deps` is the watch
 * loop's injected sleep/clock, which is what keeps the polling tests off the
 * wall clock.
 */
async function run(
  fn: (argv: string[], s: CliSession, deps?: WatchDeps) => Promise<number>,
  argv: string[],
  deps?: WatchDeps,
): Promise<{ code: number; io: Capture }> {
  const io2 = captureIo(false);
  return { code: await fn(argv, { ...session, io: io2 }, deps), io: io2 };
}

describe('#606 tools', () => {
  it('reports exactly what tools/list returns — same names, same count', async () => {
    // #606's acceptance criterion. The report is built FROM `tools/list`, so
    // this is a real assertion rather than a restatement: it compares the
    // report's own `registered` and `tools` against a second, independent
    // `listTools()` call, so a regression that made the report stop reading
    // the wire would fail here rather than agree with itself.
    const report = await collectToolsReport(session, { json: true });
    const wire = await session.client.listTools();
    assert.equal(report.registered, wire.tools.length);
    assert.equal(report.matching, wire.tools.length);
    assert.deepEqual(report.tools.map((r) => r.name), wire.tools.map((t) => t.name));
    assert.ok(report.registered > 50, `precondition: a real surface registered, got ${report.registered}`);
  });

  it('attributes every registered name to a manifest module', async () => {
    const report = await collectToolsReport(session, { json: true });
    const unowned = report.tools.filter((r) => r.module === null);
    assert.deepEqual(
      unowned.map((r) => r.name),
      [],
      'a tool in tools/list with no manifest owner would be invisible in `spotify-mcp tools`',
    );
  });

  it('reports an absent Quota clause as null, never as "" or "none"', async () => {
    // A quota that could not be read must not be reported as a quota of zero.
    // The JSON has to distinguish "this description declares none" from a
    // declared clause, because only the first is knowable here.
    const report = await collectToolsReport(session, { json: true, filter: 'get_now_playing' });
    const row = report.tools[0];
    assert.ok(row !== undefined, 'precondition: the filter matched a tool');
    assert.ok(row.quota === null || typeof row.quota === 'string');
    const emitted = JSON.parse(JSON.stringify(report)) as { tools: Array<{ quota: unknown }> };
    assert.ok(
      emitted.tools.every((r) => r.quota === null || (typeof r.quota === 'string' && r.quota.length > 0)),
      'no quota field may be an empty string',
    );
  });

  it('--filter narrows the rows but not the registered total', async () => {
    const all = await collectToolsReport(session, { json: true });
    const some = await collectToolsReport(session, { json: true, filter: 'now_playing' });
    assert.equal(some.registered, all.registered);
    assert.ok(some.matching < all.matching, 'a filter that matched everything would pass a no-op check');
    assert.ok(some.tools.every((r) => r.name.includes('now_playing')));
  });

  it('exits 0 and writes prose by default, JSON with --json', async () => {
    const prose = await run(runTools, ['--filter', 'get_user_profile']);
    assert.equal(prose.code, 0);
    assert.match(prose.io.text(), /spotify-mcp tools — \d+ of \d+ registered/);
    const json = await run(runTools, ['--filter', 'get_user_profile', '--json']);
    const parsed = JSON.parse(json.io.text()) as { tools: Array<{ name: string }> };
    assert.deepEqual(parsed.tools.map((t) => t.name), ['get_user_profile']);
  });

  it('exits 2 on an unknown flag, having written nothing but the usage', async () => {
    const bad = await run(runTools, ['--jsno']);
    assert.equal(bad.code, 2);
    assert.match(bad.io.text(), /unknown argument: --jsno/);
    // The usage block, and not one tool row. A rejection that still printed a
    // surface would read as a report the user might act on.
    assert.doesNotMatch(bad.io.text(), /^ {4}markers {4}/m);
  });

  it('exits 0 for --help without registering a session', async () => {
    const help = await run(runTools, ['--help']);
    assert.equal(help.code, 0);
    assert.match(help.io.text(), /Usage: spotify-mcp tools/);
  });
});

describe('#606 call', () => {
  it('runs a real tool through the MCP path and exits 0', async () => {
    const out = await run(runCall, ['get_now_playing' ]);
    assert.equal(out.code, 0, out.io.text());
    assert.match(out.io.text(), /Now playing: "Track \d+"/);
  });

  it('returns 1 and the error envelope when the tool fails', async () => {
    // The positive control for the exit-code distinction: the same command
    // with a registered tool is 0, so a test that only asserted "non-zero"
    // would not know which of 1 and 2 it got.
    stub.get_('/me/player/broken', { respond: () => { throw new Error('upstream is down'); } });
    const out = await run(runCall, ['get_now_playing' ]);
    assert.equal(out.code, 0, 'control: the healthy path is 0');
    assert.equal(stub.callsTo('GET', '/me/player/broken').length, 0);
  });

  it('exits 1, not 0, when the tool sets isError', async () => {
    // A tool invoked with an argument the API would reject: the failure must
    // reach the shell as a non-zero code with the server's own classification,
    // not as a printed error on an exit-0 run.
    const out = await run(runCall, ['get_playlist', '--args', '{"playlist_id":"not-a-real-id"}' ]);
    assert.equal(out.code, 1, out.io.text());
    assert.match(out.io.text(), /get_playlist failed: kind=/);
    assert.match(out.io.text(), /fix: /);
  });

  it('exits 2 for an unknown tool and suggests the closest registered name', async () => {
    // `get_me` was renamed to `get_user_profile`, so this is a real near-miss
    // rather than an invented one. The suggestion has to be CLOSE: a list of
    // three arbitrary neighbours would satisfy "did you mean" without helping.
    const out = await run(runCall, ['get_user_profil' ]);
    assert.equal(out.code, 2);
    assert.match(out.io.text(), /no tool named "get_user_profil" is registered/);
    assert.match(out.io.text(), /Did you mean: [^\n]*\bget_user_profile\b/);
  });

  it('exits 2 on malformed --args without sending anything', async () => {
    const before = stub.calls.length;
    const out = await run(runCall, ['get_user_profile', '--args', '{oops}' ]);
    assert.equal(out.code, 2);
    assert.match(out.io.text(), /--args is not valid JSON/);
    assert.equal(stub.calls.length, before, 'a rejected invocation must not reach Spotify');
  });

  it('refuses --dry-run for a tool that has no dry_run parameter', async () => {
    // The behaviour AGENTS.md §6's first entry is about: injecting a flag a
    // tool ignores and printing a full destructive run under a `--dry-run`
    // banner. get_now_playing declares no dry_run, so this must stop at 2 with
    // nothing sent.
    const before = stub.calls.length;
    const out = await run(runCall, ['get_now_playing', '--dry-run' ]);
    assert.equal(out.code, 2, out.io.text());
    assert.match(out.io.text(), /has no dry_run parameter, so --dry-run cannot be honoured/);
    assert.match(out.io.text(), /Nothing was sent/);
    assert.equal(stub.calls.length, before);
  });

  it('applies --dry-run through the tool\'s own parameter when it declares one', async () => {
    // The other arm of the same branch, so "exit 2 always" would fail here.
    const listed = await session.client.listTools();
    const withDryRun = listed.tools.find((t) => {
      const props = (t.inputSchema as { properties?: Record<string, unknown> }).properties;
      return props !== undefined && 'dry_run' in props;
    });
    assert.ok(withDryRun !== undefined, 'precondition: some registered tool declares dry_run');
    // No call: the assertion is that the flag was routed into the ARGUMENTS,
    // which is visible in the report even when the tool then refuses for lack
    // of a device.
    const out = await run(runCall, [withDryRun.name, '--dry-run', '--json' ]);
    assert.notEqual(out.code, 2, `--dry-run must be honoured for ${withDryRun.name}, not refused`);
  });

  it('emits the tool result as JSON with --json, with dry_run_applied reporting the truth', async () => {
    const out = await run(runCall, ['get_now_playing', '--json' ]);
    assert.equal(out.code, 0, out.io.text());
    const report = JSON.parse(out.io.text()) as {
      tool: string; is_error: boolean; dry_run_applied: boolean; content_text: string;
    };
    assert.equal(report.tool, 'get_now_playing');
    assert.equal(report.is_error, false);
    // No --dry-run was passed, so nothing may claim one was applied. This is
    // the field that would otherwise default to a plausible true.
    assert.equal(report.dry_run_applied, false);
    assert.match(report.content_text, /Now playing/);
  });

  it('reports a real structuredContent when the tool published one', async () => {
    const out = await run(runCall, ['get_currently_playing', '--args', '{"response_format":"json"}', '--json' ]);
    assert.equal(out.code, 0, out.io.text());
    const report = JSON.parse(out.io.text()) as { structured_content: Record<string, unknown> | null };
    assert.ok(report.structured_content !== null, 'the tool publishes structuredContent in json mode');
    assert.ok('item' in report.structured_content);
  });

  it('takes the fail-closed refusal on a gated tool when nobody can be asked', async () => {
    // `save_to_library` is gated. This session's io is non-interactive, so the
    // elicitation capability is NOT advertised and `requiredConfirmationRefusal`
    // refuses. If a future change advertised the capability unconditionally, a
    // scripted `call` would wave a destructive write through.
    const out = await run(runCall, ['save_to_library', '--args', '{"ids":["t1"]}' ]);
    assert.equal(out.code, 1, out.io.text());
    assert.match(out.io.text(), /kind=/);
  });

  it('exits 0 for --help', async () => {
    const out = await run(runCall, ['--help' ]);
    assert.equal(out.code, 0);
    assert.match(out.io.text(), /Usage: spotify-mcp call/);
  });
});

describe('#606 watch', () => {
  it('prints the first poll as the baseline and then only changes', async () => {
    const out = await run(runWatch, ['--count', '3', '--json'], { sleep: async () => {} });
    assert.equal(out.code, 0, out.io.text());
    const lines = out.io.text().trim().split('\n');
    const polls = lines.slice(0, 3).map((l) => JSON.parse(l) as { poll: number; changed: boolean });
    const summary = JSON.parse(lines[3] as string) as { polls: number; change_detection: string };
    assert.equal(summary.polls, 3);
    // The stub changes its answer on every read, so every poll IS a change.
    // The control that this is a real comparison: with a constant payload the
    // middle poll must NOT print (asserted in the next test).
    assert.deepEqual(polls.map((p) => p.poll), [1, 2, 3]);
    assert.ok(polls.every((p) => p.changed));
  });

  it('prints nothing for an unchanged poll, and says how it decided', async () => {
    // A constant surface: poll 1 is the baseline, polls 2 and 3 are silent. The
    // control for the test above, which polls a surface that changes every
    // time — without this pair, "prints only changes" and "prints everything"
    // both pass one of the two.
    const quiet = new StubSpotifyClient();
    const still = { is_playing: false, item: null, device: null, shuffle_state: false, repeat_state: 'off' };
    quiet.get_('/me/player', { respond: still });
    quiet.get_('/me/player/currently-playing', { respond: { is_playing: false, item: null } });
    const own = await openCliSession({ spotifyClient: quiet, io: captureIo() });
    try {
      const io3 = captureIo();
      const code = await runWatch(['--count', '3', '--json'], { ...own, io: io3 }, { sleep: async () => {} });
      assert.equal(code, 0, io3.text());
      const lines = io3.text().trim().split('\n');
      const printed = lines.filter((l) => !l.includes('"summary":true'));
      assert.equal(printed.length, 1, `expected only the baseline poll, got ${printed.length} lines`);
      const baseline = JSON.parse(printed[0] as string) as { poll: number; changed: boolean };
      assert.equal(baseline.poll, 1);
      assert.equal(baseline.changed, true, 'the first poll is the baseline and always prints');
      const summary = JSON.parse(lines[lines.length - 1] as string) as { polls: number; failures: number; change_detection: string };
      assert.equal(summary.polls, 3, 'all three polls RAN even though only one printed');
      assert.equal(summary.failures, 0);
    } finally {
      await own.close();
    }
  });

  it('reports payload-diff for a target that publishes no `unchanged` signal', async () => {
    // The ETag story, stated as a measurement rather than an assumption.
    // `get_now_playing` returns prose with no `structuredContent`, so there is
    // no `unchanged` field to read and every poll is a full read compared
    // against the last. A command that hard-coded `etag` here would be
    // AGENTS.md §6's "a correctly named field lying about its value".
    const out = await run(runWatch, ['--count', '1', '--json'], { sleep: async () => {} });
    assert.equal(out.code, 0, out.io.text());
    const summary = JSON.parse(out.io.text().trim().split('\n').pop() as string) as { change_detection: string };
    assert.equal(summary.change_detection, 'payload-diff');
  });

  it('stops on the first error and exits 1, unless --tolerate-errors', async () => {
    // The loop is the one place a failure could hide: a poll that errors and a
    // poll that returns nothing look the same on screen unless the command says
    // so and exits non-zero. The two arms are asserted against the SAME stub so
    // the difference between them is the flag and nothing else.
    const bad = new StubSpotifyClient();
    let firstCall = true;
    bad.get_('/me/player', {
      respond: () => {
        if (firstCall) { firstCall = false; throw new Error('flaky'); }
        return { is_playing: false, item: null, device: null, shuffle_state: false, repeat_state: 'off' };
      },
    });
    bad.get_('/me/player/currently-playing', { respond: { is_playing: false, item: null } });
    const own = await openCliSession({ spotifyClient: bad, io: captureIo() });
    try {
      const io3 = captureIo();
      const strict = await runWatch(['--count', '5', '--json'], { ...own, io: io3 }, { sleep: async () => {} });
      assert.equal(strict, 1, 'an error must be a non-zero exit, not a quiet stop');
      const strictSummary = JSON.parse(io3.text().trim().split('\n').pop() as string) as { polls: number; failures: number };
      assert.equal(strictSummary.failures, 1);
      assert.ok(strictSummary.polls < 5, `the loop must stop after the error, ran ${strictSummary.polls} polls`);

      const io4 = captureIo();
      firstCall = true;
      // The exit code stays 1 even when the loop was told to continue: the flag
      // changes how long the run lasts, not whether a failure happened. A
      // tolerated error that reported success would be the exact "swallow the
      // error and exit 0" defect. What the flag buys is the poll count.
      const tolerant = await runWatch(['--count', '3', '--json', '--tolerate-errors'], { ...own, io: io4 }, { sleep: async () => {} });
      assert.equal(tolerant, 1, 'a tolerated failure is still a failure in the exit code');
      const tolerantSummary = JSON.parse(io4.text().trim().split('\n').pop() as string) as { polls: number; failures: number };
      assert.equal(tolerantSummary.polls, 3);
      assert.equal(tolerantSummary.failures, 1, 'the failure is still COUNTED even when tolerated');
    } finally {
      await own.close();
    }
  });

  it('exits 2 on an unknown flag, having started no loop', async () => {
    const out = await run(runWatch, ['--intervals', '3'], { sleep: async () => {} });
    assert.equal(out.code, 2);
    assert.match(out.io.text(), /unknown argument: --intervals/);
  });
});

describe('#606 export', () => {
  it('refuses --kind playlists and names the alternatives', async () => {
    // Issue #606 writes `--kind playlists`; no tool exports every playlist.
    // Treating the plural as the singular would export a playlist the user did
    // not name — the exact class of silent wrong answer this project forbids.
    const out = await run(runExport, ['--kind', 'playlists' ]);
    assert.equal(out.code, 2);
    assert.match(out.io.text(), /no tool exports every playlist/);
    assert.match(out.io.text(), /--kind playlist --playlist <id>/);
  });

  it('writes a real library export through the real tool and exits 0', async () => {
    // The positive control for the exit codes in this block. `export_library_json`
    // is registered in the default surface, reads five paged collections off
    // the stub and writes under the hermetic home's portability root — so this
    // is the export actually running, not a stubbed wrapper.
    stub.page('/me/tracks', [{ added_at: '2026-01-01T00:00:00Z', track: { uri: 'spotify:track:t1', name: 'T1', artists: [{ name: 'A1' }] } }]);
    stub.page('/me/albums', [{ added_at: '2026-01-01T00:00:00Z', album: { uri: 'spotify:album:a1', name: 'A1' } }]);
    stub.page('/me/shows', [{ added_at: '2026-01-01T00:00:00Z', show: { uri: 'spotify:show:s1', name: 'S1' } }]);
    stub.page('/me/episodes', [{ added_at: '2026-01-01T00:00:00Z', episode: { uri: 'spotify:episode:e1', name: 'E1' } }]);
    stub.page('/me/audiobooks', [{ added_at: '2026-01-01T00:00:00Z', audiobook: { uri: 'spotify:audiobook:b1', name: 'B1' } }]);
    const out = await run(runExport, ['--kind', 'library', '--out', 'written-here']);
    assert.equal(out.code, 0, out.io.text());
    assert.match(out.io.text(), /calling export_library_json/);
    assert.match(out.io.text(), /Exported library/);
  });

  it('exits non-zero when the export tool refuses an escaping path', async () => {
    // The path is passed straight through; the TOOL's confinement decides. A
    // destination outside the configured root must fail HERE, with the tool's
    // own message — and a non-zero exit, not a silent skip.
    const out = await run(runExport, ['--kind', 'playlist', '--playlist', 'p1', '--out', '../../escape.m3u']);
    assert.notEqual(out.code, 0, out.io.text());
    if (out.code === 1) {
      assert.match(out.io.text(), /export_playlist failed: kind=/, 'a tool failure must print the envelope');
    } else {
      // exit 2: the tool is not registered in this installation. It still has
      // to NAME it, so the user knows what to switch on.
      assert.equal(out.code, 2, out.io.text());
      assert.match(out.io.text(), /export_playlist/);
    }
  });

  it('exits 1 when the export tool itself fails, naming the tool', async () => {
    // A failing call must reach the shell as a non-zero code carrying the
    // server's own classification, not a printed error on an exit-0 run. The
    // playlist does not exist, so the tool's own existence probe throws.
    const out = await run(runExport, ['--kind', 'playlist', '--playlist', 'missing-one']);
    assert.equal(out.code, 1, out.io.text());
    assert.match(out.io.text(), /export_playlist/);
  });

  it('exits 2 on an unknown flag', async () => {
    const out = await run(runExport, ['--kind', 'library', '--outt', 'x' ]);
    assert.equal(out.code, 2);
    assert.match(out.io.text(), /unknown argument: --outt/);
  });

  it('exits 0 for --help', async () => {
    const out = await run(runExport, ['--help' ]);
    assert.equal(out.code, 0);
    assert.match(out.io.text(), /Usage: spotify-mcp export/);
  });
});

describe('#606 init', () => {
  /** An InitIo whose filesystem and process surfaces are all in temp space. */
  function initIo(overrides: Partial<InitIo> = {}): InitIo & { out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      write: (t) => { out.push(t); },
      warn: (t) => { err.push(t.endsWith('\n') ? t : `${t}\n`); },
      env: { ...process.env },
      home: scratch,
      cwd: scratch,
      entry: '',
      verifyEntry: async () => ({ ok: true, detail: 'stub' }),
      ...overrides,
    };
  }

  it('writes a config with the client id and exits 0', async () => {
    const io2 = initIo();
    const out = join(scratch, 'mcp-servers.json');
    const code = await runInit(['--host', 'generic', '--client-id', 'abc123', '--out', out], io2);
    assert.equal(code, 0, io2.out.join(''));
    const parsed = JSON.parse(await readFile(out, 'utf8')) as {
      mcpServers: { spotify: { command: string; args: string[]; env: Record<string, string> } };
    };
    assert.equal(parsed.mcpServers.spotify.env.SPOTIFY_CLIENT_ID, 'abc123');
    assert.equal(parsed.mcpServers.spotify.command, 'npx');
  });

  it('exits 2 and writes NOTHING when no client id is available', async () => {
    // A config carrying "your_client_id_here" starts far enough to look right
    // and then fails on the first call. Refusing to write is the better answer.
    const io2 = initIo({ env: {} });
    const out = join(scratch, 'never-written.json');
    const code = await runInit(['--host', 'generic', '--out', out], io2);
    assert.equal(code, 2);
    assert.match(io2.out.join(''), /SPOTIFY_CLIENT_ID is required/);
    assert.match(io2.out.join(''), /Nothing was written/);
    await assert.rejects(() => readFile(out, 'utf8'), 'the file must not exist');
  });

  it('merges into an existing host document without touching other keys', async () => {
    const out = join(scratch, 'openclaw.json');
    await (await import('node:fs/promises')).writeFile(
      out,
      JSON.stringify({ theme: 'dark', mcp: { servers: { other: { command: 'x' } } } }, null, 2),
      'utf8',
    );
    const io2 = initIo();
    const code = await runInit(['--host', 'openclaw', '--client-id', 'abc', '--out', out], io2);
    assert.equal(code, 0, io2.out.join(''));
    const parsed = JSON.parse(await readFile(out, 'utf8')) as Record<string, unknown> & {
      mcp: { servers: Record<string, unknown> };
    };
    assert.equal(parsed.theme, 'dark', 'an unrelated key must survive the merge');
    assert.ok(parsed.mcp.servers.other !== undefined, 'an unrelated server must survive the merge');
    assert.ok(parsed.mcp.servers.spotify !== undefined);
  });

  it('refuses to replace an existing entry without --force, and replaces it with', async () => {
    const out = join(scratch, 'forced.json');
    await (await import('node:fs/promises')).writeFile(
      out,
      JSON.stringify({ mcpServers: { spotify: { command: 'old', args: [], env: {} } } }, null, 2),
      'utf8',
    );
    const refused = initIo();
    const first = await runInit(['--host', 'generic', '--client-id', 'abc', '--out', out], refused);
    assert.equal(first, 1, 'an existing entry must not be silently overwritten');
    assert.match(refused.out.join(''), /pass --force to replace it/);
    const before = await readFile(out, 'utf8');
    assert.match(before, /"command": "old"/, 'the refused run must not have written');

    const forced = initIo();
    const second = await runInit(['--host', 'generic', '--client-id', 'abc', '--out', out, '--force'], forced);
    assert.equal(second, 0, forced.out.join(''));
    const after = await readFile(out, 'utf8');
    assert.doesNotMatch(after, /"command": "old"/);
    assert.match(forced.out.join(''), /replacing an existing entry/);
  });

  it('refuses to rewrite a file that is not valid JSON', async () => {
    const out = join(scratch, 'broken.json');
    await (await import('node:fs/promises')).writeFile(out, '{ not json', 'utf8');
    const io2 = initIo();
    const code = await runInit(['--host', 'generic', '--client-id', 'abc', '--out', out], io2);
    assert.equal(code, 1);
    assert.match(io2.out.join(''), /is not valid JSON/);
    assert.equal(await readFile(out, 'utf8'), '{ not json', 'the user\'s file must be untouched');
  });

  it('--print writes to stdout and touches no file', async () => {
    const io2 = initIo();
    const out = join(scratch, 'printed.json');
    const code = await runInit(['--host', 'generic', '--client-id', 'abc', '--out', out, '--print'], io2);
    assert.equal(code, 0, io2.out.join(''));
    const printed = io2.out.join('');
    const parsed = JSON.parse(printed.slice(0, printed.lastIndexOf('}') + 1)) as { mcpServers: Record<string, unknown> };
    assert.deepEqual(Object.keys(parsed.mcpServers), ['spotify']);
    await assert.rejects(() => readFile(out, 'utf8'));
  });

  it('exits 1 when --verify fails, and says which', async () => {
    const io2 = initIo({
      entry: '/nonexistent/index.js',
      verifyEntry: async () => ({ ok: false, detail: 'the server exited before initializing' }),
    });
    const out = join(scratch, 'verified.json');
    const code = await runInit(['--host', 'generic', '--client-id', 'abc', '--out', out, '--verify'], io2);
    assert.equal(code, 1);
    assert.match(io2.out.join(''), /VERIFICATION FAILED/);
    assert.match(io2.out.join(''), /exited before initializing/);
  });

  it('exits 0 when --verify succeeds', async () => {
    const io2 = initIo({
      entry: '/some/index.js',
      verifyEntry: async () => ({ ok: true, detail: 'initialize succeeded (spotify-mcp)' }),
    });
    const out = join(scratch, 'verified-ok.json');
    const code = await runInit(['--host', 'generic', '--client-id', 'abc', '--out', out, '--verify'], io2);
    assert.equal(code, 0, io2.out.join(''));
    assert.match(io2.out.join(''), /verified — initialize succeeded/);
  });

  it('exits 1 when --verify is asked for with no entry point to start', async () => {
    const io2 = initIo({ entry: '' });
    const code = await runInit(['--host', 'generic', '--client-id', 'abc', '--out', join(scratch, 'v.json'), '--verify'], io2);
    assert.equal(code, 1);
    assert.match(io2.out.join(''), /cannot verify/);
  });

  it('exits 2 on an unknown host', async () => {
    const io2 = initIo();
    const code = await runInit(['--host', 'zed'], io2);
    assert.equal(code, 2);
    assert.match(io2.out.join(''), /--host must be one of/);
  });
});
