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
 * Scope: the general assertion below is deliberately general, and it still
 * finds one further violation the report to the issue author leaves unfixed —
 * the `browse-categories` row, whose family also has live call sites
 * (`get_category`, `browse_category_deepdive`, `category_resolver`). It is
 * named in `REPORTED_NOT_FIXED` and the assertion requires the detected set
 * to *equal* that list, so it cannot rot into a graveyard and cannot be
 * widened quietly. Fixing that row means deleting its entry, which is the
 * intended pressure.
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

/**
 * Family ids whose endpoints are named in the never-call table while the
 * family still has live call sites. One entry, reported and not fixed here.
 */
const REPORTED_NOT_FIXED: ReadonlySet<string> = new Set(['browse-categories']);

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
        '`browse-categories` is a known, reported, unfixed row — fix it and ' +
        'delete its entry from REPORTED_NOT_FIXED.',
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
