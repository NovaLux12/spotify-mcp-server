/**
 * Hermetic test home (#1274).
 *
 * `npm test` used to write into the developer's real `$HOME/.spotify-mcp`:
 * every full-suite run dropped `playlistops-pre-src-*.json` files into the real
 * `backups/` directory and rewrote the real `freshness.json`. On the machine
 * this was reported from, that directory had grown to ~1,930 files and 8.0 MB,
 * four more per run, and the real watermark file was being clobbered by a test.
 *
 * **Why redirect `HOME` and not the individual store variables.** Every default
 * in this server is `join(homedir(), '.spotify-mcp', …)`, and `os.homedir()`
 * reads `process.env.HOME` on every call — including after a runtime mutation,
 * because Node's env setter goes through `setenv(3)`. Pointing `HOME` at a temp
 * root therefore relocates *all* of them at once, including the stores with no
 * override of their own (`playlisthealth.ts`, `artistwatch.ts`,
 * `statsfm_taste.ts` all fall straight through to `homedir()`).
 *
 * The alternative — setting `SPOTIFY_MCP_BACKUP_DIR`, `SPOTIFY_MCP_FRESHNESS_STATE`
 * and a dozen more per test — was rejected on purpose. Several tests exercise the
 * *fallback* deliberately: `tests/tools.freshness.test.ts` calls `whats_new`
 * with no env at all, which is exactly the code path that resolves
 * `join(homedir(), '.spotify-mcp', 'freshness.json')`. Setting an override
 * would have made those tests stop testing the default resolution, so the leak
 * would have been "fixed" by deleting the coverage. Redirecting `HOME` moves
 * the default; it does not bypass it. The assertion "with no override set, the
 * store lands under the home directory" still runs — it just lands somewhere
 * disposable.
 *
 * This module is imported for its side effect. `tests/hermetic-home.test.ts`
 * fails if any `tests/*.test.ts` omits it, so a new test file cannot
 * reintroduce the class of bug by being added without it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** The real `$HOME`, captured before the redirect. Never write under it. */
export const REAL_HOME = homedir();

/** The disposable home every store default resolves against during a test. */
export const HERMETIC_ROOT = mkdtempSync(join(tmpdir(), 'spotify-mcp-hermetic-'));

// `USERPROFILE` is the Windows spelling; the suite also runs there in CI, and
// several existing tests (`doctor-unification`, `tools.export`, `tools.portability`)
// already save and restore both names, so setting both keeps them consistent.
const previous: Record<string, string | undefined> = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
};

process.env.HOME = HERMETIC_ROOT;
process.env.USERPROFILE = HERMETIC_ROOT;

/**
 * Restore the caller's environment and drop the temp home on the way out.
 *
 * The restore is not strictly needed — the process is exiting — but a test that
 * reads `process.env.HOME` after this module loads should still see the
 * redirect, not a half-torn-down value, and it keeps the helper's contract
 * symmetrical: it sets the environment in one place and undoes it in one place.
 */
process.once('exit', () => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(HERMETIC_ROOT, { recursive: true, force: true });
});
