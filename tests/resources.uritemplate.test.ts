/**
 * `Rfc6570UriTemplate` — the matcher behind every `{?…}` resource entry (#1401).
 *
 * ## What this class is
 *
 * NOT an expander. The MCP SDK's `UriTemplate` already expands; `expand()` and
 * `toString()` are inherited unchanged, and `resources/templates/list` still
 * advertises the original template strings. What this class replaces is
 * `match()`, because the SDK's matcher is stricter than RFC 6570 in two ways
 * that decide whether an advertised template can route anything a host would
 * actually send:
 *
 *  1. `partToRegExp` emits one `name=([^&]+)` group per declared name and
 *     concatenates them with no gaps, so `{?format,offset,limit}` compiles to
 *     `…\?format=([^&]+)&offset=([^&]+)&limit=([^&]+)` — every parameter
 *     present, adjacent, in declaration order. RFC 6570 §3.2.8 says the
 *     opposite. So the SDK's own `expand({format:'json', limit:'10'})` produces
 *     a string its own `match()` returns `null` for.
 *  2. The reserved `{+qs}` catch-all compiles to an unanchored `(.+)`, so
 *     `spotify://me/saved/tracks{+qs}` matches `spotify://me/saved/tracksX` —
 *     a different resource, which the server then serves saved tracks for.
 *
 * So the contract worth testing is: **the matcher accepts the set of concrete
 * URIs RFC 6570 says the template expands to, and rejects the neighbouring
 * URIs that are different resources.** A wrong answer here is a malformed
 * match, not an exception — a template that matches too little strands a host
 * on a "resource not found" for a URI the server itself advertised, and one
 * that matches too much serves the wrong entity. Both are silent, so both are
 * worth pinning.
 *
 * ## Why the SDK is used as the oracle
 *
 * The delegation cases (a template with no query operator, or one with a query
 * operator that is not in final position) hand the whole decision to
 * `super.match()`. Asserting "our answer equals the SDK's answer" on a case
 * where both implementations agree proves nothing — so each delegation test
 * names a URI the SDK answers DIFFERENTLY from what this class's own head
 * compiler would produce, and the agreement is therefore evidence of
 * delegation rather than a coincidence. A same-source expectation would be
 * decoration.
 *
 * ## The two corrections, and what they buy
 *
 * Everywhere else this class agrees with the SDK, and the last group asserts
 * that property directly against the SDK's own `UriTemplate` over a corpus
 * spanning the shape matrix. That differential assertion is the point: two
 * silent divergences shipped here (#1558) precisely because nothing compared
 * the override with the implementation it replaces. The only URIs where the two
 * are expected to differ are the two corrections in the header — a form-style
 * expression matching a subset of its variables, and a reserved expression
 * refusing a path continuation — and each one names which correction it is
 * exercising, so a third divergence cannot hide in the group.
 *
 * Run: node --import tsx --test tests/resources.uritemplate.test.ts
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { UriTemplate } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import { Rfc6570UriTemplate } from '../src/resources/uritemplate.js';

/**
 * The real template from `src/resources/index.ts:1128`, which is the shape
 * every `{?…}` entry in the server is built from. `spotify://playlist/{id}/tracks`
 * is also the literal in the class header.
 */
const FORM_STYLE = 'spotify://playlist/{id}/tracks{?format,offset,limit}';

/** A template from `registerTemplate` whose pattern ends in `{id}`. */
const BARE_ID = 'spotify://artist/{id}{?format}';

const ours = (template: string) => new Rfc6570UriTemplate(template);
/** The SDK's own answer for the same template — a different implementation. */
const sdk = (template: string, uri: string) => new UriTemplate(template).match(uri);

describe('Rfc6570UriTemplate — the form-style template this server advertises', () => {
  const tpl = ours(FORM_STYLE);

  it('matches the bare URI, and only the bare URI, with no query', () => {
    assert.deepEqual(tpl.match('spotify://playlist/x1/tracks'), { id: 'x1' });
    // `?` with nothing after it is the zero-variable case, which RFC 6570
    // expands to the empty string — so it is the bare URI, not a different one.
    assert.deepEqual(tpl.match('spotify://playlist/x1/tracks?'), { id: 'x1' });
  });

  it('captures a declared parameter and leaves the others undefined', () => {
    // RFC 6570 §3.2.8 expands with *whatever* variables are defined. The SDK
    // needs all three present and adjacent, so every one of these is null there.
    assert.deepEqual(tpl.match('spotify://playlist/x1/tracks?format=json'), { id: 'x1', format: 'json' });
    assert.deepEqual(tpl.match('spotify://playlist/x1/tracks?offset=10'), { id: 'x1', offset: '10' });
    assert.deepEqual(tpl.match('spotify://playlist/x1/tracks?limit=5'), { id: 'x1', limit: '5' });
    // The SDK's stricter answer for the first of these, asserted directly so the
    // reason this class exists is in the test rather than only in the header.
    assert.equal(sdk(FORM_STYLE, 'spotify://playlist/x1/tracks?format=json'), null);
  });

  it('captures every declared parameter when all are present in declaration order', () => {
    const uri = 'spotify://playlist/x1/tracks?format=json&offset=0&limit=10';
    assert.deepEqual(tpl.match(uri), { id: 'x1', format: 'json', offset: '0', limit: '10' });
    // The one URI shape the SDK also matches — which is why the asymmetry is
    // easy to miss: the full set in order works on both.
    assert.deepEqual(sdk(FORM_STYLE, uri), tpl.match(uri));
  });

  it('rejects a path continuation, which is a different resource', () => {
    // The `{+qs}` bug this class replaced: the SDK's bare `(.+)` matched
    // `tracksX` and the server served saved tracks for it.
    assert.equal(tpl.match('spotify://playlist/x1/tracksX'), null);
    assert.equal(tpl.match('spotify://playlist/x1/tracks/extra'), null);
    assert.equal(tpl.match('spotify://playlist/a/b/tracks'), null);
    assert.equal(tpl.match('spotify://playlist//tracks'), null);
    assert.equal(tpl.match('spotify://other/x1/tracks?format=json'), null);
  });

  it('lets an undeclared parameter through without capturing it', () => {
    // `market` is not in the template, so it is not a variable — but a host
    // that sends it still routes. Only the DECLARED names are read out of the
    // query, so `market` never appears in the result.
    assert.deepEqual(tpl.match('spotify://playlist/x1/tracks?market=GB'), { id: 'x1' });
    assert.deepEqual(tpl.match('spotify://playlist/x1/tracks?market=GB&format=json'), { id: 'x1', format: 'json' });
  });

  it('reads the declared names as an ordered subsequence', () => {
    // Declaration order is [format, offset, limit]. Sent out of order, the URI
    // still ROUTES, but the out-of-order name is not captured: the scan advances
    // past each match, so `limit` at index 0 is behind the cursor by the time
    // `limit` is looked for. Rendering is unaffected because every callback
    // re-parses `href`; the match variables are the routing signal, not the
    // value source. Pinned because a host relying on the variables would see it.
    assert.deepEqual(tpl.match('spotify://playlist/x1/tracks?limit=10&format=json'), { id: 'x1', format: 'json' });
  });

  it('takes the first value when a parameter is repeated', () => {
    assert.deepEqual(tpl.match('spotify://playlist/x1/tracks?format=json&format=xml'), { id: 'x1', format: 'json' });
  });

  it('treats a valueless pair as undefined and an empty value as a value', () => {
    // `?=novalue` has no name, so it belongs to no declared variable. `format=`
    // names one with an empty value, which is defined — the difference between
    // "absent" and "empty" is the whole of RFC 6570's optional-parameter rule.
    assert.deepEqual(tpl.match('spotify://playlist/x1/tracks?=novalue'), { id: 'x1' });
    assert.deepEqual(tpl.match('spotify://playlist/x1/tracks?format='), { id: 'x1', format: '' });
  });
});

describe('Rfc6570UriTemplate — accepts its own expansion, which is the contract', () => {
  const tpl = ours(FORM_STYLE);

  it('round-trips every expansion, including the ones the SDK rejects', () => {
    // `expand()` is the SDK's. The property under test is the one the class
    // header claims: whatever the inherited expander produces, this matcher
    // must accept. A failure here is a host stranded on "not found" for a URI
    // built from a template the server itself advertised.
    // Typed as a record so the spread into `expand` is a `Variables`, not a
    // union of anonymous object types.
    const variableSets: Record<string, string>[] = [
      {},
      { format: 'json' },
      { format: 'json', limit: '10' },
      { offset: '0' },
      { format: 'json', offset: '0', limit: '10' },
    ];
    for (const vars of variableSets) {
      const uri = tpl.expand({ id: 'x1', ...vars });
      const raw = tpl.match(uri);
      assert.notEqual(raw, null, `expansion of ${JSON.stringify(vars)} must match: ${uri}`);
      // The `notEqual` above already failed a null; this only satisfies the
      // compiler, and a null here would fail the `id` assertion regardless.
      const matched = raw ?? {};
      assert.equal(matched.id, 'x1');
      for (const [name, value] of Object.entries(vars)) {
        assert.equal(matched[name], String(value), `${name} must survive the round trip of ${uri}`);
      }
    }
  });

  it('round-trips a value the expander percent-encodes, and returns it still encoded', () => {
    // Encoding is the expander's job and decoding is the renderer's; what the
    // matcher owes is that it does not choke on an encoded value and does not
    // silently hand back something different from what was on the wire.
    const cases: [string, string][] = [
      ['a b', 'a%20b'],       // space — reserved, must be encoded
      ['a&b', 'a%26b'],       // the form-style separator itself
      ['a/b?c', 'a%2Fb%3Fc'], // path and query characters
      ['é', '%C3%A9'],        // non-ASCII, UTF-8
    ];
    for (const [value, encoded] of cases) {
      const uri = tpl.expand({ id: 'x1', format: value });
      assert.ok(uri.endsWith(`format=${encoded}`), `${value} must expand to ${encoded}, got ${uri}`);
      assert.deepEqual(tpl.match(uri), { id: 'x1', format: encoded });
    }
  });

  it('round-trips unreserved characters unencoded, as RFC 3986 requires', () => {
    // `-._~` are unreserved and must NOT be percent-encoded. If the expander
    // encoded them, or the matcher failed to read them back, this fails.
    const uri = tpl.expand({ id: 'x1', format: '-._~' });
    assert.ok(uri.endsWith('format=-._~'), `unreserved characters must survive verbatim, got ${uri}`);
    assert.deepEqual(tpl.match(uri), { id: 'x1', format: '-._~' });
  });
});

describe('Rfc6570UriTemplate — the four ways a URI parser can hand back the template itself', () => {
  const tpl = ours(FORM_STYLE);

  it('resolves the advertised template string to the unparameterised read', () => {
    // A host that echoes the `uriTemplate` it just read gets the documented
    // defaults, not "resource not found" against a URI the server published.
    // A URI parser encodes the braces inconsistently, so all four are accepted.
    for (const uri of [
      'spotify://playlist/x1/tracks{?format,offset,limit}',
      'spotify://playlist/x1/tracks%7B?format,offset,limit}',
      'spotify://playlist/x1/tracks{?format,offset,limit%7D',
      'spotify://playlist/x1/tracks%7B?format,offset,limit%7D',
    ]) {
      assert.deepEqual(tpl.match(uri), { id: 'x1' }, `must resolve ${uri} to the bare read`);
    }
  });

  it('does not treat a template for a DIFFERENT shape as its own', () => {
    assert.equal(tpl.match('spotify://playlist/x1/tracks{?format,offset}'), null);
    assert.equal(tpl.match('spotify://playlist/x1/tracks{?format,offset,limit,extra}'), null);
  });
});

describe('Rfc6570UriTemplate — the reserved and fragment operators stay anchored', () => {
  it('accepts only a real query for {+qs} and refuses a path continuation', () => {
    const tpl = ours('spotify://me/saved/tracks{+qs}');
    // The SDK compiled this to `(.+)`, so `tracksX` matched and the server
    // served saved tracks for a URI that names a different resource.
    assert.deepEqual(sdk('spotify://me/saved/tracks{+qs}', 'spotify://me/saved/tracksX'), { qs: 'X' });
    assert.equal(tpl.match('spotify://me/saved/tracksX'), null);
    assert.equal(tpl.match('spotify://me/saved/tracks#frag'), null);
    assert.equal(tpl.match('spotify://me/saved/tracks{a=1}'), null);
    // What it does accept: the bare URI, and a real query carried whole.
    assert.deepEqual(tpl.match('spotify://me/saved/tracks'), {});
    assert.deepEqual(tpl.match('spotify://me/saved/tracks?a=1&b=2'), { qs: '?a=1&b=2' });
  });

  it('accepts only a real fragment for {#frag}', () => {
    const tpl = ours('spotify://me/saved/tracks{#frag}');
    assert.deepEqual(tpl.match('spotify://me/saved/tracks#f'), { frag: '#f' });
    assert.equal(tpl.match('spotify://me/saved/tracks?a=1&b=2'), null);
    assert.equal(tpl.match('spotify://me/saved/tracksX'), null);
  });
});

describe('Rfc6570UriTemplate — what it hands straight to the SDK', () => {
  it('delegates a template with no query operator at all', () => {
    // `variableNames` and `toString()` are inherited, so the census is
    // unaffected; only `match` changes. The explode split is the proof of
    // delegation: this class's head compiler returns the raw matched text, so a
    // non-delegating implementation would answer the string 'a,b' here.
    const tpl = ours('spotify://artist/{id*}/albums');
    assert.deepEqual(tpl.match('spotify://artist/a,b/albums'), { id: ['a', 'b'] });
    assert.deepEqual(sdk('spotify://artist/{id*}/albums', 'spotify://artist/a,b/albums'), { id: ['a', 'b'] });
    assert.equal(tpl.match('spotify://artist/a,b/albums?format=json'), null);
  });

  it('delegates when a query operator is not in final position', () => {
    // An intermediate operator is a shape this class does not model, and
    // answering it with a half-understood rule is how a matcher starts matching
    // the wrong thing. The SDK splits the exploded variable; a tail-only head
    // compiler would not, so the agreement is the evidence.
    const tpl = ours('spotify://a{?x}/{id*}{?y}');
    assert.deepEqual(tpl.match('spotify://a?x=1/a,b?y=2'), { x: '1', id: ['a', 'b'], y: '2' });
    assert.equal(tpl.match('spotify://a/b?y=2'), null, 'the SDK needs the intermediate parameter too');
  });

  it('escapes regex metacharacters in the head IT compiles', () => {
    // The trailing `{?format}` is load-bearing. A template with no query
    // operator delegates to `super.match()`, which brings the SDK's own
    // escaper with it — so a test written against one of those passes with
    // this class's `escapeRegExp` deleted, which is exactly what it did the
    // first time. These templates are the ones `compileHead` actually builds a
    // regex from.
    //
    // Two directions, because a metacharacter is wrong in two ways and either
    // alone can hide a broken escaper. Unescaped, `.` matches any character, so
    // `aXb` routes to `a.b`'s resource — the over-match. Unescaped, `+` is a
    // quantifier, so the head stops matching its OWN literal — the under-match.
    const dotted = ours('spotify://a.b/{id}/albums{?format}');
    assert.deepEqual(dotted.match('spotify://a.b/1/albums?format=json'), { id: '1', format: 'json' });
    assert.equal(dotted.match('spotify://aXb/1/albums?format=json'), null, 'a literal dot is not any character');

    const plus = ours('spotify://a.b+c/{id}/albums{?format}');
    assert.deepEqual(
      plus.match('spotify://a.b+c/1/albums?format=json'),
      { id: '1', format: 'json' },
      'a literal + is not a quantifier',
    );

    // Unescaped, `(` opens a group that is never closed and the RegExp
    // constructor throws — at server start, over a template nobody called.
    const bracket = ours('spotify://a(b/{id}/albums{?format}');
    assert.deepEqual(bracket.match('spotify://a(b/1/albums?format=json'), { id: '1', format: 'json' });
  });
});

describe('Rfc6570UriTemplate — head expressions immediately before the trailing operator', () => {
  it('stops the head at the query and reads the query as the query (#1558)', () => {
    // The head regex is unanchored at the end, so a capture has to know where
    // it stops without anything to backtrack against. `[^/,]+` did not: it
    // matched `?` and `=`, and where the head is immediately followed by the
    // operator — every shipped pattern ending in a bare `{id}` — the whole
    // `?format=json` went into the id and every declared parameter was lost.
    const tpl = ours(BARE_ID);
    assert.deepEqual(tpl.match('spotify://artist/xyz?format=json'), { id: 'xyz', format: 'json' });
    // The SDK's fully anchored pattern finds the same stopping point by
    // backtracking, so agreement here is the evidence the fix restored the
    // behaviour rather than inventing one.
    assert.deepEqual(sdk(BARE_ID, 'spotify://artist/xyz?format=json'), { id: 'xyz', format: 'json' });
    // With no query there is nothing to split, and the answer is unchanged.
    assert.deepEqual(tpl.match('spotify://artist/xyz'), { id: 'xyz' });
    // A literal between the variable and the operator is the shipped shape for
    // every other template, and it read correctly before and after.
    const withLiteral = ours('spotify://artist/{id}/albums{?format}');
    assert.deepEqual(withLiteral.match('spotify://artist/xyz/albums?format=json'), { id: 'xyz', format: 'json' });
  });

  it('stops the head at a fragment, so a reserved tail still sees the whole fragment (#1558)', () => {
    // `{#frag}` is the same shape with a different delimiter, and it was broken
    // the same way: the head ate `#f` and the tail got an empty remainder.
    const tpl = ours('spotify://artist/{id}{#frag}');
    assert.deepEqual(tpl.match('spotify://artist/xyz#f'), { id: 'xyz', frag: '#f' });
    assert.deepEqual(tpl.match('spotify://artist/xyz'), { id: 'xyz' });
  });

  it('splits an exploded head variable, as the SDK does (#1558)', () => {
    // `compileHead` captures the raw `a,b`; the SDK's `match` then splits an
    // exploded value on commas. The override assigned the capture directly and
    // dropped that step, so a head expression was the one place an exploded
    // variable stayed a string while every delegated template split it.
    const tpl = ours('spotify://artist/{id*}/albums{?format}');
    assert.deepEqual(tpl.match('spotify://artist/a,b/albums?format=json'), { id: ['a', 'b'], format: 'json' });
    assert.deepEqual(sdk('spotify://artist/{id*}/albums{?format}', 'spotify://artist/a,b/albums?format=json'), {
      id: ['a', 'b'],
      format: 'json',
    });
    // The split is a property of the `*`, not of the comma: without it the raw
    // comma is a second value and the URI is not this resource — in BOTH
    // implementations — while an encoded comma is one value in both.
    const plain = 'spotify://artist/{id}/albums{?format}';
    assert.equal(ours(plain).match('spotify://artist/a,b/albums?format=json'), null);
    assert.equal(sdk(plain, 'spotify://artist/a,b/albums?format=json'), null);
    assert.deepEqual(ours(plain).match('spotify://artist/a%2Cb/albums?format=json'), {
      id: 'a%2Cb',
      format: 'json',
    });
  });

  it('reads every shipped pattern whose head is a bare {id}', () => {
    // The blast radius, derived rather than asserted. `registerTemplate`
    // composes `${pattern}{?${query.join(',')}}`, so a pattern ENDING in `{id}`
    // composes to exactly the shape that had nothing to backtrack against.
    //
    // Reading the patterns out of `templates.ts` rather than listing them here
    // is the point: a list in a test is a list that goes stale, and this one
    // already had. The first draft of the sibling comment said "six" and named
    // seven patterns, missing `playlist` — the actual number is whatever this
    // returns, and a new bare-`{id}` template joins the covered set with no
    // edit here at all.
    const src = readFileSync(new URL('../src/resources/templates.ts', import.meta.url), 'utf8');
    const bare = [...src.matchAll(/'(spotify:\/\/[a-z-]+\/\{id\})'/g)].map((m) => m[1]!);

    assert.ok(bare.length > 0, 'templates.ts must still register bare-{id} patterns for this to mean anything');
    // Sorted so a failure names what changed rather than what moved.
    for (const pattern of [...bare].sort()) {
      const composed = `${pattern}{?format}`;
      const uri = `${pattern.replace('{id}', 'xyz')}?format=json`;
      assert.deepEqual(ours(composed).match(uri), { id: 'xyz', format: 'json' }, `${pattern}: the head must stop at ?`);
      assert.deepEqual(
        sdk(composed, uri),
        { id: 'xyz', format: 'json' },
        `${pattern}: and the SDK agrees, so this pins behaviour rather than a private reading`,
      );
    }
  });
});

/**
 * The property the class exists to provide: outside the two documented
 * corrections, `Rfc6570UriTemplate.match` and the SDK's `UriTemplate.match`
 * return the same variables.
 *
 * The comparison is between two independent implementations at runtime, not
 * against a hand-typed expectation, so it fails if EITHER moves — including if
 * an SDK upgrade changes the answer, which is the signal to re-derive rather
 * than a flake to paper over. The corpus spans the shape matrix the two
 * disagree on by construction: a head with and without a trailing literal, with
 * and without explode, with `.` and `/` label operators, and the reserved and
 * form-style tails.
 */
describe('Rfc6570UriTemplate — agrees with the SDK outside its two corrections', () => {
  /** A shape the SDK answers correctly, so ours must answer identically. */
  const AGREE: [string, string][] = [
    // A trailing literal gives the head something to backtrack against — the
    // shape every test before #1558 covered, and the reason the defect shipped.
    ['spotify://artist/{id}/albums{?format}', 'spotify://artist/xyz/albums?format=json'],
    // No trailing literal: the head must still stop at `?` on its own. Both of
    // these declare every parameter the URI carries, so the SDK's stricter
    // "all present, adjacent, in order" rule is satisfied and the two are
    // expected to meet.
    ['spotify://artist/{id}{?format}', 'spotify://artist/xyz?format=json'],
    ['spotify://a/{id}{?format,offset,limit}', 'spotify://a/xyz?format=json&offset=1&limit=2'],
    // Explode, with and without a literal, and the label operators — all three
    // take their character class from the same `HEAD_VALUE`.
    ['spotify://artist/{id*}/albums{?format}', 'spotify://artist/a,b/albums?format=json'],
    ['spotify://artist/{id*}{?format}', 'spotify://artist/a,b?format=json'],
    ['spotify://artist/.id{?format}', 'spotify://artist/.xyz?format=json'],
    ['spotify://artist{/id}{?format}', 'spotify://artist/xyz?format=json'],
    // Values that percent-encode the delimiters, which must NOT split: the
    // matcher does not decode, so `%3F` is just a character in the value.
    ['spotify://artist/{id}/albums{?format}', 'spotify://artist/x%3Fy/albums?format=json'],
    // The two neighbours that must not match at all: an empty id, and a path
    // continuation past the resource.
    ['spotify://artist/{id}{?format}', 'spotify://artist/?format=json'],
    ['spotify://artist/{id}/albums{?format}', 'spotify://artist/xyz/albums/extra?format=json'],
  ];

  /**
   * A shape the SDK gets wrong on purpose-corrected grounds. Each entry names
   * which of the two corrections it exercises, and each asserts the SDK really
   * does answer differently — otherwise the case would be silently testing
   * agreement and the reason it is listed would rot.
   */
  const CORRECTED: [template: string, uri: string, expected: unknown, why: string][] = [
    // Correction 1: a form-style expression expands with whatever variables are
    // defined, so a subset, an out-of-declaration-order set, an undeclared
    // pair, and no query at all all expand to a URI this matcher must accept.
    ['spotify://artist/{id}{?format}', 'spotify://artist/xyz', { id: 'xyz' }, 'correction 1: the zero-variable case'],
    [
      'spotify://artist/{id}{?format}',
      'spotify://artist/xyz?offset=1',
      { id: 'xyz' },
      'correction 1: an undeclared pair is not a variable',
    ],
    [
      'spotify://a/{id}{?format,offset,limit}',
      'spotify://a/xyz?format=json&limit=2',
      { id: 'xyz', format: 'json', limit: '2' },
      'correction 1: a declared subset, not all three adjacent',
    ],
    // Correction 2: the reserved tail is anchored, so a path continuation is a
    // different resource. `spotify://artist/xyz/albums` under `{+qs}` is the
    // `/albums` continuation this class exists to reject.
    ['spotify://artist/{id}{+qs}', 'spotify://artist/xyz/albums', null, 'correction 2: `/albums` is a path continuation'],
    ['spotify://artist/{id}{#frag}', 'spotify://artist/xyz?format=json', null, 'correction 2: a query is not a fragment'],
  ];

  for (const [template, uri] of AGREE) {
    it(`agrees on ${template} ← ${uri}`, () => {
      assert.deepEqual(ours(template).match(uri), sdk(template, uri), `ours and the SDK must agree on ${uri}`);
    });
  }

  for (const [template, uri, expected, why] of CORRECTED) {
    it(`differs on ${template} ← ${uri} — ${why}`, () => {
      assert.deepEqual(ours(template).match(uri), expected, `our corrected answer for ${uri}`);
      // If the SDK ever starts answering this correctly, the correction it
      // names may be obsolete — which is worth knowing, and is the only way
      // this list cannot quietly stop describing the SDK.
      assert.notDeepEqual(sdk(template, uri), ours(template).match(uri), `the SDK must still disagree on ${uri}`);
    });
  }
});
