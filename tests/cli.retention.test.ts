/**
 * The startup retention sweep belongs to the shared entry point (#703, #606).
 *
 * ## The defect this file exists to prevent
 *
 * `pruneHistoryLedgers` used to be called from `startMcpServer`, in `src/index.ts`.
 * #606 gave the CLI subcommands (`tools`, `call`, `watch`, `export`) a SECOND
 * entry point onto the same registry — `openCliSession` in `src/cli/session.ts` —
 * and it does not go through `startMcpServer`, so a sweep that stayed there is a
 * sweep only the server path runs. The user whose entire relationship with this
 * package is `spotify-mcp export` would never age a ledger out, and the gap is
 * invisible: nothing errors, nothing logs, the ledger just grows.
 *
 * The resolution is to call it from `resolveServerScope` (`src/server.ts`), the one
 * derivation BOTH entry points make before they hold a registry. So the property
 * worth pinning is not "the string appears in server.ts" — it is that *deriving a
 * scope sweeps the ledger*, whoever asked for the scope.
 *
 * ## What these tests hold, and why they are not all string-matching
 *
 * 1. A BEHAVIOURAL test drives the real `resolveServerScope` against a real
 *    over-cap ledger on disk and asserts the rows were dropped. This is the one
 *    that fails if the call is deleted from the function body, and it fails for
 *    the right reason: the rows are still there.
 * 2. A structural test pins WHERE the call may live, so a later edit cannot
 *    re-split it (back into `index.ts` only, or into both files at once, which
 *    would double-sweep). Double-sweeping is not harmless-by-accident: it is
 *    redundant I/O on every boot, and the "exactly once per process" property is
 *    what makes the placement safe to reason about.
 * 3. A guard that the sweep is still fire-and-forget and still cannot set an exit
 *    code — the property that makes it safe to run from a command that exits.
 *
 * ## Why the behavioural test can observe a fire-and-forget promise
 *
 * `void import('./history.js').then(...)` is not awaited, so a test that called
 * `resolveServerScope` and immediately read the file back would be racing it.
 * The wait here polls the ledger to a deadline and fails with the observed
 * contents on timeout. That is deliberate: the alternative — asserting only on
 * source text — would pass unchanged if the call were made unreachable, and this
 * is exactly the §6 failure mode (a test that cannot fail is worse than none).
 *
 * ## Hermeticity
 *
 * `helpers/hermetic.js` is imported FIRST, before any src import, so the default
 * `~/.spotify-mcp` resolves to a temp root for the whole process. Every store
 * below is additionally pointed at a per-test temp dir, so even a resolver that
 * ignored HOME could not reach user data. This matters more here than in most
 * files: the code under test *writes*, by design.
 */
import './helpers/hermetic.js';

process.env.SPOTIFY_CLIENT_ID = 'test-client-id';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveServerScope } from '../src/server.js';
import { __resetHistoryWriteState, readHistory } from '../src/history.js';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAY_MS = 86_400_000;

/** How long the fire-and-forget sweep is given to land before the test calls it missed. */
const SWEEP_TIMEOUT_MS = 5_000;
const SWEEP_POLL_MS = 25;

let scratch = '';

/** The env keys the history stores read, so one test cannot hand its values to the next. */
const HISTORY_ENV_KEYS = [
  'SPOTIFY_MCP_HISTORY',
  'SPOTIFY_MCP_HISTORY_DIR',
  'SPOTIFY_MCP_HISTORY_MAX_ROWS',
  'SPOTIFY_MCP_HISTORY_MAX_BYTES',
  'SPOTIFY_MCP_HISTORY_RETENTION_DAYS',
  'SPOTIFY_MCP_TOKEN_FILE',
  'SPOTIFY_MCP_TOOLSETS',
  'SPOTIFY_MCP_ENABLE_TOOLS',
  'SPOTIFY_MCP_DISABLE_TOOLS',
  'SPOTIFY_MCP_STATSFM',
  'SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS',
  'SPOTIFY_MCP_READONLY',
] as const;

const savedEnv = new Map<string, string | undefined>();

/** One JSONL line as the writer would have written it, `daysOld` before now. */
function line(who: string, daysOld: number): string {
  return (
    JSON.stringify({
      ts: new Date(Date.now() - daysOld * DAY_MS).toISOString(),
      who,
      method: 'PUT',
      path: '/playlists/{id}/items',
    }) + '\n'
  );
}

/**
 * A fresh history dir with one account's token file, and every store pointed at
 * it. The account exists because its TOKEN file exists — that is how
 * `historyFilePaths` enumerates accounts, so the fixture has to make one.
 *
 * It deliberately does NOT create the ledger. Seeding is the caller's job, so a
 * test can assert about an account that has never mutated anything without the
 * fixture having already created the file whose absence is the point.
 */
async function sandbox(
  env: Record<string, string> = {},
): Promise<{ dir: string; historyDir: string; ledger: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'cli606-retention-'));
  const historyDir = join(dir, 'history');
  await mkdir(historyDir, { recursive: true, mode: 0o700 });
  const tokenFile = join(dir, 'tokens.json');
  await writeFile(tokenFile, '{}', { encoding: 'utf8', mode: 0o600 });
  const ledger = join(historyDir, 'mutations.jsonl');

  process.env.SPOTIFY_MCP_HISTORY = '1';
  process.env.SPOTIFY_MCP_HISTORY_DIR = historyDir;
  process.env.SPOTIFY_MCP_TOKEN_FILE = tokenFile;
  for (const key of ['SPOTIFY_MCP_HISTORY_MAX_ROWS', 'SPOTIFY_MCP_HISTORY_MAX_BYTES', 'SPOTIFY_MCP_HISTORY_RETENTION_DAYS']) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  // The per-file shape cache is process-scoped; a row count measured for a
  // previous temp dir must never be handed to this one.
  __resetHistoryWriteState();
  return { dir, historyDir, ledger };
}

/** Write the default account's ledger, the way the append path would have. */
async function seed(ledger: string, rows: readonly string[]): Promise<void> {
  await writeFile(ledger, rows.join(''), { encoding: 'utf8', mode: 0o600 });
}

/** The `who` of every record currently on the ledger, oldest-first. */
async function whosOnDisk(ledger: string): Promise<string[]> {
  return (await readHistory({ file: ledger, limit: 100 })).map((r) => String(r.who));
}

/**
 * Poll until the ledger satisfies `settled`, or give up and report what is
 * actually on it.
 *
 * The sweep is deliberately not awaited by `resolveServerScope`, so observing it
 * means waiting for it. A timeout here is the assertion failing, and the rows
 * returned are what the message shows — which is the whole diagnostic.
 *
 * `settled` takes the rows rather than re-reading them. An earlier draft read
 * the ledger, then asked a predicate that read it AGAIN, and returned the first
 * read: when the sweep landed in the gap between them, the predicate saw a
 * swept ledger, reported "settled", and the test asserted against the pre-sweep
 * rows it had read a moment earlier. It passed when the file was slow and failed
 * when it was fast, which is the worst possible shape for a test — it was
 * asserting on a value that was already stale by the time it decided to stop.
 * One read, one decision.
 */
async function waitForSweep(ledger: string, settled: (whos: string[]) => boolean): Promise<string[]> {
  const deadline = Date.now() + SWEEP_TIMEOUT_MS;
  for (;;) {
    const whos = await whosOnDisk(ledger);
    if (settled(whos)) return whos;
    if (Date.now() >= deadline) return whos;
    await new Promise((resolve) => setTimeout(resolve, SWEEP_POLL_MS));
  }
}

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'cli606-retention-root-'));
  for (const key of HISTORY_ENV_KEYS) savedEnv.set(key, process.env[key]);
});

after(async () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

describe('the startup retention sweep rides the shared entry point', () => {
  it('expires an over-age ledger when a scope is derived, with no caller asking for it', async () => {
    // A 30-day window with one row 400 days old and one 2 days old. The ages
    // are far from the boundary on both sides: a row seeded exactly ON the TTL
    // expires or survives by millisecond timing, which is a coin flip, not a
    // test. The window is also wide enough that the ROW cap (5000) cannot be
    // what drops anything, so the age cap is the only bound in play.
    const { dir, ledger } = await sandbox({ SPOTIFY_MCP_HISTORY_RETENTION_DAYS: '30' });
    try {
      await seed(ledger, [line('ancient', 400), line('recent', 2)]);
      const before = await whosOnDisk(ledger);
      assert.deepEqual(before, ['ancient', 'recent'], 'precondition: both rows are on disk');

      // No retention argument, no flag, nothing in the call that mentions #703.
      // This is the production call `startMcpServer` and `openCliSession` both make.
      await resolveServerScope({ announce: false });

      const after = await waitForSweep(ledger, (whos) => whos.length === 1);
      assert.deepEqual(
        after,
        ['recent'],
        'deriving a scope must expire the over-age record — the CLI entry point does not go through startMcpServer, so a sweep left there is a sweep the CLI never runs',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('enforces the row cap on the same path, not only the age cap', async () => {
    // The age window is disabled (0 → Infinity), so the ONLY bound that can
    // drop a row here is the row cap. Without this, a sweep that had
    // accidentally become age-only would still pass the test above.
    const { dir, ledger } = await sandbox({
      SPOTIFY_MCP_HISTORY_RETENTION_DAYS: '0',
      SPOTIFY_MCP_HISTORY_MAX_ROWS: '2',
    });
    try {
      await seed(ledger, [line('a', 2), line('b', 3), line('c', 4), line('d', 5)]);

      await resolveServerScope({ announce: false });

      const after = await waitForSweep(ledger, (whos) => whos.length === 2);
      assert.deepEqual(
        after,
        ['c', 'd'],
        'the row cap must bind on the startup path too, keeping the newest rows',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('sweeps a dormant profile no append of this process will ever reach', async () => {
    // The reason the sweep runs at startup at all: a profile the user stopped
    // using is exactly the ledger no later append can prune, because nothing
    // appends to it. Only the startup sweep expires it.
    const { dir, historyDir } = await sandbox({ SPOTIFY_MCP_HISTORY_RETENTION_DAYS: '30' });
    try {
      const dormant = join(historyDir, 'mutations.work.jsonl');
      await writeFile(join(dir, 'tokens.work.json'), '{}', { encoding: 'utf8', mode: 0o600 });
      await writeFile(dormant, [line('dormant-ancient', 400)].join(''), { encoding: 'utf8', mode: 0o600 });

      await resolveServerScope({ announce: false });

      const after = await waitForSweep(dormant, (whos) => whos.length === 0);
      assert.deepEqual(after, [], "a dormant account's ledger must still be expired at startup");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not create a ledger for an account that has never mutated anything', async () => {
    // #703's own guard: a prune with nothing to prune must not touch the disk,
    // because the sweep runs on EVERY boot. A version that wrote an empty
    // mutations.jsonl for every account with a token file would litter the state
    // directory of every install on every start. The token file EXISTS here (the
    // sandbox makes one), so "this account is known but has never mutated" is
    // exactly the state that must leave no trace.
    const { dir, ledger } = await sandbox({ SPOTIFY_MCP_HISTORY_RETENTION_DAYS: '30' });
    try {
      await assert.rejects(readFile(ledger, 'utf8'), 'precondition: no ledger exists before the sweep');

      await resolveServerScope({ announce: false });
      // Let the sweep's window pass; if it were going to write, this is when.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await assert.rejects(readFile(ledger, 'utf8'), 'a sweep with nothing to prune must not create a ledger');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the sweep is placed once, and stays advisory', () => {
  const read = (rel: string): Promise<string> => readFile(join(ROOT_DIR, rel), 'utf8');

  it('lives in resolveServerScope, which both entry points call', async () => {
    const [server, index, session] = await Promise.all([
      read('src/server.ts'),
      read('src/index.ts'),
      read('src/cli/session.ts'),
    ]);

    // The call itself, in the file both entry points reach through.
    assert.match(
      server,
      /pruneHistoryLedgers/,
      'src/server.ts must own the startup sweep — it is the only derivation both startMcpServer and openCliSession make',
    );
    // Present exactly once in src/: a sweep in two files is a double sweep on
    // every boot, and "exactly once per process" is what makes it safe to place
    // on a path a CLI subcommand also runs.
    const calls = [server, index, session].filter((text) => /pruneHistoryLedgers/.test(text));
    assert.equal(
      calls.length,
      1,
      'the startup sweep must be called from exactly one file — index.ts (server path only) and cli/session.ts (CLI path only) are each a way to have it run for one caller and not the other',
    );
    assert.doesNotMatch(
      index,
      /pruneHistoryLedgers/,
      'src/index.ts must not sweep: startMcpServer is not on the CLI path, so a sweep here is a sweep `spotify-mcp export` never runs',
    );
    assert.doesNotMatch(
      session,
      /pruneHistoryLedgers/,
      'src/cli/session.ts must not sweep: the sweep belongs to the shared derivation, or the server path loses it',
    );
  });

  it('cannot fail a boot and cannot set an exit code', async () => {
    const server = await read('src/server.ts');
    // The `void` is what makes it fire-and-forget: an awaited sweep would put a
    // filesystem round trip on the path to a `tools/list`.
    assert.match(server, /void import\('\.\/history\.js'\)/, 'the sweep must stay fire-and-forget (void), not awaited');
    // A CLI subcommand's exit code is set from its return value. A rejected
    // sweep reaching the dispatcher's catch would turn a successful `export`
    // into a non-zero exit over a best-effort retention pass.
    assert.match(
      server,
      /\.catch\(\(\) => \{[\s\S]*?\}\);/,
      'the sweep promise must keep its catch — retention is best-effort and an unhandled rejection would fail a CLI subcommand',
    );
    // And nothing in the module it pulls in may assign process.exitCode.
    const history = await read('src/history.ts');
    assert.doesNotMatch(
      history,
      /process\.exit(Code)?\s*[=(]/,
      'history.ts must never touch the exit code — it is imported by an entry point whose exit code is a contract',
    );
  });
});
