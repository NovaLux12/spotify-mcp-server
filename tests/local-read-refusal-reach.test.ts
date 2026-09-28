/**
 * #1617 — the read guard's REACH from the five caller modules that take a
 * path, and the three of them that masked a refusal into "not found".
 *
 * `tests/local-read-bounds.test.ts` proves `readLocalFile` refuses correctly,
 * and `tests/paths.test.ts` proves it at the unit level. Neither proves that
 * any tool module ROUTES a caller-supplied path through it. That gap is
 * silent: swapping one `readLocalFile` for a raw `readFile` at a call site
 * would leave every existing test green and remove the confinement with no
 * failing assertion anywhere. So each case below drives a REFUSED read through
 * a module's PUBLIC SURFACE — a registered tool handler or an exported
 * function — and asserts the refusal survives the trip.
 *
 * ## What is NOT being claimed
 *
 * No tool here is unguarded. Every one of the five reaches `readLocalFile`,
 * and the guard is correct. The gap is that nothing PROVED it. Read the
 * absence of a "path traversal" finding in this file as "unproven", never as
 * "unconfined" — that would be false.
 *
 * ## The reachability fact that shapes every case here
 *
 * Five of these call sites pass `ownStoreRoots(path)`, and that helper is
 * `dirname(resolve(path))` — the root is derived FROM the target. That has a
 * consequence a `../` test would get wrong: a path that escapes by traversal
 * is admitted, because the root moves with it. Measured, not assumed:
 *
 *   readLocalFile({roots: ownStoreRoots('/etc/passwd'), target: '/etc/passwd'})  → READ
 *   readLocalFile({roots: ownStoreRoots(store+'/../outside/secret.json'), ...})   → READ
 *
 * So the `../`-escape case CANNOT produce a refusal at these five call sites,
 * and a test asserting one would be asserting something untrue. What DOES
 * refuse is the symlink: a link planted under a store name whose target sits
 * outside the directory the root was derived from. That is the case the issue
 * calls out, and it is the one that matters — the literal path still looks
 * like it is inside the root, so only a realpath-resolving guard catches it.
 * The other two hazards (a directory, an over-cap file) refuse normally.
 *
 * Each module therefore gets the symlink case, and the masking modules get the
 * three-hazard sweep so the distinction they were erasing is pinned.
 *
 * ## Hermeticity
 *
 * `import './helpers/hermetic.js'` is the FIRST import, before any server code:
 * ES module imports hoist, so a later `HOME` assignment would be too late and
 * the store resolvers — which read `os.homedir()` on every call — would write
 * into the real `~/.spotify-mcp`. Every store is additionally relocated by an
 * explicit `SPOTIFY_MCP_*` override into an `mkdtemp` root, so the fence holds
 * twice over. Nothing here reads, lists, stats or writes the real store.
 */
import './helpers/hermetic.js';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerSwarm3SnapshotsTools } from '../src/tools/swarm3_snapshots.js';
import { registerSwarm4PlaylistsTools } from '../src/tools/swarm4_playlists.js';
import { registerPlaylistHealthTools } from '../src/tools/playlisthealth.js';
import { registerSwarm3PlaybackTools } from '../src/tools/swarm3_playback.js';
import { findPosition, listPositions } from '../src/tools/playbackpositions.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The store roots every case relocates, all under one mkdtemp. */
let root = '';
/** A second scratch dir: the "outside" side of a symlink escape. */
let outside = '';
/** Where each module's store is relocated for the duration of a test. */
let snapDir = '';
let healthDir = '';
let backupDir = '';
let positionsFilePath = '';

const saved: Record<string, string | undefined> = {};
const STORE_VARS = [
  'SPOTIFY_MCP_SNAPSHOT_DIR',
  'SPOTIFY_MCP_DATA_DIR',
  'SPOTIFY_MCP_BACKUP_DIR',
  'SPOTIFY_MCP_PLAYBACKEXT_FILE',
  'SPOTIFY_MCP_MAX_DOCUMENT_MB',
];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'w1617-root-'));
  outside = await mkdtemp(join(tmpdir(), 'w1617-outside-'));
  snapDir = join(root, 'playlist-snapshots');
  healthDir = join(root, 'health-snapshots');
  backupDir = join(root, 'backups');
  positionsFilePath = join(root, 'playback-ext.json');
  for (const d of [snapDir, healthDir, backupDir]) await mkdir(d, { recursive: true });
  for (const k of STORE_VARS) saved[k] = process.env[k];
  process.env.SPOTIFY_MCP_SNAPSHOT_DIR = snapDir;
  process.env.SPOTIFY_MCP_DATA_DIR = healthDir;
  process.env.SPOTIFY_MCP_BACKUP_DIR = backupDir;
  process.env.SPOTIFY_MCP_PLAYBACKEXT_FILE = positionsFilePath;
});

afterEach(async () => {
  for (const k of STORE_VARS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

/**
 * Plant a SYMLINK inside a store whose target sits outside it.
 *
 * This is the only escape reachable at an `ownStoreRoots` call site — see the
 * header. It is also the case a string-level check would wave through, which
 * is what makes it the one worth testing.
 */
async function plantEscapeLink(name: string, dir: string): Promise<string> {
  const secret = join(outside, 'secret.json');
  if (!lstatSync(secret, { throwIfNoEntry: false })) await writeFile(secret, '{"leaked":true}', 'utf8');
  const link = join(dir, name);
  await symlink(secret, link);
  return link;
}

// ---------------------------------------------------------------------------
// Harness — every case goes through a REGISTERED handler or an EXPORTED
// function, never through readLocalFile directly.
// ---------------------------------------------------------------------------

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}

interface RegisteredTool {
  name: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

/**
 * A client whose every method fails loudly. The refusals under test are all
 * decided from local disk, so any call reaching here would mean the guard ran
 * late — the same assertion `local-read-bounds` makes, kept here per-module.
 */
function deadClient(): SpotifyClient {
  const boom = (name: string) => () => {
    throw new Error(`stub client: ${name} must not be called for a refused local read`);
  };
  return {
    get: boom('get'),
    post: boom('post'),
    put: boom('put'),
    delete: boom('delete'),
    getAllPages: boom('getAllPages'),
    getAllPagesWithTruncation: boom('getAllPagesWithTruncation'),
  } as unknown as SpotifyClient;
}

/** Register one module's tools and return an invoker for its handlers. */
function harnessFor(register: (server: McpServer, client: SpotifyClient) => void) {
  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(name: string, _desc: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
      registered.push({ name, validate: (a) => z.object(schema).parse(a), handler });
    },
  } as unknown as McpServer;
  register(fakeServer, deadClient());
  return async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const tool = registered.find((t) => t.name === name);
    assert.ok(tool, `tool ${name} registered`);
    return tool.handler(tool.validate(args));
  };
}

const snapshots = () => harnessFor(registerSwarm3SnapshotsTools);
const swarm4 = () => harnessFor(registerSwarm4PlaylistsTools);
const health = () => harnessFor(registerPlaylistHealthTools);
const playback = () => harnessFor(registerSwarm3PlaybackTools);

/** Assert a rejection matching `pattern`, and return the message. */
async function refuses(run: () => Promise<unknown>, pattern: RegExp, what: string): Promise<string> {
  let message = '';
  await assert.rejects(
    Promise.resolve().then(run),
    (err: unknown) => {
      assert.ok(err instanceof Error, `${what}: expected an Error, got ${String(err)}`);
      message = err.message;
      assert.match(message, pattern, `${what}: unexpected refusal — ${message}`);
      return true;
    },
    `${what}: expected a refusal matching ${pattern}`,
  );
  return message;
}

// ===========================================================================
// 1. swarm3_snapshots — `read_playlist_snapshot` via the `snapshot` param.
//    This module does NOT mask, so it asserts the guard's own message.
// ===========================================================================

describe('swarm3_snapshots routes the `snapshot` param through the guard', () => {
  it('refuses a symlink whose target escapes the snapshot directory', async () => {
    await plantEscapeLink('plsnap-pl1-2026-01-01-1.json', snapDir);
    const msg = await refuses(
      () => snapshots()('read_playlist_snapshot', { snapshot: 'plsnap-pl1-2026-01-01-1.json' }),
      /refusing to read outside the allowed read roots/,
      'escaping symlink',
    );
    assert.ok(msg.includes(snapDir), `refusal must name the store it checked, got: ${msg}`);
  });

  it('refuses a directory named like a snapshot', async () => {
    await mkdir(join(snapDir, 'plsnap-pl1-2026-01-01-1.json'));
    await refuses(
      () => snapshots()('read_playlist_snapshot', { snapshot: 'plsnap-pl1-2026-01-01-1.json' }),
      /is a directory, not a regular file/,
      'directory',
    );
  });

  it('refuses a FIFO named like a snapshot rather than blocking on it', async () => {
    const fifo = join(snapDir, 'plsnap-pl1-2026-01-01-1.json');
    await execFileAsync('mkfifo', [fifo]);
    assert.ok(lstatSync(fifo).isFIFO(), 'fixture really is a FIFO');
    await refuses(
      () => snapshots()('read_playlist_snapshot', { snapshot: 'plsnap-pl1-2026-01-01-1.json' }),
      /is a FIFO, not a regular file/,
      'FIFO',
    );
  });

  it('refuses an over-cap snapshot and names the limit', async () => {
    process.env.SPOTIFY_MCP_MAX_DOCUMENT_MB = '1';
    await writeFile(join(snapDir, 'plsnap-pl1-2026-01-01-1.json'), 'x'.repeat(2 * 1024 * 1024), 'utf8');
    const msg = await refuses(
      () => snapshots()('read_playlist_snapshot', { snapshot: 'plsnap-pl1-2026-01-01-1.json' }),
      /over the 1048576-byte document limit/,
      'over-cap',
    );
    assert.match(msg, /SPOTIFY_MCP_MAX_DOCUMENT_MB/, 'the message must be actionable');
  });

  it('still reads a genuine in-store snapshot (the guard is not refusing everything)', async () => {
    const snap = {
      _meta: { snapshot_id: 'pl1-2026-01-01-1', playlist_id: 'pl1', playlist_name: 'P', taken_at: '2026-01-01T00:00:00Z', track_count: 1, unique_uris: 1 },
      tracks: [{ uri: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa', name: 'T', position: 0, added_at: '2026-01-01T00:00:00Z' }],
    };
    await writeFile(join(snapDir, 'plsnap-pl1-2026-01-01-1.json'), JSON.stringify(snap), 'utf8');
    const out = await snapshots()('read_playlist_snapshot', { snapshot: 'plsnap-pl1-2026-01-01-1.json' });
    assert.equal(out.structuredContent?.ok, true);
  });
});

// ===========================================================================
// 2. swarm4_playlists — `playlist_snapshot_detail` via `backup_file`.
//    This one MASKED; #1617 is what makes the refusals observable again.
// ===========================================================================

describe('swarm4_playlists surfaces a guard refusal instead of calling it "not found"', () => {
  it('refuses a symlink whose target escapes the backup directory', async () => {
    await plantEscapeLink('backup-2026-01-01-1.json', backupDir);
    const msg = await refuses(
      () => swarm4()('playlist_snapshot_detail', { backup_file: 'backup-2026-01-01-1.json', playlist_name: 'P' }),
      /refusing to read outside the allowed read roots/,
      'escaping symlink',
    );
    assert.ok(msg.includes(backupDir), `refusal must name the store it checked, got: ${msg}`);
  });

  it('refuses a directory named like a backup, rather than reporting "not found"', async () => {
    await mkdir(join(backupDir, 'backup-2026-01-01-1.json'));
    await refuses(
      () => swarm4()('playlist_snapshot_detail', { backup_file: 'backup-2026-01-01-1.json', playlist_name: 'P' }),
      /is a directory, not a regular file/,
      'directory',
    );
  });

  it('refuses an over-cap backup and names the limit', async () => {
    process.env.SPOTIFY_MCP_MAX_DOCUMENT_MB = '1';
    await writeFile(join(backupDir, 'backup-2026-01-01-1.json'), 'x'.repeat(2 * 1024 * 1024), 'utf8');
    const msg = await refuses(
      () => swarm4()('playlist_snapshot_detail', { backup_file: 'backup-2026-01-01-1.json', playlist_name: 'P' }),
      /over the 1048576-byte document limit/,
      'over-cap',
    );
    assert.match(msg, /SPOTIFY_MCP_MAX_DOCUMENT_MB/);
  });

  it('a genuinely ABSENT snapshot still reports "not found" with the available list', async () => {
    // The behaviour #1617 deliberately preserves: only absence is "not found".
    const msg = await refuses(
      () => swarm4()('playlist_snapshot_detail', { backup_file: 'backup-2026-01-01-9.json', playlist_name: 'P' }),
      /Snapshot "backup-2026-01-01-9\.json" not found\./,
      'absent',
    );
    assert.match(msg, /No snapshots found in/, 'the absent case keeps its "run backup_library" hint');
  });
});

// ===========================================================================
// 3. playlisthealth — `diff_since_snapshot` via the two id params, and
//    `list_playlist_snapshots`. Masked at :344; silently skipped at :642.
// ===========================================================================

describe('playlisthealth surfaces a guard refusal instead of calling it "not found"', () => {
  it('refuses a symlink whose target escapes the health snapshot directory', async () => {
    // snapshotPath() sanitises both ids to [A-Za-z0-9_-], so the file name is
    // fully determined: this link is the one the tool will look for.
    await plantEscapeLink('pl1__snap1.json', healthDir);
    const msg = await refuses(
      () => health()('diff_since_snapshot', { playlist_id: 'pl1', snapshot_id: 'snap1' }),
      /refusing to read outside the allowed read roots/,
      'escaping symlink',
    );
    assert.ok(msg.includes(healthDir), `refusal must name the store it checked, got: ${msg}`);
  });

  it('refuses a directory where the snapshot belongs, rather than reporting "not found"', async () => {
    await mkdir(join(healthDir, 'pl1__snap1.json'));
    await refuses(
      () => health()('diff_since_snapshot', { playlist_id: 'pl1', snapshot_id: 'snap1' }),
      /is a directory, not a regular file/,
      'directory',
    );
  });

  it('refuses an over-cap snapshot and names the limit', async () => {
    process.env.SPOTIFY_MCP_MAX_DOCUMENT_MB = '1';
    await writeFile(join(healthDir, 'pl1__snap1.json'), 'x'.repeat(2 * 1024 * 1024), 'utf8');
    const msg = await refuses(
      () => health()('diff_since_snapshot', { playlist_id: 'pl1', snapshot_id: 'snap1' }),
      /over the 1048576-byte document limit/,
      'over-cap',
    );
    assert.match(msg, /SPOTIFY_MCP_MAX_DOCUMENT_MB/);
  });

  it('a genuinely ABSENT snapshot still reports the ids-free "not found"', async () => {
    await refuses(
      () => health()('diff_since_snapshot', { playlist_id: 'pl1', snapshot_id: 'nope' }),
      /^Snapshot not found for the requested playlist\.$/,
      'absent',
    );
  });

  it('list_playlist_snapshots discloses an unreadable file instead of skipping it silently', async () => {
    // The listing must not raise over one bad file — it lists the rest — but a
    // refusal that vanishes from the output is the #803 shape: a listing that
    // reads as complete when it is not.
    await plantEscapeLink('pl1__snap1.json', healthDir);
    await writeFile(
      join(healthDir, 'pl2__snap2.json'),
      JSON.stringify({ snapshot_id: 'snap2', playlist_id: 'pl2', created_at: '2026-01-02T00:00:00Z', total: 2, items: [] }),
      'utf8',
    );
    const out = await health()('list_playlist_snapshots', {});
    const sc = out.structuredContent as { count: number; unreadable?: Array<{ file: string; reason: string }> };
    assert.equal(sc.count, 1, 'the readable snapshot is still listed');
    assert.equal(sc.unreadable?.length, 1, 'the refusal is disclosed, not swallowed');
    assert.match(sc.unreadable?.[0]?.reason ?? '', /refusing to read outside the allowed read roots/);
    assert.match(out.content.map((c) => c.text).join('\n'), /unreadable: "pl1__snap1\.json"/);
  });
});

// ===========================================================================
// 4. playbackpositions — seven guarded sites; driven through the EXPORTED
//    functions, which are this module's public surface (it registers no tools
//    of its own — `playbackext.ts` wraps it).
// ===========================================================================

describe('playbackpositions routes its stores through the guard', () => {
  it('refuses a symlinked positions file that escapes its directory', async () => {
    await plantEscapeLink('playback-ext.json', root);
    // The CANONICAL store goes through the shared sidecar loader, which
    // refuses loudly (preserving the bytes) rather than reading. The listing's
    // skip-and-continue policy applies to the LEGACY maps it walks afterwards;
    // the canonical store is a refusal, and this pins that it stays one.
    const msg = await refuses(
      async () => listPositions(),
      /unreadable/,
      'escaping symlink as the canonical store',
    );
    assert.match(msg, /refusing to read outside the allowed read roots/, 'the guard reason must survive');
  });

  it('findPosition does not read a symlinked legacy bookmark that escapes its directory', async () => {
    // findPosition's last fallback is readLegacyBookmarkFile, which returns
    // null on failure. The claim under test is that it returns null WITHOUT
    // having read the target's bytes.
    await plantEscapeLink('playback-bookmark-x.json', backupDir);
    const found = await findPosition('x');
    assert.equal(found, null, 'the escape yields no record');
  });

  it('a FIFO planted as the positions store is refused, not read', async () => {
    await rm(positionsFilePath, { force: true });
    const fifo = join(root, 'playback-ext.json');
    await execFileAsync('mkfifo', [fifo]);
    assert.ok(lstatSync(fifo).isFIFO(), 'fixture really is a FIFO');
    // loadSidecar preserves the bytes and refuses; it must not block on the
    // pipe, which is what a raw readFile here would do.
    await refuses(
      async () => findPosition('anything'),
      /FIFO|not a regular file|could not be read/,
      'FIFO as the positions store',
    );
  });

  it('an over-cap positions store is refused, not parsed', async () => {
    process.env.SPOTIFY_MCP_MAX_DOCUMENT_MB = '1';
    await writeFile(positionsFilePath, 'x'.repeat(2 * 1024 * 1024), 'utf8');
    await refuses(
      async () => findPosition('anything'),
      /over the 1048576-byte document limit|not a readable store/,
      'over-cap positions store',
    );
  });
});

// ===========================================================================
// 5. swarm3_playback — `listening_session_report` via `session_id`.
//    Masked as `return null`; the sanitiser holds, so the reachable hazards
//    are the non-regular file and the size cap.
// ===========================================================================

describe('swarm3_playback surfaces a guard refusal instead of reporting "no session"', () => {
  it('refuses a FIFO named like a session, rather than reporting no session found', async () => {
    // sessionPath() reduces the id to [A-Za-z0-9._-], so a traversal id cannot
    // escape and the guard is defence-in-depth here. The two hazards the
    // sanitiser cannot see are exactly the two it was swallowing.
    const fifo = join(backupDir, 'listening-session-s1.json');
    await execFileAsync('mkfifo', [fifo]);
    assert.ok(lstatSync(fifo).isFIFO(), 'fixture really is a FIFO');
    const msg = await refuses(
      () => playback()('listening_session_report', { session_id: 's1' }),
      /is a FIFO, not a regular file/,
      'FIFO session log',
    );
    assert.ok(msg.includes(backupDir), `refusal must name the store it checked, got: ${msg}`);
  });

  it('refuses an over-cap session log and names the limit', async () => {
    process.env.SPOTIFY_MCP_MAX_DOCUMENT_MB = '1';
    await writeFile(
      join(backupDir, 'listening-session-s1.json'),
      JSON.stringify({ id: 's1', started_at: '2026-01-01T00:00:00Z', start_snapshot: { t: 'x'.repeat(2 * 1024 * 1024) } }),
      'utf8',
    );
    const msg = await refuses(
      () => playback()('listening_session_report', { session_id: 's1' }),
      /over the 1048576-byte document limit/,
      'over-cap session log',
    );
    assert.match(msg, /SPOTIFY_MCP_MAX_DOCUMENT_MB/);
  });

  it('a genuinely ABSENT session still reports "no session found" (found: false)', async () => {
    // One real session must exist, or the tool short-circuits on an empty
    // directory and never reaches the read this case is about.
    await writeFile(
      join(backupDir, 'listening-session-real.json'),
      JSON.stringify({ id: 'real', started_at: '2026-01-01T00:00:00Z', start_snapshot: {} }),
      'utf8',
    );
    const out = await playback()('listening_session_report', { session_id: 'nope' });
    assert.equal(out.structuredContent?.found, false);
    assert.match(out.content.map((c) => c.text).join('\n'), /No session found with id "nope"/);
  });
});

// ===========================================================================
// The distinction the three masking modules were erasing, in one place.
// ===========================================================================

describe('"outside my roots" and "does not exist" are different answers', () => {
  it('each masking module answers the two cases differently', async () => {
    // Same module, same param, two different underlying facts. If any of these
    // pairs collapsed back into one message, the masking is back.
    const cases: Array<{ what: string; escape: () => Promise<unknown>; absent: () => Promise<unknown> }> = [
      {
        what: 'swarm4_playlists',
        escape: async () => { await plantEscapeLink('backup-2026-01-01-1.json', backupDir); return swarm4()('playlist_snapshot_detail', { backup_file: 'backup-2026-01-01-1.json', playlist_name: 'P' }); },
        absent: () => swarm4()('playlist_snapshot_detail', { backup_file: 'backup-2026-01-01-1.json', playlist_name: 'P' }),
      },
      {
        what: 'playlisthealth',
        escape: async () => { await plantEscapeLink('pl1__snap1.json', healthDir); return health()('diff_since_snapshot', { playlist_id: 'pl1', snapshot_id: 'snap1' }); },
        absent: () => health()('diff_since_snapshot', { playlist_id: 'pl1', snapshot_id: 'snap1' }),
      },
    ];

    for (const c of cases) {
      // absent: nothing planted at all
      const absentMsg = await refuses(c.absent, /not found/i, `${c.what} absent`);
      // escape: the same name, now a symlink pointing outside
      const escapeMsg = await refuses(c.escape, /refusing to read outside the allowed read roots/, `${c.what} escape`);
      assert.notEqual(
        escapeMsg,
        absentMsg,
        `${c.what}: a refusal and an absence must not produce the same answer`,
      );
      assert.ok(
        !/not found/i.test(escapeMsg),
        `${c.what}: the refusal must not be dressed as "not found" — got: ${escapeMsg}`,
      );
    }
  });
});
