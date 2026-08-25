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
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const REPO_ROOT = join(import.meta.dirname, '..');

const REQUIRED_TOOLS = [
  'get_me',
  'get_album_tracks',
  'get_show_episodes',
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
];

const EXPECTED_PROMPTS = ['dj', 'playlist_from_mood', 'music_taste_summary', 'discover_weekly_alternative', 'playlist_audit', 'listening_recap', 'migrate_library', 'podcast_catchup', 'artist_deep_dive', 'triage_liked_songs'];

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
  assert.equal(init.error, undefined, `initialize failed: ${JSON.stringify(init.error)}`);
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
    assert.equal(res.error, undefined);
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
    assert.equal(res.error, undefined);
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
    assert.equal(res.error, undefined);
    const resources = res.result?.resources as Array<{ uri: string }>;
    assert.ok(Array.isArray(resources), 'resources/list must return a resources array');
    const genreResource = resources.find((r) => r.uri === 'spotify://genres');
    assert.equal(genreResource, undefined, 'spotify://genres resource must not be listed');
    assert.ok(resources.some((r) => r.uri === 'spotify://me'), 'core spotify://me resource should still be listed');
  });
});
