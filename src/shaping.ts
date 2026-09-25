/**
 * Shared shaping helpers for tool responses (#51/#52/#53/#57/#58): zod schema
 * fragments, truncation math, pagination info, structuredContent emission,
 * mutation batch summaries and dry-run descriptions.
 *
 * Pure module: no imports from client or tool modules.
 */
import { z } from 'zod';
import { DEFAULT_MAX_ITEMS } from './config.js';

// ---------------------------------------------------------------------------
// Shared zod fragments (#51/#53/#57)
// ---------------------------------------------------------------------------

/** `response_format` option shared by every tool (#51). Default 'concise'. */
export const ResponseFormat = z
  .enum(['concise', 'detailed', 'json'])
  .default('concise')
  .describe("'concise' = human prose, 'detailed' = more fields in prose, 'json' = raw API object");
export type ResponseFormatValue = z.infer<typeof ResponseFormat>;

/** Optional per-call truncation override for list-type tools (#53). */
export const MaxResults = z
  .number()
  .int()
  .positive()
  .max(2000)
  .optional()
  .describe(`Max items to return (default: SPOTIFY_MCP_MAX_ITEMS env or ${DEFAULT_MAX_ITEMS})`);

/** Opt-in preview mode for destructive operations (#57). */
export const DryRun = z
  .boolean()
  .optional()
  .describe(
    'Preview only: validate inputs and describe exactly what would change without performing it',
  );

/**
 * Field fragment to spread into a list-type tool's args shape. Tools add
 * their own fields alongside; wave B composes:
 *   z.object({ ...sharedListFields, id: z.string() })
 */
export const CHUNK_CAPS = {
  tracks: 50, albums: 20, artists: 50, episodes: 50, shows: 50, audiobooks: 50, chapters: 50,
  playlist_writes: 100, library_writes: 40, followed: 50,
} as const;

export const sharedListFields = {
  response_format: ResponseFormat,
  max_results: MaxResults,
} as const;

// ---------------------------------------------------------------------------
// Truncation math (#53)
// ---------------------------------------------------------------------------

export interface TruncationCapabilities {
  maxResults?: boolean;
  offset?: boolean;
  fetchAll?: boolean;
  scanCap?: boolean;
  limit?: boolean;
}

export interface TruncationMetadata {
  truncated: true;
  returned: number;
  total: number;
  remaining: number;
  next_offset?: number;
}

export interface TruncationResult<T> {
  /** Items to render (already sliced). */
  items: T[];
  total: number;
  returned: number;
  truncated: boolean;
  remaining: number;
  /** Human footer when truncated; null otherwise. */
  footer: string | null;
}

function directFooterAdvice(capabilities: TruncationCapabilities | undefined): string {
  return capabilities === undefined
    ? 'pass offset or fetch_all'
    : truncationAdvice(capabilities);
}

/** Continuation advice containing only controls present in the tool schema. */
export function truncationAdvice(capabilities: TruncationCapabilities): string {
  const advice: string[] = [];
  if (capabilities.maxResults) advice.push('raise max_results');
  if (capabilities.offset) advice.push('continue with offset');
  if (capabilities.fetchAll) advice.push('set fetch_all');
  if (capabilities.scanCap) advice.push('raise scan_cap');
  if (capabilities.limit) advice.push('raise limit');
  return advice.length > 0 ? advice.join(', ') : 'narrow the query';
}

/**
 * Slice `items` down to `maxResults` (clamped to >= 1) and compute a footer
 * from the continuation controls accepted by the calling tool.
 *
 * The default preserves the historical direct-helper contract. Production
 * registration passes a schema-derived descriptor, and the result boundary
 * repairs legacy callers that still use the default.
 */
export function truncateItems<T>(
  items: readonly T[],
  maxResults: number,
  capabilities?: TruncationCapabilities,
): TruncationResult<T> {
  const cap = Number.isFinite(maxResults) ? Math.max(1, Math.floor(maxResults)) : DEFAULT_MAX_ITEMS;
  if (items.length <= cap) {
    return {
      items: [...items],
      total: items.length,
      returned: items.length,
      truncated: false,
      remaining: 0,
      footer: null,
    };
  }
  const remaining = items.length - cap;
  return {
    items: items.slice(0, cap),
    total: items.length,
    returned: cap,
    truncated: true,
    remaining,
    footer: `${remaining} more — ${directFooterAdvice(capabilities)}`,
  };
}

/**
 * Effective per-call cap: explicit argument wins over the configured default
 * (which already reflects SPOTIFY_MCP_MAX_ITEMS via config).
 */
export function resolveMaxResults(explicit: number | undefined, fallback = DEFAULT_MAX_ITEMS): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }
  return Math.max(1, Math.floor(fallback));
}

export interface CompletenessFooterOptions {
  fetched: number;
  cap: number;
  truncated: boolean;
  subject?: string;
  total?: number | null;
  capabilities?: TruncationCapabilities;
}

/** Canonical wording for complete versus cap-truncated collection walks. */
export function completenessFooter(options: CompletenessFooterOptions): string {
  const subject = options.subject ?? 'items';
  const total = typeof options.total === 'number' ? ` of ${options.total}` : '';
  const advice = options.truncated && options.capabilities
    ? `; ${truncationAdvice(options.capabilities)}`
    : '';
  return options.truncated
    ? `fetched ${options.fetched}${total} ${subject}, cap ${options.cap} — TRUNCATED; older ${subject} were not analyzed${advice}`
    : `fetched ${options.fetched}${total} ${subject}, cap ${options.cap} — complete; cap not reached`;
}

type JsonObject = Record<string, unknown>;

const CONTINUATION_KEYS: Record<keyof TruncationCapabilities, string> = {
  maxResults: 'max_results',
  offset: 'offset',
  fetchAll: 'fetch_all',
  scanCap: 'scan_cap',
  limit: 'limit',
};

function schemaKeys(inputSchema: unknown): Set<string> {
  if (inputSchema == null || typeof inputSchema !== 'object') return new Set();
  const shape = 'shape' in inputSchema
    ? (inputSchema as { shape?: unknown }).shape
    : inputSchema;
  if (shape == null || typeof shape !== 'object') return new Set();
  return new Set(Object.keys(shape));
}

function capabilitiesForSchema(inputSchema: unknown): Required<TruncationCapabilities> {
  const keys = schemaKeys(inputSchema);
  return {
    maxResults: keys.has('max_results'),
    offset: keys.has('offset'),
    fetchAll: keys.has('fetch_all'),
    scanCap: keys.has('scan_cap'),
    limit: keys.has('limit'),
  };
}

function positiveArgument(args: JsonObject, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function truncationCap(
  args: JsonObject,
  capabilities: Required<TruncationCapabilities>,
): number | undefined {
  if (capabilities.maxResults) return resolveMaxResults(positiveArgument(args, 'max_results'));
  if (capabilities.limit) return positiveArgument(args, 'limit');
  return undefined;
}

function findReturnedItems(payload: JsonObject): unknown[] | undefined {
  if (Array.isArray(payload.items)) return payload.items;
  for (const [key, value] of Object.entries(payload)) {
    if (Array.isArray(value) && /^(entries|items|rows|results|tracks|albums|artists|episodes|playlists|shows|audiobooks|top_tracks)$/.test(key)) {
      return value;
    }
  }
  return undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function metadataFromPayload(
  payload: JsonObject,
  args: JsonObject,
  capabilities: Required<TruncationCapabilities>,
  inferredRemaining: number | undefined,
  itemsWereSliced: boolean,
  cap: number | undefined,
): TruncationMetadata | undefined {
  const pagination = payload.pagination != null && typeof payload.pagination === 'object'
    ? payload.pagination as JsonObject
    : undefined;
  const items = findReturnedItems(payload);
  const explicitReturned = numberField(payload.returned);
  const returned = itemsWereSliced
    ? cap!
    : explicitReturned ?? items?.length ?? cap;
  const explicitTotal = numberField(payload.total)
    ?? numberField(pagination?.total)
    ?? numberField(payload.unique_tracks);
  const remaining = inferredRemaining
    ?? (explicitTotal !== undefined && returned !== undefined ? Math.max(0, explicitTotal - returned) : undefined);
  if (returned === undefined || remaining === undefined) return undefined;
  const total = explicitTotal ?? returned + remaining;
  const existingNextOffset = numberField(payload.next_offset) ?? numberField(pagination?.next_offset);
  const nextOffset = capabilities.offset
    ? existingNextOffset ?? (
      itemsWereSliced || remaining > 0
        ? (numberField(args.offset) ?? 0) + returned
        : undefined
    )
    : undefined;
  return {
    truncated: true,
    returned,
    total,
    remaining,
    ...(nextOffset !== undefined ? { next_offset: nextOffset } : {}),
  };
}

function mentionsAcceptedControl(text: string, capabilities: Required<TruncationCapabilities>): boolean {
  return (Object.entries(capabilities) as Array<[keyof TruncationCapabilities, boolean]>)
    .some(([capability, accepted]) => accepted && text.includes(CONTINUATION_KEYS[capability]));
}

export interface TruncationBoundary {
  shape(toolName: string, args: unknown, result: unknown): unknown;
  capabilities(toolName: string): Required<TruncationCapabilities> | undefined;
}

/**
 * Install the production tools/call result boundary before any tools are
 * registered. Schemas are inspected once; unchanged successful results are
 * returned by identity.
 */
export function installTruncationBoundary(server: object): TruncationBoundary {
  const descriptors = new Map<string, Required<TruncationCapabilities>>();
  const advice = new Map<string, string>();
  const api = server as {
    tool: (...args: unknown[]) => unknown;
    registerTool: (...args: unknown[]) => unknown;
  };
  const originalTool = api.tool.bind(server);
  const originalRegisterTool = api.registerTool.bind(server);

  const remember = (name: string, inputSchema: unknown, callbackIndex: number, args: unknown[]): void => {
    if (typeof args[callbackIndex] !== 'function') return;
    const capabilities = capabilitiesForSchema(inputSchema);
    descriptors.set(name, capabilities);
    advice.set(name, truncationAdvice(capabilities));
    const callback = args[callbackIndex] as (...callArgs: unknown[]) => unknown;
    args[callbackIndex] = async (...callArgs: unknown[]) => shape(
      name,
      callArgs[0],
      await callback(...callArgs),
    );
  };

  const shape = (toolName: string, argsValue: unknown, resultValue: unknown): unknown => {
    const capabilities = descriptors.get(toolName);
    if (!capabilities || resultValue == null || typeof resultValue !== 'object') return resultValue;
    const result = resultValue as JsonObject;
    if (result.isError === true) return resultValue;
    const content = Array.isArray(result.content) ? result.content : undefined;
    const textBlock = content?.find((block) =>
      block != null && typeof block === 'object'
      && (block as JsonObject).type === 'text'
      && typeof (block as JsonObject).text === 'string'
    ) as { type: 'text'; text: string } | undefined;
    const text = textBlock?.text;
    const footerMatch = typeof text === 'string'
      ? /\b(\d+)\s+more\s+[—-]\s+([^)\n]+)(\))?/i.exec(text)
      : undefined;
    const markedTruncated = result.structuredContent != null
      && typeof result.structuredContent === 'object'
      && (result.structuredContent as JsonObject).truncated === true;
    const completeness = typeof text === 'string' ? /\bfetched\s+(\d+)(?:\s+of\s+(\d+))?\b[^—\n]*—\s*TRUNCATED\b/i.exec(text) : undefined;
    let payload = result.structuredContent != null && typeof result.structuredContent === 'object'
      ? result.structuredContent as JsonObject
      : undefined;
    let parsedJson = false;
    if (typeof text === 'string' && /^\s*[{[]/.test(text)) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          parsedJson = true;
          if (!payload) payload = parsed as JsonObject;
        }
      } catch {
        // Non-JSON prose beginning with a brace is not a machine result.
      }
    }
    const args = argsValue != null && typeof argsValue === 'object' && !Array.isArray(argsValue)
      ? argsValue as JsonObject
      : {};
    if (!payload && completeness) {
      const fetched = Number(completeness[1]);
      const total = Number(completeness[2] ?? completeness[1]);
      payload = { returned: fetched, total, remaining: Math.max(0, total - fetched) };
    }
    if (!payload && footerMatch != null) payload = {};
    const items = payload ? findReturnedItems(payload) : undefined;
    const cap = truncationCap(args, capabilities);
    const itemsWereSliced = items !== undefined && cap !== undefined && items.length > cap;
    const declaredTotal = payload
      ? numberField(payload.total)
        ?? numberField((payload.pagination as JsonObject | undefined)?.total)
        ?? numberField(payload.unique_tracks)
      : undefined;
    const returned = numberField(payload?.returned) ?? items?.length ?? (itemsWereSliced ? cap : undefined);
    const inferredRemaining = footerMatch != null
      ? Number(footerMatch[1])
      : completeness != null
        ? Math.max(0, Number(completeness[2] ?? completeness[1]) - Number(completeness[1]))
        : itemsWereSliced
          ? items!.length - cap!
          : numberField(payload?.remaining)
            ?? (declaredTotal !== undefined && returned !== undefined ? Math.max(0, declaredTotal - returned) : undefined);
    const shortPage = returned !== undefined && declaredTotal !== undefined && returned < declaredTotal;
    const hasTruncationSignal = markedTruncated || footerMatch != null || completeness != null || shortPage;
    if (!payload || (!hasTruncationSignal && !itemsWereSliced)) return resultValue;
    const metadata = metadataFromPayload(payload, args, capabilities, inferredRemaining, itemsWereSliced, cap);
    if (!metadata) return resultValue;
    const nextPayload: JsonObject = { ...payload, ...metadata };
    if (itemsWereSliced && items) {
      const sliced = items.slice(0, cap!);
      for (const [key, value] of Object.entries(nextPayload)) {
        if (value === items) nextPayload[key] = sliced;
      }
    }
    let nextText = text;
    if (footerMatch && typeof text === 'string') {
      nextText = text.replace(footerMatch[0], `${metadata.remaining} more — ${advice.get(toolName)}${footerMatch[3] ?? ''}`);
    } else if (typeof text === 'string' && !parsedJson && !mentionsAcceptedControl(text, capabilities)) {
      nextText = `${text}\n(${metadata.remaining} more — ${advice.get(toolName)})`;
    }
    const metadataChanged = Object.keys(metadata).some((key) =>
      payload[key] !== metadata[key as keyof TruncationMetadata]
    );
    const itemsChanged = itemsWereSliced
      && Object.entries(nextPayload).some(([key, value]) => payload[key] !== value);
    const textChanged = nextText !== undefined && nextText !== text;
    if (!metadataChanged && !itemsChanged && !textChanged) return resultValue;
    const nextResult: JsonObject = { ...result, structuredContent: nextPayload };
    if (nextText !== undefined) {
      nextResult.content = content!.map((block) =>
        block === textBlock
          ? { ...(block as JsonObject), text: parsedJson ? JSON.stringify(nextPayload, null, 2) : nextText }
          : block
      );
    }
    return nextResult;
  };

  api.tool = (...args: unknown[]) => {
    const name = args[0] as string;
    const callbackIndex = args.length - 1;
    const inputSchema = args.slice(1, callbackIndex).find((value) =>
      value != null && typeof value === 'object'
      && (Object.keys(value).length === 0 || Object.values(value).some((entry) => entry != null && typeof entry === 'object'))
    );
    remember(name, inputSchema, callbackIndex, args);
    return originalTool(...args);
  };
  api.registerTool = (...args: unknown[]) => {
    const name = args[0] as string;
    const config = args[1] != null && typeof args[1] === 'object' ? args[1] as JsonObject : {};
    remember(name, config.inputSchema, 2, args);
    return originalRegisterTool(...args);
  };

  return {
    shape,
    capabilities: (toolName) => descriptors.get(toolName),
  };
}

// ---------------------------------------------------------------------------
// Pagination info + structuredContent emission (#52)
// ---------------------------------------------------------------------------

export interface PaginationInfo {
  total: number | null;
  offset: number;
  limit: number | null;
  returned: number;
  /** Offset to pass on the next call for continued enumeration; null when done. */
  next_offset: number | null;
}

export function paginationInfo(opts: {
  total?: number | null;
  offset?: number;
  limit?: number | null;
  returned: number;
}): PaginationInfo {
  const offset = opts.offset ?? 0;
  const total = typeof opts.total === 'number' ? opts.total : null;
  let nextOffset: number | null = null;
  if (opts.returned > 0) {
    if (total !== null) {
      nextOffset = offset + opts.returned < total ? offset + opts.returned : null;
    } else {
      // Unknown total: there may be more whenever we got a full page.
      nextOffset =
        opts.limit == null || opts.returned >= opts.limit ? offset + opts.returned : null;
    }
  }
  return {
    total,
    offset,
    limit: opts.limit ?? null,
    returned: opts.returned,
    next_offset: nextOffset,
  };
}

/**
 * Machine-readable payload emitted as MCP structuredContent alongside the
 * human text (#52). `extra` carries endpoint-specific top-level fields.
 */
export function listStructuredContent<T>(
  items: readonly T[],
  pagination: PaginationInfo,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    items: [...items],
    pagination: {
      total: pagination.total,
      offset: pagination.offset,
      limit: pagination.limit,
      next_offset: pagination.next_offset,
    },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Mutation batch summary line (#58)
// ---------------------------------------------------------------------------

/** "{n} items affected: uri0, uri1, uri2…" — confirmation-friendly audit echo. */
export function batchSummary(n: number, uris: readonly string[], previewCount = 3): string {
  const noun = n === 1 ? 'item' : 'items';
  if (n <= 0 || uris.length === 0) return `${n} ${noun} affected`;
  const preview = uris.slice(0, previewCount).join(', ');
  const ellipsis = uris.length > previewCount ? '…' : '';
  return `${n} ${noun} affected: ${preview}${ellipsis}`;
}

// ---------------------------------------------------------------------------
// dry_run validation + description (#57)
// ---------------------------------------------------------------------------

const URI_RE = /^spotify:(track|album|artist|playlist|show|episode|audiobook|user):(.+)$/;

/** Parse a spotify: URI into { type, id }, or null when malformed. */
export function parseSpotifyUri(uri: string): { type: string; id: string } | null {
  const match = URI_RE.exec(uri.trim());
  if (!match) return null;
  return { type: match[1], id: match[2] };
}

/**
 * Partition candidate URIs for dry_run validation (#57). When `expectedTypes`
 * is given, URIs of any other type land in `invalid` too.
 */
export function validateUris(
  uris: readonly string[],
  expectedTypes?: readonly string[],
): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const uri of uris) {
    const parsed = parseSpotifyUri(uri);
    const acceptable =
      parsed !== null &&
      (expectedTypes === undefined || expectedTypes.length === 0 || expectedTypes.includes(parsed.type));
    if (acceptable) valid.push(uri);
    else invalid.push(uri);
  }
  return { valid, invalid };
}

/**
 * Deterministic description of what a destructive operation WOULD do (#57).
 * Rendered by tools when dry_run is set — no mutating endpoint is called.
 */
export function describeDryRun(action: string, target: string, changes: readonly string[]): string {
  const lines = [`[dry run] ${action} on ${target} — nothing was changed.`];
  if (changes.length > 0) {
    lines.push(`Would affect ${changes.length} item${changes.length === 1 ? '' : 's'}:`);
    for (const change of changes) lines.push(`  - ${change}`);
  }
  return lines.join('\n');
}
