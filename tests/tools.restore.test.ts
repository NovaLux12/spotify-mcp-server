/**
 * Tests for src/tools/restore.ts (#160 — restore_library_snapshot).
 *
 * Focus: STRICTLY ADDITIVE guarantees. Every mutating scenario asserts not
 * only what WAS written but that nothing pre-existing was touched.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { registerRestoreTools } from '../src/tools/restore.js';
import type { LibrarySnapshot } from '../src/tools/restore.js';
import type { SpotifyClient } from '../src/client.js';

// ---------------------------------------------------------------------------
// Stub plumbing (mirrors tests/tools.saveddedupe.test.ts)
// ---------------------------------------------------------------------------

interface Call {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  params?: Record<string, string>;
  body?: unknown;
}

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

/** Mutable stand-in for the live account the restore writes into. */
interface LiveState {
  savedUris: string[];
  followedArtistIds: string[];
  playlists: Array<{ id: string; name: string }>;
}

function makeClient(state: LiveState) {
  const calls: Call[] = [];
  const client = {
    calls,
    async get(_path: string, params?: Record<string, string>) {
      calls.push({ method: 'GET', path: _path, params });
      if (_path === '/me/library/contains') {
        const uris = (params?.uris ?? '').split(',').filter(Boolean);
        return uris.map((u) => state.savedUris.includes(u));
      }
      if (_path === '/me/following/contains') {
        const ids = (params?.ids ?? '').split(',').filter(Boolean);
        return ids.map((id) => state.followedArtistIds.includes(id));
      }
      return null;
    },
    async getAllPages<T>(_path: string, _params?: Record<string, string>): Promise<T[]> {
      calls.push({ method: 'GET', path: `${_path} (paged)` });
      if (_path === '/me/playlists') {
        return state.playlists.map((p) => ({ ...p })) as T[];
      }
      return [] as T[];
    },
    async post(_path: string, body?: unknown) {
      calls.push({ method: 'POST', path: _path, body });
      if (_path === '/me/playlists') {
        const id = `pl_restored_${state.playlists.length + 1}`;
        state.playlists.push({ id, name: (body as { name: string }).name });
        return { id };
      }
      return {};
    },
    async put(_path: string, body?: unknown) {
      calls.push({ method: 'PUT', path: _path, body });
      return null;
    },
    async delete(_path: string, body?: unknown) {
      calls.push({ method: 'DELETE', path: _path, body });
      return null;
    },
  };
  return client;
}

type ElicitVerdict = 'accept' | 'decline' | 'unsupported';

function harness(state: LiveState, elicit: ElicitVerdict = 'unsupported') {
  const registered: RegisteredTool[] = [];
  const base = {
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
  };
  const fakeServer =
    elicit === 'unsupported'
      ? base
      : {
          ...base,
          server: {
            getClientCapabilities: () => ({ elicitation: {} }),
            elicitInput: async () =>
              elicit === 'accept'
                ? { action: 'accept', content: { confirm: true } }
                : { action: 'decline' },
          },
        };
  const client = makeClient(state);
  registerRestoreTools(fakeServer as unknown as McpServer, client as unknown as SpotifyClient);
  return {
    registered,
    client,
    state,
    invoke: async (name: string, args: Record<string, unknown> = {}) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

const textOf = (out: { content: Array<{ text: string }> }) => out.content[0].text;

const writesOf = (client: { calls: Call[] }) =>
  client.calls.filter((c) => c.method === 'PUT' || c.method === 'POST');
// Snapshot fixtures
// ---------------------------------------------------------------------------

async function snapshotFile(snapshot: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'spotify-restore-test-'));
  const path = join(dir, 'snapshot.json');
  await writeFile(path, JSON.stringify(snapshot), 'utf8');
  return path;
}

async function rawFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'spotify-restore-test-'));
  const path = join(dir, 'snapshot.json');
  await writeFile(path, contents, 'utf8');
  return path;
}

const CREATED = '2026-08-26T10:00:00.000Z';

function baseSnapshot(): LibrarySnapshot {
  return {
    _meta: { created: CREATED, counts: {} },
    liked_tracks: [
      { uri: 'spotify:track:have1', name: 'Have One', added_at: '2025-01-01' },
      { uri: 'spotify:track:missing1', name: 'Missing One', added_at: '2025-01-02' },
    ],
    saved_albums: [{ uri: 'spotify:album:albmissing', name: 'Missing Album' }],
    followed_artists: [
      { uri: 'spotify:artist:followed1', name: 'Already Followed' },
      { uri: 'spotify:artist:newartist1', name: 'New Artist' },
    ],
    playlists: [
      {
        uri: 'spotify:playlist:snapgone',
        name: 'Gone Playlist',
        item_count: 2,
        items: [
          { uri: 'spotify:track:p1', name: 'P1' },
          { uri: 'spotify:track:p2', name: 'P2' },
        ],
      },
    ],
  };
}

function emptyState(): LiveState {
  return { savedUris: [], followedArtistIds: [], playlists: [] };
}

// ---------------------------------------------------------------------------
// Registration + defaults
// ---------------------------------------------------------------------------

describe('restore_library_snapshot registration', () => {
  it('registers the tool with defaults: dry_run true, all categories', async () => {
    const h = harness(emptyState());
    const tool = h.registered.find((t) => t.name === 'restore_library_snapshot');
    assert.ok(tool, 'tool should be registered');
    const parsed = tool.validate({ backup_path: '/tmp/x.json' });
    assert.equal(parsed.dry_run, true);
    assert.equal((parsed.categories as string[]).length, 7);
    assert.match(tool.description, /STRICTLY ADDITIVE/);
  });
});

// ---------------------------------------------------------------------------
// dry_run (default): read-only plan, zero mutations
// ---------------------------------------------------------------------------

describe('restore_library_snapshot dry run', () => {
  it('default invocation performs zero mutating calls', async () => {
    const state = emptyState();
    state.savedUris = ['spotify:track:have1'];
    const path = await snapshotFile(baseSnapshot());
    try {
      const h = harness(state);
      const out = await h.invoke('restore_library_snapshot', { backup_path: path });

      assert.equal(writesOf(h.client).length, 0, 'no PUT/POST in dry run');
      assert.ok(h.client.calls.some((c) => c.path.startsWith('/me/library/contains')));
      assert.match(textOf(out), /DRY RUN/);
      const payload = out.structuredContent as Record<string, any>;
      assert.equal(payload.status, 'planned');
      assert.equal(payload.categories.liked_tracks.planned, 1);
      assert.equal(payload.categories.liked_tracks.already_present, 1);
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Strictly additive playlist behaviour
// ---------------------------------------------------------------------------

describe('restore_library_snapshot strictly additive', () => {
  it('creates missing playlists under Restored · name, skips same-name untouched', async () => {
    const state = emptyState();
    state.savedUris = ['spotify:track:have1'];
    state.followedArtistIds = ['followed1'];
    state.playlists = [{ id: 'pl_existing', name: 'Gone Playlist' }];
    const snap = baseSnapshot();
    // 150 items proves ≤100 chunking on add-items.
    snap.playlists = [
      {
        name: 'Big One',
        item_count: 150,
        items: Array.from({ length: 150 }, (_, i) => ({
          uri: `spotify:track:big${i}`,
          name: `Big ${i}`,
        })),
      },
      { name: 'Gone Playlist', items: [{ uri: 'spotify:track:x', name: 'X' }] },
    ];
    const path = await snapshotFile(snap);
    try {
      const h = harness(state, 'accept');
      const out = await h.invoke('restore_library_snapshot', {
        backup_path: path,
        dry_run: false,
      });

      const creates = h.client.calls.filter(
        (c) => c.method === 'POST' && c.path === '/me/playlists',
      );
      assert.equal(creates.length, 1, 'exactly one playlist create');
      assert.equal(
        (creates[0].body as { name: string }).name,
        `Restored · Big One (${CREATED.slice(0, 10)})`,
      );
      const adds = h.client.calls.filter(
        (c) => c.method === 'POST' && c.path.startsWith('/playlists/pl_restored_'),
      );
      assert.equal(adds.length, 2, 'items added in ≤100 chunks');
      assert.deepEqual(
        adds.map((a) => (a.body as { uris: string[] }).uris.length),
        [100, 50],
      );
      assert.equal(
        h.client.calls.some((c) => c.path.startsWith('/playlists/pl_existing')),
        false,
        'existing same-name playlist never written into',
      );

      const payload = out.structuredContent as Record<string, any>;
      assert.equal(payload.status, 'executed');
      assert.deepEqual(payload.playlists.skipped_existing, ['Gone Playlist']);
      assert.equal(payload.playlists.created[0].restored_as.startsWith('Restored · '), true);
      assert.match(textOf(out), /skipped existing playlist "Gone Playlist"/);
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('reports a capped playlist shortfall in dry run and never plans its creation', async () => {
    const snap = baseSnapshot();
    snap._meta = {
      ...snap._meta,
      snapshot_state: 'partial',
      complete: false,
      partial_reason: 'collection_cap_reached:playlists',
      partial_reasons: ['collection_cap_reached:playlists'],
    };
    snap.playlists = [{
      name: 'Capped Playlist',
      item_count: 600,
      items: Array.from({ length: 500 }, (_, i) => ({
        uri: `spotify:track:capped${i}`,
        name: `Capped ${i}`,
      })),
      items_truncated: true,
    }];
    const path = await snapshotFile(snap);
    try {
      const h = harness(emptyState());
      const out = await h.invoke('restore_library_snapshot', {
        backup_path: path,
        categories: ['playlists'],
      });
      const payload = out.structuredContent as Record<string, any>;
      assert.equal(payload.snapshot_state, 'partial');
      assert.equal(payload.restorable_complete, false);
      assert.equal(payload.playlists.created.length, 0);
      assert.match(payload.shortfalls.join(' '), /Capped Playlist: stored 500 of 600 items/);
      assert.match(textOf(out), /Snapshot completeness: partial/);
      assert.equal(writesOf(h.client).length, 0);
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('refuses a partial snapshot before confirmation or any write', async () => {
    const snap = baseSnapshot();
    snap._meta = {
      ...snap._meta,
      snapshot_state: 'partial',
      complete: false,
      partial_reason: 'quota_exceeded',
      partial_reasons: ['quota_exceeded'],
    };
    const path = await snapshotFile(snap);
    try {
      const h = harness(emptyState(), 'accept');
      await assert.rejects(
        h.invoke('restore_library_snapshot', { backup_path: path, dry_run: false }),
        /Refusing to restore incomplete snapshot.*quota_exceeded/,
      );
      assert.equal(writesOf(h.client).length, 0);
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('chunk-checks at 50, writes at 40, and saves only absent URIs', async () => {
    const state = emptyState();
    const present = new Set(['spotify:track:present0', 'spotify:track:present75']);
    state.savedUris = [...present];
    const rows = Array.from({ length: 120 }, (_, i) => ({
      uri: `spotify:track:${i < 100 && i % 50 === 0 ? 'present' : 'absent'}${i}`,
      name: `Track ${i}`,
    }));
    // Deterministic present set: indices 0 and 75.
    rows[0] = { uri: 'spotify:track:present0', name: 'Track 0' };
    rows[75] = { uri: 'spotify:track:present75', name: 'Track 75' };
    const path = await snapshotFile({
      _meta: { created: CREATED },
      liked_tracks: rows,
    });
    try {
      const h = harness(state, 'accept');
      await h.invoke('restore_library_snapshot', {
        backup_path: path,
        dry_run: false,
        categories: ['liked_tracks'],
      });

      const checks = h.client.calls.filter(
        (c) => c.method === 'GET' && c.path === '/me/library/contains',
      );
      assert.equal(checks.length, 3, '120 uris checked in 3 ≤50 chunks');
      for (const c of checks) {
        assert.ok(
          ((c.params?.uris ?? '').split(',').filter(Boolean)).length <= 50,
          'contains chunk ≤50',
        );
      }
      const puts = h.client.calls.filter(
        (c) => c.method === 'PUT' && c.path.startsWith('/me/library?'),
      );
      assert.equal(puts.length, 3, '118 absent uris saved in ≤40 chunks (40/40/38)');
      for (const p of puts) {
        const urisInRequest = new URLSearchParams(p.path.split('?')[1] ?? '').get('uris');
        assert.ok(urisInRequest !== null, 'library write must carry a uris query param');
        assert.ok(
          urisInRequest.split(',').filter(Boolean).length <= 40,
          'library write chunk ≤40',
        );
        // The request must be the request the plan printed: values percent-encoded.
        assert.equal(p.path.includes('spotify:track:'), false, 'URI values must be percent-encoded');
      }
      const savedUris = puts.flatMap((p) =>
        (new URLSearchParams(p.path.split('?')[1] ?? '').get('uris') ?? '').split(',').filter(Boolean),
      );
      assert.equal(savedUris.length, 118);
      for (const uri of savedUris) {
        assert.equal(present.has(uri), false, `already-present ${uri} never re-saved`);
      }
      assert.equal(state.savedUris.length, 2, 'stub state untouched by design');
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('follows only unfollowed artists', async () => {
    const state = emptyState();
    state.followedArtistIds = ['have1'];
    const path = await snapshotFile({
      _meta: { created: CREATED },
      followed_artists: [
        { uri: 'spotify:artist:have1', name: 'Have' },
        { uri: 'spotify:artist:new1', name: 'New' },
        { uri: 'spotify:track:notanartist', name: 'Bad' },
      ],
    });
    try {
      const h = harness(state, 'accept');
      const out = await h.invoke('restore_library_snapshot', {
        backup_path: path,
        dry_run: false,
        categories: ['followed_artists'],
      });
      const puts = h.client.calls.filter(
        (c) => c.method === 'PUT' && c.path.startsWith('/me/following?'),
      );
      assert.deepEqual(
        puts.map((p) => {
          const params = new URLSearchParams(p.path.split('?')[1] ?? '');
          return `${p.path.split('?')[0]}?type=${params.get('type')}&ids=${params.get('ids')}`;
        }),
        ['/me/following?type=artist&ids=new1'],
      );
      const payload = out.structuredContent as Record<string, any>;
      assert.equal(payload.categories.followed_artists.executed, 1);
      assert.equal(payload.categories.followed_artists.skipped, 1, 'non-artist URI skipped');
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Confirmation gate
// ---------------------------------------------------------------------------

describe('restore_library_snapshot confirmation gate', () => {
  const CONFIRM_ENV = 'SPOTIFY_MCP_CONFIRM';

  it('declined confirmation cancels with zero writes', async () => {
    delete process.env[CONFIRM_ENV];
    const path = await snapshotFile(baseSnapshot());
    try {
      const h = harness(emptyState(), 'decline');
      const out = await h.invoke('restore_library_snapshot', {
        backup_path: path,
        dry_run: false,
      });
      assert.equal(writesOf(h.client).length, 0, 'zero writes after decline');
      const payload = out.structuredContent as Record<string, any>;
      assert.equal(payload.status, 'cancelled');
      assert.match(textOf(out), /cancelled/i);
    } finally {
      delete process.env[CONFIRM_ENV];
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('SPOTIFY_MCP_CONFIRM=never explicitly bypasses confirmation and permits restores', async () => {
    process.env[CONFIRM_ENV] = 'never';
    const path = await snapshotFile(baseSnapshot());
    try {
      const h = harness(emptyState(), 'unsupported');
      await h.invoke('restore_library_snapshot', { backup_path: path, dry_run: false });
      assert.ok(writesOf(h.client).length > 0, 'automation bypass should permit additive writes');
    } finally {
      delete process.env[CONFIRM_ENV];
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('environment without elicitation support refuses rather than proceeding silently', async () => {
    delete process.env[CONFIRM_ENV];
    const path = await snapshotFile(baseSnapshot());
    try {
      const h = harness(emptyState(), 'unsupported');
      await assert.rejects(
        h.invoke('restore_library_snapshot', { backup_path: path, dry_run: false }),
        /Elicitation unavailable/,
      );
      assert.equal(writesOf(h.client).length, 0);
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Category filter
// ---------------------------------------------------------------------------

describe('restore_library_snapshot category filter', () => {
  it('only touches endpoints for selected categories', async () => {
    const path = await snapshotFile(baseSnapshot());
    try {
      const h = harness(emptyState(), 'accept');
      await h.invoke('restore_library_snapshot', {
        backup_path: path,
        categories: ['saved_albums'],
      });
      const paths = h.client.calls.map((c) => c.path);
      assert.ok(paths.some((p) => p.startsWith('/me/library/contains')));
      assert.equal(paths.some((p) => p.startsWith('/me/following')), false);
      assert.equal(paths.some((p) => p.includes('/me/playlists')), false);
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Malformed snapshots
// ---------------------------------------------------------------------------

describe('restore_library_snapshot malformed snapshots', () => {
  it('invalid JSON yields a clear error naming the path', async () => {
    const path = await rawFile('{not valid json at all');
    try {
      const h = harness(emptyState());
      await assert.rejects(
        h.invoke('restore_library_snapshot', { backup_path: path }),
        (err: Error) => {
          assert.match(err.message, /Malformed snapshot at .+snapshot\.json/);
          assert.match(err.message, /not valid JSON/);
          return true;
        },
      );
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('unrecognized structure yields a clear error', async () => {
    const path = await snapshotFile({ hello: 'world' });
    try {
      const h = harness(emptyState());
      await assert.rejects(
        h.invoke('restore_library_snapshot', { backup_path: path }),
        /no recognized categories/,
      );
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('non-array category yields a clear error', async () => {
    const path = await snapshotFile({ liked_tracks: 'oops' });
    try {
      const h = harness(emptyState());
      await assert.rejects(
        h.invoke('restore_library_snapshot', { backup_path: path }),
        /'liked_tracks' must be an array/,
      );
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// JSON mode twin
// ---------------------------------------------------------------------------

describe('restore_library_snapshot json mode', () => {
  it('text payload equals structuredContent twin', async () => {
    const path = await snapshotFile(baseSnapshot());
    try {
      const h = harness(emptyState());
      const out = await h.invoke('restore_library_snapshot', {
        backup_path: path,
        response_format: 'json',
      });
      const parsedText = JSON.parse(textOf(out));
      assert.deepEqual(parsedText, out.structuredContent);
      const payload = parsedText as Record<string, any>;
      assert.equal(payload.tool, 'restore_library_snapshot');
      assert.equal(payload.snapshot_created, CREATED);
      assert.equal(payload.playlists.created[0].restored_as, `Restored · Gone Playlist (2026-08-26)`);
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// #624 — write cap, encoding, invalid rows, partial restores
// ---------------------------------------------------------------------------

describe('restore_library_snapshot write safety (#624)', () => {
  const trackSnapshot = (uris: string[]) => ({
    _meta: { created: CREATED },
    liked_tracks: uris.map((uri, i) => ({ uri, name: `Track ${i}` })),
  });

  it('chunks a 41-URI category into 2 write requests at the 40-uri cap', async () => {
    const uris = Array.from({ length: 41 }, (_, i) => `spotify:track:t${i}`);
    const path = await snapshotFile(trackSnapshot(uris));
    try {
      const h = harness(emptyState(), 'accept');
      const out = await h.invoke('restore_library_snapshot', {
        backup_path: path,
        dry_run: false,
        categories: ['liked_tracks'],
      });
      const puts = h.client.calls.filter((c) => c.method === 'PUT' && c.path.startsWith('/me/library?'));
      assert.equal(puts.length, 2, '41 uris at a 40-uri cap is 2 requests');
      const sent = puts.map(
        (p) => new URLSearchParams(p.path.split('?')[1] ?? '').get('uris') ?? '',
      );
      assert.deepEqual(sent.map((s) => s.split(',').length), [40, 1]);
      assert.deepEqual(
        sent.flatMap((s) => s.split(',')).sort(),
        [...uris].sort(),
        'every planned uri is written exactly once',
      );
      assert.equal((out.structuredContent as Record<string, any>).status, 'executed');
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('encodes every URI value so the request matches the printed plan', async () => {
    const path = await snapshotFile(trackSnapshot(['spotify:track:ok1', 'spotify:user:someone']));
    try {
      const h = harness(emptyState(), 'accept');
      const out = await h.invoke('restore_library_snapshot', {
        backup_path: path,
        dry_run: false,
        categories: ['liked_tracks'],
      });
      const put = h.client.calls.find((c) => c.method === 'PUT' && c.path.startsWith('/me/library?'));
      assert.ok(put, 'expected a library write');
      // Values are percent-encoded, so the emitted request is the planned one.
      assert.match(put.path, /uris=spotify%3Atrack%3Aok1%2Cspotify%3Auser%3Asomeone/);
      assert.deepEqual(
        (new URLSearchParams(put.path.split('?')[1] ?? '').get('uris') ?? '').split(','),
        ['spotify:track:ok1', 'spotify:user:someone'],
        'the query round-trips back to exactly the planned URIs',
      );
      const planNotes = (out.structuredContent as Record<string, any>).categories.liked_tracks.notes as string[];
      assert.ok(
        planNotes.includes('would save spotify:user:someone'),
        'the plan prints the same unencoded URI the encoded query decodes to',
      );
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('skips an invalid URI and restores the rest instead of aborting', async () => {
    const path = await snapshotFile(
      trackSnapshot(['spotify:track:ok1', 'spotify:track:a&x=1', 'spotify:track:b#frag', 'not-a-spotify-uri', 'spotify:track:ok2']),
    );
    try {
      const h = harness(emptyState(), 'accept');
      const out = await h.invoke('restore_library_snapshot', {
        backup_path: path,
        dry_run: false,
        categories: ['liked_tracks'],
      });
      const payload = out.structuredContent as Record<string, any>;
      assert.equal(payload.status, 'executed', 'a corrupt row must not abort the restore');
      assert.equal(payload.skipped_invalid, 3);
      assert.deepEqual(payload.invalid_uris, ['spotify:track:a&x=1', 'spotify:track:b#frag', 'not-a-spotify-uri']);
      assert.equal(payload.categories.liked_tracks.executed, 2);
      const put = h.client.calls.find((c) => c.method === 'PUT' && c.path.startsWith('/me/library?'));
      const written = (new URLSearchParams(put!.path.split('?')[1] ?? '').get('uris') ?? '').split(',');
      assert.deepEqual(written, ['spotify:track:ok1', 'spotify:track:ok2'], 'only well-formed uris reach the wire');
      assert.match(textOf(out), /skipped invalid snapshot URI spotify:track:a&x=1/);
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('reports a partial restore naming what landed and what did not', async () => {
    const liked = Array.from({ length: 80 }, (_, i) => `spotify:track:l${i}`);
    const path = await snapshotFile({
      _meta: { created: CREATED },
      liked_tracks: liked.map((uri, i) => ({ uri, name: `L ${i}` })),
      saved_albums: [{ uri: 'spotify:album:a1', name: 'A' }],
    });
    try {
      const h = harness(emptyState(), 'accept');
      let libraryPuts = 0;
      const realPut = h.client.put.bind(h.client);
      h.client.put = async (path: string, body?: unknown) => {
        if (path.startsWith('/me/library?') && ++libraryPuts === 2) {
          throw new Error('Spotify rejected the request');
        }
        return realPut(path, body);
      };

      const out = await h.invoke('restore_library_snapshot', {
        backup_path: path,
        dry_run: false,
        categories: ['liked_tracks', 'saved_albums'],
      });

      const payload = out.structuredContent as Record<string, any>;
      assert.equal(payload.status, 'partial_restore');
      assert.equal(payload.partial_restore, true);
      assert.equal(payload.failures.length, 1);
      const failure = payload.failures[0];
      assert.equal(failure.category, 'liked_tracks');
      assert.equal(failure.requests_completed, 1);
      assert.equal(failure.items_written, 40);
      assert.equal(failure.items_planned, 80);
      assert.equal(failure.items_pending, 40);
      // The failing category stopped, the later category still landed.
      assert.equal(payload.categories.saved_albums.executed, 1);
      assert.match(textOf(out), /Restore PARTIAL/);
      assert.match(textOf(out), /40\/80 item\(s\) landed, 40 still pending/);
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });
});
