/**
 * #1338 — AGENTS.md's "never call these" table must agree with the runtime
 * classifier it is supposed to be a prose view of.
 *
 * The table's own heading defines its scope: *"Never call these — no
 * replacement, or superseded with no live call site."* Both halves of that
 * definition are checkable against `GATED_FAMILIES` in `src/gating.ts`, and
 * the row that broke them is the reason this issue was filed.
 *
 * The `/users/{id}` row claimed `get_user_profile` / `get_user_playlists` /
 * `get_user_playlists_by_id` "still call them and explain the 403 rather than
 * degrading — that is why they are here and not deleted". Three things wrong
 * in one row, each of which misled a reader into filing #1338:
 *
 *  1. The family **does** have live call sites, so by the table's own rule it
 *     is not a never-call row at all. It is registration-dependent, and the
 *     section above the table says so.
 *  2. `get_user_playlists` was never a caller. Despite the name it reads
 *     `GET /me/playlists`, which Spotify never removed — the distinction
 *     `src/gating.ts` already records and this row lost.
 *  3. "explain the 403" is the justification the never-call bucket forbids
 *     outright two paragraphs later, so the row argued against itself using
 *     the table's own rules.
 *
 * Neither the census nor `check:doc-tool-names` could catch this.
 * `checkGatedEndpointTruth()` guards the **array** in both directions, which
 * is why `get_user_playlists` cannot be re-added there; the array was right
 * and the **prose** had drifted away from it, and AGENTS.md is not in the
 * doc-name gate's scan set at all. A guard on the prose is the missing half.
 *
 * Scope: the general assertion below is deliberately general, and it also found
 * a second violation, the `browse-categories` row, whose family has live call
 * sites (`get_category`, `browse_category_deepdive`, `category_resolver`). That
 * row was fixed under #1359 and its `REPORTED_NOT_FIXED` entry deleted, so the
 * set is now empty. It stays a named constant rather than an inline `[]` so a
 * future violation is recorded deliberately instead of being papered over.
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GATED_FAMILIES, type GatedFamily } from '../src/gating.js';
import { buildFullRegistryServer, collectToolSchemas } from './live-registry.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS = 'AGENTS.md';

const NEVER_CALL_HEADING =
  '**Never call these — no replacement, or superseded with no live call site.**';

const REGISTRATION_DEPENDENT_HEADING = '**Registration-dependent';

/**
 * The registration-dependent subsection: from its own bold heading to the
 * never-call heading. Scoped to that range because both of the load-bearing
 * claims live inside it — the 403-is-disclosed contract that keeps the family
 * out of the never-call table, and the `200` question.
 */
function registrationDependentSection(source: string): string {
  const from = source.indexOf(REGISTRATION_DEPENDENT_HEADING);
  assert.ok(
    from >= 0,
    `AGENTS.md has no "${REGISTRATION_DEPENDENT_HEADING}…" subsection. If it ` +
      'was reworded, update this guard to match — otherwise the assertions ' +
      'below would scan an empty range and pin nothing.',
  );
  const to = source.indexOf(NEVER_CALL_HEADING, from);
  assert.ok(
    to > from,
    `the "${REGISTRATION_DEPENDENT_HEADING}…" subsection runs past the ` +
      'never-call heading, so the range below would be unbounded.',
  );
  return source.slice(from, to);
}

/**
 * Family ids whose endpoints are named in the never-call table while the
 * family still has live call sites. Empty: the `browse-categories` row was
 * fixed under #1359. A new entry means a row was found that the table's own
 * heading excludes, and it must be resolved here rather than added.
 */
const REPORTED_NOT_FIXED: ReadonlySet<string> = new Set<string>();

function readAgents(): string {
  return readFileSync(join(ROOT, AGENTS), 'utf8');
}

/**
 * The first Markdown table under the never-call heading. Scoped to that table
 * and not to the whole section on purpose: the "Removed tool | Replacement"
 * table further down legitimately names **live** tools — `check_in_library`
 * and friends — because those are the replacements, not callers of a
 * never-call endpoint. Widening the scan to the section would flag correct
 * prose.
 */
function neverCallTable(source: string): string {
  const at = source.indexOf(NEVER_CALL_HEADING);
  assert.ok(
    at >= 0,
    `AGENTS.md has no "${NEVER_CALL_HEADING}" section. If the heading was ` +
      'reworded, update this guard to match the new text — otherwise the ' +
      'assertions below would pass over an empty table and pin nothing.',
  );
  const lines = source.slice(at + NEVER_CALL_HEADING.length).split('\n');
  const rows: string[] = [];
  for (const line of lines) {
    if (!line.trimStart().startsWith('|')) {
      // The table is the first block of `|` lines; prose either side of it.
      if (rows.length > 0) break;
      continue;
    }
    rows.push(line);
  }
  assert.ok(rows.length >= 3, `never-call table parsed to ${rows.length} lines; expected a header and rows`);
  return rows.join('\n');
}

/**
 * Endpoint paths named in the table's FIRST cell, which is the `Endpoint`
 * column — the only cell that is about endpoints. Verb-prefixed forms
 * (`PUT/DELETE /me/library`) are handled by taking only the whitespace token
 * that starts with `/`, so the slash inside `PUT/DELETE` is not mistaken for
 * a path.
 */
function pathsInEndpointColumn(table: string): string[] {
  const out: string[] = [];
  for (const line of table.split('\n')) {
    const firstCell = line.trim().replace(/^\|/, '').split('|')[0] ?? '';
    for (const span of firstCell.matchAll(/`([^`]+)`/g)) {
      for (const token of span[1].split(/\s+/)) {
        if (token.startsWith('/')) out.push(token);
      }
    }
  }
  return out;
}

/** snake_case tokens the table backticks anywhere — the tool names it cites. */
function citedToolNames(table: string): string[] {
  return [
    ...new Set(
      [...table.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map((match) => match[1] as string),
    ),
  ].sort();
}

function familiesWithLiveCallSites(): GatedFamily[] {
  return GATED_FAMILIES.filter((family) => family.tools.length > 0);
}

describe('AGENTS.md agrees with the gated-endpoint classifier (#1338)', () => {
  const source = readAgents();
  const table = neverCallTable(source);
  const paths = pathsInEndpointColumn(table);
  const cited = citedToolNames(table);

  it('finds the table and its paths — the scan is not vacuous', () => {
    assert.ok(paths.length >= 6, `extracted only ${paths.length} endpoint paths from the never-call table`);
    assert.ok(cited.includes('follow_artists'), 'expected the never-call table to still cite a retired tool');
  });

  it('names no registration-dependent family that still has call sites', () => {
    const violations = familiesWithLiveCallSites()
      .filter((family) => paths.some((path) => family.pattern.test(path)))
      .map((family) => family.id)
      .sort();

    assert.deepEqual(
      violations,
      [...REPORTED_NOT_FIXED].sort(),
      'AGENTS.md\'s never-call table names a family that GATED_FAMILIES ' +
        'still attributes live call sites to. A family with callers is ' +
        'registration-dependent and belongs above the table, not in it: ' +
        'deleting its tools would remove a path that works on a ' +
        'grandfathered registration rather than fix one that does not. ' +
        `Offending families: ${violations.join(', ') || '(none)'}. ` +
        'Fix the row and delete its entry from REPORTED_NOT_FIXED.',
    );
  });

  // #1359 — the second violation this guard found, and the one that proves it
  // is not decoration. `browse-categories` WAS in the table, and the guard
  // passed only because `browse-categories` sat in REPORTED_NOT_FIXED. The
  // table's own heading is "no replacement, or superseded with no live call
  // site", and this family had three live call sites the whole time, so the
  // row was excluded by the rule the table states. The fix moved the row above
  // the table and emptied the allowlist; these two assertions then failed
  // without the doc change and passed with it.
  it('no longer names browse-categories in the never-call table (#1359)', () => {
    const offending = paths.filter((path) => GATED_FAMILIES[0].pattern.test(path));
    assert.deepEqual(
      offending,
      [],
      'the never-call table names a /browse/categories path again. That family ' +
        'still has live call sites (`get_category`, `browse_category_deepdive`, ' +
        '`category_resolver`), so by the table\'s own heading it is ' +
        'registration-dependent and belongs in the section above the table.',
    );
  });

  it('still documents the browse-categories family above the table (#1359)', () => {
    // The removal must not read as "nobody calls this". Guard the direction the
    // fix could have failed in: dropping the row without replacing the claim
    // would leave the family undocumented, and the census's per-tool
    // cross-check would still pass because it reads the array, not this prose.
    const at = source.indexOf(NEVER_CALL_HEADING);
    const above = source.slice(0, at);
    assert.match(
      above,
      /\/browse\/categories/,
      'the section above the never-call table no longer mentions /browse/categories, ' +
        'so the three live call sites are undocumented. Restore the paragraph.',
    );
  });

  it('does not cite get_user_playlists, which never called a /users endpoint', async () => {
    // The name is the whole trap: it reads `GET /me/playlists`, never removed.
    const registry = collectToolSchemas(await buildFullRegistryServer());
    assert.ok(
      registry.has('get_user_playlists'),
      'get_user_playlists is no longer registered; if it was retired, drop ' +
        'this assertion rather than letting it pass on an empty registry.',
    );
    const attributed = GATED_FAMILIES.some((family) => family.tools.includes('get_user_playlists'));
    assert.equal(
      attributed,
      false,
      'get_user_playlists is now attributed to a gated family; if that is ' +
        'correct, this assertion is stale and the table should be re-read.',
    );
    assert.ok(
      !cited.includes('get_user_playlists'),
      'AGENTS.md cites `get_user_playlists` in the never-call table. It ' +
        'reads `GET /me/playlists`, which Spotify never removed, so listing ' +
        'it beside the `/users/{id}` readers sent looking for a migration ' +
        'that was never needed.',
    );
  });
});

/**
 * #1338, second half. The first half of this file guards the never-call table
 * against `GATED_FAMILIES`. This half guards the claim the table moved TO.
 *
 * #1355 moved the `/users` family out of that table and justified the move
 * with a premise this repository cannot support: "a grandfathered
 * registration still answers 200, so deleting them would remove a path that
 * works". No probe, fixture, or recorded run in the tree demonstrates a 200 on
 * either path. The one artefact that was ever cited for the claim — a dated
 * probe JSON under `memory/`, removed from the working tree in #1260 because
 * `.gitignore` drops it — records `403 / "message": "Forbidden"` for BOTH
 * paths when read back out of git history. Every `200` in that same probe is a
 * `/me/*` or `search` path.
 *
 * So the claim was not merely uncited; the cited evidence says the opposite.
 * That is the same rot §6 of AGENTS.md describes, and it is load-bearing: a
 * reader who believes it concludes a working path is being removed, and
 * declines to fix a dead one.
 */
describe('AGENTS.md does not assert the unverified grandfathered-200 premise (#1338)', () => {
  const source = readAgents();
  const section = registrationDependentSection(source);
  const lines = section.split('\n');

  it('finds the subsection and its grandfathered question — the scan is not vacuous', () => {
    assert.ok(
      /grandfather/i.test(section),
      'the registration-dependent subsection no longer mentions a grandfathered ' +
        'registration at all. If that question was resolved rather than dropped, ' +
        'cite the evidence here and update this guard; do not let it pass because ' +
        'the words went away.',
    );
    assert.ok(
      /unverified|open question|established nowhere/i.test(section),
      'the subsection discusses a grandfathered registration but carries no ' +
        'explicit unverified/open-question marker. An unmarked mention reads as ' +
        'an assertion, which is the failure this guard exists to catch.',
    );
  });

  it('states the 200 only inside the flagged, quoted note', () => {
    // A grandfathered-200 claim is legitimate ONLY as something explicitly
    // flagged as unestablished. Flagged == blockquoted: the callout is a
    // visually separate aside, so a skimming reader cannot take it as part of
    // the standing contract. Plain prose is an assertion.
    const asserted = lines.filter(
      (line) =>
        /grandfather/i.test(line) &&
        /(?<![-\w])200(?![-\w])/.test(line) &&
        !line.trimStart().startsWith('>'),
    );

    assert.deepEqual(
      asserted,
      [],
      'AGENTS.md asserts, in plain prose, that a grandfathered registration ' +
        'answers 200 on a gated path. Nothing in this repository establishes ' +
        'that, and the probe artefact once cited for it records 403 on both ' +
        '`/users` paths. If the claim is now genuinely verified, cite the run ' +
        'that demonstrates it and delete this assertion. Offending lines:\n  ' +
        asserted.join('\n  '),
    );
  });

  it('names all three live call sites so a reader can find them', () => {
    // The keep-it decision is per call site. A reader sent here to check one
    // tool needs the other two; that is what `GATED_FAMILIES.tools` is for,
    // and this asserts the prose still agrees with it.
    const family = GATED_FAMILIES.find((f) => f.id === 'user-profile');
    assert.ok(family, 'the `user-profile` family is gone from GATED_FAMILIES; update this guard.');
    for (const tool of family.tools) {
      assert.ok(
        section.includes(tool),
        `AGENTS.md's registration-dependent subsection does not name \`${tool}\`, ` +
          'one of the three live call sites on the removed /users paths. A reader ' +
          'auditing the keep-it decision must be able to find every call site.',
      );
    }
  });
});
