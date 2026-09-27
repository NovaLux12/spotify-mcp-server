/**
 * One scope vocabulary, one list of defaults (#618).
 *
 * ## What drifted
 *
 * `src/auth.ts` and `src/config.ts` each held a hand-maintained copy of the 17
 * default scopes, and each derived a "known scopes" set from its own copy.
 * They were equal the day the audit ran and nothing enforced it. The failure
 * mode is nasty in both directions:
 *
 *  - a scope added to config's list is accepted by `SPOTIFY_SCOPES` at startup
 *    and rejected by `auth --scopes`, so the server refuses to start for a
 *    scope the auth flow would have consented to;
 *  - a scope removed from one side is still requested at auth and then rejected
 *    at config load, with an error naming the OTHER file.
 *
 * Either way the operator sees a config error caused by an edit that has
 * nothing to do with config, which is how a one-line vocabulary change gets
 * debugged as a deployment problem.
 *
 * ## What this asserts
 *
 * Both parsers accept exactly the same vocabulary, the defaults are the same
 * list, and no second copy of either can be reintroduced. The vocabulary is
 * also cross-checked against the two places that restate it in prose (SPEC.md
 * and the module-gating table), because a "single source" that leaves copies
 * behind in documentation is not one.
 */

import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SCOPES,
  KNOWN_SPOTIFY_SCOPES,
  SCOPE_PROFILE_NAMES,
  isKnownScope,
  isReadScope,
  parseScopes,
  scopesForProfile,
} from '../src/config.ts';
import { parseScopesString, resolveScopes } from '../src/auth.ts';
import { WRITE_SCOPE_REQUIREMENTS } from '../src/scopefilter.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

/** The opt-in scopes: valid to request, never requested by default. */
const OPT_IN = ['app-remote-control', 'streaming'] as const;

describe('the scope vocabulary has one definition (#618)', () => {
  it('derives the known set from the profiles rather than restating it', () => {
    // KNOWN must be every scope any profile grants, plus the opt-ins that no
    // profile carries. Asserting the relationship instead of the literal list
    // is what makes it structural: a scope added to a group and forgotten
    // elsewhere fails here rather than at a consent screen.
    const derived = new Set<string>();
    for (const name of SCOPE_PROFILE_NAMES) {
      for (const scope of scopesForProfile(name)) derived.add(scope);
    }
    for (const optIn of OPT_IN) derived.add(optIn);
    assert.deepEqual(
      [...KNOWN_SPOTIFY_SCOPES].sort(),
      [...derived].sort(),
      'KNOWN_SPOTIFY_SCOPES is not the union of the profiles plus the opt-in scopes',
    );
  });

  it('keeps the default grant free of duplicates and of opt-in scopes', () => {
    assert.equal(
      new Set(DEFAULT_SCOPES).size,
      DEFAULT_SCOPES.length,
      'DEFAULT_SCOPES repeats a scope — the consent prompt would ask twice',
    );
    for (const optIn of OPT_IN) {
      assert.ok(
        !DEFAULT_SCOPES.includes(optIn as (typeof DEFAULT_SCOPES)[number]),
        `${optIn} must be opt-in, not part of the standing grant`,
      );
    }
  });

  it('holds the default grant to the minimum (AGENTS.md §1, #700)', () => {
    // The rule this file exists to enforce was never enforced anywhere. Named
    // literally so the assertion cannot be satisfied by the profile table
    // agreeing with itself: a default that grew a mutation scope would have to
    // grow it in BOTH the group and this list to pass.
    assert.equal(
      DEFAULT_SCOPES.filter((scope) => !isReadScope(scope)).join(' '),
      'user-modify-playback-state',
      'the standing grant requests something other than reads plus playback control',
    );
  });

  it('makes every known scope pass the type guard, and nothing else', () => {
    for (const scope of KNOWN_SPOTIFY_SCOPES) {
      assert.equal(isKnownScope(scope), true, `${scope} is known but the guard rejects it`);
    }
    for (const bogus of ['not-a-scope', 'USER-READ-PRIVATE', 'user_read_private', '']) {
      assert.equal(isKnownScope(bogus), false, `${JSON.stringify(bogus)} was accepted`);
    }
  });
});

describe('both parsers accept exactly the same vocabulary (#618 acceptance)', () => {
  it('accepts every known scope in both auth --scopes and SPOTIFY_SCOPES', () => {
    for (const scope of KNOWN_SPOTIFY_SCOPES) {
      assert.deepEqual(
        parseScopesString(scope),
        [scope],
        `auth --scopes rejected a known scope: ${scope}`,
      );
      assert.deepEqual(
        parseScopes(scope),
        [scope],
        `SPOTIFY_SCOPES rejected a known scope: ${scope}`,
      );
    }
  });

  it('rejects the same unknown scopes in both, naming the value', () => {
    for (const bogus of ['not-a-scope', 'user_read_private', 'user-read-privatee']) {
      assert.throws(
        () => parseScopesString(bogus),
        new RegExp(bogus.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `auth --scopes should have rejected ${bogus}`,
      );
      assert.throws(
        () => parseScopes(bogus),
        new RegExp(bogus.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `SPOTIFY_SCOPES should have rejected ${bogus}`,
      );
    }
  });

  it('gives the auth flow exactly the documented default grant', () => {
    // The default grant is what a user is CONSENTED to when they set no
    // override, so the string the token request carries must be the `core`
    // profile, spelled out here rather than read back from config.ts — the
    // old form of this assertion compared DEFAULT_SCOPES against a string
    // built from DEFAULT_SCOPES, which passes whatever config.ts says.
    assert.deepEqual(resolveScopes(undefined, undefined).split(' ').sort(), [
      'playlist-read-collaborative',
      'playlist-read-private',
      'user-follow-read',
      'user-library-read',
      'user-modify-playback-state',
      'user-read-currently-playing',
      'user-read-playback-position',
      'user-read-playback-state',
      'user-read-private',
      'user-read-recently-played',
      'user-top-read',
    ]);
  });
});

describe('the restatements of the vocabulary are checked, not trusted (#618)', () => {
  it('agrees with the module-gating table that decides which tools are hidden', () => {
    // WRITE_SCOPE_REQUIREMENTS is keyed by the same vocabulary. A typo there
    // would hide a write module for a scope nobody holds — or, worse, keep it
    // visible — and the type only catches it at build time, so assert the
    // values are real scopes as well.
    for (const [module, required] of Object.entries(WRITE_SCOPE_REQUIREMENTS)) {
      assert.ok(required.length > 0, `${module} has an empty requirement list — it would never be blocked`);
      for (const scope of required) {
        assert.ok(
          KNOWN_SPOTIFY_SCOPES.has(scope),
          `${module} requires "${scope}", which is not in the scope vocabulary`,
        );
      }
    }
  });

  it('agrees with the scope list SPEC.md publishes', () => {
    // SPEC.md restates the defaults in a fenced block. The two are written by
    // hand on purpose — SPEC is the contract a reader checks by eye — so the
    // relationship is asserted instead. Order is deliberately NOT compared:
    // SPEC groups them differently and the order carries no meaning.
    const spec = read('SPEC.md');
    const block = spec.match(/Default .core. requests these \d+ scopes:\s*\n+```\n([\s\S]*?)```/);
    assert.ok(block, 'SPEC.md lost its default-profile scope block');
    const documented = (block[1] ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    assert.deepEqual(
      [...documented].sort(),
      [...DEFAULT_SCOPES].sort(),
      'the scopes SPEC.md publishes differ from DEFAULT_SCOPES — one of them is stale',
    );
  });

  it('scans a real surface (a stale parse would make the SPEC check vacuous)', () => {
    const documented = (read('SPEC.md').match(/Default .core. requests these \d+ scopes:\s*\n+```\n([\s\S]*?)```/)?.[1] ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    assert.equal(documented.length, DEFAULT_SCOPES.length, `parsed ${documented.length} scopes from SPEC.md, expected ${DEFAULT_SCOPES.length}`);
    assert.ok(
      KNOWN_SPOTIFY_SCOPES.size >= 19,
      `the vocabulary holds only ${KNOWN_SPOTIFY_SCOPES.size} scopes — the derivation looks wrong`,
    );
    assert.ok(
      Object.keys(WRITE_SCOPE_REQUIREMENTS).length >= 4,
      'the gating table looks empty — the vocabulary check above would pass vacuously',
    );
  });
});

describe('no second copy of the vocabulary can come back (#618 acceptance)', () => {
  it('finds no scope list declared outside config.ts', () => {
    // The issue's acceptance criterion, as an executable check. A re-introduced
    // `DEFAULT_SCOPES_LIST` in auth.ts is the exact regression this guards.
    const offenders: string[] = [];
    for (const rel of ['src/auth.ts', 'src/config.ts', 'src/scopefilter.ts', 'src/index.ts']) {
      const text = read(rel);
      for (const match of text.matchAll(/\b(DEFAULT_SCOPES_LIST|KNOWN_SCOPES|DEFAULT_SCOPE_LIST)\b/g)) {
        offenders.push(`${rel}: ${match[0]}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'a second scope list was declared: ' + offenders.join(', ')
        + '. config.ts owns the vocabulary; every other module imports it.',
    );
  });

  it('keeps the auth flow importing rather than redeclaring', () => {
    // Asserted positively as well: the check above passes if auth.ts is deleted
    // entirely, which would be a different bug with the same empty result.
    const auth = read('src/auth.ts');
    assert.match(
      auth,
      /from '\.\/config\.js'/,
      'src/auth.ts no longer imports config.js — the scope vocabulary is not shared',
    );
    // No scope NAME may be written out in auth.ts, in any form. Checking for
    // one representative literal would let `const COPY = [...SCOPE_DEFAULTS]`
    // back in — a re-bind that diverges the moment either side is edited.
    const literals = [...KNOWN_SPOTIFY_SCOPES].filter((scope) =>
      new RegExp(`['"\`]${scope}['"\`]`).test(auth),
    );
    assert.deepEqual(
      literals,
      [],
      'src/auth.ts writes out scope names again: ' + literals.join(', ')
        + '. Import KNOWN_SPOTIFY_SCOPES / DEFAULT_SCOPES instead.',
    );
    assert.ok(
      !/\[\s*\.\.\.\s*SCOPE_DEFAULTS\s*\]/.test(auth),
      'src/auth.ts copies the imported defaults into a local array — that copy is what drifts',
    );
  });
});
