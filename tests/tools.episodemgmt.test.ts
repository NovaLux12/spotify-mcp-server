import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerEpisodeMgmtTools } from '../src/tools/episodemgmt.js';
import type { SpotifyClient } from '../src/client.js';
import { verifyReceipt } from '../src/receipts.js';
type EpisodeItem = {
  episode: {
    id: string;
    uri: string;
    name: string;
    resume_point: { fully_played: boolean };
  };
  added_at: string;
};

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type RegisteredTool = {
  name: string;
  schema: z.ZodRawShape;
  handler: (args: unknown) => Promise<ToolResult>;
};

type CapturingServer = {
  tool(
    name: string,
    description: string,
    schema: z.ZodRawShape,
    handler: (args: unknown) => Promise<ToolResult>,
  ): void;
  server?: {
    getClientCapabilities(): { elicitation: { form: Record<string, never> } };
    elicitInput(): Promise<ElicitationAnswer>;
  };
};

type ElicitationAnswer =
  | { action: 'accept'; content?: { confirm?: unknown } }
  | { action: 'decline' | 'cancel' }
  | Error;

function playedEpisodes(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    episode: {
      id: `ep${i}`,
      uri: `spotify:episode:ep${i}`,
      name: `Ep ${i}`,
      resume_point: { fully_played: true },
    },
    added_at: '2026-01-01',
  }));
}

function harness(overrides: { episodes?: EpisodeItem[]; answer?: ElicitationAnswer; stillPresent?: string[] } = {}) {
  const dels: string[] = [];
  let prompts = 0;
  const episodes: EpisodeItem[] = overrides.episodes ?? [
    { episode: { id: 'ep1', uri: 'spotify:episode:ep1', name: 'Ep 1', resume_point: { fully_played: true } }, added_at: '2026-01-01' },
    { episode: { id: 'ep2', uri: 'spotify:episode:ep2', name: 'Ep 2', resume_point: { fully_played: false } }, added_at: '2026-01-02' },
    { episode: { id: 'ep3', uri: 'spotify:episode:ep3', name: 'Ep 3', resume_point: { fully_played: true } }, added_at: '2026-01-03' },
  ];
  const client = {
    async get(path: string, params?: Record<string, string>) {
      if (path === '/me/episodes') return { items: episodes, total: episodes.length };
      // Receipt verification refetch: /me/library/contains?uris=a,b
      if (path === '/me/library/contains') {
        const asked = (params?.uris ?? '').split(',');
        const present = new Set(overrides.stillPresent ?? []);
        return asked.map((u) => present.has(u));
      }
      return null;
    },
    async getAllPages() { return episodes; },
    async delete(path: string) { dels.push(path); return null; },
    async put(path: string) { return null; },
  } as unknown as SpotifyClient;
  const registered: RegisteredTool[] = [];
  const server: CapturingServer = {
    tool(name, _description, schema, handler) {
      registered.push({ name, schema, handler });
    },
  };
  if (overrides.answer !== undefined) {
    server.server = {
      getClientCapabilities: () => ({ elicitation: { form: {} } }),
      async elicitInput() {
        prompts += 1;
        if (overrides.answer instanceof Error) throw overrides.answer;
        return overrides.answer;
      },
    };
  }
  // Test double implements only the registration and elicitation surface used here.
  registerEpisodeMgmtTools(server as unknown as McpServer, client);
  const invoke = async (name: string, args: unknown) => {
    const tool = registered.find((entry) => entry.name === name);
    assert.ok(tool, `tool ${name} not found`);
    return tool.handler(z.object(tool.schema).parse(args));
  };
  return {
    registered,
    dels,
    invoke,
    get promptCount() { return prompts; },
  };
}

afterEach(() => {
  delete process.env.SPOTIFY_MCP_CONFIRM;
});

describe('episodemgmt', () => {
  it('registers exactly 1 tool (archive_played_episodes)', () => {
    const h = harness(); assert.equal(h.registered.length, 1);
    assert.ok(h.registered.some((entry) => entry.name === 'archive_played_episodes'));
  });
  it('does not register phantom mark_episode_played', () => {
    const h = harness();
    assert.ok(!h.registered.some((entry) => entry.name === 'mark_episode_played'), 'mark_episode_played should be removed');
  });
  it('accepts a legacy confirm input but never lets it authorise the delete', async () => {
    // No `answer` override: the client advertises no elicitation capability, so
    // the verdict is 'unsupported' — the exact case the old boolean bypassed.
    const h = harness({ episodes: playedEpisodes(51) });
    const tool = h.registered[0];
    assert.ok(tool);
    // Accepted so a 1.31.0 caller is not rejected with unknown_param...
    assert.ok(tool.schema.confirm, 'legacy confirm input must still be accepted');
    // ...but it must not stand in for a human: with no elicitation capability
    // the write is refused exactly as it would be without the flag.
    const out = await h.invoke('archive_played_episodes', { confirm: true });
    assert.equal(out.structuredContent?.ok, false);
    assert.equal(out.structuredContent?.reason, 'confirmation_unavailable');
    assert.deepEqual(h.dels, [], 'confirm:true must not authorise the delete');
    assert.deepEqual(out.structuredContent?.deprecated_inputs, ['confirm']);
  });
  it('archive_played_episodes reports no played when none fully_played', async () => {
    const h = harness({ episodes: [{ episode: { id: 'x', uri: 'spotify:episode:x', name: 'X', resume_point: { fully_played: false } }, added_at: '2026-01-01' }] });
    const out = await h.invoke('archive_played_episodes', {});
    assert.match(out.content[0].text, /No fully-played/i);
  });
  it('archive_played_episodes dry_run previews without prompting or writing', async () => {
    const h = harness({ episodes: playedEpisodes(51), answer: new Error('must not prompt') });
    const out = await h.invoke('archive_played_episodes', { dry_run: true });
    assert.match(out.content[0].text, /dry run/i);
    assert.equal(h.promptCount, 0);
    assert.deepEqual(h.dels, []);
  });
  it('refuses >50 episodes without elicitation support and performs zero writes', async () => {
    const h = harness({ episodes: playedEpisodes(51) });
    const out = await h.invoke('archive_played_episodes', {});
    assert.equal(out.structuredContent.ok, false);
    assert.equal(out.structuredContent.cancelled, true);
    assert.equal(out.structuredContent.reason, 'confirmation_unavailable');
    assert.equal(h.promptCount, 0);
    assert.deepEqual(h.dels, []);
  });
  it('refuses a declined confirmation and performs zero writes', async () => {
    const h = harness({ episodes: playedEpisodes(51), answer: { action: 'decline' } });
    const out = await h.invoke('archive_played_episodes', {});
    assert.equal(out.structuredContent.ok, false);
    assert.equal(out.structuredContent.cancelled, true);
    assert.equal(h.promptCount, 1);
    assert.deepEqual(h.dels, []);
  });
  it('treats accept without confirm=true as declined and performs zero writes', async () => {
    const h = harness({ episodes: playedEpisodes(51), answer: { action: 'accept', content: {} } });
    const out = await h.invoke('archive_played_episodes', {});
    assert.equal(out.structuredContent.ok, false);
    assert.equal(out.structuredContent.cancelled, true);
    assert.equal(h.promptCount, 1);
    assert.deepEqual(h.dels, []);
  });
  it('refuses a transport error and performs zero writes', async () => {
    const h = harness({ episodes: playedEpisodes(51), answer: new Error('elicitation transport failed') });
    const out = await h.invoke('archive_played_episodes', {});
    assert.equal(out.structuredContent.ok, false);
    assert.equal(out.structuredContent.cancelled, true);
    assert.equal(out.structuredContent.reason, 'elicitation_failed');
    assert.equal(h.promptCount, 1);
    assert.deepEqual(h.dels, []);
  });
  it('archives >50 episodes only after an explicit accepted confirmation', async () => {
    const h = harness({ episodes: playedEpisodes(51), answer: { action: 'accept', content: { confirm: true } } });
    const out = await h.invoke('archive_played_episodes', {});
    assert.equal(out.structuredContent.ok, true);
    assert.equal(out.structuredContent.removed, 51);
    assert.equal(h.promptCount, 1);
    assert.equal(h.dels.length, 2);
  });
  it('SPOTIFY_MCP_CONFIRM=never explicitly bypasses prompting and archives >50 episodes', async () => {
    process.env.SPOTIFY_MCP_CONFIRM = 'never';
    const h = harness({ episodes: playedEpisodes(51), answer: { action: 'decline' } });
    const out = await h.invoke('archive_played_episodes', {});
    assert.equal(out.structuredContent.ok, true);
    assert.equal(out.structuredContent.removed, 51);
    assert.equal(h.promptCount, 0);
    assert.equal(h.dels.length, 2);
  });
  it('a successful archive issues a removal receipt verify_receipt can resolve', async () => {
    const h = harness({ episodes: playedEpisodes(3) });
    const out = await h.invoke('archive_played_episodes', {});
    const receipt = out.structuredContent.receipt as { receipt_id?: string };
    assert.ok(receipt?.receipt_id, 'successful archive must surface a receipt id');
    // Same process, same in-module store: this is what verify_receipt reads.
    const stored = verifyReceipt(receipt.receipt_id!);
    assert.ok(stored, 'receipt id must resolve in the receipt store');
    assert.equal(stored!.kind, 'library');
    assert.deepEqual(stored!.uris, ['spotify:episode:ep0', 'spotify:episode:ep1', 'spotify:episode:ep2']);
  });
  it('the archive receipt records the episodes as expected ABSENT', async () => {
    const h = harness({ episodes: playedEpisodes(3) });
    const out = await h.invoke('archive_played_episodes', {});
    const receipt = out.structuredContent.receipt as Record<string, unknown>;
    // A removal receipt: direction removed (so undo re-adds) and no still-present
    // uris once the refetch confirms they are gone.
    assert.equal(receipt.direction, 'removed');
    assert.equal(receipt.verified, true);
    assert.deepEqual(receipt.missing, []);
    assert.match(out.content[0].text, /confirmed absent/i);
  });
  it('an archive that only partly landed reports the still-present uri', async () => {
    const h = harness({ episodes: playedEpisodes(3), stillPresent: ['spotify:episode:ep1'] });
    const out = await h.invoke('archive_played_episodes', {});
    const receipt = out.structuredContent.receipt as Record<string, unknown>;
    assert.equal(receipt.verified, false);
    assert.deepEqual(receipt.missing, ['spotify:episode:ep1']);
    assert.match(out.content[0].text, /still-present uris: spotify:episode:ep1/);
  });
  it('json response_format keeps the text parseable and carries the receipt in structuredContent', async () => {
    const h = harness({ episodes: playedEpisodes(3) });
    const out = await h.invoke('archive_played_episodes', { response_format: 'json' });
    // json stays machine-parseable: no receipt prose leaks into the text
    // (same contract as library.ts mutationOutVerified).
    const parsed = JSON.parse(out.content[0].text) as { removed: number };
    assert.equal(parsed.removed, 3);
    assert.doesNotMatch(out.content[0].text, /VERIFIED|confirmed absent/);
    const receipt = out.structuredContent.receipt as { receipt_id?: string };
    assert.ok(receipt.receipt_id, 'json mode must still expose the receipt via structuredContent');
    assert.ok(verifyReceipt(receipt.receipt_id!));
  });
  it('issues no receipt on any refused or dry-run path', async () => {
    const refused = harness({ episodes: playedEpisodes(51) });
    const r = await refused.invoke('archive_played_episodes', {});
    assert.equal(r.structuredContent.ok, false);
    assert.equal(r.structuredContent.receipt, undefined);
    const dry = harness({ episodes: playedEpisodes(3) });
    const d = await dry.invoke('archive_played_episodes', { dry_run: true });
    assert.equal(d.structuredContent.receipt, undefined);
  });
});
