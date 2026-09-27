/**
 * One environment, one home — the erasure-safety decision must be made in the
 * same root the store paths were resolved in (#1358).
 *
 * `runLogout` takes an `env` and resolves every store path from it. It then
 * called `planErasure` with no environment at all, so the home-directory
 * refusal inside fell back to `os.homedir()` — the *process* home. A caller
 * that declared its own `HOME` therefore had its store paths redirected into
 * one root and its erasure-safety verdict computed in another, and the two
 * disagreed about which root was real.
 *
 * The half that matters is not the cosmetic one. `dangerousEraseTarget` refuses
 * a store that resolves to a home directory; with the check pointed at the
 * wrong home, that refusal does not fire, and `logout` approves erasing a
 * directory it was told was the home.
 *
 * ## Sandboxing
 *
 * Every path here is under one `mkdtemp` root. `before()` asserts the
 * containment property directly — every store the registry can produce must sit
 * under this test's own root, and none may be the declared home — so a store
 * added later without an override fails before any assertion can act on a path
 * outside the sandbox. No test here reads or writes a real store: the
 * developer's `~/.spotify-mcp` is user data, and these tests are meant to be
 * run on a box where it exists.
 *
 * `allowGioTrash: false` throughout. The erasure mechanism is then a rename
 * into a quarantine directory beside the original — same directory, same
 * filesystem, and inside the sandbox — so nothing reaches a trash can or any
 * path outside `mkdtemp`.
 *
 * The home and the store directory are kept **distinct**, which is what a real
 * machine looks like (`HOME` holds `.spotify-mcp`) and what makes these tests
 * independent of the "a directory that contains another store" rule. It also
 * isolates the defect: with the stores *inside* the declared home, the nesting
 * rule keeps that directory and the home-directory refusal is never reached.
 */

import './helpers/hermetic.js';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { REAL_HOME } from './helpers/hermetic.js';
import { localStorePaths, runLogout, type LogoutIo } from '../src/logout.js';

const created: string[] = [];
const ORIGINAL_CONFIRM = process.env.SPOTIFY_MCP_CONFIRM;

interface Box {
  /** The declared `$HOME`. */
  home: string;
  /** The `~/.spotify-mcp` equivalent every store is wired into. */
  data: string;
  root: string;
  env: NodeJS.ProcessEnv;
}

/**
 * A sandbox with every store override logout knows about, and a `$HOME` that
 * is a different directory from the store root.
 */
function sandbox(): Box {
  const root = mkdtempSync(join(tmpdir(), 'spotify-mcp-logout-home-'));
  created.push(root);
  const home = join(root, 'home');
  const data = join(root, 'data');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(data, { recursive: true, mode: 0o700 });

  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    SPOTIFY_MCP_DATA_DIR: data,
    SPOTIFY_MCP_TOKEN_FILE: join(data, 'tokens.json'),
    SPOTIFY_MCP_ACCOUNTS_FILE: join(data, 'accounts.json'),
    SPOTIFY_MCP_HISTORY_DIR: join(data, 'history'),
    SPOTIFY_MCP_RECEIPTS_DIR: join(data, 'receipts'),
    SPOTIFY_MCP_SCENES_FILE: join(data, 'scenes.json'),
    SPOTIFY_MCP_GENRE_TAGS_FILE: join(data, 'genre-tags.json'),
    SPOTIFY_MCP_PLAYBACKEXT_FILE: join(data, 'playback-ext.json'),
    SPOTIFY_MCP_SEARCH_HISTORY_FILE: join(data, 'search-history.json'),
    SPOTIFY_MCP_FRESHNESS_STATE: join(data, 'freshness.json'),
    SPOTIFY_MCP_TASTE_FEEDBACK_FILE: join(data, 'taste-feedback.json'),
    SPOTIFY_MCP_EXHAUST2_MISC_FILE: join(data, 'exhaust2-misc.json'),
    SPOTIFY_MCP_EXHAUST2_PLAYBACK_FILE: join(data, 'exhaust2-playback.json'),
    SPOTIFY_MCP_BACKUP_DIR: join(data, 'backups'),
    SPOTIFY_MCP_SNAPSHOT_DIR: join(data, 'swarm3-snapshots'),
    SPOTIFY_MCP_PORTABILITY_DIR: join(data, 'portability'),
    SPOTIFY_MCP_EXPORT_DIR: join(data, 'exports'),
  };
  return { home, data, root, env };
}

/** `y`, so an approved erasure really is attempted rather than cancelled. */
function io(answer = 'y'): { io: LogoutIo; output: () => string } {
  let buffer = '';
  return {
    io: {
      isInteractive: true,
      ask: async () => answer,
      write: (text) => {
        buffer += text;
      },
    },
    output: () => buffer,
  };
}

const exists = (path: string): Promise<boolean> => fs.stat(path).then(() => true, () => false);

before(() => {
  // The property every assertion here depends on: the sandbox redirects the
  // whole registry. A store added without an override below would resolve
  // through `os.homedir()` to the real `~/.spotify-mcp`, and the erase that
  // follows would be real.
  const box = sandbox();
  assert.notEqual(box.home, homedir());
  assert.notEqual(box.home, REAL_HOME, 'the sandbox home must never be the real home');
  for (const store of localStorePaths({ env: box.env })) {
    assert.ok(
      store.path === box.data || store.path.startsWith(box.data + '/'),
      `${store.id} would resolve outside the sandbox (${store.path}) — add its env override to sandbox()`,
    );
    assert.notEqual(store.path, box.home, `${store.id} resolves to the sandbox home`);
  }
});

after(async () => {
  if (ORIGINAL_CONFIRM === undefined) delete process.env.SPOTIFY_MCP_CONFIRM;
  else process.env.SPOTIFY_MCP_CONFIRM = ORIGINAL_CONFIRM;
  for (const path of created.reverse()) {
    await fs.rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('#1358 — the erasure-safety check must use the env the stores came from', () => {
  it('refuses a store that resolves to the home the caller declared', async () => {
    // The shape the defect produces: the caller's own home, offered as a store.
    // Before the fix `planErasure` compared this path against the *process*
    // home, found no match, and answered `erase`.
    const box = sandbox();
    const env = { ...box.env, SPOTIFY_MCP_EXPORT_DIR: box.home };
    assert.equal(
      localStorePaths({ env }).find((s) => s.id === 'exports')?.path,
      box.home,
      'precondition: the exports store is the declared home',
    );

    const { io: seam, output } = io('y');
    // --dry-run runs the whole plan and provably erases nothing, so the
    // failure this test is written for cannot cost a file even before the real
    // assertion below.
    const code = await runLogout(['--dry-run'], seam, { env, allowGioTrash: false });

    assert.equal(code, 0);
    assert.match(output(), /exports\s+REFUSED\s+Exports/);
    assert.match(output(), /is the home directory/);
    assert.match(output(), /Dry run/);
  });

  it('leaves a declared home directory and its contents on disk', async () => {
    // The half that is an erasure-safety bug rather than a wrong report: before
    // the fix this directory was moved into the quarantine and the exit code
    // was 0. Everything here is inside `mkdtemp`, so the pre-fix failure is a
    // disposable directory, never user data.
    const box = sandbox();
    const precious = join(box.home, 'precious.txt');
    await fs.writeFile(precious, 'do not delete me', { mode: 0o600 });

    const env = { ...box.env, SPOTIFY_MCP_EXPORT_DIR: box.home };
    const { io: seam, output } = io('y');
    const code = await runLogout([], seam, { env, allowGioTrash: false });

    assert.match(output(), /REFUSED/);
    assert.match(output(), /is the home directory/);
    assert.equal(code, 1, 'a refusal must not exit 0');
    assert.equal(await exists(box.home), true, 'the home directory itself must survive');
    assert.equal(await fs.readFile(precious, 'utf8'), 'do not delete me');
  });

  it('still erases a store that sits inside the declared home', async () => {
    // The control. Without it, "refuse the home directory" and "refuse every
    // path anywhere" would both pass the two tests above.
    const box = sandbox();
    const token = join(box.data, 'tokens.json');
    await fs.writeFile(token, '{"refresh_token":"rt"}', { mode: 0o600 });

    const { io: seam, output } = io('y');
    const code = await runLogout([], seam, { env: box.env, allowGioTrash: false });

    assert.equal(code, 0, output());
    assert.equal(await exists(token), false, 'an ordinary store is the ordinary case');
    assert.match(output(), /Local stores cleared/);
  });

  it('still refuses the process home when the caller declared a different one', async () => {
    // Nothing may be loosened by the fix. `os.homedir()` is what every store
    // *default* resolves through — several stores have no override at all — so
    // the process home stays a guard home even when the caller names another.
    const box = sandbox();
    const env = { ...box.env, SPOTIFY_MCP_EXPORT_DIR: homedir() };
    const { io: seam, output } = io('y');
    const code = await runLogout(['--dry-run'], seam, { env, allowGioTrash: false });

    assert.equal(code, 0);
    assert.match(output(), /exports\s+REFUSED\s+Exports/);
    assert.match(output(), /is the home directory/);
  });

  it('refuses, rather than erases, a store that points outside the sandbox', async () => {
    // The other half of the same contract, and the one that decides what
    // happens to a path *outside* the home this run declared: refused, never
    // erased. A symlinked store is the shape that gets there — the link's
    // target is not what the user was asked about, and following it is how the
    // #623 class of bug reaches outside the store. (`runLogout` derives each
    // store's root from its own path, so the realpath-containment rule cannot
    // be reached from here; `tests/logout.test.ts` covers it with a
    // hand-built store, which is the only way to state it.)
    //
    // The victim is a `mkdtemp` sibling, not something outside this file's own
    // root: a test that proved the guard by pointing it at a real directory
    // would be betting the user's files on the guard being right.
    const box = sandbox();
    const escapeRoot = await fs.mkdtemp(join(tmpdir(), 'spotify-mcp-logout-escape-'));
    created.push(escapeRoot);
    const victim = join(escapeRoot, 'precious.json');
    await fs.writeFile(victim, 'do not delete me', { mode: 0o600 });

    // A directory inside the declared home, holding a link to the escape root.
    const exportsDir = join(box.data, 'exports');
    await fs.mkdir(exportsDir, { recursive: true, mode: 0o700 });
    await fs.symlink(escapeRoot, join(exportsDir, 'linked'));
    const env = { ...box.env, SPOTIFY_MCP_EXPORT_DIR: join(exportsDir, 'linked') };

    const { io: seam, output } = io('y');
    const code = await runLogout([], seam, { env, allowGioTrash: false });

    assert.match(output(), /exports\s+REFUSED/);
    assert.match(output(), /is a symlink to/);
    assert.equal(code, 1, 'a refusal must not exit 0');
    assert.equal(await fs.readFile(victim, 'utf8'), 'do not delete me');
  });
});
