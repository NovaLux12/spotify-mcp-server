/**
 * Types for `scripts/check-doc-tool-counts.mjs`.
 *
 * **Hand-maintained alongside the `.mjs` it describes — update this file
 * whenever that script's exports change.** A signature that stops matching the
 * implementation is a bug in this file, and the fix is to correct it here, never
 * to widen a caller's cast back to `any`.
 *
 * `tsconfig.tests.json` includes `src` and `tests` but not `scripts`, so this
 * `.mjs` had no declaration and two importers took TS7016 between them
 * (`tests/doc-figures.test.ts` and `tests/live-constant-comment.test.ts`).
 * Because the binding was `any`, every `registryScaleToolCounts(...).map((hit) =>
 * …)` in `doc-figures` also had an implicit-any parameter — six errors from one
 * missing file.
 *
 * The module body is guarded by an entry-point check, so importing the pure
 * helpers does not run the gate.
 */

/**
 * The line separating a registry total from a per-module count: below it a
 * figure is a module's own tool count, at or above it a figure is a claim about
 * the whole registry that nothing else validates.
 */
export declare const REGISTRY_SCALE_FLOOR: 100;

/**
 * The upper end of the same contract, and the reason `SPEC.md` may say "hundreds
 * of tools" rather than a count.
 */
export declare const REGISTRY_SCALE_CEILING: 1000;

/**
 * The parts of `scripts/surface-census.mjs` output this script reads.
 *
 * Deliberately partial: the census carries many more measurements, and naming
 * only the two fields the floor contract is argued from keeps a census that
 * grows a field from breaking the call sites.
 */
export interface ToolCountCensus {
  /** The registry-wide tool count `tools/list` returned. */
  tools: number;
  /** Per-module tool counts, keyed by module source path. */
  perModule?: Record<string, number> | null;
}

/** One registry-scale figure found in an already-masked text. */
export interface RegistryScaleHit {
  /** The figure exactly as written, commas and a leading `~` included. */
  figure: string;
  /** The character offset in the MASKED text — the mask is offset-preserving, so this maps back to a `file:line`. */
  index: number;
}

/**
 * The text a regex sees: generated blocks blanked to spaces.
 *
 * Every line keeps its original length and offset, so a match index in the
 * result is the same index in the source and a reported line number is honest.
 */
export declare function blankGenerated(source: string): string;

/**
 * Reduce a TypeScript source to its comments, offset-preserving.
 *
 * A line is a comment line when its first non-space characters are `//`, `/*`
 * or `*`. A trailing `//` on a code line is NOT scanned — telling a comment
 * from a string without a parser is not worth a parser. `tests/doc-figures.test.ts`
 * asserts that this limitation currently costs no coverage rather than assuming
 * it.
 */
export declare function maskToComments(source: string): string;

/** Every file the rule reads under `root`, absolute, documents before sources. */
export declare function scannableFiles(root: string): string[];

/** The masked text for source already read into memory, keyed by extension. */
export declare function maskSource(source: string, isTypeScript: boolean): string;

/**
 * Every registry-scale tool count in one already-masked text, in either word
 * order, at or above `REGISTRY_SCALE_FLOOR`.
 */
export declare function registryScaleToolCounts(masked: string): RegistryScaleHit[];

/**
 * Every un-allowed registry-scale tool count under `root`, as
 * `file:line: figure` strings, plus a dead-allowance error for any recorded
 * allowance no longer present in the tree.
 *
 * A dead allowance is an error on purpose: it is the anti-drift half of the
 * rule, so a rewording that silently disarms an allowance fails here rather
 * than leaving the gate quiet.
 */
export declare function collectToolCountErrors(root: string, census: ToolCountCensus): string[];

/**
 * Both ends of `REGISTRY_SCALE_FLOOR`, measured rather than assumed.
 *
 * Throws when the registry falls below the floor, reaches the ceiling (which
 * makes SPEC.md's "hundreds of tools" false), or when a single module reaches
 * the floor and a per-module count becomes indistinguishable from a registry
 * count.
 */
export declare function assertFloorIsDrawnCorrectly(census: ToolCountCensus): void;
