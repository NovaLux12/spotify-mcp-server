#!/usr/bin/env node
// Syntax- and import-check every module under `scripts/`, so a broken script
// fails CI instead of failing whoever runs it next.
//
// #644: the test glob is `tests/*.test.ts`, so a `.mjs` under `scripts/` is
// never loaded by a test that did not already know about it. A typo in a
// harness cost an afternoon of bisecting a two-minute failure that reported
// `timeout: initialize` and named no file. This gate is the one that closes
// that: it is the difference between "the script is broken" and "the server is
// broken", said out loud, before anyone runs it.
//
// Two halves, because they catch different things:
//
//   - `node --check` parses each file. A syntax error anywhere under
//     `scripts/**/*.mjs` is an error here, including in the ~40 scripts no
//     test references.
//   - an import smoke loads each `scripts/lib/*.mjs` in a child process.
//     `--check` does not resolve a specifier, so a bad import path is
//     invisible to it — and `scripts/lib/` is precisely the layer the three
//     harnesses all depend on (#644).
//
// ## It fails closed
//
// Three ways this gate could report success without having measured anything,
// and all three are errors rather than passes:
//
//   - the walk finds no `.mjs` files (a wrong root, a moved directory) —
//     zero files is not a clean tree, it is a gate that looked at nothing;
//   - `node --check` cannot be spawned at all — that is a verdict of "unknown",
//     not "clean";
//   - the import smoke cannot be spawned, for the same reason.
//
// Usage:
//   node scripts/check-script-syntax.mjs [--check-fixture <dir>]
//
// `--check-fixture` points the walk at a directory other than `scripts/`. It
// exists so the guard test can drive THIS gate against a tree with a planted
// syntax error, rather than re-implementing the verdict and asserting that its
// own re-implementation is right.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Show a path relative to the repo when it is in the repo, absolute otherwise. */
function display(file) {
  const rel = relative(ROOT, file);
  return rel.startsWith('..') ? file : rel;
}

/** Recursively collect `.mjs` files, sorted so a failure is reproducible. */
export function collectScripts(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectScripts(full));
    else if (entry.isFile() && entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

function runNode(args) {
  // `execFileSync` with a non-zero exit THROWS; the throw is the finding. Any
  // other failure (ENOENT on node itself) is the gate being unable to run.
  try {
    const stdout = execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, stdout };
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'EACCES')) {
      return { ok: false, harness: true, message: String(e.message) };
    }
    return { ok: false, stdout: `${e.stdout ?? ''}`, stderr: `${e.stderr ?? ''}`, status: e.status };
  }
}

function main() {
  const argv = process.argv.slice(2);
  const fixtureAt = argv.indexOf('--check-fixture');
  if (fixtureAt !== -1 && !argv[fixtureAt + 1]) {
    process.stderr.write('check-script-syntax: --check-fixture needs a directory\n');
    return 2;
  }
  const dir = fixtureAt === -1 ? join(ROOT, 'scripts') : resolve(argv[fixtureAt + 1]);

  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    process.stderr.write(`check-script-syntax: ${dir} is not a directory — nothing was checked\n`);
    return 2;
  }

  const files = collectScripts(dir);

  // Fail closed: a walk that found nothing has not proved the tree is clean.
  if (files.length === 0) {
    process.stderr.write(
      `check-script-syntax: found no .mjs files under ${dir}. That is a gate looking at nothing, not a passing gate.\n`,
    );
    return 2;
  }

  const failures = [];
  let checked = 0;

  for (const file of files) {
    const res = runNode(['--check', file]);
    if (res.harness) {
      process.stderr.write(`check-script-syntax: could not run node --check (${res.message}) — nothing was verified\n`);
      return 2;
    }
    checked += 1;
    if (!res.ok) {
      failures.push({
        phase: 'syntax',
        file: display(file),
        detail: (res.stderr || res.stdout || `node --check exited ${res.status}`).trim().split('\n').slice(0, 4).join('\n    '),
      });
    }
  }

  // Import smoke for `scripts/lib/` only. The rest of `scripts/` runs work at
  // module scope — sweep-finalize.mjs reads a report and shells out to git — so
  // importing it would be running the thing being checked, in CI, for no
  // coverage. `scripts/lib/` is the layer the harnesses all route through.
  const libDir = join(dir, 'lib');
  const libs = existsSync(libDir) ? collectScripts(libDir) : [];
  let imported = 0;
  for (const lib of libs) {
    const url = pathToFileURL(lib).href;
    const res = runNode(['--input-type=module', '-e', `await import(${JSON.stringify(url)});`]);
    if (res.harness) {
      process.stderr.write(`check-script-syntax: could not spawn the import smoke (${res.message}) — nothing was verified\n`);
      return 2;
    }
    imported += 1;
    if (!res.ok) {
      failures.push({
        phase: 'import',
        file: display(lib),
        detail: (res.stderr || res.stdout || `import exited ${res.status}`).trim().split('\n').slice(0, 4).join('\n    '),
      });
    }
  }

  if (failures.length > 0) {
    process.stderr.write(
      `check-script-syntax: ${failures.length} of ${checked} script file${checked === 1 ? '' : 's'} failed:\n` +
        failures.map((f) => `  [${f.phase}] ${f.file}\n    ${f.detail}\n`).join(''),
    );
    return 1;
  }

  console.log(
    `check-script-syntax: ${checked} script file${checked === 1 ? '' : 's'} parsed` +
      (libs.length ? `, ${imported} lib module${imported === 1 ? '' : 's'} imported` : ', 0 lib modules (none present)'),
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
