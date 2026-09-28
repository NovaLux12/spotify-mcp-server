/**
 * Duplicate-config-accessor guard (#1625).
 *
 * Three tool modules each declared their own module-scope
 * `const FETCH_ALL_CAP = () => getConfig().fetchAllCap` — byte-identical, each
 * carrying a comment saying it was the same as the others — so the name meant
 * two things: the environment variable, and a local re-binding of it. The
 * shared accessor now lives in `src/config.ts`; this is the check that makes the
 * fourth one a CI failure instead of a code review that has to notice.
 *
 * The test suite could not have caught it. Roughly ten test files reference
 * `FETCH_ALL_CAP`, and every one of them references the ENVIRONMENT VARIABLE in
 * a string — the contract, not the constant. A fourth copy of the declaration
 * passes every assertion in this repository. That is the reason a new gate
 * exists at all, and it is the reason this file exists to check the gate.
 *
 * A gate that has only ever agreed with the tree is decoration, so the weight
 * here is in the negative cases. Each one drives the REAL CLI — spawned, with its
 * real exit code, never the checked-in file, because `node:test` runs sibling
 * `describe`s concurrently and doctoring a source file would race them — against
 * a tree staged under `os.tmpdir()`:
 *
 *   - the exact fourth declaration, byte-for-byte the one that was removed;
 *   - the same declaration under a different NAME, because the rule is a shape
 *     rule and a name check would be defeated by the obvious response;
 *   - a function-local read, which is the ~40 legitimate call sites and must
 *     stay silent, or the gate gets switched off within a release;
 *   - a comment and a `.describe()` string naming the environment variable,
 *     which is most of what the string `FETCH_ALL_CAP` matches in `src/`;
 *   - an empty tree, and a tree with no `getConfig(` in it, because those are
 *     the two ways this gate can exit 0 while having learned nothing.
 *
 * Nothing here binds a port, spawns the server, or touches a real `$HOME`.
 */

import './helpers/hermetic.js';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collectDuplicateConfigAccessorErrors,
  collectReboundFields,
} from '../scripts/check-no-duplicate-config-accessors.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GUARD = join(ROOT, 'scripts', 'check-no-duplicate-config-accessors.mjs');

/** The declaration that shipped three times, verbatim, including its comment. */
const THE_FOURTH_DECLARATION = [
  '// Hard cap for fetch-all pagination loops (#55), same as playlists.ts.',
  'const FETCH_ALL_CAP = () => getConfig().fetchAllCap;',
  '',
].join('\n');

interface Run {
  status: number;
  output: string;
}

/** Drive the real CLI. Exit code and stderr, never a recomputed verdict. */
function runGate(args: string[] = []): Run {
  const result = spawnSync(process.execPath, [GUARD, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.error, undefined, `the guard could not be spawned: ${String(result.error)}`);
  return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

let stage: string;
before(() => {
  stage = mkdtempSync(join(tmpdir(), 'spotify-config-accessor-'));
});
after(() => {
  rmSync(stage, { recursive: true, force: true });
});

/** A staged tree, rooted fresh so one test cannot leave a file for the next. */
function stageTree(name: string, files: Record<string, string>): string {
  const dir = join(stage, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, body] of Object.entries(files)) {
    writeFileSync(join(dir, file), body, 'utf8');
  }
  return dir;
}

describe('#1625 — a config setting has one home', () => {
  it('passes on the real tree, and proves it looked at a real tree', () => {
    const { status, output } = runGate();
    assert.equal(status, 0, output);
    // "0 files checked" and "no re-bindings" print through the same line, so the
    // count is asserted rather than assumed: a gate that walked nothing must
    // not be readable as a pass.
    const walked = /No module-scope config-accessor re-bindings under src \((\d+) files checked\)/.exec(output);
    assert.ok(walked, `the clean run did not report a file count: ${output}`);
    assert.ok(Number(walked[1]) > 100, `expected the whole src tree, walked ${walked[1]} files`);
  });

  it('fires on a fourth copy of the declaration that was removed', () => {
    const dir = stageTree('fourth', {
      'playlistops.ts': `import { getConfig } from '../config.js';\n${THE_FOURTH_DECLARATION}`,
    });
    const { status, output } = runGate(['--guarded-dir', dir]);
    assert.equal(status, 1, `expected a non-zero exit, got ${status}: ${output}`);
    assert.match(output, /module-scope re-binding under /);
    // Line 3 is the declaration in the staged file: the import is line 1 and the
    // comment that came with it in the original is line 2. Asserted rather than
    // pattern-matched loosely, because a finding that names the wrong line is a
    // finding a reader cannot act on.
    assert.match(output, /playlistops\.ts:3: const FETCH_ALL_CAP = \(\) => getConfig\(\)\.fetchAllCap;/);
    // The remedy is named, because a gate that says only "no" makes the next
    // person re-derive what a compliant file looks like.
    assert.match(output, /Import the shared accessor from src\/config\.ts/);
  });

  it('fires on the same declaration under a different name', () => {
    // The rule is a shape rule for a reason. A check on the literal string
    // FETCH_ALL_CAP would be satisfied by the first person to write
    // PLAYLIST_WALK_LIMIT, and the drift the issue describes would continue
    // under a name the check no longer recognises.
    const dir = stageTree('renamed', {
      'playlists.ts': 'const PLAYLIST_WALK_LIMIT = () => getConfig().fetchAllCap;\n',
    });
    const { status, output } = runGate(['--guarded-dir', dir]);
    assert.equal(status, 1, `expected a non-zero exit, got ${status}: ${output}`);
    assert.match(output, /PLAYLIST_WALK_LIMIT/);
  });

  it('fires on a plain capture, and on an exported one', () => {
    const dir = stageTree('variants', {
      'plain.ts': 'const CAP = getConfig().maxItems;\n',
      'exported.ts': 'export const CAP = getConfig().maxItems;\n',
      'typed.ts': 'const CAP: number = getConfig().maxItems;\n',
      'arrow.ts': 'const CAP = () => getConfig().maxItems;\n',
    });
    const { status, output } = runGate(['--guarded-dir', dir]);
    assert.equal(status, 1, `expected a non-zero exit, got ${status}: ${output}`);
    for (const file of ['plain.ts', 'exported.ts', 'typed.ts', 'arrow.ts']) {
      assert.match(output, new RegExp(file.replace('.', '\\.')), `${file} was not reported:\n${output}`);
    }
  });

  it('stays silent on the shapes that must not trip it', () => {
    // Each of these is either a real pattern in src/ today or prose about one.
    // A gate that flags them would be a gate nobody keeps green, which is worse
    // than no gate, so they are pinned here rather than assumed.
    const dir = stageTree('legitimate', {
      // The ~40 legitimate call sites: a function-local read, indented.
      'function-local.ts': [
        'import { getConfig } from "../config.js";',
        'export async function walk(): Promise<number> {',
        '  const cap = getConfig().fetchAllCap;',
        '  return cap;',
        '}',
        '',
      ].join('\n'),
      // The shared accessors themselves, which are FUNCTION declarations.
      'config.ts': [
        'import { getConfig } from "./config.js";',
        'export function fetchAllCap(): number {',
        '  return getConfig().fetchAllCap;',
        '}',
        'export function scanCapFloor(requested?: number): number {',
        '  return Math.min(requested ?? fetchAllCap(), fetchAllCap());',
        '}',
        '',
      ].join('\n'),
      // Prose and contract text: the environment variable, named in a string.
      'prose.ts': [
        'const FIELDS = {',
        '  scan_cap: z.number().optional().describe("Maximum source rows to scan; bounded by SPOTIFY_MCP_FETCH_ALL_CAP"),',
        '};',
        '// Hard cap for fetch_all pagination loops (SPOTIFY_MCP_FETCH_ALL_CAP, #55)',
        '// This module used to hold its own `FETCH_ALL_CAP` thunk.',
        '',
      ].join('\n'),
    });
    const { status, output } = runGate(['--guarded-dir', dir]);
    assert.equal(status, 0, `these must not be findings:\n${output}`);
    assert.match(output, /3 files checked/);
  });

  it('refuses to pass on a tree with no files in it', () => {
    const dir = stageTree('empty', {});
    const { status, output } = runGate(['--guarded-dir', dir]);
    assert.equal(status, 2, `expected the zero-file refusal, got ${status}: ${output}`);
    assert.match(output, /That is a gate looking at nothing, not a passing gate\./);
  });

  it('refuses to pass when the call shape it matches on is gone', () => {
    // The rule is a pattern over `getConfig(`. Rename that function and the
    // pattern still compiles, still matches nothing, and still reports a clean
    // tree — a bill of health for a scanner that can no longer see its subject.
    // A count of zero is the measurable form of that, so it is measured.
    const dir = stageTree('no-premise', { 'a.ts': 'export const CAP = 500;\n' });
    const { status, output } = runGate(['--guarded-dir', dir]);
    assert.equal(status, 2, `expected the premise refusal, got ${status}: ${output}`);
    assert.match(output, /no `getConfig\(` call anywhere under /);
  });

  it('collects the field that was re-bound, not just the line', () => {
    // The exit code says a gate fired; this says which setting, which is what a
    // reader needs to act on it.
    assert.deepEqual(
      collectReboundFields('const CAP = getConfig().maxItems;\n', 'a.ts'),
      ['a.ts:maxItems'],
    );
    assert.deepEqual(collectReboundFields('const CAP = 1;\n', 'a.ts'), []);
  });

  it('holds every file in the real src tree at zero', () => {
    // The boundary measured directly, over the tree CI walks, so the passing CLI
    // run above is not the only evidence and a bug in the CLI's own aggregation
    // cannot hide a finding.
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return full.endsWith('.ts') ? [full] : [];
    });
    const files = walk(join(ROOT, 'src'));
    assert.ok(files.length > 100, `the walk found ${files.length} files, so this proves nothing`);

    const found = files.flatMap((file) =>
      collectDuplicateConfigAccessorErrors(readFileSync(file, 'utf8'), relative(ROOT, file)));
    assert.deepEqual(found, [], `a module re-binds a config field it should import:\n${found.join('\n')}`);
  });
});
