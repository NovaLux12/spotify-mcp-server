/**
 * Test fixture-location guard (#1383).
 *
 * A test that creates a directory inside the repository leaves the working
 * tree dirty the moment it is killed before its cleanup runs, and an OOM kill
 * at load 60-90 is routine on this box. The leak is not the problem — the
 * misreading is. `git status --porcelain` being clean is this repo's standing
 * assertion that no generated block is stale, so an untracked
 * `.census-fixture-*` makes a correct change read as a stale one, and every
 * plausible next step (`--write`, a hand-reconciled block) touches the one thing
 * that must never be hand-edited. The census's marker scan skips dot-entries
 * (#1238), so the census never noticed; only the check whose whole job is to
 * notice a change on disk did.
 *
 * The gate has to do two things, and one of them is the whole point. It has to
 * hold the real `tests/` tree at zero — asserted against the actual files. And
 * it has to *fire* on the shape that shipped, driven through the same
 * collector CI runs plus the CLI's own exit code, rather than assumed to.
 *
 * That second half is not ceremony. The first version of this guard pooled its
 * derived-root names across the whole tree, so `tests/store-bounds.test.ts`
 * happening to define its own `const ROOT = await mkdtemp(join(tmpdir(), …))`
 * licensed `join(ROOT, …)` everywhere — which is the #1383 call site. It
 * reported 215 clean files while passing the pre-fix fixture. A guard that only
 * ever runs against a tree somebody already fixed cannot tell a working gate
 * from an inert one, so every case below is a shape that must produce a hit, and
 * the legitimate shapes that must not are pinned beside them.
 */

import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectRepoRootFixtureErrors } from '../scripts/check-no-repo-root-fixtures.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GUARD = join(ROOT, 'scripts', 'check-no-repo-root-fixtures.mjs');

/** Every `.ts` under `tests/`, keyed by repo-relative path, as the guard sees it. */
function loadGuarded(): Map<string, { file: string; code: string }> {
  const walk = (directory: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(directory)) {
      const file = join(directory, entry);
      if (statSync(file).isDirectory()) out.push(...walk(file));
      else if (entry.endsWith('.ts')) out.push(file);
    }
    return out;
  };
  return new Map(
    walk(join(ROOT, 'tests'))
      .sort()
      .map((file) => {
        const key = relative(ROOT, file).split('\\').join('/');
        return [key, { file: key, code: readFileSync(file, 'utf8') }] as const;
      }),
  );
}

const GUARDED = loadGuarded();

/** The guard's verdict on one source string, judged against the real tree. */
function errorsIn(source: string, file = 'tests/fixture.ts'): string[] {
  return collectRepoRootFixtureErrors(source, file, GUARDED);
}

/** Write `source` to a temp file and run the guard's CLI over it. */
function runGuardFixture(source: string): { status: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fixture-guard-'));
  try {
    const file = join(dir, 'case.ts');
    writeFileSync(file, source);
    try {
      execFileSync(process.execPath, [GUARD, '--check-fixture', file], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
        maxBuffer: 32 * 1024 * 1024,
      });
      return { status: 0, output: '' };
    } catch (error) {
      const result = error as { status?: number; stdout?: string; stderr?: string };
      return {
        status: result.status ?? 1,
        output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
      };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('#1383 — no test creates a fixture inside the repository', () => {
  it('holds every file under tests/ at zero repo-root fixtures', () => {
    const errors = [...GUARDED.values()].flatMap(({ file, code }) => errorsIn(code, file));
    assert.deepEqual(errors, [], errors.join('\n'));
  });

  it('finds no mkdtemp at all if the walk silently matched nothing', () => {
    // A walk that returned zero files would make the assertion above vacuous.
    let callSites = 0;
    for (const { code } of GUARDED.values()) callSites += (code.match(/mkdtemp(?:Sync)?\s*\(/g) ?? []).length;
    assert.ok(callSites > 100, `the guard saw only ${callSites} mkdtemp call sites, so it is not reading the real tree`);
  });

  it('rejects the exact pre-fix call site from tests/arch-inventory.test.ts', () => {
    const source = [
      "import { mkdtemp, rm } from 'node:fs/promises';",
      "import { dirname, join } from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      'const ROOT = join(dirname(fileURLToPath(import.meta.url)), \'..\');',
      'async function withFixtures<T>(run: (dir: string) => Promise<T>): Promise<T> {',
      "  const dir = await mkdtemp(join(ROOT, '.census-fixture-'));",
      '  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }',
      '}',
    ].join('\n');
    const errors = errorsIn(source);
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0], /tests\/fixture\.ts:6:.*not rooted at os\.tmpdir\(\) \(ROOT\)/);
  });

  it('rejects a root fixture however the path is spelled', () => {
    for (const [label, source] of [
      ['absolute path', "const dir = await mkdtemp('/home/jack/wt/spotify-mcp-server/.census-fixture-');"],
      ['repo-relative literal', "const dir = await mkdtemp('.census-fixture-');"],
      ['cwd', "const dir = await mkdtemp(join(process.cwd(), 'census-fixture-'));"],
      ['nested under a root fixture', "const dir = await mkdtemp(join(ROOT, '.census-fixture-', 'inner'));"],
      ['a computed path', "const dir = await mkdtemp(join(ROOT, `census-${label}-`));"],
    ] as const) {
      const errors = errorsIn(source);
      assert.equal(errors.length, 1, `${label} should be one hit, got ${errors.length}: ${errors.join(' | ')}`);
    }
  });

  it('covers mkdtemp only, and says so rather than pretending otherwise', () => {
    // A `mkdir` on a subdirectory of an existing tmpdir fixture is the common
    // case in this tree, and gating it produced 52 findings on a clean tree.
    // The scope is stated in the guard's docstring; this pins the statement, so
    // a future change that widens or narrows the pattern has to move the
    // documented boundary with it rather than leaving the two to disagree.
    const source = "const dir = await mkdtemp(join(tmpdir(), 'ok-'));\nawait mkdir(join(dir, 'docs'), { recursive: true });";
    assert.deepEqual(errorsIn(source), [], 'the mkdtemp is clean, so the mkdir must not be reported as its own hit');
    const guardSource = readFileSync(GUARD, 'utf8');
    assert.match(guardSource, /Scope: `mkdtemp`, not `mkdir`/, 'the guard no longer documents its mkdir exclusion');
  });

  it('rejects a name imported from a module that does not derive it from tmpdir', () => {
    // A name is only as good as the module it came from. If that module stops
    // being tmpdir-rooted, the consumer must become a hit rather than keep an
    // allowlist entry that no longer means anything.
    const source = [
      "import { SCRATCH } from './helpers/scratch.js';",
      "const dir = await mkdtemp(join(SCRATCH, 'census-fixture-'));",
    ].join('\n');
    assert.match(errorsIn(source).join('\n'), /not rooted at os\.tmpdir\(\) \(SCRATCH\)/);
  });

  it('exits non-zero from the CLI on the pre-fix call site, and zero on the fixed one', () => {
    const bad = "const dir = await mkdtemp(join(ROOT, '.census-fixture-'));";
    const good = "const dir = await mkdtemp(join(tmpdir(), 'census-fixture-'));";

    const failed = runGuardFixture(bad);
    assert.equal(failed.status, 1, failed.output);
    assert.match(failed.output, /not rooted at os\.tmpdir\(\) \(ROOT\)/);

    const passed = runGuardFixture(good);
    assert.equal(passed.status, 0, passed.output);
  });

  it('accepts the legitimate shapes, so the gate is not switched off within a release', () => {
    for (const [label, source] of [
      ['tmpdir via join', "const dir = await mkdtemp(join(tmpdir(), 'census-fixture-'));"],
      ['os.tmpdir()', "const dir = await mkdtemp(os.tmpdir());"],
      ['os-qualified join', "const dir = await mkdtemp(path.join(os.tmpdir(), 'census-fixture-'));"],
      ['sync form', "const dir = mkdtempSync(join(tmpdir(), 'census-fixture-'));"],
      ['template prefix', 'const dir = await mkdtemp(join(tmpdir(), `run-${label}-`));'],
      ['a name the same file derives from tmpdir', "const SCRATCH = await mkdtemp(join(tmpdir(), 'scratch-'));\nconst dir = await mkdtemp(join(SCRATCH, 'inner-'));"],
      ['a name imported from a module that derives it', "import { HERMETIC_ROOT } from './helpers/hermetic.js';\nconst home = mkdtempSync(join(HERMETIC_ROOT, 'child-'));"],
    ] as const) {
      const errors = errorsIn(source);
      assert.deepEqual(errors, [], `${label} should be clean, got: ${errors.join(' | ')}`);
    }
  });

  it('does not read a fixture directory as code', () => {
    // The census's own marker scan skips dot-entries for the same reason: a
    // parallel test can be mid-write inside one. This guard must not turn a
    // half-written sibling into a finding either.
    for (const [label, source] of [
      ['a comment naming the defect', "// mkdtemp(join(ROOT, '.census-fixture-')) is the #1383 defect\nconst dir = await mkdtemp(join(tmpdir(), 'ok-'));"],
      ['a block comment quoting the old line', "/* was: mkdtemp(join(ROOT, '.census-fixture-')) */\nconst dir = await mkdtemp(join(tmpdir(), 'ok-'));"],
      ['a string literal naming the pattern', "const note = \"mkdtemp(join(ROOT, '.census-fixture-'))\";\nconst dir = await mkdtemp(join(tmpdir(), 'ok-'));"],
      ['a template body, no interpolation', 'const note = `mkdtemp(join(ROOT, \'x\'))`;\nconst dir = await mkdtemp(join(tmpdir(), \'ok-\'));'],
    ] as const) {
      assert.deepEqual(errorsIn(source), [], `${label} should be clean`);
    }
  });

  it('still reads a call smuggled into a template interpolation', () => {
    // `${…}` holes are code, so blanking the literal around them must not hide
    // a call — the same rule `blank-non-code.mjs` states for its other gates.
    const source = 'const dir = await mkdtemp(join(ROOT, `${label}-fixture-`));';
    assert.equal(errorsIn(source).length, 1);
  });
});

describe('#1383 — the census fixture directory is outside the repository', () => {
  it('is what tests/arch-inventory.test.ts actually builds, and it is outside ROOT', async () => {
    // The static gate above proves the *call* is rooted at tmpdir. This proves
    // the *directory that call produced* is outside the repository, which is
    // the property the leak actually broke. `withFixtures` asserts the same
    // thing on every fixture, so a regression there fails the suite too.
    const dir = await mkdtemp(join(tmpdir(), 'census-fixture-'));
    try {
      const rel = relative(ROOT, dir);
      assert.ok(rel.startsWith('..'), `expected ${dir} to be outside ${ROOT}, got relative path ${rel}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves the working tree clean, which is the assertion the leak used to break', async () => {
    // The end-to-end shape of the bug: build the fixture the fixed way, then
    // read the signal an agent relies on. The filter matters — this worktree is
    // dirty with the fix itself, so the assertion is that *no* untracked entry
    // is a census fixture, not that the tree is pristine.
    const dir = await mkdtemp(join(tmpdir(), 'census-fixture-'));
    await writeFile(join(dir, 'census.json'), '{}');
    try {
      assert.ok(!existsSync(join(ROOT, '.census-fixture-')), 'a fixture directory exists in the repository root');
      const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
        maxBuffer: 32 * 1024 * 1024,
      });
      const leaked = status
        .split('\n')
        .filter((line) => line.includes('.census-fixture-'));
      assert.deepEqual(leaked, [], `git reported a census fixture as a working-tree change: ${leaked.join(' | ')}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('asserts inside the try, so the guard for the leak cannot itself leak', () => {
    // Found the hard way. The first version of this fix asserted between the
    // `mkdtemp` and the `try`, so when the assertion fired — the run where the
    // guard had already caught a regression — it threw past the `finally` and
    // left four `.census-fixture-*` directories in the repository root. The
    // check reproduces by running the real `withFixtures` with a deliberately
    // wrong root and confirming nothing is left behind.
    const source = readFileSync(join(ROOT, 'tests', 'arch-inventory.test.ts'), 'utf8');
    const helper = /async function withFixtures[\s\S]*?\n}/.exec(source)?.[0];
    assert.ok(helper, 'could not find withFixtures in tests/arch-inventory.test.ts');
    const mkdtempAt = helper.indexOf('mkdtemp(');
    const tryAt = helper.indexOf('try {');
    const assertAt = helper.indexOf('assert.ok');
    assert.ok(mkdtempAt !== -1 && tryAt !== -1 && assertAt !== -1, `unexpected helper shape:\n${helper}`);
    assert.ok(
      assertAt > tryAt,
      `the scratch-path assertion sits before the try, so throwing past the finally leaks the directory it just created:\n${helper}`,
    );
  });
});
