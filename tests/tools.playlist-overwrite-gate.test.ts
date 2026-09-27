/**
 * Regression tests for #872 — the destructive-replace family must gate the
 * target overwrite and describe it.
 *
 * `playlist_union` and `playlist_subtract` already measure what an overwrite
 * costs and elicit before the first PUT (#860). `playlist_trim` did neither:
 * its description said "Trim playlist to N items" and never named the DELETE,
 * it asked nothing before removing every row outside the kept set, and its
 * "nothing to trim" no-op compared a CAPPED read against `keep` — so a
 * playlist larger than the walk cap was reported as already trimmed while
 * still holding every row.
 *
 * The gate is the fail-closed pair in src/tools/confirm.ts: only `confirmed`
 * proceeds, `unsupported` refuses unless SPOTIFY_MCP_CONFIRM is exactly
 * `never`, and a prompt that dies mid-flight refuses. Every refusal here is
 * asserted to leave Spotify untouched — a gate that returns a refusal *after*
 * the write would pass a message check and still destroy the playlist.
 *
 * Run: node --import tsx --test tests/tools.playlist-overwrite-gate.test.ts
 */

import './helpers/hermetic.js';

import { afterEach, describe, it } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import type { PlaylistItemObject } from '../src/types/spotify.js';
import { initConfig } from '../src/config.js';
import { StubFromResponder } from './helpers/stub-client.js';
import type { LegacyResponder, StubCall } from './helpers/stub-client.js';
import { registerPlaylistTools } from '../src/tools/playlists.js';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

interface RegisteredTool {
  name: string;
  description: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

const writes = (calls: StubCall[]) =>
  calls.filter((c) => c.method === 'PUT' || c.method === 'POST' || c.method === 'DELETE');

/** The atomic full-sequence replace is the first PUT to /playlists/{id}/items. */
const replaces = (calls: StubCall[]) => calls.filter((c) => c.method === 'PUT' && /\/items$/.test(c.path));

// Spotify playlist IDs are 22 base62 characters.
const BASE = 'A'.repeat(22);
const OTHER = 'B'.repeat(22);
const THIRD = 'C'.repeat(22);

const trackRow = (id: string): PlaylistItemObject =>
  ({
    added_at: '2026-01-01T00:00:00Z',
    item: {
      type: 'track',
      uri: `spotify:track:${id}`,
      name: `Track ${id}`,
      duration_ms: 200_000,
      artists: [{ id: `artist-${id}`, name: `Artist ${id}` }],
      album: { id: `album-${id}`, name: `Album ${id}` },
    },
  }) as unknown as PlaylistItemObject;

const rows = (n: number, prefix = 't'): PlaylistItemObject[] =>
  Array.from({ length: n }, (_, i) => trackRow(`${prefix}${i + 1}`));

/** The rows the atomic replace would actually write, in order. */
const writtenUris = (calls: StubCall[]): string[] => {
  const put = replaces(calls)[0];
  const body = put?.arg as { uris?: string[] } | undefined;
  return body?.uris ?? [];
};

const accept = { action: 'accept', content: { confirm: true } };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface HarnessOptions {
  /**
   * The elicitation verdict. `undefined` → the client advertises NO
   * elicitation capability at all, which is the fail-closed case. An Error →
   * `elicitInput` throws, which is the mid-flight-failure case.
   */
  elicit?: unknown;
  /** Runs while the prompt is open, so a test can change the playlist. */
  onElicit?: () => void;
  fetchAllCap?: number;
}

function harness(playlists: Record<string, PlaylistItemObject[]>, opts: HarnessOptions = {}) {
  const registered: RegisteredTool[] = [];
  const elicitCalls: Array<{ message: string }> = [];
  // Mutable so a test can change what the second read sees.
  const store: Record<string, PlaylistItemObject[]> = { ...playlists };

  const server = {
    tool(name: string, description: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
      registered.push({ name, description, validate: (a) => z.object(schema).parse(a), handler });
    },
    registerTool(
      name: string,
      config: { description?: string; inputSchema?: z.ZodType },
      handler: RegisteredTool['handler'],
    ) {
      registered.push({
        name,
        description: config.description ?? '',
        validate: (a) => (config.inputSchema as z.ZodType).parse(a),
        handler,
      });
    },
    // The capability accessor and elicitation both live on the inner Server
    // that McpServer exposes as `.server` (src/tools/confirm.ts).
    ...(opts.elicit !== undefined
      ? {
          server: {
            getClientCapabilities: () => ({ elicitation: { form: {} } }),
            async elicitInput(request: { message?: string }) {
              elicitCalls.push({ message: request?.message ?? '' });
              opts.onElicit?.();
              if (opts.elicit instanceof Error) throw opts.elicit;
              return opts.elicit;
            },
          },
        }
      : {}),
  } as unknown as McpServer;

  const read: LegacyResponder = (path, params) => {
    const items = /^\/playlists\/([^/]+)\/items$/.exec(path);
    if (items) {
      const id = decodeURIComponent(items[1]!);
      const list = store[id] ?? [];
      const offset = Number((params as Record<string, string> | undefined)?.offset ?? 0);
      return { items: list.slice(offset, offset + 100), total: list.length, limit: 100, offset };
    }
    const id = decodeURIComponent(path.replace('/playlists/', ''));
    return { id, name: `Playlist ${id}`, items: { total: store[id]?.length ?? 0 } };
  };

  const client = new StubFromResponder(read, {
    fetchAllCap: opts.fetchAllCap,
    writes: {
      POST: (path) => (path === '/me/playlists' ? { id: 'createdPlaylist' } : { snapshot_id: 'snap-post' }),
      PUT: () => ({ snapshot_id: 'snap-put' }),
      DELETE: () => null,
      PUT_RAW: () => undefined,
    },
  });
  registerPlaylistTools(server, client);
  return {
    // The stub's own recorder, not a copy taken at construction time: a copy
    // stays empty, and an assertion that "no write happened" then passes
    // because the list never grew rather than because nothing was written.
    calls: client.calls,
    store,
    elicitCalls,
    descriptionOf: (name: string) => registered.find((t) => t.name === name)?.description ?? '',
    async invoke(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

const textOf = (out: ToolResult) => out.content[0].text;

/** Spotify was not modified at all. */
const assertUntouched = (calls: StubCall[], label: string) =>
  assert.deepEqual(writes(calls), [], `${label}: nothing may be written`);

// SPOTIFY_MCP_CONFIRM=never turns every verdict into "unsupported, allowed".
afterEach(() => {
  delete process.env.SPOTIFY_MCP_CONFIRM;
  initConfig(process.env);
});

// ---------------------------------------------------------------------------
// playlist_trim — the ungated overwrite
// ---------------------------------------------------------------------------

describe('playlist_trim gates the overwrite it performs (#872)', () => {
  it('elicitates naming how many rows the overwrite deletes, and PUTs only on accept', async () => {
    const h = harness({ [BASE]: rows(20) }, { elicit: accept });

    await h.invoke('playlist_trim', { playlist_id: BASE, keep: 5, keep_which: 'first' });

    assert.equal(h.elicitCalls.length, 1, 'exactly one elicitation');
    const message = h.elicitCalls[0].message;
    assert.match(message, /Overwrite ALL 20 existing item\(s\) with 5 URI\(s\)/, 'the overwrite must be stated');
    assert.match(message, /deleting 15 item\(s\)/, 'the destructive count must be named');
    assert.match(message, new RegExp(BASE), 'the playlist must be named');
    assert.equal(replaces(h.calls).length, 1, 'the replace still lands on accept');
    assert.equal(writtenUris(h.calls).length, 5);
  });

  it('a declined prompt leaves the playlist untouched and reports a refusal', async () => {
    const h = harness({ [BASE]: rows(20) }, { elicit: { action: 'decline' } });

    const out = await h.invoke('playlist_trim', { playlist_id: BASE, keep: 5 });

    assert.equal(h.elicitCalls.length, 1);
    assertUntouched(h.calls, 'declined trim');
    assert.match(textOf(out), /Cancelled — nothing was changed\./);
    assert.deepEqual(out.structuredContent, { ok: false, cancelled: true });
  });

  it('a cancelled prompt is a refusal, not a silent proceed', async () => {
    const h = harness({ [BASE]: rows(20) }, { elicit: { action: 'cancel' } });

    const out = await h.invoke('playlist_trim', { playlist_id: BASE, keep: 5 });

    assertUntouched(h.calls, 'cancelled trim');
    assert.deepEqual(out.structuredContent, { ok: false, cancelled: true });
  });

  it('fails closed when the client cannot prompt (no elicitation capability)', async () => {
    const h = harness({ [BASE]: rows(20) }); // no capability advertised

    const out = await h.invoke('playlist_trim', { playlist_id: BASE, keep: 5 });

    assert.equal(h.elicitCalls.length, 0);
    assertUntouched(h.calls, 'unpromptable trim');
    assert.match(textOf(out), /Confirmation is unavailable/);
    assert.deepEqual(out.structuredContent, {
      ok: false,
      cancelled: true,
      reason: 'confirmation_unavailable',
    });
  });

  it('a mid-flight elicitation failure refuses and writes nothing', async () => {
    const h = harness({ [BASE]: rows(20) }, { elicit: new Error('transport died') });

    const out = await h.invoke('playlist_trim', { playlist_id: BASE, keep: 5 });

    assert.equal(h.elicitCalls.length, 1);
    assertUntouched(h.calls, 'failed-prompt trim');
    assert.match(textOf(out), /Elicitation failed/);
    assert.deepEqual(out.structuredContent, {
      ok: false,
      cancelled: true,
      reason: 'elicitation_failed',
    });
  });

  it('names the overwrite and the deletion in its description', () => {
    const h = harness({ [BASE]: rows(4) });
    const description = h.descriptionOf('playlist_trim');
    assert.match(description, /overwrit/i, 'the overwrite must be named');
    assert.match(description, /delete/i, 'the deletion must be named');
  });

  it('a trim that deletes nothing never elicits and never writes', async () => {
    const h = harness({ [BASE]: rows(3) }, { elicit: new Error('must not elicit') });

    const out = await h.invoke('playlist_trim', { playlist_id: BASE, keep: 5 });

    assert.equal(h.elicitCalls.length, 0, 'a no-op must not ask');
    assertUntouched(h.calls, 'no-op trim');
    assert.match(textOf(out), /already 3 ≤ 5 — nothing to trim/);
  });

  it('an unread row total is not a licence to claim "nothing to trim"', async () => {
    // The walk is capped at 12 rows and this playlist holds 20. `uris.length`
    // is therefore 12, and comparing it against keep=12 was a false no-op: the
    // tool reported an already-trimmed playlist that still held all 20 rows,
    // and 8 of them were never candidates for deletion either.
    initConfig({ ...process.env, SPOTIFY_MCP_FETCH_ALL_CAP: '12' });
    const h = harness({ [BASE]: rows(20) }, { elicit: accept });

    const out = await h.invoke('playlist_trim', { playlist_id: BASE, keep: 12 });

    assert.doesNotMatch(textOf(out), /nothing to trim/, 'a capped read cannot prove a no-op');
    assert.equal(h.elicitCalls.length, 1, 'an unprovable no-op is a prompt, not a claim');
    assert.match(h.elicitCalls[0].message, /could be read, so the true impact may be larger/);
  });

  it('refuses to write when the playlist changed while the prompt was open', async () => {
    const h = harness(
      { [BASE]: rows(20) },
      {
        elicit: accept,
        onElicit: () => {
          h.store[BASE] = [...(h.store[BASE] ?? []), trackRow('intruder')];
        },
      },
    );

    await assert.rejects(
      h.invoke('playlist_trim', { playlist_id: BASE, keep: 5 }),
      /changed during trim/,
    );
    assertUntouched(h.calls, 'trim after a concurrent edit');
  });

  it('SPOTIFY_MCP_CONFIRM=never is the only automation bypass', async () => {
    process.env.SPOTIFY_MCP_CONFIRM = 'never';
    const h = harness({ [BASE]: rows(20) }); // no capability: fail-closed by default

    await h.invoke('playlist_trim', { playlist_id: BASE, keep: 5 });

    assert.equal(replaces(h.calls).length, 1);
  });

  it('a value that is not exactly "never" is not a bypass', async () => {
    for (const value of ['NEVER', 'no', 'false', '1', '']) {
      process.env.SPOTIFY_MCP_CONFIRM = value;
      const h = harness({ [BASE]: rows(20) });
      const out = await h.invoke('playlist_trim', { playlist_id: BASE, keep: 5 });
      assertUntouched(h.calls, `SPOTIFY_MCP_CONFIRM=${value}`);
      assert.match(textOf(out), /Confirmation is unavailable/);
    }
  });

  it('a dry run previews the prompt without asking and without writing', async () => {
    const h = harness({ [BASE]: rows(20) }, { elicit: new Error('must not elicit') });

    const out = await h.invoke('playlist_trim', { playlist_id: BASE, keep: 5, dry_run: true });

    assert.equal(h.elicitCalls.length, 0);
    assertUntouched(h.calls, 'dry-run trim');
    assert.match(textOf(out), /Would trim 20 → 5 \(first\)/);
  });
});

// ---------------------------------------------------------------------------
// playlist_union — the gate that already exists, pinned from the refusal side
// ---------------------------------------------------------------------------

describe('playlist_union over an existing target (#872 acceptance)', () => {
  /** Two sources, as the schema requires: 4 unioned URIs against a 5-row target. */
  const sources = (targetRows: number) => ({
    [BASE]: rows(targetRows, 'target'),
    [OTHER]: rows(2, 'other'),
    [THIRD]: rows(2, 'third'),
  });
  const unionUris = [
    'spotify:track:other1',
    'spotify:track:other2',
    'spotify:track:third1',
    'spotify:track:third2',
  ];

  it('elicitates naming the rows the overwrite would drop', async () => {
    const h = harness(sources(5), { elicit: accept });

    await h.invoke('playlist_union', {
      playlists: [OTHER, THIRD],
      target_playlist_id: BASE,
    });

    assert.equal(h.elicitCalls.length, 1, 'exactly one elicitation');
    const message = h.elicitCalls[0].message;
    assert.match(message, /Remove 5 existing item\(s\) absent from the union/);
    assert.match(message, /Add 4 new item\(s\)/);
    assert.deepEqual(writtenUris(h.calls), unionUris);
  });

  it('a declined prompt performs no PUT at all (#872)', async () => {
    const h = harness(sources(5), { elicit: { action: 'decline' } });

    const out = await h.invoke('playlist_union', {
      playlists: [OTHER, THIRD],
      target_playlist_id: BASE,
    });

    assert.equal(h.elicitCalls.length, 1);
    assertUntouched(h.calls, 'declined union');
    assert.match(textOf(out), /Cancelled — nothing was changed\./);
    assert.deepEqual(out.structuredContent, { ok: false, cancelled: true });
  });

  it('an unpromptable client is refused before the target is touched (#872)', async () => {
    const h = harness(sources(5));

    const out = await h.invoke('playlist_union', {
      playlists: [OTHER, THIRD],
      target_playlist_id: BASE,
    });

    assertUntouched(h.calls, 'unpromptable union');
    assert.deepEqual(out.structuredContent, {
      ok: false,
      cancelled: true,
      reason: 'confirmation_unavailable',
    });
  });

  it('a union that creates a new playlist destroys nothing and never prompts', async () => {
    const h = harness(sources(0), { elicit: new Error('must not elicit') });

    const out = await h.invoke('playlist_union', { playlists: [OTHER, THIRD], target_name: 'Fresh' });

    assert.equal(h.elicitCalls.length, 0);
    assert.deepEqual(writtenUris(h.calls), unionUris);
    assert.match(textOf(out), /Union 4 item\(s\)/);
  });
});

// ---------------------------------------------------------------------------
// playlist_subtract — same gate, same refusal shape
// ---------------------------------------------------------------------------

describe('playlist_subtract rewrites the base behind a gate (#872 acceptance)', () => {
  /** A subtraction source holding the very rows the base is about to lose. */
  const baseAndSource = () => ({
    [BASE]: rows(5, 'base'),
    [OTHER]: [trackRow('base1'), trackRow('base2')],
  });

  it('elicitates naming the rows the overwrite deletes', async () => {
    const h = harness(baseAndSource(), { elicit: accept });

    await h.invoke('playlist_subtract', { base_playlist_id: BASE, playlists: [OTHER] });

    assert.equal(h.elicitCalls.length, 1);
    const message = h.elicitCalls[0].message;
    assert.match(message, /Overwrite ALL 5 existing item\(s\) with 3 URI\(s\)/);
    assert.match(message, /removing 2 URI\(s\)/);
    assert.deepEqual(writtenUris(h.calls), [
      'spotify:track:base3',
      'spotify:track:base4',
      'spotify:track:base5',
    ]);
  });

  it('names the rewrite of the base in its description', () => {
    const h = harness(baseAndSource());
    const description = h.descriptionOf('playlist_subtract');
    assert.match(description, /REWRITING A/i, 'the rewrite must be named');
    assert.match(description, /DELETED/, 'the deletion must be named');
  });

  it('a declined prompt performs no PUT at all (#872)', async () => {
    const h = harness(baseAndSource(), { elicit: { action: 'decline' } });

    const out = await h.invoke('playlist_subtract', { base_playlist_id: BASE, playlists: [OTHER] });

    assertUntouched(h.calls, 'declined subtract');
    assert.match(textOf(out), /Cancelled — nothing was changed\./);
    assert.deepEqual(out.structuredContent, { ok: false, cancelled: true });
  });

  it('a subtraction that removes nothing never elicits and never writes', async () => {
    const h = harness(
      { [BASE]: rows(3, 'base'), [OTHER]: [trackRow('unrelated')] },
      { elicit: new Error('must not elicit') },
    );

    const out = await h.invoke('playlist_subtract', { base_playlist_id: BASE, playlists: [OTHER] });

    assert.equal(h.elicitCalls.length, 0);
    assertUntouched(h.calls, 'no-op subtract');
    assert.match(textOf(out), /remove nothing; the playlist was not changed/);
  });
});
