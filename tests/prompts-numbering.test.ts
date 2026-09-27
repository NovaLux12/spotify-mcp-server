/**
 * Issue #714 — `playlist_audit` numbered its third finding "(3)" while items
 * (1) and (2) existed only as unnumbered prose, and `music_taste_summary`
 * computed a `ranges` binding nothing read.
 *
 * Two guards live here.
 *
 * 1. LIST MARKERS ARE CONTIGUOUS. A list marker is a claim about the body's
 *    own shape: "(3)" tells a model two more sections were intended, so it
 *    either invents them (padding the audit) or distrusts the one section that
 *    is numbered. `music_briefing` and `triage_liked_songs` already follow the
 *    rule the old `playlist_audit` broke — a list starts at 1 and is
 *    contiguous. The marker regexes are bounded to 1–99 so the "(429)" every
 *    prompt inherits from the shared footer cannot read as a marker; a
 *    hypothetical "(12)" HTTP status would need an allowlist entry, which is
 *    the right place to put that judgement rather than in the prose.
 *
 * 2. NO UNUSED DECLARATIONS IN src/prompts. `ranges` was computed and never
 *    interpolated and nothing failed, because the repo tsconfig leaves
 *    `noUnusedLocals` off. Turning it on repo-wide trips ~50 pre-existing
 *    hits in other modules (logout, resources, shaping, tools/*) — a separate
 *    decision outside this fix's file territory — so this runs the real
 *    compiler over `src/prompts/**` with the flag on instead and requires zero
 *    unused-declaration diagnostics there.
 *
 * The `playlist_audit` expectations below are transcribed from the audit the
 * issue describes (duplicates → dead tracks → summary table) and from what
 * each section has to keep saying, not captured from a render. That is the
 * point: a body rewritten into something else fails here instead of being
 * ratified by a regenerated snapshot.
 */
import './helpers/hermetic.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { promptSurface } from './live-registry.js';

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** `(1)`-style markers. Bounded to 1–99 so `(429)` in the footer is not one. */
const PAREN_MARKER = /\(([1-9]\d?)\)/g;
/** `1. `-style markers, which only count at the start of a line. */
const DOTTED_MARKER = /^[ \t]*([1-9]\d?)\.[ \t]/gm;

/** Every list marker in a body, in document order, de-duplicated. */
function listMarkers(body: string): number[] {
  const found = [
    ...[...body.matchAll(PAREN_MARKER)].map((m) => ({ at: m.index!, n: Number(m[1]) })),
    ...[...body.matchAll(DOTTED_MARKER)].map((m) => ({ at: m.index!, n: Number(m[1]) })),
  ].sort((a, b) => a.at - b.at);
  const ordered: number[] = [];
  for (const { n } of found) if (ordered[ordered.length - 1] !== n) ordered.push(n);
  return ordered;
}

test('no prompt body opens a list anywhere but 1, or skips a step (#714)', async () => {
  const surface = await promptSurface();
  const broken: string[] = [];
  for (const [name, body] of surface.prompts) {
    const markers = listMarkers(body);
    if (markers.length === 0) continue;
    const expected = Array.from({ length: Math.max(...markers) }, (_, i) => i + 1);
    if (markers.join() !== expected.join()) {
      broken.push(`${name}: markers [${markers.join(', ')}] — expected [${expected.join(', ')}]`);
    }
  }
  assert.deepEqual(broken, [], `prompt list markers are not contiguous from 1:\n${broken.join('\n')}`);
});

test('playlist_audit numbers its three findings 1, 2, 3 — in that order (#714)', async () => {
  const surface = await promptSurface();
  const body = surface.prompts.get('playlist_audit');
  assert.ok(body, 'playlist_audit should render');

  // Each finding is one numbered line. The old body carried a bare "(3) a
  // summary table" mid-sentence with no (1)/(2) at all.
  assert.match(body, /^\(1\) DUPLICATES\b/m);
  assert.match(body, /^\(2\) DEAD TRACKS\b/m);
  assert.match(body, /^\(3\) SUMMARY TABLE\b/m);

  // Exactly three markers, ascending — the contiguity rule, asserted on the
  // prompt that motivated it so a regression names the body.
  assert.deepEqual(listMarkers(body), [1, 2, 3]);
});

test('playlist_audit says the same thing it did before the renumber (#714)', async () => {
  const surface = await promptSurface();
  const body = surface.prompts.get('playlist_audit');
  assert.ok(body, 'playlist_audit should render');

  // Duplicates still come from the tool that detects relinked copies, and the
  // section still has to be reported verbatim.
  assert.match(body, /find_duplicates_in_playlist/);
  assert.match(body, /^\(1\) DUPLICATES[^\n]*relinked copies that ID-matching misses\)/m);

  // Dead tracks keep all three qualifiers: a null track, an unavailable flag,
  // and a region-restricted relink. A shorter rewrite would read as tidier
  // and would quietly drop one.
  assert.match(body, /^\(2\) DEAD TRACKS[^\n]*track is null or flagged unavailable\/unplayable[^\n]*including region-restricted relinks\./m);

  // The summary table still promises counts per issue.
  assert.match(body, /^\(3\) SUMMARY TABLE[^\n]*counts per issue\./m);

  // Numbering the findings must not have cost the prompt its safety line:
  // the audit presents findings, it does not delete anything.
  assert.match(body, /Do NOT remove anything yet/);
  assert.match(body, /For every problem entry give its position and URI/);
});

test('music_taste_summary has no declaration it never reads (#714)', async () => {
  // The dead `ranges` binding is what this flags, and it is the reason the
  // compiler flag is scoped rather than repo-wide. Options are read from the
  // real tsconfig so the probe cannot drift from the build's own settings;
  // `--ignoreConfig` is what lets tsc take a file list without also picking up
  // the project's include set (and reporting other modules' unused locals).
  const tsconfig = JSON.parse(await readFile(join(ROOT, 'tsconfig.json'), 'utf8'));
  const { strict, target, module, moduleResolution, esModuleInterop, skipLibCheck, types } =
    tsconfig.compilerOptions;

  let stdout = '';
  let exitFailure: string | null = null;
  try {
    const out = await execFileAsync(
      process.execPath,
      [
        join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
        '--ignoreConfig',
        '--noEmit',
        '--noUnusedLocals',
        ...(strict ? ['--strict'] : []),
        // Space-separated, not `--opt=value`: typescript 7's native tsc
        // rejects the `=` form with TS5023 on the very flags it accepts with
        // a space, which is how a probe ends up failing for a reason that has
        // nothing to do with the code under test.
        '--target', String(target),
        '--module', String(module),
        ...(moduleResolution ? ['--moduleResolution', String(moduleResolution)] : []),
        ...(esModuleInterop ? ['--esModuleInterop'] : []),
        ...(skipLibCheck ? ['--skipLibCheck'] : []),
        ...(types ? ['--types', types.join(',')] : []),
        join(ROOT, 'src', 'prompts', 'index.ts'),
      ],
      { cwd: ROOT },
    );
    stdout = out.stdout;
  } catch (err) {
    // tsc reports unused declarations on stdout and still exits non-zero, so
    // the diagnostic text has to be read out of the failure, not assumed.
    const e = err as { stdout?: string; stderr?: string; message?: string };
    stdout = e.stdout ?? '';
    exitFailure = e.stderr?.trim() || e.message || String(err);
  }

  // TS6133/6192/6196/6198/6199 are the declaration-never-read family
  // (noUnusedLocals). 6192 is "all imports in this declaration are unused" and
  // 6196 is a type-only alias, neither of which is a `const`, so both count.
  const unused = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^src[\\/]prompts[\\/].*error TS(6133|6192|6196|6198|6199):/.test(line));

  assert.deepEqual(unused, [], `unused declarations in src/prompts:\n${unused.join('\n')}`);

  // The probe itself has to be trustworthy: a non-zero exit carrying no
  // unused-local diagnostic means tsc broke (bad flag, missing typescript),
  // and a probe that fails open is indistinguishable from a clean pass.
  if (exitFailure !== null) {
    throw new Error(`tsc probe exited non-zero without an unused-local diagnostic:\n${exitFailure}\n${stdout}`);
  }
});
