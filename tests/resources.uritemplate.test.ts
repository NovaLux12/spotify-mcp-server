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
 * ## The two divergences, pinned as current behaviour
 *
 * `head expressions immediately before the trailing operator` documents two
 * shapes this class gets wrong relative to the SDK. They are pinned rather than
 * asserted as correct because they are real: an exploded head variable is not
 * split, and a head variable swallows the query string when nothing literal
 * sits between it and the operator. Both are reported, unfiled. No renderer
 * reads these match variables today (every callback takes a `URL` and re-parses
 * the query from `href`), so routing is unaffected — see the report.
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
  it('absorbs the query into a head variable, and drops the query variables', () => {
    // PINNED AS CURRENT BEHAVIOUR, and it is wrong. `[^/,]+` matches `?` and
    // `=`, and there is nothing in the head for the regex to backtrack against,
    // so `?format=json` is swallowed whole. The SDK's fully anchored pattern
    // backtracks and answers correctly.
    //
    // How many shipped patterns this reaches is NOT counted here — the next
    // test derives it from `templates.ts`, because a hand-written number in a
    // comment is a claim that decays the moment a template is added. An earlier
    // draft of this comment said "six" and then listed seven names.
    //
    // Every registered callback takes a `URL` and re-parses `href`, so no
    // renderer reads this value and routing is intact today.
    const tpl = ours(BARE_ID);
    assert.deepEqual(tpl.match('spotify://artist/xyz?format=json'), { id: 'xyz?format=json' });
    assert.deepEqual(sdk(BARE_ID, 'spotify://artist/xyz?format=json'), { id: 'xyz', format: 'json' });
    // With no query there is nothing to absorb, and the answer is right.
    assert.deepEqual(tpl.match('spotify://artist/xyz'), { id: 'xyz' });
    // A literal between the variable and the operator is the shipped shape for
    // every other template, and it reads correctly.
    const withLiteral = ours('spotify://artist/{id}/albums{?format}');
    assert.deepEqual(withLiteral.match('spotify://artist/xyz/albums?format=json'), { id: 'xyz', format: 'json' });
  });

  it('does not split an exploded head variable, unlike the SDK', () => {
    // PINNED AS CURRENT BEHAVIOUR, and it is wrong: the SDK splits an exploded
    // value on commas, `compileHead` does not, and `match` assigns the raw
    // capture. No shipped template uses explode.
    const tpl = ours('spotify://artist/{id*}/albums{?format}');
    assert.deepEqual(tpl.match('spotify://artist/a,b/albums?format=json'), { id: 'a,b', format: 'json' });
    assert.deepEqual(sdk('spotify://artist/{id*}/albums{?format}', 'spotify://artist/a,b/albums?format=json'), {
      id: ['a', 'b'],
      format: 'json',
    });
  });

  it('reaches every shipped pattern whose head is a bare {id}', () => {
    // The blast radius, derived rather than asserted. `registerTemplate`
    // composes `${pattern}{?${query.join(',')}}`, so a pattern ENDING in
    // `{id}` composes to exactly the failing shape — the head is immediately
    // followed by the trailing operator, with no literal to backtrack against.
    //
    // Reading the patterns out of `templates.ts` rather than listing them here
    // is the point: a list in a test is a list that goes stale, and this one
    // already had. The first draft of the sibling comment said "six" and named
    // seven patterns, missing `playlist` — the actual number is whatever this
    // returns, and a new bare-`{id}` template joins the failing set with no
    // edit here at all.
    const src = readFileSync(new URL('../src/resources/templates.ts', import.meta.url), 'utf8');
    const bare = [...src.matchAll(/'(spotify:\/\/[a-z-]+\/\{id\})'/g)].map((m) => m[1]!);

    assert.ok(bare.length > 0, 'templates.ts must still register bare-{id} patterns for this to mean anything');
    // Sorted so a failure names what changed rather than what moved.
    for (const pattern of [...bare].sort()) {
      const composed = `${pattern}{?format}`;
      const uri = `${pattern.replace('{id}', 'xyz')}?format=json`;
      assert.deepEqual(
        ours(composed).match(uri),
        { id: 'xyz?format=json' },
        `${pattern}: the head absorbs the query`,
      );
      assert.deepEqual(
        sdk(composed, uri),
        { id: 'xyz', format: 'json' },
        `${pattern}: and the SDK disagrees, so this is our bug and not a shared reading`,
      );
    }
  });
});
