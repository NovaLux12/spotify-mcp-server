/**
 * Tests for src/tools/restore.ts (#160 — restore_library_snapshot).
 *
 * Focus: STRICTLY ADDITIVE guarantees. Every mutating scenario asserts not
 * only what WAS written but that nothing pre-existing was touched.
 */

import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { registerRestoreTools } from '../src/tools/restore.js';
import type { LibrarySnapshot } from '../src/tools/restore.js';
import type { SpotifyClient } from '../src/client.js';
import { StubSpotifyClient } from './helpers/stub-client.js';
import type { StubCall } from './helpers/stub-client.js';
import { CHUNK_CAPS } from '../src/chunk.js';

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

/**
 * Stub offset-paging client.
 *
 * `getAllPagesWithTruncation` pages the live playlist array for real and
 * returns the same verdict the real client does (#864/#718): a walk that
 * stopped on the cap is `truncated`, and a walk that ended on a short page is
 * only `truncated` when the server's own `total` still counts more rows.
 * `getAllPages` delegates to it exactly as `SpotifyClient.getAllPages` does, so
 * a caller that asks for a bare array gets the capped one — which is the whole
 * point of #737, and why a single-page stub could never have caught it.
 *
 * `fetchAllCap` is handed to the REAL client constructor, so it reaches the
 * production walk through `this.fetchAllCap` — not through a local copy of it.
 */
function makeClient(state: LiveState, opts: { fetchAllCap?: number; containsBody?: unknown } = {}) {
  // #659: this file reimplemented `getAllPagesWithTruncation` — the verdict
  // logic for #864/#718 — behind its own `?? fetchAllCap`. Any change to the
  // real walk's cap, short-page break or reportedTotal reached no test in this
  // file. The shared stub runs the production implementation and the cap is set
  // through the constructor, which is where SPOTIFY_MCP_FETCH_ALL_CAP lands.
  const client = new StubSpotifyClient({ fetchAllCap: opts.fetchAllCap ?? 500 });
  // This file's assertions destructure a recorded call's argument as `params`
  // on a GET and `body` on a write; the shared stub records one `arg`. The
  // alias is applied to the very object the stub pushed — from inside the
  // responder, which receives that same object — so the two names cannot drift
  // from what was actually sent, and no second recorder exists to drift.
  const alias = (c: StubCall): void => {
    if (c.method === 'GET') (c as { params?: unknown }).params = c.arg;
    else (c as { body?: unknown }).body = c.arg;
  };
  // `h.client.calls` is the shared stub's own record; keep the `params`/`body`
  // aliases this file's assertions use.
  client.route('GET', /^.*$/, {
    respond: (call) => {
      alias(call);
      const params = call.arg as Record<string, string> | undefined;
      const _path = call.path;
      if (_path === '/me/library/contains') {
        // `containsBody` replaces the answer outright so a test can hand the
        // tool a body that is not one boolean per requested URI.
        if ('containsBody' in opts) return opts.containsBody as boolean[];
        // #638: one endpoint now answers for every URI type, so the stub
        // decides by the URI's own prefix — an artist URI is follow state,
        // everything else is library-saved state.
        const uris = (params?.uris ?? '').split(',').filter(Boolean);
        return uris.map((u) => (u.startsWith('spotify:artist:')
          ? state.followedArtistIds.includes(u.slice('spotify:artist:'.length))
          : state.savedUris.includes(u)));
      }
      if (_path === '/me/following/contains') {
        // Removed by the Feb 2026 changelog (#638). The read half of following
        // migrated to GET /me/library/contains; answering the old path would
        // let a regression to it pass here, so it fails as the real API does.
        throw new Error('GET /me/following/contains was removed, use GET /me/library/contains');
      }
      if (_path === '/me/playlists') {
        // Spotify's own paging shape: items[], total, limit, offset. The walk
        // that consumes it is the production one, inherited from SpotifyClient.
        const limit = Number(params?.limit ?? 50) || 50;
        const offset = Number(params?.offset ?? 0) || 0;
        return {
          items: state.playlists.slice(offset, offset + limit).map((p) => ({ ...p })),
          total: state.playlists.length,
          limit,
          offset,
        };
      }
      return null;
    },
  });
  client.route('POST', /^.*$/, {
    respond: (call) => {
      alias(call);
      if (call.path === '/me/playlists') {
        const id = `pl_restored_${state.playlists.length + 1}`;
        state.playlists.push({ id, name: (call.arg as { name: string }).name });
        return { id };
      }
      return {};
    },
  });
  client.route('PUT', /^.*$/, { respond: (call) => { alias(call); return null; } });
  client.route('DELETE', /^.*$/, { respond: (call) => { alias(call); return null; } });
  return client as unknown as SpotifyClient & { calls: Call[] };
}

type ElicitVerdict = 'accept' | 'decline' | 'unsupported';

function harness(
  state: LiveState,
  elicit: ElicitVerdict = 'unsupported',
  clientOpts: { fetchAllCap?: number; containsBody?: unknown } = {},
) {
  const registered: RegisteredTool[] = [];
  // The exact text the person is asked to authorise. #638 makes this load
  // bearing: a category the restore cannot apply has to be named at the point
  // of confirmation, not only in the plan the caller may not have read.
  const prompts: string[] = [];
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
            elicitInput: async (request: { message: string }) => {
              prompts.push(request.message);
              return elicit === 'accept'
                ? { action: 'accept', content: { confirm: true } }
                : { action: 'decline' };
            },
          },
        };
  const client = makeClient(state, clientOpts);
  registerRestoreTools(fakeServer as unknown as McpServer, client as unknown as SpotifyClient);
  return {
    registered,
    client,
    state,
    prompts,
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

/**
 * `backup_path` is a caller-supplied read, so the fixture directory has to be
 * an ALLOWED READ ROOT (#623) — exactly the opt-in an operator performs to let
 * a tool read a document from somewhere other than the server's own stores.
 * Fixtures stay under mkdtemp; nothing here touches a real data dir.
 */
function allowReadRoot(dir: string): void {
  const prev = process.env.SPOTIFY_MCP_ALLOW_PATHS;
  const next = prev ? `${prev}${delimiter}${dir}` : dir;
  process.env.SPOTIFY_MCP_ALLOW_PATHS = next;
  ALLOWED_ROOTS.push(() => {
    if (prev === undefined) delete process.env.SPOTIFY_MCP_ALLOW_PATHS;
    else process.env.SPOTIFY_MCP_ALLOW_PATHS = prev;
  });
}

const ALLOWED_ROOTS: Array<() => void> = [];

async function snapshotFile(snapshot: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'spotify-restore-test-'));
  const path = join(dir, 'snapshot.json');
  await writeFile(path, JSON.stringify(snapshot), 'utf8');
  allowReadRoot(dir);
  return path;
}

async function rawFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'spotify-restore-test-'));
  const path = join(dir, 'snapshot.json');
  await writeFile(path, contents, 'utf8');
  allowReadRoot(dir);
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

  it('chunk-checks at 50, writes at 40, and saves only absent URIs (#734)', async () => {
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
      const checkSizes = checks.map(
        (c) => ((c.params?.uris ?? '').split(',').filter(Boolean)).length,
      );
      assert.deepEqual(
        checkSizes,
        [50, 50, 20],
        'contains chunks: [50, 50, 20] at CHUNK_CAPS.library_reads (50) — read-only path keeps its larger cap',
      );
      for (const c of checks) {
        assert.ok(
          ((c.params?.uris ?? '').split(',').filter(Boolean)).length <= CHUNK_CAPS.library_reads,
          'contains chunk ≤ CHUNK_CAPS.library_reads',
        );
      }
      const puts = h.client.calls.filter(
        (c) => c.method === 'PUT' && c.path.startsWith('/me/library?'),
      );
      assert.equal(puts.length, 3, '118 absent uris saved in 3 chunks (40/40/38)');
      const putSizes = puts.map((p) => {
        const urisInRequest = new URLSearchParams(p.path.split('?')[1] ?? '').get('uris');
        assert.ok(urisInRequest !== null, 'library write must carry a uris query param');
        return urisInRequest.split(',').filter(Boolean).length;
      });
      // 118 absent URIs chunked at the documented 40-uri write cap: 40 + 40 + 38.
      // Not 50 + 50 + 18, which is what the over-cap /me/library write path
      // used to produce and what #734 was filed against.
      assert.deepEqual(
        putSizes,
        [40, 40, 38],
        'write chunks: [40, 40, 38] at CHUNK_CAPS.library_writes (40) — no over-cap write batch',
      );
      for (const p of puts) {
        const urisInRequest = new URLSearchParams(p.path.split('?')[1] ?? '').get('uris') ?? '';
        assert.ok(
          urisInRequest.split(',').filter(Boolean).length <= CHUNK_CAPS.library_writes,
          'every write chunk ≤ CHUNK_CAPS.library_writes — cross-check the constant',
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

  // #638: `PUT /me/following?type=artist` was removed by Spotify's February 2026
  // changes, and `PUT /me/library` does not accept `spotify:artist:` URIs, so
  // re-following an artist is no longer expressible at any endpoint. The old
  // test asserted a `PUT /me/following?type=artist&ids=new1` this tool can no
  // longer make, so it is replaced by the disclosure the unrecoverable case
  // requires — plus the "did it keep every live assertion" checks: the
  // already-followed artist is still recognised, and the non-artist URI is
  // still skipped.
  it('discloses un-followable artists instead of writing a follow (#638)', async () => {
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

      // No follow write of any kind. `PUT /me/following?type=artist` is gone and
      // `/me/library` would reject a `spotify:artist:` URI, so a write here
      // would be either a 404 or a silent no-op the plan then reports as
      // "restored".
      assert.deepEqual(
        h.client.calls.filter((c) => c.method === 'PUT' || c.method === 'POST'),
        [],
        'a followed-artists restore performs no writes at all',
      );

      // The read half DID migrate, and it is the only half that did. Proving it
      // with the call itself, not with a field that could pass either way.
      const contains = h.client.calls.filter((c) => c.path === '/me/library/contains');
      assert.equal(contains.length, 1);
      assert.deepEqual(
        contains[0].params?.uris,
        'spotify:artist:have1,spotify:artist:new1',
        'follow state is read through the unified read, with artist URIs',
      );

      const payload = out.structuredContent as Record<string, any>;
      const cat = payload.categories.followed_artists as Record<string, any>;
      assert.equal(cat.total, 3);
      assert.equal(cat.already_present, 1, 'the already-followed artist is still recognised');
      assert.equal(cat.unrestorable, 1, 'the un-followed artist is unrestorable');
      assert.equal(cat.skipped, 1, 'non-artist URI skipped');
      assert.equal(cat.planned, 0, 'no follow write is planned — no endpoint accepts one');
      assert.equal(cat.executed, 0, 'nothing was written, so nothing may be reported as written');
      assert.ok(
        (cat.notes as string[]).some((n) => /cannot re-follow spotify:artist:new1/.test(n)),
        `notes must name the unrestorable artist: ${JSON.stringify(cat.notes)}`,
      );
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('names the unrestorable slice in the dry-run prose and payload (#638)', async () => {
    const state = emptyState();
    const path = await snapshotFile({
      _meta: { created: CREATED },
      followed_artists: [{ uri: 'spotify:artist:new1', name: 'New' }],
    });
    try {
      const h = harness(state);
      const out = await h.invoke('restore_library_snapshot', {
        backup_path: path,
        categories: ['followed_artists'],
      });
      const text = textOf(out);
      const payload = out.structuredContent as Record<string, any>;

      // Prose: a category that silently drops its rows reads exactly like a
      // category with nothing to do. The plan must name the difference.
      assert.match(
        text,
        /- followed_artists: .*NOT RESTORABLE — Spotify removed the endpoint that would write them \(#638\)/,
      );
      // `unrestorable` is its own field, never folded into `skipped`: a
      // malformed snapshot row and a platform-removed write are different
      // failures and a caller has to be able to tell them apart.
      assert.doesNotMatch(text, /skipped/);
      assert.equal(writesOf(h.client).length, 0, 'a dry run writes nothing');
      const cat = payload.categories.followed_artists as Record<string, any>;
      assert.equal(cat.unrestorable, 1);
      assert.equal(cat.planned, 0);
      assert.equal(cat.executed, 0);
      assert.equal(cat.skipped, 0);
      assert.equal(payload.status, 'planned', 'a dry run reports a plan, not an outcome');
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('discloses the unrestorable slice in the confirmation prompt (#638)', async () => {
    // The person authorising the restore is told what will NOT change. A prompt
    // that lists only what will is how an excluded category disappears without
    // anyone having decided to exclude it.
    const state = emptyState();
    const path = await snapshotFile({
      _meta: { created: CREATED },
      liked_tracks: [{ uri: 'spotify:track:t1', name: 'One' }],
      followed_artists: [{ uri: 'spotify:artist:new1', name: 'New' }],
    });
    try {
      const h = harness(state, 'accept');
      await h.invoke('restore_library_snapshot', {
        backup_path: path,
        dry_run: false,
      });
      assert.equal(h.prompts.length, 1, 'the write path prompts exactly once');
      const prompt = h.prompts[0];
      assert.match(
        prompt,
        /- followed_artists: 1 item\(s\) CANNOT be restored — Spotify removed the endpoint that would write them \(#638\)/,
      );
      assert.match(prompt, /They are excluded, not attempted/);
      // The restorable half is still named, so the disclosure is additive
      // rather than a replacement for the change list.
      assert.match(prompt, /- liked_tracks: save 1 item\(s\)/);
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('rejects on a malformed /me/library/contains body instead of planning on it (#638)', async () => {
    // Follow state is now read through the unified read, which must answer one
    // boolean per requested URI. A body that does not is unread, not a row of
    // "not followed" — reading it positionally would mark every already-
    // followed artist as unrestorable and the plan would be wrong in a way that
    // looks like a clean result.
    const state = emptyState();
    state.followedArtistIds = ['have1', 'have2'];
    const path = await snapshotFile({
      _meta: { created: CREATED },
      followed_artists: [
        { uri: 'spotify:artist:have1', name: 'Have One' },
        { uri: 'spotify:artist:have2', name: 'Have Two' },
      ],
    });
    const cases: Array<[string, unknown]> = [
      ['empty array', []],
      ['short array', [true]],
      ['long array', [true, false, true]],
      ['non-boolean element', [true, 'yes']],
      ['error envelope', { error: { status: 403, message: 'Forbidden' } }],
    ];
    try {
      for (const [label, body] of cases) {
        // Both dry run and write path: the plan is computed before either
        // branches, so an unread follow state must stop the tool outright.
        for (const dryRun of [true, false]) {
          const h = harness(state, 'accept', { containsBody: body });
          await assert.rejects(
            h.invoke('restore_library_snapshot', { backup_path: path, dry_run: dryRun }),
            /Could not check current follows/,
            `${label} (dry_run=${dryRun}) must reject`,
          );
          assert.equal(
            writesOf(h.client).length,
            0,
            `${label} (dry_run=${dryRun}) must write nothing`,
          );
        }
      }
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('accepts a well-formed /me/library/contains body (#638 control)', async () => {
    // The counterpart to the test above. Without it, "rejects on a malformed
    // body" would also be satisfied by a tool that rejected every body.
    const state = emptyState();
    state.followedArtistIds = ['have1'];
    const path = await snapshotFile({
      _meta: { created: CREATED },
      followed_artists: [
        { uri: 'spotify:artist:have1', name: 'Have One' },
        { uri: 'spotify:artist:new1', name: 'New One' },
      ],
    });
    try {
      const h = harness(state, 'accept', { containsBody: [true, false] });
      const out = await h.invoke('restore_library_snapshot', {
        backup_path: path,
        dry_run: false,
        categories: ['followed_artists'],
      });
      const cat = (out.structuredContent as Record<string, any>).categories
        .followed_artists as Record<string, any>;
      assert.equal(cat.already_present, 1);
      assert.equal(cat.unrestorable, 1);
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
    // #1237: this previously asserted assert.rejects(/Elicitation unavailable/),
    // which pinned the throw this fix removes — an unpromptable host is a
    // refusal, not an exception. The zero-writes half is kept and is the
    // safety part; the shape is now the shared refusal contract.
    delete process.env[CONFIRM_ENV];
    const path = await snapshotFile(baseSnapshot());
    try {
      const h = harness(emptyState(), 'unsupported');
      const out = await h.invoke('restore_library_snapshot', { backup_path: path, dry_run: false });
      assert.equal(writesOf(h.client).length, 0);
      assert.equal(out.structuredContent?.reason, 'confirmation_unavailable');
      assert.equal(out.structuredContent?.ok, false);
      assert.equal(out.structuredContent?.cancelled, true);
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });

  // #1237: all three refusal verdicts, one shape. The harness's elicit modes
  // are 'accept' | 'decline' | 'unsupported'; a transport failure is modelled
  // below by a host that advertises the capability and then throws, which is
  // the wire-error path confirmViaElicitation maps to 'error'. Expected
  // reasons are literals, never recomputed from the helper under test.
  //
  // All three live in ONE test on purpose. Split across separate tests, the
  // 'unsupported' case was not reached by the mutation check for this site:
  // reverting the fix to a silent proceed on an unpromptable host left this
  // test green, because it only ever drove 'declined' and 'error'.
  it('returns the shared refusal payload for declined, error and unsupported, writing nothing', async () => {
    delete process.env[CONFIRM_ENV];
    const path = await snapshotFile(baseSnapshot());
    try {
      // A host that advertises elicitation and then fails on the wire: the
      // only way to reach the 'error' verdict through the real code path.
      const registered: RegisteredTool[] = [];
      const throwingServer = {
        tool(
          name: string,
          description: string,
          schema: z.ZodRawShape,
          handler: RegisteredTool['handler'],
        ) {
          registered.push({ name, description, validate: (a) => z.object(schema).parse(a), handler });
        },
        server: {
          getClientCapabilities: () => ({ elicitation: {} }),
          elicitInput: async () => {
            throw new Error('elicitation transport failed');
          },
        },
      };
      const errorClient = makeClient(emptyState());
      registerRestoreTools(throwingServer as unknown as McpServer, errorClient as unknown as SpotifyClient);
      const errorTool = registered.find((t) => t.name === 'restore_library_snapshot')!;

      const declined = harness(emptyState(), 'decline');
      const unsupported = harness(emptyState(), 'unsupported');
      const rows = [
        ['declined', undefined, declined.client, await declined
          .invoke('restore_library_snapshot', { backup_path: path, dry_run: false })],
        ['unsupported', 'confirmation_unavailable', unsupported.client, await unsupported
          .invoke('restore_library_snapshot', { backup_path: path, dry_run: false })],
        ['error', 'elicitation_failed', errorClient, await errorTool.handler(
          errorTool.validate({ backup_path: path, dry_run: false }),
        )],
      ] as const;

      for (const [label, reason, client, out] of rows) {
        // Nothing may be written on any refusal verdict — this is the half
        // that is the actual safety property.
        assert.equal(writesOf(client).length, 0, `${label}: no writes`);
        const p = out.structuredContent as Record<string, unknown>;
        assert.equal(p.ok, false, label);
        assert.equal(p.cancelled, true, label);
        // restore keeps its bespoke cancelled shaping, so the plan summary a
        // host already parses must survive alongside the new fields.
        assert.equal(p.status, 'cancelled', label);
        assert.equal(p.tool, 'restore_library_snapshot', label);
        if (reason === undefined) assert.equal('reason' in p, false, label);
        else assert.equal(p.reason, reason, label);
      }
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
      // Per-chunk progress (#734): the failure record names the URIs of the
      // chunk that landed just before the failure, so a re-run can resume from
      // there rather than duplicate the 40 URIs that already went through.
      // In this scenario the failing PUT was #2 of 2 (each chunk = 40), so
      // exactly one chunk's worth — the first batch's 40 URIs — was committed.
      assert.equal(failure.last_committed_chunk.length, 40);
      assert.deepEqual(failure.last_committed_chunk, liked.slice(0, 40));
      // The failing category stopped, the later category still landed.
      assert.equal(payload.categories.saved_albums.executed, 1);
      assert.match(textOf(out), /Restore PARTIAL/);
      assert.match(textOf(out), /40\/80 item\(s\) landed, 40 still pending/);
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('does not claim a playlist was created when its create failed', async () => {
    const path = await snapshotFile({
      _meta: { created: CREATED },
      playlists: [
        { name: 'One', item_count: 1, items: [{ uri: 'spotify:track:o1', name: 'O1' }] },
        { name: 'Two', item_count: 1, items: [{ uri: 'spotify:track:t1', name: 'T1' }] },
        { name: 'Three', item_count: 1, items: [{ uri: 'spotify:track:th1', name: 'TH1' }] },
      ],
    });
    try {
      const h = harness(emptyState(), 'accept');
      // The FIRST create fails; the loop still attempts the other two, so the
      // report must credit those two and blame only the one that failed.
      const realPost = h.client.post.bind(h.client);
      let creates = 0;
      h.client.post = async (p: string, body?: unknown) => {
        if (p === '/me/playlists' && ++creates === 1) throw new Error('Spotify rejected the create');
        return realPost(p, body);
      };

      const out = await h.invoke('restore_library_snapshot', {
        backup_path: path,
        dry_run: false,
        categories: ['playlists'],
      });
      const payload = out.structuredContent as Record<string, any>;
      const text = textOf(out);

      assert.equal(payload.status, 'partial_restore');
      assert.equal(payload.playlists.created.length, 2, 'the two that succeeded are credited');
      assert.equal(payload.playlists.not_created, 1, 'only the failed create is reported lost');
      assert.equal(payload.failures.length, 1);
      assert.equal(payload.failures[0].stage, 'playlist_create');
      const restored = (name: string) => `Restored · ${name} \\(${CREATED.slice(0, 10)}\\)`;
      assert.match(text, new RegExp(`NOT created — "${restored('One')}"`));
      assert.doesNotMatch(text, new RegExp(`· created "${restored('One')}"`));
      assert.match(text, new RegExp(`created "${restored('Two')}" \\(1 item\\(s\\)\\)`));
      assert.match(text, new RegExp(`created "${restored('Three')}" \\(1 item\\(s\\)\\)`));
      assert.match(text, /1 planned playlist\(s\) were never created/);
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------

/**
 * The file backup_library writes when the quota is hit mid-walk: valid
 * JSON, every category present and empty, `quota_hit`/`_partial` set.
 */
function quotaHitSnapshot(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    _partial: true,
    quota_hit: true,
    retry_after: 60,
    _meta: {
      created: CREATED,
      spotify_data: true,
      retention_until: null,
      snapshot_state: 'partial',
      complete: false,
      partial_reason: 'quota_exceeded',
      partial_reasons: ['quota_exceeded'],
      cap: 500,
      collections: {
        liked_tracks: { fetched: 0, cap: 500, complete: false, truncated: false },
      },
    },
    liked_tracks: [],
    saved_albums: [],
    saved_shows: [],
    saved_episodes: [],
    saved_audiobooks: [],
    followed_artists: [],
    playlists: [],
    ...extra,
  };
}

describe('restore_library_snapshot contentless snapshots (#757)', () => {
  it('refuses a quota-hit snapshot instead of reporting a clean nothing-to-add', async () => {
    const path = await snapshotFile(quotaHitSnapshot());
    try {
      const h = harness(emptyState());
      await assert.rejects(
        h.invoke('restore_library_snapshot', { backup_path: path }),
        (err: Error) => {
          assert.match(err.message, /Partial snapshot at .+snapshot\.json/);
          assert.match(err.message, /quota hit/);
          assert.match(err.message, /take a fresh backup/);
          return true;
        },
      );
      assert.equal(writesOf(h.client).length, 0);
      // The plan is never even built, so no library state is read either.
      assert.equal(h.client.calls.length, 0);
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('refuses the same empty file even when the quota marker was lost', async () => {
    const bare = quotaHitSnapshot();
    delete bare.quota_hit;
    delete bare._partial;
    const path = await snapshotFile(bare);
    try {
      const h = harness(emptyState());
      await assert.rejects(
        h.invoke('restore_library_snapshot', { backup_path: path }),
        /Partial snapshot at .+: no library content was recorded/,
      );
      assert.equal(h.client.calls.length, 0);
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('still previews a legitimately empty library that declares itself complete', async () => {
    const path = await snapshotFile(
      quotaHitSnapshot({
        _partial: undefined,
        quota_hit: undefined,
        retry_after: undefined,
        _meta: { created: CREATED, snapshot_state: 'complete', complete: true },
      }),
    );
    try {
      const h = harness(emptyState());
      const out = await h.invoke('restore_library_snapshot', { backup_path: path });
      const payload = out.structuredContent as Record<string, any>;
      assert.equal(payload.snapshot_state, 'complete');
      assert.equal(payload.partial, false);
      assert.equal(payload.status, 'planned');
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('refuses an unsupported schema_version, naming the supported one', async () => {
    const path = await snapshotFile({ ...baseSnapshot(), schema_version: 2 });
    try {
      const h = harness(emptyState());
      await assert.rejects(
        h.invoke('restore_library_snapshot', { backup_path: path }),
        /schema_version 2 is not the supported version 1/,
      );
      assert.equal(h.client.calls.length, 0);
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('marks a cap-truncated preview partial in the payload, not just in the prose', async () => {
    const snap = baseSnapshot();
    snap._meta = {
      ...snap._meta,
      snapshot_state: 'partial',
      complete: false,
      partial_reason: 'collection_cap_reached:liked_tracks',
      partial_reasons: ['collection_cap_reached:liked_tracks'],
    };
    const path = await snapshotFile(snap);
    try {
      const h = harness(emptyState());
      const out = await h.invoke('restore_library_snapshot', { backup_path: path });
      const payload = out.structuredContent as Record<string, any>;
      assert.equal(payload.partial, true);
      assert.equal(payload.restorable_complete, false);
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('reports unknown completeness as null rather than guessing', async () => {
    const path = await snapshotFile(baseSnapshot());
    try {
      const h = harness(emptyState());
      const out = await h.invoke('restore_library_snapshot', { backup_path: path });
      const payload = out.structuredContent as Record<string, any>;
      assert.equal(payload.snapshot_state, 'unknown');
      assert.equal(payload.partial, null);
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// #737 — the name-reservation walk must be COMPLETE
// ---------------------------------------------------------------------------

describe('restore_library_snapshot name reservation (#737)', () => {
  /** Live account of `count` playlists; `collisionName` lands at `collisionIndex`. */
  function accountOf(count: number, collisionName: string, collisionIndex: number) {
    const playlists = Array.from({ length: count }, (_, i) => ({
      id: `pl_live_${i}`,
      name: `Live ${i}`,
    }));
    playlists[collisionIndex] = { id: 'pl_collision', name: collisionName };
    const state = emptyState();
    state.playlists = playlists;
    return state;
  }

  function collisionSnapshot(name: string): LibrarySnapshot {
    return {
      _meta: { created: CREATED, counts: {} },
      playlists: [
        {
          name,
          items: [
            { uri: 'spotify:track:c1', name: 'C1' },
            { uri: 'spotify:track:c2', name: 'C2' },
          ],
        },
      ],
    };
  }

  it('sees a name collision on page 15 of a 900-playlist account (cap 500) and creates no duplicate', async () => {
    // The collision sits at index 700 — page 15, four hundred rows past the
    // default cap of 500. A walk that stops at the cap never sees it.
    const state = accountOf(900, 'Gone Playlist', 700);
    const path = await snapshotFile(collisionSnapshot('Gone Playlist'));
    try {
      const h = harness(state, 'accept', { fetchAllCap: 500 });
      const out = await h.invoke('restore_library_snapshot', {
        backup_path: path,
        categories: ['playlists'],
        dry_run: false,
      });

      const creates = h.client.calls.filter(
        (c) => c.method === 'POST' && c.path === '/me/playlists',
      );
      assert.equal(
        creates.length,
        0,
        'a playlist existing beyond the old cap must not be duplicated',
      );
      assert.equal(
        h.client.calls.some((c) => c.path.startsWith('/playlists/pl_collision')),
        false,
        'the existing same-name playlist is never written into',
      );

      const payload = out.structuredContent as Record<string, any>;
      assert.deepEqual(payload.playlists.skipped_existing, ['Gone Playlist']);
      assert.equal(
        payload.playlists.existing_scanned,
        900,
        'the whole account must be compared, not the first 500',
      );
      assert.equal(payload.playlists.existing_truncated, false);
      assert.equal(payload.playlists.existing_scan_total, 900);
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('reports the scan coverage in the dry-run plan and in prose', async () => {
    const state = accountOf(900, 'Gone Playlist', 700);
    const path = await snapshotFile(collisionSnapshot('Gone Playlist'));
    try {
      const h = harness(state, 'accept', { fetchAllCap: 500 });
      const out = await h.invoke('restore_library_snapshot', {
        backup_path: path,
        categories: ['playlists'],
      });

      const payload = out.structuredContent as Record<string, any>;
      assert.equal(payload.status, 'planned');
      assert.equal(payload.playlists.existing_scanned, 900);
      assert.equal(payload.playlists.existing_truncated, false);
      assert.ok(
        payload.playlists.existing_scan_cap >= 900,
        'the reservation walk must not inherit the 500 fetch-all cap',
      );
      assert.match(textOf(out), /Name-reservation scan: fetched 900 of 900 existing playlists compared/);
      assert.match(textOf(out), /complete; cap not reached/);
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('refuses the write path when the reservation walk is itself clipped', async () => {
    // 2500 playlists: past even the 2000-row floor, so the walk truncates and
    // the guard cannot be called complete.
    const state = accountOf(2500, 'Gone Playlist', 2400);
    const path = await snapshotFile(collisionSnapshot('Gone Playlist'));
    try {
      const h = harness(state, 'accept', { fetchAllCap: 500 });
      await assert.rejects(
        () =>
          h.invoke('restore_library_snapshot', {
            backup_path: path,
            categories: ['playlists'],
            dry_run: false,
          }),
        /name-reservation scan/,
        'a clipped reservation scan must not silently narrow the duplicate guard',
      );
      assert.equal(writesOf(h.client).length, 0, 'nothing written');
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('says so in the dry-run plan when the reservation walk is clipped', async () => {
    const state = accountOf(2500, 'Gone Playlist', 2400);
    const path = await snapshotFile(collisionSnapshot('Gone Playlist'));
    try {
      const h = harness(state, 'accept', { fetchAllCap: 500 });
      const out = await h.invoke('restore_library_snapshot', {
        backup_path: path,
        categories: ['playlists'],
      });

      const payload = out.structuredContent as Record<string, any>;
      assert.equal(payload.playlists.existing_truncated, true);
      assert.equal(payload.playlists.existing_scanned, 2000);
      assert.equal(payload.playlists.existing_scan_total, 2500);
      assert.match(textOf(out), /TRUNCATED/);
      assert.match(textOf(out), /invisible/i);
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('reports null coverage when no reservation walk ran', async () => {
    const state = emptyState();
    state.savedUris = ['spotify:track:have1'];
    const path = await snapshotFile(baseSnapshot());
    try {
      const h = harness(state);
      const out = await h.invoke('restore_library_snapshot', {
        backup_path: path,
        categories: ['liked_tracks'],
      });
      const payload = out.structuredContent as Record<string, any>;
      // "did not run" is not "found none", and null says which.
      assert.equal(payload.playlists.existing_scanned, null);
      assert.equal(payload.playlists.existing_truncated, null);
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });
});
