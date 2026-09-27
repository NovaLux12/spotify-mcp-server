/**
 * Explicit-any guard (#758).
 *
 * `as any` at a payload boundary is the cast that disables the one check this
 * server leans on to survive Spotify's wire format moving. A field rename
 * compiles clean straight through it and arrives as `undefined` — the same
 * failure that read a missing album as an empty string in `library.ts` and
 * recorded a throttled stats.fm friend as `0 streams` (#803).
 *
 * So the guard has to do two things, and a test that only does the first is
 * decoration. It has to hold the real tree at zero, and it has to *fire* when
 * a cast comes back. The first is asserted against the actual `src/tools`
 * files; the second is driven through the same collector CI runs, plus the
 * real CLI's exit code, rather than by a precomputed verdict — an assertion
 * derived from the same source as the code under test proves nothing.
 *
 * The negative cases matter as much as the positive one: a guard that flagged
 * every occurrence of the letters `as any`, including a comment explaining why
 * the cast was removed, would be a gate nobody could keep green, and would get
 * switched off within a release.
 */

import './helpers/hermetic.js';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankNonCode, collectExplicitAnyErrors } from '../scripts/check-no-explicit-any.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GUARD = join(ROOT, 'scripts', 'check-no-explicit-any.mjs');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('#758 — `as any` is gone from the payload-shape boundary', () => {
  it('holds every file under src/tools at zero explicit-any casts', () => {
    const files = walk(join(ROOT, 'src', 'tools'));
    assert.ok(files.length > 0, 'the walk found no src/tools files, so this proves nothing');

    const found = files.flatMap((file) =>
      collectExplicitAnyErrors(readFileSync(file, 'utf8'), relative(ROOT, file)));

    assert.deepEqual(
      found,
      [],
      `as any is back at a payload-shape boundary. Type the payload instead of casting it away:\n${found.join('\n')}`,
    );
  });

  it('fires on a cast that comes back, and names the file and line', () => {
    const found = collectExplicitAnyErrors(
      "const album = (track as any).album;\n",
      'src/tools/library.ts',
    );
    assert.equal(found.length, 1);
    assert.match(found[0]!, /^src\/tools\/library\.ts:1: /);
    assert.match(found[0]!, /\(track as any\)\.album/);
  });

  it('fires on every cast form, not just the first one in a file', () => {
    const found = collectExplicitAnyErrors(
      ['const a = x as any;', 'const b = (y as any).z;', 'const c = client.get(a as any);'].join('\n'),
      'src/tools/x.ts',
    );
    assert.equal(found.length, 3, `expected all three casts, got: ${JSON.stringify(found)}`);
    assert.deepEqual(found.map((f) => f.split(':')[1]), ['1', '2', '3']);
  });

  it('reads a cast inside a template-literal hole, which is still code', () => {
    const found = collectExplicitAnyErrors(
      'const label = `${(song as any).title}`;',
      'src/tools/x.ts',
    );
    assert.equal(found.length, 1, 'the ${…} body is code and must still be checked');
  });

  it('stays quiet on a comment or a string that merely names the cast', () => {
    // The removal commit for #758 says the words out loud. A gate that failed
    // on its own explanation would be switched off, so prose must not count.
    const source = [
      '// This used to be `(track as any).album` until #758 typed it.',
      "const note = 'drop the as any cast here';",
      '/* as any appears in this block comment too. */',
      'const real = track.album?.name ?? "";',
    ].join('\n');
    assert.deepEqual(collectExplicitAnyErrors(source, 'src/tools/x.ts'), []);
  });

  it('does not mistake a type argument for a cast', () => {
    // `Record<string, any>` puts `any` in a type position; only `as any` is the
    // escape hatch this guard is about. Flagging type arguments would make the
    // gate unsatisfiable rather than stricter.
    assert.deepEqual(
      collectExplicitAnyErrors('const presets: Record<string, any> = {};', 'src/tools/x.ts'),
      [],
    );
  });

  it('does not mistake a property named "as" for the keyword', () => {
    assert.deepEqual(
      collectExplicitAnyErrors('const n = row.asAny; const m = other.asarray;', 'src/tools/x.ts'),
      [],
    );
  });

  it('leaves line numbers intact so a failure points at the real line', () => {
    const source = ['// header', '', 'const x = 1;', 'const bad = y as any;'].join('\n');
    const found = collectExplicitAnyErrors(source, 'src/tools/x.ts');
    assert.equal(found.length, 1);
    assert.match(found[0]!, /^src\/tools\/x\.ts:4: /);
  });

  it('blanks comments and string bodies without moving any other character', () => {
    // Offsets are what the line number is computed from, so a comment of a
    // different length must not shift the code that follows it.
    const code = 'const x = 1;';
    const source = `// a much longer comment than the code\n${code}`;
    const blanked = blankNonCode(source);
    assert.equal(blanked.split('\n')[1], code);
  });
});

describe('#758 — the blanker reads regex literals, not just comments and strings', () => {
  // Found while building the #663 coverage gate, which reads tool names out of
  // test sources through this same blanker. `blankNonCode` had no notion of a
  // regex literal, so a quote character inside one opened a phantom string:
  //
  //   const needsQuote = /[",\r\n]/.test(safe); const v = (x as any).y;
  //
  // The `"` was read as a string delimiter and the rest of THAT LINE — real
  // code — was blanked as though it were prose. A phantom string opened by an
  // odd number of quotes runs to the end of the line; an even number pairs off
  // and costs nothing, which is why the bug is intermittent and why it can sit
  // in a tree for years looking like a passing gate. Measured on this tree, 14
  // of 274 .ts files carried an unpaired quote, three of them under
  // `src/tools`, the directory this guard protects. A guard that silently stops
  // reading part of a line is worse than no guard, because it still reports a
  // number.
  it('an odd quote count in a regex does not blank the code after it', () => {
    // The shape that actually occurs in this tree: a regex carrying a quote
    // character, with real code on the same line behind it.
    const found = collectExplicitAnyErrors(
      'const needsQuote = /["\\r\\n]/.test(safe); const album = (track as any).album;',
      'src/tools/x.ts',
    );
    assert.equal(found.length, 1, 'a cast behind a quote-bearing regex must still be found');
    assert.match(found[0]!, /^src\/tools\/x\.ts:1:/);
  });

  it('an apostrophe inside a regex does not blank the code after it', () => {
    const found = collectExplicitAnyErrors(
      "assert.match(out, /removed by Spotify's February 2026/); const album = (track as any).album;",
      'src/tools/x.ts',
    );
    assert.equal(found.length, 1);
  });

  it('a regex character class may contain a slash without ending the literal', () => {
    // `/[a/'b]/` carries both hazards at once: the `/` inside the class must not
    // be read as the closing delimiter, and the `'` must not open a string. A
    // naive scan that stops at the inner `/` then meets the apostrophe and eats
    // the rest of the line, cast included.
    const found = collectExplicitAnyErrors(
      "const m = /[a/'b]/.test(s) ? 1 : 0; const album = (track as any).album;",
      'src/tools/x.ts',
    );
    assert.equal(found.length, 1, 'a cast behind a regex whose class holds a quote and a slash must still be found');
  });

  it('a regex after a keyword is a regex, not a division', () => {
    // `return /x/` is the shape that appears in this tree; read as a division,
    // the `/` stays in the output and the regex is scanned as code.
    const found = collectExplicitAnyErrors(
      "function f(s: string) { return /a'b/.test(s); const v = (x as any).y; }",
      'src/tools/x.ts',
    );
    assert.equal(found.length, 1);
  });

  it('a division is left alone — blanking it would hide real code', () => {
    // The failure mode of the fix, stated: a misread `/` that blanks a run of
    // real code is the one outcome a gate built on this function cannot have.
    for (const division of [
      'const ratio = total / count;',
      'const half = (a + b) / 2;',
      'f(x / 2, y);',
    ]) {
      const blanked = blankNonCode(`${division} const v = (x as any).y;`);
      assert.ok(blanked.includes(division), `a division must survive blanking: ${division}`);
    }
  });

  it('leaves every quote paired across the real test corpus', () => {
    // Two files under `src/tools` still report unpaired quotes —
    // `episodemgmt.ts` and `swarm3_discovery.ts`, both from an unescaped
    // backtick inside a single-quoted string nested in a template hole. That is
    // a real, known limitation, so this assertion is scoped to `tests/`, which
    // is the corpus the #663 coverage gate reads — and that gate fails loudly
    // on a desynced file rather than absorbing it. Closing the last two needs a
    // real parser, not a better heuristic.
    const walkAll = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walkAll(full);
      return entry.name.endsWith('.ts') ? [full] : [];
    });
    const desynced = walkAll(join(ROOT, 'tests'))
      .filter((file) => {
        const blanked = blankNonCode(readFileSync(file, 'utf8'));
        return [...blanked].filter((c) => c === '"' || c === "'").length % 2 !== 0;
      })
      .map((file) => relative(ROOT, file));
    assert.deepEqual(desynced, [], `these test files are misread by the blanker:\n  ${desynced.join('\n  ')}`);
  });

  it('the pairing check can actually fail, so the tree-wide assertion means something', () => {
    // Guard on the assertion above. Two halves: the detector must report a
    // desync when one is present, and the trigger that motivated the fix must
    // now come back clean.
    const unpairedQuotes = (source: string): number =>
      [...blankNonCode(source)].filter((c) => c === '"' || c === "'").length % 2;

    // An unterminated string leaves an odd count — the detector fires.
    assert.notEqual(unpairedQuotes("const a = 'one';\nconst b = 'two;\n"), 0);

    // The known trigger: a lone quote inside a regex, with code behind it.
    assert.equal(unpairedQuotes('const m = /["x]/.test(s); const v = 1;'), 0, 'a quote inside a regex must not desync the line');
  });
});

describe('#758 — the guard fails CI on an introduced cast', () => {
  // `describe` bodies run at registration time but the `it` bodies run later,
  // so the fixture directory has to be made in a `before` hook. Creating and
  // removing it inline in the describe body deletes it before the first test
  // ever looks at it.
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'explicit-any-guard-'));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (file: string) => {
    try {
      const stdout = execFileSync(process.execPath, [GUARD, '--check-fixture', file], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, output: stdout };
    } catch (err) {
      const e = err as { status: number | null; stderr: string };
      return { code: e.status ?? -1, output: e.stderr };
    }
  };

  it('exits non-zero and reports the cast when one is present', () => {
    const file = join(dir, 'dirty.ts');
    writeFileSync(file, 'const album = (track as any).album;\n');
    const { code, output } = run(file);
    assert.notEqual(code, 0, 'the gate returned success on a file that does contain a cast');
    assert.match(output, /dirty\.ts:1:/);
  });

  it('exits zero on a file with no cast, so the gate is not always red', () => {
    const file = join(dir, 'clean.ts');
    writeFileSync(file, 'const album = track.album?.name;\n');
    const { code } = run(file);
    assert.equal(code, 0, 'the gate failed on a clean file, which is how a gate gets ignored');
  });

  it('exits zero on the real src/tools tree', () => {
    const stdout = execFileSync(process.execPath, [GUARD], { encoding: 'utf8', cwd: ROOT });
    assert.match(stdout, /No `as any` casts under src\/tools/);
    assert.match(stdout, /\d+ files checked/);
  });
});
