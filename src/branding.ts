/**
 * The non-affiliation notice (#705) — the one place that owns the wording.
 *
 * The notice has to reach every surface a user or a host can meet this project
 * on, and hand-typed variants are how it ends up on five of them: a sixth
 * surface gets its own paraphrase, the paraphrases disagree, and nothing fails.
 * So the words live here and every surface reads them from here.
 *
 * This module is also the coordination point for the sibling compliance units.
 * The MCP `initialize` handshake is shared with `a4-server-instructions`
 * (A4-025) and `a14-branding-nonaffiliation` (A14-027), which own the
 * host-orientation content. They extend `SERVER_INSTRUCTIONS`; none of them
 * re-types a sentence beside it.
 *
 * **Two forms, because of a hard cap.** The MCP Registry caps
 * `ServerDetail.description` at 100 characters (`maxLength` in the pinned
 * `$schema`), and five surfaces must fit inside that budget: the
 * `server.json` description, `package.json.description`, the README one-liner
 * and both blurbs in `docs/distribution.md`. The canonical 100-character
 * sentence is authored once in `tests/registry-meta.test.ts` (#655) and its
 * tail is `SHORT_NON_AFFILIATION_NOTICE` below. Every surface without the cap
 * carries the long form.
 *
 * `tests/branding-notice-guard.test.ts` fails if either form is dropped from a
 * surface it belongs on, and `tests/registry-meta.test.ts` fails if the
 * canonical sentence stops ending with the short form — so the two cannot
 * drift apart without a red test.
 */

/**
 * The long form, and the minimum every uncapped surface must say.
 *
 * "Unofficial" is doing work the shorter form cannot: it is the word that
 * answers a first-glance impression of an official integration, and it is the
 * one Developer Policy Sec. VI.2 reaches for. "Endorsed by" and "sponsored by"
 * are named alongside "affiliated" because Sec. IX.7 forbids *implying*
 * endorsement, which is a claim about how the product reads rather than about
 * who runs it.
 */
export const NON_AFFILIATION_NOTICE =
  'Independent, unofficial project. Not affiliated with, endorsed by, or sponsored by Spotify.';

/**
 * The trademark sentence, for surfaces with room for it.
 *
 * The short notice above denies a relationship; this one states the underlying
 * fact, which is what a reader who has never heard of the project actually
 * needs in order to place it. It is the second half of `BRANDING_NOTICE`
 * rather than a third variant.
 */
export const TRADEMARK_NOTICE =
  '"Spotify" is a trademark of Spotify AB; this project is not a Spotify product.';

/** The full two-sentence disclosure. The default on every surface with no length cap. */
export const BRANDING_NOTICE = `${NON_AFFILIATION_NOTICE} ${TRADEMARK_NOTICE}`;

/**
 * The 100-character-cap form. Equal to the tail of `CANONICAL_DESCRIPTION` in
 * `tests/registry-meta.test.ts`; the guard asserts the two are the same string,
 * so this is a second *reference* to the short form rather than a second
 * authored copy of it.
 */
export const SHORT_NON_AFFILIATION_NOTICE = 'Not affiliated with Spotify.';
