/**
 * Reading an MCP tool result without lying about its shape (#606).
 *
 * ## Why this module exists
 *
 * The SDK types `CallToolResult['content']` as `unknown`, because the
 * compatibility schema admits several result shapes. Three subcommands needed
 * the same three facts out of it — the text, the structured payload and
 * whether the tool set `isError` — and each reaching for a cast would be three
 * places where an `as` could turn a malformed result into a confident answer.
 *
 * The rules this module holds to:
 *
 *   - **No `as`.** Everything narrows through `asRecord`/`readString` from
 *     `src/shaping.ts`, the repo's own narrowing vocabulary. A content part
 *     that is not `{ type: 'text', text: string }` is described by its `type`
 *     rather than being rendered as an empty string, because a blank line
 *     would read as "the tool said nothing" when in fact the tool said
 *     something this decoder does not understand.
 *   - **A missing `structuredContent` is `null`, not `{}`.** A tool that
 *     publishes no structured payload and a tool that published an empty one
 *     are different facts, and the JSON output has to be able to tell them.
 *   - **The error envelope is returned as-is or as `null`.** It is never
 *     synthesised from a missing field, so a caller cannot read
 *     `reason: 'unknown'` as something the server said.
 */

import { asRecord, readString } from '../shaping.js';

export interface DecodedResult {
  /** Every text part, joined with newlines. Non-text parts are named inline. */
  readonly text: string;
  /** `structuredContent` when it is an object, else null. */
  readonly structured: Record<string, unknown> | null;
  readonly isError: boolean;
  /** `structuredContent.error` when it is an object, else null. */
  readonly error: Record<string, unknown> | null;
}

/**
 * Decode a `CallToolResult`-shaped value.
 *
 * Every field is read defensively because a CLI is the last place a malformed
 * payload should turn into a confident answer: a caller that cannot decode the
 * text still gets `isError`, and the subcommand's own error branch reports
 * that it could not read the payload rather than printing an empty success.
 */
export function decodeToolResult(result: unknown): DecodedResult {
  const row = asRecord(result);
  const parts: string[] = [];
  const content = row?.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      const partRow = asRecord(part);
      if (partRow === undefined) {
        parts.push('[unrecognised content part]');
        continue;
      }
      const type = readString(partRow, 'type');
      if (type === 'text') {
        const text = readString(partRow, 'text');
        parts.push(text ?? '[text content with no text field]');
      } else {
        // Named, not dropped and not blanked. A host that renders image or
        // resource content is showing a user something; replacing it with an
        // empty line would make the CLI's output a lossy copy that looks
        // complete.
        parts.push(`[${type ?? 'unknown'} content]`);
      }
    }
  }
  const structured = asRecord(row?.structuredContent) ?? null;
  const error = asRecord(structured?.error) ?? null;
  return {
    text: parts.join('\n'),
    structured,
    isError: row?.isError === true,
    error,
  };
}
