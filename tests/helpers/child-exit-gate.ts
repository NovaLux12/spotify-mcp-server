/**
 * The gate behind #1404 / #1405: a test file that spawns its own child and
 * speaks JSON-RPC to it over stdio must be able to say how that child died.
 *
 * ## Why a scan and not three fixes
 *
 * #1366 fixed this class in the two files that happened to share a harness.
 * #1395 extracted `stdio-child.ts` and made it the correct way to do this. The
 * other instances were not migrated, and nothing required them to be, so the
 * class survived the fix. #1404 found the survivors; #1405 found a fifth shape
 * of the same mistake in a file that *had* an `exit` listener and discarded the
 * signal from its parameter list.
 *
 * A gate is the only thing that stops a sixth. Each fix is still worth making —
 * a fix tells the reader of *this* failure what happened, and the gate only says
 * the shape came back.
 *
 * ## What the rule is
 *
 * **A file in `tests/` that calls `spawn(` itself, and writes a JSON-RPC frame
 * to that child's stdin, must register an `on('exit')` listener whose second
 * parameter is the signal.** Two separate conditions, both load-bearing.
 *
 * *"whose second parameter is the signal"* is not redundant with "has an
 * `exit` listener". `wire-registry.ts` had one — `child.on('exit', (code) => …)`
 * — and that is exactly the #1405 defect: a signalled child has `code === null`,
 * so the message read "exited with code null" and named an exit status for a
 * kill. A gate that only counted listeners would have passed the file it was
 * written for.
 *
 * *Delegating to the shared helper is the remedy, not an exemption.* An earlier
 * draft of this rule accepted "imports `helpers/stdio-child.js`" as an
 * alternative, and that was a hole with a real file in it:
 * `tests/branding-notice-guard.test.ts` imports the module — for
 * `describeHostPressure` — while hand-rolling its own `spawn(` with its own
 * pending promise. A file can import the correct implementation and still not
 * use it. What makes delegation safe is that a delegating file has no `spawn(`
 * call of its own, so it cannot be in scope, and the helper's own exit listener
 * covers it. `tests/child-exit-gate.test.ts` asserts the helper is itself
 * compliant, which is what closes that loop.
 *
 * ## What the rule is not
 *
 * It is scoped to files that speak JSON-RPC, and that scoping is load-bearing
 * rather than convenient. `tests/guard-sweep-loop.test.ts` spawns a bash script
 * and asserts on its exit status, and it has a second spawn — a
 * `stdio: 'ignore'` `sleep 0.5` whose only job is to hold a lock — that has no
 * exit listener and needs none: it is killed in a `finally`, it issues no
 * request, and there is no promise for a death to reject. Requiring a listener
 * there would be a rule about spelling rather than about observability, and it
 * would be satisfied by a listener that records nothing.
 *
 * `spawnSync` / `execFileSync` are out of scope for the same reason: their
 * return value carries `status` and `signal` directly, and a `promisify`'d
 * `execFile` rejects on a signal kill. There is nothing to observe separately.
 *
 * ## Reading the rule as a function
 *
 * `classifySpawnSite` is exported and pure, and `tests/child-exit-gate.test.ts`
 * drives it against synthetic sources in both directions. A scan with no
 * negative fixture cannot fail, and this one is a scan.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `tests/`, so the scan reads the suite rather than a hand-maintained list. */
export const TESTS_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * `spawn(` but not `spawnSync(`, and not a method call like `child.spawn(`.
 *
 * The leading `[^\w.]` matters: without it `spawnSync(` matches too, and the
 * synchronous calls are exactly the ones with nothing to fix.
 */
const ASYNC_SPAWN = /(^|[^\w.])spawn\(/;

/** A JSON-RPC frame, which is what makes a dead child this file's problem. */
const JSONRPC = /jsonrpc/;

/** …written to the child's stdin, i.e. the child is being *asked* something. */
const STDIN_WRITE = /stdin\s*\.\s*(write|end)/;

const IMPORTS_SHARED_HELPER = /helpers\/stdio-child\.js/;

/**
 * An `exit` listener that names the signal.
 *
 * Matches `on('exit', (code, signal) => …)` and `on("exit", function (c, signal)
 * {…})` in one pass. Requiring the *second* parameter is the load-bearing part;
 * a one-parameter `(code) => …` is the #1405 shape and is exactly what this
 * must not accept.
 */
const EXIT_LISTENER_NAMING_SIGNAL =
  /on\(\s*['"]exit['"]\s*,\s*(?:async\s*)?(?:function\s*[^(]*|\(\s*[^)]*)?[^=]*?\bsignal\b/;

export type SpawnSiteVerdict = {
  /** Repo-relative, so a failure message names a file you can open. */
  readonly file: string;
  /** This file calls `spawn(` itself and speaks JSON-RPC to that child. */
  readonly inScope: boolean;
  /** Imports `helpers/stdio-child.ts`. Diagnostic, not an exemption. */
  readonly usesSharedHelper: boolean;
  /** Registers an `exit` handler that names the signal. */
  readonly exitListenerNamesSignal: boolean;
  readonly compliant: boolean;
  /** Populated only when `compliant` is false; the one line to act on. */
  readonly reason?: string;
};

/**
 * Classify one file's source. Pure: it reads nothing and decides from `source`
 * alone, so the regression test can drive it with fixtures that never existed
 * on disk.
 */
export function classifySpawnSite(file: string, source: string): SpawnSiteVerdict {
  const inScope = ASYNC_SPAWN.test(source) && JSONRPC.test(source) && STDIN_WRITE.test(source);
  const usesSharedHelper = IMPORTS_SHARED_HELPER.test(source);
  const exitListenerNamesSignal = EXIT_LISTENER_NAMING_SIGNAL.test(source);
  const compliant = !inScope || exitListenerNamesSignal;

  return {
    file,
    inScope,
    usesSharedHelper,
    exitListenerNamesSignal,
    compliant,
    // In-scope and non-compliant means no signal-naming listener exists.
    ...(compliant
      ? {}
      : {
        reason: 'calls `spawn()` itself and writes a JSON-RPC frame to that child\'s '
          + 'stdin, but registers no `on(\'exit\')` handler whose second parameter is '
          + 'the signal. A child killed mid-request settles nothing, so the request is '
          + 'reported as a timeout — which names a hang when the cause was a crash. '
          + 'Either wire `(code, signal) => …` and reject the pending map, or drop the '
          + 'hand-rolled harness for `helpers/stdio-child.ts`.',
      }),
  };
}

/** Every `.ts` under `tests/`, recursively, helpers included. */
export function testSourceFiles(root: string = TESTS_ROOT): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts')) out.push(path);
    }
  };
  walk(root);
  return out.sort();
}

/** Classify every file under `tests/`. */
export function scanTestSuite(root: string = TESTS_ROOT): SpawnSiteVerdict[] {
  return testSourceFiles(root).map((path) => classifySpawnSite(path, readFileSync(path, 'utf8')));
}
