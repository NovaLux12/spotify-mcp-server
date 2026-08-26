/**
 * searchhistory (#205): search_history + search_rerun (90-day expiry, sidecar).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SpotifyClient } from '../client.js';
import { ResponseFormat } from '../shaping.js';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown> };
function textResult(text: string, s?: Record<string, unknown>): ToolResult { return { content: [{ type: 'text', text }], ...(s ? { structuredContent: s } : {}) }; }
function emit(fmt: string | undefined, echo: Record<string, unknown>, text: string): ToolResult {
  if (fmt === 'json') return { content: [{ type: 'text', text: JSON.stringify(echo, null, 2) }], structuredContent: echo };
  return { content: [{ type: 'text', text }], structuredContent: echo };
}

export interface SearchHistoryEntry {
  id: string;
  query: string;
  types?: string[];
  timestamp: string;
  top_result_ids: string[];
  limit?: number;
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

export async function saveSearchHistory(entries: SearchHistoryEntry[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
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

export function registerSearchHistoryTools(server: McpServer, client: SpotifyClient): void {
  server.tool('search_history',
    'Recall past searches (local sidecar, 90-day expiry). Optionally filter by query substring.',
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
    'Re-execute a stored search by history id via GET /search.',
    {
      history_id: z.string().min(1).describe('History entry id'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const entries = await loadSearchHistory();
      const entry = entries.find((e) => e.id === args.history_id);
      if (!entry) return textResult(`No history entry "${args.history_id}".`, { ok: false, available: entries.map((e) => e.id) });
      const types = (entry.types ?? ['track']) as string[];
      const params: Record<string, string> = { q: entry.query, type: types.join(','), limit: String(entry.limit ?? 5) };
      const res = await client.get<unknown>('/search', params);
      return emit(args.response_format as string, { ok: true, history_id: entry.id, query: entry.query, types, result: res }, `Re-ran search "${entry.query}" (${types.join(',')}) — see structuredContent.result.`);
    });
}
