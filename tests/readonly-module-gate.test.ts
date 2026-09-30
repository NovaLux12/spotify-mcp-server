/**
 * The read-only gate must be able to fail (#1604).
 *
 * `scripts/check-readonly-tools.mjs` asserts that no module marked
 * `readOnlySafe` contains a mutating call. On a clean tree it is a pass, which
 * is the easy half and proves nothing: a gate that cannot go red is
 * indistinguishable from a gate that is not looking (AGENTS.md §6).
 *
 * So this drives it. Every arm below is a synthetic module and a synthetic
 * call, never a live one, so the suite cannot be reddened by the fixtures
 * themselves — the point is to prove the *scanner and its wiring* work, not to
 * assert anything about today's tree, which the gate itself already does.
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'check-readonly-tools.mjs');

/**
 * Run the gate over a throwaway tree.
 *
 * The gate reads the read-only module set from `src/tools/annotations.ts`, so a
 * synthetic module cannot be introduced by writing a file — that module is the
 * source of truth and it is not ours to fake. What this varies instead is the
 * FILE the gate scans, by pointing it at a scratch repo whose
 * `src/tools/annotations.ts` reports a module the scratch repo owns.
 *
 * That is the honest seam: the manifest is generated, so the test generates it
 * too, rather than asserting against a hand-written stub that could agree with
 * a broken scanner.
 *
 * The gate is run with `--import tsx` because that is how it is run in CI and
 * locally; the loader is resolved from this repository's `cwd`, which is why
 * the scratch tree needs no `node_modules` of its own.
 */
function runGateOverManifest(manifestSource: string, moduleSource: string): { status: number; out: string } {
  const scratch = mkdtempSync(join(tmpdir(), 'readonly-gate-'));
  try {
    mkdirSync(join(scratch, 'scripts'), { recursive: true });
    mkdirSync(join(scratch, 'src', 'tools'), { recursive: true });
    // The scanner under test, copied so it resolves its own ROOT at the scratch
    // tree rather than at this repository.
    writeFileSync(join(scratch, 'scripts', 'check-readonly-tools.mjs'), readFileSync(SCRIPT, 'utf8'));
    writeFileSync(join(scratch, 'src', 'tools', 'annotations.ts'), manifestSource);
    writeFileSync(join(scratch, 'src', 'tools', 'probe_readonly.ts'), moduleSource);
    try {
      const out = execFileSync(process.execPath, ['--import', 'tsx', join(scratch, 'scripts', 'check-readonly-tools.mjs')], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
      return { status: 0, out };
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * A manifest naming one read-only module backed by `src/tools/probe_readonly.ts`.
 *
 * Written as TypeScript and placed beside the module it describes, because that
 * is where the gate reads the read-only set from.
 */
function manifest(readOnlySafe: boolean): string {
  return [
    'export const REGISTRAR_MANIFEST = [',
    '  {',
    "    key: 'probe',",
    "    registrationKey: 'probe',",
    "    file: 'src/tools/probe_readonly.ts',",
    "    name: 'probe',",
    `    readOnlySafe: ${readOnlySafe},`,
    '  },',
    '];',
    '',
  ].join('\n');
}

describe('#1604 a read-only module must contain no mutating call', () => {
  it('passes on this tree, and says how much it looked at', () => {
    const out = execFileSync(process.execPath, ['--import', 'tsx', SCRIPT], { encoding: 'utf8', cwd: ROOT });
    assert.match(out, /read-only modules: \d+ scanned, 0 contain a mutating call/);
    // "0 found" is only meaningful beside "N scanned" — a scan that found no
    // files would print the same zero.
    const scanned = Number(out.match(/read-only modules: (\d+) scanned/)?.[1] ?? '0');
    assert.ok(scanned >= 20, `expected the real read-only set, scanned only ${scanned}`);
  });

  it('fails, naming the module and the line, when a read-only module writes', () => {
    const result = runGateOverManifest(
      manifest(true),
      [
        'export async function probe(client: { post: (p: string, b: unknown) => Promise<void> }) {',
        "  await client.post('/me/player/play', {});",
        '}',
        '',
      ].join('\n'),
    );
    assert.equal(result.status, 1, `the gate must exit non-zero; output was:\n${result.out}`);
    assert.match(result.out, /probe/);
    assert.match(result.out, /probe_readonly\.ts:2/);
    assert.match(result.out, /post/);
  });

  it('ignores the same call when the module is not read-only', () => {
    // The other direction, and the one that keeps the gate from being
    // "no module may ever write": a write in an ordinary module is the normal
    // case for this server and must not be reported.
    const result = runGateOverManifest(
      manifest(false),
      [
        'export async function probe(client: { delete: (p: string, b: unknown) => Promise<void> }) {',
        "  await client.delete('/playlists/{id}/items', { tracks: [] });",
        '}',
        '',
      ].join('\n'),
    );
    assert.equal(result.status, 0, `a write in a non-read-only module must pass; output was:\n${result.out}`);
  });

  it('does not fire on a mutating call named in a comment or a string', () => {
    // A scanner that cannot tell code from prose produces false positives, and
    // a gate with false positives is a gate people learn to bypass.
    const result = runGateOverManifest(
      manifest(true),
      [
        '/**',
        ' * Example: await client.post("/me/player/play", {});',
        ' */',
        'export const note = "await client.delete(\'/x\')";',
        'export const verb = "delete";',
        '// await client.put("/x", {});',
        '',
      ].join('\n'),
    );
    assert.equal(result.status, 0, `comments and strings must not trip the gate; output was:\n${result.out}`);
  });
});
