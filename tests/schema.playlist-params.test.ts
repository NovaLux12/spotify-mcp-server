import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { SpotifyClient } from '../src/client.js';
import { registerExhaust2PlaylistsTools } from '../src/tools/exhaust2_playlists.js';
import { registerExhaustMiscTools } from '../src/tools/exhaustmisc.js';
import { registerPlaylistBatchTools } from '../src/tools/playlistbatch.js';
import { registerPlaylistOpsTools } from '../src/tools/playlistops.js';
import { registerPlaylistTools } from '../src/tools/playlists.js';
import { registerSwarm3PlaylistopsTools } from '../src/tools/swarm3_playlistops.js';
import { registerSwarm4PlaylistsTools } from '../src/tools/swarm4_playlists.js';
import type { PlaylistItemObject, SpotifyTrack } from '../src/types/spotify.js';

type SchemaProperty = { type?: string; items?: unknown; [key: string]: unknown };
type ListedTool = { name: string; inputSchema?: { properties?: Record<string, SchemaProperty> } };
type ToolResponse = {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};

type ToolContract =
  | { kind: 'list'; aliases: readonly string[] }
  | { kind: 'pair'; aliases: readonly (readonly [string, string])[] };

const TOOL_CONTRACT = {
  merge_playlists: { kind: 'list', aliases: ['sources'] },
  diff_playlists: { kind: 'pair', aliases: [['a', 'b']] },
  overlap_playlists: { kind: 'list', aliases: [] },
  check_playlist_following: { kind: 'list', aliases: ['playlist_ids'] },
  compare_playlist_covers: { kind: 'pair', aliases: [['playlist_id_a', 'playlist_id_b']] },
  playlist_union: { kind: 'list', aliases: ['source_playlist_ids'] },
  playlist_subtract: { kind: 'list', aliases: ['subtract_playlist_ids'] },
  playlist_symmetric_difference: { kind: 'pair', aliases: [['playlist_id_a', 'playlist_id_b']] },
  playlist_intersect: { kind: 'list', aliases: ['source_playlist_ids'] },
  playlist_overlap_matrix: { kind: 'list', aliases: ['playlist_ids'] },
  merge_playlists_plan: { kind: 'list', aliases: ['playlist_ids'] },
  playlist_difference_plan: { kind: 'list', aliases: ['subtract_playlist_ids'] },
  interleave_playlists_plan: { kind: 'list', aliases: ['playlist_ids'] },
  playlist_intersection: { kind: 'list', aliases: ['playlist_ids'] },
  playlist_union_preview: { kind: 'list', aliases: ['playlist_ids'] },
  find_duplicate_tracks_across_playlists: { kind: 'list', aliases: ['playlist_ids'] },
  balance_playlist_pairs: { kind: 'list', aliases: ['playlist_ids'] },
  playlist_diff: { kind: 'pair', aliases: [['playlist_a_id', 'playlist_b_id']] },
  playlist_pair_check: { kind: 'pair', aliases: [['playlist_a_id', 'playlist_b_id']] },
} satisfies Record<string, ToolContract>;

type ToolName = keyof typeof TOOL_CONTRACT;

type CallCase = {
  canonical: Record<string, unknown>;
  alias: Record<string, unknown>;
  aliasNames: string[];
};

const PLAYLIST_1 = '1111111111111111111111';
const PLAYLIST_2 = '2222222222222222222222';
const TARGET_PLAYLIST = '3333333333333333333333';
const OTHER_PLAYLIST = '4444444444444444444444';

const CALL_CASES: Record<ToolName, CallCase> = {
  merge_playlists: {
    canonical: { playlists: [PLAYLIST_1, PLAYLIST_2], new_name: 'Merged', dry_run: true },
    alias: { sources: [PLAYLIST_1, PLAYLIST_2], new_name: 'Merged', dry_run: true },
    aliasNames: ['sources'],
  },
  diff_playlists: {
    canonical: { playlist_a: PLAYLIST_1, playlist_b: PLAYLIST_2 },
    alias: { a: PLAYLIST_1, b: PLAYLIST_2 },
    aliasNames: ['a', 'b'],
  },
  overlap_playlists: {
    canonical: { playlists: [PLAYLIST_1, PLAYLIST_2] },
    alias: { playlists: [PLAYLIST_1, PLAYLIST_2] },
    aliasNames: [],
  },
  check_playlist_following: {
    canonical: { playlists: [PLAYLIST_1, PLAYLIST_2] },
    alias: { playlist_ids: [PLAYLIST_1, PLAYLIST_2] },
    aliasNames: ['playlist_ids'],
  },
  compare_playlist_covers: {
    canonical: { playlist_a: PLAYLIST_1, playlist_b: PLAYLIST_2 },
    alias: { playlist_id_a: PLAYLIST_1, playlist_id_b: PLAYLIST_2 },
    aliasNames: ['playlist_id_a', 'playlist_id_b'],
  },
  playlist_union: {
    canonical: { playlists: [PLAYLIST_1, PLAYLIST_2], target_name: 'Union', dry_run: true },
    alias: { source_playlist_ids: [PLAYLIST_1, PLAYLIST_2], target_name: 'Union', dry_run: true },
    aliasNames: ['source_playlist_ids'],
  },
  playlist_subtract: {
    canonical: { base_playlist_id: PLAYLIST_1, playlists: [PLAYLIST_2, OTHER_PLAYLIST], dry_run: true },
    alias: { base_playlist_id: PLAYLIST_1, subtract_playlist_ids: [PLAYLIST_2, OTHER_PLAYLIST], dry_run: true },
    aliasNames: ['subtract_playlist_ids'],
  },
  playlist_symmetric_difference: {
    canonical: { playlist_a: PLAYLIST_1, playlist_b: PLAYLIST_2 },
    alias: { playlist_id_a: PLAYLIST_1, playlist_id_b: PLAYLIST_2 },
    aliasNames: ['playlist_id_a', 'playlist_id_b'],
  },
  playlist_intersect: {
    canonical: { playlists: [PLAYLIST_1, PLAYLIST_2], dry_run: true },
    alias: { source_playlist_ids: [PLAYLIST_1, PLAYLIST_2], dry_run: true },
    aliasNames: ['source_playlist_ids'],
  },
  playlist_overlap_matrix: {
    canonical: { playlists: [PLAYLIST_1, PLAYLIST_2] },
    alias: { playlist_ids: [PLAYLIST_1, PLAYLIST_2] },
    aliasNames: ['playlist_ids'],
  },
  merge_playlists_plan: {
    canonical: { playlists: [PLAYLIST_1, PLAYLIST_2], dry_run: true },
    alias: { playlist_ids: [PLAYLIST_1, PLAYLIST_2], dry_run: true },
    aliasNames: ['playlist_ids'],
  },
  playlist_difference_plan: {
    canonical: { base_playlist_id: PLAYLIST_1, playlists: [PLAYLIST_1, PLAYLIST_2], dry_run: true },
    alias: { base_playlist_id: PLAYLIST_1, subtract_playlist_ids: [PLAYLIST_1, PLAYLIST_2], dry_run: true },
    aliasNames: ['subtract_playlist_ids'],
  },
  interleave_playlists_plan: {
    canonical: { playlists: [PLAYLIST_1, PLAYLIST_2], dry_run: true },
    alias: { playlist_ids: [PLAYLIST_1, PLAYLIST_2], dry_run: true },
    aliasNames: ['playlist_ids'],
  },
  playlist_intersection: {
    canonical: { playlists: [PLAYLIST_1, PLAYLIST_2] },
    alias: { playlist_ids: [PLAYLIST_1, PLAYLIST_2] },
    aliasNames: ['playlist_ids'],
  },
  playlist_union_preview: {
    canonical: { playlists: [PLAYLIST_1, PLAYLIST_2] },
    alias: { playlist_ids: [PLAYLIST_1, PLAYLIST_2] },
    aliasNames: ['playlist_ids'],
  },
  playlist_diff: {
    canonical: { playlist_a: PLAYLIST_1, playlist_b: PLAYLIST_2 },
    alias: { playlist_a_id: PLAYLIST_1, playlist_b_id: PLAYLIST_2 },
    aliasNames: ['playlist_a_id', 'playlist_b_id'],
  },
  playlist_pair_check: {
    canonical: { playlist_a: PLAYLIST_1, playlist_b: PLAYLIST_2 },
    alias: { playlist_a_id: PLAYLIST_1, playlist_b_id: PLAYLIST_2 },
    aliasNames: ['playlist_a_id', 'playlist_b_id'],
  },
  find_duplicate_tracks_across_playlists: {
    canonical: { playlists: [PLAYLIST_1, PLAYLIST_2] },
    alias: { playlist_ids: [PLAYLIST_1, PLAYLIST_2] },
    aliasNames: ['playlist_ids'],
  },
  balance_playlist_pairs: {
    canonical: { playlists: [PLAYLIST_1, PLAYLIST_2], dry_run: true },
    alias: { playlist_ids: [PLAYLIST_1, PLAYLIST_2], dry_run: true },
    aliasNames: ['playlist_ids'],
  },
};

function makeClient(calls: string[]): SpotifyClient {
  return {
    async get<T>(path: string): Promise<T | null> {
      calls.push(path);
      if (path.endsWith('/followers/contains')) return [true] as T;
      if (path.endsWith('/images')) return [] as T;
      const id = decodeURIComponent(path.replace('/playlists/', ''));
      return { id, name: `Playlist ${id}` } as T;
    },
    async getAllPages<T>(path: string): Promise<T[]> {
      calls.push(path);
      return [];
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
  } as unknown as SpotifyClient;
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
    async getAllPages<T>(path: string): Promise<T[]> {
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
  } as unknown as SpotifyClient;
  const server = new McpServer({ name: 'union-confirm-contract', version: '0.0.0' });
  registerPlaylistTools(server, client);
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
      .filter(([name, schema]) => schema.type === 'array' && (name.includes('playlist') || name === 'sources'))
      .map(([name]) => name);
  }
  const aliases = new Set<string>(contract.aliases.flatMap(([a, b]) => [a, b]));
  return Object.keys(properties).filter((name) => name === 'playlist_a' || name === 'playlist_b' || aliases.has(name));
}

describe('playlist set/diff schema and resolver contract (#912)', () => {
  let harness: PlaylistHarness;

  before(async () => {
    harness = await makeHarness();
  });

  after(async () => {
    await harness.close();
  });

  it('discovers every live set/diff-family tool with only canonical names and explicit aliases', () => {
    const discovered = harness.listed.filter((tool) => {
      const properties = tool.inputSchema?.properties ?? {};
      const hasPlaylistCollection = Object.entries(properties).some(([name, schema]) =>
        schema.type === 'array' && (name.includes('playlist') || name === 'sources'));
      const hasPair = ['playlist_a', 'playlist_b', 'a', 'b', 'playlist_a_id', 'playlist_b_id', 'playlist_id_a', 'playlist_id_b']
        .some((name) => name in properties);
      return hasPlaylistCollection || hasPair;
    }).map((tool) => tool.name).sort();
    assert.deepEqual(discovered, Object.keys(TOOL_CONTRACT).sort());
    const byName = new Map(harness.listed.map((tool) => [tool.name, tool]));
    for (const [name, contract] of Object.entries(TOOL_CONTRACT) as Array<[ToolName, (typeof TOOL_CONTRACT)[ToolName]]>) {
      const tool = byName.get(name);
      assert.ok(tool, `${name} must be registered`);
      const properties = tool.inputSchema?.properties ?? {};
      const actual = relevantSchemaFields(tool, contract);
      const expected = contract.kind === 'list'
        ? ['playlists', ...contract.aliases]
        : ['playlist_a', 'playlist_b', ...contract.aliases.flat()];
      assert.deepEqual(actual, expected, `${name} playlist input drift`);
      if (contract.kind === 'list') assert.equal(properties.playlists?.type, 'array');
      else {
        assert.equal(properties.playlist_a?.type, 'string');
        assert.equal(properties.playlist_b?.type, 'string');
        assert.ok(actual.indexOf('playlist_a') < actual.indexOf('playlist_b'), `${name} A/B order`);
      }
    }
  });

  it('routes every legacy alias to the same wire paths and exposes deprecation', async () => {
    for (const [name, callCase] of Object.entries(CALL_CASES) as Array<[ToolName, (typeof CALL_CASES)[ToolName]]>) {
      harness.calls.length = 0;
      const canonical = await harness.invoke(name, callCase.canonical);
      assert.ok(!canonical.isError, `${name} canonical call failed: ${textOf(canonical)}`);
      assert.equal(canonical.structuredContent?.deprecated_inputs, undefined, `${name} canonical output leaked deprecation`);
      const canonicalPaths = [...harness.calls];

      harness.calls.length = 0;
      const legacy = await harness.invoke(name, callCase.alias);
      assert.ok(!legacy.isError, `${name} legacy call failed: ${textOf(legacy)}`);
      assert.deepEqual(harness.calls, canonicalPaths, `${name} alias changed Spotify paths`);
      if (callCase.aliasNames.length > 0) {
        assert.deepEqual(legacy.structuredContent?.deprecated_inputs, callCase.aliasNames);
        assert.match(textOf(legacy), /Deprecated input.*use (?:playlists|playlist_a\/playlist_b)/);
        assert.equal(typeof legacy.structuredContent?.deprecation_note, 'string');
      }
    }
  });

  it('rejects every canonical/legacy conflict before an API call and names both inputs', async () => {
    for (const [name, callCase] of Object.entries(CALL_CASES) as Array<[ToolName, (typeof CALL_CASES)[ToolName]]>) {
      if (callCase.aliasNames.length === 0) continue;
      const contract = TOOL_CONTRACT[name];
      const conflictArgs = { ...callCase.canonical };
      if (contract.kind === 'list') {
        const alias = callCase.aliasNames[0];
        const canonicalValues = callCase.canonical.playlists as string[];
        conflictArgs[alias] = [...canonicalValues].reverse();
      } else {
        const aliasA = callCase.aliasNames[0];
        const aliasB = callCase.aliasNames[1];
        assert.ok(aliasA && aliasB, `${name} test case must name a complete pair alias`);
        conflictArgs[aliasA] = callCase.canonical.playlist_a;
        conflictArgs[aliasB] = OTHER_PLAYLIST;
      }
      harness.calls.length = 0;
      let message: string;
      try {
        const result = await harness.invoke(name, conflictArgs);
        assert.equal(result.isError, true, `${name} conflict unexpectedly succeeded`);
        message = textOf(result);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      // Word-boundary the alias: `playlist_a.*a/` is satisfied by the literal
      // `playlist_a` itself, so an implementation that never names the
      // conflicting alias would still pass.
      if (contract.kind === 'list') assert.match(message, new RegExp(`playlists.*\\b${callCase.aliasNames[0]}\\b`));
      else assert.match(message, new RegExp(`playlist_a.*\\b${callCase.aliasNames[0]}\\b`));
      assert.deepEqual(harness.calls, [], `${name} resolved a conflict before rejecting`);
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
      { label: 'confirmed', answer: { action: 'accept' as const, confirm: true }, useAlias: false, writes: 1 },
      { label: 'declined', answer: { action: 'decline' as const }, useAlias: true, writes: 0 },
      { label: 'transport-error', answer: new Error('elicitation transport failed'), useAlias: false, writes: 0 },
    ] as const;
    for (const testCase of cases) {
      const gate = await makeUnionGateHarness({ answer: testCase.answer });
      const source = testCase.useAlias
        ? { source_playlist_ids: [PLAYLIST_1, PLAYLIST_2] }
        : { playlists: [PLAYLIST_1, PLAYLIST_2] };
      const result = await gate.invoke('playlist_union', { ...source, target_playlist_id: TARGET_PLAYLIST });
      const writes = gate.calls.filter((call) => call.startsWith('PUT ') || call.startsWith('POST '));
      assert.equal(writes.length, testCase.writes, `${testCase.label} write count`);
      if (testCase.label === 'confirmed') assert.equal(result.structuredContent?.ok, true);
      else {
        assert.equal(result.structuredContent?.ok, false);
        assert.equal(result.structuredContent?.cancelled, true);
        if (testCase.label === 'transport-error') assert.equal(result.structuredContent?.reason, 'elicitation_failed');
        if (testCase.useAlias) {
          assert.deepEqual(result.structuredContent?.deprecated_inputs, ['source_playlist_ids']);
          assert.match(textOf(result), /Deprecated input source_playlist_ids/);
        }
      }
      await gate.close();
    }
  });

  it('refuses destructive union but allows identical subtraction without elicitation support', async () => {
    const cases = [
      { name: 'playlist_union' as const, args: { playlists: [PLAYLIST_1, PLAYLIST_2], target_playlist_id: TARGET_PLAYLIST }, ok: false, writes: 0, unchanged: false },
      { name: 'playlist_subtract' as const, args: { base_playlist_id: PLAYLIST_1, subtract_playlist_ids: [PLAYLIST_2] }, ok: true, writes: 0, unchanged: true },
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
    { name: 'playlist_subtract' as const, args: { base_playlist_id: PLAYLIST_1, subtract_playlist_ids: [PLAYLIST_2] }, toolName: 'playlist_subtract' as const },
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
        subtract_playlist_ids: [PLAYLIST_2],
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

  it('asks when the target holds rows a URI-based replace cannot restore', async () => {
    const gate = await makeUnionGateHarness({
      answer: { action: 'accept', confirm: true },
      sourceCount: 1,
      targetUris: ['spotify:track:a0', 'spotify:track:b0'],
      targetNullUris: 3,
    });
    try {
      const result = await gate.invoke('playlist_union', { playlists: [PLAYLIST_1, PLAYLIST_2], target_playlist_id: TARGET_PLAYLIST });
      assert.equal(gate.prompts.length, 1, 'dropping null-URI rows must ask even though the URIs match');
      assert.match(gate.prompts[0] ?? '', /Drop 3 item\(s\) Spotify returned without a URI/);
      assert.equal(result.structuredContent?.ok, true);
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
