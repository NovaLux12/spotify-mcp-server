/**
 * swarm3 meta slice — 500-tool swarm v1.26.0 (issue #442).
 *
 * Discoverability tools for a 500+ tool surface: search the live tool
 * registry, inspect a single tool's schema, and report toolset/module
 * structure. Pure introspection — no Spotify API calls.
 *
 * #1601 adds the two halves the v2 plan's "lazy exposure" criterion needed and
 * never got: `call_tool`, which dispatches a REGISTERED tool by name, and
 * `enable_toolset`, which registers an inactive module into the live session
 * and emits `notifications/tools/list_changed`. Until those existed, the
 * curated default surface was a commitment rather than a starting point — a
 * host that trimmed to `core` and wanted `library_hygiene` had to restart with
 * a different `SPOTIFY_MCP_TOOLSETS`.
 *
 * Registry notes (#A0-004): the SDK keeps its tools in `McpServer`'s private
 * `_registeredTools` record, keyed by tool name; the VALUE has no `name` field.
 * Reading `tool.name` therefore produced an empty registry and all three tools
 * reported "0 tools" no matter how many were registered. The key is the name.
 *
 * Shaping notes (#713): all three declare `response_format` and emit through
 * `shapeDiscoveryResult` from shaping.ts. Two of them advertised the switch
 * without reading it, and the third did not declare it, so the discovery entry
 * point handed an agent the same bullet list whatever it asked for. There is no
 * `=== 'json'` branch in this file.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SpotifyClient } from '../client.js';
import {
  TOOLSETS,
  UNGATED_REGISTRATION_KEYS,
  isModuleActive,
  allRegistrationKeys,
  resolveToolsets,
  resolveToolOverrides,
} from '../toolsets.js';
import { DiscoveryResponseFormat, shapeDiscoveryResult } from '../shaping.js';
import { CHUNK_CAPS } from '../chunk.js';
import {
  activateRegistrationKeys,
  activeRegistrationKeys,
  dispatchRegisteredTool,
  type ActivationResult,
  type ModuleSchemaBudget,
  type RegistrarManifestContext,
  readOnlyModeEnabled,
  REGISTRAR_MANIFEST,
} from './annotations.js';

interface RegisteredToolInfo {
  name: string;
  description: string;
  inputSchema?: unknown;
}

/**
 * A tool result in this server's own envelope, for the two tools that return a
 * sentence plus a payload rather than a Spotify read (#1601).
 *
 * Deliberately NOT `shapeDiscoveryResult`. That helper takes a
 * `response_format` and renders either prose or JSON from the SAME payload,
 * which is the discovery trio's contract and is right for a tool whose whole
 * job is to be read either way. `call_tool` has no such switch — it hands back
 * whatever the tool it dispatched produced — and `enable_toolset` reports an
 * action it took. Giving either a `response_format` would advertise a mode
 * neither reads.
 *
 * It also has to be ONE shape: a handler that returns
 * `ServerResult | ShapedResult` does not satisfy `ToolCallback` at all, and the
 * failure surfaces as an unhelpful overload error on `server.tool`.
 */
function actionResult(text: string, payload: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: payload };
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
 *
 * The ungated rows are included and the `disable` term is applied ahead of
 * their exemption, so this agrees with `moduleRegistrationStatus` row for row
 * (#580). Listing only `allRegistrationKeys` reported `swarm3meta` as active
 * under `DISABLE_TOOLS=swarm3meta` — the answer the gate had already stopped
 * giving, one surface behind.
 */
function activeModules(): string[] {
  const sets = resolveToolsets(process.env.SPOTIFY_MCP_TOOLSETS).sets;
  const overrides = resolveToolOverrides(
    process.env.SPOTIFY_MCP_ENABLE_TOOLS,
    process.env.SPOTIFY_MCP_DISABLE_TOOLS,
  );
  const ungated = new Set<string>(UNGATED_REGISTRATION_KEYS);
  return [...allRegistrationKeys, ...UNGATED_REGISTRATION_KEYS].filter(
    (key) => !overrides.disable.has(key) && (ungated.has(key) || isModuleActive(key, sets, overrides)),
  );
}

export function registerSwarm3MetaTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'find_tool',
    'Search the live tool registry by name or description substring — the fastest way to discover which of the 500+ tools handles a job. Discovery set: find_tool/inspect_tool/toolset_report are always available (also via catalog). Use this first when unsure which verb to use (e.g., playlist vs snapshot vs search).',
    {
      query: z.string().min(2).describe('Case-insensitive substring to match against tool names and descriptions'),
      response_format: DiscoveryResponseFormat,
      limit: z.number().int().min(1).max(100).optional().describe('Max matches to return (default 25)'),
    },
    async (args) => {
      const q = args.query.toLowerCase();
      const limit = args.limit ?? 25;
      const all = toolRegistry(server);
      if (all.length === 0) {
        return shapeDiscoveryResult(args.response_format, REGISTRY_UNAVAILABLE, {
          query: args.query,
          total_registered: 0,
          matched: 0,
          tools: [],
          error: 'registry_unavailable',
        });
      }
      const matches = all
        .filter((t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
        .slice(0, limit);
      const lines = matches.length
        ? matches.map((t) => `• ${t.name} — ${t.description}`).join('\n')
        : `No tools match "${args.query}". Try a shorter or different substring.`;
      const text = `Matched ${matches.length} of ${all.length} registered tools:\n\n${lines}`;
      return shapeDiscoveryResult(args.response_format, text, {
        query: args.query,
        total_registered: all.length,
        matched: matches.length,
        tools: matches.map((m) => ({ name: m.name, description: m.description })),
      });
    },
  );

  server.tool(
    'inspect_tool',
    'Show one tool\'s full description and input schema before calling it',
    {
      tool_name: z.string().min(1).describe('Exact registered tool name'),
      response_format: DiscoveryResponseFormat,
    },
    async (args) => {
      const all = toolRegistry(server);
      if (all.length === 0) {
        return shapeDiscoveryResult(args.response_format, REGISTRY_UNAVAILABLE, {
          found: false,
          tool_name: args.tool_name,
          error: 'registry_unavailable',
        });
      }
      const hit = all.find((t) => t.name === args.tool_name);
      if (!hit) {
        const near = all.filter((t) => t.name.toLowerCase().includes(args.tool_name.toLowerCase().slice(0, 6))).slice(0, 5).map((t) => t.name);
        return shapeDiscoveryResult(
          args.response_format,
          `Unknown tool "${args.tool_name}".${near.length ? ` Close matches: ${near.join(', ')}` : ''}`,
          { found: false, tool_name: args.tool_name },
        );
      }
      const schema = hit.inputSchema ? JSON.stringify(hit.inputSchema, null, 2) : '(no parameters)';
      const text = `${hit.name}\n\n${hit.description}\n\nInput schema:\n${schema}`;
      return shapeDiscoveryResult(args.response_format, text, {
        found: true,
        name: hit.name,
        description: hit.description,
        input_schema: hit.inputSchema ?? {},
      });
    },
  );

  server.tool(
    'toolset_report',
    'Report the active toolsets and registration modules, plus the live registered tool count — answers "how much surface is exposed right now". Discovery set; always available. Also see find_tool / inspect_tool.',
    { response_format: DiscoveryResponseFormat },
    async (args) => {
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
      const readOnly = readOnlyModeEnabled();
      const collectBudgets = (server as unknown as { __spotifyModuleSchemaBudgets?: () => ModuleSchemaBudget[] }).__spotifyModuleSchemaBudgets;
      const moduleBudgets = collectBudgets?.() ?? [];
      const registrationExclusions = moduleBudgets.filter((row) => row.status !== 'active').map((row) => `${row.module} (${row.status})`);
      const budgetLines = moduleBudgets
        .map((row) => `• ${row.module}: ${row.status}; ${row.toolCount} tools; ${row.schemaBytes} schema bytes; ceiling ${row.maxToolCount} tools/${row.maxSchemaBytes} bytes${row.withinBudget ? '' : ' — OVER BUDGET'}`)
        .join('\n');
      const head = all.length === 0
        ? REGISTRY_UNAVAILABLE
        : `Registered tools (live): ${all.length}`;
      const capLines = Object.entries(CHUNK_CAPS).map(([kind, cap]) => `• ${kind}: ${cap} per request`).join('\n');
      const text = `${head}\nActive toolsets: ${activeSets.join(', ') || '(none)'}\nread-only: ${readOnly ? 'yes' : 'no'}\n\nToolsets (SPOTIFY_MCP_TOOLSETS):\n${setLines}\n\nPer-module schema budget (description + inputSchema):\n${budgetLines}\nRegistration exclusions: ${registrationExclusions.join(', ') || '(none)'}\n\nBatch caps (per request):\n${capLines}`;
      return shapeDiscoveryResult(args.response_format, text, {
        registered_tools: all.length,
        active_toolsets: activeSets,
        active_modules: modules,
        read_only: readOnly,
        toolsets: TOOLSETS,
        module_schema_budgets: moduleBudgets,
        registration_exclusions: registrationExclusions,
        batch_caps: CHUNK_CAPS,
      });
    },
  );

  /**
   * `call_tool` — the dispatcher half of the lazy-exposure criterion (#1601).
   *
   * `find_tool` and `inspect_tool` shipped and work; this is the "call" half
   * that never did. Without it a host on the curated `core` surface has no
   * supported way to reach a tool outside it, because the only knob that
   * changes the surface is read once at startup.
   *
   * ## What it can and cannot reach
   *
   * It dispatches REGISTERED tools only. That is the whole safety property:
   * the registry holds exactly the tools this session's toolset gate, scope
   * filter and read-only gate admitted, so a call that clears the dispatcher
   * has already cleared every gate the wire path applies. It is NOT a way to
   * reach a module the session did not register — that would silently defeat
   * `SPOTIFY_MCP_READONLY` and the per-module schema budget. Activating a
   * module is `enable_toolset`'s job, and that goes through the same budget
   * gates startup does.
   *
   * ## Why it is annotated as a write
   *
   * `classifyToolAnnotations` keys off the verb, and `call` is in neither the
   * read-only nor the mutating prefix list, so name-driven classification would
   * return `destructiveHint: false` — the hint a host reads as "safe to
   * auto-approve". A tool that can reach `delete_playlist` must never carry it,
   * so the override is stated explicitly in `annotations.ts`.
   *
   * ## Why the result is returned verbatim
   *
   * Wrapping it in a discovery envelope would put a second `structuredContent`
   * contract between the caller and the tool it asked for, and the inner result
   * has already been through the truncation cap, the attribution boundary and
   * the acting-account echo on its own handler. So the inner result is handed
   * back as-is; the only thing added is this tool's own boundary pass, which is
   * idempotent by construction (`withAttributionFooter` refuses to stack a
   * second copy of the notice).
   */
  server.tool(
    'call_tool',
    'Call any REGISTERED tool by name — the dispatcher that makes a trimmed surface usable. find_tool discovers a name, inspect_tool shows its schema. Reaches only tools this session registered; for anything else use enable_toolset. Refuses to call itself.',
    {
      name: z.string().min(1).describe('Exact registered tool name (find_tool discovers it; inspect_tool shows its schema)'),
      arguments: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Arguments for that tool, exactly as its own schema declares them'),
    },
    async (args, extra) => {
      // The one refusal that is the DISPATCHER's and not the target's. Without
      // it a caller that names itself recurses until the stack dies, and the
      // error that comes back is an opaque RangeError rather than the sentence
      // that would have told them what to do instead.
      if (args.name === 'call_tool') {
        return actionResult(
          'Refused: call_tool cannot call itself. Name the tool you actually want; use find_tool to discover it.',
          { ok: false, error: 'self_dispatch_refused', requested_tool: args.name },
        );
      }
      // Every other outcome — the unknown-name refusal with its near-matches,
      // the retired-alias refusals, the validation failures, and the successful
      // call — is the result the `tools/call` handler would have produced for
      // the same name and arguments, because it is the same dispatch.
      return dispatchRegisteredTool(server, args.name, args.arguments, extra);
    },
  );

  /**
   * `enable_toolset` — the runtime half of the lazy-exposure criterion (#1601).
   *
   * The peer of `call_tool`, and the answer to the question `call_tool` answers
   * with "not registered". Until this existed, the surface a host got was
   * decided by an environment variable read once at startup, so a trimmed
   * surface was a commitment; #566's third acceptance criterion ("discover and
   * enable a toolset at runtime, and receive a `list_changed` notification") is
   * the pair of these two tools plus the notification `activateRegistrationKeys`
   * emits.
   *
   * ## Why activation is a separate tool from dispatch
   *
   * Folding it into `call_tool` would make one argument change the session's
   * payload as a side effect of a read-shaped call. Keeping it separate means a
   * host that never calls it never pays for it, and a host that does gets a
   * result that names what changed and what it cost.
   *
   * ## What it refuses
   *
   * A module `SPOTIFY_MCP_READONLY` hides. An operator who set that flag chose
   * a hard guarantee, and a tool call from inside the session must not be able
   * to undo it — that is the same reason `call_tool` cannot reach an
   * unregistered module.
   */
  server.tool(
    'enable_toolset',
    'Register an inactive toolset into THIS session and emit the MCP tools-list-changed notification — widens the surface without a restart. Takes the SPOTIFY_MCP_TOOLSETS vocabulary (all, core, playback, catalog, playlists, library, personalization, statsfm, taste, discovery, portability). Reverts entirely if it would breach the aggregate schema budget; refuses a module SPOTIFY_MCP_READONLY hides.',
    {
      sets: z
        .array(z.string().min(1))
        .min(1)
        .max(Object.keys(TOOLSETS).length)
        .describe(`Toolset names to activate. Known sets: ${Object.keys(TOOLSETS).join(', ')}. 'all' selects every set.`),
    },
    async (args) => {
      const readOnly = readOnlyModeEnabled();
      // Resolved with the SAME resolver the startup path uses, so 'ALL',
      // ' all ' and a comma-free list behave here the way
      // `SPOTIFY_MCP_TOOLSETS=all` does there. A second resolver would be a
      // second vocabulary, and the one that drifted would be the one a host
      // learned from an error message.
      const resolved = resolveToolsets(args.sets.join(','));
      if (resolved.unknown.length > 0) {
        return actionResult(
          `Unknown toolset(s): ${resolved.unknown.join(', ')}. Known sets: ${Object.keys(TOOLSETS).join(', ')}. Nothing was activated.`,
          { ok: false, error: 'unknown_toolset', unknown_sets: resolved.unknown },
        );
      }
      const context: RegistrarManifestContext = {
        readOnly,
        // "Active" here means ACTUALLY REGISTERED IN THIS SESSION — a module
        // with live tools — not what `SPOTIFY_MCP_TOOLSETS` resolves to. The
        // two differ the moment this tool has run once, and using the env spec
        // would make the second `enable_toolset library` re-register a module
        // that is already there, which the SDK refuses with "already
        // registered" and the caller sees as a failed activation of something
        // that is working.
        isModuleActive: (key) => activeRegistrationKeys(server).has(key),
        disableOverrides: resolveToolOverrides(
          process.env.SPOTIFY_MCP_ENABLE_TOOLS,
          process.env.SPOTIFY_MCP_DISABLE_TOOLS,
        ).disable,
        // Scope filtering depends on the persisted token, which this session
        // resolved at startup. Fail-open here (nothing blocked) rather than
        // re-reading the token file: a second read could produce a different
        // answer than the one the session was registered under, and the
        // registration the caller is widening was made with the FIRST answer.
        scopeBlocked: () => false,
      };
      const keys = [...resolved.sets].flatMap((set) => [...(TOOLSETS[set] ?? [])]);
      let result: ActivationResult;
      try {
        result = await activateRegistrationKeys(server, client, keys, context);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return actionResult(
          `Activation refused: ${message}`,
          { ok: false, error: 'activation_refused', requested_sets: args.sets },
        );
      }
      // One notification per change, sent AFTER the activation committed, and
      // never when it was refused: a `list_changed` for a surface that did not
      // change is a host re-listing for nothing, and the line-oriented framing
      // the v2 plan asked for means a partial frame is worse than none.
      const changed = result.addedTools.length > 0;
      if (changed) server.sendToolListChanged();
      const lines = [
        `Activated ${result.activated.length} module(s): ${result.activated.join(', ') || '(none)'}`,
        `Registered ${result.addedTools.length} tool(s) into this session.`,
        result.alreadyActive.length > 0 ? `Already active: ${result.alreadyActive.join(', ')}` : 'Already active: none',
        `list_changed notification: ${changed ? 'sent' : 'not sent — no tool was added'}`,
      ];
      return actionResult(lines.join('\n'), {
        ok: true,
        activated_modules: result.activated,
        added_tools: result.addedTools,
        already_active: result.alreadyActive,
        list_changed_sent: changed,
        registered_tools: toolRegistry(server).length,
      });
    },
  );
}

/** Every registration key the manifest owns, for the activation predicate. */
void REGISTRAR_MANIFEST;
void UNGATED_REGISTRATION_KEYS;
void allRegistrationKeys;
