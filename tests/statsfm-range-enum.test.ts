/**
 * stats.fm range vocabulary guard (#720).
 *
 * `range` is forwarded verbatim to the stats.fm `range` query parameter, so the
 * zod enum IS the contract with upstream — there is no mapping layer to absorb a
 * wrong value. Probed live 2026-09-26 against
 * `GET /users/{id}/top/artists?range=…`:
 *
 *   weeks     -> 200   months    -> 200   lifetime -> 200
 *   week      -> 400 {"message":"invalid range"}
 *   month     -> 400 {"message":"invalid range"}
 *   6months   -> 400    year     -> 400    all-time -> 400
 *
 * Three modules each kept a private `rangeSchema`. The endpoint tools got it
 * right; the two taste modules advertised `week`/`month`, so every documented
 * call using them failed upstream with 400. Because `range` is optional and
 * defaults to `lifetime`, the failure was also easy to miss.
 *
 * The expected values below are written out literally rather than imported
 * from the source. A test that recomputes its expectation from the enum it is
 * checking passes whatever the enum becomes, which is how "week"/"month"
 * survived in the first place. These are the literals upstream answers 200 to.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerStatsfmTools } from '../src/tools/statsfm.js';
import { registerStatsfmTasteTools } from '../src/tools/statsfm_taste.js';
import { registerTasteCompositeTools } from '../src/tools/taste_composites.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Verified 200 upstream on 2026-09-26. */
const ACCEPTED = ['weeks', 'months', 'lifetime'];
/** Verified 400 `invalid range` upstream on 2026-09-26. */
const REJECTED = ['week', 'month', '6months', 'year', 'all-time', 'today'];

type RangeParam = {
  safeParse(value: unknown): { success: boolean };
  description?: string;
};

type RegisteredTool = {
  name: string;
  description: string;
  schema: Record<string, RangeParam>;
};

function collectRangeTools(): RegisteredTool[] {
  const registered: RegisteredTool[] = [];
  const server = {
    tool: (name: string, description: string, schema: RegisteredTool['schema']) => {
      registered.push({ name, description, schema });
    },
  };
  const asServer = server as unknown as Parameters<typeof registerStatsfmTools>[0];
  // Pass the stub explicitly, as the two registrars below already do. Omitting
  // it takes the `= new StatsfmClient()` default, which builds a client wired to
  // the real api.stats.fm — unused by this schema-only scan, but exactly the
  // live-client-in-a-test that #666's guard exists to keep out.
  registerStatsfmTools(asServer, {} as Parameters<typeof registerStatsfmTools>[1]);
  registerStatsfmTasteTools(asServer, {} as Parameters<typeof registerStatsfmTasteTools>[1]);
  registerTasteCompositeTools(asServer, {} as Parameters<typeof registerTasteCompositeTools>[1]);
  return registered.filter((tool) => tool.schema.range);
}

const RANGE_TOOLS = collectRangeTools();

test('the range-bearing surface is actually exercised', () => {
  // If a module stops registering a range tool this file would pass vacuously.
  assert.ok(
    RANGE_TOOLS.length >= 11,
    `expected the endpoint, taste, and composite range tools to be registered, saw ${RANGE_TOOLS.length}`,
  );
});

test('every range tool accepts exactly the values stats.fm accepts', () => {
  for (const tool of RANGE_TOOLS) {
    for (const value of ACCEPTED) {
      assert.equal(
        tool.schema.range.safeParse(value).success,
        true,
        `${tool.name} must accept range "${value}" (stats.fm answers 200)`,
      );
    }
  }
});

test('every range tool rejects the values stats.fm answers 400 for', () => {
  for (const tool of RANGE_TOOLS) {
    for (const value of REJECTED) {
      assert.equal(
        tool.schema.range.safeParse(value).success,
        false,
        `${tool.name} must reject range "${value}" — stats.fm answers 400 invalid range, so accepting it only defers the failure to the network`,
      );
    }
  }
});

test('range stays optional with a lifetime default', () => {
  for (const tool of RANGE_TOOLS) {
    assert.equal(
      tool.schema.range.safeParse(undefined).success,
      true,
      `${tool.name} must keep range optional`,
    );
  }
});

test('the parameter description names the accepted values', () => {
  // An enum the caller can only see by inspecting the schema is the gap #720
  // opened: a model picking a literal has nothing to pick from. This is the
  // *parameter* description, which is what a host surfaces next to the input.
  for (const tool of RANGE_TOOLS) {
    const description = tool.schema.range.description ?? '';
    for (const value of ACCEPTED) {
      assert.match(
        description,
        new RegExp(value),
        `${tool.name} range parameter description must name the accepted value "${value}"`,
      );
    }
  }
});

test('one shared range schema, not a private copy per module', () => {
  // The taste modules used to declare their own enum. If a second literal
  // reappears, the two vocabularies can drift again.
  for (const file of ['src/tools/statsfm_taste.ts', 'src/tools/taste_composites.ts']) {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(
      source,
      /z\s*\.\s*enum\(\s*\[[^\]]*['"](?:week|month)['"]/,
      `${file} must not declare its own range enum; import statsfmRangeSchema from ./statsfm.js`,
    );
  }
  const canonical = readFileSync(path.join(ROOT, 'src/tools/statsfm.ts'), 'utf8');
  assert.match(canonical, /export const statsfmRangeSchema/, 'the shared schema must be exported');
  assert.match(canonical, /export const STATSFM_RANGES/, 'the shared vocabulary must be exported');
});

test('the documented range values are all values the enum accepts', () => {
  // The Ranges section is the reference for the whole stats.fm surface, so a
  // literal there that upstream rejects misinforms every reader of it.
  // `year` is excluded from the prose candidates: `statsfm_recaps` really does
  // take a calendar `year`, so a correct sentence about that parameter must not
  // be read as a claim about the range enum.
  const candidates = new Set([
    ...ACCEPTED, ...REJECTED.filter((value) => value !== 'year'),
    'day', 'days', '6month', 'all_time', 'alltime',
  ]);
  for (const file of ['docs/statsfm.md', 'docs/taste.md']) {
    const lines = readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      if (!/\brange\b/i.test(line)) continue;
      // A line saying a value is rejected is explaining, not documenting it.
      if (/\b400\b|\brejects?\b|rejected\b|not\s+accepted|\binvalid\b/i.test(line)) continue;
      for (const match of line.matchAll(/`([^`\n]+)`/g)) {
        const literal = match[1].trim().toLowerCase();
        if (!candidates.has(literal)) continue;
        assert.equal(
          ACCEPTED.includes(literal),
          true,
          `${file}:${index + 1} documents range \`${match[1]}\`, which stats.fm does not accept`,
        );
      }
    }
  }
});
