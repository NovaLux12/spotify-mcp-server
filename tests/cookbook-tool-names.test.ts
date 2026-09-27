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
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COOKBOOK = join(ROOT, 'docs', 'cookbook.md');
const GATE = 'scripts/check-doc-tool-names.mjs';

let sharedCensusFile: string | null = null;
function censusFile(): string {
  if (sharedCensusFile === null) {
    const dir = mkdtempSync(join(tmpdir(), 'smcp-928-census-'));
    sharedCensusFile = join(dir, 'census.json');
    writeFileSync(sharedCensusFile, execFileSync(process.execPath, ['scripts/surface-census.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }));
  }
  return sharedCensusFile;
}

/**
 * Plant `mutate(doc)` in a temp copy of the real cookbook and drive the real
 * gate over that one file. The fixture is the real document, so the gate sees
 * the same registry and the same surrounding prose it sees in CI — only the
 * planted claim differs.
 */
function gateRun(mutate: (source: string) => string): string {
  const mutated = mutate(readFileSync(COOKBOOK, 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'smcp-928-'));
  try {
    const fixture = join(dir, 'cookbook.md');
    writeFileSync(fixture, mutated);
    try {
      return execFileSync(process.execPath, [GATE, '--census-file', censusFile(), '--check-fixture', fixture], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (error) {
      const result = error as { stdout?: string; stderr?: string };
      return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Plant `mutate(doc)` and assert the gate goes red naming the planted claim. */
function gateRejects(mutate: (source: string) => string, expected: RegExp): void {
  const original = readFileSync(COOKBOOK, 'utf8');
  assert.notEqual(mutate(original), original, 'the mutation changed nothing — this would assert against the unmutated document');
  const output = gateRun(mutate);
  // Only the gate's own verdict lines, so a failure dump stays readable.
  const verdicts = output.split('\n').filter((line) => /: `/.test(line)).join('\n');
  assert.match(verdicts, expected, `gate did not name the planted claim:\n${verdicts || output}`);
}

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
      [GATE, '--check-fixture', COOKBOOK],
      { cwd: ROOT, stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 },
    );
  });
});

/**
 * #928 — the recipe-argument half of the cookbook contract.
 *
 * The gate already caught a recipe naming a tool that does not exist, which is
 * the failure the issue opened with. The two cases below are the ones it did
 * NOT catch, both because `checkCallRecipes` recognised only the literal verb
 * "Call" and compared argument *names* only:
 *
 *  - a `preview <tool> with ...` step — how every write step in the cookbook
 *    is written — was not a recipe step at all, so a bogus key inside one
 *    passed silently;
 *  - an argument the schema constrains was checked for existing, never for
 *    being a value the schema accepts, so `since: "last Monday"` passed even
 *    though `whats_new` rejects it at validation (#928's own evidence).
 *
 * Each case plants the claim into the real cookbook and asserts the gate goes
 * red naming it, so a regression that disables either comparison fails here
 * instead of passing green and protecting nothing.
 */
describe('cookbook recipe arguments (#928)', () => {
  it('rejects a preview step that names an argument the tool does not declare', () => {
    gateRejects(
      (source) => source.replace(
        'preview `create_playlist` with `name: "Taste Profile — YYYY-MM"`',
        'preview `create_playlist` with `name: "Taste Profile — YYYY-MM"`, `descripton: "typo"`',
      ),
      /`descripton` is not an input parameter of `create_playlist`/,
    );
  });

  it('rejects a recipe argument whose value the live schema does not accept', () => {
    gateRejects(
      (source) => source.replace(
        'Call whats_new with `since: "last-check"`',
        'Call whats_new with `since: "last Monday"`',
      ),
      /`whats_new` recipe passes `since: "last Monday"`, which the live inputSchema does not accept/,
    );
  });

  it('rejects a preview step whose value is not a member of the declared enum', () => {
    gateRejects(
      (source) => source.replace(
        'preview start_podcast_session with `minutes: 45`',
        'preview start_podcast_session with `minutes: 45`, `kind: "episode"`',
      ),
      /`start_podcast_session` recipe passes `kind: "episode"`, which the live inputSchema does not accept/,
    );
  });

  it('still accepts a `since` value the schema does accept, so the check is not a blanket ban', () => {
    // `whats_new.since` is a union: `const: 'last-check'` OR an ISO-date
    // pattern. A value check that rejected the pattern branch would make
    // recipe 2 unpublishable for every dated caller, so the date branch is
    // exercised here as the counterweight to the rejected `last Monday`.
    const output = gateRun(
      (source) => source.replace(
        'Call whats_new with `since: "last-check"`',
        'Call whats_new with `since: "2026-01-05"`',
      ),
    );
    assert.doesNotMatch(output, /contract check failed/, `an ISO date is accepted by the live schema and must not turn the gate red:\n${output}`);
  });
});
