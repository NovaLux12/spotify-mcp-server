/**
 * The live-registry derivation shared by the test suite (#670).
 *
 * Two gates that both had to answer "does this tool name exist?" carried their
 * own answer: a hand-copied table of 91 names in `resources-prompts.test.ts`,
 * and a private copy of the registration pass in `prompts-tool-schema.test.ts`.
 * The two non-tool allow-lists had already drifted by one entry. A hand copy is
 * wrong in the direction nobody notices — a removed tool keeps passing because
 * its name is still written down, while a newly registered tool fails because
 * nobody remembered to add it.
 *
 * So there is exactly one derivation here: walk `REGISTRAR_MANIFEST`, register
 * every module the way a full-scope install does, and read the names and
 * schemas back off the registry the server actually built. Nothing here is a
 * list of tool names, so nothing here can go stale.
 *
 * `tool.surface.test.ts` deliberately spawns the real server over stdio instead
 * — it is measuring the production path, finalizers and all — so it keeps its
 * own harness. This module is the in-process derivation for the unit gates.
 *
 * Scope note: this module derives the TOOL SURFACE — names and input schemas.
 * Toolset-parity derivation is a different question with a different owner
 * (#669); nothing here recomputes which toolset keys a module belongs to.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { REGISTRAR_MANIFEST, registerManifestModule } from '../src/tools/annotations.js';
import { SpotifyClient } from '../src/client.js';
import { moduleBlockedByScopes, scopesFor } from '../src/scopefilter.js';
import { finalInputSchema } from '../src/shaping.js';
import { registerPrompts } from '../src/prompts/index.js';

/**
 * The scopes a full install holds. Prompts are the agent-facing surface and
 * route through write tools (`add_to_queue`, `batch_add_to_queue`), so a
 * read-only or scope-trimmed registry would hide tools a prompt legitimately
 * names and the gate would fire on correct work.
 */
const FULL_SCOPE_GRANT = [
  'user-read-private', 'user-library-read', 'user-library-modify',
  'playlist-read-private', 'playlist-modify-public', 'playlist-modify-private',
  'user-follow-read', 'user-follow-modify', 'user-top-read',
  'user-modify-playback-state', 'streaming',
].join(' ');

export interface RegistryPassOptions {
  /**
   * Manifest module keys to leave unregistered. This is the seam that lets a
   * test observe what the gate does when a tool is REMOVED, without deleting a
   * tool from the source to find out.
   */
  readonly skipModules?: readonly string[];
  /**
   * Registers extra tools after the manifest pass. The mirror seam: a test can
   * add a synthetic tool and assert the derived set picks it up, which a
   * hand-maintained table structurally cannot do.
   */
  readonly extra?: (server: McpServer) => void;
}

/** Register the whole manifest the way a full-scope server does. */
export function buildFullRegistryServer(options: RegistryPassOptions = {}): McpServer {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const client = new SpotifyClient();
  const granted = scopesFor(FULL_SCOPE_GRANT);
  const skipped = new Set(options.skipModules ?? []);
  for (const module of REGISTRAR_MANIFEST) {
    if (skipped.has(module.key)) continue;
    registerManifestModule(server, client, module, {
      readOnly: false,
      // Always-active matches how the surface-budget audit (#1124) and the
      // scope-filter test (#1020) build a complete registry; a trimmed toolset
      // would hide tools prompts still reference.
      isModuleActive: () => true,
      scopeBlocked: (key) => moduleBlockedByScopes(key, granted),
    });
  }
  options.extra?.(server);
  return server;
}

/** Every registered tool name → the set of input property names it accepts. */
export function collectToolSchemas(server: McpServer): Map<string, Set<string>> {
  const registry = (server as unknown as {
    _registeredTools?: Record<string, { inputSchema?: unknown }>;
  })._registeredTools ?? {};
  const out = new Map<string, Set<string>>();
  for (const [name, entry] of Object.entries(registry)) {
    const schema = entry.inputSchema ? finalInputSchema(entry.inputSchema) : null;
    const props = schema?.properties;
    out.set(
      name,
      props && typeof props === 'object' && !Array.isArray(props)
        ? new Set(Object.keys(props as Record<string, unknown>))
        : new Set<string>(),
    );
  }
  return out;
}

// ---------------------------------------------------------------- prompts

/**
 * Snake_case tokens that appear in prompt prose but are not tool names.
 *
 * Every entry is here because a prompt presents the token as something other
 * than a tool it is asking the agent to call: a prompt argument, a
 * time-range enum value, or a Spotify field echoed in an explanation. A token
 * belongs in this set only while no prompt calls it as a tool; the moment a
 * real tool takes that name, delete the entry so the gate checks it again.
 *
 * `max_per_show` is deliberately ABSENT. It was `show_new_episodes`'s
 * per-show cap before the rename to `per_show_limit` (#716); leaving it out
 * means a prompt that reintroduces the retired spelling fails the gate instead
 * of sailing through on a stale allow-list entry — which is the exact failure
 * this module exists to remove.
 */
const NON_TOOL_IDENTIFIERS: ReadonlySet<string> = new Set([
  // Prompt argument names (src/prompts), not tools.
  'time_range', 'playlist_name',
  // Time-range enum values a prompt echoes back to the agent.
  'short_term', 'medium_term', 'long_term',
  // Prose describing what a tool call will do, using the tool's own argument
  // name so the agent does not invent a different one.
  'fetch_all', 'include_singles', 'include_groups', 'max_results', 'dry_run',
  'album_type', 'release_date', 'total_tracks',
  // show_new_episodes parameter names (#716).
  'days', 'per_show_limit', 'max_shows',
]);

/** Snake_case identifier regex matching the tokens a tool name can produce. */
const TOOL_NAME_PATTERN = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

/** A tool call with its argument list inside parens, e.g. `show_new_episodes (days=7)`. */
const CALL_PATTERN = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*\(([^)]*)\)/g;

/** An `arg=value` clause; the name is what the schema has to declare. */
export const ARG_PATTERN = /\b([a-z_][a-z0-9_]*)\s*=\s*([^,]+?)(?=,|$)/g;

export interface ExtractedCall {
  readonly tool: string;
  readonly args: readonly string[];
}

export interface ExtractedBody {
  readonly bareTools: readonly string[];
  readonly calls: readonly ExtractedCall[];
}

/** Pull tool mentions out of rendered prompt text, call-form and bare. */
export function extractBody(body: string): ExtractedBody {
  const calls: ExtractedCall[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(CALL_PATTERN)) {
    const tool = match[1];
    const args = [...match[2].matchAll(ARG_PATTERN)].map((m) => m[1]);
    const key = `${tool}|${args.join(',')}`;
    if (!seen.has(key)) {
      seen.add(key);
      calls.push({ tool, args });
    }
  }
  const bareTools = [...new Set([...body.matchAll(TOOL_NAME_PATTERN)]
    .map((m) => m[0])
    .filter((name) => !name.startsWith('spotify_') && !NON_TOOL_IDENTIFIERS.has(name)))];
  return { bareTools, calls };
}

export interface PromptSurface {
  /** Rendered prompt body by prompt name. */
  readonly prompts: ReadonlyMap<string, string>;
  /** Tool name → declared input property names, from the same registry pass. */
  readonly toolSchemas: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * One registration pass, then every prompt rendered through real MCP routing.
 *
 * `options.skipModules` / `options.extra` are forwarded to the registry pass so
 * a test can audit the surface a prompt would see if a tool were added or
 * removed, without editing the source under test.
 */
export async function promptSurface(options: RegistryPassOptions = {}): Promise<PromptSurface> {
  const server = buildFullRegistryServer(options);
  registerPrompts(server);

  const client = new Client({ name: 'tester', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(clientTransport), client.connect(serverTransport)]);
  try {
    const prompts = new Map<string, string>();
    for (const prompt of (await client.listPrompts()).prompts) {
      // Per-prompt fillers for required arguments that have a string/regex
      // shape (so the SDK accepts them); "probe" covers the rest because
      // coerce-backed number/enum fields tolerate a string here.
      const supplied: Record<string, string> = {};
      for (const arg of (prompt.arguments ?? []).filter((a) => a.required)) {
        supplied[arg.name] = arg.name === 'since' ? '2026-01-01' : 'probe';
      }
      let result;
      try {
        result = await client.getPrompt({ name: prompt.name, arguments: supplied });
      } catch (err) {
        throw new Error(`prompt ${prompt.name} failed to render with required args: ${(err as Error).message}`);
      }
      prompts.set(
        prompt.name,
        result.messages.map((m) => (m.content.type === 'text' ? m.content.text : '')).join('\n'),
      );
    }
    return { prompts, toolSchemas: collectToolSchemas(server) };
  } finally {
    await client.close();
  }
}

/** `promptName: unknown tool 'x'` for every tool a prompt names but the registry lacks. */
export function findUnknownPromptTools(surface: PromptSurface): string[] {
  const unknown: string[] = [];
  for (const [name, body] of surface.prompts) {
    for (const tool of extractBody(body).bareTools) {
      if (!surface.toolSchemas.has(tool)) unknown.push(`${name}: unknown tool '${tool}'`);
    }
  }
  return unknown;
}

/** `promptName: tool(arg=…) — 'arg' not in schema` for every undeclared argument. */
export function findUndeclaredPromptArgs(surface: PromptSurface): string[] {
  const bad: string[] = [];
  for (const [name, body] of surface.prompts) {
    for (const { tool, args } of extractBody(body).calls) {
      const props = surface.toolSchemas.get(tool);
      if (!props) continue; // covered by findUnknownPromptTools
      for (const arg of args) {
        if (!props.has(arg)) bad.push(`${name}: ${tool}(${arg}=…) — '${arg}' not in ${tool} schema`);
      }
    }
  }
  return bad;
}
