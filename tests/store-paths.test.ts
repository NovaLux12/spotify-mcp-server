/**
 * One list of local stores, and nothing that resolves one behind its back (#711).
 *
 * ## What this guards
 *
 * Before this change every store path was written twice: once in the module
 * that wrote the file, and once in whatever else needed to know where it was —
 * `logout`'s store table, the configuration reference, the doctor. Fifteen-odd
 * files each retyped `SPOTIFY_MCP_X ?? join(homedir(), '.spotify-mcp', …)`, and
 * the copies were equal only by hand. Two of them had already drifted: a
 * listening-history directory in `portability.ts` and the read-root list in
 * `paths.ts` each held their own copy of the portability default.
 *
 * The registry in `src/config.ts` is now the single place a store's path is
 * decided, and this file is what stops a fourth copy appearing. The checks are
 * deliberately STRUCTURAL — they read `src/` and compare — rather than a
 * hand-typed list of expected paths, because a hand-typed list is a second
 * registry, and a second registry is the thing that was wrong.
 *
 * ## Sandboxing
 *
 * Every path here is under this file's own `mkdtemp` root, asserted in
 * `before()` before any test can act on a path: the developer's
 * `~/.spotify-mcp` is user data and this suite is meant to be runnable on a box
 * where it exists. `allowGioTrash: false` throughout, so the erasure test is a
 * rename into a quarantine directory beside the original — same directory, same
 * filesystem, inside the sandbox — and nothing reaches a trash can.
 *
 * The declared `$HOME` and the store root are kept DISTINCT, which is both what
 * a real machine looks like and what makes these tests independent of the
 * "a directory that CONTAINS another store is kept, not erased" rule. That
 * rule is about the parent/child relationship between two resolved store paths,
 * not about how many stores share a directory: in this file's own fixture every
 * `_FILE`/`_DIR` variable points into `box.data`, so the data directory happens
 * to hold them all, which is exactly the coincidence that made `src/logout.ts`
 * describe it as a superset when it is a parent.
 */

import './helpers/hermetic.js';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOCAL_STORES, getConfig, storePath } from '../src/config.ts';
import {
  localStorePaths,
  planErasure,
  runLogout,
  type LocalStore,
  type LogoutIo,
} from '../src/logout.js';
import { historyFilePath, historyFilePaths } from '../src/history.js';
import { receiptsFilePath } from '../src/receipts.js';
import { resolveTokenFile } from '../src/config.js';
import { accountsFile } from '../src/accounts.js';
import { backupRootDir, exportRootDir, readRoots } from '../src/paths.js';
import { tasksDir } from '../src/tasks.js';
import { artistWatchlistPath } from '../src/tools/artistwatch.js';
import { exhaust2PlaybackFile } from '../src/tools/exhaust2_playback.js';
import { miscFilePath } from '../src/tools/exhaust2_misc.js';
import { watermarkFilePath } from '../src/tools/freshness.js';
import { genreTagsPath } from '../src/tools/libraryinsights.js';
import { playbackExtFile } from '../src/tools/playbackext.js';
import { snapshotDir as healthSnapshotDir } from '../src/tools/playlisthealth.js';
import { portabilityDir } from '../src/tools/portability.js';
import { scenesFilePath } from '../src/tools/scenes.js';
import { searchHistoryFile } from '../src/tools/searchhistory.js';
import { tasteFeedbackFile } from '../src/tools/statsfm_taste.js';
import { snapshotDir as swarmSnapshotDir } from '../src/tools/swarm3_snapshots.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');

const created: string[] = [];
const ORIGINAL_CONFIRM = process.env.SPOTIFY_MCP_CONFIRM;

/**
 * Stores `logout` resolves that the registry deliberately does not list, and
 * why. Stated here rather than left as an unexplained delta, because the delta
 * is the interesting part: an unexamined difference between "the stores the
 * server writes" and "the stores logout erases" is exactly the omission this
 * registry exists to make visible.
 */
const LOGOUT_ONLY: Record<string, string> = {
  cache:
    'Named after the token file through getTokenFilePath(), which also reads argv. config.ts must '
    + 'not depend on the CLI, so the naming rule lives in cachepersist.ts. logout enumerates every '
    + "profile's cache (cachePersistPaths), which is a superset of the active one.",
  'cache-pending-marker':
    'Same derivation as the cache it describes; the marker path is that path plus ".pending".',
};

/**
 * Stores the registry lists that `logout` does NOT enumerate at all, and why.
 *
 * EMPTY, and that is the point (#1434). It used to carry `accounts` and
 * `taste-feedback`: real local stores holding user data, which this list
 * recorded rather than fixed. The record made the gap VISIBLE, which is what
 * it was for — but a gap named in a test is still a gap, and the suite stayed
 * green on the strength of the difference being declared. `logout` reported a
 * clean sweep while leaving behind the record of which accounts exist on this
 * machine, and every stats.fm verdict the user had accumulated.
 *
 * The map is kept, empty, because the failure mode it was built for is still
 * live: `cache` and `cache-pending-marker` legitimately resolve through a
 * module `config.ts` may not import, and that difference has to be sayable. It
 * is `LOGOUT_ONLY` above that now carries it, and a store that appears here
 * again has to come with a reason that survives review.
 */
const NOT_ERASED_BY_LOGOUT: Record<string, string> = {};

/**
 * Stores `logout` DOES enumerate, and then deliberately keeps.
 *
 * A different fact from the map above: these are planned and reported under
 * "Not erased", and the reason is the nesting rule rather than a coverage gap.
 * With `SPOTIFY_MCP_DATA_DIR` set, `playlist-health-snapshots` resolves to the
 * data directory itself, which is the PARENT of the stores that variable
 * relocates. Erasing it would take those with it, the opposite of the
 * enumerate-then-remove promise the command makes. It is a parent of those
 * stores, not a superset of all of them; the rest resolve under
 * `~/.spotify-mcp/` either way.
 *
 * No list, and no count: how many stores the variable happens to relocate moves
 * with every store added to the registry, and the reason string the user is
 * shown computes it at runtime. Restating either here is what made
 * `src/logout.ts` claim a superset that did not exist (#1426).
 */
const KEPT_AS_CONTAINER: Record<string, string> = {
  'playlist-health-snapshots':
    'Resolves to SPOTIFY_MCP_DATA_DIR itself, so it is the parent directory of the stores that '
    + 'variable relocates. The nesting rule keeps a container rather than erasing the lot.',
};

interface Box {
  /** This test's own root. Nothing outside it may be read or written. */
  root: string;
  /** The declared `$HOME`, distinct from the store root on purpose. */
  home: string;
  /** The `~/.spotify-mcp` equivalent every store is wired into. */
  data: string;
  env: NodeJS.ProcessEnv;
}

/** A sandbox whose `$HOME` and store directory are different directories. */
function sandbox(): Box {
  const root = mkdtempSync(join(tmpdir(), 'spotify-mcp-stores-'));
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
    SPOTIFY_MCP_SNAPSHOT_DIR: join(data, 'playlist-snapshots'),
    SPOTIFY_MCP_PORTABILITY_DIR: join(data, 'portability'),
    SPOTIFY_MCP_EXPORT_DIR: join(data, 'exports'),
    SPOTIFY_MCP_TASKS_DIR: join(data, 'tasks'),
  };
  return { root, home, data, env };
}

/** Every src file, as paths relative to the repo root. */
function srcFiles(dir = SRC, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) srcFiles(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Comments removed, string literals left alone.
 *
 * Deliberately crude and deliberately one-sided: it over-strips rather than
 * under-strips, so the check that uses it can only miss a build, never invent
 * one. A string containing `//` (a URL) loses its tail — which costs this file
 * a check, not a false alarm.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * The function declaration enclosing `offset`.
 *
 * Brace-counted from the nearest `function` keyword above the offset, so it
 * reads the function BODY and not the whole file. Deliberately not a parser:
 * the store resolvers are all short top-level `export function`s, and a
 * heuristic that mis-locates one would report a file name the maintainer then
 * has to chase down. A miss is silent; a false positive is not, so the
 * brace count is what decides.
 */
function enclosingFunction(
  source: string,
  offset: number,
): { name: string; body: string } | null {
  const before = source.lastIndexOf('function', offset);
  if (before === -1) return null;
  const name = /function\s+(\w+)/.exec(source.slice(before, before + 80))?.[1] ?? '(anonymous)';
  const open = source.indexOf('{', before);
  if (open === -1 || open > offset) return null;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return { name, body: source.slice(open, i + 1) };
    }
  }
  return null;
}

describe('the store registry is the only place a store path is spelled', () => {
  // CONTAINMENT. Before anything else: prove that the sandbox is a sandbox. If
  // a store ever resolves outside this root — because an env var was missed, or
  // because a resolver fell back to process.env — every later assertion in this
  // file would be operating on a real path, so this runs first and it runs on
  // the WHOLE registry rather than on whichever store a given test touches.
  before(() => {
    const box = sandbox();
    for (const store of LOCAL_STORES) {
      for (const env of [box.env, { ...box.env, HOME: box.home, USERPROFILE: box.home }]) {
        const path = resolve(store.resolve(env));
        const rel = relative(box.root, path);
        assert.ok(
          isAbsolute(path) && rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..',
          `store "${store.id}" resolved to ${path}, which is OUTSIDE this test's mkdtemp root ${box.root}`,
        );
        assert.notEqual(
          path,
          resolve(box.home),
          `store "${store.id}" resolved to the declared home itself, so the home-directory refusal in logout could never fire for it`,
        );
      }
    }
  });

  after(async () => {
    if (ORIGINAL_CONFIRM === undefined) delete process.env.SPOTIFY_MCP_CONFIRM;
    else process.env.SPOTIFY_MCP_CONFIRM = ORIGINAL_CONFIRM;
    for (const dir of created) await fs.rm(dir, { recursive: true, force: true });
  });

  it('keeps the store directory name out of every module that does not own it', () => {
    // The load-bearing assertion, and the one that goes red the moment a module
    // re-inlines its own path. Before #711 fifteen files spelled this literal;
    // the registry is now the only one allowed to.
    //
    // The check is on the QUOTED LITERAL, not on the text: a module is free to
    // say `~/.spotify-mcp/scenes.json` in a comment or a tool description —
    // that is documentation, and rewriting it would be churn. What is forbidden
    // is the bare string as a `join`/`resolve` operand, because that is a path
    // being *built* outside the registry.
    //
    // `logout.ts` is exempt for its quarantine directory, which is deliberately
    // `~/.spotify-mcp-logout-…` rather than `~/.spotify-mcp/…`: it must be a
    // SIBLING of the store, so a restore does not depend on a directory that
    // logout is in the middle of emptying.
    const EXEMPT: Record<string, string> = {
      'logout.ts': 'the erasure quarantine directory, which must be a sibling of the store',
    };
    const offenders: string[] = [];
    for (const file of srcFiles()) {
      const rel = relative(ROOT, file);
      if (rel === join('src', 'config.ts')) continue;
      if (rel in EXEMPT) continue;
      // `join(homedir(), '.spotify-mcp', …)` and `join(x, ".spotify-mcp")` —
      // the literal as an operand, on any line, in either quote style. Comments
      // are stripped first: a module is free to QUOTE the pattern in prose, and
      // a check that cannot tell prose from code is a check nobody trusts.
      const building = /(^|[(,\s])['"]\.spotify-mcp['"]\s*[,)]/.test(
        stripComments(readFileSync(file, 'utf8')),
      );
      if (building) offenders.push(rel);
    }
    assert.deepEqual(
      offenders,
      [],
      'these files BUILD a `~/.spotify-mcp` path outside the registry. Route them '
      + 'through storePath() in src/config.ts — a second copy of a store default is '
      + 'how the paths drift and how logout ends up erasing the wrong file: '
      + offenders.join(', '),
    );
    // The exemption is stated, not implicit, so adding a new module with a
    // legitimate reason requires writing down the reason.
    for (const [rel, why] of Object.entries(EXEMPT)) {
      assert.ok(
        readFileSync(join(SRC, rel), 'utf8').includes('.spotify-mcp'),
        `${rel} is exempted from the store-directory check but no longer needs it`,
      );
      assert.ok(why.length > 20, `${rel}: the recorded exemption reason is too thin`);
    }
  });

  it('resolves each store to the same path from the registry and from its owning module', () => {
    // The two answers must be the SAME STRING, not merely the same directory:
    // a resolver that agreed on the parent and disagreed on the file name would
    // let logout report a path the tool never wrote.
    const box = sandbox();
    const owners: Record<string, (env: NodeJS.ProcessEnv) => string> = {
      token: (env) => storePath('token', env),
      accounts: accountsFile,
      // #1385: these two key their FILE NAME by the acting account, so they
      // are not one-argument resolvers any more — naming no account is an
      // error, not the default account. `resolveTokenFile(env)` is the same
      // resolver the registry rows use, which is what keeps this a comparison
      // of the DEFAULT account against the registry rather than a comparison
      // of two different accounts.
      mutations: (env) => historyFilePath(env, resolveTokenFile(env)),
      receipts: (env) => receiptsFilePath(env, resolveTokenFile(env)),
      scenes: scenesFilePath,
      'genre-tags': genreTagsPath,
      'playback-extensions': playbackExtFile,
      'search-history': searchHistoryFile,
      'artist-watchlist': artistWatchlistPath,
      'taste-feedback': tasteFeedbackFile,
      freshness: watermarkFilePath,
      'exhaust2-misc': miscFilePath,
      'exhaust2-playback': exhaust2PlaybackFile,
      backups: backupRootDir,
      'playlist-snapshots': swarmSnapshotDir,
      'playlist-health-snapshots': healthSnapshotDir,
      portability: portabilityDir,
      exports: exportRootDir,
      tasks: tasksDir,
    };

    for (const [id, owner] of Object.entries(owners)) {
      assert.equal(
        owner(box.env),
        storePath(id, box.env),
        `the module owning "${id}" resolves a different path than the registry does`,
      );
      // And with NO overrides at all, so the default is what is compared.
      const bare: NodeJS.ProcessEnv = { HOME: box.home, USERPROFILE: box.home };
      assert.equal(
        owner(bare),
        storePath(id, bare),
        `the module owning "${id}" resolves a different DEFAULT than the registry does`,
      );
    }

    // No store may be missing an owner, or the check above would quietly cover
    // fewer stores than it appears to.
    assert.deepEqual(
      Object.keys(owners).sort(),
      LOCAL_STORES.map((s) => s.id).sort(),
      'the set of stores with a named owner in this test has drifted from LOCAL_STORES',
    );
  });

  it('resolves the default each registry row documents', () => {
    // `defaultPath` is what a documentation table renders. If it and `resolve`
    // disagree, the docs are wrong in the way AGENTS.md §6 calls a correctly
    // named field lying about its value — the reader is told a path the server
    // does not use.
    //
    // The home the default lands under is `homedir()`, i.e. the *process* home,
    // which is the hermetic root under this suite. A caller-supplied `env` is
    // deliberately not able to move it: `os.homedir()` re-reads
    // `process.env.HOME` on every call, and pinning that is what
    // `tests/helpers/hermetic.ts` exists to do. The point of the assertion is
    // the SUFFIX — that the registry and its own documentation agree.
    const bare: NodeJS.ProcessEnv = {};
    for (const store of LOCAL_STORES) {
      assert.ok(
        isAbsolute(store.defaultPath) === false,
        `${store.id}: defaultPath must be spelled from ~, so a doc row never leaks a real home`,
      );
      const suffix = store.defaultPath.replace(/^~\//, '');
      assert.equal(
        resolve(store.resolve(bare)),
        join(resolve(homedir()), suffix),
        `${store.id}: LOCAL_STORES documents ${store.defaultPath} but resolve() returns something else`,
      );
    }
  });

  it('answers from the env it is handed, never from process.env', () => {
    // A resolver that fell back to `process.env` would answer a caller's
    // explicit `env` from state the caller never supplied — the #1358 shape,
    // and one of these paths is about to be erased.
    //
    // The probe is set in `process.env` and then withheld from the env handed
    // in. A correct resolver falls back to its own default; one that reads
    // `process.env` returns the probe. The probe is inside this test's own
    // `mkdtemp` root, so even a resolver that got it wrong moves nothing.
    const box = sandbox();
    const saved: Record<string, string | undefined> = {};
    for (const store of LOCAL_STORES) {
      if (!store.envVar) continue;
      const probe = join(box.root, 'process-env-probe', store.id);
      saved[store.envVar] = process.env[store.envVar];
      process.env[store.envVar] = probe;
      try {
        // The env handed in is the sandbox's, which HAS an override for this
        // variable — so the answer must be that override and never the probe.
        assert.notEqual(store.resolve(box.env), probe, `${store.id} read process.env`);
        // And an env that withholds it entirely must get the DEFAULT, not the
        // probe: the fallback is `homedir()`, never the ambient process value.
        const withheld: NodeJS.ProcessEnv = {};
        if (store.envVar === 'SPOTIFY_MCP_DATA_DIR') withheld.SPOTIFY_MCP_DATA_DIR = '';
        assert.notEqual(
          store.resolve(withheld),
          probe,
          `${store.id} fell back to process.env when handed an env without its variable`,
        );
      } finally {
        const previous = saved[store.envVar];
        if (previous === undefined) delete process.env[store.envVar];
        else process.env[store.envVar] = previous;
      }
    }
  });

  it('refuses an unknown store id rather than resolving some other store', () => {
    // A typo in a store id must be loud. Returning `undefined` here would flow
    // onward into code that erases files.
    assert.throws(() => storePath('tokenz', {}), /Unknown local store "tokenz"/);
  });

  it('agrees with the per-account keying of the ledger and receipt stores', () => {
    // #1377 keyed these two stores by account, so the registry owns the
    // DIRECTORY and the owning module appends an account segment to the file
    // name. That is the right split — the segment depends on the acting
    // account, which reaches `config.ts` only through `auth.ts`'s argv-aware
    // token resolver — but a split this subtle is exactly where two halves
    // drift, so the boundary is pinned here.
    const box = sandbox();
    const defaultLedger = historyFilePath(box.env, resolveTokenFile(box.env));
    assert.equal(
      defaultLedger,
      storePath('mutations', box.env),
      'the ledger and the registry disagree about the DEFAULT account, which is the '
      + 'one account with no key — so this disagreement needs no profile to appear',
    );
    assert.equal(
      receiptsFilePath(box.env, resolveTokenFile(box.env)),
      storePath('receipts', box.env),
      'the receipt store and the registry disagree about the default account',
    );

    // A named profile changes the file NAME and never the directory. If the
    // account key ever started moving the directory, the registry's row would
    // be describing a path no account actually uses.
    const workLedger = historyFilePath(box.env, join(box.data, 'tokens.work.json'));
    assert.notEqual(workLedger, defaultLedger, 'precondition: the key must change the path');
    assert.equal(
      dirname(workLedger),
      dirname(defaultLedger),
      'the account key moved the DIRECTORY as well as the name',
    );
    assert.match(
      basename(workLedger),
      /^mutations\.work\.jsonl$/,
      `the ledger's account key changed shape: ${basename(workLedger)}`,
    );

    // And the erasure list covers every account's ledger, not just the
    // default one — the reason `historyFilePaths` exists at all.
    const all = historyFilePaths(box.env);
    assert.ok(
      all.includes(defaultLedger),
      'the default ledger is missing from the list logout erases, so it would be '
      + 'left on disk on a machine with one account',
    );
  });

  it('resolves from the env argument alone, never from a cached config snapshot', () => {
    // The defect this guards is subtle enough to need saying twice.
    //
    // `getConfig()` returns a snapshot taken at startup and held for the life
    // of the process. A resolver that consults it answers a caller that handed
    // in its own `env` from state that caller never supplied. That is the
    // #1358 shape exactly — the store paths and the erasure guard disagreeing
    // about which environment is real — and one of these paths is about to be
    // erased.
    //
    // It is checked two ways because either alone is insufficient. The
    // structural check catches a `getConfig()` call the moment it is written,
    // including while it is still INERT: `playlisthealth.ts` read
    // `getConfig().dataDir` for a field that does not exist on the config type,
    // so the branch did nothing — until someone adds a field named `dataDir`
    // meaning "the data directory", which resolves to `~/.spotify-mcp` and
    // silently moves every playlist-health snapshot out of `playlist-snapshots/`
    // and into the directory holding every other store. The behavioural check
    // is what would actually fail on that day; the structural one is what stops
    // the code getting that far unnoticed.
    // Structural half: no function in `src/` that DELEGATES to storePath may
    // also call getConfig(). Scanned by finding each `storePath('...'` call and
    // reading its enclosing function, rather than by listing the owners — a
    // hand-kept list is a second registry, which is the thing this file exists
    // to prevent.
    const offenders: string[] = [];
    for (const file of srcFiles()) {
      const rel = relative(ROOT, file);
      const source = stripComments(readFileSync(file, 'utf8'));
      let at = source.indexOf('storePath(');
      while (at !== -1) {
        const fn = enclosingFunction(source, at);
        if (fn && /\bgetConfig\s*\(/.test(fn.body)) {
          offenders.push(`${rel} :: ${fn.name}`);
        }
        at = source.indexOf('storePath(', at + 1);
      }
    }
    assert.deepEqual(
      [...new Set(offenders)],
      [],
      'a store resolver delegates to storePath() AND calls getConfig(). It must be a '
      + 'pure function of the env it is handed: getConfig() is a startup snapshot, so '
      + "consulting it answers a caller's env from state that caller never supplied — "
      + 'which is the #1358 shape, on the one class of path that gets erased.',
    );

    // Behaviour: freeze a snapshot, then ask for a path the snapshot contradicts.
    const box = sandbox();
    const scenes = LOCAL_STORES.find((s) => s.id === 'scenes')!;
    const frozenDir = join(box.root, 'frozen-config-says-this');
    const liveDir = join(box.root, 'caller-env-says-this');
    process.env.SPOTIFY_MCP_SCENES_FILE = join(frozenDir, 'scenes.json');
    try {
      getConfig(); // the snapshot is taken now, while the process env says `frozenDir`
      const live: NodeJS.ProcessEnv = { SPOTIFY_MCP_SCENES_FILE: join(liveDir, 'scenes.json') };
      assert.equal(
        storePath('scenes', live),
        join(liveDir, 'scenes.json'),
        'the store path followed the cached config instead of the env it was handed',
      );
      assert.equal(
        scenes.resolve(live),
        storePath('scenes', live),
        'the registry row and storePath() disagree',
      );
    } finally {
      delete process.env.SPOTIFY_MCP_SCENES_FILE;
    }
  });
});

describe('the registry and logout agree on what there is to erase', () => {
  it('names the same stores, with a stated reason for each difference', () => {
    const inRegistry = new Set(LOCAL_STORES.map((s) => s.id));
    // `expand`ed stores carry the file name in their id, so compare the base.
    const inLogout = new Set(
      localStorePaths({ env: {} }).map((s) => s.id.split(':')[0]!),
    );

    const onlyRegistry = [...inRegistry].filter((id) => !inLogout.has(id)).sort();
    const onlyLogout = [...inLogout].filter((id) => !inRegistry.has(id)).sort();

    assert.deepEqual(
      onlyRegistry,
      Object.keys(NOT_ERASED_BY_LOGOUT).sort(),
      'a store is in the registry but logout does not erase it, and no reason is recorded for the gap',
    );
    assert.deepEqual(
      onlyLogout,
      Object.keys(LOGOUT_ONLY).sort(),
      'logout erases a store the registry does not list, and no reason is recorded for it',
    );
    for (const [id, why] of Object.entries({ ...NOT_ERASED_BY_LOGOUT, ...LOGOUT_ONLY })) {
      assert.ok(why.length > 40, `${id}: the recorded reason is too thin to review`);
    }
  });

  it('leaves no registered store outside logout, and the gap map says so', () => {
    // The half of the #1434 contract that is about the FUTURE rather than the
    // two stores it was filed for. The delta assertion above already fails when
    // a store is added to the registry alone — but only if whoever adds it also
    // thinks to update `NOT_ERASED_BY_LOGOUT`, which is the move that turns a
    // coverage gap into a reviewed decision. Asserting the map is EMPTY removes
    // that move: there is now no way to widen the gap without a failing test
    // that names the store.
    assert.deepEqual(
      Object.keys(NOT_ERASED_BY_LOGOUT),
      [],
      'a store is excluded from logout again. That is a product decision, not a '
      + 'default: erase it, and if it really must survive, delete this assertion '
      + 'deliberately rather than adding a key that makes it pass.',
    );
  });

  it('erases the account registry and the taste-feedback file (#1434)', async () => {
    // The regression. `logout` exists to remove this machine's local state, and
    // both of these are stores it writes: `accounts.json` through `switch_account`
    // and `auth --profile`, `taste-feedback.json` through `record_feedback`. A
    // store logout does not know about is one it leaves behind SILENTLY — it is
    // not in the report, not in the confirmation prompt, and not in the exit
    // code, so the run reads as a clean sweep.
    //
    // The observable consequence, which is what makes this a bug rather than a
    // tidiness point: `accounts.json` is not derived data. It is this machine's
    // record of which local accounts exist, their profile names, and the
    // absolute path of each one's token file. A user who runs `logout` to
    // disconnect — or who hands the machine to someone else — expects that gone,
    // and the only evidence it survived is opening the file. `taste-feedback.json`
    // is the same shape: up to 500 accumulated stats.fm verdicts, left behind
    // with nothing in the output to say so.
    //
    // Asserted through the real command rather than through `localStorePaths`,
    // because "logout enumerates it" and "logout erases it" are different claims
    // and only the second one is the bug.
    const box = sandbox();
    const accounts = join(box.data, 'accounts.json');
    const taste = join(box.data, 'taste-feedback.json');
    // A real registry document, so this fails for the right reason if the file
    // is left behind rather than passing because the seed was malformed.
    await fs.writeFile(
      accounts,
      JSON.stringify({
        version: 1,
        accounts: [
          { accountId: 'acct-1', profile: 'default', tokenFile: join(box.data, 'tokens.json') },
          { accountId: 'acct-2', profile: 'work', tokenFile: join(box.data, 'tokens.work.json') },
        ],
      }),
      { mode: 0o600 },
    );
    await fs.writeFile(
      taste,
      JSON.stringify({ entries: [{ id: 1, at: 1, subject_type: 'artist', subject: 'x', rating: 'like', note: null }] }),
      { mode: 0o600 },
    );

    const output: string[] = [];
    const io: LogoutIo = {
      isInteractive: true,
      ask: async () => 'y',
      write: (text) => output.push(text),
    };
    const code = await runLogout([], io, {
      env: box.env,
      cwd: box.root,
      allowGioTrash: false,
    });
    const report = output.join('\n');

    assert.equal(code, 0, `logout failed: ${report}`);
    for (const [id, path] of [['accounts', accounts], ['taste-feedback', taste]] as const) {
      assert.equal(
        (await fs.lstat(path).catch(() => null)) === null,
        true,
        `logout reported a clean sweep but left ${path} on disk. The store "${id}" is `
        + 'one this server writes, so a user running logout to disconnect has no way to '
        + 'learn it survived: it is absent from the report, the prompt and the exit code.',
      );
      // Named, not merely gone. A store erased without appearing in the report
      // is indistinguishable from one that was never considered. The report
      // row is `  <id> erased <how> <label> — <detail>` (see `storeLine`), so
      // the id and the verb are asserted together: an id that merely appears
      // elsewhere in the prose would not satisfy this.
      assert.match(
        report,
        new RegExp(`^ {2}${id} +erased +`, 'm'),
        `logout erased ${id} without naming it, so the report cannot be checked against the disk`,
      );
    }

    // And the erasure is the reversible one, not the credential one. Neither
    // file holds token material, so both are MOVED; if either were shredded the
    // report row would read "erased  <label> — overwritten and unlinked" and a
    // mistyped logout would become unrecoverable for a file that held nothing
    // secret. The label sits between the verb and the mechanism (`storeLine`),
    // so the pattern has to carry it.
    assert.doesNotMatch(
      report,
      /^ {2}(accounts|taste-feedback) +erased +(Account registry|stats\.fm taste feedback) — overwritten and unlinked/m,
      'a store holding no token material was shredded; only the token file is',
    );
  });

  it('labels every store logout erases the way the registry labels it', () => {
    // The report a user reads before approving an erase comes from logout; the
    // documentation table comes from the registry. Two names for one store is
    // the kind of drift this whole change is about.
    const byId = new Map(LOCAL_STORES.map((s) => [s.id, s]));
    for (const store of localStorePaths({ env: {} })) {
      const spec = byId.get(store.id.split(':')[0]!);
      if (!spec) continue; // the LOGOUT_ONLY stores, covered above
      assert.equal(store.label, spec.label, `store "${store.id}" is labelled differently by logout`);
      assert.equal(store.kind, spec.kind, `store "${store.id}" is declared a different kind by logout`);
      assert.equal(store.envVar, spec.envVar, `store "${store.id}" names a different env var`);
    }
  });
});

describe('erasing through the registry is still contained (#711 did not weaken the guard)', () => {
  it('refuses every store that resolves TO a home directory', async () => {
    // The guard is what makes a misconfigured env var survivable, and it is the
    // only thing enforcing the home bound. The registry must not have moved a
    // store somewhere the check cannot see, so this drives the real plan
    // against stores deliberately pointed at the home.
    //
    // Every store's path IS the home, which is what a single misconfigured
    // `_DIR` variable pointed at `$HOME` actually produces. Each is materialised
    // first: `planErasure` reports `absent` for a path that does not exist, and
    // `absent` is decided before the home refusal — so a store that was never
    // created would pass this test for the wrong reason.
    const box = sandbox();
    await fs.mkdir(box.home, { recursive: true, mode: 0o700 });
    const stores: LocalStore[] = LOCAL_STORES.map((spec) => ({
      id: spec.id,
      label: spec.label,
      kind: spec.kind,
      path: box.home,
      root: box.home,
      erasure: 'move',
      envVar: spec.envVar,
    }));

    const decisions = await planErasure(stores, { home: box.home, env: box.env });
    assert.equal(decisions.length, stores.length);
    for (const decision of decisions) {
      assert.equal(
        decision.action,
        'refuse',
        `store "${decision.store.id}" was approved (${decision.action}) at ${decision.store.path}, which IS the home directory`,
      );
      assert.match(
        (decision as Extract<typeof decision, { action: 'refuse' }>).reason,
        /is the home directory/,
        `store "${decision.store.id}" was refused, but not for being the home directory`,
      );
    }
    // The home survives, with everything in it. This is the assertion that
    // would catch a guard that reported `refuse` and erased anyway.
    assert.equal(
      (await fs.lstat(box.home)).isDirectory(),
      true,
      'the declared home was not left in place',
    );
  });

  it('refuses a store at the PROCESS home even when the caller declared another', async () => {
    // The union, not a swap (#1358, and the property #711 must not weaken).
    //
    // `eraseGuardHomes` collects `os.homedir()`, `env.HOME` and `options.home`
    // and refuses a store at ANY of them. Replacing the process home with the
    // declared one would be a loosening, because every store DEFAULT resolves
    // through `os.homedir()` — so the process home is exactly where the stores
    // with no override land, and it is the one the original check was written
    // for.
    //
    // Stated as its own test because it is the only assertion here that fails
    // if the set is ever turned into a preference order. Under this suite the
    // process home is the hermetic root (see `tests/helpers/hermetic.ts`), and
    // the sandbox declares a DIFFERENT home — which is the configuration where
    // a swap silently stops protecting anything.
    const box = sandbox();
    const processHome = homedir();
    assert.notEqual(
      processHome,
      box.home,
      'precondition: the sandbox home must differ from the process home, or this '
      + 'test proves nothing about the union',
    );
    // The store's path IS the process home — not something inside it. The
    // refusal is for a path that EQUALS a home directory; a store *under* one
    // is ordinary (it is what every store on a real machine is, since
    // `~/.spotify-mcp` is inside `$HOME`) and is erased, as the next test
    // asserts. Under a swap the process home drops out of `eraseGuardHomes`
    // entirely and this store is approved.
    //
    // `planErasure` PLANS; it moves nothing. That is what makes it safe to
    // name a real path here: the store is offered, judged, and the test reads
    // the verdict. Under this suite that path is the hermetic root — a
    // `mkdtemp` the helper made and deletes on exit — never the developer's
    // real home, because `tests/helpers/hermetic.ts` redirects `HOME` at
    // import and `homedir()` re-reads it on every call.
    const decisions = await planErasure(
      [
        {
          id: 'exports',
          label: 'Exports',
          kind: 'dir',
          path: processHome,
          root: processHome,
          erasure: 'move',
          envVar: 'SPOTIFY_MCP_EXPORT_DIR',
        },
      ],
      { home: box.home, env: box.env },
    );
    assert.equal(decisions.length, 1);
    assert.equal(
      decisions[0]!.action,
      'refuse',
      'a store at the process home was approved for erasure while the caller '
      + 'declared a different home — eraseGuardHomes has been reduced to a swap',
    );
    assert.match(
      (decisions[0] as Extract<typeof decisions[0], { action: 'refuse' }>).reason,
      /is the home directory/,
    );

    // And the declared home is still guarded, so the test cannot pass by
    // refusing everything.
    const declared = await planErasure(
      [
        {
          id: 'exports',
          label: 'Exports',
          kind: 'dir',
          path: box.home,
          root: box.home,
          erasure: 'move',
          envVar: 'SPOTIFY_MCP_EXPORT_DIR',
        },
      ],
      { home: box.home, env: box.env },
    );
    assert.equal(declared[0]!.action, 'refuse', 'the declared home stopped being guarded');
  });

  it('still erases a store that sits INSIDE the declared home', async () => {
    // The control, and the boundary the previous test must not cross. The
    // refusal is for a store that IS a home directory; a store under one is
    // ordinary — `~/.spotify-mcp` is inside `$HOME` on every real machine, and
    // refusing it would make `logout` erase nothing at all.
    //
    // Without this, "refuse every store" and "refuse every store that is a
    // home" would both pass the test above.
    const box = sandbox();
    const token = join(box.data, 'tokens.json');
    await fs.mkdir(box.data, { recursive: true, mode: 0o700 });
    await fs.writeFile(token, '{"refresh_token":"rt"}', { mode: 0o600 });

    const decisions = await planErasure(
      [
        {
          id: 'token',
          label: 'OAuth tokens',
          kind: 'file',
          path: token,
          root: box.data,
          erasure: 'move',
          envVar: 'SPOTIFY_MCP_TOKEN_FILE',
        },
      ],
      { home: box.home, env: box.env },
    );
    assert.equal(decisions[0]!.action, 'erase');
  });

  it('refuses a store that resolves outside the root it declares', async () => {
    const box = sandbox();
    const outsideRoot = join(box.root, 'not-the-store-dir');
    await fs.mkdir(outsideRoot, { recursive: true, mode: 0o700 });
    const outside = join(outsideRoot, 'sidecar.json');
    await fs.writeFile(outside, '{}', { mode: 0o600 });

    const decisions = await planErasure(
      [
        {
          id: 'scenes',
          label: 'Scenes',
          kind: 'file',
          path: outside,
          // The store's own directory is somewhere else entirely. This is the
          // hand-built shape: `runLogout` derives `root` from `path`, so the
          // containment rule is only reachable by naming a root yourself.
          root: join(box.data, 'scenes'),
          erasure: 'move',
          envVar: 'SPOTIFY_MCP_SCENES_FILE',
        },
      ],
      { home: box.home, env: box.env },
    );
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]!.action, 'refuse');
    assert.match(
      (decisions[0] as Extract<typeof decisions[0], { action: 'refuse' }>).reason,
      /outside its own store directory/,
    );
    assert.equal(await fs.readFile(outside, 'utf8'), '{}', 'the file was erased');
  });

  it('erases a real sandbox by rename, never by trash, and never outside mkdtemp', async () => {
    // The end-to-end shape: every store resolved from the registry, planned,
    // and moved into a quarantine directory BESIDE each original. Nothing here
    // touches a trash can or any path outside this test's own root.
    const box = sandbox();
    // Materialise every store the registry names, so the run has something to
    // move and a `keep`/`absent` verdict cannot stand in for an `erase`.
    for (const spec of LOCAL_STORES) {
      const path = resolve(spec.resolve(box.env));
      await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
      if (spec.kind === 'dir') {
        await fs.mkdir(path, { recursive: true, mode: 0o700 });
        await fs.writeFile(join(path, 'marker.json'), '{}', { mode: 0o600 });
      } else {
        await fs.writeFile(path, '{"marker":true}', { mode: 0o600 });
      }
    }

    const output: string[] = [];
    const io: LogoutIo = {
      isInteractive: true,
      // Every prompt answers "y": the stores are sandbox files this suite just
      // created, and `allowGioTrash: false` makes the erasure a rename inside
      // `mkdtemp`.
      ask: async () => 'y',
      write: (text) => output.push(text),
    };

    const code = await runLogout([], io, {
      env: box.env,
      cwd: box.root,
      allowGioTrash: false,
    });

    const report = output.join('\n');
    assert.equal(code, 0, `logout failed: ${report}`);

    for (const store of LOCAL_STORES) {
      const resolved = resolve(store.resolve(box.env));
      const rel = relative(box.root, resolved);
      assert.ok(
        isAbsolute(resolved) && rel !== '..' && !rel.startsWith(`..${sep}`),
        `store "${store.id}" escaped the sandbox: ${resolved}`,
      );
      if (store.id in NOT_ERASED_BY_LOGOUT) continue; // asserted below
      if (store.id in KEPT_AS_CONTAINER) {
        // Deliberately kept by the nesting rule. It must be REPORTED as kept,
        // not silently dropped — a store that vanishes from the report is the
        // omission this whole command exists to prevent.
        assert.notEqual(
          (await fs.lstat(resolved).catch(() => null)) === null,
          true,
          `${store.id} was the parent of the stores that variable relocates, and was erased anyway`,
        );
        assert.match(
          report,
          new RegExp(`${store.id}\\s+.*kept`),
          `${store.id} was kept but not reported as kept: ${KEPT_AS_CONTAINER[store.id]}`,
        );
        continue;
      }
      // The quarantine is a SIBLING of the original, so the moved file is still
      // inside the root — which is the whole point of `allowGioTrash: false`
      // and the reason this assertion is "moved aside, beside it" rather than
      // merely "gone". `gone` alone would also pass if something had deleted
      // the file outright, which is the outcome this test exists to
      // distinguish from a recoverable move.
      const movedAside =
        (await fs.lstat(resolved).catch(() => null)) === null
        && readdirSync(dirname(resolved)).some((name) => name.includes('quarantine'));
      assert.ok(
        movedAside,
        `store "${store.id}" was not moved aside by a rename beside it (${resolved})`,
      );
    }

    // The control, stated as its own assertion so a failure names the store:
    // anything logout does NOT claim to erase is still exactly where it was.
    // Inside the sandbox, so this checks the *decision* rather than protecting
    // a real file — but it is the assertion that would catch a change that
    // quietly widened what `logout` deletes. Vacuous while
    // `NOT_ERASED_BY_LOGOUT` is empty, and deliberately so: it is the brake for
    // the day a store is excluded again, and the emptiness is asserted
    // separately above so a re-added entry cannot pass unnoticed.
    for (const [id, why] of Object.entries(NOT_ERASED_BY_LOGOUT)) {
      const spec = LOCAL_STORES.find((s) => s.id === id)!;
      const path = resolve(spec.resolve(box.env));
      assert.notEqual(
        (await fs.lstat(path).catch(() => null)) === null,
        true,
        `${id} was erased, but logout does not claim to erase it. ${why}`,
      );
    }

    // The report must be checkable against the disk: a literal `~` in a path
    // the user is asked to approve is a path the report cannot be verified
    // against, and the hermetic helper makes a `~` here point somewhere the
    // user has never seen.
    assert.ok(
      !report.includes('~/.spotify-mcp'),
      'the report named a literal ~ path, so it cannot be checked against the disk',
    );
  });
});

/**
 * The rows of PRIVACY.md's "Local stores and paths" table, as their first cell.
 *
 * SCOPED TO THE TABLE, and that is the whole point of the helper. The file
 * mentions `~/.spotify-mcp/accounts.json` in PROSE (in the logout paragraph),
 * so a check that merely asked "does PRIVACY.md contain the path?" would pass
 * while the table — the part whose job is to answer "what is on my disk, and
 * how do I delete it" — had no row for a store the server writes. #1450 was
 * open for exactly that reason: the file was not silent about the file, it was
 * silent about the ROW. A guard that greps the whole document cannot tell those
 * apart, so it cannot catch the omission.
 *
 * The section is bounded by its own heading and the next `## `, and the header
 * and separator rows are dropped, so a `|` appearing in unrelated prose later
 * in the file cannot contribute a cell. Returns the cells, not the whole file,
 * so a caller cannot accidentally re-widen the scope it was given.
 */
function privacyStoreRows(): string[] {
  const text = readFileSync(join(ROOT, 'PRIVACY.md'), 'utf8');
  const start = text.indexOf('## Local stores and paths');
  assert.notEqual(start, -1, 'PRIVACY.md no longer has a "## Local stores and paths" section');
  const end = text.indexOf('\n## ', start + 5);
  const section = text.slice(start, end === -1 ? undefined : end);
  const lines = section.split('\n').filter((line) => line.trim().startsWith('|'));
  // Header row plus the `|---|` separator. Both are structural, not content.
  assert.ok(
    lines.length > 2,
    `the PRIVACY.md local-stores table has ${lines.length} lines — expected a header, a separator and rows, so the check would be vacuous`,
  );
  return lines.slice(2).map((line) => line.split('|').slice(1, -1)[0]!.trim());
}

describe('the documentation is generated from the registry, not retyped', () => {
  const configDoc = readFileSync(join(ROOT, 'docs', 'configuration.md'), 'utf8');

  it('names every store variable the registry lists', () => {
    // The drift guard the issue asked for, in the direction that matters: a
    // store this server writes must be discoverable in the reference an
    // operator is pointed at. `tests/env-var-truth.test.ts` already guards the
    // general "read ⇒ documented" direction; this one is scoped to the registry
    // so that adding a store is a checked act rather than a silent one.
    const missing = LOCAL_STORES.filter(
      (s) => s.envVar !== null && !configDoc.includes(s.envVar),
    ).map((s) => `${s.id} (${s.envVar})`);
    assert.deepEqual(missing, [], 'stores missing from docs/configuration.md: ' + missing.join(', '));
  });

  it('states each store the way the registry spells its default', () => {
    // A documentation row that says `~/.spotify-mcp/backups` while the
    // resolver writes somewhere else is the failure #711 is about, one layer
    // down from the code.
    //
    // The comparison is on the DIRECTORY a variable sets, not on the whole
    // path. A `_DIR` variable configures a directory and the file name inside
    // it is a separate sentence in the same row — `SPOTIFY_MCP_HISTORY_DIR` is
    // `~/.spotify-mcp/history` and the row says it holds `mutations.jsonl`.
    // Demanding the full file path in the value column would be inventing a
    // documentation convention the file does not use, which is how a
    // correctness check becomes churn nobody keeps.
    const rows = configDoc
      .split('\n')
      .filter((line) => line.startsWith('| `SPOTIFY_MCP_'));
    assert.ok(rows.length >= 8, `only ${rows.length} env rows matched — the check is too thin to be real`);

    for (const store of LOCAL_STORES) {
      if (store.envVar === null) continue;
      const row = rows.find((line) => line.startsWith(`| \`${store.envVar}\``));
      if (!row) continue; // covered by the previous test
      // What the operator sets is the dirname of the resolved path.
      const configured = dirname(store.defaultPath).replace(/^~$|^\/+$/g, '');
      assert.ok(
        row.includes(configured) || row.includes('`' + configured + '`'),
        `the docs/configuration.md row for ${store.envVar} does not state ${configured}, `
        + 'which is the directory the registry resolves into with no override set',
      );
    }
  });

  it('gives every registered store a row in the PRIVACY.md local-stores table', () => {
    // The gap #1450 was filed for. PRIVACY.md's table is the document a reader
    // consults to answer "what is on my disk, and how do I delete it", and it
    // listed 18 rows while the registry listed 19 stores: `accounts.json`, the
    // record of which accounts exist on this machine and where each one's token
    // file is, had no row. A partial table reads as a complete one, and the one
    // store missing was the one whose absence `logout` would otherwise be the
    // only way to discover.
    //
    // Matched on `defaultPath`, not on a hand-typed list of names: the registry
    // already spells each store's documented default, and `resolve()` is
    // separately asserted to agree with it, so this compares the table against
    // the code without a second registry of store names to keep in step.
    const rows = privacyStoreRows();
    const missing = LOCAL_STORES.filter(
      (s) => !rows.some((cell) => cell.includes(s.defaultPath)),
    ).map((s) => `${s.id} (${s.defaultPath})`);
    assert.deepEqual(
      missing,
      [],
      'these stores are written under ~/.spotify-mcp/ but have no row in PRIVACY.md\'s '
      + '"Local stores and paths" table. A reader using that table to find out what to clear '
      + 'would not learn the file exists. Add a row naming the default path, the data and its '
      + 'purpose, and how it is deleted: ' + missing.join(', '),
    );
  });

  it('resolves every read root from the registry rather than a second copy', () => {
    // `paths.ts` used to inline the portability default in its read-root list.
    // A read root that disagrees with the directory the tool writes into is an
    // import that cannot read an export it just made.
    const box = sandbox();
    const roots = readRoots(box.env);
    assert.ok(roots.includes(storePath('portability', box.env)), 'portability read root drifted');
    assert.ok(roots.includes(storePath('backups', box.env)), 'backup read root drifted');
    assert.ok(roots.includes(storePath('exports', box.env)), 'export read root drifted');
  });
});
