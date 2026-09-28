/**
 * #929 — documented ranges, ceilings, defaults and enum members must agree
 * with the live tool schemas. #1476 — and the two claims a document makes
 * about a contract no single tool owns.
 *
 * The name-shaped checks in `scripts/check-doc-tool-names.mjs` pass a
 * document that names the right tool, the right argument, and then lies about
 * that argument's constraints. Every row in this file is one that names
 * everything correctly and is still wrong: a range wider than the schema
 * clamps, a ceiling larger than `maxItems`, an enum member no code path reads,
 * a default that contradicts the schema's own. The failure mode is the same
 * in all four — the call is rejected at validation, so a caller following the
 * published contract gets `Too big: expected number to be <=10` from a tool
 * whose table promised 50.
 *
 * The mutations are the point, and they run FIRST. §6 records that a guard
 * whose negative case was never executed is decoration, and that a gate
 * trusted to report its own verdict must be shown rejecting something. Each
 * case below plants a specific wrong string into a temp copy of a real
 * document, drives the real gate, and asserts it goes red with that claim
 * named — so a regression that silently disables the comparison fails here
 * rather than passing green and protecting nothing.
 *
 * The passing assertions are deliberately few, because the real coverage is
 * the whole-doc run below: the gate must be green on the tree as it stands,
 * or every future contributor inherits a broken gate.
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
const GATE = 'scripts/check-doc-tool-names.mjs';

/**
 * One census, enumerated once and shared by every case below.
 *
 * The gate reads the registry through `--census-file` precisely so a run can
 * generate it once and feed the same JSON to every doc check. Without this,
 * each of the nine cases re-enumerates 587 tools by driving the real stdio
 * server, which cost ~90s of subprocess spawning when this file was written —
 * enough concurrent load to push an unrelated timed test in the same suite
 * over its limit, which is breaking the suite without changing what the suite
 * says. The registry is the same registry either way; only the cost differs.
 */
let sharedCensusFile: string | null = null;
function censusFile(): string {
  if (sharedCensusFile === null) {
    const dir = mkdtempSync(join(tmpdir(), 'smcp-929-census-'));
    sharedCensusFile = join(dir, 'census.json');
    writeFileSync(sharedCensusFile, execFileSync(process.execPath, ['scripts/surface-census.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }));
  }
  return sharedCensusFile;
}

/** Run the production gate over the whole document set; must exit 0. */
function gateAcceptsTree(): string {
  return execFileSync(process.execPath, [GATE, '--census-file', censusFile()], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * Plant `mutate(doc)` in a temp copy of `relative` and run the production
 * gate over that one file. Returns the gate's output, which must be non-empty
 * and must name the planted claim.
 *
 * The fixture is the real document, not a hand-written one, so the gate sees
 * the same registry, the same surrounding prose and the same field-attribution
 * context it sees in CI — the only difference is the planted claim.
 */
function gateRejects(relative: string, mutate: (source: string) => string, expected: RegExp): string {
  const original = readFileSync(join(ROOT, relative), 'utf8');
  const mutated = mutate(original);
  assert.notEqual(mutated, original, `the mutation for ${relative} changed nothing — the test would assert against the unmutated document`);
  const dir = mkdtempSync(join(tmpdir(), 'smcp-929-'));
  try {
    const fixture = join(dir, relative.replace(/[\\/]/g, '__'));
    writeFileSync(fixture, mutated);
    let output = '';
    try {
      execFileSync(process.execPath, [GATE, '--census-file', censusFile(), '--check-fixture', fixture], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (error) {
      const result = error as { stdout?: string; stderr?: string };
      output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    }
    assert.match(output, expected, `gate output did not name the planted claim:\n${output}`);
    return output;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Replace `anchor` in a document, failing loudly if the anchor has moved. */
function replaceOnce(source: string, anchor: string, replacement: string): string {
  const at = source.indexOf(anchor);
  assert.ok(at >= 0, `anchor not found in document: ${anchor}`);
  return source.slice(0, at) + replacement + source.slice(at + anchor.length);
}

describe('documented constraints agree with the live schemas (#929)', () => {
  it('is green on the tree as it stands', () => {
    assert.match(gateAcceptsTree(), /match the finalized production registry/);
  });

  // -- a range wider than the schema clamps ---------------------------------
  //
  // `get_artist_albums` was the shipped instance: the table promised 1–50
  // while `/artists/{id}/albums` hard-caps limit at 10 and answers 400 above
  // it. The document now says 1–10, so the mutation re-widens it.

  it('rejects a documented range wider than the schema maximum', () => {
    const output = gateRejects(
      'SPEC.md',
      (source) => replaceOnce(
        source,
        '| `limit` | number | no | 1–10. Default: 10 |',
        '| `limit` | number | no | 1–50. Default: 20 |',
      ),
      /`get_artist_albums`\.`limit` is documented as `1–50`, but the live schema caps it at 10/,
    );
    assert.match(output, /a caller copying the doc is rejected/);
  });

  it('rejects a documented range below the schema minimum', () => {
    gateRejects(
      'SPEC.md',
      (source) => replaceOnce(
        source,
        '| `limit` | number | no | 1–10. Default: 10 |',
        '| `limit` | number | no | 0–10. Default: 10 |',
      ),
      /`get_artist_albums`\.`limit` is documented as `0–10`, but the live schema requires at least 1/,
    );
  });

  // -- a ceiling stated in words rather than as a pair ----------------------
  //
  // `max 40`, `at most 10` and `cap 200` are the same claim in three
  // spellings and all three are in the docs. A gate that only parses the
  // `1–40` form reads nothing here and protects nothing.

  it('rejects a documented array ceiling above the schema maxItems', () => {
    // The anchor is `check_in_library`'s, not `save_to_library`'s: #1567 gave
    // the save a table row, so the words-form line this fixture used to plant
    // is gone. The shape under test is unchanged — a `max N` stated in words,
    // above the live `maxItems` — and the words-form line that survives is the
    // only one left in the document set, which is why the gate needs to parse
    // it at all.
    const output = gateRejects(
      'SPEC.md',
      (source) => replaceOnce(
        source,
        '`uris` (string[], required, max 40 — track, album, episode, show, audiobook, artist, user, or playlist URIs)',
        '`uris` (string[], required, max 400 — track, album, episode, show, audiobook, artist, user, or playlist URIs)',
      ),
      /`check_in_library`\.`uris` documents "max 400" but the live schema caps it at 40/,
    );
    assert.match(output, /a caller copying the doc is rejected/);
  });

  // -- a default that contradicts the schema's own --------------------------
  //
  // Only checked where the schema states a `default`. Most paging fields
  // default in the handler body and declare none, and the schema is the only
  // source this gate reads, so those are left alone rather than guessed at.

  it('rejects a documented default the schema contradicts', () => {
    gateRejects(
      'SPEC.md',
      (source) => replaceOnce(
        source,
        '| `offset` | number | no | Index of the first result to return, 0–1000 — use with `limit` to page through results |',
        '| `offset` | number | no | Index of the first result to return, 0–1000. Default: 7 — use with `limit` to page through results |',
      ),
      /`search`\.`offset` documents default 7 but the live schema declares 0/,
    );
  });

  // -- an enum member the schema does not accept ----------------------------

  it('rejects a documented enum member the schema does not accept', () => {
    const output = gateRejects(
      'SPEC.md',
      (source) => replaceOnce(
        source,
        '| `search_type` | `"track"` \\| `"episode"` | no | What to search for. Default: `"track"` |',
        '| `search_type` | `"song"` \\| `"episode"` | no | What to search for. Default: `"track"` |',
      ),
      /`play_from_search`\.`search_type` documents enum member `song`, which the live schema does not accept \(it accepts `track`, `episode`\)/,
    );
    assert.match(output, /does not accept/);
  });

  // -- the class that only exists in PROSE ----------------------------------
  //
  // Every mutation above lands in a table cell. A prose `**Inputs:**` line is
  // the harder half, because one line describes several fields and a claim
  // belongs to the field whose backtick opens it. This is the case that caught
  // a real defect in the gate itself: the `**Inputs:**` line short-circuited
  // the loop, so a wrong range written on that very line was never examined
  // while the same claim in a table failed two sections later.

  it('rejects a wrong range in a prose Inputs line', () => {
    const output = gateRejects(
      'SPEC.md',
      (source) => replaceOnce(
        source,
        '**Inputs:** `limit` (1–50, default 20), `offset`, `fetch_all`',
        '**Inputs:** `limit` (1–200, default 20), `offset`, `fetch_all`',
      ),
      /`get_user_playlists`\.`limit` is documented as `1–200`, but the live schema caps it at 50/,
    );
    assert.match(output, /a caller copying the doc is rejected/);
  });

  // -- negative controls: the gate must not fire on truth -------------------
  //
  // A gate that rejects everything is as useless as one that rejects nothing,
  // and the failure is quieter. These assert the SAME claims written in the
  // other legal spellings stay green, so a future change that tightens the
  // matcher into a blanket rejection fails here instead of in review.

  it('accepts a correct ceiling written in words', () => {
    gateRejects(
      'SPEC.md',
      (source) => replaceOnce(
        source,
        '| `limit` | number | no | 1–50. Default: 20 |',
        '| `limit` | number | no | at most 50. Default: 20 |',
      ),
      // The fixture path is what surfaces in the message, so an empty run
      // means the gate printed nothing at all — which is the pass.
      /^$/,
    );
  });

  it('does not attribute one field’s range to the next field on the line', () => {
    // `search.offset` genuinely allows 0–1000 while the following `market`
    // row carries no range. A line-scoped matcher would read `0–1000` off
    // whichever row it landed on; the clause-scoped one checks it against
    // `offset`, which is where it belongs, and passes.
    gateRejects(
      'SPEC.md',
      (source) => replaceOnce(
        source,
        '| `offset` | number | no | Index of the first result to return, 0–1000 — use with `limit` to page through results |',
        '| `offset` | number | no | Index of the first result to return, 0–1000 — use with `limit` to page through results |\n| `market` | string | no | ISO 3166-1 alpha-2 country code, 1–99 |',
      ),
      /^$/,
    );
  });
});

/**
 * #1476 — a documented constant that drifted from the constant it documents,
 * with nothing comparing the two.
 *
 * Both shipped defects were unreachable by the checks above for the same
 * reason, and it is worth naming precisely rather than as "a gap": neither
 * claim is attributed to a TOOL. The `response_format` bullet describes a
 * field the whole surface accepts, and the aggregate ceiling is a property of
 * the registry rather than of any one schema — so
 * `checkDocumentedFieldConstraints`, which needs a tool heading before it has
 * anything to compare against, never entered either. The census renders both
 * constants into `docs/schema-budgets.md`, but that is a GENERATED block:
 * `--check` proves the generator is reproducible, not that the hand-written
 * prose elsewhere agrees with it.
 *
 * The anchors below are exact current text, so a fixture that stops matching
 * fails loudly in `replaceOnce` rather than planting into nothing and
 * asserting the gate is quiet about a document it never read.
 */
describe('documented constants agree with the live code (#1476)', () => {
  it('is green on the tree as it stands', () => {
    assert.match(gateAcceptsTree(), /match the finalized production registry/);
  });

  // -- the shipped instances ------------------------------------------------

  it('rejects a shared-contract enum whose members no live schema declares', () => {
    // The shipped line read `'concile'` against a schema whose first member
    // is `concise`. Note the misspelling was ONE CHARACTER, not a different
    // word: the issue filed it as `reconcile`, and the file never contained
    // that string. A checker written against the issue text would have passed.
    const output = gateRejects(
      'SPEC.md',
      (source) => replaceOnce(
        source,
        "- **`response_format`** (`'concise' | 'detailed' | 'json'`, default `'concise'`)",
        "- **`response_format`** (`'concile' | 'detailed' | 'json'`, default `'concile'`)",
      ),
      /shared contract documents `response_format` as `concile \| detailed \| json`/,
    );
    assert.match(output, /A caller copying the documented list is rejected at validation/);
  });

  it('rejects a shared-contract default the live schema contradicts', () => {
    const output = gateRejects(
      'SPEC.md',
      (source) => replaceOnce(
        source,
        "- **`response_format`** (`'concise' | 'detailed' | 'json'`, default `'concise'`)",
        "- **`response_format`** (`'concise' | 'detailed' | 'json'`, default `'json'`)",
      ),
      /shared contract documents `response_format` as defaulting to `json`, but the live schema defaults to `concise`/,
    );
    assert.match(output, /a caller who omits the field gets the other one/);
  });

  it('rejects a documented byte figure that contradicts a live constant', () => {
    // The shipped line said 620,000B where `TOOL_SURFACE_BUDGET.defaultMaxBytes`
    // is 611,000. The direction is the point: the document overstated the
    // headroom by 9,000B, so the reader who trusted it believed a raise was
    // available that the startup gate would have refused.
    const output = gateRejects(
      'SPEC.md',
      (source) => replaceOnce(
        source,
        '(`TOOL_SURFACE_BUDGET.defaultMaxBytes`, 611,000B)',
        '(`TOOL_SURFACE_BUDGET.defaultMaxBytes`, 620,000B)',
      ),
      /documents `TOOL_SURFACE_BUDGET\.defaultMaxBytes` as 620,000B, but the live constant is 611,000B/,
    );
    assert.match(output, /wrong by 9,000B/);
  });

  it('rejects a documented figure for the enforced limit and the response cap', () => {
    // Both constants are reachable the same way, and neither is reachable
    // today: the cap is written `(64,000) serialized bytes`, which this
    // matcher deliberately does not read. Asserting the arm works for a
    // constant nothing currently states is what keeps it from being a
    // one-name special case written around the defect that shipped.
    for (const [name, wrong, expected] of [
      ['AGGREGATE_SURFACE_LIMITS.maxBytes', '613,000B', /documents `AGGREGATE_SURFACE_LIMITS\.maxBytes` as 613,000B, but the live constant is 612,000B/],
      ['MAX_RESPONSE_BYTES', '65,000B', /documents `MAX_RESPONSE_BYTES` as 65,000B, but the live constant is 64,000B/],
    ] as const) {
      const output = gateRejects(
        'SPEC.md',
        (source) => `${source}\nA budget line: \`${name}\` is ${wrong} today.\n`,
        expected,
      );
      assert.match(output, /a reader sizing against the document is wrong by 1,000B/);
    }
  });

  // -- the boundaries, so the arms are not narrower than they claim ---------

  it('accepts a shared contract documenting ONE of several live variants', () => {
    // `mode` has seven live member lists. A gate demanding the
    // intersection would fail this correct line; one demanding a specific
    // tool's list would fail the next tool that reuses the name. This is the
    // false positive that would get the check switched off, so it is
    // asserted rather than assumed.
    gateRejects(
      'SPEC.md',
      (source) => `${source}\n- **\`mode\`** (\`'copy' | 'move'\`, default \`'copy'\`) — one of seven live variants.\n`,
      /^$/,
    );
  });

  it('ignores a field no live schema types as an enum', () => {
    // `max_results` is a real parameter with no `enum`. Nothing can prove
    // this line wrong, and inventing an enum for it would make the gate a
    // liar rather than a gate.
    gateRejects(
      'SPEC.md',
      (source) => `${source}\n- **\`max_results\`** (\`'alpha' | 'beta'\`, default \`'alpha'\`) — not enum-typed anywhere.\n`,
      /^$/,
    );
  });

  it('does not read a figure from the NEXT sentence as the constant’s value', () => {
    // The same failure §6 records in a different guise: a matcher that
    // crosses a sentence boundary attributes an unrelated measurement to the
    // constant named two clauses earlier, and the first false positive is
    // how a gate dies.
    gateRejects(
      'SPEC.md',
      (source) => `${source}\nThe \`TOOL_SURFACE_BUDGET.defaultMaxBytes\` budget is not a target. The measured surface reached 598,816B on the tree this was written against.\n`,
      /^$/,
    );
  });
});
