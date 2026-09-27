/**
 * The one place a tool result is built (#582).
 *
 * Before this module, twenty-one modules each carried their own
 * `textResult` and thirteen their own `emit`, in two mutually incompatible
 * argument orders that both type-checked: `emit(fmt, echo, text)` in
 * `playbackext.ts` and `emit(rf, prose, payload)` in `exhaust2_catalog.ts`
 * are the same function with the payload and the prose swapped, and nothing
 * but reading both signatures told you which one you had. A copy that
 * silently swaps prose and JSON still compiles, still returns a
 * well-formed `CallToolResult`, and tells the caller it sent something other
 * than what it sent — the failure mode AGENTS.md §6 exists to prevent.
 *
 * So there is exactly one `textResult` and exactly one `emit` here, and no
 * module defines its own. The differences that were genuinely different are
 * parameters whose names say what they do:
 *
 *   - {@link formatDuration} takes a {@link DurationStyle}, because
 *     `audiobookcopilot.ts` renders "1h 5m" where the rest of the server
 *     renders "65:00", and `resources/templates.ts` rounds the seconds
 *     instead of truncating them. Both were correct at their call sites and
 *     neither is a bug, so both are named rather than one of them winning.
 *   - {@link textResult} attaches `structuredContent` only when one is
 *     given, because half the call sites pass prose alone and inventing an
 *     empty `{}` for them would be a new field on the wire.
 *
 * Pure module: no imports.
 */

/** A single text block in a tool result. */
export type TextContent = { type: 'text'; text: string };

/**
 * The result shape every tool in this server returns.
 *
 * `structuredContent` is optional because a prose-only result has none; the
 * omission is deliberate and load-bearing (see {@link textResult}). `isError`
 * is optional for the same reason — most results are not errors, and MCP's
 * default for an absent `isError` is `false`.
 *
 * A `type` alias, not an `interface`, on purpose: TypeScript gives an object
 * type alias an implicit index signature and does not give one to an
 * interface, and the SDK's inferred `CallToolResult` has a catch-all — so an
 * `interface` here is not assignable to a tool callback and every `server.tool`
 * registration in the server stops type-checking.
 */
export type ToolResult = {
  content: TextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Build a tool result from prose. `structured` rides along when given. */
export function textResult(text: string, structured?: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text }], ...(structured ? { structuredContent: structured } : {}) };
}

/**
 * Raw-JSON rendering for `response_format: 'json'` (#51).
 *
 * Two-space indent: it is what every `json` response in this server has
 * always been, and a host diffing two responses sees the same bytes.
 */
export function jsonText(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

/**
 * The two places a module's result genuinely differs from the house shape.
 *
 * Both are one module each, and both have been that way since #51, so neither
 * is a copy that drifted — they are contracts. They are named here rather than
 * left as a module-local function, because a local function is invisible: a
 * reviewer comparing `emit` across modules sees agreement everywhere except
 * the two modules that do it differently, and cannot tell a deliberate
 * difference from a drifted one.
 */
export interface EmitOptions {
  /**
   * Spaces of indent in the `json` body. `0` emits it compact, which is what
   * the `playback.ts` family has always returned.
   */
  jsonIndent?: number;
  /**
   * Whether PROSE mode also carries the payload as `structuredContent` (#52).
   * `false` is the `playback.ts` exception, which returns prose alone. It
   * says nothing about `json` mode: there the payload is the message, so it is
   * always attached whatever this is set to.
   */
  proseCarriesPayload?: boolean;
  /**
   * In `json` mode, print THIS instead of the payload (#895).
   *
   * The default mirrors the payload into the text block, and the host already
   * has it as `structuredContent` — one payload, two copies, charged twice.
   * A call site whose payload can be large (a move plan, a capped section set)
   * passes a summariser here and the text block becomes a bounded line that
   * names the channel the data is in.
   *
   * **The text block is then NOT valid JSON, deliberately.** A mirrored JSON
   * block is the copy being removed; replacing it with a pointer is what makes
   * the saving real. The trade is that a client reading only `content[].text`
   * no longer finds the object there, which is why this is opt-in per call site
   * rather than a change to the default — SPEC.md §5 promises "the raw API
   * payload as JSON text", and the json branches that keep the mirrored form
   * are how that promise is kept.
   *
   * A summariser that interpolates a list must bound it: a summary that is
   * itself unbounded is no saving at all.
   */
  jsonSummary?: (payload: Record<string, unknown>) => string;
}

/**
 * The prose-or-JSON result every tool that honours `response_format` returns.
 *
 * In `json` mode the caller gets the payload printed and the prose discarded;
 * in any other mode the prose stands and the payload still rides as
 * `structuredContent` (#52 — the machine-readable half is not conditional on
 * the format, or a host would have to ask twice to learn the same thing).
 *
 * Argument order is prose-then-payload, matching the call sites that read
 * most naturally that way and matching the `shape` helper this replaces.
 * Passing them the other way round still type-checks — that is precisely why
 * nine modules had it the other way round — so read the call:
 * `emit(fmt, prose, payload)`.
 *
 * A module whose payload can be large passes `{ jsonSummary }` rather than
 * defining its own wrapper: the wrapper is the drift #582 exists to prevent,
 * and the summary is a per-call-site decision, so it is an option here (#895).
 */
export function emit(
  fmt: string | undefined,
  prose: string,
  payload: Record<string, unknown>,
  options: EmitOptions = {},
): ToolResult {
  const indent = options.jsonIndent ?? 2;
  const isJson = fmt === 'json';
  // #895 — `jsonSummary` replaces the mirrored print with a bounded line. The
  // payload still rides as `structuredContent` either way, so nothing is lost;
  // what is removed is the second copy of it.
  const body = isJson
    ? options.jsonSummary
      ? options.jsonSummary(payload)
      : JSON.stringify(payload, null, indent)
    : prose;
  // `proseCarriesPayload` is about prose. Gating on it unconditionally would
  // drop `structuredContent` from json mode too, where it has always been
  // present and where the printed payload and the structured one are the same
  // object read two ways.
  const carries = isJson || options.proseCarriesPayload !== false;
  return {
    content: [{ type: 'text', text: body }],
    ...(carries ? { structuredContent: payload } : {}),
  };
}

/**
 * How a duration is rendered.
 *
 * - `m:ss` — minutes and zero-padded seconds, seconds truncated. The default,
 *   and what Spotify's own `duration_ms` columns read as.
 * - `rounded` — as `m:ss`, but the second count is rounded to nearest rather
 *   than truncated, so 1.6s reads `0:02`. Used by the episode/track resource
 *   cards, which show a resume position to the second.
 * - `words` — "1h 5m" / "5m 3s" / "3s". Used by the audiobook copilot, whose
 *   answers are read aloud rather than scanned.
 */
export type DurationStyle = 'm:ss' | 'rounded' | 'words';

/** Human-readable duration for prose rows. */
export function formatDuration(ms: number, style: DurationStyle = 'm:ss'): string {
  if (style === 'words') {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }
  if (style === 'rounded') {
    const totalSeconds = Math.round(ms / 1000);
    return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
  }
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * A duration that may be missing, rendered as `unknown` rather than as `NaN`
 * or `0:00`.
 *
 * `null`, `undefined` and `NaN` are all "we do not know", and every caller
 * that has to render a missing `duration_ms` in a prose row wants the same
 * word for all three. Guessing a number is how a chart shows `0:00` for a
 * track whose duration never came back (#803's failure, one column over).
 */
export function formatDurationOrUnknown(ms: number | null | undefined): string {
  return typeof ms === 'number' && Number.isFinite(ms) ? formatDuration(ms) : 'unknown';
}
