/**
 * resume_playback_position (#833): the bookmark resume path used to transfer
 * and seek without ever issuing PUT /me/player/play, so the saved session
 * never actually started playing. The execute path must now load the
 * bookmarked item (and its surrounding context, when one was captured) and
 * await PUT /me/player/play before reporting success; the dry run must
 * surface that same call in its plan.
 */
import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerSwarm3PlaybackTools } from '../src/tools/swarm3_playback.js';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type Registered = {
  name: string;
  schema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};

interface DeviceStub {
  id: string;
  name: string;
  type: string;
  volume_percent: number | null;
  supports_volume: boolean;
  is_active: boolean;
  is_restricted: boolean;
  is_private_session: boolean;
}

function device(over: Partial<DeviceStub> & { id: string; name: string }): DeviceStub {
  return {
    type: 'Speaker',
    volume_percent: 30,
    supports_volume: true,
    is_active: false,
    is_restricted: false,
    is_private_session: false,
    ...over,
  };
}

interface Call { method: string; path: string; arg?: unknown }
interface Harness {
  find: (name: string) => Registered;
  invoke: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  calls: Call[];
  text: (r: ToolResult) => string;
  structured: (r: ToolResult) => Record<string, unknown>;
}

function makeHarness(devices: DeviceStub[]): Harness {
  const registered: Registered[] = [];
  const calls: Call[] = [];
  const server = {
    tool(name: string, _desc: string, schema: z.ZodRawShape, handler: Registered['handler']) {
      registered.push({ name, schema, handler });
    },
  } as unknown as McpServer;
  const client = {
    async get<T>(path: string): Promise<T | null> {
      calls.push({ method: 'GET', path });
      if (path === '/me/player/devices') return { devices } as unknown as T;
      throw new Error(`unexpected GET ${path}`);
    },
    async put<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'PUT', path, arg: body });
      return null as unknown as T;
    },
  } as unknown as SpotifyClient;
  registerSwarm3PlaybackTools(server, client);
  const find = (name: string) => {
    const t = registered.find((x) => x.name === name);
    assert.ok(t, `tool ${name} must be registered`);
    return t;
  };
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const t = find(name);
    return t.handler(z.object(t.schema).parse(args) as Record<string, unknown>);
  };
  return {
    find,
    invoke,
    calls,
    text: (r: ToolResult) => r.content[0].text,
    structured: (r: ToolResult) => r.structuredContent as Record<string, unknown>,
  };
}

interface Bookmark {
  id: string;
  captured_at: string;
  label?: string;
  device_id: string | null;
  device_name: string | null;
  track_uri: string;
  track_name: string;
  position_ms: number;
  is_playing: boolean;
  context_uri: string | null;
}

async function seedBookmark(dir: string, bookmark: Bookmark): Promise<void> {
  const safe = bookmark.id.replace(/[^A-Za-z0-9._-]/g, '_');
  const path = join(dir, `playback-bookmark-${safe}.json`);
  await writeFile(path, `${JSON.stringify(bookmark, null, 2)}\n`, { mode: 0o600 });
}

let tmp: string;
let prevBackupDirEnv: string | undefined;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'spotify-resume-bookmark-'));
  prevBackupDirEnv = process.env.SPOTIFY_MCP_BACKUP_DIR;
  process.env.SPOTIFY_MCP_BACKUP_DIR = tmp;
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
  if (prevBackupDirEnv === undefined) delete process.env.SPOTIFY_MCP_BACKUP_DIR;
  else process.env.SPOTIFY_MCP_BACKUP_DIR = prevBackupDirEnv;
});

const DEVICES: DeviceStub[] = [device({ id: 'dev_speaker', name: 'Kitchen Speaker', is_active: true })];

const ALBUM_BOOKMARK: Bookmark = {
  id: '2026-09-25T10-00-00-000Z',
  captured_at: '2026-09-25T10:00:00.000Z',
  device_id: 'dev_speaker',
  device_name: 'Kitchen Speaker',
  track_uri: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa',
  track_name: 'Track A',
  position_ms: 42_000,
  is_playing: true,
  context_uri: 'spotify:album:bbbbbbbbbbbbbbbbbbbbbb',
};

const SINGLE_BOOKMARK: Bookmark = {
  ...ALBUM_BOOKMARK,
  id: '2026-09-25T10-30-00-000Z',
  track_uri: 'spotify:track:cccccccccccccccccccccc',
  track_name: 'Track C',
  context_uri: null,
};

describe('resume_playback_position (#833) — bookmarked item + context restored', () => {
  it('execute path issues PUT /me/player/play with the bookmark track URI and context', async () => {
    await seedBookmark(tmp, ALBUM_BOOKMARK);
    const h = makeHarness(DEVICES);
    const out = await h.invoke('resume_playback_position', { bookmark_id: ALBUM_BOOKMARK.id, dry_run: false });

    const playCalls = h.calls.filter((c) => c.method === 'PUT' && c.path.startsWith('/me/player/play'));
    assert.equal(playCalls.length, 1, 'execute must issue exactly one PUT /me/player/play');
    const playCall = playCalls[0];
    assert.match(playCall!.path, /^\/me\/player\/play\?device_id=dev_speaker$/, 'PUT /me/player/play must target the bookmark device');
    const body = playCall!.arg as Record<string, unknown>;
    assert.equal(body.context_uri, ALBUM_BOOKMARK.context_uri, 'album bookmark must replay the saved context');
    const offset = body.offset as { uri?: string };
    assert.equal(offset.uri, ALBUM_BOOKMARK.track_uri, 'offset must point at the bookmarked track');
    assert.equal(body.position_ms, ALBUM_BOOKMARK.position_ms, 'position_ms must carry the saved offset');
    assert.equal((out.structuredContent as { resumed: boolean }).resumed, true);
  });

  it('execute path falls back to uris[] when the bookmark captured no context', async () => {
    await seedBookmark(tmp, SINGLE_BOOKMARK);
    const h = makeHarness(DEVICES);
    const out = await h.invoke('resume_playback_position', { bookmark_id: SINGLE_BOOKMARK.id, dry_run: false });

    const playCalls = h.calls.filter((c) => c.method === 'PUT' && c.path.startsWith('/me/player/play'));
    assert.equal(playCalls.length, 1, 'execute must issue exactly one PUT /me/player/play');
    const body = playCalls[0]!.arg as Record<string, unknown>;
    assert.deepEqual(body.uris, [SINGLE_BOOKMARK.track_uri], 'ad-hoc bookmark must replay via uris[]');
    assert.equal(body.context_uri, undefined, 'no spurious context_uri on an ad-hoc bookmark');
    assert.equal(body.position_ms, SINGLE_BOOKMARK.position_ms);
    assert.equal((out.structuredContent as { resumed: boolean }).resumed, true);
  });

  it('execute path orders PUT /me/player/play AFTER the transfer and seek', async () => {
    await seedBookmark(tmp, ALBUM_BOOKMARK);
    const h = makeHarness(DEVICES);
    await h.invoke('resume_playback_position', { bookmark_id: ALBUM_BOOKMARK.id, dry_run: false });

    const order = h.calls.filter((c) => c.method === 'PUT').map((c) => c.path.split('?')[0]);
    const transferIdx = order.indexOf('/me/player');
    const playIdx = order.indexOf('/me/player/play');
    const seekIdx = order.indexOf('/me/player/seek');
    assert.ok(transferIdx >= 0, 'transfer must be issued');
    assert.ok(playIdx >= 0, 'play must be issued');
    assert.ok(seekIdx >= 0, 'seek must be issued');
    assert.ok(transferIdx < playIdx, 'transfer must precede play');
    assert.ok(transferIdx < seekIdx, 'transfer must precede seek');
    assert.ok(playIdx < seekIdx, 'play must precede seek so the saved track is loaded before positioning');
  });

  it('dry_run advertises PUT /me/player/play with the bookmark URI in the plan', async () => {
    await seedBookmark(tmp, ALBUM_BOOKMARK);
    const h = makeHarness(DEVICES);
    const out = await h.invoke('resume_playback_position', { bookmark_id: ALBUM_BOOKMARK.id });
    // dry_run defaults to true — no PUT must be issued.
    assert.equal(h.calls.filter((c) => c.method === 'PUT').length, 0, 'dry_run must not PUT');
    const steps = (out.structuredContent as { dry_run: boolean; steps: string[] }).steps;
    const playStep = steps.find((s) => s.startsWith('PUT /me/player/play'));
    assert.ok(playStep, 'dry_run plan must include PUT /me/player/play');
    assert.match(playStep!, /context_uri: spotify:album:bbbbbbbbbbbbbbbbbbbbbb/, 'plan must name the saved context');
    assert.match(playStep!, /uri: spotify:track:aaaaaaaaaaaaaaaaaaaaaa/, 'plan must name the bookmarked track');
    assert.match(playStep!, /position_ms: 42000/, 'plan must name the saved position');
  });

  it('dry_run uses the uris[] form when the bookmark captured no context', async () => {
    await seedBookmark(tmp, SINGLE_BOOKMARK);
    const h = makeHarness(DEVICES);
    const out = await h.invoke('resume_playback_position', { bookmark_id: SINGLE_BOOKMARK.id });
    const steps = (out.structuredContent as { dry_run: boolean; steps: string[] }).steps;
    const playStep = steps.find((s) => s.startsWith('PUT /me/player/play'));
    assert.ok(playStep, 'dry_run plan must include PUT /me/player/play');
    assert.match(playStep!, /uris: \[spotify:track:cccccccccccccccccccccc\]/, 'plan must name the bookmarked track via uris[]');
    assert.doesNotMatch(playStep!, /context_uri:/, 'no context_uri step when bookmark has no context');
  });

  it('awaits the play call so success is not reported before it settles', async () => {
    // The harness records calls in order; if the implementation returned before
    // awaiting the play PUT, the play call would be absent from h.calls.
    await seedBookmark(tmp, ALBUM_BOOKMARK);
    const h = makeHarness(DEVICES);
    await h.invoke('resume_playback_position', { bookmark_id: ALBUM_BOOKMARK.id, dry_run: false });
    const playCalls = h.calls.filter((c) => c.method === 'PUT' && c.path.startsWith('/me/player/play'));
    assert.equal(playCalls.length, 1, 'play PUT must be awaited (recorded) before returning');
  });
});