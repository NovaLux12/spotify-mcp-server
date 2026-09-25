import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import type { PlaylistItemObject } from '../src/types/spotify.js';
import { registerSwarm4PlaylistsTools } from '../src/tools/swarm4_playlists.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type RegisteredTool = {
  name: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};

function track(id: string): PlaylistItemObject {
  return {
    added_at: '2026-01-01T00:00:00Z',
    item: {
      type: 'track',
      uri: `spotify:track:${id}`,
      name: `Track ${id}`,
      duration_ms: 180_000,
      artists: [{ id: `artist-${id}`, name: `Artist ${id}` }],
      album: { id: `album-${id}`, name: `Album ${id}` },
    },
  } as PlaylistItemObject;
}

const PLAYLIST_A = 'A'.repeat(22);
const PLAYLIST_B = 'B'.repeat(22);

function harness(playlists: Record<string, PlaylistItemObject[]>) {
  const registered: RegisteredTool[] = [];
  const server = {
    tool(
      name: string,
      _description: string,
      schema: z.ZodRawShape,
      handler: RegisteredTool['handler'],
    ) {
      registered.push({
        name,
        validate: (args) => z.object(schema).parse(args),
        handler,
      });
    },
  } as unknown as McpServer;

  const writes: Array<{ method: 'POST' | 'PUT'; path: string; body: unknown }> = [];
  const client = {
    async get<T>(path: string): Promise<T | null> {
      const playlistId = decodeURIComponent(path.replace('/playlists/', ''));
      return { id: playlistId, name: `Playlist ${playlistId}` } as T;
    },
    async getAllPages<T>(path: string): Promise<T[]> {
      const playlistId = decodeURIComponent(path.replace('/playlists/', '').replace('/items', ''));
      return (playlists[playlistId] ?? []) as T[];
    },
    async post<T>(path: string, body?: unknown): Promise<T | null> {
      writes.push({ method: 'POST', path, body });
      return null;
    },
    async put<T>(path: string, body?: unknown): Promise<T | null> {
      writes.push({ method: 'PUT', path, body });
      return null;
    },
  } as unknown as SpotifyClient;

  registerSwarm4PlaylistsTools(server, client);
  return {
    async invoke(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
      const tool = registered.find((candidate) => candidate.name === name);
      assert.ok(tool, `tool ${name} registered`);
      return tool.handler(tool.validate(args));
    },
    writes,
  };
}


describe('playlist_pair_check exclusive sections and structured budgets', () => {
  for (const responseFormat of ['concise', 'json'] as const) {
    it(`renders the A-only section in ${responseFormat} mode`, async () => {
      const h = harness({
        [PLAYLIST_A]: [track('shared'), track('a-only')],
        [PLAYLIST_B]: [track('shared')],
      });
      const result = await h.invoke('playlist_pair_check', {
        playlist_a_id: PLAYLIST_A,
        playlist_b_id: PLAYLIST_B,
        response_format: responseFormat,
      });

      if (responseFormat === 'concise') {
        assert.ok(result.content[0].text.includes(`"Playlist ${PLAYLIST_A}" lacks (from B):`));
        assert.match(result.content[0].text, /Track a-only/);
        assert.equal(result.content[0].text.includes(`"Playlist ${PLAYLIST_B}" lacks (from A):`), false);
      }
      assert.ok(result.structuredContent);
      assert.deepEqual(result.structuredContent.only_in_a, ['spotify:track:a-only']);
      assert.deepEqual(result.structuredContent.only_in_b, []);
    });

    it(`renders the B-only section in ${responseFormat} mode`, async () => {
      const h = harness({
        [PLAYLIST_A]: [track('shared')],
        [PLAYLIST_B]: [track('shared'), track('b-only')],
      });
      const result = await h.invoke('playlist_pair_check', {
        playlist_a_id: PLAYLIST_A,
        playlist_b_id: PLAYLIST_B,
        response_format: responseFormat,
      });

      if (responseFormat === 'concise') {
        assert.ok(result.content[0].text.includes(`"Playlist ${PLAYLIST_B}" lacks (from A):`));
        assert.match(result.content[0].text, /Track b-only/);
        assert.equal(result.content[0].text.includes(`"Playlist ${PLAYLIST_A}" lacks (from B):`), false);
      }
      assert.ok(result.structuredContent);
      assert.deepEqual(result.structuredContent.only_in_a, []);
      assert.deepEqual(result.structuredContent.only_in_b, ['spotify:track:b-only']);
    });

    it(`renders neither section when both exclusive lists are empty in ${responseFormat} mode`, async () => {
      const h = harness({ [PLAYLIST_A]: [track('shared')], [PLAYLIST_B]: [track('shared')] });
      const result = await h.invoke('playlist_pair_check', {
        playlist_a_id: PLAYLIST_A,
        playlist_b_id: PLAYLIST_B,
        response_format: responseFormat,
      });

      if (responseFormat === 'concise') {
        assert.doesNotMatch(result.content[0].text, /lacks \(from [AB]\):/);
      }
      assert.ok(result.structuredContent);
      assert.deepEqual(result.structuredContent.only_in_a, []);
      assert.deepEqual(result.structuredContent.only_in_b, []);
    });
  }

  it('applies the asymmetric display cap without leaking withheld URIs in either mode', async () => {
    for (const responseFormat of ['concise', 'json'] as const) {
      const h = harness({
        [PLAYLIST_A]: [track('shared'), track('a1'), track('a2'), track('a3')],
        [PLAYLIST_B]: [track('shared'), track('b1')],
      });
      const result = await h.invoke('playlist_pair_check', {
        playlist_a_id: PLAYLIST_A,
        playlist_b_id: PLAYLIST_B,
        response_format: responseFormat,
        max_results: 2,
      });
      assert.ok(result.structuredContent);
      const payload = result.structuredContent;

      assert.deepEqual(payload.only_in_a, ['spotify:track:a1', 'spotify:track:a2']);
      assert.deepEqual(payload.only_in_b, ['spotify:track:b1']);
      assert.equal(payload.only_in_a_total, 3);
      assert.equal(payload.only_in_a_returned, 2);
      assert.equal(payload.only_in_a_withheld, 1);
      assert.equal(payload.only_in_a_truncated, true);
      assert.equal(payload.only_in_b_total, 1);
      assert.equal(payload.only_in_b_returned, 1);
      assert.equal(payload.only_in_b_withheld, 0);
      assert.equal(payload.only_in_b_truncated, false);
      assert.doesNotMatch(JSON.stringify(payload), /spotify:track:a3/);
    }
  });
});

describe('playlist plan structuredContent budgeting', () => {
  it('caps the previewed order and truthfully reports the withheld total', async () => {
    const h = harness({ source: [track('one'), track('two'), track('three')] });
    const result = await h.invoke('playlist_resequence', {
      playlist_id: 'source',
      sort_by: 'name',
      max_results: 2,
    });
    assert.ok(result.structuredContent);
    const payload = result.structuredContent;

    assert.deepEqual(payload.order, ['spotify:track:one', 'spotify:track:three']);
    assert.equal(payload.items, 3);
    assert.equal(payload.items_total, 3);
    assert.equal(payload.items_returned, 2);
    assert.equal(payload.items_withheld, 1);
    assert.equal(payload.items_truncated, true);
    assert.doesNotMatch(JSON.stringify(payload), /spotify:track:two/);
  });

  it('returns the full planned order only after explicit opt-in', async () => {
    const h = harness({ source: [track('one'), track('two'), track('three')] });
    const result = await h.invoke('playlist_resequence', {
      playlist_id: 'source',
      sort_by: 'name',
      max_results: 2,
      include_full_order: true,
    });
    assert.ok(result.structuredContent);
    const payload = result.structuredContent;

    assert.deepEqual(payload.order, ['spotify:track:one', 'spotify:track:three', 'spotify:track:two']);
    assert.equal(payload.items_returned, 3);
    assert.equal(payload.items_withheld, 0);
    assert.equal(payload.items_truncated, false);
  });
});

describe('playlist_changelog multiset diff', () => {
  const backupRoot = mkdtempSync(join(tmpdir(), 'swarm4-backup-'));
  const origBackupDir = process.env.SPOTIFY_MCP_BACKUP_DIR;
  before(() => { process.env.SPOTIFY_MCP_BACKUP_DIR = backupRoot; });
  after(() => {
    if (origBackupDir === undefined) delete process.env.SPOTIFY_MCP_BACKUP_DIR;
    else process.env.SPOTIFY_MCP_BACKUP_DIR = origBackupDir;
    rmSync(backupRoot, { recursive: true, force: true });
  });

  function writeBackup(file: string, uris: string[]): void {
    const payload = {
      _meta: {},
      liked_tracks: [], saved_albums: [], saved_shows: [], saved_episodes: [],
      saved_audiobooks: [], followed_artists: [],
      playlists: [{
        uri: 'spotify:playlist:PL',
        name: 'Mix',
        item_count: uris.length,
        items: uris.map((u) => ({ uri: u, name: `Track ${u.slice(-1)}` })),
        items_truncated: false,
      }],
    };
    writeFileSync(join(backupRoot, file), JSON.stringify(payload), 'utf8');
  }

  it('reports a swapped duplicate occurrence as added/removed (#876)', async () => {
    // Both snapshots hold the URI set {a, b}; only per-URI counts differ.
    writeBackup('backup-2026-01-01-1.json', ['spotify:track:a', 'spotify:track:a', 'spotify:track:b']);
    writeBackup('backup-2026-01-02-1.json', ['spotify:track:a', 'spotify:track:b', 'spotify:track:b']);
    const h = harness({});
    const out = await h.invoke('playlist_changelog', {
      backup_file_a: 'backup-2026-01-01-1.json',
      backup_file_b: 'backup-2026-01-02-1.json',
      playlist_name: 'Mix',
      response_format: 'concise',
    });
    const sc = out.structuredContent as {
      added: Array<{ uri: string }>;
      removed: Array<{ uri: string }>;
      kept_count: number;
    };
    assert.deepEqual(sc.added.map((a) => a.uri), ['spotify:track:b']);
    assert.deepEqual(sc.removed.map((r) => r.uri), ['spotify:track:a']);
    assert.equal(sc.kept_count, 2);
    assert.match(out.content[0].text, /\+1 added \/ -1 removed \/ 2 kept/);
  });

  it('reports an extra copy of an already-present track (#876)', async () => {
    writeBackup('backup-2026-01-03-1.json', ['spotify:track:a', 'spotify:track:b']);
    writeBackup('backup-2026-01-04-1.json', ['spotify:track:a', 'spotify:track:b', 'spotify:track:b']);
    const h = harness({});
    const out = await h.invoke('playlist_changelog', {
      backup_file_a: 'backup-2026-01-03-1.json',
      backup_file_b: 'backup-2026-01-04-1.json',
      playlist_name: 'Mix',
      response_format: 'concise',
    });
    const sc = out.structuredContent as { added: Array<{ uri: string }>; removed: unknown[] };
    assert.deepEqual(sc.added.map((a) => a.uri), ['spotify:track:b']);
    assert.equal(sc.removed.length, 0);
    assert.match(out.content[0].text, /Added:/);
  });
});

describe('playlist_move_block no-op rewrite guard (#882)', () => {
  const SOURCE = [track('a'), track('b'), track('c'), track('d')];

  it('issues zero writes when the target position lands inside the moved block', async () => {
    const h = harness({ source: SOURCE });
    const result = await h.invoke('playlist_move_block', {
      playlist_id: 'source',
      start: 2,
      count: 2,
      to_position: 3,
      dry_run: false,
      response_format: 'concise',
    });

    // The block (positions 2–3) already starts at slot 3, so the computed order
    // is byte-identical to the stored one — a PUT would only burn a write
    // request and risk dropping unavailable rows.
    assert.deepEqual(h.writes, []);
    const payload = result.structuredContent;
    assert.ok(payload);
    assert.equal(payload.ok, true);
    assert.equal(payload.no_op, true);
    assert.equal(payload.items, 4);
    assert.equal(payload.start, 2);
    assert.equal(payload.count, 2);
    assert.equal(payload.to_position, 3);
    assert.match(result.content[0].text, /no-op: target position 3 \(slot 3\) is inside the moved block \(2–3\)/);
  });

  it('issues zero writes when the target is clamped into the moved block', async () => {
    const h = harness({ source: SOURCE });
    // to_position 99 clamps onto the last slot, which is inside a 3–4 block.
    const result = await h.invoke('playlist_move_block', {
      playlist_id: 'source',
      start: 3,
      count: 2,
      to_position: 99,
      dry_run: false,
      response_format: 'json',
    });

    assert.deepEqual(h.writes, []);
    assert.equal(result.structuredContent?.no_op, true);
  });

  it('still writes exactly once for the first target position outside the block', async () => {
    const h = harness({ source: SOURCE });
    // Slot 4 is the first position NOT covered by a 2–3 block. The early return
    // must not swallow it: the tool still issues the replace, which happens to
    // reconstruct the same order (that is its existing index maths, not an
    // early return).
    const result = await h.invoke('playlist_move_block', {
      playlist_id: 'source',
      start: 2,
      count: 2,
      to_position: 4,
      dry_run: false,
      response_format: 'json',
    });

    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].method, 'PUT');
    const payload = result.structuredContent;
    assert.ok(payload);
    assert.equal(payload.no_op, undefined);
    assert.deepEqual(payload.order, [
      'spotify:track:a',
      'spotify:track:b',
      'spotify:track:c',
      'spotify:track:d',
    ]);
  });

  it('writes exactly once for a move that precedes the block', async () => {
    const h = harness({ source: SOURCE });
    const result = await h.invoke('playlist_move_block', {
      playlist_id: 'source',
      start: 3,
      count: 1,
      to_position: 1,
      dry_run: false,
      response_format: 'json',
    });

    assert.equal(h.writes.length, 1);
    assert.deepEqual(result.structuredContent?.order, [
      'spotify:track:c',
      'spotify:track:a',
      'spotify:track:b',
      'spotify:track:d',
    ]);
  });

  it('carries no noOp payload field left behind without the early return (#882)', () => {
    const src = readFileSync(
      new URL('../src/tools/swarm4_playlists.ts', import.meta.url),
      'utf8',
    );
    const handler = src.slice(src.indexOf("'playlist_move_block'"), src.indexOf("'playlist_swap_positions'"));
    // With the early return in place the local is unreachable: reporting
    // no_op in the write payload while still replacing the playlist is exactly
    // the defect, so the identifier must not survive.
    assert.doesNotMatch(handler, /noOp/);
    assert.match(handler, /no_op: true/);
  });
});
