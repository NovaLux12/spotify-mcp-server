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

const CALL_CASES: Record<ToolName, CallCase> = {
  merge_playlists: {
    canonical: { playlists: ['p1', 'p2'], new_name: 'Merged', dry_run: true },
    alias: { sources: ['p1', 'p2'], new_name: 'Merged', dry_run: true },
    aliasNames: ['sources'],
  },
  diff_playlists: {
    canonical: { playlist_a: 'p1', playlist_b: 'p2' },
    alias: { a: 'p1', b: 'p2' },
    aliasNames: ['a', 'b'],
  },
  overlap_playlists: {
    canonical: { playlists: ['p1', 'p2'] },
    alias: { playlists: ['p1', 'p2'] },
    aliasNames: [],
  },
  check_playlist_following: {
    canonical: { playlists: ['p1', 'p2'] },
    alias: { playlist_ids: ['p1', 'p2'] },
    aliasNames: ['playlist_ids'],
  },
  compare_playlist_covers: {
    canonical: { playlist_a: 'p1', playlist_b: 'p2' },
    alias: { playlist_id_a: 'p1', playlist_id_b: 'p2' },
    aliasNames: ['playlist_id_a', 'playlist_id_b'],
  },
  playlist_union: {
    canonical: { playlists: ['p1', 'p2'], target_name: 'Union', dry_run: true },
    alias: { source_playlist_ids: ['p1', 'p2'], target_name: 'Union', dry_run: true },
    aliasNames: ['source_playlist_ids'],
  },
  playlist_subtract: {
    canonical: { base_playlist_id: 'base', playlists: ['p1', 'p2'], dry_run: true },
    alias: { base_playlist_id: 'base', subtract_playlist_ids: ['p1', 'p2'], dry_run: true },
    aliasNames: ['subtract_playlist_ids'],
  },
  playlist_symmetric_difference: {
    canonical: { playlist_a: 'p1', playlist_b: 'p2' },
    alias: { playlist_id_a: 'p1', playlist_id_b: 'p2' },
    aliasNames: ['playlist_id_a', 'playlist_id_b'],
  },
  playlist_intersect: {
    canonical: { playlists: ['p1', 'p2'], dry_run: true },
    alias: { source_playlist_ids: ['p1', 'p2'], dry_run: true },
    aliasNames: ['source_playlist_ids'],
  },
  playlist_overlap_matrix: {
    canonical: { playlists: ['p1', 'p2'] },
    alias: { playlist_ids: ['p1', 'p2'] },
    aliasNames: ['playlist_ids'],
  },
  merge_playlists_plan: {
    canonical: { playlists: ['p1', 'p2'], dry_run: true },
    alias: { playlist_ids: ['p1', 'p2'], dry_run: true },
    aliasNames: ['playlist_ids'],
  },
  playlist_difference_plan: {
    canonical: { base_playlist_id: 'base', playlists: ['p1', 'p2'], dry_run: true },
    alias: { base_playlist_id: 'base', subtract_playlist_ids: ['p1', 'p2'], dry_run: true },
    aliasNames: ['subtract_playlist_ids'],
  },
  interleave_playlists_plan: {
    canonical: { playlists: ['p1', 'p2'], dry_run: true },
    alias: { playlist_ids: ['p1', 'p2'], dry_run: true },
    aliasNames: ['playlist_ids'],
  },
  playlist_intersection: {
    canonical: { playlists: ['p1', 'p2'] },
    alias: { playlist_ids: ['p1', 'p2'] },
    aliasNames: ['playlist_ids'],
  },
  playlist_union_preview: {
    canonical: { playlists: ['p1', 'p2'] },
    alias: { playlist_ids: ['p1', 'p2'] },
    aliasNames: ['playlist_ids'],
  },
  playlist_diff: {
    canonical: { playlist_a: 'p1', playlist_b: 'p2' },
    alias: { playlist_a_id: 'p1', playlist_b_id: 'p2' },
    aliasNames: ['playlist_a_id', 'playlist_b_id'],
  },
  playlist_pair_check: {
    canonical: { playlist_a: 'p1', playlist_b: 'p2' },
    alias: { playlist_a_id: 'p1', playlist_b_id: 'p2' },
    aliasNames: ['playlist_a_id', 'playlist_b_id'],
  },
  find_duplicate_tracks_across_playlists: {
    canonical: { playlists: ['p1', 'p2'] },
    alias: { playlist_ids: ['p1', 'p2'] },
    aliasNames: ['playlist_ids'],
  },
  balance_playlist_pairs: {
    canonical: { playlists: ['p1', 'p2'], dry_run: true },
    alias: { playlist_ids: ['p1', 'p2'], dry_run: true },
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
type ElicitAnswer = { action: 'accept' | 'decline' | 'cancel'; confirm?: boolean } | Error;

interface UnionGateHarness {
  calls: string[];
  invoke: (args: Record<string, unknown>) => Promise<ToolResponse>;
  close: () => Promise<void>;
}

async function makeUnionGateHarness(answer: ElicitAnswer, useAlias: boolean): Promise<UnionGateHarness> {
  const calls: string[] = [];
  const client = {
    async get<T>(path: string): Promise<T | null> {
      calls.push(path);
      return { id: path.split('/').pop() ?? 'playlist', name: 'Playlist' } as T;
    },
    async getAllPages<T>(path: string): Promise<T[]> {
      calls.push(path);
      return Array.from({ length: 50 }, (_, index) => ({
        item: { id: `${path.includes('p1') ? 'a' : 'b'}${index}`, uri: `spotify:track:${path.includes('p1') ? 'a' : 'b'}${index}`, name: `Track ${index}` },
      })) as T[];
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
    { capabilities: { elicitation: { form: {} } } },
  );
  caller.setRequestHandler(ElicitRequestSchema, async () => {
    if (answer instanceof Error) throw answer;
    if (answer.action === 'accept') return { action: answer.action, content: { confirm: answer.confirm ?? true } };
    return { action: answer.action };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([caller.connect(clientTransport), server.connect(serverTransport)]);
  return {
    calls,
    invoke: async (args) => {
      const result = await caller.callTool({ name: 'playlist_union', arguments: args });
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
        conflictArgs[aliasB] = 'different';
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
      if (contract.kind === 'list') assert.match(message, new RegExp(`playlists.*${callCase.aliasNames[0]}`));
      else assert.match(message, new RegExp(`playlist_a.*${callCase.aliasNames[0]}`));
      assert.deepEqual(harness.calls, [], `${name} resolved a conflict before rejecting`);
    }
  });

  it('requires exactly one union target before reading sources', async () => {
    for (const args of [
      { playlists: ['p1', 'p2'] },
      { playlists: ['p1', 'p2'], target_playlist_id: 'target', target_name: 'new' },
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
      const gate = await makeUnionGateHarness(testCase.answer, testCase.useAlias);
      const source = testCase.useAlias ? { source_playlist_ids: ['p1', 'p2'] } : { playlists: ['p1', 'p2'] };
      const result = await gate.invoke({ ...source, target_playlist_id: 'target' });
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

  it('normalizes Spotify URIs and URLs to raw playlist IDs on the wire', async () => {
    harness.calls.length = 0;
    const result = await harness.invoke('overlap_playlists', {
      playlists: [
        'spotify:playlist:p1?si=token',
        'https://open.spotify.com/intl-de/playlist/p2?si=token',
      ],
    });
    assert.ok(!result.isError, textOf(result));
    assert.deepEqual(harness.calls, ['/playlists/p1/items', '/playlists/p2/items']);
  });
});
