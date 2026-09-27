import './helpers/hermetic.js';

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';

import { armFileDeadline } from './helpers/file-deadline.js';

import { collectMissing, formatFailure, guardChild } from '../scripts/lib/preflight.mjs';
import { ERROR_TEXT_CAP, MCP_PROTOCOL_VERSION, RPC_TIMEOUT_MS, looksGated } from '../scripts/lib/mcp-client.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPTS = join(ROOT, 'scripts');
const LIB = join(SCRIPTS, 'lib');
const REAL_DIST = join(ROOT, 'dist');

/** Every `.mjs` under `scripts/`, recursively. */
function scriptFiles(dir = SCRIPTS): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...scriptFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.mjs')) out.push(full);
  }
  return out.sort();
}

/** The three harnesses #644 moved onto the shared client. */
const HARNESSES = ['live-gauntlet.mjs', 'live-e2e.mjs', 'tool-gate-check.mjs'] as const;

// Everything this file creates lives under the OS temp root. Never a
// checked-in file: node:test runs sibling `describe` blocks concurrently, and a
// test that proves a gate fires by editing the real `scripts/` tree would race
// whichever sibling is asserting that the real tree is clean.
const scratchDirs: string[] = [];
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

armFileDeadline({
  label: 'lib-mcp-client.test.ts',
  // Generous: this file runs three sandboxed harness processes (which each
  // preflight and exit before spawning) plus a handful of gate invocations.
  budgetMs: 2 * 60_000,
  children: () => [],
});

// ---------------------------------------------------------------------------
// Half 1 — the preconditions, driven against fixture trees
// ---------------------------------------------------------------------------

/**
 * A tree that satisfies every precondition, so each test below can break
 * exactly one and see the gate name it.
 *
 * The token lives at a path of its own via `SPOTIFY_MCP_TOKEN_FILE` rather than
 * inside the fake home, and the build is the real one — so nothing here can
 * reach the developer's `~/.spotify-mcp` even if a fixture is wrong.
 */
function satisfiedFixture(label: string): {
  root: string;
  env: NodeJS.ProcessEnv;
  home: string;
  token: string;
} {
  const root = scratch(`preflight-${label}-`);
  const home = scratch(`preflight-home-${label}-`);
  const token = join(root, 'token.json');
  writeFileSync(join(root, '.env'), '', 'utf8');
  writeFileSync(token, JSON.stringify({ access_token: 'stub' }), 'utf8');
  return {
    root,
    home,
    token,
    env: {
      HOME: home,
      USERPROFILE: home,
      SPOTIFY_CLIENT_ID: '',
      SPOTIFY_MCP_TOKEN_FILE: token,
      SPOTIFY_MCP_DIST_ROOT: REAL_DIST,
    },
  };
}

describe('#644 a live harness names what is missing instead of timing out', () => {
  it('reports nothing when every precondition holds', async () => {
    const f = satisfiedFixture('ok');
    assert.deepEqual(await collectMissing({ root: f.root, env: f.env }), []);
  });

  it('names the build when dist/ is not there', async () => {
    const f = satisfiedFixture('nobuild');
    f.env.SPOTIFY_MCP_DIST_ROOT = scratch('preflight-empty-dist-');
    const missing = await collectMissing({ root: f.root, env: f.env });
    assert.deepEqual(
      missing.map((m) => m.id),
      ['build'],
      'a missing build must be reported as exactly that, not as a missing token too',
    );
    assert.match(missing[0]!.fix, /npm run build/);
  });

  it('names the token when the developer has not run npm run auth', async () => {
    const f = satisfiedFixture('notoken');
    delete (f.env as Record<string, string | undefined>).SPOTIFY_MCP_TOKEN_FILE;
    f.env.SPOTIFY_MCP_TOKEN_FILE = join(f.root, 'absent.json');
    const missing = await collectMissing({ root: f.root, env: f.env });
    assert.deepEqual(
      missing.map((m) => m.id),
      ['credentials'],
    );
    assert.match(missing[0]!.fix, /npm run auth/);
    // The path is named, so the reader does not have to guess which store.
    assert.match(missing[0]!.problem, /absent\.json/);
  });

  it('names the client id when neither .env nor the environment has one', async () => {
    const f = satisfiedFixture('noclientid');
    rmSync(join(f.root, '.env'));
    f.env.SPOTIFY_CLIENT_ID = '';
    const missing = await collectMissing({ root: f.root, env: f.env });
    assert.deepEqual(
      missing.map((m) => m.id),
      ['client-id'],
    );
    assert.match(missing[0]!.problem, /missing \.env \(copy \.env\.example\)/);
  });

  it('accepts a client id from the environment when there is no .env', async () => {
    // The maintainer who exports SPOTIFY_CLIENT_ID has a working setup today.
    // The unconditional `--env-file=.env` this replaced broke them, so the
    // fixture is the regression, not the requirement.
    const f = satisfiedFixture('envclientid');
    rmSync(join(f.root, '.env'));
    f.env.SPOTIFY_CLIENT_ID = 'from-the-shell';
    assert.deepEqual(await collectMissing({ root: f.root, env: f.env }), []);
  });

  it('lists every missing precondition at once, in fix order', async () => {
    // The clean-clone case from the issue: nothing built, no token, no .env.
    // One run should be able to name all three.
    const f = satisfiedFixture('cleanclone');
    rmSync(join(f.root, '.env'));
    f.env.SPOTIFY_CLIENT_ID = '';
    f.env.SPOTIFY_MCP_DIST_ROOT = scratch('preflight-empty-dist-');
    const missing = await collectMissing({ root: f.root, env: f.env });
    assert.deepEqual(
      missing.map((m) => m.id),
      ['build', 'client-id'],
    );
    const text = formatFailure('live-e2e', missing);
    assert.match(text, /npm run build/);
    assert.match(text, /missing \.env \(copy \.env\.example\)/);
  });

  it('a passing run prints no precondition message', async () => {
    // The control. Without it, "the message mentions npm run build" would be
    // satisfied by a gate that always says everything.
    const f = satisfiedFixture('control');
    const missing = await collectMissing({ root: f.root, env: f.env });
    assert.equal(formatFailure('live-e2e', missing), '');
  });
});

// ---------------------------------------------------------------------------
// Half 2 — the same precondition, through a real harness process
// ---------------------------------------------------------------------------

/**
 * A sandbox holding a copy of a harness beside the lib it imports, on a tree
 * that has NO build, NO token and NO `.env` — a clean clone, in miniature.
 */
function cleanCloneSandbox(script: string) {
  const dir = scratch('preflight-run-');
  const home = scratch('preflight-run-home-');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  copyFileSync(join(SCRIPTS, script), join(dir, 'scripts', script));
  copyFileSync(join(SCRIPTS, 'hermetic-home.mjs'), join(dir, 'scripts', 'hermetic-home.mjs'));
  copyFileSync(join(SCRIPTS, 'live-gauntlet-core.mjs'), join(dir, 'scripts', 'live-gauntlet-core.mjs'));
  for (const lib of readdirSync(LIB)) {
    if (lib.endsWith('.mjs')) copyFileSync(join(LIB, lib), join(dir, 'scripts', 'lib', lib));
  }
  return {
    dir,
    run(): { status: number; output: string } {
      const res = spawnSync(process.execPath, [`scripts/${script}`], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          USERPROFILE: home,
          // An empty string is how this file says "not set": `!env.X` is the
          // test, and an inherited SPOTIFY_CLIENT_ID from the developer's shell
          // would make the fixture describe a machine that is already set up.
          SPOTIFY_CLIENT_ID: '',
          SPOTIFY_MCP_DIST_ROOT: join(dir, 'no-such-dist'),
          NODE_V8_COVERAGE: '',
        },
      });
      if (res.error) throw res.error;
      return { status: res.status ?? -1, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
    },
  };
}

describe('#644 the preflight is what a broken run actually prints', () => {
  for (const script of HARNESSES) {
    it(`${script} exits 1 with a fix, not with \`timeout: initialize\``, () => {
      const { run } = cleanCloneSandbox(script);
      const { status, output } = run();

      assert.equal(status, 1, `expected a clean-clone run to refuse; got exit ${status} with:\n${output}`);
      assert.match(output, /npm run build/);
      assert.match(output, /missing \.env \(copy \.env\.example\)/);
      // The regression this whole change exists for. Before #644 the same
      // command printed `.env: not found` from node and then, after a full
      // timeout, `Error: timeout: initialize` — a message naming no file and
      // no action. If this string reappears the preflight did not run first.
      assert.ok(
        !output.includes('timeout: initialize'),
        `the run still reported a bare timeout instead of a precondition:\n${output}`,
      );
      // And it must not have started a server: the whole point is that
      // nothing was spawned.
      assert.ok(
        !output.includes('hermetic-home:'),
        `the harness spawned a server despite unmet preconditions:\n${output}`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Half 3 — one protocol version, one timeout, one classifier
// ---------------------------------------------------------------------------

describe('#644 the three harnesses share one protocol, one timeout, one classifier', () => {
  it('the local protocol constant is the SDK revision the server speaks', () => {
    // The constant is local on purpose: two existing tests run these harnesses
    // from a `mkdtemp` with no `node_modules`, and a bare-specifier import
    // there is ERR_MODULE_NOT_FOUND. That makes it a duplicated fact, and a
    // duplicated fact is only safe if something COMPARES the two copies. This
    // is that something — checking each copy separately would not catch a
    // drift, which is the failure being guarded against.
    assert.equal(
      MCP_PROTOCOL_VERSION,
      LATEST_PROTOCOL_VERSION,
      'scripts/lib/mcp-client.mjs has fallen behind @modelcontextprotocol/sdk; bump the constant, or say why the older revision is intended',
    );
    assert.ok(
      SUPPORTED_PROTOCOL_VERSIONS.includes(MCP_PROTOCOL_VERSION),
      'the constant must be a revision the server can actually negotiate, not merely the SDK\'s newest',
    );
  });

  it('no script outside the shared client names a protocol version', () => {
    // The acceptance criterion, as a gate. A file that hard-codes its own
    // revision is exactly the drift this replaces, and `grep` is not a check —
    // it is a thing someone has to remember to run.
    //
    // The revision pattern is the SDK's own list, not a regex for anything
    // date-shaped: `live-gauntlet.mjs` legitimately contains `since: '2026-01-01'`
    // as a sweep argument, and a regex broad enough to catch that would have
    // made this gate a coin flip on a date in a comment.
    const offenders = scriptFiles().filter((file) => {
      if (file === join(LIB, 'mcp-client.mjs')) return false;
      const source = readFileSync(file, 'utf8');
      const namesTheField = /protocolVersion/.test(source);
      const hardCodesARevision = [...SUPPORTED_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION].some((v) =>
        source.includes(`'${v}'`) || source.includes(`"${v}"`),
      );
      return namesTheField || hardCodesARevision;
    });
    assert.deepEqual(
      offenders.map((f) => f.replace(`${ROOT}/`, '')),
      [],
      'these scripts negotiate their own protocol revision; the revision lives in scripts/lib/mcp-client.mjs so there is one of it',
    );
  });

  it('the shared client declares exactly one protocol version', () => {
    const source = readFileSync(join(LIB, 'mcp-client.mjs'), 'utf8');
    const versions = source.match(/20\d\d-\d\d-\d\d/g) ?? [];
    assert.deepEqual(
      versions,
      [MCP_PROTOCOL_VERSION],
      'scripts/lib/mcp-client.mjs must hold exactly one protocol version literal',
    );
  });

  it('no harness carries its own timeout default', () => {
    // The three copies held 120000, 45000 and 30000. A timeout that is a
    // property of the transport belongs to the transport.
    const offenders = HARNESSES.map((name) => join(SCRIPTS, name)).filter((file) =>
      /timeoutMs\s*=\s*\d|\d{4,6}\s*\)?\s*;?\s*\/\/\s*(ms|milliseconds)/.test(readFileSync(file, 'utf8')),
    );
    assert.deepEqual(
      offenders.map((f) => f.replace(`${ROOT}/`, '')),
      [],
      'a harness declared its own request timeout; the single policy is RPC_TIMEOUT_MS in scripts/lib/mcp-client.mjs',
    );
    assert.equal(RPC_TIMEOUT_MS, 120_000, 'the shared bound is the one the quota-paced full sweep needs');
  });

  it('the gated-endpoint sniff exists once, in the shared client', () => {
    const offenders = scriptFiles().filter((file) => {
      if (file === join(LIB, 'mcp-client.mjs')) return false;
      return /removed by spotify|not available for this app/.test(readFileSync(file, 'utf8'));
    });
    assert.deepEqual(
      offenders.map((f) => f.replace(`${ROOT}/`, '')),
      [],
      'the GATE_SNIFF pattern was duplicated byte-for-byte in live-gauntlet.mjs and sweep-finalize.mjs; a drifted copy would make the sweep report and the filed-issue count disagree about one run',
    );
  });

  it('looksGated classifies a gated answer and leaves everything else alone', () => {
    for (const text of [
      'Error: forbidden by the app registration',
      'HTTP 403',
      'This endpoint was removed by Spotify in February 2026',
      'not available for this app',
    ]) {
      assert.equal(looksGated(text), true, `should have read as gated: ${text}`);
    }
    for (const text of ['rate limit exceeded, retry after 12s', 'no results found', '', null, undefined, 403]) {
      assert.equal(looksGated(text), false, `should not have read as gated: ${String(text)}`);
    }
  });

  it('a JSON-RPC error body is capped before it is thrown', () => {
    // Unbounded in live-e2e.mjs, 300 in the gauntlet, 400 in the gate check —
    // so a sweep report's shape depended on which script produced it.
    assert.equal(ERROR_TEXT_CAP, 400);
    assert.ok(ERROR_TEXT_CAP < 2000, 'the cap exists so an error body cannot put a megabyte into a report');
  });
});

// ---------------------------------------------------------------------------
// Half 4 — a spawn that fails is reported, not thrown
// ---------------------------------------------------------------------------

/** A stand-in with the two events `spawn()` actually reports through. */
class FakeChild extends EventEmitter {
  kill(): boolean {
    return true;
  }
}

describe('#644 a child that cannot start is reported, not thrown', () => {
  it('records a spawn error and names the code', () => {
    const child = new FakeChild();
    const seen: Error[] = [];
    const guard = guardChild(child, { label: 'live-e2e', onFail: (e) => seen.push(e) });

    assert.equal(guard.failure(), null, 'a guard that reports a failure before one happened is not measuring anything');
    assert.equal(guard.alive(), true);

    const err = Object.assign(new Error('spawn node EACCES'), { code: 'EACCES' });
    child.emit('error', err);

    assert.match(String(guard.failure()), /could not start the server \(EACCES\)/);
    assert.equal(seen.length, 1);
  });

  it('keeps the first cause when the failed spawn also exits', () => {
    // `spawn` emits `error` and then `exit` for a child that never started. The
    // exit says nothing useful; if it won the race the message would name a
    // code and hide the permission error.
    const child = new FakeChild();
    const seen: Error[] = [];
    const guard = guardChild(child, { label: 'live-gauntlet', onFail: (e) => seen.push(e) });

    child.emit('error', Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }));
    child.emit('exit', 1, null);

    assert.match(String(guard.failure()), /ENOENT/);
    assert.equal(guard.alive(), false, 'a child that exited is not alive, whatever else went wrong');
    assert.equal(seen.length, 1, 'the reporter must fire once, not once per event');
  });

  it('names a crash instead of letting it read as a quota timeout', () => {
    // A server that dies mid-sweep used to wait out the FULL 120s and then
    // report `timeout: tools/call`, which sweep-finalize.mjs classifies as a
    // quota stall. That is a confident reading of a failure nobody measured.
    const child = new FakeChild();
    const guard = guardChild(child, { label: 'live-gauntlet' });
    child.emit('exit', null, 'SIGSEGV');
    assert.match(String(guard.failure()), /died on SIGSEGV/);
    assert.ok(
      !/^timeout:/.test(String(guard.failure())),
      'a crash must not be dressed up as a timeout, which downstream code reads as quota',
    );
  });

  it('does not call a clean exit a failure', () => {
    const child = new FakeChild();
    const guard = guardChild(child, { label: 'live-e2e' });
    child.emit('exit', 0, null);
    assert.equal(guard.failure(), null, 'close() and a clean exit are ordinary; reporting them would fire on every normal run');
    assert.equal(guard.alive(), false);
  });
});
