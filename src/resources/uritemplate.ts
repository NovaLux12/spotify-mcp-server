/**
 * RFC 6570-conformant matching for the URI templates this server advertises
 * (#1401).
 *
 * ## Why this file exists
 *
 * The MCP SDK matches `resources/read` requests by running each registered
 * template's `uriTemplate.match(uri)` in insertion order
 * (`server/mcp.js`, "Then check templates"), and it ships its own
 * `UriTemplate` implementation in `shared/uriTemplate.js`. That
 * implementation is stricter than RFC 6570 in two ways that decide whether an
 * advertised template can match anything a host would actually send:
 *
 *  1. **Form-style expressions require every variable.** `partToRegExp` emits
 *     one `name=([^&]+)` group per declared name and concatenates them with no
 *     gaps, so `{?format,offset,limit}` compiles to
 *     `^…\?format=([^&]+)&offset=([^&]+)&limit=([^&]+)$` — all three
 *     parameters present, adjacent, and in declaration order. RFC 6570 §3.2.8
 *     says the opposite: a form-style expression expands with *whatever
 *     variables are defined*, joined by `&` in declaration order, and with none
 *     defined it expands to the empty string. The consequence is an
 *     expand/match asymmetry inside a single class: the SDK's own
 *     `expand({format:'json', limit:'10'})` returns
 *     `spotify://me/saved/tracks?format=json&limit=10`, and `match()` of that
 *     very string returns `null`.
 *  2. **The reserved `{+qs}` catch-all is an unanchored `(.+)`.**
 *     `spotify://me/saved/tracks{+qs}` therefore matches *any* URI with that
 *     prefix — including `spotify://me/saved/tracksX`, a different URI
 *     entirely, which the server then happily serves saved tracks for.
 *
 * ## What the protocol says
 *
 * `resources/templates/list` returns `uriTemplate` strings; `resources/read`
 * takes a concrete `uri`. Nothing in a read request can carry the braces, so
 * **expanding a template is the host's job** and the server's job is to match
 * its pattern against the concrete URI the host produced. That is the model
 * this class implements: it corrects the matcher, not the spelling. A
 * `{?a,b,c}` template here matches the same set of concrete URIs that RFC 6570
 * says the template expands to, so a host that expands correctly now routes to
 * the entry it was told to build a URI from.
 *
 * Templates that use none of the query-string operators (`{id}` and friends)
 * are handed straight to the SDK — its `([^/,]+)` compilation is already
 * correct, and there is no reason to re-derive it.
 *
 * ## What the override must NOT diverge on
 *
 * Everywhere else this class answers exactly what the SDK's `UriTemplate`
 * answers; the two corrections above are the whole of the difference, and
 * `tests/resources.uritemplate.test.ts` asserts that against the SDK directly
 * rather than against hand-typed expectations. That property is load-bearing,
 * not decorative: a third divergence shipped here once (the head's character
 * class, #1558) precisely because nothing compared the override with the
 * implementation it replaces, and every symptom was silent — the match
 * succeeded, so nothing errored.
 *
 * `toString()` and `variableNames` are inherited unchanged, so
 * `resources/templates/list` still advertises the original template strings and
 * the census is unaffected.
 */
import { UriTemplate } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import type { Variables } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';

/** Any RFC 6570 expression: `{`, optional operator, names, `}`. */
const EXPRESSION = /\{([+#./?&]?)([^}]*)\}/g;

/** Operators whose expansion is a query string or fragment, and which expand
 *  to the empty string when the variable is undefined. */
const OPTIONAL_WHEN_UNDEFINED = new Set(['?', '&', '+', '#']);

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * What a simple or label-style head expression may contain: everything except
 * the characters that end it.
 *
 * `,` and `/` are the SDK's own exclusions (`partToRegExp`'s `[^/,]+`). `?` and
 * `#` are added because they are the two delimiters a query or a fragment
 * begins, and a simple expansion percent-encodes both — `encodeURIComponent('?')`
 * is `%3F` — so a value carrying a raw `?` is not a longer id, it is a head that
 * has run into the query. With the SDK's class alone the greedy `[^/,]+` had
 * nothing to stop it: where no literal sits between a head expression and the
 * trailing `{?...}`, it consumed the query whole, and
 * `spotify://artist/{id}{?format}` matched `spotify://artist/xyz?format=json` as
 * `{ id: 'xyz?format=json' }` — every declared parameter dropped. Excluding the
 * delimiters gives the regex the same stopping point the SDK's fully anchored
 * pattern finds by backtracking, without the backtracking.
 */
const HEAD_VALUE = '[^/,?#]';

type Part =
  | { literal: string }
  | { operator: string; names: string[]; exploded: boolean };

export class Rfc6570UriTemplate extends UriTemplate {
  /**
   * Regex for the literal head of the template — everything up to the first
   * query-string operator expression, with any earlier `{id}`-style
   * expressions compiled the way the SDK compiles them. Unanchored at the end
   * on purpose: the tail is what `match` inspects separately.
   */
  private readonly head: RegExp | null;
  /** Variable owning each capture group in `head`, in order. */
  private readonly headGroups: { name: string; exploded: boolean }[] = [];
  /** Declared names, in declaration order, for the trailing expression. */
  private readonly names: string[] = [];
  private readonly operator: string;
  /** The trailing expression's text, in each encoding a URI parser may use. */
  private readonly verbatim: string[] = [];

  constructor(template: string) {
    super(template);
    const parts: Part[] = [];
    let text = '';
    let cursor = 0;
    let queryOperatorSeen = false;
    for (const found of template.matchAll(EXPRESSION)) {
      const index = found.index ?? 0;
      if (index > cursor) text += template.slice(cursor, index);
      if (text) {
        parts.push({ literal: text });
        text = '';
      }
      const operator = found[1];
      if (OPTIONAL_WHEN_UNDEFINED.has(operator)) queryOperatorSeen = true;
      parts.push({
        operator,
        names: found[2].split(',').map((n) => n.replace('*', '').trim()).filter((n) => n.length > 0),
        exploded: found[2].includes('*'),
      });
      cursor = index + found[0].length;
    }
    if (cursor < template.length) text += template.slice(cursor);
    if (text) parts.push({ literal: text });

    const tail = parts.length > 0 ? parts[parts.length - 1] : undefined;
    // Only a query-string operator in FINAL position is handled here. A
    // template with one earlier is a shape this class does not model, and
    // answering it with a half-understood rule is how a matcher starts matching
    // the wrong thing — so defer to the SDK instead.
    const intermediateQueryOperator = parts
      .slice(0, -1)
      .some((part) => !('literal' in part) && OPTIONAL_WHEN_UNDEFINED.has(part.operator));
    const usable = queryOperatorSeen && !intermediateQueryOperator && tail && 'operator' in tail;
    this.operator = usable ? tail.operator : '';
    this.names = usable ? tail.names : [];
    this.head = this.operator ? new RegExp(`^${this.compileHead(parts.slice(0, -1))}`) : null;

    if (this.operator) {
      // A host that hands back the advertised `uriTemplate` string unchanged
      // gets the same defaults an unparameterised read would get, rather than a
      // "resource not found" against a URI the server itself published. A URI
      // parser encodes the braces inconsistently — the MCP client's
      // `readResource` delivers `spotify://me/saved/tracks%7B?format,offset,
      // limit}` — so all four combinations are accepted.
      const inner = `${this.operator}${this.names.join(',')}`;
      this.verbatim = [`{${inner}}`, `%7B${inner}}`, `{${inner}%7D`, `%7B${inner}%7D`];
    }
  }

  /**
   * Compile everything before the trailing query-string expression.
   *
   * The head is unanchored at the end, so every capture here has to know where
   * it stops on its own — that is what `HEAD_VALUE` is for, and why the `/` and
   * `.` cases carry the same character class as the default one rather than
   * their own. The SDK compiles the equivalent expressions the same way, except
   * that it can lean on a `(.+)`-free anchored pattern to find the stopping
   * point by backtracking.
   */
  private compileHead(parts: Part[]): string {
    return parts
      .map((part) => {
        if ('literal' in part) return escapeRegExp(part.literal);
        const [name] = part.names;
        this.headGroups.push({ name, exploded: part.exploded });
        const value = part.exploded
          ? `(${HEAD_VALUE}+(?:,${HEAD_VALUE}+)*)`
          : `(${HEAD_VALUE}+)`;
        switch (part.operator) {
          case '.':
            return `\\.${value}`;
          case '/':
            return `/${value}`;
          case '#':
            return `(#.+)`;
          case '+':
            return '(\\?.+)';
          default:
            return value;
        }
      })
      .join('');
  }

  /**
   * RFC 6570 §3.2.8 as a matcher: the query must be a `?`-prefixed list of
   * `name=value` pairs in which the declared names appear as an ordered
   * subsequence. Absent names are simply undefined and expand to nothing;
   * undeclared pairs are allowed anywhere. An absent query is the zero-variable
   * case, which RFC 6570 expands to the empty string.
   */
  private matchFormStyle(query: string): Variables {
    const variables: Variables = {};
    const pairs = query
      .slice(1)
      .split('&')
      .filter((p) => p.length > 0)
      .map((p) => {
        const eq = p.indexOf('=');
        return eq === -1 ? [p, ''] : [p.slice(0, eq), p.slice(eq + 1)];
      });
    let cursor = 0;
    for (const name of this.names) {
      const at = pairs.findIndex(([key], i) => i >= cursor && key === name);
      if (at === -1) continue; // undefined — contributes nothing to the expansion
      variables[name] = pairs[at][1];
      cursor = at + 1;
    }
    return variables;
  }

  override match(uri: string): Variables | null {
    if (!this.head) return super.match(uri);
    const found = this.head.exec(uri);
    if (!found) return null;
    const rest = uri.slice(found[0].length);

    const variables: Variables = {};
    this.headGroups.forEach((group, i) => {
      const value = found[i + 1];
      if (value === undefined) return;
      // The SDK's step, restored. `compileHead` captures an exploded value as
      // the raw `a,b`, and the capture is what this class hands back, so
      // without this a head expression would be the one place an exploded
      // variable stayed a string while every delegated template split it.
      variables[group.name] = group.exploded && value.includes(',') ? value.split(',') : value;
    });

    // A URI the server itself advertised resolves to the unparameterised read.
    if (this.verbatim.includes(rest)) return variables;

    // A reserved variable legitimately carries a query string or fragment.
    if (this.operator === '+' || this.operator === '#') {
      if (rest === '') return variables;
      const lead = this.operator === '#' ? '#' : '?';
      if (!rest.startsWith(lead)) return null;
      const [name] = this.names;
      if (name) variables[name] = rest;
      return variables;
    }

    // Form-style: nothing at all, or a query whose declared names appear in
    // order. Anything else after the head — a path continuation such as the
    // `X` in `spotify://me/saved/tracksX` — is a different resource.
    if (rest === '') return variables;
    if (!rest.startsWith('?')) return null;
    return { ...variables, ...this.matchFormStyle(rest) };
  }
}
