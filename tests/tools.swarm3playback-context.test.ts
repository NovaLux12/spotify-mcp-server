/**
 * get_context_inspect (#838): playlist item rows expose the playable under
 * `item` since the Feb 2026 rename. The deprecated `track` alias must still
 * work so either projection resolves the current track's position.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerSwarm3PlaybackTools } from '../src/tools/swarm3_playback.js';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};
type Registered = {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};

function makeHarness(responder: (path: string, params?: Record<string, string>) => unknown) {
  const registered: Registered[] = [];
  const server = {
    tool(name: string, _desc: string, _schema: z.ZodRawShape, handler: Registered['handler']) {
      registered.push({ name, handler });
    },
    registerTool(name: string, config: { description?: string; inputSchema?: z.ZodType }, handler: Registered['handler']) {
      registered.push({ name, handler });
    },
  } as unknown as McpServer;
  const client = {
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      return responder(path, params) as T | null;
    },
    async post<T>(): Promise<T | null> { return null; },
    async put<T>(): Promise<T | null> { return null; },
    async delete<T>(): Promise<T | null> { return null; },
    async getAllPages<T>(): Promise<T[]> { return []; },
  } as unknown as SpotifyClient;
  registerSwarm3PlaybackTools(server, client);
  return {
    async invoke(name: string, args: Record<string, unknown>): Promise<ToolResult> {
      const t = registered.find((r) => r.name === name);
      assert.ok(t, `tool ${name} not registered`);
      return t!.handler(args);
    },
  };
}

const state = {
  is_playing: true,
  progress_ms: 1000,
  timestamp: Date.parse('2026-09-01T10:00:00Z'),
  shuffle_state: false,
  repeat_state: 'off',
  device: { id: 'd1', name: 'Speaker', volume_percent: 50 },
  item: { uri: 'spotify:track:b', name: 'B', type: 'track', duration_ms: 200000, artists: [{ name: 'A' }] },
  context: { type: 'playlist', uri: 'spotify:playlist:pl1' },
};

describe('get_context_inspect reads item (not deprecated track) on playlist rows', () => {
  it('finds the current track in a row shaped { item: { uri } }', async () => {
    const h = makeHarness((path) => {
      if (path === '/me/player') return state;
      if (path === '/playlists/pl1/items') {
        return { items: [{ item: { uri: 'spotify:track:a' } }, { item: { uri: 'spotify:track:b' } }] };
      }
      throw new Error(`unexpected GET ${path}`);
    });
    const out = await h.invoke('get_context_inspect', {});
    assert.equal(out.structuredContent?.position_in_context, 2);
    assert.match(out.content.map((c) => c.text).join('\n'), /Track 2/);
  });

  it('still resolves rows shaped with the deprecated track alias', async () => {
    const h = makeHarness((path) => {
      if (path === '/me/player') return state;
      if (path === '/playlists/pl1/items') {
        return { items: [{ track: { uri: 'spotify:track:a' } }, { track: { uri: 'spotify:track:b' } }] };
      }
      throw new Error(`unexpected GET ${path}`);
    });
    const out = await h.invoke('get_context_inspect', {});
    assert.equal(out.structuredContent?.position_in_context, 2);
  });

  it('walks later pages using item on every page', async () => {
    const h = makeHarness((path, params) => {
      if (path === '/me/player') return state;
      if (path === '/playlists/pl1/items') {
        return params?.offset
          ? { items: [{ item: { uri: 'spotify:track:c' } }, { item: { uri: 'spotify:track:b' } }] }
          : { items: [{ item: { uri: 'spotify:track:a' } }] };
      }
      throw new Error(`unexpected GET ${path}`);
    });
    const out = await h.invoke('get_context_inspect', {});
    assert.equal(out.structuredContent?.position_in_context, 3);
  });
});
