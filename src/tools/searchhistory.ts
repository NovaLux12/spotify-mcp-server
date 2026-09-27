/**
 * searchhistory (#205): search_history + search_rerun (90-day expiry, sidecar).
 *
 * Recording (#766): the reader tools below are inert unless the search paths
 * write here. `recordSearch()` is the single writer entry point used by
 * `search`, `search_deep` and the typed-search factory — it is opt-out
 * (SPOTIFY_MCP_SEARCH_HISTORY=0) and never throws, so a sidecar that cannot be
 * written cannot fail a search.
 *
 * Replay (#793): `search_rerun` clamps the stored limit into the live range
 * before it reaches the wire, so a sidecar written under the older, higher
 * cap still replays — and reports the limit actually sent.
 *
 * Corruption (#839): a sidecar that exists but cannot be read is never
 * silently emptied. The load throws, the bytes are copied aside to
 * `<file>.corrupt`, the next append refuses rather than writing over them, and
 * the readers say so — `ok: false` with `load_error`, never a count of zero.
 * A missing file is a first run and still yields an empty history.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SpotifyClient } from '../client.js';
import { ResponseFormat } from '../shaping.js';
import { loadSidecar, SidecarUnreadableError } from '../sidecar.js';
import { SPOTIFY_SEARCH_MAX_LIMIT } from './search.js';
import { storePath } from '../config.js';

/**
 * Results-per-request a replay asks for when the sidecar records no usable
 * limit — the same default the live search tool applies.
 */
const DEFAULT_REPLAY_LIMIT = 5;

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown> };
function textResult(text: string, s?: Record<string, unknown>): ToolResult { return { content: [{ type: 'text', text }], ...(s ? { structuredContent: s } : {}) }; }
function emit(fmt: string | undefined, echo: Record<string, unknown>, text: string): ToolResult {
  if (fmt === 'json') return { content: [{ type: 'text', text: JSON.stringify(echo, null, 2) }], structuredContent: echo };
  return { content: [{ type: 'text', text }], structuredContent: echo };
}

interface SearchHistoryEntry {
  id: string;
  query: string;
  types?: string[];
  timestamp: string;
  top_result_ids: string[];
  /** Results-per-request the search asked for, when one request covers it. */
  limit?: number;
  /** Market the search was scoped to, so a replay reproduces its availability. */
  market?: string;
  /** First result index the search started at, so a replay resumes the window. */
  offset?: number;
}

/** Result identifiers kept per entry — enough to recognise a repeat, not a log. */
const TOP_RESULT_IDS = 3;

/**
 * Whether searches are recorded. Recording is on by default — the sidecar
 * holds only the query text, timestamp and a few result URIs — and
 * `SPOTIFY_MCP_SEARCH_HISTORY=0` (or false/no/off) opts out for users who do
 * not want their search terms on disk.
 */
function isSearchHistoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !['0', 'false', 'no', 'off'].includes((env.SPOTIFY_MCP_SEARCH_HISTORY ?? '').trim().toLowerCase());
}

/**
 * First `max` result identifiers from a search section, in result order. Null
 * slots (market-unavailable items) and id-less rows are skipped; a row's `uri`
 * is preferred over its bare `id` because that is what a caller replays
 * against the catalog.
 */
function topResultIds(items: readonly unknown[] | null | undefined, max: number = TOP_RESULT_IDS): string[] {
  const out: string[] = [];
  for (const item of items ?? []) {
    if (out.length >= max) break;
    if (!item || typeof item !== 'object') continue;
    const row = item as { uri?: unknown; id?: unknown };
    if (typeof row.uri === 'string' && row.uri) out.push(row.uri);
    else if (typeof row.id === 'string' && row.id) out.push(row.id);
  }
  return out;
}

interface RecordSearchInput {
  query: string;
  types: string[];
  /** Result rows across every requested type, in the order a rerun would replay. */
  items: readonly unknown[];
  limit?: number;
  market?: string;
  offset?: number;
}

/**
 * Record one executed search. Call after a search that actually returned
 * results — the readers (`search_history`, `search_rerun`,
 * `search_history_stats`, the portability archive) have no other writer.
 *
 * Never rejects: a disabled store, a read-only home directory or a corrupt
 * sidecar must leave the search itself intact.
 */
export async function recordSearch(input: RecordSearchInput, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!isSearchHistoryEnabled(env)) return;
  try {
    await appendSearchHistory({
      // Time-sortable prefix keeps the file roughly ordered; the random
      // suffix keeps ids unique within a millisecond.
      id: `sh_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`,
      query: input.query,
      types: input.types,
      timestamp: new Date().toISOString(),
      top_result_ids: topResultIds(input.items),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.market !== undefined ? { market: input.market } : {}),
      ...(input.offset !== undefined ? { offset: input.offset } : {}),
    }, env);
  } catch (err) {
    // #839: a store that could not be read is not a store we may write. The
    // append above refused, so the user's bytes are exactly as they were — but
    // the refusal happens on a path that is documented never to throw, so it
    // is recorded here and reported by the next reader rather than swallowed.
    if (err instanceof SidecarUnreadableError) {
      noteRefusedWrite(err);
      return;
    }
    // Best-effort by design: history is an aid, never a dependency.
  }
}

export function searchHistoryFile(env: NodeJS.ProcessEnv = process.env): string {
  return storePath('search-history', env);
}

/** Retention applied on read and on save. */
const ENTRY_TTL_MS = 90 * 86400_000;

/**
 * Parse + validate the sidecar, or throw. `#839`: the file is untrusted input
 * (it can be truncated by a crash, hand-edited, or carried in by an import),
 * and the old loader answered every one of those with `[]`. An empty array is
 * a real answer — "no history yet" — so returning it for a store that could
 * not be read is a lie the next append turns into data loss: the writer
 * pushes one entry onto the empty list and writes it back over the file,
 * destroying every earlier search with no warning and nothing on disk to
 * recover from.
 *
 * A row that is not a usable entry is treated as whole-file corruption rather
 * than skipped. Skipping is the same coercion one level down: the row silently
 * disappears from the user's history, and the store keeps reading as
 * "complete". Failing loudly, preserving the bytes and refusing the write
 * keeps the row recoverable from the `.corrupt` copy.
 */
function parseSearchHistoryStore(parsed: unknown): SearchHistoryEntry[] {
  const asObject = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
  const arr = Array.isArray(parsed) ? parsed : Array.isArray(asObject?.entries) ? asObject!.entries as unknown[] : null;
  if (arr === null) {
    throw new Error(
      'is not a search-history store: expected a JSON array of entries, or an object with an "entries" array',
    );
  }
  arr.forEach((row, i) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`entry ${i} is not a JSON object`);
    }
    const r = row as Record<string, unknown>;
    for (const key of ['id', 'query', 'timestamp'] as const) {
      if (typeof r[key] !== 'string') throw new Error(`entry ${i} has no string "${key}"`);
    }
    if (!Array.isArray(r.top_result_ids)) throw new Error(`entry ${i} has no "top_result_ids" array`);
  });
  const cutoff = Date.now() - ENTRY_TTL_MS;
  return (arr as SearchHistoryEntry[]).filter((e) => {
    const t = new Date(e.timestamp).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
}

/**
 * Load the sidecar.
 *
 * A missing file is a first run and yields `[]`. Anything else — an unreadable
 * path, invalid JSON, or a store whose shape is wrong — throws
 * `SidecarUnreadableError`, which names the file, states the actual parse or
 * read failure, and points at the preserved copy of the bytes.
 */
export async function loadSearchHistory(env: NodeJS.ProcessEnv = process.env): Promise<SearchHistoryEntry[]> {
  try {
    const entries = await loadSidecar<SearchHistoryEntry[]>(
      searchHistoryFile(env),
      () => [],
      parseSearchHistoryStore,
      { alreadyPreserved: preservedCopy },
    );
    // The file is readable again, so whatever we were preserving for is over.
    preservedCopy = undefined;
    return entries;
  } catch (err) {
    // Recorded here rather than in each caller: every search loads this
    // store, so a direct `loadSearchHistory()` that nobody caught would
    // otherwise let the next one copy the same bytes again.
    if (err instanceof SidecarUnreadableError) preservedCopy = err.preservedAs;
    throw err;
  }
}

/** What a load produced, plus what it could not produce and why. */
export interface SearchHistoryRead {
  entries: SearchHistoryEntry[];
  /** Set when the file existed but could not be turned into entries. */
  load_error?: string;
  /** Where those bytes were copied; null when even that failed. */
  preserved_as?: string | null;
  /** Searches that could not be recorded while the store was unreadable. */
  refused_writes?: RefusedWrites;
}

export interface RefusedWrites {
  count: number;
  first_at: string;
  last_at: string;
  preserved_as: string | null;
}

/**
 * The copy already made for the corruption now on disk, or null when the last
 * attempt could not make one, or undefined when this process has seen no
 * corruption. Every search loads this store, so without it one corrupt file
 * would leave one identical `.corrupt.N` per search. It suppresses only the
 * duplicate copy — the read still happens, so the verdict always describes the
 * file as it is now — and it is cleared by the first successful load.
 */
let preservedCopy: string | null | undefined;

/** Appends refused while the store was unreadable, cleared once reported. */
let refusedWrites: RefusedWrites | null = null;

function noteRefusedWrite(err: SidecarUnreadableError): void {
  const now = new Date().toISOString();
  refusedWrites = refusedWrites
    ? { ...refusedWrites, count: refusedWrites.count + 1, last_at: now }
    : { count: 1, first_at: now, last_at: now, preserved_as: err.preservedAs };
}

/**
 * Test seam: drop the cross-call memory of one corruption episode. Production
 * code never calls it; without it two tests in one process would share the
 * first one's `.corrupt` copy and the second would assert against `.corrupt.1`.
 */
export function __resetSearchHistoryEpisode(): void {
  preservedCopy = undefined;
  refusedWrites = null;
}

/**
 * Non-throwing load for the tools. Returns the entries when the store reads,
 * and otherwise an empty list carrying `load_error` — the tools must report
 * that, never a count of zero, because "no history" and "history I could not
 * read" are different facts and only one of them is the user's.
 */
export async function readSearchHistory(env: NodeJS.ProcessEnv = process.env): Promise<SearchHistoryRead> {
  try {
    const entries = await loadSearchHistory(env);
    // Reported exactly once, on the first read after the file became readable
    // again: that is the only moment the gap is still explainable.
    const refused = refusedWrites;
    refusedWrites = null;
    return { entries, ...(refused ? { refused_writes: refused } : {}) };
  } catch (err) {
    if (!(err instanceof SidecarUnreadableError)) throw err;
    return {
      entries: [],
      load_error: err.message,
      preserved_as: err.preservedAs,
      ...(refusedWrites ? { refused_writes: refusedWrites } : {}),
    };
  }
}

async function saveSearchHistory(entries: SearchHistoryEntry[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const file = searchHistoryFile(env);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  // expiry on save too
  const cutoff = Date.now() - ENTRY_TTL_MS;
  const filtered = entries.filter((e) => new Date(e.timestamp).getTime() >= cutoff);
  await writeFile(file, `${JSON.stringify(filtered, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  // #1084: mode only applies at creation; re-assert so a pre-existing or
  // copied-in store does not stay world-readable after this write.
  await chmod(file, 0o600);
}

/**
 * Add one entry, rewriting the whole store.
 *
 * #839 — the write-path policy is REFUSE, and it is structural rather than a
 * check that can be forgotten: this loads the existing store first, a store
 * that cannot be read throws, and the `writeFile` below is therefore
 * unreachable while the file is corrupt. The user's bytes stay exactly where
 * they are and a copy sits beside them. The two alternatives were both worse —
 * overwriting discards the history the `.corrupt` copy is the only evidence of
 * at the path every other tool reads, and "append" has no meaning here because
 * the file is not valid JSON to append to.
 */
export async function appendSearchHistory(entry: SearchHistoryEntry, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const entries = await loadSearchHistory(env);
  entries.push(entry);
  await saveSearchHistory(entries, env);
}

/**
 * The numeric limit a sidecar entry records, or NaN when it records nothing
 * usable. The sidecar is untrusted input: `"50"` in an imported file is a
 * limit, but `""`, `null`, `false` and `{}` only *look* coercible — `Number('')`
 * and `Number(false)` are both 0, and reading those as a recorded 0 would
 * clamp a replay up to one result and report `limit_clamped_from: 0`, a number
 * the file never carried.
 */
function replayableLimit(stored: unknown): number {
  if (typeof stored === 'number') return Number.isFinite(stored) ? Math.round(stored) : Number.NaN;
  if (typeof stored === 'string' && stored.trim() !== '') return Math.round(Number(stored));
  return Number.NaN;
}

/**
 * The answer a reader owes when the store exists but could not be read (#839).
 *
 * `count`/`total`/`entries` are `null`, not `0`/`[]`. Zero is a real answer —
 * it is what a first run returns and what an all-expired store returns — so
 * reporting it here would be the same coercion as any other unreadable value
 * dressed as a measurement: the caller reads "you have never searched for
 * anything" off a file holding months of searches. The same distinction
 * `export_local_stores` already draws between a store that is absent and a
 * store that could not be read.
 */
function unreadableResult(fmt: string | undefined, read: SearchHistoryRead): ToolResult {
  const structured = {
    ok: false,
    error: 'load_error',
    load_error: read.load_error,
    preserved_as: read.preserved_as ?? null,
    entries: null,
    count: null,
    total: null,
    ...(read.refused_writes ? { refused_writes: read.refused_writes } : {}),
  };
  const prose = [
    'Search history could not be read. Nothing was deleted, and no search was recorded over it:',
    read.load_error,
  ].join('\n');
  if (fmt === 'json') return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
  return { content: [{ type: 'text', text: prose }], structuredContent: structured };
}

/**
 * What the reader owes once the file is readable again: the searches that were
 * dropped while it was not. They are the only part of this failure the user
 * cannot recover from the preserved copy, so they are named once, here.
 */
function refusalNotice(refused: RefusedWrites | undefined): { text: string; field?: Record<string, unknown> } {
  if (!refused) return { text: '' };
  const plural = refused.count === 1 ? 'search was' : 'searches were';
  return {
    text: `\nNote: ${refused.count} ${plural} not recorded between ${refused.first_at} and ${refused.last_at} because this store was unreadable. Its bytes are preserved at ${refused.preserved_as ?? 'the original file, in place'}.`,
    field: { refused_writes: refused },
  };
}

export function registerSearchHistoryTools(server: McpServer, client: SpotifyClient): void {
  server.tool('search_history',
    'Recall past searches (local sidecar, 90-day expiry). Optionally filter by query substring. Recorded by search/search_deep/search_* tools; set SPOTIFY_MCP_SEARCH_HISTORY=0 to stop recording.',
    {
      query: z.string().optional().describe('Substring to filter past queries'),
      limit: z.number().int().min(1).max(100).optional().describe('Max entries to return (default 20)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const fmt = args.response_format as string | undefined;
      const read = await readSearchHistory();
      if (read.load_error) return unreadableResult(fmt, read);
      const notice = refusalNotice(read.refused_writes);
      const entries = read.entries;
      let filtered = entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      if (args.query) {
        const q = (args.query as string).toLowerCase();
        filtered = filtered.filter((e) => e.query.toLowerCase().includes(q));
      }
      const lim = (args.limit as number) ?? 20;
      const sliced = filtered.slice(0, lim);
      const echo = { ok: true, count: sliced.length, total: filtered.length, entries: sliced, ...notice.field };
      if (fmt === 'json') return { content: [{ type: 'text', text: JSON.stringify(echo, null, 2) }], structuredContent: echo };
      const body = sliced.length === 0
        ? `No search history${args.query ? ` for "${args.query}"` : ''}.`
        : `${sliced.length}/${filtered.length} history entries:\n${sliced.map((e) => `- [${e.id}] "${e.query}" (${e.types?.join(',') ?? 'track'}) @ ${e.timestamp} → ${e.top_result_ids.slice(0, 2).join(', ')}`).join('\n')}`;
      return { content: [{ type: 'text', text: `${body}${notice.text}` }], structuredContent: echo };
    });

  server.tool('search_rerun',
    'Re-execute a stored search, clamping stale limits.',
    {
      history_id: z.string().min(1).describe('History entry id'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const read = await readSearchHistory();
      if (read.load_error) return unreadableResult(args.response_format as string | undefined, read);
      const entries = read.entries;
      const notice = refusalNotice(read.refused_writes);
      const entry = entries.find((e) => e.id === args.history_id);
      if (!entry) return textResult(`No history entry "${args.history_id}".${notice.text}`, { ok: false, available: entries.map((e) => e.id), ...notice.field });
      const types = (entry.types ?? ['track']) as string[];
      // #793: a sidecar written before the February-2026 cap, or imported from
      // another install, can carry a limit /search will now reject with an
      // opaque 400. The caller cannot fix it — the value comes from disk, not
      // from its own arguments — so clamp on read and report what was sent.
      // An imported or hand-written sidecar is not obliged to hold a *number*
      // here. Coerce whatever is there; a value that carries no usable number
      // is discarded, and that discard is itself an adjustment the payload has
      // to name rather than pass off as a five-result replay the caller chose.
      const asNumber = replayableLimit(entry.limit);
      const usable = Number.isFinite(asNumber);
      const limit = Math.min(SPOTIFY_SEARCH_MAX_LIMIT, Math.max(1, usable ? asNumber : DEFAULT_REPLAY_LIMIT));
      // No recorded limit at all is not a clamp: the default was never an
      // adjustment of anything the caller can see. Anything else that differs
      // from what reached the wire is reported, including a value dropped for
      // carrying no usable number.
      const adjusted = entry.limit !== undefined && (!usable || limit !== asNumber);
      const params: Record<string, string> = { q: entry.query, type: types.join(','), limit: String(limit) };
      if (entry.market) params.market = entry.market;
      if (entry.offset) params.offset = String(entry.offset);
      const res = await client.get<unknown>('/search', params);
      return emit(args.response_format as string, {
        ok: true,
        history_id: entry.id,
        query: entry.query,
        types,
        limit_used: limit,
        // Read back off the params that were sent, not off the entry: a stored
        // market that did not survive into `params` was not market-scoped, and
        // a consumer branching on `market_used !== null` must not be told
        // otherwise.
        market_used: 'market' in params ? params.market : null,
        // A coercible limit reports the number the clamp was computed from; a
        // value that would not coerce reports the raw sidecar value, which is
        // the only account of it that exists.
        ...(adjusted ? { limit_clamped_from: usable ? asNumber : entry.limit } : {}),
        ...notice.field,
        result: res,
      }, `Re-ran search "${entry.query}" (${types.join(',')}, limit ${limit}${entry.market ? `, market ${entry.market}` : ''}) — see structuredContent.result.${notice.text}`);
    });
}
