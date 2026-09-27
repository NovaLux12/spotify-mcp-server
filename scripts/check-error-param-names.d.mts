/**
 * Types for `scripts/check-error-param-names.mjs`.
 *
 * **Hand-maintained alongside the `.mjs` it describes — update this file
 * whenever that script's exports change.** A signature that stops matching the
 * implementation is a bug in this file, and the fix is to correct it here, never
 * to widen a caller's cast back to `any`.
 *
 * `tsconfig.tests.json` includes `src` and `tests` but not `scripts`, so this
 * `.mjs` had no declaration and `tests/error-param-names.test.ts` took TS7016.
 * That test had worked around it by re-declaring every result shape at its own
 * import boundary — which put the property names under the compiler but left
 * the module itself untyped. Naming the real exports here is the same guarantee
 * from the correct side, and the workaround's local interfaces are now checked
 * against these rather than against `any`.
 *
 * Note this module exports its OWN `blankNonCode`, which is a different
 * implementation from the one in `scripts/blank-non-code.mjs`: it keeps the
 * quotes and the `${…}` holes rather than blanking the whole body. The two are
 * declared separately and must not be conflated.
 */

/** A string literal and where it starts, as the literal reader found it. */
export interface StringLiteral {
  /** The literal's text with `${…}` holes dropped — a hole is code, not prose. */
  text: string;
  /** The index just past the literal's closing quote. */
  end: number;
}

/** One `server.tool(...)` / `server.registerTool(...)` call, as the scan sees it. */
export interface Registration {
  /** The registered tool name. */
  name: string;
  /**
   * The top-level keys of the zod object literal. A lower bound, not the full
   * schema: a spread can contribute keys this scan cannot see.
   */
  keys: Set<string>;
  /**
   * True when a spread (or a nesting this scan did not follow) makes `keys`
   * incomplete. Rule 1 needs no schema and still runs; rule 2 skips, because
   * claiming a name is undeclared on a lower bound would be guessing.
   */
  opaque: boolean;
  /** Offset of the `{` that opens the schema literal. */
  handlerStart: number;
  /** Offset just past the `)` that closes the registration call. */
  handlerEnd: number;
}

/** One string literal in a span, with the line it starts on. */
export interface StringLiteralHit {
  text: string;
  /** 1-based, counted over the ORIGINAL source, not the mask. */
  line: number;
}

/** One thrown error message, attributed to the tool whose handler it sits in. */
export interface ThrownMessage {
  line: number;
  message: string;
  /** The owning tool, or `null` when the throw sits outside every registration. */
  tool: string | null;
  /** The owner's schema keys, or `null` when there is no owner or it is opaque. */
  keys: Set<string> | null;
}

/**
 * Walks the string literal whose opening quote is at `from`.
 *
 * The opening quote itself is at `from`, so `source[from]` selects the delimiter.
 * `${…}` holes are dropped from `text` and nested template literals are tracked
 * properly, so a hole holding another template cannot make the walk run past the
 * real closing backtick.
 */
export declare function readStringLiteral(source: string, from: number): StringLiteral;

/**
 * Source with comments and string bodies blanked to spaces, so a structural scan
 * can never be fooled by a brace or a `throw` living inside either.
 *
 * The output is the same length as the input, so an offset found in the mask is
 * the same offset in the source. `${…}` holes stay as code: a `throw` can live
 * in one. Quotes are kept — the structural scan needs them.
 */
export declare function blankNonCode(source: string): string;

/** The tool registrations in one source file, in the order they appear. */
export declare function registrations(source: string): Registration[];

/** Every string literal in `source[from, to)`, with its 1-based line number. */
export declare function stringLiterals(
  source: string,
  from?: number,
  to?: number,
): StringLiteralHit[];

/**
 * Every thrown error message in `source`, each attributed to the tool whose
 * handler it sits inside — or to `null` when it sits outside every registration,
 * where there is no schema to check a name against.
 */
export declare function collectThrownMessages(source: string): ThrownMessage[];

/** Every parameter name any registered tool in `sources` accepts. */
export declare function parameterVocabulary(sources: readonly string[]): Set<string>;

/** Every tool name registered anywhere in `sources`. */
export declare function toolNameVocabulary(sources: readonly string[]): Set<string>;

/**
 * Every way `source` misnames a parameter to a caller, as report lines.
 *
 * `toolNames` is the second vocabulary a bare snake_case claim is excused
 * against: "run album_id first" names a tool, not a parameter. It defaults to
 * the empty set, which is the stricter reading.
 */
export declare function collectErrorParamViolations(
  source: string,
  file: string,
  vocabulary: Set<string>,
  toolNames?: Set<string>,
): string[];
