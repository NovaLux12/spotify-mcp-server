/**
 * The hermetic-home guard (#1274).
 *
 * `npm test` used to write into the developer's real `$HOME/.spotify-mcp`. A
 * full suite run dropped four `playlistops-pre-src-*.json` files into the real
 * `backups/` directory and rewrote the real `freshness.json`; the directory had
 * reached ~1,930 files and 8.0 MB. A test run that mutates a real user store is
 * not just untidy — a test that can pass because it overwrote real state is a
 * test that can pass for the wrong reason, and concurrent runs interleave into
 * one directory.
 *
 * Two things had to be true, and a guard that only does the first is decoration:
 *
 *  1. **No test writes outside a temp root.** Checked two ways, because they
 *     fail for different reasons. *Behaviourally*: the suites that actually
 *     reach a store-writing path are run again in child processes whose `HOME`
 *     is a pristine `mkdtemp` root, and that root must still be empty
 *     afterwards. *Structurally*: every `tests/*.test.ts` must import the
 *     hermetic helper, so a file added later cannot reintroduce the whole class
 *     of bug just by being added.
 *
 *  2. **The guard can go red.** Each half is driven against something that
 *     should trip it, because this repo has shipped a guard that trusted a
 *     precomputed verdict before and the fix pattern is to drive the
 *     comparison and then confirm it goes red. Three negative cases live here,
 *     and the first exists because the first draft of this file got it wrong —
 *     see `runs the suites rather than nesting a test runner` below.
 *
 * Every child gets a *pristine* `HOME` rather than this machine's real one. A
 * check that only fires when the developer happens to already have a
 * `~/.spotify-mcp` is a check that is silently inert on CI, where the directory
 * does not exist at all; making our own fresh root is the only version that
 * behaves the same everywhere.
 */
import { REAL_HOME } from './helpers/hermetic.js';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TESTS = join(ROOT, 'tests');

/**
 * The suites observed to actually write to a home-relative store, measured by
 * running each one against a pristine `HOME`: `tools.playlistwrite-receipts`
 * drops four `pre-src` backups through `backupDir()` (via `swarm3_playlistops`
 * and `exhaust2_playlists`), and `tools.freshness` rewrites the watermark
 * through `join(homedir(), '.spotify-mcp', 'freshness.json')`.
 *
 * Four further suites import those same writer modules —
 * `schema.playlist-params`, `tools.exhaust2playlists`, `error-param-names` and
 * `tools.hot-loop-maps` — and were measured writing nothing, so they are not
 * re-run here: at ~2-3s each they would quadruple this test's cost to cover
 * nothing. The structural half below is the general net; this list is the
 * direct regression check on the two that actually leaked.
 */
const LEAKING_SUITES = [
  'tools.playlistwrite-receipts.test.ts',
  'tools.freshness.test.ts',
] as const;

/** The import every test file must carry, in either the bare or `from` form. */
const HERMETIC_IMPORT =
  /(?:^|\n)\s*import\s+(?:['"]\.\/helpers\/hermetic\.js['"]|[\s\S]{0,120}?from\s+['"]\.\/helpers\/hermetic\.js['"])/;

/**
 * Files under `tests/` that do not load the hermetic home. Kept as a pure
 * function of (file list, reader) so the anti-vacuity case can drive it with
 * synthetic content instead of asserting against the same source it checks.
 */
export function filesMissingHermeticImport(
  files: readonly string[],
  read: (file: string) => string,
): string[] {
  return files.filter((file) => !HERMETIC_IMPORT.test(read(file)));
}

const realTestFiles = (): string[] =>
  readdirSync(TESTS)
    .filter((name) => name.endsWith('.test.ts'))
    .sort()
    .map((name) => join(TESTS, name));

/** Everything a pristine `HOME` ends up containing, as sorted relative paths. */
function contentsOf(root: string): string[] {
  const target = join(root, '.spotify-mcp');
  return existsSync(target) ? readdirSync(target, { recursive: true } as never).map(String).sort() : [];
}

/** Run `args` with a pristine `HOME`; the child's exit status is the signal. */
function runWithPristineHome(args: string[], home: string) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  // The child must see the *unset* defaults, not a redirect inherited from
  // whatever this process was configured with, or the checks below prove
  // nothing about the fallback path.
  for (const key of [
    'SPOTIFY_MCP_BACKUP_DIR',
    'SPOTIFY_MCP_FRESHNESS_STATE',
    'SPOTIFY_MCP_HISTORY_DIR',
    'SPOTIFY_MCP_PORTABILITY_DIR',
    'SPOTIFY_MCP_SNAPSHOT_DIR',
    'SPOTIFY_MCP_EXPORT_DIR',
  ]) {
    delete env[key];
  }
  const res = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8', timeout: 180_000 });
  if (res.error) throw res.error;
  return res;
}

describe('#1274 the test suite does not write into the real $HOME', () => {
  let scratch: string;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), 'hermetic-home-guard-'));
    // One suite per child process, the way the real runner isolates them. The
    // child takes the file to run as a `file://` URL in argv[2] rather than
    // `node --test`, because nesting a test runner inside a test file is a
    // silent no-op — see the anti-vacuity case below.
    writeFileSync(join(scratch, 'run-one-suite.mts'), 'await import(process.argv[2]);\n');
  });
  after(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('leaves a pristine HOME untouched when the store-writing suites run', () => {
    const home = mkdtempSync(join(tmpdir(), 'hermetic-home-pristine-'));
    try {
      const failures: string[] = [];
      for (const name of LEAKING_SUITES) {
        const res = runWithPristineHome(
          ['--import', 'tsx', join(scratch, 'run-one-suite.mts'), pathToFileURL(join(TESTS, name)).href],
          home,
        );
        if (res.status !== 0) failures.push(`${name} (exit ${res.status}):\n${res.stderr?.slice(-2000) ?? ''}`);
      }
      assert.deepEqual(failures, [], 'the store-writing suites must still pass when run against a temp HOME');

      assert.deepEqual(
        contentsOf(home),
        [],
        'these tests wrote into $HOME/.spotify-mcp, which on a developer machine is their real store. ' +
          'Every test file must import tests/helpers/hermetic.ts.',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('runs the suites rather than nesting a test runner', () => {
    // The first draft of this guard shelled out to `node --import tsx --test
    // <files>` from inside a test file. Node prints
    //
    //     Warning: node:test run() is being called recursively within a test
    //     file. skipping running files.
    //
    // and exits 0 having run nothing. The containment check therefore passed
    // against a pristine HOME because no suite ever executed — a guard that was
    // green for the wrong reason, on the exact bug it was written to catch. The
    // mutation check is what found it: removing the helper import turned the
    // structural half red and left the behavioural half suspiciously green.
    //
    // So the runner is pinned here. `node:test` exits non-zero when a test
    // fails, and this asserts that through the same `run-one-suite.mts` shim the
    // containment check uses, so a shim that silently runs nothing cannot
    // satisfy it.
    writeFileSync(
      join(scratch, 'deliberately-failing.test.ts'),
      "import { it } from 'node:test';\nit('fails', () => { throw new Error('deliberate'); });\n",
    );
    const res = runWithPristineHome(
      [
        '--import',
        'tsx',
        join(scratch, 'run-one-suite.mts'),
        pathToFileURL(join(scratch, 'deliberately-failing.test.ts')).href,
      ],
      mkdtempSync(join(tmpdir(), 'hermetic-home-scratch-')),
    );
    assert.notEqual(
      res.status,
      0,
      'the suite shim reported success for a suite that failed, so the containment check cannot ' +
        'distinguish "wrote nothing because it is clean" from "wrote nothing because it never ran"',
    );
  });

  it('would notice a real-home write on a machine where ~/.spotify-mcp does not exist', () => {
    // The other anti-vacuity case. The containment check above only has teeth
    // if a write landing in a fresh HOME is visible to it, and `~/.spotify-mcp`
    // does not exist on CI at all. So drive the real default through a real
    // write and confirm the same detection sees it.
    const home = mkdtempSync(join(tmpdir(), 'hermetic-home-probe-'));
    try {
      const probe = join(scratch, 'probe.mts');
      const backupModule = pathToFileURL(join(ROOT, 'src', 'tools', 'backup.ts')).href;
      writeFileSync(
        probe,
        [
          `import { mkdirSync, writeFileSync } from 'node:fs';`,
          `import { join } from 'node:path';`,
          `import { backupDir } from '${backupModule}';`,
          // No SPOTIFY_MCP_BACKUP_DIR anywhere: this is the default the suite
          // falls through to, and it is the exact path the guard must catch.
          `const dir = backupDir();`,
          `mkdirSync(dir, { recursive: true });`,
          `writeFileSync(join(dir, 'hermetic-guard-probe.json'), '{"probe":true}');`,
        ].join('\n'),
      );

      const res = runWithPristineHome(['--import', 'tsx', probe], home);
      assert.equal(res.status, 0, `the probe must run cleanly; stderr:\n${res.stderr?.slice(-2000) ?? ''}`);

      assert.ok(
        existsSync(join(home, '.spotify-mcp', 'backups', 'hermetic-guard-probe.json')),
        'the probe did not write through backupDir() into the pristine HOME, so the containment ' +
          'check is inert on a machine with no ~/.spotify-mcp — exactly the case CI runs in.',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('every test file loads the hermetic home', () => {
    const files = realTestFiles();
    // Not vacuous: an empty file list would make the assertion below pass
    // without checking anything.
    assert.ok(
      files.length > 100,
      `expected the whole suite under tests/, found only ${files.length} file(s) — the guard is not scanning what it claims to scan`,
    );

    const missing = filesMissingHermeticImport(files, (f) => readFileSync(f, 'utf8'));
    assert.deepEqual(
      missing.map((f) => f.replace(`${ROOT}/`, '')),
      [],
      'these test files do not import tests/helpers/hermetic.ts, so a store default resolved ' +
        'through homedir() can land in the real $HOME',
    );
  });

  it('reports a test file that omits the import, so the scan is not always green', () => {
    const withImport = 'import { describe, it } from "node:test";\nimport "./helpers/hermetic.js";\n';
    const named = 'import { describe, it } from "node:test";\nimport "./helpers/other.js";\n';
    const fixtures = ['a.test.ts', 'b.test.ts', 'c.test.ts'];
    const contents: Record<string, string> = { 'a.test.ts': withImport, 'b.test.ts': named, 'c.test.ts': withImport };

    assert.deepEqual(
      filesMissingHermeticImport(fixtures, (f) => contents[f]),
      ['b.test.ts'],
      'the scan failed to flag a file with no hermetic import, which is how a guard gets ignored',
    );
    assert.deepEqual(
      filesMissingHermeticImport(['a.test.ts', 'c.test.ts'], (f) => contents[f]),
      [],
      'the scan flagged files that do carry the import, which would make it unkeepable',
    );
  });

  it('the redirect is active in this process, so this file obeys the rule it enforces', () => {
    assert.notEqual(
      process.env.HOME,
      REAL_HOME,
      'HOME was not redirected in this test file, so this file is itself non-hermetic and the ' +
        'guard would be policing others while breaking the same rule',
    );
  });
});
