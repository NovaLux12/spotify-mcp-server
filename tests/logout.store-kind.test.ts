/**
 * `logout` must not erase a path whose kind is not the kind the owning module
 * declared — #1309.
 *
 * The failure this pins: sixteen stores are declared `kind: 'file'` and erased
 * by a move. Nothing checked `info.isFile()`, so a **directory** sitting at one
 * of those paths passed both refusals that did exist — the symlink rule, and
 * containment, which a directory at `scenes.json` satisfies by construction
 * because its own root is `dirname(path)`. The tree was moved, the report named
 * one path (the directory), and `logout` exited 0 claiming the machine was
 * clear. A store that was never a cache — user data at a path the config calls
 * a file — was swept up by a routine that believed it was clearing derived
 * state.
 *
 * Two things are therefore asserted, and the second matters as much as the
 * first: the directory is **refused**, and the refusal **names what is inside
 * it**. `docs/configuration.md` promises every removed path is printed so the
 * report can be checked against the disk; a refusal that did not name its
 * contents would be a store left in place that the user still has to go and
 * investigate, which is the same under-report wearing a refusal's clothes.
 *
 * The positive-control tests at the end are load-bearing in the other
 * direction: a fix that refuses every store, or that refuses anything with a
 * child in it, would satisfy every test above. Those fail it.
 *
 * Every store env var is pointed at a fresh `mkdtemp` root, `SPOTIFY_MCP_BACKUP_DIR`
 * among them — this server's own `backups/` library is user data and a test that
 * trashes it is a bug with a green tick.
 */

import './helpers/hermetic.js';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  eraseStore,
  localStorePaths,
  planErasure,
  runLogout,
  type LogoutIo,
} from '../src/logout.js';

const created: string[] = [];
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CONFIRM = process.env.SPOTIFY_MCP_CONFIRM;

/** A throwaway data dir wired into every store override logout knows about. */
function sandbox(): { root: string; home: string; env: NodeJS.ProcessEnv } {
  const root = join(tmpdir(), `spotify-mcp-logout-kind-${randomUUID()}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  created.push(root);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    // Distinct from `root` for the reason spelled out in the two tests below
    // that already had to construct a distinct HOME by hand: with HOME ===
    // DATA_DIR the playlist-health store resolves to the home directory and
    // `dangerousEraseTarget` refuses it. That refusal became reachable from
    // `runLogout` when the env was threaded through to the check (#1358) — the
    // check used to run against the process home, which this env never named.
    HOME: home,
    SPOTIFY_MCP_DATA_DIR: root,
    SPOTIFY_MCP_TOKEN_FILE: join(root, 'tokens.json'),
    SPOTIFY_MCP_ACCOUNTS_FILE: join(root, 'accounts.json'),
    SPOTIFY_MCP_HISTORY_DIR: join(root, 'history'),
    SPOTIFY_MCP_RECEIPTS_DIR: join(root, 'receipts'),
    SPOTIFY_MCP_SCENES_FILE: join(root, 'scenes.json'),
    SPOTIFY_MCP_GENRE_TAGS_FILE: join(root, 'genre-tags.json'),
    SPOTIFY_MCP_LANES_FILE: join(root, 'lanes.json'),
    SPOTIFY_MCP_PLAYBACKEXT_FILE: join(root, 'playback-ext.json'),
    SPOTIFY_MCP_SEARCH_HISTORY_FILE: join(root, 'search-history.json'),
    SPOTIFY_MCP_FRESHNESS_STATE: join(root, 'freshness.json'),
    SPOTIFY_MCP_TASTE_FEEDBACK_FILE: join(root, 'taste-feedback.json'),
    SPOTIFY_MCP_EXHAUST2_MISC_FILE: join(root, 'exhaust2-misc.json'),
    SPOTIFY_MCP_EXHAUST2_PLAYBACK_FILE: join(root, 'exhaust2-playback.json'),
    SPOTIFY_MCP_BACKUP_DIR: join(root, 'backups'),
    SPOTIFY_MCP_SNAPSHOT_DIR: join(root, 'snapshots'),
    SPOTIFY_MCP_PORTABILITY_DIR: join(root, 'portability'),
    SPOTIFY_MCP_EXPORT_DIR: join(root, 'exports'),
    SPOTIFY_MCP_TASKS_DIR: join(root, 'tasks'),
  };
  return { root, env };
}

function io(answer = 'y'): { io: LogoutIo; output: () => string } {
  let buffer = '';
  return {
    io: { isInteractive: true, ask: async () => answer, write: (text) => (buffer += text) },
    output: () => buffer,
  };
}

function runIn(
  env: NodeJS.ProcessEnv,
  answer = 'y',
): Promise<{ code: number; output: string }> {
  const { io: seam, output } = io(answer);
  // `allowGioTrash: false` for the same reason tests/logout.test.ts does it: the
  // quarantine path is the one guaranteed available on tmpfs, and it is
  // reversible, so a test can never reach a real trash.
  return runLogout([], seam, { env, allowGioTrash: false }).then((code) => ({
    code,
    output: output(),
  }));
}

const exists = (path: string) => fs.stat(path).then(() => true, () => false);

/**
 * Put a directory at a `kind: 'file'` store path, holding content that could
 * not be mistaken for anything this server wrote.
 */
async function plantUserDataDirectory(storePath: string): Promise<string> {
  await fs.mkdir(join(storePath, 'my-saved-scenes'), { recursive: true });
  await fs.writeFile(
    join(storePath, 'my-saved-scenes', 'scene-1.json'),
    '{"name":"Sunday morning"}',
  );
  await fs.writeFile(join(storePath, 'personal-notes.txt'), 'USER DATA - not a cache');
  return storePath;
}

before(() => {
  // The safety property this file rests on: every store in the registry must be
  // redirected by an explicit env var, because a store with no override falls
  // back to the real `homedir()` — and the real `~/.spotify-mcp/backups/` is
  // user data. Fails before any test in this file can act on it.
  const box = sandbox();
  const realHome = ORIGINAL_HOME ?? homedir();
  assert.notEqual(box.root, realHome);
  assert.notEqual(box.home, realHome);
  for (const store of localStorePaths({ env: box.env })) {
    assert.notEqual(
      store.path,
      box.home,
      `${store.id} resolves to the sandbox home — give HOME a directory of its own (#1358)`,
    );
    assert.ok(
      store.path === box.root || store.path.startsWith(box.root + '/'),
      `${store.id} would resolve outside the sandbox (${store.path}) — add its env override to sandbox()`,
    );
  }
});

after(async () => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_CONFIRM === undefined) delete process.env.SPOTIFY_MCP_CONFIRM;
  else process.env.SPOTIFY_MCP_CONFIRM = ORIGINAL_CONFIRM;
  for (const path of created.reverse()) {
    await fs.rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('a file-kind store that is a directory (#1309)', () => {
  it('is refused, and the refusal names what is inside it', async () => {
    const { root, env } = sandbox();
    await plantUserDataDirectory(join(root, 'scenes.json'));

    const stores = localStorePaths({ env });
    const decisions = await planErasure(stores, { home: root });
    const decision = decisions.find((d) => d.store.id === 'scenes');
    assert.ok(decision, 'the scenes store must be in the plan');

    assert.equal(
      decision.action,
      'refuse',
      'a directory at a kind:"file" store path must never be planned for erasure',
    );
    assert.ok(decision.action === 'refuse');
    // The requirement from the issue title: named, not silently moved.
    assert.match(decision.reason, /is a directory/);
    assert.match(decision.reason, /personal-notes\.txt/);
    assert.match(decision.reason, /my-saved-scenes/);
  });

  it('survives a whole logout untouched, and logout does not claim success', async () => {
    const { root, env } = sandbox();
    const victim = await plantUserDataDirectory(join(root, 'scenes.json'));

    const { code, output } = await runIn(env);

    // Nothing moved, and the content is byte-identical.
    assert.equal(await exists(victim), true, 'the directory must still be on disk');
    assert.equal(
      await fs.readFile(join(victim, 'personal-notes.txt'), 'utf8'),
      'USER DATA - not a cache',
    );
    assert.equal(await exists(join(victim, 'my-saved-scenes', 'scene-1.json')), true);

    // Not claimed as erased, and not claimed as clean.
    assert.match(output, /scenes\s+REFUSED/);
    assert.doesNotMatch(output, /scenes\s+erased/);
    assert.ok(
      !/Local stores cleared/.test(output),
      'a refused store means logout is incomplete, so it must not print the all-clear',
    );
    assert.equal(code, 1, 'a refused store is a store still on disk, so logout exits non-zero');
  });

  it('names the contents in the report, not only in the plan', async () => {
    const { root, env } = sandbox();
    await plantUserDataDirectory(join(root, 'scenes.json'));

    const { output } = await runIn(env);

    // The report the user reads has to carry the names, not just the internal
    // decision object — a refusal printed without them is still under-reporting.
    assert.ok(
      output.includes('personal-notes.txt'),
      'the report must name the file inside the refused directory',
    );
    assert.ok(output.includes('my-saved-scenes'), 'the report must name the subdirectory');
  });

  it('does not print the all-clear beneath a refusal — for any kind of refusal', async () => {
    // The "stores cleared" line counted outcomes only, and a refused store never
    // produces one, so it printed the all-clear directly under a list of stores
    // that were not cleared. Pinned through the symlink refusal as well, so the
    // fix is not read as belonging to the kind check alone.
    const { root, env } = sandbox();
    const target = join(root, 'elsewhere.json');
    await fs.writeFile(target, '{}');
    await fs.symlink(target, join(root, 'scenes.json'));

    const { code, output } = await runIn(env);

    assert.match(output, /scenes\s+REFUSED/);
    assert.ok(
      !/Local stores cleared/.test(output),
      'a refused store is still on disk, so the summary must not claim otherwise',
    );
    assert.match(output, /Logout incomplete/);
    assert.equal(code, 1);
    assert.equal(await exists(target), true, 'a symlink target is never erased through the link');
  });

  it('refuses the credential store by kind, rather than failing on an open', async () => {
    const { root, env } = sandbox();
    await plantUserDataDirectory(join(root, 'tokens.json'));

    const stores = localStorePaths({ env });
    const decisions = await planErasure(stores, { home: root });
    const decision = decisions.find((d) => d.store.id === 'token');

    assert.ok(decision);
    assert.equal(decision.action, 'refuse');
    assert.ok(decision.action === 'refuse');
    // Not a raw EISDIR from `shredFile`. Either way the data survives, but the
    // operator is told the kind is wrong instead of being handed a syscall error.
    assert.match(decision.reason, /is a directory/);
    assert.doesNotMatch(decision.reason, /EISDIR/);
    assert.equal(await exists(join(root, 'tokens.json')), true);
  });

  it('leaves the other fifteen stores alone — one wrong path is not a global failure', async () => {
    const { root, env } = sandbox();
    // Distinct HOME, so the playlist-health store is not the home directory and
    // its own pre-existing refusal stays out of this assertion.
    const home = join(root, 'home');
    await fs.mkdir(home, { recursive: true });
    const env2 = { ...env, HOME: home };

    await plantUserDataDirectory(join(root, 'scenes.json'));
    // A real sidecar sitting beside it, so there is something that *should* go.
    await fs.writeFile(join(root, 'search-history.json'), '{"queries":["radiohead"]}');

    const stores = localStorePaths({ env: env2 });
    const decisions = await planErasure(stores, { home });
    const refused = decisions.filter((d) => d.action === 'refuse');

    assert.deepEqual(
      refused.map((d) => d.store.id),
      ['scenes'],
      'exactly the one wrong-kind store is refused',
    );
    const search = decisions.find((d) => d.store.id === 'search-history');
    assert.equal(search?.action, 'erase');
  });
});

describe('positive controls — the ordinary shapes still erase', () => {
  it('erases a regular file at a file-kind store path, and names it', async () => {
    const { root, env } = sandbox();
    const file = join(root, 'scenes.json');
    await fs.writeFile(file, '{"scenes":[]}');

    const { code, output } = await runIn(env);

    assert.equal(await exists(file), false, 'a real file at a file-kind path must be erased');
    assert.match(output, /scenes\s+erased/);
    assert.ok(output.includes(file), 'the erased file is named');
    assert.ok(!/scenes\s+REFUSED/.test(output));
    // No refusal anywhere, so logout is entitled to its all-clear.
    assert.match(output, /Local stores cleared/);
    assert.equal(code, 0);
  });

  it('erases a real directory at a dir-kind store path, naming every file inside', async () => {
    const { root, env } = sandbox();
    const dir = join(root, 'backups');
    await fs.mkdir(join(dir, 'sub'), { recursive: true });
    await fs.writeFile(join(dir, 'sub', 'lib-1.json'), '{}');
    await fs.writeFile(join(dir, 'top.json'), '{}');

    const stores = localStorePaths({ env });
    const decisions = await planErasure(stores, { home: root });
    const backups = decisions.find((d) => d.store.id === 'backups');
    assert.equal(backups?.action, 'erase', 'a real directory must still be erased');

    const { code, output } = await runIn(env);
    assert.equal(await exists(dir), false);
    // Recursive: both the nested and the top-level file, which is the promise
    // docs/configuration.md makes for a moved directory.
    assert.ok(output.includes(join(dir, 'sub', 'lib-1.json')), 'nested file named');
    assert.ok(output.includes(join(dir, 'top.json')), 'top-level file named');
    assert.equal(code, 0);
  });

  it('refuses nothing when every store is the kind it is declared to be', async () => {
    const { root, env } = sandbox();
    // A distinct HOME: `SPOTIFY_MCP_DATA_DIR` is itself the playlist-health
    // snapshot directory, so with HOME === DATA_DIR that store resolves to the
    // home directory and `dangerousEraseTarget` refuses it. That refusal is
    // pre-existing and correct; it is not what this test is measuring.
    const home = join(root, 'home');
    await fs.mkdir(home, { recursive: true });
    const env2 = { ...env, HOME: home };

    await fs.writeFile(join(root, 'scenes.json'), '{}');
    await fs.mkdir(join(root, 'backups'), { recursive: true });
    await fs.writeFile(join(root, 'backups', 'lib.json'), '{}');
    await fs.writeFile(join(root, 'search-history.json'), '{}');
    await fs.writeFile(join(root, 'tokens.json'), '{"accessToken":"x"}');

    const stores = localStorePaths({ env: env2 });
    const decisions = await planErasure(stores, { home });

    assert.deepEqual(
      decisions.filter((d) => d.action === 'refuse').map((d) => d.store.id),
      [],
      'a sandbox of correct shapes must produce no refusals at all',
    );
  });
});

describe('a dir-kind store that is a regular file', () => {
  it('is still erased, but is now named — the report under-named it (#1309)', async () => {
    const { root, env } = sandbox();
    const file = join(root, 'backups');
    await fs.writeFile(file, 'I am a file at a directory path');

    const stores = localStorePaths({ env });
    const decisions = await planErasure(stores, { home: root });
    const backups = decisions.find((d) => d.store.id === 'backups');
    // Erasing is right: this is the store's own path, it is a regular file, and
    // nothing is recursive. The defect was the report, not the erasure.
    assert.equal(backups?.action, 'erase');

    // Assert on the outcome's own file list, not on the rendered text. The
    // report repeats the store path in its "About to erase" prompt and in the
    // quarantine destination, so `output.includes(path)` is satisfied even when
    // the erased-files list is empty — which is precisely the regression, and
    // precisely how a first cut of this test passed against unfixed source.
    const outcome = await eraseStore(backups!.store, {
      stamp: 'kind',
      allowGioTrash: false,
    });
    assert.equal(outcome.status, 'erased');
    assert.deepEqual(
      outcome.files,
      [file],
      'a moved path must be named; `enumerateFiles` on a regular file is [], so this used to report no files at all',
    );
  });

  it('lists the moved file in the report, not just in the outcome', async () => {
    const { root, env } = sandbox();
    const file = join(root, 'backups');
    await fs.writeFile(file, 'I am a file at a directory path');

    const { output } = await runIn(env);

    assert.equal(await exists(file), false);
    // The erased-files list is rendered as an indented continuation line, which
    // is what distinguishes it from the "About to erase" prompt above it.
    assert.ok(
      output.includes(`\n      ${file}`),
      `the report must list the moved file under the erased store, not only in the confirmation prompt:\n${output}`,
    );
  });
});
