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
