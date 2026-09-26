/**
 * Scope-visibility matrix (#700): which tools a caller can actually SEE for
 * each granted-scope set, measured over the REAL stdio server rather than
 * inferred from the gate.
 *
 * This exists because every other test in the suite runs with an empty or
 * absent `scope`, where moduleBlockedByScopes fails OPEN — so nothing below
 * the gate was ever exercised, and a default that unregistered hundreds of
 * tools shipped with a green suite. Each case spawns src/index.ts, speaks
 * JSON-RPC, and reads the real tools/list.
 *
 * Asserted as relations, not counts: a pinned tool count breaks every time a
 * tool is added. The one count that IS pinned is the one that must never move
 * — the full-scope surface equals the pre-scope fail-open surface.
 *
 * Run: node --import tsx --test tests/scope-profile-surface.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { SCOPE_PROFILES } from '../src/config.js';

const REPO_ROOT = join(import.meta.dirname, '..');

/**
 * Read tools `core` grants read scopes FOR but whose module the write-scope
 * gate never registers. Each is a user-visible regression of the "library
 * reads and playlist reads" the default profile advertises in .env.example.
 */
const READS_CORE_GRANTS_BUT_CANNOT_REACH = [
  'get_saved_tracks',
  'get_saved_counts',
  'check_in_library',
  'get_playlist',
  'get_playlist_items',
  'get_followed_artists',
  'check_following_artists',
  'following_analytics',
];

const WRITES_NEEDING_A_WIDER_PROFILE = [
  'save_to_library',
  'create_playlist',
  'upload_playlist_cover',
];

const UNAFFECTED_BY_ANY_PROFILE = [
  'spotify_doctor',
  'get_me',
  'get_currently_playing',
  'play',
  'search',
  'get_album_tracks',
];

/**
 * Mutating tools a `core` token can still SEE. `src/tools/exhaustmisc.ts`
 * registers under `scopeKey: 'exhaustmisc'`, which is not a key in
 * WRITE_SCOPE_REQUIREMENTS, so `moduleBlockedByScopes` never blocks it: the
 * module is always registered and its writers are always listed, on a token
 * that holds no write scope at all. They fail at the API with a 403 — the
 * exact outcome the gate exists to prevent, and one an operator cannot act
 * on, because nothing in the surface says the grant is short.
 *
 * Pinned, not fixed, here: the gate keys live in `src/scopefilter.ts` and the
 * scopeKey in `src/tools/annotations.ts`, both orchestrator-reserved. Until
 * one is corrected, "the default profile withholds every write" is false —
 * and spotify_doctor cannot see it either, because SCOPE_OWNER_BY_MODULE has
 * no exhaustmisc entry, so the module never lands in hidden_by_scopes and
 * raises no gap.
 */
const WRITES_STILL_LISTED_ON_A_CORE_TOKEN = [
  'playlist_to_library',
  'remove_from_library_by_playlist',
  'unsave_orphan_tracks',
  'split_playlist',
];

interface JsonRpcResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface Pending {
  resolve: (v: JsonRpcResponse) => void;
  reject: (e: Error) => void;
}

class StdioClient {
  private buffer = '';
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.child.on('exit', (code) => {
      for (const entry of this.pending.values()) {
        entry.reject(new Error(`server exited early (code=${code})`));
      }
      this.pending.clear();
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }
      if (typeof message.id !== 'number') continue;
      const entry = this.pending.get(message.id);
      if (!entry) continue;
      this.pending.delete(message.id);
      if (message.error) {
        entry.reject(new Error(`JSON-RPC error ${message.error.code}: ${message.error.message}`));
      } else {
        entry.resolve(message);
      }
    }
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<JsonRpcResponse> {
    const id = ++this.nextId;
    const { promise, resolve, reject } = Promise.withResolvers<JsonRpcResponse>();
    this.pending.set(id, { resolve, reject });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return promise;
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }
}

const tempDirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

async function toolNamesFor(scope: string | undefined): Promise<Set<string>> {
  const dir = await mkdtemp(join(tmpdir(), 'scope-surface-'));
  tempDirs.push(dir);
  const tokenFile = join(dir, 'tokens.json');
  await writeFile(
    tokenFile,
    JSON.stringify({
      access_token: 'scope-surface-token',
      refresh_token: 'scope-surface-refresh',
      expires_at: Date.now() + 3600_000,
      ...(scope === undefined ? {} : { scope }),
    }),
    { mode: 0o600 },
  );

  const child = spawn('node', ['--import', 'tsx', 'src/index.ts'], {
    cwd: REPO_ROOT,
    env: { ...process.env, SPOTIFY_CLIENT_ID: 'test-client-id', SPOTIFY_MCP_TOKEN_FILE: tokenFile },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  // The server logs to stderr; drain it so a full pipe cannot wedge the child.
  child.stderr.resume();
  const client = new StdioClient(child);

  const init = await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'scope-surface-test', version: '1.0.0' },
  });
  assert.equal(init.error, undefined, `initialize failed: ${JSON.stringify(init.error)}`);
  client.notify('notifications/initialized');

  const list = await client.request('tools/list', {});
  const tools = (list.result?.tools ?? []) as { name: string }[];
  assert.ok(tools.length > 0, 'tools/list returned nothing');
  return new Set(tools.map((tool) => tool.name));
}

/** The set difference framed the way a caller experiences it. */
function missingFrom(visible: Set<string>, names: readonly string[]): string[] {
  return names.filter((name) => !visible.has(name));
}

let failOpenSurface: Set<string>;
let coreSurface: Set<string>;
let librarySurface: Set<string>;
let playlistsSurface: Set<string>;
let fullSurface: Set<string>;

before(async () => {
  failOpenSurface = await toolNamesFor(undefined);
  coreSurface = await toolNamesFor(SCOPE_PROFILES.core.join(' '));
  librarySurface = await toolNamesFor(SCOPE_PROFILES.library.join(' '));
  playlistsSurface = await toolNamesFor(SCOPE_PROFILES.playlists.join(' '));
  fullSurface = await toolNamesFor(SCOPE_PROFILES.full.join(' '));
});

after(async () => {
  // SIGKILL then the real exit event: no wall-clock grace period to tune, and
  // nothing here can hang on a child that ignores stdin close.
  for (const child of children) {
    child.stdin.end();
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('scope visibility matrix (#700)', () => {
  it('the previous default is intact: a full grant sees exactly the fail-open surface', () => {
    // A pre-#111 token file records no grant, so the gate cannot prove a
    // module would fail and registers everything. If a full-profile auth saw
    // fewer tools than that, this PR would have shrunk the surface even for
    // operators who keep their existing token.
    assert.equal(
      fullSurface.size,
      failOpenSurface.size,
      'full-profile grant must expose the same tool count as an unrecorded grant',
    );
    for (const name of failOpenSurface) {
      assert.ok(fullSurface.has(name), `full profile must still expose ${name}`);
    }
  });

  it('the default profile cannot reach the reads it requests scopes for', () => {
    // user-library-read, playlist-read-private and playlist-read-collaborative
    // are all in `core`, yet the write-scope gate never registers the modules
    // that serve them. This pins the current state, not an aspiration: the
    // module-level fix belongs to the gate (per-tool, not per-module), and
    // until it lands this assertion is what makes the mismatch visible.
    assert.deepEqual(
      missingFrom(coreSurface, READS_CORE_GRANTS_BUT_CANNOT_REACH),
      READS_CORE_GRANTS_BUT_CANNOT_REACH,
    );
    // Sanity: the same tools ARE reachable once a write scope is granted, so
    // this is the gate and not a rename or removal elsewhere in the tree.
    for (const name of READS_CORE_GRANTS_BUT_CANNOT_REACH) {
      assert.ok(
        librarySurface.has(name) || fullSurface.has(name),
        `${name} must be reachable under a wider profile`,
      );
    }
  });

  it('the default profile withholds every write that needs a wider profile', () => {
    assert.deepEqual(missingFrom(coreSurface, WRITES_NEEDING_A_WIDER_PROFILE), WRITES_NEEDING_A_WIDER_PROFILE);
    assert.deepEqual(missingFrom(coreSurface, UNAFFECTED_BY_ANY_PROFILE), []);
  });

  it('widening the grant only ever adds tools', () => {
    const ladder = [
      [coreSurface, librarySurface, 'core -> library'],
      [coreSurface, playlistsSurface, 'core -> playlists'],
      [coreSurface, fullSurface, 'core -> full'],
      [librarySurface, fullSurface, 'library -> full'],
      [playlistsSurface, fullSurface, 'playlists -> full'],
    ] as const;
    for (const [narrow, wide, label] of ladder) {
      for (const name of narrow) {
        assert.ok(wide.has(name), `${label} must not remove ${name}`);
      }
    }
  });

  it('each opt-in profile adds the family it names and withholds only the other', () => {
    // library covers save/remove plus follow/unfollow but not playlist writes;
    // playlists covers playlist writes plus cover upload but not library saves.
    assert.deepEqual(missingFrom(librarySurface, WRITES_NEEDING_A_WIDER_PROFILE), [
      'create_playlist',
      'upload_playlist_cover',
    ]);
    assert.deepEqual(missingFrom(playlistsSurface, WRITES_NEEDING_A_WIDER_PROFILE), ['save_to_library']);
  });

  it('lists mutating tools on a core token that holds no write scope at all', () => {
    // The inverse of the preceding test, and the reason it cannot simply read
    // "the default is safe": exhaustmisc escapes the gate entirely. Asserted
    // as "still visible" so that closing the gate turns this RED and the fix
    // cannot be mistaken for a surface regression.
    assert.deepEqual(missingFrom(coreSurface, WRITES_STILL_LISTED_ON_A_CORE_TOKEN), []);
    // Same tools under a grant that actually holds the scopes: the leak is
    // the gate's blind spot, not these tools being absent everywhere.
    for (const name of WRITES_STILL_LISTED_ON_A_CORE_TOKEN) {
      assert.ok(librarySurface.has(name) || fullSurface.has(name), `${name} must stay reachable when granted`);
    }
  });
});
