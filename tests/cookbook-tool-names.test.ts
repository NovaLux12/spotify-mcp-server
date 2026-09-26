/**
 * Cookbook tool contract guard (#712).
 *
 * Recipes in `docs/cookbook.md` name production tools inline (`Call X with
 * `arg: ...``) and backtick the tool names they exercise. The recipes also
 * embed an undo-tools section that names the receipt/undo surface. Both
 * shape layers (call recipes + backticked tool/prompt/resource names) and
 * the per-tool argument schema are checked by `scripts/check-doc-tool-names.mjs`.
 *
 * This guard runs the production gate against the live registry so a
 * cookbook that drifted from a finalized tool (renamed, dropped, or with a
 * changed input shape) fails CI — and the same gate is also run targeted
 * on `docs/cookbook.md` via `--check-fixture`, so a future rename of a
 * cookbook-named tool is the only place that needs a recipe update.
 */
import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COOKBOOK = join(ROOT, 'docs', 'cookbook.md');

describe('cookbook tool contract (#712)', () => {
  it('passes check:doc-tool-names against the finalized production registry', () => {
    execFileSync('npm', ['run', 'check:doc-tool-names'], {
      cwd: ROOT,
      stdio: 'pipe',
      maxBuffer: 32 * 1024 * 1024,
    });
  });

  it('keeps docs/cookbook.md valid as a check-doc-tool-names fixture', () => {
    execFileSync(
      process.execPath,
      ['scripts/check-doc-tool-names.mjs', '--check-fixture', COOKBOOK],
      { cwd: ROOT, stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 },
    );
  });
});
