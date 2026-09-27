/**
 * #847 — the queue-read collapse.
 *
 * Eight registered tools answered "what is in my queue" from the same
 * `GET /me/player/queue`. Six of them are gone; `get_queue` (with `view` and
 * `include`) and `peek_next` are what is left. This file pins the three claims
 * that collapse is only worth making if they are all true:
 *
 *   1. ONE read. `include: ['runtime','duplicates','profile']` must issue
 *      exactly one `GET /me/player/queue` — asserted on the stub call log, not
 *      inferred from the code reading like it does.
 *   2. The UNION. What the six retired tools each reported is still in what
 *      `get_queue` returns, value for value.
 *   3. A clear failure. A caller who sends a retired name gets a typed
 *      `retired_tool_alias` refusal whose `fix` names the exact replacement
 *      call — never a silent rewrite to a different question.
 *
 * Plus the honesty clause from #803: a runtime whose current-track position
 * could not be read reports `null` and says why. It must never report 0.
 */
import './helpers/hermetic.js';

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SpotifyClient } from '../src/client.js';
import { registerManifestModules, installToolErrorBoundary, applyToolAnnotations } from '../src/tools/annotations.js';
import { RETIRED_QUEUE_TOOLS, RETIRED_QUEUE_TOOL_NAMES } from '../src/shaping.js';
import { registerPlaybackTools } from '../src/tools/playback.js';

// ---------------------------------------------------------------- fixtures

type ToolContent = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

type RegisteredTool = {
  name: string;
  description: string;
  schema: Record<string, { safeParse(value: unknown): { success: boolean; data?: unknown } }>;
  handler: (args: Record<string, unknown>) => Promise<ToolContent>;
};

type Call = { method: string; path: string };

const track = (n: number, name: string, artist: string, album: string, ms: number, uri?: string) => ({
  id: `t${n}`, name, uri: uri ?? `spotify:track:t${n}`, type: 'track', duration_ms: ms,
  artists: [{ id: `a${artist}`, name: artist, uri: `spotify:artist:a${artist}` }],
  album: { id: `al${album}`, name: album, uri: `spotify:album:al${album}` },
});
const episode = (n: number, name: string, show: string, ms: number) => ({
  id: `e${n}`, name, uri: `spotify:episode:e${n}`, type: 'episode', duration_ms: ms,
  show: { id: `s${show}`, name: show, uri: `spotify:show:s${show}` },
});

/**
 * Four upcoming items with a genuine duplicate (positions 1 and 2 share a URI),
 * one episode, and a playing track — so duplicates, the track/episode mix and
 * the single-artist run all have something to find.
 */
const QUEUE = {
  currently_playing: track(0, 'Now One', 'Alpha', 'AlbumA', 200000),
  queue: [
    track(1, 'Next One', 'Beta', 'AlbumB', 210000),
    track(2, 'Next One', 'Beta', 'AlbumB', 210000, 'spotify:track:t1'),
    episode(3, 'Ep One', 'ShowX', 1800000),
    track(4, 'Next Two', 'Gamma', 'AlbumC', 240000),
  ],
};
const STATE = {
  is_playing: true, progress_ms: 50000, shuffle_state: false, repeat_state: 'off',
  timestamp: 1750000000000,
  device: { id: 'd1', name: 'Desk', type: 'Computer', is_active: true, volume_percent: 50, supports_volume: true },
  item: QUEUE.currently_playing, currently_playing_type: 'track',
  context: { uri: 'spotify:playlist:pl1', type: 'playlist' },
};

interface HarnessOptions {
  /** Throw on `GET /me/player`, to exercise the unreadable-runtime path. */
  failPlaybackState?: boolean;
  /** Answer `GET /me/player/queue` with an empty queue. */
  emptyQueue?: boolean;
  /** A different queue fixture, for the cases the shared one cannot express. */
  queue?: { currently_playing: unknown; queue: unknown[] };
  /** Override the current track's elapsed time, which sets every timeline offset. */
  progressMs?: number;
  /** Answer `GET /me/player` with nothing playing (an answered "idle", not a failure). */
  nothingPlaying?: boolean;
}

function makeHarness(opts: HarnessOptions = {}) {
  const calls: Call[] = [];
  const client = {
    get: async (path: string) => {
      calls.push({ method: 'GET', path });
      if (path === '/me/player/queue') {
        if (opts.emptyQueue) return { currently_playing: null, queue: [] };
        return opts.queue ?? QUEUE;
      }
      if (path === '/me/player') {
        if (opts.failPlaybackState) throw new Error('simulated playback-state failure');
        return {
          ...STATE,
          progress_ms: opts.progressMs ?? STATE.progress_ms,
          item: opts.nothingPlaying ? null : STATE.item,
        };
      }
      if (path.startsWith('/playlists/')) return { name: 'Focus Mix' };
      return null;
    },
    post: async (path: string) => { calls.push({ method: 'POST', path }); return null; },
    put: async (path: string) => { calls.push({ method: 'PUT', path }); },
    delete: async (path: string) => { calls.push({ method: 'DELETE', path }); },
    getAllPages: async () => [],
  };
  const registered: RegisteredTool[] = [];
  const server = {
    tool: (name: string, description: string, schema: RegisteredTool['schema'], handler: RegisteredTool['handler']) =>
      registered.push({ name, description, schema, handler }),
  };
  registerPlaybackTools(server as unknown as Parameters<typeof registerPlaybackTools>[0], client as unknown as Parameters<typeof registerPlaybackTools>[1]);
  return { registered, calls };
}

function findTool(registered: RegisteredTool[], name: string): RegisteredTool {
  const tool = registered.find((t) => t.name === name);
  assert.ok(tool, `expected tool ${name} to be registered`);
  return tool;
}

/** Invoke through the tool's own declared schema, so `.default()`s apply. */
async function invoke(tool: RegisteredTool, args: Record<string, unknown> = {}): Promise<ToolContent> {
  const parsed: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(tool.schema ?? {})) {
    const result = spec.safeParse(args[key]);
    parsed[key] = result.success ? result.data : args[key];
  }
  return tool.handler(parsed);
}

const text = (r: ToolContent): string => r.content.map((c) => c.text).join('\n');
const structured = (r: ToolContent): Record<string, unknown> => r.structuredContent ?? {};

// ---------------------------------------------------------------- the tests

describe('#847 queue-read collapse', () => {
  it('reads GET /me/player/queue exactly ONCE for every view and include combination', async () => {
    const combinations: Array<Record<string, unknown>> = [
      {},
      { view: 'raw' },
      { view: 'enriched' },
      { include: ['runtime'] },
      { include: ['duplicates'] },
      { include: ['profile'] },
      { view: 'enriched', include: ['runtime', 'duplicates', 'profile'] },
      { view: 'enriched', include: ['runtime', 'duplicates', 'profile'], response_format: 'json' },
    ];
    for (const args of combinations) {
      const { registered, calls } = makeHarness();
      await invoke(findTool(registered, 'get_queue'), args);
      const queueReads = calls.filter((c) => c.path === '/me/player/queue');
      assert.equal(
        queueReads.length, 1,
        `get_queue(${JSON.stringify(args)}) issued ${queueReads.length} queue reads: ${calls.map((c) => c.path).join(', ')}`,
      );
    }
  });

  it('the runtime analysis is the ONLY include that costs a second request, and it is a different endpoint', async () => {
    // The acceptance criterion is about the QUEUE endpoint, so this pins the
    // full cost too: a reader must be able to see which includes are free.
    const cost = async (args: Record<string, unknown>) => {
      const { registered, calls } = makeHarness();
      await invoke(findTool(registered, 'get_queue'), args);
      return calls.map((c) => c.path);
    };
    assert.deepEqual(await cost({ include: ['duplicates', 'profile'] }), ['/me/player/queue']);
    assert.deepEqual(await cost({ view: 'enriched', include: ['runtime'] }), ['/me/player/queue', '/me/player', '/playlists/pl1']);
    // One GET /me/player serves BOTH the enriched context and the runtime's
    // current-track position — asking for both must not read it twice.
    const both = await cost({ view: 'enriched', include: ['runtime'] });
    assert.equal(both.filter((p) => p === '/me/player').length, 1, 'playback state was read more than once');
  });

  it('returns the union of the six retired tools, value for value', async () => {
    const { registered } = makeHarness();
    const result = await invoke(findTool(registered, 'get_queue'), {
      view: 'enriched',
      include: ['runtime', 'duplicates', 'profile'],
      response_format: 'json',
    });
    const out = structured(result);

    // get_queue_snapshot / queue_runtime_report
    const runtime = out.runtime as Record<string, unknown>;
    assert.equal(runtime.upcoming_count, 4);
    assert.equal(runtime.total_runtime_ms, 210000 + 210000 + 1800000 + 240000);
    assert.equal(runtime.average_runtime_ms, Math.round(2460000 / 4));
    assert.deepEqual(runtime.longest, { uri: 'spotify:episode:e3', name: 'Ep One', duration_ms: 1800000 });
    assert.deepEqual(runtime.shortest, { uri: 'spotify:track:t1', name: 'Next One', duration_ms: 210000 });
    // 200,000ms track with 50,000ms played = 150,000ms left.
    assert.equal(runtime.current_track_remaining_ms, 150000);
    assert.equal(runtime.estimated_total_wait_ms, 2460000 + 150000);
    assert.equal(runtime.current_track_remaining_error, null);

    // queue_duplicate_check
    const duplicates = out.duplicates as Record<string, unknown>;
    assert.equal(duplicates.total_redundant, 1);
    assert.equal(duplicates.wasted_runtime_ms, 210000);
    assert.deepEqual(duplicates.duplicate_groups, [{
      uri: 'spotify:track:t1', name: 'Next One', occurrences: 2, positions: [1, 2], wasted_runtime_ms: 210000,
    }]);

    // queue_profile — counted over the playing item too, as the retired tool did.
    assert.deepEqual(out.profile, {
      total: 5, tracks: 4, episodes: 1, unique_artists: 3, unique_albums: 3, unique_shows: 1,
      longest_artist_block: { artist: 'Beta', tracks: 2 },
    });

    // describe_queue
    assert.equal(out.context_label, 'playlist "Focus Mix"');
    assert.equal(out.total_remaining_ms, 2460000);
    // get_queue's own payload is still there, unrenamed.
    assert.equal((out.items as unknown[]).length, 4);
    assert.equal(out.truncated, false);
  });

  it('analyses the WHOLE queue, never the truncated page', async () => {
    // A total computed over the first `max_results` rows is a wrong number
    // wearing the right field name (#803). This is the assertion that would
    // catch a truncation applied before the analysis.
    const { registered } = makeHarness();
    const out = structured(await invoke(findTool(registered, 'get_queue'), {
      max_results: 2,
      include: ['runtime', 'duplicates', 'profile'],
      response_format: 'json',
    }));
    assert.equal((out.items as unknown[]).length, 2, 'the item list should be truncated');
    assert.equal(out.truncated, true);
    assert.equal(out.remaining, 2);
    // ...while the analyses still see all four.
    assert.equal((out.runtime as Record<string, unknown>).upcoming_count, 4);
    assert.equal((out.runtime as Record<string, unknown>).total_runtime_ms, 2460000);
    assert.deepEqual((out.duplicates as Record<string, unknown>).duplicate_groups, [{
      uri: 'spotify:track:t1', name: 'Next One', occurrences: 2, positions: [1, 2], wasted_runtime_ms: 210000,
    }]);
    assert.equal((out.profile as Record<string, unknown>).total, 5);
  });

  it('reports an UNREAD current-track position as null with a reason, never 0 (#803)', async () => {
    const { registered } = makeHarness({ failPlaybackState: true });
    const out = structured(await invoke(findTool(registered, 'get_queue'), {
      include: ['runtime'],
      response_format: 'json',
    }));
    const runtime = out.runtime as Record<string, unknown>;
    // The parts that came from the queue read are still reported...
    assert.equal(runtime.upcoming_count, 4);
    assert.equal(runtime.total_runtime_ms, 2460000);
    // ...and the part that did not is absent, not zero.
    assert.equal(runtime.current_track_remaining_ms, null);
    assert.equal(runtime.estimated_total_wait_ms, null);
    assert.equal(runtime.current_track_remaining_error, 'simulated playback-state failure');
    assert.match(text(await invoke(findTool(registered, 'get_queue'), { include: ['runtime'] })), /Current track remaining: unknown/);
  });

  it('a raw get_queue answers exactly what it answered before the collapse', async () => {
    // Byte-for-byte against the pre-#847 output for the argument sets the
    // retired callers actually used. `view: 'raw'` and no `include` must be a
    // no-op on the wire, not merely equivalent in prose.
    const { registered } = makeHarness();
    const tool = findTool(registered, 'get_queue');
    for (const args of [{}, { max_results: 2 }, { response_format: 'detailed' }, { response_format: 'json' }]) {
      const bare = await invoke(tool, args);
      const explicit = await invoke(tool, { ...args, view: 'raw', include: [] });
      assert.deepEqual(structured(bare), structured(explicit), `view:'raw' with no include changed the answer for ${JSON.stringify(args)}`);
      assert.deepEqual(text(bare), text(explicit), `view:'raw' with no include changed the prose for ${JSON.stringify(args)}`);
    }
  });

  it('the two survivors carry a decision rule and no "See also" chain', async () => {
    const { registered } = makeHarness();
    const getQueue = findTool(registered, 'get_queue').description;
    // The issue's host-visible check: a rule that says WHICH to use, and no
    // chain of cross-references standing in for one.
    assert.doesNotMatch(getQueue, /see also/i, 'get_queue description still carries a See-also chain');
    // The rule has to be the tool's OWN job described in the tool's own voice:
    // "this is the queue-contents call" plus the one sibling that is not.
    assert.match(getQueue, /use this for queue contents/i);
    assert.match(getQueue, /use peek_next for a short lookahead/i);

    // The same check on the OTHER survivor, read off the real registry rather
    // than off the module that registers it, so a rename elsewhere cannot make
    // it vacuous.
    const server = new McpServer({ name: 'queue-descriptions', version: '0.0.0' });
    await registerManifestModules(server, new SpotifyClient(), { readOnly: false, disableOverrides: new Set<string>(), isModuleActive: () => true, scopeBlocked: () => false });
    applyToolAnnotations(server);
    installToolErrorBoundary(server);
    const client = new Client({ name: 'queue-desc-client', version: '0.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    const tools = (await client.listTools()).tools;
    const names = new Set(tools.map((t) => t.name));

    for (const retired of RETIRED_QUEUE_TOOL_NAMES) {
      assert.ok(!names.has(retired), `${retired} is still registered`);
    }
    for (const survivor of ['get_queue', 'peek_next']) {
      assert.ok(names.has(survivor), `${survivor} must be registered`);
    }
    for (const name of RETIRED_QUEUE_TOOL_NAMES) {
      const replacement = RETIRED_QUEUE_TOOLS[name].canonical;
      assert.ok(names.has(replacement), `${name} points at ${replacement}, which is not registered`);
    }
    const peek = tools.find((t) => t.name === 'peek_next')?.description ?? '';
    assert.doesNotMatch(peek, /see also/i, 'peek_next description still carries a See-also chain');
    assert.match(peek, /use get_queue for the whole queue/i);

    // The host-visible surface, counted: at most three queue-READ tools remain
    // in the playback scope, and exactly two are the entry points.
    const queueReads = tools.filter((t) => /\/me\/player\/queue/.test(t.description ?? ''))
      .filter((t) => /read/i.test(t.description ?? ''))
      .map((t) => t.name);
    assert.ok(queueReads.length <= 3, `expected at most 3 queue-read tools, found: ${queueReads.join(', ')}`);

    await client.close();
    await server.close();
  });
});

describe('#847 retired queue-read names refuse with the exact replacement call', () => {
  let call: (name: string) => Promise<{ content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean }>;

  before(async () => {
    const server = new McpServer({ name: 'queue-refusals', version: '0.0.0' });
    await registerManifestModules(server, new SpotifyClient(), { readOnly: false, disableOverrides: new Set<string>(), isModuleActive: () => true, scopeBlocked: () => false });
    applyToolAnnotations(server);
    installToolErrorBoundary(server);
    const client = new Client({ name: 'queue-refusal-client', version: '0.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    call = async (name: string) => (await client.callTool({ name, arguments: {} })) as never;
  });

  it('refuses every retired name with kind=unknown_tool and reason=retired_tool_alias', async () => {
    assert.equal(RETIRED_QUEUE_TOOL_NAMES.length, 6);
    for (const name of RETIRED_QUEUE_TOOL_NAMES) {
      const result = await call(name);
      assert.equal(result.isError, true, `${name} should refuse`);
      const error = (result.structuredContent as { error?: Record<string, unknown> }).error;
      assert.ok(error, `${name} refusal carried no structured error`);
      assert.equal(error.kind, 'unknown_tool', `${name} refusal kind`);
      assert.equal(error.reason, 'retired_tool_alias', `${name} refusal reason`);
      assert.equal(error.tool, name);
    }
  });

  it('names the exact replacement call in `fix`, arguments included', async () => {
    // A refusal that only says "use get_queue" is the #803 failure at the tool
    // level: it names a tool that will answer a different question, because
    // the survivors take arguments the retired tools did not.
    const expected: Record<string, string> = {
      describe_queue: "get_queue with view: 'enriched'",
      get_queue_snapshot: "get_queue with include: ['runtime']",
      queue_runtime_report: "get_queue with include: ['runtime']",
      queue_duplicate_check: "get_queue with include: ['duplicates']",
      queue_profile: "get_queue with include: ['profile']",
    };
    for (const [name, call_] of Object.entries(expected)) {
      const result = await call(name);
      const error = (result.structuredContent as { error: Record<string, unknown> }).error;
      assert.equal(error.fix, `Call ${call_} instead.`, `${name} fix text`);
    }
    const predict = (await call('predict_next_tracks')).structuredContent as { error: Record<string, unknown> };
    assert.match(String(predict.error.fix), /peek_next with count/);
    assert.match(String(predict.error.fix), /include: \['runtime'\]/);
  });

  it('does NOT dispatch the retired names, even with SPOTIFY_MCP_LEGACY_ALIASES=1', async () => {
    // The flag means "same call, a new name" — the eight stats.fm aliases, all
    // of which were argument-identical to their canonical tool. None of these
    // six is, so honouring the flag here would answer a different question
    // under a name that used to be right. This is the assertion that stops a
    // future agent from "helpfully" adding them to LEGACY_TOOL_ALIASES.
    const previous = process.env.SPOTIFY_MCP_LEGACY_ALIASES;
    process.env.SPOTIFY_MCP_LEGACY_ALIASES = '1';
    try {
      for (const name of RETIRED_QUEUE_TOOL_NAMES) {
        const result = await call(name);
        assert.equal(result.isError, true, `${name} dispatched under SPOTIFY_MCP_LEGACY_ALIASES=1`);
        const error = (result.structuredContent as { error: Record<string, unknown> }).error;
        assert.equal(error.reason, 'retired_tool_alias');
      }
    } finally {
      if (previous === undefined) delete process.env.SPOTIFY_MCP_LEGACY_ALIASES;
      else process.env.SPOTIFY_MCP_LEGACY_ALIASES = previous;
    }
  });

  it('keeps the six out of the LEGACY_TOOL_ALIASES dispatch table', async () => {
    // The table is a string map read by the CallTool boundary. A retired queue
    // name landing in it is a silent wrong answer waiting to happen, so assert
    // the absence where the rewrite would be read from.
    const table: Readonly<Record<string, string>> = (await import('../src/shaping.js')).LEGACY_TOOL_ALIASES;
    for (const name of RETIRED_QUEUE_TOOL_NAMES) {
      assert.ok(!Object.hasOwn(table, name), `${name} must not be in LEGACY_TOOL_ALIASES`);
    }
  });
});

/**
 * The retired tools' own tests, re-pointed at the survivor.
 *
 * `#847` deleted four `describe` blocks from
 * `tests/tools.swarm3playback-executing.test.ts` — `get_queue_snapshot`,
 * `queue_runtime_report`, `queue_duplicate_check` and `predict_next_tracks` —
 * because the registrations they drove no longer exist. Deleting them would
 * have quietly dropped real arithmetic (the cumulative ETA, the 1-based
 * duplicate positions, the "no divide by zero on an empty queue" case), so
 * every assertion those blocks made is re-made here against `get_queue`.
 * This is the migration's evidence that the collapse kept the behaviour, not
 * just the registration count.
 */
describe('#847 the retired tools’ coverage, re-pointed at get_queue', () => {
  it('types an item with no `artists` as an episode and names its show', async () => {
    // Was: `get_queue_snapshot` "reports an episode in the queue with its show
    // as the subtitle". Structural on purpose — `currently_playing_type` also
    // admits `ad` and `unknown` (#852), so a row is typed by what it carries.
    const { registered } = makeHarness();
    const out = await invoke(findTool(registered, 'get_queue'), { include: ['runtime'] });
    const timeline = (structured(out).runtime as { timeline: Array<Record<string, unknown>> }).timeline;
    assert.equal(timeline[2]?.is_episode, true);
    assert.equal(timeline[2]?.subtitle, 'ShowX');
    assert.equal(timeline[2]?.show_name, 'ShowX');
    assert.equal(timeline[0]?.is_episode, false);
    assert.equal(timeline[0]?.subtitle, 'Beta');
  });

  it('reports an empty queue without dividing by zero', async () => {
    // Was: `get_queue_snapshot` "reports an empty queue without dividing by
    // zero" and `queue_runtime_report` "returns null longest/shortest for an
    // empty queue rather than throwing".
    const { registered } = makeHarness({ emptyQueue: true, nothingPlaying: true });
    const out = await invoke(findTool(registered, 'get_queue'), { include: ['runtime'] });
    const runtime = structured(out).runtime as Record<string, unknown>;
    assert.equal(runtime.upcoming_count, 0);
    assert.equal(runtime.total_runtime_ms, 0);
    assert.equal(runtime.average_runtime_ms, 0);
    assert.equal(runtime.longest, null);
    assert.equal(runtime.shortest, null);
    assert.deepEqual(runtime.timeline, []);
    // Nothing playing is an ANSWERED question, so this one really is 0.
    assert.equal(runtime.current_track_remaining_ms, 0);
    assert.match(text(out), /Queue is empty/);
  });

  it('stamps each item with its cumulative start time after the current track', async () => {
    // Was: `predict_next_tracks` "stamps each item with its cumulative start
    // time after the current track".
    const { registered } = makeHarness({ progressMs: 30000 });
    const out = await invoke(findTool(registered, 'get_queue'), { include: ['runtime'] });
    const runtime = structured(out).runtime as Record<string, unknown>;
    assert.equal(runtime.current_track_remaining_ms, 170000, '200_000 still to play, less 30_000 elapsed');
    const timeline = runtime.timeline as Array<Record<string, unknown>>;
    assert.equal(timeline[0]?.plays_at_ms, 170000);
    assert.equal(timeline[1]?.plays_at_ms, 380000, 'the second starts after the first finishes');
    assert.equal(timeline[2]?.plays_at_ms, 590000);
  });

  it('carries every field the retired items[] carried, and one more', async () => {
    // The union claim is only honest if the rows kept their shape. `predict_
    // next_tracks` returned `items[]` of {position, uri, name, subtitle,
    // duration_ms, is_episode, plays_at_ms}; the timeline is that plus the
    // source context, asserted key-by-key so a dropped field is a red test
    // rather than a subtly shorter payload a caller cannot notice.
    const { registered } = makeHarness();
    const out = await invoke(findTool(registered, 'get_queue'), { include: ['runtime'] });
    const timeline = (structured(out).runtime as { timeline: Array<Record<string, unknown>> }).timeline;
    for (const key of ['position', 'uri', 'name', 'subtitle', 'duration_ms', 'is_episode', 'plays_at_ms']) {
      assert.ok(key in timeline[0], `timeline rows dropped ${key}, which predict_next_tracks items[] carried`);
    }
    assert.deepEqual(timeline.map((r) => r.position), [1, 2, 3, 4], 'positions stay 1-based');
  });

  it('truncates the item page but never the timeline, and says so', async () => {
    // The one place the survivor is deliberately a SUPERSET of a retired tool:
    // `predict_next_tracks`'s `count` capped the rows it returned, and there is
    // no cap here, because a total that silently covered a page is a wrong
    // number wearing the right field name (#803). Pinned so a future
    // "optimisation" that caps the timeline is a red test.
    const { registered } = makeHarness();
    const out = await invoke(findTool(registered, 'get_queue'), { include: ['runtime'], max_results: 2 });
    const sc = structured(out);
    assert.equal((sc.items as unknown[]).length, 2, 'the page really is smaller than the queue');
    const timeline = (sc.runtime as { timeline: unknown[] }).timeline;
    assert.equal(timeline.length, 4, 'the timeline covers the whole queue regardless of the page size');
  });

  it('groups repeats by uri and counts only the redundant occurrences as wasted', async () => {
    // Was: `queue_duplicate_check` "groups repeats by uri …". Three occurrences,
    // non-adjacent, with a different track in the middle — the case a
    // pairwise-neighbours implementation would get wrong.
    const { registered } = makeHarness({
      queue: {
        currently_playing: null,
        queue: [
          track(1, 'Alpha', 'Artist', 'AlbumA', 200000),
          track(2, 'Beta', 'Artist', 'AlbumB', 100000),
          track(3, 'Alpha', 'Artist', 'AlbumA', 200000, 'spotify:track:t1'),
          track(4, 'Alpha', 'Artist', 'AlbumA', 200000, 'spotify:track:t1'),
        ],
      },
    });
    const out = await invoke(findTool(registered, 'get_queue'), { include: ['duplicates'] });
    const dupes = structured(out).duplicates as Record<string, unknown>;
    const groups = dupes.duplicate_groups as Array<Record<string, unknown>>;
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.name, 'Alpha');
    assert.equal(groups[0]?.occurrences, 3);
    assert.deepEqual(groups[0]?.positions, [1, 3, 4], 'queue positions are 1-based');
    assert.equal(groups[0]?.wasted_runtime_ms, 400000, 'the first occurrence is the one that plays');
    assert.equal(dupes.total_redundant, 2);
    assert.equal(dupes.wasted_runtime_ms, 400000);
  });

  it('says there are no duplicates rather than reporting an empty group', async () => {
    // Was: `queue_duplicate_check` "says there are no duplicates rather than
    // reporting an empty group".
    const { registered } = makeHarness({
      queue: { currently_playing: null, queue: [track(1, 'A', 'X', 'L1', 1000), track(2, 'B', 'X', 'L2', 2000)] },
    });
    const out = await invoke(findTool(registered, 'get_queue'), { include: ['duplicates'] });
    const dupes = structured(out).duplicates as Record<string, unknown>;
    assert.deepEqual(dupes.duplicate_groups, []);
    assert.equal(dupes.total_redundant, 0);
    assert.match(text(out), /Duplicates: none/);
  });
});
