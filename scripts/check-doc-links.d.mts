/**
 * Types for `scripts/check-doc-links.mjs`.
 *
 * **Hand-maintained alongside the `.mjs` it describes — update this file
 * whenever that script's exports change.** A signature that stops matching the
 * implementation is a bug in this file, and the fix is to correct it here, never
 * to widen a caller's cast back to `any`.
 *
 * `tsconfig.tests.json` includes `src` and `tests` but not `scripts`, so this
 * `.mjs` has no declaration and `tsc` reported TS7016 on the import in
 * `tests/doc-links.test.ts`. The four pure helpers the test drives are declared
 * below; the rest of the module is the CLI half, which is declared too because a
 * signature that is absent is a signature nothing checks.
 *
 * Note the module body is guarded: it only runs the gate when this file is the
 * process entry point, so importing the helpers is side-effect free. The
 * `root` parameters default to the repository root inside the `.mjs` and are
 * declared optional here for the same reason.
 */

/**
 * GitHub's heading anchor: lowercase, drop everything that is not a word
 * character, space or hyphen, then each space becomes its own hyphen.
 *
 * Per-space, not per-run: "1. Goals & Non-Goals" is `#1-goals--non-goals`.
 */
export declare function anchorSlug(heading: string): string;

/** Every anchor the document publishes: its ATX headings, plus explicit `<a id>`. */
export declare function anchorsOf(source: string): Set<string>;

/** Every file under `directory`, recursively. Order is filesystem order, not sorted. */
export declare function walk(directory: string): string[];

/**
 * The documents a reader is expected to follow links inside: the five root
 * documents, then everything under `docs/` and `skills/`, filtered to the
 * Markdown files that exist and sorted.
 */
export declare function scannedDocs(root?: string): string[];

/**
 * Every relative link in `source` that does not resolve, as
 * `docFile:line  ->  target  (reason)`.
 *
 * `docDir` is the directory the links are relative to, and it is also what a
 * `#fragment` with no file part is checked against. `root` only affects the
 * wording of the message. Targets with a `scheme:` or a `//` prefix are skipped
 * by design — they resolve over the network, and a gate that fetched them would
 * be a flaky gate.
 */
export declare function findBrokenLinks(
  source: string,
  docFile: string,
  docDir: string,
  root?: string,
): string[];

/** Every broken relative link across the scanned documents. */
export declare function findBrokenDocLinks(root?: string): string[];

/**
 * Everything wrong with a 403 message that points somewhere a reader cannot go.
 *
 * Both inputs are arguments rather than things the function reads itself, which
 * is what lets a test drive it with a deliberately drifted message — a version
 * that imported `graceful403Message()` internally could only be exercised
 * against the shipped message, and neutering it left every test green.
 */
export declare function gatedMessageErrors(rendered: string, readmeSource: string): string[];

/**
 * `gatedMessageErrors` over the real message and the real README.
 *
 * The message is imported and CALLED, so a rename in `src/gating.ts` is what this
 * sees — the string is assembled from concatenated literals and there is no
 * exported constant to compare against.
 */
export declare function checkGatedMessageTarget(): Promise<string[]>;
