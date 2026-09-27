/**
 * A disposable home for the live harness scripts (#1397).
 *
 * ## What this is for
 *
 * `scripts/live-gauntlet.mjs`, `scripts/live-e2e.mjs` and
 * `scripts/tool-gate-check.mjs` each spawned the real server with
 *
 *     spawn('node', ['--env-file=.env', 'dist/index.js'], { cwd, stdio })
 *
 * — no `env`, so `spawn` inherited the parent's **entire** environment, and the
 * child got the developer's real `$HOME`. The server resolves every local store
 * as `join(homedir(), '.spotify-mcp', …)` (`src/config.ts`), so a sweep the
 * scripts themselves call "safe" was writing into, and could delete from, the
 * one directory on the machine that is not scratch: `tokens.json`,
 * `accounts.json`, `search-history.json`, `freshness.json`, `taste-feedback.json`,
 * `cache.json`, `scenes.json`, and a `backups/` directory holding thousands of
 * accumulated files the harness did not create and cannot restore.
 *
 * The pre-existing mitigation was a **blocklist** — the gauntlet declines to
 * call `save_scene` / `delete_scene` / `cancel_wind_down`, and names them in its
 * `uncalled registry writes` audit line. That is the right call for those three
 * tools, and it is not the fix. A blocklist is only as good as the day it was
 * written: nothing about the spawn made a *local write* distinguishable from a
 * *Spotify API call*, so every tool added later that touches local state was
 * automatically inside the blast radius. This module makes the class
 * unreachable instead of enumerated.
 *
 * ## Why `HOME` and not the individual store variables
 *
 * Because every store default derives from `homedir()`, and `os.homedir()` on
 * POSIX reads `process.env.HOME` on every call. Redirecting `HOME` relocates all
 * eighteen at once, including the stores with no override of their own. This is
 * the same reasoning, and the same deliberate rejection of the per-store
 * alternative, as `tests/helpers/hermetic.ts` (#1274) — which is what caught the
 * test suite doing this to the real home in the first place.
 *
 * The per-store variables are pinned anyway, and the pinning is what makes the
 * override **structural** rather than a default that a stray variable can undo:
 *
 *   - every `SPOTIFY_MCP_*` the parent carries is **deleted**, so an inherited
 *     `SPOTIFY_MCP_BACKUP_DIR=/somewhere/real` cannot point a store outside the
 *     sandbox; and
 *   - every variable the store registry names is then **set** to a path under
 *     the sandbox. Node's `--env-file` does not override variables already in the
 *     environment, so a `SPOTIFY_MCP_*` line in `.env` cannot defeat the pin
 *     either — the child env wins.
 *
 * ## Fail-closed, and checked against the registry rather than a list
 *
 * `sandboxStorePins()` below is a table, and a table is exactly the kind of thing
 * that goes stale. Two things keep it honest:
 *
 *   1. {@link assertStoresInsideSandbox} runs before any harness spawns a child
 *      and **throws** if a single store in `LOCAL_STORES` resolves outside the
 *      sandbox. A wrong pin stops the sweep rather than silently writing home.
 *   2. It also throws when the registry names an `envVar` the table does not
 *      cover, so a store added tomorrow is a loud failure in CI, not a new
 *      unprotected path.
 *
 * The registry is read from the **built** `dist/config.js` rather than restated
 * here, so this module cannot drift from the server it is isolating. That build
 * is a hard requirement rather than a new one: every caller of
 * {@link spawnHarnessServer} already spawns `dist/index.js` out of the same tree.
 */
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The build whose store registry describes the server being isolated.
 *
 * `SPOTIFY_MCP_DIST_ROOT` is the same A/B knob `scripts/measure-startup.mjs`
 * uses to point at another build, and it is honoured here for one reason: the
 * registry must describe the `dist/index.js` the harness is about to spawn. It
 * is read by the HARNESS, never forwarded as configuration — the server has no
 * such variable, so a child cannot be steered by it.
 */
const DIST_ROOT = process.env.SPOTIFY_MCP_DIST_ROOT ?? join(REPO_ROOT, 'dist');

let registry;
async function storeRegistry() {
  if (registry) return registry;
  const entry = join(DIST_ROOT, 'config.js');
  if (!existsSync(entry)) {
    throw new Error(
      `hermetic-home: ${entry} is missing, so the local-store registry cannot be read and the ` +
        `sandbox cannot be verified. Run \`npm run build\` first, or point SPOTIFY_MCP_DIST_ROOT at a build.`,
    );
  }
  const { LOCAL_STORES, storePath } = await import(pathToFileURL(entry).href);
  registry = { LOCAL_STORES, storePath };
  return registry;
}

/** `mkdtempSync` prefixes must be safe as a single path segment. */
function safePrefix(label) {
  return String(label).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40) || 'harness';
}

/** The platform's path separator, which `relative()` uses to report `..`. */
const SEP = process.platform === 'win32' ? '\\' : '/';

/** Is `candidate` `root` itself, or something under it? Both resolved first. */
export function isInside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  // `..foo` is a legal directory name, so the check is for the `..` PATH
  // SEGMENT rather than the `..` prefix.
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${SEP}`) && !isAbsolute(rel));
}

/**
 * Every store variable, pinned to its documented default under `storeDir`.
 *
 * These are the `~/.spotify-mcp/...` defaults from `LOCAL_STORES`, transcribed
 * one for one. The one place a value is a **directory** rather than a file is
 * deliberate and commented below; the layout shift it causes is inside a
 * throwaway directory, whereas leaving the variable unset would leave a `.env`
 * line free to point it at the real home.
 */
export function sandboxStorePins(storeDir) {
  return {
    // The token file is the one store the harness genuinely needs from the real
    // home, and it is pinned at the COPY `createHarnessHome` writes — never at
    // the live one, because token refresh writes back to whatever this names.
    SPOTIFY_MCP_TOKEN_FILE: join(storeDir, 'tokens.json'),
    // Deliberately NOT seeded (see createHarnessHome). Pinned to an empty
    // sandbox path so a `.env` line cannot make the server read an account
    // registry that points token files back at the real home.
    SPOTIFY_MCP_ACCOUNTS_FILE: join(storeDir, 'accounts.json'),
    SPOTIFY_MCP_HISTORY_DIR: join(storeDir, 'history'),
    // Receipts resolve as `RECEIPTS_DIR ?? HISTORY_DIR ?? storeDir`, so naming
    // the store dir here reproduces the documented `storeDir/receipts.jsonl`
    // rather than inheriting `history/receipts.jsonl` from the line above.
    SPOTIFY_MCP_RECEIPTS_DIR: storeDir,
    SPOTIFY_MCP_SCENES_FILE: join(storeDir, 'scenes.json'),
    SPOTIFY_MCP_GENRE_TAGS_FILE: join(storeDir, 'genre-tags.json'),
    SPOTIFY_MCP_PLAYBACKEXT_FILE: join(storeDir, 'playback-ext.json'),
    SPOTIFY_MCP_SEARCH_HISTORY_FILE: join(storeDir, 'search-history.json'),
    // Shared by three rows with three different defaults. `storeDir` is what
    // two of them (artist-watchlist, taste-feedback) want. The third,
    // playlist-health snapshots, would default to `storeDir/playlist-snapshots`
    // and lands in `storeDir` instead — the exact layout shift
    // `src/config.ts` warns about, kept because an unset variable is a hole and
    // the directory it lands in is discarded with the sandbox.
    SPOTIFY_MCP_DATA_DIR: storeDir,
    SPOTIFY_MCP_TASTE_FEEDBACK_FILE: join(storeDir, 'taste-feedback.json'),
    SPOTIFY_MCP_FRESHNESS_STATE: join(storeDir, 'freshness.json'),
    SPOTIFY_MCP_EXHAUST2_PLAYBACK_FILE: join(storeDir, 'exhaust2-playback.json'),
    SPOTIFY_MCP_EXHAUST2_MISC_FILE: join(storeDir, 'exhaust2-misc.json'),
    SPOTIFY_MCP_BACKUP_DIR: join(storeDir, 'backups'),
    SPOTIFY_MCP_SNAPSHOT_DIR: join(storeDir, 'playlist-snapshots'),
    SPOTIFY_MCP_PORTABILITY_DIR: join(storeDir, 'portability'),
    SPOTIFY_MCP_EXPORT_DIR: join(storeDir, 'exports'),
  };
}

/**
 * Throws unless every store in the registry resolves inside `home` under `env`.
 *
 * This is the real comparison, not a spot check: it asks the server's own
 * resolver where each of the eighteen stores would land, given the environment
 * the child is about to be spawned with, and requires all of them to be under
 * the sandbox. A pin that is wrong, a store added without a pin, or an `env` that
 * never got its `HOME` redirected all stop the harness here.
 */
export async function assertStoresInsideSandbox(env, home) {
  const { LOCAL_STORES, storePath } = await storeRegistry();
  const pins = sandboxStorePins(join(home, '.spotify-mcp'));
  const uncovered = [...new Set(LOCAL_STORES.map((s) => s.envVar))].filter((v) => !(v in pins));
  if (uncovered.length > 0) {
    throw new Error(
      `hermetic-home: the store registry names ${uncovered.join(', ')}, which sandboxStorePins() does not ` +
        `cover. A harness child would resolve ${uncovered.length === 1 ? 'it' : 'them'} through an inherited or ` +
        `.env-supplied value. Add the pin(s) before running a sweep.`,
    );
  }
  const escaped = LOCAL_STORES.filter((s) => !isInside(home, storePath(s.id, env))).map((s) => `${s.id} → ${storePath(s.id, env)}`);
  if (escaped.length > 0) {
    throw new Error(
      `hermetic-home: refusing to spawn a server whose local stores resolve outside ${home}:\n  ` +
        escaped.join('\n  ') +
        `\nA harness that writes outside its sandbox is a write to the developer's real ~/.spotify-mcp.`,
    );
  }
  return true;
}

/**
 * Build a disposable home and the child environment that is confined to it.
 *
 * @param {object} [options]
 * @param {string} [options.label]  Shown in the temp directory name.
 * @param {NodeJS.ProcessEnv} [options.realEnv]  The environment to seed
 *   credentials from and to measure the "before" against. Defaults to this
 *   process's, which is the developer's own.
 */
export async function createHarnessHome({ label = 'harness', realEnv = process.env } = {}) {
  const home = mkdtempSync(join(tmpdir(), `spotify-mcp-${safePrefix(label)}-`));
  const storeDir = join(home, '.spotify-mcp');
  mkdirSync(storeDir, { recursive: true });

  const env = { ...realEnv };
  // Drop every SPOTIFY_MCP_* the parent carries. This is a PREFIX rule, not the
  // registry's list, so a store added tomorrow under the same convention is
  // covered without an edit — and it is what stops an inherited
  // `SPOTIFY_MCP_BACKUP_DIR` from surviving the redirect below.
  for (const key of Object.keys(env)) {
    if (key.startsWith('SPOTIFY_MCP_')) delete env[key];
  }
  // Measurement bookkeeping, not configuration. `node --test
  // --experimental-test-coverage` puts a `NODE_V8_COVERAGE` directory in the
  // environment of every process it starts, and a spawned server that collects
  // into it has its coverage merged into the report — under `<repo>/dist`,
  // which is the COMPILED mirror of every `src` module. That double-counts the
  // whole codebase at a second path and drags the global line figure under the
  // gate, for a file nobody is trying to cover.
  //
  // The variable is set to the EMPTY STRING, not deleted, and that is not a
  // stylistic choice. Deleting the key from the env object does NOT stop the
  // child: Node re-injects `NODE_V8_COVERAGE` into the environment of a process
  // spawned from a coverage-instrumented parent, so the child collects anyway
  // (verified on Node 24 — a spawn with `env: {}` still collected). An empty
  // value is falsy to the collector and does suppress it.
  env.NODE_V8_COVERAGE = '';
  // The structural half: every `join(homedir(), '.spotify-mcp', …)` default now
  // resolves under the sandbox. `USERPROFILE` is the Windows spelling and CI
  // runs there, exactly as `tests/helpers/hermetic.ts` does it.
  env.HOME = home;
  env.USERPROFILE = home;
  Object.assign(env, sandboxStorePins(storeDir));

  // Credentials: ONE file, copied in.
  //
  // The harness has to authenticate to be worth running, and the token file is
  // the only thing it genuinely needs from the real home. It is COPIED, never
  // referenced — a token file is rewritten in place on refresh, so pointing the
  // child at the live one would move a write hazard rather than remove it. The
  // copy is the one file that arrives with 0600, as the original had.
  //
  // `accounts.json` is deliberately NOT copied. It names token files by path, and
  // a copied registry pointing at `~/.spotify-mcp/tokens.json` would let a token
  // refresh write the real file — reintroducing the hazard through the fix. A
  // sandbox with no account registry runs as the default account, which is the
  // account every seed read in the gauntlet already uses.
  const { storePath } = await storeRegistry();
  const liveToken = storePath('token', realEnv);
  const tokenFile = env.SPOTIFY_MCP_TOKEN_FILE;
  let seeded = null;
  if (existsSync(liveToken)) {
    copyFileSync(liveToken, tokenFile);
    chmodSync(tokenFile, 0o600);
    seeded = tokenFile;
  }

  await assertStoresInsideSandbox(env, home);

  return {
    home,
    storeDir,
    env,
    tokenFile,
    /** The copied token file, or null when the developer has not run `npm run auth`. */
    seeded,
    cleanup() {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/**
 * Spawn the real server into a fresh sandbox. The only supported way for a
 * harness script to start `dist/index.js`.
 *
 * The environment is assembled here rather than at each call site so a future
 * harness cannot spawn the server without it: there is no `spawn` left in
 * `scripts/` to copy. `tests/harness-hermetic-home.test.ts` fails if one
 * reappears.
 *
 * @param {object} options
 * @param {string} options.label
 * @param {string[]} options.args
 * @param {string} [options.cwd]
 * @param {string[]} [options.stdio]
 * @param {Record<string, string>} [options.env]  Extra variables layered on
 *   top of the sandbox (a client id, a toolsets selection). Deliberately
 *   possible and deliberately re-checked: an override that would point a store
 *   outside the sandbox makes {@link assertStoresInsideSandbox} throw here, so
 *   the escape hatch cannot become the hole.
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, sandbox: object }>}
 */
export async function spawnHarnessServer({
  label,
  args,
  cwd = REPO_ROOT,
  stdio = ['pipe', 'pipe', 'inherit'],
  env: extraEnv,
}) {
  const sandbox = await createHarnessHome({ label });
  if (extraEnv) {
    Object.assign(sandbox.env, extraEnv);
    // Re-run the containment check on the MERGED environment, not the one the
    // pins produced. An `extraEnv` that reassigns `HOME` or a store variable is
    // the one way a caller could undo all of the above, so it gets the same
    // fail-closed treatment rather than trust.
    await assertStoresInsideSandbox(sandbox.env, sandbox.home);
  }
  // stderr, not stdout: the gauntlet parses its own stdout into a report, and a
  // sandbox banner is diagnostic rather than coverage.
  process.stderr.write(
    `hermetic-home: ${label} server sandbox ${sandbox.home}\n` +
      `  ${sandbox.seeded ? 'token file copied in (read-only from here; writes stay here)' : 'no token file found — run `npm run auth` first'}\n`,
  );
  const child = spawn(process.execPath, args, { cwd, stdio, env: sandbox.env });
  // The sandbox is disposable and holds only copies, so it goes with the harness
  // on every exit path — including a signal, which is what a quota-wall abort is.
  process.once('exit', sandbox.cleanup);
  return { child, sandbox };
}
