/**
 * The stats.fm identity example must not name a real account (#1514).
 *
 * ## What leaked, and why the obvious fix is the wrong one
 *
 * `StatsfmUserInputFields` in `src/shaping.ts` describes the `statsfm_user`
 * argument with a worked example. That description is a TOOL SCHEMA, so it
 * compiles into `dist/` and is delivered to every MCP host as schema bytes,
 * permanently, whether or not that host ever calls a stats.fm tool. The
 * example it shipped was a real stats.fm account's handle. Whether that
 * account's owner consented to being a permanent fixture in someone else's
 * published tool contract was never established, and the safe assumption is
 * the one taken here.
 *
 * The handle also appeared in `docs/statsfm.md` and `.env.example`, which
 * assert it as the canonical example. Those are repo-only, but they are what
 * makes the schema text look deliberate rather than accidental, so they moved
 * with it.
 *
 * ## Why this is NOT a `sed` over the repo
 *
 * The same handle appears in three test files as fixture data — 62 lines. A
 * test fixture is not a disclosure: it is never published, never sent to a
 * host, and never read by a user. Renaming those would produce a large,
 * thorough-looking diff that changes nothing a third party can observe, while
 * burying the one line that matters. The fixtures stay.
 *
 * ## The rule is shape, not a name
 *
 * The obvious guard is `assert(!description.includes('martijn'))`, and it is
 * decoration: swap in a different real handle and it passes, having protected
 * nothing. What is actually load-bearing is the SHAPE. Every identifier in
 * this repo's own stats.fm fixtures — `u1`, `alice`, `demo`, `marley` — is a
 * single bare lowercase token, because that is what a stats.fm `customId` and
 * the `<id>` in a `stats.fm/user/<id>` URL look like. A shipped example that
 * is a single bare token is therefore indistinguishable from a real account,
 * and that is the defect. The rule below is exactly that, and it fires on any
 * bare handle, this one or a future one.
 *
 * It is deliberately scoped to the stats.fm identity argument. A repo-wide
 * "no bare token in any `e.g.`" rule would be a different, much broader gate
 * that has nothing to do with #1514 and would collide with legitimate examples
 * like `(e.g. "US")`. Scope creep here would be a rule whose false positives
 * get it switched off.
 *
 * ## The negative case
 *
 * A check that matches nothing is worse than no check, so `assertFires` below
 * drives the SAME collector used against the real registry through synthetic
 * descriptions — one carrying a bare handle (must be reported) and one
 * carrying a self-describing placeholder (must not be). If the collector's
 * pattern is ever weakened into matching nothing, the negative case fails
 * before the real one can pass silently.
 *
 * ## Hermeticity
 *
 * `import './helpers/hermetic.js'` relocates every `~/.spotify-mcp` store
 * under a disposable root, so this file cannot read or write the real tokens,
 * search history or taste feedback. Nothing here performs a network call —
 * `buildFullRegistryServer` registers every module against a stub client — and
 * nothing binds a port.
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildFullRegistryServer } from './live-registry.js';
import { finalInputSchema } from '../src/shaping.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8');

/**
 * A stats.fm `customId` or the `<id>` in a `stats.fm/user/<id>` URL: one bare
 * lowercase alphanumeric token, which is the shape every identifier in this
 * repo's own stats.fm fixtures has. Deliberately not anchored to any
 * particular name — see the header.
 *
 * Anchored to the WHOLE example, not a word inside it. The first draft used
 * `\b[a-z][a-z0-9]*\b` and the negative case below caught it: `\b` matches at
 * a hyphen, so `your-statsfm-handle` reported the `your` and the rule flagged
 * the placeholder it was written to clear. A word boundary is the wrong test
 * for "is this a bare token", because the tokens that make an example
 * self-describing are exactly the separators a bare handle does not have.
 */
const BARE_HANDLE = /^[a-z][a-z0-9]*$/;

/** The worked example out of a `(e.g. "…")` clause, or `undefined` if absent. */
function exampleIn(description: string): string | undefined {
  return /\(e\.g\.\s*"([^"]+)"\)/.exec(description)?.[1];
}

/**
 * A shipped example is a disclosure when it is a bare token, because that is
 * exactly what a real account looks like. Returns the offending examples so
 * the caller can name them rather than just learn that something matched.
 */
function bareExamples(description: string): string[] {
  const example = exampleIn(description);
  if (example === undefined) return [];
  return BARE_HANDLE.test(example) ? [example] : [];
}

/**
 * Every published `statsfm_user` description, keyed by the tool that serves
 * it. Read off the LIVE registry rather than a hand-written list, so a tool
 * that stops declaring the argument drops out and one that starts declaring it
 * is covered without anyone remembering.
 */
async function publishedIdentityDescriptions(): Promise<Map<string, string>> {
  const server = await buildFullRegistryServer();
  const registry = (server as unknown as {
    _registeredTools?: Record<string, { inputSchema?: unknown }>;
  })._registeredTools ?? {};
  const out = new Map<string, string>();
  for (const [name, entry] of Object.entries(registry)) {
    if (!entry.inputSchema) continue;
    const schema = finalInputSchema(entry.inputSchema) as {
      properties?: Record<string, { description?: string }>;
    };
    const description = schema.properties?.statsfm_user?.description;
    if (description) out.set(name, description);
  }
  return out;
}

describe('the published stats.fm identity example names no real account (#1514)', () => {
  it('holds across every tool that declares statsfm_user', async () => {
    const published = await publishedIdentityDescriptions();

    // A zero-length registry would make the assertion below vacuously true,
    // which is the same defect as a collector whose pattern matches nothing.
    // `buildFullRegistryServer` is async (#906 made the manifest hold thunks),
    // so calling it without awaiting yields an empty registry.
    assert.ok(
      published.size >= 30,
      `only ${published.size} tool(s) published a statsfm_user description — the registry is empty or the derivation is wrong`,
    );

    const offenders = [...published].flatMap(([tool, description]) =>
      bareExamples(description).map((example) => `${tool}: ${JSON.stringify(example)}`),
    );
    assert.deepEqual(
      offenders,
      [],
      `these tools ship a bare stats.fm handle as a permanent example: ${offenders.join(', ')}`,
    );
  });

  it('still names the STATSFM_USER_ID default the argument falls back to', async () => {
    // The disclosure fix must not hollow the description out. The reason a
    // host looks past `optional` is that the variable supplies the value, so
    // naming it is what makes the optionality readable rather than alarming.
    const published = await publishedIdentityDescriptions();
    for (const [tool, description] of published) {
      assert.match(
        description,
        /STATSFM_USER_ID/,
        `${tool}: the description must still name the default the argument falls back to`,
      );
    }
  });
});

describe('the check can go red (#1514)', () => {
  it('reports a bare handle and clears a self-describing placeholder', () => {
    // The same collector, driven by hand. If the pattern above is ever widened
    // until it matches everything, the first assertion fails; if it is narrowed
    // until it matches nothing, the second does. Either way this file cannot
    // go green while the real check is inert.
    assert.deepEqual(
      bareExamples('stats.fm user id or customId (e.g. "martijn"). Defaults to STATSFM_USER_ID.'),
      ['martijn'],
      'a bare handle must be reported',
    );
    assert.deepEqual(
      bareExamples('stats.fm user id or customId (e.g. "your-statsfm-handle"). Defaults to STATSFM_USER_ID.'),
      [],
      'a self-describing placeholder must be cleared',
    );
  });
});

describe('the repo-facing surfaces moved with the schema (#1514)', () => {
  it('.env.example does not offer a real handle as the template default', () => {
    // The template is repo-only (`package.json` `files` is `["dist"]`), so this
    // is not a disclosure on its own. It matters because it is what a user
    // copies, and because leaving it would have re-asserted the removed
    // handle as canonical from a second direction.
    const assigned = /^[ \t]*#?[ \t]*STATSFM_USER_ID[ \t]*=[ \t]*(\S*)/m.exec(read('.env.example'));
    assert.ok(assigned, 'STATSFM_USER_ID must still be documented in .env.example');
    assert.deepEqual(
      bareExamples(`e.g. "${assigned[1]}"`),
      [],
      `.env.example offers ${JSON.stringify(assigned[1])} as the stats.fm id template`,
    );
  });

  it('docs/statsfm.md does not present a real handle as the canonical example', () => {
    const examples = [...read('docs/statsfm.md').matchAll(/\(e\.g\.\s*"([^"]+)"\)/g)].map((m) => m[1]!);
    assert.deepEqual(
      examples.flatMap((example) => bareExamples(`e.g. "${example}"`)),
      [],
      'docs/statsfm.md presents a bare handle as a stats.fm id example',
    );
  });
});
