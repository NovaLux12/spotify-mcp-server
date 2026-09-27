/**
 * #643 — the live gauntlet's classification and its mutation proof.
 *
 * `scripts/live-gauntlet.mjs` is the harness behind the sweep report a v2
 * reviewer cites. Its safety claim has to be falsifiable, and it was not:
 *
 *   - SAFE vs MUTATING came from a 22-name hand-kept literal whose fallback
 *     branch was SAFE, while the file's own safety comment claimed unclassified
 *     tools were MUTATING. Most of the registered surface was therefore
 *     classified against the registry's own opinion, and every disagreement
 *     was in the unsafe direction.
 *   - "no mutation happened" was decided by a regex over the tool's own prose
 *     and then printed as a constant, so a clean run and a mutating run produced
 *     the same report.
 *   - A mutating tool that was declared but never actually invoked was
 *     indistinguishable from one that was exercised.
 *
 * This file pins all three, and — the part that matters more than the pins — it
 * proves each pin CAN go red:
 *
 *   1. the classifier is run over the REAL registry (built through the shared
 *      manifest pass in tests/live-registry.ts, annotated by the same
 *      `applyToolAnnotations` the server runs) and every number is derived;
 *   2. the classification is shown to disagree with the hand-kept table that
 *      used to answer it, on real registered tools, and a synthetic tool is
 *      shown to be classified without editing the script;
 *   3. every guarantee is re-run against deliberately mutated copies of the
 *      decision module. Each mutation ANCHORS on a literal that must be
 *      present in the source — a mutation that silently fails to apply aborts
 *      the run, because a mutation script that quietly does nothing looks
 *      exactly like a passing test;
 *   4. the proof is driven end-to-end through the REAL `live-gauntlet.mjs`,
 *      copied into a sandbox beside a stub MCP server with an in-memory
 *      account, so "it goes red" is observed rather than argued.
 *
 * No Spotify traffic and no live credentials: the end-to-end leg runs the real
 * script against a stub, and everything else is in-process. Nothing here binds
 * a port, and every file written is under os.tmpdir().
 */

import './helpers/hermetic.js';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { applyToolAnnotations } from '../src/tools/annotations.js';
import { finalInputSchema } from '../src/shaping.js';
import { buildFullRegistryServer } from './live-registry.js';

import * as realCore from '../scripts/live-gauntlet-core.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CORE_PATH = join(ROOT, 'scripts', 'live-gauntlet-core.mjs');
const GAUNTLET_PATH = join(ROOT, 'scripts', 'live-gauntlet.mjs');

// ---------------------------------------------------------------- core typing

/**
 * A structural view of `scripts/live-gauntlet-core.mjs`.
 *
 * Written out rather than `typeof import(...)` because the mutation leg loads
 * MUTATED copies of that module from a temp directory: the assertions below
 * have to be able to run against either one, and an explicit shape keeps both
 * on the same contract.
 */
interface Verdict {
  tool: string;
  class: string;
  reason: string;
  source: string;
  serverSaysRead: boolean;
  declaresDryRun: boolean;
}

interface AuditResult {
  total: number;
  mutating: number;
  safe: number;
  dryRunDeclared: number;
  reviewedReads: string[];
  reviewedReadCount: number;
  unannotatedCount: number;
  dryRunDeclaredButSafe: string[];
  unreviewedDryRunReads: string[];
  reviewedButNotReadOnly: string[];
  reviewedNotRegistered: string[];
  writeClassifiedSafe: string[];
  verdicts: Map<string, Verdict>;
  errors: string[];
  warnings: string[];
}

interface Proof {
  status: string;
  state_check: string;
  calls_made: number;
  mutations_detected: number;
  mutations_known: boolean;
  mutations_performed: Array<{ field: string; before: unknown; after: unknown; attributable_to: string | null }>;
  dry_run_verified: string[];
  unverified: Array<{ tool: string; reason: string }>;
  unaccounted: Array<{ tool: string; status: string; reason: string }>;
  pending: string[];
  fingerprint: { compared_fields: number; unreadable_fields: string[]; before: unknown; after: unknown };
}

interface CoreModule {
  readonly REVIEWED_READS: Map<string, string>;
  readonly MUTATING: string;
  readonly SAFE: string;
  readonly GATE_SKIP_PREFIXES: readonly string[];
  readonly ACCOUNT_PROBES: ReadonlyArray<{ field: string; tool: string; measure: string; args: unknown }>;
  classifyTool(tool: unknown, options?: unknown): Verdict;
  classifyRegistry(tools: readonly unknown[], options?: unknown): Map<string, Verdict>;
  auditClassification(tools: readonly unknown[], options?: unknown): AuditResult;
  auditRecipeTables(tools: readonly unknown[], verdicts: Map<string, Verdict>, tables: unknown): { orphans: string[]; unreachable: string[] };
  schemaDeclaresDryRun(schema: unknown): boolean;
  declaresDryRun(tool: unknown): boolean;
  confirmsDryRun(invocation: unknown): boolean;
  isGateSkip(reason: unknown): boolean;
  snapshotFromProbeResponses(responses: readonly unknown[]): { fields: Record<string, unknown>; unreadable: Record<string, string> };
  diffFingerprints(before: unknown, after: unknown): { changed: unknown[]; unreadable: string[]; compared: number };
  computeMutationProof(input: unknown): Proof;
  proofBlocksExit(proof: unknown): boolean;
  renderProofLines(proof: unknown): string[];
  renderAuditLines(audit: unknown): string[];
}

const core: CoreModule = realCore as unknown as CoreModule;

// ------------------------------------------------------------ the real registry

/**
 * The real `tools/list` rows, from the registry the server actually builds.
 *
 * Built in-process through the shared manifest pass (`tests/live-registry.ts`),
 * annotated by `applyToolAnnotations` — the same function `src/index.ts` calls
 * at startup — and projected through `finalInputSchema`, the same shaping the
 * boundary installs. So these rows carry the same `annotations` and the same
 * `inputSchema.properties` a host receives, and no name in them is written by
 * hand.
 */
async function liveRegistryRows(extra?: (server: McpServer) => void): Promise<Array<Record<string, unknown>>> {
  const server = await buildFullRegistryServer(extra ? { extra } : {});
  applyToolAnnotations(server);
  const registry = (server as unknown as {
    _registeredTools?: Record<string, { inputSchema?: unknown; annotations?: unknown }>;
  })._registeredTools ?? {};
  return Object.entries(registry).map(([name, entry]) => ({
    name,
    inputSchema: finalInputSchema(entry.inputSchema),
    annotations: entry.annotations as Record<string, unknown> | undefined,
  }));
}

let LIVE_ROWS: Array<Record<string, unknown>> = [];
let LIVE_AUDIT: AuditResult;

/**
 * Every sandbox this file makes, so they can be removed when it finishes.
 *
 * All of them are `mkdtemp` directories under `os.tmpdir()` and nothing else
 * is ever written: no file under the repository, and nothing anywhere near a
 * real `~/.spotify-mcp/`. The end-to-end leg additionally points `HOME` at its
 * own sandbox, so even a server that reached for the user's token file would
 * find an empty one.
 */
const SANDBOXES: string[] = [];

function sandbox(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  SANDBOXES.push(dir);
  return dir;
}

before(async () => {
  LIVE_ROWS = await liveRegistryRows();
  LIVE_AUDIT = core.auditClassification(LIVE_ROWS);
});

after(() => {
  for (const dir of SANDBOXES) rmSync(dir, { recursive: true, force: true });
});

// The `MUTATING` literal `live-gauntlet.mjs` carried before #643, transcribed
// verbatim from `git show origin/main:scripts/live-gauntlet.mjs` (lines 35-50)
// and kept here as the counterexample rather than left in the script. Every
// name the old table did not mention was classified SAFE; the two blocks below
// reproduce that ternary's behaviour against the same registry, so the
// disagreement is measured rather than asserted.
const LEGACY_MUTATING = new Set<string>([
  'save_to_library', 'remove_from_library',
  'play_from_search', 'play', 'pause', 'skip_next', 'skip_previous', 'seek',
  'set_volume', 'set_shuffle', 'set_repeat', 'add_to_queue', 'transfer_playback',
  'upload_playlist_cover', 'create_playlist', 'add_to_playlist',
  'remove_from_playlist', 'update_playlist', 'reorder_playlist_items',
  'replace_playlist_items',
  'merge_playlists',
  'whats_new',
]);

// -------------------------------------------------------------- scenarios

/** Registry-row builders, so a scenario reads as the shape it is about. */
function readTool(name: string, properties: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    inputSchema: { type: 'object', properties, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true },
  };
}

function writeTool(name: string, properties: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    inputSchema: { type: 'object', properties, additionalProperties: false },
    annotations: { destructiveHint: false },
  };
}

const DRY_RUN = { dry_run: { type: 'boolean' } } as Record<string, unknown>;

/** Fingerprint responses for a given account state, as the probes would read it. */
function probeResponses(m: CoreModule, state: { tracks: number; albums: number; playlists: string[] }) {
  return m.ACCOUNT_PROBES.map((probe) => {
    switch (probe.field) {
      case 'saved_tracks_total': return { probe, ok: true, structured: { items: [], pagination: { total: state.tracks } } };
      case 'saved_albums_total': return { probe, ok: true, structured: { items: [], pagination: { total: state.albums } } };
      case 'playlists_total': return { probe, ok: true, structured: { items: [], pagination: { total: state.playlists.length } } };
      default: return { probe, ok: true, structured: { items: state.playlists.map((id) => ({ id })) } };
    }
  });
}

/** A snapshot of a named account state, through the module under test. */
function fingerprintOf(m: CoreModule, state: { tracks: number; albums: number; playlists: string[] }) {
  return m.snapshotFromProbeResponses(probeResponses(m, state));
}

const CLEAN_STATE = { tracks: 100, albums: 12, playlists: ['pl1', 'pl2'] };

/** A dry-run invocation whose response confirms it structurally. */
function confirmedInvocation(tool: string): Record<string, unknown> {
  return { tool, dry_run: true, ok: true, structured: { dry_run: true, would_add: 1 }, text: '[dry run] would add 1' };
}

/** A mutating tool that skipped because the harness declined to call it. */
function gateSkipRecord(tool: string): Record<string, unknown> {
  return { tool, class: core.MUTATING, status: 'SKIP', reason: 'mutating; not in --include-mutating allowlist' };
}

/**
 * One complete run's worth of fixture: a two-tool registry (a read, a write),
 * a fingerprint pair, and the records and invocations a full sweep would hold.
 * Scenarios vary one of those four and assert on the proof.
 */
function scenario(m: CoreModule, overrides: {
  rows?: Array<Record<string, unknown>>;
  before?: { tracks: number; albums: number; playlists: string[] };
  after?: { tracks: number; albums: number; playlists: string[] };
  records?: Array<Record<string, unknown>>;
  invocations?: Array<Record<string, unknown>>;
  callsMade?: number;
  noStateCheck?: boolean;
} = {}) {
  const rows = overrides.rows ?? [readTool('get_track'), writeTool('add_to_playlist', DRY_RUN)];
  const classification = m.classifyRegistry(rows);
  return m.computeMutationProof({
    classification,
    records: overrides.records ?? [gateSkipRecord('add_to_playlist')],
    invocations: overrides.invocations ?? [],
    callsMade: overrides.callsMade ?? 0,
    before: overrides.noStateCheck ? undefined : fingerprintOf(m, overrides.before ?? CLEAN_STATE),
    after: overrides.noStateCheck ? undefined : fingerprintOf(m, overrides.after ?? CLEAN_STATE),
  });
}

// =====================================================================
// 1. The classification, over the REAL registry
// =====================================================================

describe('live-gauntlet classification, derived from the real registry', () => {
  it('classifies every registered tool, and the audit is internally consistent', () => {
    // Every number here is DERIVED from the registry the server builds. None is
    // typed: `LIVE_AUDIT` counts the same rows the server would publish, so a
    // tool added or removed upstream moves these figures with it.
    assert.equal(LIVE_AUDIT.total, LIVE_ROWS.length);
    assert.equal(LIVE_AUDIT.mutating + LIVE_AUDIT.safe, LIVE_AUDIT.total);
    assert.equal(LIVE_AUDIT.errors.length, 0, LIVE_AUDIT.errors.join('\n'));
    assert.equal(LIVE_AUDIT.unreviewedDryRunReads.length, 0, LIVE_AUDIT.unreviewedDryRunReads.join('\n'));
    assert.equal(LIVE_AUDIT.writeClassifiedSafe.length, 0, LIVE_AUDIT.writeClassifiedSafe.join('\n'));
    assert.equal(LIVE_AUDIT.reviewedButNotReadOnly.length, 0, LIVE_AUDIT.reviewedButNotReadOnly.join('\n'));
    // The surface this harness classifies is not a handful of tools. If the
    // registry ever shrank to the point where the distinction did not matter,
    // that is a change to notice, not a number to re-baseline quietly.
    assert.ok(LIVE_AUDIT.mutating > 0 && LIVE_AUDIT.safe > 0);
    assert.ok(LIVE_AUDIT.dryRunDeclared > 0);
  });

  it('accepts criterion 1 of the issue: no tool declares dry_run and is SAFE without a REVIEWED_READS entry', () => {
    // This is the acceptance criterion stated as an assertion. Every tool that
    // declares a commit path and lands on the SAFE path must be named, and the
    // audit names them.
    for (const name of LIVE_AUDIT.dryRunDeclaredButSafe) {
      assert.ok(
        LIVE_AUDIT.reviewedReads.includes(name),
        `${name} declares dry_run and is SAFE without a REVIEWED_READS entry`,
      );
    }
    assert.deepEqual(
      [...LIVE_AUDIT.dryRunDeclaredButSafe].sort(),
      [...LIVE_AUDIT.reviewedReads].sort(),
      'every dry_run-declaring SAFE tool is a reviewed read, and every reviewed read declares dry_run',
    );
  });

  it('agrees with the registry on every tool, in the direction that is safe to be wrong in', () => {
    // SAFE must imply "the registry calls it a read". The converse is allowed
    // and is the fail-closed direction: a tool the registry calls a write is
    // MUTATING here even when it declares no dry_run, so it is skipped by
    // default rather than called on the read path.
    const registryWrites = LIVE_ROWS.filter((t) => (t.annotations as Record<string, unknown> | undefined)?.readOnlyHint !== true);
    for (const row of registryWrites) {
      const name = row.name as string;
      assert.equal(LIVE_AUDIT.verdicts.get(name)?.class, 'MUTATING', `${name} is a registry write and must be MUTATING`);
    }
    for (const row of LIVE_ROWS) {
      const name = row.name as string;
      if (LIVE_AUDIT.verdicts.get(name)?.class !== 'SAFE') continue;
      assert.equal(
        (row.annotations as Record<string, unknown> | undefined)?.readOnlyHint,
        true,
        `${name} is SAFE but the registry does not advertise readOnlyHint`,
      );
    }
  });

  it('keeps REVIEWED_READS a narrow, checked escape hatch rather than a second table', () => {
    for (const [name, evidence] of core.REVIEWED_READS) {
      const row = LIVE_ROWS.find((t) => t.name === name);
      assert.ok(row, `${name} is in REVIEWED_READS but no registered tool answers to it`);
      assert.equal((row.annotations as Record<string, unknown>).readOnlyHint, true, `${name} is not a registry read`);
      assert.ok(core.schemaDeclaresDryRun(row.inputSchema), `${name} does not declare dry_run, so it needs no exception`);
      assert.ok(evidence.length > 40, `${name} carries no per-entry evidence`);
    }
    // The hazard this list creates is bounded on purpose: it is the only way a
    // dry_run-declaring tool reaches the read path, so it must not grow into
    // the hand-maintained MUTATING table with the sign flipped.
    assert.ok(
      core.REVIEWED_READS.size <= 10,
      `REVIEWED_READS has ${core.REVIEWED_READS.size} entries; the escape hatch is meant to stay small`,
    );
  });

  it('fails the audit when a REVIEWED_READS entry points at a tool the registry calls a write', () => {
    const audited = core.auditClassification([writeTool('backup_library', DRY_RUN)]);
    // Two independent invariants fire here and both are wanted: the entry is
    // stale, and the tool reached the SAFE path while the registry calls it a
    // write. Either one alone is a reason to refuse the run.
    assert.ok(
      audited.errors.includes('backup_library: REVIEWED_READS entry, but the registry no longer advertises it as read-only'),
      audited.errors.join('\n'),
    );
    assert.ok(
      audited.errors.includes('backup_library: registry advertises a write but it is classified SAFE'),
      audited.errors.join('\n'),
    );
  });

  it('records what failing closed costs: registry writes with no dry_run the gauntlet can never call', () => {
    // The honest price of the fix, pinned so it cannot be forgotten. These
    // five sit on the MUTATING path (the registry advertises no readOnlyHint)
    // and declare no `dry_run`, so the gate skips them permanently and the
    // sweep loses the read-path coverage it had before #643. Every one is a
    // read or a LOCAL sidecar write; the fix belongs in the OVERRIDES table in
    // src/tools/annotations.ts, which is outside this harness's territory, so
    // the gap is asserted here rather than papered over.
    const uncallable = LIVE_ROWS
      .filter((row) => LIVE_AUDIT.verdicts.get(row.name as string)?.class === 'MUTATING')
      .filter((row) => !core.schemaDeclaresDryRun(row.inputSchema))
      .map((row) => row.name as string)
      .sort();
    const KNOWN = [
      'cancel_wind_down', 'delete_scene', 'filter_by_genre', 'library_genre_report', 'save_scene',
    ];
    for (const name of KNOWN) {
      assert.ok(uncallable.includes(name), `${name} is no longer a registry write without dry_run — the coverage note in live-gauntlet.mjs needs updating`);
    }
    // The list is not closed: other registry writes without dry_run exist and
    // are gated for the same reason. What matters is that the named set is
    // still a subset, so the note under-reports rather than over-reports.
    assert.ok(uncallable.length >= KNOWN.length);
  });
});

// =====================================================================
// 2. The classification CAN disagree with what it used to answer to
// =====================================================================

describe('the classification is not the hand-kept table it replaced', () => {
  it('disagrees with the pre-fix literal on real registered tools, all of them in the unsafe direction', () => {
    const rows = LIVE_ROWS.map((r) => r.name as string);
    const disagreements = rows.filter((name) => {
      const legacy = LEGACY_MUTATING.has(name) ? 'MUTATING' : 'SAFE';
      return legacy !== LIVE_AUDIT.verdicts.get(name)?.class;
    });
    // The old literal named 22 tools; the registry disagrees with it on far
    // more than that, and never in the direction that would have been safe.
    assert.ok(disagreements.length > 100, `only ${disagreements.length} disagreements — the registry has probably changed shape`);
    const unsafeDirection = disagreements.filter((n) => !LEGACY_MUTATING.has(n));
    assert.equal(unsafeDirection.length, disagreements.length, 'every disagreement was SAFE under the old literal');
    for (const name of unsafeDirection) {
      assert.equal(
        LIVE_AUDIT.verdicts.get(name)?.class,
        'MUTATING',
        `${name} was SAFE under the old literal and must be MUTATING now`,
      );
    }
  });

  it('covers, with a dry-run guard, writes the old read path called without one', () => {
    // These four still carried SAFE_ARGS recipes in the pre-fix script and were
    // called on the read path with no dry_run. That is the accident the safety
    // model was written to prevent, and it is reachable through a real
    // registered tool rather than a synthetic one.
    for (const name of ['grow_playlist', 'overlap_playlists', 'tag_management', 'start_podcast_session']) {
      const row = LIVE_ROWS.find((t) => t.name === name);
      assert.ok(row, `${name} is expected to still be registered`);
      assert.equal(LIVE_AUDIT.verdicts.get(name)?.class, 'MUTATING');
      assert.ok(core.schemaDeclaresDryRun(row.inputSchema), `${name} is expected to declare dry_run`);
    }
  });

  it('closes the nine tools the A12-005 audit named as reachable on the SAFE path', () => {
    // The issue's own verification note listed exactly these nine as
    // dry_run-declaring tools that fell outside the MUTATING set AND had a
    // SAFE_ARGS recipe. Each is now either MUTATING — the registry gate
    // applies, and the allowlist plus a schema-declared dry_run are both
    // required before a call — or a REVIEWED_READ carrying its evidence, which
    // is the one documented way a commit-capable tool reaches the read path.
    const AUDITED: Record<string, 'MUTATING' | 'SAFE'> = {
      merge_playlists: 'MUTATING',
      diff_playlists: 'SAFE',        // REVIEWED_READS: never mutates, dry_run changes nothing
      overlap_playlists: 'MUTATING',
      grow_playlist: 'MUTATING',
      tag_management: 'MUTATING',
      whats_new: 'MUTATING',
      start_podcast_session: 'MUTATING',
      jump_to_chapter: 'MUTATING',
      apply_scene: 'MUTATING',
    };
    for (const [name, expected] of Object.entries(AUDITED)) {
      const row = LIVE_ROWS.find((t) => t.name === name);
      assert.ok(row, `${name} is expected to still be registered`);
      assert.ok(core.schemaDeclaresDryRun(row.inputSchema), `${name} is expected to declare dry_run`);
      assert.equal(LIVE_AUDIT.verdicts.get(name)?.class, expected, `${name} moved class`);
      if (expected === 'SAFE') {
        assert.ok(
          core.REVIEWED_READS.has(name),
          `${name} is SAFE and declares dry_run, so it needs a REVIEWED_READS entry with evidence`,
        );
      } else {
        // A MUTATING tool is only ever called under the dry-run gate, so the
        // gate condition has to actually hold for it.
        assert.equal(core.isGateSkip('mutating; not in --include-mutating allowlist'), true);
      }
    }
  });

  it('classifies tools planted into the real registry, with the script untouched (acceptance criterion 2)', async () => {
    // The seam `tests/live-registry.ts` documents for exactly this. Two tools
    // are registered into a real full-scope registry — one the naming policy
    // reads as a write, one as a read — and the classification is derived over
    // all of them. Neither name appears in the pre-fix literal, so the old
    // table called both SAFE.
    const planted = await liveRegistryRows((server) => {
      const handler = async () => ({ content: [], structuredContent: { dry_run: true } });
      server.registerTool('refresh_watchlist', {
        description: 'Refresh the saved watchlist.',
        inputSchema: { dry_run: z.boolean().optional() },
      }, handler);
      server.registerTool('get_watchlist_refresh', {
        description: 'Preview a watchlist refresh.',
        inputSchema: { dry_run: z.boolean().optional() },
      }, handler);
    });
    assert.ok(planted.some((r) => r.name === 'refresh_watchlist'), 'the planted tool is in the derived rows');
    const audited = core.auditClassification(planted);
    assert.equal(audited.errors.length, 0, audited.errors.join('\n'));

    // No mutating verb in the name: the registry's own policy calls it a write
    // and so does the harness, with no table entry to consult.
    const writeVerdict = audited.verdicts.get('refresh_watchlist');
    assert.equal(writeVerdict?.class, 'MUTATING');
    assert.equal(writeVerdict?.declaresDryRun, true);
    assert.equal(LEGACY_MUTATING.has('refresh_watchlist'), false);

    // A READ-prefixed name that nonetheless declares a commit path. Here the
    // registry says "read" and the schema says "you can commit": the two
    // disagree, and the schema has to win. Under the old table this was SAFE
    // and would have been called with no dry_run at all.
    const readVerdict = audited.verdicts.get('get_watchlist_refresh');
    assert.equal(readVerdict?.serverSaysRead, true, 'the registry naming policy reads this name as a read');
    assert.equal(readVerdict?.class, 'MUTATING', 'a declared commit path outranks a read-looking name');
    assert.equal(readVerdict?.source, 'dry_run_capability');
    assert.equal(LEGACY_MUTATING.has('get_watchlist_refresh'), false);
  });

  it('keeps a dry_run-declaring read off the SAFE path unless it is reviewed', () => {
    // A read that declares dry_run and is not reviewed is a commit path the
    // harness would call unguarded. It has to be MUTATING, and the audit is
    // what enforces that rather than the reader's care.
    const audited = core.auditClassification([readTool('get_watchlist_refresh', DRY_RUN)]);
    assert.equal(audited.verdicts.get('get_watchlist_refresh')?.class, 'MUTATING');
    assert.equal(audited.reviewedReads.includes('get_watchlist_refresh'), false);
    // Adding it to the reviewed list without evidence is what the audit is for.
    const reviewed = core.auditClassification([readTool('get_watchlist_refresh', DRY_RUN)], {
      reviewedReads: new Map([['get_watchlist_refresh', 'a handler comment']]),
    });
    assert.equal(reviewed.verdicts.get('get_watchlist_refresh')?.class, 'SAFE');
    assert.equal(reviewed.dryRunDeclaredButSafe.includes('get_watchlist_refresh'), true);
  });

  it('treats an unregistered name as MUTATING, which is the branch #643 got backwards', () => {
    // The pre-fix ternary read `MUTATING.has(tool) ? 'MUTATING' : 'SAFE'` with a
    // trailing comment claiming the opposite. Anything the table did not name
    // was therefore SAFE, and the safety model it documented was unreachable.
    const verdict = core.classifyTool({ name: 'a_tool_nobody_has_classified_yet', inputSchema: { properties: {} } });
    assert.equal(verdict.class, 'MUTATING');
    assert.equal(verdict.serverSaysRead, false);
  });
});

// =====================================================================
// 3. The proof goes red
// =====================================================================

describe('the mutation proof', () => {
  it('is PASS only on a clean, fully-covered run with a readable unchanged state', () => {
    const proof = scenario(core);
    assert.equal(proof.status, 'PASS');
    assert.equal(proof.mutations_detected, 0);
    assert.equal(proof.mutations_known, true);
    assert.equal(proof.unverified.length, 0);
    assert.equal(proof.unaccounted.length, 0);
    assert.equal(core.proofBlocksExit(proof), false);
  });

  it('reports the mutation when the account state actually changed', () => {
    const proof = scenario(core, {
      after: { ...CLEAN_STATE, tracks: 101 },
      invocations: [confirmedInvocation('add_to_playlist')],
      records: [{ tool: 'add_to_playlist', class: 'MUTATING', status: 'PASS', verified_no_mutation: true }],
    });
    assert.equal(proof.status, 'MUTATIONS_DETECTED');
    assert.equal(proof.mutations_detected, 1);
    assert.equal(proof.mutations_performed[0].field, 'saved_tracks_total');
    assert.equal(proof.mutations_performed[0].before, 100);
    assert.equal(proof.mutations_performed[0].after, 101);
    assert.equal(core.proofBlocksExit(proof), true);
  });

  it('derives the mutation count instead of asserting it', () => {
    // Four fields move — the two playlist probes both see the new playlist —
    // and the number follows the diff rather than a literal.
    const proof = scenario(core, {
      before: CLEAN_STATE,
      after: { tracks: 101, albums: 13, playlists: ['pl1', 'pl2', 'pl3'] },
    });
    assert.equal(proof.mutations_detected, 4);
    assert.equal(proof.mutations_performed.length, 4);
    assert.deepEqual(
      proof.mutations_performed.map((m) => m.field).sort(),
      ['playlist_ids_hash', 'playlists_total', 'saved_albums_total', 'saved_tracks_total'],
    );
  });

  it('is UNVERIFIED when a mutating tool is declared but never actually invoked', () => {
    // The non-vacuity case. An allowlisted write the harness declined to call
    // (no arg recipe) leaves the proof open, and the run is red rather than
    // reporting a mutation count it never earned.
    const proof = scenario(core, {
      records: [{ tool: 'add_to_playlist', class: 'MUTATING', status: 'SKIP', reason: 'needs a saved playlist; no arg recipe' }],
      callsMade: 0,
    });
    assert.equal(proof.status, 'UNVERIFIED');
    assert.equal(proof.unaccounted.length, 1);
    assert.equal(proof.unaccounted[0].tool, 'add_to_playlist');
    assert.equal(core.proofBlocksExit(proof), true);
  });

  it('is UNVERIFIED when a mutating tool is invoked without dry_run, even if the state is unchanged', () => {
    // An unchanged fingerprint does not clear a call that was allowed to write.
    const proof = scenario(core, {
      invocations: [{ tool: 'add_to_playlist', dry_run: false, ok: true, structured: { ok: true }, text: 'added 1 track' }],
    });
    assert.equal(proof.status, 'UNVERIFIED');
    assert.equal(proof.unverified[0].tool, 'add_to_playlist');
    assert.equal(core.proofBlocksExit(proof), true);
  });

  it('does not accept a prose "[dry run]" as confirmation (the #643 sniff, removed)', () => {
    const proseOnly = { tool: 'add_to_playlist', dry_run: true, ok: true, structured: { would_add: 1 }, text: '[dry run] would add 1 track' };
    assert.equal(core.confirmsDryRun(proseOnly), false);
    const proof = scenario(core, {
      invocations: [proseOnly],
      records: [{ tool: 'add_to_playlist', class: 'MUTATING', status: 'FAIL', reason: 'dry_run confirmation MISSING in response' }],
    });
    assert.equal(proof.status, 'UNVERIFIED');
    assert.equal(proof.unverified.length, 1);
  });

  it('accepts a structured dry_run confirmation and records it as verified', () => {
    const proof = scenario(core, {
      invocations: [confirmedInvocation('add_to_playlist')],
      records: [{ tool: 'add_to_playlist', class: 'MUTATING', status: 'PASS', verified_no_mutation: true }],
    });
    assert.deepEqual(proof.dry_run_verified, ['add_to_playlist']);
    assert.equal(proof.status, 'PASS');
  });

  it('is UNVERIFIED when a fingerprint field could not be read, rather than assuming it did not change', () => {
    const before = core.snapshotFromProbeResponses(probeResponses(core, CLEAN_STATE));
    const after = core.snapshotFromProbeResponses([
      ...probeResponses(core, CLEAN_STATE).slice(0, 2),
      { probe: core.ACCOUNT_PROBES[2], ok: false, error: 'quota wall' },
      { probe: core.ACCOUNT_PROBES[3], ok: true, structured: { items: [] } },
    ]);
    const proof = core.computeMutationProof({
      classification: core.classifyRegistry([readTool('get_track'), writeTool('add_to_playlist', DRY_RUN)]),
      records: [gateSkipRecord('add_to_playlist')],
      invocations: [],
      callsMade: 1,
      before,
      after,
    });
    // The unreadable probe is not defaulted to 0 — that would be the "0
    // streams" bug (#803) in a new coat, agreeing with itself.
    assert.ok(after.unreadable.playlists_total, 'the failed probe is recorded as unreadable');
    assert.equal('playlists_total' in after.fields, false);
    assert.equal(proof.status, 'UNVERIFIED');
    assert.equal(core.proofBlocksExit(proof), true);
  });

  it('is INCOMPLETE — not PASS — while the sweep has not reached every tool', () => {
    const proof = scenario(core, { records: [] });
    assert.equal(proof.status, 'INCOMPLETE');
    assert.deepEqual(proof.pending, ['add_to_playlist']);
    // A batched sweep is INCOMPLETE by construction and must not fail a run.
    assert.equal(core.proofBlocksExit(proof), false);
    // But it must not be PASS either: a claim is only ever PASS.
    assert.notEqual(proof.status, 'PASS');
  });

  it('never claims a mutation count it did not measure', () => {
    const proof = scenario(core, { noStateCheck: true, callsMade: 3 });
    assert.equal(proof.status, 'UNVERIFIED');
    assert.equal(proof.mutations_known, false);
    const lines = core.renderProofLines(proof);
    assert.ok(lines.some((l) => l.includes('mutations detected: UNKNOWN')), lines.join('\n'));
  });

  it('states plainly that a run which made no calls had nothing to mutate', () => {
    const proof = scenario(core, { records: [], callsMade: 0, noStateCheck: true });
    assert.equal(proof.status, 'INCOMPLETE');
    const lines = core.renderProofLines(proof);
    assert.ok(lines.some((l) => l.includes('no tool calls')), lines.join('\n'));
  });

  it('credits a gate skip as accounted for, so the ordinary run is not red', () => {
    const proof = scenario(core, { records: [gateSkipRecord('add_to_playlist')] });
    assert.equal(proof.status, 'PASS');
    assert.equal(proof.unaccounted.length, 0);
  });

  it('does not attribute a diff to a tool when several unguarded calls could have caused it', () => {
    const proof = scenario(core, {
      rows: [readTool('get_track'), writeTool('add_to_playlist', DRY_RUN), writeTool('create_playlist', DRY_RUN)],
      after: { ...CLEAN_STATE, tracks: 101 },
      records: [
        { tool: 'add_to_playlist', class: 'MUTATING', status: 'PASS', verified_no_mutation: true },
        { tool: 'create_playlist', class: 'MUTATING', status: 'PASS', verified_no_mutation: true },
      ],
      invocations: [
        { tool: 'add_to_playlist', dry_run: false, ok: true, structured: {} },
        { tool: 'create_playlist', dry_run: false, ok: true, structured: {} },
      ],
    });
    assert.equal(proof.status, 'MUTATIONS_DETECTED');
    assert.equal(proof.unverified.length, 2);
    // The fingerprint says WHAT changed, never WHICH tool did it. With two
    // possible causes the report declines to name one.
    assert.equal(proof.mutations_performed[0].attributable_to, null);
  });
});

// =====================================================================
// 4. End to end: the REAL script, against a stub MCP server
// =====================================================================

/**
 * A stand-in for `dist/index.js` with an in-memory account.
 *
 * The gauntlet is copied into a sandbox beside this, so the script under test
 * is the repository's own file and every code path above is the one a live
 * sweep takes. `cfg` selects the failure the scenario is about:
 *   - `mutateOnDryRun` — a tool that mutates the account even when asked for a
 *     preview, i.e. a dry_run that lies;
 *   - `proseOnly` — a tool that confirms the dry run in prose and carries no
 *     structured flag.
 */
const STUB_SERVER = `
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(process.env.STUB_CONFIG, 'utf8'));
const account = { tracks: 100, albums: 10, playlists: [{ id: 'pl1' }, { id: 'pl2' }] };
const props = (o) => ({ type: 'object', properties: o, additionalProperties: false });
const DRY = { dry_run: { type: 'boolean' } };
const write = { destructiveHint: false };

const TOOLS = [
  { name: 'get_me', description: 'me', inputSchema: props({}), annotations: { readOnlyHint: true, idempotentHint: true } },
  { name: 'search', description: 'search', inputSchema: props({}), annotations: { readOnlyHint: true, idempotentHint: true } },
  { name: 'get_saved_tracks', description: 'saved tracks', inputSchema: props({}), annotations: { readOnlyHint: true, idempotentHint: true } },
  { name: 'get_saved_albums', description: 'saved albums', inputSchema: props({}), annotations: { readOnlyHint: true, idempotentHint: true } },
  { name: 'get_user_playlists', description: 'playlists', inputSchema: props({}), annotations: { readOnlyHint: true, idempotentHint: true } },
  { name: 'get_track', description: 'track', inputSchema: props({}), annotations: { readOnlyHint: true, idempotentHint: true } },
  { name: 'get_devices', description: 'devices', inputSchema: props({}), annotations: { readOnlyHint: true, idempotentHint: true } },
  { name: 'spotify_doctor', description: 'doctor', inputSchema: props({}), annotations: { readOnlyHint: true, idempotentHint: true } },
  { name: 'add_to_playlist', description: 'add', inputSchema: props(DRY), annotations: write },
  { name: 'create_playlist', description: 'create', inputSchema: props(DRY), annotations: write },
  { name: 'apply_scene', description: 'apply', inputSchema: props(DRY), annotations: write },
  { name: 'save_scene', description: 'save', inputSchema: props({}), annotations: write },
];

const paged = (items, total) => ({ items, pagination: { total, offset: 0, limit: items.length, next_offset: null } });

function call(name, args) {
  switch (name) {
    case 'get_me': return { structuredContent: { id: 'user1', country: 'GB' } };
    case 'search': return { structuredContent: { tracks: { items: [{ id: 't1', album: { id: 'al1' }, artists: [{ id: 'ar1' }] }] }, shows: { items: [{ id: 'sh1' }] }, episodes: { items: [{ id: 'ep1' }] }, audiobooks: { items: [{ id: 'ab1' }] } } };
    case 'get_saved_tracks': return { structuredContent: paged([{ id: 't1' }], account.tracks) };
    case 'get_saved_albums': return { structuredContent: paged([{ id: 'al1' }], account.albums) };
    case 'get_user_playlists': return { structuredContent: paged(account.playlists, account.playlists.length) };
    case 'get_track': return { structuredContent: { id: 't1' } };
    case 'get_devices': return { structuredContent: { items: [{ id: 'dev1' }] } };
    case 'spotify_doctor': return { structuredContent: { ok: true } };
    case 'add_to_playlist': {
      // A dry run that does what it was asked not to do.
      if (cfg.mutateOnDryRun || args.dry_run !== true) account.tracks += 1;
      if (cfg.proseOnly) return { content: [{ type: 'text', text: '[dry run] would add 1 track' }] };
      if (args.dry_run === true && !cfg.mutateOnDryRun) return { structuredContent: { dry_run: true, would_add: 1 } };
      return { structuredContent: { ok: true, added: 1 } };
    }
    case 'create_playlist': {
      if (args.dry_run !== true) account.playlists.push({ id: 'pl-new' });
      return args.dry_run === true ? { structuredContent: { dry_run: true, would_create: 'probe' } } : { structuredContent: { ok: true } };
    }
    case 'apply_scene': return { structuredContent: { ok: true } };
    case 'save_scene': return { structuredContent: { ok: true } };
    default: throw new Error('unknown tool ' + name);
  }
}

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    let result;
    try {
      result = msg.method === 'initialize'
        ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'stub', version: '0' } }
        : msg.method === 'tools/list' ? { tools: TOOLS }
        : msg.method === 'tools/call' ? call(msg.params.name, msg.params.arguments ?? {})
        : {};
    } catch (err) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err.message } }) + '\\n');
      continue;
    }
    if (result.structuredContent && !result.content) {
      result.content = [{ type: 'text', text: JSON.stringify(result.structuredContent) }];
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  }
});
`;

interface RunOutcome {
  status: number;
  stdout: string;
  report: Record<string, never> & Record<string, any>;
}

const RUN_TIMEOUT_MS = 60_000;

/**
 * Run the repository's own `live-gauntlet.mjs` against the stub.
 *
 * The script is COPIED, not imported: it is a top-level-await program that
 * spawns its own server, so the only faithful way to exercise it is to run it
 * as a process, in a directory where `dist/index.js` is the stub. That also
 * means the assertions below are on the file the repository ships.
 */
interface Sandbox {
  readonly dir: string;
  readonly reportPath: string;
  /** Run the repository's own script in this sandbox. */
  run(args: string[]): { status: number; stdout: string };
}

/**
 * A sandbox holding a COPY of the real gauntlet beside the stub server.
 *
 * The driver spawns `node --env-file=.env dist/index.js` from the sandbox root
 * and imports its core module as `./live-gauntlet-core.mjs`, so the copies have
 * to land at those two paths. `HOME` is pointed at the sandbox too, so a server
 * that reached for a token file would find an empty one.
 */
function makeSandbox(cfg: Record<string, boolean>): Sandbox {
  const dir = sandbox('gauntlet-e2e-');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  writeFileSync(join(dir, '.env'), '', 'utf8');
  const configPath = join(dir, 'stub-config.json');
  writeFileSync(configPath, JSON.stringify(cfg), 'utf8');
  mkdirSync(join(dir, 'dist'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'index.js'), STUB_SERVER, 'utf8');
  copyFileSync(GAUNTLET_PATH, join(dir, 'scripts', 'live-gauntlet.mjs'));
  copyFileSync(CORE_PATH, join(dir, 'scripts', 'live-gauntlet-core.mjs'));
  const reportPath = join(dir, 'report.json');
  return {
    dir,
    reportPath,
    run(args) {
      const result = spawnSync(process.execPath, ['scripts/live-gauntlet.mjs', ...args], {
        cwd: dir,
        encoding: 'utf8',
        timeout: RUN_TIMEOUT_MS,
        env: { ...process.env, STUB_CONFIG: configPath, HOME: dir, USERPROFILE: dir },
      });
      return { status: result.status ?? -1, stdout: `${result.stdout ?? ''}${result.stderr ?? ''}` };
    },
  };
}

/** One clean sweep, and the report it wrote. */
function runGauntlet(cfg: Record<string, boolean>, extraArgs: string[] = []): RunOutcome {
  const box = makeSandbox(cfg);
  const run = box.run([`--report=${box.reportPath}`, ...extraArgs]);
  const report = run.status === 0 || run.status === 1
    ? JSON.parse(readFileSync(box.reportPath, 'utf8')) as RunOutcome['report']
    : ({} as RunOutcome['report']);
  return { status: run.status, stdout: run.stdout, report };
}

describe('live-gauntlet end to end, against a stub account', () => {
  it('proves a clean run: mutating tools skipped, fingerprint unchanged, PASS, exit 0', () => {
    const run = runGauntlet({ mutateOnDryRun: false, proseOnly: false });
    assert.equal(run.status, 0, run.stdout);
    const proof = run.report.mutation_proof;
    assert.equal(proof.status, 'PASS');
    assert.equal(proof.mutations_detected, 0);
    assert.equal(proof.state_check, 'PERFORMED');
    assert.ok(proof.fingerprint.compared_fields > 0, 'the state check actually read something');
    assert.deepEqual(proof.unverified_invocations, []);
    assert.deepEqual(proof.unaccounted_mutating_tools, []);
    // Nothing was called unguarded: every mutating tool skipped through the gate.
    assert.ok(proof.mutating_tools_skipped_by_default.includes('add_to_playlist'));
    assert.match(run.stdout, /mutations detected: 0/);
    // The banner's call count and the report's agree, and the seeds are counted.
    const summary = run.report.summary;
    assert.equal(summary.total_calls, summary.calls_this_run.sweep + summary.calls_this_run.seeds + summary.calls_this_run.state_check);
    assert.equal(summary.calls_this_run.seeds, 4, 'every seed read is counted, including the unrecorded audiobook search');
    assert.match(run.stdout, new RegExp(`= ${summary.total_calls} \\(`));
  });

  it('proves the proof goes red: a tool that mutates during a "dry run" is detected', () => {
    // This is the whole point of #643. The stub reports a clean dry run in
    // structured content AND changes the account, so a proof built on the
    // tool's own claim would pass. The fingerprint does not.
    const run = runGauntlet({ mutateOnDryRun: true, proseOnly: false }, ['--include-mutating=add_to_playlist']);
    assert.notEqual(run.status, 0, 'a detected mutation must fail the run');
    const proof = run.report.mutation_proof;
    assert.equal(proof.status, 'MUTATIONS_DETECTED');
    assert.equal(proof.mutations_detected, 1);
    assert.equal(proof.mutations_performed[0].field, 'saved_tracks_total');
    assert.equal(proof.mutations_performed[0].before, 100);
    assert.equal(proof.mutations_performed[0].after, 101);
    assert.equal(proof.mutations_performed[0].attributable_to, 'add_to_playlist');
    assert.match(run.stdout, /MUTATED saved_tracks_total: 100 -> 101/);
    assert.match(run.stdout, /mutation proof: MUTATIONS_DETECTED/);
  });

  it('proves the proof is non-vacuous: a mutating tool declared but never invoked is not PASS', () => {
    // `apply_scene` is allowlisted and declares dry_run, but the harness has no
    // recipe for it, so it is never called. A proof that treated "recorded" as
    // "exercised" would report PASS here.
    const run = runGauntlet({ mutateOnDryRun: false, proseOnly: false }, ['--include-mutating=apply_scene']);
    assert.notEqual(run.status, 0, 'an unexercised mutating tool must fail the run');
    const proof = run.report.mutation_proof;
    assert.equal(proof.status, 'UNVERIFIED');
    assert.deepEqual(proof.mutations_performed, []);
    assert.equal(proof.unaccounted_mutating_tools.length, 1);
    assert.equal(proof.unaccounted_mutating_tools[0].tool, 'apply_scene');
    assert.match(run.stdout, /UNACCOUNTED apply_scene/);
  });

  it('refuses a prose "[dry run]" and records the call as unverified', () => {
    const run = runGauntlet({ mutateOnDryRun: false, proseOnly: true }, ['--include-mutating=add_to_playlist']);
    assert.notEqual(run.status, 0);
    const proof = run.report.mutation_proof;
    assert.equal(proof.status, 'UNVERIFIED');
    assert.equal(proof.unverified_invocations[0].tool, 'add_to_playlist');
    assert.equal(proof.mutating_tools_dry_run_verified.includes('add_to_playlist'), false);
  });

  it('makes no mutation claim while a batched sweep is incomplete, and does not fail for it', () => {
    const run = runGauntlet({ mutateOnDryRun: false, proseOnly: false }, ['--batch=1']);
    assert.equal(run.status, 0, run.stdout);
    const proof = run.report.mutation_proof;
    assert.equal(proof.status, 'INCOMPLETE');
    assert.ok(proof.pending_mutating_tools.length > 0);
    // The number is real, and the sweep is explicitly not claiming anything.
    assert.equal(proof.mutations_detected, 0);
    assert.match(run.stdout, /mutation proof: INCOMPLETE/);
    assert.equal(run.report.summary.calls_this_run.sweep, 1);

    // Acceptance criterion 4: the four seed reads plus the one batched sweep
    // call, with the banner agreeing with the report. The issue wrote this as
    // `total_calls == seedCalls + 1` because it was written before the
    // fingerprint existed; the state check issues its own reads, so they are
    // counted and reported as their own line rather than folded into either
    // figure. The decomposition is asserted rather than the old total, because
    // the decomposition is the thing that has to stay true.
    const summary = run.report.summary;
    assert.equal(summary.calls_this_run.seeds, 4);
    assert.equal(summary.calls_this_run.state_check, 2 * core.ACCOUNT_PROBES.length, 'a fingerprint before and after the sweep');
    assert.equal(summary.total_calls, summary.calls_this_run.sweep + summary.calls_this_run.seeds + summary.calls_this_run.state_check);
    assert.match(
      run.stdout,
      new RegExp(`calls this run: ${summary.calls_this_run.sweep} sweep \\+ ${summary.calls_this_run.seeds} seed \\+ ${summary.calls_this_run.state_check} state-check = ${summary.total_calls}`),
      run.stdout,
    );
  });

  it('prints the classification audit, derived, before it calls anything', () => {
    const run = runGauntlet({ mutateOnDryRun: false, proseOnly: false });
    const auditLine = run.stdout.split('\n').find((l) => l.startsWith('classification audit:'));
    assert.ok(auditLine, 'the run prints a classification audit');
    const counts = /(\d+) MUTATING \/ (\d+) SAFE \/ (\d+) REVIEWED_READS/.exec(auditLine!);
    assert.ok(counts, auditLine!);
    assert.equal(Number(counts![1]) + Number(counts![2]), run.report.tools_discovered);
  });

  it('states the proof on the resume-to-completion path, and says it made no calls', () => {
    // The fast path a finished sweep takes. It issues no calls at all, so it
    // cannot print a mutation count it did not measure — and it still has to
    // decide PASS from the cumulative records rather than exiting 0 blind.
    const cfg = { mutateOnDryRun: false, proseOnly: false };
    const first = makeSandbox(cfg);
    const firstRun = first.run([`--report=${first.reportPath}`]);
    assert.equal(firstRun.status, 0, firstRun.stdout);

    // The first run's report is the resume input, copied into a fresh sandbox
    // so the second run starts from the same recorded state without sharing
    // any files with the run that produced it.
    const second = makeSandbox(cfg);
    copyFileSync(first.reportPath, second.reportPath);
    const secondRun = second.run([`--resume=${second.reportPath}`, `--report=${second.reportPath}`]);
    assert.equal(secondRun.status, 0, secondRun.stdout);
    assert.match(secondRun.stdout, /SWEEP_COMPLETE/);
    // No calls were made, so the honest line is the one that says so.
    assert.match(secondRun.stdout, /mutations detected: 0 \(this run issued no tool calls, so there was nothing to mutate\)/);
    assert.match(secondRun.stdout, /mutation proof: PASS/);
  });
});

// =====================================================================
// 5. Mutation testing: every guarantee above, shown able to go red
// =====================================================================

const CORE_SOURCE = readFileSync(CORE_PATH, 'utf8');

/**
 * Load a MUTATED copy of the decision module.
 *
 * Three properties this has to have, and the third is the one that matters:
 *
 *  1. the anchor must be present in the real source, asserted here. A mutation
 *     whose anchor has drifted applies to nothing, and a mutation that
 *     silently applies to nothing is indistinguishable from a passing test —
 *     so a missing anchor throws and takes the run with it.
 *  2. the copy is written under os.tmpdir() and imported by a cache-busted
 *     URL, so it cannot shadow the real module and cannot be served from the
 *     ESM cache.
 *  3. it prints nothing and mutates nothing: the copy is the same pure
 *     decision module the driver imports.
 */
async function loadMutated(label: string, anchor: string, replacement: string): Promise<CoreModule> {
  const occurrences = CORE_SOURCE.split(anchor).length - 1;
  assert.ok(occurrences > 0, `mutation "${label}": anchor not found in live-gauntlet-core.mjs — the mutation would silently apply to nothing:\n  ${anchor}`);
  assert.equal(occurrences, 1, `mutation "${label}": anchor is ambiguous (${occurrences} occurrences) — it would not mutate one place:\n  ${anchor}`);
  const dir = sandbox('gauntlet-mutate-');
  const file = join(dir, `core-${encodeURIComponent(label).replace(/%/g, '_')}.mjs`);
  writeFileSync(file, CORE_SOURCE.replace(anchor, replacement), 'utf8');
  const loaded = await import(pathToFileURL(file).href) as unknown as CoreModule;
  assert.notEqual(loaded, core, `mutation "${label}": the mutated copy did not load as a distinct module`);
  return loaded;
}

interface MutationCase {
  /** What this mutation removes, in the issue's terms. */
  readonly label: string;
  readonly anchor: string;
  readonly replacement: string;
  /**
   * The guarantee itself, as an assertion over the module under test.
   *
   * It must hold for the real module and must throw for the mutated one. A
   * `check` that is scoped to the module rather than to a pre-built fixture is
   * what lets each case assert the thing it is actually about: a classifier
   * mutation asserts on a classification, a proof mutation on a proof.
   */
  readonly check: (m: CoreModule) => void;
}

const MUTATIONS: MutationCase[] = [
  {
    label: 'an unannotated tool is treated as a write',
    anchor: '  if (!readOnly) {',
    replacement: '  if (false) {',
    // The #643 fallback, in the direction it actually failed: a write with no
    // `dry_run` and no `readOnlyHint` is the one case the `dry_run` clause
    // cannot rescue, so removing this branch is what puts it on the read path.
    check: (m) => {
      const audited = m.auditClassification([readTool('get_track'), writeTool('create_playlist')]);
      assert.equal(audited.verdicts.get('create_playlist')?.class, 'MUTATING');
      assert.equal(audited.verdicts.get('create_playlist')?.source, 'registry_write');
    },
  },
  {
    label: 'a declared commit path is treated as a write',
    anchor: '  if (dry) {',
    replacement: '  if (false) {',
    // A read-looking name that declares dry_run. With the clause gone it is
    // SAFE, so a sweep reaches it and calls it with no dry_run at all — and the
    // audit reports nothing wrong, which is the point.
    check: (m) => {
      const proof = scenario(m, { rows: [readTool('get_track', DRY_RUN)], records: [] });
      assert.equal(proof.status, 'INCOMPLETE');
      assert.deepEqual(proof.pending, ['get_track']);
      assert.equal(m.auditClassification([readTool('get_track', DRY_RUN)]).errors.length, 0);
    },
  },
  {
    label: 'dry-run confirmation comes from structured content, not prose',
    anchor: 'invocation?.structured?.dry_run === true',
    replacement: '/\\[dry run\\]/.test(String(invocation?.text ?? \'\'))',
    check: (m) => {
      const proof = scenario(m, {
        invocations: [{ tool: 'add_to_playlist', dry_run: true, ok: true, structured: { would_add: 1 }, text: '[dry run] would add 1 track' }],
        records: [{ tool: 'add_to_playlist', class: 'MUTATING', status: 'PASS', verified_no_mutation: true }],
      });
      assert.equal(proof.status, 'UNVERIFIED');
    },
  },
  {
    label: 'an unguarded call is unverified whatever the response says',
    anchor: 'if (invocation.dry_run !== true) {',
    replacement: 'if (false) {',
    // The request is what decides this, not the reply: a tool whose response
    // happens to carry `dry_run: true` was not actually asked to preview.
    check: (m) => {
      const proof = scenario(m, {
        invocations: [{ tool: 'add_to_playlist', dry_run: false, ok: true, structured: { dry_run: true, added: 1 } }],
      });
      assert.equal(proof.unverified.length, 1);
      assert.match(proof.unverified[0].reason, /without dry_run:true/);
    },
  },
  {
    label: 'a mutating tool declared but never invoked blocks the claim',
    anchor: "else if (unverified.length > 0 || unaccounted.length > 0) status = 'UNVERIFIED';",
    replacement: 'else if (unverified.length > 0) status = \'UNVERIFIED\';',
    check: (m) => {
      const proof = scenario(m, {
        records: [{ tool: 'add_to_playlist', class: 'MUTATING', status: 'SKIP', reason: 'needs a saved playlist; no arg recipe' }],
      });
      assert.equal(proof.status, 'UNVERIFIED');
      assert.equal(proof.unaccounted.length, 1);
    },
  },
  {
    label: 'an observed account-state diff is reported, not swallowed',
    anchor: "  if (mutationsPerformed.length > 0) status = 'MUTATIONS_DETECTED';",
    replacement: '  if (false) status = \'MUTATIONS_DETECTED\';',
    check: (m) => {
      const proof = scenario(m, { after: { ...CLEAN_STATE, tracks: 101 } });
      assert.equal(proof.status, 'MUTATIONS_DETECTED');
    },
  },
  {
    label: 'the mutation count is derived from the diff',
    anchor: 'mutations_detected: mutationsPerformed.length,',
    replacement: 'mutations_detected: 0,',
    // The #643 constant, verbatim: a hard-coded zero in the report, which is
    // what made a mutating run and a clean run publish the same claim.
    check: (m) => {
      const proof = scenario(m, { after: { ...CLEAN_STATE, tracks: 101 } });
      assert.equal(proof.mutations_detected, 1);
    },
  },
  {
    label: 'an unreadable probe is not counted as unchanged',
    anchor: '    if (b === undefined || a === undefined) {',
    replacement: '    if (false) {',
    check: (m) => {
      const before = fingerprintOf(m, CLEAN_STATE);
      const after = m.snapshotFromProbeResponses([
        ...probeResponses(m, CLEAN_STATE).slice(0, 2),
        { probe: m.ACCOUNT_PROBES[2], ok: false, error: 'quota wall' },
        probeResponses(m, CLEAN_STATE)[3],
      ]);
      assert.equal('playlists_total' in after.fields, false, 'a failed probe never becomes a value');
      const proof = m.computeMutationProof({
        classification: m.classifyRegistry([readTool('get_track'), writeTool('add_to_playlist', DRY_RUN)]),
        records: [gateSkipRecord('add_to_playlist')],
        invocations: [],
        callsMade: 1,
        before,
        after,
      });
      assert.equal(proof.status, 'UNVERIFIED');
    },
  },
  {
    label: 'every REVIEWED_READS entry is checked against the registry',
    anchor: 'const reviewedButNotReadOnly = reviewed.filter((n) => verdicts.get(n).serverSaysRead !== true);',
    replacement: 'const reviewedButNotReadOnly = [];',
    check: (m) => {
      const audited = m.auditClassification([writeTool('backup_library', DRY_RUN)]);
      assert.ok(
        audited.errors.includes('backup_library: REVIEWED_READS entry, but the registry no longer advertises it as read-only'),
        audited.errors.join('\n'),
      );
    },
  },
];

describe('mutation testing: each guarantee can go red', () => {
  for (const mutation of MUTATIONS) {
    it(`goes red when ${mutation.label} is removed`, async () => {
      // First: the same assertion holds against the real module. Without this,
      // "red" below could just mean the scenario was never green.
      mutation.check(core);

      const mutated = await loadMutated(mutation.label, mutation.anchor, mutation.replacement);

      // Then: the mutation must break it. `assert.throws` IS the assertion —
      // if the mutated module still satisfied the guarantee, this fails, which
      // is how a test that cannot detect its own regression gets caught.
      assert.throws(
        () => mutation.check(mutated),
        undefined,
        `mutation "${mutation.label}" did not break its guarantee — the test cannot detect this regression`,
      );
    });
  }

  it('holds every anchor it will mutate against the live source, so a drifted one fails the run', () => {
    // `loadMutated` asserts each anchor again before writing; doing it here
    // too means a rename is reported as a broken guarantee rather than as nine
    // mysterious passes. An empty table would be a harness that proves nothing.
    assert.ok(MUTATIONS.length >= 8, `only ${MUTATIONS.length} mutations defined`);
    for (const mutation of MUTATIONS) {
      assert.ok(CORE_SOURCE.includes(mutation.anchor), `anchor missing for ${mutation.label}:\n  ${mutation.anchor}`);
      assert.notEqual(mutation.anchor, mutation.replacement, `mutation ${mutation.label} is a no-op`);
    }
  });
});
