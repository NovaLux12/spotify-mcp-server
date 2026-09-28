/**
 * Reading a tool result's `structuredContent` honestly (#1408).
 *
 * Every test double in this tree declares `structuredContent` OPTIONAL,
 * because MCP's `CallToolResult` genuinely makes it optional. But the tools
 * this server ships always populate it, and the two idioms the tests used to
 * read it are both lies about that:
 *
 * - `out.structuredContent!.foo` is a non-null assertion — a promise the
 *   compiler cannot check, standing in for an assertion nobody wrote.
 * - `out.structuredContent as SomeShape` is a CAST of a possibly-absent
 *   value. When the field is absent this does not fail; it types as
 *   `SomeShape` and every read off it is `undefined`, which is how a payload
 *   assertion passes against a payload that was never there.
 *
 * `structured()` replaces both with the one thing that is actually true: the
 * field IS there, and if it ever is not, the test says so by name.
 *
 * ## Why the type argument is not a cast
 *
 * `structured<Row>(out)` states, at the call site, the shape the test
 * expects the payload to have. That is the same claim `as Row` made, so it is
 * not new checking — what is new is that the CLAIM is now visible in one
 * token instead of spread across a variable and a cast, and that the presence
 * of the field is proved rather than assumed. Tests that want the stricter
 * property should read the field off the returned record and let the assertion
 * do the rest; `structured` deliberately returns `T`, not `any`.
 */
import assert from 'node:assert/strict';

/** The minimum a tool result has to expose for `structured` to read it. */
type MaybeStructured = { structuredContent?: Record<string, unknown> };

/**
 * `result.structuredContent` as `T`, having asserted that the field is
 * present.
 *
 * @param result - A tool call result (or a test double's stand-in for one).
 * @returns The structured payload, typed as the caller expects it.
 */
export function structured<T = Record<string, unknown>>(result: MaybeStructured): T {
  const payload = result.structuredContent;
  assert.ok(
    payload !== undefined,
    'tool result carried no structuredContent — an assertion about its shape would be vacuous',
  );
  return payload as T;
}

/**
 * `result.structuredContent` as a plain record, with a NON-EMPTY claim.
 *
 * Some tests only need "there is a payload" before reading a field off it; for
 * those, an empty object is as vacuous as an absent one, so this variant also
 * refuses the empty case and says which tool produced it.
 */
export function structuredNonEmpty<T = Record<string, unknown>>(
  result: MaybeStructured,
  tool?: string,
): T {
  const payload = structured<Record<string, unknown>>(result);
  assert.ok(
    Object.keys(payload).length > 0,
    `tool result carried an empty structuredContent${tool ? ` (${tool})` : ''}`,
  );
  return payload as T;
}
