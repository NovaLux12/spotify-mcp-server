/**
 * Tests for src/tools/import.ts (#165): M3U/CSV parsing, format detection,
 * round-trip with export_playlist output, dedupe, batched adds, dry_run,
 * source-validation errors, and unknown-target fail-fast.
 */

import { describe, it } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import {
  registerImportTools,
  parseM3u,
  parseCsv,
  splitCsvRow,
  detectFormat,
} from '../src/tools/import.js';

// ---------------------------------------------------------------------------
// Stub plumbing
// ---------------------------------------------------------------------------

interface RecordedCall {
  method: string;
  path: string;
  arg?: unknown;
}

type Responder = (path: string) => unknown;

interface RegisteredTool {
  name: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (
    args: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  }>;
}

function harness(responder: Responder = () => null) {
  const registered: RegisteredTool[] = [];
  const fakeServer = {
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
  } as unknown as McmShim;
  const calls: RecordedCall[] = [];
  const client = {
    calls,
    async get<T>(path: string): Promise<T | null> {
      calls.push({ method: 'GET', path });
      return responder(path) as T | null;
    },
    async post<T>(path: string, body: unknown): Promise<T | null> {
      calls.push({ method: 'POST', path, arg: body });
      return responder(`POST ${path}`) as T | null;
    },
  };
  registerImportTools(fakeServer, client as unknown as SpotifyClient);
  return {
    registered,
    client,
    posts: () => calls.filter((c) => c.method === 'POST'),
    invoke: async (name: string, args: Record<string, unknown>) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return tool.handler(tool.validate(args));
    },
  };
}
type McmShim = McpServer;

const textOf = (out: { content: Array<{ text: string }> }) => out.content[0].text;

const playlistResponder = (name = 'Restore Target'): Responder => (path) =>
  path === '/playlists/pl1' ? { id: 'pl1', name } : null;

// ---------------------------------------------------------------------------
// Parsers (pure)
// ---------------------------------------------------------------------------

describe('import_playlist parsers', () => {
  it('parseM3u extracts bare URI lines and skips comments/blanks', () => {
    const doc = [
      '#EXTM3U',
      '#EXTINF:200,Duo - Overlap Song',
      'spotify:track:x1',
      '',
      '# a comment',
      'spotify:episode:ep1',
      'https://example.com/not-spotify',
      'spotify:track:not a uri',
    ].join('\n');
    const parsed = parseM3u(doc);
    assert.deepEqual(parsed.uris, ['spotify:track:x1', 'spotify:episode:ep1']);
    assert.equal(parsed.skipped_rows, 2);
  });

  it('parseM3u keeps first position of duplicate URIs', () => {
    const parsed = parseM3u('spotify:track:a\nspotify:track:b\nspotify:track:a');
    assert.deepEqual(parsed.uris, ['spotify:track:a', 'spotify:track:b']);
    assert.equal(parsed.skipped_rows, 0);
  });

  it('splitCsvRow honours quoted commas and escaped quotes', () => {
    assert.deepEqual(splitCsvRow('1,"Duo, The","Say ""Hi""",Album,200000,spotify:track:x'), [
      '1',
      'Duo, The',
      'Say "Hi"',
      'Album',
      '200000',
      'spotify:track:x',
    ]);
  });

  it('parseCsv finds the uri field regardless of column order or quoting', () => {
    const doc = [
      'track_no,title,artists,album,duration_ms,uri',
      '1,Some Song,Duo,Album X,200000,spotify:track:c1',
      '42,"Wrapped, title",Trio,,190000,spotify:track:c2',
    ].join('\n');
    const parsed = parseCsv(doc);
    assert.equal(parsed.format, 'csv');
    assert.deepEqual(parsed.uris, ['spotify:track:c1', 'spotify:track:c2']);
    assert.equal(parsed.skipped_rows, 1); // header row
  });

  it('detectFormat distinguishes m3u markers, bare URIs, and csv rows', () => {
    assert.equal(detectFormat('#EXTM3U\nspotify:track:a'), 'm3u');
    assert.equal(detectFormat('spotify:track:a'), 'm3u');
    assert.equal(
      detectFormat('track_no,title,uri\n1,T,spotify:track:a'),
      'csv',
    );
    assert.equal(detectFormat('nothing useful here'), null);
  });

  it('round-trips export_playlist M3U output exactly', () => {
    // Byte-identical shape to src/tools/export.ts renderM3u.
    const exported = '#EXTM3U\n#EXTINF:200,Duo - Song A\nspotify:track:a\n#EXTINF:180,Trio - Song B\nspotify:track:b\n';
    assert.deepEqual(parseM3u(exported).uris, ['spotify:track:a', 'spotify:track:b']);
  });
});

// ---------------------------------------------------------------------------
// Registration + document-source validation
// ---------------------------------------------------------------------------

describe('import_playlist registration + validation', () => {
  it('rejects missing and duplicated document sources before any network call', async () => {
    const h = harness(playlistResponder());
    await assert.rejects(() => h.invoke('import_playlist', { playlist_id: 'pl1' }), /content or input_path/);
    await assert.rejects(
      () => h.invoke('import_playlist', { playlist_id: 'pl1', content: 'x', input_path: '/tmp/x' }),
      /either content or input_path/,
    );
    assert.equal(h.client.calls.length, 0);
  });

  it('fails fast on an unknown target playlist', async () => {
    const h = harness(() => null);
    await assert.rejects(
      () => h.invoke('import_playlist', { playlist_id: 'nope', content: 'spotify:track:a' }),
      /Playlist "nope" not found/,
    );
    assert.equal(h.posts().length, 0);
  });

  it('throws a clear error when no URIs are extractable', async () => {
    const h = harness(playlistResponder());
    await assert.rejects(
      () => h.invoke('import_playlist', { playlist_id: 'pl1', content: '#EXTM3U\n# only comments' }),
      /No spotify:track:\/spotify:episode: URIs found/,
    );
  });
});

// ---------------------------------------------------------------------------
// dry_run + mutation
// ---------------------------------------------------------------------------

describe('import_playlist dry run + add behaviour', () => {
  const csv = 'track_no,title,artists,duration_ms,uri\n1,A,Duo,200000,spotify:track:a\n2,B,Trio,180000,spotify:track:b\n';

  it('dry_run reports the extraction without POSTing', async () => {
    const h = harness(playlistResponder());
    const out = await h.invoke('import_playlist', {
      playlist_id: 'pl1',
      content: csv,
      dry_run: true,
    });
    assert.match(textOf(out), /\[dry run\]/);
    const p = out.structuredContent as { parsed_uris: number; dry_run: boolean; added?: number };
    assert.equal(p.parsed_uris, 2);
    assert.equal(p.dry_run, true);
    assert.equal(p.added, undefined);
    assert.equal(h.posts().length, 0);
  });

  it('adds in batches of 100 and reports snapshot/batches', async () => {
    const uris = Array.from({ length: 250 }, (_, i) => `spotify:track:t${i}`);
    const h = harness((path) =>
      path.startsWith('POST ') ? { snapshot_id: 'snap-1' } : { id: 'pl1', name: 'X' },
    );
    const out = await h.invoke('import_playlist', {
      playlist_id: 'pl1',
      content: uris.join('\n'),
    });
    const p = out.structuredContent as { added: number; batches_sent: number; snapshot_id?: string };
    assert.equal(p.added, 250);
    assert.equal(p.batches_sent, 3);
    assert.equal(h.posts().length, 3);
    const firstBatch = (h.posts()[0].arg as { uris: string[] }).uris;
    assert.equal(firstBatch.length, 100);
    assert.equal(firstBatch[0], 'spotify:track:t0');
    assert.equal(p.snapshot_id, 'snap-1');
    assert.match(textOf(out), /Imported 250 item\(s\) into "X"/);
  });

  it('normalizes a spotify:playlist: URI target', async () => {
    const h = harness((path) =>
      path.startsWith('POST ') ? {} : path === '/playlists/pl1' ? { id: 'pl1', name: 'N' } : null,
    );
    await h.invoke('import_playlist', {
      playlist_id: 'spotify:playlist:pl1',
      content: 'spotify:track:a',
    });
    assert.ok(h.client.calls.some((c) => c.path === '/playlists/pl1/items'));
  });
});

// ---------------------------------------------------------------------------
// File source
// ---------------------------------------------------------------------------

describe('import_playlist file source', () => {
  it('reads the document from input_path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spotify-import-'));
    try {
      const file = join(dir, 'playlist.m3u');
      await writeFile(file, '#EXTM3U\nspotify:track:f1\n', 'utf8');
      const h = harness(playlistResponder());
      const out = await h.invoke('import_playlist', {
        playlist_id: 'pl1',
        input_path: file,
        dry_run: true,
      });
      const p = out.structuredContent as { parsed_uris: number };
      assert.equal(p.parsed_uris, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
