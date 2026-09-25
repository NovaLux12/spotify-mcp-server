/**
 * take_playlist_snapshot walk-cap contract (#878).
 *
 * The dry run advertises `item_walk_cap`; the commit walk must be bounded by
 * that SAME number. These tests capture the `maxItems` limit actually handed to
 * `getAllPages` on the wire (not a recomputation of the tool's own helper) and
 * assert the advertised cap, the applied ceiling, and the truncation disclosure
 * all agree.
 */
import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerSwarm3SnapshotsTools } from '../src/tools/swarm3_snapshots.js';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type RegisteredTool = {
  name: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};

/** One recorded `getAllPages` invocation — the wire-level ceiling. */
interface WalkCall {
  path: string;
  pageLimit: string | undefined;
  maxItems: number | undefined;
}

function item(index: number) {
  return {
    added_at: '2026-01-01T00:00:00Z',
    item: {
      uri: `spotify:track:t${index}`,
      name: `Track ${index}`,
      type: 'track',
    },
  };
}

/** A row itemToTrackRow rejects (no uri) — it is walked but dropped from `tracks`. */
function malformedItem(index: number) {
  return {
    added_at: '2026-01-01T00:00:00Z',
    item: { name: `Broken ${index}`, type: 'track' },
  };
}

/** `dropEvery` makes every Nth walked row malformed (no uri → itemToTrackRow null). */
function harness(options: { totalItems: number; reportedTotal?: number | null; dropEvery?: number } = { totalItems: 300 }) {
  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(name: string, _description: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
      registered.push({ name, validate: (args) => z.object(schema).parse(args), handler });
    },
  } as unknown as McpServer;

  const totalItems = options.totalItems;
  const reportedTotal = options.reportedTotal === undefined ? totalItems : options.reportedTotal;
  const dropEvery = options.dropEvery ?? 0;
  const walkCalls: WalkCall[] = [];
  const itemPageRequests: number[] = [];

  const client = {
    async get<T>(path: string): Promise<T | null> {
      if (/^\/playlists\/[^/]+$/.test(path)) {
        return {
          id: '4uLU6hMCjMI75M1A2tKUQC',
          name: 'Big List',
          uri: 'spotify:playlist:pl123',
          items: { total: reportedTotal },
        } as T;
      }
      return null;
    },
    async getAllPages<T>(
      path: string,
      params?: Record<string, string>,
      opts?: { maxItems?: number },
    ): Promise<T[]> {
      walkCalls.push({ path, pageLimit: params?.limit, maxItems: opts?.maxItems });
      const maxItems = opts?.maxItems ?? Number.POSITIVE_INFINITY;
      const pageSize = Number(params?.limit ?? 100);
      const all: unknown[] = [];
      let offset = 0;
      for (;;) {
        const page = Array.from(
          { length: Math.max(0, Math.min(pageSize, totalItems - offset)) },
          (_, i) => (dropEvery > 0 && (offset + i) % dropEvery === 0 ? malformedItem(offset + i) : item(offset + i)),
        );
        itemPageRequests.push(offset);
        all.push(...page);
        if (all.length >= maxItems) return all.slice(0, maxItems) as T[];
        if (page.length === 0 || page.length < pageSize) break;
        offset += page.length;
      }
      return all as T[];
    },
  };

  registerSwarm3SnapshotsTools(fakeServer, client as unknown as SpotifyClient);
  const byName: Record<string, RegisteredTool> = Object.fromEntries(
    registered.map((t) => [t.name, t]),
  );
  return {
    walkCalls,
    itemPageRequests,
    async invoke(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
      const tool = byName[name];
      assert.ok(tool, `${name} is registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

let snapDir: string;
const originalSnapDir = process.env.SPOTIFY_MCP_SNAPSHOT_DIR;

beforeEach(async () => {
  snapDir = await mkdtemp(join(tmpdir(), 'swarm3-snapshots-'));
  process.env.SPOTIFY_MCP_SNAPSHOT_DIR = snapDir;
});

afterEach(async () => {
  if (originalSnapDir === undefined) delete process.env.SPOTIFY_MCP_SNAPSHOT_DIR;
  else process.env.SPOTIFY_MCP_SNAPSHOT_DIR = originalSnapDir;
  await rm(snapDir, { recursive: true, force: true });
});

async function onlySnapshotFile(): Promise<Record<string, unknown>> {
  const names = (await readdir(snapDir)).filter((n) => n.startsWith('plsnap-'));
  assert.equal(names.length, 1, 'exactly one snapshot file written');
  return JSON.parse(await readFile(join(snapDir, names[0]), 'utf8')) as Record<string, unknown>;
}

describe('take_playlist_snapshot walk cap (#878)', () => {
  it('applies to the commit walk the exact cap the dry run advertised', async () => {
    const dry = harness({ totalItems: 300 });
    const plan = await dry.invoke('take_playlist_snapshot', {
      playlist: '4uLU6hMCjMI75M1A2tKUQC',
      max_results: 100,
      dry_run: true,
    });
    const planned = plan.structuredContent as { item_walk_cap: number };
    assert.equal(planned.item_walk_cap, 100, 'dry run advertises the cap');
    assert.equal(dry.walkCalls.length, 0, 'dry run performs no walk');

    const commit = harness({ totalItems: 300 });
    const out = await commit.invoke('take_playlist_snapshot', {
      playlist: '4uLU6hMCjMI75M1A2tKUQC',
      max_results: 100,
      dry_run: false,
    });
    const done = out.structuredContent as { item_walk_cap: number };

    // The limit the client actually received on the wire, not a recomputation.
    assert.equal(commit.walkCalls.length, 1, 'one item walk on the commit path');
    assert.equal(commit.walkCalls[0].maxItems, 100, 'getAllPages was bounded at the advertised cap');
    assert.equal(commit.walkCalls[0].pageLimit, '100', 'page size unchanged');

    // Plan and commit cannot disagree.
    assert.equal(done.item_walk_cap, planned.item_walk_cap, 'commit honours the advertised cap');
  });

  it('stops at the ceiling and discloses the truncation instead of walking on', async () => {
    const commit = harness({ totalItems: 300 });
    const out = await commit.invoke('take_playlist_snapshot', {
      playlist: '4uLU6hMCjMI75M1A2tKUQC',
      max_results: 100,
      dry_run: false,
    });
    const done = out.structuredContent as { track_count: number; cap_reached: boolean; item_walk_cap: number };
    const prose = out.content.map((c) => c.text).join('\n');

    assert.equal(commit.walkCalls[0].maxItems, 100);
    assert.deepEqual(commit.itemPageRequests, [0], 'walked exactly one page of 100');
    assert.equal(done.track_count, 100, 'snapshot holds only the capped rows');
    assert.equal(done.cap_reached, true, 'ceiling hit is reported');
    assert.match(prose, /TRUNCATED/);
    assert.match(prose, /cap of 100 items/);

    const doc = await onlySnapshotFile();
    const meta = doc._meta as { track_count: number; item_walk_cap: number; cap_reached: boolean };
    assert.equal(meta.track_count, 100, 'on-disk _meta agrees with the cap');
    assert.equal(meta.item_walk_cap, 100);
    assert.equal(meta.cap_reached, true);
  });

  it('does not claim truncation when the playlist fits under the cap', async () => {
    const commit = harness({ totalItems: 40 });
    const out = await commit.invoke('take_playlist_snapshot', {
      playlist: '4uLU6hMCjMI75M1A2tKUQC',
      max_results: 100,
      dry_run: false,
    });
    const done = out.structuredContent as { track_count: number; cap_reached: boolean };
    const prose = out.content.map((c) => c.text).join('\n');

    assert.equal(commit.walkCalls[0].maxItems, 100);
    assert.equal(done.track_count, 40, 'the whole playlist is captured');
    assert.equal(done.cap_reached, false);
    assert.doesNotMatch(prose, /TRUNCATED/);
  });

  it('bounds the commit walk at the configured fetch-all cap when max_results is omitted', async () => {
    const plan = harness({ totalItems: 5_000 });
    const planned = (
      await plan.invoke('take_playlist_snapshot', { playlist: '4uLU6hMCjMI75M1A2tKUQC', dry_run: true })
    ).structuredContent as { item_walk_cap: number };

    const commit = harness({ totalItems: 5_000 });
    const done = (
      await commit.invoke('take_playlist_snapshot', { playlist: '4uLU6hMCjMI75M1A2tKUQC', dry_run: false })
    ).structuredContent as { item_walk_cap: number; cap_reached: boolean };

    assert.equal(commit.walkCalls[0].maxItems, planned.item_walk_cap, 'default cap is the same number');
    assert.equal(done.item_walk_cap, planned.item_walk_cap);
    assert.equal(done.cap_reached, true, '5,000 items under a 500 cap is disclosed');
  });

  it('detects the cap from the raw walk even when dropped rows hide it', async () => {
    // Every 2nd walked row is malformed, so the walk collects 100 rows but
    // `tracks` holds only 50. Keying the disclosure off tracks.length would
    // wrongly report "not truncated" for a playlist that really was cut off.
    const commit = harness({ totalItems: 300, dropEvery: 2 });
    const out = await commit.invoke('take_playlist_snapshot', {
      playlist: '4uLU6hMCjMI75M1A2tKUQC',
      max_results: 100,
      dry_run: false,
    });
    const done = out.structuredContent as { track_count: number; cap_reached: boolean };
    const prose = out.content.map((c) => c.text).join('\n');

    assert.equal(commit.walkCalls[0].maxItems, 100);
    assert.equal(done.track_count, 50, 'only well-formed rows are stored');
    assert.ok(done.track_count < 100, 'stored rows sit below the ceiling');
    assert.equal(done.cap_reached, true, 'truncation is still disclosed');
    assert.match(prose, /TRUNCATED/);
  });
});
