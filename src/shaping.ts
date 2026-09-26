/**
 * Shared shaping helpers for tool responses (#51/#52/#53/#57/#58): zod schema
 * fragments, truncation math, pagination info, structuredContent emission,
 * mutation batch summaries and dry-run descriptions.
 *
 * Imports no client or tool module. It does import history.js for one thing:
 * `installTruncationBoundary` wraps every tool handler, which makes it the
 * only place that knows the running tool's name, and the mutation ledger
 * needs that name for each record's `who` (#591).
 */
import { z } from 'zod';
import { classifySpotifyReference } from './refs.js';
import { DEFAULT_MAX_ITEMS, getConfig } from './config.js';
import { runInToolContext } from './history.js';
import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';

/** Exact root input schema projected onto the production tools/list boundary. */
export function finalInputSchema(input: unknown): Record<string, unknown> {
  const objectSchema = normalizeObjectSchema(input as Parameters<typeof normalizeObjectSchema>[0]);
  const schema = objectSchema
    ? toJsonSchemaCompat(objectSchema, { pipeStrategy: 'input' })
    : { type: 'object', properties: {} };
  schema.additionalProperties = false;
  delete schema.$schema;
  return schema;
}

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

/**
 * Per-request cap for a `/me/library` write (#624). Spotify rejects a PUT or
 * DELETE carrying more than 40 uris. `restore.ts` and `undo.ts` import this
 * rather than each hardcoding the number, which is how the two drifted apart.
 * The read endpoint `/me/library/contains` takes 50 and is capped separately.
 */
export const LIBRARY_WRITE_CHUNK = CHUNK_CAPS.library_writes;

export const sharedListFields = {
  response_format: ResponseFormat,
  max_results: MaxResults,
} as const;

// ---------------------------------------------------------------------------
// Canonical playlist set-operation inputs (#912)
// ---------------------------------------------------------------------------

/**
 * Normalize the public playlist-reference forms to the raw ID used in
 * `/playlists/{id}` paths. Spotify share URIs and open.spotify.com playlist
 * URLs are equivalent to bare IDs on the wire.
 */
export function normalizePlaylistReference(reference: string): string {
  const parsed = classifySpotifyReference(reference, 'playlist');
  if (!parsed.valid || !parsed.id) {
    throw new Error(`Invalid playlist reference: ${parsed.error ?? 'invalid Spotify playlist reference'}`);
  }
  return parsed.id;
}

/** One playlist reference, normalized before any handler sees it. */
export const PlaylistRef = z
  .string()
  .min(1)
  .transform(normalizePlaylistReference)
  .describe('Playlist ID, spotify:playlist: URI, or Spotify playlist URL; use this reference in the canonical or documented legacy field');

interface PlaylistListLimits {
  readonly min?: number;
  readonly max?: number;
}

/** Canonical ordered collection with an operation-specific cardinality. */
function playlistListFields({ min = 2, max = 10 }: PlaylistListLimits = {}) {
  return {
    playlists: z
      .array(PlaylistRef)
      .min(min)
      .max(max)
      .optional()
      .describe(`Canonical ordered playlists (${min}–${max}), or provide the complete documented legacy alias accepted by this tool`),
  } as const;
}

export const PlaylistId = PlaylistRef;

/** Canonical plural input; exactly one canonical/legacy collection is required. */
export const PlaylistListFields = playlistListFields();

/** Canonical A-then-B pair; provide both fields or one complete documented legacy pair. */
export const PlaylistPairFields = {
  playlist_a: PlaylistRef.optional().describe('Canonical A playlist; provide with playlist_b or one complete documented legacy pair'),
  playlist_b: PlaylistRef.optional().describe('Canonical B playlist; provide with playlist_a or one complete documented legacy pair'),
} as const;

/** Shared mutation target: an existing playlist or a new playlist name. */
export const TargetPlaylistFields = {
  target_playlist_id: PlaylistRef.optional().describe('Existing target playlist (ID, URI, or URL); provide exactly one of target_playlist_id or target_name'),
  target_name: z.string().optional().describe('Name for a newly created target playlist; provide exactly one of target_playlist_id or target_name'),
} as const;

type PlaylistListAlias =
  | 'playlist_ids'
  | 'source_playlist_ids'
  | 'subtract_playlist_ids'
  | 'sources';

type PlaylistPairSide =
  | 'playlist_id_a' | 'playlist_a_id' | 'a'
  | 'playlist_id_b' | 'playlist_b_id' | 'b';

type PlaylistPairAlias = readonly [PlaylistPairSide, PlaylistPairSide];

/** Legacy aliases are supported through v2.0 and removed in v2.1. */
export function legacyPlaylistListFields<const A extends PlaylistListAlias>(
  aliases: readonly A[],
  limits: PlaylistListLimits = {},
): Record<A, z.ZodOptional<z.ZodArray<typeof PlaylistRef>>> {
  const schema = z.array(PlaylistRef).min(limits.min ?? 2).max(limits.max ?? 10)
    .describe('Deprecated one-release alias supported through v2.0; removed in v2.1. Provide this complete alias or canonical playlists.');
  return Object.fromEntries(aliases.map((name) => [name, schema.optional()])) as Record<
    A,
    z.ZodOptional<z.ZodArray<typeof PlaylistRef>>
  >;
}


type PairAliasFields<P extends PlaylistPairSide> = {
  [K in P]: z.ZodOptional<typeof PlaylistRef>;
};

/** Legacy pair aliases are supported through v2.0 and removed in v2.1. */
export function legacyPlaylistPairFields<const P extends PlaylistPairSide>(
  aliases: readonly (readonly [P, P])[],
): PairAliasFields<P> {
  return Object.fromEntries(aliases.flatMap(([a, b]) => [
    [a, PlaylistRef.optional().describe('Deprecated one-release alias supported through v2.0; removed in v2.1. Provide a complete pair or canonical playlist_a/playlist_b.')],
    [b, PlaylistRef.optional().describe('Deprecated one-release alias supported through v2.0; removed in v2.1. Provide a complete pair or canonical playlist_a/playlist_b.')],
  ])) as PairAliasFields<P>;
}

/** Canonical and legacy list spellings share one cardinality contract. */
export function playlistListInputFields<const A extends PlaylistListAlias>(
  aliases: readonly A[],
  limits: PlaylistListLimits = {},
) {
  return {
    ...playlistListFields(limits),
    ...legacyPlaylistListFields(aliases, limits),
  };
}

interface PlaylistInputResolution {
  /** Canonical, normalized values in caller-supplied order. */
  values: string[];
  /** Legacy input names actually present on the call. */
  deprecatedInputs: string[];
  /** One-line migration note, or null for canonical-only calls. */
  deprecationNote: string | null;
}

type PlaylistInputConfig =
  | { kind: 'list'; aliases: readonly PlaylistListAlias[] }
  | { kind: 'pair'; aliases: readonly PlaylistPairAlias[] };

function orderedEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeResolvedPlaylistValue(value: unknown): string {
  return normalizePlaylistReference(String(value));
}

function normalizeInputList(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array of playlist references`);
  return value.map(normalizeResolvedPlaylistValue);
}

function resolution(values: string[], deprecatedInputs: string[], canonical: string): PlaylistInputResolution {
  if (deprecatedInputs.length === 0) {
    return { values, deprecatedInputs: [], deprecationNote: null };
  }
  return {
    values,
    deprecatedInputs: [...deprecatedInputs],
    deprecationNote: `Deprecated input${deprecatedInputs.length === 1 ? '' : 's'} ${deprecatedInputs.join(', ')}; use ${canonical}. Alias support ends with v2.1 (removed in 2.1).`,
  };
}

/**
 * Resolve one canonical playlist collection or A/B pair, accepting only the
 * declared one-release aliases. Matching aliases remain observable; missing,
 * incomplete, differently ordered, or conflicting values fail before I/O.
 */
export function resolvePlaylistInput(
  args: Readonly<Record<string, unknown>>,
  config: PlaylistInputConfig,
): PlaylistInputResolution {
  if (config.kind === 'list') {
    const canonical = args.playlists === undefined ? undefined : normalizeInputList(args.playlists, 'playlists');
    const deprecatedInputs: string[] = [];
    let selected = canonical;
    let selectedName = 'playlists';

    for (const alias of config.aliases) {
      if (args[alias] === undefined) continue;
      deprecatedInputs.push(alias);
      const candidate = normalizeInputList(args[alias], alias);
      if (selected === undefined) {
        selected = candidate;
        selectedName = alias;
      } else if (!orderedEqual(selected, candidate)) {
        throw new Error(`Conflicting playlist inputs ${selectedName} and ${alias}: values must match in the same order.`);
      }
    }

    if (selected === undefined) {
      const legacy = config.aliases.length > 0 ? ` (legacy aliases: ${config.aliases.join(', ')})` : '';
      throw new Error(`Missing required playlist input playlists${legacy}`);
    }
    return resolution(selected, deprecatedInputs, 'playlists');
  }

  const canonicalA = args.playlist_a === undefined ? undefined : normalizeResolvedPlaylistValue(args.playlist_a);
  const canonicalB = args.playlist_b === undefined ? undefined : normalizeResolvedPlaylistValue(args.playlist_b);
  if ((canonicalA === undefined) !== (canonicalB === undefined)) {
    throw new Error('Missing playlist pair: playlist_a and playlist_b must be provided together');
  }

  let selectedA = canonicalA;
  let selectedB = canonicalB;
  let selectedNames: readonly string[] = ['playlist_a', 'playlist_b'];
  const deprecatedInputs: string[] = [];

  for (const [aliasA, aliasB] of config.aliases) {
    const hasA = args[aliasA] !== undefined;
    const hasB = args[aliasB] !== undefined;
    if (!hasA && !hasB) continue;
    deprecatedInputs.push(aliasA, aliasB);
    if (hasA !== hasB) {
      throw new Error(`Incomplete deprecated playlist pair ${aliasA} and ${aliasB}: both values are required`);
    }
    const candidateA = normalizeResolvedPlaylistValue(args[aliasA]);
    const candidateB = normalizeResolvedPlaylistValue(args[aliasB]);
    if (selectedA === undefined || selectedB === undefined) {
      selectedA = candidateA;
      selectedB = candidateB;
      selectedNames = [aliasA, aliasB];
    } else if (selectedA !== candidateA || selectedB !== candidateB) {
      throw new Error(`Conflicting playlist inputs ${selectedNames[0]} and ${aliasA} (or ${selectedNames[1]} and ${aliasB}): A/B values must match.`);
    }
  }

  if (selectedA === undefined || selectedB === undefined) {
    const legacy = config.aliases.length > 0 ? ` (legacy aliases: ${config.aliases.flat().join(', ')})` : '';
    throw new Error(`Missing required playlist pair playlist_a and playlist_b${legacy}`);
  }
  return resolution([selectedA, selectedB], deprecatedInputs, 'playlist_a/playlist_b');
}

/** Add machine-readable deprecation metadata only when a legacy alias was used. */
export function withPlaylistInputMetadata<T extends Record<string, unknown>>(
  payload: T,
  resolved: PlaylistInputResolution,
  extraNote?: string,
): T | (T & { deprecated_inputs: string[]; deprecation_note: string }) {
  const note = resolved.deprecationNote === null ? extraNote : `${resolved.deprecationNote} ${extraNote ?? ''}`.trim();
  if (note === undefined || note === '') return payload;
  return {
    ...payload,
    deprecated_inputs: resolved.deprecatedInputs,
    deprecation_note: note,
  };
}

/** Append the same one-line migration note to prose/JSON text. */
export function withPlaylistInputNote(text: string, resolved: PlaylistInputResolution, extraNote?: string): string {
  const note = [resolved.deprecationNote, extraNote].filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ');
  return note === '' ? text : `${text}\n${note}`;
}

// ---------------------------------------------------------------------------
// Truncation math (#53)
// ---------------------------------------------------------------------------

interface TruncationCapabilities {
  maxResults?: boolean;
  maxItems?: boolean;
  offset?: boolean;
  fetchAll?: boolean;
  scanCap?: boolean;
  limit?: boolean;
}

interface TruncationMetadata {
  truncated: boolean;
  returned: number;
  total: number;
  remaining: number;
  next_offset?: number;
}

interface TruncationResult<T> {
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
function truncationAdvice(capabilities: TruncationCapabilities): string {
  const advice: string[] = [];
  if (capabilities.maxResults) advice.push('raise max_results');
  if (capabilities.maxItems) advice.push('raise max_items');
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
export function resolveMaxResults(explicit: number | undefined, fallback = getConfig().maxItems): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }
  return Math.max(1, Math.floor(fallback));
}

interface CompletenessFooterOptions {
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
  maxItems: 'max_items',
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
    maxItems: keys.has('max_items'),
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
  if (capabilities.maxResults) return resolveMaxResults(positiveArgument(args, 'max_results'), getConfig().maxItems);
  if (capabilities.maxItems) return resolveMaxResults(positiveArgument(args, 'max_items'), getConfig().maxItems);
  if (capabilities.limit) return positiveArgument(args, 'limit');
  return undefined;
}

function findReturnedItems(payload: JsonObject, inputKeys: ReadonlySet<string> = new Set()): unknown[] | undefined {
  if (Array.isArray(payload.items) && !inputKeys.has('items')) return payload.items;
  for (const [key, value] of Object.entries(payload)) {
    if (inputKeys.has(key)) continue;
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
  inputKeys: ReadonlySet<string>,
): TruncationMetadata | undefined {
  const pagination = payload.pagination != null && typeof payload.pagination === 'object'
    ? payload.pagination as JsonObject
    : undefined;
  const truncation = payload.truncation != null && typeof payload.truncation === 'object'
    ? payload.truncation as JsonObject
    : undefined;
  const items = findReturnedItems(payload, inputKeys);
  const explicitReturned = numberField(payload.returned) ?? numberField(truncation?.returned);
  const returned = itemsWereSliced
    ? cap!
    : explicitReturned ?? items?.length;
  const explicitTotal = numberField(payload.total)
    ?? numberField(pagination?.total)
    ?? numberField(payload.unique_tracks)
    ?? numberField(truncation?.total);
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
    truncated: remaining > 0,
    returned,
    total,
    remaining,
    ...(nextOffset !== undefined ? { next_offset: nextOffset } : {}),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface CanonicalFooterMatch {
  match: RegExpExecArray;
  count: number;
}

function canonicalFooterMatch(text: string, expectedAdvice: string): CanonicalFooterMatch | null {
  for (const candidate of [expectedAdvice, 'pass offset or fetch_all']) {
    const match = new RegExp(
      `\\(\\s*(?<parenthesized>\\d+) more — ${escapeRegExp(candidate)}\\s*\\)|(?<bare>\\d+) more — ${escapeRegExp(candidate)}`,
    ).exec(text);
    if (match) {
      const count = Number(match.groups?.parenthesized ?? match.groups?.bare);
      return Number.isFinite(count) ? { match, count } : null;
    }
  }
  return null;
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
  const inputKeysByTool = new Map<string, ReadonlySet<string>>();
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
    inputKeysByTool.set(name, schemaKeys(inputSchema));
    descriptors.set(name, capabilities);
    advice.set(name, truncationAdvice(capabilities));
    const callback = args[callbackIndex] as (...callArgs: unknown[]) => unknown;
    args[callbackIndex] = async (...callArgs: unknown[]) => shape(
      name,
      callArgs[0],
      // This wrapper is the one place that knows which tool is running, so it
      // is also where the mutation ledger's `who` actor comes from (#591).
      // Without it every record falls back to the 'agent' default.
      await runInToolContext(name, async () => callback(...callArgs) as Promise<unknown>),
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
    let footerMatch = typeof text === 'string'
      ? canonicalFooterMatch(text, advice.get(toolName) ?? 'narrow the query')
      : undefined;
    const markedTruncated = result.structuredContent != null
      && typeof result.structuredContent === 'object'
      && (result.structuredContent as JsonObject).truncated === true;
    const completeness = typeof text === 'string' ? /\bfetched\s+(\d+)(?:\s+of\s+(\d+))?\b[^—\n]*—\s*TRUNCATED\b/i.exec(text) : undefined;
    let payload = result.structuredContent != null && typeof result.structuredContent === 'object'
      ? result.structuredContent as JsonObject
      : undefined;
    let parsedJson: 'object' | 'array' | false = false;
    let parsedArray: unknown[] | undefined;
    if (typeof text === 'string' && /^\s*[{[]/.test(text)) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (Array.isArray(parsed)) {
          parsedJson = 'array';
          parsedArray = parsed;
        } else if (parsed != null && typeof parsed === 'object') {
          parsedJson = 'object';
          if (!payload) payload = parsed as JsonObject;
        }
      } catch {
        // Non-JSON prose beginning with a brace or bracket is not a machine result.
      }
    }
    if (parsedJson === 'array') footerMatch = undefined;
    const args = argsValue != null && typeof argsValue === 'object' && !Array.isArray(argsValue)
      ? argsValue as JsonObject
      : {};
    if (!payload && completeness) {
      const fetched = Number(completeness[1]);
      const total = Number(completeness[2] ?? completeness[1]);
      payload = { returned: fetched, total, remaining: Math.max(0, total - fetched) };
    }
    // A prose-only canonical footer has no structured payload to rewrite, and
    // synthesizing one cannot complete (no items => no returned/remaining), so
    // there is deliberately no repair branch here: such a response keeps its
    // own footer rather than gaining a half-built one.
    let items = payload ? findReturnedItems(payload, inputKeysByTool.get(toolName)) : parsedArray;
    const cap = truncationCap(args, capabilities);
    // `fetch_all` is a documented bypass of max_results: the handler returns
    // everything it walked (up to fetchAllCap) and says so in its own prose.
    // Re-slicing here would make one response disagree with itself — text
    // reading "showing 120" beside a structuredContent of 50 rows — and would
    // silently drop exactly what the caller asked for. Remaining is still
    // derived from the declared total, so a walk that hit fetchAllCap still
    // reports honestly.
    const fetchAllRequested = capabilities.fetchAll === true && args.fetch_all === true;
    const itemsWereSliced = !fetchAllRequested && items !== undefined && cap !== undefined && items.length > cap;
    // A declared total is only usable as a *truncation* total when it counts the
    // same population as the array. `truncation.total` and `unique_tracks` do
    // by construction; a bare `total`/`pagination.total` may be index-wide (a
    // /search result the caller cannot page through) or a page-scoped count.
    // Only trust it when the tool is actually paged — it declares an offset or
    // limit control — and something was returned, so `total - returned` is a
    // real "there are more" rather than a different denominator.
    const truncationTotal = payload
      ? numberField(payload.unique_tracks) ?? numberField((payload.truncation as JsonObject | undefined)?.total)
      : undefined;
    const declaredTotal = payload
      ? numberField(payload.total)
        ?? numberField((payload.pagination as JsonObject | undefined)?.total)
        ?? truncationTotal
      : undefined;
    const pagedTotal = declaredTotal !== undefined
      && (truncationTotal !== undefined || itemsWereSliced || capabilities.offset === true || capabilities.limit === true)
      && (numberField(payload?.returned) ?? items?.length ?? 0) > 0;
    const returned = itemsWereSliced ? cap : numberField(payload?.returned) ?? items?.length;
    const inferredRemaining = pagedTotal && declaredTotal !== undefined && returned !== undefined
      ? Math.max(0, declaredTotal - returned)
      : footerMatch != null
        ? footerMatch.count
        : completeness != null
          ? Math.max(0, Number(completeness[2] ?? completeness[1]) - Number(completeness[1]))
          : itemsWereSliced
            ? items!.length - cap!
            : numberField(payload?.remaining);
    if (!payload && parsedArray) payload = { items: parsedArray };
    // `returned < total` is NOT a truncation signal on its own. `total` means
    // different populations in different tools: a page-scoped total (the
    // index-wide /search count) whose array the caller cannot enlarge, or a
    // collection that is simply exhausted, where an empty page past the end
    // still reports a non-zero total. Stamping either as "N more — raise
    // max_results" is advice the caller cannot act on, and the empty-page case
    // emitted the very offset the caller had already used, inviting an
    // infinite re-request loop. Only signals we can trust to be true
    // truncation act here: an explicit marker, a tool-authored footer, a
    // canonical completeness line, or the boundary's own slice.
    const hasTruncationSignal = markedTruncated || footerMatch != null || completeness != null;
    if (!payload || (!hasTruncationSignal && !itemsWereSliced)) return resultValue;
    const metadata = metadataFromPayload(payload, args, capabilities, inferredRemaining, itemsWereSliced, cap, inputKeysByTool.get(toolName) ?? new Set());
    if (!metadata) return resultValue;
    const nextPayload: JsonObject = { ...payload, ...metadata };
    if (payload.truncated === true) nextPayload.truncated = true;
    if (capabilities.offset && metadata.remaining > 0 && numberField(nextPayload.next_offset) !== undefined) {
      nextPayload.next_offset = numberField(nextPayload.next_offset);
    } else {
      delete nextPayload.next_offset;
    }
    if (nextPayload.pagination != null && typeof nextPayload.pagination === 'object') {
      const pagination = nextPayload.pagination as JsonObject;
      if (!capabilities.offset || metadata.remaining <= 0) {
        const { next_offset: _nextOffset, ...rest } = pagination;
        nextPayload.pagination = rest;
      }
    }
    if (itemsWereSliced && items) {
      const sliced = items.slice(0, cap!);
      for (const [key, value] of Object.entries(nextPayload)) {
        if (value === items) nextPayload[key] = sliced;
      }
    }
    let nextText = text;
    if (footerMatch && typeof text === 'string') {
      const replacement = metadata.remaining > 0
        ? `(${metadata.remaining} more — ${advice.get(toolName)})`
        : '';
      nextText = text.replace(footerMatch.match[0], replacement).trimEnd();
    } else if (parsedJson === 'array' && itemsWereSliced && items) {
      nextText = JSON.stringify(items.slice(0, cap!), null, 2);
    } else if (
      metadata.remaining > 0
      && typeof text === 'string'
      && parsedJson !== 'object'
      && !mentionsAcceptedControl(text, capabilities)
    ) {
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
          ? { ...(block as JsonObject), text: parsedJson === 'object' ? JSON.stringify(nextPayload, null, 2) : nextText }
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

/** Parse a spotify: URI through the shared reference policy. */
export function parseSpotifyUri(uri: string): { type: string; id: string } | null {
  const parsed = classifySpotifyReference(uri, undefined, { allowShortIds: true });
  if (!parsed.valid || parsed.form !== 'uri' || !parsed.kind || !parsed.id) return null;
  return { type: parsed.kind, id: parsed.id };
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
