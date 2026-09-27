/**
 * Types for `scripts/prose-manifest.mjs`.
 *
 * #1408 made this necessary. `tsconfig.tests.json` includes `src` and `tests`
 * but not `scripts`, so this `.mjs` has no declaration and
 * `tsc` reports TS7016 on the import — the binding is then `any`, and
 * everything derived from it loses its type too. That is why three errors in
 * `distribution-channel-guard.test.ts` were one error: with no declaration,
 * `splitProseUnits(source).map((unit) => ...)` has no contextual type and `unit`
 * is an implicit-any parameter, and `new Map(<any-array>)` infers a key type
 * that is not `string`, so `pinned.has(hash)` rejects it. Naming the real
 * signature removes all three at once — the signature of one cause rather than
 * three. `tsx` strips types rather than checking them, which is how the three
 * reached CI: the suite ran green while `npm run check:tests-typecheck` did
 * not.
 *
 * **This file is hand-maintained and can drift from the `.mjs` beside it.**
 * That is a real cost and it is the accepted one: the alternative is `any`,
 * which is a declaration that is wrong everywhere rather than one that is
 * wrong in one place, and a test built on `any` cannot fail on a signature
 * change at all. What keeps it honest is that the importers are not mocks —
 * `doc-prose-integrity.test.ts` calls `splitProseUnits`, `proseUnitHash`,
 * `describeDocument` and `proseDrift` against the live documents, so a shape
 * that stopped matching the implementation fails those tests at runtime rather
 * than passing quietly. If an export here is wrong, the fix is to correct this
 * file, never to widen a caller's cast.
 */

/** One pinned paragraph: a content-addressed key and a human-readable name. */
export type ProseUnitPin = { hash: string; label: string };

/** A pin that was deliberately dropped, with the reason it was dropped. */
export type ProseRetirement = ProseUnitPin & {
  file: string;
  date: string;
  reason: string;
  /** The `file:hash` of the retirement this record supersedes, if it is a correction. */
  corrects?: string;
};

/**
 * The commits a sync ran against, recorded so a later reader can tell a genuine
 * deletion from one a rebase manufactured (#1440).
 *
 * Two SHAs, not one, and the difference is the whole of #1482. `head` is the
 * tree the retirement reasons were decided against; `base` is the commit that
 * tree was built on, which is the only one of the two a squash-merge leaves an
 * ancestor of.
 *
 * `base` is optional because pins written before the field existed do not have
 * it, and those are judged on `head` alone — the strict direction, so nothing is
 * forgiven. A stamp written now always carries it, as `null` when the tree
 * shared no commit with `origin/main`.
 */
export type ProseProvenance = { head: string; base?: string | null; upstream: string | null; behind: boolean };

/** The hand-maintained pin file, as `scripts/doc-prose-manifest.json` holds it. */
export type ProseManifest = {
  note?: string;
  files?: Record<string, ProseUnitPin[]>;
  retired?: ProseRetirement[];
  provenance?: ProseProvenance;
};

/** One prose unit, as `coverage` reports it. */
export type ProseCoverageEntry = ProseUnitPin & { file: string };

/**
 * The two counts a comparison produces, reconciled by direction.
 *
 * `unpinned` is prose the walk found that no pin claims — ordinary work, free
 * by design, never an error. `missing` is a pin the walk did not find: prose a
 * file no longer carries, one entry per matching entry in `proseDrift`'s
 * `errors`. Reporting both by name is what stops a caller from subtracting
 * `currentCount` and `pinnedCount` and guessing the sign (#1460).
 */
export type ProseCoverage = { unpinned: ProseCoverageEntry[]; missing: ProseCoverageEntry[] };

/**
 * The documents a comparison read, repo-relative path to source text.
 *
 * Named in the return value as well as taken here: a scan that found nothing
 * would otherwise report the same clean verdict as one that read every file,
 * and only `files` tells them apart.
 */
export type ProseDocuments = Record<string, string>;

/** Split a document into its hand-written prose units. */
export function splitProseUnits(source: string): string[];

/** The human-facing name of a prose unit: its first 56 characters, unadorned. */
export function proseUnitLabel(text: string): string;

/** A short content digest of one unit. 16 hex characters. */
export function proseUnitHash(text: string): string;

/** The pinned identity of every hand-written unit in one document. */
export function describeDocument(source: string): ProseUnitPin[];

/**
 * Compare a manifest against the documents as they now stand.
 *
 * Reword and deletion are deliberately not told apart: nothing in the tree can
 * tell them apart, and the message names both readings.
 */
export function proseDrift(
  manifest: ProseManifest,
  documents: ProseDocuments,
): {
  errors: string[];
  currentCount: number;
  pinnedCount: number;
  coverage: ProseCoverage;
  files: string[];
};

/**
 * Rebuild a manifest from the documents, refusing to drop a pin that is no
 * longer present unless the caller retires it with a recorded reason.
 */
export function syncProseManifest(
  manifest: ProseManifest,
  documents: ProseDocuments,
  options: { retire?: string; date: string; reason?: string; corrects?: string },
): {
  manifest: ProseManifest;
  dropped: Array<ProseUnitPin & { file: string }>;
  /** The records THIS RUN added — what the census reports as the run's effect. */
  retired: ProseRetirement[];
  /** Every retirement after the write, additions and prior records together. */
  allRetired: ProseRetirement[];
  /** The one correction record written, or null when `--corrects` was absent. */
  correction: ProseRetirement | null;
  /** The `file:hash` a `--corrects` named that is not in the manifest, or null. */
  unknownCorrection: string | null;
  refused: boolean;
};

/**
 * The `file:hash` key a `corrects` field names.
 *
 * A hash alone is not the key: the same prose text can be pinned in two files.
 *
 * The parameter is the identity a key is made of, not the whole record: this is
 * called on pins, on fixtures, and on things that are not retirements at all, and
 * a signature demanding a `reason` would reject the first two for wanting less
 * than they were offered.
 */
export function retirementKey(entry: { file: string; hash: string }): string;

/**
 * Which retirement reasons a reader should still act on, and which a later record
 * retracts.
 *
 * `unknown` and `cyclic` are reported rather than resolved — a `corrects` naming
 * no record, or one that retracts itself, is a claim this will not read on the
 * author's behalf.
 */
export function retirementStanding(manifest: ProseManifest): {
  active: ProseRetirement[];
  retracted: ProseRetirement[];
  correctedBy: Map<string, string[]>;
  unknown: Array<{ corrects: string; by: string }>;
  cyclic: string[];
};

/**
 * What a working tree can prove about itself, as `gitProvenanceIn` reports it.
 *
 * `usable` is false rather than throwing on every failure: this runs on source
 * tarballs and shallow CI checkouts, and the caller's job is to *refuse* on a
 * tree it cannot vouch for, not to crash before it can explain itself.
 */
export type GitProvenance = {
  usable: boolean;
  head: string | null;
  base: string | null;
  upstream: string | null;
  behind: boolean;
  detached: boolean;
  dirty: string[];
  note: string;
};

/**
 * The two refusal classes, kept apart on purpose.
 *
 * A hard refusal has no escape — there is no tree to record provenance against,
 * and a guess would be the false record the pin exists to prevent. A soft one
 * names a situation rather than a defect, and is what `--allow-stale "<why>"`
 * acknowledges: it does not silence the warning, it moves the reason into
 * `provenance` where a reviewer reads it beside the retirement it qualifies.
 */
export type ProseSyncRefusals = { hard: string[]; soft: string[] };

/**
 * The read side of #1440, which *reports* where the write side refuses.
 *
 * `unverifiable` is not an error: a `fetch-depth: 1` CI checkout cannot prove
 * ancestry, and a gate that goes red for that is a gate people learn to ignore.
 */
export type ProseProvenanceVerdict = {
  status: 'verified' | 'rewritten' | 'unverifiable' | 'unrecorded';
  error: string | null;
  detail: string;
};

/**
 * Record the commits a manifest was generated from, beside the content it
 * describes — a SHA alone does not say whether the tree predates a docs PR.
 */
export function stampProvenance(
  manifest: ProseManifest,
  provenance: { head: string; base?: string | null; upstream?: string | null; behind?: boolean },
): ProseManifest & { provenance: ProseProvenance };

/**
 * The warning for a stamp that cannot survive a merge, or null when it can.
 *
 * A tree with no merge base has no commit that is an ancestor of both sides, so
 * the only stamp it can produce names a branch tip and is orphaned by the next
 * squash-merge. A warning rather than a refusal: the tree is not defective, and
 * refusing is the case `--allow-stale` exists to avoid.
 */
export function provenanceStampWarning(provenance: GitProvenance): string | null;

/**
 * Read the provenance of the working tree in `dir` (#1440).
 *
 * `dirty` is filtered to the paths the pin actually depends on: a dirty
 * `src/tools/foo.ts` cannot make a prose retirement false, and refusing on it
 * would train people to pass `--allow-stale` out of habit until the flag stops
 * meaning anything.
 */
export function gitProvenanceIn(
  dir: string,
  options?: { docFiles?: string[]; manifestPath?: string },
): GitProvenance;

/** The staleness cases `--prose-sync` has to refuse, split by whether they can be. */
export function proseSyncRefusals(
  provenance: GitProvenance,
  options?: { allowStale?: string | null },
): ProseSyncRefusals;

/** The short form of a SHA used in messages, or a placeholder for a missing one. */
export function short(sha: string | null | undefined): string;

/**
 * Check a manifest's recorded provenance against the tree it now sits in.
 *
 * `ancestor` is injected rather than shelled out to, so the caller decides what
 * "ancestor" costs to determine and this stays testable without a repository.
 * It returns `true`/`false` for a commit that is or is not in history, and
 * `null` for one whose object is absent — a shallow clone, not a verdict.
 */
export function proseProvenanceVerdict(
  manifest: ProseManifest,
  options: { ancestor: (recorded: string) => boolean | null },
): ProseProvenanceVerdict;

/**
 * Read documents as they are at a ref.
 *
 * A file absent at that ref is **omitted**, not returned as an empty string: a
 * document that does not exist upstream is a different fact from one that
 * exists and is empty, and the caller has to be able to tell them apart.
 */
export function readFilesAtRef(dir: string, ref: string, files: string[]): ProseDocuments;

/**
 * Which of the paragraphs a run is about to retire are *still present upstream*.
 *
 * Matched by content hash, not by label prefix: a partial reword keeps the
 * opening and changes the tail, and matching the label would report that
 * legitimate retirement as contradicted — refusing the tool's actual job.
 */
export function contradictedByUpstream(
  dropped: Array<ProseUnitPin & { file: string }>,
  upstreamDocuments: ProseDocuments,
): Array<ProseUnitPin & { file: string }>;
