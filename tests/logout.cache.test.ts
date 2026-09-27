/**
 * `logout` must erase the persisted read cache, for every profile (#1300).
 *
 * Two properties are load-bearing here, and they are different:
 *
 * 1. The cache file is erased at all. #1296 registered `cache.json.pending` and
 *    not `cache.json`, so a command whose documented job is "erase every local
 *    store it can find" reported success while leaving the account-derived
 *    cache on disk.
 * 2. EVERY profile's cache is erased. The cache is named after the account
 *    (#1249), so a machine with profiles has several files and only the active
 *    one can be named without enumerating. A fix that hardcodes the default
 *    `cache.json` looks complete — the default-account test passes, the report
 *    still looks right — and leaves `cache.<profile>.json` behind.
 *
 * So no filename is typed anywhere in this file. The cache files are created by
 * the production writer ({@link savePersistedCache}), and the assertions are made
 * against the paths it reports. A logout that erased a hardcoded `cache.json`
 * would fail on the second profile for a reason that has nothing to do with the
 * spelling of the name: the file it never looked for is still there.
 *
 * Every test runs against a fresh `mkdtemp` root with `HOME` pinned to it, so a
 * store with no env override of its own lands in the sandbox. Nothing here may
 * touch the developer's real `~/.spotify-mcp`.
 */

import './helpers/hermetic.js';

import { REAL_HOME } from './helpers/hermetic.js';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { cachePersistPath, savePersistedCache } from '../src/cachepersist.js';
import { localStorePaths, runLogout, type LocalStore, type LogoutIo } from '../src/logout.js';

const created: string[] = [];
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_CONFIRM = process.env.SPOTIFY_MCP_CONFIRM;

/**
 * A home directory with nothing in it but `.spotify-mcp/`, and an env that says
 * only `HOME` — no store overrides at all. That is the production layout, where
 * every default is `join(homedir(), '.spotify-mcp', …)`; a sandbox wired with
 * per-store variables would test the override path and never the real one.
 */
function sandbox(): { root: string; env: NodeJS.ProcessEnv } {
  const root = join(tmpdir(), `spotify-mcp-logout-cache-${randomUUID()}`);
  mkdirSync(join(root, '.spotify-mcp'), { recursive: true, mode: 0o700 });
  created.push(root);
  return { root, env: { HOME: root, USERPROFILE: root } };
}

/**
 * Point `os.homedir()` at `root` for the duration of `fn`.
 *
 * The store resolvers call `homedir()` directly, so an `env` object handed to
 * logout is not enough on its own: without this, every store with no override of
 * its own would resolve under the hermetic root instead of the sandbox and the
 * containment assertions below would be testing the wrong directory.
 */
async function withHome<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** A token file as `auth` would leave it, so the profile is discoverable. */
async function seedToken(root: string, profile: string | null): Promise<string> {
  const path = join(
    root,
    '.spotify-mcp',
    profile === null ? 'tokens.json' : `tokens.${profile}.json`,
  );
  await fs.writeFile(
    path,
    JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_at: 1 }),
    { mode: 0o600 },
  );
  return path;
}

/** Create the cache the way the server does, and return the path it wrote. */
async function writeCache(root: string, profile: string | null): Promise<string> {
  const env: NodeJS.ProcessEnv = { HOME: root, SPOTIFY_MCP_CACHE_PERSIST: '1' };
  if (profile !== null) env.SPOTIFY_MCP_PROFILE = profile;
  const file = cachePersistPath(env);
  await savePersistedCache(
    [{ key: 'GET /tracks/tr1', value: { id: 'tr1' }, expiresAt: Date.now() + 60_000 }],
    {},
    env,
  );
  await fs.writeFile(`${file}.pending`, JSON.stringify({ pid: 1, count: 1 }), {
    mode: 0o600,
  });
  return file;
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

function cacheStores(stores: LocalStore[]): LocalStore[] {
  return stores.filter((s) => s.id === 'cache' || s.id.startsWith('cache:'));
}

before(() => {
  // logout's confirmation gate has exactly one bypass and it is read from the
  // ambient process env, so an inherited SPOTIFY_MCP_CONFIRM=never would make
  // every run here non-interactive and the confirmation path untested.
  delete process.env.SPOTIFY_MCP_CONFIRM;
});

after(async () => {
  for (const [key, value] of [
    ['HOME', ORIGINAL_HOME],
    ['USERPROFILE', ORIGINAL_USERPROFILE],
    ['SPOTIFY_MCP_CONFIRM', ORIGINAL_CONFIRM],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const path of created.reverse()) {
    await fs.rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('logout and the persisted read cache (#1300)', () => {
  it('erases the cache file the writer produced, and names it in the report', async () => {
    const { root, env } = sandbox();
    await withHome(root, async () => {
      await seedToken(root, null);
      const cache = await writeCache(root, null);
      // Precondition: this is a real cache file, at the path the server chose.
      assert.ok((await fs.readFile(cache, 'utf8')).includes('tr1'));

      const { io: seam, output } = io();
      const code = await runLogout([], seam, { env, allowGioTrash: false });
      const text = output();

      assert.equal(code, 0, text);
      await assert.rejects(fs.lstat(cache), /ENOENT/, 'the read cache survived logout');
      assert.ok(text.includes(cache), `the report must name ${cache}`);
      assert.match(text, /Local stores cleared/);
      // The marker beside it was already covered by #1296; a cache fix that
      // dropped it from the registry would be a regression, not a cleanup.
      await assert.rejects(fs.lstat(`${cache}.pending`), /ENOENT/);
    });
  });

  it("erases every profile's cache, not only the active account's", async () => {
    // The failure this pins: a logout that hardcodes the default `cache.json`
    // passes the test above, still reports "Local stores cleared", and leaves
    // `cache.<profile>.json` on disk. #1249 made the cache per-account precisely
    // so one session cannot serve another account's reads; the erase has to be
    // per-account for the same reason.
    const { root, env } = sandbox();
    await withHome(root, async () => {
      await seedToken(root, null);
      await seedToken(root, 'work');
      await seedToken(root, 'personal');
      const written = [
        await writeCache(root, null),
        await writeCache(root, 'work'),
        await writeCache(root, 'personal'),
      ];
      assert.equal(new Set(written).size, 3, 'precondition: three distinct cache files');

      const { io: seam, output } = io();
      const code = await runLogout([], seam, { env, allowGioTrash: false });
      const text = output();

      assert.equal(code, 0, text);
      for (const file of written) {
        await assert.rejects(fs.lstat(file), /ENOENT/, `${file} survived logout`);
        assert.ok(text.includes(file), `the report must name ${file}`);
      }
    });
  });

  it('erases a profile cache even when a different profile is being logged out', async () => {
    // `--profile` selects which TOKEN file is erased; the shared sidecars are
    // erased either way, so scoping the caches to the named profile would be
    // inconsistent with every other store on the list. Both files must go, and
    // the report must say so.
    const { root, env } = sandbox();
    await withHome(root, async () => {
      await seedToken(root, null);
      await seedToken(root, 'work');
      const defaultCache = await writeCache(root, null);
      const workCache = await writeCache(root, 'work');

      const { io: seam, output } = io();
      const code = await runLogout(['--profile', 'work'], seam, { env, allowGioTrash: false });
      const text = output();

      assert.equal(code, 0, text);
      for (const file of [defaultCache, workCache]) {
        await assert.rejects(fs.lstat(file), /ENOENT/, `${file} survived logout`);
        assert.ok(text.includes(file), `the report must name ${file}`);
      }
    });
  });

  it('enumerates the cache files the writer would create, and nothing else', async () => {
    // The registry is compared against the writer, not against a list of names.
    // A hand-typed filename in `logout.ts` agrees with this only for as long as
    // `cacheFileNameFor` keeps producing the same shape; the moment it stops,
    // this fails instead of logout quietly stopping to erase the file.
    const { root, env } = sandbox();
    await withHome(root, async () => {
      await seedToken(root, null);
      await seedToken(root, 'work');
      const written = [await writeCache(root, null), await writeCache(root, 'work')];

      const paths = cacheStores(localStorePaths({ env })).map((s) => s.path);
      assert.deepEqual([...paths].sort(), [...written].sort());
    });
  });

  it('gives every cache file its own store id', async () => {
    // `planErasure` keeps one real path per store id in a Map. Two cache files
    // sharing an id would make the second overwrite the first, and the
    // containment check downstream would then be comparing against the wrong
    // path — a store would be kept or erased for a reason that belongs to a
    // different file. Unique ids are what make the extra stores safe to add.
    const { root, env } = sandbox();
    await withHome(root, async () => {
      await seedToken(root, null);
      await seedToken(root, 'work');
      await writeCache(root, null);
      await writeCache(root, 'work');

      const ids = localStorePaths({ env }).map((s) => s.id);
      assert.equal(new Set(ids).size, ids.length, `duplicate store ids: ${ids.join(', ')}`);
    });
  });

  it('moves the cache rather than overwriting it, like every non-credential store', async () => {
    // The token file is shredded because it holds a live refresh token. The
    // cache holds no credential, and a store the user may want back should stay
    // recoverable in the trash.
    const { root, env } = sandbox();
    await withHome(root, async () => {
      const stores = cacheStores(localStorePaths({ env }));
      assert.ok(stores.length > 0, 'no cache store in the registry');
      for (const store of stores) {
        assert.equal(store.erasure, 'move', `${store.id} must be reversible`);
        assert.equal(store.kind, 'file', `${store.id} is a single file`);
      }
    });
  });

  it('refuses a symlinked cache instead of erasing through the link', async () => {
    // The new store has to go through the same refusal rules as the other
    // sixteen. A cache file is attacker-reachable in the sense that any process
    // running as the user can put one there, so the containment and symlink
    // checks must apply to it, not just to the stores that were there first.
    const { root, env } = sandbox();
    await withHome(root, async () => {
      await seedToken(root, null);
      const cache = await writeCache(root, null);
      const victim = join(root, 'precious.txt');
      await fs.writeFile(victim, 'do not delete me', { mode: 0o600 });
      await fs.rm(cache);
      await fs.symlink(victim, cache);

      const { io: seam, output } = io();
      const code = await runLogout([], seam, { env, allowGioTrash: false });
      const text = output();

      assert.equal(code, 1, 'a refused store is still on disk, so the exit must not be 0');
      assert.match(text, /REFUSED/);
      assert.match(text, /symlink/);
      assert.equal(await fs.readFile(victim, 'utf8'), 'do not delete me');
    });
  });

  it('exits 0 on a machine with no cache at all', async () => {
    // Enumerating means reading a directory, and a missing one must not turn
    // logout into a failure — a first run on a fresh install has no token files
    // to enumerate and must still report success.
    const { root, env } = sandbox();
    await withHome(root, async () => {
      const stores = cacheStores(localStorePaths({ env }));
      assert.equal(stores.length, 1, 'the active cache is named even with no token file');

      const { io: seam, output } = io();
      const code = await runLogout([], seam, { env, allowGioTrash: false });
      assert.equal(code, 0, output());
      assert.match(output(), /absent/);
    });
  });

  it('resolves every store inside the sandbox, never under a real home', async () => {
    // The same guard `logout.test.ts` puts on its own sandbox, re-stated for a
    // sandbox with no per-store overrides at all — the one where a store that
    // forgot to consult `homedir()` would reach the developer's own files.
    const { root, env } = sandbox();
    await withHome(root, async () => {
      // REAL_HOME, not homedir(): withHome has just made homedir() the sandbox,
      // so comparing the two would only prove the assignment worked.
      assert.notEqual(root, REAL_HOME);
      for (const store of localStorePaths({ env })) {
        assert.ok(
          store.path === root || store.path.startsWith(root + '/'),
          `${store.id} would resolve outside the sandbox (${store.path})`,
        );
      }
    });
  });
});
