#!/usr/bin/env node
// Decision logic for scripts/live-gauntlet.mjs (#643).
//
// Everything the gauntlet CLAIMS is computed here, and nothing here performs
// I/O, so a claim can be evaluated against fixtures instead of a live Spotify
// account. The driver owns the RPC; this module owns the answers:
//
//   - classification  — is a tool SAFE or MUTATING, derived from the registry
//                       rather than from a hand-kept list;
//   - the audit       — the per-run classification census, and the gate that
//                       fails the run when it is internally inconsistent;
//   - the fingerprint — a cheap, honest snapshot of account state, and the
//                       diff that becomes `mutations_detected`;
//   - the proof       — the status the report and the banner print, derived
//                       from the diff, the per-call dry-run confirmations, and
//                       whether every MUTATING tool was actually accounted for.
//
// #643 was that the previous version decided all four differently, and none of
// them falsifiable: the classifier was a 22-name literal whose fallback branch
// was SAFE while the file's own safety comment claimed the opposite; the
// "verification" was a regex over the tool's own prose; and `mutations
// performed: NONE` was a constant string in both the banner and the committed
// artifact, so a clean run and a mutating run produced the same claim.
//
// The design rule throughout: a claim is either derived from observed state or
// it is reported as UNVERIFIED. Silence is never evidence of absence.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------- REVIEWED_READS

/**
 * The escape hatch: tools that declare `dry_run` and that the registry also
 * advertises as read-only, but which are treated as reads by this harness
 * anyway.
 *
 * This set is deliberately SMALL and hand-audited, because it is the one place
 * where a mutating tool can be declared SAFE. Everything else follows the
 * registry: a tool is MUTATING unless the registry says it is read-only AND it
 * declares no `dry_run`, so the list below is the *only* way a
 * `dry_run`-declaring tool lands on the SAFE path. `tests/` asserts each entry
 * is registered, does declare `dry_run`, and IS marked read-only by the
 * registry — the escape hatch fails closed if any of those stops holding.
 *
 * Every entry cites the evidence that made the tool a read:
 *
 *  - diff_playlists (src/tools/playlistops.ts) — accepts `dry_run` "so agents
 *    can pass it uniformly across the family"; the handler states outright that
 *    it never mutates and that dry_run therefore changes nothing.
 *  - find_duplicate_playlists (src/tools/playlisthealth.ts) — `dry_run` returns
 *    a request-cost estimate before the /me/playlists walk; the real path only
 *    GETs, and the tool's own description ends "Read-only."
 *  - check_artist_releases (src/tools/artistwatch.ts) — `dry_run` returns a
 *    lookup-cost estimate and makes no API calls; the commit path would be in a
 *    different tool.
 *  - playlist_staleness_report — OVERRIDES row { readOnlyHint: true } (#896):
 *    "issues only GETs — /me/playlists and then each playlist's items".
 *  - backup_library — OVERRIDES row { readOnlyHint: true } (#1101): "makes no
 *    Spotify write — every call is a GET, and the only writes are to the local
 *    backup directory."
 *  - show_backlog_plan — audited in NEVER_MUTATING_PLANS: "GET plus ordering;
 *    dry-run only, never mutates".
 *
 * Adding an entry means adding the same evidence a NEVER_MUTATING_PLANS row
 * carries. There is deliberately no entry for a tool that simply "looks like a
 * read": a new tool that takes `dry_run` and is classified SAFE without one
 * fails the audit instead of being swept onto the SAFE path.
 */
export const REVIEWED_READS = new Map([
  ['diff_playlists', 'handler comment in src/tools/playlistops.ts: "This tool never mutates anything, so dry_run changes nothing"'],
  ['find_duplicate_playlists', 'src/tools/playlisthealth.ts: dry_run returns a cost estimate before the GET walk; description ends "Read-only."'],
  ['check_artist_releases', 'src/tools/artistwatch.ts: dry_run returns a lookup-cost estimate and makes no API calls'],
  ['playlist_staleness_report', 'registry OVERRIDES readOnlyHint:true (#896) — GET /me/playlists then each playlist\'s items'],
  ['backup_library', 'registry OVERRIDES readOnlyHint:true (#1101) — every call is a GET; writes are local backup files only'],
  ['show_backlog_plan', 'registry NEVER_MUTATING_PLANS row — GET plus ordering; dry-run only, never mutates'],
]);

// ------------------------------------------------------------------ state probes

/**
 * The account state the gauntlet reads before and after a run.
 *
 * Four cheap GETs. What this covers and what it does not is stated in the
 * banner, because a fingerprint that overstates itself is the same defect as
 * the constant string it replaces: it covers library membership and the set of
 * playlists, and it does NOT cover reordering, per-item edits inside a
 * playlist, or anything outside the user's own library.
 *
 * Declared here, above `auditClassification`, because that function reads it:
 * a `const` consumed by a function defined earlier in the file is fine at call
 * time and a `ReferenceError` at import time if the ordering ever changes.
 */
export const ACCOUNT_PROBES = Object.freeze([
  Object.freeze({ field: 'saved_tracks_total', tool: 'get_saved_tracks', args: Object.freeze({ limit: 1, response_format: 'json' }), measure: 'total' }),
  Object.freeze({ field: 'saved_albums_total', tool: 'get_saved_albums', args: Object.freeze({ limit: 1, response_format: 'json' }), measure: 'total' }),
  Object.freeze({ field: 'playlists_total', tool: 'get_user_playlists', args: Object.freeze({ limit: 1, response_format: 'json' }), measure: 'total' }),
  Object.freeze({ field: 'playlist_ids_hash', tool: 'get_user_playlists', args: Object.freeze({ limit: 50, response_format: 'json' }), measure: 'id_set_hash' }),
]);

/** A count the server actually reported, or null when it did not report one. */
function readTotal(structured) {
  const total = structured?.pagination?.total ?? structured?.total;
  return typeof total === 'number' && Number.isFinite(total) ? total : null;
}

/**
 * A hash of the playlist id set, or null.
 *
 * An id SET, not a contents hash: hashing every playlist's items would mean
 * walking the whole account twice per run, which is the quota wall this script
 * exists to pace around. The banner says "id set" so nobody reads it as more.
 */
function readIdSetHash(structured) {
  const items = structured?.items;
  if (!Array.isArray(items)) return null;
  const ids = items.map((row) => row?.id).filter((id) => typeof id === 'string').sort();
  if (ids.length === 0) return null;
  return createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 16);
}

const MEASURES = { total: readTotal, id_set_hash: readIdSetHash };

// ---------------------------------------------------------------- classification

/**
 * A tool's classification, plus the evidence for it.
 *
 * `serverSaysRead` is read straight off the `tools/list` annotations the
 * server itself publishes (src/tools/annotations.ts `classifyToolAnnotations`),
 * so the harness and the registry cannot hold two different opinions about the
 * same tool. `declaresDryRun` is the capability the name-driven policy cannot
 * see: a tool that can take a commit path is a write until someone proves
 * otherwise.
 */
export const MUTATING = 'MUTATING';
export const SAFE = 'SAFE';

/**
 * Does this input schema declare a `dry_run` property?
 *
 * The capability test, on a schema rather than a whole `tools/list` row, so the
 * driver's own call site reuses it instead of re-deriving the same condition a
 * second way.
 */
export function schemaDeclaresDryRun(schema) {
  const props = schema?.properties;
  return Boolean(props && typeof props === 'object' && Object.hasOwn(props, 'dry_run'));
}

/** `declaresDryRun` for a `tools/list` row. */
export function declaresDryRun(tool) {
  return schemaDeclaresDryRun(tool?.inputSchema);
}

/**
 * Classify one registered tool. Fail-closed: anything the registry does not
 * advertise as read-only, and anything that declares a commit path, is MUTATING.
 * The only exception is REVIEWED_READS, which is audited and per-entry.
 */
export function classifyTool(tool, options = {}) {
  const reviewedReads = options.reviewedReads ?? REVIEWED_READS;
  const name = tool?.name;
  if (typeof name !== 'string' || name === '') {
    throw new Error('classifyTool: tool has no name');
  }
  const dry = declaresDryRun(tool);
  const readOnly = tool?.annotations?.readOnlyHint === true;

  if (reviewedReads.has(name)) {
    return {
      tool: name,
      class: SAFE,
      reason: `REVIEWED_READS: ${reviewedReads.get(name)}`,
      source: 'reviewed_read',
      serverSaysRead: readOnly,
      declaresDryRun: dry,
    };
  }
  if (!readOnly) {
    return {
      tool: name,
      class: MUTATING,
      reason: readOnly === false
        ? 'registry advertises no readOnlyHint (classified as a write)'
        : 'registry carries no readOnlyHint; treated as a write',
      source: 'registry_write',
      serverSaysRead: readOnly,
      declaresDryRun: dry,
    };
  }
  if (dry) {
    return {
      tool: name,
      class: MUTATING,
      reason: 'registry says read-only but the schema declares dry_run, so a commit path exists',
      source: 'dry_run_capability',
      serverSaysRead: readOnly,
      declaresDryRun: dry,
    };
  }
  return {
    tool: name,
    class: SAFE,
    reason: 'registry readOnlyHint:true and no dry_run in the schema',
    source: 'registry_read',
    serverSaysRead: readOnly,
    declaresDryRun: dry,
  };
}

/** Classify a whole `tools/list` payload. */
export function classifyRegistry(tools, options = {}) {
  const out = new Map();
  for (const tool of tools) out.set(tool.name, classifyTool(tool, options));
  return out;
}

/**
 * The per-run classification census, and the gate built on it.
 *
 * `errors` is what fails the run. It is deliberately not derived from a
 * precomputed verdict: every entry is recomputed here from the tool payloads, so
 * a change to `classifyTool` that breaks the invariant turns this red.
 *
 * The two invariants, both of which #643's classifier violated:
 *
 *   1. no tool declares `dry_run` and is classified SAFE, except through
 *      REVIEWED_READS (the audit names every one of them);
 *   2. no tool the registry advertises as a WRITE is classified SAFE, with no
 *      exception list — REVIEWED_READS can only downgrade a registry *read*.
 */
export function auditClassification(tools, options = {}) {
  const reviewedReads = options.reviewedReads ?? REVIEWED_READS;
  const verdicts = classifyRegistry(tools, options);
  const names = [...verdicts.keys()];

  const mutating = names.filter((n) => verdicts.get(n).class === MUTATING);
  const safe = names.filter((n) => verdicts.get(n).class === SAFE);
  const dryRunDeclared = names.filter((n) => verdicts.get(n).declaresDryRun);
  const reviewed = names.filter((n) => reviewedReads.has(n));
  const unannotated = tools
    .filter((t) => !Object.hasOwn(t ?? {}, 'annotations'))
    .map((t) => t.name);

  // Invariant 1.
  const dryRunDeclaredButSafe = names.filter(
    (n) => verdicts.get(n).declaresDryRun && verdicts.get(n).class === SAFE,
  );
  const unreviewedDryRunReads = dryRunDeclaredButSafe.filter((n) => !reviewedReads.has(n));

  // Invariant 2. Reviewed reads are checked against the registry too: a
  // REVIEWED_READS entry that the registry no longer calls read-only is an
  // escape hatch pointed at a write.
  const reviewedButNotReadOnly = reviewed.filter((n) => verdicts.get(n).serverSaysRead !== true);
  const reviewedNotRegistered = [...reviewedReads.keys()].filter((n) => !verdicts.has(n));
  const writeClassifiedSafe = safe.filter((n) => verdicts.get(n).serverSaysRead !== true);

  const errors = [];
  for (const name of unreviewedDryRunReads) {
    errors.push(`${name}: declares dry_run but is classified SAFE without a REVIEWED_READS entry`);
  }
  for (const name of reviewedButNotReadOnly) {
    errors.push(`${name}: REVIEWED_READS entry, but the registry no longer advertises it as read-only`);
  }
  for (const name of writeClassifiedSafe) {
    errors.push(`${name}: registry advertises a write but it is classified SAFE`);
  }
  // The state check itself must be made of reads. A fingerprint that calls a
  // write tool would mutate the account in the act of measuring it.
  for (const probe of ACCOUNT_PROBES) {
    const verdict = verdicts.get(probe.tool);
    if (verdict && verdict.class !== SAFE) {
      errors.push(`account-state probe ${probe.tool} is classified ${verdict.class}; the state check must only read`);
    }
  }

  // Reported, not gating. A REVIEWED_READS entry for a tool this registry does
  // not register is dead weight, and a sweep against a trimmed surface (a
  // toolset, a scoped install) would fail on it for no safety reason.
  const warnings = reviewedNotRegistered.map((name) => `${name}: REVIEWED_READS entry for a tool that is not registered`);

  // #1347: the census of what failing closed actually costs. A MUTATING tool
  // is only ever called when it is allowlisted AND its schema declares
  // `dry_run`, so a registry write with no commit path is a tool this harness
  // can never call — not "not called this run", NEVER. Those are the tools
  // whose coverage a reader of the sweep report would otherwise assume it has.
  //
  // Derived here from the same verdicts everything else uses, and never a
  // hand-kept list: a name added to the registry, or a tool that grows a
  // `dry_run`, moves itself off this list without anyone editing it. That is
  // the property that makes it a measurement rather than a second table to
  // forget — the failure #1347 is about is a gate that reports green while
  // measuring nothing, and a hand-typed roster of the gaps is exactly the kind
  // of thing that goes stale while still looking authoritative.
  const uncalledRegistryWrites = names
    .filter((n) => verdicts.get(n).class === MUTATING && !verdicts.get(n).declaresDryRun)
    .sort();

  return {
    total: names.length,
    mutating: mutating.length,
    safe: safe.length,
    dryRunDeclared: dryRunDeclared.length,
    reviewedReads: reviewed,
    reviewedReadCount: reviewed.length,
    unannotatedCount: unannotated.length,
    dryRunDeclaredButSafe,
    unreviewedDryRunReads,
    reviewedButNotReadOnly,
    reviewedNotRegistered,
    writeClassifiedSafe,
    uncalledRegistryWrites,
    uncalledRegistryWriteCount: uncalledRegistryWrites.length,
    verdicts,
    errors,
    warnings,
  };
}

/**
 * Audit the arg-recipe tables against the classification.
 *
 * `orphans` are recipes naming a tool that no longer registers — silently
 * recorded as a skip, so they read as coverage while exercising nothing.
 * `unreachable` are read-path recipes for tools the registry calls writes: they
 * cannot run any more, and leaving them in place is how the SAFE path looked
 * like it covered a mutating tool.
 */
export function auditRecipeTables(tools, verdicts, recipeTables) {
  const names = new Set(tools.map((t) => t.name));
  const orphans = [];
  const unreachable = [];
  for (const [table, recipes] of Object.entries(recipeTables)) {
    for (const name of Object.keys(recipes ?? {})) {
      if (!names.has(name)) { orphans.push(`${table}.${name}`); continue; }
      const verdict = verdicts.get(name);
      if (table === 'SAFE_ARGS' && verdict && verdict.class !== SAFE) {
        unreachable.push(`${table}.${name} (${verdict.class})`);
      }
    }
  }
  return { orphans, unreachable };
}

// ------------------------------------------------------------------ fingerprint

/**
 * Fold the probe responses into a fingerprint.
 *
 * A probe that fails, or that answers without the field the fingerprint needs,
 * is recorded as `unreadable` rather than defaulted to 0. Defaulting an
 * unreadable count to zero is the "0 streams" bug from #803 in a new coat, and
 * it would make the diff silently agree with itself.
 *
 * @param {Array<{probe: {field: string, tool: string, measure: string}, ok?: boolean, structured?: unknown, error?: string}>} responses
 */
export function snapshotFromProbeResponses(responses) {
  const fields = {};
  const unreadable = {};
  for (const response of responses ?? []) {
    const { probe } = response;
    if (response.ok === false) {
      unreadable[probe.field] = `${probe.tool} call failed: ${response.error ?? 'unknown error'}`;
      continue;
    }
    const measure = MEASURES[probe.measure];
    const value = measure(response.structured);
    if (value === null) {
      unreadable[probe.field] = `${probe.tool} returned no ${probe.measure} to read`;
      continue;
    }
    fields[probe.field] = value;
  }
  return { fields, unreadable };
}

/**
 * Compare two fingerprints.
 *
 * A field unreadable on either side is reported, never compared: "we could not
 * check this" is not "this did not change".
 */
export function diffFingerprints(before, after) {
  const changed = [];
  const unreadable = [];
  for (const probe of ACCOUNT_PROBES) {
    const { field } = probe;
    const b = before?.fields?.[field];
    const a = after?.fields?.[field];
    if (b === undefined || a === undefined) {
      unreadable.push(field);
      continue;
    }
    if (b !== a) changed.push({ field, before: b, after: a, probe: probe.tool });
  }
  for (const field of Object.keys(before?.unreadable ?? {})) {
    if (!unreadable.includes(field)) unreadable.push(field);
  }
  for (const field of Object.keys(after?.unreadable ?? {})) {
    if (!unreadable.includes(field)) unreadable.push(field);
  }
  return {
    changed,
    unreadable,
    compared: ACCOUNT_PROBES.length - unreadable.length,
    before: before ?? { fields: {}, unreadable: {} },
    after: after ?? { fields: {}, unreadable: {} },
  };
}

// ------------------------------------------------------------------ the proof

/**
 * SKIP reasons that mean "this harness declined to call a MUTATING tool", which
 * is a legitimate, recorded decision.
 *
 * Anything else a MUTATING tool can be recorded as — a PASS on the read path, a
 * skip with no recipe, no record at all — leaves the proof open, and the run
 * says so. The gate reasons are matched as prefixes so a reason can carry a
 * detail suffix without falling out of the set.
 */
export const GATE_SKIP_PREFIXES = Object.freeze([
  'mutating; not in --include-mutating allowlist',
  'allowlisted but tool has no dry_run support; refusing to call',
]);

export function isGateSkip(reason) {
  const text = String(reason ?? '');
  return GATE_SKIP_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/**
 * Does this response actually confirm it was a dry run?
 *
 * Structured evidence only: `structuredContent.dry_run === true`. The previous
 * version also accepted `/\[dry run\]/` over the tool's own prose, which is the
 * tool telling the harness what the harness wanted to hear — and #643's whole
 * point is that a self-report is not a measurement. A text-only confirmation is
 * recorded as UNVERIFIED, never as a pass.
 */
export function confirmsDryRun(invocation) {
  return invocation?.ok !== false && invocation?.structured?.dry_run === true;
}

/**
 * Compute the mutation proof.
 *
 * The result is one of four statuses, and only PASS is a claim:
 *
 *   MUTATIONS_DETECTED  the account fingerprint changed across the run.
 *   UNVERIFIED          something was called or recorded that cannot support
 *                       "nothing was mutated" — a mutating tool invoked without
 *                       a confirmed dry run, a mutating tool that was never
 *                       exercised, or a fingerprint field that could not be
 *                       read on both sides.
 *   INCOMPLETE          the sweep did not reach every tool, so no claim is made
 *                       either way. A batched sweep is INCOMPLETE by design and
 *                       stays exit-0; the run that records the last pending tool
 *                       is the one that has to prove something.
 *   PASS                the fingerprint was readable and unchanged, every
 *                       mutating tool called in this run confirmed its dry run,
 *                       and every mutating tool in the registry is accounted
 *                       for — verified, or explicitly gated off.
 *
 * `mutations_detected` is always the length of the observed diff. It is never a
 * constant, and a run in which nothing was really mutated is the only run in
 * which it is 0.
 *
 * @param {object} input
 * @param {Map<string, object>} input.classification  name -> verdict
 * @param {Array<object>} input.records              cumulative per-tool rows
 * @param {Array<object>} input.invocations          this run's mutating calls
 * @param {number} [input.callsMade]                 tool calls this run actually issued
 * @param {object} [input.before]                    fingerprint taken before the run
 * @param {object} [input.after]                     fingerprint taken after the run
 */
export function computeMutationProof(input) {
  const classification = input.classification ?? new Map();
  const records = input.records ?? [];
  const invocations = input.invocations ?? [];
  const callsMade = input.callsMade ?? 0;
  const stateCheck = input.before && input.after ? 'PERFORMED' : 'NOT_PERFORMED';
  const diff = stateCheck === 'PERFORMED' ? diffFingerprints(input.before, input.after) : { changed: [], unreadable: [], compared: 0, before: null, after: null };

  const recordByTool = new Map(records.map((r) => [r.tool, r]));

  // --- per-invocation verification -----------------------------------------
  const dryRunVerified = [];
  const unverified = [];
  for (const invocation of invocations) {
    const verdict = classification.get(invocation.tool);
    if (!verdict || verdict.class !== MUTATING) continue;
    if (invocation.dry_run !== true) {
      unverified.push({
        tool: invocation.tool,
        reason: 'mutating tool invoked without dry_run:true; the run cannot claim it was a preview',
      });
    } else if (confirmsDryRun(invocation)) {
      dryRunVerified.push(invocation.tool);
    } else {
      unverified.push({
        tool: invocation.tool,
        reason: invocation.ok === false
          ? `dry-run call failed: ${invocation.error ?? 'unknown error'}`
          : 'response carried no structuredContent.dry_run === true; a prose "[dry run]" is not confirmation',
      });
    }
  }

  // --- coverage over the cumulative record set -----------------------------
  const pending = [];
  const unaccounted = [];
  for (const [name, verdict] of classification) {
    if (verdict.class !== MUTATING) continue;
    const record = recordByTool.get(name);
    if (!record) {
      pending.push(name);
      continue;
    }
    if (record.verified_no_mutation === true) continue;
    if (record.status === 'SKIP' && isGateSkip(record.reason)) continue;
    if (record.status === 'FAIL') continue; // already a red run; not a safety claim
    unaccounted.push({
      tool: name,
      status: record.status ?? 'UNKNOWN',
      reason: record.status === 'SKIP'
        ? `mutating tool skipped without a gate reason: ${record.reason ?? 'none given'}`
        : `mutating tool recorded ${record.status ?? 'UNKNOWN'} without a confirmed dry run`,
    });
  }

  // --- attribution ----------------------------------------------------------
  // The fingerprint says WHAT changed, never which tool did it. Attributing a
  // diff to a tool is only honest when exactly one unguarded mutating call
  // could have caused it; otherwise the report says so rather than guessing.
  const unguarded = unverified.map((u) => u.tool);
  const mutationsPerformed = diff.changed.map((entry) => ({
    field: entry.field,
    before: entry.before,
    after: entry.after,
    observed_by: entry.probe,
    attributable_to: unguarded.length === 1 ? unguarded[0] : null,
    attribution_note: unguarded.length === 1
      ? 'single unguarded mutating call in this run'
      : unguarded.length === 0
        ? 'no unguarded mutating call was made; the change has no identified cause in this run'
        : `${unguarded.length} unguarded mutating calls; the change cannot be attributed to one of them`,
  }));

  // A run that issued no calls cannot have mutated anything, and needs no
  // fingerprint to say so. A run that DID issue calls and has no fingerprint is
  // the hole this whole module exists to close, so it is not PASS.
  const stateMissingDespiteCalls = stateCheck !== 'PERFORMED' && callsMade > 0;

  let status;
  if (mutationsPerformed.length > 0) status = 'MUTATIONS_DETECTED';
  else if (unverified.length > 0 || unaccounted.length > 0) status = 'UNVERIFIED';
  else if (stateMissingDespiteCalls) status = 'UNVERIFIED';
  else if (diff.unreadable.length > 0 && stateCheck === 'PERFORMED') status = 'UNVERIFIED';
  else if (pending.length > 0) status = 'INCOMPLETE';
  else status = 'PASS';

  return {
    status,
    state_check: stateCheck,
    calls_made: callsMade,
    // `mutations_detected` is the length of the observed diff, always. When no
    // diff was observed it is 0 AND `mutations_known` is false unless the run
    // made no calls — a number printed without a measurement behind it is the
    // constant this replaced.
    mutations_detected: mutationsPerformed.length,
    mutations_known: stateCheck === 'PERFORMED' || callsMade === 0,
    mutations_performed: mutationsPerformed,
    dry_run_verified: dryRunVerified,
    unverified,
    unaccounted,
    pending,
    fingerprint: {
      compared_fields: diff.compared,
      unreadable_fields: diff.unreadable,
      before: diff.before,
      after: diff.after,
    },
  };
}

/** True for every status except the one that is a claim. */
export function proofBlocksExit(proof) {
  return proof.status === 'MUTATIONS_DETECTED' || proof.status === 'UNVERIFIED';
}

/** The banner lines. Every number here comes from `proof`, never a literal. */
export function renderProofLines(proof) {
  const lines = [];
  if (proof.state_check === 'PERFORMED') {
    lines.push(
      `mutations detected: ${proof.mutations_detected} `
      + `(account-state diff: ${proof.fingerprint.compared_fields} field(s) read before and after, `
      + `${proof.fingerprint.unreadable_fields.length} unreadable)`,
    );
  } else if (proof.calls_made === 0) {
    lines.push('mutations detected: 0 (this run issued no tool calls, so there was nothing to mutate)');
  } else {
    lines.push(`mutations detected: UNKNOWN (${proof.calls_made} tool calls with no account-state check)`);
  }
  for (const mutation of proof.mutations_performed) {
    lines.push(`  MUTATED ${mutation.field}: ${mutation.before} -> ${mutation.after} (observed by ${mutation.observed_by}; ${mutation.attribution_note})`);
  }
  for (const entry of proof.unverified) lines.push(`  UNVERIFIED ${entry.tool}: ${entry.reason}`);
  for (const entry of proof.unaccounted) lines.push(`  UNACCOUNTED ${entry.tool}: ${entry.reason}`);
  if (proof.pending.length) {
    lines.push(`  ${proof.pending.length} mutating tool(s) not reached yet — this sweep is INCOMPLETE and makes no claim`);
  }
  lines.push(`mutation proof: ${proof.status}`);
  return lines;
}

/** The per-run classification census, rendered. */
export function renderAuditLines(audit) {
  const gaps = audit.uncalledRegistryWrites ?? [];
  return [
    `classification audit: ${audit.mutating} MUTATING / ${audit.safe} SAFE / ${audit.reviewedReadCount} REVIEWED_READS (of ${audit.total} registered; ${audit.dryRunDeclared} declare dry_run)`,
    ...audit.reviewedReads.map((name) => `  REVIEWED_READS ${name}`),
    ...audit.unreviewedDryRunReads.map((name) => `  dry_run-declaring tool classified SAFE: ${name}`),
    // #1347. Named on every run, and counted, so "the sweep covered X" is
    // never read as "the sweep covered everything registered". The count is
    // the length of the measured list, not a literal that can drift from it.
    ...(gaps.length
      ? [
        `uncalled registry writes: ${gaps.length} registered tool(s) are writes with no dry_run, so this harness can never call them — coverage this report does NOT claim: ${gaps.join(', ')}`,
      ]
      : ['uncalled registry writes: 0']),
  ];
}
