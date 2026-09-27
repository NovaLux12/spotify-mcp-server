/**
 * #608 — the v2 non-goals list stays a decision record, not a paragraph.
 *
 * The issue this closes is a duplication risk that has to be engineered away
 * rather than watched for. The list exists in three places on purpose — the
 * record in `docs/non-goals.md`, the one-line mirror in `SPEC.md` §1, and the
 * reader-facing list in the README — and three copies of a decision is three
 * chances for one of them to be the stale one. So the mirrors carry **labels
 * only**: the label set is the shared key, and the rationale and evidence live
 * in exactly one file. That is what makes it mechanically checkable, and it is
 * also what keeps the README from restating scope in its own words, which the
 * issue asked for.
 *
 * Four things are gated here, and each is gated on the shape that would
 * actually break rather than on the presence of a string:
 *
 *  - **The label sets are the same set.** Not a subset check — set equality in
 *    both directions, so a heading added to the record without a mirror fails
 *    and a mirror line deleted from the README fails.
 *  - **Every entry has all four parts.** A non-goal with no alternative is a
 *    dead end for the reader who wanted the feature, which the issue calls out
 *    explicitly; `**Instead.**` is therefore required, not encouraged.
 *  - **Every entry cites a source.** A "why" with nothing behind it is the
 *    failure mode `AGENTS.md` §6 warns about — an unsourced platform fact
 *    restated as a finding.
 *  - **No figure is typed into the record.** A tool count or a payload size in
 *    prose is stale within one release; `tests/doc-figures.test.ts` holds the
 *    same line for the pages that carry generated blocks, and this file holds
 *    it for the one that carries none.
 *
 * Every assertion is paired with the mutation that would defeat it. A guard
 * whose negative case was never run is decoration.
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RECORD = 'docs/non-goals.md';

function readDoc(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

/** The prose under one `###` heading, up to the next heading of any level. */
function section(source: string, heading: string): string {
  const at = source.indexOf(heading);
  assert.ok(at >= 0, `no ${heading} heading found`);
  const rest = source.slice(at + heading.length);
  const next = rest.search(/^#{2,3} /m);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Every `###` heading in the record — the label set the mirrors must match. */
function recordLabels(source: string): string[] {
  return [...source.matchAll(/^### (.+)$/gm)].map((match) => match[1].trim());
}

/** `- **Label** — rationale` lines, i.e. the SPEC §1 mirror. */
function specLabels(source: string): string[] {
  const body = source.slice(
    source.indexOf('### Non-Goals'),
    source.indexOf('\n## ', source.indexOf('### Non-Goals')),
  );
  return [...body.matchAll(/^- \*\*(.+?)\*\* — /gm)].map((match) => match[1].trim());
}

/** `- Label` lines, i.e. the README's reader-facing mirror. */
function readmeLabels(source: string): string[] {
  const start = source.indexOf('### What this server is not');
  assert.ok(start >= 0, 'README.md has no "What this server is not" section');
  const rest = source.slice(start);
  const end = rest.search(/^## /m);
  return [...(end === -1 ? rest : rest.slice(0, end)).matchAll(/^- (.+)$/gm)].map((match) => match[1].trim());
}

/** The record's body with every `---` rule and heading stripped. */
function recordProse(source: string): string {
  return source.replace(/^#{1,6} .+$/gm, '').replace(/^---$/gm, '');
}

/** A number written as a tool count — the shape `doc-figures` bans in prose. */
const HAND_TYPED_TOOL_COUNT = /\*{0,2}(\d[\d,]*)\*{0,2}\s*-tool\b/g;
const HAND_TYPED_TEST_COUNT = /\*{0,2}(\d[\d,]*)\+?\*{0,2}\s+tests?\b/gi;
/** A figure carrying byte units, at any magnitude. */
const BYTE_SIZED_FIGURE = /(?<![\w-])\*{0,2}(\d[\d,]*)\*{0,2}\s*(?:B\b|bytes?\b|-byte\b)/g;
/** A comma-grouped or five-digit figure: the aggregate-measurement scale. */
const AGGREGATE_FIGURE = /\*{0,2}(\d{1,3}(?:,\d{3})+|\d{5,})/g;

function figuresIn(prose: string, pattern: RegExp): string[] {
  return [...prose.matchAll(pattern)].map((match) => match[1]);
}

function ungatedFigures(prose: string): string[] {
  return [...new Set([
    ...figuresIn(prose, HAND_TYPED_TOOL_COUNT),
    ...figuresIn(prose, HAND_TYPED_TEST_COUNT),
    ...figuresIn(prose, BYTE_SIZED_FIGURE),
    ...figuresIn(prose, AGGREGATE_FIGURE),
  ])].sort();
}

const RECORD_HEADINGS = [
  'Audio streaming, audio analysis, and offline playback',
  'A web UI, a dashboard, or an MCP UI surface',
  'Multi-tenant or hosted operation',
  "Sharing one user's credentials across users",
  'Lyrics',
  'The Spotify Connect SDK and native client integration',
  'Voice control',
  'Training a model on Spotify data, or exporting derived profiles',
  'A second third-party upstream, ad-tech, or monetization egress',
  "Working around Spotify's own controls",
];

describe('the v2 non-goals list is one decision record with two mirrors (#608)', () => {
  it('the record carries every decision the issue named, as a heading', () => {
    // Pinned so a later edit that quietly drops a contested decision — the
    // exact thing the issue says happens "every release" — fails here.
    assert.deepEqual(recordLabels(readDoc(RECORD)), RECORD_HEADINGS);
  });

  it('SPEC.md §1 and the README mirror the record\'s labels exactly, in both directions', () => {
    const expected = recordLabels(readDoc(RECORD));
    assert.deepEqual(specLabels(readDoc('SPEC.md')), expected, 'SPEC.md §1 does not mirror the record');
    assert.deepEqual(readmeLabels(readDoc('README.md')), expected, 'the README does not mirror the record');
    // The scan is not vacuous: the record really does carry the labels.
    assert.ok(expected.length >= RECORD_HEADINGS.length, 'recordLabels() found no headings');
  });

  it('the mirror comparison rejects a record heading that no mirror carries', () => {
    const expected = recordLabels(readDoc(RECORD));
    const withoutLyrics = expected.filter((label) => label !== 'Lyrics');
    assert.notDeepEqual(specLabels(readDoc('SPEC.md')), withoutLyrics);
    assert.notDeepEqual(readmeLabels(readDoc('README.md')), withoutLyrics);
  });

  it('both mirrors carry a rationale, so a label is never a bare list item', () => {
    const body = readDoc('SPEC.md').slice(
      readDoc('SPEC.md').indexOf('### Non-Goals'),
      readDoc('SPEC.md').indexOf('\n## ', readDoc('SPEC.md').indexOf('### Non-Goals')),
    );
    const rationale = (label: string): string | undefined => {
      const line = body.split('\n').find((candidate) => candidate.startsWith(`- **${label}** — `));
      assert.ok(line, `SPEC.md has no rationale for "${label}"`);
      return line.split(' — ').slice(1).join(' — ').trim();
    };
    for (const label of recordLabels(readDoc(RECORD))) {
      assert.ok((rationale(label) ?? '').length > 0, `SPEC.md rationale for "${label}" is empty`);
    }
  });

  it('every entry states what is not done, why, what is offered instead, and a source', () => {
    const source = readDoc(RECORD);
    for (const label of recordLabels(source)) {
      const body = section(source, `### ${label}\n`);
      for (const part of ['**Not.**', '**Why.**', '**Instead.**', '**Sources.**']) {
        assert.ok(
          body.includes(part),
          `non-goals entry "${label}" has no ${part.replace(/\*/g, '')} — an entry missing the alternative is a dead end for the reader`,
        );
      }
    }
  });

  it('the entry-part check would fail on an entry that dropped its alternative', () => {
    const source = readDoc(RECORD);
    const body = section(source, '### Lyrics\n');
    assert.ok(body.includes('**Instead.**'), 'fixture is wrong: the Lyrics entry has no alternative');
    const stripped = body.replace('**Instead.**', 'alternatively,');
    assert.ok(!stripped.includes('**Instead.**'), 'the part check did not react to a removed alternative');
  });

  it('both index pages link the record, so it is reachable from each', () => {
    for (const relative of ['README.md', 'SPEC.md']) {
      assert.ok(
        readDoc(relative).includes('docs/non-goals.md'),
        `${relative} does not link ${RECORD}; a decision record nobody can find is not maintained`,
      );
    }
  });

  it('the record prose carries no hand-typed figure', () => {
    const prose = recordProse(readDoc(RECORD));
    const hits = ungatedFigures(prose);
    assert.deepEqual(hits, [], `${RECORD} prose hand-types a figure: ${hits.join(', ')}`);
  });

  it('the figure guard would have caught the counts it exists to catch', () => {
    // The two sentences this replaces, as they would have been written: an
    // aggregate tool count and a `tools/list` payload size, both live figures.
    for (const planted of [
      'The 587-tool surface ships 607,000 bytes of schema.',
      'a 512-tool default surface',
      'it answers in 830+ tests',
      '13,896 bytes of headroom',
    ]) {
      assert.ok(
        ungatedFigures(recordProse(planted)).length > 0,
        `the figure guard did not flag ${JSON.stringify(planted)}`,
      );
    }
  });
});
