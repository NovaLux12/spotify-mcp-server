/**
 * Per-tool test-coverage gate (#663).
 *
 * ## What this asserts
 *
 * Every tool name the production server actually serves is either exercised by
 * a test file or listed in {@link KNOWN_UNTESTED} with a reason. A name that is
 * neither fails the run and is named in the failure.
 *
 * The issue behind it: A13-002 measured 253 names with zero mentions anywhere
 * under `tests/`, concentrated in the swarm composite families — which are also
 * the modules doing 100-item batch writes. Nothing warned a reviewer that a new
 * module had arrived without a single invocation, and nothing failed when a
 * test was deleted along with the last reference to its tool.
 *
 * That 253 is not the number this gate produces, and the two are not directly
 * comparable. A13-002 searched for the 560 names written as literal
 * `server.tool('name'` calls in `src`, and counted a hit anywhere in the text
 * of `tests/`, comments included. This gate counts a hit only in code, against
 * the names the wire actually serves, so the two move in opposite directions
 * and land at 103 — see the diagnostic printed on every run.
 *
 * ## Both halves are derived; neither is typed in
 *
 * **Served** comes from {@link wireToolNames} — the real `src/index.ts` over
 * stdio, `tools/list` after production gates and finalizers. That is the same
 * derivation `scripts/surface-census.mjs` measures and writes into the generated
 * documentation, so this gate and the published `tools/list` count cannot
 * disagree. It is not a second registrar list, and not `REGISTRAR_MANIFEST`
 * read as a table of names.
 *
 * **Exercised** comes from reading the test sources. A name counts when a
 * scanned `tests/*.test.ts` file contains it as a complete string literal in
 * code. Comments are blanked first, so a file that only *talks about* a tool —
 * a header explaining what it covers, a prose assertion about an error message —
 * does not count, which is the failure mode that made the original measurement
 * wrong in the generous direction.
 *
 * ## What this is NOT, stated plainly
 *
 * The issue asked for an *invocation map recorded by the shared stub client* —
 * evidence that a tool was actually called at runtime. That is the stronger
 * claim and this gate does not make it. It could not: ~100 test files each
 * define their own local `invoke()` against their own stub server, so there is
 * no single chokepoint to record, and building one would mean rewriting the
 * suite rather than gating it. What this measures is *evidence of exercise in
 * the test sources*, which is one step weaker.
 *
 * The honest consequence: a name mentioned in a test but never called still
 * counts. The gate is therefore proof that coverage did not silently regress —
 * not proof that any specific tool works. The `KNOWN_UNTESTED` list below is
 * where the known gap is recorded and reviewed, and the gate's job is to stop it
 * growing silently.
 */

// Redirects HOME to a disposable temp root so nothing resolved at module-load
// time can reach Jack's real $HOME (#1274). Must precede every other import.
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SpotifyClient } from '../src/client.js';
import {
  moduleToolNames,
  registerManifestModules,
  REGISTRAR_MANIFEST,
  type RegistrarManifestContext,
} from '../src/tools/annotations.js';
import { blankNonCode } from '../scripts/blank-non-code.mjs';
import { wireToolNames } from './wire-registry.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TESTS_DIR = join(REPO_ROOT, 'tests');

/**
 * This file is excluded from its own scan, and the exclusion is asserted below.
 *
 * `KNOWN_UNTESTED` is a list of tool names written as string literals in this
 * file, so a scan that read this file would find every allow-listed name and
 * report 587/587 covered. The gate would then pass for the wrong reason, the
 * allow-list would appear to be doing nothing, and a genuinely new untested tool
 * would still be caught — but the number everyone reads would be a lie, and so
 * would the "shrink the list" signal. This is the oracle-containing-the-answer
 * shape, and it is why the exclusion is a named constant with its own test
 * rather than a filter buried in the walk.
 */
const SELF = fileURLToPath(import.meta.url);
const EXCLUDED_FROM_SCAN: ReadonlySet<string> = new Set([SELF]);

/**
 * The reviewed list of served tool names with no test exercising them.
 *
 * Every entry is a real, currently-uncovered name: the last assertion in this
 * file requires the set of names here to EQUAL the set the scan finds
 * uncovered, so an entry that gains a test fails the build until it is deleted
 * rather than lingering as a second registrar list. The same applies in reverse
 * — a name that stops being served fails too.
 *
 * `module` is not decoration. It is cross-checked against the manifest's own
 * registration, so a name cannot drift into the wrong group when a tool is
 * renamed or moved.
 */
const KNOWN_UNTESTED: readonly {
  readonly module: string;
  readonly reason: string;
  readonly tools: readonly string[];
}[] = [
  {
    module: 'swarm3discovery',
    reason:
      'swarm3 discovery composites are registered wholesale and have no per-tool test file yet (epic #575). Read-only report tools, so the risk is a wrong field rather than a bad write.',
    tools: [
      'artist_album_completeness', 'artist_catalog_stats', 'artist_collaboration_network',
      'artist_discography_gaps', 'artist_era_sampler', 'artist_top_vs_saved', 'decade_sampler_plan',
      'era_distribution_report', 'lyric_snippet_search', 'year_explorer',
    ],
  },
  {
    module: 'swarm3bdiscovery',
    reason:
      'The second discovery wave, same shape and same absence: registered as a family, never exercised (epic #575).',
    tools: [
      'artist_album_timeline', 'artist_collection_gaps', 'artist_debut_release_finder',
      'artist_decade_span', 'artist_discography_search', 'artist_era_map', 'artist_latest_releases',
      'artist_live_albums_finder', 'artist_release_type_breakdown', 'genre_dive_search',
      'scene_sampler_search',
    ],
  },
  {
    module: 'swarm3shows',
    reason:
      'Show and episode composites, untested as a family (epic #575). Several here are WRITES — subscribe_to_show, unsubscribe_from_show, mark_episode_played_plan — so this is the highest-risk group on the list, not merely the largest.',
    tools: [
      'episode_guest_census', 'episode_runtime_report', 'get_episode_details', 'get_show_details',
      'get_show_latest_episode', 'list_saved_shows', 'mark_episode_played_plan', 'show_activity_feed',
      'shows_without_new_episodes', 'stale_saved_shows_plan', 'subscribe_to_show',
      'unsubscribe_from_show',
    ],
  },
  {
    module: 'swarm3analytics',
    reason:
      'The entire analytics family is untested (epic #575) — every name in this module is on the list, which is the clearest single signal of the gap this gate exists to hold visible.',
    tools: [
      'artist_listening_clock', 'artist_velocity_report', 'binge_detector_report',
      'era_preference_report', 'listening_gaps_report', 'listening_history_export',
      'listening_recap_brief', 'listening_streak_report', 'mood_bucket_report',
      'repeat_listener_report', 'session_length_report', 'top_artist_leaderboard',
      'top_artist_ranking_delta', 'top_track_leaderboard', 'top_track_ranking_delta',
    ],
  },
  {
    module: 'swarm3playlistops',
    reason:
      'Playlist-operation composites, untested as a family (epic #575). This group contains the *_plan tools that take a commit path, so an untested plan handler is a write path with no regression test behind it.',
    tools: [
      'dedupe_playlist_apply', 'dedupe_playlist_plan', 'extract_playlist_range',
      'filter_playlist_by_artist', 'filter_playlist_by_duration', 'filter_playlist_by_era',
      'interleave_playlists_plan', 'move_tracks_between_playlists',
      'playlist_difference_plan', 'playlist_edit_journal', 'playlist_intersection',
      'playlist_table_of_contents', 'playlist_union_preview', 'rotate_playlist_plan',
      'sample_playlist_tracks', 'split_playlist_by_count',
      'split_playlist_by_duration',
    ],
  },
  {
    module: 'swarm3snapshots',
    reason:
      'The snapshot family is 20/24 untested and includes apply_snapshot_changes, restore_playlist_from_snapshot and prune_old_snapshots — destructive operations with no test at all. Largest untested block in the tree (epic #575).',
    tools: [
      'apply_snapshot_changes', 'delete_playlist_snapshot', 'export_snapshot_bundle',
      'find_lost_since_snapshot', 'find_new_since_snapshot', 'list_saved_snapshots',
      'merge_snapshot_changes_plan', 'prune_old_snapshots', 'read_playlist_snapshot',
      'restore_playlist_from_snapshot', 'snapshot_added_at_report', 'snapshot_diff_summary',
      'snapshot_disk_usage', 'snapshot_integrity_check', 'snapshot_integrity_report',
      'snapshot_new_tracks', 'snapshot_registry_report', 'snapshot_removed_tracks',
      'snapshot_retention_plan', 'snapshot_stats_report',
    ],
  },
  {
    module: 'swarm4playlists',
    reason:
      'The fourth-wave playlist family is 14/18 untested, including the clone, dedupe-apply and snapshot-detail operations (epic #575).',
    tools: [
      'playlist_balance', 'playlist_chunk_preview', 'playlist_clone_snapshot',
      'playlist_dedupe_advanced', 'playlist_diff', 'playlist_filter_runtime', 'playlist_flip_order',
      'playlist_history', 'playlist_keep_artist', 'playlist_remove_artist', 'playlist_rotate',
      'playlist_seed_shuffle', 'playlist_snapshot_detail', 'playlist_swap_positions',
    ],
  },
];

/** tool name → the reason it is knowingly untested. */
const UNTESTED_REASON: ReadonlyMap<string, string> = new Map(
  KNOWN_UNTESTED.flatMap((group) => group.tools.map((tool) => [tool, group.reason] as const)),
);

// ---------------------------------------------------------------------------
// The "which names does a test exercise" derivation
// ---------------------------------------------------------------------------

export interface ExerciseScan {
  /** Served names that at least one scanned test file names in code. */
  readonly exercised: ReadonlySet<string>;
  /** Served name → the test files that name it. */
  readonly byName: ReadonlyMap<string, readonly string[]>;
  /** Files whose quotes did not pair up; see the assertion that consumes this. */
  readonly desynced: readonly string[];
}

/**
 * String literals in `source`, as their ORIGINAL text, with comments excluded.
 *
 * `blankNonCode` replaces every comment character and every string BODY with a
 * space while leaving the quote delimiters and all offsets intact, so a quote
 * still standing in the blanked text opens a literal whose contents are read
 * back out of the original. That is what makes the scan comment-blind without
 * needing a parser: a name in a `/** … *\/` header is gone before the scan sees
 * it, and a name in real code is not.
 */
function stringLiterals(source: string, blanked: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < blanked.length; i++) {
    const quote = blanked[i];
    if (quote !== '"' && quote !== "'") continue;
    let j = i + 1;
    while (j < blanked.length && blanked[j] !== quote) j++;
    out.push(source.slice(i + 1, j));
    i = j;
  }
  return out;
}

/**
 * The evidence side of the gate: which served names do the test files name?
 *
 * `files` is exactly the set `npm test` executes (`tests/*.test.ts`) — not every
 * `.ts` under `tests/` — so the evidence set and the executed set cannot drift
 * apart. Helpers such as `live-registry.ts` are excluded on purpose: a name in
 * a helper is not a name a test called.
 */
export function scanExercisedNames(files: readonly string[], served: ReadonlySet<string>): ExerciseScan {
  const byName = new Map<string, string[]>();
  const desynced: string[] = [];
  for (const file of files) {
    if (EXCLUDED_FROM_SCAN.has(file)) continue;
    const source = readFileSync(file, 'utf8');
    const blanked = blankNonCode(source);
    // An unpaired quote means the tokenizer lost its place, and everything
    // after that point was read wrongly. Left unchecked that under-counts
    // silently, which would push real names onto the allow-list for no reason —
    // so it is surfaced as a failure rather than absorbed.
    const quotes = [...blanked].filter((c) => c === '"' || c === "'").length;
    if (quotes % 2 !== 0) desynced.push(file);
    for (const literal of stringLiterals(source, blanked)) {
      if (!served.has(literal)) continue;
      const seen = byName.get(literal);
      if (seen) {
        if (!seen.includes(file)) seen.push(file);
      } else {
        byName.set(literal, [file]);
      }
    }
  }
  return { exercised: new Set(byName.keys()), byName, desynced };
}

/**
 * The gate's decision, as a pure function so a test can drive it directly.
 *
 * Returning the uncovered names (rather than a boolean) is what lets the failure
 * message name the tools, which is the difference between a gate a reviewer can
 * act on and one they have to go hunting with.
 */
export function findUncoveredNames(
  served: Iterable<string>,
  exercised: ReadonlySet<string>,
  allowList: ReadonlyMap<string, string>,
): string[] {
  return [...served].filter((name) => !exercised.has(name) && !allowList.has(name)).sort();
}

// ---------------------------------------------------------------------------
// Shared measurement
// ---------------------------------------------------------------------------

/** `tests/*.test.ts` — the files `npm test` runs. */
function testFiles(): string[] {
  return readdirSync(TESTS_DIR)
    .filter((name) => name.endsWith('.test.ts'))
    .sort()
    .map((name) => join(TESTS_DIR, name));
}

/** Manifest module key → the tool names that module registers. */
async function measureOwnership(): Promise<Map<string, string[]>> {
  const server = new McpServer({ name: 'tool-coverage', version: '0.0.0' });
  const client = new SpotifyClient();
  const context: RegistrarManifestContext = {
    readOnly: false,
    isModuleActive: () => true,
    scopeBlocked: () => false,
  };
  await registerManifestModules(server, client, context);
  return new Map(REGISTRAR_MANIFEST.map((module) => [module.key, [...moduleToolNames(server, module.key)]]));
}

let servedPromise: Promise<string[]> | undefined;
const served = (): Promise<string[]> => (servedPromise ??= wireToolNames());

let scanPromise: Promise<ExerciseScan> | undefined;
const scan = (): Promise<ExerciseScan> => {
  scanPromise ??= (async () => {
    const names = await served();
    return scanExercisedNames(testFiles(), new Set(names));
  })();
  return scanPromise;
};

// ---------------------------------------------------------------------------

describe('#663 — every served tool name is exercised or knowingly allowed', () => {
  it('fails on a served name that no test names and the allow-list does not carry', async (t) => {
    const names = await served();
    const { exercised, byName } = await scan();
    const uncovered = findUncoveredNames(names, exercised, UNTESTED_REASON);

    const tested = names.filter((name) => exercised.has(name));
    const allowListed = names.filter((name) => !exercised.has(name) && UNTESTED_REASON.has(name));

    // The number the issue asked to see on every run. `t.diagnostic` rather
    // than console.log: tests/no-test-debug-output-guard.test.ts holds this
    // tree at zero debug statements, and a print that cannot fail is the thing
    // that guard exists to catch.
    t.diagnostic(
      `tested tool names: ${tested.length}/${names.length} (allow-listed untested: ${allowListed.length})`,
    );

    // The three sets partition the surface. If they do not, the headline number
    // above is describing something other than what the assertion below checks.
    assert.equal(
      tested.length + allowListed.length + uncovered.length,
      names.length,
      'tested + allow-listed + uncovered must account for every served name',
    );

    if (uncovered.length > 0) {
      const detail = uncovered
        .map((name) => {
          const mentions = (byName.get(name) ?? []).length;
          return `  - ${name} (${mentions} test-file mention${mentions === 1 ? '' : 's'})`;
        })
        .join('\n');
      assert.fail(
        `${uncovered.length} served tool name(s) are neither exercised by a test nor listed in KNOWN_UNTESTED:\n`
        + `${detail}\n\n`
        + 'Either add a test that names the tool, or — if it is knowingly untested — add it to the\n'
        + 'KNOWN_UNTESTED group for its manifest module, with a reason. A tool removed from the\n'
        + 'registry takes its allow-list entry with it.',
      );
    }
  });

  it('the allow-list is exactly the uncovered set, so it cannot outlive its reason', async () => {
    // This is the shrink direction the issue asks for: once a name gains a test
    // it must leave the list, or the list becomes a second registrar list that
    // keeps passing for tools nobody looks at any more.
    const names = await served();
    const servedSet = new Set(names);
    const { exercised } = await scan();
    const covered = names.filter((name) => exercised.has(name));

    const stale = covered.filter((name) => UNTESTED_REASON.has(name));
    assert.deepEqual(
      stale, [],
      `these names now have a test but are still listed as untested — delete the KNOWN_UNTESTED entry:\n`
      + stale.map((name) => `  - ${name}`).join('\n'),
    );

    const unserved = [...UNTESTED_REASON.keys()].filter((name) => !servedSet.has(name));
    assert.deepEqual(
      unserved, [],
      'KNOWN_UNTESTED names the registry no longer serves — delete the entry:\n'
      + unserved.map((name) => `  - ${name}`).join('\n'),
    );
  });

  it('every allow-list entry carries a reason, and no name is listed twice', () => {
    for (const [name, reason] of UNTESTED_REASON) {
      assert.ok(reason.trim().length > 0, `KNOWN_UNTESTED entry "${name}" has no reason`);
    }
    const grouped = KNOWN_UNTESTED.flatMap((group) => group.tools);
    const duplicates = grouped.filter((name, i) => grouped.indexOf(name) !== i);
    assert.deepEqual(duplicates, [], `a name appears in more than one KNOWN_UNTESTED group: ${duplicates.join(', ')}`);
    for (const group of KNOWN_UNTESTED) {
      const sorted = [...group.tools].sort();
      assert.deepEqual(group.tools, sorted, `KNOWN_UNTESTED group "${group.module}" is not sorted, so its diffs will be noisy`);
    }
  });

  it('every allow-listed name belongs to the manifest module it is grouped under', async () => {
    // Without this the grouping could rot into fiction: a tool renamed or moved
    // between modules would keep passing while the reason beside it described a
    // module it no longer lives in.
    const ownership = await measureOwnership();
    const owner = new Map<string, string>();
    for (const [key, names] of ownership) for (const name of names) owner.set(name, key);

    const misplaced: string[] = [];
    const unknownModule: string[] = [];
    for (const group of KNOWN_UNTESTED) {
      if (!ownership.has(group.module)) {
        unknownModule.push(group.module);
        continue;
      }
      for (const name of group.tools) {
        const actual = owner.get(name);
        if (actual !== group.module) {
          misplaced.push(`${name} is grouped under "${group.module}" but the manifest registers it under "${actual ?? '(no module)'}"`);
        }
      }
    }
    assert.deepEqual(unknownModule, [], `KNOWN_UNTESTED names modules that are not in REGISTRAR_MANIFEST: ${unknownModule.join(', ')}`);
    assert.deepEqual(misplaced, [], `KNOWN_UNTESTED is grouped against the wrong manifest module:\n  ${misplaced.join('\n  ')}`);
  });
});

describe('#663 — the coverage measurement is not vacuous', () => {
  // Everything above turns on `scanExercisedNames` returning a real answer. A
  // scan that returned nothing would make every served name uncovered, which the
  // allow-list would then have to cover — so the failure would be reported as a
  // coverage problem rather than as a broken gate. These assertions are what
  // catch that.
  it('the scan reads every file npm test executes, and reads them non-trivially', async () => {
    const files = testFiles();
    assert.ok(files.length > 50, `expected the full test suite, found ${files.length} test files — the glob no longer matches tests/*.test.ts`);
    for (const file of files) assert.ok(file.endsWith('.test.ts'), `${file} is not a *.test.ts file`);

    // The self-exclusion is the whole reason the number below is believable.
    assert.ok(
      EXCLUDED_FROM_SCAN.has(SELF) && files.includes(SELF),
      'this file must both be excluded from the scan and still be part of the suite it scans',
    );
    const scanned = files.filter((file) => !EXCLUDED_FROM_SCAN.has(file));
    assert.equal(scanned.length, files.length - 1, 'exactly one file is excluded — the gate itself. A second would be a hidden hole.');

    const names = await served();
    const { exercised } = await scan();
    const ratio = exercised.size / names.length;
    assert.ok(
      exercised.size > names.length / 2,
      `only ${exercised.size} of ${names.length} served names appear in any test file — the scan is looking at the wrong thing`,
    );
    assert.ok(ratio < 1, `${exercised.size}/${names.length} are covered; a scan claiming total coverage means the allow-list is doing nothing`);
  });

  it('the allow-list does not make the gate look covered on its own', () => {
    // Driven directly: scanning a file that holds the allow-list must not report
    // the allow-listed names as exercised. Reading this file into the scan turns
    // every known gap into a "covered" name and the gate stops meaning anything.
    const allowListed = KNOWN_UNTESTED.flatMap((group) => group.tools);
    assert.ok(allowListed.length > 0, 'KNOWN_UNTESTED is empty, so this proves nothing');
    const result = scanExercisedNames([SELF], new Set(allowListed));
    assert.deepEqual(
      [...result.exercised], [],
      'scanning the file that holds KNOWN_UNTESTED reported its names as exercised — the allow-list is answering the gate',
    );
  });

  it('no scanned test file left the tokenizer unpaired', async () => {
    // A desynced file is one the lexer misread end-to-end, so every name after
    // the break was under-counted — and the symptom would be a name landing on
    // the allow-list for a reason that is not true. Fail loudly instead.
    const { desynced } = await scan();
    assert.deepEqual(
      desynced, [],
      'these test files have an unpaired quote after blankNonCode, so the coverage scan misread them:\n'
      + desynced.map((file) => `  - ${file.replace(`${REPO_ROOT}/`, '')}`).join('\n'),
    );
  });

  it('a name no test mentions and no allow-list carries is reported, by name', () => {
    // The decision function on its own, driven with a synthetic served name —
    // `live-registry.ts`'s `extra` seam exists for the same reason: a gate that
    // can only be exercised by editing the registry is a gate nobody verifies.
    const uncovered = findUncoveredNames(
      ['already_tested', 'never_mentioned_anywhere'],
      new Set(['already_tested']),
      new Map(),
    );
    assert.deepEqual(uncovered, ['never_mentioned_anywhere']);
  });

  it('a served name the registry grew is caught, and the allow-list cannot absorb it by accident', () => {
    // The shape issue acceptance criterion #2 asks for: a new tool with no test
    // has to fail and be named. Proven here against the decision function,
    // and end-to-end by the mutation recorded in the PR body.
    const servedNames = ['covered_tool', 'brand_new_tool'];
    const allowList = new Map([['known_gap', 'a reason']]);
    assert.deepEqual(findUncoveredNames(servedNames, new Set(['covered_tool']), allowList), ['brand_new_tool']);
    assert.deepEqual(findUncoveredNames(servedNames, new Set(['covered_tool']), allowList), ['brand_new_tool']);
  });

  it('the exercised scan ignores a name that only appears in a comment', () => {
    // The direction that made the original measurement wrong: prose about a tool
    // is not a test of it. Driven through the real scanner, not a mock.
    const servedSet = new Set(['commented_only', 'really_called']);
    const commented = [
      '// tests/tools/thing.test.ts covers commented_only end to end',
      '/* and commented_only again in a block comment */',
      "const out = await invoke('really_called', {});",
    ].join('\n');
    const blanked = blankNonCode(commented);
    const literals = stringLiterals(commented, blanked);
    assert.ok(literals.includes('really_called'), 'a real call site must be read');
    assert.ok(!literals.includes('commented_only'), 'a comment must not be read as a call site');
    assert.ok(literals.every((literal) => servedSet.has(literal) || literal.length > 0));
  });
});

