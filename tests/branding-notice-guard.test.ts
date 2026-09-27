/**
 * Non-affiliation notice guard (#705).
 *
 * The project keeps the name "SpotifyMCP" for v2 as a recorded, accepted risk
 * against Spotify's Developer Policy Sec. VI.2 — see
 * `docs/compliance.md#naming-decision-2026-09-18`. That decision is only
 * defensible if nobody can be left thinking this is an official integration, so
 * the notice has to be on every surface, and the whole failure mode of a
 * compliance notice is that it decays silently: the notice is added, a
 * surface is added later, and the new surface ships without it, and nothing
 * fails.
 *
 * This guard is what makes that a red test instead of a habit. It asserts one
 * exported constant against every surface that must carry it, and — the part
 * that matters most — it reads the MCP `initialize` response and the CLI's own
 * stdout back off a *spawned process* rather than off the source text. A file
 * that stops containing the words is caught; so is `src/index.ts` quietly
 * dropping the constant while the docs stay correct, which is the failure a
 * grep-based guard cannot see.
 *
 * It sits alongside `tests/distribution-channel-guard.test.ts` (a guard for
 * the surfaces themselves rather than for the words on them) and
 * `tests/registry-meta.test.ts`, which owns the 100-character-capped
 * description this file asserts only the tail of. Nothing here re-authors the
 * canonical description, and nothing here edits a release-please-owned file.
 *
 * Run: node --import tsx --test tests/branding-notice-guard.test.ts
 */
import './helpers/hermetic.js';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  BRANDING_NOTICE,
  NON_AFFILIATION_NOTICE,
  SHORT_NON_AFFILIATION_NOTICE,
  TRADEMARK_NOTICE,
} from '../src/branding.js';
import { renderDoctorProse, type DoctorReport } from '../src/tools/doctortool.js';
// One vocabulary for "how did the child end", borrowed rather than re-invented:
// `classifyChild`/`describeOutcome` are #1335's, and `describeHostPressure` is
// #1366's. A second way to say "killed by SIGKILL" in this repo would be the
// exact drift these helpers exist to stop.
import { classifyChild, describeOutcome, stderrTail, type ChildOutcome, type RawChildResult } from './helpers/subprocess-outcome.js';
import { describeHostPressure } from './helpers/stdio-child.js';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  description: string;
};
const server = JSON.parse(readFileSync(path.join(ROOT, 'server.json'), 'utf8')) as {
  description: string;
};
const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const distribution = readFileSync(path.join(ROOT, 'docs/distribution.md'), 'utf8');
const compliance = readFileSync(path.join(ROOT, 'docs/compliance.md'), 'utf8');

/** The registry's `ServerDetail.description` cap — the reason two forms exist. */
const REGISTRY_DESCRIPTION_MAX = 100;

function readRepoFile(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

function listFilesIn(relativeDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else out.push(rel);
    }
  };
  walk(relativeDir);
  return out.sort();
}

/** Body of a `## <heading>` section, trimmed. */
function section(md: string, heading: string): string {
  const start = md.indexOf(`## ${heading}\n`);
  assert.notEqual(start, -1, `no "## ${heading}" section found`);
  const rest = md.slice(start + `## ${heading}\n`.length);
  const end = rest.indexOf('\n## ');
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

/**
 * Unwrap a hard-wrapped markdown blurb. Without this the check reads zero
 * occurrences of a sentence the file does carry — the failure mode that made
 * the original surface inventory wrong in the first place.
 */
function unwrap(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim().replace(/^>\s?/, ''))
    .filter((line) => line.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** README prose above the first generated block: headings and badges are not the one-liner. */
function readmeOneLiner(): string {
  const generated = readme.indexOf('<!-- BEGIN:generated');
  assert.notEqual(generated, -1, 'README.md must keep its generated block markers');
  for (const line of readme.slice(0, generated).split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('![')) continue;
    if (trimmed.startsWith('[') || trimmed.startsWith('>') || trimmed === '---') continue;
    return trimmed;
  }
  throw new Error('README.md has no prose one-liner above the first generated block');
}

// ---------------------------------------------------------------- subprocesses

let home: string;

before(async () => {
  // An isolated HOME. Nothing here may read or write the real ~/.spotify-mcp.
  home = await mkdtemp(path.join(tmpdir(), 'x705-branding-'));
  await writeFile(
    path.join(home, 'tokens.json'),
    JSON.stringify({ access_token: 'branding-test', refresh_token: 'branding-test', expires_at: Date.now() + 3_600_000 }),
    'utf8',
  );
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    SPOTIFY_CLIENT_ID: 'branding-test',
    SPOTIFY_MCP_TOKEN_FILE: path.join(home, 'tokens.json'),
  };
  return { ...env, ...extra };
}

interface JsonRpc {
  id?: number;
  result?: { instructions?: string; serverInfo?: { name?: string; version?: string } };
  error?: { code: number; message: string };
}

/**
 * `resolve` and `reject` are optional on purpose. They are typed optional so
 * the shape the first draft of this file actually destructured — a promise plus
 * two wrongly-named properties — is expressible as a `Deferred` at all, which
 * is what lets the regression test below pass one in rather than describe it in
 * a comment. `initializeFrom` checks them before it spawns anything.
 */
interface Deferred {
  promise: Promise<string | undefined>;
  resolve?: (value: string | undefined) => void;
  reject?: (reason?: unknown) => void;
}

/**
 * The `initialize` response, read off a real server process.
 *
 * This is the assertion the issue's acceptance criteria ask for, and it is
 * deliberately behavioural. Reading `src/index.ts` for the string would pass
 * if the constant were computed and then never handed to `McpServer` — the
 * exact regression `instructions: SERVER_INSTRUCTIONS` can introduce. Spawning
 * and asking is the only version that cannot be fooled.
 *
 * `entry` is a parameter so the harness's own failure paths are reachable from a
 * test — see the "harness" describe block at the bottom. A harness that cannot
 * be pointed at a broken server is a harness whose error reporting is untested.
 *
 * `makeDeferred` is a second seam onto the same idea: it is how a test reaches
 * the failure below without editing this function.
 */
function initializeFrom(
  entry: string,
  makeDeferred: () => Deferred = () => Promise.withResolvers<string | undefined>(),
): Promise<string | undefined> {
  // Checked before the child exists, and in the caller's own stack (#1366).
  //
  // `Promise.withResolvers` returns `{ promise, resolve, reject }`. The first
  // draft of this file destructured `{ promise, resolveWith, rejectWith }`, so
  // both callbacks were `undefined`, and calling one inside a
  // `child.stdout.on('data')` handler threw where the test's assertion
  // machinery cannot see it. A throw on a stream is not a rejected test: the
  // promise never settled, so the teardown below never ran, the child was
  // never killed, and its ref'd stdio pipes held the runner open. That is the
  // 35-minute hang, and it is the whole reason this guard exists.
  //
  // A `TypeError` thrown here instead lands in the caller, where `assert.rejects`
  // and the runner both see it, and no process was ever spawned to leak.
  const deferred = makeDeferred();
  const { promise } = deferred;
  const settle = deferred.resolve;
  const fail = deferred.reject;
  if (typeof settle !== 'function' || typeof fail !== 'function') {
    throw new TypeError(
      `makeDeferred() returned a deferred with no callbacks (resolve: ${typeof settle}, ` +
        `reject: ${typeof fail}); the harness would throw inside a stream handler and wedge ` +
        `the runner instead of failing this test`,
    );
  }
  const baseEnv = childEnv();
  delete baseEnv.SPOTIFY_SCOPES; // absent, not empty: #617 rejects a set-but-empty value
  const child = spawn(process.execPath, ['--import', 'tsx/esm', entry], {
    cwd: ROOT,
    env: baseEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c: string) => {
    stderr += c;
  });
  child.stdout.on('data', (chunk: string) => {
    // Every exit from this handler goes through `fail`, never through a throw.
    // An exception raised here is an uncaught exception on the stream, not a
    // rejected test: it tears down the process and reports nothing.
    try {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as JsonRpc;
        if (msg.id === 1) {
          if (msg.error) fail(new Error(`initialize failed: ${msg.error.code} ${msg.error.message}`));
          else settle(msg.result?.instructions);
        }
      }
    } catch (err) {
      fail(new Error(`could not parse a frame from the server's stdout: ${(err as Error).message}\nframe: ${JSON.stringify(buffer)}`));
    }
  });
  // A child that dies before answering must reject with the cause, not sit
  // until the watchdog fires (#1366: two stdio harnesses here reported a bare
  // "timeout waiting for initialize" for a child that had already been
  // SIGKILLed under load, discarding the exit code that would have said so).
  // First settle wins, so a healthy response is unaffected.
  child.on('error', (err) => fail(new Error(`could not spawn ${entry}: ${err.message}`)));
  child.on('exit', (code, signal) =>
    fail(new Error(`${entry} exited before answering initialize (code=${code} signal=${signal})\nstderr:\n${stderr}`)),
  );
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'branding-guard', version: '1.0.0' },
      },
    })}\n`,
  );
  // Watchdog only, and last: the server is a separate process whose timers
  // cannot be faked from here, so a real deadline is the only way to fail fast
  // instead of wedging the suite. Every other failure has already settled the
  // promise by the time this can fire.
  //
  // It kills the child itself rather than leaning on the settlement path. If
  // the watchdog's only job were to reject, a harness that could not reject
  // would leave a live child holding the runner open — which is the wedge
  // above, one layer down. Teardown must not depend on a callback working.
  const watchdog = setTimeout(() => {
    teardown();
    fail(new Error(`timeout waiting for initialize\nstderr:\n${stderr}`));
  }, 30_000);
  watchdog.unref();
  // The child is external, so tear it down on both outcomes: end stdin so a
  // healthy server exits on its own, and SIGKILL shortly after so a wedged one
  // cannot hold the runner open. Idempotent, because both this and the watchdog
  // above may call it. The `.catch` is load-bearing — `finally()` returns a
  // *new* promise, and a watchdog rejection with no handler on that derivative
  // is an unhandled rejection that takes the suite down instead of failing one
  // assertion.
  function teardown(): void {
    clearTimeout(watchdog);
    child.stdin.end();
    setTimeout(() => child.kill('SIGKILL'), 1500).unref();
  }
  void promise.finally(teardown).catch(() => {});
  return promise;
}

/** The real server. Thin wrapper so every call site below reads as "the server". */
const initializeInstructions = (): Promise<string | undefined> => initializeFrom('src/index.ts');

const CLI_TIMEOUT_MS = 30_000;
const CLI_ENTRY = path.join(ROOT, 'src', 'index.ts');

/**
 * What a one-shot CLI run produced.
 *
 * `ok: true` means the child **exited** — any code, including a non-zero one,
 * because `doctor` exits 1 whenever any check fails and with the fixture token
 * it always will. Its stdout is the thing under test, and an empty one is a
 * legitimate answer.
 *
 * `ok: false` means the child never reached a verdict at all, and `reason` says
 * which of the three ways that happened. The distinction is the whole point:
 * collapsing `ok: false` into `stdout: ''` reports a box that was starved as a
 * product that dropped a compliance notice.
 */
type CliRun =
  | { readonly ok: true; readonly stdout: string; readonly code: number }
  | { readonly ok: false; readonly reason: string };

/** Test seams. Production callers pass `args` and nothing else. */
interface CliOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** The module to run. The regression test points this at a fixture. */
  readonly entry?: string;
  /** The harness deadline. Shorter in the regression test, which must not wait 30s for a hang. */
  readonly timeoutMs?: number;
}

/** The spawn-failure half of the async error, in `classifyChild`'s vocabulary. */
function spawnFailure(err: { readonly code?: number | string | null; readonly killed?: boolean }): RawChildResult['error'] {
  // Checked before `signal` for the reason #1335 documents: a timed-out child
  // carries BOTH a signal (this harness's own `killSignal`) and a deadline, and
  // `classifyChild` reads `error` first, so the deadline has to be spelled here
  // or it is lost and the watchdog is filed as an unexplained kill.
  if (err.killed === true) return { code: 'ETIMEDOUT' };
  // Async `execFile` reports a fork/exec failure as a *string* `code`
  // (`'ENOENT'`), where the sync APIs nest it under `error`. Measured, not
  // assumed — the table in `classifyCliChild` above is reproduced against real
  // children by the `#1378` describe block at the foot of this file.
  if (typeof err.code === 'string') return { code: err.code };
  return undefined;
}

/**
 * Re-spell an async `execFile` failure in the vocabulary `classifyChild` reads.
 *
 * The sync and async APIs do not report the same three events the same way, and
 * the differences are precisely the ones that decide the diagnosis:
 *
 * | child outcome         | async `execFile` error                              | `classifyChild` reads   |
 * |-----------------------|------------------------------------------------------|-------------------------|
 * | ran, exited N         | `code: N`, `signal: null`                            | `status: N`             |
 * | killed by a signal    | `code: null`, `signal: 'SIGKILL'`, `killed: false`   | `signal`                |
 * | killed by the deadline| `code: null`, `signal: <killSignal>`, `killed: true` | `error.code: 'ETIMEDOUT'` |
 * | never started         | `code: 'ENOENT'`, `signal: undefined`                | `error.code: 'ENOENT'`  |
 *
 * The timeout row cannot be passed through. Async `execFile` attaches **no**
 * `error` property at all on any of these paths, so a raw hand-off files the
 * 30 s watchdog as `killed by SIGKILL` — the same conflation #1335 fixed for
 * the sync APIs, re-entering through the async door, and a reader sent to look
 * for an OOM kill that their own deadline caused.
 */
function classifyCliChild(err: unknown): { readonly raw: RawChildResult; readonly outcome: ChildOutcome } {
  const e = err as {
    readonly code?: number | string | null;
    readonly signal?: NodeJS.Signals | null;
    readonly killed?: boolean;
    readonly stdout?: string;
    readonly stderr?: string;
  };
  const raw: RawChildResult = {
    error: spawnFailure(e),
    signal: e.signal ?? null,
    status: typeof e.code === 'number' ? e.code : null,
    stdout: e.stdout,
    stderr: e.stderr,
  };
  return { raw, outcome: classifyChild(raw) };
}

/**
 * What kind of death this was, stated so it cannot be read as a defect in the
 * product. Split from the facts above so a message carrying both says each once.
 */
function explainCliFailure(outcome: ChildOutcome, timeoutMs: number): string {
  if (outcome.kind === 'signalled') {
    return 'A signal kill is a resource/process failure, NOT a compliance failure. Nothing the CLI could have\n'
      + 'printed was lost in the product — a signal takes the process with it before it reaches the banner —\n'
      + 'so the notice assertion that would have run here never got output to judge. Check the host pressure\n'
      + 'line before concluding the notice is missing from the product.';
  }
  if (outcome.kind === 'not-started' && outcome.reason === 'ETIMEDOUT') {
    return `The child ran for the full ${timeoutMs}ms deadline and was ended by this harness's own killSignal.\n`
      + 'That is a hang, not an unexplained kill, and it is a different thing to go looking for: check whether\n'
      + 'the child is still booting at this load before reading anything into the notice.';
  }
  return `The child never started (${outcome.reason}), so no line of the code under test ever ran. This is a\n`
    + 'harness/environment failure, not a statement about the notice.';
}

/** The self-describing report for a CLI child that never reached an exit code. */
function describeCliFailure(
  label: string,
  command: readonly string[],
  raw: RawChildResult,
  outcome: ChildOutcome,
  timeoutMs: number,
): string {
  return [
    `${label}: the CLI child ${describeOutcome(outcome)} `
      + `(code=${raw.status ?? 'null'} signal=${raw.signal ?? 'null'}), so it produced no output to check.`,
    explainCliFailure(outcome, timeoutMs),
    `command: ${command.join(' ')}`,
    `host pressure: ${describeHostPressure()}`,
    `child stderr:\n${stderrTail(raw.stderr ?? '')}`,
  ].join('\n');
}

/**
 * Run a one-shot CLI subcommand and report **how it ended**, not just what it printed.
 *
 * A non-zero exit is a verdict and is returned as one: `doctor` exits 1 whenever
 * any check fails, and with the fixture token it always will. The notice is
 * printed on the banner *before* the report is collected, so the partial output
 * of a child that ran and failed is genuinely the thing under test.
 *
 * What is **not** returned is the reason the previous version of this function
 * claimed. It said a killed child "returns its stdout instead of an empty
 * string", and that was false as a rule — it held only for a child that had
 * already reached the banner. A child killed earlier, during module load under
 * load, has an `err.stdout` of `''` exactly as a child that printed nothing has,
 * and `e.stdout ?? ''` handed both to the notice assertion as the same empty
 * string. The result was a red that read as *the product dropped its
 * non-affiliation notice* when the truth was *the box was too busy to run the
 * child*, and a green that could not distinguish them either.
 *
 * So the three outcomes are kept apart: exited (any code) carries stdout;
 * signalled and never-started do not, and say which they were.
 */
async function cli(args: string[], options: CliOptions = {}): Promise<CliRun> {
  const entry = options.entry ?? CLI_ENTRY;
  const timeoutMs = options.timeoutMs ?? CLI_TIMEOUT_MS;
  const argv = ['--import', 'tsx/esm', entry, ...args];
  const label = `spotify-mcp ${args.length > 0 ? args.join(' ') : '--help'}`;
  try {
    const { stdout } = await run(process.execPath, argv, {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      env: childEnv(options.env),
    });
    return { ok: true, stdout, code: 0 };
  } catch (err) {
    const { raw, outcome } = classifyCliChild(err);
    // A child that ran and exited is a verdict, crash or not: `doctor` exits 1
    // on every failing check, and that is the case the notice assertions exist
    // to cover.
    if (outcome.kind === 'exited') {
      return { ok: true, stdout: outcome.stdout, code: outcome.code };
    }
    return { ok: false, reason: describeCliFailure(label, [process.execPath, ...argv], raw, outcome, timeoutMs) };
  }
}

/**
 * The stdout of a run that reached a verdict, failing with the child's own cause
 * if it did not.
 *
 * This is the call site every notice assertion goes through, so the failure it
 * raises is what a reader sees instead of `expected <notice>, got ''`.
 */
function cliStdout(result: CliRun): string {
  if (!result.ok) assert.fail(result.reason);
  return result.stdout;
}

// ------------------------------------------------------------------ the guard

describe('non-affiliation notice: the runtime surfaces (#705)', () => {
  it('a host-only agent receives the notice in its initialize instructions', async () => {
    const instructions = await initializeInstructions();
    assert.equal(
      instructions,
      BRANDING_NOTICE,
      'the initialize response must carry the exported BRANDING_NOTICE verbatim. This is the ' +
        'only surface a host-only agent sees — no README, no npm page, no repository — and a ' +
        'notice that exists only in documents does not reach one. Pass it as ' +
        '{ instructions } to the McpServer constructor (src/index.ts); a string computed but ' +
        'not handed over fails here and nowhere else.',
    );
  });

  it("spotify_doctor's rendered prose opens with the notice", () => {
    const report: DoctorReport = {
      ok: true,
      rows: [{ id: 'token', status: 'pass', summary: 'token present' }],
      surface: {} as DoctorReport['surface'],
    };
    const prose = renderDoctorProse(report, true);
    const lines = prose.split('\n');
    assert.equal(lines[0], 'Spotify doctor — 1 check(s), no failures', 'precondition: the summary line leads');
    assert.equal(
      lines[1],
      BRANDING_NOTICE,
      "spotify_doctor's prose header must be the exported BRANDING_NOTICE. This is the " +
        'agent-facing identity line and the text users paste into issue reports; both the tool ' +
        'and the CLI subcommand render through this function, so neither can drift from it.',
    );
  });

  it('the CLI doctor banner carries the notice, above the Configuration block', async () => {
    const stdout = cliStdout(await cli(['doctor']));
    // Position, not `includes`. The rendered report *also* carries the notice
    // (see the prose test above), so a bare substring check is satisfied by the
    // report and passes with the banner line deleted — an assertion that
    // cannot fail. The banner is its own claim: it is what a reader sees
    // before scrolling to any row, so it is asserted as its own line.
    const lines = stdout.split('\n');
    assert.match(
      lines[0] ?? '',
      /^spotify-mcp \d+\.\d+\.\d+/,
      `precondition: the doctor opens with the version banner; got ${JSON.stringify(lines[0])}`,
    );
    assert.equal(
      lines[1],
      NON_AFFILIATION_NOTICE,
      '`spotify-mcp doctor` must print the non-affiliation notice on the banner, directly under ' +
        'the version line. That output is what a user pastes into a bug thread, and the banner is ' +
        'what is read while deciding whether this is an official Spotify integration. Print it from ' +
        'the exported constant (src/index.ts), not as a hand-typed sentence.',
    );
  });

  it('the --help banner carries the notice, directly under the title line', async () => {
    const stdout = cliStdout(await cli(['--help']));
    const lines = stdout.split('\n');
    assert.equal(
      lines[0],
      'spotify-mcp — MCP server for the Spotify Web API',
      'precondition: help opens with the title line',
    );
    assert.equal(
      lines[1],
      BRANDING_NOTICE,
      '`spotify-mcp --help` must carry the full branding notice as its second line. The help text ' +
        'is the first thing a prospective installer reads, and the name it opens with is the one ' +
        'Policy Sec. VI.2 objects to.',
    );
  });

  it('the notice is not a hand-typed second copy anywhere in src/', () => {
    const offenders = listFilesIn('src').filter((file) => {
      if (file === 'src/branding.ts') return false;
      return readRepoFile(file).includes('Not affiliated with');
    });
    assert.deepEqual(
      offenders,
      [],
      `the notice wording belongs to src/branding.ts alone. These files author their own copy: ` +
        `${offenders.join(', ')}. A per-surface paraphrase is exactly the drift the single ` +
        `constant exists to prevent, and no grep for the exact string would catch it.`,
    );
  });
});

describe('non-affiliation notice: the metadata surfaces (#705)', () => {
  /**
   * The short form, on every surface whose value IS the description. The
   * sentence itself is owned by `CANONICAL_DESCRIPTION` in
   * `tests/registry-meta.test.ts`; this asserts only that what actually ships
   * ends in this guard's copy of the tail, which is what ties the two
   * constants to each other without duplicating either.
   */
  const shortSurfaces = (): Array<[string, string]> => [
    ['package.json description', pkg.description],
    ['server.json description', server.description],
    ['README.md one-liner', readmeOneLiner()],
    ['docs/distribution.md short blurb', unwrap(section(distribution, 'Short blurb (directories)'))],
  ];

  it('the short form is the tail of every capped description, and fits the cap', () => {
    const bad = shortSurfaces()
      .filter(([, value]) => !value.endsWith(SHORT_NON_AFFILIATION_NOTICE))
      .map(([name, value]) => `${name}=${JSON.stringify(value)}`);
    assert.deepEqual(
      bad,
      [],
      `these surfaces do not end with the non-affiliation notice (${SHORT_NON_AFFILIATION_NOTICE}): ` +
        `${bad.join(' | ')}. A user who installs from npm or the MCP Registry reads only this text.`,
    );
    for (const [name, value] of shortSurfaces()) {
      assert.ok(
        value.length <= REGISTRY_DESCRIPTION_MAX,
        `${name} is ${value.length} chars; the MCP Registry caps description at ${REGISTRY_DESCRIPTION_MAX}. ` +
          'Appending the notice must not push a mirror over the cap — shorten the capability claim instead.',
      );
    }
  });

  it('the long blurb leads with the notice rather than burying it', () => {
    // A prefix, not a suffix: the long description continues into a capability
    // tour, so "ends with" is the wrong predicate for it. `includes` is what
    // keeps the guarantee honest — the notice must be *inside* the blurb, and
    // the blurb is what a directory card is pasted from.
    const long = unwrap(section(distribution, 'Long description (Glama / PulseMCP style)'));
    assert.ok(
      long.startsWith('Spotify Web API MCP:') && long.includes(SHORT_NON_AFFILIATION_NOTICE),
      `docs/distribution.md long description must lead with the capability claim and carry ` +
        `${SHORT_NON_AFFILIATION_NOTICE} inside it; it currently reads: ${long.slice(0, 160)}…`,
    );
  });

  it('the README pairs the notice with the Developer Terms link', () => {
    assert.ok(
      readme.includes(SHORT_NON_AFFILIATION_NOTICE) && readme.includes('developer.spotify.com/terms'),
      'README.md must carry the non-affiliation notice alongside the Spotify Developer Terms link',
    );
  });

  it('the two notice forms are one disclosure, not two competing claims', () => {
    // The cap is the only reason the short form exists; the long form must
    // therefore be a superset in meaning. A long form that dropped "unofficial"
    // or narrowed "not affiliated" to something else would be a weaker claim
    // on exactly the surfaces a first-time reader sees.
    assert.ok(
      NON_AFFILIATION_NOTICE.startsWith('Independent, unofficial project.'),
      'the long form must open by denying official status — that is the impression Policy Sec. VI.2 ' +
        'is about, and the first-glance answer to it.',
    );
    for (const clause of ['not affiliated', 'endorsed by', 'sponsored by']) {
      assert.ok(
        NON_AFFILIATION_NOTICE.toLowerCase().includes(clause),
        `the long form must deny ${clause}: Terms Sec. IX.7 forbids suggesting endorsement, which is a ` +
          'claim about how the product reads rather than about who runs it',
      );
    }
    assert.equal(
      BRANDING_NOTICE,
      `${NON_AFFILIATION_NOTICE} ${TRADEMARK_NOTICE}`,
      'BRANDING_NOTICE must be the two sentences joined — surfaces with room carry the trademark ' +
        'sentence too, and it is composed here rather than re-typed at each call site',
    );
    assert.ok(
      SHORT_NON_AFFILIATION_NOTICE.length < NON_AFFILIATION_NOTICE.length,
      `the short form (${SHORT_NON_AFFILIATION_NOTICE}) must be the shortened one; if it is not, the ` +
        'two forms have been swapped and the cap argument no longer holds',
    );
  });
});

describe('the recorded name decision (#705)', () => {
  const naming = (): string => section(compliance, 'Naming decision (2026-09-18)');
  const noticeDoc = (): string => section(compliance, 'The non-affiliation notice');

  it('states the date, both options, the choice and the accepted risk', () => {
    const doc = naming();
    for (const required of [
      '2026-09-18',
      'should not begin with',
      'Sec. VI.2',
      'Option A',
      'Option B',
    ]) {
      assert.ok(
        doc.includes(required),
        `docs/compliance.md "Naming decision (2026-09-18)" must record ${JSON.stringify(required)}. ` +
          'A decision log that omits the rejected option, or the date, is a rationale without a ' +
          'decision, and the next maintainer cannot tell which parts are load-bearing.',
      );
    }
    assert.match(
      doc,
      /Decision: Option B/i,
      'the page must say which option was taken, not merely describe both',
    );
  });

  it('records the re-check trigger', () => {
    const doc = naming();
    assert.match(
      doc,
      /Re-check trigger/i,
      'docs/compliance.md must carry the re-check trigger: the decision is only valid while the ' +
        'conditions that justified it hold, and a reader needs to know what invalidates it',
    );
    assert.match(
      doc,
      /directory|marketplace|listing/i,
      'the trigger must name a distribution channel — that is the concrete event that reopens the question',
    );
  });

  it('is linked from the distribution checklist, where a channel is actually added', () => {
    const checklist = section(distribution, 'Claim checklist');
    assert.match(
      checklist,
      /name re-check/i,
      'docs/distribution.md § Claim checklist must carry the name re-check. Recording the trigger ' +
        'only in docs/compliance.md puts it one hop from the person about to submit a listing.',
    );
    assert.ok(
      checklist.includes('compliance.md'),
      'the checklist item must link to docs/compliance.md, which holds the decision itself',
    );
  });

  it('documents the notice wording, both forms, and the surfaces that must carry them', () => {
    const doc = noticeDoc();
    for (const required of ['src/branding.ts', SHORT_NON_AFFILIATION_NOTICE, 'initialize', '100']) {
      assert.ok(
        doc.includes(required),
        `docs/compliance.md "The non-affiliation notice" must record ${JSON.stringify(required)} — ` +
          'the single source, the capped form, the host-only surface, or the cap that forces two forms',
      );
    }
  });

  it('names the surfaces deliberately excluded, so an absence is not read as an oversight', () => {
    const doc = noticeDoc();
    for (const excluded of ['SECURITY.md', 'CODE_OF_CONDUCT.md', '--version']) {
      assert.ok(
        doc.includes(excluded),
        `docs/compliance.md must name ${excluded} among the surfaces that deliberately do not carry ` +
          'the notice, with the reason. An unlisted absence is indistinguishable from a gap, and the ' +
          'next maintainer either re-litigates it or silently adds the notice to --version and breaks ' +
          'the scripts that parse it.',
      );
    }
  });
});

/**
 * The harness, tested (#1366).
 *
 * The file above is only trustworthy if `initializeFrom` fails the way a test
 * should fail. It did not, once: the callbacks destructured out of
 * `Promise.withResolvers` were `undefined`, calling one inside the stdout
 * handler threw, and an exception on a stream is not routed to the assertion
 * machinery. The promise then never settled, so the teardown chained to
 * `finally` never ran, the child was never killed, and its ref'd stdio pipes
 * held the runner open — the runner died reporting nothing and the run leaked
 * for 35 minutes.
 *
 * The four properties below are the ones that cost that, and all four are
 * checkable. The first is the headline: the historical broken shape is handed
 * to the harness, so the regression is driven rather than described.
 *
 * What is deliberately *not* asserted here: that `Promise.withResolvers`
 * returns `{ promise, resolve, reject }`. That is a property of the Node
 * runtime, and a test of it would pass no matter what this harness did — the
 * definition of a test that cannot fail.
 */
describe('the stdio harness fails with a cause (#1366)', () => {
  it('refuses to run on a deferred with no callbacks, instead of throwing inside a stream handler', async () => {
    // The regression, driven rather than described. This is the exact shape the
    // first draft destructured: the promise under its real name, the two
    // callbacks under names `Promise.withResolvers` does not have. `never` is
    // the promise such a harness would be left holding — unsettled, because
    // nothing can settle it.
    const never = new Promise<string | undefined>(() => {});
    const started = process.hrtime.bigint();
    await assert.rejects(
      async () =>
        initializeFrom('src/index.ts', () => ({
          promise: never,
          resolveWith: () => {},
          rejectWith: () => {},
        })),
      (err: Error) => {
        assert.ok(
          err instanceof TypeError,
          `a deferred with no callbacks must fail as a TypeError, got: ${err.constructor.name}: ${err.message}`,
        );
        assert.match(
          err.message,
          /resolve: undefined, reject: undefined/,
          `the failure must name what was missing, got: ${err.message}`,
        );
        return true;
      },
    );
    // Promptly, and with nothing left running. The guard is a synchronous
    // check made before the spawn, so this is microseconds and no child ever
    // existed; anything near the watchdog's 30 s means the throw moved back
    // inside a handler, which is the bug this test exists to keep out.
    const elapsedMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
    assert.ok(
      elapsedMs < 5_000,
      `the check must run before the spawn, took ${elapsedMs}ms — the callbacks are still being called from a handler`,
    );
  });

  it('rejects with the exit code when the server dies before answering', async () => {
    // A module that does not exist: node starts, fails to resolve it, and
    // exits non-zero without writing a frame. That is the same shape as a
    // child SIGKILLed under load, which is the case #1366 is about.
    await assert.rejects(
      () => initializeFrom('src/no-such-entry-point.ts'),
      (err: Error) => {
        assert.match(
          err.message,
          /exited before answering initialize \(code=\d+/,
          `a dead child must be reported with its exit code, got: ${err.message}`,
        );
        assert.doesNotMatch(
          err.message,
          /timeout waiting for initialize/,
          'the watchdog fired instead of the exit handler — the harness is still discarding the cause',
        );
        return true;
      },
    );
  });

  it('rejects within the watchdog, not after it', async () => {
    // The point of the exit handler is that a dead child fails in the child's
    // lifetime. If this ever takes 30 s the assertion above is passing for the
    // wrong reason, so the deadline is asserted rather than left to the runner.
    const started = process.hrtime.bigint();
    await assert.rejects(() => initializeFrom('src/no-such-entry-point.ts'));
    const elapsedMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
    assert.ok(
      elapsedMs < 20_000,
      `a dead child must reject promptly, took ${elapsedMs}ms — that is the watchdog, not the exit handler`,
    );
  });

  it('the real server still answers through the same path', async () => {
    // The control. Without it the two tests above would also pass against a
    // harness that rejects unconditionally and instantly, which is the shape a
    // "fix" written as `fail()` in the spawn would take.
    const instructions = await initializeFrom('src/index.ts');
    assert.equal(instructions, BRANDING_NOTICE, 'precondition: the real server still answers initialize');
  });
});

/**
 * The CLI harness, tested (#1378).
 *
 * ## The defect
 *
 * `cli()` caught every failure of the child and returned `e.stdout ?? ''`. Its
 * own doc comment claimed this was deliberate and correct:
 *
 * > …which is why a killed child returns its stdout instead of an empty string.
 *
 * That claim is not true as a rule, and the file's headline subject makes the
 * gap expensive rather than cosmetic. `cli()` feeds the **non-affiliation
 * notice** assertions. `''` from a SIGKILLed child therefore reached
 *
 * ```ts
 * assert.equal(lines[1], NON_AFFILIATION_NOTICE, '`spotify-mcp doctor` must print …')
 * ```
 *
 * as `expected 'Independent, unofficial project. …', got ''` — a red that says
 * *the product dropped its compliance notice* when the truth is *the box was too
 * busy to finish starting the child*. The `doctor` and `--help` cases are
 * precisely the ones that go red on a loaded machine, which is the only machine
 * a reader is on when they see it.
 *
 * It is also a check whose green is uninformative: a fix that simply asserted
 * "notice present or not" without separating the causes would pass on a kill and
 * on a real omission alike.
 *
 * ## The correction to the issue's own diagnosis, measured
 *
 * #1378 attributes the empty result to `killSignal: 'SIGKILL'` leaving
 * `err.stdout` **`undefined`**. That is not what Node does. Measured against
 * Node 24.21.0 on this box, the async `execFile` error object always *has* a
 * `stdout` property, and it holds whatever the child managed to flush:
 *
 * | child outcome          | `err.stdout` | `err.code` | `err.signal` | `err.killed` |
 * |------------------------|--------------|------------|--------------|--------------|
 * | ran, exited 1, printed | `'HELLO\n'`  | `1`        | `null`       | `false`      |
 * | killed by SIGKILL, printed | `'HELLO\n'` | `null` | `'SIGKILL'`  | `false`      |
 * | killed by SIGKILL, silent   | `''`     | `null`     | `'SIGKILL'`  | `false`      |
 * | killed by the deadline     | `'HELLO\n'` | `null`    | `'SIGKILL'`  | `true`       |
 * | never started (ENOENT)     | `''`        | `'ENOENT'` | `undefined`  | —            |
 *
 * So the comment was right for a child that had already reached the banner and
 * wrong for one killed during module load — which is the one that happens under
 * load. The empty string is reachable either way; that is the defect, and it
 * survives the correction to the mechanism. AGENTS.md §6: a correctly named
 * payload field can still lie about its value. `stdout` was named for the
 * banner and was reporting "nothing arrived, for reasons this discards".
 *
 * The measured table also shows the timeout and the signal are the *same three
 * fields* — `code: null`, `signal: 'SIGKILL'` — separated only by `killed`.
 * Handing a raw async error to `classifyChild` would therefore file this
 * harness's own 30 s deadline as `killed by SIGKILL` and send the next reader
 * hunting an OOM killer they caused themselves.
 *
 * ## What is pinned
 *
 * The three outcomes stay distinguishable **at the point of judgement**, each
 * naming itself, and each driven by a real child process rather than a
 * hand-built object — the shapes asserted are the shapes Node produces, which is
 * the whole lesson of the table above.
 */
describe('the CLI harness tells a killed child from a silent one (#1378)', () => {
  /**
   * Real children, one per outcome. `killed` is the OOM killer's exact shape:
   * a process that dies by signal having printed nothing.
   */
  const FIXTURES: Readonly<Record<string, string>> = {
    killed: 'process.kill(process.pid, "SIGKILL");\n',
    wedged: 'setInterval(() => {}, 1000);\n',
    exits1: 'process.exit(1);\n',
    exits0: 'process.exit(0);\n',
  };

  let fixtures: string;
  before(async () => {
    fixtures = await mkdtemp(path.join(tmpdir(), 'x1378-cli-'));
    await Promise.all(
      Object.entries(FIXTURES).map(([name, body]) =>
        writeFile(path.join(fixtures, `${name}.mjs`), body, 'utf8'),
      ),
    );
  });
  after(async () => {
    await rm(fixtures, { recursive: true, force: true });
  });

  const fixture = (name: string): string => path.join(fixtures, `${name}.mjs`);

  /** The reason from a run that did not reach a verdict, or a hard failure if it did. */
  function reasonOf(result: CliRun): string {
    if (result.ok) {
      assert.fail(
        `expected the child not to have exited, but it exited ${result.code} `
          + `with stdout ${JSON.stringify(result.stdout)}`,
      );
    }
    return result.reason;
  }

  it('reports a SIGKILLed child as killed, and never as a child that printed nothing', async () => {
    // The regression, driven rather than described. A real child killed by a
    // real signal, the shape a loaded box produces and the shape the old
    // `e.stdout ?? ''` returned as `''`.
    const result = await cli([], { entry: fixture('killed') });

    const reason = reasonOf(result);

    // Named in #1335's vocabulary, so a grep finds one convention repo-wide.
    assert.match(reason, /killed by SIGKILL/, 'the cause must be the signal, by name');
    // A signalled child has no exit code; saying so keeps the OOM kill from
    // being filed under "exited with no status".
    assert.match(reason, /code=null/, 'a signalled child has no exit code and the report must say so');
    assert.match(reason, /signal=SIGKILL/);
    // The line that answers the reader's only question: box or code?
    assert.match(reason, /host pressure:/, 'the report must carry the host pressure reading');
    // And it must not read as the compliance regression it is not.
    assert.match(reason, /NOT a compliance failure/, 'a signal kill must not be reported as a missing notice');

    // The caller side, which is what the notice assertions actually go through.
    assert.throws(
      () => cliStdout(result),
      /killed by SIGKILL/,
      'a notice assertion must fail with the cause, not with an empty expected value',
    );
  });

  it('tells the harness deadline apart from an unexplained signal', async () => {
    // A hang and an OOM kill are the same three fields on the wire
    // (`code: null`, `signal: 'SIGKILL'`) and different diagnoses: one points at
    // this file's `CLI_TIMEOUT_MS`, the other at the machine. Filing the
    // deadline as a kill sends the reader after a process failure they caused.
    const result = await cli([], { entry: fixture('wedged'), timeoutMs: 1_000 });

    const reason = reasonOf(result);

    assert.match(reason, /ETIMEDOUT/, 'the deadline must be named as one');
    assert.match(reason, /1000ms deadline/, 'the report must say the child ran the full deadline, not that it vanished');
    assert.doesNotMatch(
      reason,
      /killed by SIGKILL/,
      'the harness\'s own deadline must not be reported as an unexplained signal kill',
    );
    // It is a hang, so the "not a product failure" wording is different: a
    // child that ran for 30s may genuinely be stuck, and saying so is the point.
    assert.doesNotMatch(reason, /NOT a compliance failure/, 'a hang is a different diagnosis from a signal kill');
  });

  it('still returns the empty output of a child that ran and exited non-zero', async () => {
    // The anti-overcorrection, and the case that matters most, because it is the
    // real one: `doctor` exits 1 whenever any check fails. A fix that failed
    // every non-exit-zero run would break the notice guard outright, and a fix
    // that failed every *empty* one would pass the kill case above while
    // breaking a child that legitimately printed nothing.
    const result = await cli([], { entry: fixture('exits1') });

    assert.equal(result.ok, true, 'a non-zero exit is a verdict, not a crash');
    if (result.ok) {
      assert.equal(result.code, 1, 'the exit code must survive rather than be flattened');
      assert.equal(cliStdout(result), '', 'empty output from a child that ran is a legitimate answer');
    }
  });

  it('still returns the empty output of a child that exited cleanly', async () => {
    // The other direction through the same code, and the one that would catch a
    // `cli()` that failed whenever the notice was *absent* rather than whenever
    // the child was gone.
    const result = await cli([], { entry: fixture('exits0') });

    assert.equal(result.ok, true, 'a clean exit is the normal path');
    assert.equal(cliStdout(result), '', 'a silent clean exit must not be reported as a harness failure');
  });
});
