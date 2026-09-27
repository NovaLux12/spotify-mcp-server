/**
 * Generated module-map sentence guard (#1258).
 *
 * `firstDescription` in `scripts/surface-census.mjs` builds the `Responsibility`
 * cell of the ARCHITECTURE.md module map. It took the first
 * `Intl.Segmenter('en', { granularity: 'sentence' })` segment of a module's
 * opening doc comment, whatever boundary the segmenter happened to pick.
 *
 * For `src/tools/episodemgmt.ts` that boundary fell inside a query string. The
 * comment reads `…(real endpoint is PUT /me/episodes?ids= to save)`; the
 * segmenter broke the run at the `?`, and the rendered row became a claim about
 * a bare `PUT /me/episodes` with the `ids` parameter gone. The row stated half a
 * Spotify endpoint and a reader could not tell which endpoint it meant.
 *
 * The defect was permanently fenced: `--check` passed, because the generator
 * produced exactly that text and the block may not be hand-edited. So the
 * regression cannot be a doc assertion alone — a test that re-ran the generator
 * over the current tree would pass with the bug still in place, which is
 * AGENTS.md §6's "a test that cannot fail". These tests drive
 * `firstDescription` through the script's own `--description-fixture` hook
 * instead, so they observe the behaviour rather than restate the output.
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The `episodemgmt` header, verbatim in shape. The `?` is followed immediately
 * by `ids`, which is what makes the segmenter's cut a mid-token cut rather than
 * a sentence boundary.
 */
const TRUNCATED_HEADER = `/**
 * episodemgmt (#204, #187, #230): archive_played_episodes.
 * mark_episode_played was removed in #230 — PUT /me/episodes/{id} with
 * resume_point is not a real Spotify endpoint (real endpoint is
 * PUT /me/episodes?ids= to save). The tool swallowed 404s and reported
 * ok:true, which was phantom success. Removed per #85 precedent.
 */
import { z } from 'zod';
`;

// The second sentence starts uppercase because that is the only thing that
// makes `Intl.Segmenter` break there at all — before a lowercase word it runs
// the two together, and a fixture like that would pass for the wrong reason.
const COMMENT = 'the current opening paragraph ends here. The second sentence follows.';

/** Scratch dirs go under `os.tmpdir()`: parallel test files and sibling agents share `/tmp`. */
async function withScratchDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'spotify-mcp-description-fixture-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Run the real `firstDescription` in `scripts/surface-census.mjs` over `source`. */
async function firstDescription(source: string, fallback = 'src/tools/fixture.ts'): Promise<string> {
  return withScratchDir(async (dir) => {
    const file = join(dir, 'source.json');
    await writeFile(file, JSON.stringify({ source, fallback }));
    const stdout = execFileSync(process.execPath, ['scripts/surface-census.mjs', '--description-fixture', file], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
    return (JSON.parse(stdout) as { description: string }).description;
  });
}

/**
 * The pre-#1258 behaviour: take the first segment, whatever the boundary is.
 *
 * Kept only as the anti-vacuity baseline — it exists so the regression test can
 * assert that the *unguarded* boundary really does drop `ids=`. Without it, a
 * `firstDescription` that returned the entire paragraph unconditionally would
 * satisfy "the output contains `ids=`" while having fixed nothing.
 */
function naiveFirstSegment(source: string): string {
  const doc = /^\/\*\*\s*\n([\s\S]*?)\n\s*\*\//.exec(source);
  const lines = (doc?.[1] ?? '').split('\n').map((line) => line.replace(/^\s*\* ?/, '').trim());
  while (lines.length > 0 && lines[0] === '') lines.shift();
  const paragraph: string[] = [];
  for (const line of lines) {
    if (line === '') break;
    paragraph.push(line);
  }
  const text = paragraph.join(' ').replace(/\s+/g, ' ').trim();
  return [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)][0]?.segment.trim() ?? '';
}

/** The module-map table's data rows, in file order. */
async function moduleMapRows(): Promise<Array<{ file: string; description: string }>> {
  const architecture = await readFile(join(ROOT, 'ARCHITECTURE.md'), 'utf8');
  const start = architecture.indexOf('<!-- BEGIN:generated module-map -->');
  const end = architecture.indexOf('<!-- END:generated module-map -->');
  assert.ok(start >= 0 && end > start, 'ARCHITECTURE.md has no module-map block');
  const rows: Array<{ file: string; description: string }> = [];
  for (const line of architecture.slice(start, end).split('\n')) {
    const match = /^\| `([^`]+\.ts)` \| (.*) \(\d+ registered tools?\) \| \d+ \|$/.exec(line);
    if (match) rows.push({ file: match[1], description: match[2].replaceAll('\\|', '|') });
  }
  return rows;
}

describe('generated module-map sentence boundary (#1258)', () => {
  it('the unguarded segmenter really does truncate the episodemgmt claim', () => {
    // Anti-vacuity, stated first so the regression below cannot be satisfied by
    // a `firstDescription` that simply stopped truncating. This is the shape
    // #1238 and this file are both about: assert the defect is reachable.
    const naive = naiveFirstSegment(TRUNCATED_HEADER);
    assert.ok(
      naive.endsWith('PUT /me/episodes?'),
      `expected the naive first segment to stop at the query string, got: ${naive}`,
    );
    assert.ok(!naive.includes('ids='), 'the naive segment must be the broken one for this test to mean anything');
  });

  it('keeps a query string intact instead of cutting the claim at the ?', async () => {
    const description = await firstDescription(TRUNCATED_HEADER);
    assert.ok(
      description.includes('PUT /me/episodes?ids= to save'),
      `the ids= parameter was lost from the module map description: ${description}`,
    );
    assert.ok(
      !description.endsWith('PUT /me/episodes?'),
      'the description must not stop mid-endpoint',
    );
  });

  it('still truncates at a real sentence end', async () => {
    // Without this, "return the whole paragraph" would pass every other test
    // in this file while silently widening all 94 rows of the table — a bug I
    // introduced and caught mid-change, because `Intl.Segmenter` includes each
    // segment's trailing whitespace and a terminal-punctuation test run on the
    // untrimmed segment sees a space, not a full stop.
    const description = await firstDescription(`/**\n * ${COMMENT}\n */\n`);
    assert.equal(description, 'the current opening paragraph ends here.');
  });

  it('still truncates a genuine question, which only differs by what follows the ?', async () => {
    // The `?` rule rejects a cut where a word character is glued to the
    // punctuation. A real question is followed by a space, so it must keep
    // truncating — otherwise the guard would quietly keep whole paragraphs for
    // every module whose header opens with a question.
    const description = await firstDescription(`/**\n * is this module generated? it writes nothing at all.\n */\n`);
    assert.equal(description, 'is this module generated?');
  });

  it('renders the shipped module map with the complete endpoint claim', async () => {
    const rows = await moduleMapRows();
    const row = rows.find(({ file }) => file === 'src/tools/episodemgmt.ts');
    assert.ok(row, 'the module map no longer has a row for src/tools/episodemgmt.ts');
    assert.ok(
      row.description.includes('PUT /me/episodes?ids= to save'),
      `ARCHITECTURE.md still states a truncated endpoint: ${row.description}`,
    );
  });

  it('never cuts a module-map claim inside a token', async () => {
    // The general form of the defect, checked against every row rather than the
    // one that happened to ship broken: a description ending in `?` or `!` is
    // only legitimate when the source has whitespace (or nothing) after that
    // character. Anything else means the generator cut mid-token and the row is
    // quoting part of a path.
    const rows = await moduleMapRows();
    assert.ok(rows.length > 50, `expected the full module map, found ${rows.length} rows`);
    const offenders: string[] = [];
    for (const { file, description } of rows) {
      if (!/[?!]$/.test(description)) continue;
      const flat = (await readFile(join(ROOT, file), 'utf8')).replace(/\s+/g, ' ');
      const at = flat.indexOf(description);
      assert.notEqual(at, -1, `${file}: module map description is not a prefix of its source — the scan is broken`);
      const next = flat[at + description.length];
      if (next !== undefined && !/\s/.test(next)) {
        offenders.push(`${file} ends mid-token on "${description}" (followed by ${JSON.stringify(next)})`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});
