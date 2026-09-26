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
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SpotifyClient } from '../client.js';
import { ResponseFormat } from '../shaping.js';
import { SPOTIFY_SEARCH_MAX_LIMIT } from './search.js';

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
  } catch {
    // Best-effort by design: history is an aid, never a dependency.
  }
}

export function searchHistoryFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.SPOTIFY_MCP_SEARCH_HISTORY_FILE ?? join(homedir(), '.spotify-mcp', 'search-history.json');
}

export async function loadSearchHistory(env: NodeJS.ProcessEnv = process.env): Promise<SearchHistoryEntry[]> {
  try {
    const raw = await readFile(searchHistoryFile(env), 'utf8');
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : (parsed?.entries ?? []);
    if (!Array.isArray(arr)) return [];
    // 90-day expiry
    const cutoff = Date.now() - 90 * 86400_000;
    return arr.filter((e: SearchHistoryEntry) => {
      const t = new Date(e.timestamp).getTime();
      return Number.isFinite(t) && t >= cutoff;
    });
  } catch { return []; }
}

async function saveSearchHistory(entries: SearchHistoryEntry[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const file = searchHistoryFile(env);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  // expiry on save too
  const cutoff = Date.now() - 90 * 86400_000;
  const filtered = entries.filter((e) => new Date(e.timestamp).getTime() >= cutoff);
  await writeFile(file, `${JSON.stringify(filtered, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

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

export function registerSearchHistoryTools(server: McpServer, client: SpotifyClient): void {
  server.tool('search_history',
    'Recall past searches (local sidecar, 90-day expiry). Optionally filter by query substring. Recorded by search/search_deep/search_* tools; set SPOTIFY_MCP_SEARCH_HISTORY=0 to stop recording.',
    {
      query: z.string().optional().describe('Substring to filter past queries'),
      limit: z.number().int().min(1).max(100).optional().describe('Max entries to return (default 20)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const entries = await loadSearchHistory();
      let filtered = entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      if (args.query) {
        const q = (args.query as string).toLowerCase();
        filtered = filtered.filter((e) => e.query.toLowerCase().includes(q));
      }
      const lim = (args.limit as number) ?? 20;
      const sliced = filtered.slice(0, lim);
      if (sliced.length === 0) return textResult(`No search history${args.query ? ` for "${args.query}"` : ''}.`, { ok: true, count: 0, entries: [] });
      const lines = sliced.map((e) => `- [${e.id}] "${e.query}" (${e.types?.join(',') ?? 'track'}) @ ${e.timestamp} → ${e.top_result_ids.slice(0, 2).join(', ')}`);
      const echo = { ok: true, count: sliced.length, total: filtered.length, entries: sliced };
      if (args.response_format === 'json') return { content: [{ type: 'text', text: JSON.stringify(echo, null, 2) }], structuredContent: echo };
      return { content: [{ type: 'text', text: `${sliced.length}/${filtered.length} history entries:\n${lines.join('\n')}` }], structuredContent: echo };
    });

  server.tool('search_rerun',
    'Re-execute a stored search, clamping stale limits.',
    {
      history_id: z.string().min(1).describe('History entry id'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const entries = await loadSearchHistory();
      const entry = entries.find((e) => e.id === args.history_id);
      if (!entry) return textResult(`No history entry "${args.history_id}".`, { ok: false, available: entries.map((e) => e.id) });
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
        result: res,
      }, `Re-ran search "${entry.query}" (${types.join(',')}, limit ${limit}${entry.market ? `, market ${entry.market}` : ''}) — see structuredContent.result.`);
    });
}
