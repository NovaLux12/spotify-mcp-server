/**
 * swarm3 meta slice — 500-tool swarm v1.26.0 (issue #442).
 *
 * Discoverability tools for a 500+ tool surface: search the live tool
 * registry, inspect a single tool's schema, and report toolset/module
 * structure. Pure introspection — no Spotify API calls.
 *
 * Registry notes (#A0-004): the SDK keeps its tools in `McpServer`'s private
 * `_registeredTools` record, keyed by tool name; the VALUE has no `name` field.
 * Reading `tool.name` therefore produced an empty registry and all three tools
 * reported "0 tools" no matter how many were registered. The key is the name.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  TOOLSETS,
  isModuleActive,
  allRegistrationKeys,
  resolveToolsets,
  resolveToolOverrides,
} from '../toolsets.js';
import { ResponseFormat } from '../shaping.js';
import type { ModuleSchemaBudget } from './annotations.js';

interface RegisteredToolInfo {
  name: string;
  description: string;
  inputSchema?: unknown;
}

interface SdkRegisteredTool {
  title?: string;
  description?: string;
  inputSchema?: unknown;
  enabled?: boolean;
}

/** Read the SDK's private-but-stable tool registry, tolerating SDK changes. */
function toolRegistry(server: McpServer): RegisteredToolInfo[] {
  const raw = (server as unknown as { _registeredTools?: Record<string, SdkRegisteredTool> })
    ._registeredTools;
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw)
    .filter(([, tool]) => tool?.enabled !== false)
    .map(([name, tool]) => ({
      name,
      description: String(tool?.description ?? ''),
      inputSchema: tool?.inputSchema,
    }))
    .filter((tool) => tool.name !== '');
}

/** Message used when the registry cannot be read at all (SDK shape change). */
const REGISTRY_UNAVAILABLE =
  'Tool registry unavailable: the MCP SDK exposed no tool registry to read. ' +
  'This is a server bug, not an empty surface — report it rather than retrying.';

/**
 * Registration keys currently active, derived from the same env specs the
 * server registers with (`SPOTIFY_MCP_TOOLSETS` plus the per-key overrides).
 * Scope-driven hiding is not reflected here (it depends on the token).
 */
function activeModules(): string[] {
  const sets = resolveToolsets(process.env.SPOTIFY_MCP_TOOLSETS).sets;
  const overrides = resolveToolOverrides(
    process.env.SPOTIFY_MCP_ENABLE_TOOLS,
    process.env.SPOTIFY_MCP_DISABLE_TOOLS,
  );
  return allRegistrationKeys.filter((key) => isModuleActive(key, sets, overrides));
}

export function registerSwarm3MetaTools(server: McpServer): void {
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
      if (all.length === 0) {
        return {
          content: [{ type: 'text', text: REGISTRY_UNAVAILABLE }],
          structuredContent: { query: args.query, total_registered: 0, matched: 0, tools: [], error: 'registry_unavailable' },
        };
      }
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
      if (all.length === 0) {
        return {
          content: [{ type: 'text', text: REGISTRY_UNAVAILABLE }],
          structuredContent: { found: false, tool_name: args.tool_name, error: 'registry_unavailable' },
        };
      }
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
      const modules = activeModules();
      const activeKeys = new Set(modules);
      const activeSets = Object.entries(TOOLSETS)
        .filter(([, keys]) => keys.some((k) => activeKeys.has(k)))
        .map(([set]) => set);
      const setLines = Object.entries(TOOLSETS)
        .map(([set, keys]) => {
          const active = keys.filter((k) => activeKeys.has(k)).length;
          return `• ${set}: ${active}/${keys.length} modules active (${keys.join(', ')})`;
        })
        .join('\n');
      const readOnly = ['1', 'true', 'yes'].includes((process.env.SPOTIFY_MCP_READONLY ?? '').toLowerCase());
      const collectBudgets = (server as unknown as { __spotifyModuleSchemaBudgets?: () => ModuleSchemaBudget[] }).__spotifyModuleSchemaBudgets;
      const moduleBudgets = collectBudgets?.() ?? [];
      const registrationExclusions = moduleBudgets.filter((row) => row.status !== 'active').map((row) => `${row.module} (${row.status})`);
      const budgetLines = moduleBudgets
        .map((row) => `• ${row.module}: ${row.status}; ${row.toolCount} tools; ${row.schemaBytes} schema bytes; ceiling ${row.maxToolCount} tools/${row.maxSchemaBytes} bytes${row.withinBudget ? '' : ' — OVER BUDGET'}`)
        .join('\n');
      const head = all.length === 0
        ? REGISTRY_UNAVAILABLE
        : `Registered tools (live): ${all.length}`;
      const text = `${head}\nActive toolsets: ${activeSets.join(', ') || '(none)'}\nread-only: ${readOnly ? 'yes' : 'no'}\n\nToolsets (SPOTIFY_MCP_TOOLSETS):\n${setLines}\n\nPer-module schema budget (description + inputSchema):\n${budgetLines}\nRegistration exclusions: ${registrationExclusions.join(', ') || '(none)'}`;
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          registered_tools: all.length,
          active_toolsets: activeSets,
          active_modules: modules,
          read_only: readOnly,
          toolsets: TOOLSETS,
          module_schema_budgets: moduleBudgets,
          registration_exclusions: registrationExclusions,
        },
      };
    },
  );
}
