/**
 * Tests for src/tools/import.ts: M3U/CSV parsing, format detection,
 * round-trip with export_playlist output, dedupe, batched adds, dry_run,
 * source-validation errors, and unknown-target fail-fast.
 *
 * Plus the three local-file/import-safety issues:
 *   #623 read confinement — allowed roots, regular files only, size cap.
 *   #631 metadata must not masquerade as a URI (the CSV uri column is
 *        authoritative, and the sanitised M3U round-trip stays exact).
 *   #632 idempotent import (skipped_existing), honest
 *        duplicates_in_document_skipped, elicitation before the first POST.
 */

import { describe, it, afterEach } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import type { PlaylistItemObject } from '../src/types/spotify.js';
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
/** Items the target playlist already holds, served by the getAllPages walk. */
type ExistingItems = PlaylistItemObject[];

interface HarnessOptions {
  responder?: Responder;
  /** Contents of the target playlist (the idempotency walk reads these). */
  existingItems?: ExistingItems;
  /** 'none' models a client that never advertised elicitation. */
  elicitation?: 'accept' | 'decline' | 'none';
}

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

function harness(input: Responder | HarnessOptions = () => null) {
  const options: HarnessOptions = typeof input === 'function' ? { responder: input } : input;
  const responder = options.responder ?? (() => null);
  const existing = options.existingItems ?? [];
  const elicitMode = options.elicitation ?? 'accept';
  const registered: RegisteredTool[] = [];
  // Ordered across prompts and writes so a test can assert the prompt came
  // BEFORE the first POST, not merely that both happened.
  const events: string[] = [];
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
    server: {
      getClientCapabilities: () => (elicitMode === 'none' ? {} : { elicitation: { form: {} } }),
      elicitInput: async (request: { message: string }) => {
        events.push('prompt');
        return elicitMode === 'decline' ? { action: 'decline' } : { action: 'accept', content: { confirm: true } };
      },
    },
  } as unknown as McmShim;
  const calls: RecordedCall[] = [];
  const client = {
    calls,
    async get<T>(path: string): Promise<T | null> {
      calls.push({ method: 'GET', path });
      return responder(path) as T | null;
    },
    async getAllPages<T>(path: string, _params?: unknown, opts?: { maxItems?: number }): Promise<T[]> {
      calls.push({ method: 'GET_ALL', path });
      const items = existing as unknown as T[];
      return opts?.maxItems === undefined ? items : items.slice(0, opts.maxItems);
    },
    async post<T>(path: string, body: unknown): Promise<T | null> {
      calls.push({ method: 'POST', path, arg: body });
      events.push(`POST ${path}`);
      return responder(`POST ${path}`) as T | null;
    },
  };
  registerImportTools(fakeServer, client as unknown as SpotifyClient);
  return {
    registered,
    client,
    events,
    prompts: () => events.filter((e) => e === 'prompt').length,
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
  path === `/playlists/${PLAYLIST_ID}` ? { id: PLAYLIST_ID, name } : null;

// ---------------------------------------------------------------------------
// Environment / fixture plumbing
// ---------------------------------------------------------------------------

const ROOT_ENV_KEYS = [
  'SPOTIFY_MCP_PORTABILITY_DIR',
  'SPOTIFY_MCP_BACKUP_DIR',
  'SPOTIFY_MCP_EXPORT_DIR',
  'SPOTIFY_MCP_ALLOW_PATHS',
  'SPOTIFY_MCP_MAX_DOCUMENT_MB',
  'SPOTIFY_MCP_CONFIRM',
] as const;

const savedEnv = new Map<string, string | undefined>();
for (const key of ROOT_ENV_KEYS) savedEnv.set(key, process.env[key]);

afterEach(() => {
  for (const key of ROOT_ENV_KEYS) {
    const original = savedEnv.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

/** Point every default read root at `dir`, so fixtures are inside the roots. */
function useRoots(dir: string): void {
  process.env.SPOTIFY_MCP_PORTABILITY_DIR = dir;
  process.env.SPOTIFY_MCP_BACKUP_DIR = dir;
  process.env.SPOTIFY_MCP_EXPORT_DIR = dir;
}

const execFileAsync = promisify(execFile);

const itemsOf = (uris: string[]): PlaylistItemObject[] =>
  uris.map((uri) => ({ item: { uri } }) as unknown as PlaylistItemObject);

// ---------------------------------------------------------------------------
// Parsers (pure)
// ---------------------------------------------------------------------------

// Real Spotify ids are 22 base62 characters; the shared resolver rejects anything else.
const PLAYLIST_ID = '1111111111111111111111';
const MISSING_PLAYLIST_ID = '9999999999999999999999';

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
    await assert.rejects(() => h.invoke('import_playlist', { playlist_id: PLAYLIST_ID }), /content or input_path/);
    await assert.rejects(
      () => h.invoke('import_playlist', { playlist_id: PLAYLIST_ID, content: 'x', input_path: '/tmp/x' }),
      /either content or input_path/,
    );
    assert.equal(h.client.calls.length, 0);
  });

  it('fails fast on an unknown target playlist', async () => {
    const h = harness(() => null);
    await assert.rejects(
      () => h.invoke('import_playlist', { playlist_id: MISSING_PLAYLIST_ID, content: 'spotify:track:a' }),
      /Playlist "9999999999999999999999" not found/,
    );
    assert.equal(h.posts().length, 0);
  });

  it('throws a clear error when no URIs are extractable', async () => {
    const h = harness(playlistResponder());
    await assert.rejects(
      () => h.invoke('import_playlist', { playlist_id: PLAYLIST_ID, content: '#EXTM3U\n# only comments' }),
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
      playlist_id: PLAYLIST_ID,
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
      playlist_id: PLAYLIST_ID,
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

  it('canonicalizes spotify:// links before M3U writes', async () => {
    const trackId = '1'.repeat(22);
    const episodeId = '2'.repeat(22);
    const h = harness((path) =>
      path.startsWith('POST ') ? { snapshot_id: 'snap-links' } : { id: 'pl1', name: 'X' },
    );
    await h.invoke('import_playlist', {
      playlist_id: PLAYLIST_ID,
      content: [
        '#EXTM3U',
        `spotify://track/${trackId}`,
        `spotify://episode/${episodeId}`,
      ].join('\n'),
    });
    assert.deepEqual(h.posts()[0]?.arg, {
      uris: [`spotify:track:${trackId}`, `spotify:episode:${episodeId}`],
    });
  });

  it('deduplicates equivalent canonical URI spellings', async () => {
    const trackId = '5'.repeat(22);
    const h = harness((path) =>
      path.startsWith('POST ') ? { snapshot_id: 'snap-dedupe' } : { id: 'pl1', name: 'X' },
    );
    const out = await h.invoke('import_playlist', {
      playlist_id: PLAYLIST_ID,
      content: [`spotify:track:${trackId}`, `spotify://track/${trackId}`].join('\n'),
    });
    assert.deepEqual(h.posts()[0]?.arg, { uris: [`spotify:track:${trackId}`] });
    const payload = out.structuredContent as { added: number; duplicates_in_document_skipped: number };
    assert.equal(payload.added, 1);
    assert.equal(payload.duplicates_in_document_skipped, 1);
  });

  it('canonicalizes spotify:// links before CSV writes', async () => {
    const trackId = '3'.repeat(22);
    const episodeId = '4'.repeat(22);
    const h = harness((path) =>
      path.startsWith('POST ') ? { snapshot_id: 'snap-links' } : { id: 'pl1', name: 'X' },
    );
    await h.invoke('import_playlist', {
      playlist_id: PLAYLIST_ID,
      content: [
        'track_no,title,uri',
        `1,Track,spotify://track/${trackId}`,
        `2,Episode,spotify://episode/${episodeId}`,
      ].join('\n'),
    });
    assert.deepEqual(h.posts()[0]?.arg, {
      uris: [`spotify:track:${trackId}`, `spotify:episode:${episodeId}`],
    });
  });

  it('normalizes a spotify:playlist: URI target', async () => {
    const h = harness((path) =>
      path.startsWith('POST ') ? {} : path === `/playlists/${PLAYLIST_ID}` ? { id: PLAYLIST_ID, name: 'N' } : null,
    );
    await h.invoke('import_playlist', {
      playlist_id: `spotify:playlist:${PLAYLIST_ID}`,
      content: 'spotify:track:a',
    });
    assert.ok(h.client.calls.some((c) => c.path === `/playlists/${PLAYLIST_ID}/items`));
  });
});

// ---------------------------------------------------------------------------
// File source
// ---------------------------------------------------------------------------

describe('import_playlist file source', () => {
  it('reads the document from input_path inside the allowed roots', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spotify-import-'));
    useRoots(dir);
    try {
      const file = join(dir, 'playlist.m3u');
      await writeFile(file, '#EXTM3U\nspotify:track:f1\n', 'utf8');
      const h = harness(playlistResponder());
      const out = await h.invoke('import_playlist', {
        playlist_id: PLAYLIST_ID,
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

// ---------------------------------------------------------------------------
// #623 — read confinement: allowed roots, regular files, size cap
// ---------------------------------------------------------------------------

describe('import_playlist read confinement (#623)', () => {
  const realId = 'a'.repeat(22);

  it('refuses /etc/passwd and names the allowed roots, without any network call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spotify-roots-'));
    useRoots(dir);
    try {
      const h = harness(playlistResponder());
      await assert.rejects(
        () => h.invoke('import_playlist', { playlist_id: PLAYLIST_ID, input_path: '/etc/passwd' }),
        (error: Error) => {
          assert.match(error.message, /refusing to read outside the allowed read roots/);
          assert.ok(
            error.message.includes(dir),
            `refusal must name the allowed root, got: ${error.message}`,
          );
          return true;
        },
      );
      // The probe is refused outright — the file is never opened and the
      // playlist is never even looked up.
      assert.equal(h.client.calls.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses an existing file reached through a .. escape', async () => {
    const base = await mkdtemp(join(tmpdir(), 'spotify-escape-'));
    const root = join(base, 'root');
    useRoots(root);
    try {
      await mkdir(root);
      const secret = join(base, 'secret.m3u');
      await writeFile(secret, `#EXTM3U\nspotify:track:${realId}\n`, 'utf8');
      const h = harness(playlistResponder());
      await assert.rejects(
        () =>
          h.invoke('import_playlist', {
            playlist_id: PLAYLIST_ID,
            input_path: join(root, '..', 'secret.m3u'),
          }),
        /refusing to read outside the allowed read roots/,
      );
      assert.equal(h.client.calls.length, 0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('refuses a directory inside the roots instead of failing with EISDIR', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spotify-dir-'));
    useRoots(dir);
    try {
      const h = harness(playlistResponder());
      await assert.rejects(
        () => h.invoke('import_playlist', { playlist_id: PLAYLIST_ID, input_path: dir }),
        (error: Error) => {
          assert.match(error.message, /is a directory, not a regular file/);
          return true;
        },
      );
      assert.equal(h.client.calls.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a FIFO instead of blocking the server on its first read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spotify-fifo-'));
    useRoots(dir);
    try {
      const fifo = join(dir, 'pipe.m3u');
      await execFileAsync('mkfifo', [fifo]);
      const h = harness(playlistResponder());
      // No writer is ever attached: if the tool opened the FIFO this call
      // would hang until the test timeout instead of returning.
      await assert.rejects(
        () => h.invoke('import_playlist', { playlist_id: PLAYLIST_ID, input_path: fifo }),
        /is a FIFO, not a regular file/,
      );
      assert.equal(h.client.calls.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a document over the size cap and reports the limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spotify-big-'));
    useRoots(dir);
    process.env.SPOTIFY_MCP_MAX_DOCUMENT_MB = '1';
    try {
      const file = join(dir, 'huge.m3u');
      // 1.5 MB of valid document lines — the cap must stop it before parsing.
      await writeFile(file, `#EXTM3U\n${'spotify:track:aaaaaaaaaaaaaaaaaaaaaa\n'.repeat(40_000)}`, 'utf8');
      const h = harness(playlistResponder());
      await assert.rejects(
        () => h.invoke('import_playlist', { playlist_id: PLAYLIST_ID, input_path: file }),
        (error: Error) => {
          assert.match(error.message, /refusing to read \d+ bytes/);
          assert.match(error.message, /1048576-byte document limit/);
          assert.match(error.message, /SPOTIFY_MCP_MAX_DOCUMENT_MB/);
          return true;
        },
      );
      assert.equal(h.client.calls.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects inline content over the size cap at the schema, naming the limit', async () => {
    process.env.SPOTIFY_MCP_MAX_DOCUMENT_MB = '1';
    const h = harness(playlistResponder());
    await assert.rejects(
      () =>
        h.invoke('import_playlist', {
          playlist_id: PLAYLIST_ID,
          content: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa\n'.repeat(40_000),
        }),
      /over the 1048576-byte document limit/,
    );
    assert.equal(h.client.calls.length, 0);
  });

  it('reads a file from a directory opted in through SPOTIFY_MCP_ALLOW_PATHS', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spotify-root-a-'));
    const extra = await mkdtemp(join(tmpdir(), 'spotify-root-b-'));
    useRoots(root);
    process.env.SPOTIFY_MCP_ALLOW_PATHS = extra;
    try {
      const file = join(extra, 'opted-in.m3u');
      await writeFile(file, `#EXTM3U\nspotify:track:${realId}\n`, 'utf8');
      const h = harness(playlistResponder());
      const out = await h.invoke('import_playlist', {
        playlist_id: PLAYLIST_ID,
        input_path: file,
        dry_run: true,
      });
      assert.equal((out.structuredContent as { parsed_uris: number }).parsed_uris, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(extra, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// #631 — metadata must not masquerade as a URI
// ---------------------------------------------------------------------------

describe('import_playlist metadata cannot masquerade as a URI (#631)', () => {
  const realUri = `spotify:track:${'a'.repeat(22)}`;
  const hijackUri = `spotify:track:${'0'.repeat(22)}`;

  it('a CSV title that looks like a URI does not replace the row uri column', () => {
    const doc = [
      'track_no,title,artists,album,duration_ms,uri',
      `1,${hijackUri},Duo,Album X,200000,${realUri}`,
      '2,Tune,Trio,Album Y,180000,spotify:track:bbbbbbbbbbbbbbbbbbbbbb',
    ].join('\n');
    const parsed = parseCsv(doc);
    assert.deepEqual(parsed.uris, [realUri, 'spotify:track:bbbbbbbbbbbbbbbbbbbbbb']);
  });

  it('a headerless CSV row takes the last URI-shaped field, not the first', () => {
    const parsed = parseCsv([`1,${hijackUri},Duo,200000,${realUri}`].join('\n'));
    assert.deepEqual(parsed.uris, [realUri]);
  });

  it('round-trips the sanitised M3U a newline-injecting title used to break', () => {
    // What the exporter now emits for the title `Line\nspotify:track:<0s>`:
    // the newline is collapsed INSIDE the #EXTINF metadata, so the document
    // holds exactly one URI line and the parser extracts exactly that one.
    const sanitised = [
      '#EXTM3U',
      `#EXTINF:200,Evil - Line ${hijackUri}`,
      realUri,
      '',
    ].join('\n');
    const parsed = parseM3u(sanitised);
    assert.deepEqual(parsed.uris, [realUri]);
    assert.equal(parsed.uri_occurrences, 1);
  });

  it('never POSTs a URI lifted out of CSV metadata', async () => {
    const csv = [
      'track_no,title,artists,album,duration_ms,uri',
      `1,${hijackUri},Duo,Album X,200000,${realUri}`,
    ].join('\n');
    const h = harness((path) => (path.startsWith('POST ') ? {} : { id: 'pl1', name: 'X' }));
    await h.invoke('import_playlist', { playlist_id: PLAYLIST_ID, content: csv });
    assert.deepEqual(h.posts()[0]?.arg, { uris: [realUri] });
  });
});

// ---------------------------------------------------------------------------
// #632 — idempotency, honest duplicate count, elicitation gate
// ---------------------------------------------------------------------------

describe('import_playlist idempotency (#632)', () => {
  const u1 = 'spotify:track:1111111111111111111111';
  const u2 = 'spotify:track:2222222222222222222222';
  const u3 = 'spotify:track:3333333333333333333333';

  it('a second import of the same document adds nothing and reports skipped_existing', async () => {
    const doc = `${u1}\n${u2}\n${u3}\n`;
    // The playlist already holds everything the document names — the state a
    // re-run after a partial failure lands in.
    const h = harness({ responder: playlistResponder('Re-run'), existingItems: itemsOf([u1, u2, u3]) });
    const out = await h.invoke('import_playlist', { playlist_id: PLAYLIST_ID, content: doc });
    assert.equal(h.posts().length, 0);
    const p = out.structuredContent as { added: number; skipped_existing: number; batches_sent: number };
    assert.equal(p.added, 0);
    assert.equal(p.skipped_existing, 3);
    assert.equal(p.batches_sent, 0);
    assert.match(textOf(out), /already in "Re-run" — nothing added/);
  });

  it('adds only the URIs the playlist is missing', async () => {
    const h = harness({
      responder: (path) => (path.startsWith('POST ') ? { snapshot_id: 'snap-2' } : { id: 'pl1', name: 'X' }),
      existingItems: itemsOf([u1, u2]),
    });
    const out = await h.invoke('import_playlist', { playlist_id: PLAYLIST_ID, content: `${u1}\n${u2}\n${u3}\n` });
    assert.deepEqual(h.posts()[0]?.arg, { uris: [u3] });
    const p = out.structuredContent as { added: number; skipped_existing: number };
    assert.equal(p.added, 1);
    assert.equal(p.skipped_existing, 2);
  });

  it('dry_run reports what is already present without writing', async () => {
    const h = harness({ responder: playlistResponder(), existingItems: itemsOf([u1]) });
    const out = await h.invoke('import_playlist', {
      playlist_id: PLAYLIST_ID,
      content: `${u1}\n${u2}\n`,
      dry_run: true,
    });
    assert.equal(h.posts().length, 0);
    const p = out.structuredContent as { skipped_existing: number; added?: number };
    assert.equal(p.skipped_existing, 1);
    assert.equal(p.added, undefined);
    assert.match(textOf(out), /Would append 1 .*\(1 already present\)/);
  });

  it('counts in-document duplicates from the parse pass, never negative (URI in a later CSV column)', async () => {
    const csv = [
      'track_no,title,artists,duration_ms,uri',
      `1,First,Duo,200000,${u1}`,
      `2,Again,Trio,180000,${u1}`,
      `3,Second,Trio,180000,${u2}`,
    ].join('\n');
    const h = harness(playlistResponder());
    const out = await h.invoke('import_playlist', { playlist_id: PLAYLIST_ID, content: csv });
    const p = out.structuredContent as { duplicates_in_document_skipped: number; added: number };
    assert.ok(p.duplicates_in_document_skipped >= 0, 'the reported duplicate count must never be negative');
    assert.equal(p.duplicates_in_document_skipped, 1);
    assert.equal(p.added, 2);
  });

  it('prompts before the first POST on a large import', async () => {
    const uris = Array.from({ length: 150 }, (_, i) => `spotify:track:t${i}`);
    const h = harness(playlistResponder());
    await h.invoke('import_playlist', { playlist_id: PLAYLIST_ID, content: uris.join('\n') });
    assert.equal(h.prompts(), 1);
    assert.equal(h.events[0], 'prompt', 'the confirmation must precede every write');
    assert.equal(h.posts().length, 2);
  });

  it('writes nothing when the confirmation is declined', async () => {
    const uris = Array.from({ length: 150 }, (_, i) => `spotify:track:t${i}`);
    const h = harness({ responder: playlistResponder(), elicitation: 'decline' });
    const out = await h.invoke('import_playlist', { playlist_id: PLAYLIST_ID, content: uris.join('\n') });
    assert.equal(h.posts().length, 0);
    assert.equal((out.structuredContent as { ok: boolean; cancelled: boolean }).cancelled, true);
  });

  it('refuses a large import from a client that cannot be prompted, unless confirmation is disabled', async () => {
    const uris = Array.from({ length: 150 }, (_, i) => `spotify:track:t${i}`);
    const silent = harness({ responder: playlistResponder(), elicitation: 'none' });
    const refused = await silent.invoke('import_playlist', { playlist_id: PLAYLIST_ID, content: uris.join('\n') });
    assert.equal(silent.posts().length, 0);
    const payload = refused.structuredContent as { cancelled: boolean; reason?: string };
    assert.equal(payload.cancelled, true);
    assert.equal(payload.reason, 'confirmation_unavailable');

    process.env.SPOTIFY_MCP_CONFIRM = 'never';
    const optedOut = harness({ responder: playlistResponder(), elicitation: 'none' });
    await optedOut.invoke('import_playlist', { playlist_id: PLAYLIST_ID, content: uris.join('\n') });
    assert.equal(optedOut.posts().length, 2);
  });

  it('small imports are not gated', async () => {
    const h = harness(playlistResponder());
    await h.invoke('import_playlist', { playlist_id: PLAYLIST_ID, content: `${u1}\n${u2}\n` });
    assert.equal(h.prompts(), 0);
    assert.equal(h.posts().length, 1);
  });
});
