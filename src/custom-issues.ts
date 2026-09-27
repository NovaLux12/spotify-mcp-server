/**
 * #1518 — the trust boundary for zod `custom` issue messages.
 *
 * ## The defect this closes
 *
 * `expectationPhrase` (`src/tools/annotations.ts`) turns a zod issue into the
 * phrase a caller reads. Its `switch` had an arm for every code this repo's
 * schemas produce by *structure* — `invalid_type`, `invalid_value`, `too_big`,
 * `too_small`, `not_multiple_of`, `invalid_format` — and a `default` that
 * returned `undefined`. `custom` was not in the list, so the one code this repo
 * *authors by hand*, with a message written for exactly this purpose, was the
 * one code that rendered as nothing: `src/refs.ts` classified a bad Spotify
 * reference, wrote `"not a recognisable Spotify ID, URI, or official share
 * URL"`, and the boundary dropped it on the floor.
 *
 * ## Why a bare `case 'custom'` is not the fix
 *
 * A zod `custom` issue's message is whatever the schema's author put there.
 * Every schema in this repository is first-party, so today any `custom` message
 * is text someone here wrote on purpose. That is a *fact about the tree*, not a
 * *property of the message*, and a `switch` arm cannot tell the difference: it
 * reads `issue.message` and has no way to ask who wrote it. The moment a schema
 * arrives from anywhere else — a shared module, a generated schema, a
 * hand-copied snippet — the same arm publishes whatever that schema said, under
 * this server's error contract, with this server's authority behind it.
 *
 * So the arm is gated on a discriminator, not on a name and not on a string
 * comparison:
 *
 *  - **`TRUST_KEY` is a module-private `Symbol`.** It is not exported, not
 *    derived from `Symbol.for`, and not reconstructible from any string a
 *    reader of this file can see. An emitter that does not import this module
 *    cannot put the key on an issue, whatever it sets `message` to. This is the
 *    part that makes the trust decision *enforced* rather than assumed.
 *  - **`CUSTOM_ISSUE_EMITTERS` is the registry.** Naming the emitter is a
 *    compile-time obligation — `trustedCustomIssue` takes
 *    `CustomIssueEmitter`, a union derived from that list, so an unregistered
 *    name does not type-check — and the list is re-checked at runtime so the
 *    check survives a cast, a `.mjs` caller, or a future refactor that widens
 *    the type.
 *
 * An emitter that is not registered therefore falls back to the generic phrase,
 * and the tree is held to that: `tests/errors.custom-issue.test.ts` scans
 * `src/` and fails if `code: 'custom'` is constructed anywhere except here,
 * which is what makes "unregistered" a state the build catches rather than a
 * state a reader has to notice.
 *
 * ## Bounding, because trust is not the only concern
 *
 * A trusted message is still caller-visible text on the error surface, so it is
 * collapsed to one line and capped before it is relayed. Several emitters
 * interpolate caller-supplied fragments into their message (`refs.ts` names the
 * host out of a submitted URL, `freshness.ts` quotes the submitted date), and an
 * unbounded relay of a bounded-but-attacker-shaped string is the injection
 * surface the `singleLine` collapse exists to close. The cap is 200 characters;
 * the longest message this tree authors today is 142.
 */

/** Module-private. Never exported, never in the global symbol registry. */
const TRUST_KEY = Symbol('spotify-mcp.trustedCustomIssue');

/**
 * Every `custom` emitter in this tree, by name.
 *
 * **This list is the registry, and it is deliberately not one entry.** A scan of
 * `src/` on the current tree finds six sites, not one: `refs.ts` (entity
 * references), `freshness.ts` (the `since` calendar), `import.ts` (the inline
 * document byte limit), `playlists.ts` twice (create and update, the
 * public/collaborative conflict) and `playlistbatch.ts` (the same conflict on
 * `copy_playlist`). A one-entry list would have been a list that happened to
 * match the issue, not one that matched the tree, and it would have left five
 * first-party emitters silently on the generic phrase while the registry read
 * as if the trust question had been settled.
 *
 * Adding an emitter is a two-line act: the name here, and the
 * `trustedCustomIssue('<name>', …)` call. Renaming or removing one without
 * touching this list fails `tests/errors.custom-issue.test.ts`.
 */
export const CUSTOM_ISSUE_EMITTERS = [
  'freshness.sinceCalendarDate',
  'import.contentSize',
  'playlistbatch.copyPlaylistFlags',
  'playlists.createPlaylistFlags',
  'playlists.updatePlaylistFlags',
  'refs.spotifyId',
] as const;

/** The name an emitter must carry for its message to be relayed. */
export type CustomIssueEmitter = (typeof CUSTOM_ISSUE_EMITTERS)[number];

const REGISTERED: ReadonlySet<string> = new Set(CUSTOM_ISSUE_EMITTERS);

/** The longest relayed message, in characters. The tree's longest today is 142. */
export const CUSTOM_MESSAGE_CAP = 200;

/** Collapse to one bounded line, or `undefined` when nothing survives. */
function oneLine(value: string, cap: number): string | undefined {
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return undefined;
  return flat.length > cap ? `${flat.slice(0, cap - 1).trimEnd()}…` : flat;
}

/**
 * The zod `custom` issue a registered emitter should add.
 *
 * Stamping the issue is the whole mechanism: `expectationPhrase` relays
 * `message` only when it finds {@link TRUST_KEY} on the issue *and* the emitter
 * it names is in the registry. An issue built any other way — a raw
 * `addIssue({ code: 'custom', message })`, which is what an untrusted schema
 * produces — reads back as `undefined` and takes the generic phrase.
 *
 * @param emitter The registered name. A name outside `CUSTOM_ISSUE_EMITTERS`
 *   does not type-check, and throws here if it arrives anyway.
 * @param message The caller's-facing explanation. Relayed verbatim, bounded.
 */
export function trustedCustomIssue(
  emitter: CustomIssueEmitter,
  message: string,
): { code: 'custom'; message: string; params: Record<PropertyKey, string> } {
  if (!REGISTERED.has(emitter)) {
    // Fail loud rather than silently drop the message: a schema author who
    // named an unregistered emitter has asked for a surface that does not
    // exist, and the alternative is the exact defect this module closes — a
    // message written, discarded, and nothing recording that it was.
    throw new Error(`unregistered custom-issue emitter: ${emitter}`);
  }
  return { code: 'custom', message, params: { [TRUST_KEY]: emitter } };
}

/**
 * The relayed message for a `custom` issue, or `undefined` when this issue did
 * not come from a registered emitter.
 *
 * Undefined is the load-bearing return. It is what routes an untrusted issue to
 * the generic "pass a valid value according to the tool schema" phrase, and
 * `tests/errors.custom-issue.test.ts` asserts that fallback rather than
 * assuming it.
 */
export function trustedCustomMessage(issue: unknown): string | undefined {
  if (issue === null || typeof issue !== 'object') return undefined;
  const record = issue as Record<string, unknown>;
  if (record.code !== 'custom') return undefined;
  const params = record.params;
  if (params === null || typeof params !== 'object') return undefined;
  const emitter = (params as Record<PropertyKey, unknown>)[TRUST_KEY];
  if (typeof emitter !== 'string' || !REGISTERED.has(emitter)) return undefined;
  const message = record.message;
  if (typeof message !== 'string') return undefined;
  return oneLine(message, CUSTOM_MESSAGE_CAP);
}
