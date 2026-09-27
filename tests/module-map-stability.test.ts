/**
 * Generated module-map stability (#1398).
 *
 * `ARCHITECTURE.md`'s generated `module-map` block used to carry a per-file
 * line count. A line count is invalidated by *any* edit that changes a file's
 * length — a comment, a blank line, a reformat, an unrelated fix — while the
 * block's subject matter is what a file registers. So `npm run count:tools --
 * --check` reported "generated module-map block is stale" for edits that
 * changed nothing it documents. That is a false red, and it is expensive: it
 * put `main` red twice (#1360, #1380) and cost three agents two `--write`
 * cycles each, plus one stale-SHA CI failure that read as a regression and was
 * not.
 *
 * ## Why these tests drive a fixture instead of the repository
 *
 * The obvious regression test — edit a file under `src/`, run `--check`, expect
 * green — cannot fail once the fix lands, because `--write` is what keeps the
 * block current, and the real `--check` reads the block `--write` produced. A
 * test comparing the shipped block to itself passes against the exact renderer
 * that produced the defect. That is AGENTS.md §6's "a test that cannot fail".
 *
 * So the row is rendered through the census's own `--module-row-fixture` hook,
 * over a caller-supplied source, and two sources that differ *only* in a
 * comment line are compared. The repository is not involved, so nothing can
 * quietly regenerate the answer.
 *
 * ## What "still meaningful" means here
 *
 * Replacing a noisy column with a quiet one is only worth doing if the quiet one
 * is still tracking something. A renderer that had been changed to ignore its
 * inputs entirely would satisfy every invariance test in this file, so
 * `still moves when the registry moves` asserts the opposite direction: the
 * row has to change when the measured figures change. Both directions are
 * required — insensitive to the source, sensitive to the registry.
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A module that opens with a doc comment, like the 82 files that do. */
const MODULE = `/**
 * CSV cell rendering shared by every writer that emits a spreadsheet (#630).
 */
export function csvCell(value: string): string {
  return value.includes(',') ? \`"\${value}"\` : value;
}
`;

/** The same module with one line of comment added and nothing else touched. */
const MODULE_PLUS_COMMENT = `// Reproduction for #1398: a comment-only line added under src/.
${MODULE}`;

/** The same module with one line of comment *inside* the body. */
const MODULE_PLUS_TRAILING_COMMENT = `${MODULE}
// Reproduction for #1398: a comment-only line added under src/.
`;

/** Scratch dirs go under `os.tmpdir()`: parallel test files and sibling agents share `/tmp`. */
async function withScratchDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'spotify-mcp-module-row-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Render one module-map row through the census's real `moduleMapRow`. */
async function moduleRow(fields: { source: string; registered?: number; schemaBytes?: number; file?: string }): Promise<string> {
  return withScratchDir(async (dir) => {
    const file = join(dir, 'row.json');
    // `schemaBytes` is deleted rather than defaulted, because "no measurement"
    // and "a measurement of zero" are the two cases the em-dash test tells
    // apart. A `schemaBytes: 0` default would make the absent case unreachable.
    const fixture: Record<string, unknown> = { file: 'src/csvsafe.ts', registered: 0, ...fields };
    if (fields.schemaBytes === undefined) delete fixture.schemaBytes;
    await writeFile(file, JSON.stringify(fixture));
    const stdout = execFileSync(process.execPath, ['scripts/surface-census.mjs', '--module-row-fixture', file], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
    return (JSON.parse(stdout) as { row: string }).row;
  });
}

/** The shipped module map's header row, which names the columns. */
async function moduleMapHeader(): Promise<string> {
  const architecture = await readFile(join(ROOT, 'ARCHITECTURE.md'), 'utf8');
  const start = architecture.indexOf('<!-- BEGIN:generated module-map -->');
  const end = architecture.indexOf('<!-- END:generated module-map -->');
  assert.ok(start >= 0 && end > start, 'ARCHITECTURE.md has no module-map block');
  const header = architecture.slice(start, end).split('\n')[1];
  assert.ok(header, 'the module-map block has no header row');
  return header;
}

/** The third cell of every data row in the shipped module map. */
async function moduleMapSizeCells(): Promise<Array<{ file: string; cell: string }>> {
  const architecture = await readFile(join(ROOT, 'ARCHITECTURE.md'), 'utf8');
  const start = architecture.indexOf('<!-- BEGIN:generated module-map -->');
  const end = architecture.indexOf('<!-- END:generated module-map -->');
  assert.ok(start >= 0 && end > start, 'ARCHITECTURE.md has no module-map block');
  const cells: Array<{ file: string; cell: string }> = [];
  for (const line of architecture.slice(start, end).split('\n')) {
    const match = /^\| `([^`]+\.ts)` \| .* \| (.*) \|$/.exec(line);
    if (match) cells.push({ file: match[1], cell: match[2] });
  }
  return cells;
}

describe('generated module-map is not stale by a comment-only src edit (#1398)', () => {
  it('renders the same row for a module with a comment line added above it', async () => {
    const before = await moduleRow({ source: MODULE });
    const after = await moduleRow({ source: MODULE_PLUS_COMMENT });
    assert.equal(
      after,
      before,
      `a comment-only edit changed the generated module-map row:\n  before: ${before}\n  after:  ${after}`,
    );
  });

  it('renders the same row for a module with a comment line added inside it', async () => {
    const before = await moduleRow({ source: MODULE });
    const after = await moduleRow({ source: MODULE_PLUS_TRAILING_COMMENT });
    assert.equal(
      after,
      before,
      `a comment-only edit changed the generated module-map row:\n  before: ${before}\n  after:  ${after}`,
    );
  });

  it('renders the same row for a module with a blank line added', async () => {
    // LOC counted blank lines too, and so does this: any length change at all.
    const before = await moduleRow({ source: MODULE });
    const after = await moduleRow({ source: `\n${MODULE}` });
    assert.equal(after, before, `a blank line changed the generated module-map row:\n  before: ${before}\n  after:  ${after}`);
  });

  it('still moves when the registry moves', async () => {
    // The other half of the contract. An invariance test alone is satisfied by
    // a renderer that ignores its inputs, which would have stopped the module
    // map tracking anything at all while passing everything above. Tool count
    // and schema bytes are what the block documents, so both must still render.
    const one = await moduleRow({ source: MODULE, registered: 1, schemaBytes: 1234 });
    const many = await moduleRow({ source: MODULE, registered: 5, schemaBytes: 9876 });
    assert.notEqual(one, many, 'the module-map row no longer distinguishes two different modules');
    assert.match(one, /\(1 registered tool\)/, 'the singular noun is wrong');
    assert.match(one, /\| 1,234 \|$/, 'schema bytes are not rendered as a measured figure');
    assert.match(many, /\(5 registered tools\)/, 'the tool count is not rendered');
    assert.match(many, /\| 9,876 \|$/, 'schema bytes are not rendered as a measured figure');
  });

  it('renders an em dash, not a zero, for a module that registers nothing', async () => {
    // `0` reads as a measurement of zero taken. A file absent from
    // `REGISTRAR_MANIFEST` has no measurement at all, and saying so is the
    // difference between "we measured this and it is free" and "this is not a
    // registry module".
    const measured = await moduleRow({ source: MODULE, registered: 0, schemaBytes: 0 });
    const unmeasured = await moduleRow({ source: MODULE, registered: 0 });
    assert.match(measured, /\| 0 \|$/, 'a manifest module with no tools should render 0 bytes');
    assert.match(unmeasured, /\| — \|$/, 'a non-manifest module should render an em dash');
  });

  it('keeps a doc comment as the responsibility when a // line precedes it', async () => {
    // The second route to the same false red. `firstDescription` used to accept
    // a `/** … */` block only at position 0, so one `//` line above a doc
    // comment demoted the real description and promoted the new line — the
    // block then published whatever comment happened to be first.
    const row = await moduleRow({ source: MODULE_PLUS_COMMENT, registered: 0, schemaBytes: 0 });
    assert.match(row, /CSV cell rendering shared by every writer/, `the doc comment was displaced: ${row}`);
    assert.doesNotMatch(row, /Reproduction for #1398/, `a line comment was published as a responsibility: ${row}`);
  });

  it('names the measured column in the shipped block, and not a line count', async () => {
    const header = await moduleMapHeader();
    assert.match(header, /Schema bytes/, `the module map does not carry the measured column: ${header}`);
    assert.doesNotMatch(header, /\bLOC\b/, `the module map still carries a line-count column: ${header}`);
  });

  it('fills every shipped size cell with a measured figure or an em dash', async () => {
    const cells = await moduleMapSizeCells();
    assert.ok(cells.length > 50, `expected the full module map, found ${cells.length} rows`);
    const offenders = cells
      .filter(({ cell }) => !/^(?:\d[\d,]*|—)$/.test(cell))
      .map(({ file, cell }) => `${file} carries ${JSON.stringify(cell)}`);
    assert.deepEqual(offenders, []);
  });

  it('a module with no measurement exists in the tree, so the em dash is load-bearing', async () => {
    // Without this the em dash could be dead syntax that no row ever takes, and
    // the test above would be checking a shape nothing produces. `src/auth.ts`
    // is a runtime module: large, and not in `REGISTRAR_MANIFEST`.
    assert.ok(existsSync(join(ROOT, 'src', 'auth.ts')), 'the fixture module this assertion names is gone');
    const cells = await moduleMapSizeCells();
    const dash = cells.find(({ file }) => file === 'src/auth.ts');
    assert.ok(dash, 'the module map no longer has a row for src/auth.ts');
    assert.equal(dash.cell, '—');
  });
});
