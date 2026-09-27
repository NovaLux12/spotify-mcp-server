/**
 * One vocabulary for playlist position bases (#883).
 *
 * A playlist has exactly one ordered item list, and the tools that index into
 * it were numbered from two different ends. Some parameters are 0-based because
 * their value goes straight onto Spotify's wire (`range_start`, `insert_before`,
 * `position`, `positions[]` — all documented zero-based in the OpenAPI schema),
 * and some are 1-based because they are a *human* slot number that the handler
 * converts before the write (`start`, `to_position`, `position_a/b`). That
 * split is defensible on its own — the boundary is where the conversion
 * happens. What was not defensible is that the base was stated, or not stated,
 * by whichever sentence each call site happened to reach for.
 *
 * Fourteen position parameters across the playlist surface spelled the base out
 * in about six different ways, and four of the most dangerous ones said nothing
 * at all. The worst of those four — `reorder_playlist_items.range_start` and
 * `.insert_before` — are the parameters a natural-language request becomes
 * ("move track 4 to the top"), they carry the silent-wrong-rows failure, and a
 * caller had to infer the base from `.min(0)` in the JSON schema rather than
 * read it. `tests/position-base.test.ts` reads the live registry and fails if
 * any of them drifts.
 *
 * So the base is not prose convention here, it is a value. `PositionBase` names
 * the two, `positionBaseClause()` renders the one sentence each base is allowed
 * to be written as, and `positionSchema()` derives the zod lower bound from the
 * base instead of restating it. A call site cannot attach the 1-based sentence
 * to a `.min(0)` field: the two come from the same argument.
 */
import { z } from 'zod';

/**
 * The two bases a playlist position may be numbered from. Deliberately not a
 * per-tool flag: a tool picks its base once, at its schema, and the handler
 * converts exactly where it must.
 */
export type PositionBase = 'zero' | 'one';

/**
 * The one sentence each base is written as, everywhere in the tool surface.
 *
 * Both clauses end identically — "= the first item" — so the reader is told what
 * the *end* of the range looks like and not merely which number starts it.
 * `0` on a 10-item playlist is the first item and `9` the last; `1` and `10` are
 * the same two items, and the gap between the two spellings is the whole
 * failure this module exists to prevent.
 */
const POSITION_BASE_CLAUSE: Record<PositionBase, string> = {
  zero: "0-based index into the playlist's current item order (0 = the first item).",
  one: "1-based position in the playlist's current item order (1 = the first item).",
};

/**
 * The exact clause a position description must carry, for `base`.
 *
 * Exported because two call sites cannot use `positionSchema`: a position
 * nested inside a union arm, and a range that accepts negative indices. Both
 * still owe the reader the same sentence, and the test gate holds them to it.
 */
export function positionBaseClause(base: PositionBase): string {
  return POSITION_BASE_CLAUSE[base];
}

/**
 * The base's lowest legal value. A 1-based position cannot be `0` and a 0-based
 * index cannot be negative, so the floor follows from the base instead of being
 * restated beside it.
 */
const POSITION_BASE_MIN: Record<PositionBase, number> = { zero: 0, one: 1 };

/**
 * Compose a position description: what the number means, any default, then the
 * standard clause.
 *
 * The base clause is appended last and never interpolated, so every position
 * description in the surface ENDS on the same sentence. That is what lets the
 * gate assert `description.endsWith(positionBaseClause(base))` instead of
 * matching a pattern that a reworded description would slip past.
 */
export function positionDesc(what: string, base: PositionBase, defaultValue?: number): string {
  const prefix = defaultValue === undefined ? '' : `Default ${defaultValue}. `;
  return `${what.replace(/\.?\s*$/, '')}. ${prefix}${positionBaseClause(base)}`;
}

export interface PositionSchemaOptions {
  /** Upper bound, when the parameter has one. */
  readonly max?: number;
  /** Omit the parameter to take `defaultValue`. */
  readonly optional?: boolean;
  /**
   * The value applied when the parameter is omitted, when zod is what applies
   * it. Emitted as a real `default` in the JSON schema.
   */
  readonly defaultValue?: number;
  /**
   * The value applied when the parameter is omitted, when the HANDLER is what
   * applies it (`args.position ?? 0`). Same sentence in the description, but no
   * `default` key emitted, because the omission is resolved downstream of the
   * schema and a `default` here would claim the schema does it.
   */
  readonly handlerDefault?: number;
}

/**
 * A zod integer for a playlist position, with its lower bound, its default
 * note and its base sentence all derived from one `base` argument.
 *
 * The description is composed here rather than left to the call site. An
 * earlier draft had the caller chain `.describe(positionDesc(...))` on the
 * result, which silently threw away the default note the helper had just
 * written — a description that can be overwritten after the fact is a
 * description that will be. Compose once, here.
 */
export function positionSchema(
  base: PositionBase,
  what: string,
  opts: PositionSchemaOptions = {},
): z.ZodType<number> {
  const { max, optional, defaultValue, handlerDefault } = opts;
  const documented = defaultValue ?? handlerDefault;
  const described = () => positionDesc(what, base, documented);

  let schema = z.number().int().min(POSITION_BASE_MIN[base]);
  if (max !== undefined) schema = schema.max(max);
  if (defaultValue !== undefined) {
    return schema.default(defaultValue).describe(described()) as z.ZodType<number>;
  }
  if (optional) {
    return schema.optional().describe(described()) as z.ZodType<number>;
  }
  return schema.describe(described()) as z.ZodType<number>;
}
