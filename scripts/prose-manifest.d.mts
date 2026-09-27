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
export type ProseRetirement = ProseUnitPin & { file: string; date: string; reason: string };

/** The hand-maintained pin file, as `scripts/doc-prose-manifest.json` holds it. */
export type ProseManifest = {
  note?: string;
  files?: Record<string, ProseUnitPin[]>;
  retired?: ProseRetirement[];
};

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
  files: string[];
};

/**
 * Rebuild a manifest from the documents, refusing to drop a pin that is no
 * longer present unless the caller retires it with a recorded reason.
 */
export function syncProseManifest(
  manifest: ProseManifest,
  documents: ProseDocuments,
  options: { retire?: string; date: string; reason?: string },
): {
  manifest: ProseManifest;
  dropped: Array<ProseUnitPin & { file: string }>;
  retired: ProseRetirement[];
  refused: boolean;
};
