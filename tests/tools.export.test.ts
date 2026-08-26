/**
 * Tests for src/tools/export.ts (#155): M3U/CSV rendering, RFC 4180 quoting,
 * file writes (mode 0600), inline truncation, pagination, json mode.
 *
 * The stub mirrors the harness in tools.playlists-following.test.ts: a fake
 * McpServer capturing registrations plus a SpotifyClient stub whose
 * getAllPages walks real offset-based pagination semantics over the stubbed
 * get(), so multi-page fixtures are exercised end to end.
 */

import { describe, it } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import type { SpotifyPaged } from '../src/types/spotify.js';
import { registerExportTools } from '../src/tools/export.js';

// ---------------------------------------------------------------------------
// Stub plumbing
// ---------------------------------------------------------------------------

interface RecordedCall {
  method: string;
  path: string;
  arg?: unknown;
}

type Responder = (path: string, arg?: unknown) => unknown;

interface RegisteredTool {
  name: string;
  description: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (
    args: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  }>;
}

function makeStubClient(responder: Responder = () => null) {
  const calls: RecordedCall[] = [];
  let respond: Responder = responder;

  const client = {
    calls,
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      calls.push({ method: 'GET', path, arg: params });
      return respond(path, params) as T | null;
    },
    // Mirrors SpotifyClient.getAllPages offset semantics so fixtures paginate.
    async getAllPages<T>(
      path: string,
      params?: Record<string, string>,
      opts?: { maxItems?: number },
    ): Promise<T[]> {
      const maxItems = opts?.maxItems ?? 500;
      const all: T[] = [];
      let offset = 0;
      for (;;) {
        const page = await this.get<SpotifyPaged<T>>(path, { ...params, offset: String(offset) });
        if (!page || !Array.isArray(page.items)) break;
        all.push(...page.items);
        if (all.length >= maxItems) return all.slice(0, maxItems);
        const limit =
          typeof page.limit === 'number' && page.limit > 0 ? page.limit : page.items.length;
        offset += limit;
        if (page.items.length === 0 || page.items.length < limit) break;
        if (typeof page.total === 'number' && offset >= page.total) break;
      }
      return all;
    },
  };
  return client;
}

function harness(responder: Responder = () => null) {
  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(
      name: string,
      description: string,
      schema: z.ZodRawShape,
      handler: RegisteredTool['handler'],
    ) {
      registered.push({
        name,
        description,
        validate: (args) => z.object(schema).parse(args),
        handler,
      });
    },
    registerTool(
      name: string,
      config: { description?: string; inputSchema?: z.ZodType },
      handler: RegisteredTool['handler'],
    ) {
      registered.push({
        name,
        description: config.description ?? '',
        validate: (args) => (config.inputSchema as z.ZodType).parse(args),
        handler,
      });
    },
  } as unknown as McpServer;
  const client = makeStubClient(responder);
  registerExportTools(fakeServer, client as unknown as SpotifyClient);

  return {
    registered,
    client,
    invoke: async (name: string, args: Record<string, unknown>) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

const textOf = (out: { content: Array<{ text: string }> }) => out.content[0].text;

// ---------------------------------------------------------------------------
// Fixtures: one playlist across multiple pages mixing tracks and episodes
// ---------------------------------------------------------------------------

const PLAYLIST_ID = 'pl123';

const trackItem = (
  id: string,
  name: string,
  ms: number,
  artistNames: string[],
  album = 'Album X',
) => ({
  added_at: '2026-01-01T00:00:00Z',
  item: {
    type: 'track',
    id,
    name,
    uri: `spotify:track:${id}`,
    duration_ms: ms,
    explicit: false,
    artists: artistNames.map((n, i) => ({ id: `a${i}`, name: n })),
    album: { id: 'alb1', name: album },
  },
});

const episodeItem = (id: string, name: string, ms: number, showName: string) => ({
  added_at: '2026-01-01T00:00:00Z',
  item: {
    type: 'episode',
    id,
    name,
    uri: `spotify:episode:${id}`,
    duration_ms: ms,
    explicit: false,
    description: 'talk',
    release_date: '2026-01-01',
    show: { id: 'show1', name: showName },
  },
});

/** 3 tracks + 2 episodes served 2-per-page (offsets 0/2/4 → 3 pages). */
const mixedResponder: Responder = (_path, arg) => {
  const params = (arg ?? {}) as Record<string, string>;
  const all = [
    trackItem('t1', 'First Song', 200_000, ['Alpha']),
    episodeItem('e1', 'Podcast One', 1_800_000, 'Talk Show'),
    trackItem('t2', 'Second, "Quoted"', 185_500, ['Beta', 'Gamma'], 'Album, With Comma'),
    episodeItem('e2', 'Podcast Two', 900_000, 'Talk Show'),
    trackItem('t3', 'Third Song', 61_400, ['Delta']),
  ];
  const offset = Number(params.offset ?? 0);
  const limit = Math.min(2, Math.max(Number(params.limit ?? 2), 1));
  const items = all.slice(offset, offset + limit);
  return { items, total: all.length, limit, offset };
};

const episodeOnlyResponder: Responder = () => ({
  items: [episodeItem('e1', 'Only Show', 3_000_000, 'Solo Podcast')],
  total: 1,
  limit: 100,
  offset: 0,
});

// ---------------------------------------------------------------------------
// Registration + defaults
// ---------------------------------------------------------------------------

describe('export_playlist registration (#155)', () => {
  it('registers exactly export_playlist with canonical z.string playlist_id', () => {
    const h = harness(mixedResponder);
    assert.equal(h.registered.length, 1);
    assert.equal(h.registered[0].name, 'export_playlist');
    // Defaults apply cleanly: no format/output_path/include_headers required.
    const parsed = h.registered[0].validate({ playlist_id: PLAYLIST_ID }) as Record<
      string,
      unknown
    >;
    assert.equal(parsed.format, 'm3u');
    assert.equal(parsed.include_headers, true);
    assert.equal(parsed.response_format, 'concise');
  });

  it('rejects an unknown format value at the schema level', () => {
    const h = harness();
    assert.throws(() => h.registered[0].validate({ playlist_id: 'x', format: 'xml' }));
  });
});

// ---------------------------------------------------------------------------
// Unknown playlist error
// ---------------------------------------------------------------------------

describe('export_playlist unknown-playlist error', () => {
  it('fails fast with a clear error before paging items', async () => {
    const h = harness((path) => (path.startsWith('/playlists/nope') ? null : undefined));
    await assert.rejects(h.invoke('export_playlist', { playlist_id: 'nope' }), /not found/);
    // No items call was made after the failed existence probe.
    assert.ok(!h.client.calls.some((c) => c.path.includes('/items')));
  });
});

// ---------------------------------------------------------------------------
// M3U format
// ---------------------------------------------------------------------------

describe('export_playlist m3u format', () => {
  it('pages all items and renders EXTM3U header + EXTINF entries', async () => {
    const h = harness((path, arg) =>
      path === `/playlists/${PLAYLIST_ID}` ? { id: PLAYLIST_ID, name: 'Mix' } : mixedResponder(path, arg),
    );
    const out = await h.invoke('export_playlist', { playlist_id: PLAYLIST_ID });
    const text = textOf(out);

    // Three pages were walked (offset 0, 2, 4).
    const itemCalls = h.client.calls.filter((c) => c.path === `/playlists/${PLAYLIST_ID}/items`);
    assert.deepEqual(itemCalls.map((c) => (c.arg as Record<string, string>).offset), ['0', '2', '4']);

    const lines = text.split('\n');
    assert.equal(lines[0], '#EXTM3U');

    // EXTINF seconds math: 200000ms → 200; 185500ms → rounds to 186; 61400 → 61.
    assert.ok(lines.includes('#EXTINF:200,Alpha - First Song'), text);
    assert.ok(lines.includes('#EXTINF:186,Beta, Gamma - Second, "Quoted"'), text);
    assert.ok(lines.includes('#EXTINF:61,Delta - Third Song'), text);
    assert.ok(lines.includes('spotify:track:t1'));
    assert.ok(lines.includes('spotify:track:t3'));

    // Episodes skipped with a single comment count.
    assert.ok(text.includes('# 2 episode(s) skipped — M3U does not carry talk content'), text);
    assert.ok(!text.includes('spotify:episode:e1'));
    assert.ok(!text.includes('Podcast One'));
    assert.equal(text.endsWith('\n'), true);
  });

  it('renders episodes like tracks when ONLY episodes exist (never empty)', async () => {
    const h = harness((path) =>
      path === `/playlists/${PLAYLIST_ID}` ? { id: PLAYLIST_ID } : episodeOnlyResponder(path),
    );
    const out = await h.invoke('export_playlist', { playlist_id: PLAYLIST_ID });
    const text = textOf(out);
    assert.ok(text.startsWith('#EXTM3U\n'));
    assert.ok(!text.includes('skipped'));
    assert.ok(text.includes('#EXTINF:3000,Solo Podcast - Only Show'));
    assert.ok(text.includes('spotify:episode:e1'));
  });

  it('omits the #EXTM3U marker when include_headers is false', async () => {
    const h = harness(mixedResponder);
    const out = await h.invoke('export_playlist', {
      playlist_id: PLAYLIST_ID,
      include_headers: false,
    });
    const text = textOf(out);
    assert.ok(!text.includes('#EXTM3U'));
    // The episode-skip comment still documents what was left out.
    assert.ok(text.includes('# 2 episode(s) skipped'));
  });
});

// ---------------------------------------------------------------------------
// CSV format + RFC 4180 quoting
// ---------------------------------------------------------------------------

describe('export_playlist csv format', () => {
  it('emits header row and quotes fields containing commas/quotes per RFC 4180', async () => {
    const h = harness((path, arg) =>
      path === `/playlists/${PLAYLIST_ID}` ? { id: PLAYLIST_ID } : mixedResponder(path, arg),
    );
    const out = await h.invoke('export_playlist', { playlist_id: PLAYLIST_ID, format: 'csv' });
    const lines = textOf(out).trimEnd().split('\n');

    assert.equal(lines[0], 'track_no,title,artists,album,duration_ms,uri');
    // Episodes ARE included in CSV rows, in playlist order.
    assert.equal(lines.length, 6);
    assert.equal(lines[1], '1,First Song,Alpha,Album X,200000,spotify:track:t1');
    // Row 3: title contains comma AND quote → quoted, quotes doubled;
    // artists and album also contain commas → each quoted independently.
    assert.equal(
      lines[3],
      '3,"Second, ""Quoted""","Beta, Gamma","Album, With Comma",185500,spotify:track:t2',
    );
    // Episode rows carry the show name as artists and an empty album.
    assert.equal(lines[4], '4,Podcast Two,Talk Show,,900000,spotify:episode:e2');
  });

  it('omits the header row when include_headers is false', async () => {
    const h = harness((path, arg) =>
      path === `/playlists/${PLAYLIST_ID}` ? { id: PLAYLIST_ID } : mixedResponder(path, arg),
    );
    const out = await h.invoke('export_playlist', {
      playlist_id: PLAYLIST_ID,
      format: 'csv',
      include_headers: false,
    });
    const text = textOf(out);
    assert.ok(!text.includes('track_no,title'));
    assert.ok(text.startsWith('1,First Song'));
  });
});

// ---------------------------------------------------------------------------
// File mode: real tmpdir write, mode 0600, cleanup
// ---------------------------------------------------------------------------

describe('export_playlist output_path file mode', () => {
  it('writes the FULL document with mode 0600 and returns a summary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spotify-export-test-'));
    try {
      const filePath = join(dir, 'mix.m3u');
      const h = harness((path, arg) =>
        path === `/playlists/${PLAYLIST_ID}` ? { id: PLAYLIST_ID, name: 'Mix' } : mixedResponder(path, arg),
      );
      const out = await h.invoke('export_playlist', {
        playlist_id: PLAYLIST_ID,
        output_path: filePath,
      });
      const text = textOf(out);

      assert.match(text, new RegExp(filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(text, /5 item\(s\) \(3 track\(s\), 2 episode\(s\)\)/);
      assert.match(text, /\(\d+ bytes\)/);

      const written = await readFile(filePath, 'utf8');
      assert.ok(written.startsWith('#EXTM3U\n'));
      assert.ok(written.includes('#EXTINF:200,Alpha - First Song'));
      // Full document: episodes skipped, all 3 tracks present.
      assert.ok(written.includes('spotify:track:t3'));
      assert.ok(!written.includes('spotify:episode:e2'));
      assert.ok(written.includes('# 2 episode(s) skipped'));

      // Mode 0600 regardless of umask.
      const st = await stat(filePath);
      assert.equal(st.mode & 0o777, 0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes every row in csv file mode (max_results does not truncate writes)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spotify-export-test-'));
    try {
      const filePath = join(dir, 'mix.csv');
      const h = harness((path, arg) =>
        path === `/playlists/${PLAYLIST_ID}` ? { id: PLAYLIST_ID } : mixedResponder(path, arg),
      );
      const out = await h.invoke('export_playlist', {
        playlist_id: PLAYLIST_ID,
        format: 'csv',
        max_results: 1,
        output_path: filePath,
      });
      assert.doesNotMatch(textOf(out), /truncated/i);
      const written = await readFile(filePath, 'utf8');
      assert.equal(written.trimEnd().split('\n').length, 6); // header + 5 rows
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Inline truncation
// ---------------------------------------------------------------------------

describe('export_playlist inline truncation', () => {
  it('truncates at max_results rows with a footer noting truncation + full length', async () => {
    const h = harness((path, arg) =>
      path === `/playlists/${PLAYLIST_ID}` ? { id: PLAYLIST_ID } : mixedResponder(path, arg),
    );
    const out = await h.invoke('export_playlist', { playlist_id: PLAYLIST_ID, max_results: 2 });
    const text = textOf(out);
    const bodyLines = text.split('\n');

    // Header + skip comment + first 2 EXPORTABLE rows (tracks) × 2 lines.
    assert.equal(bodyLines[0], '#EXTM3U');
    assert.equal(bodyLines[1], '# 2 episode(s) skipped — M3U does not carry talk content');
    assert.equal(bodyLines[2], '#EXTINF:200,Alpha - First Song');
    assert.equal(bodyLines[3], 'spotify:track:t1');
    assert.equal(bodyLines[4], '#EXTINF:186,Beta, Gamma - Second, "Quoted"');
    assert.equal(bodyLines[5], 'spotify:track:t2');
    assert.match(
      text,
      /\[truncated: showing first 2 of 3 items — full export is 8 lines; pass output_path or raise max_results for everything\]/,
    );

    // structuredContent twin reports the truncation too.
    assert.equal(out.structuredContent?.truncated, true);
    assert.equal(out.structuredContent?.returned, 2);
    assert.equal(out.structuredContent?.total_items, 5);
  });

  it('adds no footer when everything fits', async () => {
    const h = harness((path, arg) =>
      path === `/playlists/${PLAYLIST_ID}` ? { id: PLAYLIST_ID } : mixedResponder(path, arg),
    );
    const out = await h.invoke('export_playlist', { playlist_id: PLAYLIST_ID, max_results: 10 });
    assert.doesNotMatch(textOf(out), /truncated/i);
    assert.equal(out.structuredContent?.truncated, false);
  });
});

// ---------------------------------------------------------------------------
// JSON mode
// ---------------------------------------------------------------------------

describe('export_playlist json mode', () => {
  it('returns raw parsed items with a structuredContent twin', async () => {
    const h = harness((path, arg) =>
      path === `/playlists/${PLAYLIST_ID}` ? { id: PLAYLIST_ID } : mixedResponder(path, arg),
    );
    const out = await h.invoke('export_playlist', { playlist_id: PLAYLIST_ID, response_format: 'json' });
    const parsed = JSON.parse(textOf(out));

    assert.equal(parsed.playlist_id, PLAYLIST_ID);
    assert.equal(parsed.format, 'm3u');
    assert.equal(parsed.total_items, 5);
    assert.equal(parsed.tracks, 3);
    assert.equal(parsed.episodes, 2);
    assert.equal(parsed.truncated, false);
    assert.equal(parsed.items.length, 5);
    assert.deepEqual(parsed.items[0], {
      track_no: 1,
      title: 'First Song',
      artists: 'Alpha',
      album: 'Album X',
      duration_ms: 200000,
      uri: 'spotify:track:t1',
      is_episode: false,
    });
    assert.equal(parsed.items[1].is_episode, true);
    assert.equal(parsed.items[1].artists, 'Talk Show');

    // Twin: structuredContent carries the same payload.
    assert.deepEqual(out.structuredContent, parsed);
  });

  it('reports truncation in json mode while items stay complete', async () => {
    const h = harness((path, arg) =>
      path === `/playlists/${PLAYLIST_ID}` ? { id: PLAYLIST_ID } : mixedResponder(path, arg),
    );
    const out = await h.invoke('export_playlist', {
      playlist_id: PLAYLIST_ID,
      response_format: 'json',
      max_results: 1,
    });
    // max_results caps the RENDERED document; json items stay complete and
    // report truncation via returned/truncated.
    const parsed = JSON.parse(textOf(out));
    assert.equal(parsed.returned, 1);
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.items.length, 5);
    assert.deepEqual(out.structuredContent, parsed);
  });
});

describe('export_playlist fetch truncation (FETCH_ALL_CAP)', () => {
  it('reports fetch_truncated and footer when playlist exceeds FETCH_ALL_CAP', async () => {
    const { initConfig, getConfig } = await import('../src/config.js');
    initConfig({ SPOTIFY_MCP_FETCH_ALL_CAP: '2' });
    assert.equal(getConfig().fetchAllCap, 2);
    // Need 3 items but cap 2
    const manyResponder: typeof mixedResponder = (_path, arg) => {
      const params = (arg ?? {}) as Record<string, string>;
      const all = [
        trackItem('t1', 'A', 1000, ['X']),
        trackItem('t2', 'B', 1000, ['Y']),
        trackItem('t3', 'C', 1000, ['Z']),
      ];
      const offset = Number(params.offset ?? 0);
      const items = all.slice(offset, offset + 2);
      return { items, total: all.length, limit: 2, offset };
    };
    const h = harness((path, arg) => path === `/playlists/${PLAYLIST_ID}` ? { id: PLAYLIST_ID } : manyResponder(path, arg));
    const out = await h.invoke('export_playlist', { playlist_id: PLAYLIST_ID });
    assert.equal(out.structuredContent?.fetch_truncated, true);
    assert.equal(out.structuredContent?.fetch_cap, 2);
    assert.match(textOf(out), /raise SPOTIFY_MCP_FETCH_ALL_CAP/);
    initConfig(); // restore
  });
});
