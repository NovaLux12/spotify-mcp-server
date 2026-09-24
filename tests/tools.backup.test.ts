/**
 * Tests for src/tools/backup.ts (#159): library snapshots into timestamped
 * local JSON sidecars under SPOTIFY_MCP_BACKUP_DIR, plus the newest-first
 * inventory. Real tmpdir, stub SpotifyClient; every walk is observable as a
 * recorded GET.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { initConfig, getConfig } from '../src/config.js';
import {
  registerBackupTools,
  backupDir,
  collectSnapshot,
  type LibraryBackup,
} from '../src/tools/backup.js';

// ---------------------------------------------------------------------------
// Stub plumbing (mirrors tests/tools.scenes.test.ts)
// ---------------------------------------------------------------------------

interface RecordedCall {
  method: string;
  path: string;
  arg?: unknown;
}

type Responder = (path: string, params: Record<string, string> | undefined) => unknown;

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

function makeStubClient(responder: Responder = () => null) {
  const calls: RecordedCall[] = [];
  let respond: Responder = responder;
  const client = {
    calls,
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      calls.push({ method: 'GET', path, arg: params });
      return respond(path, params) as T | null;
    },
  };
  return client;
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
  } as unknown as McpServer;
  const client = makeStubClient(responder);
  registerBackupTools(fakeServer, client as unknown as SpotifyClient);
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
// Fixtures
// ---------------------------------------------------------------------------

/** Offset-paged fixture generator: `rows` served 2-per-page, then stops. */
function offsetPages(path: string, rows: unknown[]) {
  return (params?: Record<string, string>) => {
    const offset = Number(params?.offset ?? 0);
    const page = rows.slice(offset, offset + 2);
    const next = offset + 2 < rows.length ? `${path}?next` : null;
    return { items: page, total: rows.length, limit: 2, offset, next };
  };
}

function savedRow(key: string, i: number) {
  return {
    added_at: `2024-01-0${(i % 9) + 1}T00:00:00Z`,
    [key]: { uri: `spotify:${key}:id${i}`, name: `${key} ${i}` },
  };
}

/** Full library fixture: 5 of each saved category, 3 artists, 2 playlists. */
const responders: Record<string, ReturnType<Responder>> = {
  '/me/tracks': offsetPages('/me/tracks', [0, 1, 2, 3, 4].map((i) => savedRow('track', i))),
  '/me/albums': offsetPages('/me/albums', [0, 1, 2, 3, 4].map((i) => savedRow('album', i))),
  '/me/shows': offsetPages('/me/shows', [0, 1, 2, 3, 4].map((i) => savedRow('show', i))),
  '/me/episodes': offsetPages('/me/episodes', [0, 1, 2, 3, 4].map((i) => savedRow('episode', i))),
  '/me/audiobooks': offsetPages('/me/audiobooks', [0, 1, 2, 3, 4].map((i) => savedRow('audiobook', i))),
};

function baseResponder(path: string, params?: Record<string, string>): unknown {
  if (responders[path]) return responders[path]!(params);
  if (path === '/me/following') {
    return {
      artists: {
        items: [
          { uri: 'spotify:artist:a1', name: 'Artist One' },
          { uri: 'spotify:artist:a2', name: 'Artist Two' },
          { uri: 'spotify:artist:a3', name: 'Artist Three' },
        ],
        cursors: { after: null },
        next: null,
        total: 3,
      },
    };
  }
  if (path === '/me/playlists') {
    return {
      items: [
        {
          id: 'p1',
          name: 'Playlist One',
          uri: 'spotify:playlist:p1',
          items: { total: 3 },
        },
        {
          id: 'p2',
          name: 'Playlist Two',
          uri: 'spotify:playlist:p2',
          items: { total: 2 },
        },
      ],
      total: 2,
      limit: 50,
      offset: 0,
      next: null,
    };
  }
  if (path === '/playlists/p1/items') {
    return {
      items: [
        { added_at: '2024-02-01T00:00:00Z', item: { uri: 'spotify:track:x1', name: 'X One' } },
        // Locally-removed rows come back as null items — must be skipped.
        { added_at: '2024-02-01T00:00:00Z', item: null },
        { added_at: '2024-02-01T00:00:00Z', item: { uri: 'spotify:episode:e1', name: 'Ep One' } },
        { added_at: '2024-02-01T00:00:00Z', item: { uri: 'spotify:track:x2', name: 'X Two' } },
      ],
      total: 4,
      limit: 100,
      offset: 0,
      next: null,
    };
  }
  if (path === '/playlists/p2/items') {
    return {
      items: [
        { added_at: '2024-03-01T00:00:00Z', item: { uri: 'spotify:track:y1', name: 'Y One' } },
        { added_at: '2024-03-01T00:00:00Z', item: { uri: 'spotify:track:y2', name: 'Y Two' } },
      ],
      total: 2,
      limit: 100,
      offset: 0,
      next: null,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Env/tmpdir plumbing
// ---------------------------------------------------------------------------

let tmp: string;
let prevBackupDirEnv: string | undefined;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'spotify-backup-test-'));
  // backup_dir() reads process.env directly (same convention as
  // SPOTIFY_MCP_SCENES_FILE), so the tmpdir override goes on the environment.
  prevBackupDirEnv = process.env.SPOTIFY_MCP_BACKUP_DIR;
  process.env.SPOTIFY_MCP_BACKUP_DIR = tmp;
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
  if (prevBackupDirEnv === undefined) delete process.env.SPOTIFY_MCP_BACKUP_DIR;
  else process.env.SPOTIFY_MCP_BACKUP_DIR = prevBackupDirEnv;
  initConfig(); // restore process-wide config defaults
});

// ---------------------------------------------------------------------------

describe('backup_library', () => {
  it('snapshots every category with correct counts and round-trips through JSON.parse', async () => {
    const h = harness(baseResponder);
    const out = await h.invoke('backup_library', { response_format: 'concise' });

    const files = (await readdir(tmp)).filter((f) => /^backup-\d{4}-\d{2}-\d{2}-\d+\.json$/.test(f));
    assert.equal(files.length, 1);
    const file = join(tmp, files[0]!);

    const raw = await readFile(file, 'utf8');
    const snap = JSON.parse(raw) as LibraryBackup; // round-trip validation

    assert.equal(snap._meta.created, new Date(snap._meta.created).toISOString());
    assert.equal(snap._meta.snapshot_state, 'complete');
    assert.equal(snap._meta.complete, true);
    assert.equal(snap._meta.cap, 500);
    assert.equal(snap._meta.caps.playlist_items_per_playlist, 500);
    assert.equal(snap._meta.collections.liked_tracks.fetched, 5);
    assert.equal(snap._meta.collections.liked_tracks.cap, 500);
    assert.equal(snap._meta.collections.liked_tracks.truncated, false);
    assert.equal(snap._meta.playlist_items.truncated, false);
    assert.deepEqual(snap._meta.counts, {
      liked_tracks: 5,
      saved_albums: 5,
      saved_shows: 5,
      saved_episodes: 5,
      saved_audiobooks: 5,
      followed_artists: 3,
      playlists: 2,
      playlist_items: 5,
      playlists_truncated: 0,
    });

    // Row shapes
    assert.deepEqual(Object.keys(snap).sort(), [
      '_meta',
      'followed_artists',
      'liked_tracks',
      'playlists',
      'saved_albums',
      'saved_audiobooks',
      'saved_episodes',
      'saved_shows',
    ]);
    assert.deepEqual(snap.liked_tracks[0], {
      uri: 'spotify:track:id0',
      name: 'track 0',
      added_at: '2024-01-01T00:00:00Z',
    });
    assert.deepEqual(snap.followed_artists[0], { uri: 'spotify:artist:a1', name: 'Artist One' });

    // Playlist rows carry uri/name/item_count/items; null items skipped.
    const pl1 = snap.playlists.find((p) => p.uri === 'spotify:playlist:p1')!;
    assert.equal(pl1.name, 'Playlist One');
    assert.equal(pl1.item_count, 3); // Spotify-reported total
    assert.deepEqual(pl1.items.map((i) => i.uri), ['spotify:track:x1', 'spotify:episode:e1', 'spotify:track:x2']);
    const pl2 = snap.playlists.find((p) => p.uri === 'spotify:playlist:p2')!;
    assert.equal(pl2.item_count, 2);
    assert.equal(pl2.items.length, 2);

    // Summary prose + structuredContent twin
    assert.match(textOf(out), /Library backup written/);
    assert.match(textOf(out), new RegExp(files[0]!));
    assert.match(textOf(out), /Liked tracks: 5/);
    assert.match(textOf(out), /Playlists: 2 \(5 items; 0 truncated\)/);
    const sc = out.structuredContent as Record<string, unknown>;
    assert.equal(sc.ok, true);
    assert.equal(sc.file, file);
    assert.deepEqual(sc.counts, snap._meta.counts);
  });

  it('stores optional notes in _meta', async () => {
    const h = harness(baseResponder);
    const first = await h.invoke('backup_library', { response_format: 'concise', notes: 'before spring clean' });
    const raw = await readFile((first.structuredContent as { file: string }).file, 'utf8');
    const snap = JSON.parse(raw) as LibraryBackup;
    assert.equal(snap._meta.notes, 'before spring clean');

    const sc = (await h.invoke('backup_library', { response_format: 'concise', notes: 'second' }))
      .structuredContent as Record<string, unknown>;
    assert.equal(sc.notes, 'second');
  });

  it('writes file mode 0600 inside dir mode 0700', async () => {
    const nested = join(tmp, 'deep', 'backups');
    const prev = process.env.SPOTIFY_MCP_BACKUP_DIR;
    process.env.SPOTIFY_MCP_BACKUP_DIR = nested;
    try {
      assert.equal(backupDir(), nested);
      const h = harness(baseResponder);
      await h.invoke('backup_library', { response_format: 'concise' });

      const stDir = await stat(nested);
      assert.equal(stDir.mode & 0o777, 0o700);
      const files = await readdir(nested);
      const snapshotName = files.find((name) => /^backup-.*\.json$/.test(name) && !name.endsWith('.meta.json'))!;
      const sidecarName = files.find((name) => name.endsWith('.meta.json'))!;
      assert.equal((await stat(join(nested, snapshotName))).mode & 0o777, 0o600);
      assert.equal((await stat(join(nested, sidecarName))).mode & 0o777, 0o600);
    } finally {
      if (prev === undefined) delete process.env.SPOTIFY_MCP_BACKUP_DIR;
      else process.env.SPOTIFY_MCP_BACKUP_DIR = prev;
    }
  });

  it('sequences multiple backups the same day without clobbering', async () => {
    const h = harness(baseResponder);
    await h.invoke('backup_library', { response_format: 'concise' });
    await h.invoke('backup_library', { response_format: 'concise' });
    const files = (await readdir(tmp)).filter((f) => /^backup-\d{4}-\d{2}-\d{2}-\d+\.json$/.test(f)).sort();
    assert.equal(files.length, 2);
    assert.notEqual(files[0], files[1]);
    const [, seqA] = /-(\d+)\.json$/.exec(files[0]!)!;
    const [, seqB] = /-(\d+)\.json$/.exec(files[1]!)!;
    assert.ok(Number(seqB) === Number(seqA) + 1, `${files[1]} should follow ${files[0]}`);
  });

  it('caps walks at SPOTIFY_MCP_FETCH_ALL_CAP and honors max_results override', async () => {
    initConfig({ SPOTIFY_MCP_FETCH_ALL_CAP: '3' });
    assert.equal(getConfig().fetchAllCap, 3);

    const direct = await collectSnapshot(
      makeStubClient(baseResponder) as unknown as SpotifyClient,
      getConfig().fetchAllCap,
    );
    assert.equal(direct.liked_tracks.length, 3); // capped from 5 fixtures

    const h = harness(baseResponder);
    const sc = (
      await h.invoke('backup_library', { response_format: 'concise' })
    ).structuredContent as Record<string, unknown>;
    assert.equal((sc.counts as Record<string, number>).liked_tracks, 3);
    // Pages are served 2-at-a-time by the fixture: cap=3 stops after offset 2.
    const trackGets = h.client.calls.filter((c) => c.path === '/me/tracks');
    assert.equal(trackGets.length, 2);
    assert.equal(trackGets.length < 3, true, 'walk must stop at the cap, not drain all pages');

    // Explicit max_results wins over the configured cap.
    const sc2 = (
      await h.invoke('backup_library', { response_format: 'concise', max_results: 2 })
    ).structuredContent as Record<string, unknown>;
    assert.equal((sc2.counts as Record<string, number>).liked_tracks, 2);
  });

  it('distinguishes exactly-at-cap from cap-plus-one collection walks', async () => {
    const exact = harness((path, params) =>
      path === '/me/tracks'
        ? offsetPages('/me/tracks', [0, 1, 2].map((i) => savedRow('track', i)))(params)
        : baseResponder(path, params),
    );
    const exactOut = await exact.invoke('backup_library', { response_format: 'json', max_results: 3 });
    const exactSnap = JSON.parse(textOf(exactOut)) as LibraryBackup;
    assert.equal(exactSnap._meta.collections.liked_tracks.fetched, 3);
    assert.equal(exactSnap._meta.collections.liked_tracks.cap, 3);
    assert.equal(exactSnap._meta.collections.liked_tracks.truncated, false);
    assert.equal(exactSnap._meta.collections.liked_tracks.complete, true);

    const over = harness((path, params) =>
      path === '/me/tracks'
        ? offsetPages('/me/tracks', [0, 1, 2, 3].map((i) => savedRow('track', i)))(params)
        : baseResponder(path, params),
    );
    const overOut = await over.invoke('backup_library', { response_format: 'json', max_results: 3 });
    const overSnap = JSON.parse(textOf(overOut)) as LibraryBackup;
    assert.equal(overSnap._meta.collections.liked_tracks.fetched, 3);
    assert.equal(overSnap._meta.collections.liked_tracks.truncated, true);
    assert.equal(overSnap._meta.collections.liked_tracks.complete, false);
    assert.equal(overSnap._meta.snapshot_state, 'partial');
  });

  it('records playlist item truncation and names the affected playlist in prose', async () => {
    const h = harness((path, params) => {
      if (path === '/me/playlists') {
        return {
          items: [{ id: 'large', name: 'Large Playlist', uri: 'spotify:playlist:large', items: { total: 600 } }],
          total: 1,
          limit: 50,
          offset: 0,
          next: null,
        };
      }
      if (path === '/playlists/large/items') {
        const offset = Number(params?.offset ?? 0);
        const size = Math.min(100, 600 - offset);
        return {
          items: Array.from({ length: size }, (_, index) => ({
            item: { uri: `spotify:track:${offset + index}`, name: `Track ${offset + index}` },
          })),
          total: 600,
          limit: 100,
          offset,
          next: offset + size < 600 ? 'next' : null,
        };
      }
      return baseResponder(path, params);
    });
    const out = await h.invoke('backup_library', { response_format: 'concise' });
    const snap = JSON.parse(await readFile((out.structuredContent as { file: string }).file, 'utf8')) as LibraryBackup;
    assert.equal(snap.playlists[0]!.items.length, 500);
    assert.equal(snap.playlists[0]!.item_count, 600);
    assert.equal(snap.playlists[0]!.items_truncated, true);
    assert.equal(snap._meta.counts.playlists_truncated, 1);
    assert.equal(snap._meta.playlist_items.truncated_playlists, 1);
    assert.equal(snap._meta.snapshot_state, 'partial');
    assert.match(textOf(out), /Large Playlist.*fetched 500 of 600 items, cap 500 — TRUNCATED/);
  });

  it('walks multi-page offset endpoints until next is null', async () => {
    const h = harness((path, params) =>
      path === '/me/playlists' ? offsetPages('/me/playlists', [
        { id: 'a', name: 'A', uri: 'spotify:playlist:a' },
        { id: 'b', name: 'B', uri: 'spotify:playlist:b' },
        { id: 'c', name: 'C', uri: 'spotify:playlist:c' },
      ])(params) : baseResponder(path, params),
    );
    const out = await h.invoke('backup_library', { response_format: 'concise' });
    const sc = out.structuredContent as Record<string, unknown>;
    assert.equal((sc.counts as Record<string, number>).playlists, 3);
    const playlistGets = h.client.calls.filter((c) => c.path === '/me/playlists');
    assert.equal(playlistGets.length, 2); // offsets 0 and 2
    assert.equal((playlistGets[1]!.arg as Record<string, string>).offset, '2');
  });

  it('cursor-walks followed artists across pages', async () => {
    let page = 0;
    const h = harness((path) => {
      if (path !== '/me/following') return baseResponder(path);
      page += 1;
      return page === 1
        ? {
            artists: {
              items: [{ uri: 'spotify:artist:c1', name: 'C1' }],
              cursors: { after: 'cursor-1' },
              next: 'next',
              total: 2,
            },
          }
        : {
            artists: {
              items: [{ uri: 'spotify:artist:c2', name: 'C2' }],
              cursors: { after: null },
              next: null,
              total: 2,
            },
          };
    });
    const out = await h.invoke('backup_library', { response_format: 'concise' });
    const sc = out.structuredContent as Record<string, unknown>;
    assert.equal((sc.counts as Record<string, number>).followed_artists, 2);
    const followGets = h.client.calls.filter((c) => c.path === '/me/following');
    assert.equal(followGets.length, 2);
    assert.equal((followGets[1]!.arg as Record<string, string>).after, 'cursor-1');
  });

  it('json mode returns the full snapshot as text with a summary twin on structuredContent', async () => {
    const h = harness(baseResponder);
    const out = await h.invoke('backup_library', { response_format: 'json' });
    const parsed = JSON.parse(textOf(out)) as LibraryBackup; // full snapshot body
    assert.ok(parsed._meta && Array.isArray(parsed.playlists));
    assert.equal(parsed._meta.counts.liked_tracks, 5);
    const sc = out.structuredContent as Record<string, unknown>;
    assert.equal(sc.ok, true);
    assert.deepEqual(sc.counts, parsed._meta.counts);
    assert.ok(!('_meta' in sc)); // twin stays summary-shaped
  });
});

describe('list_backups', () => {
  it('reports an empty dir gracefully', async () => {
    const h = harness(baseResponder);
    const out = await h.invoke('list_backups', { response_format: 'concise' });
    assert.match(textOf(out), /No backups found/);
    assert.deepEqual((out.structuredContent as Record<string, unknown>).backups, []);
  });

  it('ignores non-backup files in the dir', async () => {
    await writeFile(join(tmp, 'unrelated.json'), '{}');
    await writeFile(join(tmp, 'backup-not-a-date-1.txt'), 'x');
    const h = harness(baseResponder);
    const out = await h.invoke('list_backups', { response_format: 'concise' });
    assert.match(textOf(out), /No backups found/);
  });

  it('lists backups newest-first with size and counts from _meta', async () => {
    // Pre-seed an older backup, then take two live ones today.
    await mkdir(tmp, { recursive: true });
    const older: LibraryBackup = {
      _meta: {
        created: '2025-12-01T10:00:00.000Z',
        snapshot_state: 'complete',
        complete: true,
        partial_reasons: [],
        cap: 500,
        caps: { per_category: 500, playlist_items_per_playlist: 500 },
        collections: {
          liked_tracks: { fetched: 9, cap: 500, complete: true, truncated: false },
          saved_albums: { fetched: 0, cap: 500, complete: true, truncated: false },
          saved_shows: { fetched: 0, cap: 500, complete: true, truncated: false },
          saved_episodes: { fetched: 0, cap: 500, complete: true, truncated: false },
          saved_audiobooks: { fetched: 0, cap: 500, complete: true, truncated: false },
          followed_artists: { fetched: 1, cap: 500, complete: true, truncated: false },
          playlists: { fetched: 0, cap: 500, complete: true, truncated: false },
        },
        playlist_items: { fetched: 0, cap_per_playlist: 500, truncated: false, truncated_playlists: 0 },
        counts: {
          liked_tracks: 9,
          saved_albums: 0,
          saved_shows: 0,
          saved_episodes: 0,
          saved_audiobooks: 0,
          followed_artists: 1,
          playlists: 0,
          playlist_items: 0,
          playlists_truncated: 0,
        },
      },
      liked_tracks: [],
      saved_albums: [],
      saved_shows: [],
      saved_episodes: [],
      saved_audiobooks: [],
      followed_artists: [],
      playlists: [],
    };
    await writeFile(
      join(tmp, 'backup-2025-12-01-1.json'),
      `${JSON.stringify(older, null, 2)}\n`,
      { mode: 0o600 },
    );

    const h = harness(baseResponder);
    await h.invoke('backup_library', { response_format: 'concise' });
    await h.invoke('backup_library', { response_format: 'concise', notes: 'latest' });

    const out = await h.invoke('list_backups', { response_format: 'concise' });
    const sc = out.structuredContent as Record<string, unknown>;
    const backups = sc.backups as Array<{
      path: string;
      created: string;
      bytes: number | null;
      counts: Record<string, number> | null;
      notes?: string;
      metadata_source: string;
    }>;
    assert.equal(backups.length, 3);
    // Newest-first: both of today's snapshots precede the seeded 2025 one...
    assert.match(backups[0]!.path, /^.*backup-\d{4}-\d{2}-\d{2}-\d+\.json$/);
    assert.ok(Date.parse(backups[0]!.created) > Date.parse(backups[2]!.created));
    assert.ok(Date.parse(backups[1]!.created) > Date.parse(backups[2]!.created));
    // ...and among equals, higher sequence first.
    const seq = (b: { path: string }) => Number(/-(\d+)\.json$/.exec(b.path)![1]);
    assert.ok(seq(backups[0]) > seq(backups[1]));

    assert.equal(backups[2]!.counts!.liked_tracks, 9);
    assert.equal(backups[2]!.counts!.followed_artists, 1);
    assert.equal(backups[0]!.notes, 'latest');
    assert.equal(backups[0]!.metadata_source, 'sidecar');
    assert.equal(backups[2]!.metadata_source, 'legacy_prefix');
    assert.ok(backups.every((b) => b.bytes !== null && b.bytes > 0));

    assert.match(textOf(out), /newest first/);
    const firstIdx = textOf(out).indexOf(backups[0]!.path.split('/').pop()!);
    const lastIdx = textOf(out).indexOf(backups[2]!.path.split('/').pop()!);
    assert.ok(firstIdx !== -1 && lastIdx !== -1 && firstIdx < lastIdx);
  });


  it('lists quota partial snapshots visibly with their recorded reason', async () => {
    const partialPath = join(tmp, 'backup-2026-01-02-7.partial.json');
    const meta = {
      created: '2026-01-02T03:04:05.000Z',
      snapshot_state: 'partial',
      complete: false,
      partial_reason: 'quota_exceeded',
      partial_reasons: ['quota_exceeded'],
      counts: { liked_tracks: 0, playlists: 0, playlist_items: 0, followed_artists: 0 },
    };
    await writeFile(partialPath, `${JSON.stringify({ _meta: meta, _partial: true }, null, 2)}\n`);
    await writeFile(
      join(tmp, 'backup-2026-01-02-7.partial.meta.json'),
      `${JSON.stringify({ schema_version: 1, snapshot: partialPath, bytes: 123, meta }, null, 2)}\n`,
    );

    const out = await harness(baseResponder).invoke('list_backups', { response_format: 'concise' });
    const backups = (out.structuredContent as { backups: Array<Record<string, unknown>> }).backups;
    assert.equal(backups.length, 1);
    assert.equal(backups[0]!.partial, true);
    assert.equal(backups[0]!.complete, false);
    assert.equal(backups[0]!.snapshot_state, 'partial');
    assert.equal(backups[0]!.partial_reason, 'quota_exceeded');
    assert.match(textOf(out), /PARTIAL: quota_exceeded/);
  });

  it('uses a bounded legacy metadata prefix without parsing a multi-megabyte body', async () => {
    const legacyPath = join(tmp, 'backup-2026-01-03-1.json');
    const legacyPrefix = `${JSON.stringify({
      _meta: {
        created: '2026-01-03T00:00:00.000Z',
        counts: { liked_tracks: 7, playlists: 2, playlist_items: 9, followed_artists: 3 },
      },
    }).slice(0, -1)},\n${'"liked_tracks":[' + '0,'.repeat(5_000_000)}\n`;
    await writeFile(legacyPath, legacyPrefix);
    const out = await harness(baseResponder).invoke('list_backups', { response_format: 'json' });
    const backups = (JSON.parse(textOf(out)) as { backups: Array<Record<string, unknown>> }).backups;
    assert.equal(backups.length, 1);
    assert.equal((backups[0]!.counts as Record<string, number>).liked_tracks, 7);
    assert.equal(backups[0]!.snapshot_state, 'unknown');
  });

  it('json mode exposes the raw backups payload', async () => {
    const h = harness(baseResponder);
    await h.invoke('backup_library', { response_format: 'concise' });
    const out = await h.invoke('list_backups', { response_format: 'json' });
    const parsed = JSON.parse(textOf(out)) as Record<string, unknown>;
    assert.equal(parsed.ok, true);
    assert.equal(parsed.dir, tmp);
    assert.equal((parsed.backups as unknown[]).length, 1);
    assert.deepEqual(out.structuredContent, parsed);
  });
});

describe('backup_library dry_run + quota', () => {
  it('dry_run returns would_walk breakdown without API calls', async () => {
    let calls = 0;
    const h = harness(() => { calls++; return { items: [], total: 0, limit: 50, offset: 0, next: null }; });
    const out = await h.invoke('backup_library', { dry_run: true, max_results: 100 });
    assert.equal(calls, 0);
    const sc = out.structuredContent as Record<string, unknown>;
    assert.equal(sc.dry_run, true);
    assert.ok((sc.would_walk as Record<string, number>).tracks === 100);
    assert.ok(typeof sc.estimated_requests === 'number');
    assert.match(textOf(out), /dry run/);
  });
  it('quota 429 writes partial file and returns quota_hit', async () => {
    const { SpotifyApiError } = await import('../src/client.js');
    // make /me/tracks throw 429 so collectSnapshot fails
    const h = harness((_path) => { throw new SpotifyApiError(429, 'quota', 60); });
    const out = await h.invoke('backup_library', { max_results: 10 });
    const sc = out.structuredContent as Record<string, unknown>;
    assert.equal(sc.quota_hit, true);
    assert.equal(sc.retry_after, 60);
    assert.match(textOf(out), /Quota hit/);
    // partial file was written
    assert.ok(sc.file);
    const raw = await readFile(sc.file as string, 'utf8');
    const j = JSON.parse(raw);
    assert.equal(j.quota_hit, true);
    assert.equal(j._meta.snapshot_state, 'partial');
    assert.equal(j._meta.complete, false);
    assert.equal(j._meta.partial_reason, 'quota_exceeded');

    const list = await h.invoke('list_backups', { response_format: 'json' });
    const listed = (JSON.parse(textOf(list)) as { backups: Array<Record<string, unknown>> }).backups;
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.partial, true);
    assert.equal(listed[0]!.partial_reason, 'quota_exceeded');
  });
});
