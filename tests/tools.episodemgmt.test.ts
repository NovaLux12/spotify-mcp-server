import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerEpisodeMgmtTools } from '../src/tools/episodemgmt.js';
import type { SpotifyClient } from '../src/client.js';

function harness(overrides: { episodes?: any[] } = {}) {
  const dels: string[] = [];
  const episodes = overrides.episodes ?? [
    { episode: { id: 'ep1', uri: 'spotify:episode:ep1', name: 'Ep 1', resume_point: { fully_played: true } }, added_at: '2026-01-01' },
    { episode: { id: 'ep2', uri: 'spotify:episode:ep2', name: 'Ep 2', resume_point: { fully_played: false } }, added_at: '2026-01-02' },
    { episode: { id: 'ep3', uri: 'spotify:episode:ep3', name: 'Ep 3', resume_point: { fully_played: true } }, added_at: '2026-01-03' },
  ];
  const client = {
    async get(path: string) {
      if (path === '/me/episodes') return { items: episodes, total: episodes.length } as any;
      return null;
    },
    async getAllPages() { return episodes; },
    async delete(path: string) { dels.push(path); return null; },
    async put(path: string) { return null; },
  } as unknown as SpotifyClient;
  const registered: any[] = [];
  const s = { tool(n: string, _d: string, sch: any, h: any) { registered.push({ name: n, schema: sch, handler: h }); } } as unknown as McpServer;
  registerEpisodeMgmtTools(s, client);
  const invoke = async (name: string, args: any) => {
    const t = registered.find((r: any) => r.name === name); assert.ok(t, `tool ${name} not found`);
    return t.handler(z.object(t.schema).parse(args));
  };
  return { registered, dels, invoke };
}

describe('episodemgmt', () => {
  it('registers exactly 1 tool (archive_played_episodes)', () => {
    const h = harness(); assert.equal(h.registered.length, 1);
    assert.ok(h.registered.some((r: any) => r.name === 'archive_played_episodes'));
  });
  it('does not register phantom mark_episode_played', () => {
    const h = harness();
    assert.ok(!h.registered.some((r: any) => r.name === 'mark_episode_played'), 'mark_episode_played should be removed');
  });
  it('archive_played_episodes reports no played when none fully_played', async () => {
    const h = harness({ episodes: [{ episode: { id: 'x', uri: 'spotify:episode:x', name: 'X', resume_point: { fully_played: false } }, added_at: '2026-01-01' }] });
    const out = await h.invoke('archive_played_episodes', {});
    assert.match(out.content[0].text, /No fully-played/i);
  });
  it('archive_played_episodes dry_run previews', async () => {
    const h = harness();
    const out = await h.invoke('archive_played_episodes', { dry_run: true });
    assert.match(out.content[0].text, /dry run/i);
    assert.equal(h.dels.length, 0);
  });
  it('archive_played_episodes requires confirm when >50', async () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ episode: { id: `ep${i}`, uri: `spotify:episode:ep${i}`, name: `Ep ${i}`, resume_point: { fully_played: true } }, added_at: '2026-01-01' }));
    const h = harness({ episodes: many });
    const out = await h.invoke('archive_played_episodes', {});
    assert.match(out.content[0].text, /confirm/i);
  });
});
