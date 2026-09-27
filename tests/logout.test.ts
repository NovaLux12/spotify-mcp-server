/**
 * `spotify-mcp logout` — the disconnect path that did not exist before #704.
 *
 * Every test here runs against a fresh `mkdtemp` directory and points every
 * store env var at it. Nothing in this file may resolve a real store path: the
 * developer's own `~/.spotify-mcp/tokens.json` and `search-history.json` are
 * user data, and a test that deletes them is a bug with a green tick.
 *
 * The tests drive `runLogout` with an injected IO seam and `allowGioTrash:
 * false`, because the quarantine fallback is the path that has to work on
 * tmpfs (where `gio trash` refuses outright) and it is the only reversible
 * mechanism guaranteed to be available.
 */

import './helpers/hermetic.js';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  LogoutUsageError,
  localStorePaths,
  parseLogoutArgs,
  planErasure,
  renderReport,
  runLogout,
  type LocalStore,
  type LogoutIo,
} from '../src/logout.js';
import { resolveTokenFile } from '../src/config.js';
import { snapshotDir as playlistHealthSnapshotDir } from '../src/tools/playlisthealth.js';

const created: string[] = [];
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CONFIRM = process.env.SPOTIFY_MCP_CONFIRM;

/** A throwaway data dir wired into every store override logout knows about. */
function sandbox(): { root: string; env: NodeJS.ProcessEnv } {
  const root = join(tmpdir(), `spotify-mcp-logout-${randomUUID()}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  created.push(root);
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    SPOTIFY_MCP_DATA_DIR: root,
    SPOTIFY_MCP_TOKEN_FILE: join(root, 'tokens.json'),
    SPOTIFY_MCP_HISTORY_DIR: join(root, 'history'),
    SPOTIFY_MCP_RECEIPTS_DIR: join(root, 'receipts'),
    SPOTIFY_MCP_SCENES_FILE: join(root, 'scenes.json'),
    SPOTIFY_MCP_GENRE_TAGS_FILE: join(root, 'genre-tags.json'),
    SPOTIFY_MCP_PLAYBACKEXT_FILE: join(root, 'playback-ext.json'),
    SPOTIFY_MCP_SEARCH_HISTORY_FILE: join(root, 'search-history.json'),
    SPOTIFY_MCP_FRESHNESS_STATE: join(root, 'freshness.json'),
    SPOTIFY_MCP_EXHAUST2_MISC_FILE: join(root, 'exhaust2-misc.json'),
    SPOTIFY_MCP_EXHAUST2_PLAYBACK_FILE: join(root, 'exhaust2-playback.json'),
    SPOTIFY_MCP_BACKUP_DIR: join(root, 'backups'),
    SPOTIFY_MCP_SNAPSHOT_DIR: join(root, 'snapshots'),
    SPOTIFY_MCP_PORTABILITY_DIR: join(root, 'portability'),
    SPOTIFY_MCP_EXPORT_DIR: join(root, 'exports'),
  };
  return { root, env };
}

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

/** A home directory that is not any sandbox, for tests that need the rule quiet. */
function elsewhereHome(): string {
  const dir = join(tmpdir(), `spotify-mcp-logout-home-${randomUUID()}`);
  created.push(dir);
  return dir;
}

function runIn(
  args: string[],
  env: NodeJS.ProcessEnv,
  answer = 'y',
  cwd?: string,
): Promise<{ code: number; output: string }> {
  const { io: ioSeam, output } = io(answer);
  return runLogout(args, ioSeam, { env, cwd, allowGioTrash: false }).then((code) => ({
    code,
    output: output(),
  }));
}

before(async () => {
  // The safety property this whole file rests on: every store in the registry
  // must be redirected by an explicit env var in the sandbox, because a store
  // with no override falls back to the real `homedir()`. If someone adds a
  // store to the registry and forgets its sandbox override, this fails before
  // a test can act on the developer's own tokens.json.
  const box = sandbox();
  const realHome = ORIGINAL_HOME ?? homedir();
  assert.notEqual(box.root, realHome);
  for (const store of localStorePaths({ env: box.env })) {
    // Equality is allowed: SPOTIFY_MCP_DATA_DIR is itself the playlist-health
    // snapshot directory, so that store resolves to the sandbox root. planErasure
    // refuses it (it holds the other stores), which is tested separately below.
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

describe('localStorePaths', () => {
  it('resolves the token path through config.ts, not a retyped string', () => {
    const env = sandbox().env;
    const stores = localStorePaths({ env });
    const token = stores.find((s) => s.id === 'token');
    assert.ok(token);
    assert.equal(token!.path, resolveTokenFile(env));
  });

  it('places every store under the sandbox root, never under the real home', () => {
    const box = sandbox();
    for (const store of localStorePaths({ env: box.env })) {
      assert.ok(
        store.path.startsWith(box.root + '/') || store.path === box.root,
        `${store.id} escaped the sandbox: ${store.path}`,
      );
    }
  });

  it('honours --profile through the same resolver auth uses', () => {
    const box = sandbox();
    // No explicit token file, so the profile is what selects the file. The
    // fallback reads homedir(), so HOME is pinned for the duration.
    const env = { ...box.env };
    delete env.SPOTIFY_MCP_TOKEN_FILE;
    const restore = process.env.HOME;
    process.env.HOME = box.root;
    try {
      const stores = localStorePaths({ env, profile: 'work' });
      const token = stores.find((s) => s.id === 'token');
      assert.ok(token!.path.startsWith(box.root + '/'), token!.path);
      assert.ok(token!.path.endsWith('tokens.work.json'), token!.path);
    } finally {
      if (restore === undefined) delete process.env.HOME;
      else process.env.HOME = restore;
    }
  });

  it('an explicit SPOTIFY_MCP_TOKEN_FILE outranks --profile', () => {
    const box = sandbox();
    const token = localStorePaths({ env: box.env, profile: 'work' }).find(
      (s) => s.id === 'token',
    );
    // This is resolveTokenFile's precedence, and logout must not invent its own:
    // pointing logout at a different file than the server reads would be a
    // logout that leaves the live token on disk.
    assert.equal(token!.path, box.env.SPOTIFY_MCP_TOKEN_FILE);
  });

  it('marks only the token store as overwritten rather than moved', () => {
    const stores = localStorePaths({ env: sandbox().env });
    const shredding = stores.filter((s) => s.erasure === 'shred');
    assert.deepEqual(shredding.map((s) => s.id), ['token']);
  });

  it('covers the stores issue #704 names', () => {
    const ids = new Set(localStorePaths({ env: sandbox().env }).map((s) => s.id));
    for (const expected of [
      'token',
      'mutations',
      'receipts',
      'backups',
      'playlist-snapshots',
      'portability',
      'scenes',
      'genre-tags',
      'playback-extensions',
      'search-history',
      'freshness',
      'artist-watchlist',
    ]) {
      assert.ok(ids.has(expected), `registry is missing ${expected}`);
    }
  });

  it('covers the pending-save marker the persisted cache writes (#1279)', () => {
    // `logout` promises to erase every store this build can write. The
    // `cache.json.pending` marker is a file this build now writes, so leaving
    // it out would mean logout reported success while a file it created
    // survived.
    //
    // Matched by prefix, not by equality: the marker `expand`s like the cache
    // store does (#1356), so its id carries the file name. This sandbox has one
    // profile, so exactly one store comes back.
    const box = sandbox();
    const store = localStorePaths({ env: box.env }).find((s) =>
      s.id.startsWith('cache-pending-marker'),
    );
    assert.ok(store, 'the pending-save marker is not in the logout registry');
    assert.equal(
      store.erasure,
      'move',
      'the marker is reversible local state, not a credential; it moves to the trash like every other sidecar',
    );
    assert.ok(
      store.path.endsWith('.pending'),
      `the marker path must resolve to the marker itself, not the cache file it describes (got ${store.path})`,
    );
  });
});

describe('store resolvers do not read ambient process state', () => {
  it('uses the env it was handed, not process.env', () => {
    // playlisthealth's snapshot resolver consults getConfig(), which lazily
    // caches from process.env for the life of the process. A resolver whose
    // result is used to erase files must be answerable from the env its caller
    // passed. This pins the env-driven half of that; the config branch itself
    // is currently unreachable because the `dataDir` config field does not
    // exist yet (#711), so it cannot be mutation-tested here.
    const box = sandbox();
    const resolved = playlistHealthSnapshotDir({ SPOTIFY_MCP_DATA_DIR: box.root });
    assert.equal(resolved, box.root);
    // Same value as the real env's, so this also guards the fall-through.
    assert.equal(
      playlistHealthSnapshotDir(box.env),
      playlistHealthSnapshotDir({ SPOTIFY_MCP_DATA_DIR: box.root }),
    );
  });
});

describe('planErasure', () => {
  it('refuses a store whose file is a symlink pointing outside its root', async () => {
    const box = sandbox();
    const outside = join(box.root, 'outside.json');
    await fs.writeFile(outside, 'secret', { mode: 0o600 });
    const storePath = join(box.root, 'scenes.json');
    await fs.symlink(outside, storePath);

    const stores = localStorePaths({ env: box.env });
    const decisions = await planErasure(stores, { home: box.root });
    const scenes = decisions.find((d) => d.store.id === 'scenes');

    assert.equal(scenes?.action, 'refuse');
    assert.match(String(scenes?.reason), /symlink/);
    // The refusal is the whole point: the link's target must survive intact.
    assert.equal(await fs.readFile(outside, 'utf8'), 'secret');
  });

  it('refuses a store that resolves outside its own store directory', async () => {
    // The #623 shape: the configured path *string* sits under the store's own
    // directory, but a symlinked parent means the real path is somewhere else
    // entirely. A check run on the raw string would pass this and delete the
    // wrong tree, so containment is decided on the real path.
    const box = sandbox();
    const realRoot = join(box.root, 'real-root');
    await fs.mkdir(realRoot, { recursive: true });

    const escapeRoot = await fs.mkdtemp(join(tmpdir(), 'spotify-mcp-logout-escape-'));
    created.push(escapeRoot);
    const victim = join(escapeRoot, 'precious.json');
    await fs.writeFile(victim, 'do not delete me', { mode: 0o600 });

    const linked = join(realRoot, 'linked');
    await fs.symlink(escapeRoot, linked);

    const store: LocalStore = {
      id: 'scenes',
      label: 'Scenes',
      kind: 'file',
      path: join(linked, 'precious.json'),
      root: realRoot,
      erasure: 'move',
      envVar: 'SPOTIFY_MCP_SCENES_FILE',
    };
    // The literal path is inside the root...
    assert.ok(store.path.startsWith(realRoot + '/'));
    // ...and the real path is not.
    assert.ok(!(await fs.realpath(store.path)).startsWith(await fs.realpath(realRoot) + '/'));

    const decisions = await planErasure([store], { home: elsewhereHome() });
    assert.equal(decisions[0]?.action, 'refuse');
    assert.match(String(decisions[0]?.reason), /outside its own store directory/);
    assert.equal(await fs.readFile(victim, 'utf8'), 'do not delete me');
  });

  it('refuses a store that resolves to the home directory', async () => {
    const home = await fs.mkdtemp(join(tmpdir(), 'spotify-mcp-logout-home-'));
    created.push(home);
    const store: LocalStore = {
      id: 'exports',
      label: 'Exports',
      kind: 'dir',
      path: home,
      root: home,
      erasure: 'move',
      envVar: 'SPOTIFY_MCP_EXPORT_DIR',
    };
    const decisions = await planErasure([store], { home });
    assert.equal(decisions[0]?.action, 'refuse');
    assert.match(String(decisions[0]?.reason), /home directory/);
    assert.ok(await fs.stat(home));
  });

  it('reports a missing store as absent rather than failing', async () => {
    const box = sandbox();
    const decisions = await planErasure(localStorePaths({ env: box.env }), {
      home: elsewhereHome(),
    });
    // Everything is missing except the data directory, which exists (it is the
    // sandbox itself) and is the playlist-health store's container.
    assert.ok(
      decisions.every((d) => d.action === 'absent' || d.action === 'keep'),
      decisions.filter((d) => d.action !== 'absent' && d.action !== 'keep').map(String).join('\n'),
    );
    assert.equal(
      decisions.find((d) => d.store.id === 'playlist-health-snapshots')?.action,
      'keep',
    );
  });

  it('keeps backups when --keep-backups is set', async () => {
    const box = sandbox();
    await fs.mkdir(join(box.root, 'backups'), { recursive: true });
    const decisions = await planErasure(localStorePaths({ env: box.env }), {
      home: box.root,
      keepBackups: true,
    });
    const backups = decisions.find((d) => d.store.id === 'backups');
    assert.equal(backups?.action, 'keep');
  });

  it('refuses a directory store that is the parent of every other store', async () => {
    // SPOTIFY_MCP_DATA_DIR *is* the playlist-health snapshot directory, so with
    // that variable set that store resolves to the data directory holding every
    // other store. Erasing it would take the lot — the precise "a half-logout
    // that still leaves live state" outcome #704 is about, in the other
    // direction.
    const box = sandbox();
    for (const rel of ['tokens.json', 'search-history.json']) {
      await fs.writeFile(join(box.root, rel), '{}', { mode: 0o600 });
    }
    await fs.mkdir(join(box.root, 'backups'), { recursive: true });

    const stores = localStorePaths({ env: box.env });
    const health = stores.find((s) => s.id === 'playlist-health-snapshots');
    assert.equal(health?.path, box.root, 'precondition: the store is the data dir');

    // `home` is deliberately not box.root: with home pointing there the
    // home-directory rule would fire first and this test would prove nothing
    // about the containment rule it exists to cover.
    const decisions = await planErasure(stores, { home: elsewhereHome() });
    const decision = decisions.find((d) => d.store.id === 'playlist-health-snapshots');
    assert.equal(decision?.action, 'keep');
    assert.match(String(decision?.reason), /data directory itself/);

    // And the stores inside it are still erased individually.
    assert.equal(decisions.find((d) => d.store.id === 'token')?.action, 'erase');
    assert.equal(decisions.find((d) => d.store.id === 'search-history')?.action, 'erase');
  });
});

describe('runLogout', () => {
  it('erases the seeded stores and names every removed file', async () => {
    const box = sandbox();
    const tokenPath = join(box.root, 'tokens.json');
    const historyPath = join(box.root, 'history', 'mutations.jsonl');
    const receiptsPath = join(box.root, 'receipts', 'receipts.jsonl');
    const searchPath = join(box.root, 'search-history.json');
    const backupPath = join(box.root, 'backups', '2026-09-01.json');

    for (const [p, body] of [
      [tokenPath, '{"refresh_token":"rt-secret"}'],
      [historyPath, '{}\n'],
      [receiptsPath, '{}\n'],
      [searchPath, '{"queries":[]}'],
      [backupPath, '{"items":[]}'],
    ] as const) {
      await fs.mkdir(join(p, '..'), { recursive: true });
      await fs.writeFile(p, body, { mode: 0o600 });
    }

    const { code, output } = await runIn([], box.env);
    assert.equal(code, 0, output);

    for (const p of [tokenPath, historyPath, receiptsPath, searchPath]) {
      await assert.rejects(fs.lstat(p), /ENOENT/, `${p} should be gone`);
    }
    // The backup directory moved wholesale rather than being emptied piecemeal,
    // so its contents travel with it into the quarantine.
    await assert.rejects(fs.lstat(join(box.root, 'backups')), /ENOENT/);
    const quarantine = (await fs.readdir(box.root)).find((n) =>
      n.startsWith('.spotify-mcp-logout-quarantine-'),
    );
    assert.ok(quarantine, 'the backup directory should have been quarantined');
    assert.ok(
      await fs.stat(join(box.root, quarantine, 'backups', '2026-09-01.json')),
      'backup contents must travel with the directory',
    );

    // Every removed path is named, so the report can be checked against the disk.
    assert.ok(output.includes(searchPath), `report must name ${searchPath}`);
    // A moved directory is reported at its destination, so the file inside is
    // named relative to the quarantine rather than at the original path.
    assert.ok(
      output.includes(`backups/${basename(backupPath)}`),
      'report must name the backup file that was moved',
    );
    assert.match(output, /Local stores cleared/);
  });

  it('leaves no readable refresh token behind', async () => {
    const box = sandbox();
    const tokenPath = join(box.root, 'tokens.json');
    await fs.writeFile(tokenPath, '{"refresh_token":"rt-live-secret"}', { mode: 0o600 });

    const { code, output } = await runIn([], box.env);
    assert.equal(code, 0, output);
    await assert.rejects(fs.lstat(tokenPath), /ENOENT/);

    // The token is shredded rather than quarantined: a live credential must
    // not be sitting in a trash directory waiting to be read.
    assert.ok(!output.includes('rt-live-secret'), 'the report must not echo the token');
    const quarantined: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else quarantined.push(full);
      }
    };
    for (const entry of await fs.readdir(box.root, { withFileTypes: true })) {
      if (entry.name.startsWith('.spotify-mcp-logout-quarantine-')) {
        await walk(join(box.root, entry.name));
      }
    }
    for (const file of quarantined) {
      const body = await fs.readFile(file, 'utf8');
      assert.ok(!body.includes('rt-live-secret'), `refresh token survived in ${file}`);
    }
  });

  it('refuses and does not delete when a store symlinks out of its root', async () => {
    const box = sandbox();
    const victim = join(box.root, 'precious.txt');
    await fs.writeFile(victim, 'do not delete me', { mode: 0o600 });
    await fs.symlink(victim, join(box.root, 'scenes.json'));

    const { code, output } = await runIn([], box.env);
    assert.equal(code, 1, 'a refusal must not exit 0');
    assert.match(output, /REFUSED/);
    assert.match(output, /symlink/);
    assert.equal(await fs.readFile(victim, 'utf8'), 'do not delete me');
  });

  it('dry-run lists the stores and erases nothing', async () => {
    const box = sandbox();
    const tokenPath = join(box.root, 'tokens.json');
    await fs.writeFile(tokenPath, '{"refresh_token":"rt"}', { mode: 0o600 });

    const { code, output } = await runIn(['--dry-run'], box.env, 'n');
    assert.equal(code, 0);
    assert.match(output, /Dry run/);
    assert.match(output, new RegExp(tokenPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(await fs.readFile(tokenPath, 'utf8'), '{"refresh_token":"rt"}');
  });

  it('refuses to erase when the answer is not yes, changing nothing', async () => {
    const box = sandbox();
    const tokenPath = join(box.root, 'tokens.json');
    await fs.writeFile(tokenPath, '{"refresh_token":"rt"}', { mode: 0o600 });

    const { code, output } = await runIn([], box.env, 'n');
    assert.equal(code, 1);
    assert.match(output, /Cancelled/);
    assert.ok(await fs.stat(tokenPath));
  });

  it('refuses to erase when there is no terminal to ask', async () => {
    const box = sandbox();
    const tokenPath = join(box.root, 'tokens.json');
    await fs.writeFile(tokenPath, '{"refresh_token":"rt"}', { mode: 0o600 });

    let output = '';
    const code = await runLogout(
      [],
      {
        isInteractive: false,
        ask: async () => {
          throw new Error('must not prompt a non-interactive caller');
        },
        write: (text) => {
          output += text;
        },
      },
      { env: box.env, allowGioTrash: false },
    );
    assert.equal(code, 1);
    assert.match(output, /Confirmation is unavailable/);
    assert.ok(await fs.stat(tokenPath));
  });

  it('SPOTIFY_MCP_CONFIRM=never is the only bypass, and it still erases', async () => {
    const box = sandbox();
    const tokenPath = join(box.root, 'tokens.json');
    await fs.writeFile(tokenPath, '{"refresh_token":"rt"}', { mode: 0o600 });
    process.env.SPOTIFY_MCP_CONFIRM = 'never';
    try {
      let output = '';
      const code = await runLogout(
        [],
        {
          isInteractive: false,
          ask: async () => 'n',
          write: (text) => {
            output += text;
          },
        },
        { env: box.env, allowGioTrash: false },
      );
      assert.equal(code, 0, output);
      await assert.rejects(fs.lstat(tokenPath), /ENOENT/);
    } finally {
      delete process.env.SPOTIFY_MCP_CONFIRM;
    }
  });

  it('always prints the manual revocation address, last', async () => {
    const box = sandbox();
    const { output } = await runIn([], box.env);
    // Pinned on the final line, not merely "somewhere in the output": the
    // address in the header is easy to leave in place while dropping the
    // closing instruction, and the closing instruction is the one a user acts on.
    const lastLine = output.trimEnd().split('\n').pop();
    assert.equal(lastLine, 'Revoke the Spotify access token at https://www.spotify.com/account/apps/');
  });

  it('prints the revocation address in the dry run too', async () => {
    const box = sandbox();
    const { output } = await runIn(['--dry-run'], box.env, 'n');
    assert.match(output, /https:\/\/www\.spotify\.com\/account\/apps\//);
  });

  it('rejects an unknown flag instead of ignoring it', async () => {
    const { code, output } = await runIn(['--force'], sandbox().env);
    assert.equal(code, 2);
    assert.match(output, /unknown argument: --force/);
  });

  it('--keep-backups leaves the backup library on disk', async () => {
    const box = sandbox();
    const backupPath = join(box.root, 'backups', 'library.json');
    await fs.mkdir(join(box.root, 'backups'), { recursive: true });
    await fs.writeFile(backupPath, '{"items":[]}');

    const { code, output } = await runIn(['--keep-backups'], box.env);
    assert.equal(code, 0, output);
    assert.match(output, /kept/);
    assert.equal(await fs.readFile(backupPath, 'utf8'), '{"items":[]}');
  });
});

describe('parseLogoutArgs', () => {
  it('accepts the documented flags', () => {
    assert.deepEqual(parseLogoutArgs(['--dry-run', '--keep-backups', '--profile', 'work']), {
      dryRun: true,
      keepBackups: true,
      profile: 'work',
    });
  });

  it('accepts --profile=<name>', () => {
    assert.equal(parseLogoutArgs(['--profile=work']).profile, 'work');
  });

  it('rejects --profile with no value', () => {
    assert.throws(() => parseLogoutArgs(['--profile']), LogoutUsageError);
    assert.throws(() => parseLogoutArgs(['--profile', '--dry-run']), LogoutUsageError);
  });
});

describe('renderReport', () => {
  it('never reports success while a store is still on disk', () => {
    const store: LocalStore = {
      id: 'scenes',
      label: 'Scenes',
      kind: 'file',
      path: '/tmp/x/scenes.json',
      root: '/tmp/x',
      erasure: 'move',
      envVar: null,
    };
    const report = renderReport(
      [{ store, action: 'refuse', reason: 'is a symlink to /etc/passwd' }],
      [
        {
          store,
          status: 'refused',
          files: [store.path],
          reason: 'is a symlink to /etc/passwd',
        },
      ],
      { dryRun: false },
    );
    assert.match(report, /Logout incomplete/);
    assert.ok(!report.includes('Local stores cleared'));
  });
});
