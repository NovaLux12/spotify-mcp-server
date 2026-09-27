/**
 * `src/tools/encoding.ts` — the per-tool encoding plan derived from the same
 * JSON Schema `tools/list` publishes (#694).
 *
 * ## Why this file is worth a direct test when the wire is already covered
 *
 * `tests/encoding-tolerance.test.ts` drives raw JSON-RPC and proves the
 * behaviour end to end. What it cannot see is the DERIVATION: that the plan
 * for a tool is computed from that tool's own published schema, so a schema
 * that declares something new gets an encoding for it, and a schema that
 * declares nothing new does not. Those are separate claims, and this file holds
 * the second one.
 *
 * ## The rule that makes the layer safe
 *
 * **A candidate must prove itself against its own field's schema before it
 * replaces what the caller sent.** So this layer can only ever turn a call that
 * FAILED into one that SUCCEEDS: a value needing no normalisation is not copied
 * at all, an unrecognised shape gets no coercion and degrades to today's
 * behaviour, and a guess that fails goes back unchanged so the field's own
 * validation reports the honest refusal. Most of the tests below are that rule
 * from different angles, and the boolean case is the sharpest: `'false'` is a
 * truthy string in JavaScript, and a `dry_run` read as `true` because a host
 * quoted it is the exact "rejected write reported as applied" shape #830
 * shipped.
 *
 * ## The registry agreement test
 *
 * The last suite registers every module in `REGISTRAR_MANIFEST` and compares
 * each tool's plan against that tool's own `finalInputSchema` projection —
 * hundreds of tools, measured rather than sampled. The SDK is not the oracle
 * there; `finalInputSchema` is the same projection `encodingPlanFor` reads, so
 * the check is "does the plan account for every property the schema declares",
 * recomputed per tool.
 *
 * Run: node --import tsx --test tests/tools.encoding.test.ts
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { encodingPlanFor } from '../src/tools/encoding.js';
import { registerManifestModules } from '../src/tools/annotations.js';
import { finalInputSchema } from '../src/shaping.js';
import { SpotifyClient } from '../src/client.js';

describe('encodingPlanFor — what it will and will not derive from', () => {
  it('has no plan for anything that is not an input schema object', () => {
    for (const value of [null, undefined, 'ids', 7, true, [{ ids: z.array(z.string()) }]]) {
      assert.deepEqual(Object.keys(encodingPlanFor(value)), [], `no plan for ${JSON.stringify(value) ?? String(value)}`);
    }
  });

  it('has no plan for a schema that declares no properties', () => {
    assert.deepEqual(Object.keys(encodingPlanFor({})), []);
  });

  it('builds from the zod raw shape the registry holds, not from arbitrary JSON', () => {
    // The plan is derived from the projection `tools/list` publishes, which is
    // computed FROM the zod object. A hand-written JSON Schema that says the
    // same thing is not what the registry holds, and gets no tolerance — the
    // layer cannot grant something the advertised schema never declared.
    const rawShape = { ids: z.array(z.string()), limit: z.number(), mode: z.enum(['json', 'xml']) };
    assert.deepEqual(Object.keys(encodingPlanFor(rawShape)).sort(), ['ids', 'limit', 'mode']);
    const plainJsonSchema = {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        limit: { type: 'number' },
        mode: { type: 'string', enum: ['json', 'xml'] },
      },
    };
    assert.deepEqual(Object.keys(encodingPlanFor(plainJsonSchema)), []);
  });

  it('gives a brand new declaration an encoding, without touching its neighbours', () => {
    // The forward direction: add a field to a schema and the plan grows with it.
    const before = encodingPlanFor({ limit: z.number() });
    assert.deepEqual(Object.keys(before), ['limit']);
    const after = encodingPlanFor({ limit: z.number(), offsets: z.array(z.string()) });
    assert.deepEqual(Object.keys(after).sort(), ['limit', 'offsets']);
    assert.deepEqual(after.offsets('0,10'), ['0', '10']);
  });

  it('leaves a field the schema does not describe alone', () => {
    // An unrecognised shape degrades to today's behaviour rather than to a
    // guess, which is the whole of the "cannot turn a failure into a different
    // failure" guarantee.
    assert.deepEqual(Object.keys(encodingPlanFor({ obj: z.object({ a: z.string() }) })), []);
    assert.deepEqual(Object.keys(encodingPlanFor({ str: z.string() })), []);
    assert.deepEqual(Object.keys(encodingPlanFor({ bool: z.boolean() })), []);
    // A union is a shape the planner does not understand, so no coercion.
    assert.deepEqual(Object.keys(encodingPlanFor({ u: z.union([z.array(z.string()), z.string()]) })), []);
  });

  it('caches one plan per schema object, and does not share it between equal ones', () => {
    // The registry hands out the same `inputSchema` object for the life of the
    // process, so the plan is built once per tool rather than per call. Two
    // structurally equal but distinct objects are still two plans — the cache
    // is keyed by identity, not by content.
    const shape = { limit: z.number() };
    const twin = { limit: z.number() };
    assert.equal(encodingPlanFor(shape), encodingPlanFor(shape));
    assert.notEqual(encodingPlanFor(shape), encodingPlanFor(twin));
    assert.ok(Object.isFrozen(encodingPlanFor(shape)), 'a plan is not the caller\'s to edit');
  });
});

describe('the array encoding: CSV, a JSON array string, or one bare value', () => {
  const coerce = encodingPlanFor({ ids: z.array(z.string()) }).ids;

  it('reads a CSV string as a list', () => {
    assert.deepEqual(coerce('a,b,c'), ['a', 'b', 'c']);
    assert.deepEqual(coerce(' a , b '), ['a', 'b'], 'each entry is trimmed');
    // Empties are dropped, which is what every hand-rolled split in this repo
    // already did, so `'a,,b'` and `'a,b'` are the same list.
    assert.deepEqual(coerce('a,,b'), ['a', 'b']);
    assert.deepEqual(coerce(''), []);
  });

  it('honours a JSON array string first, so a value with a real comma survives', () => {
    assert.deepEqual(coerce('["a","b"]'), ['a', 'b']);
    assert.deepEqual(coerce('["Tyler, The Creator"]'), ['Tyler, The Creator'], 'the whole point of the escape hatch');
  });

  it('falls through to the split when the value merely STARTS with a bracket', () => {
    // `[not json]` is a value, not a parse failure.
    assert.deepEqual(coerce('[not json]'), ['[not json]']);
  });

  it('accepts one bare value as a one-entry list', () => {
    assert.deepEqual(coerce('a'), ['a']);
  });

  it('passes a value that is already the declared type through untouched', () => {
    // It needs no normalisation, so it is not copied into the result at all.
    const real = ['x', 'y'];
    assert.equal(coerce(real), real);
    assert.equal(coerce(7), 7);
    assert.equal(coerce(null), null);
  });

  it('never applies the item type, so a mistyped entry still fails the field', () => {
    // The list coercion normalises the SHAPE, not the contents. A CSV into a
    // number list produces strings, which the field's own validation then
    // refuses — the refusal names the real problem instead of the layer
    // inventing numbers the caller never sent.
    const numbers = encodingPlanFor({ values: z.array(z.number()) }).values;
    assert.deepEqual(numbers('1,2,3'), ['1', '2', '3']);
    assert.equal(z.object({ values: z.array(z.number()) }).safeParse({ values: numbers('1,2,3') }).success, false);
    assert.equal(z.object({ values: z.array(z.number()) }).safeParse({ values: numbers([1, 2, 3]) }).success, true);
  });

  it('cannot smuggle a longer list past a bound the array form enforces', () => {
    // The CSV form normalises BEFORE the bound, so an over-long list splits,
    // fails the field's own max, and is discarded — and the refusal the caller
    // gets is the array form's `max`, not a bare "expected an array".
    const shape = { ids: z.array(z.string()).min(1).max(3) };
    const split = encodingPlanFor(shape).ids('a,b,c,d');
    assert.deepEqual(split, ['a', 'b', 'c', 'd'], 'the CSV split to every entry');
    const over = z.object(shape).safeParse({ ids: split });
    const refusal = over.success ? undefined : over.error?.issues[0]?.message;
    assert.notEqual(refusal, undefined, 'a four-entry list must not pass a max(3) field');
    assert.match(String(refusal), /<=3 items/, 'the bound is the refusal, not the type');
    // The same shape with a legal count still works, so the test is not just
    // proving that everything is refused.
    assert.equal(z.object(shape).safeParse({ ids: encodingPlanFor(shape).ids('a,b') }).success, true);
  });
});

describe('the number encoding: a strict numeric string, and nothing else', () => {
  const coerce = encodingPlanFor({ limit: z.number() }).limit;
  const coerceInt = encodingPlanFor({ count: z.number().int() }).count;

  it('converts the numeric literals a host might stringify', () => {
    assert.equal(coerce('20'), 20);
    assert.equal(coerce(' 20 '), 20, 'surrounding whitespace is trimmed');
    assert.equal(coerce('-3'), -3);
    assert.equal(coerce('+4'), 4);
    assert.equal(coerce('1e3'), 1000);
    assert.equal(coerce('.5'), 0.5);
    assert.equal(coerce('1.'), 1);
  });

  it('refuses the three shapes `Number()` would have taken', () => {
    // `Number()` gives 0 for '', 16 for '0x10' and Infinity for 'Infinity'. The
    // first is a coercion of nothing into a number; the other two are values no
    // caller meant. All three go back unchanged so the field reports the truth.
    assert.equal(coerce(''), '');
    assert.equal(coerce('  '), '  ');
    assert.equal(coerce('0x10'), '0x10');
    assert.equal(coerce('Infinity'), 'Infinity');
    assert.notEqual(coerce('NaN'), Number.NaN, 'NaN is not a numeric literal either');
  });

  it('refuses a string with anything else in it', () => {
    for (const value of ['abc', '1,000', '1 2', '1e', '--3', '20abc', '1.2.3']) {
      assert.equal(coerce(value), value, `${value} must go back unchanged`);
    }
  });

  it('leaves a value that is already a number alone, integer bounds included', () => {
    const already = 20;
    assert.equal(coerce(already), already);
    assert.equal(coerceInt('5'), 5);
    assert.equal(z.object({ count: z.number().int() }).safeParse({ count: coerceInt('2.5') }).success, false);
  });
});

describe('the enum encoding: a case variant maps to the canonical member', () => {
  const coerce = encodingPlanFor({ mode: z.enum(['json', 'xml']) }).mode;

  it('folds a case variant onto the member', () => {
    assert.equal(coerce('JSON'), 'json');
    assert.equal(coerce('Xml'), 'xml');
    assert.equal(coerce('jSoN'), 'json');
  });

  it('leaves a canonical member and a non-member exactly as sent', () => {
    // An unrecognised value is left verbatim so the field's own validation
    // enumerates every legal member, rather than reporting one the caller
    // never sent.
    assert.equal(coerce('json'), 'json');
    assert.equal(coerce('mp3'), 'mp3');
    assert.equal(coerce(''), '');
    // Unlike the list and number encodings, this one does not trim: an
    // untrimmed value is not a member, so it is left for the field to refuse.
    assert.equal(coerce(' JSON '), ' JSON ');
  });

  it('gives up on an enum whose members differ only by case', () => {
    // `["a","A"]` has two members that fold onto one key, so "A" is not a case
    // variant of anything — it IS a member, and folding could pick the other.
    // Dropping the key beats guessing.
    assert.deepEqual(Object.keys(encodingPlanFor({ m: z.enum(['a', 'A']) })), []);
  });

  it('reads the ITEM enum for a list, not the property one', () => {
    // An array property that also carries an `enum` is still a list, and its
    // members are governed by the items.
    const items = encodingPlanFor({ modes: z.array(z.enum(['json', 'xml'])) }).modes;
    assert.deepEqual(items('JSON,xml'), ['json', 'xml']);
    assert.deepEqual(items('JSON,mp3'), ['json', 'mp3'], 'an undeclared member is left alone');
    const propertyEnum = encodingPlanFor({ modes: z.enum(['json', 'xml']).array() }).modes;
    assert.deepEqual(propertyEnum('JSON'), ['json']);
  });
});

describe('the declarations that change the answer', () => {
  it('still coerces an optional or defaulted field, and not a nullable one', () => {
    // `optional()` erases to a plain `type: array` in the published schema, so
    // it coerces. `nullable()` publishes an `anyOf`, which is a shape the
    // planner does not understand, so it does not — and the caller's failure is
    // reported honestly rather than half-guessed.
    assert.deepEqual(Object.keys(encodingPlanFor({ a: z.array(z.string()).optional() })), ['a']);
    assert.deepEqual(Object.keys(encodingPlanFor({ a: z.array(z.string()).default([]) })), ['a']);
    assert.deepEqual(Object.keys(encodingPlanFor({ n: z.number().default(5) })), ['n']);
    assert.deepEqual(Object.keys(encodingPlanFor({ a: z.array(z.string()).nullable() })), []);
  });

  it('never coerces a boolean, which is the #830 rule', () => {
    // `'false'` is a truthy string in JavaScript. A `dry_run` that read as
    // `true` because a host quoted it is a rejected write reported as applied.
    const shape = { dry_run: z.boolean() };
    assert.deepEqual(Object.keys(encodingPlanFor(shape)), []);
    assert.equal(encodingPlanFor(shape).dry_run, undefined);
  });
});

describe('the plan agrees with what the registry actually publishes', async () => {
  // Every module in the manifest, registered for real. No network, no token:
  // registration is local and nothing here calls a tool.
  const server = new McpServer({ name: 'encoding-plan-audit', version: '0.0.0' });
  await registerManifestModules(server, new SpotifyClient(), {
    readOnly: false,
    disableOverrides: new Set<string>(),
    isModuleActive: () => true,
    scopeBlocked: () => false,
  });
  const registry = (server as unknown as { _registeredTools: Record<string, { inputSchema: unknown }> })._registeredTools;
  const tools = Object.entries(registry);
  assert.ok(tools.length > 0, 'the audit must not pass on an empty registry');

  it('has a coercion for every array, number, integer and string-enum property', () => {
    // The forward direction, measured over the whole surface rather than
    // sampled: nothing a schema declares is silently left without tolerance.
    const gaps: string[] = [];
    for (const [tool, entry] of tools) {
      const properties = (finalInputSchema(entry.inputSchema).properties ?? {}) as Record<string, Record<string, unknown>>;
      const plan = encodingPlanFor(entry.inputSchema);
      for (const [name, property] of Object.entries(properties)) {
        const types = Array.isArray(property.type) ? property.type : typeof property.type === 'string' ? [property.type] : [];
        const isStringEnum = Array.isArray(property.enum) && property.enum.length > 0 && property.enum.every((v) => typeof v === 'string');
        const coercible = types.includes('array') || types.includes('number') || types.includes('integer') || isStringEnum;
        if (coercible && !Object.hasOwn(plan, name)) gaps.push(`${tool}.${name}`);
      }
    }
    assert.deepEqual(gaps, [], 'these declared properties have no encoding');
  });

  it('has no coercion for a property the published schema does not declare', () => {
    // The other direction. A plan key the schema does not justify would be
    // tolerance granted against the advertised contract, which is the one
    // thing the layer must never do.
    const extras: string[] = [];
    for (const [tool, entry] of tools) {
      const properties = (finalInputSchema(entry.inputSchema).properties ?? {}) as Record<string, unknown>;
      for (const name of Object.keys(encodingPlanFor(entry.inputSchema))) {
        if (!Object.hasOwn(properties, name)) extras.push(`${tool}.${name}`);
      }
    }
    assert.deepEqual(extras, []);
  });

  it('has no coercion for a single boolean anywhere on the surface', () => {
    // The #830 rule at scale. A boolean is the one declared type the layer
    // refuses to touch, and the count of booleans across the registry is large
    // enough that one careless `default:` branch in the planner would show.
    const coerced: string[] = [];
    let booleanProperties = 0;
    for (const [tool, entry] of tools) {
      const properties = (finalInputSchema(entry.inputSchema).properties ?? {}) as Record<string, Record<string, unknown>>;
      const plan = encodingPlanFor(entry.inputSchema);
      for (const [name, property] of Object.entries(properties)) {
        const types = Array.isArray(property.type) ? property.type : typeof property.type === 'string' ? [property.type] : [];
        if (!types.includes('boolean')) continue;
        booleanProperties++;
        if (Object.hasOwn(plan, name)) coerced.push(`${tool}.${name}`);
      }
    }
    assert.ok(booleanProperties > 0, 'the surface must actually declare booleans for this to mean anything');
    assert.deepEqual(coerced, []);
  });

  it('is frozen, and the same object, for a tool it has already seen', () => {
    // The registry hands out one `inputSchema` object per tool for the life of
    // the process, so the plan must be built once and not per call.
    const [, first] = tools[0]!;
    const plan = encodingPlanFor(first.inputSchema);
    assert.ok(Object.isFrozen(plan));
    assert.equal(encodingPlanFor(first.inputSchema), plan);
  });
});
