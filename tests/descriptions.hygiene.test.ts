/**
 * Description-prose hygiene gate (#922).
 *
 * Two conventions had grown into the registered tool surface and both were
 * carrying cost without carrying meaning:
 *
 *   1. Quota cost encoded as a coloured circle. 186 of 592 descriptions
 *      (30.6%) opened their cost clause with one of U+1F7E2 / U+1F7E1 /
 *      U+1F534, and the only place any of them was explained was an internal
 *      authoring skill. The signal was unreadable to a screen reader, to a
 *      monochrome terminal and to a model that does not weight emoji — and it
 *      was the only cost information an agent had before choosing among those
 *      186 tools.
 *   2. "Also covers:" / "See also:" cross-sell breadcrumbs on 29 descriptions.
 *      They spent prompt bytes on routing hints, and an agent that followed one
 *      was routed to a duplicate name instead of the canonical tool.
 *
 * Both are now expressed in words ("Quota: 1 read + 1 write"). The quota cost
 * is the part worth keeping — an agent choosing between 186 tools needs it — so
 * this gate pins the WORDED cost and not merely the absence of the glyph: a
 * description that drops the circle without saying what the call costs is a
 * regression the circle-only check would happily pass.
 *
 * The descriptions are read off the live registry via `tests/live-registry.ts`
 * rather than a written-out list, so a newly registered tool is covered the
 * moment it exists and a removed one cannot leave a stale entry behind.
 *
 * Run: node --import tsx --test tests/descriptions.hygiene.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildFullRegistryServer } from './live-registry.js';

/**
 * Emoji presentation ranges, by code point.
 *
 * Scoped deliberately: the acceptance criterion is "no non-ASCII emoji", and
 * the surface legitimately uses ordinary typography — em-dash, en-dash, the
 * multiplication sign, arrows, ≤, ∪, ≈. Those are readable text and removing
 * them would be a different change. What is banned here is pictographic
 * codepoints, the class that is unreadable to a monochrome renderer and that
 * was being used to carry a non-textual meaning (a severity tier).
 */
const EMOJI_RANGES: readonly (readonly [number, number])[] = [
  [0x1f300, 0x1f5ff], // symbols & pictographs
  [0x1f600, 0x1f64f], // emoticons
  [0x1f680, 0x1f6ff], // transport & map
  [0x1f700, 0x1f77f], // alchemical symbols
  [0x1f780, 0x1f7ff], // geometric shapes extended (U+1F7E1/2/3 quota circles)
  [0x1f900, 0x1f9ff], // supplemental symbols & pictographs
  [0x1fa70, 0x1faff], // symbols & pictographs extended-A
  [0x2600, 0x27bf], // misc symbols + dingbats
  [0x2b00, 0x2bff], // misc symbols and arrows
  [0xfe0f, 0xfe0f], // variation selector-16
];

/** The specific glyphs #922 removed, named so a reintroduction is legible. */
const QUOTA_GLYPHS: Readonly<Record<string, string>> = {
  '\u{1f7e2}': 'U+1F7E2 GREEN CIRCLE',
  '\u{1f7e1}': 'U+1F7E1 YELLOW CIRCLE',
  '\u{1f534}': 'U+1F534 RED CIRCLE',
};

function isEmoji(codePoint: number): boolean {
  return EMOJI_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi);
}

interface ToolDescription {
  readonly name: string;
  readonly description: string;
}

/** Every registered tool's description, read off the live registry. */
function liveDescriptions(): ToolDescription[] {
  const server = buildFullRegistryServer();
  const registry = (server as unknown as {
    _registeredTools?: Record<string, { description?: string }>;
  })._registeredTools ?? {};
  return Object.entries(registry)
    .map(([name, entry]) => ({ name, description: entry.description ?? '' }))
    .filter((tool) => tool.description.length > 0);
}

const DESCRIPTIONS = liveDescriptions();

describe('registered tool descriptions are hygienic (#922)', () => {
  it('derives a non-trivial surface, so the gates below are not vacuous', () => {
    // A test that cannot fail is worse than no test. If the registry pass
    // silently returned nothing, every assertion below would pass against an
    // empty list, so the surface size is asserted before the rules.
    assert.ok(
      DESCRIPTIONS.length > 500,
      `expected the full surface to register >500 described tools, got ${DESCRIPTIONS.length} — the registry pass is not deriving real descriptions`,
    );
  });

  it('no description contains an emoji character', () => {
    const offenders = DESCRIPTIONS.flatMap(({ name, description }) =>
      [...description]
        .filter((ch) => isEmoji(ch.codePointAt(0) ?? 0))
        .map((ch) => `${name}: contains U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')} ${QUOTA_GLYPHS[ch] ?? JSON.stringify(ch)}`),
    );
    assert.deepEqual(offenders, [], `emoji reintroduced into tool descriptions:\n${offenders.join('\n')}`);
  });

  it('no description contains a quota circle glyph', () => {
    // Stated separately from the range check above so a regression names the
    // exact convention that came back rather than a codepoint range.
    const offenders = DESCRIPTIONS.filter(({ description }) =>
      Object.keys(QUOTA_GLYPHS).some((glyph) => description.includes(glyph)),
    ).map(({ name }) => name);
    assert.deepEqual(offenders, [], `quota circle reintroduced: ${offenders.join(', ')}`);
  });

  it('no description carries an "Also covers:" or "See also:" breadcrumb', () => {
    const offenders = DESCRIPTIONS.filter(({ description }) =>
      /Also covers:|See also:/.test(description),
    ).map(({ name }) => name);
    assert.deepEqual(offenders, [], `cross-sell breadcrumb reintroduced: ${offenders.join(', ')}`);
  });

  it('states a worded quota cost wherever one was stated before', () => {
    // The point of #922 was to make the cost READABLE, not to delete it. Every
    // description that declares a quota must still declare it in words, so an
    // agent choosing between tools is not left with no cost information at all.
    //
    // "In words" means a legible cost token: a count ("1 read", "2-3 calls"),
    // a named request ("GET", plural "GETs" included), a paging shape
    // ("paginated walks", "one ... walk"), or an explicit statement that the
    // call is local. Demanding a digit would have failed 90 correct
    // descriptions whose cost is a named request or a walk instead.
    const declaring = DESCRIPTIONS.filter(({ description }) => /Quota:/.test(description));
    assert.ok(
      declaring.length > 100,
      `expected a large quota-declaring surface, got ${declaring.length}`,
    );
    const COST_TOKEN = /\d|GET|PUT|POST|DELETE|PATCH|local|no api|calls?\b|walk|paginat/i;
    const unworded = declaring.filter(({ description }) => {
      const clause = (description.split('Quota:')[1] ?? '').trim();
      return !COST_TOKEN.test(clause);
    }).map(({ name }) => name);
    assert.deepEqual(unworded, [], `quota cost is no longer stated in words: ${unworded.join(', ')}`);
  });

  it('does not leave an orphaned separator where a breadcrumb was removed', () => {
    // The mechanical removal ran to the end of the string, so a description
    // that ended in a breadcrumb could be left with a dangling em-dash or a
    // double space. Cheap to assert, and it is the exact shape of a partial
    // edit.
    const offenders = DESCRIPTIONS
      .filter(({ description }) => /—\s*$|\s{2,}[.,]|\s+$/.test(description))
      .map(({ name, description }) => `${name}: ${JSON.stringify(description.slice(-40))}`);
    assert.deepEqual(offenders, [], `orphaned separator left in a description:\n${offenders.join('\n')}`);
  });
});
