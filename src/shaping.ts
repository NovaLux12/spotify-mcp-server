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
// Canonical playlist set-operation inputs (#912)
// ---------------------------------------------------------------------------

/**
 * Normalize the public playlist-reference forms to the raw ID used in
 * `/playlists/{id}` paths. Spotify share URIs and open.spotify.com playlist
 * URLs are equivalent to bare IDs on the wire.
 */
export function normalizePlaylistReference(reference: string): string {
  const value = reference.trim();
  if (value.length === 0) throw new Error('Playlist reference must not be empty');

  const spotifyUri = /^spotify:playlist:([^?#]+)/.exec(value);
  if (spotifyUri) return decodeURIComponent(spotifyUri[1]);
  if (value.startsWith('spotify:')) {
    throw new Error(`Expected a spotify:playlist: URI or playlist ID, received "${value}"`);
  }

  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`Invalid playlist URL "${value}"`);
    }
    if (!/(^|\.)spotify\.com$/i.test(url.hostname)) {
      throw new Error(`Expected a Spotify playlist URL, received "${value}"`);
    }
    const segments = url.pathname.split('/').filter(Boolean);
    const playlistAt = segments.indexOf('playlist');
    const id = playlistAt >= 0 ? segments[playlistAt + 1] : undefined;
    if (!id) throw new Error(`Spotify URL does not contain a playlist ID: "${value}"`);
    return decodeURIComponent(id);
  }

  return value;
}

/** One playlist reference, normalized before any handler sees it. */
export const PlaylistRef = z
  .string()
  .min(1)
  .transform(normalizePlaylistReference)
  .describe('Playlist ID, spotify:playlist: URI, or Spotify playlist URL; use this reference in the canonical or documented legacy field');

/** Canonical ordered collection used by every set/diff tool. */
export const PlaylistRefs = z
  .array(PlaylistRef)
  .min(2)
  .max(10)
  .describe('Canonical ordered playlists (2–10). Provide this field or the complete documented legacy alias; IDs, spotify:playlist: URIs, and Spotify playlist URLs are accepted.');

export const PlaylistId = PlaylistRef;

/** Canonical plural input; exactly one canonical/legacy collection is required. */
export const PlaylistListFields = {
  playlists: PlaylistRefs.optional().describe('Canonical ordered playlists (2–10), or provide the complete legacy alias accepted by this tool'),
} as const;

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

export type PlaylistListAlias =
  | 'playlist_ids'
  | 'source_playlist_ids'
  | 'subtract_playlist_ids'
  | 'sources';

export type PlaylistPairAlias = readonly [
  'playlist_id_a' | 'playlist_a_id' | 'a',
  'playlist_id_b' | 'playlist_b_id' | 'b',
];

/** Legacy aliases are supported through v2.0 and removed in v2.1. */
export function legacyPlaylistListFields(
  aliases: readonly PlaylistListAlias[],
  limits: { min?: number; max?: number } = {},
): Record<PlaylistListAlias, z.ZodOptional<z.ZodArray<typeof PlaylistRef>>> {
  const schema = z.array(PlaylistRef).min(limits.min ?? 2).max(limits.max ?? 10)
    .describe('Deprecated one-release alias supported through v2.0; removed in v2.1. Provide this complete alias or canonical playlists.');
  return Object.fromEntries(aliases.map((name) => [name, schema.optional()])) as Record<
    PlaylistListAlias,
    z.ZodOptional<z.ZodArray<typeof PlaylistRef>>
  >;
}

/** Legacy pair aliases are supported through v2.0 and removed in v2.1. */
export function legacyPlaylistPairFields(aliases: readonly PlaylistPairAlias[]): Record<string, z.ZodOptional<typeof PlaylistRef>> {
  return Object.fromEntries(aliases.flatMap(([a, b]) => [
    [a, PlaylistRef.optional().describe('Deprecated one-release alias supported through v2.0; removed in v2.1. Provide a complete pair or canonical playlist_a/playlist_b.')],
    [b, PlaylistRef.optional().describe('Deprecated one-release alias supported through v2.0; removed in v2.1. Provide a complete pair or canonical playlist_a/playlist_b.')],
  ]));
}

export interface PlaylistInputResolution {
  /** Canonical, normalized values in caller-supplied order. */
  values: string[];
  /** Legacy input names actually present on the call. */
  deprecatedInputs: string[];
  /** One-line migration note, or null for canonical-only calls. */
  deprecationNote: string | null;
}

export type PlaylistInputConfig =
  | { kind: 'list'; aliases: readonly PlaylistListAlias[] }
  | { kind: 'pair'; aliases: readonly PlaylistPairAlias[] };

function orderedEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeResolvedPlaylistValue(value: unknown): string {
  const text = String(value).trim();
  return text.startsWith('spotify:') || /^https?:\/\//i.test(text)
    ? normalizePlaylistReference(text)
    : text;
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
    deprecationNote: `Deprecated input${deprecatedInputs.length === 1 ? '' : 's'} ${deprecatedInputs.join(', ')}; use ${canonical}. Alias support ends after the next release.`,
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
): T | (T & { deprecated_inputs: string[]; deprecation_note: string }) {
  if (resolved.deprecationNote === null) return payload;
  return {
    ...payload,
    deprecated_inputs: resolved.deprecatedInputs,
    deprecation_note: resolved.deprecationNote,
  };
}

/** Append the same one-line migration note to prose/JSON text. */
export function withPlaylistInputNote(text: string, resolved: PlaylistInputResolution): string {
  return resolved.deprecationNote === null ? text : `${text}\n${resolved.deprecationNote}`;
}

// ---------------------------------------------------------------------------
// Truncation math (#53)
// ---------------------------------------------------------------------------

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

/**
 * Slice `items` down to `maxResults` (clamped to >= 1) and compute the
 * "(N more — pass offset or fetch_all)" footer.
 */
export function truncateItems<T>(items: readonly T[], maxResults: number): TruncationResult<T> {
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
  return {
    items: items.slice(0, cap),
    total: items.length,
    returned: cap,
    truncated: true,
    remaining: items.length - cap,
    footer: `${items.length - cap} more — pass offset or fetch_all`,
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
}

/** Canonical wording for complete versus cap-truncated collection walks. */
export function completenessFooter(options: CompletenessFooterOptions): string {
  const subject = options.subject ?? 'items';
  const total = typeof options.total === 'number' ? ` of ${options.total}` : '';
  return options.truncated
    ? `fetched ${options.fetched}${total} ${subject}, cap ${options.cap} — TRUNCATED; older ${subject} were not analyzed`
    : `fetched ${options.fetched}${total} ${subject}, cap ${options.cap} — complete; cap not reached`;
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
