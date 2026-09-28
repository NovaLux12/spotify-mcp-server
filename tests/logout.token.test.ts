/**
 * `logout` must shred EVERY profile's token file, not one of them (#1591).
 *
 * ## The failure this pins
 *
 * The credential store registered `resolve` and no `expand`, and
 * `resolveTokenFile` answers with ONE path — the active profile's. On a machine
 * holding `tokens.json` and `tokens.work.json`, plain `spotify-mcp logout`
 * therefore shredded the first, never named the second, printed "Local stores
 * cleared." and exited 0 with a live refresh token still on disk. That token is
 * not a leftover file: Spotify publishes no revocation endpoint, so nothing else
 * in this release can ever end that access.
 *
 * Every OTHER per-account store already enumerated across profiles — the
 * mutation ledger, the receipt trail, the read cache and its pending-save
 * marker — which is why the gap is so easy to miss and so expensive when it
 * happens. The store that holds a credential was the one that did not.
 *
 * ## Why this file is shaped the way it is
 *
 * A fix that hardcodes `tokens.work.json` would pass a test that types the two
 * names, and the moment a third profile appeared the same bug would be back.
 * So no token file NAME is written here: every file is created at the path
 * `tokenFilePathForProfile` produces for that profile — the same derivation
 * `auth` and the server use — and the assertions are made against the paths the
 * command reports. What is compared is the ENUMERATION, not the spelling.
 *
 * `import './helpers/hermetic.js'` comes first for the same reason everywhere
 * else: it redirects `HOME` before any server module is imported, so nothing
 * here can resolve a path under the developer's real `~/.spotify-mcp`.
 */

import './helpers/hermetic.js';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { tokenFilePathForProfile } from '../src/config.js';
import { localStorePaths, runLogout, type LocalStore, type LogoutIo } from '../src/logout.js';

const created: string[] = [];
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_CONFIRM = process.env.SPOTIFY_MCP_CONFIRM;

/**
 * A home directory with nothing in it but `.spotify-mcp/`, and an env that says
 * only `HOME` — no store overrides at all, so every default is the production
 * `join(homedir(), '.spotify-mcp', …)` rather than the override path. A sandbox
 * wired with per-store variables would never exercise the layout a real
 * multi-profile machine has.
 */
function sandbox(): { root: string; env: NodeJS.ProcessEnv } {
  const root = join(tmpdir(), `spotify-mcp-logout-token-${randomUUID()}`);
  mkdirSync(join(root, '.spotify-mcp'), { recursive: true, mode: 0o700 });
  created.push(root);
  return { root, env: { HOME: root, USERPROFILE: root } };
}

/**
 * Point `os.homedir()` at `root` for the duration of `fn`.
 *
 * The store resolvers call `homedir()` directly, so an `env` object handed to
 * logout is not enough on its own: without this, every store with no override
 * of its own would resolve under the hermetic root instead of the sandbox.
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

/** A refresh token this run must not leave readable anywhere under the sandbox. */
const REFRESH_SECRET = 'rt-should-not-survive-logout';

/** Write a token file the way `auth` would, at the path the server derives. */
async function seedToken(root: string, profile?: string): Promise<string> {
  const path = tokenFilePathForProfile(profile, { HOME: root, USERPROFILE: root });
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path,
    JSON.stringify({
      access_token: `at-${profile ?? 'default'}`,
      refresh_token: `${REFRESH_SECRET}-${profile ?? 'default'}`,
      expires_at: 1,
    }),
    { mode: 0o600 },
  );
  return path;
}

/** The token stores the registry resolved, base id `token`. */
function tokenStores(stores: LocalStore[]): LocalStore[] {
  return stores.filter((s) => s.id === 'token' || s.id.startsWith('token:'));
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

/** Every regular file under `root`, so "nothing readable survived" is checkable. */
async function filesUnder(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(full)));
    else out.push(full);
  }
  return out;
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

describe('logout erases the token file of EVERY profile (#1591)', () => {
  it('names every token file present, not only the one the active profile resolves', async () => {
    // The registry, before anything is erased. With only `resolve` this list
    // came back as one entry, and every later assertion in this file would
    // still have passed on a machine with one profile — which is the shape the
    // bug had: correct for the developer, wrong for the user.
    const { root, env } = sandbox();
    await withHome(root, async () => {
      const written = [await seedToken(root), await seedToken(root, 'work')];
      assert.equal(new Set(written).size, 2, 'precondition: two distinct token files');

      const named = tokenStores(localStorePaths({ env })).map((s) => s.path);
      assert.deepEqual(
        [...named].sort(),
        [...written].sort(),
        'logout does not name every token file, so the ones it misses are erased by nothing '
        + 'and named in no report',
      );
    });
  });

  it('shreds the token file of every profile, leaving no refresh token behind', async () => {
    // The end-to-end claim, and the one the user is actually relying on when
    // they run the command to disconnect. A file that is merely gone is the
    // weaker assertion: logout's whole point for this store is that the bytes
    // are not still readable, so the check is for the secret, not the inode.
    const { root, env } = sandbox();
    await withHome(root, async () => {
      const written = [await seedToken(root), await seedToken(root, 'work')];

      const { io: seam, output } = io();
      const code = await runLogout([], seam, { env, allowGioTrash: false });
      const text = output();

      assert.equal(code, 0, text);
      for (const path of written) {
        await assert.rejects(fs.lstat(path), /ENOENT/, `${path} survived logout`);
        assert.ok(text.includes(path), `the report must name ${path}`);
      }
      for (const file of await filesUnder(root)) {
        assert.ok(
          !(await fs.readFile(file, 'utf8')).includes(REFRESH_SECRET),
          `a readable refresh token survived in ${file}`,
        );
      }
      assert.match(text, /Local stores cleared/);
    });
  });

  it('names every token file in the confirmation prompt, before erasing anything', async () => {
    // The prompt is the only chance the user has to see what is about to go.
    // A profile's token file missing from it means the command is about to
    // destroy a credential the operator was never shown — the same silent
    // orphaning the report causes, one step earlier.
    const { root, env } = sandbox();
    await withHome(root, async () => {
      const written = [await seedToken(root), await seedToken(root, 'work')];

      const { io: seam, output } = io();
      await runLogout([], seam, { env, allowGioTrash: false });

      const prompt = output().split('About to erase:')[1]?.split('Proceed?')[0] ?? '';
      for (const path of written) {
        assert.ok(prompt.includes(path), `the confirmation prompt does not name ${path}`);
      }
    });
  });

  it('shreds every token file with --profile too, not only the one it selects', async () => {
    // `--profile` chooses which account the command is ACTING as. It is not a
    // scope selector — every other per-account store is erased across profiles
    // regardless of the flag — and the token file cannot be the exception to
    // that without putting the flag's own answer forward as a safe workaround.
    // The bug was not reachable through `--profile work` any more than through
    // the default run, so it must not be reachable now either.
    const { root, env } = sandbox();
    await withHome(root, async () => {
      const written = [await seedToken(root), await seedToken(root, 'work')];

      const { io: seam, output } = io();
      const code = await runLogout(['--profile', 'work'], seam, { env, allowGioTrash: false });
      const text = output();

      assert.equal(code, 0, text);
      for (const path of written) {
        await assert.rejects(fs.lstat(path), /ENOENT/, `${path} survived --profile logout`);
        assert.ok(text.includes(path), `the report must name ${path}`);
      }
    });
  });

  it('enumerates three profiles the same way, with no name typed anywhere', async () => {
    // Two is the shape the issue was reported in and is where a partial fix
    // hides: an enumeration that handled the second file and stopped. Three
    // comes from the same derivation, so this fails if the count is capped
    // rather than derived.
    const { root, env } = sandbox();
    await withHome(root, async () => {
      const written = [
        await seedToken(root),
        await seedToken(root, 'work'),
        await seedToken(root, 'personal'),
      ];

      const { io: seam, output } = io();
      const code = await runLogout([], seam, { env, allowGioTrash: false });

      assert.equal(code, 0, output());
      for (const path of written) {
        await assert.rejects(fs.lstat(path), /ENOENT/, `${path} survived logout`);
      }
    });
  });

  it('gives every token file its own store id', async () => {
    // `planErasure` keeps one real path per store id in a Map. Two token files
    // sharing an id would make the second overwrite the first, and every
    // containment check downstream would then be reasoning about the other
    // file — a store approved or refused for a reason that belongs to a
    // different credential. Unique ids are what make the extra stores safe.
    const { root, env } = sandbox();
    await withHome(root, async () => {
      await seedToken(root);
      await seedToken(root, 'work');

      const ids = localStorePaths({ env }).map((s) => s.id);
      assert.equal(new Set(ids).size, ids.length, `duplicate store ids: ${ids.join(', ')}`);
    });
  });

  it('shreds each token file rather than moving it', async () => {
    // Every other store is recoverable, and the report says how it was
    // removed. This one holds a live refresh token that Spotify will not let a
    // client revoke, so a copy in the trash — or in a quarantine directory
    // beside the original — is the failure, not the safety net. Asserted per
    // store rather than for the registry, because a fix that added the extra
    // token files with `erasure` left off would shred nothing and report a
    // clean sweep, and a registry-wide assertion would pass on the one store
    // that still carried the right value.
    const { root, env } = sandbox();
    await withHome(root, async () => {
      await seedToken(root);
      await seedToken(root, 'work');
      await seedToken(root, 'personal');

      const stores = tokenStores(localStorePaths({ env }));
      assert.equal(stores.length, 3, `expected one store per token file, got ${stores.length}`);
      for (const store of stores) {
        assert.equal(store.erasure, 'shred', `${store.id} must be shredded, not moved`);
        assert.equal(store.kind, 'file', `${store.id} is a single file`);
      }
    });
  });

  it('still shreds a token file whose name no profile rule produces', async () => {
    // `SPOTIFY_MCP_TOKEN_FILE` can point at ANY path, and the enumeration walks
    // the token DIRECTORY by the profile naming rule — so a file called
    // something else is found by neither arm on its own. That is the case where
    // an implementation that unions the enumerated names but drops the resolved
    // answer shreds a DIFFERENT file and leaves the live credential: the exact
    // failure this command exists to prevent, arriving through the fix for it.
    //
    // Both arms are exercised, and both must answer. The configured file sits
    // in the token directory beside two profile-named ones, so the resolved
    // answer and the enumeration name overlapping sets — a union that dropped
    // either half erases one file and leaves the other.
    const { root, env } = sandbox();
    await withHome(root, async () => {
      const derivable = [await seedToken(root), await seedToken(root, 'work')];
      const configured = join(dirname(derivable[0]!), 'spotify-creds.json');
      assert.ok(
        !derivable.includes(configured),
        'precondition: the configured file must not be one the naming rule produces',
      );
      await fs.writeFile(
        configured,
        JSON.stringify({ access_token: 'at', refresh_token: `${REFRESH_SECRET}-custom` }),
        { mode: 0o600 },
      );
      const expected = [...derivable, configured];

      const configuredEnv = { ...env, SPOTIFY_MCP_TOKEN_FILE: configured };
      const named = tokenStores(localStorePaths({ env: configuredEnv })).map((s) => s.path);
      assert.deepEqual(
        [...named].sort(),
        [...expected].sort(),
        'precondition: the enumeration and the resolved answer must both be named',
      );

      const { io: seam, output } = io();
      const code = await runLogout([], seam, { env: configuredEnv, allowGioTrash: false });
      const text = output();

      assert.equal(code, 0, text);
      for (const path of expected) {
        await assert.rejects(fs.lstat(path), /ENOENT/, `${path} survived logout`);
        assert.ok(text.includes(path), `the report must name ${path}`);
      }
    });
  });

  it('names every token file in a dry run, and erases none of them', async () => {
    // The dry run is where an operator checks what a real run would touch, so
    // a token file missing from it is the warning that never arrives. And
    // planning must not have side effects: shredding during a dry run would be
    // the worst possible version of this bug.
    const { root, env } = sandbox();
    await withHome(root, async () => {
      const written = [await seedToken(root), await seedToken(root, 'work')];

      const { io: seam, output } = io();
      const code = await runLogout(['--dry-run'], seam, { env, allowGioTrash: false });
      const text = output();

      assert.equal(code, 0, text);
      assert.match(text, /Dry run/);
      for (const path of written) {
        assert.ok(text.includes(path), `the dry run does not name ${path}`);
        assert.ok(await fs.lstat(path), `the dry run erased ${path}`);
      }
    });
  });

  it('exits non-zero and names the store when one token file cannot be shredded', async () => {
    // The failure accounting, with several files in the store. A `kind: 'file'`
    // store whose path holds a DIRECTORY is refused (#1309): anything running as
    // the user can create one, and shredding it would mean overwriting and
    // unlinking a tree this server never wrote. The refusal has to surface the
    // same way with three files in the store as with one — a report that said
    // "Local stores cleared" under a "Not erased" section would be the exact
    // inconsistency this asserts against.
    const { root, env } = sandbox();
    await withHome(root, async () => {
      const written = [await seedToken(root), await seedToken(root, 'work')];
      const impostor = tokenFilePathForProfile('clash', { HOME: root, USERPROFILE: root });
      await fs.mkdir(impostor, { recursive: true, mode: 0o700 });
      await fs.writeFile(join(impostor, 'survivor'), 'not a token', { mode: 0o600 });

      const { io: seam, output } = io();
      const code = await runLogout([], seam, { env, allowGioTrash: false });
      const text = output();

      assert.equal(code, 1, `a refused store is still on disk, so the exit must not be 0\n${text}`);
      assert.match(text, /Not erased:/);
      assert.match(text, /REFUSED/);
      assert.doesNotMatch(text, /Local stores cleared/);
      // Named by its store id, which carries the file name (#1591 gave the
      // credential store that shape). The full path is printed for every ERASED
      // file; a refusal prints the reason, so the file name is the part of the
      // path the report can be checked on here.
      assert.ok(
        text.includes(basename(impostor)),
        `the report must name ${impostor}\n${text}`,
      );
      // The refusal must not have taken its neighbours with it: the two real
      // token files are independent stores, planned and erased on their own.
      for (const path of written) {
        await assert.rejects(fs.lstat(path), /ENOENT/, `${path} was not erased`);
      }
      assert.ok(await fs.lstat(join(impostor, 'survivor')), 'a refused directory was erased');
    });
  });

  it('exits 0 on a machine with no token file at all', async () => {
    // Enumerating means reading a directory, and a missing one must not turn
    // logout into a failure. A first run on a fresh install has no token files
    // and must still report success.
    const { root, env } = sandbox();
    await withHome(root, async () => {
      const stores = tokenStores(localStorePaths({ env }));
      assert.equal(stores.length, 1, 'the default token file is named even with none on disk');

      const { io: seam, output } = io();
      const code = await runLogout([], seam, { env, allowGioTrash: false });
      assert.equal(code, 0, output());
      assert.match(output(), /absent/);
    });
  });

  it('resolves every token store inside the sandbox, as a token file', async () => {
    // The enumeration READS A DIRECTORY, so the paths it produces are new ones
    // rather than a retyped constant — which means a mistake in that read shows
    // up as a path this server never wrote. If one of them ever escaped the
    // sandbox it would be SHREDDED: the only irreversible mechanism in this
    // command. So both halves are checked — the path is inside the sandbox, and
    // it is a token FILE rather than some other entry in the token directory.
    const { root, env } = sandbox();
    await withHome(root, async () => {
      await seedToken(root);
      await seedToken(root, 'work');
      for (const store of tokenStores(localStorePaths({ env }))) {
        assert.ok(
          store.path.startsWith(root + '/'),
          `${store.id} would resolve outside the sandbox (${store.path})`,
        );
        assert.match(
          basename(store.path),
          /^tokens(\.[^/]+)?\.json$/,
          `${store.id} names something that is not a token file: ${store.path}`,
        );
        assert.ok(
          await fs.lstat(store.path).catch(() => null),
          `${store.id} was planned for erasure but does not exist: ${store.path}`,
        );
      }
    });
  });
});
