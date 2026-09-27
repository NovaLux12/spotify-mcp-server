// Preconditions for the live harnesses, and a non-throwing spawn guard.
//
// #644: the three harness scripts each spawned `node --env-file=.env
// dist/index.js` and then waited out a full RPC timeout. In a clean clone node
// aborts on the missing `--env-file` target BEFORE the server is ever launched
// (exit 9), so the harness never saw a child, never saw an error, and reported
// the only thing it could — `Error: timeout: initialize` — thirty seconds
// later. The operator was told a server problem where the truth was a missing
// file, and `timeout: initialize` is the one message in this repo that names
// nothing to do next.
//
// Two halves, both fail-closed:
//
//   1. `collectMissing` measures what a run needs and names the fix. It is a
//      plain function over a tree, so a test can point it at a fixture; a
//      checker that has only ever been shown a correct tree has not been shown
//      to work.
//   2. `guardChild` attaches the `error` listener `spawn()` needs and a harness
//      never had. A spawn that fails to *start* (ENOENT, EACCES) emits
//      `error`; with no listener Node rethrows it, and the operator gets an
//      uncaught stack trace rather than a cause.
//
// Nothing here reads a credential's contents — this module stats paths. The
// one real `~/.spotify-mcp` file a harness may touch is the token, and
// `createHarnessHome` copies it rather than opening it.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { storeRegistry } from '../hermetic-home.mjs';

/**
 * Where the built server lives.
 *
 * The same rule `hermetic-home.mjs` uses to find the store registry, so a
 * harness's preflight and the spawn that follows it cannot disagree about which
 * build they are talking about. `SPOTIFY_MCP_DIST_ROOT` exists so a test can
 * point the helper at the REAL registry while the server it launches is a stub;
 * a preflight resolving the path any other way would check a build that is not
 * the one being run.
 */
export function distRootFor(root, env = process.env) {
  return env.SPOTIFY_MCP_DIST_ROOT || join(root, 'dist');
}

/**
 * Everything a live harness needs before it starts, as
 * `{ id, problem, fix }[]` — empty when the run may proceed.
 *
 * The order is the order an operator should fix things in, and the early
 * returns are load-bearing rather than cosmetic. The token path is *defined by*
 * the built registry (`src/config.ts` owns profile resolution), so with no
 * build there is nothing to check a token against; reporting a fabricated "no
 * token" next to "no build" would send someone to `npm run auth` when
 * `npm run build` is what they need.
 *
 * @param {object} options
 * @param {string} options.root              Repo root; the cwd the server is spawned from.
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {Promise<{ id: string, problem: string, fix: string }[]>}
 */
export async function collectMissing({ root, env = process.env } = {}) {
  const missing = [];
  const distRoot = distRootFor(root, env);
  const index = join(distRoot, 'index.js');
  const config = join(distRoot, 'config.js');

  if (!existsSync(index) || !existsSync(config)) {
    missing.push({
      id: 'build',
      problem: `no server build at ${distRoot} (${[index, config].filter((p) => !existsSync(p)).join(', ')} not found)`,
      fix: 'run `npm run build`',
    });
    return addClientId({ missing, root, env });
  }

  let tokenPath = null;
  let registryError = null;
  try {
    // Resolution, not a hand-typed `join(homedir(), '.spotify-mcp',
    // 'tokens.json')`: the server supports profiles and an explicit override,
    // so a hard-coded default would demand `npm run auth` from someone whose
    // token sits exactly where their profile puts it. That is why `src/config.ts`
    // exports this.
    const { storePath } = await storeRegistry();
    tokenPath = storePath('token', env);
  } catch (e) {
    registryError = e;
  }

  if (registryError) {
    // The file is present but does not load. A partial or stale `dist/` is the
    // usual cause, and this is NOT the same failure as "no build" — so it says
    // so instead of collapsing into one line.
    missing.push({
      id: 'registry',
      problem: `the built store registry at ${config} exists but could not be loaded: ${String(registryError?.message ?? registryError).replace(/\s+/g, ' ').slice(0, 160)}`,
      fix: 'run `npm run build`',
    });
    return addClientId({ missing, root, env });
  }

  if (!existsSync(tokenPath)) {
    missing.push({
      id: 'credentials',
      problem: `no Spotify token file at ${tokenPath}`,
      fix: 'run `npm run auth`',
    });
  }

  return addClientId({ missing, root, env });
}

/**
 * The client id has two possible sources and neither is required when the other
 * is present, so this checks that ONE of them exists rather than that `.env`
 * does. A maintainer who exports `SPOTIFY_CLIENT_ID` from their shell profile
 * has a working setup today and must not be told to create a file they do not
 * need — the unconditional `--env-file=.env` already broke them, which is a
 * large part of what #644 is about.
 */
function addClientId({ missing, root, env }) {
  const envFile = join(root, '.env');
  if (!existsSync(envFile) && !env.SPOTIFY_CLIENT_ID) {
    missing.push({
      id: 'client-id',
      problem: `missing .env (copy .env.example) at ${envFile}, and SPOTIFY_CLIENT_ID is not set in the environment either`,
      fix: 'cp .env.example .env and set SPOTIFY_CLIENT_ID, or export SPOTIFY_CLIENT_ID',
    });
  }
  return missing;
}

/**
 * The message a harness prints when it refuses to start.
 *
 * One block: every missing precondition, each with its fix. The point of #644
 * is that `timeout: initialize` names no cause; a list that names three causes
 * and three fixes is the replacement.
 */
export function formatFailure(label, missing) {
  // Nothing missing is nothing to report. Returning the empty string rather
  // than a `0 preconditions not met` banner means a caller that formats before
  // it has checked cannot print a refusal that refuses nothing.
  if (missing.length === 0) return '';
  const head = missing.length === 1 ? 'precondition not met' : `${missing.length} preconditions not met`;
  return (
    `${label}: ${head} — nothing was started.\n` +
    missing.map((m) => `  - ${m.problem}\n    fix: ${m.fix}\n`).join('') +
    `Prereqs, in order: npm run build && npm run auth.\n`
  );
}

/**
 * Refuse to start unless every precondition holds.
 *
 * `write` and `exit` are injectable so a test can drive this against a fixture
 * tree without spawning a process; both default to the real thing.
 */
export async function assertPreconditions({
  label = 'harness',
  root,
  env = process.env,
  write = (s) => process.stderr.write(s),
  exit = (code) => process.exit(code),
} = {}) {
  const missing = await collectMissing({ root, env });
  if (missing.length === 0) return [];
  write(formatFailure(label, missing));
  exit(1);
  return missing;
}

/**
 * Attach the listeners a spawned child needs and a harness never had.
 *
 * `spawn()` reports a failure to *start* — ENOENT, EACCES, ENOMEM — as an
 * `error` event, and Node's default for an `error` with no listener is to throw
 * it. The second listener closes the other half: a child that dies with a
 * request in flight otherwise waits out the FULL rpc timeout and then reports
 * `timeout: <method>`, which `sweep-finalize.mjs` classifies as a quota stall.
 * A crashed server recorded as a quota stall is a confident reading of a
 * failure nobody measured.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {object} options
 * @param {string} [options.label]  Names the harness in the message.
 * @param {(err: Error) => void} [options.onFail]  Called once, on whichever comes first.
 * @returns {{ failure: () => Error | null, alive: () => boolean }}
 */
export function guardChild(child, { label = 'harness', onFail } = {}) {
  let failure = null;
  let exited = false;
  const fail = (err) => {
    // First cause wins. A child that cannot start also emits `exit`, and the
    // spawn error is the one that says why.
    if (failure) return;
    failure = err;
    try {
      onFail?.(err);
    } catch {
      /* a failure in the reporter is not the run's failure, and must not mask it */
    }
  };

  child.on('error', (err) => {
    fail(new Error(`${label}: could not start the server (${err.code ?? err.message})`));
  });
  child.on('exit', (code, signal) => {
    exited = true;
    // `close()` and a clean exit are ordinary; only an abnormal one is a cause.
    if (code === 0) return;
    fail(new Error(`${label}: the server ${signal ? `died on ${signal}` : `exited ${code}`} before answering`));
  });

  return { failure: () => failure, alive: () => !exited };
}
