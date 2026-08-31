/**
 * swarm3 meta slice — 500-tool swarm v1.26.0 (issue #442).
 *
 * Discoverability tools for a 500+ tool surface: search the live tool
 * registry, inspect a single tool's schema, and report toolset/module
 * structure. Pure introspection — no Spotify API calls.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { TOOLSETS, isModuleActive, allRegistrationKeys } from '../toolsets.js';
import { ResponseFormat } from '../shaping.js';

interface RegisteredToolInfo {
  name: string;
  description: string;
  inputSchema?: unknown;
}

/** Read the SDK's private-but-stable tool registry, tolerating SDK changes. */
function toolRegistry(server: McpServer): RegisteredToolInfo[] {
  const raw = (server as unknown as { _registeredTools?: Record<string, { name?: string; description?: string; inputSchema?: unknown }> })._registeredTools;
  if (!raw || typeof raw !== 'object') return [];
  return Object.values(raw).map((t) => ({
    name: String(t?.name ?? ''),
    description: String(t?.description ?? ''),
    inputSchema: t?.inputSchema,
  })).filter((t) => t.name !== '');
}

/** Which toolset registration keys does a tool belong to? Not knowable at
 * runtime per-name (gating is per-module), so report module activity instead. */
function activeModules(server: McpServer): string[] {
  const sets = new Set(Object.keys(TOOLSETS));
  return allRegistrationKeys.filter((key) => isModuleActive(key, sets));
}

export function registerSwarm3MetaTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'find_tool',
    'Search the live tool registry by name or description substring — the fastest way to discover which of the 500+ tools handles a job. Discovery set: find_tool/inspect_tool/toolset_report are always available (also via catalog). Use this first when unsure which verb to use (e.g., playlist vs snapshot vs search).',
    {
      query: z.string().min(2).describe('Case-insensitive substring to match against tool names and descriptions'),
      response_format: ResponseFormat,
      limit: z.number().int().min(1).max(100).optional().describe('Max matches to return (default 25)'),
    },
    async (args) => {
      const q = args.query.toLowerCase();
      const limit = args.limit ?? 25;
      const all = toolRegistry(server);
      const matches = all
        .filter((t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
        .slice(0, limit);
      const lines = matches.length
        ? matches.map((t) => `• ${t.name} — ${t.description}`).join('\n')
        : `No tools match "${args.query}". Try a shorter or different substring.`;
      const text = `Matched ${matches.length} of ${all.length} registered tools:\n\n${lines}`;
      return {
        content: [{ type: 'text', text }],
        structuredContent: { query: args.query, total_registered: all.length, matched: matches.length, tools: matches.map((m) => ({ name: m.name, description: m.description })) },
      };
    },
  );

  server.tool(
    'inspect_tool',
    'Show one tool\'s full description and input schema before calling it',
    {
      tool_name: z.string().min(1).describe('Exact registered tool name'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const all = toolRegistry(server);
      const hit = all.find((t) => t.name === args.tool_name);
      if (!hit) {
        const near = all.filter((t) => t.name.toLowerCase().includes(args.tool_name.toLowerCase().slice(0, 6))).slice(0, 5).map((t) => t.name);
        return {
          content: [{ type: 'text', text: `Unknown tool "${args.tool_name}".${near.length ? ` Close matches: ${near.join(', ')}` : ''}` }],
          structuredContent: { found: false, tool_name: args.tool_name },
        };
      }
      const schema = hit.inputSchema ? JSON.stringify(hit.inputSchema, null, 2) : '(no parameters)';
      const text = `${hit.name}\n\n${hit.description}\n\nInput schema:\n${schema}`;
      return {
        content: [{ type: 'text', text }],
        structuredContent: { found: true, name: hit.name, description: hit.description, input_schema: hit.inputSchema ?? {} },
      };
    },
  );

  server.tool(
    'toolset_report',
    'Report the active toolsets and registration modules, plus the live registered tool count — answers "how much surface is exposed right now". Discovery set; always available. Also see find_tool / inspect_tool.',
    {},
    async () => {
      const all = toolRegistry(server);
      const modules = activeModules(server);
      const setLines = Object.entries(TOOLSETS)
        .map(([set, keys]) => {
          const active = keys.filter((k) => modules.includes(k)).length;
          return `• ${set}: ${active}/${keys.length} modules active (${keys.join(', ')})`;
        })
        .join('\n');
      const text = `Registered tools (live): ${all.length}\n\nToolsets (SPOTIFY_MCP_TOOLSETS):\n${setLines}`;
      return {
        content: [{ type: 'text', text }],
        structuredContent: { registered_tools: all.length, active_modules: modules, toolsets: TOOLSETS },
      };
    },
  );
}
