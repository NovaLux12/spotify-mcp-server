/**
 * #1397 — the live harness scripts must not be able to reach a real `$HOME`.
 *
 * ## The defect
 *
 * `scripts/live-gauntlet.mjs`, `scripts/live-e2e.mjs` and
 * `scripts/tool-gate-check.mjs` each spawned the real server with no `env`
 * option. `spawn` with no `env` inherits the parent's **entire** environment, so
 * the child got the developer's real `$HOME` — and every local store in this
 * server resolves as `join(homedir(), '.spotify-mcp', …)` (`src/config.ts`).
 * A sweep the scripts themselves describe as "safe reads" was therefore running
 * against production user data: `tokens.json`, `accounts.json`,
 * `search-history.json`, `freshness.json`, `taste-feedback.json`, `cache.json`,
 * `scenes.json` and a `backups/` directory holding thousands of accumulated
 * files.
 *
 * The gauntlet already refused to call `save_scene` / `delete_scene` /
 * `cancel_wind_down`, and named them in its `uncalled registry writes` audit
 * line. That is a blocklist of three tools, and it is not the fix: nothing about
 * the spawn made a *local write* distinguishable from a *Spotify API call*, so
 * every tool added later that touched local state was automatically in the blast
 * radius. The fix is structural — `scripts/hermetic-home.mjs` hands the child a
 * throwaway home — and these tests hold it to that.
 *
 * ## What each half proves, and why both are here
 *
 * A guard that only does one of these is decoration, so both do the real
 * comparison rather than asserting that a variable was assigned:
 *
 *  1. **Structural.** No `scripts/*.mjs` may spawn `dist/index.js` by any route
 *     other than `spawnHarnessServer`. Checked by a pure function over sources
 *     so it can be driven against a deliberately broken copy, and the check is
 *     shown to flag a bare `spawn` — a guard that cannot go red is not a guard.
 *
 *  2. **Behavioural.** The three harness scripts are executed **as processes**,
 *     each spawning the real repository-shipped code against a stub server that
 *     reports the `HOME` and the resolved store directory it was actually
 *     started with. This is the assertion the issue's definition of done asks
 *     for, and it is the one that cannot be satisfied by an assignment that
 *     never reaches the child.
 *
 *  3. **A real store write.** `save_scene` writes `scenes.json` and needs no
 *     network, so the built `dist/index.js` is booted with a harness environment
 *     and the file is then looked for. The matching negative leg boots the same
 *     server with an ordinary environment and shows the write landing there
 *     instead — which is what makes the positive leg mean anything.
 *
 * Nothing here reads, writes or lists the developer's own `~/.spotify-mcp`. The
 * only place the real store is touched at all is `createHarnessHome`'s token
 * copy, and by the time this file runs `tests/helpers/hermetic.ts` has already
 * redirected `HOME`, so that copy reads a temp root that does not exist. The
 * "real home" the tests compare against is a *fixture* — a fresh `mkdtemp` that
 * stands in for the developer's home, so the leak is observable without any test
 * ever pointing at the actual one.
 */

import './helpers/hermetic.js';

import { StdioJsonRpcChild } from './helpers/stdio-child.js';
import { armFileDeadline } from './helpers/file-deadline.js';

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertStoresInsideSandbox,
  createHarnessHome,
  isInside,
  sandboxStorePins,
  spawnHarnessServer,
} from '../scripts/hermetic-home.mjs';

import { LOCAL_STORES, storePath } from '../src/config.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPTS = join(ROOT, 'scripts');
const DIST_INDEX = join(ROOT, 'dist', 'index.js');

/**
 * Every server child this file boots, so the whole-file deadline can name and
 * reap all of them rather than only the ones a hook happened to register.
 */
const spawned: StdioJsonRpcChild[] = [];

// ~10x the ~2.1 s this repo's measured `initialize` + `tools/list` costs, and it
// has to cover three harness processes plus two real server boots. Armed at
// module scope, before any hook, and with nothing that can clear it.
armFileDeadline({
  label: 'harness-hermetic-home.test.ts',
  budgetMs: 3 * 60_000,
  children: () => spawned,
});

/** The three scripts that used to spawn the server with no `env`. */
const HARNESS_SCRIPTS = ['live-gauntlet.mjs', 'live-e2e.mjs', 'tool-gate-check.mjs'] as const;

/** Everything created here goes under the OS temp root, and nothing else. */
const scratchDirs: string[] = [];
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}
/** Sandboxes the helper made, cleaned here because its own cleanup is on exit. */
const harnessSandboxes: { cleanup(): void }[] = [];
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  for (const sandbox of harnessSandboxes) sandbox.cleanup();
});

// ---------------------------------------------------------------------------
// Half 1 — structural
// ---------------------------------------------------------------------------

/**
 * Does this source spawn the server without going through the hermetic spawn?
 *
 * Kept as a pure function of the source text so the anti-vacuity case can drive
 * it with a synthetic string instead of asserting against the same source it
 * reads. A check that cannot be shown to fail is a comment with a `for` loop.
 *
 * The two halves are deliberate. `hermetic-home.mjs` is the ONLY module allowed
 * to import `node:child_process`; a harness that grows its own `spawn` has
 * reintroduced the bug no matter what arguments it passes.
 */
export function spawnsWithoutHarnessHome(files: readonly string[], read: (file: string) => string): string[] {
  return files.filter((file) => {
    const source = read(file);
    if (/(?:^|\n)\s*import\s[^;]*?from\s+['"]node:child_process['"]/.test(source)) return true;
    // A bare `spawn(` that is not the import is still a bare spawn, whether it
    // came from `node:child_process` via require or a local re-export.
    return /(?<![.\w])spawn(?:Sync)?\s*\(/.test(source) && !/spawnHarnessServer/.test(source);
  });
}

function harnessScriptFiles(): string[] {
  return readdirSync(SCRIPTS)
    .filter((name) => name.endsWith('.mjs'))
    .filter((name) => HARNESS_SCRIPTS.includes(name as (typeof HARNESS_SCRIPTS)[number]))
    .sort()
    .map((name) => join(SCRIPTS, name));
}

// ---------------------------------------------------------------------------
// Half 2 — behavioural: run the real scripts, read the child's real environment
// ---------------------------------------------------------------------------

/**
 * A stub MCP server that reports the home it was actually started with.
 *
 * `dist/index.js` is replaced by this, and the real harness script beside it. The
 * stub writes `{HOME, USERPROFILE, homedir, storeDir, wroteTo, wroteOk}` to
 * `STUB_ENV_OUT` the moment it starts, which is the only observation that
 * matters here: what the harness's spawn actually handed the child, read from
 * inside the child rather than inferred from the harness's source.
 *
 * `storeDir` is computed exactly as `src/config.ts` computes its default —
 * `join(homedir(), '.spotify-mcp')` — so the assertion can name the path a real
 * write would land on, not merely a variable. The stub then MAKES that write, so
 * "the sandbox was honoured" is a fact about a file rather than an assignment.
 *
 * The stub reports the outcome of its own write rather than leaving the file
 * behind as the evidence, because the harness deletes its sandbox on exit — that
 * is the intended behaviour, and a test that needed the directory to outlive the
 * process would be testing the wrong thing. The check that the caller's own home
 * stayed empty is done from outside, by walking the caller's tree.
 */
const STUB_SERVER = `
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const observed = {
  HOME: process.env.HOME ?? null,
  USERPROFILE: process.env.USERPROFILE ?? null,
  homedir: homedir(),
  storeDir: join(homedir(), '.spotify-mcp'),
  wroteTo: null,
  wroteOk: false,
  error: null,
};
try {
  mkdirSync(observed.storeDir, { recursive: true });
  observed.wroteTo = join(observed.storeDir, 'scenes.json');
  writeFileSync(observed.wroteTo, JSON.stringify({ probe: true }));
  observed.wroteOk = existsSync(observed.wroteTo);
} catch (err) {
  observed.error = String(err);
}
writeFileSync(process.env.STUB_ENV_OUT, JSON.stringify(observed));

const props = (o) => ({ type: 'object', properties: o, additionalProperties: false });
const TOOLS = [
  { name: 'get_me', description: 'me', inputSchema: props({}), annotations: { readOnlyHint: true, idempotentHint: true } },
  { name: 'search', description: 'search', inputSchema: props({}), annotations: { readOnlyHint: true, idempotentHint: true } },
  { name: 'get_saved_tracks', description: 'saved', inputSchema: props({}), annotations: { readOnlyHint: true, idempotentHint: true } },
  { name: 'get_saved_albums', description: 'albums', inputSchema: props({}), annotations: { readOnlyHint: true, idempotentHint: true } },
  { name: 'get_user_playlists', description: 'playlists', inputSchema: props({}), annotations: { readOnlyHint: true, idempotentHint: true } },
  { name: 'get_devices', description: 'devices', inputSchema: props({}), annotations: { readOnlyHint: true, idempotentHint: true } },
];
const paged = (items) => ({ items, pagination: { total: items.length, offset: 0, limit: items.length, next_offset: null } });
const call = (name) => {
  switch (name) {
    case 'get_me': return { structuredContent: { id: 'user1', country: 'GB' } };
    case 'search': return { structuredContent: { tracks: { items: [{ id: 't1', album: { id: 'al1' }, artists: [{ id: 'ar1' }] }] }, shows: { items: [] }, episodes: { items: [] }, audiobooks: { items: [] } } };
    case 'get_saved_tracks': return { structuredContent: paged([{ id: 't1' }]) };
    case 'get_saved_albums': return { structuredContent: paged([{ id: 'al1' }]) };
    case 'get_user_playlists': return { structuredContent: paged([{ id: 'pl1' }]) };
    case 'get_devices': return { structuredContent: { items: [] } };
    default: throw new Error('unknown tool ' + name);
  }
};

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    let result;
    try {
      result = msg.method === 'initialize'
        ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'stub', version: '0' } }
        : msg.method === 'tools/list' ? { tools: TOOLS }
        : msg.method === 'tools/call' ? call(msg.params.name)
        : {};
    } catch (err) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err.message } }) + '\\n');
      continue;
    }
    if (result.structuredContent && !result.content) {
      result.content = [{ type: 'text', text: JSON.stringify(result.structuredContent) }];
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  }
});
`;

interface Observed {
  readonly HOME: string | null;
  readonly USERPROFILE: string | null;
  readonly homedir: string;
  readonly storeDir: string;
  readonly wroteTo: string | null;
  readonly wroteOk: boolean;
  readonly error: string | null;
}

/**
 * A sandbox holding a COPY of the real harness beside the stub server.
 *
 * The driver spawns `node --env-file=.env dist/index.js` from the sandbox root
 * and imports `./hermetic-home.mjs` and `./live-gauntlet-core.mjs` beside it,
 * so those copies have to land at those paths too.
 *
 * ## The "developer's home" is a fixture
 *
 * `fakeHome` plays the part of the machine's real `$HOME`, and the harness
 * process is started with it. It is a fresh `mkdtemp` that nothing else uses.
 * That is deliberate: the leak this test hunts is "the child inherited the
 * parent's `HOME`", and pointing the parent at a fixture makes the leak
 * observable — a file appears in the fixture — without any test in this file
 * ever naming the developer's actual `~/.spotify-mcp`.
 *
 * `scripts/hermetic-home.mjs` reads the built registry from
 * `SPOTIFY_MCP_DIST_ROOT`, which defaults to `<its own repo>/dist` and would
 * therefore be the stub here. Pointing it at the real build is what lets the
 * helper check the REAL store registry — the same eighteen stores the real
 * server has.
 */
function harnessSandbox(script: string): { dir: string; envOut: string; fakeHome: string; run: () => Observed } {
  const dir = scratch('harness-home-');
  const fakeHome = mkdtempSync(join(tmpdir(), 'harness-fake-home-'));
  scratchDirs.push(fakeHome);

  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  // `--env-file` is a hard requirement of all three harnesses and node exits 9
  // without it, so the fixture has to carry an empty one.
  writeFileSync(join(dir, '.env'), '', 'utf8');
  mkdirSync(join(dir, 'dist'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'index.js'), STUB_SERVER, 'utf8');
  copyFileSync(join(SCRIPTS, script), join(dir, 'scripts', script));
  for (const support of ['hermetic-home.mjs', 'live-gauntlet-core.mjs']) {
    const from = join(SCRIPTS, support);
    if (existsSync(from)) copyFileSync(from, join(dir, 'scripts', support));
  }
  const envOut = join(dir, 'observed.json');
  return {
    dir,
    envOut,
    fakeHome,
    run: () => {
      const res = spawnSync(process.execPath, [`scripts/${script}`, `--report=${join(dir, 'report.json')}`], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 90_000,
        env: {
          ...process.env,
          HOME: fakeHome,
          USERPROFILE: fakeHome,
          STUB_ENV_OUT: envOut,
          // The helper's registry comes from the real build, not the stub.
          SPOTIFY_MCP_DIST_ROOT: join(ROOT, 'dist'),
        },
      });
      if (res.error) throw res.error;
      assert.ok(
        existsSync(envOut),
        `${script} never started a server, so nothing was observed.\n`
          + `exit=${res.status}\nstdout:\n${(res.stdout ?? '').slice(-3000)}\nstderr:\n${(res.stderr ?? '').slice(-3000)}`,
      );
      return JSON.parse(readFileSync(envOut, 'utf8')) as Observed;
    },
  };
}

// ---------------------------------------------------------------------------

describe('#1397 the live harnesses cannot reach a real $HOME', () => {
  describe('the hermetic spawn is the only route to the server', () => {
    it('no harness script spawns the server itself', () => {
      const files = harnessScriptFiles();
      assert.deepEqual(
        files.map((f) => relative(ROOT, f)),
        HARNESS_SCRIPTS.map((s) => `scripts/${s}`).sort(),
        'the harness set changed; the structural guard is not scanning what it claims to scan',
      );

      const offenders = spawnsWithoutHarnessHome(files, (f) => readFileSync(f, 'utf8'));
      assert.deepEqual(
        offenders.map((f) => relative(ROOT, f)),
        [],
        'these harness scripts spawn the server without scripts/hermetic-home.mjs, so the child '
          + 'inherits the real $HOME and writes into the real ~/.spotify-mcp (#1397)',
      );
    });

    it('flags a harness that spawns the server on its own', () => {
      // Anti-vacuity. A guard that cannot be shown to fail is a comment.
      const bare = [
        "#!/usr/bin/env node",
        "import { spawn } from 'node:child_process';",
        "const child = spawn('node', ['--env-file=.env', 'dist/index.js'], { cwd, stdio: ['pipe','pipe','inherit'] });",
      ].join('\n');
      const usesHelper = [
        "#!/usr/bin/env node",
        "import { spawnHarnessServer } from './hermetic-home.mjs';",
        'const { child } = await spawnHarnessServer({ label: "x", args: ["dist/index.js"] });',
      ].join('\n');

      assert.deepEqual(
        spawnsWithoutHarnessHome(['a.mjs'], () => bare),
        ['a.mjs'],
        'the scan did not flag a bare spawn of dist/index.js, which is the exact #1397 shape',
      );
      assert.deepEqual(
        spawnsWithoutHarnessHome(['b.mjs'], () => usesHelper),
        [],
        'the scan flagged a script that routes its spawn through hermetic-home.mjs',
      );
    });
  });

  describe('what the child is actually started with', () => {
    for (const script of HARNESS_SCRIPTS) {
      it(`${script} hands its server a throwaway home, not the caller's`, () => {
        const box = harnessSandbox(script);
        const seen = box.run();

        // FIRST, the observable that is not a variable: nothing reached the
        // caller's home. This is the half that goes red when the spawn loses
        // its `env`, because then the child's storeDir IS this tree. Checking
        // it first is deliberate — a test that stops at "the HOME variable was
        // not the caller's" has proved nothing about where bytes landed.
        assert.equal(seen.error, null, `the stub could not write a store file: ${seen.error}`);
        assert.ok(seen.wroteOk, 'the stub did not manage a store write, so the path being observed is untested');
        assert.deepEqual(
          readdirSync(box.fakeHome, { recursive: true } as never).map(String),
          [],
          `${script} wrote into the caller's home (${box.fakeHome}), which stands in for the developer's real `
            + 'one. Every local store resolves as join(homedir(), ".spotify-mcp", …), so this is a write to the '
            + 'real ~/.spotify-mcp — the #1397 defect.',
        );

        // Then the environment it was actually started with.
        assert.equal(seen.HOME, seen.homedir, 'the child resolved a home that is not the one it was given');
        assert.notEqual(
          seen.HOME,
          box.fakeHome,
          `${script} handed its server the caller's own $HOME. Every local store resolves as `
            + 'join(homedir(), ".spotify-mcp", …), so the sweep wrote into the real store — the #1397 defect.',
        );

        // Fresh, disposable, and under the OS temp root rather than a user home.
        assert.ok(
          isInside(tmpdir(), seen.HOME),
          `${script} pointed the server at ${seen.HOME}, which is not under the OS temp root`,
        );
        assert.ok(
          isInside(seen.HOME, seen.storeDir),
          `${script} resolved its store dir to ${seen.storeDir}, outside the sandbox home ${seen.HOME}`,
        );
        assert.ok(
          seen.wroteTo !== null && isInside(seen.HOME, seen.wroteTo),
          `the stub's store write went to ${seen.wroteTo}, outside the sandbox home ${seen.HOME}`,
        );
        assert.equal(
          seen.USERPROFILE,
          seen.HOME,
          `${script} redirected HOME but not USERPROFILE, so the Windows home lookup still names the real home`,
        );
      });
    }

    it('the gauntlet still names the tools its gate excludes', () => {
      // #1397's third definition-of-done item, and a check that the fix did not
      // buy coverage by quietly widening what the sweep is allowed to do. The
      // `uncalled registry writes` audit line is what keeps an exclusion
      // VISIBLE, so it has to survive the change that made the hazard
      // unreachable.
      const source = readFileSync(join(SCRIPTS, 'live-gauntlet.mjs'), 'utf8');
      const box = harnessSandbox('live-gauntlet.mjs');
      box.run();
      const core = readFileSync(join(SCRIPTS, 'live-gauntlet-core.mjs'), 'utf8');
      assert.match(
        core,
        /uncalled registry writes/,
        'the audit line that makes a gated tool visible is gone from the classifier',
      );
      assert.match(
        source,
        /save_scene: \(\) => 'MUTATING-ADJACENT/,
        'save_scene is no longer named in the gauntlet\'s recipe table, so its exclusion is silent again',
      );
      assert.match(
        source,
        /delete_scene: \(\) => 'MUTATING-ADJACENT/,
        'delete_scene is no longer named in the gauntlet\'s recipe table, so its exclusion is silent again',
      );
    });
  });

  describe('the sandbox really is a sandbox', () => {
    it('every store in the registry resolves inside it, under a hostile environment', () => {
      // The environment a developer's shell plausibly carries: a backup
      // directory and a data directory pointing somewhere real. Before #1397
      // nothing in the harness neutralised these, and `HOME` alone would not
      // have helped — an explicit variable outranks a default.
      const fake = mkdtempSync(join(tmpdir(), 'harness-hostile-src-'));
      scratchDirs.push(fake);
      const hostile = {
        ...process.env,
        HOME: fake,
        USERPROFILE: fake,
        SPOTIFY_MCP_TOKEN_FILE: join(fake, 'absent.json'),
        SPOTIFY_MCP_BACKUP_DIR: join(fake, 'real-backups'),
        SPOTIFY_MCP_DATA_DIR: join(fake, 'real-data'),
        SPOTIFY_MCP_SCENES_FILE: join(fake, 'real-scenes.json'),
        SPOTIFY_MCP_HISTORY_DIR: join(fake, 'real-history'),
        SPOTIFY_MCP_FRESHNESS_STATE: join(fake, 'real-freshness.json'),
      };
      return createHarnessHome({ label: 'hostile', realEnv: hostile }).then((sandbox) => {
        try {
          for (const store of LOCAL_STORES) {
            const resolved = storePath(store.id, sandbox.env);
            assert.ok(
              isInside(sandbox.home, resolved),
              `${store.id} resolved to ${resolved}, outside the sandbox ${sandbox.home} — the inherited `
                + `${store.envVar} survived the redirect`,
            );
          }
          // And the pins are the documented defaults, not merely "somewhere inside".
          const pins = sandboxStorePins(join(sandbox.home, '.spotify-mcp'));
          assert.equal(pins.SPOTIFY_MCP_BACKUP_DIR, join(sandbox.home, '.spotify-mcp', 'backups'));
          assert.equal(pins.SPOTIFY_MCP_RECEIPTS_DIR, join(sandbox.home, '.spotify-mcp'));
          assert.equal(
            storePath('receipts', sandbox.env),
            join(sandbox.home, '.spotify-mcp', 'receipts.jsonl'),
            'the receipts ledger moved out of the store dir; SPOTIFY_MCP_HISTORY_DIR outranks the default',
          );
        } finally {
          sandbox.cleanup();
        }
      });
    });

    it('refuses an environment whose stores escape, rather than spawning anyway', async () => {
      // The fail-closed half, driven directly. A `throw` here is what stops a
      // future wrong pin from being a silent write to the real home.
      const fake = mkdtempSync(join(tmpdir(), 'harness-escape-'));
      scratchDirs.push(fake);
      await assert.rejects(
        () => assertStoresInsideSandbox({ HOME: fake, SPOTIFY_MCP_BACKUP_DIR: join(fake, 'real-backups') }, fake),
        /refusing to spawn a server whose local stores resolve outside/,
        'a store pointing outside the sandbox was accepted, so the guard is decorative',
      );
    });

    it('refuses a pin table that does not cover the registry', async () => {
      // A store added tomorrow without a pin must stop the harness, loudly. The
      // error has to NAME the uncovered variable, because "a store is
      // unprotected" is not actionable on its own.
      const fake = mkdtempSync(join(tmpdir(), 'harness-uncovered-'));
      scratchDirs.push(fake);
      const pins = sandboxStorePins(join(fake, '.spotify-mcp'));
      const env = { HOME: fake, USERPROFILE: fake, ...pins, SPOTIFY_MCP_BACKUP_DIR: '/somewhere/real' };
      await assert.rejects(
        () => assertStoresInsideSandbox(env, fake),
        (error: Error) => {
          assert.match(error.message, /refusing to spawn/);
          assert.match(error.message, /backups/);
          return true;
        },
      );
    });
  });

  describe('a real store write lands in the sandbox', () => {
    it('save_scene through the built server writes under the sandbox home, and not where an ordinary environment points', async function () {
      // `save_scene` is the tool the gauntlet has always refused to call, and it
      // is the reason this issue was filed: it writes `scenes.json` and needs no
      // network, so it makes the whole claim observable end to end.
      assert.ok(
        existsSync(DIST_INDEX),
        'dist/index.js is missing — run `npm run build` first. A test that skipped this leg would be green for the wrong reason.',
      );

      // The positive leg: the environment the harness itself hands a child.
      const { child: harnessChild, sandbox } = await spawnHarnessServer({
        label: 'write-probe',
        args: [DIST_INDEX],
        cwd: ROOT,
        env: { SPOTIFY_CLIENT_ID: 'harness-isolation-probe' },
      });
      // The helper arms its cleanup on process exit, which is right for a
      // one-shot harness and wrong for a test that wants to look at the
      // directory. Track it so `after()` removes it with everything else, and
      // kill the child now — a raw `spawn` with piped stdio holds the event
      // loop open for as long as it lives, which is how this file first hung.
      harnessSandboxes.push(sandbox);
      const positive = await callSaveScene(sandbox.env.HOME, 'harness-hermetic', 'harness');
      await positive.dispose();
      harnessChild.kill();

      assert.ok(
        existsSync(join(sandbox.storeDir, 'scenes.json')),
        `save_scene did not write ${join(sandbox.storeDir, 'scenes.json')} — the leg observed nothing`,
      );
      const saved = JSON.parse(readFileSync(join(sandbox.storeDir, 'scenes.json'), 'utf8')) as Record<string, unknown>;
      assert.ok('harness-hermetic' in saved, 'the write is not the one the probe asked for');
      // The path a real tool would have used, and the token-file location, are
      // both inside — nothing the server resolves escaped.
      for (const store of LOCAL_STORES) {
        assert.ok(
          isInside(sandbox.home, storePath(store.id, sandbox.env)),
          `${store.id} resolved outside the sandbox for the environment the harness actually spawns with`,
        );
      }

      // The negative leg: the same server, the same call, an ordinary
      // environment. This is what makes the positive leg mean something — if
      // the write followed the child rather than the sandbox, this is where it
      // would have gone.
      const plainHome = mkdtempSync(join(tmpdir(), 'harness-plain-home-'));
      scratchDirs.push(plainHome);
      const plainEnv: Record<string, string> = { ...process.env, HOME: plainHome, USERPROFILE: plainHome };
      for (const key of Object.keys(plainEnv)) {
        if (key.startsWith('SPOTIFY_MCP_')) delete plainEnv[key];
      }
      plainEnv.SPOTIFY_CLIENT_ID = 'harness-isolation-probe';
      const negative = await callSaveScene(plainHome, 'harness-hermetic', 'plain');
      await negative.dispose();

      assert.ok(
        existsSync(join(plainHome, '.spotify-mcp', 'scenes.json')),
        'a save_scene under an ordinary environment did not land in that environment, so the positive leg '
          + 'above would pass for a reason that has nothing to do with the harness',
      );
      assert.notEqual(plainHome, sandbox.home, 'the two legs shared a home, so they prove nothing');
    });
  });
});

/** Boot the built server with `env`, save one scene, and hand back the child. */
async function callSaveScene(home: string, sceneName: string, label: string): Promise<StdioJsonRpcChild> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.SPOTIFY_CLIENT_ID = 'harness-isolation-probe';
  for (const key of Object.keys(env)) {
    if (key.startsWith('SPOTIFY_MCP_')) delete env[key];
  }
  const child = StdioJsonRpcChild.spawn({
    label,
    command: process.execPath,
    args: [DIST_INDEX],
    cwd: ROOT,
    env,
  });
  spawned.push(child);
  try {
    await child.initialize('harness-hermetic-home-test');
    const res = await child.request('tools/call', { name: 'save_scene', arguments: { name: sceneName, volume: 50 } });
    assert.equal(res.error, undefined, `save_scene failed: ${JSON.stringify(res.error)}`);
  } catch (error) {
    await child.dispose();
    throw error;
  }
  return child;
}
