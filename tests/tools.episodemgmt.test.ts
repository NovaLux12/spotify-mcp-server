import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerEpisodeMgmtTools } from '../src/tools/episodemgmt.js';
import type { SpotifyClient } from '../src/client.js';

function harness(overrides: { episodes?: any[] } = {}) {
  const dels: string[] = []; const puts: string[] = [];
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
    async put(path: string) { puts.push(path); return null; },
  } as unknown as SpotifyClient;
  const registered: any[] = [];
  const s = { tool(n: string, _d: string, sch: any, h: any) { registered.push({ name: n, schema: sch, handler: h }); } } as unknown as McpServer;
  registerEpisodeMgmtTools(s, client);
  const invoke = async (name: string, args: any) => {
    const t = registered.find((r: any) => r.name === name); assert.ok(t);
    return t.handler(z.object(t.schema).parse(args));
  };
  return { registered, dels, puts, invoke };
}

describe('episodemgmt', () => {
  it('registers 2 tools', () => {
    const h = harness(); assert.equal(h.registered.length, 2);
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
  it('mark_episode_played dry_run', async () => {
    const h = harness();
    const out = await h.invoke('mark_episode_played', { episode_ids: ['ep1', 'ep2'], dry_run: true });
    assert.match(out.content[0].text, /dry run/i);
  });
  it('mark_episode_played requires confirm >10', async () => {
    const h = harness();
    const ids = Array.from({ length: 11 }, (_, i) => `ep${i}`);
    const out = await h.invoke('mark_episode_played', { episode_ids: ids });
    assert.match(out.content[0].text, /confirm/i);
  });
  it('mark_episode_played succeeds with confirm', async () => {
    const h = harness();
    const out = await h.invoke('mark_episode_played', { episode_ids: ['ep1'], confirm: true });
    assert.match(out.content[0].text, /Attempted|marked/i);
  });
});
