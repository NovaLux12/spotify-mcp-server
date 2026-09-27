/**
 * #694 — one encoding contract for host-native argument encodings.
 *
 * ## What this is for
 *
 * The server used to accept exactly the encoding its JSON Schema advertised, and
 * a host that flattens a multi-select into a CSV string, stringifies a number,
 * or upper-cases an enum label got a `-32602` that read as a server bug. The
 * retry cost real quota, and because the tolerance that existed was hand-rolled
 * per tool (`following.ts`, `boundedPlaylistArray`, `playlist_fill_from_search`
 * each carried their own split), an agent could not learn the rule from one
 * failure and apply it to the next call.
 *
 * So the rule is stated once, here, and derived per tool from the SAME JSON
 * Schema the host read out of `tools/list`. Three encodings are accepted:
 *
 *  - **array ← string.** A CSV string (`"a,b,c"`), a JSON array string
 *    (`'["a","b"]'`), or one bare value (`"a"`) all become the list the schema
 *    declares. The JSON form is the escape hatch: a single value that really
 *    does contain a comma is expressible as `'["Tyler, The Creator"]'`, so
 *    splitting never takes a value away.
 *  - **number/integer ← string.** `'20'` becomes `20`. Only a strict numeric
 *    literal — see {@link NUMERIC} — so `''` stays a rejection instead of
 *    becoming `0`.
 *  - **enum ← string.** Matched case-insensitively and mapped to the canonical
 *    member, so `'JSON'` is `json`. A value that is not a member at all is
 *    left alone and the boundary's own refusal — which enumerates every legal
 *    member — is what the caller sees.
 *
 * Booleans are deliberately NOT coerced. `'false'` is a truthy string in
 * JavaScript, and a `dry_run` that reads as `true` because a host quoted it is
 * the exact "rejected write reported as applied" shape #830 shipped. A host
 * that can express JSON can express `false`.
 *
 * ## The rule that makes this safe
 *
 * **A candidate must prove itself against its own field's schema before it
 * replaces what the caller sent.** Splitting is a guess about a list, and a
 * guess that fails must cost the caller nothing: the raw value goes back
 * unchanged and the boundary reports the honest refusal, naming the parameter
 * and what it expected. So this layer can only ever turn a call that FAILED
 * into a call that SUCCEEDS. It can never turn a call that failed into a
 * different failure, and it never touches a call that already worked — a value
 * that needs no normalisation is not copied into the result at all.
 *
 * That is also why the bounds survive. `ids` is `min(1) max(50)`; a 51-entry CSV
 * splits to 51 entries, fails the field's own max, and is discarded — the caller
 * gets the `max 50 per call` refusal the array form gives, not a bare
 * `expected an array`. The CSV form normalises BEFORE the bound, so it cannot
 * smuggle a longer list past a limit the array form enforces.
 *
 * ## Why the JSON Schema and not the zod object
 *
 * The plan is built from {@link finalInputSchema} — the projection
 * `tools/list` already publishes. That is deliberate: tolerance granted by a
 * second reading of the zod object could accept something the advertised schema
 * forbids, and then the two would disagree. A property this planner does not
 * understand (an object, a `oneOf`, an absent `type`) simply gets no coercion,
 * so an unrecognised shape degrades to today's behaviour rather than to a
 * guess.
 */
import { finalInputSchema } from '../shaping.js';

/**
 * A strict numeric literal. `Number()` would accept `''` as `0`, `'0x10'` as
 * `16` and `'Infinity'` as `Infinity`; the first is a coercion of "nothing" into
 * a number and the last two are values no caller meant. This is the only shape
 * that becomes a number here.
 */
const NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * A candidate value for one field, or `undefined` for "this field needs no
 * normalisation" — which is also the answer for a value this planner does not
 * understand, so an unrecognised shape degrades to today's behaviour.
 */
export type EncodingCoercion = (value: unknown) => unknown;

/** Per-field coercions for one tool or prompt, keyed by parameter name. */
export type EncodingPlan = Readonly<Record<string, EncodingCoercion>>;

/**
 * One plan per schema object. The registry hands out the same `inputSchema`
 * object for the life of the process, so this is built once per tool rather
 * than per call, and `tools/call` pays a property walk and nothing else.
 */
const PLANS = new WeakMap<object, EncodingPlan>();

const NO_PLAN: EncodingPlan = Object.freeze({});

/**
 * The encoding plan for one input schema, or an empty plan for a schema that
 * declares none. A tool with no arguments has nothing to tolerate.
 */
export function encodingPlanFor(inputSchema: unknown): EncodingPlan {
  if (inputSchema === null || typeof inputSchema !== 'object') return NO_PLAN;
  const key = inputSchema as object;
  const cached = PLANS.get(key);
  if (cached) return cached;
  const plan = buildPlan(key);
  PLANS.set(key, plan);
  return plan;
}

/** Read the published properties and derive one coercion per readable field. */
function buildPlan(schema: object): EncodingPlan {
  const published = finalInputSchema(schema);
  const properties = published.properties;
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return NO_PLAN;
  const plan: Record<string, EncodingCoercion> = {};
  for (const [name, property] of Object.entries(properties as Record<string, unknown>)) {
    const coercion = coercionFor(property);
    if (coercion) plan[name] = coercion;
  }
  return Object.freeze(plan);
}

/** The declared `type`, whether it is one name or a list of them. */
function declaredTypes(property: Record<string, unknown>): readonly string[] {
  const type = property.type;
  if (typeof type === 'string') return [type];
  if (Array.isArray(type)) return type.filter((entry): entry is string => typeof entry === 'string');
  return [];
}

/** `enum` as string members, or `undefined` when it is not a string enum. */
function stringEnum(property: Record<string, unknown>): readonly string[] | undefined {
  const values = property.enum;
  if (!Array.isArray(values) || values.length === 0) return undefined;
  return values.every((value): value is string => typeof value === 'string') ? values : undefined;
}

/**
 * A lowercase → canonical member lookup, or `undefined` when folding would be
 * ambiguous. `enum: ["a", "A"]` has two members that differ only by case, so
 * `"A"` is not a case variant of anything — it is a member, and folding it
 * could pick the other one. Those keys are dropped rather than guessed.
 */
function caseFoldMap(members: readonly string[]): Map<string, string> | undefined {
  const map = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const member of members) {
    const key = member.toLowerCase();
    const seen = map.get(key);
    if (seen !== undefined && seen !== member) ambiguous.add(key);
    else map.set(key, member);
  }
  for (const key of ambiguous) map.delete(key);
  return map.size > 0 ? map : undefined;
}

/** The coercion for one published property, or `undefined` if it has none. */
function coercionFor(property: unknown): EncodingCoercion | undefined {
  if (property === null || typeof property !== 'object' || Array.isArray(property)) return undefined;
  const record = property as Record<string, unknown>;
  const types = declaredTypes(record);
  const members = stringEnum(record);

  // A list first: an array property that also carries an `enum` is still a
  // list, and its members are governed by the ITEM enum, not the property one.
  if (types.includes('array')) return listCoercion(record.items, members);
  if (types.includes('number') || types.includes('integer')) return numberCoercion();
  if (members) return enumCoercion(members);
  return undefined;
}

/** CSV / JSON array / single bare value → the declared list. */
function listCoercion(items: unknown, propertyMembers: readonly string[] | undefined): EncodingCoercion {
  const itemRecord = items !== null && typeof items === 'object' && !Array.isArray(items)
    ? items as Record<string, unknown>
    : undefined;
  const itemMembers = itemRecord ? stringEnum(itemRecord) ?? propertyMembers : propertyMembers;
  const fold = itemMembers ? caseFoldMap(itemMembers) : undefined;
  return (value) => {
    if (typeof value !== 'string') return value;
    const list = toList(value);
    if (list === undefined) return value;
    // Only a member the schema declares is rewritten. An unrecognised one is
    // left verbatim so the field's own validation names every legal member
    // rather than reporting a value the caller never sent.
    return fold ? list.map((entry) => (typeof entry === 'string' ? fold.get(entry.toLowerCase()) ?? entry : entry)) : list;
  };
}

/**
 * A string that names a list. A JSON array string is honoured first and falls
 * through to the CSV split when it does not parse, so `[not json]` is still
 * one value rather than a failure. Empties are dropped, which makes `'a,,b'`
 * and `'a,b'` the same list — the same rule every hand-rolled split in this
 * repo already applied.
 */
function toList(value: string): unknown[] | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Not JSON after all. Fall through to the split: a value that merely
      // starts with `[` is still a value.
    }
  }
  return trimmed.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
}

/** A strict numeric string → the number. Anything else is left alone. */
function numberCoercion(): EncodingCoercion {
  return (value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!NUMERIC.test(trimmed)) return value;
    return Number(trimmed);
  };
}

/** A case variant → the canonical member. A real member is left alone. */
function enumCoercion(members: readonly string[]): EncodingCoercion | undefined {
  const fold = caseFoldMap(members);
  if (!fold) return undefined;
  return (value) => {
    if (typeof value !== 'string' || members.includes(value)) return value;
    return fold.get(value.toLowerCase()) ?? value;
  };
}
