/**
 * The lane registry (#727).
 *
 * ## What is actually pinned here
 *
 * The bug class this suite exists to catch is a lane that resolves to the WRONG
 * playlist, or fails to resolve and gets treated as "no lane". Both are silent
 * on the caller's side: the write lands, the response is a success, and the
 * playlist that got the tracks is not the one that was named. So the write
 * assertions read the RESOLVED PLAYLIST ID off the recorded wire call, not the
 * prose — the prose is what a plausible-but-wrong implementation also produces.
 *
 * The `unreadable` assertions are the other half, and they are here because of
 * the failure AGENTS.md §6 records twice: a value that could not be read,
 * coerced into a plausible number. A lane whose playlist 404s must NOT report
 * `track_count: 0` — that tells the caller a deleted playlist is an empty one,
 * and an agent branching on the count will happily "fix" a playlist that does
 * not exist. Every test below asserts the count is `null` AND that a reason is
 * present, so a later edit cannot make it a zero with the reason quietly
 * dropped alongside it.
 *
 * One test is a regression test for a bug this suite found while being written:
 * the reader originally took `tracks.total`, the field Spotify deprecated in
 * Feb 2026, so every current playlist read as UNREADABLE. `reads items.total,
 * the current spelling` is the assertion that keeps it fixed.
 */
import './helpers/hermetic.js';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { loadLanes, resolveLane, resolveLaneTarget, lanesFilePath } from '../src/lanes.js';
import { registerLaneTools } from '../src/tools/lanes.js';
import { registerPlaylistBatchTools } from '../src/tools/playlistbatch.js';
import { snapshotDir } from '../src/tools/playlisthealth.js';
import { SpotifyApiError } from '../src/client.js';
import { makeStubClient, StubSpotifyClient, StatefulPlaylistClient } from './helpers/stub-client.js';

// ------------------------------------------------------------------- harness

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

interface RegisteredTool {
  name: string;
  /** A zod shape or a whole zod object, exactly as the registrar passed it. */
  inputSchema: unknown;
  handler: (args: unknown) => Promise<ToolResult>;
}

/**
 * Records what a registrar claims, in the two shapes the SDK accepts:
 * `tool(name, description, shape, cb)` and
 * `registerTool(name, {description, inputSchema}, cb)`. Both are used in this
 * repo, the modules under test use both, and the `inputSchema` value is itself
 * either a raw shape or a whole `z.object(...)` — the SDK normalises both. The
 * harness keeps whatever it was given and normalises at call time rather than
 * assuming one form, because a harness that assumed the wrong one would record
 * a schema that cannot parse and every lookup would fail for a reason that has
 * nothing to do with the lane registry.
 */
function fakeServer(): { server: McpServer; registered: RegisteredTool[] } {
  const registered: RegisteredTool[] = [];
  const push = (name: string, inputSchema: unknown, handler: unknown): void => {
    registered.push({ name, inputSchema, handler: handler as RegisteredTool['handler'] });
  };
  const server = {
    tool: (name: string, _description: string, shape: unknown, cb: unknown) => push(name, shape, cb),
    registerTool: (name: string, config: { inputSchema: unknown }, cb: unknown) => push(name, config.inputSchema, cb),
  };
  return { server: server as unknown as McpServer, registered };
}

function findTool(registered: RegisteredTool[], name: string): RegisteredTool {
  const tool = registered.find((t) => t.name === name);
  assert.ok(tool, `expected tool ${name} to be registered`);
  return tool;
}

function isZodSchema(value: unknown): value is z.ZodType {
  return typeof (value as { safeParse?: unknown } | null)?.safeParse === 'function';
}

/**
 * Invoke a tool through its OWN declared schema, so a test that passes a field
 * the tool does not declare fails here — naming the field — rather than
 * reaching a handler that happens to ignore it.
 */
async function invoke(tool: RegisteredTool, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const schema = isZodSchema(tool.inputSchema)
    ? tool.inputSchema
    : z.object(tool.inputSchema as Record<string, z.ZodTypeAny>);
  const parsed = schema.safeParse(args);
  assert.ok(parsed.success, `args do not satisfy ${tool.name}'s declared schema: ${parsed.error?.message ?? ''}`);
  return tool.handler(parsed.data);
}

function prose(result: ToolResult): string {
  return result.content.map((c) => c.text).join('\n');
}

function payload(result: ToolResult): Record<string, unknown> {
  assert.ok(result.structuredContent, 'every lane tool must return structuredContent');
  return result.structuredContent;
}

// ------------------------------------------------------------------ fixtures

/**
 * A playlist fixture id: a readable label rendered as 22 base62 characters.
 *
 * The length is not decoration. `classifySpotifyReference` requires exactly 22
 * base62 characters for a non-user id, so a `PL-1`-shaped fixture would be
 * refused by the very resolver these tests are about — and the refusal would
 * arrive as a manifest-read error that looks like a corrupt lane file.
 */
function pid(label: string): string {
  return label.padEnd(22, '0').slice(0, 22);
}

let root: string;
const PRIOR: Record<string, string | undefined> = {};

function setEnv(key: string, value: string): void {
  if (!(key in PRIOR)) PRIOR[key] = process.env[key];
  process.env[key] = value;
}

/** Write a manifest at the env-selected path, isolated per test. */
function writeManifest(contents: unknown): string {
  const file = lanesFilePath();
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8');
  return file;
}

/** Remove the manifest, for the "operator has never made one" cases. */
function noManifest(): void {
  rmSync(process.env.SPOTIFY_MCP_LANES_FILE as string, { force: true });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lanes-'));
  // BOTH stores are redirected per test: the lane manifest AND the health
  // snapshot directory, because `lane_status` reads the latter and a snapshot
  // left behind by a sibling test would make "no snapshot" untestable.
  setEnv('SPOTIFY_MCP_LANES_FILE', join(root, 'lanes.json'));
  setEnv('SPOTIFY_MCP_DATA_DIR', join(root, 'snapshots'));
  // `resolveRequestMarket` reads SPOTIFY_MCP_MARKET before it would call
  // `GET /me`; without it the strict stub throws on an unmodelled call that
  // has nothing to do with what these tests are about.
  setEnv('SPOTIFY_MCP_MARKET', 'GB');
});

afterEach(() => {
  for (const [key, value] of Object.entries(PRIOR)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(PRIOR)) delete PRIOR[key];
  rmSync(root, { recursive: true, force: true });
});

// ------------------------------------------------------------- the resolver

describe('lane resolution', () => {
  it('resolves a lane to a normalized playlist id', async () => {
    writeManifest({ OSM: { playlist: `spotify:playlist:${pid('osm')}` } });
    const r = resolveLane(await loadLanes(), 'OSM');
    assert.ok(r.ok);
    // Normalized, so a handler can put it in a URL without re-validating.
    assert.equal(r.playlistId, pid('osm'));
  });

  it('accepts an id, a URI and a URL for one lane, and they agree', async () => {
    writeManifest({
      ById: { playlist: pid('osm') },
      ByUri: { playlist: `spotify:playlist:${pid('osm')}` },
      ByUrl: { playlist: `https://open.spotify.com/playlist/${pid('osm')}` },
    });
    const manifest = await loadLanes();
    for (const lane of ['ById', 'ByUri', 'ByUrl']) {
      const r = resolveLane(manifest, lane);
      assert.ok(r.ok, `${lane} should resolve`);
      assert.equal(r.playlistId, pid('osm'), `${lane} should normalize to the same id`);
    }
  });

  it('matches a lane name case-insensitively', async () => {
    writeManifest({ OSM: { playlist: pid('one') } });
    const manifest = await loadLanes();
    for (const spelling of ['OSM', 'osm', 'OsM']) {
      const r = resolveLane(manifest, spelling);
      assert.ok(r.ok, `${spelling} should resolve`);
      assert.equal(r.playlistId, pid('one'));
    }
  });

  it('refuses an unknown lane naming the known lanes and the manifest path', async () => {
    const file = writeManifest({ OSM: { playlist: pid('one') }, HH: { playlist: pid('two') } });
    const r = resolveLane(await loadLanes(), 'NOPE');
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.message, /Unknown lane "NOPE"/);
    assert.match(r.message, /OSM/);
    assert.match(r.message, /HH/);
    // The PATH, not just the fact. "Unknown lane" alone cannot distinguish a
    // typo from a manifest that lives somewhere the caller did not look.
    assert.ok(r.message.includes(file), `message should name ${file}, got: ${r.message}`);
  });

  it('says the manifest is EMPTY when no lanes are defined, not merely "unknown"', async () => {
    // The two causes of "unknown lane" are a typo and no manifest at all, and
    // they have different fixes. A message that only says "unknown" makes the
    // caller guess between them.
    writeManifest({});
    const r = resolveLane(await loadLanes(), 'OSM');
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.message, /no lanes are defined/);
    assert.match(r.message, /empty manifest/);
  });

  it('refuses a lane ambiguous under case folding, naming both', async () => {
    // Resolving this by insertion order would hand back one of two playlists
    // at random — precisely the drift the registry exists to prevent.
    writeManifest({ OSM: { playlist: pid('one') }, osm: { playlist: pid('two') } });
    const r = resolveLane(await loadLanes(), 'OsM');
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.message, /ambiguous/);
    assert.match(r.message, /"OSM"/);
    assert.match(r.message, /"osm"/);
  });

  it('fails the LOAD on a playlist reference that does not parse, not the first write', async () => {
    // A typo in one entry must be visible on the first call, rather than on the
    // first write that happens to use that lane.
    writeManifest({ OSM: { playlist: 'not-a-playlist' } });
    await assert.rejects(() => loadLanes(), (err: Error) => {
      assert.ok(
        /Invalid playlist reference|unreadable|corrupt/i.test(err.message),
        `expected a manifest-read failure, got: ${err.message}`,
      );
      return true;
    });
  });

  it('treats a missing manifest as an empty one, not as corruption', async () => {
    // ENOENT is a first run. Reading it as corrupt would make every
    // lane-targeted call fail on a machine that has simply never made one.
    noManifest();
    assert.deepEqual(await loadLanes(), {});
  });
});

describe('the lane target is exactly-one-of, enforced before any request', () => {
  it('refuses when both target_playlist_id and target_lane are given, naming both', async () => {
    writeManifest({ OSM: { playlist: pid('lane') } });
    await assert.rejects(
      () => resolveLaneTarget({ target_playlist_id: 'PL-ID', target_lane: 'OSM' }),
      (err: Error) => {
        assert.match(err.message, /exactly one of target_playlist_id or target_lane/);
        // Both values named, so the caller can see which one to drop.
        assert.match(err.message, /PL-ID/);
        assert.match(err.message, /OSM/);
        return true;
      },
    );
  });

  it('refuses when neither is given, naming both ways to say it', async () => {
    await assert.rejects(() => resolveLaneTarget({}), (err: Error) => {
      assert.match(err.message, /exactly one of target_playlist_id/);
      assert.match(err.message, /target_lane/);
      return true;
    });
  });

  it('resolves a lane and reports which lane was used', async () => {
    writeManifest({ OSM: { playlist: `spotify:playlist:${pid('lane')}` } });
    const r = await resolveLaneTarget({ target_lane: 'osm' });
    assert.equal(r.playlistId, pid('lane'));
    assert.equal(r.lane, 'OSM');
  });

  it('names the SOURCE pair when the source side carries both', async () => {
    // The two sides of a move have their own field names. A message that only
    // ever named the target pair would send the caller to fix the wrong one.
    writeManifest({ FROM: { playlist: pid('from') } });
    await assert.rejects(
      () => resolveLaneTarget({ target_playlist_id: 'PL-ID', target_lane: 'FROM' }, process.env, 'source'),
      (err: Error) => {
        assert.match(err.message, /exactly one of source_playlist_id or source_lane/);
        assert.doesNotMatch(err.message, /exactly one of target_playlist_id/);
        return true;
      },
    );
  });
});

// -------------------------------------------------------------- list_lanes

describe('list_lanes', () => {
  it('reports each lane with its resolved playlist id and track count', async () => {
    writeManifest({ OSM: { playlist: pid('one'), description: 'On the move' }, HH: { playlist: pid('two') } });
    const client = makeStubClient([
      ['GET', `/playlists/${pid('one')}`, { respond: () => ({ items: { total: 42 } }) }],
      ['GET', `/playlists/${pid('two')}`, { respond: () => ({ items: { total: 7 } }) }],
    ]);
    const { server, registered } = fakeServer();
    registerLaneTools(server, client);

    const sc = payload(await invoke(findTool(registered, 'list_lanes'))) as {
      lane_count: number;
      lanes: Array<{ lane: string; playlist_id: string; track_count: number; description: string | null }>;
    };
    assert.equal(sc.lane_count, 2);
    const byLane = Object.fromEntries(sc.lanes.map((l) => [l.lane, l]));
    assert.equal(byLane.OSM.playlist_id, pid('one'));
    assert.equal(byLane.OSM.track_count, 42);
    assert.equal(byLane.OSM.description, 'On the move');
    assert.equal(byLane.HH.playlist_id, pid('two'));
    assert.equal(byLane.HH.track_count, 7);
  });

  it('reads items.total — the current spelling — not the deprecated tracks.total', async () => {
    // Regression test. The reader took `tracks.total`, which Spotify deprecated
    // in Feb 2026, so a current payload left the count null and every lane
    // reported UNREADABLE from a playlist that had been read successfully.
    writeManifest({ OSM: { playlist: pid('one') } });
    const client = makeStubClient([
      ['GET', `/playlists/${pid('one')}`, { respond: () => ({ items: { total: 42 }, tracks: { total: 999 } }) }],
    ]);
    const { server, registered } = fakeServer();
    registerLaneTools(server, client);

    const sc = payload(await invoke(findTool(registered, 'list_lanes'))) as {
      lanes: Array<{ track_count: number | null; unreadable_reason: string | null }>;
      unreadable_lane_count: number;
    };
    assert.equal(sc.lanes[0].track_count, 42, 'must read items.total');
    assert.equal(sc.lanes[0].unreadable_reason, null);
    // And emphatically not the legacy number.
    assert.notEqual(sc.lanes[0].track_count, 999);
  });

  it('still accepts a grandfathered tracks.total when that is all the payload carries', async () => {
    writeManifest({ OSM: { playlist: pid('one') } });
    const client = makeStubClient([['GET', `/playlists/${pid('one')}`, { respond: () => ({ tracks: { total: 12 } }) }]]);
    const { server, registered } = fakeServer();
    registerLaneTools(server, client);
    const sc = payload(await invoke(findTool(registered, 'list_lanes'))) as {
      lanes: Array<{ track_count: number | null }>;
    };
    assert.equal(sc.lanes[0].track_count, 12);
  });

  it('reports a lane whose playlist read FAILED as unreadable, never as 0 tracks', async () => {
    // THE assertion. A 0 here would tell the caller a deleted playlist is an
    // empty one — the exact #803 shape, one field over.
    writeManifest({ OSM: { playlist: pid('gone') } });
    const client = makeStubClient([
      ['GET', `/playlists/${pid('gone')}`, {
        respond: () => { throw new SpotifyApiError(404, 'playlist not found', undefined, 'NOT_FOUND'); },
      }],
    ]);
    const { server, registered } = fakeServer();
    registerLaneTools(server, client);

    const result = await invoke(findTool(registered, 'list_lanes'));
    const sc = payload(result) as {
      lanes: Array<{ track_count: number | null; unreadable_reason: string | null }>;
      unreadable_lane_count: number;
      unreadable_lanes?: Array<{ lane: string; reason: string | null }>;
    };
    assert.equal(sc.lanes.length, 1);
    assert.equal(sc.lanes[0].track_count, null, 'a failed read must not become 0');
    assert.ok(sc.lanes[0].unreadable_reason, 'a null count must always carry a reason');
    assert.equal(sc.unreadable_lane_count, 1, 'and it must be counted');
    assert.equal(sc.unreadable_lanes?.[0].lane, 'OSM');
    assert.match(sc.unreadable_lanes?.[0].reason as string, /404/);
    assert.match(prose(result), /UNREADABLE/);
  });

  it('reports a 200 carrying no count as unreadable, not as 0', async () => {
    // The other shape of "could not be read": the request succeeded and the
    // field is absent. Defaulting it to 0 is the same lie as a 404.
    writeManifest({ OSM: { playlist: pid('bare') } });
    const client = makeStubClient([['GET', `/playlists/${pid('bare')}`, { respond: () => ({ name: 'no count key' }) }]]);
    const { server, registered } = fakeServer();
    registerLaneTools(server, client);
    const sc = payload(await invoke(findTool(registered, 'list_lanes'))) as {
      lanes: Array<{ track_count: number | null; unreadable_reason: string | null }>;
    };
    assert.equal(sc.lanes[0].track_count, null);
    assert.match(sc.lanes[0].unreadable_reason as string, /no items\.total/);
  });

  it('redacts the failure message to status and reason', async () => {
    // An upstream error body can carry private ids; only the status and
    // Spotify's own reason code are safe to put in a payload a host will print.
    writeManifest({ OSM: { playlist: pid('private') } });
    const client = makeStubClient([
      ['GET', `/playlists/${pid('private')}`, {
        respond: () => {
          throw new SpotifyApiError(403, 'Playlist PL-PRIVATE-OUTPUT is owned by user 1122334455', undefined, 'FORBIDDEN');
        },
      }],
    ]);
    const { server, registered } = fakeServer();
    registerLaneTools(server, client);
    const sc = payload(await invoke(findTool(registered, 'list_lanes'))) as {
      lanes: Array<{ unreadable_reason: string | null }>;
    };
    const reason = sc.lanes[0].unreadable_reason as string;
    assert.match(reason, /403/);
    assert.match(reason, /FORBIDDEN/);
    assert.doesNotMatch(reason, /PL-PRIVATE-OUTPUT|1122334455/);
  });

  it('reports an empty manifest without inventing lanes or reading a playlist', async () => {
    writeManifest({});
    const client = new StubSpotifyClient();
    const { server, registered } = fakeServer();
    registerLaneTools(server, client);
    const sc = payload(await invoke(findTool(registered, 'list_lanes'))) as { lane_count: number; lanes: unknown[] };
    assert.equal(sc.lane_count, 0);
    assert.deepEqual(sc.lanes, []);
    // No lane was invented, so no playlist was read — and the strict stub would
    // have thrown on any read at all.
    assert.deepEqual(client.calls, []);
  });
});

// ------------------------------------------------------------- lane_status

describe('lane_status', () => {
  /** Write a health snapshot header where `lane_status` reads them. */
  function writeSnapshot(entry: Record<string, unknown>, filename: string): void {
    mkdirSync(snapshotDir(), { recursive: true });
    writeFileSync(join(snapshotDir(), filename), JSON.stringify(entry), 'utf8');
  }

  function laneHarness(total: number) {
    const client = makeStubClient([['GET', /^\/playlists\/[^/]+$/, { respond: () => ({ items: { total } }) }]]);
    const { server, registered } = fakeServer();
    registerLaneTools(server, client);
    return { client, registered };
  }

  it('reports drift against the NEWEST snapshot', async () => {
    writeManifest({ OSM: { playlist: pid('one') } });
    writeSnapshot({ playlist_id: pid('one'), snapshot_id: 'snap-old', created_at: '2026-09-01T00:00:00Z', total: 40 }, 'a-old.json');
    writeSnapshot({ playlist_id: pid('one'), snapshot_id: 'snap-new', created_at: '2026-09-20T00:00:00Z', total: 45 }, 'b-new.json');
    const { registered } = laneHarness(50);

    const sc = payload(await invoke(findTool(registered, 'lane_status'))) as {
      lanes: Array<{ snapshot_id: string; drift: number; staleness: string }>;
      drifted_lane_count: number;
    };
    assert.equal(sc.lanes[0].snapshot_id, 'snap-new', 'the newest snapshot must win');
    assert.equal(sc.lanes[0].drift, 5);
    assert.equal(sc.lanes[0].staleness, 'drifted');
    assert.equal(sc.drifted_lane_count, 1);
  });

  it('says drift is UNKNOWN with no snapshot — not "up to date"', async () => {
    // A lane that has never been snapshotted is not a lane that is current.
    // Reporting drift 0 would be the same coercion as reporting 0 tracks.
    writeManifest({ OSM: { playlist: pid('one') } });
    const { registered } = laneHarness(50);
    const sc = payload(await invoke(findTool(registered, 'lane_status'))) as {
      lanes: Array<{ drift: number | null; staleness: string }>;
      no_snapshot_lane_count: number;
      drifted_lane_count: number;
    };
    assert.equal(sc.lanes[0].drift, null, 'no snapshot is not zero drift');
    assert.equal(sc.lanes[0].staleness, 'no_snapshot');
    assert.equal(sc.no_snapshot_lane_count, 1);
    assert.equal(sc.drifted_lane_count, 0, 'unknown is not silently counted as undrifted');
    assert.match(prose(await invoke(findTool(registered, 'lane_status'))), /drift UNKNOWN/);
  });

  it('reports an unchanged lane as unchanged', async () => {
    writeManifest({ OSM: { playlist: pid('one') } });
    writeSnapshot({ playlist_id: pid('one'), snapshot_id: 'snap-1', created_at: '2026-09-20T00:00:00Z', total: 50 }, 's.json');
    const { registered } = laneHarness(50);
    const sc = payload(await invoke(findTool(registered, 'lane_status'))) as {
      lanes: Array<{ drift: number; staleness: string }>;
    };
    assert.equal(sc.lanes[0].drift, 0);
    assert.equal(sc.lanes[0].staleness, 'unchanged');
  });

  it('reports an unresolved lane and EXCLUDES it from the resolved count', async () => {
    // "0 drifted" only means something next to "1 lane did not resolve" — a
    // summary that counted the unresolved lane would read as a clean bill.
    writeManifest({ OSM: { playlist: pid('one') } });
    const { registered } = laneHarness(50);
    const sc = payload(await invoke(findTool(registered, 'lane_status'), { lane: 'NOPE' })) as {
      resolved_lane_count: number;
      unresolved_lane_count: number;
      unresolved_lanes?: Array<{ lane: string; reason: string | null }>;
    };
    assert.equal(sc.resolved_lane_count, 0);
    assert.equal(sc.unresolved_lane_count, 1);
    assert.equal(sc.unresolved_lanes?.[0].lane, 'NOPE');
    assert.match(sc.unresolved_lanes?.[0].reason as string, /Unknown lane/);
  });

  it('reports an unreadable playlist as unreadable and does NOT claim it is undrifted', async () => {
    writeManifest({ OSM: { playlist: pid('gone') } });
    writeSnapshot({ playlist_id: pid('gone'), snapshot_id: 'snap-1', created_at: '2026-09-20T00:00:00Z', total: 50 }, 's.json');
    const client = makeStubClient([
      ['GET', `/playlists/${pid('gone')}`, { respond: () => { throw new SpotifyApiError(404, 'gone', undefined, 'NOT_FOUND'); } }],
    ]);
    const { server, registered } = fakeServer();
    registerLaneTools(server, client);

    const sc = payload(await invoke(findTool(registered, 'lane_status'))) as {
      lanes: Array<{ track_count: number | null; drift: number | null; staleness: string }>;
      unreadable_lane_count: number;
      drifted_lane_count: number;
    };
    assert.equal(sc.lanes[0].track_count, null);
    assert.equal(sc.lanes[0].drift, null, 'a failed read is not zero drift');
    assert.equal(sc.lanes[0].staleness, 'unreadable');
    assert.equal(sc.unreadable_lane_count, 1);
    assert.equal(sc.drifted_lane_count, 0);
  });

  it('skips an unparseable snapshot file rather than letting it hide a good one', async () => {
    // A damaged file must not shadow a newer, readable snapshot behind it.
    writeManifest({ OSM: { playlist: pid('one') } });
    writeSnapshot({ playlist_id: pid('one'), snapshot_id: 'snap-good', created_at: '2026-09-20T00:00:00Z', total: 45 }, 'a-good.json');
    mkdirSync(snapshotDir(), { recursive: true });
    writeFileSync(join(snapshotDir(), 'b-broken.json'), '{ not json', 'utf8');
    const { registered } = laneHarness(50);

    const sc = payload(await invoke(findTool(registered, 'lane_status'))) as {
      lanes: Array<{ snapshot_id: string; drift: number }>;
    };
    assert.equal(sc.lanes[0].snapshot_id, 'snap-good');
    assert.equal(sc.lanes[0].drift, 5);
  });

  it('issues only GETs — no write of any kind', async () => {
    // The strict stub THROWS on an unregistered method, so a POST/PUT/DELETE
    // from either tool fails here rather than passing as an extra read.
    writeManifest({ OSM: { playlist: pid('one') } });
    const client = new StubSpotifyClient();
    client.get_(`/playlists/${pid('one')}`, { respond: () => ({ items: { total: 3 } }) });
    const { server, registered } = fakeServer();
    registerLaneTools(server, client);

    await invoke(findTool(registered, 'list_lanes'));
    await invoke(findTool(registered, 'lane_status'));
    assert.deepEqual(client.calls.map((c) => c.method), ['GET', 'GET']);
  });
});

// ------------------------------------------ the lane target on a real write

describe('a lane-targeted batch add writes to the RESOLVED playlist', () => {
  /**
   * The stateful client models the whole `/playlists/{id}` family, so the write
   * path (the item read for dedupe, the POST, and the receipt's own
   * verification walk) runs end to end without a permissive stub answering for
   * an id nobody seeded. An id the handler resolves wrongly is not merely a
   * wrong assertion — it is a throw naming the unseeded id.
   */
  function batchHarness(playlistId: string, rows: string[] = []) {
    const client = new StatefulPlaylistClient();
    client.seedPlaylist(playlistId, { rows });
    client.route('GET', '/me', { respond: () => ({ country: 'GB' }) });
    const { server, registered } = fakeServer();
    registerPlaylistBatchTools(server, client);
    return { client, registered };
  }

  it('POSTs to the playlist the lane names, never to the lane string', async () => {
    writeManifest({ OSM: { playlist: `spotify:playlist:${pid('resolved')}` } });
    const { client, registered } = batchHarness(pid('resolved'));
    const result = await invoke(findTool(registered, 'batch_add_to_playlist'), {
      target_lane: 'OSM',
      source_uris: ['spotify:track:AAAA'],
      dry_run: false,
    });
    assert.deepEqual(client.writtenUris(pid('resolved')), ['spotify:track:AAAA']);
    // The lane label reached neither the write path nor any read path.
    assert.ok(
      client.calls.every((c) => !c.path.includes('OSM')),
      'the lane label must never reach Spotify as a path',
    );
    assert.equal((payload(result) as { target_playlist: string }).target_playlist, pid('resolved'));
  });

  it('resolves a lane whose manifest entry is a URL', async () => {
    writeManifest({ OSM: { playlist: `https://open.spotify.com/playlist/${pid('fromurl')}` } });
    const { client, registered } = batchHarness(pid('fromurl'));
    await invoke(findTool(registered, 'batch_add_to_playlist'), {
      target_lane: 'OSM',
      source_uris: ['spotify:track:BBBB'],
      dry_run: false,
    });
    assert.deepEqual(client.writtenUris(pid('fromurl')), ['spotify:track:BBBB']);
  });

  it('refuses an unknown lane and issues NO write at all', async () => {
    // The load-bearing safety property: a lane that does not resolve must not
    // degrade into "no target specified" and then into some default playlist.
    writeManifest({ OSM: { playlist: pid('one') } });
    const { client, registered } = batchHarness(pid('one'));
    await assert.rejects(
      () => invoke(findTool(registered, 'batch_add_to_playlist'), {
        target_lane: 'TYPO',
        source_uris: ['spotify:track:AAAA'],
        dry_run: false,
      }),
      (err: Error) => {
        assert.match(err.message, /Unknown lane "TYPO"/);
        assert.match(err.message, /OSM/);
        return true;
      },
    );
    assert.deepEqual(client.calls.filter((c) => c.method !== 'GET'), []);
  });

  it('refuses a missing manifest rather than writing anywhere', async () => {
    noManifest();
    const { client, registered } = batchHarness(pid('one'));
    await assert.rejects(
      () => invoke(findTool(registered, 'batch_add_to_playlist'), {
        target_lane: 'OSM',
        source_uris: ['spotify:track:AAAA'],
        dry_run: false,
      }),
      /no lanes are defined/,
    );
    assert.deepEqual(client.calls.filter((c) => c.method !== 'GET'), []);
  });

  it('still writes to an explicit id when no manifest exists at all', async () => {
    // The no-manifest fallback must be exactly the pre-#727 behaviour: the
    // lane feature is additive, not a new requirement. Only the id the caller
    // passed was seeded, so the strict stateful client would THROW if the
    // handler resolved anything else.
    noManifest();
    const { client, registered } = batchHarness(pid('explicit'));
    await invoke(findTool(registered, 'batch_add_to_playlist'), {
      target_playlist_id: pid('explicit'),
      source_uris: ['spotify:track:AAAA'],
      dry_run: false,
    });
    assert.deepEqual(client.writtenUris(pid('explicit')), ['spotify:track:AAAA']);
  });

  it('names both target fields when both are given, and writes nothing', async () => {
    writeManifest({ OSM: { playlist: pid('one') } });
    const { client, registered } = batchHarness(pid('one'));
    await assert.rejects(
      () => invoke(findTool(registered, 'batch_add_to_playlist'), {
        target_playlist_id: pid('one'),
        target_lane: 'OSM',
        source_uris: ['spotify:track:AAAA'],
        dry_run: false,
      }),
      /exactly one of target_playlist_id or target_lane/,
    );
    assert.deepEqual(client.calls.filter((c) => c.method !== 'GET'), []);
  });

  it('previews a lane-targeted add without writing, naming the resolved playlist', async () => {
    // The preview must show the RESOLVED id, not the lane label — a caller who
    // checks the preview is meant to be checking the playlist it will write to.
    // (`playlistbatch` uses the bare `DryRun` fragment, so `dry_run` is passed
    // explicitly here rather than relied on as a default.)
    writeManifest({ OSM: { playlist: pid('one') } });
    const { client, registered } = batchHarness(pid('one'));
    const result = await invoke(findTool(registered, 'batch_add_to_playlist'), {
      target_lane: 'OSM',
      source_uris: ['spotify:track:AAAA'],
      dry_run: true,
    });
    assert.equal((payload(result) as { dry_run: boolean }).dry_run, true);
    assert.ok(
      prose(result).includes(pid('one')),
      'the preview must name the resolved playlist, not the lane label',
    );
    assert.doesNotMatch(prose(result), /\bOSM\b/, 'the lane label alone is not enough to verify');
    assert.deepEqual(client.calls.filter((c) => c.method !== 'GET'), []);
  });
});

describe('a lane-targeted move resolves BOTH sides independently', () => {
  function moveHarness(fromId: string, toId: string) {
    const client = new StatefulPlaylistClient();
    client.seedPlaylist(fromId, { rows: ['spotify:track:AAAA'] });
    client.seedPlaylist(toId, { rows: [] });
    client.route('GET', '/me', { respond: () => ({ country: 'GB' }) });
    const { server, registered } = fakeServer();
    registerPlaylistBatchTools(server, client);
    return { client, registered };
  }

  it('reads the source lane and writes the target lane, to two different playlists', async () => {
    writeManifest({ FROM: { playlist: pid('from') }, TO: { playlist: pid('to') } });
    const { client, registered } = moveHarness(pid('from'), pid('to'));
    await invoke(findTool(registered, 'move_items_between_playlists'), {
      source_lane: 'FROM',
      target_lane: 'TO',
      mode: 'copy',
      dry_run: false,
    });
    assert.ok(
      client.calls.some((c) => c.method === 'GET' && c.path.includes(pid('from'))),
      'the SOURCE lane must be the playlist read',
    );
    assert.deepEqual(client.writtenUris(pid('to')), ['spotify:track:AAAA']);
    assert.deepEqual(client.writtenUris(pid('from')), [], 'copy mode leaves the source intact');
  });

  it('refuses when the source side has both fields, naming the SOURCE pair', async () => {
    writeManifest({ FROM: { playlist: pid('from') } });
    const { client, registered } = moveHarness(pid('from'), pid('to'));
    await assert.rejects(
      () => invoke(findTool(registered, 'move_items_between_playlists'), {
        source_playlist_id: pid('from'),
        source_lane: 'FROM',
        target_playlist_id: pid('to'),
        mode: 'copy',
        dry_run: false,
      }),
      (err: Error) => {
        assert.match(err.message, /exactly one of source_playlist_id or source_lane/);
        assert.doesNotMatch(err.message, /exactly one of target_playlist_id/);
        return true;
      },
    );
    assert.deepEqual(client.calls.filter((c) => c.method !== 'GET'), []);
  });

  it('mixes a lane on one side with an explicit id on the other', async () => {
    // The point of the feature: the caller only has a label for one playlist.
    writeManifest({ TO: { playlist: pid('to') } });
    const { client, registered } = moveHarness(pid('from'), pid('to'));
    await invoke(findTool(registered, 'move_items_between_playlists'), {
      source_playlist_id: pid('from'),
      target_lane: 'TO',
      mode: 'copy',
      dry_run: false,
    });
    assert.deepEqual(client.writtenUris(pid('to')), ['spotify:track:AAAA']);
  });
});
