/**
 * Integration smoke test: spawns the REAL server entry (src/index.ts) over
 * stdio and speaks newline-delimited JSON-RPC to it.
 *
 * Zero Spotify API traffic: initialize / tools/list / prompts/list /
 * resources/list are all served locally by the MCP SDK. The token fixture is
 * pointed at a temp file via SPOTIFY_MCP_TOKEN_FILE so the child can NEVER
 * touch ~/.spotify-mcp/tokens.json.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const REPO_ROOT = join(import.meta.dirname, '..');

// Regression guard (#110 follow-up + v1.5 wiring loss): a description
// rewrite once consumed this tool's name argument and the suite stayed
// green; the v1.5 wiring regression shipped two releases before anyone
// noticed grow_playlist/verify_receipt were missing. Pin the tools most at
// risk from either failure class.
const REQUIRED_TOOLS = [
  'check_in_library',
  'get_me',
  'get_album_tracks',
  'list_show_episodes',
  'get_audiobook',
  'get_audiobook_chapters',
  'get_chapter',
  'get_saved_audiobooks',
  'get_currently_playing',
  'play_from_search',
  'get_playlist_cover',
  'upload_playlist_cover',
  'get_top_tracks',
  'get_recently_played',
  'search',
  'play',
  // Post-v1.4 differentiators (highest-severity failure class: silent
  // wiring loss). See the wiring-regression note above.
  'grow_playlist', 'verify_receipt', 'listening_report', 'spotify_doctor',
  'whats_new', 'search_deep', 'handoff', 'merge_playlists',
  'library_hygiene', 'plan_podcast_session', 'where_was_i', 'apply_scene',
];

const FORBIDDEN_TOOLS = [
  'get_recommendations',
  'get_related_artists',
  'get_available_genres',
  'get_featured_playlists',
  'get_audio_features',
  'get_audio_analysis',
  'follow_artist',
  'unfollow_artist',
  'get_show_episodes',
];

const READONLY_WRITE_TOOLS = [
  // Verified leaking before the #579 fix (live probe, 2026-09-19): the READONLY
  // surface contained writer tools from six modules registered without the gate.
  'play_on', 'queue_next', 'seek_relative', 'remove_saved_shows', 'save_episode',
  'remove_saved_episode', 'unsave_orphan_tracks', 'remove_from_library_by_playlist',
  'playlist_to_library', 'save_artist_new_releases', 'pin_playlist',
];

const EXPECTED_PROMPTS = ['artist_deep_dive', 'crate_digging', 'discover_weekly_alternative', 'dj', 'listening_recap', 'migrate_library', 'morning_briefing', 'music_briefing', 'music_taste_summary', 'playlist_audit', 'playlist_from_mood', 'podcast_catchup', 'triage_liked_songs', 'weekly_digest'];

// Mirrors the `ErrorKind` union in src/tools/annotations.ts, which is not
// exported. A classification added there must be added here too, or this
// guard reports a false failure.
const KNOWN_ERROR_KINDS = [
  'auth', 'forbidden', 'not_found', 'rate_limited', 'unavailable',
  'conflict', 'validation', 'unknown_tool', 'unknown_param', 'internal',
] as const;

interface JsonRpcResponse {
  id?: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/** Minimal JSON-RPC client over the spawned server's stdio pipes. */
class StdioClient {
  private buffer = '';
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (v: JsonRpcResponse) => void; reject: (e: Error) => void }>();
  private stderrText = '';
  readonly child: ChildProcessWithoutNullStreams;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    // @modelcontextprotocol/sdk@1.29 StdioServerTransport frames messages as
    // newline-delimited JSON (its ReadBuffer splits on '\n') — no
    // Content-Length headers.
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrText += chunk;
    });
    this.child.on('error', (err) => this.failAll(new Error(`spawn failed: ${err.message}`)));
    this.child.on('exit', (code, signal) =>
      this.failAll(new Error(`server exited early (code=${code} signal=${signal})\nstderr:\n${this.stderrText}`)),
    );
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      const message = JSON.parse(line) as JsonRpcResponse;
      if (typeof message.id !== 'number') continue;
      const entry = this.pending.get(message.id);
      if (!entry) continue;
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        entry.reject(new Error(`JSON-RPC error ${message.error.code}: ${message.error.message}`));
      } else {
        entry.resolve(message);
      }
    }
  }

  private failAll(err: Error): void {
    for (const entry of this.pending.values()) entry.reject(err);
    this.pending.clear();
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<JsonRpcResponse> {
    const id = ++this.nextId;
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
}

let client: StdioClient;
let tempDir = '';
// Hard watchdog: the server under test is a separate OS process whose internal
// timers cannot be faked from here, so a real deadline is required to fail
// fast instead of hanging CI if the child wedges.
let watchdog: NodeJS.Timeout | undefined;

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'spotify-mcp-smoke-'));
  // Future-dated token fixture: valid shape, never expires during the run.
  const tokenFixture = {
    access_token: 'smoke-test-access-token',
    refresh_token: 'smoke-test-refresh-token',
    expires_at: Date.now() + 60 * 60 * 1000,
  };
  const tokenFile = join(tempDir, 'tokens.json');
  await writeFile(tokenFile, JSON.stringify(tokenFixture), { mode: 0o600 });

  const child = spawn('node', ['--import', 'tsx', 'src/index.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      SPOTIFY_CLIENT_ID: 'test-client-id',
      SPOTIFY_MCP_TOKEN_FILE: tokenFile,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  client = new StdioClient(child);

  watchdog = setTimeout(() => {
    client.failAll(new Error(`smoke test exceeded 30s watchdog — killing server\nstderr:\n${client['stderrText']}`));
    child.kill('SIGKILL');
  }, 30_000);

  // Handshake: initialize → initialized notification → protocol ready.
  const init = await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-smoke-test', version: '1.0.0' },
  });
  assert.equal(
    (init.result?.serverInfo as { name?: string } | undefined)?.name,
    'spotify-mcp',
    `unexpected serverInfo.name in ${JSON.stringify(init.result?.serverInfo)}`,
  );
  assert.equal(init.result?.protocolVersion, '2024-11-05');
  client.notify('notifications/initialized');
});

after(async () => {
  clearTimeout(watchdog);
  if (client) {
    client.notify('notifications/exit'); // polite shutdown hint; ignored by older servers
    client.child.stdin.end();
    const exited = Promise.race([
      once(client.child, 'exit'),
      new Promise<'kill'>((resolve) => setTimeout(() => resolve('kill'), 3000)),
    ]);
    if ((await exited) === 'kill') client.child.kill('SIGKILL');
  }
  await rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

describe('MCP stdio smoke (real src/index.ts)', () => {
  it('lists exactly the expected tool surface', async () => {
    const res = await client.request('tools/list');
    const tools = res.result?.tools as Array<{ name: string }>;
    assert.ok(Array.isArray(tools), 'tools/list must return a tools array');

    const names = new Set(tools.map((t) => t.name));
    const missing = REQUIRED_TOOLS.filter((n) => !names.has(n));
    const forbidden = FORBIDDEN_TOOLS.filter((n) => names.has(n));

    assert.deepEqual(
      missing,
      [],
      `total tool count: ${tools.length}; missing tools: [${missing.join(', ')}]`,
    );
    assert.deepEqual(
      forbidden,
      [],
      `removed tools must stay removed, found again: [${forbidden.join(', ')}]`,
    );
    assert.ok(tools.length >= REQUIRED_TOOLS.length, `total tool count: ${tools.length} should cover at least the ${REQUIRED_TOOLS.length} required tools`);
    // Visible in assertion output even on success paths via failure messages above.
    console.log(`tools/list total tool count: ${tools.length}`);
  });

  it('exposes all prompt templates', async () => {
    const res = await client.request('prompts/list');
    const prompts = res.result?.prompts as Array<{ name: string }>;
    assert.ok(Array.isArray(prompts), 'prompts/list must return a prompts array');
    const names = new Set(prompts.map((p) => p.name));
    for (const expected of EXPECTED_PROMPTS) {
      assert.ok(names.has(expected), `expected prompt template "${expected}" in [${[...names].join(', ')}]`);
    }
    assert.equal(prompts.length, EXPECTED_PROMPTS.length, 'prompts/list should expose every registered template');
  });

  it('no longer lists the spotify://genres resource', async () => {
    const res = await client.request('resources/list');
    const resources = res.result?.resources as Array<{ uri: string }>;
    assert.ok(Array.isArray(resources), 'resources/list must return a resources array');
    const genreResource = resources.find((r) => r.uri === 'spotify://genres');
    assert.equal(genreResource, undefined, 'spotify://genres resource must not be listed');
    assert.ok(resources.some((r) => r.uri === 'spotify://me'), 'core spotify://me resource should still be listed');
  });

  // --------------------------------------------------------------
  // Multi-tool sequential workflow (regression guard for the
  // sequential-call anti-pattern: one tool call must not try to
  // subsume a second independent tool invocation).
  // --------------------------------------------------------------
  it('supports sequential tool workflow without the single-call anti-pattern', async () => {
    // Regression guard: agents must issue independent tools/call requests
    // for each tool invocation; one call must not subsume a second.
    // We exercise two sequential calls against the live stdio server.
    //
    // Call 1: local-only parse_spotify_uri (zero network — always succeeds).
    const parseRes = await client.request('tools/call', {
      name: 'parse_spotify_uri',
      arguments: { uri: 'spotify:track:4iV5W9uYEdYUVa79Axb7Rh' },
    });

    // Call 2: get_me — the first networked tool on the surface, called with no
    // arguments against a stub token, so it cannot succeed.
    //
    // #667: the old guard was
    //   assert.ok(meRes.error !== undefined || meRes.result !== undefined)
    // which holds for every JSON-RPC response the transport can produce, and
    // StdioClient.request() rejects on a JSON-RPC error, so the error arm was
    // unreachable. It asserted nothing. What the test can actually pin is the
    // outcome: a call that cannot succeed must come back as a failure, mapped
    // to the failing tool, carrying a classification from the server's own
    // vocabulary and a numeric status. It does NOT pin WHICH class is correct
    // — the runtime gets that wrong today; see the known-defect note below.
    //
    // One neighbouring guarantee is deliberately NOT re-asserted here because
    // the harness already fails the run before any assertion could: a dead
    // process. StdioClient's `exit` handler calls failAll, which rejects every
    // in-flight request, so a `process.exit` inside the tool rejects this call
    // with "server exited early" rather than returning a payload to assert on.
    // A malformed CallToolResult is NOT in that category: StdioClient does no
    // result validation of its own, so such a payload would resolve and be
    // caught by the `assert.ok(failure, …)` guard below instead.
    const meRes = await client.request('tools/call', {
      name: 'get_me',
      arguments: {},
    });
    // request() rejects on a JSON-RPC error, so a resolved call always carries
    // `result`; the field is merely declared optional on the wire type.
    const me = meRes.result as { isError?: unknown; structuredContent?: unknown };
    assert.equal(me.isError, true, 'get_me must not report success against a stub token');
    const failure = (me.structuredContent as { error?: { tool?: unknown; kind?: unknown; status?: unknown } } | undefined)?.error;
    assert.ok(failure, 'a failing tool must map its error into structuredContent.error');
    // The error is attributed to the tool that produced it, not to the session
    // or the argument batch: `errorResult` stamps the requested name. A payload
    // that dropped or mis-stamped it would leave an operator unable to tell
    // which call failed, and a "some tool failed" message here would sail
    // through the kind/status guards below.
    assert.equal(failure.tool, 'get_me', 'the mapped error must name the failing tool');
    // Constrained to the server's own classification vocabulary, not merely to
    // "a non-empty string": a typo'd or unmapped class would otherwise sail
    // straight through. Deliberately NOT pinned to the *correct* class — see
    // the known-defect note below for why, and for what to tighten it to.
    assert.ok(
      typeof failure.kind === 'string' && KNOWN_ERROR_KINDS.includes(failure.kind),
      `mapped error kind must be one of [${KNOWN_ERROR_KINDS.join(', ')}], got ${JSON.stringify(failure.kind)}`,
    );
    assert.equal(typeof failure.status, 'number', 'the mapped error must carry a numeric status');

    // KNOWN DEFECT, deliberately not asserted (the runtime is wrong, the fix is
    // not ours): the real cause of this failure is authentication. GET /v1/me
    // answers 401, the client then tries to refresh, the stub refresh token
    // makes POST accounts.spotify.com/api/token answer 400, and that 400
    // replaces the original 401 — so the status->kind mapping lands on
    // `validation`. An operator with a dead token is told "received invalid
    // arguments; pass values that match the tool schema" for a call that passed
    // no arguments at all. That belongs in src/client.ts (a refresh failure
    // must not overwrite the originating 401) and in the mapping in
    // src/tools/annotations.ts, both outside this test's ownership. Once it is
    // fixed, tighten the assertion above to `assert.equal(failure.kind, 'auth')`
    // — the red-proof for that is the classifier mutation which today leaves
    // this file green (400/422 -> 'internal', or 401 -> 'not_found').
  });
});

describe('npm package artifact', () => {
  it('packs a shebanged dist entry that starts and initializes', async () => {
    const packOutput = execFileSync('npm', ['pack', '--json', '--pack-destination', tempDir], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    const [{ filename }] = JSON.parse(packOutput) as Array<{ filename: string }>;
    const packageDir = join(tempDir, 'package');
    execFileSync('tar', ['-xzf', join(tempDir, filename), '-C', tempDir]);

    const packedEntry = join(packageDir, 'dist', 'index.js');
    const firstLine = (await readFile(packedEntry, 'utf8')).split('\n', 1)[0];
    assert.equal(firstLine, '#!/usr/bin/env node', 'npm tarball must contain the executable shebang');

    // Dependencies are supplied by the consumer's install; link the checkout's
    // installed dependencies so this test remains offline while exercising the
    // actual packed entry point.
    await symlink(join(REPO_ROOT, 'node_modules'), join(packageDir, 'node_modules'), 'dir');
    const child = spawn(process.execPath, [packedEntry], {
      cwd: packageDir,
      env: {
        ...process.env,
        SPOTIFY_CLIENT_ID: 'test-client-id',
        SPOTIFY_MCP_TOKEN_FILE: join(tempDir, 'tokens.json'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const packagedClient = new StdioClient(child);
    try {
      const init = await packagedClient.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'mcp-package-smoke', version: '1.0.0' },
      });
      assert.equal(
        (init.result?.serverInfo as { name?: string } | undefined)?.name,
        'spotify-mcp',
      );
      packagedClient.notify('notifications/initialized');
    } finally {
      packagedClient.child.stdin.end();
      if (packagedClient.child.exitCode === null && packagedClient.child.signalCode === null) {
        await once(packagedClient.child, 'exit');
      }
    }
  });
});

describe('SPOTIFY_MCP_READONLY hides write-capable modules (#579)', () => {
  it('exposes no writer tools and a strictly smaller surface', async () => {
    const child = spawn('node', ['--import', 'tsx', 'src/index.ts'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        SPOTIFY_CLIENT_ID: 'test-client-id',
        SPOTIFY_MCP_TOKEN_FILE: join(tempDir, 'tokens.json'),
        SPOTIFY_MCP_READONLY: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const readOnlyClient = new StdioClient(child);
    try {
      const init = await readOnlyClient.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'mcp-readonly-smoke', version: '1.0.0' },
      });
      readOnlyClient.notify('notifications/initialized');

      const roRes = await readOnlyClient.request('tools/list');
      const roNames = new Set(((roRes.result?.tools ?? []) as Array<{ name: string }>).map((t) => t.name));
      const leaked = READONLY_WRITE_TOOLS.filter((n) => roNames.has(n));
      assert.deepEqual(leaked, [], `write tools visible under SPOTIFY_MCP_READONLY=1: [${leaked.join(', ')}]`);

      const fullRes = await client.request('tools/list');
      const fullNames = ((fullRes.result?.tools ?? []) as unknown[]).length;
      assert.ok(
        roNames.size < fullNames,
        `read-only surface (${roNames.size}) must be smaller than the full surface (${fullNames})`,
      );
    } finally {
      readOnlyClient.child.stdin.end();
      setTimeout(() => readOnlyClient.child.kill('SIGKILL'), 2000).unref();
    }
  });
});
