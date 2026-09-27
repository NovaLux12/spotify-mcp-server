import './helpers/hermetic.js';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { SpotifyClient } from '../src/client.js';
import { installToolErrorBoundary } from '../src/tools/annotations.js';
import { registerExhaust2PlaylistsTools } from '../src/tools/exhaust2_playlists.js';
import { registerExhaustMiscTools } from '../src/tools/exhaustmisc.js';
import { registerPlaylistBatchTools } from '../src/tools/playlistbatch.js';
import { registerPlaylistOpsTools } from '../src/tools/playlistops.js';
import { registerPlaylistTools } from '../src/tools/playlists.js';
import { asRecord } from '../src/shaping.js';
import { registerSwarm3PlaylistopsTools } from '../src/tools/swarm3_playlistops.js';
import { registerSwarm4PlaylistsTools } from '../src/tools/swarm4_playlists.js';
import type { PlaylistItemObject, SpotifyTrack } from '../src/types/spotify.js';
import { chmodSync, mkdtempSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type SchemaProperty = { type?: string; items?: unknown; [key: string]: unknown };
type ListedTool = { name: string; inputSchema?: { properties?: Record<string, SchemaProperty> } };
type ToolResponse = {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};

/**
 * #1287: `retired` is a RETIREMENT record, not an acceptance set. Each entry
 * names the spellings this tool published under a deprecation notice and no
 * longer accepts; the tool's schema must declare none of them, and a call
 * carrying one must be refused by name before any Spotify request. `overlap_
 * playlists` is here with an empty list because it was always canonical-only —
 * it is in the set/diff family, and its schema text used to promise an alias it
 * never had, which is the same doc/code disagreement this issue is about.
 */
type ToolContract =
  | { kind: 'list'; retired: readonly string[] }
  | { kind: 'pair'; retired: readonly (readonly [string, string])[] };

const TOOL_CONTRACT = {
  merge_playlists: { kind: 'list', retired: ['sources'] },
  diff_playlists: { kind: 'pair', retired: [['a', 'b']] },
  overlap_playlists: { kind: 'list', retired: [] },
  check_playlist_following: { kind: 'list', retired: ['playlist_ids'] },
  compare_playlist_covers: { kind: 'pair', retired: [['playlist_id_a', 'playlist_id_b']] },
  playlist_union: { kind: 'list', retired: ['source_playlist_ids'] },
  playlist_subtract: { kind: 'list', retired: ['subtract_playlist_ids'] },
  playlist_symmetric_difference: { kind: 'pair', retired: [['playlist_id_a', 'playlist_id_b']] },
  playlist_intersect: { kind: 'list', retired: ['source_playlist_ids'] },
  playlist_overlap_matrix: { kind: 'list', retired: ['playlist_ids'] },
  merge_playlists_plan: { kind: 'list', retired: ['playlist_ids'] },
  playlist_difference_plan: { kind: 'list', retired: ['subtract_playlist_ids'] },
  interleave_playlists_plan: { kind: 'list', retired: ['playlist_ids'] },
  playlist_intersection: { kind: 'list', retired: ['playlist_ids'] },
  playlist_union_preview: { kind: 'list', retired: ['playlist_ids'] },
  find_duplicate_tracks_across_playlists: { kind: 'list', retired: ['playlist_ids'] },
  balance_playlist_pairs: { kind: 'list', retired: ['playlist_ids'] },
  playlist_diff: { kind: 'pair', retired: [['playlist_a_id', 'playlist_b_id']] },
  playlist_pair_check: { kind: 'pair', retired: [['playlist_a_id', 'playlist_b_id']] },
} satisfies Record<string, ToolContract>;

type ToolName = keyof typeof TOOL_CONTRACT;

type CallCase = {
  canonical: Record<string, unknown>;
  /** A call built entirely from the retired spellings — must be refused. */
  retired: Record<string, unknown>;
  retiredNames: string[];
};

const PLAYLIST_1 = '1111111111111111111111';
const PLAYLIST_2 = '2222222222222222222222';
const TARGET_PLAYLIST = '3333333333333333333333';
const OTHER_PLAYLIST = '4444444444444444444444';

const CALL_CASES: Record<ToolName, CallCase> = {
  merge_playlists: {
    canonical: { playlists: [PLAYLIST_1, PLAYLIST_2], new_name: 'Merged', dry_run: true },
    retired: { sources: [PLAYLIST_1, PLAYLIST_2], new_name: 'Merged', dry_run: true },
    retiredNames: ['sources'],
  },
  diff_playlists: {
    canonical: { playlist_a: PLAYLIST_1, playlist_b: PLAYLIST_2 },
    retired: { a: PLAYLIST_1, b: PLAYLIST_2 },
    retiredNames: ['a', 'b'],
  },
  overlap_playlists: {
    canonical: { playlists: [PLAYLIST_1, PLAYLIST_2] },
    retired: { playlists: [PLAYLIST_1, PLAYLIST_2] },
    retiredNames: [],
  },
  check_playlist_following: {
    canonical: { playlists: [PLAYLIST_1, PLAYLIST_2] },
    retired: { playlist_ids: [PLAYLIST_1, PLAYLIST_2] },
    retiredNames: ['playlist_ids'],
  },
  compare_playlist_covers: {
    canonical: { playlist_a: PLAYLIST_1, playlist_b: PLAYLIST_2 },
    retired: { playlist_id_a: PLAYLIST_1, playlist_id_b: PLAYLIST_2 },
    retiredNames: ['playlist_id_a', 'playlist_id_b'],
  },
  playlist_union: {
    canonical: { playlists: [PLAYLIST_1, PLAYLIST_2], target_name: 'Union', dry_run: true },
    retired: { source_playlist_ids: [PLAYLIST_1, PLAYLIST_2], target_name: 'Union', dry_run: true },
    retiredNames: ['source_playlist_ids'],
  },
  playlist_subtract: {
    canonical: { base_playlist_id: PLAYLIST_1, playlists: [PLAYLIST_2, OTHER_PLAYLIST], dry_run: true },
    retired: { base_playlist_id: PLAYLIST_1, subtract_playlist_ids: [PLAYLIST_2, OTHER_PLAYLIST], dry_run: true },
    retiredNames: ['subtract_playlist_ids'],
  },
  playlist_symmetric_difference: {
    canonical: { playlist_a: PLAYLIST_1, playlist_b: PLAYLIST_2 },
    retired: { playlist_id_a: PLAYLIST_1, playlist_id_b: PLAYLIST_2 },
    retiredNames: ['playlist_id_a', 'playlist_id_b'],
  },
  playlist_intersect: {
    canonical: { playlists: [PLAYLIST_1, PLAYLIST_2], dry_run: true },
    retired: { source_playlist_ids: [PLAYLIST_1, PLAYLIST_2], dry_run: true },
    retiredNames: ['source_playlist_ids'],
  },
  playlist_overlap_matrix: {
    canonical: { playlists: [PLAYLIST_1, PLAYLIST_2] },
    retired: { playlist_ids: [PLAYLIST_1, PLAYLIST_2] },
    retiredNames: ['playlist_ids'],
  },
  merge_playlists_plan: {
    canonical: { playlists: [PLAYLIST_1, PLAYLIST_2], dry_run: true },
    retired: { playlist_ids: [PLAYLIST_1, PLAYLIST_2], dry_run: true },
    retiredNames: ['playlist_ids'],
  },
  playlist_difference_plan: {
    canonical: { base_playlist_id: PLAYLIST_1, playlists: [PLAYLIST_1, PLAYLIST_2], dry_run: true },
    retired: { base_playlist_id: PLAYLIST_1, subtract_playlist_ids: [PLAYLIST_1, PLAYLIST_2], dry_run: true },
    retiredNames: ['subtract_playlist_ids'],
  },
  interleave_playlists_plan: {
    canonical: { playlists: [PLAYLIST_1, PLAYLIST_2], dry_run: true },
    retired: { playlist_ids: [PLAYLIST_1, PLAYLIST_2], dry_run: true },
    retiredNames: ['playlist_ids'],
  },
  playlist_intersection: {
    canonical: { playlists: [PLAYLIST_1, PLAYLIST_2] },
    retired: { playlist_ids: [PLAYLIST_1, PLAYLIST_2] },
    retiredNames: ['playlist_ids'],
  },
  playlist_union_preview: {
    canonical: { playlists: [PLAYLIST_1, PLAYLIST_2] },
    retired: { playlist_ids: [PLAYLIST_1, PLAYLIST_2] },
    retiredNames: ['playlist_ids'],
  },
  playlist_diff: {
    canonical: { playlist_a: PLAYLIST_1, playlist_b: PLAYLIST_2 },
    retired: { playlist_a_id: PLAYLIST_1, playlist_b_id: PLAYLIST_2 },
    retiredNames: ['playlist_a_id', 'playlist_b_id'],
  },
  playlist_pair_check: {
    canonical: { playlist_a: PLAYLIST_1, playlist_b: PLAYLIST_2 },
    retired: { playlist_a_id: PLAYLIST_1, playlist_b_id: PLAYLIST_2 },
    retiredNames: ['playlist_a_id', 'playlist_b_id'],
  },
  find_duplicate_tracks_across_playlists: {
    canonical: { playlists: [PLAYLIST_1, PLAYLIST_2] },
    retired: { playlist_ids: [PLAYLIST_1, PLAYLIST_2] },
    retiredNames: ['playlist_ids'],
  },
  balance_playlist_pairs: {
    canonical: { playlists: [PLAYLIST_1, PLAYLIST_2], dry_run: true },
    retired: { playlist_ids: [PLAYLIST_1, PLAYLIST_2], dry_run: true },
    retiredNames: ['playlist_ids'],
  },
};

function makeClient(calls: string[]): SpotifyClient {
  const client = {
    async get<T>(path: string): Promise<T | null> {
      calls.push(path);
      // #1004: this used to answer `/playlists/{id}/followers/contains`, a
      // route Spotify's February 2026 changelog marks REMOVED. No tool calls
      // it any more — `check_playlist_following` reads
      // `GET /me/library/contains?uris=spotify:playlist:<id>` (#862) — so the
      // branch was dead, and a dead branch that answers a removed endpoint is
      // worse than none: it reads like the server depends on the route.
      // `tools.playlists-following.test.ts` is where that is pinned, with a
      // deepEqual over the whole call log rather than a permissive mock.
      if (path.endsWith('/images')) return [] as T;
      const id = decodeURIComponent(path.replace('/playlists/', ''));
      return { id, name: `Playlist ${id}` } as T;
    },
    // The real `getAllPages(path, params?, opts?)` — the wrapping walk above
    // forwards all three, so a double that accepted only `path` was not the
    // signature the tools actually call.
    async getAllPages<T>(
      path: string,
      _params?: Record<string, string>,
      _opts?: { maxItems?: number; initialOffset?: number },
    ): Promise<T[]> {
      calls.push(path);
      return [];
    },
    // #899/#902: playlistops reads through the truncating variant — #899 to
    // count its read cost off the walk, #902 because merge_playlists' source
    // walk goes through it. This delegates to getAllPages so the path-recording
    // and stubbed rows stay in ONE place; a second copy of the fixture logic
    // would drift from it.
    async getAllPagesWithTruncation<T>(
      path: string,
      params?: Record<string, string>,
      opts?: { maxItems?: number; initialOffset?: number },
    ): Promise<{
      items: T[];
      truncated: boolean;
      truncatedByCap: boolean;
      reportedTotal: number | null;
      pages: number;
    }> {
      const items = await this.getAllPages<T>(path, params, opts);
      return { items, truncated: false, truncatedByCap: false, reportedTotal: null, pages: 1 };
    },
    async post<T>(): Promise<T | null> {
      return { id: 'created', snapshot_id: 'snapshot' } as T;
    },
    async put<T>(): Promise<T | null> {
      return { snapshot_id: 'snapshot' } as T;
    },
    async delete<T>(): Promise<T | null> {
      return { snapshot_id: 'snapshot' } as T;
    },
  };
  // The cast sits on the RETURN, not on the literal: `({...} as unknown as
  // SpotifyClient)` gives the object literal the contextual type `unknown`, so
  // `this` inside its own methods resolved to `{}` and every `this.getAllPages`
  // read below was an error against a type the fixture never had.
  return client as unknown as SpotifyClient;
}

interface PlaylistHarness {
  calls: string[];
  listed: ListedTool[];
  invoke: (name: string, args: Record<string, unknown>) => Promise<ToolResponse>;
  close: () => Promise<void>;
}

async function makeHarness(): Promise<PlaylistHarness> {
  const calls: string[] = [];
  const client = makeClient(calls);
  const server = new McpServer({ name: 'playlist-schema-contract', version: '0.0.0' });
  registerPlaylistTools(server, client);
  registerPlaylistOpsTools(server, client);
  registerPlaylistBatchTools(server, client);
  registerExhaust2PlaylistsTools(server, client);
  registerExhaustMiscTools(server, client);
  registerSwarm3PlaylistopsTools(server, client);
  registerSwarm4PlaylistsTools(server, client);
  // The production boundary, not just the registrars. Zod strips an unknown
  // key before the handler runs, so a retired spelling is INVISIBLE to
  // `resolvePlaylistInput` on this path — the refusal has to be proven where a
  // real call meets it, or the test would only be proving that zod dropped a
  // field and the handler then reported a missing canonical one.
  installToolErrorBoundary(server);

  const caller = new Client({ name: 'playlist-schema-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([caller.connect(clientTransport), server.connect(serverTransport)]);
  const listed = (await caller.listTools()).tools as ListedTool[];
  return {
    calls,
    listed,
    invoke: async (name: string, args: Record<string, unknown>): Promise<ToolResponse> => {
      const result = await caller.callTool({ name, arguments: args });
      return result as unknown as ToolResponse;
    },
    close: async () => {
      await Promise.all([caller.close(), server.close()]);
    },
  };
}
type ElicitAnswer = { action: 'accept' | 'decline' | 'cancel'; confirm?: boolean } | Error | null;

interface UnionGateHarness {
  calls: string[];
  /** Message of every elicitation prompt the server raised, in order. */
  prompts: string[];
  invoke: (name: 'playlist_union' | 'playlist_subtract', args: Record<string, unknown>) => Promise<ToolResponse>;
  close: () => Promise<void>;
}

interface UnionGateOptions {
  /** null models a client that advertises no elicitation capability at all. */
  answer: ElicitAnswer;
  toolName?: 'playlist_union' | 'playlist_subtract';
  /** Ordered rows the first source yields (p1 -> a*). */
  sourceCount?: number;
  /** Ordered rows the second source yields (p2 -> b*); defaults to sourceCount. */
  source2Count?: number;
  /** Ordered rows the subtraction source yields (p2 -> subtractUris). */
  subtractUris?: string[];
  targetUris?: string[];
  /** Rows the target reports via items.total; defaults to targetUris.length. */
  targetTotal?: number;
  /** Unavailable rows the target returns as `item: null`, which a replace cannot restore. */
  targetNullUris?: number;
  /**
   * Make the playlist the revalidation re-reads (union target / subtract base)
   * return different rows on its second read, as a concurrent writer would.
   */
  mutateOnSecondRead?: boolean;
}

async function makeUnionGateHarness(options: UnionGateOptions): Promise<UnionGateHarness> {
  const { answer, toolName = 'playlist_union', sourceCount = 50, source2Count, targetUris, targetTotal, targetNullUris = 0, subtractUris, mutateOnSecondRead = false } = options;
  let targetReads = 0;
  let baseReads = 0;
  const calls: string[] = [];
  const prompts: string[] = [];
  const client = {
    async get<T>(path: string): Promise<T | null> {
      calls.push(path);
      const id = path.split('/').pop() ?? 'playlist';
      const rows = id === PLAYLIST_1 ? sourceCount : id === PLAYLIST_2 ? (source2Count ?? sourceCount) : (targetUris ?? Array.from({ length: 50 }, (_, i) => `spotify:track:b${i}`)).length;
      // `items` is the current PlaylistObject field; `tracks` is deprecated.
      return { id, name: 'Playlist', items: { total: targetTotal ?? rows + targetNullUris } } as T;
    },
    async getAllPages<T>(
      path: string,
      _params?: Record<string, string>,
      _opts?: { maxItems?: number; initialOffset?: number },
    ): Promise<T[]> {
      calls.push(path);
      const first = path.includes(`/${PLAYLIST_1}/items`);
      const second = path.includes(`/${PLAYLIST_2}/items`);
      if (first || second) {
        if (toolName === 'playlist_subtract' && second) return (subtractUris ?? []).map((uri, index) => ({ item: { id: uri, uri, name: `Track ${index}` } })) as T[];
        if (first) baseReads += 1;
        const rows = Array.from({ length: first ? sourceCount : (source2Count ?? sourceCount) }, (_, index) => {
          const uri = `spotify:track:${first ? 'a' : 'b'}${index}`;
          return { item: { id: uri, uri, name: `Track ${index}` } };
        });
        // The union re-reads its target; the subtraction re-reads its base.
        if (mutateOnSecondRead && first && toolName === 'playlist_subtract' && baseReads > 1) {
          rows.push({ item: { id: 'spotify:track:racer', uri: 'spotify:track:racer', name: 'Added mid-flight' } });
        }
        return rows as T[];
      }
      // A concurrent writer between the impact read and the revalidation
      // read: the second walk must see something the first did not.
      targetReads += 1;
      const target = targetUris ?? Array.from({ length: 50 }, (_, index) => `spotify:track:b${index}`);
      const items: PlaylistItemObject[] = target.map((uri, index) => ({
        added_at: '2024-01-01T00:00:00Z',
        item: { id: uri, uri, name: `Track ${index}` } as SpotifyTrack,
      }));
      // Spotify represents an unavailable/local row as a present row whose
      // item is null. It still occupies a slot in the playlist, and a
      // URI-based replace cannot restore it.
      for (let i = 0; i < targetNullUris; i += 1) items.push({ added_at: '2024-01-01T00:00:00Z', item: null });
      if (mutateOnSecondRead && toolName === 'playlist_union' && targetReads > 1) {
        items.push({ added_at: '2024-01-01T00:00:00Z', item: { id: 'spotify:track:racer', uri: 'spotify:track:racer', name: 'Added mid-flight' } as SpotifyTrack });
      }
      return items as T[];
    },
    // #899: see the note on the other stub — delegates so the fixture rows and
    // the recorded call stay defined once.
    async getAllPagesWithTruncation<T>(
      path: string,
      params?: Record<string, string>,
      opts?: { maxItems?: number; initialOffset?: number },
    ): Promise<{
      items: T[];
      truncated: boolean;
      truncatedByCap: boolean;
      reportedTotal: number | null;
      pages: number;
    }> {
      const items = await this.getAllPages<T>(path, params, opts);
      return { items, truncated: false, truncatedByCap: false, reportedTotal: null, pages: 1 };
    },
    async post<T>(path: string): Promise<T | null> {
      calls.push(`POST ${path}`);
      return { id: 'created' } as T;
    },
    async put<T>(path: string): Promise<T | null> {
      calls.push(`PUT ${path}`);
      return { snapshot_id: 'snapshot' } as T;
    },
    async delete<T>(): Promise<T | null> {
      return null;
    },
  };
  const server = new McpServer({ name: 'union-confirm-contract', version: '0.0.0' });
  registerPlaylistTools(server, client as unknown as SpotifyClient);
  // No error boundary here: this harness exercises the confirmation gate, and
  // the boundary converts a thrown guard into a typed envelope. The retirement
  // refusal is proven against the boundary in the main harness above.
  const caller = new Client(
    { name: 'union-confirm-client', version: '0.0.0' },
    answer === null ? undefined : { capabilities: { elicitation: { form: {} } } },
  );
  if (answer !== null) caller.setRequestHandler(ElicitRequestSchema, async (request) => {
    prompts.push(request.params.message);
    if (answer instanceof Error) throw answer;
    if (answer.action === 'accept') return { action: answer.action, content: { confirm: answer.confirm ?? true } };
    return { action: answer.action };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([caller.connect(clientTransport), server.connect(serverTransport)]);
  return {
    calls,
    prompts,
    invoke: async (name, args) => {
      const result = await caller.callTool({ name, arguments: args });
      return result as unknown as ToolResponse;
    },
    close: async () => {
      await Promise.all([caller.close(), server.close()]);
    },
  };
}

function textOf(response: ToolResponse): string {
  return response.content.map((item) => item.text ?? '').join('\n');
}

function relevantSchemaFields(tool: ListedTool, contract: ToolContract): string[] {
  const properties = tool.inputSchema?.properties ?? {};
  if (contract.kind === 'list') {
    return Object.entries(properties)
      .filter(([name, schema]) => schema.type === 'array' && name.includes('playlist'))
      .map(([name]) => name);
  }
  return Object.keys(properties).filter((name) => name === 'playlist_a' || name === 'playlist_b');
}

describe('playlist set/diff schema and resolver contract (#912)', () => {
  let harness: PlaylistHarness;

  before(async () => {
    harness = await makeHarness();
  });

  after(async () => {
    await harness.close();
  });

  it('advertises only canonical names — no retired spelling survives in any schema', () => {
    const discovered = harness.listed.filter((tool) => {
      const properties = tool.inputSchema?.properties ?? {};
      const hasPlaylistCollection = Object.entries(properties).some(([name, schema]) =>
        schema.type === 'array' && name.includes('playlist'));
      const hasPair = ['playlist_a', 'playlist_b'].some((name) => name in properties);
      return hasPlaylistCollection || hasPair;
    }).map((tool) => tool.name).sort();
    assert.deepEqual(discovered, Object.keys(TOOL_CONTRACT).sort());
    const byName = new Map(harness.listed.map((tool) => [tool.name, tool]));
    for (const [name, contract] of Object.entries(TOOL_CONTRACT) as Array<[ToolName, (typeof TOOL_CONTRACT)[ToolName]]>) {
      const tool = byName.get(name);
      assert.ok(tool, `${name} must be registered`);
      const properties = tool.inputSchema?.properties ?? {};
      const actual = relevantSchemaFields(tool, contract);
      const expected = contract.kind === 'list' ? ['playlists'] : ['playlist_a', 'playlist_b'];
      assert.deepEqual(actual, expected, `${name} playlist input drift`);
      // The removal contract itself: not just "not in the filtered set" but
      // "not a property of this tool at all", so a re-added alias under a name
      // the filter would not have caught still fails.
      for (const retired of contract.kind === 'list' ? contract.retired : contract.retired.flat()) {
        assert.ok(!(retired in properties), `${name} still advertises retired input ${retired}`);
      }
      if (contract.kind === 'list') assert.equal(properties.playlists?.type, 'array');
      else {
        assert.equal(properties.playlist_a?.type, 'string');
        assert.equal(properties.playlist_b?.type, 'string');
        assert.ok(actual.indexOf('playlist_a') < actual.indexOf('playlist_b'), `${name} A/B order`);
      }
    }
  });

  it('serves every canonical call unchanged and reports no deprecation metadata', async () => {
    for (const [name, callCase] of Object.entries(CALL_CASES) as Array<[ToolName, (typeof CALL_CASES)[ToolName]]>) {
      harness.calls.length = 0;
      const canonical = await harness.invoke(name, callCase.canonical);
      assert.ok(!canonical.isError, `${name} canonical call failed: ${textOf(canonical)}`);
      // A canonical call must carry NEITHER field. #1287 removed the only input
      // path that could produce them, so if either reappears the aliases are
      // back or a new deprecated input was added without a contract.
      assert.equal(canonical.structuredContent?.deprecated_inputs, undefined, `${name} canonical output leaked deprecated_inputs`);
      assert.equal(canonical.structuredContent?.deprecation_note, undefined, `${name} canonical output leaked deprecation_note`);
      assert.doesNotMatch(textOf(canonical), /Deprecated input/, `${name} canonical prose leaked a deprecation note`);
    }
  });

  it('refuses every retired spelling before any Spotify request, naming the replacement', async () => {
    for (const [name, callCase] of Object.entries(CALL_CASES) as Array<[ToolName, (typeof CALL_CASES)[ToolName]]>) {
      if (callCase.retiredNames.length === 0) continue;
      const contract = TOOL_CONTRACT[name];
      const canonical = contract.kind === 'list' ? 'playlists' : 'playlist_a/playlist_b';
      harness.calls.length = 0;
      let message: string;
      let structured: Record<string, unknown> | undefined;
      try {
        const result = await harness.invoke(name, callCase.retired);
        assert.equal(result.isError, true, `${name} accepted retired input ${callCase.retiredNames.join(', ')}`);
        message = textOf(result);
        structured = result.structuredContent;
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      // Both halves matter: the refusal must NAME what was sent and WHAT to
      // send instead. An `unknown_param` with a Levenshtein hint names neither
      // with certainty, and claims the server never had the name — which is
      // false, it published it until v3.0.
      for (const retired of callCase.retiredNames) {
        assert.ok(message.includes(retired), `${name} refusal did not name ${retired}: ${message}`);
      }
      assert.ok(message.includes(canonical), `${name} refusal did not name ${canonical}: ${message}`);
      // The LITERAL version, never `new RegExp(RETIRED_PLAYLIST_INPUTS_REMOVED_IN)`:
      // a regex built from the same constant the message is built from cannot
      // fail, however the release is re-dated. "removed in v3.0" is the one
      // string a caller greps for when they are still sending the old name, so
      // the wrong version here is a real defect, not a cosmetic one.
      assert.match(message, /removed in v3\.0/, `${name} refusal did not state the removal version`);
      // `asRecord`, not a cast: the refusal envelope is then read the same way
      // the server writes it, so a refusal that dropped `error` reads as
      // `undefined` here and fails, rather than type-erroring or silently
      // comparing equal to a missing field.
      if (structured) {
        const error = asRecord(structured.error);
        assert.equal(error?.kind, 'validation', `${name} refusal was not a typed validation error`);
        assert.equal(error?.reason, 'retired_input', `${name} refusal reason was not retired_input`);
      }
      assert.deepEqual(harness.calls, [], `${name} reached Spotify before refusing a retired input`);
    }
  });

  it('still refuses a missing or half-supplied canonical input by naming the field', async () => {
    // Removing an alias must not have turned a missing canonical value into a
    // silent no-op: these are the same refusals the alias path used to make.
    for (const [name, args] of [
      ['playlist_union', { target_playlist_id: TARGET_PLAYLIST }],
      ['compare_playlist_covers', { playlist_a: PLAYLIST_1 }],
      ['diff_playlists', { playlist_a: PLAYLIST_1 }],
    ] as Array<[string, Record<string, unknown>]>) {
      harness.calls.length = 0;
      let message: string;
      try {
        const result = await harness.invoke(name, args);
        assert.equal(result.isError, true, `${name} accepted an incomplete canonical input`);
        message = textOf(result);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assert.match(message, /playlist/, `${name} refusal did not name the playlist input: ${message}`);
      assert.deepEqual(harness.calls, [], `${name} reached Spotify before refusing an incomplete input`);
    }
  });

  it('requires exactly one union target before reading sources', async () => {
    for (const args of [
      { playlists: [PLAYLIST_1, PLAYLIST_2] },
      { playlists: [PLAYLIST_1, PLAYLIST_2], target_playlist_id: TARGET_PLAYLIST, target_name: 'new' },
    ]) {
      harness.calls.length = 0;
      const result = await harness.invoke('playlist_union', args);
      assert.equal(result.isError, true, 'invalid union target combination succeeded');
      assert.deepEqual(harness.calls, [], 'union read sources before validating its target');
    }
  });

  it('confirms existing-target replacement and refuses declined or transport-error prompts without writes', async () => {
    const cases = [
      { label: 'confirmed', answer: { action: 'accept' as const, confirm: true }, writes: 1 },
      { label: 'declined', answer: { action: 'decline' as const }, writes: 0 },
      { label: 'transport-error', answer: new Error('elicitation transport failed'), writes: 0 },
    ] as const;
    for (const testCase of cases) {
      const gate = await makeUnionGateHarness({ answer: testCase.answer });
      const result = await gate.invoke('playlist_union', { playlists: [PLAYLIST_1, PLAYLIST_2], target_playlist_id: TARGET_PLAYLIST });
      const writes = gate.calls.filter((call) => call.startsWith('PUT ') || call.startsWith('POST '));
      assert.equal(writes.length, testCase.writes, `${testCase.label} write count`);
      if (testCase.label === 'confirmed') assert.equal(result.structuredContent?.ok, true);
      else {
        assert.equal(result.structuredContent?.ok, false);
        assert.equal(result.structuredContent?.cancelled, true);
        if (testCase.label === 'transport-error') assert.equal(result.structuredContent?.reason, 'elicitation_failed');
        assert.equal(result.structuredContent?.deprecated_inputs, undefined, `${testCase.label} leaked deprecated_inputs`);
        assert.equal(result.structuredContent?.deprecation_note, undefined, `${testCase.label} leaked deprecation_note`);
      }
      await gate.close();
    }
  });

  it('refuses destructive union but allows identical subtraction without elicitation support', async () => {
    const cases = [
      { name: 'playlist_union' as const, args: { playlists: [PLAYLIST_1, PLAYLIST_2], target_playlist_id: TARGET_PLAYLIST }, ok: false, writes: 0, unchanged: false },
      { name: 'playlist_subtract' as const, args: { base_playlist_id: PLAYLIST_1, playlists: [PLAYLIST_2] }, ok: true, writes: 0, unchanged: true },
    ];
    for (const testCase of cases) {
      const gate = await makeUnionGateHarness({ answer: null, toolName: testCase.name });
      const result = await gate.invoke(testCase.name, testCase.args);
      assert.equal(result.structuredContent?.ok, testCase.ok, `${testCase.name} no-op impact handling`);
      if (testCase.unchanged) assert.equal(result.structuredContent?.unchanged, true);
      if (!testCase.ok) {
        assert.equal(result.structuredContent?.reason, 'confirmation_unavailable');
      } else {
        assert.deepEqual(gate.prompts, []);
      }
      assert.equal(gate.calls.filter((call) => call.startsWith('PUT ') || call.startsWith('POST ')).length, testCase.writes);
      await gate.close();
    }
  });

  // The revalidation read is the only thing between an impact measured at T0
  // and a whole-playlist overwrite at T1. Both set-op tools must abort with
  // zero writes when the playlist changed underneath them.
  for (const testCase of [
    { name: 'playlist_union' as const, args: { playlists: [PLAYLIST_1, PLAYLIST_2], target_playlist_id: TARGET_PLAYLIST }, toolName: 'playlist_union' as const },
    { name: 'playlist_subtract' as const, args: { base_playlist_id: PLAYLIST_1, playlists: [PLAYLIST_2] }, toolName: 'playlist_subtract' as const },
  ]) {
    it(`refuses to overwrite when the playlist changed mid-flight (${testCase.name})`, async () => {
      const gate = await makeUnionGateHarness({
        answer: { action: 'accept', confirm: true },
        toolName: testCase.toolName,
        subtractUris: ['spotify:track:a0'],
        mutateOnSecondRead: true,
      });
      try {
        let message = '';
        try {
          const result = await gate.invoke(testCase.name, testCase.args);
          message = result.isError === true ? textOf(result) : `expected a refusal, got ok=${String(result.structuredContent?.ok)}`;
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        assert.match(message, /changed during/, `${testCase.name} did not report the mid-flight change`);
        assert.equal(gate.calls.filter((call) => call.startsWith('PUT ') || call.startsWith('POST ')).length, 0, `${testCase.name} wrote after detecting a mid-flight change`);
      } finally {
        await gate.close();
      }
    });
  }

  it('confirms overlapping subtraction even when only ten of 100 rows survive', async () => {
    const gate = await makeUnionGateHarness({
      answer: { action: 'accept', confirm: true },
      toolName: 'playlist_subtract',
      sourceCount: 100,
      subtractUris: Array.from({ length: 90 }, (_, index) => `spotify:track:a${index}`),
    });
    try {
      const result = await gate.invoke('playlist_subtract', {
        base_playlist_id: PLAYLIST_1,
        playlists: [PLAYLIST_2],
      });
      // `removed`/`kept` are the returned row counts (bounded by max_results);
      // the `*_total` fields carry the true impact the confirmation quoted.
      assert.equal(result.structuredContent?.removed_total, 90);
      assert.equal(result.structuredContent?.kept_total, 10);
      assert.equal(result.structuredContent?.removed, 50, 'the removed array is capped by max_results');
      assert.equal(result.structuredContent?.kept, 10);
      assert.equal((result.structuredContent?.removed_uris as string[]).length, 50);
      assert.equal(gate.prompts.length, 1, 'a non-empty destructive impact must prompt');
      assert.match(gate.prompts[0] ?? '', /removing 90 URI\(s\)/);
      assert.equal(result.structuredContent?.ok, true);
      assert.deepEqual(gate.calls.filter((call) => call.startsWith('PUT ')), [`PUT /playlists/${PLAYLIST_1}/items`]);
    } finally {
      await gate.close();
    }
  });

  // The union gate is driven by what an overwrite destroys, not by how many
  // URIs arrive. A tiny union can wipe a large target, and a huge union into a
  // fresh playlist destroys nothing.
  it('confirms a one-row union that would gut a 100-row target', async () => {
    const gate = await makeUnionGateHarness({
      answer: { action: 'accept', confirm: true },
      // p1 contributes one row, p2 none, so the union is a single URI.
      sourceCount: 1,
      source2Count: 0,
      targetUris: Array.from({ length: 100 }, (_, index) => `spotify:track:t${index}`),
    });
    try {
      const result = await gate.invoke('playlist_union', { playlists: [PLAYLIST_1, PLAYLIST_2], target_playlist_id: TARGET_PLAYLIST });
      assert.equal(result.structuredContent?.uri_count, 1, 'the union must be one row');
      assert.equal(gate.prompts.length, 1, 'a 1-row union deleting 100 rows must still ask');
      assert.match(gate.prompts[0] ?? '', /Remove 100 existing item\(s\)/);
      assert.equal(result.structuredContent?.ok, true);
      assert.deepEqual(gate.calls.filter((call) => call.startsWith('PUT ')), [`PUT /playlists/${TARGET_PLAYLIST}/items`]);
    } finally {
      await gate.close();
    }
  });

  it('returns unchanged without prompting or rewriting identical contents', async () => {
    const gate = await makeUnionGateHarness({
      answer: { action: 'accept', confirm: true },
      sourceCount: 50,
      targetUris: [
        ...Array.from({ length: 50 }, (_, index) => `spotify:track:a${index}`),
        ...Array.from({ length: 50 }, (_, index) => `spotify:track:b${index}`),
      ],
    });
    try {
      const result = await gate.invoke('playlist_union', { playlists: [PLAYLIST_1, PLAYLIST_2], target_playlist_id: TARGET_PLAYLIST });
      assert.deepEqual(gate.prompts, [], 'identical contents must not prompt');
      assert.equal(result.structuredContent?.ok, true);
      assert.equal(result.structuredContent?.unchanged, true);
      assert.deepEqual(gate.calls.filter((call) => call.startsWith('PUT ')), []);
    } finally {
      await gate.close();
    }
  });

  it('confirms a pure addition, which is still a non-identical replacement', async () => {
    const gate = await makeUnionGateHarness({
      answer: { action: 'accept', confirm: true },
      sourceCount: 2,
      // Target is a strict subset of the union: nothing removed, nothing
      // reordered, but the replacement is still not identical.
      targetUris: ['spotify:track:a0', 'spotify:track:a1'],
    });
    try {
      const result = await gate.invoke('playlist_union', { playlists: [PLAYLIST_1, PLAYLIST_2], target_playlist_id: TARGET_PLAYLIST });
      assert.equal(gate.prompts.length, 1, 'adding rows rewrites the playlist and must ask');
      assert.match(gate.prompts[0] ?? '', /Add 2 new item\(s\)/);
      assert.equal(gate.prompts[0]?.includes('Remove'), false);
      assert.equal(result.structuredContent?.ok, true);
    } finally {
      await gate.close();
    }
  });

  it('asks when the target read stopped short, instead of assuming a no-op', async () => {
    // Rows read match the union exactly, but Spotify reports far more rows than
    // the capped walk returned — the unread tail could all be destroyed.
    const gate = await makeUnionGateHarness({
      answer: { action: 'accept', confirm: true },
      sourceCount: 1,
      targetUris: ['spotify:track:a0', 'spotify:track:b0'],
      targetTotal: 9000,
    });
    try {
      const result = await gate.invoke('playlist_union', { playlists: [PLAYLIST_1, PLAYLIST_2], target_playlist_id: TARGET_PLAYLIST });
      assert.equal(gate.prompts.length, 1, 'an incomplete read must not be treated as a no-op');
      assert.match(gate.prompts[0] ?? '', /Only 2 of 9000 existing row\(s\) could be read/);
      assert.equal(result.structuredContent?.ok, true);
    } finally {
      await gate.close();
    }
  });

  it('refuses, rather than prompting, when the target holds rows a URI-based replace cannot restore', async () => {
    // #860: the old answer here was to ask, and delete the null-URI rows once
    // the operator said yes. A prompt can NAME a loss and still consent to it,
    // so a full replace over a target with rows that have no URI is now
    // refused before any prompt is raised.
    const gate = await makeUnionGateHarness({
      answer: { action: 'accept', confirm: true },
      sourceCount: 1,
      targetUris: ['spotify:track:a0', 'spotify:track:b0'],
      targetNullUris: 3,
    });
    try {
      const result = await gate.invoke('playlist_union', { playlists: [PLAYLIST_1, PLAYLIST_2], target_playlist_id: TARGET_PLAYLIST });
      assert.equal(result.isError, true, 'a URI-based replace over null-URI rows must be refused');
      const message = textOf(result);
      assert.match(message, /contains 3 unavailable item\(s\)/);
      assert.match(message, /at 1-based position\(s\) 3, 4, 5/);
      assert.match(message, /remove_unavailable_playlist_items/);
      assert.deepEqual(gate.prompts, [], 'a refusal must not first ask for permission to lose the rows');
      assert.deepEqual(gate.calls.filter((call) => call.startsWith('PUT ')), [], 'the atomic replace must not run');
    } finally {
      await gate.close();
    }
  });

  it('does not prompt when a large union creates a new target', async () => {
    // No elicitation capability at all: a gate that fired here would refuse.
    const gate = await makeUnionGateHarness({ answer: null, sourceCount: 50 });
    try {
      const result = await gate.invoke('playlist_union', { playlists: [PLAYLIST_1, PLAYLIST_2], target_name: 'Fresh' });
      assert.deepEqual(gate.prompts, [], 'creating a new playlist prompted');
      assert.equal(result.structuredContent?.ok, true);
      assert.deepEqual(gate.calls.filter((call) => call.startsWith('POST ')), ['POST /me/playlists']);
      assert.equal(gate.calls.includes(`/playlists/${TARGET_PLAYLIST}/items`), false);
    } finally {
      await gate.close();
    }
  });

  it('refuses a destructive union with no elicitation support and writes nothing', async () => {
    const gate = await makeUnionGateHarness({
      answer: null,
      sourceCount: 1,
      targetUris: Array.from({ length: 100 }, (_, index) => `spotify:track:t${index}`),
    });
    try {
      const result = await gate.invoke('playlist_union', { playlists: [PLAYLIST_1, PLAYLIST_2], target_playlist_id: TARGET_PLAYLIST });
      assert.equal(result.structuredContent?.ok, false, 'destructive union proceeded without confirmation');
      assert.equal(result.structuredContent?.reason, 'confirmation_unavailable');
      assert.deepEqual(gate.calls.filter((call) => call.startsWith('PUT ') || call.startsWith('POST ')), []);
    } finally {
      await gate.close();
    }
  });

  it('lets SPOTIFY_MCP_CONFIRM=never bypass the destructive union gate', async () => {
    const previous = process.env.SPOTIFY_MCP_CONFIRM;
    process.env.SPOTIFY_MCP_CONFIRM = 'never';
    try {
      const gate = await makeUnionGateHarness({
        answer: null,
        sourceCount: 1,
        targetUris: Array.from({ length: 100 }, (_, index) => `spotify:track:t${index}`),
      });
      try {
        const result = await gate.invoke('playlist_union', { playlists: [PLAYLIST_1, PLAYLIST_2], target_playlist_id: TARGET_PLAYLIST });
        assert.deepEqual(gate.prompts, [], 'the never bypass still prompted');
        assert.equal(result.structuredContent?.ok, true);
        assert.deepEqual(gate.calls.filter((call) => call.startsWith('PUT ')), [`PUT /playlists/${TARGET_PLAYLIST}/items`]);
      } finally {
        await gate.close();
      }
    } finally {
      if (previous === undefined) delete process.env.SPOTIFY_MCP_CONFIRM;
      else process.env.SPOTIFY_MCP_CONFIRM = previous;
    }
  });

  it('normalizes Spotify URIs and URLs to raw playlist IDs on the wire', async () => {
    harness.calls.length = 0;
    const result = await harness.invoke('overlap_playlists', {
      playlists: [
        `spotify:playlist:${PLAYLIST_1}`,
        `https://open.spotify.com/embed/intl-de/playlist/${PLAYLIST_2}`,
      ],
    });
    assert.ok(!result.isError, textOf(result));
    assert.deepEqual(harness.calls, [`/playlists/${PLAYLIST_1}/items`, `/playlists/${PLAYLIST_2}/items`]);
  });
});

// #1084: every new playlistops-pre-*.json snapshot must end up 0600 after
// backupItemsBeforeWrite runs through sort_playlist_apply, even if a previous
// run had loosened the directory or the file existed already.
describe('playlistops pre-write backup mode (#1084)', () => {
  let backupDir: string;
  let prevBackupDir: string | undefined;

  before(() => {
    backupDir = mkdtempSync(join(tmpdir(), 'plops-backup-'));
    prevBackupDir = process.env.SPOTIFY_MCP_BACKUP_DIR;
    process.env.SPOTIFY_MCP_BACKUP_DIR = backupDir;
  });

  after(() => {
    if (prevBackupDir === undefined) delete process.env.SPOTIFY_MCP_BACKUP_DIR;
    else process.env.SPOTIFY_MCP_BACKUP_DIR = prevBackupDir;
    rmSync(backupDir, { recursive: true, force: true });
  });

  it('writes the pre-write backup with mode 0600', async () => {
    const before = readdirSync(backupDir);
    const localHarness = await makeHarness();
    try {
      await localHarness.invoke('sort_playlist_apply', {
        playlist_id: PLAYLIST_1,
        sort_by: 'name',
        direction: 'asc',
        dry_run: false,
      });
      const after = readdirSync(backupDir);
      const newFiles = after.filter((f) => !before.includes(f));
      assert.ok(newFiles.length > 0, 'sort_playlist_apply should have created a backup file');
      for (const f of newFiles) {
        assert.equal(statSync(join(backupDir, f)).mode & 0o777, 0o600, `backup ${f} must be 0600`);
      }
    } finally {
      await localHarness.close();
    }
  });

  it('records a pre-existing world-readable backup file as the precondition #1084 closes', () => {
    // Mimic a pre-existing backup whose mode was loosened by a previous bug.
    // The chmod in swarm3_playlistops.ts only runs after a write, so the real
    // regression assertion is the one above; this case just records the
    // pre-state the defensive chmod guards against.
    const stamp = '2026-01-01T00-00-00-000Z';
    const name = `playlistops-pre-${PLAYLIST_1}-${stamp}.json`;
    const file = join(backupDir, name);
    writeFileSync(file, JSON.stringify({ _kind: 'playlistops pre-write backup' }));
    chmodSync(file, 0o644);
    assert.equal(statSync(file).mode & 0o777, 0o644, 'sanity: pre-write file is world-readable');
  });
});
